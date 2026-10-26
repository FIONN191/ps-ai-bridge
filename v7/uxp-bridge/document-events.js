'use strict';
// Read-only Photoshop observations. Classification and user decisions belong
// to the desktop project controller, never to this bridge.
function createDocumentObserver({ app, emit, sessionId, now = () => Date.now() }) {
  let previous = new Map(), sequence = 0, initialized = false;
  function summarize(doc) {
    const read = (key, fallback) => { try { return doc[key] == null ? fallback : doc[key]; } catch (_) { return fallback; } };
    const history = read('activeHistoryState', null);
    let historyId = null; try { historyId = history && history.id != null ? String(history.id) : null; } catch (_) {}
    return { id: Number(doc.id), name: String(read('name', '')), path: String(read('path', '')),
      width: Number(read('width', 0)), height: Number(read('height', 0)), historyId, sessionId };
  }
  // ⚠ 2026-10-15：app.documents 不是真数组，Array.prototype.map.call 会全部跳过 → [null,null,…]
  //   （实测：开着 4 个文档，列表回来 4 个 null，所有"回传前核对原文档"的工具都判"原文档已关闭"）。
  //   改成逐个读出来再 map（同 ps-actions.js 的 collectionToArray）。
  function toArray(coll) {
    const out = [];
    if (!coll) return out;
    try { for (const x of coll) { if (x) out.push(x); } } catch (_) {}
    if (!out.length) { try { for (let i = 0; i < coll.length; i++) { if (coll[i]) out.push(coll[i]); } } catch (_) {} }
    return out;
  }
  function list() { return toArray(app.documents).map(doc => summarize(doc)); }
  function event(kind, document, extra) { return Object.assign({ type: 'project:document', kind, document,
    id: sessionId + ':' + (++sequence), at: now() }, extra || {}); }
  function snapshot() {
    const documents = list(), current = new Map(documents.map(d => [d.id, d]));
    if (initialized) {
      for (const [id, doc] of previous) if (!current.has(id)) emit(event('closed', doc));
      for (const [id, doc] of current) {
        const old = previous.get(id);
        if (old && old.historyId != null && doc.historyId != null && old.historyId !== doc.historyId) emit(event('changed', doc, { previousHistoryId: old.historyId }));
      }
    }
    previous = current; initialized = true;
    emit({ type: 'project:snapshot', sessionId, documents, at: now() });
    return documents;
  }
  function exported(docId, source) {
    const doc = list().find(row => row.id === Number(docId)) || previous.get(Number(docId));
    if (doc) emit(event('exported', doc, { source: source || 'photoshop-export' }));
  }
  return { list, snapshot, exported };
}
module.exports = { createDocumentObserver };
