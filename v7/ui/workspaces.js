(function(root){
  'use strict';
  const active=new Map();
  let host={},accountEpoch=0;
  function configure(options){host=options||{};}
  function create(container,id,title,description,mount,options={}){
    const existing=active.get(id);
    if(existing?.dialog.isConnected){existing.dialog.querySelector('button')?.focus();return existing;}
    if(existing)existing.forceClose();
    const source=document.activeElement,dialog=document.createElement('section');
    dialog.className='v7-workspace v7-workspace-inline';dialog.dataset.workspace=id;
    dialog.setAttribute('role','region');
    dialog.setAttribute('aria-label',title);
    const header=document.createElement('header'),heading=document.createElement('div');
    const name=document.createElement('h2');name.textContent=title;
    const note=document.createElement('p');note.textContent=description;
    heading.append(name,note);
    const closeButton=document.createElement('button');closeButton.type='button';closeButton.className='settings-btn v7-workspace-close';closeButton.setAttribute('aria-label','返回');closeButton.title='返回';
    if(root.ICON?.set)root.ICON.set(closeButton,'arrowLeft',18);else closeButton.textContent='返回';
    header.append(heading,closeButton);
    const body=document.createElement('div');body.className='v7-workspace-body';
    const footer=document.createElement('footer');footer.className='v7-workspace-footer';
    const state=document.createElement('span');state.textContent='';state.setAttribute('role','status');footer.append(state);
    dialog.append(header,body,footer);
    let dispose=()=>{},closed=false,beforeClose=null,pendingClose=null;
    const finish=reason=>{if(closed)return true;closed=true;root.UISelect?.close();handle.cancelUnsaved?.();try{dispose();}finally{dialog.remove();if(active.get(id)===handle)active.delete(id);options.onClose?.(handle,{reason});if(reason==='close'&&source?.isConnected&&!source.closest('[inert]'))source.focus({preventScroll:true});}return true;};
    const close=(force=false,reason='close')=>{
      if(closed)return true;
      if(force)return finish(reason);
      if(dialog.dataset.v7ModalSuspended)return false;
      if(pendingClose)return pendingClose;
      const result=beforeClose?.();
      if(result&&typeof result.then==='function'){
        pendingClose=Promise.resolve(result).then(accepted=>accepted===false?false:finish(reason)).finally(()=>{pendingClose=null;});
        return pendingClose;
      }
      return result===false?false:finish(reason);
    };
    const handle={dialog,element:dialog,body,footer,state,close,forceClose:()=>close(true,'invalidation'),setBeforeClose:callback=>{beforeClose=typeof callback==='function'?callback:null;},get closed(){return closed;}};
    active.set(id,handle);container.append(dialog);
    // DOM click handlers receive a MouseEvent.  Do not pass it through as the
    // `force` argument: a suspended workspace must stay open until its owner
    // explicitly invalidates it (for example, an account switch).
    closeButton.onclick=()=>close();
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();close();}});
    try{const cleanup=mount(handle);if(typeof cleanup==='function')dispose=cleanup;}catch(error){handle.forceClose();throw error;}
    return handle;
  }
  function mount(container,id,title,description,render,options){
    if(!container||typeof container.append!=='function')throw new Error('工具工作区尚未就绪');
    return create(container,id,title,description,render,options);
  }
  function open(id,title,description,render){
    const existing=active.get(id);
    if(existing?.dialog.isConnected){existing.dialog.querySelector('button')?.focus();return existing;}
    if(typeof host.open==='function')return host.open({id,title,description,mount:render});
    const container=document.querySelector?.('#dcBody');
    // Compatibility callers still use open(); production registers its card
    // navigator, while isolated hosts can supply the standard detail body.
    return create(container||document.body,id,title,description,render);
  }
  function close(id){return active.get(id)?.close();}
  async function requestCloseAll(exceptId){for(const [id,handle]of active)if(id!==exceptId&&await handle.close(false,'navigation')===false)return false;return true;}
  async function adoptLegacy(id,title,element,closeSurface,onError){
    const handle=await open(id,title,'',workspace=>{
      workspace.dialog.classList.add('v7-workspace-surface');
      element.setAttribute('open','');element.dataset.uiOverlay='false';workspace.body.append(element);
      workspace.setBeforeClose(async()=>{try{await closeSurface(true);return !element.isConnected;}catch(error){workspace.state.textContent=error.message;onError?.(error);return false;}});
    });
    if(!handle)throw Object.assign(new Error('已取消打开工作区'),{code:'WORKSPACE_OPEN_CANCELLED'});
    return handle;
  }
  function confirmUnsaved(handle,save){
    if(handle.unsavedChoice)return handle.unsavedChoice;
    const panel=document.createElement('div');panel.className='browser-unsaved-choice';panel.setAttribute('role','group');panel.setAttribute('aria-label','尚未保存的修改');
    const title=document.createElement('p');title.textContent='尚未保存的修改';panel.append(title);
    let resolveChoice;
    const promise=new Promise(resolve=>{resolveChoice=resolve;});handle.unsavedChoice=promise;
    const finish=value=>{panel.remove();handle.unsavedChoice=null;handle.cancelUnsaved=null;resolveChoice(value);};handle.cancelUnsaved=()=>finish(false);
    for(const [label,action]of [['继续编辑',()=>finish(false)],['放弃修改',()=>finish(true)],['保存并返回',async()=>{try{await save();finish(true);}catch(error){handle.state.textContent=error.message;}}]]){
      const button=document.createElement('button');button.type='button';button.className='settings-btn';button.textContent=label;button.onclick=action;panel.append(button);
    }
    handle.footer.prepend(panel);panel.querySelector('button')?.focus();return promise;
  }
  function invalidate(){accountEpoch++;for(const handle of [...active.values()])handle.forceClose?.();}
  // ⭐ 2026-10-06 晚：工作区是否【真的看得见】。
  //   hasEmbedded() 只问"dialog 还连着没有" —— 一个挂过又被收进隐藏详情层的工作区
  //   会让它恒真，进而把全局鼠标手势（任务卡/主卡右滑）整个关掉。
  //   用户实测："标准模式跑一会右滑全失灵，切自由模式就好"（自由模式进场会
  //   closeAll→requestCloseAll 把工作区关掉）。所以手势护栏改用这个更严的判据。
  //   ⚠ checkOpacity 会把 opacity:0 的祖先也算进去（隐藏的 .detail-card 就是 opacity:0）。
  function dialogVisible(el){
    if(!el||!el.isConnected) return false;
    if(typeof el.checkVisibility==='function') return el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const s=root.getComputedStyle(el);
    return s.display!=='none'&&s.visibility!=='hidden';
  }
  function hasVisibleEmbedded(){return [...active.values()].some(handle=>dialogVisible(handle.dialog));}
  // ⭐⭐⭐ 2026-10-04 深夜重做「连接与账号」。
  //
  //  用户原话（很重，两句都要照办）：
  //    · "不要去浪费我们的空间和做过多的分割。我们已经在右侧做了菜单分割，
  //       就不要再在左侧去再做分割了。"
  //    · "在某一个功能里面去给我按上这 7 个按钮，并且这 7 个按钮点下去还需要翻页，
  //       按钮的 UI 还会去改变。"
  //
  //  ⇒ 左边那排按钮【整块不要了】。改成一页到底：
  //     所有分节竖着排在同一页里，靠【右栏那条时间轴】分细
  //     （见 settings-card.js 的 railSections / scn-subs）。
  //
  //  ⚠⚠ 每节仍然挂 data-service-tab —— 三个老路由（settings/account、settings/local…）
  //     和两支测试都靠这个属性找目标。**只是行为从"换页"改成"滚到这一节"**。
  //     删掉这个属性会让它们静默失效（本项目最忌的形态）。
  //  ⚠ 每节还挂 data-sec-anchor —— 右栏扫的就是它（锚点用英文，标题给人看）。
  function arrangeServices(handle){
    const panel=handle.body.querySelector('.settings-panel');
    if(!panel)return;
    const sections=[...panel.querySelectorAll(':scope > .settings-section')];
    const account=sections[0],own=sections[1];
    if(!account||!own)return;
    const accountStatus=account.querySelector('.settings-status');
    if(accountStatus)account.querySelector('.settings-section-title').after(accountStatus);

    const content=document.createElement('div');content.className='v7-workspace-content';
    // ⚠⚠ 三个 data-* 都要挂，缺一个就有东西静默失效：
    //   data-sec-anchor  → 右栏扫它做「细分小节」（settings-card.js 的 railSections）
    //   data-service-tab → 老路由 settings/account、settings/local… 和两支测试靠它找目标
    //   data-service-page→ workspaces 那支测试读它的 textContent 验 ComfyUI 检查结果
    //   三个都留、行为改成"滚过去"，是改动最小的做法（少一处会漂的东西）。
    const mark=(node,anchor)=>{
      node.dataset.secAnchor=anchor;
      node.dataset.serviceTab=anchor;
      node.dataset.servicePage=anchor;
      node.id='setsec-'+anchor;
      return node;
    };
    const section=(title,text,anchor)=>{
      const el=document.createElement('section');el.className='settings-section';
      const h=document.createElement('h3');h.className='settings-section-title';h.textContent=title;
      const p=document.createElement('p');p.className='settings-note';p.textContent=text;
      const grid=document.createElement('div');grid.className='settings-grid';
      el.append(h,p,grid);return mark(el,anchor);
    };
    const platform=section('平台算力','使用平台算力前请登录账号。提交任务前显示报价，确认后扣费。','platform');
    const local=section('本地与自有工作流','填写自己的 ComfyUI 地址；本地 V7 控制服务默认使用 127.0.0.1:37900，工作流服务使用 37901。','local');
    const status=panel.querySelector(':scope > .settings-status');if(status)own.append(status);
    const move=(keys,target)=>keys.forEach(key=>{const input=own.querySelector('[data-setting="'+key+'"]')||panel.querySelector('[data-setting="'+key+'"]');const field=input?.closest('.settings-field,.settings-row');if(field)target.querySelector('.settings-grid').append(field);});
    move(['imageComputeSource','workflowSource'],platform);
    move(['comfyUrl','comfyKey'],local);

    // 四节的锚点（顺序就是页面上的顺序）
    mark(account,'account');
    mark(own,'own');

    // 每节自己的动作按钮 —— 原来挤在底部那一颗"随选中页变名字"的主按钮上，
    // ⚠ 那正是用户说的"按钮的 UI 还会去改变"。现在各归各节，看得见它管哪一块。
    const platformButton=document.createElement('button');platformButton.type='button';platformButton.className='settings-btn';platformButton.textContent='查看账单与兑换';platformButton.onclick=()=>root.V7AccountCenter?.open('billing');platform.append(platformButton);
    const diagnostics=document.createElement('button');diagnostics.type='button';diagnostics.className='settings-btn';diagnostics.textContent='网络体检与报告';diagnostics.onclick=()=>root.V7NetworkDoctor.open();local.append(diagnostics);
    const checkBtn=document.createElement('button');checkBtn.type='button';checkBtn.className='settings-btn';checkBtn.dataset.servicePrimary='';checkBtn.textContent='检查 ComfyUI 连接';local.append(checkBtn);
    const localResult=document.createElement('p');localResult.className='settings-note';localResult.setAttribute('role','status');localResult.textContent='尚未检查连接。';local.append(localResult);

    let checking=false;
    const context=()=>{const state=root.V7Backend?.state?.();return JSON.stringify([accountEpoch,root.WHEELCHAIR_STORAGE?.key('settings'),state?.baseUrl,state?.account?.id||state?.account?.accountId,state?.signedIn,state?.sessionVersion]);};
    const mountedContext=context(),isCurrent=()=>handle.body.isConnected&&context()===mountedContext;
    async function checkLocal(){
      if(checking||!isCurrent())return;checking=true;checkBtn.disabled=true;localResult.textContent='正在检查 ComfyUI…';
      try{
        const input=local.querySelector('[data-setting="comfyUrl"]'),key=local.querySelector('[data-setting="comfyKey"]');
        const url=new URL(String(input?.value||''));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('请填写不含账号密码的 HTTP 或 HTTPS 服务地址');
        url.pathname=url.pathname.replace(/\/$/,'')+'/system_stats';url.search='';url.hash='';
        const headers={};if(key?.value)headers.Authorization='Bearer '+key.value;
        let response;if(root.uiwin?.http?.fetch)response=await root.uiwin.http.fetch({url:url.href,method:'GET',headers,timeoutMs:10000});
        else{const result=await fetch(url.href,{headers,signal:AbortSignal.timeout(10000)});response={ok:result.ok,status:result.status,body:await result.text()};}
        if(!isCurrent())return;
        if(!response?.ok)throw new Error('连接失败'+(response?.status?'（HTTP '+response.status+'）':'')+'，请确认服务已启动、地址和 Key 正确');
        const data=typeof response.body==='string'?JSON.parse(response.body):response.body;
        if(!data||!data.system||!Array.isArray(data.devices))throw new Error('地址可以访问，但不是可识别的 ComfyUI 服务');
        localResult.textContent='ComfyUI 连接正常 · '+data.devices.length+' 个计算设备；实际生成仍需对应工作流、模型和节点。';
      }catch(error){if(isCurrent()){localResult.textContent=error.message;root.ERR?.report('PROVIDER_TEST_FAILED',{message:error.message});}}
      finally{checking=false;if(isCurrent())checkBtn.disabled=false;}
    }
    checkBtn.onclick=()=>checkLocal();

    const intro=panel.querySelector(':scope > .settings-intro');if(intro)intro.remove();
    // ⚠⚠⚠ 2026-10-09 修（用户实测报的：「我他妈没找到登录的页面啊哥们」）：
    //
    //   真因就在这里。原来只有一句 `content.append(account, platform, own, local)`，
    //   紧接着 `panel.replaceChildren(content)` 会把 panel 里**剩下的一切**都丢掉。
    //   而 legacySettingsMarkup(0) 拼出来的是【7 节】：
    //     0 现在的情况(account) / 1 你在用哪家算图(own)  ← 只有这两节被 mark，
    //     2 算力怎么分工 / 3 余额提醒 / 4 自己的在线服务与工作流 /
    //     5 平台账号 ←【登录表单 + V7 后端地址输入框都在这一节】 / 6 服务与工具
    //   ⇒ 后 5 节整个消失。用户找不到登录框、也找不到后端地址，就是这么来的。
    //
    //   ⚠ 症状为什么一直没被发现：消失是【静默】的 ——
    //     settingsMarkup 照常返回、replaceChildren 照常成功、控制台一声不吭，
    //     只是页面上少了几节。正是 CLAUDE.md 铁律 17 说的"静默失效"。
    //   ⚠ 改法：把 panel 里【还没被搬走的】直接子节点原样接在后面 ——
    //     不重新拼它们、不挑字段，只保证"没被点名的节不会凭空消失"。
    //     用 append（移动）而不是克隆：这些节点上挂着 data-setting 回填和事件绑定，
    //     克隆会让绑定落在游离节点上（本项目踩过：卡面值静默变旧）。
    //   ⚠ 必须先把"留下的"快照下来再动 —— append 会实时改变 panel.children，
    //     边遍历边移动会漏掉一半节点。
    const 留下的=Array.prototype.slice.call(panel.children);
    content.append(account,platform,own,local);
    for(const node of 留下的){
      if(node===account||node===platform||node===own||node===local)continue;
      if(node===content)continue;
      content.append(node);
    }
    // ⚠ 2026-10-09：这里原来有一段"把 data-sec-anchor=platformAccount 那节插到最前"。
    //   现在不需要了 —— 登录表单已经搬进【①「现在的情况」那一节】（它本来就排第一，
    //   而且点「账号设置」进来时路由聚焦的也是它，见 ui.html 里的说明）。
    //   删掉它是因为登录节已经不存在了，留着 querySelector 永远返回 null、是死代码。
    panel.replaceChildren(content);handle.body.classList.add('v7-service-layout');
    handle.state.textContent='连接信息修改后自动保存在本机；请主动测试以确认可用。';

    // 点了某一节（右栏细分 / 老路由）→ 滚过去，不换页。
    // ⚠ 挂 data-service-tab 的元素可能不是 <section> 本身（服务块里是标题行），
    //   所以这里用 closest 往上找锚点。
    function focusSection(id){
      const node=content.querySelector('[data-sec-anchor="'+String(id).replace(/"/g,'\\"')+'"]');
      if(!node)return;
      // ⭐ Phase C（docs/150 §6.1）：目标在折叠里就先展开 —— 否则滚过去只看到一行标题。
      //   折叠组件由 card-architecture 出（_foldSetOpen 是它的稳定接口）。
      const fold=node.closest('.settings-fold');
      // ⚠⚠⚠ 2026-10-08 加闸（用户报过"有些东西展开了没有办法收起"）：
      //   这一段是【点任何带 data-service-tab 的元素】都会跑的（见下面那个 content 监听），
      //   而"你在用哪家算图"那一节现在是【默认展开】的 —— 于是用户点它的标题想【收起】时，
      //   收起动作刚做完，这里又 _foldSetOpen(true) 把它翻回来 ⇒ 表现为"收不起来"。
      //   ⇒ 已经开着的折叠就【别再开一次】：既省一次无谓的调用，也保住用户的手动收起。
      //   ⚠ 别改成"先收起再展开"来强制滚动 —— 那会把用户刚做的收起又覆盖掉。
      if(fold&&typeof fold._foldSetOpen==='function'&&!fold.classList.contains('open'))fold._foldSetOpen(true);
      try{node.scrollIntoView({block:'start',behavior:'smooth'});}
      catch(_){content.scrollTop+=node.getBoundingClientRect().top-content.getBoundingClientRect().top;}
    }
    content.addEventListener('click',event=>{
      const btn=event.target.closest?.('[data-service-tab]');
      if(!btn)return;
      const id=btn.dataset.serviceTab;
      if(!id)return;
      const 目标=content.querySelector('[data-sec-anchor="'+id+'"]');
      if(!目标)return;
      // ⚠⚠⚠ 2026-10-08 修（用户报："有些东西展开了没有办法收起"）——真因就在这里。
      //   Phase C 之后「连接与账号」那四节是【原地折叠】：head 按钮被塞进 section 里面，
      //   而 data-service-tab 从 section 【搬到了 head 上】（card-architecture.js:500）。
      //   ⇒ 点节自己的头时，`content.querySelector('[data-sec-anchor="account"]')` 返回的是
      //     【那个 section】，而 btn 是【section 里的 head 按钮】——两者永远不相等，
      //     所以原来那句"点节本身不用滚"的守门【恒不生效】，一路走到 focusSection(id)，
      //     而 focusSection 会 _foldSetOpen(true) 把用户刚收起的节【又打开】。
      //     实测栈：_foldSetOpen(传 false)[head.onclick] → _foldSetOpen(传 true)[focusSection]
      //             ⇒ 症状就是"收不起来"。
      //   实锤对照（探针打的守门值）：btn是 BUTTON.settings-fold-head / 查到的就是btn吗 false。
      //   ⇒ 判据改成【btn 就在目标节里面】（head 本来就是 section 的孩子），
      //     这样"点自己的头"和"点节内任何地方"都会正确跳过。
      //   ⚠ 别改回 `目标===btn`：那等于又埋一次恒不生效的守门。
      if(目标===btn||目标.contains(btn))return;
      focusSection(id);
    });
    // ⚠ 对外暴露：挂载它的模块要按路由 section 直接滚到某节
    handle.focusSection=focusSection;
  }
  root.V7Workspaces={configure,open,mount,adoptLegacy,confirmUnsaved,close,requestCloseAll,arrangeServices,invalidate,get:id=>active.get(id),all:()=>[...active.values()],hasEmbedded:()=>[...active.values()].some(handle=>handle.dialog.isConnected),hasVisibleEmbedded};
  root.addEventListener?.('wheelchair:storage-context',invalidate);
})(window);
