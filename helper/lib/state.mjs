// helper 自己记的小状态（比如 Flow 专用项目的地址），放在用户目录，不进项目文件夹
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

const FILE = path.join(DATA_DIR, 'state.json');

export function readState() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function writeState(patch) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}
