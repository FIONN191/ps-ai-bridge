// Management uses the same preset API as the PS panel; no second copy of the library.
(() => {
  let list = [], categories = [], selected = null, refs = [], referenceSources = [], importPack = null, categoryRevision = 0, fieldHistory = null, fieldValues = { params: {}, fills: {} };
  const marked = new Set();
  let editSequence = 0;
  const guard = fn => async () => { try { await fn(); } catch (e) { toast(reason(e), true); } };
  $('pmCategory').insertAdjacentHTML('afterend', '<div class="row"><input id="pmCategoryName" maxlength="80" placeholder="自定义分类名" aria-label="自定义分类名"><button id="pmCategoryAdd">新建分类</button><button id="pmCategoryRename">分类改名</button></div><div class="row"><select id="pmMoveCategory" aria-label="批量移动目标"></select><button id="pmMove">移动已选个人预设</button></div>');
  $('pmContent').parentElement.insertAdjacentHTML('afterend', '<details id="pmFieldPanel"><summary>参数、填空与历史</summary><div id="pmFieldInputs"></div><select id="pmFieldHistory" aria-label="填空历史"></select><div class="row"><button id="pmFieldRestore">载入历史值</button><button id="pmFieldDefaults">写入提示词草稿</button></div><p id="pmFieldStatus" class="mute"></p></details>');
  async function refresh() {
    const editCategory = $('pmEditCategory').value;
    const data = await api('GET', '/presets'); list = data.presets;
    const cats = await api('GET', '/library/categories'); categories = cats.categories; categoryRevision = cats.revision;
    for (const id of marked) if (!list.some(p => p.id === id)) marked.delete(id);
    const cat = $('pmCategory').value;
    $('pmCategory').innerHTML = '<option value="">全部分类</option>' + categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('pmCategory').value = cat;
    $('pmEditCategory').innerHTML = categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('pmMoveCategory').innerHTML = categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (selected) $('pmEditCategory').value = editCategory || selected.category;
    draw(); await loadPresets();
  }
  function draw() {
    const q = $('pmSearch').value.toLowerCase().trim(), cat = $('pmCategory').value;
    $('pmList').innerHTML = list.filter(p => (!q || p.keys.includes(q)) && (!cat || p.category === cat)).map(p => `<div class="manager-list-item ${p.id === selected?.id ? 'selected' : ''}"><input type="checkbox" data-mark="${esc(p.id)}" ${marked.has(p.id) ? 'checked' : ''}><button data-edit="${esc(p.id)}">${esc(p.title)}<small>${p.factory ? '出厂' : '个人'} · v${p.revision} · ${p.refCount} 张参考图</small></button><button class="link" data-star="${esc(p.id)}">${p.starred ? '★' : '☆'}</button></div>`).join('');
  }
  function fill(p) {
    selected = p; refs = [...(p?.refImages || [])]; referenceSources = [...(p?.referenceSources || [])]; fieldHistory = null;
    fieldValues = { params: Object.fromEntries((p?.params || []).map(f => [f.name, f.value])), fills: Object.fromEntries((p?.fills || []).map(f => [f.name, f.value])) };
    $('pmName').value = p?.title || ''; $('pmContent').value = p?.content || '';
    $('pmEditCategory').value = p?.category || 'other';
    $('pmHint').textContent = p ? `${p.factory ? '出厂预设，保存时创建个人副本' : `个人预设 · 第 ${p.revision} 版`} · 修改后请保存` : '新建个人预设';
    $('pmRefCount').textContent = `${refs.length} 张参考图`;
    $('pmRevisions').innerHTML = '';
    drawFields();
    draw();
  }
  async function edit(id) {
    const sequence = ++editSequence;
    const preset = await api('GET', `/presets/${encodeURIComponent(id)}`);
    if (sequence !== editSequence) return;
    fill(preset);
    const history = await api('GET', `/library/fields/${encodeURIComponent(id)}`);
    if (sequence !== editSequence || selected?.id !== id) return;
    fieldHistory = history; drawFields();
    const { revisions } = await api('GET', `/presets/${encodeURIComponent(id)}/revisions`);
    if (sequence !== editSequence || selected?.id !== id) return;
    $('pmRevisions').innerHTML = revisions.map(r => `<div>v${r.revision} · ${esc(new Date(r.updatedAt).toLocaleString())} · ${esc(r.title)} <button data-revision="${r.revision}">恢复为新版本</button></div>`).join('') || '<p class="mute">还没有历史版本</p>';
  }
  async function save(copy) {
    const p = await api('POST', '/presets', { id: !copy ? selected?.id : undefined, expectedRevision: !copy ? selected?.revision : undefined,
      title: $('pmName').value, category: $('pmEditCategory').value, content: $('pmContent').value, refImages: refs, referenceSources });
    selected = p; await refresh(); await edit(p.id); toast('预设已保存');
  }
  $('pmNew').onclick = () => { editSequence++; fill(null); };
  $('pmSavePreset').onclick = guard(() => save(false));
  $('pmDuplicate').onclick = guard(() => save(true));
  $('pmSearch').oninput = draw; $('pmCategory').onchange = draw;
  $('pmList').onchange = e => { if (e.target.dataset.mark) e.target.checked ? marked.add(e.target.dataset.mark) : marked.delete(e.target.dataset.mark); };
  $('pmList').onclick = e => guard(async () => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) await edit(b.dataset.edit);
    if (b.dataset.star) { const p = list.find(p => p.id === b.dataset.star); await api('POST', `/presets/${encodeURIComponent(p.id)}/star`, { starred: !p.starred }); await refresh(); }
  })();
  $('pmDelete').onclick = guard(async () => {
    if (!selected) throw new Error('先选择个人预设');
    await api('POST', `/presets/${encodeURIComponent(selected.id)}/delete`); marked.delete(selected.id); fill(null); await refresh(); toast('已移入回收站');
  });
  $('pmUseCurrent').onclick = () => { $('pmContent').value = $('genPrompt').value; };
  $('pmRefs').onclick = guard(async () => {
    const r = await api('POST', '/presets/reference-data', { uploadIds: work.refs.map(x => x.uploadId) });
    refs = r.refImages; referenceSources = work.refs.map(r => ({ name: r.name || '', libraryId: r.libraryId, source: r.source || { kind: 'workspace' } })); $('pmRefCount').textContent = `${refs.length} 张参考图`;
  });
  $('pmUse').onclick = guard(async () => {
    if (!selected) throw new Error('先保存预设');
    if (hasDraft()) throw new Error('有未保存修改，请先保存预设');
    const r = await applyFields();
    await selectPreset(selected.id);
    $('genPrompt').value = r.content;
    for (const f of work.preset.params) if (Object.hasOwn(fieldValues.params, f.name)) f.value = fieldValues.params[f.name];
    for (const f of work.preset.fills) if (Object.hasOwn(fieldValues.fills, f.name)) f.value = fieldValues.fills[f.name];
    renderPresetDetail(); showTab('work');
  });
  $('pmExport').onclick = guard(async () => {
    const pack = await api('POST', '/presets/export', { ids: [...marked] });
    const file = await window.bridge.savePack('PS-AI-Bridge-预设.json', pack); if (file) toast('已导出预设及参考图');
  });
  $('pmDialogClose').onclick = () => { $('pmDialog').hidden = true; importPack = null; };
  $('pmImport').onclick = guard(async () => {
    const file = await window.bridge.openPack(); if (!file) return;
    importPack = file.data;
    const { report } = await api('POST', '/presets/import-pack', { pack: importPack, preview: true });
    $('pmDialogTitle').textContent = `导入预检 · ${file.name}`;
    $('pmDialogBody').innerHTML = report.map(r => `<article><strong>${esc(r.title)}</strong><p>${esc(r.errors.join('；') || (r.duplicate ? '完全重复，将跳过' : r.conflict ? '同名但内容不同，将保留两份' : '可导入'))}</p></article>`).join('');
    $('pmDialogApply').hidden = !report.some(r => !r.duplicate && !r.errors.length); $('pmDialog').hidden = false;
  });
  $('pmDialogApply').onclick = guard(async () => {
    if (!importPack) return;
    const r = await api('POST', '/presets/import-pack', { pack: importPack });
    importPack = null; $('pmDialog').hidden = true; await refresh(); toast(`已导入 ${r.added}，跳过 ${r.skipped}，未导入 ${r.rejected}`);
  });
  async function trash() {
    const r = await api('GET', '/presets/trash');
    $('pmDialogTitle').textContent = '预设回收站'; $('pmDialogApply').hidden = true;
    $('pmDialogBody').innerHTML = r.presets.map(p => `<article>${esc(p.title)} <button data-restore="${esc(p.trashId)}">恢复</button></article>`).join('') || '<p>回收站为空</p>';
    $('pmDialog').hidden = false;
  }
  $('pmTrash').onclick = guard(trash);
  $('pmDialogBody').onclick = e => guard(async () => { if (e.target.dataset.restore) { await api('POST', '/presets/restore', { trashId: e.target.dataset.restore }); await refresh(); await trash(); } })();
  $('pmRevisions').onclick = e => guard(async () => {
    if (!e.target.dataset.revision || !selected) return;
    await api('POST', `/presets/${encodeURIComponent(selected.id)}/restore-revision`, { revision: Number(e.target.dataset.revision) });
    await refresh(); await edit(selected.id); toast('旧版本已恢复，原版本仍可找回');
  })();
  document.addEventListener('workspace-tab', e => { if (e.detail === 'presets') guard(refresh)(); });
  document.addEventListener('library-presets-changed', () => guard(refresh)());
  document.addEventListener('library-category-selected', e => guard(async () => { await refresh(); $('pmCategory').value = e.detail; draw(); })());

  function drawFields() {
    $('pmFieldInputs').innerHTML = (selected?.params || []).map((f, i) => `<label class="field">${esc(f.name)} <small>${f.min}–${f.max} · 步长 ${f.step}</small><input type="number" data-pm-param="${i}" min="${f.min}" max="${f.max}" step="${f.step}" value="${esc(fieldValues.params[f.name])}"></label>`).join('') +
      (selected?.fills || []).map((f, i) => `<label class="field">${esc(f.name)}<input data-pm-fill="${i}" maxlength="4000" value="${esc(fieldValues.fills[f.name])}" list="pmFillSuggestions${i}"><datalist id="pmFillSuggestions${i}">${[...new Set((fieldHistory?.entries || []).map(h => h.fills[f.name]).filter(v => v !== undefined))].map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist></label>`).join('');
    $('pmFieldHistory').innerHTML = '<option value="">选择历史值</option>' + (fieldHistory?.entries || []).map(h => `<option value="${esc(h.id)}">${esc(new Date(h.usedAt).toLocaleString())} · v${h.presetRevision} · ${esc(Object.values(h.fills).join(' / ').slice(0, 60))}</option>`).join('');
    fieldStatus();
  }
  function fieldStatus() {
    const changed = (selected?.params || []).some(f => fieldValues.params[f.name] !== f.value) || (selected?.fills || []).some(f => fieldValues.fills[f.name] !== f.value);
    $('pmFieldStatus').textContent = selected ? (changed ? '参数或填空已改动；用于生成时记录历史，预设原文保持到主动保存。' : '当前为预设默认值。用于生成时记录最近 30 组值。') : '保存或选择预设后可填写参数。';
  }
  function hasDraft() {
    return selected && ($('pmContent').value !== selected.content || $('pmName').value !== selected.title || $('pmEditCategory').value !== selected.category || JSON.stringify(refs) !== JSON.stringify(selected.refImages));
  }
  for (const id of ['pmContent', 'pmName', 'pmEditCategory']) $(id).addEventListener('input', () => {
    $('pmHint').textContent = !selected ? '新建个人预设' : hasDraft() ? '有未保存修改；保存后生成新的预设版本' : `与已保存预设一致 · 第 ${selected.revision} 版`;
  });
  $('pmFieldInputs').oninput = e => {
    if (e.target.dataset.pmParam !== undefined) fieldValues.params[selected.params[Number(e.target.dataset.pmParam)].name] = Number(e.target.value);
    if (e.target.dataset.pmFill !== undefined) fieldValues.fills[selected.fills[Number(e.target.dataset.pmFill)].name] = e.target.value;
    fieldStatus();
  };
  $('pmFieldRestore').onclick = guard(() => {
    const entry = fieldHistory?.entries.find(h => h.id === $('pmFieldHistory').value);
    if (!entry) throw new Error('先选择一组历史值');
    for (const f of selected.params) if (Object.hasOwn(entry.params, f.name)) fieldValues.params[f.name] = entry.params[f.name];
    for (const f of selected.fills) if (Object.hasOwn(entry.fills, f.name)) fieldValues.fills[f.name] = entry.fills[f.name];
    drawFields();
  });
  async function applyFields() {
    if (!selected || !fieldHistory) throw new Error('字段历史尚未加载，请重新打开预设');
    const r = await api('POST', '/library/fields', { id: selected.id, expectedRevision: fieldHistory.revision, expectedPresetRevision: selected.revision, ...fieldValues });
    fieldHistory = r.history; drawFields(); return r;
  }
  $('pmFieldDefaults').onclick = guard(async () => {
    if ($('pmContent').value !== selected?.content) throw new Error('提示词草稿已改动，请先保存再填写字段');
    $('pmContent').value = (await applyFields()).content;
    $('pmHint').textContent = '字段已写入草稿；点击保存后成为新默认值';
  });
  $('pmCategoryAdd').onclick = guard(async () => {
    await api('POST', '/library/categories', { name: $('pmCategoryName').value, expectedRevision: categoryRevision });
    $('pmCategoryName').value = ''; await refresh();
  });
  $('pmCategoryRename').onclick = guard(async () => {
    const id = $('pmCategory').value;
    if (!categories.some(c => c.id === id && !c.builtin)) throw new Error('先在筛选中选择自定义分类');
    await api('POST', '/library/categories', { id, name: $('pmCategoryName').value, expectedRevision: categoryRevision });
    await refresh();
  });
  $('pmMove').onclick = guard(async () => {
    const ids = [...marked];
    if (!ids.length) throw new Error('先勾选要移动的个人预设');
    if (selected && ids.includes(selected.id) && hasDraft()) throw new Error('当前预设有未保存修改，请先保存再移动');
    await api('POST', '/library/move-presets', { ids, category: $('pmMoveCategory').value, expectedRevisions: Object.fromEntries(list.filter(p => marked.has(p.id)).map(p => [p.id, p.revision])) });
    await refresh(); if (selected && ids.includes(selected.id)) await edit(selected.id); toast('已移动所选预设');
  });
})();

