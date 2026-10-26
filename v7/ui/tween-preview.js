/* ═══ 任务预览：滚轮调强度 + 上方大预览框 ═══════════════════════════
 *
 * 这个文件管两件事（docs/132 §三 §四）：
 *   1. 缩略图上滚滚轮 → 调「改动强度」（0% = 原图，100% = 成品）
 *   2. 悬停任务卡 → 上方弹一个大预览框，里面能缩放/平移/双击复位
 *
 * ⚠⚠ 为什么单开一个文件而不是塞进 ui.html：
 *   ui.html 是 1.5 万行单文件单线程，两个对话同时改必冲突，而且【主脚本抛错
 *   会让整个界面死掉】（不是某个功能坏，是全死）。所以这里做全自包含，
 *   ui.html 那边只挂两行。
 *
 * ⚠ 强度两个端点的定案（docs/132 §4.2，用户 2026-10-04 拍板）：
 *     0%   = 原图（用户给的那张）
 *     100% = 对齐 + 校色后的成品
 *   为什么这样最稳：校色把色差压小、网格变形把位置差压小 → 中间帧不带色偏、
 *   光流要做的事最少 → 最不容易重影。
 *   ⚠ 旧说法「要用校色【前】的 AI 原图当端点」是【反的】，已作废。
 *   ⚠ 副作用（正常，别当 bug）：0%→100% 滚的时候颜色会跟着变，因为校色
 *     本身也算"改动"的一部分。用户认可这个观感。
 */
