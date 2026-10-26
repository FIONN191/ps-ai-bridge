/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 助手（ui-pure/cards/card-assistant.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: assistant   index: 6   levels: main-bigzone（⭐ 2026-10-17 起单张大二级 #assistantZone，没有三级）
 *
 * ⭐ 夏三六（docs/231）：内容由 V7AgentZone 画（agent-zone.js），宿主胶水在 ui.html 的 assistantRoute / assistantOpenZone。
 *   下面「四格」那段是改之前的样子，留着给查历史的人看。
 *
 * 四格
 * ────
 *   0 对话与会话 · 1 模型与连接 · 2 Agent 权限 · 3 恢复节点
 *
 * ⚠⚠ 一个必须知道的事实（docs/148 §三 实测）
 *   「Agent 权限」和「恢复节点」是【同一个折叠块换标题】，不是两块独立内容：
 *       assistant-panel.js:801  for (const node of [tier, grant, current]) node.hidden = section === 'recovery';
 *                                agent.querySelector('summary').textContent = section === 'recovery' ? '恢复节点' : 'Agent 权限';
 *   这是有意为之（省 DOM、少一处漂移），但**用户视角看是"两个格子点进去长得一样"**。
 *   如果这是个 bug，根就在这一行 —— 别去别处找。
 *
 * ⚠ 前置门槛：不连语言模型，点了只会提示"先在设置中连接语言模型"。
 *   这是【设计】不是 bug（assistant-runtime.js:188 的三道闸）。
 *
 * ⚠ 委派壳。零行为变更。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    var arch = root.V7CardArchitecture;
    if (arch && typeof arch.assistant === 'function') {
      arch.assistant(body, Number(zone) || 0);
      return;
    }
    body.innerHTML = '<div class="ai-note">助手卡没加载起来。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-assistant] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'assistant',
    index: 6,
    name: '助手',
    levels: 'main-bigzone',
    mount: mount,
    source: 'agent-zone.js mountZone()（大二级）；旧的 card-architecture.js assistant() 只在新模块没加载时兜底'
  });
})(window);
