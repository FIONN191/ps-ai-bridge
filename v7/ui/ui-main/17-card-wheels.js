// ═══ ui-main/17-card-wheels.js —— 主界面主程序第 17 / 21 段 ═══
//   管什么：记录卡滚轮 + 攒光 · 外挂能力卡滚轮 · 设置卡滚轮
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 记录卡的滚轮 + 攒光（照预设那套搬，状态独立）═══
// 规矩（用户 2026-09-30 定）：
//   一级项目列表：先滚列表，到头攒光才切主卡；
//   大二级：只翻页，永远不切主卡；到头只顶一下。
// ⚠ 攒光【复用】pzEvents/pzPushGate 那一套吗？不复用 —— 那套的状态是预设卡专用的
//   （pzDir/pzShown/pzEdgeTop 全绑在 #presetZone 上）。共用会让两张卡互相清零。
//   这里另起一套同参数（450ms 窗口 + 冻结到真停手）的。
const REC_WINDOW=450, REC_MAXH=30;
let recEvents=[], recDir=0, recShown=0, recRaf=null, recFlashAt=0, recFlashDir=0;
let recFrozenUntil=0, recFreezeCap=0;
let recEdgeTop=null, recEdgeBottom=null;
// ⚠⚠ 2026-10-07 修（用户实测报的"攒光效果消失了，光没了"）：
//   这两条光带原来是个【立即执行】的 IIFE，只在页面加载时往 #recordsZone 里塞一次。
//   而记录卡的 mount() 会用 zone.innerHTML=... 把整个面板重建（records-card.js:1109）——
//   重建一次，这两条光带就被冲掉了，之后再攒光也【没有任何东西会亮】，
//   但"攒满才翻卡"的逻辑还在（它算的是数字，不依赖 DOM）——
//   于是表现正好是用户说的那句：「依旧要攒才能滚得动，但是光没了」。
//   ⇒ 改法：改成可重入的普通函数（幂等：先拆旧的再建新的），
//     在记录卡挂载之后补调一次（见 recordsCardMount）。
function mountRecordsEdges(){
  // ⭐⭐⭐ 2026-10-09 用户定案（docs/192）：
  //   「记录与恢复的【二级】卡片不需要攒光效果，也不需要攒光的滚动控制效果。
  //     但是记录与恢复的【一级】卡片有滚动效果，也是需要的，但是它没有光。」
  //   ⇒ 光带从二级面板（#recordsZone）**挪到一级卡面的项目列表上**。
  //   ⚠ 为什么挪而不是复制：攒光是"滚到头再推才切主卡"的进度条。
  //     二级面板的滚轮规矩是【只翻页、绝不切主卡】（用户 2026-09-30 定），
  //     所以二级上那两条光带**根本没有对应的动作**，亮起来只会误导用户"还能再推"。
  //
  //   ⚠⚠⚠ 2026-10-09 第二次修（用户报「下沿的攒光没出现在卡片底部，
  //     而是出现在某一个项目的底部了」）：
  //     **光带不能挂在 .rec-list 上** —— 它自己是 overflow-y:auto 的滚动容器，
  //     里面的绝对定位元素会跟着内容一起滚：
  //       绝对定位的 bottom:0 对齐的是【内容盒底边】(536px 处)，
  //       不是【可视框底边】(322px 处)；
  //       滚到底时内容盒上移 214 ⇒ 光带也跟着上移到 536-214=322 的位置
  //       ⇒ 正好压在最后一个项目下面（用户看到的就是这个）。
  //     实测对照：滚到底后上缘光 top = -120、下缘光 top = 202（都跑到列表中间了）。
  //     ⇒ 改挂到【不滚动的定位壳 .rec-listwrap】上（见 records-card.css 那段注释）。
  //       壳只负责定位和让位，不滚 ⇒ 光带永远贴可视框的上下沿。
  //     ⚠ 判据：**光带的父级必须是 .rec-listwrap，不是 .rec-list**。
  //   ⚠⚠⚠ 2026-10-09 第三次修（用户报「光效在顶部的裁切区域、底部也在裁切区域，
  //     我要求的是在圆弧的最底…下面还空一块」）：
  //     **光带要挂到【一级卡片本体】上，不是列表壳上。**
  //     实测对比（这就是"下面空一块"的原因）：
  //       · 预设卡：光带挂在 `.zone.pzone` 上，而那个 zone 的矩形 = 整张卡
  //         （卡 60~460 / zone 60~460）⇒ 光正好贴卡顶卡底。
  //       · 我上一版挂在 `.rec-listwrap` 上，而那个壳只覆盖【列表区】
  //         （壳 94~416，卡 60~460）⇒ **卡底还空出 44px**（页脚那一条）。
  //     ⇒ 挂到卡片本体：`.block-card[data-card="history"]`。
  //       卡片自己是 position:relative + overflow:hidden，
  //       所以贴它的 bottom:1 就是"圆弧的最底"，而且会被圆角裁掉、不会溢出。
  //     ⚠ 用 top/bottom = 1px（照预设卡实测的 61/459）—— 让开 1px 边框，
  //       不然光会压在边框上显得毛。
  //     ⚠ 为什么不用 `.bc-inner`：它的矩形跟卡一样（60~460），但卡的 `overflow:hidden`
  //       和圆角是在 `.block-card` 上 —— 挂卡上才吃到圆角裁切。
  const host=document.querySelector('.block-card[data-card="history"]');
  if(!host) return;
  // 幂等：先把【所有可能挂过的地方】的旧光带拆掉再挂 ——
  //   ⚠ 我改过两次挂载位置（#recordsZone → .rec-list → .rec-listwrap → 卡片本体），
  //     只清当前位置的话，老位置会留一堆重影光带。
  [host,
   host.querySelector('[data-records-listwrap]'),
   host.querySelector('[data-records-list]'),
   document.getElementById('recordsZone')
  ].forEach(n=>{
    if(n) n.querySelectorAll(':scope > .pz-edge').forEach(el=>el.remove());
  });
  recEdgeTop=document.createElement('div');    recEdgeTop.className='pz-edge top';
  recEdgeBottom=document.createElement('div'); recEdgeBottom.className='pz-edge bottom';
  recEdgeTop.style.top='1px';       recEdgeTop.style.bottom='auto';
  recEdgeBottom.style.bottom='1px'; recEdgeBottom.style.top='auto';
  host.appendChild(recEdgeTop);
  host.appendChild(recEdgeBottom);
}
mountRecordsEdges();
function recNeed(){
  const n=Number(settingsRuntime&&settingsRuntime.presetFlipNotches);
  return Math.max(2,Math.min(30,Number.isFinite(n)&&n>0?n:10))*100;
}
function recSum(now){
  while(recEvents.length&&now-recEvents[0].t>REC_WINDOW) recEvents.shift();
  let s=0; for(let i=0;i<recEvents.length;i++) s+=recEvents[i].d;
  return s;
}
function recPushPaint(p,dir){
  const on=dir>0?recEdgeBottom:recEdgeTop, off=dir>0?recEdgeTop:recEdgeBottom;
  if(off){off.style.opacity='0';off.style.height='0px';off.style.setProperty('--edge-bright','0');}
  if(!on) return;
  if(p<=0){on.style.opacity='0';on.style.height='0px';on.style.setProperty('--edge-bright','0');return;}
  const k=Math.pow(p,1.3);
  on.style.height=(k*REC_MAXH)+'px';
  on.style.opacity=String(0.2+k*0.8);
  on.style.setProperty('--edge-bright',String(Math.pow(p,3)));
}
function recPaintFlash(f,dir){
  const on=dir>0?recEdgeBottom:recEdgeTop, off=dir>0?recEdgeTop:recEdgeBottom;
  if(off){off.style.opacity='0';off.style.height='0px';off.style.setProperty('--edge-bright','0');}
  if(!on) return;
  const out=1-Math.pow(1-f,2);
  on.style.height=(REC_MAXH*(1+out*0.9))+'px';
  on.style.opacity=String(1-out);
  on.style.setProperty('--edge-bright',String(1-out));
}
function recTick(){
  const now=performance.now();
  if(recFlashAt){
    const f=(now-recFlashAt)/200;
    if(f<1){recPaintFlash(f,recFlashDir);recRaf=requestAnimationFrame(recTick);return;}
    recFlashAt=0;recShown=0;recDir=0;recPushPaint(0,0);recRaf=null;return;
  }
  const target=Math.min(1,recSum(now)/recNeed());
  recShown+=(target-recShown)*0.28;
  if(target<=0&&recShown<0.004){recShown=0;recDir=0;recPushPaint(0,0);recRaf=null;return;}
  recPushPaint(recShown,recDir);
  recRaf=requestAnimationFrame(recTick);
}
function recKick(){ if(!recRaf) recRaf=requestAnimationFrame(recTick); }
// 返回 true = 攒够了，该切主卡
// ⚠⚠ 2026-10-07 用户定（原话）：「记录与恢复卡在没内容的时候不要攒。」
//   为什么合理：攒光的用途是"内容滚到头了、再用力推才翻卡"。
//     一条记录都没有时卡里根本没内容可滚 —— 再要求攒光就变成"滚半天不动"，
//     而且那时还会亮光带，等于在暗示"里面还有东西"。⇒ 空卡：不攒、不发光、一步翻走。
//   ⚠ 判据跟"卡片自己画不画内容"用同一个函数，别各写一份（见 recordsIsEmpty）。
function recordsIsEmpty(){
  try{
    if(!recordsCard||typeof recordsCard.projectList!=='function') return false;  // 拿不准 → 当非空，走老路
    return (recordsCard.projectList()||[]).length===0;
  }catch(_){ return false; }
}
function recPushGate(dir,deltaY){
  if(recordsIsEmpty()){                 // 空卡：一步到位，不攒光也不发光
    recEvents.length=0; recShown=0;
    return true;
  }
  const now=performance.now();
  if(now<recFrozenUntil){
    recFrozenUntil=Math.min(Math.max(recFrozenUntil,now+140),recFreezeCap);
    recEvents.length=0;
    return false;
  }
  if(dir!==recDir){recEvents.length=0;recDir=dir;}
  recEvents.push({t:now,d:Math.abs(deltaY)||100});
  recKick();
  if(recSum(now)>=recNeed()){
    recEvents.length=0;
    recFlashAt=now;recFlashDir=dir;
    recFrozenUntil=now+360;recFreezeCap=now+1200;
    recKick();
    return true;
  }
  return false;
}

