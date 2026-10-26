/* ══════════════════════════════════════════════════════════════════════════
 * V7EngineStatus · 引擎/环境/模型状态的【唯一出口】（docs/150 §4.1，Phase A）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 为什么要有这个文件（docs/150 §一）：
 *   同一个模型，现在四个地方四个结论 —— model_manager catalog（文件大小+收据）、
 *   引擎 /health（大小+decoder配对+torch/cuda）、max_tier_by_kind（显存）、
 *   前端探活（60秒缓存，一次超时把六个档位全清 0）。
 *   外挂卡 / 调试卡 / 错误"下一步" / 设置卡跳转各判各的，早晚互相打架。
 *   ⇒ 从此这些地方【只读这里】。任何卡片不许自己再判一遍。
 *
 * 数据来源（不新增宿主 API，docs/150 §4.1）：
 *   模型清单  uiwin.engine.models('catalog')        —— 文件在不在、能不能装、路径
 *   引擎实时  MATTINGENGINE.probe(force)/snapshot() —— 档位、依赖、版本
 *   独立环境  uiwin.engine.environment('status')    —— 核心环境（打包后为"已内置"）
 *
 * 合并规则（写死，别处不许自定，docs/150 §4.1）：
 *   ① 引擎没跑时：engine.state='down'，但【模型和环境照常显示】。
 *      不许把"引擎没跑"翻译成"没模型"（docs/134 §⑦ 的教训：用户白下 17G）。
 *   ② 探活失败（超时）：保留上次 engine 值 + stale:true，文案"未响应（正在重查）"。
 *      stale 值【不参与可用/安装判断】；gating 仍走 MATTINGENGINE 实时探活，
 *      本模块只把它的"清零点"从展示层隔离（不动 matting-engine.js 的判定）。
 *   ③ 模型行状态归并（modelLine() 出唯一文案）：
 *      ok→可用；present→文件在·未测试；broken→一句话原因；
 *      missing+可下载→未安装；missing+不可下载→不能装（缺少下载源，请用导入）。
 *   ④ tiers 取引擎六键原值，不再前端二次换算（engines-core.js 只做显示换算）。
 *
 * 刷新时机（docs/150 §4.1）：
 *   卡打开 / 手动"重新扫描" / 任何安装·导入·启停操作完成后；【卡关闭不轮询】。
 *
 * ⚠ 本模块【不报错】。缺环境 / 缺模型 / 引擎没起 = 状态文字，不是红报错；
 *   只有用户主动操作失败才进报错堆（CLAUDE.md 铁律 15 的落地）。
 *
 * ⚠ 已知限制（留给宿主，先登记，不自造，docs/150 §5.1）：
 *   · 引擎 pid / 启动时长 / launchId：现有 MATTINGENGINE 快照没有，恒为 null；
 *     Phase B 状态条的"已运行 X 小时"要等宿主补，不许前端编。
 *   · "进程启动时间 < 脚本 mtime → 建议重启"：前端拿不到 mtime，本模块【不猜】；
 *     只有 old-code 这一种能从前端信号判出来（/health 没有 tiers 字段 = 旧版引擎，
 *     见 matting-engine.js 里 multiCapable 的判据），mtime 那一半等宿主。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // ── 状态词典（附录 B，唯一文案；卡片只许引用，不许另写）──────────────
  var ENGINE_TEXT = Object.freeze({
    'down': '未启动',
    'starting': '正在启动…',
    'running': '运行中',
    'old-code': '运行中 · 建议重启（程序更新过）',
    'stale': '未响应（正在重查）'
  });
  var TIER_KEYS = ['matting', 'segment', 'sam2', 'sam3', 'matte', 'tween'];

  // ── 内部状态 ────────────────────────────────────────────────────────
  function emptyEngine() {
    return {
      state: 'down', version: '', device: '', vramGB: 0, uptimeText: null, pid: null, launchId: null,
      caps: { onnx: false, torch: false, cuda: false },
      tiers: { matting: 0, segment: 0, sam2: 0, sam3: 0, matte: 0, tween: 0 }
    };
  }
  function emptyEnv() { return { core: 'missing', accel: 'n/a', text: '还没有环境状态' }; }

  var current = {
    at: 0, stale: false,
    // ⚠ 兼容：engine 恒等于 engines.matting（老消费者：外挂卡状态条/环境行/模型行）。
    //   双引擎从 engines.{match,matting} 读（Phase F）。
    engine: emptyEngine(),
    engines: { match: emptyEngine(), matting: emptyEngine() },
    env: emptyEnv(),
    models: [],
    catalogAt: 0, catalogOk: null
  };
  var inflight = null;
  var revision = 0;
  var listeners = new Set();

  function copyEngine(e) {
    return {
      state: e.state,
      version: e.version,
      device: e.device,
      vramGB: e.vramGB,
      uptimeText: e.uptimeText,
      pid: e.pid,
      launchId: e.launchId,
      caps: Object.assign({}, e.caps),
      tiers: Object.assign({}, e.tiers)
    };
  }
  function copySnapshot() {
    return {
      at: current.at,
      stale: current.stale,
      engine: copyEngine(current.engine),
      engines: {
        match: copyEngine(current.engines.match),
        matting: copyEngine(current.engines.matting)
      },
      env: Object.assign({}, current.env),
      models: current.models.map(function (m) { return Object.assign({}, m); }),
      catalogAt: current.catalogAt,
      catalogOk: current.catalogOk
    };
  }

  function normalizeTiers(src) {
    var out = {}, s = src || {};
    for (var i = 0; i < TIER_KEYS.length; i++) {
      var k = TIER_KEYS[i];
      out[k] = Number(s[k]) || 0;
    }
    return out;
  }
  function normalizeCaps(src) {
    var c = src || {};
    return { onnx: c.onnx === true, torch: c.torch === true, cuda: c.cuda === true };
  }
  function isTimeout(raw) {
    return /timeout|timed out|超时/i.test(String(raw || ''));
  }
  // 引擎"起来过"的判据（同 engines-core.engineUp，但这里只看探活结果本身）
  function engineAlive(s) {
    return s.available === true || s.multiCapable === true;
  }

  // ── 源读取（全部容错：拿不到 ≠ 崩，也 ≠ "没有"）────────────────────
  // ⚠ Phase F：两台引擎各读各的。match=MATCHENGINE(37893，只有 probe/status 没有 snapshot)；
  //   matting=MATTINGENGINE(37894，有 probe/snapshot)。两个模块都是 UMD/浏览器全局。
  function snapOfModule(M) {
    if (!M) return null;
    if (typeof M.snapshot === 'function') { try { return M.snapshot() || null; } catch (_) { return null; } }
    if (typeof M.status === 'function') { try { return M.status() || null; } catch (_) { return null; } }
    return null;
  }
  async function readEngine(M, force) {
    if (!M || (typeof M.probe !== 'function' && typeof M.snapshot !== 'function' && typeof M.status !== 'function')) {
      return { snap: null, reason: '引擎模块没加载' };
    }
    try {
      if (typeof M.probe === 'function') await M.probe(force === true);
      return { snap: snapOfModule(M), reason: '' };
    } catch (e) {
      return { snap: null, reason: String(e && e.message || e) };
    }
  }

  async function readCatalog() {
    var api = root.uiwin && root.uiwin.engine && root.uiwin.engine.models;
    if (typeof api !== 'function') return { ok: false, reason: '当前版本未提供模型管理', models: null };
    try {
      var r = await api('catalog');
      if (!r || r.ok === false || !r.models || typeof r.models !== 'object') {
        return { ok: false, reason: String(r && (r.error || r.detail) || '模型清单暂时拿不到'), models: null };
      }
      return { ok: true, reason: '', models: r.models, root: String(r.root || '') };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e), models: null };
    }
  }

  async function readEnvironment() {
    var api = root.uiwin && root.uiwin.engine && root.uiwin.engine.environment;
    if (typeof api !== 'function') return { ok: false, missing: true, reason: '当前版本未提供环境管理' };
    try {
      var r = await api('status');
      return (r && typeof r === 'object') ? r : { ok: false, reason: '环境状态是空的' };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  // ── 合并：引擎块 ────────────────────────────────────────────────────
  // isMatting=true 时才有 old-code（/health 有没有 tiers 字段）和 probing 这两个概念。
  function buildEngine(snap, prev, isMatting) {
    if (!snap) {
      // 连快照都拿不到（模块没加载 / 探测抛了）—— 不装旧值，如实说没启动
      return { engine: emptyEngine(), stale: false };
    }
    if (isMatting && snap.probing && !snap.probed) {
      return {
        engine: {
          state: 'starting',
          version: String(snap.version || prev.version || ''),
          device: String(snap.device || ''), vramGB: Number(snap.vramGB) || 0,
          uptimeText: prev.uptimeText, pid: prev.pid, launchId: prev.launchId,
          caps: normalizeCaps(snap.caps),
          tiers: normalizeTiers(snap.tiers)
        },
        stale: false
      };
    }
    if (engineAlive(snap)) {
      // ⚠ old-code：/health 没有 tiers 字段 = 只会抠像的旧版引擎（matting-engine 的判据）。
      //   "进程启动时间 < 脚本 mtime" 那一半前端拿不到，见文件头"已知限制"。
      return {
        engine: {
          state: (isMatting && snap.multiCapable !== true) ? 'old-code' : 'running',
          version: String(snap.version || ''),
          device: String(snap.device || ''), vramGB: Number(snap.vramGB) || 0,
          uptimeText: null, pid: null, launchId: null,
          caps: normalizeCaps(snap.caps),
          tiers: normalizeTiers(snap.tiers)
        },
        stale: false
      };
    }
    // 没起来：先分清"超时（保留上次+标脏）"和"真没启动"
    if (prev.state !== 'down' && prev.state !== 'starting' && isTimeout(snap.lastError)) {
      return {
        engine: Object.assign({}, prev, { state: 'stale', tiers: normalizeTiers(prev.tiers), caps: normalizeCaps(prev.caps) }),
        stale: true
      };
    }
    return { engine: emptyEngine(), stale: false };
  }

  // ── 合并：环境块 ────────────────────────────────────────────────────
  function buildEnv(result, engine) {
    var r = result || {};
    var core = 'missing', text = '';
    if (r.missing) { text = '拿不到环境状态（当前版本没有环境管理）'; }
    else if (r.ready === true && r.state === 'ready') { core = 'ready'; text = '已就绪'; }
    else if (r.state === 'preparing' || r.state === 'installing' || r.state === 'removing' || r.state === 'cancelling') { text = '正在处理…'; }
    else if (r.ok === false) { text = r.error ? ('需要修复（' + String(r.error) + '）') : '需要修复'; }
    else { text = '未准备'; }
    // ── 加速档 ──────────────────────────────────────────────────────────
    // ⚠⚠ 2026-10-08 修：原来这个格子【只看引擎在不在跑】
    //   （engine.caps.torch && engine.caps.cuda，而 caps 来自【运行中】的引擎）。
    //   后果：引擎没启动时加速档一定是 '—'，用户看到的是"没有这一档"，
    //   而不是"这一档还没装" —— 一个"没启动"被读成了"不存在"。
    //   实际断链是四段：环境里没装 torch → 引擎探到 torch/cuda 都 false
    //   → 4 个要显卡的模型全标 broken → 加速档永远不就绪。
    //   ⇒ 现在以【环境自己报的加速层状态】为准（不用等引擎起来就能说清），
    //     引擎的实时 caps 只作为"两处不一致时说需要修"的旁证。
    var accelEnv = r.accel || null;
    var liveReady = !!(engine.caps && engine.caps.torch && engine.caps.cuda);
    var accel = 'n/a', accelText = '', accelState = '';
    var engineLive = (engine.state === 'running' || engine.state === 'old-code');
    if (accelEnv && accelEnv.state === 'installed') {
      accelState = 'installed';
      if (engineLive && !liveReady) {
        // 环境说装好了、可运行中的引擎说摸不到显卡 —— 不装作好了
        accel = 'missing';
        accelText = '加速包在环境里，但引擎摸不到显卡，要修一下';
      } else {
        accel = 'ready';
        // ⚠ 把两样都写出来，让用户能自己核对：
        //   · torch —— 给人体解析(Meta)/文字选区/细边/过渡帧
        //   · ONNX provider —— 给抠像/人体解析(SCHP)/分割/SAM2
        //   （只写 torch 的话，抠像还在 CPU 上跑用户也看不出来）
        var ortName = accelEnv.onnxProvider === 'DmlExecutionProvider' ? 'ONNX DirectML'
          : accelEnv.onnxProvider === 'CUDAExecutionProvider' ? 'ONNX CUDA'
          : accelEnv.onnxProvider ? ('ONNX ' + String(accelEnv.onnxProvider)) : '';
        var parts = [];
        if (accelEnv.device) parts.push(String(accelEnv.device));
        if (accelEnv.torch) parts.push('torch ' + String(accelEnv.torch));
        if (ortName) parts.push(ortName);
        accelText = '已就绪' + (parts.length ? '（' + parts.join(' · ') + '）' : '');
      }
    } else if (accelEnv && accelEnv.state === 'pending') {
      accelState = 'pending';
      accel = 'missing';
      accelText = accelEnv.available === false
        ? ('这台机器开不了（' + String(accelEnv.reason || '没有可用的 N 卡') + '）')
        : ('还没装' + (accelEnv.device ? '（检测到 ' + String(accelEnv.device) + '）' : '')
           + ' —— 装上之后细边 / 文字选区 / 过渡帧 / 人体解析就能用');
    } else if (accelEnv && accelEnv.state === 'unsupported') {
      accelState = 'unsupported';
      accel = 'n/a';
      accelText = String(accelEnv.reason || '这台机器没有可用的 N 卡');
    } else if (engineLive || (engine.state === 'stale' && (engine.caps.torch || engine.caps.cuda))) {
      // 环境那一段没报上来时的退路：拿引擎的实时探测说话（只做显示，不参与安装判断）
      accelState = liveReady ? 'installed' : 'pending';
      accel = liveReady ? 'ready' : 'missing';
      accelText = liveReady ? '已就绪' : '还没装';
    }
    return {
      core: core, accel: accel, text: text, accelText: accelText,
      accelState: accelState,
      accelAvailable: accelEnv ? accelEnv.available !== false : null,
      accelDevice: accelEnv ? String(accelEnv.device || '') : '',
      // ⚠ ONNX 后端这几样必须一起透出去：抠像/人体解析/分割/SAM2 走的是 ONNX 那条路，
      //   只看 torch 的话"抠像还在 CPU 上跑"用户根本看不出来。
      accelOnnxProvider: accelEnv ? String(accelEnv.onnxProvider || '') : '',
      accelOnnxPackage: accelEnv ? String(accelEnv.onnxPackage || '') : '',
      accelOnnxNote: accelEnv ? String(accelEnv.onnxNote || '') : '',
      vramGB: accelEnv ? (Number(accelEnv.vramGB) || 0) : 0
    };
  }

  // ── 合并：模型行（规则③）──────────────────────────────────────────
  function buildModels(catalogResult, snap, prevModels) {
    if (!catalogResult || catalogResult.ok !== true || !catalogResult.models) {
      // 拿不到清单 ≠ 没有模型 —— 保留上次那份（规则：catalog 失败看"拿不到≠没有"）
      return { models: prevModels || [], catalogOk: false, catalogAt: -1 };
    }
    var runtime = (snap && engineAlive(snap) && snap.models) ? snap.models : {};
    var items = catalogResult.models;
    var list = [];
    Object.keys(items).forEach(function (key) {
      var item = items[key] || {};
      var rt = runtime[key] || null;
      var catState = String(item.state || 'missing');
      var hasDownload = !!(item.download && item.download.available);
      var state = 'missing', reason = '';
      if (rt && rt.state === 'ok') { state = 'ok'; }
      else if (rt && rt.state === 'broken') { state = 'broken'; reason = String(rt.reason || ''); }
      else if (catState === 'present') { state = 'present'; }
      else if (catState === 'broken') {
        state = 'broken';
        reason = String((rt && rt.reason) || item.verificationNote || (item.download && item.download.reason) || '');
      } else { state = 'missing'; }
      list.push({
        key: String(item.key || key),
        name: String(item.name || key),
        tier: Number(item.tier) || 0,
        state: state,
        reason: reason,
        // ⭐ Phase B：目录里那条核对说明（"摘要已核对"之类）原样带上，
        //   模型列表要显示它；判状态仍然只用 state/reason（单一出口不打折）。
        note: String((rt && rt.verificationNote) || item.verificationNote || ''),
        path: String(item.path || item.file || (rt && rt.path) || ''),
        bytes: Number(item.bytes || (item.download && item.download.bytes) || (rt && rt.bytes) || 0),
        downloadable: hasDownload
      });
    });
    return { models: list, catalogOk: true, catalogAt: Date.now() };
  }

  // ── 唯一状态出口 API ────────────────────────────────────────────────
  async function refresh(options) {
    var opts = options || {};
    if (inflight) return inflight;
    var token = ++revision;
    inflight = (async function () {
      var tasks = [
        readEngine(root.MATTINGENGINE, opts.force === true),
        readEngine(root.MATCHENGINE, opts.force === true),
        opts.environment === false ? Promise.resolve(null) : readEnvironment(),
        opts.models === false ? Promise.resolve(null) : readCatalog()
      ];
      var got = await Promise.all(tasks);
      if (token !== revision) return copySnapshot();   // 被更新的一轮顶掉了
      var engineRes = got[0] || {};
      var matchRes = got[1] || {};
      var envRes = got[2];
      var catRes = got[3];

      var built = buildEngine(engineRes.snap, current.engines.matting, true);
      var builtMatch = buildEngine(matchRes.snap, current.engines.match, false);
      var nextEngine = built.engine;
      var nextEngines = { match: builtMatch.engine, matting: nextEngine };
      var nextEnv = (envRes === null)
        ? Object.assign({}, current.env)
        : buildEnv(envRes, nextEngine);
      var nextModels;
      if (catRes === null) {
        nextModels = { models: current.models, catalogOk: current.catalogOk, catalogAt: current.catalogAt };
      } else {
        nextModels = buildModels(catRes, engineRes.snap, current.models);
      }
      current = {
        at: Date.now(),
        stale: built.stale,
        engine: nextEngine,
        engines: nextEngines,
        env: nextEnv,
        models: nextModels.models,
        catalogAt: nextModels.catalogAt > 0 ? nextModels.catalogAt : current.catalogAt,
        catalogOk: nextModels.catalogOk
      };
      for (var fn of Array.from(listeners)) {
        try { fn(copySnapshot()); } catch (_) { /* 消费者自己的错自己担，别拖垮状态出口 */ }
      }
      try {
        root.dispatchEvent(new CustomEvent('wheelchair:engine-status', { detail: copySnapshot() }));
      } catch (_) { /* 没有 CustomEvent 的环境（node 单测）跳过 */ }
      return copySnapshot();
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  function snapshot() { return copySnapshot(); }
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  // ── 文案换算（卡片只许调这里，不许自己判）─────────────────────────
  function engineLine(engine) {
    var s = engine || current.engine;
    return ENGINE_TEXT[s.state] || ENGINE_TEXT.down;
  }
  function envLine(env) {
    var e = env || current.env;
    if (e.core === 'ready') return e.accel === 'ready' ? '已就绪 · 加速可用' : '已就绪';
    return e.text || '未准备';
  }
  // 模型行唯一文案（规则③ + 附录 B）
  function modelLine(model) {
    var m = model || {};
    if (m.state === 'ok') return { text: '可用', tone: 'ok' };
    if (m.state === 'present') return { text: '文件在 · 未测试', tone: 'idle' };
    if (m.state === 'broken') {
      return { text: '文件不完整 / 缺少配套件' + (m.reason ? '（' + m.reason + '）' : ''), tone: 'bad' };
    }
    if (m.downloadable) return { text: '未安装', tone: 'idle' };
    return { text: '不能装（缺少下载源，请用导入）', tone: 'warn' };
  }

  root.V7EngineStatus = Object.freeze({
    // 词典（附录 B，卡片引用同一份）
    ENGINE_TEXT: ENGINE_TEXT,
    TIER_KEYS: TIER_KEYS,
    // 状态
    refresh: refresh,
    snapshot: snapshot,
    subscribe: subscribe,
    // 文案
    engineLine: engineLine,
    envLine: envLine,
    modelLine: modelLine
  });
})(typeof window !== 'undefined' ? window : this);
