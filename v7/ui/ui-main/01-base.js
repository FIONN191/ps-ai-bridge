// ═══ ui-main/01-base.js —— 主界面主程序第 1 / 21 段 ═══
//   管什么：基础：全局输入锁 · 悬停浮层判据 · 拖面板 · 卡片背景 / 主题管理 · 背景槽位
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// 所有独立工作面共用这一份输入锁。原先点击、滚轮、埋卡跳转和面板外关闭各自维护名单，
// 新工具只要漏掉其中一处就会把事件送到底层 Photoshop。原生 dialog 以及带 data-ui-overlay
// 的工作面由结构登记，旧版非 dialog 工作面保留兼容选择器。
function v7OverlayOpen(){
  if(window.V7FocusScope) return V7FocusScope.isOpen();
  return !!document.querySelector('dialog[open],[data-ui-overlay],.v7-manual-overlay,.dlss-backdrop,.canvas-workbench,.region-workbench,.camera-light[open],.creative-tools[open],.ps-dlg-ov');
}
// ⭐⭐ 2026-10-06 晚：悬停手势（任务预览 / 二级右滑）专用的浮层判据。
//   v7OverlayOpen() 会把 V7FocusScope 里的【决定卡】也算成浮层 —— 但决定卡只该拦
//   点击 / 键盘 / 滚轮（focus-scope 已在捕获阶段拦掉了），不该把【纯查看】的悬停
//   导航也冻住。用户实测："弹了个报错卡出来，然后右滑就不正常了"（卡是 L3 决定卡）。
//   ⇒ 这里只认真正的浮层工作面；报错决定卡不算。点击/键盘/滚轮该拦的照样拦。
function v7HoverOverlayOpen(){
  return !!document.querySelector('dialog[open]:not([data-ui-overlay="false"]),[data-ui-overlay],.v7-manual-overlay,.dlss-backdrop,.canvas-workbench,.region-workbench,.camera-light[open],.creative-tools[open],.ps-dlg-ov');
}
// ── 桌面壳: 按住任意主卡顶部的横条拖整个面板(主进程高频跟随, V7 同款) ──
if (window.uiwin) {
  let dragging=false;
  document.querySelectorAll('[data-dragbar]').forEach(bar=>{
    bar.addEventListener('mousedown', e=>{
      if(window.V7FreeMode?.isActive())return;
      if(e.target.closest('[data-collapse-toggle]')) return;
      e.preventDefault(); e.stopPropagation();
      dragging=true;
      window.uiwin.dragStart();
    });
  });
  // 折叠态没有独立拖拽 bar：整张小灵动岛都是拖拽区域，圆点按钮除外。
  document.querySelectorAll('.block-card').forEach(card=>{
    card.addEventListener('mousedown', e=>{
      if(!isCollapsed || card!==cards[cur] || e.button!==0) return;
      if(e.target.closest('[data-collapse-toggle]')) return;
      e.preventDefault(); e.stopPropagation();
      dragging=true;
      card.classList.add('is-dragging');
      window.uiwin.dragStart();
    });
  });
  window.addEventListener('mouseup', ()=>{
    if(dragging){
      dragging=false;
      document.querySelectorAll('.block-card.is-dragging').forEach(card=>card.classList.remove('is-dragging'));
      window.uiwin.dragEnd();
      // ⚠ 窗口移动后, 重新计算报错堆和任务堆位置(否则它们会"往下飘")
      updateStackPositions();
    }
  });
  window.addEventListener('blur', ()=>{
    if(dragging){
      dragging=false;
      document.querySelectorAll('.block-card.is-dragging').forEach(card=>card.classList.remove('is-dragging'));
      window.uiwin.dragEnd();
      updateStackPositions();
    }
  });

  // ── 点击穿透: 鼠标不在 UI 上 → 窗口让位给下层(PS 等) ──
  // ⚠⚠ 2026-10-03 抢焦点根治（docs/127）：这里【不再自己记账】。
  //
  //   以前这里有一本账（ignored / ignorePending / ignoreRequestSeq），只做"状态没变就
  //   直接 return"。但外壳还有别的路会改穿透状态（自由模式看门狗、幕布全屏、设置窗口），
  //   那些路改完这本账不知道 → 账跟原生对不上 → `if (ignored === on) return` 静默返回
  //   → 指令永远发不出去 → 窗口一直吃点击，直到鼠标移进卡片再移出来才逼出一条新指令。
  //   这就是用户报的「软件老抢下面窗口的点击」。
  //
  //   现在：**去重的唯一权威在 Rust**（`ignore_state.rs`）。这里只做两件事——
  //   ① 把"我期望的状态"老实发过去；② 挡住不该发的场合（弹窗开着 / 正在拖拽）。
  //   调原生 API 的频率不变（去重挪到 Rust 了）。
  const interactiveOnly = window.WHEELCHAIR_CONTEXT?.interactiveOnly === true;
  function setIgnore(on){
    // Native desktop validation needs reliable mouse input even when the
    // transparent window is positioned above another application.
    if (interactiveOnly) on = false;
    if (window.V7Setup?.isOpen()) return;
    if (dragging || window.V7FreeMode?.isDragging() || window.V7FloatingBars?.isDragging()) return;
    // ⭐⭐⭐ 2026-10-06【硬不变式：预览框开着时，窗口一律不切穿透】
    //
    //   为什么必须是一条不变式，而不是"把缺的矩形补上"：
    //   穿透状态是靠【矩形登记表】(overUI) 算出来的，而这张表【天然会漏】——
    //   只要以后有人加一个新浮层忘了登记，就又是一次「弹出即闪回」，
    //   而且症状一模一样地难查（这次就查了一下午）。
    //
    //   机制（实测确认）：一旦切了穿透 → WebView 当场收不到鼠标 →
    //   浏览器【合成一条 documentElement.mouseleave】→
    //   tween-preview.js 的 pointerAway=true → hideBox() 当场把框收掉。
    //   也就是说：【我们自己的穿透切换，会伪装成"用户把鼠标移走了"】。
    //
    //   ⇒ 预览框是【要人操作的 UI】（缩略图能点、滑条能拖、滚轮调强度），
    //     它开着的时候窗口本来就必须收鼠标。所以：
    //     **框开着 = 不收穿透**。这不是补丁，是把语义写对。
    //     用户真移开时，预览链自己会在 160ms 内收掉（leaveTaskCard），
    //     收掉之后下一次 mousemove 自然恢复穿透 —— 不会卡住穿透。
    //   ⚠ 顺带挡住 another：自由模式的看门狗 / 幕布全屏那些路也会改穿透，
    //     它们不走这里 —— 但那时框本来也不该开着，hideBox 会先一步收掉。
    if (on && window.V7Tween && typeof V7Tween.isShowing === 'function' && V7Tween.isShowing()) on = false;
    // 期望值直接交给适配层 → Rust 命令（`ignore_set`）。去重与串行化都不在这里。
    Promise.resolve(window.uiwin.setIgnoreMouse(on)).catch(() => {});
  }
  // 判断鼠标是不是在"实体 UI"上 —— 决定穿不穿透窗口
  // ⚠ 不能用 elementFromPoint: 它只认最顶层元素。以后加提示气泡/下拉菜单/右键菜单,
  //   鼠标一旦移到浮层上就被判定成"不在UI", 窗口立刻穿透 + 收面板(埋雷)。
  //   这里只做几何矩形判断: 主卡堆 / 分区 / 详情 / 任务卡 / 预览 / 大图遮罩,
  //   任一矩形命中就算在 UI 上。与滚轮的 hitRect 逻辑一致。
  function overUI(x, y){
    // ⚠ 弹窗锁定时: 锁定遮罩(fixed inset:0)接收点击, 不穿透 —— 否则弹窗按钮点不到
    const popupLock = document.getElementById('popupLock');
    if(popupLock && popupLock.classList.contains('on')) return true;
    // ⚠⚠ 预设系统自己画的小对话框(.ps-dlg-ov: fixed 铺满窗口, Portal 到 body)。
    //   它居中在窗口中间, 不在卡片/分区/详情任何一个矩形里 —— 不登记的话这里一律判"空白"
    //   → 开穿透 → 对话框上的按钮全点不到, Esc 也没人收(2026-09-11 用户实测: 点按全穿透、退不出)。
    //   【规矩】凡是新加的全窗口浮层, 必须来这里登记。docs/12 §6.4 早写了, 这次又栽了一遍。
    if (v7OverlayOpen()) return true;
    // ⚠⚠ 2026-10-07 补登记：性能监视面板（调试卡 → 性能监视）。
    //   它是 position:fixed 挂在 body 下的独立浮层，不在任何卡片矩形里 ——
    //   不登记的话这里一律判"空白" → 开穿透 → 面板上的按钮和 × 全点不到，
    //   用户原话："点了就卡那了，不可关闭、不可移动"。
    //   ⚠ 就是这条规矩第三次被漏掉（前两次见上面 .ps-dlg-ov 和 docs/12 §6.4）：
    //     【凡是新加的全窗口浮层，必须来这里登记】。
    //   ⚠ 用查询而不是缓存元素：这个面板是开了才建、关了就没的（不像卡片是常驻的）。
    //   ⚠ 必须加 [hidden] 排除：面板收起时还留在 DOM 里，那时候不该继续吃点击。
    const perfPanel=document.querySelector('.perf-panel:not([hidden])');
    if (perfPanel && hitRect(x, y, perfPanel, 0, PAD_Y)) return true;
    if (window.V7Setup?.isOpen()) return true;
    // ⭐ 2026-10-19（docs/251 第 7 条④）：任务卡小眼睛的版本菜单（挂在 body 上的浮层）
    if (typeof colorMenuHit === 'function' && colorMenuHit(x, y)) return true;
    // ⭐ 2026-10-19（docs/250 第 17 条）：自由摆放收成小方块时，只有方块（和要用户做决定的报错卡）接鼠标 ——
    //   浮动条、导航、日程角标都藏起来了，下面那几条照旧判的话会在它们原来的位置挡住 Photoshop
    if(window.V7FreeMode?.isCompact?.()){
      if((window.UISelect&&UISelect.isOpen())||viewerOpen) return true;
      return window.V7FreeMode.hitTest(x,y);
    }
    if(window.V7FloatingBars?.hitTest(x,y))return true;
    const primaryNav=document.getElementById('v7PrimaryNav');
    if(primaryNav&&hitRect(x,y,primaryNav))return true;
    const plannerBadge=document.querySelector('.planner-attention:not([hidden])');
    if(plannerBadge&&hitRect(x,y,plannerBadge)) return true;
    // 标准下拉框的选项面板(Portal 到 body 的 fixed 层), 同理必须登记
    if (window.UISelect && UISelect.isOpen()) return true;
    if (viewerOpen) return true;
    if(window.V7FreeMode?.isActive())return window.V7FreeMode.hitTest(x,y);
    if(isCollapsed){
      // 折叠态的实际交互体是当前主卡小岛，不是隐藏的旧 collapsePill。
      const island=cards && cards[cur];
      return !!(island && hitRect(x, y, island, 0, PAD_Y));
    }
    // 大图开着时整个主窗口都被它的 modal 冻住, 不该再判断穿透 —— 一律当作"在 UI 上",
    // 免得中途误开穿透把点击漏给下层的 Photoshop。
    if (viewerOpen) return true;
    const c = cards[cur];
    if (c && hitRect(x, y, c, 0, PAD_Y)) return true;
    // 叠压的卡片往下露出边: 主卡堆矩形向下延伸 (N-1)*STEP 才盖得住所有露出的边
    const st = stack.getBoundingClientRect();
    if (x >= st.left && x <= st.right && y >= st.top - PAD_Y && y <= st.bottom + stackVisibleDepth(layoutVisibleIndices().length)*STEP + PAD_Y) return true;
    if (zones.classList.contains('show') && hitRect(x, y, zones, 0, PAD_Y)) return true;
    if (detail.classList.contains('show') && hitRect(x, y, detail, 0, PAD_Y)) return true;
    // ⚠ 报错堆的报错卡和详情层都接受点击, 不能穿透
    //   容器 #errors 只包含 absolute 子元素, 自身高度塌陷 = 0, hitRect 判不中 → 必须遍历每张卡
    const errEl=document.getElementById('errors');
    if (errEl && errEl.children.length && !window.V7WorkspaceStackRail?.isHidden('errors')) {
      for(let i=0; i<errEl.children.length; i++){
        const child = errEl.children[i];
        // 报错卡本身
        if(child.classList.contains('error-card') && hitRect(x, y, child, 0, PAD_Y)) return true;
        // 报错详情层 —— ⚠ 必须带 .show, 理由同下面的任务预览
        if(child.classList.contains('error-detail') && child.classList.contains('show') && hitRect(x, y, child, 0, PAD_Y)) return true;
      }
    }
    // ⭐⭐⭐ 2026-10-14【参考图卡「按钮点不动 / 浮层自己收掉」的根因，实测确认】——
    //   ⚠⚠ 这条规矩已经被漏掉【第四次】了（前三次：.ps-dlg-ov / 性能面板 / docs/12 §6.4）：
    //      【凡是新加的全窗口浮层，必须来 overUI 登记】。
    //   漏掉的后果，跟 2026-10-06 那次"右滑弹出即闪回"是同一个病：
    //     鼠标一到参考图卡上 → 这里一律判"空白" → 开【点击穿透】
    //     → WebView 当场收不到鼠标 → 浏览器合成 documentElement.mouseleave
    //     → 浮层被收掉。用户看到的就是"按钮点不动、菜单收不回去"。
    //   ⚠ 为什么上面那个循环接不住它：那个循环只认 .error-card / .error-detail，
    //     而参考图卡虽然也挂在 #errors 里，类名是 .refs（它不是一张报错卡，见 reference-card.js 文件头）。
    //   ⚠ 为什么用 :not([hidden]) 而不是无条件登记：没参考图时整张卡是可交互的占位，
    //     它盖住的那块地方【必须】能穿透下去给 Photoshop 点，否则等于凭空造了一块死区。
    //   ⚠ 为什么面板要在卡矩形【之外】单独判：二级菜单 .ref-panel 是 left:340px，
    //     在卡右缘之外 —— 跟任务卡那条 40px 的缝是同一个坑，只判卡身接不住。
    const refHost = document.getElementById('refs');
    if (refHost && !refHost.hidden && !window.V7WorkspaceStackRail?.isHidden('errors')) {
      const refCardEl = refHost.querySelector('.ref-card');
      if (refCardEl && hitRect(x, y, refCardEl, 0, PAD_Y)) return true;
      // ⚠ 必须带 .show：.ref-panel 隐藏时是 opacity:0 + pointer-events:none，
      //   但它【仍然占着真实矩形】。不带 .show 的话那条永不消失的矩形会一直吃点击
      //   （跟 .task-preview 踩过的坑一模一样，见下面那段注释）。
      const refPanelEl = refHost.querySelector('.ref-panel.show');
      if (refPanelEl && hitRect(x, y, refPanelEl, 0, PAD_Y)) return true;
      // ⚠ 2026-10-14 补：缩略图右上角那个删除小叉（.rc-del）。
      //   它的定位是 top/right:-6px（故意探到缩略图外面一点），是全卡最小的点击目标
      //   （18×18）。实测算下来它离卡片边缘还有 9px、本来就在 .ref-card 的矩形里，
      //   所以这条【目前是保险】而不是修 bug —— 但小叉将来要是往外挪一点就会踩坑，
      //   而"点不准 = 用户点半天没反应"是这类小按钮最常见的坏法。
      //   ⚠ 用 querySelectorAll 全量判而不是只判第一张：5 张图就有 5 个小叉。
      const refDels = refHost.querySelectorAll('.rc-del');
      for (let i = 0; i < refDels.length; i++) {
        if (hitRect(x, y, refDels[i], 0, PAD_Y)) return true;
      }
      // ④ 卡 ↔ 二级菜单之间那条缝：卡右缘 360 → 菜单左缘 400，中间 40px 两块矩形都不认。
      //   鼠标从卡上往右推动必穿这条缝 —— 判成"空白"就当场开穿透、菜单被收掉，
      //   用户的主观感受就是"滑不过去 / 滑到一半没了"。
      //   ⚠ 只在菜单【开着】时补这条缝：菜单没开的时候那片就是真空地，该穿透。
      if (refPanelEl) {
        const cr = refCardEl.getBoundingClientRect(), pr = refPanelEl.getBoundingClientRect();
        if (cr.width && pr.width) {
          const L = Math.min(cr.left, pr.left), R = Math.max(cr.right, pr.right);
          const T = Math.min(cr.top, pr.top), B = Math.max(cr.bottom, pr.bottom);
          if (x >= L - 2 && x <= R + 2 && y >= T - PAD_Y && y <= B + PAD_Y) return true;
        }
      }
    }
    const topTask = topTaskEl();
    if (topTask && !window.V7WorkspaceStackRail?.isHidden('tasks')){
      if (hitRect(x, y, topTask, 0, PAD_Y)) return true;
      // ⚠⚠ 必须带 .show —— 这是个真踩过的坑(2026-09-08):
      //   .task-preview 的 CSS 是 display:flex, 【永远不是 display:none】,
      //   隐藏只靠 opacity:0 + pointer-events:none。所以它始终占着一个真实矩形,
      //   而 hitRect 只在宽高为 0 时才判否 → 隐藏的预览照样"命中"。
      //   后果: 任务卡右边一整条(572×150)永远被当成"在 UI 上", 穿透开不了,
      //   用户点不到下层的 Photoshop。
      //   滚轮那边一直写的是 '.task-preview.show', 这里漏了 —— 同一个元素两套判定标准。
      const pv = topTask.querySelector('.task-preview.show');
      if (pv && hitRect(x, y, pv, 0, PAD_Y)) return true;

      // ⭐⭐⭐ 2026-10-06【「右滑弹出即闪回」的真正根因，实测确认】——
      //   上面那两行只认【卡本身】和【预览条本身】，中间和上面各漏了一块：
      //
      //   ① 任务卡 ↔ 预览条之间那条【41px 的缝】
      //      卡右缘 = 卡左缘+300；预览条 left:340（卡还有 1px 边框）⇒ 实际左缘 = 卡左缘+341
      //      ⇒ 361~400 这 40px【两块矩形都不认】。
      //   ② 上方那个【大预览框 .tween-box】—— 它压根没在这张表里登记过。
      //
      //   命中任一块 = overUI 返回 false = setIgnore(true) = 窗口切【点击穿透】
      //   → WebView 当场收不到鼠标 → 浏览器【合成一条 documentElement.mouseleave】
      //   → tween-preview.js 的 pointerAway=true → hideBox() 当场收框
      //   → onBoxClosed 回调把预览条一起收 = 用户看到的「弹出即闪回」。
      //
      //   ⚠ 实测证据（调试卡的「预览链追踪」面板）：打开到收掉只隔 24ms，
      //     栈顶正是 documentElement 的 mouseleave 处理器；
      //     同一次实跑的外壳日志里同时刻有 `[穿透] 界面请求 -> 穿透`。
      //   ⚠ 为什么自由模式不犯：那边走 V7FreeMode.hitTest（另一套几何，
      //     条压在卡身上没有缝、大框也在卡框内）—— 所以两种模式表现不一致。
      //   ⚠ 规矩本来就有（docs/12 §6.4）：**新加的一切全窗口浮层必须来这里登记**。
      //     大预览框是漏登记的第一个；这次连缝一起补上，别再让第二个人栽。
      if (window.V7Tween && typeof V7Tween.boxHit === 'function' && V7Tween.boxHit(x, y)) return true;
      // ① 预览链整块的并集：大框 ∪ 预览条
      //   ⚠ 用【并集】而不是逐个矩形判：框底(562) 与 条顶(579) 之间还夹着一条
      //     17px 的【纵向缝】，鼠标从触发带斜着往上够框时必然穿过去。
      //     逐个矩形补永远补不完 —— 一次算成并集，中间任何缝天然被包含。
      if (pv) {
        const pr = pv.getBoundingClientRect();
        if (pr.width && pr.height) {
          let L = pr.left, R = pr.right, T = pr.top, B = pr.bottom;
          const bx = document.querySelector('.tween-box.show');
          if (bx) {
            const br = bx.getBoundingClientRect();
            if (br.width && br.height) {
              L = Math.min(L, br.left); R = Math.max(R, br.right);
              T = Math.min(T, br.top);  B = Math.max(B, br.bottom);
            }
          }
          if (x >= L - 2 && x <= R + 2 && y >= T - PAD_Y && y <= B + PAD_Y) return true;
        }
        // ② 卡 ↔ 条 那条【横向缝】（卡右缘 → 条左缘，实测 40px）：
        //   只要高度上重叠就算在 UI 上（卡和条本来就是齐平的）。
        const cr = topTask.getBoundingClientRect();
        if (cr.width && pr.left >= cr.right) {
          if (x >= cr.right && x <= pr.left &&
              y >= Math.max(cr.top, pr.top) - PAD_Y && y <= Math.min(cr.bottom, pr.bottom) + PAD_Y) return true;
        }
      }
    }
    return false;
  }
  // Tauri 点击穿透后 WebView 不再收到 mousemove；适配层通过原生光标轮询
  // 调回这个闭包，复用同一套卡片/弹层几何命中规则恢复交互。
  window.__uiHitTest = overUI;
  // ⭐ 节流到【每帧最多一次】(2026-09-12)。
  //
  //   mousemove 一秒能触发 120 次，屏幕一秒只画 60 帧 ——
  //   **超过一半的计算结果还没机会显示就被下一次覆盖了**。节流掉的就是这部分。
  //
  //   ⚠ 这里【只改调用频率，判定逻辑一个字没动】。
  //     overUI 是点击穿透的命脉，改它会变成"点不到界面"或"点不到 Photoshop"。
  //
  // ⚠⚠ 2026-09-13 复核，纠正一个【写错了的结论】：
  //   docs/35 的 P1-1 说"overUI 里 12 次 getBoundingClientRect = 12 次强制重排"，
  //   **这个前提不成立**。强制重排(layout thrashing)的条件是【读-写交替】——
  //   写一次 DOM 让布局失效，下一次读就得重算。
  //   而 overUI 从头到尾**只有读**（getElementById / classList.contains /
  //   querySelector / getBoundingClientRect），中间一个 DOM 写都没有；
  //   setIgnore() 也不写 DOM（只发一次 IPC，去重交给 Rust 判断）。
  //   所以整个调用**最多触发 1 次布局计算**，后面那些 rect 读的是同一份已算好的布局。
  //
  //   → 「缓存矩形」那一半**不做了**。收益接近零，代价却是要在
  //     切卡 / 折叠 / 分区显隐 / 报错卡增删 / 任务增删 / 窗口缩放 /
  //     **340ms 的卡片动画全程** 正确失效 —— 动画期间矩形每帧都在变，
  //     缓存必然有一段时间是错的，而那正好是用户最可能点下去的时候。
  //   ⚠ 这是机制推断，没做性能剖析。自由模式把卡片数量堆上去之后若实测卡顿，
  //     再回来做 —— 那时有真实数据，可以只缓存"不参与动画"的那几个矩形。
  //
  //   ⚠ 用最后一次坐标，不是第一次 —— 要的是"鼠标现在在哪"，不是"这一帧开头在哪"。
  let hitQueued=false, hitX=0, hitY=0;
  document.addEventListener('mousemove', e=>{
    hitX=e.clientX; hitY=e.clientY;
    if(hitQueued) return;
    hitQueued=true;
    requestAnimationFrame(()=>{
      hitQueued=false;
      setIgnore(!overUI(hitX, hitY));
    });
  });
  // 主界面刚加载时必须先接收点击。之前这里直接进入穿透状态，
  // 而透明 Tauri 窗口在初始化阶段可能还没有收到 mousemove，
  // 结果是配置页能操作，切到主界面后整个窗口都像“死掉”。
  // 后续 mousemove 仍会按 overUI 几何判定，把鼠标移到界面外的区域交给下层应用。
  setIgnore(false);
}