// The workspace keeps its existing sliders and fills. This adds durable history
// without replacing generation handlers or storing another localStorage copy.
(() => {
  $('fillList').insertAdjacentHTML('afterend', '<details id="workFieldHistory"><summary>参数与填空历史</summary><select id="workFieldHistorySelect" aria-label="工作台字段历史"></select><button id="workFieldHistoryRestore">载入历史值</button><p id="workFieldHistoryStatus" class="mute"></p></details>');
  let history = null, sequence = 0, pending = Promise.resolve(), structuredPrompt = '', manualDirty = false;
  const fields = p => ({ params: Object.fromEntries(p.params.map(f => [f.name, f.value])), fills: Object.fromEntries(p.fills.map(f => [f.name, f.value])) });
  function draw() {
    $('workFieldHistorySelect').innerHTML = '<option value="">选择历史值</option>' + (history?.entries || []).map(h => `<option value="${esc(h.id)}">${esc(new Date(h.usedAt).toLocaleString())} · ${esc(Object.values(h.fills).join(' / ').slice(0, 60))}</option>`).join('');
    for (const [i, f] of (work.preset?.fills || []).entries()) {
      const input = $('fillList').querySelector(`[data-fill="${i}"]`); if (!input) continue;
      let suggestions = $(`workFillSuggestions${i}`);
      if (!suggestions) { suggestions = document.createElement('datalist'); suggestions.id = `workFillSuggestions${i}`; input.parentElement.append(suggestions); }
      input.setAttribute('list', suggestions.id);
      suggestions.innerHTML = [...new Set((history?.entries || []).map(h => h.fills[f.name]).filter(v => v !== undefined))].map(v => `<option value="${esc(v)}"></option>`).join('');
    }
  }
  async function load() {
    const current = ++sequence, p = work.preset;
    history = null; structuredPrompt = $('genPrompt').value; manualDirty = false;
    $('workFieldHistoryStatus').textContent = '';
    if (!p) return draw();
    try {
      const h = await api('GET', `/library/fields/${encodeURIComponent(p.id)}`);
      if (sequence !== current || work.preset?.id !== p.id) return;
      history = h; draw();
    } catch (e) { $('workFieldHistoryStatus').textContent = reason(e); }
  }
  // Only observe direct render replacements; datalists added inside a row do
  // not trigger another load and do not create an observer/request loop.
  new MutationObserver(load).observe($('fillList'), { childList: true });
  function record() {
    const p = work.preset;
    if (!p) return;
    const id = p.id, revision = p.revision, values = fields(p);
    pending = pending.then(async () => {
      const before = await api('GET', `/library/fields/${encodeURIComponent(id)}`);
      const result = await api('POST', '/library/fields', { id, expectedRevision: before.revision, expectedPresetRevision: revision, ...values });
      if (work.preset?.id === id && work.preset.revision === revision) {
        history = result.history; draw(); $('workFieldHistoryStatus').textContent = '字段历史已保存';
      }
    }).catch(e => { $('workFieldHistoryStatus').textContent = reason(e); toast(reason(e), true); });
  }
  for (const id of ['paramList', 'fillList']) {
    let beforeInput = '';
    $(id).addEventListener('input', () => { beforeInput = $('genPrompt').value; }, true);
    $(id).addEventListener('input', e => {
      // Preserve the legacy controls but fix literal replacement and exponent
      // handling at this integration boundary (the old setters use "$1value").
      if (work.preset && e.target.dataset.param !== undefined) {
        const f = work.preset.params[Number(e.target.dataset.param)], name = reEsc(f.name);
        $('genPrompt').value = beforeInput.replace(new RegExp(`("?@param:${name}"\\s*:\\s*)-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?`, 'gi'), (_, prefix) => prefix + f.value);
      }
      if (work.preset && e.target.dataset.fill !== undefined) {
        const f = work.preset.fills[Number(e.target.dataset.fill)], name = reEsc(f.name);
        $('genPrompt').value = beforeInput.replace(new RegExp(`【填空:${name}(?:=[^】]*)?】`, 'g'), () => `【填空:${f.name}=${f.value.replace(/】/g, '')}】`);
      }
      if (!manualDirty) structuredPrompt = $('genPrompt').value;
    });
    $(id).addEventListener('change', record);
  }
  $('genPrompt').addEventListener('input', () => {
    manualDirty = $('genPrompt').value !== structuredPrompt;
    if (work.preset) $('workFieldHistoryStatus').textContent = $('genPrompt').value === structuredPrompt ? '' : '提示词已有手动修改；为保留草稿，载入历史前请重新选择预设。';
  });
  $('workFieldHistoryRestore').onclick = async () => {
    try {
      const p = work.preset, entry = history?.entries.find(h => h.id === $('workFieldHistorySelect').value);
      if (!p || !entry) throw new Error('先选择一组字段历史');
      if (manualDirty || $('genPrompt').value !== structuredPrompt) throw new Error('提示词有手动修改，请先保存或重新选择预设');
      const values = fields(p);
      for (const f of p.params) if (Object.hasOwn(entry.params, f.name)) values.params[f.name] = entry.params[f.name];
      for (const f of p.fills) if (Object.hasOwn(entry.fills, f.name)) values.fills[f.name] = entry.fills[f.name];
      await pending;
      const before = await api('GET', `/library/fields/${encodeURIComponent(p.id)}`);
      const r = await api('POST', '/library/fields', { id: p.id, expectedRevision: before.revision, expectedPresetRevision: p.revision, ...values });
      if (work.preset !== p) return;
      for (const f of p.params) f.value = values.params[f.name];
      for (const f of p.fills) f.value = values.fills[f.name];
      $('genPrompt').value = r.content; structuredPrompt = r.content;
      renderPresetDetail(); toast('已载入字段历史');
    } catch (e) { toast(reason(e), true); }
  };
})();
