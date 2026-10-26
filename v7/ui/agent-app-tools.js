/* 夏三六 · 软件接口（2026-10-17 夜）
 *
 * 写给：以后接手 Agent 的人。用户原话：「你现在没有把我们软件里面的这个接口和内容以及别的东西暴露给我们的Agent呀，这个Agent的完成度还是很低哦」
 * agent-tools.js 管 PS / 引擎 / 上网；这个文件管【软件自己】：软件地图和现场、设置、账号积分、生图模型和参考图、
 * 任务栏、记录与恢复、工具与功能（抠像 / 人体解析 / AI 痕迹检测 / 示波器）、网络体检。
 *
 *   · 全部走软件里现成的接口：ui.html 在 V7AssistantPanel.configure({app}) 里接线（agentAppHost 那段），这里不另写一套业务。
 *   · 设置只认设置页上真有的项（ui.html 的 settingControl 每画一项就登记一次），Key / 密码类一律不读不写，后端地址不准改。
 *   · 改设置、改生图设置：前后的值都回给大脑，并记进对话（note），用户对着就能改回去。
 *   · 动 Photoshop 的（传回、抠像、人体解析、痕迹检测）一个个跑；只读的标 parallel 可以同时跑。
 * ⚠ 只用 tests/agent-app-tools.test.js 的假宿主测过；真大脑会不会好好用、真软件里每条接线对不对，要用户实测。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.V7AgentAppToolsCore = api;
  root.V7AgentAppTools = { build: host => api.createTools(host || {}) };
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const error = (code, message) => Object.assign(new Error(message), { code });
  const msg = e => String(e && e.message || e).slice(0, 300);
  const excerpt = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const str = { type: 'string' }, int = { type: 'integer' }, bool = { type: 'boolean' };
  const obj = (properties, required) => ({ type: 'object', properties, required: required || [], additionalProperties: false });
  const TOOL_KINDS = ['matting', 'segment'];
  const TERMINAL = ['done', 'failed', 'cancelled'];

  // 每块软件功能，大脑用哪几个工具去碰（app_map 一起回给它）
  const HOW_TO = {
    '软件现场（版本、登录、PS 和引擎连没连、最近的报错和日志、公告）': 'app_status',
    '把界面切到某张卡、某一节，或者打开某个工具让用户接着操作': 'app_open',
    '设置（设置页上的每一项）': 'settings_read 看 / settings_write 改',
    '账号、积分余额、积分流水': 'account_info',
    '用哪家生图、哪个模型、尺寸比例张数、提示词、预设、开源模型模式、价目表': 'generation_options 看 / generation_setup 改',
    '这次生成带的参考图': 'generation_refs',
    '真的出图（要花钱）': 'generation_prepare → generation_execute',
    '任务栏（每个任务的状态、出错原因、传回 PS、取消）': 'tasks_list 看 / task_action 做',
    '记录与恢复（历史任务、检查点）': 'records_search 查 / records_action 做',
    '抠像、人体解析': 'tool_run',
    'AI 修图痕迹检测': 'trace_check',
    '量画面的亮度、过曝、偏色、饱和度（示波器）': 'image_stats',
    '网络连不上、生图服务通不通': 'network_check',
    '预设': 'preset_list / preset_read / preset_import',
    '其余要在界面上调参数的工具（DLSS、校色、调色、场景、半合成、灯光、3D 镜头、辉光、指哪抠哪、分块、批处理…）': 'app_open 打开那个工具，告诉用户在哪调'
  };

  // ── 设置 ──────────────────────────────────────────────
  // meta：[{key,label,type,options:[[value,label]],range:{min,max,step,suffix}}]（ui.html settingControl 登记的）
  function settingRows(meta, values, sections) {
    const v = values || {};
    return (Array.isArray(meta) ? meta : []).filter(m => m && m.key && m.type !== 'password').map(m => {
      const row = { key: m.key, label: m.label || m.key, type: m.type || 'text', value: v[m.key] == null ? '' : v[m.key] };
      if (Array.isArray(m.options)) row.options = m.options.map(o => ({ value: String(o[0]), label: String(o[1] == null ? o[0] : o[1]) }));
      if (m.range) row.range = { min: m.range.min, max: m.range.max, step: m.range.step, suffix: m.range.suffix || '' };
      if (sections && sections[m.key]) row.section = sections[m.key];
      return row;
    });
  }
  // 大脑给的值 → 设置里存的值。⚠ 跟设置页的读法一致（settingsReadFields）：开关存布尔，其余存字符串。
  function checkSetting(m, key, value, blocked) {
    if (blocked && blocked.has(key)) throw error('SETTING_BLOCKED', key + '：这一项不让夏三六改（Key、密码、后端地址这类）');
    if (!m) throw error('SETTING_UNKNOWN', key + '：设置里没有这一项（只认 settings_read 列出来的 key）');
    if (m.type === 'password') throw error('SETTING_BLOCKED', key + '：Key / 密码类不让夏三六碰');
    if (m.type === 'checkbox') {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw error('SETTING_VALUE_INVALID', key + '（' + m.label + '）是开关，只能填 true / false');
    }
    if (m.type === 'select') {
      const opts = (m.options || []).map(o => String(o[0]));
      if (!opts.includes(String(value))) throw error('SETTING_VALUE_INVALID', key + '（' + m.label + '）只能选这几个：' + opts.join(' / '));
      return String(value);
    }
    if (m.type === 'number') {
      const n = Number(value);
      if (value === '' || value == null || !Number.isFinite(n)) throw error('SETTING_VALUE_INVALID', key + '（' + m.label + '）要填数字');
      if (m.range && (n < m.range.min || n > m.range.max)) throw error('SETTING_VALUE_INVALID', key + '（' + m.label + '）只能在 ' + m.range.min + '～' + m.range.max + ' 之间');
      return String(n);
    }
    if (m.type === 'color') {
      const s = String(value == null ? '' : value).trim();
      if (s && !/^#[0-9a-f]{6}$/i.test(s)) throw error('SETTING_VALUE_INVALID', key + '（' + m.label + '）要填 #rrggbb 这种颜色，空着 = 用默认');
      return s.toLowerCase();
    }
    const s = String(value == null ? '' : value).trim();
    if (s.length > 500) throw error('SETTING_VALUE_INVALID', key + '：太长了');
    if (m.type === 'url' && s && !/^https?:\/\/[^\s]+$/i.test(s)) throw error('SETTING_VALUE_INVALID', key + '（' + m.label + '）要以 http:// 或 https:// 开头');
    return s;
  }
  const sameValue = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);

  // ── 任务栏 ────────────────────────────────────────────
  function summarizeTask(t, transferable) {
    const shots = Array.isArray(t && t.shots) ? t.shots : [];
    const layers = t && t.psLayerByShot ? Object.keys(t.psLayerByShot).length : 0;
    const row = {
      taskId: t.id, kind: t.kind || 'generation', title: excerpt(t.label || t.presetTitle || '', 40), status: t.status || '',
      progress: Number(t.pct) || 0, note: excerpt(t.sub || '', 80),
      shots: { total: shots.length, done: shots.filter(s => s && s.done && !s.error).length, failed: shots.filter(s => s && s.error).length },
      canReturn: Number(transferable) || 0, returnedToPs: layers
    };
    if (t.error || (t.errorInfo && t.errorInfo.message)) row.error = excerpt(t.error || t.errorInfo.message, 160);
    if (t.stage) row.stage = t.stage;
    if (t.kind === 'generation' || !t.kind) Object.assign(row, { provider: t.provider || '', model: t.model || '', size: t.size || '', aspectRatio: t.aspectRatio || '', prompt: excerpt(t.prompt || '', 100) });
    if (t.sourceDocName) row.document = t.sourceDocName;
    if (t.startedAt) row.startedAt = new Date(t.startedAt).toISOString();
    return row;
  }

  // ── 记录与恢复 ────────────────────────────────────────
  // ⚠ 只用 records-core 真导出的函数（taskStatus / checkpointTime 它没导出，第一版就栽在这）
  function summarizeRecord(row, core, inTaskbar) {
    const m = row.meta || {};
    const out = { project: row.project, runId: row.runId, document: core.projectDocName(m, row.project), title: core.taskLabel(m), kind: m.kind || 'generation',
      status: String(m.status || ''), when: core.whenLabel(core.startedAt(m)), shots: core.shotCounts(m), inTaskbar: !!inTaskbar };
    if (m.model) out.model = m.model;
    if (m.presetTitle) out.preset = m.presetTitle;
    if (m.prompt) out.prompt = excerpt(m.prompt, 120);
    try { out.cost = core.formatAmount(core.taskCost(m)); } catch (_) {}
    return out;
  }

  // ── 示波器的数 → 大白话能用的几个指标 ─────────────────
  // result.histogram = [R,G,B,亮度] 各 256 档；vectors = 色度 256×256（行 = 255-Cr，列 = Cb）
  function scopeStats(result) {
    const h = result && result.histogram;
    if (!h || h.length < 4) throw error('SCOPES_EMPTY', '示波器没给出数据');
    const count = h[3].reduce((a, b) => a + b, 0);
    if (!count) throw error('SCOPES_EMPTY', '画面里没有可量的像素（全透明？）');
    const mean = arr => arr.reduce((s, n, i) => s + n * i, 0) / count;
    const pct = (arr, from, to) => { let n = 0; for (let i = from; i <= to; i++) n += arr[i]; return Math.round(n / count * 1000) / 10; };
    const quantile = (arr, q) => { let acc = 0; const target = q * count; for (let i = 0; i < 256; i++) { acc += arr[i]; if (acc >= target) return i; } return 255; };
    const out = {
      pixels: count, size: result.width && result.height ? result.width + '×' + result.height : '',
      brightness: { mean: Math.round(mean(h[3])), median: quantile(h[3], 0.5), darkest1pct: quantile(h[3], 0.01), brightest1pct: quantile(h[3], 0.99) },
      clippedShadowsPercent: pct(h[3], 0, 2), clippedHighlightsPercent: pct(h[3], 253, 255),
      channelMean: { r: Math.round(mean(h[0])), g: Math.round(mean(h[1])), b: Math.round(mean(h[2])) },
      channelClippedPercent: { r: pct(h[0], 253, 255), g: pct(h[1], 253, 255), b: pct(h[2], 253, 255) }
    };
    const v = result.vectors;
    if (v && v.length === 65536) {
      let n = 0, sumCb = 0, sumCr = 0, sumChroma = 0;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const c = v[y * 256 + x]; if (!c) continue;
        const cb = x - 128, cr = (255 - y) - 128;
        n += c; sumCb += cb * c; sumCr += cr * c; sumChroma += Math.sqrt(cb * cb + cr * cr) * c;
      }
      if (n) {
        const cb = sumCb / n, cr = sumCr / n;
        const cast = Math.abs(cb) < 3 && Math.abs(cr) < 3 ? '基本不偏色' : (cr > 0 ? (cb > 0 ? '偏品红' : '偏暖（偏红黄）') : (cb > 0 ? '偏冷（偏蓝）' : '偏绿'));
        out.color = { averageSaturation: Math.round(sumChroma / n), castCb: Math.round(cb * 10) / 10, castCr: Math.round(cr * 10) / 10, cast };
      }
    }
    out.howToRead = '亮度 0～255；clipped 是死黑 / 死白占画面的百分比；averageSaturation 是平均饱和度（0 = 灰，越大越艳）；castCb / castCr 偏离 0 越多越偏色。这些是量出来的数，好不好看还要结合 canvas_look 看图判断';
    return out;
  }

  // ── AI 痕迹检测的结果 → 只挑大脑用得上的 ─────────────
  function summarizeTrace(s) {
    const st = s || {};
    const candidates = (Array.isArray(st.candidates) ? st.candidates : []).slice(0, 40).map(c => {
      const row = { id: c.id, index: c.index };
      for (const k of ['region', 'score', 'confidence', 'kind', 'label', 'reason']) if (c[k] != null) row[k] = c[k];
      if (c.layerId != null) row.hasLayer = true;
      return row;
    });
    const m = st.manifest || {};
    return { phase: st.phase || '', message: excerpt(st.message || '', 160), busy: !!st.busy, document: m.docName || '', annotationGroupId: m.groupId, count: Array.isArray(st.candidates) ? st.candidates.length : 0, candidates };
  }

  function createTools(host) {
    const need = (v, what) => { if (!v) throw error('APP_API_UNAVAILABLE', '这个版本的软件没接上「' + what + '」接口'); return v; };
    const tool = (name, short, description, parameters, run, extra) => ({ name, short, label: short, description, parameters, run, ...(extra || {}) });
    const note = text => { try { if (host.note) host.note(text); } catch (_) {} };
    const settingMeta = () => { const s = need(host.settings, '设置'); return new Map((s.meta() || []).map(m => [m.key, m])); };
    async function findTask(id) {
      const t = need(host.tasks, '任务栏'), task = t.get(id);
      if (!task) throw error('TASK_NOT_FOUND', '任务栏里没有 taskId=' + id + ' 的任务（先 tasks_list 看）');
      return task;
    }
    async function findRecord(a) {
      const r = need(host.records, '记录与恢复'), data = await r.load();
      const row = (data.rows || []).find(x => String(x.runId) === String(a.runId) && (!a.project || String(x.project) === String(a.project)));
      if (!row) throw error('RECORD_NOT_FOUND', '记录里没有 runId=' + a.runId + '（先 records_search 查）');
      return { r, row, data };
    }

    return [
      // ═══ 认识软件 ═══
      tool('app_map', '看软件地图', '软件里有什么：每张卡（和卡里的小节）、设置的全部小节、「工具与功能」里每个工具是干啥的，以及每块功能你用哪个工具去碰。不知道软件有没有某个功能、在哪，先看这个，不准凭印象编。',
        obj({}), () => {
          const m = need(host.map, '软件地图')();
          return { cards: m.cards || [], settingsSections: m.settingsSections || [], tools: m.tools || [], howTo: HOW_TO };
        }, { parallel: true }),
      tool('app_status', '看软件现场', '软件现场：版本、连的后台、登没登录、PS 联动插件连没连 / 版本、本机引擎、开源模型模式、任务栏几个任务、最近的报错和警告（同样的合并计次）、公告。logs 给数字就顺带拿生成日志最后几条。用户说「报错了」「怎么不动了」先看这个。',
        obj({ logs: { type: 'integer', minimum: 1, maximum: 80 } }), a => {
          const out = { about: need(host.about, '软件现场')() };
          if (host.notices) { try { out.notices = host.notices(); } catch (e) { out.notices = { error: msg(e) }; } }
          if (a.logs && host.logs) out.logs = host.logs(Math.min(80, Math.max(1, Number(a.logs) || 20)));
          return out;
        }, { parallel: true }),
      tool('app_open', '打开界面', '把软件界面切到某张卡的某一节（card + section，名字从 app_map 里拿），或者打开「工具与功能」里的某个工具（tool = app_map 里 tools 的 key）。给用户看东西、或者要用户在界面上调参数时用。',
        obj({ card: str, section: str, tool: str }), async a => {
          const m = need(host.map, '软件地图')();
          if (a.tool) {
            if (!(m.tools || []).some(t => t.key === a.tool)) throw error('APP_TOOL_UNKNOWN', '没有这个工具：' + a.tool + '（看 app_map 的 tools）');
            await need(host.openTool, '打开工具')(a.tool);
            return { ok: true, opened: 'tool:' + a.tool };
          }
          const card = (m.cards || []).find(c => c.id === a.card);
          if (!card) throw error('APP_CARD_UNKNOWN', '没有这张卡：' + a.card + '（看 app_map 的 cards）');
          const sections = (card.id === 'settings' ? m.settingsSections : card.sections) || [];
          if (a.section && sections.length && !sections.some(s => s.id === a.section)) throw error('APP_SECTION_UNKNOWN', card.name + '里没有「' + a.section + '」这一节');
          await need(host.open, '切卡片')(card.id, a.section || '');
          return { ok: true, opened: card.id + (a.section ? '/' + a.section : '') };
        }),

      // ═══ 设置 ═══
      tool('settings_read', '读设置', '读软件设置：每一项的 key、名字、现在的值、能选哪些（options）或数值范围（range）、在设置的哪一节。query 按名字 / key 搜，keys 直接点名。Key、密码类不在这里。',
        obj({ query: str, keys: { type: 'array', items: str, maxItems: 40 } }), a => {
          const s = need(host.settings, '设置');
          let rows = settingRows(s.meta(), s.values(), s.sections ? s.sections() : null);
          if (Array.isArray(a.keys) && a.keys.length) rows = rows.filter(r => a.keys.includes(r.key));
          const q = String(a.query || '').trim().toLowerCase();
          if (q) rows = rows.filter(r => [r.key, r.label, r.section].join(' ').toLowerCase().includes(q));
          return { count: rows.length, rows: rows.slice(0, 80), ...(rows.length > 80 ? { more: '太多了，用 query 缩小' } : {}) };
        }, { parallel: true }),
      tool('settings_write', '改设置', '改软件设置。changes 里写 { key: 新值 }（key 和能填的值先用 settings_read 查）：开关填 true / false，下拉只能填 options 里的 value，数字要在 range 里。一次改几项，任何一项不合规就一项都不改。Key、密码、后端地址不让改。改完回读核对，前后的值会记进对话，用户能改回去。',
        obj({ changes: { type: 'object', description: '{ 设置 key: 新值 }', additionalProperties: true }, reason: str }, ['changes']), async a => {
          const s = need(host.settings, '设置'), meta = settingMeta(), before = s.values(), blocked = new Set(s.blocked ? s.blocked() : []);
          const entries = Object.entries(a.changes && typeof a.changes === 'object' ? a.changes : {});
          if (!entries.length) throw error('SETTING_EMPTY', 'changes 是空的');
          if (entries.length > 20) throw error('SETTING_TOO_MANY', '一次最多改 20 项');
          const plan = [], problems = [];
          for (const [key, value] of entries) {
            try { plan.push({ key, label: (meta.get(key) || {}).label || key, from: before[key], to: checkSetting(meta.get(key), key, value, blocked) }); }
            catch (e) { problems.push(e.message); }
          }
          if (problems.length) throw error('SETTING_REJECTED', '一项都没改：\n' + problems.join('\n'));
          const todo = plan.filter(p => !sameValue(p.from, p.to));
          if (todo.length) await s.apply(Object.fromEntries(todo.map(p => [p.key, p.to])));
          const after = s.values();
          const changed = todo.map(p => ({ key: p.key, label: p.label, from: p.from, to: after[p.key] }));
          const notApplied = todo.filter(p => !sameValue(after[p.key], p.to)).map(p => p.key);
          if (changed.length) note('夏三六改了设置' + (a.reason ? '（' + excerpt(a.reason, 60) + '）' : '') + '：' + changed.map(c => c.label + ' ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to)).join('；'));
          return { ok: !notApplied.length, changed, unchanged: plan.filter(p => sameValue(p.from, p.to)).map(p => p.key), ...(notApplied.length ? { code: 'SETTING_NOT_APPLIED', notApplied, message: '这几项写进去后回读不对，可能被软件改回去了' } : {}) };
        }),

      // ═══ 账号 ═══
      tool('account_info', '看账号积分', '账号：登没登录、邮箱、平台积分余额（common 通用 / banana 香蕉）。ledger=true 顺带看最近 20 条积分流水（哪天花在哪）。不含密码和令牌。',
        obj({ ledger: bool }), async a => {
          const acc = need(host.account, '账号'), st = acc.state() || {};
          if (!st.signedIn) return { ok: true, signedIn: false, hint: '没登录：积分、云备份、平台生图这些用不了。登录在设置「登录账号」那节（app_open card=settings section=account），要用户自己填密码' };
          const out = { ok: true, signedIn: true, email: st.email || '' };
          try { out.points = await acc.points(); } catch (e) { out.points = { error: msg(e) }; }
          if (a.ledger && acc.ledger) { try { out.ledger = await acc.ledger({ limit: 20 }); } catch (e) { out.ledger = { error: msg(e) }; } }
          return out;
        }, { parallel: true }),

      // ═══ 生图 ═══
      tool('generation_options', '看生图设置', '生成卡现在的设置：用哪家（provider）、连接配没配好、出图花谁的钱、当前模型和【能选的模型】、尺寸 / 比例 / 张数、提示词、当前预设、开源模型模式、参考图几张，以及阿吉价目表（美元 / 张，只是参考价）。',
        obj({}), () => {
          const g = need(host.generation, '生图设置'), st = g.state() || {};
          const out = { ...st, models: (g.models() || []).map(r => ({ id: r[0], name: r[1], ...(r[2] === 'other' ? { maybeNotImageModel: true } : {}) })) };
          if (!out.models.length) out.modelsHint = '没有可选模型：这家的连接还没配（设置「用哪家生图」填地址和 Key，要用户自己填）';
          if (g.refs) { try { const r = g.refs.state(); out.references = { preset: (r.fixed || []).length, temporary: (r.temporary || []).length, limit: r.limit, blocked: !!r.blocked, reason: r.reason || '' }; } catch (e) { out.references = { error: msg(e) }; } }
          if (host.prices) { try { const p = host.prices(); out.ajiPrices = { status: p.status, rows: (p.rows || []).slice(0, 60).map(x => ({ model: x.model, name: x.name, usdPerImage: x.price })) }; } catch (_) {} }
          return out;
        }, { parallel: true }),
      tool('generation_setup', '改生图设置', '改生成卡的设置（只改设置，不出图、不花钱）：model（只能填 generation_options 列出的 id）、size（1K / 2K / 4K，开源模型最高 2K）、aspectRatio、batch（张数）、prompt（提示词，会替换输入框里的）、presetId（换预设）、qwenMode（开源模型模式开关）。改完回读，前后的值记进对话。真要出图再走 generation_prepare。',
        obj({ model: str, size: str, aspectRatio: str, batch: int, prompt: str, presetId: str, qwenMode: bool }), async a => {
          const g = need(host.generation, '生图设置'), before = g.state() || {};
          if (typeof a.qwenMode === 'boolean' && a.qwenMode !== !!before.qwenMode) {
            if (!g.setQwen) throw error('APP_API_UNAVAILABLE', '这个版本不能切开源模型模式');
            if (!await g.setQwen(a.qwenMode)) throw error('QWEN_TOGGLE_FAILED', '开源模型模式没切成（设置还没读出来？），可以让用户在预设卡左上角点「开源模型模式」');
          }
          const mid = g.state() || {};
          const value = {};
          if (a.model != null) {
            const ids = (g.models() || []).map(r => r[0]);
            if (!ids.length) throw error('GEN_NOT_CONFIGURED', '这家的连接还没配，没有模型可选');
            if (!ids.includes(String(a.model))) throw error('GEN_MODEL_UNKNOWN', '没有这个模型：' + a.model + '。能选：' + ids.slice(0, 30).join('、'));
            value.model = String(a.model);
          }
          if (a.size != null) {
            const sizes = mid.sizes || ['1K', '2K', '4K'];
            if (!sizes.includes(String(a.size).toUpperCase())) throw error('GEN_SIZE_INVALID', '尺寸只能是：' + sizes.join(' / '));
            value.size = String(a.size).toUpperCase();
          }
          if (a.aspectRatio != null) {
            if (mid.aspectRatios && !mid.aspectRatios.includes(String(a.aspectRatio))) throw error('GEN_ASPECT_INVALID', '比例只能是：' + mid.aspectRatios.join(' / '));
            value.aspectRatio = String(a.aspectRatio);
          }
          if (a.batch != null) {
            const max = Number(mid.batchMax) || 18, n = Number(a.batch);
            if (!Number.isInteger(n) || n < 1 || n > max) throw error('GEN_BATCH_INVALID', '张数是 1～' + max + ' 的整数');
            value.batch = n;
          }
          if (a.prompt != null) value.prompt = String(a.prompt).slice(0, 8000);
          if (a.presetId != null) value.presetId = String(a.presetId);
          if (Object.keys(value).length) await g.apply(value);
          const after = g.state() || {};
          const keys = ['qwenMode', 'presetTitle', 'model', 'size', 'aspectRatio', 'batch'];
          const changed = keys.filter(k => !sameValue(before[k], after[k])).map(k => ({ key: k, from: before[k], to: after[k] }));
          if (value.prompt != null) changed.push({ key: 'prompt', to: excerpt(after.prompt, 60) });
          const notApplied = Object.keys(value).filter(k => k !== 'presetId' && k !== 'prompt' && !sameValue(value[k], after[k]));
          if (changed.length) note('夏三六改了生图设置：' + changed.map(c => c.key + (c.from !== undefined ? ' ' + JSON.stringify(c.from) + ' → ' : ' → ') + JSON.stringify(c.to)).join('；'));
          return { ok: !notApplied.length, changed, now: { provider: after.provider, model: after.model, size: after.size, aspectRatio: after.aspectRatio, batch: after.batch, preset: after.presetTitle, qwenMode: after.qwenMode }, ...(notApplied.length ? { code: 'GEN_NOT_APPLIED', notApplied, message: '这几项回读不对（可能当前预设或开源模型模式把它锁住了）' } : {}) };
        }),
      tool('generation_refs', '参考图', '这次生成带的参考图：list 看有几张（预设自带的 + 这次加的）、能不能再加；add_selection 把 Photoshop 当前选区抓成一张临时参考图；remove 删掉这次加的第 index 张（预设自带的不删，要用户在参考图卡里删）；clear 这次一张都不带（不动预设）。',
        obj({ op: { type: 'string', enum: ['list', 'add_selection', 'remove', 'clear'] }, index: int }, ['op']), async a => {
          const refs = need(need(host.generation, '生图设置').refs, '参考图');
          if (a.op === 'add_selection') await refs.addSelection();
          else if (a.op === 'remove') {
            const n = Number(a.index), list = refs.state().temporary || [];
            if (!Number.isInteger(n) || !list[n]) throw error('REF_INDEX_INVALID', '这次加的参考图只有 ' + list.length + ' 张（index 从 0 数）');
            await refs.removeTemporary(n);
          } else if (a.op === 'clear') await refs.clearAll();
          const st = refs.state();
          return { ok: true, preset: (st.fixed || []).map(r => r.name || ''), temporary: (st.temporary || []).map(r => r.name || ''), limit: st.limit, blocked: !!st.blocked, reason: st.reason || '' };
        }),

      // ═══ 任务栏 ═══
      tool('tasks_list', '看任务栏', '任务栏里的每个任务（生成、抠像、人体解析…）：状态、进度、出了几张、失败几张、出错原因、还有几张没传回 Photoshop、已经传回几张。',
        obj({}), () => {
          const t = need(host.tasks, '任务栏');
          return { tasks: (t.list() || []).slice(-30).map(x => summarizeTask(x, t.transferable ? t.transferable(x) : 0)) };
        }, { parallel: true }),
      tool('task_action', '任务操作', '对任务栏里的任务（taskId 来自 tasks_list）：return 把出好的图传回 Photoshop（indexes 指定第几张，从 0 数；不给就是全部没传回的）；cancel 取消还在跑的任务（⚠ 阿吉是发出去就扣钱，取消不退）。',
        obj({ op: { type: 'string', enum: ['return', 'cancel'] }, taskId: int, indexes: { type: 'array', items: int, maxItems: 18 } }, ['op', 'taskId']), async a => {
          const t = need(host.tasks, '任务栏'), task = await findTask(a.taskId);
          if (a.op === 'cancel') {
            if (TERMINAL.includes(task.status)) return { ok: false, code: 'TASK_ALREADY_FINISHED', message: '这个任务已经结束了（' + task.status + '），不用取消' };
            await t.cancel(task);
            return { ok: true, cancelled: a.taskId, note: '阿吉是发送即扣，已经发出去的那几张不退' };
          }
          if (!(t.transferable ? t.transferable(task) : 1)) return { ok: false, code: 'NOTHING_TO_RETURN', message: '这个任务没有可传回的图（还没出图，或者已经都传回了）' };
          const r = await t.transfer(task, Array.isArray(a.indexes) && a.indexes.length ? a.indexes : null);
          if (!r || r.ok === false) return { ok: false, code: 'TASK_RETURN_FAILED', message: msg(r && (r.error || r.message) || '传回没成功（Photoshop 没回执）') };
          const layers = r.data && Array.isArray(r.data.layerIds) ? r.data.layerIds.length : null;
          note('夏三六把任务 ' + a.taskId + ' 的图传回了 Photoshop' + (layers != null ? '（' + layers + ' 张）' : ''));
          return { ok: true, layers };
        }),

      // ═══ 记录与恢复 ═══
      tool('records_search', '查记录', '查「记录与恢复」里的历史任务：query 可以写任务名、预设名、模型、提示词里的词，也可以写日期（今天 / 昨天 / 09-28），空着就是最近的。checkpoints=true 顺带列检查点（自动存的整张画布）。',
        obj({ query: str, limit: { type: 'integer', minimum: 1, maximum: 50 }, checkpoints: bool }), async a => {
          const r = need(host.records, '记录与恢复'), core = need(r.core, '记录核心'), data = await r.load();
          const all = core.normalizeRows(data.rows || []);
          const rows = String(a.query || '').trim() ? core.searchRows(all, a.query) : all.slice().sort((x, y) => core.startedAt(y.meta) - core.startedAt(x.meta));
          const limit = Math.min(50, Math.max(1, Number(a.limit) || 15));
          const out = { total: rows.length, records: rows.slice(0, limit).map(row => summarizeRecord(row, core, r.inTaskbar ? r.inTaskbar(row) : false)) };
          if (a.checkpoints) out.checkpoints = core.normalizeCheckpoints(data.checkpoints || []).slice(0, 30).map(cp => ({ id: cp.raw.cacheRef, document: cp.raw.docName || core.projectLabel(cp.project), when: core.whenLabel(cp.time) }));
          return out;
        }, { parallel: true }),
      tool('records_action', '记录操作', '对一条历史记录（runId / project 来自 records_search）：restore 恢复到任务栏；return 把它的图传回 Photoshop（indexes 第几张，从 0 数；不给就全部）；reuse_prompt 把它的提示词填回生成卡；open_checkpoint 在 Photoshop 里打开一个检查点（checkpoint = records_search 列出的检查点 id）。',
        obj({ op: { type: 'string', enum: ['restore', 'return', 'reuse_prompt', 'open_checkpoint'] }, runId: str, project: str, indexes: { type: 'array', items: int, maxItems: 18 }, checkpoint: str }, ['op']), async a => {
          if (a.op === 'open_checkpoint') {
            const r = need(host.records, '记录与恢复'), data = await r.load();
            const cp = (data.checkpoints || []).find(c => c.cacheRef === a.checkpoint);
            if (!cp) throw error('CHECKPOINT_NOT_FOUND', '没有这个检查点（records_search 加 checkpoints=true 查）');
            await r.openCheckpoint(cp);
            return { ok: true, opened: a.checkpoint };
          }
          const { r, row } = await findRecord(a);
          if (a.op === 'restore') return r.restore(row);
          if (a.op === 'reuse_prompt') {
            if (!String(row.meta && row.meta.prompt || '').trim()) return { ok: false, code: 'RECORD_NO_PROMPT', message: '这条记录没有提示词（工具类任务）' };
            await r.reusePrompt(row.meta);
            note('夏三六把记录「' + excerpt(row.meta.label || row.meta.presetTitle || row.runId, 30) + '」的提示词填回了生成卡');
            return { ok: true };
          }
          const total = Array.isArray(row.meta && row.meta.shots) ? row.meta.shots.length : 0;
          const indexes = Array.isArray(a.indexes) && a.indexes.length ? a.indexes : Array.from({ length: total }, (_, i) => i);
          if (!indexes.length) return { ok: false, code: 'NOTHING_TO_RETURN', message: '这条记录没有出图' };
          const result = await r.send(row, indexes);
          if (result && result.ok) note('夏三六把历史记录的 ' + indexes.length + ' 张图传回了 Photoshop');
          return result;
        }),

      // ═══ 工具与功能 ═══
      tool('tool_run', '跑工具', '直接跑软件里的本机工具（对 Photoshop 当前选区，没选区看设置「无选区时使用整张画布」）：matting 抠像（主体抠出来，回成带蒙版的图层）；segment 人体解析（头发、脸、衣服、手臂…每个部位一个带蒙版的图层，装在一个组里）。都在本机算、不花钱，引擎没开会自动拉起。params 不给就用出厂参数（抠像：refine 边缘精修 / threshold 0～100 / contrast 0～100 / shrink -5～5 像素；人体解析：parts 部位 id 数组（空 = 全要）/ minPercent / groupName）。跑完回报任务结果。',
        obj({ tool: { type: 'string', enum: TOOL_KINDS }, params: { type: 'object', additionalProperties: true } }, ['tool']), async a => {
          if (!TOOL_KINDS.includes(a.tool)) throw error('TOOL_UNKNOWN', '只能跑：' + TOOL_KINDS.join(' / '));
          const t = need(host.tools, '工具与功能');
          const task = await t.run(a.tool, a.params && typeof a.params === 'object' ? a.params : {});
          if (!task) return { ok: false, code: 'TOOL_NOT_STARTED', message: '工具没开跑（上一次还没跑完？或者模块没加载）。看 app_status 的报错' };
          const row = summarizeTask(task, 0);
          return { ok: task.status === 'done', task: row, ...(task.status !== 'done' ? { code: 'TOOL_RUN_FAILED', message: row.error || row.note || '没跑成' } : {}) };
        }),
      tool('trace_check', 'AI 痕迹检测', 'AI 修图痕迹检测：run 抓当前 Photoshop 整张画布在本机检测，每处疑似痕迹回成一个标注图层（装在一个组里），返回每处的位置（region 是原图坐标）；result 看上一次的结果；focus 让 Photoshop 只显示第 candidateId 处并缩放过去；show_all 把标注组里的全部显示回来。',
        obj({ op: { type: 'string', enum: ['run', 'result', 'focus', 'show_all'] }, candidateId: str }, ['op']), async a => {
          const tr = need(host.trace, 'AI 痕迹检测');
          if (a.op === 'run') { const r = await tr.run(); if (r && r.busy) return { ok: false, code: 'TRACE_BUSY', message: '上一次检测还没完' }; }
          else if (a.op === 'focus') { if (!a.candidateId) throw error('TRACE_ID_REQUIRED', 'focus 要给 candidateId'); const r = await tr.select(a.candidateId); if (r && r.ok === false) return { ok: false, code: 'TRACE_FOCUS_FAILED', message: msg(r.error || '没跳过去') }; }
          else if (a.op === 'show_all') await tr.showAll();
          return { ok: true, ...summarizeTrace(tr.snapshot()) };
        }),
      tool('image_stats', '量画面', '用示波器量 Photoshop 当前画面：平均 / 中间亮度、死黑死白占多少、RGB 各通道平均、平均饱和度、偏什么色。只读，不改图。判断「是不是太暗 / 过曝 / 偏色」时用它出数，再结合 canvas_look 看图。quality 是采样长边（默认 512）。',
        obj({ quality: { type: 'integer', enum: [256, 512, 1024] } }), async a => {
          const sc = need(host.scopes, '示波器');
          const r = await sc.sample({ quality: Number(a.quality) || 512 });
          return { ok: true, document: r && r.name || '', ...scopeStats(r && r.result) };
        }),
      tool('network_check', '网络体检', '体检软件要连的几个地方（后台、本机 ComfyUI 等）通不通、多久回、不通的话下一步怎么办。用户说连不上、积分刷不出来、生图一直失败时先跑这个。',
        obj({}), async () => {
          const n = need(host.network, '网络体检');
          const r = await n.diagnose();
          return { ok: true, checkedAt: r && r.checkedAt, rows: (r && r.rows || []).map(x => ({ name: x.name, address: x.address, status: x.status, ms: x.elapsedMs, message: x.message, next: x.next })) };
        }, { parallel: true })
    ];
  }

  return { createTools, settingRows, checkSetting, summarizeTask, summarizeRecord, scopeStats, summarizeTrace, HOW_TO, TOOL_KINDS };
});
