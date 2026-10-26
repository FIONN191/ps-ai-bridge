/* ══════════════════════════════════════════════════════════════════════════
 * V7 卡片注册表（card-registry.js）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这是干什么的
 * ────────────
 * 在这之前，"有哪些卡、每张卡几级、二级叫什么、谁负责画内容" 散在 6 个地方：
 *
 *   · ui.html            静态 HTML 里的 .block-card（一级卡本体）
 *   · ui.html  ZONE_SETS 二级格的名字和图标
 *   · route-registry.js  路由 → 卡片 的跳转映射
 *   · main-card-shortcuts.js  一级卡正面的快捷格
 *   · engines-card.js / records-card.js / settings-card.js  单张大二级卡自己的内容
 *   · ui.html  各 isXxxCard() 判断
 *
 * 要定位一张卡得横跨这 6 处搜。这份表把它们**收敛成一处**，
 * 用来回答三个问题：
 *
 *   ① 有哪些卡？（9 张一级卡）
 *   ② 这张卡是几级？（一级 + 二级，还是有三级）
 *   ③ 改这张卡该动哪个文件？
 *
 * ⚠⚠ 这份表**目前还没有被 ui.html 引用**（2026-10-04 建表时故意不接线）
 * ─────────────────────────────────────────────────────────────────────
 * 原因：10-06 就冻结改动、10-07 上线。往 ui.html 里加 <script> 要重编 exe、
 * 要过测试切片，风险不值得。所以这份表现在**纯粹是开发用的地图**：
 * 给我和后来的对话查，不改任何行为。
 *
 * 接线的时机在**上线之后**，做法写在 docs/137。
 * ⚠ 在接线之前，这张表和真实代码**可能漂移** —— 所以配了一个校验脚本：
 *     node scripts/check-card-registry.cjs
 * 它拿这份表去比对 ui.html 的实际内容，不一致就报错。
 * **改过卡片结构之后跑一下它**，别让地图失真。
 *
 * 表的字段
 * ────────
 *   id        卡片 id（data-card 属性的值，也是路由里的 card 名）
 *   index     一级卡的堆叠序（data-b 属性，0 是最上面那张）
 *   name      卡面显示名（data-bglabel）
 *   footInfo  卡脚那行小字（.bc-foot-info）
 *   levels    'main-zone'   = 一级 + 二级（老结构，二级上还能推三级）
 *             'main-bigzone'= 一级 + 【单张大二级】，没有三级
 *   zones     二级格列表（ZONE_SETS 里的那一组）
 *             ⚠ 'main-bigzone' 的卡这里只有一项，那是"槽位名"，
 *               真正的页签由卡片自己的渲染器管（见 innerTabs）
 *   innerTabs 单张大二级卡**内部的**页签/栏（不是二级格）
 *   providers 内容由谁提供（改这张卡要动的文件）
 *   face      一级卡正面的快捷格谁画
 *   detail    三级面板（#detail）用不用、谁填
 *   module    这张卡的运行时全局名（如果对外暴露了）
 *   status    实装状态：'done' 完整 / 'partial' 部分 / 'shell' 空壳
 *   notes     坑和注意事项（从代码注释里搬过来的，别丢）
 *
 * ⚠ 这份文件是**纯数据 + 纯函数**，不碰 DOM、不发请求、不产生副作用。
 *   加载它不会改变任何行为（这也是它能安全地先在旁边放着的原因）。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // ── 二级格图标：ZONE_SETS 用的是图标名，这里保留原名 ──
  // （真正渲染时由 setZoneIcon() 走 ICON.set，这里只记名字）

  var CARDS = [
    {
      id: 'generation',
      index: 0,
      name: '生成',
      footInfo: '提示词 · 参数 · 开始生成',
      // ⭐⭐ 2026-10-15 用户定：二级目录删掉，换成单张大二级；三级不要了。
      levels: 'main-bigzone',
      status: 'partial',
      zones: [
        { i: 0, name: '生成', sub: '开始生成 · 参考图 · 结果', ico: 'sparkles', slot: 'all' }
      ],
      // ⚠ 必须跟 ui.html 的 GENERATION_TABS 逐行一致（check-card-registry.cjs 对账）
      innerTabs: [
        { id: 'run', name: '开始生成', sub: '抓选区、开始生成、看进度', group: '本次生成' },
        { id: 'refs', name: '参考图', sub: '这次会带几张参考图；加图、删图、排序都在参考图卡上', group: '本次生成' },
        { id: 'results', name: '生成结果', sub: '看这次出的图，传回到 Photoshop', group: '本次生成' },
        { id: 'where', name: '相关设置', sub: '出图尺寸、传回、编组、羽化、校色在设置卡里调', group: '去设置' }
      ],
      providers: ['ui.html:renderGenerationCardFields()', 'ui.html:renderGenerationPage()', 'settings-card.js'],
      face: 'ui.html',
      detail: '否（2026-10-15 起没有三级；fillDetailBody 对生成卡只收不画）',
      module: 'V7GenerationPanel',
      notes: [
        '⭐ 用户 10-04 点名：这是四张要填的卡的【第一张】，"重中之重"。',
        '⭐ 2026-10-15：原四格（生成图片/参考图片/生成结果/生成与传回设置）合进一张大二级 #generationZone，组件同设置卡（V7SettingsCard）。',
        '老路由 generation 档位 0~3 → 大二级里的 run / refs / results / where 四节（ui.html GENERATION_ZONE_SECTION）。',
        '⚠ 原四格的背景槽位 zone/detail.generation.prompt|refimage|results|help 仍登记为「保留背景」（bgSlotList historical），主题包不丢。'
      ]
    },

    {
      id: 'presets',
      index: 1,
      name: '预设',
      footInfo: '剪影 · 提示词',
      levels: 'main-zone',
      status: 'partial',
      zones: [
        { i: 0, name: '预设列表', sub: '按部位挑预设', ico: 'person', slot: 'list' }
      ],
      innerTabs: [],
      providers: ['preset-ui.js', 'preset-store.js', 'preset-references.js', 'preset-preactions.js'],
      face: null,
      detail: '是（⚠ 特殊：提示词框直接当二级，见 notes）',
      module: 'V7PresetUI / PRESETUI',
      notes: [
        '⚠⚠ 二级只有【一张】卡（#presetZone），不是四张。四张普通 .zone 在预设卡下是隐藏的。',
        '⭐ 路线 A（用户 2026-09-11 定案）：从剪影卡右滑 → 【提示词框本体当二级】（#detail 挪过去）。',
        '⭐ 路线 B：点部位 → 预设列表当二级 → 在某一行上右滑弹那一行的三级。',
        '不在任何行上右滑则什么都不做（不弹空框）。',
        '⚠ 用户 10-04 说这张卡里"相当多的工具还没落地实装或经过检测"。'
      ]
    },

    {
      id: 'settings',
      index: 2,
      name: '设置',
      footInfo: '账号 · 外观 · 存储',
      levels: 'main-bigzone',
      status: 'partial',
      zones: [
        { i: 0, name: '设置', sub: '一列到底 · 右边目录点哪滚到哪', ico: 'keyhole', slot: 'all' }
      ],
      innerTabs: [
        // ⭐⭐⭐ 2026-10-14 整轮重排：设置卡不再分页，右边导航是一列到底的小节清单。
        //   ⭐ 2026-10-15：按 ui.html 的 SETTINGS_TABS 重新生成（10-14 公告挪到第一行后这里没跟上，漂了 73 处；
        //     「检查连接」并进「用哪家生图」后少一行）。
        //   ⚠ 必须跟 ui.html 的 SETTINGS_TABS 逐行一致（check-card-registry.cjs 对账）。
        { id: 'notices', name: '公告与状态', sub: '平台公告，和服务现在正不正常', group: '平台' },
        { id: 'account', name: '登录账号', sub: '登录、注册、退出；看现在有没有登录', group: '账号' },
        { id: 'credits', name: '积分与充值', sub: '平台积分余额、卡密兑换、积分流水', group: '账号' },
        { id: 'keysync', name: 'Key 云同步', sub: '把你的 API Key 加密存到云端，换电脑不用重填', group: '账号' },
        { id: 'provider', name: '用哪家生图', sub: '选服务商、填地址和 Key，紧跟着检查连接、看余额', group: '生图服务' },
        { id: 'imagecompute', name: '出图花谁的钱', sub: '用你自己的 Key，还是用平台积分', group: '生图服务' },
        { id: 'lowbalance', name: '余额警告线', sub: '余额低于多少时提醒你', group: '生图服务' },
        { id: 'engine', name: '工作流跑在哪', sub: 'ComfyUI 这类开源工作流、开源模型模式：跑在本地、自己的服务器，还是平台云端', group: '工作流引擎' },
        { id: 'comfy', name: '本地 ComfyUI', sub: '你电脑上 ComfyUI 的地址，和连接检查', group: '工作流引擎' },
        { id: 'runninghub', name: 'RunningHub', sub: '在线工作流账号，和把工作流导入成预设', group: '工作流引擎' },
        { id: 'align', name: '对齐与校色', sub: '生成的图怎么对齐原图、颜色怎么跟原图一致', group: '生成与传回' },
        { id: 'output', name: '抓图与出图', sub: '发给 AI 的图多大、AI 出的图多大', group: '生成与传回' },
        { id: 'return', name: '传回到 PS', sub: '生成完要不要自动贴回、贴成什么图层', group: '生成与传回' },
        { id: 'group', name: '编组与联动', sub: '传回的图怎么编组；划缩略图时 PS 怎么跟着切', group: '生成与传回' },
        { id: 'feather', name: '边缘羽化', sub: '让贴回的图和原图之间看不出接缝', group: '生成与传回' },
        { id: 'sound', name: '完成音效', sub: '生成完响一声提醒你', group: '生成与传回' },
        { id: 'scale', name: '界面大小', sub: '整个软件一起放大缩小；笔记本屏幕放不下就调小', group: '外观' },
        { id: 'theme', name: '配色', sub: '卡片底色、文字颜色、主题色', group: '外观' },
        { id: 'display', name: '透明与毛玻璃', sub: '卡片透不透明、背景虚化多少、背景图清晰度、减少动画', group: '外观' },
        { id: 'bars', name: '悬浮条', sub: 'Agent 悬浮窗要不要显示', group: '外观' },
        { id: 'layout', name: '布局与恢复', sub: '保存、恢复卡片的摆放位置', group: '外观' },
        { id: 'freemode', name: '自由摆放', sub: '让每张卡片都能随意拖动摆放', group: '操作' },
        { id: 'interaction', name: '滚轮与预览', sub: '滚多少格换卡；缩略图悬停要不要弹大图；只在用 PS 时置顶', group: '操作' },
        { id: 'shortcuts', name: '快捷键', sub: '开始生成、加参考图、一键收起展开的快捷键', group: '操作' },
        { id: 'checkpoint', name: '检查点', sub: '隔一段时间自动存一份完整画布，出事能找回', group: '存储与备份' },
        { id: 'cache', name: '缓存', sub: '生成的图存在哪、最多占多大空间', group: '存储与备份' },
        { id: 'backup', name: '账号云备份', sub: '把设置和预设备份到云端，或从云端恢复', group: '存储与备份' },
        { id: 'autobackup', name: '自动备份', sub: '要不要自动备份、多久一次', group: '存储与备份' },
        { id: 'reset', name: '恢复默认', sub: '把这个账号的设置恢复到出厂状态', group: '存储与备份' },
        { id: 'assistant', name: '助手模型', sub: '聊天助手接哪个语言模型', group: '助手与隐私' },
        { id: 'permissions', name: 'Agent 权限', sub: '助手能看什么、能改什么', group: '助手与隐私' },
        { id: 'recovery', name: '助手修改回滚', sub: '把助手改过的软件退回到以前的样子', group: '助手与隐私' },
        { id: 'telemetry', name: '匿名反馈', sub: '要不要发送匿名的使用与报错信息', group: '助手与隐私' },
        { id: 'photoshop', name: 'Photoshop 联动', sub: '选 PS 版本、安装或修复桥接插件', group: '软件与服务' },
        { id: 'support', name: '客服记录', sub: '你提交过的客服工单', group: '软件与服务' },
        { id: 'community', name: '社区', sub: '打开社区网页', group: '软件与服务' },
        { id: 'about', name: '关于软件', sub: '版本号、连的哪个后台、PS 插件和引擎的状态；报问题时复制诊断信息', group: '软件与服务' }
      ],
      providers: ['settings-card.js', 'card-architecture.js:settingsTab()', 'ui.html:SETTINGS_TABS'],
      face: 'main-card-shortcuts.js',
      detail: '× 没有三级（单张大二级）',
      module: 'V7SettingsCard',
      notes: [
        '⚠⚠ 用户 10-04：「纯纯的一坨」。点名批评「连接与账号」。',
        '⚠ 用户指出的结构错误：右边已经分页了，左边【不该再分菜单】。',
        '⚠ "连接与账号"页里有 7 个按钮，点下去还翻页、按钮 UI 还变（用户点名批评）。',
        '⭐ 用户 10-04 定：滚动【绝不许】触发卡片翻页。',
        '⚠ 路由：全部 zone 恒为 0，真正的页签由 options.section 决定（settingsTabIdFromSection）。',
        '⚠⚠ SETTINGS_SECTION_TAB 必须【穷举】—— 漏一项不报错，会静默落到第一页。',
        '⚠ ZONE_SETS 里给设置卡写的是 4 个标签，但 SETTINGS_TABS 实际是 5 个 ***** 已经对不上了 *****（见 docs/137 §漂移）。'
      ],
      // ⚠⚠ 已知漂移（校验脚本会报，但【不是表写错】）
      // ZONE_SETS[2] 里给设置卡写了 4 个二级标签，那是 2026-10-01 改成
      // 「一张大二级 + 右边点阵导航」【之前】的残留。现在设置卡只用 zones[0]，
      // 那 4 个标签谁也走不到（ZONE_SETS[2] 的注释自己都写着"只提供固定的二级标签"）。
      // ⇒ 表这里按【真实情况】写 1 个，校验器用 knownDrift 放行。
      // 清理时机：上线后一并处理（要么删掉那 4 项、要么让它们跟 SETTINGS_TABS 对齐）。
      knownDrift: {
        field: 'zones',
        actualCount: 4,
        reason: 'ZONE_SETS[2] 的 4 个标签是「单张大二级」改造前的残留；且设 4 个 vs SETTINGS_TABS 5 个，两边也对不上'
      }
    },

    {
      id: 'engines',
      index: 3,
      name: '外挂能力',
      footInfo: '档位 · 模型 · 能力开关',
      levels: 'main-bigzone',
      status: 'partial',
      zones: [
        { i: 0, name: '外挂能力', sub: '档位 · 模型 · 能力开关', ico: 'bolt', slot: 'all' }
      ],
      // ⭐⭐ 2026-10-04 深夜重排：右栏从【8 个能力页】改成【4 页导航】。
      //   用户原话："右边不要放档位啊，就二级大卡不要放档位。"
      //   "第一个页面就是你的配置信息。然后一级能力、二级能力、三级能力，
      //    然后这是能力的这个简介……"
      innerTabs: [
        { id: 'config', name: '配置信息', ico: 'cpu' },
        { id: 'basic',  name: '基础',     ico: 'cpu' },
        { id: 'expand', name: '拓展',     ico: 'gpu' },
        { id: 'high',   name: '高性能',   ico: 'gpu' }
      ],
      providers: ['engines-card.js', 'engines-core.js', 'engine-models-ui.js', 'engine-environment-ui.js'],
      face: 'main-card-shortcuts.js',
      detail: '× 没有三级（单张大二级）',
      module: 'V7EnginesCore / V7EnginesCard',
      notes: [
        '√ 2026-10-04 深夜已重排完（用户看完样机后逐条口述，已实装）。',
        '⭐ 一级卡面 = 【一张总表】：横轴三档（基础/拓展/高性能），纵轴能力。',
        '   ⚠⚠ 格子里【不打勾打叉】，写的是"这一档下它是什么形态"（精确抠 / 快速分 / 打字抠…）。',
        '     依据：用户原话"不一定是勾勾叉叉了，它可以去再多一个维度的信息"。',
        '     这么改之后「文字选区」「精修边缘」两个怪名字自动消失 —— 它们是别的能力在更高档下的样子。',
        '⭐ 二级 = 顶部【机器配置 + 引擎状态】（常驻）+ 左边当前页 + 右边四页导航。',
        '   ⚠ 右栏【不再是档位梯子】（用户明说"不要放档位"）。',
        '   ⚠ 点一级格子 → 跳到那一档的页，并高亮那一样能力（.capblk.flash 闪一下）。',
        '⚠ 一级卡面【没有详情区】了 —— 用户要"一眼看穿的图表"，.ec-detail 整个删掉。',
        '⚠ 表头那个坑（问号绝对定位把三列挤歪）已根治：表头不再自己做 grid，',
        '   改成 .ec-hint 一行 + .ec-hrow 一行，hrow 与数据行共用 --ec-cols 变量。',
        '⚠ 底栏不做统计（用户："一眼看穿的图表"），只写图上看不出来的"引擎在不在"。'
      ]
    },

    {
      id: 'history',
      index: 4,
      name: '记录与恢复',
      footInfo: '任务 · 检查点 · 恢复到任务栏',
      levels: 'main-bigzone',
      status: 'done',
      zones: [
        { i: 0, name: '记录与恢复', sub: '任务 · 检查点 · 恢复到任务栏', ico: 'scroll', slot: 'all' }
      ],
      innerTabs: [],
      providers: ['records-card.js', 'records-core.js', 'checkpoints.js', 'history-library.js', 'history-prompts.js'],
      face: '× 不归 main-card-shortcuts 管（见 notes）',
      detail: '× 没有三级（单张大二级）',
      module: 'V7RecordsCard',
      notes: [
        '⭐ 用户 10-04 评价：这是所有卡里【做得最完整】的一张，"没有过多的冗余类的东西"。',
        '⚠ 但用户报了性能问题：项目 → 多次计算 → 点开某一次，【非常严重的卡顿和不跟手】。待查。',
        '⚠⚠ 卡面【不归 main-card-shortcuts.mount() 管】—— 那里对 history 直接 return。',
        '   原来会 node.innerHTML=markup[id]() 把这一格整个覆盖掉，而记录卡卡面建在同一个 .bc-inner 里，',
        '   于是"记录卡永远空白、还不报错"（第一次跑截图就栽在这）。',
        '⚠ 单张大二级卡【没有三级】，不许从右滑被推出来（docs/96 问题一的第 2 条路径）。'
      ]
    },

    {
      id: 'projects',
      index: 5,
      name: '项目',
      footInfo: '项目 · 日程 · Eagle',
      levels: 'main-zone',
      status: 'shell',
      zones: [
        { i: 0, name: '项目管理',   sub: '照片 · 进度 · 交付',       ico: 'package', slot: 'projects' },
        { i: 1, name: '本项目记录', sub: '这单活的生成任务',        ico: 'scroll',  slot: 'records' },
        { i: 2, name: '拍摄日程',   sub: '提醒 · 到点通知',          ico: 'scroll',  slot: 'schedule' },
        { i: 3, name: 'Eagle 归档', sub: '素材 · 标签 · 导入',      ico: 'image',   slot: 'eagle' }
      ],
      innerTabs: [],
      providers: ['main-card-shortcuts.js', 'project-schedule.js', 'eagle-archive.js'],
      face: 'main-card-shortcuts.js',
      detail: '是',
      module: 'V7ProjectSchedule',
      notes: [
        '⚠ 用户 10-04 点名：这是四张要填的卡之一，"重中之重"。',
        '⭐ 2026-09-29 方案 B：项目卡 = 当前这单活的全部内容；「本项目记录」从时间线卡的「本次项目」挪来。',
        '⚠ 拍摄日程原写「关联项目」，但日程条目里没有项目字段（只是提醒）—— 已改成如实描述。',
        '⚠ Eagle 归档在第 4 格（zone 3），动作名 eagle 已跟着改（原来第 3 格）。'
      ]
    },

    {
      id: 'assistant',
      index: 6,
      name: '助手',
      footInfo: '直接开工 · 快捷指令 · 对话',
      levels: 'main-bigzone',
      status: 'partial',
      zones: [
        { i: 0, name: '助手', sub: '对话 · 开工 · 快捷指令', ico: 'sparkles', slot: 'all' }
      ],
      // ⚠ 必须跟 agent-zone.js 的 RAIL 逐行一致（check-card-registry.cjs 对账）
      innerTabs: [
        { id: 'chat', name: '当前对话', sub: '跟夏三六聊、抓画布、发任务', group: '对话' },
        { id: 'history', name: '历史会话', sub: '切换、改名、删除会话', group: '对话' },
        { id: 'task', name: '当前任务', sub: '在干 / 回话了 / 出错', group: '任务' },
        { id: 'results', name: '结果清单', sub: '等修图流程做出来才有', group: '任务' },
        { id: 'model', name: '模型连接', sub: '服务商、Key、模型、连接测试（旧面板原样挂进来）', group: '设置' },
        { id: 'perm', name: '权限恢复', sub: 'Agent 权限与恢复节点（旧助手改软件那套）', group: '设置' },
        { id: 'probe', name: '能力自测', sub: '会不会调工具、能不能看图、能不能调思考强度', group: '设置' },
        { id: 'way', name: '工作方式', sub: '怎么跑 / 思考强度 / 仔细程度 / 工具坏了', group: '设置' },
        { id: 'starts', name: '开工按钮', sub: '主卡上「直接开工」那几个按钮', group: '设置' },
        { id: 'quick', name: '快捷指令', sub: '悬浮框下面那排按钮', group: '设置' }
      ],
      providers: ['agent-zone.js', 'agent-service.js', 'agent-prompt.js', 'assistant-panel.js', 'assistant-runtime.js', 'floating-bars.js'],
      face: 'agent-zone.js mountFace()（main-card-shortcuts.js 把卡面交给它）',
      detail: '否（2026-10-17 起没有三级；fillDetailBody 对助手卡只收不画）',
      module: 'V7AgentZone / V7AgentService',
      notes: [
        '⭐ 2026-10-17 夏三六（docs/231）：原四格（对话与会话 / 模型与连接 / Agent 权限 / 恢复节点）合进一张大二级 #assistantZone。',
        '老路由 assistant 档位 0~3 → 大二级里的 chat / model / perm / perm（ui.html ASSISTANT_ZONE_SECTION）。',
        '主卡能直接开工：按钮内容用户在二级「开工按钮」里自己定（V7AgentService 存，按账号分开）。',
        '⚠ 原四格的背景槽位 zone/detail.assistant.chat|connection|permissions|recovery 仍登记为「保留背景」（bgSlotList historical），主题包不丢。',
        '⚠ 设置卡「工具与隐私」里还有一份旧面板（助手模型那节）；旧面板同一时间只有最后挂的那份是活的，所以本卡每次打开设置页都重挂。'
      ]
    },

    {
      id: 'debug',
      index: 7,
      name: '调试',
      footInfo: '运行状态 · 报错 · 日志',
      levels: 'main-zone',
      status: 'shell',
      zones: [
        { i: 0, name: '运行诊断', sub: '调试开关 · 性能 · 网络', ico: 'bolt',   slot: 'runtime' },
        { i: 1, name: '报错演示', sub: 'L1 · L2 · L3 · L4',     ico: 'shield', slot: 'errors' },
        { i: 2, name: '日志',     sub: '桥接记录 · 清空 · 导出', ico: 'scroll', slot: 'logs' }
      ],
      innerTabs: [],
      providers: ['main-card-shortcuts.js', 'error-report.js'],
      face: 'main-card-shortcuts.js',
      detail: '是',
      module: null,
      notes: [
        '⚠ 用户 10-04 点名：引擎/模型的【调试报错栏】要放这里 + 报错弹窗里。',
        '⚠ 一级卡面刻意做得克制："报错模拟、清空日志和重启等操作保留在三级，避免误触"。',
        '⚠ 日志页现在只有 3 格，将来要装"引擎启动/环境校验"的详细日志 —— 用户要"非常非常详细"。'
      ]
    },

    {
      id: 'feedback',
      index: 8,
      name: '问题反馈',
      footInfo: '写问题 · 贴截图 · 直接发到后台',
      // ⭐ 2026-10-18 深夜（docs/248）：用户「新增一个问题反馈卡片 默认打开 … 可以贴图片 … 直接到服务器的内容反馈内来」
      levels: 'main-bigzone',
      status: 'done',
      zones: [
        { i: 0, name: '问题反馈', sub: '写问题 · 贴截图 · 发到后台', ico: 'info', slot: 'all' }
      ],
      // ⚠ 必须跟 feedback-card.js 的 TABS 逐行一致
      innerTabs: [
        { id: 'write', name: '写下问题', group: '反馈' },
        { id: 'images', name: '截图', group: '反馈' },
        { id: 'diag', name: '诊断信息', group: '反馈' },
        { id: 'send', name: '发送', group: '发出去' }
      ],
      providers: ['feedback-card.js', 'feedback-card.css', 'ui.html:feedbackCardMount()', 'backend-client.js:submitFeedback', 'backend/feedback.py'],
      face: 'feedback-card.js',
      detail: '× 没有三级（单张大二级）',
      module: 'V7Feedback',
      notes: [
        '单向反馈箱：用户发，后台「问题反馈」页看、标已处理；要人工回复走客服工单。',
        '必须登录；图片最多 4 张、每张 ≤ 2MB（本机先缩，服务器再解码核对）；诊断信息默认带、可取消。',
        'L2 / L3 报错卡上的「反馈这个问题」会带着错误码打开这张卡（ui.html addErrorCard）。'
      ]
    },

    {
      id: 'community',
      index: 9,
      name: '社区',
      footInfo: '谁在修图 · 排行榜 · 大家的分享',
      // ⭐ 2026-10-20：用户「把社区单独做一个卡片…显示今天社区有多热闹…从社区卡片进到社区网页」「社区的预设要能一键加到我的预设」
      levels: 'main-bigzone',
      status: 'done',
      zones: [
        { i: 0, name: '社区', sub: '排行榜 · 热门分享 · 进社区网页', ico: 'info', slot: 'all' }
      ],
      // ⚠ 必须跟 community-card.js 的 TABS 逐行一致
      innerTabs: [
        { id: 'rank', name: '修图排行榜', group: '热闹' },
        { id: 'hot', name: '热门分享', group: '分享' },
        { id: 'web', name: '进社区网页', group: '分享' }
      ],
      providers: ['community-card.js', 'community-card.css', 'ui.html:communityCardMount()', 'backend-client.js:communitySummary/leaderboard/communityPrompts', 'preset-ui.js:importItems'],
      face: 'community-card.js',
      detail: '× 没有三级（单张大二级）',
      module: 'V7Community',
      notes: [
        '数据全是后台现成的社区接口，没改后台；必须登录才看得到。',
        '「正在陪你修图」只数自己打开了「公开在线状态」的人（后台 community_activity）。',
        '一键加到我的预设：预设帖跟网页「下载预设文件」同一条（固定 id community_<帖子id>，重复加自动跳过）；提示词帖包成普通提示词预设。'
      ]
    }

    // ⚠⚠⚠ 2026-10-14：原「使用教程」卡（id: tutorial, index: 8）在这里，【已被删除】。
    //   删掉的原因（用户定）：「现在在开发阶段，教程和首次启动的东西到时候都需要重做」。
    //   ⇒ 教程和首启都要重做，留着半成品比删掉更坏（铁律 16：要么真接线，要么别出现）。
    //
    //   ⚠ 它的第 4 格「完整手册」【不是教程】，是 V7Manual —— 已改成走手册自带的浮层，
    //     入口在设置卡（见 ui.html 里 V7Manual.configure 那段）。
    //   ⚠ 重做教程卡时要恢复的东西（清单见 docs/217_交接_教程与首启拆除与重做接口_20261014.md）：
    //     · 这个 CARDS 条目（id 'tutorial' / index 8 / 4 格）
    //     · ui.html 里的 <div data-card="tutorial"> 卡面
    //     · ui-pure/cards/card-tutorial.js 的注册
    //     · layout-core.js 的 definitions 和 free-layout-core.js 的 CARD_IDS 里加回 'tutorial'
    //     · main-card-shortcuts.js 的 ids 数组里加回 'tutorial'，并恢复 markup.tutorial
    //     · card-architecture.js 的 tutorial()（现在只剩手册那一支）
  ];

  // ── 便捷索引 ──
  // ⚠ 这三个 Map 是惰性建的（第一次调用时才建），避免加载时做多余工作。
  var _byId = null, _byIndex = null, _bigZone = null;

  function byId() {
    if (!_byId) {
      _byId = Object.create(null);
      CARDS.forEach(function (c) { _byId[c.id] = c; });
    }
    return _byId;
  }

  function byIndex() {
    if (!_byIndex) {
      _byIndex = Object.create(null);
      CARDS.forEach(function (c) { _byIndex[c.index] = c; });
    }
    return _byIndex;
  }

  /** 单张大二级的卡（设置 / 外挂 / 记录）—— 它们【没有三级】 */
  function bigZoneCards() {
    if (!_bigZone) {
      _bigZone = CARDS.filter(function (c) { return c.levels === 'main-bigzone'; });
    }
    return _bigZone;
  }

  /**
   * 这张卡有没有三级（#detail）？
   * ⚠ 判断依据是 levels 字段，不是"有没有 z 项"——
   *   单张大二级的卡也有一项 zone（那是槽位名）。
   */
  function hasDetail(cardId) {
    var c = byId()[cardId];
    return !!c && c.levels === 'main-zone';
  }

  /** 全部卡 id，按堆叠序 */
  function ids() {
    return CARDS.slice().sort(function (a, b) { return a.index - b.index; })
      .map(function (c) { return c.id; });
  }

  /** 某张卡的全部二级格名（'main-bigzone' 返回的是槽位名，见文件头说明） */
  function zoneNames(cardId) {
    var c = byId()[cardId];
    return c ? c.zones.map(function (z) { return z.name; }) : [];
  }

  /** 某张卡该改哪些文件 */
  function providersOf(cardId) {
    var c = byId()[cardId];
    return c ? c.providers.slice() : [];
  }

  /** 实装状态汇总：{ done: [...], partial: [...], shell: [...] } */
  function statusSummary() {
    var out = { done: [], partial: [], shell: [] };
    CARDS.forEach(function (c) {
      if (out[c.status]) out[c.status].push(c.id);
    });
    return out;
  }

  root.V7CardRegistry = Object.freeze({
    schema: 1,
    updated: '2026-10-04',
    // ⚠ 表本身不接线，只读
    wired: false,
    cards: CARDS,
    byId: byId,
    byIndex: byIndex,
    bigZoneCards: bigZoneCards,
    hasDetail: hasDetail,
    ids: ids,
    zoneNames: zoneNames,
    providersOf: providersOf,
    statusSummary: statusSummary
  });

  // 给 Node（校验脚本）用，浏览器里 root 就是 window，这行不影响
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.V7CardRegistry;
  }
})(typeof window !== 'undefined' ? window : globalThis);
