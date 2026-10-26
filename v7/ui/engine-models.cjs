'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findPython, INSTALL_GUIDANCE } = require('./engine-environment.cjs');
const defaultExecute = promisify(execFile);
const ACTIONS = new Set(['catalog', 'status', 'import', 'download', 'cancel']);

function createService(options = {}) {
  if (!path.isAbsolute(options.root || '') || !path.isAbsolute(options.resourceRoot || '')) throw new Error('模型目录和资源目录必须由宿主指定。');
  const root = path.resolve(options.root);
  const script = path.join(options.resourceRoot, 'engine/model_manager.py');
  const execute = options.execFile || defaultExecute;
  const delay = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const newToken = options.operationId || (() => crypto.randomUUID().replaceAll('-', ''));
  let active = null;
  let last = { ok: true, root, models: {}, operation: null };
  const failure = error => ({ ...last, ok: false, root, error: typeof error === 'string' ? error : error?.message === INSTALL_GUIDANCE ? INSTALL_GUIDANCE : '模型管理未完成，请重新检测并检查模型文件与目录权限。', ...(error instanceof Error ? { detail: error.message } : {}) });

  async function invoke(python, action, model, source, token, overwrite) {
    const args = ['-I', script, '--root', root, '--action', action];
    if (model) args.push('--model', model);
    if (source) args.push('--source', source);
    if (token) args.push('--operation', token);
    if (overwrite) args.push('--overwrite');
    let stdout;
    try {
      ({ stdout } = await execute(python, args, { timeout: action === 'import' || action === 'download' ? (options.timeoutMs || 61 * 60 * 1000) : 30000, windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }));
    } catch (error) {
      if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw error;
      stdout = error.stdout;
    }
    const value = JSON.parse(stdout.trim());
    if (typeof value.ok !== 'boolean' || !value.models || typeof value.models !== 'object' || Array.isArray(value.models) || path.resolve(value.root || '') !== root) throw new Error('模型管理器返回了无效状态。');
    return value;
  }

  async function request(action, model, requestOptions = {}) {
    const source = requestOptions?.source;
    if (!ACTIONS.has(action)) return failure('不支持的模型操作。');
    if (action === 'cancel') {
      if (!active) return { ...last, ok: true };
      active.cancelled = true;
      return { ...last, ok: true, cancelRequested: true, operation: { token: active.token, action: active.action, model: active.model, status: 'cancelling' } };
    }
    if (action === 'catalog' || action === 'status') {
      try { last = await invoke(await findPython(options), 'catalog'); return last; }
      catch (error) { return failure(error); }
    }
    if (active) return failure('本软件的模型操作仍在进行。');
    if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(model)) return failure('模型标识无效。');
    if (action === 'import' && (typeof source !== 'string' || !path.isAbsolute(source))) return failure('导入来源必须由宿主文件选择器提供。');
    if (action === 'download' && source != null) return failure('模型下载不接受外部来源或网址。');
    const operation = { action, model, token: newToken(), cancelled: false, done: false };
    active = operation;
    let cancellationLoop;
    try {
      const python = await findPython(options);
      if (operation.cancelled) return { ...last, ok: false, cancelled: true, error: '模型操作已取消。', code: 'CANCELLED' };
      const pending = invoke(python, action, model, source, operation.token, requestOptions?.overwrite === true);
      cancellationLoop = (async () => {
        while (!operation.done) {
          if (operation.cancelled) {
            try { await invoke(python, 'cancel', model, undefined, operation.token); } catch (_) { /* Retry a cancellation that arrived before the manager acquired its lock. */ }
          }
          await delay(250);
        }
      })();
      try { last = await pending; }
      finally { operation.done = true; }
      return last;
    } catch (error) { return failure(error); }
    finally {
      operation.done = true;
      if (cancellationLoop) await cancellationLoop;
      if (active === operation) active = null;
    }
  }
  return { request };
}

module.exports = { createService };
