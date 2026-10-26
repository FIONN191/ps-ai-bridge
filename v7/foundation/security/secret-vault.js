'use strict';
// 密钥保险箱：API Key 等用系统钥匙串加密后存成 <directory>/<scope>.json，页面只能按名字读写。
// 接口：secrets:get(name, scope) → {ok, value}；secrets:set({name, value, scope}) → {ok}；
//      secrets:remove(name, scope) → {ok}；secrets:list(scope) → {ok, names}
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
const scopeFile = (directory, scope) => {
  const s = String(scope || 'anonymous');
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(s)) throw new Error('SECRET_SCOPE_INVALID');
  return path.join(directory, `${s.replace(/:/g, '_')}.json`);
};

function registerSecretsIpc(ipcMain, { directory, safeStorage, isMainSender }) {
  fs.mkdirSync(directory, { recursive: true });
  const usable = () => safeStorage && safeStorage.isEncryptionAvailable();
  const read = (scope) => {
    try { return JSON.parse(fs.readFileSync(scopeFile(directory, scope), 'utf8')) || {}; } catch (_) { return {}; }
  };
  const write = (scope, data) => {
    const file = scopeFile(directory, scope), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const guard = (fn) => async (event, ...args) => {
    if (isMainSender && !isMainSender(event.sender)) return { ok: false, error: 'SECRET_CALLER_DENIED' };
    try { return await fn(...args); } catch (error) { return { ok: false, error: error.message || String(error) }; }
  };
  ipcMain.handle('secrets:get', guard((name, scope) => {
    if (!NAME.test(String(name))) return { ok: false, error: 'SECRET_NAME_INVALID' };
    const stored = read(scope)[name];
    if (!stored) return { ok: true, value: '' };
    if (!usable()) return { ok: false, error: 'SECRET_STORAGE_UNAVAILABLE' };
    return { ok: true, value: safeStorage.decryptString(Buffer.from(stored, 'base64')) };
  }));
  ipcMain.handle('secrets:set', guard((request = {}) => {
    const { name, value, scope } = request;
    if (!NAME.test(String(name))) return { ok: false, error: 'SECRET_NAME_INVALID' };
    if (!usable()) return { ok: false, error: 'SECRET_STORAGE_UNAVAILABLE' };
    const data = read(scope);
    if (value) data[name] = safeStorage.encryptString(String(value)).toString('base64');
    else delete data[name];
    write(scope, data);
    return { ok: true };
  }));
  ipcMain.handle('secrets:remove', guard((name, scope) => {
    const data = read(scope);
    delete data[name];
    write(scope, data);
    return { ok: true };
  }));
  ipcMain.handle('secrets:list', guard((scope) => ({ ok: true, names: Object.keys(read(scope)) })));
}

module.exports = { registerSecretsIpc };
