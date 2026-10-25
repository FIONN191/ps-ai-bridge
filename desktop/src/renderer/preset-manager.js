// Management uses the same preset API as the PS panel; no second copy of the library.
(() => {
  let list = [], categories = [], selected = null, refs = [], importPack = null;
  const marked = new Set();
  const guard = fn => async () => { try { await fn(); } catch (e) { toast(reason(e), true); } };
  async function refresh() {
    const data = await api('GET', '/presets'); list = data.presets; categories = data.categories;
    const cat = $('pmCategory').value;
    $('pmCategory').innerHTML = '<option value="">全部分类</option>' + categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('pmCategory').value = cat;
    $('pmEditCategory').innerHTML = categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (selected) $('pmEditCategory').value = selected.category;
    draw(); await loadPresets();
  }
  function draw() {
    const q = $('pmSearch').value.toLowerCase().trim(), cat = $('pmCategory').value;
    $('pmList').innerHTML = list.filter(p => (!q || p.keys.includes(q)) && (!cat || p.category === cat)).map(p => `<div class="manager-list-item ${p.id === selected?.id ? 'selected' : ''}"><input type="checkbox" data-mark="${esc(p.id)}" ${marked.has(p.id) ? 'checked' : ''}><button data-edit="${esc(p.id)}">${esc(p.title)}<small>${p.factory ? '出厂' : '个人'} · v${p.revision} · ${p.refCount} 张参考图</small></button><button class="link" data-star="${esc(p.id)}">${p.starred ? '★' : '☆'}</button></div>`).join('');
  }
  function fill(p) {
    selected = p; refs = [...(p?.refImages || [])];
    $('pmName').value = p?.title || ''; $('pmContent').value = p?.content || '';
    $('pmEditCategory').value = p?.category || 'other';
    $('pmHint').textContent = p ? `${p.factory ? '出厂预设，保存时创建个人副本' : `个人预设 · 第 ${p.revision} 版`} · 修改后请保存` : '新建个人预设';
    $('pmRefCount').textContent = `${refs.length} 张参考图`;
    $('pmRevisions').innerHTML = '';
    draw();
  }
  async function edit(id) {
    fill(await api('GET', `/presets/${encodeURIComponent(id)}`));
    const { revisions } = await api('GET', `/presets/${encodeURIComponent(id)}/revisions`);
    $('pmRevisions').innerHTML = revisions.map(r => `<div>v${r.revision} · ${esc(new Date(r.updatedAt).toLocaleString())} · ${esc(r.title)} <button data-revision="${r.revision}">恢复为新版本</button></div>`).join('') || '<p class="mute">还没有历史版本</p>';
  }
  async function save(copy) {
    const p = await api('POST', '/presets', { id: !copy ? selected?.id : undefined, expectedRevision: !copy ? selected?.revision : undefined,
      title: $('pmName').value, category: $('pmEditCategory').value, content: $('pmContent').value, refImages: refs });
    selected = p; await refresh(); await edit(p.id); toast('预设已保存');
  }
  $('pmNew').onclick = () => fill(null);
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
    refs = r.refImages; $('pmRefCount').textContent = `${refs.length} 张参考图`;
  });
  $('pmUse').onclick = guard(async () => { if (!selected) throw new Error('先保存预设'); await selectPreset(selected.id); showTab('work'); });
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
})();
