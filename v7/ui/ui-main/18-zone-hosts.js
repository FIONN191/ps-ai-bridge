// ═══ ui-main/18-zone-hosts.js —— 主界面主程序第 18 / 21 段 ═══
//   管什么：设置 / 生成 / 助手 / 问题反馈 / 社区 / 外挂能力卡的宿主胶水 · 引擎状态刷新 · 测速与网盘
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ⭐ 设置卡（2026-10-01）宿主胶水。和记录卡同一族的"单张大二级 + 右边导航"。
//   ⚠ 内容由 V7CardArchitecture.settingsPage 出（那才是接线的地方），这里只管挂载/路由/开关。
let settingsCard=null;
// ⭐⭐⭐ 2026-10-14【整轮重排】：右边导航 = 这张表，一行一节，一列到底（不再分页）。
//   用户原话："把最右侧的导航栏…全都去重新打散，然后分成更多更细的导航栏"
//             "不分页，一列到底"、"傻子都能从右边的导航栏找得到对应的东西在哪"。
//   · id    = 左边那一节的 data-sec-anchor（card-architecture.js settingsPage 里 sec(id) 建的）
//   · name  = 导航上显示的字（≤7 个字，导航只有 140px 宽）—— 要一眼看出"这块调什么"
//   · sub   = 左边节标题下面那行常显的灰字 + 导航行的悬停说明
//   · group = 导航里的分组小标题（只做分段，不可点）
//   · keys  = ⭐ 2026-10-20 顶上搜索框用的关键词 / 近义词（这一节里「滚到这里才显示」的模块没挂上时，靠它也能搜到这一节）
//   ⚠⚠ 加一节 = 这里加一行 + settingsPage 里加一个 sec(id)。只加一边：
//     只加这里 → 导航有、点了不动；只加那边 → 内容有、导航上找不到。
//   ⚠ scripts/check-card-registry.cjs 会把这张表跟 card-registry.js 的 innerTabs 对账。
const SETTINGS_TABS=[
  // ⭐⭐ 2026-10-14（用户定）：公告挪到【设置的最顶栏】。
  //   用户原话：「如果是长公告的话，就是右划可以转到这个设置界面的公告区域，
  //             公告区域放到设置的最顶栏」。
  //   ⚠ 它必须在第一行 —— 「公告弹窗右划」跳到这一节，用户从上往下看第一眼就是它。
  {id:'notices',name:'公告与状态',sub:'平台公告，和服务现在正不正常',keys:'公告 通知 消息 服务状态 维护 服务器 在线',group:'平台'},
  {id:'account',name:'登录账号',sub:'登录、注册、退出；看现在有没有登录',keys:'登录 注册 退出 登出 邮箱 密码 验证码 记住我 忘记密码 找回密码 账号',group:'账号'},
  {id:'credits',name:'积分与充值',sub:'平台积分余额、卡密兑换、积分流水',keys:'积分 余额 充值 卡密 兑换 账单 流水 扣费 消费 Banana',group:'账号'},
  {id:'keysync',name:'Key 云同步',sub:'把你的 API Key 加密存到云端，换电脑不用重填',keys:'Key 密钥 云同步 换电脑 加密 同步 API',group:'账号'},
  {id:'provider',name:'用哪家生图',sub:'选服务商、填地址和 Key，紧跟着检查连接、看余额',keys:'服务商 生图 API 地址 Key 密钥 检查连接 余额 模型 中转 渠道 平台 改名 显示名 露出 隐藏模型 算力槽位 配置方案 多套 切换方案',group:'生图服务'},
  // ⚠ 2026-10-15：「检查连接」(providercheck) 并进上面这一节了（用户：检查连接、余额应该跟用哪家生图放一块）。
  {id:'imagecompute',name:'出图花谁的钱',sub:'用你自己的 Key，还是用平台积分',keys:'计费 付费 花钱 自己的Key 平台积分 出图 算力',group:'生图服务'},
  {id:'lowbalance',name:'余额警告线',sub:'余额低于多少时提醒你',keys:'余额 提醒 警告 不足 阈值',group:'生图服务'},
  {id:'engine',name:'工作流跑在哪',sub:'ComfyUI 这类开源工作流：跑在本地、自己的服务器，还是平台云端',keys:'ComfyUI 工作流 本地 云端 服务器 算力',group:'工作流引擎'},
  {id:'comfy',name:'本地 ComfyUI',sub:'你电脑上 ComfyUI 的地址，和连接检查',keys:'ComfyUI 地址 端口 连接 本地',group:'工作流引擎'},
  {id:'runninghub',name:'RunningHub',sub:'在线工作流账号，和把工作流导入成预设',keys:'RunningHub 在线工作流 导入 预设 API Key',group:'工作流引擎'},
  {id:'align',name:'对齐与校色',sub:'生成的图怎么对齐原图、颜色怎么跟原图一致',keys:'对齐 校色 颜色 色差 自动对齐 精准 全局 混合',group:'生成与传回'},
  {id:'output',name:'抓图与出图',sub:'发给 AI 的图多大、AI 出的图多大',keys:'尺寸 分辨率 大小 像素 抓图 出图 画质 压缩 长边 4K 2K 1K',group:'生成与传回'},
  {id:'return',name:'传回到 PS',sub:'生成完要不要自动贴回、贴成什么图层',keys:'传回 贴回 自动贴回 图层 Photoshop PS 置入',group:'生成与传回'},
  {id:'group',name:'编组与联动',sub:'传回的图怎么编组；划缩略图时 PS 怎么跟着切',keys:'编组 图层组 联动 切换 缩略图',group:'生成与传回'},
  {id:'feather',name:'边缘羽化',sub:'让贴回的图和原图之间看不出接缝',keys:'羽化 边缘 接缝 过渡 蒙版',group:'生成与传回'},
  {id:'sound',name:'完成音效',sub:'生成完响一声提醒你',keys:'音效 声音 提示音 响铃 完成提醒',group:'生成与传回'},
  // ⭐ 2026-10-18 深夜：界面大小（用户：「笔记本用户现在已经要炸了」；外壳 ui_scale.rs + ui-scale.js）
  {id:'scale',name:'界面大小',sub:'整个软件一起放大缩小；笔记本屏幕放不下就调小',keys:'缩放 放大 缩小 字体大小 字号 DPI 笔记本 屏幕',group:'外观'},
  {id:'theme',name:'配色',sub:'卡片底色、文字颜色、主题色',keys:'主题 颜色 配色 主题色 文字颜色 底色 暗色 深色 皮肤',group:'外观'},
  {id:'display',name:'透明与毛玻璃',sub:'卡片透不透明、背景虚化多少、背景图清晰度、减少动画',keys:'透明 毛玻璃 模糊 背景 背景图 不透明度 虚化 动画 减少动画 晕 卡顿 关动画',group:'外观'},
  {id:'bars',name:'悬浮条',sub:'Agent 悬浮窗要不要显示',keys:'悬浮条 Agent 悬浮窗 夏三六',group:'外观'},
  {id:'layout',name:'布局与恢复',sub:'保存、恢复卡片的摆放位置',keys:'布局 保存布局 恢复布局 位置 摆放 卡片位置 默认布局',group:'外观'},
  {id:'freemode',name:'自由摆放',sub:'让每张卡片都能随意拖动摆放',keys:'自由模式 自由摆放 拖动 多屏 多显示器 收起 折叠',group:'操作'},
  {id:'interaction',name:'滚轮与预览',sub:'滚多少格换卡；缩略图悬停要不要弹大图；只在用 PS 时置顶',keys:'滚轮 灵敏度 换卡 预览 悬停 大图 置顶 最前面 后面 挡住 跟随 Photoshop PS 前台 后台',group:'操作'},
  {id:'shortcuts',name:'快捷键',sub:'开始生成、加参考图、一键收起展开的快捷键',keys:'快捷键 热键 键盘 按键 组合键',group:'操作'},
  {id:'checkpoint',name:'检查点',sub:'隔一段时间自动存一份完整画布，出事能找回',keys:'检查点 自动保存 存档 画布 找回 恢复',group:'存储与备份'},
  {id:'cache',name:'缓存',sub:'生成的图存在哪、最多占多大空间',keys:'缓存 磁盘 空间 占用 清理 删除 存储位置 文件夹',group:'存储与备份'},
  {id:'backup',name:'账号云备份',sub:'把设置和预设备份到云端，或从云端恢复',keys:'备份 云备份 恢复 还原 同步 设置备份 预设备份',group:'存储与备份'},
  {id:'autobackup',name:'自动备份',sub:'要不要自动备份、多久一次',keys:'自动备份 定时 间隔 多久',group:'存储与备份'},
  {id:'reset',name:'恢复默认',sub:'把这个账号的设置恢复到出厂状态',keys:'恢复默认 重置 出厂 清空设置',group:'存储与备份'},
  {id:'assistant',name:'助手模型',sub:'聊天助手接哪个语言模型',keys:'助手 夏三六 AI 语言模型 LLM DeepSeek 千问 Qwen Ollama 聊天 模型',group:'助手与隐私'},
  {id:'permissions',name:'Agent 权限',sub:'助手能看什么、能改什么',keys:'权限 隐私 Agent 能看 能改 授权',group:'助手与隐私'},
  {id:'recovery',name:'助手修改回滚',sub:'把助手改过的软件退回到以前的样子',keys:'回滚 撤销 退回 助手改动 恢复',group:'助手与隐私'},
  {id:'telemetry',name:'匿名反馈',sub:'要不要发送匿名的使用与报错信息',keys:'匿名 反馈 统计 报错 上报 隐私',group:'助手与隐私'},
  {id:'photoshop',name:'Photoshop 联动',sub:'选 PS 版本、安装或修复桥接插件',keys:'PS Photoshop 插件 桥接 安装 修复 版本 UXP 联动',group:'软件与服务'},
  {id:'support',name:'客服记录',sub:'你提交过的客服工单',keys:'客服 工单 帮助 反馈 问题',group:'软件与服务'},
  // ⚠ 2026-10-14：'notices'（公告与状态）【移到最顶栏了】，见 SETTINGS_TABS 第一行。
  //   这里不能留重复项 —— 这张表是"一行一节"，重复会让导航出现两行同名项。
  {id:'community',name:'社区',sub:'打开社区网页',keys:'社区 网页 分享 在线 排行榜',group:'软件与服务'},
  // ⭐ 2026-10-16（用户：「设置里面加上一个关于软件，关于软件里面要写上现在的版本号」）
  {id:'about',name:'关于软件',sub:'版本号、连的哪个后台、PS 插件和引擎的状态；报问题时复制诊断信息',keys:'关于 版本 版本号 诊断 后台 更新 引擎状态 复制诊断',group:'软件与服务'}
];
// 「关于软件」那一节读现场用（card-architecture.js 在另一个文件，读不到这里的 linkRuntime / taskList）。
//   ⚠ 只给看得见的状态，不给密码 / Key / 提示词。
window.V7AboutInfo=()=>{
  const v=window.V7_VERSION||{},st=window.V7Backend?.state?.()||{};
  let eng=null;try{const e=window.MATTINGENGINE?.snapshot?.();if(e)eng={available:!!e.available,device:e.device||'',tiers:e.tiers||{}};}catch(_){}
  let qwen=null;try{if(window.V7QwenMode)qwen={on:V7QwenMode.enabled(),source:V7QwenMode.source(),limits:V7QwenMode.limits()};}catch(_){}
  const mem=performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576)+' / '+Math.round(performance.memory.jsHeapSizeLimit/1048576)+' MB':'';
  // 2026-10-16（用户：测试的人拿到手要能自己排查 / 交给 AI 排查）：诊断里带上最近的报错和警告 ——
  //   排查最要紧的就是「刚才出了什么错」。⚠ 像 Key / 口令的长串、Bearer 后面的东西一律打码，每条截短
  //   ⚠ 一样的合并成一条记次数：PS 开着但没打开文档时插件会反复报「没有可读取的 Photoshop 文档」，不合并 20 条全被它刷满
  const scrub=s=>String(s||'').replace(/(bearer\s+)\S+/ig,'$1***').replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g,'$1-***').replace(/[A-Za-z0-9_\-]{24,}/g,'***').slice(0,200);
  const seen=new Map();
  (typeof linkRuntime!=='undefined'&&Array.isArray(linkRuntime.logs)?linkRuntime.logs:[]).forEach(l=>{
    if(!l||(l.level!=='error'&&l.level!=='warn'))return;
    const message=scrub(l.message),key=l.level+'|'+message,old=seen.get(key);
    if(old)seen.delete(key);
    seen.set(key,{at:l.at||'',level:l.level,from:l.direction||'',message,count:old?old.count+1:1});
  });
  const problems=[...seen.values()].slice(-20);
  return {app:v.app||'?',channel:v.channel||'',date:v.date||'',backendUrl:st.baseUrl||'',signedIn:!!st.signedIn,account:st.account&&st.account.email||'',
    uxpConnected:!!(typeof linkRuntime!=='undefined'&&linkRuntime.connected),uxpBackground:!!(typeof linkRuntime!=='undefined'&&linkRuntime.background),uxpVersion:typeof linkRuntime!=='undefined'&&linkRuntime.bridgeVersion||'',
    engine:eng,qwen,tasks:typeof taskList!=='undefined'?taskList.length:0,memory:mem,ua:navigator.userAgent,problems};
};
// card-architecture.js 的 settingsPage 按 id 取节标题和灰字（它在另一个作用域，读不到 const）
window.SETTINGS_TABS_INDEX=Object.fromEntries(SETTINGS_TABS.map(t=>[t.id,t]));
// ⚠ 历史遗留常量：2026-10-08~10-14 之间"对齐与校色"住在生成卡，路由要转去那边。
//   现在它回到设置卡（align 那一节），别名直接指 'align'，这个值已经不会再出现，
//   留着只为 settingsRoute 里那段拦截不报未定义。
const GENERATION_ALIGN_ROUTE='generation:align';

