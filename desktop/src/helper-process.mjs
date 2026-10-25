// 托管本机 helper：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）跑 helper/server.mjs，不用另装 Node。
// 意外退出会自动拉起；端口上已经有一个 helper（比如源码版的「启动 helper.command」）时直接用它，等它退出再接管。
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_LOG_LINES = 2000;

// 从 Finder / 开机启动打开的 App 只有最基本的 PATH，找不到 Homebrew、~/.local/bin 里的工具（gen.sh 要用）。
// 读一次登录 shell 的 PATH 补上。
export async function loginShellPath() {
  if (process.platform === 'win32') return process.env.PATH || '';
  const fromShell = await new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5000 }, (err, out) => {
      resolve(/__PATH__(.*)__PATH__/s.exec(out || '')?.[1] || '');
    });
  });
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  return [...new Set([...fromShell.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean))].join(':');
}

export class HelperProcess extends EventEmitter {
  constructor({ dir, port, logFile, env = {} }) {
    super();
    this.dir = dir;
    this.port = port;
    this.logFile = logFile;
    this.env = env;
    this.child = null;
    this.logs = [];
    this.crashes = [];
    this.stopping = false;
    this.externalTimer = null;
    // status: stopped / starting / running / external / restarting / error
    this.state = { status: 'stopped', version: null, error: '', port };
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  log(line) {
    const stamped = `${new Date().toTimeString().slice(0, 8)} ${line}`;
    this.logs.push(stamped);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.logStream.write(`${new Date().toISOString().slice(0, 10)} ${stamped}\n`);
    this.emit('log', stamped);
  }

  async health() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    const h = await this.health();
    if (h) {
      this.log(`[桌面端] 端口 ${this.port} 上已经有 helper v${h.version} 在运行（多半是「启动 helper.command」开的），直接使用它`);
      this.set({ status: 'external', version: h.version, error: '' });
      this.watchExternal();
      return;
    }
    this.spawn();
  }

  watchExternal() {
    clearInterval(this.externalTimer);
    this.externalTimer = setInterval(async () => {
      if (await this.health()) return;
      clearInterval(this.externalTimer);
      this.log('[桌面端] 外部 helper 已退出，改由桌面端启动');
      if (!this.stopping) this.spawn();
    }, 5000);
  }

  spawn() {
    this.set({ status: 'starting', error: '' });
    const child = spawn(process.execPath, [path.join(this.dir, 'server.mjs')], {
      cwd: this.dir,
      env: { ...process.env, ...this.env, ELECTRON_RUN_AS_NODE: '1', PS_AI_BRIDGE_DESKTOP: '1', PS_AI_BRIDGE_PORT: String(this.port) },
      // 第四路是 IPC：桌面端崩了或被强退时 helper 会收到 disconnect 自己退出，不留下占着端口的孤儿进程
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) if (line.trim()) this.log(line);
      });
    }
    child.on('error', (e) => this.log(`[桌面端] helper 启动失败：${e.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    this.waitReady(child);
  }

  async waitReady(child) {
    for (let i = 0; i < 60 && this.child === child; i++) {
      await sleep(500);
      const h = await this.health();
      if (h && this.child === child) {
        this.crashes = this.crashes.filter((t) => Date.now() - t < 60000);
        this.set({ status: 'running', version: h.version, error: '' });
        return;
      }
    }
    if (this.child === child) this.set({ status: 'error', error: 'helper 30 秒内没有就绪，看看日志' });
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) return this.set({ status: 'stopped' });
    this.log(`[桌面端] helper 退出了（${signal || `退出码 ${code}`}）`);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60000), now];
    const portBusy = this.logs.slice(-5).some((l) => l.includes('已被占用'));
    if (this.crashes.length >= 5) {
      return this.set({
        status: 'error',
        error: portBusy ? `端口 ${this.port} 被别的程序占用了，关掉它再点「重启服务」` : 'helper 一分钟内反复退出，已停止重试，看看日志',
      });
    }
    this.set({ status: 'restarting', error: portBusy ? `端口 ${this.port} 被占用，稍后重试` : 'helper 意外退出，正在重启' });
    setTimeout(() => { if (!this.stopping && !this.child) this.start(); }, 1500 * this.crashes.length);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.externalTimer);
    const child = this.child;
    if (!child) {
      if (this.state.status !== 'external') this.set({ status: 'stopped' });
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }

  async restart() {
    if (this.state.status === 'external') {
      throw new Error('现在用的是外部启动的 helper：在那个终端窗口里按 Ctrl+C 关掉它，桌面端会自动接管');
    }
    await this.stop();
    this.crashes = [];
    await this.start();
  }
}
