'use strict';

const { matrix: transform, viewportGeometry } = require('./assistant-view-geometry');

// Adobe's bundled panels pair viewInfo.activeView.globalBounds with
// viewTransform and core.getDisplayConfiguration. All three must agree.
function failure(code) { return Object.assign(new Error(code), { code }); }
function active(app) { try { return app.activeDocument || null; } catch (_) { return null; } }
function identifier(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function supportsZoom(version) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(version || ''));
  return !!match && (Number(match[1]) > 25 || Number(match[1]) === 25 && Number(match[2]) >= 1);
}
function dimensions(doc) {
  try { return [doc.width, doc.height]; } catch (_) { return [null, null]; }
}
function historyId(doc) {
  try {
    const history = doc.activeHistoryState, value = history && history.id;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch (_) { return null; }
}
function createAssistantViewState({ app, core, platform, now = () => Date.now() }) {
  async function readNative(docId) {
    let row;
    try {
      const rows = await app.batchPlay([{ _obj: 'multiGet', _target: { _ref: 'document', _id: docId },
        extendedReference: [['documentID', 'viewInfo', 'viewTransform', 'width', 'height', 'resolution']] }], { synchronousExecution: true });
      row = rows && rows[0];
      if (row && row._obj !== 'error') return row;
    } catch (_) { /* Older hosts may expose only the individual matrix property. */ }
    try {
      const rows = await app.batchPlay([{ _obj: 'get', _target: [{ _property: 'viewTransform' }, { _ref: 'document', _id: docId }] }], { synchronousExecution: true });
      return rows && rows[0] && rows[0]._obj !== 'error' ? rows[0] : {};
    } catch (_) { return { unavailable: true }; }
  }
  return async function viewState(params = {}) {
    const startedAt = now();
    if (params.expiresAt !== undefined && !Number.isFinite(Number(params.expiresAt))) throw failure('ASSISTANT_VIEW_PARAMS');
    if (params.expiresAt !== undefined && Number(params.expiresAt) <= startedAt) throw failure('ASSISTANT_VIEW_EXPIRED');
    const doc = active(app), activeId = doc && identifier(doc.id);
    if (!activeId) throw failure('NO_DOCUMENT');
    const requested = params.docId == null ? activeId : identifier(params.docId);
    if (!requested) throw failure('ASSISTANT_VIEW_PARAMS');
    const state = { ok: true, status: 'unavailable', bounds: null, polygon: null, boundsKind: null, reason: 'VIEWPORT_CLIENT_BOUNDS_UNVERIFIED',
      docId: requested, activeDocumentId: activeId, activeDocumentBound: requested === activeId,
      activeWindowOnly: true, windowId: null, windowIdentityStatus: 'unavailable',
      contentRevision: null, contentRevisionSource: null,
      clientBounds: null, displayBounds: null, scaleFactor: null, coordinateSpace: 'document-pixels',
      viewTransform: null, transformStatus: 'unavailable', transformReason: 'VIEW_TRANSFORM_UNSUPPORTED',
      zoomPercent: null, zoomStatus: 'unavailable', zoomReason: 'DOM_ZOOM_REQUIRES_25_1', sampledAt: startedAt,
      selectionChanged: false, layersChanged: false };
    if (requested !== activeId) { state.transformReason = 'VIEW_DOCUMENT_NOT_ACTIVE'; state.zoomReason = 'VIEW_DOCUMENT_NOT_ACTIVE'; return state; }
    const size = dimensions(doc), initialHistoryId = historyId(doc);
    let historyReliable = initialHistoryId !== null;
    function checkDocument() {
      if (params.expiresAt !== undefined && Number(params.expiresAt) <= now()) throw failure('ASSISTANT_VIEW_EXPIRED');
      const current = active(app), currentId = current && identifier(current.id);
      const currentSize = current ? dimensions(current) : [null, null];
      if (currentId === requested && size.every((value, index) => value === currentSize[index])) {
        const latestHistoryId = historyId(current);
        if (initialHistoryId !== null && latestHistoryId !== null && initialHistoryId !== latestHistoryId) throw failure('ASSISTANT_VIEW_CONTENT_CHANGED');
        if (latestHistoryId === null) historyReliable = false;
        state.contentRevision = historyReliable ? 'doc:' + requested + ':history:' + initialHistoryId : null;
        state.contentRevisionSource = historyReliable ? 'dom-active-history-state' : null;
        return true;
      }
      state.contentRevision = null; state.contentRevisionSource = null;
      state.activeDocumentBound = currentId === requested; state.activeDocumentId = currentId;
      state.viewTransform = null; state.transformStatus = 'unavailable'; state.transformReason = currentId === requested ? 'VIEW_DOCUMENT_RESIZED' : 'VIEW_DOCUMENT_CHANGED';
      state.zoomPercent = null; state.zoomStatus = 'unavailable'; state.zoomReason = state.transformReason; state.reason = state.transformReason;
      return false;
    }
    let zoom = null;
    if (supportsZoom(app.version)) {
      try { const value = doc.zoom; if (typeof value === 'number' && Number.isFinite(value) && value > 0) zoom = value; }
      catch (_) { /* Metadata can be unavailable while the canvas is readable. */ }
      state.zoomReason = zoom === null ? 'DOM_ZOOM_UNAVAILABLE' : null;
    }
    const first = await readNative(requested);
    if (!checkDocument()) return state;
    if (first.documentID !== undefined && first.documentID !== requested) { state.reason = 'VIEWPORT_DOCUMENT_MISMATCH'; return state; }
    state.viewTransform = transform(first.viewTransform);
    state.transformReason = state.viewTransform ? null : first.unavailable ? 'VIEW_TRANSFORM_UNAVAILABLE' : 'VIEW_TRANSFORM_UNSUPPORTED';
    state.transformStatus = state.viewTransform ? 'available' : 'unavailable';
    state.zoomPercent = zoom; state.zoomStatus = zoom === null ? 'unavailable' : 'available';
    if (!first.viewInfo) return state;
    if (!core || typeof core.getDisplayConfiguration !== 'function') { state.reason = 'VIEWPORT_DISPLAY_CONFIGURATION_UNAVAILABLE'; return state; }
    let displays;
    try { displays = await core.getDisplayConfiguration({}); }
    catch (_) { state.reason = 'VIEWPORT_DISPLAY_CONFIGURATION_UNAVAILABLE'; checkDocument(); return state; }
    if (!checkDocument()) return state;
    const geometry = viewportGeometry({ ...first, width: size[0], height: size[1], displays, platform });
    if (!geometry.ok) { state.reason = geometry.reason; return state; }
    const second = await readNative(requested);
    if (!checkDocument()) return state;
    let verifiedDisplays;
    try { verifiedDisplays = await core.getDisplayConfiguration({}); }
    catch (_) { state.reason = 'VIEWPORT_DISPLAY_CONFIGURATION_UNAVAILABLE'; checkDocument(); return state; }
    if (!checkDocument()) return state;
    const verified = viewportGeometry({ ...second, width: size[0], height: size[1], displays: verifiedDisplays, platform });
    const fingerprint = (row, shape) => JSON.stringify([row.viewTransform, shape.clientBounds, shape.displayBounds, shape.scaleFactor, shape.reportedScaleFactor]);
    if (second.documentID !== undefined && second.documentID !== requested || !verified.ok || fingerprint(first, geometry) !== fingerprint(second, verified)) {
      state.reason = 'VIEWPORT_VIEW_CHANGED'; state.viewTransform = null; state.transformStatus = 'unavailable'; state.transformReason = 'VIEWPORT_VIEW_CHANGED';
      state.zoomPercent = null; state.zoomStatus = 'unavailable'; state.zoomReason = 'VIEWPORT_VIEW_CHANGED';
      return state;
    }
    if (supportsZoom(app.version)) {
      try { const latest = doc.zoom; state.zoomPercent = typeof latest === 'number' && Number.isFinite(latest) && latest > 0 ? latest : null; }
      catch (_) { state.zoomPercent = null; }
      state.zoomStatus = state.zoomPercent === null ? 'unavailable' : 'available'; state.zoomReason = state.zoomPercent === null ? 'DOM_ZOOM_UNAVAILABLE' : null;
    }
    const { ok, ...details } = verified;
    Object.assign(state, details, { status: 'available', reason: null, source: 'adobe-view-info', viewSignature: fingerprint(second, verified) });
    state.sampledAt = now();
    return state;
  };
}
module.exports = { createAssistantViewState, supportsZoom, transform };
