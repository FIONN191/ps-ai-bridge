// V8 链路验证桥的 Photoshop 原子操作。
// 这里复用 V6 已验证的 ps-io / ps-pixels 实现，不放业务判断、计费或密钥。
// ⚠ constants 是 2026-09-12 加的：placeClipped 要用 ElementPlacement.PLACEBEFORE
//   把新图层挪到目标正上方。漏了它整个文件 require 就会拿到 undefined，
//   到运行时才炸 —— UXP 里这种错误只会表现成"这个功能没反应"。
const { app, core, imaging, constants } = require('photoshop');
const uxp = require('uxp');
const { storage, host: uxpHost } = uxp;
const fs = storage.localFileSystem;
const psPixels = require('./vendor/ps-pixels.js');
const { createPSIOModule } = require('./vendor/ps-io.js');
const checkpointContract = require('./checkpoint-contract.js');
let returnLab = null;
function getReturnLab() {
  if (!returnLab) returnLab = require('./return-lab.js').createReturnLab({app,core,constants,uxp,psIo,images:require('./return-probe-images.js')});
  return returnLab;
}
let seamReview = null;
function getSeamReview() {
  if (!seamReview) seamReview = require('./seam-review.js').createSeamReview({app,core,imaging,constants});
  return seamReview;
}
let viewFocus = null;
function getViewFocus() {
  if (!viewFocus) viewFocus = require('./view-focus.js').createViewFocus({
    app, core, platform: uxpHost && uxpHost.platform,
    viewState: input => require('./assistant-view-state.js').createAssistantViewState({
      app, core, platform: uxpHost && uxpHost.platform
    })(input)
  });
  return viewFocus;
}
let creativeDocument = null;
let presetPreActions = null;
function preActions() {
  if (!presetPreActions) presetPreActions = require('./preset-preactions.js').createPresetPreActions({app, core, fs});
  return presetPreActions;
}

let settings = {
  autoFullCanvas: false,
  maxResolution: 2048,
  antiMode: 0,
  colorStable: false,
  returnFeather: false,
  returnFeatherShrinkPercent: 0,
  returnFeatherBlurPercent: 0,
  hostStorage: {}
};
let lastCapture = null;
let logSink = function() {};
let documentObserver = null;
let documentEventSink = function() {};
// ⚠⚠ UXP 的集合（app.documents / doc.layers / doc.channels …）【不是真数组】：
//   Array.prototype.map/slice/some.call(集合) 会把每一项都当成"不存在"跳过，得到一个全是空洞的数组
//   （JSON 出去就是 [null,null,…]）。2026-09-14 在 stampProbe 那里栽过一次（见下面 toArray 的注释），
//   2026-10-15 工具箱复测又抓到 6 处：列打开的文档返回 4 个 null、列图层/通道/组内图层同病。
//   规矩：集合转数组一律走这个函数。
function collectionToArray(coll) {
  const out = [];
  if (!coll) return out;
  try { for (const x of coll) { if (x) out.push(x); } } catch (_) {}
  if (!out.length) { try { for (let i = 0; i < coll.length; i++) { if (coll[i]) out.push(coll[i]); } } catch (_) {} }
  return out;
}
function observer() {
  if (!documentObserver) documentObserver = require('./document-events.js').createDocumentObserver({ app,
    sessionId: 'ps-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), emit: event => documentEventSink(event) });
  return documentObserver;
}
function setDocumentEventSink(fn) { documentEventSink = typeof fn === 'function' ? fn : function() {}; }
function observeDocuments() { return observer().snapshot(); }
// A legacy export can be invoked before the project observer is initialized;
// keep that path compatible and let the explicit notification listener report
// exports once the desktop has requested a document snapshot.
function notifyExport(docId, source) { if (documentObserver) documentObserver.exported(docId, source); }

function setLogSink(fn) { logSink = typeof fn === 'function' ? fn : function() {}; }
function log(message, level) {
  try { logSink(String(message), level || 'info'); } catch (_) {}
}
function error(code, message, raw) {
  const e = new Error(message || code);
  e.code = code;
  if (raw !== undefined) e.raw = raw;
  return e;
}

// Photoshop UXP collections are array-like. Adobe documents index access and
// length for Documents/Layers, but does not promise Array.prototype.find/map.
// Keep document and direct-layer traversal on the documented contract so the
// post-return grouping/solo path behaves the same in real UXP and Node tests.
function documentById(docId) {
  const documents = app && app.documents;
  if (!documents || !Number.isFinite(Number(documents.length))) return null;
  for (let index = 0; index < documents.length; index++) {
    const document = documents[index];
    if (document && Number(document.id) === Number(docId)) return document;
  }
  return null;
}
function collectionItems(collection) {
  const items = [];
  if (!collection || !Number.isFinite(Number(collection.length))) return items;
  for (let index = 0; index < collection.length; index++) {
    const item = collection[index];
    if (item) items.push(item);
  }
  return items;
}

// ═══ 出错时的文档现场 ═══════════════════════════════════════
//  2026-09-11 新增。以前 Photoshop 这边失败只回一句话，桌面板那边
//  除了"失败了"什么都不知道，每次都要让用户回去看文档是什么格式、
//  开没开图、选区还在不在 —— 这些 Photoshop 自己明明就知道。
//
//  ⚠ 全程不抛异常。这是在【别人已经出错的路径上】跑的，
//    再抛一次会把真正的错误盖掉，那比没有现场更糟。
//  ⚠ 只读，不进 executeAsModal。读属性不改状态，不占修改权。
async function captureScene() {
  const scene = {};
  try {
    const docs = app.documents;
    scene['打开的文档数'] = docs ? docs.length : 0;
  } catch (_) {}
  try {
    const doc = app.activeDocument;
    if (!doc) { scene['当前文档'] = '没有打开的文档'; return scene; }
    try { scene['当前文档'] = doc.name || '(未命名)'; } catch (_) {}
    try { scene['画布尺寸'] = Math.round(Number(doc.width) || 0) + '×' + Math.round(Number(doc.height) || 0); } catch (_) {}
    try { scene['位深'] = String(doc.bitsPerChannel || '未知') + ' 位'; } catch (_) {}
    try { scene['色彩模式'] = String(doc.mode || '未知'); } catch (_) {}
    try { scene['图层数'] = doc.layers ? doc.layers.length : 0; } catch (_) {}
    try {
      const layer = doc.activeLayers && doc.activeLayers[0];
      if (layer) scene['当前图层'] = layer.name || '(未命名)';
    } catch (_) {}
    // 选区状态。⚠ 没有选区时 PS 会抛，这里的 catch 就是"没有选区"的判定依据。
    try {
      const r = await app.batchPlay([{
        _obj: 'get',
        _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
      }], { synchronousExecution: false });
      const b = r && r[0] && r[0].selection;
      const rect = rectFromBounds(b);
      scene['选区'] = rect ? (Math.round(rect.width) + '×' + Math.round(rect.height)) : '没有选区';
    } catch (_) { scene['选区'] = '读不到（多半是没有选区）'; }
  } catch (_) {}
  return scene;
}
function cleanBase64(value) {
  const s = String(value || '');
  const comma = s.indexOf(',');
  return comma >= 0 ? s.slice(comma + 1) : s;
}
function valueOf(v) { return v && typeof v === 'object' && v._value !== undefined ? v._value : v; }
function rectFromBounds(b) {
  if (!b) return null;
  const left = Number(valueOf(b.left));
  const top = Number(valueOf(b.top));
  const right = Number(valueOf(b.right));
  const bottom = Number(valueOf(b.bottom));
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

const state = {
  getAutoSelectFullCanvasNoSelection: () => !!settings.autoFullCanvas,
  getMaxResolution: () => Number(settings.maxResolution) || 2048,
  setMaxResolution: value => { settings.maxResolution = Number(value) || settings.maxResolution; },
  getColorStable: () => !!settings.colorStable,
  getAntiTruncationMode: () => Number(settings.antiMode) || 0,
  setAntiTruncationMode: value => { settings.antiMode = Number(value) || 0; },
  getReturnFeatherEnabled: () => !!settings.returnFeather,
  getReturnFeatherShrinkPercent: () => Number(settings.returnFeatherShrinkPercent) || 0,
  getReturnFeatherBlurPercent: () => Number(settings.returnFeatherBlurPercent) || 0,
  getLastSelection: () => lastCapture && lastCapture.selection,
  getLastSelectionDocId: () => lastCapture && lastCapture.docId,
  getHostStorage: () => settings.hostStorage
};

const psIo = createPSIOModule({
  app, core, constants, imaging, fs, storage,
  logToPanel: log,
  sendToPanel: function() {},
  base64ToArrayBuffer: psPixels.base64ToArrayBuffer,
  arrayBufferToBase64: psPixels.arrayBufferToBase64,
  pixelsHueShift180: psPixels.pixelsHueShift180,
  pixelsFlipVertical: psPixels.pixelsFlipVertical,
  encodeJPEGFromRGB: psPixels.encodeJPEGFromRGB,
  encodePNGFromRGB: psPixels.encodePNGFromRGB,
  injectSRGBChunkIntoPNG: psPixels.injectSRGBChunkIntoPNG,
  shouldApplyReturnFeather: () => !!settings.returnFeather,
  state
});

async function docInfo() {
  const doc = app.activeDocument;
  if (!doc) return { hasDoc: false };
  let activeLayer = null;
  try {
    const layer = doc.activeLayers && doc.activeLayers[0];
    if (layer) activeLayer = { id: layer.id, name: layer.name || '', kind: layer.kind || '' };
  } catch (_) {}
  // 当前历史记录编号：画一笔、撤销、改显隐都会变。示波器实时轮询靠它判断「画面变没变」，
  //   没变就不读像素、不占用 PS（2026-09-29）。只读属性；取不到就给 null，调用方按「每隔几秒重读」兜底。
  let historyStateId = null;
  try {
    const state = doc.activeHistoryState;
    const id = state && Number(state.id);
    if (Number.isSafeInteger(id)) historyStateId = id;
  } catch (_) {}
  return {
    historyStateId,
    hasDoc: true,
    id: doc.id,
    name: doc.name || '',
    width: Number(doc.width) || 0,
    height: Number(doc.height) || 0,
    resolution: Number(doc.resolution) || 0,
    mode: String(doc.mode || ''),
    bitsPerChannel: String(doc.bitsPerChannel || ''),
    layerCount: doc.layers ? doc.layers.length : 0,
    activeLayer
  };
}

function layerSummary(layer, depth) {
  if (!layer || depth > 4) return null;
  const out = {
    id: layer.id,
    name: layer.name || '',
    kind: layer.kind || '',
    visible: layer.visible !== false,
    // ⚠ 2026-10-15：原来是 Number(opacity)||100 —— 合法的 0 会被读成 100（GPT 报告 A04）
    opacity: Number.isFinite(Number(layer.opacity)) && layer.opacity !== null && layer.opacity !== '' ? Number(layer.opacity) : 100,
    depth
  };
  try {
    if (layer.layers && layer.layers.length) {
      out.children = collectionToArray(layer.layers).slice(0, 100)
        .map(child => layerSummary(child, depth + 1)).filter(Boolean);
    }
  } catch (_) {}
  return out;
}

async function listLayers() {
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  return { docId: doc.id, layers: collectionToArray(doc.layers).map(l => layerSummary(l, 0)) };
}

async function listOpenDocs() {
  return { documents: observer().list() };
}

async function selectDocument(params) {
  const id = Number(params && (params.docId || params.id));
  if (!Number.isFinite(id)) throw error('INVALID_DOC_ID', '缺少文档 ID');
  await core.executeAsModal(async () => {
    await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: id }] }], {});
  }, { commandName: '选择文档' });
  return await docInfo();
}

