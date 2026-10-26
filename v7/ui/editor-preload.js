// editor-preload — 剪影素材编辑器窗口的最小 IPC 桥
// ⚠ 窗口里不放业务判断(同 L4 / 大图的边界): 主窗口送整包数据来, 这边只回送编辑结果。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editorwin', {
  // 主进程推数据
  onData(callback) { ipcRenderer.on('editor:data', (_e, payload) => callback(payload)); },
  onCloseRequest(callback) { ipcRenderer.on('editor:request-close', () => callback()); },
  // 页面就绪后主动拉一次 —— 建窗口时的推送常常早于页面加载完而丢掉,
  // 只靠事件会出现"窗口开了但一片空白"(照抄 viewer/l4 的做法)。
  ready(callback) {
    ipcRenderer.invoke('editor:ready').then(payload => { if (payload) callback(payload); }).catch(() => {});
  },
  save(payload) { return ipcRenderer.invoke('editor:save', payload || {}); },
  close(editorSession) { ipcRenderer.send('editor:close-self', editorSession); },
  saveText(name, text) { ipcRenderer.invoke('preset:saveText', name, text).catch(() => {}); }
});
