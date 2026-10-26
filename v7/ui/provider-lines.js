/* ══════════════════════════════════════════════════════════════════════════
 * 竞速选线（ui-pure/provider-lines.js）—— 2026-10-24，V7待办/02，用户拍板
 * ══════════════════════════════════════════════════════════════════════════
 * 用户原话：「他们可以填写多个他们的备份的网址，然后呢，用户就直接去 ping 哪个更快用哪个呗」
 *   （「默认竞速」，竞争的竞）
 *
 * 做法照 V6 bootstrap-handlers.js validateAjiKey：
 *   候选池 = 后台名单（/v1/public/provider-endpoints，供应商自己在后台填）+ 本机上次的结果 + 写死兜底，
 *           去重，三组【永远一起参赛】；
 *   拿用户自己的 Key 并发去每条线路【查一次余额】（provider-balance.js probe），单条 8 秒、整体 12 秒；
 *     · 查得到余额且 > 0 的里挑最快的；
 *     · 都查得到但都是 0 ⇒ 挑最快的，标「余额用完了」；
 *     · 全挂 ⇒ 放行兜底第一条，标「没测出可用线路」—— 选线只是锦上添花，绝不挡人（V6 铁律）。
 *   ⚠ 为什么查余额而不是 ping：ping 得通 ≠ 这条线路认你的 Key、能出图。
 *
 * 结果按电脑存（localStorage 'v7.providerLines.v1'，不跟账号 —— 线路快慢是这台电脑的网络决定的）。
 * 用不用自动选线由设置 ajiLineMode / momoLineMode 决定（'auto' 默认 / 'manual' 用户自己填的专线），
 *   ⚠ 判据【只在】provider-connections.js connection() 一处：那里调 resolved(slot)。
 * 什么时候测：Key 从安全存储恢复后、设置卡点「检查连接」/「重新测速」、换了 Key、出图报连不上服务器（只重测，不自动重发 —— 阿吉发送即扣）。
 * 测速期间不改正在跑的任务：任务开跑时地址已经快照进请求里，这里只影响下一单。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7ProviderLines = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  var FALLBACK = {
    aji: ['https://ai.ajiai.top', 'https://cn.ajiai.top', 'https://ai.ajiapi.top'],
    momo: ['https://api.momoapi.icu']
  };
  var SLOTS = ['aji', 'momo'];
  var CACHE_KEY = 'v7.providerLines.v1';
  var ENDPOINT = '/v1/public/provider-endpoints?provider=';
  var EVENT = 'wheelchair:provider-lines';
  var ONE_MS = 8000, ALL_MS = 12000, LIST_MS = 6000;

  var cache = readCache();
  var running = {};          // slot → Promise（同一家同时只测一轮）
  var remote = {};           // slot → 后台名单（这次运行拉到的）

  function readCache() {
    try { var d = JSON.parse(root.localStorage.getItem(CACHE_KEY) || '{}'); return d && typeof d === 'object' ? d : {}; } catch (_) { return {}; }
  }
  function writeCache() { try { root.localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) { } }
  function clean(url) {
    var v = String(url || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[A-Za-z0-9.\-_:/]+$/.test(v) ? v : '';
  }
  function emit(slot) { try { root.dispatchEvent(new CustomEvent(EVENT, { detail: { slot: slot } })); } catch (_) { } }

  function backendUrl() {
    try {
      var st = root.V7Backend && root.V7Backend.state && root.V7Backend.state();
      if (st && st.baseUrl) return String(st.baseUrl).replace(/\/+$/, '');
    } catch (_) { }
    return 'https://www.xiasanqi.com';
  }
  function http() { return root.uiwin && root.uiwin.http; }

  async function fetchRemote(slot) {
    var h = http();
    if (!h || !h.fetch) return remote[slot] || [];
    try {
      var r = await h.fetch({ url: backendUrl() + ENDPOINT + slot, method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: LIST_MS });
      if (r && r.ok) {
        var data = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
        remote[slot] = (data && Array.isArray(data.urls) ? data.urls : []).map(function (u) { return clean(u && u.url); }).filter(Boolean);
      } else if (slot === 'aji' && r && r.status === 404) {
        // 后台还是老版本（没有这条接口）⇒ 阿吉退老接口 /v1/public/aji-urls
        var old = await h.fetch({ url: backendUrl() + '/v1/public/aji-urls', method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: LIST_MS });
        var od = old && old.ok ? (typeof old.body === 'string' ? JSON.parse(old.body) : old.body) : null;
        remote[slot] = (od && Array.isArray(od.urls) ? od.urls : []).map(function (u) { return clean(u && u.url); }).filter(Boolean);
      }
    } catch (_) { /* 拉不到名单不要紧：本机缓存 + 兜底照样参赛 */ }
    return remote[slot] || [];
  }

  /* 候选池：后台名单 → 本机上次 → 写死兜底，去重，顺序就是「同样快时谁优先」。 */
  async function pool(slot) {
    var list = [].concat(await fetchRemote(slot), (cache[slot] && cache[slot].pool) || [], FALLBACK[slot] || []);
    var seen = {}, out = [];
    list.forEach(function (u) { var c = clean(u); if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = 1; out.push(c); } });
    return out.slice(0, 20);
  }

  function pick(slot, results, candidates) {
    var ok = results.filter(function (r) { return r && r.ok; }).sort(function (a, b) { return a.latencyMs - b.latencyMs; });
    var funded = ok.filter(function (r) { return Number(r.amount) > 0 || r.unlimited; });
    var limited = ok.filter(function (r) { return r.rateLimited; });   // 被限流（429）：线路通、余额不知道 —— 不能说成「余额用完了」
    var chosen = funded[0] || limited[0] || ok[0] || null;
    var state = funded[0] ? 'ok' : limited[0] ? 'ok' : ok[0] ? 'empty' : 'none';
    return {
      url: chosen ? chosen.url : candidates[0] || (FALLBACK[slot] || [])[0] || '',
      state: state,                                     // ok 有余额 / empty 余额用完 / none 都没测通（放行兜底）
      latencyMs: chosen ? chosen.latencyMs : null,
      balance: chosen ? chosen.amount : null,
      unit: chosen ? chosen.unit : '',
      tried: results.map(function (r) { return { url: r.url, ok: !!r.ok, ms: r.latencyMs, error: r.ok ? '' : String(r.error || '').slice(0, 120) }; }),
      checkedAt: new Date().toISOString(),
      pool: candidates
    };
  }

  /* 测一轮。apiKey 空 ⇒ 不测（没 Key 查不了余额），返回 null。 */
  function race(slot, apiKey, options) {
    if (SLOTS.indexOf(slot) < 0) return Promise.resolve(null);
    var key = String(apiKey || '').trim();
    if (!key) return Promise.resolve(null);
    if (running[slot]) return running[slot];
    var opts = options || {};
    running[slot] = (async function () {
      try {
        var candidates = await pool(slot);
        // ⚠ 跟设置卡查余额、出图同一条路：direct（不走系统代理）—— 不然会测出「这条最快」可出图走的是另一条网
        var balance = opts.balance || (root.V7ProviderBalance && root.V7ProviderBalance.create({ http: {
          fetch: function (d) { return http().fetch(Object.assign({}, d, { direct: true })); },
          cancel: function (id) { return http().cancel && http().cancel(id); } } }));
        if (!balance || !balance.probe) return null;
        var results = [], settled = 0;
        await new Promise(function (resolve) {
          var timer = setTimeout(resolve, opts.allMs || ALL_MS);     // 整体 12 秒：超时就拿已经回来的
          // ⭐ 10-25（反馈 #48 #55）：原来三条同一瞬间拿同一个 Key 查，阿吉直接限流（429）⇒ 错开 350 毫秒一条
          // 错开的总时长不超过整体时限的一半（整体 12 秒时就是 350 毫秒一条）
          var step = opts.staggerMs != null ? opts.staggerMs : Math.min(350, Math.floor((opts.allMs || ALL_MS) / 2 / Math.max(1, candidates.length)));
          candidates.forEach(function (url, k) {
            setTimeout(function () { balance.probe({ connectionSlot: slot, baseUrl: url, apiKey: key }, { timeoutMs: opts.oneMs || ONE_MS }).then(function (r) {
              results.push(r);
            }, function (e) {
              results.push({ ok: false, url: url, latencyMs: opts.oneMs || ONE_MS, error: String(e && e.message || e) });
            }).then(function () {
              settled += 1;
              if (settled >= candidates.length) { clearTimeout(timer); resolve(); }
            }); }, k * step);
          });
          if (!candidates.length) { clearTimeout(timer); resolve(); }
        });
        var out = pick(slot, results.slice(), candidates);
        cache[slot] = out;
        writeCache();
        emit(slot);
        return out;
      } finally {
        running[slot] = null;
      }
    })();
    return running[slot];
  }

  /* 自动选线时该用哪条（connection() 调它）。没测过 ⇒ 本机上次的 ⇒ 兜底第一条。 */
  function resolved(slot) {
    if (SLOTS.indexOf(slot) < 0) return '';
    var c = cache[slot];
    return (c && clean(c.url)) || (FALLBACK[slot] || [])[0] || '';
  }
  function status(slot) { return cache[slot] ? JSON.parse(JSON.stringify(cache[slot])) : null; }
  function isPoolUrl(slot, url) {
    var c = clean(url);
    if (!c) return true;                      // 空的也算「没填专线」
    var known = [].concat(FALLBACK[slot] || [], remote[slot] || [], (cache[slot] && cache[slot].pool) || []);
    return known.some(function (u) { return clean(u).toLowerCase() === c.toLowerCase(); });
  }
  /* 设置卡上那一行字 */
  function describe(slot) {
    var c = cache[slot];
    if (!c) return '自动选线 · 还没测速（填好 Key 点「重新测速」）';
    var host = String(c.url || '').replace(/^https:\/\//, '');
    var passed = (c.tried || []).filter(function (t) { return t.ok; }).length;
    var head = c.state === 'none' ? '没测出可用线路，先用 ' + host : '自动选线 · ' + host + (c.latencyMs != null ? ' · ' + c.latencyMs + 'ms' : '');
    var money = c.balance != null ? ' · 余额 ¥' + Number(c.balance).toFixed(2) + (c.state === 'empty' ? '（用完了）' : '') : '';
    return head + money + ' · ' + (c.tried || []).length + ' 条参赛 ' + passed + ' 条通过';
  }

  return { FALLBACK: FALLBACK, CACHE_KEY: CACHE_KEY, EVENT: EVENT, pool: pool, race: race, resolved: resolved, status: status, describe: describe, isPoolUrl: isPoolUrl,
    __test: { pick: pick, clean: clean, reset: function () { cache = {}; remote = {}; running = {}; } } };
});
