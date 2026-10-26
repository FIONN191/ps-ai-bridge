// ═══ ui-main/02-core-state.js —— 主界面主程序第 2 / 21 段 ═══
//   管什么：核心交互：当前卡 / 二级 / 三级的状态 · 各张大二级的实例 · 最小链路运行时状态
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 核心交互 ═══
const stack=document.getElementById('stack');
const zones=document.getElementById('zones');
const detail=document.getElementById('detail');
const cards=[...stack.querySelectorAll('.block-card')];
const N=cards.length;
// ⚠ 主卡索引一律用这两个常量，别再写死 4 / 5。
//   它们从 DOM 的 data-card 反查，所以以后在前面插回"修图"等卡片时，
//   索引自动跟着变，不用再满世界找魔法数字(2026-09-08 删占位卡时踩过)。
const CARD_GENERATION = cards.findIndex(c=>c.dataset.card==='generation');
const CARD_PRESETS    = cards.findIndex(c=>c.dataset.card==='presets');
const CARD_SETTINGS   = cards.findIndex(c=>c.dataset.card==='settings');
const CARD_ENGINES    = cards.findIndex(c=>c.dataset.card==='engines');
const CARD_HISTORY    = cards.findIndex(c=>c.dataset.card==='history');
const CARD_PROJECTS = cards.findIndex(c=>c.dataset.card==='projects');
const CARD_ASSISTANT = cards.findIndex(c=>c.dataset.card==='assistant');
const CARD_DEBUG = cards.findIndex(c=>c.dataset.card==='debug');
// ⭐ 2026-10-18 深夜：问题反馈卡（单张大二级，没有三级；内容 feedback-card.js）
const CARD_FEEDBACK = cards.findIndex(c=>c.dataset.card==='feedback');
// ⭐ 2026-10-20：社区卡（单张大二级，没有三级；内容 community-card.js）
const CARD_COMMUNITY = cards.findIndex(c=>c.dataset.card==='community');
// ⚠ 2026-10-14：CARD_TUTORIAL 删了 —— 教程卡整张已删（用户定：教程要重做）。
//   实测它【没有任何地方用】（全项目搜过只剩这一行定义本身），属于死常量：
//   findIndex 找不到会返回 -1，不报错，所以它一直是"静默废着"的。
//   重做教程卡时加回来，并检查有没有别处该用它（清单见 docs/217）。
// 预设卡的二级是单张长卡，跟其它主卡的 4 张分区卡不是一套(docs/28 §5.2)
const presetZoneEl = document.getElementById('presetZone');
const promptZoneEl = document.getElementById('promptZone');
// ⭐ 记录与恢复卡的二级（2026-09-30）。⚠ 和上面两个不是同一族的形态：
//   它只有"开/关"，没有 kind 切换（记录卡没有三级，二级就是全部）。
const recordsZoneEl = document.getElementById('recordsZone');
// ⭐ 设置卡的二级（2026-10-01）。同族形态：只有"开/关"，没有 kind 切换。
const settingsZoneEl = document.getElementById('settingsZone');
// ⭐ 外挂能力卡的二级（2026-10-01）。同族形态：只有"开/关"，没有 kind 切换。
//   ⚠ 右栏是【档位梯子】，和记录卡（检查点时间轴）、设置卡（tab 导航）都不一样 ——
//     但那是卡内部的事，宿主只管开和关。
const enginesZoneEl = document.getElementById('enginesZone');
// ⭐ 生成卡的二级（2026-10-15）。同族形态：只有"开/关"，没有 kind 切换，也没有三级。
const generationZoneEl = document.getElementById('generationZone');
// ⚠ 卡片实例【在这里就声明】，不跟设置卡那样放到后面 —— syncZoneKind 读它，
//   若启动期间先跑到 syncZoneKind 再跑到 let 那一行，就是 const/let 暂时性死区，
//   整个主脚本抛错死掉（铁律 17 表里那条"窗口不能滚动/折叠/拖拽"）。
let generationCard = null;
// ⭐ 助手卡的二级（2026-10-17 夏三六）。同族：只有开/关，没有三级。⚠ 同上，实例在这里就声明。
const assistantZoneEl = document.getElementById('assistantZone');
let assistantCard = null;
// ⭐ 问题反馈卡的二级（2026-10-18 深夜）。同族：只有开/关，没有三级。⚠ 同上，实例在这里就声明（防暂时性死区）。
const feedbackZoneEl = document.getElementById('feedbackZone');
let feedbackCard = null;
const communityZoneEl = document.getElementById('communityZone');
let communityCard = null;
// 预设卡的二级有两种形态(用户 2026-09-11 定案): 'list' = 点部位弹的预设列表; 'prompt' = 右滑弹的提示词框。
// 二级位置永远只有一个, 后来者居上。
let presetZoneKind = 'list';
function isPresetCard(){ return cur===CARD_PRESETS; }
// 切主卡时: 预设卡露单卡藏四卡，其它卡反过来
// 上一次二级显示的是哪一种（'normal' 四张分区卡 / 'list' 预设列表 / 'prompt' 提示词框）。
// ⚠ 用来判断"这一次是不是刚换了种类" —— 换种类时那张卡是从 display:none 冒出来的，
//   它身上还留着上次的内容，再去淡出它就是在淡出一堆旧东西（用户看到的"闪烁+慢一拍"）。
let lastZoneKind = null;

