/*
 * V7 遥测上报（客户端）
 *
 * 职责边界要划清 —— 客户端只负责"收集和发送"，不做隐私过滤。
 * 服务端（backend/telemetry_scrub.py）有一份强制的清洗，不信这里。
 * 这里的过滤只是"少发点没用的"，不是防线。
 *
 * 与老版（V6）的差异：
 *   V6 只在 /api/telemetry 收事件，写 jsonl 文件，7 天删
 *   V7 写数据库，能按维度聚合，并且支持报错方案的远程下发
 *
 * 三条设计原则：
 *   1. 绝不阻塞主流程 —— 上报失败静默吞掉，不能因为遥测让用户操作卡住
 *   2. 绝不上报隐私 —— 提示词/文件名/路径/Key 一个都不发（服务端还有兜底）
 *   3. 用户可以关 —— 设置里给开关，关掉后连 boot 事件都不发
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7Telemetry = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  // ⚠ 用户可关。默认开 —— 但关掉后必须真的什么都不发。
  const PREF_KEY = 'v7.telemetry.enabled.v1';
  const DEVICE_KEY = 'v7.telemetry.device.v1';
  const SEND_INTERVAL = 60 * 1000;      // 每分钟发一批
  const MAX_QUEUE = 200;                // 队列上限，超了丢最老的
  const FLUSH_AT = 30;                  // 攒够 30 条立刻发

  // 只在"用户操作完成/失败"这类时刻采，不采鼠标轨迹一类的细粒度行为
  const ALLOWED_TYPES = new Set(['boot', 'task', 'error', 'usage', 'prefs',
                                 'funnel', 'heal', 'device', 'notice']);

  let queue = [];
  let timer = null;
  let usageTimer = null;       // 使用时长心跳，跟 flush 定时器分开
  let started = false;
  let sessionStart = Date.now();
  let lastSentAt = 0;
  let deliveryVersion = 0;
  let pendingHeal = null;      // { code, at } —— 报错后等重试成功，用来衡量 advice 质量
  let seenSteps = null;        // 首次使用漏斗用

  // ------------------------------------------------------------ 基础

  function enabled() {
    try {
      const raw = root.localStorage.getItem(PREF_KEY);
      return raw === null ? true : raw === '1';
    } catch (_) { return true; }
  }

  function setEnabled(value) {
    try { root.localStorage.setItem(PREF_KEY, value ? '1' : '0'); } catch (_) {}
    if (!value) { deliveryVersion++; queue = []; } // 同时作废尚未结束请求的重试资格
  }

  function deviceId() {
    let id = '';
    try { id = root.localStorage.getItem(DEVICE_KEY) || ''; } catch (_) {}
    if (!/^[A-Za-z0-9_\-]{8,64}$/.test(id)) {
      // 匿名设备 ID：和账号无关，换账号不该换设备身份
      const bytes = new Uint8Array(16);
      (root.crypto || {}).getRandomValues
        ? root.crypto.getRandomValues(bytes)
        : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
      id = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
      try { root.localStorage.setItem(DEVICE_KEY, id); } catch (_) {}
    }
    return id;
  }

  function appVersion() {
    // ⚠ 2026-10-18 深夜修：原来只读 V7Build.version / __V7_VERSION__ —— 这两个全项目都没人定义，
    //   线上遥测的版本号一直是空的（后台「报错看板」分不出哪个版本出的错）。版本号唯一来源是 version.js 的 V7_VERSION。
    return String((root.V7_VERSION && root.V7_VERSION.app) || (root.V7Build && root.V7Build.version) || root.__V7_VERSION__ || '');
  }

  function backend() { return root.V7Backend; }

  // ------------------------------------------------------------ 采集

  function enqueue(type, payload) {
    if (!enabled() || !ALLOWED_TYPES.has(type)) return;
    const current=context();if(queueContext!==current){dropped+=queue.length;queue=[];queueContext=current;}
    if (queue.length >= MAX_QUEUE) { queue.shift(); dropped++; }
    queue.push({ type: type, ts: new Date().toISOString(), ...payload });
    if (queue.length >= FLUSH_AT) flush();
  }

  /**
   * 用"档"代替"值"。老版的经验 —— 区间数据聚合够用，但反查不到个人。
   * ⚠ 不要改成精确值：精确到秒的时间能反推作息，精确耗时能指纹化。
   */
  function bucket(ms) {
    const s = ms / 1000;
    if (s < 5) return '0-5s';
    if (s < 15) return '5-15s';
    if (s < 40) return '15-40s';
    if (s < 80) return '40-80s';
    if (s < 180) return '80-180s';
    return '180s+';
  }

  function screenClass() {
    const w = root.screen && root.screen.width || 0;
    if (w >= 3000) return '4k';
    if (w >= 2200) return 'qhd';
    if (w >= 1600) return 'fhd';
    return 'small';
  }

  function osLabel() {
    const ua = String((root.navigator && root.navigator.userAgent) || '');
    if (/Windows NT 1[01]/.test(ua)) return 'win10_or_11';
    if (/Windows NT 6\.1/.test(ua)) return 'win7';
    if (/Mac OS X/.test(ua)) return 'macos';
    return 'other';
  }

  /**
   * 设备档位。⚠ 只报"档"，不报型号全名 ——
   * "RTX 4090 + 64G + 4K" 这个组合可能唯一定位到一个用户。
   * 型号全名即使发过来，服务端也会删掉（见 telemetry_scrub.PII_FIELDS）。
   */
  async function collectDevice() {
    const payload = {
      gpu_vendor: 'unknown',
      gpu_tier: 'unknown',
      vram_bucket: 'unknown',
      ram_bucket: 'unknown'
    };
    try {
      const mem = root.navigator && root.navigator.deviceMemory;
      if (mem) payload.ram_bucket = mem >= 32 ? '32G+' : mem + 'G';
      // GPU 只从 Tauri 侧拿，并且只取"档"不取型号
      if (root.uiwin && root.uiwin.perfSample) {
        const sample = await root.uiwin.perfSample();
        const gpu = sample && sample.gpu;
        if (gpu && gpu.supported) {
          payload.gpu_vendor = 'nvidia';
          const totalMb = Number(gpu.memoryTotalMb || 0);
          if (totalMb >= 24000) { payload.gpu_tier = 'high'; payload.vram_bucket = '24G+'; }
          else if (totalMb >= 12000) { payload.gpu_tier = 'mid'; payload.vram_bucket = '12-24G'; }
          else if (totalMb >= 6000) { payload.gpu_tier = 'low'; payload.vram_bucket = '6-12G'; }
          else if (totalMb > 0) { payload.gpu_tier = 'minimal'; payload.vram_bucket = '<6G'; }
        }
      }
    } catch (_) { /* 拿不到就报 unknown，不影响 */ }
    enqueue('device', payload);
  }

  // ------------------------------------------------------------ 发送

  let sending = false;
  let queueContext = null;
  let dropped = 0;
  function context(){const s=backend()?.state?.()||{};return JSON.stringify([s.baseUrl,s.account?.id,s.sessionVersion,deliveryVersion]);}

  async function flush() {
    if (!enabled() || sending || !queue.length) return;
    const client = backend();
    if (!client || typeof client.state !== 'function') return;
    if (typeof client.sendTelemetry !== 'function') return;
    const startedContext=context();
    if(queueContext!==startedContext){dropped+=queue.length;queue=[];queueContext=startedContext;return;}
    sending = true;
    const batch = queue.splice(0,100);
    try {
      await client.sendTelemetry({deviceId:deviceId(),appVersion:appVersion(),events:batch});
      lastSentAt = Date.now();
    } catch (_) {
      if(enabled()&&context()===startedContext){
        const combined=batch.concat(queue);dropped+=Math.max(0,combined.length-MAX_QUEUE);
        queue=combined.slice(-MAX_QUEUE);
      }
      else dropped+=batch.length;
    } finally { sending = false; }
  }

  // ------------------------------------------------------------ 客户端预清洗

  // ⚠ 为什么客户端也要洗：服务端会洗，但"在网络上传输"这一步就已经暴露了。
  //   用户原话要求"脱敏上传" —— 那就不该让隐私离开这台机器。
  //   这里的规则是服务端 telemetry_scrub.py 的简化版：宁可多洗，不可漏洗。
  const SCRUB_RULES = [
    [/https?:\/\/[^\s"'<>)]+/gi, '<url>'],
    [/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '<email>'],
    [/[A-Za-z]:\\[^\s"'<>|]*/g, '<path>'],
    [/\\\\[^\\\s]+\\[^\s"'<>]*/g, '<unc>'],
    [/(?<![\w:/])\/(?:Users|home|mnt|opt|var|tmp|media)\/[^\s"'<>]*/g, '<path>'],
    [/\bsk-[A-Za-z0-9_\-]{16,}\b/g, '<key>'],
    [/\bBearer\s+[A-Za-z0-9._\-]{16,}/gi, 'Bearer <token>'],
    [/\b(?=[0-9a-f]*\d)[a-f0-9]{32,}\b/gi, '<hex>'],
    [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '<phone>'],
    [/(?<!\d)\d{8,}(?!\d)/g, '<num>'],
    // 中文一律替换 —— 中文人名/客户名/项目名无法用正则可靠识别。
    // 丢掉中文不损失诊断力：错在哪由 code 表达，怎么办由服务端下发。
    [/[一-鿿　-〿＀-￯]+/g, '<中文>']
  ];

  function scrubText(value, limit) {
    let text = String(value == null ? '' : value);
    for (const [pattern, replacement] of SCRUB_RULES) {
      text = text.replace(pattern, replacement);
    }
    text = text.replace(/\s+/g, ' ').trim();
    const max = limit || 200;
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  // ------------------------------------------------------------ 对外埋点

  function boot(extra) {
    enqueue('boot', {
      plugin_version: appVersion(),
      ps_version_major: Number((extra && extra.psMajor) || 0),
      os_label: osLabel(),
      screen_class: screenClass(),
      language: String((root.navigator && root.navigator.language) || ''),
      session_start_hour: new Date().getHours()     // ⚠ 只到小时，不到分秒
    });
  }

  function task(info) {
    const data = info || {};
    enqueue('task', {
      feature: String(data.feature || ''),
      provider: String(data.provider || ''),
      model_type: String(data.modelType || ''),
      size: String(data.size || ''),
      aspect_ratio: String(data.aspectRatio || ''),
      batch_size: Number(data.batchSize || 0),
      result: String(data.result || ''),
      elapsed_bucket: bucket(Number(data.elapsedMs || 0)),
      error_category: data.errorCategory || null
    });
  }

  /**
   * 报错上报。⚠ 只发 code 和洗过的短消息。
   * 完整的错误原文留在本机 —— 用户想给客服看时可以手动附带（见 attachToTicket）。
   */
  function error(code, info) {
    const data = info || {};
    // ⭐ 2026-10-20（docs/256 第四节①）：报错表里定成「提示」级别的（level:'info'，比如「新版本下载好了」「账号已变化，操作已停止」）
    //   不是错误 —— 原来不管级别一律记 error，线上报错统计里 19% 是这种假错误。改记 notice：后台报错看板只数 error，
    //   旧后台不认 notice 会直接丢掉（不报错）；新后台单独记。也不等「是否自行解决」—— 本来就没出错。
    const notice = data.level === 'info';
    enqueue(notice ? 'notice' : 'error', {
      code: String(code || 'UNKNOWN'),
      step: String(data.step || data.stage || ''),
      category: String(data.category || ''),
      // ⭐ 客户端就洗掉 —— 隐私不该离开这台机器去网络上转一圈
      message: scrubText(data.message, 200)
    });
    // 记下这次报错，等"是否自行解决"的信号
    if (!notice) pendingHeal = { code: String(code || ''), at: Date.now() };
  }

  /**
   * 自愈信号 —— 这是衡量 advice 质量的关键。
   * 报错后 N 分钟内如果同一功能重试成功，说明用户按你的方案解决了。
   */
  function heal(feature) {
    if (!pendingHeal) return;
    const minutes = (Date.now() - pendingHeal.at) / 60000;
    if (minutes > 30) { pendingHeal = null; return; }   // 超过 30 分钟不算自愈
    enqueue('heal', {
      code: pendingHeal.code,
      feature: String(feature || ''),
      minutes_bucket: minutes < 1 ? '<1min' : minutes < 5 ? '1-5min'
        : minutes < 15 ? '5-15min' : '15-30min',
      recovered: true
    });
    pendingHeal = null;
  }

  /** 首次使用漏斗。每步只报一次，靠 localStorage 记。 */
  const FUNNEL_KEY = 'v7.telemetry.funnel.v1';
  const FUNNEL_STEPS = ['installed', 'photoshop_connected', 'first_generate', 'first_return'];

  function funnel(step) {
    if (FUNNEL_STEPS.indexOf(step) < 0) return;
    try {
      seenSteps = JSON.parse(root.localStorage.getItem(FUNNEL_KEY) || '{}');
    } catch (_) { seenSteps = {}; }
    if (seenSteps[step]) return;              // 已报过，不重复
    seenSteps[step] = true;
    try { root.localStorage.setItem(FUNNEL_KEY, JSON.stringify(seenSteps)); } catch (_) {}
    enqueue('funnel', { step: step });
  }

  function usage(extra) {
    const data = extra || {};
    const minutes = (Date.now() - sessionStart) / 60000;
    enqueue('usage', {
      session_minutes_bucket: minutes < 5 ? '<5min' : minutes < 30 ? '5-30min'
        : minutes < 120 ? '30-120min' : '120min+',
      feature: String(data.feature || '')
    });
  }

  /**
   * 把报错状态附到客服工单里 —— 用户要求的：
   * "把报错状态作为可以发给客服的一部分，这样即便匿名也可以收到报错相关的内容"
   *
   * ⚠ 附带的是"洗过的"文本，不是原始错误。原始错误可能含客户名。
   */
  function ticketAttachment(code, info) {
    const data = info || {};
    const lines = [
      '【自动附带 · 报错信息】',
      '错误码：' + String(code || ''),
      '发生步骤：' + String(data.step || data.stage || ''),
      '消息：' + String(data.message || '').slice(0, 200),
      '版本：' + appVersion(),
      '设备档位：' + (data.deviceTier || '未知')
    ];
    return lines.join('\n');
  }

  // ------------------------------------------------------------ 启动

  function start() {
    if (started) return;
    started = true;
    sessionStart = Date.now();
    if (!enabled()) return;
    boot();
    collectDevice();
    funnel('installed');
    timer = setInterval(flush, SEND_INTERVAL);
    // 关页面时补发一次。用 sendBeacon 更可靠，但 Tauri 侧未必支持，所以兜底 flush
    if (root.addEventListener) {
      root.addEventListener('visibilitychange', function () {
        if (root.document && root.document.visibilityState === 'hidden') {
          usage();
          flush();
        }
      });
    }
    // ⭐ 使用时长心跳（2026-10-01）。
    //   ⚠ 只靠 visibilitychange 不够：用户直接点 × 关软件、或者进程被结束，
    //   那个事件根本不来 —— 于是"用了多久"这条数据全丢。
    //   改成每 12 分钟报一次增量，最坏情况只丢最后 12 分钟。
    //   报的是【本次增量】，不是会话总时长，这样重复上报不会把数字叠加。
    let lastUsageAt = sessionStart;
    usageTimer = setInterval(function () {
      const now = Date.now();
      const minutes = (now - lastUsageAt) / 60000;
      if (minutes < 1) return;
      lastUsageAt = now;
      enqueue('usage', {
        session_minutes_bucket: minutes < 5 ? '<5min' : minutes < 30 ? '5-30min'
          : minutes < 120 ? '30-120min' : '120min+',
        // 标明这是增量，聚合时不要当总时长累加
        kind: 'heartbeat'
      });
      flush();
    }, 12 * 60 * 1000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (usageTimer) clearInterval(usageTimer);
    timer = null;
    usageTimer = null;
    started = false;
  }

  return {
    start: start,
    stop: stop,
    flush: flush,
    enabled: enabled,
    setEnabled: setEnabled,
    deviceId: deviceId,
    boot: boot,
    task: task,
    error: error,
    heal: heal,
    funnel: funnel,
    usage: usage,
    ticketAttachment: ticketAttachment,
    // 给测试用
    _delivery: function(){return {lastSentAt,dropped};},
    _queue: function () { return queue.slice(); },
    // ⚠ 取走并清空队列。测试只给 _queue()（返回副本）是不够的 ——
    //   对副本 splice 清不掉真队列，事件会跨用例累积，断言全乱。
    _drain: function () { const items = queue.slice(); queue.length = 0; return items; },
    _bucket: bucket
  };
});