// ── 卡片背景: 每张卡独立, 通过 BG 模块按 card-N/zone-N/detail 存储 ──
// 切换区块时 zone 的 bgkey 会变(zone-{block}-{i}), 故引一个当前区块号
// ⚠ 不再直接存原图! 原分辨率转 base64 会涨 33%, 一张手机照片就能撑爆
//   localStorage 的 5MB 配额。改走 BG.setBgFromFile → canvas 按面板尺寸压缩。
function applyCardBg(key, file){
  if(!file || !window.BG) return;
  const item = document.querySelector('.bg-item[data-key="'+key+'"] .bg-pick');
  if(item) item.textContent='…';                 // 压缩是异步的, 给个进行中反馈
  window.BG.setBgFromFile(key, file).then(res=>{
    // ⚠ 这里【不要再报一次】(2026-09-12 修)。
    //   bg-manager.js 的 setBgFromFile 写盘失败时已经 ERR.report('BG_SAVE_FAILED') 了，
    //   这里原来又 alert 一次 —— 同一个错误弹两次，而且 alert 是系统级模态框，
    //   在透明置顶窗口里样式和整个界面格格不入（违反铁律 15）。
    //   失败时只把按钮恢复原样，让用户知道这次没成，报错交给统一出口。
    if(!res.ok && item) item.textContent='选图';
    // ⚠ 二级/三级的背景不是设在 [data-bgkey] 元素上, applyToCard 设的会被盖住/无效:
    //   二级 → 背景在 .z-body(为了跟内容一起滑动), 由 updateZoneBg 应用
    //   三级 → 由 updateDetailBg 应用
    //   所以换图后必须调它们各自的刷新函数, 否则"换了背景没有用"(光色却是对的, 因为
    //   --glow-hsl 写在 .zone/.detail 上能被光元素读到)。
    // ⚠ key 现在是【点】分段(zone.generation.results)，不是短横线
    if(key.startsWith('zone.')) updateZoneBg(cur);
    else if(key.startsWith('detail.')) updateDetailBg();
    else if(key.startsWith('error.')){
      const lv=key.split('.')[1];
      errorsEl.querySelectorAll('.error-card').forEach(card=>{
        if(card.dataset.severity===lv && window.BG.applyErrorToCard) window.BG.applyErrorToCard(card, lv);
      });
    }
    // 刷新主题管理器(若由正式入口挂载)。
    const tree = document.getElementById('bgTree');
    if(tree) renderDetailBg(tree);
  });
}

