// ═══ 报错管家 —— 全项目唯一的报错出口 ═══
//
// 规矩见 docs/31_报错分级规范.md。一句话：
//   L1 通知一声 · L2 解释原因 · L3 要你选 · L4 拦住你
//
// 为什么非要有这个东西(2026-09-11 实测账)：
//   这天排查"生成失败"，界面只给了一句 `Failed to fetch`——
//   看不出是没连上、被拒收、还是图太大。查了一个多小时，
//   最后靠读源码才定位。而真正的诊断信息【一直都在】：
//   UXP 那边 V6 留下的现场信息(位深/色彩模式/三种检测方式)早就传到界面了，
//   只是没有地方放，被 linkResultMessage 只取一个 message 字段给扔了。
//
// ⚠ 最重要的一条：**报错必须带现场，并且告诉用户下一步干什么。**
//   "失败了"是废话。"没找到选区，因为文档是 16 位的，去 图像→模式→8位 改一下"才是报错。
//
// ⚠ 第二条：**新增错误码只往 CATALOG 里加一行，不要在业务代码里写死文案。**
//   写死的文案改不动、翻译不了、也没法统一定级。
(function () {
  'use strict';

  // ── 日志出口。ui.html 启动时用 setLogSink 接上 aiAddLog，
  //    没接上时退化成 console，保证这个模块单独也能跑。 ──
  let logSink = null;
  function writeLog(message, level) {
    if (typeof logSink === 'function') {
      try { logSink(String(message), level || 'info'); return; } catch (_) {}
    }
    try { (level === 'error' ? console.error : console.warn)('[报错]', message); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════
  //  错误码表
  //
  //  每条四个字段：
  //    severity  L1/L2/L3/L4 —— 打断程度，见顶部规矩
  //    level     ok/info/warn/err —— 只管图标和颜色，跟打断程度无关
  //    title     报错卡标题，**一句人话**，不要出现英文错误码
  //    advice    下一步干什么。没有可靠建议就留空，别编。
  //
  //  ⚠ title 是给用户看的，不是给程序员看的。
  //    "NO_DOCUMENT" ✗   "Photoshop 里没有打开的图" ✓
  // ═══════════════════════════════════════════════════════════
  const CATALOG = {
    // ⭐ 2026-10-04 过渡帧（调强度）。用户明确要求：这几条必须【常驻】，
    //   不能是一闪就没的提示 —— 不然看不到真正的原因。
    TWEEN_ENGINE_MISSING: {severity:'L2',level:'err',title:'调强度用不了：本地引擎没准备好',
      advice:'先看设置 → 工具与隐私 → 本地引擎：引擎要处于「正在运行」。如果引擎在跑还是报这个，说明装的引擎版本旧了，或者少装了一样东西。详情里有引擎地址和原始原因。'},
    // ⭐ 2026-10-21（docs/261 B9）：开着云端外挂时调强度也在云端算，连不上要说云端，不能说「本地引擎」
    TWEEN_CLOUD_UNREACHABLE: {severity:'L2',level:'warn',title:'调强度：云端外挂暂时连不上',
      advice:'多半是网络抖了一下或者算力机正忙，等几秒再在缩略图上滚一下就行。一直不行的话看设置 → 工具与隐私 → 云端外挂的状态。'},
    TWEEN_COMPUTE_FAILED: {severity:'L2',level:'err',title:'这张图的强度调不出来',
      advice:'右滑看详情：「原图/成品在内存里」有一项是「false」的话，是那张图已经被释放了（换任务/切账号会释放），重新生成或重新点开这张图再试。两项都是 true 就是引擎那边算不出来，详情里有原始报错。'},
    TWEEN_RENDER_FAILED: {severity:'L2',level:'warn',title:'预览框画不出来',
      advice:'图仍在缓存里，不影响传回。可以先关掉预览框再重新推出来。'},
    SEAM_REVIEW_FAILED: {severity:'L2',level:'err',title:'AI 修图痕迹检测未完成',advice:'查看详情中的原因。确认 Photoshop 文档仍打开、联动插件已 Reload；若已进入传回，请先检查图层面板，再决定是否重试。'},
    SEAM_REVIEW_TIMEOUT: {severity:'L2',level:'err',title:'AI 修图痕迹检测等待超时',advice:'检查 Photoshop 是否正忙或被对话框挡住。传回可能仍在完成，请先检查图层面板，避免重复添加。'},
    SEAM_REVIEW_FOCUS_FAILED: {severity:'L2',level:'warn',title:'没能跳到这处痕迹',advice:'确认检测的那个 PSD 还开着，「AI修图痕迹检测标注」组和里面的痕迹图层没被删掉或移走；联动插件要 Reload 到 0.1.5 以上。仍不行就重新检测一次。'},
    RETURN_PROBE_FAILED:{severity:'L2',level:'warn',title:'回图对照实验未完成',advice:'查看开发卡中的阶段报告和 Photoshop 图层。失败时图片可能已置入，不要直接重复回图；如动作未注册，请重载新版 UXP 桥。'},
    TOOL_OPEN_FAILED:{severity:'L2',level:'err',title:'工具未能打开',advice:'原有预设和工具数据仍保留。请查看具体原因，重新选择对应的工具剪影。'},
    DLSS_FAILED:{severity:'L2',level:'err',title:'DLSS 增强未完成',advice:'查看详情和任务状态。网络恢复后用“恢复传输”继续，不要重新扣费；已收到结果可再次传回，失败或取消不自动退积分。'},
    REGION_WORKBENCH_FAILED:{severity:'L2',level:'err',title:'区域处理未完成',advice:'查看失败区域和原因。已成功结果保留在本机；确认原文档后可仅重试缺少结果或再次传回。'},
    CREATIVE_DOCUMENT_INVALID:{severity:'L2',level:'err',title:'海报文档创建未完成',advice:'检查尺寸与 PPI，并核对 Photoshop 是否已有此次创建的文档，避免重复传回。'},
    REGION_CAPTURE_FAILED:{severity:'L2',level:'err',title:'区域抓取未完成',advice:'确认来源文档仍打开且尺寸未变化；恢复旧记录后请重新绑定原文档。'},
    LAYER_PROPERTIES_FAILED:{severity:'L2',level:'err',title:'图层属性未设置完成',advice:'结果图层已保留；检查原文档及对应图层编号后重试后处理，不要重复生成。'},
    PREACTION_INVALID:{severity:'L2',level:'warn',title:'预设前置动作配置无效',advice:'打开预设的前置动作，检查执行时机、工具、颜色和工具预设名称。'},
    PREACTION_BRIDGE_REQUIRED:{severity:'L2',level:'warn',title:'Photoshop 尚未连接',advice:'启动 Photoshop 并连接 UXP 联动插件，再重新选择预设。'},
    PREACTION_DOCUMENT_REQUIRED:{severity:'L2',level:'warn',title:'前置动作缺少目标图片',advice:'在 Photoshop 打开目标图片，再重新选择预设。'},
    PREACTION_DOCUMENT_CHANGED:{severity:'L2',level:'warn',title:'目标图片已经变化',advice:'确认 Photoshop 当前图片，再重新选择预设。'},
    PREACTION_EXPIRED:{severity:'L2',level:'warn',title:'前置动作等待超时',advice:'结束 Photoshop 当前操作，再重新选择预设。'},
    PREACTION_PS_BUSY:{severity:'L2',level:'warn',title:'Photoshop 正在处理其他操作',advice:'关闭 Photoshop 对话框或结束正在执行的操作，再重新选择预设。'},
    PS_BUSY:{severity:'L2',level:'warn',title:'Photoshop 正在处理其他操作',advice:'Photoshop 里开着对话框，或正在自由变换 / 输入文字。先关掉对话框或按回车结束当前操作，再试一次。'},
    // 10-25（反馈 #48 #55）：查余额的两个码原来没登记 ⇒ 卡上只写「出了点问题」
    PROVIDER_BALANCE_FAILED:{severity:'L2',level:'warn',title:'余额没查到',advice:'核对设置卡里的服务地址和 Key；余额查不到不影响出图。'},
    PROVIDER_BALANCE_RATE_LIMITED:{severity:'L1',level:'info',title:'查余额太频繁了',advice:'服务商暂时不让查（HTTP 429），过半分钟再点。不影响出图，也不是 Key 不对。'},
    // 10-25（反馈 #16）：桥接请求等回执超时 —— 原来是永远等着不报错
    BRIDGE_RESULT_TIMEOUT:{severity:'L2',level:'warn',title:'Photoshop 那边一直没回话',advice:'PS 联动插件可能断了，或者 PS 正忙。看一眼 PS 里插件面板是不是「已连接」；传回类的操作先到 PS 里看图层有没有贴进去，没有再重试。'},
    PREACTION_PS_FAILED:{severity:'L2',level:'warn',title:'Photoshop 前置动作未完成',advice:'查看详情中的具体原因和已执行项目，检查工具与颜色后重试。'},
    PREACTION_VERIFY_FAILED:{severity:'L2',level:'warn',title:'Photoshop 工具或颜色未通过核对',advice:'检查 Photoshop 当前工具、颜色模式和前背景色，再重新选择预设。'},
    GRAPHICS_PACK_MISSING:{severity:'L2',level:'warn',title:'预设需要的图形包尚未安装',advice:'在预设前置动作中安装对应的 Photoshop 工具预设包，再重试。'},
    GRAPHICS_PRESET_UNAVAILABLE:{severity:'L2',level:'warn',title:'Photoshop 形状或图案工具预设不可用',advice:'核对工具类型和预设名称，确认所需工具预设已经安装。'},
    GRAPHICS_INSTALL_CONFIRM_REQUIRED:{severity:'L2',level:'warn',title:'图形包安装尚未确认',advice:'通过预设前置动作中的安装入口选择工具预设包。'},
    GRAPHICS_PACK_ALREADY_INSTALLED:{severity:'L1',level:'warn',title:'这个图形包已经安装',advice:'先检查 Photoshop 工具预设列表，避免重复导入。'},
    GRAPHICS_PACK_INVALID:{severity:'L2',level:'warn',title:'图形包格式无效',advice:'选择 Photoshop 导出的非空 .tpl 工具预设包，大小不超过 32 MB。'},
    GRAPHICS_INSTALL_FAILED:{severity:'L2',level:'warn',title:'Photoshop 未能安装图形包',advice:'查看 Photoshop 返回的原因，确认工具预设包版本兼容。'},
    GRAPHICS_REGISTRY_INVALID:{severity:'L2',level:'warn',title:'图形包安装记录无法读取',advice:'保留现有安装记录，通过助手或人工排查，避免重复导入。'},
    GRAPHICS_REGISTRY_WRITE_FAILED:{severity:'L2',level:'warn',title:'图形包已导入，但安装记录未保存',advice:'检查插件资料目录权限和可用空间；不要重复安装同一图形包。'},
    CANVAS_FAILED:{severity:'L2',level:'err',title:'幕布操作未完成',advice:'查看详情中的原因，修正当前节点后重试。已保存的其它节点不会自动重新运行。'},
    IMAGE_SCOPES_FAILED:{severity:'L2',level:'err',title:'示波器读取未完成',advice:'确认 Photoshop 已打开文档并连接，再点击刷新；可降低采样长边后重试。'},
    CANVAS_GRAPH_INVALID:{severity:'L2',level:'err',title:'幕布数据无法读取',advice:'保留现有数据，选择其它幕布或从已保存副本恢复。'},
    CANVAS_IMAGE_INVALID:{severity:'L2',level:'warn',title:'幕布图片无法导入',advice:'使用 PNG、JPEG、WebP、GIF 或 BMP 图片，单张小于 64 MB。'},
    CANVAS_IMAGE_MISSING:{severity:'L2',level:'warn',title:'幕布素材已不存在',advice:'重新导入图片并连接到对应节点。'},
    CANVAS_SAVE_FAILED:{severity:'L2',level:'err',title:'幕布未能保存',advice:'检查本机存储空间；保存成功前不要关闭幕布。'},
    CANVAS_INPUT_REQUIRED:{severity:'L2',level:'warn',title:'节点缺少图片输入',advice:'将图片节点的输出连接到当前节点的图片输入。'},
    CANVAS_SELECTION_REQUIRED:{severity:'L2',level:'warn',title:'尚未选择上一步结果',advice:'打开上一步节点，手动选择一张结果后继续。'},
    CANVAS_CYCLE:{severity:'L2',level:'warn',title:'节点连接形成循环',advice:'断开返回上游的连接，再运行当前节点。'},
    CANVAS_BUSY:{severity:'L1',level:'warn',title:'当前节点正在运行',advice:'等待结果或停止本次等待。'},
    CANVAS_PRESET_REQUIRED:{severity:'L2',level:'warn',title:'生成节点未选择可用预设',advice:'在节点右侧选择一个预设。'},
    CANVAS_NODE_REQUIRED:{severity:'L1',level:'warn',title:'请选择要运行的节点',advice:'选择生成、拼接或输出节点。'},
    CANVAS_CLOSED:{severity:'L1',level:'warn',title:'幕布已关闭',advice:'重新打开幕布后继续操作。'},
    CANVAS_NO_RESULT:{severity:'L2',level:'err',title:'当前节点没有可用结果',advice:'查看本次生成任务的错误，修正配置后手动重试。'},
    CANVAS_BROWSER_UNAVAILABLE:{severity:'L2',level:'warn',title:'内置浏览器尚不可用',advice:'在完整桌面版本中打开幕布；当前仍可导入本机图片。'},
    ASSISTANT_OPERATION_FAILED: { severity: 'L2', level: 'warn', title: '助手本次操作未完成', advice: '查看具体原因。连接失败可更换语言模型；修改权限不足时，先在“Agent 权限与软件恢复”选择访问范围。' },
    HISTORY_OPERATION_FAILED: { severity: 'L2', level: 'warn', title: '历史操作未完成', advice: '查看原因。存储失败时检查本机空间；预设已变化时可只复用提示词。失败不会显示为已保存。' },

    // ── Photoshop startup ─────────────────────────────
    SETUP_OPERATION_FAILED: { severity: 'L2', level: 'warn', title: '本次设置未完成', advice: '查看具体原因，修正后重试。软件不会把没有通过测试的连接显示为成功。' },
    FIRST_USE_SAVE_FAILED: { severity: 'L2', level: 'err', title: '无法保存本机条款记录', advice: '检查本机可用空间与软件资料目录权限，保存成功后才能开始使用。' },
    UXP_PATH_UNSAFE: { severity: 'L2', level: 'warn', title: '桥接路径无法安全确认', advice: '目标或资源包含目录链接。请选择实际 Photoshop 安装位置，不要选择快捷方式或映射目录。' },
    UXP_PACKAGE_INVALID: { severity: 'L2', level: 'err', title: '随软件附带的桥接资源不完整', advice: '请修复软件安装包；不要用未知文件覆盖 Photoshop 插件目录。' },
    UXP_TARGET_CONFLICT: { severity: 'L2', level: 'warn', title: '桥接目标目录已有其他插件', advice: '为保护已有插件，已停止写入。检查所选 Photoshop 和桥接安装目录。' },
    UXP_PROCESS_CHECK_FAILED: { severity: 'L2', level: 'warn', title: '无法确认 Photoshop 是否已关闭', advice: '软件这次没读到电脑上正在运行的程序（可能被安全软件拦了）。先保存并关闭 Photoshop 再点一次；还不行就把修图轮椅加进杀毒软件的信任名单。' },
    UXP_PS_RUNNING: { severity: 'L2', level: 'warn', title: '请先保存并关闭 Photoshop', advice: '桥接安装或恢复需要 Photoshop 完全退出。软件不会替你强行关闭作品。' },
    // ⭐ 2026-10-20（docs/256 第 9 条）：插件比软件要求的旧（学员软件 1.9.3、插件还是 1.8.1，PS 里的操作一串报错）
    UXP_BRIDGE_OUTDATED: { severity: 'L2', level: 'warn', title: 'PS 联动插件需要更新', advice: '先保存并关掉 Photoshop，点「去重新安装」按提示装一次插件，再打开 Photoshop。不更新的话，替换、打组、抠像这些在 PS 里的操作可能出错。' },
    UXP_INSTALL_BUSY: { severity: 'L2', level: 'info', title: '桥接安装正在进行', advice: '等待当前安装或恢复结束，再继续操作。' },
    UXP_PERMISSION_REQUIRED: { severity: 'L2', level: 'warn', title: '没有写入 Photoshop 插件目录的权限', advice: '已经用管理员身份试过还是写不进去，多半是杀毒软件（360、火绒、电脑管家等）拦了。把修图轮椅加进杀毒软件的信任名单，或者先暂时关掉防护再装一次。已有插件会被保留。' },
    UXP_ELEVATION_CANCELLED: { severity: 'L2', level: 'info', title: '没有允许安装插件', advice: 'Photoshop 装在系统文件夹里，放插件要 Windows 允许一次。再点一次安装，Windows 弹窗问「是否允许此应用对你的设备进行更改」时点「是」。' },
    // ⭐ 2026-10-18 在线更新（ui-pure/app-update.js，docs/244）
    APP_UPDATE_READY: { severity: 'L2', level: 'info', title: '新版本已经下载好了', advice: '点「现在安装」：大约半分钟，装完自动重新打开，设置和预设都保留。点「稍后」的话，下次打开软件会再提醒。' },
    APP_UPDATE_REQUIRED: { severity: 'L3', level: 'warn', title: '需要更新才能继续使用', advice: '这个版本跟云端服务已经对不上，或者有必须修的问题。点「现在更新」，大约半分钟，装完自动重新打开。' },
    APP_UPDATE_MANUAL: { severity: 'L2', level: 'info', title: '有新版本（请下载安装包）', advice: '你用的是解压版，没法自动更新。到官网下载安装包装一次（设置和预设都保留），以后就能自动更新了。' },
    APP_UPDATE_FAILED: { severity: 'L2', level: 'warn', title: '更新没成功', advice: '具体原因看上面那一行。软件过一会儿会自动再试；也可以到「设置 → 关于软件」点「检查更新」。一直不行就到官网下载安装包。' },
    UXP_ELEVATION_FAILED: { severity: 'L2', level: 'warn', title: '没能用管理员身份安装插件', advice: '可能被杀毒软件拦了，或者这台电脑不允许提升权限。把修图轮椅加进杀毒软件的信任名单后重试；还不行就右键 wheelchair-v7.exe 选「以管理员身份运行」再装一次。' },
    UXP_INSTALL_FAILED: { severity: 'L2', level: 'err', title: '桥接安装未完成', advice: '检查磁盘空间与目录权限后重试；已存在的桥接会尝试自动恢复。' },
    UXP_RECOVERY_REQUIRED: { severity: 'L3', level: 'err', title: '桥接自动恢复未完成', advice: '暂勿启动 Photoshop。原桥接备份仍在所选安装目录的 Wheelchair-V7-Bridge-Backups 中，请联系维护人员恢复。' },
    UXP_BACKUP_NOT_FOUND: { severity: 'L2', level: 'warn', title: '找不到该桥接恢复节点', advice: '该节点可能已恢复或移动，请重新检测安装状态。' },
    UXP_INSTALL_CHANGED: { severity: 'L2', level: 'warn', title: '桥接文件在安装后发生了变化', advice: '为保留后续修改，已停止覆盖恢复。先备份当前桥接文件，再决定恢复方式。' },
    UXP_ROLLBACK_FAILED: { severity: 'L2', level: 'err', title: '桥接恢复未完成', advice: '检查可用空间、目录权限以及恢复节点；不要删除安装目录旁保留的桥接备份。' },
    PHOTOSHOP_PATH_INVALID: { severity: 'L2', level: 'warn', title: 'Photoshop 程序位置无效', advice: '重新检测版本，或选择安装目录中的 Photoshop.exe。' },
    PHOTOSHOP_NOT_FOUND: { severity: 'L2', level: 'warn', title: '找不到所选 Photoshop 程序', advice: '程序可能已移动或卸载；重新检测并选择版本。' },
    PHOTOSHOP_SELECTION_REQUIRED: { severity: 'L2', level: 'warn', title: '请先选择 Photoshop 版本', advice: '先检测本机 Photoshop，再从检测结果选择要启动的版本。' },
    PHOTOSHOP_SELECTION_FAILED: { severity: 'L2', level: 'err', title: '无法保存 Photoshop 版本选择', advice: '请重新打开软件后再检测。' },
    PHOTOSHOP_CALLER_DENIED: { severity: 'L2', level: 'warn', title: '当前页面不能启动 Photoshop', advice: '请从软件主窗口的首次引导或设置页操作。' },
    PHOTOSHOP_LAUNCH_FAILED: { severity: 'L2', level: 'err', title: 'Photoshop 启动失败', advice: '查看系统返回的原因，并确认 Photoshop 能否直接从电脑中打开。' },

    // ── Photoshop 侧：抓取 ──────────────────────────────
    NO_DOCUMENT: {
      severity: 'L2', level: 'warn', title: 'Photoshop 里没有打开的图',
      advice: '先在 Photoshop 里打开一张图，再回来点生成。'
    },
    // 10-25（docs/286 P0-4）：没框选区是正常提示，不算错误 —— level 改 info（遥测不再当错误统计，原来 7 天 873 次占满错误榜）；卡照样弹
    NO_SELECTION: {
      severity: 'L2', level: 'info', title: '先在 Photoshop 里框一块',
      advice: '用矩形选框工具（快捷键 M）在图上框住要改的地方，再点生成。想直接用整张图，去设置里打开「无选区时使用整张画布」。'
    },
    SELECTION_DETECTION_FAILED: {
      severity: 'L2', level: 'err', title: '读不出选区',
      advice: '三种检测方式都失败了。如果文档是 16 位或 32 位的，去 图像 → 模式 → 8位/通道 转一下再试。'
    },
    SELECTION_CAPTURE_FAILED: {
      severity: 'L2', level: 'err', title: '抓取选区时出错',
      advice: '详情里是 Photoshop 给的原始报错。如果反复出现，换一张图或重启 Photoshop 试试。'
    },
    CAPTURE_FAILED: {
      severity: 'L2', level: 'err', title: '抓取选区时出错',
      advice: '详情里是 Photoshop 给的原始报错。'
    },
    NO_SELECTION_HISTORY: {
      severity: 'L2', level: 'warn', title: '没有可以恢复的选区记录',
      advice: '这个功能要先抓取过一次才能用。'
    },

    // ── Photoshop 侧：桥接传输 ──────────────────────────
    // ⚠ 这三条是 2026-09-11 那场排查的直接产物，别删。
    BRIDGE_PAYLOAD_TOO_LARGE: {
      severity: 'L2', level: 'err', title: '图太大，没能传回来',
      advice: '把选区缩小一点再抓。详情里有这次实际多大、上限是多少。'
    },
    BRIDGE_RESULT_POST_FAILED: {
      severity: 'L2', level: 'err', title: 'Photoshop 的结果没传回来',
      advice: '图已经抓到了，但从 Photoshop 送回桌面板这一步失败了。详情里是真实原因。'
    },
    BRIDGE_UNAVAILABLE: {
      severity: 'L2', level: 'err', title: '连不上 Photoshop 插件',
      advice: '确认 Photoshop 开着，并且「V7 链路验证桥」面板是打开的(窗口 → 扩展功能)。'
    },
    BRIDGE_DISCONNECTED: {
      severity: 'L2', level: 'warn', title: 'Photoshop 插件断开了',
      advice: '去 Photoshop 里看一眼那个桥面板还在不在。它重连上会自己恢复，不用重启桌面板。'
    },
    BRIDGE_RECONNECTED: {
      // 好消息也要说一声，否则用户不知道能不能接着干活了。
      severity: 'L1', level: 'ok', title: 'Photoshop 插件已重新连上', advice: ''
    },
    BRIDGE_DISCONNECTED_BUSY: {
      // ⚠ L3：正在跑任务时断连，必须让用户决定等还是放弃，不能替他做主。
      severity: 'L3', level: 'err', title: 'Photoshop 插件断开了，但任务还在跑',
      advice: '选「继续等」会等它自己重连；选「放弃任务」会把当前任务标记为失败。'
    },
    UXP_ACTION_FAILED: {
      severity: 'L2', level: 'err', title: 'Photoshop 操作失败',
      advice: '详情里是 Photoshop 给的原始报错。'
    },
    UNKNOWN_ACTION: {
      severity: 'L2', level: 'err', title: 'Photoshop 插件不认识这个操作',
      advice: '多半是桌面板和 Photoshop 插件版本对不上，重装一次插件。'
    },

    // ── Photoshop 侧：传回 ──────────────────────────────
    SOURCE_DOCUMENT_CLOSED: {
      // ⚠ L3：文档被关了是用户自己的操作，贴到别的文档上是有后果的，必须问。
      severity: 'L3', level: 'warn', title: '原来那张图已经关掉了',
      advice: '图生成好了，但当初抓取的那个文档不在了。可以贴到当前打开的图上，也可以先不贴、之后再说。'
    },
    SOURCE_SNAPSHOT_MISSING: {
      severity: 'L2', level: 'warn', title: '这个任务没有记录来源',
      advice: '找不到当初是从哪张图、哪个选区抓的，所以没法自动贴回去。可以手动保存图片。'
    },
    NO_IMAGE: { severity: 'L2', level: 'warn', title: '没有可以贴回去的图', advice: '' },
    NO_IMAGES: { severity: 'L2', level: 'warn', title: '没有可以贴回去的图', advice: '' },
    NO_LAYER: { severity: 'L2', level: 'warn', title: '找不到目标图层', advice: '' },
    NO_LAYER_ID: { severity: 'L2', level: 'warn', title: '缺少图层编号', advice: '' },
    NO_LAYER_IDS: { severity: 'L2', level: 'warn', title: '没有选中要编组的图层', advice: '' },
    NO_CHANNEL: { severity: 'L2', level: 'warn', title: '找不到目标通道', advice: '' },
    NO_EXPORT_PATH: { severity: 'L2', level: 'warn', title: '没有指定保存位置', advice: '' },
    CHECKPOINT_PATH_INVALID: { severity: 'L2', level: 'warn', title: '检查点保存位置不可用', advice: '检查缓存目录是否可写。检查点未保存成功，本次生成会继续。' },
    CHECKPOINT_PATH_MUST_BE_PNG: { severity: 'L2', level: 'err', title: '检查点保存格式不正确', advice: '检查点必须保存为 PNG；请更新桌面软件和 Photoshop 桥。' },
    CHECKPOINT_PNG_UNSUPPORTED: { severity: 'L2', level: 'warn', title: '当前 Photoshop 无法保存无压缩 PNG 检查点', advice: '检查 Photoshop 版本及桥版本。软件不会用有损图片替代检查点。' },
    CHECKPOINT_TIMEOUT: { severity: 'L2', level: 'warn', title: '检查点保存等待超时', advice: '检查 Photoshop 是否有未关闭的弹窗或正在执行其他操作。下一次生成会重试。' },
    CHECKPOINT_CACHE_UNAVAILABLE: { severity: 'L2', level: 'err', title: '检查点缓存接口不可用', advice: '请重新打开桌面软件。' },
    CHECKPOINT_STORE_UNAVAILABLE: { severity: 'L2', level: 'err', title: '检查点记录模块不可用', advice: '请重新打开桌面软件。' },
    CHECKPOINT_CACHE_FAILED: { severity: 'L2', level: 'warn', title: '检查点缓存写入失败', advice: '检查缓存所在磁盘的空间和写入权限。下一次生成会重试。' },
    CHECKPOINT_INDEX_FAILED: { severity: 'L2', level: 'warn', title: '检查点记录读写未完成', advice: '请检查本地存储空间及详情；已存在的 PNG 保留在检查点缓存目录中。' },
    CHECKPOINT_DOCUMENT_REQUIRED: { severity: 'L2', level: 'warn', title: '检查点没有找到 Photoshop 来源文档', advice: '重新从 Photoshop 抓取后生成。' },
    CHECKPOINT_EXPORT_INVALID: { severity: 'L2', level: 'warn', title: '无法确认检查点保存成功', advice: '检查 Photoshop 桥和缓存目录。软件不会把空文件记为检查点。' },
    CHECKPOINT_EXPORT_FAILED: { severity: 'L2', level: 'warn', title: '检查点保存失败', advice: '详情里是 Photoshop 返回的原因；下一次生成会重试。' },
    CHECKPOINT_FOLDER_FAILED: { severity: 'L2', level: 'warn', title: '检查点文件夹无法打开', advice: '缓存可能已移动或清理；详情里有系统返回的原因。' },
    CHECKPOINT_ACCOUNT_CHANGED: { severity: 'L2', level: 'warn', title: '检查点操作时账号发生了切换', advice: '本次操作已停止；已写入的图片保留在原账号目录。请在当前账号重新检查缓存和检查点。' },
    EXPORT_FORMAT_UNSUPPORTED: { severity: 'L2', level: 'warn', title: '不支持这个导出格式', advice: '请使用 PNG、JPG、PSD、PSB、BMP 或 GIF 文件名后缀。' },
    EXPORT_PATH_UNAVAILABLE: { severity: 'L2', level: 'warn', title: '无法创建导出文件', advice: '确认导出目录存在且可以写入。' },
    INVALID_DOC_ID: { severity: 'L2', level: 'err', title: '文档编号无效', advice: '' },
    INVALID_MODE: { severity: 'L2', level: 'err', title: '图层联动参数不对', advice: '' },
    INVALID_SOLO_LAYER: { severity: 'L2', level: 'err', title: '要单独显示的图层不在这一组里', advice: '' },
    UNSUPPORTED_LAYER_ACTION: { severity: 'L2', level: 'err', title: '不支持的图层操作', advice: '' },
    UNSUPPORTED_SELECTION_OPERATION: { severity: 'L2', level: 'err', title: '不支持的选区操作', advice: '' },

    // ── 生成：参数 ──────────────────────────────────────
    AI_URL_MISSING: {
      severity: 'L2', level: 'warn', title: '还没配生图服务',
      advice: '到设置卡「用哪家生图」选好服务商、填上地址和 API Key，再点「检查连接」。'
    },
    AI_PROMPT_MISSING: {
      severity: 'L1', level: 'warn', title: '还没写提示词',
      advice: ''
    },
    AI_BRIDGE_UNAVAILABLE: {
      severity: 'L2', level: 'err', title: '生成接口没接上',
      advice: '桌面板内部接线出问题了，重启一次桌面板。'
    },
    WORKFLOW_SERVICE_UNCONFIGURED: { severity:'L2', level:'warn', title:'平台工作流服务尚未配置', advice:'联系管理员配置计算服务；自己的本地 ComfyUI 可在设置中另选算力来源。' },
    WORKFLOW_PRESET_UNAVAILABLE: { severity:'L2', level:'warn', title:'此预设还没有可运行的官方工作流', advice:'选择已验证预设，或等待工作流目录发布。此次未配置检查发生在扣费前。' },
    WORKFLOW_REVIEW_REQUIRED: { severity:'L2', level:'warn', title:'Forge 迁移工作流仍需验证', advice:'保留导入预设，完成对应 ComfyUI 工作流映射和效果验收后再使用。' },
    WORKFLOW_MAPPING_REQUIRED: { severity:'L2', level:'warn', title:'工作流缺少输入或最终结果映射', advice:'为 Photoshop 输入图、提示词和最终图片出口指定节点后重试。' },
    WORKFLOW_BATCH_UNSUPPORTED: { severity:'L2', level:'warn', title:'工作流未配置多张生成', advice:'将张数设为 1，或由工作流作者增加张数映射。' },
    WORKFLOW_API_PROMPT_REQUIRED: { severity:'L2', level:'warn', title:'需要 ComfyUI API 格式工作流', advice:'在 ComfyUI 导出 API 格式后再关联到预设。' },
    WORKFLOW_SOURCE_REQUIRED: { severity:'L2', level:'warn', title:'请选择工作流算力来源', advice:'在设置中选择自己的本地服务、自有 Key 或平台积分。' },
    WORKFLOW_HTTP_ERROR: { severity:'L2', level:'err', title:'工作流服务连接失败', advice:'检查当前算力来源、地址与 Key，查看任务详情后再重试。' },
    WORKFLOW_EXECUTION_FAILED: { severity:'L2', level:'err', title:'工作流没有执行完成', advice:'查看节点报错或联系算力提供方；平台已提交任务不会自动退款。' },
    QUOTE_DECLINED: { severity:'L1', level:'info', title:'已取消本次生成', advice:'本次报价未确认，不会创建平台扣费任务。' },
    QUOTE_CHANGED: { severity:'L2', level:'warn', title:'报价已更新，本次未扣费', advice:'重新查看报价，确认后再提交。' },
    BILLING_RULE_UNCONFIGURED: { severity:'L2', level:'warn', title:'平台尚未配置计费规则', advice:'请联系管理员配置真实计价依据，本次未扣费。' },
    PLATFORM_IMAGE_SERVICE_UNCONFIGURED: { severity:'L2', level:'warn', title:'官方 Banana 服务尚未配置', advice:'本次未扣费。可在图像 API 算力来源中选择自己的服务，或等待平台开放。' },
    // ⭐ 2026-10-02 GRS 通道（夏算力）托管 / 自带。用户要求：这几种失败【弹错误卡】。
    //   对应后端 /v1/compute/key 返回的 keyStatus（见 ui.html aiAttachGrsKey）。
    COMPUTE_NO_BALANCE: { severity:'L2', level:'warn', title:'GRS 托管余额用完了', advice:'本次没有发出请求。兑换卡密充值后再生成；或在设置 → 连接里把 GRS 用法改成「自带 GRS Key」。' },
    COMPUTE_PAUSED: { severity:'L2', level:'warn', title:'GRS 托管被暂停了', advice:'通常是今天用量到上限，第二天 0 点自动恢复；详情里有暂停原因和恢复时间。急用可以改成「自带 GRS Key」。' },
    COMPUTE_CREATE_FAILED: { severity:'L2', level:'err', title:'专属 Key 额度尚未确认', advice:'本次生成未提交，已兑换的积分记录保留。请联系夏三七核对处理。' },
    COMPUTE_ALLOCATION_PENDING: { severity:'L1', level:'info', title:'新增额度需要核对', advice:'请联系夏三七处理。原 Key 的可用额度仍可继续使用。' },
    COMPUTE_KEY_FAILED: { severity:'L2', level:'err', title:'拿不到 GRS 托管 key', advice:'本次没有发出请求。检查网络和账号登录状态后重试；一直不行就联系客服。' },
    COMPUTE_LOGIN_REQUIRED: { severity:'L2', level:'warn', title:'GRS 托管要先登录', advice:'在设置 → 连接与账号里登录；不想登录的话，把 GRS 用法改成「自带 GRS Key」并填上自己的 Key。' },
    COMPUTE_BYOK_KEY_REQUIRED: { severity:'L2', level:'warn', title:'还没填自己的 GRS Key', advice:'在设置 → 连接里填上 GRS Key；或者把 GRS 用法改成「夏三七托管」，登录后就能用，不用填 Key。' },
    COMPUTE_LOW_BALANCE: { severity:'L1', level:'info', title:'GRS 托管余额快用完了', advice:'这次照常生成。记得找夏三七充值。' },
    RH_KEY_REQUIRED: { severity:'L2', level:'warn', title:'需要自己的 RH Key', advice:'在连接设置中填写 RH 服务与 Key，然后测试连接。' },
    RH_UPLOAD_FAILED: { severity:'L2', level:'err', title:'RH 输入图上传失败', advice:'检查 Key、服务状态和图片大小，确认上游任务记录后重试。' },
    WORKFLOW_RESPONSE_INVALID: { severity:'L2', level:'err', title:'工作流服务返回格式不正确', advice:'检查服务地址是否为接口地址，并查看接口错误详情。' },
    SECRET_STORE_UNAVAILABLE: { severity:'L2', level:'warn', title:'本机安全存储不可用', advice:'当前 Key 只保留在本次会话；不会写入普通设置文件。检查系统凭据服务后重试。' },
    BACKUP_QUOTA_EXCEEDED: { severity:'L2', level:'warn', title:'云备份已超出账号额度', advice:'已暂停自动上传；减少基础预设内容后手动重新上传。旧云备份仍然保留。' },
    BACKUP_ACCOUNT_CHANGED: { severity:'L1', level:'info', title:'账号已变化，操作已停止', advice:'请在当前账号重新打开云备份页面。' },
    CLOUD_BACKUP_FAILED: { severity:'L2', level:'warn', title:'云备份操作未完成', advice:'请在设置 → 连接与账号 → 账号云备份查看详情；检查网络和本机存储后手动重试。未完成的操作不会显示为成功。' },
    WORKER_AUTH_REQUIRED: { severity:'L2', level:'err', title:'计算服务身份校验失败', advice:'联系管理员检查计算服务配置；软件不能自行声明官方生成成功。' },
    PLATFORM_LOGIN_REQUIRED: {
      severity: 'L2', level: 'warn', title: '平台算力需要先登录',
      advice: '先在设置里的「连接与账号」登录 V7 账号；自己的第三方 API 可以选择其他服务商。'
    },
    // ⭐ 2026-10-16（用户：「你现在看一下我们的报错，就有些报错我觉得实在不应该啊」）：
    //   云端工作流 / 千问的这些码原来【一条都没登记】⇒ 报错栏只写「出了点问题」，看不出要不要管。
    //   后台的限流拒绝都在扣分之前 ⇒ 每条都写明「没扣分」；会自动等的写明「不用管」。
    WORKFLOW_LIMIT_CONCURRENT: { severity: 'L2', level: 'warn', title: '上一张还在算',
      advice: '开源模型会自动排队等，不用管，没扣分。一直这样的话：可能同一个账号在别的电脑上也在跑，或者服务器那张还没收尾（最多 15 分钟自动放开）。' },
    WORKFLOW_LIMIT_COOLDOWN: { severity: 'L2', level: 'warn', title: '提交太快了',
      advice: '两次提交要隔 3 秒，软件会自动隔开再交，不用重点，没扣分。' },
    WORKFLOW_LIMIT_QUEUE: { severity: 'L2', level: 'warn', title: '云端现在人多',
      advice: '软件会自动等一会儿再交，没扣分。' },
    WORKFLOW_LIMIT_LOW_TIER_RATE: { severity: 'L2', level: 'warn', title: '1K 限速：普通账号每分钟 1 张',
      advice: '软件按服务器说的秒数自动等再交，没扣分。学员不限速。' },
    WORKFLOW_LIMIT_BATCH: { severity: 'L2', level: 'warn', title: '一次选的张数超了',
      advice: '普通账号一次 1 张、学员 4 张（管理员不限）。少选几张，或者连着点生成，会排队一张张出。没扣分。' },
    WORKFLOW_LIMIT_BATCH_FULL: { severity: 'L2', level: 'warn', title: '这一组已经发完了',
      advice: '重新点一次生成就行，没扣分。' },
    WORKFLOW_LIMIT_HIGH_TIER: { severity: 'L2', level: 'warn', title: '2K 额度不够了',
      advice: '改用 1K（1K 不占这个额度），或者少选几张。没扣分。' },
    WORKFLOW_LIMIT_DAILY: { severity: 'L2', level: 'warn', title: '今天全站的额度用完了',
      advice: '明天零点重置，没扣分。' },
    WORKFLOW_LIMIT_POINTS: { severity: 'L2', level: 'warn', title: '积分不到 1000，云端开源模型暂时用不了',
      advice: '这个门槛只看不扣。充值或兑换卡密后再试。' },
    WORKFLOW_WORKER_UNAVAILABLE: { severity: 'L2', level: 'warn', title: '云端暂时不可用（没扣分）',
      advice: '云端算力机器不在线（重启或维护中）。过一会儿再点生成；本次没扣分。' },
    WORKFLOW_PLATFORM_ONLY: { severity: 'L2', level: 'warn', title: '这条预设只能用云端跑',
      advice: '生成卡算力那一格选「平台工作流」（或者设置 → 工作流算力来源 → 平台云算力）。' },
    QWEN_ENGINE_MISSING: { severity: 'L2', level: 'err', title: '开源模型模式的工作流没装上',
      advice: '重新安装软件；急用的话先关掉开源模型模式，用原来的通道。' },
    QWEN_TOO_MANY_REFERENCES: { severity: 'L2', level: 'warn', title: '参考图太多了',
      advice: '开源模型模式最多主图 + 5 张参考图，删掉几张再生成。' },
    // ⭐ 2026-10-18 云端外挂（docs/237）。正文由 cloud-tools.js 写【到底是谁的问题】（你没网 / 云端机器挂了 / 没登录 / 被停用），
    //   这里只给标题和下一步。用户：「云端连不上的时候，就直接降级，要提醒用户，实话实说」
    CLOUD_TOOLS_FALLBACK: { severity: 'L2', level: 'warn', title: '云端外挂连不上，先用本机引擎',
      advice: '接下来 2 分钟用这台电脑的本机引擎（慢一些，第一次要等它加载）；之后会自动再试云端。外挂能力卡左上角能看云端状态、点「重新检测」。' },
    CLOUD_TOOLS_UNAVAILABLE: { severity: 'L2', level: 'warn', title: '云端外挂现在用不了',
      advice: '按上面说的原因处理：没网就先连网；没登录就先登录；云端机器在维护就过几分钟再试。外挂能力卡左上角能看云端状态、点「重新检测」。' },
    CLOUD_TOOLS_BUSY: { severity: 'L2', level: 'warn', title: '云端外挂排队满了',
      advice: '现在用的人太多，等一两分钟再点；别连着点，每次都会重新排队。' },
    INSUFFICIENT_POINTS: { severity: 'L2', level: 'warn', title: '积分不够',
      advice: '充值或兑换卡密后再试；本次没扣分。' },
    BACKEND_URL_INVALID: {
      severity: 'L2', level: 'warn', title: 'V7 后端地址不可用',
      advice: '检查地址是否以 http:// 或 https:// 开头，并确认本机或内网穿透服务正在运行。'
    },
    // ⭐ 2026-10-09（docs/195 §1）：后端默认地址线上化之后的配套。
    //   ⚠ 跟 BACKEND_URL_INVALID 的分工：
    //     · URL_INVALID  = 地址【写错了】（格式不对 / 打错字）—— 不会自动恢复
    //     · 本条          = 地址没错，但【连不上】（服务器挂了 / 没网 / 被墙）—— 会自己恢复
    //   ⇒ 两条不能合并：合并以后用户不知道该改地址还是该等。
    BACKEND_UNREACHABLE: {
      severity: 'L2', level: 'warn', title: '连不上 V7 服务器',
      advice: '账号、积分、平台算力（香蕉）都用不了；但本机生成、修图、抠像、调色不受影响，可以照常用。'
        + '\n可能是：① 你的网络断了 ② 我们服务器在维护 ③ 杀毒软件拦了。'
        + '\n稍等一会儿点上面的「重试」；一直不行就把这句话截图给开发。'
    },
    // ⭐ 2026-10-15（用户定）：启动时拉公告兼做「服务器连得上吗」的检查。
    //   用户原话：「如果没联网就报一个失败，让用户知道他现在没有办法连接上服务器」。
    //   ⚠ 跟 BACKEND_UNREACHABLE 分开登记：这张卡钉在报错堆最顶、详情里有「重试」按钮，
    //     而且只在启动 / 点重试时出现 —— 文案要说清"是启动检查发现的"。
    ANNOUNCE_FETCH_FAILED: {
      severity: 'L2', level: 'warn', title: '连不上 V7 服务器',
      advice: '启动检查没连上服务器，所以也没拿到平台公告。'
        + '\n现在用不了：账号登录、积分、平台算力（香蕉）。不受影响：本机生成、修图、抠像、调色。'
        + '\n可能是：① 网络断了 ② 服务器在维护 ③ 杀毒软件 / 代理拦了。'
        + '\n点「重试」再连一次；一直不行就把这张卡截图发给客服。'
    },
    BACKEND_ACCOUNT_FAILED: {
      severity: 'L2', level: 'err', title: '账号连接失败',
      advice: '详情里有后端返回的原因；确认邮箱、密码和后端地址后再试。'
    },
    // ⚠⚠ 2026-10-10 对抗审查补（用户要求「找到各种人为操作的 bug/问题/漏洞/边界/降级」）：
    //   实测发现：账号相关的失败【全被塞进 BACKEND_ACCOUNT_FAILED 一个码】，
    //   于是"验证码没取到""卡密打错一位""被限流""断网"在用户眼里长得一模一样
    //   —— 都是"账号连接失败"，谁也不知道下一步该干什么。
    //   ⇒ 按真实原因拆开登记，每条都给【用户能照着做】的一句话。
    //   ⚠ 这些码是后端（server.py / captcha.py / db.py）真的会返回的 code，
    //     不是我编的 —— 客户端只是把它们翻成人话。
    CAPTCHA_NOT_READY: {
      severity: 'L1', level: 'warn', title: '验证码还没取到',
      advice: '点一下验证码那张图，等图上出现字符再填。取不到通常是网络慢或断网。'
    },
    // ⚠ 2026-10-10：这三个是【客户端】拦下来的"根本没填"，不是后端错误。
    //   为什么要单独登记：不分的话全落到 LOGIN_FAILED「邮箱或密码不对」，
    //   用户会去怀疑密码 —— 而他只是没填。方向错的提示比没提示更坏。
    ACCOUNT_EMAIL_EMPTY: {
      severity: 'L1', level: 'warn', title: '还没填邮箱',
      advice: '填你注册时用的那个邮箱。'
    },
    ACCOUNT_PASSWORD_EMPTY: {
      severity: 'L1', level: 'warn', title: '还没填密码',
      advice: '填密码。注意大小写；忘了就用「找回密码」。'
    },
    ACCOUNT_CAPTCHA_EMPTY: {
      severity: 'L1', level: 'warn', title: '还没填验证码',
      advice: '照着验证码图上那几位填进去（不分大小写）。看不清就点一下图换一张。'
    },
    CAPTCHA_INVALID: {
      severity: 'L1', level: 'warn', title: '验证码不对或已过期',
      advice: '验证码是一次性的：用掉就作废（填错也算用掉）。点一下图换一张，重新填。'
    },
    LOGIN_FAILED: {
      severity: 'L2', level: 'err', title: '邮箱或密码不对',
      advice: '先确认密码（注意大小写）。同一个邮箱连续错多次会被临时锁一会儿，'
        + '那时候要等，不是密码错了。忘了密码用「找回密码」。'
    },
    AUTH_RATE_LIMITED: {
      severity: 'L2', level: 'warn', title: '操作太频繁，被暂时拦住了',
      advice: '等一会儿再试。这是防别人暴力猜你密码的，不是你的账号有问题。'
    },
    CARD_NOT_FOUND: {
      severity: 'L1', level: 'warn', title: '卡密不对',
      advice: '逐位核对。卡密里【没有】0 O 1 I L 这几个容易看错的字符；'
        + '带不带横杠都能识别。确认没输错再试。'
        + '\n如果你确定卡密是对的，可能是这张卡已作废或已过期 —— 找客服查。'
    },
    CARD_ALREADY_REDEEMED: {
      severity: 'L1', level: 'warn', title: '这张卡密已经用过了',
      advice: '同一张卡只能兑换一次。到「积分流水」看有没有这笔充值记录。'
        + '\n如果流水里没有、但这里说用过了，找客服（把卡密发过去）。'
    },
    BACKEND_REQUEST_FAILED: {
      severity: 'L2', level: 'err', title: '请求没发出去',
      advice: '多半是网络断了或服务器暂时不可用。等几秒重试；'
        + '本机功能（生成/修图/抠像/调色）不受影响，可以照常用。'
    },
    NETWORK_OFFLINE: {
      severity: 'L1', level: 'warn', title: '现在没有网络',
      advice: '恢复网络后重试。本机功能不受影响。'
    },
    ACCOUNT_CENTER_FAILED: {
      severity: 'L2', level: 'err', title: '账号服务操作未完成',
      advice: '检查账号和服务连接后刷新；兑换无回执时先检查账单，不要更换卡密反复提交。'
    },
    COLOR_TOOL_FAILED: {
      severity: 'L2', level: 'err', title: '调色操作未完成',
      advice: '检查工作面中的原图与结果记录。传回无回执时先核对 Photoshop 图层；已有图层仅重试属性设置，避免重复置入。'
    },
    BATCH_QUEUE_FAILED: {
      severity: 'L2', level: 'err', title: '批处理操作未完成',
      advice: '查看条目原因和原任务历史。未执行项目仍保留；图片缺失需重新抓取，重试前先核对已有结果与费用。'
    },
    PROVIDER_CATALOG_INVALID: {
      severity: 'L2', level: 'err', title: '服务商推荐未能完成',
      advice: '检查后台地址并刷新推荐信息。确认地址后再填写对应 Key；未公布价格请向服务商确认。'
    },
    PROVIDER_TEST_FAILED: {
      severity: 'L2', level: 'err', title: '服务商连接测试失败',
      advice: '不要把失败当成已配置成功。检查地址、Key 和模型服务状态后选择其他服务商再测试。'
    },

    // ── 生成：网络 ⭐ 2026-09-11 重点改造 ──────────────
    // 这两条是靠联网探测【区分】出来的，不是猜的。判别方法见 probeEndpoint()。
    AI_NETWORK_UNREACHABLE: {
      severity: 'L2', level: 'err', title: '连不上 AI 服务器',
      advice: '请求根本没发出去。检查网络；如果开着 Clash 之类的代理，确认它没把这个地址拦掉。详情里有探测结果。'
    },
    AI_CORS_BLOCKED: {
      severity: 'L2', level: 'err', title: '服务器连得上，但响应被拦下了',
      advice: '请求送到服务器了(积分可能已经扣)，是回来的响应被界面的跨域规则挡住。这是桌面板自身的架构问题，不是你操作错了——把这条报给开发。'
    },
    AI_HTTP_ERROR: {
      severity: 'L2', level: 'err', title: 'AI 服务器拒绝了这次请求',
      advice: '详情里是服务器的原话。常见：401 Key 不对 / 402·403 余额不足 / 413 图片太大 / 429 太频繁 / 400 参数或提示词有问题 / 502·503·504 服务商那边出图超时或暂时不可用（不是你的问题，稍后再试或换模型 / 换渠道）。'
    },
    // ⭐ 2026-10-21（用户：「HTTP 504 … 何意为」）：502/503/504 = 服务商把请求转给上游出图，上游没按时回 —— 跟用户的操作、网络都没关系。
    //   ⚠ 请求已经送到服务商了，所以软件不会自动重试（重试可能重复扣钱）；这一单可能已计费，要查就拿详情里的 request id 问服务商。
    AI_MODEL_NO_CHANNEL: {
      severity: 'L2', level: 'err', title: '服务商那边这个模型暂时没有可用通道',
      advice: '不是你的设置问题，也不是网络问题：服务商（中转站）那边这个模型现在没有能用的线路，等多久都一样。换一个模型或换个渠道再出图；想继续用这个模型，把详情里的 request id 发给服务商客服问一下。这一单一般不会计费。'
    },
    AI_UPSTREAM_TIMEOUT: {
      severity: 'L2', level: 'err', title: '服务商那边出图超时',
      advice: '不是你的问题，也不是网络问题：服务商把这单转给上游出图，上游没按时做出来。稍等一会儿再试，或者换个模型 / 换个渠道。请求已经送到服务商，所以软件没有自动重试（重试可能重复扣钱）；这一单可能已经计费 —— 要查的话，把详情里的 request id 发给服务商客服。'
    },
    // ⭐ 413 单独拎出来：这是"图片太大"的标准答复，也是 V6 时代就踩过的坑。
    //   把它和一般 HTTP 错误分开，用户一眼就知道该缩图而不是去查 Key。
    AI_IMAGE_TOO_LARGE: {
      severity: 'L2', level: 'err', title: '图太大，AI 服务器不收',
      advice: '把选区缩小，或者在设置里把最大分辨率调低一档再试。详情里有这次发出去多大、服务器怎么说的。'
    },
    AI_NO_IMAGE_RETURNED: {
      severity: 'L2', level: 'err', title: 'AI 没有返回图片',
      advice: '请求成功了但里面没有图。多半是提示词被判定为违规，或者模型名填错了。'
    },
    AI_REQUEST_FAILED: {
      severity: 'L2', level: 'err', title: '这次生成请求失败了',
      advice: '详情里是原始报错。'
    },

    // ── 生成：任务 ──────────────────────────────────────
    AI_CANCELLED: { severity: 'L1', level: 'info', title: '任务已取消', advice: '' },
    AI_TASK_FAILED: {
      severity: 'L2', level: 'err', title: '生成任务失败了',
      advice: '详情里有失败发生在哪一步。'
    },
    AI_PARTIAL_FAILED: {
      // ⚠ L1：一批里挂了几张但还有成功的，不值得打断人。
      severity: 'L1', level: 'warn', title: '', advice: ''
    },
    // ⚠ L1：这不是报错，是"我替你降级了"的知会。零打断、自动消失。
    //   用 L2 的话每批都弹一张卡会很烦；但完全不说就是静默失效 ——
    //   用户选的可能是「精准」或「混合」，实际跑的是「全局」——
//   它俩不是一回事（全局不看位置），所以必须说清换了哪一种。L1 正好。
    ASPECT_MISMATCH: {
      severity: 'L1', level: 'warn', title: '选区比例和生图比例对不上',
      // ⭐⭐⭐ 2026-10-08（docs/170 §4.8 · E11）：这句原来【说假话】——
    //   它说「降级成整体校色」，而引擎当时是【直接跳过校色】。
    //   现在比例不符时前端把 method 换成 'global'（拍板点 4-B），说的是真的了。
    advice: '已自动跳过对齐、改用全局校色（精准和混合都靠位置，比例对不上就用不了）。想用它们就把「宽高比」改成 Auto。'
    },
    // ── 细节补偿档位（2026-09-12）────────────────────────
    // ⚠ 这三条都是【用户主动点了按钮】才可能出现的。
    //   主动动作失败必须有回音 —— 点了没反应是本项目最忌讳的故障形态。
    DETAIL_NO_SOURCE: {
      severity: 'L2', level: 'warn', title: '这张图补不了细节',
      advice: '补细节要拿"当初递交给 AI 的那张原图"当原料，这个任务里没有留下它。重新生成一次就有了。'
    },
    DETAIL_NO_TARGET: {
      severity: 'L2', level: 'warn', title: '不知道要嵌到哪一层上',
      advice: '先把这一批传回 Photoshop（补好的图是盖在那张 AI 图上方的，得先有那张图）。'
    },
    DETAIL_FAILED: {
      severity: 'L2', level: 'error', title: '补细节没成功',
      advice: '确认加速引擎在线、那张 AI 图还在 Photoshop 里没被删掉，然后再点一次。原来的图没有被改动。'
    },
    ENGINE_OFFLINE: {
      // ⭐ 2026-10-06 晚：L3 → L2。有动作按钮本身不是升级 L3 的理由（这条注释
      //   本来就是这么写的，只是代码没跟上）。L3 会走 V7FocusScope.registerConfirmation
      //   → isOpen() 恒真 → v7OverlayOpen() 恒真 → 全局 mousemove 一进门就 return，
      //   任务卡/主卡所有右滑手势全部停摆（用户实测"弹了报错卡之后右滑就不正常"）。
      //   引擎离线是"后台状态 + 一个动作按钮"，不该是模态决定；按钮仍在
      //   （cancel/onCancel 由 report 的 L2 分支透传，卡片默认摊开详情），只是不再冻结界面。
      severity: 'L2', level: 'warn', title: '校色加速引擎没在运行',
      advice: '点「立刻启动」就能开起来（需要装过 Python 依赖）。不启动也能用，只是走本机算法，修不了局部形变。'
    },
    ENGINE_OFFLINE_BACKGROUND: {
      // 后台探活只负责告知状态，不能把普通页面变成必须先决定的 L3。
      // 用户主动点“补细节”时仍使用上面的 ENGINE_OFFLINE/L3。
      severity: 'L2', level: 'warn', title: '校色加速引擎暂时没在运行',
      advice: '可以继续使用其他功能；需要局部形变修复时，进入设置中的引擎页面启动它。'
    },
    ENGINE_STARTED: {
      severity: 'L1', level: 'ok', title: '加速引擎已启动', advice: ''
    },
    ENGINE_ENVIRONMENT_FAILED: { severity:'L2', level:'err', title:'图像环境准备未完成', advice:'检查 Python、磁盘空间和网络后重试；失败不会替换原来的可用环境。' },
    ENGINE_MODEL_FAILED: { severity:'L2', level:'err', title:'模型文件操作未完成', advice:'检查文件来源、空间和运行中的引擎后重试；失败不会启用不完整文件。' },
    ENGINE_STOP_FAILED: { severity:'L2', level:'err', title:'引擎尚未停止', advice:'只能停止本次由软件启动的引擎；其它实例请回到启动它的程序关闭，再重新检测。' },
    ENGINE_START_FAILED: {
      severity: 'L2', level: 'err', title: '引擎启动失败',
      advice: '多半是没装依赖。去设置里复制那条安装命令，在终端里跑一次。'
    },

  // ⭐⭐⭐ 2026-10-09（引擎联通性审计）：下面 15 个码原来【只有调用、没有定义】，
  //   用户看到的是 CATALOG.UNKNOWN 的「出了点问题 / 详情里是原始报错」——
  //   没有下一步可做。逐条补上标题和建议。
  //   ⚠ 新增错误码时，这个文件必须同步加一条 —— 忘了加不会报错，
  //     只会静默降级成"出了点问题"（这正是这次审计查出来的形态）。
  //   自检：node scripts/_verify-engine-wiring.cjs 会列出"报了但没定义"的码。
  ENGINE_ACCEL_FAILED: {
    severity: 'L2', level: 'err', title: '一键开启加速没完成',
    advice: '看详情里"卡在哪一步"。多半是显卡驱动或磁盘空间；重试一次通常能过。'
  },
  ENGINE_OPERATION_FAILED: {
    severity: 'L2', level: 'err', title: '引擎操作没完成',
    advice: '看详情那句原始原因。启动/停止/安装都是同一个入口，失败原因会写在里面。'
  },
  MODEL_DOWNLOAD_UNAVAILABLE: {
    severity: 'L2', level: 'warn', title: '这个模型现在下不了',
    advice: '检查网络能不能通到模型来源；也可以先用其它档位的模型跑。'
  },
  TWEEN_APPLY_UNAVAILABLE: {
    severity: 'L2', level: 'warn', title: '「应用」这条路还没接上',
    advice: '这是版本问题，不是你的操作问题。换个方式把这张传回 Photoshop。'
  },
  TWEEN_APPLY_FAILED: {
    severity: 'L2', level: 'err', title: '强度没应用成功',
    advice: '看详情那句原因。多半是 Photoshop 那边没连上，或这一层已经被改过。'
  },
  TWEEN_APPLY_NO_TARGET: {
    severity: 'L2', level: 'warn', title: '找不到可以应用的那一层',
    advice: '要先把这张传回过 Photoshop、有对应图层，才能应用强度。'
  },
  COLOR_VERSION_UNAVAILABLE: {
    severity: 'L2', level: 'warn', title: '这一单没有别的版本可看',
    advice: '其它版本还没算过。切到会自动算的版本上等它算完，或先看当前这个版本。'
  },
  COLOR_VERSION_SAVE_FAILED: {
    severity: 'L2', level: 'err', title: '校色版本没存下来',
    advice: '检查缓存盘的空间；这一张的其它版本可能下次要重算。'
  },
  COLOR_RECOMPUTE_NO_REF: {
    severity: 'L2', level: 'warn', title: '补算这个版本缺一张参考图',
    advice: '它要用对齐过的底版当参考。先让这一单跑完底版那一步。'
  },
  COLOR_RECOMPUTE_DECODE_FAILED: {
    severity: 'L2', level: 'err', title: '补算这个版本时读图失败',
    advice: '文件可能被删或被占用。去缓存里确认这一单的底版文件还在。'
  },
  LAYOUT_FAILED: {
    severity: 'L1', level: 'warn', title: '界面重新排版没成功',
    advice: '通常自己会恢复。还不对就切一下卡片、或者重开软件。'
  },
  CARD_MOUNT_FAILED: {
    severity: 'L2', level: 'err', title: '这张卡没显示出来',
    advice: '切到别的卡再切回来；还不行就重开软件，缓存不会丢。'
  },
  SETTINGS_OPERATION_FAILED: {
    severity: 'L2', level: 'err', title: '设置没能保存',
    advice: '看详情那句原因。多半是磁盘写不进去，重启软件后重试一次。'
  },
  DETAIL_BLEND_UNSUPPORTED: {
    severity: 'L2', level: 'warn', title: '这张图不支持"融合"这一档',
    advice: '换成"替换"或"增益"档，它们对图没有这个限制。'
  },
  BROWSER_PREFERENCES_FAILED: {
    severity: 'L1', level: 'warn', title: '浏览器偏好设置没读出来',
    advice: '用的是默认设置，不影响其它功能。想改的话重开软件再试。'
  },
    COPY_FAILED: {
      severity: 'L1', level: 'warn', title: '没能复制到剪贴板',
      advice: '手动选中那行命令复制即可。'
    },

    // ── 抠像（2026-09-14）──
    // ⚠ 抠像【没有本机兜底】：没模型就是做不了。所以这几条一律要出声，
    //   不能像校色那样静默回落（docs/40 规矩 5）。
    MATTING_START_FAILED: {
      severity: 'L2', level: 'err', title: '抠像引擎没能启动',
      advice: '多半是没装 onnxruntime。去 设置 → 外挂能力 → 抠像，复制那条安装命令在终端里跑一次。'
    },
    MATTING_OPEN_DIR_FAILED: {
      severity: 'L1', level: 'warn', title: '打不开模型文件夹',
      advice: '设置页里显示了完整路径，可以手动复制到资源管理器打开。'
    },
    MATTING_VERIFY_FAILED: {
      severity: 'L1', level: 'warn', title: '模型完整性检查没跑成', advice: ''
    },
    MATTING_NO_URL: {
      severity: 'L2', level: 'warn', title: '这个模型的下载链接还没配',
      advice: '把对应的 .onnx 文件放进模型文件夹，回来点「重新扫描」一样能用。'
    },
    MATTING_URL_COPIED: {
      severity: 'L1', level: 'ok', title: '下载链接已复制', advice: ''
    },
    MATTING_NO_HOST: {
      severity: 'L2', level: 'warn', title: '抠像还没接进 Photoshop',
      advice: '参数已经能调了，但"抓选区→抠图→贴回"那条链路还在做。'
    },
    SEMANTIC_MODEL_MISSING: { severity:'L2', level:'warn', title:'缺少可区分目标的语义模型', advice:'先在本地能力中安装并启动 SAM 3，再识别人物或部位。' },
    SEMANTIC_ENGINE_UNAVAILABLE: { severity:'L2', level:'warn', title:'语义识别引擎未就绪', advice:'请在设置中检查本地能力状态。' },
    SEMANTIC_ENGINE_FAILED: { severity:'L2', level:'err', title:'语义识别失败', advice:'检查本地模型与显卡资源，再重新识别。' },
    SEMANTIC_RESULT_INVALID: { severity:'L2', level:'err', title:'识别边界不可靠', advice:'未创建选区；请重新识别或手动框选。' },
    SEMANTIC_NO_CANDIDATES: { severity:'L1', level:'warn', title:'未识别到目标部位', advice:'可以换一个部位重试，或在 Photoshop 中手动框选。' },
    SEMANTIC_CONFIRM_REQUIRED: { severity:'L1', level:'warn', title:'请先确认目标', advice:'在本机预览中选择人物或部位，并点击建立选区。' },
    SEMANTIC_SELECTION_EXPIRED: { severity:'L1', level:'warn', title:'这次部位识别已过期', advice:'请根据当前画面重新识别。' },
    SEMANTIC_DOCUMENT_CHANGED: { severity:'L2', level:'warn', title:'原画布已经变化', advice:'请重新识别，避免将旧坐标用于新画布。' },
    SEMANTIC_SELECTION_INVALID: { severity:'L2', level:'err', title:'选区坐标无效', advice:'未修改 Photoshop，请重新识别。' },
    SEMANTIC_CONTEXT_CHANGED: { severity:'L1', level:'warn', title:'识别上下文已切换', advice:'请在当前账号重新识别。' },
    SEMANTIC_PART_UNSUPPORTED: { severity:'L1', level:'warn', title:'暂不支持这个部位名称', advice:'可选择人物、服装、上衣、裤子、连衣裙、脸、头发、手、手臂、腿或鞋。' },
    SEMANTIC_MARGIN_INVALID: { severity:'L1', level:'warn', title:'选区余量无效', advice:'每条边可向外留 0–50%。' },
    SEMANTIC_CAPTURE_INVALID: { severity:'L2', level:'err', title:'未取得完整画布', advice:'请检查 Photoshop 联动，然后重新抓取。' },
    SEMANTIC_APPLY_FAILED: { severity:'L2', level:'err', title:'Photoshop 未确认选区', advice:'检查联动状态后重新识别并确认。' },
    SEMANTIC_PREVIEW_BUSY: { severity:'L1', level:'warn', title:'已有部位确认窗口', advice:'先完成或取消当前预览。' },
    EAGLE_UNAVAILABLE: { severity:'L2', level:'warn', title:'Eagle 当前不可用', advice:'请打开 Eagle 并检查本机接口；未连接成功前不会修改任何 Eagle 内容。' },
    EAGLE_ARCHIVE_FAILED: { severity:'L2', level:'err', title:'Eagle 归档未全部完成', advice:'重新读取结果，检查未完成项目后再确认归档；已完成项目会保留。' },
    EAGLE_ACCOUNT_CHANGED: { severity:'L2', level:'warn', title:'Eagle 操作期间账号已切换', advice:'请在当前账号重新配对 Eagle，再读取待归档项目。' },
    LIGHTING_FAILED: { severity:'L2', level:'err', title:'相机或灯光操作未完成', advice:'检查来源图片、助手或生图连接，查看保留的结果后重试未完成项目。' },
    LIGHTING_ACCOUNT_CHANGED: { severity:'L2', level:'warn', title:'灯光项目所属账号已切换', advice:'在当前账号重新打开灯光项目并抓取图像，原账号的操作已停止。' },
    // ⭐ 10-25：工具「眼神调整」（eyegaze-tool.js，本机引擎 /eyegaze/prepare）
    EYEGAZE_FAILED: { severity:'L2', level:'err', title:'眼神调整没完成',
      advice:'详情里有原因。多半是 Photoshop 没框选区（要包住整张脸），或者联动插件没连上。' },
    EYEGAZE_UNUSABLE: { severity:'L1', level:'warn', title:'眼神调整：这张图找不到能用的眼睛',
      advice:'选区要包住整张脸（正脸或微侧脸、眼睛睁开）；眼睛太小的话把选区缩到脸附近，或者把「处理倍率」调到 2x。' },
    EYEGAZE_ENGINE_OFFLINE: { severity:'L2', level:'err', title:'眼神调整：本机引擎没开起来',
      advice:'到「外挂能力」卡里看本机引擎的状态，点启动；起来以后再点一次「抓取选区」。' },
    EYEGAZE_ENGINE_OLD: { severity:'L2', level:'warn', title:'眼神调整：本机引擎是旧版本',
      advice:'软件更新后本机引擎要重启一次才认得新功能。到「外挂能力」卡里重启本机引擎，或者重开软件。' },
    EYEGAZE_UNAVAILABLE: { severity:'L2', level:'err', title:'眼神调整：本机引擎缺组件',
      advice:'引擎运行库里少了人脸识别组件或模型。更新到最新的完整安装包后再试；详情里有缺的是哪一样。' },
    EYEGAZE_RETURN_FAILED: { severity:'L2', level:'err', title:'眼神调整：没能传回 Photoshop',
      advice:'原文档可能关了或者尺寸变了。回到原文档、确认联动插件连着，再点「传回 PS」。' },
    // ⭐ 10-25：任务卡「分割」（segment-panel.js）
    ADDMASK_FAILED: { severity:'L2', level:'err', title:'分割：这张图打不开',
      advice:'多半是原图或生成图已经被释放了（换账号 / 清缓存会释放）。重新点开这张任务卡再点「分割」；一直不行就重新生成。详情里有原始原因。' },
    ADDMASK_RETURN_FAILED: { severity:'L2', level:'err', title:'分割：蒙版没换上',
      advice:'Photoshop 里那张传回的图层可能被删了、合并了，或者文档关了。可以在 PS 里把那个图层删掉，再在任务卡上点「分割」→「回传」重新贴一张带蒙版的。' },
    CREATIVE_TOOL_FAILED: { severity:'L2', level:'err', title:'场景、海报或半合成未完成', advice:'检查素材、生成设置和服务连接，保留已完成的结果后重试未完成项目。' },
    CREATIVE_ACCOUNT_CHANGED: { severity:'L2', level:'warn', title:'创作项目所属账号已切换', advice:'请在当前账号重新打开项目并确认来源图片；原账号的操作已停止。' },
    EAGLE_UPDATE_FAILED: { severity:'L2', level:'err', title:'Eagle 标签未写入', advice:'请检查 Eagle 是否仍在运行，再确认清单后重试。' },
    ASSISTANT_CAPTURE_DIMENSIONS: { severity:'L2', level:'err', title:'画布尺寸无效', advice:'请检查当前 Photoshop 文档。' },
    ASSISTANT_CAPTURE_PARAMS: { severity:'L2', level:'err', title:'助手抓图参数无效', advice:'请重新发起看图。' },
    ASSISTANT_CAPTURE_BOUNDS: { severity:'L2', level:'warn', title:'无法确认完整画布范围', advice:'未向助手发送可能失真的构图；请重新抓取或检查 Photoshop 版本。' },
    ASSISTANT_CAPTURE_PIXELS: { severity:'L2', level:'warn', title:'助手预览格式不受支持', advice:'请检查 Photoshop 和桥接版本后重试。' },
    ASSISTANT_CAPTURE_EXPIRED: { severity:'L1', level:'warn', title:'助手抓图请求已过期', advice:'请重新抓取当前画布。' },
    ASSISTANT_CAPTURE_UNSUPPORTED: { severity:'L2', level:'warn', title:'当前 Photoshop 不支持助手抓图', advice:'请升级 Photoshop 和联动插件。' },
    ASSISTANT_CAPTURE_EMPTY: { severity:'L1', level:'warn', title:'画布没有可读取的图像', advice:'请打开有内容的文档再试。' },
    ASSISTANT_CAPTURE_ENCODING: { severity:'L2', level:'err', title:'助手预览编码失败', advice:'请重新抓取当前画布。' },
    GLOW_BUSY: { severity:'L1', level:'warn', title:'辉光预览已经打开', advice:'先完成或取消当前的辉光操作。' },
    GLOW_RUN_FAILED: { severity:'L2', level:'err', title:'辉光计算未完成', advice:'检查 Photoshop 桥接状态；超大图片请缩小选区后重试。' },
    GLOW_PREVIEW_FAILED: { severity:'L1', level:'warn', title:'辉光预览无法更新', advice:'可以取消后重新抓图，错误详情会保留。' },
    MATTING_BUSY: {
      severity: 'L1', level: 'warn', title: '抠像还在跑', advice: '等这一次跑完再点。'
    },
    MATTING_UNUSABLE: {
      severity: 'L2', level: 'warn', title: '现在还抠不了',
      // ⚠ advice 留空：具体原因（缺依赖/没装模型/文件没下完）由 message 带进来，
      //   那才是真正有用的下一步。写死一句通用建议反而会盖过它。
      advice: ''
    },
    MATTING_RUN_FAILED: {
      severity: 'L2', level: 'err', title: '抠像没跑成',
      advice: '看详情里那句原因——它会说是哪一步出的问题（抓图 / 引擎 / 贴回）。'
    },
    // 10-25（docs/286 B7）：原来显存不够时报的是「'utf-8' codec can't decode byte 0xd3」，看不懂
    ENGINE_OUT_OF_MEMORY: {
      severity: 'L2', level: 'warn', title: '显卡内存不够，这张图太大',
      advice: '把选区框小一点、换低一档，或者打开云端外挂用云端算。不是软件坏了。'
    },
    MATTING_EMPTY: {
      // ⚠ 这【不是】故障，是模型在这张图里什么都没找到。说清楚才不会让用户去查引擎。
      severity: 'L2', level: 'warn', title: '这块区域里没抠出东西',
      advice: '模型在选区里没找到主体。换一档模型试试，或者把选区框得更贴近人/物一点。'
    },
    MATTING_PLACE_FAILED: {
      severity: 'L2', level: 'err', title: '抠好了，但没能贴回 Photoshop',
      advice: '图已经在任务卡的缩略图里了，点开能看。常见原因是来源文档被关掉了。'
    },
    // ═══ 人体解析（2026-09-14 深夜）═══════════════════════
    SEGMENT_BUSY: {
      severity: 'L1', level: 'warn', title: '人体解析还在跑', advice: '等这一次跑完再点。'
    },
    SEGMENT_UNUSABLE: {
      // ⚠ advice 留空：真正的原因由 message 带进来（同 MATTING_UNUSABLE 的理由）
      severity: 'L2', level: 'warn', title: '现在还做不了人体解析', advice: ''
    },
    SEGMENT_RUN_FAILED: {
      severity: 'L2', level: 'err', title: '人体解析没跑成',
      advice: '看详情里那句原因——它会说是哪一步出的问题（抓图 / 引擎 / 贴回）。'
    },
    SEGMENT_EMPTY: {
      // ⚠ 这不是故障，是模型在这张图里没认出人。分开说，用户才不会去查引擎。
      severity: 'L2', level: 'warn', title: '这块区域里没认出人',
      advice: '人体解析只认人。框选里要有人（而且别太小），换一档模型也可以试试。'
    },
    SEGMENT_NO_PICKED_PART: {
      severity: 'L2', level: 'warn', title: '你勾的那几个部位这张图里都没有',
      advice: '面板里把勾选去掉（一个都不勾 = 全要），或者换几个部位。'
    },
    SEGMENT_APPLY_FAILED: {
      severity: 'L2', level: 'err', title: '部位算好了，但没能做进 Photoshop',
      advice: '各部位的预览还在任务卡里。常见原因是来源文档被关掉了。'
    },
    SEGMENT_PARTIAL: {
      // ⚠ L1 而不是 L2：大部分部位做成了，只是少了几个。
      //   但【必须说】——不说就是静默少做（铁律 17）。
      severity: 'L1', level: 'warn', title: '有几个部位没做成',
      advice: '做成的那些已经在图层里了。把这句话截图给开发，能查出是哪个部位卡住了。'
    },
    // ═══ 指哪抠哪 / SAM2（2026-09-14 深夜）═══════════════
    SAM2_BUSY: {
      severity: 'L1', level: 'warn', title: '指哪抠哪还在跑', advice: '等这一次跑完再点。'
    },
    SAM2_UNUSABLE: {
      severity: 'L2', level: 'warn', title: '现在还用不了指哪抠哪', advice: ''
    },
    SAM2_NO_BOX: {
      severity: 'L2', level: 'warn', title: '得先在 Photoshop 里框一下',
      advice: '这个功能是「你指哪它抠哪」——先用选框工具框住你要的东西，再按开始计算。'
    },
    SAM2_RUN_FAILED: {
      severity: 'L2', level: 'err', title: '指哪抠哪没跑成',
      advice: '看详情里那句原因——它会说是哪一步出的问题（抓图 / 引擎 / 贴回）。'
    },
    SAM2_EMPTY: {
      severity: 'L2', level: 'warn', title: '框里没抠出东西',
      advice: '三个答案都是空的。把框拉得更贴近你要的那个东西再试一次。'
    },
    SAM2_APPLY_FAILED: {
      severity: 'L2', level: 'err', title: '抠好了，但没能做进 Photoshop',
      advice: '结果还在任务卡的缩略图里。常见原因是来源文档被关掉了。'
    },
    COLORMATCH_FAILED: {
      // ⚠ L1：校色是锦上添花，失败了原图照样在、照样能用。
      //   把它做成 L2 会让用户以为生成也失败了。
      severity: 'L1', level: 'warn', title: '自动校色没做成，已用原图',
      advice: ''
    },
    COLOR_BASE_MISSING: {
      // ⭐ 2026-10-05（docs/143 §五-5.4）：老任务没有底版文件。
      //   ⚠ 用户拍板：【不做迁移】，点了就明说缺文件 —— 而不是静默不生效。
      //   ⭐ 要告诉用户下一步怎么办：底版只有引擎档（档 2/3）生成时才会有，
      //     所以要"切回没校色的样子"，最简单的是重新生成一次（开着引擎）。
      severity: 'L2', level: 'warn', title: '这一单没有底版，切不了',
      advice: '底版是"掰正了、没校色"的那一份，只有开着加速引擎（档 2/3）生成时才会一起存。'
        + '这一单是早先生成的（或者当时引擎没开），所以没有。'
        + '想随时切回没校色的样子，开着引擎再生成一次就有了。'
    },
    AI_RESTORE_FAILED: {
      severity: 'L2', level: 'err', title: '生成的图没能还原出来',
      advice: '图拿回来了但解码失败。如果开着抗截断，试试关掉再生成一次。'
    },
    AI_TRANSFER_FAILED: {
      severity: 'L2', level: 'err', title: '没能传回 Photoshop',
      advice: '图还在，可以手动保存，或者稍后再点一次传回。'
    },
    // ⭐ 2026-10-21（docs/261 B8）：PS 插件回图那几步的错误码以前表里没有 ⇒ 标题只能显示兜底的「出了点问题」。
    //   详情里会带上 Photoshop 自己说的原因（插件 ps-io.js returnErrorText）。
    RETURN_PS_ACTION_FAILED: { severity: 'L2', level: 'err', title: 'Photoshop 拒绝了这次传回',
      advice: '右滑看详情里 Photoshop 的原话。最常见的是 PS 开着对话框（液化、Camera Raw、存储…）、文档被锁定或者正在执行别的操作：关掉对话框、等 PS 空下来，再点一次传回。图还在，不会丢。' },
    RETURN_OPERATION_FAILED: { severity: 'L2', level: 'err', title: '这张图没能贴进 Photoshop',
      advice: '右滑看详情里的原因。确认目标文档还开着、没被锁定、PS 没有弹着对话框，再点一次传回。同一批里其他图不受影响。' },
    RETURN_BATCH_FAILED: { severity: 'L2', level: 'err', title: '这一批图都没能传回 Photoshop',
      advice: '先看看 PS 里有没有已经贴进去的图层，免得重复。确认文档还开着、PS 没弹着对话框，再点一次传回。' },
    RETURN_LAYER_RECEIPT_FAILED: { severity: 'L2', level: 'warn', title: '贴进去了，但 Photoshop 没告诉我是哪一层',
      advice: '看看 PS 里是不是已经多了一层，有的话不用再传；之后的「应用强度 / 补细节」可能找不到这一层，需要时重新传回一次。' },
    RETURN_VISIBILITY_READ_FAILED: { severity: 'L2', level: 'err', title: '读不到 Photoshop 里原来图层的显示状态',
      advice: '为了不把你原来的图层显隐弄乱，这次没有贴。确认目标文档还开着、PS 没弹着对话框，再点一次传回。' },
    RETURN_VISIBILITY_RESTORE_FAILED: { severity: 'L2', level: 'warn', title: '图贴进去了，但原来图层的显示状态没完全恢复',
      advice: '在 PS 图层面板里看一下原来那些图层的小眼睛，有被关掉的手动点开。' },
    RETURN_CHECKPOINT_FAILED: { severity: 'L2', level: 'warn', title: '传回时的检查步骤没完成',
      advice: '看看 PS 里图层是否正常。不对的话按 Ctrl+Z 撤销，再点一次传回。' },
    RETURN_ANCHOR_CREATE_FAILED: { severity: 'L2', level: 'err', title: '传回前的准备图层没建成，已经停下',
      advice: '没有删任何东西。确认 PS 没弹着对话框，再点一次传回。' },
    RETURN_ANCHOR_NOT_TOP_LEVEL: { severity: 'L2', level: 'err', title: '传回前的准备图层位置不对，已经停下',
      advice: '没有贴图。看看 PS 图层面板里有没有多出来的空图层，有就删掉，再点一次传回。' },
    RETURN_ANCHOR_DELETE_FAILED: { severity: 'L2', level: 'warn', title: '图贴好了，但留下了一个临时空图层',
      advice: '在 PS 图层面板里把那个空的临时图层删掉就行，图本身没问题。' },
    RETURN_STRATEGY_INVALID: { severity: 'L2', level: 'err', title: '传回方式设置不对',
      advice: '这是软件内部的问题。点「反馈这个问题」告诉我们，同时重新装一次 PS 插件。' },
    AI_TRANSFER_PREPARE_FAILED: {
      severity: 'L2', level: 'err', title: '准备传回数据时出错',
      advice: ''
    },
    AI_SOURCE_SNAPSHOT_MISSING: {
      severity: 'L2', level: 'warn', title: '这个任务缺少 Photoshop 来源信息',
      advice: '没有记录当初从哪张图抓的，为安全起见不自动贴回去。'
    },
    PS_CAPTURE_FAILED: {
      severity: 'L2', level: 'err', title: '没能从 Photoshop 拿到图',
      advice: '详情里是 Photoshop 那边的具体原因。'
    },

    // ── 缓存 / 持久化：L1，坏了也不影响当次使用 ─────────
    CACHE_WRITE_FAILED: {
      // 2026-10-24：L1 → L2。原来只闪一下 toast，用户只知道「每次都存不了」不知道为什么；
      //   现在走 ERR.cacheFailure，同一种原因一次运行只弹一张卡，卡上说清原因 + 两个按钮。
      severity: 'L2', level: 'warn', title: '这次的结果没能存进缓存',
      advice: '不影响这次出图，只是这张不会出现在历史里。'
    },
    CACHE_RESTORE_FAILED: {
      severity: 'L1', level: 'warn', title: '有历史任务没能恢复',
      advice: ''
    },
    TASKBAR_UPDATE_FAILED: { severity: 'L1', level: 'warn', title: '任务栏状态没更新上', advice: '' },
    SOURCE_IMAGE_REGISTER_FAILED: { severity: 'L1', level: 'warn', title: '输入图没能登记', advice: '' },
    PROJECT_READ_FAILED: { severity: 'L2', level: 'err', title: '本机项目记录无法读取', advice: '已停止写入并保留原记录。请检查本机存储，重启后重试；不要清空项目数据。' },
    PROJECT_SAVE_FAILED: { severity: 'L2', level: 'err', title: '项目记录尚未保存', advice: '请检查磁盘空间和写入权限，再重试这次操作。' },
    PROJECT_PLANNER_FAILED: { severity: 'L2', level: 'err', title: '项目或日程操作未完成', advice: '请根据详情检查 Photoshop 连接或桌面日程服务，然后重试。' },
    PROJECT_ACCOUNT_CHANGED: { severity: 'L1', level: 'info', title: '账号已切换，旧项目操作已停止', advice: '请在当前账号重新操作。' },
    WORKFLOW_STATE_SAVE_FAILED: { severity: 'L1', level: 'warn', title: '工作流参数尚未保存', advice: '当前参数仍保留在界面内。请检查本机存储空间和权限后重试。' },
    CHECKPOINT_CAPACITY_FAILED: { severity: 'L2', level: 'warn', title: '检查点容量管理未完成', advice: '请检查缓存目录的空间和权限，处理详情中的原因后重试。' },
    CHECKPOINT_CAPACITY_BLOCKED: { severity: 'L2', level: 'warn', title: '缓存容量不足以保存检查点', advice: '请在历史中清理不需要的缓存，或在设置中增加容量上限。' },
    CHECKPOINT_CAPACITY_DECLINED: { severity: 'L1', level: 'info', title: '已保留检查点', advice: '缓存仍超限。清理缓存或增加容量上限后，才会继续保存新检查点。' },
    REF_THUMB_FAILED: { severity: 'L1', level: 'warn', title: '参考图缩略图没做出来', advice: '' },
    UXP_BRIDGE_UPDATE_NEEDED: { severity: 'L2', level: 'warn', title: 'PS 联动插件需要更新', advice: '更新好、插件重新连上以后这张卡会自己消失。不更新也能照常用，只是这一版新加 / 修好的 PS 操作可能不灵。' },
    SNIP_FAILED: { severity: 'L2', level: 'warn', title: '截图当参考图没成功', advice: '再按一次快捷键试试；还不行就先切到 Photoshop，用选区当参考图（PS 在前台时快捷键会抓 PS 里框选的那块）。' },
    PRESET_REFERENCE_FAILED: { severity: 'L2', level: 'warn', title: '参考图操作未完成', advice: '检查图片是否完整；缺失的预设参考图需要从原设备导出完整预设包后重新导入。' },
    PRESET_REFERENCE_CLEANUP_FAILED: { severity: 'L1', level: 'warn', title: '旧参考图尚未清理', advice: '预设已保存。检查本机存储空间和权限后，重新删除不需要的预设以释放未引用图片。' },
    PRESET_SAVE_FAILED: { severity: 'L2', level: 'warn', title: '预设操作未保存', advice: '检查本机可用空间和预设内容后重试。' },
    WORKFLOW_REFERENCE_MAPPING_REQUIRED: { severity: 'L2', level: 'warn', title: '工作流参考图未就绪', advice: '在生成的参考图片面板打开图片节点，为主图和每张参考图指定独立节点。平台工作流未开放参考图输入时不会扣费。' },

    // ── 界面功能 ────────────────────────────────────────
    // ⭐ 2026-10-19（docs/250 第 20 条）：失败任务「重跑」拿不齐原单的东西（原图 / 参考图 / 工作流预设）时 —— 不偷偷少发，明说
    TASK_RERUN_UNAVAILABLE: {
      severity: 'L2', level: 'warn', title: '这单没法原样重跑',
      advice: '详情里写了缺的是什么。原卡还在，可以在 Photoshop 里重新框选后再生成。'
    },
    VIEWER_OPEN_FAILED: {
      severity: 'L2', level: 'err', title: '大图打不开',
      advice: ''
    },
    BG_SAVE_FAILED: {
      severity: 'L2', level: 'err', title: '背景图没保存上',
      advice: '换一张小一点的图试试。'
    },
    BG_READ_FAILED: {
      severity: 'L2', level: 'warn', title: '背景图读不出来',
      advice: '已经退回默认背景，不影响使用。'
    },
    SHORTCUT_REGISTER_FAILED: {
      severity: 'L1', level: 'warn', title: '快捷键没注册上',
      advice: '多半被别的软件占用了。窗口在最前面时仍然能用。'
    },
    POLL_SET_FAILED: { severity: 'L1', level: 'warn', title: '轮询间隔没设置上', advice: '' },

    // ── 盖印后自动收起（2026-09-14）──
    // ⚠ 这两条是"盖印了卡没消失"排查的直接产物。功能本身天生只能靠猜，
    //   所以它的每一种失败都必须出声，不然用户分不清"没触发"和"触发了判定没过"。
    STAMP_PROBE_MISSING: {
      severity: 'L2', level: 'warn', title: '盖印功能需要重载 Photoshop 里的插件',
      advice: '桌面板已经是新版了，但 Photoshop 里跑的插件还是旧版，没有「盖印探针」这条命令。去 UXP Developer Tool 里对插件点一次 Reload，再回来试。'
    },
    STAMP_PROBE_FAILED: {
      severity: 'L1', level: 'warn', title: '盖印探针这一轮没跑成',
      advice: ''
    },

    // ── 预设系统：以前只进 console，用户完全看不见 ──────
    PRESET_FORGE_REVIEW_REQUIRED: {
      severity: 'L2', level: 'warn', title: '这个 Forge 预设还需要验证工作流',
      advice: '参数已经保留。请等待对应的 ComfyUI 工作流通过验证后再生成，避免错误调用其他模型。'
    },
    AGENT_WORKSPACE_FAILED: { severity: 'L2', level: 'err', title: '软件修改工作区不可用', advice: '当前使用官方界面。检查应用数据目录的权限、磁盘空间及错误详情；已有备份和冲突归档不会删除。' },
    TUTORIAL_OPEN_FAILED: { severity: 'L2', level: 'warn', title: '新手教程没打开', advice: '不影响使用。以后想看，在「设置 → 关于软件 → 重新看教程」里再开。' },
    RUNNINGHUB_OFF: { severity: 'L2', level: 'warn', title: 'RunningHub 还没接通', advice: '这条预设走的是 RunningHub，暂时用不了。换一条平台工作流或本地 ComfyUI 的预设；本次没有扣费。' },
    AGENT_UPGRADE_CONFLICT: { severity: 'L2', level: 'warn', title: '升级后有软件修改被停用', advice: '相关文件已恢复官方版本，修改内容已归档。打开助手的“Agent 权限与软件恢复”查看文件和恢复节点，重新审阅后再修改。' },
    AGENT_ROLLBACK_UPGRADE_CONFLICT: { severity: 'L2', level: 'warn', title: '旧恢复节点与当前版本不兼容', advice: '官方升级已改变相关文件。旧备份仍保留，但不会覆盖新版本；请根据当前官方文件重新制作修改。' },
    AGENT_PRESET_IMPORT_FAILED: { severity: 'L2', level: 'warn', title: 'Agent 预设未能保存', advice: '查看错误代码：文件需包含名称、带时区的时间、作者和预设内容；不要附带密钥或图片。修改后重新写入 JSON，也可检查本机授权和磁盘空间。' },
    AGENT_PRESET_INBOX_FAILED: { severity: 'L2', level: 'warn', title: 'Agent 收件箱已停止读取', advice: '打开剪影上的 Agent 图标，在管理中重新启用。切换账号需要重新确认；不要把收件箱改成链接或移到其它位置。' },
    AGENT_PRESET_ROLLBACK_BLOCKED: { severity: 'L2', level: 'warn', title: '暂时不能恢复这个预设节点', advice: '该操作后还有预设变更。为保护这些内容没有覆盖数据库；请先导出当前预设，或先恢复较新的节点。' },
    PRESET_MIGRATION_FAILED: {
      severity: 'L2', level: 'err', title: 'V6 预设搬家未完成',
      advice: '查看详情中的文件或存储原因。搬家写入采用整批事务；写入失败不会留下半批预设。确认磁盘空间充足后重试。'
    },
    PRESET_MIGRATION_ROLLBACK_BLOCKED: {
      severity: 'L2', level: 'warn', title: '搬家之后修改过预设，已保护这些修改',
      advice: '自动恢复已停止。先导出当前预设备份，再按搬家报告手动移除不需要的条目，避免丢失后续修改。'
    },
    PRESET_BOOT_FAILED: {
      severity: 'L2', level: 'err', title: '预设数据没加载起来',
      advice: '预设列表可能是空的。重启桌面板试试。'
    },
    PRESET_SILHOUETTE_FAILED: {
      severity: 'L2', level: 'err', title: '剪影素材切割失败',
      advice: '剪影图可能显示不全或点不中部位。'
    },
    PRESET_LAYOUT_FAILED: {
      severity: 'L1', level: 'warn', title: '剪影一直拿不到尺寸',
      advice: '剪影可能不显示，把卡片收起再展开一次。'
    },
    SILHOUETTE_EDITOR_STALE: {
      severity: 'L2', level: 'warn', title: '剪影编辑结果已过期，未写入',
      advice: '账号或剪影素材在编辑期间发生了变化。为避免写错账号，请重新打开剪影编辑器并保存。'
    },
    PRESET_THUMB_FAILED: { severity: 'L1', level: 'warn', title: '预设缩图失败，已改送原图', advice: '' },
    PRESET_PROMPT_SYNC_FAILED: { severity: 'L1', level: 'warn', title: '提示词没同步到生成卡', advice: '' },
    PRESET_FIELD_HISTORY_FAILED: { severity: 'L2', level: 'warn', title: '这次输入没有保存到历史', advice: '当前输入仍在。请检查本机存储空间，清理不需要的字段历史后再保存。' },
    PRESET_START_FAILED: {
      severity: 'L2', level: 'err', title: '从预设启动生成失败',
      advice: ''
    },

    // ── 界面自身崩溃 ────────────────────────────────────
    // ⚠ 按 2026-09-11 定的 L4 尺度：脚本报个错不一定就用不下去，所以是 L2。
    //   只有【启动自检没跑完】才是 L4 —— 那种情况下大半功能是死的，
    //   让用户接着点下去只会踩到更多坑(CLAUDE.md 铁律 17：语法通过 ≠ 能用)。
    UI_SCRIPT_ERROR: {
      severity: 'L2', level: 'err', title: '界面出了个内部错误',
      advice: '如果界面开始不正常(按钮没反应、卡片不动)，重启一次桌面板。详情里的内容请截图给开发。'
    },
    UI_PROMISE_REJECTION: {
      severity: 'L2', level: 'err', title: '界面有个操作没能完成',
      advice: '详情里的内容请截图给开发。'
    },
    UI_BOOT_INCOMPLETE: {
      severity: 'L4', level: 'err', title: '桌面板没有正常启动',
      advice: '启动脚本没跑完，现在大部分功能是坏的。请重启桌面板；如果重启后还是这样，把详情截图给开发。'
    },

    // ── 兜底 ────────────────────────────────────────────
    UNKNOWN: {
      severity: 'L2', level: 'err', title: '出了点问题',
      advice: '详情里是原始报错。'
    }
  };

  // ⭐ 2026-10-20 Mac：装 PS 插件这几条原文写的是 Windows 的做法（Windows 弹窗、杀毒软件、右键 .exe），
  //   Mac 上照着做不了。只在 Mac 上换成 Mac 的说法，Windows 上一个字不变。
  if (/Macintosh|Mac OS X/.test(navigator.userAgent || '')) {
    CATALOG.UXP_PERMISSION_REQUIRED = Object.assign({}, CATALOG.UXP_PERMISSION_REQUIRED, {
      advice: '已经输过电脑密码、用管理员身份试过，还是写不进 Photoshop 的插件文件夹。先确认这台 Mac 的登录账户是管理员，再点一次安装。已有插件会被保留。'
    });
    CATALOG.UXP_ELEVATION_CANCELLED = Object.assign({}, CATALOG.UXP_ELEVATION_CANCELLED, {
      advice: 'Photoshop 装在「应用程序」文件夹里，放插件要 Mac 允许一次。再点一次安装，弹出窗口要电脑密码时输入开机密码，点「好」。'
    });
    CATALOG.UXP_ELEVATION_FAILED = Object.assign({}, CATALOG.UXP_ELEVATION_FAILED, {
      advice: '没能用管理员身份把插件放进 Photoshop 的插件文件夹。确认这台 Mac 的登录账户是管理员后重试；详情里是原始报错。'
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  去重
  //
  //  为什么要：批量生成 8 张，网络断了就是 8 次同样的失败。
  //  不去重会一口气堆 8 张一模一样的报错卡，反而看不见重点。
  //  ⚠ 只按「错误码 + 具体消息」去重，不按标题 ——
  //    同一个码配不同消息(比如两个不同文档)是两回事，都要看见。
  // ═══════════════════════════════════════════════════════════
  const DEDUPE_MS = 8000;
  const recent = new Map();   // key -> { at, count }

  function dedupeKey(code, message) { return String(code) + '|' + String(message || ''); }

  function shouldSuppress(code, message) {
    const key = dedupeKey(code, message);
    const now = Date.now();
    const hit = recent.get(key);
    if (hit && (now - hit.at) < DEDUPE_MS) {
      hit.count += 1;
      hit.at = now;
      return hit.count;      // 返回累计次数(>1 表示应抑制)
    }
    recent.set(key, { at: now, count: 1 });
    // 顺手清理过期项，防止这个 Map 只增不减
    if (recent.size > 60) {
      for (const [k, v] of recent) { if (now - v.at > DEDUPE_MS * 4) recent.delete(k); }
    }
    return 1;
  }

  // ═══════════════════════════════════════════════════════════
  //  详情区文本
  //
  //  报错卡右滑露出来的那一块。顺序是固定的，因为用户看的顺序是固定的：
  //  先问"为什么"，再问"当时什么情况"，最后才关心错误码。
  // ═══════════════════════════════════════════════════════════
  // ⚠ 必须定义在 buildDetail 之前。本项目栽过 const 暂时性死区
  //   (CLAUDE.md 铁律 17：脚本抛错死掉，后面绑定全没跑)，不给自己留这种雷。
  const STAGE_LABEL = {
    validate: '检查参数', capture: '抓取', submit: '提交',
    generate: '生成', restore: '还原', transfer: '传回', unknown: '未知',
    // 抠像那条链路的阶段（2026-09-14 下半场）
    engine: '检查引擎', matting: '抠图',
    // 人体解析 / 指哪抠哪（2026-09-14 深夜）。
    // ⚠ apply = "盖印+做蒙版"那一步，三个功能共用一个桥动作，所以阶段名也共用。
    segment: '认部位', sam2: '指哪抠哪', glow:'辉光计算', apply: '盖印做蒙版'
  };

  function buildDetail(def, opts) {
    const lines = [];
    const message = String(opts.message || '').trim();
    if (message) lines.push('原因：' + message);

    // 现场。⚠ 值为空的键直接跳过 —— "文档：(空)"这种行只会添乱。
    const ctx = opts.context || {};
    const ctxLines = Object.keys(ctx)
      .filter(k => ctx[k] !== undefined && ctx[k] !== null && String(ctx[k]) !== '')
      .map(k => '  ' + k + '：' + ctx[k]);
    if (ctxLines.length) lines.push('', '当时的情况：', ctxLines.join('\n'));

    if (def.advice) lines.push('', '怎么办：' + def.advice);

    // 排查信息放最后。用户不看，但截图给开发时全靠这几行。
    const tail = [];
    if (opts.code) tail.push('错误码 ' + opts.code);
    // ⚠ 括号不能省：'阶段 '+X||Y 会被解析成 ('阶段 '+X)||Y，永远取不到 Y，
    //   表里没有的阶段就会显示成「阶段 undefined」。
    if (opts.stage) tail.push('阶段 ' + (STAGE_LABEL[opts.stage] || opts.stage));
    if (opts.taskId) tail.push('任务 ' + opts.taskId);
    tail.push(new Date().toLocaleTimeString());
    lines.push('', '── 排查信息 ──', tail.join(' · '));

    // 原始报错单独放，可能很长(比如 V6 那套四条诊断)
    const raw = opts.raw && String(opts.raw).trim();
    if (raw && raw !== message) lines.push('', '原始报错：', raw);

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  联网探测 ⭐
  //
  //  用来区分两种长得一模一样、但修法完全不同的失败：
  //    ① 连不上   —— 请求根本没出门(网络/DNS/代理)
  //    ② 被拒收   —— 请求到了服务器，是回来的响应被跨域规则挡了
  //
  //  判别原理：mode:'no-cors' 的请求【不受跨域规则限制】，
  //  只有在网络层真的失败时才会 reject。所以：
  //    no-cors 能成 + 正常请求失败 = 跨域被拦
  //    no-cors 也失败              = 网络不通
  //
  //  ⚠ 这是本项目 2026-09-11 卡了一个多小时的那个问题的自动化判别，
  //    别把它简化成"随便 ping 一下"。
  // ═══════════════════════════════════════════════════════════
  async function probeEndpoint(rawUrl) {
    let origin = '';
    try { origin = new URL(String(rawUrl || '')).origin; }
    catch (_) { return { verdict: 'BAD_URL', origin: '', ms: 0 }; }

    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const elapsed = () => Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - started);

    // 超时必须有：服务器不响应时不能让用户干等着看不到报错。
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, 4000) : null;
    try {
      await fetch(origin, {
        method: 'GET', mode: 'no-cors', cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      return { verdict: 'REACHABLE', origin, ms: elapsed() };
    } catch (e) {
      const aborted = e && (e.name === 'AbortError');
      return { verdict: aborted ? 'TIMEOUT' : 'UNREACHABLE', origin, ms: elapsed(), message: (e && e.message) || String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 常见状态码的人话。⚠ 只放【确定】的，拿不准的宁可不写 ——
  // 猜错了比不写更糟，用户会照着错误的方向折腾半天。
  const STATUS_HINT = {
    400: '请求有问题', 401: 'API Key 不对或没填', 402: '余额不足',
    403: '没有权限或被拒绝', 404: '接口地址不对', 413: '发出去的内容太大',
    415: '格式不支持', 429: '请求太频繁', 500: '服务器自己出错了',
    502: '网关错误', 503: '服务暂时不可用', 504: '服务器响应超时'
  };

  // 把探测结果翻译成错误码 + 一行人话
  function verdictToCode(verdict) {
    if (verdict === 'REACHABLE') return 'AI_CORS_BLOCKED';
    if (verdict === 'TIMEOUT') return 'AI_NETWORK_UNREACHABLE';
    if (verdict === 'BAD_URL') return 'AI_URL_MISSING';
    return 'AI_NETWORK_UNREACHABLE';
  }
  function verdictText(p) {
    if (!p) return '';
    if (p.verdict === 'REACHABLE') return '探测：' + p.origin + ' 能连上(' + p.ms + 'ms)，所以问题出在响应被拦，不是网络。';
    if (p.verdict === 'TIMEOUT') return '探测：' + p.origin + ' 4 秒内没有任何响应。';
    if (p.verdict === 'BAD_URL') return '探测：这个地址格式不对，解析不出来。';
    return '探测：' + p.origin + ' 连不上' + (p.message ? '(' + p.message + ')' : '') + '。';
  }

  // ═══════════════════════════════════════════════════════════
  //  主入口
  // ═══════════════════════════════════════════════════════════
  //  report(code, {
  //    message,    真实错误文字(必给，这是"为什么")
  //    raw,        原始报错全文(可选，可以很长)
  //    context,    { 文档:'x.psd', 尺寸:'4096×4096' } —— 现场
  //    stage,      capture/generate/transfer...
  //    taskId,
  //    title,      覆盖表里的标题(少用)
  //    severity,   覆盖表里的级别(少用，破坏一致性)
  //    onConfirm / onCancel / confirm / cancel   —— L3 用
  //    silent,     true = 只写日志不弹卡
  //  })
  function report(code, opts) {
    opts = opts || {};
    const key = String(code || 'UNKNOWN').toUpperCase();
    const def = CATALOG[key] || CATALOG.UNKNOWN;
    const severity = String(opts.severity || def.severity || 'L2').toUpperCase();
    const message = String(opts.message || '').trim();
    const title = String(opts.title || def.title || '出了点问题');

    // 日志永远写，成功失败都写(CLAUDE.md 排查纪律：只打失败的日志会骗人)
    writeLog('[' + severity + '] ' + title + (message ? '：' + message : '') + ' (' + key + ')',
      def.level === 'err' ? 'error' : def.level === 'warn' ? 'warn' : 'info');

    // ⚠ 遥测放在抑制判断【之前】—— 要的是"真实发生多少次"。
    //   被抑制的重复项恰恰是最该统计的：同一错误反复出现 = 用户卡住了。
    //   这里只上报 code + 步骤 + 洗过的短消息；完整原文留在本机，
    //   用户想给客服看时用 V7Telemetry.ticketAttachment 手动附带。
    try {
      if (window.V7Telemetry) {
        window.V7Telemetry.error(key, {
          // opts.where：只给遥测看的出错位置（文件:行 / 错误码），不上报错卡（卡上会显示成「阶段 …」）
          stage: opts.stage || opts.where,
          message: message,
          category: opts.category,
          // ⭐ 2026-10-20：带上报错表里定的级别 —— 「提示」（info）不再被遥测当成错误统计（docs/256 第四节①）
          level: def.level
        });
      }
    } catch (_) { /* 遥测绝不能影响报错本身 */ }

    if (opts.silent) return null;

    const times = shouldSuppress(key, message);
    if (times > 1) {
      // 抑制掉的也要留痕，否则"只弹了一张卡"会被误读成"只发生了一次"
      writeLog('同样的问题第 ' + times + ' 次发生，已合并(不再重复弹卡)', 'warn');
      return null;
    }

    if (!window.UI) { writeLog('报错系统还没就绪，这条只进了日志', 'warn'); return null; }

    const payload = {
      title: title,
      body: message || def.advice || '',
      detail: buildDetail(def, Object.assign({}, opts, { code: key })),
      level: def.level || 'err',
      // 2026-10-18 深夜：报错卡上的「反馈这个问题」要带错误码（ui.html addErrorCard）
      code: key
    };
    // Follow the same card route as manual navigation, without editing a value
    // or replacing a caller's recovery/retry action.
    const target=severity==='L2'&&!opts.onConfirm&&window.V7CardRoutes?.errorTarget?.(key);
    if(target)opts=Object.assign({},opts,{confirm:opts.confirm||'定位到设置',onConfirm:target});

    if (severity === 'L1') return window.UI.toast(title, def.level || 'info', opts.duration || 3000);
    if (severity === 'L3') {
      return window.UI.dialog(Object.assign(payload, {
        confirm: opts.confirm || '知道了',
        cancel: opts.cancel || '取消',
        danger: !!opts.danger,
        onConfirm: opts.onConfirm,
        onCancel: opts.onCancel,
        safeClear: opts.safeClear   // 2026-10-18 深夜：垃圾桶一键清时怎么处理
      }));
    }
    if (severity === 'L4') {
      return window.UI.block(Object.assign(payload, {
        action: opts.confirm || '立即处理',
        onAction: opts.onConfirm
      }));
    }
    // ⚠ 2026-10-06 晚：L2 也要能带"取消"和"立刻摊开详情"（引擎离线那种动作卡）。
    //   只用 Object.assign 塞 cancel:undefined 会踩 addErrorCard 的 `o.cancel!==false`
    //   —— 每张 L2 都会长出一个"取消"按钮。所以【有才塞】。
    const extra = {
      confirm: opts.confirm || '知道了',
      onConfirm: opts.onConfirm
    };
    if (opts.cancel !== undefined) { extra.cancel = opts.cancel; extra.onCancel = opts.onCancel; }
    if (opts.expand) extra.expand = true;
    // ⭐ 2026-10-15：钉顶 + 自定义按钮（「连不上服务器」那张卡要钉在最顶、带"重试"）。有才塞。
    if (opts.pin) extra.pin = opts.pin;
    if (Array.isArray(opts.actions)) extra.actions = opts.actions;
    if (opts.safeClear) extra.safeClear = opts.safeClear;   // 2026-10-18 深夜：垃圾桶一键清时怎么处理（confirm / cancel / none）
    if (opts.persistent) extra.persistent = true;           // 2026-10-24：关不掉的常驻卡（插件需要更新），事情解决后调用方 close()
    // ⭐ 2026-10-22（docs/263 §2「报错卡上没有重试」）：能重试的错就把重试按钮带上。
    //   调用方写 ERR.report('XXX', { retry: () => 再做一次 }) 就行；不传照旧只有「知道了」。
    if (typeof opts.retry === 'function') { extra.retry = opts.retry; if (opts.retryLabel) extra.retryLabel = opts.retryLabel; }
    return window.UI.notice(Object.assign(payload, extra));
  }

  // ── 从 UXP 回执直接报 ──
  //   UXP 给的是 { success, action, error:{ code, message, raw } }。
  //   ⚠ 以前 linkResultMessage 只取 message，code 和 raw 全丢了 ——
  //     那正是"看不出为什么失败"的根源。这里三样全用上。
  function fromLinkResult(result, extra) {
    const err = (result && result.error) || {};
    const code = err.code || 'UXP_ACTION_FAILED';
    // err.scene 是 Photoshop 那边 ps-actions 的 run() 统一附上的文档现场。
    // 直接铺进"当时的情况"，用户不用再切回 PS 自己查文档是什么格式。
    const scene = (err.scene && typeof err.scene === 'object') ? err.scene : {};
    return report(code, Object.assign({}, extra || {}, {
      message: err.message || '执行失败',
      raw: err.raw,
      stage: (extra && extra.stage) || 'capture',
      context: Object.assign({}, scene, {
        '操作': (result && result.action) || ''
      }, (extra && extra.context) || {})
    }));
  }

  // ── 生成失败专用：先探测，再定性 ──
  //   为什么要单独开一个：`Failed to fetch` 这一个字符串背后是两种完全不同的病，
  //   不探测就只能写"网络错误"这种废话。
  async function reportGenerateFailure(error, extra) {
    const message = String((error && error.message) || error || '生成失败');
    const url = (extra && extra.url) || '';
    const isFetchFailure = /failed to fetch|networkerror|load failed|fetch failed/i.test(message);

    // ⭐ 服务器明确回了状态码 —— 这是【最有价值】的一种失败，它自己说了为什么。
    //   2026-09-11 之前这条路走不通：Tauri 壳在界面里 fetch，跨域规则把响应连同
    //   状态码一起吞了，我们永远只能看到 Failed to fetch。现在请求走 Rust，能拿到原话。
    const status = Number((error && error.httpStatus) || (extra && extra.httpStatus) || 0);
    if (status > 0) {
      const serverBody = String((error && error.serverBody) || '').trim();
      // 413 = Payload Too Large。有些服务不按规矩来，用 400 + "too large" 说同一件事，
      // 所以正文里出现 large/size/exceed 也按"图太大"归类。
      const saysTooLarge = status === 413
        || /too\s*large|payload.*large|exceed.*size|image.*too\s*big|request entity/i.test(serverBody);
      const ctx = Object.assign({
        'HTTP 状态': status + (STATUS_HINT[status] ? '（' + STATUS_HINT[status] + '）' : '')
      }, (extra && extra.context) || {});
      // ⭐ 2026-10-24（查生产库反馈 806542d8）：墨墨回 503 + model_not_found「No available channel for model …」
      //   = 服务商那边这个模型现在【没有可用通道】，不是上游出图超时。原来一律报「出图超时、稍等再试」，等多久都没用。
      const noChannel = !saysTooLarge && /model_not_found|no available channel/i.test(serverBody);
      const upstream = !saysTooLarge && !noChannel && [502, 503, 504].includes(status);
      return report(saysTooLarge ? 'AI_IMAGE_TOO_LARGE' : noChannel ? 'AI_MODEL_NO_CHANNEL' : upstream ? 'AI_UPSTREAM_TIMEOUT' : 'AI_HTTP_ERROR',
        Object.assign({}, extra, {
          message: message,
          // 服务器原文整段给出来。⚠ 不要截太短：真正的原因经常藏在后半句。
          raw: serverBody ? ('服务器原话：\n' + serverBody.slice(0, 2000)) : '',
          context: ctx
        }));
    }

    if (isFetchFailure && url) {
      const probe = await probeEndpoint(url);
      const code = verdictToCode(probe.verdict);
      return report(code, Object.assign({}, extra, {
        message: message,
        raw: verdictText(probe),
        context: Object.assign({
          '服务器': probe.origin,
          '探测结果': probe.verdict === 'REACHABLE' ? '能连上' : probe.verdict === 'TIMEOUT' ? '超时无响应' : '连不上',
          '探测耗时': probe.ms + 'ms'
        }, (extra && extra.context) || {})
      }));
    }
    return report((extra && extra.code) || (error && error.code) || 'AI_REQUEST_FAILED',
      Object.assign({}, extra, { message: message, raw: error && error.stack }));
  }

  // ═══════════════════════════════════════════════════════════
  //  全局兜底
  //
  //  ⚠ 以前【完全没有】。脚本抛个错就静静地死在 console 里，
  //    用户只看到"按钮没反应"——CLAUDE.md 铁律 17 说的"静默失效"，
  //    本项目最常见的故障形态，以前查它全靠人肉读源码。
  // ═══════════════════════════════════════════════════════════
  // 报错系统自己还没就绪时的最后一道防线。
  // ⚠ 不能依赖 window.UI —— 主脚本第一行就炸的话，UI 根本不存在，
  //   那时候用户看到的是一个白板窗口，没有任何提示。这种情况必须有东西能显示出来。
  function rawFallbackBanner(title, detail) {
    try {
      if (document.getElementById('errBootFallback')) return;
      const box = document.createElement('div');
      box.id = 'errBootFallback';
      box.style.cssText = 'position:fixed;left:50%;top:40px;transform:translateX(-50%);z-index:calc(var(--z-top,99998) + 1);'
        + 'max-width:620px;padding:16px 20px;border-radius:12px;background:rgba(32,10,10,.96);'
        + 'color:#ffd9d9;font:13px/1.7 "Microsoft YaHei",sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);'
        + 'border:1px solid rgba(255,120,120,.45);white-space:pre-wrap;';
      box.textContent = '✕ ' + title + '\n\n' + (detail || '');
      (document.body || document.documentElement).appendChild(box);
    } catch (_) {}
  }

  // ── 启动自检 ──
  //   CLAUDE.md 铁律 17：「语法通过 + 编译通过 + 启动无报错」≠ 能用。
  //   主脚本中途抛错死掉时，后面的绑定全都没跑，界面看着正常但一按就没反应。
  //   以前查这个全靠人肉在末尾插 debug_log。现在自动化：
  //   ui.html 跑到最后一行会调 markBootOk()，没调到就说明半路死了。
  let bootOk = false;
  function markBootOk() { bootOk = true; }
  function startBootWatchdog(ms) {
    setTimeout(function () {
      if (bootOk) return;
      const detail = '界面的主脚本没有执行到最后一行，说明它在启动过程中就出错了。\n'
        + '现在大部分按钮可能是死的（点了没反应、卡片拖不动）。\n\n'
        + '请重启桌面板。如果重启后还是这样，把这个提示和终端里的报错截图给开发。';
      if (window.UI) report('UI_BOOT_INCOMPLETE', { message: '主脚本未执行到结尾', raw: detail });
      else rawFallbackBanner('桌面板没有正常启动', detail);
    }, ms || 6000);
  }

  // 全局兜底报错的出错位置，给遥测用。⚠ 上报时中文会被抹掉、完整地址会被洗成 <url>，
  //   只剩「<中文>」根本查不出是哪段代码（10-21 查 1.9.5 的 5 次 UI_PROMISE_REJECTION 就卡在这）。
  //   所以只取纯英文数字：错误码 + 第一个 .js 文件名:行号。
  function errorWhere(error, filename, line) {
    const parts = [];
    if (error && typeof error.code === 'string' && /^[A-Z0-9_]{2,60}$/.test(error.code)) parts.push(error.code);
    const frame = String((error && error.stack) || '').match(/([\w.-]+\.(?:js|html)):(\d+):\d+/);
    if (frame) parts.push(frame[1] + ':' + frame[2]);
    else if (filename) parts.push(String(filename).split(/[\\/]/).pop().replace(/[?#].*$/, '') + (line ? ':' + line : ''));
    return parts.join(' @ ');
  }

  function installGlobalHandlers() {
    window.addEventListener('error', function (e) {
      // 资源加载失败(图片/脚本 404)也走这里，但那些不该打扰用户
      if (e && e.target && e.target !== window && e.target.tagName) return;
      report('UI_SCRIPT_ERROR', {
        message: (e && e.message) || '未知脚本错误',
        raw: e && e.error && e.error.stack,
        where: errorWhere(e && e.error, e && e.filename, e && e.lineno),
        context: {
          '文件': e && e.filename ? String(e.filename).split('/').pop() : '',
          '位置': e && e.lineno ? ('第 ' + e.lineno + ' 行 第 ' + e.colno + ' 列') : ''
        }
      });
    });

    window.addEventListener('unhandledrejection', function (e) {
      const reason = e && e.reason;
      report('UI_PROMISE_REJECTION', {
        message: (reason && reason.message) || String(reason || '未知错误'),
        raw: reason && reason.stack,
        where: errorWhere(reason)
      });
    });
  }

  // ── 后端不可达提示条 ──
  //   ⭐ 2026-10-09（docs/195 §1）：后端地址改成线上之后必须有这个。
  //     理由：默认地址从"本机"变成"公网服务器"之后，服务器挂了 / 用户断网，
  //     软件会照样打开（本机功能都能用），但账号/积分/平台算力全废。
  //     如果什么都不提示，用户看到的是"按钮点了没反应" —— 铁律 17 说的静默失效。
  //
  //   ⚠ 跟 rawFallbackBanner 的分工：那个是"界面根本没起来"的最后防线（只会出现一次、不可关）；
  //     这个是"界面起来了但服务器连不上"，**可以重试、可以关掉**，不该堵住用户干活。
  //   ⚠ 单例：重复调用只更新内容，不叠出一堆条（不然断网久了会糊满屏幕）。
  let backendBannerEl = null;
  function backendBanner(title, detail, onRetry) {
    try {
      if (!document.body) return;
      if (backendBannerEl && !backendBannerEl.isConnected) backendBannerEl = null;
      if (!backendBannerEl) {
        const box = document.createElement('div');
        box.id = 'errBackendBanner';
        // 样式跟 rawFallbackBanner 同源（同色系、同圆角），但更矮、更靠上、能关
        box.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:var(--z-top,99998);'
          + 'max-width:640px;padding:12px 16px;border-radius:12px;background:rgba(40,26,10,.97);'
          + 'color:#ffe6c2;font:12.5px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.55);'
          + 'border:1px solid rgba(255,180,90,.45);display:flex;gap:10px;align-items:flex-start;';
        const text = document.createElement('div');
        text.style.cssText = 'white-space:pre-wrap;flex:1;min-width:0;';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试';
        retry.style.cssText = 'flex:none;padding:5px 12px;border-radius:8px;cursor:pointer;'
          + 'border:1px solid rgba(255,190,110,.55);background:rgba(255,190,110,.18);color:#ffe6c2;'
          + 'font:12px "Microsoft YaHei",sans-serif;';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', '关掉这条提示');
        close.style.cssText = 'flex:none;width:22px;height:22px;line-height:1;border-radius:8px;cursor:pointer;'
          + 'border:1px solid rgba(255,190,110,.4);background:transparent;color:#ffe6c2;font-size:13px;';
        close.onclick = () => { try { box.remove(); } catch (_) {} backendBannerEl = null; };
        box.append(text, retry, close);
        (document.body || document.documentElement).appendChild(box);
        backendBannerEl = box;
        box._text = text;
        box._retry = retry;
        retry.onclick = async () => {
          // ⚠ 重试期间禁用按钮：不然用户连点会叠出一堆探测请求
          retry.disabled = true;
          const old = retry.textContent;
          retry.textContent = '检查中…';
          try { await (typeof onRetry === 'function' ? onRetry() : null); }
          finally { retry.disabled = false; retry.textContent = old; }
        };
      }
      backendBannerEl._text.textContent = '⚠ ' + title + (detail ? ('\n' + detail) : '');
      return true;
    } catch (_) { return false; }
  }
  function backendBannerClear() {
    try {
      if (backendBannerEl) { backendBannerEl.remove(); backendBannerEl = null; }
    } catch (_) {}
  }

  // ═══ 缓存写不进去（2026-10-24，V7待办/06）═══════════════════════
  //   反馈 #3「每次都无法缓存」：原来每写失败一次就弹一张卡，消息里带每次不同的路径，去重也去不掉。
  //   现在：外壳回 kind（denied 被拦 / locked 被占用 / full 磁盘满 / missing 文件没了 / other），
  //   按 kind 给人话和按钮；【同一种原因一次运行只弹一张卡】，后面的只进日志 + 遥测（遥测带 kind）。
  const CACHE_KIND_TEXT = {
    denied: { why: '缓存文件夹被拦了：多半是杀毒软件（火绒 / 360 / Defender）在扫描刚写的文件，或者这个位置没有写入权限。', next: '把缓存文件夹加进杀毒软件的信任区；或者到设置里把缓存位置换到别的盘。' },
    locked: { why: '缓存文件正被别的程序占用（多半是杀毒软件在扫描），稍等重试了 5 次还是没放开。', next: '把缓存文件夹加进杀毒软件的信任区。' },
    full: { why: '缓存所在的磁盘满了。', next: '清理这块磁盘，或者到设置里把缓存位置换到空间大的盘、调小缓存上限。' },
    missing: { why: '要存的文件或文件夹已经不在了（被挪走或删掉了）。', next: '一般不影响下次生成；反复出现请把详情发给我们。' },
    other: { why: '写入缓存失败。', next: '检查缓存所在磁盘的空间和写入权限。' }
  };
  const cacheKindShown = new Set();
  function cacheFailure(code, info) {
    info = info || {};
    const raw = String(info.error || info.message || '');
    const kind = CACHE_KIND_TEXT[info.kind] ? info.kind : (/os error 5\b|拒绝访问|denied/i.test(raw) ? 'denied' : /os error (112|39)\b|空间不足/.test(raw) ? 'full' : /os error 3[23]\b/.test(raw) ? 'locked' : /could not be read|os error [23]\b/.test(raw) ? 'missing' : 'other');
    const text = CACHE_KIND_TEXT[kind];
    const onceKey = String(code) + ':' + kind;
    const first = !cacheKindShown.has(onceKey);
    cacheKindShown.add(onceKey);
    // ⭐ 10-25（docs/286 P0-3）：遥测只收得到这里的 stage + 洗过的 message（中文全打码成 <中文>）⇒ 原来只剩「cache:other」，看不出到底是什么错。
    //   补一段英文特征：错误码 / 系统错误号 / 缓存是不是放在网盘同步目录里（只是特征，不带路径原文）
    const sig = String(info.code || (raw.match(/os error \d+/) || [])[0] || (raw.match(/\b[A-Z][A-Z0-9_]{4,}\b/) || [])[0] || '').replace(/\s+/g, '');
    const synced = /onedrive|dropbox|baidunetdisk|百度网盘|nutstore|坚果云|icloud|google ?drive|wps ?cloud/i.test(String(info.path || '')) ? ':sync' : '';
    const opts = {
      message: text.why + ' ' + text.next,
      stage: 'cache:' + kind + (sig ? ':' + sig : '') + synced,
      raw: raw,
      context: Object.assign({ '原因': kind, '原文': raw }, info.path ? { '位置': String(info.path) } : {}, info.context || {}),
      silent: !first
    };
    if (first && kind !== 'missing') {
      opts.actions = [
        { key: 'open-cache', label: '打开缓存文件夹', run: function () { try { const c = window.uiwin && window.uiwin.cache; if (c && c.openFolder) c.openFolder('', ''); } catch (_) {} } },
        { key: 'cache-settings', label: '去改缓存位置', run: function () { try { window.V7CardRoutes && window.V7CardRoutes.open('settings', 0, { section: 'cache', highlight: '[data-cache-root]' }); } catch (_) {} } }
      ];
    }
    if (!first) writeLog('缓存写入又失败了一次（' + kind + '）：' + raw + '。同一种原因这次运行只弹一张卡。', 'warn');
    return report(code, opts);
  }

  window.ERR = {
    report: report,
    cacheFailure: cacheFailure,
    fromLinkResult: fromLinkResult,
    reportGenerateFailure: reportGenerateFailure,
    probeEndpoint: probeEndpoint,
    backendBanner: backendBanner,
    backendBannerClear: backendBannerClear,
    setLogSink: function (fn) { logSink = typeof fn === 'function' ? fn : null; },
    installGlobalHandlers: installGlobalHandlers,
    markBootOk: markBootOk,
    // 阶段中文名。任务卡失败时只显示"失败 · 抓取"这种短状态，
    // 具体原因去报错卡看 —— 两边用同一份表，不各写各的。
    stageLabel: function (stage) { return STAGE_LABEL[stage] || ''; },
    catalog: CATALOG,
    // 运行时补一个错误码(给以后的新功能用，不用改这个文件)
    register: function (code, def) { if (code && def) CATALOG[String(code).toUpperCase()] = def; },
    // 给自检用：确认表没被改坏
    selfCheck: function () {
      const bad = [];
      Object.keys(CATALOG).forEach(k => {
        const d = CATALOG[k];
        if (!d.severity || ['L1', 'L2', 'L3', 'L4'].indexOf(d.severity) < 0) bad.push(k + ' 级别不对');
        if (k !== 'AI_PARTIAL_FAILED' && !d.title) bad.push(k + ' 缺标题');
      });
      return { total: Object.keys(CATALOG).length, bad: bad };
    }
  };

  // ⚠ 立刻自己装上，不等 ui.html 来调。
  //   要是等业务代码调用，而业务代码正好在那之前就炸了，
  //   兜底就永远装不上 —— 恰恰是最需要它的那种情况。
  installGlobalHandlers();
  startBootWatchdog(6000);
})();
