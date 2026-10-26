/* 夏三六 · 二级大卡（#assistantZone）+ 主卡卡面（2026-10-17）
 *
 * 写给：以后接手 Agent 界面的人。依据 docs/231，样稿在 tmp/agent-ui/mock.html（用户看过 v2 定的形态）。
 * 只跟中间人 V7AgentService 说话，不直接碰 V7AssistantPanel —— 唯一的例外是「设置」页里
 * 原样挂一份旧面板（连接 / Agent 权限 / 恢复节点），那几块功能现成可用，不重写。
 *
 * 形态（用户定）：
 *   · 540×400，左 416 内容 + 右 108 导航（跟设置卡、生成卡长得一样）
 *   · 「当前对话」是聊天页：顶上只有一条细状态（没事时不占地方），抓画布 / 怎么跑 / 输入框 / 发送 一行钉在底下；
 *     会话管理（新建 / 切换 / 改名 / 删除）在「历史会话」页（10-17 晚用户：别放顶上，太占位置）
 *   · 「设置」组是一列到底、点哪滚到哪
 *   · 主卡 = 进程清单：计划 + 每个工具调用 + 正在 / 接下来（10-17 晚用户定）；空闲时能直接开工，按钮内容用户自己在「开工按钮」里定
 * ⚠ 监听只在挂载时绑一次（事件委托）；重画只改内容，不再绑 —— 「重复挂监听会锁死整机」那条教训。
 * ⚠ 正在打字的输入框重画时不碰，免得光标跳走。
 * ⚠ 进程清单里的东西都是真发生的（旧助手报的工具调用、大脑用 task_plan 写的计划），不编进度。
 */
