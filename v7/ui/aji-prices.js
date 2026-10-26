/* ══════════════════════════════════════════════════════════════════════════
 * 阿吉价目表（ui-pure/aji-prices.js）—— 2026-10-15
 * ══════════════════════════════════════════════════════════════════════════
 * 用户定（原话）：
 *   「我们现在的计价模式是单针对于阿吉…你只需要做这一个渠道的价格…
 *     在后端去把对应的价格填到对应的位置，这个计算只是说 API 渠道的价格，不涉及任何我们的积分」
 *   「计价单位是美元」「这个表只负责阿吉」
 *   「记录与恢复卡片里面…算总消耗的，那个也得开始算」
 *
 * 这个模块只干三件事：
 *   ① 从后端拉 /v1/public/aji-prices（不登录也能拉）
 *   ② 记一份在本机（下次开软件先用它，网络回来再更新 —— 这是【参考价】，不是公告，旧一点也比没有强）
 *   ③ priceFor(模型, 分辨率) → 每张多少美元；查不到返回 null（界面写"单价未知"，绝不当免费）
 *
 * 怎么对上价目表里的「请求名称」：
 *   生成卡里存的是【基础名 + 分辨率】（AJbanana3 + 2K），发给阿吉时才拼成 AJbanana3-2k。
 *   ⇒ 先找「基础名-分辨率」，再找「基础名本身」（gpt-image-2 这种不分档的）。大小写一律不管。
 *   模型名本来就带着后缀（老预设里存过 AJbanana3-2k）⇒ 直接按它找。
 *
 * ⚠ 价目表变了会广播 'wheelchair:aji-prices-updated'，并顺手广播 'wheelchair:records-changed'
 *   —— 记录卡靠后者重算每次 / 每个项目 / 总共花了多少。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7AjiPrices = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  var ENDPOINT = '/v1/public/aji-prices';
  var CACHE_KEY = 'wheelchair.v7.ajiPrices.v1';
  var EVENT = 'wheelchair:aji-prices-updated';
  var TIMEOUT_MS = 12000;
  var SIZE_SUFFIX = /-(?:1k|2k|4k)$/i;

  // byModel：小写请求名称 → {name, model, price}
  var state = { rows: [], byModel: {}, updatedAt: '', at: 0, source: 'none', status: 'idle', error: '' };
  var inflight = null;

  function index(rows) {
    var map = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var model = String(r.model == null ? '' : r.model).trim();
      var price = Number(r.price);
      if (!model || !isFinite(price) || price < 0) return;     // 坏行跳过，不让它算出负的花费
      map[model.toLowerCase()] = { name: String(r.name || model), model: model, price: price };
    });
    return map;
  }

  function apply(rows, updatedAt, at, source) {
    state.byModel = index(rows);
    state.rows = Object.keys(state.byModel).map(function (k) { return state.byModel[k]; });
    state.updatedAt = String(updatedAt || '');
    state.at = Number(at) || Date.now();
    state.source = source;
  }

  function readCache() {
    try {
      var raw = root && root.localStorage && root.localStorage.getItem(CACHE_KEY);
      var d = raw ? JSON.parse(raw) : null;
      return d && Array.isArray(d.rows) ? d : null;
    } catch (_) { return null; }
  }
  function writeCache(rows, updatedAt) {
    try { root.localStorage.setItem(CACHE_KEY, JSON.stringify({ rows: rows, updatedAt: updatedAt, at: Date.now() })); } catch (_) { }
  }

  function backendUrl() {
    // 跟公告同一个来源（V7Backend 是权威；启动那一刻 settingsRuntime 还没就绪）
    try {
      var st = root.V7Backend && root.V7Backend.state && root.V7Backend.state();
      if (st && st.baseUrl) return String(st.baseUrl).replace(/\/+$/, '');
    } catch (_) { }
    return 'https://www.xiasanqi.com';
  }

  // ⚠ 走宿主桥 uiwin.http（两个壳里浏览器 fetch 会 Failed to fetch），没有桥才用浏览器 fetch
  async function httpGet(url) {
    if (root.uiwin && root.uiwin.http && root.uiwin.http.fetch) {
      var r = await root.uiwin.http.fetch({ url: url, method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status != null ? r.status : '无响应'));
      return typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    try {
      var resp = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  function emit() {
    try { root.dispatchEvent(new Event(EVENT)); } catch (_) { }
    try { root.dispatchEvent(new CustomEvent('wheelchair:records-changed')); } catch (_) { }
  }

  /* 拉一次。失败不抛、不弹卡：价格拉不到只影响"显示多少钱"，
     界面会写"单价未知"，手里有上次的那份就继续用那份。 */
  function refresh() {
    if (inflight) return inflight;
    state.status = 'loading';
    inflight = (async function () {
      try {
        var data = await httpGet(backendUrl() + ENDPOINT);
        var rows = data && Array.isArray(data.rows) ? data.rows : [];
        apply(rows, data && data.updatedAt, Date.now(), 'live');
        writeCache(rows, state.updatedAt);
        state.status = 'ok'; state.error = '';
      } catch (error) {
        state.status = 'fail';
        state.error = String((error && error.message) || error).slice(0, 160);
        if (root.console) console.log('[阿吉价目表] 没拉到，' + (state.source === 'cache' ? '继续用上次那份' : '暂时没有价格') + '：' + state.error);
      }
      inflight = null;
      emit();
      return snapshot();
    })();
    return inflight;
  }
  function refreshIfStale(maxAgeMs) {
    var age = Date.now() - (state.at || 0);
    if (state.status === 'loading') return inflight;
    if (state.source !== 'live' || age > (maxAgeMs == null ? 600000 : maxAgeMs)) return refresh();
    return Promise.resolve(snapshot());
  }

  /* 每张多少美元。model = 生成卡里的模型（基础名或带后缀），size = 1K/2K/4K。
     返回 {price, model(命中的请求名称), name} 或 null。 */
  function priceFor(model, size) {
    var m = String(model == null ? '' : model).trim();
    if (!m) return null;
    var sz = String(size == null ? '' : size).trim().toUpperCase();
    var tries = [];
    if (SIZE_SUFFIX.test(m)) tries.push(m);
    else {
      if (sz === '1K' || sz === '2K' || sz === '4K') tries.push(m + '-' + sz);
      tries.push(m);
    }
    for (var i = 0; i < tries.length; i++) {
      var hit = state.byModel[tries[i].toLowerCase()];
      if (hit) return { price: hit.price, model: hit.model, name: hit.name };
    }
    return null;
  }

  function snapshot() {
    return { rows: state.rows.slice(), updatedAt: state.updatedAt, at: state.at, source: state.source, status: state.status, error: state.error };
  }

  // 启动：先用本机记的那份（立刻有价格可看），再去后端拉最新的
  (function boot() {
    var c = readCache();
    if (c) apply(c.rows, c.updatedAt, c.at, 'cache');
    if (root && root.document && typeof setTimeout === 'function') setTimeout(function () { refresh(); }, 1800);
  })();

  return {
    refresh: refresh, refreshIfStale: refreshIfStale, priceFor: priceFor, state: snapshot,
    endpoint: ENDPOINT, event: EVENT, key: CACHE_KEY,
    __test: { apply: function (rows) { apply(rows, '', Date.now(), 'live'); state.status = 'ok'; }, index: index }
  };
});
