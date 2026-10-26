'use strict';
// 幕布里的内置网页：在主窗口里叠一个 WebContentsView，位置跟着页面里的占位框走。
// browser:request(action, input)：workspace / open / navigate / back / forward / reload / close / setBounds / state / taskLock / importImage
// 事件：browser:state（地址、标题、出错）、browser:image（网页里右键「用作幕布素材」）
const MAX_IMAGE = 60 * 1024 * 1024;

function registerBrowserIpc(ipcMain, { electron, parent, emit }) {
  const { WebContentsView, Menu, session } = electron;
  let view = null, open = false, workspace = false, taskLocked = false, visible = true, lastError = '';
  const part = session.fromPartition('persist:v7-browser');

  const snapshot = () => {
    const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
    return { ok: true, open, workspace, taskLocked, url: wc ? wc.getURL() : '', title: wc ? wc.getTitle() : '', canGoBack: !!wc && wc.navigationHistory.canGoBack(), canGoForward: !!wc && wc.navigationHistory.canGoForward(), error: lastError };
  };
  const publish = () => emit('browser:state', snapshot());
  const httpUrl = (raw) => {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch (_) { u = new URL(`https://${String(raw || '').trim()}`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('只能打开 http/https 网页');
    return u.toString();
  };

  async function fetchImage(url) {
    const res = await part.fetch(httpUrl(url));
    if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
    const mime = String(res.headers.get('content-type') || 'image/png').split(';')[0];
    if (!mime.startsWith('image/')) throw new Error('这个链接不是图片');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('图片太大');
    return { ok: true, imageBase64: buf.toString('base64'), mime, source: { kind: 'browser', url } };
  }

  function ensureView() {
    const win = parent();
    if (!win || win.isDestroyed()) throw new Error('主窗口不存在');
    if (view && !view.webContents.isDestroyed()) return view;
    view = new WebContentsView({ webPreferences: { partition: 'persist:v7-browser', sandbox: true, contextIsolation: true } });
    win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) wc.on(ev, () => { lastError = ''; publish(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) { lastError = `打不开：${desc}`; publish(); } });
    wc.on('context-menu', (_e, params) => {
      if (params.mediaType !== 'image' || !params.srcURL) return;
      Menu.buildFromTemplate([{ label: '用作幕布素材', click: () => fetchImage(params.srcURL).then((item) => emit('browser:image', item)).catch((error) => { lastError = error.message; publish(); }) }]).popup();
    });
    return view;
  }

  function setBounds(input = {}) {
    if (!view) return snapshot();
    if (typeof input.visible === 'boolean') visible = input.visible;
    if (['x', 'y', 'width', 'height'].every((k) => Number.isFinite(Number(input[k])))) {
      view.setBounds({ x: Math.round(input.x), y: Math.round(input.y), width: Math.max(1, Math.round(input.width)), height: Math.max(1, Math.round(input.height)) });
    }
    view.setVisible(visible && !taskLocked);
    return snapshot();
  }

  function close() {
    const win = parent();
    if (view) {
      try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch (_) {}
      try { view.webContents.close(); } catch (_) {}
    }
    view = null; open = false; workspace = false;
    publish();
    return snapshot();
  }

  ipcMain.handle('browser:request', async (_event, action, input = {}) => {
    try {
      switch (action) {
        case 'workspace': workspace = input.open !== false; return snapshot();
        case 'open': {
          const v = ensureView();
          open = true; visible = true;
          if (input.bounds) setBounds({ ...input.bounds, visible: true });
          if (input.url) await v.webContents.loadURL(httpUrl(input.url)).catch((e) => { lastError = e.message; });
          publish();
          return snapshot();
        }
        case 'navigate': if (!view) ensureView(); await view.webContents.loadURL(httpUrl(input.url)).catch((e) => { lastError = e.message; }); return snapshot();
        case 'back': view?.webContents.navigationHistory.goBack(); return snapshot();
        case 'forward': view?.webContents.navigationHistory.goForward(); return snapshot();
        case 'reload': view?.webContents.reload(); return snapshot();
        case 'close': return close();
        case 'setBounds': return setBounds(input);
        case 'state': return snapshot();
        case 'taskLock': taskLocked = !!input.locked; if (view) view.setVisible(visible && !taskLocked); publish(); return snapshot();
        case 'importImage': return await fetchImage(input.url);
        default: return { ok: false, error: `不支持的网页操作：${action}` };
      }
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  return { state: () => ({ open, workspace }), close };
}

module.exports = { registerBrowserIpc };
