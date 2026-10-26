// V8 链路验证 UXP 薄桥：明文、无业务、无密钥，只执行 Photoshop 原子操作。
const ps = require('./ps-actions.js');

const BRIDGE_URL = 'http://127.0.0.1:37889';
// ⚠⚠ 2026-10-07 改过一次：'v8-link-validation-uxp' → 'v7-link-validation-uxp'。
//   这是 UXP ↔ Rust 认身份的暗号，**三处必须逐字一致**，改错一处就是静默配对失败
//   （界面表现＝插件永远连不上，日志里只说"等待外部 UI"）。
//   另外两处：ui-pure/main.js 的 LINK_CLIENT_ID、src-tauri/src/main.rs 的 LINK_CLIENT_ID。
//   改完必须三处一起 grep 复核。
const CLIENT_ID = 'v7-link-validation-uxp';
// ⚠ 版本号只在这里写一次（scripts/sync-version.cjs 认的就是 `bridgeVersion: '数字'` 这一处），
//   握手上报和面板上显示的都读它。2026-10-18 以前面板上手写着 v0.1.8，跟真实版本对不上。
const BRIDGE_INFO = { bridgeVersion: '1.9.22' };
// 轮询间隔。⚠ 不是常量 —— UI 侧设置里可以调，值随每次 /v8/commands 响应下发。
// 这样试 hover 联动手感时不用反复重载插件。
// 为什么要能调: hover 缩略图 → PS 里换显示，延迟主要卡在这个轮询上。
// 180ms 时平均要等 90ms 才被捞走；调到 40ms 就明显跟手，代价是 PS 里每秒多跑几次。
let POLL_MS = 180;
const POLL_MIN = 20, POLL_MAX = 2000;
// 长轮询（2026-10-20）：取命令时让桌面端最多挂着等这么久，有命令立刻回。见 poll() 末尾。
const LONG_POLL_WAIT_MS = 5000;
let running = true;
let connected = false;
let serverSessionId = '';
let bridgeToken = '';
let activeCommand = null;
let pairGeneration = 0;
let lastText = '正在找修图轮椅…';
let serial = Promise.resolve();

function setPanel(text, ok) {
  lastText = String(text || '');
  try {
    const status = document.getElementById('status');
    const dot = document.getElementById('dot');
    if (status) status.textContent = lastText;
    if (dot) dot.classList.toggle('ok', !!ok);
    // 连上了就收起「启动修图轮椅」；没连上才给按钮
    const launchRow = document.getElementById('launchRow');
    if (launchRow) launchRow.style.display = ok ? 'none' : 'block';
  } catch (_) {}
}

