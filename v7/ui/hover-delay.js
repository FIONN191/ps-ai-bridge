'use strict';
// ════════════════════════════════════════════════════════════════════
// hover-delay.js —— 鼠标停一下才弹，划过去不闪（docs/263 第 7 条，10-22 用户拍板「实装」）
//
//   · 第一次弹：鼠标停 120ms 才弹（划过去不弹）
//   · 已经有一个开着（或刚关不到 300ms）：挪到隔壁【立刻】换，不再等 —— 浏览一排时不会觉得慢
//   · 离开：留 80ms 宽限再收，鼠标从按钮划到气泡中间的缝不会闪一下
//
// 用法：
//   const hd = V7HoverDelay.create();
//   over:  hd.show(() => 打开(目标))
//   out:   hd.hide(() => 收起())
//   点击 / 键盘聚焦这类明确操作照旧立刻打开，不经过它（调用方直接调 打开()，再 hd.opened() 告诉它开着）。
//
// ⚠ 不是所有悬停都该等：PS 里看图层的缩略图（scrub 对比）、引擎卡右栏页签（用户 10-05 嫌慢专门调到 45ms）不用它。
// ════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.V7HoverDelay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function create(opts) {
    const o = opts || {};
    const DELAY = o.delay == null ? 120 : o.delay;
    const GRACE = o.grace == null ? 80 : o.grace;
    const WARM = o.warm == null ? 300 : o.warm;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    let showT = 0, hideT = 0, open = false, closedAt = -Infinity;
    function clear() { if (showT) { clearTimeout(showT); showT = 0; } if (hideT) { clearTimeout(hideT); hideT = 0; } }
    return {
      show(fn) {
        clear();
        if (open || now() - closedAt < WARM) { open = true; fn(); return; }
        showT = setTimeout(() => { showT = 0; open = true; fn(); }, DELAY);
      },
      hide(fn) {
        if (showT) { clearTimeout(showT); showT = 0; }
        if (!open) return;
        if (hideT) clearTimeout(hideT);
        hideT = setTimeout(() => { hideT = 0; open = false; closedAt = now(); fn(); }, GRACE);
      },
      // 明确操作（点击 / 聚焦）立刻开了的，告诉它一声
      opened() { clear(); open = true; },
      // 外部已经关掉了（Esc / 滚动 / 点别处）
      closed() { clear(); if (open) { open = false; closedAt = now(); } },
      isOpen: () => open
    };
  }
  return { create };
});
