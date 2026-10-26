// 对 V7 原版文件的最小改动（导入新版后由 scripts/import-v7.mjs 自动重新打上）。
// 每一条都是「原文 → 改成」，找不到原文就报错停下，提醒核对新版 V7 是否已经改了这里。
// 只放跨平台 / 整合必须的修改；V7 自己的功能逻辑不动。
export const PATCHES = [
  {
    file: 'ui/setup-host.cjs',
    why: 'macOS 上 modal 子窗口会变成依附主窗口的 sheet，全屏透明的「首次使用设置」显示不出来，主界面被一层遮罩锁死',
    find: 'parent: main, modal: true, frame: false',
    replace: "parent: main, modal: process.platform !== 'darwin', frame: false",
  },
  {
    file: 'ui/setup-host.cjs',
    why: 'Electron 在 macOS 上 setEnabled(false) 会给主窗口挂一张半透明 sheet 拦住所有鼠标，设置窗口也点不动；主界面本来就由页面 inert 锁住',
    find: '      main.setEnabled(false);',
    replace: "      if (process.platform !== 'darwin') main.setEnabled(false);",
  },
  {
    file: 'ui/setup-host.cjs',
    why: '退出程序 / 安装更新时，必填的首次设置窗口会拦住关闭，关掉后界面又马上重开一个，整个程序退不掉',
    find: "      if (record === own && own.payload.required === true) event.preventDefault();",
    replace: "      if (record === own && own.payload.required === true && !globalThis.__PSAI_V7_HOST__?.isQuitting?.()) event.preventDefault();",
  },
  {
    file: 'ui/setup-host.cjs',
    why: '同上：退出过程中不再新开设置窗口',
    find: "    if (operation !== 'open') return { ok: false, error: 'SETUP_OPERATION_INVALID' };",
    replace: "    if (operation !== 'open') return { ok: false, error: 'SETUP_OPERATION_INVALID' };\n    if (globalThis.__PSAI_V7_HOST__?.isQuitting?.()) return { ok: false, error: 'APP_QUITTING' };",
  },
  {
    file: 'ui/main.js',
    why: '同上：L4 报错冻结窗口在 macOS 上改为普通置顶子窗口',
    find: '    parent: win,\n    modal: true,\n    frame: false,',
    replace: "    parent: win,\n    modal: process.platform !== 'darwin',\n    frame: false,",
  },
  {
    file: 'ui/main.js',
    why: '同上：大图查看窗口',
    find: '    modal: true,               // 冻结主窗口',
    replace: "    modal: process.platform !== 'darwin', // 冻结主窗口",
  },
  {
    file: 'ui/main.js',
    why: '整合进 PS AI Bridge 后 V7 放在 resources/v7 下，图像引擎脚本在 v7/engine，不在 resources 根目录',
    find: "const engineResourceRoot = () => app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');",
    replace: "const engineResourceRoot = () => path.join(__dirname, '..');",
  },
];
