/* ⭐ 2026-10-18 新手教程 · 章节内容（播放器在 tutorial.js，方案 docs/243 第三节）。
 *
 * 第二版（10-18 晚，按用户试用后的意见改，记忆 project_v7_tutorial_feedback_20261018）：
 *   · 删了助手、项目两章（功能没打磨好）；外挂工具（抠像 / 人体解析 / 指哪抠哪）没测好，不让学员用，只指位置；
 *   · 加了：连 PS（装插件 → 增效工具打开面板 → 拖到一边放好）、预设系统、自由模式、设置卡导览；
 *   · 右滑是核心操作，第 0 章就教、就练；框选一律「先选矩形选框工具 → 照着黄色虚线框框准」；
 *   · 快捷键默认都没有：开始生成先点 ▶，再带学员自己设快捷键；
 *   · 记录与恢复只讲「攒光」。
 *
 * 每章 = 先「看我做」（演示：假手自动做，学员这时动不了界面）→ 再「轮到你了」（动手：做对了才放行）。
 * 一步的写法：
 *   { kind: 'tell' | 'demo' | 'try',
 *     text:   气泡里的话（可以带 <b>），
 *     target: 高亮谁（可以是数组，同时框几块）—— {app:'css'} 真界面里 / {ps:'css'} 假 PS 里 / {canvasBox:[x,y,w,h]} 照片上 /
 *             function(api) 返回元素或 {appRect:{…}}；加 label 会在框上写名字（函数用 lab(fn, '名字')）,
 *     swipe:  true = 这一步要往右滑，气泡别挡目标右边那片,
 *     guide:  [x,y,w,h] 照片上显示黄色虚线框（照着框选）,
 *     enter:  进这一步时先摆好场景（可选）,
 *     demo:   自动演示（可选；演示完「下一步」才亮）,
 *     task:   你来做的那件事（try 才有）,
 *     check:  (api, m) => 做对了没有（m = 这一步开始时的计数快照，可以往上记东西）,
 *     help:   做不出来时「帮我做一下」干什么（真点按钮，不跳过检查） }
 *   章节：needsPlugin:false = 这一章不需要 PS 插件连着（第 0、1 章）。
 *
 * ⚠ 检查一律看「结果」：假 PS 收到了什么（api.since(m,'a:动作名')）、真界面的状态（api.peek()）——
 *   不看学员点没点某个按钮，换个入口做对了也算。
 * ⚠ 以后加新功能 = 在末尾加一章、version 从 1 起；改了老章节内容就把它的 version 加一（学员会被要求重看那一章）。
 */
