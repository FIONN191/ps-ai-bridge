/* 浏览器刷新键拦截（2026-10-20，docs/256 F2：用户报「点击任意软件卡片后 Ctrl+R 会刷新软件」）。
 *
 *   这是桌面软件，不是网页：Ctrl+R / Ctrl+Shift+R / F5 一按，整个界面就重新加载 ——
 *   正在跑的任务、没存的输入、剪影编辑器里没保存的修改全丢。原来一个窗口都没拦。
 *   ⚠ 只 preventDefault（不让浏览器去刷新），不拦冒泡：用户自己把某个快捷键设成 Ctrl+R 时，软件自己的处理照常收到。
 *   ⚠ 每个窗口页面都要引用（ui.html / 大图 / L4 / 首次设置 / 剪影编辑器 / 教程），tests/feedback-batch2-fixes.test.js 会查。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root.addEventListener === 'function') {
    root.addEventListener('keydown', api.onKeyDown, true);
    root.V7ReloadGuard = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function isReloadKey(e) {
    if (!e) return false;
    const key = String(e.key || '');
    if (key === 'F5') return true;                       // F5 / Ctrl+F5 / Shift+F5
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;   // 带 Alt 的（含 AltGr 打出来的字）不算
    return key === 'r' || key === 'R' || e.code === 'KeyR';    // Ctrl+R / Ctrl+Shift+R / Mac ⌘R
  }
  function onKeyDown(e) {
    if (isReloadKey(e)) e.preventDefault();
  }
  return { isReloadKey: isReloadKey, onKeyDown: onKeyDown };
});
