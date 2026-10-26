/* ══════════════════════════════════════════════════════════════════════════
 * 参考图卡（ui-pure/reference-card.js）  ·  2026-10-13 新建
 * ══════════════════════════════════════════════════════════════════════════
 * 用户定案（2026-10-13，本卡推翻了自己 10-01 的 R3/R8 两条，见下）：
 *   · 参考图不再"点了弹窗才出现"，而是在【报错栏那一片】挂成一张常驻卡。
 *   · 【有图就在，没图就整张卡消失】—— 不占地方。
 *   · 缩略图 1:1。加一张就多一个格子，一眼能看全（上限 5 张，50px 正好排满）。
 *   · 往右滑 → 推出管理区（清除全部 / 排序 / 追加 / 删除单张）。
 *   · 加图那一刻卡片【从光里扫出来】（照抄报错卡的 errorGlowSweep）。
 *   · 层级：平时在报错卡【下面】；【正在加图/管图时】临时抬到报错卡之上。
 *     报错来了参考图让位 —— 用户原话："本身我们的所有操作它并不存在静态"。
 *
 * ⚠⚠ 本卡推翻了用户 2026-10-01 自己定的两条规则，写在这里免得下一个人当成 bug：
 *   · R3「弹窗关掉 = 清空临时参考图」—— 没有弹窗了，这条作废。
 *   · R8「参考图【只放在弹窗里】，不上一级卡面」—— 用户 10-13 明确要它常驻可见。
 *   R2（关软件就不留）和 R4（点了计算才落盘）【继续有效】。
 *
 * ⚠ 为什么不做成"塞进 #errors 里的一张特殊报错卡"：
 *   会被报错的"最多显示 4 层"限制，而且报错清堆时可能把参考图一起清掉。
 *   所以自己一个 #refs 容器，位置由宿主在 setErrors() 末尾顺带刷新（只加一行调用）。
 *
 * ⚠ 不碰 ui.html 的内部变量：要抓选区/看图/生成，一律由宿主 configure() 传进来。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var host = {};              // 抓选区、看图、预览停留/离开及图标，由宿主装配。
  var el = null;              // #refs 容器
  var card = null;            // .ref-card
  var panel = null;           // .ref-panel
  var panelOpen = false;
  var busyText = '';
  var lastSig = '';           // 上一次渲染的内容指纹（没变就不重画）
  var frontTimer = 0;         // 抬到最上之后的自动降回计时器

  function R() { return root.V7PresetReferences; }
  function L() { return root.V7ReferenceLimits || { REFS_MAX: 5, TOTAL_MAX: 6 }; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, size) {
    try {
      if (typeof host.icon === 'function') return host.icon(name, size);
      if (root.ICON && typeof root.ICON.render === 'function') return root.ICON.render(name, size);
    } catch (_) { }
    return '';
  }

  // ── 建容器（只建一次）──
  function build() {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.className = 'refs';
    el.id = 'refs';                         // 跟 #errors / #tasks 一致：容器都带 id，好定位也好调试
    el.hidden = true;                       // ⚠ 没图就整张不挂（用户定）
    el.innerHTML =
      '<div class="ref-card" data-ref-card>' +
        // ⚠⚠⚠ 2026-10-14 补（用户："你的光效是用一个方形的界面来去限制它的，
        //   但是我们的界面是有圆角的，所以说你的方形光线出在我们画面框外了"）——
        //   用户完全对。光带是个【矩形】，强度从右缘往左递减到 0，
        //   但递减到 0 之前那几个 px 已经越过圆角了 —— 所以角上会露出一小块方形的光。
        //   原生的做法（ui.html:1040）是光【包在一层圆角裁切壳里】：
        //     .error-light-clip{ position:absolute; inset:0; overflow:hidden;
        //                        border-radius:28px; pointer-events:none; z-index:2; isolation:isolate; }
        //   ⚠ 我之前只给光自己写了 border-top-right-radius —— 那只管右上角，
        //     而且宽度涨到 44px 之后【左边缘还是方的】，圆角根本挡不住。
        //   ⇒ 照抄：加一层 .rc-light-clip 把两个光包起来，让壳去裁。
        '<div class="rc-light-clip">' +
          '<div class="rc-glow"></div><div class="rc-bright"></div>' +
        '</div>' +
        '<div class="rc-edgehint"></div>' +
        '<div class="rc-head">' +
          // ⚠⚠ size 必须传 20，不能只是让 CSS 把它撑到 20：
          //   icons.css 是【按 svg 的 width 属性】给 stroke-width 分档的
          //   （.ico[width="13"]→2.2 / .ico[width="20"]→1.9）。
          //   属性写 13、CSS 显示 20 的话，描边会按 13px 那档给 2.2 ——
          //   在 20px 上就显得比隔壁报错卡的图标粗一圈（用户会看出"不是一套"）。
          //   2026-10-14 实测踩过：视觉尺寸对了（20×20）但 stroke 还是 2.2。
          '<span class="rc-head-ico">' + icon('image', 20) + '</span>' +
          '<span class="rc-title">参考图</span>' +
          '<span class="rc-count" data-ref-count></span>' +
        '</div>' +
        '<div class="rc-strip" data-ref-strip></div>' +
      '</div>' +
      '<div class="ref-panel" data-ref-panel>' +
        '<div class="rp-body">' +
          // ⭐⭐ 2026-10-14 用户定案（原话）：
          //   "我觉得在右边的卡片排参考图的顺序是一件很蠢的事情，以及在右边的卡片编辑参考图
          //    是一件很蠢的事情。我觉得应该让参考图直接可以拖拽排序…
          //    然后参考图右划就只有清除所有参考图这个按钮就行"
          //   ⇒ 排序搬到缩略图上（拖拽）、单张删除搬到缩略图右上角的小叉，
          //     管理区【只留一个】按钮。原来那行「1 ← → ✕ 2 ← → ✕」整行删掉。
          '<div class="rp-row">' +
            '<button type="button" class="rp-btn danger" data-ref-act="clear">清除所有参考图</button>' +
          '</div>' +
          '<div class="rp-hint" data-ref-hint></div>' +
        '</div>' +
      '</div>';

    // ⚠⚠ 2026-10-14 修正（用户 2026-10-14 定案）：挂进【#errors 里面】，当报错堆的一层。
    //   原来挂在 .anchor 里 —— 那是错的，两个后果：
    //     ① .anchor 自己就在 left:60px/top:60px，我在里面又写 left:60px/top:60px ⇒
    //        叠加成 120/120，永远比卡片堆【偏 60×60】（实测 offsetVsErrors dx=60 dy=60）。
    //     ② .anchor 带 z-index:5，是个【层叠上下文】⇒ 我写在里面的 z-index:834 根本出不去，
    //        "正在调参考图时抬到报错卡之上"这条完全没生效。
    //   ⚠ 报错堆和任务堆都是 body 直接子元素，ui.html:3204 那行注释专门警告过
    //     「anchor 的 z-index:5 会限制内部元素」—— 我踩了同一个坑，记在这儿别再犯。
    //   ⭐ 用户 2026-10-14 的原话："把它放到报错卡里面，作为报错卡的一个层级就好了呀"。
    //     好处：普通模式它就在报错栏；自由模式【跟着报错堆一起被拖走】，
    //     不用再登记成独立单元（那样普通模式在报错栏、自由模式又独立，会自相矛盾）。
    var errorsHost = document.getElementById('errors') || document.body;
    errorsHost.appendChild(el);

    card = el.querySelector('[data-ref-card]');
    panel = el.querySelector('[data-ref-panel]');

    el.addEventListener('click', onClick);
    // ⭐ 2026-10-14：拖拽排序。⚠ 用【指针事件】不用 HTML5 draggable ——
    //   照抄预设列表（preset-ui.js 的 bindDragSort）那套，理由见文件里那段注释。
    //   挂在容器 el 上用事件委托：缩略图是每次 render 重画的，逐个绑会绑到扔掉的旧节点上。
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    // 右滑展开用"鼠标贴右缘"触发（跟报错卡同一套习惯：贴边就预告 + 展开）
    card.addEventListener('mousemove', onCardMove);
    card.addEventListener('mouseleave', onCardLeave);
    card.addEventListener('mouseenter', function () {
      if (typeof host.holdPreview === 'function') host.holdPreview(card);
    });
    // ⚠ 2026-10-14 补：鼠标推进管理区之后【别收】—— 没有这两条的话，
    //   上面 onCardLeave 的宽限计时会照收，用户正要点按钮菜单就没了。
    panel.addEventListener('mouseenter', onPanelEnter);
    panel.addEventListener('mouseleave', onPanelLeave);
    // ⚠ 点空白收起。挂在 document 捕获阶段 —— 见 onDocPointerDown 里的理由。
    document.addEventListener('pointerdown', onDocPointerDown, true);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        leavePreview(true);
        if (panelOpen) { e.preventDefault(); e.stopPropagation(); closePanel(); }
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.defaultPrevented) leavePreview(true);
    });
    return el;
  }

  // ── 内容指纹：只有真变了才重画（防闪、防打断动画）──
  function signature(s) {
    var parts = [s.fixed.length, s.temporary.length, s.limit, s.blocked ? 1 : 0, busyText];
    s.fixed.forEach(function (r) { parts.push('f:' + r.name + r.thumbUrl); });
    s.temporary.forEach(function (r) { parts.push('t:' + r.name + r.thumbUrl); });
    return parts.join('|');
  }

  function rowsOf(s) {
    var out = [];
    s.fixed.forEach(function (row, i) { out.push({ kind: 'fixed', index: i, row: row }); });
    s.temporary.forEach(function (row, i) { out.push({ kind: 'temporary', index: i, row: row }); });
    return out;
  }

  // ── 渲染 ──
  function render() {
    var r = R(); if (!r || !el) return;
    var s;
    try { s = r.state(); } catch (_) { return; }

    var rows = rowsOf(s);
    var n = rows.length;

    // 没图 → 整张卡不挂（用户定："没有参考图的时候，参考图就删除"）
    if (!n && !busyText) {
      leavePreview(true);
      el.hidden = true;
      lastSig = '';
      if (panelOpen) closePanel();
      return;
    }
    el.hidden = false;

    var sig = signature(s);
    if (sig === lastSig) return;
    leavePreview(true); // 删除、排序、切预设或账号后，旧大图及未结束的读图都要退场。
    lastSig = sig;

    var lim = Number(s.limit) || L().REFS_MAX || 5;
    el.querySelector('[data-ref-count]').textContent = n + '/' + lim;

    // 图槽：有图的缩略图 + 空槽（点一下 = 追加当前选区）
    // ⭐⭐ 2026-10-14 用户定案：缩略图自己就是操作面板 ——
    //   · 拖着排序（拖完的顺序就是发给 AI 的顺序）
    //   · 右上角小叉 → 单张删除（原来是跑到右边管理区里点 ✕）
    //   · 点图本身   → 看大图详情
    //   ⚠ 小叉必须【包在缩略图里面】而不是绝对定位到 strip 上：
    //     缩略图是 50×50 的小方块，外面叠一层 18×18 的按钮很容易偏到隔壁那张上，
    //     删错图用户会直接骂人。放里面 z-index 抬起来，超出的部分靠 overflow:visible 露出去。
    //   ⚠⚠⚠ 【绝对不要】给缩略图加 draggable="true"（2026-10-14 踩过）：
    //     拖拽是【指针事件】那套（照抄预设列表，见下面 onPointerDown），
    //     而 HTML5 的原生 draggable 会在 pointerdown 之后【接管指针流】——
    //     浏览器开始自己的拖拽，pointermove 当场停发，我们的处理器就再也收不到位移。
    //     表现：按住能按下（:active 有反应），但拖不动、或者只挪一下就断。
    //     ⚠ 我的合成测试（new PointerEvent + dispatchEvent）【测不出这个】——
    //       它不会触发浏览器的原生拖拽机制，所以一路都是绿的。
    //       真机一上手就是"拽不动"。⇒ 加这个属性之前先想清楚用哪套拖拽。
    var strip = el.querySelector('[data-ref-strip]');
    var html = rows.map(function (x, i) {
      var isFirst = (i === 0);
      var tag = isFirst ? '主图' : ('参考图 ' + i);
      return '<span class="rc-thumb-wrap" data-ref-wrap="' + x.kind + ':' + x.index + '"' +
          ' data-ref-kind="' + x.kind + '" data-ref-index="' + x.index + '">' +
          '<button type="button" class="rc-thumb"' +
            ' data-ref-view="' + x.kind + '" data-ref-index="' + x.index + '"' +
            ' title="' + esc(x.row.name) + (isFirst ? '（第 1 张＝主图）' : '') + '　·　按住可拖动换顺序，点开看大图"' +
            ' style="background-image:url(' + esc(x.row.thumbUrl) + ')"' +
            ' aria-label="' + tag + '：' + esc(x.row.name) + '"></button>' +
          // ⚠ aria-label 写"删掉第 N 张"而不是"删除"：读屏时一排"删除"分不清删哪张
          '<button type="button" class="rc-del" data-ref-remove="' + x.kind + '" data-ref-index="' + x.index + '"' +
            ' title="删掉这一张" aria-label="删掉' + tag + '">✕</button>' +
        '</span>';
    }).join('');
    // 还能加几张 → 画几个空槽
    var room = Math.max(0, Math.min(lim, 5) - n);
    for (var i = 0; i < room; i++) {
      html += '<button type="button" class="rc-slot" data-ref-act="selection" title="追加当前选区" aria-label="追加参考图">+</button>';
    }
    // 真塞不下了（>5 张）—— 理论上到不了（上限 5），兜底给个"还有 N 张"
    if (n > 5) html += '<button type="button" class="rc-more" data-ref-act="expand">+' + (n - 5) + '</button>';
    strip.innerHTML = html;

    // 管理区：⭐ 2026-10-14 用户定案 —— 只留「清除所有参考图」。
    //   原来那行「1 ← → ✕　2 ← → ✕」整行删了（排序改成拖缩略图、删除改成缩略图右上角小叉）。
    //   ⚠ 这里【不再重画任何按钮】：面板是静态 HTML（见 build()），
    //     重画反而会让 hover/focus 状态在每次 render 时被打断。

    var hint = el.querySelector('[data-ref-hint]');
    if (hint) {
      var over = n > lim;
      // ⚠ 2026-10-14：提示里必须写清"顺序 = 发给 AI 的顺序、第 1 张是主图"——
      //   用户要求的就是这个语义，但界面上不说的话没人知道拖了会有什么后果。
      hint.textContent = busyText ? busyText
        : over ? '超出上限，请先删掉 ' + (n - lim) + ' 张'
        : s.blocked ? (s.reason || '当前组合不能再加')
        : (n > 1 ? '第 1 张＝主图，往后依次是参考图 · 拖动可换顺序'
                 : (room > 0 ? '还能加 ' + room + ' 张' : '已加满'));
    }

    // 禁用态：⭐ 管理区现在只剩「清除所有参考图」一个按钮
    //   ⚠ 加图入口已经搬到「回车发消息」和缩略图上的空槽，这里不再有 selection/files/save
    var busy = !!busyText || s.loading;
    el.querySelectorAll('[data-ref-act]').forEach(function (b) {
      b.disabled = busy || (b.dataset.refAct === 'clear' && !n);
    });
  }

  // ── 弹出光（照抄报错卡）──
  function glow() {
    if (!card) return;
    ['rc-glow', 'rc-bright'].forEach(function (cls) {
      var node = card.querySelector('.' + cls);
      if (!node) return;
      node.classList.remove('glow');
      void node.offsetWidth;         // 强制回流，动画才会重播
      node.classList.add('glow');
    });
    var dur = getComputedStyle(card).getPropertyValue('--dur').trim();
    var ms = dur && dur.endsWith('ms') ? parseFloat(dur) : 600;
    setTimeout(function () {
      card && card.querySelectorAll('.rc-glow.glow,.rc-bright.glow').forEach(function (n) { n.classList.remove('glow'); });
    }, ms + 80);
  }

  // ── 正在动它 → 抬到报错卡之上；停手一会儿自动降回 ──
  function raiseFront() {
    if (!el) return;
    el.classList.add('refs-front');
    if (frontTimer) clearTimeout(frontTimer);
    frontTimer = setTimeout(function () { frontTimer = 0; el && el.classList.remove('refs-front'); }, 2600);
  }

  // ⭐ 2026-10-14：管理区【不再常开】。
  //   ⚠ 原来卡片第一次出现时直接 openPanel() 且永不自动收起 ⇒ 截图里管理区一直开着、
  //     挡住了卡片右侧，而用户要的是"【往右划】才去管理"。常开等于把右滑这个动作废掉了。
  //   现在的做法：卡片出现时把管理区【亮一下再收】（教用户"这儿能滑出来"），
  //   之后打开只由两个动作触发 —— 鼠标贴卡片右缘、或点「+」空槽。
  function openPanel() {
    if (!panel || panelOpen) return;
    panelOpen = true;
    raiseFront();
    panel.classList.add('show');
    card && card.classList.add('expanded');
  }

  // ⭐⭐ 2026-10-14 用户报："参考图添加之后，它右侧的二级菜单直接自己弹出来了，我都没调"
  //   ⚠ 真因：原来这里叫 teachFlash()，它【直接 openPanel()】再等 1.8 秒收 ——
  //     卡片第一次出现（加第一张图）就强制把管理区亮出来，用户没碰它，它就是弹开的。
  //   实测（改之前）：加图后面板状态=true、卡片类="ref-card expanded"，2 秒后才 false。
  //   ⇒ 改成"右缘光自己走一趟"当教学：不碰面板，只让预告光像鼠标划过那样亮一下再收。
  //     用户看到的是"右边亮了一下"（暗示能往右推），要点/要推才真开管理区。
  //   ⚠ 为什么用 3 小段而不是一次长亮：一次长亮像"卡住了"；分三段像"有东西在动"，
  //     更接近"鼠标贴过去"的观感（跟鼠标真划过时的连续变化同一套语言）。
  var teachTimers = [];
  function clearTeach() {
    teachTimers.forEach(function (t) { clearTimeout(t); });
    teachTimers = [];
    var h = card && card.querySelector('.rc-edgehint');
    if (h) { h.style.opacity = '0'; h.style.width = '0px'; }
  }
  function teachFlash() {
    var h = card && card.querySelector('.rc-edgehint');
    if (!h) return;
    clearTeach();
    var seq = [[0, 0.22, 12], [0.35, 0.55, 26], [0.75, 0.9, 40], [0.95, 0.15, 8], [1.15, 0, 0]];
    seq.forEach(function (step) {
      teachTimers.push(setTimeout(function () {
        h.style.opacity = String(step[1]);
        h.style.width = step[2] + 'px';
      }, step[0] * 1000));
    });
    teachTimers.push(setTimeout(clearTeach, 1400));
  }
  // ⚠ teachArmed / teachTimer 这两个变量已经删了（2026-10-14：教学不再碰面板，
  //   改成右缘光自己走一趟，见上面 teachFlash）。清掉它们的引用 ——
  //   留着的话是往一个不存在的变量上赋值（非严格模式下会偷偷造全局变量，很难查）。
  function closePanel() {
    cancelAutoClose();                 // ⚠ 关了就别忘了把宽限计时也撤掉，否则会空转
    if (!panel || !panelOpen) return;
    panelOpen = false;
    panel.classList.remove('show');
    card && card.classList.remove('expanded');
  }

  // 鼠标贴到卡右侧边缘 → 右缘实时渐亮 + 展开管理区（跟任务卡/报错卡同一套习惯）
  //
  // ⚠⚠⚠ 2026-10-14 重写（用户："包括鼠标相关的位置也会决定我们的光效"）——
  //   用户说得对。第一版我只做了个死开关（classList.add('edge-hint')），
  //   光是"啪一下亮到固定亮度"，完全不跟鼠标位置。
  //   原生的做法（ui.html:8287-8307，任务卡预告光，注释写着"跟一/二级同款"）是
  //   【连续变化】：鼠标从卡片中线往右移，越靠右光越亮越宽，进触发带封顶。
  //   ⚠ 基准用【卡片自己的中线】而不是画面中心 —— 原生的注释专门写了这条：
  //     "以中心为基准会算出负值永远不亮"（卡在屏幕左边，画面中心在它右边）。
  //   ⚠ 曲线是 Math.pow(t, 1.3)：前段涨得慢、贴近边缘才明显加速，
  //     这样鼠标随便划过卡片时不会一直闪。数字照抄，不要凭手感改。
  //   ⚠ opacity 起点 0.15 不是 0：过中线就有一点微光，是"这儿能拉出去"的预告；
  //     真到 0 的话用户要推到很靠边才看得见，等于没有预告。
  var EDGE_TRIGGER_PX = 34;      // 进这条带 = 触发（跟原来一致）
  function onCardMove(e) {
    if (!card) return;
    cancelAutoClose();                 // 鼠标还在卡上 ⇒ 别收
    var r = card.getBoundingClientRect();
    if (!r.width) return;
    var hint = card.querySelector('.rc-edgehint');
    var mx = e.clientX;
    var distFromRight = r.right - mx;   // 离右缘多少 px（正数=在卡内）
    var inTrigger = distFromRight >= 0 && distFromRight <= EDGE_TRIGGER_PX;

    if (hint) {
      if (inTrigger) {
        // 进触发带 → 封顶（原生就是 44px / 1.0）
        hint.style.opacity = '1';
        hint.style.width = '44px';
      } else {
        // ⚠ 卡片中线往右算进度；中线左边 tt<=0 ⇒ 归零（原生同款）
        var mid = r.left + r.width / 2;
        var tt = Math.min(1, Math.max(0, (mx - mid) / (r.right - mid)));
        if (tt > 0) {
          var pp = Math.pow(tt, 1.3);
          hint.style.opacity = String(0.15 + pp * 0.75);
          hint.style.width = String(pp * 40) + 'px';
        } else {
          hint.style.opacity = '0';
          hint.style.width = '0px';
        }
      }
    }

    if (inTrigger) { openPanel(); }
    else if (panelOpen) { /* 已展开就别来回抖 */ }
  }
  function leavePreview(force) {
    if (typeof host.leavePreview === 'function') host.leavePreview(card, !!force);
  }
  function onCardLeave() {
    leavePreview(false); // 使用共用预览框的 160ms 宽限；管理菜单另走自己的 1200ms。
    card && card.classList.remove('edge-hint');
    // ⚠ 离开时把预告光的行内值清干净，让它回到 CSS 默认态（opacity:0 / width:0）。
    //   不清的话下次鼠标再进来会从"上次停住的那个亮度"开始，看着像闪了一下。
    var hint = card && card.querySelector('.rc-edgehint');
    if (hint) { hint.style.opacity = '0'; hint.style.width = '0px'; }
    // ⚠ 离开卡片【不能立刻收】：用户可能正要把鼠标移到管理区上（卡右缘 360 → 菜单左缘 400，
    //   中间有 40px 的缝，鼠标必然经过"哪块都不属于"的地方）。
    //   ⇒ 改成"宽限一会儿再收"：移进管理区就取消，都没回来才收。
    //   ⚠ 原来这里写的是【永不自动收】—— 用户 2026-10-14 实测报的就是这个：
    //     "它的按钮没有办法自动收回"。菜单划出来之后就赖在那儿了。
    scheduleAutoClose();
  }
  function onPanelEnter() {
    cancelAutoClose();
    if (typeof host.holdPreview === 'function') host.holdPreview(card);
  }
  function onPanelLeave() { leavePreview(false); scheduleAutoClose(); }

  // ── 自动收起 ──────────────────────────────────────────────────
  // ⚠ 用"宽限计时"而不是"立刻收"或"永不收"：
  //   立刻收 = 鼠标穿过那 40px 缝时菜单当场消失，用户觉得"滑不过去"；
  //   永不收 = 用户说的"没办法自动收回"。
  //   1200ms 是够推过去的余量（同 raiseFront 的 2600ms 是给"降回层级"用的，不是一回事）。
  var autoCloseTimer = 0;
  var AUTO_CLOSE_GRACE_MS = 1200;
  function scheduleAutoClose() {
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(function () {
      autoCloseTimer = 0;
      // ⚠ 收起前再确认一次鼠标真的不在卡上：窗口切过穿透、鼠标移到别处又移回来
      //   这些情况都会让 mouseleave 之后没有对应的 mouseenter，光靠事件计数会误收。
      if (card && card.matches(':hover')) return;
      if (panel && panel.matches(':hover')) return;
      if (typeof host.previewChainHit === 'function' && host.previewChainHit(card)) {
        scheduleAutoClose(); // 沿用任务卡连通区；离开大图后菜单仍能正常收尾。
        return;
      }
      closePanel();
      // ⚠ 连"抬到报错卡之上"也一起降回去 —— 菜单都没了还占着最上层是错的。
      if (frontTimer) { clearTimeout(frontTimer); frontTimer = 0; }
      el && el.classList.remove('refs-front');
    }, AUTO_CLOSE_GRACE_MS);
  }
  function cancelAutoClose() {
    if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = 0; }
  }

  // ── 点空白处收起 ────────────────────────────────────────────
  // 他的注释里写了"收起的时机交给点空白 / Esc / 卡片消失"，但【点空白这条根本没实现】——
  //   实测：点 BODY 之后 panel.show 还是 true。这里把它补上。
  // ⚠ 用 pointerdown 不用 click：click 要等 mouseup，用户按住拖动时不该误判成"点了空白"。
  // ⚠ 捕获阶段监听：卡片/菜单自己的处理器先跑（可能 stopPropagation），
  //   但"点空白"这件事必须在最外层先判掉，不能被里面拦走。
  function onDocPointerDown(e) {
    if (!(el && el.contains(e.target)) && !(e.target.closest && e.target.closest('.tween-box'))) leavePreview(true);
    if (!panelOpen) return;
    // ⚠⚠ 2026-10-14：点缩略图上的【小叉】要当成"点空白"处理 —— 一边收起一边让位。
    //   不能直接 return（缩略图在 el 里面，会被下面那条 el.contains 吃掉）。
    //   判据用小叉自己/祖先里的 [data-ref-remove]，不看 el.contains。
    if (e.target.closest && e.target.closest('[data-ref-remove]')) {
      closePanel();
      cancelAutoClose();
      return;
    }
    if (card && card.contains(e.target)) return;      // 点在卡上
    if (panel && panel.contains(e.target)) return;    // 点在菜单上
    if (el && el.contains(e.target)) return;          // 容器里的别的东西（保险）
    closePanel();
    cancelAutoClose();
  }

  // ── 拖拽排序：⭐ 2026-10-14 换成【指针事件】那套 ──────────────────────
  //
  //   ⚠⚠ 为什么不用 HTML5 的 draggable：用户的原话是
  //     "你可以看一下这个原来的剪影预设的二级菜单里面预设怎么排序的，
  //      把那个动画和方式去复制过来"。
  //     预设列表（preset-ui.js 的 bindDragSort，1143 行起）用的是【pointer 事件 + 位移】，
  //     不是 HTML5 drag —— 两套手感完全不一样（原生 drag 有系统那个半透明幽灵，
  //     而且 dragover 的事件频率和坐标语义都不同）。既然要"复制过来"，就照那套写。
  //
  //   原生那套的四个要点（逐条抄，别自己改数字）：
  //     ① pointerdown 时 setPointerCapture —— 鼠标移出元素也继续收事件，
  //        不然拖快一点就"掉"了
  //     ② 位移 < 4px 不算拖（绑定里的 `Math.abs(dy) < 4`）—— 防手抖误判
  //     ③ 拖动中【保持视觉位置】：拖起来的那张跟着鼠标，邻居让位
  //     ④ 松手后【先别清 transform】，等新顺序渲染好再一起换掉 ——
  //        原生注释里写死了这条（2026-09-11 修的两跳闪烁）
  //
  //   ⚠ 横向条：原生的 dy/offsetHeight 换成 dx/offsetWidth（缩略图是横着排的）
  //   ⚠⚠ 不许跨组拖（fixed 预设自带 / temporary 这次加的）—— 铁律见 preset-references.js
  //     move/moveTo 的注释。拖拽时看到 kind 不同就直接不认。
  var drag = null;
  var suppressViewClick = false;

  function thumbStep() {
    // 一格 = 缩略图宽 + 间隙。⚠ 从真实 DOM 量，别写死 54（CSS 改了这里要跟着改就必然忘）
    var w = el.querySelector('.rc-thumb-wrap');
    if (!w) return 54;
    var r = w.getBoundingClientRect();
    var strip = el.querySelector('[data-ref-strip]');
    var gap = strip ? parseFloat(getComputedStyle(strip).columnGap || getComputedStyle(strip).gap) || 0 : 0;
    return r.width + gap;
  }

  function wraps() {
    return Array.prototype.slice.call(el.querySelectorAll('.rc-thumb-wrap'));
  }

  function clearDragTransforms() {
    wraps().forEach(function (w) {
      if (w !== (drag && drag.wrap)) { w.style.transform = ''; w.style.transition = ''; }
    });
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;                  // 只认左键
    suppressViewClick = false;
    var wrap = e.target.closest && e.target.closest('.rc-thumb-wrap');
    if (!wrap || !el.contains(wrap)) return;
    // ⚠ 点小叉不是在拖 —— 那是删除，交给 click 那条路
    if (e.target.closest('[data-ref-remove]')) return;
    drag = {
      wrap: wrap,
      kind: wrap.dataset.refKind,
      index: Number(wrap.dataset.refIndex),
      startX: e.clientX,
      moved: false,
      list: wraps()
    };
    // 捕获到缩略图按钮：捕获到外层 wrap 会让原生 click 改落在 wrap，点按入口因此失效。
    var thumb = wrap.querySelector('[data-ref-view]');
    if (thumb && thumb.setPointerCapture) { try { thumb.setPointerCapture(e.pointerId); } catch (_) {} }
  }

  function onPointerMove(e) {
    if (!drag) return;
    var dx = e.clientX - drag.startX;
    // ② 位移不够不算拖（照抄原生的 4px 阈值）
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    drag.wrap.classList.add('dragging');
    drag.wrap.style.transform = 'translateX(' + dx + 'px)';
    // ③ 邻居让位：跟原生同一个算法，只是轴从 Y 换成 X
    var step = thumbStep();
    var from = drag.list.indexOf(drag.wrap);
    var to = Math.max(0, Math.min(drag.list.length - 1, from + Math.round(dx / step)));
    drag.list.forEach(function (w, i) {
      if (w === drag.wrap) return;
      var shift = 0;
      if (from < to && i > from && i <= to) shift = -step;
      else if (from > to && i < from && i >= to) shift = step;
      // ⚠ 跨组不许让位 —— 别让用户看着"能插进去"、松手又弹回来
      if (w.dataset.refKind !== drag.kind) shift = 0;
      w.style.transition = 'transform .12s ease';
      w.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
    });
  }

  function onPointerUp(e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.moved) {
      // 没真拖 → 让它回位（这条路上"回原位"才是对的，原生注释同款）
      d.wrap.classList.remove('dragging');
      d.wrap.style.transform = '';
      clearDragTransforms();
      return;
    }
    suppressViewClick = true; // 真拖过就不把松手后的 click 当成点开大图。
    var dx = e.clientX - d.startX;
    var step = thumbStep();
    var from = d.list.indexOf(d.wrap);
    var to = Math.max(0, Math.min(d.list.length - 1, from + Math.round(dx / step)));
    // ⚠⚠ 跨组：落点目标跟自己不是同一组 ⇒ 取消，回原位。
    //   必须显式取消并把行内 transform 清干净 —— 不清的话那张会【永久停在拖到的位置】，
    //   而数据没变，看着就是"拖过去了但重启就回去了"。
    var target = d.list[to];
    if (target && target.dataset.refKind !== d.kind) {
      d.wrap.classList.remove('dragging');
      d.wrap.style.transform = '';
      clearDragTransforms();
      return;
    }
    if (to === from) {
      // ⚠ 没换位置 → 带动画滑回原位；高亮等滑回去了再摘（原生同款）
      d.wrap.style.transition = 'transform .14s var(--ease-out)';
      d.wrap.style.transform = '';
      setTimeout(function () {
        d.wrap.classList.remove('dragging');
        d.wrap.style.transition = '';
        clearDragTransforms();
      }, 160);
      return;
    }
    // ④ 位置真变了：⚠ 这里【绝不清 transform】—— 让各行保持拖拽后的视觉位置，
    //    一直等到 moveTo 写完、列表重画，旧元素连同 transform 一起被替换掉。
    //    中间没有任何一帧是"回原位"，所以几乎看不出切换（原生注释 2026-09-11）。
    var r = R();
    if (!r || typeof r.moveTo !== 'function') { clearDragTransforms(); return; }
    run('正在调整顺序…', function () { return r.moveTo(d.kind, from, to); });
  }

  function onPointerCancel() {
    if (!drag) return;
    drag.wrap.classList.remove('dragging');
    drag.wrap.style.transform = '';
    drag = null;
    clearDragTransforms();
  }

  // ── 交互 ──
  async function run(text, fn) {
    busyText = text; lastSig = ''; render();
    try { await fn(); }
    catch (error) { R() && R().report(error); }
    finally { busyText = ''; lastSig = ''; render(); }
  }

  function onClick(e) {
    var t = e.target.closest && e.target.closest('[data-ref-view],[data-ref-act],[data-ref-remove],[data-ref-move]');
    if (!t || !el.contains(t)) return;
    var r = R(); if (!r) return;

    // ⚠⚠ 顺序要紧：小叉现在【包在缩略图里面】（见 render 里那段注释），
    //   所以它也能被 [data-ref-view] 的选择器匹配到外层。
    //   必须【先】判删除 —— 反了的话点小叉会变成"打开大图"，用户会觉得删除键坏了。
    if (t.hasAttribute('data-ref-remove')) {
      e.stopPropagation();
      e.preventDefault();          // ⚠ 缩略图外面是 .rc-thumb-wrap，防它被当成拖拽起点
      raiseFront();
      // ⭐ 2026-10-22（docs/263 第 6 条）：删了能撤销 —— 底部弹「已删除 1 张参考图 · 撤销」，点了放回原位
      run('正在删除…', function () {
        return r.remove(t.dataset.refRemove, Number(t.dataset.refIndex)).then(function (token) {
          if (!token || !root.V7Undo || typeof r.restore !== 'function') return;
          root.V7Undo.offer('已删除 1 张参考图', function () {
            run('正在放回…', function () { return r.restore(token); });
          });
        });
      });
      return;
    }
    if (t.hasAttribute('data-ref-view')) {
      e.stopPropagation();
      if (suppressViewClick) { suppressViewClick = false; return; }
      raiseFront();
      // 整张卡作为预览归属，宿主提供右划面板，交给任务卡的共用算法定位。
      // 不按单格右缘摆大图，否则会盖住后面的缩略图。旧宿主没有几何钩子时保留兼容回退。
      var geo = null;
      try {
        if (typeof host.geometry === 'function') geo = host.geometry(t);
      } catch (_) { geo = null; }
      if (!geo) {
        var cr = card.getBoundingClientRect();
        geo = { width: Math.max(240, Math.round(cr.width)), height: Math.round(cr.width * 1.2), side: 'right' };
      }
      // 贴整张卡，不能贴单格右缘：贴第一格右缘会遮住后面的缩略图。
      if (typeof host.viewImage === 'function') host.viewImage(t.dataset.refView, Number(t.dataset.refIndex), card, geo);
      return;
    }
    if (t.hasAttribute('data-ref-move')) {
      e.stopPropagation(); raiseFront();
      if (typeof r.move !== 'function') return;
      run('正在调整顺序…', function () { return r.move(t.dataset.refMove, Number(t.dataset.refIndex), Number(t.dataset.refDir)); });
      return;
    }

    var act = t.dataset.refAct;
    raiseFront();
    e.stopPropagation();
    if (act === 'selection') {
      if (typeof host.captureSelection !== 'function') return;
      run('正在从 Photoshop 抓取选区…', function () { return host.captureSelection(r.context()); });
    } else if (act === 'files') {
      var guard = r.context(), input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.multiple = true;
      input.hidden = true; el.appendChild(input);
      input.addEventListener('change', function () {
        var files = Array.from(input.files || []); input.remove();
        run('正在读取图片…', function () { return r.append(files, guard); });
      }, { once: true });
      input.addEventListener('cancel', function () { input.remove(); }, { once: true });
      input.click();
    } else if (act === 'save') {
      run('正在存进预设…', function () { return r.saveFixed().then(function () { root.UI && root.UI.toast && root.UI.toast('参考图已存进预设', 'ok'); }); });
    } else if (act === 'clear') {
      r.clearAll(); lastSig = ''; render();
    } else if (act === 'expand') {
      openPanel();
    }
  }

  // ── 定位：作为【报错堆内部的一层】往下让 ──
  //   ⭐ 2026-10-14 重写（用户定案："把它放到报错卡里面，作为报错卡的一个层级"）。
  //   ⚠ 为什么不做绝对定位（原来的写法）：
  //     ① 挂在 .anchor 里时坐标系错了（.anchor 自己 left/top 60，我又写 60 ⇒ 偏 60×60）；
  //     ② 自由模式下自由布局只认 tasks/errors 两个单元，参考图卡不在此列 ⇒ 拖不动，
  //        而它又确实该跟着报错堆走 ⇒ "普通模式在报错栏、自由模式独立"自相矛盾。
  //   ⭐ 现在：它是 #errors 的子元素，用【容器内相对坐标】往下排 ——
  //     容器 move（自由模式拖报错堆）时它自动跟着走，一行都不用额外写。
  //   ⚠ 不再自己算主卡/任务堆的避让 —— 那些由 #errors 容器自己负责，重复一份必然漂移。
  function reposition() {
    if (!el) return;
    if (el.hidden) return;
    var errorsEl = document.getElementById('errors');
    if (!errorsEl || el.parentElement !== errorsEl) return;
    var cards = errorsEl.querySelectorAll('.error-card');
    if (!cards.length) {
      // 没有报错 → 就待在报错栏原本该在的位置（容器顶部）
      el.style.transform = 'translate(0, 0px)';
      return;
    }
    // 报错堆的可见高度：顶层卡高 + 后面几层每层露出 ERR_STEP(24)
    var ERR_STEP = 24, ERR_MAX_VISIBLE = 4;
    var h = 0;
    cards.forEach(function (c) { h = Math.max(h, c.offsetHeight || 100); });
    var visible = Math.min(cards.length, ERR_MAX_VISIBLE);
    var extent = h + (visible - 1) * ERR_STEP;
    // ⚠ 用 transform 不用 top：transform 不触发重排，而且跟报错卡自己的叠压方式一致
    el.style.transform = 'translate(0, ' + (extent + 12) + 'px)';
  }

  root.V7ReferenceCard = {
    mount: function () { build(); render(); },       // 宿主第一次调用：建容器 + 首次渲染
    refresh: function () {                            // 参考图变了 → 重画（必要时播放弹出光）
      if (!el) return;
      var wasHidden = el.hidden;
      lastSig = '';
      render();
      // ⚠ 2026-10-14：卡片出现时改成 teachFlash()（亮一下再自动收），不是 openPanel() 常开。
      if (wasHidden && el && !el.hidden) { reposition(); glow(); teachFlash(); }
      reposition();
    },
    reposition: reposition,
    closePanel: closePanel,
    isOpen: function () { return !!(el && !el.hidden); },
    configure: function (h) { host = h || {}; }
  };
})(window);
