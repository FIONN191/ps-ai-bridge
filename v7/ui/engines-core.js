/* 外挂能力卡 · 纯逻辑地基（无 DOM、无 IPC，可在 node 里单测）
 *
 * 这一层只回答三类问题，界面怎么画都不归它管：
 *   1. 三档各是什么、各要什么（显存 / 磁盘 / 装什么）；
 *   2. 六样能力在三档里分别是什么、哪些是【三档互斥只能开一份】的；
 *   3. 引擎报回来的模型清单 → 反推"这台机器实际到了第几档、装了哪些"。
 *
 * ⚠⚠ 为什么"档位"必须从【引擎实际报的模型】反推，而不是用户勾了就算：
 *   用户 2026-10-01 定的规矩 —— 档位是用户选的开关，点了 2 档就真去下模型。
 *   但下完没下完、显存够不够，是引擎说了算。两个都要看，取严的那一边。
 *   这条和 matting-engine.js 的 pickTier（"引擎能给的 ∩ 用户允许的"）是同一个道理。
 *
 * ⚠ 这一层【不认识】MATTINGENGINE，也不认识 model-downloads.json。
 *   宿主把引擎快照喂进来（tiers / models），这里只做换算。这样能单测。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7EnginesCore = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ============================================================
  //  三档（整层一个大档）
  //  ⚠ 1 档的定义是用户 2026-10-01 亲自纠正过的：
  //    "不需要挑设备、不挑性能、基本都能跑" + "小型的安装包可以直接嵌在插件里面"
  //    → 所以【校色、网格变形这些纯 CPU 算法是 1 档的头号成员，它们零安装】。
  //    ⚠ 曾经把 1 档写成"先给套轻量模型"，被用户否了。别重犯。
  // ============================================================
  var TIERS = Object.freeze({
    1: {
      n: 1, head: '基础', sub: '不用装任何东西，什么电脑都能跑',
      dev: '随便什么机器', gpu: 0, disk: 0, need: '零安装', needShort: '已就绪', gpuText: '不挑显卡',
      ico: 'cpu',
      gets: ['校色', '快速对齐', '轻量抠像', '快速人体'],
      why: '这一档的东西已经在软件里了，不需要下载任何东西，也不需要显卡。'
    },
    2: {
      n: 2, head: '拓展', sub: '下几个模型，抠像和人体都变准',
      dev: '4-6G 显卡内存', gpu: 6, disk: 3.9, need: '一键下载 3.9G', needShort: '要下 3.9G', gpuText: '要 4-6G 显卡内存',
      ico: 'gpu',
      gets: ['标准抠像', '人体（准）', '分割', '细节还原'],
      why: '模型要单独下 —— 太大，塞不进安装包。'
    },
    3: {
      n: 3, head: '高性能', sub: '要 N 卡，解锁最细的几样',
      // ⚠⚠ 2026-10-05：`dev` / `need` / `gpuText` 全是【用户看得见的】，
      //   一律不许出现 PyTorch / 显存 / 模型文件名（用户："留了大量的专有名词"）。
      dev: 'N 卡 · 6-12G 显卡内存', gpu: 12, disk: 10.6, need: '要 N 卡 + 再下 6.7G', needShort: '要下 6.7G + N 卡', gpuText: '要 N 卡 6-12G',
      ico: 'gpu',
      gets: ['高精抠像', '人体（细 6 倍）', '打字抠', '精修边缘'],
      why: '这一档要 N 卡。⚠ 不承诺"有独显就能用"，实际能不能跑由检测说了算。'
    }
  });

  // ============================================================
  //  六样能力
  //  ⚠ 顺序照用户说的：校色、网格变形排头两条 —— 它们比抠像还基础。
  //  ⚠ swap:true = 【三档互斥，只能开一个】。用户 2026-10-01 反复强调：
  //     "有些功能它只能开一档，不可能说三档都能开"。
  //     换档是把上一个顶掉，绝不会三个同时跑、不会三份模型都占显存。
  //  ⚠ swap:false 的是校色 / 网格变形 / 细节补偿 —— 三档同一套本机算法，不互斥。
  //
  // ⭐⭐ 2026-10-02 卡面重排时改的三件事（用户当天提的两条要求）：
  //
  //  ① `name` 全改成【大白话短名】。用户原话："卡片里面不需要加任何的专业术语，
  //     只需要加简单的内容即可，告诉他这个东西是干嘛的，任何相关元素直接移到二级菜单。"
  //       · 「网格变形对齐」→「对齐」
  //       · 「人体解析」   →「人体」
  //       · 「指哪抠哪」   →「分割」（用户 2026-10-02 亲自点的名）
  //       · 「细节补偿」   →「细节还原」
  //     ⚠ 模型名（BiRefNet / SCHP / Sapiens2 / segformer / SAM2）一个都不许再出现在卡面。
  //       它们【只留在 `tiers` 里】，而卡面不再读 `tiers` —— 读 `tiers` 的只有二级页。
  //       docs/14 早就定了这条（卡面禁英文、模型名去二级菜单）；
  //       2026-10-01 那版把 '轻量 BiRefNet-lite 110M' 加回了卡面，这轮按 docs/14 收回。
  //     ⚠ 短名有长度上限：卡面左栏 46px、约 3 个字。改名前先量（实测「指哪抠哪」4 字被切）。
  //
  //  ② 新增 `same:true` = 【三档完全一样、不互斥的能力】。
  //     卡面上这类不再各占一行，而是【压成一行】"校色 · 对齐 · 细节还原 三档都一样"。
  //     为什么：用户 2026-10-02 要"对照表和详情都要看"，而卡面可用区只有 248×322。
  //     实测 6 行对照 + 详情 = 444（溢出 122）、挤到极限仍溢出 29。
  //     这三样三档一模一样、没有对照价值 —— 压掉它们正好腾出详情的位置。
  //
  //  ③ 新增 `plain` = 【给普通用户看的一句话】。卡面/详情只显示它。
  //     `note` 是给二级菜单的技术说明，卡面【不碰】。
  //
  //  ⚠⚠ 可扩展性（用户 2026-10-02："你要考虑我们后续还要添加新的功能啊"）：
  //     往这个数组里【加新能力】不会撑破卡面 —— 卡面的对照区是"定高 + 内部滚动"
  //     （.ec-grid 自己 overflow-y:auto，跟二级右栏 .rail-list 同一套做法）。
  //     加多少样都行，卡面外形一动不动。实测：涨到 8 样、只要让它滚，仍是 322。
  // ============================================================
  // ⭐⭐⭐ 2026-10-04 深夜重排（用户看完样机后逐条口述的结构）：
  //
  //  一级卡面 = 【一张总表】：横轴 = 三档（基础 / 拓展 / 高性能），纵轴 = 能力。
  //  ⚠⚠ 格子里【不再打勾打叉】，改成【这一档下、这样能力是什么形态】。
  //     用户原话："横轴和纵轴中间，它不一定是勾勾叉叉了，它可以去再多一个维度的信息。"
  //     一个格子本来能装一句话，只画个 ✓ 等于白扔。
  //     而且这么改之后，「文字选区」「精修边缘」这两个怪名字【自动消失】——
  //     它们不是两个并列的怪功能，是别的能力在更高档下的样子。
  //
  //  `form` = 格子里显示的那几个字（三档各一个）。空串/null = 这一档没有它。
  //  ⚠ `form` 只给【一级卡面】看；`tiers` 是二级页的技术说明，卡面不许读（docs/14）。
  //
  //  ⚠⚠ 短名长度上限：一级卡面左栏 46px ≈ 3 个字（实测「指哪抠哪」4 字被切）。
  //     `name` 一律 ≤3 字；`form` 因为格子宽 64px，可以到 4~5 字。
  var CAPS = Object.freeze([
    {
      id: 'color', name: '校色', ico: 'palette', swap: false, same: true,
      plain: '把颜色校准回原图的色调',
      // ⚠ 用户 10-04 定："校色是校准的意思"。三档完全一样（纯本机算法，零安装）。
      form: ['已内置', '已内置', '已内置'],
      tiers: ['本机算法', '本机算法', '本机算法'],
      note: '把 AI 图的颜色校准回原图色调。三档完全一样，不用下任何东西 —— 它是软件自带的。',
      need: { 1: null, 2: null, 3: null }
    },
    {
      id: 'align', name: '对齐', ico: 'grid', swap: false, same: false,
      plain: '修 AI 图的位置偏移',
      // 2026-10-24：精确对齐（光流）已删，三档都是快速对齐（docs/273）
      form: ['快速对齐', '快速对齐', '快速对齐'],
      tiers: ['网格对齐', '网格对齐', '网格对齐'],
      note: 'AI 出图时画面会有一点点偏移，它负责拉回来。它只做很轻的调整，不会把修好的脸又扭歪。',
      need: { 1: null, 2: null, 3: null }
    },
    {
      id: 'matting', name: '抠像', ico: 'scissors', swap: true,
      plain: '把人从背景里分出来',
      form: ['普通抠', '精确抠', '高精抠'],
      tiers: ['轻量 BiRefNet-lite 110M', '标准 1024 · BiRefNet-matting 467M', '高精 2048 · HR-matting-fp16 450M'],
      note: '把人从背景里抠出来。三档都装在同一个引擎里，不用另外装东西。',
      swapNote: '三档只能开一个，换了就把上一个换掉，电脑里永远只跑一个。',
      need: { 1: null, 2: '下 467M', 3: '下 450M + 12G 显卡内存' }
    },
    {
      id: 'segment', name: '人体', ico: 'person', swap: true,
      plain: '按部位分成头发、脸、衣服',
      form: ['快速分', '精确分', '精细分'],
      tiers: ['快 · segformer_b2 105M', '准 · SCHP 18/20 类 255M×2', '细 · Sapiens2 0.8b 3.1G'],
      note: '按部位拆图层（头发/脸/上衣/裤子…）。第三档比第一档细 6 倍。',
      swapNote: '三档只能开一个，换了就把上一个换掉。',
      need: { 1: null, 2: '下 510M', 3: '下 3.1G + 要 N 卡' }
    },
    {
      id: 'sam2', name: '分割', ico: 'crosshair', swap: true,
      plain: '你框哪里它就分哪里',
      // ⚠ 第三档 = 文字抠图（用户原话："文字选区，也就是打字去抠图"）。
      //   它【不是】另一样能力，是分割在最高档下的形态 —— 所以并进这一行，不另开一行。
      form: ['框一下', '框准点', '打字抠'],
      tiers: ['tiny 129M（约 37ms）', 'base+ 325M（配套解码器待确认）', 'large 849M（约 120ms）'],
      note: '你框哪它抠哪。第三档还能直接打名字（比如打"灯"）把画面里所有灯分出来。',
      swapNote: '三档只能开一个，换档时两个部分一起换。',
      need: { 1: null, 2: '下 20M 配套小件', 3: '下 849M + 8G 显卡内存' }
    },
    {
      id: 'detail', name: '细节还原', ico: 'sparkle', swap: false, same: true,
      plain: '把压掉的锐度补回来',
      form: [null, '补锐度', '补锐度'],
      // ⚠ 1 档没有它（null）—— 它是引擎独有的能力。
      // ⚠⚠ 藏意图（2026-10-04）：note 是【用户看得见的】文案，不许写"靠什么算出来的"。
      tiers: [null, '用原图高频补回锐度', '用原图高频补回锐度'],
      note: '⚠ 这一样不在基础档：它需要加速引擎，本机算法做不到。',
      need: { 1: '基础档没有这个能力', 2: null, 3: null }
    },
    {
      id: 'tween', name: '调强度', ico: 'wave', swap: false, same: true,
      // ⚠⚠ 用户 10-04 点名要它上表。它跟别的不一样：它不是"用户要开的能力"，
      //   是【调强度这个功能依赖的东西】—— 所以它没有开关，只有"能不能用"。
      plain: '把两张成品之间的强度拉成一条连续的量',
      form: [null, '可调', '可调'],
      tiers: [null, '在两张成品之间连续调', '在两张成品之间连续调'],
      note: '⚠ 这一样不在基础档：它需要加速引擎。基础档下只能整数档跳，不能连续调。',
      need: { 1: '基础档没有这个能力', 2: null, 3: null }
    },
    {
      id: 'matte', name: '精修边缘', ico: 'edge', swap: false, same: true,
      // ⚠⚠ 用户 10-04 原话："边缘精修归谁？我也不知道，现在就先放那吧。
      //   先让它作为一个独立的一个项目，或者是归到抠像，都可以。"
      //   ⇒ 先【独立成行】。将来要并进抠像，删掉这一项 + 把抠像第三档的 form 改成"精修边缘"即可。
      plain: '把抠出来的边修干净（头发丝、半透明）',
      form: [null, null, '修边'],
      tiers: [null, null, 'ViTMatte 精修边缘'],
      note: '⚠ 只有最高档有：抠完之后把边缘（头发丝、半透明的地方）修干净。',
      need: { 1: '基础档没有这个能力', 2: '拓展档也没有', 3: null }
    }
  ]);

  // 引擎里的能力名（matting-engine.js 的 KINDS）→ 这张卡的 id
  // ⚠ 这层换算只做一次，外面统一用本文件的 id。
  //   ⚠ 引擎那边 sam2 的 modelKind 是 'sam2-enc'，别直接拿 id 去问引擎。
  var WIRE = Object.freeze({
    matting: 'matting',
    segment: 'segment',
    sam2: 'sam2'
  });

  // ⭐⭐ 2026-10-06（Phase F）：「哪样能力归哪台引擎」的【唯一映射】。
  //   ⚠ 两台引擎是两个独立进程：match=校色引擎(37893) / matting=外挂引擎(37894)。
  //     一级卡面的框色、能力页里的引擎状态行、以后任何"这能力要哪台机器"的判断
  //     全读这一份 —— 在别处再写一份映射必然漂（本项目老坑）。
  var ENGINE_OF_CAP = Object.freeze({
    color: 'match', align: 'match', detail: 'match',
    matting: 'matting', segment: 'matting', sam2: 'matting',
    tween: 'matting', matte: 'matting'
  });
  function capEngine(capId) { return ENGINE_OF_CAP[capId] || ''; }
  // 这台引擎现在算不算"在跑"（界面共用）。
  function engineRunning(engine) {
    var s = (engine && engine.state) || '';
    return s === 'running' || s === 'old-code';
  }
  // ⭐ 一级卡面的框色（纯函数，可单测）：
  //   'ok'       绿框 —— 这行能力的引擎在跑
  //   'degraded' 黄框 —— 校色类：引擎没起 = 没有增强，但档 1 本机算法照常生成
  //   'off'      灰框 —— 抠像类：引擎没起 = 现在做不了（点开去启动）
  //   ⚠ 引擎"起了但缺依赖"也归 off/degraded，不新增第四种颜色；原因在能力页里说。
  function capEngineFrame(capId, engines) {
    var which = ENGINE_OF_CAP[capId] || '';
    if (!which) return 'off';
    var eng = (engines && engines[which]) || null;
    if (engineRunning(eng)) return 'ok';
    return which === 'match' ? 'degraded' : 'off';
  }

  // 引擎报的档位号 → 本卡的档位号。
  // ⚠ 引擎的档位是【按能力各自算】的（抠像档2 和 分割档2 是两个模型），
  //   而这张卡是【整层一个大档】。所以这里是"取严"：
  //   整层到第几档 = 所有【有的】能力里最低的那一个。有一项还停在 1 档，整层就是 1 档。
  //   ⚠ 不能让"抠像到 2 档了"就把整层说成 2 档 —— 人体解析可能还在 1 档。
  //
  // ⚠⚠ 0 要分两种情况，2026-10-01 自测时栽过：
  //   ① 引擎报 0 也可能是"这一类【完全没装】"（matting-engine 的 onnxModels 逻辑：
  //      显存不够 / 没有这一类的模型时报 0）。那不是"第 0 档"，不该把整层拖成 0。
  //   ② 但也可能整个引擎压根没起来（三样全 0）—— 那才真的是"不知道"。
  //   所以：0 的项【跳过不参与取最小】，只拿 >0 的项算；一个 >0 的都没有才返回 0。
  //   同时把跳过的项报给宿主，让界面能说"这台机器没有 X"而不是闭嘴。
  function tierFromEngine(snapshot) {
    var snap = snapshot || {};
    var tiers = snap.tiers || {};
    var present = [], missing = [];
    for (var key in WIRE) {
      if (!Object.prototype.hasOwnProperty.call(WIRE, key)) continue;
      var n = Number(tiers[key]) || 0;
      if (n > 0) present.push(n); else missing.push(key);
    }
    // 三样都没有 >0 的档位 → 不知道（引擎没起来 / 什么都没装）
    if (!present.length) return 0;
    var min = present[0];
    for (var i = 1; i < present.length; i++) if (present[i] < min) min = present[i];
    return min;
  }

  // 哪些能力这台机器【完全没有】（引擎报了 0）。界面用它说人话。
  function missingKinds(snapshot) {
    var snap = snapshot || {};
    var tiers = snap.tiers || {};
    var out = [];
    for (var key in WIRE) {
      if (!Object.prototype.hasOwnProperty.call(WIRE, key)) continue;
      if (!(Number(tiers[key]) > 0)) out.push(key);
    }
    return out;
  }

  // 装了哪些 → 各能力实际到第几档。
  // 引擎快照里的 tiers 是"引擎能给的最高档"，不是"这台机器实际能跑的"；
  // 显存不够时引擎会把档位降为 0（matting-engine 的 onnxModels 逻辑）。
  // 所以这里直接用引擎的 tiers，不再自己按显存算一遍 —— 两处算会漂。
  function installedMap(snapshot) {
    var snap = snapshot || {};
    var tiers = snap.tiers || {};
    var out = {
      matting: Number(tiers.matting) || 0,
      segment: Number(tiers.segment) || 0,
      sam2: Number(tiers.sam2) || 0,
      // ⭐ 2026-10-03 补：引擎早就在报这两个键了（multi_engine_server.py:2019-2021），
      //   但这边一直没读，于是「装了 SAM3 文字选区」卡面不知道。
      //   ⚠ 引擎的 tier 是【同一类能力里的第几档】，sam3/matte 各自只有一个模型，
      //     所以它们永远是 1 —— 判它们该看「在不在」，不能看 `< 3`。
      sam3: Number(tiers.sam3) || 0,
      matte: Number(tiers.matte) || 0,
      // ⭐ 2026-10-04 过渡帧（调强度用）。引擎 /health 报的键名就是 tween。
      //   ⚠ 跟 sam3/matte 一样只有一个模型，tier 恒为 1 —— 判"有没有"看 >0，别看 `< 3`。
      //   ⚠ 键名是中性词，别改回能反推算法的说法（见 docs/132 §五「重」档）。
      tween: Number(tiers.tween) || 0
    };
    return out;
  }

  // ⭐⭐ 2026-10-04 重排：每一样能力【在某个档下到底是什么形态】。
  //
  //  ⚠⚠ 这是新一级卡面唯一读的东西。原来卡面读 `tiers`（技术名），
  //    会把 BiRefNet / SCHP / Sapiens2 这些模型名带上卡面 —— 违反 docs/14。
  //    `form` 是【给用户看的形态名】，`tiers` 是【给二级页看的技术说明】，两套分开。
  //
  //  ⚠ 返回 null = 这一档没有这样能力（卡面画成"点不动"的暗格子）。
  function capForm(c, n) {
    if (!c || !c.form) return null;
    var v = c.form[n - 1];
    return v == null ? null : v;
  }

  // 一级卡面的纵轴：**全部**能力（不像老版那样把"三档一样"的压成一行）。
  //  ⚠ 用户 10-04 明确点名校色要上表（"校色是校准的意思"），所以不再压缩。
  //    8 行在 322 高的可用区里放得下（5 提示 + 50 表头 + 8×28 = 279）。
  //
  //  返回 [{id,name,ico,swap,same,plain,form,text,need,state,note,swapNote}]
  //    form = ⭐一级卡面唯一读的字段（形态名，比如"精确抠"）；null = 这一档没有它
  //    text = 二级页用的技术说明（模型名/尺寸），⚠ 卡面【不许读它】（docs/14）
  //
  // ⚠⚠ 2026-10-04 这里连着犯过两个错，都记下来：
  //   ① 写完新函数【忘了删旧的】—— 同一个名字在文件里出现两遍，后定义的覆盖前面的，
  //      我新加的 `form` 从来没生效过。语法过、不报错、只是每个格子都判成"没有"。
  //   ② 写完 `capForm` 忘了【导出】—— cards 那边 `C.capForm` 是 undefined，
  //      同样不报错、同样全判成"没有"。
  //   两个错都是探针【逐格数字符】才抓出来的（"text:0, none:24"）。
  //   教训：改完数据层，第一件事是量"卡面到底显示出了什么"，不是看代码有没有语法错。
  function capsInTier(n) {
    if (!TIERS[n]) return [];
    var k = Number(n);
    return CAPS.map(function (c) {
      var v = c.tiers[k - 1];
      var form = capForm(c, k);
      return {
        id: c.id, name: c.name, ico: c.ico, swap: c.swap,
        same: !!c.same,
        plain: c.plain || '',
        form: form,
        text: v || null, need: c.need ? c.need[k] : null,
        state: form ? 'on' : 'none',
        note: c.note, swapNote: c.swapNote || ''
      };
    });
  }

  // 这张卡要不要在【对照表】里占一行。
  //
  // ⚠⚠ 判据【只有一条真源：tiers 数据】，不要另设一个手写的 same 标记 ——
  //   两个地方判同一件事必然漂（我 2026-10-02 第一版就是又加了 same 标记又写这个函数，
  //   结果「细节还原」标着 same:true 却因为 1 档没有而占了对照行，自相矛盾）。
  //
  //   占行的两种理由：
  //     ① 三档文本不全一样（比如「细节还原」1 档没有、2/3 档有）→ 本身是个差异
  //     ② swap:true（三档互斥，只能开一份）→ 就算三档文本一样，也必须跨档显示，
  //        否则"只能开一档"这件事会被"三档都一样"那一行盖掉
  //   两种情况都不是 → 压进 sameCaps 那一行。
  //
  //   2026-10-02 为什么要有这条：卡面可用区 248×322，6 条对照行 + 详情实测溢出 122px。
  //     把"没差异"的行压掉，才腾得出详情的位置（用户要"对照表和详情都要看"）。
  function isComparable(c) {
    if (!c || !c.tiers) return false;
    if (c.swap) return true;                       // ① 互斥的必须跨档显示
    var first = c.tiers[0];
    for (var i = 1; i < 3; i++) if (c.tiers[i] !== first) return true;   // ② 三档有差异
    return false;
  }

  // 需要占对照行的能力（顺序照 CAPS 原顺序，不加塞）。
  function comparableCaps() {
    return CAPS.filter(isComparable);
  }

  // 三档完全一样、且三档都有的能力 → 压成一行显示。
  // ⚠ 空数组 = 没有这类能力，界面就不画那一行（别画一个空框）。
  function sameCaps() {
    return CAPS.filter(function (c) {
      if (isComparable(c)) return false;
      return !!c.tiers[0];   // 三档都有（[null,null,null] 的排除掉）
    });
  }

  // 「升 N 档可换」提示：当前档用不了、但更高档有，找最近的那个。
  // 返回 0 = 没有任何更高档有它。
  function higherTierWith(id, from) {
    var c = null;
    for (var i = 0; i < CAPS.length; i++) if (CAPS[i].id === id) { c = CAPS[i]; break; }
    if (!c) return 0;
    for (var n = Number(from) + 1; n <= 3; n++) if (c.tiers[n - 1]) return n;
    return 0;
  }

  // 引擎到底在不在跑。
  //
  // ⚠⚠⚠ 2026-10-04 用户实测报的 bug：**本地模型全都在（16/16 present），
  //   但外挂卡上显示"需要下载"**。
  //   真因：引擎没启动时 /health 探不到 → tiers 全是 0 →
  //   下面的 tierInstalled 就判成"没装" → 卡面挂出下载按钮。
  //   这等于把「引擎没开」说成了「模型没下」—— 用户会白下一遍 17G。
  //
  // ⇒ 分清三件事：
  //     引擎在跑 + 档位够   = 装好了
  //     引擎在跑 + 档位不够 = 真的缺（这时说"需要下载"才对）
  //     **引擎没跑           = 不知道**（要说"引擎没运行"，不能说"需要下载"）
  function engineUp(snapshot) {
    var snap = snapshot || {};
    if (snap.available === true || snap.multiCapable === true) return true;
    var tiers = snap.tiers || {};
    for (var k in tiers) {
      if (Object.prototype.hasOwnProperty.call(tiers, k) && Number(tiers[k]) > 0) return true;
    }
    return false;
  }

  // 这一档装了没。
  // ⚠ 判据：【这一档需要的东西，引擎全都有了】。
  //   1 档永远算装了（纯算法，不需要下任何东西）—— 这是 1 档的定义，不是特例。
  function tierInstalled(n, snapshot) {
    if (Number(n) === 1) return true;
    var t = installedMap(snapshot);
    if (Number(n) === 2) return t.matting >= 2 || t.segment >= 2;
    if (Number(n) === 3) return t.matting >= 3 || t.segment >= 3 || t.sam2 >= 3;
    return false;
  }

  // 这一档缺什么（底栏/徽章要显示的人话）。
  // ⚠ 返回空串 = 不缺。
  function tierMissing(n, snapshot) {
    if (Number(n) === 1) return '';
    var t = installedMap(snapshot);
    var parts = [];
    if (Number(n) === 2) {
      if (t.matting < 2) parts.push('精确抠');
      if (t.segment < 2) parts.push('精确分');
    } else if (Number(n) === 3) {
      if (t.matting < 3) parts.push('高精抠');
      if (t.segment < 3) parts.push('精细分');
      // ⚠⚠ 2026-10-03 修「张冠李戴」：这里原来写的是 `if (t.sam2 < 3) parts.push('SAM3')`。
      //   但 sam2 是【分割 / 指哪抠哪】，sam3 是【打英文词把画面里符合的全分出来】——
      //   两样完全不同的能力。原来的写法会导致：
      //     · 用户装了 SAM3 文字选区，卡面不会认为 3 档多了什么
      //     · 卡面说"还差 SAM3"时，其实是在说"你的分割还没升到 large"
      //   现在分开判：分割看 sam2 的档位，打字抠看 sam3【在不在】。
      //   ⚠ sam3/matte/tween 在引擎里 tier 恒为 1（各自只有一个模型），所以只能判 >0。
      if (t.sam2 < 3) parts.push('打字抠');
      if (!(t.sam3 > 0)) parts.push('打字抠的模型');
      if (!(t.matte > 0)) parts.push('精修边缘');
    }
    return parts.length ? ('还差 ' + parts.join('、')) : '';
  }

  // 引擎现在用什么算：CPU 还是显卡。
  //
  // ⭐ 2026-10-02 补（docs/114 第 3 件、findings 第一条「显卡白买了」）：
  //   这台 5090 上实测 ONNX 那三样（抠像/人体/分割）一直在 CPU 上跑，慢 1.66 倍，
  //   而且是【静默】的 —— 引擎只在自己的日志里喊，用户永远看不到。
  //   这个函数只判断「要不要明说」，怎么说由卡面决定（卡面只写人话，细节进二级）。
  //
  //   返回 { known, onCpu, label, detail }
  //     known  = false：引擎没开 / 没探测到 → 不知道，【别乱说】
  //     onCpu  = true ：确实在 CPU 上算
  //     detail ：给二级页看的技术说明（后端名 + 引擎给的原因）
  //
  // ⚠ 判据用 provider（ONNX 实际选中的后端），device 只做兜底 ——
  //   device 是给人看的名字（"CPU (onnxruntime)"、"NVIDIA … (CUDA)"），措辞可能变；
  //   provider 是 onnxruntime 的固定名字。
  function computeDevice(snapshot) {
    var s = snapshot || {};
    if (!s.available) return { known: false, onCpu: false, label: '', detail: '' };
    var provider = String(s.provider || '');
    var device = String(s.device || '');
    var onCpu;
    if (provider) onCpu = provider === 'CPUExecutionProvider';
    else onCpu = /^cpu\b/i.test(device) || device === '';
    // ⚠⚠ 2026-10-05 用户报"还是留了大量的专有名词"：
    //   这里原来会把 CUDA / DirectML / CPUExecutionProvider 这几个
    //   【运行时名字】直接印给用户看。用户不需要知道后端叫什么 ——
    //   他只需要知道一件事：**这台机器是拿显卡算，还是拿 CPU 算（慢一些）**。
    //   provider 仍然照原样返回，留给排查用；但 detail 只出"显卡 / CPU"。
    var detail = '抠像、人体、分割这些' + (onCpu
      ? '现在用 CPU 算，会比用显卡慢一些。'
      : '现在用显卡算。');
    return { known: true, onCpu: onCpu, label: onCpu ? '用 CPU 算 · 会慢些' : '', detail: detail };
  }

  // 这一档有几样能力是真能用的（底栏 "6/8 样能用" 的那个 6）。
  // ⚠ 数的是【这一档有它的】，不是【装了模型】——
  //   基础档那几样里绝大多数是纯算法，它们不需要装任何东西。
  // ⚠⚠ 2026-10-04 判据从 `text` 改成 `form`：卡面现在显示的是 `form`（形态名），
  //   而 `text` 是二级页的技术说明。两套数据必须【同生共死】——
  //   CAPS 里出现过 form 有值但 tiers 是 null 的情况就会数错。
  //   这里以 form 为准（它是卡面真源），并顺手校验一下两者是否一致（不一致写一行 console）。
  function usableCount(n) {
    var list = capsInTier(n);
    var k = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].form) k++;
      else if (list[i].text && typeof console !== 'undefined') {
        // ⚠ 静默不一致是本项目最忌的形态 —— 至少留一行，别让它无声无息
        console.warn('[外挂卡] ' + list[i].id + ' 第 ' + n + ' 档有 tiers 却没有 form，卡面会显示成"没有"');
      }
    }
    return k;
  }

  // 整层的一句话状态（一级卡顶上的「当前 N 档 xxx」）。
  function statusLine(n, snapshot) {
    var T = TIERS[n];
    if (!T) return { tier: 0, head: '还没探测', sub: '点下面的档位看看', ok: false };
    return { tier: T.n, head: T.head, sub: T.sub, ok: tierInstalled(n, snapshot) };
  }

  // 这一档要用到哪些引擎模型 key（算磁盘占用用）。
  // ⚠ 这是【产品三档 → 引擎模型】的唯一映射，别在别处再写一份（两处必然漂）。
  //   键名照 engine/multi_engine_server.py 的 MODELS 表：
  //     1 档 = 轻量抠像 + 快解析 + 分割 tiny（纯算法不进这里，它们零安装）
  //     2 档 = 标准抠像 + SCHP 双套 + 分割 base（含配套解码器）
  //     3 档 = 高精抠像 + Sapiens2 + 分割 large + SAM3 文字选区 + ViTMatte
  //   ⚠ 解码器必须算进去 —— 编码器单独一个是不工作的（引擎的 decoder_ready 会拦）。
  var TIER_MODELS = Object.freeze({
    1: ['matting-lite', 'segment-segformer', 'sam2-tiny-enc'],
    2: ['matting-std', 'segment-schp-atr', 'segment-schp-lip', 'sam2-base-enc'],
    3: ['matting-hr', 'segment-sapiens', 'sam2-large-enc', 'sam3-text', 'matte-vitmatte']
  });

  // 磁盘 / 显存合计（二级卡底栏）。
  //
  // ⭐ 2026-10-03：disk 改成【自动算】。以前 0 / 3.9 / 10.6 三个数是写死的
  //   （从 docs/92 的实测抄来，只算 ONNX 那条线，不含 Python 环境），
  //   加模型不会自动更新，而且跟引擎表对不上账。
  //   现在从引擎快照的 models[].bytes 实时累加。
  //   ⚠ 快照里没有这个模型（引擎没开 / 还没装）→ 那个模型算 0 字节，
  //     回落到 TIERS 里那三个静态数（宁可显示旧数字，也不能显示 0 骗人）。
  function footprint(n, snapshot) {
    var T = TIERS[n] || {};
    var models = (snapshot && snapshot.models) || null;
    var keys = TIER_MODELS[Number(n)] || [];
    var sum = 0, counted = 0;
    if (models && keys.length) {
      for (var i = 0; i < keys.length; i++) {
        var item = models[keys[i]];
        if (item && Number(item.bytes) > 0) { sum += Number(item.bytes); counted++; }
      }
    }
    // 一个都没数到 → 用静态值（绝不能拿"没探测到"当"占 0G"）
    var diskGB = counted ? Math.round(sum / 1024 / 1024 / 1024 * 10) / 10 : (T.disk || 0);
    return { disk: diskGB, gpu: T.gpu || 0, gpuText: T.gpuText || '不挑显卡', measured: !!counted };
  }

  // 全三档的表（二级卡「三档各要什么」那张表）。
  function tierTable(snapshot) {
    return [1, 2, 3].map(function (n) {
      var T = TIERS[n];
      var fp = footprint(n, snapshot);
      return {
        n: n, head: T.head, dev: T.dev, ico: T.ico,
        disk: fp.disk,          // ⭐ 同上：跟底栏用同一个数，别一处算一处写死
        installed: tierInstalled(n, snapshot)
      };
    });
  }

  // ============================================================
  //  下载清单：能不能下、为什么不能下
  //  ⚠⚠ 这条是用户 2026-10-01 特意点名的坑：
  //     "按钮点得动但点了没反应"是本项目最忌讳的故障形态。
  //     model-downloads.json 空着的时候，按钮必须【禁用并写明原因】，
  //     绝不能让它看起来能点。
  // ============================================================
  function downloadState(catalog, key) {
    var items = (catalog && catalog.models) || {};
    var item = items[key];
    if (!item) return { can: false, reason: '这台机器上没登记这个模型' };
    var d = item.download || {};
    if (!d.available) return { can: false, reason: d.reason || '还没有可信的下载地址和校验值' };
    if (item.state === 'present') return { can: true, reason: '', installed: true, bytes: item.bytes };
    if (item.state === 'broken') return { can: true, reason: '文件在，但校验没过，可以重下', installed: false, bytes: item.bytes };
    return { can: true, reason: '', installed: false, bytes: d.bytes || 0 };
  }

  // 人话的体积
  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n <= 0) return '';
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'K';
    if (n < 1024 * 1024 * 1024) return Math.round(n / 1024 / 1024) + 'M';
    return (Math.round(n / 1024 / 1024 / 1024 * 10) / 10) + 'G';
  }

  // ============================================================
  //  下载三件事：清单兜底 / 测速判定 / 走哪条路（docs/128 §三-3）
  //
  //  ⚠ 这三件都放在这一层，是因为它们是【纯换算】，能在 node 里单测。
  //    2026-10-03 之前的教训：把判定写进界面里，改一次就得起 Electron 才验得了，
  //    而且"不同参数数字完全一致"这种度量坏掉的情况看不出来。
  // ============================================================

  // 默认的测速门槛。跟后台「模型下载」页那三个数是同一组，
  // 后台没配的时候用这份。
  var DOWNLOAD_DEFAULTS = Object.freeze({
    speedThresholdKBps: 200, probeBytes: 1048576, probeTimeoutMs: 3000
  });

  // 后台清单 + 内置清单合起来。
  //
  // ⚠⚠ 为什么要有兜底：后台挂了 / 没登录 / 网络不通的时候，
  //    如果清单空了，用户看到的就是"这一档装不了" —— 明明模型地址是写死在
  //    engine/model-downloads.json 里的。所以内置那份永远垫底。
  // ⚠ 谁优先：后台的赢。后台是运维改得动的那一份，改地址不用发版。
  // ⚠ 合并粒度到【单个模型】，不是整份替换 ——
  //    后台只补了插帧一个模型的时候，别的模型不能被清空。
  function mergeManifests(builtin, remote) {
    var out = { models: {}, fallback: {} };
    var i, key;
    for (key in DOWNLOAD_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DOWNLOAD_DEFAULTS, key)) {
        out.fallback[key] = DOWNLOAD_DEFAULTS[key];
      }
    }
    var base = (builtin && builtin.models) || {};
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) out.models[key] = base[key];
    }
    var fb = (remote && remote.fallback) || {};
    for (key in fb) {
      if (Object.prototype.hasOwnProperty.call(fb, key) && Number(fb[key]) > 0) out.fallback[key] = Number(fb[key]);
    }
    var over = (remote && remote.models) || {};
    for (key in over) {
      if (Object.prototype.hasOwnProperty.call(over, key)) {
        // 后台那条覆盖内置的同名条目（整条替换，不做字段级合并 ——
        // 半个新半个旧拼出来的清单最容易出现"大小是新的、摘要是旧的"）
        var item = over[key] || {};
        var merged = {};
        for (var f in item) {
          if (Object.prototype.hasOwnProperty.call(item, f)) merged[f] = item[f];
        }
        // 内置那条的本地信息（state/bytes）要保留 —— 那是引擎探测出来的，后台不知道
        var local = base[key] || {};
        if (merged.state === undefined && local.state !== undefined) merged.state = local.state;
        if (merged.bytes === undefined && local.bytes !== undefined) merged.bytes = local.bytes;
        out.models[key] = merged;
      }
    }
    return out;
  }

  // 测速结果 → 走哪条路。
  //
  //   入参：{ bytes, ms, ok, error }
  //   判定顺序【不能换】：
  //     1. 压根没测成（连不上 / 超时）→ 兜底
  //     2. 下够了试块但慢于门槛        → 兜底
  //     3. 够快                        → 主地址
  //
  // ⚠ "3 秒还没下完 1MB" 要单独算慢，不能只看算出来的 KB/s ——
  //   没下完的时候字节数是残缺的，拿它算速率会得到一个虚高的数，
  //   结果"很慢的连接"被算成"很快"。这是 2026-10-03 设计时点出来的坑。
  function classifySpeed(probe, fallback) {
    var cfg = fallback || DOWNLOAD_DEFAULTS;
    var p = probe || {};
    var want = Number(cfg.probeBytes) || DOWNLOAD_DEFAULTS.probeBytes;
    var line = Number(cfg.speedThresholdKBps) || DOWNLOAD_DEFAULTS.speedThresholdKBps;
    if (!p.ok) {
      return { route: 'pan', reason: 'connect', speedKBps: 0,
               text: '连不上下载服务器' + (p.error ? '（' + p.error + '）' : '') };
    }
    var got = Number(p.bytes) || 0;
    var ms = Number(p.ms) || 0;
    if (got < want) {
      // 没下完就返回了 —— 要么被掐，要么就是慢。两种都当"慢"处理。
      return { route: 'pan', reason: 'incomplete', speedKBps: speedOf(got, ms),
               text: '下载太慢，试了一小块就没下完' };
    }
    var speed = speedOf(got, ms);
    if (speed < line) {
      return { route: 'pan', reason: 'slow', speedKBps: speed,
               text: '网速 ' + Math.round(speed) + ' KB/秒，比 ' + line + ' KB/秒 慢' };
    }
    return { route: 'direct', reason: 'fast', speedKBps: speed,
             text: '网速 ' + Math.round(speed) + ' KB/秒，够快' };
  }

  // 一次测速拿到的字节数 / 毫秒 → KB/秒。⚠ ms 为 0 时返回 0，不能除出 Infinity。
  function speedOf(bytes, ms) {
    var n = Number(bytes) || 0, t = Number(ms) || 0;
    if (n <= 0 || t <= 0) return 0;
    return n / 1024 / (t / 1000);
  }

  // 兜底卡上要显示的东西。⚠ 链接和提取码【从清单来】，页面里一个都不许写死 ——
  // 写死了换个网盘就得重新发版。
  function fallbackCard(model, decision) {
    var item = model || {};
    return {
      title: '这次走网盘拿模型',
      why: (decision && decision.text) || '下载服务器太慢',
      link: item.panLink || '',
      code: item.panCode || '',
      // 用户原话"告诉用户放哪" —— 说人话，不写"路径/目录结构"
      steps: [
        '点下面的「复制链接」，在浏览器里打开',
        '下载后解压，会得到一个文件夹',
        '点「打开模型文件夹」，把解压出来的文件夹整个拖进去，覆盖就行'
      ],
      // 没配网盘链接时如实说，不能给个空按钮让人点
      missing: item.panLink ? '' : '这个模型还没配网盘链接，先找客服'
    };
  }

  // 清单里这个模型最快的那条地址（主地址排第一）。
  // ⚠ 只认 https —— http 会被引擎直接拒掉（model_manager 的 HTTPSOnly）。
  function primarySource(item) {
    var files = (item && item.files) || [];
    for (var i = 0; i < files.length; i++) {
      var sources = files[i].sources || [];
      for (var j = 0; j < sources.length; j++) {
        if (/^https:\/\//i.test(String(sources[j] || ''))) return sources[j];
      }
    }
    // 兼容老形状：单个 url 字段
    if (item && /^https:\/\//i.test(String(item.url || ''))) return item.url;
    return '';
  }

  return {
    TIERS: TIERS, CAPS: CAPS, WIRE: WIRE,
    // ⭐ Phase F 修：TIER_MODELS 一直没导出 —— 它是"档位 → 引擎模型 key"的唯一映射，
    //   前端两处（卡面的文件检测 / ui.html 的测速选路 enginesFirstDownloadable）都在读它，
    //   没导出时两处都静默变成 []（一个显示不出"装好了"，一个永远直连不测速）。
    TIER_MODELS: TIER_MODELS,
    // ⭐ Phase F：能力 → 引擎 的唯一映射 + 卡面框色纯函数
    ENGINE_OF_CAP: ENGINE_OF_CAP,
    capEngine: capEngine,
    engineRunning: engineRunning,
    capEngineFrame: capEngineFrame,
    tierFromEngine: tierFromEngine,
    missingKinds: missingKinds,
    installedMap: installedMap,
    capsInTier: capsInTier,
    // ⭐⭐ 2026-10-04 重排新增：一级卡面唯一读的东西（形态名）。
    //   ⚠⚠ 我第一版写了这个函数却忘了导出 —— 结果卡面那边 `C.capForm` 是 undefined，
    //     24 个格子全判成"这一档没有"，整张表变成一片叉。**不报错，只是全错**。
    //     这正是本项目最忌的静默失效形态（铁律 17）。探针逐格数文字才抓出来。
    capForm: capForm,
    // ⭐ 2026-10-02 卡面重排新增（见 CAPS 上面那段注释）
    isComparable: isComparable,
    comparableCaps: comparableCaps,
    sameCaps: sameCaps,
    higherTierWith: higherTierWith,
    tierInstalled: tierInstalled,
    engineUp: engineUp,
    tierMissing: tierMissing,
    computeDevice: computeDevice,
    usableCount: usableCount,
    statusLine: statusLine,
    footprint: footprint,
    tierTable: tierTable,
    downloadState: downloadState,
    humanSize: humanSize,
    // ⭐ 2026-10-03 新增（docs/128 §三-3）：客户端下载 + 测速 + 网盘兜底
    DOWNLOAD_DEFAULTS: DOWNLOAD_DEFAULTS,
    mergeManifests: mergeManifests,
    classifySpeed: classifySpeed,
    speedOf: speedOf,
    fallbackCard: fallbackCard,
    primarySource: primarySource
  };
});
