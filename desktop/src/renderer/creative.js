/* Load after workspace.js. This module installs its own tab, styles and guarded handlers. */
(() => {
  if (document.getElementById('tab-creative')) return;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'creative.css'; document.head.append(css);
  const tab = document.createElement('button'); tab.className = 'tab-btn'; tab.dataset.tab = 'creative'; tab.role = 'tab'; tab.textContent = '创作幕布';
  tab.onclick = () => showTab('creative'); // Initial workspace listeners have already been enumerated.
  document.querySelector('.tabs').append(tab);
  const pane = document.createElement('section'); pane.id = 'tab-creative'; pane.className = 'tab creative'; pane.hidden = true; document.body.append(pane);
  const state = { canvas: null, graph: { nodes: [] }, selected: null, dirty: false, review: null, catalog: null, execution: null, assetUrls: new Map(), materialUrls: new Map(), page: 'canvas', tool: 'lighting', title: '创作项目', prompt: '', style: '', effects: '', materials: [], templateId: 'editorial', width: 1200, height: 1600, pages: [{ headline: '', subtitle: '', body: '' }], rig: { camera: { azimuth: 0, elevation: 10, distance: 5, focal: 50 }, ambient: .08, lights: [{ id: 'light-1', name: '主光', x: -2, y: 3, z: 3, intensity: 1, temperature: 5600, color: '#ffffff', fixture: 'softbox', enabled: true }] }, previewMode: '3d', lightIndex: 0 };
  let proposalBusy = false;
  const suggestions = { lights: null, pages: null };
  state.analysisBackend = 'channel'; state.posterSource = '';
  let pending = false, pollBusy = false, drag = null;
  const el = id => document.getElementById(`cr-${id}`);
  const call = (method, route, body) => api(method, `/creative/${route}`, body);
  const message = msg => { el('message').textContent = msg; };
  const guard = fn => async (...args) => { if (pending) return; pending = true; pane.setAttribute('aria-busy', 'true'); try { await fn(...args); } catch (e) { message(reason(e)); toast(reason(e), true); } finally { pending = false; pane.removeAttribute('aria-busy'); } };
  const button = (id, label) => `<button id="cr-${id}">${label}</button>`;
  const field = (label, html) => `<label class="cr-field">${label}${html}</label>`;
  const input = (id, value = '', type = 'text', extra = '') => `<input id="cr-${id}" type="${type}" value="${esc(value)}" ${extra}>`;
  const options = (items, value) => items.map(item => { const [v, name] = Array.isArray(item) ? item : [item, item]; return `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(name)}</option>`; }).join('');
  const typeNames = { image: '图像输入', generate: '生成', candidate: '候选选择', stitch: '拼接', output: '输出' };
  const statusNames = { pending: '待执行', submitting: '提交中', running: '执行中', paused: '已暂停', done: '完成', error: '失败', uncertain: '提交未知', 'needs-attention': '需要核对', 'awaiting-selection': '等待选择', cancelled: '已取消' };
  pane.innerHTML = `<header class="cr-header"><div><h2>创作工作台</h2><p>幕布保存、明确选择候选、逐步执行。预览为艺术示意，生成效果需人工验收。</p></div></header>
    <nav class="cr-nav" aria-label="创作工具">${[['canvas', '幕布'], ['lighting', '相机 / 布光 / 拆光'], ['scene', '场景素材'], ['poster', '多页海报'], ['presets', '工具预设']].map(([id, title]) => `<button data-cr-page="${id}">${title}</button>`).join('')}</nav>
    <p id="cr-message" role="status" aria-live="polite"></p><div id="cr-content"></div><section id="cr-review" hidden></section><section id="cr-execution"></section>`;
  const markDirty = () => { state.dirty = true; state.review = null; el('review').hidden = true; message('幕布有未保存修改'); };
  function workOptions() {
    const provider = $('provider')?.value;
    if (!provider) throw new Error('先在工作台选择生成平台');
    return { provider, model: $('model')?.value || '', aspect: $('aspect')?.value === 'auto' ? '1:1' : $('aspect')?.value || '1:1', resolution: $('resolution')?.value || '2K', thinking: $('thinking')?.value || 'High', count: 1 };
  }
  function toolSettings() { return { tool: state.tool, captureId: state.captureId || null, title: state.title, rig: state.rig, prompt: state.prompt, style: state.style, effects: state.effects, materials: state.materials, templateId: state.templateId, width: state.width, height: state.height, pages: state.pages, options: state.loadedOptions || workOptions() }; }
  function bind(id, fn) { if (el(id)) el(id).onclick = guard(fn); }
  function loadCanvas(c) { state.canvas = c; state.graph = structuredClone(c.graph); state.execution = c.execution; state.selected = state.graph.nodes[0]?.id; state.dirty = false; state.review = null; el('review').hidden = true; }
  async function library() {
    const data = await call('GET', 'canvases');
    if (el('library')) el('library').innerHTML = '<option value="">选择已保存幕布</option>' + options(data.canvases.map(c => [c.id, c.title]), state.canvas?.id);
  }
  async function saveCanvas() {
    const title = el('canvas-title')?.value || state.canvas?.title || '未命名幕布';
    const c = state.canvas ? await call('POST', `canvases/${state.canvas.id}/save`, { revision: state.canvas.revision, graph: state.graph, title }) : await call('POST', 'canvases', { title, graph: state.graph });
    loadCanvas(c); message('幕布和图像已持久保存'); await library(); drawGraph(); drawInspector(); renderExecution();
  }
  function newNode(type) {
    const id = `n-${crypto.randomUUID()}`, config = type === 'generate' ? { ...workOptions(), prompt: $('genPrompt')?.value || '按要求编辑图像，保持人物身份与未指定区域。' } : type === 'stitch' ? { mode: 'horizontal', columns: 2, gap: 0 } : type === 'output' ? { blendMode: 'normal' } : {};
    const previous = state.graph.nodes.find(n => n.id === state.selected);
    const validPrevious = previous && previous.type !== 'output' && (previous.type !== 'generate' || type === 'candidate') && (type !== 'candidate' || previous.type === 'generate') && type !== 'image';
    const n = { id, type, title: typeNames[type], config, inputs: validPrevious ? [previous.id] : [], position: { x: 35 + (state.graph.nodes.length % 4) * 280, y: 40 + Math.floor(state.graph.nodes.length / 4) * 170 } };
    state.graph.nodes.push(n); state.selected = id; markDirty(); drawGraph(); drawInspector();
  }
  async function showPage(name) {
    state.page = name;
    pane.querySelectorAll('[data-cr-page]').forEach(b => b.classList.toggle('active', b.dataset.crPage === name));
    if (!state.catalog) state.catalog = await call('GET', 'catalog');
    if (name === 'canvas') renderCanvas();
    else if (name === 'presets') await renderPresets();
    else { state.tool = name; renderTool(); }
    renderExecution();
  }
  pane.querySelector('.cr-nav').onclick = e => { if (e.target.dataset.crPage) guard(() => showPage(e.target.dataset.crPage))(); };
  function renderCanvas() {
    el('content').innerHTML = `<div class="cr-toolbar">${input('canvas-title', state.canvas?.title || '未命名幕布')}<select id="cr-library" aria-label="已保存幕布"></select>${button('open', '打开')}${button('new', '新建')}${button('save', '保存修订')}${button('undo', '撤销')}${button('redo', '重做')}${button('review-run', '审阅执行')}</div>
      <div class="cr-toolbar">${Object.entries(typeNames).map(([t, name]) => `<button data-cr-add="${t}">＋ ${name}</button>`).join('')}<span>拖动节点标题移动；右侧连接输入，列表顺序决定原图 / 参考图顺序。</span></div>
      <div class="cr-canvas-layout"><div class="cr-scroll"><div id="cr-board"><svg id="cr-wires" aria-hidden="true"></svg><div id="cr-nodes"></div></div></div><aside id="cr-inspector"></aside></div>`;
    el('canvas-title').oninput = markDirty;
    bind('open', async () => { const id = el('library').value; if (!id) return; if (state.dirty && !confirm('放弃未保存的幕布修改？')) return; loadCanvas(await call('GET', `canvases/${id}`)); renderCanvas(); renderExecution(); });
    bind('new', () => { if (state.dirty && !confirm('放弃未保存的幕布修改？')) return; state.canvas = null; state.execution = null; state.graph = { nodes: [] }; state.selected = null; state.dirty = false; state.review = null; el('review').hidden = true; renderCanvas(); renderExecution(); });
    bind('save', saveCanvas);
    for (const action of ['undo', 'redo']) bind(action, async () => { if (!state.canvas) throw new Error('请先保存幕布'); if (state.dirty) throw new Error('请先保存修改，再撤销已保存修订'); loadCanvas(await call('POST', `canvases/${state.canvas.id}/${action}`, { revision: state.canvas.revision })); renderCanvas(); renderExecution(); });
    bind('review-run', async () => { await saveCanvas(); state.review = await call('POST', `canvases/${state.canvas.id}/review`); renderReview(); });
    el('content').querySelectorAll('[data-cr-add]').forEach(b => b.onclick = guard(() => newNode(b.dataset.crAdd)));
    library().catch(e => message(reason(e))); drawGraph(); drawInspector();
  }
  function drawGraph() {
    if (!el('nodes')) return;
    const nodes = state.graph.nodes, byId = new Map(nodes.map(n => [n.id, n]));
    const w = Math.max(1300, ...nodes.map(n => n.position.x + 300)), h = Math.max(650, ...nodes.map(n => n.position.y + 160));
    el('board').style.width = `${w}px`; el('board').style.height = `${h}px`; el('wires').setAttribute('width', w); el('wires').setAttribute('height', h);
    el('wires').innerHTML = nodes.flatMap(n => n.inputs.map(id => { const from = byId.get(id); if (!from) return ''; const x1 = from.position.x + 230, y1 = from.position.y + 50, x2 = n.position.x, y2 = n.position.y + 50; return `<path d="M${x1},${y1} C${x1 + 55},${y1} ${x2 - 55},${y2} ${x2},${y2}"/>`; })).join('');
    el('nodes').innerHTML = nodes.map(n => `<article class="cr-node ${state.selected === n.id ? 'selected' : ''}" data-node="${n.id}"><button class="cr-node-handle" data-handle="${n.id}">${esc(n.title)}</button><p>${typeNames[n.type]} · ${esc(statusNames[state.execution?.nodes[n.id]?.status] || '草稿')}</p><small>${esc(n.type === 'generate' ? `${n.config.provider} · ${n.config.count || 1} 候选` : `${n.inputs.length} 个输入`)}</small></article>`).join('');
    el('nodes').querySelectorAll('[data-node]').forEach(card => { const n = byId.get(card.dataset.node); card.style.left = `${n.position.x}px`; card.style.top = `${n.position.y}px`; });
    el('nodes').onclick = e => { const n = e.target.closest('[data-node]'); if (n) { state.selected = n.dataset.node; drawGraph(); drawInspector(); } };
    el('nodes').onpointerdown = e => {
      const handle = e.target.closest('[data-handle]'); if (!handle || e.button !== 0) return;
      const n = byId.get(handle.dataset.handle); state.selected = n.id; drag = { node: n, x: e.clientX, y: e.clientY, ox: n.position.x, oy: n.position.y, moved: false }; e.preventDefault();
    };
  }
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.node.position.x = Math.min(20000, Math.max(0, Math.round(drag.ox + e.clientX - drag.x)));
    drag.node.position.y = Math.min(20000, Math.max(0, Math.round(drag.oy + e.clientY - drag.y)));
    drag.moved = true; drawGraph();
  });
  document.addEventListener('pointerup', () => { if (!drag) return; if (drag.moved) markDirty(); drag = null; drawInspector(); });
  function drawInspector() {
    if (!el('inspector')) return;
    const n = state.graph.nodes.find(n => n.id === state.selected);
    if (!n) { el('inspector').innerHTML = '<p>添加节点开始。图像 → 生成 → 候选选择 → 输出；也可用工具页建立完整幕布。</p>'; return; }
    const configField = (key, label, type = 'text', fallback = '', extra = '') => field(label, `<input data-config="${key}" type="${type}" value="${esc(n.config[key] ?? fallback)}" ${extra}>`);
    let fields = '';
    if (n.type === 'image') fields = `${button('node-pick', '导入图片')}${button('node-work', '使用工作台原图')}<p>${n.config.assetId ? '已保存素材' : '尚未选择图片'}</p><img id="cr-input-preview" class="cr-thumb" hidden><details><summary>从已完成任务 / 流程导入</summary>${field('任务或流程 ID', input('source-id'))}<select id="cr-source-kind">${options(['jobId', 'runId'], 'jobId')}</select>${button('node-history', '读取并固定结果')}</details>`;
    if (n.type === 'generate') fields = `${button('node-options', '使用工作台平台与参数')}<p>平台：${esc(n.config.provider)} · 模型：${esc(n.config.model || '平台默认')}</p>${configField('model', '模型 ID')}${configField('aspect', '比例')}${configField('resolution', '分辨率')}${configField('count', '候选数（每张单独提交）', 'number', 1, 'min="1" max="8"')}<label class="cr-field">提示词<textarea data-config="prompt" rows="7">${esc(n.config.prompt)}</textarea></label>`;
    if (n.type === 'candidate') fields = '<p>执行到此节点将暂停。查看缩略图并明确选择后，下游才可继续。</p>';
    if (n.type === 'stitch') {
      fields = field('模式', `<select data-config="mode">${options([['horizontal', '横向'], ['vertical', '纵向'], ['grid', '网格'], ['overlay', '图层叠加'], ['screen', '滤色叠加']], n.config.mode || 'horizontal')}</select>`);
      const overlay = ['overlay', 'screen'].includes(n.config.mode);
      fields += overlay ? configField('width', '画布宽', 'number', 1024) + configField('height', '画布高', 'number', 1024) : configField('cellWidth', '单格宽（空白取输入最大值）', 'number') + configField('cellHeight', '单格高', 'number') + configField('columns', '网格列数', 'number', 2) + configField('gap', '间距', 'number', 0);
      if (overlay) fields += n.inputs.map((id, i) => `<fieldset><legend>${esc(state.graph.nodes.find(n => n.id === id)?.title || id)}</legend>${['x', 'y', 'width', 'height', 'opacity'].map(k => field(k, `<input type="number" data-layer="${i}" data-layer-key="${k}" value="${n.config.layers?.[i]?.[k] ?? (k === 'opacity' ? 1 : ['width', 'height'].includes(k) ? 1024 : 0)}" step="${k === 'opacity' ? '.05' : '1'}">`)).join('')}</fieldset>`).join('');
    }
    if (n.type === 'output') fields = `${configField('captureId', '原文档捕获 ID（可选，绑定贴回）')}${configField('width', '输出宽（空白保持输入）', 'number')}${configField('height', '输出高', 'number')}${field('图层建议混合模式', `<select data-config="blendMode">${options([['normal', '正常'], ['screen', '滤色 Screen']], n.config.blendMode || 'normal')}</select>`)}<p>精确规格输出采用等比缩放并留透明边，不裁切。有捕获 ID 时可贴回原文档；父级 PS 桥将应用指定混合模式。</p>`;
    const candidates = state.graph.nodes.filter(x => x.id !== n.id && x.type !== 'output' && !n.inputs.includes(x.id) && (n.type !== 'candidate' || x.type === 'generate') && (x.type !== 'generate' || n.type === 'candidate'));
    el('inspector').innerHTML = `<h3>${typeNames[n.type]}</h3>${field('名称', input('node-title', n.title))}<div class="cr-two">${field('X', input('node-x', n.position.x, 'number'))}${field('Y', input('node-y', n.position.y, 'number'))}</div>${fields}${n.type !== 'image' ? `<h4>输入（第一张为原图）</h4><ol>${n.inputs.map((id, i) => `<li>${esc(state.graph.nodes.find(n => n.id === id)?.title || id)} <button data-unlink="${i}">移除</button>${i ? `<button data-input-up="${i}">上移</button>` : ''}</li>`).join('')}</ol><select id="cr-connect-id">${options(candidates.map(n => [n.id, n.title]), '')}</select>${button('connect', '连接输入')}` : ''}<hr>${button('delete-node', '删除节点')}`;
    const changed = () => { markDirty(); drawGraph(); };
    el('node-title').onchange = e => { n.title = e.target.value; changed(); };
    for (const axis of ['x', 'y']) el(`node-${axis}`).onchange = e => { const value = Number(e.target.value); if (!Number.isFinite(value) || value < 0 || value > 20000) { message('位置需在 0–20000'); return; } n.position[axis] = value; changed(); };
    el('inspector').querySelectorAll('[data-config]').forEach(control => control.onchange = () => {
      const key = control.dataset.config;
      if (control.type === 'number' && !control.value) delete n.config[key]; else n.config[key] = control.type === 'number' ? Number(control.value) : control.value;
      if (key === 'mode' && ['overlay', 'screen'].includes(n.config.mode)) syncLayers(n);
      changed(); if (key === 'mode') drawInspector();
    });
    el('inspector').querySelectorAll('[data-layer]').forEach(control => control.onchange = () => { syncLayers(n); n.config.layers[Number(control.dataset.layer)][control.dataset.layerKey] = Number(control.value); changed(); });
    el('inspector').querySelectorAll('[data-unlink]').forEach(b => b.onclick = () => { const i = Number(b.dataset.unlink); n.inputs.splice(i, 1); n.config.layers?.splice(i, 1); changed(); drawInspector(); });
    el('inspector').querySelectorAll('[data-input-up]').forEach(b => b.onclick = () => { const i = Number(b.dataset.inputUp); [n.inputs[i - 1], n.inputs[i]] = [n.inputs[i], n.inputs[i - 1]]; if (n.config.layers) [n.config.layers[i - 1], n.config.layers[i]] = [n.config.layers[i], n.config.layers[i - 1]]; changed(); drawInspector(); });
    bind('connect', () => { const id = el('connect-id').value; if (!id) return; n.inputs.push(id); syncLayers(n); changed(); drawInspector(); });
    bind('delete-node', () => { state.graph.nodes = state.graph.nodes.filter(x => x.id !== n.id); for (const x of state.graph.nodes) { const i = x.inputs.indexOf(n.id); if (i >= 0) { x.inputs.splice(i, 1); x.config.layers?.splice(i, 1); } } state.selected = null; changed(); drawInspector(); });
    async function setImage(source) { const asset = await call('POST', 'assets', source); n.config = { assetId: asset.assetId }; changed(); drawInspector(); }
    bind('node-pick', async () => { const [r] = await window.bridge.pickImages('original', false); if (r) await setImage({ uploadId: r.uploadId }); });
    bind('node-work', async () => { if (!work.input) throw new Error('工作台没有原图'); await setImage({ uploadId: work.input.uploadId }); });
    bind('node-history', () => setImage({ [el('source-kind').value]: el('source-id').value.trim() }));
    bind('node-options', () => { Object.assign(n.config, workOptions()); changed(); drawInspector(); });
    if (n.type === 'image' && n.config.assetId) assetUrl(n.config.assetId).then(src => { if (state.selected === n.id && el('input-preview')) { el('input-preview').src = src; el('input-preview').hidden = false; } }).catch(e => message(reason(e)));
  }
  function syncLayers(n) { if (n.type === 'stitch' && ['overlay', 'screen'].includes(n.config.mode)) n.config.layers = n.inputs.map((_, i) => n.config.layers?.[i] || { x: 0, y: 0, width: n.config.width || 1024, height: n.config.height || 1024, opacity: 1 }); }
  async function assetUrl(id) { if (!state.assetUrls.has(id)) { const r = await call('GET', `assets/${id}`); state.assetUrls.set(id, url(`/uploads/${r.uploadId}`)); } return state.assetUrls.get(id); }
  function renderReview() {
    const r = state.review; el('review').hidden = false;
    el('review').innerHTML = `<h3>执行前审阅</h3><p>将产生最多 <strong>${r.submissions}</strong> 次独立生成。原图 / 参考图已固定，候选选择后再继续。费用由所选平台决定。</p>${r.errors.map(x => `<p class="cr-error">${esc(x)}</p>`).join('')}${r.warnings.map(x => `<p>${esc(x)}</p>`).join('')}<div class="cr-review-nodes">${r.nodes.map(n => `<article><strong>${esc(n.title)} · ${typeNames[n.type]}</strong><p>输入：${esc(n.inputs.map(id => r.nodes.find(x => x.id === id)?.title).join(' → ') || '无')}</p>${n.type === 'generate' ? `<p>${esc(n.config.provider)} / ${esc(n.config.model || '默认模型')} · ${esc(n.config.aspect)} · ${esc(n.config.resolution)} · ${n.config.count} 张</p><pre>${esc(n.config.prompt)}</pre>` : n.type === 'output' ? `<p>${n.config.width ? `${n.config.width}×${n.config.height}` : '保持输入尺寸'} · ${esc(n.config.blendMode || 'normal')}</p>` : ''}</article>`).join('')}</div><label><input id="cr-reviewed" type="checkbox"> 已核对平台、提示词、素材顺序和生成次数</label>${button('start-reviewed', '开始 / 继续此修订')}`;
    el('start-reviewed').disabled = r.errors.length > 0;
    bind('start-reviewed', async () => { if (!el('reviewed').checked) throw new Error('请勾选审阅确认'); state.execution = await call('POST', `canvases/${state.canvas.id}/start`, { token: r.token, reviewed: true }); state.canvas.executionId = state.execution.id; el('review').hidden = true; message('执行已保存；可随时暂停后续提交'); renderExecution(); });
    el('review').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function renderExecution() {
    const e = state.execution;
    if (!e) { el('execution').innerHTML = ''; return; }
    el('execution').innerHTML = `<h3>执行：${esc(statusNames[e.status] || e.status)}</h3><p>${esc(e.note || '')}</p><div class="cr-toolbar">${['done', 'cancelled'].includes(e.status) ? '' : `${button('pause', '暂停后续')}${button('resume', '继续 / 检查已有任务')}${button('cancel', '取消后续执行')}`}${button('inspect-execution', '刷新状态')}</div><div class="cr-results">${e.graph.nodes.map(n => {
      const s = e.nodes[n.id];
      if (n.type === 'candidate' && s.status === 'awaiting-selection') return `<article><h4>${esc(n.title)}</h4><div class="cr-candidates">${n.inputs.flatMap(id => e.nodes[id].slots).filter(s => s.status === 'done').map(slot => `<button data-choose-node="${n.id}" data-choose-job="${slot.jobId}" data-asset="${slot.assetId}"><img alt="候选预览"><span>选择此候选</span></button>`).join('')}</div></article>`;
      if (n.type === 'output' && s.status === 'done') return `<article><h4>${esc(n.title)}</h4><img class="cr-output" data-asset="${s.assetId}" alt="已保存输出"><p>${s.blendMode === 'screen' ? '黑底光照贡献 · PS 使用滤色 Screen；需人工检查黑底及对位。' : '已保存至任务历史'}</p><button data-reveal-job="${s.jobId}">显示文件</button><button data-view-job="${s.jobId}">查看结果</button>${n.config.captureId ? `<button data-place-job="${s.jobId}" data-capture-id="${esc(n.config.captureId)}">贴回绑定文档</button>` : ''}${s.blendMode === 'screen' ? `<button data-copy-screen="${s.jobId}">复制滤色图层说明</button>` : ''}</article>`;
      if (n.type === 'generate') return `<article><strong>${esc(n.title)} · ${esc(statusNames[s.status])}</strong>${s.slots.map(slot => `<p>候选 ${slot.index + 1} · ${esc(statusNames[slot.status])} ${esc(slot.error || '')} ${slot.jobId ? `<button data-inspect-job="${slot.jobId}">检查任务</button>` : ''}${slot.canRecover && slot.status === 'error' ? `<button data-recover-node="${n.id}" data-slot="${slot.index}">恢复已有上游任务（不新建）</button>` : ''}${['uncertain', 'error', 'submitting'].includes(slot.status) ? `<button data-retry-node="${n.id}" data-slot="${slot.index}">核对后重试</button><button data-link-node="${n.id}" data-slot="${slot.index}">关联已有任务</button>` : ''}</p>${slot.status === 'awaiting-selection' ? `<div class="cr-candidates">${(slot.candidates || []).map(c => `<button data-job-select-node="${n.id}" data-slot="${slot.index}" data-candidate-id="${esc(c.id)}" data-asset="${c.assetId}" ${slot.selectedCandidateId && slot.selectedCandidateId !== c.id ? 'disabled' : ''}><img alt="平台候选"><span>选择平台候选 ${esc(c.id)}</span></button>`).join('')}</div>` : ''}`).join('')}</article>`;
      return '';
    }).join('')}</div><div id="cr-job-inspection"></div>`;
    for (const action of ['pause', 'resume', 'cancel']) bind(action, async () => { state.execution = await call('POST', `executions/${e.id}/${action}`); renderExecution(); });
    bind('inspect-execution', refreshExecution);
    el('execution').querySelectorAll('[data-job-select-node], [data-recover-node]').forEach(b => b.onclick = guard(async () => {
      const select = Boolean(b.dataset.jobSelectNode);
      state.execution = await call('POST', `executions/${e.id}/${select ? 'job-select' : 'recover-job'}`, { nodeId: b.dataset.jobSelectNode || b.dataset.recoverNode, slot: Number(b.dataset.slot), candidateId: b.dataset.candidateId });
      renderExecution();
    }));
    el('execution').querySelectorAll('[data-choose-node]').forEach(b => b.onclick = guard(async () => { state.execution = await call('POST', `executions/${e.id}/select`, { nodeId: b.dataset.chooseNode, jobId: b.dataset.chooseJob }); renderExecution(); }));
    el('execution').querySelectorAll('[data-place-job]').forEach(b => b.onclick = guard(async () => { await api('POST', '/bridge/ps', { type: 'paste-bound', captureId: b.dataset.captureId, jobId: b.dataset.placeJob }); message('已贴回绑定文档；混合模式由父级 PS 桥应用'); }));
    el('execution').querySelectorAll('[data-reveal-job]').forEach(b => b.onclick = guard(() => window.bridge.revealJob(b.dataset.revealJob)));
    el('execution').querySelectorAll('[data-view-job]').forEach(b => b.onclick = guard(async () => { await refreshJobs(); const j = work.jobs.find(j => j.id === b.dataset.viewJob); if (!j) throw new Error('结果未在最近历史中加载，请使用“显示文件”'); openViewer(j.groupId, j.id); }));
    el('execution').querySelectorAll('[data-copy-screen]').forEach(b => b.onclick = guard(async () => { await window.bridge.copyText(`将任务 ${b.dataset.copyScreen} 的黑底 PNG 作为独立图层导入原文档，保持原坐标与尺寸，混合模式设为 Screen / 滤色；检查黑底残留、对位及光照贡献。生成贡献不是物理分解。`); message('滤色图层说明已复制'); }));
    el('execution').querySelectorAll('[data-inspect-job]').forEach(b => b.onclick = guard(async () => { const j = await api('GET', `/jobs/${b.dataset.inspectJob}`); const box = el('job-inspection'); box.innerHTML = `<h4>已有任务检查</h4><p>${esc(j.id)} · ${esc(j.provider)} · ${esc(j.status)} · ${esc(j.stage || '')}</p><p>${esc(j.error || '')}</p><pre>${esc(j.log?.slice(-12).join('\n') || '没有日志')}</pre>`; }));
    el('execution').querySelectorAll('[data-retry-node], [data-link-node]').forEach(b => b.onclick = guard(async () => {
      const retry = Boolean(b.dataset.retryNode), nodeId = b.dataset.retryNode || b.dataset.linkNode;
      if (e.status === 'running') throw new Error('请先暂停执行');
      let jobId;
      if (!retry) { jobId = prompt('输入属于此节点 / 此次候选提交的已有任务 ID'); if (!jobId) return; }
      if (!confirm(retry ? '已检查外部平台，确认没有可恢复结果？重试会再次生成，可能再次收费。' : '确认已检查此任务身份与外部执行状态？')) return;
      state.execution = await call('POST', `executions/${e.id}/${retry ? 'retry' : 'reconcile'}`, { nodeId, slot: Number(b.dataset.slot), verified: true, confirmNoResult: retry, jobId }); renderExecution();
    }));
    el('execution').querySelectorAll('[data-asset]').forEach(target => { const img = target.tagName === 'IMG' ? target : target.querySelector('img'); assetUrl(target.dataset.asset).then(src => { if (img.isConnected) img.src = src; }).catch(err => message(reason(err))); });
  }
  async function refreshExecution() {
    if (!state.execution || pollBusy) return; pollBusy = true;
    try { const e = await call('GET', `executions/${state.execution.id}`); if (JSON.stringify(e) !== JSON.stringify(state.execution)) { state.execution = e; renderExecution(); drawGraph(); } } finally { pollBusy = false; }
  }
  function materialsMarkup() {
    return `<h3>场景素材</h3><div class="cr-toolbar">${button('material-pick', '添加素材')}${button('material-work', '工作台原图')}${button('material-ps', '捕获 PS 当前文档')}</div><p>按顺序传入：第一张为原图，其余为参考。角色描述参与提示词，不在本地自动抠图。</p><div class="cr-materials">${state.materials.map((m, i) => `<article><img data-material-asset="${m.assetId}" alt="素材预览"><span>${esc(m.name)}</span><select data-material-role="${i}">${options([['subject', '主体'], ['foreground', '前景'], ['middle', '中景'], ['background', '背景'], ['reference', '风格参考']], m.role)}</select><button data-material-up="${i}" ${i ? '' : 'disabled'}>上移</button><button data-material-remove="${i}">删除</button></article>`).join('')}</div>`;
  }
  function renderTool() {
    const isLighting = state.page === 'lighting', isPoster = state.page === 'poster';
    el('content').innerHTML = `<div class="cr-tool-layout"><div class="cr-tool-form">
      ${field('项目名称', input('tool-title', state.title))}${materialsMarkup()}
      ${isPoster ? `<h3>自有版式模板</h3><select id="cr-template">${options(state.catalog.templates.map(t => [t.id, t.title]), state.templateId)}</select><p id="cr-template-description"></p><div class="cr-two">${field('输出宽 px', input('poster-width', state.width, 'number', 'min="1" max="8192"'))}${field('输出高 px', input('poster-height', state.height, 'number', 'min="1" max="8192"'))}</div><div id="cr-pages">${state.pages.map((p, i) => `<fieldset><legend>第 ${i + 1} 页 <button data-remove-page="${i}">删除</button></legend>${['headline', 'subtitle', 'body'].map((key, k) => field(['标题', '副标题', '正文'][k], `<textarea rows="${key === 'body' ? 4 : 2}" data-page-index="${i}" data-page-key="${key}">${esc(p[key])}</textarea>`)).join('')}</fieldset>`).join('')}</div>${button('add-page', '添加一页')}<details><summary>从文字资料填入页面</summary><p>每段一页，以空行分隔；每段第一行为标题，第二行为副标题，其余为正文。不会声称自动视觉识别。</p><textarea id="cr-page-source" rows="6" placeholder="标题\n副标题\n正文\n\n下一页标题">${esc(state.posterSource)}</textarea>${button('extract-pages', '按段落填入（替换当前页）')}</details>` : `<label class="cr-field">创作要求<textarea id="cr-tool-prompt" rows="5">${esc(state.prompt)}</textarea></label>`}
      ${isLighting || isPoster ? proposalMarkup(isPoster ? 'pages' : 'lights') : ''}${field('风格', input('tool-style', state.style))}${!isPoster ? field('光效 / 特效', input('tool-effects', state.effects)) : ''}
      <div class="cr-toolbar">${button('make-canvas', '生成规格 → 保存幕布')}${isLighting ? button('make-decomposition', '选中光源 → 拆光幕布') : ''}${button('save-tool-preset', '保存工具预设')}</div><p>使用工作台所选平台 / 模型${state.loadedOptions ? '（当前使用已载入预设参数）' : ''}。创建幕布不提交生成，需在幕布页审阅后开始。</p>${state.loadedOptions ? button('reset-tool-options', '改用当前工作台参数') : ''}
      </div><div class="cr-tool-preview">${isPoster ? '<h3>版式示意</h3><div id="cr-poster-preview"></div><p>这里是自有模板的排版示意。实际海报经模型生成；文字、人物身份和跨页一致性需检查。输出按指定像素尺寸等比留边。</p>' : rigMarkup()}<p>前中后景与参考素材由你指定。所有素材应为自有或获准使用；这里不包含第三方素材包。</p></div></div>`;
    for (const [id, key] of [['tool-title', 'title'], ['tool-prompt', 'prompt'], ['tool-style', 'style'], ['tool-effects', 'effects']]) if (el(id)) el(id).oninput = e => { state[key] = e.target.value; };
    bindMaterials();
    if (isPoster) bindPoster(); else bindRig();
    if (isLighting || isPoster) bindProposals(isPoster ? 'pages' : 'lights');
    async function compose(tool) {
      if (state.dirty && !confirm('保存新工具幕布将离开未保存的当前幕布，继续？')) return;
      const c = await call('POST', 'compose', { ...toolSettings(), tool }); loadCanvas(c); await showPage('canvas'); message(`已建立幕布，尚未提交。${c.notes?.join(' ') || ''}`);
    }
    bind('make-canvas', () => compose(state.page)); bind('make-decomposition', () => compose('decompose'));
    bind('save-tool-preset', async () => { const settings = toolSettings(); await call('POST', 'presets', { title: state.title, settings }); message('工具预设和素材已持久保存'); });
    bind('reset-tool-options', () => { state.loadedOptions = null; renderTool(); });
  }
  function proposalMarkup(kind) {
    return `<section class="cr-proposal-panel"><h3>${kind === 'lights' ? '可选：原图光源分析' : '可选：粘贴资料智能提取'}</h3><p>${kind === 'lights' ? '仅分析第一张素材。可见阴影 / 高光作为依据，灯位、强度、色温和灯具为估计。' : '使用上方“从文字资料填入页面”内的原文，提取有原文依据的页面字段。缺失信息留空。'} 分析会调用所选文字 / 视觉助手，可能消耗该渠道额度；不会提交生图。</p>${field('分析助手', `<select id="cr-analysis-backend">${options([['channel', '已配置助手 API 渠道'], ['codex', '已登录的本机 Codex']], state.analysisBackend)}</select>`)}${button('request-proposal', kind === 'lights' ? '分析原图 → 预览建议' : '提取资料 → 预览页面')}<div id="cr-proposal-preview"></div></section>`;
  }
  function proposalContext(kind) {
    return JSON.stringify(kind === 'lights' ? { assetId: state.materials[0]?.assetId || '', rig: state.rig } : { sourceText: state.posterSource, pages: state.pages });
  }
  function bindProposals(kind) {
    el('analysis-backend').onchange = e => { state.analysisBackend = e.target.value; };
    el('request-proposal').disabled = proposalBusy;
    // Do not hold the global UI guard during the model call; Pause and other local controls stay usable.
    el('request-proposal').onclick = async () => {
      if (proposalBusy) return;
      try {
        const context = proposalContext(kind), body = { kind, backend: state.analysisBackend, requestId: crypto.randomUUID() };
        if (kind === 'lights') { if (!state.materials[0]?.assetId) throw new Error('先添加要分析的原图'); body.assetId = state.materials[0].assetId; }
        else { if (!state.posterSource.trim()) throw new Error('先在上方资料输入框粘贴海报原文'); body.sourceText = state.posterSource; }
        proposalBusy = true; el('request-proposal').disabled = true; message('助手正在分析；原草稿未改变，返回后需预览并应用');
        const record = await call('POST', 'proposals', body);
        if (record.status !== 'ready') throw new Error(record.error || '分析尚未返回可用提案');
        suggestions[kind] = { record, context };
        if ((kind === 'lights' && state.page === 'lighting') || (kind === 'pages' && state.page === 'poster')) renderProposal(kind);
        message('分析提案已保存，请核对依据与不确定项后明确应用');
      } catch (e) { message(reason(e)); toast(reason(e), true); }
      finally { proposalBusy = false; if (el('request-proposal')) el('request-proposal').disabled = false; }
    };
    renderProposal(kind);
  }
  function renderProposal(kind) {
    const holder = el('proposal-preview'), suggestion = suggestions[kind]; if (!holder) return;
    if (!suggestion) { holder.innerHTML = ''; return; }
    const { record } = suggestion, p = record.proposal;
    holder.innerHTML = `<h4>待审阅提案 · ${esc(record.source?.title || record.backend)}</h4><p>${esc(p.summary)}</p>${kind === 'lights' ? p.lights.map(l => `<article><strong>${esc(l.name)} · 估计 ${Math.round(l.confidence * 100)}% 主观置信度</strong><p>位置 (${l.x}, ${l.y}, ${l.z}) · ${l.fixture} · 相对强度 ${l.intensity} · 估计 ${l.temperature}K · ${esc(l.color)}</p><p>可见依据：${esc(l.evidence)}</p></article>`).join('') || '<p>图像证据不足，没有提出灯位。</p>' : p.pages.map((page, i) => `<article><strong>建议第 ${i + 1} 页</strong><p>标题：${esc(page.headline || '未提供')}</p><p>副标题：${esc(page.subtitle || '未提供')}</p><pre>${esc(page.body)}</pre><details><summary>原文依据</summary>${page.sourceQuotes.map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}</details></article>`).join('')}<p>不确定项：${esc(p.uncertainties.join('；') || '模型未列出；仍需人工核对')}</p><label><input id="cr-proposal-approved" type="checkbox"> 已核对提案，替换当前${kind === 'lights' ? '灯位列表（保留相机）' : '页面字段'}，不提交生图</label>${button('apply-proposal', '应用到可编辑草稿')}${button('dismiss-proposal', '保留当前草稿 / 关闭提案')}`;
    el('apply-proposal').disabled = kind === 'lights' && !p.lights.length;
    bind('apply-proposal', async () => {
      if (!el('proposal-approved').checked) throw new Error('请先核对提案并勾选确认');
      if (suggestion.context !== proposalContext(kind)) throw new Error('原图、资料或草稿已改变，请重新分析以免覆盖新修改');
      const result = await call('POST', `proposals/${record.id}/apply`, { approved: true, revision: record.revision });
      // Recheck after the await: editing fields remains possible while an API request is in flight.
      if (suggestion.context !== proposalContext(kind)) throw new Error('草稿在应用时发生改变，未覆盖；请重新分析');
      if (kind === 'lights') { state.rig.lights = result.patch.lights; state.lightIndex = 0; }
      else state.pages = result.patch.pages;
      suggestions[kind] = null; renderTool(); message('已应用到可编辑草稿；尚未创建或运行生图任务');
    });
    bind('dismiss-proposal', () => { suggestions[kind] = null; renderProposal(kind); message('已保留当前草稿'); });
  }
  function bindMaterials() {
    async function add(items, captureId = null) {
      if (!state.materials.length) state.captureId = captureId;
      for (const r of items) { if (state.materials.length >= 16) throw new Error('最多 16 张素材'); const asset = await call('POST', 'assets', { uploadId: r.uploadId }); state.materials.push({ assetId: asset.assetId, name: r.name || '素材', role: state.materials.length ? 'reference' : 'subject' }); }
      renderTool();
    }
    bind('material-ps', async () => {
      if (state.materials.length) throw new Error('PS 捕获需作为第一张原图，请先移除现有素材或保存为预设');
      const docs = await api('POST', '/bridge/ps', { type: 'documents' });
      const target = docs.documents.find(d => d.docId === docs.activeId);
      if (!target) throw new Error('Photoshop 没有活动文档');
      const capture = await api('POST', '/bridge/ps', { type: 'capture-region', target, rect: { left: 0, top: 0, right: target.width, bottom: target.height }, useSelection: false, title: target.name });
      const uploaded = await api('POST', '/regions/upload', { id: capture.id });
      await add([uploaded], capture.id); message('已捕获并绑定原文档会话；输出可贴回原文档');
    });
    bind('material-pick', async () => add(await window.bridge.pickImages('original', true)));
    bind('material-work', async () => { if (!work.input) throw new Error('工作台尚无原图'); await add([work.input]); });
    el('content').querySelectorAll('[data-material-role]').forEach(s => s.onchange = () => { state.materials[Number(s.dataset.materialRole)].role = s.value; });
    el('content').querySelectorAll('[data-material-remove]').forEach(b => b.onclick = () => { if (Number(b.dataset.materialRemove) === 0) state.captureId = null; state.materials.splice(Number(b.dataset.materialRemove), 1); renderTool(); });
    el('content').querySelectorAll('[data-material-up]').forEach(b => b.onclick = () => { const i = Number(b.dataset.materialUp); if (i === 1) state.captureId = null; if (i > 0) [state.materials[i - 1], state.materials[i]] = [state.materials[i], state.materials[i - 1]]; renderTool(); });
    el('content').querySelectorAll('[data-material-asset]').forEach(img => assetUrl(img.dataset.materialAsset).then(src => { if (img.isConnected) img.src = src; }).catch(e => message(reason(e))));
  }
  function bindPoster() {
    el('page-source').oninput = e => { state.posterSource = e.target.value; };
    const show = () => {
      const template = state.catalog.templates.find(t => t.id === state.templateId), page = state.pages[0] || {};
      el('template-description').textContent = template.layout;
      el('poster-preview').className = `cr-poster ${state.templateId}`;
      el('poster-preview').style.aspectRatio = `${state.width} / ${state.height}`;
      el('poster-preview').innerHTML = `<h3>${esc(page.headline || '标题')}</h3><div class="cr-poster-image">主图 / 画廊素材</div><strong>${esc(page.subtitle || '副标题')}</strong><p>${esc(page.body || '活动资料与正文')}</p><small>01 / ${state.pages.length}</small>`;
    };
    el('template').onchange = e => { state.templateId = e.target.value; const t = state.catalog.templates.find(t => t.id === state.templateId); state.width = t.width; state.height = t.height; el('poster-width').value = t.width; el('poster-height').value = t.height; show(); };
    for (const dimension of ['width', 'height']) el(`poster-${dimension}`).onchange = e => { state[dimension] = Number(e.target.value); show(); };
    el('pages').querySelectorAll('[data-page-index]').forEach(t => t.oninput = () => { state.pages[Number(t.dataset.pageIndex)][t.dataset.pageKey] = t.value; show(); });
    el('pages').querySelectorAll('[data-remove-page]').forEach(b => b.onclick = () => { if (state.pages.length <= 1) { message('至少保留一页'); return; } state.pages.splice(Number(b.dataset.removePage), 1); renderTool(); });
    bind('add-page', () => { if (state.pages.length >= 20) throw new Error('最多 20 页'); state.pages.push({ headline: '', subtitle: '', body: '' }); renderTool(); });
    bind('extract-pages', () => { const paragraphs = el('page-source').value.trim().split(/\n\s*\n/); if (!paragraphs[0] || paragraphs.length > 20) throw new Error('请输入 1–20 段资料'); state.pages = paragraphs.map(p => { const [headline, subtitle = '', ...rest] = p.split('\n'); return { headline, subtitle, body: rest.join('\n') }; }); renderTool(); });
    show();
  }
  function rigMarkup() {
    const c = state.rig.camera;
    return `<h3>相机与灯位预览</h3><div class="cr-toolbar">${button('mode-2d', '2D 顶视')}${button('mode-3d', '3D 透视')}</div><canvas id="cr-light-preview" width="600" height="430" aria-label="相机与灯光几何预览"></canvas><p>2D 顶视图可拖动灯位；Y 高度由输入框调整。3D 为球体漫反射近似，使用位置、光强、色温和相机投影；不是照片重打光或物理精确渲染。</p>
      <div class="cr-rig-fields">${[['azimuth', '方位角', -180, 180, 1], ['elevation', '仰角', -80, 80, 1], ['distance', '距离', 2, 20, .1], ['focal', '焦距 mm', 18, 150, 1]].map(([key, label, min, max, step]) => field(label, `<input data-camera="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${c[key]}">`)).join('')}${field('环境光', input('ambient', state.rig.ambient, 'number', 'min="0" max="1" step=".02"'))}</div>
      <div class="cr-toolbar">${button('add-light', '添加灯具')}<select id="cr-light-select" aria-label="灯具">${options(state.rig.lights.map((l, i) => [String(i), l.name]), String(state.lightIndex))}</select>${button('remove-light', '删除灯具')}</div><div id="cr-light-fields"></div><p>拆光只对勾选的光源创建黑底贡献任务。光源可手动定义，或审阅可选视觉分析提案后应用。位置、色温与灯具均为估计。</p>`;
  }
  function bindRig() {
    const update = () => { drawLights(); };
    el('content').querySelectorAll('[data-camera]').forEach(c => c.oninput = () => { if (!c.validity.valid) return; state.rig.camera[c.dataset.camera] = Number(c.value); update(); });
    el('ambient').oninput = e => { if (e.target.validity.valid) { state.rig.ambient = Number(e.target.value); update(); } };
    bind('mode-2d', () => { state.previewMode = '2d'; update(); }); bind('mode-3d', () => { state.previewMode = '3d'; update(); });
    bind('add-light', () => { if (state.rig.lights.length >= 8) throw new Error('最多 8 盏灯'); state.rig.lights.push({ id: `light-${crypto.randomUUID()}`, name: `灯 ${state.rig.lights.length + 1}`, x: 2, y: 2, z: 2, intensity: 1, temperature: 5600, color: '#ffffff', fixture: 'softbox', enabled: true }); state.lightIndex = state.rig.lights.length - 1; renderTool(); });
    bind('remove-light', () => { state.rig.lights.splice(state.lightIndex, 1); state.lightIndex = Math.max(0, state.lightIndex - 1); renderTool(); });
    el('light-select').onchange = e => { state.lightIndex = Number(e.target.value); renderLightFields(); update(); };
    renderLightFields(); update();
    const canvas = el('light-preview'); let lightDrag = false;
    const point = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * 600 / r.width, y: (e.clientY - r.top) * 430 / r.height }; };
    canvas.onpointerdown = e => {
      if (state.previewMode !== '2d') return; const p = point(e);
      const index = state.rig.lights.findIndex(l => Math.hypot(300 + l.x * 18 - p.x, 215 - l.z * 18 - p.y) < 18);
      if (index < 0) return; state.lightIndex = index; el('light-select').value = String(index); lightDrag = true; canvas.setPointerCapture(e.pointerId); renderLightFields();
    };
    canvas.onpointermove = e => { if (!lightDrag) return; const p = point(e), l = state.rig.lights[state.lightIndex]; l.x = Math.round(Math.max(-10, Math.min(10, (p.x - 300) / 18)) * 10) / 10; l.z = Math.round(Math.max(-10, Math.min(10, (215 - p.y) / 18)) * 10) / 10; renderLightFields(); update(); };
    canvas.onpointerup = canvas.onpointercancel = () => { lightDrag = false; };
  }
  function renderLightFields() {
    const l = state.rig.lights[state.lightIndex]; if (!l) { el('light-fields').innerHTML = '<p>未设置灯具</p>'; return; }
    el('light-fields').innerHTML = `<label><input id="cr-light-enabled" type="checkbox" ${l.enabled ? 'checked' : ''}> 启用 / 选中拆光</label>${field('名称', input('light-name', l.name))}${field('灯具', `<select id="cr-light-fixture">${options(['softbox', 'point', 'spot', 'sun'], l.fixture)}</select>`)}<div class="cr-rig-fields">${[['x', 'X', -10, 10, .1], ['y', 'Y 高度', -10, 10, .1], ['z', 'Z', -10, 10, .1], ['intensity', '强度', 0, 10, .1], ['temperature', '色温 K', 1000, 12000, 100]].map(([key, label, min, max, step]) => field(label, `<input data-light-value="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${l[key]}">`)).join('')}${field('颜色', input('light-color', l.color, 'color'))}</div>`;
    el('light-fields').querySelectorAll('[data-light-value]').forEach(c => c.oninput = () => { if (!c.validity.valid) return; l[c.dataset.lightValue] = Number(c.value); drawLights(); });
    for (const key of ['name', 'fixture', 'color']) el(`light-${key}`).oninput = e => { l[key] = e.target.value; if (key === 'name') el('light-select').options[state.lightIndex].textContent = l.name; drawLights(); };
    el('light-enabled').onchange = e => { l.enabled = e.target.checked; drawLights(); };
  }
  function drawLights() {
    const canvas = el('light-preview'); if (!canvas) return;
    const ctx = canvas.getContext('2d'), { camera, lights, ambient } = state.rig;
    ctx.fillStyle = '#101723'; ctx.fillRect(0, 0, 600, 430); ctx.font = '12px sans-serif';
    const rad = v => v * Math.PI / 180, a = rad(camera.azimuth), e = rad(camera.elevation);
    const eye = [camera.distance * Math.sin(a) * Math.cos(e), camera.distance * Math.sin(e), camera.distance * Math.cos(a) * Math.cos(e)];
    const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0), norm = v => { const d = Math.hypot(...v) || 1; return v.map(x => x / d); }, sub = (a, b) => a.map((x, i) => x - b[i]);
    const forward = norm(eye.map(x => -x)), right = [Math.cos(a), 0, -Math.sin(a)], up = [-Math.sin(a) * Math.sin(e), Math.cos(e), -Math.cos(a) * Math.sin(e)];
    const focal = camera.focal * 600 / 36;
    const project = p => { if (state.previewMode === '2d') return [300 + p[0] * 18, 215 - p[2] * 18]; const q = sub(p, eye), depth = dot(q, forward); if (depth < .1) return null; return [300 + focal * dot(q, right) / depth, 215 - focal * dot(q, up) / depth]; };
    const line = (a, b, color) => { if (!a || !b) return; ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); };
    for (let i = -10; i <= 10; i++) { line(project([i, -1, -10]), project([i, -1, 10]), '#263347'); line(project([-10, -1, i]), project([10, -1, i]), '#263347'); }
    const tempRGB = kelvin => { const t = kelvin / 100; const clamp = v => Math.max(0, Math.min(255, v)) / 255; return [clamp(t <= 66 ? 255 : 329.698727446 * (t - 60) ** -.1332047592), clamp(t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -.0755148492), clamp(t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307)]; };
    const lightData = lights.filter(l => l.enabled).map(l => ({ ...l, rgb: tempRGB(l.temperature).map((v, i) => v * parseInt(l.color.slice(1 + i * 2, 3 + i * 2), 16) / 255) }));
    if (state.previewMode === '3d') {
      // Ray / sphere intersection, directional Lambert diffuse and inverse-square point falloff.
      // No normals are inferred from uploaded photographs. Softbox and spot are illustrative only.
      const scale = 2, sw = 300, sh = 215, pixels = ctx.createImageData(sw, sh);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const dx = (x * scale - 300) / focal, dy = (215 - y * scale) / focal;
        const ray = norm(forward.map((v, i) => v + dx * right[i] + dy * up[i]));
        const b = dot(eye, ray), discriminant = b * b - dot(eye, eye) + 1;
        if (discriminant <= 0) continue;
        const t = -b - Math.sqrt(discriminant); if (t <= 0) continue;
        const p = eye.map((v, i) => v + t * ray[i]), normal = norm(p), rgb = [ambient, ambient, ambient];
        for (const l of lightData) {
          const delta = sub([l.x, l.y, l.z], p), distance = Math.hypot(...delta), direction = norm(delta);
          let attenuation = l.fixture === 'sun' ? 1 : 8 / Math.max(1, distance * distance);
          if (l.fixture === 'spot') attenuation *= Math.max(0, dot(norm([-l.x, -l.y, -l.z]), norm(p.map((v, i) => v - [l.x, l.y, l.z][i])))) ** 12;
          const diffuse = l.fixture === 'softbox' ? Math.max(0, (dot(normal, direction) + .15) / 1.15) : Math.max(0, dot(normal, direction));
          rgb.forEach((_, i) => { rgb[i] += l.rgb[i] * l.intensity * diffuse * attenuation; });
        }
        const index = (y * sw + x) * 4; rgb.forEach((v, i) => { pixels.data[index + i] = Math.round(255 * (1 - Math.exp(-v * .7)) ** (1 / 2.2)); }); pixels.data[index + 3] = 255;
      }
      const off = document.createElement('canvas'); off.width = sw; off.height = sh; off.getContext('2d').putImageData(pixels, 0, 0); ctx.drawImage(off, 0, 0, 600, 430);
    } else {
      ctx.fillStyle = '#8592a6'; ctx.beginPath(); ctx.arc(300, 215, 18, 0, 2 * Math.PI); ctx.fill();
      const cp = project(eye); line(cp, [300, 215], '#7dabff'); ctx.fillStyle = '#7dabff'; ctx.fillRect(cp[0] - 7, cp[1] - 5, 14, 10); ctx.fillText('相机', cp[0] + 10, cp[1]);
    }
    lights.forEach((l, index) => { const p = project([l.x, l.y, l.z]); if (!p) return; line(p, project([0, 0, 0]), l.enabled ? '#8c774a' : '#444'); ctx.fillStyle = l.enabled ? l.color : '#555'; ctx.beginPath(); ctx.arc(p[0], p[1], index === state.lightIndex ? 9 : 6, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#eef3fa'; ctx.fillText(`${l.name} · ${l.intensity} · ${l.temperature}K`, p[0] + 12, p[1]); });
    ctx.fillStyle = '#a7b8ce'; ctx.fillText(`${state.previewMode === '2d' ? '顶视：X / Z，单位为示意场景单位' : '透视球体 · 近似漫反射'} · 不代表模型实际输出`, 14, 410);
  }
  async function renderPresets() {
    const { presets } = await call('GET', 'presets');
    el('content').innerHTML = `<h3>已保存工具预设</h3><p>包含素材快照、灯位、页面规格与生成参数；载入后可编辑并创建新幕布。</p><div class="cr-presets">${presets.map(p => `<article><h4>${esc(p.title)}</h4><p>${esc(p.settings.tool)} · ${p.settings.materials?.length || 0} 张素材</p><button data-load-preset="${p.id}">载入</button><button data-delete-preset="${p.id}">删除预设</button></article>`).join('') || '<p>尚无工具预设。在工具页面点击保存。</p>'}</div>`;
    el('content').querySelectorAll('[data-load-preset]').forEach(b => b.onclick = guard(async () => { const p = await call('GET', `presets/${b.dataset.loadPreset}`), s = p.settings; for (const key of ['title', 'captureId', 'prompt', 'style', 'effects', 'rig', 'materials', 'templateId', 'width', 'height', 'pages']) if (s[key] !== undefined) state[key] = structuredClone(s[key]); state.loadedOptions = s.options; state.lightIndex = 0; await showPage(s.tool === 'decompose' ? 'lighting' : s.tool); message('预设已载入，尚未提交生成'); }));
    el('content').querySelectorAll('[data-delete-preset]').forEach(b => b.onclick = guard(async () => { if (!confirm('删除此工具预设？已有幕布和输出会保留。')) return; await call('POST', `presets/${b.dataset.deletePreset}/delete`); await renderPresets(); }));
  }
  document.addEventListener('workspace-tab', e => { if (e.detail === 'creative') guard(() => showPage(state.page))(); });
  setInterval(() => { if (!pane.hidden && !pending) refreshExecution().catch(e => message(reason(e))); }, 2200);
  // workspace may have restored a tab name before this dynamically registered pane existed.
  try { if (localStorage.getItem('ps-ai-bridge-tab') === 'creative') showTab('creative'); } catch { /* optional tab preference */ }
})();
