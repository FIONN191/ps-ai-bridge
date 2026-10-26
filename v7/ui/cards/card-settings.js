/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 设置（ui-pure/cards/card-settings.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: settings   index: 2   levels: main-bigzone（单张大二级，右边点阵导航）
 *
 * 内容现在住在哪
 * ─────────────
 *   页面框架（点阵导航 + 页签容器）→ ui.html `fillSettingsDetail()`（13271 行）
 *   每页的具体内容 → `card-architecture.js settings(body, zone)`
 *                    （它再往下分给 settingsTab / defaults / storage /
 *                     mountServices / mountProjectRecords 等）
 *
 * ⚠ 委派壳。零行为变更。
 * ⚠ 这张卡有个历史漂移（已记录、未修）：
 *   card-registry.js 说它 1 个二级格、代码里 ZONE_SETS 有 4 个残留标签、
 *   SETTINGS_TABS 又是 5 个 —— 三方对不上。check-card-registry.cjs 会报出来。
 *   拆这张卡时**顺便把这三方对齐**，是后面的事，不是这一轮。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    var arch = root.V7CardArchitecture;
    if (arch && typeof arch.settings === 'function') {
      arch.settings(body, Number(zone) || 0);
      return;
    }
    body.innerHTML = root.V7Format ? root.V7Format.skeletonHtml(6) : '<div class="ai-note">设置页加载中，请稍候。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-settings] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'settings',
    index: 2,
    name: '设置',
    levels: 'main-bigzone',
    mount: mount,
    source: 'card-architecture.js settings() / settingsTab()'
  });
})(window);
