// 发布新版本到 GitHub Releases（App 打开时就会提示更新）。步骤：
//   1. 改 desktop/package.json 的 version，在仓库根目录 CHANGELOG.md 里写好这一版的「## 版本号」
//   2. npm run dist   （打好 mac / Windows 安装包；App 开着时可以 PS_AI_BRIDGE_OUT=dist-next）
//   3. npm run release（生成 update.json，建 v版本号 的 Release，把安装包和 update.json 传上去）
// 需要已登录的 gh（gh auth login），代码要先推到 GitHub。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP, '..');
const OUT = path.join(DESKTOP, process.env.PS_AI_BRIDGE_OUT || 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const { version } = pkg;
const repo = pkg.psAiBridge.repo;
const tag = `v${version}`;

// 每个平台对应的安装包（App 按 process.platform-process.arch 取）
const FILES = {
  'darwin-arm64': `PS-AI-Bridge-${version}-mac-arm64.dmg`,
  'darwin-x64': `PS-AI-Bridge-${version}-mac-x64.dmg`,
  'win32-x64': `PS-AI-Bridge-${version}-win-x64-setup.exe`,
};

// CHANGELOG.md 里「## 版本号」到下一个「## 」之间的内容
function notesFor(v) {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const m = new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text);
  if (!m || !m[1].trim()) throw new Error(`CHANGELOG.md 里没有 ## ${v} 这一节，先写好更新说明`);
  return m[1].trim();
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const notes = notesFor(version);
const files = {};
for (const [platform, name] of Object.entries(FILES)) {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) throw new Error(`没找到 ${path.relative(REPO_ROOT, file)}，先 npm run dist`);
  files[platform] = { url: `https://github.com/${repo}/releases/download/${tag}/${name}`, sha256: sha256(file), size: fs.statSync(file).size };
}
// plugin：这一版带的 PS 插件版本，桌面端「检查插件更新」用它判断要不要先更新桌面端
const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin', 'manifest.json'), 'utf8')).version;
const manifest = { version, plugin, date: new Date().toISOString().slice(0, 10), notes, files };
const manifestFile = path.join(OUT, 'update.json');
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`update.json：v${version}，${Object.keys(files).length} 个平台`);

const notesFile = path.join(OUT, `release-notes-${version}.md`);
fs.writeFileSync(notesFile, `${notes}\n\n---\n下载：macOS（Apple 芯片）选 mac-arm64.dmg，Intel Mac 选 mac-x64.dmg，Windows 选 win-x64-setup.exe。已经装了 0.5.0 以后版本的，打开 App 会自动提示更新。\n`);
const gh = (args) => execFileSync('gh', args, { stdio: 'inherit', cwd: REPO_ROOT });
// Keep Latest unchanged until every installer and the feed are uploaded and verified.
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:REPO_ROOT,encoding:'utf8'}).trim();
gh(['release', 'create', tag, '--repo', repo, '--title', tag, '--notes-file', notesFile, '--draft', '--target', revision,
  ...Object.values(FILES).map((n) => path.join(OUT, n)), manifestFile]);
// A draft has no published Git tag yet; resolve its release ID from the authenticated list.
const releases=JSON.parse(execFileSync('gh',['api',`repos/${repo}/releases?per_page=100`],{cwd:REPO_ROOT,encoding:'utf8'}));
const uploaded=releases.find(release=>release.tag_name===tag && release.draft);
if(!uploaded) throw new Error(`未找到待验证的发布草稿：${tag}`);
for(const local of [...Object.values(FILES).map(n=>path.join(OUT,n)),manifestFile]){
  const asset=uploaded.assets.find(a=>a.name===path.basename(local));
  if(!asset||asset.state!=='uploaded'||asset.size!==fs.statSync(local).size||asset.digest!==`sha256:${sha256(local)}`)
    throw new Error(`上传校验失败，保留草稿且不会更新 Latest：${path.basename(local)}`);
}
gh(['api','--method','PATCH',`repos/${repo}/releases/${uploaded.id}`,'-F','draft=false','-f','make_latest=true','--jq','.html_url']);
console.log(`已发布并验证：https://github.com/${repo}/releases/tag/${tag}`);
