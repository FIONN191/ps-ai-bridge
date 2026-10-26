(function(root){
  'use strict';
  let host={};
  let storageEpoch=0;
  const historyKey=()=>root.WHEELCHAIR_STORAGE?.key('network-diagnostics.v1')||'wheelchair.network-diagnostics.v1';
  // A -> B -> A has the same storage key but is a different operation scope.
  root.addEventListener?.('wheelchair:storage-context',()=>{storageEpoch++;});
  function context(){
    const backend=root.V7Backend?.state?.();
    return {key:historyKey(),epoch:storageEpoch,session:JSON.stringify(backend?[
      backend.baseUrl||'',!!backend.signedIn,backend.account?.id||backend.account?.accountId||'',
      backend.deviceId||'',backend.sessionVersion??null
    ]:null)};
  }
  function sameContext(expected){const current=context();return expected.key===current.key&&expected.epoch===current.epoch&&expected.session===current.session;}
  function stale(){return Object.assign(new Error('账号会话或网络体检页面已变化，已丢弃旧的检查结果'),{code:'NETWORK_DIAGNOSTIC_STALE'});}
  function endpoint(value,suffix){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('服务地址必须是 HTTP/HTTPS，且不能包含账号密码');url.pathname=url.pathname.replace(/\/$/,'')+suffix;url.search='';url.hash='';return url.href;}
  async function request(url){
    let result;if(root.uiwin?.http?.fetch)result=await root.uiwin.http.fetch({url,method:'GET',timeoutMs:5000});
    else{const response=await fetch(url,{signal:AbortSignal.timeout(5000)});result={ok:response.ok,status:response.status,body:await response.text()};}
    if(!result?.ok)throw new Error('HTTP '+(result?.status||'无法连接'));
    return typeof result.body==='string'?JSON.parse(result.body):result.body;
  }
  async function diagnoseFor(expected,active=()=>true){
    const check=()=>{if(!active()||!sameContext(expected))throw stale();};
    check();
    const settings=host.settings?.()||{},rows=[];
    check();
    const probe=async(name,address,route,valid,next)=>{const started=Date.now();let url='';try{check();url=endpoint(address,route);const value=await request(url);check();if(!valid(value))throw new Error('响应格式或服务身份不匹配');return {name,address:new URL(url).origin,status:'ok',elapsedMs:Date.now()-started,message:'连接正常',next:''};}catch(error){check();return {name,address:url?new URL(url).origin:'未配置或地址无效',status:'failed',elapsedMs:Date.now()-started,message:error.message,next};}};
    // ⚠⚠ 2026-10-10 修：原来这里是 `settings.backendUrl || 'http://127.0.0.1:37900'`。
    //   地址为空时它会去探【用户自己这台电脑】的 37900 端口 ——
    //   正式版里本机根本没有我们的后端 ⇒ 体检报告显示"V7 账号与计费服务：连不上"，
    //   用户照着"启动 V7 本地后端"去折腾，而真实原因是**地址没填**。
    //   这是误导性失败：报告说了一件不存在的故障。
    //   ⇒ 地址为空就如实说"没配置"，别去探本机、也别给一条指错方向的建议。
    //   ⚠ 顺带：URL 为空时 endpoint() 里 new URL('') 会抛，现在也一并挡掉。
    const backendJobs = String(settings.backendUrl || '').trim()
      ? [probe('V7 账号与计费服务', settings.backendUrl, '/health',
          v => v?.ok === true && v.service === 'v7-backend',
          '核对「连接与账号」里的后端地址；正式版应指向 https://www.xiasanqi.com。')]
      : [{ name: 'V7 账号与计费服务', address: '未配置', status: 'failed', elapsedMs: 0,
          message: '没有填后端地址', next: '到「连接与账号」里填写后端地址（正式版是 https://www.xiasanqi.com）。' }];
    const jobs = [...backendJobs,
      probe('本机工作流服务', 'http://127.0.0.1:37901', '/health',
        v => v?.ok === true && v.service === 'v7-workflow-data-plane',
        '启动 V7 工作流服务。此项只检查本机；云端状态请查看公告与服务状态。')];
    if(settings.comfyUrl)jobs.push(probe('自己的 ComfyUI',settings.comfyUrl,'/system_stats',v=>!!v?.system&&Array.isArray(v.devices),'确认 ComfyUI 已启动且地址正确；带认证的服务请使用连接工作面的检查按钮。'));
    rows.push(...await Promise.all(jobs));
    check();
    const started=Date.now();
    try{if(!root.uiwin?.link?.status)throw new Error('桌面桥接口不可用');const status=await root.uiwin.link.status();check();const last=Date.parse(status?.bridge?.lastPollAt||'');if(!last||Date.now()-last>=12000)throw new Error('尚未收到 Photoshop 桥的近期响应');rows.push({name:'Photoshop 桥',status:'ok',elapsedMs:Date.now()-started,message:'最近 12 秒内有响应',next:''});}
    catch(error){check();rows.push({name:'Photoshop 桥',status:'failed',elapsedMs:Date.now()-started,message:error.message,next:'打开开始设置，选择 Photoshop 并检查桥接；此项不会修改 Photoshop 文档。'});}
    check();
    return {checkedAt:new Date().toISOString(),rows};
  }
  async function diagnose(){return diagnoseFor(context());}
  function reportText(result){return ['V7 网络体检 · '+result.checkedAt,'仅检查连通性，不执行图片生成、扣费或修改 Photoshop 文档。',...result.rows.map(row=>[row.name,row.status==='ok'?'通过':'未通过',row.address||'',row.elapsedMs+'ms',row.message,row.next].filter(Boolean).join(' · '))].join('\n');}
  function create(container,options={}){
    const render=handle=>{
      const expected=context();let current=true,running=false,unsubscribe=()=>{};
      const active=()=>current&&sameContext(expected);
      const dispose=()=>{if(!current)return;current=false;root.removeEventListener?.('wheelchair:storage-context',invalidate);unsubscribe();};
      const invalidate=()=>{dispose();if(handle.forceClose)handle.forceClose();else handle.close?.();};
      const report=document.createElement('textarea');report.readOnly=true;report.className='network-diagnostic-report';report.setAttribute('aria-label','诊断报告');
      const start=document.createElement('button');start.className='settings-btn';start.textContent='开始检查';start.dataset.networkStart='';
      const copy=document.createElement('button');copy.className='settings-btn';copy.textContent='复制报告';copy.disabled=true;
      const select=document.createElement('select');select.className='settings-btn';select.setAttribute('aria-label','历史检查');let saved=[];
      try{saved=JSON.parse(localStorage.getItem(expected.key)||'[]');if(!Array.isArray(saved))saved=[];}catch(_){saved=[];}
      const renderHistory=()=>{select.replaceChildren();saved.forEach((item,index)=>{const option=document.createElement('option');option.value=index;option.textContent=window.V7Format?(window.V7Format.ago(item.checkedAt)+' · '+window.V7Format.full(item.checkedAt)):new Date(item.checkedAt).toLocaleString('zh-CN');select.append(option);});select.disabled=!saved.length;};
      const show=result=>{report.value=reportText(result);copy.disabled=false;handle.state.textContent=result.rows.filter(row=>row.status==='ok').length+'/'+result.rows.length+' 项通过 · '+new Date(result.checkedAt).toLocaleTimeString('zh-CN');};
      renderHistory();if(saved[0])show(saved[0]);else report.value='点击“开始检查”读取服务状态。';
      select.onchange=()=>{if(active()&&saved[Number(select.value)])show(saved[Number(select.value)]);};
      copy.onclick=async()=>{if(!active())return;try{await navigator.clipboard.writeText(report.value);if(active())handle.state.textContent='报告已复制';}catch(_){if(!active())return;report.focus();report.select();handle.state.textContent='请按 Ctrl+C 复制选中的报告';}};
      start.onclick=async()=>{if(running||!active())return;running=true;start.disabled=true;handle.state.textContent='正在检查…';try{const result=await diagnoseFor(expected,active);if(!active())return;saved=[result,...saved].slice(0,10);localStorage.setItem(expected.key,JSON.stringify(saved));renderHistory();show(result);}catch(error){if(active()&&error?.code!=='NETWORK_DIAGNOSTIC_STALE'){handle.state.textContent=error.message;root.ERR?.report('PROVIDER_TEST_FAILED',{message:error.message});}}finally{running=false;if(active())start.disabled=false;}};
      handle.body.append(report);handle.footer.prepend(select);handle.footer.append(copy,start);
      root.addEventListener?.('wheelchair:storage-context',invalidate);
      unsubscribe=root.V7Backend?.onChange?.(()=>{if(!sameContext(expected))invalidate();})||(()=>{});
      return dispose;
    };
    const args=['network','网络体检','检查本机与已配置服务，报告不包含 Key、密码或账号。',render];
    return container?root.V7Workspaces.mount(container,...args,options):root.V7Workspaces.open(...args);
  }
  root.V7NetworkDoctor={configure:value=>{host=value||{};},open:options=>create(null,options),mount:(container,options)=>create(container,options),diagnose,reportText};
})(window);
