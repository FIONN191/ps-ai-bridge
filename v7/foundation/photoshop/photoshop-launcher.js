'use strict';
// 找 Photoshop、打开 Photoshop。候选：{ path（可执行文件）, version, name, root（含 Plug-ins 的安装目录）, appPath? }
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

function plistVersion(appPath) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  } catch (_) { return ''; }
}

// macOS 上的 Photoshop.app 本体可执行文件
function bundleExecutable(appPath) {
  const macos = path.join(appPath, 'Contents', 'MacOS');
  try {
    const names = fs.readdirSync(macos);
    const pick = names.find((n) => n.startsWith('Adobe Photoshop')) || names[0];
    if (pick) return path.join(macos, pick);
  } catch (_) {}
  return appPath;
}

function canonicalExecutable(p) {
  try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
}

function macCandidate(appPath) {
  const exe = canonicalExecutable(bundleExecutable(appPath));
  return { path: exe, appPath, root: path.dirname(appPath), name: path.basename(appPath, '.app'), version: plistVersion(appPath) || '?' };
}

function winVersion(exe) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  } catch (_) { return ''; }
}

function discoverMac(explicitPath) {
  const out = [];
  const add = (appPath) => {
    if (!appPath || !appPath.endsWith('.app') || !fs.existsSync(appPath)) return;
    const c = macCandidate(appPath);
    if (!out.some((x) => x.path === c.path)) out.push(c);
  };
  for (const e of safeReaddir('/Applications')) {
    if (!e.isDirectory() || !e.name.startsWith('Adobe Photoshop')) continue;
    const dir = path.join('/Applications', e.name);
    for (const sub of safeReaddir(dir)) if (sub.name.startsWith('Adobe Photoshop') && sub.name.endsWith('.app')) add(path.join(dir, sub.name));
  }
  if (explicitPath) {
    const m = /^(.*?\.app)(\/|$)/.exec(explicitPath);
    if (m) add(m[1]);
  }
  return out;
}

function discoverWin(explicitPath) {
  const out = [];
  const add = (exe) => {
    if (!exe || !/photoshop\.exe$/i.test(exe) || !fs.existsSync(exe)) return;
    const c = { path: canonicalExecutable(exe), root: path.dirname(exe), name: path.basename(path.dirname(exe)), version: winVersion(exe) || '?' };
    if (!out.some((x) => x.path.toLowerCase() === c.path.toLowerCase())) out.push(c);
  };
  const bases = [...new Set([process.env.ProgramW6432, process.env.PROGRAMFILES].filter(Boolean))].map((b) => path.join(b, 'Adobe'));
  for (const base of bases) for (const e of safeReaddir(base)) if (e.isDirectory() && e.name.startsWith('Adobe Photoshop')) add(path.join(base, e.name, 'Photoshop.exe'));
  if (explicitPath) add(explicitPath);
  return out;
}

function safeReaddir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } }

function isRunning(candidate) {
  try {
    if (process.platform === 'darwin') {
      const list = execFileSync('/bin/ps', ['-axo', 'comm'], { encoding: 'utf8' });
      return list.split('\n').some((l) => (candidate && candidate.path ? l.trim() === candidate.path : /\/Adobe Photoshop[^/]*\.app\/Contents\/MacOS\//.test(l)));
    }
    if (process.platform === 'win32') return /Photoshop\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Photoshop.exe', '/NH'], { encoding: 'utf8', windowsHide: true }));
  } catch (_) {}
  return false;
}

function createPhotoshopService() {
  const discover = (explicitPath) => {
    const candidates = process.platform === 'darwin' ? discoverMac(explicitPath) : process.platform === 'win32' ? discoverWin(explicitPath) : [];
    return { ok: true, candidates };
  };
  // 只接受本机真找得到的 Photoshop，页面传来的路径不能拿去启动别的程序
  const authorize = (candidate) => {
    const wanted = canonicalExecutable(String(candidate && candidate.path || ''));
    const found = discover(wanted).candidates.find((c) => c.path === wanted);
    if (!found) throw Object.assign(new Error('PHOTOSHOP_NOT_FOUND'), { code: 'PHOTOSHOP_NOT_FOUND' });
    return found;
  };
  const launch = async (candidate) => {
    const found = authorize(candidate);
    if (isRunning(found)) return { ok: true, alreadyRunning: true };
    if (process.platform === 'darwin') spawn('/usr/bin/open', ['-a', found.appPath], { detached: true, stdio: 'ignore' }).unref();
    else spawn(found.path, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, launched: true };
  };
  return { discover, authorize, launch, isRunning };
}

module.exports = { createPhotoshopService, bundleExecutable, canonicalExecutable, isRunning };