// 老的 section 名 → 新的小节 id。
// ⚠⚠ 这张表必须【穷举】。漏一项不会报错，会静默落到第一节（"登录账号"）。
//   老路由（route-registry.js）、正脸状态行、报错卡的"去设置"按钮都传老名字进来。
const SETTINGS_SECTION_TAB={
  // 账号
  account:'account',billing:'credits',costs:'credits',credits:'credits',keys:'keysync',
  // 生图服务
  own:'provider',provider:'provider',providers:'provider',platform:'imagecompute',compute:'imagecompute',
  // 工作流
  local:'comfy',workflow:'engine',
  // 生成与传回（10-14 从生成卡第 4 格搬回来）
  align:'align',color:'align','auto-align':'align',colormatch:'align',render:'align',
  output:'output',generation:'output',return:'return',
  // 外观 / 操作
  appearance:'theme',interface:'theme',content:'theme',layout:'layout','layout-restore':'layout',
  interaction:'interaction',
  // 存储与备份
  tools:'checkpoint',storage:'checkpoint',advanced:'checkpoint',
  'account-backup':'backup','backup-preferences':'autobackup',
  // 助手与隐私
  assistant:'assistant',privacy:'permissions','software-recovery':'recovery',
  // 软件与服务
  photoshop:'photoshop',support:'support',service:'notices',community:'community'
};
function settingsTabIdFromSection(section,index){
  const s=String(section||'');
  if(SETTINGS_SECTION_TAB[s])return SETTINGS_SECTION_TAB[s];
  // ⚠ 也认【小节 id 本身】（测试、直达链接手里只有 id）
  if(SETTINGS_TABS.some(t=>t.id===s))return s;
  // 认不出来才按老的分区序号兜底（0→账号 / 1→检查点 / 2→配色 / 3→检查点）
  return ['account','checkpoint','theme','checkpoint'][Number(index)||0]||'account';
}
function closeSettingsDetail(){
  closeRecordsDetail();   // 两者都是"没有三级"的卡，收法一样（含清空 #dcBody，防隐形残留）
}
function settingsCardMount(){
  const zone=settingsCardEl();
  if(!zone||!window.V7SettingsCard) return null;
  if(settingsCard) return settingsCard;
  V7SettingsCard.setIconRenderer(function(name,size){
    try{ return window.ICON?ICON.render(name,size):''; }catch(_){ return ''; }
  });
  settingsCard=V7SettingsCard.create({
    zone:zone,
    tabs:SETTINGS_TABS,
    // ⭐ 2026-10-20：顶上的搜索框（用户：「设置内容特别多……顶部需要加一个搜索框……近似搜索……有跳转有分类」）
    search:{},
    host:{
      // 搜索跳到折叠里的项：先展开它外面的折叠（含懒挂的服务块），跟路由跳转同一个钩子
      expandAncestors:node=>{ try{ window.V7CardArchitecture?.expandAncestors?.(node); }catch(_){} },
      // 每个页的内容由 card-architecture 出（它才知道每个设置项怎么接 + 怎么 retain 清理）
      // ⭐ 2026-10-14：整页一列到底（settingsPage），不再按页签分页出内容
      render:(body,anchor,section)=>V7CardArchitecture.settingsPage(body,anchor,section)||null,
      onError:error=>ERR.report('SETTINGS_OPERATION_FAILED',{message:String(error&&error.message||error)})
    }
  });
  settingsCard.mount();
  return settingsCard;
}
async function settingsRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  // ⚠ 单张大二级 —— zoneSel 必须归 0（同记录卡/预设卡，否则算出野槽位）
  zoneSel=0;
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  closeSettingsDetail();
  // ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：别名表里 align/color/auto-align/colormatch
  //   指向的【不是设置卡了】—— 对齐与校色整块搬去了生成卡二级。
  //   ⇒ 在这里拦住它，改跳生成卡第 4 格（zone 3，就是三个折叠组那格），
  //     然后复用项目现成的 expandAncestors + route-highlight（不另造动效）。
  //   ⚠ 不拦的后果：settingsTabIdFromSection 查不到这个值 ⇒ 【静默落到第一页】。
  if(opts && opts.section===GENERATION_ALIGN_ROUTE){
    navigateCard('generation',3,{highlight:'[data-sec-anchor="align"]'}).catch(()=>{});
    return {body:document.getElementById('dcBody'),cancelled:false,settings:false};
  }
  const card=settingsCardMount();
  if(card){
    // ⚠ section 必须一起传：有些 section 是【页签里的子页签】（assistant / keys / billing…），
    //   只传页签的话卡片会以为"没变化"而跳过重画，子页签静默失效。
    card.open(settingsTabIdFromSection(opts.section,opts.index), opts.section);
    settingsOpenZone();
    // Service sections mount lazily on the next frame. Await that frame so
    // callers of the existing route API receive a mounted destination.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    // ⭐ 从正脸点状态行 / tag 进来：落地后让那一项闪一下，告诉用户"要改的在这"。
    //   复用项目现成的 .route-highlight（通用导航就是这么做的），不另造动效。
    //   ⚠ 等两帧再找：路由进来是立即换页，但子页签（账号页里那几页）是点完按钮才挂内容的。
    // ⚠⚠⚠ 2026-10-11 审计修（真 bug）：
    //   这一段原来只在 opts.highlight 存在时跑。而路由表里 'settings/layout'
    //   只给了 { section:'layout' }、【没有 highlight】：
    //       route-registry.js:91  'settings/layout': { card:'settings', zone:2, options:{ section:'layout' } }
    //   ⇒ 这段整个不执行 ⇒ 目标那一节的折叠【不展开】。
    //   ⚠ 后果（用户能看到的）：布局面板是"第一次展开才挂"的懒加载
    //     （card-architecture.js:478-487 覆写 _foldSetOpen 去调 V7LayoutManager.mount）。
    //     折叠不展开 ⇒ 面板不挂 ⇒ 用户点"保存布局 / 布局恢复"跳过去，
    //     看到的是一个【折叠着的空壳】，点开才有内容 —— 他会以为功能坏了。
    //   ⚠ 同一个洞影响三条路由：settings/layout、records/layout、
    //     以及错误码 LAYOUT_FAILED 的跳转（ui.html:15403 navigateCard('settings',2,{section:'layout'})）。
    //   ⇒ 修法：section==='layout' 时也去展开+定位那一节。用产品自己已有的钩子
    //     [data-layout-section]（card-architecture.js:477 layout.dataset.layoutSection=''），
    //     不新造属性，也不改路由表（改路由表只修一条，改这里三条都修）。
    const focusSel=opts.highlight||(opts.section==='layout'?'[data-layout-section]':null);
    if(focusSel){
      const selector=focusSel;
      {
        const node=settingsCardEl()?.querySelector(selector);
        if(node){
        // ⭐ 2026-10-06 docs/150 §4.3：跳转先展开再高亮。
        // 目标若在折叠体里，先展开祖先折叠（含服务块懒挂载），否则下面 checkVisibility() 不过、静默 return。
        // ⚠⚠ 2026-10-11：这里【必须】真的调 expandAncestors —— 布局面板能不能挂就靠它
        //   （card-architecture.js:482 的 _foldSetOpen 覆写里才是 mount）。
        window.V7CardArchitecture?.expandAncestors?.(node);
        if(node.checkVisibility?.()){
        const target=node.closest('.settings-row,.settings-field,.tgl,label')||node;
        // ⚠ 2026-10-15：只有"跳到某一项"(highlight)才再滚一次。整节跳转(section:'layout')已由 settingsOpenZone 落到节标题；
        //   布局面板比窗口高(725>400)，再 nearest 一次会把它顶边对齐 ⇒ 节标题被顶出视野 64px（真窗口实测）。
        if(opts.highlight)target.scrollIntoView({block:'nearest',behavior:'smooth'});
        target.classList.add('route-highlight');
        setTimeout(()=>target.classList.remove('route-highlight'),3300);
        }
        }
      }
    }
  }
  return {body:document.getElementById('dcBody'),cancelled:false,settings:true};
}
function settingsOpenZone(){
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  // ⚠⚠ 2026-10-03 晚【竞态】修复：原来这里写的是 `if(allCloseTimer){allCloseTimer=null;}`
  //   ——【只把变量置空，没有 clearTimeout】。而 allCloseTimer 是个【已经排上队的 360ms 定时器】：
  //     closeAll() 关二级时会 setTimeout(clear, 360)，那 360ms 内若又开了二级，
  //     这个没被取消的定时器【照样会响】，到点就把刚开出来的二级整个拆掉。
  //   表现就是用户报的「右滑打不开二级 / 闪一下就没」——典型的竞态。
  //   ⚠ 同一族的记录卡(recordsOpenZone)、预设卡、以及右滑通用分支都写对了(clearTimeout)，
  //     只有设置卡和外挂卡这两处漏了。反复出现"有时好有时坏"就往这里查。
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=settingsCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.z-glow','.z-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  // ⭐⭐ 2026-10-15 修（真窗口实测：从正脸标签 / 生成卡「相关设置」/ 报错卡「定位到设置」跳进来，
  //   导航亮的是目标那一节，内容却【停在最顶上】）：
  //   路由是先 card.open(目标节)（里面就滚过去了）、再走到这里把二级显示出来 ——
  //   可那一刻 #settingsZone 还是 display:none，隐藏的元素 scrollTop 写不进去，滚了等于没滚。
  //   ⇒ 显示出来之后的下一帧，按卡片当前那一节再滚一次。
  //   ⚠ 以前的测试只看 dataset.settingsTab（导航亮哪节），没看真的滚到没有 —— 所以一直没抓到。
  if(settingsCard&&typeof settingsCard.scrollToAnchor==='function'){
    const want=settingsCard.currentTab();
    requestAnimationFrame(()=>{ try{ if(want) settingsCard.scrollToAnchor(want,false); }catch(_){} });
  }
}
function settingsCloseZone(){
  if(!settingsCard||!settingsCard.isOpen()) return;
  settingsCard.close();
  settingsCardEl()&&settingsCardEl().classList.remove('show');
  if(!zones.querySelector('.zone.show')) zones.classList.remove('show');
}

