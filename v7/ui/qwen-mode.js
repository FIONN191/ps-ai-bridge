/* 千问模式（2026-10-15 用户定）
 *
 *   切到千问模式后：
 *     ① 原本发给 Banana / GPT Image 的出图请求，全部改走千问 2.1（生成卡、批量工场、助手、调色、灯光、创作、局部工作台
 *        都经过 ui.html 的 aiGenerateNow，所以只在那一处接这一个口子）；
 *     ② 剪影预设只显示千问那一套（98 个出厂 + 千问模式下自己存的），切回普通模式原来那批原样回来，两套互不影响；
 *     ③ 默认走云端（免费，有 V6 那套每人限制），设置里能改成用自己电脑上的 ComfyUI；
 *     ④ 最高 2K：选 4K 自动降到 2K 并提示；参考图照现在的流程（主图 + 最多 5 张）；
 *     ⑤ 一张一张跑、跑完一张回一张（千问 2.1 一次合着跑 4 张比排队一张张跑还慢：云端实测 418 秒 vs 295 秒）；
 *        学员后台允许同时 4 张，就开 4 路。
 *
 *   ⚠ 已经是工作流的请求（Forge 预设、ComfyUI 预设、RH）不改道 —— 那些本来就不是 Banana / GPT。
 *   ⚠ 千问引擎（7 条流程）在 ui-pure/workflows/qwen-engine.js（make_qwen_presets.py --engine-js 生成），不进用户预设列表。
 *   ⚠ 出厂预设在 ui-pure/qwen-factory-presets.js（scripts/build-qwen-factory-presets-20261015.py 生成）。
 *   ⚠ 开关和"在哪算"存在设置里（settingsRuntime.qwenMode / qwenSource，按账号存），ui.html 通过
 *     window.__V7_QWEN_SETTINGS__ / __V7_QWEN_SAVE__ 交给这里读写，这个文件不自己存。
 */