// ── 背景/主题管理器(正式入口按需挂载): 按主卡分组折叠, 全部卡片可换图 ──
// 分组: 一行一个主卡名, 点开显示它名下 1 主卡 + 4 分区 + 4 三级 = 9 张。
// 该能力不再依赖测试主卡，正式主题入口可直接复用。
function renderDetailBg(el){
  const lib = el || document.getElementById('dcBody');
  if(!lib) return;
  let html='';
  // ⚠ 直接从【槽位表】生成，key 全用语义名(bgSlotKey)。
  //   以前是 'zone-'+b+'-'+p 这种序号拼接，增删卡片就错位 —— 见 docs/24。
  const groups=[];
  for(let b=0;b<N;b++){
    const items=[{ key:bgSlotKey('card',b), label:'主卡背景', type:'main' }];
    (ZONE_SETS[b]||[]).forEach((_,p)=>{
      items.push({ key:bgSlotKey('zone',b,p), label:'二级 · '+zoneLabelOf(b,p), type:'zone' });
    });
    (ZONE_SETS[b]||[]).forEach((_,p)=>{
      items.push({ key:bgSlotKey('detail',b,p), label:'三级 · '+zoneLabelOf(b,p), type:'detail' });
    });
    // Consolidated cards still retain every historical theme address. Users
    // can inspect/export/replace those images without recreating old pages.
    const historical={engines:[['engine','引擎'],['align','对齐'],['detail','细节'],['matting','抠像']],
      history:[['recent','最近'],['prompts','提示词'],['checkpoints','检查点']],
      // ⭐ 2026-10-15：生成卡四格合成一张大二级 —— 原四格的背景槽位照样登记，主题包不丢。
      generation:[['prompt','生成图片'],['refimage','参考图片'],['results','生成结果'],['help','生成与传回设置']],
      // ⭐ 2026-10-17：助手卡四格合成一张大二级 —— 原四格的背景槽位照样登记。
      assistant:[['chat','对话与会话'],['connection','模型与连接'],['permissions','Agent 权限'],['recovery','恢复节点']]};
    for(const [slug,label] of historical[cardSlugOf(b)]||[]){
      for(const kind of ['zone','detail'])items.push({key:BG.slotKey(kind,cardSlugOf(b),slug),label:'保留背景 · '+label+' · '+(kind==='zone'?'二级':'三级'),type:kind});
    }
    // Tool details share the presets card shell but need optional per-tool
    // artwork. The legacy detail.presets.list slot remains the fallback for
    // themes that predate tool silhouettes.
    if(b===CARD_PRESETS && window.BG && window.BG.slotKey && window.V7ToolSilhouettes){
      V7ToolSilhouettes.definitions.forEach(row=>{
        items.push({ key:BG.slotKey('detail','presets','tool-'+row.key), label:'三级 · 工具 · '+row.title, type:'detail' });
      });
    }
    groups.push({ name:(cards[b]&&cards[b].dataset.bglabel)||('模块 '+(b+1)), items });
  }
  groups.push({
    name:'报错背景 L1-L4',
    items:['L1','L2','L3','L4'].map(lv=>({ key:window.BG?window.BG.errorKey(lv):'', label:'报错 '+lv, type:'error' }))
  });
  groups.push({
    name:'自由模式空位',
    items:[
      {key:'free.placeholder.tasks',label:'任务卡堆空位',type:'free-placeholder'},
      {key:'free.placeholder.errors',label:'报错卡堆空位',type:'free-placeholder'}
    ]
  });
  groups.forEach((g,gi)=>{
    // 默认展开当前主卡那一组, 其余收起(方便一打开就能看到当前正在管的卡)
    const open = (gi===cur);
    // ⚠ 展开/收起箭头。图标库没加载时回退成原来的字符，不要留空——
    //   那样用户完全看不出这一行能点开。
    const arrow = window.ICON
      ? ICON.render(open?'chevronDown':'chevronRight', 12)
      : (open ? '▾' : '▸');
    html += `<div class="bg-group${open?' open':''}" data-group="${gi}">${arrow}<span>${g.name}</span></div>`;
    html += `<div class="bg-group-body" id="bgGroup${gi}" style="${open?'':'display:none'}">`;
    g.items.forEach(r=>{
      const has=window.BG && window.BG.getBg(r.key);
      const thumb= has? `<div class="bg-thumb" style="background-image:url('${has}')"></div>`
                      : `<div class="bg-thumb bg-thumb-empty">默认</div>`;
      const t = window.BG && window.BG.targetFor ? window.BG.targetFor(r.key) : null;
      const size = t ? `${t.w}×${t.h}` : '';
      // ⚠ has 现在是 blob: 地址(短字符串)，长度不再代表图片大小 —— 体积从 BG.usage() 拿
      const kb = '';
      // 当前正显示的那张卡(主卡cur/分区zoneSel)高亮
      const hi = (r.key===bgSlotKey('card',cur) || r.key===bgSlotKey('zone',cur,zoneSel) || r.key===currentDetailBgKey()) ? ' bg-hi' : '';
      html += `<div class="bg-item${hi}" data-key="${r.key}">
        ${thumb}
        <div class="bg-meta"><div class="bg-label">${r.label}</div><div class="bg-key">${size}${kb}</div></div>
        <label class="bg-pick">换<input type="file" accept="image/*" data-bgkey="${r.key}" style="display:none"></label>
      </div>`;
    });
    html += `</div>`;
  });
  const u = window.BG && window.BG.usage ? window.BG.usage() : null;
  if(u){
    html += `<div class="bg-foot"><span>已用 ${u.count} 张 · ${u.kb}KB / 5MB</span>
      <button class="bg-clear" id="bgClearAll">清空全部</button></div>`;
  }
  lib.innerHTML=html;
  // 分组折叠: 点击组名展开/收起(用 data-group 索引)
  lib.querySelectorAll('.bg-group').forEach(g=>{
    g.addEventListener('click',()=>{
      const body=document.getElementById('bgGroup'+g.dataset.group);
      const open = g.classList.toggle('open');
      g.textContent = (open?'▾':'▸') + g.textContent.slice(1);
      if(body) body.style.display = open?'':'none';
    });
  });
  const cl=document.getElementById('bgClearAll');
  if(cl) cl.addEventListener('click',e=>{
    e.stopPropagation();
    if(confirm('清空所有卡片的背景图, 回到默认渐变色?')){ window.BG.clearAll(); renderDetailBg(); }
  });
  lib.querySelectorAll('.bg-pick input[data-bgkey]').forEach(inp=>{
    inp.addEventListener('change',e=>{
      e.stopPropagation();
      applyCardBg(inp.dataset.bgkey, e.target.files[0]);
    });
  });
}

