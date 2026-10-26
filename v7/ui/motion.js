/* ═══════════════════════════════════════════════════════════════
   motion.js —— 图标动画（window.MOTION）
   2026-09-14 建立。配合 icons.js。

   ⭐ 用户定的两级模型（2026-09-14）：
   ┌──────────┬────────────────────────────────────────────────┐
   │ 小图标   │ 简单：悬停有反应 + 按下回缩。CSS 就够（.ico-btn）│
   │ 大图标   │ 复杂：【选中】→ 开始循环动画                    │
   │ (二级分区)│        可打断 · 可点按 · 从哪来回哪去           │
   └──────────┴────────────────────────────────────────────────┘

   "从哪来回哪去"在这里的含义：取消选中时，**从循环当时那一帧平滑退回静止**，
   不是啪一下跳回去。所以每次停都要读当前值再动画回零。

   ⚠ 为什么不用 CSS 动画：要"从当前帧接出触发动画"必须读得到相位，
     CSS 交不出 currentTime。所以全部走 Web Animations API。

   ⚠⚠ 这个文件【不许】加全局性的开关（比如 prefers-reduced-motion 一刀切）。
     2026-09-14 栽过：用户 Windows 关了"显示动画"，我加的无障碍检测
     把整个界面的动画全关了 —— 那是设计外的多余操作。
     要做无障碍就单独给设置项，别偷偷替用户决定。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // el → { name, loop, trigger }
  const bound = new Map();

  // ── 小工具 ──────────────────────────────────────────────────
  function one(el, sel) { return el ? el.querySelector(sel) : null; }
  function parts(el, sels) { return sels.map(s => one(el, s)).filter(Boolean); }

  // 循环关键帧 —— 每帧 ease-in-out，动画自身 linear
  const E = 'ease-in-out';
  function lk(o, t, op) {
    var k = { offset: o, transform: t, easing: E };
    if (op !== undefined) k.opacity = op;
    return k;
  }
  // 点击关键帧 —— 每帧 smooth，动画自身 linear
  var SM = 'cubic-bezier(.4,0,.2,1)';
  function ck(o, t, op) {
    var k = { offset: o, transform: t, easing: SM };
    if (op !== undefined) k.opacity = op;
    return k;
  }

  // 数据驱动的循环启动器（选中时播）
  // data = { '.ipN': [lk帧, ...], ... }
  function loopAll(el, data, dur) {
    var a = [];
    for (var sel in data) {
      var g = one(el, sel);
      if (g) a.push(g.animate(data[sel],
        { duration: dur || 2800, iterations: Infinity, easing: 'linear' }));
    }
    return a;
  }

  // 短动作走三档（motion-tokens.js）；下面 LOOPS / TRIGGERS 里 900~2800ms 的是逐帧编排过的图标戏，不归档（同 CSS 里 .6s 以上的装饰动画）
  function M() { return (window.V7Motion && window.V7Motion.MS) || { fast: 120, base: 200, slow: 340 }; }
  // 一起亮一下（简单图标用）
  function burst(el, sels) {
    parts(el, sels).forEach(function (g) {
      g.animate(
        [{ opacity: 1 }, { opacity: 1, offset: .25 }, { opacity:0.5 }],
        { duration: M().slow, easing: 'ease-out' });
    });
  }
  // 弹一下（简单图标用）
  function pop(el, sel, scale) {
    var g = one(el, sel); if (!g) return;
    g.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(' + (scale || 1.2) + ')', offset: .35 }, { transform: 'scale(1)' }],
      { duration: M().slow, easing: 'cubic-bezier(.22,.9,.32,1.2)' });
  }

  /* ═══════════════════════════════════════════════════════════
     大图标的循环动画（选中时播）
     每个图标一个专属动作。⚠ 只动 transform / opacity。
     GPT 80→24 坐标缩放：translate 值 ×0.3，scale/rotate/opacity 不变。
     ═══════════════════════════════════════════════════════════ */
  var LOOPS = {
    // ── 二级分区：前四个（生成区）────────────────────────────
    // 星火(生成图片): 画框摇 + 星火转 + 光线呼吸
    sparkles: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0) rotate(0)'), lk(.45,'translateY(-.9px) rotate(-4deg)'), lk(.75,'translateY(.3px) rotate(2deg)'), lk(1,'translateY(0) rotate(0)')],
      '.ip1': [lk(0,'scale(1) rotate(0)'), lk(.5,'scale(1.18) rotate(35deg)'), lk(1,'scale(1) rotate(0)')],
      '.ip2': [lk(0,'scale(.94)',.55), lk(.48,'scale(1.08)',1), lk(1,'scale(.94)',.55)]
    }, 2800); },
    // 参考图片: 叠层卡摇 + 箭头浮 + 扫描线淡
    image: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0) rotate(0)'), lk(.46,'translateY(-.9px) rotate(1deg)'), lk(.74,'translateY(.3px) rotate(-.5deg)'), lk(1,'translateY(0) rotate(0)')],
      '.ip1': [lk(0,'translateY(0)'), lk(.5,'translateY(1.2px)'), lk(1,'translateY(0)')],
      '.ip2': [lk(0,'translateY(0)',.8), lk(.5,'translateY(-1.2px)',.3), lk(1,'translateY(0)',.8)]
    }, 2800); },
    // 生成结果: 盒体漂浮 + 内核脉动 + 盖板摇
    package: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0) rotate(0)'), lk(.45,'translateY(-1.8px) rotate(-1deg)'), lk(.72,'translateY(-.9px) rotate(.6deg)'), lk(1,'translateY(0) rotate(0)')],
      '.ip1': [lk(0,'scale(.88)',.35), lk(.5,'scale(1)',.85), lk(1,'scale(.88)',.35)],
      '.ip2': [lk(0,'translateY(0) rotate(0)'), lk(.45,'translateY(-.6px) rotate(-3deg)'), lk(.72,'translateY(-.3px) rotate(-1deg)'), lk(1,'translateY(0) rotate(0)')]
    }, 2800); },
    // 使用说明: 书本摇 + 底圈缩放 + 叹号浮
    info: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0) rotate(0)'), lk(.45,'translateY(-.9px) rotate(-2deg)'), lk(.75,'translateY(.3px) rotate(1deg)'), lk(1,'translateY(0) rotate(0)')],
      '.ip1': [lk(0,'scale(1)'), lk(.5,'scale(1.07)'), lk(1,'scale(1)')],
      '.ip2': [lk(0,'translateY(0)'), lk(.5,'translateY(-.9px)'), lk(1,'translateY(0)')]
    }, 2800); },

    // ── 二级分区：设置区 9 卡 ─────────────────────────────
    // 连接与账号: 竖线/上下扣交错 + 节点脉 + 侧波
    keyhole: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0)'), lk(.42,'translateY(-.6px)'), lk(.72,'translateY(.3px)'), lk(1,'translateY(0)')],
      '.ip1': [lk(0,'translateY(0) rotate(0)'), lk(.48,'translateY(-1.2px) rotate(-4deg)'), lk(1,'translateY(0) rotate(0)')],
      '.ip2': [lk(0,'translateY(0) rotate(0)'), lk(.48,'translateY(1.2px) rotate(4deg)'), lk(1,'translateY(0) rotate(0)')],
      '.ip3': [lk(0,'scale(.92)'), lk(.5,'scale(1.08)'), lk(1,'scale(.92)')],
      '.ip4': [lk(0,'scaleX(.7)',.35), lk(.5,'scaleX(1.2)',1), lk(1,'scaleX(.7)',.35)]
    }, 2800); },
    // 生成与传回: 画框浮 + 选区脉 + 底线延 + 箭头扫 + 像素跳
    palette: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0)'), lk(.46,'translateY(-.9px)'), lk(.74,'translateY(.3px)'), lk(1,'translateY(0)')],
      '.ip1': [lk(0,'translateY(0) scale(.96)'), lk(.5,'translateY(-.9px) scale(1.06)'), lk(1,'translateY(0) scale(.96)')],
      '.ip2': [lk(0,'translateY(0)'), lk(.5,'translateY(.9px)'), lk(1,'translateY(0)')],
      '.ip3': [lk(0,'translateY(0)',.65), lk(.5,'translateY(1.2px)',1), lk(1,'translateY(0)',.65)],
      '.ip4': [lk(0,'translateY(.6px) scale(.8)',.35), lk(.5,'translateY(-.9px) scale(1.1)',1), lk(1,'translateY(.6px) scale(.8)',.35)]
    }, 2800); },
    // 外观与交互: 后板/前板层叠 + 导轨 + 把手缩 + 角标呼吸
    monitor: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0)'), lk(.45,'translateY(-.9px)'), lk(.74,'translateY(.3px)'), lk(1,'translateY(0)')],
      '.ip1': [lk(0,'translateY(0) scale(1)'), lk(.48,'translateY(-.6px) scale(1.03)'), lk(1,'translateY(0) scale(1)')],
      '.ip2': [lk(0,'translateY(0)'), lk(.5,'translateY(1.2px)'), lk(1,'translateY(0)')],
      '.ip3': [lk(0,'translateY(0) scaleY(.9)'), lk(.5,'translateY(-1.5px) scaleY(1.1)'), lk(1,'translateY(0) scaleY(.9)')],
      '.ip4': [lk(0,'scale(.92)',.55), lk(.5,'scale(1.08)',1), lk(1,'scale(.92)',.55)]
    }, 2800); },
    // 工具与隐私: 钥匙浮 + 上下挡板交替 + 侧钉呼吸
    shield: function (el) { return loopAll(el, {
      '.ip1': [lk(0,'translateY(0)'), lk(.5,'translateY(-.9px)'), lk(1,'translateY(0)')],
      '.ip2': [lk(0,'translateY(0)'), lk(.5,'translateY(.6px)'), lk(1,'translateY(0)')],
      '.ip3': [lk(0,'translateY(0)'), lk(.5,'translateY(-.6px)'), lk(1,'translateY(0)')],
      '.ip5': [lk(0,'scaleY(.85)',.6), lk(.5,'scaleY(1.05)',1), lk(1,'scaleY(.85)',.6)]
    }, 2800); },

    // ── 引擎区 4 卡 ──────────────────────────────────────
    // 加速引擎: 推力闪 + 活塞抽 + 卡环反向 + 充能线
    bolt: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0) scaleY(.7)',.45), lk(.38,'translateY(-.3px) scaleY(.35)',.2), lk(.68,'translateY(0) scaleY(1)',.9), lk(1,'translateY(0) scaleY(.7)',.45)],
      '.ip2': [lk(0,'translateY(0)'), lk(.38,'translateY(.9px)'), lk(.65,'translateY(-1.2px)'), lk(1,'translateY(0)')],
      '.ip3': [lk(0,'translateY(0)'), lk(.38,'translateY(-.6px)'), lk(.65,'translateY(.6px)'), lk(1,'translateY(0)')],
      '.ip4': [lk(0,'translateY(0) scaleY(.75)',.55), lk(.38,'translateY(.6px) scaleY(.4)',.25), lk(.68,'translateY(0) scaleY(1)',1), lk(1,'translateY(0) scaleY(.75)',.55)]
    }, 2800); },
    // 对齐与校色: 框缩 + 三色条高低差 + 扫描箭头
    crosshair: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'scale(1)',.8), lk(.5,'scale(.97)',1), lk(1,'scale(1)',.8)],
      '.ip1': [lk(0,'translateY(0)'), lk(.4,'translateY(-.9px)'), lk(.7,'translateY(-.3px)'), lk(1,'translateY(0)')],
      '.ip2': [lk(0,'translateY(0)'), lk(.3,'translateY(.3px)'), lk(.65,'translateY(-.6px)'), lk(1,'translateY(0)')],
      '.ip3': [lk(0,'translateY(0)'), lk(.45,'translateY(.9px)'), lk(.72,'translateY(.3px)'), lk(1,'translateY(0)')],
      '.ip4': [lk(0,'translateY(0)',.65), lk(.42,'translateY(-2.4px)',1), lk(.72,'translateY(1.2px)',.85), lk(1,'translateY(0)',.65)]
    }, 2800); },
    // 全部历史: 卷头抬 + 纸卷伸 + 光标闪 + 时针转
    scroll: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'translateY(0)'), lk(.5,'translateY(-.3px)'), lk(1,'translateY(0)')],
      '.ip1': [lk(0,'translateY(0) scaleY(1)'), lk(.5,'translateY(.6px) scaleY(1.1)'), lk(1,'translateY(0) scaleY(1)')],
      '.ip2': [lk(0,'translateY(0)',.35), lk(.5,'translateY(.6px)',1), lk(1,'translateY(0)',.35)],
      '.ip4': [lk(0,'rotate(0)'), lk(.5,'rotate(-35deg)'), lk(1,'rotate(0)')]
    }, 2800); },

    // ── 主卡区 ───────────────────────────────────────────
    // 齿轮(设置卡): 齿盘摇 + 内圈缩 + 缺口浮
    gear: function (el) { return loopAll(el, {
      '.ip0': [lk(0,'rotate(0)'), lk(.38,'rotate(-8deg)'), lk(.68,'rotate(5deg)'), lk(1,'rotate(0)')],
      '.ip1': [lk(0,'translateY(0) scale(1)'), lk(.45,'translateY(-.6px) scale(1.08)'), lk(.72,'translateY(.3px) scale(.96)'), lk(1,'translateY(0) scale(1)')],
      '.ip2': [lk(0,'translateY(0)'), lk(.5,'translateY(-.9px)'), lk(1,'translateY(0)')]
    }, 2800); },
    // 预设(人形): 整体呼吸
    person: function (el) {
      var svg = one(el, 'svg');
      return svg ? [svg.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }],
        { duration: 2400, iterations: Infinity, direction: 'alternate', easing: E })] : [];
    },

    // 细节补偿: 晶格台整体浮 + 节点块跟浮 + 支柱拉伸 + 定位框轻浮
    // ⚠ GPT 原稿位移 ×0.3（80→24）：-4px→-1.2px, 1px→.3px, -2px→-.6px, .5px→.15px
    // ⚠ ip0(底台) 在 hover 里【本来就不动】—— GPT 的 hover 只给了另外四个部件，
    //   别自作主张给它补一个，那会让"台子稳、上面的东西浮"这个意思散掉。
    detail: function (el) { return loopAll(el, {
      '.ip1': [lk(0,'translateY(0) scaleY(1)',.7), lk(.44,'translateY(-.6px) scaleY(1.2)',1), lk(.76,'translateY(.15px) scaleY(.95)',.6), lk(1,'translateY(0) scaleY(1)',.7)],
      '.ip2': [lk(0,'translateY(0)'), lk(.44,'translateY(-1.2px)'), lk(.76,'translateY(.3px)'), lk(1,'translateY(0)')],
      '.ip3': [lk(0,'translateY(0)',.75), lk(.44,'translateY(-1.2px)',1), lk(.76,'translateY(.3px)',.6), lk(1,'translateY(0)',.75)],
      '.ip4': [lk(0,'translateY(0)',.65), lk(.44,'translateY(-.6px)',1), lk(.76,'translateY(.3px)',.4), lk(1,'translateY(0)',.65)]
    }, 2800); },

    // ── 不变的 ───────────────────────────────────────────
    // 特效(剪影卡「特效」部位): 旧星火脉冲。
    // ⚠ 别把它换成上面的 detail —— 两个是不同分区的不同图标（见 icons.js 的注释）
    effects: function (el) {
      return parts(el, ['.ip0', '.ip1', '.ip2']).map(function (g, i) {
        return g.animate([{ opacity:0.5 }, { opacity: 1 }, { opacity:0.5 }],
          { duration: 1800, iterations: Infinity, delay: i * 260, easing: E });
      });
    },
    // 靶心: 三圈雷达
    target: function (el) {
      return parts(el, ['.ip0', '.ip1', '.ip2']).map(function (g, i) {
        return g.animate([{ opacity:0.5 }, { opacity: 1 }, { opacity:0.5 }],
          { duration: 1800, iterations: Infinity, delay: i * 220, easing: E });
      });
    }
  };

  /* ═══════════════════════════════════════════════════════════
     点按触发动画 —— 从循环【当时那一帧】接出去。
     GPT 80→24 坐标缩放：translate 值 ×0.3。
     ═══════════════════════════════════════════════════════════ */
  var TRIGGERS = {
    // ── 生成区 ───────────────────────────────────────────
    sparkles: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.12,'translateY(1.5px) scale(.9,.92)'), ck(.34,'translateY(-3px) scale(1.06)'), ck(.62,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1260, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'scale(1) rotate(0)'), ck(.24,'scale(1.35) rotate(45deg)'), ck(.64,'scale(1.08) rotate(120deg)'), ck(1,'scale(1) rotate(180deg)')], { duration: 1080, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'scale(.94)',.55), ck(.28,'scale(1.2)',1), ck(1,'scale(1.5)',0)], { duration: 920, easing: 'linear' });
    },
    image: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.12,'translateY(1.5px) scale(.9,.92)'), ck(.34,'translateY(-3px) scale(1.06)'), ck(.62,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1260, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'none'), ck(.16,'translateY(1.5px) scale(.92)'), ck(.38,'translateY(-3.6px) scale(1.07) rotate(-2deg)'), ck(.64,'translateY(.9px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1220, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0)'), ck(.28,'translateY(4.2px)'), ck(.62,'translateY(-1.2px)'), ck(1,'translateY(0)')], { duration: 1120, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0)',.8), ck(.3,'translateY(-2.4px)',.95), ck(1,'translateY(-4.8px)',0)], { duration: 1000, easing: 'linear' });
    },
    package: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.12,'translateY(1.5px) scale(.9,.92)'), ck(.34,'translateY(-3px) scale(1.06)'), ck(.62,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1260, easing: 'linear' });
      var lid = one(el, '.ip2');
      if (lid) lid.animate([ck(0,'translateY(0) rotate(0)'), ck(.1,'translateY(.9px)'), ck(.31,'translateY(-8.4px) rotate(-4deg)'), ck(.52,'translateY(-6px) rotate(3deg)'), ck(.72,'translateY(-2.1px) rotate(-1deg)'), ck(1,'translateY(0) rotate(0)')], { duration: 1280, easing: 'linear' });
      var core = one(el, '.ip1');
      if (core) core.animate([ck(0,'scale(.88)',.35), ck(.18,'translateY(-8.4px) scale(1.2) rotate(25deg)',1), ck(.44,'translateY(-4.8px) scale(1.05) rotate(80deg)',.8), ck(1,'translateY(0) scale(.88) rotate(180deg)',.35)], { duration: 1280, easing: 'linear' });
      var b = one(el, '.ip3');
      if (b) b.animate([ck(0,'scale(1)',0), ck(.18,'scale(1.1)',1), ck(1,'scale(1.35)',0)], { duration: 920, easing: 'linear' });
    },
    info: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.12,'translateY(1.5px) scale(.9,.92)'), ck(.34,'translateY(-3px) scale(1.06)'), ck(.62,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1260, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'none'), ck(.13,'translateY(1.2px) scale(1.05,.92)'), ck(.36,'translateY(-2.1px) scale(1.02) rotate(-2deg)'), ck(.62,'translateY(.6px) rotate(1deg)'), ck(1,'translateY(0) scale(1)')], { duration: 1220, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'scale(1)'), ck(.24,'scale(1.38)'), ck(.52,'scale(.92)'), ck(1,'scale(1)')], { duration: 1120, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0) scale(1)'), ck(.24,'translateY(-2.4px) scale(1.16)'), ck(.53,'translateY(.6px) scale(.92)'), ck(1,'translateY(0) scale(1)')], { duration: 1120, easing: 'linear' });
    },

    // ── 设置区 ───────────────────────────────────────────
    keyhole: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.15,'translateY(1.5px) scale(.94,.96)'), ck(.36,'translateY(-2.7px) scale(1.04)'), ck(.64,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1360, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0) rotate(0)'), ck(.18,'translateY(-.6px) rotate(-2deg)'), ck(.42,'translateY(2.1px) rotate(7deg)'), ck(.72,'translateY(-.6px) rotate(-2deg)'), ck(1,'translateY(0) rotate(0)')], { duration: 1180, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0) rotate(0)'), ck(.18,'translateY(.6px) rotate(2deg)'), ck(.42,'translateY(-2.1px) rotate(-7deg)'), ck(.72,'translateY(.6px) rotate(2deg)'), ck(1,'translateY(0) rotate(0)')], { duration: 1180, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'scale(1)'), ck(.2,'scale(1.2)'), ck(.48,'scale(.82)'), ck(1,'scale(1)')], { duration: 980, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'scaleX(1)',.6), ck(.2,'scaleX(1.3)',1), ck(.55,'scaleX(.4)',.15), ck(1,'scaleX(1)',.6)], { duration: 920, easing: 'linear' });
    },
    palette: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.15,'translateY(1.5px) scale(.94,.96)'), ck(.38,'translateY(-3px) scale(1.05)'), ck(.68,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1420, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'none'), ck(.16,'translateY(1.2px)'), ck(.42,'translateY(-3px) scale(1.04)'), ck(.7,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1280, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0) scale(1)'), ck(.2,'translateY(-1.2px) scale(1.16)'), ck(.52,'translateY(2.4px) scale(.86)'), ck(1,'translateY(0) scale(1)')], { duration: 940, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0)'), ck(.18,'translateY(.6px)'), ck(.46,'translateY(-3.9px)'), ck(.72,'translateY(-1.2px)'), ck(1,'translateY(0)')], { duration: 1220, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'translateY(0)'), ck(.18,'translateY(3px)'), ck(.5,'translateY(-2.7px)'), ck(.76,'translateY(.9px)'), ck(1,'translateY(0)')], { duration: 1120, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'translateY(0) scale(1)',.65), ck(.2,'translateY(3px) scale(1.2)',1), ck(.58,'translateY(-2.4px) scale(.8)',.25), ck(1,'translateY(0) scale(1)',.65)], { duration: 900, easing: 'linear' });
    },
    monitor: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.15,'translateY(1.5px) scale(.93,.95)'), ck(.38,'translateY(-2.7px) scale(1.06)'), ck(.68,'translateY(.6px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1380, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'none'), ck(.16,'translateY(1.2px) scale(.98)'), ck(.42,'translateY(-3px) scale(1.04)'), ck(.7,'translateY(.6px) scale(.99)'), ck(1,'translateY(0) scale(1)')], { duration: 1280, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'none'), ck(.15,'translateY(1.2px) scale(.94,.92)'), ck(.38,'translateY(-3.6px) scale(1.08,1.04)'), ck(.67,'translateY(.9px) scale(.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1320, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0)'), ck(.18,'translateY(3.3px)'), ck(.48,'translateY(-3.6px)'), ck(.75,'translateY(.9px)'), ck(1,'translateY(0)')], { duration: 1160, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'translateY(0) scaleY(1)'), ck(.2,'translateY(3px) scaleY(1.2)'), ck(.5,'translateY(-2.4px) scaleY(.8)'), ck(1,'translateY(0) scaleY(1)')], { duration: 1020, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'scale(1)',.65), ck(.18,'scale(1.18)',1), ck(.55,'scale(.84)',.35), ck(1,'scale(1)',.65)], { duration: 980, easing: 'linear' });
    },
    shield: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.22,'translateY(.9px) scale(1.03,.96)'), ck(.53,'translateY(-.6px) scale(1)'), ck(1,'translateY(0) scale(1)')], { duration: 1750, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0) scaleY(1)'), ck(.22,'translateY(2.7px) scaleY(2)'), ck(.5,'translateY(2.7px) scaleY(2)'), ck(.78,'translateY(-.6px) scaleY(.9)'), ck(1,'translateY(0) scaleY(1)')], { duration: 1800, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'translateY(0) scaleY(1)'), ck(.25,'translateY(-3px) scaleY(2)'), ck(.52,'translateY(-3px) scaleY(2)'), ck(.8,'translateY(.6px) scaleY(.9)'), ck(1,'translateY(0) scaleY(1)')], { duration: 1800, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0) scale(1)',1), ck(.22,'translateY(.9px) scale(.88)',.25), ck(.53,'translateY(.3px) scale(.9)',.25), ck(.78,'translateY(-.9px) scale(1.04)',1), ck(1,'translateY(0) scale(1)',1)], { duration: 1740, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'translateY(0) scale(1)',0), ck(.2,'translateY(.6px) scale(.6)',0), ck(.37,'translateY(0) scale(1)',1), ck(.52,'translateY(0) scale(1)',1), ck(.7,'translateY(-.6px) scale(.8)',0), ck(1,'translateY(0) scale(1)',0)], { duration: 1800, easing: 'linear' });
      var p5 = one(el, '.ip5');
      if (p5) p5.animate([ck(0,'scaleY(1)',.6), ck(.22,'scaleY(.75)',.3), ck(.5,'scaleY(1)',1), ck(.78,'scaleY(1.1)',.8), ck(1,'scaleY(1)',.6)], { duration: 1800, easing: 'linear' });
    },

    // ── 引擎区 ───────────────────────────────────────────
    bolt: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.2,'translateY(.9px) scale(1.025,.96)'), ck(.48,'translateY(-.9px) scale(.99,1.02)'), ck(.74,'translateY(.3px) scale(1)'), ck(1,'translateY(0) scale(1)')], { duration: 1520, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0)'), ck(.2,'translateY(2.1px)'), ck(.46,'translateY(-1.8px)'), ck(.7,'translateY(.6px)'), ck(1,'translateY(0)')], { duration: 1520, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'translateY(0) scale(1)'), ck(.2,'translateY(-.9px) scale(1.05,1)'), ck(.48,'translateY(.9px) scale(1)'), ck(.76,'translateY(-.3px) scale(1)'), ck(1,'translateY(0) scale(1)')], { duration: 1520, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'none'), ck(.2,'translateY(.6px) scale(1.06,.9)'), ck(.48,'translateY(0) scale(.98,1.05)'), ck(.75,'translateY(.3px) scale(1.01,.98)'), ck(1,'translateY(0) scale(1)')], { duration: 1500, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'translateY(0) scaleY(.7)',.45), ck(.2,'translateY(-.6px) scaleY(.15)',.15), ck(.46,'translateY(.3px) scaleY(1.1)',1), ck(.74,'translateY(.3px) scaleY(.85)',.7), ck(1,'translateY(0) scaleY(.7)',.45)], { duration: 1420, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'translateY(0) scaleY(.75)',.55), ck(.18,'translateY(.9px) scaleY(.2)',.15), ck(.46,'translateY(0) scaleY(1)',1), ck(.76,'translateY(.3px) scaleY(.55)',.7), ck(1,'translateY(0) scaleY(.75)',.55)], { duration: 1380, easing: 'linear' });
    },
    crosshair: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.19,'translateY(.9px) scale(1,.97)'), ck(.46,'translateY(-.9px) scale(1)'), ck(.72,'translateY(.3px) scale(1)'), ck(1,'translateY(0) scale(1)')], { duration: 1600, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0)'), ck(.18,'translateY(.9px)'), ck(.42,'translateY(-2.4px)'), ck(.66,'translateY(-2.4px)'), ck(.85,'translateY(-.6px)'), ck(1,'translateY(0)')], { duration: 1650, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0)'), ck(.18,'translateY(.9px)'), ck(.46,'translateY(0)'), ck(.66,'translateY(0)'), ck(.85,'translateY(-.3px)'), ck(1,'translateY(0)')], { duration: 1650, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'translateY(0)'), ck(.18,'translateY(.9px)'), ck(.5,'translateY(2.4px)'), ck(.66,'translateY(2.4px)'), ck(.85,'translateY(.6px)'), ck(1,'translateY(0)')], { duration: 1650, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'translateY(0)',.65), ck(.18,'translateY(2.7px)',.5), ck(.42,'translateY(-4.8px)',1), ck(.66,'translateY(-4.8px)',1), ck(.85,'translateY(.9px)',.8), ck(1,'translateY(0)',.65)], { duration: 1500, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'scale(1)',.8), ck(.19,'scale(1.035,.96)',.6), ck(.47,'scale(.93,1)',1), ck(.67,'scale(.93,1)',1), ck(1,'scale(1)',.8)], { duration: 1600, easing: 'linear' });
    },
    scroll: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.18,'translateY(.6px) scale(1,.97)'), ck(.4,'translateY(-.6px) scale(1)'), ck(1,'translateY(0) scale(1)')], { duration: 1640, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0) scaleY(1)'), ck(.18,'translateY(-1.5px) scaleY(.72)'), ck(.48,'translateY(1.5px) scaleY(1.24)'), ck(.72,'translateY(.9px) scaleY(1.14)'), ck(1,'translateY(0) scaleY(1)')], { duration: 1780, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'translateY(0) scaleY(1)'), ck(.18,'translateY(.6px) scaleY(.92)'), ck(.44,'translateY(-.9px) scaleY(1.04)'), ck(.7,'translateY(.3px) scaleY(.99)'), ck(1,'translateY(0) scaleY(1)')], { duration: 1660, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'scale(1)'), ck(.18,'scale(.92)'), ck(.48,'scale(1.13)'), ck(.73,'scale(1.05)'), ck(1,'scale(1)')], { duration: 1700, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'scale(1) rotate(0)'), ck(.18,'scale(.92) rotate(12deg)'), ck(.48,'scale(1.13) rotate(-95deg)'), ck(.73,'scale(1.05) rotate(-45deg)'), ck(1,'scale(1) rotate(0)')], { duration: 1700, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0) scaleY(1)',.7), ck(.18,'translateY(-1.2px) scaleY(.7)',.3), ck(.48,'translateY(1.5px) scaleY(1.24)',1), ck(.72,'translateY(.9px) scaleY(1.14)',.8), ck(1,'translateY(0) scaleY(1)',.7)], { duration: 1780, easing: 'linear' });
    },

    // ── 主卡区 ───────────────────────────────────────────
    gear: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.18,'translateY(1.2px) scale(1.04,.93)'), ck(.42,'translateY(-.6px) scale(1.02)'), ck(.68,'translateY(.3px) scale(.985)'), ck(1,'translateY(0) scale(1)')], { duration: 2050, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'rotate(0)'), ck(.18,'rotate(-10deg)'), ck(.48,'rotate(36deg)'), ck(.76,'rotate(-6deg)'), ck(1,'rotate(0)')], { duration: 2050, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0) scale(1)'), ck(.15,'translateY(.9px) scale(.72)'), ck(.36,'translateY(-.6px) scale(1.14)'), ck(.58,'translateY(.3px) scale(.94)'), ck(1,'translateY(0) scale(1)')], { duration: 1780, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'translateY(0) scaleY(1)',1), ck(.18,'translateY(1.5px) scaleY(.65)',.35), ck(.46,'translateY(-.6px) scaleY(1.15)',1), ck(.72,'translateY(.3px) scaleY(.92)',.72), ck(1,'translateY(0) scaleY(1)',1)], { duration: 1780, easing: 'linear' });
    },
    person: function (el) { pop(el, 'svg', 1.16); },
    // 细节补偿: 整台压一下 → 晶格台带着节点弹起来 → 落回。位移 ×0.3（80→24）
    // ⚠ ip4(定位框) 在 GPT 原稿里是【单独的时长 1470ms】，不是统一的 1640 ——
    //   它比别的先落定，"定位框先归位、内容后落下"是这个动画的意思，别改成一样长。
    detail: function (el) {
      var s = one(el, 'svg');
      if (s) s.animate([ck(0,'none'), ck(.22,'translateY(.9px) scale(1.015,.97)'), ck(.5,'translateY(-.6px) scale(1)'), ck(.78,'translateY(.3px) scale(1)'), ck(1,'translateY(0) scale(1)')], { duration: 1640, easing: 'linear' });
      var p0 = one(el, '.ip0');
      if (p0) p0.animate([ck(0,'none'), ck(.23,'translateY(.6px) scale(1.025,.92)'), ck(.5,'translateY(0) scale(.99,1.02)'), ck(.77,'translateY(.3px) scale(1,.99)'), ck(1,'translateY(0) scale(1)')], { duration: 1640, easing: 'linear' });
      var p1 = one(el, '.ip1');
      if (p1) p1.animate([ck(0,'translateY(0) scaleY(1)',.7), ck(.23,'translateY(1.65px) scaleY(.28)',.4), ck(.5,'translateY(-1.05px) scaleY(1.45)',1), ck(.68,'translateY(-.6px) scaleY(1.22)',.9), ck(.82,'translateY(.15px) scaleY(.95)',.8), ck(1,'translateY(0) scaleY(1)',.7)], { duration: 1640, easing: 'linear' });
      var p2 = one(el, '.ip2');
      if (p2) p2.animate([ck(0,'none'), ck(.23,'translateY(3.3px)'), ck(.5,'translateY(-2.1px)'), ck(.68,'translateY(-1.2px)'), ck(.82,'translateY(.3px)'), ck(1,'translateY(0)')], { duration: 1640, easing: 'linear' });
      var p3 = one(el, '.ip3');
      if (p3) p3.animate([ck(0,'translateY(0)',.75), ck(.23,'translateY(3.3px)',.3), ck(.5,'translateY(-3px)',1), ck(.68,'translateY(-1.5px)',1), ck(.82,'translateY(.3px)',.8), ck(1,'translateY(0)',.75)], { duration: 1640, easing: 'linear' });
      var p4 = one(el, '.ip4');
      if (p4) p4.animate([ck(0,'translateY(0) scale(1)',.65), ck(.2,'translateY(1.8px) scale(.9,1)',.3), ck(.5,'translateY(-.9px) scale(1,1)',1), ck(.74,'translateY(-.3px) scale(1,1)',.9), ck(1,'translateY(0) scale(1)',.65)], { duration: 1470, easing: 'linear' });
    },

    // ── 不变的 ───────────────────────────────────────────
    effects: function (el) { burst(el, ['.ip0', '.ip1', '.ip2']); },
    target: function (el) { burst(el, ['.ip0', '.ip1', '.ip2']); }
  };

  /* ═══════════════════════════════════════════════════════════
     对外接口
     ═══════════════════════════════════════════════════════════ */

  // 把一个大图标登记进来（渲染完之后调一次）
  function bind(el) {
    if (!el) return false;
    var name = el.dataset.icon;
    if (!name || !LOOPS[name]) return false;
    bound.set(el, { name: name, loop: null, trigger: TRIGGERS[name] || null });
    return true;
  }

  // 选中 → 开始循环
  function select(el) {
    var st = bound.get(el);
    if (!st || st.loop) return;          // 已经在播就不重复起（可打断靠 deselect）
    var anims = LOOPS[st.name](el);
    st.loop = (anims && anims.length) ? anims : null;
  }

  // 取消选中 → 循环停下，【从当前帧平滑退回静止】(从哪来回哪去)
  function deselect(el) {
    var st = bound.get(el);
    if (!st || !st.loop) return;
    st.loop.forEach(function (a) {
      if (!a) return;
      try {
        // ⚠ 不能直接 cancel —— 那是啪一下跳回原样。
        //   先把当前这一帧的样子固定住，再用一个短过渡退回静止。
        var node = a.effect && a.effect.target;
        var snap = node ? getComputedStyle(node).transform : null;
        var snapOp = node ? getComputedStyle(node).opacity : null;
        a.cancel();
        if (node) {
          var from = {};
          if (snap && snap !== 'none') from.transform = snap;
          if (snapOp != null) from.opacity = snapOp;
          if (Object.keys(from).length) {
            node.animate([from, { transform: 'none', opacity: 1 }],
              { duration: M().base, easing: 'cubic-bezier(.22,.9,.32,1)' });
          }
        }
      } catch (_) { try { a.cancel(); } catch (__) { } }
    });
    st.loop = null;
  }

  // 点按 → 从当前帧接出触发动画
  function trigger(el) {
    var st = bound.get(el);
    if (st && st.trigger) { try { st.trigger(el); } catch (_) { } }
  }

  // 这个图标现在在循环吗（自检用）
  function isLooping(el) {
    var st = bound.get(el);
    return !!(st && st.loop && st.loop.some(function (a) { return a && a.playState === 'running'; }));
  }

  // 有几个大图标登记了（自检用）
  function boundCount() { return bound.size; }

  window.MOTION = { bind: bind, select: select, deselect: deselect, trigger: trigger, isLooping: isLooping, boundCount: boundCount };
})();
