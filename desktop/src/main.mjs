// 桌面端主进程：托管本机 helper（Photoshop 插件连的 127.0.0.1:47811），一键把插件装进 Photoshop，关窗口后留在托盘/菜单栏。
import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, nativeTheme, dialog, clipboard } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HelperProcess, loginShellPath, waitForHelperReady } from './helper-process.mjs';
import { createInstaller, isPhotoshopRunning } from './plugin-installer.mjs';
import { Updater } from './updater.mjs';
import { createOrganizerDesktop } from './organizer-desktop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '..', 'assets');
// 打包后 helper 和插件放在 resources 里（electron-builder 的 extraResources）；开发时直接用仓库里的
const REPO = path.resolve(here, '..', '..');
const RES = app.isPackaged ? process.resourcesPath : REPO;
const HELPER_DIR = path.join(RES, 'helper');
const PLUGIN_DIR = path.join(RES, 'plugin');
// 夏三七的修图轮椅 V7（界面、PS 桥接插件、Electron 主程序），由 scripts/import-v7.mjs 从官方安装包导入
const V7_DIR = path.join(RES, 'v7');
const PORT = Number(process.env.PS_AI_BRIDGE_PORT) || 47811;

let DATA_DIR = '';
let USER_CONFIG = '';
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let win = null;
let tray = null;
let quitting = false;
let helper = null;
let installer = null;
let updater = null;
let startHidden = false;
let organizerDesktop = null;

const readSettings = () => {
  try { return { customRoots: [], ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { customRoots: [] }; }
};
const writeSettings = (patch) => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
};

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// 修图轮椅 V7 的悬浮面板是主界面；V7 主程序把恢复面板的方法挂在 __PSAI_V7_HOST__ 上
function showPanel() {
  if (globalThis.__PSAI_V7_HOST__?.showPanel) globalThis.__PSAI_V7_HOST__.showPanel();
  else showWindow();
}

function showWindow() {
  if (!helper) return; // 还在启动，start() 会自己开窗口
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    title: 'AI 生图贴回',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#f6f6f4',
    icon: process.platform === 'win32' ? path.join(ASSETS, 'icon-win.png') : undefined,
    webPreferences: { preload: path.join(here, 'preload.cjs') },
  });
  if (process.platform !== 'darwin') win.removeMenu();
  organizerDesktop?.attachWindow(win);
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  // 启动时不弹这个窗口（主界面是修图轮椅面板）；首次使用要看说明时才弹
  win.once('ready-to-show', () => { if (!startHidden && !readSettings().onboarded) win.show(); });
  // 页面里的外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  let hintedTray = false;
  win.on('close', (e) => {
    if (quitting) return;
    // 关窗口只是藏起来，helper 继续跑，Photoshop 插件照常能用
    e.preventDefault();
    win.hide();
    if (process.platform === 'win32' && !hintedTray && tray) {
      hintedTray = true;
      tray.displayBalloon({ title: 'AI 生图贴回仍在运行', content: '本机服务在后台继续工作。右下角托盘图标可以打开主窗口或退出。', iconType: 'info' });
    }
  });
}

const STATUS_TEXT = {
  starting: '本机服务启动中…',
  running: '本机服务运行中',
  external: '本机服务运行中（外部启动）',
  restarting: '本机服务重启中…',
  error: '本机服务出错',
  stopped: '本机服务已停止',
};

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`AI 生图贴回 · ${STATUS_TEXT[helper.state.status] || ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: STATUS_TEXT[helper.state.status] || '本机服务', enabled: false },
    { type: 'separator' },
    { label: '显示修图轮椅面板', click: showPanel },
    { label: '设置与免 API 生图', click: showWindow },
    { label: '打开控制台', click: () => openTarget('console') },
    { label: '打开专用 Chrome', click: () => openTarget('chrome').catch((e) => dialog.showErrorBox('打不开专用 Chrome', e.message)) },
    { label: '检查更新', click: () => { showWindow(); updater.check({ manual: true }); } },
    { type: 'separator' },
    { label: '退出 AI 生图贴回', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = process.platform === 'darwin'
    ? nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (process.platform !== 'darwin') tray.on('click', showWindow);
  updateTray();
}

async function openTarget(what) {
  const health = await helper.health();
  if (what === 'console') return shell.openExternal(`http://127.0.0.1:${PORT}`);
  if (what === 'chrome') {
    if (!health) throw new Error('本机服务没有运行');
    const r = await fetch(`http://127.0.0.1:${PORT}/chrome/open`, { method: 'POST', headers: { 'x-ps-ai-bridge': '1' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return;
  }
  if (what === 'logs') return shell.showItemInFolder(helper.logFile);
  if (what === 'data') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return shell.openPath(DATA_DIR);
  }
  if (what === 'output') {
    const dir = health?.outputDir || path.join(os.homedir(), 'Pictures', 'AI生图', 'ps-ai-bridge');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  }
  if (what === 'config') {
    // 只放用户常改的几项；其余沿用 helper 的默认值（config.example.json）
    if (!fs.existsSync(USER_CONFIG)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(USER_CONFIG, `${JSON.stringify({ geminiApiKey: '', openaiApiKey: '' }, null, 2)}\n`);
    }
    const err = await shell.openPath(USER_CONFIG);
    if (err) shell.showItemInFolder(USER_CONFIG);
    return;
  }
  throw new Error(`未知目标：${what}`);
}

async function collectState() {
  const settings = readSettings();
  const [photoshops, psRunning, health] = await Promise.all([
    installer.findPhotoshops(settings.customRoots),
    isPhotoshopRunning(),
    helper.health(),
  ]);
  return {
    app: { version: app.getVersion(), platform: process.platform, openAtLogin: app.getLoginItemSettings().openAtLogin, dataDir: DATA_DIR, onboarded: Boolean(settings.onboarded) },
    helper: { ...helper.state, health },
    plugin: { ...installer.bundled, photoshops, psRunning, cc: installer.ccInstalled() },
  };
}

// 工作台通过主进程调 helper：页面是 file:// 打开的，直接 fetch 会被跨域拦（helper 要求自定义请求头）
const helperUrl = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`bad helper path: ${p}`);
  return `http://127.0.0.1:${PORT}${p}`;
};
async function helperApi(method, p, body, { signal } = {}) {
  await waitForHelperReady(helper,{signal});
  const post = method !== 'GET';
  const r = await fetch(helperUrl(p), {
    method, signal,
    headers: post ? { 'x-ps-ai-bridge': '1', 'content-type': 'application/json' } : {},
    body: post ? JSON.stringify(body || {}) : undefined,
  }).catch(() => { throw new Error('本机服务没有运行'); });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'avif', 'bmp'];

