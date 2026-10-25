// 账号登录（设置页卡片、使用说明里的第 2 步）、首次打开的使用说明、工作台里「这个平台还没登录」的提示。
// 登录在专用 Chrome 里做，这里只显示状态：helper 读专用 Chrome 的登录 cookie（见 helper/lib/accounts.mjs）。

const ACCOUNT_NAMES = { google: 'Google', chatgpt: 'ChatGPT' };
// 哪个平台要哪个账号
const PROVIDER_ACCOUNT = { aistudio: 'google', flow: 'google', chatgpt: 'chatgpt' };
let accounts = null; // { google: true|false|null, chatgpt: ..., chrome: {...} }
let guideShown = false;

function renderAccounts() {
  for (const el of document.querySelectorAll('[data-acc]')) {
    const v = accounts?.[el.dataset.acc];
    el.textContent = v === true ? '已登录' : v === false ? '未登录' : '';
    el.className = `acc-state ${v === true ? 'ok' : v === false ? 'no' : ''}`;
  }
  for (const b of document.querySelectorAll('[data-login]')) {
    const name = ACCOUNT_NAMES[b.dataset.login];
    b.textContent = accounts?.[b.dataset.login] ? `切换 ${name} 账号` : `用 ${name} 账号登录`;
    b.className = accounts?.[b.dataset.login] === false ? 'primary' : '';
  }
  renderProviderNote();
}

function renderProviderNote() {
  const site = PROVIDER_ACCOUNT[$('provider').value];
  const note = $('providerNote');
  const missing = site && accounts?.[site] === false;
  note.hidden = !missing;
  if (missing) note.innerHTML = `还没登录 ${ACCOUNT_NAMES[site]} 账号，这个平台会生成失败。<button class="link inline" data-login="${site}">现在登录</button>`;
}

async function refreshAccounts() {
  if (!work.health) return;
  try { accounts = await api('GET', '/accounts'); } catch { return; }
  renderAccounts();
}

document.addEventListener('click', (e) => {
  const site = e.target.closest('[data-login]')?.dataset.login;
  if (!site) return;
  action(async () => {
    await api('POST', '/accounts/login', { site });
    toast(`已在专用 Chrome 里打开 ${ACCOUNT_NAMES[site]} 登录页，登录好回到这里`);
  });
});
$('provider').addEventListener('change', renderProviderNote);

// ---------- 使用说明 ----------
function renderGuide() {
  if (!state) return;
  const ps = state.plugin.photoshops;
  const targets = ps.filter((p) => p.supported && p.hasPluginsDir);
  const installed = targets.filter((p) => p.installed);
  const el = $('gPlugin');
  el.textContent = !ps.length ? '没找到 Photoshop' : installed.length ? `已装进 ${installed.map((p) => p.name).join('、')}` : '未安装';
  el.className = `step-state ${installed.length ? 'ok' : 'no'}`;
  const btn = $('gInstall');
  btn.textContent = !targets.length ? '去设置页手动添加 Photoshop' : installed.length ? '重新安装' : '一键安装插件';
  btn.className = targets.length && !installed.length ? 'primary' : '';
}

function openGuide() {
  $('guide').hidden = false;
  renderGuide();
  refreshAccounts();
}

$('openGuide').addEventListener('click', openGuide);
$('guideDone').addEventListener('click', () => {
  $('guide').hidden = true;
  window.bridge.setOnboarded();
});
// 安装用设置页的同一个按钮（同一套安装、结果提示）
$('gInstall').addEventListener('click', async () => {
  if (!targetsOf(state.plugin).length) {
    $('guide').hidden = true;
    showTab('settings');
    return;
  }
  $('install').click();
});

// 出图后关不关专用 Chrome 里的标签页（helper 的运行中设置，改了立即生效）
let prefsLoaded = false;
async function loadPrefs() {
  try {
    const p = await api('GET', '/prefs');
    $('closeTabs').checked = p.closeTabsAfterDone;
    prefsLoaded = true;
  } catch {}
}
$('closeTabs').addEventListener('change', (e) => action(async () => {
  const p = await api('POST', '/prefs', { closeTabsAfterDone: e.target.checked });
  e.target.checked = p.closeTabsAfterDone;
  toast(p.closeTabsAfterDone ? '出图后会自动关闭标签页' : '出图后标签页会留在专用 Chrome 里');
}));

document.addEventListener('app-state', (e) => {
  if (!prefsLoaded && work.health) loadPrefs();
  if (!$('guide').hidden) renderGuide();
  // 第一次打开 App：弹出使用说明
  if (!guideShown && !e.detail.app.onboarded) {
    guideShown = true;
    openGuide();
  }
  if (!accounts) refreshAccounts();
});

// 设置页或使用说明开着时勤一点（等用户登录完），其他时候慢一点
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (!$('guide').hidden || !$('tab-settings').hidden) refreshAccounts();
}, 3000);
setInterval(() => { if (document.visibilityState === 'visible') refreshAccounts(); }, 15000);
window.addEventListener('focus', refreshAccounts);