async function restoreSelection(params) {
  const p = params || {};
  const selection = p.selection || (lastCapture && lastCapture.selection);
  if (!selection) throw error('NO_SELECTION_HISTORY', '没有可恢复的选区记录');
  const docId = p.docId || (lastCapture && lastCapture.docId);
  await core.executeAsModal(async () => {
    if (docId) await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: docId }] }], {});
    await app.batchPlay([{
      _obj: 'set',
      _target: [{ _ref: 'channel', _property: 'selection' }],
      to: { _obj: 'rectangle',
        top: { _unit: 'pixelsUnit', _value: selection.top },
        left: { _unit: 'pixelsUnit', _value: selection.left },
        bottom: { _unit: 'pixelsUnit', _value: selection.bottom },
        right: { _unit: 'pixelsUnit', _value: selection.right } }
    }], {});
  }, { commandName: '恢复选区' });
  return { restored: true, selection, docId: docId || null };
}

async function capture(params) {
  const p = params || {};
  const previousAnti = settings.antiMode;
  settings.autoFullCanvas = !!p.allowFullCanvas;
  if (p.maxResolution) settings.maxResolution = Number(p.maxResolution) || settings.maxResolution;
  // 抗截断模式属于本次抓图/任务快照，不能读取上一次任务残留的全局值。
  // 参考图和聊天抓图会在各自入口强制使用 0；主生成入口显式传入 0/1/2。
  settings.antiMode = Math.max(0, Math.min(2, Number(p.antiMode) || 0));
  const doc = app.activeDocument;
  try {
    if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
    const result = await psIo.getSelectionAndImage(null, {
      padToSquare: !!p.padToSquare
    });
    if (!result) {
      const detail = psIo.getSelectionAndImage.lastError || {};
      throw error(detail.code || 'NO_SELECTION', detail.message || '未检测到选区');
    }
    const info = await docInfo();
    const selection = result.selection || null;
    const sourceImageBase64 = result.originalBase64 || result.base64;
    const capturedAt = Date.now();
    const captureId = String(doc.id) + ':' + String(capturedAt);
    lastCapture = { imageBase64: result.base64, sourceImageBase64, selection, docId: doc.id, docName: doc.name || '', antiMode: settings.antiMode, capturedAt, captureId };
    return {
      imageBase64: result.base64,
      // antiMode=0 时两份 PNG 字节完全相同，不重复传输；UI 会回退到 imageBase64。
      sourceImageBase64: sourceImageBase64 !== result.base64 ? sourceImageBase64 : undefined,
      mime: 'image/png',
      // width/height 表示实际发送像素；selection 保存 Photoshop 原始坐标和尺寸。
      width: Number(result.pixelWidth) || (selection ? selection.width : 0),
      height: Number(result.pixelHeight) || (selection ? selection.height : 0),
      selection,
      docId: doc.id,
      docName: doc.name || '',
      docWidth: info.width,
      docHeight: info.height,
      pixelWidth: Number(result.pixelWidth) || (selection ? selection.width : 0),
      pixelHeight: Number(result.pixelHeight) || (selection ? selection.height : 0),
      selectionWidth: selection ? selection.width : 0,
      selectionHeight: selection ? selection.height : 0,
      hasSelection: !!selection,
      antiMode: settings.antiMode,
      capturedAt,
      captureId
    };
  } finally {
    settings.antiMode = previousAnti;
  }
}

// V6 选区流动作的明文适配层：复用同一套像素读取实现，
// 只补“抓取后取消选区”和聊天分辨率语义，不把业务状态带进 UXP。
async function captureRefImage(params) {
  const result = await capture(params || {});
  await psIo.deselectAll();
  return Object.assign({}, result, { deselected: true, purpose: 'reference' });
}

async function recaptureRefImage(params) {
  return await captureRefImage(params || {});
}

async function captureForChat(params) {
  const previousMax = settings.maxResolution;
  const previousAnti = settings.antiMode;
  try {
    settings.maxResolution = Number(params && params.maxResolution) || 1024;
    settings.antiMode = 0;
    const result = await capture(params || {});
    await psIo.deselectAll();
    return Object.assign({}, result, { deselected: true, purpose: 'chat' });
  } finally {
    settings.maxResolution = previousMax;
    settings.antiMode = previousAnti;
  }
}

async function clearSelection() {
  await psIo.deselectAll();
  return { cleared: true };
}

// ═══ 把图层并进【已存在的】组（2026-09-13）═══════════════
//
// ⭐ 为什么要这条：一个任务可以【分几次传回】（提前结束传一批、后台算完再传一批）。
//   每次都 ps.group.create 的话，同一个任务的图会散在三四个"轮椅-XXXX"组里，
//   用户根本没法管。第一次建组，之后一律并进去。
//
// ⚠ 用 ElementPlacement.PLACEINSIDE 把图层移进组，不是重新建组。
// ⚠ 组可能已经被用户删了/改名了 —— 找不到就如实报错，调用方会说明"图贴进去了只是没归组"。
async function groupAddTo(params) {
  const p = params || {};
  const groupId = p.groupId;
  const ids = Array.isArray(p.layerIds) ? p.layerIds.filter(x => x != null) : [];
  if (groupId == null) throw error('NO_GROUP', '没有给要并入的组');
  if (!ids.length) throw error('NO_LAYERS', '没有要并入的图层');
  const doc = p.docId != null
    ? documentById(p.docId)
    : app.activeDocument;
  if (!doc) throw error('SOURCE_DOCUMENT_CLOSED', '目标文档已关闭');
  const group = findLayerById(doc, groupId);
  if (!group) throw error('GROUP_GONE', '原来那个分组已经不在了（可能被删了）');

  let moved = 0;
  await core.executeAsModal(async () => {
    for (const id of ids) {
      const layer = findLayerById(doc, id);
      if (!layer) continue;                       // 这一张可能已被用户删掉，跳过别报错
      try { layer.move(group, constants.ElementPlacement.PLACEINSIDE); moved++; } catch (_) {}
    }
  }, { commandName: '并入原分组' });
  return { ok: true, groupId, moved, requested: ids.length };
}

// ═══ 贴回后的边缘羽化（2026-09-13 接线）═══════════════════
//
// ⭐ 治的是用户很早就反馈的那条【笔直的接缝】—— 选区边界上
//   "处理过 vs 没处理过"的硬分界线。对齐和校色都治不了它：
//   那不是位置问题也不是颜色问题，是【边界本身太硬】。
//   做法是给贴回的图层加一张蒙版：往里收一点 + 把蒙版边缘模糊掉，
//   让 AI 的图和周围原图渐变过渡。
//
// ⚠ 能力本来就在（`ps-io.js: applyReturnFeatherMaskToLayer`，V6 搬过来的），
//   只是一直没人调 —— 以前只有调试面板的 `ps.mask.feather` 会用到。
//
// ⚠⚠ 参数【按次传】，不走 settings 常驻状态：
//   桥这边没有"界面同步设置过来"的通道（settings 只有默认值），
//   靠常驻状态会变成"界面上调了没反应"的假开关（铁律 16）。
//   所以这里临时改 settings、用完立刻还原 —— 和 featherMask 同一套写法。
//
// ⚠ 羽化失败【绝不能让整批传回失败】：图已经贴进 PS 了，蒙版只是锦上添花。
async function applyFeatherToPlaced(feather, docId, entries) {
  const f = feather || null;
  if (!f || !f.enabled) return { feathered: 0 };
  const prev = {
    enabled: settings.returnFeather,
    shrink: settings.returnFeatherShrinkPercent,
    blur: settings.returnFeatherBlurPercent
  };
  let done = 0;
  try {
    settings.returnFeather = true;
    settings.returnFeatherShrinkPercent = Math.max(0, Math.min(50, Number(f.shrinkPercent) || 0));
    settings.returnFeatherBlurPercent = Math.max(0, Math.min(50, Number(f.blurPercent) || 0));
    for (const it of entries) {
      // ⚠ layerId 为 null = 这一张贴回失败了，位置是特意留空的，跳过别报错
      if (!it || it.layerId == null || !it.selection) continue;
      try {
        await psIo.applyReturnFeatherMaskToLayer(docId, it.layerId, it.selection, 'return');
        done++;
      } catch (e) {
        log('[羽化] 第 ' + (done + 1) + ' 张没加上蒙版: ' + ((e && e.message) || e), 'warn');
      }
    }
  } finally {
    settings.returnFeather = prev.enabled;
    settings.returnFeatherShrinkPercent = prev.shrink;
    settings.returnFeatherBlurPercent = prev.blur;
  }
  return { feathered: done };
}