function registerIpc() {
  organizerDesktop.registerIpc();
  ipcMain.handle('state', () => collectState());
  ipcMain.handle('pack:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择 JSON 文件', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    if (fs.statSync(r.filePaths[0]).size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
    return { name: path.basename(r.filePaths[0]), data: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) };
  });
  ipcMain.handle('pack:save', async (_e, name, data) => {
    const r = await dialog.showSaveDialog(win, { title: '导出数据包', defaultPath: String(name || 'presets.json').replace(/[/\\]/g, '_'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    return r.filePath;
  });
  ipcMain.handle('api', (_e, method, p, body) => helperApi(method, p, body));
  // 本地图片 → helper 统一转成上传图（摆正、转 sRGB、限制长边）
  ipcMain.handle('upload:files', async (_e, files, maxSide) => {
    const out = [];
    for (const f of files) out.push(await helperApi('POST', '/uploads/from-file', { path: f, maxSide }));
    return out;
  });
  ipcMain.handle('upload:pick', async (_e, maxSide, multiple) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片',
      filters: [{ name: '图片', extensions: IMAGE_EXTS }],
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) out.push(await helperApi('POST', '/uploads/from-file', { path: f, maxSide }));
    return out;
  });
  ipcMain.handle('upload:clipboard', async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) throw new Error('剪贴板里没有图片');
    const r = await fetch(helperUrl('/uploads'), { method: 'POST', headers: { 'x-ps-ai-bridge': '1', 'content-type': 'image/png' }, body: img.toPNG() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '上传失败');
    const { width, height } = img.getSize();
    return { uploadId: d.uploadId, width, height, name: '剪贴板图片' };
  });
  ipcMain.handle('job:reveal', async (_e, jobId) => {
    const j = await helperApi('GET', `/jobs/${encodeURIComponent(jobId)}`);
    if (j.result?.path) shell.showItemInFolder(j.result.path);
    else shell.openPath(j.dir);
  });
  ipcMain.handle('job:copyImage', async (_e, p) => {
    const r = await fetch(helperUrl(p));
    if (!r.ok) throw new Error('取不到这张图');
    const img = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer()));
    if (img.isEmpty()) throw new Error('这张图的格式没法放进剪贴板，用「在文件夹中显示」');
    clipboard.writeImage(img);
  });
  ipcMain.handle('clipboard:text', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('logs', () => helper.logs.join('\n'));
  ipcMain.handle('helper:restart', () => helper.restart());
  ipcMain.handle('open', (_e, what) => openTarget(what));
  ipcMain.handle('plugin:install', async (_e, dirs) => { await installer.install(dirs); });
  ipcMain.handle('plugin:uninstall', async (_e, dirs) => { await installer.uninstall(dirs); });
  ipcMain.handle('plugin:installViaCC', async () => {
    const err = await shell.openPath(installer.makeCcx());
    if (err) throw new Error(`没能交给 Creative Cloud（${err}）。先装好 Creative Cloud 桌面程序再试`);
  });
  ipcMain.handle('plugin:addPhotoshop', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 Photoshop 的安装文件夹',
      message: '选里面有 Plug-ins 文件夹的那一层（比如「Adobe Photoshop 2025」）',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return false;
    // 选成了 Plug-ins 本身也认
    let root = r.filePaths[0];
    if (path.basename(root).toLowerCase() === 'plug-ins') root = path.dirname(root);
    if (!fs.existsSync(path.join(root, 'Plug-ins'))) throw new Error('这个文件夹里没有 Plug-ins，不像 Photoshop 的安装文件夹');
    writeSettings({ customRoots: [...new Set([...readSettings().customRoots, root])] });
    return true;
  });
  ipcMain.handle('plugin:removePhotoshop', (_e, root) => {
    writeSettings({ customRoots: readSettings().customRoots.filter((r) => r !== root) });
  });
  ipcMain.handle('settings:onboarded', () => writeSettings({ onboarded: true }));
  // 自动更新
  ipcMain.handle('update:state', () => updater.state);
  ipcMain.handle('update:check', async () => { await updater.check({ manual: true }); return updater.state; });
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('update:open-installer', () => updater.openInstaller());
  ipcMain.handle('update:skip', () => updater.skip());
  ipcMain.handle('update:dismiss', () => updater.dismiss());
  ipcMain.handle('update:quit', () => app.quit());
  // 检查插件更新：App 自带的插件版本 + 网上最新一版桌面端带的插件版本（比自带的新，就得先更新桌面端）
  ipcMain.handle('plugin:checkUpdate', async () => {
    await updater.check();
    return { bundled: installer.bundled.version, latestPlugin: updater.state.latestPlugin, desktop: updater.state };
  });
  ipcMain.handle('settings:openAtLogin', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPanel);
  app.on('activate', showPanel);
  app.on('before-quit', () => {
    quitting = true;
    organizerDesktop?.dispose();
  });
  app.on('will-quit', (e) => {
    if (!helper?.child) return;
    e.preventDefault();
    helper.stop().finally(() => app.exit(0));
  });
  // 窗口关掉不退出：一直留在托盘/菜单栏
  app.on('window-all-closed', () => {});
  loadV7();
  // 不能在顶层 await app.whenReady()：ESM 入口没执行完之前 Electron 不发 ready，会一直卡住
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox('AI 生图贴回启动失败', e?.stack || String(e));
    app.exit(1);
  });
}