// ⭐⭐ 生成卡（2026-10-15）宿主胶水 —— 跟设置卡【逐行同一个套路】，只是内容换成 renderGenerationPage。
//   用户原话：「把目前所有的二级目录删除，换成和别的卡片一样的二级大卡片。然后三级卡片就直接不要了。」
//   ⚠ 组件直接复用 V7SettingsCard（右边导航 + 一列到底 + 点哪滚到哪 + 自愈空白），不另写一份。
//   ⚠ generationCard 变量在文件前面（generationZoneEl 旁边）就声明了，防暂时性死区。
function closeGenerationDetail(){
  closeRecordsDetail();   // 同设置卡：没有三级 —— 收掉并清空 #dcBody，防隐形残留
}
function generationCardMount(){
  const zone=generationCardEl();
  if(!zone||!window.V7SettingsCard) return null;
  if(generationCard) return generationCard;
  generationCard=V7SettingsCard.create({
    zone:zone,
    tabs:GENERATION_TABS,
    host:{
      // 内容走总管理员（cards/card-generation.js），它再调 renderGenerationPage；总管理员不在就直接画
      render:(body)=>{
        if(window.V7CardManager&&typeof V7CardManager.mount==='function'){ V7CardManager.mount('generation',body,0); return null; }
        return renderGenerationPage(body);
      },
      onError:error=>ERR.report('UI_ACTION_FAILED',{message:'生成卡：'+String(error&&error.message||error)})
    }
  });
  generationCard.mount();
  return generationCard;
}
function generationSectionFromRoute(opts){
  const s=String(opts&&opts.section||'');
  if(GENERATION_TABS.some(t=>t.id===s)) return s;
  return GENERATION_ZONE_SECTION[Number(opts&&opts.index)||0]||'run';
}
async function generationRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  zoneSel=0;              // 单张大二级 —— 必须归 0（否则 updateDetailBg 算出野槽位）
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  closeGenerationDetail();
  const card=generationCardMount();
  if(card){
    card.open(generationSectionFromRoute(opts));
    generationOpenZone();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(opts.highlight){
      const node=generationCardEl()?.querySelector(opts.highlight);
      if(node&&node.checkVisibility?.()){
        node.scrollIntoView({block:'nearest',behavior:'smooth'});
        node.classList.add('route-highlight');
        setTimeout(()=>node.classList.remove('route-highlight'),3300);
      }
    }
  }
  return {body:document.getElementById('dcBody'),cancelled:false,generation:true};
}
function generationOpenZone(){
  // ⚠ 跟 settingsOpenZone 同一套（含 2026-10-03 那个 allCloseTimer 竞态修复：必须 clearTimeout，不能只置空）
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=generationCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.z-glow','.z-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  // 打开时刷一次：任务/参考图在卡关着的时候可能变过
  try{ aiRefreshInPlace(); }catch(_){}
  // ⭐ 2026-10-15：同 settingsOpenZone —— 隐藏时滚不动，显示后按当前那一节补滚一次
  if(generationCard&&typeof generationCard.scrollToAnchor==='function'){
    const want=generationCard.currentTab();
    requestAnimationFrame(()=>{ try{ if(want) generationCard.scrollToAnchor(want,false); }catch(_){} });
  }
}
function generationCloseZone(){
  if(!generationCard||!generationCard.isOpen()) return;
  generationCard.close();
  generationCardEl()&&generationCardEl().classList.remove('show');
  if(!zones.querySelector('.zone.show')) zones.classList.remove('show');
}

// ⭐⭐ 助手卡（2026-10-17 夏三六，docs/231）宿主胶水 —— 跟生成卡【同一个套路】，只是内容由 V7AgentZone 画。
//   ⚠ 老路由 0~3 = 对话 / 模型与连接 / Agent 权限 / 恢复节点 → chat / model / perm / perm
const ASSISTANT_ZONE_SECTION=['chat','model','perm','perm'];
function closeAssistantDetail(){
  closeRecordsDetail();   // 同生成卡：没有三级 —— 收掉并清空 #dcBody，防隐形残留
}
function assistantCardMount(){
  const zone=assistantCardEl();
  if(!zone||!window.V7AgentZone) return null;
  if(assistantCard) return assistantCard;
  assistantCard=V7AgentZone.mountZone(zone);
  return assistantCard;
}
function assistantSectionFromRoute(opts){
  const s=String(opts&&opts.section||'');
  const legacy={connection:'model',permissions:'perm',recovery:'perm'};
  if(legacy[s]) return legacy[s];
  if(window.V7AgentZone&&V7AgentZone.RAIL.some(r=>r.id===s)) return s;
  return ASSISTANT_ZONE_SECTION[Number(opts&&opts.index)||0]||'chat';
}
async function assistantRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  zoneSel=0;              // 单张大二级 —— 必须归 0（否则 updateDetailBg 算出野槽位）
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  closeAssistantDetail();
  const card=assistantCardMount();
  if(card){
    card.open(assistantSectionFromRoute(opts));
    assistantOpenZone();
  }
  return {body:document.getElementById('dcBody'),cancelled:false,assistant:true};
}
function assistantOpenZone(){
  // ⚠ 跟 generationOpenZone 同一套（含 allCloseTimer 竞态修复：必须 clearTimeout，不能只置空）
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=assistantCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.z-glow','.z-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  // 同生成卡：隐藏时滚不动，显示出来以后按当前那一节补滚一次
  if(assistantCard){
    const want=assistantCard.currentTab();
    requestAnimationFrame(()=>{ try{ if(want) assistantCard.scrollToAnchor(want,false); }catch(_){} });
  }
}
function assistantCloseZone(){
  if(!assistantCard||!assistantCard.isOpen()) return;
  assistantCard.close();
  assistantCardEl()&&assistantCardEl().classList.remove('show');
  if(!zones.querySelector('.zone.show')) zones.classList.remove('show');
}

