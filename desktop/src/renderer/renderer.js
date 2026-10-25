// 设置页：插件安装、本机服务、专用浏览器、开机自启
let state = null;
let busy = false;
let lastResult = null; // { kind: 'ok' | 'err', html }

// 能装的：版本够新、有 Plug-ins 文件夹
const targetsOf = (p) => p.photoshops.filter((ps) => ps.supported && ps.hasPluginsDir);

function psState(ps, version) {
  if (!ps.supported) return ['bad', '版本太旧，需要 Photoshop 2024（25.0）以上'];
  if (!ps.hasPluginsDir) return ['bad', '找不到 Plug-ins 文件夹'];
  if (ps.installed && cmp(ps.installed, version) >= 0) return ['ok', `已安装 v${ps.installed}`];
  if (ps.installed) return ['old', `已安装 v${ps.installed}，可更新`];
  return ['', '未安装'];
}

function renderPlugin(p) {
  $('bundled').textContent = `插件 v${p.version}`;
  $('psList').innerHTML = p.photoshops.length
    ? p.photoshops.map((ps) => {
      const [cls, text] = psState(ps, p.version);
      return `<li>
        <div>
          <div><span class="ps-name">${esc(ps.name)}</span><span class="ps-ver">${esc(ps.version)}</span></div>
          <div class="ps-path">${esc(ps.pluginsDir)}${ps.custom ? `<button class="link ps-remove" data-remove="${esc(ps.root)}">移除</button>` : ''}</div>
        </div>
        <span class="ps-state ${cls}">${text}</span>
      </li>`;
    }).join('')
    : '<li class="mute">没找到 Photoshop。装在别的位置的话，点「手动添加 Photoshop…」选它的安装文件夹。</li>';

  const targets = targetsOf(p);
  const pending = targets.filter((ps) => !ps.installed || cmp(ps.installed, p.version) < 0);
  const install = $('install');
  install.disabled = busy || !targets.length;
  install.className = pending.length || !targets.length ? 'primary' : '';
  install.textContent = busy ? '正在安装…' : !pending.length && targets.length ? '重新安装' : pending.some((ps) => ps.installed) ? '更新插件' : '一键安装插件';
  $('uninstall').hidden = !p.photoshops.some((ps) => ps.installed);
  $('uninstall').disabled = busy;

  const parts = [];
  if (lastResult) parts.push(lastResult.html);
  if (p.cc && p.photoshops.some((ps) => ps.installed)) {
    parts.push(`<p>Creative Cloud 里也装了一份 v${esc(p.cc)}，和 Plug-ins 里的会冲突。留一份就好：Creative Cloud 的在 Creative Cloud → 增效工具 → 管理增效工具 里卸载，Plug-ins 的点上面「卸载」。</p>`);
  }
  for (const ps of p.photoshops) {
    for (const dir of ps.others) parts.push(`<p>${esc(ps.name)} 的 Plug-ins 里还有一份同样的插件：<br>${esc(dir)}<br>两份同时在会冲突，建议删掉这份旧的。</p>`);
  }
  const notice = $('pluginNotice');
  notice.hidden = !parts.length;
  notice.className = `notice${lastResult?.kind === 'err' ? ' err' : ''}${!lastResult && parts.length ? ' warn' : ''}`;
  notice.innerHTML = parts.join('');
}

function renderHelper(h) {
  const [cls, text] = STATUS[h.status] || ['', h.status];
  for (const id of ['helperStatus', 'topStatus']) {
    const el = $(id);
    el.querySelector('.dot').className = `dot ${cls}`;
    el.querySelector('span').textContent = id === 'topStatus' ? `本机服务${text}` : `${text}${h.version ? ` · v${h.version}` : ''}`;
  }
  const detail = $('helperDetail');
  detail.style.color = h.error ? 'var(--err)' : '';
  detail.textContent = h.error
    || (h.status === 'external'
      ? `端口 ${h.port} 上已经有一个 helper（多半是「启动 helper.command」开的），桌面端直接用它；关掉那个终端窗口后桌面端会自动接管。`
      : `127.0.0.1:${h.port}。Photoshop 面板通过它调用各个生图平台，关掉窗口后会在后台继续运行。`);
}

