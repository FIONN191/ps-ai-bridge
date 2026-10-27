// 平台账号的登录状态：Google（AI Studio、Flow）和 ChatGPT。登录本身在专用 Chrome 里做（Google 不允许在内嵌浏览器里登录）。
// Codex CLI / Antigravity agy 是命令行工具：看本机有没有装、有没有登录凭证；登录在「终端」里跑它们自己的登录命令。
// 专用 Chrome 开着时通过 CDP 读 cookie；没开时读它配置目录里的 Cookies 数据库。只看登录 cookie 的名字和过期时间，不读内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';
import { execFile } from 'node:child_process';
import { isChromeUp, getBrowser, showChrome } from './chrome.mjs';

const SITES = {
  google: { loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Faistudio.google.com%2F', domain: 'google.com', names: ['SID', '__Secure-1PSID'] },
  // ChatGPT 的会话 cookie 太长时会拆成 .0 / .1
  chatgpt: { loginUrl: 'https://chatgpt.com/auth/login', domain: 'chatgpt.com', names: ['__Secure-next-auth.session-token'] },
};
const isLoginCookie = (s, host, name) => host.endsWith(s.domain) && s.names.some((n) => name === n || name.startsWith(`${n}.`));
const each = (fn) => Object.fromEntries(Object.entries(SITES).map(([k, s]) => [k, fn(s)]));

async function fromChrome() {
  const browser = await getBrowser();
  const cookies = await browser.contexts()[0].cookies(['https://accounts.google.com', 'https://chatgpt.com']);
  const now = Date.now() / 1000;
  return each((s) => cookies.some((c) => isLoginCookie(s, c.domain, c.name) && (c.expires === -1 || c.expires > now)));
}

async function fromDisk() {
  const db = ['Network/Cookies', 'Cookies'].map((f) => path.join(config.chrome.profileDir, 'Default', f)).find((f) => fs.existsSync(f));
  if (!db) return each(() => false); // 专用 Chrome 还没开过
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return each(() => null); } // Node 太旧（22.5 以前没有 node:sqlite），状态未知
  // Chrome 开着时会锁库，复制一份再读
  const tmp = path.join(os.tmpdir(), `ps-ai-bridge-cookies-${process.pid}.db`);
  fs.copyFileSync(db, tmp);
  try {
    const conn = new sqlite.DatabaseSync(tmp, { readOnly: true });
    // expires_utc 是从 1601 年起的微秒数，超出 JS 安全整数，让 SQLite 自己比较
    const rows = conn.prepare(`SELECT host_key AS host, name FROM cookies
      WHERE (host_key LIKE '%google.com' OR host_key LIKE '%chatgpt.com')
        AND (expires_utc = 0 OR expires_utc > (CAST(strftime('%s', 'now') AS INTEGER) + 11644473600) * 1000000)`).all();
    conn.close();
    return each((s) => rows.some((r) => isLoginCookie(s, r.host, r.name)));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const HOME = os.homedir();
const onPath = (name) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
// 跟 agent-imagen-skill 的 gen.sh 找法一致
const CLIS = {
  codex: {
    bin: () => onPath('codex') || ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/Codex.app/Contents/Resources/codex'].find((f) => fs.existsSync(f)),
    loggedIn: () => fs.existsSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'auth.json')),
    login: (bin) => `'${bin}' login`,
    install: 'https://developers.openai.com/codex/cli',
  },
  agy: {
    bin: () => onPath('agy') || [path.join(HOME, '.local', 'bin', 'agy')].find((f) => fs.existsSync(f)),
    loggedIn: () => fs.existsSync(path.join(HOME, '.gemini', 'jetski-standalone-oauth-token')),
    login: (bin) => `'${bin}'`,
    install: 'https://antigravity.google/cli',
  },
};
const cliStatus = () => Object.fromEntries(Object.entries(CLIS).map(([k, c]) => {
  if (process.platform === 'win32') return [k, { installed: false, loggedIn: false, note: '仅支持 macOS' }];
  const bin = c.bin();
  return [k, { installed: !!bin, loggedIn: !!bin && c.loggedIn(), install: c.install }];
}));

export async function accountStatus() {
  const chrome = { path: config.chrome.app, found: fs.existsSync(config.chrome.app), running: await isChromeUp() };
  const status = await (chrome.running ? fromChrome() : fromDisk()).catch(() => each(() => null));
  return { chrome, ...status, cli: cliStatus() };
}

// 在专用 Chrome 里打开登录页并拿到前面；命令行工具在「终端」里跑它自己的登录（会再打开浏览器授权）
export async function openLogin(site) {
  const cli = CLIS[site];
  if (cli) {
    if (process.platform !== 'darwin') throw new Error('Codex CLI / agy 目前只支持 macOS');
    const bin = cli.bin();
    if (!bin) return { ok: false, needInstall: true, install: cli.install };
    const script = `tell application "Terminal"\nactivate\ndo script "${cli.login(bin).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    await new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', script], (e) => (e ? reject(new Error(`打不开终端：${e.message}`)) : resolve())));
    return { ok: true, terminal: true };
  }
  const s = SITES[site];
  if (!s) throw new Error(`未知账号：${site}`);
  await showChrome(s.loginUrl);
  return { ok: true };
}
