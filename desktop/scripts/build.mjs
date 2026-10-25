// 打包桌面端：node scripts/build.mjs mac win（不写参数就打当前系统）。产物在 desktop/dist。
// 每个目标单独准备一份 helper：装好对应系统/架构的 sharp 预编译包，放进 App 的 resources/helper；
// 插件文件夹（加 LICENSE、NOTICE）放进 resources/plugin，「一键安装」从这里复制。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DESKTOP, '..');
const STAGE = path.join(DESKTOP, '.stage');
// 产物目录，默认 dist；App 正开着时可以设 PS_AI_BRIDGE_OUT=dist-next 打到别处，免得覆盖正在运行的 App
const OUT = process.env.PS_AI_BRIDGE_OUT || 'dist';

const TARGETS = {
  mac: [['darwin', 'arm64'], ['darwin', 'x64']],
  'mac-arm64': [['darwin', 'arm64']],
  'mac-x64': [['darwin', 'x64']],
  win: [['win32', 'x64']],
};

const hidden = (src) => path.basename(src).startsWith('.');

function stagePlugin() {
  fs.copyFileSync(path.join(REPO, 'plugin', 'api-settings.js'), path.join(DESKTOP, 'src', 'renderer', 'api-settings.js'));
  const dir = path.join(STAGE, 'plugin');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'plugin'), dir, { recursive: true, filter: (src) => !hidden(src) });
  for (const f of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  return dir;
}

function stageHelper(platform, arch) {
  const src = path.join(REPO, 'helper');
  const dir = path.join(STAGE, `helper-${platform}-${arch}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(src, dir, {
    recursive: true,
    filter: (p) => {
      const top = path.relative(src, p).split(path.sep)[0];
      if (hidden(p) || ['node_modules', 'tests', 'config.json'].includes(top)) return false;
      // 快捷键组件只有 macOS 版
      return !(top === 'native' && platform !== 'darwin');
    },
  });
  // --os/--cpu 让 npm 装目标平台的可选依赖（sharp 的预编译包），在 Mac 上也能备好 Windows 版
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`], {
    cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
  });
  // .bin 里是软链接，helper 用不到；留着的话签名会报「软链接指向 App 外面」
  fs.rmSync(path.join(dir, 'node_modules', '.bin'), { recursive: true, force: true });
  const sharpPkg = path.join(dir, 'node_modules', '@img', `sharp-${platform}-${arch}`);
  if (!fs.existsSync(sharpPkg)) throw new Error(`没装上 ${path.basename(sharpPkg)}，这个平台的图像处理会用不了`);
  return dir;
}

// electron-builder 的 extraResources 会把 node_modules 过滤掉，helper 的依赖要在打包后（签名前）自己复制进去
const copyHelper = (helperDir) => (context) => {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const dest = path.join(resources, 'helper');
  fs.rmSync(dest, { recursive: true, force: true });
  // verbatimSymlinks：不要把相对软链接改写成指向 .stage 的绝对路径
  fs.cpSync(helperDir, dest, { recursive: true, verbatimSymlinks: true });
};

const config = (helperDir, pluginDir) => ({
  appId: 'com.fionn.psaibridge.desktop',
  productName: 'PS AI Bridge',
  copyright: 'Copyright (C) 2026 fionn · GPL-3.0-or-later',
  directories: { output: OUT, buildResources: 'assets' },
  files: ['src/**/*', 'assets/**/*', 'package.json'],
  extraResources: [{ from: pluginDir, to: 'plugin' }],
  afterPack: copyHelper(helperDir),
  mac: {
    icon: 'assets/icon.png',
    category: 'public.app-category.graphics-design',
    // 没有 Apple 开发者证书：用临时签名（Apple 芯片上必须至少有临时签名才能运行）
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    title: 'PS AI Bridge ${version}',
    artifactName: 'PS-AI-Bridge-${version}-mac-${arch}.${ext}',
  },
  win: {
    icon: 'assets/icon-win.png',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    shortcutName: 'AI 生图贴回',
    artifactName: 'PS-AI-Bridge-${version}-win-${arch}-setup.${ext}',
    deleteAppDataOnUninstall: false,
  },
});

const wanted = process.argv.slice(2).filter((a) => TARGETS[a]);
if (!wanted.length) wanted.push(process.platform === 'win32' ? 'win' : 'mac');

fs.mkdirSync(STAGE, { recursive: true });
const pluginDir = stagePlugin();
for (const os of wanted) {
  for (const [platform, arch] of TARGETS[os]) {
    console.log(`\n=== ${platform} ${arch} ===`);
    const helperDir = stageHelper(platform, arch);
    const targets = platform === 'darwin'
      ? Platform.MAC.createTarget('dmg', Arch[arch])
      : Platform.WINDOWS.createTarget('nsis', Arch[arch]);
    await build({ projectDir: DESKTOP, targets, config: config(helperDir, pluginDir), publish: 'never' });
  }
}
console.log('\n产物：');
for (const f of fs.readdirSync(path.join(DESKTOP, OUT))) if (/\.(dmg|exe)$/.test(f)) console.log(' ', path.join('desktop', OUT, f));
