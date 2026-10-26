/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 调试（ui-pure/cards/card-debug.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: debug   index: 7   levels: main-zone（3 个二级格）
 *
 * 三格
 * ────
 *   0 运行日志与诊断 · 1 网络体检 · 2 书签
 *
 * ⚠ 这张卡 2026-10-06 刚被改成【只读诊断】（docs/150 Phase E）：
 *   引擎/模型的【操作按钮全删了】，只留只读状态，加一句"去外挂能力卡 · 配置信息"。
 *   历史坑：错误文案原来写"设置 → 工具与隐私 → 引擎"，实际环境 UI 在调试卡；
 *   而 `ENGINE_*`/`MATTING_*` 的"下一步"高亮指向 `[data-engine-box]`/`[data-matting-box]`
 *   —— 那两个框在调试卡里，早就删了，**高亮一直静默落空**。
 *   现在统一指 `[data-engine-status]`（外挂卡配置页的状态条）。
 *   **别再往这张卡上加操作按钮**，它现在的定位是只读。
 *
 * ⚠ 委派壳。零行为变更。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    var arch = root.V7CardArchitecture;
    if (arch && typeof arch.debug === 'function') {
      arch.debug(body, Number(zone) || 0);
      return;
    }
    body.innerHTML = '<div class="ai-note">调试卡没加载起来。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-debug] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'debug',
    index: 7,
    name: '调试',
    levels: 'main-zone',
    mount: mount,
    source: 'card-architecture.js debug()'
  });
})(window);
