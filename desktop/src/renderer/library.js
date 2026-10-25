// Load after common.js/workspace.js. All UI is created here; no index/main edits.
(() => {
  if ($('tab-library')) return;
  const tab = document.createElement('button');
  tab.className = 'tab-btn'; tab.dataset.tab = 'library'; tab.setAttribute('role', 'tab'); tab.textContent = '图库与剪影';
  tab.onclick = () => showTab('library');
  document.querySelector('.tab-btn').parentElement.append(tab);
  const pane = document.createElement('section'); pane.id = 'tab-library'; pane.className = 'tab library-page'; pane.hidden = true;
  pane.innerHTML = `
    <div class="library-toolbar"><h2>参考图库</h2><button id="libRefresh">重新载入</button><span id="libStatus" role="status"></span></div>
    <p class="mute">参考图保存在本机图库，清理临时上传后仍可使用。拖动卡片调整顺序；勾选后用于生成或保存到预设。</p>
    <div class="row"><button id="libPick">上传图片</button><button id="libClipboard">粘贴图片</button><button id="libScreenshot">截屏</button><button id="libPS">捕获 PS 选区 / 文档</button><button id="libWorkspace">收藏工作台参考图</button></div>
    <div id="libDrop" class="library-drop" tabindex="0" aria-label="拖入参考图片"><div id="libRefs" class="library-refs"></div><p class="mute">可把图片文件拖到这里</p></div>
    <div class="row"><button id="libUse">使用已选参考图</button><button id="libDelete">从图库移除已选</button><select id="libPreset" aria-label="保存参考图的目标预设"></select><button id="libAttach">将已选图保存到预设</button></div>
    <details><summary>参考图名称与来源</summary><p class="mute">点击卡片名称编辑来源。来源为本地描述，不会访问填写的网址。</p><div class="library-source">
      <label>名称<input id="libRefName" maxlength="200"></label><label>来源<select id="libSourceKind"><option value="file">文件</option><option value="clipboard">剪贴板</option><option value="screenshot">截屏</option><option value="photoshop">Photoshop</option><option value="preset">预设</option><option value="workspace">工作台</option></select></label>
      <label>来源链接<input id="libSourceURL" type="url" maxlength="2000"></label><label>备注<input id="libSourceNote" maxlength="1000"></label><button id="libSourceSave">保存来源</button>
    </div></details>
    <hr><div class="library-toolbar"><h2>分类剪影</h2><label><input type="checkbox" id="libEditBoard">编辑位置</label><button id="libBoardSave">保存布局</button><button id="libBoardImage">上传分类图</button><button id="libBoardReset">使用默认剪影</button></div>
    <p class="mute">浏览时点击区域筛选分类；将已勾选的个人预设拖到区域即可分组。编辑时拖动区域、拖右下角缩放，可设置层级与隐藏。</p>
    <div class="library-layout"><div>
      <div id="libBoard" class="library-board" aria-label="分类剪影画布"></div>
      <div class="library-hotspot-controls"><select id="libHotspot" aria-label="编辑区域"></select><select id="libHotCategory" aria-label="区域分类"></select><button id="libHotAdd">添加区域</button><button id="libHotRemove">删除区域</button>
        <label>X %<input id="libX" type="number" min="0" max="98" step="0.1"></label><label>Y %<input id="libY" type="number" min="0" max="98" step="0.1"></label><label>宽 %<input id="libW" type="number" min="2" max="100" step="0.1"></label><label>高 %<input id="libH" type="number" min="2" max="100" step="0.1"></label><label>层级<input id="libZ" type="number" min="0" max="1000"></label><label><input id="libVisible" type="checkbox">显示区域</label><button id="libHotApply">更新区域</button>
      </div>
    </div><aside class="library-grouping"><div class="row"><input id="libSearch" type="search" placeholder="搜索名称或拼音"><select id="libFilter" aria-label="筛选分类"></select></div><div class="row"><button id="libGroup">移动已选到当前分类</button><button id="libOpenCategory">在预设管理中打开</button></div><p id="libSelection" class="mute"></p><div id="libPresets"></div></aside></div>`;
  document.body.append(pane);

  let state = null, board = null, categories = [], presets = [], dirty = false, busy = false, activeHotspot = null, editingReference = null;
  const checked = new Set(), marked = new Set();
  const guard = fn => async (...args) => {
    if (busy) return toast('正在保存，请稍候');
    busy = true; $('libStatus').textContent = '处理中…';
    try { await fn(...args); $('libStatus').textContent = dirty ? '布局有未保存修改' : '已加载 / 已保存'; }
    catch (e) { $('libStatus').textContent = reason(e); toast(reason(e), true); }
    finally { busy = false; }
  };
  const options = () => categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  const categoryName = id => categories.find(c => c.id === id)?.name || id;
  const chosenIds = () => state.references.filter(r => checked.has(r.id)).map(r => r.id);
  function checkReferenceLimit(count) {
    const caps = work.health?.providers?.[$('provider').value] || {};
    const max = caps.maxReferences ?? caps.maxRefs ?? caps.maxReferenceImages ?? caps.maxRefImages ?? caps.referenceLimit;
    if (Number.isInteger(max) && count > max) throw new Error(`当前平台最多支持 ${max} 张参考图`);
  }
  // Existing preset selection calls addRefs. Retain its append semantics, but
  // never silently discard durable references at the old four-item UI limit.
  addRefs = async list => {
    checkReferenceLimit(work.refs.length + list.length);
    work.refs.push(...list); renderRefs();
  };
  function needState() { if (!state) throw new Error('图库尚未加载，请点重新载入'); }
  function draft() { dirty = true; $('libStatus').textContent = '布局有未保存修改'; $('libRefresh').textContent = '重新载入（放弃布局草稿）'; }
  async function refresh() {
    const [s, c, p] = await Promise.all([api('GET', '/library'), api('GET', '/library/categories'), api('GET', '/presets')]);
    state = s; categories = c.categories; presets = p.presets;
    board = structuredClone(state.board); dirty = false;
    for (const id of checked) if (!state.references.some(r => r.id === id)) checked.delete(id);
    for (const id of marked) if (!presets.some(p => p.id === id)) marked.delete(id);
    const selectedPreset = $('libPreset').value, filter = $('libFilter').value;
    $('libPreset').innerHTML = '<option value="">选择目标预设</option>' + presets.map(p => `<option value="${esc(p.id)}">${esc(p.title)}${p.factory ? '（创建个人副本）' : ''}</option>`).join('');
    $('libPreset').value = selectedPreset;
    $('libFilter').innerHTML = '<option value="">全部分类</option>' + options(); $('libFilter').value = filter;
    $('libHotCategory').innerHTML = options();
    $('libRefresh').textContent = '重新载入';
    drawRefs(); drawPresets(); drawBoard();
  }
  async function mutate(op, body) {
    needState();
    const result = await api('POST', `/library/${op}`, { ...body, expectedRevision: state.revision });
    state = result; drawRefs(); return result;
  }
  async function addUploads(uploads, kind, extra = {}) {
    needState();
    for (const r of uploads) if (r?.uploadId) await mutate('add', { uploadId: r.uploadId, name: r.name || extra.documentName || '参考图', source: { ...r.source, ...extra, kind, name: r.name || '' } });
  }
  function drawRefs() {
    $('libRefs').innerHTML = state.references.map(r => `<article class="library-ref" draggable="true" data-ref-card="${esc(r.id)}"><label><input type="checkbox" data-ref-check="${esc(r.id)}" ${checked.has(r.id) ? 'checked' : ''}>选择</label><img src="${url(r.imageUrl)}" alt="${esc(r.name)}" draggable="false"><button class="link" data-ref-edit="${esc(r.id)}">${esc(r.name)}</button><small>${esc(r.source.kind)} · ${r.width}×${r.height}</small><div class="row"><button data-ref-up="${esc(r.id)}" aria-label="前移">←</button><button data-ref-down="${esc(r.id)}" aria-label="后移">→</button></div></article>`).join('') || '<p class="mute">图库还没有图片</p>';
  }
  async function reorder(id, target, after = false) {
    const ids = state.references.map(r => r.id), old = ids.indexOf(id);
    if (old < 0 || !ids.includes(target) || id === target) return;
    ids.splice(old, 1); ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, id);
    await mutate('reorder', { ids });
  }
  $('libRefresh').onclick = guard(refresh);
  $('libPick').onclick = guard(async () => { needState(); await addUploads(await window.bridge.pickImages(8192, true), 'file'); });
  $('libClipboard').onclick = guard(async () => { needState(); await addUploads([await window.bridge.uploadClipboard()], 'clipboard'); });
  $('libScreenshot').onclick = guard(async () => { needState(); await addUploads([await api('POST', '/screenshot')], 'screenshot'); });
  $('libWorkspace').onclick = guard(() => { if (!work.refs.length) throw new Error('工作台没有参考图'); return addUploads(work.refs, 'workspace'); });
  $('libPS').onclick = guard(async () => {
    needState();
    const docs = await api('POST', '/bridge/ps', { type: 'documents' });
    const target = docs.documents?.find(d => d.docId === docs.activeId);
    if (!target) throw new Error('Photoshop 没有打开的当前文档');
    const capture = await api('POST', '/bridge/ps', { type: 'capture-region', target });
    const upload = await api('POST', '/regions/upload', { id: capture.id });
    await addUploads([upload], 'photoshop', { documentName: target.name, docId: target.docId, session: target.session });
  });
  $('libDrop').ondragover = e => e.preventDefault();
  $('libDrop').ondrop = guard(async e => {
    e.preventDefault(); needState();
    if (!e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map(f => window.bridge.pathForFile(f)).filter(Boolean);
    await addUploads(await window.bridge.uploadFiles(paths, 8192), 'file');
  });
  $('libRefs').ondragstart = e => {
    const card = e.target.closest('[data-ref-card]'); if (!card) return;
    e.dataTransfer.setData('application/x-psai-reference', card.dataset.refCard); e.dataTransfer.effectAllowed = 'move';
  };
  $('libRefs').ondragover = e => e.preventDefault();
  $('libRefs').ondrop = e => {
    const id = e.dataTransfer.getData('application/x-psai-reference'), target = e.target.closest('[data-ref-card]')?.dataset.refCard;
    if (!id || !target) return;
    e.preventDefault(); e.stopPropagation(); guard(() => reorder(id, target))();
  };
  $('libRefs').onchange = e => { const id = e.target.dataset.refCheck; if (id) e.target.checked ? checked.add(id) : checked.delete(id); };
  $('libRefs').onclick = guard(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.refEdit) {
      editingReference = b.dataset.refEdit; const r = state.references.find(r => r.id === editingReference);
      $('libRefName').value = r.name; $('libSourceKind').value = r.source.kind; $('libSourceURL').value = r.source.url || ''; $('libSourceNote').value = r.source.note || '';
      $('libSourceSave').closest('details').open = true; return;
    }
    const id = b.dataset.refUp || b.dataset.refDown;
    if (id) { const i = state.references.findIndex(r => r.id === id), next = i + (b.dataset.refUp ? -1 : 1); if (next >= 0 && next < state.references.length) await reorder(id, state.references[next].id, Boolean(b.dataset.refDown)); }
  });
  $('libSourceSave').onclick = guard(async () => {
    const r = state?.references.find(r => r.id === editingReference); if (!r) throw new Error('先点击卡片名称选择参考图');
    const source = { ...r.source, kind: $('libSourceKind').value, note: $('libSourceNote').value };
    delete source.url; if ($('libSourceURL').value) source.url = $('libSourceURL').value;
    await mutate('update', { id: r.id, name: $('libRefName').value, source });
  });
  $('libDelete').onclick = guard(async () => { await mutate('delete', { ids: chosenIds() }); checked.clear(); });
  $('libUse').onclick = guard(async () => {
    needState(); const ids = chosenIds(); if (!ids.length) throw new Error('先选择参考图');
    // No invented provider limit: reject a known overflow and leave the actual
    // submission's provider validation authoritative when capabilities omit it.
    checkReferenceLimit(ids.length);
    const r = await api('POST', '/library/uploads', { ids, expectedRevision: state.revision });
    work.refs = r.uploads; renderRefs(); showTab('work'); toast(`已使用 ${r.uploads.length} 张参考图`);
  });
  $('libAttach').onclick = guard(async () => {
    needState(); const p = presets.find(p => p.id === $('libPreset').value); if (!p) throw new Error('先选择目标预设');
    const r = await api('POST', '/library/attach-preset', { ids: chosenIds(), presetId: p.id, expectedRevision: state.revision, expectedPresetRevision: p.revision });
    const data = await api('GET', '/presets'); presets = data.presets;
    $('libPreset').innerHTML = '<option value="">选择目标预设</option>' + presets.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join(''); $('libPreset').value = r.preset.id;
    document.dispatchEvent(new CustomEvent('library-presets-changed')); await loadPresets(); toast('已按图库顺序保存到预设');
  });

  const silhouette = '<svg class="library-silhouette" viewBox="0 0 400 600" aria-label="默认人体剪影"><circle cx="200" cy="73" r="39"/><path d="M174 108 L226 108 L237 133 Q272 137 283 171 L315 293 Q316 312 301 314 Q286 314 282 295 L253 207 L249 307 L263 522 Q264 542 246 543 L222 543 L211 345 L189 345 L178 543 L154 543 Q136 542 137 522 L151 307 L147 207 L118 295 Q114 314 99 314 Q84 312 85 293 L117 171 Q128 137 163 133 Z"/></svg>';
  function drawBoard() {
    if (!board) return;
    const edit = $('libEditBoard').checked;
    $('libBoard').classList.toggle('editing', edit);
    $('libBoard').innerHTML = (board.imageId ? `<img class="library-board-image" src="${url(`/library/images/${board.imageId}`)}" alt="自定义分类图" draggable="false">` : silhouette) + board.hotspots.filter(h => edit || h.visible).map(h => `<button class="library-hotspot ${h.id === activeHotspot ? 'selected' : ''} ${h.visible ? '' : 'hidden-hotspot'}" data-hotspot="${esc(h.id)}" title="${esc(categoryName(h.category))}">${esc(categoryName(h.category))}${edit ? '<span class="library-resize" data-resize="true"></span>' : ''}</button>`).join('');
    // CSSOM property assignment works under the app's style-src 'self' policy;
    // inline style attributes in generated HTML would be blocked.
    for (const el of $('libBoard').querySelectorAll('[data-hotspot]')) {
      const h = board.hotspots.find(h => h.id === el.dataset.hotspot);
      Object.assign(el.style, { left: `${h.x * 100}%`, top: `${h.y * 100}%`, width: `${h.width * 100}%`, height: `${h.height * 100}%`, zIndex: String(h.z) });
    }
    $('libHotspot').innerHTML = '<option value="">选择区域</option>' + board.hotspots.map(h => `<option value="${esc(h.id)}">${esc(categoryName(h.category))}${h.visible ? '' : '（隐藏）'}</option>`).join('');
    $('libHotspot').value = activeHotspot || ''; fillHotspot();
  }
  function fillHotspot() {
    const h = board?.hotspots.find(h => h.id === activeHotspot); if (!h) return;
    $('libHotCategory').value = h.category;
    for (const [id, key] of [['libX', 'x'], ['libY', 'y'], ['libW', 'width'], ['libH', 'height']]) $(id).value = Number((h[key] * 100).toFixed(2));
    $('libZ').value = h.z; $('libVisible').checked = h.visible;
  }
  $('libEditBoard').onchange = drawBoard;
  $('libHotspot').onchange = () => { activeHotspot = $('libHotspot').value; drawBoard(); };
  $('libHotAdd').onclick = guard(() => {
    needState(); if (board.hotspots.length >= 200) throw new Error('最多支持 200 个区域');
    const h = { id: crypto.randomUUID(), category: $('libHotCategory').value || 'other', x: .35, y: .35, width: .3, height: .12, z: 1, visible: true };
    board.hotspots.push(h); activeHotspot = h.id; $('libEditBoard').checked = true; draft(); drawBoard();
  });
  $('libHotRemove').onclick = guard(() => { needState(); if (!activeHotspot) throw new Error('先选择区域'); board.hotspots = board.hotspots.filter(h => h.id !== activeHotspot); activeHotspot = null; draft(); drawBoard(); });
  $('libHotApply').onclick = guard(() => {
    const h = board?.hotspots.find(h => h.id === activeHotspot); if (!h) throw new Error('先选择区域');
    const next = { ...h, category: $('libHotCategory').value, x: Number($('libX').value) / 100, y: Number($('libY').value) / 100, width: Number($('libW').value) / 100, height: Number($('libH').value) / 100, z: Number($('libZ').value), visible: $('libVisible').checked };
    if (![next.x, next.y, next.width, next.height].every(Number.isFinite) || next.x < 0 || next.y < 0 || next.width < .02 || next.height < .02 || next.x + next.width > 1 || next.y + next.height > 1 || !Number.isInteger(next.z) || next.z < 0 || next.z > 1000) throw new Error('区域必须在画布内，尺寸至少 2%，层级为 0–1000 整数');
    Object.assign(h, next); draft(); drawBoard();
  });
  $('libBoardSave').onclick = guard(async () => { await mutate('board', { board }); board = structuredClone(state.board); dirty = false; $('libRefresh').textContent = '重新载入'; drawBoard(); });
  $('libBoardReset').onclick = guard(() => { needState(); board.imageId = null; draft(); drawBoard(); });
  $('libBoardImage').onclick = guard(async () => {
    needState(); const [r] = await window.bridge.pickImages(8192, false); if (!r) return;
    await addUploads([r], 'file'); board.imageId = state.references.at(-1).imageId; draft(); drawBoard();
  });
  let drag = null;
  $('libBoard').onpointerdown = e => {
    if (!$('libEditBoard').checked || busy || e.button !== 0) return;
    const el = e.target.closest('[data-hotspot]'); if (!el) return;
    e.preventDefault(); activeHotspot = el.dataset.hotspot;
    const h = board.hotspots.find(h => h.id === activeHotspot);
    drag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, initial: { ...h }, h, el, resize: Boolean(e.target.dataset.resize), bounds: $('libBoard').getBoundingClientRect() };
    $('libBoard').setPointerCapture(e.pointerId); fillHotspot();
  };
  $('libBoard').onpointermove = e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag, dx = (e.clientX - d.x) / d.bounds.width, dy = (e.clientY - d.y) / d.bounds.height;
    if (d.resize) { d.h.width = Math.max(.02, Math.min(1 - d.h.x, d.initial.width + dx)); d.h.height = Math.max(.02, Math.min(1 - d.h.y, d.initial.height + dy)); }
    else { d.h.x = Math.max(0, Math.min(1 - d.h.width, d.initial.x + dx)); d.h.y = Math.max(0, Math.min(1 - d.h.height, d.initial.y + dy)); }
    Object.assign(d.el.style, { left: `${d.h.x * 100}%`, top: `${d.h.y * 100}%`, width: `${d.h.width * 100}%`, height: `${d.h.height * 100}%` }); draft(); fillHotspot();
  };
  const finishDrag = () => { if (drag) { drag = null; drawBoard(); } };
  $('libBoard').onpointerup = finishDrag; $('libBoard').onpointercancel = finishDrag;
  $('libBoard').onclick = e => {
    const h = board?.hotspots.find(h => h.id === e.target.closest('[data-hotspot]')?.dataset.hotspot);
    if (h && !$('libEditBoard').checked) { $('libFilter').value = h.category; drawPresets(); }
  };
  $('libBoard').ondragover = e => { if (!$('libEditBoard').checked) e.preventDefault(); };
  $('libBoard').ondrop = e => {
    e.preventDefault(); const h = board?.hotspots.find(h => h.id === e.target.closest('[data-hotspot]')?.dataset.hotspot);
    if (!h || $('libEditBoard').checked) return;
    const ids = e.dataTransfer.getData('application/x-psai-presets'); if (!ids) return;
    guard(async () => { const records = JSON.parse(ids); if (!Array.isArray(records)) throw new Error('拖放数据无效'); await group(records, h.category); })();
  };
  function drawPresets() {
    const q = $('libSearch').value.trim().toLowerCase(), cat = $('libFilter').value;
    $('libSelection').textContent = `${marked.size} 个个人预设已选${cat ? ` · ${categoryName(cat)}` : ''}`;
    $('libPresets').innerHTML = presets.filter(p => (!cat || p.category === cat) && (!q || p.keys.includes(q))).map(p => `<div class="library-preset" draggable="${!p.factory}" data-preset="${esc(p.id)}"><label><input type="checkbox" data-preset-check="${esc(p.id)}" ${p.factory ? 'disabled' : ''} ${marked.has(p.id) ? 'checked' : ''}>${esc(p.title)}</label><small>${esc(categoryName(p.category))} · ${p.factory ? '出厂：请先复制' : `个人 v${p.revision}`}</small></div>`).join('');
  }
  async function group(ids, category) {
    const selected = presets.filter(p => ids.includes(p.id));
    await api('POST', '/library/move-presets', { ids, category, expectedRevisions: Object.fromEntries(selected.map(p => [p.id, p.revision])) });
    presets = (await api('GET', '/presets')).presets; marked.clear(); drawPresets(); await loadPresets(); document.dispatchEvent(new CustomEvent('library-presets-changed')); toast('分类已保存');
  }
  $('libPresets').onchange = e => { const id = e.target.dataset.presetCheck; if (id) { e.target.checked ? marked.add(id) : marked.delete(id); $('libSelection').textContent = `${marked.size} 个个人预设已选`; } };
  $('libPresets').ondragstart = e => {
    const id = e.target.closest('[data-preset]')?.dataset.preset, p = presets.find(p => p.id === id); if (!p || p.factory) return e.preventDefault();
    e.dataTransfer.setData('application/x-psai-presets', JSON.stringify(marked.has(id) ? [...marked] : [id])); e.dataTransfer.effectAllowed = 'move';
  };
  $('libSearch').oninput = drawPresets; $('libFilter').onchange = drawPresets;
  $('libGroup').onclick = guard(() => { if (!$('libFilter').value) throw new Error('先选择目标分类'); return group([...marked], $('libFilter').value); });
  $('libOpenCategory').onclick = () => { showTab('presets'); document.dispatchEvent(new CustomEvent('library-category-selected', { detail: $('libFilter').value })); };
  document.addEventListener('workspace-tab', e => { if (e.detail === 'library' && !dirty) guard(refresh)(); });
})();