// ⚠⚠ ZONE_SETS 必须定义在【所有用到它的函数被调用之前】。
//   2026-09-10 踩过: 它原本在 3855 行, 而 updateZoneBg(cur) 在 3206 行就执行了 ——
//   const 的暂时性死区直接抛 ReferenceError, 整个脚本当场死掉,
//   表现是窗口不能滚动/不能折叠/不能拖拽(后面的事件绑定全没跑到)。
//   ⚠ 这种错【只在控制台里看得到】, 界面上只是整个不动了。
// ⚠ 顺序必须和 HTML 里 .block-card 的出现顺序一一对应(按 cur 索引取)。
//   2026-09-08 删掉了修图/特效/合成/上课四张占位卡, 这里同步删掉它们的分区。
//   加回主卡时: HTML 加一张 → 这里【同一位置】加一组, 别的地方不用改
//   (索引已改用 CARD_GENERATION/CARD_SETTINGS 语义常量, 会自动跟着走)。
// ⚠ 第 4 位是【背景槽位的语义名】，主题包按它命名文件(zone.generation.prompt.jpg)。
//   一旦定了就别改 —— 改了等于让所有主题包的那张图失效。清单见 docs/24_主题开发规范.md。
const ZONE_SETS=[
  // ⭐ 2026-10-15（用户定）：生成卡改成【单张大二级】，没有三级。原来的四格
  //   （生成图片 / 参考图片 / 生成结果 / 生成与传回设置）合进 #generationZone 的一列里，
  //   右边导航点哪滚到哪。这一组只剩一个槽位名 'all'（同设置卡 / 外挂卡）。
  //   ⚠ 原四格的背景槽位在 bgSlotList 的 historical.generation 里保留。
  [['sparkles','生成','开始生成 · 参考图 · 结果','all']],
  // ⚠ 预设卡的二级只有【一张】卡(#presetZone)，不是四张。这一组只用来给背景槽位起名
  //   (zone.presets.list / detail.presets.list)，四张普通 .zone 在预设卡下是隐藏的。
  [['person','预设列表','按部位挑预设','list']],
  // 设置详情由正式设置渲染器接管，这里只提供固定的二级标签。
  [['keyhole','账号与连接','账号 · API · 算力 · Photoshop','connection'],['palette','默认与交互','生成默认值 · 滚动 · 快捷键','output'],['monitor','界面','外观 · 自由布局 · 教程提示','appearance'],['shield','存储与隐私','缓存 · 容量 · 浏览器','tools']],
  // ⭐ 外挂能力卡（2026-10-01 改成单张大二级）。
  //   ⚠ 原来是四个分区（加速引擎 / 对齐与校色 / 细节补偿 / 抠像与分割），
  //     现在整层合并成一张 540×400 大卡：左边内容 + 右边【档位梯子】。
  //     照记录卡 2026-09-30 那次改法 —— 只留一个槽位名。
  //   ⚠ 槽位名沿用 'all'（原「外挂·全部」），主题包里
  //     zone.engines.all / detail.engines.all 继续有效，不会失效。
  //   ⚠ 原来那四个槽位名（engine / align / detail / matting）从这一组里撤了 ——
  //     它们对应的分区已经不存在。用户给那几个槽位设过的背景图会"暂时看不到"，
  //     但数据还在（没删），以后要是再拆分区，原样挂回去就行。
  //   ⚠ 注意：卡【内容】里仍有同名的能力页（抠像 / 人体解析…），
  //     那是卡自己的右栏导航，跟这个背景槽位表不是一回事 —— 别混。
  [['bolt','外挂能力','档位 · 模型 · 能力开关','all']],
  // Keep the four historical background slugs: existing theme packs address them by name.
  // ⭐ 2026-09-30 记录与恢复卡实装：这张卡只剩【一个分区】—— 一张 540×400 大卡
  //   （项目列表 + 任务 + 检查点时间轴），没有三级。
  //   ⚠ 槽位名沿用 'all'（原「全部历史」，意思对得上），主题包里
  //     zone.history.all / detail.history.all 那几张图继续有效，不会失效。
  //   ⚠ 原来那四个槽位名（recent / prompts / checkpoints）从这一组里撤了 ——
  //     它们对应的分区已经不存在。用户给那几个槽位设过的背景图会"暂时看不到"，
  //     但数据还在（没删），以后要是再拆分区，原样挂回去就行。
  [['scroll','记录与恢复','任务 · 检查点 · 恢复到任务栏','all']],
  // ⭐ 2026-09-29 方案 B：项目卡 = 当前这单活的全部内容；「本项目记录」从原时间线卡的「本次项目」挪过来。
  //   ⚠ 拍摄日程原写「关联项目」，但日程条目里没有项目字段（只是提醒）—— 改成如实描述。
  [['package','项目管理','照片 · 进度 · 交付','projects'],['scroll','本项目记录','这单活的生成任务','records'],['scroll','拍摄日程','提醒 · 到点通知','schedule'],['image','Eagle 归档','素材 · 标签 · 导入','eagle']],
  // ⭐ 2026-10-17（用户定，D02）：助手卡改成【单张大二级】#assistantZone，没有三级。原来四格
  //   （对话与会话 / 模型与连接 / Agent 权限 / 恢复节点）合进一张卡：左边内容、右边导航。
  //   这一组只剩一个槽位名 'all'；原四格的背景槽位在 bgSlotList 的 historical.assistant 里保留，主题包不丢。
  [['sparkles','助手','对话 · 开工 · 快捷指令','all']],
  [['bolt','运行诊断','调试开关 · 性能 · 网络','runtime'],['shield','报错演示','L1 · L2 · L3 · L4','errors'],['scroll','日志','桥接记录 · 清空 · 导出','logs']],
  // ⭐ 2026-10-18 深夜：第 9 张「问题反馈」（单张大二级，槽位名 'all'）。
  //   ⚠ 这一格原来放的是 10-14 删掉的「使用教程」卡的四格（卡早没了，这组一直是死数据）——
  //     现在 HTML 第 9 张是问题反馈卡，按位置对应就得是它这一组（不改的话背景槽位会叫成 zone.feedback.cards 之类的野名字）。
  [['info','问题反馈','写问题 · 贴截图 · 发到后台','all']],
  // ⭐ 2026-10-20：第 10 张「社区」（单张大二级，槽位名 'all'）。按位置对应 HTML 第 10 张。
  [['info','社区','排行榜 · 热门分享 · 进社区网页','all']]
];