// 打开记录卡的二级（出场/弹出光全用现成那套）
function recordsOpenZone(){
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=recordsCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.zone-glow','.zone-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  // ⚠⚠ 2026-10-07 补：面板【露出来了】之后必须让卡片重画一次。
  //   为什么：卡片的 render() 是"面板可见（有 .show）→ 画面里的空状态"，
  //     而这个 .show 是【上面几行刚加上去的】—— 加之前那次 render 看不到它，
  //     加之后再没人叫它画 ⇒ 结果就是一块空白（用户实测报的就是这个）。
  //   ⚠ 不放在上面（加 .show 之前）：那样 render 里判断"面板可见"还是不成立，等于没调。
  //   ⚠ render() 是幂等的（空状态有 data-empty 标记防重写），重复调用不会闪。
  try{ if(recordsCard&&typeof recordsCard.render==='function') recordsCard.render(); }catch(e){ /* 渲染失败不该拦住开面板 */ }
}

// ── 记录卡的滚轮（window 捕获阶段 + 几何判断，和预设那套同一个套路）──
// ⚠ 挂在元素上会踩"鼠标不动、一直滚"的陈旧命中测试（见预设那段的注释）。
window.addEventListener('wheel',event=>{
  if(event.target.closest&&event.target.closest('.v7-floating-bar')) return;
  if(document.body.classList.contains('v7tw-covering')) return;
  if(!isRecordsCard()) return;
  if(v7OverlayOpen()) return;
  const lock=document.getElementById('popupLock');
  if(lock&&lock.classList.contains('on')) return;
  if(viewerOpen||isCollapsed) return;
  if(!event.deltaY) return;
  const dir=event.deltaY>0?1:-1;
  const dy=recNormalizeDelta(event,400);
  const zone=recordsCardEl();

  // 二级开着 + 落在二级上：只翻页 / 只滚检查点，永远不切主卡
  if(zoneOpen&&zone&&hitRect(event.clientX,event.clientY,zone)){
    event.preventDefault();
    event.stopPropagation();
    if(!recordsCard) return;
    recordsCard.markUsed();
    // 固定检查点时：左边缩小的整片上下滚（一直滚得到这个项目的第一次/最后一次）
    if(recordsCard.checkpointState()==='full'){
      const detail=zone.querySelector('.rc-detail');
      if(!detail||!hitRect(event.clientX,event.clientY,detail)) recordsCard.cpScrollBy(dy);
      return;
    }
    if(recordsCard.checkpointState()==='half') return;   // 悬停预览时不响应
    // 右侧时间轴：滚它自己的列表
    const rail=zone.querySelector('.rc-rail');
    if(rail&&hitRect(event.clientX,event.clientY,rail)){
      const list=rail.querySelector('.rail-list');
      if(list) list.scrollTop+=dy;
      return;
    }
    // 中间的任务区：滚它自己的列表。
    // ⭐⭐⭐ 2026-10-09 用户定案（docs/192）：
    //   「记录与恢复的二级卡片不需要攒光效果，也不需要攒光的滚动控制效果。」
    //   ⇒ 这里原来是 `if(recPushGate(dir,dy)) recordsCard.onWheel(dir,dy);`
    //     —— 即"先攒光，攒够了才翻页"。
    //   ⚠ 现在改成**直接翻页，不攒光、不受攒光门控**。
    //     理由：二级面板的规矩本来就是"只翻页、绝不切主卡"（用户 2026-09-30 定），
    //     而攒光是个进度条 —— 它的意义是"再推就切卡"。二级既然不切卡，
    //     那个进度条就没有对应的动作，只会让用户以为"再推推能出去"。
    //   ⚠ 顺手把攒光状态清掉（recPushPaint(0,0)）：不然从一级攒了一半进去，
    //     光带的残影会留在屏幕上（虽然现在光带已经不挂在二级上了，但状态要干净）。
    recShown=0; recDir=0; recEvents=[];
    if(recRaf){cancelAnimationFrame(recRaf);recRaf=null;}
    recordsCard.onWheel(dir,dy);
    return;
  }

  // 一级：先滚项目列表，到头攒光才切主卡
  const card=cards[CARD_HISTORY];
  if(!card||!hitRect(event.clientX,event.clientY,card)) return;
  event.preventDefault();
  event.stopPropagation();
  const list=card.querySelector('[data-records-list]');
  if(list){
    // ⚠ 保险：光带挂在【一级卡面的定位壳 .rec-listwrap】上，而卡面是卡片自己重画的
    //   （每次重建都会把光带连同 DOM 一起冲掉）。这里每次滚轮时对一下账，
    //   缺了就补挂 —— 比"只在某个时机补一次"稳（那种写法 2026-10-07 已经栽过一次，
    //   见 mountRecordsEdges 上面那段注释：光带被 innerHTML 冲掉后"永远不亮"）。
    //   ⚠ 判据看【壳】上有没有光带，不看列表 —— 光带的父级是壳不是列表。
    // ⚠ 光带挂在【一级卡片本体】上（不是列表壳）—— 见 mountRecordsEdges 的说明。
    if(!card.querySelector(':scope > .pz-edge')) mountRecordsEdges();
    const more=dir>0?(list.scrollTop+list.clientHeight<list.scrollHeight-1):(list.scrollTop>0);
    if(more){ list.scrollTop+=dy; recKick(); return; }   // ⚠ 不硬清零攒的光，让它自己过期
  }
  if(recPushGate(dir,dy)) switchMainCard(dir,'记录卡攒光达标');
},{passive:false,capture:true});
// deltaY 单位归一化。⚠ deltaMode=1 是"行"（一格才 3px），不归一化就成了"怎么滚都不动"。
function recNormalizeDelta(event,viewH){
  const mode=event.deltaMode;
  if(mode===1) return event.deltaY*16;
  if(mode===2) return event.deltaY*(viewH||300);
  return event.deltaY;
}

