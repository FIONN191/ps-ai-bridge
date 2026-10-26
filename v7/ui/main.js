// ============================================================
//  ui-desktop — V8 UI 桌面测试壳
//  透明无边框窗口, 加载 ui.html (叠压卡片原型), 可拖拽
//  参考 V7 orbit 的窗口处理: resizable:false / focusable:false /
//  alwaysOnTop / 主进程高频拖拽跟随
// ============================================================
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, Notification, nativeImage } = require('electron');
const { installSafeOutput } = require('../foundation/safe-output');
installSafeOutput();
const http = require('http');
const path = require('path');
const fs = require('fs');   // 生成缓存读写(见下方 CACHE_ROOT)
const crypto = require('crypto');
const photoshopLauncher = require('../foundation/photoshop/photoshop-launcher.js');
const photoshopService = photoshopLauncher.createPhotoshopService();
const { registerAgentIpc } = require('../foundation/agent/agent-ipc.js');
const { registerAgentPresetInbox } = require('../foundation/agent/agent-preset-inbox.js');
const { registerSecretsIpc } = require('../foundation/security/secret-vault.js');
const { installResident } = require('../foundation/planner/electron-resident.js');
const { registerCacheIpc } = require('../foundation/cache/cache-lifecycle.js');
const { registerBrowserIpc } = require('../foundation/browser/browser-host.js');
const { createUxpInstaller } = require('../foundation/photoshop/uxp-installer.js');
let resident = null;
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => { if (resident) resident.restore(); });

// 窗口大小: 贴合内容区(卡片堆 + 右侧弹出区 + 任务堆)
// H = 1100: 留足报错堆(最多3张) + 任务堆(最多4张)的空间，避免防越界逻辑强制重叠
// 详情卡右侧重阴影需要额外透明安全区，避免在无边框窗口边界被裁切。
const W = 1020, H = 1100;
const LINK_PORT = 37889;
// ⚠ 必须和 src-tauri/src/main.rs 的 MAX_BODY_BYTES 一个数(铁律 14 双壳同步)。
//   2026-09-11 之前这里是 192MB、Tauri 是 64MB —— 同一张 4096×4096 的图
//   在 Electron 下抓得回来、Tauri 下报「桥接传回未完成」，查了半天才发现是两边不一样。
//   算账见 main.rs 同名常数上面的注释。
const LINK_MAX_JSON_BYTES = 256 * 1024 * 1024;
// 一次最多生成多少张。⚠ 必须和 ui.html 的 AI_BATCH_MAX、tauri-adapter.js 同值(铁律 14)。
//   只改界面不改这里的话，界面显示上限 18、后端照样肯跑更多。
const AI_BATCH_MAX = 18;

let win = null;
let agentIpc = null;
let browserHost = null;
let uxpInstaller = null;
let generationShortcut = '';   // 2026-10-18 晚：三个快捷键默认都没有（用户设了才注册）
// ⭐ 2026-10-14：加参考图快捷键（用户要求"放到和开始计算同时，那就一起的位置"）。
//   ⚠ 跟 generationShortcut 分开存 —— 两个键各自独立换绑，互不影响。
let referenceShortcut = '';
let collapseShortcut = '';   // ⭐ 2026-10-17 夜：一键收起 / 展开（见 registerCollapseShortcut）
let providerShortcut = '';   // ⭐ 2026-10-21：换下一家渠道（见 registerProviderShortcut）
let pointerProbeTimer = null;
let mouseIgnored = false;

// When a transparent window is ignored, Chromium may stop delivering the
// mousemove that would normally tell the renderer to reclaim the pointer.
// Probe only during that state and let the renderer reuse its existing hit test.
function stopPointerProbe() {
  if (pointerProbeTimer) clearInterval(pointerProbeTimer);
  pointerProbeTimer = null;
}

function startPointerProbe() {
  if (pointerProbeTimer) return;
  pointerProbeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !mouseIgnored || setupHost?.isOpen?.()) return;
    if (dragBase || (browserHost && (browserHost.state().workspace || browserHost.state().open))) return;
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    win.webContents.send('win:cursorProbe', { x: p.x - wx, y: p.y - wy });
  }, 80);
}


function electronShortcut(value) {
  const parts = String(value || 'mod+enter').toLowerCase().split('+').map(x => x.trim()).filter(Boolean);
  const out = [];
  if (parts.includes('mod')) out.push('CommandOrControl');
  if (parts.includes('ctrl')) out.push('Control');
  if (parts.includes('alt')) out.push('Alt');
  if (parts.includes('shift')) out.push('Shift');
  const key = parts.find(x => !['mod', 'ctrl', 'alt', 'shift'].includes(x));
  if (!key) return '';
  const names = { enter: 'Enter', space: 'Space', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete' };
  out.push(names[key] || key.toUpperCase());
  return out.join('+');
}

function registerGenerationShortcut(value) {
  // 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 只取消原来那个，回成功（跟 Tauri 壳 set_*_shortcut 一样，铁律 14）
  if (!String(value || '').trim()) { try { if (generationShortcut) globalShortcut.unregister(generationShortcut); } catch (_) {} generationShortcut = ''; return { ok: true, shortcut: '', cleared: true }; }
  const next = electronShortcut(value);
  if (!next) return { ok: false, error: '快捷键格式无效' };
  try { globalShortcut.unregister(generationShortcut); } catch (_) {}
  try {
    const ok = globalShortcut.register(next, () => {
      if (win && !win.isDestroyed()) win.webContents.send('shortcut:generation');
    });
    if (ok) generationShortcut = next;
    // 注册失败最常见的原因是组合键被别的软件先占了。必须回报给界面，
    // 否则用户只会看到"按了没反应", 无从判断是程序坏了还是被占用。
    console.log('[Shortcut] 注册 ' + next + ': ' + (ok ? '成功' : '失败(可能被其他软件占用)'));
    return { ok, shortcut: next, error: ok ? '' : '组合键可能已被其他软件占用' };
  } catch (e) {
    console.log('[Shortcut] 注册 ' + next + ' 异常: ' + e.message);
    return { ok: false, shortcut: next, error: e.message };
  }
}

// ⭐ 2026-10-14：加参考图快捷键。跟上面那份逐行对称，只有两处不同：
//   · 存的是 referenceShortcut
//   · 发的是 'shortcut:reference'（界面收到就去抓当前 PS 选区加进参考图）
//   ⚠⚠ 双壳必须同步（铁律 14）：这边改了，preload.js / tauri-adapter.js / main.rs
//     三处都要改，否则【不报错，只是按了没反应】。
function registerReferenceShortcut(value) {
  // 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 只取消原来那个，回成功（跟 Tauri 壳 set_*_shortcut 一样，铁律 14）
  if (!String(value || '').trim()) { try { if (referenceShortcut) globalShortcut.unregister(referenceShortcut); } catch (_) {} referenceShortcut = ''; return { ok: true, shortcut: '', cleared: true }; }
  const next = electronShortcut(value);
  if (!next) return { ok: false, error: '快捷键格式无效' };
  try { globalShortcut.unregister(referenceShortcut); } catch (_) {}
  try {
    const ok = globalShortcut.register(next, () => {
      if (win && !win.isDestroyed()) win.webContents.send('shortcut:reference');
    });
    if (ok) referenceShortcut = next;
    console.log('[Shortcut] 注册(参考图) ' + next + ': ' + (ok ? '成功' : '失败(可能被其他软件占用)'));
    return { ok, shortcut: next, error: ok ? '' : '组合键可能已被其他软件占用' };
  } catch (e) {
    console.log('[Shortcut] 注册(参考图) ' + next + ' 异常: ' + e.message);
    return { ok: false, shortcut: next, error: e.message };
  }
}

// ⭐ 2026-10-17 夜：一键收起 / 展开快捷键（同一个键：收起 ↔ 展开）。跟上面两份逐行对称：
//   存的是 collapseShortcut，发的是 'shortcut:collapse'。
//   ⚠⚠ 双壳必须同步（铁律 14）：preload.js / tauri-adapter.js / main.rs 一起改。
function registerCollapseShortcut(value) {
  // 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 只取消原来那个，回成功（跟 Tauri 壳 set_*_shortcut 一样，铁律 14）
  if (!String(value || '').trim()) { try { if (collapseShortcut) globalShortcut.unregister(collapseShortcut); } catch (_) {} collapseShortcut = ''; return { ok: true, shortcut: '', cleared: true }; }
  const next = electronShortcut(value);
  if (!next) return { ok: false, error: '快捷键格式无效' };
  try { globalShortcut.unregister(collapseShortcut); } catch (_) {}
  try {
    const ok = globalShortcut.register(next, () => {
      if (win && !win.isDestroyed()) win.webContents.send('shortcut:collapse');
    });
    if (ok) collapseShortcut = next;
    console.log('[Shortcut] 注册(一键收起) ' + next + ': ' + (ok ? '成功' : '失败(可能被其他软件占用)'));
    return { ok, shortcut: next, error: ok ? '' : '组合键可能已被其他软件占用' };
  } catch (e) {
    console.log('[Shortcut] 注册(一键收起) ' + next + ' 异常: ' + e.message);
    return { ok: false, shortcut: next, error: e.message };
  }
}
// ⭐ 2026-10-21：换下一家渠道快捷键。跟 registerCollapseShortcut 逐行对称：存 providerShortcut，发 'shortcut:provider'。
//   ⚠⚠ 双壳必须同步（铁律 14）：preload.js / tauri-adapter.js / main.rs 一起改。
function registerProviderShortcut(value) {
  if (!String(value || '').trim()) { try { if (providerShortcut) globalShortcut.unregister(providerShortcut); } catch (_) {} providerShortcut = ''; return { ok: true, shortcut: '', cleared: true }; }
  const next = electronShortcut(value);
  if (!next) return { ok: false, error: '快捷键格式无效' };
  try { globalShortcut.unregister(providerShortcut); } catch (_) {}
  try {
    const ok = globalShortcut.register(next, () => {
      if (win && !win.isDestroyed()) win.webContents.send('shortcut:provider');
    });
    if (ok) providerShortcut = next;
    console.log('[Shortcut] 注册(换渠道) ' + next + ': ' + (ok ? '成功' : '失败(可能被其他软件占用)'));
    return { ok, shortcut: next, error: ok ? '' : '组合键可能已被其他软件占用' };
  } catch (e) {
    console.log('[Shortcut] 注册(换渠道) ' + next + ' 异常: ' + e.message);
    return { ok: false, shortcut: next, error: e.message };
  }
}
const blockingWindows = new Map();
const blockingQueue = new Map();

// ── V8 最小链路桥 ──
// UI 只负责排队，UXP 通过本地 HTTP 轮询命令并传回结果。
// 这里不放账号、计费、引擎或授权逻辑；正式 Tauri 侧沿用同一协议即可。
const linkCommands = [];
let linkServer = null;
let linkSeq = 0;
let linkSessionId = 'ui-' + crypto.randomBytes(16).toString('base64url');
let linkBridgeToken = crypto.randomBytes(32).toString('base64url');
let linkTokenIssuedAt = Date.now();
const LINK_TOKEN_TTL_MS = 60 * 60 * 1000;
// ⚠⚠ 2026-10-07：'v8-link-validation-uxp' → 'v7-link-validation-uxp'。
//   三处配对串必须逐字一致（另两处：uxp-bridge/index.js 的 CLIENT_ID、
//   src-tauri/src/main.rs 的 LINK_CLIENT_ID）。只改一处＝静默配对失败。
const LINK_CLIENT_ID = 'v7-link-validation-uxp';
const LINK_ACTIONS = new Set(require('../uxp-bridge/action-names.json'));
// UXP 轮询间隔(毫秒)。随 /v8/commands 响应下发，设置里可调。
// 调小 = hover 联动更跟手，代价是 Photoshop 里每秒多跑几次轮询。
let linkPollMs = 180;
const linkBridge = { connected: false, clientId: null, bridgeVersion: null, lastReadyAt: null, lastEventAt: null, lastPollAt: null };
// 长轮询：挂着等命令的 /v8/commands（带 ?wait=）。有命令入队就逐个叫醒。
// ⚠ 必须和 src-tauri/src/main.rs 的 wait_for_commands / LINK_LONG_POLL_MAX 保持一致(铁律 14)。
const LINK_LONG_POLL_MAX_MS = 5000;
const linkWaiters = new Set();
function wakeLinkWaiters() { for (const wake of Array.from(linkWaiters)) wake(); }

function linkJson(res, status, payload) {
  const body = JSON.stringify(payload == null ? {} : payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > LINK_MAX_JSON_BYTES) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('请求体超过 ' + Math.round(LINK_MAX_JSON_BYTES / 1024 / 1024) + 'MB'));
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('JSON 格式无效: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function makeLinkRequest(payload) {
  const action = String(payload && payload.action || '').trim();
  if (!action) throw new Error('链路 action 不能为空');
  if (!LINK_ACTIONS.has(action)) throw new Error('链路 action 不在 Photoshop 白名单内');
  const requestId = 'link-' + Date.now().toString(36) + '-' + (++linkSeq).toString(36);
  return {
    requestId,
    action,
    params: payload && payload.params && typeof payload.params === 'object' ? payload.params : {},
    createdAt: new Date().toISOString()
  };
}

// ── V7 AI 全量验证：请求在 Electron 主进程执行，UXP 永远只处理 Photoshop 原子操作 ──
// 这里不保存 Key、不写磁盘；Key 由验证卡本次请求传入，调用结束后随内存对象释放。
const aiControllers = new Map();
let aiSeq = 0;

function aiCleanBase64(value) {
  const text = String(value || '').trim();
  const comma = text.indexOf(',');
  return text.indexOf('data:') === 0 && comma >= 0 ? text.slice(comma + 1) : text;
}

function aiMime(value, fallback = 'image/png') {
  const m = /^data:([^;,]+)/i.exec(String(value || ''));
  return m ? m[1] : fallback;
}

function aiSendProgress(sender, data) {
  try { if (sender && !sender.isDestroyed()) sender.send('ai:progress', data); } catch (_) {}
}

function aiValidateUrl(raw, label) {
  const value = String(raw || '').trim();
  if (!value) throw new Error((label || 'API URL') + '不能为空');
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error((label || 'API URL') + '格式无效'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error((label || 'API URL') + '只允许 http/https');
  }
  return value.replace(/\/+$/, '');
}

function aiEndpoint(payload) {
  const rawEndpoint = String(payload.endpoint || '').trim();
  if (rawEndpoint && /^https?:\/\//i.test(rawEndpoint)) return aiValidateUrl(rawEndpoint, 'Endpoint');
  const base = aiValidateUrl(payload.baseUrl || payload.url, 'API URL');
  if (rawEndpoint) {
    if (!rawEndpoint.startsWith('/')) throw new Error('Endpoint 路径必须以 / 开头，或填写完整 http/https URL');
    return base + rawEndpoint;
  }
  const protocol = String(payload.protocol || 'gemini').toLowerCase();
  const gpt = aiIsGptImage(payload);
  if (protocol === 'openai' || gpt) {
    const parsed = new URL(base);
    if (/\/images\/(?:generations|edits)\/?$/i.test(parsed.pathname)) return base;
    if (gpt) parsed.pathname = parsed.pathname.replace(/\/v1beta\/?$/i, ''); // 香蕉那套地址填到了 /v1beta 也能接上
    const action = gpt || aiInputImages(payload).length ? 'edits' : 'generations';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + (/\/v1\/?$/i.test(parsed.pathname) ? '/images/' : '/v1/images/') + action;
    return parsed.toString();
  }
  const model = encodeURIComponent(String(payload.model || '').trim());
  if (!model) throw new Error('模型不能为空');
  if (/\/v1beta\/models\/[^/]+:generateContent(?:\?|$)/i.test(base)) return base;
  if (/\/v1beta$/i.test(base)) return base + '/models/' + model + ':generateContent';
  return base + '/v1beta/models/' + model + ':generateContent';
}

function aiInputImages(payload) {
  const images = [];
  function add(value, mime) {
    const b64 = aiCleanBase64(value).replace(/\s/g, '');
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1 || (b64.includes('=') && b64.length % 4 !== 0)) {
      throw new Error('图片数据无效，请重新选择参考图或重新抓图');
    }
    images.push({ b64, mime: mime || aiMime(value) });
  }
  const input = payload.inputImageBase64 || payload.inputBase64;
  if (input) add(input, payload.inputMime);
  (Array.isArray(payload.refImages) ? payload.refImages : []).forEach(ref => {
    add(typeof ref === 'string' ? ref : ref && (ref.imageBase64 || ref.base64), ref && ref.mime);
  });
  return images;
}

function aiAppendQuery(url, key, value) {
  if (!value) return url;
  const joiner = url.indexOf('?') >= 0 ? '&' : '?';
  return url + joiner + encodeURIComponent(key) + '=' + encodeURIComponent(value);
}

function aiSizePixels(size, aspect) {
  const side = ({ '1K': 1024, '2K': 2048, '4K': 4096 })[String(size || '1K').toUpperCase()] || 1024;
  const ar = String(aspect || '1:1');
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return side + 'x' + side;
  const ratio = Number(match[1]) / Number(match[2]);
  if (ratio >= 1) return side + 'x' + Math.max(1, Math.round(side / ratio));
  return Math.max(1, Math.round(side * ratio)) + 'x' + side;
}

// ⭐ 2026-10-23（用户报：阿吉 GPT Image 加两张参考图 ⇒ HTTP 400，V6 正常）：
//   V6 只要模型名带 gpt-image 就单独走 OpenAI 的 /v1/images/edits 表单上传（V6 host/ai-api.js callGptImageNewApi），
//   V7 原来照香蕉一律发 Gemini 格式 ⇒ 阿吉不认。这里照 V6 补回：不管连接上选的协议，GRS 除外（那边是另一套协议，6.7.0 要删）。
//   跟 V6 对齐的几处：多张图字段都叫 image（不是 image[]）；尺寸用 GPT 支持的固定档；没图塞 1×1 透明图；回任务号就轮询。
//   ⚠ tauri-adapter.js 有同一套（铁律 14），两边一起改。
function aiIsGptImage(payload) {
  return /gpt-image/i.test(String(payload && payload.model || '')) && String(payload && payload.connectionSlot || '') !== 'grs' && String(payload && payload.provider || '') !== 'grs';
}
const AI_GPT_BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function aiGptSize(size, aspect) {
  const key = String(size || '1K').toUpperCase();
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect || ''));
  const ratio = match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : 0;
  const wide = ratio > 1, tall = ratio > 0 && ratio < 1;
  if (key === '4K') return tall ? '2160x3840' : '3840x2160'; // 4K 没有 1:1，方图/Auto 都给横屏（V6 同款）
  if (key === '2K') return tall ? '1152x2048' : wide ? '2048x1152' : '2048x2048';
  return tall ? '1024x1536' : wide ? '1536x1024' : '1024x1024';
}