// 返回 true = 这次调用切换了二级的种类
function syncZoneKind(){
  const on = isPresetCard();
  // ⚠ 恢复显示【之前】必须先摘掉残留的 .glow(2026-09-11)。
  //   display:none → '' 会让 CSS animation 从头重播，class 还挂着就会白亮一次
  //   ——「上下滚动时二级卡也发光」就是这么来的。
  //   正常情况下 animationend 已经摘干净了；这里兜的是"动画没播完就被切走"那种,
  //   那时候 animationend 永远不会来，class 就永久留下了。
  if(!on){
    zones.querySelectorAll('.zone:not(.pzone) .zone-glow.glow, .zone:not(.pzone) .zone-bright.glow')
      .forEach(el=>el.classList.remove('glow'));
  }
  const availableZones=ZONE_SETS[cur]||[];
  // ⭐ 记录与恢复卡（2026-09-30）：它是【单张大二级】，四张普通分区卡【一张都不该露】。
  //   ⚠⚠ 下面那条 `on||!availableZones[i]` 只藏"没有对应分区的"那几张 ——
  //     记录卡只剩一格，第 0 张有分区所以会被留着，于是顶上会挂着一张
  //     属于别的主卡的旧二级卡（实装第一版截图里那个「调色」就是它）。
  //     所以记录卡必须整组跳过，单独把它自己那张收掉。
  const recordsOnly=isRecordsCard();
  // ⭐ 设置卡（2026-10-01）：同上，它也是【单张大二级】，四张普通分区卡一张都不该露。
  const settingsOnly=isSettingsCard();
  // ⭐ 外挂能力卡（2026-10-01）：同上，也是【单张大二级】。
  const enginesOnly=isEnginesCard();
  // ⭐ 生成卡（2026-10-15）：同上，也是【单张大二级】。
  const generationOnly=isGenerationCard();
  // ⭐ 助手卡（2026-10-17）：同上，也是【单张大二级】。
  const assistantOnly=isAssistantCard();
  // ⭐ 问题反馈卡（2026-10-18 深夜）：同上，也是【单张大二级】。
  const feedbackOnly=isFeedbackCard();
  // ⭐ 社区卡（2026-10-20）：同上，也是【单张大二级】。
  const communityOnly=isCommunityCard();
  const singleOnly=recordsOnly||settingsOnly||enginesOnly||generationOnly||assistantOnly||feedbackOnly||communityOnly;
  zones.querySelectorAll('.zone:not(.pzone)').forEach((z,i)=>{
    z.style.display = (on||singleOnly||!availableZones[i]) ? 'none' : '';
  });
  if(presetZoneEl) presetZoneEl.style.display = (on && presetZoneKind==='list') ? '' : 'none';
  if(promptZoneEl) promptZoneEl.style.display = (on && presetZoneKind==='prompt') ? '' : 'none';
  if(recordsZoneEl){
    const recOn=recordsOnly&&recordsCard&&recordsCard.isOpen();
    recordsZoneEl.style.display=recOn?'':'none';
    if(recOn) zoneSel=0;
  }
  if(settingsZoneEl){
    const setOn=settingsOnly&&settingsCard&&settingsCard.isOpen();
    settingsZoneEl.style.display=setOn?'':'none';
    if(setOn) zoneSel=0;
  }
  if(enginesZoneEl){
    const engOn=enginesOnly&&enginesCard&&enginesCard.isOpen();
    enginesZoneEl.style.display=engOn?'':'none';
    if(engOn) zoneSel=0;
  }
  if(generationZoneEl){
    const genOn=generationOnly&&generationCard&&generationCard.isOpen();
    generationZoneEl.style.display=genOn?'':'none';
    if(genOn) zoneSel=0;
  }
  if(assistantZoneEl){
    const asOn=assistantOnly&&assistantCard&&assistantCard.isOpen();
    assistantZoneEl.style.display=asOn?'':'none';
    if(asOn) zoneSel=0;
  }
  if(feedbackZoneEl){
    const fbOn=feedbackOnly&&feedbackCard&&feedbackCard.isOpen();
    feedbackZoneEl.style.display=fbOn?'':'none';
    if(fbOn) zoneSel=0;
  }
  if(communityZoneEl){
    const ccOn=communityOnly&&communityCard&&communityCard.isOpen();
    communityZoneEl.style.display=ccOn?'':'none';
    if(ccOn) zoneSel=0;
  }
  // ⚠ 预设卡只有一个分区, zoneSel 必须归 0 —— 否则从"生成"卡的第 4 分区切过来时
  //   zoneSel 还是 3, updateDetailBg 会算出 detail.presets.zone3 这种野槽位,
  //   主题包永远对不上(这类"安静地不对"正是铁律 17 说的静默失效)。
  if(on) zoneSel = 0;
  else zoneSel=Math.max(0,Math.min(zoneSel,availableZones.length-1));
  const kind = on ? presetZoneKind : 'normal';
  const changed = (lastZoneKind !== null && lastZoneKind !== kind);
  lastZoneKind = kind;
  return changed;
}

