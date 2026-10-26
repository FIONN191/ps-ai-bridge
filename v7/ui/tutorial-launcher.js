/* ⭐ 2026-10-18 新手教程 · 主窗口这一侧的「开教程」（教程本体是外壳开的全屏窗口 tutorial.html）。
 *
 * 用户定的规矩（docs/243 / docs/245 §2.1）：
 *   · 所有人都要做一遍（老用户也一样）；可以跳过；跳过后在「设置 → 关于软件 → 重新看教程」能回来，还能挑章节；
 *   · 以后加新功能 = 加一章：升级后只弹新加的那几章（tutorial-chapters.js 里章节的 id + version）；
 *   · 首次打开顺序：用户协议 → 登录（必须）→ 教程 → 装插件 → 选出图方式 ⇒ 这里等「已同意条款 + 已登录」才自动弹。
 *
 * 进度存在 localStorage（跟着这台电脑，不进账号云备份）：
 *   wheelchair.v7.tutorial.progress.v1 = { done:{章节id:版本}, skipped:{章节id:版本}, skippedAt, finishedAt, current }
 *   某章内容改了把它的 version 加一，那一章会重新弹。
 *
 * ⭐⭐ 2026-10-18 深夜（用户：「用 flag 记录用户是否看过这节教程，没看过就每次启动弹」）：
 *   · done[章节id] = 那一章【整章走完】的标记（tutorial.js 的 markDone）—— 这就是「看过没有」的 flag；
 *   · 每次启动（登录后）检查：还有没走完的章节就弹，教程里只放没看过的那几章；全部看完就不弹；
 *   · 跳过只管这一次：skipped 只留作记录，【不再】算看过 —— 下次启动照样弹，直到看完。
 */
(function (root) {
  'use strict';
  if (root.__V7_TUTORIAL__) return;            // 教程里的那份界面不再开教程
  var KEY = 'wheelchair.v7.tutorial.progress.v1';
  var SESSION = 'wheelchair.v7.tutorial.autoShown';

  function progress() { try { return JSON.parse(root.localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; } }
  function chapters() { return (root.V7Tutorial && root.V7Tutorial.chapters) || []; }
  // 还没看完的章节（按版本比；跳过的不算看过）
  function pending() {
    var p = progress(), done = p.done || {};
    return chapters().filter(function (c) { var v = c.version || 1; return !(done[c.id] >= v); });
  }
  function open(chapter) {
    if (!root.uiwin || !root.uiwin.tutorial || typeof root.uiwin.tutorial.open !== 'function') return Promise.resolve({ ok: false, error: '这一份软件没有教程窗口' });
    return Promise.resolve(root.uiwin.tutorial.open(chapter || '')).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // ── 自动弹：条款同意了、登录了、还有没做的章节、这次开软件还没弹过 ──
  var tries = 0, timer = 0;
  function ready() {
    if (new URLSearchParams(root.location.search).has('ui-test')) return false;
    if (!root.V7FirstRun || !root.V7FirstRun.isComplete()) return false;
    var b = root.V7Backend && root.V7Backend.state && root.V7Backend.state();
    return !!(b && b.signedIn);
  }
  function tick() {
    tries++;
    try { if (root.sessionStorage.getItem(SESSION)) return stop(); } catch (_) {}
    if (!ready()) { if (tries > 600) stop(); return; }       // 最多等 20 分钟（等用户同意条款、登录）
    stop();
    if (!pending().length) return;
    try { root.sessionStorage.setItem(SESSION, '1'); } catch (_) {}
    open('').then(function (r) {
      if (r && r.ok === false && root.ERR) root.ERR.report('TUTORIAL_OPEN_FAILED', { message: r.error || '教程窗口没打开' });
    });
  }
  function stop() { if (timer) { root.clearInterval(timer); timer = 0; } }
  // 1.9.1 曾经先关着（教程第二版用户还没过目）；10-18 深夜用户定「没看过就每次启动弹」⇒ 打开。
  var AUTO_OPEN = true;
  root.addEventListener('DOMContentLoaded', function () { if (AUTO_OPEN) timer = root.setInterval(tick, 2000); });

  root.V7TutorialLauncher = { open: open, pending: pending, progress: progress, key: KEY };
})(window);
