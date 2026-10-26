(function(root){
  'use strict';
  const core=root.V7LayoutCore,KEY='layout.manager.v1',CANVAS='canvas.v1';
  let host={},state=null,scopeEpoch=0,busy=false,loadPromise=null,ui=null;
  const transactions=new Set();
  let current=core.defaults();
  const clone=value=>structuredClone(value);
  function normalizeLayout(value){
    const normalized=core.normalize(value),recoveryId=host.recoveryCard;
    if(!recoveryId)return normalized;
    const cards=normalized.cards.map(row=>row.id===recoveryId?{...row,hidden:false}:row);
    const active=cards.some(row=>row.id===normalized.active&&!row.hidden)
      ? normalized.active
      : (cards.find(row=>!row.hidden)?.id||'');
    return {...normalized,cards,active};
  }
  const scope=()=>root.WHEELCHAIR_STORAGE.namespaceId();
  function context(){const id=scope(),epoch=scopeEpoch;return {id,name:root.WHEELCHAIR_STORAGE.dbName('presets'),check(){if(id!==scope()||epoch!==scopeEpoch)throw Object.assign(new Error('账号已切换，本次布局操作停止'),{code:'LAYOUT_SCOPE_CHANGED'});}};}
  // ⭐ 2026-10-19：换账号把还在跑的那次【初始化】叫停是正常的（这里自己的守卫 / 预设库都会抛「账号已切换」）——
  //   新账号那次初始化会接着跑。原来照样当「布局失败」报出来：自由摆放测试连着换两次账号时抓到
  //   （tests/free-mode-interactions-ui，报错是预设库的「账号已切换，预设操作已停止」）。
  //   ⚠ 只放过【初始化】被取代这一种；用户自己点的保存 / 应用被打断照常报。
  const superseded=error=>!!error&&(error.code==='LAYOUT_SCOPE_CHANGED'||error.code==='BACKUP_ACCOUNT_CHANGED');
  const reportInitError=error=>{if(!superseded(error))host.error?.(error);};
  function empty(){return {version:1,current:core.defaults(),snapshots:[],undo:null,pendingAppearance:null};}
  // ⭐ 2026-10-21（用户定「布局跟电脑走」）：主卡的排布（顺序 / 显示隐藏 / 改的名字 / 停在哪张）另存一份在【这台电脑】。
  //   原来只跟账号存：登录过期掉回 anonymous（空的那一格）⇒ 卡片顺序、隐藏的卡全变回出厂。
  //   ⚠ 只搬卡片排布：剪影位置跟预设图片绑在一起、「我的布局」快照相当于预设，照旧跟账号走。
  //   ⚠ 搬家：本机这份还没从【真账号】接过（fromAccount 不是 true）⇒ 真账号时用账号现在的排布写进本机并打标记；
  //     开机先站在 anonymous 那一格，那时只临时用，不打标记。
  const machineKey=()=>{const S=root.WHEELCHAIR_STORAGE;return S&&typeof S.localKey==='function'?S.localKey('layout-cards.v1'):null;};
  const signedIn=()=>{const S=root.WHEELCHAIR_STORAGE;return !!(S&&typeof S.isSignedInContext==='function'&&S.isSignedInContext());};
  function machineRead(){const key=machineKey();if(!key)return null;try{const v=JSON.parse(localStorage.getItem(key)||'null');return v&&Array.isArray(v.cards)?v:null;}catch(_){return null;}}
  function machineWrite(layout,fromAccount){const key=machineKey();if(!key)return;try{const prev=machineRead();localStorage.setItem(key,JSON.stringify({cards:layout.cards,active:layout.active,fromAccount:fromAccount===true||prev?.fromAccount===true}));}catch(_){}}
  function withMachineCards(layout,accountHasLayout){
    const local=machineRead();
    if(local?.fromAccount!==true&&signedIn()){
      // 账号里确实存过排布才接过来；没存过（新账号）就留本机现在的 —— 别拿新账号的出厂排布冲掉没登录时调好的
      if(accountHasLayout||!local){machineWrite(layout,true);return layout;}
      machineWrite({cards:local.cards,active:local.active},true);
    }
    if(!local){machineWrite(layout,false);return layout;}
    try{return normalizeLayout({...layout,cards:local.cards,active:local.active||layout.active});}
    catch(_){machineWrite(layout,local.fromAccount===true);return layout;}
  }
  // 换账号那一瞬间（新账号的布局还没读出来）：排布已经跟电脑走了，直接用本机那份，别先闪回出厂
  function machineOrDefaults(){
    const base=core.defaults(),local=machineRead();
    if(!local)return base;
    try{return normalizeLayout({...base,cards:local.cards,active:local.active||base.active});}catch(_){return base;}
  }
  function validateState(value){
    if(!value)return empty();
    if(value.version!==1||!Array.isArray(value.snapshots)||value.snapshots.length>30)throw new Error('本机布局记录损坏，原记录已保留');
    const ids=new Set();
    return {...value,current:normalizeLayout(value.current),undo:value.undo?normalizeLayout(value.undo):null,
      snapshots:value.snapshots.map(row=>{
        if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>80)throw new Error('布局快照记录损坏，原记录已保留');
        ids.add(row.id);return {...row,name:row.name.trim(),layout:normalizeLayout(row.layout)};
      })};
  }
  async function transact(op,write,run){
    op.check();await root.PRESETS.init();op.check();
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(op.name,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{op.check();}catch(error){db.close();throw error;}
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['meta','assets'],write?'readwrite':'readonly');transactions.add(tx);let result,failure;
      const finish=()=>{transactions.delete(tx);db.close();};
      const abort=error=>{failure=error;try{tx.abort();}catch(_){finish();reject(error);}};
      tx.oncomplete=()=>{finish();try{op.check();resolve(result);}catch(error){reject(error);}};
      tx.onabort=tx.onerror=()=>{finish();reject(failure||tx.error||new Error('布局保存失败，原数据未改动'));};
      try{run(tx,value=>{result=value;},abort);}catch(error){abort(error);}
    });
  }
  function notify(){host.applyCards?.(clone(current));}
  async function finishAppearance(op){
    if(!state.pendingAppearance)return;
    op.check();host.applyAppearance(state.pendingAppearance);op.check();
    const next={...state,pendingAppearance:null};
    await transact(op,true,(tx,done)=>{tx.objectStore('meta').put(next,KEY);done(true);});state=next;
  }
  let ready=false;
  async function init(){
    if(loadPromise)return loadPromise;
    const op=context();
    loadPromise=(async()=>{
      const loaded=await transact(op,false,(tx,done)=>{const r=tx.objectStore('meta').get(KEY);r.onsuccess=()=>done(r.result);});
      op.check();state=validateState(loaded);current=withMachineCards(normalizeLayout(state.current),!!loaded);await finishAppearance(op);op.check();notify();ready=true;return clone(current);
    })();
    try{return await loadPromise;}catch(error){if(op.id===scope())loadPromise=null;throw error;}
  }
  function capture(){
    return normalizeLayout({...current,active:host.active?.()||current.active,appearance:host.appearance?.()||{},silhouette:{canvasAspect:root.PRESETS.canvasAspect(),assets:root.PRESETS.assets().map(a=>({id:a.id,name:a.name||'',x:a.x,y:a.y,w:a.w,h:a.h,z:a.z||0,hidden:a.hidden===true,...(typeof a.locked==='boolean'?{locked:a.locked}:{})}))}});
  }
  async function exclusive(action){
    if(busy)throw new Error('正在保存布局，请稍候');busy=true;const op=context();
    try{await init();op.check();return await action(op);}finally{busy=false;}
  }
  async function apply(layout){
    const target=normalizeLayout(layout);
    return exclusive(async op=>{
      const previous=capture(),next={...state,current:target,undo:previous,pendingAppearance:target.appearance};
      const result=await transact(op,true,(tx,done,abort)=>{
        const assets=tx.objectStore('assets'),meta=tx.objectStore('meta'),read=assets.getAll(),canvas=meta.get(CANVAS);let count=2;
        const ready=()=>{if(--count)return;try{
          op.check();const known=new Map(read.result.map(a=>[a.id,a])),missing=[];let changed=false;
          for(const pos of target.silhouette?.assets||[]){const asset=known.get(pos.id);if(!asset){missing.push(pos.id);continue;}
            const merged={...asset,...pos};
            if(Object.keys(pos).some(key=>asset[key]!==pos[key])){assets.put(merged,asset.id);changed=true;}
          }
          if(target.silhouette&&canvas.result?.canvasAspect!==target.silhouette.canvasAspect){meta.put({...canvas.result,canvasAspect:target.silhouette.canvasAspect},CANVAS);changed=true;}
          meta.put(next,KEY);done({missingAssets:missing,changed});
        }catch(error){abort(error);}};read.onsuccess=canvas.onsuccess=ready;
      });
      op.check();state=next;current=target;machineWrite(target,false);notify();await finishAppearance(op);
      if(result.changed){await root.PRESETUI.rebindStorage();op.check();await root.PRESETS.init();op.check();}
      // ⭐ 2026-10-21（docs/261 U6）：快照里带着自由摆放的位置 ⇒ 一起用上；开着自由摆放、快照里却没有 ⇒ 告诉用户为什么卡没动
      const free=root.V7FreeMode;
      if(target.freePlacement&&free?.importPlacement){
        try{free.importPlacement(target.freePlacement);result.freePlacement='applied';}
        catch(error){result.freePlacement='invalid';host.error?.(error);}
      }else if(free?.isActive?.())result.freePlacement='missing';
      return result;
    });
  }
  async function save(name){
    name=String(name||'').trim();if(!name||name.length>80)throw new Error('请填写 1 至 80 字的布局名称');
    return exclusive(async op=>{
      if(state.snapshots.length>=30)throw new Error('最多保存 30 套布局，请先删除不需要的快照');
      // 开着自由摆放时顺手存下每张卡的位置（docs/261 U6）；固定摆放下存的不带这一项
      const placement=root.V7FreeMode?.isActive?.()?root.V7FreeMode.exportPlacement?.():null;
      const row={id:root.crypto.randomUUID(),name,createdAt:new Date().toISOString(),layout:normalizeLayout({...capture(),...(placement?{freePlacement:placement}:{})})},next={...state,snapshots:[...state.snapshots,row]};
      await transact(op,true,(tx,done)=>{tx.objectStore('meta').put(next,KEY);done(true);});state=next;return clone(row);
    });
  }
  async function remove(id){return exclusive(async op=>{const index=state.snapshots.findIndex(row=>row.id===id),removed=index>=0?state.snapshots[index]:null;const next={...state,snapshots:state.snapshots.filter(row=>row.id!==id)};await transact(op,true,(tx,done)=>{tx.objectStore('meta').put(next,KEY);done(true);});state=next;return {removed,index};});}
  // ⭐ 2026-10-22（docs/263 第 6 条「删了能撤销」）：把删掉的快照放回原位
  async function restore(row,index){return exclusive(async op=>{if(!row||state.snapshots.some(r=>r.id===row.id))return;const list=state.snapshots.slice();list.splice(Math.max(0,Math.min(list.length,Number(index)||0)),0,row);const next={...state,snapshots:list};await transact(op,true,(tx,done)=>{tx.objectStore('meta').put(next,KEY);done(true);});state=next;});}
  function status(text,error=false){if(ui){ui.state.textContent=text;ui.state.dataset.error=String(error);}}
  async function operation(action,success){
    const session=ui,epoch=scopeEpoch;
    if(session?.pending)return;
    const controls=session?[...session.dialog.querySelectorAll('button,input')].map(el=>[el,el.disabled]):[];
    if(session){session.pending=true;session.dialog.setAttribute('aria-busy','true');controls.forEach(([el])=>{el.disabled=true;});}
    try{const result=await action();if(session===ui&&epoch===scopeEpoch){
      // Import parsing inserts a confirmation preview into the current body; preserve it until the user decides.
      if(!result||result.preview!==true)render();
      status(typeof success==='function'?success(result):success||'已保存');
    }return result;}
    catch(error){if(session===ui&&epoch===scopeEpoch)status(error.message,true);}
    finally{if(session){session.pending=false;session.dialog.removeAttribute('aria-busy');controls.forEach(([el,disabled])=>{if(el.isConnected)el.disabled=disabled;});if(session===ui)session.footer.querySelector('[data-layout-undo]').disabled=!state?.undo;}}
  }
  function button(text,action){const el=document.createElement('button');el.type='button';el.className='settings-btn';el.textContent=text;el.onclick=action;return el;}
  function section(title){const node=document.createElement('section'),h=document.createElement('h3');node.className='layout-section';h.textContent=title;node.append(h);return node;}
  function render(){
    if(!ui||!state)return;
    const body=ui.body;body.replaceChildren();
    const cards=section('核心卡片'),list=document.createElement('div');list.className='layout-card-list';
    current.cards.forEach((row,index)=>{
      const line=document.createElement('div');line.className='layout-card-row';line.dataset.layoutCard=row.id;
      const reserved=row.id===host.recoveryCard;
      const visible=document.createElement('input');visible.type='checkbox';visible.checked=reserved||!row.hidden;visible.disabled=reserved;visible.setAttribute('aria-label',reserved?'设置页始终保留布局恢复入口':'显示'+row.name);
      const name=document.createElement('input');name.value=row.name;name.maxLength=40;name.setAttribute('aria-label',row.name+'的名称');
      const commit=patch=>{const next=capture();next.cards[index]={...next.cards[index],...patch};operation(()=>apply(next),'卡片布局已保存');};
      visible.onchange=()=>commit({hidden:!visible.checked});name.onchange=()=>commit({name:name.value});
      const move=direction=>{const next=capture();[next.cards[index],next.cards[index+direction]]=[next.cards[index+direction],next.cards[index]];operation(()=>apply(next),'卡片顺序已保存');};
      const up=button('上移',()=>move(-1)),down=button('下移',()=>move(1));up.disabled=index===0;down.disabled=index===current.cards.length-1;
      for(const [control,icon,label] of [[up,'arrowUp','上移'],[down,'arrowDown','下移']]){
        control.classList.add('layout-order-button');control.dataset.layoutMove=label==='上移'?'up':'down';
        control.title=label+row.name;control.setAttribute('aria-label',label+row.name);
        if(root.ICON)control.innerHTML=root.ICON.render(icon,16);
      }
      line.append(visible,name,up,down);list.append(line);
    });cards.append(list);
    const note=document.createElement('p');note.className='settings-note';note.textContent='直接调整主卡的名称、顺序与显示状态。设置卡始终保留，调试卡默认隐藏。剪影位置、尺寸、名称与隐藏状态随布局保存；图片和预设保留在原库。';cards.append(note);
    const snapshots=section('我的布局'),saveRow=document.createElement('form');saveRow.className='layout-save-row';
    const name=document.createElement('input');name.placeholder='例如：修图常用布局';name.maxLength=80;name.setAttribute('aria-label','新布局名称');
    const saveButton=button('保存当前布局',()=>{});saveButton.type='submit';saveRow.append(name,saveButton);saveRow.onsubmit=e=>{e.preventDefault();operation(()=>save(name.value),'布局快照已保存');};snapshots.append(saveRow);
    for(const row of state.snapshots){
      const line=document.createElement('div');line.className='layout-snapshot-row';const title=document.createElement('span');title.textContent=row.name;
      line.append(title,button('应用',()=>operation(()=>apply(row.layout),r=>(r.missingAssets.length?'已应用；'+r.missingAssets.length+' 个剪影在本机不存在，已跳过':'布局已应用')+(r.freePlacement==='applied'?'（含自由摆放位置）':r.freePlacement==='missing'?'。这套布局是在固定摆放下存的，不含自由摆放时各张卡的位置':''))),
        // ⭐ 2026-10-22（docs/263 第 6 条）：不再两步确认 —— 删了立刻生效，弹窗底部给「撤销」放回原位
        button('删除',()=>{const host=ui&&ui.dialog;operation(()=>remove(row.id),'快照已删除').then(r=>{if(r&&r.removed&&root.V7Undo)root.V7Undo.offer('已删除布局快照「'+row.name+'」',()=>operation(()=>restore(r.removed,r.index),'快照已放回'),{host});});}));snapshots.append(line);
    }
    if(!state.snapshots.length){const p=document.createElement('p');p.className='settings-note';p.setAttribute('role','status');p.textContent='还没有保存的布局 · 在上面起个名字，点「保存当前布局」就存下一套。';snapshots.append(p);}
    body.append(cards,snapshots);
    root.V7CardArchitecture?.helpify(body);
    ui.footer.querySelector('[data-layout-undo]').disabled=!state.undo;
  }
  function download(){
    const text=JSON.stringify(capture(),null,2),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');
    link.href=url;link.download='V7-界面布局.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('已导出当前布局；图片与预设不包含在文件中');
  }
  function attach(handle){
      ui=handle;
      const undo=button('撤销上次布局更改',()=>operation(()=>apply(state.undo),'已恢复更改前的布局'));undo.dataset.layoutUndo='';undo.disabled=true;
      const reset=button('恢复默认卡片布局',()=>{const next=capture();next.cards=core.defaults().cards;next.active='generation';operation(()=>apply(next),'核心卡顺序、名称和默认显示已恢复；剪影、图片和预设已保留');});
      const file=document.createElement('input');file.type='file';file.accept='.json,application/json';file.hidden=true;
      const importButton=button('导入布局',()=>file.click());
      file.onchange=()=>{const picked=file.files?.[0],epoch=scopeEpoch;if(!picked)return;file.value='';operation(async()=>{
        if(picked.size>1024*1024)throw new Error('布局文件不能超过 1 MB');const value=core.parse(await picked.text());if(epoch!==scopeEpoch)throw new Error('账号已切换，请重新导入');
        const preview=document.createElement('div');preview.className='layout-import-preview';const p=document.createElement('p');p.textContent='待导入：'+value.cards.filter(row=>!row.hidden).length+' 张可见核心卡、'+(value.silhouette?.assets.length||0)+' 个剪影位置。确认后替换当前布局，可撤销；不导入图片或预设。';
        preview.append(p,button('确认应用导入布局',()=>operation(()=>apply(value),r=>'导入完成'+(r.missingAssets.length?'；跳过 '+r.missingAssets.length+' 个本机没有的剪影':''))),button('取消导入',()=>preview.remove()));
        handle.body.prepend(preview);return {preview:true};
      },'已读取布局，请核对后确认');};
      handle.footer.append(undo,reset,button('导出布局',download),importButton,file);
      init().then(()=>{if(ui===handle)render();}).catch(error=>status(error.message,true));
      return ()=>{if(ui===handle)ui=null;};
  }
  function mount(container){
    if(!container)throw new Error('缺少布局设置容器');
    if(ui?.embedded&&ui.container===container&&ui.dialog.isConnected)return ui.dispose;
    ui?.close();
    const panel=document.createElement('div');panel.className='layout-manager layout-embedded';panel.dataset.layoutManager='';
    panel.setAttribute('aria-label','布局与恢复');
    const body=document.createElement('div');body.className='layout-manager-body';
    const footer=document.createElement('div');footer.className='layout-manager-footer';
    const message=document.createElement('p');message.className='settings-note';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    footer.append(message);panel.append(body,footer);container.append(panel);
    let disposed=false,release=()=>{};
    const dispose=()=>{if(disposed)return;disposed=true;release();panel.remove();};
    const handle={dialog:panel,body,footer,state:message,container,embedded:true,close:dispose,dispose};
    release=attach(handle);return dispose;
  }
  function open(){
    if(typeof host.navigateToLayout==='function')return host.navigateToLayout();
    if(ui?.dialog.isConnected){ui.dialog.querySelector('input,button')?.focus();return ui;}
    ui=null;
    const handle=root.V7Workspaces.open('layout','布局与恢复','调整核心卡片；保存、切换和恢复你的工作布局。',handle=>{
      handle.dialog.classList.add('layout-workspace','layout-manager');return attach(handle);
    });return handle;
  }
  root.addEventListener('wheelchair:storage-context',()=>{
    scopeEpoch++;ready=false;for(const tx of transactions){try{tx.abort();}catch(_){}}
    ui?.close();state=null;loadPromise=null;current=machineOrDefaults();notify();
    // Account's preset store rebind listener runs in the same event dispatch.
    queueMicrotask(()=>init().catch(reportInitError));
  });
  function configure(options){
    host=options;
    init().catch(reportInitError);
  }
  root.V7LayoutManager={configure,init,isReady:()=>ready,mount,open,apply,save,remove,capture,current:()=>clone(current),snapshots:()=>clone(state?.snapshots||[]),undo:()=>state?.undo?apply(state.undo):Promise.reject(new Error('没有可恢复的布局')),core};
})(window);
