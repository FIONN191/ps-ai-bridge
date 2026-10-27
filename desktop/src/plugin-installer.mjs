// 一键安装插件：把插件文件夹复制进每个 Photoshop 的 Plug-ins 目录。Photoshop 启动时会加载这里的 UXP 插件，
// 不需要 Creative Cloud，也不用开开发者模式（修图轮椅、像素起子这些也是这么装的）。
// Adobe 的命令行安装器（UnifiedPluginInstallerAgent）认不出 Photoshop (Beta)，所以不走它。
// Plug-ins 归管理员所有：macOS 弹密码框，Windows 弹 UAC。macOS 装好后把文件夹改归当前用户，以后更新不用再输密码。
// 这种方式 Adobe 没写进文档，万一某个 Photoshop 不加载，可以退回 Creative Cloud 安装（.ccx，见 makeCcx）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const FOLDER = 'PS-AI-Bridge';
const PROMPT = 'BXAS 要把插件装进 Photoshop 的 Plug-ins 文件夹。';

// Creative Cloud 装的 UXP 插件放在这里，文件夹名是「插件ID_版本」
const CC_DIR = process.platform === 'darwin'
  ? '/Library/Application Support/Adobe/UXP/Plugins/External'
  : path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'Adobe', 'UXP', 'Plugins', 'External');

const readManifest = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
};
const readdir = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Plug-ins 里所有同 ID 的插件副本（我们装的 + 用户以前手动放的），往下找 3 层
function findCopies(dir, id, depth = 0) {
  const out = [];
  for (const e of readdir(dir)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    const m = readManifest(sub);
    if (m?.id === id) out.push({ dir: sub, version: m.version });
    else if (!m && depth < 2) out.push(...findCopies(sub, id, depth + 1));
  }
  return out;
}

async function macPhotoshops() {
  const list = [];
  for (const e of readdir('/Applications')) {
    if (!e.isDirectory() || !e.name.startsWith('Adobe Photoshop')) continue;
    const root = path.join('/Applications', e.name);
    const bundle = readdir(root).find((x) => x.name.startsWith('Adobe Photoshop') && x.name.endsWith('.app'));
    if (!bundle) continue;
    let version = '';
    try {
      version = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(root, bundle.name, 'Contents', 'Info.plist')])).stdout.trim();
    } catch {}
    list.push({ name: bundle.name.replace(/\.app$/, ''), root, version });
  }
  return list;
}

async function winPhotoshops() {
  const bases = [...new Set([process.env.ProgramW6432, process.env.PROGRAMFILES].filter(Boolean))].map((b) => path.join(b, 'Adobe'));
  const list = [];
  for (const base of bases) {
    for (const e of readdir(base)) {
      const exe = path.join(base, e.name, 'Photoshop.exe');
      if (e.isDirectory() && e.name.startsWith('Adobe Photoshop') && fs.existsSync(exe)) list.push({ name: e.name, root: path.join(base, e.name), exe, version: '' });
    }
  }
  if (list.length) {
    // 一次读出所有 Photoshop.exe 的版本号，每行「序号|版本」
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const script = list.map((p, i) => `'${i}|' + (Get-Item -LiteralPath ${q(p.exe)}).VersionInfo.ProductVersion`).join('; ');
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 });
      for (const line of stdout.split(/\r?\n/)) {
        const [i, v] = line.trim().split('|');
        if (list[Number(i)] && v) list[Number(i)].version = v.trim();
      }
    } catch {}
  }
  return list;
}

// Photoshop 2024 = 25.x；读不到版本号时按文件夹名里的年份推
const majorOf = (p) => parseInt(p.version, 10) || (Number(/20(\d\d)/.exec(p.name)?.[1]) + 1 || 0);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const appleString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const psq = (s) => `'${s.replace(/'/g, "''")}'`;