async function place(params) {
  const p = params || {};
  const base64 = cleanBase64(p.imageBase64 || p.base64 || (lastCapture && lastCapture.imageBase64));
  if (!base64) throw error('NO_IMAGE', '没有可贴回的图片');
  const docId = p.targetDocId || p.docId || (p.strictTarget ? null : (lastCapture && lastCapture.docId));
  const selection = p.targetSelection || p.selection || (p.strictTarget ? null : (lastCapture && lastCapture.selection));
  if (p.strictTarget && (!docId || !selection)) throw error('SOURCE_SNAPSHOT_MISSING', '当前任务缺少 Photoshop 来源快照');
  const returnOptions = p.returnOptions && typeof p.returnOptions === 'object' ? { strategy: p.returnOptions.strategy, receipt: {}, historyName: p.returnOptions.historyName } : undefined;
  const layerId = await psIo.placeImageToSpecificDoc(base64, docId, selection, Number(p.antiMode) || 0, p.layerType || 'smartObject', returnOptions);
  const fr = await applyFeatherToPlaced(p.feather, docId, [{ layerId, selection }]);
  return { placed: true, layerId, docId: docId || null, selection: selection || null,
           layerType: p.layerType || 'smartObject', feathered: fr.feathered,
           ...(returnOptions ? { returnReceipt: returnOptions.receipt } : {}) };
}

async function placeBatch(params) {
  const p = params || {};
  const items = Array.isArray(p.items) ? p.items.map(item => ({
    base64: cleanBase64(item.imageBase64 || item.base64),
    selection: item.selection,
    antiMode: Number(item.antiMode) || 0,
    layerType: item.layerType || 'smartObject',
    // ⭐ 10-25 任务卡「分割」：这一张自带蒙版（10-26 起是游程编码的灰度像素，尺寸 = 贴回的选区，按选区左上角精确写进图层蒙版）
    mask: item.maskRle ? { rle: cleanBase64(item.maskRle), width: Number(item.maskWidth), height: Number(item.maskHeight) } : null
  })) : [];
  if (!items.length) throw error('NO_IMAGES', '没有可贴回的图片');
  const targetDocId = p.targetDocId || (p.strictTarget ? null : (lastCapture && lastCapture.docId));
  if (p.strictTarget && !targetDocId) throw error('SOURCE_DOCUMENT_CLOSED', '来源文档已关闭，无法传回');
  const exposeReturnReceipts = !!(p.returnOptions && typeof p.returnOptions === 'object');
  // Always retain item failures internally. A protected return may fail for
  // visibility/placement reasons even while its document remains open.
  const returnOptions = { strategy: exposeReturnReceipts ? p.returnOptions.strategy : undefined, receipts: [] };
  const layerIds = await psIo.placeImagesBatch(targetDocId, items, undefined, returnOptions);
  if (p.strictTarget && (!layerIds.length || layerIds.every(id => id == null))) {
    const firstFailure = returnOptions.receipts.find(row => row && row.error);
    const failed = error(firstFailure && firstFailure.error.code || 'RETURN_BATCH_FAILED', firstFailure && firstFailure.error.message || '回图没有完成，请核对 Photoshop 图层后再决定是否重试');
    failed.returnReceipts = returnOptions.receipts;
    throw failed;
  }
  // ⚠ layerIds 和 items 是【按发送顺序一一对应】的，失败的那张是 null 占位
  //   （见 ui.html autoGroupAfterTransfer 的注释：V6 特意 push(null) 保住位置）。
  //   所以这里可以直接按下标配对，不能先 filter 掉 null。
  // ⭐ 10-25（用户：「回传图层不受影响，附带一个蒙版…这种情况下，蒙版羽化功能就要相对来说避让一下」）：
  //   带了分割蒙版的那一张【不加边缘羽化】，改挂分割蒙版；别的照旧羽化。
  //   ⚠ 挂蒙版失败也不能让整批失败：图已经贴进去了，回执里如实带上 maskFailed，界面会说。
  const fr = await applyFeatherToPlaced(p.feather, targetDocId,
    layerIds.map((id, i) => ({ layerId: items[i] && items[i].mask ? null : id, selection: items[i] && items[i].selection })));
  let masked = 0;
  const maskFailed = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i].mask || layerIds[i] == null) continue;
    try {
      const sel = items[i].selection || {};
      await psIo.applyAlphaMaskToLayer({ docId: targetDocId, layerId: layerIds[i], maskRle: items[i].mask.rle, width: items[i].mask.width, height: items[i].mask.height, left: sel.left, top: sel.top });
      masked++;
    } catch (e) {
      maskFailed.push({ index: i, message: (e && e.message) || String(e) });
      log('[分割蒙版] 第 ' + (i + 1) + ' 张没挂上: ' + ((e && e.message) || e), 'warn');
    }
  }
  // ⚠ 没带蒙版时回执一个字段都不多（tests/uxp-return-production 钉着）
  return { placed: true, layerIds, docId: targetDocId || null, feathered: fr.feathered,
           ...(masked ? { masked } : {}), ...(maskFailed.length ? { maskFailed } : {}),
           ...(exposeReturnReceipts ? { returnReceipts: returnOptions.receipts } : {}) };
}

// ═══ 任务卡「分割」：给已经传回的那个图层换上分割蒙版（10-25）═══════
// ⚠ 先查图层还在不在：用户可能已经删了 / 合并了 —— 查不到就明说，别去碰别的图层。
async function layerApplyMask(params) {
  const p = params || {};
  const docId = p.docId || p.targetDocId;
  const mask = cleanBase64(p.maskRle);
  if (!mask) throw error('MASK_NO_ALPHA', '没有蒙版数据');
  if (!docId || !p.selection) throw error('SOURCE_SNAPSHOT_MISSING', '缺少文档或选区快照，没法对齐蒙版');
  if (p.layerId == null) throw error('NO_TARGET_LAYER', '不知道要给哪个图层挂蒙版');
  const doc = documentById(docId);
  if (!doc) throw error('SOURCE_DOCUMENT_CLOSED', '目标文档已关闭');
  if (!findLayerById(doc, p.layerId)) throw error('TARGET_LAYER_GONE', '传回的那个图层已经不在了（可能被删除或合并）');
  const r = await psIo.applyAlphaMaskToLayer({ docId, layerId: p.layerId, maskRle: mask, width: p.maskWidth, height: p.maskHeight, left: p.selection.left, top: p.selection.top });
  return { ok: true, layerId: r.layerId, docId };
}

// ═══ 眼神调整：一块 RGBA 像素按文档坐标精确贴成新图层（10-26，不走置入内核，不会偏 / 不会被缩放）═══
async function layerPutPixels(params) {
  const p = params || {};
  const docId = p.docId || p.targetDocId;
  if (!docId) throw error('SOURCE_SNAPSHOT_MISSING', '缺少目标文档');
  if (!documentById(docId)) throw error('SOURCE_DOCUMENT_CLOSED', '目标文档已关闭');
  const r = await psIo.placePixelsAsNewLayer({ docId, name: p.name, rgba: cleanBase64(p.rgba), width: p.width, height: p.height, left: p.left, top: p.top, layerType: p.layerType });
  return { placed: true, layerId: r.layerId, docId };
}

