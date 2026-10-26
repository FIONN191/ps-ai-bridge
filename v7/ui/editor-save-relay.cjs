'use strict';

const { randomUUID } = require('node:crypto');

// Resolve only after the owning renderer has committed the edit to storage.
function createEditorSaveRelay({ getMain, getEditor, getPayload, timeoutMs = 120000 }) {
  const pending = new Map();
  function save(sender, payload) {
    const editor = getEditor(), main = getMain(), session = getPayload()?.editorSession;
    if (!editor || editor.isDestroyed() || sender.id !== editor.webContents.id ||
        !main || main.isDestroyed() || !session || payload?.editorSession !== session) {
      return Promise.resolve({ ok: false, error: '编辑窗口已过期，请重新打开', code: 'SILHOUETTE_EDITOR_STALE' });
    }
    if (pending.size) return Promise.resolve({ ok: false, error: '正在保存，请等待完成' });
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(requestId, { ok: false, error: '保存回执超时，编辑内容已保留，请检查主窗口后重试' }), timeoutMs);
      pending.set(requestId, { session, editor, main, resolve, timer });
      try { main.webContents.send('editor:saved', payload, requestId); }
      catch (_) { finish(requestId, { ok: false, error: '主窗口暂时无法接收保存，编辑内容已保留，请稍后重试' }); }
    });
  }
  function finish(requestId, result) {
    const item = pending.get(requestId);
    if (!item) return;
    pending.delete(requestId); clearTimeout(item.timer); item.resolve(result);
  }
  function acknowledge(sender, message) {
    const main = getMain(), item = pending.get(message?.requestId);
    if (!main || main.isDestroyed() || sender.id !== main.webContents.id || !item || main !== item.main || message.editorSession !== item.session) return false;
    if (getPayload()?.editorSession !== item.session || getEditor() !== item.editor || item.editor.isDestroyed()) finish(message.requestId, { ok: false, error: '编辑会话已切换', code: 'SILHOUETTE_EDITOR_STALE' });
    else finish(message.requestId, message.result?.ok === true ? message.result : { ok: false, error: message.result?.error || '保存未完成，编辑内容已保留' });
    return true;
  }
  function cancel() { for (const id of pending.keys()) finish(id, { ok: false, error: '编辑窗口已关闭', code: 'SILHOUETTE_EDITOR_STALE' }); }
  return { save, acknowledge, cancel };
}

module.exports = { createEditorSaveRelay };