// 异步回执：{task_id} 或 {data:{task_id}}；轮询结果：{data:{status, data:[…]}}（V6 _extractGptImageBase64 同款判据）
function aiGptTaskId(body) {
  return String(body && (body.task_id || (body.data && !Array.isArray(body.data) && body.data.task_id)) || '');
}

function aiGptTaskState(body) {
  const d = body && body.data && !Array.isArray(body.data) && typeof body.data === 'object' ? body.data : body || {};
  const st = String(d.status || '').toLowerCase();
  if (['failure', 'failed', 'error'].includes(st)) {
    const why = d.fail_reason || d.error || d.message;
    return { failed: why ? (typeof why === 'string' ? why : JSON.stringify(why).slice(0, 200)) : '未知错误' };
  }
  const done = ['success', 'succeeded', 'completed', 'done', 'finished'].includes(st);
  return { done, pending: !!st && !done, unknown: !st };
}

// 2026-10-24（V7待办/05）：自己填了完整 endpoint（如 https://host/proxy/v1/images/generations）时，保留 /images/ 前面的前缀
function aiGptPollUrl(url, id) {
  const u = new URL(url), tail = '/images/tasks/' + encodeURIComponent(id), at = u.pathname.toLowerCase().lastIndexOf('/images/');
  u.pathname = at >= 0 ? u.pathname.slice(0, at) + tail : '/v1' + tail;
  u.search = '';
  return u.toString();
}

async function aiGptPoll(built, firstBody, signal) {
  const pollUrl = aiGptPollUrl(built.url, aiGptTaskId(firstBody));
  const headers = built.headers.Authorization ? { Authorization: built.headers.Authorization } : {};
  const start = Date.now();
  const stop = () => Object.assign(new Error('已取消'), { name: 'AbortError' });
  let errs = 0, blank = 0;
  while (true) {
    for (let w = 0; w < 3; w++) { if (signal.aborted) throw stop(); await new Promise(r => setTimeout(r, 1000)); }
    if (signal.aborted) throw stop();
    if (Date.now() - start > 3600000) throw Object.assign(new Error('GPT Image 等结果超时（1 小时）'), { code: 'AI_UPSTREAM_TIMEOUT' });
    let response;
    try { response = await fetch(pollUrl, { method: 'GET', headers, signal }); }
    catch (e) { if (signal.aborted) throw stop(); if (++errs >= 5) throw new Error('GPT Image 查询结果连续失败：' + (e.message || e)); continue; }
    if (!response.ok) { if (++errs >= 5) throw new Error('GPT Image 查询结果连续报错 HTTP ' + response.status); continue; }
    errs = 0;
    let body = null;
    try { body = await response.json(); } catch (_) { continue; }
    const state = aiGptTaskState(body);
    if (state.failed) throw new Error('GPT Image 任务失败：' + state.failed);
    if (state.pending) continue;
    const images = [], urls = [];
    aiCollectImages(body, images, urls, new Set());
    if (images.length || urls.length) return { images, urls };
    if (state.done) throw Object.assign(new Error('GPT Image 任务完成但没有返回图片'), { code: 'AI_NO_IMAGE_RETURNED' });
    // 2026-10-24（V7待办/05）：没有状态也没有图 = 回包格式认不出来。原来会一直问到 1 小时超时；连续 20 次（约 1 分钟）就报
    if (state.unknown && ++blank >= 20) throw Object.assign(new Error('GPT Image 查询结果的格式认不出来（连续 20 次没有状态也没有图）：' + JSON.stringify(body).slice(0, 200)), { code: 'AI_NO_IMAGE_RETURNED' });
    if (!state.unknown) blank = 0;
  }
}

async function aiDownloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('图片 URL 下载失败 HTTP ' + response.status);
  const type = String(response.headers.get('content-type') || 'image/png').split(';')[0];
  const buf = Buffer.from(await response.arrayBuffer());
  return { imageBase64: buf.toString('base64'), mime: type };
}

function aiCollectImages(value, out, urls, seen) {
  if (value == null) return;
  if (Array.isArray(value)) { value.forEach(v => aiCollectImages(v, out, urls, seen)); return; }
  if (typeof value !== 'object') return;
  const inline = value.inlineData && value.inlineData.data ? value.inlineData : null;
  if (inline) {
    const b64 = aiCleanBase64(inline.data);
    const key = 'b64:' + b64.length + ':' + b64.slice(0, 48) + ':' + b64.slice(-48);
    if (b64 && !seen.has(key)) { seen.add(key); out.push({ imageBase64: b64, mime: inline.mimeType || 'image/png' }); }
  }
  if (value.b64_json) {
    const b64 = aiCleanBase64(value.b64_json);
    const key = 'b64:' + b64.length + ':' + b64.slice(0, 48) + ':' + b64.slice(-48);
    if (b64 && !seen.has(key)) { seen.add(key); out.push({ imageBase64: b64, mime: value.mime || 'image/png' }); }
  }
  if (typeof value.image_base64 === 'string') {
    const b64 = aiCleanBase64(value.image_base64);
    const key = 'b64:' + b64.length + ':' + b64.slice(0, 48) + ':' + b64.slice(-48);
    if (b64 && !seen.has(key)) { seen.add(key); out.push({ imageBase64: b64, mime: value.mime || 'image/png' }); }
  }
  if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) {
    if (!urls.includes(value.url)) urls.push(value.url);
  }
  Object.keys(value).forEach(k => aiCollectImages(value[k], out, urls, seen));
}

function aiReadErrorBody(body, status) {
  if (body && body.error) return body.error.message || body.error.type || JSON.stringify(body.error);
  if (body && body.message) return body.message;
  return 'HTTP ' + status;
}

