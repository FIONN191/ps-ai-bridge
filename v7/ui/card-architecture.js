(function(root){
  'use strict';
  let host={};const disposals=new WeakMap();
  let tabSequence=0;
  let helpOwner=null,helpPopup=null;
  // ⭐ 2026-10-22（docs/263 第 7 条）：「?」鼠标停 120ms 才弹，划过去不弹；开着时挪到隔壁立刻换（hover-delay.js）
  //   点击 / 键盘聚焦照旧立刻弹。没加载 hover-delay（单独测这个文件时）就退回老样子：一碰就弹。
  const helpHover=root.V7HoverDelay?root.V7HoverDelay.create():null;
  let helpPending=null;
  const helpObserver=new MutationObserver(()=>{if(helpOwner&&!helpOwner.isConnected)closeHelp();});
  function helpText(button){
    const text=button.dataset.helpText||button.getAttribute('title')||'';
    if(text)button.dataset.helpText=text;
    button.removeAttribute('title');
    return text;
  }
  function closeHelp(){
    helpObserver.disconnect();
    if(helpOwner)helpOwner.removeAttribute('aria-describedby');
    helpOwner=null;helpPopup?.remove();helpPopup=null;
    helpPending=null;helpHover?.closed();
  }
  function showHelp(button){
    if(!button?.isConnected)return;
    const text=helpText(button);if(!text)return;
    closeHelp();helpOwner=button;helpPending=null;helpHover?.opened();helpPopup=document.createElement('div');
    helpPopup.id='v7-context-help';helpPopup.className='v7-help-popup';helpPopup.setAttribute('role','tooltip');helpPopup.textContent=text;
    // The top layer escapes the animated/clipped detail card, including when
    // help is used inside a dialog. Older hosts retain the fixed fallback.
    if(typeof helpPopup.showPopover==='function')helpPopup.setAttribute('popover','manual');
    document.body.append(helpPopup);
    if(typeof helpPopup.showPopover==='function')helpPopup.showPopover();
    button.setAttribute('aria-describedby',helpPopup.id);
    const anchor=button.getBoundingClientRect(),box=helpPopup.getBoundingClientRect();
    helpPopup.style.left=Math.max(8,Math.min(innerWidth-box.width-8,anchor.right-box.width))+'px';
    helpPopup.style.top=Math.max(8,Math.min(innerHeight-box.height-8,anchor.bottom+8+box.height>innerHeight-8?anchor.top-box.height-8:anchor.bottom+8))+'px';
    helpObserver.observe(document.body,{childList:true,subtree:true});
  }
  document.addEventListener('pointerover',event=>{const button=event.target.closest?.('.v7-help');if(!button||button===helpOwner||button===helpPending)return;if(!helpHover)return showHelp(button);helpPending=button;helpHover.show(()=>{if(helpPending===button)showHelp(button);});});
  document.addEventListener('pointerout',event=>{const button=event.target.closest?.('.v7-help');if(!button||button.contains(event.relatedTarget))return;if(button===helpPending&&button!==helpOwner){helpPending=null;helpHover?.hide(()=>{});return;}if(button===helpOwner&&document.activeElement!==button){if(helpHover)helpHover.hide(()=>{if(helpOwner===button)closeHelp();});else closeHelp();}});
  document.addEventListener('focusin',event=>{const button=event.target;if(button.matches?.('.v7-help'))requestAnimationFrame(()=>{if(document.activeElement===button)showHelp(button);});});
  document.addEventListener('focusout',event=>{if(event.target===helpOwner)closeHelp();});
  document.addEventListener('click',event=>{const button=event.target.closest?.('.v7-help');if(!button)return;event.preventDefault();event.stopPropagation();showHelp(button);},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&helpOwner){event.preventDefault();event.stopPropagation();closeHelp();}},true);
  document.addEventListener('scroll',()=>{if(helpOwner)closeHelp();},true);
  root.addEventListener('resize',closeHelp);
  root.addEventListener('wheelchair:free-mode-changed',closeHelp);
  root.addEventListener('wheelchair:storage-context',closeHelp);
  // ⭐ 2026-10-14：设置卡一列到底后，点导航只是滚动（目标已在视野里时连滚动都没有）—— 也要收掉旧说明
  root.addEventListener('wheelchair:settings-navigate',closeHelp);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function configure(options){host=options;}
  // ⭐ 2026-10-19（docs/252 ⑧，社区接线）：两个「社区」按钮（设置卡「社区」那节、老的模块列表）共用这一个打开法。
  //   社区网页只认从软件拉起：先跟后台要一张一次性进门条子（60 秒、只能用一次、绑这个账号），
  //   拼在网址 # 后面交给浏览器 —— # 后面的东西浏览器不会发给服务器、也不进访问日志，网页拿到立刻从地址栏抹掉。
  //   没登录 / 拿不到条子 / 浏览器没打开，都说清楚，不静默（网页那头没条子什么都看不到，硬开只会让人以为坏了）。
  async function openCommunity(url){
    const B=root.V7Backend;
    if(!B||typeof B.communityTicket!=='function')return {ok:false,message:'当前版本还不能从软件进社区（缺进门条子接口）。'};
    let signed=false;
    try{signed=!!(B.state&&B.state().signedIn);}catch(_){signed=false;}
    if(!signed)return {ok:false,message:'社区只对登录的用户开放：先在设置卡最上面的「账号」登录，再点这里。'};
    let ticket='';
    try{ticket=String(await B.communityTicket()||'');}
    catch(error){return {ok:false,message:'没拿到进社区的条子：'+String(error&&error.message||error).slice(0,80)};}
    const target=String(url||'').replace(/#.*$/,'')+'#ticket='+ticket;
    let ok=false;
    try{ok=await root.uiwin?.openExternalUrl?.(target)===true;}catch(_){ok=false;}
    return ok?{ok:true,message:'已在浏览器里打开社区（这次的进门条子 60 秒内有效，关掉网页要回软件再点一次）。'}
      :{ok:false,message:'没能启动浏览器：检查一下默认浏览器设置，再点一次。'};
  }
  function prepareDetail(body,route){
    if(!body||body.dataset.cardRoute===route)return;
    dispose(body);body.dataset.cardRoute=route;
    body.classList.remove('v7-service-layout');body.removeAttribute('data-service-view');
  }
  function dispose(body){if(helpOwner&&body.contains(helpOwner))closeHelp();for(const fn of disposals.get(body)||[])try{fn();}catch(error){host.error?.(error);}disposals.delete(body);body._settingsAccountCleanup?.();body._settingsAccountCleanup=null;}
  function retain(body,fn){if(typeof fn==='function')disposals.set(body,[...(disposals.get(body)||[]),fn]);}
  function reset(body){dispose(body);body.replaceChildren();body.classList.remove('v7-service-layout');delete body.dataset.recordsCenter;delete body.dataset.centerSection;}
  // ⭐ 2026-10-04 深夜：section() 现在【认锚点】——设置卡会扫这一页里所有带锚点的块，
  //   拿去当右栏的细分小节（用户要的"在时间轴里分得更细"）。
  //   ⚠ 第三个参数可选：section('账号', html, 'account')。
  //     不传就还是老样子（不参与右栏细分），所以老调用一行都不用改。
  //   ⚠ 锚点名用【人话小标题】，不是 id —— 它要直接显示给用户看（"登录与验证"）。
  function section(title,content,anchor){
    const node=document.createElement('section');node.className='settings-section';
    const heading=document.createElement('h3');heading.className='settings-section-title';heading.textContent=title;
    node.append(heading);
    if(typeof content==='string')node.insertAdjacentHTML('beforeend',content);else if(content)node.append(content);
    if(anchor){node.dataset.secAnchor=String(anchor);node.id='setsec-'+String(anchor).replace(/[^a-zA-Z0-9_-]/g,'-');}
    return node;
  }
  // ⭐ 2026-10-06 docs/150 §4.2：共享折叠组件 foldSection()。
  //   ⚠ 样式【只许】写在 card-architecture.css（docs/147 §2.3：两处定义 = 文字不一致的根源）。
  //   ⚠ 折叠 = 隐藏不移除（[hidden]，DOM/`data-*`/[data-setting] 全留）——
  //     main-card-shortcuts.js:89-106 全文档查 [data-setting] 回填，卸载 = 卡面值静默变旧。
  //   ⚠ 折叠体内【不加 overflow】（滚动永远归 .sc-body，docs/150 §三-3）。
  //   ⚠ 同屏最多展开一个低频折叠：点开一个，同一内容容器里别的先收起。
  //   参数：{title, anchor, open, content, note}；note 是收起时也可见的一句话摘要。
  function foldSection(options){
    const o=options||{};
    const node=document.createElement('section');node.className='settings-section settings-fold';
    if(o.anchor){node.dataset.secAnchor=String(o.anchor);node.id='setsec-'+String(o.anchor).replace(/[^a-zA-Z0-9_-]/g,'-');}
    const head=document.createElement('button');head.type='button';head.className='settings-fold-head';head.setAttribute('aria-expanded','false');
    const title=document.createElement('span');title.className='settings-section-title';title.textContent=o.title||'';head.append(title);
    if(o.note){const note=document.createElement('span');note.className='settings-fold-note';note.textContent=String(o.note);head.append(note);}
    const mark=document.createElement('span');mark.className='fold-x';mark.setAttribute('aria-hidden','true');head.append(mark);
    const body=document.createElement('div');body.className='settings-fold-body';
    if(typeof o.content==='string')body.innerHTML=o.content;else if(o.content)body.append(o.content);
    node.append(head,body);
    // ⚠ helpify 必须在"藏起来"之前调 —— 它对 [hidden] 内的说明文字直接跳过（见上面 closest('[hidden]') 那句），
    //   先隐藏再 helpify 的话折叠里的「?」一个都不会生成（docs/150 §4.2 点名的坑）。
    helpify(body);
    wireFold(node,head,body,o.open===true);
    return node;
  }
  // 折叠的开/关逻辑【只此一份】：foldSection 和 mountServices 的"原地折叠"共用。
  function wireFold(node,head,body,open){
    const setOpen=next=>{
      const want=next!==false;
      body.hidden=!want;
      head.setAttribute('aria-expanded',String(want));
      node.classList.toggle('open',want);
      if(want&&node.isConnected)closeFolds(node);
    };
    // ⚠⚠ 2026-10-07 修（用户实测报：设置卡「工具与隐私」有大标题、里面的内容全没了）
    //   点击必须走【当前】的 _foldSetOpen，不能死抱下面这个局部 setOpen。
    //   原因：好几处调用方会在建完之后**覆写** _foldSetOpen 去挂懒加载内容
    //   （storage() 的 ensure()、外观页 layout 段的 mount、mountServices 的原地折叠）。
    //   覆写只改了属性，改不到 head.onclick 闭包里的那个 setOpen ——
    //   于是**鼠标点开 = 绕过所有加载逻辑 = 永远一个空壳**，
    //   而程序化展开（路由高亮走 expandAncestors → _foldSetOpen）反而正常。
    //   实测对照（点第一行「存储与检查点」后的内容长度）：
    //     初始 [0,0,0,0,0,0] → 鼠标点 [0,0,0,0,0,0] → 程序化展开 [68,0,0,0,0,0]
    //   ⚠ 两条路必须都能挂载，不能只修一条（只修鼠标、程序化那条以后就会坏）。
    head.onclick=()=>{
      const current=typeof node._foldSetOpen==='function'?node._foldSetOpen:setOpen;
      // ⚠⚠⚠ 2026-10-08 修（用户报："有些东西展开了没有办法收起，有些地方它收起了没有办法展开"）
      //   ⚠⚠ 这行的方向【很容易搞反，我是靠实测栈才定下来的】，别凭感觉改：
      //      body.hidden 是【当前状态】：收着 = true。
      //      而 setOpen(next) 的 next 是【目标状态】：想打开就传 true。
      //      ⇒ 当前收着(true) 时，目标状态就是 true ⇒ **直接传 body.hidden 就是对的**
      //        （true→打开、false→收起，正好是"切换"）。
      //   ☠ 我一度把它"改成" current(!body.hidden)，结果是：
      //      收着时 !true = false ⇒ 传 false ⇒ 继续收着 ⇒ 鼠标永远打不开。
      //      探针实测栈：_foldSetOpen 传参 false / 之前藏 true / 之后藏 true —— 铁证。
      //      （顺带说：为什么原先就写着 body.hidden 还会"展不开"？
      //        因为 setOpen 里那句 `if(want&&node.isConnected)closeFolds(node)` ——
      //        下面那段注释讲的就是"鼠标点开=空壳"那件事，两条症状是分开的。）
      //   ⚠ closeFolds/expandAncestors/workspaces 传的都是【目标状态】（false/true/true），
      //     跟这里一致 —— 一处改了要四处一起看，否则又会出现"点开又被别人收起"。
      current(body.hidden);
    };
    node._foldSetOpen=setOpen;   // expandAncestors 用它，不模拟 click（避开滚动/焦点的副作用）
    setOpen(open===true);
    return setOpen;
  }
  // 同屏最多展开一个低频折叠。范围 = 最近的内容容器；找不到才退到整个文档。
  function closeFolds(keep){
    const scope=keep.closest('.settings-panel,.architecture-tab-panel,.sc-body,[data-sc-body],#dcBody,.v7-workspace-content')||document;
    scope.querySelectorAll('.settings-fold.open').forEach(other=>{
      if(other===keep)return;
      const fn=other._foldSetOpen;if(typeof fn==='function')fn(false);
    });
  }
  // ⭐ 2026-10-06 docs/150 §4.3：跳转先展开再高亮（expandAncestors）。
  //   路由高亮 / 卡面快捷 jump / 错误"下一步"落地前调它：
  //   向上找被 [hidden] 的折叠体 → 展开 + 更新 aria-expanded，
  //   否则目标 checkVisibility() 不过、高亮会被静默 return（改造前 ui.html 就是这样）。
  //   ⚠ 服务块的展开必须走它自己的 click（内容懒挂载）—— 直接把 hidden 去掉只会露一个空壳。
  function expandAncestors(node){
    if(!node||typeof node.closest!=='function')return false;
    // ⚠ 目标可能就是折叠本身（比如生成卡的 highlight 直接指 [data-sec-anchor="output"]）——
    //   先开"离目标最近的折叠"，再处理祖先链（服务块懒挂载 / 外层折叠）。
    const nearest=node.closest('.settings-fold');
    let changed=false;
    if(nearest&&typeof nearest._foldSetOpen==='function'&&!nearest.classList.contains('open')){
      nearest._foldSetOpen(true);
      changed=true;
    }
    const chain=[];
    for(let el=node.parentElement;el;el=el.parentElement){if(el.hidden)chain.push(el);}
    chain.reverse();   // 外层先开，内层才有可见性
    for(const body of chain){
      if(body.classList.contains('settings-fold-body')||body.hasAttribute('data-fold-body')){
        const sec=body.closest('.settings-fold');
        const fn=sec&&sec._foldSetOpen;
        if(typeof fn==='function')fn(true);else body.hidden=false;
        changed=true;
        continue;
      }
      if(body.classList.contains('service-block-body')){
        const head=body.previousElementSibling;
        if(head&&typeof head.click==='function'){head.click();changed=true;}
        continue;
      }
    }
    return changed;
  }
  function source(index){const node=document.createElement('div');node.innerHTML=host.settingsMarkup(index);return node;}
  function takeField(from,key){const input=from.querySelector('[data-setting="'+key+'"]');return input?.closest('.settings-row')||input?.closest('.settings-field');}
  function takeHelp(from,key){const node=from.querySelector('[data-setting-help="'+key+'"]');if(!node)return null;node.removeAttribute('data-setting-help');return node;}
  function fields(from,keys){const grid=document.createElement('div');grid.className='settings-grid';for(const key of keys){const node=takeField(from,key);if(node)grid.append(node);else throw new Error('设置入口缺失：'+key);}return grid;}
  function helpify(container){
    container.querySelectorAll('.v7-help').forEach(helpText);
    // ⚠⚠⚠ 2026-10-08 加：这一族节点【转成「?」按钮会出事】，必须整个跳过。
    //   · [data-provider-test-status] —— 「检查连接」跑完是把结果写进这个节点的 textContent。
    //     节点被换成「?」按钮之后，结果就【写进了一个已经不在页面上的节点】= 静默失效。
    //     （用户跑完检查什么都看不到，而控制台一声不吭 —— 本项目最忌讳的形态。）
    //   · [data-provider-modelnote] 同理（模型名单"新增/消失"那一行）。
    //   · [data-provider-balance] 是余额框，它本身是个按钮，不该再被挂一个问号。
    const 不许动='[data-provider-test-status],[data-provider-modelnote],[data-provider-balance],[data-provider-connection-slot]';
    const attach=(target,text)=>{
      const existing=target.querySelector(':scope > .v7-help');
      if(existing){
        const parts=helpText(existing).split('\n');if(!parts.includes(text))parts.push(text);
        existing.dataset.helpText=parts.join('\n');existing.setAttribute('aria-label','说明：'+existing.dataset.helpText);return;
      }
      const button=document.createElement('button');button.type='button';button.className='v7-help';button.textContent='?';button.dataset.helpText=text;button.setAttribute('aria-label','说明：'+text);
      target.append(button);
    };
    container.querySelectorAll('.sf-hint,.settings-note,.ai-help,.settings-intro,.pd-field-desc').forEach(node=>{
      if(node.closest('[hidden]'))return;
      if(node.matches(不许动))return;
      if(node.closest(不许动))return;
      if(node.matches('[role], [data-provider-test-status], [data-align-tip]')||[...node.attributes].some(attr=>attr.name.startsWith('data-'))||node.querySelector('button,input,select,textarea,a,[role],[data-setting]'))return;
      const text=node.textContent.trim();if(!text||/不可撤销|不能撤销|永久删除|正在跑的任务会丢失|修改软件代码可能/.test(text)||/^(还没有|暂无|尚未|未连接|已连接|费用|资料更新)/.test(text))return;
      // ⚠ 2026-10-14：'.v7-tutorial' 那个选择器跟着教程卡一起删了（教程整块要重做）。
      //   '.manual-content' 留着 —— 使用说明书还在（它不是教程）。
      if(node.closest('.manual-content'))return;
      if(node.classList.contains('settings-intro')){const title=node.querySelector('strong');if(title){const line=document.createElement('div');line.className='settings-section-title';line.append(title);attach(line,text);node.replaceWith(line);return;}}
      const field=node.closest('.pd-slider,.pd-field,.settings-field,.settings-row');
      const group=node.closest('details,.settings-section,.layout-section,.provider-catalog,.provider-catalog-item');
      const target=field?.querySelector('.nsl-head,.tgl,.settings-color,.pd-slider-head,.pd-field-label')||field||group?.querySelector(':scope > summary,:scope > .settings-section-title,:scope > h3');
      if(target&&container.contains(target)){attach(target,text);if(target.getAttribute('title')===text)target.removeAttribute('title');node.remove();}
      else{const wrap=document.createElement('div');wrap.className='v7-help-line';attach(wrap,text);node.replaceWith(wrap);}
    });
    // Legacy switches describe the whole label with a native title. Give that
    // explanation the same single, keyboard-accessible help target as fields.
    container.querySelectorAll('.tgl[title],.pd-slider-head[title]').forEach(node=>{
      const text=node.getAttribute('title')?.trim();node.removeAttribute('title');if(text)attach(node,text);
    });
  }
  function cardFace(container,id,zones){
    if(container.dataset.faceReady===id)return;
    container.dataset.faceReady=id;container.replaceChildren();
    for(const [index,item] of zones.entries()){
      const button=document.createElement('button');button.type='button';button.className='card-category';button.dataset.cardRoute=id;button.dataset.cardZone=index;button.dataset.categoryId=String(item[3]||index);
      const icon=document.createElement('span');icon.className='card-category-icon';icon.setAttribute('aria-hidden','true');
      if(root.ICON&&typeof root.ICON.set==='function')root.ICON.set(icon,item[0],18);
      const title=document.createElement('strong');title.textContent=item[1];const subtitle=document.createElement('span');subtitle.textContent=item[2];button.append(icon,title,subtitle);
      button.onclick=event=>{event.preventDefault();event.stopPropagation();host.navigate(id,index);};container.append(button);
    }
  }
  function bind(body){host.bindSettings(body);helpify(body);}
  function panel(body,zone){const el=document.createElement('div');el.className='settings-panel architecture-panel';el.dataset.settingsZone=zone;body.append(el);return el;}
  function tabs(container,items,initial,render,options={}){
    const nav=document.createElement('nav'),content=document.createElement('div'),prefix='v7-center-'+(++tabSequence);
    nav.className='architecture-tabs';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','内容分区');
    content.className='architecture-tab-content';content.setAttribute('role','tabpanel');content.id=prefix+'-panel';
    container.append(nav,content);
    let cleanup=null,selected='',closed=false;
    const preserved=options.preservePanels===true;
    const panels=new Map(),panelCleanups=new Map();
    function ensurePanel(id){
      if(panels.has(id))return panels.get(id);
      const panel=document.createElement('div');panel.className='architecture-tab-panel';panel.dataset.centerPanel=id;
      content.append(panel);panels.set(id,panel);
      const dispose=render(panel,id)||null;if(typeof dispose==='function')panelCleanups.set(id,dispose);
      helpify(panel);panel.hidden=true;return panel;
    }
    const positions=new Map();
    function select(id,focus=false){
      if(closed||selected===id)return;
      const scroll=container.closest('.dc-scroll');if(scroll&&selected)positions.set(selected,scroll.scrollTop);
      if(preserved){
        selected=id;for(const [key,panel] of panels)panel.hidden=key!==id;cleanup=panelCleanups.get(id)||null;
      }else{cleanup?.();cleanup=null;selected=id;content.replaceChildren();}
      container.dataset.centerSection=id;
      // Keep the public detail body in sync with the inner tab host.  Route
      // tests, keyboard users, and the navigation shell all observe #dcBody;
      // the tab host is intentionally nested there so the state must not be
      // hidden on the implementation wrapper only.
      // ⚠ 2026-10-01：设置内容搬进 #settingsZone 后，容器不再是 #dcBody 的后代 ——
      //   只认 #dcBody 的话 data-center-section 永远写不上，路由/测试都读不到当前子页签。
      const publicBody=container.closest?.('#dcBody, #settingsZone');
      if(publicBody)publicBody.dataset.centerSection=id;
      nav.querySelectorAll('button').forEach(button=>{const active=button.dataset.centerTab===id;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;if(active){content.setAttribute('aria-labelledby',button.id);if(focus)button.focus({preventScroll:true});}});
      if(!preserved){cleanup=render(content,id)||null;helpify(content);}
      if(scroll)requestAnimationFrame(()=>{if(!closed&&selected===id&&container.isConnected)scroll.scrollTop=positions.get(id)||0;});
    }
    for(const [id,label] of items){const button=document.createElement('button');button.type='button';button.className='settings-btn';button.dataset.centerTab=id;button.id=prefix+'-'+id;button.setAttribute('role','tab');button.setAttribute('aria-controls',content.id);button.textContent=label;button.onclick=()=>select(id);nav.append(button);}
    nav.addEventListener('keydown',event=>{const buttons=[...nav.querySelectorAll('button')],index=buttons.indexOf(event.target);if(index<0)return;let next;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index+buttons.length-1)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;event.preventDefault();event.stopPropagation();select(buttons[next].dataset.centerTab,true);});
    const first=items.some(([id])=>id===initial)?initial:items[0][0];
    if(preserved)items.forEach(([id])=>ensurePanel(id));
    select(first);
    return ()=>{closed=true;if(preserved){for(const dispose of panelCleanups.values())try{dispose();}catch(_){}panelCleanups.clear();panels.clear();}else{cleanup?.();cleanup=null;}};
  }
  function routeButton(label,route){const button=document.createElement('button');button.type='button';button.className='settings-btn';button.textContent=label;button.onclick=()=>root.V7RouteRegistry.open(route);return button;}
  function guardReset(body){
    const original=body.querySelector('[data-settings-reset]');if(!original)return;
    const button=original.cloneNode(true);original.replaceWith(button);
    button.onclick=()=>{const scope=root.WHEELCHAIR_STORAGE?.namespaceId?.();root.UI?.dialog({title:'恢复当前账号的默认设置',body:'这会重置当前账号的设置和这台电脑的主题外观，并重新加载界面。预设、图片、历史和其他账号的数据继续保留。',confirm:'恢复默认并重新加载',cancel:'保留当前设置',danger:true,onConfirm:()=>{if(scope===root.WHEELCHAIR_STORAGE?.namespaceId?.())original.click();}});};
  }
  /* ⚠⚠ 死代码，但别删也别让它裸奔（2026-10-01 设置卡改版后）：
     这一页（设置 zone 1）【已经不可达】—— 生成与传回搬去生成卡，交互/快捷键搬进
     「外观与交互」，账号页也不再指到这里。settings() 却仍是公开 API（导出表里有），
     外部/旧代码仍可能调 settings(body,1)，走到这儿。
     ⚠ 里面 fields(other,['bridgePollMs']) 在标记被删后会【抛错】
       （fields 找不到 key 是 throw，不是 return null）——
       所以这里全部改成安全取法，坏也坏得看得见。 */
  function defaults(body,out){
    const requested=body.dataset.requestedSection || host.routeOptions()?.section;
    retain(body,tabs(out,[['output','生成与回图'],['interaction','交互与快捷键'],['content','内容偏好']],requested||'output',(target,id)=>{
      if(id==='output'){generation(target);return ()=>{target._settingsAccountCleanup?.();target._settingsAccountCleanup=null;};}
      const appearance=source(2),other=source(3);
      /* ⚠ safe()：拿不到就跳过，不要留空节、也不要抛 */
      const safe=(keys,from)=>{const grid=document.createElement('div');grid.className='settings-grid';
        for(const key of keys){const node=takeField(from,key);if(node)grid.append(node);}
        return grid.childElementCount?grid:null;};
      if(id==='interaction'){
        const rows=[['滚动与切换',safe(['presetFlipNotches'],appearance),'预设列表滚动到边缘后，连续滚够设定格数才切换主卡。'],
                    // ⚠ 2026-10-14：这里原来只有 generationShortcut ——
                    //   加了「加参考图」之后忘了补，走这条路由时用户只能看到一个录入框。
                    //   （这条路由本身已不可达，但 settings() 仍是公开 API，别让它少东西。）
                    ['快捷键',safe(['generationShortcut','referenceShortcut','collapseShortcut','providerShortcut'],appearance),'点击快捷键输入框后按下组合键。'],
                    ['Photoshop 交互',safe(['bridgePollMs'],other),'轮询越快，图层联动越跟手，也会增加 Photoshop 的处理频率。']];
        for(const [title,grid,hint] of rows){
          if(!grid)continue;
          const sec=section(title);sec.append(grid);
          sec.append(Object.assign(document.createElement('p'),{className:'settings-note',textContent:hint}));
          target.append(sec);
        }
      }else{
        const browser=other.querySelector('[data-browser-preferences]')?.closest('.settings-section');if(browser){target.append(browser);browser.querySelector('button').onclick=()=>root.V7BrowserBookmarks.open();}
        // ⚠ 2026-10-01 真搬家：Forge 预设那个按钮跟着「生成与传回」一起搬去生成卡了，
        //   所以这里不能再用 source(1) 去设置卡 zone 1 捞 —— 捞不到（那句话是 if 保护，
        //   不会报错，但按钮会【静默消失】）。
        //   现在从 generationMarkup() 里取。⚠ 那一页本身已不可达（见上面注释），
        //   但 settings() 还是公开 API，别让它静默少一个入口。
        const presets=section('预设内容');presets.append(routeButton('生成与回图默认值','settings/generation'));
        const gsrc=document.createElement('div');gsrc.innerHTML=host.generationMarkup?host.generationMarkup():'';
        const refresh=gsrc.querySelector('[data-forge-comfy-refresh]');if(refresh)presets.append(refresh);target.append(presets);
        // ⚠⚠ 2026-10-14：这里原来还有一段「教程提示」（data-tutorial-hints 开关，
        //   接 root.V7Tutorial.hintsEnabled()/setHintsEnabled()）—— 跟着教程一起删了。
        //   ⚠ 它不能只是删掉 DOM：V7Tutorial 模块本身也删了，留着这一行会
        //     `Cannot read properties of undefined (reading 'hintsEnabled')` 直接抛。
        //   重做教程时要在【三个地方】同时恢复：
        //     · 这里（设置 → 外观 里的开关）
        //     · card-architecture.js 的 appearance 那一段（data-tutorial-hints）
        //     · main-card-shortcuts.js 的 SETTINGS_TAGS 'hints' + ids 数组 + markup.tutorial
        //   清单见 docs/217。
      }
      bind(target);return ()=>{target._settingsAccountCleanup?.();target._settingsAccountCleanup=null;};
    },{preservePanels:true}));
  }
  function storage(body,out){
    // ⭐⭐ 2026-10-14 重排：数据与隐私 6 个折叠 → 直铺小标题。
    //   折叠头删掉，内容直接铺在页面里；右边导航条扫 [data-sec-anchor] 自动建小节列表。
    //   ⚠ 懒挂载改 IntersectionObserver：每个重模块在滚到可见时才建，不再依赖展开。
    //   ⚠ 必须保留（逐条）：id="setsec-*" / data-sec-anchor（右栏细分 + 老路由寻址）、
    //     [data-account-backup] / [data-layout-restore] / [data-software-recovery] 高亮钩子、
    //     V7CloudBackup.open / V7LayoutManager.mount / V7AssistantPanel.mountSection / mountCache。
    const defs=[
      {id:'storage',title:'存储与检查点'},
      {id:'account-backup',title:'账号备份'},
      {id:'layout-restore',title:'布局恢复'},
      {id:'software-recovery',title:'助手修改回滚'},
      {id:'backup-preferences',title:'自动备份'},
      {id:'privacy',title:'Agent 权限'}
    ];
    defs.forEach(def=>{
      // 直铺 section，不再是折叠块。section() 负责写 data-sec-anchor 和 id。
      const sec=section(def.title,null,def.id);
      const target=document.createElement('div');
      sec.append(target);
      // 高亮钩子先建好（路由"先滚到再高亮"必须找得到目标）
      if(def.id==='account-backup')target.setAttribute('data-account-backup','');
      if(def.id==='layout-restore')target.setAttribute('data-layout-restore','');
      if(def.id==='software-recovery')target.setAttribute('data-software-recovery','');
      let mounted=false,cacheHandle=null;
      const ensure=()=>{
        if(mounted)return;
        mounted=true;
        if(def.id==='account-backup')root.V7CloudBackup.open(target,{section:'backup',showBack:false});
        else if(def.id==='layout-restore')root.V7LayoutManager.mount(target);
        else if(def.id==='software-recovery')root.V7AssistantPanel.mountSection(target,'recovery');
        else if(def.id==='backup-preferences')root.V7CloudBackup.open(target,{section:'preferences',showBack:false});
        else if(def.id==='privacy')root.V7AssistantPanel.mountSection(target,'permissions');
        else{
          const output=source(1),other=source(3),checkpoints=section('缓存与检查点',fields(output,['checkpointEnabled','checkpointIntervalMin','cacheCapacityGB']));
          const help=takeHelp(output,'checkpoint');if(help)checkpoints.append(help);target.append(checkpoints);
          const cache=other.querySelector('[data-cache-settings]');if(cache)target.append(cache);
          cacheHandle=cache?host.mountCache(cache):null;
          // ⚠ 遥测开关没有 data-setting，必须手工重建。见之前注释（§改进计划 → §匿名反馈）。
          const telemetry=section('匿名反馈',
            '<div class="settings-row full"><label class="ai-switch"><span>发送匿名使用与报错信息</span>'
            +'<input type="checkbox" data-telemetry-toggle '+((root.V7Telemetry?root.V7Telemetry.enabled():true)?'checked':'')+'></label></div>'
            +'<div class="settings-note">用来知道你在哪一步遇到问题、哪个功能真被用，好让我们把它修好。<br>'
            +'<b>绝不上传</b>：提示词和文案、文件名和路径、图片内容、任何 Key 或密码、邮箱和手机、设备型号全名、精确位置。<br>'
            +'报错消息里的中文和路径会在<b>你的电脑上先被抹掉</b>，再发出去；完整原文只留在本机。<br>'
            +'关掉这个开关后，连启动事件都不会发送，也不影响任何功能。</div>');
          target.append(telemetry);
          const restore=section('设置恢复','<p class="architecture-warning">恢复默认会清除当前账号的设置和这台电脑的主题外观，并重新加载界面。</p><div class="settings-actions"><button class="settings-btn" data-settings-save>保存设置</button><button class="settings-btn danger" data-settings-reset>恢复默认设置</button></div>');target.append(restore);
          bind(target);guardReset(target);
        }
      };
      // 懒挂载：滚到可见才建，不一进页就全建（重模块太多会卡）。
      if(typeof IntersectionObserver!=='undefined'){
        const obs=new IntersectionObserver(entries=>{
          if(entries.some(e=>e.isIntersecting)){obs.disconnect();ensure();}
        },{threshold:0.01});
        obs.observe(sec);
        retain(body,()=>obs.disconnect());
      }else{
        ensure();
      }
      out.append(sec);
      retain(body,()=>{if(typeof cacheHandle==='function')cacheHandle();else cacheHandle?.dispose?.();target._settingsAccountCleanup?.();target._settingsAccountCleanup=null;});
    });
  }
  /* ═══════════════════════════════════════════════════════════════════════
     ⭐⭐⭐ 2026-10-14 设置卡【一列到底】整页渲染（替代下面按页签出内容的 settingsTab）。

     用户原话（这一版的依据）：
       "左侧的详情…所有的展开、闭合都需要全部删除，全部重排"
       "按照第一性原理和我们的使用逻辑…切得更细更碎"
       "傻子都能看得懂，傻子都能玩的明白，傻子都能从右边的导航栏找得到对应的东西在哪"
       "颜色设置里面那三栏是不是可以直接一横排去搞定？"
       "一个很长的滑动条…能不能换成左边一个，右边一个，同时放下两个？"
       "有一个问号单独占一行，这种情况太多了，导致整个设置界面变得极为臃肿"

     ⚠ 规矩（改这里之前先看）：
       ① 每一节都用 page.sec(id,…)；id 必须在 ui.html 的 SETTINGS_TABS 里有一行 ——
          右边导航按那张表画，左边没有对应节 = 点了不动（静默失效）。
       ② 控件【不重写】，全部从原来的标记源里搬（source(0..3) / generationMarkup /
          alignSettingsMarkup / returnSettingsMarkup）—— 另写一份就是"两份控件两份仓库"。
          ⚠ take() 找不到不抛错，但会在控制台报一句（方便查"控件凭空消失"）。
       ③ 说明文字一律走 note()：helpify 会把它收成【标题右边的「?」】，不单占一行。
          节标题下面那句灰字（sub）是【常显】的，写"这一块管什么"，一句话说完。
       ④ 单例模块（账单中心 / 云备份 / 助手面板）同一时间只能挂一份 ——
          用 slots 管：滚到哪一节，模块就挂到哪一节，离开的那一节保住高度、显示占位。
     ═══════════════════════════════════════════════════════════════════════ */
  function settingsPage(body){
    reset(body);
    // ⚠ 所有小节包在一个 .settings-panel 里：老测试和账号隔离检查按 closest('.settings-panel') 认"这是设置表单"。
    const list=document.createElement('div');list.className='settings-panel sc-flat';body.append(list);
    body.dataset.settingsTab='all';
    const src0=source(0),src1=source(1),src2=source(2),src3=source(3);
    const box=html=>{const d=document.createElement('div');d.innerHTML=html||'';return d;};
    const gen=box(host.generationMarkup?host.generationMarkup():'');
    const align=box(typeof host.alignSettingsMarkup==='function'?host.alignSettingsMarkup():'');
    const ret=box(typeof host.returnSettingsMarkup==='function'?host.returnSettingsMarkup():'');
    const missing=[];
    // 从源里拿一个控件（整行）。⚠ 找不到记下来，最后统一报（不抛，免得整页白屏）。
    const take=(from,key)=>{const node=takeField(from,key);if(!node)missing.push(key);return node;};
    // 一排 N 个。wide = 该项占满整排（地址、Key 这种长输入）
    const row=(cols,...nodes)=>{
      const g=document.createElement('div');g.className='settings-grid cols-'+cols;
      nodes.flat().filter(Boolean).forEach(n=>g.append(n));
      return g.childElementCount?g:null;
    };
    const wide=node=>{if(node)node.classList.add('wide');return node;};
    const note=text=>Object.assign(document.createElement('p'),{className:'settings-note',textContent:text});
    const actions=(...buttons)=>{const a=document.createElement('div');a.className='settings-actions';buttons.filter(Boolean).forEach(b=>a.append(b));return a.childElementCount?a:null;};
    const btn=(label,fn,attrs)=>{const b=document.createElement('button');b.type='button';b.className='settings-btn';b.textContent=label;if(fn)b.onclick=fn;Object.entries(attrs||{}).forEach(([k,v])=>b.setAttribute(k,v));return b;};
    const meta=(window.SETTINGS_TABS_INDEX||{});
    const sec=(id,...children)=>{
      const m=meta[id]||{};
      const node=section(m.name||id,null,id);
      if(m.sub){const p=document.createElement('p');p.className='sec-sub';p.textContent=m.sub;node.append(p);}
      children.flat().filter(Boolean).forEach(c=>node.append(c));
      list.append(node);
      return node;
    };
    const slots=moduleSlots(body);

    // ══ ⭐⭐ 云功能闸门（2026-10-14，用户要求）════════════════
    // 用户原话：「所有的和云相关的功能，就是跟我们账号相关的功能，
    //           在不登录的时候就直接不显示。」
    //          → 追问后改成：「换成灰色，不点按就行了，无法点按就行了」
    // 所以：【变灰 + 点不动】，不是移走（移走的话用户不知道有这功能，
    //       而且版面会跳来跳去）。
    //
    // ⚠⚠ 三条边界（每一条都有人踩过坑，别随手放开）：
    //  ① 【公告除外】。'notices' 那一节绝不能进这张表 ——
    //     后端的 /v1/public/announcement 本来就在公开白名单里，不登录也能读。
    //     用户明确说过"公告无论如何登不登录都要尝试拉取一次"。
    //  ② 'account' 那一节【不能整节锁】—— 登录框就在里面，锁了就永远登不上。
    //     它由下面的 locked 判断单独跳过（只锁'credits'及以后的云功能）。
    //  ③ 本地功能一个都不锁：生成、预设、抠像、引擎、布局、外观…
    //     判据是「这件事要不要跟后端说话」，不是「听起来像不像高级功能」。
    const CLOUD_SECTIONS=['credits','keysync','imagecompute','lowbalance',
      'backup','autobackup','support','community','notices'];
    // ⚠ 'notices' 故意【不在】上面那张表里？—— 不，它在列表里但下面会跳过它。
    //   写在这里是为了"看得见它被讨论过"；真正生效的是下面 cloudGated() 的排除逻辑。
    const CLOUD_GATE_EXEMPT=['notices'];   // 公告：不锁（约束①）
    const cloudGated=id=>CLOUD_SECTIONS.indexOf(id)>=0 && CLOUD_GATE_EXEMPT.indexOf(id)<0;
    // 登录状态：唯一真相在后端客户端里（别自己另存一份，那种"两处状态"迟早不同步）
    const signedIn=()=>{
      try{ return !!(window.V7Backend && V7Backend.state && V7Backend.state().signedIn); }
      catch(_){ return false; }
    };
    // 给每节打标记 + 按登录状态上锁。⚠ 幂等：可以随便重复调。
    function applyCloudGate(){
      const on=signedIn();
      list.querySelectorAll('[data-sec-anchor]').forEach(node=>{
        const id=node.dataset.secAnchor;
        if(!cloudGated(id)){ node.removeAttribute('data-cloud-locked'); return; }
        // ⚠ 不用 hidden、不用 display:none —— 用户要的是"看得见但点不动"
        if(on) node.removeAttribute('data-cloud-locked');
        else node.setAttribute('data-cloud-locked','');
      });
      list.dataset.cloudSignedIn=on?'1':'0';
    }

    // ══ 账号 ══════════════════════════════════════════
    // 登录框：后端地址【不再给输入框】（用户定："后端写死…后端不允许改"）。
    //   ⚠ backendUrl 这个键还在 settingsRuntime 里（启动迁移/网络体检都读它），只是不让在界面上改。
    // ══ 公告与状态 ══════════════════════════════════════
    // ⭐⭐ 2026-10-14（用户定）：【搬到最顶栏】。
    //   用户原话：「如果是长公告的话，就是右划可以转到这个设置界面的公告区域，
    //             公告区域放到设置的最顶栏」。
    //   ⚠ 必须在这里（settingsPage 的开头）建 —— sec() 是按调用顺序 append 的，
    //     写在后面就跑到最底下，用户右划过来还得自己往下翻半天。
    //   ⚠ 配套：ui.html 的 SETTINGS_TABS 里 'notices' 也要在第一行（导航那一列的顺序）。
    {
      const slot=document.createElement('div');
      sec('notices',slot);
      // ⚠⚠ 2026-10-14（用户两次点名改造后重写）：
      //   用户原话：「设置卡顶上有一个公告与状态，有一个平台公告。你这两个也挺奇怪的。」
      //            「把这个公告变成最大的顶栏放在上面，合并公告与状态和平台公告」
      //            「把这个 V7开始测试了，包在这个公告框里面」
      //   ⇒ 整节内容由 V7Announce.panelHtml()【整段替换】：
      //     一个标题「平台公告」+ 状态行 + 一个有边框的公告框 + 服务状态容器。
      //     ⚠ 必须整段换：标题是 sec() 按 SETTINGS_TABS 建的（写死「公告与状态」），
      //       只往里面塞正文的话，标题还是「公告与状态」、里面又一个小标题「平台公告」
      //       —— 那就是用户看到的"两个，挺奇怪的"。
      //
      //   ⚠⚠ 为什么公告正文不走 account-center：
      //     它 account-center.js:38 有个【整页级】登录闸门
      //       `if(!state().signedIn){ body.innerHTML='请先登录，再查看…服务公告'; return; }`
      //     把 billing / support / service 三个页签一起挡掉 ⇒ 不登录时公告永远看不到。
      //     而用户明确要求"公告不论登不登录都要能看到"。
      //   ⚠ 没动 account-center 那道闸门 —— 账单和工单本来就该要登录，那是它的职责。
      const paint=()=>{
        // ⭐⭐ 2026-10-15（用户定「冗余的状态和公告合并好」）：这一节现在只有【一块】——
        //   标题「平台公告」+ 右边连接状态（已连上 / 连不上）+ 富文本公告框 + 服务状态小签 + 链接。
        //   服务状态跟公告是同一个公开接口回来的（不登录也有），所以【不再】挂 account-center
        //   的 service 页（那一页要登录、自带"平台服务公告状态 / 公告"两个小标题和"刷新当前页"按钮
        //   —— 用户说的"太冗余，不知道在干啥"就是它）。account-center 本身没删，别处还在用。
        const node=root.V7Announce&&typeof root.V7Announce.panelNode==='function'?root.V7Announce.panelNode():null;
        if(!node) return;                 // 模块没加载就保持 sec() 画的原样，别把这一节清空
        // ⚠⚠ 必须替换【整节】的内容（标题也换），否则会出现「公告与状态」「平台公告」两个标题。
        //   ⚠ data-sec-anchor / id 在【节元素本身】上，replaceChildren 不会碰它们，导航锚点照旧有效。
        const secEl=slot.closest('.settings-section');
        if(!secEl) return;
        secEl.replaceChildren(...node.childNodes);
      };
      paint();
      // 拉完（启动那次、或下面的触发式刷新）就重画。⚠ 用事件，不轮询。
      const onUpdate=()=>{ try{ paint(); }catch(error){ if(window.ERR) ERR.report('SETTINGS_OPERATION_FAILED',{message:'公告区重画：'+String(error&&error.message||error)}); } };
      window.addEventListener('wheelchair:announce-updated',onUpdate);
      retain(body,()=>window.removeEventListener('wheelchair:announce-updated',onUpdate));
      // ⭐ 2026-10-15「刷新改成触发式」：没有刷新按钮。每次打开设置页，
      //   上次拉取超过 1 分钟、或者上次没连上，就悄悄重拉一次（结果靠上面的事件画出来）。
      try{ root.V7Announce?.refreshIfStale?.(60000); }catch(_){}
    }
    {
      const status=src0.querySelector('.settings-status');
      const loginGrid=src0.querySelector('[data-account-email]')?.closest('.settings-grid');
      const email=loginGrid?.querySelector('[data-account-email]')?.closest('.settings-field');
      const pw=loginGrid?.querySelector('[data-account-password]')?.closest('.settings-field');
      const cap=loginGrid?.querySelector('[data-account-captcha]')?.closest('.settings-field');
      const capImg=loginGrid?.querySelector('[data-account-captcha-img]')?.closest('.settings-field');
      const btns=[...src0.querySelectorAll('[data-account-login],[data-account-register],[data-account-recovery],[data-account-points],[data-account-logout]')];
      // 顺序：登录 → 注册 → 忘记密码 → 刷新积分 → 退出（按"用到的先后"排）
      const order=['data-account-login','data-account-register','data-account-recovery','data-account-points','data-account-logout'];
      btns.sort((a,b)=>order.findIndex(k=>a.hasAttribute(k))-order.findIndex(k=>b.hasAttribute(k)));
      // ⭐⭐ 2026-10-14：把「记住我」整行 + 它的说明 + 「忘掉这台设备」按钮搬过来。
      //   ⚠⚠ 这一节是【挑着搬】的（只搬上面点名的那些控件）——
      //     光在 legacySettingsMarkup 里写好标记是【不会出现在界面上】的。
      //     我第一版就栽在这儿：标记写了、语法过了、界面上一片空白，
      //     查了半天才发现是"没被搬过来"（DOM 里 querySelectorAll 数是 0）。
      //     这是这张卡的固定姿势：`settingsPage` 里加东西，这里必须同步加一行。
      //     （同一族的老坑记在调试卡那段注释里，也是"必须在这里显式搬过来"。）
      const rememberRow=src0.querySelector('[data-remember-row]');
      const rememberNote=src0.querySelector('[data-remember-note]');
      const rememberStatus=src0.querySelector('[data-account-remember-status]')?.closest('.settings-actions');
      // ⭐⭐ 2026-10-15 重排（用户原话：「账号登录下面的那些按钮，它居然不在同一行」
      //   「记住账号密码的这个钩子…它的排序啊，在界面中的位置也很奇怪」）。
      //   ⇒ 按【登录前 / 登录后】分两块，同一时间只露一块：
      //     登录前：邮箱 密码 / 验证码 图 / 「记住我 …… 忘记密码？」一行 / 「登录 注册」一行
      //     登录后：状态行 + 「退出登录 忘掉这台设备」一行 + 本机记住了谁
      //   ⚠ 两块都在 DOM 里，用 hidden 切（契约：折叠隐藏不移除，bindSettingsDetail 按属性找按钮）。
      //   ⚠「刷新积分」不再给按钮：积分在下一节「积分与充值」里自动读（打开就读、每分钟、兑换后都会刷），
      //     按钮节点留着藏起来（老 accountAction 还绑着它）。
      const by=attr=>btns.find(b=>b.hasAttribute(attr));
      const loginBtn=by('data-account-login'),regBtn=by('data-account-register'),recBtn=by('data-account-recovery');
      const pointsBtn=by('data-account-points'),outBtn=by('data-account-logout');
      const forgetBtn=rememberStatus?.querySelector('[data-account-forget]');
      const rememberText=rememberStatus?.querySelector('[data-account-remember-status]');
      if(recBtn){recBtn.classList.add('settings-link-btn');recBtn.textContent='忘记密码？';}
      const optRow=document.createElement('div');optRow.className='account-login-options';
      if(rememberRow){rememberRow.classList.remove('full');optRow.append(rememberRow);}
      if(recBtn)optRow.append(recBtn);
      const loginBox=document.createElement('div');loginBox.className='account-mode';loginBox.dataset.accountLoginBox='';
      [row(2,email,pw),row(2,cap,capImg),optRow,actions(loginBtn,regBtn)].filter(Boolean).forEach(n=>loginBox.append(n));
      const signedBox=document.createElement('div');signedBox.className='account-mode';signedBox.dataset.accountSignedBox='';
      [actions(outBtn,forgetBtn),rememberText].filter(Boolean).forEach(n=>signedBox.append(n));
      if(pointsBtn){pointsBtn.hidden=true;signedBox.append(pointsBtn);}
      if(rememberStatus){rememberStatus.hidden=true;signedBox.append(rememberStatus);}   // 空壳也留着（老选择器）
      // 「记住我」那段长说明 → 收进这一节的 ? 气泡（原文带 <b>，helpify 不收，所以取纯文字另做一条 note，原节点藏起来留着）
      const rememberText_=rememberNote?String(rememberNote.textContent||'').replace(/\s+/g,' ').trim():'';
      if(rememberNote){rememberNote.hidden=true;}
      sec('account',status,loginBox,signedBox,
        rememberNote,
        note('同一账号同一时间只保留一个设备登录。只用自己的第三方 API Key 时，可以不登录。验证码看不清就点一下图片换一张；每张只能用一次。'+(rememberText_?'「记住我」：'+rememberText_:'')));
      const syncAccountMode=()=>{
        let signed=false;
        try{ signed=!!(root.V7Backend&&V7Backend.state&&V7Backend.state().signedIn); }catch(_){}
        loginBox.hidden=signed;
        signedBox.hidden=!signed;
      };
      syncAccountMode();
      const offAccount=root.V7Backend?.onChange?.(syncAccountMode);
      window.addEventListener('wheelchair:storage-context',syncAccountMode);
      retain(body,()=>{ try{ typeof offAccount==='function'&&offAccount(); }catch(_){} window.removeEventListener('wheelchair:storage-context',syncAccountMode); });
      // 状态文字（"本机已记住：xxx"）要按实际情况刷一次 —— 刚搬过来时它是空的
      try{ root.accountRefreshRememberStatus?.(); }catch(_){}
    }
    {
      const slot=document.createElement('div');slot.setAttribute('data-account-billing','');
      const credits=sec('credits',slot);
      slots.add('account-center',slot,el=>root.V7AccountCenter?.mount(el,'billing'));
      // ⭐⭐ 2026-10-15（用户原话：「积分与充值的那个横行右边加上一个使用积分，然后点一下之后下滑弹出一个兑换卡密」）
      //   ⇒ 标题行右边一个「兑换卡密」按钮，点了往下展开卡密输入框；再点收起。
      //   ⚠ 开关状态记在【这一节】身上（data-redeem-open），不记在账单模块里 ——
      //     账单模块每次刷新都整块重画，记在里面的话一刷新就自己收起来了。
      //   ⚠ 展开的框是 account-center 画的 [data-account-redeem-panel]，显隐只靠 CSS（cloud-gate.css）。
      const title=credits.querySelector('.settings-section-title');
      if(title){
        const toggle=btn('兑换卡密',()=>{
          const open=!credits.hasAttribute('data-redeem-open');
          credits.toggleAttribute('data-redeem-open',open);
          toggle.setAttribute('aria-expanded',String(open));
          if(open)requestAnimationFrame(()=>credits.querySelector('[data-account-redeem]')?.focus());
        },{'data-credits-redeem-toggle':'','aria-expanded':'false'});
        toggle.classList.add('sec-title-btn');
        title.append(toggle);
      }
    }
    {
      // ⭐ 2026-10-15（用户：「充值 key 这些东西…用户一定知道那个地方可以…但常驻的话是一个超低频次的使用，
      //   所以不应该直接放在这个二级菜单里面」）⇒ 这一节内容收进折叠，点开才挂云备份模块。
      //   ⚠ 懒挂载靠 moduleSlots 的"露出多少"判断 —— 折叠收着时露出为 0，所以展开时要手动催一次 update()。
      const slot=document.createElement('div');
      const fold=document.createElement('details');fold.className='settings-fold-lite';fold.dataset.keysyncFold='';
      const sum=document.createElement('summary');sum.textContent='换电脑时用：把 API Key 加密存到云端（点开设置）';
      fold.append(sum,slot);
      fold.addEventListener('toggle',()=>{ if(fold.open) requestAnimationFrame(()=>slots.update()); });
      sec('keysync',fold);
      slots.add('cloud-backup',slot,el=>root.V7CloudBackup?.open(el,{section:'keys',showBack:false}));
    }

    // ══ 生图服务（闭源模型）══════════════════════════════
    {
      const provider=take(src0,'provider');
      const other=src0.querySelector('[data-provider-other-choice]');
      const conns=src0.querySelector('[data-provider-connections]');
      // 每个服务商的槽位：地址 / Key 各占一整排，协议和鉴权两个一排
      conns?.querySelectorAll('[data-provider-connection-slot]').forEach(slotGrid=>{
        slotGrid.classList.add('cols-2');
        slotGrid.querySelectorAll('[data-setting$="Url"],[data-setting$="Key"]').forEach(input=>wide(input.closest('.settings-field,.settings-row')));
        const quota=slotGrid.querySelector('[data-grs-quota]');if(quota)quota.classList.add('wide');
      });
      // ⭐⭐ 2026-10-15（用户原话：「检查链接这个地方，余额这个地方不应该直接和这个用哪家生图放一块吗？
      //   就这些信息它们太散了」）⇒ 原来的「检查连接」一节【并进这一节】：
      //   选服务商 → 地址 / Key → 紧跟着「检查连接」+ 结果 + 余额（一个流程一屏看完）→ 推荐服务商（折叠）。
      //   ⚠ 右边导航的「检查连接」那一行跟着撤了（SETTINGS_TABS），老路由本来就没有指向它的。
      const test=src0.querySelector('[data-provider-test]'),cancel=src0.querySelector('[data-provider-test-cancel]');
      const testStatus=src0.querySelector('[data-provider-test-status]');
      const balance=src0.querySelector('[data-provider-balance]'),modelnote=src0.querySelector('[data-provider-modelnote]');
      const catalog=src0.querySelector('[data-provider-catalog-host]');
      if(test)test.classList.add('settings-btn-primary');
      const check=document.createElement('div');check.className='provider-check';check.dataset.providerCheckBlock='';
      [actions(test,cancel),testStatus,balance,modelnote].filter(Boolean).forEach(n=>check.append(n));
      // 推荐服务商：低频（选服务商时看一眼）⇒ 折叠，展开时才去读（触发式，不用点"刷新推荐信息"）
      let catalogFold=null;
      if(catalog){
        catalogFold=document.createElement('details');catalogFold.className='settings-fold-lite';catalogFold.dataset.providerCatalogFold='';
        const sum=document.createElement('summary');sum.textContent='推荐的服务商（地址、联系方式、参考价）';
        catalogFold.append(sum,catalog);
        catalogFold.addEventListener('toggle',()=>{ if(catalogFold.open) root.V7ProviderSettings?.ensureCatalog?.(); });
      }
      // ⭐ 2026-10-21（用户要求，照 V6 算力槽位）：给渠道改名、挑露出哪些模型、给模型起显示名 —— 低频 ⇒ 折叠，展开才画。
      //   内容由 ui-main/10-settings-runtime.js 的 computeSlotEditorPaint 画（逻辑在 compute-slots.js）。
      const slotEditor=document.createElement('details');slotEditor.className='settings-fold-lite';slotEditor.dataset.computeSlotEditor='';
      const slotSum=document.createElement('summary');slotSum.textContent='渠道名字和露出的模型（只改显示）';
      const slotBody=document.createElement('div');slotBody.dataset.computeSlotBody='';
      slotEditor.append(slotSum,slotBody);
      slotEditor.addEventListener('toggle',()=>{if(slotEditor.open&&typeof root.computeSlotEditorPaint==='function')root.computeSlotEditorPaint();});
      slotEditor.addEventListener('change',event=>{if(typeof root.computeSlotEditorChange==='function')root.computeSlotEditorChange(event);});
      slotEditor.addEventListener('click',event=>{if(typeof root.computeSlotEditorClick==='function')root.computeSlotEditorClick(event);});
      const psaiMode=src0.querySelector('[data-psai-mode]')?.closest('.settings-field'),psaiAccounts=src0.querySelector('[data-psai-accounts]');
      sec('provider',...(psaiMode?[row(1,wide(psaiMode))]:[]),row(2,provider,other),conns,...(psaiAccounts?[psaiAccounts]:[]),check,slotEditor,
        note('AJI、MOMO 是中转站：地址填它给你的网址（https:// 开头），Key 一般是 sk- 开头。「图像协议」和「鉴权方式」大多数情况保持默认，服务商另有说明时才改。'),
        note('「检查连接」会拉一次模型列表（填进生成卡的模型下拉框）并查一次余额，不发生成请求、不花钱。拉到列表只说明地址和 Key 对；某个模型能不能出图以实际生成为准。'),
        catalogFold);
    }
    sec('imagecompute',row(1,wide(take(src0,'imageComputeSource'))),
      note('自己的 Key：花你在服务商那里充的钱，不扣平台积分。平台积分：要登录，按平台价目扣积分。'));
    sec('lowbalance',row(2,take(src0,'lowBalanceUSD')),
      note('单位跟中转站后台显示的一样（界面写 ¥），填 0 就是不提醒。只对阿吉 / 墨墨这种充值到中转站的有效；GRS 是积分，不按这个算。'));

    // ══ 工作流引擎（开源）═══════════════════════════════
    sec('engine',row(1,wide(take(src0,'workflowSource'))),
      // ⭐ 2026-10-19：「开源模型模式在哪算」原来只在生成卡的算力格里（开着千问模式才出现）—— 设置卡里补回常驻入口
      //   （10-14 设置卡改一列到底时漏搬了这一个；tests/workspaces-ui「每个原有设置都要找得到」一直红在它身上）
      row(1,wide(take(src0,'qwenSource'))),
      note('工作流是 ComfyUI 那一类开源流程。本地 = 跑在你自己电脑上；自己的在线服务 = 你自己租的服务器；平台云算力 = 用平台的显卡，要登录、扣积分。'));
    {
      const url=wide(take(src0,'comfyUrl')),key=wide(take(src0,'comfyKey'));
      const result=document.createElement('p');result.className='settings-status-line';result.setAttribute('role','status');result.textContent='还没检查过。';
      let checking=false;
      const check=btn('检查 ComfyUI 连接',async()=>{
        if(checking)return;checking=true;check.disabled=true;result.textContent='正在检查…';
        try{
          const u=new URL(String(body.querySelector('[data-setting="comfyUrl"]')?.value||''));
          if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('请填写 http:// 或 https:// 开头、不带账号密码的地址');
          u.pathname=u.pathname.replace(/\/$/,'')+'/system_stats';u.search='';u.hash='';
          const k=body.querySelector('[data-setting="comfyKey"]')?.value;const headers=k?{Authorization:'Bearer '+k}:{};
          let response;
          if(root.uiwin?.http?.fetch)response=await root.uiwin.http.fetch({url:u.href,method:'GET',headers,timeoutMs:10000});
          else{const r=await fetch(u.href,{headers,signal:AbortSignal.timeout(10000)});response={ok:r.ok,status:r.status,body:await r.text()};}
          if(!body.isConnected)return;
          if(!response?.ok)throw new Error('连不上'+(response?.status?'（HTTP '+response.status+'）':'')+'：确认 ComfyUI 已经启动、地址和 Key 正确');
          const data=typeof response.body==='string'?JSON.parse(response.body):response.body;
          if(!data||!data.system||!Array.isArray(data.devices))throw new Error('地址能打开，但它不是 ComfyUI');
          result.textContent='连接正常 · '+data.devices.length+' 个计算设备。能不能出图，还要看工作流用到的模型和节点装没装。';
        }catch(error){if(body.isConnected){result.textContent=String(error.message||error);root.ERR?.report('PROVIDER_TEST_FAILED',{message:String(error.message||error)});}}
        finally{checking=false;if(body.isConnected)check.disabled=false;}
      });
      check.classList.add('settings-btn-primary');check.dataset.servicePrimary='';
      const forge=gen.querySelector('[data-forge-comfy-refresh]');
      // ⚠ data-service-page=local：老测试按它读检查结果（这一节以前叫「本地与自有工作流」，页名是 local）
      sec('comfy',row(2,url,key),actions(check,btn('网络体检',()=>root.V7NetworkDoctor?.open()),forge),result,
        note('ComfyUI 装在你自己电脑上时，地址默认是 http://127.0.0.1:8188，没设密码 Key 就留空。'),
        note('「检查内置 Forge→ComfyUI 预设」：看看软件自带的那批工作流预设在你的 ComfyUI 上能不能跑。')).dataset.servicePage='local';
    }
    {
      const rhTest=src0.querySelector('[data-rh-test]'),rhImport=src0.querySelector('[data-rh-import]');
      if(rhImport)rhImport.textContent='从 RunningHub 导入为预设';
      sec('runninghub',row(2,wide(take(src0,'runninghubUrl')),wide(take(src0,'runninghubKey')),take(src0,'rhWorkflowId'),take(src0,'rhWorkflowName')),
        actions(rhTest,rhImport),
        // 2026-10-18 深夜（用户定）：RunningHub 还没接线，这一节整块灰掉（ui.html 的 RUNNINGHUB_OFF 总开关；输入框和按钮在 bindSettingsDetail 里禁用）
        //   ⚠ 判「不是明确接通」而不是「明确关着」：设置卡可能在主脚本给 window.V7_RUNNINGHUB_OFF 赋值之前就画好了
        root.V7_RUNNINGHUB_OFF!==false?(()=>{const p=document.createElement('p');p.className='settings-status-line v7-rh-off-line';p.setAttribute('role','status');p.textContent='⚠ RunningHub 还没接通，这一节暂时不能用。工作流请用「平台云算力」或「本地 ComfyUI」。';return p;})():null,   // ⚠ 不能用 note()：说明会被收进标题旁的「?」里，平时看不见
        note('只有工作流要走你自己的 RunningHub 账号时才需要填。工作流编号在作品链接的最后那串数字；预设名留空就叫「RH 工作流 + 编号」。'));
    }

    // ══ 生成与传回 ═════════════════════════════════════
    {
      const tip=align.querySelector('[data-align-tip]');
      const helps=[...align.querySelectorAll('.ai-help')].filter(n=>!n.hasAttribute('data-align-tip'));
      sec('align',row(2,take(align,'autoAlign'),take(align,'alignMode')),row(1,wide(take(align,'colorMatchMode'))),tip,helps);
    }
    sec('output',row(2,take(gen,'captureMaxEdge'),take(gen,'maxResolution'),take(gen,'autoFullCanvas'),take(gen,'refSquarePad')),
      note('抓图分辨率 = 发给 AI 的图有多大；越大越清楚，但太大会被服务商拒收（4096 多数服务会退回）。2048 是推荐值。'),
      note('出图尺寸 = 让 AI 生成多大的图；4K 更清楚，也更贵、更慢。'),
      note('「没选区就用整张图」：PS 里没框选区时，直接拿整张画布去生成；关掉的话没选区就不让生成。'),
      note('「带参考图时自动补成正方形」：这次带了参考图，就把图 1 和参考图都补成正方形再发（已经是正方形的不动），比例按 1:1 发；AI 出的图会裁回你框的大小再贴回。'));
    {
      const lt=ret.querySelector('[data-setting="layerType"]')?.closest('.settings-field,.settings-row');
      if(!lt)missing.push('layerType');
      sec('return',row(2,take(gen,'autoReturn'),lt),
        note('自动传回：生成完直接贴回 Photoshop；关掉的话要你在任务卡上点「传回」。'),
        note('智能对象：以后能无损缩放、替换内容；普通图层：改起来更直接，但反复缩放会糊。'));
    }
    sec('group',row(2,take(gen,'autoGroup'),take(gen,'soloSwitchDocument'),take(gen,'autoDismissOnStamp'),take(gen,'returnGroupColor')),
      note('自动编组：一次生成的几张图放进同一个组。开着它，鼠标划过任务卡的缩略图，PS 里就只显示那一张；【双击】缩略图会直接跳过去并放大到那一块。'),
      note('跨文档切换：划到的图属于另一个 PS 文档时，自动切过去；关掉的话就不打断你当前的文档。'),
      note('盖印后收起任务卡：你在传回组上方盖印（Ctrl+Shift+Alt+E），就当这个任务用完了，任务卡自动收起，图不会删。需要开着自动编组。'),
      note('组的标注颜色：图层面板里组的颜色。只能选 PS 自带的那几种，「不给颜色」就是不标。'));
    sec('feather',row(2,take(gen,'returnFeather'),take(gen,'returnFeatherShrink'),take(gen,'returnFeatherBlur')),
      note('AI 只改了选区里面，贴回去后边界可能有一条直线接缝。羽化就是把边界做成渐变，让它看不出来。'),
      note('两个百分比都按选区的短边算：选区短边 1200 像素，「往里收 1%」就是 12 像素。接缝还看得见就调大一点。'));
    // ⚠ 2026-10-15：加了「音效音量」（三个位共用一个）⇒ 总开关+音量一行、三个音效一行。
    sec('sound',row(2,take(gen,'soundEnabled'),take(gen,'soundVolume')),row(3,take(gen,'soundSuccess'),take(gen,'soundAllFail'),take(gen,'soundSingleFail')),
      note('默认关。打开后：全部成功 / 全部失败 / 有成有败，分别响对应的声音；选「无」就是那种情况不响。'),
      note('选了音效会马上放一遍给你听；音量三个共用，拖完松手也会放一遍听听多大声。'));

    // ══ 外观 ══════════════════════════════════════════
    // ⭐ 2026-10-18 深夜：界面大小（整个软件 + 窗口一起缩，这台电脑的设置；内容由 ui-scale.js 画）
    {
      const slot=document.createElement('div');
      sec('scale',slot);
      if(root.V7UiScale)retain(body,root.V7UiScale.mountSettings(slot));
      else slot.textContent='这一份软件没有界面缩放。';
    }
    // 2026-10-22（docs/263 第 19 条）：「统一深色底」开关删了（默认就是统一中性底，颜色交给上面的「卡片底色」）
    sec('theme',row(3,take(src2,'themeCardBg'),take(src2,'themeText'),take(src2,'themeAccent')),
      row(2,take(src2,'themeAutoContrast')),
      note('三个颜色一次改全部卡片，点「默认」回到原来的配色。主题色 = 按钮、滑条、进度条的颜色；卡片边缘那几道光不受它影响。'),
      note('浅底自动深字：你选了浅色底，文字自动变黑；你自己指定了文字颜色时就听你的。'));
    sec('display',row(2,take(src2,'blur'),take(src2,'opacity'),take(src2,'bgQuality')),row(2,take(src2,'reduceMotion')),
      note('毛玻璃：卡片后面的背景模糊多少，0 = 不模糊。不透明度：卡片底色有多实，调低能透出背景图。'),
      note('减少动画：卡片展开、切换、悬停都变成一下到位，转圈和扫光这类一直动的也停下。电脑卡或者看着晕时打开。'),
      note('背景清晰度只影响之后导入的背景图，已经导入的不会自动重压；X4 最清楚，也最占内存。'));
    {
      const fb=document.createElement('div');
      sec('bars',fb);
      if(root.V7FloatingBars)retain(body,root.V7FloatingBars.mountSettings(fb));
    }
    {
      const slot=document.createElement('div');slot.setAttribute('data-layout-section','');slot.setAttribute('data-layout-restore','');
      sec('layout',slot);
      slots.add('layout-manager',slot,el=>root.V7LayoutManager?.mount(el));
    }

    // ══ 操作 ══════════════════════════════════════════
    sec('freemode',row(2,take(src2,'freeMode')),
      note('开启后，每张主卡、整叠任务卡和整叠报错卡都能单独拖动摆放；二三级面板跟着它的主卡走。只在当前显示器范围内摆放。'),
      note('卡住了想退出：按 Ctrl+Alt+Shift+F12。'));
    sec('interaction',row(2,take(src2,'presetFlipNotches'),take(src2,'hoverOpensPreview')),row(2,take(src2,'topmostFollowPs')),
      note('只在用 Photoshop 时置顶：正在用 PS、或者正在点轮椅时，轮椅压在最前面；切到浏览器、微信这些别的软件，轮椅就退到它们后面，切回 PS 又自动出来。退到后面时点任务栏 / 托盘图标，或按「一键收起展开」快捷键就能叫回来。关掉 = 一直压在最前面。'),
      note('悬停弹大图：鼠标停在任务卡缩略图上就自动弹出上方的大预览框；关掉后要点一下缩略图才弹。'),
      note('换卡格数：预设列表滚到头之后，要连续滚够这么多格才会换到下一张主卡。数字越大越不容易误触，默认 10。'));
    // ⭐ 2026-10-17 夜：加第三个「一键收起 / 展开」（用户要放在开始计算、加参考图旁边）
    sec('shortcuts',row(2,take(src2,'generationShortcut'),take(src2,'referenceShortcut')),row(2,take(src2,'collapseShortcut'),take(src2,'providerShortcut')),
      note('录快捷键：点一下输入框，再按下你想要的组合键就录好了。开始生成 = 直接开始算；加参考图 = 把 PS 里当前框选的那块加进参考图；一键收起 / 展开 = 同一个键按一下收起、再按一下展开（自由摆放时是所有卡组一起折叠 / 展开）；换下一家渠道 = 按「渠道顺序」换到下一家服务商（顺序在「你在用哪家生图」→ 渠道名字那一块里调）。'));

    // ══ 存储与备份 ═════════════════════════════════════
    sec('checkpoint',row(2,take(src1,'checkpointEnabled'),take(src1,'checkpointIntervalMin')),
      note('默认关。开启后，每张照片隔一段时间，在下一次生成前存一份完整画布 PNG；不含图层，不会自动恢复。保存的文件夹在「记录与恢复」卡里能打开。'),
      note('画布很大时，存检查点会多等一会儿，也更占硬盘。'));
    {
      const cache=src3.querySelector('[data-cache-settings]')||document.createElement('div');
      sec('cache',row(2,take(src1,'cacheCapacityGB')),cache,
        note('缓存 = 每次生成留下的图。攒满上限后，最旧的先被清掉；按账号分开算。'));
      slots.add('cache',cache,el=>host.mountCache?host.mountCache(el):null,{keep:true});
    }
    {
      const slot=document.createElement('div');slot.setAttribute('data-account-backup','');
      sec('backup',slot);
      slots.add('cloud-backup',slot,el=>root.V7CloudBackup?.open(el,{section:'backup',showBack:false}));
    }
    {
      const slot=document.createElement('div');
      sec('autobackup',slot);
      slots.add('cloud-backup',slot,el=>root.V7CloudBackup?.open(el,{section:'preferences',showBack:false}));
    }
    {
      const save=btn('保存设置',null,{'data-settings-save':''});
      const reset_=btn('恢复默认设置',null,{'data-settings-reset':''});reset_.classList.add('danger');
      sec('reset',actions(save,reset_),
        note('恢复默认只影响当前账号的设置，会重新加载界面。预设、图片、历史记录和其他账号都不受影响。'));
    }

    // ══ 助手与隐私 ═════════════════════════════════════
    {
      const a=document.createElement('div'),p=document.createElement('div'),r=document.createElement('div');
      r.setAttribute('data-software-recovery','');
      sec('assistant',a);sec('permissions',p);sec('recovery',r);
      slots.add('assistant-panel',a,el=>root.V7AssistantPanel?.mountSection(el,'connection'));
      slots.add('assistant-panel',p,el=>root.V7AssistantPanel?.mountSection(el,'permissions'));
      slots.add('assistant-panel',r,el=>root.V7AssistantPanel?.mountSection(el,'recovery'));
    }
    {
      // ⚠ 遥测开关是裸 checkbox（没有 data-setting，存自己的键），必须手工建。
      //   绑定在 bindSettingsDetail 里（按 [data-telemetry-toggle] 找）。
      const t=document.createElement('div');t.className='settings-grid cols-2';
      t.innerHTML='<div class="settings-row"><label class="tgl"><span class="tgl-label">发送匿名使用与报错信息</span>'
        +'<input type="checkbox" data-telemetry-toggle '+((root.V7Telemetry?root.V7Telemetry.enabled():true)?'checked':'')+'>'
        +'<span class="tgl-track"><span class="tgl-dot"></span></span></label></div>';
      sec('telemetry',t,
        note('用来知道大家卡在哪一步、哪个功能真被用到。绝不上传：提示词、文件名和路径、图片、任何 Key 或密码、邮箱手机号。'),
        note('报错里的中文和路径会先在你电脑上抹掉再发出去。关掉后连启动记录都不发，不影响任何功能。'));
    }

    // ══ 软件与服务 ═════════════════════════════════════
    {
      const slot=document.createElement('div');
      sec('photoshop',slot);
      slots.add('setup',slot,el=>root.V7Setup?.mount(el),{keep:true});
    }
    {
      const s=document.createElement('div'),n=document.createElement('div');
      // ⚠⚠ 2026-10-14：公告那一节【搬到最上面】了（用户定：公告区放到设置的最顶栏）。
      //   sec() 是按调用顺序 append 的 ⇒ 它的 sec('notices') 已经在下面被搬走了，
      //   这里只留客服记录。搬家理由见下面 "公告与状态" 那一段的注释。
      sec('support',s);
      slots.add('account-center',s,el=>root.V7AccountCenter?.mount(el,'support'));
    }
    {
      // ⚠ 社区地址【滚到这一节才去拉】—— 设置页启动时就会画一次，
      //   一画就发请求的话，没登录、没看社区的人也会白白打一次后台（account-center 测试抓到）。
      const slot=document.createElement('div');
      sec('community',slot);
      slots.add('community',slot,el=>{
        const noteEl=document.createElement('p');noteEl.className='settings-status-line';noteEl.setAttribute('role','status');noteEl.textContent='正在读取社区地址…';
        let url='';
        const open=btn('打开社区网页',async()=>{
          if(!url)return;open.disabled=true;
          // ⭐ 2026-10-19：先要进门条子再开（openCommunity），网页只认从软件拉起
          const result=await openCommunity(url);
          noteEl.textContent=result.message;
          open.disabled=!url;
        });
        open.classList.add('settings-btn-primary');open.disabled=true;
        const acts=actions(open);acts.classList.add('settings-actions');
        el.append(acts,noteEl);
        (async()=>{
          try{
            if(typeof root.V7Backend?.publicCommunity!=='function'){noteEl.textContent='当前版本读不到社区地址。';return;}
            const info=await root.V7Backend.publicCommunity();
            if(!el.isConnected)return;
            const u=String(info&&info.url||'').trim();
            if(!/^https?:\/\/[^/\s]+/i.test(u)){noteEl.textContent='社区网页还没开放。等平台把地址配好，这里就能点了。';return;}
            url=u;open.disabled=false;noteEl.textContent=(info&&info.note)?String(info.note):('会在默认浏览器里打开：'+u);
          }catch(error){if(el.isConnected)noteEl.textContent='读社区地址失败：'+String(error&&error.message||error).slice(0,60);}
        })();
      },{keep:true});
    }

    {
      // ⭐ 2026-10-16「关于软件」（用户：设置里加上关于软件，写上现在的版本号；前端后端 UXP 全部同步）
      //   版本号只有一个来源：ui-pure/version.js（scripts/sync-version.cjs 六处一起改）。
      //   后台版本是【现问】线上 /health 拿的，不是写死的 —— 两边对不上一眼就看得出来。
      //   「复制诊断信息」给测试的人报问题用；里面是版本、状态和最近 20 条报错 / 警告（像 Key 的长串打码），没有密码 / Key。
      const slot=document.createElement('div');
      sec('about',slot);
      slots.add('about',slot,el=>{
        const rows=document.createElement('div');rows.className='settings-about-rows';rows.setAttribute('data-about-rows','');
        const note=document.createElement('p');note.className='settings-status-line';note.setAttribute('role','status');
        let backend=null,text='';
        const row=(k,v)=>'<div class="settings-about-row"><span class="settings-about-key">'+k+'</span><span class="settings-about-val">'+v+'</span></div>';
        const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
        const paint=()=>{
          const i=root.V7AboutInfo?root.V7AboutInfo():{};
          const lines=[];
          const appLine=esc(i.app)+(i.channel?'（'+esc(i.channel)+(i.date?' · '+esc(i.date):'')+'）':'');
          const uxp=i.uxpConnected?('已连接'+(i.uxpBackground?' · PS 在后台（PS 放后台时插件问话变慢，切回 PS 就正常）':'')+' · '+esc(i.uxpVersion||'版本未知')+(i.uxpVersion&&i.uxpVersion!==i.app?' ⚠ 跟软件版本不一样：到「Photoshop 联动」点修复安装':'')):'没连上（在 PS 里打开轮椅插件面板就会连）';
          const back=backend===null?'正在问…':backend===false?'连不上':('线上 '+esc(backend.version||'?')+'（指纹 '+esc(String(backend.build||'').slice(0,12))+'）');
          const eng=i.engine?(i.engine.available?('在运行'+(i.engine.device?' · '+esc(i.engine.device):'')):'没在运行（用到时自动启动，空闲 10 分钟自动关）'):'没装（精简包没带引擎）';
          let qwen='';
          if(i.qwen&&i.qwen.limits){const l=i.qwen.limits;qwen='一次最多 '+(l.maxBatch||'不限')+' 张 · 同时 '+(l.concurrent||1)+' 张'+(l.student?' · 学员':l.admin?' · 管理员':'');}
          rows.innerHTML=row('软件版本',appLine)+row('PS 插件',uxp)+row('后台',esc(i.backendUrl||'未设置')+' · '+back)
            +row('账号',i.signedIn?esc(i.account||'已登录'):'没登录')+row('本机引擎',eng)+(qwen?row('云端开源模型',qwen):'')
            +row('界面内存',esc(i.memory||'读不到'))
            // 2026-10-18 在线更新那一行（ui-pure/app-update.js）
            +row('软件更新',esc(root.V7AppUpdate?root.V7AppUpdate.describe():'没加载'));
          lines.push('软件 '+(i.app||'?')+' '+(i.channel||'')+' '+(i.date||''),'PS 插件 '+(i.uxpConnected?(i.uxpVersion||'已连接'):'没连上'),
            '后台 '+(i.backendUrl||'')+' '+(backend?('线上 '+backend.version+' '+backend.build):backend===false?'连不上':'未知'),
            '登录 '+(i.signedIn?'是':'否'),'引擎 '+(i.engine?JSON.stringify(i.engine):'没装'),'开源模型 '+(i.qwen?JSON.stringify(i.qwen):'无'),
            '任务数 '+i.tasks,'界面内存 '+(i.memory||''),'更新 '+(root.V7AppUpdate?root.V7AppUpdate.describe():'没加载'),'系统 '+(i.ua||''),'时间 '+new Date().toString());
          const probs=Array.isArray(i.problems)?i.problems:[];
          lines.push('—— 最近的报错 / 警告（'+(probs.length?probs.length+' 种，一样的合并了，最新的在最后':'没有')+'）——');
          probs.forEach(p=>lines.push((p.at||'').replace('T',' ').slice(0,19)+' ['+(p.level==='error'?'错误':'警告')+(p.from?' · '+p.from:'')+'] '+p.message+(p.count>1?'（×'+p.count+'）':'')));
          text=lines.join('\n');
        };
        const copy=btn('复制诊断信息',async()=>{
          paint();
          let ok=false;
          try{await navigator.clipboard.writeText(text);ok=true;}catch(_){ok=false;}
          if(!ok){try{const ta=document.createElement('textarea');ta.value=text;document.body.append(ta);ta.select();ok=document.execCommand('copy');ta.remove();}catch(_){ok=false;}}
          note.textContent=ok?'已复制。报问题时直接粘贴给客服（里面没有密码和 Key）。':'没能自动复制 —— 下面这段手动选中复制：\n'+text;
        });
        copy.classList.add('settings-btn-primary');
        // 2026-10-18「检查更新」：手动查一次，失败会弹卡说原因；有新版就后台下载，下好了弹「现在安装」
        const checkUpdate=btn('检查更新',async()=>{
          if(!root.V7AppUpdate){note.textContent='这一份没有在线更新。';return;}
          note.textContent='正在检查更新…';
          const s=await root.V7AppUpdate.check(true);
          paint();
          note.textContent=root.V7AppUpdate.describe()+(s&&s.phase==='downloading'?'。下好了会弹卡问你要不要安装。':'');
        });
        // 2026-10-18 新手教程的常驻入口（一次性引导必须留常驻入口：跳过了也能从这里回来，还能挑章节）
        const tutorialLeft=(()=>{try{return root.V7TutorialLauncher?root.V7TutorialLauncher.pending().length:0;}catch(_){return 0;}})();
        const tutorial=btn(tutorialLeft?('重新看教程（还有 '+tutorialLeft+' 章没看）'):'重新看教程',async()=>{
          if(!root.V7TutorialLauncher){note.textContent='这一份没有新手教程。';return;}
          const r=await root.V7TutorialLauncher.open('');
          note.textContent=r&&r.ok===false?('教程没打开：'+(r.error||'未知原因')):'教程已打开（全屏）。随时点右上角「跳过教程」或按 Esc 退出。';
        });
        const acts=actions(copy,checkUpdate,tutorial);acts.classList.add('settings-actions');
        // 2026-10-18 用到的模型（用户：「我们使用了哪些模型需要在关于软件里面详细的列出来」；清单在 ui-pure/model-credits.js）
        const credits=document.createElement('details');credits.className='settings-about-models';
        const mc=root.V7ModelCredits;
        if(mc&&Array.isArray(mc.list)){
          const groups=[...new Set(mc.list.map(m=>m.group))];
          credits.innerHTML='<summary>用到的模型（'+mc.list.length+' 个）与许可证</summary>'
            +groups.map(g=>'<div class="settings-about-key" style="margin-top:8px">'+esc(g)+'</div>'
              +mc.list.filter(m=>m.group===g).map(m=>'<div class="settings-about-row"><span class="settings-about-key">'+esc(m.name)+'</span><span class="settings-about-val">'
                +esc(m.use)+' · '+esc(m.where)+' · '+esc(m.by)+'<br>许可证：'+esc(m.license)+(m.nonCommercial?' ⚠ 非商业':'')+(m.url?'<br><span style="opacity:0.75">'+esc(m.url)+'</span>':'')+'</span></div>').join('')).join('')
            +'<p class="settings-status-line">'+esc(mc.note)+'</p>';
        }else credits.hidden=true;
        el.append(rows,acts,note,credits);
        paint();
        (async()=>{
          const h=typeof root.V7Backend?.publicHealth==='function'?await root.V7Backend.publicHealth():null;
          if(!el.isConnected)return;
          backend=h&&h.ok?h:false;paint();
        })();
      },{keep:true});
    }

    // ⚠ 老入口按钮（data-setup-open / data-account-center / data-community-nav）
    //   现在都有对应的小节了，界面上不再显示；节点【藏起来但不删】——
    //   老测试和 bindSettingsDetail 里的 accountAction 还在找它们（找不到不报错，但留着更稳）。
    {
      const legacy=src0.querySelector('[data-setup-open]')?.closest('.settings-actions');
      if(legacy){legacy.hidden=true;legacy.dataset.legacyServiceEntries='';list.append(legacy);}
    }

    if(missing.length)console.warn('[设置卡] 这些控件在标记源里没找到，界面上不会出现：',missing.join(', '));
    bind(body);
    guardReset(body);
    slots.start();
    // ⭐⭐ 云功能闸门（2026-10-14）：画完立刻上一次锁，并跟着登录状态变。
    //   ⚠ 必须放在 slots.start() 之后 —— 那些"懒挂载"的模块（账单/云备份）
    //     是 start() 才把内容填进去的，早于它就锁了个空壳。
    applyCloudGate();
    // 登录/退出、切账号都会发 wheelchair:storage-context（项目里统一用这个事件）
    const onContext=()=>{ try{ applyCloudGate(); }catch(error){ if(window.ERR) ERR.report('SETTINGS_OPERATION_FAILED',{message:'云功能闸门：'+String(error&&error.message||error)}); } };
    window.addEventListener('wheelchair:storage-context',onContext);
    retain(body,()=>window.removeEventListener('wheelchair:storage-context',onContext));
    retain(body,()=>slots.dispose());
    return ()=>dispose(body);
  }
  /* ⭐ 单例模块的挂载调度（2026-10-14）。
     账单中心 / 云备份 / 助手面板 这几个模块内部只记【一个】挂载点，
     同时挂两份时后挂的会把先挂的顶掉（或者先挂的那份变成不再更新的死界面）。
     ⇒ 同一个 key 的几节里，【当前露出最多的那一节】才挂真模块；
       离开的那一节保住原高度（不让下面的内容跳），显示一句占位。
     ⚠ keep:true = 只有一节、挂上就不卸（省得反复建）。 */
  function moduleSlots(scroller){
    const groups=new Map();let raf=0,started=false;
    const idle=el=>{if(el.querySelector(':scope > .slot-idle'))return;const p=document.createElement('p');p.className='slot-idle';p.textContent='滚到这里就会显示 …';el.append(p);};
    function add(key,el,mount,opts){
      if(!groups.has(key))groups.set(key,{slots:[],owner:null,dispose:null});
      const g=groups.get(key);g.slots.push({el,mount,keep:!!(opts&&opts.keep)});
      el.classList.add('module-slot');idle(el);
    }
    function visible(el){
      const a=el.getBoundingClientRect(),b=scroller.getBoundingClientRect();
      return Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    }
    // ⭐ 挂上模块后这一块会变高。如果它在【视野中线以上】（用户看的是它下面的东西），
    //   就把滚动位置往下补同样的量 —— 正在看的内容不动（跟浏览器的"滚动锚定"同一个意思）。
    //   如果用户正看着它本身（它跨过中线），就让它照常往下长。
    //   ⚠ 不补的后果（测试抓到的）：自由摆放开关上面那节「布局与恢复」一挂就把开关推走，点空。
    //   ⚠ 模块内容常常是异步长出来的（读账单、读备份信息）—— 挂上后再跟一小会儿高度变化。
    // ⭐⭐ 判断标准（2026-10-14 量出来后改的）：
    //   · 用户是点导航进这一节的（navigated=true）→ 他要看的就是它 → 照常往下长，不补
    //   · 这一块下面还有【能看见的内容】→ 用户看的是下面那些 → 补滚动，让下面不动
    //   · 这一块是从屏幕底部冒出来的（下面没有可见内容）→ 往下长不影响谁 → 不补
    //   ⚠ 原来用"在不在中线以上"判，实测那块正好跨中线就不补，开关被推下去 551px、点空。
    function anchorWhile(el,run,navigated){
      const b=scroller.getBoundingClientRect();
      const keep=!navigated&&el.getBoundingClientRect().bottom<b.bottom-40;
      let last=el.offsetHeight;
      // ⚠ 要不要补【挂之前判断一次就定死】：长高之后它自然会越过中线，再判一次就永远不补了（踩过）。
      const fix=()=>{const h=el.offsetHeight;if(keep&&h!==last)scroller.scrollTop+=h-last;last=h;};
      run();fix();
      if(keep&&typeof ResizeObserver!=='undefined'){const ro=new ResizeObserver(fix);ro.observe(el);setTimeout(()=>ro.disconnect(),1500);}
    }
    function activate(g,slot,navigated){
      if(g.owner===slot)return;
      if(g.owner){
        const old=g.owner,h=old.el.offsetHeight;
        try{typeof g.dispose==='function'?g.dispose():g.dispose?.dispose?.();}catch(error){host.error?.(error);}
        old.el.replaceChildren();old.el.style.minHeight=h+'px';idle(old.el);
      }
      g.owner=slot;g.dispose=null;
      anchorWhile(slot.el,()=>{
        slot.el.replaceChildren();slot.el.style.minHeight='';
        try{g.dispose=slot.mount(slot.el)||null;}catch(error){host.error?.(error);slot.el.textContent='这一块没加载起来：'+String(error&&error.message||error);}
        helpify(slot.el);
      },navigated);
    }
    function update(){
      raf=0;if(!scroller.isConnected)return;
      // ⚠ 优先挂到【导航当前停在的那一节】：点导航跳到最底下的「公告与状态」时，
      //   页面滚不到让它顶到最上面，上面的「客服记录」露出得更多 —— 只看露出多少，
      //   模块就会挂错节（account-center 测试抓到：点公告，显示的是工单）。
      const zone=scroller.closest('#settingsZone');
      const want=zone?zone.dataset.settingsTab:'';
      for(const g of groups.values()){
        let best=null,max=0;
        for(const s of g.slots){
          const v=visible(s.el);
          if(v>0&&want&&s.el.closest('[data-sec-anchor]')?.dataset.secAnchor===want){best=s;max=Infinity;break;}
          if(v>max){max=v;best=s;}
        }
        // max===Infinity = 这一块就是导航当前那一节（用户点进来的 / 正停在它上面）→ 不补滚动
        if(best&&max>0&&(!g.owner||!g.owner.keep||g.owner===best))activate(g,best,max===Infinity);
      }
    }
    const onScroll=()=>{if(!raf)raf=requestAnimationFrame(update);};
    // 点导航时如果目标已经在视野里，页面不会滚（没有 scroll 事件）—— 盯住导航当前项的变化也触发一次。
    let watch=null;
    function start(){
      if(started)return;started=true;
      scroller.addEventListener('scroll',onScroll,{passive:true});
      const zone=scroller.closest('#settingsZone');
      if(zone&&typeof MutationObserver!=='undefined'){watch=new MutationObserver(onScroll);watch.observe(zone,{attributes:true,attributeFilter:['data-settings-tab','class','style']});}
      requestAnimationFrame(()=>requestAnimationFrame(update));
    }
    function dispose(){
      scroller.removeEventListener('scroll',onScroll);if(raf)cancelAnimationFrame(raf);watch?.disconnect();
      for(const g of groups.values()){try{typeof g.dispose==='function'?g.dispose():g.dispose?.dispose?.();}catch(_){}g.owner=null;g.dispose=null;}
    }
    return {add,start,update,dispose};
  }
  /* ⭐ 设置卡大二级（2026-10-01）：按【页签】出内容，给 ui-pure/settings-card.js 调。
     ⚠ 每个页自己负责 reset + 建结构；卡片那边每次切页给的是一个空的 body。
     ⚠ 页签 id 与 settings-card.js 的 tabs 表一一对应，改一边必须改另一边。 */
  function settingsTab(body,tab,requestedSection){
    body.dataset.requestedSection=requestedSection || '';
    if(tab==='credits'){body.dataset.settingsTab='credits';return root.V7AccountCenter?.mount(body,'billing');}
    if(tab==='service'){body.dataset.settingsTab='service';return root.V7AccountCenter?.mount(body,'service');}
    // ⭐⭐ 2026-10-05：对齐与校色（用户定"只放在设置卡里"）。
    //   ⚠ 内容仍然出自 ui.html 的 enginesCapSettingsHtml('align') —— 单一真源，
    //     外挂卡那边已删掉这段、只留一个跳过来的入口。别再往这边抄一份控件。
    if(tab==='render'){
      // ⚠⚠⚠ 这一行【必须有】：不加的话上一张卡的内容会留在 #dcBody 里（实测踩过）。
      reset(body);
      body.dataset.settingsTab='render';
      // ⭐⭐⭐ 2026-10-14（用户定「生成卡二三级不该残留任何设置」）：
      //   生成卡第 4 格原来那 5 组折叠【整批搬来这一页】，并且折叠改成直铺小标题。
      //   ⚠ id 仍然是 'render' —— 十几处路由引用，改了会静默落回第一页。
      //   ⚠⚠ 控件仍是【同一份源】：generationMarkup() / alignSettingsMarkup() /
      //     returnSettingsMarkup()（都在 ui.html）。这里只做归位，不重写控件 ——
      //     另写一份就是"两份控件两份仓库"（铁律 16 的来源）。
      const from=document.createElement('div');
      from.innerHTML=(typeof host.generationMarkup==='function')?host.generationMarkup():'';
      const src=from.querySelector('.settings-section')||from;
      const takeGrid=keys=>{const grid=document.createElement('div');grid.className='settings-grid';
        for(const key of keys){const field=takeField(src,key);if(field)grid.append(field);}
        return grid;};
      // 说明按内容归位：编组/盖印/标注色 → 编组；羽化/接缝 → 羽化；其余 → 输出行为。
      const allNotes=[...src.querySelectorAll('.settings-note')];
      const notesFor=re=>allNotes.filter(n=>re.test(n.textContent||''));
      const outputNotes=allNotes.filter(n=>!/编组|盖印|羽化|接缝|音效|标注色/.test(n.textContent||''));

      // ① 对齐与校色（源 = host.alignSettingsMarkup，单一真源）
      const alignSec=section('对齐与校色',null,'align');
      {
        const wrap=document.createElement('div');
        wrap.innerHTML=(typeof host.alignSettingsMarkup==='function')?host.alignSettingsMarkup():'';
        const grid=document.createElement('div');grid.className='settings-grid';
        for(const key of ['autoAlign','alignMode','colorMatchMode']){
          const node=wrap.querySelector('[data-setting="'+key+'"]');
          const field=node?.closest('.settings-field,.settings-row');
          if(field)grid.append(field);
        }
        if(grid.childElementCount)alignSec.append(grid);
        // ⚠ 对齐那段 tip 是动态刷新的（updateAlignTip 按 data-align-tip 找），必须带上。
        const tip=wrap.querySelector('[data-align-tip]');if(tip)alignSec.append(tip);
        [...wrap.querySelectorAll('.ai-help')].forEach(node=>{
          if(!node.hasAttribute('data-align-tip'))alignSec.append(node);
        });
      }

      // ② 输出行为
      const outputSec=section('输出行为',null,'output');
      outputSec.append(takeGrid(['captureMaxEdge','maxResolution','autoReturn','autoFullCanvas','refSquarePad']));
      outputNotes.forEach(n=>outputSec.append(n));
      const forge=src.querySelector('[data-forge-comfy-refresh]');
      if(forge){const acts=document.createElement('div');acts.className='settings-actions';acts.append(forge);outputSec.append(acts);}

      // ③ 传回图层 —— ⚠ 这一项在 generationMarkup 和 returnSettingsMarkup 里【各有一份】，
      //   这里【只取 returnSettingsMarkup 那一份】，生成卡那份不搬（避免两份同名控件）。
      const retSec=section('传回图层',null,'return');
      {
        const wrap=document.createElement('div');
        wrap.innerHTML=(typeof host.returnSettingsMarkup==='function')?host.returnSettingsMarkup():'';
        const grid=document.createElement('div');grid.className='settings-grid';
        const node=wrap.querySelector('[data-setting="layerType"]');
        const field=node?.closest('.settings-field,.settings-row');
        if(field)grid.append(field);
        if(grid.childElementCount)retSec.append(grid);
        [...wrap.querySelectorAll('.ai-help,.settings-note')].forEach(n=>retSec.append(n));
      }

      // ④ 编组 —— ⚠⚠ soloFocusRegion（联动时聚焦图层位置）【已删】：
      //   用户定改成【双击缩略图】直接跳过去并缩放填满，不再占一个开关。
      const groupSec=section('编组',null,'group');
      groupSec.append(takeGrid(['autoGroup','returnGroupColor','soloSwitchDocument','autoDismissOnStamp']));
      notesFor(/编组|盖印|标注色/).forEach(n=>groupSec.append(n));

      // ⑤ 羽化
      const featherSec=section('羽化',null,'feather');
      featherSec.append(takeGrid(['returnFeather','returnFeatherShrink','returnFeatherBlur']));
      notesFor(/羽化|接缝/).forEach(n=>featherSec.append(n));

      // ⑥ 完成音效
      const soundSec=section('完成音效',null,'sound');
      soundSec.append(takeGrid(['soundEnabled','soundVolume','soundSuccess','soundAllFail','soundSingleFail']));
      notesFor(/音效/).forEach(n=>soundSec.append(n));

      body.append(alignSec,outputSec,retSec,groupSec,featherSec,soundSec);
      // ⚠ 必须 bind：这些控件不绑就是死控件（改了不生效 = 铁律 16 那种假开关）。
      bind(body);
      if(typeof host.alignSettingsBind==='function')host.alignSettingsBind(body);
      return null;
    }
    const zone=tab==='account'?0:tab==='appear'?2:tab==='tools'?3:-1;
    if(zone<0)return null;
    body.dataset.settingsTab=tab;
    settings(body,zone);
    return null;
  }
  function settings(body,zone){
    reset(body);const out=panel(body,zone);
    if(zone===0){mountServices(body,out);return;}
    if(zone===1){defaults(body,out);return;}
    if(zone===3){storage(body,out);return;}
    const appearance=source(2);
    if(zone===2){
      // ⭐⭐ 2026-10-14 重排：外观与交互 4 组折叠 → 直铺小标题。
      //   折叠头删掉，内容直接铺在页面里；右边导航条扫 [data-sec-anchor] 自动建小节列表。
      //   ⚠ [data-setting] 全留在 DOM 里，卡面回填照常（§三-1）。
      //   ⚠ 加控件时两边必须成对改：fields() 名单 + legacySettingsMarkup 里的控件。
      //     漏名单 → 控件不出现；漏 markup → fields() 抛错。
      const themeBody=fields(appearance,['themeCardBg','themeText','themeAccent','themeAutoContrast']);
      const themeHelp=takeHelp(appearance,'theme');if(themeHelp)themeBody.append(themeHelp);
      const theme=section('主题',null,'theme');theme.append(themeBody);

      const displayBody=fields(appearance,['blur','opacity','bgQuality','reduceMotion']);
      const bgQualityHelp=takeHelp(appearance,'bgQuality');if(bgQualityHelp)displayBody.append(bgQualityHelp);
      const display=section('显示',null,'display');display.append(displayBody);

      // 交互：自由摆放 + 滑动格数 + 快捷键 + 缩略图预览
      const interactionBody=fields(appearance,['freeMode','presetFlipNotches','generationShortcut','referenceShortcut','collapseShortcut','providerShortcut','hoverOpensPreview','topmostFollowPs']);
      const freeHelp=takeHelp(appearance,'freeMode');if(freeHelp)interactionBody.append(freeHelp);
      interactionBody.append(Object.assign(document.createElement('p'),{className:'settings-note',
        textContent:'预设列表滚到边缘后要连续滚够设定格数才换主卡。'
          +'两个快捷键都点输入框后按下组合键录入：'
          +'「开始计算」＝直接开始生成；「加参考图」＝抓 Photoshop 当前选区加进参考图（先在 PS 里框选一块）。'}));
      const interaction=section('交互',null,'interaction');interaction.append(interactionBody);

      // 布局：懒挂载改 IntersectionObserver —— 不再依赖折叠展开，可见就建。
      // ⚠ 量高度必须在元素可见时进行（V7FloatingBars / V7LayoutManager 内部会 getBoundingClientRect）。
      const layoutBody=document.createElement('div');layoutBody.className='settings-fold-stack';
      layoutBody.dataset.layoutSection='';
      const layout=section('布局',null,'layout');layout.append(layoutBody);
      let layoutMounted=false;
      const ensureLayout=()=>{
        if(layoutMounted)return;
        layoutMounted=true;
        if(root.V7FloatingBars)retain(body,root.V7FloatingBars.mountSettings(layoutBody));
        retain(body,root.V7LayoutManager.mount(layoutBody));
      };
      // 用 IntersectionObserver 代替"展开才挂"——滚到可见区域就挂载。
      if(typeof IntersectionObserver!=='undefined'){
        const obs=new IntersectionObserver(entries=>{
          if(entries.some(e=>e.isIntersecting)){obs.disconnect();ensureLayout();}
        },{threshold:0.01});
        obs.observe(layout);
        retain(body,()=>obs.disconnect());
      }else{
        ensureLayout();
      }

      out.append(theme,display,interaction,layout);
    }
    bind(body);
    guardReset(body);
  }
  function mountServices(body,out){
    out.innerHTML=host.settingsMarkup(0);const inner=out.firstElementChild;out.replaceWith(inner);
    const footer=document.createElement('div');footer.className='service-inline-footer';const state=document.createElement('span');state.setAttribute('role','status');footer.append(state);
    const handle={body,footer,state};host.bindSettings(body);root.V7Workspaces.arrangeServices(handle);
    const content=body.querySelector('.v7-workspace-content');
    // ⚠⚠⚠ 2026-10-08 修（实拍发现：底部那行小字"连接信息修改后自动保存在本机…"看着压在"助手 API"上）：
    //   原来 footer 是 body.append() —— 挂在【body】上，而四节折叠与「更多服务」宫格都住在
    //   .v7-workspace-content 里面。footer 不在内容流里，位置就靠不住（截图里它跟着内容往上跑）。
    //   ⚠ 尺子的教训：我一开始是从截图上判"重叠"的，量出来 box 其实【不重叠】——
    //     真实毛病是"它没排在内容流末尾"，只是看起来像压住。
    //   ⚠⚠ 挂的时机：必须等「更多服务」那些块都建完再挂（本函数末尾），
    //     在这里（内容还没建）挂的话它会跑到"更多服务"【上面】去 —— 我第一版就挂早了。
    if(!content){body.append(footer);helpify(body);return;}
    // ⭐⭐ 2026-10-06 docs/150 §6.1（Phase C）：连接与账号首屏瘦身。
    //   四节（账号 / 平台算力 / 自有服务 / 本地工作流）收成折叠：
    //     账号默认展开（唯一）；其余三节收起，头上一句话摘要。
    //   ⚠ 隐藏不移除：原 section 的孩子【原样搬进折叠体】，
    //     data-service-tab / data-service-page / data-sec-anchor / id 全留（§三-1/5）。
    var foldables=Array.prototype.slice.call(content.querySelectorAll(':scope > .settings-section')).filter(function(sec){return !!sec.dataset.secAnchor;});
    var fieldValue=function(sec,key){var el=sec&&sec.querySelector('[data-setting="'+key+'"]');return el?String(el.value||''):'';};
    var secOf=function(anchor){for(var i=0;i<foldables.length;i++)if(foldables[i].dataset.secAnchor===anchor)return foldables[i];return null;};
    var platformSec=secOf('platform'),ownSec=secOf('own'),localSec=secOf('local');
    var notes={
      account:'',
      platform:fieldValue(platformSec,'imageComputeSource')==='platform'?'图像走平台算力':'图像走自己的服务',
      own:(function(){
        var sel=ownSec&&ownSec.querySelector('[data-setting="provider"]');
        var label=sel&&sel.selectedOptions&&sel.selectedOptions[0]?sel.selectedOptions[0].textContent:'';
        return '服务商：'+(label||'未选择');
      })(),
      local:'ComfyUI '+(fieldValue(localSec,'comfyUrl')?'已填写地址':'未填写地址')
    };
    foldables.forEach(function(sec){
      var anchor=String(sec.dataset.secAnchor||'');
      // ⭐ Phase C：账号里那排 6 个服务入口与下面的「更多服务」网格重复 ——
      //   【隐藏不移除】（data-setup-open / data-account-backup / data-account-center… 全留，
      //   测试与回填照常找得到；访问入口在网格里）。
      if(anchor==='account'){
        var legacyActs=sec.querySelectorAll(':scope > .settings-actions');
        if(legacyActs.length){legacyActs[0].hidden=true;legacyActs[0].dataset.legacyServiceEntries='';}
      }
      // ⚠⚠ 原地折叠：sec 这个元素【必须留着】—— workspaces.js 的闭包（local / platform 变量、
      //   checkBtn.onclick / checkLocal）指着它；replaceWith 会让那些引用变成游离节点，
      //   ComfyUI 检查按钮点了不工作（workspaces-ui 测试当场抓到）。
      sec.classList.add('settings-fold');
      var head=document.createElement('button');head.type='button';head.className='settings-fold-head';head.setAttribute('aria-expanded','false');
      var title=sec.querySelector('.settings-section-title');
      if(title)head.append(title);
      else{var t=document.createElement('span');t.className='settings-section-title';t.textContent=anchor;head.append(t);}
      if(notes[anchor]){var note=document.createElement('span');note.className='settings-fold-note';note.textContent=notes[anchor];head.append(note);}
      var markx=document.createElement('span');markx.className='fold-x';markx.setAttribute('aria-hidden','true');head.append(markx);
      var bodyEl=document.createElement('div');bodyEl.className='settings-fold-body';
      Array.prototype.slice.call(sec.children).forEach(function(node){if(node!==head)bodyEl.append(node);});
      sec.prepend(head);sec.append(bodyEl);
      // ⚠ data-service-tab 要【移到可点的折叠头】上 —— 老路由/测试点它是为了"展开那一节"。
      //   data-service-page 留在节上：workspaces 测试读它的 textContent（ComfyUI 结果行）。
      if(sec.dataset.serviceTab){head.dataset.serviceTab=sec.dataset.serviceTab;delete sec.dataset.serviceTab;}
      // ⚠ helpify 必须在藏起来之前（它跳过 [hidden] 里的说明文字）
      helpify(bodyEl);
      // ⚠⚠⚠ 2026-10-08 改：默认展开的那一节从 'account' 换成 'own'。
      //   用户原话："我填一个API key和URL，我找这个检查按钮我找特别久"。
      //   原因就是【填地址和 Key 的那一节默认是收着的】—— 一进页面只看到四个折叠头，
      //   「检查连接」在折叠里面，不点开根本不存在于视野里。
      //   ⇒ 你要填的是地址和 Key，那就把这一节默认摊开，检查按钮紧跟在 Key 下面。
      //   ⚠ 仍然保持"同屏只开一个"：下面 closeFolds 会把这个规矩执行下去。
      //   ⚠ 后面 focusSection(requested) 那句【不许】无条件再展开 ——
      //     否则用户手动收起后，任何一次重绘都会把它重新翻开，又变成"收不起来"。
      // ⚠⚠⚠ 2026-10-09（第二次改）：
      //   默认展开的锚点从 'platformAccount' 改【回】'account'。
      //   起因：用户要求"登录框提到最顶端 + 要能折叠"。我第一版是"新开一节排到最上"，
      //   但实测不成立（两个原因见下面），于是改成【把登录表单搬进「现在的情况」那一节】——
      //   那一节本来就排第一、本来就能折叠、而且点「账号设置」进来时路由聚焦的就是它
      //   （routeOptions()?.section||'account'）。⇒ 顺序/默认展开/聚焦三件事自动一致，
      //   不用再跟"同屏只开一个"的规矩打架。
      //   ⚠ 第一版为什么不成立（试错记录，别再走一遍）：
      //     ① closeFolds 保证同屏只开一个折叠 ⇒ 两个节都想默认开做不到；
      //     ② focusSection('account') 会把「现在的情况」展开，顺手挤掉我设的默认展开
      //        （实测：默认展开=false / 折叠体可见=false）。
      wireFold(sec,head,bodyEl,anchor==='account');
    });
    // ⭐⭐ 2026-10-04 深夜：服务块从"点一下翻一页"改成【页内可展开的一节】。
    //   ⚠⚠ 用户原话："在某一个功能里面去给我按上这 7 个按钮，并且这 7 个按钮点下去
    //     还需要翻页，按钮的 UI 还会去改变。" —— 那正是被点名批评的形态。
    //   ⇒ 现在：每一样服务就是页面上一节，标题行写着它是什么、右边一个箭头；
    //     点开就地展开（内容按需挂载，不展开就不建），再点收起。
    //     全都在同一页里，滚轮滚过去就行 —— 不换页、不换主卡。
    //   ⚠ data-service-tab 必须留着：老路由（settings/assistant、settings/keys…）
    //     和测试都靠这个属性找目标。**只是行为从"翻页"改成"展开 + 滚过去"**。
    //   ⚠ 懒挂载：内容只在第一次展开时挂（社区/云备份这种重模块，
    //     一进页面全挂上会明显卡 —— 记录卡那轮就吃过"一次渲染太多 DOM"的亏）。
    // ⭐ Phase C（docs/150 §6.1）：8 个服务收进「更多服务」两列网格 ——
    //   收起时每个只占一格（一行），点开的那个横跨两列显示内容。
    const moreTitle=document.createElement('div');moreTitle.className='settings-section-title service-more';moreTitle.textContent='更多服务';content.append(moreTitle);
    const moreGrid=document.createElement('div');moreGrid.className='service-grid';moreGrid.dataset.serviceGrid='';content.append(moreGrid);
    const hosts=new Map();
    const add=(id,label,render)=>{
      const sec=document.createElement('section');
      // ⚠⚠⚠ 2026-10-08（用户："右侧 6 个菜单的风格都要统一，都对成外挂能力里那个模型状态
      //   那种折叠收起的状态" + "下面那个更多服务也很乱，全部按照折叠的状态去给它重排"）：
      //   这 8 个原来叫 service-block / service-block-head / service-block-body，
      //   自带一套 CSS —— 跟 settings-fold 那套【逐条几乎一样】（都 38px 高、
      //   同样的 padding/箭头/旋转/展开底色），只是多了"宫格 2 列 + 文字不换行"。
      //   ⇒ 直接【复用折叠那套类】：长相自动等同，而且少一份重复定义
      //     （docs/147 §2.3 点过名："两处定义 = 文字不一致的根源"）。
      //   ⚠ 旧类名 service-block / service-block-head 与 [data-service-tab] 全保留 ——
      //     路由、右栏细分、测试都靠它们找节点，删了就是静默失效。
      sec.className='settings-section settings-fold service-block';
      sec.dataset.secAnchor=id;sec.id='setsec-'+id;
      const head=document.createElement('button');
      head.type='button';head.className='settings-fold-head service-block-head';head.dataset.serviceTab=id;
      head.setAttribute('aria-expanded','false');
      head.innerHTML='<span class="sb-t">'+String(label).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+'</span><span class="sb-c fold-x"></span>';
      const panel=document.createElement('div');panel.className='settings-fold-body service-block-body';panel.hidden=true;
      sec.append(head,panel);moreGrid.append(sec);
      hosts.set(id,{sec,head,panel,render,mounted:false});
      return sec;
    };
    add('photoshop','Photoshop',target=>root.V7Setup.mount(target));
    add('assistant','助手 API',target=>root.V7AssistantPanel.mountSection(target,'connection'));
    add('keys','Key 同步',target=>root.V7CloudBackup.open(target,{section:'keys',showBack:false}));
    // ⚠ 账单就在【这一页】里（V7AccountCenter 的 billing 页），不再跳记录卡。
    //   以前是 root.V7RouteRegistry.open('records/billing') —— 那会把用户甩到记录卡再回来，
    //   而且记录卡现在已经不管账单了（见 route-registry 里 records/billing 的改指）。
    add('billing','账单与兑换',target=>root.V7AccountCenter.mount(target,'billing'));
    add('support','客服记录',target=>root.V7AccountCenter.mount(target,'support'));
    add('service','公告与状态',target=>root.V7AccountCenter.mount(target,'service'));
    // ⚠ 云备份的内容直接挂在这一页（原来是跳 records/backup，会绕回设置卡自己）。
    add('backup','云备份',target=>root.V7CloudBackup.open(target,{section:'backup',showBack:false}));
    // ⭐⭐ 2026-10-09（用户定）：「砍掉软件里的社区，软件里只留一个「社区」按钮，点了跳网页」
    //   ⇒ 这里不再挂 community-center 那套完整界面（提示词广场/排行/审核/实名…），
    //     只留一个按钮，点了用【系统默认浏览器】打开后台配的社区网址。
    //
    //   ⚠ 网址来自后台 /v1/public/community（不写死在客户端）——
    //     域名/路径以后会变，写死就得重新发版；后台改一次全部客户端就跟着变。
    //   ⚠ 网址空的时侯：按钮显示「社区（暂未开放）」并且【点不动】，
    //     绝不允许跳一个 404 或空白页 —— 那比没有按钮更糟。
    //   ⚠ 打开失败（没浏览器/被拦）要说一句，不能静默无反应（铁律 17 的静默失效）。
    add('community','社区',target=>{
      target.innerHTML='<div class="settings-panel"><div class="settings-intro"><strong>社区</strong>'
        +'社区现在是一个独立的网页，不再做进软件里。</div>'
        +'<div class="settings-section"><div class="settings-section-title">打开社区网页</div>'
        +'<p class="settings-note" data-community-note role="status">正在读取社区地址…</p>'
        +'<div class="settings-actions"><button class="settings-btn settings-btn-primary" type="button" data-community-open disabled>社区</button></div>'
        +'<div class="settings-note">会在你的默认浏览器里打开。没装浏览器或地址没配好时，这里会说明原因。</div>'
        +'</div></div>';
      // ⚠⚠ 2026-10-10 审查时改成【从 note 反查同一个面板里的按钮】，不再全局 querySelector。
      //   原因：页面上还有另一个按钮也叫 data-community-open（ui.html 的"跳到社区设置页"导航按钮），
      //   全局取会抓到那一个 ⇒ arm() 把禁用/文字全改到错的元素上，
      //   真正这个按钮一直"可点但点了没反应"（铁律 17 的静默失效）。
      //   那个导航按钮现在已经改名成 data-community-nav，但这里也一起加固：
      //   ⚠ 教训：同一个 data-* 属性别用在两个用途不同的元素上；取节点要限定在【自己这块面板】里。
      const note=target.querySelector('[data-community-note]');
      const button=note?note.closest('.settings-panel')?.querySelector('[data-community-open]')||null:target.querySelector('[data-community-open]');
      if(!note||!button)console.warn('[社区] 面板结构不对，按钮或说明没找到 —— 这个块会显示不全');
      let url='',title='社区';
      const paint=text=>{ if(note)note.textContent=text; };
      // ⚠⚠ 2026-10-10 审查时收紧（原来只看 `有没有 URL`，自测抓到两个不一致）：
      //   ① localhost:37900 被误挡 —— 正则要求域名带点，localhost 没有点；
      //   ② 域名里夹控制字符（\u0000 之类）被放行 —— \s 不匹配 NUL。
      //   ⇒ 现在跟后端 community_url_ok / Rust open_external_url 用同一套规矩：
      //      http(s) + 剥掉端口后有主机名 + 主机名里没有空白和控制字符
      //      + 主机名带点或等于 localhost。
      //   ⚠ 客户端的判断只是「早点告诉用户」，**真正的安全边界在后端和 Rust 那边**。
      //     三处规矩必须一致，否则会出现"前端说填好了、后端偷偷清空"⇒ 用户填了没反应。
      const urlOk=value=>{
        const text=String(value||'').trim();
        // 控制字符（含 NUL/换行/制表符）一律挡
        for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c<32||c===127)return false;}
        const m=/^https?:\/\/([^/?#]*)/i.exec(text);
        if(!m)return false;
        const hostWithPort=m[1];
        if(!hostWithPort)return false;
        const colon=hostWithPort.lastIndexOf(':');
        const host=colon>=0?hostWithPort.slice(0,colon):hostWithPort;
        if(!host||/\s/.test(host))return false;
        if(host.indexOf('.')<0&&host.toLowerCase()!=='localhost')return false;
        return true;
      };
      const arm=()=>{
        if(!button)return;
        button.disabled=!url;
        button.textContent=url?(title||'社区'):'社区（暂未开放）';
      };
      arm();
      // 拉地址（失败就说原因，不静默）
      (async()=>{
        try{
          if(!root.V7Backend||typeof root.V7Backend.publicCommunity!=='function'){
            // ⚠⚠ 2026-10-10 审查抓到：这几条"提前 return"的分支【原来没调 arm()】，
            //   而 arm() 里才有 disabled 的判断 ⇒ 按钮停在"可点但点了什么都不发生"。
            //   实测现场：说明写着「社区网页还没配置」，按钮却是可点的、文字还是「社区」。
            //   这正是铁律 17 的静默失效 —— 用户点了没反应，还不知道为什么。
            //   ⇒ 所有出口都必须 arm()，一个都不能漏。
            paint('当前版本读不到社区地址（后台接口未接入）。');arm();return;
          }
          const info=await root.V7Backend.publicCommunity();
          url=String(info&&info.url||'').trim();
          title=String(info&&info.title||'社区').trim()||'社区';
          if(!url){ paint('社区网页还没配置。等平台把地址填到后台，这里就会出现入口。'); arm(); return; }
          // ⚠ 后端按理已经挡过一次了；这里再挡一次是防"后台脏数据"（比如手工改库塞进去的）。
          //   拦下来时报清楚，别让按钮看着能点却打不开。
          if(!urlOk(url)){ url=''; paint('后台配的社区地址看起来不完整（要 http:// 或 https:// 开头、带域名），已经先禁用这个按钮。'); arm(); return; }
          paint((info&&info.note)?String(info.note):('地址：'+url));
          arm();
        }catch(error){
          paint('读社区地址失败：'+String(error&&error.message||error).slice(0,60));
          // ⚠ 这里也要 arm()：不然按钮会停在"可点但没地址"的状态，
          //   用户点下去什么都不发生（静默失效）。实测抓到过这个。
          arm();
        }
      })();
      if(button)button.onclick=async()=>{
        if(!url)return;
        button.disabled=true;
        const old=button.textContent;
        button.textContent='正在打开浏览器…';
        // ⭐ 2026-10-19：先要进门条子再开（openCommunity，见文件开头）
        const result=await openCommunity(url);
        button.disabled=false;button.textContent=old;
        paint(result.message);
      };
    });

    let cleanup=null;
    retain(body,()=>{try{cleanup?.();}catch(_){}});
    function collapse(id){
      const h=hosts.get(id);if(!h||!h.mounted)return;
      try{cleanup?.();}catch(_){}
      cleanup=null;
      h.panel.replaceChildren();h.mounted=false;h.panel.hidden=true;h.head.setAttribute('aria-expanded','false');
      h.sec.classList.remove('open');
    }
    function expand(id){
      const h=hosts.get(id);if(!h)return;
      // ⚠ 一次只开一节 —— 全开着的话这一页会长到滚不完，又变回"翻页"那种负担
      for(const [other] of hosts)if(other!==id)collapse(other);
      if(!h.mounted){
        const target=document.createElement('div');h.panel.append(target);
        try{cleanup=h.render(target)||null;}catch(error){h.panel.append(Object.assign(document.createElement('p'),{className:'settings-note',textContent:'这一块没打开：'+String(error&&error.message||error)}));}
        h.mounted=true;
      }
      h.panel.hidden=false;h.head.setAttribute('aria-expanded','true');h.sec.classList.add('open');
      helpify(h.panel);
      body.dataset.serviceView=id;
      // 展开之后把它滚进视野（它可能在页面下方）
      try{h.sec.scrollIntoView({block:'nearest',behavior:'smooth'});}catch(_){}
    }
    content.addEventListener('click',event=>{
      const head=event.target.closest?.('[data-service-tab]');
      if(!head||!hosts.has(head.dataset.serviceTab))return;
      event.preventDefault();
      const id=head.dataset.serviceTab;
      const h=hosts.get(id);
      if(h&&h.mounted&&!h.panel.hidden)collapse(id);else expand(id);
    });
    // 路由进来：滚到那一节并把服务块展开
    const requested=body.dataset.requestedSection || host.routeOptions()?.section||'account';
    handle.focusSection?.(requested);
    // ⭐ Phase C（docs/150 §6.1）：settings/photoshop|assistant|keys|billing… 进来要
    //   "展开 + 滚到" —— 四节折叠由 focusSection 自己开，服务块在这里开。
    if(hosts.has(requested))requestAnimationFrame(function(){if(hosts.has(requested))expand(requested);});
    // ⚠ 2026-10-08：footer 挂到【内容流末尾】—— 到这里「更多服务」8 个块才建完，
    //   现在挂才会排在它们下面（挂早了会跑到"更多服务"标题上面）。
    // ⚠⚠⚠ 2026-10-08 新增：默认把「你在用哪家算图」摊开。
    //   用户原话："我填一个API key和URL，我找这个检查按钮我找特别久"。
    //   实测机制（探针打的）：检查按钮存在:true / 可见:false / 在哪个折叠:"own" / 那个折叠开着吗:false
    //   ⇒ 一进页面只有四个折叠头，填地址、填 Key、"检查连接"三样全在折叠里，用户当然找不到。
    //   ⚠⚠ 实现方式说明（试错记录，别改回去）：
    //     在这里"事后补一次 _foldSetOpen(true)"【没用】—— 实测 own 仍然收着。
    //     原因是四个折叠是按顺序 wireFold 的，每次 setOpen(true) 都会 closeFolds 关掉别人，
    //     事后补开还会跟 closeFolds 打架（而且服务块现在也带 settings-fold 类，
    //     那句 `!content.querySelector('.settings-fold.open')` 会被服务块命中而永远为假）。
    //   ⇒ 用代码里【本来就有】的那套机制：默认展开哪一节由 wireFold 的第四个参数决定
    //     （原来传的是 anchor==='account'）。在【原地折叠】那里改成 'own' 就行 —— 一行，无副作用。
    //     见下面 foldables.forEach 里 wireFold(sec,head,bodyEl,anchor==='own')。
    content.append(footer);
    helpify(body);
  }
  function records(body,historyHost){
    reset(body);body.dataset.recordsCenter=historyHost.view==='costs'?'billing':'recovery';
    const requested=host.routeOptions()?.section;
    const items=historyHost.view==='costs'?[['billing','积分账单'],['costs','本机任务费用']]:[['checkpoints','画布检查点'],['backup','账号备份'],['layout','布局恢复'],['software','软件恢复']];
    const cleanup=tabs(body,items,requested,(target,id)=>{
      if(id==='billing')return root.V7AccountCenter.mount(target,'billing');
      if(id==='backup')return root.V7CloudBackup.open(target,{section:'backup',showBack:false});
      if(id==='layout')return root.V7LayoutManager.mount(target);
      if(id==='software')return root.V7AssistantPanel.mountSection(target,'recovery');
      if(id==='checkpoints'){const settings=document.createElement('div');settings.className='settings-actions';settings.append(routeButton('检查点与容量设置','settings/storage'));target.append(settings);}
      const list=document.createElement('div');target.append(list);
      return root.V7HistoryLibrary.mount(list,{...historyHost,view:id,recordsEmbedded:true});
    });
    retain(body,cleanup);return cleanup;
  }
  // ⭐ 生成与传回设置（2026-10-01 真搬家）。
  //   ⚠⚠ 以前这里是 `source(1)` —— 从【设置卡 zone 1】把那一段取过来渲染，
  //     再剔掉调试/检查点/缓存三样。那叫"借用"，不叫搬家：
  //     生成卡和设置卡共用一份定义，改一边动两边（用户明确否掉了"跳转"，同理也否掉这个）。
  //   现在生成卡【自带定义】（host.generationMarkup），设置卡那边整段删掉。
  //   ⚠ 留在设置卡的只有两个：检查点（checkpointEnabled / checkpointIntervalMin）
  //     和缓存容量（cacheCapacityGB）—— 用户 2026-10-01 定："检查点留在设置卡"。
  function generation(body){
    // ⭐⭐⭐ 2026-10-14（用户定）：「生成卡二三级不应该残留任何的设置」。
    //   原来这里画的是 5 组折叠（对齐与校色 / 输出行为 / 编组 / 羽化 / 完成音效），
    //   【整批搬去设置卡「生成结果设置」页了】（见 settingsTab 的 tab==='render' 分支）。
    //   ⚠ 这一格今后【不放任何设置】—— 用户要拿它放别的东西。
    //   ⚠ 不在这里留同一批控件：两张卡都放，用户不知道改的是哪个（本项目反复记过的坑）。
    reset(body);
    body.innerHTML='<div class="settings-intro">这一格不再放设置 —— 生成与传回的选项已经全部搬到'
      +'<b>设置卡</b>的「生成结果设置」页。这里留给之后要放的内容。</div>';
  }
  function debug(body,zone){
    reset(body);
    // ⚠⚠ 2026-10-01：这两段原来从【设置 zone 3】取（source(3)）。用户定案把调试内容
    //   挪到调试卡之后，设置里那份标记被删了 —— 再 source(3) 会直接 null 崩
    //   （实测：Cannot read properties of null (reading 'closest')）。
    //   现在调试卡拿 host.debugMarkup() 的【自带】标记，不再依赖设置卡。
    const from=document.createElement('div');from.innerHTML=host.debugMarkup?host.debugMarkup():'';
    if(zone===0){
      // ⚠⚠ 2026-10-01 真搬家：这一格原来是 `source(1)`（从设置卡 zone 1 借 debugMode 那一项）。
      //   设置卡 zone 1 现在整段删掉了 —— 再 source(1) 会取到空节点，
      //   fields() 找不到 debugMode 会【抛 "设置入口缺失：debugMode"】（它就是这么设计的：
      //   少一项就明着炸，不静默缺一个开关）。
      //   现在这一项由 host.debugMarkup() 自带（含勾选状态），这里整个取过来。
      const runtimeStatus=from.querySelector('[data-setting="debugMode"]')?.closest('.settings-section');
      if(runtimeStatus)body.append(runtimeStatus);
      const runtime=from.querySelector('[data-perf-open]')?.closest('.settings-section');
      // ⚠ 原来这里有一句 takeField(runtime,'bridgePollMs')?.remove() —— 它剔掉轮询间隔，
      //   因为那时设置卡「交互」页还挂着同一项，两处都放会打架。
      //   ⚠⚠ 2026-10-01 设置那边删掉之后，这句会让 bridgePollMs 【整个界面都调不到】。
      //   现在它是唯一入口，必须留着。
      if(runtime)body.append(runtime);
      const network=section('连接诊断','<button class="settings-btn" data-network-check>网络体检与报告</button>');body.append(network);network.querySelector('button').onclick=()=>root.V7NetworkDoctor.open();
      // ⚠ 2026-10-01：书签入口原来绑在 defaults()（设置 zone 1）里 —— 那页已经不可达，
      //   不在这儿补一句，入口就彻底消失了（标记在、点不动）。
      const bookmarks=from.querySelector('[data-browser-preferences]')?.closest('.settings-section');
      if(bookmarks){body.append(bookmarks);bookmarks.querySelector('button').onclick=()=>root.V7BrowserBookmarks.open();}
      // ⭐ 预览链追踪（2026-10-06）：debugMarkup 里那段【必须在这里显式搬过来】。
      //   ⚠⚠ 这一格是【挑着搬】的（只取运行状态 / 网络 / 书签那几段），不是末尾整体 append ——
      //     光把标记写进 debugMarkup 是【不会出现在界面上】的。
      //     第一版就是这么白写的：探针查 [data-preview-trace] 查到 0 个。
      //     记住这条：往 debugMarkup 加新段落，这里必须跟着搬一次。
      const trace=from.querySelector('[data-preview-trace]')?.closest('.settings-section');
      if(trace)body.append(trace);
      if(root.V7ReturnLab){const lab=document.createElement('section');lab.className='settings-section';body.append(lab);retain(body,root.V7ReturnLab.mount(lab));}
      bind(body);
    }else if(zone===1){
      // ⚠⚠⚠ 2026-10-14：这一格从"只搬一段"改成"搬两段"。
      //   原来只取 `[data-error-test]` 那一节。而 debugMarkup() 是【挑着搬】的 ——
      //   没被点名的段落【不会出现在界面上】（本文件上面那段注释专门记过这条坑，
      //   说有人白写过一次）。
      //   我给调试卡加了「参考图调试」一节（加假参考图那几个按钮），
      //   所以这里必须跟着搬一次，否则那几个按钮【看得见标记、界面上没有】。
      //   ⚠ 加新段落时，这里必须同步加一行 —— 这是这张卡的固定姿势。
      //   ⚠ 用 querySelectorAll 而不是再多写一个 if：以后再加段落只用改数组。
      //     顺序按 debugMarkup 里的出现顺序（报错分级 → 参考图调试）。
      const zone1 = [...from.querySelectorAll('[data-error-test],[data-ref-fake],[data-ref-fake-clear]')]
        .map(node => node.closest('.settings-section'))
        .filter((node, index, all) => node && all.indexOf(node) === index);
      zone1.forEach(node => body.append(node));
      bind(body);
    }
    else{
      body.innerHTML='<div class="link-panel" data-log-zone="0"><div class="settings-actions"><button class="settings-btn" data-log-show="0">全部日志</button><button class="settings-btn" data-log-show="1">桥接日志</button><button class="settings-btn danger" data-log-clear>清空本地日志</button><button class="settings-btn" data-log-copy>复制全部日志</button></div><div class="log-list" data-log-list></div></div>';
      host.bindLogs(body);host.refreshLogs(body,host.routeOptions()?.logKind||0);body.querySelectorAll('[data-log-show]').forEach(button=>button.onclick=()=>host.refreshLogs(body,Number(button.dataset.logShow)));
    }
  }
  // ⚠⚠ 2026-10-14：这里是原来「使用教程」卡的渲染入口（tutorial），
  //   它前 3 格是教程正文（V7Tutorial）、第 4 格是完整手册（V7Manual）。
  //   教程卡【整张已删】（用户定：教程要重做），所以这个函数只剩手册那一支。
  //
  //   ⚠ 既然教程卡没了，就没有任何卡片会调它 —— 保留它只是【留重做接口】：
  //     重做教程卡时，card-registry.js 的 module 指回 'V7Tutorial'、
  //     这里把前 3 格的 V7Tutorial.mount 加回来即可（清单见 docs/217）。
  //   ⚠ 手册【没有跟着删】：它不是教程。现在走 V7Manual 自带的浮层
  //     （V7Manual.open(id)，manual-center.js 里会自己建 overlay），
  //     入口在设置卡 —— 见 ui.html 里 V7Manual.configure 那一段。
  function tutorial(body,zone){reset(body);retain(body,root.V7Manual.mount(body,host.routeOptions()?.topic,host.routeOptions()?.query));}
  // ⭐ 2026-09-29 方案 B：项目卡四格顺序变了（项目管理 / 本项目记录 / 拍摄日程 / Eagle 归档）。
  //   ⚠ 第 1 格「本项目记录」不是项目与日程那套（它读的是历史库，view:'current'），
  //     所以这里不能再用 ['projects','schedule','eagle'][zone] 直接映射 ——
  //     那样第 1 格会落到「日程提醒」、第 2 格落到 Eagle，四格整体错位一格且不报错。
  //   映射表现在是显式的：0/2/3 走 ProjectSchedule，1 走 mountProjectRecords。
  function projects(body,zone){
    reset(body);
    if(zone===1){
      retain(body,host.mountProjectRecords?.(body)||(()=>{}));
    }else{
      const tab={0:'projects',2:'schedule',3:'eagle'}[zone]||'projects';
      retain(body,root.V7ProjectSchedule.mount(body,tab));
    }
    helpify(body);
  }
  function assistant(body,zone){
    reset(body);retain(body,root.V7AssistantPanel.mountSection(body,['chat','connection','permissions','recovery'][zone]));
    if(zone===1){
      const local=document.createElement('details');local.className='assistant-local-setup';local.innerHTML='<summary>本地助手运行环境</summary><div data-local-assistant-setup></div>';body.append(local);
      let cleanup=null;local.ontoggle=()=>{if(local.open&&!cleanup)cleanup=root.V7Setup.mount(local.querySelector('div'),{section:'assistant'});else if(!local.open&&cleanup){cleanup();cleanup=null;}};
      retain(body,()=>cleanup?.());
    }
    helpify(body);
  }
  root.V7CardArchitecture={configure,openCommunity,prepareDetail,retain,reset,helpify,cardFace,settings,settingsTab,settingsPage,generation,records,debug,tutorial,projects,assistant,foldSection,expandAncestors};
})(window);
