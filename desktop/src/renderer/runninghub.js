(()=>{
 let workflows=[],current=null;
 const sources=[['prompt','提示词','text'],['image','原图','image'],['reference','参考图 1','image'],['seed','随机种子','seed'],['width','输出宽度','width'],['height','输出高度','height']];
 const guard=fn=>async()=>{try{await fn();}catch(e){$('rhStatus').textContent=reason(e);toast(reason(e),true);}};
 function draw(){ $('rhTitle').value=current?.title||'';$('rhWorkflowId').value=current?.workflowId||'';$('rhOutput').value=current?.outputNode||'';
  $('rhMapping').innerHTML=sources.map(([source,label,field])=>{const m=current?.mapping.find(m=>m.source===source);return `<div class="rh-map"><span>${label}</span><input placeholder="节点 ID" data-rh-node="${source}" value="${esc(m?.nodeId||'')}"><input placeholder="字段名" data-rh-field="${source}" value="${esc(m?.fieldName||field)}"></div>`;}).join('');
 }
 async function refresh(){const c=await api('GET','/runninghub');workflows=c.workflows;$('rhUrl').value=c.url;$('rhEnabled').checked=c.enabled;$('rhKey').placeholder=c.hasKey?'已保存，留空保留':'填写自己的 RunningHub Key';$('rhWorkflows').innerHTML='<option value="">新工作流</option>'+workflows.map(w=>`<option value="${w.id}">${esc(w.title)}</option>`).join('');$('rhWorkflows').value=current?.id||'';}
 $('rhWorkflows').onchange=()=>{current=workflows.find(w=>w.id===$('rhWorkflows').value)||null;draw();};
 $('rhConnect').onclick=guard(async()=>{await api('POST','/runninghub/connection',{url:$('rhUrl').value,key:$('rhKey').value,enabled:$('rhEnabled').checked});$('rhKey').value='';await refresh();$('rhStatus').textContent='连接已保存';});
 $('rhTest').onclick=guard(async()=>{const r=await api('POST','/runninghub/test');$('rhStatus').textContent=`账号响应 ${r.latency} ms · 余额 ${r.balance??'服务未提供'} · 活跃任务 ${r.activeTasks??'未知'}`;});
 $('rhSave').onclick=guard(async()=>{const mapping=sources.map(([source])=>({source,nodeId:$('rhMapping').querySelector(`[data-rh-node="${source}"]`).value.trim(),fieldName:$('rhMapping').querySelector(`[data-rh-field="${source}"]`).value.trim()})).filter(m=>m.nodeId);current=await api('POST','/runninghub/workflow',{id:current?.id,title:$('rhTitle').value,workflowId:$('rhWorkflowId').value.trim(),outputNode:$('rhOutput').value.trim(),mapping});await refresh();$('rhStatus').textContent='工作流已保存，在工作台选择 RunningHub 即可运行';});
 document.addEventListener('workspace-tab',e=>{if(e.detail==='studio')guard(refresh)();});draw();
})();
