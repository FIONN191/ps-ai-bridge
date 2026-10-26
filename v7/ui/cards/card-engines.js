/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 外挂能力（ui-pure/cards/card-engines.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: engines   index: 3   levels: main-bigzone（单张大二级）
 *
 * 内容现在住在哪
 * ─────────────
 *   `engines-card.js`（1640 行）—— 卡面 + 大二级的宿主胶水全在这。
 *   三级【不存在】（2026-10-01 改成单张大二级），所以 ui.html 里
 *   切到这张卡时会走 `closeEnginesDetail()` 明确收掉三级框。
 *
 * ⚠ 委派壳。零行为变更。
 * ⚠ 状态只有一个出口：这张卡的任何状态文字都必须读 `V7EngineStatus`，
 *   **不许自己再判一遍引擎/模型/环境**（契约 §四，先例写在 engines-core.js 注释里）。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    // 单张大二级卡：真正的页面由 engines-card.js 自己挂，三级框只负责"收掉"。
    // ⚠ closeEnginesDetail 是 ui.html 里的顶层函数声明 → 在经典 <script> 里是全局的。
    if (typeof root.closeEnginesDetail === 'function') {
      root.closeEnginesDetail();
      return;
    }
    // 兜底：直接交给卡片模块渲染（万一三级路径没接线）
    var card = root.V7EnginesCard;
    if (card && typeof card.mount === 'function') {
      card.mount(body, { zone: 'all' });
      return;
    }
    body.innerHTML = '<div class="ai-note">外挂能力卡没加载起来（engines-card.js）。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-engines] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'engines',
    index: 3,
    name: '外挂能力',
    levels: 'main-bigzone',
    mount: mount,
    source: 'engines-card.js（大二级宿主）'
  });
})(window);