// ═══ 细节补偿的贴回：新图层 → 挪到目标正上方 → 剪切蒙版 ═══════
//
// ⭐ 做法照抄 V6 `tiles/tile-colormatch.host.js` 的 placeColormatchItems，
//   那是跑了很久的成熟实现，别自己重新发明。
//
// ⭐⭐ 为什么用剪切蒙版而不是"替换图层像素"：
//   **AI 那张图一个像素都不动。** 补偿结果是独立的一层盖在它上面，
//   用户在 PS 里点一下眼睛就能对比补偿前后，不想要就删掉这一层。
//   反过来"替换像素"是不可逆的，而且用户很可能已经给那张图加过
//   蒙版/调整/滤镜 —— 一替换就把他的活儿压没了。
//
// ⚠ V6 留的那道阀门必须照抄：**只有确实挪到目标正上方才建剪切蒙版**。
//   没挪成功还去剪切，会剪到下面随便哪一层上 —— 那是在破坏用户的图层。
async function placeClipped(params) {
  const p = params || {};
  const base64 = cleanBase64(p.imageBase64 || p.base64);
  if (!base64) throw error('NO_IMAGE', '没有可贴回的图片');
  const docId = p.targetDocId || p.docId;
  const selection = p.targetSelection || p.selection;
  if (!docId || !selection) throw error('SOURCE_SNAPSHOT_MISSING', '缺少文档或选区快照，无法贴回');
  const targetLayerId = p.targetLayerId;
  if (targetLayerId == null) throw error('NO_TARGET_LAYER', '不知道要嵌到哪一层上');

  const doc = documentById(docId);
  if (!doc) throw error('SOURCE_DOCUMENT_CLOSED', '目标文档已关闭');
  // ⚠ 先确认目标图层还在 —— 用户可能已经把那张 AI 图删了。
  //   不先查的话会白贴一层孤零零的图上去，比直接失败更糟。
  if (!findLayerById(doc, targetLayerId)) {
    throw error('TARGET_LAYER_GONE', '要嵌入的那张 AI 图已经不在了（可能被删除或合并）');
  }

  const layerId = await psIo.placeImageToSpecificDoc(
    base64, docId, selection, 0, p.layerType || 'smartObject');
  if (!layerId) throw error('PLACE_FAILED', '贴回失败');

  let moved = false, clipped = false, blendApplied = false, modalError = '';
  // ⭐ 2026-10-20（docs/250 第 12 条，测试用户报「点替换之后实际已经成功，但弹未成功」）：
  //   图在上面那句已经贴上了；下面「挪位 / 剪切 / 混合模式」整段原来没接住 —— PS 正忙（用户在用画笔、自由变换、
  //   或者插件醒来那一刻 PS 处在别的模态里）时 executeAsModal 本身就抛，整件事被报成「贴回失败」。
  //   改成：失败等 300ms 再试一次；还不行就【不抛】，回 placed:true + clipped:false + modalError（调用方会说「贴上了，没嵌进去」）。
  const arrange = () => core.executeAsModal(async () => {
    const d = documentById(docId) || app.activeDocument;
    const newLayer = findLayerById(d, layerId);
    const target = findLayerById(d, targetLayerId);
    if (!newLayer) return;
    if (p.name) { try { newLayer.name = String(p.name); } catch (_) {} }
    // 挪到目标正上方。目标在组里的话，这一步会让新层跟着进同一个组。
    if (target) {
      try { newLayer.move(target, constants.ElementPlacement.PLACEBEFORE); moved = true; } catch (_) {}
    }
    // ⚠ moved 为真才剪切 —— 见函数头的说明，这道闸不能省
    if (moved) {
      try {
        await app.batchPlay([
          { _obj: 'select', _target: [{ _ref: 'layer', _id: layerId }], makeVisible: false },
          { _obj: 'groupEvent', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }
        ], {});
        clipped = true;
      } catch (_) {}
    }
    // ⭐⭐ 2026-10-05（docs/143 §八）：设混合模式 —— 补细节的「增量层」靠【线性光】复现引擎公式
    //   （result = base + 2×(本层 − 128)，推导见引擎 detail_layer）。
    //   ⚠ 幂等：每次贴都重设一遍，不判断"有没有设过"。
    //   ⚠ 设失败【不抛】—— 图已经贴上去了；抛出去会把"贴成功但模式没设上"报成"贴回失败"，
    //     用户会以为整件事没成。调用方拿 blendApplied:false 自己决定怎么提示。
    if (p.blendMode) {
      try {
        await app.batchPlay([{
          _obj: 'set',
          _target: [{ _ref: 'layer', _id: layerId }, { _ref: 'document', _id: docId }],
          to: { mode: { _enum: 'blendMode', _value: String(p.blendMode) } }
        }], {});
        blendApplied = true;
      } catch (_) {}
    }
  }, { commandName: '细节补偿图层就位' });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await arrange(); modalError = ''; break; }
    catch (e) {
      modalError = String(e && e.message || e).slice(0, 200);
      if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  // 边缘羽化：和正常贴回走同一个函数，接缝处理保持一致。
  // ⚠ 羽化失败不能让整件事失败 —— 图已经贴上去了。
  let feathered = false;
  if (p.featherKey) {
    try {
      await psIo.applyReturnFeatherMaskToLayer(docId, layerId, selection, p.featherKey);
      feathered = true;
    } catch (_) {}
  }
  return { placed: true, layerId, docId, targetLayerId, moved, clipped, feathered, blendApplied, modalError: modalError || undefined };
}

async function createLayer(params) {
  const name = String(params && params.name || '链路验证图层');
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  let id = null;
  await core.executeAsModal(async () => {
    const result = await app.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name } }], {});
    id = result && result[0] && result[0].layerID;
  }, { commandName: '新建图层' });
  return { created: true, id, name };
}

async function mutateLayer(action, params) {
  const p = params || {};
  const id = p.layerId || p.id;
  const target = id ? [{ _ref: 'layer', _id: id }] : [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }];
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  let result = null;
  await core.executeAsModal(async () => {
    if (action === 'rename') {
      result = await app.batchPlay([{ _obj: 'set', _target: target, to: { _obj: 'layer', name: String(p.name || '未命名图层') } }], {});
    } else if (action === 'visibility') {
      // ⚠ 2026-10-15：原来是 set layer {visible} —— Photoshop 回成功但什么都不做（工具箱复测实测）。用 show/hide（同 soloLayer）。
      result = await app.batchPlay([{ _obj: p.visible !== false ? 'show' : 'hide', null: target }], {});
    } else if (action === 'opacity') {
      const opacity = Math.max(0, Math.min(100, Number(p.opacity)));
      result = await app.batchPlay([{ _obj: 'set', _target: target, to: { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: opacity } } }], {});
    } else if (action === 'delete') {
      result = await app.batchPlay([{ _obj: 'delete', _target: target }], {});
    } else if (action === 'select') {
      result = await app.batchPlay([{ _obj: 'select', _target: target, makeVisible: false }], {});
    } else {
      throw error('UNSUPPORTED_LAYER_ACTION', '不支持的图层动作: ' + action);
    }
  }, { commandName: '图层' + action });
  return { action, layerId: id || null, success: true, result: result || null };
}

async function soloLayer(params) {
  const p = params || {};
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  const activeId = p.layerId || p.layerID || (doc.activeLayers && doc.activeLayers[0] && doc.activeLayers[0].id);
  const owned = Array.isArray(p.ownedLayerIds) ? p.ownedLayerIds : (Array.isArray(p.ownedLayerIDs) ? p.ownedLayerIDs : []);
  const layerIds = owned.length ? owned : collectionToArray(doc.layers).map(layer => layer.id);
  if (!activeId) throw error('NO_LAYER', '没有可独显的图层');
  await core.executeAsModal(async () => {
    const ops = [{ _obj: 'show', null: [{ _ref: 'layer', _id: Number(activeId) }] }];
    for (const id of layerIds) {
      if (String(id) === String(activeId)) continue;
      ops.push({ _obj: 'hide', null: [{ _ref: 'layer', _id: Number(id) }] });
    }
    await app.batchPlay(ops, {});
    await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: Number(activeId) }], makeVisible: false }], {});
  }, { commandName: '独显图层' });
  return { solo: true, layerId: activeId || null, ownedLayerIds: layerIds };
}

async function conversationLayerVisibility(params) {
  const p = params || {};
  const mode = p.mode === 'restore' ? 'restore' : p.mode === 'solo' ? 'solo' : '';
  if (!mode) throw error('INVALID_MODE', '图层联动 mode 必须是 solo 或 restore');
  const owned = (Array.isArray(p.ownedLayerIds) ? p.ownedLayerIds : p.ownedLayerIDs || [])
    .map(Number).filter(Number.isFinite);
  const soloId = Number(p.soloLayerId != null ? p.soloLayerId : p.soloLayerID);
  if (mode === 'solo' && (!Number.isFinite(soloId) || owned.indexOf(soloId) < 0)) {
    throw error('INVALID_SOLO_LAYER', 'soloLayerID 必须属于 ownedLayerIDs');
  }
  if (!owned.length) return { mode, applied: [], failed: [] };
  const docId = p.docId;
  await core.executeAsModal(async () => {
    if (docId != null) await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: Number(docId) }] }], {});
    const ops = [];
    for (const id of owned) {
      if (mode === 'restore' || id === soloId) ops.push({ _obj: 'show', null: [{ _ref: 'layer', _id: id }] });
      else ops.push({ _obj: 'hide', null: [{ _ref: 'layer', _id: id }] });
    }
    await app.batchPlay(ops, {});
    if (mode === 'solo') {
      await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: soloId }], makeVisible: false }], {});
      // V6 会把目标图层的父组逐层展开/显示，否则 show 子图层仍可能不可见。
      try {
        const active = app.activeDocument && app.activeDocument.activeLayers && app.activeDocument.activeLayers[0];
        let parent = active && active.parent;
        let hops = 0;
        while (parent && parent !== app.activeDocument && hops < 10) {
          try { parent.visible = true; } catch (_) {}
          parent = parent.parent;
          hops++;
        }
      } catch (_) {}
    }
  }, { commandName: '对话气泡 · 图层联动' });
  return { mode, applied: owned, failed: [] };
}

// 按 ID 递归找图层(组里面还可能套组)
function findLayerById(container, id) {
  const list = (container && container.layers) || [];
  for (let index = 0; index < (Number(list.length) || 0); index++) {
    const layer = list[index];
    if (!layer) continue;
    if (Number(layer.id) === Number(id)) return layer;
    // Photoshop ordinary layers do not promise a readable `layers` child
    // collection. Only recurse after confirming the Layer is a group; this
    // prevents a pixel-layer getter from aborting a later group lookup.
    let kind = null;
    try { kind = layer.kind; } catch (_) {}
    const groupKind = constants && constants.LayerKind && constants.LayerKind.GROUP;
    const isGroup = (groupKind != null && kind === groupKind) || String(kind || '').toLowerCase() === 'group';
    if (!isGroup) continue;
    let children = null;
    try { children = layer.layers; } catch (_) { continue; }
    const hit = findLayerById({ layers: children }, id);
    if (hit) return hit;
  }
  return null;
}

