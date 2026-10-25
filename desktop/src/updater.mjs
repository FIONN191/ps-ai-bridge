// 自动更新：打开 App 时（之后每 6 小时）去 GitHub Releases 取最新的 update.json，有新版本就在窗口里问要不要更新。
// 没有 Apple 开发者证书，用不了系统那套自动更新（Squirrel 要求正式签名），这里自己下载安装包：
//  · macOS：下载 dmg，等旧版退出后用脚本把新 App 换进原来的位置再打开；位置不可写（比如没拖进「应用程序」直接从 dmg 里开）就打开 dmg 让用户手动拖
//  · Windows：下载安装程序直接运行，一键安装会覆盖旧版并自动打开
// update.json 由 scripts/release.mjs 生成：{ version, date, notes, files: { 'darwin-arm64': { url, sha256, size }, ... } }
import { app, net, shell } from 'electron';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
// PS_AI_BRIDGE_UPDATE_FEED：测试时指到本地的 update.json
const FEED = process.env.PS_AI_BRIDGE_UPDATE_FEED || `https://github.com/${pkg.psAiBridge.repo}/releases/latest/download/update.json`;
const PLATFORM = `${process.platform}-${process.arch}`;

export function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// 等旧版退出 → 挂载新 dmg → 把新 App 换进原位置 → 打开。任何一步失败都还原旧版并打开 dmg，让用户手动拖
const MAC_SCRIPT = `#!/bin/bash
PID="$1"; DMG="$2"; APP="$3"
for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
MNT="$(mktemp -d /tmp/ps-ai-bridge-update.XXXXXX)"
fail() {
  hdiutil detach "$MNT" -quiet 2>/dev/null
  if [ -d "$APP.old" ] && [ ! -d "$APP" ]; then mv "$APP.old" "$APP"; fi
  rm -rf "$APP.new"
  open "$DMG"
  exit 1
}
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null || fail
SRC="$(ls -d "$MNT"/*.app 2>/dev/null | head -1)"
[ -n "$SRC" ] || fail
rm -rf "$APP.new" "$APP.old"
ditto "$SRC" "$APP.new" || fail
mv "$APP" "$APP.old" || fail
mv "$APP.new" "$APP" || fail
rm -rf "$APP.old"
hdiutil detach "$MNT" -quiet
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
open "$APP"
`;

export class Updater extends EventEmitter {
  constructor({ readSettings, writeSettings, log = () => {} }) {
    super();
    this.readSettings = readSettings;
    this.writeSettings = writeSettings;
    this.log = log;
    this.manifest = null;
    // status：idle / disabled / checking / latest / available / downloading / installing / manual / error
    // prompt：要不要弹「发现新版本」（跳过的版本、点过「以后再说」的不弹）
    this.state = { status: 'idle', current: app.getVersion(), latest: null, notes: '', size: 0, percent: 0, error: '', prompt: false };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  async check({ manual = false } = {}) {
    if (!app.isPackaged && !process.env.PS_AI_BRIDGE_UPDATE_FEED) return this.set({ status: 'disabled' });
    if (['downloading', 'installing'].includes(this.state.status)) return;
    this.set({ status: 'checking', error: '' });
    try {
      // net.fetch 走 Chromium 的网络栈，会用系统代理（访问 GitHub 往往要靠它）
      const r = await net.fetch(FEED, { cache: 'no-store' });
      if (r.status === 404) return this.set({ status: 'latest', latest: null }); // 还没发布过
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = await r.json();
      const file = m.files?.[PLATFORM];
      if (!isNewer(m.version, this.state.current) || !file) return this.set({ status: 'latest', latest: m.version });
      this.manifest = m;
      const skipped = !manual && this.readSettings().skipVersion === m.version;
      this.set({ status: 'available', latest: m.version, notes: m.notes || '', size: file.size || 0, prompt: manual || !skipped });
      this.log(`[桌面端] 发现新版本 ${m.version}`);
    } catch (e) {
      this.set({ status: 'error', error: `检查更新失败：${e.message}（访问 GitHub 可能需要魔法）`, prompt: manual });
    }
  }

  skip() {
    this.writeSettings({ skipVersion: this.state.latest });
    this.set({ prompt: false });
  }

  dismiss() {
    this.set({ prompt: false });
  }

  async install() {
    const file = this.manifest?.files?.[PLATFORM];
    if (!file) throw new Error('没有可用的新版本');
    this.set({ status: 'downloading', percent: 0, error: '', prompt: true });
    const dest = path.join(app.getPath('temp'), path.basename(new URL(file.url).pathname));
    try {
      const r = await net.fetch(file.url);
      if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
      const total = Number(r.headers.get('content-length')) || file.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      let got = 0;
      let shown = -1;
      for await (const chunk of r.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
        got += chunk.length;
        const percent = total ? Math.floor((got / total) * 100) : 0;
        if (percent !== shown) { shown = percent; this.set({ percent }); }
      }
      out.end();
      await once(out, 'close');
      if (file.sha256 && hash.digest('hex') !== file.sha256) throw new Error('下载的安装包校验不对（可能没下完整），请重试');
    } catch (e) {
      fs.rmSync(dest, { force: true });
      this.set({ status: 'error', error: e.message, prompt: true });
      return;
    }
    this.set({ status: 'installing', percent: 100 });
    this.log(`[桌面端] 新版本 ${this.state.latest} 已下载，开始安装`);
    if (process.platform === 'darwin') this.installMac(dest);
    else this.installWin(dest);
  }

  installMac(dmg) {
    const appPath = path.resolve(app.getPath('exe'), '..', '..', '..');
    let writable = appPath.endsWith('.app') && !appPath.includes('/AppTranslocation/') && !appPath.startsWith('/Volumes/');
    try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); fs.accessSync(appPath, fs.constants.W_OK); } catch { writable = false; }
    if (!writable) {
      shell.openPath(dmg);
      return this.set({ status: 'manual' });
    }
    const script = path.join(app.getPath('temp'), 'ps-ai-bridge-update.sh');
    fs.writeFileSync(script, MAC_SCRIPT, { mode: 0o755 });
    spawn('/bin/bash', [script, String(process.pid), dmg, appPath], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }

  installWin(exe) {
    // 等 3 秒再运行安装程序：先让旧版和本机服务退干净，安装程序就不会提示「程序正在运行」
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep -Seconds 3; Start-Process -FilePath ${q(exe)}`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    app.quit();
  }
}
