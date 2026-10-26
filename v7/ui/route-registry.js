// V7 canonical route and surface registry.
//
// Product meaning and display host are deliberately separate.  A route says
// what the user is trying to do; the current card/workspace implementation
// decides how it is displayed.  Existing card IDs, zone indexes, and APIs are
// kept as compatibility targets while new callers use stable route IDs.
(function (root) {
  'use strict';

  const ROUTES = Object.freeze({
    // ⭐ 2026-10-01 设置卡改成【一张大二级 + 右边点阵导航】后，全部 zone 恒为 0。
    //   ⚠ 真正的页签由 options.section 决定（settingsRoute → settingsTabIdFromSection）。
    //     别再往 zone 里塞 1/2/3 —— 那些分区已经不存在了，塞了也是静默落回第一页。
    'settings/account': { card: 'settings', zone: 0, options: { section: 'account' }, category: 'settings', surface: 'card' },
    'settings/compute': { card: 'settings', zone: 0, options: { section: 'platform' }, category: 'settings', surface: 'card' },
    'settings/providers': { card: 'settings', zone: 0, options: { section: 'own' }, category: 'settings', surface: 'card' },
    'settings/local': { card: 'settings', zone: 0, options: { section: 'local' }, category: 'settings', surface: 'card' },
    'settings/photoshop': { card: 'settings', zone: 0, options: { section: 'photoshop' }, category: 'settings', surface: 'card' },
    // ⭐ 生成与传回已【搬去生成卡】（2026-10-01，用户定：设置里只放最纯粹的设置）。
    //   生成卡第 4 格就叫「生成与传回设置」，正好接这一批。
    // ⭐ 2026-10-06 docs/150 §7.2：生成卡第 4 格现在是三组折叠（输出行为/编组/羽化），
    //   路由进来要"先展开再高亮"（§4.3）—— 所以带上 highlight 钩子。
    // ⭐⭐ 2026-10-14：生成卡第 4 格清空（用户定：生成卡二三级不留任何设置），这批设置【回到设置卡】「抓图与出图」那一节。
    'settings/generation': { card: 'settings', zone: 0, options: { section: 'output' }, category: 'settings', surface: 'card' },
    //   「交互与快捷键」留在设置卡（滚动格数 / 快捷键不算生成行为）
    'settings/interaction': { card: 'settings', zone: 0, options: { section: 'interaction' }, category: 'settings', surface: 'card' },
    'settings/content': { card: 'settings', zone: 0, options: { section: 'content' }, category: 'settings', surface: 'card' },
    'settings/assistant': { card: 'settings', zone: 0, options: { section: 'assistant' }, category: 'settings', surface: 'card' },
    'settings/keys': { card: 'settings', zone: 0, options: { section: 'keys' }, category: 'settings', surface: 'card' },
    'settings/interface': { card: 'settings', zone: 0, options: { section: 'appearance' }, category: 'settings', surface: 'card' },
    'settings/advanced': { card: 'settings', zone: 0, options: { section: 'tools' }, category: 'settings', surface: 'card' },
    'settings/storage': { card: 'settings', zone: 0, options: { section: 'storage' }, category: 'settings', surface: 'card' },
    'settings/backup': { card: 'settings', zone: 0, options: { section: 'backup-preferences' }, category: 'settings', surface: 'card' },
    'settings/privacy': { card: 'settings', zone: 0, options: { section: 'privacy' }, category: 'settings', surface: 'card' },
    // ⭐ 新增两页（2026-10-01）：这两页原来只能靠鼠标划过点阵栏到达，路由寻址不到。
    'settings/credits': { card: 'settings', zone: 0, options: { section: 'credits' }, category: 'settings', surface: 'card' },
    'settings/service': { card: 'settings', zone: 0, options: { section: 'service' }, category: 'settings', surface: 'card' },
    // ⭐ 新增一页（2026-10-05）：对齐与校色 —— 用户定"只放在设置卡里"。
    //   原来这两样只藏在外挂能力卡二级的「基础」页，**连路由都寻址不到**。
    //   ⚠ 外挂卡那边现在只留一个跳过来的按钮，跳的就是这一条。
    'settings/render': { card: 'settings', zone: 0, options: { section: 'render' }, category: 'settings', surface: 'card' },
    // ⭐ 2026-09-29 方案 B 重建（用户定案「项目时间线」和「项目」两张卡的重复内容整合，只留一份）：
    //   「记录与恢复」卡（history）= 找回以前的东西：近期任务 / 全部历史 / 提示词复用 / 检查点与账单
    //   「项目」卡（projects）     = 当前这单活：项目管理 / 本项目记录 / 拍摄日程 / Eagle 归档
    //   ⚠ 以前这几条 records 路由还指着时间线卡【更早】的四格（生成记录 / 提示词 / 恢复 / 账单），09-28 改成
    //     「本次项目 / 近期任务 / 全部历史 / 低频资料」后没跟着改：点「检查点与恢复」落到全部历史、点「提示词」落到近期任务，
    //     检查点 / 账号备份 / 布局恢复 / 软件恢复这整块记录中心从卡片上根本进不去。
    //   规矩：按钮 / 快捷入口 / 提醒条一律走这里的路由名，不再各自写死「第几张卡第几格」。
    //   ⭐ 2026-09-30 记录与恢复卡实装：这张卡改成【一张大二级】，没有三级了。
    //     所以下面这些路由不再带 zone（记录卡只有一个分区，zone 恒为 0）：
    //       recent / generation / prompts / recovery  → 记录卡大二级（可带 project / query / checkpoint）
    //       backup / layout / software                → 设置卡「存储与隐私」
    //       billing / costs                           → 设置卡「账号服务」的账单页
    //     ⚠ 这一版把"检查点与账单"里混的那几样彻底分家了 —— 记录卡只管"找回以前的东西"，
    //       备份/布局/软件恢复是设置项，账单是账号页。别再往记录卡上挂第三个入口。
    'records/recent': { card: 'history', zone: 0, options: {}, category: 'records', surface: 'card' },
    'records/generation': { card: 'history', zone: 0, options: {}, category: 'records', surface: 'card' },
    'records/prompts': { card: 'history', zone: 0, options: { section: 'prompts' }, category: 'records', surface: 'card' },
    'records/recovery': { card: 'history', zone: 0, options: { section: 'checkpoints' }, category: 'records', surface: 'card' },
    //   ⚠ section 必须是【标签页自己的 id】（storage / account-backup / layout-restore /
    //     software-recovery），不是分区名 —— 传错了 tabs() 会静默退回第一个标签，
    //     按钮根本不渲染（这一版第一次就传成了 storage）。
    'records/backup': { card: 'settings', zone: 3, options: { section: 'account-backup', highlight: '[data-account-backup]' }, category: 'records', surface: 'card' },
    'records/layout': { card: 'settings', zone: 3, options: { section: 'layout-restore', highlight: '[data-layout-restore]' }, category: 'records', surface: 'card' },
    'records/software': { card: 'settings', zone: 3, options: { section: 'software-recovery', highlight: '[data-software-recovery]' }, category: 'records', surface: 'card' },
    //   ⚠ section 必须是服务页的标签 id（billing），传 'account' 只会落到默认页，
    //     账单页根本不挂载（这一版第一次就传成了 account）。
    'records/billing': { card: 'settings', zone: 0, options: { section: 'billing', highlight: '[data-account-billing]' }, category: 'records', surface: 'card' },
    'records/costs': { card: 'settings', zone: 0, options: { section: 'billing', highlight: '[data-account-billing]' }, category: 'records', surface: 'card' },
    'projects/progress': { card: 'projects', zone: 0, options: {}, category: 'projects', surface: 'card' },
    'projects/records': { card: 'projects', zone: 1, options: {}, category: 'projects', surface: 'card' },
    'projects/schedule': { card: 'projects', zone: 2, options: {}, category: 'projects', surface: 'card' },
    'projects/eagle': { card: 'projects', zone: 3, options: {}, category: 'projects', surface: 'card' },
    // ⭐ 外挂能力卡（2026-10-01 实装）。这张卡改成【一张大二级】之后没有三级了，
    //   所以 zone 恒为 0（同记录卡/设置卡）。真正的页由 options.zone 决定
    //   （enginesRoute → V7EnginesCard.open）。
    //   ⚠⚠ 这几条是补的历史欠账：整张外挂卡原来【一条路由都没有】，
    //     于是 V7RouteRegistry.open('engines') 直接抛「未知的 V7 路由：engines」。
    //     之前一直没暴露，是因为调用方都走 navigateCard / V7CardRoutes.open
    //     （那条路不查注册表）—— 直到 2026-10-01 的探针第一次用注册表才炸出来。
    //     ⚠ 这类缺口是【安静地少一条路】：不主动查永远不会响。
    'engines/overview': { card: 'engines', zone: 0, options: { zone: 'all' }, category: 'engines', surface: 'card' },
    // 六样能力各一页（一级能力行点进来用的就是这些）
    'engines/color':    { card: 'engines', zone: 0, options: { zone: 'color' }, category: 'engines', surface: 'card' },
    'engines/align':    { card: 'engines', zone: 0, options: { zone: 'align' }, category: 'engines', surface: 'card' },
    'engines/matting':  { card: 'engines', zone: 0, options: { zone: 'matting' }, category: 'engines', surface: 'card' },
    'engines/segment':  { card: 'engines', zone: 0, options: { zone: 'segment' }, category: 'engines', surface: 'card' },
    'engines/sam2':     { card: 'engines', zone: 0, options: { zone: 'sam2' }, category: 'engines', surface: 'card' },
    'engines/detail':   { card: 'engines', zone: 0, options: { zone: 'detail' }, category: 'engines', surface: 'card' },
    // DLSS 单独一页（不在三档梯子上，授权还没拍板）
    'engines/dlss':     { card: 'engines', zone: 0, options: { zone: 'dlss' }, category: 'engines', surface: 'card' },
    'settings/layout': { card: 'settings', zone: 2, options: { section: 'layout' }, category: 'settings', surface: 'card' },
    'tools/network': { card: 'debug', zone: 0, options: { section: 'network' }, category: 'tools', surface: 'workspace', module: 'V7NetworkDoctor' },
    'tools/bookmarks': { card: 'debug', zone: 0, options: { section: 'bookmarks' }, category: 'tools', surface: 'workspace', module: 'V7BrowserBookmarks' },
    'tools/scopes': { card: 'debug', zone: 0, options: { section: 'scopes' }, category: 'tools', surface: 'workspace', module: 'V7ImageScopes' }
  });

  const ALIASES = Object.freeze({
    account: 'settings/account',
    service: 'settings/account',
    provider: 'settings/providers',
    own: 'settings/providers',
    platform: 'settings/compute',
    local: 'settings/local',
    photoshop: 'settings/photoshop',
    output: 'settings/generation',
    appearance: 'settings/interface',
    tools: 'settings/advanced',
    layout: 'settings/layout',
    billing: 'records/billing',
    costs: 'records/billing',
    backup: 'records/backup',
    checkpoints: 'records/recovery',
    recovery: 'records/recovery',
    history: 'records/generation',
    recent: 'records/recent',
    prompts: 'records/prompts',
    project: 'projects/progress',
    projects: 'projects/progress',
    schedule: 'projects/schedule',
    eagle: 'projects/eagle',
    // ⭐ 外挂卡（2026-10-01）：裸名 engines 也能开（老代码/提醒条可能这么写）
    engines: 'engines/overview',
    engine: 'engines/overview',
    matting: 'engines/matting',
    segment: 'engines/segment',
    sam2: 'engines/sam2',
    dlss: 'engines/dlss'
  });

  const SURFACES = Object.freeze({
    card: { modal: 'none', closePolicy: 'return' },
    workspace: { modal: 'none', closePolicy: 'return' },
    dialog: { modal: 'confirm', closePolicy: 'explicit' },
    childWindow: { modal: 'window', closePolicy: 'window' },
    l4: { modal: 'blocking', closePolicy: 'resolve' }
  });

  function resolve(routeId) {
    const raw = String(routeId || '').trim();
    const id = ROUTES[raw] ? raw : (ALIASES[raw] || raw);
    const route = ROUTES[id];
    if (!route) throw new Error('未知的 V7 路由：' + raw);
    return { id, ...route, options: { ...(route.options || {}) } };
  }

  let openSequence = 0;
  function open(routeId, extra) {
    const route = resolve(routeId);
    const navigate = root.V7CardRoutes?.open;
    if (typeof navigate !== 'function') throw new Error('V7 卡片导航尚未就绪：' + route.id);
    const sequence = ++openSequence;
    const options = { ...route.options, ...(extra || {}) };
    const result = navigate(route.card, route.zone, options);
    const finish = value => {
      const response = { route, value };
      // The card host reports direct navigation/account invalidation through
      // cancelled. The local sequence also rejects older registry requests,
      // including two tools sharing the same debug card and zone.
      if (!route.module || value?.cancelled || value?.ok === false || sequence !== openSequence) return response;
      const target = root[route.module];
      if (typeof target?.open !== 'function') throw new Error('V7 工具尚未就绪：' + route.id);
      const workspace = target.open(options);
      return workspace && typeof workspace.then === 'function' ? workspace.then(() => response) : response;
    };
    return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
  }

  root.V7RouteRegistry = Object.freeze({ routes: ROUTES, aliases: ALIASES, surfaces: SURFACES, resolve, open });
  if (root.V7CardRoutes) root.V7CardRoutes.openRoute = open;
})(window);