// ⭐⭐ 问题反馈卡（2026-10-18 深夜，docs/248）宿主胶水 —— 跟生成卡【同一个套路】（V7SettingsCard），内容由 V7Feedback.renderPage 画。
function feedbackCardMount(){
  const zone=feedbackCardEl();
  if(!zone||!window.V7SettingsCard||!window.V7Feedback) return null;
  if(feedbackCard) return feedbackCard;
  feedbackCard=V7SettingsCard.create({
    zone:zone,
    tabs:V7Feedback.TABS,
    host:{
      render:(body)=>V7Feedback.renderPage(body),
      onError:error=>ERR.report('UI_ACTION_FAILED',{message:'问题反馈卡：'+String(error&&error.message||error)})
    }
  });
  feedbackCard.mount();
  return feedbackCard;
}
async function feedbackRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  zoneSel=0;              // 单张大二级 —— 必须归 0（否则 updateDetailBg 算出野槽位）
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  closeRecordsDetail();   // 没有三级 —— 收掉并清空 #dcBody，防隐形残留
  const card=feedbackCardMount();
  if(card){
    const s=String(opts.section||'');
    card.open(V7Feedback.TABS.some(t=>t.id===s)?s:'write');
    feedbackOpenZone();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    // 从报错卡 / 卡面点进来：光标直接落在输入框里
    if(!s||s==='write'){ const ta=feedbackCardEl()?.querySelector('[data-fb-text]'); if(ta&&!ta.disabled) try{ ta.focus({preventScroll:true}); }catch(_){} }
  }
  return {body:document.getElementById('dcBody'),cancelled:false,feedback:true};
}
function feedbackOpenZone(){
  // ⚠ 跟 generationOpenZone 同一套（含 allCloseTimer 竞态修复：必须 clearTimeout，不能只置空）
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=feedbackCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.z-glow','.z-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  if(feedbackCard){
    const want=feedbackCard.currentTab();
    requestAnimationFrame(()=>{ try{ if(want) feedbackCard.scrollToAnchor(want,false); }catch(_){} });
  }
}

// ⭐⭐ 社区卡（2026-10-20）宿主胶水 —— 跟问题反馈卡【同一个套路】（V7SettingsCard），内容由 V7Community.renderPage 画。
function communityCardMount(){
  const zone=communityCardEl();
  if(!zone||!window.V7SettingsCard||!window.V7Community) return null;
  if(communityCard) return communityCard;
  communityCard=V7SettingsCard.create({
    zone:zone,
    tabs:V7Community.TABS,
    host:{
      render:(body)=>V7Community.renderPage(body),
      onError:error=>ERR.report('UI_ACTION_FAILED',{message:'社区卡：'+String(error&&error.message||error)})
    }
  });
  communityCard.mount();
  return communityCard;
}
async function communityRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  zoneSel=0;              // 单张大二级 —— 必须归 0（否则 updateDetailBg 算出野槽位）
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  closeRecordsDetail();   // 没有三级
  const card=communityCardMount();
  if(card){
    const s=String(opts.section||'');
    card.open(V7Community.TABS.some(t=>t.id===s)?s:'rank');
    communityOpenZone();
  }
  return {body:document.getElementById('dcBody'),cancelled:false,community:true};
}
function communityOpenZone(){
  // ⚠ 跟 feedbackOpenZone 同一套（含 allCloseTimer 竞态修复：必须 clearTimeout，不能只置空）
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=communityCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.z-glow','.z-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  if(communityCard){
    const want=communityCard.currentTab();
    requestAnimationFrame(()=>{ try{ if(want) communityCard.scrollToAnchor(want,false); }catch(_){} });
  }
}

// ⭐ 外挂能力卡（2026-10-01）宿主胶水。同一族的"单张大二级 + 右边导航"，
//   但右栏的含义是【档位梯子】—— 划上去预览、点一下换档。
//   ⚠ 数据三处来源，别混：
//     ① 引擎快照 → MATTINGENGINE.snapshot()（这台机器装了哪些模型）
//     ② 下载清单 → managedEngineModels()（model-downloads.json 那份）
//     ③ 用户选的档 → settingsRuntime.enginesTier（用户自己点的，要记住）
let enginesCard=null;