// ops: [{ op: 'copy', src, dest } | { op: 'remove', dest }]，用管理员权限一次做完
async function elevated(ops) {
  if (process.platform === 'darwin') {
    const user = os.userInfo().username;
    const cmds = ops.map((o) => (o.op === 'copy'
      ? `rm -rf ${sh(o.dest)} && mkdir -p ${sh(o.dest)} && cp -R ${sh(`${o.src}/.`)} ${sh(o.dest)} && chown -R ${sh(user)} ${sh(o.dest)}`
      : `rm -rf ${sh(o.dest)}`)).join(' && ');
    try {
      await run('/usr/bin/osascript', ['-e', `do shell script ${appleString(cmds)} with prompt ${appleString(PROMPT)} with administrator privileges`]);
    } catch (e) {
      if (/-128/.test(e.stderr || e.message)) throw new Error('已取消授权，插件没有变动');
      throw new Error(`授权后复制失败：${(e.stderr || e.message).trim()}`);
    }
    return;
  }
  if (process.platform === 'win32') {
    const stamp = Date.now();
    const result = path.join(os.tmpdir(), `ps-ai-bridge-${stamp}.txt`);
    const script = path.join(os.tmpdir(), `ps-ai-bridge-${stamp}.ps1`);
    const body = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      ...ops.flatMap((o) => [
        `  if (Test-Path -LiteralPath ${psq(o.dest)}) { Remove-Item -LiteralPath ${psq(o.dest)} -Recurse -Force }`,
        ...(o.op === 'copy' ? [
          `  New-Item -ItemType Directory -Path ${psq(o.dest)} -Force | Out-Null`,
          `  Copy-Item -Path (Join-Path ${psq(o.src)} '*') -Destination ${psq(o.dest)} -Recurse -Force`,
        ] : []),
      ]),
      `  Set-Content -LiteralPath ${psq(result)} -Value 'ok' -Encoding UTF8`,
      '} catch {',
      `  Set-Content -LiteralPath ${psq(result)} -Value $_.Exception.Message -Encoding UTF8`,
      '}',
    ].join('\r\n');
    // Windows PowerShell 5.1 只在有 BOM 时把脚本当 UTF-8 读，路径里有中文时要带上
    fs.writeFileSync(script, `﻿${body}`, 'utf8');
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq(`"${script}"`)}`,
      ], { windowsHide: true });
    } catch (e) {
      throw new Error(/cancel/i.test(e.stderr || e.message) ? '已取消授权，插件没有变动' : `没能以管理员身份运行：${(e.stderr || e.message).trim()}`);
    } finally {
      fs.rmSync(script, { force: true });
    }
    const out = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').replace(/^﻿/, '').trim() : '';
    fs.rmSync(result, { force: true });
    if (out !== 'ok') throw new Error(`授权后复制失败：${out || '没有完成'}`);
    return;
  }
  throw new Error('这个系统不支持');
}

const denied = (e) => ['EACCES', 'EPERM'].includes(e?.code);

// 最小的 zip 写入器（.ccx 就是 manifest.json 在根目录的 zip），免得为这一个功能带上压缩库
function writeZip(dir, out) {
  const files = [];
  const walk = (sub) => {
    for (const e of readdir(path.join(dir, sub))) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk('');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const rel of files.sort()) {
    const name = Buffer.from(rel, 'utf8');
    const data = fs.readFileSync(path.join(dir, rel));
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    // 公共字段：版本 20、UTF-8 文件名标志、deflate、时间 0 点、日期 1980-01-01
    const common = (b, at) => {
      b.writeUInt16LE(20, at); b.writeUInt16LE(0x0800, at + 2); b.writeUInt16LE(8, at + 4);
      b.writeUInt16LE(0, at + 6); b.writeUInt16LE(0x21, at + 8); b.writeUInt32LE(crc, at + 10);
      b.writeUInt32LE(packed.length, at + 14); b.writeUInt32LE(data.length, at + 18); b.writeUInt16LE(name.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    common(local, 4);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    common(entry, 6);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, ...central, end]));
}

// 先不要权限直接复制（目标文件夹归当前用户时就能成），失败了再走管理员权限
function replaceDir(src, dest) {
  if (fs.existsSync(dest)) for (const name of fs.readdirSync(dest)) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
  else fs.mkdirSync(dest);
  fs.cpSync(src, dest, { recursive: true });
}

export function createInstaller({ sourceDir, extras = [], folder = FOLDER }) {
  const bundled = readManifest(sourceDir);
  if (!bundled?.id) throw new Error(`插件文件不完整：${sourceDir}`);
  const minMajor = parseInt(bundled.host?.minVersion, 10) || 0;

  // 复制前先拼一份干净的插件：插件文件 + LICENSE/NOTICE，去掉隐藏文件和下载隔离标记
  function stage() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-bridge-plugin-'));
    fs.cpSync(sourceDir, dir, { recursive: true, filter: (src) => src === sourceDir || !path.basename(src).startsWith('.') });
    for (const f of extras) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    if (process.platform === 'darwin') try { fs.chmodSync(dir, 0o755); } catch {}
    return dir;
  }

  async function findPhotoshops(customRoots = []) {
    const found = process.platform === 'darwin' ? await macPhotoshops() : process.platform === 'win32' ? await winPhotoshops() : [];
    for (const root of customRoots) {
      if (!found.some((p) => samePath(p.root, root))) found.push({ name: path.basename(root), root, version: '', custom: true });
    }
    return found.map((p) => {
      const pluginsDir = path.join(p.root, 'Plug-ins');
      const major = majorOf(p);
      const copies = findCopies(pluginsDir, bundled.id);
      const ours = copies.find((c) => path.basename(c.dir) === folder) || null;
      return {
        name: p.name,
        root: p.root,
        version: p.version,
        custom: !!p.custom,
        pluginsDir,
        hasPluginsDir: fs.existsSync(pluginsDir),
        supported: !major || major >= minMajor,
        installed: ours?.version || null,
        others: copies.filter((c) => c !== ours).map((c) => c.dir),
      };
    });
  }

  async function install(pluginsDirs) {
    const staged = stage();
    try {
      const needAdmin = [];
      for (const dir of pluginsDirs) {
        const dest = path.join(dir, folder);
        try { replaceDir(staged, dest); } catch (e) { if (denied(e)) needAdmin.push({ op: 'copy', src: staged, dest }); else throw e; }
      }
      if (needAdmin.length) await elevated(needAdmin);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
    const failed = pluginsDirs.filter((dir) => readManifest(path.join(dir, folder))?.version !== bundled.version);
    if (failed.length) throw new Error(`复制后检查没通过：${failed.join('、')}`);
  }

  async function uninstall(pluginsDirs) {
    const needAdmin = [];
    for (const dir of pluginsDirs) {
      const dest = path.join(dir, folder);
      if (!fs.existsSync(dest)) continue;
      try { fs.rmSync(dest, { recursive: true }); } catch (e) { if (denied(e)) needAdmin.push({ op: 'remove', dest }); else throw e; }
    }
    if (needAdmin.length) await elevated(needAdmin);
  }

  // Creative Cloud 里已经装的版本（没装返回 null）
  function ccInstalled() {
    const e = readdir(CC_DIR).find((x) => x.isDirectory() && x.name.startsWith(`${bundled.id}_`));
    return e ? readManifest(path.join(CC_DIR, e.name))?.version || '?' : null;
  }

  // 备用安装方式：打成 .ccx，交给 Creative Cloud 安装
  function makeCcx() {
    const staged = stage();
    const out = path.join(os.tmpdir(), `PS-AI-Bridge-${bundled.version}.ccx`);
    try { writeZip(staged, out); } finally { fs.rmSync(staged, { recursive: true, force: true }); }
    return out;
  }

  return { bundled: { id: bundled.id, version: bundled.version, minMajor }, findPhotoshops, install, uninstall, ccInstalled, makeCcx };
}

export async function isPhotoshopRunning() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('/bin/ps', ['-axo', 'comm']);
      return stdout.split('\n').some((l) => /\/Adobe Photoshop[^/]*\.app\/Contents\/MacOS\//.test(l));
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq Photoshop.exe', '/NH'], { windowsHide: true });
      return /Photoshop\.exe/i.test(stdout);
    }
  } catch {}
  return false;
}