function aiBuildRequest(payload) {
  const gpt = aiIsGptImage(payload);
  const protocol = gpt ? 'openai' : String(payload.protocol || 'gemini').toLowerCase();
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const inputB64 = aiCleanBase64(payload.inputImageBase64 || payload.inputBase64);
  const refs = Array.isArray(payload.refImages) ? payload.refImages : [];
  const key = String(payload.apiKey || '').trim();
  const endpoint = aiEndpoint(payload);
  let url = endpoint;
  const headers = { 'Content-Type': 'application/json' };
  let authMode = String(payload.authMode || 'bearer').toLowerCase();
  if (gpt && authMode === 'x-goog-api-key') authMode = 'bearer';
  if (!['bearer', 'query', 'x-goog-api-key'].includes(authMode) || authMode === 'x-goog-api-key' && protocol !== 'gemini') throw new Error('请核对当前协议的鉴权方式');
  if (key && authMode === 'query') url = aiAppendQuery(url, 'key', key);
  else if (key && authMode === 'x-goog-api-key') headers['x-goog-api-key'] = key;
  else if (key) headers.Authorization = 'Bearer ' + key;
  let body;
  if (protocol === 'openai') {
    const fields = {
      model: String(payload.model || '').trim(),
      prompt,
      n: 1,
      size: gpt ? aiGptSize(payload.size, payload.aspectRatio) : aiSizePixels(payload.size, payload.aspectRatio),
      response_format: 'b64_json'
    };
    const images = aiInputImages(payload);
    if (/\/edits\/?$/i.test(new URL(endpoint).pathname)) {
      if (!images.length && gpt) images.push({ b64: AI_GPT_BLANK_PNG, mime: 'image/png' }); // 阿吉的 GPT 节点至少要 1 张图（V6 同款）
      if (!images.length) throw new Error('图片编辑接口需要主图或参考图，请添加图片或改用 generations 接口');
      const form = new FormData();
      Object.keys(fields).forEach(k => form.append(k, String(fields[k])));
      images.forEach((image, index) => {
        const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp' })[image.mime] || 'png';
        form.append(images.length > 1 && !gpt ? 'image[]' : 'image', new Blob([Buffer.from(image.b64, 'base64')], { type: image.mime }), 'image_' + index + '.' + extension);
      });
      body = form;
      delete headers['Content-Type'];
      return { url, headers, body, multipart: true, gptImage: gpt };
    }
    if (images.length) throw new Error('当前 Endpoint 不支持图片输入，请改用 /images/edits；主图和参考图不会被忽略后继续生成');
    body = fields;
  } else {
    const parts = [{ text: prompt }];
    if (inputB64) parts.push({ inlineData: { mimeType: payload.inputMime || 'image/png', data: inputB64 } });
    refs.forEach(ref => {
      const b64 = aiCleanBase64(typeof ref === 'string' ? ref : ref && (ref.imageBase64 || ref.base64));
      if (b64) parts.push({ inlineData: { mimeType: (ref && ref.mime) || 'image/png', data: b64 } });
    });
    const generationConfig = { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.8, topP: 0.95, maxOutputTokens: 8192 };
    const imageConfig = {};
    if (payload.size && payload.size !== 'Auto') imageConfig.imageSize = payload.size;
    if (payload.aspectRatio && payload.aspectRatio !== 'Auto') imageConfig.aspectRatio = payload.aspectRatio;
    if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
    body = { contents: [{ role: 'user', parts }], generationConfig };
  }
  return { url, headers, body };
}

async function aiGenerate(payload, sender) {
  const request = Object.assign({}, payload || {});
  const taskId = String(request.taskId || ('ai-' + Date.now().toString(36) + '-' + (++aiSeq).toString(36)));
  // ⚠ 与 ui.html 的 AI_BATCH_MAX / tauri-adapter.js 保持一致(铁律 14)。
  const batch = Math.max(1, Math.min(AI_BATCH_MAX, Number(request.batch) || 1));
  const controllers = [];
  aiControllers.set(taskId, controllers);
  const results = [];
  const errors = [];
  let next = 0;
  // Each provider request normally returns one image, but some compatible
  // endpoints return an array. Reserve the first `batch` indexes for the
  // request slots and allocate any extra images after them so no result is
  // silently dropped or overwrites another request's slot.
  let nextExtraIndex = batch;
  let completed = 0;
  aiSendProgress(sender, { taskId, phase: 'started', completed: 0, total: batch });

  async function one(index) {
    const controller = new AbortController();
    controllers.push(controller);
    try {
      const built = aiBuildRequest(request);
      const response = await fetch(built.url, { method: 'POST', headers: built.headers, body: built.multipart ? built.body : JSON.stringify(built.body), signal: controller.signal });
      let body = null;
      const raw = await response.text();
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      // ⚠ 错误码和【服务器原话】都要带上(和 tauri-adapter.js 对齐，铁律 14)。
      //   serverBody 是报错卡判断"是不是图太大"的依据 —— 有些服务不回 413，
      //   而是用 400 + 正文写 "image too large"，只看状态码会漏判。
      // ⭐ 2026-10-21：502/503/504 单独一个码（同 tauri-adapter.js，铁律 14）
      if (!response.ok) throw Object.assign(new Error(aiReadErrorBody(body, response.status)),
        { code: /model_not_found|no available channel/i.test(String(raw || '')) ? 'AI_MODEL_NO_CHANNEL' : ([502, 503, 504].includes(response.status) || [502, 503, 504].includes(Number(body && body.error && body.error.code))) ? 'AI_UPSTREAM_TIMEOUT' : 'AI_HTTP_ERROR', httpStatus: response.status, serverBody: raw });
      let images = [], urls = [];
      aiCollectImages(body, images, urls, new Set());
      // GPT Image 异步：没给图只给任务号 ⇒ 轮询（同 tauri-adapter.js）
      if (!images.length && !urls.length && built.gptImage && aiGptTaskId(body)) ({ images, urls } = await aiGptPoll(built, body, controller.signal));
      for (const url of urls) {
        try { images.push(await aiDownloadImage(url)); } catch (e) { errors.push({ index, message: e.message }); }
      }
      if (!images.length) {
        const text = body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts
          ? body.candidates[0].content.parts.filter(p => p && p.text).map(p => p.text).join(' ').slice(0, 240) : '';
        throw Object.assign(new Error(text ? 'API 仅返回文本：' + text : 'API 未返回图片'),
          { code: 'AI_NO_IMAGE_RETURNED' });
      }
      const outputImages = images.map((image, imageIndex) => Object.assign(image, {
        index: imageIndex === 0 ? index : nextExtraIndex++, taskId
      }));
      outputImages.forEach(image => {
        results[image.index] = image;
        aiSendProgress(sender, { taskId, phase: 'progress', completed: completed + 1, total: batch, index: image.index, image });
      });
      completed++;
    } catch (e) {
      const cancelled = e && e.name === 'AbortError';
      const message = cancelled ? '已取消' : (e.message || String(e));
      // 原样带出真实错误码，不要一律压成 AI_REQUEST_FAILED(和 tauri-adapter.js 对齐)。
      errors.push({ index, message, code: cancelled ? 'AI_CANCELLED' : ((e && e.code) || 'AI_REQUEST_FAILED'), httpStatus: e && e.httpStatus, serverBody: e && e.serverBody });
      completed++;
      aiSendProgress(sender, { taskId, phase: 'progress', completed, total: batch, index, error: message });
    }
  }
  try {
    const workerCount = Math.min(4, batch);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) { const index = next++; if (index >= batch) return; await one(index); }
    }));
    const ordered = results.filter(Boolean).sort((a, b) => Number(a.index) - Number(b.index));
    if (!ordered.length) throw new Error(errors[0] ? errors[0].message : 'AI 未返回任何图片');
    const result = { ok: true, taskId, results: ordered, errors, stats: { requested: batch, succeeded: ordered.length, failed: errors.length } };
    aiSendProgress(sender, Object.assign({ phase: 'complete' }, result));
    return result;
  } finally {
    aiControllers.delete(taskId);
  }
}

function startLinkServer() {
  if (linkServer) return linkServer;
  linkServer = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').toLowerCase();
    const origin = String(req.headers.origin || '');
    const hostAllowed = !host || host === '127.0.0.1:' + LINK_PORT || host === 'localhost:' + LINK_PORT;
    // UXP fetch has no web Origin. Reject browser/file origins and any
    // non-loopback Host before a route can observe bridge state.
    const originAllowed = !origin || origin.startsWith('uxp://');
    const trustedRequest = hostAllowed && originAllowed;
    const reply = (status, payload) => linkJson(res, status, payload);
    if (!trustedRequest) return reply(403, { ok: false, error: '桥请求来源不受信任' });
    if (req.method === 'OPTIONS') return reply(204, null);
    const url = new URL(req.url || '/', 'http://127.0.0.1:' + LINK_PORT);

    function bridgeAuth() {
      if (Date.now() - linkTokenIssuedAt >= LINK_TOKEN_TTL_MS) return false;
      return req.headers['x-v7-bridge-token'] === linkBridgeToken || url.searchParams.get('bridgeToken') === linkBridgeToken;
    }

    if (req.method === 'GET' && url.pathname === '/v8/status') {
      return reply(200, {
        ok: true,
        version: '8.0.0-link-validation',
        port: LINK_PORT,
        sessionId: linkSessionId,
        queued: linkCommands.length,
        bridge: Object.assign({}, linkBridge),
        at: new Date().toISOString()
      });
    }

    if (req.method === 'GET' && url.pathname === '/v8/bootstrap') {
      if (req.headers['x-v7-bridge-client'] !== LINK_CLIENT_ID) return reply(401, { ok: false, error: '桥客户端未配对' });
      if (Date.now() - linkTokenIssuedAt >= LINK_TOKEN_TTL_MS) {
        linkSessionId = 'ui-' + crypto.randomBytes(16).toString('base64url');
        linkBridgeToken = crypto.randomBytes(32).toString('base64url');
        linkTokenIssuedAt = Date.now();
        linkBridge.connected = false;
      }
      return reply(200, { ok: true, sessionId: linkSessionId, bridgeToken: linkBridgeToken, expiresIn: Math.floor(LINK_TOKEN_TTL_MS / 1000) });
    }

    if (req.method === 'GET' && url.pathname === '/v8/commands') {
      if (!bridgeAuth()) return reply(401, { ok: false, error: '桥实例未配对或已过期' });
      // 心跳：每次轮询盖一个时间戳，界面靠它判断桥是不是还活着。
      // ⚠ 必须和 src-tauri/src/main.rs 的 last_poll_at 保持一致(铁律 14)。
      linkBridge.lastPollAt = new Date().toISOString();
      const wait = Math.min(LINK_LONG_POLL_MAX_MS, Math.max(0, Number(url.searchParams.get('wait')) || 0));
      if (wait > 0 && !linkCommands.length) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); linkWaiters.delete(done); resolve(); };
          const timer = setTimeout(done, wait);
          linkWaiters.add(done);
          res.on('close', done);   // 插件那头断了就别再挂着（⚠ 不能用 req 的 close：GET 读完请求体就触发）
        });
        linkBridge.lastPollAt = new Date().toISOString();
      }
      if (res.writableEnded || res.destroyed) return;
      // 每次最多发 8 个，桥可以继续轮询；不在这里设置业务超时。
      const commands = linkCommands.splice(0, 8);
      // ⚠ pollMs 随每次响应下发：用户在设置里改完，UXP 下一次轮询就生效，
      //   不用重新加载 Photoshop 插件。否则每改一个数就要去 UXP Dev Tool 重载，没法试手感。
      return reply(200, { ok: true, sessionId: linkSessionId, pollMs: linkPollMs, longPoll: wait > 0, commands });
    }

    if (req.method === 'POST' && url.pathname === '/v8/results') {
      if (!bridgeAuth()) return reply(401, { ok: false, error: '桥实例未配对或已过期' });
      try {
        const result = await readJson(req);
        if (!result.requestId) return reply(400, { ok: false, error: '缺少 requestId' });
        if (win && !win.isDestroyed()) win.webContents.send('link:result', result);
        return reply(200, { ok: true });
      } catch (e) {
        return reply(400, { ok: false, error: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/v8/events') {
      if (!bridgeAuth()) return reply(401, { ok: false, error: '桥实例未配对或已过期' });
      try {
        const event = await readJson(req);
        linkBridge.lastEventAt = new Date().toISOString();
        if (event.type === 'ready') {
          linkBridge.connected = true;
          linkBridge.clientId = event.clientId || null;
          linkBridge.bridgeVersion = event.bridgeVersion || null;
          linkBridge.lastReadyAt = linkBridge.lastEventAt;
        } else if (event.type === 'status' && event.connected === false) {
          linkBridge.connected = false;
        }
        if (win && !win.isDestroyed()) win.webContents.send('link:event', event);
        return reply(200, { ok: true });
      } catch (e) {
        return reply(400, { ok: false, error: e.message });
      }
    }

    return reply(404, { ok: false, error: 'Not found' });
  });
  linkServer.on('error', e => console.error('[link] 37889 启动失败:', e.message));
  linkServer.listen(LINK_PORT, '127.0.0.1', () => {
    console.log('[link] V8 链路桥运行在 127.0.0.1:' + LINK_PORT);
  });
  return linkServer;
}

function stopLinkServer() {
  if (!linkServer) return;
  try { linkServer.close(); } catch (_) {}
  linkServer = null;
}

