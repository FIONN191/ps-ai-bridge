// preload — 给渲染进程暴露窗口控制接口(拖动/关闭)
const { contextBridge, ipcRenderer } = require('electron');

// Electron 的透明窗口在点击穿透后可能不再收到 renderer mousemove。
// 主进程会在穿透期间探测屏幕光标位置，这里复用渲染层的几何命中判断，
// 命中实体 UI 后通知主进程恢复鼠标接管。
ipcRenderer.on('win:cursorProbe', (_event, payload) => {
  const x = Number(payload && payload.x);
  const y = Number(payload && payload.y);
  let overUI = false;
  try {
    overUI = Number.isFinite(x) && Number.isFinite(y)
      && typeof window.__uiHitTest === 'function'
      && window.__uiHitTest(x, y) === true;
  } catch (_) {}
  ipcRenderer.send('win:cursorProbeResult', { x, y, overUI });
});

// Account-aware persistence is opt-in: the host can provide these IDs when a
// signed-in profile is opened; anonymous windows use their own namespace.
contextBridge.exposeInMainWorld('WHEELCHAIR_CONTEXT', Object.freeze({
  accountId: process.env.WHEELCHAIR_ACCOUNT_ID || 'anonymous',
  deviceId: process.env.WHEELCHAIR_DEVICE_ID || 'local-device',
  profileId: process.env.WHEELCHAIR_PROFILE_ID || 'default',
  // Desktop validation can opt into a fully interactive transparent window.
  // The normal Electron/Tauri click-through behavior remains unchanged.
  interactiveOnly: process.env.WHEELCHAIR_INTERACTIVE_ONLY === '1'
}));