// ⭐ 2026-10-18 没连上修图轮椅时，面板上给一个「启动修图轮椅」按钮（用户：「从桥接插件里面引导用户启动我们正式版软件」）。
//   走 wheelchair-v7:// 链接 —— 软件每次启动都会在当前用户的注册表里登记这个链接（src-tauri/src/url_scheme.rs），
//   要 manifest 里的 launchProcess 权限；PS 会先弹「允许插件打开外部程序吗」，点允许才执行（docs/239 §5）。
//   ⚠ openExternal 不抛异常：成功回 ""、失败回错误文字 —— 必须判返回值，不然又是「点了没反应」。
//   require('uxp') 放在点击里：测试用 vm 跑这个文件时没有 uxp 模块。
let launchBusy = false;
async function launchApp() {
  if (launchBusy) return;
  launchBusy = true;
  const button = document.getElementById('launch');
  const hint = document.getElementById('launchHint');
  if (button) button.disabled = true;
  const manual = '。请双击桌面上的「修图轮椅」图标打开。';
  try {
    const error = await require('uxp').shell.openExternal('wheelchair-v7://open', '打开修图轮椅主程序，好在 Photoshop 里接着修图');
    if (hint) hint.textContent = error ? '没能打开修图轮椅：' + error + manual : '已经叫修图轮椅启动了，连上后上面会变绿。';
  } catch (e) {
    if (hint) hint.textContent = '没能打开修图轮椅：' + ((e && e.message) || e) + manual;
  } finally {
    setTimeout(() => { launchBusy = false; if (button) button.disabled = false; }, 8000);
  }
}
try {
  const button = document.getElementById('launch');
  if (button) button.addEventListener('click', launchApp);
  const version = document.getElementById('version');
  if (version) version.textContent = 'v' + BRIDGE_INFO.bridgeVersion;
} catch (_) {}
function log(message, level, meta) {
  const payload = Object.assign({ type: 'log', level: level || 'info', message: String(message || ''), at: new Date().toISOString() }, meta || {});
  post('/v8/events', payload).catch(() => {});
}
ps.setLogSink((message, level) => log(message, level, activeCommand || {}));
ps.setDocumentEventSink(event => { if (connected) post('/v8/events', event).catch(e => log('项目事件发送失败: ' + e.message, 'warn')); });
const documentWatch = setInterval(() => {
  if (!running || !connected || activeCommand) return;
  try { ps.observeDocuments(); } catch (e) { log('文档列表读取失败: ' + e.message, 'warn'); }
}, 1600);
// Native export notifications vary by Photoshop version. Only report an
// explicit export/copy descriptor with a document ID; never guess by filename.
let exportListener = null;
try {
  const action = require('photoshop').action;
  exportListener = (name, descriptor) => {
    if (activeCommand || !descriptor) return; // excludes automatic checkpoints
    const isExport = name === 'export' || (name === 'save' && (descriptor.copy === true || descriptor.asCopy === true));
    if (!isExport) return;
    const target = (descriptor._target || []).find(row => row._ref === 'document' && row._id != null);
    const id = descriptor.documentID || (target && target._id);
    if (id != null) ps.notifyExport(id, 'photoshop-notification');
    else log('Photoshop 导出通知缺少文档 ID；请在项目中手动标记导出状态', 'info');
  };
  action.addNotificationListener(['export', 'save'], exportListener).catch(e => log('原生导出监听不可用，请在项目中手动标记导出状态: ' + e.message, 'warn'));
} catch (e) { log('原生导出监听不可用，请在项目中手动标记导出状态: ' + e.message, 'warn'); }

async function request(path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-V7-Bridge-Client': CLIENT_ID }, opts.headers || {});
  if (bridgeToken) opts.headers['X-V7-Bridge-Token'] = bridgeToken;
  // Keep the credential in a header only. Query-string tokens leak into
  // proxy/access logs and are unnecessary for the local bridge contract.
  const response = await fetch(BRIDGE_URL + path, opts);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { throw new Error('桥返回非 JSON: ' + text.slice(0, 200)); }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || ('HTTP ' + response.status));
    error.status = response.status;
    error.code = response.status === 401 || response.status === 403 ? 'BRIDGE_PAIRING_EXPIRED' : 'BRIDGE_REQUEST_FAILED';
    throw error;
  }
  return data;
}
function post(path, payload) {
  return request(path, { method: 'POST', body: JSON.stringify(payload || {}) });
}

async function announceReady() {
  await post('/v8/events', {
    type: 'ready',
    clientId: CLIENT_ID,
    bridgeVersion: BRIDGE_INFO.bridgeVersion,
    actions: ps.listActions(),
    at: new Date().toISOString()
  });
  connected = true;
  setPanel('已连上修图轮椅', true);
}

async function bootstrap() {
  const data = await request('/v8/bootstrap');
  bridgeToken = String(data.bridgeToken || '');
  serverSessionId = String(data.sessionId || '');
  if (!bridgeToken) throw new Error('桥配对令牌为空');
}

async function recoverPairing(reason) {
  // A host restart invalidates the old token while the UXP panel remains
  // alive. Clear it before re-bootstrap so no command/result is replayed with
  // stale credentials. The next poll receives only newly queued commands.
  bridgeToken = '';
  serverSessionId = '';
  connected = false;
  pairGeneration += 1;
  setPanel('桥会话已变化，正在重新配对…', false);
  try {
    await bootstrap();
    await announceReady();
    return true;
  } catch (error) {
    setPanel('重新配对失败: ' + error.message, false);
    log('重新配对失败: ' + error.message, 'warn', { reason: String(reason || '') });
    return false;
  }
}

