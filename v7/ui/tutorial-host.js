/* ⭐ 2026-10-18 新手教程 · 真界面这一侧（方案 docs/243）。
 *
 * 教程页面 tutorial.html 用 iframe 嵌【真的 ui.html】，地址带 ?tutorial=1。这个文件在 ui.html 里【第一个】加载：
 *   · 标记 window.__V7_TUTORIAL__ = true —— 存储换到单独一格（profile=tutorial，见 backend-client.js），
 *     登录凭证换一把单独的钥匙：教程里点的、存的、生成的，全都不碰用户真数据；
 *   · 自己建 window.uiwin（tauri-adapter.js 见到 window.uiwin 已经在，或者没有 Tauri 时会直接退出）：
 *       link.*      → 发给父页面的假 PS（postMessage），假 PS 照插件的格式回结果 —— 卡片逻辑一行不改，就是真的；
 *       ai.generate → 不联网，按提示词 / 预设回教程预制的结果图；
 *       http.fetch  → 假后台：登录、积分、开源模型额度……都是写死的假回复；别的地址一律拒绝；
 *       其余        → 能做的回成功空结果，不能做的回「教程里不可用」；
 *   · 全局 fetch / XMLHttpRequest / WebSocket / sendBeacon 只放行本软件自己的文件：教程里绝不能真扣钱、真发请求。
 *
 * 只在 ?tutorial=1 时生效；平时这个文件什么都不做（第一行就 return）。
 */