// 用户选的档（1/2/3）。⚠ 存 settingsRuntime 里，跟其它设置一个待遇（会跟着账号存/读）。
// ⚠⚠ 2026-10-03 晚：默认从【1】改成【引擎实际能给的最高档】。用户原话：
//   「让我本地模型齐全的情况下，默认能够直接开到第三档。」
//   以前写死 1，于是本地 17.7G 模型一个不少的人，开软件看到的也是"第 1 档"，
//   得自己去点一下才升上去 —— 那正是他这次抱怨的"本地有模型却没吃上"。
//   ⚠ 取的是 C.tierFromEngine()（三样能力里【最低】的那一个，见 engines-core 的说明），
//     不是无脑写 3：本地只装了档 1 的模型时就老老实实显示 1 档，
//     否则卡面会显示"3 档 · 要下载 10.6G"，对着一个已经装满的机器说瞎话。
//   ⚠ 引擎还没探测（tierFromEngine 回 0）时兜底给 3：
//     模型齐全的机器一秒后就会探到 3，先按 3 显示不会跳档；
//     引擎真没起来时卡面走的是 engineDown() 那条路（显示「引擎没起 / 启动引擎」），
//     不会因为这里是 3 而假装"已装好"。
function enginesTierSetting(){
  const n=Number(settingsRuntime.enginesTier);
  if(n===1||n===2||n===3) return n;      // 用户自己点过 → 一律听用户的，不再自动
  try{
    const snap=window.MATTINGENGINE?window.MATTINGENGINE.snapshot():null;
    const t=window.V7EnginesCore?window.V7EnginesCore.tierFromEngine(snap):0;
    if(t>=1&&t<=3) return t;
  }catch(_){}
  return 3;
}
// 从引擎快照里拼出界面要的"探测到的"那块（Python / onnx / DirectML / 显卡）
function enginesProbeView(snap){
  const s=snap||{};
  const caps=s.caps||{};
  const yes=v=>v?'可用':'没有';
  return {
    python:String(s.python||'').trim(),
    onnx:caps.onnx?('可用'+(s.version?(' · '+s.version):'')):'没有',
    dml:yes(caps.dml!==undefined?caps.dml:caps.directml),
    torch:yes(caps.torch),
    gpu:s.device?String(s.device)+(s.vramGB?(' · '+s.vramGB+'G'):''):'',
    vramGB:Number(s.vramGB)||0,
    tiers:s.tiers||{},
    available:s.available===true,
    multiCapable:s.multiCapable===true,
    lastError:String(s.lastError||'')
  };
}
// 下载清单：走现成的 managedEngineModels()（engine-models-ui.js 那套），拿不到就返回 null。
// ⚠ 拿不到【不代表没模型可用】—— 只代表"这条链现在答不上话"，界面要说清楚，别装成"没有"。
async function enginesLoadCatalog(){
  try{
    if(window.V7EngineModels&&typeof V7EngineModels.request==='function'){
      const r=await V7EngineModels.request('catalog');
      return r||null;
    }
  }catch(_){ }
  return null;
}
function enginesCardMount(){
  const zone=enginesCardEl();
  const faceEl=document.querySelector('.block-card[data-card="engines"]');
  if(!zone||!window.V7EnginesCard) return null;
  if(enginesCard) return enginesCard;
  V7EnginesCard.setIconRenderer(function(name,size,width){
    try{ return window.ICON?ICON.render(name,size):''; }catch(_){ return ''; }
  });
  enginesCard=V7EnginesCard.create({
    zone:zone,
    face:faceEl,
    host:{
      load:()=>({
        engine:window.MATTINGENGINE?Object.assign({},MATTINGENGINE.snapshot(),enginesProbeView(MATTINGENGINE.snapshot())):{},
        catalog:enginesCatalogCache,
        // ⭐ Phase B：配置页三块（状态条/环境行/模型行）的唯一数据源。
        status:window.V7EngineStatus?V7EngineStatus.snapshot():null,
        tier:enginesTierSetting()
      }),
      // 用户点了别的档 —— 记进设置（会跟着账号存/读）
      onTier:n=>{
        settingsRuntime.enginesTier=n;
        try{ settingsSave(); }catch(_){ }
      },
      // ⚠⚠ 卡自己把二级打开时（一级卡上点能力行），必须由宿主把 #zones 露出来 ——
      //   卡只管自己内部的 open 状态，它碰不到宿主的 .zones.show。
      //   2026-10-01 实装时栽过：一级点能力行，卡内部 open=true 但二级整块还是 hidden，
      //   症状就是"点了没反应"（本项目最忌讳的形态）。
      onOpen:()=>enginesOpenZone(),
      // ⭐ 2026-10-05：配置信息页要显示「模型下载状态」，卡那边进这一页时会来要一次清单。
      //   ⚠ 复用现成的 enginesLoadCatalog()（走 V7EngineModels.request('catalog')），
      //     不另拉一条链 —— 两条链早晚会给出不一样的答案。
      loadCatalog:async()=>{
        if(enginesCatalogCache&&enginesCatalogCache.models) return enginesCatalogCache;
        const cat=await enginesLoadCatalog();
        if(cat) enginesCatalogCache=cat;
        return enginesCatalogCache;
      },
      // 点「装」→ 真去下模型。⚠⚠ 这条链【必须】走通，否则就是
      //   "按钮点得动但点了没反应" —— 本项目最忌讳的故障形态。
      install:n=>enginesStartInstall(n),
      // ⭐ Phase F："重新检测"刷【两台】引擎（状态出口内部会分别探）。
      probe:()=>enginesStatusRefresh(true),
      // ⭐ 2026-10-04 第 ⑥ 条：本地有模型却显示「需要下载」。
      //   那句误报的根子不在下载，在【引擎没起来】—— 所以给一条直达的路。
      //   ⚠⚠ 复用宿主的 engineStartAndWait()，别在这里另写一套启动 ——
      //     两边逻辑一分叉，早晚会出现"一处能起一处起不来"。
      //   它已经处理好了这三件容易做错的事：
      //     ① 拉起进程后【轮询等端口】，不是 spawn 完就报成功
      //     ② 给够等待时间（首次要加载 torch，慢是正常的）
      //     ③ 起不来就如实报错，不装作好了
      //   ⚠⚠ 2026-10-03 晚【修】：这颗按钮原来是去启动【校色引擎】的
      //     （engineStartAndWait 不传 which → 默认 'match' / 37893），
      //     而这张卡用的是抠像引擎（'matting' / 37894）—— 按下去等于没启动，
      //     界面还报"引擎起来了"。用户实测原话："反正就用不了"。
      //     ⇒ 必须传 'matting'，跟状态条/配置页那条启动路保持一致。
      // ⭐ Phase F：which 参数化（'match' 校色引擎 / 'matting' 外挂引擎）。
      //   卡面上两台引擎各有各的启动/停止按钮，谁都不连坐。
      startEngine:async(which)=>{
        const target=which==='match'?'match':'matting';
        const tip=m=>{ try{ UI.toast(m); }catch(_){} };
        const r=await engineStartAndWait(tip,target);
        if(r.ok){
          // 起来了 → 重新探测，让卡面/状态条自己变。
          await enginesStatusRefresh(true);
          try{ UI.toast(target==='match'?'校色引擎起来了':'外挂引擎起来了'); }catch(_){ }
        }else{
          ERR.report('ENGINE_START_FAILED',{
            message:String((r&&r.error)||'启动失败'),
            // ⭐ Phase E 文案 sweep：维修入口统一指外挂能力卡的环境行（文档 §8-3）。
            context:{'下一步':'去 外挂能力卡 · 配置信息 看「环境」那一行，装好再启动'},
            // ⭐ 2026-10-22（docs/263 第 5 条）：启动失败常常只是起得慢 —— 报错卡上直接给「再启动一次」（启动引擎不扣分）
            retry:()=>{ engineStartAndWait(tip,target).then(again=>{ if(again&&again.ok){ enginesStatusRefresh(true); try{ UI.toast(target==='match'?'校色引擎起来了':'外挂引擎起来了'); }catch(_){} } else ERR.report('ENGINE_START_FAILED',{message:String((again&&again.error)||'启动失败'),context:{'下一步':'去 外挂能力卡 · 配置信息 看「环境」那一行，装好再启动'}}); }); },
            retryLabel:'再启动一次'
          });
        }
      },
      toast:m=>UI.toast(m),
      // ⭐ 2026-10-18 云端外挂（docs/237）：左上角开关 + 二级的「重新检测 / 改用本机引擎」。状态只由 cloud-tools.js 判，卡不另判。
      cloud:()=>window.V7CloudTools?V7CloudTools.status():null,
      setCloud:on=>cloudToolsToggle(on),
      cloudCheck:()=>{
        if(!window.V7CloudTools) return;
        V7CloudTools.forgetPass();                       // 重新检测 = 扔掉旧通行证、清掉"降级中"，从头再连一次
        V7CloudTools.ensureReady().then(r=>{
          try{ enginesStatusRefresh(true); }catch(_){}
          if(r&&r.route==='cloud') UI.toast('云端连上了');
        }).catch(()=>{});
      },
      // ⭐⭐ 2026-10-04 重排新增：二级顶部那条「电脑配置 + 引擎状态」要的数据。
      //   用户原话："顶部它应该是我们目前的这个扫描用户的电脑配置，比如说内存是多少？
      //   显卡是多少？……和我们的引擎的启动状态之类的。"
      //   ⚠ 复用 perfMonitor 那条链【不重复造】—— 但这里直接调 uiwin.perf.sample()，
      //     不走 perfMonitor 的订阅（订阅是"每秒一直发"，配置页只需要进来时看一次 + 低频刷新）。
      //   ⚠ 采样器可能抛（外壳没起来 / 权限），一律转成 null，卡面会如实说"还没读到"。
      perfSample:async()=>{
        try{
          if(!(window.uiwin&&window.uiwin.perf&&window.uiwin.perf.sample)) return null;
          return await window.uiwin.perf.sample();
        }catch(_){ return null; }
      },
      // ⭐ 停止引擎。⚠ 走的是跟设置卡那颗「停止引擎」【同一条路】（uiwin.engine.stop），
      //   不另写一套 —— 两边分叉早晚会"一处能停一处停不掉"。
      stopEngine:async(which)=>{
        const target=which==='match'?'match':'matting';
        try{
          if(!(window.uiwin&&window.uiwin.engine&&window.uiwin.engine.stop)){
            UI.toast('这个版本还没有停止引擎的入口'); return;
          }
          const r=await window.uiwin.engine.stop(target);
          if(r&&r.ok===true){ UI.toast(target==='match'?'校色引擎已停止':'外挂引擎已停止'); await enginesStatusRefresh(true); }
          else UI.toast('引擎没停掉：'+((r&&r.error)||'原因不明'));
        }catch(error){
          ERR.report('ENGINE_STOP_FAILED',{message:String(error&&error.message||error)});
        }
      },
      // ⭐ Phase B：状态/环境/模型三块的数据与刷新（配置页用，docs/150 §5.1）。
      //   ⚠ 刷新/判断只在 V7EngineStatus 里做一次；这里只是"宿主触发刷新的口"。
      status:()=>window.V7EngineStatus?V7EngineStatus.snapshot():null,
      refreshStatus:force=>enginesStatusRefresh(force),
      mountEnv:()=>{ if(window.V7EngineEnvironment) return V7EngineEnvironment.mount(); },
      // ⭐ 2026-10-08：一键开启加速的进度线要画在环境行里，所以卡片把"推进度"这件事
      //   转交给环境行模块（它是唯一画那一行的地方）。
      envProgress:text=>{ if(window.V7EngineEnvironment&&V7EngineEnvironment.progress) return V7EngineEnvironment.progress(text); },
      // ⭐ 也把这一键本身暴露给卡片（万一以后要在别处调，不再另写一条链）
      startAccel:onStep=>engineAccelStart(onStep),
      mountModels:()=>{ if(window.V7EngineModels) return V7EngineModels.mount(); },
      rescanModels:async()=>{
        enginesCatalogCache=null;
        if(window.V7EngineStatus) await V7EngineStatus.refresh({force:true,models:true,environment:false});
        const cat=await enginesLoadCatalog();
        if(cat) enginesCatalogCache=cat;
        if(enginesCard) enginesCard.reload();
      },
      // ⭐ Phase B：状态条的「重启」= 停止 + 等端口松开 + 再走现成的启动链。
      //   ⚠ 不另写启动/停止逻辑（两边分叉早晚会出现"一处能起一处起不来"）。
      restartEngine:async(which)=>{
        const target=which==='match'?'match':'matting';
        const tip=m=>{ try{ UI.toast(m); }catch(_){} };
        try{
          if(window.uiwin&&window.uiwin.engine&&window.uiwin.engine.stop){
            tip('正在停止…');
            const r=await window.uiwin.engine.stop(target);
            if(r&&r.ok!==true&&r.cancelled!==true){ UI.toast('停不掉：'+((r&&r.error)||'原因不明')); return; }
          }
        }catch(error){
          ERR.report('ENGINE_STOP_FAILED',{message:String(error&&error.message||error)});
          return;
        }
        await new Promise(res=>setTimeout(res,600));
        const r=await engineStartAndWait(tip,target);
        if(r.ok){ await enginesStatusRefresh(true); tip(target==='match'?'校色引擎已重启':'外挂引擎已重启'); }
        else ERR.report('ENGINE_START_FAILED',{message:String((r&&r.error)||'启动失败'),context:{'下一步':'去 外挂能力卡 · 配置信息 看「环境」那一行'}});
      },
      // ⭐ 二级「配置信息」页底部那条 DLSS 入口。
      //   ⚠ 它原来是「总览」页的底部入口；总览页这轮没了，不能让它变成"看得见点不到"。
      openDlss:()=>{
        // DLSS 是个独立工作面，不是这张卡的一页 —— 直接开它自己的界面。
        try{
          if(window.V7DLSS&&typeof V7DLSS.openTask==='function'){ V7DLSS.openTask(null); return; }
        }catch(_){}
        UI.toast('DLSS 那一页还没接上');
      },
      // ⭐ 二级的能力页里要嵌「这一样能力的设置项」（自动对齐 / 校色 / 细节还原 / 引擎开关）。
      //   这些原来在三级，现在三级没了，内容不能跟着丢 —— 所以由卡来问宿主拿。
      //   ⚠ kind 是老的四个分区名（engine / align / detail / matting），
      //     卡那边负责把「校色/对齐 → align、细节还原/调强度 → detail、
      //     抠像/人体/分割/精修边缘 → matting、配置信息 → engine」映射过来。
      //   ⚠⚠ 2026-10-05 加了第二个参数 opts：卡那边传 {noBox:true} 表示
      //     "这一页不要再给引擎状态框了"（顶栏已经有一份，重复占 215px）。
      // ⚠⚠ 2026-10-05：对齐/校色这两样【搬去设置卡了】（用户定"只放在设置卡里"）。
      //   所以外挂卡这一页【不再出控件】，只出一个跳过去的入口 ——
      //   出两份控件就是两份 DOM、两份绑定，改一边另一边静默不同步（这个项目的老坑）。
      //   ⛔ 不要去改 enginesCapSettingsHtml 的 align 分支：那个分支现在是
      //     【生成卡二级「对齐与校色」组】的内容源（alignSettingsMarkup）。
      //     在这里拦一道就行。
      //   ⚠ 2026-10-08：原来这里写的是"设置卡「对齐与校色」页正是从它取内容"——
      //     那一页已经改成「传回」了，别照着旧注释去找。
      settingsFor:(kind,opts)=>kind==='align'
        ? {
            // ⭐⭐⭐ 2026-10-08（docs/170 §4.8 · E4）：跳转按钮改指向【生成卡二级的新组】。
            //   ⚠ 10-05 时它指向设置卡「对齐与校色」页；那一页 10-08 被清空改名「传回」了
            //     （对齐/校色搬去生成卡二级），所以这个按钮不改就是【跳到错的地方】。
            //   ⚠ 没有删掉它：它本来就是"告诉你东西搬哪去了"——
            //     删了用户在外挂卡里就彻底找不着了。用户 10-01 否掉的是
            //     "用跳转代替搬家"，而这里搬家【已经真做了】。
            html:'<div class="ai-help">对齐和校色<b>已经搬到「生成」卡的二级</b>了 —— '
              +'它们管的是所有生成共用的规矩，不是某一样能力的零件，放在这里每次都让人找不着。</div>'
              +'<div class="settings-actions"><button type="button" class="settings-btn" '
              +'data-goto-align>去生成卡 · 对齐与校色</button></div>',
            bind:body=>{
              const btn=body&&body.querySelector('[data-goto-align]');
              // ⚠ 走 GENERATION_ALIGN_ROUTE 而不是硬写 'generation'：
              //   那个 sentinel 是"打开生成卡 + 展开对齐与校色折叠组"的约定，
              //   两处硬写就容易只改一处（别名表那边也是同一个值）。
              if(btn)btn.onclick=()=>{ closeEnginesDetail(); navigateCard('settings',0,{section:GENERATION_ALIGN_ROUTE}); };
            }
          }
        : {
            html:enginesCapSettingsHtml(kind,opts),
            bind:body=>enginesCapSettingsBind(body,kind)
          },
      onError:error=>ERR.report('ENGINE_OPERATION_FAILED',{message:String(error&&error.message||error)})
    }
  });
  enginesCard.mount(zone,faceEl);
  return enginesCard;
}

