/* ══════════════════════════════════════════════════════════════════════════
 * 供应商模型目录（ui-pure/supplier-models.js）—— 2026-10-24，V7待办/02
 * ══════════════════════════════════════════════════════════════════════════
 * 阿吉 / 墨墨在我们后台「线路与模型」页自己配：模型在软件里叫什么、有哪几档分辨率、每档每张多少钱、
 * 发请求时拼不拼「-2K」后缀（backend/supplier.py）。软件这边拉 /v1/public/provider-models?provider=。
 *
 * ⚠ 名字别撞：
 *   · provider-models.js（V7ProviderModels）= 中转站自己 /v1/models 拉到的【原始名单】的筛选 / 缓存；
 *   · provider-catalog.js（V7ProviderCatalog）= 「推荐服务商」卡；
 *   · 本模块（V7SupplierModels）= 供应商在我们后台配的【目录】（显示名 + 档位 + 价格）。
 *
 * 拉不到 ⇒ 本机上次那份 ⇒ 没有（阿吉调用方再退老的 aji-prices.js）。
 * 价格只是参考价（显示成 ¥，只换符号不换算 —— 用户 10-24 定）。
 * 变了广播 'wheelchair:supplier-models' + 'wheelchair:records-changed'（记录卡要重算花费）。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7SupplierModels = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  var SLOTS = ['aji', 'momo'];
  var SIZES = ['1K', '2K', '4K'];
  var CACHE_KEY = 'v7.supplierModels.v1';
  var ENDPOINT = '/v1/public/provider-models?provider=';
  var EVENT = 'wheelchair:supplier-models';
  var SIZE_SUFFIX = /-(1k|2k|4k)$/i;

  var state = readCache();          // slot → {models:[...], updatedAt, at, source}
  var inflight = {};

  function readCache() {
    try { var d = JSON.parse(root.localStorage.getItem(CACHE_KEY) || '{}'); return d && typeof d === 'object' ? d : {}; } catch (_) { return {}; }
  }
  function writeCache() { try { root.localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch (_) { } }

  function normalize(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      var id = String(m.id || '').trim();
      if (!id || /\s/.test(id) || seen[id.toLowerCase()]) return;
      seen[id.toLowerCase()] = 1;
      var sizes = SIZES.filter(function (s) { return (m.sizes || []).map(function (x) { return String(x).toUpperCase(); }).indexOf(s) >= 0; });
      if (!sizes.length) sizes = ['1K'];
      var prices = {};
      SIZES.forEach(function (s) { var v = m.prices && Number(m.prices[s]); if (m.prices && m.prices[s] !== '' && m.prices[s] != null && isFinite(v) && v >= 0) prices[s] = v; });
      out.push({ id: id, name: String(m.name || id).slice(0, 40), sizes: sizes,
        default: sizes.indexOf(String(m.default || '').toUpperCase()) >= 0 ? String(m.default).toUpperCase() : (sizes.indexOf('2K') >= 0 ? '2K' : sizes[0]),
        suffixMode: m.suffixMode === 'append' ? 'append' : 'none', suffixCase: m.suffixCase === 'lower' ? 'lower' : 'upper', prices: prices });
    });
    return out;
  }

  function backendUrl() {
    try {
      var st = root.V7Backend && root.V7Backend.state && root.V7Backend.state();
      if (st && st.baseUrl) return String(st.baseUrl).replace(/\/+$/, '');
    } catch (_) { }
    return 'https://www.xiasanqi.com';
  }

  function emit(slot) {
    try { root.dispatchEvent(new CustomEvent(EVENT, { detail: { slot: slot } })); } catch (_) { }
    try { root.dispatchEvent(new CustomEvent('wheelchair:records-changed')); } catch (_) { }
  }

  function refresh(slot) {
    if (SLOTS.indexOf(slot) < 0) return Promise.resolve(null);
    if (inflight[slot]) return inflight[slot];
    inflight[slot] = (async function () {
      try {
        var h = root.uiwin && root.uiwin.http;
        if (!h || !h.fetch) return null;
        var r = await h.fetch({ url: backendUrl() + ENDPOINT + slot, method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 10000 });
        if (!r || !r.ok) return null;          // 后台老版本（404）/ 连不上 ⇒ 照旧用本机那份
        var data = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
        var models = normalize(data && data.models);
        var before = JSON.stringify(state[slot] && state[slot].models || []);
        state[slot] = { models: models, updatedAt: String(data && data.updatedAt || ''), at: Date.now(), source: 'live' };
        writeCache();
        if (before !== JSON.stringify(models)) emit(slot);
        return state[slot];
      } catch (_) { return null; }
      finally { inflight[slot] = null; }
    })();
    return inflight[slot];
  }

  /* 这家的目录（显示用）。没有 ⇒ []。 */
  function modelsFor(slot) { return state[slot] && Array.isArray(state[slot].models) ? state[slot].models : []; }
  function has(slot) { return modelsFor(slot).length > 0; }

  /* 生成卡里存的是「基础名」（AJbanana3），也可能是老预设里带后缀的（AJbanana3-2k）⇒ 都认。 */
  function find(slot, model) {
    var m = String(model || '').trim().toLowerCase();
    if (!m) return null;
    var list = modelsFor(slot);
    var hit = list.find(function (x) { return x.id.toLowerCase() === m; });
    if (hit) return hit;
    var base = m.replace(SIZE_SUFFIX, '');
    return list.find(function (x) { return x.suffixMode === 'append' && x.id.toLowerCase() === base; }) || null;
  }

  /* 发给服务商的请求名（后台 supplier.request_id 同一套规则）。目录里没有 ⇒ null（调用方照老规矩）。 */
  function requestId(slot, model, size) {
    var hit = find(slot, model);
    if (!hit) return null;
    var sz = String(size || '').toUpperCase();
    if (hit.suffixMode !== 'append' || SIZES.indexOf(sz) < 0) return hit.id;
    return hit.id + '-' + (hit.suffixCase === 'lower' ? sz.toLowerCase() : sz);
  }

  /* 每张多少钱（参考价）。没填这档 ⇒ null（界面写「单价未知」，绝不当免费）。 */
  function priceFor(slot, model, size) {
    var hit = find(slot, model);
    if (!hit) return null;
    var sz = String(size || '').toUpperCase();
    var m = String(model || '').match(SIZE_SUFFIX);
    if (m) sz = m[1].toUpperCase();
    // 这个模型不支持当前档（不分档的 gpt-image-2 只有 1K，而生成卡上选着 4K）⇒ 按它自己的默认档算，别写「单价未知」
    if (hit.sizes.indexOf(sz) < 0) sz = hit.default;
    var v = hit.prices[sz];
    return typeof v === 'number' ? { price: v, model: requestId(slot, hit.id, sz), name: hit.name, size: sz } : null;
  }

  /* 启动：先用本机那份，再去后台拉 */
  (function boot() {
    if (root && root.document && typeof setTimeout === 'function') setTimeout(function () { SLOTS.forEach(refresh); }, 2000);
  })();

  return { SLOTS: SLOTS, EVENT: EVENT, CACHE_KEY: CACHE_KEY, refresh: refresh, modelsFor: modelsFor, has: has, find: find, requestId: requestId, priceFor: priceFor,
    __test: { normalize: normalize, set: function (slot, models) { state[slot] = { models: normalize(models), at: Date.now(), source: 'live' }; }, reset: function () { state = {}; inflight = {}; } } };
});
