'use strict';

// Local, single-image Photoshop diagnostics. This module has no capture cache,
// account state, generation service, undo, or layer deletion path.
const STRATEGIES = ['legacy', 'restore', 'anchor'];
const IMAGE_KINDS = ['transparent-frame', 'corner-marks', 'opaque-reference'];
const LAYER_TYPES = ['smartObject', 'pixel'];
const LIMITATIONS = [
  'effectiveVisible 只由图层自身和祖先组的 visible 计算，不表示该图层的像素一定出现在最终画面。',
  '本诊断不能仅凭图层树判定像素遮挡、透明度、蒙版、混合模式或 Photoshop 内部独显（solo）状态。',
  '阶段快照只能定位首次观察到变化的检查点，不能证明两个检查点之间没有短暂变化。',
  '回图目标范围固定为调用时的画布或选区；等待 modal 期间的变化单独报告，不归因于置入操作。',
  '最终 after 快照在回图调用返回后读取；操作归因以 modal 内检查点为准，调用返回后的变化单独报告。',
  '诊断不自动删除回图层、不自动撤销。需要恢复时请检查 Photoshop 历史记录并使用撤销；失败后不要直接重复运行。'
];

function failure(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}
function errorField(error, key) {
  try { return error == null ? undefined : error[key]; }
  catch (_) { return '[无法读取 ' + key + ']'; }
}
function safeText(value) {
  try { return String(value); } catch (_) { return '[无法转换为文字]'; }
}
// Error descriptors may contain host objects, cycles or throwing getters. Copy
// their evidence into plain JSON data without invoking host toJSON methods.
function jsonSafe(value, ancestors = new Set(), depth = 0) {
  if (value == null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : safeText(value);
  if (type !== 'object') return safeText(value);
  if (ancestors.has(value)) return '[循环引用]';
  if (depth >= 10) return '[达到诊断序列化深度上限]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, 200);
      const result = [];
      for (let i = 0; i < length; i++) result.push(jsonSafe(errorField(value, i), ancestors, depth + 1));
      if (value.length > length) result.push('[其余 ' + (value.length - length) + ' 项未展开]');
      return result;
    }
    const result = {};
    let keys;
    try { keys = Object.keys(value); }
    catch (_) { return '[无法枚举宿主对象]'; }
    if (value instanceof Error) keys = [...new Set(['name', 'message', ...keys])];
    for (const key of keys.slice(0, 200)) Object.defineProperty(result, key, {
      value: jsonSafe(errorField(value, key), ancestors, depth + 1), enumerable: true, writable: true, configurable: true
    });
    if (keys.length > 200) result.serializationNotice = '其余 ' + (keys.length - 200) + ' 个字段未展开';
    return result;
  } catch (_) { return '[无法序列化宿主对象]'; }
  finally { ancestors.delete(value); }
}
function errorInfo(error) {
  const result = { code: safeText(errorField(error, 'code') || 'RETURN_LAB_FAILED'), message: safeText(errorField(error, 'message') || error) };
  const stage = errorField(error, 'returnStage') || errorField(error, 'stage');
  if (stage) result.stage = String(stage);
  for (const field of ['details', 'returnDetails', 'raw', 'result', 'cleanupError']) {
    const value = errorField(error, field);
    if (value !== undefined) result[field] = jsonSafe(value);
  }
  return result;
}
function read(object, key, context) {
  try { return object[key]; }
  catch (error) {
    const field = context + '.' + String(key);
    throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法完整读取 Photoshop 状态：' + field,
      { field, cause: String(error && error.message || error) });
  }
}
function identifier(value, context, code = 'RETURN_LAB_SNAPSHOT_FAILED') {
  const number = Number(value);
  if (value == null || value === '' || typeof value === 'boolean' || !Number.isSafeInteger(number) || number < 1)
    throw failure(code, context + '不是有效编号');
  return number;
}
function numeric(value, context) {
  const raw = value && typeof value === 'object' && value._value !== undefined ? value._value : value;
  const number = Number(raw);
  if (raw == null || raw === '' || typeof raw === 'boolean' || !Number.isFinite(number))
    throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法读取有效数值：' + context);
  return number;
}
function scalar(value, context) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))
    throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法读取完整属性：' + context);
  return value;
}
function bool(value, context) {
  if (typeof value !== 'boolean') throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法读取布尔状态：' + context);
  return value;
}
function text(value, context) {
  if (typeof value !== 'string') throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法读取名称：' + context);
  return value;
}
function collection(value, context) {
  if (!value) throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法读取集合：' + context);
  const length = read(value, 'length', context);
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
    throw failure('RETURN_LAB_SNAPSHOT_FAILED', '集合长度无效：' + context);
  const iterator = read(value, Symbol.iterator, context);
  const result = [];
  try {
    if (typeof iterator === 'function') {
      for (const item of value) {
        if (!item) throw new Error('集合包含缺失条目');
        result.push(item);
      }
    } else {
      if (length === undefined) throw new Error('集合既不可迭代也没有可靠长度');
      for (let index = 0; index < length; index++) {
        const item = value[index];
        if (!item) throw new Error('集合条目缺失：' + index);
        result.push(item);
      }
    }
    if (length !== undefined && (result.length !== length || read(value, 'length', context) !== length))
      throw new Error('集合读取不完整或读取期间发生变化');
  } catch (error) {
    if (error && error.code) throw error;
    throw failure('RETURN_LAB_SNAPSHOT_FAILED', '无法完整读取集合：' + context,
      { field: context, cause: String(error && error.message || error) });
  }
  return result;
}
function parameters(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw failure('RETURN_LAB_PARAMS', '诊断参数必须是对象');
  return value;
}
function requestedId(params) {
  const docId = params.docId == null ? null : identifier(params.docId, 'docId', 'RETURN_LAB_PARAMS');
  const targetId = params.targetDocId == null ? null : identifier(params.targetDocId, 'targetDocId', 'RETURN_LAB_PARAMS');
  if (docId !== null && targetId !== null && docId !== targetId)
    throw failure('RETURN_LAB_PARAMS', 'docId 与 targetDocId 不一致，未执行诊断');
  return targetId === null ? docId : targetId;
}
function sameIds(left, right) { return left.length === right.length && left.every((id, index) => id === right[index]); }
function compare(before, after) {
  if (!before || !after || !before.complete || !after.complete || before.docId !== after.docId) return null;
  const old = new Map(before.layers.map(layer => [layer.id, layer]));
  const current = new Map(after.layers.map(layer => [layer.id, layer]));
  const added = after.layers.filter(layer => !old.has(layer.id));
  const removed = before.layers.filter(layer => !current.has(layer.id));
  const visibilityChanged = [], parentChanged = [], effectiveVisibilityChanged = [], ancestorChanged = [], otherChanged = [];
  for (const previous of before.layers) {
    const next = current.get(previous.id);
    if (!next) continue;
    const change = (field, output) => {
      if (previous[field] !== next[field]) output.push({ id: previous.id, name: previous.name, before: previous[field], after: next[field] });
    };
    change('visible', visibilityChanged);
    change('parentId', parentChanged);
    change('effectiveVisible', effectiveVisibilityChanged);
    if (!sameIds(previous.ancestorIds, next.ancestorIds))
      ancestorChanged.push({ id: previous.id, name: previous.name, before: previous.ancestorIds, after: next.ancestorIds });
    for (const field of ['name', 'kind', 'isBackgroundLayer', 'locked']) {
      if (previous[field] !== next[field]) otherChanged.push({ id: previous.id, name: previous.name, field, before: previous[field], after: next[field] });
    }
  }
  const originalLayersChanged = [removed, visibilityChanged, parentChanged, effectiveVisibilityChanged, ancestorChanged, otherChanged].some(rows => rows.length > 0);
  const documentChanged = [];
  for (const field of ['name', 'width', 'height', 'resolution', 'mode', 'bitsPerChannel']) {
    if (before.document[field] !== after.document[field]) documentChanged.push({ field, before: before.document[field], after: after.document[field] });
  }
  const activeLayerIdsChanged = !sameIds(before.activeLayerIds, after.activeLayerIds);
  const activeDocumentIdChanged = before.activeDocumentId !== after.activeDocumentId;
  return { complete: true, added, removed, visibilityChanged, parentChanged, effectiveVisibilityChanged, ancestorChanged, otherChanged,
    originalLayersChanged, documentChanged, activeLayerIdsChanged, activeDocumentIdChanged,
    anyChanged: originalLayersChanged || added.length > 0 || documentChanged.length > 0 || activeLayerIdsChanged || activeDocumentIdChanged,
    activeDocumentId: { before: before.activeDocumentId, after: after.activeDocumentId },
    activeLayerIds: { before: before.activeLayerIds, after: after.activeLayerIds } };
}