// 读当前缩放百分比。只用来在日志里对比"缩放前/后"，读不到就是 null，不影响功能。
function readDocZoom(doc) {
  try {
    const zoom = Number(doc && doc.zoom);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : null;
  } catch (_) { return null; }
}

// 把选中图层还原成 ids 这一批。ids 为空 = 原来一个图层都没选。
// currentId 是临时选中的那个图层，原来就只选了它的话什么都不用做。
async function restoreActiveLayers(ids, currentId) {
  if (ids.length === 1 && ids[0] === currentId) return;
  if (!ids.length) {
    await app.batchPlay([{ _obj: 'selectNoLayers', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
    return;
  }
  // 第一个替换选中，其余逐个加选(等同按住 Ctrl 点)
  await app.batchPlay(ids.map((id, index) => Object.assign(
    { _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false },
    index ? { selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' } } : {}
  )), {});
}

// ═══ 组内单显(V8 新增，不改 V6 的 conversationLayerVisibility) ═══
// 只在【指定组的直接子图层】里做显隐，组外的一切绝不碰。
//
// ⚠ 为什么要用"组"当边界而不是只信传进来的图层 ID：
//   V6 的置入函数是靠"置入完选中的是谁"来返回图层 ID 的
//   (ps-io.js: return app.activeDocument.activeLayers[0].id)，这是个脆弱的假设。
//   文档里图层一多就可能返回别人的图层 —— 那我们就会去改用户自己/V6 的组。
//   所以这里再加一道物理边界：ownedLayerIds ∩ 组的实际成员，交集之外一律不动。
//
// ⚠ 父组链【不往上走】。V6 的做法是一路把祖先组全点亮，那会改到用户自己的组。
//   这里只保证我们自己这个组可见，到此为止 —— 宁可不生效，也不动用户的东西。
async function groupSoloOwned(params) {
  const p = params || {};
  const docId = p.docId != null ? Number(p.docId) : null;
  const groupId = p.groupId != null ? Number(p.groupId) : null;
  const soloId = Number(p.soloLayerId != null ? p.soloLayerId : p.soloLayerID);
  const owned = (Array.isArray(p.ownedLayerIds) ? p.ownedLayerIds : [])
    .map(Number).filter(Number.isFinite);
  const allowSwitchDoc = p.allowSwitchDocument !== false;   // 默认允许切文档
  const focusRegion = p.focusRegion === true;               // 是否聚焦到图层位置

  if (!Number.isFinite(soloId) || !owned.length) {
    return { ok: false, reason: 'NO_TARGET', applied: [] };
  }
  const doc = docId != null ? documentById(docId) : app.activeDocument;
  if (!doc) return { ok: false, reason: 'DOCUMENT_CLOSED', applied: [] };

  // 目标不是当前文档：按开关决定切过去还是干脆不做。
  // ⚠ 不切又硬做的话，是在用户看不见的文档里改东西，比什么都不做更糟。
  const isActive = app.activeDocument && app.activeDocument.id === doc.id;
  if (!isActive && !allowSwitchDoc) {
    return { ok: false, reason: 'NOT_ACTIVE_DOCUMENT', applied: [] };
  }

  let applied = [];
  let reason = '';
  await core.executeAsModal(async () => {
    if (!isActive) {
      await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
    }
    // ⭐ 确定边界容器。⚠ 【绝不能因为拿不到 groupId 就整个不干】——
    //   2026-09-09 就是这么把功能改坏的: V6 的 createGroupAndMask 没有 return，
    //   groupId 永远是 undefined，于是每次都直接退出、联动完全失效。
    //   拿不到组就退而求其次: 用【目标图层自己的父容器】当边界。
    //   父容器是组 → 边界就是那个组; 图层在顶层 → 边界是文档顶层。
    //   不管哪种，后面都还要和 ownedLayerIds 求交集，越不出我们自己那批图层。
    let container = groupId != null ? findLayerById(doc, groupId) : null;
    if (!container || !container.layers) {
      const solo = findLayerById(doc, soloId);
      if (!solo) { reason = 'SOLO_LAYER_MISSING'; return; }
      container = (solo.parent && solo.parent.layers) ? solo.parent : doc;
    }

    // ⭐ 物理边界：只认这个容器的直接子图层
    const members = new Set(collectionItems(container.layers).map(l => Number(l.id)));
    const targets = owned.filter(id => members.has(id));
    if (!targets.length || !members.has(soloId)) { reason = 'SOLO_NOT_IN_CONTAINER'; return; }

    const ops = targets.map(id => ({
      _obj: id === soloId ? 'show' : 'hide',
      null: [{ _ref: 'layer', _id: id }]
    }));
    await app.batchPlay(ops, {});
    // 只点亮边界容器本身，【不再往上走父组链】——
    // V6 那套会一路点到顶，会改到用户自己建的组。
    try { if (container !== doc) container.visible = true; } catch (_) {}
    applied = targets;

    // ⭐ 聚焦到图层位置（2026-09-28 新增，2026-09-29 重写）
    // 等同 PS 菜单「视图 > 按屏幕大小缩放图层」：把选中的图层缩放到填满窗口并居中。
    // ⚠ 2026-09-29 真 PS 2026(27.7)实测：doc.activeView 根本不存在(viewExists:false)。
    //   旧写法照 Illustrator 的 view.zoom / centerPoint 猜的，在 PS 里从来没动过。
    //   别再去 DOM 上找"视图对象"。
    //   fitLayersOnScreen 是从 PS 本体的菜单项名单里查到的(和 fitArtboardOnScreen 同一排)。
    // ⚠ 这个菜单只对【选中的图层】生效，所以要临时选中目标层；
    //   做完必须把用户原来选中的图层还回去 —— 不然用户回 PS 一下笔就画错层。
    if (focusRegion) {
      const focusLog = { step: 'start', data: { method: 'fitLayersOnScreen' } };
      let prevActive = null;
      try {
        focusLog.data.zoomBefore = readDocZoom(doc);
        focusLog.step = 'remember-selection';
        prevActive = collectionItems(doc.activeLayers).map(l => Number(l.id)).filter(Number.isFinite);
        focusLog.data.prevActive = prevActive;
        focusLog.step = 'select-solo';
        await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: soloId }], makeVisible: false }], {});
        focusLog.step = 'fit-layers-on-screen';
        const fit = await app.batchPlay([{
          _obj: 'select',
          _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: 'fitLayersOnScreen' }],
          _options: { dialogOptions: 'dontDisplay' }
        }], {});
        // batchPlay 失败时多半不抛异常，而是回一个 {_obj:'error'}，要自己看
        const first = fit && fit[0];
        focusLog.data.fitResult = first;
        focusLog.data.zoomAfter = readDocZoom(doc);
        focusLog.step = first && first._obj === 'error' ? 'fit-rejected' : 'complete';
      } catch (e) {
        focusLog.error = { at: focusLog.step, message: (e && e.message) || String(e), number: e && e.number };
        focusLog.step = 'error';
      }
      // 选中状态不管成败都要还原
      if (prevActive) {
        try {
          await restoreActiveLayers(prevActive, soloId);
          focusLog.data.restored = true;
        } catch (e) {
          focusLog.data.restored = false;
          focusLog.data.restoreError = (e && e.message) || String(e);
        }
      }
      // 日志塞进 applied 带回界面，调试卡片里的「聚焦探针」会把它打出来
      applied.push({ _focusLog: focusLog });
    }
  }, { commandName: '组内单显' });

  return { ok: applied.length > 0, reason, applied, groupId };
}

// ═══ 组内全部显示（2026-09-29 新增）═══
// groupSoloOwned 的反操作：把【我们自己组里】的这批图层全部点亮。
// 用在 AI 修图痕迹检测的「显示全部」—— 点过某一条痕迹后组里只剩它，这里一键还原。
// 边界规则和 groupSoloOwned 完全一样：只认 groupId 这个组的直接子图层 ∩ ownedLayerIds，组外一律不碰。
async function groupShowOwned(params) {
  const p = params || {};
  const docId = p.docId != null ? Number(p.docId) : null;
  const groupId = p.groupId != null ? Number(p.groupId) : null;
  const owned = (Array.isArray(p.ownedLayerIds) ? p.ownedLayerIds : [])
    .map(Number).filter(Number.isFinite);
  if (groupId == null || !owned.length) return { ok: false, reason: 'NO_TARGET', applied: [] };
  const doc = docId != null ? documentById(docId) : app.activeDocument;
  if (!doc) return { ok: false, reason: 'DOCUMENT_CLOSED', applied: [] };
  const isActive = app.activeDocument && app.activeDocument.id === doc.id;
  if (!isActive && p.allowSwitchDocument === false) return { ok: false, reason: 'NOT_ACTIVE_DOCUMENT', applied: [] };

  let applied = [];
  let reason = '';
  await core.executeAsModal(async () => {
    if (!isActive) await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
    const container = findLayerById(doc, groupId);
    if (!container || !container.layers) { reason = 'GROUP_MISSING'; return; }
    const members = new Set(collectionItems(container.layers).map(l => Number(l.id)));
    const targets = owned.filter(id => members.has(id));
    if (!targets.length) { reason = 'NOTHING_IN_GROUP'; return; }
    await app.batchPlay(targets.map(id => ({ _obj: 'show', null: [{ _ref: 'layer', _id: id }] })), {});
    try { container.visible = true; } catch (_) {}
    applied = targets;
  }, { commandName: '组内全部显示' });
  return { ok: applied.length > 0, reason, applied, groupId };
}

