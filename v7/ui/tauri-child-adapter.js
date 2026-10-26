// 子窗口(大图 / L4)的 Tauri 适配层。
//
// Electron 里这两个页面靠各自的 preload(viewer-preload.js / l4-preload.js)拿到
// window.viewerwin / window.l4win；Tauri 没有 preload，所以由这个文件补上同名接口。
// 页面代码因此不需要知道自己跑在哪个壳里 —— 和主窗口的 tauri-adapter.js 同一个思路。
//
// ⚠ 在 Electron 里这个文件什么都不做：没有 window.__TAURI__ 就直接 return，
//   preload 已经把接口注入好了，不能覆盖。
(function () {
  'use strict';

  const tauri = window.__TAURI__ || null;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
    // Electron 下这是正常的(preload 已经注入过接口)，不留痕迹。
    // Tauri 下走到这里说明 __TAURI__ 没注入，页面会在 1.5 秒后自己把这句显示出来。
    if (window.__TAURI_INTERNALS__ || location.protocol.indexOf('tauri') === 0) {
      window.__childAdapterError = 'window.__TAURI__ 不可用(withGlobalTauri 没生效?)';
    }
    return;
  }

  const invoke = tauri.core.invoke;
  const listen = tauri.event && tauri.event.listen;
  const emit = tauri.event && tauri.event.emit;
  if (document.getElementById('setup-panel')) {
    window.setupwin = {
      async onData(callback) {
        await listen('setup:data', event => callback(event.payload));
        callback(await invoke('setup_child', { operation: 'ready', payload: {} }));
      },
      action(payload) { return invoke('setup_child', { operation: 'action', payload: payload || {} }); }
    };
    return;
  }

  // 当前是哪个子窗口：按页面上的锚点元素判断，不猜文件名。
  const isViewer = !!document.getElementById('pvimg');
  const isEditor = !!document.getElementById('stage');
  const label = isViewer ? 'viewer' : (isEditor ? 'editor' : 'l4');

  // ── 大图 ──
  if (isViewer) {
    let dataCallback = null;
    let latestRequestGeneration = 0;
    let latestSeq = null;
    let activeAbort = null;

    // 取原图字节。⚠ 走 Response 拿 ArrayBuffer，不走 JSON：
    //   Tauri 的 invoke 参数/返回默认 JSON 序列化，8MB 二进制会被转成
    //   几千万元素的数组，慢到不能用。
    function fetchBytesAndDeliver(meta) {
      if (!dataCallback || !meta) return;
      const seq = meta.seq == null ? null : Number(meta.seq);
      // Ignore an event that is already older than the newest navigation
      // notification.  Tauri invoke calls can finish out of order.
      if (seq != null && Number.isFinite(seq) && latestSeq != null && seq < latestSeq) return;
      const generation = ++latestRequestGeneration;
      if (seq != null && Number.isFinite(seq)) latestSeq = seq;
      if (activeAbort) try { activeAbort.abort(); } catch (_) {}
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      activeAbort = controller;
      // ⚠ 带上 seq：主窗口把图和"第几张"绑了同一个流水号。
      //   我们是收到通知【之后】才回来取图的，这中间图可能已被下一次覆盖 ——
      //   核对不上就拿到空字节，保持原样等下一条，绝不显示错配的图。
      const request = controller
        ? invoke('viewer_get_image', { seq: meta.seq }, { signal: controller.signal })
        : invoke('viewer_get_image', { seq: meta.seq });
      request
        .then(buf => {
          if (generation !== latestRequestGeneration ||
              (seq != null && Number.isFinite(seq) && latestSeq !== seq)) return;
          const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf)
                      : (buf && buf.byteLength !== undefined ? new Uint8Array(buf) : null);
          if (!bytes || !bytes.length) {
            // 空字节有两种可能：
            //   ① 流水号对不上 —— 说明用户已经切到下一张了，这一帧丢掉【是对的】，
            //      下一条通知马上就到，不能把 meta 交出去(否则会显示旧图配新序号)。
            //   ② 真的没图 —— 这时把 meta 交出去，让页面显示"图片没送达"而不是干等。
            if (meta && meta.seq != null) return;
            window.viewerwin.lastError = 'viewer_get_image 返回空字节';
            dataCallback(meta);
            return;
          }
          dataCallback(Object.assign({}, meta, { bytes: bytes }));
        })
        .catch(e => {
          if (generation === latestRequestGeneration) window.viewerwin.lastError = 'viewer_get_image 失败: ' + (e && e.message || e);
        }).finally(() => { if (activeAbort === controller) activeAbort = null; });
    }

    window.viewerwin = {
      lastError: '',
      onData(callback) {
        dataCallback = callback;
        if (listen) {
          listen('viewer:data', event => fetchBytesAndDeliver(event && event.payload))
            .catch(e => { window.viewerwin.lastError = 'listen 失败: ' + (e && e.message || e); });
        } else {
          window.viewerwin.lastError = 'event.listen 不可用';
        }
        // ⚠ 建窗口时主进程发的那条事件多半早于本页面加载完成，已经丢了。
        //   这里主动回去取一次当前数据，否则窗口开着却一片空白。
        invoke('overlay_ready', { label: label })
          .then(meta => {
            if (meta) fetchBytesAndDeliver(meta);
            else window.viewerwin.lastError = 'overlay_ready 返回空(主窗口还没存数据)';
          })
          .catch(e => { window.viewerwin.lastError = 'overlay_ready 失败: ' + (e && e.message || e); });
      },
      nav(delta) { if (emit) emit('viewer:nav', Number(delta) || 0); },
      close() { invoke('viewer_close').catch(() => {}); }
    };
    return;
  }

  // ── 剪影素材编辑器 ──
  // ⚠ 数据是 dataURL 字符串, 不是二进制 —— 走普通 JSON 事件就行, 不用 viewer 那套 raw body。
  if (isEditor) {
    window.editorwin = {
      lastError: '',
      onCloseRequest(callback) { if (listen) listen('editor:request-close', () => callback()); },
      onData(callback) {
        if (listen) {
          listen('editor:data', event => { if (event && event.payload) callback(event.payload); })
            .catch(e => { window.editorwin.lastError = 'listen 失败: ' + (e && e.message || e); });
        } else {
          window.editorwin.lastError = 'event.listen 不可用';
        }
      },
      // 页面就绪后主动拉一次 —— 建窗口时的 emit 常常早于页面加载完而丢掉，
      // 只靠事件会出现"窗口开了但一片空白"(同 viewer / l4)。
      ready(callback) {
        invoke('overlay_ready', { label: label })
          .then(payload => {
            if (payload) callback(payload);
            else window.editorwin.lastError = 'overlay_ready 返回空(主窗口还没存数据)';
          })
          .catch(e => { window.editorwin.lastError = 'overlay_ready 失败: ' + (e && e.message || e); });
      },
      save(payload) { return invoke('editor_save', { payload: payload || {} }); },
      close(editorSession) { return invoke('editor_close', { editorSession: editorSession || null }); },
      saveText(name, text) {
        invoke('preset_save_text', { name: String(name || 'export.json'), text: String(text || '') })
          .catch(function () {});
      }
    };
    return;
  }

  // ── L4 冻结窗口 ──
  let l4DisplayedId = String(window.__L4_WINDOW_ID__ || '');
  let l4ActionSent = false;
  let l4EscapeSent = false;
  function receiveL4Data(payload, callback) {
    // 应急关闭已开始时冻结当前身份，迟到数据不能复活正常确认或改掉关闭目标。
    if (!payload || l4EscapeSent) return;
    const id = String(payload.id || '');
    if (payload.backgroundOnly) {
      if (!id || id !== l4DisplayedId) return;
    } else {
      if (!id) return;
      if (id !== l4DisplayedId) { l4ActionSent = false; l4EscapeSent = false; }
      l4DisplayedId = id;
    }
    callback(payload);
  }
  window.l4win = {
    lastError: '',
    onData(callback) {
      let receivedLiveData = false;
      if (listen) {
        listen('l4:data', event => {
          if (event && event.payload && !event.payload.backgroundOnly) receivedLiveData = true;
          receiveL4Data(event && event.payload, callback);
        })
          .catch(e => { window.l4win.lastError = 'listen 失败: ' + (e && e.message || e); });
      } else {
        window.l4win.lastError = 'event.listen 不可用';
      }
      invoke('overlay_ready', { label: label })
        .then(payload => {
          // 新内容已经经事件送达时，不让稍晚返回的就绪快照盖回上一条。
          if (payload) {
            if (!receivedLiveData) receiveL4Data(payload, callback);
          } else {
            window.l4win.lastError = 'overlay_ready 返回空(主窗口还没存数据)';
          }
        })
        .catch(e => { window.l4win.lastError = 'overlay_ready 失败: ' + (e && e.message || e); });
    },
    action() {
      if (!emit || !l4DisplayedId || l4ActionSent) return;
      l4ActionSent = true;
      emit('l4:action', { id: l4DisplayedId });
    },
    // 创建窗口时注入的 ID 不依赖数据消息。Rust 同时验证调用窗口和当前 ID，
    // 等原生销毁后发 closed 回执；应急操作从不经过正常业务 action。
    escape() {
      if (!l4DisplayedId || l4EscapeSent || l4ActionSent) return Promise.resolve({ok:false});
      l4EscapeSent = true;
      l4ActionSent = true;
      const id = l4DisplayedId;
      return invoke('l4_escape', { id }).then(result => {
        if (result?.ok === false && l4DisplayedId === id) { l4EscapeSent = false; l4ActionSent = false; }
        return result;
      }).catch(error => {
        if (l4DisplayedId === id) { l4EscapeSent = false; l4ActionSent = false; }
        window.l4win.lastError = '应急关闭失败: ' + (error && error.message || error);
        return {ok:false};
      });
    }
  };
})();
