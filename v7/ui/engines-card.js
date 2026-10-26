/* ============================================================================
   外挂能力卡 · 2026-10-04 深夜重排（用户看完样机后逐条口述）
   ============================================================================

   ⭐⭐ 用户原话（这一版的依据，别改回去）：
     "主卡片其实它应该是一个横轴是这个档位，纵轴是能力。然后横轴呢，就是 1、2、3 档，
      甚至我们不要档位就行，我们可以开成这个快速、普通、精确……然后在这个快速、普通、
      精确，它就直接放到顶部的 bar 下面，然后右边放一个这个问号，然后你鼠标移到那个
      问号上面去……它就有一个窗口说啊，这个快速、普通、精确，它是一个什么分类方式？"
     "然后呢，这个纵轴呢，就是这个……抠图，分割……然后如果说某一个档位没有这个功能，
      那在这个纵轴纵向上面就显示一个叉叉，然后你鼠标移过去就告诉你说啊，这个档位下没有
      这个功能。然后如果说你想要开启某一个功能，你就在这个横纵轴交界的这个地方……点一下，
      然后卡片就直接跳转到那个地方去，告诉你说，哎，这个功能需要什么样的配置。"

     —— 一级卡面 = 【一张总表】。

     "然后二级大卡……右边不是有上下那个滚条吗……第一个页面就是你的配置信息。
      然后一级能力、二级能力、三级能力，然后这是能力的这个简介，然后说一下他们都可以
      做到哪些事情。然后这些能力呢，都有这个开关或者是引擎状态。"
     "顶栏……应该是我们目前的这个扫描用户的电脑配置，比如说内存是多少？显卡是多少？
      ……和我们的引擎的启动状态之类的。"
     "我们卡名在底部啊。"

     —— 二级 = 【右栏四页导航（配置信息 + 三档能力）】+【顶部硬件/引擎状态】。

   ⚠⚠ 这一版【删掉】的东西（别以为是漏了）：
     · 一级卡面的"详情区"（.ec-detail）—— 用户要的是"一眼看穿的图表"，不再需要它。
       连带 animDetail / detailNatural / detailMax / detailLimit / applyDetailCap /
       refreshMoreHint / queueMoreHint 七个函数一起删（它们只为详情区存在）。
     · 二级右栏的"档位梯子"—— 用户原话"右边不要放档位啊，就二级大卡不要放档位"。
       改成四页导航。
     · "三档都一样"压缩行（.ec-samerow）—— 现在每样能力都占一行（含校色）。

   ⚠ 守住的旧规矩（重写时必须继续守，别弄丢）：
     ① 三档必须表达【互斥】：只有当前档那一列亮，另两列压灰。
        用户 2026-10-01 强调过三次"有些功能它只能开一档"。
     ② 一级卡结构【一次建好、常驻】，之后只切 class / 文本（docs/12 坑 17）。
     ③ 卡面一个字都不许出现模型名 / 显存 / PyTorch（docs/14）。
        —— 现在由 engines-core.js 的 `form` 字段保证：卡面只读 form，不读 tiers。
     ④ "按钮点得动但点了没反应"是本项目最忌讳的形态：没接线就禁用 + 写明原因。
     ⑤ 引擎没起来 ≠ 要下载。本地模型都在，只是引擎没开（用户 10-04 实测报过）。
        文案由 engines-core.js 的 engineDown()/engineUp() 判，不要在这里另判一遍。
     ⑥ 藏意图：界面只谈"你能得到什么"，不谈"我们怎么算出来的"。
        机制词只许出现在报错详情里。

   ⚠⚠ 2026-10-04 修过的一个真 bug，重写时别再犯：
     表头原来是 `问号 + 三个档位` 同一个 grid 里，而问号绝对定位不占格子 →
     三个档位【自动落到第 1/2/3 列】，而第 1 列是 46px 的能力名栏 → 整个表头左移一格。
     （10-02 也踩过同一个：档位显示成 2、1、3。根因都是"靠 grid 自动排位"。）
     ⇒ 现在的做法：表头【不自己做 grid】—— 层级上单独一行，
        三个档位塞进一个 .ec-hrow，hrow 用跟数据行【同一个 template 变量】。
        两边共用变量就永远不会漂 —— 这是唯一的根治办法。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.V7EnginesCard = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var GLOBAL = (typeof window !== 'undefined' && window) || (typeof globalThis !== 'undefined' && globalThis) || {};

  var CORE = (typeof window !== 'undefined' ? window.V7EnginesCore : null) || null;
  function core() {
    if (CORE && CORE.TIERS) return CORE;
    CORE = GLOBAL.V7EnginesCore || CORE;
    return CORE;
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // 图标渲染优先走宿主给的 ICON（ui.html 的 icons.js），拿不到才用自带路径。
  function icon(name, size) {
    if (icon.renderer) { try { var s = icon.renderer(name, size || 16); if (s) return s; } catch (_) {} }
    return '';
  }
  icon.setRenderer = function (fn) { icon.renderer = fn; };

  var P = {
    arrow: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.3"/><circle cx="15" cy="9" r="1.3"/><circle cx="9.5" cy="15" r="1.3"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
    scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18M8 16.5 20 6"/>',
    person: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
    crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    download: '<path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3"/>',
    gpu: '<rect x="3" y="6" width="18" height="12" rx="3"/><circle cx="9" cy="12" r="2.6"/><path d="M15 10h3M15 14h3"/>',
    warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.5v2"/><path d="M12 17h.01"/>',
    dlss: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 15V9l4 6V9M17 9v6"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    // ⭐ 2026-10-04 重排新增（原来没有这两样能力的图标）：
    edge: '<path d="M4 20 20 4"/><path d="M4 13v7h7"/><path d="M13 4h7v7"/>',
    wave: '<path d="M2 12h4l2-6 3 12 2.5-8 2 4h6"/>',
    gauge: '<path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l5-3"/><circle cx="12" cy="12" r="1.4"/>',
    memory: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 4v3M12 4v3M16 4v3M8 17v3M12 17v3M16 17v3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    // ⭐ 2026-10-05 新增：能力块的展开/收起箭头（收起式布局要用）
    arrowDown: '<path d="m6 9 6 6 6-6"/>',
    arrowUp: '<path d="m6 15 6-6 6 6"/>',
    // ⭐ 2026-10-07 新增：机器状态那个小按钮的图标（用户："就用一个小电脑的一个图标就好了"）
    //   一个显示器：屏幕 + 底座 + 支脚。收起态显示它 = "点我展开机器状态"。
    monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7"/><path d="M12 16.5v4"/>'
  };
  function svg(d, s, w) {
    s = s || 16; w = w || 2;
    // ⚠⚠⚠ 2026-10-07 用户报"小电脑图标没加上去"，实测查出来是【svg 被压成 1px 宽】：
    //   只写 width/height 属性时，在 flex 子项里它可能被挤没（实测渲染尺寸 1×13，
    //   属性明明写着 13×13、viewBox 也对、fill/stroke 也正常 ⇒ 什么都看不见）。
    //   ⇒ 这里连【内联样式】一起写上，尺寸就不靠属性推导了（内联样式优先级最高，谁也压不动）。
    //   ⚠ 别只留属性 —— 那样又会回到"看不见的图标"。
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"'
      + ' style="width:' + s + 'px;height:' + s + 'px;flex:none;display:block">' + d + '</svg>';
  }
  function ico(name, s, w) { return svg(P[name] || P.help, s || 16, w || 2); }

  // ══════════════════════════════════════════════════════════════
  //  二级右栏 = 四页导航（不再是档位梯子）
  //  ⚠ 用户 2026-10-04："右边不要放档位啊，就二级大卡不要放档位"
  // ══════════════════════════════════════════════════════════════
  var RAIL = [
    // ⚠⚠ 2026-10-05 用户："你可以看到在标题部分，配置信息，这台配机器能跑什么。然后他说这台机器
    //   能跑到高性能。我觉得这个语义相对来说有点重复。"
    //   ⇒ 副标题【不再说"这台机器能跑什么"】（结论条马上就会说"能跑到高性能"），
    //     改成交代这一页里有什么 —— 两句话各说各的，不再互相复述。
    { id: 'config', name: '配置信息', sub: '机器情况 · 模型文件 · 引擎设置', tier: 0, ico: 'cpu' },
    { id: 'basic',  name: '基础',     sub: '不用装任何东西',   tier: 1, ico: 'cpu' },
    { id: 'expand', name: '拓展',     sub: '下几个模型',       tier: 2, ico: 'gpu' },
    { id: 'high',   name: '高性能',   sub: '要 N 卡',          tier: 3, ico: 'gpu' }
  ];
  function tierOfPage(id) {
    for (var i = 0; i < RAIL.length; i++) if (RAIL[i].id === id) return RAIL[i].tier;
    return 0;
  }
  function pageOfTier(n) {
    for (var i = 0; i < RAIL.length; i++) if (RAIL[i].tier === Number(n)) return RAIL[i].id;
    return 'config';
  }
  function railOf(id) {
    for (var i = 0; i < RAIL.length; i++) if (RAIL[i].id === id) return RAIL[i];
    return RAIL[0];
  }

  // 能力 id → 老的四个分区名（设置项从那三个分区里搬过来，见 ui.html 的
  // enginesCapSettingsHtml / enginesCapSettingsBind）。
  // ⚠ 校色和对齐【共用】align 那一组；三样模型类能力【共用】matting 那一组。
  //   丢了映射的话设置项就静默不出现 —— 属于铁律 15 那类"看得见但改不了"。
  var SETTINGS_KIND = {
    color: 'align', align: 'align', detail: 'detail',
    matting: 'matting', segment: 'matting', sam2: 'matting',
    tween: 'detail', matte: 'matting'
  };

  // 三档怎么分的 —— 问号移上去/点一下给用户看的那段话。
  // ⚠ 只谈"要什么、能得到什么"，不谈"怎么算的"（藏意图）。
  var TIER_HELP = '三档按「要什么才能跑」分：'
    + '基础＝什么都不用装，什么电脑都能跑；'
    + '拓展＝要下几个模型（约 3.9G），不用显卡也能跑，就是慢些；'
    + '高性能＝要有 N 卡，能开最细的那几样。'
    + '点任意一个格子，右边就会告诉你那一样能力要什么。';

  function create(options) {
    options = options || {};
    // ⚠ 回调可平铺传，也可收在 options.host 里 —— 两种形状都要认。
    var host = options.host || options;
    var C = core();

    var state = {
      tier: 1,          // 用户选的档（一级卡上那一列亮的）
      engineTier: 0,    // 引擎实际能给的第几档（0 = 还不知道）
      caps: {},         // 引擎快照
      catalog: null,    // 模型下载清单
      open: false,      // 二级开着没
      zone: 'config',   // 二级当前页（config / basic / expand / high）
      focus: '',        // 从一级格子点进来时要高亮的那一样能力 id
      openCap: '',      // 二级页里【展开着】的那一样能力 id（收起式布局，2026-10-05）
      // ⚠⚠ 2026-10-05 用户："我希望我的引擎状态和性能状态是在顶部折叠的一个情况，
      //   这样它就不用占用太多的一直留存的空间了。" ⇒ 默认【折起来】。
      //   折起来之后内容区多出 ~46px，三档页一屏就能看完。
      //   ⚠ 折起来不等于看不见引擎状态 —— 那一行（点 + 状态 + 主按钮）始终在，
      //     折掉的只是「重新检测」和内存/显卡/核心那几个数。
      topFold: true,
      // ⚠⚠ 2026-10-05 用户："配置信息作为一个单独的页面，你要把用户的详细配置显示出来，
      //   并且这个详细的配置是需要允许折叠和收纳起来的。然后呢，默认是收纳的状态。"
      //   ⇒ 「详细配置」那一块（CPU / 内存 / 显卡 / 显存 / 运行环境）默认【收起来】。
      //   跟 topFold 一样是"折起来省地方"的思路，但两者【互不相干】：
      //     topFold 管的是顶部常驻那条，detailFold 管的是配置页里那一节。
      detailFold: true,
      // ⭐ 2026-10-06 docs/150 §5.1（Phase B）：配置页新增三块的状态。
      //   ⚠ status 是 V7EngineStatus.snapshot()（唯一状态出口）——卡只读它，不许自己再判。
      //   ⚠ 两个折叠默认【收起】：配置页首屏必须一屏（模型列表展开后行数 = catalog 数）。
      status: null,
      modelsFold: true,
      engineFold: true,
      // ⚠⚠ 2026-10-05：`focus` 是【一次性】的（afterPage 滚完就清），
      //   而 `highlight` 是【粘的】—— 它才是能力块上那圈蓝边。
      //   两者必须分开：探针实测抓到"跳过去了、也滚到了，但高亮一闪就没"，
      //   真因就是 reload() 重画时 focus 早被清空，`.focus` 类再也没人打。
      highlight: '',
      openedBy: null,
      used: false,
      busy: null,       // 正在装哪一档
      progress: 0
    };

    var zone = null;
    var face = null;
    var built = false;        // 一级卡结构只建一次
    var firstPaint = true;    // 首帧不播动画
    var pageSeq = 0;
    var perfTimer = 0, perfData = null, perfErr = '';
    // ⚠ 2026-10-07：机器数据那一行的"最近一次数据"。
    //   为了能【就地改文字】而不重建节点（重建会重播入场动画⇒闪），
    //   渲染和"按数据打补丁"要共用同一份结构。
    var lastSpecData = null;

    // ══════════════════════════════════════════════════
    //  数据
    // ══════════════════════════════════════════════════
    function load() {
      if (typeof host.load === 'function') {
        try { return host.load() || {}; } catch (_) { return {}; }
      }
      return {};
    }
    function applyData() {
      var d = load();
      if (d.engine) state.caps = d.engine;
      if (d.catalog) state.catalog = d.catalog;
      // ⭐ Phase B：唯一状态出口的快照（引擎/环境/模型三块都从它来）
      if (d.status) state.status = d.status;
      if (typeof d.tier === 'number') state.tier = d.tier;
      if (C) {
        var t = C.tierFromEngine(state.caps);
        // ⚠ 引擎没探测到（0）时保留用户选的档，不要跳回 0 ——
        //   引擎没起来的时候界面得还能用，不能整张卡变成"不知道"。
        if (t > 0) state.engineTier = t;
      }
    }
    function T(n) { return C ? (C.TIERS[n] || null) : null; }
    // ⭐⭐ 2026-10-18 云端外挂（docs/237，用户原话）：
    //   「在外挂能力卡片的左上角……新建一个和千问的开关一样……云端外挂。如果用户打开了云端外挂之后，
    //     挂载能力里面的和本地相关的部署的内容全部都冻结，变为灰色。然后外挂能力卡片那一栏变为云端的状态，全都启用的状态。」
    //   ⇒ 开着时：一级表亮「高性能」整列、表头都写「云端」；二级里本机引擎 / 环境 / 模型 / 引擎设置整块冻结（灰、点不动），
    //     每样能力的本机启停换成「在云端算」。状态（在线 / 没登录 / 连不上…）由宿主 host.cloud() 给（cloud-tools.js 判，卡不另判）。
    function cloud() { try { return typeof host.cloud === 'function' ? (host.cloud() || null) : null; } catch (_) { return null; } }
    function cloudOn() { var c = cloud(); return !!(c && c.on); }
    var CLOUD_FROZEN_ACTS = { 'start-engine': 1, 'stop-engine': 1, 'restart-engine': 1, install: 1, redownload: 1, 'models-rescan': 1, 'jump-tier': 1 };
    function capsOf(n) { return C ? C.capsInTier(n) : []; }
    function installed(n) { if (cloudOn()) return true; return C ? C.tierInstalled(n, state.caps) : n === 1; }
    function engineDown() {
      if (cloudOn()) return false;   // 云端外挂开着：本机引擎起没起不相干（状态看 host.cloud()）
      if (!C || !C.engineUp) return false;
      // ⚠⚠ 2026-10-06 修：原来这里写的是 `snap.probed===true || snap.available===true` —— 
      //   "探过但没起"（probed:true / available:false）被这个短路当成"不是 down"，
      //   于是档位状态回落成 needShort，用户明明有文件却看到"要下 3.9G"（用户实测报的）。
      //   判据只有一个：引擎实际能力（available / multiCapable / 任一档位 > 0）。
      return !C.engineUp(state.caps || {});
    }
    // ⭐ Phase F：这一档要的模型文件【在不在】（用户 2026-10-06："接到文件检测"）。
    //   数据源 = V7EngineStatus 的模型清单（model_manager catalog 会 stat 每个文件）：
    //     'present' 文件齐 / 'missing' 确实缺 / 'unknown' 清单还没拿到（回落旧逻辑）
    //   ⚠ 只看"文件在不在"，不代表能跑（显存/依赖/引擎在不在是另说）。
    function tierFilesState(n) {
      if (cloudOn()) return 'present';           // 云端：模型都在云端那台机器上
      if (Number(n) === 1) return 'present';   // 1 档是内置算法，永远算"在"
      var models = (state.status && state.status.models) || null;
      if (!models || !models.length) return 'unknown';
      var keys = (C && C.TIER_MODELS && C.TIER_MODELS[n]) || [];
      if (!keys.length) return 'unknown';
      var byKey = {};
      for (var i = 0; i < models.length; i++) byKey[models[i].key] = models[i];
      var have = 0;
      for (var k = 0; k < keys.length; k++) {
        var m = byKey[keys[k]];
        if (!m) return 'missing';                       // 清单里没登记这个模型
        if (m.state === 'ok' || m.state === 'present') have++;
        else if (m.state === 'broken') return 'broken';
        else return 'missing';
      }
      return have === keys.length ? 'present' : 'missing';
    }
    function engineDownText() {
      return '引擎没启动 —— 模型文件都在，不用下载，点上面的「启动引擎」就行';
    }
    // ⭐ Phase F：唯一词典在 V7EngineStatus；卡这边只引用，不另立一套。
    function engineLineText(e) {
      if (GLOBAL.V7EngineStatus && typeof GLOBAL.V7EngineStatus.engineLine === 'function') {
        try { return GLOBAL.V7EngineStatus.engineLine(e); } catch (_) { /* fallthrough */ }
      }
      var map = { down: '未启动', starting: '正在启动…', running: '运行中', 'old-code': '运行中 · 建议重启（程序更新过）', stale: '未响应（正在重查）' };
      return map[(e && e.state) || 'down'] || '未启动';
    }
    // ⭐ Phase F：这一行能力的框色。数据源 = V7EngineStatus 的双引擎快照；
    //   拿不到快照时的兜底：抠像按旧探活判，校色未知按"降级"（宁可黄，不谎绿）。
    function frameOf(capId) {
      if (cloudOn()) {
        var cs = cloud() || {};
        return cs.state === 'ready' ? 'ok' : (cs.state === 'checking' || cs.state === 'reconnecting' || cs.state === 'degraded' || cs.state === 'busy' || cs.state === 'flaky') ? 'degraded' : 'off';
      }
      var engines = state.status && state.status.engines;
      if (engines && C && typeof C.capEngineFrame === 'function') return C.capEngineFrame(capId, engines);
      var which = (C && typeof C.capEngine === 'function') ? C.capEngine(capId) : '';
      if (which === 'match') return 'degraded';
      return (C && C.engineUp && C.engineUp(state.caps)) ? 'ok' : 'off';
    }

    // ══════════════════════════════════════════════════
    //  一级卡面：一张总表（横轴三档 / 纵轴能力）
    // ══════════════════════════════════════════════════
    //
    //  ⚠⚠ 格子里显示的是 `form`（形态名，比如"精确抠"），不是 ✓/✗。
    //     用户 10-04："横轴和纵轴中间，它不一定是勾勾叉叉了，
    //     它可以去再多一个维度的信息。" 一个格子能装一句话，只画个勾等于白扔。
    //
    //  ⚠ 表头【不自己做 grid】—— 单独一行 + 一个 .ec-hrow 装三个档位，
    //     hrow 与数据行共用同一个 CSS 变量 --ec-cols。
    //     这是为了根治"问号绝对定位把三列挤歪"那个坑（见文件头）。

    // 档位格下面那行小字。
    // ⚠⚠ 卡面【绝不许】出现模型名 / PyTorch / 显存 / 文件名（docs/14）。
    //   `need` 是给下载按钮和安装说明用的（"再装 PyTorch + 6.7G 模型"），
    //   卡面只读 `needShort`（"要下 6.7G + N 卡"）。
    //   ⚠ 2026-10-04 探针抓到过一次：卡面把 `need` 直接印上去了，蹦出个 "PyTorch"。
    //     现在两个字段分开，别再图省事用 need。
    function tierStateText(n) {
      var t = T(n) || {};
      if (cloudOn()) return '云端';
      if (Number(n) === 1) return '已就绪';
      // ⭐⭐ 2026-10-06（用户报的 bug）：优先按【文件检测】说 —— 文件在就是"装好了"，
      //   不许再让有文件的人看到"要下 X G"（引擎没起也不再顺口说成缺文件）。
      var files = tierFilesState(n);
      if (files === 'present') return '装好了';
      if (files === 'missing') return t.needShort || '';
      if (files === 'broken') return '文件要修';
      // 清单还没拿到：回落旧逻辑（引擎实际档位 / 引擎在不在）
      if (installed(n)) return '装好了';
      if (engineDown()) return '引擎没起';
      return t.needShort || '';
    }

    function buildFace() {
      if (!face || built) return;
      var stack = face.querySelector('.ec-stack');
      if (!stack) return;

      var all = C ? C.CAPS : [];

      var head = [1, 2, 3].map(function (n) {
        var t = T(n) || {};
        return '<div class="ec-hcell" data-tier="' + n + '">'
          + '<span class="ec-hn">' + esc(t.head || (n + ' 档')) + '</span>'
          + '<span class="ec-hs" data-tier-state="' + n + '"></span>'
          + '</div>';
      }).join('');

      var rows = all.map(function (c) {
        var cells = '';
        for (var n = 1; n <= 3; n++) {
          var form = C && C.capForm ? C.capForm(c, n) : null;
          cells += '<span class="ec-cell' + (form ? '' : ' none') + '"'
            + ' data-cap="' + esc(c.id) + '" data-tier="' + n + '"'
            + (form ? ' role="button" tabindex="0"' : ' aria-disabled="true"')
            + ' title="' + esc(form
                ? (c.name + ' · ' + form + ' ｜ ' + (c.plain || '') + ' ｜ 点一下看这一档要什么')
                : (c.name + ' · ' + (T(n) ? T(n).head : n + ' 档') + '下没有这个能力')) + '">'
            + (form ? esc(form) : svg(P.x, 9, 2.6))
            + '</span>';
        }
        return '<div class="ec-crow" data-cap="' + esc(c.id) + '" title="' + esc(c.name + '　' + (c.plain || '')) + '">'
          // ⭐ Phase F：能力名这一格挂框色（data-cap-frame 标记，syncFace 上色）
          + '<span class="ec-cname" data-cap-frame>' + esc(c.name) + '</span>'
          + cells
          + '</div>';
      }).join('');

      stack.innerHTML =
        '<div class="ec-thead">'
        + '<div class="ec-hint"><span>点格子看这一档要什么</span>'
        + '<button type="button" class="ec-q" data-act="tier-help" aria-label="三档是怎么分的">?</button></div>'
        + '<div class="ec-hrow">' + head + '</div>'
        + '</div>'
        + '<div class="ec-grid">' + rows + '</div>';

      built = true;
    }

    // 只切状态，不重建 DOM（本项目硬规矩）
    function syncFace() {
      if (!face) return;
      paintCloudSwitch();
      var stack = face.querySelector('.ec-stack');
      if (!stack) return;
      // ⭐ 云端外挂开着：亮「高性能」整列（云端那台 4090D 全都跑得动）。⚠ 只是显示，不改用户存的档位 state.tier
      var shownTier = cloudOn() ? 3 : state.tier;
      face.classList.toggle('ec-cloud-on', cloudOn());

      // 1) 表头：选中档那一列亮绿
      var heads = stack.querySelectorAll('.ec-hcell');
      for (var i = 0; i < heads.length; i++) {
        var n = +heads[i].dataset.tier;
        heads[i].classList.toggle('sel', n === shownTier);
        var st = heads[i].querySelector('.ec-hs');
        if (st) {
          var txt = tierStateText(n);
          var files = n === 1 ? 'present' : tierFilesState(n);
          var good = n === 1 || files === 'present' || installed(n);
          st.textContent = txt;
          st.classList.toggle('ok', good && files !== 'broken');
          // 黄字只留给"要用户去处理"的：文件坏了，或清单拿不到又引擎没起
          st.classList.toggle('warn', files === 'broken' || (!good && files === 'unknown' && engineDown()));
        }
      }

      // 2) 数据格：只有当前档那一列亮，另两列压灰（"互斥"的视觉表达）
      var cells = stack.querySelectorAll('.ec-grid .ec-cell');
      for (var j = 0; j < cells.length; j++) {
        cells[j].classList.toggle('sel', +cells[j].dataset.tier === shownTier);
      }

      // 2.5) ⭐ Phase F：能力名那一格 = 框色，代表这行能力的引擎状态：
      //   绿=引擎在跑；黄=校色类没增强（档 1 照常用）；灰=抠像类没起（做不了）。
      var names = stack.querySelectorAll('.ec-grid .ec-cname[data-cap-frame]');
      for (var k = 0; k < names.length; k++) {
        var crow = names[k].closest('.ec-crow');
        var frame = frameOf(crow ? crow.dataset.cap : '');
        names[k].classList.toggle('frame-ok', frame === 'ok');
        names[k].classList.toggle('frame-degraded', frame === 'degraded');
        names[k].classList.toggle('frame-off', frame === 'off');
      }

      // 3) 底栏 —— 只写状态，不写统计
      //   ⚠ 用户 10-04："底栏就不用做统计了，这一眼看穿的图表"。
      //     所以这里【不写 "6/8 样能用"】，只写图上看不出来的那一件事：引擎在不在。
      var foot = document.querySelector('[data-engines-foot]');
      if (foot && !state.busy) {
        var picked = T(state.tier) || { head: '' };
        var real = Number(state.engineTier) || 0;
        if (cloudOn()) {
          foot.textContent = '云端外挂 · ' + ((cloud() || {}).text || '正在连云端…');
        } else if (engineDown()) {
          foot.textContent = '引擎没启动 · 模型都在，不用下载';
        } else if (real > state.tier) {
          foot.textContent = '当前 ' + picked.head + ' · 这台机器能到 ' + (T(real) ? T(real).head : real);
        } else {
          foot.textContent = '当前 ' + picked.head;
        }
      }
    }

    function renderFace() {
      if (!face) return;
      buildFace();
      syncFace();
      firstPaint = false;
    }

    // ⭐ 2026-10-18 云端外挂开关：一级卡左上角，【跟千问那个开关同一个样式】（复用 .ps-crumb-qwen：
    //   跟顶部拖动横条一样高、上下对齐）。宿主没给 host.cloud 就不画（老宿主 / 测试夹具）。
    //   ⚠ 节点只建一次，之后只改文字和 class（本项目硬规矩：常驻结构不重建）。
    function paintCloudSwitch() {
      if (!face || typeof host.cloud !== 'function') return;
      var box = face.querySelector('.ec-cloudsw');
      if (!box) {
        box = document.createElement('div');
        box.className = 'ec-cloudsw';
        box.innerHTML = '<button type="button" class="ps-crumb-qwen ec-cloud-btn" data-cloud-toggle></button>';
        face.appendChild(box);
        var b0 = box.querySelector('button');
        b0.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (typeof host.setCloud === 'function') host.setCloud(!cloudOn());
          else toast('这个版本还没有接上云端外挂');
        });
      }
      var b = box.querySelector('button');
      var on = cloudOn(), c = cloud() || {};
      // ⚠ 开着时文字要短（跟千问「千问 · 开」一样长）：原来「云端外挂 · 开」太长，卡窄时压到中间的拖动横条（10-18 用户实测）
      var text = on ? '云端 · 开' : '云端外挂';
      if (b.textContent !== text) b.textContent = text;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.title = on
        ? ('现在：抠像 / 人体解析 / 指哪抠哪 / 文字找东西 / 细边 / 过渡帧 / 校色都在云端算（' + (c.text || '') + '）。点一下切回本机引擎')
        : '切到云端外挂：上面这些能力全部改到云端 4090D 上算，本机不用装引擎和模型（要登录）';
    }

    function pushStack() {
      if (!face) return;
      var s = face.querySelector('.ec-stack');
      if (!s) return;
      s.style.transition = 'none'; s.style.transform = 'translateY(6px)';
      void s.offsetHeight;
      var go = function () {
        s.style.transition = 'transform var(--m-base) var(--ease-out)';   // ⚠ 原来写 --dur-short，全项目没人定义 ⇒ 一直是瞬间跳（10-22 查出）
        s.style.transform = 'none';
      };
      if (GLOBAL.requestAnimationFrame) GLOBAL.requestAnimationFrame(go); else setTimeout(go, 16);
    }

    // ══════════════════════════════════════════════════
    //  二级卡
    // ══════════════════════════════════════════════════
    function mountZone() {
      if (!zone || zone.dataset.mounted === '1') return;
      zone.dataset.mounted = '1';
      // ⚠⚠ 顶部那块（机器配置 + 引擎状态）必须在【.rs-page 之外】——
      //   它是常驻的，换页动画只滑 .tp（在 .rs-page 里），它要一直看得见。
      zone.innerHTML = '<div class="rc-main">'
        + '<div class="rc-top" data-rc-top></div>'
        + '<div class="rc-left"><div class="rs-page"></div></div>'
        + '</div>'
        + '<div class="rc-rail zcard"><div class="z-glow"></div><div class="z-bright"></div><div class="rail-in"></div></div>';
      paintTop();
      bindZone();
    }

    // 只重画顶部那一条 —— ⚠ 不动整页（否则页内滚动位置和输入框焦点全丢）。
    // ⚠⚠⚠ 2026-10-07 用户实测："它现在是粗暴的向下直接变大，然后遮挡下面的内容，然后有闪烁。"
    //   真因：以前折叠 = 【整块 replaceWith 一个新节点】——
    //     ① 新节点没有"从折叠到展开"的过程，高度直接到位 ⇒ 看着就是"瞬间向下变大"；
    //     ② 那一行上带着 animation:etRowIn ⇒ 每次折叠/展开都重播一次，观感是"闪"。
    //   ⇒ 现在：只用 class 切换状态（.rc-top.folded + .topped），
    //     高度/内边距/那一行的收起全部交给 CSS transition 做（见 engines-card.css）。
    //     ⚠ 别再改回整块重建 —— 那样 CSS 过渡永远播不出来。
    function paintTop(opts) {
      if (!zone) return;
      var top = zone.querySelector('[data-rc-top]');
      if (!top) return;
      // ⚠⚠⚠ 2026-10-07 我自己在这踩过一脚：mountZone() 建的是一个【空壳】
      //   `<div class="rc-top" data-rc-top></div>`（内容是这里填的）。
      //   我改成"只切 class"之后忘了填内容 ⇒ 顶条永远是 0 子节点、高度 14px、
      //   那一行不存在、点折叠直接报 null。⇒ 空壳时先【就地填内容】（不换节点，省得后面误判 wasFolded）。
      var folded = !!state.topFold;
      var wasFolded = top.classList.contains('folded');
      if (!top.children.length) {
        // ⚠ perfTopHtml() 返回的是【整个 .rc-top】——不能把它塞进壳里（会套娃：rc-top 里又一层 rc-top，
        //   高度变成两份）。这里只取里面的内容填进壳，class 也照它同步。
        var wrap0 = document.createElement('div');
        wrap0.innerHTML = perfTopHtml();
        var fresh = wrap0.firstElementChild;
        if (fresh) {
          top.innerHTML = fresh.innerHTML;
          top.className = fresh.className;
        }
        top.classList.toggle('folded', folded);
        wasFolded = folded;    // 刚建出来不算"用户刚展开"，别播入场动画
      }
      top.classList.toggle('folded', folded);
      var btn = top.querySelector('.topfold');
      if (btn) {
        btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
        btn.title = folded ? '展开机器状态' : '收起机器状态';
        var box = btn.querySelector('svg');
        // ⚠ 图标要跟状态一致：收起态 = 小电脑（可以点开），展开态 = 向上箭头（可以收起）。
        //   见 perfTopHtml 里那条注释：用户报过"收起态是个没有按钮的状态"。
        if (box) box.outerHTML = ico(folded ? 'monitor' : 'arrowUp', folded ? 13 : 12, folded ? 2 : 2.4);
      }
      // ⚠ "刚展开"这个标记（.topped）只用来播【一次】入场动画。
      //   判据 = wasFolded（上一次是折叠的，这一次不是）—— 也就是"用户刚点了展开"。
      //   ⚠ 播完必须摘掉：留着的话下次数据刷新时元素还在动画状态，又会变成闪。
      //   ⚠ 首帧挂载【不播】：卡片刚出来时整条一起出现，单独给这一行动画反而突兀。
      if (folded) {
        top.classList.remove('topped');
      } else if (wasFolded) {
        top.classList.add('topped');
        if (!(opts && opts.keepTopped)) {
          setTimeout(function () { if (top) top.classList.remove('topped'); }, 280);
        }
      }
      patchSpec(top);       // 数据那份也顺手对齐一次（省得展开后显示旧数）
      layoutTop();
    }

    // 顶部占多高 → 让内容区让出来。
    // ⚠ 用实际量到的高度写 CSS 变量，不写死像素 —— 内存/显存行数会变（没 N 卡少一行）。
    function layoutTop() {
      if (!zone) return;
      var top = zone.querySelector('[data-rc-top]');
      if (!top) return;
      var h = Math.round(top.getBoundingClientRect().height) || 0;
      if (h > 0) zone.style.setProperty('--rc-top-h', h + 'px');
    }


    function renderRail() {
      if (!zone) return;
      var box = zone.querySelector('.rail-in');
      if (!box) return;
      var down = engineDown();
      var nodes = RAIL.map(function (r) {
        var on = state.zone === r.id;
        var mark = '';
        if (cloudOn()) {
          // 云端外挂开着：每一页都是「云端」（配置页看云端在不在线）
          var cs = cloud() || {};
          mark = (r.tier === 0 && cs.state !== 'ready')
            ? '<em class="miss">' + ico('warn', 9, 2.4) + esc(cs.state === 'checking' ? '连接中' : cs.state === 'reconnecting' ? '重连中' : '云端不通') + '</em>'
            : '<em class="got">' + svg(P.check, 9, 3.4) + '云端</em>';
        } else if (r.tier === 0) {
          mark = down ? '<em class="miss">引擎没起</em>'
            : '<em class="got">' + svg(P.check, 9, 3.4) + '在线</em>';
        } else {
          // ⭐ 文件检测优先：文件在 = 装好了（引擎没起不在这一格重复说，状态条/顶栏在说）
          var tfiles = tierFilesState(r.tier);
          var ok = tfiles === 'present' || (tfiles === 'unknown' && installed(r.tier));
          if (ok) mark = '<em class="got">' + svg(P.check, 9, 3.4) + '装好了</em>';
          else if (tfiles === 'missing' || tfiles === 'broken') {
            mark = '<em class="miss">' + ico('download', 9, 2.6) + esc(C ? (C.tierMissing(r.tier, state.caps) || (T(r.tier) || {}).needShort || '要装') : '要装') + '</em>';
          } else {
            mark = down ? '<em class="miss off">' + ico('warn', 9, 2.4) + '引擎没起</em>'
                        : '<em class="miss">' + ico('download', 9, 2.6) + esc(C ? (C.tierMissing(r.tier, state.caps) || (T(r.tier) || {}).needShort || '要装') : '要装') + '</em>';
          }
        }
        return '<div class="tabn tiern' + (on ? ' sel' : '') + '" data-page="' + r.id + '"'
          + ' role="button" tabindex="0" title="' + esc(r.name + ' · ' + r.sub) + '">'
          + '<i></i><span class="tt">' + esc(r.name) + '<b>' + esc(r.sub) + '</b>' + mark + '</span></div>';
      }).join('');
      var fp = C ? C.footprint(state.tier, state.caps) : { disk: 0, gpuText: '' };
      // ⭐ 2026-10-18 云端外挂：本机不占地方、不要显卡（原来那句「当前档占 10.6G · 要 N 卡」在云端模式下是错的）
      var footHtml = cloudOn()
        ? '<span>云端算 · 本机不占空间</span><span>不要显卡</span>'
        : '<span>当前档占 ' + fp.disk + 'G</span><span>' + esc(fp.gpuText) + '</span>';
      box.innerHTML = '<div class="rail-head">能开的<small>' + (RAIL.findIndex(function (r) { return r.id === state.zone; }) + 1) + ' / ' + RAIL.length + '</small></div>'
        + '<div class="rail-list"><div class="rail-nodes">' + nodes + '</div></div>'
        + '<div class="rail-foot">' + footHtml + '</div>';
    }

    // ── 二级通用零件 ──
    function sec(cls, title, note, inner) {
      return '<div class="sec ' + cls + '"><div class="sec-h"><h4>' + esc(title) + '</h4><em>' + esc(note) + '</em></div>' + inner + '</div>';
    }
    function row(l, s, right) {
      return '<div class="row"><span class="rl"><b>' + l + '</b>' + (s ? '<small>' + s + '</small>' : '') + '</span>'
        + (right ? '<span class="rc">' + right + '</span>' : '') + '</div>';
    }

    // ════ 顶部：机器 + 引擎状态（所有页都看得到）════
    //  ⚠ 数据来自宿主 host.perfSample()（Tauri 的 perf_sample）。
    //   ⚠⚠ 显卡那部分【只支持 N 卡】（走 NVML），不是 N 卡要如实说"没检测到 N 卡"，
    //     不许编数字 —— 这是本项目对"假信息"的一贯态度。
    //
    // ⚠⚠⚠ 2026-10-05 重做（用户两条原话）：
    //   ① "我希望我的引擎状态和性能状态是在顶部折叠的一个情况，这样它就不用占用太多的
    //      一直留存的空间了。" ⇒ 折起来只剩【一行 30px】：点 + 状态 + 主按钮 + 展开箭头。
    //      折掉的是「重新检测」和内存/显卡/核心那几个数。
    //   ② "顶部的引擎在跑和性能监看其实可以摆成横排的，这样更省空间。"
    //      ⇒ 展开时【引擎状态和机器数据左右并排】，不是上下堆。
    //   ③ "它右侧有一定的空位，这个空位和最右边的那个四个大选项没有对齐"
    //      ⇒ 顶条原来只有 416 宽（缩在左半区里），而右栏从 432 起。
    //        现在顶条【横跨整宽 540】，右内边距跟右栏节点对齐（见 CSS 的 .rc-top）。
    function perfTopHtml() {
      var p = perfData;
      var down = engineDown();
      var folded = state.topFold;

      // ① 引擎状态那一行（折叠时只留这一行）
      // ⭐ 2026-10-18：云端外挂开着时，这一行说的是【云端】（本机引擎不相干，也不给启停按钮）
      var cs = cloudOn() ? (cloud() || {}) : null;
      var eng = cs
        ? '<span class="edot' + (cs.state === 'ready' ? ' ok' : '') + '"></span>'
          + '<span class="etx"><b>云端外挂</b>' + (folded ? '' : '<small>' + esc(cs.text || '正在连云端…') + '</small>') + '</span>'
          + '<button class="ect btn" data-act="cloud-check">' + ico('refresh', 11, 2.4) + '重新检测</button>'
        : '<span class="edot' + (down ? '' : ' ok') + '"></span>'
        + '<span class="etx">'
        + (down ? '<b>引擎没启动</b>' : '<b>引擎在跑</b>')
        + (folded ? '' : '<small>' + esc(down
            ? '模型都在，不用下载 —— 点「启动引擎」就行'
            : engineShort(state.caps)) + '</small>')
        + '</span>'
        + (down
          ? '<button class="ect btn pri" data-act="start-engine">' + ico('play', 11, 2.4) + '启动引擎</button>'
          : '<button class="ect btn" data-act="stop-engine">' + ico('stop', 10, 2.4) + '停止</button>')
        + (folded ? '' : '<button class="ect btn" data-act="probe">' + ico('refresh', 11, 2.4) + '重新检测</button>');

      // ② 机器数据（只在展开时出现）
      // ⚠⚠⚠ 2026-10-07 用户实测三连（"闪 / 粗暴向下变大 / 文字每次刷新都刷新一下"）后重做：
      //   ① 以前这里【只有展开时才渲染那一行】（folded 时整块不渲染）。
      //      后果：折叠 = 节点突然出现/消失，没有任何过渡 ⇒ 用户说的"粗暴地向下直接变大、遮挡下面的内容"。
      //   ② 更糟的是 tickPerf 每 1.5 秒把【整条】top.replaceWith(新节点)，
      //      而 .specline 上带着 animation:etRowIn ⇒ **每 1.5 秒重播一次淡入+上滑**：
      //      这就是"机器状态每刷新一下、显示的文字也会闪一下"。
      //   ⇒ 现在：这一行【常驻在 DOM 里】，折叠与否交给 CSS（.folded 收起：max-height+opacity 过渡）；
      //     数据变化只【就地改文字/进度条】，不重建节点 ⇒ 不重播动画、不闪。
      //     ⚠ 别改回"folded 时不渲染"：那样折叠只能是硬跳，用户已经否掉了。
      var specData = specDataOf(p);
      var specLine = specLineHtml(specData);
      lastSpecData = specData;   // 给 patchSpec（数据刷新时"就地改"）用

      // ⚠ 收展按钮：一个 24px 的方形小按钮，箭头随状态翻。
      //   它必须【永远在】—— 否则折起来之后用户没地方展开（入口要幂等，铁律 26 那类）。
      // ⚠ 收展按钮：一个 24px 的方形小按钮。
      //   ⚠⚠ 2026-10-07 用户："现在把展开机器状态的按钮加进去，它现在是一个没有按钮的状态，
      //     就用一个小电脑的一个图标就好了。" —— 原来收起态那个箭头画不出来（看着就是个空按钮）。
      //   ⇒ 收起态显示【小电脑（显示器）】图标 = "机器状态，点我展开"；
      //     展开态显示【向上箭头】= "收起"。
      //   ⚠ 它必须【永远在】—— 否则折起来之后用户没地方展开（入口要幂等，铁律 26 那类）。
      var toggle = '<button type="button" class="ect btn topfold" data-act="top-fold"'
        + ' aria-expanded="' + (folded ? 'false' : 'true') + '"'
        + ' title="' + (folded ? '展开机器状态' : '收起机器状态') + '">'
        + (folded ? ico('monitor', 13, 2) : ico('arrowUp', 12, 2.4)) + '</button>';

      // ⚠ 横排（用户要的"摆成横排"）：引擎一行 + 机器数据一行并排；
      //   折起来时只有引擎那一行，机器那一行整块不渲染（不是隐藏 —— 不渲染才真省地方）。
      return '<div class="rc-top' + (folded ? ' folded' : '') + '">'
        + '<div class="trow">'
        + '<div class="engline">' + eng + '</div>'
        + toggle
        + '</div>'
        + specLine
        + '</div>';
    }

    // 机器数据 → 一份"数据"（不碰 HTML）。
    // ⚠ 渲染（specLineHtml/patchSpec）和数据刷新（tickPerf）必须共用这一份口径，
    //   否则两处各算一遍、迟早不一致。
    function specDataOf(p) {
      if (!p) return { dim: true, text: '还没读到这台机器的信息' + (perfErr ? '（' + perfErr + '）' : '') };
      var bits = [];
      if (p.system && Number(p.system.memTotalMB) > 0) {
        bits.push({ chip: 'memory', k: '内存', v: fmtGB(p.system.memUsedMB) + ' / ' + fmtGB(p.system.memTotalMB),
          pct: Math.round(Number(p.system.memUsedMB) / Number(p.system.memTotalMB) * 100) });
      }
      if (p.gpu && p.gpu.supported) {
        var gpuTxt = p.gpu.name || 'NVIDIA';
        if (Number(p.gpu.memTotalMB) > 0) gpuTxt = fmtGB(p.gpu.memUsedMB) + ' / ' + fmtGB(p.gpu.memTotalMB);
        bits.push({ chip: 'gpu', k: '显卡', v: gpuTxt,
          pct: Number(p.gpu.memTotalMB) > 0 ? Math.round(Number(p.gpu.memUsedMB) / Number(p.gpu.memTotalMB) * 100) : 0,
          x: p.gpu.utilPercent });
      } else {
        bits.push({ chip: 'gpu', k: '显卡', v: (p.gpu && p.gpu.reason) || '没检测到 N 卡', pct: null });
      }
      if (p.system && p.system.cores) {
        var cpuPct = p.process ? (p.process.cpuPercent || 0) : 0;
        bits.push({ chip: 'cpu', k: '占用', v: cpuPct + '%', pct: cpuPct });
      }
      return { dim: false, bits: bits };
    }

    // 机器数据那一行的阶段 1：把【数据】渲染成 HTML（不碰 DOM）。
    // ⚠ 为什么单独抽出来：数据刷新时要用同一套结构【就地改】现有节点（见 patchSpec），
    //   不能再走"整块 innerHTML 重建"——那会重播 .specline 的入场动画，就是用户看到的"闪"。
    function specLineHtml(d) {
      if (!d) return '<div class="specline dim"></div>';
      if (d.dim) return '<div class="specline dim">' + esc(d.text) + '</div>';
      return '<div class="specline" data-spec="' + esc(JSON.stringify(d.bits)) + '">'
        + d.bits.map(function (b) { return specChipHtml(b); }).join('') + '</div>';
    }
    function specChipHtml(b) {
      return '<span class="specchip" data-chip="' + b.chip + '">'
        + '<span class="sc-i">' + ico(b.chip, 11, 2) + '</span>'
        + '<span class="sc-k">' + esc(b.k) + '</span>'
        + '<span class="sc-v">' + esc(b.v) + '</span>'
        + (b.pct != null && isFinite(b.pct)
            ? '<span class="sc-bar"><i style="width:' + Math.max(0, Math.min(100, b.pct)) + '%"></i></span>'
            : '')
        + (b.x != null ? '<span class="sc-x">' + Math.round(Number(b.x) || 0) + '%</span>' : '')
        + '</span>';
    }

    // 机器数据那一行的阶段 2：按新数据【就地改】现有节点。
    // ⚠ 只动"变了的那几处文字"和进度条宽度；节点本身不换 ⇒ 不重播动画、不闪、不丢 hover/focus。
    // ⚠ 结构对不上时（比如从"内存/显卡/占用"变成"显卡/占用"）才整体重画那一行 —— 这种情况很少见。
    function patchSpec(top) {
      if (!top) return;
      var line = top.querySelector('.specline');
      if (!line) return;
      var d = lastSpecData;
      if (!d) return;
      if (d.dim) {
        if (line.getAttribute('data-spec') || !line.classList.contains('dim')) {
          line.classList.add('dim'); line.removeAttribute('data-spec');
          line.textContent = d.text;
        } else if (line.textContent !== d.text) {
          line.textContent = d.text;
        }
        return;
      }
      var old = [];
      try { old = JSON.parse(line.getAttribute('data-spec') || '[]'); } catch (e) { old = []; }
      var sameShape = old.length === d.bits.length && old.every(function (b, i) { return b.chip === d.bits[i].chip; });
      if (!sameShape) {
        // 结构变了：只重画这一行（保留 .specline 节点，避免整条顶栏重建）
        var wrap = document.createElement('div');
        wrap.innerHTML = specLineHtml(d);
        var nu = wrap.firstElementChild;
        if (nu) line.replaceWith(nu);
        layoutTop();
        return;
      }
      line.classList.remove('dim');
      line.setAttribute('data-spec', JSON.stringify(d.bits));
      var chips = line.querySelectorAll('.specchip');
      for (var i = 0; i < d.bits.length; i++) {
        var b = d.bits[i], el = chips[i];
        if (!el) continue;
        var vEl = el.querySelector('.sc-v');
        if (vEl && vEl.textContent !== b.v) vEl.textContent = b.v;
        var bar = el.querySelector('.sc-bar > i');
        if (bar && b.pct != null && isFinite(b.pct)) {
          var w = Math.max(0, Math.min(100, b.pct)) + '%';
          if (bar.style.width !== w) bar.style.width = w;   // ⚠ 只改宽度 ⇒ CSS 的 transition 会平滑跟过去
        }
      }
    }

    // ⚠ 2026-10-07：老的 specChip(iconName,label,value,pct,extra) 已并入 specChipHtml(b)（上面）——
    //   统一的入口只有一个，免得两处各自拼 HTML、以后改样式漏一处。
    function engineShort(snap) {
      if (!snap) return '';
      var d = C && C.computeDevice ? C.computeDevice(snap) : null;
      var dev = (d && d.known) ? (d.onCpu ? '用 CPU 算' : '用显卡算') : '';
      var tier = T(state.engineTier);
      return [dev, tier ? ('能到 ' + tier.head) : ''].filter(Boolean).join(' · ') || '已就绪';
    }
    function fmtGB(mb) {
      var n = Number(mb) || 0;
      if (n <= 0) return '—';
      if (n < 1024) return Math.round(n) + 'M';
      return (Math.round(n / 1024 * 10) / 10) + 'G';
    }
    function barRow(iconName, label, used, total, extra) {
      var u = parseFloat(used) || 0, t = parseFloat(total) || 0;
      var pct = t > 0 ? Math.max(0, Math.min(100, Math.round(u / t * 100))) : 0;
      return '<div class="specrow"><span class="sk">' + ico(iconName, 11, 2) + esc(label) + '</span>'
        + '<span class="sv"><b>' + esc(used) + '</b> <span class="dim">/ ' + esc(total) + '</span></span>'
        + (extra != null ? '<em class="sutil">' + Math.round(Number(extra) || 0) + '%</em>' : '')
        + '<span class="sbar"><i style="width:' + pct + '%"></i></span></div>';
    }

    // ════ 页 1：配置信息 ════
    //
    // ⚠⚠⚠ 2026-10-05 整页重写（用户："你现在还是留了大量的专有名词和要滚动的内容"）。
    //   探针实测：这一页内容 808px、可视只有 291px —— 要滚 1.8 屏，而且滚出来的
    //   全是 Python / onnxruntime / DirectML / torch 这种【运行时名字】。
    //   那些是排查用的，不是给用户看的（docs/14 + 用户 10-04"藏意图"那条）。
    //
    //   现在这一页只回答一件事：**这台机器能跑到哪一档、占多大地方、引擎开关在哪**。
    //     · 探测细节（那几个运行时名字）→ 只留在报错详情里，界面不印
    //     · "三档各要什么"那张表 → 删掉。一级卡面就是那张表，二级再印一遍是重复
    //     · 机器配置 / 内存 / 显卡 → 顶部那条常驻状态已经有了，这页不重复
    //     · 四个 sec() 标题（"这台机器"/"加速引擎"/…）→ 全删。
    //       探针实测这四个标题自己就占 116px，而每一块的内容本来一句话就说清了 ——
    //       标题反而在替用户重复"这是这一档、这是引擎"，纯占地方。
    //   ⇒ 目标：一屏看完，不用滚（实测 291/291）。
    function configPage() {
      var probe = state.caps || {};
      var dev = C && C.computeDevice ? C.computeDevice(probe) : { known: false };
      var real = Number(state.engineTier) || 0;
      var shown = real > 0 ? real : state.tier;
      var t = T(shown) || {};
      var p = perfData;
      // ⭐⭐ 2026-10-06 docs/150 §5.1：配置页的数据源 = V7EngineStatus（唯一出口）。
      //   ⚠ 引擎/环境/模型三块全都读它，卡这边不许自己再判一遍（§9.2）。
      var S = state.status || {};
      var eng = S.engine || {};
      var modelsList = Array.isArray(S.models) ? S.models : [];

      // ① 结论条。⭐ 2026-10-05 用户："配置信息，这台配机器能跑什么。然后他说这台机器能跑到高性能。
      //   我觉得这个语义相对来说有点重复。"
      //   ⇒ 页头副标题（RAIL 的 sub）原来写着"这台机器能跑什么"，结论条又写"这台机器能跑到 X"
      //     —— 同一句话说两遍。现在：**页头只报栏目名，结论条只报结论**，
      //     而且结论条下面那句改成【为什么是这个结论】，不再复述副标题。
      var why = probe.available === true
        ? (dev.known ? dev.detail : '')
        : '';
      if (!why) {
        why = probe.available === true
          ? ('这一档要的东西' + (installed(shown) ? '都齐了' : '还没齐，见下面「模型文件」'))
          : '还没检测过引擎 —— 点上面「启动引擎」，检测完这里会自己更新。';
      }
      var verdict = '<div class="verdict">'
        + '<span class="vd-i">' + ico(t.ico || 'cpu', 16, 2) + '</span>'
        + '<span class="vd-t"><b>这台机器能跑到「' + esc(t.head || '还没测出来') + '」</b>'
        + '<small>' + esc(why) + '</small></span>'
        + '</div>';

      // ② ⭐ 状态条 [data-engine-status]（docs/150 §5.1；Phase F 起是【两台引擎各一行】）
      //   按钮词表：启动 / 重启 / 停止 / 重新检测（§二）。启停各管各的，谁都不连坐。
      var ebtn = function (act, which, cls, html) {
        return '<button type="button" class="ect btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-engine-which="' + which + '">' + html + '</button>';
      };
      var engineRow = function (which, label) {
        var e = (S.engines && S.engines[which]) || (which === 'matting' ? eng : null) || {};
        var run = e.state === 'running' || e.state === 'old-code';
        var canStart = e.state === 'down' || e.state === 'stale';
        var acts = canStart
          ? ebtn('start-engine', which, 'pri', ico('play', 11, 2.4) + '启动')
          : (run
              ? ebtn('restart-engine', which, '', ico('refresh', 11, 2.4) + '重启') + ebtn('stop-engine', which, '', ico('stop', 10, 2.4) + '停止')
              : ebtn('probe', which, '', ico('refresh', 11, 2.4) + '重新检测'));
        return '<div class="engline2' + (run ? ' on' : '') + '">'
          + '<span class="edot' + (run ? ' ok' : '') + '"></span>'
          + '<span class="estx"><b>' + esc(label) + '</b><i>' + esc(engineLineText(e)) + '</i>'
          + (e.version ? '<small>v' + esc(e.version) + '</small>' : '') + '</span>'
          + '<span class="eacts">' + acts + '</span></div>';
      };
      var statusRow = '<div class="engstatus" data-engine-status>'
        + engineRow('match', '校色引擎') + engineRow('matting', '外挂引擎') + '</div>';

      // ③ ⭐ 环境行 [data-env-row]（核心 / 加速档 + 一个动作按钮；内容由 V7EngineEnvironment 画）
      var envRow = '<div class="envwrap" data-env-row>'
        + (GLOBAL.V7EngineEnvironment ? GLOBAL.V7EngineEnvironment.markup() : '<div data-engine-env></div>')
        + '</div>';

      // ② ⭐⭐ 详细配置（用户 10-05："你要把用户的详细配置显示出来，并且这个详细的配置
      //   是需要允许折叠和收纳起来的。然后呢，默认是收纳的状态。"）
      //   ⚠ 收起来时【只留一行标题 + 箭头】，一个数据都不印 —— 这才是"收纳"。
      //   ⚠ 展开的内容分两类，别混着排：
      //     · 机器本身（处理器/内存/显卡/显存）—— 来自 host.perfSample()
      //     · 怎么算的（用显卡还是用处理器）—— 来自引擎的探测，是"这台机器实际在用什么"
      var detailRows = [];
      if (p && p.system && Number(p.system.memTotalMB) > 0) {
        detailRows.push(['内存', fmtGB(p.system.memUsedMB) + ' / ' + fmtGB(p.system.memTotalMB)]);
      }
      if (p && p.system && p.system.cores) {
        detailRows.push(['处理器', p.system.cores + ' 核']);
      }
      if (p && p.gpu && p.gpu.supported) {
        detailRows.push(['显卡', String(p.gpu.name || 'NVIDIA')
          + (Number(p.gpu.memTotalMB) > 0 ? '　' + fmtGB(p.gpu.memUsedMB) + ' / ' + fmtGB(p.gpu.memTotalMB) : '')]);
      } else {
        detailRows.push(['显卡', (p && p.gpu && p.gpu.reason) || '没检测到 N 卡']);
      }
      if (dev.known) {
        detailRows.push(['运算方式', dev.onCpu
          ? '用处理器算 —— 能跑，但慢一些'
          : '用显卡算']);
      } else {
        detailRows.push(['运算方式', '引擎没启动，还看不出来']);
      }
      // ⚠ 运行环境那几样（Python / 加速库 / 显卡加速 / PyTorch）【收在折叠区里】——
      //   它们是排查用的，用户平时不用看（用户 10-04"藏意图"那条 + 本项目"机制词只进日志"）。
      //   收起来之后这一页默认是干净的，需要排查时展开就能看全。
      if (probe.available === true) {
        if (probe.python) detailRows.push(['运行环境', String(probe.python)]);
        detailRows.push(['加速库', String(probe.onnx || '没有')]);
        detailRows.push(['显卡加速', String(probe.dml || '没有')]);
        detailRows.push(['图像计算库', String(probe.torch || '没有')]);
        if (probe.vramGB) detailRows.push(['显存', Number(probe.vramGB) + ' G']);
      }
      var detailBody = detailRows.length
        ? '<div class="kvlist">' + detailRows.map(function (r) {
            return '<div class="kv"><span class="kv-k">' + esc(r[0]) + '</span><span class="kv-v">' + esc(r[1]) + '</span></div>';
          }).join('') + '</div>'
        : '<div class="hintline">' + ico('warn', 11, 2) + '<span>还没读到这台机器的信息'
          + (perfErr ? '（' + esc(perfErr) + '）' : '') + '。</span></div>';
      var detail = '<div class="fold' + (state.detailFold ? '' : ' open') + '" data-fold="detail">'
        + '<button type="button" class="fold-h" data-act="detail-fold" aria-expanded="' + (state.detailFold ? 'false' : 'true') + '">'
        + '<span class="fold-t">详细配置</span>'
        + '<span class="fold-x">' + (state.detailFold ? ico('arrowDown', 12, 2.4) : ico('arrowUp', 12, 2.4)) + '</span>'
        + '</button>'
        + (state.detailFold ? '' : '<div class="fold-b">' + detailBody + '</div>')
        + '</div>';

      // ④ ⭐ 模型行 [data-models-summary] + 折叠列表（docs/150 §5.1）
      //   摘要 = N/M 可用 + 当前这一档缺什么；列表默认收起，展开后是 V7EngineModels 的行。
      //   ⚠ 清单拿不到时【明说拿不到】，不许装作"没有模型"（本项目对假信息的一贯态度）。
      var msTotal = modelsList.length, msOk = 0, msPresent = 0;
      for (var mi = 0; mi < modelsList.length; mi++) {
        if (modelsList[mi].state === 'ok') msOk++;
        else if (modelsList[mi].state === 'present') msPresent++;
      }
      var msMissing = (C && C.tierMissing) ? C.tierMissing(state.tier, state.caps) : '';
      var msText;
      if (S.catalogOk === false) msText = '拿不到清单（不代表没有）—— 点「重新扫描」再试';
      else if (!msTotal) msText = '还没读到模型清单';
      else if (probe.available !== true) msText = (msOk + msPresent) + '/' + msTotal + ' 个文件在（引擎没起 · 未测试）';
      else msText = msOk + '/' + msTotal + ' 可用' + (msPresent ? ' · ' + msPresent + ' 个未测试' : '') + (msMissing ? ' · ' + msMissing : ' · 当前这一档要的齐了');
      var modelsOpen = state.modelsFold !== true;
      var models = '<div class="sec modelsec">'
        + '<div class="mrow-head" data-models-summary>'
        + '<span class="mh-k">模型文件</span><span class="mh-v">' + esc(msText) + '</span>'
        + '<span class="mh-acts">'
        + '<button type="button" class="ect btn" data-act="models-fold">' + (modelsOpen ? '收起' : '查看') + '</button>'
        + '<button type="button" class="ect btn" data-act="models-rescan">重新扫描</button>'
        + '</span></div>'
        + '<div class="mlist" data-models-list' + (modelsOpen ? '' : ' hidden') + '>'
        + (GLOBAL.V7EngineModels ? GLOBAL.V7EngineModels.markup() : '<div data-engine-models></div>')
        + '</div></div>';

      // ⑤ ⭐ 引擎设置（折叠，docs/150 §5.1）。控件仍在 DOM 里（隐藏不移除）——
      //   main-card-shortcuts 的全文档 [data-setting] 回填照常找得到（§三-1）。
      var engineSettings = '';
      if (typeof host.settingsFor === 'function') {
        var got = null;
        try { got = host.settingsFor('engine', { noBox: true }); } catch (_) { got = null; }
        if (got && got.html) engineSettings = '<div class="ec-settings" data-ec-settings="engine">' + got.html + '</div>';
      }
      var engineOpen = state.engineFold !== true;
      var settingsSec = '<div class="fold' + (engineOpen ? ' open' : '') + '" data-fold="engine">'
        + '<button type="button" class="fold-h" data-act="engine-fold" aria-expanded="' + (engineOpen ? 'true' : 'false') + '">'
        + '<span class="fold-t">引擎设置</span>'
        + '<span class="fold-x">' + (engineOpen ? ico('arrowUp', 12, 2.4) : ico('arrowDown', 12, 2.4)) + '</span>'
        + '</button>'
        + '<div class="fold-b"' + (engineOpen ? '' : ' hidden') + '>'
        + (engineSettings || '<div class="hintline">' + ico('warn', 11, 2) + '<span>这个版本还没有引擎开关。</span></div>')
        + '</div></div>';

      // ⑤ DLSS 不在这三档梯子上（用户 10-01 定：授权还悬着，单独放）。
      var dlss = row('<b>DLSS 画质增强</b>', '单独的东西，不占这三档',
        '<button class="ect btn" data-act="dlss">去了解</button>');

      // ⭐⭐ 2026-10-18 云端外挂开着：顶上一块「云端」结论 + 两个按钮；本机那几块（引擎 / 环境 / 模型 / 引擎设置）整块冻结。
      //   ⚠ 冻结 = 还在、看得见、点不动（灰）。不删 —— 用户关掉云端时要原样回来，而且「本机装了什么」照样值得看一眼。
      //   ⚠ 机器的详细配置（内存 / 显卡）不冻：那不是部署，是这台电脑本身。
      if (cloudOn()) {
        var cs = cloud() || {};
        var ok = cs.state === 'ready';
        var cloudVerdict = '<div class="verdict ec-cloud-verdict' + (ok ? ' ok' : '') + '">'
          + '<span class="vd-i">' + ico(ok ? 'check' : 'warn', 16, 2) + '</span>'
          + '<span class="vd-t"><b>' + (ok ? '云端外挂已开 · 全部能力都能用' : '云端外挂已开') + '</b>'
          + '<small>' + esc(cs.text || '正在连云端…') + '</small></span>'
          + '</div>'
          + '<div class="row ec-cloud-acts"><span class="rl"><b>云端 4090D</b><small>抠像、人体解析、指哪抠哪、文字找东西、细边、过渡帧、校色都在云端算；图片直接在你的电脑和云端之间传</small></span>'
          + '<span class="rc"><button type="button" class="ect btn" data-act="cloud-check">' + ico('refresh', 11, 2.4) + '重新检测</button>'
          + '<button type="button" class="ect btn" data-act="cloud-off">改用本机引擎</button></span></div>';
        var frozenNote = '<div class="ec-frozen-note">' + ico('warn', 11, 2) + '<span>云端外挂开着：下面这些本机的引擎 / 环境 / 模型都不用管。要用本机，先关掉左上角的「云端外挂」。</span></div>';
        return cloudVerdict + detail + frozenNote
          + '<div class="ec-local-frozen" aria-disabled="true" inert>' + statusRow + envRow + models + settingsSec + '</div>' + dlss;
      }

      return verdict + statusRow + envRow + detail + models + settingsSec + dlss;
    }

    // ════ 页 2~4：三档能力 ════
    function tierPage(n) {
      var t = T(n) || {};
      if (cloudOn()) {
        // ⭐ 2026-10-18 云端外挂：这一档的能力都在云端算，不用装、不用开引擎
        var cs0 = cloud() || {};
        var ok0 = cs0.state === 'ready';
        var bannerC = '<div class="tbanner' + (ok0 ? ' has' : ' err') + '">'
          + '<span class="tbn">' + (ok0 ? svg(P.check, 12, 3) + '云端' : ico('warn', 12, 2.4) + '云端') + '</span>'
          + '<span class="tbt">' + esc(ok0 ? '云端外挂开着 —— 这一档的能力都在云端算，不用装、不用开引擎' : (cs0.text || '正在连云端…')) + '</span>'
          + '<span class="tbr"></span></div>';
        var listC = capsOf(n).filter(function (c) { return c.form; });
        return bannerC + (listC.map(function (c) { return capBlock(c, n); }).join('') || '<div class="hintline"><span>这一档没有额外能力。</span></div>');
      }
      // ⭐⭐ 2026-10-06（用户："二级页的『要下东西』也要吃文件检测"）：
      //   banner 的判据 = tierFilesState()（model_manager catalog 对每个文件 stat 的结论）：
      //     文件在 → "装好了"（引擎没起也不许说成要下载）；文件确实缺 → "要下东西"；
      //     清单还没拿到 → 回落旧逻辑（引擎档位 / 引擎在不在）。
      var files = tierFilesState(n);
      var down = engineDown();
      var kind;
      if (files === 'present') kind = 'has';
      else if (files === 'missing' || files === 'broken') kind = 'need';
      else if (installed(n)) kind = 'has';
      else if (down) kind = 'err';
      else kind = 'need';
      var has = kind === 'has';
      var sub = has ? (down ? '模型文件都在；引擎没起 —— 去「配置信息」启动' : '这一档已经能用了')
        : (files === 'broken' ? '文件不完整，点「重新扫描」看哪一件要修'
        : (kind === 'err' ? engineDownText() : (t.needShort || '')));
      var action = has ? ''
        : (kind === 'err'
          ? '<button class="ect btn pri" data-act="start-engine">' + ico('play', 11, 2.4) + '启动引擎</button>'
          : '<button class="ect btn pri" data-act="install">' + ico('download', 12, 2.6) + esc(t.needShort || '装') + '</button>');
      // ⚠⚠ 2026-10-05：banner 只留"这一档现在什么状态 + 要按的按钮"，一句话。
      var banner = '<div class="tbanner' + (kind === 'has' ? ' has' : (kind === 'err' ? ' err' : '')) + '">'
        + '<span class="tbn">' + (has ? svg(P.check, 12, 3) + '装好了'
            : (kind === 'err' ? ico('warn', 12, 2.4) + '引擎没起' : ico('download', 12, 2.6) + '要下东西')) + '</span>'
        + '<span class="tbt">' + esc(sub) + '</span>'
        + '<span class="tbr">' + action + '</span></div>';

      var list = capsOf(n).filter(function (c) { return c.form; });
      var blocks = list.map(function (c) { return capBlock(c, n); }).join('');

      // ⚠⚠ 2026-10-05：这里【不再套 sec()】——
      //   原来套了一层"这一档能开这几样 5 样"的标题行（约 30px），
      //   可页头已经写着"基础 / 拓展 / 高性能"了，等于同一句话说两遍。
      //   探针实测：去掉它 + 行改成单行，高性能页才从 556px 压到一屏内。
      return banner + (blocks || '<div class="hintline"><span>这一档没有额外能力。</span></div>');
    }

    // 一样能力：一行标题 + 它能做到什么 + 开关/状态 + 它的设置项
    //
    // ⚠⚠⚠ 2026-10-05 改为【收起式 + 点开有动画 + 顶上吸条】（用户三条原话）：
    //   ① "你现在还是留了大量的要滚动的内容" → 收起式（每样能力只占一行）
    //   ② "它没有这个比较好的展开折叠动画" → 展开/收起走 JS 量高 + transition，
    //      **不是**重画整页（重画 = 硬切，没有动画）
    //   ③ "某一个展开之后我往下滑，它顶部会留有一个方便我收纳的那个栏，
    //      就是在我滚动的时候被顶到顶上就不会再被滚走的那个栏"
    //      → .cb-head 展开时 position:sticky（见 CSS）
    //   ⚠ 展开态记在 state.openCap：重画页面后要能接回去。
    //   ⚠ 收起时 body【不渲染】设置项 HTML（省几百个节点），第一次展开才建 ——
    //     这也是原来"七屏半"的直接来源。
    function capBlock(c, n) {
      // ⚠ 用 highlight（粘的），不是 focus（一次性的）—— 见 state 里的注释。
      var focused = state.highlight === c.id ? ' focus' : '';
      var expanded = state.openCap === c.id;
      var sk = SETTINGS_KIND[c.id] || '';

      var head = '<button type="button" class="cb-head" data-cap-toggle="' + esc(c.id) + '">'
        + '<span class="cb-i">' + ico(c.ico, 14, 2) + '</span>'
        + '<span class="cb-t"><b>' + esc(c.form) + '</b><i>' + esc(c.name + '　' + (c.plain || '')) + '</i></span>'
        + '<span class="cb-s">' + (c.swap
            ? '<em class="tagswap">两档只能开一个</em>' : '') + '</span>'
        + '<span class="cb-x" data-cap-arrow>' + (expanded ? ico('arrowUp', 12, 2.4) : ico('arrowDown', 12, 2.4)) + '</span>'
        + '</button>';

      return '<div class="capblk' + (expanded ? ' open' : '') + focused
        + '" data-capblk="' + esc(c.id) + '" data-cap-kind="' + esc(sk) + '">'
        + head
        + '<div class="cb-body" data-cap-body' + (expanded ? ' data-built="1"' : ' hidden') + '>'
        + (expanded ? capBodyHtml(c, sk) : '')
        + '</div>'
        + '</div>';
    }

    // 展开之后才需要的那一段（说明 + 提醒 + 设置项）
    function capBodyHtml(c, sk) {
      var settings = '';
      if (sk && typeof host.settingsFor === 'function') {
        var got = null;
        try { got = host.settingsFor(sk); } catch (_) { got = null; }
        if (got && got.html) settings = '<div class="ec-settings" data-ec-settings="' + esc(sk) + '">' + got.html + '</div>';
      }
      // ⚠⚠⚠ 2026-10-05 用户："现在排版的节奏和空间冗余太低了，并且看起来非常难受，
      //   有大量的非常高密度的信息和巨量的文字说明。我希望说明放到一起，
      //   路径放到一起，设置放到一起，就是分门别类的放好。"
      //
      //   ⇒ 展开区【分成明确的两块】，不再把说明和设置项穿插着排：
      //     ① 「说明」块 —— 这一样能力是干什么的 + 换档提醒（都是文字，归一处）
      //     ② 「设置」块 —— 宿主给的控件（开关/下拉），标题单独一行
      //   ⚠ 路径类的东西（比如实验台地址）原来夹在说明文字中间，用户一眼扫过去
      //     分不清哪句是说明、哪个是地址 —— 现在把它单独拎成一行 .cb-path。
      var notes = '';
      if (c.note) notes += '<div class="noteline">' + esc(c.note) + '</div>';
      if (c.swapNote) notes += '<div class="noteline warn">' + esc(c.swapNote) + '</div>';

      var notesBlock = notes
        ? '<div class="cbb"><div class="cbb-h">说明</div>' + notes + '</div>'
        : '';

      // 设置块：宿主那块 HTML 里如果自带地址/路径（比如调参台），把它拎出来单列一行。
      var setBlock = '';
      if (settings) {
        setBlock = '<div class="cbb"><div class="cbb-h">设置</div>'
          + '<div class="cb-set">' + settings + '</div></div>';
      }

      // ⭐ Phase F：这一样能力对应的引擎 —— 状态 + 就地的启动/停止。
      //   点格子跳进来就能看"它是否打开"，随手拉起来（用户要的"点过去确认"）。
      var engBlock = '';
      var which = (C && typeof C.capEngine === 'function') ? C.capEngine(c.id) : '';
      if (which && cloudOn()) {
        // ⭐ 2026-10-18 云端外挂：本机启停按钮换成一句话（本机引擎不相干）
        engBlock = '<div class="cb-engine ec-cloud-eng" data-cap-engine="cloud">'
          + '<span class="cbe-t"><b>云端</b> 这一样在云端 4090D 上算（' + esc((cloud() || {}).text || '正在连云端…') + '）</span></div>';
      } else if (which) {
        var e = (state.status && state.status.engines && state.status.engines[which]) || null;
        var run = !!e && (e.state === 'running' || e.state === 'old-code');
        var label = which === 'match' ? '校色引擎' : '外挂引擎';
        var tip = which === 'match'
          ? '没开也能生成（校色/快速对齐是内置的）；开着才有细节还原，生成时也会存底版'
          : '抠像 / 人体 / 分割 / 调强度要用它 —— 没开就用不了';
        var acts = run
          ? '<button type="button" class="ect btn" data-act="restart-engine" data-engine-which="' + which + '">' + ico('refresh', 11, 2.4) + '重启</button>'
            + '<button type="button" class="ect btn" data-act="stop-engine" data-engine-which="' + which + '">' + ico('stop', 10, 2.4) + '停止</button>'
          : '<button type="button" class="ect btn pri" data-act="start-engine" data-engine-which="' + which + '">' + ico('play', 11, 2.4) + '启动</button>';
        engBlock = '<div class="cb-engine" data-cap-engine="' + which + '">'
          + '<span class="cbe-t" title="' + esc(tip) + '"><b>' + esc(label) + '</b> ' + esc(engineLineText(e)) + '</span>'
          + '<span class="cbe-a">' + acts + '</span></div>';
      }
      return engBlock + notesBlock + setBlock;
    }

    // ── 展开 / 收起（带动画，不重画整页）────────────────────────
    //  ⚠⚠ 为什么不能像原来那样 renderPage(0)：那是【整页重画】——
    //    旧节点直接消失、新节点直接出现，中间没有任何过渡 = 用户说的"没有展开折叠动画"。
    //    而且重画会把页面滚动位置冲回顶部。
    //  ⚠ 高度过渡用显式 px（0 → 实测高度 → auto）：
    //    直接 transition height 到 auto 是【不生效】的（auto 不是可插值长度）。
    //  ⚠ 收尾必须把 style 清干净回到 auto，否则窗口变了高度就卡死在旧值上。
    var capAnimT = 0;
    function findCapById(id) {
      var all = C ? C.CAPS : [];
      for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
      return null;
    }
    function arrowOf(blk, open) {
      var a = blk.querySelector('[data-cap-arrow]');
      if (a) a.innerHTML = open ? ico('arrowUp', 12, 2.4) : ico('arrowDown', 12, 2.4);
    }
    function expandBlk(blk, body) {
      var id = blk.dataset.capblk;
      if (body.dataset.built !== '1') {
        var c = findCapById(id);
        if (c) {
          body.innerHTML = capBodyHtml(c, blk.dataset.capKind || '');
          body.dataset.built = '1';
          bindSettingsIn(body);          // 里面新出现的设置项要绑一次
        }
      }
      blk.classList.add('open');
      arrowOf(blk, true);
      body.hidden = false;
      // 量目标高
      body.style.height = '0px';
      body.style.opacity = '0';
      body.style.overflow = 'hidden';
      body.style.transition = 'none';
      var target = body.scrollHeight;
      void body.offsetHeight;            // 强制回流，让 0 生效
      body.style.transition = 'height .26s var(--ease-out), opacity .18s var(--ease-soft)';
      body.style.height = target + 'px';
      body.style.opacity = '1';
      clearTimeout(capAnimT);
      capAnimT = setTimeout(function () {
        if (!body.isConnected) return;
        body.style.transition = ''; body.style.height = ''; body.style.opacity = '';
        body.style.overflow = '';          // ⚠ 要放开，不然 sticky 头会被裁
      }, 300);
    }
    function collapseBlk(blk, body) {
      if (!body || body.hidden) { blk.classList.remove('open'); arrowOf(blk, false); return; }
      blk.classList.remove('open');
      arrowOf(blk, false);
      var cur = body.getBoundingClientRect().height;
      body.style.transition = 'none';
      body.style.height = cur + 'px';
      body.style.opacity = '1';
      body.style.overflow = 'hidden';
      void body.offsetHeight;
      body.style.transition = 'height .22s var(--ease-out), opacity .16s var(--ease-soft)';
      body.style.height = '0px';
      body.style.opacity = '0';
      clearTimeout(capAnimT);
      capAnimT = setTimeout(function () {
        if (!body.isConnected) return;
        body.hidden = true;
        body.style.transition = ''; body.style.height = ''; body.style.opacity = ''; body.style.overflow = '';
      }, 250);
    }
    function toggleCap(id) {
      if (!zone) return;
      var blk = zone.querySelector('.capblk[data-capblk="' + String(id).replace(/"/g, '\\"') + '"]');
      if (!blk) return;
      var body = blk.querySelector('[data-cap-body]');
      if (!body) return;
      var opening = !blk.classList.contains('open');

      // ⚠ 一次只开一个：先收掉上一个（用户是拿它当"手风琴"用的）
      var prevId = state.openCap;
      if (opening && prevId && prevId !== id) {
        var prev = zone.querySelector('.capblk[data-capblk="' + String(prevId).replace(/"/g, '\\"') + '"]');
        if (prev) collapseBlk(prev, prev.querySelector('[data-cap-body]'));
      }
      state.openCap = opening ? id : '';

      if (opening) {
        expandBlk(blk, body);
        // ⚠ 展开后往上顶一点：让这一块的【吸顶头】正好停在滚动区顶部，
        //   否则展开在下面、头还在屏幕外，用户找不到那个"收纳栏"。
        if (GLOBAL.requestAnimationFrame) {
          var mine = id;
          GLOBAL.requestAnimationFrame(function () {
            var box = zone && zone.querySelector('.tp-body');
            var b2 = zone && zone.querySelector('.capblk[data-capblk="' + String(mine).replace(/"/g, '\\"') + '"]');
            if (!box || !b2 || box.clientHeight < 2) return;
            var want = b2.offsetTop - 2;
            var max = Math.max(0, box.scrollHeight - box.clientHeight);
            try { box.scrollTo({ top: Math.max(0, Math.min(max, want)), behavior: 'smooth' }); }
            catch (_) { box.scrollTop = Math.max(0, Math.min(max, want)); }
          });
        }
      } else {
        collapseBlk(blk, body);
      }
    }

    // 把某棵子树里的设置项绑上（展开时才建的那些）
    function bindSettingsIn(scope) {
      if (!scope || typeof host.settingsFor !== 'function') return;
      var boxes = scope.querySelectorAll('[data-ec-settings]');
      for (var i = 0; i < boxes.length; i++) {
        var kind = boxes[i].dataset.ecSettings;
        if (!kind) continue;
        if (boxes[i].dataset.ecBound === '1') continue;   // ⚠ 别重复绑（铁律 28）
        var got = null;
        try { got = host.settingsFor(kind); } catch (_) { got = null; }
        if (got && typeof got.bind === 'function') {
          try { got.bind(boxes[i]); boxes[i].dataset.ecBound = '1'; } catch (_) { /* 绑失败不拦渲染 */ }
        }
      }
    }

    function pageBody() {
      if (state.zone === 'config') return configPage();
      var t = tierOfPage(state.zone);
      if (t > 0) return tierPage(t);
      return configPage();
    }

    function pageHeader() {
      var r = railOf(state.zone);
      return '<div class="tp">'
        + '<div class="tp-head"><div class="tp-headline"><div class="tp-title">' + esc(r.name) + '</div>'
        + '<div class="tp-sub">' + esc(r.sub) + '</div></div></div>'
        + '<div class="tp-body">' + pageBody() + '</div>'
        + '</div>';
    }

    function bindPageSettings() {
      if (!zone) return;
      // ⭐ Phase B：配置页的环境行 / 模型列表由各自模块渲染，并且它们自己订阅状态出口。
      //   ⚠ 只经 host.mountEnv/host.mountModels 一处调用（docs/150 §5.5 grep 自查：
      //     V7EngineEnvironment.mount / V7EngineModels.mount 各只出现 1 次 = 宿主那一处）。
      //   模块的 mount() 只渲染 + 订阅，【不主动刷新】（刷新时机归宿主，§4.1/§9.2）。
      if (state.zone === 'config') {
        try { if (typeof host.mountEnv === 'function') host.mountEnv(); } catch (_) { /* 模块自己的问题不拦页面 */ }
        try { if (typeof host.mountModels === 'function') host.mountModels(); } catch (_) { /* 同上 */ }
      }
      // ⚠ 统一走 bindSettingsIn（它带 data-ec-bound 去重）——
      //   以前这里和展开时的绑定是两份代码，重复绑定的风险各担一半（铁律 28）。
      bindSettingsIn(zone);
    }

    // 换页：整体滚动（规范 4.4），不是逐元素错落
    //
    // ⚠⚠⚠ 2026-10-05 改（用户："外挂能力卡片不知道为什么会上下切换有迟滞"）。
    //   旧写法是【两段式】：先把旧的滑出去 → setTimeout 190ms → 再换内容、新的滑进来。
    //   那个 190ms 是给【整卡进场】用的节奏（一级卡打开二级那一下，慢一点显得稳）；
    //   但右栏页签之间切换、以及滚轮翻页，用户是连着操作的 ——
    //   每次都要白等 190ms，手感就是"迟滞 / 切不动"。
    //   ⇒ 页签之间改成【一段式】：立刻换内容，然后只播"新页滑进来"这一半。
    //     整卡进场那条路（dir 为 0 或首次）不受影响。
    //   ⚠ 为什么不做"两个 .tp 交叉淡入淡出"：那要同时存在两份内容，
    //     这一页里有输入框和设置项，双份会带来焦点/重绑定的麻烦（本项目栽过重绑）。
    // ⚠⚠ 2026-10-07：切页动画的【方向】要跟右栏"上/下"一致 ——
    //   旧写法两处调用都写死 renderPage(1)，于是往下切和往上切都是同一个方向（推拉感是错的）。
    //   这里按【右栏里的顺序】算：去更靠下的页 = +1（往下推），去更靠上的页 = -1（往上推）。
    function pageDirTo(id) {
      var 顺序 = RAIL.map(function (r) { return r.id; });
      var 从 = 顺序.indexOf(state.zone), 到 = 顺序.indexOf(id);
      if (从 < 0 || 到 < 0 || 从 === 到) return 1;
      return 到 > 从 ? 1 : -1;
    }

    function renderPage(dir) {
      if (!zone) return;
      var hp = zone.querySelector('.rs-page');
      if (!hp) return;
      var slide = hp.querySelector('.tp');
      if (!slide || !dir) {
        hp.innerHTML = pageHeader();
        bindPageSettings();
        afterPage();
        return;
      }
      var seq = ++pageSeq;
      // ⚠⚠⚠ 2026-10-07 用户实测："二级卡片在右边的纵栏去上下切换卡片内容的时候，整个卡片有一点闪烁感。
      //   我希望是跟随右边的卡片上下切换的时候，总体推拉的感觉，上下推拉。"
      //   旧写法（两段式）为什么会闪：
      //     ① `hp.innerHTML = 新内容` —— 旧内容【瞬间消失】，那一刻页面是空的；
      //     ② 新内容从偏移 18px 处【淡入】（opacity 0→1）—— 淡入期间底下是空的 ⇒ 看着就是"闪一下"。
      //   ⇒ 改成【真推拉】：把旧内容【快照】成一个浮层留在原位，
      //     旧层向反方向推出去、新层从另一侧推进来，两层【同时动】⇒ 中间没有空帧。
      //   ⚠ 用 innerHTML 快照而不是搬真节点：真节点上挂着的事件/绑定留给新内容，
      //     快照只负责"被推出去"这一段视觉，几百毫秒后丢掉。
      //   ⚠ 首帧（dir=0 或还没有 .tp）走上面那条同步分支，不播动画 —— 免得刚开卡就闪一下。
      var 旧层 = null;
      if (slide) {
        旧层 = document.createElement('div');
        旧层.className = 'tp tp-leaving';
        旧层.setAttribute('aria-hidden', 'true');
        旧层.innerHTML = slide.innerHTML;
        旧层.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;'
          + 'pointer-events:none;z-index:2;will-change:transform,opacity';
        // ⚠⚠ 注意顺序：这里【只建好、先不挂】——
        //   下面那句 `hp.innerHTML = …` 会把 hp 里的东西全冲掉，
        //   先 append 再赋值 = 旧层立刻被冲走（我第一版就这么写的，验收的"旧层 0/20 帧"直接抓出来了）。
      }
      var 距离 = 26;                       // 推拉距离：比原来的 18 大一点，推拉感更明确
      var 进 = dir > 0 ? 距离 : -距离;      // 新内容从哪一侧进来
      var 出 = -进;                        // 旧内容往反方向出去（这就是"推"）
      // 换内容（此刻 hp 是空的；旧层马上挂上去盖住，所以看不到空帧）
      hp.innerHTML = pageHeader();
      if (旧层) hp.appendChild(旧层);       // ⚠ 必须在 innerHTML 之后挂
      bindPageSettings();
      afterPage();
      var nu = hp.querySelector('.tp');
      if (!nu) { if (旧层) 旧层.remove(); return; }
      nu.style.position = 'absolute';
      nu.style.inset = '0';
      nu.style.zIndex = '1';
      nu.style.transition = 'none';
      nu.style.transform = 'translateY(' + 进 + 'px)';
      nu.style.opacity = '0.001';          // ⚠ 不用纯 0：纯 0 会走"合成层"那条路，文字栅格化会跳一下
      var 走 = function () {
        if (seq !== pageSeq) { if (旧层) 旧层.remove(); return; }
        var 时长 = '.22s';
        nu.style.transition = 'transform ' + 时长 + ' var(--ease-out), opacity .18s var(--ease-soft)';
        nu.style.transform = 'translateY(0)';
        nu.style.opacity = '1';
        if (旧层) {
          旧层.style.transition = 'transform ' + 时长 + ' var(--ease-out), opacity .16s var(--ease-soft)';
          旧层.style.transform = 'translateY(' + 出 + 'px)';
          旧层.style.opacity = '0';
          setTimeout(function () { if (旧层 && 旧层.parentNode) 旧层.remove(); }, 300);
        }
      };
      if (GLOBAL.requestAnimationFrame) GLOBAL.requestAnimationFrame(function () { GLOBAL.requestAnimationFrame(走); });
      else setTimeout(走, 32);
    }

    // 换页之后：从一级格子点进来时，把那样能力滚进视野并闪一下
    //
    // ⚠⚠⚠ 2026-10-05 修掉的真 bug（用户："你一级卡片的跳转也没做，你就这么偷懒？"）。
    //   症状：点"抠像·高精抠"→ 页切到「高性能」、目标块的 .focus 也打上了，
    //         但 **scrollTop 还是 0、目标块在屏幕外、闪烁一下都没播** —— 等于没跳。
    //   真因（探针实测）：
    //     ① openZone() 先 renderPage(0) → afterPage()，而这一步是在
    //        `zone.classList.add('show')`【之前】跑的，宿主的 display 也还没轮到 ——
    //        那一刻 zone 还是 display:none，**所有 getBoundingClientRect() 都是 0**，
    //        scrollIntoView 自然是空操作。
    //     ② 更致命的：旧代码【不管成没成功】都先把 `state.focus` 清成空串，
    //        于是 openAtCap 里那句补救（`if (state.open && state.focus)`）
    //        永远进不去 —— 补救分支从写下来那天起就是死代码。
    //   ⇒ 现在：滚之前先确认"真的能滚"（容器有高度 + 元素有高度）；
    //     没成功就【保留 focus】并排下一帧重试，成功才清空。
    //   ⚠ 重试必须有上限，否则目标元素永远不出现时会一直排帧（本项目栽过"重复挂监听锁死"）。
    var focusTries = 0;
    function afterPage() {
      if (!zone || !state.focus) return;
      var id = state.focus;
      var body = zone.querySelector('.tp-body');
      var el = zone.querySelector('[data-capblk="' + id + '"]');

      // 能滚的条件：容器已经显示且有高度 + 目标元素在（有高度）
      var ready = !!(body && el
        && body.clientHeight > 1
        && el.getBoundingClientRect().height > 1);

      if (!ready) {
        // 还没显示出来（二级刚开、宿主 display 还没切）→ 保留 focus，下一帧再来
        if (focusTries++ < 60) {
          if (GLOBAL.requestAnimationFrame) GLOBAL.requestAnimationFrame(afterPage);
          else setTimeout(afterPage, 16);
        } else {
          focusTries = 0; state.focus = '';   // 放弃（元素确实不存在），别一直排帧
        }
        return;
      }

      focusTries = 0;
      state.focus = '';

      // ⚠ 不用 scrollIntoView —— 它会连带滚动外层容器（整个卡片台面都会被推走）。
      //   这张卡的滚动容器只有一个：.tp-body。自己算偏移最稳。
      var want = el.offsetTop - (body.clientHeight - el.offsetHeight) / 2;
      var max = Math.max(0, body.scrollHeight - body.clientHeight);
      try {
        body.scrollTo({ top: Math.max(0, Math.min(max, want)), behavior: 'smooth' });
      } catch (_) {
        body.scrollTop = Math.max(0, Math.min(max, want));
      }

      // ⚠ 闪一下用 JS 加 class + 定时摘，不给"已存在的元素"直接加 class 播动画
      //   （那会先画终态再播，闪两次 —— 项目里踩过）
      el.classList.add('flash');
      setTimeout(function () { if (el.isConnected) el.classList.remove('flash'); }, 1200);
    }

    function popGlow() {
      if (!zone) return;
      var els = zone.querySelectorAll('.z-glow,.z-bright');
      for (var i = 0; i < els.length; i++) { els[i].classList.remove('glow'); void els[i].offsetWidth; els[i].classList.add('glow'); }
    }

    // ══════════════════════════════════════════════════
    //  性能监控（用户 10-04 定：要活的监控）
    //  ⚠ 只在二级开着、且停在「配置信息」页时才轮询 —— 别的页不看它，
    //    一直在后台每 1.5 秒问一次是白烧电（而且采样器本身要 refresh 进程表）。
    // ══════════════════════════════════════════════════
    function stopPerf() {
      if (perfTimer) { clearInterval(perfTimer); perfTimer = 0; }
    }
    function tickPerf() {
      if (!state.open || state.zone !== 'config') { stopPerf(); return; }
      if (typeof host.perfSample !== 'function') return;
      Promise.resolve().then(function () { return host.perfSample(); }).then(function (s) {
        perfErr = '';
        perfData = s || null;
        // ⚠⚠⚠ 2026-10-07 用户实测："机器状态每刷新一下，机器状态显示的那些文字也会刷新一下"。
        //   真因：这里原来是【整条顶栏 replaceWith(新节点)】——
        //     ① .specline 上带着 animation:etRowIn（淡入+上滑）⇒ 每 1.5 秒重播一次动画 = 闪；
        //     ② 节点换了 ⇒ hover/focus 状态丢；
        //     ③ 进度条节点的 transition 每次都从头开始。
        //   ⇒ 现在只【就地改】变了的那几处文字和进度条宽度（patchSpec），节点不动。
        //   ⚠ 别改回整块重建。要改结构的话（比如芯片数量变了）patchSpec 内部会自己处理。
        var top = zone && zone.querySelector('[data-rc-top]');
        if (top) {
          lastSpecData = specDataOf(perfData);
          patchSpec(top);
        }
      }).catch(function (e) {
        perfErr = String(e && e.message || e);
        perfData = null;
      });
    }
    function startPerf() {
      if (typeof host.perfSample !== 'function') return;
      stopPerf();
      tickPerf();
      perfTimer = setInterval(tickPerf, 1500);
    }

    // ══════════════════════════════════════════════════
    //  开 / 关
    // ══════════════════════════════════════════════════
    function openZone(pageId, how) {
      pageId = pageId || state.zone || 'config';
      if (!railOf(pageId)) pageId = 'config';
      // ⭐ 2026-10-06 Phase B：配置页的数据 = V7EngineStatus。进这一页问宿主刷一次
      //   （刷新时机归宿主：卡打开 / 手动重新扫描 / 操作完成；卡关闭不轮询 —— docs/150 §4.1）。
      if (pageId === 'config' && typeof host.refreshStatus === 'function') {
        Promise.resolve().then(function () { return host.refreshStatus(false); }).catch(function () { });
      }
      if (!state.open) {
        state.open = true; state.openedBy = how || 'click';
        state.zone = pageId;
        mountZone(); renderPage(0); renderRail(); renderFace();
        if (zone) zone.classList.add('show');
        popGlow();
        if (typeof host.onOpen === 'function') host.onOpen(state.zone);
        startPerf();
      } else {
        // ⚠⚠⚠ 2026-10-05 修掉的真 bug（用户："我点按一级卡片里面的对齐的高性能档位，
        //   它不会弹出任何内容。而是只有我去手动打开二级卡片，也就是向右滑动之后，
        //   我才能在二级卡片里看到它其实是在切换的。"）
        //
        //   真因：`state.open` 是【粘的】—— 这张卡的 zone 容器只要露过一次
        //   （路由进来过 / 右滑开过），state.open 就永远是 true。
        //   于是【第二次点格子】走的是这个 else 分支，只切了卡内部那一页，
        //   **完全没有通知宿主**，宿主的 zoneOpen / .show / display 全没动
        //   ⇒ 屏幕上二级容器还是收着的 = 用户看到的"点了没反应"。
        //   （宿主那半边是 enginesOpenZone()，只有 host.onOpen 这一个入口能碰到它。）
        //
        //   修法：只要是【用户主动发起】的开（click / swipe / route），
        //   每次都通知宿主一次。enginesOpenZone() 是幂等的（它查 wasOpen 决定要不要播光），
        //   重复调不会出问题 —— 这一点我核实过（ui.html 的 enginesOpenZone）。
        //   ⚠ 不用 state.open 当护栏：护栏的判据（内部页签变没变）跟
        //     "宿主那边容器露没露"本来就是两件事，不能互相代替。
        if (pageId !== state.zone) {
          state.zone = pageId;
          // ⚠ 页变了 → 顶上那条监控的"要不要继续跑"也要跟着变
          if (pageId === 'config') startPerf(); else stopPerf();
          renderPage(1); renderRail();
        } else {
          renderRail();
        }
        // ⚠ 用户主动开的这三条路，一律把宿主那半边也叫醒。
        //   'api'（内部重画/路由静默调用）不叫 —— 那种情况宿主要么已经露着、要么不该由它开。
        if ((how === 'click' || how === 'swipe' || how === 'route') && typeof host.onOpen === 'function') {
          host.onOpen(state.zone);
        }
        if (zone) zone.classList.add('show');
      }
      if (how === 'click') state.used = true;
    }

    // 从一级卡面点某个格子 → 跳到那一档的页，并高亮那一样能力
    function openAtCap(capId, tier) {
      state.focus = capId || '';
      // ⚠ highlight 是粘的（画蓝边用），focus 是一次性的（滚完就清）。
      //   两个都要设：focus 负责"滚过去"，highlight 负责"到了之后还亮着"。
      state.highlight = capId || '';
      // ⚠ 跳过去就顺手把那样能力【展开】—— 用户点格子就是想看它需要什么，
      //   再让他自己点一次展开是多余的一步。
      state.openCap = capId || '';
      openZone(pageOfTier(tier), 'click');
      if (state.open) {
        // 已经开着、且就在这一页 → openZone 不换页，得自己重画一次
        renderPage(0); renderRail();
      }
    }

    function closeZone() {
      if (!state.open) return;
      state.open = false;
      stopPerf();
      if (zone) zone.classList.remove('show');
      if (face) {
        var eh = face.querySelector('.edgehint');
        if (eh) { eh.style.opacity = ''; eh.style.width = ''; eh.classList.remove('recoil'); void eh.offsetWidth; eh.classList.add('recoil'); }
      }
      if (typeof host.onClose === 'function') host.onClose();
    }

    // 滚轮翻页（宿主 ui.html 调）
    // ⚠⚠ 2026-10-04：设置卡那边用户明确要求"能滚但绝不翻页"。
    //   这张卡【保留】翻页 —— 因为右栏是"四页导航"，翻页是它设计里就有的动作，
    //   而且滚轮落在二级上时 ui.html 已经做过"正文先滚、到头才翻"的判定。
    //   ⚠ 这条跟设置卡不同，别照着设置卡改成"不翻页"。
    function flipPage(dir) {
      if (!state.open) return false;
      var idx = -1;
      for (var i = 0; i < RAIL.length; i++) if (RAIL[i].id === state.zone) { idx = i; break; }
      if (idx < 0) return false;
      var next = idx + (dir > 0 ? 1 : -1);
      if (next < 0 || next >= RAIL.length) return false;
      state.zone = RAIL[next].id;
      if (state.zone === 'config') startPerf(); else stopPerf();
      renderPage(dir); renderRail();
      return true;
    }

    function setTier(n) {
      n = +n;
      if (!T(n)) return;
      if (cloudOn()) { toast('云端外挂开着：三档能力都在云端算，不用选档、不用装'); return; }
      state.tier = n;
      renderFace();
      if (state.open) { renderPage(0); renderRail(); }
      pushStack();
      if (!installed(n)) startInstall(n);
      else {
        if (typeof host.onTier === 'function') host.onTier(n);
        toast('这一档：' + T(n).head);
      }
    }

    // ══════════════════════════════════════════════════
    //  事件
    // ══════════════════════════════════════════════════
    function bindZone() {
      if (!zone) return;
      zone.addEventListener('mouseover', function (e) {
        var n = e.target.closest && e.target.closest('[data-page]');
        if (!n) return;
        var id = n.dataset.page;
        if (!id || id === state.zone) return;
        clearTimeout(railHoverT);
        // ⚠⚠ 2026-10-05 用户："外挂能力卡片不知道为什么上下切换会有迟滞，或者是有切不动的情况。"
        //   两条真因，这里修的是第一条：
        //     ① 【消抖 110ms + 换页等 190ms ≈ 300ms】——鼠标在右栏扫过去的时候，
        //        第 4 个页签要等前 3 个的计时器全部作废才轮到它，手感上就是"切不动"。
        //        ⇒ 消抖砍到 45ms（还够挡住"扫过"时的连切，但不再像卡住）。
        //     ② 换页那条路原来【先滑出、等 190ms、才换内容】（renderPage 的 seq 逻辑）。
        //        那是给整卡进场用的节奏，二级页签之间太慢 —— 见 renderPage 里的改动。
        //   ⚠ 消抖不能没有：完全没有的话鼠标从上扫到下，四个页会各切一次、噼里啪啦。
        railHoverT = setTimeout(function () {
          if (state.open) {
            var 方向 = pageDirTo(id);      // 同上：先算方向再改 state.zone
            state.zone = id;
            if (id === 'config') startPerf(); else stopPerf();
            renderPage(方向); renderRail();
          }
        }, 45);
      });
      zone.addEventListener('click', function (e) {
        state.used = true;
        var p = e.target.closest && e.target.closest('[data-page]');
        if (p && p.dataset.page) {
          var id = p.dataset.page;
          if (id !== state.zone) {
            var 方向 = pageDirTo(id);      // ⚠ 要在改 state.zone 之前算（它要用旧的 state.zone）
            state.zone = id;
            if (id === 'config') startPerf(); else stopPerf();
            renderPage(方向); renderRail();
          }
          return;
        }
        // ⭐ 2026-10-05：能力块展开 / 收起（带高度动画 + 吸顶头，见 capBlock 注释）
        //   ⚠ 这里【不再 renderPage(0)】—— 整页重画 = 硬切、没动画，还会把滚动位置冲回顶部。
        //     这正是用户说的"它没有这个比较好的展开折叠动画"。
        //     现在由 toggleCap 直接对那一个块做高度过渡。
        //   ⚠ 必须排在 [data-act] 前面。
        var tg = e.target.closest && e.target.closest('[data-cap-toggle]');
        if (tg) { toggleCap(tg.dataset.capToggle); return; }
        var a = e.target.closest && e.target.closest('[data-act]');
        if (a) { doAct(a.dataset.act, a); return; }
        var gt = e.target.closest && e.target.closest('[data-goto-tier]');
        if (gt) { setTier(+gt.dataset.gotoTier); return; }
      });
    }
    var railHoverT = 0;

    function doAct(k, el) {
      if (k === 'tier-help') { toast(TIER_HELP); return; }
      // ⭐ 2026-10-18 云端外挂
      if (k === 'cloud-check') {
        if (typeof host.cloudCheck === 'function') { toast('正在连云端…'); host.cloudCheck(); }
        return;
      }
      if (k === 'cloud-off' || k === 'cloud-on') {
        if (typeof host.setCloud === 'function') host.setCloud(k === 'cloud-on');
        return;
      }
      // 冻结区本来点不动（inert + CSS），这里再兜一道：万一从别处（快捷键 / 夏三六）触发了，也不碰本机引擎
      if (cloudOn() && CLOUD_FROZEN_ACTS[k]) {
        toast('云端外挂开着：本机引擎不用管。要用本机，先关掉左上角的「云端外挂」');
        return;
      }
      if (cloudOn() && k === 'probe') { if (typeof host.cloudCheck === 'function') host.cloudCheck(); return; }
      // ⭐ 顶部机器状态条的折叠/展开（2026-10-05 用户要的"折起来不占地方"）
      if (k === 'top-fold') {
        state.topFold = !state.topFold;
        paintTop();          // 只重画顶条，不动页面（页内滚动位置要保住）
        return;
      }
      // ⭐ 2026-10-05：配置页的「详细配置」折叠（用户要的"允许折叠收纳、默认收起"）。
      //   ⚠ 这里【重画整页】是故意的：展开/收起会明显改变这一页的高度，
      //     留着旧的滚动位置反而会跳到半截。收起来时是回到顶部，符合直觉。
      //     （对比 top-fold 那条：它只动常驻顶条，不影响页内滚动，所以只重画顶条。）
      if (k === 'detail-fold') {
        state.detailFold = !state.detailFold;
        renderPage(0);
        return;
      }
      if (k === 'install') { startInstall(state.tier); return; }
      // ⭐ Phase B（docs/150 §5.1）：状态条的重启；模型行/引擎设置的折叠与重扫。
      if (k === 'restart-engine') {
        var w3 = (el && el.dataset && el.dataset.engineWhich) || 'matting';
        if (typeof host.restartEngine === 'function') host.restartEngine(w3);
        else toast('这个版本还没有重启引擎的入口');
        return;
      }
      if (k === 'models-fold') { state.modelsFold = !state.modelsFold; renderPage(0); return; }
      if (k === 'models-rescan') {
        if (typeof host.rescanModels === 'function') host.rescanModels();
        else toast('这个版本还没有重新扫描的通道');
        return;
      }
      if (k === 'engine-fold') { state.engineFold = !state.engineFold; renderPage(0); return; }
      if (k === 'jump-tier') { var n = C ? C.higherTierWith(state.zone, state.tier) : 2; setTier(n || 2); return; }
      if (k === 'redownload') {
        if (typeof host.redownload === 'function') host.redownload(state.tier);
        else if (typeof host.install === 'function') host.install(state.tier);
        else toast('还没有接上下载通道');
        return;
      }
      // ⭐ Phase F：启停/重启都带 data-engine-which（match|matting），各管各的。
      if (k === 'probe') { if (typeof host.probe === 'function') host.probe(el && el.dataset ? el.dataset.engineWhich : undefined); return; }
      if (k === 'start-engine') {
        var w1 = (el && el.dataset && el.dataset.engineWhich) || 'matting';
        if (typeof host.startEngine === 'function') host.startEngine(w1);
        else toast('这个版本还没有启动引擎的入口');
        return;
      }
      if (k === 'stop-engine') {
        var w2 = (el && el.dataset && el.dataset.engineWhich) || 'matting';
        if (typeof host.stopEngine === 'function') host.stopEngine(w2);
        else toast('这个版本还没有停止引擎的入口');
        return;
      }
      if (k === 'dlss') {
        if (typeof host.openDlss === 'function') host.openDlss();
        else toast('DLSS 那一页还没接上');
        return;
      }
      if (el && el.classList.contains('btn')) {
        if (el.classList.contains('done')) return;
        var old = el.innerHTML; el.classList.add('done'); el.innerHTML = svg(P.check, 13, 2.6) + '好了';
        setTimeout(function () { if (el.isConnected) { el.classList.remove('done'); el.innerHTML = old; } }, 1200);
      }
    }

    var instT = 0;
    // 清掉忙碌态（底栏的"正在装 … N%"和进度条一起收）。
    // ⚠ 2026-10-06 用户实测：点了「安装」但宿主早期返回（没有下载源 / tier1 / 没通道）时，
    //   底栏就【永远卡在"正在装 拓展… 0%"】—— 因为宿主是会 await 的 async，
    //   而这里只认"立即返回 false"，Promise 没人接。现在成功/失败/空跑三条路都收口。
    function clearInstallBusy() {
      state.busy = null; state.progress = 0;
      var bar = document.querySelector('.block-card[data-card="engines"] .bc-foot .pgbar');
      if (bar) bar.remove();
    }
    function startInstall(n) {
      if (state.busy) { toast('正在装 ' + state.busy + ' 档，等它跑完'); return; }
      if (typeof host.install !== 'function') { toast('还没有接上下载通道 —— 这一档暂时装不了'); return; }
      var r = null;
      try { r = host.install(n); } catch (e) { toast('装不起来：' + (e && e.message || e)); return; }
      // 宿主同步说"不做"（比如 1 档不用装）→ 什么都不用清，本来就没进忙碌态
      if (r === false) return;
      state.busy = n; state.progress = 0;
      paintProgress();
      // 宿主是 async：真正跑完/空跑都会回到这里。成功/失败路径里宿主会调
      // doneInstall/failInstall（那时 busy 已经不是 n，这里直接跳过）；
      // 只有"早期返回 false"没人管 —— 由这里收尾，底栏恢复真实状态。
      if (r && typeof r.then === 'function') {
        r.then(function () {
          // 宿主走成功/失败路径时会先调 doneInstall/failInstall（busy 已换），这里跳过；
          // 只有"早期返回 false / 没人收尾"才由这里兜底 —— 绝不把底栏卡在"正在装 0%"。
          if (state.busy === n) { clearInstallBusy(); reload(); }
        }).catch(function () {
          if (state.busy === n) { clearInstallBusy(); reload(); }
        });
      }
    }

    function paintProgress() {
      var foot = document.querySelector('.block-card[data-card="engines"] .bc-foot');
      if (!foot) return;
      var bar = foot.querySelector('.pgbar');
      if (!bar) { bar = document.createElement('i'); bar.className = 'pgbar'; foot.appendChild(bar); }
      bar.style.width = (state.progress * 100) + '%';
      var info = document.querySelector('[data-engines-foot]');
      if (info && state.busy) info.textContent = '正在装 ' + (T(state.busy) ? T(state.busy).head : state.busy + ' 档') + '… ' + Math.round(state.progress * 100) + '%';
    }

    var toastT = 0;
    function toast(m) {
      var el = document.getElementById('toast');
      if (!el) { if (typeof host.toast === 'function') host.toast(m); return; }
      el.textContent = m; el.classList.add('show');
      clearTimeout(toastT);
      toastT = setTimeout(function () { el.classList.remove('show'); }, 2600);
    }

    // ══════════════════════════════════════════════════
    //  一级卡事件
    // ══════════════════════════════════════════════════
    function bindFace() {
      if (!face || face.dataset.bound === '1') return;
      face.dataset.bound = '1';
      face.addEventListener('click', function (e) {
        var hit = function (sel) { return e.target.closest && e.target.closest(sel); };

        // ① 表头的问号 → 说清三档是怎么分的
        if (hit('.ec-q')) { if (typeof host.toast === 'function') host.toast(TIER_HELP); return; }

        // ② ⭐ 点格子 → 跳到那一档，并高亮那一样能力
        //   ⚠⚠ 用户 10-04 原话："注意叉叉是点不下去的" —— 没有 form 的格子
        //     是 .none，这里必须拦住，不然点了会跳到一个"这一档没有它"的页面，
        //     用户会以为是 bug。
        var cell = hit('.ec-cell');
        if (cell) {
          if (cell.classList.contains('none')) return;
          openAtCap(cell.dataset.cap, +cell.dataset.tier);
          return;
        }

        // ③ 点档位表头那一格 → 只换当前档（不跳页），方便对比
        var hc = hit('.ec-hcell');
        if (hc) { setTier(+hc.dataset.tier); return; }

        // ④ 点行名 → 进二级看这一档的它
        var cr = hit('.ec-crow');
        if (cr) { openAtCap(cr.dataset.cap, state.tier); return; }
      });

      // 键盘：格子是 role=button，回车/空格要等于点击
      face.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var cell = e.target.closest && e.target.closest('.ec-cell');
        if (!cell || cell.classList.contains('none')) return;
        e.preventDefault();
        openAtCap(cell.dataset.cap, +cell.dataset.tier);
      });
    }

    // ══════════════════════════════════════════════════
    //  对外
    // ══════════════════════════════════════════════════
    function mount(zoneEl, faceEl) {
      if (zoneEl) zone = zoneEl;
      if (faceEl) face = faceEl;
      mountZone();
      bindFace();
      reload();
    }
    function reload() {
      applyData();
      renderFace();
      if (state.open) { renderPage(0); renderRail(); }
    }
    // ⭐ 2026-10-18 云端外挂：状态变了（开 / 关 / 连上 / 降级 / 没登录…）时宿主调这个。
    //   ⚠ 只有「开关 + 状态」真变了才重画二级页 —— 重画会把页内滚动和展开的能力块冲掉，
    //     而云端状态会时不时通知一下（比如重新检测一次、结果没变），不能每次都重画。
    //   ⚠ 2026-10-20 加了每分钟一次的心跳：延迟数字每分钟都变 —— 只换顶上那行，不重画二级页（否则页内滚动每分钟被冲一次）
    var lastCloudSig = '', lastPageSig = '';
    function syncCloud() {
      var c = cloud() || {};
      var sig = (c.on ? 1 : 0) + '|' + (c.state || '') + '|' + (c.degraded ? 1 : 0) + '|' + (c.text || '');
      var pageSig = sig.replace(/ · 延迟 \d+ ms/, '');
      syncFace();
      if (sig === lastCloudSig) return;
      lastCloudSig = sig;
      if (zone) {
        var top = zone.querySelector('[data-rc-top]');
        if (top) { top.innerHTML = ''; paintTop(); }
        zone.classList.toggle('ec-cloud-on', cloudOn());
      }
      if (pageSig === lastPageSig) return;
      lastPageSig = pageSig;
      if (state.open) { renderPage(0); renderRail(); }
    }
    function setProgress(p, n) {
      state.progress = Math.max(0, Math.min(1, Number(p) || 0));
      if (n != null) state.busy = n;
      paintProgress();
    }
    function doneInstall(n) {
      clearInstallBusy();
      reload();
      if (n) toast((T(n) ? T(n).head : n + ' 档') + ' 装好了');
    }
    function failInstall(n, msg) {
      clearInstallBusy();
      reload();
      toast('装 ' + (T(n) ? T(n).head : n + ' 档') + ' 没成功：' + (msg || '原因不明'));
    }

    return {
      mount: mount, reload: reload, render: renderFace, syncCloud: syncCloud,
      openZone: openZone, open: openZone, close: closeZone,
      isOpen: function () { return state.open; },
      openedBy: function () { return state.openedBy; },
      used: function () { return state.used; },
      markUsed: function () { state.used = true; },
      zoneId: function () { return state.zone; },
      tier: function () { return state.tier; },
      engineTier: function () { return state.engineTier; },
      setTier: setTier, flipPage: flipPage,
      setProgress: setProgress, doneInstall: doneInstall, failInstall: failInstall,
      // ⚠ 一级卡面的"详情区"已删（用户要"一眼看穿的图表"），没有展开态了。
      //   这两个方法留着只为兼容老调用 —— 别据此以为还有展开动画。
      expanded: function () { return true; },
      setExpanded: function () { /* 已废弃：一级卡面没有可展开的详情区 */ },
      tierOfPage: tierOfPage, pageOfTier: pageOfTier,
      rail: RAIL,
      state: state
    };
  }

  return {
    create: create,
    setIconRenderer: function (fn) { icon.setRenderer(fn); },
    svg: svg, esc: esc, RAIL: RAIL, tierOfPage: tierOfPage, pageOfTier: pageOfTier
  };
});
