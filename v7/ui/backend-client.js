/*
 * V7 backend control-plane client.
 *
 * This module deliberately keeps account credentials and access tokens out of
 * localStorage. The token lives in memory for the current app session only;
 * the server remains the source of truth for account, points, task ownership
 * and billing. It is usable in Electron and Tauri because both expose the
 * same uiwin.http.fetch contract.
 */
(function (root) {
  'use strict';

  var state = {
    // ⭐⭐⭐ 2026-10-09（docs/195 §1，用户定案）：「后端地址默认值永远写死 www.xiasanqi.com」
    //   ⇒ 从本机开发地址改成正式线上地址。
    //   ⚠ 这个默认值是【兜底】：正常情况下 ui.html 的 settingsRuntime.backendUrl
    //     会通过 setBaseUrl() 覆盖它（见 ui.html 的 settingsSyncAiRuntime）。
    //     两处必须一致 —— 只改一处的话，设置还没加载完的那一小段会连错地址。
    //   ⚠ 换这个值 = setBaseUrl() 会强制登出一次（见下面那句 sessionEnding）。
    //     用户已确认接受（老用户重登一次）。
    baseUrl: 'https://www.xiasanqi.com',
    accessToken: '',
    account: null,
    deviceId: '',
    sessionEnded: false
  };
  var listeners = [];
  var sessionEndingListeners = [];
  var sessionVersion = 0;
  // Auth-changing operations share one monotonic epoch.  A response from an
  // older login/me/logout must never commit into the newer account namespace.
  var authEpoch = 0;
  var presenceQueue = Promise.resolve();
  var dlssWorker = null;

  function sessionEnding() {
    return Promise.allSettled(sessionEndingListeners.slice().map(function (listener) {
      try { return listener(snapshot()); } catch (_) { return null; }
    }));
  }

  function syncStorageContext() {
    if (!root.WHEELCHAIR_STORAGE || !root.WHEELCHAIR_STORAGE.setContext) return;
    var accountId = state.account && (state.account.id || state.account.accountId);
    if (!accountId && !state.sessionEnded && root.WHEELCHAIR_STORAGE.getContext) {
      // Preserve a host-injected account namespace until the first login/me
      // response arrives; configuring the backend URL must not reset it.
      accountId = root.WHEELCHAIR_STORAGE.getContext().accountId;
    }
    root.WHEELCHAIR_STORAGE.setContext({
      accountId: accountId || 'anonymous',
      deviceId: state.deviceId || 'local-device',
      // 2026-10-18 教程（ui-pure/tutorial-host.js）把整个界面放在 profile=tutorial 的单独一格里，保证教程里的设置、预设、记录不碰用户真数据
      profileId: root.__V7_TUTORIAL__ ? 'tutorial' : 'default'
    });
  }

  function notify() {
    syncStorageContext();
    listeners.slice().forEach(function (listener) {
      try { listener(snapshot()); } catch (_) {}
    });
  }

  function snapshot() {
    return {
      baseUrl: state.baseUrl,
      signedIn: !!state.accessToken && !!state.account,
      account: state.account ? Object.assign({}, state.account) : null,
      deviceId: state.deviceId,
      sessionVersion: sessionVersion
    };
  }

  function staleAuthError() {
    return Object.assign(new Error('账号会话已变化，已忽略旧请求结果'), { code: 'AUTH_OPERATION_STALE' });
  }

  function authSnapshot() {
    return {
      epoch: authEpoch,
      sessionVersion: sessionVersion,
      baseUrl: state.baseUrl,
      accessToken: state.accessToken
    };
  }

  function assertAuthSnapshot(captured) {
    if (!captured || captured.epoch !== authEpoch || captured.sessionVersion !== sessionVersion ||
        captured.baseUrl !== state.baseUrl || captured.accessToken !== state.accessToken) {
      throw staleAuthError();
    }
  }

  function randomId() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'device-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // ══════════════════════════════════════════════════════════════════
  // 「记住我」—— 存【登录凭证】，绝不存密码（2026-10-14，用户定）
  // ══════════════════════════════════════════════════════════════════
  // 用户要求：「登录账号的地方要加一个保存账号和密码以及自动登录」
  //   ⇒ 我把"保存密码"改成了"保存登录凭证"，并且在界面上明说这件事。
  //     理由（也写在设置卡那一栏的说明里，用户能看到）：
  //       · 存密码 = 你的密码能被人解出来。而人往往多平台复用同一个密码，
  //         泄漏一个等于泄漏一片。
  //       · 存凭证 = 只泄漏这一个软件的这张票据；而且改密码就能立刻作废它。
  //     功能上用户要的"下次打开自动登录"一样拿到（凭证有效期 30 天）。
  //     ⚠ 用户明确选了这个方案（我问过，选项 A）。
  //
  // ⚠ 本文件开头那句"deliberately keeps ... access tokens out of localStorage"
  //   现在【只在"没勾记住我"时成立】—— 不勾就是不写，跟以前一样。
  //   ⇒ 那句话我没删，但在下面 STORE_KEY 这里写明了新的例外，别让后人以为矛盾。
  //
  // ⚠ 存的是什么：{ email, token, savedAt }。**没有密码字段**。
  //   设备标识（deviceId）本来就存在本地（DEVICE_KEY），不涉及隐私。
  // 2026-10-18 教程（tutorial-host.js）里用单独一把：教程是假后台，不能读走、也不能覆盖用户真的登录凭证
  var STORE_KEY = root.__V7_TUTORIAL__ ? 'wheelchair.v7.tutorial.remembered-login.v1' : 'wheelchair.v7.remembered-login.v1';

  function readRemembered() {
    try {
      var raw = root.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.token || !d.email) return null;
      return d;
    } catch (_) { return null; }
  }

  function saveRemembered() {
    try {
      root.localStorage.setItem(STORE_KEY, JSON.stringify({
        email: String((state.account && state.account.email) || ''),
        token: String(state.accessToken || ''),
        savedAt: new Date().toISOString()
      }));
      return true;
    } catch (_) { return false; }
  }

  function clearRemembered() {
    try { root.localStorage.removeItem(STORE_KEY); return true; } catch (_) { return false; }
  }

  function remembered() {
    var d = readRemembered();
    return d ? { email: d.email, savedAt: d.savedAt } : null;
  }

  /* 自动登录：用存下来的凭证恢复会话。
   *
   * ⚠ 必须【真的问一次后端】才知道凭证还有效没有：
   *   后端凭证 30 天过期，也可能被"改密码/别处退出"作废。
   *   不验就宣布"已登录"的话，界面会显示已登录、但每个请求都 401 ——
   *   那种"看着登录了其实没有"是最难查的一类故障。
   *   ⇒ 调 /v1/auth/me 验一次（顺带把 account 拉回来，不用再多一次请求）。
   * ⚠ 凭证失效时【静默清掉本地那份】并返回 false：
   *   不弹错误。用户开软件时看到一个"你的登录过期了"的红卡，没有意义也没法处理。
   */
  async function restoreSession() {
    if (state.accessToken && state.account) return snapshot();   // 内存里已经有会话
    var saved = readRemembered();
    if (!saved) return null;
    var operation = ++authEpoch;
    var endpoint = state.baseUrl;
    // ⚠⚠ 2026-10-14 修（我第一版就是这么错的，而且【不报错、只是不生效】）：
    //   第一版我发的是"临时 session"（request(..., {baseUrl, accessToken: saved.token})），
    //   而没收下回的 assertAuthSnapshot 比的是【state.accessToken】——
    //   它跟前一个（空）不一样 ⇒ 抛 AUTH_OPERATION_STALE ⇒ 被 catch 吞掉 ⇒ 自动登录永远不生效。
    //   ⇒ 正确做法：先把凭证放进 state，再发请求，这样快照前后一致；
    //     失败时（在 catch 里）把它还原回去。
    var previous = { token: state.accessToken, account: state.account };
    state.accessToken = String(saved.token);
    try {
      var result = await request('/v1/auth/me');
      if (operation !== authEpoch || state.baseUrl !== endpoint) throw staleAuthError();
      await sessionEnding();
      if (operation !== authEpoch) throw staleAuthError();
      state.account = result.account || null;
      state.deviceId = result.deviceId || state.deviceId;
      state.sessionEnded = false;
      sessionVersion++;
      notify();
      return snapshot();
    } catch (e) {
      // 凭证过期/被作废/连不上后端 —— 都按"自动登录没成功"处理，并把 state 还原
      state.accessToken = previous.token;
      state.account = previous.account;
      var code = '';
      try { code = String((e && e.code) || ''); } catch (e2) { }
      // ⚠ 留个诊断痕迹。自动登录失败时界面表现是"没登录"，
      //   跟"没记住过"完全一样 —— 不记原因的话根本分不出是哪一种。
      try {
        if (root.__autoLogin) {
          root.__autoLogin.err = code + ' / ' + String((e && e.message) || e).slice(0, 120);
        }
      } catch (_) { }
      // ⚠ 连不上后端时【不要】清掉凭证：那只是这次没网，下次开还能用。
      //   只有后端【明确说】凭证无效才清。
      if (code === 'AUTH_INVALID' || code === 'AUTH_REQUIRED') clearRemembered();
      return null;
    }
  }

  function setBaseUrl(value) {
    var next = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(next)) throw new Error('后端地址必须以 http:// 或 https:// 开头');
    if (next !== state.baseUrl) {
      authEpoch++;
      if (state.accessToken || state.account) {
        sessionEnding();
        state.accessToken = ''; state.account = null; state.sessionEnded = true;
      }
      sessionVersion++;
    }
    state.baseUrl = next;
    notify();
    return state.baseUrl;
  }

  async function request(path, options, session) {
    var opts = Object.assign({timeoutMs: /^\/v1\/compute\//.test(path) ? 60000 : 20000}, options || {});
    var url = (session ? session.baseUrl : state.baseUrl) + path;
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var sentToken = session ? session.accessToken : state.accessToken;
    if (sentToken) headers.Authorization = 'Bearer ' + sentToken;
    var payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    var result;
    if (root.uiwin && root.uiwin.http && root.uiwin.http.fetch) {
      result = await root.uiwin.http.fetch({
        url: url,
        method: opts.method || 'GET',
        headers: headers,
        body: payload,
        timeoutMs: opts.timeoutMs,
        requestId: 'backend-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
      });
    } else {
      var signal = opts.timeoutMs && root.AbortSignal && root.AbortSignal.timeout ? root.AbortSignal.timeout(opts.timeoutMs) : undefined;
      var response = await root.fetch(url, { method: opts.method || 'GET', headers: headers, body: payload, keepalive: opts.keepalive === true, signal: signal });
      result = { ok: response.ok, status: response.status, body: await response.text() };
    }
    var data = null;
    try { data = result && result.body ? JSON.parse(result.body) : null; } catch (_) {}
    if (!result || !result.ok) {
      if (result && result.status === 401 && state.accessToken === sentToken && data && ['AUTH_INVALID','AUTH_REQUIRED'].includes(data.code)) {
        state.accessToken = ''; state.account = null; state.sessionEnded = true; notify();
      }
      var error = new Error(data && data.message ? data.message : '后端请求失败');
      error.code = data && data.code || 'BACKEND_REQUEST_FAILED';
      error.status = result && result.status;
      throw error;
    }
    return data || {};
  }

  function ensureDeviceId() {
    if (!state.deviceId) {
      try { state.deviceId = root.localStorage.getItem('wheelchair.device-id.v1') || ''; } catch (_) {}
      if (!state.deviceId) {
        state.deviceId = randomId();
        try { root.localStorage.setItem('wheelchair.device-id.v1', state.deviceId); } catch (_) {}
      }
    }
    return state.deviceId;
  }

  // ⭐⭐⭐ 2026-10-09（用户定：「登录咋没有验证码呢？…你好歹去个手动验证码吧？」）
  //
  //   取一张图形验证码。后端是【自绘 SVG】的（captcha.py），不依赖任何境外服务
  //   —— 项目里有明确理由：Turnstile/hCaptcha 国内加载不出来会让页面卡死，比没验证码更糟。
  //
  //   ⚠⚠ 为什么必须补这一步：后端【注册】接口早就强制要验证码了（server.py 注册那段），
  //     但客户端 register() 从来没发过 captchaId/captcha
  //      ⇒ 软件里点「注册账号」【必然失败】（报"验证码错误或已过期"）。
  //      这是个一直没被发现的坏功能 —— 因为注册这条路平时没人走。
  //   ⚠ 登录原本【完全没有】验证码（只有限流）。现在后端加上了，这里同步补。
  //   ⚠ 验证码是【一次性】的：不管对错，用掉就作废（captcha.consume 的设计）。
  //     ⇒ 每次登录/注册失败后都必须重新取一张，不能拿旧图重试。
  //   ⚠⚠ 必须是 POST，不能是 GET：后端把这条路由写在 do_POST 里
  //     （server.py 的 `if path == "/v1/auth/captcha"`）。
  //     我第一版写的是 GET，结果线上/本机都回 404「找不到接口」——
  //     一度误以为是没发版，其实是方法用错了。
  async function captchaChallenge() {
    return request('/v1/auth/captcha', { method: 'POST', body: {} }, { baseUrl: state.baseUrl, accessToken: '' });
  }

  async function register(email, password, displayName, captchaId, captchaAnswer) {
    var operation = ++authEpoch;
    var endpoint = state.baseUrl;
    var result = await request('/v1/auth/register', { method: 'POST', body: {
      email: String(email || '').trim(), password: String(password || ''), displayName: String(displayName || ''),
      // ⚠ 这两个必须发：不发的话后端一定回 CAPTCHA_INVALID（注册接口强制验码）
      captchaId: String(captchaId || ''), captcha: String(captchaAnswer || ''),
      deviceId: ensureDeviceId()
    }}, {baseUrl: endpoint, accessToken: ''});
    if (operation !== authEpoch || state.baseUrl !== endpoint) throw staleAuthError();
    await sessionEnding();
    if (operation !== authEpoch) throw staleAuthError();
    state.accessToken = String(result.accessToken || '');
    state.account = result.account || null;
    state.sessionEnded = false;
    sessionVersion++;
    notify();
    return snapshot();
  }

  async function login(email, password, captchaId, captchaAnswer, remember) {
    var operation = ++authEpoch;
    var endpoint = state.baseUrl;
    var result = await request('/v1/auth/login', { method: 'POST', body: {
      email: String(email || '').trim(), password: String(password || ''), deviceId: ensureDeviceId(),
      // ⭐ 2026-10-09：登录也要验证码了（用户定）。见上面 captchaChallenge 的说明。
      captchaId: String(captchaId || ''), captcha: String(captchaAnswer || '')
    }}, {baseUrl: endpoint, accessToken: ''});
    if (operation !== authEpoch || state.baseUrl !== endpoint) throw staleAuthError();
    await sessionEnding();
    if (operation !== authEpoch) throw staleAuthError();
    state.accessToken = String(result.accessToken || '');
    state.account = result.account || null;
    state.sessionEnded = false;
    sessionVersion++;
    // ⭐ 2026-10-14「记住我」：勾了就存【凭证】（不是密码），下次开软件自动登录。
    //   ⚠ 不勾就【主动清掉】旧的那份 —— 否则用户取消勾选、下次开还是自动登录了，
    //     那是最容易被骂的一种行为（"我明明取消了"）。
    if (remember) saveRemembered(); else clearRemembered();
    notify();
    return snapshot();
  }

  async function logout() {
    var operation = ++authEpoch;
    var captured = authSnapshot();
    await sessionEnding();
    if (captured.accessToken) {
      try { await request('/v1/auth/logout', { method: 'POST', body: {} }, captured); } catch (_) {}
    }
    if (operation !== authEpoch) throw staleAuthError();
    state.accessToken = '';
    state.account = null;
    state.sessionEnded = true;
    sessionVersion++;
    // ⭐ 2026-10-14：用户主动退出 ⇒ 本地那份凭证【必须】清掉。
    //   不清的话下次开软件会自动又把他登回去 —— 用户会觉得"退出没生效"。
    clearRemembered();
    notify();
    return snapshot();
  }

  async function me() {
    var captured = authSnapshot();
    var result = await request('/v1/auth/me', undefined, captured);
    // The account response is only allowed to update the identity it queried.
    // This covers A -> B and A -> B -> A, including a delayed /auth/me.
    assertAuthSnapshot(captured);
    state.account = result.account || null;
    state.deviceId = result.deviceId || state.deviceId;
    notify();
    return snapshot();
  }

  async function points() {
    return request('/v1/points');
  }

  async function pointLedger(options) {
    var value = options || {}, params = new URLSearchParams();
    params.set('offset', String(Math.max(0, Math.floor(Number(value.offset) || 0))));
    params.set('limit', String(Math.max(1, Math.min(100, Math.floor(Number(value.limit) || 20)))));
    if (['common', 'banana'].includes(value.pool)) params.set('pool', value.pool);
    return request('/v1/points/ledger?' + params.toString());
  }

  async function redeemPoints(code) {
    return request('/v1/points/redeem', { method: 'POST', body: { code: String(code || '').trim() } });
  }

  async function accountNotices() {
    return request('/v1/account/notices');
  }

  async function providers() {
    return request('/v1/providers');
  }

  async function providerRecommendations() {
    return request('/v1/providers/recommendations');
  }

  async function models(providerId, keyword) {
    var params = new URLSearchParams();
    if (providerId) params.set('provider', String(providerId));
    if (keyword) params.set('q', String(keyword));
    return request('/v1/models' + (params.toString() ? '?' + params.toString() : ''));
  }

  async function testProvider(providerId) {
    return request('/v1/providers/' + encodeURIComponent(String(providerId || '')) + '/test', { method: 'POST', body: {} });
  }

  // 本地引擎要下的那批模型（抠像 / SAM2 / 插帧 …）的下载清单（docs/128 §三-3）。
  //
  // ⚠ 跟上面 models() 完全两回事 —— 那个是「云端出图用哪个服务商模型」。
  // ⚠ 要登录：清单里带网盘链接和提取码，是慢网速时的兜底通道，不能白送出去。
  // ⚠ 拉不到【不算错误】：调用方要退回内置清单 ——
  //   不能因为后台挂了，用户连下载入口都没有了。
  async function modelDownloadManifest() {
    return request('/v1/models/download-manifest');
  }

  // ⭐ 2026-10-09（用户要求）：模型下载的【网盘地址】。
  //
  //   用户原话：「有时候可能这个链接会过期，或者百度网盘链接会失效，
  //              所以说需要同步到后台」。
  //   ⇒ 链接存后台，客户端每次用时现拉。**绝不写死在界面里。**
  //
  // ⚠ 这条【不需要登录】，跟上面 modelDownloadManifest 不一样：
  //   清单里有主地址 / sha256 / 文件大小，那些不给外人；
  //   网盘链接本来就是发给用户的东西 ⇒ 后台单开了一条只吐链接+提取码的窄接口。
  //   ⚠ 为什么必须免登录：用户装完软件【还没登录】就要下模型，
  //     要他先登录才能看到下载链接，等于第一步就卡住。
  //
  // ⚠ 拉不到【不算错误】：返回空对象，调用方如实说"还没配"——
  //   不能因为后台挂了，用户连网盘地址都看不到。
  async function modelPanLinks() {
    try {
      var data = await request('/v1/public/models/pan');
      return (data && data.models) || {};
    } catch (_) {
      return {};
    }
  }

  // ⭐⭐ 2026-10-09（用户定）：「砍掉软件里的社区，软件里只留一个「社区」按钮，点了跳网页」
  //   ⇒ 软件里那个按钮要跳到哪，由后台给（不写死在客户端）。
  //
  //   ⚠ 为什么免登录：跳个网页而已，跟账号无关。而且没登录的用户也该能进社区。
  //   ⚠ 拉不到【不算错误】：返回空的 url，调用方显示"暂未开放"并且点不动 ——
  //     绝不能因为后台挂了就跳个 404 或者让按钮点了没反应。
  // 「设置 → 关于软件」用（2026-10-16）：线上后台现在跑的版本和代码指纹。免登录（/health 本来就公开）；拉不到返回 null
  async function publicHealth() {
    try { return await request('/health', { timeoutMs: 8000 }); } catch (_) { return null; }
  }

  // ⭐ 2026-10-18 云端外挂工具（docs/237）：领云端通行证（15 分钟有效）。
  //   账号服务器只发证、不过图；拿到 { pass, url, expiresIn } 后软件直接连云端门卫（cloud-tools.js）。
  async function cloudToolsPass() {
    return request('/v1/cloud-tools/pass', { method: 'POST', body: {}, timeoutMs: 15000 });
  }

  async function publicCommunity() {
    try {
      var data = await request('/v1/public/community');
      return {
        url: String((data && data.url) || ''),
        title: String((data && data.title) || '社区'),
        note: String((data && data.note) || '')
      };
    } catch (_) {
      return { url: '', title: '社区', note: '' };
    }
  }

  // ⭐ 2026-10-19（docs/252 ⑧，社区接线）：社区网页只认从软件拉起 —— 点「社区」时先拿一张一次性进门条子
  //   （后台 60 秒过期、只能用一次、绑这个账号），拼在网址 # 后面交给浏览器；网页拿条子换它自己的短期登录。
  //   要登录（用软件这张凭证要条子）；拿不到就抛错，调用方说清楚原因。
  async function communityTicket() {
    var data = await request('/v1/community/web-ticket', { method: 'POST', body: {}, timeoutMs: 15000 });
    var ticket = String((data && data.ticket) || '');
    if (!/^[A-Za-z0-9._~-]{4,512}$/.test(ticket)) throw Object.assign(new Error('后台没给出有效的进门条子'), { code: 'COMMUNITY_TICKET_INVALID' });
    return ticket;
  }

  async function quote(route, requestedCount, context) {
    return request('/v1/tasks/quote', { method: 'POST', body: Object.assign({}, context || {}, {
      route: String(route || ''), requestedCount: Math.max(1, Number(requestedCount) || 1)
    })});
  }

  async function createTask(payload) {
    var body = Object.assign({}, payload || {});
    body.idempotencyKey = String(body.idempotencyKey || ('v7-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)));
    body.requestedCount = Math.max(1, Number(body.requestedCount) || 1);
    return request('/v1/tasks', { method: 'POST', body: body });
  }

  async function cancelTask(taskId) {
    return request('/v1/tasks/' + encodeURIComponent(String(taskId || '')) + '/cancel', { method: 'POST', body: {} });
  }

  // 2026-10-21：查一单的状态（云端工作流跑着时顺带拿实时进度 progress：排队前面几单 / 采样第几步）
  async function getTask(taskId) {
    return request('/v1/tasks/' + encodeURIComponent(String(taskId || '')), { method: 'GET' });
  }

  async function setProviderTask(taskId, providerTaskId) {
    return request('/v1/tasks/' + encodeURIComponent(String(taskId || '')) + '/provider', { method: 'POST', body: {
      providerTaskId: String(providerTaskId || '')
    }});
  }

  async function workflowAvailability(presetId, route, requestedCount, referenceCount = 0) {
    return request('/v1/workflows/availability', { method: 'POST', body: { presetId: String(presetId || ''), route: String(route || ''), requestedCount: Number(requestedCount) || 1, referenceCount } });
  }

  // 云端官方预设（2026-10-15）：只有参数说明、不带工作流本体，要登录
  async function officialPresets() {
    return request('/v1/workflows/official-presets', { method: 'GET' });
  }

  // 云端预设库（2026-10-24 晚，V7待办/16，backend/cloud_presets.py）：增量拉，since = 上次的游标（空 = 全量），要登录
  async function presetLibrary(since) {
    return request('/v1/presets/library?since=' + encodeURIComponent(String(since || '')), { method: 'GET' });
  }

  async function executionTicket(taskId) {
    return request('/v1/tasks/' + encodeURIComponent(String(taskId || '')) + '/execution-ticket', { method: 'POST', body: {} });
  }

  async function recordTaskOutputs(taskId, outputs) {
    return request('/v1/tasks/' + encodeURIComponent(String(taskId || '')) + '/outputs', { method: 'POST', body: { outputs: Array.isArray(outputs) ? outputs : [] } });
  }

  async function requestVerification(channel, target) {
    return request('/v1/auth/verification/request', { method: 'POST', body: { channel: channel, target: target } });
  }

  async function requestPasswordRecovery(email) {
    return request('/v1/auth/recovery/request', { method: 'POST', body: { email: String(email || '').trim() } });
  }

  async function resetPassword(email, code, newPassword) {
    var normalized = String(email || '').trim().toLowerCase(), version = sessionVersion;
    var result = await request('/v1/auth/recovery/confirm', { method: 'POST', body: { email: normalized, code: String(code || '').trim(), newPassword: String(newPassword || '') } });
    if (sessionVersion === version && state.account && String(state.account.email).toLowerCase() === normalized) {
      sessionEnding(); state.accessToken = ''; state.account = null; state.sessionEnded = true; sessionVersion++; notify();
    }
    return result;
  }

  async function confirmVerification(channel, code) {
    return request('/v1/auth/verification/confirm', { method: 'POST', body: { channel: channel, code: code } });
  }

  async function communityPrompts(query, status) {
    var params = new URLSearchParams();
    if (query) params.set('q', String(query));
    if (status) params.set('status', String(status));
    return request('/v1/community/prompts' + (params.toString() ? '?' + params.toString() : ''));
  }

  async function submitCommunityPrompt(title, prompt, metadata) {
    return request('/v1/community/prompts', { method: 'POST', body: { title: title, prompt: prompt, metadata: metadata || {} } });
  }

  async function reviewCommunityPrompt(promptId, decision, reason) {
    return request('/v1/community/prompts/' + encodeURIComponent(String(promptId || '')) + '/review', { method: 'POST', body: { decision: decision, reason: reason || '' } });
  }

  async function reactCommunityPrompt(promptId, action, reason) {
    return request('/v1/community/prompts/' + encodeURIComponent(String(promptId || '')) + '/react', { method: 'POST', body: { action: action, reason: reason || '' } });
  }

  async function leaderboard(period) {
    var value = ['day', 'week', 'month'].indexOf(String(period || 'day')) >= 0 ? String(period || 'day') : 'day';
    return request('/v1/community/leaderboard?period=' + encodeURIComponent(value));
  }

  async function communitySummary() {
    return request('/v1/community/summary');
  }

  async function communityPresence(activityState, options) {
    var value = activityState || 'active';
    if (!['active', 'generating', 'leave'].includes(value)) throw new Error('在线状态无效');
    if (!state.accessToken || !state.account) throw new Error('请先登录平台账号');
    if (value !== 'leave' && state.account.share_activity !== true && state.account.share_activity !== 1) {
      var denied = new Error('请先自主开启在线人数统计分享');
      denied.code = 'ACTIVITY_CONSENT_REQUIRED'; throw denied;
    }
    var session = { baseUrl: state.baseUrl, accessToken: state.accessToken };
    // Serialize renewal and leave for the captured session. A slow heartbeat
    // must not arrive after a leave and revive the old account's presence.
    var sent = presenceQueue.catch(function () {}).then(function () {
      return request('/v1/community/presence', { method: 'POST', body: { state: value }, keepalive: !!(options && options.keepalive), timeoutMs: 5000 }, session);
    });
    presenceQueue = sent;
    return sent;
  }

  async function communityPrivacy(values) {
    var body = typeof values === 'boolean' ? { showRankName: values } : {};
    if (values && typeof values === 'object') {
      ['showRankName', 'shareActivity'].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          if (typeof values[key] !== 'boolean') throw new Error('隐私选项必须为开启或关闭');
          body[key] = values[key];
        }
      });
    }
    var started = state.accessToken;
    var result = await request('/v1/community/privacy', { method: 'POST', body: body });
    if (state.accessToken === started && result.account) { state.account = result.account; notify(); }
    return result;
  }

  async function communityMine() {
    return request('/v1/community/mine');
  }

  async function communitySaved() {
    return request('/v1/community/saved');
  }

  async function supportTickets() {
    return request('/v1/support/tickets');
  }

  async function supportSummary() {
    return request('/v1/support/summary');
  }

  async function submitSupportTicket(subject, body, taskId) {
    return request('/v1/support/tickets', { method: 'POST', body: {
      subject: String(subject || ''), body: String(body || ''), taskId: taskId ? String(taskId) : undefined
    }});
  }

  // ⭐ 2026-10-18 深夜：问题反馈卡（feedback-card.js → 后台「问题反馈」页，backend/feedback.py）。
  //   带图时请求体最多 ~11MB：给 3 分钟（默认 20 秒，网慢的用户带 4 张图会被误判超时）。
  async function submitFeedback(payload) {
    var p = payload || {};
    return request('/v1/feedback', { method: 'POST', timeoutMs: 180000, body: {
      clientId: String(p.clientId || ''), category: String(p.category || 'bug'), body: String(p.body || ''),
      images: Array.isArray(p.images) ? p.images.slice(0, 4) : [], appVersion: String(p.appVersion || ''),
      diagnostics: String(p.diagnostics || ''), context: p.context && typeof p.context === 'object' ? p.context : undefined
    }});
  }

  async function replySupportTicket(ticketId, body) {
    return request('/v1/support/tickets/' + encodeURIComponent(String(ticketId || '')) + '/reply', { method: 'POST', body: { body: String(body || '') } });
  }

  async function syncSecret(name, value, enabled) {
    secretTransport();
    return request('/v1/sync/secrets', { method: 'POST', body: { name: name, value: value, enabled: enabled === true } });
  }

  async function syncBackup(manifest) {
    return request('/v1/sync/backups', { method: 'POST', timeoutMs: 3600000, body: {
      manifest: manifest || {}
    }});
  }

  function secretTransport() {
    var url = new URL(state.baseUrl);
    if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
      var error = new Error('Key 同步需要 HTTPS 服务地址，本机测试可以使用 localhost');
      error.code = 'KEY_SYNC_TLS_REQUIRED'; throw error;
    }
  }

  async function dlssAvailability() {
    var version = sessionVersion, token = state.accessToken;
    if (!token || !state.account) throw Object.assign(new Error('请先登录平台账号'), {code:'AUTH_REQUIRED'});
    if (dlssWorker && dlssWorker.version === version) return dlssWorker.value;
    var value = await request('/v1/dlss/availability');
    if (sessionVersion !== version || state.accessToken !== token) throw Object.assign(new Error('账号已切换，已停止原账号传输'), {code:'DLSS_ACCOUNT_CHANGED'});
    var url = new URL(value.workerUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
      throw Object.assign(new Error('DLSS 服务地址无效或缺少安全连接'), {code:'DLSS_SERVICE_UNCONFIGURED'});
    }
    dlssWorker = {version:version,value:{...value,workerUrl:url.href.replace(/\/+$/,'')}};
    return dlssWorker.value;
  }

  async function dlssRequest(path, options) {
    if (!/^\/v1\/dlss\//.test(path)) throw new Error('DLSS 请求路径无效');
    var version = sessionVersion, token = state.accessToken;
    var available = await dlssAvailability();
    if (sessionVersion !== version || state.accessToken !== token) throw Object.assign(new Error('账号已切换，已停止原账号传输'), {code:'DLSS_ACCOUNT_CHANGED'});
    var value = await request(path, options, {baseUrl:available.workerUrl,accessToken:token});
    if (sessionVersion !== version || state.accessToken !== token) throw Object.assign(new Error('账号已切换，已停止原账号传输'), {code:'DLSS_ACCOUNT_CHANGED'});
    return value;
  }

  // ═══════════════════════════════════════════════════════════════
  //  平台算力（GRS）· 对应 V6 的 /compute/* 四个接口
  //
  //  ⚠⚠ 2026-10-02 补。为什么必须有：前端一直【没有】调过这四个接口，
  //     于是「平台算力」这条路是死的 —— 用户拿不到 key，生成必失败；
  //     不回报名，后台看到的余额永远是旧的、日/小时风控形同虚设（docs/110 第四节）。
  //
  //  ⚠⚠ 字段名跟 V6 不一样，【不能拿 V6 插件的代码直接贴】（docs/110 已点名）：
  //     | | V6 | V7 |
  //     | 外层 | { errno:0, info:"..." } | HTTP 状态码 + 直接返回数据 |
  //     | 命名 | key_status / banana_points | keyStatus / bananaPoints |
  //     | 路径 | /compute/key | /v1/compute/key |
  //     贴错不报错、只是值永远读到 undefined（铁律 17 那种静默失效）。
  //
  //  ⚠⚠ 四个接口后端【一律返回 200】来表达业务失败（余额不足、被风控暂停等），
  //     失败信息放在 body 的 keyStatus / code 里，不是 HTTP 错误码。
  //     所以这里【不能】靠 catch 判断失败，必须看返回值 —— 见 computeKey 的注释。
  // ═══════════════════════════════════════════════════════════════

  // 拿平台子 key。
  //   返回（mode='proxy'）：{ mode, key, keyStatus, cap, balanceCached, dailyUsed, expiresAt, bananaPoints, message }
  //   keyStatus 非 'ok' 时【key 可能仍然有值】，但按产品要求不许拿它去生成。
  //
  // ⚠⚠ 不缓存：子 key 是【懒创建 + 有效期的】，而且风控可能随时把它改成 paused。
  //   缓存住就会出现"后台已经停了、前端还在拿旧 key 猛冲"。每次生成前现拿。
  async function computeKey() {
    var version = sessionVersion, token = state.accessToken;
    if (!token || !state.account) throw Object.assign(new Error('请先登录平台账号'), {code:'AUTH_REQUIRED'});
    var value = await request('/v1/compute/key');
    if (sessionVersion !== version || state.accessToken !== token) {
      throw Object.assign(new Error('账号已切换，已停止原账号传输'), {code:'COMPUTE_ACCOUNT_CHANGED'});
    }
    return value || {};
  }

  // 生成后回报：同步真实余额 + 把张数记进风控计数器。
  //   attempts = 本批【尝试】的张数（不是成功张数 —— 后端按尝试记账）。
  //
  // ⚠ 什么时候调：见 ui.html 的 aiReportComputeAttempts()。定的是
  //   【一批生成走完就报一次】，成功失败都报 —— 因为 GRS 是按"请求发出去"计费的，
  //   失败的那批一样消耗了额度，不报的话风控算少了。
  // ⚠ 这个调用【不该让生成失败】：余额同步是后台的事，用户已经拿到图了。
  //   所以调用方要自己 catch（见 ui.html 里那句注释）。
  async function computeRefill(attempts) {
    var value = await request('/v1/compute/refill', {
      method: 'POST',
      body: { attempts: Math.max(0, Number(attempts) || 0) }
    });
    return value || {};
  }

  // 强制对账（用户点「刷新余额」时用）。
  async function computeSync() {
    var value = await request('/v1/compute/sync', { method: 'POST', body: {} });
    return value || {};
  }

  // 切自带 key / 切回平台池。服务端只记 mode，不存用户自带的 key。
  async function computeByok(mode) {
    var value = await request('/v1/compute/byok', {
      method: 'POST',
      body: { mode: mode === 'byok' ? 'byok' : 'proxy' }
    });
    return value || {};
  }

  root.V7Backend = {
    state: snapshot,
    sendTelemetry: function(payload){return request('/v1/telemetry',{method:'POST',body:payload,timeoutMs:10000});},
    setBaseUrl: setBaseUrl,
    register: register,
    login: login,
    // ⭐ 2026-10-14「记住我」三件套（存的是【登录凭证】，不存密码）：
    //   restoreSession() 开软件时调一次，凭证还有效就自动登录
    //   remembered()     给界面读"记住了哪个邮箱"
    //   forget()         用户点"忘掉这台设备"时清掉
    restoreSession: restoreSession,
    remembered: remembered,
    forget: clearRemembered,
    // ⭐ 2026-10-09：取图形验证码（登录/注册都要用）。见上面 captchaChallenge 的说明。
    captchaChallenge: captchaChallenge,
    logout: logout,
    me: me,
    points: points,
    pointLedger: pointLedger,
    redeemPoints: redeemPoints,
    accountNotices: accountNotices,
    providers: providers,
    providerRecommendations: providerRecommendations,
    models: models,
    modelDownloadManifest: modelDownloadManifest,
    modelPanLinks: modelPanLinks,
    // ⭐ 2026-10-09：社区网页地址（软件里「社区」按钮跳过去用）。
    publicCommunity: publicCommunity,
    // ⭐ 2026-10-19：进社区网页的一次性条子（docs/252 ⑧）
    communityTicket: communityTicket,
    publicHealth: publicHealth,
    cloudToolsPass: cloudToolsPass,
    testProvider: testProvider,
    quote: quote,
    createTask: createTask,
    setProviderTask: setProviderTask,
    workflowAvailability: workflowAvailability,
    officialPresets: officialPresets,
    presetLibrary: presetLibrary,
    executionTicket: executionTicket,
    dlssAvailability: dlssAvailability,
    dlssRequest: dlssRequest,
    // ⭐ 2026-10-02 平台算力（GRS）四件套。见文件里那段的注释。
    computeKey: computeKey,
    computeRefill: computeRefill,
    computeSync: computeSync,
    computeByok: computeByok,
    cancelTask: cancelTask,
    getTask: getTask,
    recordTaskOutputs: recordTaskOutputs,
    requestVerification: requestVerification,
    requestPasswordRecovery: requestPasswordRecovery,
    resetPassword: resetPassword,
    confirmVerification: confirmVerification,
    communityPrompts: communityPrompts,
    submitCommunityPrompt: submitCommunityPrompt,
    reviewCommunityPrompt: reviewCommunityPrompt,
    reactCommunityPrompt: reactCommunityPrompt,
    leaderboard: leaderboard,
    communitySummary: communitySummary,
    communityPresence: communityPresence,
    communityPrivacy: communityPrivacy,
    communityMine: communityMine,
    communitySaved: communitySaved,
    supportTickets: supportTickets,
    supportSummary: supportSummary,
    submitSupportTicket: submitSupportTicket,
    submitFeedback: submitFeedback,
    replySupportTicket: replySupportTicket,
    syncSecret: syncSecret,
    syncBackup: syncBackup,
    backupInfo: function () { return request('/v1/sync/backups'); },
    readBackup: function () { return request('/v1/sync/backups/latest', {timeoutMs:3600000}); },
    deleteBackup: function () { return request('/v1/sync/backups/delete', {method:'POST',body:{confirmed:true}}); },
    listCloudSecrets: function () { secretTransport(); return request('/v1/sync/secrets'); },
    restoreCloudSecret: function (name) { secretTransport(); return request('/v1/sync/secrets/restore', {method:'POST',body:{name:name,confirmed:true}}); },
    deleteCloudSecrets: function (name) { secretTransport(); return request('/v1/sync/secrets/delete', {method:'POST',body:{name:name,confirmed:true}}); },
    onChange: function (listener) { if (typeof listener === 'function') listeners.push(listener); return function () { listeners = listeners.filter(function (item) { return item !== listener; }); }; },
    onSessionEnding: function (listener) { if (typeof listener === 'function') sessionEndingListeners.push(listener); return function () { sessionEndingListeners = sessionEndingListeners.filter(function (item) { return item !== listener; }); }; },
    requiresPlatformAccount: function (provider, computeSource) { return computeSource === 'platform'; },
    ensureDeviceId: ensureDeviceId
  };
})(window);
