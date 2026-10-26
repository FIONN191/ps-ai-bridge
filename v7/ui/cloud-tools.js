/* ═══════════════════════════════════════════════════════════
 * V7CloudTools · 云端外挂工具（软件这一侧，2026-10-18，docs/237）
 * ═══════════════════════════════════════════════════════════
 *
 * 用户原话：
 *   「在外挂能力卡片的左上角……新建一个和千问的开关一样……云端外挂模型。打开了之后，挂载能力里面的
 *     和本地相关的部署的内容全部都冻结，变为灰色。然后外挂能力卡片那一栏变为云端的状态，全都启用的状态。」
 *   「云端登录之后直连到本地……不要经过我们的账号服务器」
 *   「云端连不上的时候，就直接降级，要提醒用户，实话实说。然后如果用户是网络环境有问题，要实话实说啊」
 *
 * 做法（一处改道，全部生效）：
 *   软件里所有工具（抠像 / 人体解析 / 指哪抠哪 / 文字找东西 / 细边 / 过渡帧 / 校色）本来都向本机引擎发请求
 *   （http://127.0.0.1:37894 / 37893）。开着云端外挂时，本模块把这些请求【原样改发】到云端门卫：
 *     127.0.0.1:37894/xxx → <云端地址>/m/xxx       127.0.0.1:37893/xxx → <云端地址>/c/xxx
 *   并带上通行证（账号服务器发的，15 分钟有效，快到期自动换新）。
 *   ⚠ 为什么在 fetch 这一层改道、不去改每个工具：调引擎的地方有十几处（ui.html / tween / 校色 / 文字选区 / 夏三六…），
 *     一处一处改必然漏一处 —— 漏掉的那处会【静默地还连本机】，用户以为在用云端。
 *
 * 连不上时（降级，实话实说）：
 *   · 这台电脑有本机引擎（完整包）→ 接下来 2 分钟先用本机引擎，并弹一张说清原因的提示卡；之后自动再试云端。
 *   · 没有本机引擎（不带模型的包）→ 不偷偷假装，直接告诉用户是哪一种情况：
 *       你自己没网 / 你网络正常但云端机器连不上 / 没登录 / 被停用 / 云端排队满了。
 *
 * ⚠ 本模块【不碰】本机引擎的开关、安装、模型下载 —— 那些由外挂能力卡在云端模式下冻结。
 * ═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7CloudTools = api.create(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // 云端门卫只放行这些（跟 backend/cloud-tools-gateway.js 的 ROUTES 一一对应；多了会 404，少了会漏走本机）
  var ROUTES = {
    37894: { prefix: '/m', get: ['/health', '/models'], post: ['/matting', '/segment', '/sam2', '/sam3', '/matte', '/tween'] },
    37893: { prefix: '/c', get: ['/health'], post: ['/process'] }
  };
  // 云端模式下这几条【不许】发到云端（卸模型 / 关引擎），回一个"做了"的假回复，免得界面报错
  var NOOP = ['/unload', '/shutdown'];
  var DEGRADE_MS = 2 * 60 * 1000;
  var PASS_ERROR_HOLD_MS = 20 * 1000;
  var REPORT_GAP_MS = 60 * 1000;
  // ⭐ 2026-10-20 网络防抖（用户：「服务器有抖动，第一下连不上就直接报错……尝试个两三次」）：
  //   一次失败不算失败 —— 网络错 / 超时 / 云端 502·503·504 / 传图卡住 → 等一会儿再试，一共 3 次（业内通行：指数退避 + 随机抖动）。
  //   没登录 / 被停用 / 没配置 / 排队满 这些【再试也一样】的不重试。重试过程不弹卡；3 次都不行才按老规矩降级 / 如实报错（不许完全静默）。
  var RETRY_DELAYS = [500, 1500];
  // 降级后后台自己隔一会儿探一次云端（30 秒 → 1 分钟 → 2 分钟），通了就悄悄切回云端；连着时每分钟探一次活（心跳）
  var RECOVER_STEPS = [30 * 1000, 60 * 1000, 120 * 1000];
  var HEARTBEAT_MS = 60 * 1000;

  function create(root, hostIn) {
    var host = hostIn || {};
    var origFetch = null;
    var installed = false;
    var pass = null;            // { value, url, exp(ms) }
    var passing = null;         // 正在领的 Promise
    var passError = null;       // { why, at }
    var degradedUntil = 0;
    var lastWhy = null;
    var health = { state: 'idle', at: 0, ms: null, busy: null, slots: null, waiting: null };
    var listeners = new Set();
    var reported = {};
    var localCache = { at: 0, value: null };
    var retrying = 0;            // 正在「等一会儿再试」的请求个数（状态显示「正在重连」）
    var degradeNoticed = false;  // 这次降级有没有跟用户说过（后台悄悄降级的，第一次真去用工具时要说）
    var watchTimer = null, watchStep = 0, watchAt = 0;

    function now() { return typeof host.now === 'function' ? host.now() : Date.now(); }
    function sleep(ms) {
      if (typeof host.sleep === 'function') return Promise.resolve(host.sleep(ms));
      return new Promise(function (r) { setTimeout(r, ms); });
    }
    // 第 n 次重试前等多久：0.5 秒 / 1.5 秒，上下浮动三成（大家同一时刻断线时别同一时刻一起冲回来）
    function backoff(n, hint) {
      if (hint > 0) return Math.min(5000, hint);
      var base = RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length) - 1];
      return Math.round(base * (0.7 + Math.random() * 0.6));
    }
    function transientStatus(s) { return s === 502 || s === 503 || s === 504; }
    function transientError(e) {
      if (!e || e.name === 'AbortError' || e.kind) return false;
      if (e.stall) return true;
      if (e.status) return e.status >= 500;
      return e instanceof TypeError || /fetch|network|timeout|timed out|ECONN|socket/i.test(String(e.message || e));
    }
    function retryAfterMs(headers) {
      var v = Number(headers && headers.get && headers.get('retry-after'));
      return v > 0 ? v * 1000 : 0;
    }
    // 包一层「失败了等一会儿再试」：fn 每次都从头做；again(结果, 错误) 说这次算不算「抖了一下」
    function withRetry(fn, again, onRetry) {
      var n = 0;
      var go = function () {
        return Promise.resolve().then(fn).then(function (v) {
          var hint = again(v, null);
          return hint !== false && n < RETRY_DELAYS.length ? wait(hint).then(go) : v;
        }, function (e) {
          var hint = again(null, e);
          if (hint !== false && n < RETRY_DELAYS.length) return wait(hint).then(go);
          throw e;
        });
      };
      var wait = function (hint) {
        n++;
        retrying++; notify();
        if (typeof onRetry === 'function') { try { onRetry(n); } catch (_) {} }
        return sleep(backoff(n, typeof hint === 'number' ? hint : 0)).then(function () { retrying--; notify(); }, function () { retrying--; notify(); });
      };
      return go();
    }
    function enabled() {
      try { return typeof host.getMode === 'function' ? host.getMode() === true : false; } catch (_) { return false; }
    }
    function degraded() { return degradedUntil > now(); }
    function routing() { return enabled() && !degraded(); }

    function notify() {
      var s = status();
      listeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
    }
    function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }

    function report(code, why, extra) {
      var key = code + ':' + (why && why.kind);
      // ⚠ 没登录 / 被停用 / 没配置 这三种【用户自己知道、一时也改不了】—— 10 分钟才提醒一次，别每分钟弹卡
      var gap = why && /^(no-login|banned|unconfigured)$/.test(why.kind) ? 10 * REPORT_GAP_MS : REPORT_GAP_MS;
      if (reported[key] && now() - reported[key] < gap) return;
      reported[key] = now();
      try { if (typeof host.report === 'function') host.report(code, Object.assign({ severity: 'L2', stage: 'cloud-tools', message: why ? why.text : '' }, extra || {})); } catch (_) {}
    }

    // ── 本机引擎在不在（降级能不能退到本机）── 缓存 1 分钟：这个判断要读磁盘
    function localAvailable() {
      if (localCache.at && now() - localCache.at < 60000) return Promise.resolve(localCache.value);
      return Promise.resolve()
        .then(function () { return typeof host.localAvailable === 'function' ? host.localAvailable() : false; })
        .catch(function () { return false; })
        .then(function (v) { localCache = { at: now(), value: !!v }; return !!v; });
    }

    // ── 通行证 ──
    function forgetPass() { pass = null; passError = null; }
    function ensurePass(force) {
      // 剩下不到「90 秒 / 有效期的三分之一」就换新（有效期很短时别每次都去领）
      if (!force && pass && pass.exp - now() > Math.min(90 * 1000, pass.ttl / 3)) return Promise.resolve(pass);
      if (!force && passError && now() - passError.at < PASS_ERROR_HOLD_MS) return Promise.reject(passError.why);
      if (passing) return passing;
      passing = Promise.resolve()
        .then(function () {
          if (typeof host.signedIn === 'function' && !host.signedIn()) {
            throw why('no-login', '没登录 —— 云端外挂要先登录账号才能用（登录后会自动接上）');
          }
          if (!host.backendPass) throw why('unconfigured', '这个版本的软件没有云端外挂入口');
          // 账号服务器没回话 / 回 5xx：抖一下再领（没登录 / 404 / 被停用 不重试）
          return withRetry(function () { return host.backendPass(); }, function (v, e) {
            if (!e) return false;
            var w = e.kind ? e : classifyPassError(e);
            return w.kind === 'network' || (w.kind === 'account-down' && (Number(e.status) || 0) >= 500) ? 0 : false;
          });
        })
        .then(function (r) {
          if (!r || !r.pass || !r.url) throw why('unconfigured', '账号服务器没给出云端地址');
          var ttl = Math.max(60, Number(r.expiresIn) || 900) * 1000;
          pass = { value: String(r.pass), url: String(r.url).replace(/\/+$/, ''), exp: now() + ttl, ttl: ttl };
          passError = null;
          return pass;
        }, function (e) {
          var w = e && e.kind ? e : classifyPassError(e);
          if (w.kind === 'network') return diagnose(pass && pass.url).then(function (d) { throw d; });
          throw w;
        })
        .catch(function (w) { passError = { why: w, at: now() }; pass = null; throw w; })
        .finally(function () { passing = null; });
      return passing;
    }
    function why(kind, text, code) { return { kind: kind, text: text, code: code || ('CLOUD_TOOLS_' + kind.toUpperCase().replace(/-/g, '_')) }; }
    function classifyPassError(e) {
      var code = String(e && e.code || '');
      var msg = String(e && e.message || e || '');
      var status = Number(e && e.status) || 0;
      if (code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID') return why('no-login', '登录已失效 —— 重新登录后云端外挂会自动接上', code);
      if (code === 'CLOUD_TOOLS_BANNED') return why('banned', msg || '你的云端外挂工具已被停用', code);
      if (code === 'CLOUD_TOOLS_UNCONFIGURED') return why('unconfigured', msg || '云端外挂还没配置好', code);
      // ⚠ 账号服务器【回了话】（有 HTTP 状态）就不是网络问题 —— 10-18 用户实测：线上还是老版本、没有发证接口（404），
      //   原来一律当成「网络不通」去探网，又因为探网的 bug 报成「连百度都连不上」，两层错叠在一起。
      if (status === 404 || code === 'NOT_FOUND') return why('unconfigured', '账号服务器还没开通云端外挂（线上版本太老，要升级到 1.8.1 以上）', code || 'NOT_FOUND');
      if (status >= 500) return why('account-down', '账号服务器出错了（' + (msg || status) + '），领不到云端通行证', code);
      if (status >= 400) return why('account-down', '账号服务器没给云端通行证（' + (msg || status) + '）', code);
      return why('network', msg);
    }

    // ── 实话实说：连不上到底是谁的问题 ──
    //   ① 系统说断网了 → 你没网；
    //   ② 百度和账号服务器都连不上 → 你这边网络有问题；
    //   ③ 别的都通、只有云端不通 → 云端机器的问题（重启 / 维护）；
    //   ④ 现在又通了 → 刚才网络抖了一下。
    function probe(url, ms) {
      if (typeof host.probe !== 'function' || !url) return Promise.resolve(false);
      return Promise.resolve().then(function () { return host.probe(url, ms || 6000); }).then(function (v) { return !!v; }, function () { return false; });
    }
    function diagnose(cloudUrl) {
      try { if (typeof host.online === 'function' && host.online() === false) return Promise.resolve(why('offline', '你的电脑现在没联网（系统显示断网了）—— 连上网再用云端外挂')); } catch (_) {}
      return Promise.all([
        cloudUrl ? probe(cloudUrl + '/health') : Promise.resolve(null),
        probe(typeof host.accountHealthUrl === 'function' ? host.accountHealthUrl() : ''),
        probe('https://www.baidu.com/')
      ]).then(function (r) {
        var cloud = r[0], account = r[1], baidu = r[2];
        if (!baidu && !account) return why('offline', '你这边的网络有问题：连百度和我们的账号服务器都连不上。看看网线 / Wi-Fi，或者代理软件是不是挡住了');
        if (cloud === false) {
          return why('cloud-down', '你的网络是好的（' + (baidu ? '能上百度' : '') + (baidu && account ? '、' : '') + (account ? '账号服务器也通' : '') + '），是云端机器暂时连不上 —— 可能正在重启或维护，一般几分钟就好');
        }
        if (!account) return why('account-down', '账号服务器暂时连不上（你的网络能上百度），领不到云端通行证');
        return why('flaky', '刚才那一下没连上云端，但现在又能连上了 —— 多半是网络抖了一下，再试一次');
      });
    }

    // ── 云端门卫探活（不要通行证）── 一次没通不算：抖一下再探，3 次都不通才算「不在」
    function checkGateway(url) {
      var t0 = 0, tries = 0;
      return withRetry(function () {
        t0 = now();
        // 第一次多给点时间（冷启动 / 慢网），后面两次短一点，免得用户干等
        return origFetchFn()(url + '/health', { cache: 'no-store', signal: timeoutSignal(tries++ ? 5000 : 8000) })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(Object.assign(new Error('HTTP ' + r.status), { status: r.status })); });
      }, function (v, e) { return e && (transientError(e) || e.name === 'TimeoutError' || e.name === 'AbortError') ? 0 : false; })
        .then(function (b) {
          health = { state: 'ready', at: now(), ms: now() - t0, busy: b.busy, slots: b.slots, waiting: b.waiting };
          return true;
        }, function () { health = Object.assign({}, health, { state: 'down', at: now() }); return false; });
    }
    function timeoutSignal(ms) {
      try { return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined; } catch (_) { return undefined; }
    }

    // 用工具之前问一句（ui.html 的 toolEngineReady 调）：
    //   { route:'cloud' }  —— 走云端；
    //   { route:'local', why } —— 云端不行、退回本机（已提示用户）；
    //   { route:'none',  why } —— 云端不行、本机也没有（已提示用户；接着发请求会拿到同样的话）。
    function ensureReady(opts) {
      var quiet = !!(opts && opts.quiet);
      if (!enabled() || degraded()) return Promise.resolve({ route: 'local' });
      return ensurePass()
        .then(function (p) {
          return checkGateway(p.url).then(function (ok) {
            if (ok) { lastWhy = null; watchStep = 0; scheduleWatch(HEARTBEAT_MS); notify(); return { route: 'cloud' }; }
            return diagnose(p.url).then(function (w) { return fallback(w, quiet); });
          });
        }, function (w) { return fallback(w, quiet); });
    }
    // quiet：开软件时那一次后台检查 —— 只更新状态（外挂能力卡上看得到），【不弹卡】。
    //   ⚠ 真界面截图抓到：不带模型的包、还没登录的人，一开软件就弹「云端外挂现在用不了 —— 没登录」，人还什么都没干。
    //     要等他真去用工具 / 亲手点开关时才说。
    //   ⚠ 2026-10-20：后台悄悄降级的，等他【第一次真去用工具】时补说一次（见 fetchRoute）—— 不许完全静默地换成本机算。
    function fallback(w, quiet) {
      lastWhy = w;
      // 后台接着隔一会儿探一次云端，通了自动切回（没登录的等登录那一刻再接，见 ui.html；这里也照样慢慢探）
      if (w.kind !== 'busy') scheduleWatch(RECOVER_STEPS[0]);
      return localAvailable().then(function (local) {
        if (local && w.kind !== 'busy') {
          degradedUntil = now() + DEGRADE_MS;
          degradeNoticed = !quiet;
          if (!quiet) report('CLOUD_TOOLS_FALLBACK', w, { message: w.text + ' —— 接下来先用这台电脑的本机引擎，云端好了会自动切回去。' });
          notify();
          return { route: 'local', why: w };
        }
        if (!quiet) report('CLOUD_TOOLS_UNAVAILABLE', w, { message: w.text + (local ? '' : '（这个安装包没带本机引擎，只能等云端好了再用）') });
        notify();
        return { route: 'none', why: w };
      });
    }

    // ── 后台看护（2026-10-20）：一个定时器两种节奏 ──
    //   · 连着云端：每分钟探一次活（心跳），顺便刷新延迟 / 排队数；探不通 → 跟开软件那次一样【不弹卡】只改状态（并悄悄降级）。
    //   · 连不上 / 降级中：30 秒 → 1 分钟 → 2 分钟 探一次，通了就悄悄切回云端（状态变回「云端在线」）。
    //   都是后台的事，不弹卡；用户真去用工具时如果还不行，照老规矩说清原因。
    function scheduleWatch(ms) {
      if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
      if (!enabled()) return;
      watchTimer = setTimeout(function () { watchTimer = null; watchTick(); }, ms);
      if (watchTimer && watchTimer.unref) watchTimer.unref();
    }
    function stopWatch() { if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; } watchStep = 0; }
    function troubled() { return degraded() || !!(lastWhy && lastWhy.kind !== 'busy'); }
    function watchTick() {
      if (!enabled()) { stopWatch(); return Promise.resolve('off'); }
      watchAt = now();
      var wasTrouble = troubled();
      var still = function (w) {
        lastWhy = w;
        // 降级中探了还是不通：接着用本机（别到点又去连云端、让用户干等 3 次重试）
        if (degradedUntil) degradedUntil = Math.max(degradedUntil, now() + DEGRADE_MS);
        else if (!wasTrouble) return fallback(w, true).then(function () { return 'down'; });
        var step = RECOVER_STEPS[Math.min(watchStep++, RECOVER_STEPS.length - 1)];
        scheduleWatch(step);
        notify();
        return 'down';
      };
      return ensurePass(wasTrouble).then(function (p) {
        return checkGateway(p.url).then(function (ok) {
          if (ok) {
            if (wasTrouble) { degradedUntil = 0; lastWhy = null; degradeNoticed = false; }
            watchStep = 0;
            scheduleWatch(HEARTBEAT_MS);
            notify();
            return 'ready';
          }
          return diagnose(p.url).then(still);
        });
      }, still);
    }
    // 网络恢复 / 窗口切回来：有问题的话【马上】探一次（不用等定时器）
    function nudge() {
      if (!enabled() || !troubled()) return;
      if (now() - watchAt < 10 * 1000) return;
      if (passError) passError = null;
      watchTick();
    }

    // ── 改道 ──
    function target(input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var u;
      try { u = new URL(url); } catch (_) { return null; }
      if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return null;
      var r = ROUTES[Number(u.port)];
      if (!r) return null;
      return { route: r, path: u.pathname, search: u.search, url: url };
    }
    function methodOf(input, init) {
      return String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    }
    function cloudable(t, method) {
      var list = method === 'POST' ? t.route.post : method === 'GET' ? t.route.get : [];
      return list.indexOf(t.path) >= 0;
    }
    function jsonResponse(status, body) {
      return new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    function origFetchFn() { return origFetch || (host.fetch ? host.fetch : root.fetch.bind(root)); }

    function sendCloud(p, t, input, init) {
      var headers = new Headers((init && init.headers) || (input && typeof input === 'object' && input.headers) || {});
      headers.set('Authorization', 'Bearer ' + p.value);
      var opts = Object.assign({}, init || {}, { headers: headers, cache: 'no-store' });
      delete opts.__v7Local;
      delete opts.__v7Job;
      return origFetchFn()(p.url + t.route.prefix + t.path + t.search, opts);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  ⭐⭐ 2026-10-19 云端任务队列（docs/249，用户：「主要是排序、并发和软件层有问题，太多静默等待和无状态标注」）
    //
    //  调强度 / 应用 / 校色 / 补细节 / 切校色版本 这几种【用户等着看】的云端活，不再各发各的：
    //   ① 排序：用户正盯着的（优先级 0）先；生成时的校色（1）按张号；后台的（2）最后。
    //   ② 上传只走一条道：带宽是瓶颈，6 张一起传等于 6 张一起慢；一条一条传第一张最快出来。
    //   ③ 同一张图只传一次：先问云端「这个指纹你有没有」，有就不传（同一任务的原图、「应用」时的两张图都不用再传）。
    //      门卫拿指纹拼回原字节交给引擎 —— 引擎收到的跟整包上传逐字节一样（画质不可能变）。
    //   ④ 每一步都有状态：本机排队（前面几个）→ 上传百分比 → 云端排队（第几位、等了多久）→ 处理中 → 接收百分比 → 完成（用时分解）。
    //      界面（任务卡底栏、缩略图角标、调强度大框）订阅 onJob 自己画。文案中性，不说具体在算什么（10-04 用户定的藏意图）。
    //   ⑤ 卡住才算失败（上传 / 接收 25 秒没进展），不再用「整单 60 秒」一刀切 —— 排队只要还在往前走就一直等。
    //  老门卫（没有 features.blobs）或者请求体拆不开 → 照老办法整包发，但照样有状态。
    // ══════════════════════════════════════════════════════════════════════════
    var JOB_TOOLS = { '/tween': 'tween', '/process': 'color' };
    var jobs = new Map();
    var jobListeners = new Set();
    var jobSeq = 0;
    var upQueue = [];          // 等着上传的 { job, seq, start, fail }
    var upActive = 0;
    var UP_LANES = 1;          // 同时上传几条（带宽是瓶颈：1 条）
    var STALL_MS = 25000;
    var POLL_MS = 700;
    var features = null;       // 门卫支持哪些新功能（/health 回的 features）；null = 还没问
    var featuresAt = 0;
    var rate = { bytes: 0, ms: 0 }; // 最近一次上传的量和用时（给状态行算上行速度）
    var blobInflight = new Map();   // 指纹 -> { job, promise }：正在传的图（别的单要同一张就等它）

    function jobSnapshot(j) {
      return { id: j.id, kind: j.kind, label: j.label, taskId: j.taskId, shot: j.shot, priority: j.priority, stage: j.stage,
        pct: j.pct, ahead: j.ahead, position: j.position, waitedMs: j.waitedMs, bytes: j.bytes, total: j.total,
        startedAt: j.startedAt, doneAt: j.doneAt, timing: Object.assign({}, j.timing), cloud: j.cloud ? Object.assign({}, j.cloud) : null,
        error: j.error, saved: j.saved, mode: j.mode, retry: j.retry || 0 };
    }
    var emitTimer = null, emitDirty = new Set();
    function flushJobs() {
      emitTimer = null;
      var ids = Array.from(emitDirty); emitDirty.clear();
      ids.forEach(function (id) {
        var jj = jobs.get(id) || retired.get(id); if (!jj) return;
        var snap = jobSnapshot(jj);
        jobListeners.forEach(function (fn) { try { fn(snap); } catch (_) {} });
      });
      notify();
    }
    var retired = new Map();   // 刚结束、还要再发一次「结束」事件的单
    function emitJob(j, now_) {
      emitDirty.add(j.id);
      if (now_) { if (emitTimer) clearTimeout(emitTimer); flushJobs(); return; }
      if (!emitTimer) emitTimer = setTimeout(flushJobs, 120);
    }
    function setStage(j, stage, extra) {
      if (j.stage === 'done' || j.stage === 'failed') return;          // 结束了就不再动
      var t = now();
      if (j.stage !== stage) {
        if (j.stageAt) j.timing[j.stage] = (j.timing[j.stage] || 0) + (t - j.stageAt);
        j.stage = stage; j.stageAt = t;
      }
      if (extra) Object.keys(extra).forEach(function (k) { j[k] = extra[k]; });
      var terminal = stage === 'done' || stage === 'failed';
      // ⚠ 结束时间要在【发通知之前】记上 —— 原来记在后面，界面收到的「完成」那一条 doneAt 还是 0，
      //   显示成「完成 · -1792398964.8 秒」（模拟实测抓到）
      if (terminal) j.doneAt = t;
      emitJob(j, terminal || stage !== j.lastEmittedStage);
      j.lastEmittedStage = stage;
      if (terminal) {
        jobs.delete(j.id); retired.set(j.id, j);
        var keep = setTimeout(function () { retired.delete(j.id); }, 4000);
        if (keep && keep.unref) keep.unref();
      }
    }
    function newJob(hint, tool) {
      var h = hint || {};
      var j = { id: 'job-' + now().toString(36) + '-' + (++jobSeq) + '-' + Math.random().toString(36).slice(2, 8),
        qseq: jobSeq,
        kind: String(h.kind || tool), label: String(h.label || ''), taskId: h.taskId != null ? String(h.taskId) : '', shot: h.shot != null ? Number(h.shot) : -1,
        priority: Math.max(0, Math.min(2, h.priority == null ? 1 : Number(h.priority))), stage: 'prepare', stageAt: now(), pct: 0, ahead: 0, position: 0,
        waitedMs: 0, bytes: 0, total: 0, startedAt: now(), doneAt: 0, timing: {}, cloud: null, error: '', saved: 0, mode: '', upDone: 0, upTotal: 0 };
      j.upPrio = j.priority;
      jobs.set(j.id, j);
      emitJob(j, true);
      return j;
    }
    function abortError() {
      try { return new DOMException('已取消', 'AbortError'); } catch (_) { var e = new Error('已取消'); e.name = 'AbortError'; return e; }
    }

    // ── 门卫支不支持新协议（问一次缓存 5 分钟；问不到当不支持，照老办法）──
    function gatewayFeatures(p) {
      if (features && now() - featuresAt < 5 * 60 * 1000) return Promise.resolve(features);
      return Promise.resolve()
        .then(function () { return origFetchFn()(p.url + '/health', { cache: 'no-store', signal: timeoutSignal(8000) }); })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (b) { features = (b && b.features) || {}; featuresAt = now(); return features; }, function () { return {}; });
    }

    // ── 传输：有 XMLHttpRequest 就用它（能拿上传 / 接收进度），没有（测试环境）就退回 fetch ──
    //   phase：'blob' 只传一张图（PUT）；'whole' 老办法整包（先上传、再等云端、再接收）；'wait' 拼图请求（不带图，等云端、再接收）
    function xhrSend(method, url, headers, body, j, phase, signal) {
      var X = root.XMLHttpRequest;
      if (typeof X !== 'function') {
        return origFetchFn()(url, { method: method, headers: new Headers(headers || {}), body: body, cache: 'no-store', signal: signal })
          .then(function (r) {
            if (phase === 'whole') setStage(j, 'cloud-queue');
            return r.arrayBuffer().then(function (buf) { return { status: r.status, headers: r.headers, buf: buf }; });
          });
      }
      return new Promise(function (resolve, reject) {
        var x = new X();
        var last = now(), stall = null, done = false;
        var finish = function (fn, v) { if (done) return; done = true; clearInterval(stall); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
        var onAbort = function () { try { x.abort(); } catch (_) {} finish(reject, abortError()); };
        if (signal) { if (signal.aborted) return reject(abortError()); signal.addEventListener('abort', onAbort); }
        x.open(method, url, true);
        x.responseType = 'arraybuffer';
        Object.keys(headers || {}).forEach(function (k) { x.setRequestHeader(k, headers[k]); });
        var hasBody = body != null;
        if (x.upload && hasBody) {
          x.upload.onprogress = function (e) {
            last = now();
            // 传图：一单要传几张就合成一条进度（传完第一张不会从 0% 重新来）
            var base = phase === 'blob' ? (j.upDone || 0) : 0;
            var tot = phase === 'blob' && j.upTotal ? j.upTotal : (e.lengthComputable ? e.total : 0);
            var got = base + e.loaded;
            setStage(j, 'upload', { bytes: got, total: tot, pct: tot ? Math.min(100, Math.round(got / tot * 100)) : 0 });
          };
          x.upload.onload = function () {
            last = now();
            // 整包老办法：图传完了，接下来是云端排队 / 处理（单号查询会把它细分成「排第几 / 处理中」）
            if (phase === 'whole') setStage(j, 'cloud-queue', { pct: 0 });
          };
        }
        x.onprogress = function (e) {
          last = now();
          if (phase === 'blob') return;     // 传图的回执只有几十字节，不算「接收结果」
          var tot = e.lengthComputable ? e.total : 0;
          setStage(j, 'download', { bytes: e.loaded, total: tot, pct: tot ? Math.round(e.loaded / tot * 100) : 0 });
        };
        // ⚠ 卡住检测：只在【应该有数据在走】的阶段算（上传中 / 接收中）；云端排队、处理中不算卡住（单号查询盯着）
        stall = setInterval(function () {
          if ((j.stage === 'upload' || j.stage === 'download') && now() - last > STALL_MS) {
            var up = j.stage === 'upload';
            try { x.abort(); } catch (_) {}
            finish(reject, Object.assign(new Error((up ? '上传' : '接收结果') + '卡住了（' + Math.round(STALL_MS / 1000) + ' 秒没有任何进展），多半是网络断了一下'), { stall: true }));
          }
        }, 1000);
        x.onload = function () {
          var hs = new Headers();
          String(x.getAllResponseHeaders() || '').trim().split(/[\r\n]+/).forEach(function (line) {
            var i = line.indexOf(':'); if (i > 0) { try { hs.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch (_) {} }
          });
          finish(resolve, { status: x.status, headers: hs, buf: x.response || new ArrayBuffer(0) });
        };
        x.onerror = function () { finish(reject, new TypeError('Failed to fetch')); };
        x.send(hasBody ? body : null);
      });
    }

    // ── 上传道：按（优先级，这一单开始的先后，同一单里的先后）一条一条传 ──
    //   ⚠ 同一单要传两张时，两张是【一起】排进来的（见 viaBlobs），挨着传，别人插不进来。
    //     （模拟实测抓到：原来传完第一张才去排第二张，那一瞬间道空着，别的单的图先上了 —— 第一张校色多等 4～5 秒。）
    //   ⚠ 排序用 upPrio 不用 priority：别的急单在等这一单正在传的同一张图时，只把【上传】往前提，
    //     不改这一单在云端的优先级。
    var upSeq = 0;
    var upNowJobs = new Set();   // 正在传图的单（状态留在「上传」，不被改成「等待中」）
    function uploadSlot(j) {
      return new Promise(function (resolve, reject) {
        upQueue.push({ job: j, seq: ++upSeq, start: resolve, fail: reject });
        pumpUploads();
        aheadRefresh();
      });
    }
    function upOrder(a, b) { return a.job.upPrio - b.job.upPrio || a.job.qseq - b.job.qseq || a.seq - b.seq; }
    // 「前面 N 个」按【单】数，不按图数（一单两张图算一个）
    function aheadRefresh() {
      var before = new Set(upNowJobs), seen = new Set();
      upQueue.slice().sort(upOrder).forEach(function (it) {
        var jj = it.job;
        if (seen.has(jj)) return;
        seen.add(jj);
        if (!upNowJobs.has(jj)) {
          var ahead = before.size;
          if (jj.stage !== 'local-queue' || jj.ahead !== ahead) setStage(jj, 'local-queue', { ahead: ahead });
        }
        before.add(jj);
      });
    }
    function pumpUploads() {
      while (upActive < UP_LANES && upQueue.length) {
        upQueue.sort(upOrder);
        var it = upQueue.shift();
        upActive++;
        upNowJobs.add(it.job);
        it.start((function (jj) {
          var released = false;
          return function release() {
            if (released) return;
            released = true; upActive--; upNowJobs.delete(jj);
            pumpUploads(); aheadRefresh();
          };
        })(it.job));
      }
    }
    function dropQueued(j) {
      for (var i = upQueue.length - 1; i >= 0; i--) if (upQueue[i].job === j) { upQueue.splice(i, 1)[0].fail(abortError()); }
      aheadRefresh();
    }

    function sha256Hex(bytes) {
      var subtle = root.crypto && root.crypto.subtle;
      if (!subtle) return Promise.reject(new Error('没有 crypto.subtle'));
      return subtle.digest('SHA-256', bytes).then(function (buf) {
        return Array.from(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    }
    function toBytes(v) {
      if (v == null) return Promise.resolve(null);
      if (v instanceof Uint8Array) return Promise.resolve(v);
      if (v instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(v));
      if (ArrayBuffer.isView && ArrayBuffer.isView(v)) return Promise.resolve(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      if (typeof Blob !== 'undefined' && v instanceof Blob) return v.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      return Promise.resolve(null);
    }
    // 把请求体拆成「几张图 + 拼法」。拆不开（字符串、未知格式）→ null，走整包老办法。
    function decompose(tool, init) {
      var body = init && init.body;
      var hs = new Headers((init && init.headers) || {});
      if (tool === 'tween') {
        var headLen = Number(hs.get('x-head-len') || 0);
        return toBytes(body).then(function (u8) {
          if (!u8 || !(headLen > 0) || headLen >= u8.length) return null;
          return { spec: { t: 'concat', headLen: true, ct: hs.get('content-type') || 'application/octet-stream' }, parts: [u8.subarray(0, headLen), u8.subarray(headLen)] };
        });
      }
      if (tool === 'color' && typeof FormData !== 'undefined' && body instanceof FormData) {
        var fields = {}, files = [], waits = [];
        body.forEach(function (v, k) {
          if (typeof v === 'string') { fields[k] = v; return; }
          var f = { n: k, f: v.name || k, ct: v.type || 'application/octet-stream' };
          files.push(f);
          waits.push(toBytes(v).then(function (u8) { f.bytes = u8; }));
        });
        if (!files.length || files.length > 4) return Promise.resolve(null);
        return Promise.all(waits).then(function () {
          if (files.some(function (f) { return !f.bytes; })) return null;
          return { spec: { t: 'form', fields: fields, files: files.map(function (f) { return { n: f.n, f: f.f, ct: f.ct }; }) }, parts: files.map(function (f) { return f.bytes; }) };
        });
      }
      return Promise.resolve(null);
    }

    function pollStatus(pp, j, reqId, alive) {
      if (!alive()) return;
      origFetchFn()(pp().url + '/q/' + reqId, { headers: { Authorization: 'Bearer ' + pp().value }, cache: 'no-store', signal: timeoutSignal(5000) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s || !alive()) return;
          // ⚠ 只往前走：已经在接收结果了，迟到的「还在处理」回执不许把状态拉回去
          if (j.stage === 'download' || j.stage === 'upload' || j.stage === 'local-queue') return;
          if (s.stage === 'queued') setStage(j, 'cloud-queue', { position: s.position, waitedMs: s.waitedMs });
          else if (s.stage === 'running') setStage(j, 'processing', { position: 0, waitedMs: s.waitedMs });
        }, function () {})
        .then(function () { if (alive()) { var tt = setTimeout(function () { pollStatus(pp, j, reqId, alive); }, POLL_MS); if (tt && tt.unref) tt.unref(); } });
    }

    // 一单云端活：拆 → 算指纹 → 问云端缺哪张 → 排队上传缺的 → 发「拼图」请求 → 盯状态 → 收结果
    //   返回一个普通的 Response（调用方照旧 res.ok / res.text() / res.arrayBuffer()，一行都不用改）。
    function sendJob(p0, t, input, init, tool) {
      var p = p0;
      var j = newJob(init && init.__v7Job, tool);
      var signal = init && init.signal;
      var reqBase = 'r' + j.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-36);
      var reqId = reqBase;
      var finished = false;
      var alive = function () { return !finished; };
      if (signal) signal.addEventListener('abort', function () { j.cancelled = true; dropQueued(j); });
      var renewed = false;
      var headersFor = function () {
        var h = {};
        new Headers((init && init.headers) || {}).forEach(function (v, k) { if (k !== 'content-length') h[k] = v; });
        h['authorization'] = 'Bearer ' + p.value;
        h['x-v7-req'] = reqId;
        h['x-v7-priority'] = String(j.priority);
        return h;
      };
      var url = function () { return p.url + t.route.prefix + t.path + t.search; };
      // 通行证过期：换一张再来（只换一次）
      var renew = function () {
        if (renewed) return Promise.reject(Object.assign(new Error('云端通行证换了新的还是不认'), { status: 401 }));
        renewed = true; forgetPass();
        return ensurePass(true).then(function (p2) { p = p2; });
      };
      var asResult = function (status) { return { status: status, headers: new Headers(), buf: new ArrayBuffer(0) }; };

      function uploadOne(bytes, hash) {
        return uploadSlot(j).then(function (release) {
          if (j.cancelled) { release(); throw abortError(); }
          var tot = j.upTotal || bytes.byteLength;
          setStage(j, 'upload', { bytes: j.upDone, total: tot, pct: tot ? Math.round(j.upDone / tot * 100) : 0 });
          var t0 = now();
          return xhrSend('PUT', p.url + '/b/' + hash, { authorization: 'Bearer ' + p.value }, bytes, j, 'blob', signal)
            .then(function (r) {
              release();
              var ms = now() - t0;
              if (ms > 300 && bytes.byteLength > 256 * 1024) { rate.bytes = bytes.byteLength; rate.ms = ms; }
              if (r.status === 401) return renew().then(function () { return uploadOne(bytes, hash); });
              if (r.status !== 201) throw Object.assign(new Error('图没传上去（云端回 ' + r.status + '）'), { status: r.status });
              j.upDone += bytes.byteLength;
            }, function (e) { release(); throw e; });
        });
      }
      function legacy() {
        // 整包老办法（老门卫 / 拆不开的请求体）：照样排上传道、照样有状态
        j.mode = 'whole';
        // ⚠ 2026-10-20 真软件实测抓到：线上老门卫的跨域白名单只认 authorization / content-type / x-head-len / x-params / x-matting-params，
        //   带上 x-v7-req / x-v7-priority 浏览器预检就拦掉（Failed to fetch）⇒ 云端调强度 / 校色整个用不了、悄悄退回本机。
        //   （模拟实测在 Node 里跑，不管跨域，没测出来。）老门卫也用不上这两个头 ⇒ 不是新门卫就不带；新门卫照旧带（排队优先级要用）。
        var legacyHeaders = function () {
          var h = headersFor();
          if (!(features && features.blobs)) { delete h['x-v7-req']; delete h['x-v7-priority']; }
          return h;
        };
        return uploadSlot(j).then(function (release) {
          if (j.cancelled) { release(); throw abortError(); }
          setStage(j, 'upload', { bytes: 0, total: 0, pct: 0 });
          var poll = setTimeout(function () { pollStatus(function () { return p; }, j, reqId, alive); }, POLL_MS);
          var released = false, rel = function () { if (!released) { released = true; release(); } };
          // 上传传完就把道让出来（不用等云端算完）
          var watch = setInterval(function () { if (j.stage !== 'upload' && j.stage !== 'local-queue') { rel(); clearInterval(watch); } }, 200);
          return toBytes(init && init.body).then(function (u8) {
            return xhrSend((init && init.method) || 'POST', url(), legacyHeaders(), u8 || (init && init.body), j, 'whole', signal);
          }).then(function (r) { clearTimeout(poll); clearInterval(watch); rel(); return r; },
                  function (e) { clearTimeout(poll); clearInterval(watch); rel(); throw e; });
        });
      }
      function viaBlobs(d) {
        j.mode = 'blobs';
        return Promise.all(d.parts.map(function (u8) { return sha256Hex(u8); })).then(function (hashes) {
          var spec = d.spec;
          if (spec.t === 'concat') spec.parts = hashes; else spec.files.forEach(function (f, i) { f.h = hashes[i]; });
          var round = 0;
          var attempt = function () {
            return origFetchFn()(p.url + '/b/check', { method: 'POST', headers: { Authorization: 'Bearer ' + p.value, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: hashes }), cache: 'no-store', signal: timeoutSignal(15000) })
              .then(function (r) {
                if (r.status === 401) return renew().then(attempt);
                if (!r.ok) return Promise.reject(Object.assign(new Error('问云端缺哪张图没问成（' + r.status + '）'), { status: r.status }));
                return r.json().then(function (c) {
                  var missing = ((c && c.missing) || []).filter(function (h, i, a) { return a.indexOf(h) === i && hashes.indexOf(h) >= 0; });
                  var sizeOf = function (h) { return d.parts[hashes.indexOf(h)].byteLength; };
                  j.saved = hashes.filter(function (h, i) { return hashes.indexOf(h) === i && missing.indexOf(h) < 0; }).reduce(function (s, h) { return s + sizeOf(h); }, 0);
                  var ownLeft = 0, sharedLeft = 0;
                  // 自己的传完了、还在等别人传同一张 → 状态如实改成「等待中」（别停在「上传 100%」）
                  var settle = function () { if (!ownLeft && sharedLeft && !j.cancelled) setStage(j, 'local-queue', { ahead: 1 }); };
                  // 自己传一张：登记成「正在传」（别的单要同一张就等它），排进上传道
                  var own = function (h) {
                    j.upTotal += sizeOf(h);
                    ownLeft++;
                    var pr = uploadOne(d.parts[hashes.indexOf(h)], h);
                    var entry = { job: j, promise: pr };
                    blobInflight.set(h, entry);
                    var clear = function () { if (blobInflight.get(h) === entry) blobInflight.delete(h); };
                    pr.then(clear, clear);
                    return pr.then(function () { ownLeft--; settle(); });
                  };
                  // ⚠ 几单同时开工时，大家问「有没有原图」那一刻都还没有 —— 别的单【正在传 / 排着要传】同一张就等它，别再传一遍
                  //   （测试抓到：同任务 4 张一起开，原图被传了 4 次）。等的那单更急就把它的【上传】往前提。
                  //   那一单要是没传成（被取消 / 网断），这一单自己补传，不跟着失败。
                  var waitShared = function (h, shared) {
                    if (j.upPrio < shared.job.upPrio) { shared.job.upPrio = j.upPrio; aheadRefresh(); }
                    j.saved += sizeOf(h);
                    sharedLeft++;
                    return shared.promise.then(function () { sharedLeft--; }, function () {
                      sharedLeft--;
                      if (j.cancelled) throw abortError();
                      j.saved -= sizeOf(h);
                      var again = blobInflight.get(h);
                      return again && again.job !== j ? again.promise : own(h);
                    });
                  };
                  // ⭐ 这一单缺的几张【一次全排进上传道】（挨着传，别人插不进来；进度合成一条）
                  var waits = missing.map(function (h) {
                    var shared = blobInflight.get(h);
                    return shared && shared.job !== j ? waitShared(h, shared) : own(h);
                  });
                  settle();
                  return Promise.all(waits).then(function () {
                    setStage(j, 'cloud-queue', { position: 0, waitedMs: 0, pct: 0 });
                    var h2 = Object.assign(headersFor(), { 'x-v7-compose': encodeURIComponent(JSON.stringify(spec)) });
                    delete h2['content-type']; delete h2['x-head-len'];
                    var poll = setTimeout(function () { pollStatus(function () { return p; }, j, reqId, alive); }, POLL_MS);
                    return xhrSend((init && init.method) || 'POST', url(), h2, null, j, 'wait', signal)
                      .then(function (res) { clearTimeout(poll); return res; }, function (e) { clearTimeout(poll); throw e; });
                  }).then(function (res) {
                    if (res.status === 401) return renew().then(attempt);
                    // 云端说缺图（过期 / 重启过）：补传后再来一次（只补一次）
                    if (res.status === 409 && round++ === 0) return attempt();
                    return res;
                  });
                });
              });
          };
          return attempt();
        });
      }

      // ⭐ 2026-10-20 网络抖一下（断线 / 传图卡住 / 云端 502·503·504）：这一单从头再来，最多 3 次；状态写「正在重连」。
      //   每次换一个请求编号（上一次可能还挂在云端，别跟它撞）；已经传上去的图云端还留着，「问缺哪张」会跳过，不会重传。
      //   云端外挂不扣积分（backend/cloud_tools.py 只记用量），重发不会多扣钱。
      var tries = 0;
      var run = withRetry(function () {
        reqId = tries ? reqBase + '-' + tries : reqBase;
        return gatewayFeatures(p).then(function (f) {
          if (!f || !f.blobs) return legacy();
          return decompose(tool, init).then(function (d) { return d ? viaBlobs(d) : legacy(); });
        });
      }, function (r, e) {
        if (j.cancelled || (signal && signal.aborted)) return false;
        if (r) return transientStatus(r.status) ? retryAfterMs(r.headers) : false;
        return transientError(e) ? 0 : false;
      }, function (n) {
        tries = n;
        features = null;            // 云端可能刚重启过（换了门卫版本）：重新问一次
        j.upDone = 0; j.upTotal = 0; j.saved = 0;
        setStage(j, 'reconnect', { retry: n, pct: 0, bytes: 0, total: 0 });
      });

      return run.then(function (r) {
        finished = true;
        j.cloud = { upload: Number(r.headers.get('x-cloud-upload-ms')) || 0, queue: Number(r.headers.get('x-cloud-queue-ms')) || 0, engine: Number(r.headers.get('x-cloud-ms')) || 0 };
        if (r.status >= 200 && r.status < 300) setStage(j, 'done', { pct: 100 });
        else setStage(j, 'failed', { error: 'HTTP ' + r.status });
        return new Response(r.status === 204 ? null : r.buf, { status: r.status, headers: r.headers });
      }, function (e) {
        finished = true;
        dropQueued(j);
        setStage(j, 'failed', { error: String(e && e.message || e) });
        throw e;
      });
    }
    function jobEligible(t, method) {
      return method === 'POST' && !!JOB_TOOLS[t.path];
    }
    // 界面用：现在还没结束的单（给状态行 / 任务卡汇总）
    function listJobs() { return Array.from(jobs.values()).map(jobSnapshot); }
    function onJob(fn) {
      if (typeof fn !== 'function') return function () {};
      jobListeners.add(fn);
      return function () { jobListeners.delete(fn); };
    }
    // 一单的状态文案（中性：只说在传 / 在排 / 在处理 / 在收，不说在算什么）
    function jobText(s) {
      if (!s) return '';
      var sec = function (ms) { return Math.max(0, Math.round((ms || 0) / 1000)); };
      switch (s.stage) {
        case 'prepare': return '准备中';
        case 'local-queue': return s.ahead ? '等待中 · 前面 ' + s.ahead + ' 个' : '等待中';
        case 'upload': return '上传 ' + (s.pct || 0) + '%' + (s.total ? '（' + (s.bytes / 1048576).toFixed(1) + '/' + (s.total / 1048576).toFixed(1) + ' MB）' : '');
        case 'cloud-queue': return s.position ? '云端排队 · 第 ' + s.position + ' 位' + (s.waitedMs > 2000 ? ' · 已等 ' + sec(s.waitedMs) + ' 秒' : '') : '已送达云端';
        case 'reconnect': return '网络抖了一下，正在重连' + (s.retry > 1 ? '（第 ' + s.retry + ' 次）' : '');
        case 'processing': return '处理中';
        case 'download': return '接收 ' + (s.pct || 0) + '%';
        case 'done': return '完成 · ' + (((s.doneAt || 0) - (s.startedAt || 0)) / 1000).toFixed(1) + ' 秒';
        case 'failed': return '没成功：' + (s.error || '');
        default: return '';
      }
    }
    // 完成后的用时分解（悬停提示 / 调试日志）
    function jobBreakdown(s) {
      if (!s) return '';
      var t = s.timing || {}, c = s.cloud || {};
      var f = function (ms) { return (Math.max(0, ms || 0) / 1000).toFixed(1); };
      return '本机等待 ' + f(t['local-queue']) + ' · 上传 ' + f(t.upload) + ' · 云端排队 ' + f(c.queue || t['cloud-queue']) + ' · 处理 ' + f(c.engine || t.processing) + ' · 接收 ' + f(t.download)
        + (s.saved ? ' · 省传 ' + (s.saved / 1048576).toFixed(1) + ' MB' : '');
    }

    function fetchRoute(input, init) {
      var t = target(input);
      var plain = function () { return origFetchFn()(input, init); };
      if (!t || !enabled() || (init && init.__v7Local)) return plain();
      var method = methodOf(input, init);
      if (NOOP.indexOf(t.path) >= 0) return Promise.resolve(jsonResponse(200, { ok: true, cloud: true, note: '云端外挂模式下不用卸载 / 关闭本机引擎' }));
      if (!cloudable(t, method)) return plain();        // 测试台之类只在本机有的页面
      if (degraded()) {
        // 后台（开软件 / 心跳）悄悄降级的：用户第一次真去算图时补说一句「现在用的是本机」—— 不许完全静默地换掉
        if (method !== 'GET' && !degradeNoticed && lastWhy) {
          degradeNoticed = true;
          report('CLOUD_TOOLS_FALLBACK', lastWhy, { message: lastWhy.text + ' —— 现在先用这台电脑的本机引擎，云端好了会自动切回去。' });
        }
        return plain();
      }

      // ⚠ 探活 / 看模型清单（GET）是软件自己在后台问的（开卡、刷新状态），连不上只更新状态、不弹卡；
      //   真去算图（POST）连不上才弹卡说原因。
      var quietReq = method === 'GET';
      var failover = function (w) {
        return fallback(w, quietReq).then(function (d) {
          if (d.route === 'local') {
            // 本机引擎可能还没开：先拉起来（toolEngineReady 现在会看到"降级中"，走本机那条）
            var starting = Promise.resolve().then(function () { return typeof host.ensureLocal === 'function' ? host.ensureLocal() : null; }).catch(function () {});
            // ⭐ 2026-10-21 修（体检抓到）：后台探活（GET，只是问一句「在不在」）不等本机引擎起来 —— 原来要等引擎真的起来才回，
            //   本机引擎起不来（没装 / 被关）就一直等，外挂能力卡的状态刷新跟着卡死（等了 30 秒还没完）。
            //   现在：引擎照样在后台拉起来，探活立刻按「现在本机通不通」如实回答；真去算图（POST）还是等引擎起来再发。
            if (quietReq) return plain();
            return starting.then(plain);
          }
          return jsonResponse(503, { ok: false, cloud: true, code: w.code, error: w.text });
        });
      };

      return ensurePass().then(function (p) {
        // ⭐ 2026-10-19：调强度 / 校色这两种走云端任务队列（排序、只传一次、每步有状态），别的照旧
        var tool = JOB_TOOLS[t.path];
        if (jobEligible(t, method)) return sendJob(p, t, input, init, tool);
        var once = function () {
          return sendCloud(p, t, input, init).then(function (res) {
            if (res.status !== 401) return res;
            forgetPass();                                     // 通行证过期 / 被换钥匙：换一张再来一次
            return ensurePass(true).then(function (p2) { p = p2; return sendCloud(p2, t, input, init); });
          });
        };
        // 网络抖一下 / 云端 502·503·504：等一会儿再发（最多 3 次）。请求体是「流」的发过一次就没了，不能重发
        var body = init && init.body;
        var oneShot = body && typeof body === 'object' && typeof body.getReader === 'function';
        var signal = init && init.signal;
        if (oneShot) return once();
        return withRetry(once, function (r, e) {
          if (signal && signal.aborted) return false;
          if (r) return transientStatus(r.status) ? retryAfterMs(r.headers) : false;
          return transientError(e) ? 0 : false;
        });
      }).then(function (res) {
        if (res.status === 403 || res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          return res.clone().json().catch(function () { return {}; }).then(function (b) {
            var code = String(b.code || '');
            var w = res.status === 403 ? why('banned', b.error || '你的云端外挂工具已被停用', code)
              : res.status === 429 ? why('busy', b.error || '云端现在太忙了，稍后再试', code)
              : why('cloud-down', '云端引擎暂时没响应（' + (b.error || res.status) + '）', code);
            if (w.kind === 'busy') { lastWhy = w; report('CLOUD_TOOLS_BUSY', w); notify(); return res; }   // 排队满不降级：本机没有就是等，有也别抢
            return failover(w);
          });
        }
        if (lastWhy) { lastWhy = null; watchStep = 0; scheduleWatch(HEARTBEAT_MS); notify(); }
        return res;
      }, function (e) {
        if (e && e.kind) return failover(e);
        if (e && e.name === 'AbortError') throw e;          // 调用方自己掐的（超时 / 取消），原样抛回去
        // 传图 / 收结果卡住了（25 秒没进展）：先看是谁的网络问题，再按老规矩降级或如实说
        if (e && e.stall) return diagnose(pass && pass.url).then(function (w) { return failover(Object.assign({}, w, { text: e.message + ' —— ' + w.text })); });
        return diagnose(pass && pass.url).then(failover);
      });
    }

    function install() {
      if (installed || typeof root.fetch !== 'function') return false;
      origFetch = root.fetch.bind(root);
      root.fetch = function (input, init) { return fetchRoute(input, init); };
      installed = true;
      try {
        if (typeof root.addEventListener === 'function') {
          root.addEventListener('online', nudge);
          var doc = root.document;
          if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') nudge(); });
        }
      } catch (_) {}
      return true;
    }

    function status() {
      var on = enabled();
      var active = Array.from(jobs.values());
      var mbps = rate.ms ? Math.round(rate.bytes * 8 / rate.ms / 100) / 10 : null;
      var s = { on: on, degraded: degraded(), url: pass ? pass.url : '', latencyMs: health.ms, busy: health.busy, slots: health.slots, waiting: health.waiting, checkedAt: health.at,
        jobs: active.length, uploadMbps: mbps };
      // ⭐ 2026-10-19：你自己有几单在跑、上行多快（云端模式下最常见的「为什么这么慢」就是这两个）
      var mine = active.length ? ' · 你的队列 ' + active.length + ' 单' : '';
      var up = mbps ? ' · 上行约 ' + mbps + ' Mbps' : '';
      if (!on) return Object.assign(s, { state: 'off', text: '没开（用这台电脑的本机引擎）' });
      if (s.degraded) return Object.assign(s, { state: 'degraded', text: '云端连不上，暂时在用本机引擎' + (lastWhy ? '：' + lastWhy.text : '') + '（后台会隔一会儿再试，好了自动切回云端）' });
      // ⭐ 2026-10-20：正在「等一会儿再试」—— 只是抖了一下，先别下结论
      if (retrying > 0) return Object.assign(s, { state: 'reconnecting', text: '网络抖了一下，正在重连…' + mine });
      if (lastWhy) return Object.assign(s, { state: lastWhy.kind, text: lastWhy.text + mine });
      if (health.state === 'ready') return Object.assign(s, { state: 'ready', text: '云端在线' + (health.ms != null ? ' · 延迟 ' + health.ms + ' ms' : '') + (health.waiting ? ' · 云端排队 ' + health.waiting : '') + mine + up });
      return Object.assign(s, { state: 'checking', text: '正在连云端…' + mine });
    }

    function setEnabled(on) {
      if (typeof host.setMode === 'function') host.setMode(!!on);
      // ⚠ 用户亲手点开关 = 要一个【现在】的结论：扔掉缓存的通行证和「没登录」之类的旧判断，从头再连
      //   （不扔的话：刚开软件时没登录被记下，登录后点开关还会照旧说「没登录」，要等 20 秒才好 —— 真界面测试抓到）
      forgetPass();
      degradedUntil = 0; lastWhy = null;
      notify();
      if (on) return ensureReady().then(function (r) { notify(); return r; });
      stopWatch();
      return Promise.resolve({ route: 'local' });
    }

    function configure(next) {
      Object.keys(next || {}).forEach(function (k) { host[k] = next[k]; });
      return api;
    }

    var api = {
      install: install, configure: configure,
      enabled: enabled, routing: routing, degraded: degraded,
      setEnabled: setEnabled, ensureReady: ensureReady, status: status, subscribe: subscribe,
      forgetPass: function () { forgetPass(); degradedUntil = 0; lastWhy = null; degradeNoticed = false; notify(); },
      // ⭐ 2026-10-20：登录状态变了 / 网络回来了 —— 开着云端就马上悄悄连一次（原来要用户手动点「重新检测」）
      reconnect: function () {
        forgetPass(); degradedUntil = 0; lastWhy = null; degradeNoticed = false; watchStep = 0;
        if (!enabled()) { notify(); return Promise.resolve({ route: 'local' }); }
        notify();
        return ensureReady({ quiet: true });
      },
      // ⭐ 2026-10-19 云端任务队列（docs/249）：界面订阅状态画标注
      onJob: onJob, jobs: listJobs, jobText: jobText, jobBreakdown: jobBreakdown,
      // 测试 / 诊断用
      _target: target, _fetch: fetchRoute, _diagnose: diagnose, _watchTick: watchTick, _watchPending: function () { return !!watchTimer; }, _uploadQueue: function () { return upQueue.length + upActive; },
      ROUTES: ROUTES
    };
    return api;
  }

  return { create: create, ROUTES: ROUTES };
});