function safeError(e) {
  // PS 开着对话框 / 自由变换中：batchPlay 抛 number=9「host is in a modal state」，别把数字 9 当错误码传出去
  const modal = !!e && (Number(e.number) === 9 || String(e.code) === '9' || /host is in a modal state/i.test(String(e.message || '')));
  return {
    code: modal ? 'PS_BUSY' : (e && e.code) || 'UXP_ACTION_FAILED',
    message: (e && e.message) || String(e),
    raw: e && e.raw !== undefined ? e.raw : undefined,
    returnReceipt: e && e.returnReceipt ? e.returnReceipt : undefined,
    returnReceipts: e && e.returnReceipts ? e.returnReceipts : undefined,
    // 出错时的 Photoshop 现场(文档/位深/色彩模式/选区…)，由 ps-actions 的 run() 统一附上。
    // 桌面板的报错卡会把它铺在"当时的情况"那一栏 —— 用户不用再回 PS 里查一遍。
    scene: e && e.scene ? e.scene : undefined
  };
}

async function executeCommand(command) {
  const startedAt = new Date().toISOString();
  const action = String(command && command.action || '');
  let result;
  activeCommand = { requestId: command && command.requestId, action };
  try {
    result = await ps.run(action, command.params || {});
    return { requestId: command.requestId, action, success: true, data: result, error: null, startedAt, finishedAt: new Date().toISOString() };
  } catch (e) {
    return { requestId: command && command.requestId, action, success: false, data: null, error: safeError(e), startedAt, finishedAt: new Date().toISOString() };
  } finally {
    activeCommand = null;
  }
}

function scheduleCommand(command) {
  // Photoshop 修改状态的 action 全部串行；UI 仍可并发提交并由服务端排队。
  serial = serial.then(async () => {
    const commandGeneration = pairGeneration;
    log('开始执行 ' + command.action, 'info', { requestId: command.requestId, action: command.action });
    const result = await executeCommand(command);
    const publishResult = commandGeneration === pairGeneration ? result : Object.assign({}, result, {
      success: false, data: null,
      error: { code: 'BRIDGE_SESSION_CHANGED', message: '宿主桥会话已重启；该 Photoshop 操作可能已执行，但回执未确认，请检查文档后再重试。' }
    });
    // ⚠ 回执体积【成功失败都打】(CLAUDE.md 排查纪律)。
    //   只在挂了之后才打，就永远不知道「没挂的那次」离上限还有多远。
    //   ⚠ 不要用 JSON.stringify(result).length 去量 —— 那会凭空多复制一份几十 MB 的字符串。
    //   直接数 base64 长度即可，误差只有几百字节的元数据。
    let payloadMB = 0;
    try {
      const d = result && result.data;
      if (d) payloadMB = ((String(d.imageBase64 || '').length + String(d.sourceImageBase64 || '').length) / 1024 / 1024);
      if (payloadMB > 0) log('回执体积约 ' + payloadMB.toFixed(1) + 'MB', 'info', { action: command.action });
    } catch (_) {}
    // ⭐ 2026-10-24（V7待办/08，反馈 #12「传回图片后插件会掉，修好 6 张后必现」）：
    //   PS 在后台时大回执那一下的 fetch 会被宿主打断（#14 日志：Network request failed ×19）。
    //   原来一失败就只补发「不带像素的失败回执」，这张图就白算了。现在先【带像素】隔 1 秒重发一次，
    //   还不行才发失败回执。撞上大小上限的不重发（再发也一样大）。
    //   ⭐ 10-24 傍晚模拟（tools/sim/bridge-sim.cjs：PS 在后台 + 15% 请求被打断）：只重发一次时 10 张丢 1 张 ⇒ 改成最多重发 3 次（隔 1 / 2 / 4 秒）。
    //     重复送到不怕：桌面板按 requestId 只认第一份回执（03-bridge-collapse.js linkHandleResult，第二份只多一行日志，不会再贴一次）。
    let sent = false, lastError = null;
    for (let attempt = 0; attempt < 4 && !sent; attempt++) {
      try {
        if (attempt > 0) { const wait = 1000 * Math.pow(2, attempt - 1); log('回执没送到，' + (wait / 1000) + ' 秒后带图重发（第 ' + attempt + ' 次）', 'warn', { action: command.action, error: lastError && lastError.message }); await new Promise(r => setTimeout(r, wait)); }
        await post('/v8/results', publishResult);
        sent = true;
      } catch (e) {
        lastError = e;
        if (/超过上限|请求体|too large|payload/i.test((e && e.message) || '') || (e && e.status)) break;
      }
    }
    if (!sent) try { throw lastError || new Error('回执没送到'); } catch (e) {
      // 回执送不出去时，补发一个不带像素的失败回执，避免 UI 永远停在旧图片。
      // ⚠ 2026-09-11：以前这里把【所有】回传失败都写死成「图片太大，请缩小选区」——
      //   桌面板关了、端口被占、JSON 出错，全都报成「太大」，排查直接被带沟里。
      //   现在只有真的撞上限才这么说，其余原样透出真实原因。
      try {
        const detail = (e && e.message) || String(e);
        const tooLarge = /超过上限|请求体|too large|payload/i.test(detail);
        const sizeHint = payloadMB > 0 ? '（本次约 ' + payloadMB.toFixed(1) + 'MB）' : '';
        const slim = Object.assign({}, publishResult, { success: false, data: null,
          error: {
            code: tooLarge ? 'BRIDGE_PAYLOAD_TOO_LARGE' : 'BRIDGE_RESULT_POST_FAILED',
            message: (tooLarge
              ? '抓取图片太大，桥接回传未完成，请缩小选区后重试' + sizeHint + '：'
              : '回传桥接失败' + sizeHint + '：') + detail,
            raw: detail
          } });
        await post('/v8/results', slim);
      } catch (_) {}
      setPanel('回传失败: ' + e.message, false);
    }
    log(result.success ? '完成 ' + command.action : '失败 ' + command.action + ': ' + result.error.message,
      result.success ? 'success' : 'error', { requestId: command.requestId, action: command.action });
    setPanel(result.success ? '最近完成: ' + command.action : '最近失败: ' + command.action, result.success);
  }).catch(e => log('桥队列异常: ' + e.message, 'error'));
}

