/* 夏三六 · 中间人（2026-10-17）
 *
 * 写给：以后接手 Agent 的人。依据 docs/231。
 * 界面（主卡 / 二级大卡 / 悬浮框）只跟这一层说话，不直接碰 V7AssistantPanel。
 * ⭐ 第一批：背后是现有的助手（assistant-panel.js + assistant-runtime.js，三种接口 + 调工具循环）。
 *   以后换成 Deep Agents 后台进程时，只换这一层背后那一头，界面不用重做。
 *
 * 任务状态只有四种，都是从真发生的事推出来的，不编进度：
 *   idle    空闲
 *   running 在干（发出去了，还没回来；step = 助手报的当前动作）
 *   replied 回话了（这一轮结束，等用户看 / 回话；task.ask 有值 = 它用 ask_user 停下来问你，带选项）
 *   failed  出错（error = 原因，原样给用户看）
 * 一次只干一个任务；在干时再交的活排进 queue，干完自动接下一个（10-17 晚用户定）。
 * 进程清单（activity：每个工具调用 / 中途说的话 / 全自动替你点的同意）和计划（plan：大脑用 task_plan 写的）从旧助手的状态里转过来，不编。
 *
 * 存的东西（按账号分开，换账号重新读）：
 *   starts  主卡「直接开工」按钮：{id,label,prompt,scope}，prompt 里的「【范围】」按 scope 换成文字
 *   quick   悬浮框快捷指令：字符串数组
 *   prefs   工作方式：mode(each|once|auto) care(fast|normal|careful) fallback(ask|auto) reasoning(''|low|medium|high)
 *   probe   上一次能力自测结果（按模型名记）
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7AgentService = api.create(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SCOPES = { all: '所有打开的图', current: '当前这张图' };
  const DEFAULT_STARTS = [
    { id: 'bg', label: '去背景杂物', scope: 'all', prompt: '把【范围】里背景上的杂物去掉（地上的垃圾、电线、不该出现的东西）。人身上的东西和角色道具不动，拿不准的列出来问我。' },
    { id: 'body', label: '去身上杂物', scope: 'all', prompt: '把【范围】里人身上的杂物去掉（别针、多余的发卡、线头、标签）。角色本身的发饰和道具不动，拿不准的列出来问我。' },
    { id: 'face', label: '修脸', scope: 'current', prompt: '帮【范围】里的人修脸：去瑕疵、匀肤色。五官、妆容和纹路不动，先告诉我打算怎么改。' },
    { id: 'shape', label: '修身材', scope: 'current', prompt: '帮【范围】里的人修身材，幅度自然。先告诉我打算改哪里，再动手。' }
  ];
  const DEFAULT_QUICK = ['去掉选区里的杂物', '这张图去路人', '检查刚贴回的', '写一条开源模型提示词'];
  const DEFAULT_PREFS = { mode: 'each', care: 'normal', fallback: 'ask', reasoning: '' };
  const LIMITS = { starts: 8, quick: 12, label: 12, prompt: 600, quickText: 60 };
  const clone = v => JSON.parse(JSON.stringify(v));
  const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

  function sanitizeStarts(rows) {
    if (!Array.isArray(rows)) return clone(DEFAULT_STARTS);
    const out = [], ids = new Set();
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const label = clean(r.label, LIMITS.label), prompt = String(r.prompt == null ? '' : r.prompt).trim().slice(0, LIMITS.prompt);
      if (!label || !prompt) continue;
      let id = clean(r.id, 24).replace(/[^\w-]/g, '') || 's' + out.length;
      while (ids.has(id)) id += '_';
      ids.add(id);
      out.push({ id, label, prompt, scope: SCOPES[r.scope] ? r.scope : 'current' });
      if (out.length >= LIMITS.starts) break;
    }
    return out;
  }
  function sanitizeQuick(rows) {
    if (!Array.isArray(rows)) return clone(DEFAULT_QUICK);
    const out = [];
    for (const r of rows) { const t = clean(r, LIMITS.quickText); if (t && !out.includes(t)) out.push(t); if (out.length >= LIMITS.quick) break; }
    return out;
  }
  function sanitizePrefs(p) {
    const v = p && typeof p === 'object' ? p : {};
    return {
      mode: ['each', 'once', 'auto'].includes(v.mode) ? v.mode : DEFAULT_PREFS.mode,
      care: ['fast', 'normal', 'careful'].includes(v.care) ? v.care : DEFAULT_PREFS.care,
      fallback: ['ask', 'auto'].includes(v.fallback) ? v.fallback : DEFAULT_PREFS.fallback,
      reasoning: ['', 'low', 'medium', 'high'].includes(v.reasoning) ? v.reasoning : DEFAULT_PREFS.reasoning
    };
  }
  // 占位符用中文的「【范围】」（{范围} 在界面字体下看着像普通括号，用户会看不出来；老写法照样认）
  function startText(start) { const where = SCOPES[start.scope] || SCOPES.current; return String(start.prompt).split('【范围】').join(where).split('{范围}').join(where); }
  function excerpt(text, n) { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

  function create(root, deps) {
    deps = deps || {};
    const panel = () => deps.panel || (root && root.V7AssistantPanel) || null;
    const storage = deps.storage || (root && root.localStorage) || null;
    const keyOf = () => (root && root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.key('agent.ui.v1') : 'wheelchair.agent.ui.v1');
    const listeners = new Set();
    let saved = null, key = '', task = { state: 'idle', title: '', source: '', step: '', reply: '', error: '', at: 0 }, seq = 0, unsub = null, panelState = {};
    // ⭐ 2026-10-17 晚（用户：「我们同时只会进行这个一个任务，可以让它顺位进行」）：在干的时候再交活 → 排队，干完一个自动接下一个。
    //   夏三六在等你回答问题（ask_user）时不往下接，免得下一个任务把问题冲掉；你回答或点「收起」后再接。
    let queue = [], qseq = 0;

    function load() {
      key = keyOf(); let raw = null;
      try { raw = JSON.parse(storage && storage.getItem(key) || 'null'); } catch (_) { raw = null; }
      saved = {
        starts: sanitizeStarts(raw && raw.starts), quick: sanitizeQuick(raw && raw.quick),
        prefs: sanitizePrefs(raw && raw.prefs), probe: raw && raw.probe && typeof raw.probe === 'object' ? raw.probe : null
      };
      task = { state: 'idle', title: '', source: '', step: '', reply: '', error: '', at: 0 };
      applyPrefs();
    }
    function persist() { try { if (storage) storage.setItem(key, JSON.stringify(saved)); } catch (e) { report(e); } }
    function report(e) { try { root && root.ERR && root.ERR.report('ASSISTANT_OPERATION_FAILED', { message: String(e && e.message || e) }); } catch (_) {} }
    function ensure() { if (!saved || key !== keyOf()) load(); hook(); }
    function hook() {
      // ⚠ 旧助手的 subscribe 一订阅就【马上】回一次状态 → 回调里 emit → snapshot → ensure → 又来 hook。
      //   不先占位就会无限套娃（测试抓到过：Maximum call stack size exceeded）。
      const p = panel(); if (unsub || !p || typeof p.subscribe !== 'function') return;
      unsub = () => {};
      unsub = p.subscribe(s => { panelState = s || {}; if (task.state === 'running' && panelState.status) task.step = excerpt(panelState.status, 40); emit(); next(); }) || unsub;
    }
    function applyPrefs() {
      const p = panel(); if (!p || typeof p.applyAgentPrefs !== 'function') return;
      try { p.applyAgentPrefs(saved.prefs); } catch (e) { report(e); }
    }
    function snapshot() {
      ensure();
      const conn = panelState || {};
      return {
        task: { ...task },
        connection: { ready: !!conn.ready, model: conn.model || '', busy: !!conn.busy },
        conversations: Array.isArray(conn.conversations) ? conn.conversations : [],
        conversationId: conn.sessionId || '', conversationTitle: conn.conversationTitle || '',
        messages: Array.isArray(conn.messages) ? conn.messages : [],
        hasAttachment: !!conn.hasAttachment,
        // 进程清单：每个工具调用 / 大脑中途说的话 / 全自动替你点的同意；计划；它问你的问题
        activity: Array.isArray(conn.activity) ? conn.activity : [], plan: Array.isArray(conn.plan) ? conn.plan : [], ask: task.ask || null,
        queue: queue.map(q => ({ id: q.id, title: q.title })),
        starts: clone(saved.starts), quick: clone(saved.quick), prefs: { ...saved.prefs }, probe: saved.probe ? clone(saved.probe) : null,
        scopes: { ...SCOPES }
      };
    }
    function emit() {
      const s = snapshot();
      for (const fn of listeners) { try { fn(s); } catch (e) { report(e); } }
      try { root && root.dispatchEvent && root.dispatchEvent(new root.CustomEvent('wheelchair:agent-service', { detail: { state: s.task.state } })); } catch (_) {}
    }
    function subscribe(fn) { listeners.add(fn); try { fn(snapshot()); } catch (e) { report(e); } return () => listeners.delete(fn); }

    // 发一句话给夏三六。meta: {title, source:'main'|'dock'|'zone'}
    //   在干的时候再发 → 排队（返回 queued:true）；它在等你回答时你发的话就是回答，直接发。
    async function submit(text, meta) {
      ensure();
      const words = String(text || '').trim();
      if (!words) return { ok: false, code: 'EMPTY' };
      const p = panel(); if (!p || typeof p.submit !== 'function') { task = { ...task, state: 'failed', error: '助手没加载起来', at: Date.now() }; emit(); return { ok: false, code: 'ASSISTANT_UNAVAILABLE' }; }
      const m = meta || {};
      // 没连上大脑就当场说清楚，不发出去：旧助手发之前会先走「首次使用向导」等人，
      //   任务就会卡在「在干」，状态行却写着「尚未连接」—— 自相矛盾，正是要防的「假装在干」（实跑抓到的）。
      if (!panelState.ready) {
        task = { state: 'failed', title: excerpt(m.title || words, 20), source: m.source || 'zone', step: '', reply: '', error: '还没连上大脑：先去二级「模型连接」填服务商和 Key，点「测试填写的模型」通过后再发。', at: Date.now() };
        emit(); return { ok: false, code: 'ASSISTANT_NOT_VERIFIED' };
      }
      if (task.state === 'running' || panelState.busy) {
        if (queue.length >= 10) return { ok: false, code: 'QUEUE_FULL', message: '已经排了 10 个任务，等前面的做完再交' };
        queue.push({ id: ++qseq, text: words, title: excerpt(m.title || words, 20), meta: m });
        emit(); return { ok: true, queued: true, position: queue.length };
      }
      return run(words, m);
    }
    async function run(words, m) {
      const p = panel(), mine = ++seq;
      task = { state: 'running', title: excerpt(m.title || words, 20), source: m.source || 'zone', step: '已发出，等夏三六回话', reply: '', error: '', ask: null, at: Date.now() };
      emit();
      try {
        const r = await p.submit(words);
        if (mine !== seq) return r;
        if (r && r.ok) task = { ...task, state: 'replied', step: '', reply: excerpt((p.getState && p.getState().lastReply) || panelState.lastReply || '', 160), ask: r.asked && r.asked.question ? { question: r.asked.question, options: (r.asked.options || []).slice(0, 6) } : null, at: Date.now() };
        else task = { ...task, state: 'idle', step: '', at: Date.now() };   // 用户在确认框点了取消：回到空闲，不算出错
        emit(); return r;
      } catch (e) {
        if (mine === seq) { task = { ...task, state: 'failed', step: '', error: excerpt(e && e.message || e, 120), at: Date.now() }; emit(); }
        return { ok: false, code: e && e.code || 'ASSISTANT_OPERATION_FAILED', message: String(e && e.message || e) };
      } finally { if (mine === seq) setTimeout(next, 0); }
    }
    // 接下一个排队的：没在干、旧助手不忙、没在等你回答
    function next() {
      if (!queue.length || task.state === 'running' || task.ask || panelState.busy || !panelState.ready) return;
      const q = queue.shift(); run(q.text, { ...q.meta, title: q.title });
    }
    function start(id) { ensure(); const s = saved.starts.find(r => r.id === id); return s ? submit(startText(s), { title: s.label, source: 'main' }) : Promise.resolve({ ok: false, code: 'NO_SUCH_START' }); }
    // 停止 = 停掉正在干的，排队的也一起清掉（不然停了马上又自己开始下一个）
    async function stop() { const p = panel(); seq++; queue = []; task = { ...task, state: 'idle', step: '', ask: null, at: Date.now() }; emit(); if (p && p.cancel) return p.cancel(); return { ok: true }; }
    function dismiss() { if (task.state === 'running') return; task = { state: 'idle', title: '', source: '', step: '', reply: '', error: '', ask: null, at: Date.now() }; emit(); setTimeout(next, 0); }
    // 回答它的问题（点选项按钮）：就是发一句话
    function answer(text) { const t = task; return submit(text, { title: t.title, source: t.source || 'main' }); }
    function unqueue(id) { queue = queue.filter(q => q.id !== Number(id)); emit(); }

    function setStarts(rows) { ensure(); saved.starts = sanitizeStarts(rows); persist(); emit(); return clone(saved.starts); }
    function resetStarts() { return setStarts(clone(DEFAULT_STARTS)); }
    function setQuick(rows) { ensure(); saved.quick = sanitizeQuick(rows); persist(); emit(); return clone(saved.quick); }
    function addQuick(text) { ensure(); return setQuick(saved.quick.concat([text])); }
    function setPrefs(patch) { ensure(); saved.prefs = sanitizePrefs({ ...saved.prefs, ...(patch || {}) }); persist(); applyPrefs(); emit(); return { ...saved.prefs }; }
    async function probe() {
      const p = panel(); if (!p || typeof p.probeCapabilities !== 'function') return { ok: false, code: 'ASSISTANT_UNAVAILABLE' };
      const r = await p.probeCapabilities();
      if (r && r.ok) { ensure(); saved.probe = r.result; persist(); emit(); }
      return r;
    }

    if (root && root.addEventListener) {
      root.addEventListener('wheelchair:storage-context', () => { saved = null; seq++; queue = []; ensure(); emit(); });
      root.addEventListener('wheelchair:assistant-state', () => { if (listeners.size) emit(); });
    }
    return { subscribe, snapshot, submit, start, stop, dismiss, answer, unqueue, setStarts, resetStarts, setQuick, addQuick, setPrefs, probe, startText,
      open: section => { const p = panel(); if (p && p.open) p.open(section || 'chat'); },
      newConversation: () => panel() && panel().newConversation(), switchConversation: id => panel() && panel().switchConversation(id),
      renameConversation: t => panel() && panel().renameConversation(t), deleteConversation: () => panel() && panel().deleteConversation(),
      capture: () => panel() && panel().captureCanvas ? panel().captureCanvas() : Promise.resolve({ ok: false, code: 'CAPTURE_UNAVAILABLE' }) };
  }

  return { create, sanitizeStarts, sanitizeQuick, sanitizePrefs, startText, DEFAULT_STARTS, DEFAULT_QUICK, DEFAULT_PREFS, SCOPES };
});