// ⚠ 原来这里有一段背景一次性迁移(2026-09-08 删占位主卡时写的, 把 card-4 搬到 card-0)。
//   2026-09-10 背景 key 已整体改成语义名(card.generation 这种), 旧的序号体系整个作废,
//   那段迁移已无意义且有害(它会把旧序号 key 写回 IndexedDB)。已删除。
//   当时用户还没设过任何背景图, 所以直接换方案、不需要迁移 —— 见 docs/24。
let cur=0, zoneOpen=false, zoneSel=0;
let layoutOrder=cards.map((_,index)=>index);
let layoutHidden=new Set();
function layoutVisibleIndices(){return layoutOrder.filter(index=>!layoutHidden.has(index)&&cards[index]);}
function applyLayoutCards(layout){
  if(!layout||!Array.isArray(layout.cards))return;
  const byId=new Map(cards.map((card,index)=>[card.dataset.card,index]));
  const nextOrder=[];layout.cards.forEach(row=>{const index=byId.get(row.id);if(index!==undefined)nextOrder.push(index);});
  cards.forEach((_,index)=>{if(!nextOrder.includes(index))nextOrder.push(index);});
  layoutOrder=nextOrder;layoutHidden=new Set(layout.cards.filter(row=>row.hidden).map(row=>byId.get(row.id)).filter(index=>index!==undefined));
  // 设置页承载布局恢复入口，始终保留设置卡可访问；否则隐藏设置卡后无法找回布局管理器。
  if(CARD_SETTINGS>=0)layoutHidden.delete(CARD_SETTINGS);
  const visible=layoutVisibleIndices();
  if(!visible.length){layoutHidden.delete(CARD_GENERATION);visible.push(CARD_GENERATION);}
  if(!visible.includes(cur))cur=visible[0];
  setStack();
}
function layoutActiveId(){return cards[cur]?.dataset.card||'generation';}
function layoutAppearance(){return {
  opacity:String(settingsRuntime?.opacity||100),blur:String(settingsRuntime?.blur||24),
  themeCardBg:String(settingsRuntime?.themeCardBg||''),themeText:String(settingsRuntime?.themeText||''),
  themeAccent:String(settingsRuntime?.themeAccent||''),themeNoTint:!!settingsRuntime?.themeNoTint
};}
function layoutApplyAppearance(values){if(!values||typeof values!=='object')return;Object.assign(settingsRuntime,values);settingsSave();}
let isCollapsed=false;
let collapseSnapshot=null;
// ── V8 最小链路运行时状态 ──
// 只保存本次 UI 会话的测试结果和日志；真实 PS 状态始终以 UXP 回执为准。
const LINK_TESTS={capture:{label:'抓取测试',status:'idle'},transfer:{label:'传回测试',status:'idle'},generate:{label:'生成测试',status:'idle'},control:{label:'控制 PS 测试',status:'idle'}};
const LINK_DEFAULT_ACTIONS=[
  ['ps.doc.info','读取当前文档'],['ps.doc.listOpen','列出打开文档'],['listDocuments','V6 列出文档'],['ps.doc.select','切换文档'],['ps.doc.export','导出当前文档'],
  ['getDocInfo','V6 读取文档信息'],['fetchOpenDocs','V6 列出打开文档'],['activateDocument','V6 激活文档'],
  ['ps.selection.rect','读取选区矩形'],['ps.selection.capture','抓取选区像素'],['ps.selection.captureRef','抓取参考图'],['ps.selection.recaptureRef','重新抓取参考图'],['ps.selection.captureForChat','抓取聊天图'],['ps.selection.restore','恢复历史选区'],['ps.selection.clear','取消选区'],['ps.selection.ops','选区操作'],
  ['captureRefImage','V6 抓取参考图'],['recaptureRefImage','V6 重新抓取参考图'],['captureForChat','V6 抓取聊天图'],['restoreSelectionFromHistory','V6 恢复历史选区'],['probeSelectionRect','V6 探测选区矩形'],
  ['ps.marquee.sync','同步选框比例'],['ps.marquee.import','导入选框预设'],['syncMarqueeAspect','V6 同步选框比例'],['importMarqueePresets','V6 导入选框预设'],
  ['ps.layer.list','列出图层'],['ps.layer.select','选择图层'],['ps.layer.create','新建图层'],['ps.layer.rename','重命名图层'],['ps.layer.delete','删除图层'],
  ['ps.layer.visibility','切换图层可见'],['ps.layer.opacity','设置图层不透明度'],['ps.layer.solo','独显当前图层'],['soloLayer','V6 独显图层'],['ps.layer.gotoMask','选择图层蒙版'],['gotoLayerMask','V6 跳转图层蒙版'],['conversationLayerVisibility','V6 对话图层显隐'],['collapseAllGroups','V6 折叠所有图层组'],
  ['ps.layer.place','贴回单张图片'],['ps.layer.placeBatch','批量贴回图片'],['ps.layer.placeClipped','嵌入贴回(剪切蒙版)'],['ps.group.create','创建编组'],['ps.group.stampProbe','探测盖印图层'],['ps.mask.feather','应用羽化蒙版'],['ps.mask.magentaFix','应用修复曲线'],
  ['ps.channel.list','列出通道'],['ps.channel.visibility','切换通道可见']
];
// 所有可执行 PS action 的统一说明。label 只负责短标题，what/requires/params 负责让
// 用户在点击前知道动作效果、前置条件和参数来源；V6 别名也保留独立条目，便于逐项验证。
const LINK_ACTION_META={
  'ps.doc.info':{label:'读取当前文档',what:'读取当前 Photoshop 文档的名称、尺寸、色彩模式和活动图层。',requires:'至少打开一个 Photoshop 文档。',params:'无需填写参数。'},
  'ps.doc.listOpen':{label:'列出打开文档',what:'返回 Photoshop 当前打开的全部文档及尺寸。',requires:'Photoshop 正在运行；可没有打开文档。',params:'无需填写参数。'},
  'listDocuments':{label:'V6 列出文档',what:'按 V6 兼容接口返回当前打开文档列表。',requires:'Photoshop 正在运行；可没有打开文档。',params:'无需填写参数。'},
  'ps.doc.select':{label:'切换文档',what:'把指定文档设为 Photoshop 当前活动文档。',requires:'目标文档仍处于打开状态。',params:'填写“文档 ID”。'},
  'ps.doc.export':{label:'导出当前文档',what:'把当前文档导出到指定 Windows 路径。',requires:'至少打开一个文档，并且导出目录可写。',params:'填写“导出 file:/ 路径”。'},
  'getDocInfo':{label:'V6 读取文档信息',what:'通过 V6 兼容接口读取活动文档信息。',requires:'至少打开一个 Photoshop 文档。',params:'无需填写参数。'},
  'fetchOpenDocs':{label:'V6 列出打开文档',what:'通过 V6 兼容接口列出全部打开文档。',requires:'Photoshop 正在运行。',params:'无需填写参数。'},
  'activateDocument':{label:'V6 激活文档',what:'通过 V6 兼容接口切换活动文档。',requires:'目标文档仍处于打开状态。',params:'填写“文档 ID”。'},
  'ps.selection.rect':{label:'读取选区矩形',what:'读取当前文档选区的 x、y、宽度和高度。',requires:'至少打开一个文档；有选区时返回实际矩形。',params:'无需填写参数。'},
  'ps.selection.capture':{label:'抓取选区像素',what:'抓取当前选区像素并传回 UI，保存为最近图片。',requires:'至少打开一个文档；默认需要有效选区。',params:'勾选“无选区时自动使用整张画布”可改用全画布。'},
  'ps.selection.captureRef':{label:'抓取参考图',what:'抓取当前选区作为参考图传回 UI。',requires:'至少打开一个文档；默认需要有效选区。',params:'自动读取选区；可开启整张画布开关。'},
  'ps.selection.recaptureRef':{label:'重新抓取参考图',what:'重新读取 Photoshop 当前选区，替换最近参考图。',requires:'至少打开一个文档；默认需要有效选区。',params:'自动读取选区；可开启整张画布开关。'},
  'ps.selection.captureForChat':{label:'抓取聊天图',what:'按聊天链路限制抓取选区像素并传回 UI。',requires:'至少打开一个文档；默认需要有效选区。',params:'自动读取选区；可开启整张画布开关。'},
  'ps.selection.restore':{label:'恢复历史选区',what:'把最近抓取结果中的选区恢复到 Photoshop。',requires:'至少打开一个文档，并且 UI 中已有抓取记录。',params:'可填写“文档 ID”；选区来自最近抓取图。'},
  'ps.selection.clear':{label:'取消选区',what:'清除当前 Photoshop 文档的选区。',requires:'至少打开一个文档。',params:'无需填写参数。'},
  'ps.selection.ops':{label:'选区操作',what:'执行当前 UI 预设的选区原子操作，本验证版默认为清除选区。',requires:'至少打开一个文档。',params:'无需填写参数；当前固定 operation=clear。'},
  'captureRefImage':{label:'V6 抓取参考图',what:'调用 V6 兼容接口抓取选区参考图并传回 UI。',requires:'至少打开一个文档；默认需要有效选区。',params:'自动读取选区；可开启整张画布开关。'},
  'recaptureRefImage':{label:'V6 重新抓取参考图',what:'调用 V6 兼容接口重新抓取当前选区参考图。',requires:'至少打开一个文档；默认需要有效选区。',params:'自动读取选区；可开启整张画布开关。'},
  'captureForChat':{label:'V6 抓取聊天图',what:'调用 V6 兼容接口抓取聊天用图像并传回 UI。',requires:'至少打开一个文档；默认需要有效选区。',params:'自动读取选区；可开启整张画布开关。'},
  'restoreSelectionFromHistory':{label:'V6 恢复历史选区',what:'调用 V6 兼容接口恢复最近抓取记录中的选区。',requires:'至少打开一个文档，并且 UI 中已有抓取记录。',params:'可填写“文档 ID”；选区来自最近抓取图。'},
  'probeSelectionRect':{label:'V6 探测选区矩形',what:'调用 V6 兼容接口探测当前选区的矩形范围。',requires:'至少打开一个文档。',params:'无需填写参数。'},
  'ps.marquee.sync':{label:'同步选框比例',what:'把指定比例同步到 Photoshop 选框工具设置。',requires:'Photoshop 正在运行。',params:'填写“选框比例”，例如 1:1 或 16:9。'},
  'ps.marquee.import':{label:'导入选框预设',what:'向 Photoshop 导入当前验证版的选框比例预设。',requires:'Photoshop 正在运行。',params:'当前使用“选框比例”作为预设来源。'},
  'syncMarqueeAspect':{label:'V6 同步选框比例',what:'通过 V6 兼容接口同步选框比例。',requires:'Photoshop 正在运行。',params:'填写“选框比例”，例如 1:1 或 16:9。'},
  'importMarqueePresets':{label:'V6 导入选框预设',what:'通过 V6 兼容接口导入选框比例预设。',requires:'Photoshop 正在运行。',params:'当前使用“选框比例”作为预设来源。'},
  'ps.layer.list':{label:'列出图层',what:'读取当前文档的图层树和图层属性。',requires:'至少打开一个 Photoshop 文档。',params:'无需填写参数。'},
  'ps.layer.select':{label:'选择图层',what:'把指定图层设为 Photoshop 当前活动图层。',requires:'目标图层存在且所属文档已打开。',params:'填写“图层 ID”，可选“文档 ID”。'},
  'ps.layer.create':{label:'新建图层',what:'在当前文档创建一个普通图层。',requires:'至少打开一个文档，并允许修改文档。',params:'填写“图层名称”。'},
  'ps.layer.rename':{label:'重命名图层',what:'修改指定图层的名称。',requires:'目标图层存在且所属文档已打开。',params:'填写“图层 ID”和“图层名称”。'},
  'ps.layer.delete':{label:'删除图层',what:'删除指定图层。此操作会直接修改 Photoshop 文档。',requires:'目标图层存在且可删除；建议先在临时文档测试。',params:'填写“图层 ID”，可选“文档 ID”。'},
  'ps.layer.visibility':{label:'切换图层可见',what:'设置指定图层的显示或隐藏状态。',requires:'目标图层存在且所属文档已打开。',params:'填写“图层 ID”，再设置“可见”开关。'},
  'ps.layer.opacity':{label:'设置图层不透明度',what:'设置指定图层的不透明度百分比。',requires:'目标图层存在且支持不透明度。',params:'填写“图层 ID”和 0-100 的“不透明度”。'},
  'ps.layer.solo':{label:'独显当前图层',what:'隐藏同层其他图层，只保留目标图层可见。',requires:'目标图层存在；嵌套图层需要其父组可访问。',params:'填写“图层 ID”。'},
  'soloLayer':{label:'V6 独显图层',what:'通过 V6 兼容接口独显指定图层。',requires:'目标图层存在；嵌套图层需要其父组可访问。',params:'填写“图层 ID”。'},
  'ps.layer.gotoMask':{label:'选择图层蒙版',what:'选择指定图层并尝试激活它的图层蒙版通道。',requires:'目标图层存在且已有图层蒙版。',params:'填写“图层 ID”，可选“文档 ID”。'},
  'gotoLayerMask':{label:'V6 跳转图层蒙版',what:'通过 V6 兼容接口选择图层蒙版。',requires:'目标图层存在且已有图层蒙版。',params:'填写“图层 ID”，可选“文档 ID”。'},
  'conversationLayerVisibility':{label:'V6 对话图层显隐',what:'按对话链路规则批量设置拥有图层的显隐或独显状态。',requires:'目标图层存在；批量图层 ID 应属于当前文档。',params:'填写“图层 ID”和逗号分隔的“图层 ID（逗号分隔）”。'},
  'collapseAllGroups':{label:'V6 折叠所有图层组',what:'折叠当前文档中的全部图层组，便于恢复可读的图层面板。',requires:'至少打开一个文档。',params:'无需填写参数。'},
  'ps.layer.place':{label:'贴回单张图片',what:'把最近抓取图或生成图传回 Photoshop，创建智能对象图层。',requires:'至少打开一个文档；没有历史图片时会使用固定占位图。',params:'可填写“文档 ID”；图片来自最近生成图或抓取图。'},
  'ps.layer.placeBatch':{label:'批量贴回图片',what:'按批量接口把图片列表传回 Photoshop。',requires:'至少打开一个文档；没有历史图片时会使用固定占位图。',params:'可填写“文档 ID”；本验证版由最近图片生成单项列表。'},
  'ps.layer.placeClipped':{label:'嵌入贴回(剪切蒙版)',what:'把图片贴成新图层、挪到指定图层正上方、再建剪切蒙版嵌进去。下面那层一个像素都不动，删掉上面这层即可完全还原。给「细节补偿档位」用。',requires:'至少打开一个文档；必须给出目标图层 ID，且该图层还在。',params:'需要“文档 ID”“目标图层 ID”和选区；选区来自任务快照。'},
  'ps.group.create':{label:'创建编组',what:'把指定图层放入一个新的图层组。',requires:'目标图层存在且允许修改文档。',params:'填写逗号分隔的“图层 ID（逗号分隔）”和“编组名称”。'},
  'ps.group.stampProbe':{label:'探测盖印图层',what:'读取指定编组同层图层，判断最近一次盖印结果是否已出现在编组上方。',requires:'Photoshop 正在运行；目标编组仍存在且属于当前文档。',params:'由自动盖印监测填入“文档 ID”和“编组 ID”；无需手动填写。'},
  'ps.mask.feather':{label:'应用羽化蒙版',what:'基于最近抓取选区创建或处理羽化蒙版。',requires:'至少打开一个文档，并且已有有效选区或抓取记录。',params:'可填写“文档 ID”和“图层 ID”；选区来自最近抓取图。'},
  'ps.mask.magentaFix':{label:'应用修复曲线',what:'对当前文档执行修复曲线处理。',requires:'至少打开一个文档；建议先复制文档或图层测试。',params:'可填写“编组名称”作为处理目标上下文。'},
  'ps.channel.list':{label:'列出通道',what:'读取当前文档的颜色通道和可见状态。',requires:'至少打开一个 Photoshop 文档。',params:'无需填写参数。'},
  'ps.channel.visibility':{label:'切换通道可见',what:'设置指定通道的显示或隐藏状态。',requires:'目标通道存在且所属文档已打开。',params:'填写“通道 ID”，再设置“可见”开关。'}
};
function linkActionMeta(action,label){
  return LINK_ACTION_META[action]||{label:label||action,what:'执行 '+(label||action)+'。',requires:'确认 Photoshop 正在运行且目标对象可用。',params:'请根据上方输入框填写所需参数。'};
}
const linkRuntime={
  tests:LINK_TESTS, actions:LINK_DEFAULT_ACTIONS.slice(), pending:new Map(), logs:[],
  connected:false, bridgeVersion:'', capture:null, generated:null, autoFullCanvas:false, lastRequest:null,
  // ⭐ 2026-10-05 诊断：UXP 自报的「定时器被拖慢」记录（见 linkHandleEvent 的 log 分支）。
  //   只在"PS 后台报断开"这条排查上用，不影响任何正常流程。
  pollLag:null,
  form:{docId:'',layerId:'',layerName:'链路验证结果',opacity:'100',aspect:'1:1',channelId:'',exportPath:'',groupIds:'',groupName:'链路验证组',visible:true}
};
