'use strict';
const path = require('node:path');
// ⚠ 2026-10-14：'tutorial-next' 从动作白名单里删掉了 —— 首启的教程步骤整块已删
//   （用户定：教程要重做）。留着的话它会变成一条"界面永远不会发、但白名单认"的僵尸动作，
//   下一个人查协议时会以为教程还在。重做教程时加回来（清单见 docs/217）。
const ACTIONS = new Set(['close','quit','consent','terms-back','terms-accept','detect','choose','ps','autolaunch','skip','launch','install','rollback','provider','assistant','guide','finish','local-detect','local-start','local-download-runtime','local-model-library','local-model','local-pull','local-test']);
function createSetupHost({ BrowserWindow, ipcMain, screen, directory, getWindow, onLock, localAssistant, onQuit = () => require('electron').app.quit() }) {
  let record = null, queue = Promise.resolve();
  const local = localAssistant || require('./local-assistant.cjs').createLocalAssistant({
    openExternal: url => require('electron').shell.openExternal(url),
    confirm: async model => (await require('electron').dialog.showMessageBox(record?.window || getWindow(), {
      type: 'question', title: '下载本地聊天模型', message: '下载模型 ' + model + '？',
      detail: 'Ollama 将联网下载模型到它自己的模型目录，可能占用数 GB 磁盘空间；具体大小由所选版本决定。下载完成后还需进行本机聊天测试，不会自动改用云模型。',
      buttons: ['取消', '下载'], defaultId: 0, cancelId: 0, noLink: true
    })).response === 1
  });
  const mainSender = event => { const main = getWindow(); return main && !main.isDestroyed() && event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame && String(event.senderFrame?.url || '').startsWith('file:'); };
  function release(own) {
    if (record !== own) return;
    local.cancel(own.payload.session);
    record = null;
    const main = getWindow();
    if (main && !main.isDestroyed()) {
      if (own.window) {
        main.setEnabled(true); main.setIgnoreMouseEvents(false); main.setAlwaysOnTop(true, 'screen-saver'); main.focus();
      }
      main.webContents.send('setup:closed', { session: own.payload.session });
    }
  }
  function close() {
    if (!record) return;
    if (record.window && !record.window.isDestroyed()) record.window.destroy();
    else release(record);
  }
  async function request(operation, payload = {}) {
    const main = getWindow();
    if (!main || main.isDestroyed()) return { ok: false, error: '主窗口已关闭' };
    if (typeof payload?.session !== 'string' || !payload.session || Buffer.byteLength(payload.session, 'utf8') > 128) return { ok: false, error: 'SETUP_SESSION_INVALID' };
    if (operation === 'quit') {
      if (!record?.window || record.window.isDestroyed() || record.payload.session !== payload.session || record.payload.required !== true) return { ok: false, error: 'SETUP_SESSION_INVALID' };
      close();
      onQuit();
      return { ok: true };
    }
    if (operation === 'close') {
      if(record?.payload.session===payload.session && record.payload.required===true && payload.completed!==true)return {ok:false,error:'SETUP_REQUIRED'};
      if (record?.payload.session === payload.session) close();
      return { ok: true };
    }
    if (operation === 'detach') {
      if (record?.payload.session === payload.session && !record.window) close();
      return { ok: true };
    }
    if (operation === 'attach') {
      if (payload.required !== false || record?.window && record.payload.required === true) return { ok: false, error: 'SETUP_SESSION_INVALID' };
      if (record?.payload.session === payload.session && !record.window) { record.payload = payload; return { ok: true }; }
      close();
      record = { window: null, payload };
      return { ok: true };
    }
    if (operation === 'update') {
      if (record?.payload.session === payload.session) {
        if (!record.window && payload.required !== false) return { ok: false, error: 'SETUP_SESSION_INVALID' };
        record.payload = payload; record.window?.webContents.send('setup:data', payload);
      }
      return { ok: true };
    }
    if (operation !== 'open') return { ok: false, error: 'SETUP_OPERATION_INVALID' };
    if (globalThis.__PSAI_V7_HOST__?.isQuitting?.()) return { ok: false, error: 'APP_QUITTING' };
    if (record) {
      if (record.window && !record.window.isDestroyed() && record.payload.session === payload.session) { record.window.focus(); return { ok: true }; }
      close();
    }
    const bounds = screen.getDisplayMatching(main.getBounds()).bounds;
    const child = new BrowserWindow({ ...bounds, parent: main, modal: process.platform !== 'darwin', frame: false, transparent: true,
      resizable: false, movable: false, hasShadow: false, skipTaskbar: true, focusable: true,
      alwaysOnTop: true, backgroundColor: '#00000000', show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(directory, 'setup-preload.js') } });
    const own = { window: child, payload };
    record = own;
    // Only the active first-run gate blocks an OS close. Completion, failure
    // cleanup and an explicit quit use destroy(), which bypasses this event.
    child.on('close', event => {
      if (record === own && own.payload.required === true && !globalThis.__PSAI_V7_HOST__?.isQuitting?.()) event.preventDefault();
    });
    child.on('closed', () => release(own));
    try {
      onLock?.();
      main.setIgnoreMouseEvents(false);
      main.setAlwaysOnTop(false);
      if (process.platform !== 'darwin') main.setEnabled(false);
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', event => event.preventDefault());
      child.webContents.on('render-process-gone', () => { if (record === own) close(); });
      await child.loadFile(path.join(directory, 'setup-window.html'));
      if (record !== own || child.isDestroyed()) return { ok: true, closed: true };
      child.webContents.send('setup:data', own.payload);
      child.setBounds(bounds); child.setAlwaysOnTop(true, 'screen-saver'); child.show(); child.focus();
      return { ok: true };
    } catch (error) { if (record === own) close(); return { ok: false, error: error.message }; }
  }
  ipcMain.handle('setup:request', (event, operation, payload) => {
    if (!mainSender(event)) return { ok: false, error: 'SETUP_CALLER_DENIED' };
    if (operation === 'local-assistant') {
      const own = record;
      if (!own || payload?.session !== own.payload.session || own.window?.isDestroyed()) return { ok: false, error: 'SETUP_SESSION_INVALID' };
      return local.run(payload.action, payload, () => record === own && !own.window?.isDestroyed());
    }
    const result = queue.catch(() => {}).then(() => request(operation, payload)); queue = result; return result;
  });
  ipcMain.handle('setup:child', (event, operation, payload) => {
    if (!record?.window || record.window.isDestroyed() || event.sender !== record.window.webContents) return { ok: false, error: 'SETUP_CALLER_DENIED' };
    if (operation === 'ready') return record.payload;
    if (operation !== 'action' || payload?.session !== record.payload.session || !ACTIONS.has(payload.action)) return { ok: false, error: 'SETUP_ACTION_DENIED' };
    getWindow()?.webContents.send('setup:action', payload);
    return { ok: true };
  });
  return { isOpen: () => !!record?.window, window: () => record?.window || getWindow(), close };
}
module.exports = { createSetupHost };
