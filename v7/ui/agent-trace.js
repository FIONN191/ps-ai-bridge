/* 夏三六 · 黑匣子（2026-10-17 夜）
 *
 * 写给：以后调夏三六提示词 / 规则的人（主要是开发这边的 AI）。用户原话：
 *   「你现在要加一个东西，能够直接读取这个助手的提示词和调用工具的状态，然后来更针对性的做优化和提示词优化，然后看看它卡在哪了，然后来优化规则……
 *     就是你要能看它调度哪个工具，等了多久，它现在的状态是什么样子的」
 *
 * 记什么（一件事一行 JSON，写进磁盘：开发版 <项目>/logs/agent-trace/日期.jsonl，正式版 %LOCALAPPDATA%\修图轮椅\agent-trace\日期.jsonl）：
 *   system      发给大脑的系统提示词全文（同一份只记一次，按指纹认）
 *   turn-start  一轮开始：用户说的话、模型、接口、工作方式、交给它的工具名单、提示词指纹
 *   round-start / round-end  每次请求大脑：第几圈、带了几条消息多少字；回了什么话、要调哪些工具（含参数）、用了多少 token、花了多久
 *   tool-start / tool-end    每个工具：参数、结果（截短，不含图片）、成没成、花了多久
 *   note        界面上发生的事（全自动替你点了同意、停止…）
 *   turn-end    一轮结束：怎么结束的（回话 / 问你 / 停止 / 圈数到顶 / 出错）、转了几圈、总共多久
 * 卡住时最后一行就是「tool-start 某工具」没有对应的 end —— live() 直接算出卡在哪、卡了几秒。
 * ⚠ 密钥：进来的内容都已经过大脑那边的 scrub（去掉 Key）；这里再截短。图片不记。
 * 读法：node scripts/agent-trace-report.cjs（汇总：每轮几圈、每个工具几次多久、最慢的、失败的、重复调用、卡住的）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7AgentTrace = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const MAX = { text: 4000, args: 4000, result: 6000, system: 20000 };
  const KEEP_TURNS = 30;

  function cut(value, n) {
    const s = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch (_) { return String(value); } })();
    return s == null ? '' : (s.length > n ? s.slice(0, n) + '…（截短，原长 ' + s.length + '）' : s);
  }
  // 提示词指纹：同一份提示词只记一次全文（每轮都重发，全记会很大）
  function hash(text) {
    let h = 5381; const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36) + '-' + s.length;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function day(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  // sink(day, line)：把一行写进磁盘（宿主给；没有就只记在内存里）。context()：当前工作方式等（宿主给）。
  function recorder(options) {
    const o = options || {}, now = o.now || (() => Date.now());
    const turns = [], seenSystem = new Set();
    let current = null, seq = 0, chain = Promise.resolve(), sinkError = '';
    function write(event) {
      const t = now(), row = { v: 1, t, at: new Date(t).toISOString(), ...event };
      if (current && !row.turn) row.turn = current.id;
      if (current) { current.events.push(row); if (current.events.length > 2000) current.events.splice(0, current.events.length - 2000); }
      if (typeof o.sink === 'function') {
        let line; try { line = JSON.stringify(row); } catch (_) { return row; }
        chain = chain.then(() => o.sink(day(t), line)).then(r => { if (r && r.ok === false) sinkError = String(r.error || '写不进去'); else sinkError = ''; }, e => { sinkError = String(e && e.message || e); });
      }
      return row;
    }
    const api = {
      begin(info) {
        const i = info || {}, t = now();
        if (current && !current.ended) api.end({ reason: 'superseded' });
        current = { id: 'T' + t.toString(36) + '-' + (++seq), startedAt: t, events: [], rounds: 0, tools: 0, state: 'starting', since: t, ended: false };
        turns.push(current); if (turns.length > KEEP_TURNS) turns.shift();
        const sh = i.system ? hash(i.system) : '';
        if (sh && !seenSystem.has(sh)) { seenSystem.add(sh); write({ type: 'system', hash: sh, chars: String(i.system).length, text: cut(i.system, MAX.system) }); }
        let ctx = {}; try { ctx = o.context ? (o.context() || {}) : {}; } catch (_) {}
        write({ type: 'turn-start', user: cut(i.user, MAX.text), hasImage: !!i.hasImage, model: i.model || '', protocol: i.protocol || '', maxRounds: i.maxRounds, systemHash: sh, tools: Array.isArray(i.tools) ? i.tools : [], ...ctx });
        return current.id;
      },
      round(info) {
        if (!current) return;
        const i = info || {}; current.rounds = Math.max(current.rounds, (i.round || 0) + 1);
        current.state = 'waiting-model'; current.since = now(); current.detail = '第 ' + ((i.round || 0) + 1) + ' 圈';
        write({ type: 'round-start', round: i.round, messages: i.messages, chars: i.chars });
      },
      roundEnd(info) {
        if (!current) return;
        const i = info || {};
        current.state = 'thinking'; current.since = now(); current.detail = '';
        write({ type: 'round-end', round: i.round, ms: i.ms, ...(i.error ? { error: cut(i.error, 600), code: i.code || '' } : {}),
          text: cut(i.text || '', MAX.text), calls: (i.calls || []).map(c => ({ name: c.name, args: cut(c.arguments || c.args || {}, MAX.args) })),
          ...(i.usage ? { usage: i.usage } : {}) });
      },
      toolStart(info) {
        if (!current) return;
        const i = info || {}; current.tools++;
        current.running = current.running || new Map();
        current.running.set(String(i.id || i.name), { name: i.name, since: now() });
        current.state = 'running-tool'; current.since = now(); current.detail = i.name;
        write({ type: 'tool-start', id: i.id || '', name: i.name, parallel: !!i.parallel, args: cut(i.args || {}, MAX.args) });
      },
      toolEnd(info) {
        if (!current) return;
        const i = info || {}, r = i.result;
        if (current.running) current.running.delete(String(i.id || i.name));
        if (!current.running || !current.running.size) { current.state = 'thinking'; current.since = now(); current.detail = ''; }
        const failed = !!(r && typeof r === 'object' && r.ok === false);
        write({ type: 'tool-end', id: i.id || '', name: i.name, ms: i.ms, ok: !failed, ...(failed ? { code: r.code || '', message: cut(r.message || '', 600) } : {}), result: cut(r, MAX.result) });
      },
      note(text, extra) { write({ type: 'note', text: cut(text, 1000), ...(extra || {}) }); },
      end(info) {
        if (!current || current.ended) return;
        const i = info || {}, t = now();
        current.ended = true; current.state = 'idle'; current.since = t; current.detail = '';
        write({ type: 'turn-end', reason: i.reason || 'done', ms: t - current.startedAt, rounds: current.rounds, tools: current.tools, ...(i.error ? { error: cut(i.error, 600), code: i.code || '' } : {}) });
      },
      // 现在卡在哪：在等大脑 / 在跑哪个工具（同时跑好几个就都列出来）/ 空闲；各自多少秒了
      live() {
        const t = now();
        if (!current || current.ended) return { state: 'idle', sinkError };
        const running = current.running ? [...current.running.values()].map(r => ({ tool: r.name, seconds: Math.round((t - r.since) / 1000) })) : [];
        return { turn: current.id, state: current.state, detail: current.detail || '', seconds: Math.round((t - current.since) / 1000), turnSeconds: Math.round((t - current.startedAt) / 1000), rounds: current.rounds, tools: current.tools, running, sinkError };
      },
      recent(n) { return turns.slice(-(n || 5)).map(x => ({ id: x.id, startedAt: x.startedAt, ended: x.ended, rounds: x.rounds, tools: x.tools, events: x.events.slice() })); },
      flush() { return chain; },
      sinkError: () => sinkError
    };
    return api;
  }

  return { recorder, hash, day, cut, MAX };
});
