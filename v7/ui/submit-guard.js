'use strict';
// ════════════════════════════════════════════════════════════════════
// submit-guard.js —— 防连点（docs/263 第 9 条，10-22 用户拍板「实装」）
//
// 问题：提交类按钮手快双击 = 提交两次；生成就是扣两次分。
// ⚠⚠ 为什么不是「点了锁 1 秒」：生成链路是【故意】让连续点击各算一单的
//   （aiBeginImmediate 里专门加了进程内序号，保证每个点击都是独立任务）—— 有人就是连点三下排三单。
//   锁 1 秒会把这个用法拦掉。
// ⇒ 只拦「系统认定为双击的第二下」（click 事件的 detail ≥ 2：同一位置、系统双击间隔内）。
//   正常节奏点几下：每下 detail 都是 1，照常一下一单；手抖双击：第二下被吞掉。
//
// 在 document 捕获阶段拦：比按钮自己挂的监听先跑，stopImmediatePropagation 后它们收不到。
// 新加的提交按钮：要么用下面列表里的标记，要么加 data-submit-once。
// ════════════════════════════════════════════════════════════════════
(function (root) {
  const SUBMIT = [
    '[data-ai-action="generate"]', '[data-ai-action="full"]', '[data-generation-run]',
    '[data-run]', '[data-node-run]', '[data-color-run]', '[data-batch-run]', '[data-return-run]', '[data-af-start]',
    '[data-transfer]', '[data-twtransfer]', '[data-node-transfer]', '[data-ct-transfer]', '[data-color-transfer]', '[data-ct-upload]',
    '[data-support-submit]', '[data-community-submit]', '[data-recovery-submit]', '[data-recovery-resend]', '[data-assistant-send]',
    '[data-retry]', '[data-ct-retry]', '[data-batch-retry]', '[data-eagle-retry]',
    'button[type="submit"]', 'input[type="submit"]', '[data-submit-once]'
  ].join(',');
  let blocked = 0;
  function onClick(e) {
    if (!(e.detail >= 2)) return;
    const t = e.target && e.target.closest ? e.target.closest(SUBMIT) : null;
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    blocked++;
  }
  if (typeof document !== 'undefined') document.addEventListener('click', onClick, true);
  root.V7SubmitGuard = { selector: SUBMIT, blockedCount: () => blocked };
})(typeof window !== 'undefined' ? window : globalThis);
