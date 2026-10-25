(() => {
  let inputs = [], projects = [], toolSource = null, preview = null, revision = 0, viewedJob = null;
  const guard = fn => async () => { try { await fn(); } catch(e) { toast(reason(e), true); } };
  const labels = { paused:'已暂停',running:'执行中',pending:'待执行',done:'完成',error:'失败','needs-attention':'有失败项',cancelled:'已取消' };
  function drawInputs() { $('batchCount').textContent = `${inputs.length} 张`; $('batchInputs').innerHTML = inputs.map(x => `<img src="${url(`/uploads/${x.uploadId}`)}" title="${esc(x.name)}">`).join(''); }
  $('batchPick').onclick = guard(async () => { inputs.push(...await window.bridge.pickImages(maxSide(),true)); inputs=inputs.slice(0,200); drawInputs(); });
  $('batchClear').onclick = () => { inputs=[]; drawInputs(); };
  $('batchCreate').onclick = guard(async () => {
    const provider = $('provider').value, caps = work.health?.providers[provider];
    if (!caps?.available) throw new Error('请先在工作台选择可用平台');
    const prompt = buildPrompt($('genPrompt').value,true,work.refs.length,$('keepComposition').checked);
    if (!$('genPrompt').value.trim()) throw new Error('先在工作台填写提示词或选择预设');
    await api('POST','/batches',{ title:$('batchTitle').value,inputs,projectId:$('projectSelect').value,options:{ provider,model:$('model').value,aspect:$('aspect').value,resolution:$('resolution').value,thinking:$('thinking').value,prompt,refUploadIds:work.refs.map(r=>r.uploadId),fallbacks:[],post:{align:false,cc:'none'} } });
    inputs=[]; drawInputs(); await refresh(); toast('队列已创建，点击开始执行');
  });
  async function refresh() {
    const [b,p] = await Promise.all([api('GET','/batches'),api('GET','/projects')]); projects=p.projects;
    $('batchList').innerHTML=b.batches.map(b=>`<article><strong>${esc(b.title)}</strong> · ${labels[b.status]||esc(b.status)}<p class="mute">${b.items.filter(i=>i.status==='done').length}/${b.items.length} 完成 ${esc(b.note||'')}</p><div class="row">${['paused','needs-attention'].includes(b.status)?`<button data-batch="${b.id}" data-act="start">开始 / 继续</button>`:''}${b.status==='running'?`<button data-batch="${b.id}" data-act="pause">暂停后续</button>`:''}${b.items.some(i=>i.status==='error')?`<button data-batch="${b.id}" data-act="retry">重置失败项</button>`:''}${!['cancelled','done'].includes(b.status)?`<button data-batch="${b.id}" data-act="cancel">取消队列</button>`:''}</div><details><summary>逐张状态</summary>${b.items.map(i=>`<p>${esc(i.name)} · ${labels[i.status]||i.status} ${esc(i.error||'')} ${i.status==='done'?`<button data-job="${esc(i.jobId)}">查看</button>`:''}</p>`).join('')}</details></article>`).join('') || '<p class="mute">还没有队列</p>';
    const id=$('projectSelect').value;
    $('projectSelect').innerHTML='<option value="">新建项目</option>'+projects.map(p=>`<option value="${p.id}">${esc(p.title)} · ${esc(p.state)}</option>`).join(''); $('projectSelect').value=id;
  }
  $('batchList').onclick=e=>guard(async()=>{ if(e.target.dataset.batch){ await api('POST',`/batches/${e.target.dataset.batch}/${e.target.dataset.act}`); await refresh(); } if(e.target.dataset.job) await viewJob(e.target.dataset.job); })();
  async function viewJob(id) { await refreshJobs(); const j=work.jobs.find(j=>j.id===id); if(!j)throw new Error('结果不在当前历史中'); openViewer(j.groupId,j.id); }
  function projectFields() {
    const p=projects.find(p=>p.id===$('projectSelect').value);
    $('projectTitle').value=p?.title||''; $('projectState').value=p?.state||'todo'; $('projectDue').value=p?.due||''; $('projectNotes').value=p?.notes||'';
    $('projectJobs').innerHTML=(p?.jobIds||[]).map(id=>`<button data-job="${esc(id)}">${esc(id)}</button>`).join('');
  }
  $('projectSelect').onchange=projectFields;
  async function saveProject(attach=false) {
    const old=projects.find(p=>p.id===$('projectSelect').value), jobIds=[...(old?.jobIds||[])];
    if(attach){ if(!viewedJob)throw new Error('先在工作台打开一张结果'); if(!jobIds.includes(viewedJob))jobIds.push(viewedJob); }
    const p=await api('POST','/projects',{ id:old?.id,title:$('projectTitle').value,state:$('projectState').value,due:$('projectDue').value,notes:$('projectNotes').value,jobIds });
    await refresh(); $('projectSelect').value=p.id; projectFields(); toast('项目已保存');
  }
  $('projectSave').onclick=guard(()=>saveProject()); $('projectAttach').onclick=guard(()=>saveProject(true));
  $('projectJobs').onclick=e=>{ if(e.target.dataset.job)guard(()=>viewJob(e.target.dataset.job))(); };
  function invalidate() { revision++; preview=null; $('toolSave').disabled=true; }
  function source(s){toolSource=s;invalidate();$('toolInput').src=url(s.jobId?`/jobs/${s.jobId}/result`:`/uploads/${s.uploadId}`);$('toolInput').hidden=false;$('toolOutput').hidden=true;}
  $('toolPick').onclick=guard(async()=>{const [r]=await window.bridge.pickImages(4096,false);if(r)source(r);});
  $('toolUseInput').onclick=guard(()=>{if(!work.input)throw new Error('工作台没有本地原图');source(work.input);});
  $('toolUseResult').onclick=guard(()=>{if(!viewedJob)throw new Error('先在工作台打开一张结果');source({jobId:viewedJob});});
  for(const id of ['toolExposure','toolSaturation','toolSharpen','toolGlow']) $(id).oninput=()=>{ $(id).nextElementSibling.value=$(id).value;invalidate(); };
  $('toolPreview').onclick=guard(async()=>{
    if(!toolSource)throw new Error('先选择图片');const rev=revision;
    $('toolPreview').disabled=true;$('toolMessage').textContent='正在计算预览…';
    try { const r=await api('POST','/tools/preview',{...toolSource,exposure:Number($('toolExposure').value),saturation:Number($('toolSaturation').value),sharpen:Number($('toolSharpen').value),glow:Number($('toolGlow').value)});
      if(rev!==revision)return;preview=r;$('toolOutput').src=url(`/uploads/${r.uploadId}`);$('toolOutput').hidden=false;$('toolSave').disabled=false;$('toolMessage').textContent='预览已就绪，保存后进入生成记录。';
    } finally {$('toolPreview').disabled=false;}
  });
  $('toolSave').onclick=guard(async()=>{if(!preview)throw new Error('参数已变化，请重新预览');const j=await api('POST','/tools/save-preview',{previewId:preview.previewId});await refreshJobs();openViewer(j.groupId,j.id);toast('已保存独立结果');});
  $('toolScopes').onclick=guard(async()=>{
    if(!toolSource)throw new Error('先选择图片');const d=await api('POST','/tools/scopes',toolSource);
    const h=$('toolHistogram'),ctx=h.getContext('2d');h.hidden=false;ctx.clearRect(0,0,h.width,h.height);
    d.histogram.forEach((bins,c)=>{ctx.strokeStyle=['#fa6868','#68dc8a','#688afa'][c];ctx.beginPath();const max=Math.max(...bins,1);bins.forEach((v,i)=>{const x=i*2,y=180-Math.log1p(v)/Math.log1p(max)*170;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();});
    const w=$('toolWaveform'),wc=w.getContext('2d');w.hidden=false;wc.clearRect(0,0,w.width,w.height);d.waveform.forEach((bins,x)=>bins.forEach((v,y)=>{if(v){wc.fillStyle=`rgba(100,230,160,${Math.min(1,.12+Math.log1p(v)/5)})`;wc.fillRect(x*4,179-y/255*179,4,1);}}));
    const parade=$('toolParade'),pc=parade.getContext('2d');parade.hidden=false;pc.clearRect(0,0,parade.width,parade.height);
    d.parade.forEach((columns,c)=>columns.forEach((bins,x)=>bins.forEach((v,y)=>{if(v){pc.globalAlpha=Math.min(1,.12+Math.log1p(v)/5);pc.fillStyle=['#fa6868','#68dc8a','#688afa'][c];pc.fillRect(c*256+x*2,179-y/255*179,2,1);}})));pc.globalAlpha=1;
    const vector=$('toolVectorscope'),vc=vector.getContext('2d');vector.hidden=false;vc.clearRect(0,0,256,256);vc.strokeStyle='#555';vc.beginPath();vc.arc(128,128,120,0,Math.PI*2);vc.moveTo(8,128);vc.lineTo(248,128);vc.moveTo(128,8);vc.lineTo(128,248);vc.stroke();
    d.vectorscope.forEach((row,y)=>row.forEach((v,x)=>{if(v){vc.fillStyle=`rgba(120,230,190,${Math.min(1,.2+Math.log1p(v)/5)})`;vc.fillRect(x*2,254-y*2,2,2);}}));vc.fillStyle='#bbb';vc.fillText('Cb →',211,140);vc.fillText('Cr ↑',135,16);
    $('toolMessage').textContent='依次为 RGB 直方图（对数纵轴）、亮度波形、RGB Parade、Cb/Cr 矢量示波 · sRGB 编码值，Rec.709 系数；采样最长边 512 像素';
  });
  $('studioRefresh').onclick=guard(refresh);
  document.addEventListener('workspace-tab',e=>{if(e.detail==='studio'){if(work.viewer?.jobId)viewedJob=work.viewer.jobId;guard(refresh)();}});
  // Remember the last viewed result even after its viewer is closed.
  new MutationObserver(()=>{if(work.viewer?.jobId)viewedJob=work.viewer.jobId;}).observe($('vMeta'),{childList:true});
  setInterval(()=>{if(!$('tab-studio').hidden)guard(refresh)();},2500);
})();