// Local UXP experiments share the bridge queue; never run a second PS mutation
// alongside a remotely queued return. Expose only the two diagnostic actions.
window.V7ReturnProbeInvoke = function(action, params) {
  if (action !== 'ps.returnProbe.snapshot' && action !== 'ps.returnProbe.run') return Promise.reject(new Error('不支持的回图诊断动作'));
  const job = serial.then(async () => {
    if (!running) throw new Error('UXP 面板已关闭');
    const result = await executeCommand({requestId:'local-return-' + Date.now(),action,params});
    if (!result.success) throw Object.assign(new Error(result.error.message), result.error);
    return result.data;
  });
  serial = job.then(() => undefined, () => undefined);
  return job;
};

// ⭐⭐ 2026-10-05 诊断（用户报："PS 在后台待一段时间，桌面板就报『Photoshop 插件断开了』"）。
//   ⚠ 这是【只诊断、不改行为】的一步 —— 用户拍的板是"先加诊断再改"。
//   要证明的命题是：**Photoshop 不在前台时，宿主把我们的定时器拖慢了。**
//   证据只能在这里取：定时器是我们设的（POLL_MS），实际隔了多久才跑到，只有这里知道。
//   桌面板那边看到的是"12 秒没有时间戳"，它分不清是"面板被关了"还是"被节流了"——
//   把这里量到的 lag 报上去，两者就分得开了。
//   ⚠ 别用 performance.now 的差值算 HTTP 耗时：那混进了网络和执行时间。
//     量的是【从"本该下一次"到"真的下一次"】这中间的空档（timerLagMs）。
let pollDueAt = 0;                 // 上一次排定下一次轮询的时刻
let netRetries = 0;                // 连续几次网络层错误后立刻重试了（成功一次清零；满 3 次退回定时器）
function pollWithLag() {
  const now = Date.now();
  // ⚠ 2026-10-18 修：pollDueAt 记的已经是「本该跑的时刻」（= 排定时 + POLL_MS），原来这里又减了一次 POLL_MS，少报一个间隔。
  //   桌面板现在拿这个数判断「PS 在后台被节流 / 真的掉线」（ui.html 的 bridgeThrottled），要报准。
  const lag = pollDueAt ? now - pollDueAt : 0;   // 超出应到时刻多久（ms）
  if (lag > Math.max(1000, POLL_MS * 4)) {
    // ⚠ 只在明显超时才报，正常抖动（几十 ms）不刷日志 —— 否则日志会被灌满。
    log('轮询被延迟 ' + Math.round(lag) + 'ms（设定间隔 ' + POLL_MS + 'ms）', 'warn', {
      pollLagMs: Math.round(lag), pollMs: POLL_MS,
      visibility: (typeof document !== 'undefined' && document.visibilityState) || 'unknown'
    });
  }
  return poll();
}