function renderHealth(health) {
  if (!health) {
    $('providers').innerHTML = '<li class="mute">本机服务就绪后显示</li>';
    return;
  }
  const c = health.chrome || {};
  const name = /edge/i.test(c.path || '') ? 'Microsoft Edge' : 'Google Chrome';
  $('chromeText').textContent = c.found
    ? `网页平台（AI Studio、Flow、ChatGPT）不需要 API Key，用你自己的账号，在一个单独的 ${name} 窗口里生图，和你平时用的浏览器互不影响。登录一次即可，之后出图时它在后台运行。`
    : '没找到 Google Chrome（Windows 上也没找到 Edge）。网页平台需要它，请先安装 Google Chrome。';
  $('providers').innerHTML = displayProviders(health.providers)
    .map(([, p]) => `<li class="${p.available ? 'yes' : 'no'}">${esc(p.label)}${p.available ? '' : `（${esc(p.note || '不可用')}）`}</li>`).join('');
}

async function refresh() {
  try {
    state = await window.bridge.state();
  } catch (e) {
    toast(reason(e), true);
    return;
  }
  $('appMeta').textContent = `桌面端 v${state.app.version}`;
  $('openAtLogin').checked = state.app.openAtLogin;
  renderPlugin(state.plugin);
  renderHelper(state.helper);
  renderHealth(state.helper.health);
  // 工作台（workspace.js）跟着更新平台列表、端口
  document.dispatchEvent(new CustomEvent('app-state', { detail: state }));
  maybePromptPluginUpdate();
}

// App 更新后自带的插件变新了，但装在 Photoshop 里的还是旧的：打开时提示一次（使用说明、桌面端更新弹窗先走完）
let pluginPrompted = false;
function maybePromptPluginUpdate() {
  if (pluginPrompted || busy || !$('guide').hidden || !$('updateModal').hidden) return;
  const v = state.plugin.version;
  const old = targetsOf(state.plugin).filter((ps) => ps.installed && cmp(ps.installed, v) < 0);
  if (!old.length) return;
  pluginPrompted = true;
  $('pmText').textContent = `${old.map((ps) => `${ps.name} 里装的是 v${ps.installed}`).join('、')}，新版是 v${v}。更新后重启 Photoshop 才生效${state.plugin.psRunning ? '（Photoshop 正在运行，先保存好文件）' : ''}。`;
  $('pluginModal').hidden = false;
}
$('pmLater').addEventListener('click', () => { $('pluginModal').hidden = true; });
$('pmUpdate').addEventListener('click', () => {
  $('pluginModal').hidden = true;
  showTab('settings');
  $('install').click();
});

$('checkPluginUpdate').addEventListener('click', () => action(async () => {
  $('checkPluginUpdate').disabled = true;
  try {
    await refresh(); // 先重新看一遍 Photoshop 里装的是哪个版本
    const r = await window.bridge.checkPluginUpdate();
    const targets = targetsOf(state.plugin);
    if (!targets.length) return toast('没找到可以装插件的 Photoshop', true);
    const outdated = targets.filter((ps) => !ps.installed || cmp(ps.installed, r.bundled) < 0);
    if (outdated.length) {
      lastResult = { kind: 'ok', html: `<p>插件有新版本 v${esc(r.bundled)}（${outdated.map((ps) => `${esc(ps.name)} ${ps.installed ? `装的是 v${esc(ps.installed)}` : '还没装'}`).join('、')}）。点上面的「更新插件」，然后重启 Photoshop。</p>` };
      renderPlugin(state.plugin);
      return;
    }
    if (r.latestPlugin && cmp(r.latestPlugin, r.bundled) > 0) {
      toast(`插件 v${r.latestPlugin} 跟着桌面端 v${r.desktop.latest} 发布，先更新桌面端`);
      await window.bridge.checkUpdate(); // 弹出「发现新版本」
      return;
    }
    if (r.desktop.status === 'error') toast(`Photoshop 里的插件和 App 自带的一样（v${r.bundled}），但没连上 GitHub 查更新的版本`, true);
    else toast(`插件已经是最新版本（v${r.bundled}）`);
  } finally {
    $('checkPluginUpdate').disabled = false;
  }
}));

async function action(fn) {
  try { await fn(); } catch (e) { toast(reason(e), true); }
}

