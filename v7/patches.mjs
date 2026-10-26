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
  {
    file: 'ui/ui-main.js',
    why: '整合：Others 槽位固定给本机「免 API 模式」（AI Studio / Flow / ChatGPT 网页等），名字直接叫免 API 模式',
    find: "other:'Others · 其他'};\nfunction computeSlotLabel",
    replace: "other:'免 API 模式'};\nfunction computeSlotLabel",
  },
  {
    file: 'ui/compute-slots.js',
    why: '同上：渠道默认名',
    find: "grs: 'GRS', other: '自定义' });",
    replace: "grs: 'GRS', other: '免 API 模式' });",
  },
  {
    file: 'ui/provider-connections.js',
    why: '同上：连接标题',
    find: "other:'Others · 其他'});",
    replace: "other:'免 API 模式'});",
  },
  {
    file: 'ui/ui-main.js',
    why: '同上：设置里连接字段的标题和提示',
    find: "['other','自定义','https://你的中转站地址','该站给你的 Key'],",
    replace: "['other','免 API 模式','http://127.0.0.1:47811/compat（已自动填好）','随便填，比如 local'],",
  },
  {
    file: 'ui/ui-main.js',
    why: '同上：幕布生成节点的渠道列表，免 API 模式排第一',
    find: "channels:()=>[['aji','AJI'],['grs','GRS'],['other','其他']],",
    replace: "channels:()=>[['other','免 API 模式'],['aji','AJI'],['grs','GRS']],",
  },
  {
    file: 'ui/ui-main.js',
    why: '免 API 模式：生成卡先选「生图平台」再选模型（平台和模型分两行、各占整行，名字不再被截断）；不显示余额折算',
    find: "      const 名单=配了?aiModelOptions():[];",
    replace: "      const 免API=window.__PSAI_FREE_API__&&__PSAI_FREE_API__.active()?__PSAI_FREE_API__:null;\n      const 名单=配了?(免API?免API.filter(aiModelOptions()):aiModelOptions()):[];",
  },
  {
    file: 'ui/ui-main.js',
    why: '同上：模型行前面加平台行',
    find: "      return '<div class=\"gcf modelrow\">模型<div class=\"modelrow-line\">'\n        +'<select data-ai-field=\"model\"'",
    replace: "      return (免API?免API.platformRow():'')+'<div class=\"gcf modelrow\">模型<div class=\"modelrow-line\">'\n        +'<select data-ai-field=\"model\"'",
  },
  {
    file: 'ui/ui-main.js',
    why: '同上：免 API 不扣费，去掉挤占下拉框宽度的「自定连接 · 不折算」',
    find: "        +(配了?modelQuotaHtml():'<span class=\"model-quota\" data-state=\"empty\"",
    replace: "        +(免API?'':配了?modelQuotaHtml():'<span class=\"model-quota\" data-state=\"empty\"",
  },
  {
    file: 'ui/ui-main.js',
    why: '免 API 模式：生成卡的算力来源写清楚走本机账号（原来显示「自有 API · 免 API 模式」，容易和平台算力混淆）',
    find: "[['own','自有 API · '+(V7ProviderConnections.TITLES?.[settingsRuntime.provider]||settingsRuntime.provider||'其他'),ownReady]",
    replace: "[['own',settingsRuntime.provider==='other'?'免 API 模式 · 本机账号出图':'自有 API · '+(V7ProviderConnections.TITLES?.[settingsRuntime.provider]||settingsRuntime.provider||'其他'),ownReady]",
  },
  {
    file: 'ui/ui-main.js',
    why: '免 API 模式：设置卡摘要里的服务商名（原来显示 Others）',
    find: "({aji:'AJI',momo:'MOMO',other:'Others'})[settingsRuntime.provider]",
    replace: "({aji:'AJI',momo:'MOMO',other:'免 API 模式'})[settingsRuntime.provider]",
  },
];
