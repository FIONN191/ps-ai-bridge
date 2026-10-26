/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 记录与恢复（ui-pure/cards/card-history.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: history   index: 4   levels: main-bigzone（单张大二级）
 *
 * 内容现在住在哪
 * ─────────────
 *   `records-card.js`（1318 行）—— 卡面 + 大二级
 *   `records-core.js`（541 行）—— 数据与状态判定
 *   `history-library.js`（262 行）—— 嵌在里面的历史库
 *   三级【不存在】→ 走 `closeRecordsDetail()` 收掉
 *
 * ⚠ 委派壳。零行为变更。
 * ⚠ 这张卡是"找回以前的东西"：近期任务 / 全部历史 / 提示词复用 / 检查点与账单。
 *   **别往它上面挂第三个入口**（注释里明确写着）——
 *   备份 / 布局恢复 / 软件恢复是【设置项】、账单是【账号页】。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    // ⚠ closeRecordsDetail 是 ui.html 里的顶层函数声明 → 在经典 <script> 里是全局的。
    if (typeof root.closeRecordsDetail === 'function') {
      root.closeRecordsDetail();
      return;
    }
    var card = root.V7RecordsCard;
    if (card && typeof card.mount === 'function') {
      card.mount(body);
      return;
    }
    body.innerHTML = '<div class="ai-note">记录与恢复卡没加载起来（records-card.js）。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-history] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'history',
    index: 4,
    name: '记录与恢复',
    levels: 'main-bigzone',
    mount: mount,
    source: 'records-card.js + records-core.js + history-library.js'
  });
})(window);