(function (root) {
  'use strict';

  // ⚠ 端口允许被覆盖：探针要在【测试端口】上起一份新引擎来验，不能去打用户正在用的那个。
  //   覆盖途径有两个（探针按顺序试）：URL 上的 ?tween-port=xxxx / window.V7_ENGINE_PORT。
  //   生产两条都没有 → 走 37894。
  var ENGINE_PORT = (function () {
    try {
      var q = (root.location && root.location.search) || '';
      var m = /[?&]tween-port=(\d+)/.exec(q);
      if (m) return Number(m[1]);
    } catch (_) {}
    if (root.V7_ENGINE_PORT) return Number(root.V7_ENGINE_PORT);
    return 37894;
  })();
  var ENGINE_BASE = 'http://127.0.0.1:' + ENGINE_PORT;

  // 强度档数。⚠ 实测（docs/132 §七）：1024² 插 16 帧纯推理约 60ms，
  //   算一次总耗时（含传输）约 0.3s —— 用户等这一下，之后滚轮零延迟。
  var STEPS = 16;

  // 每条预览条一份缓存：key = taskId + '/' + shotIndex
  var cache = Object.create(null);

  // ── 状态 ──
  var box = null;          // 上方大预览框的 DOM（Portal 到 body）
  var boxTaskId = null;    // 当前框里是谁的图
  // ⭐⭐⭐ 2026-10-09（状态归属审计）：boxTaskId 会被设成【两种类型】——
  //   task.id 是【数字】（ui.html 里 ++taskSeq 生成），
  //   而 showImage 那条独立看图的路会把它设成字符串 '__standalone__'。
  //   代码里有 5 处比较包了 String()、另 6 处没包 ⇒ 一旦哪天 task.id 变成字符串，
  //   那 6 处会【静默永远不相等】—— 本项目最忌讳的形态。
  //   ⇒ 收口成一个设置函数，进来就是字符串。**别绕过它直接赋值**。
  function setBoxTask(id) {
    // null / undefined 保持 null（表示“框没有归属”），其余一律存字符串
    boxTaskId = (id == null) ? null : String(id);
    // ⭐ 2026-10-09（docs/191）：记住"框【曾经】归属谁"。
    //   ⚠ 为什么需要：框一收，boxTaskId 就被清成 null；而"鼠标移开"那次收起
    //     还要靠它去通知 ui.html 收预览条。没有这份记忆，条就永远赖着
    //     （用户实测："缩略图卡片有时候收不回去了"）。
    //   ⚠ 只在设成非 null 时更新 —— 清空那一下不能把记忆也抹掉。
    if (boxTaskId != null) boxTaskIdWas = boxTaskId;
  }
  var boxShotIndex = -1;
  var boxFrames = null;    // 已算好的帧（string[] dataURL / ImageBitmap）
  var boxTaskIdWas = null; // 上一次框归属谁（收框后仍保留，供收预览条用）
  var zoom = 1, panX = 0, panY = 0;
  var dragging = null;
  var hideTimer = 0;
  var yieldState = null;   // 一级卡让位前的状态（离开时恢复）

  // ══════════════════════════════════════════════════════════
  //  工具
  // ══════════════════════════════════════════════════════════
  function ui() { return root.uiwin || {}; }

  // 引擎报的 tween 档位。0 = 没装/没起来。
  //
  // ⚠⚠ 2026-10-04 探针抓到的静默失效（记进 docs/133）：
  //   这里原来读 `MATTINGENGINE.state()` —— 但那个模块【根本没有 state 这个方法】，
  //   它导出的叫 `snapshot()`（ui-pure/matting-engine.js:301）。
  //   于是这个函数永远返回 0 → 滚轮第一步就被判"引擎没装"挡掉，
  //   表现是"滚了完全没反应，一句错都不报"。典型静默失效（铁律 17）。
  //   ⚠ 教训：读别的模块的接口前，先 grep 它到底导出了什么，别按印象写。
  function engineSnapshot() {
    var M = root.MATTINGENGINE;
    if (!M) return null;
    if (typeof M.snapshot === 'function') return M.snapshot();
    // 兼容：万一以后有人把 state 也导出了
    if (typeof M.state === 'function') return M.state();
    return null;
  }

  function engineAvailable() {
    var st = engineSnapshot();
    if (!st) return 0;
    var tiers = st.tiers || {};
    return Number(tiers.tween) || 0;
  }
  // ⚠ 2026-10-19：原来这里有个全局 strengthEngineStarting（一张在算时别的图滚轮全被吞掉），已改成按每一张判（见 strengthWheel）。

  // ⭐⭐ 2026-10-16（用户：「引擎掉线之后，也就是长时间休眠之后重新拉起的时候，第一次拉起会直接报失败。
  //   应该报这个引擎正在重新启动，然后等待就好了」）
  //   真因：engineAvailable() 只看【记下来的快照】。引擎空闲 10 分钟会自己退出（multi_engine_server 的看门狗）、
  //   电脑睡过觉，快照里还写着"在" ⇒ 旧写法不拉引擎、直接去算 ⇒ Failed to fetch ⇒ 红卡「这张图的强度调不出来」。
  //   现在：算之前【现问一次】；不在就提示「引擎正在重新启动」、拉起来、等好了自动接着算；
  //   算到一半连不上（刚好那一刻退出）再拉一次、自动重算一次。真的拉不起来才报错。
  function isNetworkFailure(err) {
    var m = String((err && (err.message || err)) || '');
    return /Failed to fetch|NetworkError|ECONNREFUSED|ERR_CONNECTION|Load failed|fetch failed/i.test(m);
  }
  // ⭐ 2026-10-21（docs/261 B9，线上一个用户 76 次）：开着云端外挂时调强度也是云端在算 ——
  //   云端抖一下快照各档就是 0，以前报「本地引擎没准备好」误导人，而且每滚一下滚轮重试一次、报一次。
  //   现在：云端模式说云端的话（另一个错误码）；失败后 5 秒内再滚不重试、不再报。
  function cloudRouting() {
    try { return !!(root.V7CloudTools && typeof root.V7CloudTools.routing === 'function' && root.V7CloudTools.routing()); } catch (_) { return false; }
  }
  var ENGINE_RETRY_COOLDOWN_MS = 5000, engineMissingAt = 0;
  function engineMissingError() {
    if (cloudRouting()) return Object.assign(new Error('云端外挂暂时连不上（网络抖了一下，或者算力机正忙），稍等几秒再滚一下。'), { code: 'TWEEN_CLOUD_UNREACHABLE' });
    return Object.assign(new Error('自动启动引擎没成功，或者这一档要的东西没装上（引擎快照里档位还是 0）。'), { code: 'TWEEN_ENGINE_MISSING' });
  }
  function isEngineMissing(err) { return !!err && (err.code === 'TWEEN_ENGINE_MISSING' || err.code === 'TWEEN_CLOUD_UNREACHABLE'); }
  var engineWaking = null;
  function wakeEngine() {
    if (engineWaking) return engineWaking;
    var M = root.MATTINGENGINE;
    engineWaking = Promise.resolve(M && typeof M.probe === 'function' ? M.probe(true) : null).catch(function () { }).then(function () {
      if (engineAvailable()) return true;
      if (typeof root.V7EngineEnsure !== 'function') return false;
      report(cloudRouting() ? '云端外挂正在重连，好了自动接着算' : '引擎正在重新启动（空闲久了会自己关掉，第一次要等十几秒），好了自动接着算', 'warn');
      return Promise.resolve(root.V7EngineEnsure('改动强度')).catch(function () { }).then(function () { return !!engineAvailable(); });
    }).then(function (ok) { engineWaking = null; return ok; }, function (err) { engineWaking = null; throw err; });
    return engineWaking;
  }
  function missing() { engineMissingAt = Date.now(); return engineMissingError(); }
  // 要算帧的地方一律走这里（滚轮第一次 / 点开大图），别直接调 compute
  function computeReady(task, shot, onProgress) {
    var hit = cache[cacheKey(task, shot)];
    if (hit && (hit.ready || hit.pending)) return compute(task, shot, onProgress);
    // 刚失败过：冷却期内不重试、不再报（cooldown 标记 ⇒ reportComputeFailure 不出卡）
    if (Date.now() - engineMissingAt < ENGINE_RETRY_COOLDOWN_MS) return Promise.reject(Object.assign(engineMissingError(), { cooldown: true }));
    return wakeEngine().then(function (ok) {
      if (!ok) throw missing();
      return compute(task, shot, onProgress).catch(function (err) {
        if (!isNetworkFailure(err)) throw err;
        return wakeEngine().then(function (again) {
          if (!again) throw missing();
          return compute(task, shot, onProgress);
        });
      });
    });
  }
  function reportComputeFailure(err, task, shot, withMemory) {
    if (isEngineMissing(err)) {
      if (!err.cooldown) reportError(err.code, err.message, { severity: 'L2', stage: 'tween' });
      return;
    }
    var context = {
      '引擎地址': ENGINE_BASE,
      '原图 id': String((task && task.sourceImgId) || '(无)'),
      '成品 id': String((shot && shot.imgId) || '(无)')
    };
    if (withMemory) {
      context['原图在内存里'] = String(!!(root.IMG && root.IMG.has(task && task.sourceImgId)));
      context['成品在内存里'] = String(!!(root.IMG && root.IMG.has(shot && shot.imgId)));
    }
    // ⚠ 常驻报错（用户要求）：一闪就没的提示等于没提示。
    reportError('TWEEN_COMPUTE_FAILED', String((err && err.message) || err || '未知原因'), { severity: 'L2', stage: 'tween', context: context });
  }

  // 引擎快照里 tween 那一档（给探针和诊断用）
  function engineTiers() {
    var st = engineSnapshot();
    return st ? (st.tiers || {}) : null;
  }

  // ⚠⚠ 2026-10-04 看着截图改的（这条规矩的价值就在这）：降级提示【不能走 ERR.report】。
  //   ERR.report 会在左下角弹一张红色报错卡、还会进报错堆 —— 但我们这里是
  //   "图照样能看，只是调强度这个附加功能用不了"，不是故障。
  //   第一版就是走了 VIEWER_OPEN_FAILED，截图里弹出一张「大图打不开」的报错卡，
  //   措辞和行为都不对。改成只走轻提示（toast）。
  function report(msg, kind) {
    if (root.UI && root.UI.toast) {
      try { root.UI.toast(String(msg), kind || 'warn', 2600); return; } catch (_) {}
    }
  }

  // 真正的故障走这个（进报错堆 + 分级 + 常驻，用户能慢慢看）
  //
  // ⚠⚠ 2026-10-04 用户明确要求：调强度失败【不能一闪就没】。
  //   原来走 UI.toast（2.6 秒自动消失），用户根本来不及看清原因。
  //   改成走 ERR.report 的 L2 —— 它会在左下角留一张常驻报错卡，右滑能看详情。
  function reportError(code, msg, extra) {
    if (root.ERR && root.ERR.report) {
      try {
        root.ERR.report(code, Object.assign({ message: String(msg) }, extra || {}));
        return;
      } catch (_) {}
    }
    // 兜底：报错系统没起来时至少别静默
    if (root.UI && root.UI.toast) {
      try { root.UI.toast(String(msg), 'err', 8000); return; } catch (_) {}
    }
  }

  // 把 ArrayBuffer/Uint8Array 变成 blob URL。⚠ 用完必须 revoke，不然内存一直涨。
  // ⭐ 2026-10-18：云端外挂的预览帧是 JPEG（见 computeFromEngine），类型跟着引擎说的走
  function toUrl(bytes, mime) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([u8], { type: mime || 'image/png' }));
  }

  function revokeAll(frames) {
    if (!frames) return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i] && frames[i].url) { try { URL.revokeObjectURL(frames[i].url); } catch (_) {} }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  强度：向引擎要一串过渡帧
  // ══════════════════════════════════════════════════════════
  // ⚠ 端点（docs/132 §4.2）：A = 原图（task.sourceImgId），B = 成品（shot.imgId）
  function endpointsOf(task, shot) {
    var a = task && task.sourceImgId;
    var b = shot && shot.imgId;
    if (!a || !b) return null;
    if (!root.IMG || !root.IMG.has(a) || !root.IMG.has(b)) return null;
    return { a: a, b: b };
  }

  // ⚠⚠ 2026-10-04 用户实测报的 bug 的根因：这里原来用 shot.index 做键，
  //   但【真实的 shot 对象里根本没有 index 字段】——
  //   那个 index 只在 ui.html 的 buildPreview 里用 Object.assign 临时造出来，
  //   没有写回 task.shots。于是所有图的键都是 "任务id/undefined"，
  //   **一张任务卡上所有图共用同一条缓存** → 表现就是"预览的图都是同一张、
  //   上下对不上"（用户 2026-10-04 傍晚报的）。
  //   改法：按【两个端点的身份】做键 —— 原图 id + 成品 id。
  //   这才是"这组过渡帧属于谁"的唯一正确标识（同一张图 = 同一组帧，本来就该共用）。
  function cacheKey(task, shot) {
    var a = (task && task.sourceImgId) || '';
    var b = (shot && shot.imgId) || '';
    if (a || b) return String(a) + '|' + String(b);
    // 兜底：两个都没有时退回按位置（至少不会全撞在一起）
    var pos = task && task.shots ? task.shots.indexOf(shot) : -1;
    return String(task && task.id) + '#' + String(pos);
  }

  // ⚠⚠ 2026-10-05（docs/143 §六）：cacheKey 上面那个键已经能当"这组帧的身份证号"，
  //   但它【太长而且带 | 这种字符】，不能直接进文件名。这里把它压成一个短、只含
  //   [a-z0-9_] 的版本标识，专供文件名用：
  //     0% 端点的 imgId + 100% 端点的 imgId → 各自去掉非字母数字，再拼。
  //   ⚠ 为什么压缩而不是只取成品 id：切版本时【只有 b（shot.imgId）会变】，
  //     所以只按 b 也能区分；但万一将来 0% 端点（原图）也能换，只按 b 就漏了。
  //     两个都进名字，成本一样，将来少一个坑。
  //   ⚠ 长度封顶 24 字符：imgId 是 'img_123' 这种短串，正常不会超；真超了也只是
  //     名字短一点、靠 .json 里的完整 key 兜底（校验以 json 为准，不以文件名为准）。
  function versionTag(task, shot) {
    var raw = cacheKey(task, shot).toLowerCase().replace(/[^a-z0-9]/g, '_');
    return raw.slice(0, 24) || 'x';
  }

  // ══════════════════════════════════════════════════════════
  //  ⭐⭐ 中间帧落盘（2026-10-05 用户："我希望我们调整强度的引擎，生成的中间的层级的图像，
  //     能够在缓存里面有一席之地，而不是现在每次重启之后，都需要重新计算一遍。"）
  //
  //  ⚠⚠ 键用【任务自己的缓存位置】（task.cacheProject + task.cacheRunId），
  //     绝不能用 imgId —— imgId 是 image-store 里进程内自增的（'img_7' 这种），
  //     重启就全变了，拿它当磁盘键等于每次重启都读不中（等于没做）。
  //
  //  ⚠ 文件名必须【不跟同一目录里的别的文件撞】：那个目录里已经有
  //     output_N.png / raw_N.png / input.png / thumb_N.jpg / prompt.txt / meta.json。
  //
  //  ⚠⚠ 2026-10-05（docs/143 §六-3）：名字里【还要带版本标识】。
  //     起因：切版本（校色版 ↔ 底版）之后 shot.imgId 变了，但【磁盘位置（第几张）没变】——
  //     名字里不带版本的话，新版本算出来的帧会覆盖旧版本的帧，或者反过来读到旧的。
  //     表现同样是静默的：图看着有、就是错的那一版。
  //     ⇒ 名字从 tween_N_序.png 改成 tween_v<版本>_N_序.png（.json 同理），两版各占一套。
  //     ⚠ 代价：切来切去会各留一套 ≈30MB。这钱花得值 —— 缓存清理是按 run 目录整体走的，
  //       不会漏；而"读到错版本"是用户肉眼看不出来的错。
  //
  //  ⚠ 体积说在明处：16 帧 × 约 2MB ≈ 30MB/张图。它跟着缓存清理走（在同一个 run 目录里）。
  //     写失败【不算错】—— 这只是"省下次重算"，写不进去不该影响用户看图和调强度。
  // ⛔⛔⛔ 2026-10-08（docs/170 §十四）：下面这几个磁盘函数【已弃用，没有任何调用方了】。
  //   保留在这里是为了让下一个读代码的人一眼看到"它曾经存在、为什么不再用"，
  //   而不是翻半天以为哪里漏了。**不要重新把它们接回去** ——
  //   用户原话：「只记录最近12张图的插帧缓存」，不存硬盘。
  //   （实测那套攒了 22.80 GB / 3348 个文件。）
  //   ⚠ 真正的清理：启动时会一次性删掉历史遗留的 tween_*.png / tween_*.json。
  function diskRoute(task, shot) {
    var c = root.uiwin && root.uiwin.cache;
    if (!c || typeof c.writeFile !== 'function' || typeof c.readFile !== 'function') return null;
    var project = task && task.cacheProject;
    var runId = task && task.cacheRunId;
    var idx = shotIndexOf(task, shot);
    if (!project || !runId || idx < 0) return null;
    // ⚠ v 放前缀：同一目录里扫一眼就知道这批帧属于哪一版。
    return { cache: c, project: project, runId: runId, idx: idx,
             v: versionTag(task, shot),
             base: 'tween_v' + versionTag(task, shot) + '_' + (idx + 1) };
  }

  function readFramesFromDisk(task, shot) {
    var r = diskRoute(task, shot);
    if (!r) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return r.cache.readFile(r.project, r.runId, r.base + '.json'); })
      .then(function (metaBytes) {
        if (!metaBytes || !metaBytes.length) return null;
        var meta = null;
        try {
          var u8 = metaBytes instanceof Uint8Array ? metaBytes : new Uint8Array(metaBytes);
          meta = JSON.parse(new TextDecoder().decode(u8));
        } catch (_) { return null; }
        if (!meta || !meta.count) return null;
        // ⚠ steps 变了要作废：帧数不一样，按旧帧算出来的强度会跳到别的档上。
        if (meta.steps != null && Number(meta.steps) !== Number(STEPS)) return null;
        // ⚠⚠⚠ 2026-10-05（docs/143 §六-1）【本次补上的阀门】：
        //   文件名带版本号只是"名字碰不上"，不等于"这组帧确实属于当前这一对端点"。
        //   这里做真正的身份证校验：写盘时 json 里记的 key，必须 === 现在这对端点的 cacheKey。
        //   ⚠ 缺这一步的后果就是 docs/143 §六-2 写的那个静默错误：切到未校色版之后滚强度，
        //     读回来的还是旧校色版插出来的帧 —— 不报错、看着正常、数据是错的。
        //   ⚠ 这一版之前写的老文件（tween_N.json，名字里没版本号）根本读不到了（base 已经变了），
        //     所以不需要为它们做兼容：自然忽略、重算一次，最多浪费一点时间。
        if (meta.key !== cacheKey(task, shot)) return null;
        var jobs = [];
        for (var i = 0; i < meta.count; i++) {
          jobs.push(r.cache.readFile(r.project, r.runId, r.base + '_' + i + '.png'));
        }
        return Promise.all(jobs).then(function (list) {
          var frames = [];
          for (var k = 0; k < list.length; k++) {
            var b = list[k];
            if (!b || !b.length) return null;      // 缺一帧就当整组没存（宁可重算，不给半套）
            var bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
            frames.push({ bytes: bytes, url: toUrl(bytes), w: meta.w, h: meta.h });
          }
          return { frames: frames, meta: meta };
        });
      })
      .catch(function () { return null; });        // ⚠ 读失败一律当"没有"，不往上抛
  }

  function writeFramesToDisk(task, shot, rec) {
    var r = diskRoute(task, shot);
    if (!r || !rec || !rec.frames || !rec.frames.length) return;
    var enc = new TextEncoder();
    var meta = {
      version: 1, steps: STEPS, count: rec.frames.length,
      w: (rec.meta && rec.meta.width) || 0, h: (rec.meta && rec.meta.height) || 0,
      key: cacheKey(task, shot)
    };
    // ⚠⚠ 缓存接口写失败【不抛异常】，只返回 {ok:false, error}（Tauri 和 Electron 都是）。
    //   只靠 .catch 兜底的话，某一帧写失败照样会继续往下写 → 磁盘上留下半套。
    //   ⇒ 每一步都要验 ok，跟 ui.html 的 cacheSaveTask 里那个 writeChecked 同一个口径。
    var checked = function (p) {
      return Promise.resolve(p).then(function (res) {
        if (!res || res.ok !== true) throw new Error((res && res.error) || '写入失败');
        return res;
      });
    };
    // ⚠⚠ 顺序很重要：【先写完所有帧，最后才写 tween_v…_N.json】。
    //   json 是"这一组完整可用"的标记 —— 读的时候先看它在不在。
    //   要是先写 json、写到一半断电/写满，下次就会读到一个"标记说有 16 帧、实际只有 7 帧"的半套。
    //   反过来写：帧写到一半失败 → json 根本没写 → 下次就当没存、重算一遍，最多浪费磁盘不会出错。
    //   ⚠ 这里 meta.key 就是上面读盘那道阀门要核对的身份证 —— 两处必须同源（都用 cacheKey）。
    // ⚠ 串行写：并行写 16 个文件在 Rust 那边是同一个锁，并发只会互相排队 + 抢令牌。
    var chain = Promise.resolve();
    for (var i = 0; i < rec.frames.length; i++) {
      (function (fi) {
        chain = chain.then(function () {
          return checked(r.cache.writeFile(r.project, r.runId, r.base + '_' + fi + '.png', rec.frames[fi].bytes));
        });
      })(i);
    }
    chain
      .then(function () { return checked(r.cache.writeFile(r.project, r.runId, r.base + '.json', enc.encode(JSON.stringify(meta)))); })
      .catch(function () { /* 写不进去就算了 —— 没写 json 等于没存，下次重算，不会读到半套 */ });
  }

  // ⚠⚠ 2026-10-05（docs/143 §六-3 第 2 条）：切版本时【主动把该批的帧清掉】。
  //
  //   为什么光靠"名字带版本 + key 校验"还不够：
  //     · key 校验只能保证【读回来的那组是对的】，管不了磁盘上堆着的旧版本；
  //     · 用户反复切版本时，旧那套会一直留着 —— 一是占地方（每套 ≈30MB/张图），
  //       二是下次切回去时读到的可能是半年前算的、跟当前设置不一样的帧。
  //   ⇒ 切版本就清，简单粗暴，不留判断分支。
  //
  //   ⚠⚠ 怎么做才安全：缓存接口【没有 deleteFile】，只有 deleteRun（整条删）和
  //     deleteOutput（删成品图，还得动 meta.json 的 deletedOutputs 记录）。这里都不能用。
  //     ⇒ 用【覆盖成空文件】把它作废：json 是"这组可用"的标记，清空它 = 下次读不到 →
  //       自动重算。帧文件本身留着（无害，等缓存清理按 run 目录一起走）。
  //       这跟 cache-lifecycle 里 tombstone 的思路一致（读的时候才判断，不真删）。
  //   ⚠ 用 Uint8Array(0) 而不是 null/undefined：writeFile 走 atomic()，写空字节是合法的。
  //   ⚠ 只覆盖 json、不覆盖帧：一份 json 顶掉整套的判断权，写 1 个文件比写 16 个快 16 倍。
  //
  //   ⚠ 内存那份也一起清（cache / strengthState 两个表都按 key 查）—— 不清的话，
  //     切版本后界面会继续用内存里的旧帧，磁盘清得再干净也没用。
  function purgeFrames(task, shot) {
    var key = cacheKey(task, shot);
    var tid = String((task && task.id) || '');
    var pos = shotIndexOf(task, shot);
    // ① 内存：这一张的【所有版本】的帧都收掉 —— 按"任务 + 第几张"找，不按键找。
    //   ⚠⚠ 2026-10-09（docs/175）：旧代码只 delete cache[当前键]，而 ui.html 的顺序是
    //     「先 s.imgId=want（换成新版本），之后才调 purgeTaskFrames」——
    //     等 purge 跑起来，cacheKey 里的 shot.imgId 已经是【新】的了，
    //     旧键那组帧就留在内存里没人管（复核实测：换过 imgId 再 purge，旧键仍在）。
    //     ⇒ 按【任务 + 位置】找回，这才是"这一张"的身份。
    var keys = Object.keys(cache);
    for (var i = 0; i < keys.length; i++) {
      var rec = cache[keys[i]];
      if (!rec) continue;
      var sameSlot = (rec.ownerTask === tid && rec.ownerPos === pos);
      if (sameSlot || keys[i] === key) {
        releaseSet(keys[i]);                 // ⚠ 真释放（撤销 blob）—— 旧代码只 delete，内存不还
        delete strengthState[keys[i]];       // 端点换了，旧的强度百分比不再对应同一张图
      }
    }
    // ② ⭐⭐ 2026-10-08（docs/170 §十四）：不再有磁盘那一半了。
    //   ⚠ 原来这里要把标记 json 覆盖成空 —— 那正是在硬盘上留东西。
    //     用户拍板"不存硬盘"之后，清内存就是全部。
    //   ⚠ 保留这个 return 形状（{ok, disk}）：调用方在读 disk 字段，
    //     改形状会静默变成 undefined（铁律 17 那类）。disk 恒为 false 就是事实。
    //   ⚠⚠ 2026-10-09：这里【不许】再 touchLRU —— 旧代码在这给一条刚删掉的键
    //     盖了"最新用过"的时间戳，等于往 LRU 表里塞空条目白占名额。
    return Promise.resolve({ ok: true, disk: false });
  }

  // 整批（一个任务的所有图）切版本时用 —— 用户点那个「小眼睛」切的是任务级开关，
  // 不是单张。逐张清，一张都不漏。
  function purgeTaskFrames(task) {
    var shots = (task && task.shots) || [];
    var jobs = [];
    for (var i = 0; i < shots.length; i++) {
      if (shots[i] && shots[i].done && shots[i].imgId) jobs.push(purgeFrames(task, shots[i]));
    }
    return Promise.all(jobs);
  }

  // 算一次（或复用缓存）。返回 Promise<{frames:[{url,bytes}], ...}>
  function compute(task, shot, onProgress) {
    var key = cacheKey(task, shot);
    var hit = cache[key];
    // ⭐⭐ 2026-10-09（docs/175）：命中缓存 = 这一组被用到了一次。
    //   ⚠ 旧代码在这里直接 return，于是"被用"只在【算完那一刻】记过一次 ——
    //     之后你反复看它、滚它，时间戳一直停在当初，它就会被当成最旧的淘汰掉。
    //     docs/170 §14.3-2 要求的是"被显示或滚动一次就挪到最新"。
    if (hit && hit.ready) { touchLRU(task, shot); return Promise.resolve(hit); }
    if (hit && hit.pending) { touchLRU(task, shot); return hit.pending; }

    var ep = endpointsOf(task, shot);
    if (!ep) return Promise.reject(new Error('这张图没有可用的原图/成品对照'));

    // ⭐⭐ 2026-10-09（docs/175）：每条记录都记下【它属于哪个任务的第几张】。
    //   ⚠ 为什么必须记：cacheKey 里带的是 shot.imgId，而切版本时 imgId 会变。
    //     purge 跑的时候只能靠"任务 + 位置"把这一张的旧版本帧找回来（见 purgeFrames）。
    var rec = {
      ready: false, pending: null, frames: null, strength: -1, meta: null,
      ownerTask: String((task && task.id) || ''), ownerPos: shotIndexOf(task, shot)
    };
    cache[key] = rec;

    // ⭐⭐ 2026-10-08（docs/170 §十四）：帧【只放内存】，直接找引擎算。
    //   ⚠ 原来这里是"先问磁盘、没有再问引擎"（10-05 加的"省下次重算"）。
    //     用户 10-08 拍板不存硬盘 —— 实测那套攒了 22.80 GB。
    //     ⇒ 重启后确实要重算一次。这是用户明确接受的代价（他原话是"只记录最近12张图的缓存"）。
    //   ⚠ 缓存命中仍然有效：cache[key] 那层还在，同一个任务里滚来滚去不重算。
    rec.pending = computeFromEngine(task, shot, rec, ep, onProgress).then(function (r) {
      // ⭐⭐ 2026-10-09（docs/175）：算完先看【这条记录还是不是当初那条】。
      //   ⚠ 为什么必须看：算一次要几秒（CPU 上十几秒），这中间用户完全可能
      //     切版本（purge）、或者这组被上限淘汰掉 —— 那时 cache[key] 已经不是 rec 了。
      //     旧代码不管这些，照样 touchLRU + 把新算出来的帧挂上去：
      //       · 白建一批 blob，谁也管不到（没人 revoke，一直占内存）
      //       · 还会往 LRU 表里塞一条指向【不存在的记录】的空条目
      //     ⇒ 发现"已经不是它了"就地撤销、直接返回，不挂、不 touch。
      if (cache[key] !== rec) {
        revokeAll(r && r.frames);
        return r;
      }
      touchLRU(task, shot);
      return r;
    }).catch(function (err) {
      // ⚠ 走 releaseSet 而不是裸 delete：万一失败前已经建过 blob，也要撤销掉
      if (!rec.ready) { releaseSet(key); delete strengthState[key]; }
      throw err;
    });

    return rec.pending;
  }

  // 真去引擎算一遍（磁盘里没有这一组时才走这条路）。
  // ⚠ 拆出来是为了让上面那段"先磁盘后引擎"读得懂 —— 逻辑一个字没改。
  function computeFromEngine(task, shot, rec, ep, onProgress) {
    return Promise.resolve()
      .then(function () { return root.IMG.fullBytes(ep.a); })
      .then(function (bufA) {
        return root.IMG.fullBytes(ep.b).then(function (bufB) {
          return [new Uint8Array(bufA), new Uint8Array(bufB)];
        });
      })
      .then(function (pair) {
        // ⚠ 两张图首尾相接放 body，用 X-Head-Len 标出前一张的长度。
        //   这是引擎那边的约定（对齐 /matting 的"图片走 body、参数走 query"）。
        var A = pair[0], B = pair[1];
        var body = new Uint8Array(A.length + B.length);
        body.set(A, 0); body.set(B, A.length);

        // ⚠⚠ 2026-10-03 晚【第二颗雷】：这里原来带 raw=1。
        //   后果：引擎回的 raw 是【裸 RGB 像素】（base64），不是 PNG。
        //   实测证据（亲手打了一次引擎）：
        //     "raw":"Hjx4Hjx4…" → 解出来 0x1E 0x3C 0x78 = 30/60/120，正是夹具那格颜色。
        //   而本文件下面把这段字节【当 PNG】包成 blob 塞给 img.src
        //   （见 toUrl：new Blob([u8], {type:'image/png'})）——浏览器解不了，
        //   帧一张都画不出来。表现是"框弹出来了，里面是空的/一直是转圈"。
        //   ⚠ 这条跟 CORS 那条是【两个独立的病】：CORS 让 fetch 直接失败（Failed to fetch），
        //     这条让 fetch 成功之后图还是出不来。修了一个不修另一个，用户照样看不到图。
        //
        //   改法：不带 raw=1 → 引擎走 want_png 分支，每行回 PNG 的 b64，下面照旧 atob+blob 就对。
        //   ⚠ 为什么不改成"客户端拿 canvas 把裸像素还原成图"（引擎当初就是为这个留的 raw）：
        //     裸像素 base64 是 3字节/像素 → 1024² 一帧 4MB；PNG 约 2MB。**PNG 更小**。
        //     loopback 传输不要钱，省的那点编码时间是一次性的（每张图算一次、进缓存），
        //     换来的是两边都不用写 RGBA 扩张 + canvas + 异步 convertToBlob 那一套。
        //   ⚠ 代价说在明处：引擎多花约 0.4 秒编 PNG（4K 更大）。用户已表态"宁可慢"。
        // ⭐ 2026-10-18 云端外挂（docs/237，用户选「滚轮预览传压缩图、点应用再要一张无损的」）：
        //   走云端时要 fmt=jpg —— 1K 一组从 102 MB 降到 8 MB（实测，scripts/test-engine-access-lock.cjs）。
        //   预览只给眼睛看；「应用」/ 传回 PS 时由 losslessFrameBytes 单独要那一帧的 PNG（逐字节等于老格式那一帧）。
        //   本机引擎照旧 PNG（本机传输不要钱，也省得再要一次）。
        var cloudPreview = !!(root.V7CloudTools && typeof root.V7CloudTools.routing === 'function' && root.V7CloudTools.routing());
        // ⭐ 2026-10-19（docs/249）：bin=1 要二进制回包（不转 base64，传回小约 25%，这边也省掉逐字节解码）；
        //   老引擎不认 bin 会照旧回 NDJSON —— 下面两种都认。
        var url = ENGINE_BASE + '/tween?steps=' + STEPS + (cloudPreview ? '&fmt=jpg' : '') + '&bin=1';
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Head-Len': String(A.length) },
          body: body,
          // ⭐ 2026-10-19：用户滚轮要看的 —— 优先级 0；云端任务队列按它排序、给大框和缩略图画状态
          __v7Job: { kind: 'tween', priority: 0, taskId: String((task && (task.taskId || task.id)) || ''), shot: shotIndexOf(task, shot) }
        }).then(function (r) {
          if (!r.ok) {
            return r.text().then(function (t) {
              var msg = t;
              try { msg = JSON.parse(t).error || t; } catch (_) {}
              throw new Error(msg || ('引擎返回 ' + r.status));
            });
          }
          return parseFrames(r).then(function (parsed) {
            var head = parsed.head;
            if (!head.ok) throw new Error(head.error || '引擎没能算好这一档');
            var frames = parsed.items.map(function (it) {
              return { bytes: it.bytes, url: toUrl(it.bytes, head.mime), w: head.width, h: head.height };
            });
            rec.frames = frames;
            rec.meta = head;
            // ⭐ 2026-10-18：有损预览（云端 JPEG）要记下来 —— 「应用」/ 传回时不能直接拿这些字节进 PS
            rec.lossy = head.lossy === true;
            rec.ready = true;
            rec.pending = null;
            // ⭐⭐ 2026-10-08（docs/170 §十四）：算完【不落盘】。
            //   ⚠ 原来是 writeFramesToDisk(task, shot, rec)（10-05 那条"省下次重算"）。
            //     用户 10-08 拍板不存硬盘 —— 那套实测攒了 22.80 GB。
            //   ⚠ 这一行删掉之后，"帧还在不在"就完全由上面的 cache[key] + LRU 决定。
            touchLRU(task, shot);
            if (onProgress) onProgress(rec);
            return rec;
          });
        });
      });
  }

  // ⭐ 2026-10-19（docs/249）：读引擎回的帧 —— 新的二进制（bin=1）和老的 NDJSON 都认。
  //   二进制：[4 字节大端 头长度][头 JSON]，然后每帧 [4 字节大端 帧号][4 字节大端 长度][字节]。
  //   ⚠ 用 Content-Type 分：二进制是 application/octet-stream；老引擎不认 bin，回 application/x-ndjson。
  //   返回 { head, items: [{ i, bytes }] }（按帧号从小到大）。
  function parseFrames(r) {
    var ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
    if (/octet-stream/i.test(ct)) {
      return r.arrayBuffer().then(function (buf) {
        var dv = new DataView(buf);
        var n = dv.getUint32(0, false);
        var head = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, 4, n)));
        var off = 4 + n, items = [];
        while (off + 8 <= buf.byteLength) {
          var i = dv.getUint32(off, false), len = dv.getUint32(off + 4, false);
          off += 8;
          if (off + len > buf.byteLength) throw new Error('引擎回的数据不完整（第 ' + i + ' 帧缺了一截）');
          items.push({ i: i, bytes: new Uint8Array(buf.slice(off, off + len)) });
          off += len;
        }
        return { head: head, items: items };
      });
    }
    return r.text().then(function (text) {
      var lines = text.split('\n').filter(function (x) { return x.trim(); });
      var head = JSON.parse(lines[0]);
      var items = [];
      for (var i = 1; i < lines.length; i++) {
        var item = JSON.parse(lines[i]);
        // ⚠⚠ 引擎两个字段名：want_png=True 回 "b64"（PNG），raw=1 回 "raw"（裸像素）。
        //   以前这里【只读 raw】—— 后果是每帧 0 长度、图是空的（静默失效），两个字段都读。
        var raw = atob(item.b64 || item.raw || '');
        var u8 = new Uint8Array(raw.length);
        for (var k = 0; k < raw.length; k++) u8[k] = raw.charCodeAt(k);
        items.push({ i: item.i, bytes: u8 });
      }
      return { head: head, items: items };
    });
  }

  // ══════════════════════════════════════════════════════════
  //  ⭐⭐⭐ 2026-10-08（docs/170 §十四 · 用户拍板）：帧缓存【只放内存】，最多留最近 12 组。
  //
  //  用户原话：「只记录最近12张图的插帧缓存」。
  //
  //  ⚠⚠ 为什么必须封顶：帧非常大。
  //     实测 1463×1463 一张 = 4.61 MB，一组 18 帧 ≈ 83 MB
  //     ⇒ 12 组 ≈ 1 GB。不封顶的话开一天就把内存吃光（docs/139 待办第 16 行就是记这个）。
  //
  //  ⭐⭐ 2026-10-09（docs/175 · 用户拍板 + 独立复核）：**全局 12**，不是"每任务 12"。
  //     原来按任务算（taskId -> {key: stamp}），后果是上限 = 12 × 开着的任务数：
  //       开 4 张卡就是 48 组 ≈ 4 GB，文档里"12 组 ≈ 1 GB"这句话根本不成立。
  //     复核时实测过：窗口里同时开着 4 个任务 ⇒ 上限实际是 48 组。
  //     用户拍板改成全局 —— 内存这才真的有顶。
  //     ⚠ 代价（用户接受）：一批 18 张的图，滚过第 13 张时最早的几张会被释放、
  //       回头再滚要重算一次。这是"有上限"必然的代价。
  //
  //  ⭐⭐ 2026-10-09：淘汰时【必须真释放】—— 旧代码只 delete 了缓存引用，
  //     没撤销 blob 地址，而帧图是 URL.createObjectURL 出来的：
  //     **不 revoke 就一直占着内存**，删引用一样。复核实测：逼它淘汰 8 组，
  //     revokeObjectURL 被调用 0 次 ⇒ 上限形同虚设，内存照涨。
  //     （旧代码只在「删任务」那条路上 revoke 过。）
  //
  //  ⚠ 淘汰时【只删内存引用】，不碰图管家（IMG）里的原始图 ——
  //     那些图还要给预览、传回、切版本用，删了就是数据丢失。
  var MAX_SETS = 12;
  var lruStamp = 0;                          // 单调递增的"最后用过"时间戳
  var lruOrder = Object.create(null);        // key -> stamp（全局一张表，不分任务）
  var lruOwner = Object.create(null);        // key -> taskId（删任务时要按任务找回它的帧）
  var lruPinned = Object.create(null);       // key -> 引用计数（正在传回 PS 的不许淘汰）

  /** 正在大框里显示的那一组 —— 规定不许淘汰（docs/170 §14.3-2）。 */
  function boxKeyNow() {
    var t = boxTask(), s = boxShot();
    return (t && s) ? cacheKey(t, s) : null;
  }

  /** 正在显示 / 正在传回 PS：两种都不许被淘汰。 */
  function isProtected(key) {
    if (lruPinned[key]) return true;
    return key === boxKeyNow();
  }

  function pinSet(key) { if (key) lruPinned[key] = (lruPinned[key] || 0) + 1; }
  function unpinSet(key) {
    if (!key || !lruPinned[key]) return;
    lruPinned[key]--;
    if (!lruPinned[key]) delete lruPinned[key];
  }

  // 真·释放一组：撤销 blob 地址 + 抹掉缓存记录。
  // ⚠ 两道都必要 —— 只 delete cache[key] 的话，blob 还挂在 URL 表里占着内存。
  // ⚠ strengthState 【不在这里删】：docs/170 §14.3-2 明写"强度不跟着释放，
  //   这样被释放的那一套重算后，还停在原来的强度"。强度表只占几个字节。
  function releaseSet(key) {
    var rec = cache[key];
    if (rec && rec.frames) revokeAll(rec.frames);
    delete cache[key];
    delete lruOrder[key];
    delete lruOwner[key];
  }

  /** 记一次"被用过"（算完 / 滚过 / 显示过 都算），并顺手淘汰超出的。 */
  function touchLRU(task, shot) {
    var tid = String((task && task.id) || '');
    var key = cacheKey(task, shot);
    if (!key) return;
    lruOrder[key] = ++lruStamp;
    if (tid) lruOwner[key] = tid;            // ⚠ 空 tid 不覆盖已有的归属
    evictLRU();
  }

  // 超了就把【最久没用过】的几组丢掉。丢的只是内存里那组帧，图本身还在。
  function evictLRU() {
    var keys = Object.keys(lruOrder);
    // ① 先扫掉"表里记着、cache 里其实已经没有了"的空条目。
    //   ⚠ 它们一个字节都不占，却会算进名额里 ⇒ 真数据反而被提前挤掉。
    //     （正常路径已经不会产生这种条目了，这里是兜底：宁可多扫一圈，也别让空缺额。
    //       复核时实测过这类空条目确实会把真帧挤出去。）
    for (var j = 0; j < keys.length; j++) {
      if (!cache[keys[j]]) { delete lruOrder[keys[j]]; delete lruOwner[keys[j]]; }
    }
    keys = Object.keys(lruOrder);
    var over = keys.length - MAX_SETS;
    if (over <= 0) return;
    // ② 按"最后用过"升序，前面的就是最久没用的
    keys.sort(function (a, b) { return lruOrder[a] - lruOrder[b]; });
    for (var i = 0; i < keys.length && over > 0; i++) {
      // ⚠ 正在看 / 正在传回的那一组跳过（规定不许淘汰）。
      //   跳过的【不占】这轮的名额 —— 它本来就该留着。
      if (isProtected(keys[i])) continue;
      releaseSet(keys[i]);
      over--;
    }
  }

  // 任务没了（被删 / 被清）时把它那份记录一起收掉，免得表越攒越大。
  function dropLRU(taskId) {
    var tid = String(taskId);
    var keys = Object.keys(cache);
    for (var i = 0; i < keys.length; i++) {
      if (lruOwner[keys[i]] !== tid) continue;
      releaseSet(keys[i]);
      delete strengthState[keys[i]];
    }
  }

  // 强度 → 帧号。0% 是第 0 张（原图），100% 是最后一张（成品）。
  function frameAt(rec, strength) {
    if (!rec || !rec.frames || !rec.frames.length) return null;
    var n = rec.frames.length - 1;
    var s = Math.max(0, Math.min(1, strength));
    return rec.frames[Math.round(s * n)];
  }

  // ══════════════════════════════════════════════════════════
  //  滚轮：挂在【已有的】预览区监听里（docs/132 §十一 3.1）
  // ══════════════════════════════════════════════════════════
  // ⚠⚠ 不许另挂一个 wheel 监听（铁律 29：滚轮监听别挂会隐藏的元素 ——
  //   .pv-cell 会随预览条收起而隐藏，另挂必踩"动一下鼠标才好"那种陈旧命中测试）。
  //   ui.html 那边只在现成的 pv._pageWheelHandler 里加一个分支，调到这里。
  var strengthState = Object.create(null);   // key -> 0..1

  // ⭐⭐ 滚轮调强度 —— 缩略图和上面大框【共用这一条】，不许各写一份。
  //
  // ⚠⚠ 2026-10-03 晚，用户实测报的：「应该让弹出的大图和缩略图都有反应，
  //   现在只有缩略图有反应。」
  //   真因：这个函数原来叫 wheelOnCell，只认【格子】这一个来源 ——
  //   它改完格子的图就结束了，从头到尾没碰过大框。
  //   而大框自己那个滚轮绑的是【缩放】，跟它提示行上写的"滚轮调强度"是两回事。
  //   ⇒ 抽成一个「跟来源无关」的核心：谁滚进来的都调强度，改完【两端一起换图】。
  //
  // ⚠ cell 允许为 null（从大框滚进来时，那一格可能没渲染出来）。
  //   这时只在框里换图，不去找格子 —— 找不到还硬找会写出一堆写死索引的坑。
  function strengthWheel(task, shot, cell, deltaY) {
    var key = cacheKey(task, shot);
    var cur = strengthState[key];
    var rec0 = cache[key];
    // ⭐⭐ 2026-10-09（docs/175）：判断"要不要先算一遍"的条件，从"没调过强度"
    //   改成"**没调过强度，或者帧已经不在了**"。
    //   ⚠ 为什么必须加后半句：淘汰（全局 12 那道上限）只放帧、**故意不放强度**
    //     （docs/170 §14.3-2：重算后还停在原来的百分比）。
    //     于是会出现"强度还在、帧没了"这种状态 —— 旧判断会以为算过了，
    //     走下面那条零延迟的路，而 applyStrength 里发现没有 rec 就直接 return：
    //     **用户滚半天、画面一动不动、一句错都不报**（本项目最忌的静默失效形态）。
    var haveFrames = !!(rec0 && rec0.ready);

    // ── 第一次滚（或帧已被淘汰）：先算一遍（用户等这一下），算完在已算好的帧里切 ──
    if (cur === undefined || !haveFrames) {
      // ⭐⭐ 2026-10-19（docs/249）：原来这里是【全局】一个 strengthEngineStarting —— 一张在算时，
      //   在【任何别的图】上滚都直接 return（不报错、不算），用户切到另一张调强度就是「没反应」。
      //   现在按【这一张】判：这一张已经在算就等它；别的图照样能开算（排队优先级 0，插到生成校色前面）。
      if (rec0 && rec0.pending) return true;
      // ⚠ 只有"第一次"才把强度设成 100%；帧被淘汰过（强度还留着）时【保留原百分比】。
      if (cur === undefined) strengthState[key] = 1;
      setCellBusy(cell, true);
      if (isBoxShot(task, shot)) setBoxBusy(true);
      computeReady(task, shot).then(function () {
        setCellBusy(cell, false);
        if (isBoxShot(task, shot)) setBoxBusy(false);
        applyStrength(cell, task, shot, strengthState[key]);
      }).catch(function (err) {
        setCellBusy(cell, false);
        if (isBoxShot(task, shot)) setBoxBusy(false);
        delete strengthState[key];
        reportComputeFailure(err, task, shot, true);
      });
      return true;
    }

    // ── 已经算过：在已算好的帧里切，零延迟 ──
    var step = deltaY > 0 ? -0.0625 : 0.0625;   // 16 档 → 每格 1/16
    var next = Math.max(0, Math.min(1, cur + step));
    if (next === cur) return true;
    strengthState[key] = next;
    applyStrength(cell, task, shot, next);
    return true;
  }

  function setCellBusy(cell, busy) {
    if (!cell) return;
    cell.classList.toggle('pv-strength-busy', !!busy);
  }

  // 大框里的"正在算"层（跟格子的绕圈同一个意思，只是画在大框里）
  // ⭐ 2026-10-19（docs/249）：不再只写「正在处理…」—— 有云端单就写它到哪一步了（等待 / 上传% / 云端排队第几位 / 处理中 / 接收%），
  //   文案来自 V7CloudTools.jobText（中性，不说在算什么）。本机引擎没有分步，就照旧「正在处理…」。
  function setBoxBusy(busy) {
    if (!box) return;
    var ld = box.querySelector('.tween-box-loading');
    if (!ld) return;
    ld.style.display = busy ? '' : 'none';
    if (busy) ld.textContent = boxJobText() || '正在处理…';
  }
  // 这一张是不是大框里正在看的那张（别的图在后台算，不该动大框的「正在处理」层）
  function isBoxShot(task, shot) {
    return !!(box && task && String(boxTaskId) === String(task.id) && boxShotIndex === shotIndexOf(task, shot));
  }
  var boxJobs = Object.create(null);   // '任务:张' -> 最新的云端单状态（调强度 / 应用）
  function boxJobText() {
    var s = boxJobs[String(boxTaskJobId()) + ':' + boxShotIndex];
    return s && root.V7CloudTools ? root.V7CloudTools.jobText(s) : '';
  }
  function boxTaskJobId() {
    var t = boxTask();
    return t ? String(t.taskId || t.id) : '';
  }
  if (root.V7CloudTools && typeof root.V7CloudTools.onJob === 'function') {
    root.V7CloudTools.onJob(function (s) {
      if (!s || (s.kind !== 'tween' && s.kind !== 'tween-apply') || !(s.shot >= 0)) return;
      var k = String(s.taskId) + ':' + s.shot;
      if (s.stage === 'done' || s.stage === 'failed') delete boxJobs[k]; else boxJobs[k] = s;
      if (!box) return;
      var ld = box.querySelector('.tween-box-loading');
      if (ld && ld.style.display !== 'none' && k === boxTaskJobId() + ':' + boxShotIndex) ld.textContent = boxJobText() || '正在处理…';
    });
  }

  // 这一格 shot 在界面上的那个格子（从大框滚回来时要同步角标用）。
  // ⚠ 靠 data-original-idx 反查，不靠位置猜 —— 分页翻过之后位置和顺序不是一回事。
  function cellOfShot(task, shot) {
    var idx = shotIndexOf(task, shot);
    if (idx < 0 || !task) return null;
    var el = document.querySelector('.task[data-task="' + String(task.id) + '"]');
    if (!el) return null;
    var cells = el.querySelectorAll('.pv-cell');
    for (var i = 0; i < cells.length; i++) {
      var im = cells[i].querySelector('img[data-img-id]');
      if (im && parseInt(im.dataset.originalIdx, 10) - 1 === idx) return cells[i];
    }
    return null;
  }

  // 缩略图上滚 → 交给上面那个共用核心
  function wheelOnCell(cell, ev, task, pv) {
    var img = cell.querySelector('img[data-img-id]');
    if (!img) return false;
    var shotIndex = parseInt(img.dataset.originalIdx, 10) - 1;
    var shot = (task.shots || [])[shotIndex];
    if (!shot || !shot.done || !shot.imgId) return false;
    return strengthWheel(task, shot, cell, ev.deltaY);
  }

  // 把某一格（+ 上面那个大框）显示成指定强度的那一帧
  //
  // ⚠⚠ cell 允许是 null —— 从【大框】滚进来时，那一格可能没渲染/不在视口里。
  //   以前这里第一行就是 `cell.querySelector(...)`，cell 为 null 会直接抛异常，
  //   而调用方不会报错、只是整条链断掉 → 又是"一句错都不报"那类静默失效。
  function applyStrength(cell, task, shot, strength) {
    var rec = cache[cacheKey(task, shot)];
    if (!rec || !rec.ready) return;
    // ⭐⭐ 2026-10-09（docs/175）：滚一次 = 用过一次。
    //   docs/170 §14.3-2 原文：「某一套每被**显示或滚动**一次，就把它挪到最新」。
    //   ⚠ 旧代码只在"算完"那一刻 touch 过 —— 于是"看过"不算"用过"，
    //     用户正在滚的这一组会被当成最旧的淘汰掉（复核实测确认过）。
    touchLRU(task, shot);
    var f = frameAt(rec, strength);
    if (!f) return;

    if (cell) {
      var img = cell.querySelector('img[data-img-id]');
      if (img) {
        // ⚠ 只换 src，不动 DOM 结构 —— 重建 DOM 会让 hover/按钮状态闪一下。
        if (img.dataset.strengthUrl !== f.url) {
          img.dataset.strengthUrl = f.url;
          img.src = f.url;
        }
        img.dataset.strength = String(Math.round(strength * 100));
      }
      cell.classList.add('pv-strength-on');
    }

    // ⭐⭐ 大框跟着一起换（用户 2026-10-03 晚实测报的：
    //   「应该让弹出的大图和缩略图都有反应，现在只有缩略图有反应」）。
    //   ⚠ 以前这条链【只改格子】—— 大框自己那套滚轮绑的是缩放，两边是断开的。
    syncBoxFrame(task, shot, f);

    // ⭐ 底部那个圆形把跟着走（2026-10-05 用户要的"把里面显示强度"）
    setKnob(strength, true);
  }

  // 大框里的图跟着强度走。⚠ 三个前提缺一不可，不然会把别的任务的图顶掉。
  function syncBoxFrame(task, shot, f) {
    if (!box || !box.classList.contains('show')) return;
    if (String(boxTaskId) !== String(task.id)) return;
    if (boxShotIndex !== shotIndexOf(task, shot)) return;
    var img = box.querySelector('.tween-box-img');
    if (!img) return;
    if (img.dataset.strengthUrl === f.url) return;
    img.dataset.strengthUrl = f.url;
    img.src = f.url;
    img.style.display = '';
    var ld = box.querySelector('.tween-box-loading');
    if (ld) ld.style.display = 'none';
  }

  // ⭐⭐ 大图右侧那条【竖直滑条】（2026-10-05 晚，替掉原来的圆形把）。
  //   用户原话：「我要任务卡预览大图右侧从上到下有一个滑条，滑条可以拉，
  //     滚动联动滑条，滑条底部是强度参数，而不是现在的圆形」。
  //
  //   ⚠⚠ 三条硬要求，各对应一个设计决定：
  //     ① "从上到下" ⇒ 竖直方向。**0% 在底、100% 在顶** —— 跟所有竖直滑条一致
  //        （往上 = 更强）。fill 用 bottom:0 往上长，thumb 用 bottom:% 定位。
  //     ② "滚动联动滑条" ⇒ 滚轮和滑条是【同一份状态】，不许各记一份。
  //        两边都只调 applyStrength，位置在 setSlider 里统一写。
  //     ③ "底部是强度参数" ⇒ 百分比写在滑条【最下面】，不是浮在中间。
  //
  //   ⚠ show=false 时整条隐藏：没调过强度的图不该冒出一个 100%，
  //     那会让用户以为"这张被改过"（假信息，本项目一贯不画假东西）。
  function setSlider(strength, show) {
    if (!box) return;
    var sl = box.querySelector('.tween-box-slider');
    if (!sl) return;
    // ⚠⚠⚠ 2026-10-05：滑条【悬浮】在图上，不挤压图片占的位置。
    //   用户原话：「我要悬浮的 不要挤压图占的位置」。
    //   ⇒ 这里不再挂 .has-slider（那一版会给 .tween-box-inner 加 44px 右内边距、
    //     把图挤窄），已按用户要求删掉。图照旧占满整框、居中原位，
    //     滑条浮在它右边那一层上（.tween-box-slider 自己绝对定位 + 半透明底）。
    if (!show) { sl.hidden = true; return; }
    sl.hidden = false;
    var s = Math.max(0, Math.min(1, Number(strength)));
    var pct = (s * 100);
    var fill = sl.querySelector('.ts-fill');
    var thumb = sl.querySelector('.ts-thumb');
    var v = sl.querySelector('.ts-v');
    if (fill) fill.style.height = pct + '%';
    if (thumb) thumb.style.bottom = pct + '%';
    if (v) v.textContent = Math.round(pct) + '%';
  }
  // 旧名字留着（别处可能还调）—— 直接转给新的
  function setKnob(strength, show) { setSlider(strength, show); }

  // 拖动滑条：按鼠标在轨道里的位置【绝对设值】（滚轮是相对的，拖拽要绝对的）
  function bindSlider() {
    if (!box) return;
    var sl = box.querySelector('.tween-box-slider');
    if (!sl || sl.dataset.bound === '1') return;
    sl.dataset.bound = '1';
    var track = sl.querySelector('.ts-track');
    if (!track) return;

    function valueAt(clientY) {
      var r = track.getBoundingClientRect();
      if (r.height <= 0) return null;
      // ⚠ 从下往上：底边 = 0%，顶边 = 100%
      return Math.max(0, Math.min(1, (r.bottom - clientY) / r.height));
    }
    function applyAt(clientY) {
      var t = boxTask(), shot = boxShot();
      if (!t || !shot) return;
      var v = valueAt(clientY);
      if (v == null) return;
      // ⚠ 还没算过帧 → 先走一次滚轮那条初始化（会去 compute），别自己另开一条
      var key = cacheKey(t, shot);
      var rec0 = cache[key];
      // ⭐⭐ 2026-10-09（docs/175）：跟 strengthWheel 里同一条 ──
      //   "帧被淘汰了（强度还留着）"也算"没算过"，否则拖滑条同样纹丝不动。
      if (strengthState[key] === undefined || !rec0 || !rec0.ready) {
        strengthWheel(t, shot, cellOfShot(t, shot), 0);   // 触发首次 compute
        return;
      }
      strengthState[key] = v;
      applyStrength(cellOfShot(t, shot), t, shot, v);
    }

    // ⚠⚠⚠⚠ 2026-10-05 修「滑条的点点不动」的真正根因（探针量的实数，不是猜）：
    //   圆点靠 margin-bottom:-9px 骑在数值线上 → **100% 时它有一半探出轨道顶边**。
    //   实测：圆点顶 74 / 轨道顶 83 ⇒ 圆点上方那 9px 落在【轨道外面】，
    //   在那些像素上按下，命中的是 .tween-box-slider（外层容器），
    //   而处理函数当时挂在【轨道】上 ⇒ dragging 永远是 false，圆点"点不动"。
    //   （只给容器加 padding 是不够的 —— 那只是给了空间，没改命中目标。）
    //   ⇒ 处理函数挂【整条滑条 sl】（34px 宽 × 整高），不再只挂 18px 的轨道。
    //     这样圆点无论骑到哪一端，它整圈都落在监听范围内。
    //   ⚠ 值仍然按【轨道】的矩形算（圆点骑出轨道那 9px 会被 clamp 成 0% / 100%，
    //     正好是想要的行为：拖到端点就是端点）。
    sl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // ⚠ 点到底部那个百分比数字不应该跳值 —— 那不是滑轨范围
      if (e.target && e.target.closest && e.target.closest('.ts-v')) return;
      e.preventDefault();
      e.stopPropagation();          // ⚠ 别让父层的"拖动平移"也接上
      try { sl.setPointerCapture(e.pointerId); } catch (_) {}
      sl.classList.add('dragging');
      dragPointer = e.pointerId;
      applyAt(e.clientY);
    });
    // ⚠⚠⚠ 只拦 pointerdown 是【不够的】——
    //   浏览器在 pointerdown 之后还会补发一个兼容用的 mousedown，
    //   而外层 bindBoxInteractions 的"拖动平移"挂的正是 mousedown。
    //   于是拖滑条会【同时把图片拖走】（两个动作一起发生）。
    //   （本项目的既定形态：拦一种事件不够，得把同一动作的所有入口都堵上。）
    var stopMouse = function (e) { e.preventDefault(); e.stopPropagation(); };
    sl.addEventListener('mousedown', stopMouse);

    // ⚠⚠⚠ move / up 挂【window】，不挂 track 自己：
    //   轨道只有 18px 宽，用户手一抖指针就出了轨道 ——
    //   挂在轨道上的话拖到一半就断（滑条"拖不动"，得重新点住）。
    //   这也符合本项目那条：拖拽要挂到能兜住整个手势的那一层（同 free-mode 的拖卡）。
    //   ⚠ 只挂一次：本函数靠 dataset.bound 去重（整框一生只建一次，但还是写稳）。
    if (!bindSlider._wired) {
      bindSlider._wired = true;
      var onMove = function (e) {
        if (dragPointer === null || e.pointerId !== dragPointer) return;
        e.preventDefault();
        applyAt(e.clientY);
      };
      var onUp = function (e) {
        if (dragPointer === null || e.pointerId !== dragPointer) return;
        dragPointer = null;
        if (box) {
          var s2 = box.querySelector('.tween-box-slider');
          if (s2) s2.classList.remove('dragging');
        }
      };
      root.addEventListener('pointermove', onMove, { passive: false });
      root.addEventListener('pointerup', onUp);
      root.addEventListener('pointercancel', onUp);
    }
  }
  // 正在被拖的 pointerId（null = 没在拖）
  var dragPointer = null;

  // 大框现在装的是哪个任务 / 哪一张（从 boxTaskId / boxShotIndex 还原）
  function boxTask() {
    if (!boxTaskId) return null;
    if (typeof root.taskById === 'function') {
      try { return root.taskById(boxTaskId); } catch (_) {}
    }
    return null;
  }
  function boxShot() {
    var t = boxTask();
    if (!t) return null;
    var s = (t.shots || [])[boxShotIndex];
    return (s && s.done && s.imgId) ? s : null;
  }

  // 拿到当前格子的强度（大预览框要跟缩略图同步）
  function currentStrength(task, shot) {
    var v = strengthState[cacheKey(task, shot)];
    return v === undefined ? 1 : v;
  }

  function currentFrameUrl(task, shot) {
    var rec = cache[cacheKey(task, shot)];
    if (!rec || !rec.ready) return null;
    // ⭐⭐ 2026-10-09（docs/175）：这个函数【所有调用方都是"要把它显示出来"】
    //   （大框换图 / 悬停换图 / 点缩略图），所以这里 = "被显示了一次"。
    //   docs/170 §14.3-2 要求"被显示一次就挪到最新" —— 见 applyStrength 里那段说明。
    touchLRU(task, shot);
    var f = frameAt(rec, currentStrength(task, shot));
    return f ? f.url : null;
  }

  // ══════════════════════════════════════════════════════════
  //  上方大预览框（阶段 4）
  // ══════════════════════════════════════════════════════════
  //
  // ⚠⚠ 两条用户定的硬规矩（docs/132 §2.1，不许自己发挥）：
  //   宽 = 任务卡弹出的【预览条的整宽】（不是 4 张图，是整条，含右侧点状条）
  //   高 = 从预览条顶边，一直到【一级主卡堆的顶边】
  // ⚠ 这两条必须【实时算】（getBoundingClientRect），不许写死像素 ——
  //   窗口大小、卡片堆叠数、预览条张数一变就得跟着变（docs/132 §2.1 明写）。
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'tween-box';
    box.setAttribute('aria-hidden', 'true');
    // ⚠ 全屏层一律 Portal 到 body（铁律 23）：被带 transform 的祖先困住会变"小黑屋"。
    // ⚠⚠ 藏意图（2026-10-04 用户定）：等待文案原来写的是「正在算过渡帧…」，
    //   等于把"我们在算中间帧"直接告诉用户，**把项目辛苦做的防逆向白送了**
    //   （docs/133 §四：端点 / 权重名 / 类名 / 张量键名全换中性词，124 条键 0 处可反推）。
    //   ⇒ 改成「正在处理…」：只说"在忙"，不说在忙什么。
    //   ⚠ 以后往界面加文案，先问一句"这句暴露了实现方式吗"（docs/136 §一）。
    // ⚠⚠ 2026-10-05 晚：底部那个圆形把 → 改成【右侧从上到下的竖直滑条】。
    //   用户原话：「我要任务卡预览大图右侧从上到下有一个滑条，滑条可以拉，
    //     滚动联动滑条，滑条底部是强度参数，而不是现在的圆形」。
    //   ⇒ 结构：.tween-box-slider 是右侧一整条（top:0 bottom:0），
    //     里面 .ts-track（细轨）+ .ts-fill（从下往上涨的填充）+ .ts-thumb（可拖的圆点），
    //     最底下 .ts-v 显示百分比。
    //   ⚠ 「滚动联动滑条」= 滚轮的调强度和滑条位置是【同一个状态】，
    //     NOT 两条各自记一份。所以两者都只走 applyStrength，位置由它统一写。
    box.innerHTML =
      '<div class="tween-box-inner">' +
      '  <img class="tween-box-img" alt="">' +
      '  <div class="tween-box-loading">正在处理…</div>' +
      '  <div class="tween-box-hint">滚轮调强度 · Ctrl+滚轮缩放 · 拖动平移 · 双击复位</div>' +
      '</div>' +
      '<div class="tween-box-slider" hidden>' +
      '  <div class="ts-track"><i class="ts-fill"></i><b class="ts-thumb"></b></div>' +
      '  <span class="ts-v">100%</span>' +
      '</div>';
    // ⚠⚠ 2026-10-05 用户实测后改定：「应用」【不放大框里】了，挪到缩略图上替掉「替换」。
    //   原话："我们的预览窗口是完全穿透的，没有办法在预览窗口上点按下任何的按钮。
    //     并且如果说鼠标移到预览窗口才能传回的话…拉长用户的操作路径。
    //     现在还是需要去把原来的替换按钮换成应用按钮。"
    //   ⇒ 这里推翻了 docs/136 的 S5（"按钮只放大框里"）—— 以用户实测为准。
    //     按钮现在在 ui.html 的 buildPreview（缩略图那一排），点击走 V7Tween.applyShot。
    document.body.appendChild(box);
    bindBoxInteractions(box);
    bindSlider();
    watchMainCards();
    return box;
  }

  // ⚠⚠ 2026-10-04 用户实测「向右滑动不灵敏」的真因：
  //   .tween-box 的 z-index 是 10050，而它横向占的正是【二级/三级卡往右弹的位置】——
  //   鼠标推过去想开二级卡时，事件先被预览框吃了。
  //   ⇒ 二级/三级卡一开着，就先别让预览框挡路。
  //   ⚠ 用 MutationObserver 只挂一次（铁律 28：别在重绘函数里绑监听，会翻倍锁死整机）。
  var mainWatch = null;
  function mainCardsOpen() {
    var z = document.getElementById('zones');
    var d = document.getElementById('detail');
    return !!((z && z.classList.contains('show')) || (d && d.classList.contains('show')));
  }
  function watchMainCards() {
    if (mainWatch) return;
    var targets = [document.getElementById('zones'), document.getElementById('detail')];
    try {
      mainWatch = new MutationObserver(function () {
        if (mainCardsOpen() && box && box.classList.contains('show')) {
          // ⚠⚠⚠ 2026-10-06 晚：这里原来只 `box.classList.remove('show')`，
          //   留下三个脏状态 —— 用户实测「第一下正常、后面推右没反应」的真因：
          //     ① 预览条 .show 不收（原注释说"有意"）→ 而 ui.html 的触发分支是
          //        `if(!pvOpen)` → 条还开着，右滑就【再也不会重新弹框】；
          //     ② boxTaskId / hideTimer 不清 → 后续 leaveTaskCard 的收尾对错人；
          //     ③ yieldState 不清 → 下一次 showBox 的 yieldMainCard 直接
          //        `if(yieldState)return` 跳过，二级卡不再让位、叠在框上打架。
          //   ⇒ 主链要用这块地方 = 任务预览【整体退场】（框和条同生同死，
          //     这也是 2026-10-06 定下的"条和框必须一起死"的另一半）。
          //     这里【不】恢复主链：主链是这次要用的那一方，刚让位又抢回去是错的。
          concedeToMainCards();
        }
      });
      for (var i = 0; i < targets.length; i++) {
        if (targets[i]) mainWatch.observe(targets[i], { attributes: true, attributeFilter: ['class'] });
      }
    } catch (_) { mainWatch = null; }
  }

  // 二级/三级卡要用了：任务预览整体退场（框 + 条 + 全部状态一次性清干净）。
  // ⚠ 必须和 hideBox 清的一样多 —— 区别只有一条：这里【不调 restoreMainCard】
  //   （主链已经自己开了，不能再抢回去），yieldState 直接置空。
  function concedeToMainCards() {
    clearTimeout(hideTimer);
    var wasTask = boxTaskId;
    if (box) {
      box.classList.remove('show');
      box.setAttribute('aria-hidden', 'true');
    }
    setBoxTask(null);
    boxShotIndex = -1;
    boxAnchorEl = null;
    boxCustom = '';
    boxGeometry = null;
    setKnob(0, false);
    yieldState = null;
    if (wasTask != null && typeof onBoxClosed === 'function') {
      try { onBoxClosed(String(wasTask)); } catch (_) { /* 通知失败不影响退场 */ }
    }
  }

  // 一级主卡的矩形（要它的 left 和 top）。
  //
  // ⚠⚠ 2026-10-04 用户实测报的 bug 的根因：这里原来查的是 `#stack .card`，
  //   但【主卡的类名是 .block-card，根本不存在 .card】（grep 全文件 0 处命中）。
  //   于是选择器永远匹配不到 → 每次都走兜底值 → 用户看到"窗口大小不对"。
  //   ⚠ 教训：写选择器之前先 grep 一遍类名，别按印象写。
  //
  // ⚠ 2026-10-03 第二版：用户定的宽从"预览条整宽"改成
  //   【主卡左缘 → 预览条右缘】= 一级卡 + 二级 + 三级 拉开之后的总宽（880）。
  //   所以这里要的是【一个矩形】，不再只是顶边的 y。
  function mainCardRect() {
    // 优先用"当前这张"主卡（自由模式里每张卡位置不同，得跟正在看的那张走）
    var cur = document.querySelector('#stack > .block-card.is-current');
    if (cur && cur.getBoundingClientRect) {
      var r0 = cur.getBoundingClientRect();
      if (r0.width >= 40 && r0.height >= 20) return r0;
    }
    var best = null;
    var cards = document.querySelectorAll('#stack > .block-card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c.getBoundingClientRect) continue;
      // 折叠/隐藏的卡不算（它没有可见高度）
      var r = c.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      if (!best || r.top < best.top) best = r;
    }
    return best;
  }

  // ⭐⭐ 整叠主卡的【上下边界】（2026-10-04 新增，给大框的高度用）
  //
  //   为什么要"整叠"而不是"一张卡"：
  //     用户要的框高 = 1 张卡 + 3 张叠压露边 = 400 + 34×3 = 502。
  //     而标准模式下只有 is-current 那张在最上面，下面几张是【各自 transform:translateY(34px×深度)】，
  //     所以"整叠的矩形"正好 = 顶卡顶边 → 最底下那张的底边 = 60 → 562。
  //
  //   ⚠ top 取【最小值】、bottom 取【最大值】—— 不是"顶卡"和"最后一张卡"，
  //     因为自由模式里卡片可以任意摆放，z 序和 y 序不一定一致（摆乱了也得出对的结果）。
  //   ⚠ 折叠/隐藏/堆外的不算（同 mainCardRect 的过滤条件）。
  //   ⚠ 拿到 null 时调用方要能退回（见 geometryFor 里那个兜底分支）。
  function stackBounds() {
    var cards = document.querySelectorAll('#stack > .block-card');
    var top = null, bottom = null;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.hidden || !c.getBoundingClientRect) continue;
      if (c.classList.contains('stack-overflow-hidden')) continue;
      if (c.offsetParent === null && c.style.display === 'none') continue;
      var r = c.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      if (top === null || r.top < top) top = r.top;
      if (bottom === null || r.bottom > bottom) bottom = r.bottom;
    }
    if (top === null || bottom === null || bottom <= top) return null;
    return { top: top, bottom: bottom };
  }

  // ⭐ 自由模式下大框和预览条之间的间隔。
  //   ⚠ 这个数【不是拍脑袋】：2026-10-05 在标准模式下实测「框底 → 预览条顶」= 16.57px
  //     （探针 tmp/_measure-std-gap.cjs，1500×1000 窗口；标准模式那边框底锚在主卡堆底上，
  //     这段距离由布局自然形成）。用户定"跟标准模式量出来的一样"，所以照抄。
  //   ⚠ 它同时保证缩略图悬停放大（1.32 倍、往上冒约 21px，但格子顶本身比预览条顶低 10px）
  //     不会被框压住：放大后顶边仍比框底低约 6px。
  var FREE_GAP = 16.57;
  function isFreeMode() {
    try { if (root.V7FreeMode && typeof root.V7FreeMode.isActive === 'function' && root.V7FreeMode.isActive()) return true; } catch (_) {}
    return !!(document.body && document.body.classList.contains('free-mode'));
  }
  // 自由模式的几何：只看预览条，跟主卡在哪【完全无关】。
  //   放置顺序（2026-10-05 用户定）：
  //     ① 预览条【上方】放得下正方形 → 放上方（首选，跟标准模式同一个方向）
  //     ② 上方放不下 → 翻到预览条【下方】，同样 对齐 + 正方形 + 同一个间隔
  //     ③ 上下都放不下 → 缩小但【保持正方形】，放在空间大的那一边，左缘对齐预览条
  //   ⚠ 三种情况都不压缩略图：间隔永远是 FREE_GAP，从预览条边缘往外量。
  var EDGE = 8;   // 离窗口边的最小留白
  function freeGeometry(sr, left, width) {
    var vh = root.innerHeight || 900;
    var spaceAbove = (sr.top - FREE_GAP) - EDGE;
    var spaceBelow = (vh - EDGE) - (sr.bottom + FREE_GAP);
    if (spaceAbove >= width) {
      return { left: left, width: width, top: sr.top - FREE_GAP - width, height: width, side: 'above' };
    }
    if (spaceBelow >= width) {
      return { left: left, width: width, top: sr.bottom + FREE_GAP, height: width, side: 'below' };
    }
    var size = Math.max(160, Math.floor(Math.max(spaceAbove, spaceBelow)));
    if (spaceAbove >= spaceBelow) {
      return { left: left, width: size, top: sr.top - FREE_GAP - size, height: size, side: 'above-shrunk' };
    }
    return { left: left, width: size, top: sr.bottom + FREE_GAP, height: size, side: 'below-shrunk' };
  }

  // ⚠ 用户定的两条硬规矩（2026-10-03 晚【改版】，用户语音原话）：
  //   宽 = 【一级卡左缘 → 预览条右缘】= 一级卡 + 二级 + 三级 拉开之后的总宽（≈880）
  //        ⚠ 原来写的是"预览条整宽（572）"，用户实测后要求改成整条 880。
  //   高 = 从预览条顶边一直到一级主卡堆顶边（这条没变）
  //   ⚠⚠ 这套【只给标准模式】。自由模式 2026-10-05 起单独走 freeGeometry（用户点名要分开）。
  function geometryFor(taskEl, pv, layoutRect) {
    // 预览条：任务卡右边那条（含右侧点状分页条 .pv-rail）
    var strip = pv.querySelector('.pv-strip') || pv;
    var sr = layoutRect || strip.getBoundingClientRect();

    // ⚠⚠ 2026-10-03 晚【第三版】—— 用户实测后又把上一版推翻了。
    //   版本史（别再来回改，先看清这段）：
    //     第一版：宽 = 预览条整宽（约 572）
    //     第二版：宽 = 主卡左缘 → 预览条右缘（一级+二级+三级 ≈880）← 用户 Message 3 要的
    //     第三版（现在）：宽 = 预览条(.pv-strip)自己那一截      ← 用户 Message 7 要的
    //   用户原话：「它的宽度差不多是我们整个的一级卡片加上二级卡片加上三级卡片的宽度，
    //     而不是只有它弹出卡片的那个宽度。我让你限制到弹出卡片那个横向的宽度。」
    //   ⇒ 所以现在【左缘 + 宽】都取自预览条：框跟预览条左右两条边完全对齐。
    //   ⚠ 不要再改回 880 —— 那正是这次点名要拆掉的。
    var left = sr.left;
    var width = Math.max(240, Math.round(sr.width));

    // ⭐⭐ 2026-10-05：自由模式【单独一条路】，不再复用下面那套"锚主卡堆"。
    //   用户原话："是不是你偷懒了？你直接去检测另外一个卡片所在的位置，然后联动它们去算高度了。
    //     我要求是不要挤压下面的缩略图卡片，然后往上有一个正常的间隔，保持1:1，
    //     在自由模式下…高度计算路径不是一条线，你要重新单独写一下。"
    //   ⚠ 原来这里写着"自由模式复用同一套，不另写一份"——那是错的：自由模式里主卡可以摆在任何地方，
    //     拿主卡堆的上下边去算，框的高度/位置就跟着别的卡跑（后来加的"不超过窗口 62%"只是补丁）。
    //   ⇒ 自由模式只认【预览条自己】：
    //     · 宽 / 左缘 = 预览条（上面已经算好，跟标准模式一致）
    //     · 底 = 预览条顶 − FREE_GAP（跟标准模式实测的间隔一样，用户定的）
    //     · 高 = 宽（正方形 1:1，用户定的）
    if (isFreeMode()) return freeGeometry(sr, left, width);

    // ⭐⭐ 高：上下两条边【都锚在主卡堆的网格上】（2026-10-04 用户定案）
    //
    //   用户原话：「需要对齐，就是跟我们别的界面去做对齐。
    //     这个具体的像素数值我不知道，但是你要思考 —— **我们的界面都是方格子，它不能凸出去**。」
    //
    //   ⇒ 正解 = 框的上边贴【主卡堆顶边】、下边贴【主卡堆底边】，
    //      **高度 = 堆高 = 400 + 露边34 × 可见层数**（4 张正好 502），
    //      一个像素都不多、也不伸进缩略图那一格。
    //
    //   ⚠⚠ 为什么不能用"预览条顶 −8"（原来就是这么写的，两个 bug 都出在这）：
    //     ① 框会比堆高【多 9px】（8px 缝 + .task 的 1px 边框）→ 他报的"比这个高度要多一段像素"
    //     ② 框底会伸到【预览条顶上方 4px】，而缩略图 hover 放大 1.32 倍后
    //        顶边在【预览条顶上方 11.8px】→ 放大的那部分被框压住（他报的"小图被大图压住"）
    //     两个 bug 同一个根，锚到网格上一起解决。
    //   ⚠ 不写死任何数字：堆顶/堆底都是实时量的（自由模式里主卡可随意摆）。
    var stackRect = stackBounds();
    var mr = mainCardRect();
    var top = stackRect ? stackRect.top : (mr ? mr.top : null);
    var bottom = stackRect ? stackRect.bottom : null;
    if (top === null || bottom === null) {
      // 拿不到主卡堆（理论上不该发生）→ 退回"预览条上方给一块"
      top = Math.max(8, sr.top - 420);
      bottom = sr.top - 8;
    }
    var height = Math.max(160, bottom - top);

    // ⚠⚠ 2026-10-04 用户实测报的 bug：自由模式下窗口【过长】。
    //   真因：自由模式里主卡是随意摆的，可能被摆到屏幕很上面，
    //   "顶到主卡顶边"这条规矩就会算出一个从屏幕顶一直到预览条的巨型框。
    //   用户原话：「我希望它就是直接在预览的那个横条上方直接弹出来」
    //   ⇒ 加一道【封顶】：不管主卡在哪，高度不超过窗口的 62%。
    //     ⚠ 封顶时底边仍然贴着【堆底】（不再贴预览条顶），保持"不压缩略图"这条。
    var vh = root.innerHeight || 900;
    var maxH = Math.round(vh * 0.62);
    if (height > maxH) {
      height = maxH;
      top = bottom - height;
    }

    return { left: left, width: width, top: top, height: height };
  }

  function positionBox(taskEl, pv) {
    var g = geometryFor(taskEl, pv);
    box.style.left = g.left + 'px';
    box.style.width = g.width + 'px';
    box.style.top = g.top + 'px';
    box.style.height = g.height + 'px';
  }

  // ⚠⚠ 2026-10-03 晚（探针抓到的真 bug，不是假红）：
  //   预览条弹出时有【滑入动画】(transform: translateX(-24px) → 0，.34s)。
  //   框是在弹出的那一瞬间量的尺寸 → 量到的是"还没滑到位、右缘偏左 24px"的预览条。
  //   后果：框比它该有的宽度【窄一截】（实测 591 vs 该有的 598），
  //   而且右边跟预览条对不齐 —— 用户要的正是"跟预览条完全对上"。
  //   ⚠ 加两张缩略图后偏得更明显：条越宽，那 24px 的相对偏差越大。
  //   ⇒ 弹出后再量几次，等滑入动画走完，量到的才是稳定值。
  //   ⚠ 用 setTimeout 链而不是 transitionend：预览条上还挂着别的过渡，
  //     逐个监听容易重复绑定（铁律 28）。这里只是重复算几个矩形，很便宜。
  var repositionTimers = [];
  function scheduleReposition(taskEl, pv) {
    // ⚠ 先把上一次的定时器清掉 —— 快速划过好几张卡时不清理会堆积成风暴。
    for (var i = 0; i < repositionTimers.length; i++) clearTimeout(repositionTimers[i]);
    repositionTimers = [];
    var delays = [60, 140, 260, 420];   // 覆盖 .34s 那条滑入动画的全程
    for (var j = 0; j < delays.length; j++) {
      (function (d) {
        repositionTimers.push(setTimeout(function () {
          // 框已经被收掉 / 已经换到别的任务上了 → 别再动它
          if (!box || !box.classList.contains('show')) return;
          // ⚠⚠⚠ 2026-10-03 晚【用户实测报的"没对齐"就是这个判断写完的结果】。
          //   原来写的是：
          //       if (boxTaskId !== (taskEl && taskEl.dataset ? taskEl.dataset.task : boxTaskId)) return;
          //   左边 boxTaskId 是【数字】（task.id 来自 ++taskSeq），
          //   右边 taskEl.dataset.task 是【字符串】（DOM 属性一律字符串）。
          //   ⇒ `1 !== "1"` 恒为 true ⇒ 这个函数【每一次都从这里 return】，
          //     三段重定位从上线到现在一次都没执行过。
          //   后果正是用户看到的：框停在"弹出那一瞬间"量到的位置，
          //   而那一刻预览条还在滑入动画里（translateX(-24px)），位置偏左 24px，
          //   之后【再也不会被修正】。
          //   ⚠ 教训同 docs/134 那批：**类型不一致的比较不报错，只是永远走错分支**。
          //     凡是拿 dataset 跟内存里的值比，两边都 String() 一下，别赌类型。
          if (String(boxTaskId) !== String(taskEl && taskEl.dataset ? taskEl.dataset.task : boxTaskId)) return;
          var live = taskEl.querySelector('.task-preview.show') || taskEl.querySelector('.task-preview');
          if (!live) return;
          positionBox(taskEl, live);
        }, d));
      })(delays[j]);
    }
  }

  // 一级卡"让位"：预览框要弹时，把开着的二级/三级收回（带动画），离开时恢复。
  // ⚠ 用户点名要求「收回」和「恢复」都要有过渡动画（docs/132 §2.3）。
  function yieldMainCard() {
    // ⚠⚠⚠ 2026-10-06 晚：这里原来第一句是 `if (yieldState) return;` —— 已删。
    //   上一次让位可能【没有经过 hideBox】（二级卡自己弹开时由 concedeToMainCards
    //   让框退场），于是 yieldState 一直挂着：下一次 showBox 直接从这里 return →
    //   二级卡不再收 → 框和二级叠着打架。
    //   让位状态要按【现场】重新采一次，它不是一次性的令牌。
    yieldState = null;
    var zones = document.getElementById('zones');
    var detail = document.getElementById('detail');
    var wasOpen = !!(zones && zones.classList.contains('show')) ||
                  !!(detail && detail.classList.contains('show'));
    yieldState = { wasOpen: wasOpen };
    if (!wasOpen) return;
    // ⚠ 走现成的 closeAll（它自带收回动画 + playRecoil），不自己写一套 ——
    //   自己写的动画容易踩"先加 class 再播 = 闪两次"（铁律 22）。
    if (typeof root.closeAll === 'function') {
      try { root.closeAll(); } catch (_) {}
    }
  }

  function restoreMainCard() {
    if (!yieldState) return;
    var st = yieldState;
    yieldState = null;
    if (!st.wasOpen) return;
    // ⚠ 恢复用现成的 resumeDetail（它带着展开动画）。
    //   找不到就安静放弃 —— 这里失败不该让整个界面挂掉。
    try {
      if (typeof root.resumeDetail === 'function') root.resumeDetail();
      else if (typeof root.setZone === 'function') root.setZone(root.zoneSel || 0);
    } catch (_) {}
  }

  function showBox(taskEl, task, shotIndex, url, busy) {
    ensureBox();
    var pv = taskEl.querySelector('.task-preview.show') || taskEl.querySelector('.task-preview');
    if (!pv) return;
    clearTimeout(hideTimer);
    setBoxTask(task.id);
    boxAnchorEl = null;
    boxCustom = '';
    boxGeometry = null;
    boxShotIndex = shotIndex;
    positionBox(taskEl, pv);
    scheduleReposition(taskEl, pv);   // ⚠ 见下面说明：预览条还在滑入时量到的尺寸是偏的
    yieldMainCard();

    var img = box.querySelector('.tween-box-img');
    var loading = box.querySelector('.tween-box-loading');
    if (url) { img.src = url; img.style.display = ''; }
    else { img.style.display = 'none'; }
    loading.style.display = busy ? '' : 'none';
    box.classList.add('show');
    box.setAttribute('aria-hidden', 'false');
    // ⚠⚠ 2026-10-06 晚：让位万一没成功（closeAll 不可用 / 被别的流程挡住），
    //   别硬叠在二级卡上 —— 走和观察器同一条退场路，整体收干净。
    if (mainCardsOpen()) { concedeToMainCards(); return; }
    resetView();

    // ⭐ 底部圆形把（2026-10-05）：只在【这一张真的调过强度】时出现。
    //   ⚠ 没调过就冒一个 100% 出来 = 假信息，用户会以为这张被改过。
    //   ⚠ 复用 currentStrength（没调过时它返回 1），但要判断 strengthState 里
    //     【有没有这一张的键】才决定显不显示 —— 别把默认值当"调过"。
    var sh = (task && task.shots || [])[shotIndex];
    if (sh) {
      var adjusted = strengthState[cacheKey(task, sh)] !== undefined;
      setKnob(currentStrength(task, sh), adjusted);
    } else {
      setKnob(0, false);
    }
  }

  // ⭐⭐ 2026-10-05：给「传回」用 —— 这一张调过强度的话，返回【调好那一帧】的字节。
  //
  //   用户实测："在修改完强度之后，点击传回，传回的不是修改完强度的，而是满强度的。"
  //   真因：ui.html 的 aiTransfer 从来只读 shot.imgId（AI 返回的 100% 原图），
  //   docs/136 S3（"点传回时传的是滚过之后的那张"）一直没接线。
  //
  //   返回 Promise<Uint8Array|null>：
  //     · null = 没调过、或者调回了 100% → 调用方照旧传原图
  //       （100% 不用帧：帧是引擎重新编过的 PNG，原图才是无损原样）
  //     · 调过但帧还在算 → 【等它算完】再返回，不能偷偷传 100%（那正是这次的 bug 形态）
  //   ⚠ 按 imgId 找，不按位置：调用方手里是 outputs（排过序 / 过滤过），位置对不上。
  function frameBytesFor(task, imgId) {
    if (!task || !imgId) return Promise.resolve(null);
    var shot = null, list = task.shots || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].imgId === imgId) { shot = list[i]; break; }
    if (!shot) return Promise.resolve(null);
    var key = cacheKey(task, shot);
    var s = strengthState[key];
    if (s === undefined || s >= 1) return Promise.resolve(null);
    // ⭐⭐ 2026-10-09（docs/175）：传回期间【钉住】这一组。
    //   docs/170 §14.3-2 原文：「⚠ 正在显示的那一套、**正在传回 PS 的那一套**，不能被释放。」
    //   ⚠ 为什么必须钉：只要一淘汰就会 revoke 掉 blob，而这里紧接着要读 f.bytes
    //     （bytes 还在，但整组的生命周期不该由"恰好没超上限"来决定）。
    pinSet(key);
    return compute(task, shot).then(function (rec) {
      var f = frameAt(rec, strengthState[key] === undefined ? 1 : strengthState[key]);
      return f ? losslessFrameBytes(task, shot, rec, f) : null;
    }).then(function (out) { unpinSet(key); return out; },
            function (err) { unpinSet(key); throw err; });
  }

  // ⭐⭐ 2026-10-18 云端外挂（docs/237）：拿【能进 PS 的】那一帧。
  //   本机算的帧本来就是 PNG 无损 ⇒ 直接给。
  //   云端预览帧是 JPEG（有损，只给眼睛看）⇒ 单独向引擎要这一帧的 PNG（only=第几帧，同样的帧数），
  //   实测跟老格式那一帧逐字节相同（scripts/test-engine-access-lock.cjs）。
  //   ⚠ 绝不许拿有损预览顶上去进 PS —— 那是悄悄糟蹋画质，用户看不出来（docs/21 那条铁律）。
  function losslessFrameBytes(task, shot, rec, f) {
    if (!rec || !rec.lossy) return Promise.resolve(f && f.bytes ? new Uint8Array(f.bytes) : null);
    var idx = (rec.frames || []).indexOf(f);
    if (idx < 0) return Promise.resolve(null);
    var ep = endpointsOf(task, shot);
    if (!ep) return Promise.reject(new Error('原图或成品已经不在内存里了，拿不到这一档的无损图 —— 重新滚一下强度再点'));
    var steps = (rec.meta && Number(rec.meta.steps)) || STEPS;
    return Promise.resolve()
      .then(function () { return root.IMG.fullBytes(ep.a); })
      .then(function (bufA) { return root.IMG.fullBytes(ep.b).then(function (bufB) { return [new Uint8Array(bufA), new Uint8Array(bufB)]; }); })
      .then(function (pair) {
        var A = pair[0], B = pair[1];
        var body = new Uint8Array(A.length + B.length);
        body.set(A, 0); body.set(B, A.length);
        // ⭐ 2026-10-19（docs/249）：云端那两张图本来就在（调强度时传过）—— 云端任务队列查指纹发现已有，【一个字节都不再传】；
        //   引擎也只算包含这一帧的那一批（结果逐字节一样）。bin=1 二进制回包。
        return fetch(ENGINE_BASE + '/tween?steps=' + steps + '&only=' + idx + '&bin=1', {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Head-Len': String(A.length) }, body: body,
          __v7Job: { kind: 'tween-apply', priority: 0, taskId: String((task && (task.taskId || task.id)) || ''), shot: shotIndexOf(task, shot) }
        });
      })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (text) { var m = text; try { m = JSON.parse(text).error || text; } catch (_) {} throw new Error('拿无损的那一帧没成功：' + (m || r.status)); });
        }
        return parseFrames(r).then(function (parsed) {
          for (var i = 0; i < parsed.items.length; i++) {
            if (parsed.items[i].i !== idx) continue;
            var u8 = parsed.items[i].bytes;
            // PNG 文件头核一下：万一拿到的不是无损 PNG，宁可报错也不送进 PS
            if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47)) throw new Error('引擎回的不是无损 PNG，这次不传');
            return u8;
          }
          throw new Error('引擎没回第 ' + idx + ' 帧');
        });
      });
  }

  // ⭐⭐ 点缩略图上的「应用」：把【这一张当前强度那一帧】贴回 PS，换掉原来那层。
  //   ⚠ 按钮在缩略图上（替掉原来的「替换」），所以这里按【参数】拿任务和那一张，
  //     不读大框的状态（大框可能根本没开）。
  //   ⚠⚠ 走宿主（ui.html 的 applyTweenToPS）去派活 —— 只有那边知道怎么调
  //     ps.layer.placeClipped、怎么改 psLayerByShot 对照表。本文件不许自己拼 PS 调用。
  //   ⚠ S-Q3：一次【只换一张】。
  //   ⭐ 2026-10-21 改（用户：「校色改动后可以直接点击应用，现在会被没调整强度的阀门拦住」）：
  //     换了校色方式后 shot.imgId 换成新的那一版 ⇒ 强度记录是按 imgId 记的，新版一定「没调过」，
  //     以前就被「先滚滚轮调好」挡住。现在没调过 = 把【当前这一版 100%】原样贴回去，换掉 PS 里那层。
  function applyShot(task, shotIndex, btn) {
    if (task && typeof root.taskById === 'function') {
      try { var live = root.taskById(task.taskId || task.id); if (live) task = live; } catch (_) {}
    }
    var shot = task && (task.shots || [])[shotIndex];
    if (!task || !shot || !shot.imgId) return;
    if (typeof root.applyTweenToPS !== 'function') {
      reportError('TWEEN_APPLY_UNAVAILABLE', '这个版本还没有接上「应用」的通道。', { severity: 'L2' });
      return;
    }
    var adjusted = strengthState[cacheKey(task, shot)] !== undefined;
    var rec = null, f = null, pct = 100;
    if (adjusted) {
      rec = cache[cacheKey(task, shot)];
      if (!rec || !rec.ready) { report('这张还没算好，等它算完再点', 'warn'); return; }
      pct = Math.round(currentStrength(task, shot) * 100);
      f = frameAt(rec, currentStrength(task, shot));
      if (!f) { report('这一档没有可用的图', 'warn'); return; }
    } else if (!root.IMG || typeof root.IMG.fullBytes !== 'function' || !root.IMG.has(shot.imgId)) {
      report('这张图已经不在内存里了，重新打开任务卡再点', 'warn'); return;
    }
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    var restore = function () { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label || '应用'; } };
    // ⭐⭐ 2026-10-09（docs/175）：贴回 PS 期间钉住这一组（同 frameBytesFor 里那段说明）。
    var pinKey = cacheKey(task, shot);
    pinSet(pinKey);
    Promise.resolve()
      .then(function () { return adjusted ? losslessFrameBytes(task, shot, rec, f) : root.IMG.fullBytes(shot.imgId).then(function (buf) { return new Uint8Array(buf); }); })
      .then(function (bytes) {
        if (!bytes) throw new Error('这一档没拿到能进 PS 的图');
        return root.applyTweenToPS(task, shotIndex, bytes, pct);
      })
      .then(function () { unpinSet(pinKey); restore(); report('第 ' + (shotIndex + 1) + ' 张已应用强度 ' + pct + '%', 'ok'); })
      .catch(function (err) {
        unpinSet(pinKey);
        restore();
        reportError('TWEEN_APPLY_FAILED', String((err && err.message) || err || '未知原因'), { severity: 'L2' });
      });
  }

    // ⭐⭐⭐ 2026-10-09 修（用户实测：「没有大图的时候，任务卡片详情收不回去」）
    //
    //   原来第一句是 `if (!box) return;` —— 大图没被创建过时这个函数【整个不执行】，
    //   连"通知详情收起"都发不出去。而没成品图时大图恰恰不会被创建
    //   （hoverTaskCard 里 firstReadyShot 为空就直接 return，不建大图）。
    //   ⇒ 详情就永远收不回去。
    //
    //   ⚠ 这个函数的职责【不只是收大图】，还有"收详情" ——
    //     不能让后者被前者的存在性挡住。这是本 bug 的根，别改回去。
    //
    //   ⚠ 实测对照（改之前）：
    //     无图/失败：大图开着=false → 移开后详情还在=true  ❌
    //     有图：      大图开着=true  → 移开后详情还在=false ✅
    function hideBox() {
      clearTimeout(hideTimer);
      // ⚠⚠ 先把"该通知谁"算出来，再碰任何 DOM 的 show 类 ——
      //   下面的 boxTaskId = null 必须在取 wasTask【之后】。
      var wasTask = boxTaskId;
      var notifyId = (wasTask != null) ? wasTask : boxTaskIdWas;
      if (box) {
        box.classList.remove('show');
        box.setAttribute('aria-hidden', 'true');
        // ⚠⚠ 这里【必须】清归属 —— 我试过保留（想让 stillInPreviewChain 找对卡），
        //   结果把用户那个真实场景弄坏了（只出条不点大图 → 移开 → 条不消失，
        //   连跑两次都挂，见 tmp/_cdp-strip-only.cjs）。
        //   原因：boxTaskId 留着旧值后，stillInPreviewChain() 里那个
        //     querySelector('.task[data-task="'+boxTaskId+'"]') 会命中的是
        //     【上一次那张卡】，用它来判"鼠标还在不在" ⇒ 判错。
        //   ⇒ **保持清空**。用户在意的那个场景优先。
        setBoxTask(null);
        boxShotIndex = -1;
        // ⚠ 2026-10-14：锚点也一起清 —— 它是一个 DOM 引用，
        //   而参考图卡的缩略图每次 render 都会整块重画（旧节点被扔掉）。
        //   不清的话下次判断"目标有没有变"会拿一个已经脱离文档的旧节点去比，
        //   结果是"明明换了目标却判成同一个，不重新贴位置"（静默失效，铁律 17）。
        boxAnchorEl = null;
        boxCustom = '';
        boxGeometry = null;
        // ⚠ 收框时把圆形把一起收掉（下次弹出时 showBox 会按新的那一张重新决定显不显示）
        setKnob(0, false);
        restoreMainCard();
      }
      // ⚠⚠⚠ 这一段【必须在大图存在与否之外】—— 它才是"详情跟着收"的唯一出口。
      //   2026-10-05 用户实测「我甚至能卡到预览窗口活着，小图标窗口死了」，
      //   当时加的补救就是它；但补救只挂在大图那条路上 ⇒ 没大图时又漏了。
      //   ⚠ 带任务 id 过去：用户快速划过两张卡时，不能把别人的预览条关掉。
      //
      //   ⭐⭐⭐ 2026-10-09 第三次修（用户报「为什么现在还是收缩不进去呢」）——
      //     我前两版都按"框在不在 / 这次有没有真收框"来决定要不要通知，
      //     **两次都错**。实测（真窗口、条卡住时手动调 leaveTaskCard(true)）：
      //       框已经关了 ⇒ 判据为假 ⇒ 整段跳过 ⇒ 条永远收不掉。
      //     ⇒ 根因是**框和条是两条命**：
      //       条可能是被别的原因打开的（点缩略图、悬停），那时框早就关了，
      //       但条还开着 —— 而"收条"唯一的出口就是这次通知。
      //     ⚠⚠⚠ 判据就是【原版这一条】，我加了 `didHide` 反而弄坏了它。
      //       原版：只要知道归属，收框时就通知 —— **不问"框在不在"**。
      //       为什么不能问：用户完全可能【只右滑出预览条、不点开大图】。
      //         那种情况下框从来没开过 ⇒ didHide 恒为假 ⇒ 通知永远发不出去
      //         ⇒ **条赖着不消失**。
      //         用户 2026-10-09 原话：「只有带着展开的大图移出去才消失，
      //         如果不点展开大图移出去、只有缩略图条的话，它是不消失的」
      //         —— 说的就是这个 `didHide`。
      //       ⇒ 这一条是"收条的唯一出口"，**只要知道该收谁的，就必须发**。
      //         框在不在根本不改变"条该不该收"—— 两件事不能绑在一起。
      //     ⚠ 我试过的错方向（都挂了探针，别再试）：无条件通知 / 时间窗 /
      //       !boxWasOpen 兜底 ⇒ 见本文件 hideBox 上方与 docs/191 的记录。
      //       正解就是下面这样：**有归属就通知，不附加任何框的状态条件**。
      if (notifyId != null && typeof onBoxClosed === 'function') {
        try { onBoxClosed(String(notifyId)); }
        catch (_) { /* 通知失败不能影响收框 */ }
      }
    }

  // 框被收掉时的回调（ui.html 注册进来，用于同步收掉预览条）。
  // ⚠ 用回调而不是让这里直接去 querySelector('.task-preview') ——
  //   那个元素归 ui.html 管，从这边伸手过去会把"谁拥有哪个 DOM"搅浑，
  //   下一次改 ui.html 的结构这里就静默失效了（铁律 17）。
  var onBoxClosed = null;
  function setBoxClosedHandler(fn) { onBoxClosed = typeof fn === 'function' ? fn : null; }

  // ══════════════════════════════════════════════════════════
  //  独立显示：给记录卡 / 参考图这类「没有任务卡可挂」的地方用
  //  （替代原来的独立大图窗口 viewer-window.html，docs/132 §三）
  // ══════════════════════════════════════════════════════════
  //
  // ⚠ 几何还是实时算：优先贴着触发它的那个元素（比如记录卡里那张图），
  //   拿不到就居中显示一块大的。**不写死像素**（同 §2.1 的硬规矩）。
  //
  // 参考图菜单即使没展开，也按滑入结束后的布局量，避免大图偏左 24px。
  function previewLayoutRect(pv) {
    var r = pv.getBoundingClientRect();
    var transform = root.getComputedStyle(pv).transform;
    var matrix = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform) : null;
    var dx = matrix ? matrix.m41 * (r.width / (pv.offsetWidth || r.width)) : 0;
    var dy = matrix ? matrix.m42 * (r.height / (pv.offsetHeight || r.height)) : 0;
    return {left:r.left-dx, right:r.right-dx, top:r.top-dy, bottom:r.bottom-dy, width:r.width, height:r.height};
  }
  // previewEl 复用任务大图；width/height/side 保留给已有独立看图调用。
  function geometryNear(anchorEl, custom) {
    if (custom && custom.previewEl && custom.previewEl.isConnected) {
      return geometryFor(anchorEl, custom.previewEl, previewLayoutRect(custom.previewEl));
    }
    var vw = root.innerWidth || 1020, vh = root.innerHeight || 900;
    if (anchorEl && anchorEl.getBoundingClientRect && custom && custom.width) {
      var ar = anchorEl.getBoundingClientRect();
      var cw = Math.max(160, Math.min(vw - 32, Math.round(custom.width)));
      var ch = Math.max(120, Math.min(vh - 32, Math.round(custom.height || cw)));
      // side: 'right' 摆右边（默认） / 'left' 摆左边 / 'above' 摆上方（左右对齐）
      var side = custom.side || 'right';
      var cl, ct;
      if (side === 'above') {
        cl = Math.round(ar.left);
        ct = Math.round(ar.top - ch - 12);
      } else if (side === 'left') {
        cl = Math.round(ar.left - cw - 12);
        ct = Math.round(ar.top + ar.height / 2 - ch / 2);
      } else {
        cl = Math.round(ar.right + 12);
        ct = Math.round(ar.top + ar.height / 2 - ch / 2);
      }
      // 保留已有独立看图的视口保护；参考图走上面的 previewEl 分支。
      cl = Math.max(16, Math.min(vw - cw - 16, cl));
      ct = Math.max(16, Math.min(vh - ch - 16, ct));
      var overlapsX = !(cl + cw <= ar.left || cl >= ar.right);
      var overlapsY = !(ct + ch <= ar.top || ct >= ar.bottom);
      if (overlapsX && overlapsY) {
        cl = Math.round(ar.left);
        ct = Math.round(ar.top - ch - 12);
        cl = Math.max(16, Math.min(vw - cw - 16, cl));
        ct = Math.max(16, Math.min(vh - ch - 16, ct));
      }
      return { left: cl, top: ct, width: cw, height: ch };
    }
    if (anchorEl && anchorEl.getBoundingClientRect) {
      var r = anchorEl.getBoundingClientRect();
      var width = Math.max(320, Math.min(vw - 48, Math.round(vw * 0.62)));
      var height = Math.max(240, Math.min(vh - 96, Math.round(vh * 0.72)));
      var left = Math.max(16, Math.min(vw - width - 16, Math.round(r.left + r.width / 2 - width / 2)));
      var top = Math.max(16, Math.min(vh - height - 16, Math.round(r.top + r.height / 2 - height / 2)));
      return { left: left, top: top, width: width, height: height };
    }
    var w2 = Math.round(vw * 0.66), h2 = Math.round(vh * 0.76);
    return { left: Math.round((vw - w2) / 2), top: Math.round((vh - h2) / 2), width: w2, height: h2 };
  }

  // url 可以是 blob:/data: 地址，也可以是 ArrayBuffer/Uint8Array（会自动转 URL）
  //
  // 参考图用整张卡认领大图、用自己的右划面板定位；连续切图保持位置。
  // 记录卡等旧入口可以继续省略 anchorEl / custom。
  var boxAnchorEl = null;
  // custom 支持 {previewEl} 共用任务几何，或已有的 {width,height,side}。
  //   ⚠ custom 变了也要重贴 —— 同 width 不同 side 是两种摆法。
  var boxCustom = null;
  var boxGeometry = null;
  function showImage(source, anchorEl, custom) {
    ensureBox();
    clearTimeout(hideTimer);
    var url = source;
    var madeHere = false;
    if (source && (source instanceof Uint8Array || source instanceof ArrayBuffer)) {
      url = toUrl(source);
      madeHere = true;
    }
    if (!url) return;
    // ⚠⚠⚠ 2026-10-05 用户："我现在点击任务卡片右滑弹出的选择图像缩略图的里面的一张图
    //   之后，会导致我的预览图像的窗口变位置。并且我也没有办法点到调整强度之后的替换按钮。"
    //
    //   真因：这里原来【无条件】按 anchorEl（被点的那一格缩略图）重算几何 ——
    //   而任务卡弹出的那条路走的是 positionBox(taskEl, pv)（按卡片堆算的固定几何）。
    //   **同一时刻存在两套算法**，所以一点图，框就往你点的那一格跳过去。
    //
    //   ⚠ 这同时是"点不到「替换」"的根：框宽是视口的 62%、还要以那一格为中心，
    //     必然盖住缩略图那一排 —— 而「替换/增益」正好挂在格子底部，
    //     它们的 z-index 又低于框（框是 10050），于是点不到。
    //
    //   ⇒ 框【已经开着】时不再重算位置，只换图 ——
    //     "框指向哪一块"归 showBox / retarget 管（它们才知道任务卡那套几何）。
    //
    //   换到另一张卡或另一块面板时重新定位；同卡换图只更新图片。
    var alreadyOpen = !!(box && box.classList.contains('show'));
    var targetChanged = !!anchorEl && anchorEl !== boxAnchorEl;
    // ⚠ custom 也要参与"变没变"的判断：同一个锚点、换了摆法（比如 side 从 right 变 above）
    //   也得重贴。用 width+height+side 拼一个指纹比，最省事也最不容易漏字段。
    var customSig = custom ? (custom.previewEl ? 'preview' : custom.width + 'x' + custom.height + '/' + (custom.side || 'right')) : '';
    var customChanged = customSig !== (boxCustom || '') ||
      (custom && custom.previewEl) !== (boxGeometry && boxGeometry.previewEl);
    if (!alreadyOpen || targetChanged || customChanged) {
      var g = geometryNear(anchorEl, custom);
      box.style.left = g.left + 'px';
      box.style.top = g.top + 'px';
      box.style.width = g.width + 'px';
      box.style.height = g.height + 'px';
    }
    // ⚠ 传了 anchor 就记下来 —— 下次判断"是不是换了目标"全靠它。
    //   没传（老调用点）就清空，免得拿一个失效的引用去比。
    boxAnchorEl = anchorEl || null;
    boxCustom = customSig;
    boxGeometry = custom || null;
    // 参考图复用任务卡的主面板让位；连续切图保留之前的恢复状态。
    if (custom && custom.previewEl && (!yieldState || mainCardsOpen())) yieldMainCard();

    var img = box.querySelector('.tween-box-img');
    var prev = img.dataset.ownedUrl;
    img.src = url;
    img.style.display = '';
    img.dataset.ownedUrl = madeHere ? url : '';
    if (prev && prev !== url) { try { URL.revokeObjectURL(prev); } catch (_) {} }
    box.querySelector('.tween-box-loading').style.display = 'none';
    setBoxTask('__standalone__');
    box.classList.add('show');
    box.setAttribute('aria-hidden', 'false');
    if (custom && custom.previewEl && mainCardsOpen()) { concedeToMainCards(); return; }
    resetView();
    // ⚠ 独立大图（记录卡/参考图）没有强度这回事 → 圆形把必须收掉。
    //   不收的话会留着【上一张】的百分比，看着像这张被调过（假信息）。
    setKnob(0, false);
  }

  function isShowing() {
    return !!(box && box.classList.contains('show'));
  }

  // ⭐⭐ 2026-10-04 新增：切换任务卡时【重新指向】新任务（用户实测报的 bug）
  //
  //   他原话：「我在切换任务卡片的这个过程当中…选中缩略图之后弹出的那个框，
  //     **它不消失或者更新不及时**。」
  //
  //   真因：大框的"归属"（boxTaskId）**只在预览条第一次弹出那一下**被设定
  //     （ui.html:6919-6928 那段包在 `if(!pvOpen)` 里）。
  //     而滚轮切任务卡走的是【另一条路】`followPreview()`（ui.html:7283），
  //     那条路里 **一次都没碰过 V7Tween**（grep 过，0 处）。
  //   ⇒ 换了任务，boxTaskId 还指着旧的 → hoverThumb 第一行就 return
  //     → 缩略图滚不动、框里还是旧图、位置也不更新，
  //     一直要等鼠标离开整个连通区才被 leaveTaskCard() 收掉。
  //
  //   ⚠ 这个函数**只在框已经开着时**才动它。
  //     框没开就不该弹出来 —— 用户滚的是"任务卡"，不是"要把预览框调出来"。
  //     （`followPreview` 是"跟随"，不是"重新弹出"。）
  //   ⚠ 也不能走 hoverTaskCard()：那个会 yieldMainCard() 去收二级/三级面板，
  //     滚一下任务就收一次面板 = 用户正看着的二级卡被踹掉。
  function retarget(taskEl, task) {
    if (!box || !box.classList.contains('show')) return false;
    if (!taskEl || !task) return false;
    var shot = firstReadyShot(task);
    if (!shot) return false;

    var pv = taskEl.querySelector('.task-preview.show') || taskEl.querySelector('.task-preview');
    if (!pv) return false;

    // 换归属 + 重新贴几何（新任务卡的位置/预览条宽度都可能不一样）
    setBoxTask(task.id);
    boxShotIndex = shotIndexOf(task, shot);
    positionBox(taskEl, pv);
    scheduleReposition(taskEl, pv);

    // 换图：有算好的帧就用帧，没有就显示这张图本身（跟 hoverThumb 一个规矩）
    var img = box.querySelector('.tween-box-img');
    var loading = box.querySelector('.tween-box-loading');
    if (!img) return true;
    var url = currentFrameUrl(task, shot);
    if (url) {
      img.src = url; img.style.display = ''; resetView();
      if (loading) loading.style.display = 'none';
    } else {
      if (loading) loading.style.display = 'none';
      // ⭐ 2026-10-19（用户定：滚滚轮才开算）：换任务卡只换图，不开算
      showShotImage(img, task, shot, boxShotIndex);
    }
    return true;
  }

  function attachTo(anchorEl) {
    ensureBox();
    clearTimeout(hideTimer);
    var g = geometryNear(anchorEl);
    box.style.left = g.left + 'px';
    box.style.top = g.top + 'px';
    box.style.width = g.width + 'px';
    box.style.height = g.height + 'px';
  }

  // 悬停任务卡 → 弹；离开 → 收（留一点延迟，免得从卡移到框上时闪一下）
  function hoverTaskCard(taskEl, task) {
    if (!taskEl || !task) return;
    clearTimeout(hideTimer);
    // ⭐⭐⭐ 2026-10-09 修（用户实测：「没有大图的时候，任务卡片详情收不回去」）：
    //   【光改 hideBox 还不够】—— 没有成品图时 showBox() 根本不会被调用，
    //   而 boxTaskId 只在 showBox() 里赋值 ⇒ 它一直是 null
    //   ⇒ hideBox 里 `if (wasTask != null)` 那道闸门也过不去，通知照样发不出去。
    //   ⇒ 详情栏既然为这个任务展开了，就得**先认下它是谁的**，
    //     这样收尾时才知道该去收哪一条（而且不会误收别人的）。
    //   ⚠ 这一步与"弹不弹大图"无关 —— 详情栏的归属不该依赖大图存在。
    setBoxTask(task.id);
    var shot = firstReadyShot(task);
    // ⚠ 没有成品图 → 只展开详情栏，不建大图。
    //   这【不是错误】：生成中/失败的单子本来就没图可看。
    //   但详情栏该收的时候还是要收（见上面 boxTaskId 那一段）。
    if (!shot) return;
    var url = currentFrameUrl(task, shot);
    // ⚠ 2026-10-03 晚：原来传的是 `shot.index`（不存在的字段）→ boxShotIndex 永远是
    //   undefined。改成真实位置（见上面 hoverThumb 里那段说明）。
    // ⭐⭐ 2026-10-19（docs/249，用户定：「要滚动滚轮才开始」）：框弹出来【不开算】，显示这张图本身；
    //   原来一弹出就后台开算（每单十几 MB 上传）—— 只是路过任务卡也会开单，把真正要调的那张挤到后面。
    var idx0 = shotIndexOf(task, shot);
    showBox(taskEl, task, idx0, url || ((root.IMG && shot.imgId) ? root.IMG.thumb(shot.imgId) : ''), false);
    if (!url) {
      var img0 = box && box.querySelector('.tween-box-img');
      if (img0) showShotImage(img0, task, shot, idx0);
    }
  }

  function hoverThumb(cell, task, shot) {
    if (!box || String(boxTaskId) !== String(task.id)) return;
    // ⚠⚠ 2026-10-03 晚：这里原来写的是 `shot.index` —— 【真实 shot 对象没有 index 字段】
    //   （那个字段只在 ui.html 的 buildPreview 里临时 Object.assign 出来，没写回 task.shots）。
    //   同 docs/134 第 ③ 条那批坑：按印象写了个不存在的字段，一句错都不报。
    //   ⇒ 改成按【位置】算，真的落在 task.shots 里的第几张才是权威。
    var idx = shotIndexOf(task, shot);
    boxShotIndex = idx;
    var img = box.querySelector('.tween-box-img');
    if (!img) return;
    // ⚠⚠ 2026-10-05：换到另一张图时，强度滑条【必须跟着这一张重算】。
    //   原来只在框第一次弹出时（showBox）按【第一张图】判一次，之后悬停/点别的图都不刷新。
    //   ⚠ S-Q4（用户定）：每张图【各记各的强度】，所以滑条也要按这一张取值。
    setKnob(currentStrength(task, shot), strengthState[cacheKey(task, shot)] !== undefined);
    var url = currentFrameUrl(task, shot);   // 过渡帧算好了就用那一帧（跟着强度走）
    if (url) { img.src = url; img.style.display = ''; resetView(); setBoxBusy(false); return; }
    // ⭐⭐ 2026-10-19（docs/249，用户定：「要滚动滚轮才开始」）：悬停 / 换到这张【只换图，不开算】。
    //   原来悬停就开一单（每单要传十几 MB）：鼠标从一排缩略图上划过 = 开好几单，把真正要看的那张挤到后面。
    //   现在显示这张图本身（先缩略图顶上，原图到了换清晰的）；用户在上面滚滚轮才开算。
    //   ⚠ 例外：这张【以前调过强度】、帧被淘汰了 —— 那是用户已经表过态的，补算一次，免得框里显示的强度跟滑条对不上。
    //     但要【停在这张 0.45 秒】才补：鼠标只是划过去的不算（不然划过一排调过的图又是好几单）。
    showShotImage(img, task, shot, idx);
    clearTimeout(restoreTimer);
    if (strengthState[cacheKey(task, shot)] !== undefined) {
      setBoxBusy(true);
      restoreTimer = setTimeout(function () {
        if (!box || !box.classList.contains('show')) return;
        if (String(boxTaskId) !== String(task.id) || boxShotIndex !== idx) return;
        computeReady(task, shot).then(function (rec) {
          if (!box || !box.classList.contains('show')) return;
          if (String(boxTaskId) !== String(task.id) || boxShotIndex !== idx) return;
          setBoxBusy(false);
          var f = frameAt(rec, currentStrength(task, shot));
          if (f) { img.src = f.url; img.style.display = ''; }
        }).catch(function () { if (boxShotIndex === idx) setBoxBusy(false); });
      }, 450);
    } else setBoxBusy(false);
  }
  var restoreTimer = null;
  // 框里显示这张图本身：先拿缩略图顶上，原图读到了换成清晰的（还停在这张才换）
  function showShotImage(img, task, shot, idx) {
    var local = (root.IMG && shot && shot.imgId) ? root.IMG.thumb(shot.imgId) : '';
    if (local) { img.src = local; img.style.display = ''; resetView(); }
    if (root.IMG && shot && shot.imgId && typeof root.IMG.fullUrl === 'function') {
      root.IMG.fullUrl(shot.imgId).then(function (u) {
        if (!u || !box || String(boxTaskId) !== String(task.id) || boxShotIndex !== idx) return;
        if (currentFrameUrl(task, shot)) return;   // 这期间帧算好了，帧优先
        img.src = u; img.style.display = '';
      }, function () {});
    }
  }

  // ⭐⭐ 2026-10-05：任务卡里【点缩略图】专用的入口。
  //
  //   用户实测（修了一轮还在）：「点击缩略图还是会出现一个歪的大图框」+「应用按钮没出现」。
  //   真因：ui.html 点缩略图时调的是 attachTo(格子) + showImage(…, 格子) ——
  //     · attachTo 【无条件】按被点的那一格重算框的位置 → 框跳到格子上 = "歪"
  //       （上一轮我只在 showImage 里加了"框开着就不动"，可框早在前一行就被 attachTo 挪走了，等于没修）
  //     · showImage 是给【记录卡 / 参考图】的"独立看图"用的，它把 boxTaskId 设成 '__standalone__'，
  //       从这一刻起框就不认这个任务了 → 滚轮调不了强度、「应用」条也不会出现
  //   ⇒ 任务卡里的点击走【任务卡自己那套】：
  //     · 框已经开着、且就是这个任务 → 原地换图（hoverThumb），位置一个像素都不动
  //     · 框没开 → 按任务卡的几何弹出（showBox → positionBox），跟悬停任务卡弹出来的一模一样
  //   两条路都【不看被点的那一格在哪】—— 位置只由任务卡 + 预览条决定。
  function openShot(taskEl, task, shot) {
    if (!taskEl || !task || !shot) return false;
    var idx = shotIndexOf(task, shot);
    if (idx < 0) return false;
    ensureBox();
    clearTimeout(hideTimer);
    if (box.classList.contains('show') && String(boxTaskId) === String(task.id)) {
      hoverThumb(null, task, shot);
      return true;
    }
    var url = currentFrameUrl(task, shot)
      || ((root.IMG && shot.imgId) ? root.IMG.thumb(shot.imgId) : '');
    showBox(taskEl, task, idx, url, !url);
    // showBox 只放了一张静态图；剩下的（后台算过渡帧、刷「应用」条和滑条）交给 hoverThumb
    hoverThumb(null, task, shot);
    return true;
  }

  // 这张 shot 在 task.shots 里的位置（-1 = 不在里面）
  function shotIndexOf(task, shot) {
    var list = (task && task.shots) || [];
    return list.indexOf(shot);
  }

  function leaveTaskCard(force) {
    clearTimeout(hideTimer);
    // ⚠ 2026-10-03 晚：收之前先看鼠标真在哪 —— 从预览条往上移到框里、
    //   或者从框里往回拉到预览条上，都【不算离开】，两块都留着。
    //   真移出去才两块一起收（用户原话，见上面那段）。
    //
    // ⚠⚠⚠ 2026-10-05 修（用户实测：「鼠标快速移走之后，生成卡片还觉得鼠标在上面，
    //   并且预览图也还在」）：
    //   上面的 stillInPreviewChain 用的是【最后一次收到的 mousemove 坐标】。
    //   鼠标【快速移出窗口】时，之后不会再有 mousemove 了 —— lastMX/lastMY 就
    //   永远停在"还在卡里"的那一点上 ⇒ 这道判断恒为真 ⇒ 框永远不收。
    //   这正是用户说的"卡片还觉得鼠标在上面"（陈旧命中测试，铁律 29 那个坑的同一形状）。
    //   ⇒ 两个补丁：
    //     ① force=true 时【不查坐标】直接收（调用方已经自己判过"该收了"）
    //     ② pointerAway：指针离开窗口时立刻置位，让坐标判断失效
    if (force) { hideBox(); return; }
    if (pointerAway) { hideBox(); return; }
    hideTimer = setTimeout(function () {
      if (pointerAway) { hideBox(); return; }
      if (stillInPreviewChain(lastMX, lastMY)) return;
      hideBox();
    }, 160);
  }

  // 参考图只管理自己认领的框，不能把后来打开的任务大图收掉。
  function holdImage(anchorEl) {
    if (boxTaskId === '__standalone__' && boxAnchorEl === anchorEl) clearTimeout(hideTimer);
  }
  function leaveImage(anchorEl, force) {
    if (boxTaskId === '__standalone__' && boxAnchorEl === anchorEl) leaveTaskCard(force);
  }
  function imageChainHit(anchorEl) {
    return !pointerAway && boxTaskId === '__standalone__' && boxAnchorEl === anchorEl &&
      box && box.classList.contains('show') && stillInPreviewChain(lastMX, lastMY);
  }

  // 指针是不是已经不在窗口里了。
  // ⚠ 必须有这个：mouseleave 之后 mousemove 不再触发，任何"看最后坐标"的判断
  //   都会用陈旧数据（见过太多次了 —— 记忆里那条"滚轮监听别挂会隐藏的元素"
  //   是同一个坑的另一种表现）。
  var pointerAway = false;

  // 只收【属于这个任务】的框。
  // ⚠ 给 ui.html 用：它收预览条时知道自己收的是哪一张任务卡，
  //   而框可能已经指向别的任务（用户快速划过两张卡）—— 不判归属就会把别人的框关掉。
  // ⭐ 10-25：任务卡「分割」框要摆在大预览框的位置（segment-panel.js）。预览条没弹出来就回 null，由调用方自己找地方。
  function geometryForTask(taskEl) {
    if (!taskEl) return null;
    var pv = taskEl.querySelector('.task-preview.show');
    if (!pv) return null;
    var strip = pv.querySelector('.pv-strip') || pv, r = strip.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return geometryFor(taskEl, pv);
  }

  // ⭐ 10-26：取消「鼠标刚移开、160ms 后收框收条」那个计时（分割框打开时用：鼠标移到按钮上那一下已经排了收条，
  //   框一开、归属一登记，计时一到就把刚弹出的缩略图条收掉 —— 真机实测抓到的）
  function cancelPendingHide() { clearTimeout(hideTimer); }

  // 大预览框现在显示的是这一单的第几张（没开 / 不是这一单 → -1）
  function boxShotOf(task) {
    if (!task || !box || !box.classList.contains('show') || boxTaskId == null || String(boxTaskId) !== String(task.id)) return -1;
    return boxShotIndex;
  }

  function hideBoxIfTask(taskId) {
    if (!box) return;
    if (boxTaskId != null && String(boxTaskId) !== String(taskId)) return;
    clearTimeout(hideTimer);
    hideBox();
  }

  function firstReadyShot(task) {
    var shots = task.shots || [];
    for (var i = 0; i < shots.length; i++) {
      if (shots[i] && shots[i].done && shots[i].imgId) return shots[i];
    }
    return null;
  }

  // ── 缩放 / 平移 / 双击复位（从 viewer-window.html 照着重接，不复制粘贴）──
  function applyView() {
    if (!box) return;
    var img = box.querySelector('.tween-box-img');
    if (!img) return;
    img.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  }
  function resetView() { zoom = 1; panX = 0; panY = 0; applyView(); }

  function bindBoxInteractions(el) {
    // ⚠ 挂在自己的框上（它不是会隐藏的滚动目标，是这个框本身）；
    //   离开框就收，所以用 mouseenter/mouseleave 而不是 window 捕获。
    //
    // ⚠⚠ 2026-10-03 晚分工改了（用户实测报的「大图也要有反应」）：
    //   以前：滚轮 = 缩放。但框上那行提示写的是"滚轮调强度" —— 说一套做一套。
    //   现在对齐【全项目统一的那套约定】（跟老的大图窗口一致）：
    //     滚轮          = 调强度（主操作，跟缩略图上是同一个动作）
    //     Ctrl/⌘ + 滚轮 = 缩放
    //     拖动          = 平移
    //     双击          = 复位
    //   ⇒ 提示行也一起改了，见 ensureBox 里那句。
    el.addEventListener('wheel', function (e) {
      var img = el.querySelector('.tween-box-img');
      if (!img || img.style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        // ── 缩放（老习惯保留，只是挪到 Ctrl 上）──
        var factor = e.deltaY > 0 ? 0.88 : 1.14;
        zoom = Math.max(0.2, Math.min(12, zoom * factor));
        applyView();
        return;
      }

      // ── 调强度（跟缩略图上走【同一个核心】，不许在这儿另写一套增量）──
      var t = boxTask(), shot = boxShot();
      if (!t || !shot) return;
      strengthWheel(t, shot, cellOfShot(t, shot), e.deltaY);
    }, { passive: false });

    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = { x: e.clientX, y: e.clientY, px: panX, py: panY, moved: false };
    });

    el.addEventListener('dblclick', function (e) {
      e.preventDefault();
      resetView();
    });

    el.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    el.addEventListener('mouseleave', function () { leaveTaskCard(); });

  }

  // ⚠⚠ 2026-10-03 晚：用户实测「鼠标移到预览框上，框直接消失」。
  //   真因不是这个模块 —— 是 ui.html 那个全局 mousemove 判定：
  //   它只要看到鼠标不在【任务卡 + 预览条】这个连通区里，就把预览条收了，
  //   顺手把大预览框也收了。而大预览框在【预览条正上方】，本来就不在连通区里
  //   → 鼠标往上移必然被判成"离开" → 框消失。用户根本来不及缩放。
  //   ⇒ 两处一起改：
  //     ① here：收之前先确认鼠标是不是还在【框 / 任务卡 / 预览条】这一整块里
  //     ② ui.html 的 inConnected('task')：把大预览框的矩形也算进连通区
  //   用户要的规矩（原话）：「往回拉到选择图的框上，选择框还留着；
  //   移出去，才跟着一起收。」
  var lastMX = -1, lastMY = -1;
  root.addEventListener('mousemove', function (e) {
    lastMX = e.clientX; lastMY = e.clientY;
    pointerAway = false;                 // 指针回来了 → 坐标重新可信
    // 参考图的通道不属于卡、菜单或大图，离开通道不会产生它们的 mouseleave。
    // 在现有全局监听里收尾，避免在通道停留后再移走时框一直挂着。
    if (boxTaskId === '__standalone__' && boxAnchorEl && box && box.classList.contains('show')) {
      if (stillInPreviewChain(lastMX, lastMY)) clearTimeout(hideTimer);
      else leaveTaskCard();
    }
  }, true);

  // ⚠⚠ 指针离开窗口 → 把坐标判断【作废】。
  //   鼠标快速甩出去时，浏览器不会再发 mousemove，于是 lastMX/lastMY 停在
  //   "还在卡里"那一点上，任何看坐标的判断都会一直为真 → 框收不掉。
  //   ⇒ pointerAway 一置位，leaveTaskCard 就不再信任坐标，直接收。
  //
  // ⚠⚠⚠ 2026-10-06 修（用户实测：「标准模式下弹出快速闪回，自由模式下正常」）。
  //   这是我 10-05 亲手造出来的回归，两次都没修对，教训写在这里：
  //
  //   【第一版】用 window 的 mouseout + `if (e.relatedTarget) return;`，
  //     潜台词是"relatedTarget 为 null = 出了窗口"。**这是错的** ——
  //     relatedTarget 为 null 有两种情况：
  //       ① 指针真的移出了窗口（我要的那个）
  //       ② **指针底下的元素被从 DOM 里删掉了**（浏览器找不到"移到哪去了"）
  //     而标准模式下 showBox 会调 yieldMainCard() → root.closeAll() 去收二级/三级面板
  //     —— 那正好是在鼠标底下删 DOM → 触发 ② → 立刻 hideBox()
  //     → hideBox 又通过 onBoxClosed 把下面的预览条一起收了 → **弹出即闪回**。
  //     自由模式下二级面板本来就没开，closeAll() 不动作，所以那个模式看着是好的。
  //
  //   【第二版】改成看坐标贴不贴边（clientX<=1 之类）。**还是错** ——
  //     元素被删时合成出来的 mouseout，坐标本身也可能是 0/空的，
  //     于是照样命中"贴边=出窗口"，一模一样地误判。
  //
  //   【现在】不再猜事件的语义，直接用【元素级 mouseleave】：
  //     documentElement 的 mouseleave 只在【指针真的离开整个文档】时触发，
  //     DOM 怎么增删都不会让它误报。这是这一整类问题里唯一可靠的信号。
  //   ⚠ 不用 window 的 mouseout / blur：这两个的触发条件里都混着
  //     "DOM 变了""焦点变了"这些跟指针无关的原因，拿它们当"鼠标走了"用必然误伤。
  //     （教训：判断"指针在哪"只认指针自己的事件，别拿旁路事件代替。）
  if (document.documentElement) {
    document.documentElement.addEventListener('mouseleave', function () {
      pointerAway = true;
      if (box && box.classList.contains('show')) hideBox();
    });
  }

  function pointInEl(mx, my, el, pad) {
    if (!el || mx < 0 || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var p = pad || 0;
    return mx >= r.left - p && mx <= r.right + p && my >= r.top - p && my <= r.bottom + p;
  }

  // 大预览框在不在指针下（给 ui.html 的连通区判定用）
  function boxHit(mx, my) {
    return !!(box && box.classList.contains('show') && pointInEl(mx, my, box, 4));
  }

  // 两个矩形之间那条【横向缝隙】算不算"还在链上"。
  //   ⚠⚠⚠ 2026-10-06：这就是"标准模式右滑必闪、自由模式正常"的根。
  //
  //   几何（标准模式，实测）：任务卡右缘 = 卡左缘+300，预览条内联/样式 left:340
  //     （.task 有 1px 边框 + 15px padding，所以条的实际左缘 = 卡左缘 + 341）
  //     ⇒ 卡↔条之间有【41px 的缝】。
  //   下面那两行各自带 6px 容差：卡认到 +306 为止、条从 +335 才开始
  //     ⇒ **306~335 这 29px 谁都不认** = 死区。
  //   谁会踩进去：scheduleReposition 在 60/140/260/420ms 把框左缘从 317 挪到 341
  //     （预览条 pop 时 translateX(-24px)，见 geometryFor 那段说明）。
  //     鼠标停在 317~341 这条带里 → 框右移、鼠标露在框外 → 框自己的 mouseleave
  //     → leaveTaskCard() → 160ms 后这次判断正好落在死区 → hideBox()
  //     → onBoxClosed 把预览条一起收掉 → 下一次 mousemove 又满足弹出条件 = **闪回**。
  //   为什么自由模式不犯：free-mode-ui.js 把条的 left 按屏宽夹成 min(340, 屏宽-48-x)，
  //     任务堆默认贴右（x=屏宽-332）⇒ 夹出来是 284 < 300 ⇒ **条压在卡身上，根本没有缝**。
  //
  //   ⇒ 这条缝只要【高度上重叠】就算连通 —— 正是 freeNavigationBridgeHit
  //     (ui.html 的 navigationGapHit) 对卡↔条做的事，只是那边被
  //     `isActive()`（自由模式）挡住了，标准模式用不上。这里补上，两种模式一致。
  //   ⚠ 必须带上【高度重叠】这一条：否则整条水平带（包括卡上方的空白）都算连通，
  //     鼠标从卡正上方划过去时框就收不掉了。
  function corridorHit(mx, my, a, b) {
    if (!a || !b) return false;
    var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    if (!ar.width || !ar.height || !br.width || !br.height) return false;
    var lo = Math.min(ar.right, br.right), hi = Math.max(ar.left, br.left);
    if (hi <= lo) return false;                       // 两边已经叠上了，没有缝
    var top = Math.max(ar.top, br.top), bottom = Math.min(ar.bottom, br.bottom);
    if (bottom <= top) return false;                  // 高度不重叠 → 不是走廊
    var pad = 6;
    return mx >= lo - pad && mx <= hi + pad && my >= top - pad && my <= bottom + pad;
  }

  // 框 ∪ 条 的并集区（带容差）—— 2026-10-06 补。
  //
  // ⚠⚠⚠ 为什么还要这一段：corridorHit 只认"两个矩形【竖向重叠】时中间那条横向缝"，
  //   而下面两个残区它一个都盖不住（这正是"标准模式推右弹出后还会闪回"的最后一环）：
  //     ① 框↔条之间的【纵向缝】（框底到条顶约 17px，两矩形竖向不重叠 →
  //        corridorHit 的 `bottom <= top` 恒真 → 永远返回 false）；
  //     ② 框左缘那条【竖列】：scheduleReposition 在 60/140/260/420ms 把框左缘
  //        从偏左 24px 修正到位，而这条竖列在【任务卡高度以上】，y 不在卡/条带内，
  //        corridorHit 同样不成立。指针从触发带往右上移去够框时必然穿这里。
  //   在这两处一旦停留超过 160ms（或框从指针底下挪走触发框自己的 mouseleave），
  //   leaveTaskCard 的延迟复查就会判"已离开" → hideBox → onBoxClosed 把预览条
  //   一起收掉 → 下一帧 mousemove 又重新弹出 = 闪回。
  //   ⇒ 用【框和条两块的并集矩形】来兜：并集从框顶一直到条底，
  //     纵向缝天然被包含；左 pad 取 40（实测卡右缘+6 到条左缘-6 约 29px 宽）。
  //   ⚠ 只在框真的开着时生效；框被二级卡挤掉后（watchMainCards）不参与判定。
  function junctionHit(mx, my, previewEl) {
    if (!box || !box.classList.contains('show')) return false;
    var pv = previewEl;
    if (!pv) {
      var el = document.querySelector('.task[data-task="' + boxTaskId + '"]') ||
               document.querySelector('.task');
      pv = el && el.querySelector('.task-preview.show');
    }
    if (!pv) return false;
    var br = box.getBoundingClientRect(), pr = pv.getBoundingClientRect();
    if (!br.width || !br.height || !pr.width || !pr.height) return false;
    var left = Math.min(br.left, pr.left) - 40;
    var right = Math.max(br.right, pr.right) + 8;
    var top = Math.min(br.top, pr.top) - 8;
    var bottom = Math.max(br.bottom, pr.bottom) + 24;
    return mx >= left && mx <= right && my >= top && my <= bottom;
  }

  // 鼠标是不是还在【框 / 任务卡 / 预览条】这一整块里
  function stillInPreviewChain(mx, my) {
    if (mx < 0) return false;
    if (boxHit(mx, my)) return true;
    if (boxTaskId === '__standalone__') {
      if (!boxAnchorEl || !boxAnchorEl.isConnected) return false;
      if (pointInEl(mx, my, boxAnchorEl, 6)) return true;
      var previewEl = boxGeometry && boxGeometry.previewEl;
      if (previewEl && previewEl.isConnected) {
        if (previewEl.classList.contains('show') && pointInEl(mx, my, previewEl, 6)) return true;
        if (junctionHit(mx, my, previewEl)) return true;
        if (corridorHit(mx, my, boxAnchorEl, previewEl)) return true;
      }
      if (corridorHit(mx, my, boxAnchorEl, box)) return true;
      // 窄窗口摆在卡上方时，保留卡↔框之间的纵向缝；与任务卡的连通区规则一致。
      var ar = boxAnchorEl.getBoundingClientRect(), br = box.getBoundingClientRect();
      var left = Math.max(ar.left, br.left), right = Math.min(ar.right, br.right);
      var top = Math.min(ar.bottom, br.bottom), bottom = Math.max(ar.top, br.top);
      return right > left && bottom > top && mx >= left - 6 && mx <= right + 6 && my >= top - 6 && my <= bottom + 6;
    }
    var el = document.querySelector('.task[data-task="' + boxTaskId + '"]') ||
             document.querySelector('.task');
    if (!el) return false;
    if (pointInEl(mx, my, el, 6)) return true;
    var pv = el.querySelector('.task-preview.show');
    if (!pv) return false;
    if (pointInEl(mx, my, pv, 6)) return true;
    // ⭐ 框↔条 的纵向缝 + 框左缘竖列（2026-10-06 补，见 junctionHit 注释）
    if (junctionHit(mx, my)) return true;
    // ⭐ 卡 ↔ 条 之间那条缝也算（标准模式 41px，自由模式为 0 所以恒不触发）
    return corridorHit(mx, my, el, pv);
  }

  // 拖拽在 window 上收尾（鼠标可能拖出框外）
  root.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
    panX = dragging.px + dx;
    panY = dragging.py + dy;
    applyView();
  });
  root.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = null;
  });

  // 窗口变了就把框重新贴一次（几何是实时算的）
  root.addEventListener('resize', function () {
    if (!box || !box.classList.contains('show')) return;
    if (boxTaskId === '__standalone__') {
      if (!boxAnchorEl || !boxAnchorEl.isConnected) return;
      var g = geometryNear(boxAnchorEl, boxGeometry);
      box.style.left = g.left + 'px';
      box.style.top = g.top + 'px';
      box.style.width = g.width + 'px';
      box.style.height = g.height + 'px';
      return;
    }
    var el = document.querySelector('.task[data-task="' + boxTaskId + '"]') ||
             document.querySelector('.task');
    var pv = el && (el.querySelector('.task-preview.show') || el.querySelector('.task-preview'));
    if (el && pv) positionBox(el, pv);
  });

  // ══════════════════════════════════════════════════════════
  //  清缓存（任务被删 / 换图时必须调，不然 blob URL 一直挂着）
  // ══════════════════════════════════════════════════════════
  // ⭐⭐⭐ 2026-10-08（docs/170 §10.1 H2）：修掉一个【静默失效】的老 bug。
  //
  //  改之前：
  //    function dropTask(taskId) {
  //      var prefix = String(taskId) + '/';
  //      if (k.indexOf(prefix) === 0) { ...清... }
  //    }
  //  ⚠ 而 cacheKey() 产出的键是 '原图id|成品id'（例 'img_1|img_2'），
  //    兜底也是 'taskId#位置' —— **两种都不带 '/'**。
  //    ⇒ 那个 indexOf 永远匹配不上 ⇒ 任务删了，一帧都不清、
  //      一帧都不报错（这正是本项目最忌的静默失效形态）。
  //  ⚠ 而且【没有任何地方调它】—— 两件事叠起来，帧和 blob URL 就一直挂在内存里。
  //
  //  改法：收【任务对象】而不是 id（没有任务对象就推不出那两个端点 id），
  //       用 cacheKey(task, shot) 逐张算出真键。
  function dropTask(task) {
    var taskId = task && task.id;
    if (!task) return;
    var shots = task.shots || [];
    for (var i = 0; i < shots.length; i++) {
      var shot = shots[i];
      if (!shot) continue;
      var key = cacheKey(task, shot);
      if (cache[key]) {
        // ⚠ revoke：blob URL 不主动放就一直占着（同 image-store 的做法）
        revokeAll(cache[key].frames);
        delete cache[key];
      }
      // ⭐⭐ 2026-10-09（docs/175）：LRU 记录也要一起清。
      //   ⚠ 只 delete cache[key] 不清 lruOrder 的话，全局表里会留下【指向空气、
      //     时间戳却有效的】条目，白占那 12 个名额（旧代码是每任务一张表，没这问题）。
      delete lruOrder[key];
      delete lruOwner[key];
      delete lruPinned[key];
      delete strengthState[key];
    }
    // ⚠ 兜底键也清一遍：cacheKey 在"两个端点 id 都没有"时会退回 'taskId#位置'，
    //   那条路算出来的键不在上面那圈里。不清的话它会一直留着。
    var loose = String(taskId) + '#';
    Object.keys(cache).forEach(function (k) {
      if (k.indexOf(loose) === 0) {
        revokeAll(cache[k].frames);
        delete cache[k];
        delete lruOrder[k];
        delete lruOwner[k];
        delete lruPinned[k];
      }
    });
    Object.keys(strengthState).forEach(function (k) {
      if (k.indexOf(loose) === 0) delete strengthState[k];
    });
    // ⭐⭐ 第 3 步新加的 LRU 记录也一起收掉（按归属扫，连"换过 imgId 的旧键"也收）。
    if (typeof dropLRU === 'function') dropLRU(taskId);
    if (String(boxTaskId) === String(taskId)) hideBox();
  }

  root.V7Tween = {
    // 测试用（tests/tween-engine-wake.test.js）：引擎掉线后的「现问 → 拉起 → 自动接着算」那一段
    _computeReady: computeReady,
    // ⚠ 给探针看的：证明它真的连到了【预期的那个端口】。
    //   不带这个，探针只能间接猜（第一版就是这么错的：探针去读 window.V7_ENGINE_PORT，
    //   而模块其实读的是 location.search 里的 tween-port —— 断言和实现读的不是同一个地方）。
    engineBase: ENGINE_BASE,
    wheelOnCell: wheelOnCell,
    hoverTaskCard: hoverTaskCard,
    // ⚠ 2026-10-04：切任务卡时重新指归属（见上面 retarget 那段说明）。
    //   给 ui.html 的 followPreview() 用 —— 它原来一次都没碰过 V7Tween。
    retarget: retarget,
    hoverThumb: hoverThumb,
    leaveTaskCard: leaveTaskCard,
    holdImage: holdImage,
    leaveImage: leaveImage,
    imageChainHit: imageChainHit,
    hideBox: hideBox,
    // ⭐ 2026-10-05：ui.html 收预览条时调这个 —— 带任务归属判断，
    //   不会把"已经指向别的任务"的框误关掉（用户快速划过两张卡时会撞上）。
    hideBoxIfTask: hideBoxIfTask,
    geometryForTask: geometryForTask,
    boxShotOf: boxShotOf,
    cancelPendingHide: cancelPendingHide,
    // ⭐⭐ 2026-10-09（用户报「只出缩略图条、不点大图，移开鼠标条不消失」）：
    //   给 ui.html 用 —— **预览条弹出来的那一刻就要认下它归属谁**。
    //
    //   ⚠ 为什么必须单独开一个口子：原来"认归属"只发生在 hoverTaskCard /
    //     showBox 里，而 hoverTaskCard 整条被设置项「鼠标移到缩略图上自动弹出
    //     大预览框」挡着（关掉就不调）⇒ **那个开关顺手把"归属登记"也关掉了**。
    //     结果：条靠 ui.html 自己 pv.classList.add('show') 弹了出来，
    //     但归属从没登记 ⇒ 收框时 notifyId 是 null ⇒ 收条通知发不出去
    //     ⇒ 条永远赖着（用户实测）。
    //   ⇒ 归属登记跟"弹不弹大图"是两件事，不许再绑在一起。
    //     谁把条弹出来，谁就得顺手调这个登记一下。
    setBoxOwner: function (taskId) { if (taskId != null) setBoxTask(taskId); },
    // ⭐ 2026-10-17 夜（用户：「在任务卡片里面点击切换校色之后，预览图没有实时的变化」）：
    //   切校色版本以后，大预览框如果正开着这一单，按【正在看的那一张】重新取图（以前要等鼠标再动一下才换）。
    refreshBox: function (task) {
      if (!box || !box.classList.contains('show') || !task || String(boxTaskId) !== String(task.id)) return false;
      var shots = task.shots || [], shot = shots[boxShotIndex];
      if (!shot || !shot.done || !shot.imgId) shot = firstReadyShot(task);
      if (!shot) return false;
      hoverThumb(null, task, shot);
      return true;
    },
    // ⭐ 2026-10-05：框被收掉时反向通知 ui.html 收预览条（见 hideBox 里的说明）。
    //   两边互相通知，预览框和预览条才是"同生同死"，不会只死一边。
    setBoxClosedHandler: setBoxClosedHandler,
    // ⭐ 2026-10-05：框当前是不是开着、属于谁 —— 给 ui.html 做一致性判断用。
    boxState: function () {
      return { open: !!(box && box.classList.contains('show')), taskId: boxTaskId };
    },
    // ⭐ 2026-10-06：给调试卡的「谁把任务预览收掉的」追踪面板读现场用（preview-trace.js）。
    //   ⚠ 只读，不碰任何状态。指针坐标 / pointerAway 是本模块私有的，
    //     外面猜不到，只能从这里拿 —— 缺了这几个数，"是不是被判成鼠标离开了"这一条就断不了案。
    _diag: function () {
      return {
        boxTaskId: boxTaskId,
        boxShotIndex: boxShotIndex,
        pointerAway: pointerAway,
        lastMX: lastMX,
        lastMY: lastMY,
        dragging: !!dragging,
        zoom: zoom
      };
    },
    dropTask: dropTask,
    currentStrength: currentStrength,
    // ⚠⚠ 2026-10-04：这个【必须导出】—— ui.html 点缩略图那段调的就是它。
    //   第一版漏了导出，探针抓到的（表现是点图没反应，一句错都没有 = 典型静默失效）。
    currentFrameUrl: currentFrameUrl,
    compute: compute,
    // ⭐ 2026-10-05：任务卡里点缩略图用这个（见 openShot 注释）。
    //   ⚠ 不要再用 attachTo + showImage —— 那是"独立看图"，会让框跑位、丢掉任务归属。
    openShot: openShot,
    // ⭐ 2026-10-05：缩略图右上角「应用」调这个（见 applyShot 注释）
    applyShot: applyShot,
    // ⭐ 2026-10-05：「传回」问这个拿调好强度的那一帧（见 frameBytesFor 注释）
    frameBytesFor: frameBytesFor,
    // ⭐⭐ 2026-10-05（docs/143 §六-3）：「小眼睛」切版本时调这两个 ——
    //   单张用 purgeFrames，整批用 purgeTaskFrames（ui.html 切的是任务级开关）。
    //   ⚠ 必须调！不调的话切版本后滚强度读到的还是旧版本的帧（静默错误，docs/143 §六-2）。
    purgeFrames: purgeFrames,
    purgeTaskFrames: purgeTaskFrames,
    dropLRU: dropLRU,          // ⭐ 第 3 步：任务删了就把它的帧记录收掉
    // 独立显示（替代原大图窗口，给记录卡/参考图用）
    showImage: showImage,
    attachTo: attachTo,
    // ⚠ 2026-10-03 晚：给 ui.html 的连通区判定用 —— 鼠标在框里时，
    //   预览条不许收（不然鼠标一往上移框就没）。
    boxHit: boxHit,
    isShowing: isShowing,
    STEPS: STEPS,
    _cache: cache,
    _strength: strengthState,
    // ⭐⭐ 2026-10-09（docs/175）：给复核探针看的 LRU 观察口。
    //   ⚠ 为什么必须暴露：这台机器上"内存到底有没有被还回去"只能从外面量
    //     （缓存表对外已经有一份 _cache，但"淘汰了哪几组、钉子有几颗"看不见）。
    //     没有这个口，就只能靠读代码猜，而读代码猜正是上一轮把上限做成摆设的原因。
    _lru: function () {
      return {
        max: MAX_SETS,
        order: Object.keys(lruOrder).length,
        keys: Object.keys(lruOrder),
        owner: Object.assign({}, lruOwner),
        pinned: Object.assign({}, lruPinned),
        boxKey: boxKeyNow()
      };
    }
  };
})(typeof window !== 'undefined' ? window : this);