$('install').addEventListener('click', async () => {
  const targets = targetsOf(state.plugin);
  busy = true;
  lastResult = null;
  renderPlugin(state.plugin);
  try {
    await window.bridge.installPlugin(targets.map((ps) => ps.pluginsDir));
    await refresh();
    const next = state.plugin.psRunning
      ? '<strong>Photoshop 正在运行</strong>：保存好文件，退出后重新打开 Photoshop，插件才会出现。'
      : '打开 Photoshop，在菜单「增效工具 → AI 生图贴回」里打开面板。';
    lastResult = { kind: 'ok', html: `<p>✓ 已装进 ${targets.length} 个 Photoshop。${next}</p>` };
  } catch (e) {
    lastResult = { kind: 'err', html: `<p>没装上：${esc(reason(e))}</p>` };
  }
  busy = false;
  await refresh();
});

$('uninstall').addEventListener('click', async () => {
  const installed = state.plugin.photoshops.filter((ps) => ps.installed);
  if (!confirm(`从 ${installed.map((ps) => ps.name).join('、')} 里卸载插件？`)) return;
  busy = true;
  lastResult = null;
  renderPlugin(state.plugin);
  try {
    await window.bridge.uninstallPlugin(installed.map((ps) => ps.pluginsDir));
    lastResult = { kind: 'ok', html: '<p>已卸载。重启 Photoshop 后面板消失。</p>' };
  } catch (e) {
    lastResult = { kind: 'err', html: `<p>没卸掉：${esc(reason(e))}</p>` };
  }
  busy = false;
  await refresh();
});

$('viaCC').addEventListener('click', async () => {
  if (!confirm('改用 Creative Cloud 安装：先把 Plug-ins 里的这份插件卸载，再把安装包交给 Creative Cloud，按它弹出的提示确认安装，然后重启 Photoshop。\n\n需要已经装好 Creative Cloud 桌面程序。继续？')) return;
  busy = true;
  lastResult = null;
  renderPlugin(state.plugin);
  try {
    const installed = state.plugin.photoshops.filter((ps) => ps.installed);
    if (installed.length) await window.bridge.uninstallPlugin(installed.map((ps) => ps.pluginsDir));
    await window.bridge.installViaCC();
    lastResult = { kind: 'ok', html: '<p>已交给 Creative Cloud。按它的提示完成安装，然后重启 Photoshop。</p>' };
  } catch (e) {
    lastResult = { kind: 'err', html: `<p>${esc(reason(e))}</p>` };
  }
  busy = false;
  await refresh();
});

$('addPs').addEventListener('click', () => action(async () => { if (await window.bridge.addPhotoshop()) await refresh(); }));
$('psList').addEventListener('click', (e) => {
  const root = e.target.dataset?.remove;
  if (root) action(async () => { await window.bridge.removePhotoshop(root); await refresh(); });
});

$('openConsole').addEventListener('click', () => action(() => window.bridge.open('console')));
$('restartHelper').addEventListener('click', () => action(async () => { await window.bridge.restartHelper(); toast('本机服务已重启'); }));
$('openOutput').addEventListener('click', () => action(() => window.bridge.open('output')));
$('openConfig').addEventListener('click', () => action(() => window.bridge.open('config')));
$('openData').addEventListener('click', () => action(() => window.bridge.open('data')));
$('openLogFile').addEventListener('click', () => action(() => window.bridge.open('logs')));
$('openAtLogin').addEventListener('change', (e) => action(async () => { e.target.checked = await window.bridge.setOpenAtLogin(e.target.checked); }));

$('toggleLogs').addEventListener('click', async () => {
  const box = $('logsBox');
  box.hidden = !box.hidden;
  $('toggleLogs').textContent = box.hidden ? '查看日志' : '收起日志';
  if (!box.hidden) {
    $('logs').textContent = await window.bridge.logs();
    $('logs').scrollTop = $('logs').scrollHeight;
  }
});

window.bridge.onLog((line) => {
  if ($('logsBox').hidden) return;
  const pre = $('logs');
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
  pre.textContent = `${pre.textContent}\n${line}`.split('\n').slice(-2000).join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
});

window.bridge.onHelper((h) => {
  renderHelper(h);
  // 刚就绪时顺便取一次平台列表
  if (h.status === 'running' || h.status === 'external') refresh();
});

window.addEventListener('focus', refresh);
setInterval(() => { if (document.visibilityState === 'visible' && !busy) refresh(); }, 10000);
refresh();
