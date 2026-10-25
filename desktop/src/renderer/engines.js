(()=>{
 const card=$('engineRun')?.closest('.studio-card');if(!card)return;
 const controls=document.createElement('div');controls.innerHTML=`
  <div class="row"><label class="field">蒙版阈值（0 保留软边）<input id="engineThreshold" type="number" min="0" max="1" step="0.05" value="0"></label><label class="field">中值去噪半径<input id="engineDenoise" type="number" min="0" max="5" step="1" value="0"></label></div>
  <div class="row"><button id="engineProbe">真实推理探测</button><button id="engineStop">停止并等待退出</button></div>
  <details><summary>模型来源、校验与环境管理</summary><pre id="engineCatalog"></pre><p class="mute">当前安装使用 CPU。探测会运行所选已下载模型；不自动下载。移除操作将文件移到应用回收区，可恢复；运行中禁止移除。</p><div class="row"><button id="engineRemoveModel">所选模型移入回收区</button><button id="engineUninstall">环境移入回收区</button></div><div id="engineTrash"></div></details>`;
 card.insertBefore(controls,$('engineRuns'));
 let input=null,modelKey="",operationKey="";
 const guard=fn=>async()=>{try{await fn();}catch(e){toast(reason(e),true);$('engineState').textContent=reason(e);}};
 async function refresh(){
  const s=await api('GET','/engine');const labels={missing:'尚未安装',installing:'正在安装独立环境',downloading:'正在下载并验证模型',ready:'引擎就绪',error:'出错',interrupted:'安装曾中断',probing:'正在真实推理探测',stopped:'已停止',restored:'环境已恢复，待探测'};
  $('engineState').textContent=`${labels[s.phase]||s.phase}${s.error?' · '+s.error:''}`;
  const model=$('engineModel').value;if(modelKey!==JSON.stringify(s.models)){modelKey=JSON.stringify(s.models);$('engineModel').innerHTML=s.models.map(m=>`<option value="${m.id}">${esc(m.name)} · ${m.size} · ${m.installed?'已下载':'未下载'}</option>`).join('');if(model)$('engineModel').value=model;}
  const busy=s.busy||['installing','downloading','probing'].includes(s.phase);$('engineInstall').disabled=busy;$('engineDownload').disabled=busy||!s.ready;
  $('engineProbe').disabled=busy||!s.pythonReady;$('engineRemoveModel').disabled=busy;$('engineUninstall').disabled=busy;
  $('engineCatalog').textContent=JSON.stringify({backend:s.backend,probe:s.probe,models:s.models},null,2);
  $('engineTrash').innerHTML=(s.trash||[]).filter(t=>t.state!=='restored').map(t=>`<div class="engine-trash-item">${esc(t.model||'Python 环境')} · ${esc(new Date(t.createdAt).toLocaleString())} <button data-engine-restore="${esc(t.id)}" ${busy?'disabled':''}>恢复</button></div>`).join('');
  $('engineRun').disabled=busy||!s.ready||s.operations.some(o=>o.status==='running');$('engineLog').textContent=(s.log||[]).join('\n');
  if(operationKey!==JSON.stringify(s.operations)){operationKey=JSON.stringify(s.operations);$('engineRuns').innerHTML=s.operations.slice().reverse().slice(0,10).map(o=>`<article>${esc(o.status==='running'?o.stage:o.status==='done'?'抠像完成':o.error||o.status)} ${o.status==='running'?`<button data-cancel-engine="${o.id}">取消</button>`:''}${o.jobId?`<button data-engine-job="${o.jobId}">查看透明结果</button>`:''}</article>`).join('');}
 }
 $('engineProbe').onclick=guard(async()=>{await api('POST','/engine/probe',{model:$('engineModel').value});await refresh();});
 $('engineStop').onclick=guard(async()=>{await api('POST','/engine/stop');await refresh();});
 $('engineRemoveModel').onclick=guard(async()=>{await api('POST','/engine/uninstall',{target:'model',model:$('engineModel').value});await refresh();});
 $('engineUninstall').onclick=guard(async()=>{await api('POST','/engine/uninstall',{target:'environment'});await refresh();});
 $('engineTrash').onclick=e=>guard(async()=>{if(e.target.dataset.engineRestore){await api('POST','/engine/restore',{id:e.target.dataset.engineRestore});await refresh();}})();
 $('engineInstall').onclick=guard(async()=>{await api('POST','/engine/install');await refresh();});
 $('engineDownload').onclick=guard(async()=>{await api('POST','/engine/download',{model:$('engineModel').value});await refresh();});
 $('engineRefresh').onclick=guard(refresh);
 $('enginePick').onclick=guard(async()=>{const [r]=await window.bridge.pickImages('original',false);if(r){input=r;$('engineInputLabel').textContent=`${r.name} · ${r.width}×${r.height}`;}});
 $('engineFromWork').onclick=guard(()=>{if(!work.input)throw new Error('工作台没有本地原图');input=work.input;$('engineInputLabel').textContent=input.name;});
 $('engineRun').onclick=guard(async()=>{if(!input)throw new Error('先选择照片');await api('POST','/engine/run',{uploadId:input.uploadId,model:$('engineModel').value,erode:Number($('engineErode').value),feather:Number($('engineFeather').value),threshold:Number($('engineThreshold').value),denoise:Number($('engineDenoise').value)});await refresh();});
 $('engineRuns').onclick=e=>guard(async()=>{if(e.target.dataset.cancelEngine){await api('POST','/engine/cancel',{id:e.target.dataset.cancelEngine});await refresh();}if(e.target.dataset.engineJob){await refreshJobs();const j=work.jobs.find(j=>j.id===e.target.dataset.engineJob);if(j)openViewer(j.groupId,j.id);}})();
 document.addEventListener('workspace-tab',e=>{if(e.detail==='studio')guard(refresh)();});
 setInterval(()=>{if(!$('tab-studio').hidden)guard(refresh)();},2500);
})();
