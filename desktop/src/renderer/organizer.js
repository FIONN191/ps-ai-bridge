/* Load after workspace.js/common.js; parent adds organizer.css and this script.
 * Native hooks requested from preload (all optional; missing support is reported):
 * bridge.applyOrganizerLayout({mode,theme,zoom,opacity}) -> {applied:true}
 * bridge.scheduleOrganizerNotifications({projects:[{id,title,due}]}) -> {scheduled:number}
 * bridge.openExternalHTTPS(url), or parent explicitly exposes openSupportsHTTPS=true.
 * Existing bridge.api, openPack/savePack, copyText and revealJob are reused.
 */
(() => {
  if (window.organizer) return;
  const $o = id => document.getElementById(`org-${id}`);
  const get = (p, q = {}) => api('GET', `/organizer/${p}?${new URLSearchParams(q)}`);
  const post = (p, b = {}) => api('POST', `/organizer/${p}`, b);
  const state = { offset: 0, checkpointOffset: 0, limit: 24, rows: [], projects: [], selected: null, checkpoint: null, layout: null, pack: null, preflight: null, historySeq: 0, previewSeq: 0 };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const bytes = n => `${(n / 1024 / 1024).toFixed(2)} MB`;
  const option = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  function say(text, error = false) { for (const e of document.querySelectorAll('.org-message')) { e.textContent = text; e.classList.toggle('err', error); } toast(text, error); }
  const guard = fn => async e => {
    const button = e?.currentTarget?.tagName === 'BUTTON' ? e.currentTarget : e?.target?.closest?.('button');
    if (button?.dataset.orgBusy) return;
    if (button) { button.dataset.orgBusy = '1'; button.setAttribute('aria-busy','true'); }
    const staleErrors=[...document.querySelectorAll('.org-message.err')].map(message=>[message,message.textContent]);
    try { await fn(e); for(const [message,text] of staleErrors)if(message.textContent===text){message.textContent='';message.classList.remove('err');} } catch (err) { say(reason(err), true); }
    finally { if (button) { delete button.dataset.orgBusy; button.removeAttribute('aria-busy'); } }
  };
  function addTab(name, label, html) {
    const nav = document.querySelector('.tab-btn')?.parentElement;
    const host = document.getElementById('tab-work')?.parentElement;
    if (!nav || !host) throw new Error('Organizer 需要工作台标签容器');
    const button = document.createElement('button'); button.className = 'tab-btn'; button.dataset.tab = name; button.setAttribute('role', 'tab'); button.textContent = label;
    button.onclick = () => showTab(name); nav.append(button);
    const section = document.createElement('div'); section.className = 'tab org-page'; section.id = `tab-${name}`; section.hidden = true;
    section.innerHTML = `<p class="org-message" role="status" aria-live="polite"></p>${html}`; host.append(section);
  }
  addTab('organizer-history', '历史与恢复', `
    <section class="card"><div class="org-toolbar"><h2>全部本地历史</h2><button id="org-history-refresh">刷新</button></div>
      <form id="org-history-filter" class="org-toolbar"><label>搜索<input id="org-search" type="search" placeholder="提示词、名称、任务 ID"></label><label>项目<select id="org-project-filter"></select></label><label>原图组<input id="org-original-filter" placeholder="原图 / 分组 ID"></label><button type="submit">筛选</button><button type="button" id="org-filter-reset">重置</button></form>
      <p class="mute">包含较早的磁盘历史。原图组默认使用生成分组，可在详情中关联相同原图。费用仅展示已记录的来源。</p>
      <div id="org-history-list" class="org-list"></div><div class="org-toolbar"><button id="org-prev">上一页</button><span id="org-history-count"></span><button id="org-next">下一页</button></div></section>
    <section class="card" id="org-result" hidden><div class="org-toolbar"><h2 id="org-result-title"></h2><label>版本<select id="org-version"></select></label></div>
      <img id="org-result-image" class="org-preview" alt="所选历史版本"><textarea id="org-prompt" rows="4" readonly aria-label="历史提示词"></textarea>
      <div class="org-toolbar"><button id="org-copy-prompt">复制提示词</button><button id="org-reuse-prompt">复用到工作台</button><button id="org-reveal">显示结果目录</button><button id="org-restore-result">恢复为新结果</button></div>
      <div class="org-toolbar"><label>关联项目<select id="org-link-project"></select></label><label>原图组 ID<input id="org-link-original"></label><button id="org-link-save">保存关联</button></div>
      <details><summary>Eagle 归档</summary><p>预览上方所选版本及下方标签后确认。原文件保留。</p><div class="org-toolbar"><button id="org-eagle-detect">检测 Eagle</button><span id="org-eagle-status">尚未检测</span></div><label>归档名称<input id="org-eagle-name"></label><label>标签（逗号分隔）<input id="org-eagle-tags" placeholder="项目, 成片"></label><p id="org-eagle-preview"></p><button id="org-eagle-archive">确认归档此版本</button></details>
    </section>
    <section class="card"><div class="org-toolbar"><h2>画布检查点</h2><button id="org-checkpoint-refresh">刷新</button></div><p class="mute">恢复会创建新本地结果，不覆盖检查点，也不自动贴回 Photoshop。</p><div id="org-checkpoint-list" class="org-list"></div><div class="org-toolbar"><button id="org-checkpoint-prev">上一页</button><span id="org-checkpoint-count"></span><button id="org-checkpoint-next">下一页</button></div><img id="org-checkpoint-image" class="org-preview" alt="检查点预览" hidden><button id="org-checkpoint-restore" hidden>将此检查点恢复为新结果</button></section>`);
  addTab('organizer-projects', '项目日程', `
    <section class="card"><div class="org-toolbar"><h2>项目日程</h2><button id="org-project-refresh">刷新</button><button id="org-project-new">新建项目</button><button id="org-notifications">启用 / 更新驻留提醒</button></div><p class="mute">与「工具与项目」共用项目。提醒需桌面运行并允许系统通知。</p><label>月份<input id="org-month" type="month"></label><div id="org-calendar" class="org-calendar"></div><div id="org-project-list" class="org-list"></div></section>
    <section class="card"><h2>编辑项目</h2><form id="org-project-form"><input id="org-project-id" type="hidden"><label>名称<input id="org-project-title" maxlength="200" required></label><div class="org-toolbar"><label>状态<select id="org-project-state">${[['todo','待处理'],['working','处理中'],['done','完成'],['rework','返工'],['archived','弃用']].map(x=>option(...x)).join('')}</select></label><label>到期日期<input id="org-project-due" type="date"></label><label><input id="org-project-reminder" type="checkbox">需要提醒</label></div><label>备注<textarea id="org-project-notes" rows="3"></textarea></label><p id="org-project-linked" class="mute"></p><div class="org-toolbar"><button type="button" id="org-project-add-result">关联历史页所选结果</button><button type="button" id="org-project-refresh-docs">读取 PS 文档</button><label>选择文档<select id="org-project-document"><option value="">请先读取并选择文档</option></select></label><button type="button" id="org-project-add-doc">关联所选文档</button><button type="submit">保存项目</button></div></form></section>`);
  addTab('organizer', '管理与帮助', `
    <section class="card"><div class="org-toolbar"><h2>布局</h2><button id="org-floating-open">打开浮动任务卡</button><button id="org-floating-close">关闭浮动任务卡</button></div><form id="org-layout-form" class="org-toolbar"><label>模式<select id="org-layout-mode">${option('full','完整')}${option('compact','紧凑')}</select></label><label>主题<select id="org-layout-theme">${option('dark','深色')}${option('light','浅色')}${option('system','跟随系统')}</select></label><label>缩放<input id="org-layout-zoom" type="number" min="0.75" max="1.5" step="0.05"></label><label>窗口不透明度<input id="org-layout-opacity" type="number" min="0.5" max="1" step="0.05"></label><button type="submit">保存并应用</button></form><p class="mute">前台快捷键：Cmd/Ctrl+Shift+H 历史 · P 项目 · L 紧凑布局 · F 搜索帮助。输入时不触发。</p><p id="org-layout-status"></p></section>
    <section class="card"><h2>用户状态备份</h2><p class="mute">包含偏好、共享设置、快捷键、预设与字段历史、图库参考图与分类布局、项目、布局、书签与历史关联；不含生成图片、检查点、连接配置、凭证或浏览器。备份上限 40 MB，超限整体失败。导入先显示预检，失败自动回滚。</p><div class="org-toolbar"><button id="org-backup-export">导出备份</button><button id="org-backup-preflight">选择备份并预检</button><button id="org-backup-import" hidden>确认导入已预检文件</button><button id="org-rollbacks-refresh">刷新回滚记录</button></div><pre id="org-backup-plan"></pre><div id="org-rollbacks" class="org-list"></div></section>
    <section class="card"><div class="org-toolbar"><h2>缓存与回收站</h2><button id="org-cache-refresh">检查占用</button></div><p id="org-cache-usage"></p><div id="org-cache-list" class="org-list"></div><button id="org-cache-trash">将选中预览移至回收站</button><div id="org-trash-list" class="org-list"></div></section>
    <section class="card"><h2>网页书签</h2><form id="org-bookmark-form" class="org-toolbar"><label>名称<input id="org-bookmark-title" required></label><label>HTTPS 地址<input id="org-bookmark-url" type="url" required placeholder="https://"></label><button type="submit">保存</button></form><div id="org-bookmarks" class="org-list"></div></section>
    <section class="card"><div class="org-toolbar"><h2>帮助与诊断</h2><button id="org-diagnostics">导出脱敏诊断</button></div><form id="org-help-form" class="org-toolbar"><label>搜索手册<input id="org-help-query" type="search" placeholder="历史、恢复、Eagle、快捷键…"></label><button type="submit">搜索</button></form><div id="org-help-list"></div></section>`);

  // Controls stay in the trusted renderer; the webpage itself is an isolated
  // native view with no bridge/preload. Native DIP width is converted for CSS zoom.
  $o('bookmark-form').closest('section').insertAdjacentHTML('beforebegin', `
    <section class="card"><h2>网页参考分屏</h2><form id="org-reference-form" class="org-toolbar"><label>HTTPS 网页<input id="org-reference-url" type="url" required placeholder="https://"></label><button type="submit">分屏打开 / 更新</button><button type="button" id="org-reference-close">关闭分屏</button></form><div class="org-toolbar"><label>右侧宽度<input id="org-reference-width" type="range" min="240" max="720" step="20" value="420"></label><button id="org-reference-chrome">打开专用 Chrome</button></div><p class="mute">参考网页使用独立浏览器空间，不共享应用权限。Google / ChatGPT 登录继续在专用 Chrome 进行。</p><p id="org-reference-status" role="status">未打开分屏</p></section>`);
  const referenceBar=document.createElement('div');referenceBar.className='org-reference-toolbar';referenceBar.hidden=true;
  referenceBar.innerHTML='<span>参考分屏</span><button type="button">关闭</button>';
  (document.querySelector('.topbar')||document.body).append(referenceBar);
  function referenceState(value){
    state.reference=value;document.body.classList.toggle('org-reference-open',!!value.open);
    document.documentElement.style.setProperty('--org-reference-width',`${(value.width||0)/(state.layout?.zoom||1)}px`);
    referenceBar.hidden=!value.open;
    $o('reference-width').value=value.requestedWidth||420;
    $o('reference-status').textContent=value.error||(value.open?`${value.loading?'加载中 · ':''}${value.url} · ${value.width}px`:'未打开分屏');
  }
  const closeReference=guard(async()=>{if(!window.bridge.closeOrganizerReference)throw new Error('当前桌面尚未接入网页分屏');referenceState(await window.bridge.closeOrganizerReference());});
  referenceBar.querySelector('button').onclick=closeReference;$o('reference-close').onclick=closeReference;
  async function openReference(url){
    if(!window.bridge.openOrganizerReference)throw new Error('当前桌面尚未接入网页分屏');
    referenceState(await window.bridge.openOrganizerReference({url,width:Number($o('reference-width').value)}));
  }
  $o('reference-form').onsubmit=guard(async e=>{e.preventDefault();await openReference($o('reference-url').value);});
  $o('reference-width').onchange=guard(async()=>{if(!window.bridge.setOrganizerReferenceWidth)throw new Error('当前桌面尚未接入网页分屏');referenceState(await window.bridge.setOrganizerReferenceWidth(Number($o('reference-width').value)));});
  $o('reference-chrome').onclick=guard(()=>window.bridge.open('chrome'));
  $o('floating-open').onclick=guard(async()=>{if(!window.bridge.openOrganizerFloating)throw new Error('当前桌面尚未接入浮动任务卡');await window.bridge.openOrganizerFloating();});
  $o('floating-close').onclick=guard(async()=>{if(window.bridge.closeOrganizerFloating)await window.bridge.closeOrganizerFloating();});
  if(window.bridge.onOrganizerReferenceState)window.bridge.onOrganizerReferenceState(referenceState);
  if(window.bridge.organizerReferenceState)guard(async()=>referenceState(await window.bridge.organizerReferenceState()))();

  async function refreshProjects() {
    state.projects = (await get('projects')).projects;
    for (const id of ['project-filter','link-project']) { const old=$o(id).value;$o(id).innerHTML=option('',id==='project-filter'?'全部项目':'未关联')+state.projects.map(p=>option(p.id,p.title)).join('');$o(id).value=old; }
    $o('project-list').innerHTML=state.projects.map(p=>`<article><div><strong>${esc(p.title)}</strong><p>${esc(p.state)} · ${esc(p.due||'未安排日期')}${p.due && p.due<today() && !['done','archived'].includes(p.state)?' · 已逾期':''} · ${p.jobIds?.length||0} 个任务</p></div><div class="org-toolbar"><button data-project="${esc(p.id)}">编辑</button><button data-delay="${esc(p.id)}" data-days="1">延后一天</button><button data-delay="${esc(p.id)}" data-days="7">延后一周</button></div></article>`).join('')||'<p class="mute">还没有项目</p>';
    drawCalendar();
  }
  function drawCalendar() {
    const month=$o('month').value||today().slice(0,7), [y,m]=month.split('-').map(Number), count=new Date(y,m,0).getDate(), first=new Date(y,m-1,1).getDay();
    const items=state.projects.filter(p=>p.due?.startsWith(month)&&!['done','archived'].includes(p.state));
    $o('calendar').innerHTML=['日','一','二','三','四','五','六'].map(x=>`<strong>${x}</strong>`).join('')+'<span></span>'.repeat(first)+Array.from({length:count},(_,i)=>{const d=`${month}-${String(i+1).padStart(2,'0')}`;return `<div class="org-day${d===today()?' org-today':''}"><span>${i+1}</span>${items.filter(p=>p.due===d).map(p=>`<button data-project="${esc(p.id)}">${esc(p.title)}</button>`).join('')}</div>`;}).join('');
  }
  async function refreshHistory() {
    const seq=++state.historySeq;
    const r=await get('history',{offset:state.offset,limit:state.limit,q:$o('search').value,projectId:$o('project-filter').value,originalId:$o('original-filter').value});
    if(seq!==state.historySeq)return;state.rows=r.items;
    $o('history-list').innerHTML=r.items.map(j=>`<article><div><strong>${esc(j.title)}</strong><p>${esc(new Date(j.createdAt).toLocaleString())} · ${esc(j.provider)} · ${esc(j.status)}</p><p class="mute">原图组 ${esc(j.originalId)} · ${j.cost?`${esc(j.cost.amount)} ${esc(j.cost.currency)}（${esc(j.cost.source)}）`:'费用未记录'}</p></div><button data-select="${esc(j.id)}">${j.hasResult?'查看版本':'查看提示词'}</button></article>`).join('')||'<p class="mute">没有匹配的历史</p>';
    $o('history-count').textContent=`${r.total?state.offset+1:0}–${state.offset+r.items.length} / ${r.total}${r.issues.length?` · ${r.issues.length} 条损坏记录已跳过`:''}`;
    $o('prev').disabled=!state.offset;$o('next').disabled=!r.hasMore;
  }
  const selection=()=>({jobId:state.selected?.id,variant:$o('version').value||'applied'});
  async function resultPreview() {
    const seq=++state.previewSeq;$o('eagle-archive').disabled=true;$o('restore-result').disabled=true;$o('result-image').hidden=true;$o('result-image').removeAttribute('src');
    if(!state.selected?.hasResult)return;
    const r=await post('history/preview',selection());if(seq!==state.previewSeq)return;$o('result-image').src=r.dataUrl;$o('result-image').hidden=false;$o('eagle-archive').disabled=false;$o('restore-result').disabled=false;
  }
  function eagleTags(){return $o('eagle-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean);}
  function eaglePreview(){$o('eagle-preview').textContent=`归档：${$o('eagle-name').value} · 版本 ${$o('version').value} · 标签：${eagleTags().join(' / ')||'无'}`;}
  async function selectResult(id) {
    state.selected=state.rows.find(j=>j.id===id);if(!state.selected)throw new Error('请刷新历史后重新选择');const j=state.selected;
    $o('result').hidden=false;$o('result-title').textContent=j.title;$o('prompt').value=j.prompt;
    $o('version').innerHTML=j.versions.map(v=>option(v,v==='applied'?'已应用 / 当前默认':v==='raw'?'原始生成':v)).join('');
    $o('link-project').value=j.projectId;$o('link-original').value=j.originalId;$o('eagle-name').value=j.title;eaglePreview();
    $o('reveal').disabled=!j.canReveal;$o('reveal').title=j.canReveal?'':'较早的历史请先恢复为新结果，再显示目录';$o('restore-result').disabled=!j.hasResult;$o('eagle-archive').disabled=!j.hasResult;
    await resultPreview();
  }
  async function refreshCheckpoints(){
    const r=await get('checkpoints',{offset:state.checkpointOffset,limit:12});
    $o('checkpoint-list').innerHTML=r.items.map(c=>`<article><span>${esc(c.name)} · ${bytes(c.bytes)}</span><button data-checkpoint="${esc(c.id)}">浏览</button></article>`).join('')||'<p class="mute">没有画布检查点</p>';
    $o('checkpoint-count').textContent=`${r.total?state.checkpointOffset+1:0}–${state.checkpointOffset+r.items.length} / ${r.total}`;$o('checkpoint-prev').disabled=!state.checkpointOffset;$o('checkpoint-next').disabled=!r.hasMore;
  }
  async function restored(r){say(`已创建新的本地结果：${r.jobId}`);state.offset=0;await refreshHistory();}
  $o('history-filter').onsubmit=guard(async e=>{e.preventDefault();state.offset=0;await refreshHistory();});
  $o('history-refresh').onclick=guard(async()=>{await refreshProjects();await refreshHistory();});
  $o('filter-reset').onclick=guard(async()=>{for(const id of ['search','project-filter','original-filter'])$o(id).value='';state.offset=0;await refreshHistory();});
  $o('prev').onclick=guard(async()=>{state.offset=Math.max(0,state.offset-state.limit);await refreshHistory();});
  $o('next').onclick=guard(async()=>{state.offset+=state.limit;await refreshHistory();});
  $o('history-list').onclick=guard(async e=>{const id=e.target.closest('[data-select]')?.dataset.select;if(id)await selectResult(id);});
  $o('version').onchange=guard(async()=>{eaglePreview();await resultPreview();});
  $o('copy-prompt').onclick=guard(async()=>{await window.bridge.copyText($o('prompt').value);say('提示词已复制');});
  $o('reuse-prompt').onclick=guard(()=>{const field=document.getElementById('genPrompt');if(!field)throw new Error('工作台提示词输入框不可用');field.value=$o('prompt').value;field.dispatchEvent(new Event('input',{bubbles:true}));showTab('work');field.focus();});
  $o('reveal').onclick=guard(()=>window.bridge.revealJob(state.selected.id));
  $o('restore-result').onclick=guard(async()=>restored(await post('history/restore',selection())));
  $o('link-save').onclick=guard(async()=>{await post('history/link',{jobId:state.selected.id,projectId:$o('link-project').value,originalId:$o('link-original').value});say('历史关联已保存');await refreshHistory();});
  $o('eagle-tags').oninput=eaglePreview;$o('eagle-name').oninput=eaglePreview;
  $o('eagle-detect').onclick=guard(async()=>{const r=await get('eagle/detect');$o('eagle-status').textContent=r.available?`Eagle ${r.version} · 官方 API 可用`:r.next;});
  $o('eagle-archive').onclick=guard(async()=>{if(!window.confirm(`将上方所选版本归档到 Eagle？\n${$o('eagle-preview').textContent}\n原文件保留。`))return;const r=await post('eagle/archive',{...selection(),name:$o('eagle-name').value,tags:eagleTags(),confirm:true});say(r.originalPreserved?'Eagle 已确认归档，原文件保留':'Eagle 已确认归档；原文件校验异常，请核对',!r.originalPreserved);});
  $o('checkpoint-refresh').onclick=guard(refreshCheckpoints);
  $o('checkpoint-prev').onclick=guard(async()=>{state.checkpointOffset=Math.max(0,state.checkpointOffset-12);await refreshCheckpoints();});
  $o('checkpoint-next').onclick=guard(async()=>{state.checkpointOffset+=12;await refreshCheckpoints();});
  $o('checkpoint-list').onclick=guard(async e=>{const id=e.target.closest('[data-checkpoint]')?.dataset.checkpoint;if(!id)return;state.checkpoint=null;$o('checkpoint-image').hidden=true;$o('checkpoint-restore').hidden=true;const r=await post('checkpoints/preview',{id});state.checkpoint=id;$o('checkpoint-image').src=r.dataUrl;$o('checkpoint-image').hidden=false;$o('checkpoint-restore').hidden=false;});
  $o('checkpoint-restore').onclick=guard(async()=>restored(await post('checkpoints/restore',{id:state.checkpoint})));

  let editing={jobIds:[],documents:[]};
  function editProject(id){const p=state.projects.find(p=>p.id===id)||{state:'todo',jobIds:[],documents:[]};editing={...p,jobIds:[...(p.jobIds||[])],documents:[...(p.documents||[])]};for(const k of ['id','title','state','due','notes'])$o(`project-${k}`).value=p[k]||'';$o('project-reminder').checked=!!p.reminder;linked();}
  function linked(){$o('project-linked').textContent=`关联任务 ${editing.jobIds.join(', ')||'无'}；文档 ${editing.documents.map(d=>d.name).join(', ')||'无'}`;}
  $o('project-new').onclick=()=>editProject();$o('project-refresh').onclick=guard(refreshProjects);$o('month').value=today().slice(0,7);$o('month').onchange=drawCalendar;
  const projectClick=guard(async e=>{const b=e.target.closest('button');if(b?.dataset.project)editProject(b.dataset.project);if(b?.dataset.delay){await post('projects/delay',{id:b.dataset.delay,days:Number(b.dataset.days),today:today()});await refreshProjects();}});
  $o('project-list').onclick=projectClick;$o('calendar').onclick=projectClick;
  $o('project-add-result').onclick=guard(()=>{if(!state.selected)throw new Error('请先在历史页选择一个结果');editing.jobIds=[...new Set([...editing.jobIds,state.selected.id])];linked();});
  let projectDocuments=[];
  const documentKey=d=>`${d.session}:${d.docId}`;
  async function readProjectDocuments(){
    const result=await api('POST','/bridge/ps',{type:'documents'});
    if(!Array.isArray(result.documents))throw new Error('Photoshop 未返回文档列表');
    return result.documents.map(d=>({...d,session:d.session||result.session})).filter(d=>Number.isSafeInteger(d.docId)&&d.docId>0&&typeof d.session==='string');
  }
  $o('project-refresh-docs').onclick=guard(async()=>{
    const previous=$o('project-document').value;projectDocuments=await readProjectDocuments();
    $o('project-document').innerHTML=option('','请选择要关联的文档')+projectDocuments.map(d=>option(documentKey(d),`${d.name} · #${d.docId}`)).join('');
    $o('project-document').value=projectDocuments.some(d=>documentKey(d)===previous)?previous:'';
    say(`已读取 ${projectDocuments.length} 个文档；请明确选择，当前 Photoshop 文档保持不变`);
  });
  $o('project-add-doc').onclick=guard(async()=>{
    const key=$o('project-document').value;if(!key)throw new Error('请读取并选择要关联的 Photoshop 文档');
    const current=await readProjectDocuments(),doc=current.find(d=>documentKey(d)===key);
    if(!doc)throw new Error('所选文档会话已关闭或变化，请重新读取并选择');
    editing.documents=editing.documents.filter(d=>!(d.docId===doc.docId&&d.session===doc.session));
    editing.documents.push({id:String(doc.docId),docId:doc.docId,session:doc.session,name:doc.name||String(doc.docId)});linked();
  });
  $o('project-form').onsubmit=guard(async e=>{e.preventDefault();const p=await post('projects',{id:$o('project-id').value||undefined,title:$o('project-title').value,state:$o('project-state').value,due:$o('project-due').value,notes:$o('project-notes').value,reminder:$o('project-reminder').checked,jobIds:editing.jobIds,documents:editing.documents});await refreshProjects();editProject(p.id);say('项目已保存；日程更改后可更新驻留提醒');});
  $o('notifications').onclick=guard(async()=>{if(!window.bridge.scheduleOrganizerNotifications)throw new Error('当前桌面版本尚未接入项目通知。请完成桌面通知集成后重试。');const r=await window.bridge.scheduleOrganizerNotifications({projects:state.projects.filter(p=>p.reminder&&p.due&&!['done','archived'].includes(p.state)).map(({id,title,due})=>({id,title,due}))});if(!Number.isInteger(r?.scheduled))throw new Error('桌面未确认提醒已调度');say(`已调度 ${r.scheduled} 个项目提醒`);});

  async function applyLayout(value, native=false){
    state.layout=value;if(state.reference)referenceState(state.reference);document.documentElement.dataset.orgTheme=value.theme;document.documentElement.dataset.orgMode=value.mode;
    // CSS zoom is a real local fallback; native hook owns actual BrowserWindow opacity.
    document.documentElement.style.zoom=String(value.zoom);
    for(const k of ['mode','theme','zoom','opacity'])$o(`layout-${k}`).value=value[k];
    if(window.bridge.applyOrganizerLayout){const r=await window.bridge.applyOrganizerLayout(value);if(r?.applied!==true)throw new Error('桌面未确认原生布局已应用');$o('layout-status').textContent='布局已保存并应用';}
    else {$o('layout-status').textContent='页面布局、主题与缩放已应用；窗口透明度尚未接入桌面设置。';if(native)say('布局已保存；窗口透明度尚未接入桌面设置');}
  }
  $o('layout-form').onsubmit=guard(async e=>{e.preventDefault();await applyLayout(await post('layout',{mode:$o('layout-mode').value,theme:$o('layout-theme').value,zoom:Number($o('layout-zoom').value),opacity:Number($o('layout-opacity').value)}),true);});
  async function savePack(name,data){if(!window.bridge.savePack)throw new Error('需要桌面 savePack 文件保存接口');const file=await window.bridge.savePack(name,data);if(file)say('文件已保存');}
  async function rollbacks(){const r=await get('backup/rollbacks');$o('rollbacks').innerHTML=r.items.sort((a,b)=>b.createdAt-a.createdAt).map(x=>`<article><span>${esc(new Date(x.createdAt).toLocaleString())} · ${esc(x.status)} · ${x.files} 个文件</span>${['applying','applied','rollback-failed'].includes(x.status)?`<button data-rollback="${esc(x.id)}">回滚本次导入</button>`:''}</article>`).join('');}
  $o('backup-export').onclick=guard(async()=>savePack(`ps-ai-bridge-state-${today()}.json`,await post('backup/export')));
  $o('backup-preflight').onclick=guard(async()=>{state.pack=null;state.preflight=null;$o('backup-import').hidden=true;if(!window.bridge.openPack)throw new Error('需要桌面 openPack 文件选择接口');const r=await window.bridge.openPack();if(!r)return;const p=await post('backup/preflight',{pack:r.data});state.pack=r.data;state.preflight=p;$o('backup-plan').textContent=`${r.name}\n${p.files.length} 个文件，${bytes(p.totalBytes)}\n${p.files.map(f=>`${f.previous?'替换':'新增'} ${f.path}`).join('\n')}\n导入会保留可回滚副本；完成后在任务空闲时重启本机服务刷新缓存。预检有效期 10 分钟。`;$o('backup-import').hidden=false;});
  $o('backup-import').onclick=guard(async()=>{if(!state.preflight)throw new Error('请先预检');const r=await post('backup/import',{pack:state.pack,token:state.preflight.token});state.pack=null;state.preflight=null;$o('backup-import').hidden=true;say(`已导入 ${r.files} 个文件。请在任务空闲时重启本机服务刷新预设及设置缓存，回滚记录 ${r.id}`);await applyLayout(await get('layout'));await refreshProjects();await rollbacks();await refreshBookmarks();});
  $o('rollbacks-refresh').onclick=guard(rollbacks);$o('rollbacks').onclick=guard(async e=>{const id=e.target.closest('[data-rollback]')?.dataset.rollback;if(!id||!window.confirm('恢复该次导入前的用户状态？如文件已有后续修改将停止。'))return;await post('backup/rollback',{id});await rollbacks();await applyLayout(await get('layout'));await refreshProjects();await refreshBookmarks();say('已回滚，请在任务空闲时重启本机服务刷新预设及设置缓存');});
  async function cache(){const r=await get('cache'), t=await get('cache/trash');$o('cache-usage').textContent=`结果目录 ${bytes(r.outputBytes)} · 预览 ${bytes(r.previewBytes)} · 回收站 ${bytes(r.trashBytes)}。${r.scope}`;$o('cache-list').innerHTML=r.previews.map(p=>`<label><input type="checkbox" data-preview="${esc(p.id)}" ${p.protected?'disabled':''}>${esc(p.id)} · ${bytes(p.bytes)} ${p.protected?'（活动任务保护）':''}</label>`).join('')||'<p class="mute">无可回收预览</p>';$o('trash-list').innerHTML=t.items.filter(x=>x.status!=='restored').map(x=>`<article><span>${esc(new Date(x.createdAt).toLocaleString())} · ${x.entries.length} 个预览 · ${esc(x.status)}</span><button data-trash="${esc(x.id)}">恢复</button></article>`).join('');}
  $o('cache-refresh').onclick=guard(cache);$o('cache-trash').onclick=guard(async()=>{const ids=[...$o('cache-list').querySelectorAll('input:checked')].map(e=>e.dataset.preview);if(!ids.length)throw new Error('请选择预览文件');await post('cache/trash',{ids});await cache();say('预览已移入可恢复回收站');});
  $o('trash-list').onclick=guard(async e=>{const id=e.target.closest('[data-trash]')?.dataset.trash;if(id){await post('cache/restore',{id});await cache();say('预览已恢复');}});
  async function refreshBookmarks(){const r=await get('bookmarks');$o('bookmarks').innerHTML=r.items.map(b=>`<article><span>${esc(b.title)}<small>${esc(b.url)}</small></span><div><button data-reference-url="${esc(b.url)}">分屏查看</button><button data-bookmark-copy="${esc(b.url)}">复制地址</button><button data-bookmark-url="${esc(b.url)}">打开</button><button data-bookmark-delete="${esc(b.id)}">删除</button></div></article>`).join('');}
  $o('bookmark-form').onsubmit=guard(async e=>{e.preventDefault();await post('bookmarks',{title:$o('bookmark-title').value,url:$o('bookmark-url').value});await refreshBookmarks();});
  $o('bookmarks').onclick=guard(async e=>{const b=e.target.closest('button');if(b?.dataset.referenceUrl)await openReference(b.dataset.referenceUrl);if(b?.dataset.bookmarkCopy){await window.bridge.copyText(b.dataset.bookmarkCopy);say('书签地址已复制');}if(b?.dataset.bookmarkDelete){await post('bookmarks/delete',{id:b.dataset.bookmarkDelete});await refreshBookmarks();}if(b?.dataset.bookmarkUrl){const u=new URL(b.dataset.bookmarkUrl);if(u.protocol!=='https:'||u.username||u.password)throw new Error('只允许 HTTPS');if(window.bridge.openSupportsHTTPS===true)await window.bridge.open(u.href);else if(window.bridge.openExternalHTTPS)await window.bridge.openExternalHTTPS(u.href);else throw new Error('当前桌面版本尚未接入 HTTPS 书签打开。可先复制地址到浏览器。');}});
  async function help(){const r=await get('help',{q:$o('help-query').value});$o('help-list').innerHTML=r.items.map(x=>`<article><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></article>`).join('')||'<p>没有匹配条目</p>';}
  $o('help-form').onsubmit=guard(async e=>{e.preventDefault();await help();});
  $o('diagnostics').onclick=guard(async()=>savePack(`ps-ai-bridge-diagnostics-${today()}.json`,await get('diagnostics')));
  document.addEventListener('workspace-tab',guard(async e=>{if(e.detail==='organizer-history'){await refreshProjects();await refreshHistory();await refreshCheckpoints();}if(e.detail==='organizer-projects')await refreshProjects();if(e.detail==='organizer'){await applyLayout(await get('layout'));await refreshBookmarks();await rollbacks();await help();}}));
  document.addEventListener('keydown',guard(async e=>{
    if(e.repeat||e.isComposing||e.defaultPrevented||!document.hasFocus()||!(e.metaKey||e.ctrlKey)||!e.shiftKey||e.altKey||e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return;
    const key=e.key.toLowerCase();if(!['h','p','l','f'].includes(key))return;e.preventDefault();
    if(key==='h')showTab('organizer-history');if(key==='p')showTab('organizer-projects');
    if(key==='f'){showTab('organizer');$o('help-query').focus();}
    if(key==='l'){const value=state.layout||await get('layout');await applyLayout(await post('layout',{...value,mode:value.mode==='compact'?'full':'compact'}),true);}
  }));
  window.organizer={refresh:guard(async()=>{await refreshProjects();await refreshHistory();}),tabs:['organizer-history','organizer-projects','organizer']};
  let restoredInitialLayout=false;
  const restoreInitialLayout=guard(async()=>{await applyLayout(await get('layout'));restoredInitialLayout=true;});
  if(window.bridge.onHelper)window.bridge.onHelper(value=>{if(!restoredInitialLayout&&['running','external'].includes(value?.status))restoreInitialLayout();});
  editProject();restoreInitialLayout();
})();
