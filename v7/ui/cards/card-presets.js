/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 预设（ui-pure/cards/card-presets.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: presets   index: 1   levels: main-zone（1 个大二级格）
 *
 * 内容现在住在哪
 * ─────────────
 *   `preset-ui.js`（3378 行）—— `PRESETUI.fillDetail(animate, dir)`。
 *   注意它走的不是 (body, zone) 签名，而是 (animate, dir)：
 *   它自己知道该往 #dcBody 里画什么。
 *
 * ⚠ 委派壳。零行为变更。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    var ui = root.PRESETUI;
    if (ui && typeof ui.fillDetail === 'function') {
      // ⚠ 预设系统自己管动画与方向，这里不复用 animate/dir ——
      //   传 false 让它首帧直接填（与老路径 fillDetailBody 里的调用一致）。
      ui.fillDetail(false, 0);
      return;
    }
    body.innerHTML = '<div class="ai-note">预设系统没加载起来（preset-ui.js）。看一眼控制台。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-presets] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'presets',
    index: 1,
    name: '预设',
    levels: 'main-zone',
    mount: mount,
    source: 'preset-ui.js PRESETUI.fillDetail()'
  });
})(window);
