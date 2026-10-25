import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, USER_CONFIG } from './paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const expand = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

// 专用浏览器：优先 Google Chrome；没装 Chrome 时用 Edge（同样是 Chromium，支持远程调试，Windows 自带）
function findChrome() {
  const home = os.homedir();
  const list = process.platform === 'win32'
    ? [
        ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
        ...[process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES].filter(Boolean).map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
  return list.find((p) => fs.existsSync(p)) || list[0];
}

function load() {
  const base = readJson(path.join(ROOT, 'config.example.json'));
  // 用户配置：数据目录里的 config.json（桌面端「打开配置文件」打开的就是它）；开发时 helper/config.json 也认，后者优先
  const cfg = [USER_CONFIG, path.join(ROOT, 'config.json')].map(readJson)
    .reduce((acc, user) => ({ ...acc, ...user, chrome: { ...acc.chrome, ...(user.chrome || {}) } }), base);
  // 环境变量优先，方便不把 Key 写进文件
  cfg.geminiApiKey = process.env.GEMINI_API_KEY || cfg.geminiApiKey;
  cfg.openaiApiKey = process.env.OPENAI_API_KEY || cfg.openaiApiKey;
  cfg.port = Number(process.env.PS_AI_BRIDGE_PORT) || cfg.port;
  cfg.outputDir = expand(cfg.outputDir);
  cfg.imagenSkillDir = expand(cfg.imagenSkillDir);
  cfg.chrome.app = expand(cfg.chrome.app) || findChrome();
  cfg.chrome.profileDir = expand(cfg.chrome.profileDir) || path.join(DATA_DIR, 'chrome-profile');
  return cfg;
}

export const config = load();
