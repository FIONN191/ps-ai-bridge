// ═══ ui-main/10-settings-runtime.js —— 主界面主程序第 10 / 21 段 ═══
//   管什么：正式设置运行时（设置先存本地，生成卡只读确认过的）· 配色接线
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ── 正式设置运行时：设置先在本地保存，生成卡只读取这里的已确认配置 ──
const SETTINGS_KEY='v7.settings.v1';
function settingsStorageKey(){
  return window.WHEELCHAIR_STORAGE
    ? window.WHEELCHAIR_STORAGE.key(SETTINGS_KEY) : SETTINGS_KEY;
}
// ⚠ 这里【只放真正被消费的键】。2026-09-08 清掉了 26 个"能存但不生效"的占位
//   (原来 41 个里 63% 是占位)。理由和完整清单见 docs/22_占位清理记录.md。
//   铁律: 设置项要么真接线，要么别出现 —— 能存不生效的开关比没有更坏，
//   用户会以为自己调过了。色彩稳定曾被错接成抗截断的暗闸，就是这么来的。
//   老用户 localStorage 里残留的键会被 settingsLoad 自动忽略(只认这里有的键)。
// ⭐⭐⭐ 2026-10-08（docs/170 §4.2）：读校色方式的【唯一出口】。
//   ⚠ 为什么要收敛成一个函数：原来 autoColorMatch 被读了 3 处（生成闸门 /
//     引擎调用 / 对齐闸门），四态之后每处各写一遍判断必然漂移 —— 本项目老坑。
//   ⚠ 兼容旧存档：autoColorMatch === false 视为 'off'（迁移只在读的时候兜底，
//     不改用户文件 —— 免得两个地方都写迁移逻辑、早晚不一致）。
//   返回 'off' | 'global' | 'precise' | 'hybrid'
function wantColorMode(){
const v = settingsRuntime.colorMatchMode;
if(v === 'off' || v === 'global' || v === 'precise' || v === 'hybrid') return v;
// 旧存档：只有布尔 autoColorMatch
if(settingsRuntime.autoColorMatch === false) return 'off';
// ⭐ 2026-10-19（docs/251 第 7 条①）：默认不校色
return 'off';
}
// 老代码里那些 `settingsRuntime.autoColorMatch!==false` 一律换成本函数。
//   校色错了顶多颜色不对，对齐错了会把整张图扭变形 —— 后者严重得多。
const settingsRuntime={
  freeMode:false,
  // ⭐⭐⭐ 2026-10-09（docs/195 §1，用户定案）：
  //   「后端地址默认值永远写死 www.xiasanqi.com」
  //   ⇒ 默认值从本机开发地址 `http://127.0.0.1:37900` 改成正式线上地址。
  //   ⚠ 必须带 https：实测 http://xiasanqi.com 会 301 跳转，
  //     而 tauri.localhost 这个页面上 http 请求还可能被判混合内容。
  //     证书实测有效（curl ssl_verify_result=0），www 与裸域同一张证书。
  //   ⚠⚠ 这个值只影响【新装 / 从没存过设置的人】——
  //     settingsLoad() 里存过的值会覆盖它（见本文件 settingsLoad）。
  //     用户已确认：老用户升级后被登出一次、重新登录，可以接受。
  //   ⚠ 服务器不可达时的表现见 networkStatusTick()（不能白屏，要能提示）。
  backendUrl:'https://www.xiasanqi.com',
  imageComputeSource:'own',workflowSource:'platform',workflowSourceChosen:false,qwenMode:false,qwenSource:'platform',
  // ⭐ 2026-10-18 云端外挂（docs/237）：外挂能力卡左上角那个开关。Chosen=false 表示「用户没自己选过」——
  //   那时按这台电脑有没有本机引擎来定（没有 → 默认开云端；不带模型的包就是这种）。见 cloudToolsConfigure。
  cloudToolsMode:false,cloudToolsModeChosen:false,
  comfyUrl:'http://127.0.0.1:8188',comfyKey:'',runninghubUrl:'https://www.runninghub.cn',runninghubKey:'',rhWorkflowId:'',rhWorkflowName:'',
  // ⚠ 2026-10-07 新增：余额不足提醒线（美元）。0 = 不提醒（用户定："用户自己填数字"）。
  lowBalanceUSD:0,
  // ⭐ 2026-10-24（V7待办/02，用户定「默认竞速」）：阿吉 / 墨墨的地址怎么来 —— 'auto' 自动选线（provider-lines.js 测出来的）/
  //   'manual' 用下面自己填的 ajiUrl / momoUrl。空 = 还没迁移过（settingsMigrateLineMode 定），按 auto 算。lineModeV1 = 迁移做过没有。
  ajiLineMode:'',momoLineMode:'',lineModeV1:false,
  connectionsVersion:0,provider:'aji',otherConnection:'custom',ajiUrl:'',ajiKey:'',ajiProtocol:'',ajiAuthMode:'',momoUrl:'',momoKey:'',momoProtocol:'',momoAuthMode:'',grsUrl:'',grsKey:'',grsProtocol:'',grsAuthMode:'',grsMode:'',otherUrl:'',otherKey:'',otherProtocol:'',otherAuthMode:'',
  // ⭐ 2026-10-21（用户要求，V6 有）：自定义渠道存多套方案（ui-pure/other-profiles.js）。
  //   当前在用的那套照旧在上面 otherUrl/otherKey/otherProtocol/otherAuthMode 里；这三个只存「其他几套」。
  //   otherProfileKeys 是 Key，进安全存储（SECRET_SETTING_KEYS），不落明文。
  otherProfiles:[],otherProfileActive:'',otherProfileKeys:'',
  // ⭐ 2026-10-21（用户要求，照 V6 算力槽位）：渠道显示名 + 每个渠道露出哪些模型 / 模型显示名（ui-pure/compute-slots.js）。
  //   只改显示：渠道真实取值、模型真实 id 都不变。跟账号走。
  computeSlotNames:{},computeModelPrefs:{},
  // 2026-10-21：渠道排序（服务商下拉 + 快捷键轮换的顺序；空 = 默认 阿吉 / 墨墨 / GRS / 自定义）。跟账号走
  computeSlotOrder:[],
  // ⭐ 贴回时的边缘羽化（2026-09-13 接线）。治的是选区边界上那条【笔直的接缝】——
  //   "处理过 vs 没处理过"的硬分界线。对齐和校色都治不了它（既不是位置问题
  //   也不是颜色问题，是【边界本身太硬】），只能靠给贴回的图层加一张
  //   "往里收一点 + 边缘模糊"的蒙版，让 AI 图和周围原图渐变过渡。
  //
  // ⚠⚠ 这两个百分比是【占选区短边】的，不是占整张图。
  //   选区 1220×1736 → 短边 1220 → 内缩 1% = 12px、模糊 1.5% = 18px。
  //   ⚠ V6 的默认是 10%/8%，对人脸精修这种尺寸【太狠了】(122px/98px)，
  //     所以这里没照抄，取的是"够软化 1px 硬线、又不明显吃掉内容"的保守值。
  //   ⚠ **这两个数没有实测依据**，是估的起点 —— 接缝还看得见就往上调。
  returnFeather:true,
  returnFeatherShrink:'1',
  returnFeatherBlur:'1.5',
  layerType:'smartObject',maxResolution:'2K',autoReturn:false,autoFullCanvas:false,
  // Opt-in. The first checkpoint is eligible five minutes after enabling;
  // subsequent ones are made on the next generation, never by a background timer.
  checkpointEnabled:false,cacheCapacityGB:20,
  // ⭐ 自动检查点间隔（2026-09-30 记录与恢复卡）。单位【分钟】，1–60。
  //   ⚠ 只在「真有生成」且距上一份够久时才存一份，不是后台定时器 —— 这点没变。
  //   默认 5 分钟 = 改造前写死的那个值，老用户升级后行为一样。
  checkpointIntervalMin:5,
  // ⭐ 从 Photoshop 抓多大的图(长边像素)。2026-09-11 加，默认 2048。
  //
  // ⚠ 别和上面那个 maxResolution 搞混：那个管【生成出来多大】(1K/2K/4K 输出尺寸)，
  //   这个管【喂进去多大】。两个是两回事，以前只有前者，后者被写死成 4096。
  //
  // 为什么默认 2048：抓图导出的 PNG 是【不压缩】的(ps-pixels.js 是 store 模式)，
  //   体积 ≈ 像素数，转 base64 再 ×4/3，所以尺寸和体积是死的对应关系：
  //     1024 → 4.0MB    2048 → 16.0MB    3072 → 36.0MB    4096 → 64.0MB
  //   2026-09-11 实测：4096 发给 AI 服务器直接被退回
  //   「Request image too large: 64.0MB exceeds the 10MB limit」。
  //   V6 这个值默认就是 2048(V6 index.js: g_maxResolution = 2048)，
  //   是 V8 当初写死成 4096 才天天撞上限 —— 这次是把 V6 的默认值和可调性一起补回来。
  captureMaxEdge:'2048',
  // ⭐ 10-25（用户定）：带参考图时，图 1 和参考图都补成正方形再发，回图裁回原尺寸（ref-square-pad.js）。默认开。
  refSquarePad:true,
  // ⭐ 自动校色 / 对齐(2026-09-11)。AI 返回的图在【存进图片管家之前】就处理完，
  //   所以预览看到的和贴回 Photoshop 的是同一份已处理内容，不用改两处。
  //   算法在 ui-pure/color-match.js，纯 CPU 无依赖(档 1)。
  // ⭐⭐⭐ 2026-10-08（docs/170 §4.2）：校色方式四选一。
  //   'off' 不校色 / 'global' 全局 / 'precise' 精准 / 'hybrid' 混合
  //   ⭐ 2026-10-19（docs/251 第 7 条①，用户定「默认不校色，只有用户去切换时才校色」）：默认改成 'off'。
  //     出图时只对齐、不校色；想看校色的到任务卡小眼睛里选（选了才现算）。老用户存过「混合」的一次性改成不校色（settingsMigrateColorDefaultOff）。
  //   ⚠ 铁律 16：这个键在【档 1 和引擎档都必须真生效】——
  //     以前档 1 写死走混合，等于「设置里有、实际不生效」。
  colorMatchMode:'off',
  // 「老用户的混合一次性改成不校色」做过没有（只改一次，之后用户自己再选的照常保留）
  colorDefaultOffV1:false,
  // ⚠ 兼容键（只读，代码不再读它）：老设置文件里存的是布尔 autoColorMatch。
  //   迁移见 settingsMigrateColorMode()：false → 'off'，其余 → 'hybrid'。
  //   留着它免得旧文件被当成「没设置过」。
  // ⚠⚠⚠ 2026-10-05：colorMatchMethod【已删】——
  //   用户拍板"把之前的校色算法全都干飞掉"，主链路只有【混合判据】一条路。
  //   引擎那边也只剩 color_hybrid（旧的两个函数留给实验台做对照基准线）。
  //   ⚠ 老设置文件里存的 colorMatchMethod 会被忽略（settingsRuntime 里没有这个键，
  //     settingsReadFields 遍历的是 settingsRuntime 的键，读不到就跳过）。
  autoAlign:true,
  // ⭐ 对齐方式(2026-09-12)。'mesh' 网格变形 / 'flow' 稠密光流 / 'off' 不对齐
  //
  //   ⚠⚠ 默认 mesh 不是 flow，这是用实测换来的：
  //     稠密光流每像素一个位移，**分不清"重采样漂移"和"AI 的有意修改"**。
  //     用户 2026-09-12 实测：修脸时 AI 瘦下去的脸、放大的眼睛被全部扭回原样。
  //     网格变形只有 10×10 个控制点且必须连续 —— 它【扭不动】局部改动，
  //     低自由度本身就是安全阀，比任何阈值判据都可靠。
  alignMode:'mesh',
  // ⭐ 细节补偿：用原图的高频补回重采样损失的锐度。
  //   它只补细节不改形状 —— 形状(低频)来自 AI 图，细节(高频)来自原图。
  //
  // ⚠⚠ 2026-09-12 起【默认关闭】（用户决定）。原来默认是 true。
  //
  //   实测（cache/X37_0100.NEF/20260912-181810-12，4 张回图取平均）：
  //     放大后原图(能追到的上限) 16.41 · AI 原样 13.04 · 只对齐 12.86
  //     老默认值(自动半径+降噪开+强度1.0) → **11.93**，比不补还糊。
  //
  //   三个原因叠加：① AI 把图放大 1.33 倍返回，原料先天打折
  //   ② 光流搬运又插值一次 ③ 抠细节前那道降噪把原图纹理先削了。
  //
  //   ⚠ 最阴的是旧指标看不出来：「与原图差异」那个数反而从 3.52 降到 3.23,
  //     看着像变好了。差异小在这里不等于好 —— 见 docs/39 的 3.3。
  //
  //   现在的参数（半径15/强度1.5/门槛0.20/不降噪，在 match-engine.js 里）
  //   能跑到 15.03，是正收益；但要不要默认开着，等剪切蒙版那套档位做完再说。
  detailBoost:false,
  detailStrength:'150',
  // ⭐ 传回 PS 后自动补细节（2026-09-12，用户定案）。
  //   'off' 不自动（默认）/ 'replace' 细节还原档 / 'gain' 轻微增强档
  //   ⚠ 默认 off 是有理由的：一批 18 张要串行跑十几秒，而实际上
  //     大部分人只会挑一两张满意的来补 —— 那用缩略图上那两个按钮就够了。
  //   ⚠ 开了也【不会】覆盖那两个按钮：一次性动作必须留常驻入口，
  //     自动补完之后照样能手动换档位。
  autoDetailTier:'off',
  // 处理档位上限。'3'=有引擎就用最好的、没有自动回落档 1(默认，不用操心)；
  // '1'=强制只用本地算法，不去探测引擎(引擎有问题时可以用它排除干扰)。
  matchTier:'3',
  // ⭐ 调试模式(2026-09-12)。开了之后，运行过程中的关键状态
  //   （抓取/生成/校色调度/进度/用了哪档/耗时）都会以 L1 胶囊弹在报错堆里。
  //   ⚠ 默认关：正常使用时这些信息只会碍事。它是【排查工具】不是功能。
  debugMode:false,
  // ⚠⚠ Phase F（用户 2026-10-06 拍板）：【所有引擎开机都不自启，只能手动开】。
  //   这两个键保留只为兼容旧存档（老设置文件里可能还存着 true），
  //   **代码里已经不再读它们**，界面上的两个开关也已删除。
  //   引擎的启动入口 = 外挂能力卡 · 配置信息（两台各一行）+ 能力块里那一行。
  engineAutoStart:false,
  engineAutoStartMatting:false,
  // 自动编组：默认【开】。它是"划到哪张就在 PS 里显示哪张"的前置，
  // 默认关的话用户根本发现不了有这个功能。
  autoGroup:true,
  // 划缩略图联动时，如果那张图属于别的 Photoshop 文档，要不要自动切过去。
  // 默认开(用户 2026-09-09 决定)；关掉的话跨文档时就什么都不做，不打断当前工作。
  soloSwitchDocument:true,
  // 划缩略图联动时，是否聚焦到图层位置（缩放视口让图层填满画面）。
  // 默认开 —— 类似 PS 里 Alt+点击图层的行为，直接跳到那个图层所在区域。
  soloFocusRegion:true,
  // ⭐ 盖印后自动收起任务卡(2026-09-14 用户要求)。默认【开】—— 这是用户主动要的功能。
  //   ⚠ 它依赖「自动编组」：没有组就没有判定基准，关了自动编组这个功能自然不生效。
  autoDismissOnStamp:true,
  // ══════════════════════════════════════════════════════════════
  // ⭐⭐ 2026-10-11（用户要求）：传回的组给 PS 标注色 + 完成音效。两个都照 V6 搬。
  //
  // 【组颜色】V6 是写死的 —— 轮椅 4.0 → 6.4.6 八个版本的
  //   host/ps-io.js 里都是同一句 { color:{_enum:'color',_value:'yellowColor'} }。
  //   V7 把它做成可设。⚠ 只能选 Photoshop 自己那 9 个固定色（DOM API 没这个属性，
  //   只能走 batchPlay；社区从 2020 年申请自定义色，Adobe 没做）。
  //   默认 'none' = 不给颜色（用户 2026-10-11 定："不设置颜色，默认就是没有颜色"）。
  returnGroupColor:'none',
  // 【音效】照 V6 的三位结构（sound.success / allFail / singleFail）。
  //   ⚠ 默认值跟用户 2026-10-11 的要求一致：【默认不启用，用户自己去开】。
  //     （V6 是默认开，这里跟 V6 不同 —— 用户明确要求默认关。）
  soundEnabled:false,
  // 三个音效位。'' = 还没设过，读的时候回落到 DEFAULT_SOUNDS 里的默认值。
  // ⚠ V6 的默认：成功='三七唐笑'、全部失败='none'、单个失败='none'。
  soundSuccess:'',
  soundAllFail:'',
  soundSingleFail:'',
  // 音量（2026-10-15 用户要求）：三个音效共用一个，0~100。'100' = 跟以前一样响。
  soundVolume:'100',
  blur:'24',opacity:'100',
  // ══ 配色（2026-09-14 用户要求：一次调所有卡片）══
  // ⚠ 空串 = 跟默认，不覆盖。这样"没设过"和"设成了黑色"能区分开 ——
  //   用 '#000000' 当默认的话，用户永远没法退回项目原本的配色。
  themeCardBg:'',      // 卡片底色。⚠ 只改色相，透明度仍由「界面不透明度」那一项管
  themeText:'',        // 文字颜色
  themeAccent:'',      // 主题色：按钮、滑条、进度条、选中态
  // 文字颜色跟不跟着背景亮度自动翻黑白。默认开 ——
  // 用户选了浅色底但忘了改文字色时，这个能兜住可读性。
  themeAutoContrast:true,
  // 关掉「每张卡按名字自动分配一个颜色」那套默认渐变（bg-manager.keyToGrad）。
  // 开 = 所有没设背景图的卡统一用中性深灰，一点彩色都不带。
  // ⚠ 代价：一/二/三级会长得一模一样，少了"我在第几层"的颜色线索
  //   （边缘的光还是按层分蓝/绿/紫，线索没完全没）。
  themeNoTint:false,
  // 主题背景清晰度。X4 = 按显示尺寸的 4 倍存图(高分屏更清晰, 更吃内存)。
  // ⚠ 默认 4 的前提是背景已改存 IndexedDB —— localStorage 时代 X4 必爆配额(见 docs/24)。
  bgQuality:'4',
  // ⭐⭐ 2026-10-18 晚（用户定）：三个快捷键【默认都没有】—— 用户可以清除不用，自己设了才生效；老用户升级也清掉一次（见 settingsMigrateShortcutsNone）。
  //   ⚠ 空串 = 不注册任何全局快捷键（外壳收到空值只取消注册、回成功）。别再在用的地方写「|| 'mod+enter'」兜底。
  generationShortcut:'',
  // ⭐ 2026-10-14：加参考图快捷键（用户要求"放到和开始计算同时的、一起的位置"）。
  referenceShortcut:'',
  // ⭐ 2026-10-17 夜：一键收起 / 展开快捷键（用户：「一键收起、展开都是同一个快捷键」，放在开始计算、加参考图旁边）。全局快捷键，PS 里按也有效。
  collapseShortcut:'',
  // ⭐ 2026-10-21：换下一家渠道（按渠道顺序轮换，见 providerCycleByShortcut）。同样默认没有、全局快捷键
  providerShortcut:'',
  // 2026-10-18 晚：老用户的三个快捷键清过一次没有（只清一次，之后用户自己设的照常保留）
  shortcutsClearedV1:false,
  // 预设列表「滚到底再猛推 → 翻到下一张主卡」需要的格数。
  // 越大越难触发。判定是"约半秒内滚够这么多格"，所以它实际控制的是【要求的滚动速度】。
  // 默认 10：用户 2026-09-11 实测 4 格和 6 格都"太容易触发"，定到 10（约每秒 22 格，必须刻意甩）。
  presetFlipNotches:'10',
  // ⭐⭐ 2026-10-09（用户要求）：鼠标移到缩略图上就自动弹出上方大预览框。
  //   用户原话：「鼠标选中交互图像时自动弹出预览框，如果说把这个东西关了，
  //             那就只有我点下去之后才会出现大图预览」。
  //   ⚠ 默认 true = 保持现在的手感（开着才符合"默认开启的一项功能"）。
  //   ⚠ 关掉之后【点一下照样能开】—— 点击走的是缩略图自己的 openShot 入口
  //     （ui.html 的 buildPreview 里 img 的 click 监听），跟这个开关无关。
  //     所以这个开关只是"少一条自动弹的路"，不是把功能关死。
  hoverOpensPreview:true,
  // ⭐ 2026-10-21（用户定）：只在用 Photoshop 时置顶 —— 当前在用 PS 或正在点轮椅才压在最前面，切到别的软件就退到后面。
  //   关掉 = 原来的「始终置顶」。跟电脑走（MACHINE_SETTING_KEYS）。外壳那头在 src-tauri/src/topmost.rs。
  topmostFollowPs:true,
  // ⭐ 2026-10-22（docs/263 1.6）：减少动画。软件自己的开关 —— 不读系统的「显示动画」偏好（09-14、10-20 栽过）。
  //   开 = 过渡压成瞬间、装饰循环停；跟电脑走（THEME_MACHINE_KEYS）。实现在 motion-tokens.js + tokens.css 末尾。
  reduceMotion:false,
  // UXP 轮询间隔(毫秒)。开发期调试参数：调小 = hover 联动更跟手。
  bridgePollMs:'180',
  // 旧键（2026-09-28 那版拖动存的，已不再读）。留着只是为了不动设置格式。
  workspacePosition:null,
  // ⭐ 自由模式下工具大卡的位置（窗口坐标 {left,top}）；null = 在当前卡原位展开。
  //   聚合模式不存：那边拖的是整个窗口，大卡永远贴着一级卡展开（2026-09-29 用户定案）。
  toolCardFreePos:null,
  // ⭐ 性能监视面板的位置（窗口坐标 {left,top}）；null = 用它自己的默认位置。
  //   2026-10-07 用户定："默认右下，但记住我拖过的位置"。
  //   ⚠ 记住的是【窗口坐标】：面板住在这张窗户纸里，窗口一挪它也挪，
  //     所以存的必须是"窗口内坐标"，不是屏幕坐标（存屏幕坐标下次开就对不上了）。
  perfPanelPos:null
};
const SETTINGS_DEFAULTS=Object.freeze({...settingsRuntime});
const checkpointRuntime=window.V7Checkpoints?window.V7Checkpoints.createController({
  cache:window.uiwin&&window.uiwin.cache,
  productData:window.V7ProductData,
  scope:()=>window.WHEELCHAIR_STORAGE?window.WHEELCHAIR_STORAGE.key('checkpoint.runtime'):'anonymous',
  namespaceId:()=>cacheNamespaceId(),
  warn:msg=>{try{aiAddLog('[检查点] '+msg,'warn');}catch(_){}},
  // ⭐ 间隔从设置实时取（分钟 → 毫秒）。传函数而不是值：改完滑条立刻生效。
  intervalMs:()=>checkpointIntervalMs(),
  capacityBytes:()=>Math.max(1,Math.min(1024,Number.isFinite(Number(settingsRuntime.cacheCapacityGB))?Number(settingsRuntime.cacheCapacityGB)||20:20))*1024*1024*1024,
  confirmCleanup:plan=>new Promise(resolve=>UI.dialog({title:'缓存容量已超限',
    body:'当前账号缓存 '+(plan.totalBytes/1073741824).toFixed(2)+' GB'+(plan.incomingBytes?'，本次待保存 '+(plan.incomingBytes/1048576).toFixed(1)+' MB':'')+'，上限 '+(plan.limitBytes/1073741824).toFixed(2)+' GB。按时间清理最旧的 '+plan.items.length+' 份检查点，将释放 '+(plan.freedBytes/1048576).toFixed(1)+' MB。',
    detail:'清理后无法恢复这些检查点。Photoshop 原文件和生成结果保留。',confirm:'清理旧检查点',cancel:'保留',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})),
  bridge(action,params,timeoutMs){
    return new Promise((resolve,reject)=>{
      let requestId='',settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(requestId)linkRuntime.pending.delete(requestId);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(Object.assign(new Error('等待 Photoshop 保存检查点超时'),{code:'CHECKPOINT_TIMEOUT'})),timeoutMs||120000);
      // ⭐ 记录与恢复卡（2026-09-30）：只有【真的在导出检查点】时才挂「正在备份检查点…」。
      //   ⚠ 判断放在 bridge 回调里（而不是 beforeGeneration 调用点）：同一条 bridge
      //     还会跑别的动作（比如记录的整画布小图），在调用点挂的话那些动作也会误弹。
      //   这条动作是慢活（整画布 PNG 落盘，大图要好几秒），所以必须有反馈。
      const checkpointToast=action==='ps.doc.exportCheckpoint'?recordsToast('正在备份检查点…','info'):{close:()=>{}};
      const requestAt=Date.now();
      const settle=(error,value)=>{
        checkpointToast.close();
        if(error){ if(action==='ps.doc.exportCheckpoint') recordsToast('检查点备份失败','warn',3200); }
        else if(action==='ps.doc.exportCheckpoint'){
          // 优先用 PS 回执里的真实耗时；没有就按往返时间估。
          const ms=Number(value&&value.durationMs);const seconds=Math.max(0,(Number.isFinite(ms)&&ms>0?ms:Date.now()-requestAt)/1000);
          recordsToast('检查点备份完成 · '+seconds.toFixed(1)+' 秒','ok',2600);
        }
        finish(error,value);
      };
      linkQueue(action,params,{after:data=>settle(null,data),afterError:result=>settle(Object.assign(new Error(linkResultMessage(result)),{code:result&&result.error&&result.error.code||'CHECKPOINT_EXPORT_FAILED'}))})
        .then(reply=>{requestId=reply&&reply.requestId||'';if(settled&&requestId)linkRuntime.pending.delete(requestId);if(reply&&reply.ok===false)settle(Object.assign(new Error(reply.error||'检查点入队失败'),{code:'CHECKPOINT_EXPORT_FAILED'}));})
        .catch(error=>settle(error));
    });
  }
}):null;
// 自动检查点间隔：设置里是【分钟】(1–60)，控制器要的是毫秒。
// ⚠ 只有这一处做换算 + 夹紧 —— 别在各调用点各写一遍（那必然有地方漏夹）。
function checkpointIntervalMs(){
  const minutes=Math.max(1,Math.min(60,Number(settingsRuntime.checkpointIntervalMin)||5));
  return minutes*60000;
}
const SECRET_SETTING_KEYS=new Set(['ajiKey','momoKey','grsKey','otherKey','runninghubKey','comfyKey','otherProfileKeys']);
// ⭐ 2026-10-14：快捷键类设置项。这些键存之前要先归一化（小写/别名统一），
//   否则录入框和实际注册的组合键对不上（比如录了 Ctrl+Shift+Enter 却存成别的写法）。
//   ⚠ 加第三个快捷键时【必须加进来】，漏了 = 存的格式不对 = 换绑后不生效。
const SHORTCUT_SETTING_KEYS=new Set(['generationShortcut','referenceShortcut','collapseShortcut','providerShortcut']);
// 每个快捷键的出厂值（没存过时显示 / 匹配用）。⚠ 2026-10-17 夜加第三个时收成一张表 —— 原来两处各写一遍三元判断，加键必漏。
const SHORTCUT_DEFAULTS={generationShortcut:'',referenceShortcut:'',collapseShortcut:'',providerShortcut:''};
// ⭐ 2026-10-19（docs/250 第 18、19 条，用户定「跟电脑走」）：这几项是「这台电脑的设置」，不跟账号存。
//   原来跟账号存：登录过期掉回 anonymous / 换账号 / 开机自动登录慢一步，就换成另一份 —— 那份快捷键是空的，
//   下次随便存一项设置（原来 settingsSave 每次都把三个快捷键重注册）就按空值把快捷键注销了 ⇒「重设后好，过一会又失效」。
//   自由摆放开没开着（freeMode）同理（位置本身在 free-mode-ui.js 里也改成跟电脑走）。
//   ⚠ 存在 WHEELCHAIR_STORAGE.localKey('machine-settings.v1')（带 profile、不带账号；教程的 profile 单独一份）；
//     账号那份不再存这几项（safeSettingsSnapshot 剔掉），读到了也会被本机这份盖掉（settingsMigrateShortcutsNone）。
//   ⚠ 云备份恢复（V7CloudBackup.applySettings）也不许动这几项。
// ⭐ 2026-10-21（用户定「主题、布局跟电脑走」）：主题那 8 项 + 三个面板位置也搬进本机这份。
//   原来跟账号存：登录过期掉回 anonymous（那格是空的）⇒ 主题整个变回出厂，用户以为设置丢了。
//   ⚠ 搬家：本机这份还没从【真账号】接过一次（没有 themeFromAccountV1）⇒ 用当前账号现在的值；
//     开机先站在 anonymous 那一格、自动登录回来才是真账号 —— anonymous 时只先临时用着，不打标记，真账号来了再接一次。
const THEME_MACHINE_KEYS=['blur','opacity','themeCardBg','themeText','themeAccent','themeAutoContrast','themeNoTint','reduceMotion','bgQuality','workspacePosition','toolCardFreePos','perfPanelPos'];
const MACHINE_SETTING_KEYS=new Set([...SHORTCUT_SETTING_KEYS,'freeMode',...THEME_MACHINE_KEYS,'topmostFollowPs']);
// settingsLoad 读账号那份时记下：里面【原来】存没存主题（读完它可能立刻按新格式重存一遍，主题项就被剔掉了，迁移再看就晚了）
let settingsAccountHadTheme=false;
// 本机那份里每一项的写法：快捷键是字符串、自由摆放是布尔，主题 / 位置原样存（有数字、布尔、对象）
function machineSettingValue(k,v){return k==='freeMode'?v===true:SHORTCUT_SETTING_KEYS.has(k)?String(v||''):(v===undefined?null:v);}
function machineSettingsKey(){const S=window.WHEELCHAIR_STORAGE;return S&&typeof S.localKey==='function'?S.localKey('machine-settings.v1'):'wheelchair.local.machine-settings.v1';}
function machineSettingsRead(){try{const v=JSON.parse(localStorage.getItem(machineSettingsKey())||'null');return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch(_){return null;}}
function machineSettingsSignedIn(){const S=window.WHEELCHAIR_STORAGE;return !!(S&&typeof S.isSignedInContext==='function'&&S.isSignedInContext());}
// ⚠ 搬家标记要带着走：原来每次都整份重写，标记会被冲掉 ⇒ 每次换账号都重新「接」一遍、把本机主题盖掉。
function machineSettingsWrite(fromAccount){try{const prev=machineSettingsRead()||{};const out={shortcutsClearedV1:true};if(fromAccount===true||prev.themeFromAccountV1===true)out.themeFromAccountV1=true;MACHINE_SETTING_KEYS.forEach(k=>{out[k]=machineSettingValue(k,settingsRuntime[k]);});localStorage.setItem(machineSettingsKey(),JSON.stringify(out));}catch(_){}}
// ⭐ 2026-10-18 深夜（用户：「RunningHub 现在没有接线，把 RunningHub 变成灰色，不要让用户去用」）：总开关。
//   接好之后把它改成 false 就全回来了：生成卡 / 设置里「自有工作流」那一项、设置卡 RunningHub 那一节、RH 预设出图。
const RUNNINGHUB_OFF=true;window.V7_RUNNINGHUB_OFF=RUNNINGHUB_OFF;
// 以前选过「自有工作流（RunningHub）」的：改回平台工作流（选着一个用不了的，出图必失败）
function settingsMigrateRunningHubOff(){
  if(!window.V7_RUNNINGHUB_OFF||settingsRuntime.workflowSource!=='own')return false;
  settingsRuntime.workflowSource='platform';
  try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){}
  return true;
}
// ⭐ 2026-10-19（docs/251 第 7 条①，用户定「老用户已存混合的一次性改成不校色，带迁移标记，只改一次」）：
//   存的是「混合」（以前的默认）或没存过 ⇒ 改成不校色；自己特意选了「全局 / 精准」的不动（那是他选的）。
//   ⚠ 只改一次（colorDefaultOffV1 记着）：之后用户自己再选混合，照常保留。启动、换账号都在 settingsLoad 之后调。
function settingsMigrateColorDefaultOff(){
  if(settingsRuntime.colorDefaultOffV1===true)return false;
  const mode=settingsRuntime.colorMatchMode;
  if(!mode||mode==='hybrid')settingsRuntime.colorMatchMode='off';
  settingsRuntime.colorDefaultOffV1=true;
  try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){}
  return true;
}
// ⭐ 2026-10-24（docs/273 P1-6，用户定「永久删除精准对齐，老用户就是这个原因，光流法扭曲图片了」）：
//   「精确对齐」(alignMode='flow' 稠密光流) 整个下掉了 —— 选项删了，存过它的老用户一律改回快速对齐（mesh）。
//   ⚠ 不是只改一次：这个值以后不该再出现，每次读设置都兜一遍（存档、换账号、云端恢复设置都可能带回来）。
// ⭐ 2026-10-24（V7待办/02）：老用户第一次升到「自动选线」—— 自己填过、而且不是官方那几条线路的地址 = 他的专线，
//   改成 manual 照旧用他的；填的是官方线路 / 没填 ⇒ auto。只做一次（lineModeV1）。
function settingsMigrateLineMode(){
  if(settingsRuntime.lineModeV1===true)return false;
  for(const slot of ['aji','momo']){
    if(settingsRuntime[slot+'LineMode']==='auto'||settingsRuntime[slot+'LineMode']==='manual')continue;
    const url=String(settingsRuntime[slot+'Url']||'').trim();
    const official=!url||!!(window.V7ProviderLines&&V7ProviderLines.isPoolUrl(slot,url));
    settingsRuntime[slot+'LineMode']=official?'auto':'manual';
  }
  settingsRuntime.lineModeV1=true;
  try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){}
  return true;
}
function settingsMigrateAlignFlowOff(){
  if(settingsRuntime.alignMode!=='flow')return false;
  settingsRuntime.alignMode='mesh';
  try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){}
  return true;
}
// ⭐ 2026-10-18 晚（用户定「老用户也清掉」）：升级到默认无快捷键的版本时，把这个账号原来的三个快捷键清一次。
//   只清一次（shortcutsClearedV1 记着）；清完之后用户自己再设的照常保留。
// ⭐ 2026-10-19（docs/250 第 18 条）：改成【每台电脑清一次】，而且之后只认本机那份（machine-settings.v1）：
//   · 本机那份已经有了 ⇒ 把它盖到 settingsRuntime 上（换账号、掉回 anonymous 都不影响快捷键 / 自由摆放开关）；
//   · 本机第一次 ⇒ 账号那份已经清过（1.9.x 起）就沿用账号里现在的值，没清过就先清；然后写进本机那份（谁先打开就用谁的）。
//   ⚠ 函数名不改：启动和换账号（storage-context 大处理器）两处都在 settingsLoad 之后调它。
function settingsMigrateShortcutsNone(){
  const local=machineSettingsRead();
  const has=k=>Object.prototype.hasOwnProperty.call(local,k);
  if(local){
    // 10-21 搬家：主题 / 位置还没从真账号接过 ⇒ 真账号时：账号那份【确实存着】老主题才接过来，没存过就留本机现在的（都打标记）；
    //   anonymous 时本机有就先用本机的。⚠ 不能无条件接：没登录时调好主题、第一次登一个新账号，会被新账号的出厂值冲掉。
    const adopting=local.themeFromAccountV1!==true&&machineSettingsSignedIn();
    const take=adopting&&settingsAccountHadTheme;
    MACHINE_SETTING_KEYS.forEach(k=>{if(take&&THEME_MACHINE_KEYS.includes(k))return;if(has(k))settingsRuntime[k]=machineSettingValue(k,local[k]);});
    if(adopting||THEME_MACHINE_KEYS.some(k=>!has(k)))machineSettingsWrite(adopting);
    return false;
  }
  if(settingsRuntime.shortcutsClearedV1!==true)SHORTCUT_SETTING_KEYS.forEach(k=>{settingsRuntime[k]='';});
  settingsRuntime.shortcutsClearedV1=true;
  machineSettingsWrite(machineSettingsSignedIn());
  try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){}
  return true;
}
// ⭐ 2026-10-21（用户定）：从真账号掉回「未登录」（退出 / 登录过期）时说一声。
//   不说的话：设置、预设、生成记录这些跟账号走的东西一下全空了，用户会以为数据丢了 —— 其实重新登录就回来。
//   主题、卡片排布、快捷键跟这台电脑走，不受影响（所以不用提它们会变）。
window.addEventListener('wheelchair:storage-context',e=>{
  const d=e&&e.detail||{};
  if(d.accountId!=='anonymous'||!d.previousAccountId||d.previousAccountId==='anonymous'||d.profileId==='tutorial')return;
  try{if(window.UI&&typeof UI.notice==='function')UI.notice({title:'已退出登录',body:'现在显示的是「未登录」时的设置、预设和记录，你账号里的东西都还在，重新登录就会回来。',detail:'主题、卡片排布和快捷键跟这台电脑走，不受影响。',level:'info'});}catch(_){}
});
// ⚠ 2026-10-08：连接配置的指纹 —— settingsSyncAiRuntime 用它判断"要不要重建生成卡"。
//   ⚠ 用 let 而不是 const，且初值给 null：第一遍同步时不算"变化"（不然开机会白重建一次）。
let lastConnectionFingerprint=null;
let settingsContextEpoch=0;
const settingsVault=window.V7SettingsVault?V7SettingsVault.create({keys:()=>SECRET_SETTING_KEYS,get:name=>settingsRuntime[name],set:(name,value)=>{settingsRuntime[name]=value;syncSettingsSecretFields(name);},onLoaded:()=>{settingsSyncAiRuntime();otherProfilesPaint();}}):null;
function syncSettingsSecretFields(name){
  document.querySelectorAll('[data-setting]').forEach(el=>{
    if(el.dataset.setting===name&&!el.value&&!el.dataset.settingEdited)el.value=String(settingsRuntime[name]||'');
  });
}
function loadSettingsSecrets(){
  if(!settingsVault)return;
  const scope=settingsStorageKey(),epoch=settingsContextEpoch;
  return settingsVault.load().then(()=>{if(epoch===settingsContextEpoch&&scope===settingsStorageKey())return settingsVault.saveChanges();}).catch(settingsVaultError);
}
function settingsVaultError(e){if(window.ERR)ERR.report(e.code||'SECRET_STORE_UNAVAILABLE',{message:String(e.message||e)});}
function safeSettingsSnapshot(){const out={};Object.keys(settingsRuntime).forEach(k=>{if(!SECRET_SETTING_KEYS.has(k)&&!MACHINE_SETTING_KEYS.has(k))out[k]=settingsRuntime[k];});out.savedAt=Date.now();return out;}
function settingsLoad(){try{settingsAccountHadTheme=false;const raw=localStorage.getItem(settingsStorageKey()),saved=raw?JSON.parse(raw):{};if(!saved||typeof saved!=='object')return;settingsAccountHadTheme=THEME_MACHINE_KEYS.some(k=>Object.prototype.hasOwnProperty.call(saved,k));Object.keys(settingsRuntime).forEach(k=>{if(Object.prototype.hasOwnProperty.call(saved,k)&&(!SECRET_SETTING_KEYS.has(k)||typeof saved[k]==='string'))settingsRuntime[k]=saved[k];});let legacy=null;try{legacy=JSON.parse(localStorage.getItem(window.WHEELCHAIR_STORAGE?WHEELCHAIR_STORAGE.key('v7.ai.validation.temp.v1'):'v7.ai.validation.temp.v1')||'null');}catch(_){}Object.assign(settingsRuntime,V7ProviderConnections.migrate(settingsRuntime,legacy));if(settingsRuntime.workflowSourceChosen!==true&&settingsRuntime.workflowSource==='local')settingsRuntime.workflowSource='platform';if(saved.connectionsVersion!==1||saved.provider!==settingsRuntime.provider||Object.keys(saved).some(k=>SECRET_SETTING_KEYS.has(k)))localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){} }
function settingsSave(){try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){} machineSettingsWrite();settingsSyncAiRuntime();settingsApplyAppearance();shortcutApplyIfChanged();topmostApplyIfChanged();if(settingsVault)settingsVault.saveChanges().catch(settingsVaultError);window.dispatchEvent(new Event('wheelchair:settings-changed'));}
// ⭐ 千问模式（2026-10-15）：开关和「在哪算」存在设置里（按账号存、跟云备份走），qwen-mode.js 通过这两个口子读写，自己不另存一份。
window.__V7_QWEN_SETTINGS__=()=>settingsRuntime;window.__V7_QWEN_SAVE__=settingsSave;
// ⭐ 2026-10-18 新手教程（tutorial.js）：只读的状态窗口，检查「学员做对了没」用。只在教程里挂（平时没有这个口子）。
//   ⚠ 为什么不让教程页自己 eval：软件的 CSP 没开 unsafe-eval；cur / taskList / aiRuntime 又是 let/const，挂不到 window 上。
if(window.__V7_TUTORIAL__)window.__V7_TUTORIAL_PEEK__=()=>({
  card:(cards[cur]&&cards[cur].dataset.card)||'',collapsed:!!isCollapsed,zoneOpen:!!zoneOpen,
  presetId:String(aiRuntime.workflowPresetId||aiRuntime.presetId||''),presetTitle:String(aiRuntime.presetTitle||''),prompt:String(aiRuntime.prompt||''),batch:Number(aiRuntime.batch)||1,autoReturn:!!aiRuntime.autoReturn,
  settings:settingsRuntime,
  tasks:taskList.filter(t=>t&&t.kind==='generation').map(t=>({id:String(t.id),status:t.status,label:t.label,returnState:t.returnState||'',
    done:(t.shots||[]).filter(s=>s&&s.done).length,shots:(t.shots||[]).length,layers:(t.psLayerIds||[]).length,colorVersion:t.colorVersion||'',
    version:(()=>{try{const s=(t.shots||[]).find(x=>x&&x.done);return s?shotCurrentVersion(t,s):'';}catch(_){return '';}})(),
    strength:(()=>{const s=(t.shots||[]).find(x=>x&&x.done);return s&&s.tweenStrength!=null?Number(s.tweenStrength):null;})()})),
  taskCount:taskList.length
});
// ⭐⭐ 2026-10-18 云端外挂（docs/237）：给 cloud-tools.js 接上设置 / 登录 / 探网 / 本机引擎。
//   用户：「云端连不上的时候，就直接降级，要提醒用户，实话实说。然后如果用户是网络环境有问题，要实话实说」
//   ⚠ 开关【没自己选过】时：这台电脑没有本机引擎 ⇒ 默认开（不带模型的包装完就能用）；有 ⇒ 默认关（老用户不被突然改道）。
//     cloudToolsLocalReady = null 表示还没查完（这段时间一律当「没开」，不改道）。
let cloudToolsLocalReady=null;
function cloudToolsMode(){
  if(settingsRuntime.cloudToolsModeChosen===true) return settingsRuntime.cloudToolsMode===true;
  return cloudToolsLocalReady===false;
}
async function cloudToolsLocalEnv(){
  try{
    if(!(window.uiwin&&uiwin.engine&&uiwin.engine.environment)) return false;
    const r=await uiwin.engine.environment('status');
    return !!(r&&r.ready===true&&r.state==='ready');
  }catch(_){ return false; }
}
function cloudToolsConfigure(){
  if(!window.V7CloudTools) return;
  V7CloudTools.configure({
    getMode:cloudToolsMode,
    setMode:on=>{ settingsRuntime.cloudToolsMode=!!on; settingsRuntime.cloudToolsModeChosen=true; settingsSave(); },
    signedIn:()=>{ try{ return !!(window.V7Backend&&V7Backend.state().signedIn); }catch(_){ return false; } },
    backendPass:()=>V7Backend.cloudToolsPass(),
    localAvailable:cloudToolsLocalEnv,
    ensureLocal:()=>window.V7EngineEnsure?V7EngineEnsure('本机'):null,
    report:(code,info)=>{ if(window.ERR) ERR.report(code,info); },
    // 探网：走壳的网络口（不受网页跨域限制），能拿到任何 HTTP 状态 = 通
    //   ⚠⚠ 请求编号必须每次都不一样：三个探测是【同一毫秒】一起发的，编号只用时间戳就会撞号 ⇒
    //     壳把撞号的请求当成同一个、互相取消（两个全部「已取消」），于是网络明明好的却报「连百度都连不上」
    //     （10-18 用户实测报的；同一编号 → 两个都「已取消」、不同编号 → 两个都 200，现场复现过）。
    probe:async(url,ms)=>{
      try{
        if(!(window.uiwin&&uiwin.http&&uiwin.http.fetch)) return false;
        const r=await uiwin.http.fetch({url,method:'GET',timeoutMs:ms||6000,direct:true,requestId:'cloud-probe-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)});
        return !!(r&&Number(r.status)>0);
      }catch(_){ return false; }
    },
    accountHealthUrl:()=>String(settingsRuntime.backendUrl||'https://www.xiasanqi.com').replace(/\/+$/,'')+'/health',
    online:()=>navigator.onLine!==false
  });
  // 换账号 / 登出：旧通行证作废（下次用到时用新账号重领）。⚠ 只认「账号变了」——账号信息刷新（积分变了之类）也会通知，那时不该扔掉通行证
  //   ⭐ 2026-10-20：账号变了（尤其是开软件后自动登录完成那一下）开着云端就【马上悄悄重连】——
  //     原来只扔通行证不重连，开软件时那次检查又跑在自动登录之前（被判「没登录」），用户每次都得手动点「重新检测」
  let cloudToolsAccount=null;
  try{ if(window.V7Backend&&V7Backend.onChange) V7Backend.onChange(s=>{
    const id=(s&&s.signedIn&&s.account&&(s.account.id||s.account.accountId))||'';
    if(id!==cloudToolsAccount){
      const first=cloudToolsAccount===null;
      cloudToolsAccount=id;
      if(first||!cloudToolsMode()){ V7CloudTools.forgetPass(); return; }
      V7CloudTools.reconnect().then(()=>{ try{ enginesStatusRefresh(true); }catch(_){} }).catch(()=>{});
    }
  }); }catch(_){}
  // 开着云端时，状态变了（连上 / 降级 / 没登录…）让外挂能力卡跟着变
  V7CloudTools.subscribe(()=>{ try{ if(enginesCard&&enginesCard.syncCloud) enginesCard.syncCloud(); }catch(_){} });
  cloudToolsLocalEnv().then(v=>{
    cloudToolsLocalReady=v;
    if(cloudToolsMode()){ V7CloudTools.ensureReady({quiet:true}).then(()=>{ try{ enginesStatusRefresh(true); }catch(_){} }); }
    try{ if(enginesCard&&enginesCard.syncCloud) enginesCard.syncCloud(); }catch(_){}
  });
}
// 外挂能力卡左上角的开关点了：存设置 → 重新探两台引擎（这时探的就是云端 / 本机）→ 卡面跟着变
async function cloudToolsToggle(on){
  if(!window.V7CloudTools) return;
  const r=await V7CloudTools.setEnabled(!!on);
  try{ await enginesStatusRefresh(true); }catch(_){}
  try{ if(enginesCard){ enginesCard.reload(); if(enginesCard.syncCloud) enginesCard.syncCloud(); } }catch(_){}
  if(on&&r&&r.route==='cloud') UI.toast('已切到云端外挂：抠像 / 人体解析 / 校色等都在云端算，本机引擎不用开');
  else if(!on) UI.toast('已切回本机引擎');
}
cloudToolsConfigure();
// ⭐ 2026-10-24（V7待办/02 竞速选线，ui-pure/provider-lines.js）：阿吉 / 墨墨是自动选线、而且 Key 是新的 / 变了 ⇒ 测一轮。
//   开软件 Key 从安全存储恢复（applySecrets → 本函数）、设置里换了 Key、点「检查连接 / 重新测速」（force）都走这里。
//   测完 resolved(slot) 变了 ⇒ 再同步一次，aiRuntime.baseUrl 换成新线路（只影响下一单：跑着的任务地址早就快照了）。
//   ⚠ 用 var 不用 const：本函数开机很早就被调，const 在暂时性死区里一读就抛（铁律 17 那个坑）。
var providerLinesRaced={aji:'',momo:''},providerLinesTimer=0;
function providerLinesMaybeRace(force){
  if(!window.V7ProviderLines||typeof setTimeout!=='function')return Promise.resolve([]);
  clearTimeout(providerLinesTimer);
  return new Promise(resolve=>{
    providerLinesTimer=setTimeout(()=>{
      const jobs=[];
      for(const slot of ['aji','momo']){
        const key=String(settingsRuntime[slot+'Key']||'').trim();
        if(!key||settingsRuntime[slot+'LineMode']==='manual')continue;
        const sig=key.length+'|'+key.slice(-6);              // 只记 Key 的指纹（长度 + 尾巴），不在内存里多留一份全文
        if(!force&&providerLinesRaced[slot]===sig)continue;
        providerLinesRaced[slot]=sig;
        jobs.push(V7ProviderLines.race(slot,key).then(r=>{ if(r) settingsSyncAiRuntime(); return r; }).catch(()=>null));
      }
      resolve(Promise.all(jobs));
    },force?0:1500);
  });
}
function settingsSyncAiRuntime(){
  if(checkpointRuntime)checkpointRuntime.setEnabled(settingsRuntime.checkpointEnabled===true);
  try{ if(window.V7Backend&&settingsRuntime.backendUrl) window.V7Backend.setBaseUrl(settingsRuntime.backendUrl); }catch(e){ if(window.ERR) ERR.report('BACKEND_URL_INVALID',{message:String(e&&e.message||e)}); }
  Object.assign(settingsRuntime,V7ProviderConnections.migrate(settingsRuntime));
  // ⚠⚠⚠ 2026-10-08 修（用户报："模型选择那个地方必然是空的"那条引出）：
  //   生成卡的模型名单是【渲染那一刻】算出来的（aiModelOptions / modelQuotaHtml 都读当时的
  //   aiRuntime + 连接配置）。而这里原来【只更新 runtime 的值、从不重建卡面】⇒
  //   用户在设置卡里配好地址/Key、点完检查连接，回到生成卡看到的还是旧名单（或者空）。
  //   实测：改完设置后 runtime.baseUrl 已经是 https://ai.test，但下拉框还是 1 个占位项；
  //   手动调一次 renderGenerationCardFields() 立刻变成 11 项 —— 就是这个缺口。
  //   ⇒ 连接真的变了就重建一次卡面。
  //   ⚠ 只在【连接指纹变了】时重建：这里每次保存设置都会被调，
  //     无条件重建会让用户正在调的下拉框/输入框被重置（体验上比"不更新"更糟）。
  //   ⚠ 延后一拍再做：现在还在设置那边的改动流程里，立刻重建可能撞上半截状态。
  try{
    const 连接字段=['provider','otherConnection','ajiUrl','ajiKey','ajiProtocol','ajiAuthMode',
      'momoUrl','momoKey','momoProtocol','momoAuthMode','grsUrl','grsKey','grsProtocol','grsAuthMode',
      'otherUrl','otherKey','otherProtocol','otherAuthMode','ajiLineMode','momoLineMode'];
    const 算指纹=()=>连接字段.map(k=>String(settingsRuntime[k]==null?'':settingsRuntime[k])).join('\u0001');
    const 新指纹=算指纹();
    // ⚠ 初值是 null：第一遍（开机那次同步）不算"变化"，否则开机会白重建一次卡面。
    if(lastConnectionFingerprint!==null&&lastConnectionFingerprint!==新指纹){
      setTimeout(()=>{ try{ renderGenerationCardFields(); }catch(_){} },0);
    }
    lastConnectionFingerprint=新指纹;
  }catch(_){ }
  Object.assign(aiRuntime,V7ProviderConnections.runtimePatch(settingsRuntime,aiRuntime));
  window.V7ProviderSettings?.changed();
  providerLinesMaybeRace(false);
  aiRuntime.model=aiRuntime.model||'AJbanana3';
  aiRuntime.size=settingsRuntime.maxResolution||aiRuntime.size;
  aiRuntime.autoReturn=!!settingsRuntime.autoReturn;
  aiRuntime.autoFullCanvas=!!settingsRuntime.autoFullCanvas;
  // 轮询间隔下发给桥。⚠ 每次保存设置都发一次，UXP 下一轮就生效，不用重载插件。
  if(window.uiwin&&window.uiwin.link&&window.uiwin.link.setPollMs){
    window.uiwin.link.setPollMs(Number(settingsRuntime.bridgePollMs)||180)
      .catch(e=>ERR.report('POLL_SET_FAILED',{message:String(e&&e.message||e)}));
  }
  // ⚠ 抗截断【不受】设置里的「色彩稳定」控制。
  //   「色彩稳定」是个还没接通的占位功能(见 docs/13 占位清单)，
  //   之前被错接成抗截断的总闸：取消勾选会把抗截断无声归零，
  //   用户会看到开关选着「抗截断+」、实际却按关的跑。两者已断开。
  aiRuntime.antiMode=Math.max(0,Math.min(2,Number(aiRuntime.antiMode)||0));
  aiRuntime.layerType=settingsRuntime.layerType||'smartObject';
  // ⭐ 「盖印后自动收起」的表跟着开关走：关了立刻停表(不再往桥里发探针)，
  //   开了就起表。⚠ 光靠 tick 里那句 if 判断是不够的 —— 那只是不干活，表还在空转。
  //   ⚠⚠ try 是【必须的】，别以为那句 typeof 能顶事：
  //     stampWatch 是 const，在暂时性死区里【连 typeof 都会抛 ReferenceError】
  //     (这是 const/let 和未声明变量的区别 —— 未声明的 typeof 才安全返回 'undefined')。
  //     settingsSyncAiRuntime 在启动早期就会被调，那时 stampWatch 还没初始化，
  //     不用 try 包住的话这里一抛，整段初始化就断在这儿(铁律 17 那个坑)。
  try{
    if(typeof stampWatch!=='undefined'){
      if(settingsRuntime.autoDismissOnStamp&&settingsRuntime.autoGroup) stampWatch.ensure();
      else stampWatch.stop();
    }
  }catch(_){ }
}
function settingsApplyAppearance(){
  const root=(typeof document!=='undefined' && document)?document.documentElement:null;
  if(!root || !root.style) return;
  const n=(value,fallback)=>{const x=Number(value);return Number.isFinite(x)?x:fallback;};
  root.style.setProperty('--blur',Math.max(0,n(settingsRuntime.blur,24))+'px');
  const uiOpacity=Math.max(.35,Math.min(1,n(settingsRuntime.opacity,100)/100));
  root.style.setProperty('--ui-opacity',uiOpacity);
  // Background-only opacity. Content layers (text, controls, thumbnails/previews)
  // intentionally do not inherit an element-level opacity.
  root.style.setProperty('--ui-bg-opacity',uiOpacity);
  // At 100% keep the historical stack pixels untouched. Below 100% the
  // reveal rule and optional geometry module remove covered card areas.
  // Never call setStack() here (that would introduce an initialization race).
  if(uiOpacity<.999) root.dataset.stackOpacityReveal='1';
  else delete root.dataset.stackOpacityReveal;
  window.V7StackOcclusion?.sync();
  // 主题背景清晰度 → 告诉 BG 模块以后按几倍存图。
  // ⚠ 只影响【之后新导入的图】；已存的图不会自动重压(那要把整套主题重新处理一遍)。
  if(window.BG && window.BG.setScale) window.BG.setScale(settingsRuntime.bgQuality);
  if(window.V7Motion) window.V7Motion.setReduced(settingsRuntime.reduceMotion===true);
  applyThemeColors();
}

// ══ 配色接线（2026-09-14）══════════════════════════════════════
// 用户在设置里选的三个颜色 → 覆盖 tokens.css 的变量 → 全项目跟着变。
//
// ⚠ 空串 = 不覆盖（把内联样式清掉，回落到 tokens.css 的默认值）。
//   所以"恢复默认"不需要单独写逻辑，把输入框清空就行。
function applyThemeColors(){
  const root=document.documentElement; if(!root||!root.style) return;
  const set=(k,v)=>{ if(v) root.style.setProperty(k,v); else root.style.removeProperty(k); };

  const bg=String(settingsRuntime.themeCardBg||'').trim();
  const tx=String(settingsRuntime.themeText||'').trim();
  const ac=String(settingsRuntime.themeAccent||'').trim();

  // ① 卡片底色
  // ⚠⚠ 真正决定"卡片什么颜色"的是 .block-card::before 那层遮罩渐变，
  //   不是 --bg（卡片本体是 background-color:transparent）。2026-09-14 第一版改错了地方，
  //   用户实测"卡片底色没生效"。现在写 --card-h（只含色相+饱和，亮度各处自留），
  //   那层渐变用 hsl(var(--card-h) 8% / .7) 取用 —— 不透明度和亮度都保持不变，
  //   所以背景图仍然透得出来，不会被盖死。
  if(bg){
    const hsl=hexToHsl(bg);
    if(hsl){
      // ⭐ 只写【色相+饱和度】，亮度不写 —— 每处遮罩自己带亮度(6%/8%/11%/13%)。
      //   这四档亮度是层次感的来源：任务卡最深、主卡、三级、L4 依次变浅。
      //   一刀切成同一个亮度会把整个界面压平（差点这么干了）。
      root.style.setProperty('--card-h', hsl.split(' ').slice(0,2).join(' '));
      // 二级/三级卡用的是实心底色，一起跟着走
      const c=hexToRgb(bg);
      if(c){
        // 工作面用实底；不透明度由背景图遮罩和控件表面层负责，不能让下层 Photoshop 透过输入控件。
        root.style.setProperty('--bg', 'rgb('+c.r+' '+c.g+' '+c.b+')');
        root.style.setProperty('--bg-solid', 'rgb('+c.r+' '+c.g+' '+c.b+')');
      }
      // ⭐⭐ 还要盖掉【每张卡按名字自动分配的默认渐变】(bg-manager.keyToGrad)。
      //   不盖的话：你选的底色只是最上面那层半透明遮罩，
      //   底下那层五颜六色的默认渐变照样透出来 —— 表现就是"每张卡还是各有各的颜色"
      //   （2026-09-14 用户实测指出）。
      //   ⚠ 光效色也一起传过去，否则卡片统一成纯色了、边缘的光还按名字散成各种颜色。
      //   ⚠ 单独设过背景图的卡不受影响，见 bg-manager.applyToCard 里的优先级说明。
      // 光效色 = 底色的色相 + 拉高的饱和/亮度。
      // ⚠ 饱和亮度必须拉高(78%/66%)，不能直接用底色的 ——
      //   底色通常很暗(比如 8% 亮度)，照搬的话边缘的光等于没有。
      //   这两个数跟 bg-manager 无图时的算法保持一致，换算方式统一。
      const hue=hsl.split(' ')[0];
      if(window.BG && window.BG.setSolid) BG.setSolid(bg, hue+' 78% 66%');
    }
  }else{
    // ⭐⭐ 2026-10-22（docs/263 第 19 条，用户拍板）：删掉「统一深色底」开关，连同「每张卡按名字自动配彩色渐变」。
    //   用户原话：「我不要顶上的颜色，用户可以自定义主题色」—— 没在主题里选卡片底色时，统一用中性深灰
    //   （#0e121a → 色相 220 28%，就是 --card-h 的默认值），跟以前「勾上统一深色底」完全一样。
    //   ⚠ 老设置里存的 themeNoTint 不用迁移：现在勾没勾都是这一种。
    //   ⚠ 单独给某张卡设过背景图的照旧（bg-manager.applyToCard 的优先级不变）；每张卡的 data-bgkey 挂点保留，给以后主题用。
    root.style.removeProperty('--card-h');
    root.style.removeProperty('--bg'); root.style.removeProperty('--bg-solid');
    if(window.BG && window.BG.setSolid) BG.setSolid('#0e121a','220 20% 60%');
  }

  // ② 文字色。同时推出次要文字色（同色相压到 62% 不透明）——
  //   让用户只选一个颜色就够，不用再选第二个。
  if(tx){
    const c=hexToRgb(tx);
    set('--tx', tx);
    if(c) root.style.setProperty('--tx2','rgba('+c.r+','+c.g+','+c.b+',.62)');
  }else{
    root.style.removeProperty('--tx'); root.style.removeProperty('--tx2');
  }

  // ③ 主题色（按钮/滑条/进度条/选中高亮）
  // ⚠ 只动 --accent 系列，【不动 --glow-*】—— 那四个是卡片边缘的光效，
  //   由背景图反推，跟主题色是两回事（tokens.css 里写明了）。
  // ⚠⚠ 必须【两个一起写】：--accent 是 hex（给不需要透明度的地方），
  //   --accent-hsl 是三分量（给需要 hsl(... / alpha) 的地方，全项目有 30 多处）。
  //   只写一个的话，改主题色时另一半纹丝不动 ——
  //   2026-09-14 用户实测"为什么不影响选中高亮色"就是这个：
  //   那些地方当时全是写死的 rgba(90,169,255,...)。
  // ⚠⚠⚠ 2026-10-07 用户实测后定（原话："跟着卡片底色走"）：
  //   他改了「卡片底色」成红色，界面里的按钮/滑条还是**默认蓝** ——
  //   因为「主题色」那一项是空的，这里就不写 --accent，于是回落到 tokens.css 里的默认蓝。
  //   用户的预期是"我挑了一个颜色，整个界面就统一"。
  //   ⇒ 没填主题色时【用卡片底色兜底】；两个都没填才回落到默认。
  //   ⚠ 这样也保留了原能力：想故意让按钮跟卡片不同色，就单独填「主题色」，它优先。
  const accent = ac || bg;
  set('--accent', accent);
  const acHsl = accent ? hexToHsl(accent) : null;
  set('--accent-hsl', acHsl);

  // ④ 自动对比：底色浅就整体翻深字
  // ⚠ 只在用户【没有手动指定文字色】时才接管 —— 他明确选了颜色就听他的。
  const auto = settingsRuntime.themeAutoContrast!==false && bg && !tx;
  document.body.classList.toggle('on-light', !!(auto && isLightColor(bg)));
}

// hex → {r,g,b}。认 #rgb 和 #rrggbb，认不出返回 null（调用方回落到默认）。
function hexToRgb(hex){
  const s=String(hex||'').trim().replace(/^#/,'');
  const full = s.length===3 ? s.split('').map(c=>c+c).join('') : s;
  if(!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return { r:parseInt(full.slice(0,2),16), g:parseInt(full.slice(2,4),16), b:parseInt(full.slice(4,6),16) };
}
// hex → "H S% L%" 三分量字符串（不含 alpha）。
// ⚠ 为什么要 HSL 不用 rgba：卡片遮罩是【三个色标的渐变】，每个色标不透明度不同。
//   用 hsl(var(--card-h) 8% / .7) 这种写法，一个变量就能配出多档透明度和亮度；
//   换成 rgba 就得存三份，改一次要同步三处。
function hexToHsl(hex){
  const c=hexToRgb(hex); if(!c) return null;
  const r=c.r/255, g=c.g/255, b=c.b/255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn;
  let h=0;
  if(d){
    if(mx===r) h=((g-b)/d)%6;
    else if(mx===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60; if(h<0) h+=360;
  }
  const l=(mx+mn)/2;
  const s=d? d/(1-Math.abs(2*l-1)) : 0;
  return Math.round(h)+' '+Math.round(s*100)+'% '+Math.round(l*100)+'%';
}
// 这个颜色算不算"浅色"。
// ⚠ 权重用 Rec.601（人眼对绿最敏感），阈值 .55 ——
//   和 bg-manager.luminanceFromDataUrl() 判背景图用的是【同一套】，
//   否则纯色主题和图片主题会在边界上给出不一样的结果。
function isLightColor(hex){
  const c=hexToRgb(hex); if(!c) return false;
  return (c.r*0.299 + c.g*0.587 + c.b*0.114)/255 > 0.55;
}
// 抓取分辨率(长边像素)。⚠ 全项目只有这一个地方决定"从 PS 拿多大"，
// 别再在调用点写死数字 —— 写死过一次，代价是设置里那一项变成假开关(铁律 15)。
// 夹在 512~4096：低于 512 抓回来没法用，高于 4096 是 PS 抓图本身的实际上限。
function captureMaxEdge(){
  const v=Number(settingsRuntime.captureMaxEdge)||2048;
  return Math.max(512,Math.min(4096,v));
}
// ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：同一个设置键的【多份控件】必须实际同步。
//
//  为什么必须加（查证结果）：
//    · settingsReadFields() 只把值写进 settingsRuntime + settingsSave() ——
//      它【不会】更新其它同名控件
//    · syncGenerationCardFields() 会同步，但它只扫【生成卡内部】那棵子树
//    · 设置卡里的同名控件不在这棵子树里
//  ⇒ 改一处、另一处显示旧值；而下次 settingsReadFields 读到的正是那个旧值，
//    又把它写回去 ⇒ 显示不同步，而且互相覆盖。
//  ⇒ 而 docs/170 §4.8 恰恰要求「校色方式」同时出现在生成卡卡面和二级（同一个键）。
//
//  ⚠ 只碰 data-setting（settingsRuntime），不碰 data-ai-field（那是 aiRuntime，另一套）。
//  ⚠ 正在被用户操作的那个控件跳过 —— 别抢用户的输入。
//  ⚠ select 被 ui-select.js 包成了毛玻璃面板，直接改 value 它不知道，
//    必须派个 change 让它重画标签（见 syncGenerationCardFields 里那条注释）。
function syncSettingControl(key){
  if(!key) return;
  const v=settingsRuntime[key];
  document.querySelectorAll('[data-setting="'+key+'"]').forEach(el=>{
    if(el===document.activeElement) return;
    if(el.type==='checkbox'){
      if(el.checked!==!!v) el.checked=!!v;
      return;
    }
    const want=v==null?'':String(v);
    if(String(el.value)===want) return;
    el.value=want;
    if(el.tagName==='SELECT') el.dispatchEvent(new Event('change',{bubbles:false}));
  });
}

function settingsReadFields(root,changedField){
  if(!root||root.dataset.settingsScope&&root.dataset.settingsScope!==settingsStorageKey())return;
  if(changedField?.dataset.setting==='freeMode'){
    // Native mode owns its commit. Saving the previous value here would visibly undo the toggle during motion.
    window.V7FreeMode?.set(changedField.checked);return;
  }
  const controls=changedField?[changedField]:root.querySelectorAll('[data-setting]');
  // ⭐ 2026-10-15（用户要求）：三个音效下拉框选了新的 ⇒ 马上试听一遍（不看总开关，是他自己点的）。
  //   音量滑条松手 ⇒ 用新音量放一遍「任务成功」那个音，听听多大声。
  //   ⚠ 只在【值真的变了】时放：同一个键在两张卡各有一份控件，下面 syncSettingControl
  //     会给另一份补发一次 change —— 那一次值已经一样了，不能再响第二遍。
  const soundKey=changedField&&/^sound(Success|AllFail|SingleFail|Volume)$/.test(changedField.dataset.setting||'')?changedField.dataset.setting:'';
  const soundBefore=soundKey?String(settingsRuntime[soundKey]||''):'';
  controls.forEach(el=>{
    const key=el.dataset.setting;if(!key||!Object.prototype.hasOwnProperty.call(settingsRuntime,key))return;
    if(key==='freeMode'){window.V7FreeMode?.set(el.checked);return;}
    if(SECRET_SETTING_KEYS.has(key)&&(changedField===el||el.dataset.settingEdited))settingsVault?.markEdited(key);
    // ⚠ 2026-10-14：快捷键类字段要归一化（原来只认 generationShortcut，
    //   加了 referenceShortcut 之后必须一起归一化，否则存的格式和读取的对不上）。
    settingsRuntime[key]=el.type==='checkbox'?!!el.checked:(SHORTCUT_SETTING_KEYS.has(key)?normalizeShortcutValue(el.value):el.value);
    if(key==='workflowSource')settingsRuntime.workflowSourceChosen=true;   // 自己选过 → 以后不再自动换成云端
  });
  // ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：读完把【同名控件的另一份】刷新。
  //   ⚠ 不加这一步的后果：同一个键在两张卡各有一个控件，
  //     改 A 之后 B 还显示旧值，而用户下次点 B 又把旧值写回去。
  //   ⚠ 放在 settingsSave() 之前：save 里可能会读 DOM，要让 DOM 先一致。
  for(const el of controls){ if(el.dataset && el.dataset.setting) syncSettingControl(el.dataset.setting); }
  settingsSave();
  if(soundKey&&String(settingsRuntime[soundKey]||'')!==soundBefore){
    const A=window.V7ReturnAppearance;
    const name=soundKey==='soundVolume'?A?.soundFor?.(settingsRuntime,'success'):settingsRuntime[soundKey];
    A?.previewByName?.(name,{
      warn:(msg,error)=>{try{UI.toast(msg,'warn',3200);aiAddLog(msg+(error?('：'+String(error&&error.message||error).slice(0,80)):''),'warn');}catch(_){}}
    },settingsRuntime.soundVolume);
  }
  // ⚠ 配色项改完要立刻生效（"自动深色文字"那个开关走的是这条路，不走 input 事件）
  if(typeof applyThemeColors==='function') applyThemeColors();
}
// ⭐ 2026-10-21（用户要求，V6 有）：自定义渠道存多套「配置方案」—— 界面这一层（逻辑在 ui-pure/other-profiles.js）。
//   当前这套照旧在 otherUrl/otherKey/otherProtocol/otherAuthMode；切换时把这四项和「其他」那一槽的模型名单一起换。
//   ⚠⚠ Key 是开机后从安全存储异步读出来的：没读完就切换 / 初始化，会拿空值把存着的 Key 冲掉 ⇒ 没读完一律不让动。
function otherProfilesKeysReady(){return !settingsVault||settingsVault.isLoaded('otherProfileKeys')&&settingsVault.isLoaded('otherKey');}
function otherProfilesState(){
  const M=window.V7ProviderModels;
  return {profiles:Array.isArray(settingsRuntime.otherProfiles)?settingsRuntime.otherProfiles:[],active:String(settingsRuntime.otherProfileActive||''),
    live:{url:String(settingsRuntime.otherUrl||''),key:String(settingsRuntime.otherKey||''),protocol:settingsRuntime.otherProtocol||'gemini',authMode:settingsRuntime.otherAuthMode||'bearer',models:M?M.modelsFor('other'):[]},
    keys:V7OtherProfiles.parseKeys(settingsRuntime.otherProfileKeys)};
}
function otherProfilesCommit(next){
  const M=window.V7ProviderModels;
  const modelsChanged=!!M&&JSON.stringify(M.modelsFor('other'))!==JSON.stringify(next.live.models||[]);
  settingsRuntime.otherProfiles=next.profiles;settingsRuntime.otherProfileActive=next.active;
  settingsRuntime.otherUrl=next.live.url;settingsRuntime.otherKey=next.live.key;
  settingsRuntime.otherProtocol=next.live.protocol;settingsRuntime.otherAuthMode=next.live.authMode;
  settingsRuntime.otherProfileKeys=V7OtherProfiles.stringifyKeys(next.keys);
  if(settingsVault){settingsVault.markEdited('otherKey');settingsVault.markEdited('otherProfileKeys');}
  if(modelsChanged)M.save('other',next.live.models||[]);
  ['otherUrl','otherKey','otherProtocol','otherAuthMode'].forEach(syncSettingControl);
  settingsSave();
  try{if(window.V7ProviderSettings)V7ProviderSettings.changed();}catch(_){}
  otherProfilesPaint();
}
function otherProfilesRun(step){
  if(!window.V7OtherProfiles)return;
  if(!otherProfilesKeysReady()){try{UI.toast('Key 还在从本机安全存储读取，稍等一下再切换方案','info',3000);}catch(_){}otherProfilesPaint();return;}
  try{otherProfilesCommit(step(V7OtherProfiles.ensure(otherProfilesState())));}
  catch(e){try{UI.toast(String(e&&e.message||e),'warn',3200);}catch(_){}otherProfilesPaint();}
}
function otherProfilesPaint(){
  const boxes=document.querySelectorAll('[data-other-profiles]');
  if(!boxes.length||!window.V7OtherProfiles)return;
  if(!otherProfilesKeysReady()){boxes.forEach(box=>{box.innerHTML='<span class="sf-label">配置方案</span><span class="sf-hint">Key 读取中…读完就能切换方案</span>';});return;}
  // ⚠ 只画不存：还没存过方案时，「方案 1」只是按现在填着的值算出来显示（编号固定 p1）。
  //   只是打开设置页就往账号里写东西 = 换账号测试抓到的「看一眼就改了 A 账号的存储」。真存盘只在用户点了之后（otherProfilesRun）。
  const raw=V7OtherProfiles.ensure(otherProfilesState());
  const active=raw.profiles.find(p=>p.id===raw.active);
  boxes.forEach(box=>{
    box.innerHTML='<span class="sf-label">配置方案</span><div class="other-profiles-row">'
      +'<select data-other-profile-select aria-label="切换自定义渠道方案">'+raw.profiles.map(p=>'<option value="'+escapeHtml(p.id)+'"'+(p.id===raw.active?' selected':'')+'>'+escapeHtml(p.name)+'</option>').join('')+'</select>'
      +'<input data-other-profile-name maxlength="40" aria-label="当前方案的名字" value="'+escapeHtml(active?active.name:'')+'">'
      +'<button type="button" class="settings-btn" data-other-profile-new>另存为新方案</button>'
      +'<button type="button" class="settings-btn danger" data-other-profile-delete'+(raw.profiles.length<=1?' disabled':'')+'>删除这套</button></div>'
      +'<span class="sf-hint">存好几个中转站来回切：切换时地址、Key、协议、模型名单一起换。名字直接在框里改。</span>';
  });
}
// ⭐ 2026-10-24（V7待办/02 竞速选线）：设置卡阿吉 / 墨墨那一槽的「自动选线 · 哪条 · 多快 · 余额 · 几条通过」+ 两个按钮。
//   自动：地址框藏起来（填了也不用）；手动：地址框露出来，用他自己填的专线。
function providerLinesPaint(){
  document.querySelectorAll('[data-provider-line]').forEach(box=>{
    const slot=box.dataset.providerLine,manual=settingsRuntime[slot+'LineMode']==='manual';
    const status=box.querySelector('[data-provider-line-status]'),race=box.querySelector('[data-provider-line-race]'),mode=box.querySelector('[data-provider-line-mode]');
    const hasKey=!!String(settingsRuntime[slot+'Key']||'').trim();
    if(status)status.textContent=manual?'手动填地址：用下面你自己填的这个（有专线的人用）。改回自动选线，软件会在多条线路里挑又快又有余额的那条。'
      :!window.V7ProviderLines?'自动选线（这个版本缺选线模块）':!hasKey?'自动选线 · 先在下面填好 Key，填完会自动测速':box.dataset.racing==='1'?'正在测速：每条线路查一次余额，最多 12 秒…':V7ProviderLines.describe(slot);
    if(race){race.hidden=manual;race.disabled=!hasKey||box.dataset.racing==='1';}
    if(mode)mode.textContent=manual?'改回自动选线':'改成手动填地址';
    const field=document.querySelector('[data-provider-connection-slot="'+slot+'"] [data-setting="'+slot+'Url"]');
    const row=field&&field.closest('.settings-field,.settings-row');
    if(row)row.hidden=!manual;
  });
}
function providerLinesBind(root){
  root.querySelectorAll('[data-provider-line]').forEach(box=>{
    const slot=box.dataset.providerLine;
    const race=box.querySelector('[data-provider-line-race]'),mode=box.querySelector('[data-provider-line-mode]');
    if(race)race.onclick=()=>{
      box.dataset.racing='1';providerLinesPaint();
      providerLinesMaybeRace(true).finally(()=>{box.dataset.racing='';providerLinesPaint();});
    };
    if(mode)mode.onclick=()=>{
      const toManual=settingsRuntime[slot+'LineMode']!=='manual';
      // 改成手动时地址框是空的 ⇒ 先填上现在自动选中的那条，免得一切过去就「没填地址」
      if(toManual&&!String(settingsRuntime[slot+'Url']||'').trim()&&window.V7ProviderLines)settingsRuntime[slot+'Url']=V7ProviderLines.resolved(slot);
      settingsRuntime[slot+'LineMode']=toManual?'manual':'auto';
      syncSettingControl(slot+'Url');
      settingsSave();
      if(!toManual)providerLinesMaybeRace(true).finally(providerLinesPaint);
      providerLinesPaint();
    };
  });
  providerLinesPaint();
}
if(typeof window.addEventListener==='function')window.addEventListener('wheelchair:provider-lines',()=>{try{providerLinesPaint();}catch(_){}});
function otherProfilesBind(root){
  root.querySelectorAll('[data-other-profiles]').forEach(box=>{
    if(box.dataset.otherProfilesBound)return;
    box.dataset.otherProfilesBound='1';
    box.addEventListener('change',e=>{
      const t=e.target;
      if(t.matches('[data-other-profile-select]'))otherProfilesRun(s=>V7OtherProfiles.switchTo(s,t.value));
      else if(t.matches('[data-other-profile-name]'))otherProfilesRun(s=>V7OtherProfiles.rename(s,s.active,t.value));
    });
    box.addEventListener('click',e=>{
      if(e.target.closest('[data-other-profile-new]'))otherProfilesRun(s=>V7OtherProfiles.saveAs(s));
      else if(e.target.closest('[data-other-profile-delete]')){
        const st=otherProfilesState(),cur=st.profiles.find(p=>p.id===st.active);
        UI.dialog({title:'删除方案「'+(cur?cur.name:'')+'」？',body:'这套的地址、Key、模型名单会从这台电脑上删掉，然后切到剩下的第一套。',
          confirm:'删除',cancel:'先不删',danger:true,onConfirm:()=>otherProfilesRun(s=>V7OtherProfiles.remove(s,s.active))});
      }
    });
  });
  otherProfilesPaint();
}
// ⭐ 2026-10-21（用户要求，照 V6 算力槽位）：「渠道名字和露出的模型」编辑区（设置卡「你在用哪家生图」那一节，折叠着）。
//   逻辑在 ui-pure/compute-slots.js；这里只管画和存。编辑的是【当前在用的渠道】（换服务商下拉再编别家）。
//   ⚠ 列的是原始名单（aiModelOptionsRaw）—— 藏掉的也得列出来，不然勾掉就再也勾不回来。
const COMPUTE_SLOT_BASE_LABELS={aji:'AJI · 阿吉',momo:'MOMO · 墨墨',grs:'GRS（夏三七托管 / 自带官方 Key）',other:'Others · 其他'};
function computeSlotLabel(slot){return window.V7ComputeSlots?V7ComputeSlots.labelWithOrigin(settingsRuntime.computeSlotNames,slot,COMPUTE_SLOT_BASE_LABELS[slot]):(COMPUTE_SLOT_BASE_LABELS[slot]||slot);}
function aiModelDisplay(slot,id){const n=(((settingsRuntime.computeModelPrefs||{})[String(slot||'')]||{}).names)||{};const raw=String(id||'');const base=typeof aiModelBase==='function'?aiModelBase(raw):raw;return String(n[raw]||n[base]||'').trim()||raw;}
// 任务卡底部那行：⚠ 只有改过名才换 —— 没改过的照旧显示原来那串（不改名的人看到的一点不变）
function aiTaskChannelText(task){
  const slot=String(task&&(task.connectionSlot||task.provider)||'');
  const custom=window.V7ComputeSlots?V7ComputeSlots.customName(settingsRuntime.computeSlotNames,slot):'';
  const model=task&&task.model?aiModelDisplay(slot,task.model):'';
  return (custom||String(task&&task.provider||''))+(model?(' · '+model):'');
}
function computeSlotOrderList(){return window.V7ComputeSlots?V7ComputeSlots.order(settingsRuntime.computeSlotOrder):['aji','momo','grs','other'];}
function computeSlotRefreshLabels(){
  const order=computeSlotOrderList();
  document.querySelectorAll('select[data-setting="provider"]').forEach(sel=>{
    sel.querySelectorAll('option').forEach(o=>{if(COMPUTE_SLOT_BASE_LABELS[o.value]){const t=computeSlotLabel(o.value);if(o.textContent!==t)o.textContent=t;}});
    // 2026-10-21：按渠道排序重排下拉框（只挪顺序，选中项不变）
    const opts=[...sel.options],want=order.map(slot=>opts.find(o=>o.value===slot)).filter(Boolean);
    if(want.some((o,i)=>opts[i]!==o)){const v=sel.value;want.forEach(o=>sel.appendChild(o));opts.filter(o=>!want.includes(o)).forEach(o=>sel.appendChild(o));sel.value=v;}
  });
}
function computeSlotEditorPaint(){
  const C=window.V7ComputeSlots;if(!C)return;
  document.querySelectorAll('[data-compute-slot-editor]').forEach(fold=>{
    const body=fold.querySelector('[data-compute-slot-body]');if(!body||!fold.open)return;
    // 正在里面的输入框打字时别重画（别的设置一保存就整块重建，会把没敲完的字冲掉）
    const typing=document.activeElement;if(typing&&body.contains(typing)&&typing.matches('input:not([type=checkbox])'))return;
    const slot=aiModelSlot();
    // 2026-10-21：渠道顺序（▲▼ 挪；服务商下拉、快捷键「换下一家」都按这个顺序）
    const order=computeSlotOrderList();
    const orderHtml='<div class="settings-field wide"><span class="sf-label">渠道顺序</span><div class="compute-slot-order" role="list">'
      +order.map((s,i)=>'<div class="compute-slot-order-row" role="listitem"><span>'+escapeHtml(C.name(settingsRuntime.computeSlotNames,s))+(s===slot?'（在用）':'')+'</span>'
        +'<button type="button" class="settings-btn" data-compute-slot-move="'+s+'" data-dir="-1" aria-label="'+escapeHtml(C.name(settingsRuntime.computeSlotNames,s))+' 上移"'+(i===0?' disabled':'')+'>▲</button>'
        +'<button type="button" class="settings-btn" data-compute-slot-move="'+s+'" data-dir="1" aria-label="'+escapeHtml(C.name(settingsRuntime.computeSlotNames,s))+' 下移"'+(i===order.length-1?' disabled':'')+'>▼</button></div>').join('')
      +'</div><span class="sf-hint">服务商下拉框、「换下一家渠道」快捷键都按这个顺序。</span></div>';
    if(!C.SLOTS.includes(slot)){body.innerHTML=orderHtml+'<p class="settings-note">当前这个渠道不支持改名和挑模型。</p>';return;}
    const prefs=C.prefsOf(settingsRuntime.computeModelPrefs,slot),hidden=new Set(prefs.hidden);
    const rows=aiModelOptionsRaw().filter(r=>!/（当前）$/.test(String(r[1]||'')));
    let html=orderHtml+'<div class="settings-field wide"><span class="sf-label">「'+escapeHtml(C.DEFAULT_NAMES[slot])+'」显示成</span>'
      +'<input data-compute-slot-name maxlength="20" placeholder="'+escapeHtml(C.DEFAULT_NAMES[slot])+'" value="'+escapeHtml(C.customName(settingsRuntime.computeSlotNames,slot))+'">'
      +'<span class="sf-hint">只改显示的名字（设置里、任务卡上），真正连的还是这家。留空 = 用默认名。</span></div>';
    if(!rows.length)html+='<p class="settings-note">还没有模型名单 —— 先点上面的「检查连接」拉一次。</p>';
    else html+='<div class="compute-slot-models" role="list">'+rows.map(r=>{const id=String(r[0]);
      return '<div class="compute-slot-model" role="listitem"><label><input type="checkbox" data-compute-model-show="'+escapeHtml(id)+'"'+(hidden.has(id)?'':' checked')+'> 露出</label>'
        +'<code title="真实模型名（发给服务商、算钱都用它）">'+escapeHtml(id)+'</code>'
        +'<input data-compute-model-name="'+escapeHtml(id)+'" maxlength="40" aria-label="'+escapeHtml(id)+' 的显示名" placeholder="'+escapeHtml(String(r[1]||id))+'" value="'+escapeHtml(String(prefs.names[id]||''))+'"></div>';}).join('')+'</div>';
    html+='<div class="settings-actions"><button type="button" class="settings-btn" data-compute-slot-reset>这个渠道恢复默认</button></div>'
      +'<p class="settings-note">勾掉的模型不出现在生成卡的模型下拉框里（正在用的那个除外，老预设照样能用）。改的名字只是显示，发给服务商、算钱用的还是真实模型名。至少要露出一个。</p>';
    body.innerHTML=html;
  });
}
function computeSlotsCommit(){
  settingsSave();computeSlotRefreshLabels();
  try{if(typeof renderGenerationCardFields==='function')renderGenerationCardFields();}catch(_){}
  computeSlotEditorPaint();
}
function computeSlotEditorChange(e){
  const C=window.V7ComputeSlots,t=e&&e.target,slot=aiModelSlot();
  if(!C||!t||!C.SLOTS.includes(slot))return;
  try{
    if(t.matches('[data-compute-slot-name]'))settingsRuntime.computeSlotNames=C.setSlotName(settingsRuntime.computeSlotNames,slot,t.value);
    else if(t.matches('[data-compute-model-show]'))settingsRuntime.computeModelPrefs=C.setHidden(settingsRuntime.computeModelPrefs,slot,t.dataset.computeModelShow,!t.checked,aiModelOptionsRaw().map(r=>String(r[0])));
    else if(t.matches('[data-compute-model-name]'))settingsRuntime.computeModelPrefs=C.setModelName(settingsRuntime.computeModelPrefs,slot,t.dataset.computeModelName,t.value);
    else return;
  }catch(err){if(t.type==='checkbox')t.checked=true;try{UI.toast(String(err&&err.message||err),'warn',2600);}catch(_){}return;}
  computeSlotsCommit();
}
function computeSlotEditorClick(e){
  const C=window.V7ComputeSlots,slot=aiModelSlot();
  const mv=e&&e.target.closest&&e.target.closest('[data-compute-slot-move]');
  if(C&&mv){settingsRuntime.computeSlotOrder=C.move(settingsRuntime.computeSlotOrder,mv.dataset.computeSlotMove,Number(mv.dataset.dir)||1);computeSlotsCommit();return;}
  if(!C||!e||!e.target.closest('[data-compute-slot-reset]')||!C.SLOTS.includes(slot))return;
  const next=C.reset(settingsRuntime.computeModelPrefs,settingsRuntime.computeSlotNames,slot);
  settingsRuntime.computeModelPrefs=next.prefs;settingsRuntime.computeSlotNames=next.names;
  computeSlotsCommit();
}
// 换服务商 / 拉完模型名单 / 换账号后：编辑区开着就跟着重画，下拉框里的名字也跟上
window.addEventListener('wheelchair:settings-changed',()=>{computeSlotRefreshLabels();computeSlotEditorPaint();});
// ⭐ 2026-10-21（用户要，照 V6 Dock「切换算力来源」一键轮换）：快捷键「换下一家渠道」—— 按渠道顺序换到下一家，到头绕回。
//   跟在设置里改服务商下拉是同一件事：改 provider → settingsSave（同步运行参数、连接变了会重建卡面）。
//   ⚠ 切过去当前模型在新渠道的名单里没有 ⇒ 换成新渠道的第一个（V6 同一条兜底：防切完出图报错）。
//   ⚠ 设置卡开着时下拉框也要跟着改：不然下次读设置字段会把 provider 读回旧值。
function providerCycleByShortcut(){
  const C=window.V7ComputeSlots;if(!C)return false;
  const cur=aiModelSlot(),nextSlot=C.next(settingsRuntime.computeSlotOrder,cur);
  if(!nextSlot||nextSlot===cur)return false;
  settingsRuntime.provider=nextSlot;
  if(nextSlot==='other'&&settingsRuntime.otherConnection==='grs')settingsRuntime.otherConnection='custom';
  document.querySelectorAll('select[data-setting="provider"]').forEach(s=>{s.value=nextSlot;});
  settingsSave();
  const rows=(typeof aiModelOptions==='function'?aiModelOptions():[]).filter(r=>!/（当前）$/.test(String(r[1]||'')));
  if(rows.length&&!rows.some(r=>String(r[0])===String(aiRuntime.model))){aiRuntime.model=String(rows[0][0]);if(typeof aiSaveTempCache==='function')aiSaveTempCache();}
  try{if(window.V7ProviderSettings)V7ProviderSettings.changed();}catch(_){}
  try{if(typeof renderGenerationCardFields==='function')renderGenerationCardFields();}catch(_){}
  const text='已切到「'+C.name(settingsRuntime.computeSlotNames,nextSlot)+'」'+(aiRuntime.model?' · '+aiModelDisplay(nextSlot,aiRuntime.model):'');
  aiAddLog(text,'info');
  try{UI.toast(text,'info',2200);}catch(_){}
  return true;
}
// ⭐⭐⭐ 2026-10-09（用户实测报的：「你后端没有给我们写死成为我们服务端的地址，
//   所以现在顶栏一直有个报错，连不上服务器，这个服务器是个本地 IP」）：
//
//   我上一版【只改了默认值】，没做迁移 ⇒ 对【已经存过设置的人】完全没用：
//     settingsLoad() 用存过的值覆盖了默认值（存的还是 http://127.0.0.1:37900）
//     ⇒ 软件照旧连本机 ⇒ 本机后端没起来 ⇒ 顶栏一直报"连不上服务器"。
//
//   ⚠ 为什么不干脆删掉那个设置项、彻底写死：
//     开发/内网还要用自定义地址（settingsRuntime 里 properties 还要能改），
//     但**指向"本机自己"的地址在正式版里一定是错的** —— 本机没有我们的后端。
//   ⚠ 判据只认"本机"三种写法（127.0.0.1 / localhost / ::1）：
//     别人在内网用 192.168.x.x 连自建后端，不能被我们改掉。
//   ⚠ 只在【升级后第一次】做（写一个标记）：不然用户想连回本机调试时，
//     每次启动都会被改回线上，那是个"改不掉的设置"——更糟。
//   ⚠ 必须在 settingsLoad() 之后、settingsSyncAiRuntime() 之前 ——
//     后者才是真正把地址交给 V7Backend 的地方。
//
// ⭐⭐⭐ 2026-10-10 审查时发现标记【放错了地方】，改成按快照带：
//
//   ❌ 原来：标记是 localStorage 里一个【全局】键（v7.backend.online-migrated.v1）。
//   ✅ 现在：标记写进【每个设置快照自己里面】（settingsRuntime.backendOnlineMigrated）。
//
//   ⚠⚠ 为什么必须改（这是实测抓到的现场，不是我猜的）：
//     设置是【按身份分开存】的，键名长这样：
//       wheelchair.a-anonymous~d-local-device~p-default.v7.settings.v1
//       wheelchair.a-<账号id>~d-<设备id>~p-default.v7.settings.v1
//     而标记只有一个。启动早期 deviceId 还是占位值 'local-device'
//     （见 backend-client.js:52 `state.deviceId || 'local-device'`），
//     于是迁移写的是 **d-local-device 那份快照**、全局标记也设成了 1；
//     等真设备号/账号就位后，运行时读的是**另一份快照** ——
//     那份里的 http://127.0.0.1:37900 **永远不会再被迁到**（全局标记已经是 1）。
//     实测证据（审查时从真窗口 dump 出来的三份快照）：
//       a-anonymous ~ d-local-device       → http://127.0.0.1:37900   ← 卡住的就是这份
//       a-anonymous ~ d-4ac3f79c…          → https://www.xiasanqi.com
//       a-211bdd82…（已登录）~ d-4ac3f79c… → https://www.xiasanqi.com
//
//   ⚠ 改完之后的行为（逐条说清，免得又埋新坑）：
//     · 每份旧快照各自迁一次（各自带标记）⇒ 不会再漏掉任何一份；
//     · 用户以后手动把地址改成 127.0.0.1 想连本机调试：那份快照**已经有标记了**
//       ⇒ 不会被改回线上，用户的选择被尊重（跟原来一样）；
//     · 全新安装：没有快照 ⇒ 直接用默认值（线上），标记也一起写上。
const BACKEND_ONLINE_MIGRATION_KEY='v7.backend.online-migrated.v1';
// 打上"这份快照迁过了"的标记。
// ⚠ 旧的全局限也一起写：万一以后回滚到老版本，老版本看全局键=1 就不会重复迁。
function markBackendMigrated(){
  settingsRuntime.backendOnlineMigrated=true;
  try{localStorage.setItem(BACKEND_ONLINE_MIGRATION_KEY,'1');}catch(_){}
}
function settingsMigrateBackendToService(){
  try{
    const raw=String(settingsRuntime.backendUrl||'').trim();
    if(!raw){ settingsRuntime.backendUrl=SETTINGS_DEFAULTS.backendUrl; markBackendMigrated(); return 'empty'; }
    let hostname='';
    try{ hostname=new URL(raw).hostname.toLowerCase(); }catch(_){ return 'invalid'; }
    if(!['127.0.0.1','localhost','::1','[::1]'].includes(hostname)) return 'not-local';
    // ⚠ 判据是【这份快照自己】迁过没有 —— 不是那个全局键。
    //   全局键只用来在日志里说明历史，不参与判断（那正是这次的 bug）。
    if(settingsRuntime.backendOnlineMigrated===true) return 'already';
    settingsRuntime.backendUrl=SETTINGS_DEFAULTS.backendUrl;
    markBackendMigrated();
    // ⚠ 必须【写回存储】：不写的话，之后任何一次保存设置又会把旧地址写回去
    //   （settingsSave 存的是 settingsRuntime 快照，但迁移发生在启动早期、
    //    那时还没保存过 —— 只要用户在设置里点一下别的，旧值就复活了）。
    //   ⚠ 这里【不调 settingsSave()】：它会顺带做外观/快捷键/派事件，
    //     而我们在启动中途、那些东西还没就绪。只做最必要的一件事（写快照）。
    try{localStorage.setItem(settingsStorageKey(),JSON.stringify(safeSettingsSnapshot()));}catch(_){}
    console.log('[后端地址迁移] 本机地址 → '+settingsRuntime.backendUrl
      +'（这份快照自带标记；旧全局标记='+(localStorage.getItem(BACKEND_ONLINE_MIGRATION_KEY)==='1'?'1':'无')+'）');
    return 'migrated';
  }catch(e){ return 'error:'+String(e&&e.message||e); }
}
// ⭐ 2026-10-10：把【别的身份】留下的本机地址快照也一起清掉。
//
// ⚠ 为什么需要这一步：迁移是按"当前身份"读快照的，而旧版本留下的坏快照
//   可能挂在别的身份下（实测抓到过：a-096d33b3…~d-4ac3f79c… 那份还是 127.0.0.1，
//   而这次启动读不到它 ⇒ 要等用户切到那个身份才会被迁）。
//   用户根本不知道自己有"好几份设置"，看到的就是"我的地址怎么又变回本机了"。
//
// ⚠ 四条安全边界（每条都是"不做就会出事"）：
//   ① 只扫【我们自己的键】（以 'wheelchair.' 开头 + 以 '.v7.settings.v1' 结尾）——
//      绝不碰别人的 localStorage 数据；
//   ② 只改【主机名是 127.0.0.1 / localhost / ::1】的，别的一律不动
//      （别人在内网用 192.168.x.x 连自建后端，不能被我们改掉）；
//   ③ 已经有 backendOnlineMigrated 标记的【跳过】—— 那是"用户手动改回本机调试"，
//      他的选择要被尊重（跟单份迁移的规矩一致）；
//   ④ 出错就静默跳过（清理失败不该拦住软件启动）。
function settingsSweepLegacyLocalBackend(){
  let fixed=0;
  try{
    const doomed=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);
      if(!key||key.indexOf('wheelchair.')!==0||key.slice(-'.v7.settings.v1'.length)!=='.v7.settings.v1')continue;
      let data=null;
      try{ data=JSON.parse(localStorage.getItem(key)||'{}'); }catch(_){ continue; }
      if(!data||typeof data!=='object')continue;
      if(data.backendOnlineMigrated===true)continue;                 // ③ 用户改过的，跳过
      let hostname='';
      try{ hostname=new URL(String(data.backendUrl||'')).hostname.toLowerCase(); }catch(_){ continue; }
      if(!['127.0.0.1','localhost','::1','[::1]'].includes(hostname))continue;   // ② 只清本机
      data.backendUrl=SETTINGS_DEFAULTS.backendUrl;
      data.backendOnlineMigrated=true;
      doomed.push([key,JSON.stringify(data)]);
    }
    for(const [key,json] of doomed){ localStorage.setItem(key,json); fixed++; }   // ① 只写回自己的键
  }catch(_){ /* ④ 静默 */ }
  if(fixed)console.log('[后端地址迁移] 顺手清掉 '+fixed+' 份其它身份留下的本机地址快照');
  return fixed;
}
settingsLoad();
settingsMigrateShortcutsNone();
settingsMigrateRunningHubOff();
settingsMigrateColorDefaultOff();
settingsMigrateAlignFlowOff();
settingsMigrateLineMode();
settingsMigrateBackendToService();
// ⚠ 顺序：先迁【当前身份】那份（settingsMigrateBackendToService），再扫【其它身份】的残留。
//   反过来的话，当前这份会被当成"别的身份"扫掉 —— 结果一样，但日志会看不懂。
settingsSweepLegacyLocalBackend();
loadSettingsSecrets();
settingsSyncAiRuntime();
settingsApplyAppearance();
// 主进程全局快捷键是否注册成功。失败时才启用页面内的兜底监听。
let shortcutGlobalOk=false;
// 一键收起 / 展开的全局键注册成功没有（没成功时页面内兜底监听接手；跟生成键各算各的）
let shortcutCollapseGlobalOk=false;
let shortcutProviderGlobalOk=false;
// ⭐ 2026-10-19（docs/250 第 18 条）：只在三个快捷键的值【真的变了】时才重注册 ——
//   原来每次存设置（哪怕只是进出自由摆放自动存的 freeMode）都把三个全部注销再注册，中间有空档，值不对时还会按空值注销掉。
let shortcutsAppliedSig=null;
function shortcutApplyIfChanged(){
  const sig=JSON.stringify([...SHORTCUT_SETTING_KEYS].map(k=>String(settingsRuntime[k]||'')));
  if(sig===shortcutsAppliedSig)return false;
  shortcutApplyToMain();
  return true;
}
// ⭐ 10-25（反馈 #46「设了 g，到桌面打字打不出 g」，docs/286 P1-1）：快捷键是系统级的，注册上的键别的软件收不到。
//   生成 / 换渠道 10-25 起切到别的软件就放开（外壳 shortcuts_follow_front）；参考图 / 一键收起是故意全局的（PS 不在前台也要能用）。
//   ⇒ 设成【单个字母 / 数字键】（没带 Ctrl / Alt / Shift）时提醒一次：全局那两个在哪都打不出这个字；另外两个在 PS 里打字时也打不出。
const shortcutSingleWarned=new Set();
function shortcutSingleKeyWarn(value,label,global){
  const v=String(value||'').trim();
  if(!v||v.indexOf('+')>=0||!/^(Key)?[A-Za-z0-9]$|^(Digit)?[0-9]$|^Space$/i.test(v))return;
  const key=label+':'+v;
  if(shortcutSingleWarned.has(key))return;
  shortcutSingleWarned.add(key);
  const text='「'+label+'」设成了单个键 '+formatShortcutValue(v)+'：'+(global?'这个键在所有软件里都会被轮椅占住（聊天、打字都打不出来）':'在 Photoshop 里打字时这个键会被轮椅占住')+'。建议加上 Ctrl 或 Alt。';
  try{aiAddLog(text,'warn');}catch(_){}
  try{if(window.UI&&typeof UI.toast==='function')UI.toast(text,'info',6000);}catch(_){}
}
function shortcutApplyToMain(){
  if(!(window.uiwin&&window.uiwin.shortcuts))return;
  shortcutSingleKeyWarn(settingsRuntime.generationShortcut,'开始生成',false);
  shortcutSingleKeyWarn(settingsRuntime.providerShortcut,'换渠道',false);
  shortcutSingleKeyWarn(settingsRuntime.referenceShortcut,'加参考图',true);
  shortcutSingleKeyWarn(settingsRuntime.collapseShortcut,'一键收起',true);
  shortcutsAppliedSig=JSON.stringify([...SHORTCUT_SETTING_KEYS].map(k=>String(settingsRuntime[k]||'')));
  // ⭐ 2026-10-18 晚：空 = 用户没设 / 清掉了 ⇒ 照样发给外壳（它只取消原来那个、回成功），不报「没注册上」
  const value=settingsRuntime.generationShortcut||'';
  window.uiwin.shortcuts.setGeneration(value).then(res=>{
    shortcutGlobalOk=!!(res&&res.ok);
    if(!shortcutGlobalOk&&value&&window.ERR)
      ERR.report('SHORTCUT_REGISTER_FAILED',{message:formatShortcutValue(value)+' 没注册上：'+((res&&res.error)||'可能被其他软件占用'),duration:5000});
  }).catch(()=>{shortcutGlobalOk=false;});
  // ⭐ 2026-10-14：加参考图快捷键（跟上面同一套：注册失败要吵出来，不能静默）。
  //   ⚠ 两个键各自独立成败，一个失败不影响另一个。
  if(typeof window.uiwin.shortcuts.setReference==='function'){
    const rvalue=settingsRuntime.referenceShortcut||'';
    window.uiwin.shortcuts.setReference(rvalue).then(res=>{
      if(!(res&&res.ok)&&rvalue&&window.ERR)
        ERR.report('SHORTCUT_REGISTER_FAILED',{message:formatShortcutValue(rvalue)+'（加参考图）没注册上：'+((res&&res.error)||'可能被其他软件占用'),duration:5000});
    }).catch(()=>{});
  }
  // ⭐ 2026-10-17 夜：一键收起 / 展开快捷键（同一套：注册失败要吵出来；各自独立成败）
  if(typeof window.uiwin.shortcuts.setCollapse==='function'){
    const cvalue=settingsRuntime.collapseShortcut||'';
    window.uiwin.shortcuts.setCollapse(cvalue).then(res=>{
      shortcutCollapseGlobalOk=!!(res&&res.ok);
      if(!shortcutCollapseGlobalOk&&cvalue&&window.ERR)
        ERR.report('SHORTCUT_REGISTER_FAILED',{message:formatShortcutValue(cvalue)+'（一键收起 / 展开）没注册上：'+((res&&res.error)||'可能被其他软件占用'),duration:5000});
    }).catch(()=>{shortcutCollapseGlobalOk=false;});
  }
  // ⭐ 2026-10-21：换下一家渠道（同一套：注册失败要吵出来；各自独立成败）
  if(typeof window.uiwin.shortcuts.setProvider==='function'){
    const pvalue=settingsRuntime.providerShortcut||'';
    window.uiwin.shortcuts.setProvider(pvalue).then(res=>{
      shortcutProviderGlobalOk=!!(res&&res.ok);
      if(!shortcutProviderGlobalOk&&pvalue&&window.ERR)
        ERR.report('SHORTCUT_REGISTER_FAILED',{message:formatShortcutValue(pvalue)+'（换下一家渠道）没注册上：'+((res&&res.error)||'可能被其他软件占用'),duration:5000});
    }).catch(()=>{shortcutProviderGlobalOk=false;});
  }
}
// ⭐ 2026-10-17 夜（用户：「增加一个一键收起的快捷键，一键收起、展开都是同一个快捷键」）：
//   普通模式 = 整个面板收起 / 展开（跟卡上那颗「折叠面板」按钮同一个动作 setCollapsed）；
//   自由模式 = ⭐ 2026-10-19 改（docs/250 第 17 条）：整个面板收成一个小方块，再按一下放回来（V7FreeMode.toggleCompact）。
//   ⚠ 正在设置里录快捷键时不动（不然录「Ctrl+Alt+Enter」的那一下就把面板收了）。
function toggleCollapseByShortcut(){
  const active=document.activeElement;
  if(active&&active.dataset&&SHORTCUT_SETTING_KEYS.has(active.dataset.setting))return false;
  if(window.V7FreeMode&&V7FreeMode.isActive()){
    if(typeof V7FreeMode.toggleCompact==='function'){
      // ⭐ 2026-10-19（docs/250 第 18 条）：自由摆放正在切换（播动画）时按了没反应 —— 说一声，别静默
      if(V7FreeMode.toggleCompact()===null){shortcutBlockedHint('自由摆放正在切换，等动画放完再按一次');return false;}
      return true;
    }
    return false;
  }
  setCollapsed(!isCollapsed);
  return true;
}
// ⭐ 2026-10-19（docs/250 第 17 条）：自由摆放收成小方块时，方块上那几样信息从这里取（free-mode-ui.js 只在收着的时候半秒问一次）。
//   在跑几个 + 平均进度 / 一共出了几张（方块自己算「收起之后新出的」）/ 没看的报错（L2 那种，L1 胶囊自己会消失）/ 当前预设 / PS 连着没有
function freeCompactSummary(){
  const running=taskList.filter(t=>t&&!aiTaskIsTerminal(t));
  const pct=running.length?Math.round(running.reduce((n,t)=>n+Math.max(0,Math.min(100,Number(t.pct)||0)),0)/running.length):0;
  const doneShots=taskList.reduce((n,t)=>n+(t&&Array.isArray(t.shots)?t.shots.filter(s=>s&&s.done).length:0),0);
  let preset='';
  try{preset=presetTitleNow();}catch(_){preset='';}
  return {running:running.length,pct,doneShots,errors:errorsEl?errorsEl.querySelectorAll('.error-card.ec-l2').length:0,preset,
    link:{connected:!!linkRuntime.connected,background:!!linkRuntime.background}};
}
// ⭐ 2026-10-19（docs/250 第 18 条）：快捷键按了但被挡住（弹窗 / 大工具卡开着、自由摆放在切换）时给一句轻提示。
//   原来直接 return，用户以为快捷键坏了（「重设后好，过一会又失效」的另一半原因）。同一句 3 秒内只提示一次。
let shortcutBlockedAt=0;
function shortcutBlockedHint(text){
  const now=Date.now();
  if(now-shortcutBlockedAt<3000)return;
  shortcutBlockedAt=now;
  try{if(window.UI&&typeof UI.toast==='function')UI.toast('快捷键这次没执行：'+text,'info',3200);}catch(_){}
}
const SHORTCUT_OVERLAY_HINT='有弹窗或工具窗口开着，先关掉它再按';
// ⭐ 2026-10-21（用户定）：「只在用 Photoshop 时置顶」—— 开机告诉外壳一次，之后设置改了才再告诉（值没变不重发）。
//   ⚠ 用 var：settingsSave 也会调它，开机早期万一先被调到，let 会报「还没准备好就被用」。
var topmostAppliedSig=null;
function topmostApplyIfChanged(){
  const follow=settingsRuntime.topmostFollowPs!==false;
  if(follow===topmostAppliedSig||!(window.uiwin&&window.uiwin.topmost))return;
  topmostAppliedSig=follow;
  window.uiwin.topmost.setFollowPs(follow).catch(()=>{topmostAppliedSig=null;});
}
topmostApplyIfChanged();
if(window.uiwin&&window.uiwin.shortcuts){
  shortcutApplyToMain();
  // ⚠ 走 runNow 不走 generationRunNow：快捷键要按"当前选中哪条预设"分流
  //   （选着抠像就抠像）。这是用户 2026-09-14 明确要的行为。
  window.uiwin.shortcuts.onGeneration(()=>{if(v7OverlayOpen()){shortcutBlockedHint(SHORTCUT_OVERLAY_HINT);return;}runNow();});
  // ⭐ 2026-10-14：加参考图快捷键 —— 抓当前 PS 选区加进参考图（复用现成的抓选区那条路，
  //   也就是生成卡那格「追加当前选区」按的同一个函数）。
  //   ⚠ 卡片由 V7PresetReferences 的变化回调自动挂出来（见 configure 那处），这里不用管显示。
  if(typeof window.uiwin.shortcuts.onReference==='function'){
    window.uiwin.shortcuts.onReference(()=>{
      if(v7OverlayOpen()){shortcutBlockedHint(SHORTCUT_OVERLAY_HINT);return;}
      // ⚠ 没同意条款 / 没登录时别硬抓：跟生成键一样先过首启门（gateFirstRun 会自己提示）
      if(window.V7FirstRun&&!V7FirstRun.isComplete()){gateFirstRun(()=>referenceHotkey(V7PresetReferences.context()).catch(V7PresetReferences.report));return;}
      // 2026-10-24：PS 不在前台 ⇒ 截图框选（referenceHotkey，14-compute.js）
      referenceHotkey(V7PresetReferences.context()).catch(V7PresetReferences.report);
    });
  }
  if(window.uiwin.snip&&typeof window.uiwin.snip.onDone==='function'){
    window.uiwin.snip.onDone(result=>referenceSnipDone(result));
  }
  // ⭐ 2026-10-17 夜：一键收起 / 展开
  if(typeof window.uiwin.shortcuts.onCollapse==='function'){
    window.uiwin.shortcuts.onCollapse(()=>{if(v7OverlayOpen()){shortcutBlockedHint(SHORTCUT_OVERLAY_HINT);return;}toggleCollapseByShortcut();});
  }
  // ⭐ 2026-10-21：换下一家渠道
  if(typeof window.uiwin.shortcuts.onProvider==='function'){
    window.uiwin.shortcuts.onProvider(()=>{if(v7OverlayOpen()){shortcutBlockedHint(SHORTCUT_OVERLAY_HINT);return;}providerCycleByShortcut();});
  }
}
const AI_TEMP_CACHE_KEY='v7.ai.validation.temp.v1';
function aiTempStorageKey(){
  return window.WHEELCHAIR_STORAGE
    ? window.WHEELCHAIR_STORAGE.key(AI_TEMP_CACHE_KEY) : AI_TEMP_CACHE_KEY;
}
const AI_TEMP_CACHE_TTL=7*24*60*60*1000;
// ⚠⚠ 2026-09-13 把 'autoReturn' 从这张表里摘掉了（用户实测的假开关）。
//   它在这里的后果：启动顺序是 settingsLoad → settingsSyncAiRuntime → aiLoadTempCache，
//   最后这一步会用【7 天前存的临时值】把刚同步好的 aiRuntime.autoReturn 盖掉 ——
//   于是设置里明明关着，重载之后又自己传回去了。
//   现在"自动传回"的唯一仓库是 settingsRuntime（走 localStorage 的设置项，不过期）。
//   ⚠⚠ 2026-10-18 'autoFullCanvas' 也拿掉了（docs/238 §4-8，实测复现）：原来这里写「两处读的都是 settingsRuntime，先不动」——
//     不对，「开始生成」读的是 aiRuntime.autoFullCanvas（aiBeginImmediate 里 allowFullCanvas 那行），
//     于是设置关、7 天内临时缓存是开 ⇒ 卡面显示关、实际按整张画布跑（反过来也一样）。
//     复现脚本 tmp/agent-impl/repro-autofullcanvas.cjs。唯一仓库同样是 settingsRuntime，aiRuntime 那份只当镜像。
const AI_TEMP_FIELDS=['model','size','aspectRatio','batch','prompt','antiMode','workflowParameters','workflowPresetId','batchByKind','batchKind','sizeByKind','sizeKind'];
function aiPersistentParameters(values,context){
  const source=context||aiRuntime;
  const id=source.workflowPresetId||source.presetId;
  const preset=source.workflowPreset||(id&&window.PRESETS&&PRESETS.presetById(id));
  return window.V7Workflows?V7Workflows.persistentParameters(values,source.workflow||preset&&(preset.workflow||preset.forgeWorkflow),preset):{};
}
function aiTempSnapshot(){const out={};AI_TEMP_FIELDS.forEach(k=>{out[k]=k==='workflowParameters'?aiPersistentParameters(aiRuntime[k],aiRuntime):aiRuntime[k];});return out;}
function aiLoadTempCache(){try{const raw=localStorage.getItem(aiTempStorageKey());if(!raw)return;const saved=JSON.parse(raw);if(!saved||saved.version!==1||!saved.savedAt||Date.now()-Number(saved.savedAt)>AI_TEMP_CACHE_TTL){localStorage.removeItem(aiTempStorageKey());return;}delete saved.apiKey;delete saved.provider;delete saved.baseUrl;delete saved.endpoint;delete saved.authMode;delete saved.protocol;saved.workflowParameters=aiPersistentParameters(saved.workflowParameters,saved);localStorage.setItem(aiTempStorageKey(),JSON.stringify(saved));AI_TEMP_FIELDS.forEach(k=>{if(Object.prototype.hasOwnProperty.call(saved,k))aiRuntime[k]=k==='workflowParameters'?aiClonePlain(saved[k]||{}):saved[k];});}catch(error){ERR.report('WORKFLOW_STATE_SAVE_FAILED',{message:String(error.message||error)});}}
function aiSaveTempCache(){try{if(typeof batchKindRecord==='function')batchKindRecord();localStorage.setItem(aiTempStorageKey(),JSON.stringify(Object.assign({version:1,savedAt:Date.now()},aiTempSnapshot())));}catch(error){ERR.report('WORKFLOW_STATE_SAVE_FAILED',{message:String(error.message||error)});} }
function aiClearTempCache(){try{localStorage.removeItem(aiTempStorageKey());}catch(_){}aiRuntime.status='临时缓存已删除';aiRefreshInPlace();}
// ⭐ 2026-10-17 夜（用户：「正常返回的图明显感觉我提示词没有生效」）：生成那几样的出厂值留一份。
//   启动这一刻账号还没恢复，下面这次读的是「未登录占位」那份存档（实测：里面是一段旧的去杂物提示词）；
//   账号恢复 / 换账号时（wheelchair:storage-context）先回到出厂值、再读新账号自己那份 —— 以前只在这里读一次，旧词一直留着被发出去。
const AI_TEMP_DEFAULTS=JSON.parse(JSON.stringify(Object.fromEntries(AI_TEMP_FIELDS.map(k=>[k,aiRuntime[k]===undefined?null:aiRuntime[k]]))));
function aiReloadTempCacheForAccount(){AI_TEMP_FIELDS.forEach(k=>{aiRuntime[k]=JSON.parse(JSON.stringify(AI_TEMP_DEFAULTS[k]));});aiLoadTempCache();}
aiLoadTempCache();
Object.assign(aiRuntime,V7ProviderConnections.runtimePatch(settingsRuntime,aiRuntime));
// ⚠ 上限从 32 降到 18 之前存的缓存里可能是 19~32，不夹回来的话
//   界面显示 18、实际却按旧值跑(而且条的 max 是 18，看不出哪里不对)。
aiRuntime.batch=Math.max(1,Math.min(AI_BATCH_MAX,Number(aiRuntime.batch)||1));
// ⚠ 卡面参数的渲染【不能放这里】——它用到的 gcSyncing 是 let，声明在后面几百行，
//   在这里调用就撞上暂时性死区，整个主脚本当场抛错、后面的初始化全不跑
//   (CLAUDE.md 铁律 17 那条，2026-09-11 实测栽过一次)。
//   调用已挪到主脚本末尾，那里所有声明都完成了。
function aiPanelForZone(zone){return document.querySelector('#dcBody .ai-panel[data-ai-zone="'+String(zone)+'"]');}
// 抗截断三档的唯一命名来源。⚠ 别在别处再写一遍字面量：
// 以前 aiModeLabel、下拉框选项、aiRefreshInPlace 各写各的，
// 结果 aiRefreshInPlace 每个进度心跳都会把下拉框的字改回它自己那套。
// ⚠ 默认值是 0（关），这是用户 2026-09-08 明确拍板的，不是漏配。
//   原来设置里的「色彩稳定」曾被错接成这里的总闸（占位功能控制真功能），
//   已断开并删除。以后谁想改默认值，先问用户。
const ANTI_MODE_LABELS=['抗截断关','抗截断开','抗截断+'];
// 2026-10-18 用户：「抗截断这个叫法没问题，放上去有解释就行」。卡面下拉和生成卡大二级那一行都挂这句。
//   机制照 V6 原文（fillAiDetail 那段 note）：开 = R17 色相反转 180°，+ = 再上下翻转；出图后自动还原。
const ANTI_MODE_TIP='抗截断：服务商把图截断（出一半、不肯出）时打开。\n· 开 —— 先把颜色反转再发给 AI，出图后自动还原\n· + —— 再加上下翻转，更强一档\n平时关着就行。';
function aiModeLabel(mode){return ANTI_MODE_LABELS[Number(mode)||0]||ANTI_MODE_LABELS[0];}
// Photoshop 来源快照是任务的“哪里来 → 回哪里”凭证。
// 只保留可序列化的来源字段，并深拷贝 selection（包含 cropRect 等嵌套坐标），
// 防止后续切换文档/选区或 UXP 重用对象时把旧任务的目标悄悄改掉。
function aiClonePlain(value){
  if(value===undefined||value===null)return value;
  if(typeof value!=='object')return value;
  try{return JSON.parse(JSON.stringify(value));}catch(_){
    if(Array.isArray(value))return value.map(aiClonePlain);
    const out={};Object.keys(value).forEach(k=>{out[k]=aiClonePlain(value[k]);});return out;
  }
}
function aiCaptureSnapshot(capture,modeOverride){
  if(!capture)return null;
  const c=capture||{};
  const input=String(c.inputImageBase64||c.imageBase64||c.base64||'');
  const source=String(c.sourceImageBase64||c.originalBase64||c.sourceBase64||input||'');
  const mode=Math.max(0,Math.min(2,Number(modeOverride===undefined?c.antiMode:modeOverride)||0));
  return aiClonePlain({
    docId:c.docId===undefined||c.docId===null?null:c.docId,
    docName:String(c.docName||''),
    selection:aiClonePlain(c.selection||null),
    imageBase64:input,
    inputImageBase64:input,
    sourceImageBase64:source,
    mime:String(c.mime||c.inputMime||'image/png'),
    width:Number(c.width)||0,
    height:Number(c.height)||0,
    hasSelection:!!c.hasSelection,
    antiMode:mode,
    capturedAt:Number(c.capturedAt)||Date.now(),
    captureId:String(c.captureId||'')
  });
}
function aiTaskIsTerminal(task){
  return !!task && ['done','success','completed','failed','cancelled'].indexOf(String(task.status||''))>=0;
}
let aiRequestSequence=0;
function aiNewTaskId(prefix='ai'){return prefix+'-'+Date.now().toString(36)+'-'+(++aiRequestSequence).toString(36);}
function aiSelectedTask(){
  const selected=taskList[tcur];
  return selected&&selected.kind==='generation'?selected:taskById(aiRuntime.currentTaskId);
}
function aiActiveCount(){return Object.keys(aiRuntime.activeTasks||{}).length;}
function aiMarkActive(taskId,phase){
  if(taskId===undefined||taskId===null)return;
  aiRuntime.activeTasks[String(taskId)]=String(phase||'generate');
  aiRuntime.activePhase=String(phase||'generate');
  aiRuntime.running=aiActiveCount()>0;
}
function aiMarkInactive(taskId){
  if(taskId!==undefined&&taskId!==null)delete aiRuntime.activeTasks[String(taskId)];
  aiRuntime.running=aiActiveCount()>0;
  if(!aiRuntime.running)aiRuntime.activePhase='';
}
// activeTasks 只用于显示当前活动数量和取消按钮，不再阻塞新增完整任务。
function aiHasActiveRequest(){
  return aiActiveCount()>0;
}
function aiAddLog(message,level){aiRuntime.logs.push({at:linkIso(),message:String(message||''),level:level||'info'});if(aiRuntime.logs.length>300)aiRuntime.logs.splice(0,aiRuntime.logs.length-300);addLinkLog({direction:'AI',level:level||'info',message:String(message||'')});}
// 2026-10-18：aiInputValue 删了 —— 0 个调用，查的 #dcBody [data-ai-field] 早就不在了（docs/238 §4-4）。
function aiReadFields(root){if(!root)return;root.querySelectorAll('[data-ai-field]').forEach(el=>{const k=el.dataset.aiField;if(el.type==='checkbox')aiRuntime[k]=!!el.checked;else aiRuntime[k]=el.value;});aiRuntime.batch=Math.max(1,Math.min(AI_BATCH_MAX,Number(aiRuntime.batch)||1));aiRuntime.antiMode=Math.max(0,Math.min(2,Number(aiRuntime.antiMode)||0));
  if(aiRuntime.workflowPresetId && window.PRESETUI && PRESETUI.setWorkflowParameters) PRESETUI.setWorkflowParameters({imageCount:aiRuntime.batch,batch:aiRuntime.batch,count:aiRuntime.batch},{refresh:false});
  aiSaveTempCache();}
function aiPlan(taskOverride){
  const task=taskOverride&&taskOverride.kind==='generation'?taskOverride:null;
  const capture=task?(task.captureSnapshot||null):(aiRuntime.captureSnapshot||aiRuntime.capture);
  const sel=capture&&capture.selection;
  const w=capture&&Number(capture.pixelWidth||capture.width)||sel&&Number(sel.width)||0;
  const h=capture&&Number(capture.pixelHeight||capture.height)||sel&&Number(sel.height)||0;
  const ratio=String(task&&task.aspectRatio||aiRuntime.aspectRatio||'1:1'); const m=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio); let outW=0,outH=0;
  const side=({ '1K':1024,'2K':2048,'4K':4096 })[String(task&&task.size||aiRuntime.size||'2K').toUpperCase()]||2048;
  if(m){const r=Number(m[1])/Number(m[2]);outW=r>=1?side:Math.round(side*r);outH=r>=1?Math.round(side/r):side;}else{outW=side;outH=side;}
  const mode=task&&task.antiMode!==undefined?task.antiMode:aiRuntime.antiMode;
  return {source:w&&h?(w+'×'+h):'未抓取',target:outW+'×'+outH,mode:aiModeLabel(mode),recovery:Number(mode)===0?'直接使用结果':Number(mode)===1?'生成后还原色相':'生成后还原色相并恢复垂直方向'};
}
function aiThumbsHtml(outputs){
  const all=outputs===undefined?(aiRuntime.outputs||[]):(outputs||[]); if(!all.length)return '<div class="ai-note">还没有结果。点「开始生成」后会在这里出现。</div>';
  // ⚠ 只挂缩略图。这个函数在【每一次进度回调】里都会被 aiRefreshInPlace 重新拼一遍，
  //   以前拼的是完整 base64，8 张图每个心跳 ~170MB 字符串 —— 界面就是这么被拖住的。
  return '<div class="ai-thumb-grid" data-ai-results>'+all.map((x,i)=>'<div class="ai-thumb" data-ai-image-index="'+i+'"><img src="'+(x&&x.imgId?window.IMG.thumb(x.imgId):'')+'" alt="生成结果 '+(i+1)+'"><em>#'+(i+1)+'</em></div>').join('')+'</div>';
}
function aiResultsHtml(outputs){return aiThumbsHtml(outputs);}
function aiRefreshInPlace(){
  // ⭐ 2026-10-15：生成卡改成单张大二级后，「开始生成 / 参考图 / 生成结果」画在 #generationZone 里，
  //   不在 #dcBody 了 ⇒ 下面所有选择器都扩成 :is(#dcBody,#generationZone)。
  //   ⚠ 只扩不换：#dcBody 里的老面板（预设卡等也调 renderGenerationPanel）照旧要刷。
  const selected=aiSelectedTask();
  const viewTask=selected&&selected.kind==='generation'?selected:null;
  const viewOutputs=viewTask&&Array.isArray(viewTask.outputs)?viewTask.outputs:(aiRuntime.outputs||[]);
  const viewStatus=viewTask?(viewTask.sub||taskStatusText(viewTask,Number(viewTask.pct)||0)):aiRuntime.status;
  const viewProgress=viewTask?Math.max(0,Math.min(100,Number(viewTask.pct)||0)):aiRuntime.progress;
  const plan=aiPlan(viewTask); aiRuntime.lastPlan=plan;
  // 卡面参数跟着 aiRuntime 走(设置页同步、从缓存恢复都会改它)
  syncGenerationCardFields();
  // ⭐ 2026-10-15：模型右边那块「每张多少 · 本次多少」跟着张数/分辨率/模型变
  try{ refreshModelQuota(); }catch(_){}
  // ⭐⭐ 2026-10-08（docs/170 §4.8）：设置卡里的同名控件也要跟上。
  //   syncGenerationCardFields 只扫生成卡内部那棵子树，够不到设置卡。
  for(const k of GENERATION_CARD_SETTING_KEYS) syncSettingControl(k);
  // ⭐⭐ 2026-10-14：预设卡二级/三级的快捷调参条也要跟上。
  if(typeof syncQuickParams==='function') syncQuickParams();
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-field="antiMode"] option').forEach((el,i)=>{if(i<3)el.textContent=ANTI_MODE_LABELS[i];});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-status]').forEach(el=>el.textContent=viewStatus);
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-progress]').forEach(el=>{el.style.width=viewProgress+'%';});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-progress-text]').forEach(el=>el.textContent=viewProgress+'%');
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-source]').forEach(el=>el.textContent=plan.source);
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-target]').forEach(el=>el.textContent=plan.target);
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-mode]').forEach(el=>el.textContent=plan.mode);
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-recovery]').forEach(el=>el.textContent=plan.recovery);
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-count]').forEach(el=>el.textContent=viewOutputs.length+' 张');
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-queue-count]').forEach(el=>el.textContent=aiRuntime.queue.length+' 项');
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-queue-list]').forEach(el=>{const top=el.scrollTop;el.innerHTML=aiRuntime.queue.length?aiRuntime.queue.map(q=>'<div class="ai-queue-row"><span>'+escapeHtml(q.prompt.slice(0,24)||'未填写提示词')+'</span><span class="state '+(q.status==='success'?'ok':q.status==='failed'?'err':'')+'">'+escapeHtml(q.status)+'</span></div>').join(''):'<div class="ai-note">队列为空</div>';el.scrollTop=top;});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-output-area]').forEach(el=>{const top=el.scrollTop;el.innerHTML=aiResultsHtml(viewOutputs);el.scrollTop=top;});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-generation-ref]').forEach(el=>{el.innerHTML=generationReferencePreview();});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-reference-map]').forEach(el=>{const preset=window.PRESETS&&window.PRESETUI&&PRESETS.presetById(PRESETUI.prompt.presetId);el.hidden=!(preset&&(preset.workflow||preset.forgeWorkflow));});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-log-list]').forEach(el=>{const top=el.scrollTop;el.innerHTML=aiRuntime.logs.length?aiRuntime.logs.slice().reverse().map(logEntryHtml).join(''):'<div class="ai-note">暂无 AI 验证日志</div>';el.scrollTop=top;});
  const phase=selected&&aiRuntime.activeTasks[selected.taskId];
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-run]').forEach(el=>{el.disabled=false;});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-cancel]').forEach(el=>{el.disabled=!phase||phase==='transfer'||!!(selected&&selected.cancelRequested);});
  document.querySelectorAll(':is(#dcBody,#generationZone) [data-ai-place]').forEach(el=>{el.disabled=!selected||!selected.outputs.length||!!phase;});
}
function aiRestoreTaskImage(task,image){
  if(!task._restorations)task._restorations=new Map();
  const index=Number(image.index)||0;
  if(!task._restorations.has(index)){
    // 调试模式：把"这一张准备怎么处理"说清楚
    if(isDebugOn()){
      const m=Math.max(0,Math.min(2,Number(task.antiMode)||0));
      const wantC=wantColorMode()!=='off';   // ⭐ 四态：'off' 才是不校色
      const wantA=settingsRuntime.autoAlign!==false;
      dbg('调度','第 '+(index+1)+' 张 · 抗截断'+(m===0?'关':('R17'+(m===2?'+':'')))
        +' · 校色'+(wantC?'开':'关')+' · 对齐'+(wantA?'开':'关')
        +' · 上限档'+(settingsRuntime.matchTier||'3'));
    }
    // ⭐ 校色用的参考图 = 这个任务当初从 Photoshop 抓的【用户可见原图】。
    //   ⚠ 一定要用 sourceImageBase64 而不是 inputImageBase64：
    //     后者是抗截断处理过的(色相反转)，拿它当颜色基准会把图校成反的。
    //   两张图本来就在同一个任务里，配对天然成立 —— 这也是为什么
    //   "生成时自动校色"不需要传回台账(台账是给事后补校色用的)。
    const snap=task&&task.captureSnapshot;
    const refB64=(snap&&(snap.sourceImageBase64||snap.imageBase64))||task.sourceImageBase64||'';
    const restoreScope=cacheNamespaceId(),restoreEpoch=sourceImageEpoch;
    const ownsRestore=()=>restoreScope===cacheNamespaceId()&&restoreEpoch===sourceImageEpoch&&taskById(task.taskId||task.id)===task;
    // ⭐⭐ 2026-10-19（docs/249，用户：「主要是排序、并发和软件层有问题」）：
    //   原来回来一张就马上开一单、一批 N 张【同时】解码 + 编码 + 上传 —— 平分带宽，第一张也很晚才出来，
    //   一起超时、一起悄悄降级。现在经过 restoreGate：走云端时同时最多 2 张（第 2 张准备时第 1 张在传，流水线）、本机 4 张，
    //   按张号小的先；后面的云端任务队列再按「上传只走一条道」排。
    const job={kind:'color',priority:1,taskId:String(task.taskId||task.id),shot:index,label:'第 '+(index+1)+' 张'};
    // ⭐ 10-25：图 1 发出去前补过正方形（ref-square-pad.js）⇒ 回图先按补的位置裁回原来那块，再还原 / 校色。
    //   ⚠ 裁回放在 aiRestoreImage 前面：校色 / 对齐拿原图比，比例不一样会整张对歪。
    const squarePad=task._squarePad||null;
    const restoreOne=()=>{
      if(!squarePad||!window.V7RefSquarePad)return aiRestoreImage(image,task.antiMode,task.preserveGeneratedAppearance?'':refB64,job);
      const b64=image&&(image.imageBase64||image.base64)||'';
      return V7RefSquarePad.crop(b64,image.mime||'image/png',squarePad).then(cut=>{
        const next=Object.assign({},image,{imageBase64:cut.imageBase64,mime:cut.mime,squareCropped:true});delete next.base64;
        return aiRestoreImage(next,task.antiMode,task.preserveGeneratedAppearance?'':refB64,job);
      });
    };
    task._restorations.set(index,restoreGate(index,restoreOne,{taskId:job.taskId,shot:index}).then(result=>{
      if(!ownsRestore()){
        if(result&&result.imgId&&window.IMG)window.IMG.release(result.imgId);
        throw Object.assign(new Error('账号或任务已变化，旧还原结果已释放'),{code:'AI_CONTEXT_CHANGED'});
      }
      return result;
    }));
  }
  return task._restorations.get(index);
}
// ⭐ 2026-10-19（docs/249）：生成回来的图「还原 + 校色」的闸门 —— 同时最多 2 张（走云端）/ 4 张（本机）在做，张号小的先。
//   ⚠ 只管【开工顺序和同时几张】，不改任何一张图的算法；排着的那几张也要标「等待中 · 前面几个」（不许静默等）。
//   ⚠ 用 var 不用 const（下面 jobView 同理）：任务卡 / 缩略图那两处在文件更前面，用 typeof 判断它在不在；
//     const 在这一行执行之前连 typeof 都会抛错（暂时性死区），一抛整张任务卡就不画了。var 那时只是 undefined。
//   ⚠ 位置别挪：这两段必须在 aiRestoreTaskImage 和 aiCapture 之间 —— 两份测试按源码切片跑
//     （ai-generation-account-guard：[aiRestoreTaskImage, aiCapture)；ai-task-concurrency：[AI_BATCH_MAX, bindAiDetail)），
//     放到切片外面就是 restoreGate is not defined（10-19 全量测试抓到）。
var restoreGate=(()=>{
  let active=0, seq=0;
  const queue=[];
  // ⚠ 同时几张：走云端时 2 张（上行带宽是瓶颈，一张张传第一张最快出来；第 2 张准备时第 1 张在传 = 流水线）；
  //   用本机时 4 张 —— 原来本机根本不限，可本机后台线程池最多也就 4 条（match-engine.js 的 poolSize），
  //   多放进去的只是在池子里排着、还多占着解码好的整张图的内存。所以 4 张 = 速度跟原来一样、内存更稳。
  const limit=()=>{ try{ return (window.V7CloudTools&&typeof V7CloudTools.routing==='function'&&V7CloudTools.routing())?2:4; }catch(_){ return 4; } };
  // 标注只是锦上添花：jobView 不在（测试切片 / 还没初始化）就不标，闸门照常放行
  const mark=(meta,st)=>{ if(meta&&typeof jobView!=='undefined'&&jobView) jobView.gate(meta.taskId,meta.shot,st); };
  const refresh=()=>{
    queue.slice().sort((a,b)=>a.prio-b.prio||a.seq-b.seq).forEach((it,i)=>mark(it.meta,{stage:'local-queue',ahead:i+active}));
  };
  const pump=()=>{
    while(active<limit()&&queue.length){
      queue.sort((a,b)=>a.prio-b.prio||a.seq-b.seq);
      const it=queue.shift();
      active++;
      mark(it.meta,{stage:'prepare',ahead:0});
      Promise.resolve().then(it.run).then(it.resolve,it.reject).finally(()=>{active--;mark(it.meta,null);pump();});
    }
    refresh();
  };
  return (prio,run,meta)=>new Promise((resolve,reject)=>{queue.push({prio:Number(prio)||0,seq:++seq,run,resolve,reject,meta:meta||null});pump();});
})();