// L4 使用独立的显示器级窗口：窗口覆盖当前主窗口所在显示器，
// 由 l4-window.html 自己绘制遮罩和居中操作卡，不再落入报错卡堆。
const setupHost = require('./setup-host.cjs').createSetupHost({ BrowserWindow, ipcMain, screen, directory: __dirname, getWindow: () => win, onLock: () => stopDrag() });

function openBlockingWindow(payload={}) {
  setupHost.close();
  if (!win || win.isDestroyed()) return;
  const id = String(payload.id || ('l4-' + Date.now()));
  const current = blockingWindows.get(id);
  if (current && !current.window.isDestroyed()) { current.window.focus(); return; }
  if (blockingWindows.size) { blockingQueue.set(id, { ...payload, id }); return; }
  payload = { ...payload, id };
  const display = screen.getDisplayMatching(win.getBounds());
  const { x, y, width, height } = display.bounds;
  const blocker = new BrowserWindow({
    x, y, width, height,
    parent: win,
    modal: process.platform !== 'darwin',
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'l4-preload.js'),
      additionalArguments: ['--l4-id=' + encodeURIComponent(id)]
    }
  });
  const record = { window: blocker, allowClose: false };
  blockingWindows.set(id, record);
  blocker.on('close', event => {
    if (!record.allowClose) event.preventDefault();
  });
  blocker.on('closed', () => {
    blockingWindows.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('win:l4-closed', id);
    const next = blockingQueue.entries().next().value;
    if (next && win && !win.isDestroyed()) {
      blockingQueue.delete(next[0]);
      setImmediate(() => openBlockingWindow(next[1]));
    }
  });
  blocker.loadFile(path.join(__dirname, 'l4-window.html'));
  blocker.webContents.once('did-finish-load', () => {
    if (!blocker.isDestroyed()) blocker.webContents.send('l4:data', payload);
    // 透明窗口在部分 Windows/GPU 组合下不会触发 ready-to-show。
    // 页面已经加载完成即可显示，避免 L4 已触发但用户看不到冻结层。
    if (!blocker.isDestroyed() && !blocker.isVisible()) {
      blocker.show();
      blocker.focus();
    }
  });
  blocker.once('ready-to-show', () => {
    if (blocker.isDestroyed()) return;
    // did-finish-load 通常已经显示；这里作为非透明/慢 GPU 环境的兜底。
    if (!blocker.isVisible()) {
      blocker.show();
      blocker.focus();
    }
  });
  blocker.setAlwaysOnTop(true, 'screen-saver');
  blocker.setBounds({ x, y, width, height });
}

function closeBlockingWindow(id) {
  if (blockingQueue.delete(String(id))) {
    if (win && !win.isDestroyed()) win.webContents.send('win:l4-closed', String(id));
    return;
  }
  const record = blockingWindows.get(String(id));
  if (!record) return;
  record.allowClose = true;
  if (!record.window.isDestroyed()) record.window.close();
}

// ── 大图查看：显示器级独立窗口 ──
// 主窗口是死的 1020×1100，窗口内的 position:fixed 铺不满屏幕，
// 所以大图和 L4 一样必须另开一个盖住整个显示器的窗口。
// ⚠ 手法照抄 L4，接口刻意不合并：L4 传标题/按钮，大图传图片/张数，
//   硬塞进一个 openBlocking 会变成联合体 payload。共用的只有"开窗"这个套路。
let viewerWindow = null;
let viewerReady = Promise.resolve({ ok: false });

async function openViewerWindow(payload = {}) {
  if (!win || win.isDestroyed()) return { ok: false, error: '主窗口已关闭' };
  // 阀门①：重入。已经开着就只换图，绝不叠开第二个窗口。
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    const opened = viewerWindow;
    const ready = await viewerReady;
    if (!ready.ok || viewerWindow !== opened || opened.isDestroyed()) return { ok: false, error: '查看窗口已关闭' };
    sendToViewer(payload);
    opened.focus();
    return { ok: true };
  }
  // 阀门②：跟主窗口所在的那块显示器走，多屏时不会跑到别的屏幕上。
  const display = screen.getDisplayMatching(win.getBounds());
  const { x, y, width, height } = display.bounds;
  const viewer = new BrowserWindow({
    x, y, width, height,
    parent: win,
    modal: process.platform !== 'darwin', // 冻结主窗口：这就是"冻结"本身
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,           // ⚠ 独立窗口自己可聚焦，所以主窗口将来改成
                               //   focusable:false 也不影响大图收 Esc / 滚轮。
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'viewer-preload.js')
    }
  });
  viewerWindow = viewer;
  viewer.on('closed', () => {
    if (viewerWindow === viewer) viewerWindow = null;
    // 阀门③：不管是谁关的(Esc/点空白/主窗口销毁)，主窗口都要收到通知，
    //   否则渲染层的 viewerOpen 会永远卡在 true，滚轮和穿透判断跟着一起坏。
    if (win && !win.isDestroyed()) win.webContents.send('viewer:closed');
  });
  viewerReady = viewer.loadFile(path.join(__dirname, 'viewer-window.html')).then(() => {
    if (viewer.isDestroyed() || viewerWindow !== viewer) return { ok: false, error: '查看窗口已关闭' };
    sendToViewer(payload);
    if (!viewer.isVisible()) { viewer.show(); viewer.focus(); }
    return { ok: true };
  }).catch(error => {
    if (!viewer.isDestroyed()) viewer.close();
    return { ok: false, error: String(error.message || error) };
  });
  viewer.once('ready-to-show', () => {
    if (viewer.isDestroyed()) return;
    if (!viewer.isVisible()) { viewer.show(); viewer.focus(); }
  });
  viewer.setAlwaysOnTop(true, 'screen-saver');
  viewer.setBounds({ x, y, width, height });
  return viewerReady;
}

function sendToViewer(payload = {}) {
  if (!viewerWindow || viewerWindow.isDestroyed()) return { ok: false, error: '查看窗口已关闭' };
  viewerWindow.webContents.send('viewer:data', payload);
  return { ok: true };
}

function closeViewerWindow() {
  if (!viewerWindow || viewerWindow.isDestroyed()) { viewerWindow = null; return; }
  viewerWindow.close();
}

// ── 剪影素材编辑器：第三个显示器级独立窗口 ──
// ⚠ 手法照抄 L4 / 大图，接口刻意不合并（同 docs/03 的理由）。
//   跟那两个不同的是：编辑器【可以正常关】，也【不冻结主窗口的业务】，
//   所以 modal:false —— 用户可能要一边看主窗口的剪影一边调。
let editorWindow = null;
let editorPayload = null;
let editorAllowClose = false;
const editorSaveRelay = require('./editor-save-relay.cjs').createEditorSaveRelay({
  getMain: () => win, getEditor: () => editorWindow, getPayload: () => editorPayload
});

function editorBounds() {
  const display = screen.getDisplayMatching(win.getBounds()), area = display.workArea;
  let stored;
  try { stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'editor-window-bounds.json'), 'utf8')); } catch (_) {}
  const width = Math.min(area.width, Math.max(Math.min(900, area.width), Number(stored?.width) || Math.round(area.width * 0.7)));
  const height = Math.min(area.height, Math.max(Math.min(620, area.height), Number(stored?.height) || Math.round(area.height * 0.75)));
  const x = Math.max(area.x, Math.min(Number.isFinite(stored?.x) ? stored.x : area.x + Math.round((area.width - width) / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(Number.isFinite(stored?.y) ? stored.y : area.y + Math.round((area.height - height) / 2), area.y + area.height - height));
  return { x, y, width, height };
}

function openEditorWindow(payload = {}) {
  if (!win || win.isDestroyed()) return;
  if (payload.focusOnly) {
    const existing = !!editorWindow && !editorWindow.isDestroyed();
    if (existing) { editorWindow.show(); editorWindow.focus(); }
    return { ok: true, existing };
  }
  if (editorPayload?.editorSession !== payload.editorSession) editorSaveRelay.cancel();
  editorAllowClose = false;
  editorPayload = payload;
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send('editor:data', payload);
    editorWindow.focus();
    return { ok: true };
  }
  const { x, y, width, height } = editorBounds();
  const ed = new BrowserWindow({
    x, y, width, height,
    parent: win,
    modal: false,
    frame: true,
    transparent: false,
    resizable: true,
    movable: true,
    minWidth: Math.min(760, width),
    minHeight: Math.min(520, height),
    hasShadow: true,
    skipTaskbar: false,
    focusable: true,
    alwaysOnTop: false,
    backgroundColor: '#171a20',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'editor-preload.js')
    }
  });
  editorWindow = ed;
  ed.on('close', event => {
    if (!editorAllowClose) { event.preventDefault(); ed.webContents.send('editor:request-close'); return; }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'editor-window-bounds.json'), JSON.stringify(ed.getNormalBounds())); } catch (_) {}
  });
  ed.on('closed', () => { if (editorWindow === ed) { editorWindow = null; editorSaveRelay.cancel(); } });
  ed.loadFile(path.join(__dirname, 'silhouette-editor.html'));
  ed.webContents.once('did-finish-load', () => {
    if (ed.isDestroyed()) return;
    ed.webContents.send('editor:data', editorPayload || {});
    // 透明窗口在部分 Windows/GPU 组合下不触发 ready-to-show，页面加载完就显示
    if (!ed.isVisible()) { ed.show(); ed.focus(); }
  });
  ed.once('ready-to-show', () => {
    if (ed.isDestroyed()) return;
    if (!ed.isVisible()) { ed.show(); ed.focus(); }
  });
  ed.setBounds({ x, y, width, height });
  return { ok: true };
}

function closeEditorWindow(expectedWindow, expectedSession) {
  if (expectedWindow && (editorWindow !== expectedWindow || editorPayload?.editorSession !== expectedSession)) return;
  if (!editorWindow || editorWindow.isDestroyed()) { editorWindow = null; return; }
  editorAllowClose = true;
  editorWindow.close();
}

// ── 强制置顶兜底 ──
// 【铁律】Windows 上 setIgnoreMouseEvents / setPosition 都会重置置顶窗口的 Z 序,
//   面板是"透明悬停"形态: 卡片永远浮在最上, 空白处鼠标穿透给下层。
//   所以每次穿透切换 / 拖动结束都要重新置顶, 否则被一键打回桌面层级(用户实测)。
//   用 screen-saver(最高层级), 防被其它置顶工具压下去。
function raiseTop(){
  if (!win || win.isDestroyed()) return;
  if (setupHost.isOpen()) return;
  if (browserHost && (browserHost.state().workspace || browserHost.state().open)) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
}

function createWindow() {
  win = new BrowserWindow({
    width: W,
    height: H,
    // 透明窗口: UI 之外完全透出桌面。 参考 V7 弃用 acrylic —— 整窗矩形会盖住
    // 卡片外空白, 这里 UI 之外直接透明, 只有卡片/i控件显示。
    transparent: true,
    frame: false,
    resizable: false,          // 不可调整大小(V7 同款)
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: false,
    focusable: true,           // ⚠ 测试期临时开: 窗口能收 Esc, 看二级/三级消失动画。
                               //   正式版还原成 false(不抢 PS 焦点)。封包前提醒用户。V7 同款是 false。
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // ⚠ 把渲染层的报错/警告转到终端。
  //   Tauri 那边有 debug_log 命令能把界面里的值打到 Rust 控制台，Electron 这边一直是瞎的 ——
  //   界面里抛了异常终端上一个字都不显示，只能靠开 devtools 逮，排查"静默失效"极其吃亏
  //   (CLAUDE.md 铁律 17)。这里只转 warning(1) 和 error(2)，正常 log 不转，避免刷屏。
  //   ⚠ 只转【错误】和下面这几个诊断前缀。不能连 warning 一起转 ——
  //     界面里 setErrors/updateStackPositions 本来就有一批常驻 console.warn 调试行，
  //     全转的话终端一秒刷几十条，真正的报错反而被埋掉。
  // ⚠ 这是【白名单】：不在里面的 console.log 一律不往主进程转发(只有 error 例外)。
  //   2026-09-12 补上 [报错] 和 [校色]：CLAUDE.md 铁律 17 要求改完看"三行启动自检"，
  //   可那三行里有两行走的正是这两个前缀 —— 不加的话在 Electron 壳里【永远看不到】，
  //   于是"脚本有没有跑到最后一行"这个检查在两个壳里只有一个能用。
  //   （Tauri 侧那两行是靠 invoke('debug_log') 打到 Rust 控制台的，一直都在。）
  const RENDER_LOG_PREFIXES = ['[预设]', '[拼音]', '[图片]', '[报错]', '[校色]', '[图标]'];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const msg = String(message || '');
    const isError = level >= 2;
    if (!isError && !RENDER_LOG_PREFIXES.some(p => msg.startsWith(p))) return;
    const src = String(sourceId || '').split(/[\\/]/).pop();
    console.log(`${isError ? '[渲染层错误]' : '[渲染层]'} ${msg}  (${src}:${line})`);
  });

  win.loadFile(path.join(__dirname, 'ui.html'));
  // 2026-10-18 深夜：上次调过界面大小就用上（跟 Tauri 壳启动时 ui_scale::apply 对称）
  win.webContents.once('did-finish-load', () => { const s = uiScaleLoad(); if (s !== 1) uiScaleApply(s); });
  if (resident) resident.attach(win);
  win.on('closed', () => {
    stopPointerProbe();
    mouseIgnored = false;
    for (const record of blockingWindows.values()) {
      record.allowClose = true;
      if (!record.window.isDestroyed()) record.window.close();
    }
    blockingWindows.clear();
    blockingQueue.clear();
    // 阀门⑤：主窗口没了，大图窗口不能留成孤儿(它 alwaysOnTop 且无边框，
    //   留下来就是一块关不掉的黑幕)。
    if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.close();
    viewerWindow = null;
    win = null;
  });

  // ⚠ 开发阶段: F12 打开开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      win.webContents.toggleDevTools();
    }
  });
  // 开发者工具改为 F12 手动打开，避免启动时遮挡 UI 视觉验收。

  // ── 定位主屏幕居中 ──
  const wa = screen.getPrimaryDisplay().workArea;
  win.setPosition(
    Math.round(wa.x + (wa.width  - W) / 2),
    Math.round(wa.y + (wa.height - H) / 2)
  );

  // ── 置顶放最后, 先定位再置顶, 用最高层级 ──
  raiseTop();
}

