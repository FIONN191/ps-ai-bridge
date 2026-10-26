'use strict';
// ════════════════════════════════════════════════════════════════════
// motion-tokens.js —— JS 动画的三档时长 +「减少动画」开关（docs/263 1.6、第三批）
//
//   CSS 那边读 tokens.css 的 --m-fast / --m-base / --m-slow；JS 的 el.animate() 读这里，两边同一套数：
//     fast 120ms：悬停、按下、颜色变化、< 40px 的小位移、退出
//     base 200ms：面板展开/收起、弹出、列表增删和重排、内容切换
//     slow 340ms：整卡位移、飞行动画
//
//   「减少动画」是软件自己的设置项（设置 → 外观 → 透明与毛玻璃 下面）。
//   ⚠ 不读系统的 prefers-reduced-motion：用户 Windows 关了「显示动画」，读了它整个界面的动画全没了（2026-09-14、10-20 两次）。
//   打开后：html 挂 .v7-reduce-motion → CSS 三档压成 1ms、装饰循环停；JS 这边 ms() 返回 1，reduced() 为 true。
//
// 另外三个小工具（docs/263「列表增删、来源切换、参数变化补动画」）：
//   listFlip(容器, 取 key, 重画函数)  重画列表：新出现的行淡入、留下的行从旧位置滑到新位置（删一行时下面的会补上去）
//   swap(元素)                        内容整块换掉之后调：淡入 + 上移 4px
//   bump(元素)                        数值变了之后调：轻轻一亮
// ════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.V7Motion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MS = { fast: 120, base: 200, slow: 340 };
  const EASE = 'cubic-bezier(.22,.9,.32,1)';   // = tokens.css --ease-out
  const CLASS = 'v7-reduce-motion';

  function docEl() { return typeof document !== 'undefined' ? document.documentElement : null; }
  function reduced() { const el = docEl(); return !!(el && el.classList.contains(CLASS)); }
  function setReduced(on) { const el = docEl(); if (el) el.classList.toggle(CLASS, !!on); }
  function ms(name) { return reduced() ? 1 : (MS[name] || MS.base); }

  function play(el, frames, opts) {
    if (!el || typeof el.animate !== 'function' || reduced()) return null;
    try { return el.animate(frames, Object.assign({ easing: EASE }, opts)); } catch (_) { return null; }
  }

  // 重画一个列表，并让变化看得见。keyOf(子元素) 返回稳定的 key（没 key 的行不参与）。
  // ⚠ 第一次画（之前一行都没有）不播 —— 打开卡片时整列一起飞进来很吵。
  // ⚠ 行数太多（> 60）不播：算位置要强制排版，长列表划不来。
  function listFlip(container, keyOf, render) {
    if (!container || typeof render !== 'function') { if (render) render(); return; }
    const before = new Map();
    if (!reduced()) {
      for (const child of container.children) {
        const k = keyOf(child);
        if (k != null && k !== '') before.set(String(k), child.getBoundingClientRect());
      }
    }
    render();
    if (!before.size || reduced() || container.children.length > 60) return;
    for (const child of container.children) {
      const k = keyOf(child);
      if (k == null || k === '') continue;
      const old = before.get(String(k));
      if (!old) {
        play(child, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: MS.base });
        continue;
      }
      const now = child.getBoundingClientRect();
      const dx = old.left - now.left, dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      play(child, [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: MS.base });
    }
  }

  function swap(el) {
    play(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: MS.base });
  }

  function bump(el) {
    play(el, [{ opacity: .5 }, { opacity: 1 }], { duration: MS.base });
  }

  // 「减少动画」也要管住 JS 的 el.animate()（CSS 那条 !important 规则只管 CSS 动画）。
  // 在这一处包住，各文件不用自己判断：开着时一律 1ms、只播一遍、不延迟；fill / .finished 照旧，收尾逻辑不受影响。
  if (typeof Element !== 'undefined' && Element.prototype.animate && !Element.prototype.animate.__v7Reduce) {
    const native = Element.prototype.animate;
    const wrapped = function (frames, opts) {
      if (!reduced()) return native.call(this, frames, opts);
      const o = typeof opts === 'number' ? {} : Object.assign({}, opts);
      o.duration = 1; o.delay = 0; o.endDelay = 0; o.iterations = 1;
      return native.call(this, frames, o);
    };
    wrapped.__v7Reduce = true;
    Element.prototype.animate = wrapped;
  }

  return { MS, EASE, ms, reduced, setReduced, listFlip, swap, bump };
});
