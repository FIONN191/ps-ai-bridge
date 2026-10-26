/* ═══════════════════════════════════════════════════════════
 * V7Fuzzy · 模糊搜索（2026-10-20，设置卡顶上的搜索框用）
 * ═══════════════════════════════════════════════════════════
 *
 * 用户原话：「设置内容特别多……顶部需要加一个搜索框……能够去搜索模糊的相关的内容……近似搜索」
 *
 * 一个词怎么算「对上了」（都能混着用）：
 *   · 原文里直接有：  「缩放」→ 界面缩放          （最高分）
 *   · 汉字：          「主题」「题色」              （中间可以隔几个字，隔得越多分越低）
 *   · 全拼：          「suofang」→ 缩放             （多音字哪个读音都算：chongxin → 重新）
 *   · 首字母：        「zt」→ 主题
 *   · 拼一半：        「suof」→ 缩放               （最后一个字只打了几个字母）
 *   · 英文不分大小写：「comfy」→ 本地 ComfyUI
 * 拼音表：PYFULL（pinyin-full.js，6763 常用字全拼）；表外的字退到 PYIN（pinyin-initials.js）只认首字母。
 *
 * ⚠ 只做「打分 + 排序」，不碰界面。界面（结果列表、跳转、闪一下）在 settings-card.js。
 * ═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api;
  if (typeof module === 'object' && module.exports) {
    var full = null;
    try { full = require('./pinyin-full.js'); } catch (_) {}
    api = factory(function () { return full; }, function () { return null; });
    module.exports = api;
  } else {
    api = factory(function () { return root.PYFULL || null; }, function () { return root.PYIN || null; });
    root.V7Fuzzy = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function (getFull, getInitials) {
  'use strict';

  var GAP = 0.8;        // 已经对上几个字以后，中间每隔一个字扣的分（0.6 时乱打的「xyzq」能在长长的说明文字里东凑西凑对上，真软件里抓到的）
  var LEAD = 0.02;      // 开头跳过的字（越靠前对上越好，只扣一点点）
  var MAX_TEXT = 160;
  var MAX_QUERY = 32;
  var CJK = /[㐀-鿿]/;

  // ⭐ 2026-10-22（docs/263 第 11 条）：界面统一叫「传回」了，老用户习惯打「传回」照样要搜得到
  var ALIASES = [[/回传/g, '传回']];
  function norm(q) {
    var s = String(q == null ? '' : q).toLowerCase().replace(/[\s·,，。、:：;；!！?？'"“”‘’()（）【】\[\]{}<>《》\-_/\\|]+/g, '');
    ALIASES.forEach(function (a) { s = s.replace(a[0], a[1]); });
    return s.slice(0, MAX_QUERY);
  }

  var unitCache = new Map();
  function units(text) {
    var key = String(text || '').slice(0, MAX_TEXT);
    var hit = unitCache.get(key);
    if (hit) return hit;
    var full = getFull(), ini = getInitials();
    var out = [];
    var lower = key.toLowerCase();
    for (var i = 0; i < lower.length; i++) {
      var c = lower[i];
      if (/\s/.test(c)) continue;
      var u = { c: c, cjk: CJK.test(c), py: [] };
      if (u.cjk) {
        var all = full && full.all ? full.all(c) : [];
        if (all && all.length) u.py = all;
        else if (ini && ini.of) { var f = ini.of(c); if (f) u.py = [f]; }
      }
      out.push(u);
    }
    if (unitCache.size > 4000) unitCache.clear();
    unitCache.set(key, out);
    return out;
  }

  // 打分：对不上 → -1；对得越整齐分越高。
  function score(query, text) {
    var q = typeof query === 'string' && query.__normed ? query : norm(query);
    if (!q) return -1;
    var t = String(text || '');
    if (!t) return -1;
    var lower = t.toLowerCase().replace(/\s+/g, '');
    var at = lower.indexOf(q);
    // 原文里就有：最高分。越靠前、原文越短（越「正好是它」）越高
    if (at >= 0) return 100 + (at === 0 ? 20 : 0) - at * 0.2 - lower.length * 0.05 + q.length;
    var us = units(t);
    var n = us.length, m = q.length;
    if (!n) return -1;
    var memo = new Map();
    function f(i, j) {
      if (j === m) return 0;
      if (i >= n) return -Infinity;
      var key = i * 64 + j;
      if (memo.has(key)) return memo.get(key);
      var best = f(i + 1, j) - (j > 0 ? GAP : LEAD);
      var u = us[i];
      if (u.c === q[j]) best = Math.max(best, (u.cjk ? 3 : 2) + f(i + 1, j + 1));
      for (var k = 0; k < u.py.length; k++) {
        var r = u.py[k];
        // 冷门读音（k>0）只认打全拼，分也低一点；首字母 / 拼一半只认最常用的那个读音
        if (r.length > 1 && q.startsWith(r, j)) best = Math.max(best, (k ? 2.2 : 2.6) + f(i + 1, j + r.length));
        else if (!k && m - j > 1 && r.length > m - j && r.startsWith(q.slice(j))) best = Math.max(best, 2.2);   // 最后一个字拼了一半
        if (!k && r[0] === q[j]) best = Math.max(best, 1.5 + f(i + 1, j + 1));
      }
      memo.set(key, best);
      return best;
    }
    var s = f(0, 0);
    if (!isFinite(s) || s < m * 0.45) return -1;
    return s;
  }

  // 在一堆条目里找：fields(item) → [[文字, 权重], ...]；返回按分数从高到低排好的 [{item, score}]
  function search(query, items, fields, limit) {
    var q = norm(query);
    if (!q) return [];
    var out = [];
    (items || []).forEach(function (it) {
      var best = -1;
      (fields(it) || []).forEach(function (fw) {
        if (!fw || !fw[0]) return;
        var s = score(q, fw[0]);
        if (s > 0) best = Math.max(best, s * (fw[1] == null ? 1 : fw[1]));
      });
      if (best > 0) out.push({ item: it, score: best });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return limit ? out.slice(0, limit) : out;
  }

  return { score: score, search: search, norm: norm };
});