(function (root) {
  'use strict';
  const SET = 'qwen';                        // 预设上的 presetSet 标记：千问那一套
  const SETTING = 'qwenMode', SOURCE = 'qwenSource';
  const RETRY_LIMIT_SECONDS = 120;           // 普通账号「1K 每分钟 1 张」：按后台说的秒数等，超过这个就不等了
  const COOLDOWN_MS = 3200;                  // 后台规矩：同一账号两次提交至少隔 3 秒
  const STOP_ALL = /^(WORKFLOW_WORKER_UNAVAILABLE|WORKFLOW_SERVICE_UNCONFIGURED|PLATFORM_LOGIN_REQUIRED|AUTH_INVALID|AUTH_REQUIRED|WORKFLOW_LIMIT_(HIGH_TIER|DAILY|POINTS|QUEUE|BATCH|BATCH_FULL))$/;
  const ASPECTS = ['1:1', 'Auto', '9:16', '16:9', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '21:9', '9:21', '2:1', '1:2', '3:1', '1:3'];

  const settings = () => (typeof root.__V7_QWEN_SETTINGS__ === 'function' ? root.__V7_QWEN_SETTINGS__() : null);
  // ⚠ 键名直接写出来（别用 s[SOURCE]）：scripts/audit-settings.js 靠这两行认出「千问模式在哪算」这个设置真有人读
  function enabled() { const s = settings(); return !!(s && s.qwenMode === true); }
  function source() { const s = settings(); return s && s.qwenSource === 'local' ? 'local' : 'platform'; }
  function setEnabled(on) {
    const s = settings();
    if (!s) return false;
    s.qwenMode = !!on;
    // ⚠ 先广播再存：存设置会再发一次 wheelchair:settings-changed，界面要先按"点了开关"刷新（带提示），
    //   顺序反过来的话界面会在"设置变了"那一下静默刷新，开关的提示就丢了（10-15 界面实测抓到）。
    try { root.dispatchEvent(new CustomEvent('wheelchair:qwen-mode', { detail: { enabled: !!on } })); } catch (_) { }
    if (typeof root.__V7_QWEN_SAVE__ === 'function') root.__V7_QWEN_SAVE__();
    return true;
  }

  // ── 两套预设分开 ──
  // 千问模式只认 presetSet==='qwen' 的；普通模式只认不是 qwen 的。
  // 出厂工具（抠像/解析…）、工具分类、Agent 收件箱两边都要（它们不是 Banana/GPT 的提示词）。
  function isQwenPreset(p) { return !!p && p.presetSet === SET; }
  // 工作流预设（Forge / ComfyUI / RH，带 workflow / forgeWorkflow 或认得的 provider）：本来就不是 Banana / GPT，千问模式不改道
  function isWorkflowPreset(p) { return !!p && !!(p.workflow || p.forgeWorkflow || /^(comfy|comfyui|forge|rh|runninghub)$/i.test(String(p.provider || ''))); }
  function visible(p) {
    if (!p) return false;
    if (p.category === '__tool__' || p.category === '__agent_inbox__') return true;
    if (root.PRESETS && typeof root.PRESETS.isToolKind === 'function' && p.kind && p.kind !== 'prompt' && root.PRESETS.isToolKind(p.kind)) return true;
    // ⭐ 2026-10-19（docs/250 第 3 条，用户定）：出厂的只放行【软件内置的工具】（抠像 / 人体解析 / 指哪抠哪 / 辉光 /
    //   tool-silhouettes 的内置工具行 —— 它们都不是提示词），不再「见 _isFactory 就放行」。
    //   ⚠ 原来第一句是 `p._isFactory || …`：V6 搬家（v6-migration.js）原样保留了 V6 出厂提示词预设的 _isFactory，
    //     于是千问模式下还能看到「★ 身材优化」这类香蕉预设（测试用户截图）。现在这类提示词按下面的 presetSet 判。
    if (p._isFactory && p.kind && p.kind !== 'prompt') return true;
    // ⭐ 2026-10-16（用户：「现在comfyui部分的之前的Forge预设也用不了」）：工作流预设两边都显示。
    //   「两套分开」说的是 Banana/GPT 那套提示词预设 ↔ 千问那套；Forge / ComfyUI 预设不改道、两种模式下都能直接用，
    //   原来千问模式把它们一起藏了 ⇒ 切过去就找不到。
    if (!isQwenPreset(p) && isWorkflowPreset(p)) return true;
    return enabled() ? isQwenPreset(p) : !isQwenPreset(p);
  }

  // ── 出厂预设装进本账号（版本变高才装；用户改过的不覆盖，见 preset-store installQwenFactory） ──
  function ensureFactory() {
    const bundle = root.__V7_QWEN_FACTORY_PRESETS__, P = root.PRESETS;
    if (!bundle || !Array.isArray(bundle.items) || !P || typeof P.installQwenFactory !== 'function') return Promise.resolve({ skipped: true });
    return P.installQwenFactory(bundle);
  }

  // ── 出图改道 ──
  function engineFor(imageCount) {
    const bundle = root.__V7_QWEN_ENGINE__;
    if (!bundle || !bundle.engines) throw Object.assign(new Error('开源模型模式的工作流没装上，请重新安装软件'), { code: 'QWEN_ENGINE_MISSING' });
    const refMax = bundle.refMax || 5, refs = imageCount - 1;
    if (refs > refMax) throw Object.assign(new Error('开源模型模式最多主图 + ' + refMax + ' 张参考图，这次有 ' + imageCount + ' 张'), { code: 'QWEN_TOO_MANY_REFERENCES' });
    const engine = imageCount <= 0 ? bundle.engines.t2i : refs <= 0 ? bundle.engines.edit : bundle.engines['ref' + refs];
    if (!engine) throw Object.assign(new Error('开源模型模式的工作流不全，请重新安装软件'), { code: 'QWEN_ENGINE_MISSING' });
    return JSON.parse(JSON.stringify(engine));
  }
  function quality(size) {
    const text = String(size || '').toUpperCase();
    if (text === '4K') return { value: 2048, downgraded: true };
    if (text === '2K') return { value: 2048, downgraded: false };
    return { value: 1024, downgraded: false };
  }
  // 这一单要不要改道：千问模式开着、且走的是 Banana / GPT 那条路（不是工作流）
  function shouldReroute(snapshot) {
    if (!enabled() || !snapshot) return false;
    const preset = snapshot.workflowPreset;
    return !(preset && (preset.workflow || preset.forgeWorkflow));
  }

  // ── 一次最多几张（2026-10-16 用户定：「张数限制需要不能被破解 需要服务器验证 权限跟随账号走 普通账号和学员账号不一样 +2k限额」）──
  //   云端：上限由后台按账号给（availability 的 limits.maxBatch；2K 再跟 highTierLeft 取小的），这里只拿来给张数框定上限；
  //     真正的拦截在后台：每张单带「这一组的编号 + 一共几张」（generate 里的 qwenGroup），后台逐单核对，改软件绕不过去。
  //   本机：用户自己的电脑、不走后台，只受软件总上限管。
  const LIMITS_TTL_MS = 60000;
  let limitsCache = null, limitsLoading = null, limitsError = '';       // limitsCache = { account, at, limits }
  function accountKey() {
    try {
      const st = root.V7Backend && root.V7Backend.state && root.V7Backend.state();
      return st && st.signedIn && st.account ? String(st.account.id || st.account.email || '') : '';
    } catch (_) { return ''; }
  }
  function limits() { const key = accountKey(); return key && limitsCache && limitsCache.account === key ? limitsCache.limits : null; }
  function storeLimits(key, value) {
    const before = JSON.stringify(limits());
    limitsCache = { account: key, at: Date.now(), limits: value || null };
    if (JSON.stringify(limitsCache.limits) !== before) {
      try { root.dispatchEvent(new CustomEvent('wheelchair:qwen-limits', { detail: { limits: limitsCache.limits } })); } catch (_) { }
      pump();     // 同时能跑几张变了（比如刚问到是学员 4 路）：排队的马上多放几张出去
    }
  }
  // force：刚出完图（2K 剩余变了）时强制重问
  function refreshLimits(force) {
    if (!enabled() || source() !== 'platform') return Promise.resolve(null);
    const key = accountKey(), B = root.V7Backend;
    if (!key || !B || typeof B.workflowAvailability !== 'function') return Promise.resolve(null);
    if (!force && limitsCache && limitsCache.account === key && Date.now() - limitsCache.at < LIMITS_TTL_MS) return Promise.resolve(limitsCache.limits);
    if (limitsLoading) return limitsLoading;
    const bundle = root.__V7_QWEN_ENGINE__, engine = bundle && bundle.engines && bundle.engines.t2i;
    const id = engine && (engine.platformPresetId || engine.id);
    if (!id) return Promise.resolve(null);
    limitsLoading = B.workflowAvailability(id, 'comfyui', 1, 0)
      .then(info => { if (accountKey() === key) { limitsError = ''; storeLimits(key, info && info.limits); } return limits(); })
      // 问不到（没网 / 云端不在）：记一下时间，别每次重画都去问；张数框退回软件总上限，后台照样会拦
      .catch(error => {
        if (accountKey() !== key) return null;
        limitsError = String(error && error.message || error || '查不到');
        if (!(limitsCache && limitsCache.account === key && limitsCache.limits)) storeLimits(key, null);
        else limitsCache.at = Date.now();
        try { root.dispatchEvent(new CustomEvent('wheelchair:qwen-limits', { detail: { error: limitsError } })); } catch (_) { }
        return null;
      })
      .finally(() => { limitsLoading = null; });
    return limitsLoading;
  }
  // 上一次问额度失败的原因（界面显示「没查到」而不是一直「正在查」）；问到了就清空
  function limitsFailure() { return limits() ? '' : limitsError; }
  function isHigh(size, l) { return quality(size).value >= (Number(l && l.highTierFrom) || 1025); }
  // 还没问到 / 问不到（没登录、没网、后台还是老版本）时先按普通账号的默认上限显示（跟后台 DEFAULT maxBatch 一样）。
  //   10-16 用户实测「千问模式下张数限制没生效 还是能拉到18张」：当时线上后台 1.6.0 没有千问服务，问额度失败，
  //   旧写法退回软件总上限 18 —— 看着像没限。问到了以服务器为准。
  //   ⭐ 10-16 晚用户定数「普通1张，学员4张 管理员不限制」→ 这里跟着改成 1。
  const FALLBACK_BATCH = 1;
  // 这个分辨率下一次最多几张。null = 不限（本机算 / 服务器说不限）。0 = 2K 额度用完了
  function batchCap(size) {
    if (!enabled() || source() !== 'platform') return null;
    const l = limits();
    if (!l) return FALLBACK_BATCH;
    let cap = Number(l.maxBatch) > 0 ? Number(l.maxBatch) : null;
    if (isHigh(size, l) && l.highTierLeft != null && !l.highTierUnlimited) {
      const left = Math.max(0, Number(l.highTierLeft) || 0);
      cap = cap == null ? left : Math.min(cap, left);
    }
    return cap;
  }
  // 把 Banana / GPT 的请求快照改成一条千问工作流请求（返回新快照，不碰原来的）
  function reroute(snapshot, notify) {
    const s = Object.assign({}, snapshot);
    const capture = s.captureSnapshot || s.capture;
    const hasMain = !!(capture && (capture.inputImageBase64 || capture.imageBase64));
    const refs = Array.isArray(s.refImages) ? s.refImages.length : 0;
    const imageCount = (hasMain ? 1 : 0) + refs;
    const engine = engineFor(imageCount);
    const q = quality(s.size);
    if (q.downgraded && notify) notify('开源模型最高 2K，这次按 2K 出（选的是 4K）');
    engine.parameters = Object.assign({}, engine.parameters, { resolution: q.value, seed: -1 });
    if (imageCount === 0) engine.parameters.aspectRatio = ASPECTS.indexOf(String(s.aspectRatio || '')) >= 0 ? String(s.aspectRatio) : '1:1';
    s.workflowPreset = engine;
    s.workflowPresetId = engine.id;
    s.workflowParameters = engine.parameters;
    s.workflowSource = source();
    s.qwenRequested = Math.max(1, Number(s.batch) || 1);
    s.batch = 1;                       // 每张单独一单
    // 没主图却有参考图：把第一张参考图当主图（主图口在引擎里永远是第一张）
    if (!hasMain && refs) s.qwenPromoteFirstReference = true;
    return s;
  }

  function prepareShot(p) {
    if (!p.qwenPromoteFirstReference || !Array.isArray(p.refImages) || !p.refImages.length) return p;
    const first = p.refImages[0];
    const data = typeof first === 'string' ? first : first.imageBase64 || first.base64 || first.dataUrl || '';
    return Object.assign({}, p, { inputImageBase64: String(data).replace(/^data:[^,]*,/, ''), refImages: p.refImages.slice(1) });
  }
  function limitWait(error) {
    if (!error || error.code !== 'WORKFLOW_LIMIT_LOW_TIER_RATE') return 0;
    const match = /还要等\s*(\d+)\s*秒/.exec(String(error.message || ''));
    const seconds = match ? Number(match[1]) : 60;
    return seconds > 0 && seconds <= RETRY_LIMIT_SECONDS ? seconds : 0;
  }
  function sleep(ms, guard) {
    return new Promise((resolve, reject) => {
      let left = ms;
      const step = () => {
        try { if (guard) guard(); } catch (error) { reject(error); return; }
        if (left <= 0) { resolve(); return; }
        const slice = Math.min(500, left); left -= slice; setTimeout(step, slice);
      };
      step();
    });
  }

  // ── 全局排队（10-16 晚用户：「可以反复提交，可以多线程去发任务的 … 上一个任务没算完，发下一个任务会直接失败
  //   直接让排队就行」「取消的任务就直接不要再发给服务器了」）
  //   所有千问任务的每一张都从这里领「跑道」：跑道数 = 服务器说这个账号同时能跑几张（limits.concurrent：普通 1、学员 4），
  //   没领到的在本机排队 —— 不发给服务器、不扣分；取消时排队里的直接撤掉，一张都不发。
  //   两次提交之间至少隔 3.2 秒（后台冷却 3 秒），按领到跑道的先后排时间。
  const lanes = { active: 0, waiting: [], nextAt: 0 };
  function laneCount() {
    if (source() !== 'platform') return 1;            // 本机 ComfyUI 本来就一张一张算
    const l = limits(), n = l && Number(l.concurrent);
    return n > 0 ? n : (l && l.student ? 4 : 1);      // 问不到按 1 路（后台照样拦）
  }
  function pump() {
    while (lanes.waiting.length && lanes.active < laneCount()) { const next = lanes.waiting.shift(); lanes.active++; next.resolve(); }
    lanes.waiting.forEach((entry, i) => { try { entry.onWait(i + 1); } catch (_) { } });
  }
  function acquire(owner, onWait) {
    return new Promise((resolve, reject) => { lanes.waiting.push({ owner, resolve, reject, onWait: onWait || (() => { }) }); pump(); });
  }
  function release() { lanes.active = Math.max(0, lanes.active - 1); pump(); }
  function dropWaiting(owner, error) {
    const keep = [];
    for (const entry of lanes.waiting) { if (entry.owner === owner) entry.reject(error); else keep.push(entry); }
    lanes.waiting = keep;
    pump();
  }
  function reserveSubmitSlot() { const now = Date.now(), at = Math.max(now, lanes.nextAt); lanes.nextAt = at + COOLDOWN_MS; return at - now; }
  const cancelledError = () => Object.assign(new Error('已取消'), { code: 'AI_CANCELLED' });
  // 后台「过一会儿再来」的拒绝（都在扣分之前，没建单）：等一下再交，不算失败
  //   同时几张满了（别的设备 / 上一张服务器还没记完）、冷却、全站排队满；「1K 每分钟」按后台说的秒数等
  const RETRY_LATER = /^WORKFLOW_LIMIT_(CONCURRENT|COOLDOWN|QUEUE)$/;
  const RETRY_LATER_MAX_MS = 16 * 60 * 1000;          // 后台 staleMinutes=15：没人跑的单 15 分钟后不再占名额，再久就真失败
  function retryWait(error, waitedMs) {
    const lowTier = limitWait(error);
    if (lowTier) return lowTier * 1000 + 300;
    const code = error && error.code || '';
    if (RETRY_LATER.test(code) && waitedMs < RETRY_LATER_MAX_MS) return code === 'WORKFLOW_LIMIT_COOLDOWN' ? 3300 : 5000;
    return 0;
  }

  /* 一张一张跑。每跑完一张立刻交给 onShot（存图 + 点亮任务卡那一格），最后汇总成跟 Banana 一样形状的结果。
   *   每张先在本机排队领跑道（见上面），领到才发；第一张先单独跑：确认框只弹一次；没登录 / 云端不在 / 额度满，
   *   第一张就停，这个任务排队里的几张也撤掉不发。
   *   被后台挡回「过一会儿再来」的按说的秒数等再交（没扣分的拒绝，等了再发是安全的）。
   *   某一张失败不影响别的张；一张都没出才算整单失败。 */
  async function generate(p, task, hooks, onShot) {
    const total = Math.max(1, Number(p.qwenRequested) || 1);
    const workflows = root.V7Workflows;
    if (!workflows) throw Object.assign(new Error('工作流模块没加载'), { code: 'QWEN_RUNTIME_MISSING' });
    hooks = hooks || {};
    const check = () => { if (hooks.guard) hooks.guard(); if (task && task.cancelRequested) throw cancelledError(); };
    // 跑道数要靠「这个账号同时能跑几张」：先问一下（1 分钟内问过就用记下的）；问不到按 1 路
    if (p.computeSource === 'platform') { await refreshLimits(false).catch(() => null); check(); }
    // 这一次点生成 = 一组：每张单都带上组编号和总张数，后台核对「一次最多几张」「这组不能多发」「2K 整组放得进剩余额度」
    const group = p.computeSource === 'platform'
      ? { id: (String(p.taskId || 'qwen').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64) + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), size: total }
      : null;
    const results = [], errors = [];
    let confirmed = false, stopped = null, stopAll = null;
    const confirm = estimate => {
      if (confirmed || !hooks.confirm || !estimate || !Number(estimate.points)) return Promise.resolve(true);
      return Promise.resolve(hooks.confirm(Object.assign({}, estimate, { qwenTotal: total }))).then(ok => { confirmed = ok === true; return ok; });
    };
    const progress = text => { if (hooks.onProgress) hooks.onProgress({ status: text }); };
    async function runOne(index) {
      const shot = prepareShot(Object.assign({}, p, { taskId: p.taskId + '-q' + (index + 1), batch: 1 }, group ? { qwenGroup: group } : {}));
      check();
      // 先在本机排队领跑道：没领到之前什么都不发给服务器（取消就直接撤掉）
      await acquire(p.taskId, ahead => progress('排队中 · 前面还有 ' + ahead + ' 张（第 ' + (index + 1) + '/' + total + ' 张）'));
      const subs = running.get(p.taskId) || new Set();
      running.set(p.taskId, subs);
      subs.add(shot.taskId);
      try {
        check();
        // 领到跑道时再看一眼：这个任务前面那张已经判了「后面都别发」/ 被拒了，就不发
        if (stopAll) throw Object.assign(new Error(stopAll.message), { code: stopAll.code, qwenStopAll: stopAll });
        if (stopped) throw cancelledError();
        // 两次提交隔 3.2 秒是后台冷却的规矩，只管云端；本机 ComfyUI 不用等
        const gap = p.computeSource === 'platform' ? reserveSubmitSlot() : 0;
        if (gap > 0) await sleep(gap, check);
        let waited = 0;
        for (;;) {
          check();
          progress('开源模型 · 第 ' + (index + 1) + '/' + total + ' 张');
          try {
            const result = await workflows.generate(shot, task, Object.assign({}, hooks, { confirm }));
            const image = result && Array.isArray(result.results) && result.results[0];
            if (!image) throw Object.assign(new Error('工作流没返回图片'), { code: 'WORKFLOW_OUTPUT_INVALID' });
            const item = Object.assign({}, image, { index });
            results.push(item);
            if (onShot) await onShot(item, results.length, total);
            return;
          } catch (error) {
            const wait = retryWait(error, waited);
            if (!wait) {
              // ⚠ 要在 finally 还跑道【之前】判：不然跑道先交给本任务排队的下一张，它照样会发出去
              if (STOP_ALL.test(error && error.code || '')) markStopAll(error);
              throw error;
            }
            waited += wait;
            const seconds = limitWait(error) || Math.ceil(wait / 1000);     // 限速按后台说的秒数报（等的时候多留 0.3 秒余量）
            progress(error.code === 'WORKFLOW_LIMIT_LOW_TIER_RATE' ? '开源模型限速：' + seconds + ' 秒后自动提交第 ' + (index + 1) + '/' + total + ' 张'
              : '等前面的算完 · ' + seconds + ' 秒后自动提交第 ' + (index + 1) + '/' + total + ' 张');
            await sleep(wait, check);
          }
        }
      } finally {
        subs.delete(shot.taskId);
        if (!subs.size) running.delete(p.taskId);
        release();
      }
    }
    async function attempt(index) {
      if (stopped) return;
      if (stopAll) { errors.push({ index, code: stopAll.code, message: stopAll.message }); return; }
      try { await runOne(index); }
      catch (error) {
        const code = error && error.code || '';
        if (error && error.qwenStopAll) { errors.push({ index, code: error.qwenStopAll.code, message: error.qwenStopAll.message }); return; }
        if (code === 'QUOTE_DECLINED' || code === 'AI_CANCELLED' || code === 'AI_CONTEXT_CHANGED' || code === 'ASSISTANT_SESSION_CHANGED') {
          stopped = stopped || error;
          dropWaiting(p.taskId, cancelledError());
          return;
        }
        errors.push({ index, code: code || 'QWEN_SHOT_FAILED', message: String(error && error.message || error) });
      }
    }
    // 后面几张也一样过不去（云端不在 / 额度满 / 没登录…）：排队里的撤掉不发，原话记到每一张上
    function markStopAll(error) {
      if (stopAll) return;
      stopAll = { code: error.code, message: String(error.message || error) };
      dropWaiting(p.taskId, Object.assign(new Error(stopAll.message), { code: stopAll.code, qwenStopAll: stopAll }));
    }

    await attempt(0);
    if (total > 1) await Promise.all(Array.from({ length: total - 1 }, (_, i) => attempt(i + 1)));
    if (stopped && !results.length) throw stopped;
    // 2K 剩几张、是不是被拦了：出完重问一次，张数框上限跟着变
    if (group) refreshLimits(true).catch(() => null);
    results.sort((a, b) => a.index - b.index);
    errors.sort((a, b) => a.index - b.index);
    const first = errors[0];
    return { ok: results.length > 0, taskId: p.taskId, results, errors, cancelled: !!stopped,
      error: results.length ? '' : (first ? first.message : '开源模型没有出图') };
  }

  // 正在跑的千问子单：主任务编号 → 子单编号（每张单独一单，取消主任务时要把子单一起取消）
  const running = new Map();
  // 取消：排队里还没发的直接撤掉（一张都不发给服务器）；已经发出去的通知服务器取消
  function cancel(taskId) {
    const id = String(taskId || '');
    dropWaiting(id, cancelledError());
    const subs = running.get(id);
    if (!subs || !root.V7Workflows) return Promise.resolve(false);
    return Promise.all(Array.from(subs, sub => root.V7Workflows.cancel(sub).catch(() => null))).then(() => true);
  }
  // 测试用：看现在排队的样子
  function queueState() { return { active: lanes.active, waiting: lanes.waiting.length, lanes: laneCount() }; }

  root.V7QwenMode = { enabled, setEnabled, source, visible, isQwenPreset, ensureFactory, shouldReroute, reroute, generate, cancel, engineFor, quality,
    limits, limitsFailure, refreshLimits, batchCap, queueState, FALLBACK_BATCH, SET, SETTING, SOURCE, ASPECTS };

  // 开千问模式、换账号、改「在哪算」时重问一次上限（张数框要跟着变）
  if (root.addEventListener) {
    root.addEventListener('wheelchair:qwen-mode', () => { setTimeout(() => { refreshLimits(true).catch(() => null); }, 0); });
    root.addEventListener('wheelchair:settings-changed', () => { refreshLimits(false).catch(() => null); });
  }
  if (root.V7Backend && typeof root.V7Backend.onChange === 'function') {
    // ⚠ onChange 刷新账号资料时也会发（同一个账号），只在真的换了账号时才强制重问
    let lastAccount = accountKey();
    root.V7Backend.onChange(() => {
      const key = accountKey();
      if (key === lastAccount) return;
      lastAccount = key;
      setTimeout(() => { refreshLimits(true).catch(() => null); }, 0);
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