// 加载 V7 的 Electron 主程序（v7/ui/main.js，原样使用）。它自己注册 IPC、开悬浮面板、起 37889 端口的 PS 链路。
// 它缺的共享模块在 v7/foundation（我们补写）；要用到本程序能力的地方从 __PSAI_V7_HOST__ 取。
function loadV7() {
  const entry = path.join(V7_DIR, 'ui', 'main.js');
  if (!fs.existsSync(entry)) return;
  globalThis.__PSAI_V7_HOST__ = {
    createInstaller,
    pluginExtras: app.isPackaged ? [] : [path.join(REPO, 'LICENSE'), path.join(REPO, 'NOTICE')],
    isQuitting: () => quitting,
    showSettings: () => showWindow(),
  };
  // 面板加载完后把「Others」预填成本机免 API 生图（v7/foundation/renderer/free-api-connection.js）
  const freeApi = path.join(V7_DIR, 'foundation', 'renderer', 'free-api-connection.js');
  app.on('web-contents-created', (_e, contents) => {
    contents.on('did-finish-load', () => {
      if (!contents.getURL().endsWith('/v7/ui/ui.html') || !fs.existsSync(freeApi)) return;
      contents.executeJavaScript(fs.readFileSync(freeApi, 'utf8')).catch(() => {});
    });
  });
  try {
    createRequire(import.meta.url)(entry);
  } catch (e) {
    app.whenReady().then(() => dialog.showErrorBox('修图轮椅面板加载失败', e?.stack || String(e)));
  }
}

async function start() {
  // 数据目录和 helper 共用一份定义（helper 打包在 resources 里，只能按路径动态加载）
  ({ DATA_DIR, USER_CONFIG } = await import(pathToFileURL(path.join(HELPER_DIR, 'lib', 'paths.mjs')).href));
  // 开机自启时只进托盘，不弹窗口
  startHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (process.platform === 'win32') app.setAppUserModelId('com.fionn.psaibridge.desktop');
  installer = createInstaller({ sourceDir: PLUGIN_DIR, extras: app.isPackaged ? [] : [path.join(REPO, 'LICENSE'), path.join(REPO, 'NOTICE')] });
  helper = new HelperProcess({
    dir: HELPER_DIR,
    port: PORT,
    logFile: path.join(DATA_DIR, 'logs', 'helper.log'),
    env: { PATH: await loginShellPath() },
  });
  helper.on('change', (s) => { send('helper', s); updateTray(); });
  helper.on('log', (line) => send('log', line));
  updater = new Updater({ readSettings, writeSettings, log: (line) => helper.log(line) });
  updater.on('change', (s) => {
    send('update', s);
    if (win && !win.isDestroyed()) win.setProgressBar(s.status === 'downloading' ? s.percent / 100 : -1);
  });
  organizerDesktop = createOrganizerDesktop({ getWindow: () => win, onNotificationClick: showWindow, fetchJobs: signal => helperApi('GET','/jobs',undefined,{signal}), log: message => helper.log(message) });
  organizerDesktop.restore();
  registerIpc();
  createTray();
  createWindow();
  helper.start();
  // 打开 5 秒后查一次更新，之后每 6 小时查一次
  setTimeout(() => updater.check(), 5000);
  setInterval(() => updater.check(), 6 * 3600 * 1000);
}