contextBridge.exposeInMainWorld('uiwin', {
  // ⭐⭐ 2026-10-09（用户定）：「砍掉软件里的社区，软件里只留一个「社区」按钮，点了跳网页」
  //   ⇒ 用【系统默认浏览器】打开外部网址。
  //   ⚠⚠ 不能用 window.open：UI 跑在 WebView 里，window.open 会在【自己这个窗口】
  //     里导航或被拦掉 —— 用户看到的是界面没了，而不是浏览器起来了。
  //   ⚠ Tauri 侧有同名接口（tauri-adapter.js 的 openExternalUrl → Rust open_external_url）。
  //     两个壳必须齐平（铁律 14），改一边就要改另一边 —— check-shell-parity.js 会查。
  //   ⚠ 只放行 http/https：主进程还会再挡一次（白名单，不是黑名单）。
  openExternalUrl(url) { return ipcRenderer.invoke('shell:openExternal', String(url || '')); },
  setup: {
    request(operation, payload) { return ipcRenderer.invoke('setup:request', operation, payload || {}); },
    onAction(callback) { const fn = (_event, value) => callback(value); ipcRenderer.on('setup:action', fn); return () => ipcRenderer.removeListener('setup:action', fn); },
    onClosed(callback) { const fn = (_event, value) => callback(value); ipcRenderer.on('setup:closed', fn); return () => ipcRenderer.removeListener('setup:closed', fn); }
  },
  // 拖动: 按下 start, 松开 end。高频跟随在主进程做(V7 同款, 更稳不抖)。
  dragStart() { ipcRenderer.send('win:dragStart'); },
  dragEnd() { ipcRenderer.send('win:dragEnd'); },
  // 点击穿透: true=鼠标穿过窗口交给下层, false=窗口接管
  setIgnoreMouse(ignore) { ipcRenderer.send('win:ignoreMouse', ignore); },
  // L4 显示器级冻结窗口
  openBlocking(payload) { ipcRenderer.send('win:openBlocking', payload || {}); },
  closeBlocking(id) { ipcRenderer.send('win:closeBlocking', id); },
  onBlockingAction(callback) {
    ipcRenderer.on('win:l4-action', (_event, id) => callback(id));
  },
  onBlockingClosed(callback) {
    const fn = (_event, id) => callback(id);
    ipcRenderer.on('win:l4-closed', fn);
    return () => ipcRenderer.removeListener('win:l4-closed', fn);
  },
  // V8 最小链路：UI 入队，主进程通过 37889 与 UXP 桥双向通信。
  link: {
    async enqueue(action, params) {
      return await ipcRenderer.invoke('link:enqueue', { action, params: params || {} });
    },
    async status() {
      return await ipcRenderer.invoke('link:status');
    },
    // 调 UXP 轮询间隔(开发期试 hover 联动手感用)
    async setPollMs(value) { return await ipcRenderer.invoke('link:setPollMs', value); },
    onQueued(callback) {
      ipcRenderer.on('link:queued', (_event, data) => callback(data));
    },
    onResult(callback) {
      ipcRenderer.on('link:result', (_event, data) => callback(data));
    },
    onEvent(callback) {
      ipcRenderer.on('link:event', (_event, data) => callback(data));
    }
  },
  // 对外 HTTP：由主进程代发，绕开渲染进程的跨域限制，并且能拿到服务器的真实报错。
  // ⚠ 必须和 src-tauri 的 http_fetch / http_cancel 保持同名同形(铁律 14)。
  //   Electron 这边渲染进程其实没有跨域问题(webSecurity 关着时)，
  //   但接口还是要齐平 —— 否则前端就得写两套分支，那才是真的会漂移。
  // 校色加速引擎：拉起本地 Python 服务。⭐ 只能启动项目里那个写死的脚本。
  engine: {
    // ⚠ 第二个参数 accel：'cuda' | 'off'，只管 prepare（装 CUDA 版 PyTorch）。
    //   和 Rust 侧（main.rs 的 engine_environment）同名同形 —— 铁律 14，不许只改一边。
    environment(action, accel) { return ipcRenderer.invoke('engine:environment', action, accel === 'cuda' ? 'cuda' : 'off'); },
    models(action, model) { return ipcRenderer.invoke('engine:models', action, model); },
    // which: 'match'(校色) | 'matting'(抠像)。⚠ 后端按【白名单】映射到脚本名，
    //   界面传的是标识不是路径 —— 不许改成传路径（docs/40 第四节）。
    async start(which) { return await ipcRenderer.invoke('engine:start', which || 'match'); },
    stop(which) { return ipcRenderer.invoke('engine:stop', which || 'match'); },
    // 打开抠像模型文件夹（用户把网盘下的 .onnx 拖进去）
    async openModelsDir() { return await ipcRenderer.invoke('engine:openModelsDir'); }
  },
  photoshop: {
    async discover(explicitPath) { return await ipcRenderer.invoke('photoshop:discover', explicitPath || ''); },
    async launch(candidate) { return await ipcRenderer.invoke('photoshop:launch', candidate || {}); },
    choose() { return ipcRenderer.invoke('photoshop:choose'); },
    inspect(candidate) { return ipcRenderer.invoke('photoshop:inspect', candidate || {}); },
    install(candidate) { return ipcRenderer.invoke('photoshop:install', candidate || {}); },
    rollback(candidate, backupId) { return ipcRenderer.invoke('photoshop:rollback', candidate || {}, backupId); },
    bridgeCopies() { return ipcRenderer.invoke('photoshop:bridgeCopies'); }
  },
  // 2026-10-24：截图当参考图只在 Tauri 正式壳有（snip.rs）。开发壳给同形空壳：界面拿到 unknown / UNSUPPORTED 就照旧抓 PS 选区（铁律 14）
  snip: {
    foreground() { return Promise.resolve({ ok: false, kind: 'unknown', supported: false }); },
    start() { return Promise.resolve({ ok: false, error: 'UNSUPPORTED' }); },
    onDone() { return Promise.resolve(() => {}); }
  },
  browser: {
    workspace(input) { return ipcRenderer.invoke('browser:request', 'workspace', input || {}); },
    open(input) { return ipcRenderer.invoke('browser:request', 'open', input || {}); },
    navigate(url) { return ipcRenderer.invoke('browser:request', 'navigate', { url }); },
    back() { return ipcRenderer.invoke('browser:request', 'back'); },
    forward() { return ipcRenderer.invoke('browser:request', 'forward'); },
    reload() { return ipcRenderer.invoke('browser:request', 'reload'); },
    close() { return ipcRenderer.invoke('browser:request', 'close'); },
    setBounds(input) { return ipcRenderer.invoke('browser:request', 'setBounds', input || {}); },
    state() { return ipcRenderer.invoke('browser:request', 'state'); },
    taskLock(locked) { return ipcRenderer.invoke('browser:request', 'taskLock', { locked }); },
    importImage(url) { return ipcRenderer.invoke('browser:request', 'importImage', { url }); },
    onState(callback) { const fn = (_event, value) => callback(value); ipcRenderer.on('browser:state', fn); return () => ipcRenderer.removeListener('browser:state', fn); },
    onImage(callback) { const fn = (_event, value) => callback(value); ipcRenderer.on('browser:image', fn); return () => ipcRenderer.removeListener('browser:image', fn); }
  },
  // Agent 文件操作只能由 Electron 主进程执行，渲染层不能直接拿 fs。
  // 访问档位由主进程原生确认窗口授予，页面传入 tier 不能提升权限。
  planner: {
    request(input) { return ipcRenderer.invoke('planner:request', input || {}); },
    onReminder(callback) { const listener = (_event, data) => callback(data); ipcRenderer.on('planner:reminder', listener); return () => ipcRenderer.removeListener('planner:reminder', listener); }
  },
  secrets: {
    get(name, scope) { return ipcRenderer.invoke('secrets:get', name, scope); },
    set(request) { return ipcRenderer.invoke('secrets:set', request || {}); },
    remove(name, scope) { return ipcRenderer.invoke('secrets:remove', name, scope); },
    list(scope) { return ipcRenderer.invoke('secrets:list', scope); }
  },
  agent: {
    readFile(request) { return ipcRenderer.invoke('agent:readFile', request || {}); },
    listFiles(request) { return ipcRenderer.invoke('agent:listFiles', request || {}); },
    async tierInfo() { return await ipcRenderer.invoke('agent:tierInfo'); },
    async requestAccess(tier) { return await ipcRenderer.invoke('agent:requestAccess', tier); },
    async authorize(request) { return await ipcRenderer.invoke('agent:authorize', request || {}); },
    async applyChanges(request) { return await ipcRenderer.invoke('agent:applyChanges', request || {}); },
    async diff(backupId) { return await ipcRenderer.invoke('agent:diff', backupId); },
    async rollback(request) { return await ipcRenderer.invoke('agent:rollback', request || {}); },
    async listBackups() { return await ipcRenderer.invoke('agent:listBackups'); },
    upgradeStatus() { return ipcRenderer.invoke('agent:upgradeStatus'); }
  },
  // ⭐ 2026-10-17 夜：夏三六黑匣子（ui-pure/agent-trace.js）—— 一行一件事追加进当天的文件。两壳一致：Tauri 侧 agent_trace_append / agent_trace_path
  agentTrace: {
    append(day, line) { return ipcRenderer.invoke('agentTrace:append', String(day || ''), String(line || '')); },
    path() { return ipcRenderer.invoke('agentTrace:path'); }
  },
  agentPresets: {
    enable(request) { return ipcRenderer.invoke('agentPresets:enable', request || {}); },
    disable() { return ipcRenderer.invoke('agentPresets:disable'); },
    info() { return ipcRenderer.invoke('agentPresets:info'); },
    scan() { return ipcRenderer.invoke('agentPresets:scan'); },
    ack(request) { return ipcRenderer.invoke('agentPresets:ack', request || {}); },
    openFolder() { return ipcRenderer.invoke('agentPresets:openFolder'); }
  },
  http: {
    async fetch(options) { return await ipcRenderer.invoke('http:fetch', options || {}); },
    async cancel(requestId) { return await ipcRenderer.invoke('http:cancel', requestId); }
  },
  // V7 AI 全量验证：请求与密钥只进 Electron 主进程，不经过 UXP。
  ai: {
    async generate(payload) { return await ipcRenderer.invoke('ai:generate', payload || {}); },
    async cancel(taskId) { return await ipcRenderer.invoke('ai:cancel', taskId); },
    onProgress(callback) { ipcRenderer.on('ai:progress', (_event, data) => callback(data)); }
  },
  close() { ipcRenderer.send('win:close'); },
  // 调试用: 重启整个程序，验"重启后任务还在不在"
  restart() { ipcRenderer.send('app:restart'); },
  // 性能采样。⚠ 数据源与显示位置解耦，现在显示在 L3 卡，以后可能挪走
  perf: {
    async sample() { return await ipcRenderer.invoke('perf:sample'); }
  },
  async getPos() { return await ipcRenderer.invoke('win:getPos'); }
  // 生成缓存：<缓存根>/<PS项目名>/<每次计算>/。接口与 Tauri 适配层逐项对齐。
  ,cache: {
    async root() { return await ipcRenderer.invoke('cache:root'); },
    // bytes 传 Uint8Array，走结构化克隆，不转 base64
    async writeFile(project, runId, name, bytes) { return await ipcRenderer.invoke('cache:writeFile', project, runId, name, bytes); },
    async writeMeta(project, runId, meta) { return await ipcRenderer.invoke('cache:writeMeta', project, runId, meta); },
    async readFile(project, runId, name) { return await ipcRenderer.invoke('cache:readFile', project, runId, name); },
    async list() { return await ipcRenderer.invoke('cache:list'); },
    async openFolder(project, runId) { return await ipcRenderer.invoke('cache:openFolder', project, runId); },
    async deleteRun(request) { return await ipcRenderer.invoke('cache:deleteRun', request || {}); },
    async deleteOutput(request) { return await ipcRenderer.invoke('cache:deleteOutput', request || {}); },
  // ⭐⭐ 2026-10-08（docs/170 §十四）：清掉历史遗留的插帧文件。
  //   ⚠ 这是【唯一】一个会真删缓存文件的接口，所以 Rust 那边用白名单式判定
  //     （必须 tween_ 开头 + .png/.json）—— 见 cache_purge_tween_files 的注释。
  async purgeTweenFiles(request) { return await ipcRenderer.invoke('cache:purgeTweenFiles', request || {}); },
    async listDeleted(namespaceId) { return await ipcRenderer.invoke('cache:listDeleted', String(namespaceId || '')); },
    async restoreDeleted(request) { return await ipcRenderer.invoke('cache:restoreDeleted', request || {}); },
    async purgeDeleted(request) { return await ipcRenderer.invoke('cache:purgeDeleted', request || {}); },
    async checkpointInventory(request) { return await ipcRenderer.invoke('cache:checkpointInventory', request || {}); },
    async purgeCheckpoint(request) { return await ipcRenderer.invoke('cache:purgeCheckpoint', request || {}); },
    async chooseRoot() { return await ipcRenderer.invoke('cache:chooseRoot'); },
    // 缓存用量报告（docs/128 §三-4）：按项目 / 按日期各占多少。
    // ⚠ 必须和 tauri-adapter.js 的那份同名同形（铁律 14）。
    async usageReport(request) { return await ipcRenderer.invoke('cache:usageReport', request || {}); }
  }
  // 大图查看：显示器级独立冻结窗口。和 L4 分开走，接口各管各的。
  ,viewer: {
    open(payload) { return ipcRenderer.invoke('viewer:open', payload || {}); },
    update(payload) { return ipcRenderer.invoke('viewer:update', payload || {}); },
    close() { ipcRenderer.send('viewer:close'); },
    // 大图窗口请求切上下张，delta: 1=下一张 -1=上一张
    onNav(callback) { ipcRenderer.on('viewer:nav', (_event, delta) => callback(delta)); },
    // 大图窗口已关闭(不管是谁关的)，主窗口据此复位状态
    onClosed(callback) { ipcRenderer.on('viewer:closed', () => callback()); }
  }
  // ⭐ 2026-10-21：窗口跟随 Photoshop 置顶只在 Tauri 外壳做了（topmost.rs）；这个旧外壳照旧始终置顶，老实回「不支持」
  ,topmost: {
    async setFollowPs(follow) { return { ok: true, follow: !!follow, supported: false }; }
  }
  ,shortcuts: {
    async setGeneration(value) { return await ipcRenderer.invoke('shortcut:set-generation', value || ''); },
    onGeneration(callback) { ipcRenderer.on('shortcut:generation', () => callback()); },
    // ⭐ 2026-10-14：加参考图快捷键。跟上面两项逐行对称（双壳同步，铁律 14）。
    async setReference(value) { return await ipcRenderer.invoke('shortcut:set-reference', value || ''); },
    onReference(callback) { ipcRenderer.on('shortcut:reference', () => callback()); },
    // ⭐ 2026-10-17 夜：一键收起 / 展开快捷键。跟上面逐行对称（双壳同步，铁律 14）。
    async setCollapse(value) { return await ipcRenderer.invoke('shortcut:set-collapse', value || ''); },
    onCollapse(callback) { ipcRenderer.on('shortcut:collapse', () => callback()); },
    // ⭐ 2026-10-21：换下一家渠道（双壳同步，铁律 14）
    async setProvider(value) { return await ipcRenderer.invoke('shortcut:set-provider', value || ''); },
    onProvider(callback) { ipcRenderer.on('shortcut:provider', () => callback()); }
  }
  ,freeMode: {
    async set(enabled) { return await ipcRenderer.invoke('free-mode:set', !!enabled); },
    pulse() { return ipcRenderer.invoke('free-mode:pulse'); },
    onMouseReset(callback) { const fn = () => callback(); ipcRenderer.on('free-mode:mouse-reset', fn); return () => ipcRenderer.removeListener('free-mode:mouse-reset', fn); },
    onExitRequest(callback) { const fn = () => callback(); ipcRenderer.on('shortcut:free-mode-exit', fn); return () => ipcRenderer.removeListener('shortcut:free-mode-exit', fn); }
  }
  // ⭐ 2026-10-18 深夜：界面缩放。跟 tauri-adapter.js 的 uiScale 逐个对称（双壳同步，铁律 14）
  ,uiScale: {
    get() { return ipcRenderer.invoke('ui-scale:get'); },
    set(scale) { return ipcRenderer.invoke('ui-scale:set', Number(scale) || 1); }
  }
  // 预设系统的文件活儿。导入不走这里(界面用 <input type="file"> 就够了)，
  // 这里只做三件必须碰文件系统的事：找 V6 目录 / 读目录 / 保存对话框。
  ,presetfs: {
    async findV6() { return await ipcRenderer.invoke('preset:findV6'); },
    async scanDir(dir) { return await ipcRenderer.invoke('preset:scanDir', dir); },
    async saveText(name, text) { return await ipcRenderer.invoke('preset:saveText', name, text); }
  }
  // 剪影素材编辑器：第三个显示器级独立窗口，手法同 L4 / 大图。
  ,editor: {
    open(payload) { return ipcRenderer.invoke('editor:open', payload || {}); },
    close() { ipcRenderer.send('editor:close'); },
    onSave(callback) {
      const listener = async (_event, data, requestId) => {
        let result;
        try { result = await callback(data); }
        catch (error) { result = { ok: false, error: String(error?.message || error), code: error?.code }; }
        if (requestId) ipcRenderer.send('editor:save-result', { requestId, editorSession: data?.editorSession, result });
      };
      ipcRenderer.on('editor:saved', listener);
      return () => ipcRenderer.removeListener('editor:saved', listener);
    }
  }
});
