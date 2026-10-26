/* ══════════════════════════════════════════════════════════════════════════
 * 卡片 · 生成（ui-pure/cards/card-generation.js）
 * ══════════════════════════════════════════════════════════════════════════
 * id: generation   index: 0   levels: main-bigzone（单张大二级，没有三级）
 *
 * ⭐⭐ 2026-10-15 用户定：「生成卡片的二级菜单和三级菜单基本已经没用了…
 *   把目前所有的二级目录删除，换成和别的卡片一样的二级大卡片。然后三级卡片就直接不要了。」
 *   ⇒ 原来 4 个二级格（生成图片 / 参考图片 / 生成结果 / 生成与传回设置）+ 三级，
 *     合成【一张】540×400 大二级（#generationZone），一列到底、右边导航点哪滚到哪。
 *     组件跟设置卡是同一个（V7SettingsCard），宿主胶水在 ui.html 搜 generationCardMount。
 *
 * 内容住在哪
 * ─────────
 *   大二级的整页 → ui.html `renderGenerationPage(body)`（四节：开始生成 / 参考图 / 生成结果 / 相关设置）
 *   老的单档面板 → ui.html `renderGenerationPanel(body, zone)`（还留着：老调用方、测试直接调它）
 *
 * ⚠ mount 怎么分辨"新的大二级"和"老的三级"：看 body 在不在 #generationZone 里。
 *   在 → 画整页；不在（有人还往 #dcBody 里按档位画）→ 照老规矩画那一档，行为一个字不变。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function mount(body, zone) {
    var panel = root.V7GenerationPanel;
    var inBigZone = !!(body && body.closest && body.closest('#generationZone'));
    if (inBigZone) {
      if (panel && typeof panel.renderPage === 'function') { panel.renderPage(body); return; }
      if (root.console && console.error) console.error('[card-generation] V7GenerationPanel.renderPage 没就位 —— ui.html 里 renderGenerationPage 是否还在？');
      body.innerHTML = '<div class="ai-note">生成卡的大二级没接线（renderGenerationPage）。<br>规矩见 ui-pure/cards/_CONTRACT.md。</div>';
      return;
    }

    // ── 下面是老路径（往 #dcBody 按档位画），保留给老调用方 ──
    var zoneIndex = Number(zone) || 0;
    if (zoneIndex === 3) {
      var arch = root.V7CardArchitecture;
      if (arch && typeof arch.generation === 'function') { arch.generation(body); return; }
      body.innerHTML = '<div class="ai-note">生成与传回设置没加载起来（card-architecture.js）。</div>';
      return;
    }
    if (panel && typeof panel.render === 'function') { panel.render(body, zoneIndex); return; }
    if (root.console && console.error) {
      console.error('[card-generation] V7GenerationPanel 没就位 —— ui.html 里 renderGenerationPanel 是否还在？');
    }
    body.innerHTML = '<div class="ai-note">生成卡的分区内容没接线（档位 ' + zoneIndex +
      '）。<br>规矩见 ui-pure/cards/_CONTRACT.md。</div>';
  }

  if (!root.V7CardManager) {
    console.error('[card-generation] V7CardManager 没加载：检查 ui.html 里 card-manager.js 是否排在卡片脚本前面');
    return;
  }
  root.V7CardManager.register({
    id: 'generation',
    index: 0,
    name: '生成',
    levels: 'main-bigzone',
    mount: mount,
    source: 'ui.html renderGenerationPage()（大二级整页）；老档位面板 renderGenerationPanel() 保留'
  });
})(window);