// ═══ 盖印探针(2026-09-14 新增，只读) ═══
// 用途：给 UI 判断"传回组的上方有没有多出一个盖印层"。
//
// ⚠⚠ 这个 action 【只读】。不进 executeAsModal，不改任何东西 ——
//   它会被界面每隔两秒调一次，一旦它有副作用，就是每两秒动一次用户的文档。
//   以后要加功能：另开一个 action，不要往这里塞写操作。
//
// ⚠ 判定【不在这里做】。这里只报事实(谁在谁上面、是什么类型)，
//   "算不算盖印"由 UI 决定。理由：判定规则一定会调(误判/漏判都要改)，
//   而改 UI 不用重装 UXP 插件，改这里要。所以规则放 UI，事实放这里。
async function groupStampProbe(params) {
  const p = params || {};
  const ids = (Array.isArray(p.groupIds) ? p.groupIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) throw error('NO_GROUP_IDS', '没有要检查的组 ID');
  const doc = p.docId != null ? documentById(p.docId) : app.activeDocument;
  if (!doc) return { ok: false, reason: 'DOCUMENT_CLOSED', docId: null, groups: [] };
  // ⚠ 只在【当前文档】上报。别的文档里的组虽然找得到，但用户看不见它 ——
  //   在看不见的地方判"用户盖印了"是没有依据的。UI 那边也会再挡一道。
  const activeId = app.activeDocument ? app.activeDocument.id : null;

  // ⚠⚠ UXP 的图层集合(doc.layers / group.layers / doc.activeLayers)【不是真数组】。
  //   2026-09-14 实测：Array.prototype.slice.call(集合) 转出来是一个带【空洞】的数组 ——
  //   后面 findIndex 一碰到空洞就读 undefined.id，整个探针炸掉
  //   ("Cannot read properties of undefined (reading 'id')")。
  //   这里统一走索引读取；不要依赖集合自带的 .map/findIndex，避免真实 UXP
  //   集合与 Node 数组的行为差异。
  //   规矩：集合转数组一律走这个函数，别再 slice.call。
  const toArray = (coll) => {
    const out = [];
    if (!coll) return out;
    try { for (const x of coll) { if (x) out.push(x); } } catch (_) {}
    if (!out.length) { try { for (let i = 0; i < coll.length; i++) { if (coll[i]) out.push(coll[i]); } } catch (_) {} }
    return out;
  };

  // ⚠ 读单个图层的名字 / 类型出错时只把这一项留空，不让整个探针失败（2026-10-21）。
  //   线上 1.9.3/1.9.5 有 5 台报「Cannot read properties of undefined (reading 'batchPlay')」——
  //   本文件没有这种写法，推测是 PS 自己读某个图层属性时内部出错（图层刚被删 / 合并之类），未真机复现。
  const readSafe = (fn) => { try { const v = fn(); return v == null ? '' : v; } catch (_) { return ''; } };

  // 取一个图层的兄弟列表(它父容器的直接子图层)。顶层图层的父就是文档。
  const siblingsOf = (layer) => {
    const parent = (layer && layer.parent && layer.parent.layers) ? layer.parent : doc;
    return { parent, list: toArray(parent.layers) };
  };

  const groups = ids.map(gid => {
    let group = null;
    try { group = findLayerById(doc, gid); } catch (_) {}
    if (!group) return { groupId: gid, found: false };
    let sib;
    try { sib = siblingsOf(group); } catch (_) { return { groupId: gid, found: true, siblingsFailed: true }; }
    const list = sib.list;
    const at = list.findIndex(l => Number(l.id) === Number(gid));
    // 只报组附近的一小段。整份图层树可能上千层，全报一遍纯属浪费带宽 ——
    // 盖印层就贴在组旁边，看 8 个足够。
    const from = Math.max(0, at - 8), to = Math.min(list.length, at + 9);
    const near = list.slice(from, to).map((l, k) => {
      let hasChildren = null;
      try { hasChildren = l.layers ? l.layers.length > 0 : null; } catch (_) {}
      return {
        index: from + k,
        id: Number(l.id),
        name: readSafe(() => l.name),
        // ⚠ kind 原样透出，【不在这里翻译】。UXP 到底给什么字符串我们没实测过，
        //   在这里做映射就等于把猜测写死；UI 会把它打进日志，对着真值校准。
        kind: readSafe(() => l.kind),
        hasChildren: hasChildren
      };
    });
    // ⭐ 组【里面】有哪些图层(2026-09-14 排查用)。
    //   盖印时如果选中的是组里的某一张图，盖印层会落在【组内部】，
    //   而判定只看组旁边 —— 不报组内成员，用户就看不出"盖印落错地方了"。
    let children = [];
    try {
      children = toArray(group.layers).slice(0, 60)
        .map(l => ({ id: Number(l.id), name: readSafe(() => l.name), kind: readSafe(() => l.kind) }));
    } catch (_) {}
    return {
      groupId: gid, found: true,
      groupIndex: at,
      siblingCount: list.length,
      // ⭐ 同层【全部】图层 ID。基线要用它 ——
      //   只存上面那个 near 窗口是不够的：组的位置会变(用户拖动/新增图层)，
      //   窗口一挪，原本一直在那儿的老图层就会显得"是新的"→ 误判成盖印。
      //   全量 ID 只是一串数字，几千层也才几十 KB，比误判便宜得多。
      siblingIds: list.map(l => Number(l.id)),
      children: children,
      // parentIsDoc: 组在顶层(不是嵌在别的组里)。UI 暂时不用，留给排查。
      parentIsDoc: sib.parent === doc,
      near: near
    };
  });
  // 当前选中的图层。排查用：盖印层永远插在【选中项】的正上方，
  // 知道选中的是谁，就能解释"盖印为什么落在了那个位置"。
  let activeLayerIds = [];
  try { activeLayerIds = toArray(doc.activeLayers).map(l => Number(l.id)); } catch (_) {}
  return { ok: true, docId: doc.id, isActiveDocument: activeId === doc.id, activeLayerIds, groups };
}

async function gotoLayerMask(params) {
  const p = params || {};
  const layerId = Number(p.layerId != null ? p.layerId : p.layerID);
  if (!Number.isFinite(layerId)) throw error('NO_LAYER_ID', '缺少图层 ID');
  await core.executeAsModal(async () => {
    if (p.docId != null) await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: Number(p.docId) }] }], {});
    if (!app.activeDocument) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
    await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: layerId }], makeVisible: false }], {});
    // 选择 mask 通道会让蒙版缩略图成为活动绘画目标；没有蒙版时保留原始 PS 错误。
    await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }], makeVisible: false }], {});
  }, { commandName: '选择图层蒙版' });
  return { selected: true, layerId, maskSelected: true };
}

async function collapseAllGroups() {
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  await core.executeAsModal(async () => { await app.batchPlay([{ _obj: 'collapseAllGroupsEvent' }], {}); }, { commandName: '折叠所有图层组' });
  return { collapsed: true, docId: doc.id };
}

// 按名字前缀找组（遍历写法照 findLayerById：按下标、先确认是组再往里找 —— PS 的图层集合不是数组，没有 .find）
function findGroupByNamePrefix(container, prefix) {
  const list = (container && container.layers) || [];
  for (let index = 0; index < (Number(list.length) || 0); index++) {
    const layer = list[index];
    if (!layer) continue;
    let kind = null;
    try { kind = layer.kind; } catch (_) {}
    const groupKind = constants && constants.LayerKind && constants.LayerKind.GROUP;
    const isGroup = (groupKind != null && kind === groupKind) || String(kind || '').toLowerCase() === 'group';
    if (!isGroup) continue;
    if (String(layer.name || '').indexOf(prefix) === 0) return layer;
    let children = null;
    try { children = layer.layers; } catch (_) { continue; }
    const hit = findGroupByNamePrefix({ layers: children }, prefix);
    if (hit) return hit;
  }
  return null;
}

async function createGroup(params) {
  const p = params || {};
  const ids = Array.isArray(p.layerIds) ? p.layerIds : [];
  if (!ids.length) throw error('NO_LAYER_IDS', '没有提供要编组的图层');
  let groupId = null;
  const prefix = p.groupName || '链路验证组';
  // ⭐ 2026-10-20（docs/250 第 9 条，测试用户报「三并发时遇到一次打组失败，单图时也遇到过一次」）：
  //   ① 原来不切文档 —— createGroupAndMask 只认【当前激活的文档】：中途切了文档、几单同时在不同文档上跑时，
  //      就在错的文档里找这些图层 ⇒ 建组失败或建错地方。软件现在会带上贴图那个文档的 docId，先切过去再建。
  //   ② 原来找回组用 app.activeDocument.layers.find(...) —— 图层集合不是数组、没有 .find，一调就抛、被吞掉 ⇒
  //      组建了却拿不到 groupId（后面的组内单显 / 盖印收起全靠它）。而且只找最外层，贴图本来在组里时新组是套在里面的。
  const docId = p.docId || p.targetDocId || null;
  if (docId && !documentById(docId)) throw error('SOURCE_DOCUMENT_CLOSED', '要编组的那个文档已经关掉了');
  await core.executeAsModal(async () => {
    if (docId) await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: Number(docId) }] }], {});
    await psIo.createGroupAndMask(ids, prefix, p.maskOptions || {});
    // ⚠ V6 的 createGroupAndMask【没有 return 语句】，永远给 undefined —— 组要自己按名字找回来
    //   （组名带随机串，V6 内部会拼成 "<前缀> 生成组"，所以按前缀匹配）。
    try {
      const doc = (docId && documentById(docId)) || app.activeDocument;
      const hit = findGroupByNamePrefix(doc, prefix);
      if (hit) groupId = hit.id;
    } catch (_) {}
  }, { commandName: '创建编组和蒙版' });
  return { created: true, groupId, docId: docId || undefined };
}

