(()=>{
 let input=null,modelKey="",operationKey="";
 const guard=fn=>async()=>{try{await fn();}catch(e){toast(reason(e),true);$('engineState').textContent=reason(e);}};
 async function refresh(){
  const s=await api('GET','/engine');const labels={missing:'尚未安装',installing:'正在安装独立环境',downloading:'正在下载并验证模型',ready:'引擎就绪',error:'出错',interrupted:'安装曾中断'};
  $('engineState').textContent=`${labels[s.phase]||s.phase}${s.error?' · '+s.error:''}`;
  const model=$('engineModel').value;if(modelKey!==JSON.stringify(s.models)){modelKey=JSON.stringify(s.models);$('engineModel').innerHTML=s.models.map(m=>`<option value="${m.id}">${esc(m.name)} · ${m.size} · ${m.installed?'已下载':'未下载'}</option>`).join('');if(model)$('engineModel').value=model;}
  const busy=['installing','downloading'].includes(s.phase);$('engineInstall').disabled=busy;$('engineDownload').disabled=busy||!s.ready;
  $('engineRun').disabled=busy||!s.ready||s.operations.some(o=>o.status==='running');$('engineLog').textContent=(s.log||[]).join('\n');
  if(operationKey!==JSON.stringify(s.operations)){operationKey=JSON.stringify(s.operations);$('engineRuns').innerHTML=s.operations.slice().reverse().slice(0,10).map(o=>`<article>${esc(o.status==='running'?o.stage:o.status==='done'?'抠像完成':o.error||o.status)} ${o.status==='running'?`<button data-cancel-engine="${o.id}">取消</button>`:''}${o.jobId?`<button data-engine-job="${o.jobId}">查看透明结果</button>`:''}</article>`).join('');}
 }
 $('engineInstall').onclick=guard(async()=>{await api('POST','/engine/install');await refresh();});
 $('engineDownload').onclick=guard(async()=>{await api('POST','/engine/download',{model:$('engineModel').value});await refresh();});
 $('engineRefresh').onclick=guard(refresh);
 $('enginePick').onclick=guard(async()=>{const [r]=await window.bridge.pickImages('original',false);if(r){input=r;$('engineInputLabel').textContent=`${r.name} · ${r.width}×${r.height}`;}});
 $('engineFromWork').onclick=guard(()=>{if(!work.input)throw new Error('工作台没有本地原图');input=work.input;$('engineInputLabel').textContent=input.name;});
 $('engineRun').onclick=guard(async()=>{if(!input)throw new Error('先选择照片');await api('POST','/engine/run',{uploadId:input.uploadId,model:$('engineModel').value,erode:Number($('engineErode').value),feather:Number($('engineFeather').value)});await refresh();});
 $('engineRuns').onclick=e=>guard(async()=>{if(e.target.dataset.cancelEngine){await api('POST','/engine/cancel',{id:e.target.dataset.cancelEngine});await refresh();}if(e.target.dataset.engineJob){await refreshJobs();const j=work.jobs.find(j=>j.id===e.target.dataset.engineJob);if(j)openViewer(j.groupId,j.id);}})();
 document.addEventListener('workspace-tab',e=>{if(e.detail==='studio')guard(refresh)();});
 setInterval(()=>{if(!$('tab-studio').hidden)guard(refresh)();},2500);
})();