// ══════════════════════════════════════════════════════════════════
//  ⭐⭐ 2026-10-19 状态标注（docs/249，用户：「包含上传了吗、排队多久、什么状态、哪一步了，全都没标注」）
//   三处：① 任务卡底栏那行字（这一批进行到哪：「校色 3/6 · 第 4 张 上传 46%」）
//         ② 每张缩略图角上的小标（等待 / 上传% / 云端排队 / 处理 / 接收% / ✓ / 简）
//         ③ 调强度大框（tween-preview.js 自己订阅，这里不管）
//   数据：云端任务队列（V7CloudTools.onJob）+ 上面闸门的「等待中 / 准备中」。只改 DOM 的字，不重画卡片。
//   ⚠ 文案中性（用 V7CloudTools.jobText），不说在算什么。
// ══════════════════════════════════════════════════════════════════
var jobView=(()=>{
  const cloud=new Map();   // '任务:张' -> 最新的云端单状态
  const gates=new Map();   // '任务:张' -> {stage, ahead}
  const pending=new Set();
  let raf=0;
  const KIND_LABEL={color:'校色','color-version':'切换校色',detail:'补细节',tween:'调强度','tween-apply':'应用'};
  const k=(t,s)=>String(t)+':'+Number(s);
  function schedule(taskId){
    if(!taskId) return;
    pending.add(String(taskId));
    if(raf) return;
    // ⚠ 没有 requestAnimationFrame 的地方（测试沙箱）退回 setTimeout —— 标注不许把调用它的闸门弄崩
    const next=(typeof requestAnimationFrame==='function')?requestAnimationFrame:(fn=>setTimeout(fn,16));
    raf=next(()=>{ raf=0; const ids=[...pending]; pending.clear(); ids.forEach(paint); })||1;
  }
  function onCloud(s){
    if(!s||!s.taskId||!(s.shot>=0)) return;
    const key=k(s.taskId,s.shot);
    if(s.stage==='done'||s.stage==='failed'){
      cloud.set(key,s);
      // 完成 / 失败的标留 1.5 秒（让人看见「✓」），之后撤掉
      setTimeout(()=>{ const cur=cloud.get(key); if(cur&&cur.id===s.id){ cloud.delete(key); schedule(s.taskId); } },1500);
    }else cloud.set(key,s);
    schedule(s.taskId);
  }
  function gate(taskId,shot,st){
    const key=k(taskId,shot);
    if(st) gates.set(key,st); else gates.delete(key);
    schedule(taskId);
  }
  function shotText(taskId,shot){
    const s=cloud.get(k(taskId,shot));
    if(s&&window.V7CloudTools) return {text:V7CloudTools.jobText(s),stage:s.stage,kind:s.kind,tip:s.stage==='done'?V7CloudTools.jobBreakdown(s):''};
    const g=gates.get(k(taskId,shot));
    if(g) return {text:g.stage==='local-queue'?('等待中'+(g.ahead?' · 前面 '+g.ahead+' 个':'')):'准备中',stage:g.stage,kind:'color',tip:''};
    return null;
  }
  // 任务卡底栏：有活在跑才接管那行字，跑完交还原来的 task.sub
  function summary(task){
    if(!task) return '';
    const tid=String(task.taskId||task.id);
    const shots=task.shots||[];
    let active=null, activeIdx=-1, waitingN=0;
    shots.forEach((_,i)=>{
      const st=shotText(tid,i);
      if(!st||st.stage==='done'||st.stage==='failed') return;
      if(st.stage==='local-queue'){ waitingN++; if(active) return; }
      if(!active||(active.stage==='local-queue'&&st.stage!=='local-queue')){ active=st; activeIdx=i; }
    });
    if(!active) return '';
    const done=shots.filter(s=>s&&s.restoreState==='done').length;
    const kind=KIND_LABEL[active.kind]||'处理';
    const head=active.kind==='color'?('校色 '+done+'/'+shots.length+' · '):(kind+' · ');
    // 底栏地方窄：去掉括号里的「（2.5/6.8 MB）」（真软件冒烟时整行被截成「…上传 13%（…/13.6 MB）· 还…」），完整的在缩略图角标的悬停提示里
    const text=String(active.text||'').replace(/（[^）]*）/g,'');
    return head+'第 '+(activeIdx+1)+' 张 '+text+(waitingN&&active.stage!=='local-queue'?' · 还有 '+waitingN+' 张在等':'');
  }
  function paint(taskId){
    const task=typeof taskById==='function'?taskById(taskId):null;
    if(!task||typeof tasksEl==='undefined'||!tasksEl) return;
    const el=tasksEl.querySelector('.task[data-task="'+task.id+'"]');
    if(!el) return;
    const sub=el.querySelector('.t-sub');
    if(sub){ const s=summary(task); sub.textContent=s||task.sub||''; sub.classList.toggle('t-sub-live',!!s); }
    el.querySelectorAll('.pv-cell[data-shot-index]').forEach(cell=>paintCell(cell,task));
  }
  function paintCell(cell,task){
    const i=Number(cell.dataset.shotIndex);
    const shot=(task.shots||[])[i];
    const st=shotText(String(task.taskId||task.id),i);
    let badge=cell.querySelector('.pv-job');
    const fb=shot&&shot.colorFallback;
    if(!st&&!fb){ if(badge) badge.remove(); return; }
    if(!badge){ badge=document.createElement('span'); badge.className='pv-job'; (cell.querySelector('.pv-media')||cell).appendChild(badge); }
    if(st&&st.stage!=='done'){
      badge.dataset.stage=st.stage;
      // 角上地方小：只放最要紧的几个字（百分比 / 排位），整句放在悬停提示里
      //   ⚠ 别用 ↑ / ↓ 箭头：9.5px 字号下「↑29%」看着像「129%」（10-19 真软件冒烟截图看出来的）
      const pct=(st.text.match(/\d+%/)||[''])[0];
      const short={'local-queue':'等待','prepare':'准备','upload':'上传'+pct,'cloud-queue':'排队','processing':'处理','download':'接收'+pct,'failed':'失败'};
      badge.textContent=short[st.stage]||'';
      badge.title=(KIND_LABEL[st.kind]||'')+' · '+st.text;
    }else if(st&&st.stage==='done'){
      badge.dataset.stage='done'; badge.textContent='✓'; badge.title=st.tip||st.text;
    }else{
      // 云端 / 加速引擎没成、用了本机简化算法：常驻一个「简」，说清原因
      badge.dataset.stage='fallback'; badge.textContent='简';
      badge.title='这张没用上'+engineWord()+'，用的是本机简化校色（'+String(fb).slice(0,80)+'）';
    }
  }
  // 「没用上什么」：开着云端外挂说「云端校色」，否则说「加速引擎」（本机装了引擎但这次没成）
  function engineWord(){
    try{ return (window.V7CloudTools&&typeof V7CloudTools.routing==='function'&&V7CloudTools.routing())?'云端校色':'加速引擎'; }catch(_){ return '加速引擎'; }
  }
  if(window.V7CloudTools&&typeof V7CloudTools.onJob==='function') V7CloudTools.onJob(onCloud);
  return {gate,paint,paintCell,summary,shotText,schedule,engineWord};
})();
function aiHandleProgress(data){
  if(!data||!data.taskId)return;
  const current=taskById(data.taskId);
  if(!current||!aiRuntime.activeTasks[data.taskId]||current.cancelRequested||aiTaskIsTerminal(current))return;
  const progressScope=cacheNamespaceId(),progressEpoch=sourceImageEpoch;
  const ownsProgress=()=>progressScope===cacheNamespaceId()&&progressEpoch===sourceImageEpoch&&taskById(data.taskId)===current;
  const isCurrent=String(data.taskId)===String(aiRuntime.currentTaskId);
  if(data.phase==='started'){
    aiMarkActive(data.taskId,'generate');
    if(isCurrent){aiRuntime.progress=0;aiRuntime.status='请求已开始';}
    updateGenerationTask(data.taskId,{status:'running',sub:'请求已提交 · 0/'+data.total+' 张'});
    dbg('生成','请求已发出 · 共 '+data.total+' 张','ok');
  }else if(data.phase==='progress'){
    const pct=Math.round((Number(data.completed||0)/Math.max(1,Number(data.total||1)))*100);
    dbg('进度', data.error
      ? ('第 '+(Number(data.index)+1)+' 张失败：'+data.error)
      : ('第 '+(Number(data.index)+1)+' 张回来了 · '+data.completed+'/'+data.total+' ('+pct+'%)'),
      data.error?'warn':'info');
    const sub=data.error?'第 '+(Number(data.index)+1)+' 张失败：'+data.error:'已完成 '+data.completed+'/'+data.total+' 张（还原中）';
    if(isCurrent){aiRuntime.progress=pct;aiRuntime.status=sub;}
    const shots=current.shots.slice(),idx=Number(data.index)||0;
    shots[idx]=Object.assign({},shots[idx],{done:false,error:data.error||'',errorInfo:data.error?taskErrorInfo(data.error,'generate',data.code||'AI_IMAGE_FAILED'):null,imgId:'',restoreState:data.error?'failed':'pending'});
    updateGenerationTask(data.taskId,{status:'running',pct,shots,sub});
    if(data.image&&!data.error){
      aiRestoreTaskImage(current,Object.assign({},data.image,{index:idx})).then(rr=>{
        if(!ownsProgress())return;
        const live=taskById(data.taskId);if(!live||live.cancelRequested||aiTaskIsTerminal(live)||aiRuntime.activeTasks[data.taskId]!=='generate')return;
        const next=live.shots.slice();
        // ⚠ 缩略图在 IMG 里已经做好了才走到这一步，所以 restoreState 一置 done，
        //   渲染就一定拿得到图 —— 不会出现"先空白、图后跳出来"的闪烁。
        // ⚠⚠ 2026-10-05（docs/143 §二）：rawImgId / baseImgId 都必须在这里【显式往下传】。
        //   这是 B01 那个坑的同一形状：aiRestoreImage 明明返回了，但这一层只挑了几个字段
        //   复制过去 —— 没被挑中的字段【静默消失】，不报错。
        //   我这次漏了 baseImgId，探针实跑抓到（base 一张都没写）。
        // ⭐⭐ 2026-10-05（docs/143 §五）：小眼睛是【总阀门】——
        //   新回来的图必须跟着当前版本走。关着校色时进来的，显示的就该是底版。
        //
        //   ⚠⚠ 这里原来写死 rr.imgId（校色版），从来不看 task.colorVersion。
        //     后果：关掉小眼睛之后回来的图依旧是校色的 —— 用户实测报的
        //     「关闭校色预览时别的图传回来，它依旧是校色状态」。
        //     而且 cacheSaveTask 写 output_N.png 读的就是 shot.imgId，
        //     所以【连磁盘上的成品也是校色的】，不只是界面显示不对。
        //   ⚠ 必须同时记 colorImgId：否则切回校色版时没有那张图可用
        //     （切版本那条路靠 shot.colorImgId 找回校色版）。
        const wantBase=(taskColorVersion(live)==='base')&&!!rr.baseImgId;
        next[idx]=Object.assign({},next[idx],{done:true,error:'',errorInfo:null,
          imgId:wantBase?rr.baseImgId:rr.imgId,
          // ⭐⭐ docs/170 §4.3 不变量 8：这张的"自动方式结果"永远是 rr.imgId（AI 回来那张），
          //   【与 wantBase 无关】—— wantBase 只决定"现在显示哪张"，不决定"存档存哪张"。
          autoImgId:rr.imgId||'',
          colorImgId:rr.imgId||'',
          // ⭐ 2026-10-18：生成时实际用的那种校色（切版本靠它认「自动那一种」；没有 = 老逻辑当混合）
          autoVersion:rr.autoVersion||'',
          // ⭐ 2026-10-19：这张没用上云端 / 引擎、用了本机简化校色（缩略图常驻「简」角标，悬停说原因）
          colorFallback:rr.colorFallback||'',
          rawImgId:rr.rawImgId||'',baseImgId:rr.baseImgId||'',restoreState:'done'});
        updateGenerationTask(data.taskId,{status:'running',shots:next,sub:'已还原 '+next.filter(x=>x&&x.done).length+'/'+next.length+' 张'});
        // 降级不许静默：同一个任务只提示一次（一批里可能好几张都降级）
        if(rr.colorFallback&&!live._fallbackNoted){
          live._fallbackNoted=true;
          if(window.UI&&UI.toast) UI.toast('第 '+(idx+1)+' 张没用上'+jobView.engineWord()+'，改用了本机简化校色（缩略图上标「简」）', 'warn', 5000);
        }
      }).catch(e=>{
        if(!ownsProgress())return;
        const live=taskById(data.taskId);if(!live||live.cancelRequested||aiTaskIsTerminal(live)||aiRuntime.activeTasks[data.taskId]!=='generate')return;
        const next=live.shots.slice(),reason='还原失败：'+e.message;
        next[idx]=Object.assign({},next[idx],{done:false,error:reason,errorInfo:taskErrorInfo(e,'restore','AI_RESTORE_FAILED'),imgId:'',restoreState:'failed'});
        updateGenerationTask(data.taskId,{status:'running',shots:next,sub:reason});
      });
    }
  }else if(data.phase==='complete'){
    if(isCurrent){aiRuntime.progress=100;aiRuntime.status='生成完成，正在整理结果';}
    updateGenerationTask(data.taskId,{status:'running',pct:100,sub:'生成完成，正在还原图片'});
  }
  aiRefreshInPlace();
}
function aiCapture(after, modeOverride, onError, options){
  const ownerTaskId=options&&options.ownerTaskId;
  const ownsView=()=>!ownerTaskId||String(aiRuntime.currentTaskId||'')===String(ownerTaskId);
  const setView=(status,progress)=>{if(!ownsView())return;aiRuntime.status=status;if(progress!==undefined)aiRuntime.progress=progress;aiRefreshInPlace();};
  setView('正在从 Photoshop 抓取',0);
  if(isDebugOn()) dbg('抓取','开始 · 抓取上限 '+captureMaxEdge()+'px');
  const mode=Math.max(0,Math.min(2,Number(modeOverride===undefined?aiRuntime.antiMode:modeOverride)||0));
  let phaseTimer=setTimeout(()=>setView('正在读取 Photoshop 像素'),700);
  let encodeTimer=setTimeout(()=>setView('正在编码图片并传回'),1800);
  const clearPhase=()=>{clearTimeout(phaseTimer);clearTimeout(encodeTimer);};
  const allowFullCanvas=options&&options.allowFullCanvas!==undefined?!!options.allowFullCanvas:!!aiRuntime.autoFullCanvas;
  // ⭐ 2026-09-11：这里原先写死 4096，设置里那个滑块根本管不到它(铁律 15 说的假开关)。
  //   4096 = 64MB，实测被 AI 服务器以 413 退回。现在读设置，默认 2048(和 V6 一致)。
  return linkQueue('ps.selection.capture',{allowFullCanvas,maxResolution:captureMaxEdge(),antiMode:mode},{after:data=>{clearPhase();const fixed=Object.assign({},data,{antiMode:mode});if(ownsView()){aiRuntime.capture=fixed;aiRuntime.captureSnapshot=aiCaptureSnapshot(fixed,mode);}setView('已抓取 '+((data.width||0)+'×'+(data.height||0))+' · '+aiModeLabel(mode));aiAddLog('已加载 Photoshop 图片'+(data.docName?' · '+data.docName:' ')+' · '+aiModeLabel(mode));dbg('抓取','完成 '+((data.width||0)+'×'+(data.height||0))+(data.docName?(' · '+data.docName):'')+' · '+aiModeLabel(mode),'ok');if(after)after(fixed);},afterError:result=>{clearPhase();
    // ⭐ 抓取失败在这里报，不等它流到任务卡那一层(2026-09-11)。
    //   因为 Photoshop 回执里的 code 和 scene(位深/色彩模式/选区)只在这一层拿得到，
    //   再往下传就只剩一个字符串了 —— 那正是以前"抓取失败"查不出原因的根源。
    if(window.ERR) ERR.fromLinkResult(result,{stage:'capture',taskId:String(ownerTaskId||'')});
    else aiAddLog('加载 PS 图片失败：'+linkResultMessage(result),'error');
    setView('加载 PS 图片失败（详情看报错卡）');
    if(typeof onError==='function')onError(result);}});
}
// ⭐⭐ 预设名【提交这一刻现取】（2026-09-13 用户定案 · 照 V6 的架构）。
//
// ⚠⚠ 为什么不再靠"预设一变就推给生成侧"（原来的 onPromptChange 推送）：
//   推的路径只要漏掉一条就静默失效，而且**已经栽过两次**：
//     ① onPromptChange 的第二个参数一直被丢掉 → 任务卡从来不知道自己是哪条预设跑的
//     ② 重启后 preset-ui 的 loadPromptState 恢复了预设名，但【没有推给生成侧】，
//        而提示词正文自己会从临时缓存回来 —— 于是"提示词还在、预设名没了"，
//        点生成就显示「自定义提示词」（用户 2026-09-13 实测）。
//   V6 是各处提交时 `TileAPI.state.get('prompt.lastPresetTitle')` 现取的，
//   **现取没有"漏推"这种失败模式**。V6 v6.5.0 的原注释写着：
//     "预设名跟着落盘 — 修复重启后生成的缓存文件夹/生成记录只显示提示词内容不显示预设名"
//   —— 同一个 bug 人家修过，我们只复刻了一半。
//
// ⚠ 现取【只在提交那一刻做一次】（aiBeginImmediate / aiEnqueue），
//   取到就跟着任务走，之后用户再换预设也不会改已经跑起来的任务。
function presetTitleNow(){
  try{
    const PU=window.PRESETUI;
    if(PU&&typeof PU.getPresetOrigin==='function'){
      const o=PU.getPresetOrigin()||{};
      const t=String(o.title||'').trim();
      // ⚠ 预设侧说"没有来源"就是没有 —— 绝不回落到 aiRuntime 那份镜像。
      //   回落的话就是 V6 那个"幽灵预设名"：自己手打的词，挂着上一条预设的名字。
      if(!t) return '';
      let edited=!!o.edited;
      // 别处改的词（比如详情卡验证台里的提示词框）预设侧不知道 —— 比一下正文就能发现。
      // 两边本来是一字不差同步的（onPromptChange 直接赋值），不一样就说明被第三方改过。
      if(!edited&&typeof PU.getPromptText==='function'
         && String(aiRuntime.prompt||'')!==String(PU.getPromptText()||'')) edited=true;
      return t+(edited?' · 已改':'');
    }
  }catch(_){ }
  return String(aiRuntime.presetTitle||'');   // 预设系统没起来时的兜底
}
function aiWorkflowSnapshot(){
  const id=window.PRESETUI&&PRESETUI.prompt&&!PRESETUI.prompt.toolId&&PRESETUI.prompt.presetId;
  const preset=id&&window.PRESETS&&PRESETS.presetById(id);
  return {workflowPreset:preset&&(preset.workflow||preset.forgeWorkflow)?aiClonePlain(preset):null,preActionPreset:preset?aiClonePlain(preset):null,workflowSource:settingsRuntime.workflowSource,imageComputeSource:settingsRuntime.imageComputeSource,
    fieldHistorySnapshot:window.PRESETUI&&PRESETUI.captureFieldHistory?PRESETUI.captureFieldHistory({presetId:String(id||''),text:aiRuntime.prompt,workflowParameters:aiRuntime.workflowParameters}):null,
    workflowParameters:aiClonePlain(aiRuntime.workflowParameters||{}),workflowPresetId:String(aiRuntime.workflowPresetId||id||''),
    comfyUrl:settingsRuntime.comfyUrl,comfyKey:settingsRuntime.comfyKey,runninghubUrl:settingsRuntime.runninghubUrl,runninghubKey:settingsRuntime.runninghubKey};
}
/* ⭐⭐ 2026-10-08 新增：阿吉（AJI）的"分辨率钉在模型名里"兼容。

   用户给的规则（他看过阿吉的模型名单，原话）：
     "所有不带后缀的直接无视，然后我们那边就只显示，就是123K浓缩成一个模型选择，
      然后我们的分辨率就联动这个模型的后缀，然后一起发出去"

   阿吉的名单长这样（用户截图）：
     AJbanana2      AJbanana2-1k   AJbanana2-2k   AJbanana2-4k
     AJbanana3      AJbanana3-1k   AJbanana3-2k   AJbanana3-4k
     Banana-pro-A   …
   ⇒ 规则 = 【基础名 + '-' + 档位】。

   ⇒ 界面上：三档【浓缩成一个模型名】（显示 AJbanana3，不带后缀），
     分辨率栏保持不变；发出去的时候把后缀接上（AJbanana3 + 2K → "AJbanana3-2k"）。

   ⚠⚠ 三条边界：
     1.【只对阿吉做】—— 用户明确定的："你只需要根据阿吉的这个逻辑来做阿吉的兼容，
       阿吉的渠道单独做"。别的服务商（默默/自定义/后台模型）的 id 原样发，一个字不改。
     2.【只在没有后缀时才接】—— 已经是 AJbanana3-2k 这种（老预设里存过的）就不再接，
       否则会接成 AJbanana3-2k-2k。
     3.【接不上就不接】—— 档位不是 1K/2K/4K 之一（比如工作流那种"工作流尺寸"）时原样返回，
       绝不硬拼一个可能不存在的模型名（拼错 = 请求 404，而且用户不知道为什么）。
*/
const AJI_SIZE_SUFFIX=/-(?:1k|2k|4k)$/i;
/* ⭐⭐ 2026-10-15 修（用户报：「本地前端似乎把 GPT Image 筛掉了」）：
   原来只要档位合法就一律接后缀 ⇒ gpt-image-2 被发成 gpt-image-2-2k（阿吉不认，必失败）。
   ⇒ 第三个参数 names = 阿吉名单（检查连接拉到的那份），据它判断：
     · 名单里有「名-档」⇒ 发【名单里那个原样】（大小写以阿吉为准，比如 -2k）
     · 名单里根本没有这个模型的分档版本 ⇒ 不分档模型，【原名发】
     · 只是缺这一档（有 -1k/-4k 没 -2k）⇒ 照旧接（跟原来一样，阿吉会明确报错）
   · 名单不在手边时，再看价目表：价目表里它只有不带后缀的那一行 ⇒ 也按不分档原名发。
   ⚠ 别把这段挪出 ajiModelId 另起函数：tests/assistant-plan-integration.test.js 按源码顺序
     切 ajiModelId → isAjiConnection → modelForRequest → aiPayload 这一段跑，中间多一个
     顶层函数也没事，但挪到 ajiModelId 前面就切不到了。 */
