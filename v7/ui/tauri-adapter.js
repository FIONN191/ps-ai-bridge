(function () {
  'use strict';

  // Keep the formal UI independent from Electron and Tauri window objects.
  // Photoshop/UXP traffic goes through the localhost bridge owned by Rust;
  // the page only knows the small invoke/event contract below.
  const tauri = window.__TAURI__ || null;
  const current = tauri && tauri.window && typeof tauri.window.getCurrentWindow === 'function'
    ? tauri.window.getCurrentWindow()
    : null;

  if (!current) return;
  // 2026-10-18 教程（tutorial-host.js）：教程页里嵌的界面用假 PS / 假后台，绝不能被换回真接口（真接口会真的发请求、真的改 PS）
  if (window.__V7_TUTORIAL__) return;

  const invoke = tauri && tauri.core && typeof tauri.core.invoke === 'function'
    ? tauri.core.invoke
    : null;
  const listen = tauri && tauri.event && typeof tauri.event.listen === 'function'
    ? tauri.event.listen
    : null;
  const cursorPosition = tauri && tauri.window && typeof tauri.window.cursorPosition === 'function'
    ? tauri.window.cursorPosition
    : null;
  // ⚠ 2026-10-03 抢焦点根治（docs/127）：这里**不再自己记账做去重**了。
  //   以前 ignoreState 是"适配层记的一本账"，界面那边还有一本（ignorePromise/ignored），
  //   加上 Rust 原生窗口的真实状态，一共三本。外壳一旦绕过 JS 直接改状态
  //   （自由模式看门狗 / 幕布全屏 / 设置窗口），账本对不上，恢复指令就被
  //   `ignoreState === next` 静默吞掉 —— 表现就是"点不到下面的 PS，动一下鼠标才好"。
  //
  //   现在：**去重挪到 Rust**（`src-tauri/src/ignore_state.rs`），JS 只负责
  //   "把期望值老实发过去 + 串行化"。串行化不能省 —— 原生 IPC 是异步的，
  //   快速移出/移回时旧回调会把窗口留在穿透状态。
  //   ignoreState 降级成"最后一次确认值"，只给恢复轮询看，不再参与决策。
  let httpAutoSeq = 0;   // 不带编号的对外请求现编唯一编号用（见 http.fetch 那段 2026-10-16 的注释）
  let ignoreState = null;
  let ignoreQueue = Promise.resolve();
  let ignoreBusy = false;
  let ignoreQueuedTarget = null;
  let ignoreLastRequest = null;
  let recoveryTimer = null;
  let recoveryBusy = false;
  let browserOpen = false;
  let setupOpen = false;

  // ── 点击穿透体检日志（2026-09-28）────────────────────────────
  //   "偶发点不到桌面"这类问题只靠手点很难复现。这里把穿透状态机的
  //   每一次决策都打一行出来，出事以后回看日志就知道是谁的锅：
  //     SKIP  = 指令被"状态没变"提前吞掉了（看门狗账本错位时就是这里卡住）
  //     NATIVE= 真的调了原生接口，状态从 x 变成 y
  //     RESET = 原生看门狗发来 mouse-reset（两个相反分支共用的事件名）
  //   走 debug_log 发到 Rust 控制台；从控制台父进程启动 exe 才看得见。
  let ignoreTraceSeq = 0;
  function ignoreTrace(what, detail) {
    if (!invoke || typeof invoke !== 'function') return;
    try {
      invoke('debug_log', {
        message: '[穿透#' + (++ignoreTraceSeq) + '] ' + what + ' ' + (detail || '')
      }).catch(function () {});
    } catch (_) { /* 体检日志不能影响主流程 */ }
  }

  function unavailable(name) {
    return Promise.resolve({ ok: false, error: name + ' 尚未接入 Tauri 主进程' });
  }

  // 当前 L4 的 id。主窗口按 id 管理 L4，Tauri 侧同时只会有一个，用它换算回去。
  let l4Current = '';
  let l4ActionId = '';
  // Tauri 的 L4 只有一个固定标签窗口。多个错误仍在 UI 层各自保留处理器，
  // 这里按顺序排队，当前错误处理完后再显示下一条，不能用新错误覆盖旧错误。
  const l4Pending = [];
  let l4Operation = Promise.resolve();
  let l4ClosingId = '';
  const l4ClosedListeners = new Set();
  const l4ClosedIds = new Set();
  let l4ClosedSubscription = null;
  function notifyL4Closed(id) {
    const value = String(id || '');
    if (!value || l4ClosedIds.has(value)) return;
    l4ClosedIds.add(value);
    l4ClosedListeners.forEach(function (callback) { try { callback(value); } catch (_) {} });
  }
  function queueL4Operation(operation) {
    const next = l4Operation.then(operation, operation);
    // 一次失败不能让后续 L4 操作永久停在 rejected 链上。
    l4Operation = next.catch(function () {});
    return next;
  }
  function ensureL4ClosedSubscription() {
    if (!listen) return Promise.resolve(false);
    if (l4ClosedSubscription) return l4ClosedSubscription;
    l4ClosedSubscription = Promise.resolve().then(function () {
      return listen('l4:closed', function (event) {
        const id = String(event && event.payload && event.payload.id || '');
        if (!id) return;
        if (l4ClosingId) {
          if (id !== l4ClosingId) return;
          l4ClosingId = '';
        } else {
          // 应急命令直接由子窗口调用；只有匹配当前编号的原生回执可清理队列。
          if (id !== l4Current) return;
          l4Current = '';
        }
        l4ActionId = '';
        notifyL4Closed(id);
        promoteNextL4().catch(function () {});
      });
    }).then(function () { return true; }).catch(function () {
      l4ClosedSubscription = null;
      return false;
    });
    return l4ClosedSubscription;
  }
  function promoteNextL4() {
    if (l4Current || l4ClosingId || !l4Pending.length) return Promise.resolve({ ok: true, queued: false });
    const entry = l4Pending.shift();
    l4Current = entry.id;
    l4ActionId = '';
    l4ClosedIds.delete(entry.id);
    return queueL4Operation(async function () {
      // 先订阅原生销毁回执再开窗口，首个应急关闭也不会丢清理通知。
      await ensureL4ClosedSubscription();
      return invoke('l4_open', { payload: entry.payload });
    });
  }
  function closeL4Blocking(id) {
    if (!invoke) return Promise.resolve({ ok: false, error: 'L4 冻结窗口' });
    const target = String(id || '');
    if (target && target !== l4Current) {
      const pendingIndex = l4Pending.findIndex(entry => entry.id === target);
      if (pendingIndex >= 0) {
        l4Pending.splice(pendingIndex, 1);
        notifyL4Closed(target);
      }
      return Promise.resolve({ ok: true, removed: pendingIndex >= 0 });
    }
    if (!l4Current) return Promise.resolve({ ok: true, closed: false });
    const closingId = l4Current;
    l4Current = '';
    if (l4Pending.length) {
      // 同一个原生窗口直接换下一条；旧业务处理器先收到逻辑 closed 回执。
      notifyL4Closed(closingId);
      const next = l4Pending.shift();
      l4Current = next.id;
      l4ActionId = '';
      l4ClosedIds.delete(next.id);
      return queueL4Operation(function () {
        return invoke('l4_open', { payload: next.payload });
      });
    }
    l4ClosingId = closingId;
    const close = queueL4Operation(function () { return invoke('l4_close', { id: closingId }); });
    const restore = function () { if (l4ClosingId === closingId) { l4ClosingId = ''; l4Current = closingId; } };
    close.then(function (result) { if (result?.ok === false) restore(); }).catch(restore);
    return close;
  }
  // 大图传输流水号。图片和"第几张"绑同一个号，防止快速切图时张冠李戴。
  let viewerSeq = 0;

  // 置顶兜底。调用很频繁(每次切穿透), 失败静默 —— 它是兜底不是主流程。
  function raiseTop() {
    if (browserOpen || setupOpen) return;
    if (invoke) invoke('raise_top').catch(function () {});
  }

  // ── 大图：先把原图字节传过去，再让窗口显示/换图 ──
  // ⚠ 两步走是刻意的：字节走 raw invoke body(二进制直传)，
  //   元数据(第几张/共几张/要不要复位)走普通 JSON。
  //   合成一步的话字节就会被 JSON 序列化，8MB 图直接卡死。
  function viewerSend(command, payload) {
    if (!invoke) return unavailable('大图查看');
    const data = payload || {};
    const bytes = data.bytes;
    const meta = {
      num: Number(data.num) || 0,
      total: Number(data.total) || 0,
      reset: !!data.reset,
      mime: data.mime || 'image/png'
    };
    // ⚠ 失败必须抛出去, 不能默默返回 {ok:false} ——
    //   调用方只 catch 不查返回值, 吞掉就成了"点了没反应, 也没报错", 根本没法查。
    const check = function (res) {
      if (res && res.ok === false) throw new Error(res.error || '大图窗口打开失败');
      return res;
    };
    // ⚠⚠ 图片和"第几张"必须【绑同一个流水号】一起送 ——
    //   以前是分两步(先 put 图，再 show 序号)，中间可以被下一次插队：
    //     put(第3张) → put(第4张) → show(第3张的序号) → 子窗口取到第4张的图
    //   结果画面是第4张、底下写着"3 / 8"。快速滚动切图时必现(Electron 那边是
    //   一条消息把图和序号一起发的，所以只有 Tauri 会遇到)。
    //   现在 Rust 侧把 seq 和图片一起存，show 时核对，对不上就不显示。
    viewerSeq += 1;
    const seq = viewerSeq;
    meta.seq = seq;
    const show = function () { return invoke(command, { meta: meta }).then(check); };
    if (!bytes || !bytes.byteLength) return show();
    // Tauri v2: invoke 的第二参数是 ArrayBuffer/Uint8Array 时按原始二进制发送。
    const buffer = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    return invoke('viewer_put_image', buffer, { headers: { mime: meta.mime, seq: String(seq) } })
      .then(check)
      .then(show)
      .catch(function (error) {
        console.error('[大图] 失败:', error);
        throw error;
      });
  }

  // ── 快捷键格式转换 ──
  // 界面内部用的是 'mod+enter' / 'mod+alt+2' 这种小写格式(和 Electron 侧同源)，
  // Tauri 的解析器要的是 'CommandOrControl+Enter' / 'CommandOrControl+Alt+Digit2'。
  // ⚠ 数字键必须写成 DigitN、字母键必须写成 KeyX，直接给 '2' 或 'a' 解析不了。
  function tauriAccelerator(value) {
    const parts = String(value || 'mod+enter').toLowerCase().split('+')
      .map(function (x) { return x.trim(); }).filter(Boolean);
    const out = [];
    if (parts.indexOf('mod') >= 0) out.push('CommandOrControl');
    if (parts.indexOf('ctrl') >= 0) out.push('Control');
    if (parts.indexOf('alt') >= 0) out.push('Alt');
    if (parts.indexOf('shift') >= 0) out.push('Shift');
    const mods = ['mod', 'ctrl', 'alt', 'shift'];
    const key = parts.filter(function (x) { return mods.indexOf(x) < 0; })[0];
    if (!key) return '';
    const named = {
      enter: 'Enter', space: 'Space', esc: 'Escape', escape: 'Escape',
      tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight'
    };
    if (named[key]) out.push(named[key]);
    else if (/^[0-9]$/.test(key)) out.push('Digit' + key);
    else if (/^[a-z]$/.test(key)) out.push('Key' + key.toUpperCase());
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) out.push(key.toUpperCase());
    else return '';
    return out.join('+');
  }

  const aiControllers = new Map();
  // 一次最多生成多少张。⚠ 必须和 ui.html 的 AI_BATCH_MAX、main.js 同值(铁律 14)。
  //   只改界面不改这里的话，界面显示上限 18、后端照样肯跑更多。
  const AI_BATCH_MAX = 18;
  // ⭐ 2026-10-21（用户：「做一个并发错峰，然后做一个网络抖动重试」，照 V6 host/concurrency-pool.js + host/ai-api.js _fetchWithRetry）
  //   ① 错峰：任意两条出图请求的【发起】至少隔 120ms（跨任务也算）。几张同时算时一起建连 / 解析 DNS，
  //      开着代理（Clash）的电脑上常常前几条一起「连不上」。同时在跑的数量不受影响，只是错开起步。
  //   ② 抖动重试：只重试「请求还没送到服务器」的失败 —— 重试不会重复出图、重复扣钱：
  //      · 外壳报「连不上服务器」（DNS / 建连 / TLS 握手没成）⇒ 一定没送到，重试；
  //      · 外壳报笼统的「网络错误」且 3 秒内就失败 ⇒ 多半还在建连阶段，重试（V6 同一条线）；
  //      · 超时、已取消、服务器回了错误（那是有回应，不是抛错）⇒ 一律不重试。
  //      最多重试 2 次，间隔 400ms×次数 + 随机 0~200ms（错开）。
  const AI_LAUNCH_GAP_MS = 120, AI_RETRY_MAX = 2, AI_CONNECT_GUARD_MS = 3000;
  let aiLastLaunchAt = 0;
  function aiLaunchSlot() {
    const now = Date.now(), at = Math.max(now, aiLastLaunchAt + AI_LAUNCH_GAP_MS);
    aiLastLaunchAt = at;
    return at > now ? new Promise(function (resolve) { setTimeout(resolve, at - now); }) : Promise.resolve();
  }
  function aiNetRetryable(error, elapsedMs) {
    const message = String((error && error.message) || error || '');
    if (/已取消|AbortError|超时/.test(message)) return false;
    if (/^连不上服务器/.test(message)) return true;
    return /^网络错误/.test(message) && elapsedMs < AI_CONNECT_GUARD_MS;
  }
  async function aiFetchWithRetry(send, controller, label) {
    for (let attempt = 1; ; attempt++) {
      await aiLaunchSlot();
      if (controller && controller.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      const started = Date.now();
      try { return await send(); }
      catch (error) {
        const elapsed = Date.now() - started;
        if ((controller && controller.aborted) || attempt > AI_RETRY_MAX || !aiNetRetryable(error, elapsed)) {
          if (attempt > 1) {
            const text = String((error && error.message) || error || '网络错误') + '（已自动重试 ' + (attempt - 1) + ' 次）';
            throw (error && typeof error === 'object') ? Object.assign(error, { message: text }) : new Error(text);
          }
          throw error;
        }
        const wait = 400 * attempt + Math.floor(Math.random() * 200);
        try { console.warn('[出图] ' + (label || '') + ' 第 ' + attempt + ' 次网络失败（' + elapsed + 'ms）：' + String((error && error.message) || error) + ' → ' + wait + 'ms 后重试'); } catch (_) {}
        await new Promise(function (resolve) { setTimeout(resolve, wait); });
      }
    }
  }
  let aiSequence = 0;
  const aiCleanBase64 = value => { const s=String(value||'').trim(); const i=s.indexOf(','); return s.indexOf('data:')===0&&i>=0?s.slice(i+1):s; };
  const aiMime = (value,fallback='image/png') => { const m=/^data:([^;,]+)/i.exec(String(value||'')); return m?m[1]:fallback; };
  function aiUrl(raw,label){ const value=String(raw||'').trim(); if(!value) throw new Error((label||'API URL')+'不能为空'); let u; try{u=new URL(value);}catch(_){throw new Error((label||'API URL')+'格式无效');} if(!/^https?:$/.test(u.protocol)) throw new Error((label||'API URL')+'只允许 http/https'); return value.replace(/\/+$/,''); }
  function aiEndpoint(p){
    const ep=String(p.endpoint||'').trim(); if(ep&&/^https?:\/\//i.test(ep)) return aiUrl(ep,'Endpoint');
    const base=aiUrl(p.baseUrl||p.url,'API URL'); if(ep){if(!ep.startsWith('/')) throw new Error('Endpoint 路径必须以 / 开头，或填写完整 http/https URL'); return base+ep;}
    const gpt=aiIsGptImage(p);
    if(String(p.protocol||'gemini').toLowerCase()==='openai'||gpt){
      const parsed=new URL(base);if(/\/images\/(?:generations|edits)\/?$/i.test(parsed.pathname))return base;
      if(gpt)parsed.pathname=parsed.pathname.replace(/\/v1beta\/?$/i,'');   // 香蕉那套地址填到了 /v1beta 也能接上
      const action=gpt||aiInputImages(p).length?'edits':'generations';
      parsed.pathname=parsed.pathname.replace(/\/+$/,'')+(/\/v1\/?$/i.test(parsed.pathname)?'/images/':'/v1/images/')+action;
      return parsed.toString();
    }
    const model=encodeURIComponent(String(p.model||'').trim()); if(!model) throw new Error('模型不能为空'); if(/\/v1beta\/models\/[^/]+:generateContent(\?|$)/i.test(base))return base; return /\/v1beta$/i.test(base)?base+'/models/'+model+':generateContent':base+'/v1beta/models/'+model+':generateContent';
  }
  function aiInputImages(p){
    const images=[];
    function add(value,mime){
      const b64=aiCleanBase64(value).replace(/\s/g,'');
      if(!b64||!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)||b64.length%4===1||(b64.includes('=')&&b64.length%4!==0))throw new Error('图片数据无效，请重新选择参考图或重新抓图');
      images.push({b64,mime:mime||aiMime(value)});
    }
    const input=p.inputImageBase64||p.inputBase64;if(input)add(input,p.inputMime);
    (Array.isArray(p.refImages)?p.refImages:[]).forEach(ref=>add(typeof ref==='string'?ref:ref&&(ref.imageBase64||ref.base64),ref&&ref.mime));
    return images;
  }
  // ⭐ 2026-10-23（用户报：阿吉 GPT Image 加两张参考图 ⇒ HTTP 400，V6 正常）：
  //   V6 只要模型名带 gpt-image 就单独走 OpenAI 的 /v1/images/edits 表单上传（V6 host/ai-api.js callGptImageNewApi），
  //   V7 原来照香蕉一律发 Gemini 格式 ⇒ 阿吉不认。这里照 V6 补回：不管连接上选的协议，GRS 除外（那边是另一套协议，6.7.0 要删）。
  //   跟 V6 对齐的几处：多张图字段都叫 image（不是 image[]）；尺寸用 GPT 支持的固定档；没图塞 1×1 透明图；回任务号就轮询。
  //   ⚠ main.js 有同一套（铁律 14），两边一起改。
  const aiIsGptImage=p=>/gpt-image/i.test(String(p&&p.model||''))&&String(p&&p.connectionSlot||'')!=='grs'&&String(p&&p.provider||'')!=='grs';
  const AI_GPT_BLANK_PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  function aiGptSize(p){const k=String(p.size||'1K').toUpperCase(),m=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(p.aspectRatio||'')),r=m&&Number(m[2])>0?Number(m[1])/Number(m[2]):0,wide=r>1,tall=r>0&&r<1;
    if(k==='4K')return tall?'2160x3840':'3840x2160';   // 4K 没有 1:1，方图/Auto 都给横屏（V6 同款）
    if(k==='2K')return tall?'1152x2048':wide?'2048x1152':'2048x2048';
    return tall?'1024x1536':wide?'1536x1024':'1024x1024';}
  // 异步回执：{task_id} 或 {data:{task_id}}；轮询结果：{data:{status, data:[…]}}（V6 _extractGptImageBase64 同款判据）
  function aiGptTaskId(body){return String(body&&(body.task_id||(body.data&&!Array.isArray(body.data)&&body.data.task_id))||'');}
  function aiGptTaskState(body){const d=body&&body.data&&!Array.isArray(body.data)&&typeof body.data==='object'?body.data:body||{},st=String(d.status||'').toLowerCase();
    if(['failure','failed','error'].includes(st)){const why=d.fail_reason||d.error||d.message;return {failed:why?(typeof why==='string'?why:JSON.stringify(why).slice(0,200)):'未知错误'};}
    const done=['success','succeeded','completed','done','finished'].includes(st);return {done,pending:!!st&&!done,unknown:!st};}
  // 2026-10-24（V7待办/05）：自己填了完整 endpoint（如 https://host/proxy/v1/images/generations）时，保留 /images/ 前面的前缀
  function aiGptPollUrl(url,id){const u=new URL(url),tail='/images/tasks/'+encodeURIComponent(id),at=u.pathname.toLowerCase().lastIndexOf('/images/');u.pathname=at>=0?u.pathname.slice(0,at)+tail:'/v1'+tail;u.search='';return u.toString();}
  function aiSize(p){const side=({ '1K':1024,'2K':2048,'4K':4096 })[String(p.size||'1K').toUpperCase()]||1024;const m=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(p.aspectRatio||'1:1'));if(!m)return side+'x'+side;const r=Number(m[1])/Number(m[2]);return r>=1?side+'x'+Math.max(1,Math.round(side/r)):Math.max(1,Math.round(side*r))+'x'+side;}
  function aiCollect(value,out,urls,seen){if(value==null)return;if(Array.isArray(value)){value.forEach(v=>aiCollect(v,out,urls,seen));return;}if(typeof value!=='object')return;const inline=value.inlineData&&value.inlineData.data?value.inlineData:null;if(inline){const b=aiCleanBase64(inline.data),k='b:'+b.length+':'+b.slice(0,30);if(b&&!seen.has(k)){seen.add(k);out.push({imageBase64:b,mime:inline.mimeType||'image/png'});}}if(value.b64_json){const b=aiCleanBase64(value.b64_json),k='b:'+b.length+':'+b.slice(0,30);if(b&&!seen.has(k)){seen.add(k);out.push({imageBase64:b,mime:value.mime||'image/png'});}}if(typeof value.image_base64==='string'){const b=aiCleanBase64(value.image_base64),k='b:'+b.length+':'+b.slice(0,30);if(b&&!seen.has(k)){seen.add(k);out.push({imageBase64:b,mime:value.mime||'image/png'});}}if(typeof value.url==='string'&&/^https?:\/\//i.test(value.url)&&!urls.includes(value.url))urls.push(value.url);Object.keys(value).forEach(k=>aiCollect(value[k],out,urls,seen));}
  // URL 型输出必须和 b64_json / inlineData 走同一套 Base64 合同。
  // 直接把二进制字节拼成 JS 字符串会在非 ASCII 字节上损坏 PNG，
  // 这个问题只会出现在 Tauri 壳，Electron 侧已经用 Buffer 正确编码。
  async function aiDownload(url){const r=await fetch(url);if(!r.ok)throw new Error('图片 URL 下载失败 HTTP '+r.status);return {imageBase64:aiBinaryBase64(await r.arrayBuffer())};}
  function aiBinaryBase64(buf){let s='';const bytes=new Uint8Array(buf);const step=0x8000;for(let i=0;i<bytes.length;i+=step)s+=String.fromCharCode(...bytes.subarray(i,i+step));return btoa(s);}
  async function aiBuild(p){
    const gpt=aiIsGptImage(p), protocol=gpt?'openai':String(p.protocol||'gemini').toLowerCase(), prompt=String(p.prompt||'').trim();if(!prompt)throw new Error('提示词不能为空');
    const endpoint=aiEndpoint(p), key=String(p.apiKey||'').trim(), headers={'Content-Type':'application/json'};let url=endpoint;let authMode=String(p.authMode||'bearer').toLowerCase();if(gpt&&authMode==='x-goog-api-key')authMode='bearer';if(!['bearer','query','x-goog-api-key'].includes(authMode)||authMode==='x-goog-api-key'&&protocol!=='gemini')throw new Error('请核对当前协议的鉴权方式');if(key&&authMode==='query')url+=(url.includes('?')?'&':'?')+'key='+encodeURIComponent(key);else if(key&&authMode==='x-goog-api-key')headers['x-goog-api-key']=key;else if(key)headers.Authorization='Bearer '+key;
    const input=aiCleanBase64(p.inputImageBase64||p.inputBase64), refs=Array.isArray(p.refImages)?p.refImages:[];
    if(protocol==='openai'){
      const body={model:String(p.model||'').trim(),prompt,n:1,size:gpt?aiGptSize(p):aiSize(p),response_format:'b64_json'},images=aiInputImages(p);
      if(/\/edits\/?$/i.test(new URL(endpoint).pathname)){
        if(!images.length&&gpt)images.push({b64:AI_GPT_BLANK_PNG,mime:'image/png'});   // 阿吉的 GPT 节点至少要 1 张图（V6 同款）
        if(!images.length)throw new Error('图片编辑接口需要主图或参考图，请添加图片或改用 generations 接口');
        const form=new FormData();Object.keys(body).forEach(k=>form.append(k,String(body[k])));
        images.forEach((image,index)=>{
          const bytes=Uint8Array.from(atob(image.b64),ch=>ch.charCodeAt(0)),extension=({'image/jpeg':'jpg','image/webp':'webp'})[image.mime]||'png';
          form.append(images.length>1&&!gpt?'image[]':'image',new Blob([bytes],{type:image.mime}),'image_'+index+'.'+extension);
        });
        // Serialize the complete multipart body once so Rust receives its boundary and binary bytes intact.
        const encoded=new Response(form);headers['Content-Type']=encoded.headers.get('content-type');
        return {url,headers,body:aiBinaryBase64(await encoded.arrayBuffer()),bodyEncoding:'base64',gptImage:gpt};
      }
      if(images.length)throw new Error('当前 Endpoint 不支持图片输入，请改用 /images/edits；主图和参考图不会被忽略后继续生成');
      return {url,headers,body};
    }
    const parts=[{text:prompt}];if(input)parts.push({inlineData:{mimeType:p.inputMime||'image/png',data:input}});refs.forEach(r=>{const b=aiCleanBase64(typeof r==='string'?r:r&&(r.imageBase64||r.base64));if(b)parts.push({inlineData:{mimeType:r&&r.mime||'image/png',data:b}});});
    const generationConfig={responseModalities:['IMAGE','TEXT'],temperature:0.8,topP:0.95,maxOutputTokens:8192}, imageConfig={};if(p.size&&p.size!=='Auto')imageConfig.imageSize=p.size;if(p.aspectRatio&&p.aspectRatio!=='Auto')imageConfig.aspectRatio=p.aspectRatio;if(Object.keys(imageConfig).length)generationConfig.imageConfig=imageConfig;return {url,headers,body:{contents:[{role:'user',parts}],generationConfig}};
  }
  async function aiGenerate(payload,progress){
    const p=Object.assign({},payload||{}), taskId=String(p.taskId||('ai-'+Date.now().toString(36)+'-'+(++aiSequence))), total=Math.max(1,Math.min(AI_BATCH_MAX,Number(p.batch)||1)), controllers=[];aiControllers.set(taskId,controllers);const results=[],errors=[];let next=0,nextExtraIndex=total,completed=0;progress({taskId,phase:'started',completed:0,total});
    // ⭐ 2026-09-11：这里原先用的是浏览器 fetch —— 那是这条链路一直失败的根因。
    //   界面属于浏览器环境，跨域规则会把没带放行头的响应【整个丢掉】，
    //   连服务器明确回的「图片太大」(413) 都看不见，只剩一句 Failed to fetch。
    //   现在改走 Rust(window.uiwin.http.fetch)，没有跨域这回事，
    //   服务器回什么原样拿到什么 —— 包括它拒绝我们的真正理由。
    async function one(index){
      const httpId=taskId+'#'+index;
      // 取消仍然要能用：controllers 里塞一个能调 http.cancel 的壳，对上层接口不变。
      const controller={aborted:false,pollId:'',abort(){this.aborted=true;try{ window.uiwin.http.cancel(httpId); }catch(_){ }if(this.pollId)try{ window.uiwin.http.cancel(this.pollId); }catch(_){ } }};
      controllers.push(controller);
      try{
        const built=await aiBuild(p);
        if(controller.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'});
        // ⭐ 2026-10-17 夜（用户：「生图就直连就好了」）：出图请求和下结果图都 direct（不走系统代理，见 main.rs HttpFetchArgs.direct）
        // ⭐ 2026-10-21：错峰起步 + 只在请求没送到时自动重试（aiFetchWithRetry）
        const r=await aiFetchWithRetry(()=>window.uiwin.http.fetch({url:built.url,method:'POST',headers:built.headers,
          body:built.bodyEncoding?built.body:JSON.stringify(built.body),bodyEncoding:built.bodyEncoding,requestId:httpId,direct:true}),controller,'第 '+(index+1)+' 张');
        const raw=(r&&r.body)||'';let body=null;try{body=raw?JSON.parse(raw):null;}catch(_){}
        if(!r||!r.ok){
          // 服务器的原话优先；解析不出结构时把 body 原文截一段带出去 ——
          // 哪怕是一坨 HTML 错误页，也比"HTTP 413"这四个字有用得多。
          const serverSays=(body&&body.error&&(body.error.message||body.error.type))||(body&&body.message)
            ||(raw?String(raw).slice(0,300):'');
          // ⭐ 2026-10-21：502/503/504（或服务器原话里的错误码是这几个）= 服务商上游出图超时 / 不可用，单独一个码，报错卡说清「不是你的问题、可能已计费」
          const upstream=[502,503,504].includes(Number(r&&r.status))||[502,503,504].includes(Number(body&&body.error&&body.error.code));
          // 2026-10-24：model_not_found / No available channel = 服务商这个模型没通道（不是超时，同 error-report.js，铁律 14）
          const noChannel=/model_not_found|no available channel/i.test(String(raw||''));
          throw Object.assign(new Error('HTTP '+((r&&r.status)||'?')+(serverSays?('：'+serverSays):'')),
            {code:noChannel?'AI_MODEL_NO_CHANNEL':upstream?'AI_UPSTREAM_TIMEOUT':'AI_HTTP_ERROR',httpStatus:r&&r.status,serverBody:raw});
        }
        const images=[],urls=[];aiCollect(body,images,urls,new Set());
        // GPT Image 异步：没给图只给任务号 ⇒ 每 3 秒问一次，最长 1 小时，连错 5 次放弃（V6 同款）
        if(!images.length&&!urls.length&&built.gptImage&&aiGptTaskId(body)){
          const pollUrl=aiGptPollUrl(built.url,aiGptTaskId(body)),pollHeaders=built.headers.Authorization?{Authorization:built.headers.Authorization}:{},start=Date.now(),stop=()=>Object.assign(new Error('已取消'),{name:'AbortError'});let errs=0,n=0,blank=0;
          while(!images.length&&!urls.length){
            for(let w=0;w<3;w++){if(controller.aborted)throw stop();await new Promise(r=>setTimeout(r,1000));}
            if(controller.aborted)throw stop();
            if(Date.now()-start>3600000)throw Object.assign(new Error('GPT Image 等结果超时（1 小时）'),{code:'AI_UPSTREAM_TIMEOUT'});
            controller.pollId=httpId+'-poll-'+(++n);let d=null;
            try{d=await window.uiwin.http.fetch({url:pollUrl,method:'GET',headers:pollHeaders,requestId:controller.pollId,direct:true});}
            catch(e){if(controller.aborted)throw stop();if(++errs>=5)throw new Error('GPT Image 查询结果连续失败：'+(e.message||e));continue;}
            if(!d||!d.ok){if(++errs>=5)throw new Error('GPT Image 查询结果连续报错 HTTP '+((d&&d.status)||'?'));continue;}
            errs=0;let pb=null;try{pb=d.body?JSON.parse(d.body):null;}catch(_){continue;}
            const state=aiGptTaskState(pb);if(state.failed)throw new Error('GPT Image 任务失败：'+state.failed);
            if(state.pending)continue;
            aiCollect(pb,images,urls,new Set());
            if(state.done&&!images.length&&!urls.length)throw Object.assign(new Error('GPT Image 任务完成但没有返回图片'),{code:'AI_NO_IMAGE_RETURNED'});
            // 2026-10-24（V7待办/05）：没有状态也没有图 = 回包格式认不出来。原来会一直问到 1 小时超时；连续 20 次（约 1 分钟）就报
            if(state.unknown&&!images.length&&!urls.length&&++blank>=20)throw Object.assign(new Error('GPT Image 查询结果的格式认不出来（连续 20 次没有状态也没有图）：'+String(d.body||'').slice(0,200)),{code:'AI_NO_IMAGE_RETURNED'});
            if(!state.unknown)blank=0;
          }
        }
        // ⚠ 图片必须用 responseType:'base64' 拿 —— 按文本读会把二进制字节改坏，图必花。
        for(const u of urls){try{
          // 下载结果图是 GET，同样规矩重试（出过的图不会因为重试多扣钱，但一样只重试没连上的）
          const d=await aiFetchWithRetry(()=>window.uiwin.http.fetch({url:u,method:'GET',requestId:httpId+'-img',responseType:'base64',direct:true}),controller,'第 '+(index+1)+' 张结果图下载');
          if(d&&d.ok&&d.body)images.push({imageBase64:d.body,mime:String((d.headers&&d.headers['content-type'])||'image/png').split(';')[0]});
        }catch(e){errors.push({index,message:e.message});}}
        if(!images.length)throw Object.assign(new Error('API 未返回图片'),{code:'AI_NO_IMAGE_RETURNED'});
        const outputImages=images.map((image,imageIndex)=>Object.assign(image,{index:imageIndex===0?index:nextExtraIndex++,taskId}));
        outputImages.forEach(image=>{results[image.index]=image;progress({taskId,phase:'progress',completed:completed+1,total,index:image.index,image});});
        completed++;
      }catch(e){const cancelled=(e&&e.name==='AbortError')||/已取消/.test(String(e&&e.message||'')),message=cancelled?'已取消':(e.message||String(e));
      // ⚠ 错误码必须原样带出去(2026-09-11)。以前不管什么毛病都压成 AI_REQUEST_FAILED，
      //   上层拿到的永远是同一个码，报错卡就只能说"请求失败了"这种废话。
      errors.push({index,message,code:cancelled?'AI_CANCELLED':(e&&e.code)||'AI_REQUEST_FAILED',
        httpStatus:e&&e.httpStatus,serverBody:e&&e.serverBody});completed++;progress({taskId,phase:'progress',completed,total,index,error:message});}}
    try{const workers=Math.min(4,total);await Promise.all(Array.from({length:workers},async()=>{while(true){const i=next++;if(i>=total)return;await one(i);}}));const ordered=results.filter(Boolean).sort((a,b)=>Number(a.index)-Number(b.index));if(!ordered.length)return {ok:false,taskId,error:errors[0]&&errors[0].message||'AI 未返回任何图片',errors};const out={ok:true,taskId,results:ordered,errors,stats:{requested:total,succeeded:ordered.length,failed:errors.length}};progress(Object.assign({phase:'complete'},out));return out;}finally{aiControllers.delete(taskId);}
  }

  window.uiwin = {
    // ⭐⭐ 2026-10-09（用户定）：「砍掉软件里的社区，软件里只留一个「社区」按钮，点了跳网页」
    //   ⇒ 用【系统默认浏览器】打开外部网址。
    //   ⚠⚠ 不能用 window.open：这个 UI 跑在 tauri.localhost 的 WebView 里，
    //     window.open 会在【我们自己这个窗口】里导航或被 WebView 拦掉 ——
    //     用户看到的是界面没了，而不是浏览器起来了。要出到进程外面必须走 Rust。
    //   ⚠ Rust 侧只放行 http/https（白名单），且失败返回 false 不抛错 ——
    //     调用方（社区按钮）自己会说"启动浏览器失败"，不需要一张报错卡。
    //   ⚠ Electron 侧有同名接口（main.js），两个壳必须一致（铁律 14）。
    openExternalUrl(url) {
      if (!invoke) return Promise.resolve(false);
      return invoke('open_external_url', { url: String(url || '') })
        .then(function (ok) { return ok === true; })
        .catch(function () { return false; });
    },
    // ⚠⚠ 不用 Tauri 自带的 `startDragging()`（2026-09-12 换掉）。
    //   它走【系统原生窗口拖拽】，Windows 上拖动透明无边框窗口时
    //   系统会画出窗口矩形轮廓 —— 用户看到的"拖的时候冒出一个虚拟外框"就是它。
    //   那个轮廓是系统画的，CSS 关不掉。
    //   现在改成 Rust 侧自己算位置（drag_start/drag_end），
    //   和 Electron 侧（主进程高频 setPosition）行为一致，也没有轮廓。
    //   ⚠ Rust 那边照抄了 Electron 的两条防漂移规矩：基准锁死 + 光标不动不设位置。
    dragStart() {
      if (setupOpen) return Promise.resolve({ ok: true });
      if (!invoke) return unavailable('窗口拖拽');
      return invoke('drag_start').catch(function (e) {
        console.error('[拖拽] 启动失败:', e);
        // 兜底：自己算不了就退回系统拖拽（有轮廓，但总比拖不动强）
        if (typeof current.startDragging === 'function') return current.startDragging();
      });
    },
    // ⚠【铁律, Electron 侧实测】Windows 上拖完窗口 / 切换点击穿透都会重置置顶 Z 序，
    //   不重新拉回顶层，面板会被一键打回桌面层级(跑到 Photoshop 后面)。
    //   drag_end 里 Rust 已经补了一次置顶，这里再补一次没坏处（幂等）。
    dragEnd() {
      if (invoke) invoke('drag_end').catch(function () {});
      raiseTop();
    },
    setIgnoreMouse(ignore) {
      if (setupOpen) return Promise.resolve({ ok: true, ignored: false, supported: true });
      const next = browserOpen ? false : !!ignore;
      if (!invoke) {
        return Promise.resolve({ ok: false, ignored: false, supported: false, error: 'Tauri 点击穿透 API 不可用' });
      }
      // ⚠⚠ 2026-10-03 抢焦点根治（docs/127）：这里**不再自己判断"状态没变就跳过"**。
      //   那个判断就是抢焦点的根因 —— 外壳一旦绕过 JS 改了状态（看门狗/幕布/设置窗口），
      //   本地的账就跟原生对不上，恢复指令被静默吞掉，窗口一直吃鼠标。
      //   现在决策权归 Rust（`ignore_set` 命令里做去重），本层只负责【串行化】：
      //   原生 IPC 是异步的，快速移出/移回时旧回调会把窗口留在穿透状态。
      const run = async function () {
        const target = setupOpen || browserOpen ? false : next;
        try {
          // 期望值老实发过去；Rust 自己判断要不要真调原生 API（frequency 不增加）。
          const result = await invoke('ignore_set', { value: target });
          const applied = result && typeof result.ignored === 'boolean' ? result.ignored : target;
          ignoreTrace('NATIVE', 'want ' + target + ' -> ' + applied + (result && result.changed === false ? ' (外壳已是该状态)' : ''));
          // ignoreState 现在只是"最后一次确认值"，给恢复轮询看，不参与决策。
          ignoreState = applied;
          if (applied) startRecovery();
          else if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
          raiseTop();   // 切穿透会重置 Z 序，必须拉回顶层
          if (result && result.ok === false) {
            return { ok: false, ignored: applied, supported: true, error: result.error || '原生切换失败' };
          }
          return { ok: true, ignored: applied, supported: true };
        } catch (error) {
          // 失败时保留上一次已知值，下一次 mousemove 会重试（不再有"以为切成功"的假象）。
          return { ok: false, ignored: ignoreState === true, supported: true,
            error: error && error.message || String(error) };
        }
      };
      let request;
      if (!ignoreBusy) {
        // 启动第一条切换时立即发送；后续相反方向请求再接到队列尾部。
        ignoreBusy = true;
        ignoreQueuedTarget = next;
        request = run();
      } else {
        ignoreQueuedTarget = next;
        request = ignoreQueue.then(run, run);
      }
      ignoreQueue = request.catch(function () {});
      ignoreLastRequest = request;
      request.then(function () {
        if (ignoreLastRequest === request) {
          ignoreBusy = false;
          ignoreQueuedTarget = null;
          ignoreLastRequest = null;
        }
      }, function () {
        if (ignoreLastRequest === request) {
          ignoreBusy = false;
          ignoreQueuedTarget = null;
          ignoreLastRequest = null;
        }
      });
      return request;
    },
    setup: {
      async request(operation, payload) {
        if (!invoke) return unavailable('开始设置');
        if (operation === 'open') setupOpen = true;
        let value;
        try { value = await invoke('setup_request', { operation, payload: payload || {} }); }
        catch (error) { setupOpen = false; ignoreState = null; window.uiwin.setIgnoreMouse(false); throw error; }
        if (operation === 'close' || !value?.ok) {
          setupOpen = false;
          // 账本作废（外壳那边也刚走过 force_ignore），然后老实发一条 false。
          ignoreState = null;
          window.uiwin.setIgnoreMouse(false);
        }
        return value;
      },
      onAction(callback) { const pending = listen('setup:action', event => callback(event.payload)); return () => pending.then(fn => fn()); },
      onClosed(callback) {
        const pending = listen('setup:closed', event => {
          setupOpen = false;
          ignoreState = null;
          window.uiwin.setIgnoreMouse(false);
          callback(event.payload);
        });
        return () => pending.then(fn => fn());
      }
    },
    // L4 显示器级冻结窗口。数据是小 JSON，正常走命令即可。
    openBlocking(payload) {
      if (!invoke) return unavailable('L4 冻结窗口');
      const data = payload || {};
      const id = String(data.id || '');
      if (!id) return Promise.resolve({ ok: false, error: 'L4 缺少唯一编号' });
      if (data.backgroundOnly) {
        if (id === l4Current) {
          return queueL4Operation(function () {
            return invoke('l4_open', { payload: data });
          });
        }
        const waiting = l4Pending.find(entry => entry.id === id);
        // 只合并背景值，不能把 backgroundOnly 标记带进下一次正式打开。
        if (waiting && data.background) waiting.payload.background = data.background;
        // 迟到的背景图属于已关闭/尚未登记的错误，安全忽略。
        return Promise.resolve({ ok: true, ignored: !waiting });
      }
      if (id === l4Current) {
        return queueL4Operation(function () {
          return invoke('l4_open', { payload: data });
        });
      }
      const existing = l4Pending.find(entry => entry.id === id);
      if (existing) {
        existing.payload = data;
        return Promise.resolve({ ok: true, queued: true });
      }
      l4ClosedIds.delete(id);
      l4Pending.push({ id, payload: Object.assign({}, data) });
      return promoteNextL4();
    },
    closeBlocking(id) {
      return closeL4Blocking(id);
    },
    onBlockingClosed(callback) {
      if (typeof callback !== 'function') return () => {};
      l4ClosedListeners.add(callback);
      ensureL4ClosedSubscription();
      return () => l4ClosedListeners.delete(callback);
    },
    onBlockingAction(callback) {
      if (!listen) return;
      // 动作必须属于实际显示的那一条，不能把旧窗口的迟到/连点当成下一条确认。
      listen('l4:action', function (event) {
        const id = String(event && event.payload && event.payload.id || '');
        if (id && id === l4Current && id !== l4ActionId) { l4ActionId = id; callback(id); }
      });
    },
    // ⭐ 本机 CPU 校色（2026-10-20，Rust 写进软件本体：src-tauri/v7-color + src/color_native.rs）。
    //   两张同尺寸 RGBA 进、结果 RGBA（+ 底版）出，全程二进制，不经过 PNG 编解码。
    //   ⚠ Electron 测试壳没有这个（它跑不了 Rust）⇒ 那边 uiwin.match 不存在，match-engine.js 自动走老路。
    match: invoke ? {
      process(src, ref, opts) {
        const o = opts || {};
        const w = src.width, h = src.height, n = w * h * 4;
        if (!ref || ref.width !== w || ref.height !== h) return Promise.reject(new Error('两张图尺寸不一样'));
        const body = new Uint8Array(n * 2);
        body.set(src.data, 0);
        body.set(ref.data, n);
        const meta = {
          w: w, h: h, align: o.align !== false, alignMode: String(o.alignMode || 'mesh'), color: o.color !== false,
          method: String(o.method || 'hybrid'), aspectOff: Number(o.aspectOff) || 0, wantBase: o.wantBase !== false
        };
        return invoke('color_match', body, { headers: { meta: JSON.stringify(meta) } }).then(function (buf) {
          const ab = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer;
          const L = new DataView(ab).getUint32(0, true);
          const info = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, L)));
          const off = 4 + L;
          if (ab.byteLength < off + n) throw new Error('本机校色回来的数据不完整');
          const out = { img: { data: new Uint8ClampedArray(ab, off, n), width: w, height: h }, base: null, notes: info.notes || [], ms: info.ms };
          if (info.hasBase && ab.byteLength >= off + n * 2) out.base = { data: new Uint8ClampedArray(ab, off + n, n), width: w, height: h };
          return out;
        });
      }
    } : null,
    // 生成缓存：接口与 Electron 的 preload.js 逐项对齐。
    // ⚠ 写文件走两步：先 cache_begin_run 拿数字令牌，再用令牌 + ASCII 文件名写二进制。
    //   不能把项目名直接放 header —— header 必须是 ASCII，而 PS 项目名是中文。
    cache: {
      root() { return invoke ? invoke('cache_root_path') : Promise.resolve(''); },
      writeFile(project, runId, name, bytes) {
        if (!invoke) return unavailable('缓存写入');
        return invoke('cache_begin_run', { project: String(project), runId: String(runId) })
          .then(function (res) {
            if (!res || !res.ok) return { ok: false, error: (res && res.error) || '缓存目录创建失败' };
            const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
            const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
            return invoke('cache_write_file', buffer, {
              headers: { token: String(res.token), name: String(name) }
            });
          });
      },
      writeMeta(project, runId, meta) {
        if (!invoke) return unavailable('缓存写入');
        return invoke('cache_write_meta', { project: String(project), runId: String(runId), meta: meta || {} });
      },
      readFile(project, runId, name) {
        if (!invoke) return Promise.resolve(new Uint8Array(0));
        return invoke('cache_read_file', { project: String(project), runId: String(runId), name: String(name) })
          .then(function (buf) { return buf ? new Uint8Array(buf) : new Uint8Array(0); })
          .catch(function () { return new Uint8Array(0); });
      },
      list() {
        if (!invoke) return Promise.resolve({ ok: false, runs: [] });
        return invoke('cache_list');
      },
      openFolder(project, runId) {
        if (!invoke) return unavailable('打开缓存文件夹');
        return invoke('cache_open_folder', { project: String(project || ''), runId: String(runId || '') });
      },
      deleteRun(request) {
        if (!invoke) return unavailable('删除缓存任务');
        return invoke('cache_delete_run', { request: request || {} });
      },
      deleteOutput(request) {
        if (!invoke) return unavailable('删除缓存图片');
        return invoke('cache_delete_output', { request: request || {} });
      },
      // ⭐⭐⭐ 2026-10-08（docs/170 §十四）：清掉历史遗留的插帧文件。
      //   ⚠⚠ 加这个是因为 check-shell-parity.js 抓到了缺口 ——
      //     铁律 14：Tauri 壳和 Electron 壳必须给同一套接口。
      //     只在 preload.js 里加、忘了这边，Tauri 用户那边这个功能就是【静默不存在】。
      purgeTweenFiles(request) {
        if (!invoke) return unavailable('清理插帧缓存');
        return invoke('cache_purge_tween_files', { request: request || {} });
      },
      listDeleted(namespaceId) {
        if (!invoke) return Promise.resolve({ ok: false, items: [] });
        return invoke('cache_list_deleted', { namespaceId: String(namespaceId || '') });
      },
      restoreDeleted(request) {
        if (!invoke) return unavailable('恢复缓存');
        return invoke('cache_restore_deleted', { request: request || {} });
      },
      checkpointInventory(request) {
        return invoke ? invoke('cache_checkpoint_inventory', { request: request || {} }) : unavailable('检查点缓存');
      },
      purgeCheckpoint(request) {
        return invoke ? invoke('cache_purge_checkpoint', { request: request || {} }) : unavailable('检查点缓存');
      },
      purgeDeleted(request) {
        if (!invoke) return unavailable('彻底清理缓存');
        return invoke('cache_purge_deleted', { request: request || {} });
      },
      chooseRoot() {
        if (!invoke) return unavailable('选择缓存目录');
        return invoke('cache_choose_root');
      },
      // 缓存用量报告（docs/128 §三-4）：按项目 / 按日期分别占多少。
      // ⚠ 必须和 preload.js 的那份同名同形（铁律 14）——
      //   只改一边不会报错，只会安静地少一个功能。
      usageReport(request) {
        if (!invoke) return unavailable('缓存用量');
        return invoke('cache_usage_report', { request: request || {} });
      }
    },
    // 大图查看：显示器级独立冻结窗口。
    // ⚠ 图片走二进制，不走 JSON —— Tauri 的 invoke 参数默认 JSON 序列化，
    //   8MB 图会被转成几千万元素的数组。这里用 raw invoke body 直传字节。
    viewer: {
      open(payload) { return viewerSend('viewer_open', payload); },
      update(payload) { return viewerSend('viewer_update', payload); },
      close() { if (invoke) invoke('viewer_close').catch(function () {}); },
      onNav(callback) {
        if (listen) listen('viewer:nav', function (event) {
          callback(event && event.payload !== undefined ? event.payload : event);
        });
      },
      onClosed(callback) {
        if (listen) listen('viewer:closed', function () { callback(); });
      }
    },
    browser: {
      async workspace(input) { const value = await invoke('browser_request', { action: 'workspace', input: input || {} }); browserOpen = !!(value.workspace || value.open); ignoreState = null; if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; } if (browserOpen) window.uiwin.setIgnoreMouse(false); return value; },
      async open(input) { const value = await invoke('browser_request', { action: 'open', input: input || {} }); browserOpen = !!(value.workspace || value.open); ignoreState = null; if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; } if (browserOpen) window.uiwin.setIgnoreMouse(false); return value; },
      navigate(url) { return invoke('browser_request', { action: 'navigate', input: { url } }); },
      back() { return invoke('browser_request', { action: 'back' }); },
      forward() { return invoke('browser_request', { action: 'forward' }); },
      reload() { return invoke('browser_request', { action: 'reload' }); },
      async close() { const value = await invoke('browser_request', { action: 'close' }); browserOpen = false; ignoreState = null; window.uiwin.setIgnoreMouse(false); return value; },
      setBounds(input) { return invoke('browser_request', { action: 'setBounds', input: input || {} }); },
      state() { return invoke('browser_request', { action: 'state' }); },
      taskLock(locked) { return invoke('browser_request', { action: 'taskLock', input: { locked } }); },
      importImage(url) { return invoke('browser_request', { action: 'importImage', input: { url } }); },
      onState(callback) { let dispose = null, ended = false; listen('browser:state', event => callback(event.payload)).then(fn => { if (ended) fn(); else dispose = fn; }); return () => { ended = true; if (dispose) dispose(); }; },
      onImage(callback) { let dispose = null, ended = false; listen('browser:image', event => callback(event.payload)).then(fn => { if (ended) fn(); else dispose = fn; }); return () => { ended = true; if (dispose) dispose(); }; }
    },
    // 全局快捷键：UI 窗口失焦(人在 Photoshop 里)也要能触发。
    freeMode: {
      pulse() { return invoke('free_mode_pulse').then(zoomWorkArea); },
      onMouseReset(callback) {
        let dispose = null, ended = false;
        // ⚠ 不要写死 ignoreState=true。
        //   Rust 看门狗【两个相反的分支】都会发这个事件：一个是"界面卡死了、
        //   我替你开穿透"(native true)，另一个是"界面活过来了、我把输入还回去"
        //   (native false)。无条件记成 true，就会在第二个分支上和原生对不上：
        //   JS 以为穿着、原生其实没穿 → 之后 mousemove 算出"该穿"时被
        //   `ignoreState === next` 提前 return 吞掉，面板就一直吃鼠标，
        //   桌面和别的软件全点不到；用户必须先把鼠标移到卡片上、再移走，
        //   逼出一条真实指令才能把两边对齐（2026-09-28 用户实测）。
        //   清成 null = "我不知道对方改成什么了"，下一次 mousemove 会重新发
        //   一条真实指令，两边立刻同步。null 是本文件既有的"账本作废"写法。
        listen('free-mode:mouse-reset', () => { ignoreTrace('RESET', 'old state=' + ignoreState + ' -> null'); ignoreState=null; startRecovery(); callback(); }).then(fn => { if(ended)fn();else dispose=fn; });
        return () => { ended=true;dispose?.(); };
      },
      set(enabled) {
        if (!invoke) return unavailable('自由模式');
        return invoke('free_mode_set', { enabled: !!enabled }).then(zoomWorkArea);
      },
      onExitRequest(callback) {
        if (!listen) return function () {};
        let dispose = null, ended = false;
        listen('free-mode:exit', function () {
          ignoreState = null;
          window.uiwin.setIgnoreMouse(false);
          callback();
        }).then(fn => { if (ended) fn(); else dispose = fn; });
        return function () { ended = true; if (dispose) dispose(); };
      }
    },
    // ⭐ 2026-10-21：窗口跟随 Photoshop 置顶（外壳 topmost.rs）。follow=false = 原来的「始终置顶」。
    topmost: {
      setFollowPs(follow) {
        if (!invoke) return unavailable('窗口置顶');
        return invoke('set_topmost_follow_ps', { follow: !!follow });
      }
    },
    shortcuts: {
      setGeneration(value) {
        if (!invoke) return unavailable('全局快捷键');
        // 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 让外壳取消原来那个（外壳收到空串只取消、回成功）
        if (!String(value || '').trim()) return invoke('set_generation_shortcut', { accelerator: '' });
        const accelerator = tauriAccelerator(value);
        if (!accelerator) return Promise.resolve({ ok: false, error: '快捷键格式无效' });
        return invoke('set_generation_shortcut', { accelerator: accelerator });
      },
      onGeneration(callback) {
        if (listen) listen('shortcut:generation', function () { callback(); });
      },
      // ⭐ 2026-10-14：加参考图快捷键。跟上面两项逐行对称（双壳同步，铁律 14：
      //   只改一边【不报错】，只是按了没反应）。
      setReference(value) {
        if (!invoke) return unavailable('全局快捷键');
        // 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 让外壳取消原来那个（外壳收到空串只取消、回成功）
        if (!String(value || '').trim()) return invoke('set_reference_shortcut', { accelerator: '' });
        const accelerator = tauriAccelerator(value);
        if (!accelerator) return Promise.resolve({ ok: false, error: '快捷键格式无效' });
        return invoke('set_reference_shortcut', { accelerator: accelerator });
      },
      onReference(callback) {
        if (listen) listen('shortcut:reference', function () { callback(); });
      },
      // ⭐ 2026-10-17 夜：一键收起 / 展开快捷键。跟上面逐行对称（双壳同步，铁律 14）。
      setCollapse(value) {
        if (!invoke) return unavailable('全局快捷键');
        // 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 让外壳取消原来那个（外壳收到空串只取消、回成功）
        if (!String(value || '').trim()) return invoke('set_collapse_shortcut', { accelerator: '' });
        const accelerator = tauriAccelerator(value);
        if (!accelerator) return Promise.resolve({ ok: false, error: '快捷键格式无效' });
        return invoke('set_collapse_shortcut', { accelerator: accelerator });
      },
      onCollapse(callback) {
        if (listen) listen('shortcut:collapse', function () { callback(); });
      },
      // ⭐ 2026-10-21：换下一家渠道快捷键。跟 setCollapse 逐行对称（双壳同步，铁律 14）。
      setProvider(value) {
        if (!invoke) return unavailable('全局快捷键');
        if (!String(value || '').trim()) return invoke('set_provider_shortcut', { accelerator: '' });
        const accelerator = tauriAccelerator(value);
        if (!accelerator) return Promise.resolve({ ok: false, error: '快捷键格式无效' });
        return invoke('set_provider_shortcut', { accelerator: accelerator });
      },
      onProvider(callback) {
        if (listen) listen('shortcut:provider', function () { callback(); });
      }
    },
    // 预设系统的文件活儿。跟 Electron 的 preload.js 逐项对齐。
    // ⚠ 导入不在这里 —— 界面用 <input type="file">，两个壳都原生支持，不需要接口。
    presetfs: {
      findV6() {
        if (!invoke) return Promise.resolve([]);
        return invoke('preset_find_v6').catch(function () { return []; });
      },
      scanDir(dir) {
        if (!invoke) return unavailable('读取文件夹');
        return invoke('preset_scan_dir', { dir: String(dir || '') });
      },
      saveText(name, text) {
        if (!invoke) return unavailable('保存文件');
        return invoke('preset_save_text', { name: String(name || 'export.json'), text: String(text || '') });
      }
    },
    // 剪影素材编辑器：第三个显示器级独立窗口。
    // ⚠ 数据是 dataURL 字符串(blob 地址跨窗口无效)，正常走 JSON 命令即可。
    editor: {
      open(payload) {
        if (!invoke) return unavailable('素材编辑器');
        return invoke('editor_open', { payload: payload || {} });
      },
      close(editorSession) { if (invoke) return invoke('editor_close', { editorSession: editorSession || null }).catch(function () {}); },
      onSave(callback) {
        if (listen) listen('editor:saved', async function (event) {
          const data = event && event.payload !== undefined ? event.payload : event;
          let result;
          try { result = await callback(data); }
          catch (error) { result = { ok: false, error: String(error?.message || error), code: error?.code }; }
          if (data?._editorRequestId && invoke) await invoke('editor_saved', {
            requestId: data._editorRequestId, editorSession: data.editorSession, result: result || { ok: false }
          });
        });
      }
    },
    close() {
      return typeof current.close === 'function' ? current.close() : unavailable('关闭窗口');
    },
    // 调试用: 重启整个程序，验"重启后任务还在不在"
    restart() {
      if (invoke) invoke('restart_app').catch(function () {});
    },
    // 性能采样。⚠ 数据源与显示位置解耦，现在显示在 L3 卡，以后可能挪走
    perf: {
      sample() {
        if (!invoke) return Promise.resolve({ ok: false, error: 'Tauri invoke 不可用' });
        return invoke('perf_sample');
      }
    },
    getPos() {
      if (typeof current.outerPosition !== 'function') return Promise.resolve([0, 0]);
      return current.outerPosition().then(function (position) {
        return [Number(position && position.x) || 0, Number(position && position.y) || 0];
      });
    },
    // ⭐ 2026-10-18 新手教程：外壳开一个全屏置顶窗口（tutorial.html）。chapter = 从哪一章开始（空 = 封面挑章节）
    // ⭐ 2026-10-18 深夜：界面缩放（src-tauri/src/ui_scale.rs；设置界面在 ui-scale.js）
    uiScale: {
      get() { return invoke ? invoke('ui_scale_get') : unavailable('界面缩放'); },
      set(scale) { return invoke ? invoke('ui_scale_set', { scale: Number(scale) || 1 }) : unavailable('界面缩放'); }
    },
    tutorial: {
      open(chapter) {
        if (!invoke) return unavailable('新手教程');
        return invoke('tutorial_open', { chapter: chapter ? String(chapter) : null });
      },
      onClosed(callback) {
        if (!listen || typeof callback !== 'function') return Promise.resolve(() => {});
        return listen('tutorial:closed', event => callback(event && event.payload !== undefined ? event.payload : event));
      }
    },
    link: {
      enqueue(action, params) {
        if (!invoke) return unavailable('UXP 链路');
        return invoke('link_enqueue', { payload: { action: String(action || ''), params: params || {} } });
      },
      status() {
        if (!invoke) return Promise.resolve({ ok: false, connected: false, bridge: null, error: 'Tauri invoke 不可用' });
        return invoke('link_status');
      },
      // 调 UXP 轮询间隔(开发期试 hover 联动手感用)
      setPollMs(value) {
        if (!invoke) return unavailable('轮询间隔');
        return invoke('link_set_poll_ms', { value: Math.max(20, Math.min(2000, Number(value) || 180)) });
      },
      onQueued(callback) {
        if (!listen || typeof callback !== 'function') return Promise.resolve(() => {});
        return listen('link:queued', event => callback(event && event.payload !== undefined ? event.payload : event));
      },
      onResult(callback) {
        if (!listen || typeof callback !== 'function') return Promise.resolve(() => {});
        return listen('link:result', event => callback(event && event.payload !== undefined ? event.payload : event));
      },
      onEvent(callback) {
        if (!listen || typeof callback !== 'function') return Promise.resolve(() => {});
        return listen('link:event', event => callback(event && event.payload !== undefined ? event.payload : event));
      }
    },
    // 校色加速引擎：拉起本地 Python 服务。
    // ⚠ 必须和 preload.js 的 engine 接口同名同形(铁律 14)。
    engine: {
      // action: status | prepare | remove | cancel | removeaccel
      // ⚠ 第二个参数 accel：'cuda' | 'off'，只管 prepare（装 CUDA 版 PyTorch）。
      //   和 preload.js 的 engine.environment 同名同形 —— 铁律 14，不许只改一边。
      environment(action, accel) { return invoke ? invoke('engine_environment', { action, accel: accel === 'cuda' ? 'cuda' : 'off' }) : unavailable('独立图像环境'); },
      models(action, model) { return invoke ? invoke('engine_models', { action, model: model || null }) : unavailable('模型管理'); },
      // which: 'match' | 'matting'。⚠ Rust 侧按白名单映射到脚本名，界面传标识不传路径。
      start(which) { return invoke ? invoke('engine_start', { which: which || 'match' }) : unavailable('引擎'); },
      stop(which) { return invoke ? invoke('engine_stop', { which: which || 'match' }) : unavailable('停止引擎'); },
      openModelsDir() { return invoke ? invoke('open_models_dir') : unavailable('打开模型文件夹'); }
    },
    photoshop: {
      discover(explicitPath) { return invoke ? invoke('photoshop_discover', { explicitPath: String(explicitPath || '') }) : unavailable('Photoshop 检测'); },
      launch(candidate) { return invoke ? invoke('photoshop_launch', { candidate: candidate || {} }) : unavailable('Photoshop 启动'); },
      choose() { return invoke('photoshop_choose'); },
      inspect(candidate) { return invoke('photoshop_inspect', { candidate: candidate || {} }); },
      // ⭐ 2026-10-24（docs/273 #10）：插件重复检测，只读。Electron 开发壳没有 ⇒ 界面见不到就跳过。
      bridgeCopies() { return invoke('photoshop_bridge_copies'); },
      install(candidate) { return invoke('photoshop_install', { candidate: candidate || {} }); },
      rollback(candidate, backupId) { return invoke('photoshop_rollback', { candidate: candidate || {}, backupId: String(backupId || '') }); }
    },
    // ⭐ 2026-10-24（用户定）：PS 不在前台时参考图快捷键 = 全屏截图框选（src-tauri/src/snip.rs）。
    //   foreground() → {kind:'photoshop'|'ours'|'other'|'unknown'}；start() 开截图窗口；onDone(cb) 收结果 {ok,imageBase64,mime,width,height} / {cancelled}
    //   ⚠ 跟 preload.js 的 snip 同名同形（铁律 14）
    snip: {
      foreground() { return invoke ? invoke('snip_foreground') : Promise.resolve({ ok: false, kind: 'unknown', supported: false }); },
      start() { return invoke ? invoke('snip_start') : Promise.resolve({ ok: false, error: 'UNSUPPORTED' }); },
      onDone(callback) {
        if (!listen || typeof callback !== 'function') return Promise.resolve(() => {});
        return listen('snip:done', event => callback(event && event.payload !== undefined ? event.payload : event));
      }
    },
    // ⭐ 2026-10-18 在线更新（src-tauri/src/app_update.rs，docs/244）。只有 Tauri 正式壳有；Electron 开发壳没有这一项，
    //   界面那边（ui-pure/app-update.js）见不到 uiwin.update 就整块不启用。
    update: {
      check() { return invoke('app_update_check'); },
      status() { return invoke('app_update_status'); },
      install() { return invoke('app_update_install'); }
    },
    // 对外 HTTP：交给 Rust 发。
    // ⚠ 这不是"为了统一"才搬的，是【非做不可】：界面里 fetch 外部接口会被跨域规则
    //   把响应整个吞掉，连服务器明确回的「图片太大」都看不见(2026-09-11 实测)。
    //   必须和 preload.js 的 http 接口同名同形(铁律 14)。
    http: {
      fetch(options) {
        if (!invoke) return unavailable('对外 HTTP');
        const o = options || {};
        return invoke('http_fetch', { args: {
          url: String(o.url || ''),
          method: String(o.method || 'GET'),
          headers: o.headers || {},
          body: o.body === undefined || o.body === null ? null : String(o.body),
          bodyEncoding: o.bodyEncoding === 'base64' ? 'base64' : null,
          // ⭐⭐ 2026-10-09（用户要求）：出图这类请求要能【慢慢等】，别 3 分钟就放弃。
          //   用户原话：「不要超时时间，就是我们可以慢慢等，反正在后台可以慢慢算」，
          //   并让我参考 V6 —— V6 那边等出图是 1 小时量级
          //   （host/ai-api.js：maxPollSeconds 默认 3600 秒）。
          //
          //   ⚠ 改之前是 `|| 180000`（3 分钟），而 Rust 侧上限是 600_000（10 分钟）。
          //     出一张大图、或者服务商排队，超过 3 分钟很正常 ⇒
          //     客户端先放弃、服务端还在算 ⇒ 用户白等。
          //
          //   ⚠⚠ 这一处【必须和 Rust 那个默认值一起改】：aiGenerate 调 http.fetch 时
          //     没有显式传 timeoutMs ⇒ 这里给的 180000 会被一路带到 Rust，
          //     把 Rust 的默认值覆盖掉。只改 Rust = 白改。
          //     （2026-10-09 实测：只改了 main.rs，实际仍按 3 分钟超时。）
          //
          //   ⚠ 不设"永不超时"：连接真挂死时没有任何东西会结束它，失败要等很久才报。
          //     1 小时够"慢慢算"了，而且用户随时能点取消（cancel 走 watch 通道，不受影响）。
          //   ⚠ 两壳必须一致（铁律 14）：Electron 侧对应 main.js 的 http:fetch。
          timeoutMs: Number(o.timeoutMs) || 3600000,
          // ⚠⚠ 2026-10-16 修（完整包冒烟测试抓到「连不上 V7 服务器（已取消）」）：原来没给编号就填空字符串 ''
          //   ⇒ 所有不带编号的请求共用同一个编号 ⇒ Rust 那边登记「进行中」时后一个把前一个的取消开关顶掉、
          //   被顶掉的那个立刻当成「已取消」。启动时公告 / 阿吉价目表 / 云端预设一起发，随机有一个被"取消"。
          //   ⇒ 没给编号就现编一个不重样的（调用方本来就不拿它取消，换成唯一的不影响任何人）。
          requestId: String(o.requestId || ('auto-' + Date.now().toString(36) + '-' + (++httpAutoSeq) + '-' + Math.random().toString(36).slice(2, 8))),
          responseType: o.responseType === 'base64' ? 'base64' : 'text',
          // ⭐ 2026-10-17 夜（用户：「生图就直连就好了」）：true = 不走系统代理（Clash），直接连服务商。
          //   ⚠ 这里是手写的参数对象 —— 不在这写一行，调用方传了也会被吃掉（Rust 那边收不到 = 静默失效）。
          direct: o.direct === true
        } });
      },
      cancel(requestId) {
        if (!invoke) return unavailable('对外 HTTP');
        return invoke('http_cancel', { requestId: String(requestId || '') });
      }
    },
    ai: {
      generate(payload) { return aiGenerate(payload, data => { try { window.dispatchEvent(new CustomEvent('v7-ai-progress', { detail:data })); } catch (_) {} }); },
      cancel(taskId) { const list=aiControllers.get(String(taskId||''))||[];list.forEach(c=>{try{c.abort();}catch(_){}});return Promise.resolve({ok:true,cancelled:list.length>0}); },
      onProgress(callback) { if(typeof callback!=='function') return ()=>{}; const fn=e=>callback(e.detail||e);window.addEventListener('v7-ai-progress',fn);return ()=>window.removeEventListener('v7-ai-progress',fn); }
    },
    // 与 Electron 同名同形。权限和路径仍由 Tauri 主进程复核，不接受页面自行提升档位。
    planner: {
      request(input) { return invoke ? invoke('planner_request', { input: input || {} }) : unavailable('日程'); },
      onReminder(callback) { let disposed = false, off = null; if (listen) listen('planner:reminder', event => callback(event.payload)).then(fn => { if (disposed) fn(); else off = fn; }); return () => { disposed = true; if (off) off(); }; }
    },
    secrets: {
      get(name, scope) { return invoke ? invoke('secret_get', { name, scope: scope || null }) : unavailable('安全存储'); },
      set(request) { return invoke ? invoke('secret_set', { request: request || {} }) : unavailable('安全存储'); },
      remove(name, scope) { return invoke ? invoke('secret_remove', { name, scope: scope || null }) : unavailable('安全存储'); },
      list(scope) { return invoke ? invoke('secret_list', { scope: scope || null }) : unavailable('安全存储'); }
    },
    // ⭐ 2026-10-17 夜：夏三六黑匣子（ui-pure/agent-trace.js）。两壳一致：Electron 侧 preload agentTrace / main.js agentTrace:*
    agentTrace: {
      append(day, line) { return invoke ? invoke('agent_trace_append', { day: String(day || ''), line: String(line || '') }) : unavailable('黑匣子'); },
      path() { return invoke ? invoke('agent_trace_path') : unavailable('黑匣子'); }
    },
    agentPresets: {
      enable(request) { return invoke ? invoke('agent_presets_enable', { request: request || {} }) : unavailable('Agent'); },
      disable() { return invoke ? invoke('agent_presets_disable') : unavailable('Agent'); },
      info() { return invoke ? invoke('agent_presets_info') : unavailable('Agent'); },
      scan() { return invoke ? invoke('agent_presets_scan') : unavailable('Agent'); },
      ack(request) { return invoke ? invoke('agent_presets_ack', { request: request || {} }) : unavailable('Agent'); },
      openFolder() { return invoke ? invoke('agent_presets_open_folder') : unavailable('Agent'); }
    },
    agent: {
      readFile(request) { return invoke ? invoke('agent_read_file', { request: request || {} }) : unavailable('Agent'); },
      listFiles(request) { return invoke ? invoke('agent_list_files', { request: request || {} }) : unavailable('Agent'); },
      tierInfo() { return invoke ? invoke('agent_tier_info') : unavailable('Agent'); },
      requestAccess(tier) { return invoke ? invoke('agent_request_access', { tier: String(tier || '') }) : unavailable('Agent'); },
      authorize(request) { return invoke ? invoke('agent_authorize', { request: request || {} }) : unavailable('Agent'); },
      applyChanges(request) { return invoke ? invoke('agent_apply_changes', { request: request || {} }) : unavailable('Agent'); },
      diff(backupId) { return invoke ? invoke('agent_diff', { backupId: String(backupId || '') }) : unavailable('Agent'); },
      rollback(request) { return invoke ? invoke('agent_rollback', { request: request || {} }) : unavailable('Agent'); },
      listBackups() { return invoke ? invoke('agent_list_backups') : unavailable('Agent'); },
      upgradeStatus() { return invoke ? invoke('agent_upgrade_status') : unavailable('Agent'); }
    }
  };

  // ⭐ 2026-10-18 深夜：自由模式回的工作区是【逻辑像素】；界面缩放开着时页面里的尺寸 = 逻辑像素 ÷ 缩放比例。
  //   不换算的话：缩到 80% 时自由模式以为屏幕只有实际的 80% 大，卡片拖不到右下角那一块。
  function zoomWorkArea(result) {
    const zoom = Number(window.__v7Zoom) > 0 ? Number(window.__v7Zoom) : 1;
    if (zoom === 1 || !result || !result.workArea) return result;
    const area = result.workArea;
    // ⭐ 2026-10-20 多屏：每块屏的位置（monitors）、切换前后的屏幕原点（fromOrigin / toOrigin）也是壳的逻辑像素，同样除以界面大小
    const div = v => Math.round(Number(v) / zoom);
    const rect = r => r && Object.assign({}, r, { x: div(r.x), y: div(r.y), width: div(r.width), height: div(r.height) });
    const point = p => p && Object.assign({}, p, { x: Number(p.x) / zoom, y: Number(p.y) / zoom });
    return Object.assign({}, result, { workArea: Object.assign({}, area, {
      width: Math.round(Number(area.width) / zoom), height: Math.round(Number(area.height) / zoom)
    }) }, Array.isArray(result.monitors) ? { monitors: result.monitors.map(rect) } : {},
    result.fromOrigin ? { fromOrigin: point(result.fromOrigin) } : {}, result.toOrigin ? { toOrigin: point(result.toOrigin) } : {});
  }

  async function recoverIfCursorReenters() {
    if (!ignoreState || recoveryBusy || !cursorPosition || !current || typeof current.outerPosition !== 'function') return;
    recoveryBusy = true;
    try {
      const [cursor, origin, scale] = await Promise.all([
        cursorPosition(),
        current.outerPosition(),
        typeof current.scaleFactor === 'function' ? current.scaleFactor() : Promise.resolve(1)
      ]);
      const factor = Number(scale) > 0 ? Number(scale) : 1;
      // ⚠ 2026-10-18 深夜：界面缩放（ui_scale.rs 的 set_zoom）开着时，页面坐标 = 逻辑像素 ÷ 缩放比例 —— 不除就命中到别的地方
      const zoom = Number(window.__v7Zoom) > 0 ? Number(window.__v7Zoom) : 1;
      // ⚠⚠ 2026-10-20：直接除以 devicePixelRatio（= 窗口缩放 × 网页实际缩放）。原来是「÷ 窗口缩放 ÷ 界面大小」——
      //   多屏自由摆放时窗口跨屏，网页缩放额外乘了补偿（free_mode.rs 的 zoom_comp），那样算出来的点整个偏掉，
      //   永远判成「不在卡上」、一直穿透 ⇒ 界面怎么点都点不动（用户 10-20 实测）。devicePixelRatio 本身就含了两样，不会再漏。
      const ratio = Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : factor * zoom;
      const x = (Number(cursor && cursor.x) - Number(origin && origin.x)) / ratio;
      const y = (Number(cursor && cursor.y) - Number(origin && origin.y)) / ratio;
      // The UI script exposes its existing geometry hit test after startup.
      // This keeps the exact same card/overlay rules while the window is ignored.
      const hit = typeof window.__uiHitTest === 'function' && window.__uiHitTest(x, y);
      if (hit) {
        // 先让原生窗口恢复接收输入，成功后再更新状态并停止轮询。
        // 如果 Windows/Tauri 短暂拒绝这次 IPC，必须保留穿透状态继续重试；
        // 不能提前把 ignoreState 改成 false，否则后续恢复轮询会永久停掉。
        const result = await window.uiwin.setIgnoreMouse(false);
        if (!result || result.ok === false || ignoreState !== false) return;
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      }
    } catch (_) {
      // Cursor polling is a recovery aid; transient native failures should not
      // make the UI throw or stop receiving normal events.
    } finally {
      recoveryBusy = false;
    }
  }

  function startRecovery() {
    if (recoveryTimer || !cursorPosition) return;
    // 30ms（原 60ms）。自由模式按"必须真的进到卡片里"的严格判定，
    // 鼠标移回界面上以后要尽快把输入收回来；60ms 在快速移动时会明显滞后。
    // ⚠ 这只是经验值：若实测鼠标划过时面板边缘出现闪烁，说明轮询太勤，调回 45~60。
    recoveryTimer = setInterval(recoverIfCursorReenters, 30);
  }
})();
