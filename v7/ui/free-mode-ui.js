/* global cards, cur, zones, detail, stack, tasksEl, errorsEl, settingsRuntime,
   settingsStorageKey, settingsSave, setStack, setTasks, updateStackPositions,
   setCollapsed, isCollapsed, fillZonesNow, updateZoneBg, updateDetailBg,
   closeAll, layoutHidden, selectZone, zoneSel, hitRect, v7OverlayOpen,
   syncZonesToCard */
(function(root){
  'use strict';
  const core=root.V7FreeLayoutCore, keyName='v7.free-layout.v1';
  let active=false,layout=null,scope='',busy=Promise.resolve(),epoch=0,normalCollapsed=false,switching=false,resizeRevision=0;
  let surfaceSize=null,transitioning=false;
  // ⭐ 2026-10-20 多屏：壳回执里的 monitors（每块屏在窗口里的位置，第一块 = 软件所在那块）。单屏 / 老壳 = null。
  //   ⚠ 存档里的坐标一直是「相对软件所在那块屏左上角」（单屏时窗口就从那里开始）。多屏时窗口从所有屏的外包矩形左上角开始，
  //     所以读档时加上 homeOffset、存档时减掉 —— 老存档、单屏、多屏三种情况坐标意思不变。
  let surfaceMonitors=null;
  const homeOffset=()=>surfaceMonitors&&surfaceMonitors[0]?{x:surfaceMonitors[0].x,y:surfaceMonitors[0].y}:{x:0,y:0};
  let drag=null,frame=0,pending=null,saveTimer=0,lastSave=0,collapsed=new Set(),slowFrames=0,lastCurrent='';
  // 收成小方块（第 17 条，见文件末尾 toggleCompact 那段）
  let compact=false,compactBusy=false,blockDrag=null,blockTimer=0,blockPos=null,recentDone=0,recentUntil=0,lastDone=0;
  const anchors=new Map();
  // ⭐ 折叠条【固定厚度】。用户定案(2026-09-28)：单张卡折叠和多张卡折叠必须一样厚，
  //   取单卡的高度 44。名字仍然全列出来，但只占一行、放不下省略 —— 厚度不随名字长度变。
  const FREE_FOLDED_HEIGHT=44;
  const performanceNote=document.createElement('div');performanceNote.className='free-mode-performance';performanceNote.hidden=true;
  performanceNote.textContent='正在合并拖动刷新，以保持操作流畅。';document.body.append(performanceNote);
  const snapPreview=document.createElement('div');snapPreview.className='free-snap-preview';snapPreview.hidden=true;snapPreview.setAttribute('aria-hidden','true');document.body.append(snapPreview);
  // ⭐ 2026-10-22 对齐吸附的辅助线（最多两条：一竖一横），吸上时才显示
  const guideEls=[0,1].map(()=>{const g=document.createElement('div');g.className='free-align-guide';g.hidden=true;g.setAttribute('aria-hidden','true');document.body.append(g);return g;});
  function showGuides(list){
    guideEls.forEach((g,i)=>{const l=list&&list[i];g.hidden=!l;if(!l)return;
      if(l.x!=null){setStyle(g,'left',l.x+'px');setStyle(g,'top',l.y1+'px');setStyle(g,'width','1px');setStyle(g,'height',(l.y2-l.y1)+'px');}
      else{setStyle(g,'left',l.x1+'px');setStyle(g,'top',l.y+'px');setStyle(g,'width',(l.x2-l.x1)+'px');setStyle(g,'height','1px');}});
  }
  const motionAnimations=new Set(),positionAnimations=new Map();
  // ⚠⚠ 2026-10-20 改：原来是 matchMedia('(prefers-reduced-motion: reduce)') —— 用户 Windows 里关了「显示动画」，
  //   Chromium 就判 reduce ⇒ 自由摆放里所有动画被砍：收成小方块没有动画（一下没了）、滚轮切卡只挪 8 像素（像硬切），
  //   跟标准摆放（不看这个偏好）手感完全两样 —— 用户 10-20 报的就是这两条。
  //   项目规矩（reference-card.css / icons.css 开头的血泪教训）：整个界面【不尊重】这个系统偏好，自由摆放也一样。
  //   ⚠ 别改回去；真要给"减少动画"，做成软件自己的设置项，别读系统偏好。
  // 2026-10-22：接上软件自己的「减少动画」开关（设置 → 外观），仍然不读系统偏好
  const reducedMotion=()=>!!(root.V7Motion&&root.V7Motion.reduced());
  // ⭐⭐ 2026-10-20 iOS 风格的弹簧（用户：「动画好丑陋…完全没有计算起始点到终点不同的路径，好像就是按照方向做了个渐入渐出…
  //   学习一下 iOS 的风格」）。
  //   按真的阻尼弹簧方程 x(t)=1-e^(-ζωt)(cos ωd·t + ζω/ωd·sin ωd·t) 算出曲线，交给浏览器的 CSS linear()：
  //   起步快、收尾软，阻尼 < 1 时末尾有一点点回弹 —— 跟 iOS 的交互弹簧同一个思路（不是固定的 ease-out）。
  //   response = 弹一个来回要多久（秒，越小越快）；damping = 阻尼比（1 = 不过冲，0.8 左右 = 轻微回弹）。
  //   时长 = 算到偏差小于千分之一为止，所以快慢由弹簧决定，不是拍脑袋写死的毫秒数。
  const springCache=new Map();
  function spring(response,damping){
    const key=response+'|'+damping;
    if(springCache.has(key))return springCache.get(key);
    const w=2*Math.PI/response,z=Math.min(damping,0.999),wd=w*Math.sqrt(1-z*z);
    const x=t=>1-Math.exp(-z*w*t)*(Math.cos(wd*t)+(z*w/wd)*Math.sin(wd*t));
    let settle=0.1;
    for(let t=0.02;t<3;t+=0.005)if(Math.abs(1-x(t))>0.001)settle=t+0.005;
    const points=[];
    for(let i=0;i<=60;i++)points.push(i===60?'1':x(settle*i/60).toFixed(4));
    let easing='cubic-bezier(.22,1,.36,1)';
    try{if(root.CSS&&CSS.supports('animation-timing-function','linear(0, 1)'))easing='linear('+points.join(', ')+')';}catch(_){}
    const out={duration:Math.round(settle*1000),easing};
    springCache.set(key,out);
    return out;
  }
  // 元素「现在这一刻」的样子：布局盒左上角 + 现有变换（换算成以左上角为原点的矩阵）。
  //   拿它可以算出「把这个元素摆成屏幕上任意一个矩形」要用的 transform —— 这样动画才是从真实起点走到真实终点，
  //   中途大小也跟着变（FLIP），而不是原地淡入淡出。
  function boxInfo(node){
    const style=getComputedStyle(node);
    const F=style.transform&&style.transform!=='none'?new DOMMatrix(style.transform):new DOMMatrix();
    const origin=String(style.transformOrigin||'0 0').split(' ').map(v=>parseFloat(v)||0);
    const F0=new DOMMatrix().translate(origin[0],origin[1]).multiply(F).translate(-origin[0],-origin[1]);
    const rect=node.getBoundingClientRect();
    return {F0,rect,left:rect.left-F0.e,top:rect.top-F0.f,W:node.offsetWidth||rect.width||1,H:node.offsetHeight||rect.height||1,opacity:style.opacity};
  }
  // ⚠ 2026-10-20（用户：「报错卡和任务卡…是原地消失的」）：任务堆 / 报错堆的容器本身是 0×0（卡都是绝对定位的子元素），
  //   量容器量不到东西 ⇒ 动画被跳过、原地消失。动画时把这两堆拆成里面的每一张卡，各走各的路。
  function motionTargets(nodes){
    const out=[];
    for(const node of nodes){
      if(node===tasksEl||node===errorsEl){
        // ⚠ 2026-10-20（用户：「拖动任务卡堆、拖动报错卡堆这种按钮…让它们都一起去」）：不只拿卡 —— 堆里【所有看得见的】子元素
        //   （卡、拖动按钮、空堆占位…）都一起走，免得漏哪个原地消失。正在退场的任务卡（.leaving）不算。
        for(const child of node.children){
          if(child.classList.contains('leaving'))continue;
          const r=child.getBoundingClientRect();if(!r.width||!r.height)continue;
          // ⚠ 只看有没有尺寸、是不是 display:none —— 不看透明度 / visibility：报错卡旁边的详情（.error-detail）
          //   自己是透明的、里面的字却看得见，按透明度筛就把它漏了（用户：「报错卡堆的内容没跟随折叠动画」）。
          //   看不见的东西陪着一起动没有坏处。
          if(getComputedStyle(child).display==='none')continue;
          out.push(child);
        }
      }else out.push(node);
    }
    return out;
  }
  const rectTransform=(info,t)=>`matrix(${t.width/info.W},0,0,${t.height/info.H},${t.left-info.left},${t.top-info.top})`;
  const ORIGIN0='0px 0px';
  function animate(node,frames,options){
    const animation=node.animate(frames,{easing:'cubic-bezier(.22,1,.36,1)',...options});
    motionAnimations.add(animation);animation.finished.catch(()=>{}).finally(()=>motionAnimations.delete(animation));
    return animation;
  }
  function waitMotion(animations,duration){
    // A minimized/hidden WebView may suspend its animation timeline; mode changes must still finish.
    return new Promise(resolve=>{
      let done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);for(const animation of animations)if(animation.playState==='running'||animation.playState==='paused')try{animation.finish();}catch(_){}resolve();};
      const timer=setTimeout(finish,duration+120);
      Promise.all(animations.map(animation=>animation.finished.catch(()=>{}))).then(finish);
    });
  }
  function captureCards(){return new Map(cards.filter(c=>!c.hidden).map(c=>[c,c.getBoundingClientRect()]));}
  function animatePositions(before,duration=180,easing){
    if(transitioning)return;
    for(const [node,from] of before){
      const previous=positionAnimations.get(node);if(previous)previous.cancel();
      const to=node.getBoundingClientRect(),dx=from.left-to.left,dy=from.top-to.top;
      if(Math.abs(dx)+Math.abs(dy)<1)continue;
      const animation=animate(node,[{transform:`translate(${reducedMotion()?0:dx}px,${reducedMotion()?Math.sign(dy)*8:dy}px)`},{transform:'none'}],{duration,...(easing?{easing}:{})});
      positionAnimations.set(node,animation);
      animation.finished.catch(()=>{}).finally(()=>{if(positionAnimations.get(node)===animation)positionAnimations.delete(node);});
    }
  }
  function cancelPositionAnimations(){
    for(const animation of positionAnimations.values()){
      try{animation.cancel();}catch(_){/* already finished */}
    }
    positionAnimations.clear();
  }
  function transitionNodes(){return [...cards.filter(c=>!c.hidden),tasksEl,errorsEl,zones,detail,...document.querySelectorAll(".v7-floating-bar")];}   // 10-20：两个悬浮条也跟着走真实路径
  // ⭐ 2026-10-20 改：原来先整体淡出 180ms、切完窗口再从新位置「朝原方向挪最多 56 像素 + 淡入」——
  //   卡片根本不走从起点到终点的路（用户说的「按照方向做了个渐入渐出」）。原因是窗口切换前后位置不同，坐标对不上。
  //   现在壳在回执里给出切换前后窗口内容区的屏幕原点（fromOrigin / toOrigin），每张卡都能换算回【切换前在屏幕上的位置】，
  //   用弹簧从那里一路走到新位置（位移 + 缩放）。切窗口那几帧只是藏起来（不再先淡出）。
  async function leaveSurface(){
    cancelPositionAnimations();
    transitioning=true;document.body.classList.add('free-mode-switching','free-mode-native-switch');
  }
  async function revealSurface(before,origins){
    document.body.classList.remove('free-mode-native-switch');
    const motion=spring(0.56,0.86);
    const shift=origins&&origins.from&&origins.to?{x:origins.from.x-origins.to.x,y:origins.from.y-origins.to.y}:null;
    const animations=motionTargets(transitionNodes().filter(node=>!node.hidden)).map(node=>{
      const info=boxInfo(node);
      if(!info.rect.width||!info.rect.height)return null;
      const from=before.get(node);
      const end={transformOrigin:ORIGIN0,transform:info.F0.toString(),opacity:info.opacity};
      if(!from||!from.width||!from.height||!shift){
        // 切换前看不见（或者壳太老没给原点）：原地从 94% 弹出来
        const r=info.rect,t={left:r.left+r.width*.03,top:r.top+r.height*.03,width:r.width*.94,height:r.height*.94};
        return animate(node,[{transformOrigin:ORIGIN0,transform:rectTransform(info,t),opacity:0},end],{duration:motion.duration,easing:motion.easing});
      }
      const t={left:from.left+shift.x,top:from.top+shift.y,width:from.width,height:from.height};
      return animate(node,[{transformOrigin:ORIGIN0,transform:rectTransform(info,t),opacity:from.opacity},end],{duration:motion.duration,easing:motion.easing});
    }).filter(Boolean);
    await waitMotion(animations,motion.duration+80);
    transitioning=false;document.body.classList.remove('free-mode-switching');
  }
  function cancelTransition(){
    for(const animation of motionAnimations)animation.cancel();motionAnimations.clear();
    positionAnimations.clear();
    transitioning=false;document.body.classList.remove('free-mode-switching','free-mode-native-switch');
  }
  const clamp=(v,a,b)=>Math.max(a,Math.min(Math.max(a,b),v));
  // ⭐ 2026-10-19（docs/250 第 19 条，用户定「跟电脑走」）：布局存在【不带账号】的本机键里。
  //   原来按账号存：登录过期掉回 anonymous 读到的是另一份（多半是默认摆法），用户在那份里摆好、重新登录又换回去 —— 哪边看都像「没记住」。
  //   ⚠ 本机键还没有时，从原来那份（账号的）拷过来一次（见 load）。
  const storageKey=()=>{const S=root.WHEELCHAIR_STORAGE;return S?(typeof S.localKey==='function'?S.localKey(keyName):S.key(keyName)):keyName;};
  const legacyStorageKey=()=>root.WHEELCHAIR_STORAGE?WHEELCHAIR_STORAGE.key(keyName):keyName;
  // ⭐ 2026-10-19（docs/250 第 19 条②）：「挤进屏幕范围」只影响显示，不覆盖存档。
  //   原来进自由摆放（load → clampPositions → persist）、窗口变大小（resize → clamp → persist）都是夹完就存 ——
  //   这次的工作区比上次小（主窗口在另一块屏、改了界面大小、任务栏变了、远程桌面），原来的位置就被永久覆盖。
  //   现在：savedPos = 存档里的原坐标；touched = 这次被用户真动过的单元（拖动 / 从卡组释放 / 折叠展开 / 翻卡组）。
  //   存盘时动过的写新坐标，没动过的写回原坐标；写完清掉 touched（之后再被挤，照样不覆盖）。
  let savedPos=new Map(),touched=new Set();
  const touch=ids=>{for(const id of ids||[])if(id)touched.add(id);};
  const surfaceWidth=()=>surfaceSize?.width||innerWidth,surfaceHeight=()=>surfaceSize?.height||innerHeight;
  const viewport=()=>({x:8,y:42,width:Math.max(300,surfaceWidth()-16),height:Math.max(44,surfaceHeight()-50)});
  // 每块屏的可放区域（留边跟 viewport 一样）；单屏时 null ⇒ 照旧用整个 viewport
  const monitorViewports=()=>surfaceMonitors&&surfaceMonitors.length>1?surfaceMonitors.map(m=>({x:m.x+8,y:m.y+42,width:Math.max(300,m.width-16),height:Math.max(44,m.height-50)})):null;
  const unit=id=>layout?.units.find(row=>row.id===id);
  // Reserve the existing modal layer (830+) and keep relative ranks stable below it.
  const zIndex=id=>100+(unit(id)?.z||0)*3;
  function report(error){root.ERR?.report('LAYOUT_FAILED',{message:String(error?.message||error)});}
  function persist(){
    clearTimeout(saveTimer);saveTimer=0;
    if(!layout||!scope)return;
    try{
      const out=core.normalize(layout);      // ⚠ normalize 返回新对象：改 out 不影响屏幕上的位置
      const off=homeOffset();
      for(const row of out.units){
        const keep=!touched.has(row.id)&&savedPos.get(row.id);
        if(keep){row.x=keep.x;row.y=keep.y;}
        else{row.x-=off.x;row.y-=off.y;savedPos.set(row.id,{x:row.x,y:row.y});}
      }
      localStorage.setItem(scope,JSON.stringify({layout:out,collapsed:[...collapsed]}));
      touched.clear();lastSave=performance.now();
    }
    catch(error){report(error);}
  }
  function scheduleSave(){if(performance.now()-lastSave>300)persist();else if(!saveTimer)saveTimer=setTimeout(persist,150);}
  function defaultLayout(){
    const state=core.createDefault({cardIds:cards.map(c=>c.dataset.card),card:{width:300,height:400},startX:24,startY:64,stackOffset:34});
    // Start as two titled piles. Positions are immediately free to change.
    state.units.filter(r=>r.kind==='card').forEach((r,i)=>{r.x=24+(i<5?0:334);r.y=64+(i<5?i:i-5)*34;r.z=cards.length-i;r.groupId=i<5?'default:left':'default:right';});
    const home=surfaceMonitors&&surfaceMonitors[0]?surfaceMonitors[0]:{width:surfaceWidth(),height:surfaceHeight()};
    Object.assign(state.units.find(r=>r.id==='tasks'),{x:Math.max(24,home.width-332),y:150,z:cards.length+1});
    Object.assign(state.units.find(r=>r.id==='errors'),{x:Math.max(24,home.width-332),y:400,z:cards.length+2});
    return core.clampLayout(state,{x:8,y:42,width:Math.max(300,home.width-16),height:Math.max(44,home.height-50)});
  }
  function load(){
    scope=storageKey();collapsed=new Set();touched=new Set();
    lastCurrent=core.cardUnitId(cards[cur].dataset.card);
    const defaults=defaultLayout();layout=defaults;
    try{
      let raw=localStorage.getItem(scope);
      // ⭐ 2026-10-19：本机键还没有 ⇒ 从原来按账号存的那份拷过来一次（下次存盘就写进本机键）
      if(raw==null&&legacyStorageKey()!==scope)raw=localStorage.getItem(legacyStorageKey());
      const saved=JSON.parse(raw||'null');
      if(saved?.layout){
        const old=core.normalize(saved.layout),ids=new Set(defaults.units.map(r=>r.id));
        const merged=old.units.filter(r=>ids.has(r.id));
        for(const row of defaults.units)if(!merged.some(r=>r.id===row.id))merged.push({...row,z:merged.length});
        // In ordinary mode the small window must not rewrite a saved desktop-sized layout.
        layout=core.normalize({...defaults,units:merged});
        collapsed=new Set((saved.collapsed||[]).filter(id=>ids.has(id)));
        for(const id of [...collapsed])for(const member of core.pileIds(layout,id))collapsed.add(member);
      }
    }catch(error){report(error);}
    // 存档里的原坐标（夹进屏幕之前）—— persist 写回没动过的单元时用
    savedPos=new Map(layout.units.map(r=>[r.id,{x:r.x,y:r.y}]));
    const off=homeOffset();
    if(off.x||off.y)layout=core.normalize({...layout,units:layout.units.map(r=>({...r,x:r.x+off.x,y:r.y+off.y}))});
    if(active)clampPositions();
  }
  function setStyle(node,name,value){if(node.style[name]!==value)node.style[name]=value;}
  function clampPositions(){
    const foldedHeights={};
    if(document.body.classList.contains('free-mode')){
      for(const row of layout.units)if(row.kind==='card')applyCard(row);
      // ⚠ 折叠厚度【固定 44】，不再按名字文字量算（2026-09-28 用户实测：
      //   多张卡的名字拼起来会换行，于是"三张卡折起来比一张厚"，不齐整）。
      //   名字仍然都显示，但统一占一行、超长省略 —— 见 FREE_FOLDED_HEIGHT 处的说明。
      for(const id of collapsed){const row=unit(id);if(row)foldedHeights[row.groupId]=FREE_FOLDED_HEIGHT;}
    }else{
      // Labels are measured after entering the free surface; this first pass keeps the saved origin.
      for(const id of collapsed){const row=unit(id);if(row)foldedHeights[row.groupId]=44;}
    }
    layout=core.clampLayout(layout,viewport(),foldedHeights,monitorViewports());
  }
  function updateLinkedPanels(){
    if(!active)return;
    const card=cards[cur],row=unit(core.cardUnitId(card.dataset.card));if(!row)return;
    const width=surfaceWidth(),height=surfaceHeight();
    const zoneWidth=zones.offsetWidth||200,detailWidth=detail.offsetWidth||300;
    const right=row.x+340, left=row.x-zoneWidth-40;
    const zx=right+zoneWidth+40+detailWidth<=width-8?right:
      left-40-detailWidth>=8?left:clamp(right,8,width-zoneWidth-8);
    const opensLeft=zx<row.x;
    let dx=opensLeft?zx-detailWidth-40:zx+zoneWidth+40;
    if(dx<8||dx+detailWidth>width-8)dx=opensLeft?zx+zoneWidth+40:zx-detailWidth-40;
    if(dx<8||dx+detailWidth>width-8)dx=clamp(row.x+340,8,width-detailWidth-8);
    const y=clamp(row.y,42,height-Math.max(zones.offsetHeight||400,detail.offsetHeight||400)-8);
    for(const [node,x] of [[zones,zx],[detail,dx]]){
      node.dataset.freeOwner=card.dataset.card;
      setStyle(node,'left',x+'px');setStyle(node,'top',y+'px');setStyle(node,'zIndex',String(zIndex(row.id)+1));
      setStyle(node,'visibility',collapsed.has(row.id)?'hidden':'');
    }
  }
  function applyCard(row){
    const c=cards.find(c=>c.dataset.card===row.cardId);if(!c)return;
    const pile=core.pileIds(layout,row.id),visible=pile.filter(id=>!layoutHidden.has(cards.findIndex(item=>core.cardUnitId(item.dataset.card)===id)));
    const folded=collapsed.has(row.id),leader=visible[0]||pile[0],top=folded?Math.min(...pile.map(id=>unit(id).y)):row.y;
    const depth=visible.indexOf(row.id),previous=depth>0?unit(visible[depth-1]):null;
    const strip=previous?Math.max(0,Math.min(34,row.y-previous.y)):34;
    setStyle(c,'left',row.x+'px');setStyle(c,'top',top+'px');setStyle(c,'zIndex',String(zIndex(row.id)));
    c.classList.toggle('free-collapsed',folded);c.classList.toggle('free-group-hidden',folded&&row.id!==leader);
    // Keep every member in the group and wheel sequence. Only the first four
    // visible members render; deeper members share the final layer in core.
    c.classList.toggle('free-pile-buried',!folded&&depth>=core.MAX_VISIBLE_PILE_CARDS);
    c.classList.toggle('free-pile-layered',!folded&&depth>0&&depth<core.MAX_VISIBLE_PILE_CARDS);
    c.dataset.freePileDepth=String(depth);
    // ⭐ 2026-10-04 用户实测报的「自由模式堆叠不压暗」（docs/137 §七）。
    //   ⚠⚠ 这条跟标准模式必须一致（用户 2026-10-01 定案，写在 ui.html:7134）。
    //   真因：setStack() 的自由模式分支里写死了一句
    //     `const dim=c.querySelector('.bc-dim'); if(dim) dim.style.opacity='0';`
    //   （ui.html:4323）—— 那是照抄标准模式更早一版的写法。标准模式后来改成
    //   「按叠压深度 Math.min(0.62, 深度*0.2)」，自由模式那一行【没跟着改】，
    //   于是自由模式下底面那些卡永远不暗。
    //   ⚠ 为什么修在这里：setStack() 的自由分支跑完会调 applyPositions() →
    //     applyCard()（顺序：先 setStack 清 0，再 applyCard 写值）。
    //     所以【最终值由这里写】—— 改 ui.html 那句没用，会被这行覆盖。
    //   深度取 depth（0=最上面那张），跟标准模式同一个公式。
    const dim=c.querySelector('.bc-dim');
    if(dim)dim.style.opacity=folded?'0':String(Math.min(0.62,Math.min(depth,core.MAX_VISIBLE_PILE_CARDS-1)*0.2));
    if(!folded&&depth>0)c.style.setProperty('--stack-visible-strip',strip+'px');
    else c.style.removeProperty('--stack-visible-strip');
    c.dataset.freeGroup=row.groupId;
    // 折叠条上列出组内每张卡的名字（一张就一个，多张就都列上，用 · 分隔）
    const names=pile.map(id=>cards.find(item=>core.cardUnitId(item.dataset.card)===id)?.dataset.bglabel||id.slice(5));
    const label=c.querySelector('.free-group-label'),text=names.join(' · ');if(label.textContent!==text)label.textContent=text;label.hidden=!folded;
    // ⚠ 折叠厚度固定：不管组里有几张、名字多长，折起来都是同一个高度。
    //   以前是 Math.max(44, label.offsetHeight+24) —— 名字换行就变厚，单卡和多卡不一样高。
    c.style.setProperty('--free-collapsed-height',FREE_FOLDED_HEIGHT+'px');
    const release=c.querySelector('[data-free-release]');release.disabled=pile.length<2;
    const button=c.querySelector('[data-collapse-toggle]');if(button){button.dataset.collapsed=String(folded);button.setAttribute('aria-expanded',String(!folded));button.title=folded?'展开卡组':'折叠卡组';button.setAttribute('aria-label',button.title);}
  }
  function syncSpecialUnit(id){
    if(!active||!layout)return;
    const row=unit(id),node=id==='tasks'?tasksEl:errorsEl;if(!row)return;
    let x=row.x,y=row.y;
    if(id==='errors'){
      errorsEl.classList.remove('layout-overlap-fallback');
      const taskRow=unit('tasks'),taskHeight=taskStackExtent();
      const errorCards=[...errorsEl.querySelectorAll('.error-card')];
      const height=errorCards.length?Math.max(...errorCards.map(el=>el.offsetHeight||100))+(Math.min(errorCards.length,4)-1)*24:110;
      // Independent columns retain their saved position. If a task pile grows
      // into the error pile below it, move only the rendered error origin.
      // Shrinking tasks restores the preferred position without rewriting it.
      // ⭐ 2026-10-04 用户定案（docs/132 §六）：放不下【不再翻到左右侧/上方】，
      //   就在原位 —— 允许跟任务卡叠一点，用户自己拖。原来那套"翻边"会
      //   把报错堆甩到用户没看的地方，反而找不回来。
      if(drag?.id!=='errors'&&taskRow&&taskHeight>0&&row.y>taskRow.y&&
        x<taskRow.x+300&&x+300>taskRow.x&&y<taskRow.y+taskHeight+24){
        const below=taskRow.y+taskHeight+24;
        if(below+height<=surfaceHeight()-8)y=below;
      }
    }
    setStyle(node,'left',x+'px');setStyle(node,'top',y+'px');setStyle(node,'zIndex',String(zIndex(id)));
    // 预览/详情跟着它所属的那一摞，往右开。
    // ⭐ 2026-10-04 用户定案（docs/132 §六）：右边放不下【不再翻到左边】，就在原位往右开。
    //   ⚠ 只留一条最小保险：至少让 48px 露在可视区内 —— 不然彻底看不见就找不回来了。
    const children=node.querySelectorAll(id==='tasks'?'.task-preview':'.error-detail');
    children.forEach(panel=>{
      const px=Math.min(340,Math.max(0,surfaceWidth()-48-x));
      setStyle(panel,'left',px+'px');
    });
    if(id==='tasks')syncSpecialUnit('errors');
  }
  function syncEmptyUnits(){
    for(const [id,item] of anchors){
      const node=id==='tasks'?tasksEl:errorsEl;
      const empty=!node.querySelector(id==='tasks'?'.task:not(.leaving)':'.error-card');
      item.placeholder.hidden=!active||!empty;
      item.handle.hidden=!active;
      node.classList.toggle('free-stack-empty',empty);
    }
  }
  function applyPositions(){
    if(!active||!layout)return;
    for(const row of layout.units)if(row.kind==='card')applyCard(row);
    // The available task layers depend on their desktop origin. Recompute
    // them after restore/resize as well as after task insertion/removal.
    syncSpecialUnit('tasks');setTasks();syncEmptyUnits();updateLinkedPanels();
    root.V7StackOcclusion?.sync();
  }
  function raise(id){
    const pile=core.pileIds(layout,id);
    if(pile.length){
      const selected=[id,...pile.filter(member=>member!==id)],anchor={x:unit(id).x,y:Math.min(...pile.map(member=>unit(member).y))};
      layout=core.arrangePile(layout,selected,anchor,collapsed.has(id)?null:viewport());
      touch(pile);                                   // 叠卡顺序变了 = 用户动过这一组
    }else layout=core.raise(layout,id);
    applyPositions();scheduleSave();
  }
  function activate(id){
    if(!active||scope!==storageKey())return;
    if(lastCurrent!==id){lastCurrent=id;raise(id);}
  }
  function selectCard(card,options={}){
    const next=cards.indexOf(card);if(next<0)return;
    const followPanels=next!==cur&&options.followPanels&&(zones.classList.contains('show')||detail.classList.contains('show'));
    if(next!==cur){
      if(!followPanels){
        closeAll();
        // The old panel may still be running its closing animation, but its
        // navigation state must not block a right swipe on the new owner.
        zoneOpen=false;
      }
      cur=next;
      if(!followPanels){selectZone(0);fillZonesNow();}
      updateZoneBg(cur);updateDetailBg();
    }
    // Hover navigation must not re-arrange the pile underneath the pointer.
    // A real click still raises the selected card; mouseenter/right-swipe only
    // changes its navigation context so the following pointer event keeps the
    // same card hit target.
    const id=core.cardUnitId(card.dataset.card);
    if(options.raise!==false)raise(id);
    // setStack synchronizes the active unit through activate().  Mark this
    // navigation-only selection as current before that synchronization, or
    // activate() would implicitly raise and move the hovered card anyway.
    else lastCurrent=id;
    setStack();
    // Wheel changes use the same lower-level whole-content motion as normal
    // mode. Keep an open chain visible instead of closing it on every turn.
    if(followPanels)syncZonesToCard(options.direction);
  }
  function expandGroup(id){
    if(!active||!collapsed.has(id))return;
    core.pileIds(layout,id).forEach(member=>collapsed.delete(member));
    clampPositions();applyPositions();persist();
  }
  // Free placement retains the ordinary main-card motion tokens. The input
  // cadence follows that same duration, rather than a second, faster timeline.
  function mainCardMotion(card){
    const style=getComputedStyle(card),value=style.getPropertyValue('--dur').trim();
    const parsed=parseFloat(value),duration=Number.isFinite(parsed)&&parsed>0?parsed*(value.endsWith('ms')?1:1000):340;
    return {duration,easing:style.getPropertyValue('--ease-out').trim()||'cubic-bezier(.22,.9,.32,1)'};
  }
  function cycleAtCurrent(dir,target){
    if(transitioning||drag)return;
    const card=target||cards[cur],motion=mainCardMotion(card);
    const id=core.cardUnitId(card.dataset.card),row=unit(id);if(!row)return;
    const all=core.pileIds(layout,id),pile=all.filter(id=>!layoutHidden.has(cards.findIndex(c=>core.cardUnitId(c.dataset.card)===id)));
    if(pile.length<2||collapsed.has(id))return;
    // Capture the displayed position before cancelling a previous compositor
    // transform. This also avoids a jump at the animation-frame boundary.
    const before=captureCards();cancelPositionAnimations();
    const anchor={x:row.x,y:Math.min(...pile.map(id=>unit(id).y))};
    dir>0?pile.push(pile.shift()):pile.unshift(pile.pop());
    layout=core.arrangePile(layout,[...pile,...all.filter(id=>!pile.includes(id))],anchor,viewport());
    touch(all);
    selectCard(cards.find(c=>core.cardUnitId(c.dataset.card)===pile[0]),{followPanels:true,direction:dir});applyPositions();animatePositions(before,motion.duration,motion.easing);persist();
  }
  function syncControls(){document.querySelectorAll('[data-setting="freeMode"]').forEach(el=>{el.checked=active;});}
  function cleanupDOM(){
    exitCompact({instant:true});
    document.body.classList.remove('free-mode');
    cards.forEach(c=>{c.classList.remove('free-collapsed','free-group-hidden','free-pile-buried','free-pile-layered','free-dragging');c.style.left='';c.style.top='';c.style.removeProperty('--free-collapsed-height');c.style.removeProperty('--stack-visible-strip');c.removeAttribute('data-free-group');c.removeAttribute('data-free-pile-depth');c.querySelector('.free-group-label').hidden=true;});
    for(const node of [zones,detail]){for(const name of ['left','top','zIndex','visibility'])node.style[name]='';}
    zones.removeAttribute('data-free-owner');detail.removeAttribute('data-free-owner');lastCurrent='';
    for(const node of [tasksEl,errorsEl]){node.style.zIndex='';node.querySelectorAll('.task-preview,.error-detail').forEach(p=>p.style.left='');}
    performanceNote.hidden=true;syncEmptyUnits();
    snapPreview.hidden=true;
    setStack();setCollapsed(normalCollapsed);updateStackPositions();syncControls();
  }
  // ⭐ 2026-10-19（docs/250 第 19 条）：「自由摆放开着没有」改成这台电脑的设置（ui.html 的 machine-settings.v1），不再看账号那份
  function enabledForCurrentScope(){
    try{
      if(typeof machineSettingsRead==='function'){const m=machineSettingsRead();if(m&&Object.prototype.hasOwnProperty.call(m,'freeMode'))return m.freeMode===true;}
      return settingsRuntime.freeMode===true;
    }catch(_){return false;}
  }
  function enterDOM(result){
    surfaceSize=result.workArea||surfaceSize;
    surfaceMonitors=Array.isArray(result.monitors)&&result.monitors.length?result.monitors:null;
    if(!active)normalCollapsed=isCollapsed;
    if(isCollapsed)setCollapsed(false);
    closeAll();active=true;load();document.body.classList.add('free-mode');clampPositions();
    setStack();applyPositions();setTasks();
  }
  function set(enabled,options={}){
    const requested=!!enabled,requestEpoch=epoch,requestScope=storageKey();
    busy=busy.catch(()=>{}).then(async()=>{
      if(requestEpoch!==epoch||requestScope!==storageKey())return false;
      if(active===requested){syncControls();return true;}
      if(!root.uiwin?.freeMode?.set){report(new Error('当前桌面壳尚不支持自由模式，请启动新版软件。'));syncControls();return false;}
      if(!requested)finishDrag();
      // 切换前每块东西在窗口里的位置 + 透明度（回来时按壳给的原点换算成屏幕位置）
      const before=new Map(motionTargets(transitionNodes().filter(node=>!node.hidden)).map(node=>{const r=node.getBoundingClientRect();return [node,{left:r.left,top:r.top,width:r.width,height:r.height,opacity:getComputedStyle(node).opacity}];}));
      let result;
      switching=true;resizeRevision++;
      try{
        await leaveSurface();
        if(requestEpoch!==epoch||requestScope!==storageKey()){cancelTransition();return false;}
        result=await uiwin.freeMode.set(requested);
      }finally{switching=false;}
      if(!result?.ok){cancelTransition();report(new Error(result?.error||'自由模式窗口切换失败'));syncControls();return false;}
      if(requestEpoch!==epoch||requestScope!==storageKey()){
        // An account switch during the native request must never apply the old layout.
        if(requested){
          let rollback;
          try{rollback=await uiwin.freeMode.set(false);}catch(error){rollback={ok:false,error:String(error?.message||error)};}
          if(!rollback?.ok){
            // The native window is still expanded. Keep the current account's exit path usable.
            enterDOM(result);cancelTransition();syncControls();
            report(new Error(rollback?.error||'窗口恢复失败，请再次退出自由模式'));
            return false;
          }
        }
        active=false;surfaceSize=null;surfaceMonitors=null;cleanupDOM();
        cancelTransition();
        return false;
      }
      if(requested){
        // Native resize acknowledgement may precede the renderer's resize event.
        // Use the acknowledged work area, never the stale ordinary viewport.
        enterDOM(result);
      }else{persist();active=false;surfaceSize=null;surfaceMonitors=null;cleanupDOM();}
      if(!options.restore){settingsRuntime.freeMode=requested;settingsSave();}
      syncControls();persist();
      root.dispatchEvent(new CustomEvent('wheelchair:free-mode-changed',{detail:{active}}));
      await revealSurface(before,{from:result.fromOrigin,to:result.toOrigin});
      return requestEpoch===epoch&&requestScope===storageKey()&&active===requested;
    }).catch(error=>{cancelTransition();report(error);syncControls();return false;});
    return busy;
  }
  function rebind(){
    // ⭐ 2026-10-19（docs/250 第 19 条）：布局和开关都改成跟电脑走以后，换账号读到的还是同一份（键不带账号），
    //   这里重读一遍只是把内存跟存档对齐；仍然要 epoch++ —— 取消换账号那一刻正在进行的切换（见 set 里的 requestEpoch）。
    finishDrag();exitCompact({instant:true});if(layout)persist();epoch++;cancelTransition();
    // Read the new account synchronously, before task-cache restoration can add cards.
    load();if(active)applyPositions();
    const restore=enabledForCurrentScope();
    queueMicrotask(()=>set(restore,{restore:true}));
  }
  function unitForTarget(target){
    const card=target.closest?.('.block-card');if(card)return core.cardUnitId(card.dataset.card);
    if(target.closest?.('#tasks'))return 'tasks';if(target.closest?.('#errors'))return 'errors';return null;
  }
  function cardAtPoint(x,y){
    if(compact)return null;                    // 收成小方块时卡都藏着，矩形还在 —— 别让滚轮 / 悬停摸到看不见的卡
    const candidates=cards.filter(card=>{
      if(card.hidden||card.matches('.free-group-hidden,.free-pile-buried')||!hitRect(x,y,card,0,8))return false;
      // hitRect uses the full DOM rectangle. When low opacity clips a pile
      // member, reject the invisible upper part in this fallback path too;
      // native hit testing already respects clip-path, but hover navigation
      // also calls cardAtPoint() directly.
      if(card.classList.contains('free-pile-layered')){
        const clip=getComputedStyle(card).clipPath;
        if(clip!=='none'){
          const strip=parseFloat(getComputedStyle(card).getPropertyValue('--stack-visible-strip'))||34;
          if(y<card.getBoundingClientRect().bottom-strip)return false;
        }
      }
      return true;
    });
    candidates.sort((a,b)=>Number(b.style.zIndex||0)-Number(a.style.zIndex||0));
    return candidates[0]||null;
  }
  function activateCard(card){
    if(!active||compact||!card||card.hidden||card.matches('.free-collapsed,.free-group-hidden,.free-pile-buried'))return false;
    if(cards[cur]!==card){
      const id=core.cardUnitId(card.dataset.card),currentId=core.cardUnitId(cards[cur].dataset.card);
      // Wheel motion can temporarily carry an old member underneath a still
      // pointer. Do not make that animation frame replace the selected owner.
      // Moving into another group and explicit clicks remain available.
      if(unit(id)?.groupId===unit(currentId)?.groupId&&[...positionAnimations.entries()].some(([node,animation])=>
        unit(core.cardUnitId(node.dataset.card))?.groupId===unit(currentId)?.groupId&&['running','paused'].includes(animation.playState)))return false;
    }
    if(cards[cur]!==card)selectCard(card,{raise:false});
    return true;
  }
  function hitTest(x,y){
    if(!active)return false;
    if(compact){
      // 收成小方块：只有方块接鼠标；要用户做决定的报错卡照常弹出来，它们也得点得到
      if(blockDrag)return true;
      if(!block.hidden&&hitRect(x,y,block,0,4))return true;
      if(errorsBlocking())for(const child of errorsEl.querySelectorAll('.error-card,.error-detail.show'))if(hitRect(x,y,child,0,8))return true;
      return false;
    }
    if(drag)return true;
    // ⭐ 10-26（用户真机报：自由摆放里打开工具大卡，PS 有一大片点不动）：工具大卡开着时，底下的卡片、任务卡、报错卡
    //   都被让位动画收起、看不见了（tool-workbench.css 只给 #stack/#zones 关了 pointer-events），可这里照旧按它们的矩形算
    //   ⇒ 一大片看不见的区域吃掉鼠标。⇒ 大卡开着时只认大卡自己（工具大卡就是 #detail）；要用户做决定的报错卡照常能点。
    if(document.body.classList.contains('v7tw-covering')){
      if(detail.classList.contains('show')&&hitRect(x,y,detail,0,8))return true;
      if(errorsBlocking())for(const child of errorsEl.querySelectorAll('.error-card,.error-detail.show'))if(hitRect(x,y,child,0,8))return true;
      return false;
    }
    if(typeof freeNavigationBridgeHit==='function'&&freeNavigationBridgeHit(x,y))return true;
    if(cardAtPoint(x,y))return true;
    if(!collapsed.has(core.cardUnitId(cards[cur].dataset.card))){
      if(zones.classList.contains('show')&&hitRect(x,y,zones,0,20))return true;
      if(detail.classList.contains('show')&&hitRect(x,y,detail,0,20))return true;
    }
    for(const [id, item] of anchors){
      if(root.V7WorkspaceStackRail?.isHidden(id))continue;
      if(hitRect(x,y,item.handle)||(!item.placeholder.hidden&&hitRect(x,y,item.placeholder)))return true;
      const node=id==='tasks'?tasksEl:errorsEl;
      for(const child of node.querySelectorAll('.task:not(.leaving),.error-card,.task-preview.show,.error-detail.show'))if(hitRect(x,y,child,0,8))return true;
    }
    return false;
  }
  function beginDrag(event,id){
    if(event.button!==0||!unit(id)||transitioning)return;
    event.preventDefault();event.stopImmediatePropagation();
    const card=id.startsWith('card:')?cards.find(c=>c.dataset.card===unit(id).cardId):null;
    // An automatically displaced error pile starts dragging from its visible
    // origin, then becomes the user's new saved placement.
    if(id==='errors'){unit(id).x=parseFloat(errorsEl.style.left)||unit(id).x;unit(id).y=parseFloat(errorsEl.style.top)||unit(id).y;}
    if(card)selectCard(card);else raise(id);
    const row={...unit(id)},pile=card?core.pileIds(layout,id):[id],rows=pile.map(member=>({...unit(member)}));
    const node=card||(id==='tasks'?tasksEl:errorsEl);
    const nodes=card?cards.filter(item=>pile.includes(core.cardUnitId(item.dataset.card))):[node];
    drag={id,node,nodes,pile,rows,x:event.clientX,y:event.clientY,left:row.x,top:row.y,moved:false,snap:null,
      // 记下松手那一刻指针在哪。拖拽期间窗口一定在接收输入，指针必然停在卡片上；
      // 松手后要靠这个坐标判断"该不该把点击让给下层"，不能凭想象直接开穿透。
      pointer:{x:event.clientX,y:event.clientY}};
    nodes.forEach(item=>item.classList.add('free-dragging'));
    uiwin.setIgnoreMouse(false);
  }
  function moveNow(){
    frame=0;if(!drag||!pending)return;
    const start=performance.now(),point=pending;pending=null;
    if(!drag.moved){
      if(Math.hypot(point.x-drag.x,point.y-drag.y)<4)return;
      drag.moved=true;
    }
    const row=unit(drag.id);
    let height=row.height;
    if(row.kind==='card')height=collapsed.has(row.id)?drag.node.offsetHeight:Math.max(...drag.rows.map(item=>item.y+item.height))-drag.top;
    if(row.kind==='tasks'){const el=tasksEl.querySelector('.task');height=el?el.offsetHeight||150:110;}
    if(row.kind==='errors'){const el=errorsEl.querySelector('.error-card');height=el?el.offsetHeight||100:110;}
    const clamped=core.clampRect({...row,height,x:drag.left+point.x-drag.x,y:drag.top+point.y-drag.y},viewport());
    const hiddenIds=cards.filter((c,i)=>layoutHidden.has(i)||c.matches('.free-group-hidden,.free-pile-buried')).map(c=>core.cardUnitId(c.dataset.card));
    // Folded members retain expanded positions for restore; only their visible bar is a target.
    const snapLayout={...layout,units:layout.units.map(member=>member.kind==='card'&&collapsed.has(member.id)?{...member,y:Math.min(...core.pileIds(layout,member.id).map(id=>unit(id).y))}:member)};
    drag.snap=row.kind==='card'?core.snapCandidate(snapLayout,row.id,{...row,x:clamped.x,y:clamped.y},[...hiddenIds,...drag.pile]):null;
    // ⭐ 2026-10-22 对齐吸附（free-layout-core alignSnap）：没要合成一叠时，跟附近的卡左/右/顶/底对齐或隔 16px 贴着。
    //   按住 Alt 临时不吸（想放在两条对齐线中间时用）。
    let guides=[];
    if(!drag.snap&&!point.alt){
      const others=cards.filter(c=>!c.matches('.free-group-hidden,.free-pile-buried')&&c.offsetParent!==null&&!drag.pile.includes(core.cardUnitId(c.dataset.card)))
        .map(c=>({x:parseFloat(c.style.left)||0,y:parseFloat(c.style.top)||0,width:c.offsetWidth,height:c.offsetHeight}));
      for(const special of [tasksEl,errorsEl])if(special&&special!==drag.node&&special.offsetWidth)others.push({x:parseFloat(special.style.left)||0,y:parseFloat(special.style.top)||0,width:300,height:special.querySelector('.task,.error-card')?.offsetHeight||110});
      const s=core.alignSnap({x:clamped.x,y:clamped.y,width:drag.node.offsetWidth||row.width,height},others);
      const again=core.clampRect({...clamped,x:s.x,y:s.y},viewport());
      if(again.x===s.x)clamped.x=s.x;if(again.y===s.y)clamped.y=s.y;
      guides=s.guides;
    }
    showGuides(guides);
    for(const original of drag.rows){const member=unit(original.id);member.x=original.x+clamped.x-drag.left;member.y=original.y+clamped.y-drag.top;}
    touch(drag.pile);
    snapPreview.hidden=!drag.snap;
    document.querySelectorAll('.free-snap-target').forEach(node=>node.classList.remove('free-snap-target'));
    if(drag.snap){
      const pile=core.pileIds(layout,drag.snap.id),y=Math.min(...pile.map(id=>unit(id).y));
      setStyle(snapPreview,'left',drag.snap.x+'px');setStyle(snapPreview,'top',y+'px');
      cards.find(c=>core.cardUnitId(c.dataset.card)===drag.snap.id)?.classList.add('free-snap-target');
    }
    if(row.kind==='card'){drag.pile.forEach(id=>applyCard(unit(id)));updateLinkedPanels();}
    else{
      syncSpecialUnit(row.id);
      // Dragging a task pile toward the bottom reduces its visible staircase;
      // error avoidance must use those same final offsets, not stale layers.
      if(row.kind==='tasks')setTasks();
    }
    scheduleSave();
    const elapsed=performance.now()-start;slowFrames=elapsed>16?slowFrames+1:Math.max(0,slowFrames-1);
    performanceNote.hidden=slowFrames<4;
  }
  function finishDrag(){
    if(!drag)return;if(frame){cancelAnimationFrame(frame);frame=0;}moveNow();
    // 松手后指针几乎总是还停在卡片上。以前这里无脑 setIgnoreMouse(true)，
    // 等于把用户接下来那一下点击直接让给了后面的 Photoshop ——
    // 表现就是"挡住了、点不动"，要点第二次（等 60ms 轮询把状态收回来）才生效。
    // 改成按松手时的指针位置重新过一遍几何判定：命中界面就继续保持可点，
    // 只有确实落在空白处才把点击让出去。判定不出来时保守取"可点"，
    // 宁可多挡一次鼠标，也不能让整个面板点不到。
    const releasePoint=drag.pointer;
    const before=captureCards();
    if(drag.snap){
      const pile=core.pileIds(layout,drag.snap.id),anchor={x:drag.snap.x,y:Math.min(...pile.map(id=>unit(id).y))};
      const merged=[...drag.pile,...pile],folded=collapsed.has(drag.snap.id);
      merged.forEach(id=>folded?collapsed.add(id):collapsed.delete(id));
      layout=core.arrangePile(layout,merged,anchor,folded?null:viewport());clampPositions();
      touch(merged);
    }
    if(drag.moved)touch(drag.pile);
    drag.nodes.forEach(node=>node.classList.remove('free-dragging'));drag=null;pending=null;snapPreview.hidden=true;showGuides([]);
    document.querySelectorAll('.free-snap-target').forEach(node=>node.classList.remove('free-snap-target'));
    applyPositions();animatePositions(before);persist();
    root.dispatchEvent(new Event('wheelchair:setup-window-closed'));
    const stillOverUI=!releasePoint||typeof root.__uiHitTest!=='function'
      ?true
      :!!root.__uiHitTest(releasePoint.x,releasePoint.y);
    uiwin.setIgnoreMouse(!stillOverUI);
    performanceNote.hidden=true;
  }
  function releaseCard(card){
    const id=core.cardUnitId(card.dataset.card),pile=core.pileIds(layout,id);if(pile.length<2)return;
    const before=captureCards(),row={...unit(id)},anchor={x:row.x,y:Math.min(...pile.map(member=>unit(member).y))};
    layout=core.arrangePile(layout,pile.filter(member=>member!==id),anchor,collapsed.has(id)?null:viewport());
    const candidates=[{x:anchor.x+340,y:anchor.y},{x:anchor.x-340,y:anchor.y},{x:anchor.x,y:anchor.y+434},{x:anchor.x,y:anchor.y-434}].map(point=>core.clampRect({...row,...point},viewport()));
    const overlap=point=>layout.units.filter(member=>member.id!==id&&member.kind==='card').reduce((sum,member)=>sum+Math.max(0,Math.min(point.x+point.width,member.x+member.width)-Math.max(point.x,member.x))*Math.max(0,Math.min(point.y+point.height,member.y+member.height)-Math.max(point.y,member.y)),0);
    candidates.sort((a,b)=>overlap(a)-overlap(b));
    layout=core.arrangePile(layout,[id],candidates[0],viewport());
    touch(pile);
    selectCard(card);clampPositions();applyPositions();animatePositions(before);persist();
    card.querySelector('[data-collapse-toggle]').focus({preventScroll:true});
  }
  for(const id of ['tasks','errors']){
    const node=id==='tasks'?tasksEl:errorsEl,label=id==='tasks'?'任务卡堆':'报错卡堆';
    const handle=document.createElement('button');handle.className='free-stack-handle';handle.type='button';handle.textContent='拖动'+label;handle.dataset.freeDrag=id;
    const placeholder=document.createElement('div');placeholder.className='free-empty-card';placeholder.hidden=true;placeholder.dataset.freeDrag=id;placeholder.tabIndex=0;placeholder.setAttribute('role','group');placeholder.setAttribute('aria-label',label+'空位，可拖动摆放');
    const title=document.createElement('strong');title.textContent=label;placeholder.append(title);
    placeholder.dataset.bgkey='free.placeholder.'+id;placeholder.dataset.bglabel=label+'占位';placeholder.dataset.bgtype='free-placeholder';
    node.append(handle,placeholder);anchors.set(id,{handle,placeholder});
  }
  for(const card of cards){
    const release=document.createElement('button');release.type='button';release.className='free-release';release.dataset.freeRelease='';release.title='从卡组释放';release.setAttribute('aria-label','从卡组释放');release.innerHTML=root.ICON.render('arrowUpRight',14);card.append(release);
    const names=document.createElement('span');names.className='free-group-label';names.hidden=true;card.append(names);
  }
  document.addEventListener('mousedown',event=>{
    if(!active||transitioning||v7OverlayOpen()||document.getElementById('popupLock').classList.contains('on'))return;
    const id=unitForTarget(event.target);if(!id)return;
    const card=event.target.closest('.block-card');
    if(event.target.closest('[data-free-release],[data-collapse-toggle]'))return;
    if(event.target.closest('[data-dragbar],[data-free-drag]')||card?.classList.contains('free-collapsed')){beginDrag(event,id);return;}
    // ⭐ 2026-10-04 用户实测报的「在自由模式点卡片的名字直接切卡，中间竟然没有动画」。
    //   真因：这里原来调 selectCard(card) → raise() → applyPositions()，
    //   全程【只写 left/top，没有任何补间】—— 位置是硬跳过去的。
    //   标准模式切卡是有动画的（--dur 的整卡滚动），自由模式缺了这一层。
    //   ⚠ 用户 2026-10-01 定案：自由模式和标准模式【必须一致】（见 ui.html:7134）。
    //   ⚠ 为什么加在这里、不加在 raise() 里：raise() 还被 activate() 调，
    //     而 activate() 是滚轮/跟随路径，那里【故意】不要动画
    //     （已经在动的卡片再补一次会互相打架）。所以只在"真点击"这条路上补。
    const id2=id;
    if(card&&cards.indexOf(card)!==cur){
      const before=captureCards();cancelPositionAnimations();
      selectCard(card);applyPositions();animatePositions(before);
    }else raise(id2);
  },true);
  document.addEventListener('click',event=>{
    if(!active||transitioning)return;
    const release=event.target.closest('[data-free-release]');if(release){event.preventDefault();event.stopImmediatePropagation();releaseCard(release.closest('.block-card'));return;}
    const button=event.target.closest('[data-collapse-toggle]');if(!button)return;
    const card=button.closest('.block-card');if(!card)return;
    event.preventDefault();event.stopImmediatePropagation();selectCard(card);
    const id=core.cardUnitId(card.dataset.card),pile=core.pileIds(layout,id),folded=!collapsed.has(id);pile.forEach(member=>folded?collapsed.add(member):collapsed.delete(member));
    touch(pile);
    if(collapsed.has(id))closeAll();clampPositions();applyPositions();persist();
  },true);
  root.addEventListener('mousemove',event=>{if(!drag)return;drag.pointer={x:event.clientX,y:event.clientY};pending={x:event.clientX,y:event.clientY,alt:event.altKey};if(!frame)frame=requestAnimationFrame(moveNow);},true);
  root.addEventListener('mouseup',finishDrag,true);root.addEventListener('blur',finishDrag);
  root.addEventListener('resize',async()=>{
    if(!active||!layout||switching)return;
    const revision=++resizeRevision,owner=scope;
    // Native emergency exit resizes before the renderer receives its exit event.
    // Verify native mode before clamping, or the small normal window destroys the saved layout.
    try{
      const native=await uiwin.freeMode.pulse();
      if(!native?.enabled||!active||switching||revision!==resizeRevision||owner!==scope)return;
      // ⭐ 2026-10-21（docs/261 B2，用户：最小化再点回来，所有卡叠回左上角）：
      //   最小化那一下窗口只剩 0 / 一小块 —— 拿它去挤，所有卡被挤进 300×44 的左上角。最小化 / 小得离谱就这次不挪。
      const area=native.workArea;
      if(native.minimized||(area&&(area.width<200||area.height<200)))return;
      surfaceSize=area||surfaceSize;
      // ⭐ 同一处第二道保险：没被用户动过的卡，每次都从【存档原位置】重新挤 ——
      //   屏幕先变小再变大（换屏、远程桌面、改缩放），卡能回到原位，而不是在上一次挤过的位置上再挤一次。
      const off=homeOffset();
      layout=core.normalize({...layout,units:layout.units.map(r=>{const keep=!touched.has(r.id)&&savedPos.get(r.id);return keep?{...r,x:keep.x+off.x,y:keep.y+off.y}:r;})});
      clampPositions();applyPositions();persist();
      if(compact)blockPlace();
    }catch(error){report(error);}
  });
  root.addEventListener('beforeunload',persist);
  root.uiwin?.freeMode?.onExitRequest(()=>{
    // This event is emitted only after native recovery succeeded. Do not queue it behind motion.
    finishDrag();persist();epoch++;cancelTransition();active=false;surfaceSize=null;surfaceMonitors=null;cleanupDOM();
    settingsRuntime.freeMode=false;settingsSave();syncControls();
    root.dispatchEvent(new CustomEvent('wheelchair:free-mode-changed',{detail:{active:false}}));
  });
  root.uiwin?.freeMode?.onMouseReset(()=>root.dispatchEvent(new Event('wheelchair:setup-window-closed')));
  if(root.uiwin?.freeMode?.pulse)setInterval(()=>{if(active)uiwin.freeMode.pulse().catch(()=>{});},1000);
  // ⭐ 2026-10-19（docs/250 第 17 条，用户定）：快捷键「一键收起」在自由摆放时 = 整个面板收成一个小方块（原来是所有卡组一起折叠）。
  //   用户原话：「按一个键，整个面板全部收起来，变成一个窄的方块，跟标准任务卡差不多大小；方块上挑重要信息显示；能拖动、记位置」
  //   ⚠ 只是藏起来：布局、折叠、存档一个字不动；展开 = 全部原样回来（位置不变）。
  //   ⚠ 收着的时候透明窗口只有方块那块接鼠标（hitTest），其余全部穿透给 Photoshop。
  //   ⚠ 要用户做决定的 L3 卡照常弹出来（CSS 只藏普通报错，跟 workspace-stack-rail.css 同一条规矩）；普通报错只在方块上亮红角标。
  //   ⚠ 有人要打开卡（报错卡上的按钮、助手、教程…走 navigateCard）⇒ 先放回来（ui.html 的 navigateCard 里调 expandCompact）。
  const BLOCK_KEY='free.collapsedBlock.v1',BLOCK_W=300,BLOCK_H=64;
  const block=document.createElement('div');block.className='free-block';block.hidden=true;block.tabIndex=0;block.setAttribute('role','button');
  block.setAttribute('aria-label','展开面板（按住可以拖动）');block.title='点一下展开面板；按住可以拖到别处';
  block.innerHTML='<span class="fb-dot" data-fb-dot></span><span class="fb-text"><span class="fb-line1" data-fb-line1></span><span class="fb-line2" data-fb-line2></span></span>'
    +'<span class="fb-badges"><span class="fb-badge fb-err" data-fb-err hidden></span><span class="fb-badge fb-ok" data-fb-ok hidden></span></span><span class="fb-bar" data-fb-bar></span>';
  document.body.append(block);
  // 方块位置跟电脑走（跟第 19 条的布局同一个规矩）
  const blockKey=()=>{const S=root.WHEELCHAIR_STORAGE;return S&&typeof S.localKey==='function'?S.localKey(BLOCK_KEY):BLOCK_KEY;};
  function blockSaved(){try{const v=JSON.parse(localStorage.getItem(blockKey())||'null');return v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?{x:v.x,y:v.y}:null;}catch(_){return null;}}
  function blockPlace(){
    // 第一次出现在右上角（自由摆放时窗口铺满主窗口所在那块屏的工作区）。挤进屏幕只影响显示，不覆盖存档
    // ⭐ 2026-10-20 多屏：存的位置相对软件所在那块屏（同布局存档）；摆的时候夹进它落在的那块屏，别掉进屏和屏之间的空当
    const off=homeOffset(),home=surfaceMonitors&&surfaceMonitors[0]?surfaceMonitors[0]:{x:0,y:0,width:surfaceWidth(),height:surfaceHeight()};
    const raw=blockSaved(),want=raw?{x:raw.x+off.x,y:raw.y+off.y}:{x:home.x+home.width-BLOCK_W-24,y:home.y+64};
    const vp=core.pickViewport({x:want.x,y:want.y,width:BLOCK_W,height:BLOCK_H},surfaceMonitors,{x:0,y:0,width:surfaceWidth(),height:surfaceHeight()});
    blockPos={x:clamp(want.x,vp.x+8,vp.x+vp.width-BLOCK_W-8),y:clamp(want.y,vp.y+8,vp.y+vp.height-BLOCK_H-8)};
    setStyle(block,'left',blockPos.x+'px');setStyle(block,'top',blockPos.y+'px');
  }
  // 拖完：就地夹进它落在的那块屏（多屏时别停在屏和屏之间的空当里）—— 不读存档
  function blockOnScreen(){
    const vp=core.pickViewport({x:blockPos.x,y:blockPos.y,width:BLOCK_W,height:BLOCK_H},surfaceMonitors,{x:0,y:0,width:surfaceWidth(),height:surfaceHeight()});
    blockPos={x:clamp(blockPos.x,vp.x+8,vp.x+vp.width-BLOCK_W-8),y:clamp(blockPos.y,vp.y+8,vp.y+vp.height-BLOCK_H-8)};
    setStyle(block,'left',blockPos.x+'px');setStyle(block,'top',blockPos.y+'px');
  }
  function blockSummary(){
    let s=null;try{s=typeof freeCompactSummary==='function'?freeCompactSummary():null;}catch(_){s=null;}
    return s||{running:0,pct:0,doneShots:0,errors:0,preset:'',link:{}};
  }
  function blockRefresh(){
    if(!compact)return;
    const s=blockSummary(),now=Date.now(),q=sel=>block.querySelector(sel);
    const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
    // 「完成 N 张」：收起之后新出的图，最后一张出来后亮 6 秒
    if(s.doneShots>lastDone){recentDone=(now<recentUntil?recentDone:0)+(s.doneShots-lastDone);recentUntil=now+6000;}
    lastDone=s.doneShots;if(now>=recentUntil)recentDone=0;
    const link=s.link||{},state=link.connected?(link.background?'bg':'ok'):'off',dot=q('[data-fb-dot]');
    if(dot.dataset.state!==state){dot.dataset.state=state;dot.title=state==='ok'?'Photoshop 已连接':state==='bg'?'已连接 · Photoshop 在后台':'Photoshop 没连上';}
    text(q('[data-fb-line1]'),s.running?'正在算 '+s.running+' 个 · '+s.pct+'%':'空闲');
    text(q('[data-fb-line2]'),s.preset?'当前预设：'+s.preset:'当前没选预设');
    const err=q('[data-fb-err]');err.hidden=!s.errors;text(err,s.errors+' 条报错');
    const ok=q('[data-fb-ok]');ok.hidden=!recentDone;text(ok,'完成 '+recentDone+' 张');
    setStyle(q('[data-fb-bar]'),'width',(s.running?Math.max(4,s.pct):0)+'%');
  }
  const errorsBlocking=()=>errorsEl.classList.contains('has-blocking')||errorsEl.hasAttribute('data-v7-confirmation')||!!errorsEl.querySelector('.ec-l3,.ec-l4');
  // 飞向方块 / 从方块飞回来的那几样：看得见的卡、任务堆、（没有要做决定的卡时）报错堆
  function compactNodes(){
    const list=cards.filter(c=>!c.hidden&&!c.matches('.free-group-hidden,.free-pile-buried'));
    if(tasksEl.querySelector('.task:not(.leaving)'))list.push(tasksEl);
    if(!errorsBlocking()&&errorsEl.querySelector('.error-card'))list.push(errorsEl);
    // ⭐ 2026-10-20（用户：「两个悬浮条的移动合并也没做」）：顶部导航条和助手悬浮条收拢时也藏（free-mode-ui.css），
    //   原来不在这份名单里 ⇒ 原地消失。一起飞进方块、一起飞回来。
    document.querySelectorAll('.v7-floating-bar,.planner-attention').forEach(bar=>{if(!bar.hidden&&getComputedStyle(bar).display!=='none')list.push(bar);});   // 提醒角标（.planner-attention）收拢时也藏，一起走
    return list;
  }
  // ⚠ 2026-10-20：原来的 flyTo（按中心算位移 + scale(.3)，主卡 transform-origin 却在左上 ⇒ 落不到方块上）已删，
  //   收拢 / 放回现在按真实矩形走（boxInfo / rectTransform），细节见 enterCompact、exitCompact 里的注释。
  async function enterCompact(){
    compactBusy=true;
    try{
      // 二三级里嵌着大工作区（工具卡）时先让它自己收（可能要问存不存）；不肯收就不收拢
      if(root.V7Workspaces?.hasEmbedded?.()&&await root.V7Workspaces.requestCloseAll()===false)return false;
      if(!active||compact)return false;
      compact=true;
      closeAll();if(typeof clearPreview==='function')clearPreview();root.V7Tween?.hideBox?.();
      blockPlace();lastDone=blockSummary().doneShots;recentDone=0;recentUntil=0;blockRefresh();
      const center={x:blockPos.x+BLOCK_W/2,y:blockPos.y+BLOCK_H/2},still=reducedMotion();
      // ⭐⭐ 2026-10-20 第二版（用户：「加快…融合到变成新的一张缩略卡片的过程当中增加一些交互效果，现在就是移到一个地方直接变成一张卡片，
      //   没有那种融合叠加的感觉」）：
      //   ① 更快：临界阻尼弹簧 0.3（≈0.45 秒），一张接一张只差 10ms；
      //   ② 融合：每张卡一边飞一边【变成方块的形状】（高卡压成扁条），快到时在方块上方一层层叠起来（越晚到越靠上），
      //      最后一截糊开 + 淡掉 —— 像好几张卡揉成了一张；
      //   ③ 接住：方块在卡飞到一半时就浮出来，卡落下的那一刻「被压一下再弹回」+ 一圈主题色的光，里面的字最后才出来。
      const into=spring(0.3,1),STAGGER=10;
      const nodes=motionTargets(compactNodes()).map(node=>({node,info:boxInfo(node)})).filter(row=>row.info.rect.width&&row.info.rect.height);
      const dist=row=>Math.hypot(row.info.rect.left+row.info.rect.width/2-center.x,row.info.rect.top+row.info.rect.height/2-center.y);
      nodes.sort((a,b)=>dist(a)-dist(b));
      const blockRect={left:blockPos.x,top:blockPos.y,width:BLOCK_W,height:BLOCK_H};
      const stacked=i=>{const grow=1.06,lift=Math.min(i,6)*3;return {left:center.x-BLOCK_W*grow/2,top:center.y-BLOCK_H*grow/2-lift,width:BLOCK_W*grow,height:BLOCK_H*grow};};
      const animations=still?[]:nodes.map((row,i)=>animate(row.node,[
        {offset:0,transformOrigin:ORIGIN0,transform:row.info.F0.toString(),opacity:row.info.opacity,filter:'blur(0px)'},
        {offset:.55,filter:'blur(0px)'},
        {offset:.74,transformOrigin:ORIGIN0,transform:rectTransform(row.info,stacked(i)),opacity:row.info.opacity},
        {offset:1,transformOrigin:ORIGIN0,transform:rectTransform(row.info,blockRect),opacity:0,filter:'blur(6px)'}
      ],{duration:into.duration,easing:into.easing,delay:i*STAGGER,fill:'forwards'}));
      // ⚠ 去掉 hidden 和开始播放在同一拍里：第一帧就是透明的，不会先闪一下终态
      block.hidden=false;
      const land=into.duration*.74+Math.max(0,nodes.length-1)*STAGGER;   // 最后一张落到方块上的时刻
      const total=Math.max(land+300,into.duration+nodes.length*STAGGER);
      const base=getComputedStyle(block).boxShadow;
      const glow=(base&&base!=='none'?base+', ':'')+'0 0 26px 3px color-mix(in srgb, var(--accent) 55%, transparent)';
      const at=ms=>Math.min(.98,Math.max(.02,ms/total));
      const blockIn=still?null:animate(block,[
        {offset:0,opacity:0,transform:'scale(.88)',boxShadow:base},
        {offset:at(into.duration*.4),opacity:1,transform:'scale(.95)'},
        {offset:at(land),transform:'scale(1.05,.9)',boxShadow:glow},
        {offset:at(land+110),transform:'scale(.985,1.03)'},
        {offset:1,transform:'none',boxShadow:base}
      ],{duration:total,easing:'linear',fill:'backwards'});
      const inner=still?[]:[...block.children].map(child=>animate(child,[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}],{duration:(root.V7Motion?root.V7Motion.MS.base:200),delay:Math.round(land),easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'}));
      await waitMotion([...animations,...(blockIn?[blockIn]:[]),...inner],total+80);
      // ⚠ 动画放着的时候被放回来 / 退出了自由摆放（exitCompact 已经把 compact 置回 false）⇒ 这次收拢作废，别再挂「藏起来」
      if(!compact||!active){for(const animation of animations)animation.cancel();if(blockIn)blockIn.cancel();return false;}
      // ⚠ 先挂上「藏起来」再撤掉飞走的动画 —— 反过来的话撤的那一帧会闪回原位
      document.body.classList.add('free-mode-compact');
      for(const animation of animations)animation.cancel();
      clearInterval(blockTimer);blockTimer=setInterval(blockRefresh,500);
      root.dispatchEvent(new CustomEvent('wheelchair:free-compact-changed',{detail:{compact:true}}));
      return true;
    }catch(error){report(error);return false;}
    finally{compactBusy=false;}
  }
  // instant：离开自由摆放 / 换账号 / 有人要打开卡时用，不播动画
  async function exitCompact(options={}){
    if(!compact)return true;
    compact=false;clearInterval(blockTimer);blockTimer=0;blockDrag=null;block.classList.remove('fb-dragging');
    const center=blockPos?{x:blockPos.x+BLOCK_W/2,y:blockPos.y+BLOCK_H/2}:null;
    document.body.classList.remove('free-mode-compact');
    if(options.instant||!center||reducedMotion()||!active){block.hidden=true;root.dispatchEvent(new CustomEvent('wheelchair:free-compact-changed',{detail:{compact:false}}));return true;}
    compactBusy=true;
    try{
      applyPositions();
      // 去掉「藏起来」和从方块飞回来的第一帧在同一拍里 —— 不会先在原位闪一下
      // ⭐ 2026-10-20 第二版：反过来 —— 方块先鼓一下，卡从「揉在一起、糊着」的方块里散出来、各自弹回位置（带一点回弹），近的先出来
      const out=spring(0.34,0.8),STAGGER=10;
      const nodes=motionTargets(compactNodes()).map(node=>({node,info:boxInfo(node)})).filter(row=>row.info.rect.width&&row.info.rect.height);
      const dist=row=>Math.hypot(row.info.rect.left+row.info.rect.width/2-center.x,row.info.rect.top+row.info.rect.height/2-center.y);
      nodes.sort((a,b)=>dist(a)-dist(b));
      const blockRect={left:blockPos.x,top:blockPos.y,width:BLOCK_W,height:BLOCK_H};
      const animations=nodes.map((row,i)=>animate(row.node,[
        {offset:0,transformOrigin:ORIGIN0,transform:rectTransform(row.info,blockRect),opacity:0,filter:'blur(6px)'},
        {offset:.18,opacity:row.info.opacity},
        {offset:.32,filter:'blur(0px)'},
        {offset:1,transformOrigin:ORIGIN0,transform:row.info.F0.toString(),opacity:row.info.opacity,filter:'blur(0px)'}
      ],{duration:out.duration,easing:out.easing,delay:i*STAGGER,fill:'backwards'}));
      const blockOut=animate(block,[
        {offset:0,opacity:1,transform:'none'},
        {offset:.35,opacity:1,transform:'scale(1.06,.9)'},
        {offset:1,opacity:0,transform:'scale(1.12,1.3)'}
      ],{duration:(root.V7Motion?root.V7Motion.MS.base:200),easing:'cubic-bezier(.3,0,.7,1)',fill:'forwards'});
      await waitMotion([...animations,blockOut],out.duration+nodes.length*STAGGER+80);
      if(!compact)block.hidden=true;blockOut.cancel();
    }finally{compactBusy=false;}
    root.dispatchEvent(new CustomEvent('wheelchair:free-compact-changed',{detail:{compact:false}}));
    return true;
  }
  // 快捷键入口。⚠ 正在切换 / 拖动时返回 null —— ui.html 靠它给「这次没执行」的提示（第 18 条）
  function toggleCompact(){
    if(!active||!layout||transitioning||compactBusy||drag||blockDrag)return null;
    if(compact){exitCompact();return {compact:false};}
    enterCompact();return {compact:true};
  }
  // 方块：按住拖动（记位置），没拖就是点一下 = 展开
  block.addEventListener('mousedown',event=>{
    if(event.button!==0||!compact||compactBusy)return;
    event.preventDefault();event.stopPropagation();
    blockDrag={x:event.clientX,y:event.clientY,left:blockPos.x,top:blockPos.y,moved:false,pointer:{x:event.clientX,y:event.clientY}};
    root.uiwin?.setIgnoreMouse?.(false);
  });
  block.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&compact&&!compactBusy){event.preventDefault();exitCompact();}});
  root.addEventListener('mousemove',event=>{
    if(!blockDrag)return;
    blockDrag.pointer={x:event.clientX,y:event.clientY};
    const dx=event.clientX-blockDrag.x,dy=event.clientY-blockDrag.y;
    if(!blockDrag.moved){if(Math.hypot(dx,dy)<4)return;blockDrag.moved=true;block.classList.add('fb-dragging');}
    blockPos={x:clamp(blockDrag.left+dx,8,surfaceWidth()-BLOCK_W-8),y:clamp(blockDrag.top+dy,8,surfaceHeight()-BLOCK_H-8)};
    setStyle(block,'left',blockPos.x+'px');setStyle(block,'top',blockPos.y+'px');
  },true);
  root.addEventListener('mouseup',()=>{
    const done=blockDrag;if(!done)return;blockDrag=null;block.classList.remove('fb-dragging');
    if(done.moved){blockOnScreen();const off=homeOffset();try{localStorage.setItem(blockKey(),JSON.stringify({x:blockPos.x-off.x,y:blockPos.y-off.y}));}catch(error){report(error);}}
    else{exitCompact();return;}
    // 松手后按指针位置重新判一次穿透（同 finishDrag 的道理：别把下一下点击白白让给 Photoshop）
    const stillOverUI=typeof root.__uiHitTest!=='function'?true:!!root.__uiHitTest(done.pointer.x,done.pointer.y);
    root.uiwin?.setIgnoreMouse?.(!stillOverUI);
  },true);
  root.addEventListener('blur',()=>{if(blockDrag){blockDrag=null;block.classList.remove('fb-dragging');}});
  root.V7FreeMode={toggleCompact,isCompact:()=>compact,expandCompact:exitCompact,isActive:()=>active,isDragging:()=>!!drag||!!blockDrag,isTransitioning:()=>transitioning,cardUnitId:core.cardUnitId,unit,zIndex,activate,activateCard,cardAtPoint,expandGroup,cycleAtCurrent,
    applyPositions,updateLinkedPanels,syncSpecialUnit,syncEmptyUnits,hitTest,set,rebind,
    snapshot:()=>layout?JSON.parse(JSON.stringify({layout,collapsed:[...collapsed],active})):null};
  // monitors()：2026-10-21 加的只读查询（测试用）—— 多屏时每块屏在窗口里的位置，第一块 = 软件所在那块；单屏 / 没进自由摆放 = null
  // moveUnit(id,x,y)：2026-10-21 —— 按「用户亲手挪了这张」的方式挪（记成动过 ⇒ 会存档；见上面 savedPos / touched 的规矩）。
  //   直接改 unit(id).x/y 只是临时摆，不算用户动过、不进存档（10-19 定的：挤进屏幕之类的程序挪动不覆盖存档）。
  //   ⚠ 单独挂、别塞进上面那个对象的开头：tests/collapse-shortcut.test.js 按源码认「root.V7FreeMode={toggleCompact,isCompact:」
  root.V7FreeMode.monitors=()=>surfaceMonitors?surfaceMonitors.map(m=>Object.assign({},m)):null;
  root.V7FreeMode.moveUnit=(id,x,y)=>{const u=unit(id);if(!u||!active)return false;u.x=Number(x);u.y=Number(y);touch([id]);clampPositions();applyPositions();persist();return true;};
  // ⭐ 2026-10-21（docs/261 U6）：给「我的布局」快照用 —— 存的是【存档里的样子】（没被挤过的原坐标、哪些折叠着）。
  //   importPlacement 写回存档；开着自由摆放就马上按它重新摆（跟进入自由摆放走同一条：load → 挤进屏幕 → 摆）。
  root.V7FreeMode.exportPlacement=()=>{
    try{if(active&&layout)persist();const saved=JSON.parse(localStorage.getItem(storageKey())||'null');return saved&&saved.layout?saved:null;}
    catch(_){return null;}
  };
  root.V7FreeMode.importPlacement=saved=>{
    if(!saved||!saved.layout)return false;
    core.normalize(saved.layout);            // 格式不对直接抛，不写坏存档
    finishDrag();
    localStorage.setItem(storageKey(),JSON.stringify({layout:saved.layout,collapsed:Array.isArray(saved.collapsed)?saved.collapsed:[]}));
    if(active&&!switching){load();setStack();applyPositions();}
    return true;
  };
  // Observe only hierarchy state, not per-frame styles, to avoid drag mutation loops.
  new MutationObserver(()=>{if(active){updateLinkedPanels();syncSpecialUnit('tasks');syncSpecialUnit('errors');}})
    .observe(zones,{attributes:true,attributeFilter:['class']});
  new MutationObserver(()=>{if(active)updateLinkedPanels();}).observe(detail,{attributes:true,attributeFilter:['class']});
  load();if(settingsRuntime.freeMode===true)set(true,{restore:true});
})(window);