function ajiModelId(base,size,names){
  const 名=String(base||'').trim();
  if(!名)return 名;
  // 档位必须是 1K / 2K / 4K 之一；别的（Auto、工作流尺寸、空）都不接后缀
  const 档=String(size||'').trim().toUpperCase();
  if(!['1K','2K','4K'].includes(档))return 名;
  if(AJI_SIZE_SUFFIX.test(名))return 名;                  // 已经带后缀 ⇒ 不重复接
  const ids=Array.isArray(names)?names.map(x=>typeof x==='string'?x:(x&&(x.id||x.name))||'').filter(Boolean):[];
  const 小=名.toLowerCase();
  if(ids.length){
    const want=小+'-'+档.toLowerCase();
    const exact=ids.find(id=>String(id).toLowerCase()===want);
    if(exact)return String(exact);                       // 用名单里的原样大小写
    const 有分档=ids.some(id=>AJI_SIZE_SUFFIX.test(id)&&String(id).replace(AJI_SIZE_SUFFIX,'').toLowerCase()===小);
    if(!有分档)return 名;                                 // 不分档的模型（gpt-image-2 这种）⇒ 原名发
  }else{
    try{
      const 价=window.V7AjiPrices&&typeof window.V7AjiPrices.priceFor==='function'?window.V7AjiPrices.priceFor(名,档):null;
      if(价&&String(价.model||'').toLowerCase()===小)return 名;   // 价目表里只有不带后缀那一行 ⇒ 不分档
    }catch(_){}
  }
  return 名+'-'+档.toLowerCase();
}
// 这条连接是不是阿吉（只有它要按上面那套规则拼后缀）
function isAjiConnection(s){
  try{
    const slot=String((s&&s.connectionSlot)||(s&&s.provider)||'');
    return slot==='aji';
  }catch(_){ return false; }
}
// 只给"阿吉 + 没后缀 + 档位合法 + 确实有分档版本"的那种接后缀；其余一律原样
function modelForRequest(s){
  const 名=String((s&&s.model)||'').trim();
  // ⭐ 2026-10-24（V7待办/02）：阿吉 / 墨墨后台模型目录里有这个模型 ⇒ 按目录拼（拼不拼 -2K、大小写都由供应商定）。
  //   墨墨原来一律原名发（isAjiConnection 只认阿吉），现在也走目录。目录里没有 ⇒ 照老规矩。
  try{
    const slot=String((s&&(s.connectionSlot||s.provider))||'');
    if((slot==='aji'||slot==='momo')&&window.V7SupplierModels){
      const id=V7SupplierModels.requestId(slot,名,s&&s.size);
      if(id){
        // ⚠⚠ P0（10-24）：目录是从老价目表换算的（写的 AJbanana3-2K 大写），阿吉真名是 AJbanana3-2k ⇒ 阿吉回 model_not_found，全员出不了图。
        //   服务商自己的 /v1/models 名单里有这个名字（不分大小写）⇒ 一律用名单里的原样写法发；名单没拉到才信目录。
        let 名单=null;
        try{ 名单=window.V7ProviderSettings&&typeof window.V7ProviderSettings.modelsFor==='function'?window.V7ProviderSettings.modelsFor(slot):null; }catch(_){ 名单=null; }
        const 原样=(Array.isArray(名单)?名单:[]).map(x=>typeof x==='string'?x:String(x&&(x.id||x[0])||'')).find(x=>x&&x.toLowerCase()===id.toLowerCase());
        return 原样||id;
      }
    }
  }catch(_){}
  if(!isAjiConnection(s))return 名;
  let 名单=null;
  try{ 名单=window.V7ProviderSettings&&typeof window.V7ProviderSettings.modelsFor==='function'?window.V7ProviderSettings.modelsFor('aji'):null; }catch(_){ 名单=null; }
  return ajiModelId(名,s&&s.size,名单);
}
function aiPayload(snapshot){
  const s=snapshot||aiRuntime;
  // 优先读取显式任务快照；仅在旧调用没有快照时回退到全局 capture。
  const c=s.captureSnapshot||s.capture||(snapshot?null:aiRuntime.capture);
  const snap=s.captureSnapshot||aiCaptureSnapshot(c,s.antiMode);
  // ⚠ prompt 在这里过一遍净化(V6 同款 sanitizePrompt)：填空标记换成值、
  //   滑块拉到 0 的模块整块剔除。这是【发送前的最后一道】，
  //   原文(aiRuntime.prompt / 预设内容)一个字不动。
  const taskId=String(s.taskId||aiNewTaskId('ai')); const apiKey=aiSessionSecrets.get(taskId)||s.apiKey||'';
  const preset=s.workflowPreset||null;
  const rawWorkflow=preset&&(preset.workflow||preset.forgeWorkflow);
  // Canonical execution config keeps the API prompt and its mappings together.
  // Legacy presets with top-level mappings are normalized here; RH imports are
  // already wrapped and pass through unchanged.
  const workflow=rawWorkflow&&window.V7Workflows ? aiClonePlain(V7Workflows.normalizeConfig(rawWorkflow,preset)) : null;
  const workflowProvider=preset&&((workflow&&(preset.provider||'comfyui'))||(/^(comfyui|forge|runninghub|rh)$/.test(preset.provider||'')?preset.provider:''));
  const prompt= sanitizePrompt(s.prompt);
  // Converted Forge presets carry normalized values so the runtime can apply
  // them through the declared node bindings. The visible prompt remains the
  // user's editable positive prompt and therefore wins over the imported one.
  const sameWorkflowPreset=!preset||!s.workflowPresetId||String(s.workflowPresetId)===String(preset.id);
  const workflowParameters=workflow?Object.assign({}, preset&&preset.parameters||{}, sameWorkflowPreset?(s.workflowParameters||{}):{}):{};
  const batch=Math.max(1,Math.min(AI_BATCH_MAX,Number(s.batch)||1));
  for(const binding of workflow&&workflow.parameterBindings||[]){
    if(binding.key==='positivePrompt'||binding.source==='prompt')workflowParameters[binding.key]=prompt;
    if(/^(imageCount|batch|count)$/.test(binding.key))workflowParameters[binding.key]=batch;
  }
  const payload = {taskId,protocol:s.protocol,provider:workflowProvider||s.provider,baseUrl:workflowProvider?(workflowProvider==='runninghub'||workflowProvider==='rh'?s.runninghubUrl:s.comfyUrl):s.baseUrl,endpoint:s.endpoint,apiKey:workflowProvider?(workflowProvider==='runninghub'||workflowProvider==='rh'?s.runninghubKey:s.comfyKey):apiKey,authMode:s.authMode,model:s.model,size:s.size,aspectRatio:s.aspectRatio,batch,prompt,presetTitle:String(s.presetTitle||''),presetId:preset&&preset.id||s.presetId||'',presetVersion:preset&&preset.version||s.presetVersion||'',platformPresetId:preset&&preset.platformPresetId||'',workflow,workflowParameters,workflowPresetId:preset&&preset.id||s.workflowPresetId||'',workflowNeedsReview:!!(preset&&preset.needsReview),computeSource:workflowProvider?(s.workflowSource||s.computeSource):(s.imageComputeSource||'own'),antiMode:Math.max(0,Math.min(2,Number(s.antiMode)||0)),inputImageBase64:snap&&String(snap.inputImageBase64||snap.imageBase64||''),sourceImageBase64:snap&&String(snap.sourceImageBase64||snap.inputImageBase64||snap.imageBase64||''),inputMime:snap&&snap.mime,refImages:s.refImages||[],captureSnapshot:snap};
  // ⚠⚠ 2026-10-08：阿吉的模型名要【在发送这一刻】把分辨率后缀接上
  //   （界面显示的是不带后缀的 AJbanana3，发出去的是 AJbanana3-2k）。
  //   ⚠ 只改【走中转站出图】这一条路（workflow 那条下面会自己覆盖 payload.model，
  //     那是工作流自己的模型清单名，绝不能接分辨率后缀）。
  payload.model=modelForRequest(s);
  // ⭐ 2026-10-23：壳里 GPT Image 要改走 /images/edits，但 GRS 的 GPT 不算（另一套协议）。
  //   GRS 时 provider 是 other，光看 provider 分不出来 ⇒ 把连接槽位带下去（判据同 grsTaskTargets）。
  payload.connectionSlot=String(s.connectionSlot||(s.provider==='grs'?'grs':'')||'');
  if(workflow){
    const checkpoints=Object.entries(workflow.prompt||{}).map(([nodeId,node])=>{
      const binding=(workflow.parameterBindings||[]).find(item=>String(item.nodeId)===nodeId&&item.input==='ckpt_name');
      return binding&&workflowParameters[binding.key]!=null?workflowParameters[binding.key]:node&&node.inputs&&node.inputs.ckpt_name;
    }).filter(name=>typeof name==='string');
    payload.model=checkpoints.length?checkpoints.join(' + '):String(preset.title||'工作流');
    payload.size=workflowParameters.resolution!=null?String(workflowParameters.resolution)+'px':'工作流尺寸';
    payload.aspectRatio='Auto';
  }
  return payload;
}