(function (root) {
  'use strict';

  // ── 小工具 ──
  function lab(t, label) {
    if (typeof t === 'function') { var f = function (a) { return t(a); }; f.label = label; return f; }
    return Object.assign({}, t, { label: label });
  }
  var card = function (id) { return { app: '.block-card[data-card="' + id + '"]' }; };
  var topCard = function (api) { return api.q('.block-card[data-card="' + (api.peek().card || 'generation') + '"]'); };
  var topTask = function (api) { return api.q('#tasks .task'); };
  var preview = function (api) { var t = topTask(api), id = t && t.dataset.task; return id ? api.q('.task-preview[data-preview="' + id + '"]') : null; };
  var previewOpen = function (api) { var p = preview(api); return !!(p && p.classList.contains('show')); };
  function taskThumbAt(api, n) { var p = preview(api); var list = p ? Array.prototype.slice.call(p.querySelectorAll('.pv-cell img')) : []; return list[n] || list[0] || null; }
  var taskThumb = function (api) { return taskThumbAt(api, 0); };
  var refThumbs = function (api) { return api.qa('.ref-card [data-ref-remove]').filter(function (b) { return b.offsetWidth; }); };
  // 参考图顺序：按缩略图本身（几张的名字可能一样，拿名字比看不出换没换顺序 —— 10-18 晚走查实测）
  var refOrder = function (api) { return api.qa('.ref-card [data-ref-view]').map(function (b) { return b.style.backgroundImage || b.title; }).join('|'); };
  // 自由模式下露在最上面、拖得动的那张卡的小横线（叠在一组里被压在下面的拖不到）
  function freeBar(api, skip) {
    var bars = api.qa('.block-card [data-dragbar]').filter(function (b) { return api.visible(b); });
    for (var i = 0; i < bars.length; i++) {
      var card = bars[i].closest('.block-card'); if (skip && card.dataset.card === skip) continue;
      var r = bars[i].getBoundingClientRect(), hit = api.doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && card.contains(hit)) return bars[i];
    }
    return null;
  }
  function firstVisible(api, sel) { return api.qa(sel).find(function (el) { return api.visible(el); }) || null; }
  var pd = function (sel) { return function (api) { return firstVisible(api, '#promptZone ' + sel) || firstVisible(api, '#detail ' + sel) || firstVisible(api, sel); }; };
  var AUTO_RETURN = '.block-card[data-card="generation"] [data-setting="autoReturn"]';
  var PRESET_ID = 'tutorial-face-retouch', PRESET_TITLE = '教程·修脸';
  var setsec = function (id) { return { app: '#setsec-' + id }; };
  // 这一步要「设置卡的二级开着、滚到某一节」（用户 10-18 晚：学员不一定开着二级 —— 收起来时别把框画在空地方）
  function needSettings(section) {
    return { test: function (api) { var p = api.peek(); return p.card === 'settings' && p.zoneOpen && api.visible('#setsec-' + section); },
      how: '设置的二级收起来了：滚到「设置」卡，在卡上往右滑把它打开',
      target: lab(card('settings'), '先翻到设置卡，往右滑打开'),
      fix: function (api) { return api.navigate('settings', 0, { section: section }); } };
  }
  // 这一步要「提示词面板开着」（在预设列表那一行上右滑 / 点那一行才出来）
  var needPrompt = { test: function (api) { return !!runButton(api); },
    how: '提示词面板收起来了：在剪影预设列表里再点一下「教程·修脸」那一行',
    target: lab({ app: '.pz-row[data-preset-id="tutorial-face-retouch"]' }, '再点一下这一行'),
    fix: function (api) { return pickTutorialPreset(api); } };
  // 开关的勾选框是藏起来的（看不见、量不出位置），高亮和点都用它外面那个开关外框
  var toggleOf = function (sel) { return function (api) { var el = api.q(sel); return el && el.closest('.tgl') || el; }; };
  // 主卡堆整体、它右边二级卡出来的地方、它下面那一片（任务卡 / 报错卡 / 参考图卡）
  function stackRect(api) {
    var cards = api.qa('.block-card').filter(function (c) { return api.visible(c); });
    if (!cards.length) return null;
    var rs = cards.map(function (c) { return c.getBoundingClientRect(); });
    var l = Math.min.apply(null, rs.map(function (r) { return r.left; })), t = Math.min.apply(null, rs.map(function (r) { return r.top; }));
    var rr = Math.max.apply(null, rs.map(function (r) { return r.right; })), b = Math.max.apply(null, rs.map(function (r) { return r.bottom; }));
    return { left: l, top: t, width: rr - l, height: b - t };
  }
  var REGION_STACK = function (api) { var r = stackRect(api); return r && { appRect: r }; };
  var REGION_ZONE = function (api) { var r = stackRect(api); return r && { appRect: { left: r.left + r.width + 24, top: r.top, width: 620, height: Math.max(r.height, 420) } }; };
  var REGION_BELOW = function (api) { var r = stackRect(api); return r && { appRect: { left: r.left - 4, top: r.top + r.height + 10, width: r.width + 8, height: 330 } }; };

  // 照片上几块常用的地方（0~1）。⚠ 跟着占位照片画的人像定的；换真素材时一起改。
  var FACE = [0.33, 0.15, 0.34, 0.3], CLOTH = [0.24, 0.52, 0.52, 0.44], HAIR = [0.32, 0.12, 0.36, 0.14], PERSON = [0.12, 0.08, 0.76, 0.9];
  function box(api, b) { return api.marquee(b[0], b[1], b[2], b[3]); }
  // 框选步骤（统一做法）：先选矩形选框工具 → 照着虚线框框 → 框准了才算
  function frameStep(b, what, extraText) {
    return { kind: 'try', target: { ps: '#psCanvas' }, guide: b, guideLabel: '照着这个框：' + what,
      text: '你来：先点左边工具栏的<b>矩形选框工具</b> ⬚（或者按键盘上的 <b>M</b>），再<b>照着黄色虚线框</b>把' + what + '框出来。框准了虚线框会变绿。' + (extraText || ''),
      task: '选矩形选框工具 → 照着虚线框框' + what,
      check: function (api, m) {
        if (api.tool() !== 'marquee') { if (api.since(m, 'wrongTool') > 0) api.note('先点左边工具栏的「矩形选框工具」⬚'); return false; }
        if (api.since(m, 'userSelect') <= 0) return false;
        if (api.selectionScore(b) < 0.55) { api.note('框得不太准：照着黄色虚线框再框一次'); return false; }
        return true;
      },
      help: function (api) { return api.setTool('marquee').then(function () { return box(api, b); }).then(function () { api.stats.userSelect = (api.stats.userSelect || 0) + 1; }); } };
  }
  function ids(api) { var s = {}; api.tasks().forEach(function (t) { s[t.id] = 1; }); return s; }
  function newTasks(api, m) { return api.tasks().filter(function (t) { return !(m.ids && m.ids[t.id]); }); }
  function isDone(t) { return t && (t.status === 'done' || t.status === 'completed' || (t.done > 0 && t.status !== 'running')); }
  function runButton(api) { return pd('.pd-hb-run')(api); }
  function presetsReady(api) { return api.navigate('presets').then(function () { return api.until(function () { return api.q('.pz-row[data-preset-id]'); }, 6000); }); }
  // 选教程的修脸预设（列表里点那一行；不在当前列表里就先切到「头部面部」）
  function pickTutorialPreset(api) {
    return presetsReady(api).then(function () {
      if (!api.q('.pz-row[data-preset-id="' + PRESET_ID + '"]')) { try { api.app.PRESETUI.selectAsset('head'); } catch (_) {} }
      return api.until(function () { return api.q('.pz-row[data-preset-id="' + PRESET_ID + '"]'); }, 4000);
    }).then(function () { return api.click({ app: '.pz-row[data-preset-id="' + PRESET_ID + '"]' }); })
      .then(function () { return api.until(function () { return runButton(api); }, 4000); });
  }
  function presetTitleNow(api) { try { return api.app.PRESETUI.getPresetTitle(); } catch (_) { return ''; } }
  function promptText(api) { try { return api.app.PRESETUI.getText(); } catch (_) { return ''; } }
  function paramValue(api, name) { var m = new RegExp('"@param:' + name + '"\\s*:\\s*([\\d.]+)').exec(promptText(api)); return m ? Number(m[1]) : null; }
  function fieldValue(api, name) { var m = new RegExp('【填空:' + name + '(?:=([^】]*))?】').exec(promptText(api)); return m ? (m[1] || '') : null; }
  // 出一张图（演示 / 帮做用）：框好 → 选好预设 → 点 ▶ → 等出来
  function generate(api, area) {
    var m = { ids: ids(api) };
    return api.setTool('marquee').then(function () { return box(api, area || FACE); })
      .then(function () { return presetTitleNow(api) === PRESET_TITLE && runButton(api) ? null : pickTutorialPreset(api); })
      .then(function () { return api.click(runButton); })
      .then(function () { return api.until(function () { var n = newTasks(api, m); return n.length && isDone(n[0]); }, 20000); });
  }
  function setBatch(api, n) {
    var el = api.q('.block-card[data-card="generation"] [data-ai-field="batch"]') || api.q('[data-ai-field="batch"]');
    if (!el) return;
    el.value = String(n);
    el.dispatchEvent(new api.app.Event('input', { bubbles: true }));
    el.dispatchEvent(new api.app.Event('change', { bubbles: true }));
  }
  // 要一张「已经出好、还没传回」的任务；没有就先出一张（minShots：这一批至少几张）
  function ensurePendingTask(api, minShots) {
    var t = api.tasks()[0];
    if (t && isDone(t) && !t.layers && t.done >= (minShots || 1)) return Promise.resolve();
    if (api.settings().autoReturn) api.saveSettings({ autoReturn: false });
    setBatch(api, minShots || 1);
    return generate(api);
  }
  // 要一批「已经传回 PS」的任务（图层联动、切校色要用）。⚠ 至少两张：划缩略图要从一张划到另一张
  function ensureReturnedTask(api) {
    var t = api.tasks()[0];
    if (t && t.layers >= 2) return Promise.resolve();
    return ensurePendingTask(api, 2).then(function () {
      var m = api.mark();
      return api.click(function (a) { return a.q('#tasks .task [data-task-send]'); })
        .then(function () { return api.until(function () { return api.since(m, 'a:ps.layer.placeBatch') + api.since(m, 'a:ps.layer.place') > 0 && api.tasks()[0].layers > 0; }, 10000); });
    }).then(function () { setBatch(api, 1); });
  }
  // 设一个快捷键：在设置卡快捷键那一格里按组合键（跟学员真按一样走录键那段代码）
  function recordShortcut(api, field, combo) {
    var sel = '#setsec-shortcuts [data-setting="' + field + '"]';
    return api.navigate('settings', 0, { section: 'shortcuts' }).then(function () { return api.until(function () { return api.q(sel); }, 4000); })
      .then(function () { return api.click({ app: sel }); }).then(function () {
        var el = api.q(sel), W = api.app; if (!el) return;
        el.focus();
        el.dispatchEvent(new W.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, combo)));
      });
  }
  function keyText(spec) { var n = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter' }; return String(spec || '').split('+').filter(Boolean).map(function (k) { return n[k] || k.toUpperCase(); }).join(' + '); }
  // 剪影上某个部位在屏幕上的哪个点（剪影是一整张图，靠点的位置判部位）。
  //   ⚠ 要用跟界面一样的命中算法（V7ToolSilhouettes.previewHitTest + 当前排版），
  //     PRESETS.hitTest 是素材原始坐标，跟卡片上实际显示的位置对不上（10-18 晚走查实测点不中）
  function partPoint(api, part) {
    var inner = api.q('.block-card[data-card="presets"] .ps-canvas-inner'); if (!inner) return null;
    var r = inner.getBoundingClientRect(), W = api.app, best = null;
    var hit = function (ux, uy) {
      try {
        var T = W.V7ToolSilhouettes, S = W.PRESETUI && W.PRESETUI.state;
        if (T && T.previewHitTest && S) return T.previewHitTest(W.PRESETS.assets(), S.previewLayout, ux, uy);
        return W.PRESETS.hitTest(ux, uy);
      } catch (_) { return null; }
    };
    for (var uy = 0.04; uy < 0.96 && !best; uy += 0.02) for (var ux = 0.1; ux < 0.9; ux += 0.02) {
      var h = hit(ux, uy);
      if (h && (h.id === part || h.category === part)) { best = { ux: ux, uy: uy }; break; }
    }
    if (!best) return null;
    var s = api.appToScreen({ left: r.left + best.ux * r.width, top: r.top + best.uy * r.height, width: 0, height: 0 });
    return { x: s.left, y: s.top };
  }
  function selectedPart(api) { try { return String(api.app.PRESETUI.state.selAsset || ''); } catch (_) { return ''; } }
  function clickPart(api, part) {
    var p = partPoint(api, part);
    return (p ? api.clickAt(p.x, p.y) : Promise.resolve()).then(function () {
      // 点没中（剪影素材换过之类）：直接选中那个部位，教程照样往下走
      if (selectedPart(api) !== part) { try { api.app.PRESETUI.selectAsset(part); } catch (_) {} }
    });
  }

  var chapters = [
    // ───────────────────────────────────────────── 0 认识界面
    {
      id: 'intro', no: 0, version: 2, title: '认识界面', summary: '各块区域是什么；换卡、右滑、收起、拖动', needsPlugin: false,
      setup: function (api) { return api.navigate('generation'); },
      steps: [
        { kind: 'tell', target: [lab(REGION_STACK, '① 主卡')],
          text: '左边是一个<b>假的 Photoshop</b>，右边浮着的就是<b>修图轮椅</b>。真用的时候它是一个浮在 PS 上面的透明窗口，PS 照常用。<br><b>① 主卡</b>：一张张叠着的卡（生成、预设、设置、外挂能力、记录……），最上面那张就是现在在用的。' },
        { kind: 'tell', target: [lab(REGION_STACK, '① 主卡'), lab(REGION_ZONE, '② 二级卡出来的地方')],
          text: '<b>② 二级卡</b>：在主卡上<b>往右滑</b>，主卡右边会推出一张大卡，放这张卡的全部内容（比如生成卡的全部参数、设置卡的全部设置）。待会儿就教你右滑。' },
        { kind: 'demo', target: [lab(REGION_BELOW, '③ 任务卡 / 报错卡 / 参考图卡')],
          text: '<b>③ 主卡下面这一片</b>：<br>· <b>任务卡</b>：每次生成一张，显示进度、结果；<br>· <b>报错卡</b>：出了问题写清楚是什么事、怎么办（小的自己消失，要你决定的会一直等你）；<br>· <b>参考图卡</b>：加了参考图才出现。<br>看，这就是一张报错卡（演示用）。',
          demo: function (api) { try { api.app.ERR.report('BRIDGE_RECONNECTED', { message: '这是一张示例提示卡（教程演示）' }); } catch (_) {} return api.sleep(1500); } },
        { kind: 'demo', target: topCard,
          text: '<b>换卡</b>：鼠标放在主卡上<b>滚一下滚轮</b>，下面那张就翻上来。看我滚过去、再滚回来。',
          demo: function (api) { return api.wheel(topCard, 120, 1).then(function () { return api.sleep(800); }).then(function () { return api.wheel(topCard, -120, 1); }); } },
        { kind: 'try', target: topCard, text: '你来：在主卡上滚滚轮，翻到<b>「设置」</b>卡。', task: '翻到「设置」卡',
          check: function (api) { return api.peek().card === 'settings'; },
          help: function (api) { return api.navigate('settings'); } },
        { kind: 'try', target: topCard, text: '很好。再往反方向滚，回到<b>「生成」</b>卡。', task: '回到「生成」卡',
          check: function (api) { return api.peek().card === 'generation'; },
          help: function (api) { return api.navigate('generation'); } },
        { kind: 'demo', target: [topCard, lab(REGION_ZONE, '二级卡从这里出来')], swipe: true,
          text: '<b>右滑</b>是修图轮椅<b>最重要的操作</b>：鼠标在卡上<b>慢慢往右移，移出卡的右边缘</b>，下一层就推出来了。<br>主卡 → 二级卡、预设列表的一行 → 它的提示词、任务卡 → 缩略图、参考图卡 → 管理区，全是右滑。<br>看我滑一次：',
          enter: function (api) { try { api.app.closeAll(); } catch (_) {} },
          demo: function (api) { return api.swipe(topCard).then(function () { return api.until(function () { return api.peek().zoneOpen; }, 3000); }).then(function () { return api.sleep(1200); }); } },
        { kind: 'try', target: topCard, swipe: true,
          text: '你来：先把鼠标移开让二级卡收起来，再在「生成」主卡上<b>慢慢往右滑</b>，移出右边缘，把二级卡推出来。<br><small>太快甩过去不算，慢慢推。</small>', task: '在主卡上往右滑，推出二级卡',
          enter: function (api, m) { try { api.app.closeAll(); } catch (_) {} m.closed = false; },
          check: function (api, m) { var z = api.peek().zoneOpen; if (!z) m.closed = true; return m.closed && z; },
          help: function (api) { try { api.app.closeAll(); } catch (_) {} return api.sleep(300).then(function () { return api.swipe(topCard); }); } },
        { kind: 'demo', target: function (api) { var c = topCard(api); return c && c.querySelector('[data-collapse-toggle]'); },
          text: '<b>收起 / 展开</b>：卡片右上角这个小圆点。点一下，整叠卡片收成一个小条，不挡 PS；再点一下展开。<br>也可以在设置里给它设一个快捷键（默认没有）。',
          enter: function (api) { try { api.app.closeAll(); } catch (_) {} },
          demo: function (api) {
            var dot = function (a) { var c = topCard(a); return c && c.querySelector('[data-collapse-toggle]'); };
            return api.click(dot).then(function () { return api.sleep(1000); }).then(function () { return api.click(dot); });
          } },
        { kind: 'try', target: function (api) { var c = topCard(api); return c && c.querySelector('[data-collapse-toggle]'); },
          text: '你来：点小圆点<b>收起</b>，再点一下<b>展开</b>。', task: '先收起，再展开',
          check: function (api, m) { var p = api.peek(); if (p.collapsed) m.saw = true; return !!m.saw && !p.collapsed; },
          help: function (api) { var dot = function (a) { var c = topCard(a); return c && c.querySelector('[data-collapse-toggle]'); }; return api.click(dot).then(function () { return api.sleep(800); }).then(function () { return api.click(dot); }); } },
        { kind: 'try', target: function (api) { var c = topCard(api); return c && c.querySelector('[data-dragbar]'); },
          text: '<b>拖动</b>：按住卡片最上面那条<b>小横线</b>，拖到你顺手的位置（真软件里拖的是整个窗口）。', task: '按住小横线拖一下',
          check: function (api, m) { return api.since(m, 'drag') > 0 && api.since(m, 'dragMoved') > 20; },
          help: function (api) {
            var c = topCard(api), bar = c && c.querySelector('[data-dragbar]'), W = api.app;
            if (!bar) return;
            return api.hover(function () { return bar; }).then(function () {
              bar.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: W, button: 0, screenX: 600, screenY: 300 }));
              var i = 0;
              return new Promise(function (resolve) {
                (function step() {
                  i++;
                  W.document.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, view: W, screenX: 600 - i * 8, screenY: 300 + i * 3 }));
                  if (i < 10) return setTimeout(step, 40);
                  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, view: W, button: 0 }));
                  resolve();
                })();
              });
            });
          } }
      ]
    },
    // ───────────────────────────────────────────── 1 连上 PS
    {
      id: 'connect', no: 1, version: 1, title: '连上 Photoshop', summary: '装桥接插件 → 增效工具里打开 → 放好', needsPlugin: false,
      setup: function (api) { return api.navigate('settings', 0, { section: 'photoshop' }); },
      steps: [
        { kind: 'tell', target: lab(setsec('photoshop'), 'Photoshop 联动'), needs: needSettings('photoshop'),
          text: '修图轮椅要通过 PS 里的一个<b>桥接插件</b>跟 PS 说话：抓选区、贴回图层、图层联动全靠它。<br>第一次用要<b>装一次</b>：在设置卡<b>「Photoshop 联动」</b>里。装之前最好先保存并关掉 PS。' },
        { kind: 'demo', target: lab({ app: '#setsec-photoshop [data-action="install"]' }, '安装 / 修复桥接'), needs: needSettings('photoshop'),
          text: '点<b>「安装 / 修复桥接」</b>。Windows 会弹一个<b>「用户账户控制」</b>，问你允不允许修改设备 —— 点<b>「是」</b>（装插件要管理员权限，正常的）。',
          demo: function (api) { return api.until(function () { return api.q('#setsec-photoshop [data-action="install"]'); }, 4000).then(function () { return api.hover({ app: '#setsec-photoshop [data-action="install"]' }); }).then(function () { return api.sleep(1200); }); } },
        { kind: 'try', target: { app: '#setsec-photoshop [data-action="install"]' }, needs: needSettings('photoshop'),
          text: '你来：点<b>「安装 / 修复桥接」</b>，弹出来的框点<b>「是」</b>。', task: '点安装 → 弹框点「是」',
          check: function (api) { return api.plugin.installed; },
          help: function (api) { return api.click({ app: '#setsec-photoshop [data-action="install"]' }).then(function () { return api.until(function () { return api.uacOpen(); }, 3000); }).then(function () { return api.click({ ps: '#tutUacYes' }); }); } },
        { kind: 'demo', target: [lab({ ps: '#psPluginsMenuBtn' }, '增效工具')],
          text: '装好了。接下来回到 PS：顶上菜单<b>「增效工具」</b>→<b>「修图轮椅 V7 连接 PS 插件工具」</b>，插件面板就打开了。<br>然后按住面板的标题栏，把它<b>拖到 PS 随便哪个地方放着</b>（停到右边面板区最省地方）。看我做一遍：',
          demo: function (api) {
            return api.openMenu().then(function () { return api.sleep(500); })
              .then(function () { return api.click({ ps: '[data-ps="open-plugin"]' }); })
              .then(function () { return api.sleep(600); })
              .then(function () {
                var t = api.rect({ ps: '#psPluginTitle' }), p = api.rect({ ps: '#psPanels' });
                return api.dragScreen({ x: t.left + 40, y: t.top + 10 }, { x: p.left + p.width / 2, y: p.top + p.height * 0.6 }, document.getElementById('psPluginTitle'));
              }).then(function () { return api.sleep(900); })
              // 演示完收起来，让学员自己再做一遍
              .then(function () { api.plugin.open = false; api.plugin.placed = false; document.getElementById('psPlugin').hidden = true; });
          } },
        { kind: 'try', target: [lab({ ps: '#psPluginsMenuBtn' }, '增效工具')],
          text: '你来：<b>增效工具 → 修图轮椅 V7 连接 PS 插件工具</b>，再按住面板标题栏把它<b>拖到一边放好</b>。', task: '打开插件面板，拖到一边放好',
          enter: function (api) { api.plugin.open = false; api.plugin.placed = false; document.getElementById('psPlugin').hidden = true; },
          check: function (api) { return api.plugin.open && api.plugin.placed && api.pluginConnected(); },
          help: function (api) {
            return (api.plugin.open ? Promise.resolve() : api.openMenu().then(function () { return api.sleep(400); }).then(function () { return api.click({ ps: '[data-ps="open-plugin"]' }); }))
              .then(function () { return api.sleep(500); })
              .then(function () { var t = api.rect({ ps: '#psPluginTitle' }), p = api.rect({ ps: '#psPanels' }); return api.dragScreen({ x: t.left + 40, y: t.top + 10 }, { x: p.left + p.width / 2, y: p.top + p.height * 0.6 }, document.getElementById('psPluginTitle')); });
          } },
        { kind: 'tell', target: [lab({ ps: '#psPlugin' }, '绿点 = 连上了')],
          text: '插件面板上是<b>绿点「已连上修图轮椅」</b>就成了。以后开 PS 它会自己连。<br>这个面板<b>别关</b>：关了就断开了。断开的时候修图轮椅会冒一张报错卡告诉你。' }
      ]
    },
    // ───────────────────────────────────────────── 2 第一张图
    {
      id: 'first-image', no: 2, version: 2, title: '第一张图', summary: '框选 → 点部位挑预设 → 调参数 → ▶ 开始 → 设快捷键',
      setup: function (api) { api.ps.setSelection(null); return api.navigate('presets'); },
      steps: [
        { kind: 'demo', target: [lab({ ps: '[data-ps-tool="marquee"]' }, '矩形选框工具'), { ps: '#psCanvas' }],
          text: '第一步永远是<b>在 PS 里框选</b>要改的地方：用左边工具栏的<b>矩形选框工具</b> ⬚，在照片上按住拖。看我框一下脸：',
          demo: function (api) { return api.setTool('marquee').then(function () { return box(api, FACE); }); } },
        frameStep(FACE, '脸'),
        { kind: 'tell', target: [lab(card('presets'), '剪影预设卡'), lab({ app: '.ps-crumb' }, '全部预设'), lab({ app: '.ps-gear' }, '编辑剪影素材'), lab({ app: '.ps-crumb-qwen' }, '开源模型开关')],
          text: '第二步<b>挑预设</b>，在<b>剪影预设</b>卡：<br>· 中间的<b>人体是可以点的</b>：点脸、点头发、点衣服，右边列表就只剩那个部位的预设；<br>· <b>全部预设</b>：不分部位看全部；<br>· <b>⚙</b>：编辑剪影素材；<br>· 左上角<b>开源模型</b>开关后面单独讲。' },
        { kind: 'demo', target: card('presets'),
          text: '看我点一下人体的<b>脸</b>：右边列表就只剩「头部面部」的预设了。',
          demo: function (api) { return clickPart(api, 'head').then(function () { return api.sleep(1200); }); } },
        { kind: 'try', target: card('presets'), text: '你来：在人体上<b>点一个部位</b>（哪儿都行），看列表跟着变。', task: '点人体上的一个部位',
          enter: function (api, m) { m.before = selectedPart(api); try { api.app.PRESETUI.selectAsset(null); } catch (_) {} },
          check: function (api) { return !!selectedPart(api); },
          help: function (api) { return clickPart(api, 'head'); } },
        { kind: 'demo', target: lab({ app: '.pz-row[data-preset-id="' + PRESET_ID + '"]' }, '教程专用的修脸预设'),
          text: '这是教程专门准备的<b>「教程·修脸」</b>预设（在「头部面部」里，带 ★ 收藏所以排最上面）。点它，提示词面板就出来了。',
          enter: function (api) { return presetsReady(api).then(function () { if (!api.q('.pz-row[data-preset-id="' + PRESET_ID + '"]')) try { api.app.PRESETUI.selectAsset('head'); } catch (_) {} }); },
          demo: function (api) { return pickTutorialPreset(api).then(function () { return api.sleep(800); }); } },
        { kind: 'try', target: { app: '.pz-row[data-preset-id="' + PRESET_ID + '"]' }, text: '你来：点<b>「教程·修脸」</b>这一行。', task: '点「教程·修脸」',
          enter: function (api, m) { try { api.app.closeAll(); } catch (_) {} return presetsReady(api).then(function () { if (!api.q('.pz-row[data-preset-id="' + PRESET_ID + '"]')) try { api.app.PRESETUI.selectAsset('head'); } catch (_) {} }); },
          check: function (api) { return presetTitleNow(api) === PRESET_TITLE && !!runButton(api); },
          help: pickTutorialPreset },
        { kind: 'tell', needs: needPrompt, target: [lab(pd('.pd-hb-run'), '▶ 开始'), lab(pd('[data-act="save"]'), '另存为新预设'), lab(pd('[data-act="preactions"]'), '前置动作'), lab(pd('[data-act="clear"]'), '清空'), lab(pd('[data-act="toggle"]'), '滑块 / 原文')],
          text: '这就是<b>提示词面板</b>，上面一排按钮：<br>· <b>播放</b> 用现在的参数开始生成；<br>· <b>存</b> 另存为新预设（改好的参数存成你自己的）；<br>· <b>扳手</b> 前置动作（生成前先让 PS 做点什么）；<br>· <b>×</b> 清空并卸下这个预设；<br>· <b>滑块 / 原文</b> 切换：看滑块，还是看提示词原文。' },
        { kind: 'try', target: lab(pd('.pd-range'), '磨皮强度'), needs: needPrompt, text: '预设里带<b>滑块</b>：拖一拖<b>「磨皮强度」</b>，提示词里的数字跟着变。', task: '拖一下「磨皮强度」滑块',
          check: function (api) { var v = paramValue(api, '磨皮强度'); return v != null && Math.abs(v - 0.4) > 0.01; },
          help: function (api) { var el = pd('.pd-range')(api); if (!el) return; return api.hover(function () { return el; }).then(function () { el.value = '0.7'; el.dispatchEvent(new api.app.Event('input', { bubbles: true })); }); } },
        { kind: 'try', target: lab(pd('.pd-field-input'), '妆容'), needs: needPrompt, text: '还有<b>填空</b>：在<b>「妆容」</b>框里改成你想要的，比如「裸妆」。', task: '把「妆容」改一下',
          check: function (api) { var v = fieldValue(api, '妆容'); return v != null && v !== '淡妆'; },
          help: function (api) { var el = pd('.pd-field-input')(api); if (!el) return; return api.click(function () { return el; }).then(function () { el.value = '裸妆'; el.dispatchEvent(new api.app.Event('input', { bubbles: true })); }); } },
        { kind: 'try', target: lab(pd('.pd-hb-run'), '▶ 开始生成'), needs: needPrompt,
          text: '第三步<b>开始生成</b>：点 <b>▶</b>。下面会出一张<b>任务卡</b>，显示进度；出好了缩略图就亮起来。', task: '点 ▶ 开始生成',
          enter: function (api, m) { m.ids = ids(api); if (!api.ps.selection()) return box(api, FACE); },
          check: function (api, m) { var n = newTasks(api, m); return n.length > 0 && isDone(n[0]); },
          help: function (api) { return api.click(runButton); } },
        { kind: 'try', target: lab({ app: '#setsec-shortcuts [data-setting="generationShortcut"]' }, '开始计算快捷键'), needs: needSettings('shortcuts'),
          text: '每次都点 ▶ 太麻烦？给<b>开始生成</b>设一个<b>快捷键</b>（默认没有，设了才有）：点这个框，然后<b>按下你想要的组合键</b>，推荐 Ctrl + 2。<br>这是全局快捷键：焦点在 PS 里也能按。不想用了在框里按退格清掉。', task: '点框，按一个组合键（推荐 Ctrl + 2）',
          enter: function (api) { return api.navigate('settings', 0, { section: 'shortcuts' }); },
          check: function (api) { return !!api.settings().generationShortcut; },
          help: function (api) { return recordShortcut(api, 'generationShortcut', { key: '2', code: 'Digit2', ctrlKey: true }); } },
        { kind: 'try', target: { ps: '#psCanvas' }, guide: FACE, guideLabel: '再框一次脸',
          text: '用你刚设的快捷键再出一张：<b>框好脸 → 按快捷键</b>。', task: '框选，然后按你的快捷键',
          enter: function (api, m) { m.ids = ids(api); var el = document.querySelector('#tutTask'); var k = keyText(api.settings().generationShortcut); if (el && k) el.textContent = '框选，然后按 ' + k; return api.navigate('presets'); },
          check: function (api, m) { var n = newTasks(api, m); return api.since(m, 'key:generation') > 0 && n.length > 0; },
          help: function (api) { return api.setTool('marquee').then(function () { return box(api, FACE); }).then(function () { return api.shortcut('generation'); }); } }
      ]
    },
    // ───────────────────────────────────────────── 3 预设系统
    {
      id: 'presets', no: 3, version: 1, title: '预设系统', summary: '收藏、搜索、编辑、另存、工具箱和预设迁移',
      setup: function (api) { return presetsReady(api); },
      steps: [
        { kind: 'tell', target: [lab({ app: '#presetZone [data-act="search"]' }, '搜索'), lab({ app: '#presetZone [data-act="new"]' }, '新建'), lab({ app: '#presetZone [data-act="import"]' }, '导入'), lab({ app: '#presetZone [data-act="export"]' }, '导出'), lab({ app: '#presetZone .pz-list' }, '预设列表')],
          text: '<b>预设列表</b>上面一排：<b>搜索</b>（中文、拼音首字母都行）、<b>新建</b>、<b>导入 / 导出</b>（跟别人互换预设）。<br>每一行前面的 <b>☆</b> 是<b>收藏</b>：收藏的排最上面。按住一行上下拖能<b>排顺序</b>。' },
        { kind: 'try', target: lab({ app: '#presetZone .pz-list' }, '点 ☆ 收藏'), text: '你来：点某一行前面的 <b>☆</b>，<b>收藏</b>一个预设。', task: '收藏一个预设',
          enter: function (api, m) { m.n = api.app.PRESETS.presets().filter(function (p) { return p.starred; }).length; },
          check: function (api, m) { return api.app.PRESETS.presets().filter(function (p) { return p.starred; }).length > m.n; },
          help: function (api) { return api.click(function (a) { return a.qa('#presetZone .pz-star').find(function (s) { return !s.classList.contains('on'); }); }); } },
        { kind: 'try', target: { app: '#presetZone [data-act="search"]' }, text: '点<b>搜索</b>，输入「修脸」（或者拼音首字母「xl」）。', task: '搜「修脸」',
          check: function (api) { try { return /修脸|xl/i.test(String(api.app.PRESETUI.state.filter || '')); } catch (_) { return false; } },
          help: function (api) { return api.click({ app: '#presetZone [data-act="search"]' }).then(function () { return api.until(function () { return firstVisible(api, '#presetZone .pz-input'); }, 2000); }).then(function () { var el = firstVisible(api, '#presetZone .pz-input'); if (!el) return; el.value = '修脸'; el.dispatchEvent(new api.app.Event('input', { bubbles: true })); }); } },
        { kind: 'demo', target: lab(pd('textarea'), '提示词原文'), needs: needPrompt,
          text: '<b>预设编辑器</b>就是提示词面板本身：切到<b>原文</b>就能直接改字。<br>原文里有两种特殊写法：<br>· <b>"@param:名字": 0.4</b> → 显示成<b>滑块</b>（0 到 1）；<br>· <b>【填空:名字=默认值】</b> → 显示成<b>输入框</b>。<br>自己写预设时照这个写就有滑块和填空。',
          enter: function (api) { var inp = firstVisible(api, '#presetZone .pz-input'); if (inp) { inp.value = ''; inp.dispatchEvent(new api.app.Event('input', { bubbles: true })); } return presetTitleNow(api) === PRESET_TITLE && runButton(api) ? null : pickTutorialPreset(api); },
          demo: function (api) { return api.click(pd('[data-act="toggle"]')).then(function () { return api.sleep(2600); }).then(function () { return api.click(pd('[data-act="toggle"]')); }); } },
        { kind: 'try', target: lab(pd('[data-act="save"]'), '另存为新预设'), needs: needPrompt,
          text: '改好的参数想留着：点 <b>另存为新预设</b>，起个名字，选放到哪个部位，点确定。', task: '另存为一个新预设',
          enter: function (api, m) { m.n = api.app.PRESETS.presets().length; },
          check: function (api, m) { return api.app.PRESETS.presets().length > m.n; },
          help: function (api) {
            return api.click(pd('[data-act="save"]')).then(function () { return api.until(function () { return api.q('.ps-dlg-input[data-k="title"]'); }, 3000); })
              .then(function () { var el = api.q('.ps-dlg-input[data-k="title"]'); if (el) { el.value = '我的修脸'; el.dispatchEvent(new api.app.Event('input', { bubbles: true })); } return api.click({ app: '.ps-dlg-ok' }); });
          } },
        { kind: 'tell', target: [lab(card('presets'), '剪影上的工具箱'), lab({ app: '.ps-gear' }, '⚙ 编辑剪影素材')],
          text: '剪影上还有一个<b>工具箱</b>（那个箱子图标）：里面的<b>预设迁移</b>能把 V6 的老预设搬过来，可以用；<b>其他工具还在测试</b>，先别用。<br><b>⚙ 编辑剪影素材</b>：换人体图、调部位范围，会单独开一个编辑窗口。' }
      ]
    },
    // ───────────────────────────────────────────── 4 传回到 PS
    {
      id: 'return', no: 4, version: 2, title: '传回到 PS', summary: '传回、生成组在哪、自动传回',
      setup: function (api) { return api.navigate('generation').then(function () { return ensurePendingTask(api, 1); }); },
      steps: [
        { kind: 'demo', target: lab(function (api) { return api.q('#tasks .task [data-task-send]') || topTask(api); }, '传回'),
          text: '出好的图要<b>传回 PS</b> 才变成图层。任务卡上的<b>「传回 N」</b>就是把还没传的那几张贴进 PS。看我点：',
          demo: function (api, m) { return api.click(function (a) { return a.q('#tasks .task [data-task-send]'); }).then(function () { return api.until(function () { return api.since(m, 'layers') > 0; }, 8000); }).then(function () { return api.sleep(600); }); } },
        { kind: 'tell', target: [lab({ ps: '#psLayers .ps-layer[data-group]' }, '生成组'), lab(function (api) { var l = api.ps.active() && api.ps.active().layers[0]; var r = l && l.layers && l.layers[0] && l.layers[0].rect; return r ? api.docToScreen(r) : null; }, '贴回的位置')],
          text: '看左边 PS：<br>· 图层面板多了一个<b>生成组</b>（「轮椅-xxx 生成组」），一批一个组，里面是「生成结果 1、2……」；<br>· 图贴回到了你<b>当初框的位置</b>，边缘做了<b>羽化</b>，看不出接缝。<br>贴成智能对象还是普通图层、怎么编组、羽化多宽，都在设置卡「传回到 PS」「编组与联动」「边缘羽化」。' },
        { kind: 'try', target: lab({ ps: '#psLayers .ps-layer[data-group] .eye' }, '组前面的眼睛'),
          text: '你来：点生成组前面的<b>眼睛</b> 关掉，再点一下打开，对比一下修之前、修之后。', task: '点两下生成组的眼睛',
          check: function (api, m) { return api.since(m, 'eyeClick') >= 2; },
          help: function (api) { var e = { ps: '#psLayers .ps-layer[data-group] .eye' }; return api.click(e).then(function () { return api.sleep(700); }).then(function () { return api.click(e); }); } },
        { kind: 'try', target: lab(function (api) { var el = api.q(AUTO_RETURN); return el && el.closest('.tgl') || el; }, '自动传回'),
          text: '嫌每次都要点？打开生成卡上的<b>「自动传回」</b>：生成完自己贴回 PS。', task: '打开「自动传回」开关',
          enter: function (api) { return api.navigate('generation'); },
          check: function (api) { return api.settings().autoReturn === true; },
          help: function (api) { return api.click(function (a) { var el = a.q(AUTO_RETURN); return el && el.closest('.tgl') || el; }); } },
        frameStep(CLOTH, '衣服'),
        { kind: 'try', target: [lab(pd('.pd-hb-run'), '▶'), { ps: '#psLayers' }], needs: needPrompt,
          text: '现在点 <b>▶</b>（或者按你设的快捷键）生成，什么都不用点，看它<b>自己贴回 PS</b>。', task: '生成，看它自动贴回',
          enter: function (api) { return presetTitleNow(api) === PRESET_TITLE && runButton(api) ? null : pickTutorialPreset(api); },
          check: function (api, m) { return api.since(m, 'a:ps.layer.placeBatch') + api.since(m, 'a:ps.layer.place') > 0; },
          help: function (api) { return api.click(runButton); } }
      ]
    },
    // ───────────────────────────────────────────── 5 任务卡
    {
      id: 'task-card', no: 5, version: 2, title: '任务卡', summary: '右滑出缩略图、图层联动、眼睛 切校色、调强度、看大图、跳过去',
      setup: function (api) { return ensureReturnedTask(api); },
      steps: [
        { kind: 'demo', target: topTask, swipe: true,
          text: '在任务卡上<b>往右滑</b>，右边推出这一批的<b>缩略图</b>。看我滑：',
          enter: function (api) { api.leave(); },
          demo: function (api) { return api.swipe(topTask).then(function () { return api.until(function () { return previewOpen(api); }, 3000); }).then(function () { return api.sleep(800); }); } },
        { kind: 'try', target: topTask, swipe: true, text: '你来：鼠标先移开，再在任务卡上<b>往右滑</b>，把缩略图推出来。', task: '在任务卡上往右滑',
          enter: function (api, m) { api.leave(); m.closed = false; },
          check: function (api, m) { var o = previewOpen(api); if (!o) m.closed = true; return m.closed && o; },
          help: function (api) { api.leave(); return api.sleep(300).then(function () { return api.swipe(topTask); }); } },
        { kind: 'demo', target: [lab(preview, '缩略图'), lab({ ps: '#psLayers' }, 'PS 跟着切')],
          text: '<b>划到哪张，PS 里就只显示哪张</b>（图层联动）—— 不用去图层面板一个个点眼睛。看左边图层面板：',
          enter: function (api) { if (!previewOpen(api)) return api.swipe(topTask); },
          demo: function (api) { return api.hover(function (a) { return taskThumbAt(a, 1); }).then(function () { return api.sleep(900); }).then(function () { return api.hover(function (a) { return taskThumbAt(a, 0); }); }).then(function () { return api.sleep(900); }); } },
        { kind: 'try', target: [preview, { ps: '#psLayers' }], text: '你来：在缩略图之间<b>来回划</b>，看左边图层面板跟着切。', task: '在缩略图之间划一下',
          enter: function (api) { if (!previewOpen(api)) return api.swipe(topTask); },
          check: function (api, m) { return api.since(m, 'a:ps.group.soloOwned') > 0; },
          help: function (api) { return api.hover(function (a) { return taskThumbAt(a, 1); }).then(function () { return api.sleep(300); }).then(function () { return api.hover(function (a) { return taskThumbAt(a, 0); }); }); } },
        { kind: 'demo', target: [lab(function (api) { return api.q('#tasks .task [data-task-eye]'); }, '眼睛 校色版本'), lab(preview, '缩略图跟着变'), lab({ ps: '#psCanvas' }, 'PS 里也跟着变')],
          text: '任务卡上的<b>眼睛按钮</b>是<b>校色版本</b>：底版（没校色）→ 全局 → 精准 → 混合，点一下换一种。<br>右边缩略图和 PS 里已经贴回的图层<b>一起换颜色</b>，不用重新生成。',
          enter: function (api) { if (!previewOpen(api)) return api.swipe(topTask); },
          demo: function (api) { return api.click(function (a) { return a.q('#tasks .task [data-task-eye]'); }).then(function () { return api.sleep(1400); }); } },
        { kind: 'try', target: [function (api) { return api.q('#tasks .task [data-task-eye]'); }, preview, { ps: '#psCanvas' }],
          text: '你来：点两下眼睛按钮，<b>换两次</b>版本，同时看右边缩略图和左边 PS 的颜色变化。', task: '点两次眼睛按钮',
          check: function (api, m) {
            var t = api.tasks()[0], v = t && (t.version || t.colorVersion);
            m.seen = m.seen || []; if (v && m.seen[m.seen.length - 1] !== v) m.seen.push(v);
            return m.seen.length >= 3;
          },
          help: function (api) { var eye = function (a) { return a.q('#tasks .task [data-task-eye]'); }; return api.click(eye).then(function () { return api.sleep(900); }).then(function () { return api.click(eye); }); } },
        { kind: 'demo', target: lab(taskThumb, '在这张上滚滚轮'), swipe: true,
          text: '鼠标停在缩略图上<b>滚滚轮</b> = 调这张图的<b>强度</b>（在原图和生成结果之间过渡）。改太猛就往回滚一点，满意了点缩略图上的「应用」贴回 PS。',
          enter: function (api) { if (!previewOpen(api)) return api.swipe(topTask); },
          demo: function (api) { return api.wheel(taskThumb, 100, 3).then(function () { return api.sleep(1500); }); } },
        { kind: 'try', target: taskThumb, swipe: true, text: '你来：鼠标停在缩略图上，<b>滚几下滚轮</b>。', task: '在缩略图上滚滚轮',
          enter: function (api) { if (!previewOpen(api)) return api.swipe(topTask); },
          // ⚠ 过渡帧算过一次就走缓存、不再请求引擎（10-18 走查实测），所以「在缩略图上滚过」也算
          check: function (api, m) { return api.since(m, 'engine:/tween') > 0 || api.since(m, 'thumbWheel') >= 2; },
          help: function (api) { return api.wheel(taskThumb, -100, 3); } },
        { kind: 'try', target: taskThumb, swipe: true, text: '<b>单击</b>缩略图 = 打开<b>大预览框</b>，看清细节（里面也能滚轮调强度）。点开看看，看完把鼠标移开它就收起。', task: '单击缩略图，打开大预览框',
          enter: function (api) { if (!previewOpen(api)) return api.swipe(topTask); },
          // ⚠ 10-04 起单击不再开独立大图窗口，开的是卡片旁边的大预览框（V7Tween 那个框）
          check: function (api, m) { try { var b = api.app.V7Tween && api.app.V7Tween.boxState && api.app.V7Tween.boxState(); if (b && b.open) m.saw = true; } catch (_) {} return !!m.saw || api.since(m, 'viewer') > 0; },
          help: function (api) { return api.click(taskThumb).then(function () { return api.sleep(900); }); } },
        { kind: 'try', target: [taskThumb, { ps: '#psCanvas' }], swipe: true, text: '<b>双击</b>缩略图 = PS 里<b>跳到那张图的位置并放大</b>，方便细看。双击试试，看左边 PS。', task: '双击缩略图',
          enter: function (api) { api.zoomFit(); if (!previewOpen(api)) return api.swipe(topTask); },
          check: function (api, m) { return api.since(m, 'zoom') > 0; },
          help: function (api) { return api.dblclick(taskThumb); } },
        { kind: 'tell', target: [lab({ ps: '#psFit' }, '适合屏幕'), lab(function (api) { var t = topTask(api); return t && t.querySelector('[data-task-close]'); }, '✕ 收起任务卡')],
          text: '看完点 PS 的<b>「适合屏幕」</b>缩回来。<br>任务卡右上角的 <b>✕</b> 只是从这里收起，图还在「记录与恢复」里。',
          enter: function (api) { return api.sleep(300); } }
      ]
    },
    // ───────────────────────────────────────────── 6 参考图
    {
      id: 'references', no: 6, version: 2, title: '参考图', summary: '设快捷键加参考图、拖动排序、删除、清空',
      setup: function (api) { api.zoomFit(); return api.navigate('presets'); },
      steps: [
        { kind: 'tell', target: lab(function (api) { return REGION_BELOW(api); }, '参考图卡会出现在这里'),
          text: '想让 AI <b>照着某张图</b>改（比如照着这个发型），就加<b>参考图</b>：在 PS 里框出参考的那块，按<b>「加参考图」快捷键</b>，抓进来。生成时会一起带上。' },
        { kind: 'try', target: lab({ app: '#setsec-shortcuts [data-setting="referenceShortcut"]' }, '加参考图快捷键'), needs: needSettings('shortcuts'),
          text: '先给<b>加参考图</b>设个快捷键（默认没有）：点这个框，按一个组合键，推荐 Ctrl + 3。', task: '设「加参考图」快捷键',
          enter: function (api) { return api.navigate('settings', 0, { section: 'shortcuts' }); },
          check: function (api) { return !!api.settings().referenceShortcut; },
          help: function (api) { return recordShortcut(api, 'referenceShortcut', { key: '3', code: 'Digit3', ctrlKey: true }); } },
        { kind: 'demo', target: [{ ps: '#psCanvas' }, lab(function (api) { return REGION_BELOW(api); }, '参考图卡')],
          text: '看我加一张：框住<b>头发</b> → 按加参考图快捷键 → 主卡下面出现<b>参考图卡</b>。',
          enter: function (api) { return api.navigate('presets'); },
          demo: function (api) { return api.setTool('marquee').then(function () { return box(api, HAIR); }).then(function () { return api.shortcut('reference'); }).then(function () { return api.until(function () { return refThumbs(api).length > 0; }, 5000); }); } },
        { kind: 'try', target: [{ ps: '#psCanvas' }, { app: '.ref-card' }], guide: CLOTH, guideLabel: '框衣服当参考图',
          text: '你来：用矩形选框<b>框衣服</b>，按你的<b>加参考图</b>快捷键，再加一张。', task: '框衣服 → 按加参考图快捷键',
          enter: function (api, m) { m.n = refThumbs(api).length; var k = keyText(api.settings().referenceShortcut), el = document.querySelector('#tutTask'); if (el && k) el.textContent = '框衣服 → 按 ' + k; },
          check: function (api, m) { return refThumbs(api).length > m.n; },
          help: function (api) { return api.setTool('marquee').then(function () { return box(api, CLOTH); }).then(function () { return api.shortcut('reference'); }); } },
        { kind: 'demo', target: lab({ app: '.ref-card' }, '参考图卡'), swipe: true,
          text: '在参考图卡上<b>往右滑</b>推出管理区。<b>按住缩略图左右拖</b>能换顺序：排<b>第一张的最重要</b>（主图）。看我把第二张拖到前面：',
          demo: function (api) {
            return api.swipe({ app: '.ref-card' }).then(function () { return api.sleep(600); }).then(function () {
              var thumbs = api.qa('.ref-card [data-ref-view]'); if (thumbs.length < 2) return;
              var a = api.rect(function () { return thumbs[1]; }), b = api.rect(function () { return thumbs[0]; });
              if (!a || !b) return;
              return api.dragScreen({ x: a.left + a.width / 2, y: a.top + a.height / 2 }, { x: b.left + 4, y: b.top + b.height / 2 }, document.body).then(function () {
                // 演示的拖是画给你看的；真换顺序走参考图模块自己的「挪位置」（真软件里你按住拖就是这个效果）
                var kind = thumbs[1].dataset.refView, idx = Number(thumbs[1].dataset.refIndex);
                try { return api.app.V7PresetReferences.moveTo(kind, idx, 0); } catch (_) {}
              });
            }).then(function () { return api.sleep(800); });
          } },
        { kind: 'try', target: { app: '.ref-card' }, swipe: true, text: '你来：<b>按住一张缩略图拖</b>，换个顺序。', task: '拖动换一下参考图顺序',
          enter: function (api, m) { m.order = refOrder(api); },
          check: function (api, m) { var o = refOrder(api); return !!o && o !== m.order; },
          help: function (api) { var t = api.qa('.ref-card [data-ref-view]'); if (t.length < 2) return; try { return api.app.V7PresetReferences.moveTo(t[1].dataset.refView, Number(t[1].dataset.refIndex), 0); } catch (_) {} } },
        { kind: 'try', target: lab({ app: '.ref-card' }, '右上角的小叉'), text: '点某张参考图右上角的<b>小叉</b>，删掉它。', task: '删一张参考图',
          enter: function (api, m) { m.n = refThumbs(api).length; },
          check: function (api, m) { return refThumbs(api).length < m.n; },
          help: function (api) { return api.click(function (a) { return refThumbs(a)[0]; }); } },
        { kind: 'try', target: { app: '.ref-card' }, swipe: true, text: '最后：右滑出管理区，点<b>「清除所有参考图」</b>。', task: '清空参考图',
          check: function (api) { return refThumbs(api).length === 0; },
          help: function (api) {
            if (api.q('[data-ref-act="clear"]')) return api.click({ app: '[data-ref-act="clear"]' });
            return refThumbs(api).reduce(function (p) { return p.then(function () { return api.click(function (a) { return refThumbs(a)[0]; }); }); }, Promise.resolve());
          } }
      ]
    },
    // ───────────────────────────────────────────── 7 开源模型
    {
      id: 'open-model', no: 7, version: 2, title: '开源模型', summary: '免费限量的开源模型开关',
      setup: function (api) { return api.navigate('presets'); },
      steps: [
        { kind: 'demo', target: lab({ app: '.ps-crumb-qwen' }, '开源模型开关'),
          text: '剪影预设卡左上角这个<b>「开源模型」</b>开关：打开后出图走 <b>ComfyUI 工作流</b>，<b>不扣积分，只限量</b>（要登录）。<br>打开后预设列表换成开源模型专用的那一套。看我点开再关上：',
          demo: function (api) { return api.click({ app: '.ps-crumb-qwen' }).then(function () { return api.sleep(1400); }).then(function () { return api.click({ app: '.ps-crumb-qwen' }); }); } },
        { kind: 'try', target: { app: '.ps-crumb-qwen' }, text: '你来：<b>打开</b>开源模型。', task: '打开「开源模型」',
          check: function (api) { return api.settings().qwenMode === true; },
          help: function (api) { return api.click({ app: '.ps-crumb-qwen' }); } },
        { kind: 'try', target: [card('presets'), { ps: '#psCanvas' }],
          text: '用开源模型出一张：<b>框一块 → 在列表里挑一个预设 → 点 ▶</b>（或按快捷键）。<br>开源模型最高 2K，几张就排几次队，<b>出好一张回一张</b>。', task: '用开源模型生成一次',
          enter: function (api, m) { m.ids = ids(api); },
          check: function (api, m) { var n = newTasks(api, m); return n.length > 0 && isDone(n[0]); },
          help: function (api) {
            return api.setTool('marquee').then(function () { return box(api, FACE); }).then(function () { return api.until(function () { return api.q('.pz-row[data-preset-id]'); }, 4000); })
              .then(function () { return api.click({ app: '.pz-row[data-preset-id]' }); }).then(function () { return api.until(function () { return runButton(api); }, 4000); })
              .then(function () { return api.click(runButton); });
          } },
        { kind: 'try', target: { app: '.ps-crumb-qwen' }, text: '教程后面用回普通模式：把开源模型<b>关掉</b>。', task: '关掉「开源模型」',
          check: function (api) { return api.settings().qwenMode !== true; },
          help: function (api) { return api.click({ app: '.ps-crumb-qwen' }); } }
      ]
    },
    // ───────────────────────────────────────────── 8 外挂能力
    {
      id: 'engines', no: 8, version: 2, title: '外挂能力', summary: '云端开关和档位表（工具还在测试）',
      setup: function (api) { return api.navigate('engines'); },
      steps: [
        { kind: 'tell', target: [lab(card('engines'), '外挂能力卡'), lab(function (api) { return api.qa('.block-card[data-card="engines"] button, .block-card[data-card="engines"] span').find(function (el) { return /云端\s*·/.test(el.textContent || '') && el.offsetWidth; }); }, '云端开关')],
          text: '<b>外挂能力</b>卡管抠像、人体解析、校色、调强度这些要「算」的活：<br>· 左上角<b>「云端」</b>开着 = 在我们的云端显卡上算，你电脑不用装模型、不吃你的显卡；<br>· 表格是<b>每一档能干什么</b>：基础 / 拓展 / 高性能。<br>抠像、人体解析、指哪抠哪这几个工具<b>还在测试</b>，先别用；校色、调强度已经在你前面用过了。' }
      ]
    },
    // ───────────────────────────────────────────── 9 自由模式
    {
      id: 'free-mode', no: 9, version: 1, title: '自由模式', summary: '每张卡随便摆、卡组堆叠、一键收起',
      setup: function (api) { return api.navigate('settings', 0, { section: 'freemode' }); },
      steps: [
        { kind: 'tell', target: lab(setsec('freemode'), '自由摆放'), needs: needSettings('freemode'),
          text: '平时卡片是叠在一起的一叠。<b>自由模式</b>下：<b>每张主卡、整叠任务卡、整叠报错卡</b>都能单独拖到屏幕任何地方，二级、三级跟着它的主卡走。<br>大屏幕、双屏的时候特别好用。开关在设置卡<b>「自由摆放」</b>。' },
        { kind: 'try', target: lab(toggleOf('#setsec-freemode [data-setting="freeMode"]'), '自由摆放模式'), needs: needSettings('freemode'), text: '你来：打开<b>「自由摆放模式」</b>。', task: '打开自由摆放模式',
          check: function (api) { try { return api.app.V7FreeMode.isActive(); } catch (_) { return false; } },
          help: function (api) { return api.click(function (a) { var el = a.q('#setsec-freemode [data-setting="freeMode"]'); return el && el.closest('.tgl') || el; }); } },
        { kind: 'demo', target: lab(card('generation'), '按住小横线拖'),
          text: '现在每张卡都能单独拖：按住卡片顶上的<b>小横线</b>拖走。拖到另一张卡上会<b>堆成一组</b>（卡组），一组里滚轮还是能换卡。看我把生成卡拖开：',
          enter: function (api) { return api.sleep(800); },
          demo: function (api) {
            var bar = api.rect(function (a) { var c = a.q('.block-card[data-card="generation"]'); return c && c.querySelector('[data-dragbar]'); });
            if (!bar) return;
            return api.dragApp({ x: bar.left + bar.width / 2, y: bar.top + bar.height / 2 }, { x: bar.left + bar.width / 2 + 260, y: bar.top + bar.height / 2 + 60 });
          } },
        { kind: 'try', target: function (api) { return freeBar(api, 'generation') || freeBar(api); },
          text: '你来：按住某张卡的小横线，<b>拖到别的地方</b>。', task: '拖一张卡',
          enter: function (api, m) { m.pos = api.qa('.block-card').map(function (c) { var r = c.getBoundingClientRect(); return r.left + ',' + r.top; }).join('|'); },
          check: function (api, m) { var now = api.qa('.block-card').map(function (c) { var r = c.getBoundingClientRect(); return r.left + ',' + r.top; }); var old = m.pos.split('|'); return now.some(function (p, i) { var a = p.split(','), b = (old[i] || '0,0').split(','); return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 40; }); },
          help: function (api) { var bar = api.rect(function (a) { return freeBar(a, 'generation') || freeBar(a); }); if (!bar) return; return api.dragApp({ x: bar.left + bar.width / 2, y: bar.top + bar.height / 2 }, { x: bar.left + bar.width / 2 + 220, y: bar.top + bar.height / 2 + 140 }); } },
        { kind: 'try', target: lab({ app: '#setsec-shortcuts [data-setting="collapseShortcut"]' }, '一键收起 / 展开'), needs: needSettings('shortcuts'),
          text: '卡摆得满屏都是，修图时要一下子全收起来：给<b>「一键收起 / 展开」</b>设个快捷键（默认没有），比如 Ctrl + Alt + Enter。<br>自由模式下按它 = <b>所有卡组一起收起</b>，再按一次<b>一起展开</b>。', task: '设「一键收起 / 展开」快捷键',
          enter: function (api) { return api.navigate('settings', 0, { section: 'shortcuts' }); },
          check: function (api) { return !!api.settings().collapseShortcut; },
          help: function (api) { return recordShortcut(api, 'collapseShortcut', { key: 'Enter', ctrlKey: true, altKey: true }); } },
        { kind: 'try', target: null, text: '按你设的快捷键：先<b>全部收起</b>，再按一次<b>全部展开</b>。', task: '按两次一键收起快捷键',
          enter: function (api) { var k = keyText(api.settings().collapseShortcut), el = document.querySelector('#tutTask'); if (el && k) el.textContent = '按两次 ' + k; },
          check: function (api, m) { return api.since(m, 'key:collapse') >= 2; },
          help: function (api) { return api.shortcut('collapse').then(function () { return api.sleep(900); }).then(function () { return api.shortcut('collapse'); }); } },
        { kind: 'try', target: lab(toggleOf('#setsec-freemode [data-setting="freeMode"]'), '自由摆放模式'), needs: needSettings('freemode'), text: '教程后面用回普通模式：把<b>「自由摆放模式」</b>关掉。<br><small>万一卡拖丢了找不回来：按 Ctrl + Alt + Shift + F12 退出自由模式。</small>', task: '关掉自由摆放模式',
          enter: function (api) { return api.navigate('settings', 0, { section: 'freemode' }); },
          check: function (api) { try { return !api.app.V7FreeMode.isActive(); } catch (_) { return true; } },
          help: function (api) { return api.click(function (a) { var el = a.q('#setsec-freemode [data-setting="freeMode"]'); return el && el.closest('.tgl') || el; }); } }
      ]
    },
    // ───────────────────────────────────────────── 10 生成卡与设置
    {
      id: 'settings', no: 10, version: 2, title: '生成卡与设置', summary: '生成卡上的参数；设置卡最常用的那些',
      setup: function (api) { return api.navigate('generation'); },
      steps: [
        { kind: 'tell', target: [lab(card('generation'), '生成卡')],
          text: '<b>生成卡</b>正面是这次生成的参数：<b>模型、分辨率、宽高比、张数</b>；<b>抗截断</b>（防止 AI 乱裁）；<b>抓取分辨率</b>（发给 AI 的图多大）；<b>校色方式</b>；<b>自动传回</b>；<b>用整张图</b>（不框选也能生成）。' },
        { kind: 'try', target: { app: '.block-card[data-card="generation"] [data-ai-field="batch"]' }, text: '你来：把<b>张数</b>调到 <b>2</b>（一次出两张挑着用）。', task: '张数调到 2',
          check: function (api) { return api.peek().batch === 2; },
          help: function (api) { setBatch(api, 2); } },
        { kind: 'tell', target: [lab(setsec('provider'), '用哪家生图'), lab(setsec('imagecompute'), '出图花谁的钱')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'provider' }); }, needs: needSettings('provider'),
          text: '<b>设置卡</b>是一列到底的，右边目录点哪滚到哪。先看最要紧的两节：<br>· <b>用哪家生图</b>：选服务商、填地址和 Key，点「检查连接」；<br>· <b>出图花谁的钱</b>：用你自己的 Key，还是用平台积分。' },
        { kind: 'tell', target: [lab(setsec('align'), '对齐与校色'), lab(setsec('output'), '抓图与出图')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'align' }); }, needs: needSettings('align'),
          text: '· <b>对齐与校色</b>：生成的图怎么对齐原图、颜色怎么跟原图一致（默认「不校色」，出图后在任务卡上点眼睛按钮也能换着看）；<br>· <b>抓图与出图</b>：发给 AI 的图多大、AI 出的图多大。' },
        { kind: 'tell', target: [lab(setsec('return'), '传回到 PS'), lab(setsec('group'), '编组与联动'), lab(setsec('feather'), '边缘羽化')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'return' }); }, needs: needSettings('return'),
          text: '· <b>传回到 PS</b>：要不要自动贴回、贴成智能对象还是普通图层；<br>· <b>编组与联动</b>：传回的图怎么编组；划缩略图时 PS 怎么跟着切；<br>· <b>边缘羽化</b>：贴回的图边缘多柔，看不出接缝。' },
        { kind: 'tell', target: [lab(setsec('sound'), '完成音效'), lab(setsec('theme'), '配色'), lab(setsec('display'), '透明与毛玻璃')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'sound' }); }, needs: needSettings('sound'),
          text: '· <b>完成音效</b>：生成完响一声；<br>· <b>配色、透明与毛玻璃</b>：卡片什么颜色、透不透明、背景虚化多少。' },
        { kind: 'tell', target: [lab(setsec('interaction'), '滚轮与预览'), lab(setsec('shortcuts'), '快捷键')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'interaction' }); }, needs: needSettings('interaction'),
          text: '· <b>滚轮与预览</b>：滚多少格换卡；鼠标停在缩略图上要不要弹大图；<br>· <b>快捷键</b>：开始生成、加参考图、一键收起展开（默认都没有，设了才有，退格清除）。' },
        { kind: 'tell', target: [lab(setsec('checkpoint'), '检查点'), lab(setsec('cache'), '缓存'), lab(setsec('backup'), '账号云备份')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'checkpoint' }); }, needs: needSettings('checkpoint'),
          text: '· <b>检查点</b>：每次生成前先存一份完整画布，PS 崩了、改坏了能找回；<br>· <b>缓存</b>：生成的图存在哪、最多占多大；<br>· <b>账号云备份</b>：把设置和预设备份到云端，换电脑一键恢复。' },
        { kind: 'tell', target: [lab(setsec('photoshop'), 'Photoshop 联动'), lab(setsec('about'), '关于软件')],
          enter: function (api) { return api.navigate('settings', 0, { section: 'about' }); }, needs: needSettings('about'),
          text: '· <b>Photoshop 联动</b>：装插件、修插件（第 1 章讲过）；<br>· <b>关于软件</b>：版本号、插件和后台的状态；报问题时点<b>「复制诊断信息」</b>发给客服；<b>「重新看教程」</b>也在这里。' }
      ]
    },
    // ───────────────────────────────────────────── 11 记录与恢复
    {
      id: 'history', no: 11, version: 2, title: '记录与恢复', summary: '滚动攒光',
      setup: function (api) { return api.navigate('history'); },
      steps: [
        { kind: 'tell', target: lab(card('history'), '记录与恢复'),
          text: '<b>记录与恢复</b>：每一次生成都记在这里，任务卡关了、软件重开了，图都还在，能「恢复到任务栏」接着用。<br>这张卡（还有预设列表）里滚轮<b>先滚它自己的列表</b>，不会一碰就换卡 —— 这就是<b>「攒光」</b>。' },
        { kind: 'demo', target: card('history'),
          text: '<b>慢慢滚</b>：只是在翻这张卡自己的内容，卡不会换。看：',
          demo: function (api) { return api.wheel(card('history'), 100, 6, 160).then(function () { return api.sleep(600); }); } },
        { kind: 'demo', target: card('history'),
          text: '<b>快速连着滚</b>：卡片边缘的光一格一格<b>攒起来</b>，攒满了才翻到下一张卡；往回滚一下，光就清零。看：',
          demo: function (api) { return api.wheel(card('history'), 100, 14, 25).then(function () { return api.sleep(800); }).then(function () { return api.navigate('history'); }); } },
        { kind: 'try', target: card('history'), text: '你来：在这张卡上<b>快速连着滚</b>，把光攒满，翻到下一张卡。', task: '快速连续滚，把卡翻走',
          enter: function (api) { return api.navigate('history'); },
          check: function (api) { return api.peek().card !== 'history'; },
          help: function (api) { return api.wheel(card('history'), 100, 14, 25); } }
      ]
    },
    // ───────────────────────────────────────────── 12 快捷键和截图参考图（2026-10-24 新加，用户定）
    //   老用户升级后【只弹这一章】（tutorial-launcher.js：按 id + version 判，没看过的才弹）。
    //   推荐的一套快捷键是用户定的：Ctrl+2 开始计算 / Ctrl+3 加参考图 / Ctrl+4 一键收起 / Ctrl+5 换渠道（PS 里观察通道那几个键基本没人用）。
    //   ⚠ 软件第一次打开时快捷键仍然【全空】（用户定）—— 这里只是推荐 + 一键填入，不替用户默认设好。
    {
      id: 'shortcuts-snip', no: 12, version: 1, title: '快捷键和截图参考图', summary: '一键填入推荐快捷键；不在 PS 里也能截图当参考图', needsPlugin: false,
      steps: [
        { kind: 'tell', target: null,
          text: '新版本加了两样东西，花一分钟看一下：<br>① 一套<b>推荐快捷键</b>（默认还是没有，你点一下就填上）；<br>② <b>截图当参考图</b>：在浏览器、微信这些别的软件里看到好图，按快捷键直接截下来当参考图。' },
        { kind: 'try', target: lab({ app: '#setsec-shortcuts' }, '快捷键'), needs: needSettings('shortcuts'),
          text: '推荐这一套（PS 里这几个键原来是看单个通道的，基本没人用）：<br><b>Ctrl + 2</b> 开始计算 · <b>Ctrl + 3</b> 加参考图 · <b>Ctrl + 4</b> 一键收起 / 展开 · <b>Ctrl + 5</b> 换下一家渠道<br>自己在框里按一遍，或者点「帮我做一下」一次填好。⚠ 这是全局快捷键：轮椅开着时，别的软件里这几个组合键也会被它接走（比如浏览器的 Ctrl + 2 切标签页），不想要就在框里按退格清掉。',
          task: '四个快捷键都设上（照推荐的，或者你自己的）',
          check: function (api) { var s = api.settings(); return !!(s.generationShortcut && s.referenceShortcut && s.collapseShortcut && s.providerShortcut); },
          help: function (api) {
            var keys = [['generationShortcut', '2'], ['referenceShortcut', '3'], ['collapseShortcut', '4'], ['providerShortcut', '5']];
            return keys.reduce(function (p, k) { return p.then(function () { return recordShortcut(api, k[0], { key: k[1], code: 'Digit' + k[1], ctrlKey: true }); }); }, Promise.resolve());
          } },
        { kind: 'tell', target: lab({ app: '#setsec-shortcuts [data-setting="referenceShortcut"]' }, '加参考图快捷键'),
          text: '<b>加参考图</b>的快捷键现在会<b>看你在用哪个软件</b>：<br>· <b>Photoshop 在前面</b>：跟原来一样，抓 PS 里<b>框选的那块</b>；<br>· <b>别的软件在前面</b>（浏览器、微信、看图软件）：屏幕变暗 → <b>拖一个框</b> → 点「确认」就加进参考图，框歪了点「重截」，不要了按 Esc。<br>截图的时候轮椅会先藏起来，不会截到它自己。' },
        { kind: 'tell', target: null,
          text: '找不到参考图在哪？参考图卡<b>加了参考图才出现</b>，在主卡下面那一片。没加过的时候是看不到的，这是正常的。' }
      ]
    },
    // ───────────────────────────────────────────── 13 分割、眼神调整、补正方形（2026-10-25 新加，用户定）
    //   老用户升级后只弹这一章（tutorial-launcher.js：按 id + version 判，没看过的才弹）。只讲在哪、干什么，不让学员真点 ——
    //   分割要一单真生成过的图、眼神调整要真人脸，教程的假 PS 给不了，硬做「你来试试」会卡住。
    {
      id: 'features-1025', no: 13, version: 1, title: '分割、眼神调整、补正方形', summary: '只抠新加的东西带蒙版传回；改眼神；带参考图自动补正方形',
      setup: function (api) { return ensureReturnedTask(api); },
      steps: [
        { kind: 'tell', target: null,
          text: '新版本加了三样东西，花一分钟看一下：<br>① 任务卡上的<b>「分割」</b>：只把 AI <b>新加的东西</b>抠出来，带蒙版传回；<br>② 工具箱里的<b>「眼神调整」</b>：改眼睛看的方向、眼珠和瞳孔大小；<br>③ 带参考图生成时，图 1 和参考图<b>自动补成正方形</b>。' },
        { kind: 'tell', target: lab(function (api) { return api.q('#tasks .task [data-task-segment]') || topTask(api); }, '分割'),
          text: '<b>分割</b>在任务卡「传回」的右边，这一单有出好的图就一直在。<br>点开后在大预览框的位置出一个分割框：<b>拖滑块时看黑白蒙版</b>（白 = 留下），<b>松手看贴回去的样子</b>。<br>五个调节：<b>差值灵敏度</b>（新东西选不全就往右）、<b>去碎点</b>、<b>保持连续</b>（只留最大那块）、<b>平滑</b>、<b>模糊</b>。<br>点<b>「回传」</b>：图层照常贴回，外加一个蒙版，蒙版就是你调出来的区域；这一张不再加边缘羽化。这张已经传回过的话，就给 PS 里那个图层换上这个蒙版，不会多贴一层。' },
        { kind: 'tell', target: lab(card('presets'), '剪影上的工具箱 → 眼神调整'),
          text: '<b>眼神调整</b>在剪影上的<b>工具箱</b>里（箱子图标），全程本机计算、不花积分。<br>用法：在 PS 里<b>框选包住整张脸</b> → 点右上角<b>「抓取选区」</b> → 拖滑块改方向（在图上按住拖一个点，两只眼就看过去）、眼珠大小、瞳孔大小、眼白亮度 → <b>「传回 PS」</b>：多一个「眼神调整」图层，只盖住两只眼。<br>自动认错眼珠时点<b>「调眼珠圈」</b>拖到眼珠上，再点<b>「按圈重做」</b>；眼睛太小就把<b>处理倍率</b>调到 2x。' },
        { kind: 'tell', target: lab({ app: '#setsec-output' }, '设置 → 抓图与出图'), needs: needSettings('output'),
          text: '<b>带参考图时自动补成正方形</b>（默认开着）：这次带了参考图，图 1 和每张参考图不是正方形的就补成正方形再发，比例按 1:1 发；AI 出的图会<b>裁回你框的大小</b>再贴回，位置不会错。<br>不带参考图时跟原来一样。不想要就在这里关掉。' }
      ]
    },
    // ───────────────────────────────────────────── 14 收尾
    {
      id: 'finish', no: 14, version: 2, title: '收尾', summary: '接下来做什么、在哪重看教程', needsPlugin: false,
      steps: [
        { kind: 'tell', target: null,
          text: '教程到这里就走完了<br>接下来：<br>① <b>连上真的 Photoshop</b>：设置卡「Photoshop 联动」里装插件，再在 PS 的增效工具里打开面板；<br>② <b>选出图方式</b>：开源模型 / 平台积分 / 你自己的 Key；<br>③ 想再看教程：<b>设置 → 关于软件 → 重新看教程</b>，可以挑章节。' }
      ]
    }
  ];

  root.V7Tutorial = { chapters: chapters };
})(window);