async function featherMask(params) {
  const p = params || {};
  const info = await docInfo();
  const layerId = p.layerId || (info.activeLayer && info.activeLayer.id);
  const selection = p.selection || (lastCapture && lastCapture.selection);
  if (!layerId) throw error('NO_LAYER', '没有可应用蒙版的图层');
  if (!selection) throw error('NO_SELECTION', '没有可用于羽化蒙版的选区');
  const previous = {
    enabled: settings.returnFeather,
    shrink: settings.returnFeatherShrinkPercent,
    blur: settings.returnFeatherBlurPercent
  };
  try {
    // 这是一个显式控制 action，不能受正式工作流开关关闭影响。
    settings.returnFeather = true;
    settings.returnFeatherShrinkPercent = Number(p.shrinkPercent) || 0;
    settings.returnFeatherBlurPercent = Number(p.blurPercent) || 0;
    await psIo.applyReturnFeatherMaskToLayer(p.docId || info.id, layerId, selection, p.workflowKey || 'link-validation');
    return { applied: true, layerId, docId: p.docId || info.id, shrinkPercent: settings.returnFeatherShrinkPercent, blurPercent: settings.returnFeatherBlurPercent };
  } finally {
    settings.returnFeather = previous.enabled;
    settings.returnFeatherShrinkPercent = previous.shrink;
    settings.returnFeatherBlurPercent = previous.blur;
  }
}

async function channelList() {
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  return { channels: collectionToArray(doc.channels).map(c => ({ id: c.id, name: c.name || '', kind: c.kind || '', visible: c.visible !== false })) };
}

async function channelVisibility(params) {
  const p = params || {};
  const channels = app.activeDocument && app.activeDocument.channels;
  const channel = channels ? collectionToArray(channels).find(c => String(c.id) === String(p.channelId || p.id)) : null;
  if (!channel) throw error('NO_CHANNEL', '找不到目标通道');
  await core.executeAsModal(async () => { channel.visible = p.visible !== false; }, { commandName: '通道可见性' });
  return { channelId: channel.id, visible: channel.visible !== false };
}

async function exportDocument(params) {
  const p = params || {};
  const rawPath = String(p.path || '');
  if (!rawPath) throw error('NO_EXPORT_PATH', '导出测试需要提供本地文件路径');
  const doc = app.activeDocument;
  if (!doc) throw error('NO_DOCUMENT', '没有打开的 Photoshop 文档');
  let url, format;
  try { url = checkpointContract.fileUrl(rawPath); format = checkpointContract.exportFormat(rawPath); }
  catch (e) { throw error(e.message, '导出路径或格式无效；支持 PNG、JPG、PSD、PSB、BMP 和 GIF'); }
  if (!doc.saveAs || typeof doc.saveAs[format] !== 'function') throw error('EXPORT_FORMAT_UNSUPPORTED', '当前 Photoshop 不支持指定的导出格式：' + format);
  let file;
  try { file = await fs.getEntryWithUrl(url); }
  catch (readError) {
    if (typeof fs.createEntryWithUrl !== 'function' || !storage.types) throw error('EXPORT_PATH_UNAVAILABLE', '目标文件不存在且无法创建，请检查导出目录');
    try { file = await fs.createEntryWithUrl(url, { type: storage.types.file, overwrite: false }); }
    catch (e) { throw error('EXPORT_PATH_UNAVAILABLE', '无法创建导出文件：' + (e.message || e)); }
  }
  await core.executeAsModal(async () => { await doc.saveAs[format](file, {}, true); }, { commandName: '导出文档' });
  notifyExport(doc.id, 'ps.doc.export');
  return { exported: true, path: url, format, docId: doc.id };
}

// Checkpoint export is deliberately separate from the legacy ps.doc.export
// action.  The legacy action is a user-directed test/export path; this action
// has a strict PNG contract and always exports the whole canvas as a copy,
// leaving the Photoshop document and its layers untouched.
async function exportCheckpoint(params) {
  const p = params || {};
  if (Number(p.expiresAt) > 0 && Date.now() > Number(p.expiresAt)) {
    throw error('CHECKPOINT_TIMEOUT', '检查点请求已过期，请在下一次生成时重试');
  }
  let url;
  try { url = checkpointContract.validateCheckpointPath(p.path); }
  catch (e) { throw error(e.message, '检查点导出路径无效：' + e.message); }
  const file = await fs.getEntryWithUrl(url);
  const requestedDocId = p.docId == null || p.docId === '' ? null : Number(p.docId);
  const doc = requestedDocId == null
    ? app.activeDocument
    : documentById(requestedDocId);
  if (!doc) throw error(requestedDocId == null ? 'NO_DOCUMENT' : 'SOURCE_DOCUMENT_CLOSED', '检查点对应的 Photoshop 文档不存在');
  const startedAt = Date.now();
  if (!doc.saveAs || typeof doc.saveAs.png !== 'function' || !constants.PNGMethod || !constants.PNGMethod.QUICK) {
    throw error('CHECKPOINT_PNG_UNSUPPORTED', '当前 Photoshop 不支持无压缩 PNG 检查点导出');
  }
  const options = checkpointContract.createPngSaveOptions(constants.PNGMethod.QUICK);
  await core.executeAsModal(async () => {
    // asCopy=true is required: exporting a PNG must never change the source
    // document's format, dirty state, or layer structure.
    await doc.saveAs.png(file, options, true);
  }, { commandName: '保存五分钟检查点' });
  let sizeBytes = 0;
  try { const metadata = await file.getMetadata(); sizeBytes = Math.max(0, Number(metadata && metadata.size) || 0); }
  catch (e) { throw error('CHECKPOINT_EXPORT_INVALID', '检查点保存后无法核实文件大小：' + (e.message || e)); }
  if (!sizeBytes) throw error('CHECKPOINT_EXPORT_INVALID', '检查点 PNG 文件为空，保存没有完成');
  return {
    exported: true,
    checkpoint: true,
    path: url,
    docId: doc.id,
    docName: doc.name || '',
    width: Math.round(Number(doc.width) || 0),
    height: Math.round(Number(doc.height) || 0),
    mime: 'image/png',
    // The native PNG encoder receives QUICK / compression 0. No resize,
    // selection crop, anti-truncation transform or generation input is used.
    lossless: true,
    compression: 0,
    sizeBytes,
    durationMs: Date.now() - startedAt
  };
}

async function marqueeSync(params) { return await psIo.setMarqueeAspectPreset(params && params.aspect); }
async function marqueeImport() { return await psIo.importMarqueePresets(); }
async function magentaFix(params) {
  let applied = false;
  await core.executeAsModal(async () => {
    await psIo.applyMagentaFixCurveToGroup(params && params.groupName);
    applied = true;
  }, { commandName: '应用修复曲线' });
  return { applied };
}

async function selectionOps(params) {
  const operation = String(params && (params.operation || params.op) || '').toLowerCase();
  if (operation === 'clear' || operation === 'none' || operation === 'deselect') return await clearSelection();
  if (operation === 'restore') return await restoreSelection(params);
  if (operation === 'all') {
    await core.executeAsModal(async () => {
      await app.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'allEnum' } }], {});
    }, { commandName: '全选' });
    return { selectedAll: true };
  }
  throw error('UNSUPPORTED_SELECTION_OPERATION', '不支持的选区操作: ' + operation);
}

// ── 盖印 + 蒙版(2026-09-14 晚, 用户定的新贴回方式) ─────────────
//
//   老路: 引擎回一张 RGBA 透明图 → ps.layer.place 贴成智能对象
//   新路: 引擎只回 alpha(RGB 全黑) → 盖印当前画面 + 把 alpha 做成图层蒙版
//
//   好处见 vendor/ps-io.js 里 stampAndApplyMask 上面那段注释。
//   ⚠ 这两个动作是【抠像 / 语义分割 / SAM2 三个功能共用】的,
//     改的时候记得三边都会受影响。
// ─────────────────────────────────────────────────────────────

// 抠像 / SAM2: 一张 alpha → 盖印一层 + 挂一个蒙版
async function applyMaskStamp(params) {
  const p = params || {};
  const alpha = cleanBase64(p.alphaBase64 || p.imageBase64 || p.base64);
  if (!alpha) throw error('NO_ALPHA', '没有蒙版数据(alphaBase64 是空的)');
  const docId = p.docId || p.targetDocId || (p.strictTarget ? null : (lastCapture && lastCapture.docId));
  const selection = p.selection || p.targetSelection || (p.strictTarget ? null : (lastCapture && lastCapture.selection));
  if (!docId) throw error('SOURCE_SNAPSHOT_MISSING', '不知道要盖印到哪个文档(缺 docId)');
  const r = await psIo.stampAndApplyMask({
    docId, alphaBase64: alpha, selection,
    layerName: p.layerName || '抠像'
  });
  return { applied: true, layerId: r.layerId, layerName: r.layerName,
           docId, selection: selection || null };
}

// 语义分割: N 个部位 → 盖印一层转智能对象 → 复制 N 份各挂一个部位蒙版 → 装进一个组
// ⚠ 单个部位失败不砸整批(ps-io 里跳过继续), 所以返回值里 count 可能小于 requested ——
//   调用方必须比对这两个数并告诉用户, 不然就是静默少做(铁律 17)。
async function applyMaskGroup(params) {
  const p = params || {};
  const rawParts = Array.isArray(p.parts) ? p.parts : [];
  const parts = rawParts
    .map(x => ({ name: String((x && x.name) || ''), alphaBase64: cleanBase64(x && (x.alphaBase64 || x.base64)) }))
    .filter(x => x.alphaBase64);
  if (!parts.length) throw error('NO_PARTS', '一个部位都没给, 没东西可以做成蒙版');
  const docId = p.docId || p.targetDocId || (p.strictTarget ? null : (lastCapture && lastCapture.docId));
  const selection = p.selection || p.targetSelection || (p.strictTarget ? null : (lastCapture && lastCapture.selection));
  if (!docId) throw error('SOURCE_SNAPSHOT_MISSING', '不知道要盖印到哪个文档(缺 docId)');
  const r = await psIo.stampAndApplyMaskGroup({
    docId, selection,
    groupName: p.groupName || '人体解析',
    parts
  });
  return { applied: true, groupName: r.groupName, layerIds: r.layerIds, names: r.names,
           count: r.layerIds.length, requested: parts.length,
           docId, selection: selection || null };
}

