// 大图独立窗口的最小桥接：只收图片数据，只发"切上下张"和"关闭"。
// ⚠ 和 l4-preload.js 刻意分开：两个窗口的数据形状完全不同，
//   合成一个 window.xxx 会逼出联合类型的 payload，以后谁都不敢改。
// ⚠ 这里不放任何业务判断（哪张能看、跳过失败图、张数排序）——那些留在主窗口。
//   这个窗口只是个显示器级的画框。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerwin', {
  // once 不行：开图之后还要不断换图，必须持续监听。
  onData(callback) {
    ipcRenderer.on('viewer:data', (_event, data) => callback(data || {}));
  },
  // delta: 1=下一张, -1=上一张。具体切到哪张由主窗口决定。
  nav(delta) {
    ipcRenderer.send('viewer:nav-request', Number(delta) || 0);
  },
  close() {
    ipcRenderer.send('viewer:close-self');
  }
});