// ── 拖拽: 光标真的移动了才挪窗口, 不动就完全不调 setPosition ──
// 【根因】setPosition 设进去的值和实际生效值有 1px 偏差(设617→实际616),
//   高频定时器每帧都设 → 每秒累积丢几十像素 → "按住不动也慢慢漂走"。
//   解法: 记录上一次光标位置, 只有光标真的动了才设窗口, 且用累计位移算目标,
//   不依赖 getPosition() 的读回值(避免把 1px 误差滚进去)。
let dragTimer = null;
let dragBase = null;   // { curX, curY, winX, winY } 按下瞬间的基准
function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragBase = null;
}
ipcMain.on('win:dragStart', () => {
  if (!win) return;
  if (setupHost.isOpen()) return;
  stopDrag();
  const start = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  // 基准锁死: 之后每帧的目标 = 基准窗口位置 + (当前光标 - 基准光标)
  // 全程只跟这一个基准比, 不做增量累加, 所以 1px 误差不会滚雪球。
  dragBase = { curX: start.x, curY: start.y, winX: wx, winY: wy };
  let lastX = start.x, lastY = start.y;
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragBase) { stopDrag(); return; }
    const p = screen.getCursorScreenPoint();
    // 光标没动 → 一次都不调 setPosition(从根上杜绝"按住不动也漂")
    if (p.x === lastX && p.y === lastY) return;
    lastX = p.x; lastY = p.y;
    win.setPosition(
      dragBase.winX + (p.x - dragBase.curX),
      dragBase.winY + (p.y - dragBase.curY),
      false
    );
  }, 16);
});
ipcMain.on('win:dragEnd', () => { stopDrag(); raiseTop(); });

ipcMain.on('win:openBlocking', (_event, payload) => {
  const p = payload || {};
  // ⚠ backgroundOnly = 主窗口异步取到背景图后的「补发」，不是要新开窗口。
  //   L4 是独立窗口，blob 地址跨窗口无效，所以背景图只能转 dataURL 后补发（见 docs/24）。
  if (p.backgroundOnly) {
    const record = blockingWindows.get(String(p.id || ''));
    if (record && !record.window.isDestroyed()) record.window.webContents.send('l4:data', p);
    else if (blockingQueue.has(String(p.id || ''))) Object.assign(blockingQueue.get(String(p.id)), p, { backgroundOnly: false });
    return;
  }
  // 阀门④：L4 是最高打断等级，必须能被看到。大图开着就先让位，
  //   否则两个 modal 挂同一个 parent，Windows 上谁盖谁没保证。
  closeViewerWindow();
  openBlockingWindow(p);
});
ipcMain.on('win:closeBlocking', (_event, id) => { closeBlockingWindow(id); });

// ── 大图：主渲染进程 → 大图窗口 ──
ipcMain.on('viewer:open', (_event, payload) => { openViewerWindow(payload || {}); });
ipcMain.on('viewer:update', (_event, payload) => { sendToViewer(payload || {}); });
ipcMain.handle('viewer:open', (event, payload) => event.sender === win?.webContents ? openViewerWindow(payload || {}) : { ok: false, error: 'VIEWER_CALLER_DENIED' });
ipcMain.handle('viewer:update', async (event, payload) => {
  if (event.sender !== win?.webContents) return { ok: false, error: 'VIEWER_CALLER_DENIED' };
  await viewerReady;
  return sendToViewer(payload || {});
});
ipcMain.on('viewer:close', () => { closeViewerWindow(); });
// ── 大图：大图窗口 → 主渲染进程 ──
// 大图窗口只报"想切上下张"，切到哪张由主渲染进程算(要跳过没生成完/失败的图)。
ipcMain.on('viewer:nav-request', (event, delta) => {
  if (!viewerWindow || viewerWindow.isDestroyed()) return;
  if (event.sender.id !== viewerWindow.webContents.id) return;   // 只认大图窗口自己
  if (win && !win.isDestroyed()) win.webContents.send('viewer:nav', Number(delta) || 0);
});
ipcMain.on('viewer:close-self', event => {
  if (!viewerWindow || viewerWindow.isDestroyed()) return;
  if (event.sender.id !== viewerWindow.webContents.id) return;
  closeViewerWindow();
});
ipcMain.on('l4:action', (event, claimedId) => {
  for (const [id, record] of blockingWindows) {
    if (record.allowClose || record.window.isDestroyed() || record.window.webContents.id !== event.sender.id) continue;
    if (claimedId && String(claimedId) !== id) continue;
    // 先通知主渲染进程执行用户动作，再允许并关闭对应 L4 窗口。
    if (win && !win.isDestroyed()) win.webContents.send('win:l4-action', id);
    record.allowClose = true;
    record.window.close();
    break;
  }
});
// 超时应急关闭：只验证窗口来源并关闭，不把它路由成业务确认。
ipcMain.on('l4:escape', (event, claimedId) => {
  for (const [id, record] of blockingWindows) {
    if (record.allowClose || record.window.isDestroyed() || record.window.webContents.id !== event.sender.id) continue;
    if (!claimedId || String(claimedId) !== id) continue;
    record.allowClose = true;
    record.window.close();
    break;
  }
});

// ═══ 生成缓存 ═══
// 结构: <缓存根>/<PS项目名>/<每次计算>/{meta.json, input.png, output_N.png, thumb_N.jpg}
// 接口与 Tauri 侧【逐项对齐】，UI 层不需要知道自己跑在哪个壳里。
//
// ⚠⚠ 临时位置: 现在写死在项目文件夹下。**正式发布前必须改成用户自选目录**
//    (见 docs/10_缓存设计.md 和 docs/13 的"封包前必办")。
// ⚠⚠ 2026-09-11 修：原来一律 path.resolve(__dirname,'..','cache')。
//    开发时没问题，**打包后 __dirname 在 app.asar 里** ——
//    往 asar 里写文件会直接失败（asar 是只读归档）。
//    现在按是否打包分流：
//      开发时       → 项目目录下的 cache/，方便随时翻看
//      打包后       → 用户的本地应用数据目录 %LOCALAPPDATA%\修图轮椅\cache
//    和 Rust 侧 cache_root() 保持同样的规则(铁律 14)。
// ⚠ 跨平台：Electron 的 app.getPath('userData') 本身就会按平台给对路径
//   （Win → %APPDATA%\<应用名>，mac → ~/Library/Application Support/<应用名>），
//   所以【优先用它】，不要先读 LOCALAPPDATA —— 那是 Windows 专属，
//   mac 上恒为 undefined。这里保留 LOCALAPPDATA 只是为了和 Rust 侧的
//   Windows 行为对齐（两壳同一个缓存目录，铁律 14）。
const APP_DATA_ROOT = app.isPackaged
  ? (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || app.getPath('userData'), '修图轮椅')
      : app.getPath('userData'))
  : path.resolve(__dirname, '..');
const CACHE_ROOT = path.join(APP_DATA_ROOT, 'cache');

// 缓存由共享生命周期模块统一实现，Electron/Tauri 的路径、原子写入、
// 删除回收站和用户自选根目录保持同一份合同。主窗口校验由模块完成。
const cacheLifecycle = registerCacheIpc(ipcMain, {
  defaultRoot: CACHE_ROOT,
  configFile: path.join(APP_DATA_ROOT, 'cache-settings.json'),
  projectRoot: path.resolve(__dirname, '..'),
  isMainSender: sender => !!win && !win.isDestroyed() && sender.id === win.webContents.id,
  openPath: target => require('electron').shell.openPath(target),
  chooseDirectory: async () => {
    const result = await require('electron').dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  }
});

// 重启整个程序。开发期用来验"重启后任务还在不在"，不用手动杀进程。
// ⚠ 这是调试入口，正式发布前要从设置里撤掉(见 docs/13 封包前必办)。
ipcMain.on('app:restart', () => {
  console.log('[restart] 用户从设置触发重启');
  app.relaunch();
  app.exit(0);
});

// ── 剪影素材编辑器窗口 ──
ipcMain.on('editor:open', (event, payload) => { if (event.sender === win?.webContents) openEditorWindow(payload || {}); });
ipcMain.handle('editor:open', (event, payload) => event.sender === win?.webContents ? openEditorWindow(payload || {}) : { ok: false, error: 'EDITOR_CALLER_DENIED' });
ipcMain.on('editor:close', event => { if (event.sender === win?.webContents) closeEditorWindow(); });
ipcMain.on('editor:close-self', (event, session) => {
  if (event.sender === editorWindow?.webContents && (!session || editorPayload?.editorSession === session)) closeEditorWindow();
});
ipcMain.handle('editor:ready', event => event.sender === editorWindow?.webContents ? editorPayload || null : null);
ipcMain.handle('editor:save', async (event, payload) => {
  const owner = editorWindow, session = payload?.editorSession;
  const result = await editorSaveRelay.save(event.sender, payload);
  if (result?.ok === true) closeEditorWindow(owner, session);
  return result;
});
ipcMain.on('editor:save-result', (event, message) => editorSaveRelay.acknowledge(event.sender, message));
ipcMain.on('editor:save', async (event, payload) => {
  const owner = editorWindow, session = payload?.editorSession;
  const result = await editorSaveRelay.save(event.sender, payload);
  if (result?.ok === true) closeEditorWindow(owner, session);
});

// ═══ 预设系统的文件活儿 ═══
// ⚠ 只做三件必须碰文件系统的事。导入走界面自己的 <input type="file">，不占接口。

// V6 的预设藏在 PS 的 UXP 插件数据目录里，路径带 PS 版本号和插件 id，只能通配着找。
//   %APPDATA%\Adobe\UXP\PluginsStorage\PHSP*\<版本>\<Developer|External>\<插件id>\PluginData\presets
// ⚠ 实测这台机器有 8 个这样的目录（不同 PS 版本 / Developer 和 External 各一份 / 不同插件 id），
//   各自有独有的用户预设 —— 所以全都返回，由界面合并去重，别自作主张只挑一个。
function findV6PresetDirs() {
  const out = [];
  const roots = [];
  if (process.platform === 'darwin') {
    roots.push(path.join(require('os').homedir(), 'Library', 'Application Support', 'Adobe', 'UXP', 'PluginsStorage'));
  } else {
    const appdata = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
    roots.push(path.join(appdata, 'Adobe', 'UXP', 'PluginsStorage'));
  }
  const dirsIn = p => {
    try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch (_) { return []; }
  };
  for (const root of roots) {
    for (const host of dirsIn(root)) {                 // PHSP / PHSPBETA
      if (!/^PHSP/i.test(host)) continue;
      const hostDir = path.join(root, host);
      for (const ver of dirsIn(hostDir)) {              // 22 / 26 / 27 …
        const verDir = path.join(hostDir, ver);
        for (const kind of dirsIn(verDir)) {            // Developer / External / Internal
          const kindDir = path.join(verDir, kind);
          for (const plugin of dirsIn(kindDir)) {
            if (!/wheelchair/i.test(plugin)) continue;  // 只认轮椅自己的插件
            for (const [folder, presetKind] of [['presets', 'prompt'], ['forge_presets', 'forge']]) {
              const presets = path.join(kindDir, plugin, 'PluginData', folder);
              let count = 0;
              try { count = fs.readdirSync(presets, { withFileTypes: true }).filter(f => f.isFile() && f.name.toLowerCase().endsWith('.json')).length; }
              catch (_) { continue; }
              if (!count) continue;
              out.push({ path: presets, kind: presetKind, count, label: host + '/' + ver + '/' + kind + '/' + plugin + '/' + folder + '  (' + count + ' 个)' });
            }
          }
        }
      }
    }
  }
  return out;
}