// ⚠ 下载/安装：2 档走 model_manager 的 download，3 档走 managed_environment 的 prepare。
//   两条都在【引擎侧】的 Python 里，这边只负责发起 + 报进度 + 如实报错。
//   ⚠ model-downloads.json 空着的时候，这里必须【明说装不了】，不能装作开始了。
let enginesCatalogCache=null;
async function enginesProbe(force){
  if(!window.MATTINGENGINE) return null;
  try{
    const snap=await MATTINGENGINE.probe(force===true);
    if(enginesCard) enginesCard.reload();
    return snap;
  }catch(error){
    ERR.report('ENGINE_OPERATION_FAILED',{message:String(error&&error.message||error)});
    return null;
  }
}
// ⭐⭐ 2026-10-06 docs/150 Phase B：引擎/环境/模型状态的宿主刷新口。
//   唯一状态出口 = V7EngineStatus（§9.2）；刷新时机只有三个（§4.1）：
//     卡打开 / 手动"重新扫描" / 安装·导入·启停操作完成后。卡关闭不轮询。
async function enginesStatusRefresh(force){
  if(!window.V7EngineStatus) return null;
  try{
    const snap=await V7EngineStatus.refresh({force:force===true,models:true,environment:true});
    if(enginesCard) enginesCard.reload();
    return snap;
  }catch(error){
    // 状态出口自己容错；这里不再往报错堆扔 —— 缺环境/引擎没起是状态，不是错（§三-7）。
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一键开启加速（2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话："我要用户到手就能用，然后他们能够自己配置 PyTorch 和 CUDA，
 *           然后启动的时候能选择直接启动当前配置支持的最高的那一档。"
 *
 * 为什么要有这条链 —— 断链的每一段都是实测出来的（不是猜的）：
 *   ① 隔离环境里【从来没装过 torch】（engine/requirements.txt 只有 numpy/PIL/cv2/onnx）
 *   ② 引擎 probe 到 caps.torch=false / caps.cuda=false（引擎自己的日志原话：
 *      "装了 PyTorch 版模型，但 torch 用不了：No module named 'torch'"）
 *   ③ 于是 4 个要显卡的模型被标成 broken（引擎原话："模型下好了，但这台机器
 *      没装 PyTorch，跑不了它"）→ 人体解析 / 细边 / 文字选区 / 过渡帧 档位全掉 0
 *   ④ 加速档 = torch && cuda = false ⇒ 永远"未装"
 *   ⚠ 而这 4 个模型【文件一个都不缺】（跑引擎自己的 MODELS 表读过：ok=16 broken=0）。
 *     ⇒ 缺的只有 torch 一样东西。所以这条链只做"把 torch 装上"，
 *       不重新下模型、不重建环境（除非环境本来就没就绪）。
 *
 * ⚠ 为什么自动跳过已就绪的步骤：用户明确嫌"启动的东西太多"。
 *   每一步都先读状态，已经好了就跳过并在进度线上明说"已经是好的，跳过"。
 * ⚠ 失败必须说清卡在哪一步（step 字段），不许笼统说"失败了"。
 */
async function engineAccelStart(onStep){
  const say=m=>{ try{ onStep&&onStep(m); }catch(_){} };
  const envApi=(window.uiwin&&window.uiwin.engine&&window.uiwin.engine.environment)||null;
  if(typeof envApi!=='function') return {ok:false,step:'连接',error:'这个版本还没有环境管理的入口'};

  // ── 第 1 步：读环境现状 ────────────────────────────────────────────
  say('正在看当前环境…');
  let status=null;
  try{ status=await envApi('status'); }
  catch(error){ return {ok:false,step:'读环境状态',error:String(error&&error.message||error)}; }
  if(!status||typeof status!=='object') return {ok:false,step:'读环境状态',error:'环境状态是空的'};

  const accel=status.accel||{};
  if(accel.available===false) return {ok:false,step:'看显卡',error:String(accel.reason||'这台机器开不了加速档（没检测到可用的 N 卡）')};

  const coreReady=(status.ok===true&&status.ready===true&&status.state==='ready');

  // ── 第 2 步：装加速包（核心环境没就绪就一起装，一步到位）──────────
  if(accel.state==='installed'&&coreReady){
    say('加速包已经装好了，跳过');
  }else{
    say(coreReady
      ? '核心环境已经是好的，只装加速包（约 3GB，慢慢下）…'
      : '核心环境还没就绪，一起装（基础依赖 + 加速包约 3GB）…');
    let r=null;
    try{ r=await envApi('prepare','cuda'); }
    catch(error){ return {ok:false,step:'装加速包',error:String(error&&error.message||error)}; }
    if(!r||r.ok!==true){
      if(r&&r.cancelled) return {ok:false,cancelled:true,step:'装加速包',error:'已经取消'};
      return {ok:false,step:'装加速包',error:String((r&&r.error)||'装加速包没完成')};
    }
    // ⚠ 装完要复核：prepare 返回 ok=true 只代表【核心环境】好了。
    //   加速包装失败时它走的是"只记状态不抛"那条路（核心环境不能被加速失败毁掉），
    //   所以这里必须再读一次状态，看加速档到底成没成 —— 不许把 ok 当成功糊弄过去。
    say('正在复核加速档…');
    let after=null;
    try{ after=await envApi('status'); }catch(_){ after=null; }
    const a2=(after&&after.accel)||{};
    if(a2.state!=='installed'){
      return {ok:false,step:'装加速包',error:String(a2.reason||'加速包没装上（核心环境是好的，可以稍后重试）')};
    }
  }

  // ── 第 3 步：拉起外挂引擎（那 4 个要显卡的模型跑在它里面）─────────
  say('正在启动外挂引擎…');
  const started=await engineStartAndWait(say,'matting');
  if(!started.ok){
    return {ok:false,step:'启动引擎',error:String(started.error||'引擎没起来')};
  }
  say('好了');
  try{ await enginesStatusRefresh(true); }catch(_){ }
  return {ok:true,step:'',st:started.st,which:'matting'};
}

// ⭐ 界面侧唯一入口：环境行那颗「开启加速」调它（engine-environment-ui.js 里调的）。
window.V7EngineAccel=onStep=>engineAccelStart(onStep);

// ⭐「下次自动开」：勾了就在开机后自己跑一次「开启加速」。
//   ⚠ 只在【勾着】且【加速档确实还没装】时才跑 —— 已经好了就一个字都不做，
//     免得每次开机都去问一遍后端、白等一轮（用户嫌"启动的东西太多"）。
//   ⚠ 静默：不在界面上弹任何东西，失败也只写日志，不弹报错卡
//     （用户没主动点，弹卡就是打扰 —— 这条是 af1efe07 那次"自动检查弹报错卡"的教训）。
async function tryAutoAccel(){
  try{
    if(localStorage.getItem('v7.engine.autoAccel')!=='1') return;
    const envApi=(window.uiwin&&window.uiwin.engine&&window.uiwin.engine.environment)||null;
    if(typeof envApi!=='function') return;
    const status=await envApi('status');
    const accel=(status&&status.accel)||{};
    if(accel.state==='installed') return;              // 已经好了：什么都不做
    if(accel.available===false) return;                // 这台机器没 N 卡：不折腾
    aiAddLog('[加速] 上次勾了「下次自动开」，开始自动开启加速','info');
    const r=await engineAccelStart(m=>aiAddLog('[加速] '+m,'info'));
    if(r&&r.ok) aiAddLog('[加速] 自动开启完成','info');
    else aiAddLog('[加速] 自动开启没完成（'+(r&&r.step?'卡在'+r.step+'：':'')+((r&&r.error)||'原因不明')+'）','warn');
  }catch(_){ /* 自动路径一律不打扰用户 */ }
}
// ── 测速 + 网盘兜底（docs/128 §三-3）────────────────────────────
//  纯换算在 engines-core.js（那边能单测），这里只管"发请求 / 弹卡片"。
const enginesDownloadRuntime={manifest:null,fallback:null};

// 拉清单：后台优先，拉不到就用引擎自带那份。
// ⚠⚠ 兜底是【必须的】—— 后台挂了 / 没登录 / 网络不通时，
//   如果清单直接空了，用户看到的就是"这一档装不了"，明明地址是写死在引擎里的。
async function enginesLoadDownloadManifest(){
  let remote=null;
  try{
    if(window.V7Backend&&typeof V7Backend.modelDownloadManifest==='function'
       &&V7Backend.state&&V7Backend.state().signedIn){
      remote=await V7Backend.modelDownloadManifest();
    }
  }catch(error){
    // 拉不到不是错 —— 按设计退回内置清单
    if(window.ERR)ERR.report('MODEL_DOWNLOAD_UNAVAILABLE',{message:'后台清单拉不到，用引擎自带的：'+String(error&&error.message||error)});
  }
  const core=window.V7EnginesCore;
  const builtin=enginesCatalogCache||null;
  if(core&&typeof core.mergeManifests==='function'&&remote){
    const merged=core.mergeManifests(builtin,remote);
    enginesDownloadRuntime.fallback=merged.fallback;
    return merged;
  }
  enginesDownloadRuntime.fallback=(core&&core.DOWNLOAD_DEFAULTS)||null;
  return builtin;
}

// 这一档第一个"有地址、能下"的模型。
function enginesFirstDownloadable(manifest,tier){
  const keys=(window.V7EnginesCore&&V7EnginesCore.TIER_MODELS&&V7EnginesCore.TIER_MODELS[tier])||[];
  const items=(manifest&&manifest.models)||{};
  for(const key of keys){
    const item=items[key];
    if(!item) continue;
    if(item.enabled===false) continue;
    const src=(window.V7EnginesCore&&V7EnginesCore.primarySource)?V7EnginesCore.primarySource(item):'';
    if(src) return {key,item,src};
  }
  return null;
}

// 向主地址要一小块，计时。
// ⚠ 只认 window.uiwin.http.fetch（两个壳同名同形）——
//   直接 fetch 在 UXP/Tauri 里没有 CORS 那一套不说，还拿不到 headers。
async function enginesProbeSpeed(url,cfg){
  const core=window.V7EnginesCore;
  const conf=cfg||enginesDownloadRuntime.fallback||(core&&core.DOWNLOAD_DEFAULTS)||{probeBytes:1048576,probeTimeoutMs:3000};
  if(!(window.uiwin&&window.uiwin.http&&window.uiwin.http.fetch)) return {ok:false,error:'没有下载通道'};
  const started=Date.now();
  const requestId='speed-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  try{
    const r=await window.uiwin.http.fetch({
      url:url,method:'GET',
      headers:{'Range':'bytes=0-'+(conf.probeBytes-1)},
      timeoutMs:conf.probeTimeoutMs,
      requestId:requestId
    });
    const ms=Date.now()-started;
    // ⚠ 拿到的字节数按 base64 长度反推不准，直接看响应体长度。
    //   服务器可能不理 Range 直接回整包 —— 那时候 body 会很大，
    //   我们只关心"这一小段用了多久"，所以按请求的字节数封顶算。
    const got=r&&typeof r.body==='string'?r.body.length:0;
    return {ok:true,bytes:Math.min(got,conf.probeBytes),ms:ms};
  }catch(error){
    return {ok:false,error:String(error&&error.message||error)};
  }
}

// 测速闸门：够快返回 route='direct'，慢/连不上返回 route='pan'。
// ⚠ 任何一步出问题都【返回 direct】—— 宁可直连去试，也不能因为测速自己的毛病不让装。
async function enginesSpeedGate(tier){
  const manifest=await enginesLoadDownloadManifest();
  const pick=enginesFirstDownloadable(manifest,tier);
  if(!pick) return {route:'direct',reason:'no-model'};
  const core=window.V7EnginesCore;
  if(!core||typeof core.classifySpeed!=='function') return {route:'direct',reason:'no-core'};
  const probe=await enginesProbeSpeed(pick.src,enginesDownloadRuntime.fallback);
  const decision=core.classifySpeed(probe,enginesDownloadRuntime.fallback);
  return {route:decision.route,decision:decision,model:pick.item,key:pick.key,src:pick.src};
}

// 网盘兜底卡：链接和提取码都从【后台】来，页面里一个字都不写死。
// ⚠ 用 L3 dialog（要用户点一下）而不是 toast —— 这是一个需要人动手的分支，
//   飘一条两秒就消失的提示等于没告诉。
//
// ⭐⭐ 2026-10-09（用户要求）：链接改成【每次现拉后台】。
//   用户原话：「有时候可能这个链接会过期，或者百度网盘链接会失效，
//              所以说需要同步到后台」。
//   ⇒ 拉的是 /v1/public/models/pan（免登录、只吐链接+提取码）。
//   ⚠ 顺序很重要：**先拉到再弹卡**。反过来（先弹卡再填链接）会出现
//     "卡片上链接是空的、过一会儿自己蹦出来"，用户可能已经点过复制了。
//   ⚠ 拉不到也不能不给卡：退回清单里那份 panLink（可能是内置的旧值），
//     实在没有就如实说"还没配"，绝不给个空按钮。
async function enginesPanLinkFor(key,model){
  let links={};
  try{
    if(window.V7Backend&&typeof V7Backend.modelPanLinks==='function'){
      links=await V7Backend.modelPanLinks();
    }
  }catch(_){links={};}
  const fromBackend=links&&links[key];
  const backendLink=fromBackend&&fromBackend.panLink?String(fromBackend.panLink):'';
  const backendCode=fromBackend&&fromBackend.panCode?String(fromBackend.panCode):'';
  return {
    link: backendLink || String((model&&model.panLink)||''),
    code: backendCode || String((model&&model.panCode)||''),
    // 后台拉到了才算"配好了"；只有清单里那份旧值也认，但不静默——见下面 missing 文案
    fromBackend: !!backendLink
  };
}

async function enginesShowFallbackCard(model,decision,modelKey){
  const core=window.V7EnginesCore;
  const card=core&&typeof core.fallbackCard==='function'
    ?core.fallbackCard(model,decision)
    :{title:'这次走网盘拿模型',why:'下载服务器太慢',link:'',code:'',steps:[],missing:'这个模型还没配网盘链接'};
  // ★ 链接以【后台】为准，清单里那份只当兜底
  const pan=await enginesPanLinkFor(modelKey,model);
  card.link=pan.link;
  card.code=pan.code;
  card.missing=pan.link?'':'这个模型还没配网盘链接，先找客服';
  const steps=card.steps.map((s,i)=>(i+1)+'. '+s).join('\n');
  const body=[
    card.why?('原因：'+card.why):'',
    card.link?('网盘链接：'+card.link):'',
    card.code?('提取码：'+card.code):'',
    card.missing?card.missing:'',
    '',
    '怎么放：',
    steps
  ].filter(line=>line!=='').join('\n');
  UI.dialog({
    title:card.title,
    body:body,
    confirm:'复制链接',
    cancel:'打开模型文件夹',
    safeClear:'none',   // 垃圾桶一键清时只收起，不替用户打开文件夹（2026-10-18 深夜）
    onConfirm:function(){
      if(!card.link){UI.toast('这个模型还没配网盘链接','warn',3000);return;}
      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(card.link).then(
            ()=>UI.toast('链接已复制','ok',2000),
            ()=>UI.toast('复制失败，请手动选中上面的链接','warn',3200));
        }else{
          UI.toast('这个环境不能自动复制，请手动选中上面的链接','warn',3200);
        }
      }catch(_){UI.toast('复制失败，请手动选中上面的链接','warn',3200);}
    },
    onCancel:async function(){
      // 复用现成的「打开模型文件夹」通道，别新开一条
      try{
        if(window.uiwin&&window.uiwin.engine&&window.uiwin.engine.openModelsDir){
          const r=await window.uiwin.engine.openModelsDir();
          if(!r||r.ok!==true) throw new Error((r&&r.error)||'打不开模型文件夹');
        }else{
          UI.toast('这个环境打不开文件夹','warn',3000);
        }
      }catch(error){
        ERR.report('ENGINE_OPERATION_FAILED',{message:'打开模型文件夹失败：'+String(error&&error.message||error)});
      }
    }
  });
}
// ⭐⭐ 2026-10-06 Phase B（docs/150 §5.3）：安装编排 installTier。
//   ① 读 V7EngineStatus 的模型清单 → 收集 tier≤n 且 state≠present/ok 且【有下载源】的模型 → 逐个下。
//   ② 保留现有测速 / 网盘兜底链（enginesSpeedGate / enginesShowFallbackCard）原样，不重写判据。
//   ③ 无可下载源（当前 model-downloads.json 为空，必然命中）：行内说清楚 + 只给「导入」，
//      【不弹红错】—— 那是数据前置，不是用户操作失败（docs/150 §5.3、§三-7）。
async function enginesStartInstall(n){
  const tier=Number(n)||1;
  if(tier===1){
    // 1 档是纯本机算法，不需要装任何东西 —— 如实说清楚，别弹个假进度条
    UI.toast('1 档不需要下载 —— 它用的算法已经在软件里了');
    return false;
  }
  if(!window.V7EngineModels||typeof V7EngineModels.request!=='function'){
    UI.toast('下载通道还没接上，暂时装不了');
    return false;
  }
  // 实时清单走唯一状态出口；拿不到就按"没有可下的"处理（页面文案会如实说拿不到）。
  let snap=null;
  if(window.V7EngineStatus){
    try{ snap=await V7EngineStatus.refresh({force:true,models:true,environment:false}); }catch(_){ }
  }
  const list=(snap&&Array.isArray(snap.models))?snap.models:[];
  const want=list.filter(m=>m.tier>0&&m.tier<=tier&&m.state!=='ok'&&m.state!=='present'&&m.downloadable);
  if(!want.length){
    UI.toast('这一档没有可下载的模型 —— 缺少下载源，去配置页「模型文件」用「导入」','warn',3600);
    return false;
  }
  // ── 装之前先测速（docs/128 §三-3）──────────────────────────────
  //   够快就直接下；太慢 / 连不上就弹网盘兜底卡，让用户手动下。
  //   ⚠ 这一段【失败不算装不了】—— 测速本身出错（比如引擎没开）就照常直连，
  //     不能因为"测不了速"就不给装。
  try{
    const gate=await enginesSpeedGate(tier);
    if(gate&&gate.route==='pan'){
      // ⚠ 把 key 一起传 —— 网盘链接是按模型 key 从后台取的
      await enginesShowFallbackCard(gate.model,gate.decision,gate.key);
      return false;
    }
  }catch(error){
    // 测速环节的问题不该挡住下载 —— 记一笔，继续走直连
    ERR.report('ENGINE_OPERATION_FAILED',{message:'测速没做成，直接开始下载：'+String(error&&error.message||error)});
  }
  try{
    for(let i=0;i<want.length;i++){
      enginesCard&&enginesCard.setProgress(i/want.length,tier);
      const r=await V7EngineModels.request('download',want[i].key);
      if(r&&r.cancelled) return false;
      if(r&&r.ok===false) throw new Error(r.error||r.message||'下载失败');
    }
    enginesCard&&enginesCard.setProgress(1,tier);
    enginesCard&&enginesCard.doneInstall(tier);
    UI.toast(tier+' 档装好了');
    await enginesStatusRefresh(true);
    return true;
  }catch(error){
    enginesCard&&enginesCard.failInstall(tier,String(error&&error.message||error));
    ERR.report('ENGINE_OPERATION_FAILED',{message:String(error&&error.message||error)});
    return false;
  }
}
async function enginesRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  // ⚠ 单张大二级 —— zoneSel 必须归 0（同记录卡/设置卡，否则算出野槽位）
  zoneSel=0;
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  closeEnginesDetail();
  const card=enginesCardMount();
  if(card){
    // ⚠ 先探测一次再开 —— 不然开出来是"上一次的旧状态"，用户会以为没生效。
    //   拿不到引擎也照常开（界面会如实说"还没探测到引擎"），不能因为引擎没起来就白屏。
    // ⭐ Phase B：统一走状态出口（引擎+环境+模型都在这一口里），别再用 half 的 enginesProbe。
    await enginesStatusRefresh(false);
    card.open(opts.zone||(opts.cap||null),'route');
    enginesOpenZone();
    if(opts.highlight){
      const selector=opts.highlight;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const node=enginesCardEl()?.querySelector(selector);
        if(!node)return;
        // ⭐ 2026-10-06 docs/150 §4.3：同设置卡 —— 先展开目标所在的折叠体，再滚 + 高亮。
        window.V7CardArchitecture?.expandAncestors?.(node);
        if(!node.checkVisibility?.())return;
        node.scrollIntoView({block:'nearest',behavior:'smooth'});
        node.classList.add('route-highlight');
        setTimeout(()=>node.classList.remove('route-highlight'),3300);
      }));
    }
  }
  return {body:document.getElementById('dcBody'),cancelled:false,engines:true};
}
function enginesOpenZone(){
  if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
  // ⚠⚠ 2026-10-03 晚【竞态】修复：同 settingsOpenZone 那处 ——
  //   原来只写 `allCloseTimer=null`，【没 clearTimeout】。
  //   closeAll() 排的那个 360ms 清场定时器因此照旧会响，把刚开的二级拆掉。
  //   ⇒ 用户报的「外挂卡右滑打不开二级」的两个真因之一就是这个（另一个是右滑分支没给这卡开门）。
  if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  const target=enginesCardEl();
  const wasOpen=target&&target.classList.contains('show');
  if(target) target.style.display='';
  if(!wasOpen&&target){
    ['.z-glow','.z-bright'].forEach(cls=>{
      const el=target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration='0.6s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
}
function enginesCloseZone(){
  if(!enginesCard||!enginesCard.isOpen()) return;
  enginesCard.close();
  enginesCardEl()&&enginesCardEl().classList.remove('show');
  if(!zones.querySelector('.zone.show')) zones.classList.remove('show');
}
// 检查点间隔：数字设置项，跟 checkpointIntervalMs() 同一份夹紧规则
function checkpointIntervalValue(){
  return Math.max(1,Math.min(60,Number(settingsRuntime.checkpointIntervalMin)||5));
}

function fillZonesNow(){
  syncZoneKind();
  // 预设卡: 二级是单张列表卡, 内容交给 preset-ui.js 自己填
  if(isPresetCard()){
    if(window.PRESETUI){ if(presetZoneKind==='prompt') PRESETUI.fillPromptZone(); else PRESETUI.fillZone(); }
    return;
  }
  // 记录与恢复卡: 二级也是单张 540×400 大卡, 内容交给记录卡模块自己填
  if(isRecordsCard()){
    recordsCardReload();
    return;
  }
  // 设置卡（2026-10-01）: 同上，单张 540×400 大卡，内容交给设置卡模块自己填
  if(isSettingsCard()){
    return;
  }
  // 生成卡（2026-10-15）: 同上
  if(isGenerationCard()){
    return;
  }
  // 助手卡（2026-10-17）: 同上，内容由 V7AgentZone 画
  if(isAssistantCard()){
    return;
  }
  // 问题反馈卡（2026-10-18 深夜）: 同上，内容由 V7Feedback 画
  if(isFeedbackCard()){
    return;
  }
  // 社区卡（2026-10-20）: 同上，内容由 V7Community 画
  if(isCommunityCard()){
    return;
  }
  const set=ZONE_SETS[cur]||ZONE_SETS[0];
  zones.querySelectorAll('.zone:not(.pzone)').forEach((z,i)=>{
    const body=z.querySelector('.z-body'); if(!body) return;
    const d=set[i]; if(!d) return;
    const ic=body.querySelector('.z-ic'), nm=body.querySelector('.z-name'), sb=body.querySelector('.z-sub');
    setZoneIcon(ic, d[0]);
    if(nm) nm.textContent=d[1];
    if(sb) sb.textContent=d[2];
  });
}

function syncZonesToCard(dir){
  const d0 = (dir===undefined? lastDir : dir);
  // ⚠ 记住这次有没有换二级种类 —— 换了的话那张卡是刚 display 出来的，
  //   带着旧内容，不能再走"淡出→等→写→滑入"那条路（见 slideZoneBody 的注释）。
  const kindChanged = syncZoneKind();
  // ⭐ 记录卡（2026-09-30 修，docs/96 问题一第 1 条路径）：
  //   这张卡没有三级，必须【在这里就返回】。以前它落进下面普通分支 →
  //   `if(detail.show) setTimeout(syncDetailToZone,120)` → fillDetailBody →
  //   fillHistoryDetail，把老版历史库画进一个本该不存在的三级框。
  //   症状就是用户报的"从别的卡切到记录卡，冒出残留三级框"。
  //   ⚠ 二级内容由记录卡模块自己管（recordsCardReload），这里不用管。
  if(isRecordsCard()){ closeRecordsDetail(); return; }
  // 预设卡的二级是单张卡(不是四张错落)，但【切主卡时一样要整体上下滚动】——
  // 2026-09-11 之前这里是直接重填，表现是"别的卡切换有滚动、预设的二级是硬切"。
  // ⚠ 滚的是【内容层】不是卡片本身: 卡片还要参与二级的联动位移，
  //   动卡片会和那套位移打架。
  if(isPresetCard()){
    if(window.PRESETUI){
      const zoneEl = presetZoneKind==='prompt' ? promptZoneEl : presetZoneEl;
      const inner = zoneEl && (zoneEl.querySelector('.qz-body') || zoneEl.querySelector('.pz-body'));
      const write = ()=>{ if(presetZoneKind==='prompt') PRESETUI.fillPromptZone(); else PRESETUI.fillZone(); };
      slideZoneBody(inner, write, d0, kindChanged);
    }
    if(detail.classList.contains('show')) setTimeout(()=>syncDetailToZone(d0), 120);
    return;
  }
  const set=ZONE_SETS[cur]||ZONE_SETS[0];
  const els=zones.querySelectorAll('.zone:not(.pzone)');
  const out = d0>0 ? -SLIDE_Z : SLIDE_Z;   // 滑走方向: 向下滚 → 内容向上滑走
  const inn = d0>0 ?  SLIDE_Z : -SLIDE_Z;  // 新内容从反侧滑入
  // ⚠ 同预设卡那条路：刚从预设卡切回来时，这四张也是刚 display 出来的，
  //   身上留着上一次的内容。淡出旧内容 = 闪一下 + 白等 150ms。
  //   kindChanged 时直接写完滑入，不淡出。
  if(kindChanged){
    els.forEach((z,i)=>{
      const body=z.querySelector('.z-body'); if(!body) return;
      const d=set[i];
      if(d){
        setZoneIcon(body.querySelector('.z-ic'), d[0]);
        body.querySelector('.z-name').textContent=d[1];
        body.querySelector('.z-sub').textContent=d[2];
      }
      body.style.transition='none';
      body.style.transform='translateY('+inn+'px)';
      body.style.opacity='0';
      setTimeout(()=>{
        requestAnimationFrame(()=>{
          body.style.transition='transform .18s var(--ease-out), opacity .15s var(--ease-soft)';
          body.style.transform='translateY(0)';
          body.style.opacity='1';
        });
      }, i*STAGGER);
    });
    if(detail.classList.contains('show')) setTimeout(()=>syncDetailToZone(d0), 120);
    return;
  }
  els.forEach((z,i)=>{
    const body=z.querySelector('.z-body'); if(!body) return;
    const d=set[i];
    setTimeout(()=>{
      body.style.transition='transform .15s var(--ease-out), opacity .15s var(--ease-soft)';
      body.style.transform='translateY('+out+'px)';
      body.style.opacity='0';
      setTimeout(()=>{
        if(d){
          // ⚠⚠ 写图标的地方【有两处】：这里 和 fillZonesNow()。
          //   2026-09-14 只改了那一处，这里漏了 —— ZONE_SETS 已经换成图标名，
          //   这里还在当文字写，界面直接显示出 "sparkles" 再被 30px 的框裁成 "parkles"。
          //   以后动 ZONE_SETS 的图标格式，两处必须一起改。
          setZoneIcon(body.querySelector('.z-ic'), d[0]);
          body.querySelector('.z-name').textContent=d[1];
          body.querySelector('.z-sub').textContent=d[2];
        }
        // 瞬移到反侧起点(无动画), 再滑回原位
        body.style.transition='none';
        body.style.transform='translateY('+inn+'px)';
        requestAnimationFrame(()=>{
          body.style.transition='transform .18s var(--ease-out), opacity .15s var(--ease-soft)';
          body.style.transform='translateY(0)';
          body.style.opacity='1';
        });
      }, 150);
    }, i*STAGGER);
  });
  if(detail.classList.contains('show')){
    setTimeout(()=>syncDetailToZone(d0), 120);
  }
}