(function (root) {
  'use strict';
  var params;
  try { params = new URLSearchParams(root.location.search); } catch (_) { return; }
  if (!params.has('tutorial')) return;
  root.__V7_TUTORIAL__ = true;

  // ── 存储隔离（兜底）：教程这份界面跟真软件共用同一个 localStorage（同源）。
  //    按账号分开的钥匙（带 ~p-tutorial 的）本来就隔开了；但还有一批【全局钥匙】（模型列表缓存、遥测、价格缓存、
  //    首次设置……）直接写死名字 —— 教程里一写就会盖掉用户真软件的（10-18 晚核对：provider-models 按服务商存模型列表，
  //    教程配了假的阿吉服务，会把真阿吉的模型列表冲成空的）。
  //    ⇒ 在这个窗口里把 localStorage 的读写换一层：不是教程钥匙、也不是按账号分开的，一律加前缀存到教程自己那一格。
  //    ⚠ 只改这个 iframe 的 Storage 原型（每个窗口一份），不影响真软件窗口。
  try {
    var LS = root.localStorage, SP = Object.getPrototypeOf(LS);
    var rawGet = SP.getItem, rawSet = SP.setItem, rawDel = SP.removeItem;
    var mapKey = function (k) {
      k = String(k);
      if (/tutorial/.test(k) || k === 'wheelchair.device-id.v1') return k;   // 教程自己的 / 按账号分开的（~p-tutorial）/ 设备号（只读，两边一样）
      return 'wheelchair.v7.tutorial.global:' + k;
    };
    SP.getItem = function (k) { return rawGet.call(this, this === LS ? mapKey(k) : k); };
    SP.setItem = function (k, v) { return rawSet.call(this, this === LS ? mapKey(k) : k, v); };
    SP.removeItem = function (k) { return rawDel.call(this, this === LS ? mapKey(k) : k); };
  } catch (_) {}

  // ── 教程这一格的「已经同意条款 + 已经登录」：钥匙都是教程专用的（first-run-contract.js / backend-client.js 认 __V7_TUTORIAL__），
  //    不碰用户真的同意记录和登录凭证。登录走下面的假后台（/v1/auth/me 回「教程学员」）。
  try {
    root.localStorage.setItem('wheelchair.v7.tutorial.first-use-consent.v1', 'accepted');
    root.localStorage.setItem('wheelchair.v7.tutorial.remembered-login.v1', JSON.stringify({ email: 'tutorial@example.com', token: 'tutorial-token', savedAt: new Date().toISOString() }));
    // 首次设置（setup-center.js）：当作已经做完、已经选好教程里那个假 PS —— 不然设置卡「Photoshop 联动」只写「请先完成首次使用设置」，没有安装按钮
    root.localStorage.setItem('wheelchair.v7.tutorial.setup.local.v1', JSON.stringify({ finishedAt: new Date().toISOString(), photoshopPath: 'C:\\教程\\Photoshop.exe', autoLaunch: false }));
  } catch (_) {}
  // ⚠ 一开机就站在「教程学员」这一格里（storage-namespace.js 读 __WHEELCHAIR_CONTEXT__）。
  //   不这样的话：先在「匿名」格里启动，自动登录后再换到教程账号 —— 预设系统启动到一半被换账号打断，
  //   预设列表是空的，还冒三张「账号已切换」的卡（10-18 实测）。
  //   设备号用这台电脑本来的那个：backend-client 登录前就拿它当设备号，跟下面假后台回的一致，就不会再换一次格子。
  var DEVICE_ID = 'local-device';
  try { DEVICE_ID = root.localStorage.getItem('wheelchair.device-id.v1') || 'local-device'; } catch (_) {}
  root.__WHEELCHAIR_CONTEXT__ = { accountId: 'tutorial', deviceId: DEVICE_ID, profileId: 'tutorial' };

  // ── 演示时锁住：教程页在自动演示时把 __V7_TUTORIAL_LOCKED__ 置真，这时学员真的按键 / 点 / 滚都拦掉，
  //    免得一边演示一边被打乱（用户 10-18 晚要求）。演示自己发的是合成事件（isTrusted=false），照常放行。
  //    ⚠ 最先挂、挂在捕获阶段：要抢在界面自己的监听前面。鼠标那边教程页还有一层透明遮罩挡着，这里主要管键盘和滚轮。
  ['keydown', 'keyup', 'keypress', 'wheel', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu'].forEach(function (type) {
    root.addEventListener(type, function (e) {
      if (!root.__V7_TUTORIAL_LOCKED__ || !e.isTrusted) return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  });
  // ── 断网保险：只放行本软件自己的文件（相对地址 / 同源 / data: / blob:）──
  var origin = root.location.origin;
  function allowed(url) {
    var u = String(url || '');
    if (/^(data|blob):/i.test(u)) return true;
    try { var p = new URL(u, root.location.href); return p.origin === origin || p.protocol === 'file:'; } catch (_) { return false; }
  }
  function blocked(url) {
    try { root.parent.postMessage({ v7tutorial: 'blocked', url: String(url).slice(0, 200) }, '*'); } catch (_) {}
    return new Error('教程里不联网：' + String(url).slice(0, 120));
  }
  var realFetch = root.fetch && root.fetch.bind(root);
  root.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // 本机引擎 / 云端外挂的请求：交给教程假引擎（tutorial-engine.js）现场合成示例结果
    var engine = typeof root.__V7_TUTORIAL_ENGINE__ === 'function' ? root.__V7_TUTORIAL_ENGINE__(url, init) : null;
    if (engine) return engine;
    if (!allowed(url)) return Promise.reject(blocked(url));
    return realFetch(input, init);
  };
  var XO = root.XMLHttpRequest && root.XMLHttpRequest.prototype.open;
  if (XO) root.XMLHttpRequest.prototype.open = function (method, url) {
    if (!allowed(url)) throw blocked(url);
    return XO.apply(this, arguments);
  };
  root.WebSocket = function (url) { throw blocked(url); };
  if (root.navigator && root.navigator.sendBeacon) root.navigator.sendBeacon = function (url) { blocked(url); return false; };

  // ── 跟父页面（假 PS + 教程脚本）说话 ──
  var seq = 0, waiting = {}, listeners = { result: [], event: [], queued: [] };
  function toParent(msg) { try { root.parent.postMessage(Object.assign({ v7tutorial: 1 }, msg), '*'); } catch (_) {} }
  function call(kind, payload) {
    var id = 't' + (++seq);
    return new Promise(function (resolve) { waiting[id] = resolve; toParent({ kind: kind, id: id, payload: payload }); });
  }
  root.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.v7tutorialReply !== 1) return;
    if (d.id && waiting[d.id]) { var fn = waiting[d.id]; delete waiting[d.id]; fn(d.payload); return; }
    // 假 PS 主动推过来的：插件执行结果 / 插件事件（ready、文档变化…）
    if (d.push === 'link:result') listeners.result.forEach(function (cb) { try { cb(d.payload); } catch (_) {} });
    if (d.push === 'link:event') listeners.event.forEach(function (cb) { try { cb(d.payload); } catch (_) {} });
    // ⚠ 不做「父页面发代码过来求值」：软件的 CSP 没开 unsafe-eval，eval 在真软件里必挂。
    //   教程页跟这里同源，要查状态 / 点按钮直接读 iframe.contentWindow（tutorial.js 的 api.app）。
  });
  function on(list) { return function (cb) { if (typeof cb === 'function') list.push(cb); return Promise.resolve(function () { var i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); }); }; }

  // ── 假后台：只回教程用得到的几个接口 ──
  var ACCOUNT = { id: 'tutorial', email: 'tutorial@example.com', display_name: '教程学员', status: 'active', role: 'user', entitlements: [] };
  function backend(url, method, body) {
    var path = '';
    try { path = new URL(url).pathname; } catch (_) { return null; }
    var json = function (status, data) { return { ok: status < 400, status: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }; };
    switch (path) {
      case '/v1/auth/captcha': return json(200, { captchaId: 'tutorial', image: '', question: '教程里随便填' });
      case '/v1/auth/login':
      case '/v1/auth/register': return json(200, { accessToken: 'tutorial-token', account: ACCOUNT, deviceId: DEVICE_ID });
      case '/v1/auth/me': return json(200, { account: ACCOUNT, deviceId: DEVICE_ID });
      // 云端官方预设：教程里不拉（回「没有新的」，不冒「云端预设没拉下来」的卡）
      case '/v1/workflows/official-presets': return json(200, { ok: true, items: [], hash: 'tutorial' });
      case '/v1/auth/logout': return json(200, { ok: true });
      case '/v1/points': return json(200, { ok: true, balances: { common: 5000, banana: 0 }, ledger: [] });
      case '/v1/points/ledger': return json(200, { ok: true, items: [], ledger: [], total: 0 });
      // 阿吉 / 陌陌中转站的余额接口（教程里出图服务是假的阿吉地址）
      case '/api/usage/token': case '/api/usage/token/': return json(200, { success: true, data: { total_available: 50000000, total_used: 0 }, owner_balance_usd: 100 });
      case '/api/status': return json(200, { success: true, data: { status: 'ok' } });
      case '/v1/workflows/availability': return json(200, { ok: true, allowed: true, limits: { maxBatch: 4, concurrent: 1 }, free: true });
      case '/v1/account/notices': return json(200, { ok: true, notices: [] });
      case '/v1/cloud-tools/pass': return json(200, { ok: true, pass: 'tutorial-pass', token: 'tutorial-pass', expiresIn: 900, url: 'https://tutorial-cloud.invalid' });
      case '/health': case '/v1/public/health': return json(200, { ok: true, version: 'tutorial', build: 'tutorial' });
      // 问题反馈：教程里点「发送」不真发（回一条假的「收到了」，什么都不出门）
      case '/v1/feedback': return json(201, { ok: true, id: 'tutorial0000000000000000000000000', createdAt: new Date().toISOString() });
      default:
        if (/^\/v1\/(providers|models|community|support|sync|telemetry|public)/.test(path)) return json(200, { ok: true, items: [], providers: [], models: [] });
        // 没写假回复的接口：记一笔给教程页（自动检查会列出来，好补）
        try { root.parent.postMessage({ v7tutorial: 1, kind: 'backend-miss', payload: { path: path, method: method || 'GET' } }, '*'); } catch (_) {}
        return json(404, { ok: false, code: 'TUTORIAL_OFFLINE', message: '教程里没有这个功能的网络服务' });
    }
  }

  function unavailable(name) { return Promise.resolve({ ok: false, error: '教程里不可用：' + name }); }
  var lastDown = { x: 0, y: 0 }, dragOff = null;
  root.addEventListener('mousedown', function (e) { lastDown = { x: e.screenX, y: e.screenY }; }, true);
  var okEmpty = function () { return Promise.resolve({ ok: true }); };
  var noop = function () { return function () {}; };

  root.uiwin = {
    __tutorial: true,
    platform: 'win32',
    // ── PS 联动：全部交给假 PS ──
    link: {
      enqueue: function (action, p) { return call('link:enqueue', { action: String(action || ''), params: p || {} }); },
      status: function () { return call('link:status', {}); },
      setPollMs: okEmpty,
      onQueued: on(listeners.queued), onResult: on(listeners.result), onEvent: on(listeners.event)
    },
    // ── 出图：教程预制的结果 ──
    ai: {
      generate: function (payload) {
        var taskId = String((payload && payload.taskId) || ('tut-' + Date.now()));
        return call('ai:generate', { taskId: taskId, prompt: payload && payload.prompt, batch: payload && payload.batch, presetId: payload && payload.presetId,
          size: payload && payload.size, aspectRatio: payload && payload.aspectRatio, inputImageBase64: payload && payload.inputImageBase64 }).then(function (r) {
          var results = (r && r.results) || [];
          results.forEach(function (image, i) {
            try { root.dispatchEvent(new CustomEvent('v7-ai-progress', { detail: { taskId: taskId, phase: 'progress', completed: i + 1, total: results.length, index: i, image: image } })); } catch (_) {}
          });
          var out = { ok: results.length > 0, taskId: taskId, results: results, errors: [], stats: { requested: results.length, succeeded: results.length, failed: 0 } };
          try { root.dispatchEvent(new CustomEvent('v7-ai-progress', { detail: Object.assign({ phase: 'complete' }, out) })); } catch (_) {}
          return out;
        });
      },
      cancel: function () { return Promise.resolve({ ok: true, cancelled: false }); },
      onProgress: function (cb) { if (typeof cb !== 'function') return function () {}; var fn = function (e) { cb(e.detail || e); }; root.addEventListener('v7-ai-progress', fn); return function () { root.removeEventListener('v7-ai-progress', fn); }; }
    },
    // ── 网络：只认假后台 ──
    http: {
      fetch: function (req) {
        var r = backend(req && req.url, req && req.method, req && req.body);
        if (r) return Promise.resolve(r);
        blocked(req && req.url);
        return Promise.resolve({ ok: false, status: 0, body: '', error: '教程里不联网' });
      },
      cancel: okEmpty
    },
    // ── 存储 / 窗口这些：回成功空结果，界面照常走 ──
    cache: (function () {
      // 名字照 tauri-adapter.js 的 cache 一个一个对齐（漏一个 = 界面调到时报「不是函数」）。
      // ⚠ 要真能存取（放内存里，关教程就没了）：软件把底版 / 结果写进缓存后会从内存里释放，
      //   要用时再读回来 —— 假装写入、其实不存的话，任务卡 👁 切校色会说「没有底版」（10-18 走查实测），记录卡也是空的。
      var files = new Map(), metas = new Map();
      var k = function (p, r, n) { return String(p) + '\u0001' + String(r) + '\u0001' + String(n || ''); };
      return {
        root: function () { return Promise.resolve(''); },
        writeFile: function (project, runId, name, bytes) {
          var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
          files.set(k(project, runId, name), view.slice());
          return Promise.resolve({ ok: true });
        },
        writeMeta: function (project, runId, meta) { metas.set(k(project, runId), { project: String(project), runId: String(runId), meta: meta || {} }); return Promise.resolve({ ok: true }); },
        readFile: function (project, runId, name) { var b = files.get(k(project, runId, name)); return Promise.resolve(b ? b.slice() : new Uint8Array(0)); },
        list: function () { return Promise.resolve({ ok: true, runs: Array.from(metas.values()), root: '' }); },
        openFolder: okEmpty,
        deleteRun: function (req) { req = req || {}; metas.delete(k(req.project, req.runId)); return Promise.resolve({ ok: true }); },
        deleteOutput: okEmpty, purgeTweenFiles: okEmpty,
        listDeleted: function () { return Promise.resolve({ ok: true, items: [] }); }, restoreDeleted: okEmpty,
        checkpointInventory: function () { return Promise.resolve({ ok: true, items: [], totalBytes: 0 }); }, purgeCheckpoint: okEmpty, purgeDeleted: okEmpty,
        chooseRoot: function () { return Promise.resolve({ ok: false, cancelled: true }); },
        usageReport: function () { return Promise.resolve({ ok: true, total: { bytes: 0, runs: metas.size }, byProject: [], byDate: [] }); }
      };
    })(),
    secrets: { get: function () { return Promise.resolve({ ok: true, value: '' }); }, set: okEmpty, remove: okEmpty, list: function () { return Promise.resolve({ ok: true, names: [] }); } },
    shortcuts: {
      setGeneration: function (v) { keys.generation = String(v || ''); return okEmpty(); },
      setReference: function (v) { keys.reference = String(v || ''); return okEmpty(); },
      setCollapse: function (v) { keys.collapse = String(v || ''); return okEmpty(); },
      // 快捷键在教程里由父页面转发（真软件是系统级快捷键，iframe 收不到）
      onGeneration: function (cb) { listeners.gen = cb; return noop; },
      onReference: function (cb) { listeners.ref = cb; return noop; },
      onCollapse: function (cb) { listeners.col = cb; return noop; }
    },
    // 拖面板：真软件是外壳拖整个窗口；教程里把鼠标位移报给教程页，由它挪 iframe
    setIgnoreMouse: okEmpty, raiseTop: okEmpty,
    dragStart: function () {
      var start = lastDown, move = function (e) {
        try { root.parent.postMessage({ v7tutorial: 1, kind: 'drag', payload: { dx: e.screenX - start.x, dy: e.screenY - start.y } }, '*'); } catch (_) {}
        start = { x: e.screenX, y: e.screenY };
      };
      dragOff = function () { root.document.removeEventListener('mousemove', move, true); dragOff = null; };
      root.document.addEventListener('mousemove', move, true);
      return okEmpty();
    },
    dragEnd: function () { if (dragOff) dragOff(); try { root.parent.postMessage({ v7tutorial: 1, kind: 'drag-end' }, '*'); } catch (_) {} return okEmpty(); },
    freeMode: { set: okEmpty, pulse: okEmpty, onMouseReset: noop, onExitRequest: noop },
    // 看大图：真软件是外壳开一个全屏窗口；教程里把图交给教程页，由它在假 PS 上面盖一层显示
    viewer: (function () {
      var closed = [], navs = [], url = '';
      function show(payload) {
        try {
          if (url) root.URL.revokeObjectURL(url);
          url = root.URL.createObjectURL(new Blob([payload && payload.bytes || new Uint8Array(0)], { type: (payload && payload.mime) || 'image/png' }));
          toParent({ kind: 'viewer', payload: { url: url, num: payload && payload.num, total: payload && payload.total } });
        } catch (_) {}
        return Promise.resolve({ ok: true });
      }
      // 教程页那边关掉 / 切上下张时回调这里（跟真窗口的 viewer:closed / viewer:nav 一样）
      root.__V7_TUTORIAL_VIEWER_CLOSED__ = function () { if (url) { root.URL.revokeObjectURL(url); url = ''; } closed.forEach(function (cb) { try { cb(); } catch (_) {} }); };
      root.__V7_TUTORIAL_VIEWER_NAV__ = function (delta) { navs.forEach(function (cb) { try { cb(delta); } catch (_) {} }); };
      return {
        open: show, update: show, putImage: okEmpty,
        close: function () { toParent({ kind: 'viewer-close' }); root.__V7_TUTORIAL_VIEWER_CLOSED__(); },
        onNav: function (cb) { if (typeof cb === 'function') navs.push(cb); return function () {}; },
        onClosed: function (cb) { if (typeof cb === 'function') closed.push(cb); return function () {}; }
      };
    })(),
    perf: { sample: function () { return Promise.resolve({ ok: false }); } }, perfSample: function () { return Promise.resolve({ ok: false }); },
    engine: {
      environment: function () { return Promise.resolve({ ok: true, ready: false, cloud: true }); },
      models: function () { return Promise.resolve({ ok: true, models: [] }); },
      start: function () { return unavailable('本机引擎'); }, stop: okEmpty, openModelsDir: okEmpty
    },
    // PS 联动：装没装插件由教程页的假 PS 记着（第 1 章「连上 PS」要学员自己装、自己在增效工具里打开面板）
    photoshop: {
      discover: function () { return Promise.resolve({ ok: true, candidates: [{ path: 'C:\\教程\\Photoshop.exe', version: '2025（教程）', source: 'tutorial' }], selectedPath: 'C:\\教程\\Photoshop.exe' }); },
      launch: okEmpty, choose: function () { return Promise.resolve({ ok: false, cancelled: true, candidates: [] }); },
      inspect: function () {
        return call('ps-inspect', {}).then(function (r) {
          var installed = !!(r && r.installed);
          return { ok: true, installed: installed, running: true, installedVersion: installed ? '教程' : '', packageVersion: '教程' };
        });
      },
      // 安装：教程页弹一个假的「用户账户控制」，学员点「是」才算装好（真软件装插件也要管理员权限）
      install: function () { return call('ps-install', {}).then(function (r) { return r && r.ok ? { ok: true, backupId: 'tutorial-backup', installed: true } : { ok: false, cancelled: true }; }); },
      rollback: okEmpty
    },
    update: { check: function () { return Promise.resolve({ ok: true, phase: 'disabled' }); }, status: function () { return Promise.resolve({ ok: true, phase: 'disabled' }); }, install: okEmpty },
    setup: { request: okEmpty, onAction: noop, onClosed: noop },
    // 教程里点「重新看教程」：就在这里，不再开一个
    tutorial: { open: okEmpty, onClosed: function () { return Promise.resolve(function () {}); } },
    planner: { request: function (input) { if (input && input.op === 'quit') toParent({ kind: 'quit' }); return Promise.resolve({ ok: true }); }, onReminder: noop },
    agent: new Proxy({
      // 开机就会问的几个：回「正常、没东西」，别冒「工作区不可用」那种红卡
      upgradeStatus: function () { return Promise.resolve({ ok: true, files: [], officialOnly: false }); },
      tierInfo: function () { return Promise.resolve({ ok: true, name: 'read_only', tier: 'read_only' }); },
      status: function () { return Promise.resolve({ ok: true }); }
    }, { get: function (t, k) { return t[k] || function () { return unavailable('Agent 改软件'); }; } }),
    agentPresets: new Proxy({}, { get: function () { return function () { return unavailable('Agent'); }; } }),
    agentTrace: { append: okEmpty, path: okEmpty },
    browser: new Proxy({}, { get: function () { return function () { return unavailable('内置浏览器'); }; } }),
    // 预设文件：开机会找一遍 V6 老预设（findV6 要回数组，回对象会冒「V6 预设搬家未完成」）
    presetfs: new Proxy({ findV6: function () { return Promise.resolve([]); } }, { get: function (t, k) { return t[k] || function () { return unavailable('预设文件'); }; } }),
    openExternalUrl: function () { return Promise.resolve(false); },
    openBlocking: okEmpty, closeBlocking: okEmpty, onBlockingAction: noop, onBlockingClosed: noop,
    editor: new Proxy({}, { get: function () { return function () { return unavailable('剪影编辑器'); }; } }),
    close: function () { toParent({ kind: 'quit' }); return Promise.resolve(); },
    getPos: function () { return Promise.resolve([0, 0]); },
    restart: okEmpty
  };
  // 快捷键：真软件是系统级全局键（焦点在 PS 里也能按），教程里只能在页面里听 ——
  //   焦点在真界面里：这里的 keydown 自己认；焦点在假 PS 上：父页面把按键交给 __V7_TUTORIAL_KEY__。
  //   键位照用户设置里存的（setGeneration 收到的 'mod+enter' 这种写法），改过键位教程里也按改过的认。
  root.__V7_TUTORIAL_SHORTCUT__ = function (which) {
    var cb = which === 'generation' ? listeners.gen : which === 'reference' ? listeners.ref : which === 'collapse' ? listeners.col : null;
    if (typeof cb === 'function') { cb(); return true; }
    return false;
  };
  function keyMatches(spec, e) {
    var parts = String(spec || '').toLowerCase().split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return false;
    var want = { mod: false, shift: false, alt: false }, key = '';
    parts.forEach(function (p) {
      if (p === 'mod' || p === 'ctrl' || p === 'control' || p === 'commandorcontrol' || p === 'cmdorctrl') want.mod = true;
      else if (p === 'shift') want.shift = true;
      else if (p === 'alt' || p === 'option') want.alt = true;
      else key = p;
    });
    var k = String(e.key || '').toLowerCase();
    if (k === 'return') k = 'enter';
    return !!(e.ctrlKey || e.metaKey) === want.mod && !!e.shiftKey === want.shift && !!e.altKey === want.alt && k === key;
  }
  // 2026-10-18 晚起三个快捷键默认都没有（用户在设置里设了才有，setGeneration 等会把设置值传进来）
  var keys = { generation: '', reference: '', collapse: '' };
  root.__V7_TUTORIAL_KEY__ = function (e) {
    var which = ['collapse', 'reference', 'generation'].find(function (w) { return keyMatches(keys[w], e); });
    if (!which) return '';
    root.__V7_TUTORIAL_SHORTCUT__(which);
    try { root.parent.postMessage({ v7tutorial: 1, kind: 'shortcut', payload: { which: which } }, '*'); } catch (_) {}
    return which;
  };
  root.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.repeat) return;
    // 正在设置里录快捷键：让录键那格自己处理
    var a = root.document.activeElement;
    if (a && a.dataset && /Shortcut$/.test(a.dataset.setting || '')) return;
    if (root.__V7_TUTORIAL_KEY__(e)) e.preventDefault();
  }, true);
  // ── 工作流出图（ComfyUI / Forge 预设、开源模型模式都走它）：教程里换成预制结果 ──
  //   ⚠ 只换「真去服务器跑」这一步（V7Workflows.generate）：前面的预设参数、千问改道、排队、
  //     后面的存图 / 校色 / 任务卡 / 传回全是真代码。开源模型模式一张一张调它，也一起管住了。
  root.addEventListener('DOMContentLoaded', function () {
    var W = root.V7Workflows;
    if (!W || typeof W.generate !== 'function') return;
    W.generate = function (p, task, hooks) {
      hooks = hooks || {};
      try { if (hooks.onProgress) hooks.onProgress({ status: '教程 · 示例结果生成中' }); } catch (_) {}
      return call('ai:generate', { taskId: String(p && p.taskId || ''), batch: p && p.batch, presetId: p && (p.workflowPresetId || p.presetId),
        inputImageBase64: p && p.inputImageBase64, workflow: true }).then(function (r) {
        var results = (r && r.results) || [];
        return { ok: results.length > 0, taskId: p && p.taskId, results: results, errors: [] };
      });
    };
  });
  toParent({ kind: 'hello' });
})(window);