ipcMain.handle('preset:findV6', () => {
  try { return findV6PresetDirs(); }
  catch (e) { console.warn('[预设] 扫描 V6 目录失败:', e.message); return []; }
});

ipcMain.handle('preset:scanDir', (_event, dir) => {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      try { out.push({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }); }
      catch (error) { out.push({ name, error: error.message }); }
    }
  } catch (e) { throw new Error('读不了这个文件夹: ' + e.message); }
  return out;
});

// 导出: 写到固定的 exports 文件夹，返回完整路径由界面提示给用户。
// ⚠ 这里【故意不用】Electron 自带的另存为对话框 —— Tauri 那边要弹对话框得多装
//   tauri-plugin-dialog(需要联网拉 crate，本项目通路历史上不稳，见 docs/03)。
//   两个壳必须行为一致(铁律 14)，所以统一走固定文件夹。想换真对话框就两边一起换。
const EXPORTS_ROOT = path.join(APP_DATA_ROOT, 'exports');

// 文件名消毒: 只挡路径分隔符和上跳，中文正常留着。
function safeExportName(name) {
  let s = String(name || '').replace(/[/\\:*?"<>|\r\n\t]/g, '_').replace(/\.\./g, '_').trim().replace(/^\.+|\.+$/g, '');
  if (!s) s = 'export.json';
  if (!s.toLowerCase().endsWith('.json')) s += '.json';
  return s;
}

ipcMain.handle('preset:saveText', (_event, name, text) => {
  try {
    fs.mkdirSync(EXPORTS_ROOT, { recursive: true });
    const file = path.join(EXPORTS_ROOT, safeExportName(name));
    fs.writeFileSync(file, String(text || ''), 'utf8');
    console.log('[预设] 已导出到 ' + file);
    return { ok: true, path: file };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.on('win:close', () => { if (win) win.close(); });
ipcMain.handle('win:getPos', () => { return win ? win.getPosition() : [0, 0]; });
ipcMain.handle('shortcut:set-generation', (_event, value) => registerGenerationShortcut(value));
// ⭐ 2026-10-14：加参考图快捷键（同上一行，双壳同步见 registerReferenceShortcut 注释）
ipcMain.handle('shortcut:set-reference', (_event, value) => registerReferenceShortcut(value));
ipcMain.handle('shortcut:set-collapse', (_event, value) => registerCollapseShortcut(value));
ipcMain.handle('shortcut:set-provider', (_event, value) => registerProviderShortcut(value));
const freeModeHost = require('./free-mode-host.cjs').createFreeModeHost({
  getWindow: () => win, screen, globalShortcut, multiScreen: true,
  canEnter: () => !setupHost.isOpen() && !(browserHost && (browserHost.state().workspace || browserHost.state().open)),
  emit: (name, value) => { if (win && !win.isDestroyed()) win.webContents.send(name, value); }
});
ipcMain.handle('free-mode:set', (event, enabled) => {
  if (!win || event.sender !== win.webContents) return { ok: false, error: '主窗口专用接口' };
  stopDrag(); return freeModeHost.set(!!enabled);
});
ipcMain.handle('free-mode:pulse', event => {
  if (!win || event.sender !== win.webContents) return { ok: false };
  return freeModeHost.pulse();
});
// ⭐ 2026-10-18 深夜：界面缩放（跟 src-tauri/src/ui_scale.rs 同一套：网页缩放 + 主窗口按比例改尺寸；存在 userData/ui-scale.json）
const uiScaleFile = () => require('path').join(app.getPath('userData'), 'ui-scale.json');
const uiScaleClamp = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(Math.min(1.5, Math.max(0.7, n)) * 20) / 20 : 1; };
function uiScaleLoad() { try { return uiScaleClamp(JSON.parse(require('fs').readFileSync(uiScaleFile(), 'utf8')).scale); } catch (_) { return 1; } }
function uiScaleApply(scale) {
  if (!win || win.isDestroyed()) return { ok: false, error: '主窗口不存在' };
  const s = uiScaleClamp(scale);
  win.webContents.setZoomFactor(s);
  const freeActive = (() => { try { return !!freeModeHost.isActive(); } catch (_) { return false; } })();
  if (!freeActive) {
    const w = Math.round(W * s), h = Math.round(H * s);
    win.setMinimumSize(1, 1); win.setSize(w, h); win.setMinimumSize(w, h);
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  return { ok: true, scale: s };
}
ipcMain.handle('ui-scale:get', event => {
  if (!win || event.sender !== win.webContents) return { ok: false, error: '主窗口专用接口' };
  return { ok: true, scale: uiScaleLoad(), min: 0.7, max: 1.5 };
});
ipcMain.handle('ui-scale:set', (event, scale) => {
  if (!win || event.sender !== win.webContents) return { ok: false, error: '主窗口专用接口' };
  const result = uiScaleApply(scale);
  if (!result.ok) return result;
  try { require('fs').writeFileSync(uiScaleFile(), JSON.stringify({ scale: result.scale })); return Object.assign(result, { saved: true }); }
  catch (error) { return Object.assign(result, { saved: false, error: '缩放已生效，但没存下来：' + error.message }); }
});

// UI 侧唯一入队入口。结果由 /v8/results 通过 link:result 回推到渲染层。
ipcMain.handle('link:enqueue', (_event, payload) => {
  try {
    const command = makeLinkRequest(payload || {});
    linkCommands.push(command);
    wakeLinkWaiters();
    if (win && !win.isDestroyed()) win.webContents.send('link:queued', command);
    return { ok: true, requestId: command.requestId, command };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('link:status', event => {
  if (!localMainCaller(event)) return { ok: false, error: 'LINK_CALLER_DENIED' };
  return { ok: !!linkServer, port: LINK_PORT, queued: linkCommands.length,
    sessionId: linkSessionId, bridge: Object.assign({}, linkBridge) };
});

// ═══ 性能采样 ═══
// ⚠ 这是【数据源】，和显示在哪儿完全解耦（现在在 L3 卡里，以后可能挪走）。
//   返回结构与 Tauri 侧【逐字段对齐】，UI 不需要知道自己跑在哪个壳里。
// ⚠ Electron 是多进程的，必须用 getAppMetrics() 把所有进程加起来，
//   只报主进程的话数字会明显偏小（渲染进程才是吃内存的大头）。
ipcMain.handle('perf:sample', () => {
  try {
    const metrics = app.getAppMetrics();
    let memKB = 0, cpu = 0;
    metrics.forEach(m => {
      memKB += (m.memory && m.memory.workingSetSize) || 0;
      cpu += (m.cpu && m.cpu.percentCPUUsage) || 0;
    });
    const cores = require('os').cpus().length || 1;
    return {
      ok: true,
      at: Date.now(),
      process: {
        memMB: Math.round(memKB / 1024 * 10) / 10,
        // percentCPUUsage 已经是"整机占比"口径，不用再除核心数
        cpuPercent: Math.round(cpu * 10) / 10,
        cpuPercentOfOneCore: Math.round(cpu * cores * 10) / 10,
        processCount: metrics.length
      },
      system: {
        memUsedMB: Math.round((require('os').totalmem() - require('os').freemem()) / 1048576),
        memTotalMB: Math.round(require('os').totalmem() / 1048576),
        cores
      },
      // ⚠ Electron 拿不到 GPU 占用率（getGPUInfo 只有静态信息，没有实时利用率）。
      //   Tauri 侧走 NVML 能拿到。接口保持一致，这边如实报"不支持"。
      gpu: { supported: false, reason: 'Electron 壳拿不到 GPU 实时占用（Tauri 壳可以）' }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 调 UXP 的轮询间隔。开发期用来试 hover 联动的手感。
// 下限 20ms 是保护：再小对手感没有意义，只会让 PS 里的 JS 空转。
ipcMain.handle('link:setPollMs', (_event, value) => {
  const clamped = Math.max(20, Math.min(2000, Number(value) || 180));
  linkPollMs = clamped;
  console.log('[link] 轮询间隔改为 ' + clamped + 'ms');
  return { ok: true, pollMs: clamped };
});

ipcMain.handle('ai:generate', async (event, payload) => {
  try { return await aiGenerate(payload || {}, event && event.sender); }
  catch (e) { return { ok: false, taskId: payload && payload.taskId, error: e.message || String(e) }; }
});
ipcMain.handle('ai:cancel', (_event, taskId) => {
  const list = aiControllers.get(String(taskId || '')) || [];
  list.forEach(controller => { try { controller.abort(); } catch (_) {} });
  return { ok: true, taskId: String(taskId || ''), cancelled: list.length > 0 };
});

// ── 对外 HTTP 代发 ──
// ⚠ 必须和 src-tauri/src/main.rs 的 http_fetch / http_cancel 行为一致(铁律 14)：
//   同样的入参、同样的返回结构、同样"不管状态码都把 body 读回来"。
//   返回结构: { ok, status, headers, body, elapsedMs, url }
// ⭐ 2026-10-17 夜：夏三六黑匣子（ui-pure/agent-trace.js）。⚠ 两壳一致（铁律 14）：规则跟 main.rs agent_trace_append 一模一样
//   开发版 = 项目根/logs/agent-trace；正式版 = %LOCALAPPDATA%\修图轮椅\agent-trace。文件名只认日期；一行 ≤2MB、一天 ≤64MB、只留 30 天。
const AGENT_TRACE_DIR = app.isPackaged ? path.join(APP_DATA_ROOT, 'agent-trace') : path.join(APP_DATA_ROOT, 'logs', 'agent-trace');
ipcMain.handle('agentTrace:path', () => AGENT_TRACE_DIR);
ipcMain.handle('agentTrace:append', (_event, day, line) => {
  const d = String(day || ''), text = String(line || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'AGENT_TRACE_BAD_DAY' };
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || text.includes('\n') || !text.startsWith('{')) return { ok: false, error: 'AGENT_TRACE_BAD_LINE' };
  try {
    fs.mkdirSync(AGENT_TRACE_DIR, { recursive: true });
    const file = path.join(AGENT_TRACE_DIR, d + '.jsonl');
    if (fs.existsSync(file)) { if (fs.statSync(file).size > 64 * 1024 * 1024) return { ok: false, error: 'AGENT_TRACE_FULL' }; }
    else {
      const names = fs.readdirSync(AGENT_TRACE_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
      while (names.length >= 30) { try { fs.unlinkSync(path.join(AGENT_TRACE_DIR, names.shift())); } catch (_) {} }
    }
    fs.appendFileSync(file, text + '\n');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
const httpControllers = new Map();
ipcMain.handle('http:fetch', async (_event, options) => {
  const o = options || {};
  const controller = new AbortController();
  const requestId = String(o.requestId || '');
  if (requestId) httpControllers.set(requestId, controller);
  // ⭐⭐ 2026-10-09（用户要求）：出图这类请求要能【慢慢等】，别 3 分钟就放弃。
  //   用户原话：「不要超时时间，就是我们可以慢慢等，反正在后台可以慢慢算」。
  //   ⚠ 改之前是 `|| 180000` + 上限 600000（3 分钟 / 10 分钟）。
  //     出一张大图或服务商排队，超过 3 分钟很正常 ⇒
  //     客户端先放弃、服务端还在算 ⇒ 用户白等。
  //   ⚠ 不设"永不超时"：连接真挂死时没有东西会结束它，失败要等很久才报。
  //     1 小时够"慢慢算"了，而且用户随时能点取消（abort 那条路不受影响）。
  //   ⚠ 两壳必须一致（铁律 14）：Tauri 侧对应 tauri-adapter.js + main.rs 的 http_fetch。
  const timeoutMs = Math.min(3600000, Math.max(1000, Number(o.timeoutMs) || 3600000));
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, timeoutMs);
  const started = Date.now();
  try {
    // ⭐ 2026-10-17 夜：o.direct（生图「不走系统代理」）这边不用处理 —— Node 自带的 fetch 本来就不读 Windows 系统代理，
    //   一直是直连。Tauri 侧（main.rs http_fetch）的 reqwest 默认会读系统代理，所以那边要按 direct 关掉（铁律 14：两壳行为一致）。
    const response = await fetch(String(o.url || ''), {
      method: String(o.method || 'GET').toUpperCase(),
      headers: o.headers || {},
      body: o.body === undefined || o.body === null ? undefined : o.bodyEncoding === 'base64' ? Buffer.from(o.body, 'base64') : o.body,
      signal: controller.signal,
      redirect: 'follow'
    });
    // ⚠ 不管状态码是多少都要读 body —— 服务器拒绝时最有用的话
    //   (「image too large」「quota exceeded」)就在错误响应的 body 里。
    // ⚠ 图片要走 base64：按文本读会把二进制字节改坏(和 Rust 侧同一个道理)。
    const wantBase64 = o.responseType === 'base64';
    const text = wantBase64
      ? Buffer.from(await response.arrayBuffer()).toString('base64')
      : await response.text();
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status, headers, body: text,
      bodyEncoding: wantBase64 ? 'base64' : 'text',
      elapsedMs: Date.now() - started, url: String(o.url || '')
    };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('已取消');
    // 和 Rust 侧一样，把网络失败分个类，别只给一句干巴巴的报错。
    const msg = String((e && e.message) || e);
    const kind = /timeout|aborted/i.test(msg) ? '超时'
      : /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg) ? '域名解析不了'
      : /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg) ? '连不上服务器'
      : '网络错误';
    throw new Error(kind + ': ' + msg);
  } finally {
    clearTimeout(timer);
    if (requestId) httpControllers.delete(requestId);
  }
});
// 启动校色加速引擎。⚠ 必须和 src-tauri 的 engine_start 行为一致(铁律 14)。
//   只能启动项目里那一个写死的脚本，不接受界面传路径 —— 否则就是任意执行的口子。
// ⚠⚠ 白名单：只能启动这里列出的脚本，【绝不接受界面传路径过来】(docs/40 第四节)。
//   否则等于开了个任意执行的口子 —— 哪怕只监听本机也不该留。
//   加新引擎就往这张表加一行，不要改成"界面传什么就跑什么"。
// ⚠⚠ 2026-09-14 深夜：抠像那一条换成了【三合一】的 multi_engine_server.py
//   （抠像 + 人体解析 + 指哪抠哪，还是 37894 这一个端口）。
//   老的 matting_server.py 留在仓库里【只作参考，不再启动】——
//   它和新引擎抢同一个端口，两个都跑的话先到的赢，而且不报错，
//   表现成"新功能怎么都出不来"（2026-09-14 深夜真的栽过一次）。
// ⚠ 铁律 14：这张表改了，src-tauri/src/main.rs 的 engine_start 必须同步改。
const engineDataRoot = () => process.platform === 'win32' ? APP_DATA_ROOT
  : path.join(app.getPath('appData'), process.platform === 'darwin' ? '修图轮椅' : 'wheelchair');
const engineModelsDir = () => app.isPackaged
  ? path.join(engineDataRoot(), 'models') : path.join(__dirname, '..', 'engine', 'models');
const engineResourceRoot = () => path.join(__dirname, '..');
const engineEnvironmentRoot = () => app.isPackaged
  ? path.join(engineDataRoot(), 'managed-engine') : path.join(__dirname, '..', 'tmp', 'managed-engine');
let engineEnvironmentService = null;
let engineOperationBusy = false;
let engineEnvironmentPending = false;
let engineEnvironmentCancelled = false;
const engineEnvironment = () => engineEnvironmentService || (engineEnvironmentService = require('./engine-environment.cjs').createService({
  root: engineEnvironmentRoot(), resourceRoot: engineResourceRoot()
}));
const engineEnvironmentFailure = error => ({ ok: false, state: 'error', ready: false, python: null, root: engineEnvironmentRoot(), error });
const runningImageEngine = async () => {
  const launcher = require('./engine-launcher.cjs');
  return (await Promise.all(Object.values(launcher.ENGINES).map(spec => launcher.portOccupied(spec.port)))).some(Boolean);
};
ipcMain.handle('engine:environment', async (event, action, accel) => {
  if (!localMainCaller(event)) return engineEnvironmentFailure('引擎操作仅允许软件主窗口调用。');
  if (!['status', 'prepare', 'remove', 'cancel', 'removeaccel'].includes(action)) return engineEnvironmentFailure('独立图像环境操作无效。');
  // ⚠ 加速档只管 prepare（和 Rust 侧 engine_environment 逐字对齐）。
  const mode = accel === 'cuda' ? 'cuda' : 'off';
  if (action === 'status' || action === 'cancel') {
    if (action === 'cancel' && engineEnvironmentPending) engineEnvironmentCancelled = true;
    return engineEnvironment().request(action);
  }
  if (engineOperationBusy) return engineEnvironmentFailure('图像引擎正在启动或环境正在变更，请等待完成。');
  engineOperationBusy = true;
  engineEnvironmentPending = true;
  engineEnvironmentCancelled = false;
  try {
    if (await runningImageEngine()) return engineEnvironmentFailure('图像引擎端口正在使用。请先退出运行中的引擎，再变更独立环境；软件不会关闭其它进程。');
    if (engineEnvironmentCancelled) return { ...(await engineEnvironment().request('status')), cancelled: true };
    const preparing = action === 'prepare';
    const removing = action === 'remove';
    const detail = preparing
      ? (mode === 'cuda'
        ? '将在 V7 固定目录创建独立 Python 环境，联网安装基础依赖 + CUDA 版 PyTorch（约 3GB），不修改系统 Python，不下载模型权重。现有模型文件不会删除。'
        : '将在 V7 固定目录创建独立 Python 环境，联网安装 CPU 基础依赖，不修改系统 Python，不下载模型权重。现有模型文件不会删除。')
      : removing
        ? '仅移除 V7 管理的独立 Python 环境和基础依赖。不会移除系统 Python，也不会删除现有模型文件。'
        : '将拆掉加速包（CUDA 版 PyTorch 以及它带进来的几个库），环境回到只用处理器的状态。基础依赖和所有模型文件都保留。';
    const result = await require('electron').dialog.showMessageBox(win, {
      type: 'question',
      title: preparing ? (mode === 'cuda' ? '准备环境并开启加速' : '准备独立图像环境') : removing ? '移除独立图像环境' : '关闭加速',
      message: preparing ? '准备 V7 专用的独立图像环境？' : removing ? '移除 V7 专用的独立图像环境？' : '关闭加速档？',
      detail,
      buttons: [preparing ? '准备' : removing ? '移除' : '关闭加速', '取消'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (result.response !== 0) return { ...(await engineEnvironment().request('status')), cancelled: true };
    if (!localMainCaller(event)) return engineEnvironmentFailure('主窗口已经关闭，环境操作已停止。');
    if (await runningImageEngine()) return engineEnvironmentFailure('图像引擎端口正在使用，请先退出引擎后重试。');
    if (engineEnvironmentCancelled) return { ...(await engineEnvironment().request('status')), cancelled: true };
    return await engineEnvironment().request(action, mode);
  } catch (error) { return engineEnvironmentFailure(String(error.message || error)); }
  finally { engineOperationBusy = false; engineEnvironmentPending = false; }
});
ipcMain.handle('engine:start', async (event, which) => {
  if (!localMainCaller(event)) return { ok: false, error: '引擎操作仅允许软件主窗口调用。' };
  if (engineOperationBusy) return { ok: false, error: '图像引擎正在启动或环境正在变更，请等待完成。' };
  engineOperationBusy = true;
  try {
    const python = await engineEnvironment().managedPython();
    if (!python) return { ok: false, error: '独立图像环境尚未就绪，请先在设置中准备环境。' };
    return await require('./engine-launcher.cjs').startEngine(which, {
      resourceRoot: engineResourceRoot(), python,
      modelsDir: engineModelsDir(),
      logsDir: app.isPackaged ? path.join(engineDataRoot(), 'engine-logs') : path.join(APP_DATA_ROOT, 'tmp/engine-logs')
    });
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
  finally { engineOperationBusy = false; }
});
ipcMain.handle('engine:stop', async (event, which) => {
  if (!localMainCaller(event)) return { ok: false, error: '引擎操作仅允许软件主窗口调用。' };
  if (engineOperationBusy) return { ok: false, error: '图像引擎或环境仍在变更，请等待完成。' };
  if (!['match', 'matting'].includes(which || 'match')) return { ok: false, error: '不认识的引擎。' };
  engineOperationBusy = true;
  try {
    const result = await require('electron').dialog.showMessageBox(win, {
      type: 'question', title: '停止图像引擎', message: '停止本次软件启动的' + ((which || 'match') === 'match' ? '校色' : '抠像') + '引擎？',
      detail: '正在执行的引擎请求会中断。仅停止身份已核实的本次子进程，不会删除环境或模型，也不会关闭其它程序启动的服务。',
      buttons: ['停止', '取消'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (result.response !== 0) return { ok: false, cancelled: true };
    if (!localMainCaller(event)) return { ok: false, error: '主窗口已经关闭，停止操作已取消。' };
    return await require('./engine-launcher.cjs').stopEngine(which || 'match', {
      resourceRoot: engineResourceRoot(), logsDir: app.isPackaged ? path.join(engineDataRoot(), 'engine-logs') : path.join(APP_DATA_ROOT, 'tmp/engine-logs')
    });
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
  finally { engineOperationBusy = false; }
});
let engineModelsService = null;
let engineModelsPending = false;
let engineModelsCancelled = false;
const managedEngineModels = () => engineModelsService || (engineModelsService = require('./engine-models.cjs').createService({
  root: engineModelsDir(), resourceRoot: engineResourceRoot(), environmentRoot: engineEnvironmentRoot()
}));
const engineModelsFailure = error => ({ ok: false, root: engineModelsDir(), models: {}, operation: null, error });
const cancelledEngineModels = async () => ({ ...(await managedEngineModels().request('catalog')), cancelled: true });
ipcMain.handle('engine:models', async (event, action, model) => {
  if (!localMainCaller(event)) return engineModelsFailure('模型操作仅允许软件主窗口调用。');
  if (action === 'catalog' || action === 'status') return managedEngineModels().request('catalog');
  if (action === 'cancel') {
    if (engineModelsPending) engineModelsCancelled = true;
    return managedEngineModels().request('cancel');
  }
  if (!['import', 'download'].includes(action) || typeof model !== 'string') return engineModelsFailure('模型管理操作无效。');
  if (engineOperationBusy) return engineModelsFailure('图像引擎正在启动或模型与环境正在变更，请等待完成。');
  engineOperationBusy = true;
  engineModelsPending = true;
  engineModelsCancelled = false;
  try {
    if (await runningImageEngine()) return engineModelsFailure('图像引擎端口正在使用，请先退出引擎后再导入或下载模型。');
    const catalog = await managedEngineModels().request('catalog');
    if (!catalog.ok) return catalog;
    const entry = Object.hasOwn(catalog.models || {}, model) ? catalog.models[model] : null;
    if (!entry || typeof entry !== 'object') return engineModelsFailure('请选择有效的模型。');
    if (engineModelsCancelled) return cancelledEngineModels();
    const { dialog } = require('electron');
    let source;
    if (action === 'import') {
      const picked = await dialog.showOpenDialog(win, {
        title: '选择要导入的模型', properties: [entry.dir ? 'openDirectory' : 'openFile']
      });
      if (picked.canceled || !picked.filePaths?.length || engineModelsCancelled) return cancelledEngineModels();
      source = picked.filePaths[0];
    } else if (!entry.download?.available) return engineModelsFailure(entry.download?.reason || '随包清单尚未提供可信下载地址，请手工导入模型。');
    if (engineModelsCancelled) return cancelledEngineModels();
    const result = await dialog.showMessageBox(win, {
      type: 'question', title: action === 'import' ? '导入模型' : '下载模型',
      message: (action === 'import' ? '导入 ' : '下载 ') + (entry.name || model) + '？',
      detail: action === 'import'
        ? '来源：' + source + '\n将验证并复制所选模型到软件模型目录；已存在的同名模型会被替换，其它模型不会删除。'
        : '大小：' + entry.download.bytes + ' 字节\n来源：' + (entry.download.urls || [entry.download.url]).join('\n') + '\n将使用随包清单的 SHA-256 验证下载；已存在的同名模型会被替换，其它模型不会删除。',
      buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (result.response !== 0 || engineModelsCancelled) return cancelledEngineModels();
    if (!localMainCaller(event)) return engineModelsFailure('主窗口已经关闭，模型操作已停止。');
    if (await runningImageEngine()) return engineModelsFailure('图像引擎端口正在使用，请先退出引擎后重试。');
    if (engineModelsCancelled) return cancelledEngineModels();
    return await managedEngineModels().request(action, model, { source, overwrite: true });
  } catch (error) { return engineModelsFailure(String(error.message || error)); }
  finally { engineOperationBusy = false; engineModelsPending = false; }
});
// ── 打开模型文件夹（抠像模型放这儿，用户要把网盘下的文件拖进去）──
// ⚠ 路径规则和 cache_root 一套：开发时项目内、打包后 %LOCALAPPDATA%（docs/34）。
//   ⚠ 必须先 mkdir —— 文件夹不存在时 openPath 会静默失败，
//     表现成"点了没反应"，正是最忌讳的那种（docs/40 规矩5）。
ipcMain.handle('engine:openModelsDir', async event => {
  if (!localMainCaller(event)) return { ok: false, error: '引擎操作仅允许软件主窗口调用。' };
  const { shell } = require('electron');
  const dir = engineModelsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error ? { ok: false, dir, error } : { ok: true, dir };
  } catch (error) { return { ok: false, dir, error: error.message }; }
});

// Photoshop 首次引导：检测和启动由主进程完成，渲染层只拿到候选路径和结果。
// 真实 UXP 安装仍要求用户确认目标 Photoshop 版本，避免误改另一套 PS。
ipcMain.handle('photoshop:discover', (event, explicitPath) => {
  if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return { ok: false, error: 'PHOTOSHOP_CALLER_DENIED', candidates: [] };
  try { return photoshopService.discover(explicitPath); }
  catch (error) { return { ok: false, error: error.message || String(error), candidates: [] }; }
});
ipcMain.handle('photoshop:launch', async (event, candidate) => {
  if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return { ok: false, error: 'PHOTOSHOP_CALLER_DENIED' };
  try { return await photoshopService.launch(candidate || {}); }
  catch (error) { return { ok: false, error: error.message || String(error), detail: error.detail || '' }; }
});
function localMainCaller(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url.startsWith('file:');
}
ipcMain.handle('photoshop:choose', async event => {
  if (!localMainCaller(event)) return { ok: false, error: 'PHOTOSHOP_CALLER_DENIED', candidates: [] };
  const selected = await require('electron').dialog.showOpenDialog(setupHost.window(), { title: '选择 Photoshop', properties: process.platform === 'darwin' ? ['openFile','openDirectory'] : ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Photoshop', extensions: ['exe'] }] : [] });
  if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true, candidates: [] };
  try {
    const launcher = require('../foundation/photoshop/photoshop-launcher');
    const chosen = process.platform === 'darwin' && selected.filePaths[0].endsWith('.app') ? launcher.bundleExecutable(selected.filePaths[0]) : selected.filePaths[0];
    return Object.assign(photoshopService.discover(selected.filePaths[0]), { selectedPath: launcher.canonicalExecutable(chosen) });
  } catch (error) { return { ok: false, error: error.message, candidates: [] }; }
});
for (const operation of ['inspect','install','rollback']) {
  ipcMain.handle('photoshop:' + operation, async (event, candidate, backupId) => {
    if (!localMainCaller(event) || !uxpInstaller) return { ok: false, error: 'PHOTOSHOP_CALLER_DENIED' };
    try {
      const info = await uxpInstaller.inspect(candidate || {});
      if (operation === 'inspect') return info;
      if (info.running) return { ok: false, error: 'UXP_PS_RUNNING' };
      const accepted = await require('electron').dialog.showMessageBox(setupHost.window(), { type: 'question', title: operation === 'install' ? '安装 Photoshop 联动插件' : '恢复联动插件备份',
        message: operation === 'install' ? '将联动插件安装到所选 Photoshop？' : '将联动插件恢复到指定备份？',
        detail: info.target + '\nPhotoshop 必须已关闭。完成后仍需启动 Photoshop 并通过联动握手验证。',
        buttons: ['取消', operation === 'install' ? '安装' : '恢复'], defaultId: 0, cancelId: 0, noLink: true });
      if (accepted.response !== 1) return { ok: false, cancelled: true, error: 'UXP_CONFIRMATION_REQUIRED' };
      return operation === 'install' ? await uxpInstaller.install(candidate || {}) : await uxpInstaller.rollback(candidate || {}, backupId);
    } catch (error) { return { ok: false, error: error.code || error.message || 'UXP_INSTALL_FAILED', detail: error.detail || '' }; }
  });
}
// 2026-10-24（V7待办/12.3，铁律 14）：插件重复检测只在 Tauri 正式壳实现（photoshop.rs + uxp_installer::copies）。
//   Electron 开发壳给同形空壳：界面拿到 UNSUPPORTED 就照旧弹老的「插件版本旧」卡，不会坏。
ipcMain.handle('photoshop:bridgeCopies', async event => {
  if (!localMainCaller(event)) return { ok: false, error: 'PHOTOSHOP_CALLER_DENIED' };
  return { ok: false, error: 'UNSUPPORTED', copies: [] };
});
ipcMain.handle('http:cancel', (_event, requestId) => {
  const c = httpControllers.get(String(requestId || ''));
  if (c) { try { c.abort(); } catch (_) {} }
  return { ok: true, requestId: String(requestId || '') };
});

// ── 点击穿透: 鼠标不在 UI 上时, 让窗口把点击交给下层(PS 等) ──
// 【铁律, 来自 V7】setIgnoreMouseEvents 在 Windows 上会重设窗口鼠标区域,
//   调用太频繁会让窗口短暂丢失鼠标捕获(拖拽脱节/闪烁)。
//   所以渲染进程侧必须做状态去重 + 滞回, 只在跨边界那一刻调一次。
ipcMain.on('win:ignoreMouse', (_e, ignore) => {
  if (!win || win.isDestroyed()) return;
  if (setupHost.isOpen()) return;
  if (browserHost && (browserHost.state().workspace || browserHost.state().open)) ignore = false;
  mouseIgnored = !!ignore;
  win.setIgnoreMouseEvents(mouseIgnored, { forward: true });
  // 穿透切换本身会重置置顶 Z 序 → 切完立刻拉回顶层。
  // 注意: 只在"不是拖动中"时才拉, 拖动中有自己的位置/置顶管理。
  if (!dragBase) raiseTop();
  if (mouseIgnored) startPointerProbe();
  else stopPointerProbe();
});

ipcMain.on('win:cursorProbeResult', (event, payload) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !mouseIgnored) return;
  if (!payload || payload.overUI !== true) return;
  mouseIgnored = false;
  win.setIgnoreMouseEvents(false, { forward: true });
  stopPointerProbe();
  if (!dragBase) raiseTop();
});

app.whenReady().then(async () => {
  if (!firstInstance) return;
  uxpInstaller = createUxpInstaller({ sourceDir: path.join(__dirname, '..', 'uxp-bridge'), stateDir: app.getPath('userData'), authorize: photoshopService.authorize });
  resident = installResident({ app, ipcMain, Tray, Menu, Notification, nativeImage, getWindow: () => win,
    isMainSender: sender => !!win && !win.isDestroyed() && sender === win.webContents,
    iconPath: path.join(__dirname, '../src-tauri/icons/icon.ico') });
  registerSecretsIpc(ipcMain, {
    directory: path.join(app.getPath('userData'), 'protected-keys'),
    safeStorage: require('electron').safeStorage,
    projectRoot: path.join(__dirname, '..'),
    isMainSender: sender => !!win && !win.isDestroyed() && sender === win.webContents
  });
  registerAgentPresetInbox(ipcMain, {
    appData: app.getPath('appData'), projectRoot: path.join(__dirname, '..'),
    isMainSender: sender => !!win && !win.isDestroyed() && sender === win.webContents,
    openPath: folder => require('electron').shell.openPath(folder),
    confirm: async () => (await require('electron').dialog.showMessageBox(win, {
      title: 'Agent 预设收件箱', message: '启用当前账号的 Agent 预设收件箱？',
      detail: '外部 Agent 将 JSON 写入固定目录，校验后进入专用预设列表。每次导入前自动建立恢复节点。切换账号或退出后需重新启用。不要在文件内放密钥或图片。',
      buttons: ['取消', '启用'], defaultId: 0, cancelId: 0, noLink: true
    })).response === 1
  });
  agentIpc = registerAgentIpc(ipcMain, {
    governance: (await require('../foundation/agent/agent-workspace-electron').setup({ electron: require('electron'), projectRoot: path.join(__dirname, '..'), dataRoot: app.getPath('userData'), version: app.getVersion() })).governance,
    projectRoot: path.join(__dirname, '..'),
    isMainSender: sender => !!win && !win.isDestroyed() && sender === win.webContents,
    confirmAccess: async (_sender, tier) => {
      const titles = { preset_editor: '编辑预设', software_developer: '修改软件', administrator: '修改和删除软件文件' };
      const response = await require('electron').dialog.showMessageBox(win, {
        type: 'warning', title: 'Agent 访问权限',
        message: '允许 Agent 在未来 30 分钟内' + titles[tier] + '？',
        detail: '修改前会建立备份。此权限不允许修改缓存、用户图片、PSD、密钥或其他软件。Agent 可能改坏软件；请先了解修改目的，必要时从备份节点恢复。',
        buttons: ['保持只读', '允许本次访问'], defaultId: 0, cancelId: 0, noLink: true
      });
      return response.response === 1;
    }
  });
  // 2026-10-18 晚：开机不再注册默认快捷键（默认都没有）；界面读到用户设置后会调 shortcut:set-* 注册
  createWindow();
  browserHost = registerBrowserIpc(ipcMain, { electron: require('electron'), parent: () => win,
    emit: (name, value) => { if (win && !win.isDestroyed()) win.webContents.send(name, value); } });
  startLinkServer();
});
app.on('before-quit', stopLinkServer);
// ⭐⭐ 2026-10-10（修用户实测报的"显存被吃满"）：
//   软件退出时必须把【本次软件启动的】图像引擎一起关掉。
//
//   ⚠ 为什么必须在这里关：
//     引擎是 detached + unref 起来的（故意的，为了让软件重启时模型还在显存里），
//     所以【没有任何机制】会在软件退出时收走它 —— 实测它带着 9.6GB 显存
//     活了 42 小时（主程序早就关了）。
//
//   ⚠ 为什么走 stopEngine 而不是直接 kill：
//     引擎自己 spawn 了 torch_worker（吃显存的大头）。
//     kill 引擎本体的话，那个子进程会变孤儿继续活着 —— 等于没修。
//     stopEngine 现在会先请引擎"正常关闭"，引擎会把子进程一起带走并还显存。
//
//   ⚠ 时序：before-quit 里做异步收尾要 preventDefault + 自己 quit 一次，
//     否则 Electron 不等你、进程直接就没了，引擎反而留成孤儿。
//     这里用一个 once 闸门，保证只拦一次、不会自己套自己。
let engineShutdownDone = false;
app.on('before-quit', event => {
  if (engineShutdownDone) return;                 // 第二次进来 = 我们自己调的那次，放行
  const launcher = (() => { try { return require('./engine-launcher.cjs'); } catch (_) { return null; } })();
  if (!launcher || typeof launcher.stopEngine !== 'function') return;
  event.preventDefault();
  engineShutdownDone = true;
  // ⚠⚠ 这些 const/箭头函数（APP_DATA_ROOT / engineDataRoot / engineResourceRoot）定义在本文件
  //   一千两百多行之后，而这段代码在一千五百多行 —— 万一将来有人把退出逻辑挪到更前面，
  //   或者出现"极早期就退出"的路径，直接引用会踩【暂时性死区】（TDZ）抛 ReferenceError，
  //   那软件就关不掉了。所以取值一律包在 try 里，取不到就用 __dirname 兜底。
  let resourceRoot = path.join(__dirname, '..');
  let logsDir = path.join(__dirname, '..', 'tmp', 'engine-logs');
  try {
    resourceRoot = engineResourceRoot();
    logsDir = app.isPackaged ? path.join(engineDataRoot(), 'engine-logs') : path.join(APP_DATA_ROOT, 'tmp/engine-logs');
  } catch (_) { /* 保持上面的兜底值 */ }
  // ⚠ 给一个总超时兜底：某个引擎卡住时不能让软件关不掉。
  //   单次 stopEngine 内部已经有 6 秒上限，两个引擎最多 12 秒 —— 这里给 8 秒就够，
  //   超了直接放行退出（引擎有"爹没了就自己走"的兜底，不会赖着）。
  let finished = false;
  const finish = () => { if (!finished) { finished = true; try { app.quit(); } catch (_) {} } };
  const timer = setTimeout(finish, 8000);
  Promise.allSettled(['matting', 'match'].map(which =>
    Promise.resolve(launcher.stopEngine(which, { resourceRoot, logsDir }))
  )).then(() => { clearTimeout(timer); finish(); });
});
// 退出必须交还全局快捷键, 否则反复重启调试时会留下占用。
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else if (resident) resident.restore(); });