function recordsCloseZone(){
  if(!recordsCard||!recordsCard.isOpen()) return;
  recordsCard.close();
  recordsCardEl()&&recordsCardEl().classList.remove('show');
  if(!zones.querySelector('.zone.show')) zones.classList.remove('show');
}

// ── 外挂能力卡的滚轮（window 捕获阶段 + 几何判断，和记录卡/预设卡同一个套路）──
// ⚠ 另起【第三套】状态（engPushGate）—— 别复用 recPushGate / pzPushGate。
//   三张卡共用一套状态的话必然互相清零（docs/94 第 5 节记过这个坑）。
// ⚠⚠ 2026-10-07 用户定案（原话）：「外挂能力卡反而是翻一下就直接能翻的。」
//   ⇒ 这张卡改成【滚一下就翻】，跟生成/设置/项目/助手/调试/教程那 7 张一致。
//   改之前的旧行为：要攒到 step*3.2（一格 120 → 要滚 4 下）才翻，
//     而且这张卡【没有光带】（engPushPaint / engEdge 从来不存在）——
//     于是"要滚 4 下、还不亮任何光"，手感就是用户说的"不知道为什么切不动"。
//   ⚠ 保留 engPushGate 这个名字和"每张卡一套独立状态"的结构（别删，注释里那条规矩仍然有效）。
let engPushDir=0,engPushShown=0,engPushEdgeTop=0,engPushT=0;
function engPushGate(dir,deltaY){
  const now=Date.now();
  // 一步就翻也算一次"推进"：把状态归零，免得残留值影响下一次（比如从别的卡切回来时）
  engPushDir=dir; engPushShown=0; engPushEdgeTop=0; engPushT=now;
  return true;
}
window.addEventListener('wheel',event=>{
  if(event.target.closest&&event.target.closest('.v7-floating-bar')) return;
  if(document.body.classList.contains('v7tw-covering')) return;
  if(!isEnginesCard()) return;
  if(v7OverlayOpen()) return;
  const lock=document.getElementById('popupLock');
  if(lock&&lock.classList.contains('on')) return;
  if(viewerOpen||isCollapsed) return;
  if(!event.deltaY) return;
  const dir=event.deltaY>0?1:-1;
  const dy=recNormalizeDelta(event,400);
  const zoneEl=enginesCardEl();

  // 二级开着 + 落在二级上：只翻页，永远不切主卡
  // ⭐⭐ 2026-10-05 用户定：「鼠标在那个区域才绑定到上面」+「右侧的那个滚条其实是不需要
  //   绑定到滚动切换的」。
  //   ⇒ 滚轮落在哪个区域，就只滚那个区域，**一律不翻页**：
  //     · 落在右栏 → 滚右栏自己那个列表（它超高时才真的动），**绝不换页**
  //     · 落在正文 → 滚正文，**到头了也安静停住**，不去翻页
  //   ⚠⚠ 这一条改掉了旧行为。旧版是"正文滚到头 → flipPage(dir)"，
  //     用户实测的两个症状都是它引起的：
  //       ① "我如果在二级卡片的左侧的那个面板里面去上下滚动的话，会触发右侧的滚动切换"
  //       ② "外挂能力卡片不知道为什么上下切换会有迟滞，或者是有切不动的情况"
  //          —— 那个"迟滞"就是"先滚正文、到头才翻页"：滚动位置没到底的那一下，
  //             滚轮被正文吃掉，用户感觉"滚了没反应"。
  //   ⚠ 翻页只能靠【点右栏节点】或【悬停右栏节点】（见 engines-card.js 的 bindZone）。
  if(zoneOpen&&zoneEl&&hitRect(event.clientX,event.clientY,zoneEl)){
    event.preventDefault();
    event.stopPropagation();
    if(!enginesCard) return;
    enginesCard.markUsed();
    // ① 右栏：滚它自己的列表
    const rail=zoneEl.querySelector('.rc-rail');
    if(rail&&hitRect(event.clientX,event.clientY,rail)){
      const list=rail.querySelector('.rail-list');
      if(list&&list.scrollHeight>list.clientHeight+1) list.scrollTop+=dy;
      return;   // ⚠ 无论如何都吞掉，不漏给后面
    }
    // ② 正文：滚正文，到头就停
    const body=zoneEl.querySelector('.tp-body');
    if(body&&hitRect(event.clientX,event.clientY,body)){
      body.scrollTop+=dy;
      return;
    }
    return;
  }

  // 一级：先滚【能力表】，到头攒光才切主卡
  //
  // ⚠⚠ 2026-10-04 重排后，卡面上只剩【一个】能滚的容器：.ec-grid（那张总表）。
  //   旧的 .ec-dbody（详情区）已经整个删掉了 —— 用户要的是"一眼看穿的图表"，
  //   一级卡面不再有可展开的详情块。
  //   ⚠ 不改这里的话表现为【滚轮在一级外挂卡上失灵】——而且不报错，纯静默
  //     （铁律 17 那类）。所以这里的选择器必须跟着卡面结构走。
  const card=cards[CARD_ENGINES];
  if(!card||!hitRect(event.clientX,event.clientY,card)) return;
  event.preventDefault();
  event.stopPropagation();
  const box=card.querySelector('.ec-grid');
  if(box&&hitRect(event.clientX,event.clientY,box)){
    const more=dir>0?(box.scrollTop+box.clientHeight<box.scrollHeight-1):(box.scrollTop>0);
    if(more){ box.scrollTop+=dy; return; }
  }
  if(engPushGate(dir,dy)) switchMainCard(dir,'外挂卡攒光达标');
},{passive:false,capture:true});

