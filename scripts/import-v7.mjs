// 从夏三七的修图轮椅 V7 Windows 安装包（WheelchairV7_x.y.z_x64-setup.exe）导入它的代码到 v7/：
//   v7/ui          界面（Tauri 里内嵌的 ui.html 和全部脚本，原样解出）
//   v7/uxp-bridge  PS 里的桥接插件
//   v7/eagle-bridge、v7/engine  Eagle 桥接和本机 Python 图像引擎（engine/eyegaze/pydeps 是 Windows 依赖，不导入）
// V7 出新版时重跑一次即可：node scripts/import-v7.mjs ~/Documents/WheelchairV7_1.9.23_x64-setup.exe
// 用法许可：夏三七本人同意修改整合，条件是不拿去盈利（见 NOTICE）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'v7');
const installer = process.argv[2];
if (!installer || (installer !== '--patch' && !fs.existsSync(installer))) throw new Error('用法：node scripts/import-v7.mjs <WheelchairV7_x.y.z_x64-setup.exe>（或 --patch 只重打 v7/patches.mjs）');

// 打 v7/patches.mjs 里的小改动；已经打过的跳过，找不到原文就停下
async function applyPatches() {
  const { PATCHES } = await import(new URL('../v7/patches.mjs', import.meta.url));
  for (const patch of PATCHES) {
    const file = path.join(OUT, patch.file);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(patch.replace)) continue;
    if (!text.includes(patch.find)) throw new Error(`补丁对不上（${patch.file}）：${patch.why}`);
    fs.writeFileSync(file, text.replace(patch.find, patch.replace));
  }
  console.log(`已打补丁 ${PATCHES.length} 处`);
}
if (installer === '--patch') {
  await applyPatches();
  process.exit(0);
}

function find7z() {
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('7zip')) : []) {
    for (const sub of fs.readdirSync(path.join(cache, dir))) {
      for (const name of ['7zz', '7za']) {
        const p = path.join(cache, dir, sub, 'bin', name);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return '7zz';
}

// Tauri 把前端资源以 brotli 压缩、按 [路径指针, 路径长度, 数据指针, 数据长度] 一行 32 字节的表格编进 exe。
// 先找 "/ui.html" 这个字符串的虚拟地址，再找指向它的那一行，前后扫出整张表。
export function extractTauriAssets(exe, dest) {
  const b = fs.readFileSync(exe);
  const pe = b.readUInt32LE(0x3c), nsec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20);
  const imageBase = Number(b.readBigUInt64LE(pe + 24 + 24));
  const sections = Array.from({ length: nsec }, (_, i) => {
    const s = pe + 24 + optSize + i * 40;
    return { va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20), rsize: b.readUInt32LE(s + 16) };
  });
  const toOff = (va) => { const r = va - imageBase; const s = sections.find((s) => r >= s.va && r < s.va + Math.max(s.vsize, s.rsize)); return s ? s.raw + r - s.va : -1; };
  const toVa = (off) => { const s = sections.find((s) => off >= s.raw && off < s.raw + s.rsize); return s ? imageBase + s.va + off - s.raw : -1; };
  let rowAt = -1;
  for (let i = b.indexOf('/ui.html'); i >= 0 && rowAt < 0; i = b.indexOf('/ui.html', i + 1)) {
    const va = toVa(i);
    if (va < 0) continue;
    const needle = Buffer.alloc(16);
    needle.writeBigUInt64LE(BigInt(va));
    needle.writeBigUInt64LE(8n, 8);
    rowAt = b.indexOf(needle);
  }
  if (rowAt < 0) throw new Error('exe 里没找到界面资源表');
  const row = (i) => {
    if (i < 0 || i + 32 > b.length) return null;
    const kp = toOff(Number(b.readBigUInt64LE(i))), kl = Number(b.readBigUInt64LE(i + 8));
    const vp = toOff(Number(b.readBigUInt64LE(i + 16))), vl = Number(b.readBigUInt64LE(i + 24));
    if (kp < 0 || vp < 0 || kl < 2 || kl > 300 || vl < 1 || vl > 50e6) return null;
    const name = b.subarray(kp, kp + kl).toString('utf8');
    return name.startsWith('/') && !name.includes('..') && !name.includes('\0') ? { name, vp, vl } : null;
  };
  let start = rowAt;
  while (row(start - 32)) start -= 32;
  const files = [];
  for (let i = start, r; (r = row(i)); i += 32) {
    const data = zlib.brotliDecompressSync(b.subarray(r.vp, r.vp + r.vl), { maxOutputLength: 60e6 });
    const file = path.join(dest, r.name.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    files.push({ path: r.name.slice(1), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
  return files;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-import-'));
try {
  execFileSync(find7z(), ['x', '-y', `-o${tmp}`, installer], { stdio: 'ignore' });
  const exe = path.join(tmp, 'wheelchair-v7.exe');
  if (!fs.existsSync(exe)) throw new Error('安装包里没有 wheelchair-v7.exe，不是 V7 的安装包？');
  // 只换 V7 自己的四个目录；v7/foundation 是我们补写的，保留
  for (const dir of ['ui', 'uxp-bridge', 'eagle-bridge', 'engine']) fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });
  const files = extractTauriAssets(exe, path.join(OUT, 'ui'));
  for (const dir of ['uxp-bridge', 'eagle-bridge', 'engine']) {
    fs.cpSync(path.join(tmp, dir), path.join(OUT, dir), { recursive: true, filter: (p) => !p.includes(`eyegaze${path.sep}pydeps`) });
  }
  const version = /app:\s*'([\d.]+)'/.exec(fs.readFileSync(path.join(OUT, 'ui', 'version.js'), 'utf8'))?.[1] || '';
  const info = {
    version,
    installer: path.basename(installer),
    installerSha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
    importedAt: new Date().toISOString().slice(0, 10),
    uiFiles: files.length,
  };
  fs.writeFileSync(path.join(OUT, 'VERSION.json'), `${JSON.stringify(info, null, 2)}\n`);
  await applyPatches();
  console.log(`已导入修图轮椅 V7 ${version}：界面 ${files.length} 个文件 → v7/`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
