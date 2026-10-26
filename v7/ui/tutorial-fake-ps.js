/* ⭐ 2026-10-18 新手教程 · 假 Photoshop 的「大脑」（不画界面，只管文档 / 图层 / 选区，照 PS 插件的格式回结果）。
 *
 * 真软件里，界面通过「桥」给 PS 插件发动作（uxp-bridge/ps-actions.js 的 ACTIONS 表，73 个），插件回
 *   { requestId, action, success, data, error }。教程里由这个文件冒充插件：
 *   · 动作名、参数、返回字段都照 ps-actions.js 抄（抄错 = 真界面在教程里跑岔，所以测试 tests/tutorial-fake-ps.test.js 逐条对）；
 *   · 不认识的动作：回成功 + 空结果，记进 unknown 列表（教程检查脚本会报出来，好补）；
 *   · 图都是 data URL（base64），由画画那一层（tutorial.js）负责合成显示。
 *
 * 浏览器和 Node 都能加载（Node 里给测试用）。
 */
(function (root) {
  'use strict';

  function create(opts) {
    opts = opts || {};
    var nextId = 100;
    var listeners = [];
    var unknown = [];
    var docs = [];
    var active = null;
    var lastCapture = null;
    var selection = null;           // 当前文档的选区 {left,top,right,bottom,width,height}
    var history = 0;

    function emit(kind, detail) { listeners.forEach(function (fn) { try { fn(kind, detail); } catch (_) {} }); }
    function err(code, message) { var e = new Error(message); e.code = code; return e; }

    function addDoc(d) {
      var doc = {
        id: nextId++, name: d.name || '未标题-1.psd', width: d.width || 1600, height: d.height || 2000, resolution: 300,
        mode: 'RGBColorMode', bitsPerChannel: 8,
        // 图层：从上到下。底图一层 + 之后贴回来的
        layers: [{ id: nextId++, name: '背景', kind: 'pixel', visible: true, opacity:1, image: d.image || '', parent: null }]
      };
      docs.push(doc); active = doc; selection = null; history++;
      emit('doc', doc);
      return doc;
    }
    function docById(id) { return docs.find(function (d) { return d.id === Number(id); }) || null; }
    function layerById(doc, id) {
      var found = null;
      (function walk(list) { list.forEach(function (l) { if (l.id === Number(id)) found = l; if (l.layers) walk(l.layers); }); })(doc.layers);
      return found;
    }
    function summary(l, depth) {
      var s = { id: l.id, name: l.name, kind: l.layers ? 'group' : (l.kind || 'pixel'), visible: l.visible !== false, opacity: l.opacity == null ? 100 : l.opacity, depth: depth || 0 };
      if (l.layers) s.layers = l.layers.map(function (c) { return summary(c, (depth || 0) + 1); });
      if (l.mask) s.hasMask = true;
      return s;
    }
    function docInfo() {
      var d = active;
      if (!d) return { hasDoc: false };
      return { hasDoc: true, docId: d.id, id: d.id, name: d.name, width: d.width, height: d.height, resolution: d.resolution,
        mode: d.mode, bitsPerChannel: d.bitsPerChannel, historyId: history, activeLayers: [] };
    }

    // ── 选区：由画布那一层（用户在假 PS 里拖框）设置 ──
    function setSelection(rect) {
      if (!rect) { selection = null; emit('selection', null); return; }
      var r = { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
      r.width = r.right - r.left; r.height = r.bottom - r.top;
      selection = r.width > 4 && r.height > 4 ? r : null;
      emit('selection', selection);
    }

    // ── 抓选区：真插件会把选区那块像素读出来；这里请画画那一层裁一块（opts.crop），拿不到就用整张底图 ──
    async function capture(p, purpose) {
      p = p || {};
      if (!active) throw err('NO_DOCUMENT', '没有打开的 Photoshop 文档');
      var sel = selection;
      if (!sel && p.allowFullCanvas) sel = { left: 0, top: 0, right: active.width, bottom: active.height, width: active.width, height: active.height };
      if (!sel) throw err('NO_SELECTION', '未检测到选区：先在画布上框一块（或打开「用整张图」）');
      var crop = typeof opts.crop === 'function' ? await opts.crop(active, sel) : null;
      var imageBase64 = crop || String(active.layers[active.layers.length - 1].image || '').replace(/^data:[^,]+,/, '');
      var capturedAt = Date.now();
      lastCapture = { imageBase64: imageBase64, selection: sel, docId: active.id, docName: active.name, capturedAt: capturedAt };
      emit('capture', { purpose: purpose || 'generate', selection: sel });
      if (purpose === 'reference' || purpose === 'chat') { selection = null; emit('selection', null); }
      return {
        imageBase64: imageBase64, mime: 'image/png', width: sel.width, height: sel.height, selection: sel,
        docId: active.id, docName: active.name, docWidth: active.width, docHeight: active.height,
        pixelWidth: sel.width, pixelHeight: sel.height, selectionWidth: sel.width, selectionHeight: sel.height,
        hasSelection: true, antiMode: Number(p.antiMode) || 0, capturedAt: capturedAt, captureId: active.id + ':' + capturedAt,
        deselected: purpose === 'reference' || purpose === 'chat' || undefined, purpose: purpose
      };
    }

    // ── 贴回：新图层放在最上面，记住它贴在哪（选区） ──
    function placeOne(doc, base64, sel, layerType, name) {
      var layer = { id: nextId++, name: name || ('生成结果 ' + (doc.layers.length)), kind: layerType === 'pixel' ? 'pixel' : 'smartObject',
        visible: true, opacity:1, image: base64 ? 'data:image/png;base64,' + String(base64).replace(/^data:[^,]+,/, '') : '', rect: sel || null, parent: null };
      doc.layers.unshift(layer); history++;
      emit('layers', doc);
      return layer;
    }
    function place(p) {
      p = p || {};
      var doc = docById(p.targetDocId || p.docId || (lastCapture && lastCapture.docId)) || active;
      if (!doc) throw err('SOURCE_DOCUMENT_CLOSED', '来源文档已关闭，无法传回');
      var sel = p.targetSelection || p.selection || (lastCapture && lastCapture.selection) || null;
      var layer = placeOne(doc, p.imageBase64 || p.base64 || (lastCapture && lastCapture.imageBase64), sel, p.layerType);
      return { placed: true, layerId: layer.id, docId: doc.id, selection: sel, layerType: p.layerType || 'smartObject', feathered: !!p.feather };
    }
    function placeBatch(p) {
      p = p || {};
      var items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) throw err('NO_IMAGES', '没有可贴回的图片');
      var doc = docById(p.targetDocId || (lastCapture && lastCapture.docId)) || active;
      if (!doc) throw err('SOURCE_DOCUMENT_CLOSED', '来源文档已关闭，无法传回');
      var ids = items.map(function (it, i) { return placeOne(doc, it.imageBase64 || it.base64, it.selection, it.layerType, '生成结果 ' + (i + 1)).id; });
      return { placed: true, layerIds: ids, docId: doc.id, feathered: !!p.feather };
    }
    // ── 编组：把这些图层收进一个组（组名带前缀，跟真插件一样「<前缀> 生成组」） ──
    function createGroup(p) {
      p = p || {};
      var ids = (Array.isArray(p.layerIds) ? p.layerIds : []).map(Number);
      if (!ids.length) throw err('NO_LAYER_IDS', '没有提供要编组的图层');
      var doc = active;
      var members = doc.layers.filter(function (l) { return ids.indexOf(l.id) >= 0; });
      doc.layers = doc.layers.filter(function (l) { return ids.indexOf(l.id) < 0; });
      var group = { id: nextId++, name: (p.groupName || '修图轮椅') + ' 生成组', layers: members, visible: true, opacity:1, open: true, mask: !!(p.maskOptions) };
      members.forEach(function (m) { m.parent = group.id; });
      doc.layers.unshift(group); history++;
      emit('layers', doc);
      return { groupId: group.id, layerIds: ids };
    }
    // ── 组内单显：划缩略图时 PS 跟着切（图层联动） ──
    function soloOwned(p) {
      p = p || {};
      var doc = p.docId != null ? docById(p.docId) : active;
      if (!doc) return { ok: false, reason: 'DOCUMENT_CLOSED', applied: [] };
      var solo = Number(p.soloLayerId != null ? p.soloLayerId : p.soloLayerID);
      var owned = (Array.isArray(p.ownedLayerIds) ? p.ownedLayerIds : []).map(Number);
      if (!isFinite(solo) || !owned.length) return { ok: false, reason: 'NO_TARGET', applied: [] };
      var applied = [];
      owned.forEach(function (id) { var l = layerById(doc, id); if (l) { l.visible = id === solo; applied.push({ id: id, visible: l.visible }); } });
      history++; emit('layers', doc);
      // 双击缩略图（focusRegion）：真插件会跳到那张图并缩放到填满画面 —— 这里通知画画那一层去缩放
      if (p.focusRegion) { var sl = layerById(doc, solo); if (sl && sl.rect) emit('view', { rect: sl.rect, layerId: solo }); }
      return { ok: true, applied: applied, soloLayerId: solo, focused: !!p.focusRegion };
    }
    function showOwned(p) {
      var doc = (p && p.docId != null) ? docById(p.docId) : active;
      if (!doc) return { ok: false, applied: [] };
      var owned = ((p && p.ownedLayerIds) || []).map(Number);
      owned.forEach(function (id) { var l = layerById(doc, id); if (l) l.visible = true; });
      history++; emit('layers', doc);
      return { ok: true, applied: owned };
    }
    function mutateLayer(kind, p) {
      p = p || {};
      var doc = docById(p.docId) || active;
      var l = doc && layerById(doc, p.layerId || p.id);
      if (!l) throw err('LAYER_NOT_FOUND', '找不到图层');
      if (kind === 'visibility') l.visible = p.visible !== false;
      if (kind === 'opacity') l.opacity = Math.max(0, Math.min(100, Number(p.opacity)));
      if (kind === 'rename') l.name = String(p.name || l.name);
      if (kind === 'delete') { (function drop(list) { var i = list.indexOf(l); if (i >= 0) list.splice(i, 1); list.forEach(function (x) { if (x.layers) drop(x.layers); }); })(doc.layers); }
      history++; emit('layers', doc);
      return { ok: true, layerId: l.id };
    }
    // ── 抠像 / 解析把结果当蒙版贴回：盖印一层 + 带蒙版 ──
    function applyMask(p, label) {
      var doc = docById(p && p.docId) || active;
      if (!doc) throw err('NO_DOCUMENT', '没有打开的文档');
      var layer = placeOne(doc, '', (p && p.selection) || null, 'pixel', (p && p.layerName) || label);
      layer.mask = (p && (p.alphaBase64 || p.maskBase64)) ? 'data:image/png;base64,' + String(p.alphaBase64 || p.maskBase64).replace(/^data:[^,]+,/, '') : 'mask';
      layer.stampOf = 'visible';
      emit('layers', doc);
      return { layerId: layer.id, layerName: layer.name };
    }

    var ACTIONS = {
      'ps.doc.info': function () { return docInfo(); },
      'getDocInfo': function () { return docInfo(); },
      'ps.doc.listOpen': function () { return { documents: docs.map(function (d) { return { id: d.id, docId: d.id, name: d.name, width: d.width, height: d.height, active: d === active }; }) }; },
      'fetchOpenDocs': function () { return ACTIONS['ps.doc.listOpen'](); },
      'listDocuments': function () { return ACTIONS['ps.doc.listOpen'](); },
      'ps.doc.select': function (p) { var d = docById(p && (p.docId || p.id)); if (!d) throw err('DOCUMENT_CLOSED', '文档已关闭'); active = d; emit('doc', d); return { ok: true, docId: d.id }; },
      'activateDocument': function (p) { return ACTIONS['ps.doc.select'](p); },
      'ps.doc.canvasThumb': async function () {
        if (!active) throw err('NO_DOCUMENT', '没有打开的文档');
        var t = typeof opts.thumb === 'function' ? await opts.thumb(active) : null;
        return { imageBase64: t || '', mime: 'image/jpeg', width: 512, height: Math.round(512 * active.height / active.width), docId: active.id };
      },
      'ps.selection.rect': function () { return { hasSelection: !!selection, selection: selection, docId: active && active.id }; },
      'probeSelectionRect': function () { return ACTIONS['ps.selection.rect'](); },
      'ps.selection.capture': function (p) { return capture(p, 'generate'); },
      'ps.selection.captureRef': function (p) { return capture(Object.assign({}, p, { antiMode: 0 }), 'reference'); },
      'ps.selection.recaptureRef': function (p) { return capture(Object.assign({}, p, { antiMode: 0 }), 'reference'); },
      'captureRefImage': function (p) { return capture(Object.assign({}, p, { antiMode: 0 }), 'reference'); },
      'recaptureRefImage': function (p) { return capture(Object.assign({}, p, { antiMode: 0 }), 'reference'); },
      'ps.selection.captureForChat': function (p) { return capture(Object.assign({}, p, { antiMode: 0 }), 'chat'); },
      'captureForChat': function (p) { return capture(Object.assign({}, p, { antiMode: 0 }), 'chat'); },
      'ps.assistant.capture': function (p) { return capture(Object.assign({ allowFullCanvas: true }, p, { antiMode: 0 }), 'chat'); },
      'ps.selection.restore': function (p) { if (p && p.selection) setSelection(p.selection); return { ok: true, restored: !!selection }; },
      'restoreSelectionFromHistory': function (p) { return ACTIONS['ps.selection.restore'](p); },
      'ps.selection.clear': function () { setSelection(null); return { ok: true }; },
      'ps.layer.list': function () { return { docId: active && active.id, layers: active ? active.layers.map(function (l) { return summary(l, 0); }) : [] }; },
      'ps.layer.place': place,
      'ps.layer.placeBatch': placeBatch,
      'ps.layer.placeClipped': place,
      // 10-25 任务卡「分割」给已传回的图层换蒙版：教程里不画蒙版，只回成功
      'ps.layer.applyMask': function (p) { return { ok: true, layerId: p && p.layerId, docId: p && p.docId }; },
      'ps.layer.putPixels': function (p) { return place({ imageBase64: '', targetDocId: p && p.docId }); },
      'ps.group.create': createGroup,
      'ps.group.addTo': function (p) { return { ok: true, groupId: p && p.groupId }; },
      'ps.group.soloOwned': soloOwned,
      'ps.group.showOwned': showOwned,
      'ps.layer.visibility': function (p) { return mutateLayer('visibility', p); },
      'ps.layer.opacity': function (p) { return mutateLayer('opacity', p); },
      'ps.layer.rename': function (p) { return mutateLayer('rename', p); },
      'ps.layer.delete': function (p) { return mutateLayer('delete', p); },
      'ps.layer.select': function (p) { return { ok: true, layerId: p && p.layerId }; },
      'ps.layer.solo': function (p) { var doc = active; var id = Number(p && p.layerId); doc.layers.forEach(function (l) { l.visible = l.id === id || l.kind === 'pixel' && l.name === '背景'; }); emit('layers', doc); return { ok: true }; },
      'soloLayer': function (p) { return ACTIONS['ps.layer.solo'](p); },
      'ps.layer.properties': function (p) { var l = active && layerById(active, p && p.layerId); return l ? summary(l, 0) : { ok: false }; },
      'ps.mask.applyStamp': function (p) { return applyMask(p, '抠像结果'); },
      'ps.mask.applyGroup': function (p) { return applyMask(p, '解析结果'); },
      'ps.matting.applyMask': function (p) { return applyMask(p, '抠像结果'); },
      'ps.mask.feather': function () { return { ok: true, feathered: true }; },
      'collapseAllGroups': function () { if (active) active.layers.forEach(function (l) { if (l.layers) l.open = false; }); emit('layers', active); return { ok: true }; },
      // 跳到某块并放大（任务卡双击缩略图那类）
      'ps.view.focusRegion': function (p) { var r = p && (p.rect || p.selection || p.region); if (r) emit('view', { rect: r }); return { ok: true, focused: !!r }; }
    };
    // 只读 / 跟画面无关的动作：回成功空结果就够教程用
    ['ps.returnProbe.snapshot', 'ps.returnProbe.run', 'ps.preset.prepare', 'ps.graphics.installPack', 'ps.graphics.listPacks', 'ps.doc.create', 'ps.doc.export',
      'ps.doc.exportCheckpoint', 'ps.regions.capture', 'ps.seam.review', 'ps.seam.focus', 'ps.seam.focusCandidate', 'ps.view.focusRegion', 'ps.assistant.viewState',
      'ps.assistant.applySelection', 'ps.assistant.selectShapes', 'ps.selection.ops', 'syncMarqueeAspect', 'importMarqueePresets', 'ps.marquee.sync', 'ps.marquee.import',
      'ps.layer.create', 'ps.layer.gotoMask', 'gotoLayerMask', 'conversationLayerVisibility', 'ps.group.stampProbe', 'ps.mask.magentaFix', 'ps.channel.list',
      'ps.channel.visibility', 'ps.seam.capture', 'ps.seam.apply'].forEach(function (name) {
      if (!ACTIONS[name]) ACTIONS[name] = function () { return { ok: true, tutorial: true }; };
    });

    async function run(action, params) {
      var fn = ACTIONS[action];
      if (!fn) { unknown.push(action); return { ok: true, tutorial: true, unknownAction: action }; }
      return await fn(params || {});
    }

    return {
      run: run,
      actions: function () { return Object.keys(ACTIONS); },
      unknown: function () { return unknown.slice(); },
      addDoc: addDoc,
      active: function () { return active; },
      docs: function () { return docs.slice(); },
      setSelection: setSelection,
      selection: function () { return selection; },
      layerById: function (id) { return active ? layerById(active, id) : null; },
      onChange: function (fn) { listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
    };
  }

  root.V7FakePS = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