// 二级分区图标的唯一写入口（2026-09-14）。
// ⚠ 必须只有这一个函数能写 .z-ic —— 原来有两处各写各的，
//   改图标格式时漏了一处，界面直接把图标名当文字显示出来。
//   以后再有第三处要写图标，也走这里。
function setZoneIcon(el, name){
  if(!el) return;
  if(window.ICON){
    ICON.set(el, name, 24);
    // 大图标（二级分区）要参与"选中→循环动画"，渲染完登记一次
    if(window.MOTION) MOTION.bind(el);
  }else{
    el.textContent='';   // 图标库没加载时留空，不要把图标名当文字显示
  }
}

// 二级分区"选中"的唯一入口（2026-09-14）。
// ⚠ 原来 .sel 类在【三个地方】各加各的（点击 / 悬停滑动 / 恢复快照），
//   要给选中态接动画就得改三处，必漏。统一走这里。
// ⭐ 用户定的大图标模型：选中 → 开始循环动画；取消选中 → 从当前帧平滑退回静止。
function selectZone(idx){
  if(!isPresetCard())idx=Math.max(0,Math.min((ZONE_SETS[cur]||[]).length-1,Number(idx)||0));
  const list=zones.querySelectorAll('.zone');
  list.forEach(z=>{
    const on = parseInt(z.dataset.z)===idx;
    const was = z.classList.contains('sel');
    z.classList.toggle('sel', on);
    if(on===was) return;                       // 状态没变就别重复起停动画
    const ic=z.querySelector('.z-ic');
    if(!ic||!window.MOTION) return;
    if(on) MOTION.select(ic); else MOTION.deselect(ic);
  });
  zoneSel=idx;
}