// ── 设置卡的滚轮（window 捕获阶段 + 几何判断，和记录卡/外挂卡同一个套路）──
// ⚠⚠ 2026-10-04 用户实测报的「设置二级大卡一滚就直接切到别的卡片去了」。
//   真因：设置卡【压根没有自己的滚轮监听】—— 全项目只有记录卡和外挂卡各有一套。
//   事件于是漏给全局那条，而全局对"鼠标落在二级上"只有一句
//   `switchMainCard(dir,'全局滚轮')` —— 一滚就换主卡，正是用户看到的"翻页"。
//   ⚠ 他说得对："塞下了不止一行的内容，然后我一滚，就直接切换到别的卡片去了"。
// ⚠ 用户定案（docs/136 §十二 P-Q2）：单张大二级【能滚，但绝不翻页】。
//   大二级装的是原来三级的内容，禁滚会把内容挤死；要禁的是"滚一下就翻页"。
//   ⇒ 这里只管【滚】。页签只能靠右边那条导航悬停/点击切换，滚轮绝不换页签。
//     内容真滚到头了，仍按"攒光"规则换主卡 —— 跟别的大二级一致，
//     不然二级开着的时候滚轮就成死键了，用户会以为卡住了。
// ⚠ 这里【故意不碰一级卡面】。
//   一级卡面的滚轮归属于 ui.html 那条全局监听（"滚一下切一张"，所有一级卡
//   同一套行为）。这里要是也接管一级，就等于顺手改了标准行为，
//   且设置卡会和别的卡不一致 —— 用户只报了二级那条，不该多动。
//   ⇒ 所以本监听【只认二级】。二级没开、或鼠标不在二级上，一律直接 return，
//     事件原样交给全局那条（它的 overMain 分支照旧）。
window.addEventListener('wheel',event=>{
  // ⭐ 2026-10-15：生成卡的大二级用的是同一个组件，滚轮规矩也同一套（只滚内容、绝不翻页）。
  // ⭐ 2026-10-17：助手卡的大二级也走这里（只滚内容、绝不翻页）；它自己知道哪块该滚（聊天记录 / 设置一列 / 输入框）。
  if(!isSettingsCard()&&!isGenerationCard()&&!isAssistantCard()&&!isFeedbackCard()&&!isCommunityCard()) return;
  if(viewerOpen||isCollapsed) return;
  if(!event.deltaY) return;
  if(event.target.closest&&event.target.closest('.v7-floating-bar')) return;
  if(document.body.classList.contains('v7tw-covering')) return;
  if(v7OverlayOpen()) return;
  const lock=document.getElementById('popupLock');
  if(lock&&lock.classList.contains('on')) return;
  const zoneEl=isAssistantCard()?assistantCardEl():isGenerationCard()?generationCardEl():isFeedbackCard()?feedbackCardEl():isCommunityCard()?communityCardEl():settingsCardEl();
  if(!zoneOpen||!zoneEl||!hitRect(event.clientX,event.clientY,zoneEl)) return;

  // 到这里 = 二级开着 + 鼠标在二级上。只滚内容，绝不换页签、绝不切主卡。
  const dir=event.deltaY>0?1:-1;
  const dy=recNormalizeDelta(event,400);
  event.preventDefault();
  event.stopPropagation();
  if(isAssistantCard()){ if(assistantCard) assistantCard.wheel(event.clientX,event.clientY,dy); return; }
  // ⭐ 2026-10-20：设置卡顶上搜索框的结果列表盖在正文上 —— 滚轮落在它上面就滚它（到头吞掉，不漏给下面的正文）
  const searchResults=zoneEl.querySelector('.scs-results:not([hidden])');
  if(searchResults&&hitRect(event.clientX,event.clientY,searchResults)){
    if(searchResults.scrollHeight>searchResults.clientHeight+1) searchResults.scrollTop+=dy;
    return;
  }
  // ⭐⭐ 2026-10-05 用户定："我希望它还是以滚轮为操作驱动的一个状态"。
  //   ⇒ 滚轮在右栏上 = 滚那只【朝左滑出的细分列】，不是滚主菜单
  //     （主菜单 5 行稳定装得下，本来也没有"滚它"的意义；它一滚反而会动，就是"被弹走"的观感）。
  //   ⚠ 细分列自己超长时才真滚它；不超长就把这一滚吞掉（外面有 event.preventDefault 拦着，
  //     不然这一滚会漏给全局 → 一滚就换主卡，那是"一滚就翻页"同族的坑）。
  const rail=zoneEl.querySelector('.sc-rail');
  if(rail&&hitRect(event.clientX,event.clientY,rail)){
    const sub=rail.querySelector('.rail-sub');
    const inner=sub&&!sub.hidden?sub.querySelector('.scs-in'):null;
    if(inner&&inner.scrollHeight>inner.clientHeight+1){ inner.scrollTop+=dy; return; }
    const list=rail.querySelector('.rail-list');
    if(list&&list.scrollHeight>list.clientHeight+1) list.scrollTop+=dy;
    return;   // ⚠ 无论如何都吞掉，不往下漏
  }
  // 正文自己还在滚 → 滚它
  const body=zoneEl.querySelector('.sc-body');
  if(body&&hitRect(event.clientX,event.clientY,body)){
    const more=dir>0?(body.scrollTop+body.clientHeight<body.scrollHeight-1):(body.scrollTop>0);
    if(more){ body.scrollTop+=dy; return; }
  }
  // ⚠ 这里【绝对不能】调 settingsCard.flip() —— 那就是用户报的"一滚就翻页"。
  //   到头就安静停住；页签只能靠右边那条导航悬停/点击切换。
  //   ⚠ 也不调 switchMainCard()：二级开着的时候滚轮不该把整张卡换掉。
  //     真要走，用户会先把鼠标移出二级（那时本监听就不拦了）。
  return;
},{passive:false,capture:true});