async function poll() {
  if (!running) return;
  let longPoll = false, startedAt = Date.now(), gotCommands = false;
  try {
    if (!bridgeToken) await bootstrap();
    const response = await request('/v8/commands?clientId=' + encodeURIComponent(CLIENT_ID) + '&wait=' + LONG_POLL_WAIT_MS);
    // UI 每次重启都会生成新的 sessionId。即使 UXP 自己没断线，
    // 也必须重新发送 ready，让新 UI 拿到完整 action 目录。
    if (response.sessionId && !serverSessionId) {
      // 首次轮询只记录当前会话；启动阶段 announceReady 已经完成握手。
      serverSessionId = response.sessionId;
    } else if (response.sessionId && response.sessionId !== serverSessionId) {
      serverSessionId = response.sessionId;
      connected = false;
      await bootstrap();
    }
    // ⭐ 2026-10-24（docs/273 #14，用户报面板定格在「ready 回传失败」，桌面板一直显示没连上）：
    //   原来这里 ready 失败后下一行照样 connected = true —— 之后的轮询都以为连着，再也不重发 ready，
    //   桌面板收不到报到、面板文字也永远停在那句报错上。
    //   现在只有 announceReady 真的成功了（它自己会设 connected = true）才算连上；失败就留着 false，下一轮接着发。
    if (!connected) {
      try { await announceReady(); }
      catch (readyError) { setPanel('桥已发现但 ready 回传失败（正在重试）: ' + readyError.message, false); }
    }
    // UI 侧下发的轮询间隔。夹在 20~2000ms，防止填个 0 把 PS 卡死。
    if (response.pollMs != null) {
      const next = Math.max(POLL_MIN, Math.min(POLL_MAX, Number(response.pollMs) || POLL_MS));
      if (next !== POLL_MS) { POLL_MS = next; log('轮询间隔改为 ' + POLL_MS + 'ms', 'info'); }
    }
    if (Array.isArray(response.commands)) response.commands.forEach(scheduleCommand);
    longPoll = response.longPoll === true;
    gotCommands = Array.isArray(response.commands) && response.commands.length > 0;
    netRetries = 0;
  } catch (e) {
    if (connected) log('外部 UI 连接中断: ' + e.message, 'warn');
    connected = false;
    const recovered = e && (e.status === 401 || e.status === 403)
      ? await recoverPairing(e.code || e.status) : false;
    if (!recovered) setPanel('没连上修图轮椅：它开着吗？', false);
    // ⭐ 2026-10-24（V7待办/08）：网络层错误（fetch 自己抛的，没有 HTTP 状态 = 请求被打断 / 桌面板没开）
    //   原来要等下一轮定时器 —— PS 在后台时定时器会被拖到几十秒（#14：拖了 15 秒、之后 56 秒没请求）。
    //   现在立刻再试，最多连续 3 次，之后退回定时器（桌面板真没开时不会狂发）。
    if (!recovered && running && e && !e.status && netRetries < 3) {
      netRetries += 1;
      pollDueAt = 0;
      Promise.resolve().then(poll);
      return;
    }
  }
  // ⭐ 长轮询：桌面端真的挂着等过（回了 longPoll:true）→ 不走定时器，马上发下一次。
  //   PS 不在前台时宿主会把 setTimeout 拖到几秒一次（反馈「PS 在后台插件变慢」），网络回调不走定时器。
  //   ⚠ 未在真机 PS 后台下实测过「网络回调不被拖慢」，发版前要真机确认（docs/256）。
  //   旧桌面端不认 wait、不回 longPoll → 照旧定时轮询，不会空转狂发。
  //   空手秒回（< 50ms 又没命令）也退回定时器，防止哪天桌面端出毛病变成死循环狂刷。
  if (longPoll && (gotCommands || Date.now() - startedAt >= 50)) {
    pollDueAt = 0;
    Promise.resolve().then(poll);
    return;
  }
  // ⭐ 上报这一轮的实际间隔（见 pollWithLag 的注释）。挂在查询串上，服务端好存。
  pollDueAt = Date.now() + POLL_MS;
  setTimeout(pollWithLag, POLL_MS);
}

bootstrap().then(announceReady).catch(e => { connected = false; setPanel('没连上修图轮椅：它开着吗？', false); });
poll();

window.addEventListener('unload', () => {
  running = false; clearInterval(documentWatch);
  if (exportListener) { try { require('photoshop').action.removeNotificationListener(['export', 'save'], exportListener); } catch (_) {} }
});