// ═══ 背景槽位 key ═══
// ⚠ 一律语义名，绝不用序号。旧方案 card-0/zone-0-2 是按 DOM 位置编号的，
//   2026-09-08 删掉四张占位主卡时整套错位，不得不写一次性迁移。
//   主题包要能长期用，key 就必须跟增删卡片无关 —— 加卡片时已有 key 一个都不动。
//   完整槽位清单见 docs/24_主题开发规范.md。
function cardSlugOf(block){
  const c = cards && cards[block];
  return (c && c.dataset.card) || ('card' + block);
}
function zoneSlugOf(block, i){
  const set = ZONE_SETS[block] || [];
  const item = set[i];
  return (item && item[3]) || ('zone' + i);      // 第 4 位是语义名
}
function zoneLabelOf(block, i){
  const set = ZONE_SETS[block] || [];
  const item = set[i];
  return (item && item[1]) || ('分区' + (i + 1));
}
function bgSlotKey(kind, block, i){
  if (!window.BG || !window.BG.slotKey) return '';
  return window.BG.slotKey(kind, cardSlugOf(block), (i == null ? '' : zoneSlugOf(block, i)));
}

// ── 切换区块时更新 zone 的 bgkey 并应用对应背景 ──
// ⚠ .pzone(预设卡的单张长卡)不参与序号编排 —— 它的 bgkey 写死在 HTML 里
//   (zone.presets.list)，跟着序号走会被算成 zone.generation.prompt。
function updateZoneBg(block){
  const set=ZONE_SETS[block]||[];
  zones.querySelectorAll('.zone:not(.pzone)').forEach((z,i)=>{
    // Some formal cards intentionally have three categories while the shared
    // DOM keeps four reusable zone shells. Do not publish a made-up semantic
    // slot such as zone.projects.zone3 for the hidden shell.
    if(!set[i]){
      z.removeAttribute('data-bgkey');
      z.removeAttribute('data-bglabel');
      return;
    }
    // ⚠ 语义 key: zone.<主卡名>.<分区名>，跟卡片位置无关(见 docs/24)
    z.dataset.bgkey = bgSlotKey('zone', block, i);
    z.dataset.bglabel = zoneLabelOf(block, i);
    // ⚠⚠ 这里【必须走 BG.applyToCard】，不能自己写一套（2026-09-14）。
    //   原来这段自己判断"有图用图、没图用 keyToGrad"，是全项目【第三套】上色逻辑
    //   （另外两套：bg-manager.applyToCard、updateDetailBg）。
    //   后果：切主卡时它直接把彩色渐变写回 .z-body，
    //   把"全局纯色底"那个设置覆盖掉 —— 表现就是【切换动画里闪出一套彩色】
    //   （用户 2026-09-14 实测，前面两轮各修了一套，就剩这套没抓到）。
    //   applyToCard 里有完整的优先级：单独设的图 > 全局纯色 > 默认渐变，
    //   而且顺带设 --glow-hsl，比这里手写的更全。
    if(window.BG && window.BG.applyToCard) window.BG.applyToCard(z.dataset.bgkey);
  });
}

