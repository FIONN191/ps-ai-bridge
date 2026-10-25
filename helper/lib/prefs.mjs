// 运行中可以改的设置（桌面端设置页里改），存在数据目录的 prefs.json，改了立即生效，不用重启 helper。
// 和 config.json 分开：config.json 是启动时读一次的配置（端口、API Key 等）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

const FILE = path.join(DATA_DIR, 'prefs.json');
const DEFAULTS = {
  // 出图后关掉专用 Chrome 里的标签页。默认不关：方便在网页上看生成的样子、和贴回 PS 的版本对比
  closeTabsAfterDone: false,
};
let cache = null;

export function getPrefs() {
  if (!cache) {
    try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { cache = { ...DEFAULTS }; }
  }
  return cache;
}

export function updatePrefs(patch) {
  const next = { ...getPrefs() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (typeof v !== typeof DEFAULTS[k]) throw new Error(`设置 ${k} 的类型不对`);
    next[k] = v;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
