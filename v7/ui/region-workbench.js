(function(root) {
  'use strict';
  const core = root.V7RegionCore, media = root.V7RegionMedia;
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const modes = { partition: '全局分区', tiles: '分块增强', stitch: '多区拼接' };
  const statuses = { pending: '待生成', running: '处理中', done: '已完成', partial: '部分成功', failed: '失败', interrupted: '已中断' };
  let host = {}, element = null, store = null, runner = null, run = null, documents = [], records = [], mode = 'partition', generation = 0, prepared = null, locked = false, paintId = 0;
  const previewUrls = new Set();
  // ⭐ 工具大卡订阅用（2026-09-29 用户定案「老弹窗全部收掉」）：区域状态一变就推快照。
  const listeners = new Set(); let statusText = '本机记录';
  function snapshot() {
    const regions = run ? run.regions : [];
    return { mode, busy: !!busy(), status: statusText, hasRun: !!run, runMode: run ? run.mode : null,
      presetId: run ? run.presetId : '', prompt: run ? run.prompt : '', options: run ? { ...run.options } : null,
      layout: run && run.layout ? JSON.parse(JSON.stringify(run.layout)) : null,
      doc: regions[0] ? { ...regions[0].doc } : null,
      regions: regions.map(r => ({ id: r.id, label: r.label, docName: r.doc.name, docWidth: r.doc.width, docHeight: r.doc.height, selection: { ...r.selection },
        status: r.status, statusLabel: statuses[r.status] || r.status, attempts: r.attempts, error: r.error || '', bound: r.bound !== false,
        inputAssetId: r.inputAssetId || '', outputs: r.outputs.map(o => ({ assetId: o.assetId, returned: !!o.returned })) })),
      pending: run ? core.jobs(run).length : 0, failed: run ? core.jobs(run, true).length : 0,
      done: regions.filter(r => r.status === 'done').length, returnable: regions.some(r => r.outputs.some(o => !o.returned)),
      presets: (host.presets ? host.presets() : []).map(p => ({ id: p.id, title: p.title, content: p.content || '' })) };
  }
  function notify() { if (!listeners.size) return; const value = snapshot(); for (const fn of listeners) { try { fn(value); } catch (_) {} } }
  function note(text) { statusText = String(text); if (element) element.querySelector('.rw-status').textContent = statusText; notify(); }
  const scope = () => root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.namespaceId() : 'anonymous';
  const uid = prefix => prefix + '-' + crypto.randomUUID();
  const icon = (name, title, action) => '<button type="button" class="rw-icon" data-rw="' + action + '" title="' + title + '" aria-label="' + title + '">' + (root.ICON ? root.ICON.render(name, 18) : (name === 'close' ? '&#215;' : '&#8592;')) + '</button>';
  function report(error) { note(String(error.message || error)); if (root.ERR) root.ERR.report('REGION_WORKBENCH_FAILED', { message: String(error.message || error) }); }
  function assertCurrent(epoch) { if (generation !== epoch) throw core.fail('账号已切换，请重新打开区域工具'); }
  function busy() { return locked || runner && runner.busy(); }
  async function bridge(action, params) { if (!host.bridge) throw core.fail('Photoshop 联动接口不可用'); return host.bridge(action, params); }
  async function makeAsset(result, targetStore = store) { const response = await fetch('data:' + (result.mime || 'image/png') + ';base64,' + result.imageBase64); return targetStore.put(await response.blob()); }
  async function capture(region, targetStore = store) {
    const result = await bridge('ps.regions.capture', { docId: region.doc.id, selection: region.selection, expected: region.doc, maxEdge: run.options.maxEdge });
    if (String(result.docId) !== String(region.doc.id)) throw core.fail('抓取回执与原文档不一致');
    return makeAsset(result, targetStore);
  }
  function makeRunner() {
    const epoch = generation, activeStore = store, namespace = scope();
    return root.V7RegionRuntime.create({
      isCurrent: () => epoch === generation && namespace === scope(), save: value => activeStore.save(value), changed: () => { if (epoch === generation) paint(); }, report,
      capture: region => capture(region, activeStore), asset: id => activeStore.asset(id), put: blob => activeStore.put(blob),
      sheet: (regions, layout) => media.sheet(regions, layout, activeStore), split: (asset, layout) => media.split(asset, layout, activeStore),
      generate: request => host.generate({ ...request, prepared }), cancel: taskId => host.cancel(taskId)
    });
  }
  function options() {
    const field = key => element.querySelector('[data-option="' + key + '"]');
    return { tileSize: core.integer(field('tileSize').value, 128, 8192, '分块大小'), overlap: core.integer(field('overlap').value, 0, 8191, '重叠'),
      maxEdge: core.integer(field('maxEdge').value, 256, 4096, '抓取长边'), batch: core.integer(field('batch').value, 1, 4, '每区张数'),
      inset: core.integer(field('inset').value, 0, 4096, '蒙版内收'), blur: core.integer(field('blur').value, 0, 4096, '蒙版羽化'), gap: 24 };
  }
  function draft() {
    const presetId = element.querySelector('[data-preset]').value;
    if (!presetId) throw core.fail('请先选择生成预设');
    return { id: uid('regions'), createdAt: Date.now(), mode, options: options(), presetId, prompt: element.querySelector('[data-prompt]').value, regions: [] };
  }
  async function save() {
    if (!run) return;
    const epoch = generation, activeStore = store, activeRun = run;
    await activeStore.save(activeRun); assertCurrent(epoch);
    const rows = await activeStore.list(); assertCurrent(epoch); records = rows;
  }
  async function refreshDocuments() { const epoch = generation, result = await bridge('ps.doc.listOpen', {}); assertCurrent(epoch); documents = result.documents || []; paint(); }
  async function plan() {
    const selected = [...element.querySelectorAll('[data-document]:checked')].map(el => documents[Number(el.dataset.document)]);
    const next = draft(); next.regions = core.plan(mode, selected, next.options);
    next.regions.forEach(region => { core.feather(region, next.options.inset, next.options.blur); region.bound = true; });
    run = next; await save(); paint();
  }
  async function addRegion() {
    const epoch = generation, next = run && run.mode === 'stitch' ? run : draft();
    if (next.regions.length >= 32) throw core.fail('最多拼接 32 个区域');
    const result = await bridge('ps.regions.capture', { maxEdge: next.options.maxEdge }); assertCurrent(epoch);
    const asset = await makeAsset(result); assertCurrent(epoch);
    const region = { id: uid('region'), doc: { id: result.docId, name: result.docName, width: result.docWidth, height: result.docHeight }, selection: result.selection,
      label: '区域 ' + (next.regions.length + 1), inputAssetId: asset.id, bound: true, status: 'pending', attempts: 0, outputs: [] };
    core.feather(region, next.options.inset, next.options.blur); next.regions.push(region); next.layout = core.stitchLayout(next.regions, next.options.maxEdge, next.options.gap);
    run = next; await save(); paint();
  }
  async function execute(groups) {
    if (busy() || !run || !groups.length) return;
    const count = groups.reduce((sum, group) => sum + Math.max(1, run.options.batch - Math.min(...group.map(r => r.outputs.length))), 0);
    if (groups.some(group => group.some(r => r.bound === false))) throw core.fail('请先重新绑定恢复记录中的原文档');
    const epoch = generation; locked = true;
    try {
      const confirmed = await host.confirm({ title: '确认区域生成', body: modes[run.mode] + ' · ' + groups.length + ' 组 · 请求 ' + count + ' 张', detail: '将使用所选预设及当前服务设置。平台任务提交前显示积分费用；生成失败、取消和重试均不自动退款。' }); assertCurrent(epoch);
      if (!confirmed) return;
      prepared = await host.prepare(run); assertCurrent(epoch);
      locked = false; await runner.run(run, groups); await save();
    } finally { if (epoch === generation) { locked = false; paint(); } }
  }
  async function validateTarget(region) {
    if (region.bound === false) throw core.fail('请先重新绑定原文档');
    const result = await bridge('ps.doc.listOpen', {}), doc = (result.documents || []).find(item => String(item.id) === String(region.doc.id));
    if (!doc || doc.name !== region.doc.name || Number(doc.width) !== Number(region.doc.width) || Number(doc.height) !== Number(region.doc.height)) throw core.fail('原文档已关闭、改名或更改尺寸，请重新绑定');
    return doc;
  }
  async function transfer(regions) {
    const epoch = generation;
    for (const region of regions) {
      await validateTarget(region); assertCurrent(epoch);
      for (const output of region.outputs) {
        if (output.returned) continue;
        const asset = await store.asset(output.assetId); assertCurrent(epoch);
        const result = await host.transfer({ asset, doc: region.doc, selection: region.selection, feather: core.feather(region, run.options.inset, run.options.blur) }); assertCurrent(epoch);
        if (!result || !result.layerId) throw core.fail('Photoshop 未返回图层编号；已保留结果，请检查原文档后再操作');
        output.returned = true; output.layerId = result.layerId; await save();
      }
    }
    paint(); note('已传回到原文档');
  }
  async function preview(id) {
    const epoch = generation, activeStore = store, activeElement = element;
    const asset = await activeStore.asset(id); assertCurrent(epoch); if (!activeElement || activeElement !== element) return;
    const url = URL.createObjectURL(asset.full), overlay = document.createElement('div'); previewUrls.add(url); overlay.className = 'rw-preview';
    overlay.innerHTML = '<div class="rw-actions"><button data-save-image>导出 PNG</button>' + icon('close', '关闭预览', 'preview-close') + '</div><img alt="区域结果预览">';
    overlay.querySelector('img').src = url;
    const close = () => { URL.revokeObjectURL(url); previewUrls.delete(url); overlay.remove(); };
    overlay.querySelector('[data-rw]').onclick = close;
    overlay.querySelector('[data-save-image]').onclick = () => { const a = document.createElement('a'); a.href = url; a.download = 'region-result.png'; a.click(); };
    element.append(overlay);
  }
  async function compose(region) {
    const epoch = generation, activeStore = store;
    const group = run.regions.filter(r => String(r.doc.id) === String(region.doc.id));
    const asset = await media.compose(group, 0, activeStore); assertCurrent(epoch);
    const saved = await activeStore.put(asset.full); assertCurrent(epoch);
    await preview(saved.id);
  }
  function paint() {
    notify();
    if (!element) return;
    const currentPaint = ++paintId, activeStore = store, values = {};
    for (const input of element.querySelectorAll('[data-option]')) values[input.dataset.option] = input.value;
    const selectedPreset = element.querySelector('[data-preset]')?.value, prompt = element.querySelector('[data-prompt]')?.value;
    const checkedDocs = new Set([...element.querySelectorAll('[data-document]:checked')].map(el => documents[Number(el.dataset.document)]?.id));
    const presets = host.presets ? host.presets() : [], defaults = run && run.mode === mode ? run.options : { tileSize: 2048, overlap: 256, maxEdge: 2048, batch: 1, inset: 0, blur: 80 };
    const option = (key, label, min, max) => '<label><span>' + label + '</span><input type="number" data-option="' + key + '" min="' + min + '" max="' + max + '" value="' + escape(run ? defaults[key] : values[key] ?? defaults[key]) + '"></label>';
    element.querySelector('[data-settings]').innerHTML = '<div class="rw-settings-grid"><label class="rw-wide"><span>生成预设</span><select data-preset><option value="">选择预设</option>' + presets.map(p => '<option value="' + escape(p.id) + '"' + ((run?.presetId || selectedPreset) === p.id ? ' selected' : '') + '>' + escape(p.title) + '</option>').join('') + '</select></label>'
      + '<label class="rw-wide"><span>提示词</span><textarea data-prompt>' + escape(run?.prompt ?? prompt ?? '') + '</textarea></label>'
      + option('batch', '每区结果张数', 1, 4) + option('maxEdge', '抓取 / 拼图长边 px', 256, 4096)
      + '<div' + (mode === 'tiles' ? '' : ' hidden') + '>' + option('tileSize', '分块大小 px', 128, 8192) + '</div><div' + (mode === 'tiles' ? '' : ' hidden') + '>' + option('overlap', '重叠 px', 0, 8191) + '</div>'
      + option('inset', '传回蒙版内收 px', 0, 4096) + option('blur', '传回蒙版羽化 px', 0, 4096) + '</div>'
      + '<div class="rw-actions"><button data-rw="documents">刷新 PS 文档</button></div><div class="rw-docs">' + documents.map((doc, i) => '<label><input type="checkbox" data-document="' + i + '"' + (checkedDocs.has(doc.id) ? ' checked' : '') + '><span>' + escape(doc.name) + ' · ' + doc.width + ' × ' + doc.height + '</span></label>').join('') + '</div>'
      + '<button class="rw-primary" data-rw="' + (mode === 'stitch' ? 'capture' : 'plan') + '">' + (mode === 'stitch' ? '加入当前 PS 选区' : '规划勾选文档') + '</button>';
    const regions = run?.regions || [], count = core.jobs(run || { mode, regions }).length;
    element.querySelector('[data-results]').innerHTML = '<p class="rw-summary">' + regions.length + ' 个区域 · ' + regions.filter(r => r.status === 'done').length + ' 已完成 · ' + count + ' 组待处理' + (run?.layout ? ' · 拼图 ' + run.layout.width + ' × ' + run.layout.height : '') + '</p><div class="rw-grid">'
      + regions.map((r, i) => '<article class="rw-region" data-region="' + i + '" data-state="' + r.status + '"><h3>' + escape(r.doc.name) + ' · ' + escape(r.label) + '</h3><small>' + r.selection.left + ', ' + r.selection.top + ' → ' + r.selection.right + ', ' + r.selection.bottom + ' · ' + escape(statuses[r.status] || r.status) + ' · 尝试 ' + r.attempts + ' 次</small>'
        + '<div class="rw-thumbs">' + [r.inputAssetId ? { assetId: r.inputAssetId, source: true } : null, ...r.outputs].filter(Boolean).map((o, j) => '<button class="rw-thumb" data-preview="' + escape(o.assetId) + '"><img alt="' + (o.source ? '输入图' : '生成结果') + '" data-thumb="' + escape(o.assetId) + '"><span>' + (o.source ? '输入' : o.returned ? '已传回' : '结果 ' + j) + '</span></button>').join('') + '</div>'
        + (r.error ? '<p class="rw-error">' + escape(r.error) + '</p>' : '')
        + (r.bound === false ? '<select data-rebind><option value="">重新绑定原文档</option>' + documents.map((doc, index) => '<option value="' + index + '">' + escape(doc.name) + '</option>').join('') + '</select><button data-rw="bind">绑定</button>' : '')
        + '<div class="rw-actions">' + (run.mode !== 'stitch' && ['failed', 'partial', 'interrupted'].includes(r.status) ? '<button data-rw="retry-one">重试缺少结果</button>' : '') + (r.outputs.length ? '<button data-rw="return-one">传回结果</button>' : '')
        + (run.mode !== 'stitch' && r.outputs.length ? '<button data-rw="compose">合成此文档首张</button>' : '') + (run.mode === 'stitch' && !regions.some(x => x.outputs.length) ? '<button data-rw="remove-region">移除</button>' : '') + '</div></article>').join('') + '</div>';
    const recordsEl = element.querySelector('[data-records]'); recordsEl.innerHTML = '<option value="">本机保存记录</option>' + records.map(r => '<option value="' + escape(r.id) + '">' + escape(modes[r.mode]) + ' · ' + (window.V7Format ? window.V7Format.ago(r.createdAt) : new Date(r.createdAt).toLocaleString()) + ' · ' + r.regions.length + ' 区</option>').join(''); recordsEl.value = run?.id || '';
    const inProgress = busy(); element.querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = inProgress && !['stop', 'close'].includes(el.dataset.rw); });
    if (run) element.querySelectorAll('[data-option],[data-preset],[data-prompt]').forEach(el => { el.disabled = true; });
    for (const img of element.querySelectorAll('[data-thumb]')) activeStore.preview(img.dataset.thumb).then(url => { if (url && paintId === currentPaint && img.isConnected) img.src = url; }).catch(report);
    element.querySelector('[data-preset]').onchange = event => { const preset = presets.find(p => p.id === event.target.value); element.querySelector('[data-prompt]').value = preset?.content || ''; };
  }
  async function dispatch(action, button) {
    if (action === 'close') { element.remove(); element = null; store.release(); for (const url of previewUrls) URL.revokeObjectURL(url); previewUrls.clear(); return; }
    if (action === 'stop') { await runner.cancel(); return; }
    if (busy()) return;
    const epoch = generation, region = run?.regions[Number(button.closest('[data-region]')?.dataset.region)];
    if (['run', 'retry', 'retry-one'].includes(action)) return execute(action === 'retry-one' ? [[region]] : core.jobs(run || { mode, regions: [] }, action === 'retry'));
    locked = true;
    try {
      if (action === 'documents') await refreshDocuments();
      else if (action === 'plan') await plan();
      else if (action === 'capture') await addRegion();
      else if (action === 'return') await transfer(run.regions);
      else if (action === 'return-one') await transfer([region]);
      else if (action === 'compose') await compose(region);
      else if (action === 'new') { run = null; }
      else if (action === 'remove-region') { run.regions = run.regions.filter(r => r !== region); run.layout = run.regions.length ? core.stitchLayout(run.regions, run.options.maxEdge, run.options.gap) : null; await save(); }
      else if (action === 'bind') {
        const value = button.closest('[data-region]').querySelector('[data-rebind]').value, doc = value === '' ? null : documents[Number(value)];
        if (!doc || doc.width !== region.doc.width || doc.height !== region.doc.height) throw core.fail('所选文档尺寸必须与原记录一致');
        const confirmed = await host.confirm({ title: '重新绑定原文档', body: region.doc.name + ' → ' + doc.name, detail: '后续传回使用此文件的原坐标，请确认是同一张图片。' }); assertCurrent(epoch);
        if (confirmed) { const old = region.doc.id; for (const r of run.regions) if (String(r.doc.id) === String(old)) { r.doc = { id: doc.id, name: doc.name, path: doc.path || '', width: doc.width, height: doc.height }; r.bound = true; } await save(); }
      }
    } finally { if (epoch === generation) { locked = false; paint(); } }
  }
  async function open(initialMode) {
    const epoch = generation;
    const requested=modes[initialMode]?initialMode:null;
    if(requested&&requested!==mode){
      if(busy())throw core.fail('当前区域任务仍在运行，请完成或停止后切换工具');
      await save();assertCurrent(epoch);run=null;mode=requested;
      if(element){element.querySelector('input[name="region-mode"][value="'+mode+'"]').checked=true;paint();}
    }
    if (element) return;
    if (!store) { store = root.V7RegionStore.create('wheelchair.' + scope() + '.regions.v1'); runner = makeRunner(); const rows = await store.list(); assertCurrent(epoch); records = rows; }
    if (element) return;
    if (requested && !run) mode = requested;
    element = document.createElement('section'); element.className = 'region-workbench'; element.dataset.uiOverlay = 'true'; element.setAttribute('aria-label', '区域工作台');
    element.innerHTML = '<header class="rw-head">' + icon('arrowLeft', '返回主面板', 'close') + '<h2>区域工作台</h2><select data-records aria-label="本机区域记录"></select><button data-rw="new">新建</button></header>'
      + '<nav class="rw-tabs">' + Object.entries(modes).map(([key, label]) => '<label><input type="radio" name="region-mode" value="' + key + '"' + (key === mode ? ' checked' : '') + '>' + label + '</label>').join('') + '</nav>'
      + '<div class="rw-main"><aside class="rw-settings" data-settings></aside><main class="rw-results" data-results></main></div><footer class="rw-foot"><span class="rw-status" role="status">本机记录</span><div class="rw-actions"><button class="rw-primary" data-rw="run">生成待处理区域</button><button data-rw="retry">重试失败区域</button><button data-rw="return">传回已完成结果</button><button data-rw="stop">停止</button></div></footer>';
    document.body.append(element);
    element.addEventListener('click', event => { const previewButton = event.target.closest('[data-preview]'); if (previewButton) { preview(previewButton.dataset.preview).catch(report); return; } const button = event.target.closest('[data-rw]'); if (button) dispatch(button.dataset.rw, button).catch(report); });
    element.addEventListener('change', event => {
      if (event.target.name === 'region-mode') { if (!busy()) { mode = event.target.value; run = null; paint(); } }
      if (event.target.matches('[data-records]')) { const found = records.find(row => row.id === event.target.value); if (found) { run = core.restore(found); mode = run.mode; element.querySelector('input[name=region-mode][value=' + mode + ']').checked = true; paint(); } }
    });
    paint(); await refreshDocuments();
  }
  root.addEventListener('wheelchair:storage-context', () => { generation++; if (runner) runner.cancel().catch(report); if (element) element.remove(); element = null; store?.release(); for (const url of previewUrls) URL.revokeObjectURL(url); previewUrls.clear(); store = null; runner = null; run = null; documents = []; records = []; prepared = null; locked = false; });
  // ⭐ 给工具大卡用（2026-09-29）：不开窗口的区域会话（分块增强 / 多区拼接；全局分区已按用户定案删除，不接）。
  //   和老窗口的区别只是参数由大卡直接传进来，不从窗口里的输入框读；规划 / 抓取 / 生成 / 传回 / 重试 / 停止全是原来那套。
  async function ensureStore() {
    const epoch = generation;
    if (!store) { store = root.V7RegionStore.create('wheelchair.' + scope() + '.regions.v1'); runner = makeRunner(); const rows = await store.list(); assertCurrent(epoch); records = rows; }
  }
  // 规划 / 加区域时预设可以先空着（先看分块预览），点「开始」时才要求（run 里检查）
  function draftFrom(cfg = {}) {
    const o = cfg.options || {};
    const options = { tileSize: core.integer(o.tileSize ?? 2048, 128, 8192, '块大小'), overlap: core.integer(o.overlap ?? 256, 0, 8191, '重叠量'),
      maxEdge: core.integer(o.maxEdge ?? 2048, 256, 4096, '抓取长边'), batch: core.integer(o.batch ?? 1, 1, 4, '每块张数'),
      inset: core.integer(o.inset ?? 0, 0, 4096, '蒙版内收'), blur: core.integer(o.blur ?? 80, 0, 4096, '蒙版羽化'), gap: 24 };
    return { id: uid('regions'), createdAt: Date.now(), mode, options, presetId: cfg.presetId || '', prompt: String(cfg.prompt || ''), regions: [] };
  }
  async function attach(requested) {
    await ensureStore();
    // ⭐ 2026-10-03 放行 'partition'（用户当天明确纠正：全局分区【做回来】，别删名字）。
    //   ⚠ 原来这里只认 tiles / stitch，于是剪影里点「全局分区」永远走不到大卡 ——
    //     表现就是"点了没反应"（tool-workbench 的兜底分支当时写着"已定案删除"）。
    if (['partition', 'tiles', 'stitch'].includes(requested) && requested !== mode) {
      if (busy()) throw core.fail('当前区域任务仍在运行，请完成或停止后切换工具');
      await save(); run = null; mode = requested;
    }
    const epoch = generation;
    const guard = fn => async (...args) => { try { return await fn(...args); } catch (error) { if (epoch === generation) report(error); throw error; } };
    const withLock = async fn => { if (busy()) return; locked = true; try { return await fn(); } finally { if (epoch === generation) { locked = false; paint(); } } };
    const unused = () => !run || !run.regions.some(r => r.outputs.length);
    return {
      snapshot,
      subscribe(fn) { listeners.add(fn); try { fn(snapshot()); } catch (_) {} return () => listeners.delete(fn); },
      // 分块 / 全局分区：按当前 PS 文档重新规划（换预设 / 参数也走这里）
      //
      // ⚠ 两者的区别只有一条：块大小怎么定。
      //   分块（tiles）  —— 用户自己填「块大小 / 重叠」，适合"我知道要多大的块"。
      //   全局分区（partition）—— 不填，按画布长边自动分，保证每块是【正方形】且
      //     铺满整张画布不留中间的空当（core.plan 里就是这么算的）。
      //   ⚠ 所以 partition 分支不能把 tileSize/overlap 传进去 —— 传了会被 core 忽略，
      //     但更糟的是会让后来读代码的人以为那些参数对分区也生效。
      plan: guard(cfg => withLock(async () => {
        const doc = await bridge('ps.doc.info', {}); assertCurrent(epoch);
        if (!doc || doc.id == null) throw core.fail('Photoshop 里没有打开的文档');
        const next = draftFrom(cfg);
        next.mode = mode;   // ⚠ 必须写回：draftFrom 用的是模块级 mode，但重规划时 mode 可能刚被切换过
        next.regions = core.plan(mode === 'partition' ? 'partition' : 'tiles',
          [{ id: doc.id, name: doc.name, path: doc.path || '', width: Number(doc.width), height: Number(doc.height) }], next.options);
        next.regions.forEach(region => { core.feather(region, next.options.inset, next.options.blur); region.bound = true; });
        run = next; await save();
        note('已按 ' + doc.name + ' 规划 ' + next.regions.length + ' 个区域');
      })),
      // 拼接：把 PS 当前选区加进来（第一块时按大卡参数新建）
      addRegion: guard(cfg => withLock(async () => {
        const next = run && run.mode === 'stitch' ? run : draftFrom(cfg);
        if (next.regions.length >= 32) throw core.fail('最多拼接 32 个区域');
        if (next.regions.some(r => r.outputs.length)) throw core.fail('这组已经生成过了；要加新区域请先点「新建一组」');
        const result = await bridge('ps.regions.capture', { maxEdge: next.options.maxEdge }); assertCurrent(epoch);
        const asset = await makeAsset(result); assertCurrent(epoch);
        const region = { id: uid('region'), doc: { id: result.docId, name: result.docName, width: result.docWidth, height: result.docHeight }, selection: result.selection,
          label: '区域 ' + (next.regions.length + 1), inputAssetId: asset.id, bound: true, status: 'pending', attempts: 0, outputs: [] };
        core.feather(region, next.options.inset, next.options.blur); next.regions.push(region); next.layout = core.stitchLayout(next.regions, next.options.maxEdge, next.options.gap);
        run = next; await save(); note('已加入 ' + region.label + ' · ' + result.selection.width + ' × ' + result.selection.height);
      })),
      // 拼接：还没生成前可以移动 / 删除区域，并重新自动排布
      moveRegion: guard((id, dir) => withLock(async () => {
        if (!run || run.mode !== 'stitch' || !unused()) return;
        const at = run.regions.findIndex(r => r.id === id), to = at + Number(dir);
        if (at < 0 || to < 0 || to >= run.regions.length) return;
        [run.regions[at], run.regions[to]] = [run.regions[to], run.regions[at]];
        run.layout = core.stitchLayout(run.regions, run.options.maxEdge, run.options.gap); await save();
      })),
      removeRegion: guard(id => withLock(async () => {
        if (!run || run.mode !== 'stitch' || !unused()) return;
        run.regions = run.regions.filter(r => r.id !== id);
        run.layout = run.regions.length ? core.stitchLayout(run.regions, run.options.maxEdge, run.options.gap) : null; await save();
      })),
      relayout: guard(() => withLock(async () => {
        if (!run || run.mode !== 'stitch' || !run.regions.length || !unused()) return;
        run.layout = core.stitchLayout(run.regions, run.options.maxEdge, run.options.gap); await save(); note('已重新自动排布');
      })),
      // 还没生成前改预设 / 提示词 / 张数
      update: guard(cfg => withLock(async () => {
        if (!run || !unused()) return;
        if (cfg.presetId) run.presetId = cfg.presetId;
        if (cfg.prompt !== undefined) run.prompt = String(cfg.prompt);
        if (cfg.batch !== undefined) run.options.batch = core.integer(cfg.batch, 1, 4, '张数');
        await save();
      })),
      run: guard(async () => {
        if (!run) throw core.fail(mode === 'stitch' ? '先「从当前选区添加」至少一个区域' : '先规划分块');
        if (!run.presetId) throw core.fail('请先在右边选择生成预设');
        await execute(core.jobs(run));
      }),
      retry: guard(async () => { if (!run) return; if (!run.presetId) throw core.fail('请先在右边选择生成预设'); await execute(core.jobs(run, true)); }),
      transfer: guard(() => withLock(async () => { if (run) await transfer(run.regions); })),
      stop: () => runner ? runner.cancel() : Promise.resolve(),
      reset() { if (!busy()) { run = null; note('已新建一组'); } },
      thumb: id => store ? store.preview(id) : Promise.resolve('')
    };
  }
  root.V7RegionWorkbench = { configure: value => { host = value; }, open, attach, isOpen: () => !!element };
})(window);