function toolDetailBgKey(){
  if(typeof CARD_PRESETS!=='number'||cur!==CARD_PRESETS||!window.BG||!window.V7ToolSilhouettes||!window.PRESETUI||typeof PRESETUI.getToolPreset!=='function') return '';
  const preset=PRESETUI.getToolPreset(),entry=preset&&V7ToolSilhouettes.getPreset(preset);
  return entry&&entry.key ? BG.slotKey('detail','presets','tool-'+entry.key) : '';
}

function currentDetailBgKey(){
  const legacy=bgSlotKey('detail',cur,zoneSel),tool=toolDetailBgKey();
  // Existing themes only know detail.presets.list. Keep that slot authoritative
  // until a user/theme has actually supplied the new tool-specific image.
  return tool&&BG.getBg(tool) ? tool : legacy;
}

// A saved/deleted image or an async theme reload can change which fallback is
// applicable while the same tool remains selected.
window.addEventListener('wheelchair:background-change', updateDetailBg);

// ── 三级详情: 按 当前主卡+分区 绑定稳定 bgkey(detail-{主卡}-{位置}) ──
// 三级 ID 独立于二级, 但数量与二级相等、从属一级。此函数在点分区/切主卡时调用。
function updateDetailBg(){
  if(!detail) return;
  // ⚠ 语义 key: detail.<主卡名>.<分区名>(见 docs/24)
  const key = currentDetailBgKey();
  const tool = toolDetailBgKey();
  detail.dataset.bgkey = key;
  detail.dataset.bglabel = tool && key===tool
    ? '工具 · ' + ((window.V7ToolSilhouettes?.getPreset && window.PRESETUI?.getToolPreset)
      ? (window.V7ToolSilhouettes.getPreset(window.PRESETUI.getToolPreset())?.title || '详情')
      : '详情')
    : zoneLabelOf(cur, zoneSel) + ' · 详情';
  // ⚠⚠ 三级卡原来在这儿【自己写了一套上色逻辑】，绕过 bg-manager.applyToCard ——
  //   所以"全局纯色底"那个设置对它完全不生效（2026-09-14 用户实测：三级还有色罩）。
  //   现在改成调 applyToCard，和主卡/二级走同一条路：
  //     这张卡单独设过的图 > 全局纯色 > 该卡专属默认渐变
  //   ⚠ applyToCard 还会顺带设 --glow-hsl（光效色），原来这段没设，
  //     三级的光一直跟着别处的值走。改完顺带修了这个。
  if(window.BG && window.BG.applyToCard){
    window.BG.applyToCard(key);
  }else{
    // 兜底：BG 没加载时至少别留着上一张卡的图
    detail.style.backgroundImage='';
    detail.classList.remove('has-bg');
  }
  // 主题管理器按需调用 renderDetailBg()；当前正式 UI 不显示独立背景管理卡。
}

