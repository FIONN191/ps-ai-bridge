(function (root) {
  'use strict';
  var host = {}, selectionRevision = 0, selectedId = '', pending = null, ready = null, lastFailure = null, dialog = null;
  function contract() { if (!root.V7PresetPreActionContract) throw new Error('前置动作模块未加载'); return root.V7PresetPreActionContract; }
  function failure(code, message) { return Object.assign(new Error(message || code), {code: code}); }
  function report(error) { if (root.ERR) root.ERR.report(error.code || 'PREACTION_PS_FAILED', {message: error.message, detail: error.message}); else console.error(error); }
  function unwrap(result) {
    if (!result || result.ok === false || result.success === false) throw failure(result && result.error && result.error.code || 'PREACTION_PS_FAILED', result && result.error && result.error.message || result && result.error || 'Photoshop 没有确认前置动作');
    return result.success === true && result.data ? result.data : result;
  }
  async function run(action, params) { if (typeof host.run !== 'function') throw failure('PREACTION_BRIDGE_REQUIRED', '请先连接 Photoshop 与 UXP 联动插件'); return unwrap(await host.run(action, params)); }
  async function currentDocument() {
    if (typeof host.getDocument === 'function') return unwrap(await host.getDocument());
    return run('ps.doc.info', {});
  }
  function signature(preset, config) { return String(preset.id || '') + ':' + JSON.stringify(config); }
  async function prepare(preset, info, revision) {
    var config = contract().normalize(preset && preset.preActions);
    if (!config || !config.enabled) return {applied: false, skipped: true};
    var documentInfo = info || await currentDocument();
    if (revision != null && revision !== selectionRevision) return {applied: false, superseded: true};
    if (!documentInfo || documentInfo.hasDoc === false || !Number.isSafeInteger(Number(documentInfo.id))) throw failure('PREACTION_DOCUMENT_REQUIRED', '请先在 Photoshop 打开目标图片');
    var params = {preActions: config, presetId: String(preset.id || ''), docId: Number(documentInfo.id), expiresAt: Date.now() + 8000};
    if (documentInfo.name != null) params.docName = String(documentInfo.name);
    if (documentInfo.width != null) params.docWidth = Number(documentInfo.width);
    if (documentInfo.height != null) params.docHeight = Number(documentInfo.height);
    var result = await run('ps.preset.prepare', params);
    if (result.applied !== true || Number(result.docId) !== params.docId) throw failure('PREACTION_VERIFY_FAILED', 'Photoshop 未确认目标文档的前置动作');
    if (revision == null || revision === selectionRevision) ready = {signature: signature(preset, config), docId: params.docId};
    return result;
  }
  function select(preset) {
    var config;
    try { config = contract().normalize(preset && preset.preActions); } catch (error) { report(error); return Promise.reject(error); }
    var nextId = String(preset && preset.id || ''), same = nextId === selectedId;
    if (same && pending && pending.signature === signature(preset, config)) return pending.promise;
    if (same && ready && ready.signature === signature(preset, config)) {
      var readyRevision = selectionRevision;
      return currentDocument().then(function (documentInfo) {
        if (readyRevision !== selectionRevision || selectedId !== nextId) return {applied: false, superseded: true};
        if (documentInfo && documentInfo.hasDoc !== false && ready && ready.signature === signature(preset, config) && ready.docId === Number(documentInfo.id)) return {applied: false, unchanged: true};
        ready = null; lastFailure = null; selectionRevision++;
        return prepare(preset, documentInfo, selectionRevision);
      });
    }
    selectedId = nextId; ready = null; lastFailure = null; selectionRevision++;
    if (!config || !config.enabled || config.trigger !== 'select') { pending = null; return Promise.resolve({applied: false, skipped: true}); }
    var revision = selectionRevision;
    var operation = {signature: signature(preset, config)};
    operation.promise = prepare(preset, null, revision).catch(function (error) { if (revision === selectionRevision) { lastFailure = {signature: operation.signature, error: error}; report(error); } throw error; });
    pending = operation;
    operation.promise.then(function () { if (pending === operation) pending = null; }, function () { if (pending === operation) pending = null; });
    return operation.promise;
  }
  async function beforeGenerate(preset, documentInfo) {
    var config = contract().normalize(preset && preset.preActions);
    if (!config || !config.enabled || config.trigger === 'manual') return {applied: false, skipped: true};
    // A ready selection is tied to the document it prepared. Callers that do
    // not have a snapshot (the normal generation path) must resolve the live
    // Photoshop document before reusing that cached result.
    if (config.trigger === 'select' && pending && pending.signature === signature(preset, config)) await pending.promise;
    if (config.trigger === 'select' && lastFailure && lastFailure.signature === signature(preset, config)) throw lastFailure.error;
    documentInfo = documentInfo || await currentDocument();
    if (documentInfo && documentInfo.hasDoc !== false && config.trigger === 'select' && ready && ready.signature === signature(preset, config) && ready.docId === Number(documentInfo.id)) return {applied: false, ready: true};
    return prepare(preset, documentInfo);
  }
  async function manual(preset) { return prepare(preset); }
  function escape(value) { return String(value || '').replace(/[&<>"']/g, function (c) { return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]; }); }
  function openEditor(preset) {
    if (dialog) dialog.remove();
    var original = contract().normalize(preset.preActions) || {version: 1, enabled: false, trigger: 'select'};
    dialog = document.createElement('dialog'); dialog.className = 'preset-preaction-editor';
    dialog.style.cssText = 'box-sizing:border-box;width:460px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;border:1px solid var(--line,#555);border-radius:8px;padding:20px;background:#262629;color:var(--tx,#eee);font:13px/1.5 system-ui,sans-serif';
    var tools = '<option value="">保持当前工具</option>' + Object.keys(contract().TOOLS).map(function (key) { return '<option value="' + key + '"' + (original.tool === key ? ' selected' : '') + '>' + escape(contract().TOOLS[key]) + '</option>'; }).join('');
    dialog.innerHTML = '<form><h2 style="font-size:17px;margin:0 0 12px">' + escape(preset.title) + ' · 前置动作</h2>' +
      '<label><input name="enabled" type="checkbox"' + (original.enabled ? ' checked' : '') + '> 启用</label>' +
      '<label class="settings-field">执行时机<select name="trigger"><option value="select">选中预设时</option><option value="manual">点击准备标注时</option><option value="beforeGenerate">开始生成前</option></select></label>' +
      '<label class="settings-field">Photoshop 工具<select name="tool">' + tools + '</select></label>' +
      '<label class="settings-field">形状 / 图案工具预设名称<input name="toolPreset" maxlength="160" value="' + escape(original.toolPreset) + '"></label>' +
      '<div style="display:flex;flex-wrap:wrap;gap:24px;margin:12px 0"><label><input type="checkbox" name="setForeground"' + (original.foreground ? ' checked' : '') + '> 前景色 <input type="color" name="foreground" value="' + (original.foreground || '#ff0000') + '"></label><label><input type="checkbox" name="setBackground"' + (original.background ? ' checked' : '') + '> 背景色 <input type="color" name="background" value="' + (original.background || '#00ff00') + '"></label></div>' +
      '<label class="settings-field">依赖图形包编号（逗号分隔）<input name="packIds" value="' + escape((original.packIds || []).join(', ')) + '"></label>' +
      '<div class="settings-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><button class="settings-btn" type="button" data-install>安装图形包</button><button class="settings-btn" type="button" data-redgreen>红绿画笔</button><button class="settings-btn" type="button" data-prepare>准备标注</button></div><div role="status" data-status style="overflow-wrap:anywhere"></div>' +
      '<div class="settings-actions" style="display:flex;gap:8px;margin-top:16px"><button class="settings-btn" type="submit">保存</button><button class="settings-btn" type="button" data-close>取消</button></div></form>';
    document.body.appendChild(dialog); var current = dialog, form = dialog.querySelector('form'), status = dialog.querySelector('[data-status]');
    form.elements.trigger.value = original.trigger;
    function values() { var f = form.elements; return contract().normalize({version: 1, enabled: f.enabled.checked, trigger: f.trigger.value, tool: f.tool.value, toolPreset: f.toolPreset.value, foreground: f.setForeground.checked ? f.foreground.value : '', background: f.setBackground.checked ? f.background.value : '', packIds: f.packIds.value.split(',').map(function (id) { return id.trim(); }).filter(Boolean)}); }
    function close() { current.close(); current.remove(); if (dialog === current) dialog = null; }
    var busy = false;
    async function execute(fn) { if (busy) return; busy = true; form.querySelectorAll('button').forEach(function (button) { button.disabled = true; }); try { await fn(); } catch (error) { status.textContent = error.message; report(error); } finally { busy = false; form.querySelectorAll('button').forEach(function (button) { button.disabled = false; }); } }
    form.onsubmit = function (event) { event.preventDefault(); execute(async function () { var updated = Object.assign({}, root.PRESETS.presetById(preset.id) || preset, {preActions: values(), updatedAt: new Date().toISOString()}); await root.PRESETS.savePreset(updated); ready = null; if (typeof host.onSaved === 'function') host.onSaved(updated); close(); }); };
    dialog.querySelector('[data-close]').onclick = close;
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); if (!busy) close(); });
    dialog.querySelector('[data-redgreen]').onclick = function () { var f = form.elements; f.enabled.checked = true; f.trigger.value = 'select'; f.tool.value = 'paintbrushTool'; f.toolPreset.value = ''; f.setForeground.checked = true; f.setBackground.checked = true; f.foreground.value = '#ff0000'; f.background.value = '#00ff00'; };
    dialog.querySelector('[data-prepare]').onclick = function () { execute(async function () { var result = await manual(Object.assign({}, preset, {preActions: values()})); status.textContent = result.applied ? 'Photoshop 已确认工具与颜色。' : '前置动作未启用。'; }); };
    dialog.querySelector('[data-install]').onclick = function () { execute(async function () {
      var id = 'graphics_' + Date.now().toString(36); var result = await run('ps.graphics.installPack', {confirmed: true, packId: id});
      if (result.cancelled) { status.textContent = '已取消安装。'; return; }
      if (!result.installed || !result.pack) throw failure('GRAPHICS_INSTALL_FAILED', 'Photoshop 没有确认图形包安装');
      form.elements.packIds.value = [form.elements.packIds.value, result.pack.id].filter(Boolean).join(', '); status.textContent = result.pack.name + ' 已安装。';
    }); };
    dialog.showModal();
  }
  root.V7PresetPreActions = {configure: function (options) { host = options || {}; }, select: select, beforeGenerate: beforeGenerate, manual: manual, openEditor: openEditor, listPacks: function () { return run('ps.graphics.listPacks', {}); }};
})(window);
