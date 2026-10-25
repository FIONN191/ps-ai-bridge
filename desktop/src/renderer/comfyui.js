(()=>{
 let workflows=[],current=null,mappings=[];
 const guard=fn=>async()=>{try{await fn();}catch(e){$('comfyStatus').textContent=reason(e);toast(reason(e),true);}};
 async function refresh(){const d=await api('GET','/comfyui');workflows=d.workflows;$('comfyUrl').value=d.connection.url;$('comfyEnabled').checked=d.connection.enabled;$('comfyKey').placeholder=d.connection.hasKey?'已保存密钥，留空保留':'不需要认证可留空';const id=current?.id||'';$('comfyWorkflows').innerHTML='<option value="">新工作流</option>'+workflows.map(w=>`<option value="${w.id}">${esc(w.title)}</option>`).join('');$('comfyWorkflows').value=id;}
 $('comfyConnect').onclick=guard(async()=>{await api('POST','/comfyui/connection',{url:$('comfyUrl').value,key:$('comfyKey').value,enabled:$('comfyEnabled').checked});$('comfyKey').value='';await refresh();$('comfyStatus').textContent='连接已保存，点击检测服务验证可用性';});
 $('comfyTest').onclick=guard(async()=>{const d=await api('POST','/comfyui/test');$('comfyStatus').textContent=`服务响应 ${d.latency} ms · ${d.devices.map(x=>x.name).join('、')||'设备未报告'}`;});
 function draw(){if(!current){$('comfyTitle').value='';$('comfyMapping').innerHTML='';return;}$('comfyTitle').value=current.title||'';
  const nodes=Object.entries(current.prompt||{});$('comfyOutput').innerHTML='<option value="">自动（仅单张输出）</option>'+nodes.map(([id,n])=>`<option value="${esc(id)}">${esc(id)} · ${esc(n._meta?.title||n.class_type)}</option>`).join('');$('comfyOutput').value=current.outputNode||'';
  mappings=[];for(const[node,n]of nodes)for(const[field,value]of Object.entries(n.inputs||{})){if(Array.isArray(value)||typeof value==='object')continue;const saved=(current.mapping||[]).find(m=>m.node===node&&m.field===field);mappings.push({node,field,value,...saved,source:saved?.source||''});}
  $('comfyMapping').innerHTML=mappings.map((m,i)=>`<div class="workflow-map"><span title="${esc(m.value)}">${esc(m.node)} · ${esc(m.field)}</span><select data-map="${i}">${[['','保留工作流值'],['prompt','工作台提示词'],['image','原图'],['reference','参考图 1'],['seed','随机种子'],['width','输出宽度'],['height','输出高度']].map(([v,label])=>`<option value="${v}" ${m.source===v?'selected':''}>${label}</option>`).join('')}</select></div>`).join('');
 }
 $('comfyWorkflows').onchange=()=>{current=workflows.find(w=>w.id===$('comfyWorkflows').value)||null;draw();};
 $('comfyImport').onclick=guard(async()=>{const f=await window.bridge.openPack();if(!f)return;const prompt=f.data?.prompt||f.data;if(!prompt||typeof prompt!=='object'||Array.isArray(prompt)||prompt.nodes||!Object.values(prompt).every(n=>n?.class_type&&n.inputs))throw new Error('请选择 ComfyUI 导出的 API 格式 JSON');current={title:f.name.replace(/\.json$/i,''),prompt,mapping:[]};draw();});
 $('comfyMapping').onchange=e=>{if(e.target.dataset.map!=null)mappings[Number(e.target.dataset.map)].source=e.target.value;};
 $('comfyInspect').onclick=guard(async()=>{if(!current)throw new Error('先导入工作流');const d=await api('POST','/comfyui/inspect',{prompt:current.prompt});$('comfyStatus').textContent=d.ok?'节点与枚举参数检查通过；实际推理仍需生成验证':`缺失节点：${d.missing.map(x=>x.type).join('、')||'无'}；不可用模型或参数：${d.invalid.map(x=>`${x.node}.${x.field}=${x.value}`).join('、')||'无'}`;});
 $('comfySave').onclick=guard(async()=>{if(!current)throw new Error('先导入工作流');current=await api('POST','/comfyui/save',{...current,title:$('comfyTitle').value,outputNode:$('comfyOutput').value,mapping:mappings.filter(m=>m.source)});await refresh();$('comfyStatus').textContent='已保存，可以在工作台选择 ComfyUI 和此工作流';});
 document.addEventListener('workspace-tab',e=>{if(e.detail==='studio')guard(refresh)();});
})();
