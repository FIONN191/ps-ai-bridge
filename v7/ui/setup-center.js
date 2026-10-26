(function (root) {
  'use strict';
  // 2026-10-18 教程（tutorial-host.js）里用教程专用的钥匙：教程里点「安装 / 修复桥接」、选 PS 版本，不能写进用户真的首次设置记录
  const KEY = root.__V7_TUTORIAL__ ? 'wheelchair.v7.tutorial.setup.local.v1' : 'wheelchair.v7.setup.local.v1';
  let host = {}, state = read(), candidates = [], ready = false, session = null, serial = 0;
  let windowQueue = Promise.resolve(), subscribed = false;
  function read() { try { const value = JSON.parse(localStorage.getItem(KEY) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch (_) { return {}; } }
  function write() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function active(run) { return !!run && run === session; }
  function request(operation, payload) {
    const pending = windowQueue.catch(() => {}).then(async () => {
      if (!root.uiwin?.setup?.request) throw new Error('独立设置窗口不可用，请重新启动软件。');
      const value = await root.uiwin.setup.request(operation, payload || {});
      if (!value?.ok) throw new Error(value?.error || '独立设置窗口未响应');
      return value;
    });
    windowQueue = pending;
    return pending;
  }
  function model(run) {
    // ⚠ 2026-10-14：原来这里有一项 tutorial: run.tutorial?.snapshot() || null
    //   —— 传给 setup-window 画教程面板用。教程删了，这一项跟着删。
    //   ⚠ 它是可选链写法，留着不会抛，但会让 setup-window 里 `value.tutorial?.complete`
    //     永远 false —— 那种"不报错但行为不对"最费时间，所以主动清掉。
    //   重做教程时加回来，见 docs/217。
    return { session: run.id, required: run.required, busy: run.busy, terms: run.terms, notice: run.notice || '',
      canFinish: canFinish(run),
      consent: root.V7FirstRun?.describe?.(), agreed: !!root.V7FirstRun?.isComplete(),
      providerReady: !!host.providerConfigured?.(), assistantReady: !!root.V7AssistantPanel?.connectionState?.().ready,
      candidates, state: { ...state }, bridgeReady: ready, theme: readTheme(),
      localAssistant: run.local || { models: [], message: '尚未检测本地聊天运行时。' } };
  }
  // ⚠ 2026-10-21 修：原来在全部账号的设置里随便挑「最后一个」读主题 —— 这台电脑登过几个账号时会读到别人的配色。
  //   主题现在跟电脑走（machine-settings.v1），先读这份；读不到（老数据还没搬）再读【当前账号】那份。
  function readTheme() {
    const out = {};
    const names = ['blur','opacity','themeCardBg','themeText','themeAccent','themeNoTint'];
    const read = key => { try { const v = key ? JSON.parse(localStorage.getItem(key) || 'null') : null; return v && typeof v === 'object' ? v : null; } catch (_) { return null; } };
    try {
      const S = root.WHEELCHAIR_STORAGE;
      const machine = read(S && typeof S.localKey === 'function' ? S.localKey('machine-settings.v1') : '');
      const account = read(S ? S.key('v7.settings.v1') : 'v7.settings.v1');
      names.forEach(name => {
        const src = machine && machine[name] !== undefined ? machine : account;
        if (src && src[name] !== undefined) out[name] = src[name];
      });
    } catch (_) {}
    return out;
  }
  async function publish(run) { if (active(run)) { if (run.embedded) run.renderer?.paint(model(run)); else await request('update', model(run)); } }
  async function report(error, run) {
    if (run && !active(run)) return;
    if (run?.required || run?.embedded) {
      // If the native required window never opened, keeping the first-run
      // session alive would leave body.inert in place with no surface left
      // for the user to recover it. Release that lock and let the main page
      // show the error through the normal error reporter instead.
      if (run?.required && !run.embedded && !run.nativeOpened) {
        detach(run);
      } else {
        run.busy = false; run.notice = error.detail || error.message || String(error);
        await publish(run).catch(() => {});
      }
    } else await close().catch(() => {});
    const code = error.code || String(error.error || error.message || '').split(':')[0];
    root.ERR?.report(code.startsWith('UXP_') || code.startsWith('PHOTOSHOP_') ? code : 'SETUP_OPERATION_FAILED', { message: error.detail || error.message || String(error) });
  }
  async function call(name, ...args) {
    const api = root.uiwin?.photoshop;
    if (!api || typeof api[name] !== 'function') throw new Error('PHOTOSHOP_CALLER_DENIED');
    const value = await api[name](...args);
    if (value?.cancelled) return value;
    if (!value?.ok) throw Object.assign(new Error(value?.error || 'SETUP_OPERATION_FAILED'), value || {});
    return value;
  }
  function current() { return candidates.find(c => c.path === state.photoshopPath) || null; }
  async function localAction(run, action, value) {
    if (action === 'model') { state.localModel = String(value || ''); write(); return; }
    run.notice = action === 'pull' ? '正在下载所选模型；关闭设置将停止本次等待，Ollama 已下载的部分可能仍保留。' : action === 'test' ? '正在进行本机聊天测试。' : '正在检查本地聊天运行时。';
    await publish(run); if (!active(run)) return;
    const result = await root.uiwin.setup.request('local-assistant', { session: run.id, action, model: action === 'pull' ? String(value || '') : state.localModel || '' });
    if (!active(run)) return;
    if (result?.cancelled) { run.notice = '已取消本次本地助手操作。'; return; }
    if (!result?.ok) { run.notice = result?.error || '本地助手准备失败，请重新检测后重试。'; run.local = { ...run.local, error: run.notice }; return; }
    if (action === 'test') {
      if (!result.tested || !root.V7AssistantPanel?.useLocalConnection) throw new Error('本地助手连接接口不可用，请重新启动软件。');
      const connected = await root.V7AssistantPanel.useLocalConnection(result.config,{signal:run.controller.signal,isCurrent:()=>active(run)});
      if (!active(run)) return;
      if (!connected?.ok) { run.notice = connected?.error || '本机聊天模型尚未通过助手连接测试。'; return; }
      state.skipAssistant = false; write();
      if (run.required) { run.notice = '本机助手已经通过测试。可以继续完成设置。'; return; }
      await close(); await host.openAssistant?.(); return;
    }
    if (Array.isArray(result.models)) {
      run.local = result;
      if (state.localModel && !result.models.some(row => row.name === state.localModel)) { state.localModel = ''; write(); }
      run.notice = result.running ? 'Ollama 已连接，已读取 ' + result.models.length + ' 个本机模型。请选择模型并测试后启用。' : result.message || '本地助手暂不可用。';
    } else run.notice = '已打开官方页面。完成安装或选择模型后，返回这里继续准备。';
  }
  async function detect(run) {
    const result = await call('discover', state.photoshopPath || '');
    if (run && !active(run)) return;
    candidates = result.candidates || [];
    if (!state.photoshopPath && candidates.length === 1) { state.photoshopPath = candidates[0].path; write(); }
  }
  async function refresh(run) {
    if (!active(run) || run.refreshing) return;
    run.refreshing = true;
    try {
      const result = await root.uiwin?.link?.status();
      if (!active(run)) return;
      const bridge = result?.bridge, age = Date.now() - Date.parse(bridge?.lastPollAt);
      const next = !!bridge?.connected && Number.isFinite(age) && age >= -1000 && age < 12000;
      if (next !== ready) { ready = next; await publish(run); }
    } catch (_) { if (active(run) && ready) { ready = false; await publish(run); } }
    finally { run.refreshing = false; }
  }
  function detach(run) {
    if (!active(run)) return;
    run.controller.abort();
    clearInterval(run.timer); run.renderer?.dispose(); session = null;
    document.documentElement.classList.remove('setup-window-open');
    // Release the DOM lock on every native-window exit.  A required session
    // is reopened by the onClosed handler below; keeping `inert` here when
    // that reopen fails would leave the whole main page permanently dead.
    // `open()` reapplies the first-run lock before it asks the native window
    // to open, so the normal required-session gate remains intact.
    document.documentElement.classList.remove('setup-required');
    document.body.inert = false;
    root.dispatchEvent(new Event('wheelchair:setup-window-closed'));
  }
  // Provider/LLM setup and Photoshop bridge health are optional capabilities.
  // First launch must not lock the whole application behind either service;
  // bridge-dependent actions report their own unavailable state when used.
  // ⚠⚠ 2026-10-14：原来这里是
  //     return !!root.V7FirstRun?.isComplete() && (!run?.required || !!run.tutorial?.snapshot().complete);
  //   —— 后半句是"必修教程没看完就不能完成"。教程删了，run.tutorial 也不存在了，
  //     留着这一段会让 canFinish 永远 false（`.snapshot()` 抛错 / undefined）⇒ 向导卡死。
  //   ⇒ 现在只剩"同意条款"这一个必修项：同意过就能完成。
  //   ⚠ 重做教程时把后半句加回来（清单见 docs/217）。
  function canFinish(run) { return !!root.V7FirstRun?.isComplete(); }
  function finishRequired(run) {
    if (!canFinish(run)) return false;
    state.finishedAt = state.finishedAt || new Date().toISOString();
    if (ready) state.bridgeVerifiedAt = new Date().toISOString();
    else delete state.bridgeVerifiedAt;
    write();
    document.documentElement.classList.remove('setup-required'); document.body.inert = false;
    return true;
  }
  async function close() {
    const run = session; if (!run) return windowQueue.catch(() => {});
    // ⚠ 2026-10-14：文案里的「入门教程」删掉了（教程要重做，首启已经没有这一步了）。
    //   不能再说"请完成入门教程" —— 用户根本找不到那个教程（铁律 15：不许空话）。
    if (run.required && !state.finishedAt) { run.notice = '请先同意使用条款；Photoshop 联动和服务配置可以稍后完成。'; await publish(run); return false; }
    detach(run);
    await request(run.embedded ? 'detach' : 'close', { session: run.id, completed: !!state.finishedAt });
    return true;
  }
  async function action(data) {
    const run = session;
    if (!run || data?.session !== run.id) return;
    if (data.action === 'quit' && run.required) { run.quitting = true; try { await request('quit', { session: run.id }); } catch (error) { run.quitting = false; await report(error,run); } return; }
    if (data.action === 'close') { await close(); return; }
    if (run.busy) return;
    run.busy = true; run.notice = '';
    try {
      await publish(run);
      if (!active(run)) return;
      const name = data.action;
      // ⚠⚠ 2026-10-14：这里原来是一段「教程没看完就把其他动作全挡掉」的拦截：
      //     if (run.required && !run.tutorial?.snapshot().complete) {
      //       if (name === 'tutorial-next' && run.tutorial?.next()) { …存教程进度… }
      //       return;   ← 关键：不是教程动作就直接 return，下面所有按钮都点不动
      //     }
      //   教程删了 ⇒ run.tutorial 是 undefined，`.snapshot()` 会抛
      //   ⇒ 这一段整个摘掉。首启的必修项现在只剩【同意条款】那一步。
      //   ⚠ 重做教程时把这段加回来（含 state.tutorialIndex / tutorialProgressVersion /
      //     tutorialVersion / tutorialCompletedAt 那几个存档字段的写入），清单见 docs/217。
      if (name === 'consent') run.terms = true;
      else if (name === 'terms-back') run.terms = false;
      else if (name === 'terms-accept' && run.terms) {
        if (!root.V7FirstRun?.accept(data.value)) throw new Error('条款同意记录未保存，请重试。');
        run.terms = false;
      } else if (!root.V7FirstRun?.isComplete()) return;
      else if (name.startsWith('local-')) await localAction(run, name.slice(6), data.value);
      else if (name === 'detect') await detect(run);
      else if (name === 'choose') {
        const result = await call('choose');
        if (!active(run) || result.cancelled) return;
        candidates = result.candidates || []; state.photoshopPath = result.selectedPath || candidates[0]?.path || '';
        delete state.backupId; ready = false; write();
      } else if (name === 'ps') {
        if (data.value && !candidates.some(c => c.path === data.value)) return;
        state.photoshopPath = String(data.value || ''); delete state.backupId; ready = false; write();
      } else if (name === 'autolaunch' || name === 'skip') {
        state[name === 'skip' ? 'skipAssistant' : 'autoLaunch'] = data.value === true; write();
      } else if (['launch', 'install', 'rollback'].includes(name)) {
        const selected = current(); if (!selected) return;
        if (name === 'launch') {
          const info = await call('inspect', selected);
          if (active(run) && !info.running) await call('launch', selected);
        } else {
          const result = await call(name, selected, state.backupId);
          // Persist a completed installation's recovery receipt even after closing.
          if (result.cancelled) return;
          if (state.photoshopPath === selected.path) {
            if (name === 'install' && result.backupId) state.backupId = result.backupId;
            if (name === 'rollback') delete state.backupId;
            write();
          }
          if (active(run)) run.notice = name === 'install' ? '桥接文件已就绪。打开 Photoshop 的增效工具中的桥接面板，等待真实连接响应。' : '上次桥接文件已恢复。';
          // 2026-10-24：报错栏那张「插件需要更新」常驻卡马上核对一次（PS 关着 + 文件已是新版 ⇒ 立刻收掉，不等下次开 PS）
          if (name === 'install') root.dispatchEvent(new Event('wheelchair:bridge-installed'));
        }
        await refresh(run);
      } else if (['provider', 'assistant', 'guide'].includes(name)) {
        if (run.required) { await refresh(run); if (!finishRequired(run)) { run.notice = '请先完成入门教程并同意使用条款，再进入后续配置。'; return; } }
        await close();
        if (name === 'provider') await host.openProvider?.();
        if (name === 'assistant') await host.openAssistant?.();
        if (name === 'guide') await host.openGuide?.();
      } else if (name === 'finish') {
        await refresh(run);
        if (!canFinish(run)) { run.notice = '请先完成入门教程并同意使用条款。Photoshop 联动和图像服务可以稍后设置。'; return; }
        finishRequired(run); await close(); host.onComplete?.();
      }
    } catch (error) { await report(error, run); }
    finally { if (active(run)) { run.busy = false; await publish(run).catch(error => report(error, run)); } }
  }
  function subscribe() {
    if (subscribed) return;
    if (!root.uiwin?.setup) throw new Error('独立设置窗口不可用，请重新启动软件。');
    root.uiwin.setup.onAction(data => action(data).catch(error => report(error, session)));
    root.uiwin.setup.onClosed(data => {
      if (session?.id !== data?.session) return;
      const required = session.required && !state.finishedAt && !session.quitting;
      detach(session);
      if (required) queueMicrotask(() => open().catch(error => report(error, session)));
    });
    subscribed = true;
  }
  async function open() {
    if (state.finishedAt && host.openEmbedded) return host.openEmbedded();
    subscribe();
    if (session) { if (session.embedded) await publish(session); else await request('open', model(session)); return; }
    const required = !state.finishedAt;
    // ⚠⚠ 2026-10-14（用户定：教程要重做）：这里原来还挂着一份教程进度
    //     tutorial: root.V7Tutorial?.playback({ … state.tutorialVersion / state.tutorialIndex … })
    //   —— 教程整块删了，这份 run.tutorial 也跟着删。
    //   ⇒ 连带效果：首启不再有"必须看完教程"这一步，剩下的必修项只有【同意条款】。
    //     canFinish / close / action 里那三处 run.tutorial 闸门也一起摘了
    //     （不摘的话 run.tutorial 是 undefined，`.snapshot()` 会直接抛，向导卡死）。
    //   ⚠ state.tutorialVersion / tutorialIndex / tutorialCompletedAt 这几个存档字段
    //     【保留不动】—— 老用户的存档里可能已经有它们，删字段会让 write() 丢数据；
    //     反正没人读了。重做教程时正好接着用（清单见 docs/217）。
    const run = { id: 'setup-' + Date.now() + '-' + (++serial), required, busy: true, terms: false, timer: null, nativeOpened: false, controller:new AbortController() };
    session = run;
    document.documentElement.classList.add('setup-window-open');
    if (required) { document.documentElement.classList.add('setup-required'); document.body.inert = true; }
    try {
      await request('open', model(run));
      if (!active(run)) return;
      run.nativeOpened = true;
      await detect(run); if (!active(run)) return;
      await refresh(run); if (!active(run)) return;
      run.busy = false; await publish(run);
      if (active(run)) run.timer = setInterval(() => {
        // ⚠ 2026-10-14：这里原来有一支"教程没看完就反复 publish 催"的分支
        //   （`if (run.required && !run.tutorial?.snapshot().complete) publish(run)`）。
        //   教程删了 ⇒ 那一支整个去掉，只留下面按 3 秒刷新桥接状态这一支。
        //   ⚠ 不删的话 `.snapshot()` 会抛，而且是在 setInterval 里抛 —— 每 500ms 一次，
        //     报错刷屏但界面看着还在，属于最难查的那种坏法。
        if (Date.now() - (run.lastRefresh || 0) >= 3000) { run.lastRefresh = Date.now(); refresh(run); }
      }, 500);
    } catch (error) { await report(error, run); }
  }
  function mount(container, options) {
    if (!container) return () => {};
    const settings = options || {};
    if (!state.finishedAt) { container.textContent = '请先完成首次使用设置。'; open().catch(error => report(error, session)); return () => {}; }
    let cancelled = false, mountedRun = null;
    const closing = close();
    const run = { id: 'setup-' + Date.now() + '-' + (++serial), required: false, embedded: true, busy: true, terms: false, timer: null, controller: new AbortController() };
      mountedRun = run; session = run;
      const surface = document.createElement('div'); surface.className = 'v7-setup v7-setup-embedded'; container.replaceChildren(surface);
      run.renderer = root.V7SetupRenderer.create(surface, {embedded:true, step: settings.section === 'assistant' ? 3 : settings.section === 'terms' ? 0 : 1, send: action});
    (async () => {
      await closing; if (cancelled || !active(run)) return;
      await request('attach',model(run)); if (!active(run) || cancelled) return;
      await publish(run); await detect(run); await refresh(run); if (!active(run)) return;
      run.busy = false; await publish(run);
      run.timer = setInterval(() => { if (!container.isConnected) { close().catch(error => report(error)); return; } refresh(run); },3000);
    })().catch(error => report(error, mountedRun));
    return () => { cancelled = true; if (mountedRun && active(mountedRun)) close().catch(error => report(error)); };
  }
  async function boot() {
    if (!state.finishedAt && host.autoOpen !== false) await open();
    if (state.autoLaunch !== false && state.photoshopPath && root.V7FirstRun?.isComplete()) {
      try { await detect(session); const selected = current(); if (selected) { const info = await call('inspect', selected); if (!info.running) await call('launch', selected); } }
      catch (error) { await report(error, session); }
    }
  }
  root.addEventListener('wheelchair:storage-context', () => { close().catch(error => report(error)); });
  root.V7Setup = { configure: options => { host = options || {}; }, open, close, boot, mount, isOpen: () => !!session && !session.embedded, isRequired: () => !state.finishedAt, isBlocking: () => !state.finishedAt && (host.autoOpen !== false || !!session?.required), state: () => ({ ...state, bridgeReady: ready }) };
})(window);
