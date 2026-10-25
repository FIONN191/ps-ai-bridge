/* Loaded after workspace.js. Helper owns durable state; never interpret reply text as actions. */
(() => {
  if (document.getElementById('tab-assistant')) return;
  const button = document.createElement('button');
  button.className = 'tab-btn'; button.dataset.tab = 'assistant'; button.setAttribute('role', 'tab'); button.textContent = '助手';
  button.onclick = () => showTab('assistant');
  document.querySelector('.tabs').append(button);
  const section = document.createElement('section');
  section.id = 'tab-assistant'; section.className = 'tab manager aw'; section.hidden = true;
  section.innerHTML = `
    <header class="aw-heading"><div><h2>助手与受控计划</h2><p>对话提供建议。预设须批准保存；修图计划须预览后逐步执行。</p></div><button id="awRefresh">刷新</button></header>
    <nav class="aw-nav" aria-label="助手工作区"><button data-aw-page="chat" aria-pressed="true">对话</button><button data-aw-page="knowledge">知识库</button><button data-aw-page="inbox">预设收件箱</button><button data-aw-page="plans">修图计划</button></nav>
    <p id="awError" class="aw-error" role="alert" hidden></p>
    <div data-aw-pane="chat">
      <div class="aw-toolbar"><label>会话 <select id="awSession" aria-label="选择会话"></select></label><input id="awTitle" placeholder="新对话名称" maxlength="200" aria-label="新对话名称"><button id="awNew">新建</button><label>连接 <select id="awBackend"><option value="auto">已配置助手渠道 / Codex</option><option value="channel">仅已配置助手渠道</option><option value="codex">本机 Codex</option></select></label></div>
      <p class="aw-muted">API 连接使用设置页的“用于 AI 帮写”文本/视觉模型。发送消息会实际调用所选连接；失败会保留错误。消息和图片可能发送给该服务。</p>
      <div id="awMessages" class="aw-messages" aria-live="polite"></div>
      <div class="aw-compose"><label>模式 <select id="awMode"><option value="chat">对话 / 看图 / 提示词建议</option><option value="preset">生成预设提案</option><option value="plan">生成修图计划</option></select></label>
        <label id="awPresetTargetLabel" hidden>修订目标 <select id="awPresetTarget"><option value="">另存新预设</option></select></label>
        <p id="awPlanHint" hidden>先在「修图计划」选择目标文档，然后回到这里描述需求。</p>
        <textarea id="awText" rows="4" maxlength="16000" placeholder="描述需求，或附图提问…" aria-label="消息内容"></textarea>
        <div id="awImages" class="aw-images"></div><div class="aw-toolbar"><button id="awPick">附图（最多 4 张）</button><button id="awClearImages">移除附图</button><button id="awSend" class="primary">发送</button><button id="awStop">停止回复</button><span id="awChatStatus" role="status"></span></div>
      </div>
    </div>
    <div data-aw-pane="knowledge" hidden>
      <h3>导入自己的文本资料</h3><p class="aw-muted">支持 .txt / .md；按原文行号检索并显示片段。检索片段不代表模型答案已被资料证实。</p>
      <label>文件 <input id="awKnowledgeFile" type="file" accept=".txt,.md,text/plain,text/markdown"></label>
      <label>来源名称 <input id="awKnowledgeName" placeholder="我的修图手册.md" maxlength="200"></label>
      <textarea id="awKnowledgeText" rows="8" maxlength="500000" placeholder="也可以粘贴自己提供的文本资料" aria-label="资料正文"></textarea><button id="awKnowledgeSave">导入资料</button>
      <div class="aw-toolbar"><input id="awQuery" placeholder="输入检索词" aria-label="知识检索词"><button id="awSearch">检索</button></div>
      <div id="awSources"></div><div id="awKnowledgeList"></div><pre id="awSourceText" class="aw-source" hidden></pre>
    </div>
    <div data-aw-pane="inbox" hidden><h3>待批准的预设</h3><p class="aw-muted">仅接受名称、分类、提示词。未知字段、工作流和工具代码会被拒绝。保存通过现有预设版本仓库；修订可恢复为新版本。</p>
      <details><summary>导入结构化预设提案</summary><p>JSON 格式：{"title":"名称","category":"cleanup","content":"提示词"}</p><textarea id="awPresetJson" rows="6" aria-label="预设提案 JSON"></textarea><button id="awImportPreset">校验并放入收件箱</button></details><div id="awInbox"></div>
    </div>
    <div data-aw-pane="plans" hidden><h3>绑定目标并预览计划</h3><p class="aw-muted">每个计划绑定一个 PS 会话和文档。可为多个文档分别建立计划。每次只执行你批准的一步；停止不会撤回已派发的 PS 动作。</p>
      <div class="aw-toolbar"><button id="awDocuments">读取 PS 文档</button><label>目标文档 <select id="awTarget"><option value="">请先读取并选择文档</option></select></label></div><p id="awTargetInfo" class="aw-muted"></p>
      <details id="awPlanTemplate"><summary>导入 / 批量创建结构化修图计划</summary><p>最多 12 步。步骤索引从 0 开始，只能引用前面的捕获与生成。可先回到「对话」选择「生成修图计划」。</p><textarea id="awPlanJson" rows="8" aria-label="修图计划 JSON" placeholder='{"title":"检查主体","steps":[{"type":"select-subject","title":"选择主体"}]}'></textarea><button id="awImportPlan">为单个目标校验并预览</button><fieldset class="aw-batch-targets"><legend>批量目标（逐个勾选，不默认选择）</legend><div id="awBatchTargets">先读取 PS 文档。</div></fieldset><p class="aw-muted">先检查上方 JSON 模板及每个目标。每个文档会独立验证矩形范围并保存一个待批准计划；不会自动执行，也不会共享其他文档的捕获或任务结果。</p><button id="awBatchCreate">已检查模板，为勾选文档创建计划预览</button><p id="awBatchStatus" role="status"></p></details>
      <div id="awPlans"></div>
    </div>`;
  // The first <main> belongs to Settings and is hidden when another tab opens.
  // Mount beside the existing tab panes, never inside one of their descendants.
  (document.getElementById('tab-work')?.parentElement || document.body).append(section);
  const $a = id => document.getElementById(id);
  const request = (method, suffix = '', body) => api(method, `/assistant-workbench${suffix}`, body);
  let snapshot = {sessions:[],knowledge:[],proposals:[],plans:[]}, session = null, images = [], docs = [], presets = [], sending = false, refreshing = false;
  const states = {pending:'待批准',preview:'待预览批准',ready:'等待下一步批准',responding:'回复中',idle:'就绪',running:'执行中',done:'完成',saved:'已保存',rejected:'已拒绝',restored:'已恢复为新版本',cancelled:'已停止',interrupted:'中断，须核对',error:'失败','needs-attention':'需要处理',saving:'保存中',restoring:'恢复中'};
  const label = status => states[status] || status;
  const guard = fn => async (...args) => { try { $a('awError').hidden=true; await fn(...args); } catch (e) { $a('awError').textContent=reason(e);$a('awError').hidden=false;toast(reason(e),true); } };
  function page(name) {
    section.querySelectorAll('[data-aw-pane]').forEach(e=>{e.hidden=e.dataset.awPane!==name;});
    section.querySelectorAll('[data-aw-page]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.awPage===name)));
  }
  function sources(items) {
    return (items||[]).map(s=>`<details class="aw-citation"><summary>${esc(s.name)} · L${s.startLine}–${s.endLine}</summary><code>[${esc(s.citation)}]</code><pre>${esc(s.excerpt)}</pre><button data-aw-source="${esc(s.sourceId)}">打开完整来源</button></details>`).join('');
  }
  function renderSession() {
    $a('awMessages').innerHTML=(session?.messages||[]).map(m=>`<article class="aw-message aw-${esc(m.role)}"><strong>${m.role==='user'?'你':'助手'}</strong> <small>${esc(label(m.status))}${m.source?` · ${esc(m.source.title||m.source.provider)} ${esc(m.source.model||'')}`:''}</small><pre>${esc(m.text)}</pre>${m.images?.length?`<small>本条附图 ${m.images.length} 张（已随会话保存）</small>`:''}${m.validationError?`<p class="aw-error">结构校验失败，未创建提案：${esc(m.validationError)}</p>`:''}${m.proposalId?'<p>预设提案已进入收件箱，尚未保存。</p>':''}${m.planId?'<p>修图计划已进入预览，尚未执行。</p>':''}${m.sources?.length?`<details><summary>本次检索来源（${m.sources.length}）</summary>${sources(m.sources)}</details>`:''}</article>`).join('')||'<p class="aw-muted">新建或选择对话。历史保存在 helper，重启后可继续。</p>';
    $a('awChatStatus').textContent=session?`${label(session.status)}${session.error?' · '+session.error:''}`:'';
    $a('awSend').disabled=sending||session?.status==='responding';
    $a('awStop').disabled=!session||(!sending&&session.status!=='responding');
    $a('awSession').disabled=sending;$a('awNew').disabled=sending;
    for(const id of ['awText','awMode','awBackend','awPresetTarget','awPick','awClearImages'])$a(id).disabled=sending||session?.status==='responding';
  }
  function renderInbox() {
    $a('awInbox').innerHTML=snapshot.proposals.map(p=>`<article class="aw-record"><h4>${esc(p.proposal.title)} <small>${esc(label(p.status))}</small></h4><p>${esc(p.proposal.category)} · ${p.previous?`修订 ${esc(p.previous.title)}（v${p.previous.revision}）`:'新预设'}</p><pre>${esc(p.proposal.content)}</pre>${p.previous?`<details><summary>保存前版本</summary><pre>${esc(p.previous.content)}</pre></details>`:''}${p.saved?`<p>保存结果：${esc(p.saved.id)} · v${p.saved.revision}</p>`:''}${p.error?`<p class="aw-error">${esc(p.error)}</p>`:''}<div class="aw-toolbar">${p.status==='pending'?`<button data-proposal="${p.id}" data-action="approve">批准并保存当前提案</button><button data-proposal="${p.id}" data-action="reject">拒绝</button>`:''}${p.status==='saved'&&p.previous?`<button data-proposal="${p.id}" data-action="restore">批准恢复保存前版本</button>`:''}</div></article>`).join('')||'<p class="aw-muted">尚无提案。在对话中生成，或导入上面的 JSON。</p>';
  }
  function renderPlans() {
    $a('awPlans').innerHTML=snapshot.plans.map(p=>{
      const next=p.steps.find(s=>s.status!=='done');
      return `<article class="aw-record"><h4>${esc(p.title)} <small>${esc(label(p.status))}</small></h4><p>目标：${esc(p.target.name)} · doc ${p.target.docId} · ${p.target.width}×${p.target.height}<br><small>会话 ${esc(p.target.session)}</small></p><p>${p.steps.filter(s=>s.status==='done').length} / ${p.steps.length} 步完成${p.batchId?` · 批次 ${esc(p.batchId)}`:''}</p><button data-template-plan="${p.id}">将步骤复制到批量模板（不含执行状态）</button>${p.error?`<p class="aw-error">${esc(p.error)}</p>`:''}${p.note?`<p>${esc(p.note)}</p>`:''}<ol class="aw-steps">${p.steps.map(s=>{
        const {id,status,result,jobId,error,startedAt,finishedAt,...payload}=s;
        return `<li><strong>${esc(s.title)}</strong> · ${esc(label(s.status))}<pre>${esc(JSON.stringify(payload,null,2))}</pre>${s.result?.id&&s.type==='capture-region'?`<img class="aw-preview" src="${url(`/regions/${encodeURIComponent(s.result.id)}/image`)}" alt="已捕获区域">`:''}${s.jobId?`<p>任务 ${esc(s.jobId)}</p>`:''}${s.type==='generate'&&s.status==='done'?`<img class="aw-preview" src="${url(`/jobs/${encodeURIComponent(s.jobId)}/result`)}" alt="生成结果，执行下一步前请检查">`:''}${s.result?`<details><summary>真实执行结果</summary><pre>${esc(JSON.stringify(s.result,null,2))}</pre></details>`:''}${s.error?`<p class="aw-error">${esc(s.error)}</p>`:''}${s.note?`<p>${esc(s.note)}</p>`:''}${s===next&&s.status==='pending'&&['preview','ready'].includes(p.status)?`<button data-plan="${p.id}" data-action="execute" data-step="${s.id}">已检查预览，执行这一步</button>`:''}</li>`;
      }).join('')}</ol><div class="aw-toolbar">${p.status==='interrupted'&&next?.type==='generate'&&next.jobId?`<button data-plan="${p.id}" data-action="reconcile">核对已有任务结果（不重新生成）</button>`:''}${!['done','cancelled'].includes(p.status)?`<button data-plan="${p.id}" data-action="cancel">停止此计划</button>`:''}</div></article>`;
    }).join('')||'<p class="aw-muted">尚无计划。选择明确目标，再生成或导入计划。</p>';
  }
  async function refresh() {
    if(refreshing)return;refreshing=true;
    try {
      snapshot=await request('GET');
      const selected=$a('awSession').value||session?.id||'';
      $a('awSession').innerHTML='<option value="">选择对话</option>'+snapshot.sessions.map(s=>`<option value="${s.id}">${esc(s.title)} · ${s.messageCount} 条</option>`).join('');
      $a('awSession').value=selected;
      if(selected)session=await request('GET',`/sessions/${encodeURIComponent(selected)}`);
      renderSession();renderInbox();renderPlans();
      $a('awKnowledgeList').innerHTML=snapshot.knowledge.map(d=>`<article>${esc(d.name)} · ${d.lineCount} 行 <button data-aw-source="${d.id}">查看来源</button></article>`).join('');
    }finally{refreshing=false;}
  }
  const selectedTarget=()=>{const t=docs[Number($a('awTarget').value)];if($a('awTarget').value===''||!t)throw new Error('先读取 PS 文档并明确选择目标');return t;};
  $a('awRefresh').onclick=guard(refresh);
  $a('awNew').onclick=guard(async()=>{session=await request('POST','/sessions',{title:$a('awTitle').value||'新对话'});$a('awSession').innerHTML=`<option value="${session.id}">新对话</option>`;images=[];$a('awImages').textContent='';await refresh();});
  $a('awSession').onchange=guard(async()=>{session=$a('awSession').value?await request('GET',`/sessions/${encodeURIComponent($a('awSession').value)}`):null;images=[];$a('awImages').textContent='';renderSession();});
  $a('awMode').onchange=guard(async()=>{
    $a('awPlanHint').hidden=$a('awMode').value!=='plan';$a('awPresetTargetLabel').hidden=$a('awMode').value!=='preset';
    if($a('awMode').value==='preset'){const r=await api('GET','/presets');presets=(r.presets||[]).filter(p=>!p.factory);$a('awPresetTarget').innerHTML='<option value="">另存新预设</option>'+presets.map(p=>`<option value="${esc(p.id)}">${esc(p.title)} · v${p.revision}</option>`).join('');}
  });
  $a('awPick').onclick=guard(async()=>{images=[...images,...await window.bridge.pickImages(2048,true)].slice(0,4);$a('awImages').innerHTML=images.map(i=>`<img src="${url(`/uploads/${encodeURIComponent(i.uploadId)}`)}" alt="${esc(i.name||'附图')}">`).join('');});
  $a('awClearImages').onclick=()=>{images=[];$a('awImages').textContent='';};
  $a('awSend').onclick=guard(async()=>{
    if(!session)throw new Error('请先新建或选择对话');
    const content=$a('awText').value;if(!content.trim())throw new Error('请输入消息');
    const id=session.id,mode=$a('awMode').value,body={text:content,mode,backend:$a('awBackend').value,uploadIds:images.map(i=>i.uploadId)};
    if(mode==='plan')body.target=selectedTarget();
    if(mode==='preset'&&$a('awPresetTarget').value){const p=presets.find(p=>p.id===$a('awPresetTarget').value);body.presetId=p.id;body.expectedRevision=p.revision;}
    sending=true;renderSession();
    try{
      const r=await request('POST',`/sessions/${encodeURIComponent(id)}/messages`,body);
      if(session?.id===id){session=r;renderSession();}
      if(r.status==='idle'){$a('awText').value='';images=[];$a('awImages').textContent='';}
      await refresh();
    }finally{sending=false;renderSession();}
  });
  $a('awStop').onclick=guard(async()=>{if(session){session=await request('POST',`/sessions/${encodeURIComponent(session.id)}/cancel`);renderSession();}});
  $a('awKnowledgeFile').onchange=guard(async()=>{const file=$a('awKnowledgeFile').files[0];if(!file)return;if(file.size>1024*1024||!/\.(txt|md)$/i.test(file.name))throw new Error('请选择不超过 1 MB 的 txt/md 文件');$a('awKnowledgeName').value=file.name;$a('awKnowledgeText').value=await file.text();});
  $a('awKnowledgeSave').onclick=guard(async()=>{await request('POST','/knowledge',{name:$a('awKnowledgeName').value,text:$a('awKnowledgeText').value});await refresh();toast('资料已导入');});
  $a('awSearch').onclick=guard(async()=>{const r=await request('POST','/knowledge/search',{query:$a('awQuery').value});$a('awSources').innerHTML=sources(r.sources)||'<p>没有匹配的来源。</p>';});
  $a('awImportPreset').onclick=guard(async()=>{await request('POST','/proposals',{proposal:JSON.parse($a('awPresetJson').value)});await refresh();toast('提案已校验，尚未保存预设');});
  $a('awDocuments').onclick=guard(async()=>{const r=await request('GET','/documents');docs=r.documents;$a('awTarget').innerHTML='<option value="">请选择目标文档</option>'+docs.map((d,i)=>`<option value="${i}">${esc(d.name)} · #${d.docId} · ${d.width}×${d.height}</option>`).join('');$a('awTargetInfo').textContent='';$a('awBatchTargets').innerHTML=docs.map((d,i)=>`<label><input type="checkbox" data-aw-batch-target="${i}">${esc(d.name)} · #${d.docId} · ${d.width}×${d.height} · ${esc(d.session)}</label>`).join('')||'没有打开的 PS 文档';});
  $a('awTarget').onchange=guard(async()=>{$a('awTargetInfo').textContent=$a('awTarget').value===''?'':JSON.stringify(selectedTarget());});
  $a('awImportPlan').onclick=guard(async()=>{await request('POST','/plans',{plan:JSON.parse($a('awPlanJson').value),target:selectedTarget()});await refresh();toast('计划已创建，仅预览，尚未执行');});
  $a('awBatchCreate').onclick=guard(async()=>{
    const targets=[...section.querySelectorAll('[data-aw-batch-target]:checked')].map(e=>docs[Number(e.dataset.awBatchTarget)]);
    if(!targets.length)throw new Error('请逐个勾选批量目标文档');
    const plan=JSON.parse($a('awPlanJson').value);$a('awBatchCreate').disabled=true;
    try{const r=await request('POST','/plans/batch',{approved:true,targets,plan});$a('awBatchStatus').textContent=`已创建 ${r.plans.length} 个独立预览计划；每一步仍须单独批准。`;section.querySelectorAll('[data-aw-batch-target]').forEach(e=>{e.checked=false;});await refresh();}
    finally{$a('awBatchCreate').disabled=false;}
  });
  section.addEventListener('click',guard(async e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.awPage)page(b.dataset.awPage);
    if(b.dataset.templatePlan){
      const p=snapshot.plans.find(p=>p.id===b.dataset.templatePlan);if(!p)throw new Error('计划已改变，请刷新');
      const keys=['type','title','rect','captureStep','jobStep','provider','model','prompt','aspect','resolution','mode'];
      $a('awPlanJson').value=JSON.stringify({title:p.title,steps:p.steps.map(s=>Object.fromEntries(keys.filter(k=>Object.hasOwn(s,k)).map(k=>[k,s[k]])))},null,2);
      $a('awPlanTemplate').open=true;$a('awBatchStatus').textContent='步骤已复制；请检查矩形范围并逐个勾选目标，再确认创建。';
    }
    if(b.dataset.awSource){const d=await request('GET',`/knowledge/${encodeURIComponent(b.dataset.awSource)}`);page('knowledge');$a('awSourceText').hidden=false;$a('awSourceText').textContent=`${d.name}\nSHA-256 ${d.digest}\n\n`+d.text.split('\n').map((l,i)=>`${i+1}  ${l}`).join('\n');}
    const kind=b.dataset.proposal?'proposals':b.dataset.plan?'plans':null;
    if(kind){
      const id=b.dataset.proposal||b.dataset.plan,r=snapshot[kind].find(p=>p.id===id);if(!r)throw new Error('记录已改变，请刷新');
      const body={approved:true,revision:r.revision,...(b.dataset.step?{stepId:b.dataset.step}:{})};
      b.disabled=true;
      try{await request('POST',`/${kind}/${encodeURIComponent(id)}/${b.dataset.action}`,body);await refresh();}finally{b.disabled=false;}
    }
  }));
  document.addEventListener('workspace-tab',e=>{if(e.detail==='assistant')guard(refresh)();});
  // Poll only visible pending work; handlers catch service errors and never execute pending steps.
  const timer=setInterval(()=>{if(!section.hidden&&(sending||session?.status==='responding'||snapshot.plans.some(p=>p.status==='running')))guard(refresh)();},1500);
  window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});
})();
