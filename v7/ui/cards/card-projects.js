/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 项目（ui-pure/cards/card-projects.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: projects   index: 5   levels: main-zone（4 个二级格）
 *
 * 四格（2026-09-29 方案 B 重排后的顺序，⚠ 别再按老顺序写硬编码）
 * ─────────────────────────────────────────────────────────
 *   0 项目管理 · 1 本项目记录 · 2 拍摄日程 · 3 Eagle 归档
 *
 * ⚠ 索引重排埋过一次雷：`V7ProjectSchedule.configure({navigate:section=>navigateCard('projects',{projects:0,schedule:2,eagle:3}...)}`
 *   那张映射表原来写 `['projects','schedule','eagle']`，重排后 `open('schedule')`
 *   会落到第 2 格（现在是「本项目记录」）—— 日程页再也打不开。
 *   加格子、挪格子之后，**必须回头核这张映射表**。
 *
 * ⚠ 委派壳。零行为变更。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    var arch = root.V7CardArchitecture;
    if (arch && typeof arch.projects === 'function') {
      arch.projects(body, Number(zone) || 0);
      return;
    }
    body.innerHTML = '<div class="ai-note">项目卡没加载起来。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-projects] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'projects',
    index: 5,
    name: '项目',
    levels: 'main-zone',
    mount: mount,
    source: 'card-architecture.js projects() → V7ProjectSchedule'
  });
})(window);