const ACTIONS = {
  'ps.preset.prepare': params => preActions().prepare(params),
  'ps.graphics.installPack': params => preActions().installPack(params),
  'ps.graphics.listPacks': params => preActions().listPacks(params),
  'ps.doc.info': docInfo,
  'ps.doc.listOpen': listOpenDocs,
  'ps.doc.create': params => {
    if (!creativeDocument) creativeDocument = require('./creative-document.js').createDocumentAction({app,core,constants});
    return creativeDocument(params);
  },
  'ps.doc.select': selectDocument,
  'ps.doc.export': exportDocument,
  'ps.doc.exportCheckpoint': exportCheckpoint,
  // ⭐ 记录与恢复卡（2026-09-30）：给记录卡抓一张「整画布」小图当项目条封面。
  //   复用 createAssistantCapture —— 它本来就是【只读、整画布、缩小、出 JPEG】，
  //   正好是这里要的；它内部不碰选区，不存在"为了做缩略图去动用户选区"的风险。
  //
  //   ⚠⚠ 必须包 executeAsModal：这台 PS 上 imaging.getPixels 也要求在保护区里
  //     （不进就报 "only allowed from inside a modal scope"）。包在【登记处】而不是
  //     createAssistantCapture 内部 —— 助手看图那边是它自己在保护区里调的，
  //     里面再包一层就成保护区套保护区（见上面 ps.regions.capture 那段）。
  //   ⚠ 长边写死 512（记录卡封面就 200px 宽）。上限由 assistant-capture 的 MAX_EDGE 再夹一道。
  //   ⚠ return 里只挑记录卡要的字段：不带 focus/viewport —— 记录卡不关心视口，白让桥的消息变大。
  'ps.doc.canvasThumb': params => core.executeAsModal(
    () => require('./assistant-capture.js').createAssistantCapture({ app, imaging, log,
      viewState: input => require('./assistant-view-state.js').createAssistantViewState({ app, core, platform: uxpHost && uxpHost.platform })(input)
    })(Object.assign({}, params || {}, { maxEdge: 512 })).then(shot => ({
      docId: shot.docId, docName: shot.docName,
      width: shot.width, height: shot.height,
      docWidth: shot.docWidth, docHeight: shot.docHeight,
      base64: shot.imageBase64, mime: shot.mime,
      capturedAt: shot.capturedAt, durationMs: shot.durationMs
    })),
    { commandName: '读取整画布缩略图' }
  ),
  'ps.selection.rect': async () => await psIo.probeSelectionRect(),
  'ps.selection.capture': capture,
  // ⚠⚠ 读像素（imaging.getPixels）在用户这台 PS 上【也必须】进 executeAsModal，不只是改图才要 ——
  //   不进就报 "The requested functionality is only allowed from inside a modal scope"。
  //   09-27 痕迹检测抓图栽过一次（docs/81），09-29 示波器 / DLSS / 分块拼接 / 批处理共用的这条又栽一次。
  //   包在登记处而不是 createRegionCapture 里面：痕迹检测是在它自己的保护区里直接调 createRegionCapture 的，
  //   里面再包一层就成了保护区套保护区。
  'ps.regions.capture': params => core.executeAsModal(
    () => require('./region-capture.js').createRegionCapture({ app, imaging })(params),
    { commandName: '读取画布像素' }
  ),
  'ps.seam.capture': params => getSeamReview().capture(params),
  'ps.seam.apply': params => getSeamReview().apply(params),
  // Read-only viewport navigation for a previously detected candidate.  This
  // never replaces ps.seam.apply and never changes pixels, layers or selection.
  'ps.seam.focus': params => getViewFocus().focus(params),
  'ps.seam.focusCandidate': params => getViewFocus().focus(params),
  'ps.view.focusRegion': params => getViewFocus().focus(params),
  'ps.seam.review': () => { throw error('SEAM_UPGRADE_REQUIRED','请从新版桌面剪影卡运行 AI 修图痕迹检测，并 Reload 联动插件'); },
  'ps.selection.captureRef': captureRefImage,
  'ps.selection.recaptureRef': recaptureRefImage,
  'ps.selection.captureForChat': captureForChat,
  // ⚠⚠ 2026-10-17 修（用户在夏三六里发「你好」报 "only allowed from inside a modal scope"）：
  //   这条【原来没包】executeAsModal —— 上面记录卡那条注释说「助手看图那边是它自己在保护区里调的」，实际没有。
  //   助手发消息前会自动抓整画布，抓图一失败整条消息都发不出去。照记录卡那条，包在登记处。
  'ps.assistant.capture': params => core.executeAsModal(
    () => require('./assistant-capture.js').createAssistantCapture({app,imaging,log,
      viewState: input => require('./assistant-view-state.js').createAssistantViewState({app,core,platform:uxpHost && uxpHost.platform})(input)})(params),
    { commandName: '助手读取整画布（只读）' }
  ),
  'ps.assistant.viewState': params => require('./assistant-view-state.js').createAssistantViewState({app,core,platform:uxpHost && uxpHost.platform})(params),
  'ps.assistant.applySelection': async params => require('./assistant-selection.js').createApplySelection({app,core})(params),
  // 夏三六按自己量的原图坐标建选区（只建选区、建完回读核对；2026-10-17）
  'ps.assistant.selectShapes': async params => require('./assistant-selection.js').createSelectShapes({app,core})(params),
  'ps.selection.restore': restoreSelection,
  'ps.selection.clear': clearSelection,
  'ps.selection.ops': selectionOps,
  // V6 action names kept as explicit aliases so migration tests can exercise
  // the same PS operation without teaching the UI about legacy transport.
  'captureRefImage': captureRefImage,
  'recaptureRefImage': recaptureRefImage,
  'captureForChat': captureForChat,
  'restoreSelectionFromHistory': restoreSelection,
  'probeSelectionRect': async () => await psIo.probeSelectionRect(),
  'syncMarqueeAspect': marqueeSync,
  'importMarqueePresets': marqueeImport,
  'getDocInfo': docInfo,
  'fetchOpenDocs': listOpenDocs,
  'listDocuments': listOpenDocs,
  'activateDocument': selectDocument,
  'ps.marquee.sync': marqueeSync,
  'ps.marquee.import': marqueeImport,
  'ps.layer.list': listLayers,
  'ps.layer.select': async p => mutateLayer('select', p),
  'ps.layer.create': createLayer,
  'ps.layer.rename': async p => mutateLayer('rename', p),
  'ps.layer.delete': async p => mutateLayer('delete', p),
  'ps.layer.visibility': async p => mutateLayer('visibility', p),
  'ps.layer.opacity': async p => mutateLayer('opacity', p),
  'ps.layer.solo': soloLayer,
  'ps.layer.gotoMask': gotoLayerMask,
  'gotoLayerMask': gotoLayerMask,
  'soloLayer': soloLayer,
  'conversationLayerVisibility': conversationLayerVisibility,
  'collapseAllGroups': collapseAllGroups,
  'ps.layer.place': place,
  'ps.returnProbe.snapshot': params => getReturnLab().snapshot(params),
  'ps.returnProbe.run': params => getReturnLab().run(params),
  'ps.layer.properties': params => require('./layer-properties.js').createLayerProperties({ app, core })(params),
  'ps.layer.placeBatch': placeBatch,
  'ps.layer.applyMask': layerApplyMask,
  'ps.layer.putPixels': layerPutPixels,
  'ps.layer.placeClipped': placeClipped,
  'ps.group.addTo': groupAddTo,
  'ps.group.create': createGroup,
  'ps.group.soloOwned': groupSoloOwned,
  'ps.group.showOwned': groupShowOwned,
  'ps.group.stampProbe': groupStampProbe,
  'ps.mask.feather': featherMask,
  'ps.mask.magentaFix': magentaFix,
  // 盖印+蒙版(抠像 / SAM2 / 语义分割 三个功能共用)
  'ps.mask.applyStamp': applyMaskStamp,
  'ps.mask.applyGroup': applyMaskGroup,
  // ⚠ 别名: docs/47 4.0 里写的是这个名字, 留着免得文档和代码对不上
  'ps.matting.applyMask': applyMaskStamp,
  'ps.channel.list': channelList,
  'ps.channel.visibility': channelVisibility
};

function listActions() {
  return Object.keys(ACTIONS).sort().map(name => ({ name, available: true }));
}

async function run(action, params) {
  const fn = ACTIONS[action];
  if (!fn) throw error('UNKNOWN_ACTION', 'UXP 未注册 action: ' + action);
  try {
    return await fn(params || {});
  } catch (e) {
    // ⭐ 任何 action 失败都补一份文档现场再往上抛(2026-09-11)。
    //   钉在这一个地方，就不用去 40 多个 action 里逐个加 —— 逐个加必然漏。
    //   ⚠ 补现场本身绝不能失败：出错路径上再抛一次会把真错误盖掉。
    try { if (e && !e.scene) e.scene = await captureScene(); } catch (_) {}
    throw e;
  }
}

module.exports = { setLogSink, setDocumentEventSink, observeDocuments, notifyExport, run, listActions, error };
