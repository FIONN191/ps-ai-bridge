(function (root) {
  'use strict';
  let helpSequence = 0;
  function create(panel, options) {
  const settings = options || {}, embedded = !!settings.embedded;
  let data = null;
  function esc(value) { const el = document.createElement('span'); el.textContent = String(value || ''); return el.innerHTML.replace(/"/g, '&quot;'); }
  function button(name, text, disabled) { return '<button type="button" class="settings-btn" data-action="' + name + '" ' + (disabled ? 'disabled' : '') + '>' + text + '</button>'; }
  function help(text) {
    if (embedded && root.V7CardArchitecture) return '<button type="button" class="v7-help" data-help-text="' + esc(text) + '" aria-label="说明：' + esc(text) + '">?</button>';
    const id = 'setup-help-' + (++helpSequence);
    return '<span class="setup-help"><button type="button" class="setup-help-trigger" aria-label="说明" aria-describedby="' + id + '">?</button><span class="setup-help-content" id="' + id + '" role="tooltip">' + esc(text) + '</span></span>';
  }
  function localMarkup(value, draft) {
    const local = value.localAssistant || {}, models = local.models || [], selected = value.state.localModel || '';
    return '<h4>本地聊天助手 · Ollama ' + help('本地模型会与 Photoshop 和图像引擎共用本机资源。请自行选择模型版本；本机测试只发送一条短文本，图片分析与工具能力取决于模型。') + '</h4><p ' + (local.error ? 'role="alert"' : 'role="status"') + '>' + esc(local.error || local.message || (local.running ? '本机运行时已连接 · ' + (local.version || '') : '尚未检测本地聊天运行时。')) + '</p>' +
      '<div class="settings-actions">' + button('local-detect','检测本机') + button('local-start','启动 Ollama',!local.installed||local.running) + button('local-download-runtime','下载官方运行时') + '</div>' +
      '<label class="settings-field"><span>已安装的本机模型</span><select data-action="local-model" ' + (!local.running ? 'disabled' : '') + '><option value="">选择模型</option>' + models.map(row => '<option value="' + esc(row.name) + '" ' + (selected === row.name ? 'selected' : '') + '>' + esc(row.name) + (row.size ? ' · ' + (row.size/1073741824).toFixed(2) + ' GiB' : '') + '</option>').join('') + '</select></label>' +
      '<div class="settings-actions">' + button('local-test','本机测试并启用',!local.running||!selected) + '</div>' +
      '<label class="settings-field"><span>待下载模型名称与版本</span><input type="text" maxlength="120" data-action="local-model-tag" value="' + esc(draft) + '" placeholder="模型名称:版本" autocomplete="off" spellcheck="false"></label>' +
      '<div class="settings-actions">' + button('local-model-library','官方模型库') + button('local-pull','确认下载所填模型',!local.running) + '</div>' +
      '';
  }
  function photoshopCompatMarkup(value) {
    const selected = value.state?.photoshopPath || '';
    return '<div class="setup-step-compat" hidden aria-hidden="true"><label>Photoshop 版本<select data-action="ps"><option value="">选择版本</option>' + (value.candidates || []).map(c => '<option value="' + esc(c.path) + '" ' + (c.path === selected ? 'selected' : '') + '>' + esc(c.version) + ' · ' + esc(c.path) + '</option>').join('') + '</select></label></div>';
  }
  let activeStep = embedded ? Number(settings.step ?? 1) : 0, lastAgreed = null, lastSession = null, tutorialKey = '';
  const escapeHandler = event => { if (event.key === 'Escape' && !embedded) send('close'); };
  function applyTheme(theme) {
    const root = document.documentElement, t = theme || {};
    if (t.blur !== undefined) root.style.setProperty('--blur', Math.max(0, Number(t.blur) || 0) + 'px');
    if (t.opacity !== undefined) {
      const value = Math.max(.35, Math.min(1, Number(t.opacity) / 100));
      // Keep the setting available to background layers only. Applying opacity
      // to the setup document/body would also fade labels, controls and previews.
      root.style.setProperty('--ui-opacity', value);
      root.style.setProperty('--ui-bg-opacity', value);
    }
    if (t.themeAccent) root.style.setProperty('--accent', t.themeAccent);
    if (t.themeText) root.style.setProperty('--tx', t.themeText);
    if (t.themeCardBg) root.style.setProperty('--workbench-bg', t.themeCardBg);
  }
  function paint(value) {
    if (!value?.session) return;
    if (value.session !== lastSession) { activeStep = embedded ? Number(settings.step ?? 1) : 0; lastAgreed = null; tutorialKey = ''; lastSession = value.session; }
    const wasAgreed = lastAgreed;
    data = value; if (!embedded) applyTheme(value.theme);
    panel.setAttribute('aria-busy', String(data.busy));
    // ⚠⚠ 2026-10-14（用户定：教程要重做）：这里原来是
    //     if (value.required && !value.tutorial?.complete) { paintTutorial(); return; }
    //   —— 首启第一件事是"必须看一遍入门教程"，没看完就【只画教程面板】。
    //   教程删了、setup-center 也不再发 tutorial 这一项了 ⇒ 这一句必须摘掉：
    //   不摘的话 `value.tutorial?.complete` 永远是 falsy ⇒ 首启会永远只画教程面板，
    //   而 paintTutorial() 又没东西可画（data.tutorial 是 undefined）⇒ 【真空白】。
    //   重做教程时把这一句和下面的 paintTutorial() 一起加回来（清单见 docs/217）。
    // After the first consent action, move directly to Photoshop linking so
    // the next actionable step is visible without an extra navigation click.
    if (value.agreed && wasAgreed === false && activeStep === 0) activeStep = 1;
    lastAgreed = !!value.agreed;
    const localDraft = panel.querySelector('[data-action="local-model-tag"]')?.value || '';
    const scroll = panel.querySelector('[data-setup-scroll]'), position = scroll ? scroll.scrollTop : 0;
    const focus = document.activeElement?.dataset?.action;
    const s = data.state, agreed = data.agreed, selected = data.candidates.find(c => c.path === s.photoshopPath);
    if (embedded && !data.terms) activeStep = Number(settings.step ?? 1);
    if (data.terms) activeStep = 0;
    if (!agreed && activeStep > 0) activeStep = 0;
    panel.setAttribute('aria-busy', String(data.busy));
    const heading = embedded ? '' : '<header class="v7-setup-heading"><div><h2>' + (data.required ? '首次使用设置' : '开始设置') + '</h2><p>' + (data.required ? '完成入门教程并确认使用条款即可进入；Photoshop 联动、图像服务和助手都可稍后设置。' : '检查联动和服务配置。') + '</p></div>' + button(data.required ? 'quit' : 'close', data.required ? '退出软件' : '关闭') + '</header>';
    if (data.terms) {
      panel.innerHTML = heading + '<div class="v7-setup-scroll" data-setup-scroll><fieldset class="setup-compat-fieldset" disabled aria-hidden="true"></fieldset><section><h3>' + esc(data.consent.title) + '</h3><p>' + esc(data.consent.body) + '</p><p>' + esc(data.consent.detail) + '</p></section></div><footer class="v7-setup-footer"><div class="settings-actions">' + button('terms-back', '返回', data.busy) + button('terms-accept', agreed ? '已同意，返回' : '我知道了并同意', data.busy) + '</div></footer>';
    } else {
      const steps = [['隐私与费用', agreed], ['Photoshop 联动', data.bridgeReady], ['图像服务', data.providerReady], ['语言助手', data.assistantReady || s.skipAssistant]];
      const nav = embedded ? '' : '<nav class="v7-setup-steps" aria-label="设置步骤" role="tablist">' + steps.map(([title, done], i) => '<button type="button" role="tab" aria-selected="' + (i === activeStep) + '" class="' + (done ? 'done ' : '') + (i === activeStep ? 'active' : '') + '" data-action="step" data-step-index="' + i + '"><span>' + (i + 1) + '</span>' + title + '</button>').join('') + '</nav>';
      let content = '';
      if (activeStep === 0) content = '<section><h3>隐私、数据、安全性与费用</h3><p>' + (agreed ? '已记录本机条款同意。API Key 云同步、在线人数统计和助手图片发送分别确认。' : '请先阅读并同意使用条款，之后再开始使用软件。') + '</p>' + button('consent', agreed ? '查看使用条款' : '阅读并同意', data.busy) + '</section>';
      if (activeStep === 1) content = '<fieldset ' + (!agreed || data.busy ? 'disabled' : '') + '><section><h3>Photoshop 联动 ' + help('安装前请保存并关闭 Photoshop。安装后打开 Photoshop 的增效工具中的桥接面板，再等待连接确认。首次使用必须收到 Photoshop 桥接的真实响应。') + '</h3><label class="settings-field"><span>Photoshop 版本</span><select data-action="ps"><option value="">选择版本</option>' + data.candidates.map(c => '<option value="' + esc(c.path) + '" ' + (c.path === s.photoshopPath ? 'selected' : '') + '>' + esc(c.version) + ' · ' + esc(c.path) + '</option>').join('') + '</select></label><div class="settings-actions">' + button('detect', '重新检测') + button('choose', '手动选择') + '</div><p data-setup-bridge>' + (data.bridgeReady ? '桥接已响应，可以读取 Photoshop。' : '尚未收到 Photoshop 桥接响应。') + '</p><div class="settings-actions">' + button('install','安装 / 修复桥接',!selected) + button('launch','打开 Photoshop',!selected) + (s.backupId ? button('rollback','恢复上次桥接',!selected) : '') + '</div><label class="v7-setup-check"><input type="checkbox" data-action="autolaunch" ' + (s.autoLaunch !== false ? 'checked' : '') + '>启动软件时联动打开所选 Photoshop</label></section></fieldset>';
      if (activeStep === 2) content = '<fieldset ' + (!agreed || data.busy ? 'disabled' : '') + '><section><h3>图像服务</h3><p>' + (data.providerReady ? '已填写自己的图像服务。是否可用以服务商实际返回为准。' : '填写服务商 URL 与 API Key；生成费用由所选服务商收取。') + '</p>' + button('provider','设置图像 API',data.busy) + '</section></fieldset>';
      if (activeStep === 3) content = '<fieldset ' + (!agreed || data.busy ? 'disabled' : '') + '><section><h3>语言助手</h3><p>' + (data.assistantReady ? '当前语言模型已经通过连接测试。' : '本机助手尚未启用，可稍后设置。') + '</p>' + localMarkup(data, localDraft) + '<div class="settings-actions">' + button('assistant','其他语言模型连接',data.busy) + '</div><label class="v7-setup-check"><input type="checkbox" data-action="skip" ' + (s.skipAssistant ? 'checked' : '') + '>暂不启用助手' + help('暂不启用时，聊天答疑、模型评图、Agent 软件修改和助手自动修图不可用；手动预设生图与其他已就绪能力仍可使用。云端建议须在助手中主动开启，并确认费用和图片范围。') + '</label>' + '</section></fieldset>';
      const prev = !embedded && activeStep > 0 ? button('step', '上一步') : ''; const next = !embedded && activeStep < 3 ? button('step', '下一步') : '';
      const setupCompat = !agreed ? '<fieldset class="setup-compat-fieldset" disabled aria-hidden="true"></fieldset>' : '';
      // Keep the local-assistant actions mounted while another step is active.
      // Older host smoke tests and keyboard automation query the whole setup
      // surface; the hidden copy remains delegated to the same action handler.
      const localCompat = activeStep === 3 ? '' : '<div class="setup-step-compat" hidden aria-hidden="true">' + localMarkup(data, localDraft) + '</div>';
      const photoshopCompat = activeStep === 1 ? '' : photoshopCompatMarkup(data);
      const serviceCompat = activeStep === 2 ? '' : '<div class="setup-step-compat" hidden aria-hidden="true">' + button('provider', '设置图像 API') + '</div>';
      const assistantCompat = activeStep === 3 ? '' : '<div class="setup-step-compat" hidden aria-hidden="true">' + '<label class="v7-setup-check"><input type="checkbox" data-action="skip" ' + (s.skipAssistant ? 'checked' : '') + '>暂不启用助手</label>' + button('assistant', '其他语言模型连接') + '</div>';
      panel.innerHTML = heading + nav + setupCompat + '<div class="v7-setup-scroll" data-setup-scroll>' + content + localCompat + photoshopCompat + serviceCompat + assistantCompat + (data.notice ? '<p role="status">' + esc(data.notice) + '</p>' : '') + '</div><footer class="v7-setup-footer"><div class="setup-footer-nav">' + prev + next + '</div><div class="settings-actions">' + (data.required || !embedded && activeStep === 3 ? button('finish',data.required ? '进入软件（稍后配置）' : '完成设置',!data.canFinish) : '') + (embedded ? button('consent','使用条款',data.busy) : '') + button('guide','使用说明',data.required&&!data.canFinish) + '</div></footer>';
      const stepButtons = panel.querySelectorAll('[data-action="step"]');
      stepButtons.forEach(el => { if (!el.dataset.stepIndex) el.dataset.stepIndex = String(el.textContent.includes('上一步') ? activeStep - 1 : activeStep + 1); });
    }
    const restored = panel.querySelector('[data-setup-scroll]'); if (restored) restored.scrollTop = position;
    if (focus === 'step') panel.querySelector('[data-step-index="' + activeStep + '"]')?.focus({ preventScroll: true });
    else if (focus) panel.querySelector('[data-action="' + focus + '"]')?.focus({ preventScroll: true });
  }
  // ⚠⚠ 2026-10-14：原 paintTutorial() 【整个函数已删除】（用户定：教程要重做）。
  //   它原来画的是首启第一步「先看一遍基本操作」：标题 + 进度（第 N / 3 节）
  //   + root.V7Tutorial.markup(lesson.id) + 「下一节 / 进入使用条款」按钮 + 等待秒数。
  //   ⚠ 它的调用点（paint 里那一句）也已经一起摘掉了 —— 不能只删函数留调用。
  //   ⚠ 重做时要恢复的东西（清单见 docs/217）：
  //     · 这个函数本体（含 data-tutorial-wait / data-setup-tutorial-notice 两个占位）
  //     · paint() 里那句 `if (value.required && !value.tutorial?.complete) { paintTutorial(); return; }`
  //     · tutorialKey 这个模块级变量（第 46 行那句重置也要跟着回来）
  //     · setup-center.js 的 run.tutorial / model().tutorial / 三处闸门
  //     · ui-pure/tutorial.js（V7Tutorial 模块，含 markup/playback/lessons/version）
  async function send(action, value) {
    if (!data || data.busy && !['close','quit'].includes(action)) return;
    if (!['close','quit'].includes(action)) { data = { ...data, busy: true }; panel.setAttribute('aria-busy','true'); }
    await settings.send({ session: data.session, action, value });
  }
  const onClick = event => {
    const button = event.target.closest('button[data-action]');
    if (button && !button.disabled) {
      if (button.dataset.action === 'step') { activeStep = Math.max(0, Math.min(3, Number(button.dataset.stepIndex))); paint(data); return; }
      send(button.dataset.action, button.dataset.action === 'terms-accept' ? data.consent.version : button.dataset.action === 'local-pull' ? panel.querySelector('[data-action="local-model-tag"]').value : undefined);
    }
  };
  const onChange = event => { if (event.target.dataset.action && event.target.dataset.action !== 'local-model-tag') send(event.target.dataset.action, event.target.type === 'checkbox' ? event.target.checked : event.target.value); };
  panel.addEventListener('click', onClick); panel.addEventListener('change', onChange);
  document.addEventListener('keydown', escapeHandler);
  return { paint, dispose() { panel.removeEventListener('click',onClick); panel.removeEventListener('change',onChange); document.removeEventListener('keydown',escapeHandler); } };
  }
  root.V7SetupRenderer = { create };
  const panel = document.getElementById('setup-panel');
  if (panel && root.setupwin) { const renderer = create(panel,{send: value => root.setupwin.action(value)}); root.setupwin.onData(renderer.paint); }
})(window);
