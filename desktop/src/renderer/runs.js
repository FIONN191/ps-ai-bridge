(()=>{
 let input=null,steps=[],rendered='';
 const guard=fn=>async()=>{try{await fn();}catch(e){toast(reason(e),true);$('runMessage').textContent=reason(e);}};
 const names={paused:'已暂停',pending:'待执行',running:'执行中',done:'完成',error:'失败','needs-attention':'需要核对',cancelled:'已取消'};
 function current(){
  const provider=$('provider').value;
  if(!work.health?.providers[provider]?.available)throw new Error('先在工作台选择可用平台');
  if(!$('genPrompt').value.trim())throw new Error('先在工作台填写本步提示词');
  return {provider,model:$('model').value,title:`第 ${steps.length+1} 步`,prompt:buildPrompt($('genPrompt').value,true,work.refs.length,$('keepComposition').checked),aspect:$('aspect').value,resolution:$('resolution').value,thinking:$('thinking').value,refUploadIds:work.refs.map(r=>r.uploadId)};
 }
 function source(r){input=r;$('runSourceLabel').textContent=`${r.name} · ${r.width}×${r.height}`;$('runSourcePreview').src=url(`/uploads/${r.uploadId}`);$('runSourcePreview').hidden=false;}
 function drawSteps(){$('runSteps').innerHTML=steps.map((s,i)=>`<article><p>${i+1}. ${esc(s.provider)} · ${esc(s.model)} · ${s.refUploadIds.length} 张参考图</p><input data-step-title="${i}" value="${esc(s.title)}" aria-label="步骤 ${i+1} 名称"><textarea rows="4" data-step-prompt="${i}" aria-label="步骤 ${i+1} 提示词">${esc(s.prompt)}</textarea><div class="row"><button data-step-up="${i}" ${i===0?'disabled':''}>上移</button><button data-step-remove="${i}">删除此步</button></div></article>`).join('');}
 $('runSteps').oninput=e=>{if(e.target.dataset.stepTitle!=null)steps[Number(e.target.dataset.stepTitle)].title=e.target.value;if(e.target.dataset.stepPrompt!=null)steps[Number(e.target.dataset.stepPrompt)].prompt=e.target.value;};
 $('runSteps').onclick=e=>{if(e.target.dataset.stepRemove!=null){steps.splice(Number(e.target.dataset.stepRemove),1);drawSteps();}if(e.target.dataset.stepUp!=null){const i=Number(e.target.dataset.stepUp);if(i>0)[steps[i-1],steps[i]]=[steps[i],steps[i-1]];drawSteps();}};
 $('runAddStep').onclick=guard(()=>{if(steps.length>=30)throw new Error('最多 30 步');steps.push(current());drawSteps();});
 $('runPick').onclick=guard(async()=>{const [r]=await window.bridge.pickImages('original',false);if(r)source(r);});
 $('runFromWork').onclick=guard(()=>{if(!work.input)throw new Error('请先在工作台导入原图');source(work.input);});
 $('runMode').onchange=()=>{const tile=$('runMode').value==='tiles';$('runChainFields').hidden=tile;$('runTileFields').hidden=!tile;};
 $('runCreate').onclick=guard(async()=>{
  if(!input)throw new Error('先选择原图');const mode=$('runMode').value;
  if(mode==='chain'&&!steps.length)throw new Error('请添加至少一步');
  const r=await api('POST','/runs',{mode,title:$('runTitle').value,uploadId:input.uploadId,steps,options:mode==='tiles'?current():undefined,size:Number($('runTileSize').value),overlap:Number($('runTileOverlap').value),reviewEach:$('runReview').checked});
  $('runMessage').textContent=`已保存 ${r.steps.length} 个任务，原图 ${r.width}×${r.height}；核对后在右侧开始。`;await refresh();
 });
 async function refresh(){
  const {runs}=await api('GET','/runs'),key=JSON.stringify(runs);if(key===rendered)return;rendered=key;
  $('runsList').innerHTML=runs.map(r=>`<article><strong>${esc(r.title)}</strong> · ${names[r.status]||esc(r.status)}<p>${r.mode==='chain'?'连续步骤':'分块合成'} · ${r.width}×${r.height} · ${r.steps.filter(s=>s.status==='done').length}/${r.steps.length} 完成</p><p class="mute">${esc(r.note||'')}</p><div class="row">${['paused','needs-attention'].includes(r.status)?`<button data-run="${r.id}" data-action="start">开始 / 继续</button>`:''}${r.status==='running'?`<button data-run="${r.id}" data-action="pause">暂停后续</button>`:''}${r.steps.some(s=>s.status==='error')?`<button data-run="${r.id}" data-action="retry">核对后重试失败步骤</button>`:''}${!['done','cancelled'].includes(r.status)?`<button data-run="${r.id}" data-action="cancel">取消流程</button>`:''}${r.resultJobId?`<button data-run-job="${r.resultJobId}">查看最终结果</button>`:''}</div><details><summary>步骤和坐标</summary>${r.steps.map((s,i)=>`<p>${i+1}. ${esc(s.title)} · ${names[s.status]||esc(s.status)} ${s.region?`· (${s.region.left},${s.region.top}) ${s.region.width}×${s.region.height}`:''} ${esc(s.error||'')} ${s.status==='done'?`<button data-run-job="${s.jobId}">查看此步</button>`:''}</p>`).join('')}</details></article>`).join('')||'<p class="mute">还没有流程</p>';
 }
 $('runsList').onclick=e=>guard(async()=>{
  const {run,action,runJob}=e.target.dataset;
  if(run){
   if(action==='retry'&&!window.confirm('请先在外部服务中核对失败任务是否已经完成。继续会重新提交失败步骤，可能再次消耗额度。确认已经核对并重试？'))return;
   await api('POST',`/runs/${run}/${action}`,{verified:action==='retry'});await refresh();
  }
  if(runJob){await refreshJobs();const j=work.jobs.find(j=>j.id===runJob);if(!j)throw new Error('结果不在最近历史中');openViewer(j.groupId,j.id);}
 })();
 $('runsRefresh').onclick=guard(refresh);document.addEventListener('workspace-tab',e=>{if(e.detail==='runs')guard(refresh)();});
 setInterval(()=>{if(!$('tab-runs').hidden)guard(refresh)();},2500);
})();
