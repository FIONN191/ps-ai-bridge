// 专用 Chrome：独立的用户目录 + 远程调试端口。用户在这个窗口里登录一次 Google / ChatGPT，
// 之后 helper 通过 CDP 接管它来上传、生成、取图。（Chrome 136 起默认用户目录不允许远程调试，所以必须单独建目录。）
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { config } from './config.mjs';

const { app, profileDir, debugPort } = config.chrome;
const endpoint = `http://127.0.0.1:${debugPort}`;

export async function isChromeUp() {
  try {
    const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function launchChrome(url = 'about:blank') {
  if (await isChromeUp()) return;
  fs.mkdirSync(profileDir, { recursive: true });
  // macOS 上用 open -g -n 启动：另起一个 Chrome 实例，且不抢到 Photoshop 前面
  const bundle = app.includes('.app/') ? app.slice(0, app.indexOf('.app/') + 4) : null;
  const [cmd, pre] = process.platform === 'darwin' && bundle ? ['/usr/bin/open', ['-g', '-n', '-a', bundle, '--args']] : [app, []];
  const child = spawn(cmd, [
    ...pre,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 窗口被 Photoshop 挡住时也照常跑，不要被当成后台节流
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isChromeUp()) return;
  }
  throw new Error('专用 Chrome 没有启动成功。如果这个配置的 Chrome 窗口已经开着（不是 helper 打开的），请先关掉它再试。');
}

let browserPromise = null;

export async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    browserPromise = null;
  }
  await launchChrome();
  browserPromise = chromium.connectOverCDP(endpoint);
  const b = await browserPromise;
  b.on('disconnected', () => { browserPromise = null; });
  return b;
}

const targetIdOf = async (ctx, page) => {
  const s = await ctx.newCDPSession(page);
  try {
    return (await s.send('Target.getTargetInfo')).targetInfo.targetId;
  } finally {
    await s.detach().catch(() => {});
  }
};

// 在后台开标签页：不切换标签、不激活 Chrome 窗口，生图时不会盖住 Photoshop
export async function newPage(url) {
  const browser = await getBrowser();
  const ctx = browser.contexts()[0];
  const cdp = await browser.newBrowserCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
  await cdp.detach().catch(() => {});
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    for (const p of ctx.pages()) {
      if (p.url() === 'about:blank' && (await targetIdOf(ctx, p).catch(() => null)) === targetId) page = p;
    }
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error('专用 Chrome 里开不了新标签页');
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

// 关标签页时至少留一个空白页：窗口里的标签页全关掉，下次开标签页会新建窗口并跳到最前面
export async function closePage(page) {
  try {
    if (page.context().pages().some((p) => p !== page)) await page.close();
    else await page.goto('about:blank');
  } catch {}
}

// 「打开专用 Chrome」按钮用：这时才把窗口拿到前面，方便登录
export async function showChrome(url) {
  await launchChrome(url);
  const browser = await getBrowser();
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().startsWith(url)) || (await ctx.newPage());
  if (page.url() !== url && !page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront();
}
