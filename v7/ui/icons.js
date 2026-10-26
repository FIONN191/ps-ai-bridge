/* ═══════════════════════════════════════════════════════════════
   icons.js —— 原创矢量图标库（window.ICON）
   2026-09-14 建立。替换全项目的 emoji / 文本符号图标。

   设计语言完整版见 docs/43_图标设计语言.md，这里只写代码约定。

   ⭐ 三条硬约定
   ① 全部画在 24×24 网格上，viewBox="0 0 24 24"。缩放靠 width/height，不改 viewBox。
   ② 颜色一律 currentColor（跟随文字色）。语义色由外面的容器给，图标自己不写死颜色。
   ③ 一个图标可以拆成【多个部件】(parts)，每个部件是独立的 <g class="ip0/ip1/...">。
      部件的意义：让动画能只动其中一部分（齿轮整体转 / 大脑只有内部线条亮）。
      ⚠ 部件顺序 = 绘制顺序 = z 序，后面的盖前面的。

   ⚠ 不要在这里写动画。动画全部在 motion.js —— 那边要按"当前帧"接管，
     必须由 JS 掌握相位，写在 CSS/SVG 里就交不出相位了。

   ⚠ UXP 侧不许 require 这个文件（它是浏览器环境的）。这是桌面板专属。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── 画图小工具 ───────────────────────────────────────────────
  // p() 路径 / c() 圆 / r() 圆角矩形 / l() 直线
  const p = d => '<path d="' + d + '"/>';
  const c = (x, y, rr) => '<circle cx="' + x + '" cy="' + y + '" r="' + rr + '"/>';
  const r = (x, y, w, h, rd) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (rd == null ? 3 : rd) + '"/>';
  const l = (x1, y1, x2, y2) => '<path d="M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2 + '"/>';
  // 实心部件（少数图标需要，如选中的星星）
  const fill = s => '<g fill="currentColor" stroke="none">' + s + '</g>';

  /* ═══════════════════════════════════════════════════════════
     图标定义表
     每项: [部件1, 部件2, ...]  —— 数组长度 = 部件数
     命名规矩见 docs/43：用【物】不用【功能】(gear 不叫 settings)，
     这样同一个图标能用在多处，不会出现"设置图标用在别的地方名字不对"。
     ═══════════════════════════════════════════════════════════ */
  const G = {};

  // ── 五张主卡的身份图标（大图标，有专属循环动画）──────────────
  // 生成 = 魔棒 + 星火。⚠ 部件拆法是为了动画：棒身不动、星火依次闪。
  G.wand = [
    p('M5 19 15.5 8.5'),                                    // 棒身
    p('m14 7 3 3'),                                         // 棒头箍
    p('M18 3.5v3M16.5 5h3'),                                // 星火大
    p('M20.5 9v2M19.5 10h2'),                               // 星火中
    p('M15.5 2.5v1.5M14.75 3.25h1.5')                       // 星火小
  ];
  // 预设 = 人形剪影（对应剪影卡）
  G.person = [
    c(12, 5.2, 2.6),                                        // 头
    p('M12 8v7'),                                           // 躯干
    p('m12 9-4 2m4-2 4 2'),                                 // 手臂
    p('m12 15-2.5 6m2.5-6 2.5 6')                           // 腿
  ];
  // 设置 = 齿轮 — GPT 80→24。ip0=齿盘, ip1=内圈, ip2=缺口线
  G.gear = [
    p('M10.26 5.94 10.59 4.02H13.41L13.74 5.94A6.3 6.3 0 0 1 15.05 6.49L16.65 5.36 18.64 7.35 17.51 8.95A6.3 6.3 0 0 1 18.06 10.26L19.98 10.59V13.41L18.06 13.74A6.3 6.3 0 0 1 17.51 15.05L18.64 16.65 16.65 18.64 15.05 17.51A6.3 6.3 0 0 1 13.74 18.06L13.41 19.98H10.59L10.26 18.06A6.3 6.3 0 0 1 8.95 17.51L7.35 18.64 5.36 16.65 6.49 15.05A6.3 6.3 0 0 1 5.94 13.74L4.02 13.41V10.59L5.94 10.26A6.3 6.3 0 0 1 6.49 8.95L5.36 7.35 7.35 5.36 8.95 6.49A6.3 6.3 0 0 1 10.26 5.94Z'),
    c(12, 12, 2.4),
    '<g opacity=".55">' + p('M11.1 12h1.8') + '</g>'
  ];
  // 加速引擎 — GPT 80→24。ip0=推力线, ip1=基座, ip2=活塞+闪电, ip3=卡环, ip4=充能线
  G.bolt = [
    '<g opacity=".45">' + p('M10.2 18.6v1.2M13.8 18.6v1.2') + '</g>',
    p('M7.5 14.7v3h9V14.7'),
    r(9, 6.6, 6, 9, 0.6) + fill('<path d="m12.3 7.8-2.1 3.3h1.8l-.3 2.4 2.4-3.6h-1.8Z"/>'),
    fill('<rect x="6.9" y="12.9" width="10.2" height="1.5" rx=".3"/>'),
    '<g opacity=".55">' + p('M12 4.2v1.2') + '</g>'
  ];
  // 全部历史 — GPT 80→24。ip0=卷轴头, ip1=纸面, ip2=光标线, ip3=表盘, ip4=时针
  G.scroll = [
    '<g opacity=".55">' + p('M5.7 7.8v-2.1h11.4v2.1') + '</g>',
    p('M6.6 7.8h9.6v9.9H6.6Z'),
    '<g opacity=".7">' + p('M8.7 10.8h3.6M8.7 13.2h2.4') + '</g>',
    c(16.8, 15.9, 3.9),
    p('M16.8 14.1v1.8l-1.5.6')
  ];

  // ── 二级分区图标（24px，小图标简单效果）─────────────────────
  // 星火(生成图片) — GPT 80→24 缩放。ip0=画框+山, ip1=星火, ip2=光线
  G.sparkles = [
    p('M15.3 7.2H5.4v10.2h11.4V12') + p('m7.2 14.7 3-3.3 4.2 3.9'),
    fill('<path d="m17.4 4.8 .9 2.4 2.4 .9-2.4 .9-.9 2.4-.9-2.4-2.4-.9 2.4-.9Z"/>'),
    '<g opacity=".55">' + p('M3.6 6v1.2M18.6 16.5v1.2') + '</g>'
  ];
  // 参考图片 — GPT 80→24。ip0=叠层卡+山, ip1=箭头, ip2=扫描线
  G.image = [
    '<g opacity=".55">' + p('M7.2 6.3h11.1v9.6') + '</g>' +
      p('M4.8 8.7h11.1v9.9H4.8Z') + p('m6.6 15.3 2.7-2.7 3 3'),
    p('M11.7 2.7v5.1m-1.8-1.8 1.8 1.8 1.8-1.8'),
    '<g opacity=".42">' + p('M6.6 16.8h7.5') + '</g>'
  ];
  // 生成结果 — GPT 80→24。ip0=盒体+中线, ip1=内核, ip2=盖板, ip3=爆线
  G.package = [
    p('m5.7 11.4 6.3 3 6.3-3v6.6L12 21 5.7 18Z') +
      '<g opacity=".55">' + p('M12 14.4v6.6') + '</g>',
    '<g opacity=".2">' + fill('<path d="m12 9.3 2.1 2.4-2.1 3-2.1-3Z"/>') + '</g>',
    fill('<path d="m5.7 9.9 6.3-3 6.3 3-6.3 3Z"/>'),
    '<g opacity="0">' + p('M9 4.5v-1.2m6 1.2v-1.2') + '</g>'
  ];
  // 使用说明 — GPT 80→24。ip0=书+脊线, ip1=底圈, ip2=叹号
  G.info = [
    p('M4.5 7.2h4.2c1.5 0 2.7.6 3.3 1.5.6-.9 1.8-1.5 3.3-1.5h4.2v9.3H15.3c-1.5 0-2.7.6-3.3 1.5-.6-.9-1.8-1.5-3.3-1.5H4.5Z') +
      '<g opacity=".55">' + p('M12 8.7v9.3') + '</g>',
    c(12, 12.9, 3.9),
    p('M12 10.5v.03M12 12.6v2.4')
  ];
  // 连接与账号 — GPT 80→24。ip0=竖线, ip1=上扣, ip2=下扣, ip3=节点, ip4=脉冲
  G.keyhole = [
    '<g opacity=".55">' + p('M12 8.7v6.6') + '</g>',
    p('M8.7 10.8v-1.8a3.3 3.3 0 0 1 6.6 0v1.8'),
    p('M8.7 13.2v1.8a3.3 3.3 0 0 0 6.6 0v-1.8'),
    fill('<circle cx="12" cy="12" r="1.2"/>'),
    '<g opacity=".55">' + p('M4.8 12h1.8m10.8 0h1.8') + '</g>'
  ];
  // 生成与传回 — GPT 80→24。ip0=画框, ip1=选区标, ip2=底线, ip3=传回箭头, ip4=像素块
  G.palette = [
    r(5.1, 6.3, 9.6, 10.2, 0.6),
    '<g opacity=".55">' + p('M7.5 11.1v-2.4h2.4m2.4 3v2.4h-2.4') + '</g>',
    '<g opacity=".55">' + p('M6.3 18.9h7.2') + '</g>',
    p('M18.6 8.4v7.8m-2.1-2.1 2.1 2.1 2.1-2.1'),
    fill('<rect x="17.7" y="4.8" width="1.8" height="1.8" rx=".3"/>')
  ];
  // 外观与交互 — GPT 80→24。ip0=后板, ip1=前板, ip2=导轨, ip3=把手, ip4=角标
  G.monitor = [
    '<g opacity=".55">' + r(7.2, 6, 9, 8.4, 0.6) + '</g>',
    r(5.1, 8.7, 9.6, 8.4, 0.6),
    '<g opacity=".55">' + p('M18.9 6.3v12') + '</g>',
    r(17.4, 10.5, 3, 3, 0.6),
    p('M3.3 10.5V6.9h3.6m5.7 12h3.9V15.3')
  ];
  // 工具与隐私 — GPT 80→24。ip0=盾, ip1=钥匙, ip2=上挡板, ip3=下挡板, ip4=封印, ip5=侧钉
  G.shield = [
    p('m5.7 6.9 6.3-2.7 6.3 2.7v5.7c0 3.6-2.4 6.6-6.3 8.4-3.9-1.8-6.3-4.8-6.3-8.4Z'),
    fill('<path d="M10.5 8.7a2.4 2.4 0 0 0 .3 4.5v3.6a1.2 1.2 0 0 0 2.4 0V13.2a2.4 2.4 0 0 0 .3-4.5v2.7H10.5Z"/>'),
    '<g fill="currentColor" stroke="none" opacity=".35"><rect x="7.2" y="5.1" width="9.6" height="3.3"/></g>',
    '<g fill="currentColor" stroke="none" opacity=".35"><rect x="7.2" y="17.7" width="9.6" height="4.2"/></g>',
    '<g opacity="0">' + p('m10.2 12.3 1.2 1.2 2.4-2.7') + '</g>',
    '<g opacity=".6">' + p('M3.3 10.8v3M20.7 10.8v3') + '</g>'
  ];
  // 对齐与校色 — GPT 80→24。ip0=四角框, ip1=暗条, ip2=灰条, ip3=亮条, ip4=扫描箭头
  G.crosshair = [
    p('M4.8 7.5v-2.7h2.7M16.5 4.8h2.7v2.7M4.8 16.5v2.7h2.7M16.5 19.2h2.7v-2.7'),
    '<rect x="6.9" y="10.2" width="3" height="7.2" rx=".3" fill="currentColor" fill-opacity=".33" stroke="none"/>',
    '<rect x="10.5" y="7.8" width="3" height="7.2" rx=".3" fill="currentColor" fill-opacity=".67" stroke="none"/>',
    '<rect x="14.1" y="5.4" width="3" height="7.2" rx=".3" fill="currentColor" stroke="none"/>',
    p('m4.2 11.4 1.2 1.2-1.2 1.2m15.6-2.4-1.2 1.2 1.2 1.2')
  ];
  G.target = [c(12, 12, 8.4), c(12, 12, 4.6), c(12, 12, 1.2)];

  // ── 报错/状态 ────────────────────────────────────────────────
  G.check = [p('M4.5 12.5 9.5 17.5 19.5 6.5')];
  G.warning = [p('M12 3.5 21.5 20H2.5z'), p('M12 9.5v5'), c(12, 17.2, 1)];
  G.close = [p('M6 6l12 12M18 6 6 18')];
  G.cross = [p('M6 6l12 12M18 6 6 18')];       // 同形，语义不同（关闭 vs 失败），命名分开便于以后各自改
  G.hourglass = [
    p('M7 3.5h10M7 20.5h10'),
    p('M8 3.5v3.2c0 2 4 3.4 4 5.3s-4 3.3-4 5.3v3.2m8-17v3.2c0 2-4 3.4-4 5.3s4 3.3 4 5.3v3.2')
  ];
  G.refresh = [
    p('M20 12a8 8 0 1 1-2.6-5.9'),
    p('M20.5 3.5v4h-4')
  ];

  // ── 文本符号的替代 ──────────────────────────────────────────
  G.arrowLeft = [p('M19 12H5.5'), p('m11 5.5-5.5 6.5 5.5 6.5')];
  G.arrowRight = [p('M5 12h13.5'), p('m13 5.5 5.5 6.5-5.5 6.5')];
  G.arrowDown = [p('M12 5v13.5'), p('m5.5 12 6.5 6.5 6.5-6.5')];
  G.arrowUp = [p('M12 19V5.5'), p('m5.5 12 6.5-6.5 6.5 6.5')];
  // 还原/重置 = 逆时针回环箭头
  G.revert = [p('M4 12a8 8 0 1 0 2.6-5.9'), p('M3.5 3.5v4h4')];
  // 播放/开始 = 三角
  G.play = [p('M8 5.5 18.5 12 8 18.5z')];
  // 停止 = 方块
  G.stop = [r(6.5, 6.5, 11, 11, 2)];
  // 新建 = 加号
  G.plus = [p('M12 5.5v13M5.5 12h13')];
  // 扳手 = 工具类。⭐ 剪影上的「工具」模块用它（抠像/以后的外挂模型都挂这个类别）
  // ⚠ 开口朝左上、柄朝右下 —— 和齿轮(设置)在形状上要分得开，
  //   两个都是"工具感"的图标，放一起容易认错。
  G.wrench = [
    p('M15.5 3.2a5.6 5.6 0 0 0-5 8.2L3.5 18.4a2 2 0 0 0 2.8 2.8l7-7a5.6 5.6 0 0 0 7-7l-3.1 3.1-2.8-.7-.7-2.8 3.1-3.1a5.6 5.6 0 0 0-1.3-.5Z'),
    c(5.6, 18.4, 1)   // 柄尾那个小圆点，给动画用（点按时闪一下）
  ];
  // 挂锁（工具与隐私）。⚠ 和 keyhole 不同：那个是"钥匙孔"，这个是"锁"
  G.lock = [
    p('M8 10.5V7.5a4 4 0 0 1 8 0v3'),
    r(5, 10.5, 14, 9.5, 2.5),
    c(12, 15, 1.4)
  ];
  G.arrowUpRight = [p('M6.5 17.5 17.5 6.5'), p('M9.5 6.5h8v8')];
  G.chevronDown = [p('m6 9.5 6 6 6-6')];
  G.chevronRight = [p('m9.5 6 6 6-6 6')];
  G.swap = [p('M4 8.5h13m-3.5-3.5L17 8.5 13.5 12'), p('M20 15.5H7m3.5-3.5L7 15.5 10.5 19')];
  G.starOutline = [p('m12 3.8 2.6 5.7 6.2.7-4.6 4.2 1.3 6.1L12 17.4l-5.5 3.1 1.3-6.1-4.6-4.2 6.2-.7z')];
  G.starFilled = [fill('<path d="m12 3.8 2.6 5.7 6.2.7-4.6 4.2 1.3 6.1L12 17.4l-5.5 3.1 1.3-6.1-4.6-4.2 6.2-.7z"/>')];

  // ── 工具/操作 ───────────────────────────────────────────────
  G.scissors = [
    c(6.5, 18, 2.5), c(6.5, 6, 2.5),
    p('M8.6 7.4 20 17M8.6 16.6 20 7')
  ];
  G.broom = [
    p('m14 10.5 6.5-7'),
    p('m7.5 9.5 7.5 6-3 4.5-8-1-1-3.5z'),
    p('m8 13-1.5 3.5m4.5-2-1.5 3')
  ];
  G.sliders = [
    p('M5 6.5h14M5 12h14M5 17.5h14'),
    c(9, 6.5, 2), c(15, 12, 2), c(8, 17.5, 2)
  ];
  G.search = [c(10.5, 10.5, 6.5), p('m15.5 15.5 4.5 4.5')];
  // ⭐ 2026-10-19（docs/250 第 8 条）：预设二级右上角「最近用过的提示词」
  G.clock = [c(12, 12, 8.5), p('M12 7.5V12l3 2')];
  G.save = [
    p('M5.5 4.5h10L19.5 8.5v11h-14z'),
    p('M8.5 4.5v5h6v-5'),
    r(8.5, 13, 7, 6.5, 1.5)
  ];
  G.truck = [
    p('M2.5 6.5h10v9h-10z'), p('M12.5 10h4l3 3v2.5h-7z'),
    c(6, 18, 2), c(16.5, 18, 2)
  ];
  G.pin = [
    p('M12 21v-6.5'),
    p('M8 4.5h8l-1 5.5 2.5 3.5h-11L9 10z')
  ];
  G.note = [
    p('M18.5 12.5v7h-14v-15h8'),
    p('m9 15.5 1-3.5 8.5-8.5 2.5 2.5-8.5 8.5z')
  ];
  G.chart = [p('M3.5 3.5v17h17'), p('M7.5 17v-4.5'), p('M12 17V8'), p('M16.5 17v-7')];
  G.download = [p('M12 3.5v11'), p('m7.5 10.5 4.5 4.5 4.5-4.5'), p('M4.5 19.5h15')];
  G.upload = [p('M12 15.5v-11'), p('m7.5 8.5 4.5-4.5 4.5 4.5'), p('M4.5 19.5h15')];
  G.link = [
    p('M9.5 14.5 14.5 9.5'),
    p('M11 7.5 13 5.5a3.5 3.5 0 0 1 5 5l-2 2'),
    p('M13 16.5 11 18.5a3.5 3.5 0 0 1-5-5l2-2')
  ];
  G.books = [
    p('M3.5 5h4v14h-4zM3.5 9h4'),
    p('M8 5h4.5v14H8zM8 9h4.5'),
    p('m14 6 3.5-1 3.5 13-3.5 1z')
  ];
  G.bulb = [
    p('M8.5 15.5c0-2-3-3-3-6.5a6.5 6.5 0 0 1 13 0c0 3.5-3 4.5-3 6.5z'),
    p('M9.5 18.5h5m-4 2.5h3'),
    p('M12 15.5v-4.5')
  ];
  G.fog = [
    p('M5.5 10a3 3 0 0 1 .4-6 5.5 5.5 0 0 1 10.1 1.1A3.4 3.4 0 1 1 19 10'),
    p('M4 13.5h11m3 0h2.5'),
    p('M6 17h13M3.5 20.5h12')
  ];
  G.film = [
    r(4, 3.5, 16, 17, 2.5),
    p('M8.5 3.5v17m7-17v17'),
    p('M4 8.5h4.5m7 0H20M4 15.5h4.5m7 0H20')
  ];
  G.mask = [
    p('M3.5 6c3 .9 5.7.9 8.5 0v5.5c0 3-1.9 5.6-4.2 6.6C5.4 17.1 3.5 14.5 3.5 11.5z'),
    p('M20.5 8v5.5c0 3-1.9 5.6-4.2 6.6-1.5-.6-2.7-1.7-3.5-3.1'),
    p('M6.5 9.5h1m2 0h1')
  ];
  G.thread = [
    p('M7.5 3.5h9M7.5 20.5h9'),
    p('M9 3.5v17m6-17v17'),
    p('m9 8 6 2m-6 2 6 2')
  ];
  G.puzzle = [
    p('M10 4.5h4a1 1 0 0 1 1 1v1.2a2 2 0 1 0 3 1.8H19a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1a2 2 0 1 0-3 1.8v1.2a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-1.2a2 2 0 1 0-3-1.8H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h1a2 2 0 1 0 3-1.8V5.5a1 1 0 0 1 1-1Z')
  ];

  // ── 剪影 17 个部位 ─────────────────────────────────────────
  G.head = [c(12, 9.5, 6), p('M9.5 8.5v1m5-1v1'), p('M10.5 13h3'), p('M8 15.5c0 3 1 5 4 5s4-2 4-5')];
  G.hair = [c(12, 12, 6), p('M6 11c0-5 3-7.5 6-7.5s6 2.5 6 7.5'), p('m7 7.5 2 2m8-2-2 2m-3-4v2')];
  G.bone = [
    p('M9.5 9.5 14.5 14.5'),
    c(8, 8, 2.2), c(10.5, 10.5, 2.2), c(13.5, 13.5, 2.2), c(16, 16, 2.2)
  ];
  G.shirt = [
    p('M9 4.5 12 7l3-2.5 4.5 2.5-1.5 4-2 .8v8.7h-8V11.3l-2-.8L4.5 7z')
  ];
  G.arm = [
    p('M7.5 4.5c0 4 1 5.5 3.5 7s3.5 3.5 3.5 7'),
    c(7.5, 4.5, 2), c(14.5, 19, 2)
  ];
  G.hand = [
    p('M8 12.5V6.2a1.4 1.4 0 0 1 2.8 0v5.3'),
    p('M10.8 11.5V5a1.4 1.4 0 0 1 2.8 0v6.5m0-1V6.5a1.4 1.4 0 0 1 2.8 0v6'),
    p('M16.4 11.5v-2a1.4 1.4 0 0 1 2.6.7V15c0 3.3-2.2 5.5-5.5 5.5S8 18.3 8 15v-2.5')
  ];
  G.leg = [
    p('M9 3.5v7.5c0 2 .5 3 1.5 4.5s1.5 3 1.5 5'),
    p('M15 3.5v6c0 2-.5 3-1.5 4.5'),
    p('M9.5 20.5h4')
  ];
  G.foot = [
    p('M7.5 17.5c-1-3 0-5.5 1.5-7.5s3-4 4.5-4 3 1.5 3 4.5-1 5-1 8'),
    p('M7.5 17.5c0 2 1.5 3 4 3s4.5-1 4.5-3')
  ];
  G.dress = [
    p('M9.5 4h5l-1 3.5 4 12h-11l4-12z'),
    p('M9.5 4 12 6l2.5-2')
  ];
  G.ring = [c(12, 14.5, 5.5), p('m9.5 8 2.5-4 2.5 4'), p('M9.5 8h5')];
  G.lighting = [
    c(12, 12, 4),
    p('M12 3v2.5m0 13V21M3 12h2.5m13 0H21M5.6 5.6l1.8 1.8m9.2 9.2 1.8 1.8m0-12.8-1.8 1.8M7.4 16.6l-1.8 1.8')
  ];
  G.landscape = [
    r(3, 5, 18, 14, 2.5),
    p('m4 16 4.5-5.5L12 15l3-3.5 5 5.5'),
    c(8, 9, 1.4)
  ];
  G.sword = [
    p('m14 4.5 5.5-1-1 5.5-9 9'),
    p('m6.5 15.5 3 3'),
    p('m4.5 19.5 2-2m1 3 2-2')
  ];
  // 细节补偿 — GPT 80→24。ip0=底台, ip1=支柱, ip2=晶格台, ip3=节点块, ip4=定位框
  // ⚠ 这个图标【只给「细节补偿」分区用】，不要拿去当「特效」——
  //   剪影卡的「特效」部位走 G.effects（星火造型），两者形状完全不同。
  //   GPT 那份素材里 detail-* 和 sparkles 本来就是两组，别合并。
  G.detail = [
    p('M6 15.6v3h12V15.6'),                                 // 底台
    '<g opacity=".7">' + p('M9 12.3v3.6M15 12.3v3.6') + '</g>',   // 支柱（GPT 原稿 #999 + .7）
    p('M6 9.3v3h12V9.3'),                                   // 晶格台
    fill('<rect x="7.5" y="8.1" width="1.8" height="1.8"/>' +
         '<rect x="11.1" y="8.1" width="1.8" height="1.8"/>' +
         '<rect x="14.7" y="8.1" width="1.8" height="1.8"/>'),    // 三个节点块
    '<g opacity=".65">' + p('M8.4 6v-1.5h7.2v1.5') + '</g>'       // 定位框
  ];
  // ⚠ effects 与 sparkles 拆开：剪影卡的「特效」部位用 effects。
  //   ⚠ 别把它改成 GPT 的 detail 造型 —— effects 还被 iconForPart 映射着
  //     （preset-store 里 {id:'effects', name:'特效'}），改了剪影的特效会变成格栅。
  G.effects = [
    p('m9.5 4 1.7 4.3 4.3 1.7-4.3 1.7L9.5 16l-1.7-4.3L3.5 10l4.3-1.7z'),
    p('m18 3 .8 2.2 2.2.8-2.2.8L18 9l-.8-2.2-2.2-.8 2.2-.8z'),
    p('M18.5 15.5v4M16.5 17.5h4')
  ];
  G.box = G.package;           // 其他 = 箱子，同形
  G.wing = [
    p('M4 18.5c0-7 4.5-12.5 10-12.5'),
    p('M6.5 18.5c0-5 3-9 7.5-9'),
    p('M9.5 18.5c0-3 2-5.5 4.5-5.5'),
    p('M14 6c3 0 5.5 1.5 6 4')
  ];

  // ═══════════════════════════════════════════════════════════
  //  部位 id → 图标名 映射（preset-store.js 里那 17 个）
  //  ⚠ 这些 icon 字段已存进 IndexedDB，改默认值不会生效。
  //    渲染时按 id 查这个表，新老用户都统一。
  // ═══════════════════════════════════════════════════════════
  const PART_ICON_MAP = {
    head: 'head', hair: 'hair', neck: 'bone', torso: 'shirt',
    arms: 'arm', hands: 'hand', legs: 'leg', feet: 'foot',
    clothing: 'dress', accessory: 'ring', fullbody: 'person',
    lighting: 'lighting', background: 'landscape', weapon: 'sword',
    cleanup: 'broom', effects: 'effects', other: 'box',
    // ⭐ 内置「工具」素材（preset-store 的 TOOL_ID）。抠像/外挂模型都挂这个类别
    __tool__: 'wrench'
  };

  // ═══════════════════════════════════════════════════════════
  //  渲染 SVG
  // ═══════════════════════════════════════════════════════════
  function render(name, sz) {
    const parts = G[name];
    if (!parts) return '';
    const w = sz || 24, h = sz || 24;
    let inner = '';
    for (let i = 0; i < parts.length; i++) {
      inner += '<g class="ip' + i + '">' + parts[i] + '</g>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + w + '" height="' + h + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ico ico-' + name + '">' + inner + '</svg>';
  }

  // 挂到 DOM 节点上（替换 textContent）
  function set(el, nameOrEmoji, sz) {
    if (!el) return;
    // 如果传进来的是 emoji / 其它旧符号 → 先查有没有对应的新图标
    // ⚠ 先剥掉变体选择符 U+FE0F。库里存的是 'landscape'（带 FE0F），
    //   而扫描/传参时常常只有 'landscape' —— 不剥就永远匹配不上（2026-09-14 栽过）。
    let name = String(nameOrEmoji == null ? '' : nameOrEmoji).replace(/️/g, '');
    if (name === 'head') name = 'wand';
    else if (name === 'person') name = 'person';
    else if (name === '⚙') name = 'gear';
    else if (name === '⚡') name = 'bolt';
    else if (name === '📜') name = 'scroll';
    else if (name === '✨') name = 'sparkles';
    else if (name === '🖼') name = 'image';
    else if (name === '📦') name = 'package';
    else if (name === 'ℹ') name = 'info';
    else if (name === '🔐') name = 'keyhole';
    else if (name === '🎨') name = 'palette';
    else if (name === '🖥') name = 'monitor';
    else if (name === '🛡') name = 'shield';
    else if (name === '⌖') name = 'crosshair';
    else if (name === '◎') name = 'target';
    else if (name === '✓') name = 'check';
    else if (name === '⚠') name = 'warning';
    else if (name === '✕' || name === '✗') name = 'close';
    else if (name === '⏳') name = 'hourglass';
    else if (name === '🔄') name = 'refresh';
    else if (name === '←') name = 'arrowLeft';
    else if (name === '→') name = 'arrowRight';
    else if (name === '↓') name = 'arrowDown';
    else if (name === '↑') name = 'arrowUp';
    else if (name === '↺' || name === '↻') name = 'revert';
    else if (name === '▶') name = 'play';
    else if (name === '⏹') name = 'stop';
    else if (name === '🔒') name = 'lock';
    else if (name === '↗') name = 'arrowUpRight';
    else if (name === '▾') name = 'chevronDown';
    else if (name === '▸') name = 'chevronRight';
    else if (name === '↔') name = 'swap';
    else if (name === '☆') name = 'starOutline';
    else if (name === '★') name = 'starFilled';
    else if (name === '✂') name = 'scissors';
    else if (name === '🧹') name = 'broom';
    else if (name === '🎚' || name === '🎛') name = 'sliders';
    else if (name === '🔍') name = 'search';
    else if (name === '💾') name = 'save';
    else if (name === '🚚') name = 'truck';
    else if (name === 'pin') name = 'pin';
    else if (name === '📝') name = 'note';
    else if (name === '📊') name = 'chart';
    else if (name === '📥') name = 'download';
    else if (name === '📤') name = 'upload';
    else if (name === '🔗') name = 'link';
    else if (name === '📚') name = 'books';
    else if (name === 'bulb') name = 'bulb';
    else if (name === '🌫') name = 'fog';
    else if (name === '🎞') name = 'film';
    else if (name === '🎭') name = 'mask';
    else if (name === '🧵') name = 'thread';
    else if (name === '🧩') name = 'puzzle';
    // 剪影 17 个部位
    else if (name === 'head' || name === 'hair') name = 'head';  // 头部面部 兼容两个 emoji
    else if (name === 'bone') name = 'bone';
    else if (name === 'shirt') name = 'shirt';
    else if (name === 'arm') name = 'arm';
    else if (name === 'hand') name = 'hand';
    else if (name === 'leg') name = 'leg';
    else if (name === 'foot') name = 'foot';
    else if (name === 'dress') name = 'dress';
    else if (name === 'ring') name = 'ring';
    else if (name === 'landscape') name = 'landscape';
    else if (name === 'sword') name = 'sword';
    else if (name === 'wing') name = 'wing';

    el.innerHTML = render(name, sz);
    el.dataset.icon = name;  // 留给 motion.js 用
  }

  // 按剪影部位 id 取图标名。
  // ⚠⚠ 只认 V6 那 17 个【内置】部位。用户自建素材返回空 ——
  //   因为自建素材的图标是【用户自己在编辑器里填的 emoji】(silhouette-editor 的 #wizIcon)，
  //   那是用户数据，不能拿我们的 SVG 覆盖掉。调用方拿到空就回退显示他填的那个字符。
  function iconForPart(partId) {
    return PART_ICON_MAP[partId] || '';
  }

  // 把页面上所有 [data-icon-static] 渲染出来。
  // ⚠ 子窗口（大图/L4/素材编辑器）是独立页面，各自调一次这个就行，
  //   不用每个窗口再抄一遍渲染代码。
  // ⚠ 元素里原来的 emoji 是【兜底】：图标库加载失败时它还在，用户至少看得见按钮。
  //   所以这里成功才覆盖 innerHTML。
  function mountStatic(root) {
    const host = root || document;
    let n = 0;
    host.querySelectorAll('[data-icon-static]').forEach(el => {
      const svg = render(el.dataset.iconStatic, Number(el.dataset.iconSize) || 18);
      if (svg) { el.innerHTML = svg; n++; }
    });
    return n;
  }

  // 暴露接口
  window.ICON = { render, set, iconForPart, mountStatic };
  window.__ICON_GLYPHS__ = G;  // 调试用
})();
