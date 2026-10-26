/* ══════════════════════════════════════════════════════════════════════════
 * V7 卡片总管理员（ui-pure/cards/card-manager.js）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这是干什么的
 * ────────────
 * 在这之前，9 张一级卡的渲染器散在 card-architecture.js 一个文件里
 * （generation / settings / records / debug / tutorial / projects / assistant
 *  七段长在一起，加上 ui.html 自己管的两张），改一张要在一堆里找。
 *
 * 现在：每张卡一个文件（cards/card-<id>.js），**自己注册进来**；
 * 这份管理员负责——① 排好序 ② 统一分发 ③ 自检对账 ④ 隔离错误。
 *
 * 规矩见 cards/_CONTRACT.md（每个卡片作者都要读）。
 *
 * ⚠ 这份文件【不改任何现有行为】。它是一层薄薄的调度：
 *   注册表里没有的卡，照样回落到老路径（V7CardArchitecture[id]）。
 *   —— 这样拆到一半时，没拆的卡一切照旧，拆好的卡走新路。
 *
 * 用法
 * ────
 *   V7CardManager.register({ id, index, name, levels, mount, source? })
 *   V7CardManager.mount(id, body, zone)     ← ui.html 分发时调这个
 *   V7CardManager.audit()                   ← 自检，返回问题清单
 *   V7CardManager.list()                    ← 已登记的卡（按 index 排好）
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // 已登记的卡：id → 卡片对象
  var registry = new Map();
  // 登记顺序（用来在 id 撞车时报出"谁先谁后"）
  var order = [];
  // 已认领的分发计数（调试用：看哪张卡真被挂过）
  var mountCount = new Map();

  var REQUIRED = ['id', 'index', 'name', 'levels', 'mount'];
  var LEVELS = ['main-zone', 'main-bigzone'];

  // ── 校验一张卡合不合格 ──────────────────────────────────────────
  // 返回问题字符串数组（空数组 = 合格）。
  // ⚠ 校验失败【不抛错、不拦路】—— 只在控制台报警并记进 audit()。
  //   理由：卡片缺字段是"开发期的错"，不该让用户看到白屏。
  function validate(card) {
    var problems = [];
    if (!card || typeof card !== 'object') return ['不是一个对象'];
    for (var i = 0; i < REQUIRED.length; i++) {
      var key = REQUIRED[i];
      if (card[key] === undefined || card[key] === null || card[key] === '') {
        problems.push('缺字段 ' + key);
      }
    }
    if (typeof card.mount !== 'function') problems.push('mount 不是函数');
    if (card.levels && LEVELS.indexOf(card.levels) === -1) {
      problems.push('levels 取值非法：' + card.levels + '（只允许 ' + LEVELS.join(' / ') + '）');
    }
    if (card.index !== undefined && (typeof card.index !== 'number' || card.index < 0)) {
      problems.push('index 必须是非负数字：' + card.index);
    }
    return problems;
  }

  function register(card) {
    var problems = validate(card);
    if (problems.length) {
      // ⚠ 明着报，不静默吞
      if (root.console && console.warn) {
        console.warn('[V7CardManager] 卡片不合格，未登记：' + (card && card.id ? card.id : '(无 id)') +
          '\n  · ' + problems.join('\n  · ') + '\n  规矩见 ui-pure/cards/_CONTRACT.md');
      }
      return false;
    }
    if (registry.has(card.id)) {
      // ⚠ id 撞车是硬错：两张卡抢同一个 id，分发时会随机赢一个。
      //   注册表文件 card-registry.js 里也有同样的 id，那是"地图"，
      //   这里是"真身"—— 真身撞车必须炸出来。
      if (root.console && console.error) {
        console.error('[V7CardManager] id 撞车：' + card.id + ' 已被登记过（登记顺序：' + order.join(' → ') + '）');
      }
      return false;
    }
    var frozen = Object.freeze({
      id: card.id,
      index: card.index,
      name: card.name,
      levels: card.levels,
      mount: card.mount,
      // source 只用来在自检报告里写"这张卡的内容现在住在哪个文件"
      source: card.source || '(未标注)'
    });
    registry.set(frozen.id, frozen);
    order.push(frozen.id);
    return true;
  }

  // ── 统一分发 ────────────────────────────────────────────────────
  // ⚠ 这是 ui.html 唯一该调的入口。逻辑：
  //   ① 登记过的卡 → 走它自己的 mount()
  //   ② 没登记的卡 → 回落到 V7CardArchitecture[id]（老路径，行为不变）
  //   ③ 两边都没有 → 明着说"没接线"，不留假页面
  //   ④ 任何一步抛错 → 【只这一张卡失败】，其余卡不受影响
  function mount(id, body, zone) {
    if (!body) return false;
    var card = registry.get(id);
    var count = (mountCount.get(id) || 0) + 1;
    mountCount.set(id, count);

    // 新路径
    if (card) {
      try {
        card.mount(body, zone);
        return true;
      } catch (error) {
        // ⚠ 隔离：一张卡崩了不能带崩整台界面。
        //   报错堆照常收（ERR.report 是全局的）。
        if (root.ERR && typeof root.ERR.report === 'function') {
          root.ERR.report('CARD_MOUNT_FAILED', {
            message: '卡片 ' + id + ' 渲染失败：' + (error && error.message || error),
            card: id, zone: zone
          });
        } else if (root.console) {
          console.error('[V7CardManager] 卡片 ' + id + ' 渲染失败', error);
        }
        return false;
      }
    }

    // 老路径（还没拆的卡走这里）
    var legacy = root.V7CardArchitecture && root.V7CardArchitecture[id];
    if (typeof legacy === 'function') {
      legacy(body, zone);
      return true;
    }

    // 两边都没有 —— 明着说，不留假页面。
    // ⚠ 原 ui.html 那段"通用渲染"（假参数行 + 假开始按钮）已经删过一次，
    //   理由写在原注释里：留着有害，加回真卡片却忘了接线会安静退化成假页面。
    if (root.console && console.warn) {
      console.warn('[V7CardManager] 没有卡片渲染器：' + id +
        '（既没登记，V7CardArchitecture 里也没有这个键）');
    }
    body.innerHTML = '<div class="ai-note">这张卡还没有接入详情渲染器（' + id +
      '）。<br>加卡的规矩见 ui-pure/cards/_CONTRACT.md：先写好功能，再放界面入口。</div>';
    return false;
  }

  // ── 自检对账 ────────────────────────────────────────────────────
  // 返回 { ok, problems[], cards[] }。给 scripts/check-card-contract.cjs 用，
  // 也可以在任何时候在控制台敲 V7CardManager.audit() 看状态。
  function audit() {
    var problems = [];
    var cards = list();

    // ① 断言"真的扫到了东西"——扫 0 张卡报 0 问题，跟探针不断言一样是假绿。
    //    （docs/147 §一 教训：审计器不加参数时输出假的"零违规"。）
    if (cards.length === 0) {
      problems.push('一张卡都没登记 —— 先确认卡片脚本是不是真的加载了');
      return { ok: false, problems: problems, cards: cards };
    }

    // ② index 必须连续且不重复
    var seenIndex = new Map();
    cards.forEach(function (card) {
      if (seenIndex.has(card.index)) {
        problems.push('index ' + card.index + ' 被两张卡占用：' +
          seenIndex.get(card.index) + ' 和 ' + card.id);
      } else {
        seenIndex.set(card.index, card.id);
      }
    });
    var expect = 0;
    cards.forEach(function (card) {
      if (card.index !== expect) {
        problems.push('index 不连续：期望 ' + expect + '，实际 ' + card.index + '（' + card.id + '）');
      }
      expect = Math.max(expect, card.index + 1);
    });

    // ③ 跟 card-registry.js 的"地图"对账
    var map = root.V7CardRegistry;
    if (map && typeof map.ids === 'function') {
      var mapped = map.ids();
      mapped.forEach(function (id) {
        if (!registry.has(id)) problems.push('地图里有 ' + id + '，但没有卡片登记它');
      });
      cards.forEach(function (card) {
        if (mapped.indexOf(card.id) === -1) problems.push('登记了 ' + card.id + '，但地图里没有');
      });
    } else {
      problems.push('V7CardRegistry 没加载 —— 无法跟地图对账（卡片脚本是不是排在 registry 前面了？）');
    }

    return { ok: problems.length === 0, problems: problems, cards: cards };
  }

  function list() {
    return Array.from(registry.values()).sort(function (a, b) { return a.index - b.index; });
  }

  // 调试用：看每张卡被挂了几次。挂载次数异常增长 = 有地方在重复挂。
  function stats() {
    var out = {};
    mountCount.forEach(function (value, key) { out[key] = value; });
    return out;
  }

  root.V7CardManager = Object.freeze({
    register: register,
    mount: mount,
    audit: audit,
    list: list,
    stats: stats,
    // ⚠ 只读，别拿它当写入入口
    get size() { return registry.size; }
  });
})(window);
