/* Loaded by the parent after workspace.js; append to the existing tools page. */
(()=>{
 const host=document.querySelector('#tab-studio .studio-grid');if(!host||document.getElementById('modelToolCard'))return;
 const make=(id,title,html)=>{const el=document.createElement('article');el.id=id;el.className='studio-card model-tools-card';el.innerHTML=`<h3>${title}</h3>${html}`;host.append(el);return el;};
 make('forgeCard','Forge / A1111',`
  <p class="mute">连接启用 --api 的自有服务。只导入可表达的参数；模型、LoRA 与 ControlNet 逐项检查，不承诺转换等价。</p>
  <label class="field">地址<input id="forgeUrl" value="http://127.0.0.1:7860"></label>
  <div class="row"><label class="field">API 用户名<input id="forgeUser" autocomplete="off"></label><label class="field">API 密码<input id="forgePassword" type="password" autocomplete="off" placeholder="留空保留"></label></div>
  <label class="check"><input id="forgeEnabled" type="checkbox">启用连接</label><label class="check"><input id="forgeClearPassword" type="checkbox">清除已保存密码</label>
  <div class="row"><button id="forgeConnect">保存连接</button><button id="forgeInspect">检查服务与模型</button></div>
  <select id="forgePresets"><option value="">新预设</option></select><label class="field">预设名称<input id="forgeTitle"></label>
  <label class="field">参数 JSON<textarea id="forgeJson" rows="9" spellcheck="false"></textarea></label>
  <details><summary>支持格式 / 不兼容项</summary><p class="mute">model 为服务的 checkpoint title。LoRA: [{"name":"名称","weight":0.8}]。ControlNet: [{"model":"模型名称","module":"none","source":"image"}]；参考图用 source:"reference", index:0。任意脚本、画布工作流、未知参数都会列为不兼容，不会静默转换。</p></details>
  <div class="row"><button id="forgeImportFile">读取参数文件</button><button id="forgePreflight">生成导入报告</button><button id="forgeSave">检查并保存预设</button></div>
  <pre id="forgeReport" role="status" aria-live="polite"></pre>`);
 make('modelToolCard','语义选区与专用增强',`
  <p class="mute">使用你导入的真实 ComfyUI 模型工作流。先在 ComfyUI 卡片映射原图入口；本页将任务输入绑定到明确的节点字面量字段。Qwen 仅作为用户工作流分类，能力取决于实际节点与权重。</p>
  <div class="row"><select id="mtBindings"><option value="">新绑定</option></select><button id="mtRefresh">刷新工作流</button></div>
  <label class="field">绑定名称<input id="mtTitle"></label>
  <div class="row"><label class="field">任务角色<select id="mtRole"><option value="segmentation">语义选区 / 人体部位</option><option value="enhancement">专用增强</option></select></label><label class="field">工作流分类<select id="mtFamily"><option value="user">用户模型工作流</option><option value="qwen">Qwen 用户工作流</option></select></label></div>
  <label class="field">已导入工作流<select id="mtWorkflow"></select></label>
  <div class="row"><label class="field">输出节点<select id="mtOutputNode"></select></label><label class="field">输出类型<select id="mtOutput"><option value="gray">灰度蒙版</option><option value="alpha">透明通道</option><option value="image">增强图像</option></select></label></div>
  <details><summary>查看实际字面量字段与 JSON 指南</summary><pre id="mtFields"></pre><p class="mute">points 使用原图像素 [{"x":120,"y":240,"label":1}]，label 1 包含、0 排除；box 为 [x1,y1,x2,y2]。人体部位 includeParts / excludeParts 使用节点认可的名称数组。数组须绑定接收 JSON 字符串的字段，并使用 encoding:"json"。文本/数字使用 encoding:"value"；部位逗号列表可用 "csv"。不能覆盖节点连接。</p></details>
  <label class="field">任务输入 → 字段映射 JSON<textarea id="mtMappings" rows="6" spellcheck="false"></textarea></label>
  <div class="row"><button id="mtSave">保存任务绑定</button><button id="mtRemove">移除绑定</button></div>
  <div class="row"><button id="mtPick">选择原图</button><button id="mtFromWork">工作台原图</button><span id="mtInputLabel" class="mute">未选择</span></div>
  <div class="mt-preview"><canvas id="mtCanvas" width="800" height="450" aria-label="原图选区画布：点击标记包含或排除点，框选模式拖动绘制矩形"></canvas><p id="mtEmpty" class="mute">先选择原图，再添加选区条件</p></div>
  <p id="mtCoordinates" class="mute" aria-live="polite">坐标使用已上传原图的像素，不受预览缩放影响。</p>
  <div id="mtSelectionControls">
    <div class="row"><label class="field">画布操作<select id="mtPointerMode"><option value="include">包含点 ＋</option><option value="exclude">排除点 −</option><option value="box">拖动框选</option></select></label><button id="mtUndoPoint">撤销末点</button><button id="mtClearPoints">清除点</button><button id="mtClearBox">清除框</button></div>
    <div id="mtPoints" class="mt-point-list"></div>
    <label class="field">文字选区<input id="mtText" placeholder="例如：只选人物头发"></label>
    <details open><summary>人体部位（名称须与所选模型节点一致）</summary><div id="mtParts" class="mt-parts"></div>
      <div class="row"><label class="field">其他包含部位（逗号分隔）<input id="mtIncludeCustom" placeholder="节点认可的精确名称"></label><label class="field">其他排除部位（逗号分隔）<input id="mtExcludeCustom" placeholder="节点认可的精确名称"></label></div>
    </details>
    <button id="mtResetSelection">重置全部选区条件</button>
  </div>
  <div id="mtEnhancementControls" hidden><label class="field">专用 upscaler 模型<input id="mtUpscaler" placeholder="所选工作流支持的模型文件名"></label><label class="field">倍率（工作流需绑定 scale）<input id="mtScale" type="number" min="1" max="8" step="0.5" value="2"></label></div>
  <p id="mtBindingSupport" class="mute"></p>
  <details><summary>高级：本次任务输入 JSON</summary><label class="field">与可视化控件共享同一组输入<textarea id="mtInputs" rows="6" spellcheck="false"></textarea></label><button id="mtApplyJson">将 JSON 应用到画布与控件</button></details>
  <p class="mute" id="mtHint">选区必须输出与原图同尺寸的灰度蒙版或 alpha，结果保留原图已有透明度。</p>
  <div class="row"><button id="mtInspect">检查任务依赖</button><button id="mtRun" class="primary">运行所选模型工作流</button><button id="mtView" hidden>查看任务</button></div>
  <pre id="mtStatus" role="status" aria-live="polite"></pre>`);
 let current=null,data={bindings:[],workflows:[]},forgeData={presets:[]},input=null,jobId=null;
 let preview=null,imageRevision=0,drag=null,visual={};
 const partChoices=[['hair','头发'],['face','脸'],['neck','颈部'],['torso','躯干'],['arms','手臂'],['hands','手'],['legs','腿'],['feet','脚'],['clothes','衣物'],['background','背景']];
 const guard=(status,fn)=>async()=>{try{await fn();}catch(e){$(status).textContent=reason(e);toast(reason(e),true);}};
 const json=id=>{try{return JSON.parse($(id).value);}catch{throw new Error(`${id==='mtMappings'?'映射':id==='mtInputs'?'任务输入':'参数'} JSON 格式无效`);}};
 const show=(id,value)=>{$(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2);};
 const options=(list,value,label)=>list.map(x=>`<option value="${esc(value(x))}">${esc(label(x))}</option>`).join('');
 function fields(){const w=data.workflows.find(w=>w.id===$('mtWorkflow').value),selected=$('mtOutputNode').value;
  $('mtOutputNode').innerHTML=w?options(Object.entries(w.prompt),x=>x[0],x=>`${x[0]} · ${x[1].class_type}`):'';
  if(w?.prompt[selected])$('mtOutputNode').value=selected;
  show('mtFields',w?Object.entries(w.prompt).flatMap(([node,n])=>Object.entries(n.inputs).filter(([,v])=>v===null||typeof v!=='object').map(([field,value])=>({node,field,value,type:typeof value,nodeType:n.class_type}))):[]);
 }
 function roleHint(){const enhance=$('mtRole').value==='enhancement';$('mtHint').textContent=enhance?'必须明确选择 upscaler 模型名称并绑定实际模型加载字段。运行前检查节点与权重依赖；不标记为 DLSS。':'坐标为原图像素；只接受同尺寸 gray / alpha 输出，保留原始透明度。';}
 function drawBinding(){current=data.bindings.find(b=>b.id===$('mtBindings').value)||null;
  $('mtTitle').value=current?.title||'';$('mtRole').value=current?.role||'segmentation';$('mtFamily').value=current?.family||'user';
  if(current)$('mtWorkflow').value=current.workflowId;fields();if(current)$('mtOutputNode').value=current.outputNode;
  $('mtOutput').value=current?.output||'gray';$('mtMappings').value=JSON.stringify(current?.mappings||[{source:'text',node:'6',field:'text',encoding:'value'}],null,2);
  $('mtInputs').value=JSON.stringify(emptyInputs(),null,2);roleHint();syncVisual();bindingControls();
 }
 async function refreshTools(){const selected=$('mtBindings').value,wid=$('mtWorkflow').value;data=await api('GET','/model-tools');
  $('mtBindings').innerHTML='<option value="">新绑定</option>'+options(data.bindings,b=>b.id,b=>b.title);$('mtBindings').value=selected;
  $('mtWorkflow').innerHTML='<option value="">选择已导入工作流</option>'+options(data.workflows,w=>w.id,w=>w.title);$('mtWorkflow').value=wid;fields();
 }
 async function refreshForge(){const selected=$('forgePresets').value;forgeData=await api('GET','/forge');const c=forgeData.connection;
  $('forgeUrl').value=c.url;$('forgeUser').value=c.username||'';$('forgeEnabled').checked=c.enabled;$('forgePassword').placeholder=c.hasPassword?'已保存，留空保留':'可选';
  $('forgePresets').innerHTML='<option value="">新预设</option>'+options(forgeData.presets,p=>p.id,p=>p.title);$('forgePresets').value=selected;
 }
 $('forgeJson').value=JSON.stringify({model:'填写服务返回的 checkpoint title',steps:20,cfg_scale:7,denoising_strength:0.35,loras:[],controlnet:[]},null,2);
 $('forgeConnect').onclick=guard('forgeReport',async()=>{await api('POST','/forge/connection',{url:$('forgeUrl').value,username:$('forgeUser').value,password:$('forgePassword').value,clearPassword:$('forgeClearPassword').checked,enabled:$('forgeEnabled').checked});$('forgePassword').value='';$('forgeClearPassword').checked=false;await refreshForge();show('forgeReport','连接已保存；请检查服务验证可用性');});
 $('forgeInspect').onclick=guard('forgeReport',async()=>show('forgeReport',await api('POST','/forge/inspect')));
 $('forgePreflight').onclick=guard('forgeReport',async()=>show('forgeReport',await api('POST','/forge/preflight',{preset:json('forgeJson')})));
 $('forgeImportFile').onclick=guard('forgeReport',async()=>{const f=await window.bridge.openPack();if(f){$('forgeJson').value=JSON.stringify(f.data,null,2);$('forgeTitle').value=f.name.replace(/\.json$/i,'');$('forgePresets').value='';show('forgeReport','已读取文件；请生成导入报告');}});
 $('forgeSave').onclick=guard('forgeReport',async()=>{const p=await api('POST','/forge/import',{id:$('forgePresets').value||undefined,title:$('forgeTitle').value,preset:json('forgeJson')});await refreshForge();$('forgePresets').value=p.id;show('forgeReport',p.report);});
 $('forgePresets').onchange=()=>{const p=forgeData.presets.find(p=>p.id===$('forgePresets').value);$('forgeTitle').value=p?.title||'';if(p)$('forgeJson').value=JSON.stringify(p.parameters,null,2);};
 $('mtRefresh').onclick=guard('mtStatus',refreshTools);$('mtBindings').onchange=guard('mtStatus',drawBinding);$('mtWorkflow').onchange=guard('mtStatus',fields);
 $('mtRole').onchange=()=>{$('mtOutput').value=$('mtRole').value==='enhancement'?'image':'gray';roleHint();bindingControls();};
 $('mtSave').onclick=guard('mtStatus',async()=>{const b=await api('POST','/model-tools/save',{id:current?.id,title:$('mtTitle').value,role:$('mtRole').value,family:$('mtFamily').value,workflowId:$('mtWorkflow').value,outputNode:$('mtOutputNode').value,output:$('mtOutput').value,mappings:json('mtMappings')});await refreshTools();$('mtBindings').value=b.id;current=b;mergeMappedDefaults();bindingControls();show('mtStatus','任务绑定已保存，运行前请检查本次输入和依赖');});
 $('mtRemove').onclick=guard('mtStatus',async()=>{if(!current)throw new Error('先选择绑定');await api('POST','/model-tools/remove',{id:current.id});current=null;await refreshTools();drawBinding();show('mtStatus','绑定已移除，原工作流保留');});
 $('mtPick').onclick=guard('mtStatus',async()=>{const [r]=await window.bridge.pickImages('original',false);if(r)await setSource(r);});
 $('mtFromWork').onclick=guard('mtStatus',async()=>{if(!work.input)throw new Error('工作台没有本地原图');await setSource(work.input);});
 const taskBody=()=>{if(!current||current.id!==$('mtBindings').value)throw new Error('先保存并选择绑定');if(current.workflowId!==$('mtWorkflow').value||current.role!==$('mtRole').value||current.outputNode!==$('mtOutputNode').value||current.output!==$('mtOutput').value||JSON.stringify(current.mappings)!==JSON.stringify(json('mtMappings')))throw new Error('绑定配置已修改，请先保存再运行');syncVisual();return {id:current.id,inputs:json('mtInputs'),uploadId:input?.uploadId};};
 $('mtInspect').onclick=guard('mtStatus',async()=>show('mtStatus',await api('POST','/model-tools/inspect',taskBody())));
 $('mtRun').onclick=guard('mtStatus',async()=>{if(!input)throw new Error('先选择原图');const body=taskBody();$('mtRun').disabled=true;try{const j=await api('POST','/model-tools/run',body);jobId=j.id;$('mtView').hidden=false;show('mtStatus',`已创建任务 ${j.id}；进度与错误见任务列表`);await refreshJobs();}finally{$('mtRun').disabled=false;}});
 $('mtView').onclick=guard('mtStatus',async()=>{await refreshJobs();const j=work.jobs.find(j=>j.id===jobId);if(!j)throw new Error('任务暂未出现在列表，请刷新');openViewer(j.groupId,j.id);});
 // The display buffer is bounded for memory use; input coordinates are ALWAYS
 // obtained from the loaded image's natural size and the current CSS rectangle.
 function emptyInputs(){const result={};for(const m of current?.mappings||[])result[m.source]=m.source==='scale'?2:['points','box','includeParts','excludeParts'].includes(m.source)?[]:'';return result;}
 function supports(source){return current?.role===$('mtRole').value&&current?.mappings.some(m=>m.source===source);}
 function mergeMappedDefaults(){const v=json('mtInputs');$('mtInputs').value=JSON.stringify({...emptyInputs(),...v},null,2);syncVisual();}
 function bindingControls(){
  const enhance=$('mtRole').value==='enhancement';$('mtSelectionControls').hidden=enhance;$('mtEnhancementControls').hidden=!enhance;
  for(const o of $('mtPointerMode').options)o.disabled=!supports(o.value==='box'?'box':'points');
  if($('mtPointerMode').selectedOptions[0]?.disabled){const option=[...$('mtPointerMode').options].find(o=>!o.disabled);if(option)$('mtPointerMode').value=option.value;}
  $('mtText').disabled=!supports('text');$('mtUpscaler').disabled=!supports('upscaler');$('mtScale').disabled=!supports('scale');
  $('mtIncludeCustom').disabled=!supports('includeParts');$('mtExcludeCustom').disabled=!supports('excludeParts');
  for(const box of $('mtParts').querySelectorAll('input'))box.disabled=!supports(box.dataset.partSide);
  $('mtBindingSupport').textContent=current?`当前已保存绑定支持：${[...new Set(current.mappings.map(m=>m.source))].join('、')}。未绑定的控件不可用；请在上方配置真实节点字段后保存。`:'先选择或保存模型工作流绑定；画布操作不会替代分割模型。';
  $('mtCanvas').classList.toggle('mt-disabled',enhance||(!supports('points')&&!supports('box')));
 }
 function validateVisual(v){
  if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('任务输入必须是 JSON 对象');
  if(v.points!==undefined&&(!Array.isArray(v.points)||v.points.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||![0,1].includes(p.label))))throw new Error('points 需要 {x,y,label:0或1} 数组');
  if(v.box!==undefined&&(!Array.isArray(v.box)||(v.box.length!==0&&(v.box.length!==4||v.box.some(n=>!Number.isFinite(n)||n<0)||v.box[2]<=v.box[0]||v.box[3]<=v.box[1]))))throw new Error('box 需要 [x1,y1,x2,y2] 或空数组');
  for(const key of ['includeParts','excludeParts'])if(v[key]!==undefined&&(!Array.isArray(v[key])||v[key].some(x=>typeof x!=='string')))throw new Error(`${key} 必须是名称数组`);
  if(preview&&((v.points||[]).some(p=>p.x>=preview.naturalWidth||p.y>=preview.naturalHeight)||(v.box?.length&&(v.box[2]>preview.naturalWidth||v.box[3]>preview.naturalHeight))))throw new Error('选区坐标超出已上传原图');
  return v;
 }
 function syncVisual(){
  visual=validateVisual(json('mtInputs'));$('mtText').value=visual.text||'';$('mtUpscaler').value=visual.upscaler||'';$('mtScale').value=visual.scale??2;
  for(const box of $('mtParts').querySelectorAll('input'))box.checked=(visual[box.dataset.partSide]||[]).includes(box.dataset.part);
  const common=new Set(partChoices.map(p=>p[0]));$('mtIncludeCustom').value=(visual.includeParts||[]).filter(p=>!common.has(p)).join(', ');$('mtExcludeCustom').value=(visual.excludeParts||[]).filter(p=>!common.has(p)).join(', ');
  $('mtPoints').innerHTML=(visual.points||[]).map((p,i)=>`<button type="button" data-remove-point="${i}" class="${p.label?'mt-positive':'mt-negative'}" title="删除此点">${p.label?'＋':'−'} ${i+1} · (${p.x}, ${p.y}) ×</button>`).join('');drawCanvas();
 }
 function updateInputs(change){const next=validateVisual(json('mtInputs'));change(next);validateVisual(next);$('mtInputs').value=JSON.stringify(next,null,2);syncVisual();}
 function clearGeometry(v){for(const key of ['points','box']){if(Object.hasOwn(v,key)||supports(key))v[key]=[];}}
 async function setSource(r){
  const values=json('mtInputs'),revision=++imageRevision,img=new Image();
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('原图预览加载失败，请重新选择'));img.src=url(`/uploads/${encodeURIComponent(r.uploadId)}`);});
  if(revision!==imageRevision)return;
  clearGeometry(values);preview=img;input={...r,width:img.naturalWidth,height:img.naturalHeight};drag=null;
  const canvas=$('mtCanvas'),scale=Math.min(1,1400/img.naturalWidth,1000/img.naturalHeight);canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
  $('mtEmpty').hidden=true;$('mtInputLabel').textContent=`${r.name||'原图'} · ${img.naturalWidth}×${img.naturalHeight}`;
  $('mtCoordinates').textContent=`原图 ${img.naturalWidth}×${img.naturalHeight} 像素；更换图片已清除点与框。`;
  $('mtInputs').value=JSON.stringify(values,null,2);syncVisual();
 }
 function coordinate(event,edge=false){const b=$('mtCanvas').getBoundingClientRect();if(!preview||!b.width||!b.height)throw new Error('先加载原图');
  const x=Math.max(0,Math.min(preview.naturalWidth,(event.clientX-b.left)/b.width*preview.naturalWidth));
  const y=Math.max(0,Math.min(preview.naturalHeight,(event.clientY-b.top)/b.height*preview.naturalHeight));
  return edge?{x,y}:{x:Math.min(preview.naturalWidth-1,Math.floor(x)),y:Math.min(preview.naturalHeight-1,Math.floor(y))};
 }
 function boxBetween(a,b){return [Math.floor(Math.min(a.x,b.x)),Math.floor(Math.min(a.y,b.y)),Math.ceil(Math.max(a.x,b.x)),Math.ceil(Math.max(a.y,b.y))];}
 function drawCanvas(){const canvas=$('mtCanvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!preview)return;
  ctx.drawImage(preview,0,0,canvas.width,canvas.height);const sx=canvas.width/preview.naturalWidth,sy=canvas.height/preview.naturalHeight,unit=canvas.width/(canvas.getBoundingClientRect().width||canvas.width);
  const box=drag?.mode==='box'?boxBetween(drag.start,drag.end):visual.box;
  if(box?.length===4){ctx.fillStyle='rgba(85,170,255,.14)';ctx.strokeStyle='#55aaff';ctx.lineWidth=2*unit;ctx.fillRect(box[0]*sx,box[1]*sy,(box[2]-box[0])*sx,(box[3]-box[1])*sy);ctx.strokeRect(box[0]*sx,box[1]*sy,(box[2]-box[0])*sx,(box[3]-box[1])*sy);}
  for(const [i,p]of (visual.points||[]).entries()){const x=(p.x+.5)*sx,y=(p.y+.5)*sy;ctx.beginPath();ctx.arc(x,y,8*unit,0,2*Math.PI);ctx.fillStyle=p.label?'#117a4a':'#b52d45';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1.5*unit;ctx.stroke();ctx.fillStyle='#fff';ctx.font=`bold ${10*unit}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(`${p.label?'+':'−'}${i+1}`,x,y);}
 }
 $('mtParts').innerHTML='<div class="mt-part-head">节点名称</div><div>包含</div><div>排除</div>'+partChoices.map(([id,label])=>`<span>${label} <small>${id}</small></span><input type="checkbox" aria-label="包含${label}" data-part="${id}" data-part-side="includeParts"><input type="checkbox" aria-label="排除${label}" data-part="${id}" data-part-side="excludeParts">`).join('');
 $('mtParts').onchange=event=>guard('mtStatus',()=>{const box=event.target;if(!box.dataset.part)return;updateInputs(v=>{const key=box.dataset.partSide,other=key==='includeParts'?'excludeParts':'includeParts';v[key]=[...new Set([...(v[key]||[]).filter(p=>p!==box.dataset.part),...(box.checked?[box.dataset.part]:[])])];if(box.checked&&v[other])v[other]=v[other].filter(p=>p!==box.dataset.part);});})();
 for(const [id,key]of [['mtText','text'],['mtUpscaler','upscaler'],['mtScale','scale']])$(id).oninput=guard('mtStatus',()=>updateInputs(v=>{v[key]=key==='scale'?Number($(id).value):$(id).value;}));
 for(const [id,key]of [['mtIncludeCustom','includeParts'],['mtExcludeCustom','excludeParts']])$(id).onchange=guard('mtStatus',()=>updateInputs(v=>{const common=new Set(partChoices.map(p=>p[0])),custom=$(id).value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);v[key]=[...new Set([...(v[key]||[]).filter(p=>common.has(p)),...custom])];const other=key==='includeParts'?'excludeParts':'includeParts';if(v[other])v[other]=v[other].filter(p=>!v[key].includes(p));}));
 $('mtUndoPoint').onclick=guard('mtStatus',()=>updateInputs(v=>{if(v.points?.length)v.points.pop();}));
 $('mtClearPoints').onclick=guard('mtStatus',()=>updateInputs(v=>{if(v.points||supports('points'))v.points=[];}));
 $('mtClearBox').onclick=guard('mtStatus',()=>{drag=null;updateInputs(v=>{if(v.box||supports('box'))v.box=[];});});
 $('mtResetSelection').onclick=guard('mtStatus',()=>{drag=null;updateInputs(v=>{for(const k of ['points','box','text','includeParts','excludeParts'])if(Object.hasOwn(v,k)||supports(k))v[k]=k==='text'?'':[];});});
 $('mtPoints').onclick=event=>guard('mtStatus',()=>{const button=event.target.closest('[data-remove-point]');if(button)updateInputs(v=>v.points.splice(Number(button.dataset.removePoint),1));})();
 $('mtApplyJson').onclick=guard('mtStatus',syncVisual);
 const canvas=$('mtCanvas');
 canvas.onpointerdown=event=>guard('mtStatus',()=>{if(event.button!==0)return;if($('mtRole').value!=='segmentation')throw new Error('增强角色不使用选区标记');const mode=$('mtPointerMode').value;if(!supports(mode==='box'?'box':'points'))throw new Error('所选绑定没有对应 points / box 字段，请先配置并保存');syncVisual();const start=coordinate(event,mode==='box');drag={mode,start,end:start,pointerId:event.pointerId};canvas.setPointerCapture(event.pointerId);event.preventDefault();})();
 canvas.onpointermove=event=>guard('mtStatus',()=>{if(!preview)return;const p=coordinate(event);$('mtCoordinates').textContent=`原图坐标 (${p.x}, ${p.y}) · ${preview.naturalWidth}×${preview.naturalHeight}`;if(drag&&drag.pointerId===event.pointerId){drag.end=coordinate(event,drag.mode==='box');drawCanvas();}})();
 canvas.onpointerup=event=>guard('mtStatus',()=>{if(!drag||drag.pointerId!==event.pointerId)return;const action=drag;drag=null;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);const end=coordinate(event,action.mode==='box');updateInputs(v=>{if(action.mode==='box'){const b=boxBetween(action.start,end);if(b[2]>b[0]&&b[3]>b[1])v.box=b;}else v.points=[...(v.points||[]),{...end,label:action.mode==='include'?1:0}];});})();
 canvas.onpointercancel=()=>{drag=null;drawCanvas();};canvas.onlostpointercapture=()=>{if(drag){drag=null;drawCanvas();}};
 new ResizeObserver(()=>drawCanvas()).observe(canvas);
 drawBinding();
 document.addEventListener('workspace-tab',e=>{if(e.detail==='studio'){guard('mtStatus',refreshTools)();guard('forgeReport',refreshForge)();}});
 if(!$('tab-studio').hidden){guard('mtStatus',refreshTools)();guard('forgeReport',refreshForge)();}
})();
