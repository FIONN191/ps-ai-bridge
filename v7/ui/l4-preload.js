// L4 独立窗口的最小桥接：只接收主进程下发的数据，并发送“立即处理”。
const { contextBridge, ipcRenderer } = require('electron');
const rawWindowId = String((process.argv.find(value => value.indexOf('--l4-id=') === 0) || '').slice(8));
const windowId = (() => { try { return decodeURIComponent(rawWindowId); } catch (_) { return rawWindowId; } })();
let receivedData = false, actionSent = false;

contextBridge.exposeInMainWorld('l4win', {
  onData(callback) {
    ipcRenderer.on('l4:data', (_event, data) => {
      if (!data || String(data.id || '') !== windowId) return;
      if (!data.backgroundOnly) receivedData = true;
      callback(data);
    });
  },
  windowId,
  action() {
    if (!receivedData || actionSent) return;
    actionSent = true;
    ipcRenderer.send('l4:action', windowId);
  },
  // 超时应急关闭是独立事件，绝不冒充正常业务确认。
  escape() {
    if (actionSent) return;
    actionSent = true;
    ipcRenderer.send('l4:escape', windowId);
  }
});
