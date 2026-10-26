(function(root){
  'use strict';
  const doc=root.document,nav=doc.getElementById('v7PrimaryNav');
  if(!nav||root.V7FloatingBars)return;
  const key=()=>root.WHEELCHAIR_STORAGE.key('floating-bars.v1');
  const scope=()=>root.WHEELCHAIR_STORAGE.namespaceId();
  const mode=()=>root.V7FreeMode?.isActive()?'free':'normal';
  // ⭐ 2026-10-09（用户要求）：「就是先默认打开关掉」——
  //   胶囊导航条【默认不显示】，想用的人到设置中心→界面与布局里勾开。
  //   ⚠ agent 输入条【不受影响】，仍然默认显示（用户只说导航条）。
  //   ⚠ 只改默认值：已经存过设置的人按他存的算（load 里那个 `=== true` 保证这一点）。
  const blank=()=>({version:1,nav:{visible:false,positions:{}},agent:{visible:true,positions:{},panelSize:{width:580,height:470}}});
  let settings=blank(),owner=scope(),currentMode=mode(),drag=null,frame=0,point=null;
  let composing=false,expanded=false,resize=null;
  const refs={nav},settingsViews=new Set();
  const icon=(name,size=16)=>root.ICON?.render(name,size)||'';
  function button(label,cls,html){const el=doc.createElement('button');el.type='button';el.className=cls;el.setAttribute('aria-label',label);el.title=label;el.innerHTML=html||'';return el;}
  function report(error){root.ERR?.report('LAYOUT_FAILED',{message:String(error?.message||error)});}
  function persist(){if(owner!==scope())return;try{localStorage.setItem(key(),JSON.stringify(settings));}catch(error){report(error);}}
  function load(){
    settings=blank();try{const saved=JSON.parse(localStorage.getItem(key())||'null');if(saved?.version===1)for(const id of ['nav','agent']){
      // ⚠⚠ 这里原来是 `!== false` —— 那对 nav 就等于"没存过也当显示"，
      //   上面 blank() 里把 nav 默认改成 false 就【形同虚设】。
      //   ⇒ 改成"存过布尔值才听它的，没存过就保留 blank() 的默认值"。
      //     ⚠ 用 typeof 判断而不是 `=== true`：后者在"没存过"时也会把
      //       默认值覆盖成 false（对 nav 结果一样，但语义错了 ——
      //       以后改 blank() 的默认值会被这里悄悄吃掉，是个埋雷）。
      const v=saved[id]?.visible;
      if(typeof v==='boolean')settings[id].visible=v;
      // ⭐ 10-25 用户审批（docs/286 B6「显示导航条点了没反应」）：「把导航条给我删了，现在不需要导航条」⇒ 存过「显示」的也不认，永远藏着
      //   ⚠ 元素本身留着：ui.html 里的导航外壳（返回上一页的记录）挂在它上面，删了会连带坏
      settings.nav.visible=false;
      for(const kind of ['normal','free']){const p=saved[id]?.positions?.[kind];if(p&&[p.x,p.y,p.width,p.height].every(Number.isFinite))settings[id].positions[kind]={x:p.x,y:p.y,width:p.width,height:p.height};}
    }
    const size=saved?.agent?.panelSize;if(size&&Number.isFinite(size.width)&&Number.isFinite(size.height))settings.agent.panelSize={width:Math.max(320,Math.min(900,size.width)),height:Math.max(240,Math.min(900,size.height))};
    }catch(_){/* A corrupt local layout falls back to reachable defaults. */}
  }
  function bounds(node,x,y){const margin=8;return {x:Math.max(margin,Math.min(innerWidth-node.offsetWidth-margin,x)),y:Math.max(margin,Math.min(innerHeight-node.offsetHeight-margin,y))};}
  function defaultPosition(id){
    const x=id==='agent'&&currentMode==='free'
      ? Math.min(innerWidth*.48,innerWidth-refs.agent.offsetWidth-8)
      : currentMode==='free'?24:Math.min(60,Math.max(8,innerWidth-refs[id].offsetWidth-8));
    return {x,y:id==='nav'?8:Math.max(64,innerHeight-refs.agent.offsetHeight-16)};
  }
  function place(id,p){const node=refs[id],v=bounds(node,p.x,p.y);node.style.left=Math.round(v.x)+'px';node.style.top=Math.round(v.y)+'px';if(id==='agent')positionPanel();return v;}
  function layout(){
    for(const id of ['nav','agent']){const node=refs[id];node.hidden=!settings[id].visible;if(node.hidden)continue;
      const saved=settings[id].positions[currentMode];
      place(id,saved?{x:saved.x*Math.max(1,innerWidth-node.offsetWidth-16)/Math.max(1,saved.width-node.offsetWidth-16),y:saved.y*Math.max(1,innerHeight-node.offsetHeight-16)/Math.max(1,saved.height-node.offsetHeight-16)}:defaultPosition(id));
    }
    positionPanel();
    refreshSettings();root.V7NavigationShell?.refresh();
  }
  // 2026-10-17：悬浮框推倒重做后没有展开小窗了；这个函数留着是因为 place() 还在调它
  function positionPanel(){}

  function remember(id){const node=refs[id];settings[id].positions[currentMode]={x:parseFloat(node.style.left)||8,y:parseFloat(node.style.top)||8,width:innerWidth,height:innerHeight};persist();}
  function release(cancelled=false){
    if(!drag)return;const item=drag;drag=null;if(frame)cancelAnimationFrame(frame);frame=0;point=null;
    try{item.handle.releasePointerCapture(item.pointer);}catch(_){}
    refs[item.id].classList.remove('v7-floating-moving');
    if(!cancelled&&item.owner===scope()&&item.mode===currentMode)remember(item.id);else layout();
    root.dispatchEvent(new Event('wheelchair:setup-window-closed'));
  }
  function move(){frame=0;if(!drag||!point)return;place(drag.id,{x:drag.left+point.x-drag.x,y:drag.top+point.y-drag.y});}
  function grip(id,label){
    const handle=button(label,'v7-floating-grip');handle.dataset.floatingGrip=id;handle.setAttribute('aria-keyshortcuts','ArrowUp ArrowDown ArrowLeft ArrowRight');
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0||root.V7FreeMode?.isTransitioning()||root.V7FocusScope?.isOpen()||handle.closest('[inert]')||doc.getElementById('popupLock')?.classList.contains('on'))return;
      event.preventDefault();event.stopPropagation();release();const rect=refs[id].getBoundingClientRect();
      drag={id,handle,pointer:event.pointerId,owner:scope(),mode:currentMode,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
      refs[id].classList.add('v7-floating-moving');handle.setPointerCapture(event.pointerId);root.uiwin?.setIgnoreMouse(false);
    });
    handle.addEventListener('keydown',event=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;event.preventDefault();event.stopPropagation();const rect=refs[id].getBoundingClientRect(),step=event.shiftKey?24:8;place(id,{x:rect.left+delta[0]*step,y:rect.top+delta[1]*step});remember(id);});
    return handle;
  }
  // Some transparent/offscreen hosts retarget pointer events after the grip
  // moves. Track the active pointer at window capture level as well.
  root.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointer)return;
    point={x:event.clientX,y:event.clientY};if(!frame)frame=requestAnimationFrame(move);
  },true);
  root.addEventListener('pointerup',event=>{
    if(!drag||event.pointerId!==drag.pointer)return;
    point={x:event.clientX,y:event.clientY};if(frame)cancelAnimationFrame(frame);move();release();
  },true);
  root.addEventListener('pointercancel',event=>{if(drag&&event.pointerId===drag.pointer)release(true);},true);
  function setVisible(id,visible){
    if(!refs[id])return;
    if(id==='nav'&&visible)return;   // 导航条已经删了（10-25），谁叫它显示都不理
    release();settings[id].visible=!!visible;
    if(id==='agent')setExpanded(false);
    persist();layout();
    if(!visible){
      const fallback=id==='nav'||nav.hidden?null:nav.querySelector('[aria-current="page"]');
      (fallback||doc.querySelector('#stack .block-card.is-current [data-collapse-toggle]'))?.focus?.({preventScroll:true});
    }
  }
  function refreshSettings(){for(const el of settingsViews){if(!el.isConnected){settingsViews.delete(el);continue;}el.querySelector('[data-floating-toggle="agent"]').checked=settings.agent.visible;}}
  function reset(){release();settings=blank();persist();layout();}
  function mountSettings(container){
    const el=doc.createElement('div');el.className='v7-floating-settings';
    el.innerHTML='<label class="v7-check-row"><span>显示 Agent 悬浮窗</span><input type="checkbox" data-floating-toggle="agent"></label><p class="settings-note">拖动左侧双竖线移动。常规模式和自由模式分别记住位置；隐藏后可在这里重新打开。</p><div class="settings-actions"><button type="button" class="settings-btn" data-floating-reset>显示并恢复默认位置</button></div>';
    container.append(el);settingsViews.add(el);el.querySelector('[data-floating-toggle="agent"]').onchange=event=>setVisible('agent',event.target.checked);
    el.querySelector('[data-floating-reset]').onclick=reset;refreshSettings();return ()=>{settingsViews.delete(el);el.remove();};
  }
  nav.classList.add('v7-floating-bar');nav.dataset.floatingBar='nav';nav.prepend(grip('nav','拖动导航条；也可用方向键移动'));
  const navHide=button('隐藏导航条；可在设置中心的界面与布局中重新打开','v7-floating-icon',icon('close'));
  navHide.dataset.floatingHide='nav';navHide.onclick=()=>setVisible('nav',false);nav.append(navHide);
  // ⭐⭐ 2026-10-17 夏三六悬浮框【推倒重做】（用户：「完全推倒，重新做一遍…里面就不要再放设置了，
  //   那个 agent 输入框我们就可以简单的做一些快捷指令，就是发一些很简单的任务」，docs/231）。
  //   · 上面一行胶囊：把手 · 夏三六（状态灯，点了进二级）· 一句话输入 · 发送/停止 · ↗ 进二级 · 隐藏
  //   · 下面一行：平时是快捷指令（V7AgentService 管，二级「快捷指令」那节能改）；有任务时换成状态 + 按钮
  //   · 原来能展开的聊天小窗、会话管理、模型信息全去掉 —— 完整聊天点 ↗ 进二级看
  //   ⚠ 任务状态跟主卡、二级是同一份（都从 V7AgentService 来），哪边发的三处都看得到
  //   ⚠ setAgentExpanded 这个对外接口留着（别处可能在调），现在等于「打开二级的当前对话」
  const dock=doc.createElement('section');dock.id='v7AgentDock';dock.className='v7-agent-dock v7-floating-bar';dock.dataset.floatingBar='agent';dock.setAttribute('aria-label','夏三六 悬浮框');refs.agent=dock;
  const form=doc.createElement('form');form.className='ad-cap';form.append(grip('agent','拖动悬浮框；也可用方向键移动'));
  const who=button('打开二级大卡看完整聊天','ad-who','<span class="ad-dot" data-agent-dot></span><span>夏三六</span>');who.dataset.agentOpen='';
  const input=doc.createElement('input');input.className='ad-in';input.maxLength=600;input.placeholder='说一件简单的活，比如：去掉选区里的杂物';input.setAttribute('aria-label','给夏三六的一句话');input.setAttribute('aria-describedby','v7AgentStatus');input.dataset.agentInput='';
  const send=button('发送','v7-floating-icon ad-send',icon('arrowUp'));send.type='submit';send.dataset.agentSend='';
  const full=button('打开二级大卡看完整聊天','v7-floating-icon',icon('arrowUpRight'));full.dataset.agentFull='';
  const hide=button('隐藏悬浮框；可在设置中重新打开','v7-floating-icon',icon('close'));hide.dataset.floatingHide='agent';hide.onclick=()=>setVisible('agent',false);
  form.append(who,input,send,full,hide);
  const chipsRow=doc.createElement('div');chipsRow.className='ad-row';chipsRow.dataset.agentChips='';chipsRow.innerHTML='<span class="ad-lbl">快捷</span><div class="ad-chips"></div>';
  const chips=chipsRow.querySelector('.ad-chips');
  const statusRow=doc.createElement('div');statusRow.className='ad-row';statusRow.dataset.agentStatusRow='';statusRow.hidden=true;
  statusRow.innerHTML='<span class="ad-badge" data-agent-badge></span><span class="ad-st" id="v7AgentStatus" role="status" aria-live="polite"></span><span class="ad-btns" data-agent-btns></span>';
  dock.append(form,chipsRow,statusRow);doc.body.append(dock);
  const service=()=>root.V7AgentService;
  function openZone(){try{service()?service().open('chat'):root.V7CardRoutes.open('assistant',0);}catch(error){report(error);}}
  function setExpanded(value){expanded=false;if(value&&settings.agent.visible)openZone();}
  who.onclick=full.onclick=openZone;
  let quickRows=[],lastChips='',lastStatus='',taskState='idle';
  function renderChips(){
    const text=input.value.trim(),showSave=!!text&&!quickRows.includes(text)&&quickRows.length<12;
    const sig=JSON.stringify([quickRows,showSave]);if(sig===lastChips)return;lastChips=sig;
    chips.replaceChildren();
    for(const q of quickRows){const b=button('发给夏三六：'+q,'ad-chip');b.textContent=q;b.dataset.agentCmd=q;chips.append(b);}
    if(showSave){const b=button('把输入框里这句话存成快捷指令','ad-chip save');b.textContent='＋存为快捷';b.dataset.agentSave='';chips.append(b);}
    if(!quickRows.length&&!showSave){const s=doc.createElement('span');s.textContent='没有快捷指令（二级「快捷指令」里加）';chips.append(s);}
  }
  function renderDock(s){
    if(!s)return;
    quickRows=s.quick||[];taskState=s.task.state;
    const t=s.task,running=t.state==='running',dot=dock.querySelector('[data-agent-dot]');
    dot.className='ad-dot'+(running?' run':t.state==='replied'?' wait':t.state==='failed'?' err':s.connection.ready?'':' off');
    who.title=s.connection.ready?'已连接 '+(s.connection.model||'')+' · 点一下看完整聊天':'还没连上大脑 · 点一下去二级连接';
    sendIcon();
    chipsRow.hidden=t.state!=='idle';statusRow.hidden=t.state==='idle';
    statusRow.classList.toggle('ask',t.state==='replied');statusRow.classList.toggle('err',t.state==='failed');
    renderChips();
    const sig=JSON.stringify([t.state,t.title,t.step,t.reply,t.error,t.ask,(s.queue||[]).length]);if(sig===lastStatus)return;lastStatus=sig;
    const badge=statusRow.querySelector('[data-agent-badge]'),st=statusRow.querySelector('#v7AgentStatus'),btns=statusRow.querySelector('[data-agent-btns]');
    badge.className='ad-badge'+(t.state==='replied'?' wait':t.state==='failed'?' err':'');
    badge.textContent=t.ask?'等你回答':({running:'在干',replied:'回话了',failed:'出错'}[t.state]||'');
    // 在干时输入框打字再发 = 排队（10-17 晚：一次一个任务，顺位进行）
    const queued=(s.queue||[]).length?' · 还排着 '+s.queue.length+' 个':'';
    st.textContent=running?(t.title+(t.step?' · '+t.step:'')+queued):t.ask?t.ask.question:t.state==='replied'?(t.reply||'这一轮说完了'):t.state==='failed'?(t.error||'出错了'):'';
    st.title=st.textContent;
    btns.innerHTML=running?'<button type="button" class="warn" data-agent-act="stop">停止</button>'
      :t.state==='replied'?'<button type="button" class="pri" data-agent-act="open">看全文 ↗</button><button type="button" data-agent-act="dismiss">收起</button>'
      :t.state==='failed'?'<button type="button" data-agent-act="open">去看 ↗</button><button type="button" data-agent-act="dismiss">收起</button>':'';
  }
  // 在干的时候：输入框空着 = 停止；打了字 = 排队发（一次一个任务，顺位进行）
  function sendIcon(){
    const stopping=taskState==='running'&&!input.value.trim(),label=stopping?'停止':taskState==='running'?'排队':'发送';
    if(send.dataset.mode===label)return;send.dataset.mode=label;
    send.innerHTML=stopping?icon('stop'):icon('arrowUp');send.setAttribute('aria-label',label);send.title=label;
  }
  async function dockSend(text){
    const s=service(),words=String(text||'').trim();if(!s||!words)return;
    if(input.value.trim()===words)input.value='';lastChips='';renderChips();
    try{const r=await s.submit(words,{source:'dock',title:words});if(r&&r.cancelled&&!input.value)input.value=words;}catch(error){report(error);}
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();event.stopPropagation();
    if(taskState==='running'&&!input.value.trim()){service()?.stop().catch(report);return;}
    dockSend(input.value);
  });
  chips.addEventListener('click',event=>{
    const cmd=event.target.closest('[data-agent-cmd]');if(cmd&&taskState!=='running'){dockSend(cmd.dataset.agentCmd);return;}
    if(event.target.closest('[data-agent-save]')){try{service().addQuick(input.value);}catch(error){report(error);}lastChips='';}
  });
  statusRow.addEventListener('click',event=>{
    const a=event.target.closest('[data-agent-act]')?.dataset.agentAct;if(!a)return;
    if(a==='stop')service()?.stop().catch(report);else if(a==='open')openZone();else if(a==='dismiss')service()?.dismiss();
  });
  input.addEventListener('input',()=>{lastChips='';renderChips();sendIcon();});
  input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;});
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();input.blur();return;}
    if(event.key==='Enter'){event.stopPropagation();if(composing||event.isComposing||event.keyCode===229)event.preventDefault();}
  });
  // The global stack uses coordinate hit tests in capture listeners. Those
  // listeners must also skip floating bars; these stops handle bubbling paths.
  for(const node of Object.values(refs)){node.addEventListener('click',event=>event.stopPropagation());node.addEventListener('mousedown',event=>event.stopPropagation());node.addEventListener('wheel',event=>{event.stopPropagation();if(!event.target.closest('textarea,select'))event.preventDefault();},{passive:false});}
  function hitTest(x,y){if(drag||resize)return true;return Object.values(refs).some(el=>{if(el.hidden||el.closest('[hidden]')||el.closest('[inert]'))return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;});}
  function workArea(){const n=nav.getBoundingClientRect(),a=dock.getBoundingClientRect();return {top:!nav.hidden&&n.top<80?Math.max(60,n.bottom+12):60,bottom:!dock.hidden&&a.top>innerHeight*.55?a.top-12:innerHeight-16};}
  root.V7FloatingBars={setVisible,reset,mountSettings,hitTest,workArea,setAgentExpanded:setExpanded,isDragging:()=>!!drag||!!resize,snapshot:()=>JSON.parse(JSON.stringify({settings,mode:currentMode,scope:owner,agentExpanded:expanded}))};
  root.addEventListener('blur',()=>{release();resize=null;});root.addEventListener('beforeunload',()=>{release();resize=null;});
  root.addEventListener('resize',()=>{if(root.V7FreeMode?.isTransitioning())return;layout();});
  root.addEventListener('wheelchair:free-mode-changed',()=>{release();currentMode=mode();layout();});
  root.addEventListener('wheelchair:storage-context',()=>{release(true);resize=null;owner=scope();currentMode=mode();input.value='';lastChips='';lastStatus='';load();layout();});
  load();layout();if(root.V7AgentService)root.V7AgentService.subscribe(renderDock);else{statusRow.hidden=false;chipsRow.hidden=true;statusRow.querySelector('#v7AgentStatus').textContent='夏三六没加载起来（agent-service.js）';}
})(window);