(function (root) {
  'use strict';
  if (!root || root.V7AgentZone) return;
  const doc = root.document;

  // ⚠ scripts/check-card-registry.cjs 会把这张表跟 card-registry.js 的 innerTabs 对账：
  //   每行必须以 { id: '…', name: '…' 开头，改了这里就要改注册表。
  var RAIL = [
    { id: 'chat', name: '当前对话', group: '对话', page: 'chat' },
    { id: 'history', name: '历史会话', group: '对话', page: 'history' },
    { id: 'task', name: '当前任务', group: '任务', page: 'task' },
    { id: 'results', name: '结果清单', group: '任务', page: 'results' },
    { id: 'model', name: '模型连接', group: '设置', page: 'settings' },
    { id: 'perm', name: '权限恢复', group: '设置', page: 'settings' },
    { id: 'probe', name: '能力自测', group: '设置', page: 'settings' },
    { id: 'way', name: '工作方式', group: '设置', page: 'settings' },
    { id: 'starts', name: '开工按钮', group: '设置', page: 'settings' },
    { id: 'quick', name: '快捷指令', group: '设置', page: 'settings' }
  ];
  const STATE_LABEL = { idle: '空闲', running: '在干', replied: '回话了', failed: '出错' };
  const STATE_CLASS = { idle: 'ok', running: 'run', replied: 'wait', failed: 'err' };
  const SOURCE_LABEL = { main: '主卡', dock: '悬浮框', zone: '二级' };
  const PREF_CHOICES = {
    mode: [['each', '每步都问'], ['once', '开工前问一次'], ['auto', '全自动']],
    reasoning: [['', '不调'], ['low', '低'], ['medium', '中'], ['high', '高']],
    care: [['fast', '快'], ['normal', '标准'], ['careful', '仔细']],
    fallback: [['ask', '停下问我'], ['auto', '自动降级（写清楚）']]
  };
  const PREF_LABEL = { mode: '怎么跑', reasoning: '思考强度', care: '仔细程度', fallback: '工具坏了' };
  const MODE_SHORT = { each: '每步问', once: '问一次', auto: '全自动' };
  const PLAN_ICON = { todo: '○', doing: '◉', done: '✓', skip: '–' };
  const fmtMs = ms => !ms ? '' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  // ⭐ 2026-10-17 夜（用户：「它现在卡在准备生成了，有一会了」）：正在跑的工具显示「已跑几秒」，每秒跳一次；超过 60 秒标橙（多半卡住了）。
  //   ⚠ 只改那一小格的字（data-run-at），不整块重画 —— 高频重画会卡（记忆：重复挂监听 / 全量重绘锁死整机）。
  const SLOW_SEC = 60;
  const runSec = at => Math.max(0, Math.round((Date.now() - Number(at || 0)) / 1000));
  const runText = at => '已 ' + runSec(at) + ' 秒';
  if (root && root.setInterval) root.setInterval(() => {
    const els = root.document ? root.document.querySelectorAll('[data-run-at]') : [];
    for (const el of els) { const s = runSec(el.dataset.runAt); el.textContent = runText(el.dataset.runAt); el.classList.toggle('slow', s >= SLOW_SEC); }
  }, 1000);
  /* ── 进程清单（10-17 晚用户：主卡要看到「它当前调用了什么工具、干了什么、目前准备干什么」）──
   *   计划 = 大脑用 task_plan 写的；过程 = 每个工具调用 / 它中途说的话 / 全自动替你点的同意；都是真发生的事，不编 */
  function planHtml(plan, max) {
    if (!plan.length) return '';
    let rows = plan, more = '';
    // 主卡地方小：只露当前这步附近的几步，别把「正在做」那步挤出去
    if (max && plan.length > max) {
      const at = Math.max(0, plan.findIndex(p => p.status === 'doing' || p.status === 'todo'));
      const from = Math.max(0, Math.min(at - 1, plan.length - max));
      rows = plan.slice(from, from + max); more = '<div class="ap-step more"><i></i><span>共 ' + plan.length + ' 步，这里只露 ' + max + ' 步</span></div>';
    }
    return '<div class="ap-plan">' + rows.map(p => '<div class="ap-step ' + esc(p.status) + '"><i>' + (PLAN_ICON[p.status] || '○') + '</i><span>' + esc(p.text) + '</span></div>').join('') + more + '</div>';
  }
  function eventHtml(r) {
    if (r.kind === 'tool') return '<div class="ap-ev ' + esc(r.state) + '" title="' + esc([r.label, r.detail, r.note].filter(Boolean).join(' · ')) + '"><i></i><span class="ap-l">' + esc(r.label) + (r.detail ? ' <em>' + esc(r.detail) + '</em>' : '') + (r.note ? ' <em class="n">' + esc(r.note) + '</em>' : '') + '</span><span class="ap-r' + (r.state === 'run' && runSec(r.at) >= SLOW_SEC ? ' slow' : '') + '"' + (r.state === 'run' && r.at ? ' data-run-at="' + esc(r.at) + '"' : '') + '>' + (r.state === 'run' ? (r.at ? runText(r.at) : '…') : esc(fmtMs(r.ms))) + '</span></div>';
    const tag = { say: '夏三六', user: '你', auto: '自动' }[r.kind] || '';
    return '<div class="ap-ev ' + esc(r.kind) + '" title="' + esc(r.text) + '"><i></i><span class="ap-l"><b>' + tag + '</b> ' + esc(r.text) + '</span></div>';
  }
  function nextLine(s) {
    const doing = s.plan.find(p => p.status === 'doing'), todo = s.plan.find(p => p.status === 'todo');
    const run = [...s.activity].reverse().find(r => r.kind === 'tool' && r.state === 'run');
    // 2026-10-22（docs/263 第 3 条）：以前写「正在：读取文档」—— 冒号后面再接动作，读着别扭，改成「正在读取文档…」
    if (s.task.state === 'running') return run ? '正在' + run.label + (run.detail ? ' · ' + run.detail : '…') : doing ? '正在' + doing.text + '…' : '正在想下一步…';
    if (s.task.ask) return '';
    return todo ? '接下来：' + todo.text : '';
  }
  let host = { navigate: null, setupMount: null };
  const svc = () => root.V7AgentService;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const report = e => { try { root.ERR && root.ERR.report('ASSISTANT_OPERATION_FAILED', { message: String(e && e.message || e) }); } catch (_) {} };
  const go = section => { try { if (host.navigate) host.navigate(section); } catch (e) { report(e); } };
  const sig = v => JSON.stringify(v);
  const time = at => { if (!at) return ''; const d = new Date(at); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const badge = state => '<span class="az-badge ' + (STATE_CLASS[state] || '') + '">' + esc(STATE_LABEL[state] || state) + '</span>';
  const seg = (key, value, disabled) => '<span class="az-seg' + (disabled ? ' off' : '') + '" data-pref="' + key + '">' + PREF_CHOICES[key].map(([v, l]) => '<button type="button" data-val="' + esc(v) + '"' + (v === value ? ' class="on"' : '') + (disabled ? ' disabled' : '') + '>' + esc(l) + '</button>').join('') + '</span>';
  function connText(c) { return c.ready ? '<span class="az-dot"></span>已连接' + (c.model ? ' · ' + esc(c.model) : '') : '<span class="az-dot off"></span>还没连上大脑'; }
  function taskLines(t) {
    if (t.state === 'running') return [t.title || '在干', t.step || '已发出，等夏三六回话'];
    if (t.state === 'replied') return [t.title || '回话了', t.reply || '这一轮说完了'];
    if (t.state === 'failed') return [t.title || '出错了', t.error || '出错了'];
    return ['目前没有执行任务', '点上面的按钮，或者直接说要干什么'];
  }
  async function act(fn) { try { return await fn(); } catch (e) { report(e); return null; } }

  /* ═════════ 二级大卡 ═════════ */
  function zoneMarkup() {
    let groups = '', lastGroup = '';
    for (const r of RAIL) {
      if (r.group !== lastGroup) { groups += '<div class="az-group">' + esc(r.group) + '</div>'; lastGroup = r.group; }
      groups += '<button type="button" class="az-node" data-az-go="' + r.id + '"><i></i><span>' + esc(r.name) + '</span><em hidden></em></button>';
    }
    return '<div class="az-main">' +
      // 当前对话 —— ⭐ 10-17 晚用户：对话管理别放顶上（太占地方，挪到「历史会话」那页）；抓画布 / 怎么跑 / 输入框 / 发送 挤在一行；上下空间尽量给消息
      '<section class="az-pg on" data-az-pg="chat">' +
        '<div class="az-strip" data-az-strip hidden><span data-az-strip-badge></span><span class="az-strip-tx" data-az-strip-tx></span>' +
          '<button type="button" class="az-btn sm" data-az-go="model" data-az-strip-conn hidden>去连接</button><button type="button" class="az-btn sm warn" data-az-act="stop" hidden>停止</button></div>' +
        '<div class="az-msgs" data-az-scroll data-az-msgs role="log" aria-label="当前会话消息"></div>' +
        '<div class="az-attach" data-az-attach hidden></div>' +
        '<div class="az-comp"><button type="button" class="az-btn sm" data-az-act="capture" title="把 Photoshop 当前整张画布附上（夏三六也会自己看图）">抓画布</button>' +
          '<select class="az-select sm" data-az-mode title="这次怎么跑">' + PREF_CHOICES.mode.map(([v]) => '<option value="' + v + '">' + MODE_SHORT[v] + '</option>').join('') + '</select>' +
          '<textarea class="az-ta" data-az-scroll data-az-input rows="1" maxlength="12000" placeholder="说要干什么，回车发送"></textarea>' +
          '<button type="button" class="az-btn sm pri" data-az-act="send">发送</button></div>' +
      '</section>' +
      // 历史会话（会话管理挪到这里：新建、切换、改名、删除）
      '<section class="az-pg" data-az-pg="history"><div class="az-ph"><div class="az-ph-t">历史会话</div><div class="az-ph-s">点一下切过去看；切走不会停正在跑的任务</div></div>' +
        '<div class="az-pb" data-az-scroll><div class="az-rowbtns"><button type="button" class="az-btn" data-az-act="new">＋新建会话</button><span class="az-conn" data-az-conn></span></div><div data-az-history></div></div></section>' +
      // 当前任务
      '<section class="az-pg" data-az-pg="task"><div class="az-ph"><div class="az-ph-t">当前任务</div><div class="az-ph-s">它写的计划、调过的每个工具、中途说的话；排着队的任务也在这里</div></div>' +
        '<div class="az-pb" data-az-scroll data-az-taskpage></div></section>' +
      // 结果清单
      '<section class="az-pg" data-az-pg="results"><div class="az-ph"><div class="az-ph-t">结果清单</div><div class="az-ph-s">每处一行、通过 / 不要 / 重做</div></div>' +
        '<div class="az-pb" data-az-scroll><div class="az-note">还没有。结果清单要等「去杂物」这些修图流程做出来才有（docs/231 第八节）。现在夏三六做的东西直接在 Photoshop 的图层里，汇报写在对话里。</div></div></section>' +
      // 设置：一列到底
      '<section class="az-pg" data-az-pg="settings"><div class="az-ph"><div class="az-ph-t">设置</div><div class="az-ph-s">大脑、自测、工作方式、开工按钮、快捷指令</div></div>' +
        '<div class="az-pb" data-az-scroll data-az-settings>' +
          '<div class="az-sec" data-az-anchor="model"><div class="az-sec-t">模型连接</div><div class="az-sec-s">用哪家的大脑你自己定；Key 存在本机安全存储里</div><div data-az-legacy></div><details class="az-local"><summary>本地助手运行环境（用本机模型时）</summary><div data-az-local></div></details></div>' +
          '<div class="az-sec" data-az-anchor="perm"><div class="az-sec-t">权限与恢复节点</div><div class="az-sec-s">旧助手「改软件」那套的权限和备份，在上面「模型连接」那块里一起显示。夏三六不改软件代码，这两个工具不交给它</div></div>' +
          '<div class="az-sec" data-az-anchor="probe"><div class="az-sec-t">能力自测</div><div class="az-sec-s">连上以后测一下这个大脑会什么；不会的功能会灰掉并写明原因（会花几分钱，要你点同意）</div><div data-az-probe></div><div class="az-rowbtns"><button type="button" class="az-btn pri" data-az-act="probe">开始自测</button></div><div class="az-status" data-az-probe-status role="status"></div></div>' +
          '<div class="az-sec" data-az-anchor="way"><div class="az-sec-t">工作方式</div><div class="az-sec-s">默认值；对话输入框旁边每次还能临时改「怎么跑」</div><div data-az-way></div>' +
            '<div class="az-note">不管哪一档：碰到红线、钱不够、拿不准，夏三六都会停下来问你；图层到底贴没贴回 Photoshop，哪一档都要查。</div></div>' +
          '<div class="az-sec" data-az-anchor="starts"><div class="az-sec-t">开工按钮</div><div class="az-sec-s">主卡上「直接开工」那几个按钮；点一下就把这句话发给夏三六。话里写「【范围】」会换成下面选的范围</div><div data-az-starts-edit></div>' +
            '<div class="az-rowbtns"><button type="button" class="az-btn" data-az-act="start-add">＋加一个按钮</button><button type="button" class="az-btn" data-az-act="start-reset">恢复默认</button></div></div>' +
          '<div class="az-sec" data-az-anchor="quick"><div class="az-sec-t">快捷指令</div><div class="az-sec-s">悬浮框下面那排按钮；悬浮框里打一句没存过的话，也会出现「＋存为快捷」</div><div data-az-quick-edit></div>' +
            '<div class="az-rowline"><input class="az-input" data-az-quick-new maxlength="60" placeholder="加一条，比如：把这张图调亮一点"><button type="button" class="az-btn" data-az-act="quick-add">加上</button></div></div>' +
        '</div></section>' +
    '</div>' +
    '<nav class="az-rail" aria-label="助手导航"><div class="z-glow"></div><div class="z-bright"></div><div class="az-rail-in"><div class="az-nodes">' + groups + '</div></div></nav>';
  }

  function mountZone(zone, options) {
    if (!zone) return null;
    if (zone.__az) return zone.__az;
    host = Object.assign(host, options || {});
    zone.classList.add('az-zone');
    zone.innerHTML = zoneMarkup();
    const $ = s => zone.querySelector(s), $$ = s => [...zone.querySelectorAll(s)];
    let anchor = 'chat', isOpen = false, legacyCleanup = null, localCleanup = null, last = {}, startsTimer = 0, renameId = '', syncingMode = false;

    function mountLegacy() {
      // ⚠ 旧面板同一时间只有【最后挂的那一份】是活的（设置卡「助手模型」那节也挂一份）。
      //   所以每次打开本卡的设置页都重挂一份新的 —— 不然中途去过设置卡，回来这份就是「看着正常、点了读别处」的死面板。
      if (!root.V7AssistantPanel || typeof root.V7AssistantPanel.mountSection !== 'function') return;
      if (legacyCleanup) { try { legacyCleanup(); } catch (_) {} legacyCleanup = null; }
      const box = $('[data-az-legacy]');
      try {
        legacyCleanup = root.V7AssistantPanel.mountSection(box, 'connection');
        // 旧面板挂成「连接」那一块；同一块里的 Agent 权限 / 恢复节点也露出来（不另挂第二份 —— 旧面板同时只能有一份是活的）
        const view = box.querySelector('.assistant-embedded');
        const agent = view && view.querySelector('[data-agent-tier]') && view.querySelector('[data-agent-tier]').closest('details');
        if (agent) { agent.hidden = false; const s = agent.querySelector('summary'); if (s) s.textContent = 'Agent 权限与恢复节点（旧助手改软件那套）'; agent.dataset.azPerm = '1'; }
        const title = view && view.querySelector('[data-assistant-panel] > .settings-section-title'); if (title) title.hidden = true;
        const note = view && view.querySelector('[data-assistant-panel] > .settings-note'); if (note) note.hidden = true;
      } catch (e) { report(e); }
    }
    function scrollToAnchor(id, smooth) {
      const body = $('[data-az-settings]'), target = body && body.querySelector('[data-az-anchor="' + id + '"]');
      if (!body || !target) return;
      let y = target.offsetTop - body.offsetTop - 4;
      if (id === 'perm') { const a = body.querySelector('[data-az-perm]'); if (a && a.offsetParent) y = a.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 4; }
      body.scrollTo({ top: Math.max(0, y), behavior: smooth === false ? 'auto' : 'smooth' });
    }
    function show(id, smooth) {
      const r = RAIL.find(x => x.id === id) || RAIL[0];
      // 在设置页里点导航换小节时不重挂（只滚）；从别的页进来、或者卡重新打开时才重挂
      const wasSettings = isOpen && (RAIL.find(x => x.id === anchor) || {}).page === 'settings' && $('[data-az-pg="settings"]').classList.contains('on') && !!legacyCleanup;
      anchor = r.id;
      $$('[data-az-pg]').forEach(p => p.classList.toggle('on', p.dataset.azPg === r.page));
      $$('.az-node').forEach(n => n.classList.toggle('sel', n.dataset.azGo === r.id));
      zone.dataset.assistantTab = r.id;
      if (r.page === 'settings') { if (!wasSettings) mountLegacy(); root.requestAnimationFrame(() => scrollToAnchor(r.id, smooth)); }
      if (r.page === 'chat') root.requestAnimationFrame(() => { const m = $('[data-az-msgs]'); if (m) m.scrollTop = m.scrollHeight; });
    }

    /* ── 画 ── */
    function render(s) {
      const t = s.task, running = t.state === 'running';
      $('[data-az-conn]').innerHTML = connText(s.connection);
      // 会话（管理挪到「历史会话」页）
      const sessSig = sig([s.conversations, s.conversationId]);
      if (sessSig !== last.sess) { last.sess = sessSig; renderHistory(s); }
      // 开工按钮编辑器
      const startsSig = sig(s.starts);
      if (startsSig !== last.starts) {
        last.starts = startsSig;
        if (!zone.contains(doc.activeElement) || !doc.activeElement.closest('[data-az-starts-edit]')) renderStartsEditor(s);
      }
      // 对话页顶上那一条细状态：没事的时候不占地方
      const queued = s.queue.length ? '还排着 ' + s.queue.length + ' 个任务' : '';
      const stripText = !s.connection.ready ? '还没连上大脑' : running ? (nextLine(s) || '在干') + (queued ? ' · ' + queued : '') : t.ask ? '等你回答（点下面的选项，或者直接打字回）' : t.state === 'failed' ? (t.error || '出错了') : queued;
      const strip = $('[data-az-strip]'); strip.hidden = !stripText; strip.className = 'az-strip' + (t.state === 'failed' ? ' err' : t.ask ? ' ask' : '');
      $('[data-az-strip-badge]').innerHTML = !s.connection.ready ? '' : t.ask ? '<span class="az-badge wait">等你</span>' : t.state === 'idle' ? '' : badge(t.state);
      $('[data-az-strip-tx]').textContent = stripText; $('[data-az-strip-tx]').title = stripText;
      $('[data-az-strip-conn]').hidden = s.connection.ready;
      $$('[data-az-act="stop"]').forEach(b => { b.hidden = !running; });
      // 在干的时候也能发：排进队里，干完接着干（一次一个任务，顺位进行）
      const sendBtn = $('[data-az-act="send"]'); sendBtn.textContent = running ? '排队' : '发送'; sendBtn.title = running ? '现在这个干完接着干这一句' : '';
      $$('[data-az-start]').forEach(b => { b.disabled = running; });
      // 消息（它问你的问题带选项按钮）
      const msgSig = sig([s.conversationId, s.messages.length, s.messages.length && s.messages[s.messages.length - 1].text.length, t.ask, s.connection.ready]);
      if (msgSig !== last.msgs) { last.msgs = msgSig; renderMessages(s); }
      // 附件
      const prev = root.V7AssistantPanel && root.V7AssistantPanel.attachmentPreview ? root.V7AssistantPanel.attachmentPreview() : null;
      const attachSig = sig(prev);
      if (attachSig !== last.attach) {
        last.attach = attachSig;
        const box = $('[data-az-attach]'); box.hidden = !prev;
        box.innerHTML = prev ? (prev.src ? '<img alt="准备发送的画布" src="' + esc(prev.src) + '">' : '') + '<span>' + esc(prev.name) + ' · ' + esc(prev.width) + '×' + esc(prev.height) + '（跟下一句一起发' + (s.prefs.mode === 'auto' ? '' : '，发送时会问你一次') + '）</span><button type="button" class="az-btn sm" data-az-act="unattach">移除</button>' : '';
      }
      // ⚠ 统一下拉框（ui-select.js）只在 change 事件 / 选项增删时刷新它画的那个按钮 —— 代码直接改 value 它看不见，
      //   主卡上改了「怎么跑」，这里就会还显示旧的（自己挑刺挑出来的）。改完手动发一次 change，并且别让它反过来触发保存。
      const modeSel = $('[data-az-mode]');
      if (doc.activeElement !== modeSel && modeSel.value !== s.prefs.mode) { modeSel.value = s.prefs.mode; syncingMode = true; try { modeSel.dispatchEvent(new Event('change')); } finally { syncingMode = false; } }
      // 导航角标
      const em = $('[data-az-go="task"] em'); em.hidden = t.state === 'idle'; em.textContent = { running: '跑', replied: '回', failed: '错' }[t.state] || ''; em.className = t.state === 'failed' ? 'e' : t.state === 'replied' ? 'w' : '';
      renderTaskPage(s);
      renderProbe(s);
      const waySig = sig([s.prefs, s.probe && s.probe.thinking, s.probe && s.probe.model, s.connection.model]);
      if (waySig !== last.way) { last.way = waySig; renderWay(s); }
      const quickSig = sig(s.quick);
      if (quickSig !== last.quick) { last.quick = quickSig; renderQuickEditor(s); }
    }
    function renderMessages(s) {
      const box = $('[data-az-msgs]'), stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.replaceChildren();
      if (!s.messages.length) {
        const hello = doc.createElement('div'); hello.className = 'az-m a';
        hello.innerHTML = '<small>夏三六</small>你好，我是夏三六。直接告诉我要修什么；主卡上能看到我正在调什么工具、接下来打算干什么。' + (s.connection.ready ? '' : '<br>现在还没连上大脑：点上面的「去连接」填服务商和 Key。');
        box.append(hello);
      }
      for (const m of s.messages) {
        const d = doc.createElement('div');
        d.className = 'az-m ' + (m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : 't');
        const who = doc.createElement('small'); who.textContent = m.role === 'user' ? '你' : m.role === 'assistant' ? '夏三六' : '操作记录';
        const body = doc.createElement('div'); body.textContent = m.text; body.dataset.selectable = '';
        d.append(who, body); box.append(d);
      }
      // 它用 ask_user 问你：选项做成按钮，点一下就等于回答
      if (s.task.ask && s.task.ask.options.length) {
        const row = doc.createElement('div'); row.className = 'az-answers';
        for (const o of s.task.ask.options) { const b = doc.createElement('button'); b.type = 'button'; b.className = 'az-chip'; b.dataset.azAnswer = o; b.textContent = o; row.append(b); }
        box.append(row);
      }
      if (stick) box.scrollTop = box.scrollHeight;
    }
    function renderHistory(s) {
      const rows = s.conversations.length ? s.conversations : [];
      $('[data-az-history]').innerHTML = rows.map(c => {
        const cur = c.id === s.conversationId, editing = renameId === c.id;
        return '<div class="az-hs' + (cur ? ' cur' : '') + '" data-az-conv="' + esc(c.id) + '">' +
          (editing ? '<input class="az-input" data-az-rename value="' + esc(c.title) + '" maxlength="80"><button type="button" class="az-btn sm pri" data-az-act="rename-save">保存</button>'
            : '<span class="az-hs-nm">' + esc(c.title || '新会话') + '</span>' + (cur ? '<span class="az-badge ok">当前</span>' : '') +
              '<span class="az-hs-ops"><button type="button" class="az-btn sm" data-az-act="rename">改名</button><button type="button" class="az-btn sm warn" data-az-act="delete">删除</button></span>') + '</div>';
      }).join('') || (root.V7Format ? root.V7Format.emptyHtml({ title: '还没有会话', hint: '直接在聊天框里说话会自动建一个', action: { label: '新建会话', attrs: 'data-az-act="new"' } }) : '<div class="az-note">还没有会话。</div>');
      if (renameId) { const i = $('[data-az-rename]'); if (i) { i.focus(); i.select(); } }
    }
    function renderTaskPage(s) {
      const t = s.task, k = sig([t, s.plan, s.activity, s.queue]);
      if (k === last.task) return; last.task = k;
      const [l1, l2] = taskLines(t), nx = nextLine(s);
      $('[data-az-taskpage]').innerHTML = '<div class="az-tp-head">' + badge(t.state) + '<b>' + esc(l1) + '</b></div>' +
        (t.state === 'idle' && !s.activity.length ? '<div class="az-note">没有任务。在主卡点「直接开工」的按钮、在悬浮框点快捷指令，或者在「当前对话」里说一句，就会出现在这里。</div>'
          : (t.state === 'idle' ? '' : '<div class="az-kv"><span>从哪发的</span><b>' + esc(SOURCE_LABEL[t.source] || t.source || '-') + '</b></div><div class="az-kv"><span>时间</span><b>' + esc(time(t.at)) + '</b></div>') +
            (s.plan.length ? '<div class="az-sec-t ap-h">计划</div>' + planHtml(s.plan) : '') +
            (nx ? '<div class="ap-next">' + esc(nx) + '</div>' : '') +
            '<div class="az-sec-t ap-h">过程（' + s.activity.length + '）</div><div class="ap-log full">' + (s.activity.map(eventHtml).join('') || '<div class="az-note">还没调过工具。</div>') + '</div>' +
            (t.state === 'replied' || t.state === 'failed' ? '<div class="az-tp-body">' + esc(l2) + '</div>' : '') +
            (s.queue.length ? '<div class="az-sec-t ap-h">排着队的（干完当前这个接着干）</div>' + s.queue.map(q => '<div class="az-qk"><span>' + esc(q.title) + '</span><button type="button" class="az-btn sm warn" data-az-unqueue="' + esc(q.id) + '">不做了</button></div>').join('') : '') +
            '<div class="az-rowbtns">' + (t.state === 'running' ? '<button type="button" class="az-btn warn" data-az-act="stop">停止</button>' : '<button type="button" class="az-btn" data-az-act="dismiss">收起</button>') + '<button type="button" class="az-btn" data-az-go="chat">看对话 ›</button></div>');
    }
    function renderProbe(s) {
      const p = s.probe, k = sig([p, s.connection.model]);
      if (k === last.probe) return; last.probe = k;
      const stale = p && s.connection.model && p.model && p.model !== s.connection.model;
      const row = (label, r) => '<div class="az-cap"><span>' + label + '</span><b class="' + (!r ? 'unk' : r.ok ? 'ok' : 'bad') + '">' + (!r ? '没测' : (r.ok ? '✓ ' : '✗ ') + esc(r.detail || '')) + '</b></div>';
      $('[data-az-probe]').innerHTML = (stale ? '<div class="az-note">上次测的是「' + esc(p.model) + '」，现在换成了「' + esc(s.connection.model) + '」，请重测。</div>' : '') +
        row('能调工具（自动干活必须）', p && p.tools) + row('能看图（检查结果、降级时自己看）', p && p.vision) + row('能调思考强度', p && p.thinking) +
        (p && p.at ? '<div class="az-ph-s">测于 ' + esc(time(p.at)) + ' · ' + esc(p.model || '') + '</div>' : '');
    }
    function renderWay(s) {
      const p = s.probe, thinkingOff = !!(p && p.thinking && !p.thinking.ok && (!s.connection.model || p.model === s.connection.model));
      $('[data-az-way]').innerHTML = ['mode', 'reasoning', 'care', 'fallback'].map(k => '<div class="az-row"><span>' + PREF_LABEL[k] + '</span>' + seg(k, s.prefs[k], k === 'reasoning' && thinkingOff) + '</div>').join('') +
        '<div class="az-ph-s">思考强度目前只对 OpenAI 那类推理模型生效（gpt-5、o 系列）；别的模型选了也不发，免得接口报错。</div>';
    }
    function renderStartsEditor(s) {
      $('[data-az-starts-edit]').innerHTML = s.starts.map((r, i) => '<div class="az-st" data-az-st="' + i + '">' +
        '<div class="az-rowline"><input class="az-input" data-az-sf="label" maxlength="12" value="' + esc(r.label) + '" placeholder="按钮上的字">' +
        '<select class="az-select sm" data-az-sf="scope">' + Object.entries(svc().snapshot().scopes).map(([v, l]) => '<option value="' + v + '"' + (v === r.scope ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
        '<button type="button" class="az-btn sm" data-az-act="start-up"' + (i ? '' : ' disabled') + '>上移</button><button type="button" class="az-btn sm warn" data-az-act="start-del">删除</button></div>' +
        '<textarea class="az-ta sm" data-az-sf="prompt" maxlength="600" rows="2" placeholder="点了发给夏三六的话">' + esc(r.prompt) + '</textarea></div>').join('') ||
        '<div class="az-note">一个按钮都没有，主卡上会提示你来这里加。</div>';
    }
    function renderQuickEditor(s) {
      $('[data-az-quick-edit]').innerHTML = s.quick.map((q, i) => '<div class="az-qk" data-az-qk="' + i + '"><span>' + esc(q) + '</span><button type="button" class="az-btn sm" data-az-act="quick-up"' + (i ? '' : ' disabled') + '>上移</button><button type="button" class="az-btn sm warn" data-az-act="quick-del">删除</button></div>').join('') || '<div class="az-note">没有快捷指令。</div>';
    }
    function collectStarts() {
      const cur = svc().snapshot().starts;
      return $$('[data-az-st]').map(row => {
        const i = Number(row.dataset.azSt), old = cur[i] || {};
        return { id: old.id, label: row.querySelector('[data-az-sf="label"]').value, scope: row.querySelector('[data-az-sf="scope"]').value, prompt: row.querySelector('[data-az-sf="prompt"]').value };
      });
    }
    function saveStartsSoon() { clearTimeout(startsTimer); startsTimer = setTimeout(() => act(() => svc().setStarts(collectStarts().filter(r => r.label.trim() && r.prompt.trim()))), 500); }

    /* ── 操作（全部委托在 zone 上，只绑这一次） ── */
    async function send() {
      const box = $('[data-az-input]'), text = box.value.trim(); if (!text) { box.focus(); return; }
      box.value = ''; grow(box);
      const r = await act(() => svc().submit(text, { source: 'zone' }));
      if (r && r.cancelled && !box.value) { box.value = text; grow(box); }
    }
    // 输入框跟着字数长高（一行起，最多四行），省出上下空间给消息
    function grow(box) { box.style.height = ''; if (box.value) box.style.height = Math.min(84, Math.max(30, box.scrollHeight + 2)) + 'px'; }
    zone.addEventListener('click', async e => {
      const goEl = e.target.closest('[data-az-go]'), btn = e.target.closest('button');
      if (btn && btn.disabled) return;
      if (goEl && (!btn || btn === goEl)) { show(goEl.dataset.azGo); return; }
      const start = e.target.closest('[data-az-start]'); if (start) { show('chat'); act(() => svc().start(start.dataset.azStart)); return; }
      const answer = e.target.closest('[data-az-answer]'); if (answer) { act(() => svc().answer(answer.dataset.azAnswer)); return; }
      const unq = e.target.closest('[data-az-unqueue]'); if (unq) { svc().unqueue(unq.dataset.azUnqueue); return; }
      const conv = e.target.closest('[data-az-conv]');
      if (conv && !btn && !e.target.closest('input')) { act(() => svc().switchConversation(conv.dataset.azConv)); show('chat'); return; }
      const a = btn && btn.dataset.azAct; if (!a) return;
      const s = svc();
      if (a === 'send') return send();
      if (a === 'stop') return act(() => s.stop());
      if (a === 'dismiss') return s.dismiss();
      if (a === 'new') { act(() => s.newConversation()); show('chat'); return; }
      if (a === 'capture') return act(() => s.capture());
      if (a === 'unattach') return act(() => root.V7AssistantPanel.removeAttachment());
      if (a === 'probe') {
        const out = $('[data-az-probe-status]'); out.textContent = '正在自测…'; btn.disabled = true;
        const r = await act(() => s.probe()); btn.disabled = false;
        out.textContent = !r ? '自测没做成' : r.ok ? '自测做完了' : r.cancelled ? '' : (r.message || '自测没做成');
        return;
      }
      if (a === 'rename' || a === 'delete') {
        const id = btn.closest('[data-az-conv]').dataset.azConv;
        if (id !== s.snapshot().conversationId) await act(() => s.switchConversation(id));
        if (a === 'rename') { renameId = id; last.sess = ''; render(s.snapshot()); } else await act(() => s.deleteConversation());
        return;
      }
      if (a === 'rename-save') { const v = $('[data-az-rename]').value; renameId = ''; await act(() => s.renameConversation(v)); last.sess = ''; render(s.snapshot()); return; }
      if (a === 'start-add') { const rows = s.snapshot().starts; if (rows.length >= 8) return; s.setStarts(rows.concat([{ label: '新按钮', prompt: '帮【范围】…（写清楚要做什么）', scope: 'current' }])); renderStartsEditor(s.snapshot()); return; }
      if (a === 'start-reset') { s.resetStarts(); renderStartsEditor(s.snapshot()); return; }
      if (a === 'start-up' || a === 'start-del') {
        clearTimeout(startsTimer);
        const rows = collectStarts(), i = Number(btn.closest('[data-az-st]').dataset.azSt);
        if (a === 'start-del') rows.splice(i, 1); else if (i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        s.setStarts(rows); renderStartsEditor(s.snapshot()); return;
      }
      if (a === 'quick-add') { const i = $('[data-az-quick-new]'); if (i.value.trim()) { s.addQuick(i.value); i.value = ''; } return; }
      if (a === 'quick-up' || a === 'quick-del') {
        const rows = s.snapshot().quick, i = Number(btn.closest('[data-az-qk]').dataset.azQk);
        if (a === 'quick-del') rows.splice(i, 1); else if (i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        s.setQuick(rows); return;
      }
      const segEl = e.target.closest('[data-pref]');
      if (segEl && btn.dataset.val != null) s.setPrefs({ [segEl.dataset.pref]: btn.dataset.val });
    });
    zone.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey && e.target.matches('[data-az-input]')) { e.preventDefault(); send(); }
      else if (e.key === 'Enter' && e.target.matches('[data-az-rename]')) { e.preventDefault(); $('[data-az-act="rename-save"]').click(); }
      else if (e.key === 'Enter' && e.target.matches('[data-az-quick-new]')) { e.preventDefault(); $('[data-az-act="quick-add"]').click(); }
      else if (e.key === 'Escape' && e.target.matches('[data-az-rename]')) { renameId = ''; last.sess = ''; render(svc().snapshot()); }
    });
    zone.addEventListener('input', e => { if (e.target.closest('[data-az-st]')) saveStartsSoon(); else if (e.target.matches('[data-az-input]')) grow(e.target); });
    zone.addEventListener('change', e => {
      if (e.target.matches('[data-az-mode]')) { if (!syncingMode) svc().setPrefs({ mode: e.target.value }); }
      else if (e.target.closest('[data-az-st]')) saveStartsSoon();
    });
    const local = $('.az-local');
    local.addEventListener('toggle', () => {
      if (local.open && !localCleanup && root.V7Setup) { try { localCleanup = root.V7Setup.mount(local.querySelector('[data-az-local]'), { section: 'assistant' }); } catch (e) { report(e); } }
      else if (!local.open && localCleanup) { try { localCleanup(); } catch (_) {} localCleanup = null; }
    });

    // 滚轮：宿主（ui.html 那条全局滚轮监听）判定鼠标在本卡上以后交给这里 —— 只滚内容，到头就停，绝不翻页
    function wheel(x, y, dy) {
      const el = doc.elementFromPoint(x, y), box = el && el.closest && el.closest('[data-az-scroll]');
      if (!box || !zone.contains(box)) return false;
      const more = dy > 0 ? box.scrollTop + box.clientHeight < box.scrollHeight - 1 : box.scrollTop > 0;
      if (more) box.scrollTop += dy;
      return more;
    }

    svc().subscribe(render);
    // 换账号：跟设置卡同一个规矩 —— 旧面板【立刻】拆掉（不让上个账号的 key / 地址留在眼前），
    //   等新账号的设置读进来（排到所有同步处理器之后）再按需重挂一份新的。
    root.addEventListener('wheelchair:storage-context', () => {
      if (legacyCleanup) { try { legacyCleanup(); } catch (_) {} legacyCleanup = null; }
      renameId = ''; last = {};
      setTimeout(() => { if (isOpen && $('[data-az-pg="settings"]').classList.contains('on')) mountLegacy(); }, 0);
    });
    const api = {
      el: zone, wheel,
      open: id => { const wasOpen = isOpen; isOpen = true; if (!wasOpen && legacyCleanup) { try { legacyCleanup(); } catch (_) {} legacyCleanup = null; } show(id || anchor, false); },
      close: () => { isOpen = false; },
      isOpen: () => isOpen,
      currentTab: () => anchor,
      scrollToAnchor: (id, smooth) => scrollToAnchor(id, smooth),
      tabs: () => RAIL.map(r => ({ id: r.id, name: r.name, group: r.group }))
    };
    zone.__az = api;
    return api;
  }

  /* ═════════ 主卡卡面：进程清单 + 能直接开工 ═════════
   * ⭐ 10-17 晚用户：「我希望我们的助手卡片的主页是就是它当前调用了什么工具，干了什么，然后目前准备干什么，就是类似于一个进程清单」
   *   在干 / 回话了 / 出错 / 等你回答 → 进程清单（计划 + 过程 + 正在 / 接下来 + 按钮）
   *   空闲 → 「直接开工」按钮 + 怎么跑（上一个任务的过程缩成几行留在下面） */
  function mountFace(node) {
    if (!node) return null;
    if (node.__af) return node.__af;
    node.classList.add('agent-face');
    node.innerHTML = '<div class="af-head"><span data-af-badge></span><b>夏三六</b><span class="af-q" data-af-queue hidden></span><button type="button" class="af-conn" data-af-go="model" data-af-conn></button></div><div class="af-body" data-af-body></div>';
    const $ = s => node.querySelector(s);
    let lastSig = '';
    function render(s) {
      const t = s.task, k = sig([t, s.starts, s.prefs.mode, s.connection.ready, s.connection.model, s.activity, s.plan, s.queue]);
      $('[data-af-badge]').innerHTML = t.ask ? '<span class="az-badge wait">等你</span>' : badge(t.state);
      $('[data-af-conn]').innerHTML = connText(s.connection);
      const q = $('[data-af-queue]'); q.hidden = !s.queue.length; q.textContent = '排队 ' + s.queue.length;
      if (k === lastSig) return; lastSig = k;
      const body = $('[data-af-body]');
      if (t.state === 'idle') {
        body.innerHTML = (s.connection.ready ? '' : '<div class="af-note">还没连上大脑：点右上角去「模型连接」填服务商和 Key。</div>') +
          '<div class="af-lbl"><span>直接开工</span><button type="button" class="af-link" data-af-go="starts">改按钮 ›</button></div>' +
          (s.starts.length ? '<div class="af-grid">' + s.starts.map(r => '<button type="button" class="af-start" data-af-start="' + esc(r.id) + '" title="' + esc(svc().startText(r)) + '">' + esc(r.label) + '<small>' + esc(s.scopes[r.scope] || '') + '</small></button>').join('') + '</div>'
            : '<div class="af-note">还没有开工按钮，点「改按钮」加几个。</div>') +
          '<div class="af-row"><span>怎么跑</span>' + seg('mode', s.prefs.mode) + '</div>' +
          (s.activity.length ? '<div class="af-lbl"><span>上一个任务</span><button type="button" class="af-link" data-af-go="task">全过程 ›</button></div><div class="ap-log dim">' + s.activity.slice(-4).map(eventHtml).join('') + '</div>' : '');
        return;
      }
      const [l1, l2] = taskLines(t), nx = nextLine(s);
      const btns = t.state === 'running'
        ? '<button type="button" class="az-btn warn" data-af-act="stop">停止</button><button type="button" class="az-btn" data-af-go="chat">看对话 ›</button>'
        : t.ask
          ? t.ask.options.map(o => '<button type="button" class="az-btn pri" data-af-answer="' + esc(o) + '">' + esc(o) + '</button>').join('') + '<button type="button" class="az-btn" data-af-go="chat">回话 ›</button><button type="button" class="az-btn" data-af-act="decline">先不做</button>'
          : t.state === 'replied'
            ? '<button type="button" class="az-btn pri" data-af-act="continue">好，继续</button><button type="button" class="az-btn" data-af-go="chat">看全文 ›</button><button type="button" class="az-btn" data-af-act="dismiss">收起</button>'
            : '<button type="button" class="az-btn" data-af-go="model">去看连接 ›</button><button type="button" class="az-btn" data-af-act="dismiss">收起</button>';
      body.innerHTML = '<div class="af-proc">' +
        '<div class="af-t1">' + esc(l1) + (s.prefs.mode === 'auto' ? '<span class="af-auto">全自动</span>' : '') + '</div>' +
        planHtml(s.plan, 5) +
        '<div class="ap-log" data-af-log>' + (s.activity.slice(-14).map(eventHtml).join('') || '<div class="ap-ev say"><i></i><span class="ap-l">已发出，等夏三六回话…</span></div>') + '</div>' +
        (t.state === 'running' ? '<div class="ap-next">' + esc(nx) + '</div><div class="af-bar"><i></i></div>'
          : t.ask ? '<div class="af-ask">' + esc(t.ask.question) + '</div>'
          : '<div class="af-t2' + (t.state === 'failed' ? ' err' : '') + '">' + esc(l2) + '</div>' + (nx ? '<div class="ap-next">' + esc(nx) + '</div>' : '')) +
        '<div class="af-btns">' + btns + '</div></div>';
    }
    node.addEventListener('click', e => {
      const btn = e.target.closest('button'); if (!btn || btn.disabled) return;
      e.preventDefault(); e.stopPropagation();
      const s = svc();
      if (btn.dataset.afGo) return go(btn.dataset.afGo);
      if (btn.dataset.afStart) return act(() => s.start(btn.dataset.afStart));
      if (btn.dataset.afAnswer) return act(() => s.answer(btn.dataset.afAnswer));
      const a = btn.dataset.afAct;
      if (a === 'stop') return act(() => s.stop());
      if (a === 'dismiss') return s.dismiss();
      if (a === 'continue') return act(() => s.submit('好，继续', { title: s.snapshot().task.title, source: 'main' }));
      if (a === 'decline') return act(() => s.submit('先不做了，停在这里，告诉我现在的状态。', { title: s.snapshot().task.title, source: 'main' }));
      const segEl = e.target.closest('[data-pref]'); if (segEl && btn.dataset.val != null) s.setPrefs({ [segEl.dataset.pref]: btn.dataset.val });
    });
    const unsub = svc().subscribe(render);
    node.__af = { cleanup: () => { unsub(); node.__af = null; } };
    return node.__af;
  }

  root.V7AgentZone = { RAIL, mountZone, mountFace, configure: o => { host = Object.assign(host, o || {}); }, tabs: () => RAIL.map(r => ({ id: r.id, name: r.name, group: r.group })) };
  // 换账号时，开着的旧「对话工作面」（设置中心那个入口开的模态窗）一律关掉，不让上一个账号的聊天窗口留在眼前。
  //   ⚠ 以前是三级详情随换账号重挂时「顺带」关掉的；助手卡没有三级以后没人关它了（实测 test-assistant-sessions 抓到），这里明确关。
  root.addEventListener('wheelchair:storage-context', () => { try { if (root.V7AssistantPanel && root.V7AssistantPanel.close) root.V7AssistantPanel.close({ restore: false }); } catch (_) {} });
})(typeof window !== 'undefined' ? window : null);
