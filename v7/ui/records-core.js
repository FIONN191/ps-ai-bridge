/* 记录与恢复卡 · 纯逻辑地基（无 DOM、无 IPC，可在 node 里单测）
 *
 * 这一层只回答三类问题，界面怎么画都不归它管：
 *   1. 一笔任务要花多少钱（价目表从 V6 的 tiles/tile-params.js 搬过来，集中在这一处）；
 *   2. 缓存行怎么按「项目 = PS 文件」分组、排序、算合计；
 *   3. 搜索词（日期写法 / 任务名 / 项目名 / 提示词）怎么匹配。
 *
 * 计费规矩（用户 2026-08-02 定，记录卡沿用）：
 *   aji  = 发送即扣 → 按发起张数记（成功 + 失败都算）
 *   grs  = 成功才扣 → 只按成功张数记
 *   momo / 自定义服务商 / RunningHub 等 → 单价只有后台账单知道 → 显示「以账单为准」，不计入合计
 *   本机工具 / 本机工作流 → 「本机」，不花钱
 *
 * ⚠ 单位（别搞混）：
 *   aji 的价目表是【美元】；grs 的价目表是【积分】，1000 积分 = $0.1（即 1 积分 = $0.0001）。
 *   ⚠ 记录卡用的是 GRS【内置价目表】（就是本文件里「1」= 1000 积分那张）。
 *     不是「Others 自定义渠道」那张外链价目表 —— 后者压根不是积分单位。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7RecordsCore = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var DAY = 86400000;
  var MIN = 60000;

  // 积分 → 美元。用户定案：1000 积分 = $0.1。
  var POINTS_PER_USD = 10000; // 1 美元 = 10000 积分
  function pointsToUsd(points) { return (Number(points) || 0) / POINTS_PER_USD; }

  // ============================================================
  //  价目表（唯一来源，只在这里维护）
  //  直接从 V6 tiles/tile-params.js 的 MODEL_CONFIG / GRS_MODEL_CONFIG 搬来。
  //  ⚠ 改价只改这里；已完成的旧记录不受影响（金额在完成那一刻就写进 meta.cost 了）。
  // ============================================================
  var AJI_MODELS = Object.freeze({
    'AJbanana3': { name: '香蕉Pro', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.15, '2K': 0.16, '4K': 0.18 } },
    'Banana-pro-D': { name: '香蕉Pro-D', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.1, '2K': 0.1, '4K': 0.1 } },
    'AJbanana2': { name: '香蕉2', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.1, '2K': 0.1, '4K': 0.1 } },
    'gemini-2.5-flash-image': { name: '香蕉1', sizes: ['1K'], prices: { '1K': 0.04 } },
    'gpt-image-2': { name: 'GPT-Image-2', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.04, '2K': 0.08, '4K': 0.16 } }
  });

  // grs 价目表单位 = 积分（「1」= 1000 积分）
  var GRS_MODELS = Object.freeze({
    'nano-banana-2': { name: 'nano-banana-2', sizes: ['1K', '2K', '4K'], prices: { '1K': 1, '2K': 2, '4K': 4 } },
    'nano-banana-fast': { name: 'nano-banana-fast', sizes: ['1K'], prices: { '1K': 1 } },
    'nano-banana': { name: 'nano-banana', sizes: ['1K'], prices: { '1K': 1 } },
    'nano-banana-pro': { name: 'nano-banana-pro', sizes: ['1K', '2K', '4K'], prices: { '1K': 2, '2K': 3, '4K': 5 } },
    'nano-banana-pro-vt': { name: 'nano-banana-pro-vt', sizes: ['1K', '2K', '4K'], prices: { '1K': 2, '2K': 3, '4K': 5 } },
    'nano-banana-pro-cl': { name: 'nano-banana-pro-cl', sizes: ['1K', '2K', '4K'], prices: { '1K': 2, '2K': 3, '4K': 5 } },
    'nano-banana-pro-vip': { name: 'nano-banana-pro-vip', sizes: ['1K', '2K'], prices: { '1K': 3, '2K': 5 } },
    'nano-banana-pro-4k-vip': { name: 'nano-banana-pro-4k-vip', sizes: ['4K'], prices: { '4K': 8 } },
    'gpt-image-2': { name: 'GPT-Image-2', sizes: ['1K', '2K'], prices: { '1K': 2, '2K': 4 } },
    'gpt-image-2-vip': { name: 'GPT-Image-2 VIP (支持 4K)', sizes: ['1K', '2K', '4K'], prices: { '1K': 3, '2K': 5, '4K': 10 } }
  });

  // 进缓存的那些任务种类。别的（链路验证之类）不参与记录与计费。
  var CACHED_KINDS = ['generation', 'glow', 'dlss', 'matting', 'segment', 'sam2'];

  // ⭐ 2026-10-15：外部价目来源（目前只有阿吉）。见 priceOf 的说明。
  var resolvers = {};
  function setPriceResolver(table, fn) { resolvers[String(table)] = typeof fn === 'function' ? fn : null; }

  function isCachedKind(kind) { return CACHED_KINDS.indexOf(String(kind || '')) >= 0; }

  // 「本机工具」：不走接口、不花钱的那些。
  function isLocalToolKind(kind) {
    return kind === 'glow' || kind === 'matting' || kind === 'segment' || kind === 'sam2' || kind === 'dlss';
  }

  // ============================================================
  //  服务商归一：算出「用哪张价目表」
  //  ⚠ V7 的 provider 只有 aji / momo / other 三种；
  //    grs 是 provider='other' + connectionSlot='grs'（见 provider-connections.js）。
  //    老记录可能带 V6 时代的 provider='grs'，这里一并认。
  // ============================================================
  function rateTable(meta) {
    var provider = String((meta && meta.provider) || '');
    var slot = String((meta && (meta.connectionSlot || meta.computeSlot)) || '');
    // ⭐ 2026-10-16：千问模式的单 provider 还留着 aji（重新生成要用），按通道 'qwen' 认 →
    //   以账单为准（千问现在免费、后台随时能改收费）；不能按阿吉价目表算钱。本机算的下面 isLocalCompute 认成免费。
    if (slot === 'qwen') return 'billing';
    if (provider === 'grs' || slot === 'grs') return 'grs';
    if (provider === 'aji' || slot === 'aji') return 'aji';
    // ⭐ 2026-10-24（V7待办/02，用户定「墨墨跟阿吉一模一样」）：墨墨按后台模型目录的价算；目录里没价照旧「以账单为准」
    if (provider === 'momo' || slot === 'momo') return 'momo';
    return 'billing'; // other(自定义) / runninghub / 未知 → 以账单为准
  }

  // 「这笔是不是跑在我自己机器上、根本不花钱」。
  //
  // ⚠⚠ 别把 computeSource==='own' 当成免费（2026-09-30 第一版就这么写错了，
  //   结果是所有用自己的 key 的任务全算成 $0）。
  //   computeSource 的两个值是 'own' / 'platform'，说的是【钱付给谁】：
  //     own      = 用自己的 API Key → 钱照样付给服务商，只是不经过平台
  //     platform = 走平台代付（积分）
  //   两个都要花钱。真正免费的只有：
  //     · 本机工具（辉光/抠像/人体分割/SAM/DLSS）—— 本文件 isLocalToolKind
  //     · 本机工作流：computeSource==='local'（自己的 ComfyUI）
  //   ⚠ RunningHub 是【云端付费服务】，按计划该是「以账单为准」，不是本机。
  function isLocalCompute(meta) {
    if (!meta) return false;
    if (String(meta.computeSource || '') === 'local') return true;   // 本机 ComfyUI
    var provider = String(meta.provider || '');
    return provider === 'local' || provider === 'comfy';
  }

  function priceOf(table, model, size) {
    // ⭐ 2026-10-24（V7待办/02）：墨墨的单价来自供应商在后台配的模型目录（宿主 setPriceResolver('momo', …)）
    if (table === 'momo') {
      var m = null;
      try { m = typeof resolvers.momo === 'function' ? resolvers.momo(model, size) : null; } catch (_) { m = null; }
      if (!m || typeof m.price !== 'number' || !isFinite(m.price)) return null;
      return { price: m.price, size: String(size || ''), name: m.name || '', model: m.model || '' };
    }
    if (table !== 'aji' && table !== 'grs') return null;
    // ⭐⭐ 2026-10-15：阿吉的单价【以后台价目表为准】（ui-pure/aji-prices.js 从 /v1/public/aji-prices 拉）。
    //   宿主（ui.html）启动时 setPriceResolver('aji', …V7AjiPrices.priceFor) 接上；
    //   接上之后上面那张写死的 AJI_MODELS【不再参与】—— 它是 V6 搬来的旧表，少了 pro-A / 香蕉2.1 /
    //   gpt-image-2.5 两个，gpt-image-2 的价也不对（旧表按分辨率 0.04/0.08/0.16，后台表统一 0.07）。
    //   价目表里查不到 ⇒ 返回 null ⇒ 「以账单为准」，不当免费、不拿旧表顶。
    //   ⚠ 没接 resolver 的环境（node 单测）照旧用写死的表，老测试不受影响。
    if (table === 'aji' && typeof resolvers.aji === 'function') {
      var got = null;
      try { got = resolvers.aji(model, size); } catch (_) { got = null; }
      if (!got || typeof got.price !== 'number' || !isFinite(got.price)) return null;
      return { price: got.price, size: String(size || ''), name: got.name || '', model: got.model || '' };
    }
    var catalog = table === 'aji' ? AJI_MODELS : GRS_MODELS;
    var entry = catalog[String(model || '')];
    if (!entry) return null;
    var key = String(size || '') || (entry.sizes && entry.sizes[0]) || '1K';
    // 尺寸对不上时退回该模型的第一档（V6 也是这么兜的），总比显示 0 强
    var price = entry.prices && typeof entry.prices[key] === 'number' ? entry.prices[key] : null;
    if (price == null && entry.sizes && entry.sizes.length) price = entry.prices[entry.sizes[0]];
    if (typeof price !== 'number') return null;
    return { price: price, size: key, name: entry.name || '' };
  }

  // ============================================================
  //  张数统计：meta 里 shots 数组 → 成功 / 失败 / 总发起
  //  ⚠ aji 按「发起张数」扣，所以总发起 ≠ 成功 + 失败（还有排队中的）；
  //    有显式 generated 计数时优先用它，否则用 shots/batch 兜。
  // ============================================================
  function shotCounts(meta) {
    meta = meta || {};
    var shots = Array.isArray(meta.shots) ? meta.shots : [];
    var ok = 0, fail = 0;
    for (var i = 0; i < shots.length; i++) {
      var s = shots[i] || {};
      if (s.error) fail++;
      else if (s.done || s.hasImage) ok++;
    }
    if (typeof meta.generated === 'number') ok = meta.generated;
    if (typeof meta.failCount === 'number') fail = meta.failCount;
    var batch = Number(meta.batch) || 0;
    var sent = Number(meta.sent) || (ok + fail);
    if (sent < batch) sent = batch; // 发起张数不会少于批次
    if (sent < ok + fail) sent = ok + fail;
    return { ok: ok, fail: fail, sent: sent, total: Math.max(1, batch || shots.length || 1) };
  }

  function taskStatus(meta) {
    return String((meta && meta.status) || '');
  }

  function isLiveStatus(status) {
    return status === 'running' || status === 'queued' || status === 'pending' || status === 'preparing';
  }

  function isDoneStatus(status) {
    return status === 'done' || status === 'success' || status === 'completed';
  }

  // ============================================================
  //  taskCost(meta) —— 单笔任务的金额
  //
  //  入参 meta 用缓存 meta.json / 任务对象的字段即可：
  //    { kind, provider, connectionSlot, computeSource, model, size, status, batch, shots, generated, cost }
  //
  //  返回（永远有 usd，单位美元）：
  //    usd      金额（美元，拿不准时为 0）
  //    status   'free' 本机 / 'pending' 以账单为准 / 'live' 还在跑 / 'recorded' 用完成时快照 / 'priced' 现场算的
  //    free     true = 不花钱；pendingBilling true = 以账单为准（不计入合计）
  //    unit     单价（原单位：aji 美元 / grs 积分）
  //    unitKind 'usd' | 'points'
  //    count    计了几张
  //    table    'aji' | 'grs' | 'billing'
  // ============================================================
  function taskCost(meta) {
    meta = meta || {};
    var base = function (patch) {
      var out = { usd: 0, unit: 0, unitKind: 'usd', count: 0, table: 'billing', free: false, pendingBilling: false, status: 'priced' };
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
      return out;
    };
    var kind = String(meta.kind || 'generation');

    // 1) 本机的不花钱
    if (isLocalToolKind(kind) || isLocalCompute(meta)) return base({ status: 'free', free: true, count: shotCounts(meta).total });

    // 2) 还在跑：金额还没定，先别算（记录卡上显示「生成中」）
    if (isLiveStatus(taskStatus(meta))) return base({ status: 'live', count: shotCounts(meta).total });

    // 3) 完成时已经把金额快照进 meta 了 → 认它，之后改价目表不影响旧账
    //   ⭐ 2026-10-15 例外：阿吉那笔当时【没价】（旧表里没这个模型，快照写的是"以账单为准"、金额 0）
    //     ⇒ 现在价目表里查得到就按现价补上。它当时根本没记金额，补上不算"改旧账"；
    //       不补的话 pro-A / 香蕉2.1 这些模型以前的记录永远是"以账单为准"，总消耗就一直漏算。
    var recorded = meta.cost;
    // 2026-10-24：墨墨同理（以前墨墨的记录一律「以账单为准」，目录有价以后补上）
    var ajiUnpriced = recorded && typeof recorded === 'object' && recorded.pendingBilling && ['aji', 'momo'].indexOf(String(recorded.table || '')) >= 0;
    if (recorded && typeof recorded === 'object' && recorded.pendingBilling && String(recorded.table || '') === 'billing' && rateTable(meta) === 'momo') ajiUnpriced = true;
    if (!ajiUnpriced && recorded && typeof recorded === 'object' && typeof recorded.usd === 'number' && isFinite(recorded.usd)) {
      return base({
        usd: recorded.usd, unit: Number(recorded.unit) || 0,
        unitKind: recorded.unitKind === 'points' ? 'points' : 'usd',
        count: Number(recorded.count) || 0, table: String(recorded.table || rateTable(meta)),
        status: 'recorded', free: !!recorded.free, pendingBilling: !!recorded.pendingBilling
      });
    }
    // 兼容：只写了裸数字的老记录
    if (typeof recorded === 'number' && isFinite(recorded)) return base({ usd: recorded, status: 'recorded' });

    // 4) 现场算
    var counts = shotCounts(meta);
    var table = rateTable(meta);

    if (table === 'billing') {
      // momo / 自定义服务商：单价只有后台账单知道
      return base({ status: 'pending', pendingBilling: true, count: counts.sent, table: 'billing' });
    }

    var hit = priceOf(table, meta.model, meta.size);
    if (!hit) {
      // 价目表里没有这个模型（新模型还没搬进来）→ 同样按「以账单为准」处理，别显示 0 骗人
      return base({ status: 'pending', pendingBilling: true, count: counts.sent, table: table });
    }

    if (table === 'aji') {
      // 发送即扣：成功 + 失败都算
      var sent = counts.sent;
      return base({ usd: hit.price * sent, unit: hit.price, unitKind: 'usd', count: sent, table: 'aji', status: 'priced', free: false });
    }
    if (table === 'momo') {
      // 墨墨成功才扣（跟 GRS 一样只按成功张数算，备忘 billing-rules）；金额就是目录里填的数（显示 ¥，不换算）
      var okMomo = counts.ok;
      return base({ usd: hit.price * okMomo, unit: hit.price, unitKind: 'usd', count: okMomo, table: 'momo', status: 'priced', free: false });
    }
    // grs：成功才扣，积分折美元
    var ok = counts.ok;
    return base({
      usd: pointsToUsd(hit.price * ok), unit: hit.price, unitKind: 'points',
      count: ok, table: 'grs', status: 'priced', free: false
    });
  }

  // 完成任务时写进 meta 的快照（cacheMetaFromTask 用）
  function costSnapshot(meta) {
    var c = taskCost(meta);
    return { usd: c.usd, unit: c.unit, unitKind: c.unitKind, count: c.count, table: c.table, free: c.free, pendingBilling: c.pendingBilling, at: Date.now() };
  }

  // ============================================================
  //  金额显示
  //  ⚠ 本机 → 「本机」；拿不准 → 「以账单为准」；这两种都不计入合计。
  // ============================================================
  function formatUsd(value) {
    var v = Number(value) || 0;
    // ⭐ 2026-10-24（用户定）：花费一律显示「¥」——只换符号，不换算汇率（数字跟中转站后台对得上）
    if (v >= 10) return '¥' + v.toFixed(1);
    if (v >= 1) return '¥' + v.toFixed(2);
    if (v > 0) return '¥' + v.toFixed(3);
    return '¥0';
  }

  function formatPoints(points) {
    var p = Number(points) || 0;
    if (p >= 10000) return (p / 10000).toFixed(1) + ' 万积分';
    return Math.round(p).toLocaleString('en-US') + ' 积分';
  }

  function formatAmount(cost) {
    cost = cost || taskCost({});
    if (cost.free) return '本机';
    if (cost.status === 'live') return '生成中';
    if (cost.pendingBilling) return '以账单为准';
    return formatUsd(cost.usd);
  }

  // 项目合计：把 pending（以账单为准）的条数一起带出来，界面上要标「+N 项以账单为准」
  function summarizeCosts(list) {
    var usd = 0, pending = 0, live = 0, free = 0;
    (list || []).forEach(function (item) {
      var c = taskCost(item && item.meta ? item.meta : item);
      if (c.pendingBilling) pending++;
      else if (c.status === 'live') live++;
      else if (c.free) free++;
      else usd += c.usd;
    });
    return { usd: usd, pending: pending, live: live, free: free, text: formatUsd(usd) };
  }

  // ============================================================
  //  时间
  // ============================================================
  function startedAt(meta) {
    meta = meta || {};
    var t = Number(meta.startedAt) || Number(meta.t0) || Number(meta.savedAt) || 0;
    if (!t) {
      var run = /^(\d{8})-(\d{6})/.exec(String(meta.runId || ''));
      if (run) {
        var s = run[1], c = run[2];
        t = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +c.slice(0, 2), +c.slice(2, 4), +c.slice(4, 6)).getTime();
      }
    }
    return t;
  }

  function completedAt(meta) {
    meta = meta || {};
    return Number(meta.completedAt) || Number(meta.t1) || startedAt(meta);
  }

  function dayStart(ms) { var d = new Date(Number(ms) || 0); d.setHours(0, 0, 0, 0); return d.getTime(); }

  function dayLabel(ms) {
    var s = dayStart(ms), today = dayStart(Date.now());
    if (s === today) return '今天';
    if (s === today - DAY) return '昨天';
    if (s === today - 2 * DAY) return '前天';
    var d = new Date(Number(ms) || 0);
    return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function clockLabel(ms) {
    var d = new Date(Number(ms) || 0);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // 「今天 14:03」这种
  function whenLabel(ms) { return dayLabel(ms) + ' ' + clockLabel(ms); }

  // ============================================================
  //  搜索：日期写法（样机 parseDateToken 原样搬过来）
  // ============================================================
  function parseDateToken(tok) {
    tok = String(tok == null ? '' : tok).trim();
    if (!tok) return null;
    var now = new Date(), y = now.getFullYear(), td = dayStart(Date.now());
    function day(Y, M, D) {
      if (M < 1 || M > 12 || D < 1 || D > 31) return null;
      var s = new Date(Y, M - 1, D).getTime();
      if (new Date(Y, M - 1, D).getMonth() !== M - 1) return null; // 2月30日之类
      return [s, s + DAY];
    }
    function month(Y, M) { return M >= 1 && M <= 12 ? [new Date(Y, M - 1, 1).getTime(), new Date(Y, M, 1).getTime()] : null; }
    if (tok === '今天' || tok === '今日') return [td, td + DAY];
    if (tok === '昨天' || tok === '昨日') return [td - DAY, td];
    if (tok === '前天') return [td - 2 * DAY, td - DAY];
    var wk = td - ((new Date(td).getDay() + 6) % 7) * DAY; // 周一为一周开始
    if (tok === '本周' || tok === '这周') return [wk, wk + 7 * DAY];
    if (tok === '上周') return [wk - 7 * DAY, wk];
    if (tok === '本月' || tok === '这个月') return month(y, now.getMonth() + 1);
    if (tok === '上月' || tok === '上个月') return month(y, now.getMonth());
    var m;
    if ((m = tok.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/))) return day(+m[1], +m[2], +m[3]);
    if ((m = tok.match(/^(\d{4})(\d{2})(\d{2})$/))) return day(+m[1], +m[2], +m[3]);
    if ((m = tok.match(/^(\d{1,2})[-/.月](\d{1,2})[日号]?$/))) return day(y, +m[1], +m[2]);
    if ((m = tok.match(/^(\d{4})[-/.年](\d{1,2})月?$/))) return month(+m[1], +m[2]);
    if ((m = tok.match(/^(\d{1,2})月$/))) return month(y, +m[1]);
    if ((m = tok.match(/^(\d{1,2})[日号]$/))) return day(y, now.getMonth() + 1, +m[1]);
    return null;
  }

  // 项目名清洗：「a-anonymous~d-local-device~p-default__X37_1751____.jpg」→「X37_1751」
  function projectLabel(project) {
    var raw = String(project || '');
    var tail = raw.indexOf('__') >= 0 ? raw.slice(raw.indexOf('__') + 2) : raw;
    tail = tail.replace(/\.(psd|psb|jpg|jpeg|png|tif|tiff|bmp)$/i, '').replace(/_+$/, '');
    return tail || raw || '未命名项目';
  }

  function projectDocName(meta, project) {
    meta = meta || {};
    var name = String(meta.sourceDocName || (meta.captureSnapshot && meta.captureSnapshot.docName) || '').trim();
    if (name) return name.replace(/\.[a-z0-9]+$/i, '');
    return projectLabel(project);
  }

  // 任务名（记录卡横条上那行标题）
  function taskLabel(meta) {
    meta = meta || {};
    var label = String(meta.label || '').trim();
    if (label && label !== '自定义提示词') return label;
    if (meta.presetTitle) return String(meta.presetTitle);
    var prompt = String(meta.prompt || '').trim();
    if (prompt) return prompt.length > 18 ? prompt.slice(0, 18) + '…' : prompt;
    return label || '未命名任务';
  }

  // ============================================================
  //  项目分组：缓存行 → 项目列表
  //
  //  行 = 缓存里的一条任务记录，形状 { project, runId, meta }（host.cache.list() 的 runs）
  //  项目 = 同 project 的行聚在一起
  // ============================================================
  function normalizeRows(rows) {
    return (rows || []).filter(function (row) {
      return row && row.meta && isCachedKind(row.meta.kind);
    });
  }

  function groupRows(rows) {
    var byProject = new Map();
    normalizeRows(rows).forEach(function (row) {
      var key = String(row.project || '');
      if (!byProject.has(key)) {
        byProject.set(key, { project: key, label: projectDocName(row.meta, key), rows: [], lastAt: 0, firstAt: Infinity });
      }
      var group = byProject.get(key);
      group.rows.push(row);
      var s = startedAt(row.meta);
      if (s > group.lastAt) group.lastAt = s;
      if (s < group.firstAt) group.firstAt = s;
    });
    var groups = Array.from(byProject.values());
    groups.forEach(function (group) {
      group.rows.sort(function (a, b) {
        var d = startedAt(b.meta) - startedAt(a.meta);
        return d || String(b.runId || '').localeCompare(String(a.runId || ''));
      });
      group.count = group.rows.length;
      group.cost = summarizeCosts(group.rows);
      group.live = group.rows.some(function (row) { return isLiveStatus(taskStatus(row.meta)); });
      group.docName = projectDocName(group.rows[0] && group.rows[0].meta, group.project);
    });
    // 最近有动静的项目排前面
    groups.sort(function (a, b) { return b.lastAt - a.lastAt; });
    return groups;
  }

  // ============================================================
  //  搜索：任务名 / 项目名优先，提示词靠后
  //  query 可以混着写：「今天 兔女郎」「09-29 修脸」
  // ============================================================
  function buildMatcher(query) {
    var tokens = String(query == null ? '' : query).trim().split(/\s+/).filter(Boolean);
    var ranges = [], words = [];
    tokens.forEach(function (tok) {
      var r = parseDateToken(tok);
      if (r) ranges.push(r); else words.push(tok.toLowerCase());
    });
    return { ranges: ranges, words: words, empty: !ranges.length && !words.length };
  }

  // 返回 null = 不匹配；数字越小越靠前 = 越像用户要找的
  function matchRow(row, matcher) {
    if (!matcher || matcher.empty) return 0;
    var meta = (row && row.meta) || {};
    var time = completedAt(meta) || startedAt(meta);
    for (var i = 0; i < matcher.ranges.length; i++) {
      var r = matcher.ranges[i];
      if (time < r[0] || time >= r[1]) return null;
    }
    if (!matcher.words.length) return 0;
    var fields = [
      { text: projectDocName(meta, row.project), rank: 1 },   // 项目名最优先
      { text: taskLabel(meta), rank: 2 },                     // 任务名
      { text: String(meta.presetTitle || ''), rank: 3 },
      { text: String(meta.model || ''), rank: 5 },
      { text: String(meta.prompt || ''), rank: 6 },           // 提示词靠后
      { text: String(meta.runId || ''), rank: 8 }
    ].map(function (f) { return { text: String(f.text || '').toLowerCase(), rank: f.rank }; });

    var best = Infinity;
    for (var w = 0; w < matcher.words.length; w++) {
      var word = matcher.words[w], hit = Infinity;
      for (var f = 0; f < fields.length; f++) {
        if (fields[f].text && fields[f].text.indexOf(word) >= 0) hit = Math.min(hit, fields[f].rank);
      }
      if (hit === Infinity) return null; // 关键词一个都没命中 → 整条不算
      best = Math.min(best, hit);
    }
    return best;
  }

  function searchRows(rows, query) {
    var matcher = buildMatcher(query);
    var scored = [];
    normalizeRows(rows).forEach(function (row) {
      var score = matchRow(row, matcher);
      if (score === null) return;
      scored.push({ row: row, score: score });
    });
    scored.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return startedAt(b.row.meta) - startedAt(a.row.meta);
    });
    return scored.map(function (item) { return item.row; });
  }

  function searchGroups(groups, query) {
    var matcher = buildMatcher(query);
    if (matcher.empty) return groups;
    var out = [];
    groups.forEach(function (group) {
      var rows = group.rows.filter(function (row) { return matchRow(row, matcher) !== null; });
      if (!rows.length) return;
      var copy = Object.assign({}, group, {
        rows: rows, count: rows.length, cost: summarizeCosts(rows),
        live: rows.some(function (row) { return isLiveStatus(taskStatus(row.meta)); })
      });
      out.push(copy);
    });
    return out;
  }

  // ============================================================
  //  检查点 ↔ 项目
  //  ⚠ 检查点不新增字段：用 cacheRef 路径里的文件夹名对上项目的 project 名。
  // ============================================================
  function checkpointProject(checkpoint) {
    var ref = String((checkpoint && checkpoint.cacheRef) || '');
    var m = /^cache:([^/]+)\/([^/]+)\/canvas\.png$/.exec(ref);
    return m ? m[1] : '';
  }

  // ⚠ 真实 checkpoint.json 的 createdAt 是 ISO 文字（"2026-09-30T05:58:26.221Z"），
  //   Number() 读出来是 NaN → 整条被当坏数据扔掉（2026-09-30 查到，测试一直塞的是数字）。
  function checkpointTime(cp) {
    var raw = cp && (cp.time || cp.createdAt);
    var n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    var parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeCheckpoints(list) {
    return (list || []).filter(function (cp) {
      return cp && (checkpointProject(cp) || cp.project) && checkpointTime(cp) > 0;
    }).map(function (cp) {
      return { raw: cp, project: checkpointProject(cp) || String(cp.project || ''), time: checkpointTime(cp) };
    }).sort(function (a, b) { return b.time - a.time; }); // 新的在上
  }

  // 某个项目下的检查点，按天分组（时间轴上那种）
  function checkpointsForProject(checkpoints, project) {
    var key = String(project || '');
    return normalizeCheckpoints(checkpoints).filter(function (cp) { return cp.project === key; });
  }

  // 「之前 / 之后」：任务完成时间 ≤ 检查点时间 → 之前
  function splitByCheckpoint(rows, checkpoint) {
    var at = (checkpoint && typeof checkpoint === 'object') ? checkpointTime(checkpoint) : (Number(checkpoint) || 0);
    var before = [], after = [];
    normalizeRows(rows).forEach(function (row) {
      (completedAt(row.meta) <= at ? before : after).push(row);
    });
    return { before: before, after: after, at: at };
  }

  return {
    DAY: DAY, MIN: MIN, POINTS_PER_USD: POINTS_PER_USD,
    AJI_MODELS: AJI_MODELS, GRS_MODELS: GRS_MODELS, CACHED_KINDS: CACHED_KINDS,
    isCachedKind: isCachedKind, isLocalToolKind: isLocalToolKind, isLocalCompute: isLocalCompute,
    rateTable: rateTable, priceOf: priceOf, pointsToUsd: pointsToUsd, setPriceResolver: setPriceResolver,
    shotCounts: shotCounts, isLiveStatus: isLiveStatus, isDoneStatus: isDoneStatus,
    taskCost: taskCost, costSnapshot: costSnapshot,
    formatUsd: formatUsd, formatPoints: formatPoints, formatAmount: formatAmount, summarizeCosts: summarizeCosts,
    startedAt: startedAt, completedAt: completedAt, dayStart: dayStart, dayLabel: dayLabel, clockLabel: clockLabel, whenLabel: whenLabel,
    parseDateToken: parseDateToken, buildMatcher: buildMatcher, matchRow: matchRow, searchRows: searchRows, searchGroups: searchGroups,
    projectLabel: projectLabel, projectDocName: projectDocName, taskLabel: taskLabel,
    normalizeRows: normalizeRows, groupRows: groupRows,
    checkpointProject: checkpointProject, normalizeCheckpoints: normalizeCheckpoints,
    checkpointsForProject: checkpointsForProject, splitByCheckpoint: splitByCheckpoint
  };
});