function createReturnLab({ app, core, psIo, images, constants, uxp } = {}) {
  if (!app || !core || !psIo || typeof psIo.placeImageToSpecificDoc !== 'function' || !images)
    throw failure('RETURN_LAB_DEPENDENCIES', '回图诊断依赖尚未就绪');

  function hostInfo() {
    const host = { photoshopVersion: null, uxpVersion: null, unavailableFields: [] };
    const uxpVersions = (() => {
      try { return uxp && uxp.versions; } catch (_) { return null; }
    })();
    for (const [source, key, field] of [[app, 'version', 'photoshopVersion'], [uxpVersions, 'uxp', 'uxpVersion']]) {
      try {
        const value = source && source[key];
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) host[field] = String(value);
        else host.unavailableFields.push(field);
      } catch (_) { host.unavailableFields.push(field); }
    }
    return host;
  }
  function isGroup(kind, context) {
    const groupKind = constants && constants.LayerKind && constants.LayerKind.GROUP;
    if (groupKind != null) return kind === groupKind;
    if (typeof kind === 'string') return kind.toLowerCase() === 'group';
    throw failure('RETURN_LAB_SNAPSHOT_FAILED', '缺少图层类型常量，无法可靠判断子图层集合：' + context);
  }

  function activeId() {
    const active = read(app, 'activeDocument', 'app');
    return active == null ? null : identifier(read(active, 'id', 'activeDocument'), '活动文档 ID');
  }
  function bind(params) {
    const explicit = requestedId(params);
    const id = explicit === null ? activeId() : explicit;
    if (id === null) throw failure('NO_DOCUMENT', '请先在 Photoshop 打开需要诊断的文档');
    return id;
  }
  function documentById(id) {
    const matches = collection(read(app, 'documents', 'app'), 'app.documents').filter(doc =>
      identifier(read(doc, 'id', 'document'), '文档 ID') === id);
    if (matches.length !== 1) throw failure('SOURCE_DOCUMENT_CLOSED', '绑定的 Photoshop 文档已关闭或无法唯一识别', { docId: id });
    return matches[0];
  }
  function capture(id, suppliedDocument) {
    const doc = suppliedDocument || documentById(id);
    if (identifier(read(doc, 'id', 'document'), '文档 ID') !== id)
      throw failure('RETURN_LAB_DOCUMENT_MISMATCH', '检查点文档不是实验绑定文档', { docId: id });
    const name = text(read(doc, 'name', 'document'), 'document.name');
    const width = numeric(read(doc, 'width', 'document'), 'document.width');
    const height = numeric(read(doc, 'height', 'document'), 'document.height');
    if (width <= 0 || height <= 0) throw failure('RETURN_LAB_SNAPSHOT_FAILED', 'Photoshop 画布尺寸无效');
    const document = { id, name, width, height }, unavailableFields = [];
    for (const field of ['resolution', 'mode', 'bitsPerChannel']) {
      const value = read(doc, field, 'document');
      if (value == null) { document[field] = null; unavailableFields.push('document.' + field); }
      else document[field] = field === 'resolution' ? numeric(value, 'document.' + field) : scalar(value, 'document.' + field);
    }
    const layers = [], seen = new Set();
    const roots = collection(read(doc, 'layers', 'document'), 'document.layers');
    function visit(items, parentId, ancestorIds, ancestorsVisible) {
      for (const layer of items) {
        const layerId = identifier(read(layer, 'id', 'layer'), '图层 ID');
        if (seen.has(layerId)) throw failure('RETURN_LAB_SNAPSHOT_FAILED', '图层树包含重复 ID 或循环', { layerId });
        seen.add(layerId);
        const context = 'layer[' + layerId + ']';
        const visible = bool(read(layer, 'visible', context), context + '.visible');
        const kind = scalar(read(layer, 'kind', context), context + '.kind');
        const row = { id: layerId, name: text(read(layer, 'name', context), context + '.name'), parentId,
          ancestorIds: ancestorIds.slice(), visible, effectiveVisible: ancestorsVisible && visible, kind,
          isBackgroundLayer: bool(read(layer, 'isBackgroundLayer', context), context + '.isBackgroundLayer'),
          locked: bool(read(layer, 'locked', context), context + '.locked') };
        layers.push(row);
        if (isGroup(kind, context)) {
          const childCollection = read(layer, 'layers', context);
          if (childCollection == null) throw failure('RETURN_LAB_SNAPSHOT_FAILED', '图层组的子集合不可读取', { layerId });
          visit(collection(childCollection, context + '.layers'), layerId, [...ancestorIds, layerId], row.effectiveVisible);
        }
      }
    }
    visit(roots, null, [], true);
    const activeLayerIds = collection(read(doc, 'activeLayers', 'document'), 'document.activeLayers').map(layer =>
      identifier(read(layer, 'id', 'activeLayer'), '活动图层 ID'));
    if (new Set(activeLayerIds).size !== activeLayerIds.length || activeLayerIds.some(layerId => !seen.has(layerId)))
      throw failure('RETURN_LAB_SNAPSHOT_FAILED', '活动图层不在完整图层树内，状态读取不一致');
    const activeDocumentId = activeId();
    return { ok: true, complete: true, docId: id, host: hostInfo(), document, activeDocumentId, isActiveDocument: activeDocumentId === id,
      activeLayerIds, rootLayerIds: roots.map(layer => identifier(read(layer, 'id', 'rootLayer'), '根图层 ID')),
      layers, layerCount: layers.length, unavailableFields, limitations: LIMITATIONS.slice() };
  }
  async function snapshot(params = {}) {
    const input = parameters(params);
    const id = bind(input);
    return capture(id);
  }
  function validateRun(params) {
    requestedId(params);
    if (!STRATEGIES.includes(params.strategy)) throw failure('RETURN_LAB_PARAMS', 'strategy 必须是 legacy、restore 或 anchor');
    if (!IMAGE_KINDS.includes(params.imageKind)) throw failure('RETURN_LAB_PARAMS', 'imageKind 必须是预置诊断图片');
    if (!['canvas', 'selection'].includes(params.target)) throw failure('RETURN_LAB_PARAMS', 'target 必须是 canvas 或 selection');
    const layerType = params.layerType === undefined ? 'smartObject' : params.layerType;
    if (!LAYER_TYPES.includes(layerType)) throw failure('RETURN_LAB_PARAMS', 'layerType 必须是 smartObject 或 pixel');
    const image = images[params.imageKind];
    if (!image || typeof image.base64 !== 'string' || !image.base64 || image.width !== 256 || image.height !== 256)
      throw failure('RETURN_LAB_IMAGE_INVALID', '256×256 诊断图片不可用');
    return { strategy: params.strategy, imageKind: params.imageKind, layerType, target: params.target, image };
  }
  function targetBounds(doc, target, before) {
    if (target === 'canvas') return { left: 0, top: 0, right: before.document.width, bottom: before.document.height, width: before.document.width, height: before.document.height };
    let bounds;
    try { bounds = doc.selection && doc.selection.bounds; }
    catch (error) { throw failure('RETURN_LAB_SELECTION_READ_FAILED', '无法读取当前选区，未执行回图诊断', { cause: String(error && error.message || error) }); }
    if (!bounds) throw failure('NO_SELECTION', '当前文档没有选区，未执行回图诊断');
    const result = {};
    for (const key of ['left', 'top', 'right', 'bottom']) result[key] = numeric(read(bounds, key, 'selection.bounds'), 'selection.bounds.' + key);
    result.width = result.right - result.left; result.height = result.bottom - result.top;
    if (result.width <= 0 || result.height <= 0) throw failure('NO_SELECTION', '当前选区为空，未执行回图诊断');
    return result;
  }
  async function run(params = {}) {
    const input = parameters(params), options = validateRun(input);
    const receipt = {}, stages = [];
    let docId = null, initialBefore = null, before = null, modalEntry = null, modalAfter = null, after = null, bounds = null,
      targetBoundsAtModalEntry = null, targetDrift = null, preModalChanges = null, baselineSource = 'unavailable',
      attributionReliable = false, operationCheckpointSeen = false, runError = null, afterError = null, firstChangedStage = null;
    function record(stage, current, compareTo = before, countForAttribution = true) {
      const changes = compare(compareTo, current);
      stages.push({ stage, snapshot: current, changes });
      if (countForAttribution && attributionReliable && firstChangedStage === null && changes && changes.originalLayersChanged) firstChangedStage = stage;
      return current;
    }
    function readTargetAtModal(doc) {
      try { return targetBounds(doc, options.target, modalEntry || initialBefore); }
      catch (error) { return { unavailable: true, error: errorInfo(error) }; }
    }
    try {
      // Bind once, before the first await. Never resolve an active document again
      // as a fallback if the user switches documents during temporary-file IO.
      docId = bind(input);
      const doc = documentById(docId);
      initialBefore = capture(docId, doc);
      record('initial-before', initialBefore, null, false);
      before = initialBefore;
      baselineSource = 'invocation';
      bounds = targetBounds(doc, options.target, initialBefore);
      const layerId = await psIo.placeImageToSpecificDoc(options.image.base64, docId, bounds, 0, options.layerType, {
        strategy: options.strategy, receipt, historyName: 'V7 回图对照实验',
        async checkpoint(stage, checkpointDoc) {
          const name = String(stage || 'unnamed');
          try {
            const current = capture(docId, checkpointDoc);
            if (name === 'modal-entry') {
              if (modalEntry || operationCheckpointSeen)
                throw failure('RETURN_LAB_CHECKPOINT_ORDER', 'modal-entry 检查点重复或晚于操作检查点，不能重置诊断基线');
              modalEntry = current;
              modalAfter = current;
              preModalChanges = compare(initialBefore, current);
              before = current;
              baselineSource = 'modal-entry';
              attributionReliable = true;
              targetBoundsAtModalEntry = readTargetAtModal(checkpointDoc || documentById(docId));
              if (targetBoundsAtModalEntry && !targetBoundsAtModalEntry.unavailable && bounds) {
                const keys = ['left', 'top', 'right', 'bottom', 'width', 'height'];
                const changed = keys.filter(key => bounds[key] !== targetBoundsAtModalEntry[key]);
                targetDrift = changed.length ? { changed, before: bounds, after: targetBoundsAtModalEntry } : null;
              } else if (targetBoundsAtModalEntry && targetBoundsAtModalEntry.unavailable) targetDrift = targetBoundsAtModalEntry;
              stages.push({ stage: name, snapshot: current, changes: preModalChanges, baseline: 'initial-before' });
            } else {
              operationCheckpointSeen = true;
              modalAfter = current;
              record(name, current);
            }
          }
          catch (error) { stages.push({ stage: name, snapshot: null, changes: null, error: errorInfo(error) }); throw error; }
        }
      });
      receipt.returnedLayerId = layerId == null ? null : Number(layerId);
    } catch (error) { runError = error; }
    // Older bridges may not expose modal-entry. Keep the invocation snapshot as
    // a conservative fallback, but never claim that a later change was caused
    // by a particular Photoshop operation.
    if (!modalEntry && initialBefore) {
      before = initialBefore;
      baselineSource = 'invocation';
      attributionReliable = false;
    }
    if (docId !== null) {
      try { after = record('after', capture(docId), before, false); }
      catch (error) { afterError = error; stages.push({ stage: 'after', snapshot: null, changes: null, error: errorInfo(error) }); if (!runError) runError = error; }
    }
    const changes = compare(before, after);
    if (!runError) {
      const id = receipt.returnedLayerId;
      if (!Number.isSafeInteger(id) || id < 1 || !changes || !changes.added.some(layer => layer.id === id))
        runError = failure('RETURN_LAB_LAYER_RECEIPT_FAILED', '无法确认返回编号属于本次新增回图层，请检查 Photoshop 文档，不要直接重试', { returnedLayerId: id });
    }
    const result = { ok: !runError, docId, host: hostInfo(), strategy: options.strategy, imageKind: options.imageKind,
      layerType: options.layerType, target: options.target, targetBounds: bounds, targetBoundsAtModalEntry,
      targetDrift, initialBefore, baselineSource, attributionReliable, preModalChanges, receipt: jsonSafe(receipt), stages,
      modalAfter, postModalChanges: compare(modalAfter, after),
      before, after, changes, firstChangedStage, retryAdvice: 'manual-review-before-retry', limitations: LIMITATIONS.slice() };
    if (runError) result.error = errorInfo(runError);
    if (afterError) result.afterError = errorInfo(afterError);
    return result;
  }
  return { snapshot, run };
}

module.exports = { createReturnLab };
