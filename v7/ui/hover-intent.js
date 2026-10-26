/*
 * 悬停意图：分清「鼠标真的移到这张图上」和「图从静止的鼠标底下滑过来」（2026-10-19，docs/250 第 4 条）
 *
 *   测试用户原话：「v7 的滚轮查看过去生成过的图片时容易直接把底下隐藏图层点开」。
 *   真因：缩略图用 mouseenter 触发「PS 里只显示这张」（ui.html buildPreview → generationSoloLayer）。
 *     滚轮翻任务卡时鼠标没动，是卡片从鼠标底下滑过去 —— 浏览器照样发 mouseenter（Chromium 滚动后还会补发一个坐标不变的 mousemove）。
 *
 *   判法（跟浏览器先发 mousemove 还是先发 mouseenter 无关）：
 *     · 只把【坐标真的变了】的 mousemove 记成「真实移动」（补发的那个坐标没变，不算）；
 *     · 进入时：坐标跟「最近一次真实移动」一样、而且那次移动已经过去 STALE_MS 以上 → 鼠标一直停着，是东西滑过来了 → 不算；
 *       刚滚过轮（WHEEL_GUARD_MS 内）→ 也先不算；
 *     · 不算的那次记成「待定」：之后鼠标在这张图上【真的动一下】再触发 —— 所以悬停功能本身一点不少。
 *
 *   用法：const hi = V7HoverIntent.create();  window 上（捕获阶段）把 mousemove 交给 hi.move(e)、wheel 交给 hi.wheel(e)；
 *         元素 mouseenter 里 hi.enter(e) 为真才触发；mousemove 里 hi.moveOn(e) 为真（待定 + 真动了）就补触发；mouseleave 里 hi.leave(el)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.V7HoverIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function create(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const STALE_MS = o.staleMs == null ? 60 : o.staleMs;           // 坐标没变、上次真实移动早于这么久 = 鼠标一直停着
    const WHEEL_GUARD_MS = o.wheelGuardMs == null ? 250 : o.wheelGuardMs;
    let last = null;              // 最近一次【坐标变了】的移动 { x, y, t }
    let lastRealEvent = null;     // 那次移动的事件对象（元素自己的 mousemove 监听靠它认「这一下是不是真动了」）
    let wheelAt = -Infinity;
    const pending = new WeakSet();   // 进入时没算、等真动一下再触发的元素

    function sameXY(e) { return !!last && Math.abs(e.clientX - last.x) < 0.5 && Math.abs(e.clientY - last.y) < 0.5; }
    function move(e) {
      if (!e) return;
      if (last && sameXY(e)) { lastRealEvent = null; return; }        // 补发的假移动：坐标没变
      last = { x: e.clientX, y: e.clientY, t: now() };
      lastRealEvent = e;
    }
    function wheel() { wheelAt = now(); }
    // 这次「进入」算不算鼠标真的移过来的
    function real(e) {
      if (now() - wheelAt < WHEEL_GUARD_MS) return false;
      if (!last) return true;                                          // 软件刚开、还没记到任何移动：照旧算
      if (!sameXY(e)) return true;                                     // 先发进入、后发移动的浏览器：坐标跟上次不一样 = 真动了
      return now() - last.t < STALE_MS;                                // 先发移动、后发进入的浏览器：刚刚才动过 = 真动了
    }
    function enter(e) {
      const el = e && e.currentTarget;
      if (real(e)) { if (el) pending.delete(el); return true; }
      if (el) pending.add(el);
      return false;
    }
    // 元素自己的 mousemove：待定中、而且这一下是真实移动（window 捕获阶段刚记下的就是它）→ 补触发一次
    function moveOn(e) {
      const el = e && e.currentTarget;
      if (!el || !pending.has(el)) return false;
      if (e !== lastRealEvent || now() - wheelAt < WHEEL_GUARD_MS) return false;
      pending.delete(el);
      return true;
    }
    function leave(el) { if (el) pending.delete(el); }
    return { move, wheel, enter, moveOn, leave, _state: () => ({ last, wheelAt }) };
  }
  return { create };
});
