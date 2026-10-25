// Dedicated local card. No workspace imports, helper boot, timers, or generic IPC.
(() => {
  const names={queued:'排队中',submitting:'提交中',running:'生成中',downloaded:'已下载',processed:'已处理','awaiting-selection':'待选择',placing:'贴回中',done:'完成',error:'失败',cancelled:'已取消'};
  const terminal=new Set(['done','error','cancelled']);
  const status=document.getElementById('status'),list=document.getElementById('jobs');
  function render(snapshot){
    const jobs=Array.isArray(snapshot.jobs)?snapshot.jobs:[];
    const active=jobs.filter(j=>!terminal.has(j.status));
    status.textContent=snapshot.offline?'本机服务未连接；以下为上次读取的状态':`${active.length} 个进行中 · 当前已载入 ${jobs.length} 条`;
    status.classList.toggle('error',!!snapshot.offline);list.replaceChildren();
    const visible=[...active,...jobs.filter(j=>terminal.has(j.status)).sort((a,b)=>b.createdAt-a.createdAt)].slice(0,12);
    for(const j of visible){
      const row=document.createElement('article'),title=document.createElement('strong'),phase=document.createElement('p'),detail=document.createElement('small');
      title.textContent=j.title;phase.textContent=names[j.status]||j.status;phase.className=j.status==='error'?'error':j.status==='done'?'done':'';
      detail.textContent=j.error||j.stage||'';row.append(title,phase,detail);list.append(row);
    }
    if(!visible.length){const empty=document.createElement('p');empty.textContent=snapshot.offline?'等待本机服务恢复':'目前没有任务';list.append(empty);}
    document.getElementById('scope').textContent=`${snapshot.scope||'最近任务'} · ${snapshot.updatedAt?new Date(snapshot.updatedAt).toLocaleTimeString():'尚未更新'}`;
  }
  const guard=fn=>async()=>{try{await fn();}catch(e){status.textContent=e.message||String(e);status.classList.add('error');}};
  document.getElementById('home').onclick=guard(()=>window.bridge.returnToWorkspace());
  document.getElementById('close').onclick=guard(()=>window.bridge.closeFloating());
  window.bridge.onFloatingState(render);
  guard(async()=>render(await window.bridge.floatingState()))();
})();
