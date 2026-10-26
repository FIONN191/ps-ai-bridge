// ═══ ui-main/16-engines-detail-fill.js —— 主界面主程序第 16 / 21 段 ═══
//   管什么：外挂能力卡三级 · 跳过去的二级 · 填三级 / 静默填二级 · 记录卡卡面 / 搜索 / 回调
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 外挂能力卡 · 三级渲染(2026-09-12) ═══════════════════════
//  四个分区：加速引擎 / 对齐方式 / 细节补偿 / 更多模型
//
//  ⚠ 这张卡管的是【装了才有、不装也能用】的东西。
//    所以每一项都要说清楚两件事：现在能不能用、不能用的话差什么。
//    "不可用"却不说差什么，等于没说（这是本项目最忌讳的静默失效）。
// ⚠ 这张表要和 ZONE_SETS[CARD_ENGINES] 一一对应（顺序、条数都要一致）——
//   一个管二级分区的显示，一个管三级的内容，对不上就会"点第4个显示第3个的内容"。
const ENGINES_ZONE_SET=[['engine','加速引擎'],['align','对齐与校色'],['detail','细节补偿'],['matting','抠像与分割']];

// ⚠⚠ 2026-10-01 外挂卡改成单张大二级之后【没有三级了】。
//   但原来三级里那些设置项（自动对齐 / 对齐方式 / 自动校色 / 校色方式 /
//   细节补偿 / 引擎开关）不能就这么丢掉 —— 丢了用户就是"看得见但改不了"，
//   比没有还坏（铁律 15 的反面：设置项要么真接线，要么别出现）。
//   所以把「每样能力的设置项」抽成两个函数，由新卡的二级页调用：
//     enginesCapSettingsHtml(kind)      → 出 HTML
//     enginesCapSettingsBind(body,kind) → 挂绑定 + 触发异步块
//   kind 沿用老的分区名：engine / align / detail / matting。
//   ⚠ 映射关系写死在 engines-card.js 那边（color/align→align，detail→detail，
//     抠像/解析/点选→matting，总览→engine）。
function enginesCapSettingsHtml(kind,opts){
    opts=opts||{};
    let html='';
    if(kind==='engine'){
      // ⚠⚠ 2026-10-05：`opts.noBox` 由外挂卡二级的「配置信息」页传进来 ——
      //   那一页顶部【已经常驻】一条引擎状态（开关 + 启动/停止/重新检测三个按钮），
      //   再嵌一个 engineBoxHtml() 就是第二份同样的东西。
      //   探针实测那份重复的东西占 215px，是那一页要滚 1.8 屏的主要原因。
      //   ⚠ 设置卡那边不传 noBox，照旧带框 —— 它没有顶栏那一份。
      // ⚠⚠ 2026-10-05：配置信息页（noBox）连这句说明也不要 ——
      //   顶栏已经在讲引擎开没开，设置卡里有完整解释。这一页只留两个开关，一屏看完。
      // ⚠⚠ 2026-10-05 用户："下面用不用加速，这个东西说起来非常模糊。你需要在设置里面
      //   尽量避免口语化的内容以及过于专业的语言，而是需要使用大白话加书面化的语言
      //   去构建我们的设置内的页面。"
      //   ⇒ 「用不用加速」改成说清【它在决定什么】：让谁去算。
      //     选项也不再是"自动/只用本机算的"这种口语，改成两个明确的说法。
      // ⭐ Phase F（用户 2026-10-06 定）：所有引擎开机都不自启，只能手动开 ——
      //   原来的「随软件一起启动」开关已删（留着就是死开关，铁律 16）。
      //   settingsRuntime.engineAutoStart 键保留只为兼容旧存档，代码不再读它。
      html=(opts.noBox?'':'<div class="ai-help">不装也能用 —— <b>对齐和校色都已经内置</b>。想更准就要它。</div>')
        +'<div class="settings-grid">'
        +settingControl('matchTier','由谁来计算','select',[
            ['3','优先使用加速引擎'],['1','只使用软件自带的算法']])
        +'</div>'
        +(opts.noBox?'':engineBoxHtml());
    }
    else if(kind==='align'){
      html='<div class="ai-help">AI 模型有自己的原生比例。你递交 1020×1028，它近似到 1:1 做成 1024×1024，返回再拉回来 ——'
        +'<b>两次重采样</b>会让没被修改的部位也上下抖。对齐就是修这个。</div>'
        +'<div class="settings-grid">'
        +settingControl('autoAlign','自动对齐','checkbox')
        +settingControl('alignMode','用哪种','select',[
            // 2026-10-24 删了「精确对齐」(flow)：光流会把 AI 改过的形状扭回去 / 扭歪（docs/273，用户定永久删除）
            ['mesh','快速对齐（推荐）'],['off','不对齐']])
        +'</div>'
        +'<div class="ai-help" data-align-tip></div>'
        +'<div class="ai-help" style="margin-top:10px">—— 校色是另一回事 ——<br>'
        +'对齐管<b>位置</b>，校色管<b>颜色</b>，两个互不影响，可以分别开关。</div>'
        +'<div class="settings-grid">'
        // ⭐⭐⭐ 2026-10-08（docs/170 §4.2/§4.8）：勾选框 → 四选一下拉。
//   ⚠ 选项名只写【效果名】，不写实现词（光流 / LUT / 引导滤波 一律不许出现）——
//     这是项目的老规矩（docs/141 §二）。
//   ⚠ 每项用大白话写清【它什么时候不好】，用户才有判断依据。
+settingControl('colorMatchMode','校色方式','select',[
    ['off','不校色 —— 保持 AI 原本的颜色'],
    ['global','全局 —— 整张图按颜色配平，不看位置（AI 大改内容时整体颜色会被带偏）'],
    ['precise','精准 —— 按位置把原图颜色换回来（AI 改过的地方会出鬼影）'],
    ['hybrid','混合 —— 只校内容没变的地方（偏保守，但最不容易出鬼影）'],
  ])
        // ⚠⚠⚠ 2026-10-05：「校色方式」这个下拉【已删】—— 用户拍板
        //   "把之前的校色算法全都干飞掉"。主链路现在只有【混合判据】一条路，
        //   没有第二种可选，留着这个下拉就是铁律 16 说的"能存不生效的开关"。
        //   （引擎那边 color_lowfreq / color_mkl 只留给实验台做对照基准线。）
        +'</div>';
    }
    else if(kind==='detail'){
      html='<div class="ai-help">重采样还会让<b>边缘、直线、弧线变糊</b>。这一步用原图的高频细节把锐度补回来。'
        +'<br>它<b>只补细节，不改形状</b> —— 眼睛多大、脸多瘦仍然由 AI 决定。</div>'
        // ⚠ 默认关是【实测结论】，不是"保守起见"。必须把数摆出来，
        //   否则下一个人看到一个默认关的功能，只会以为是没做完。
        +'<div class="ai-help" style="border-left:2px solid #ffd479;padding-left:9px">'
        +'⚠ <b>2026-09-12 起默认关掉了</b>，因为实测它<b>在帮倒忙</b>：<br>'
        +'原图放大后能追到的上限 <b>16.41</b>，AI 原样 <b>13.04</b>，只对齐 <b>12.86</b>，'
        +'补完反而掉到 <b>11.93</b> —— 比不补还糊。<br>'
        +'原因是 AI 返回的图被放大过，拿来当"原料"的原图先天就糊了一档。<br>'
        +'现在换了参数（半径15/强度1.5/不降噪）能跑到 <b>15.03</b>，是正收益，'
        +'但<b>要不要默认开着还没定</b>。想用就手动打开。</div>'
        +'<div class="settings-grid">'
        +settingControl('detailBoost','细节补偿（用原图高频补回锐度）','checkbox')
        +settingControl('detailStrength','补偿强度','number')
        +'</div>'
        +'<div class="ai-help" style="margin-top:10px">—— 传回 Photoshop 之后 ——<br>'
        +'补好的图会<b>单独一层盖在那张 AI 图上方</b>（剪切蒙版嵌进去），'
        +'<b>AI 那张图一个像素都不动</b>。<br>'
        +'在 PS 里点一下眼睛就能对比补前补后；不想要直接删掉那一层。<br>'
        +'⭐ 不开自动也没关系 —— <b>鼠标划到任务栏的缩略图上，下面会浮出「替换 / 增益」两个按钮</b>，'
        +'挑中满意的那张单独补就行。'
        +'</div>'
        +'<div class="settings-grid">'
        +settingControl('autoDetailTier','传回后自动补细节','select',[
            ['off','不自动（推荐 · 用缩略图上的按钮按需补）'],
            ['replace','自动用「替换」档（细节还原）']])
        +'</div>'
        +'<div class="ai-help">⚠ 自动档是<b>整批</b>补的，一张约 1.5 秒 —— 18 张要等半分钟。'
        +'开了之后那两个按钮<b>照样能用</b>，随时可以换档。</div>'
        +'<div class="ai-help">⚠ 这一步<b>只有加速引擎（档 2）能做</b>。'
        +'引擎没启动时开着它也不会生效 —— 那时日志里会写明"跳过细节补偿"。</div>'
        +'<div class="ai-help">调参用的实验台：<span data-selectable style="color:var(--accent)">'
        +'http://127.0.0.1:37893/compare</span>（要先启动引擎）。'
        +'能调抠法/半径/叠加方式，还能 A/B 两组参数并排比。</div>';
    }
    else if(kind==='matting'){
      // ⭐ 抠像模型库（2026-09-14）。内容由 refreshMattingBox() 异步填 ——
      //   要去问引擎（探活 + 扫模型目录），不能同步渲染。
      // ⚠ 2026-09-14 深夜：这张卡现在管【三样】—— 抠像 / 人体解析 / 指哪抠哪，
      //   它们共用同一个引擎、同一个模型目录、同一个端口（37894）。
      //   文案必须跟着改：只写"抠像"的话，用户看到列表里冒出一堆别的模型会懵。
      html='<div class="ai-help">这里管三样外挂能力：<b>抠像</b>、<b>人体解析</b>（按部位拆图层）、'
        +'<b>指哪抠哪</b>（你框哪它抠哪）。它们共用同一个引擎。</div>'
        +'<div class="ai-help">⚠ 和校色不一样：<b>没有本机兜底</b> —— 不装模型就是做不了，'
        +'不会偷偷用别的办法糊弄过去。</div>'
        // ⭐ Phase F（用户 2026-10-06 定）：引擎一律不自启，只能手动开 ——
        //   原来的「跟软件一起启动外挂引擎」开关已删（死开关，铁律 16）。
        //   settingsRuntime.engineAutoStartMatting 键保留只为兼容旧存档，代码不再读它。
        +'<div data-matting-box><div class="ai-note">正在检查…</div></div>';
    }
    else{
      html='<div class="ai-help"><b>还没接入。</b><br><br>'
        +'这里将来放更多的对齐精度档、超分模型等。<br><br>'
        +'⚠ 什么时候才值得加新东西，判据很简单：'
        +'实际用下来出现过「明明该对上、结果没对上」才算数 —— '
        +'没有真实的失败样本就上模型，等于凭想象堆算力。</div>';
    }
    return html;
}

// 挂上「每样能力」的设置项绑定 + 触发异步块。
// ⚠⚠ 这两块的内容是【异步填的】（要去问引擎），写完 HTML 之后必须调用一次。
//   ⚠ 2026-09-14 栽过：抠像那条加到了 bindSettingsDetail 里 ——
//     那是【设置卡】的绑定函数，而抠像在【外挂能力卡】。
//     结果 refreshMattingBox 从来没被调用，界面永远停在"正在检查…"。
//     加异步内容块时，认准它属于哪张卡。
function enginesCapSettingsBind(body,kind){
  if(!body) return;
  if(kind==='engine'){ refreshEngineBox(false); }
  if(kind==='matting'){ refreshMattingBox(false); }
  bindNumControls(body);
  // ⚠ 这里【不能】用 bindSettingsDetail —— 那个函数还带着设置页专属的东西
  //   （快捷键录入、保存/重置按钮）。这张卡没有保存按钮，是【改了就存】。
  //   2026-09-12 第一版直接写了个不存在的 bindSettingsInputs，运行时炸了。
  body.querySelectorAll('[data-setting]').forEach(el=>{
    el.addEventListener('change',()=>{ settingsReadFields(body); updateAlignTip(body); });
    el.addEventListener('input',()=>{ settingsReadFields(body); updateAlignTip(body); });
  });
  updateAlignTip(body);
  V7CardArchitecture.helpify(body);
}

// 外挂卡【没有三级】（2026-10-01 改成单张大二级）。
// ⚠ 同记录卡/设置卡：不只藏起来，还要清空 #dcBody，防"隐形残留"。
function closeEnginesDetail(){
  const body=document.getElementById('dcBody');
  if(body){ V7CardArchitecture?.reset?.(body); body.replaceChildren(); }
  const el=document.getElementById('detail');
  if(el) el.classList.remove('show');
}

// 对齐方式的说明跟着选择变 —— 每种的代价要当场说清楚
function updateAlignTip(root){
  const el=(root||document).querySelector('[data-align-tip]');
  if(!el)return;
  const v=String(settingsRuntime.alignMode||'mesh');
  el.innerHTML=({
    mesh:'<b>快速对齐</b>：只允许画面整体轻微扭动。'
      +'<br>⭐ <b>它扭得少，正是它的安全之处</b> —— 它<u>扭不动</u>「眼睛放大一圈」这种局部改动，'
      +'所以不会把 AI 修脸的成果撤销掉。',
    off:'<b>不对齐</b>：完全不动几何。重采样带来的漂移会保留。'
  })[v]||'';
}

let cardRouteOptions={},cardRouteEpoch=0,cardRouteRequest=0;
// ⭐ 2026-10-19（docs/250 第 5 条）：点按钮跳过去打开的二级，鼠标第一次进去之前不按「离开就收」处理（见 zonesOpenedByNav）。
//   ⚠ 标记要在【开面板之前】立：面板是在下面各条路线里面开的，中间还有等待，等完再立的话这段时间里鼠标一动就收了。
//     （各条路线里没有调 closeAll / closeZones —— 10-19 逐个查过，只有注释里提到。）
//   ⚠ 没跳成（取消 / 出错）就撤掉自己立的那个；别人后来立的不动（编号对不上）。
async function navigateCard(id,index,options){
  // ⭐ 2026-10-19（docs/250 第 17 条）：自由摆放收成小方块时有人要打开卡（报错卡上的按钮、助手、教程…）⇒ 先把面板放回来，不然开了也看不见
  if(window.V7FreeMode?.isCompact?.()) V7FreeMode.expandCompact({instant:true});
  const navTok=++zonesNavSeq;
  zonesOpenedByNav=navTok;
  const drop=()=>{ if(zonesOpenedByNav===navTok) zonesOpenedByNav=0; };
  try{
    const r=await navigateCardInner(id,index,options);
    if(!r||r.cancelled) drop();
    return r;
  }catch(error){ drop(); throw error; }
}
async function navigateCardInner(id,index,options){
  const routeScope=cacheNamespaceId(),contextEpoch=settingsContextEpoch,request=++cardRouteRequest;
  if(!window.V7LayoutManager?.isReady?.())await window.V7LayoutManager?.init?.();
  if(routeScope!==cacheNamespaceId()||contextEpoch!==settingsContextEpoch||request!==cardRouteRequest)return {body:document.getElementById('dcBody'),cancelled:true};
  const epoch=++cardRouteEpoch;
  const target=cards.findIndex(card=>card.dataset.card===id);
  if(target<0)throw new Error('找不到功能主卡：'+id);
  // Layout initialization may itself invalidate the navigation epoch; the
  // destination starts after that restoration and remains account scoped.
  // ⭐ 记录与恢复卡（2026-09-30）：没有三级，路由进来直接开大二级。
  //   ⚠ 必须放在下面那套通用导航【之前】—— 通用导航会 prepareDetail + 重画三级，
  //     而记录卡压根没有三级内容，走进去会得到一个空的三级面板。
  //   options 可带：{ project, query, checkpoint, section }
  if(id==='history'){
    const opts=options||{};
    // ⚠⚠ 必须先问工作区放不放行（2026-09-30 实装时漏了这一步）。
    //   别的地方走下面那套通用导航时会调 requestCloseAll()，
    //   用户在浏览器/调色那种工作区里改了没保存，切卡会弹"保存并返回"。
    //   我这条早返回绕过了它 → 直接切走、草稿没了、而且不弹框。
    //   （症状：test-tools-workspace-ui 卡在"放弃修改"那个选择上超时。）
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await recordsRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // ⭐ 设置卡（2026-10-01）：同样没有三级，路由进来直接开大二级。
  //   ⚠ 必须放在通用导航【之前】—— 通用导航会 prepareDetail + 重画三级，
  //     设置卡没有三级内容，走进去会得到一个空的三级面板。
  //   options 可带：{ section, highlight, index }
  if(id==='settings'){
    const opts=Object.assign({index:Number(index)||0},options||{});
    // ⚠⚠ 必须在这里就写 cardRouteOptions —— 通用导航里那句赋值在这条早返回【之后】，
    //   不补的话 host.routeOptions() 拿到的还是【上一次】路由的参数，
    //   子页签会静默停在旧的那一页（路由注释里记过同类坑：传错 section 会静默退回第一页）。
    cardRouteOptions=opts;
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await settingsRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // ⭐ 生成卡（2026-10-15 改成单张大二级）：同样没有三级，路由进来直接开大二级。
  //   ⚠ 必须放在通用导航【之前】（同设置卡：通用导航会去画一个不存在的三级）。
  //   老路由传的是 zone 序号 0~3（生成图片 / 参考图片 / 生成结果 / 生成与传回设置），
  //   这里换成大二级里对应的那一节；options.section 也可以直接给节 id。
  if(id==='generation'){
    const opts=Object.assign({index:Number(index)||0},options||{});
    cardRouteOptions=opts;
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await generationRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // ⭐ 助手卡（2026-10-17 夏三六）：单张大二级，没有三级。老路由传 0~3（对话 / 模型与连接 / Agent 权限 / 恢复节点），
  //   这里换成大二级里对应那一节；options.section 也能直接给节 id（chat / model / perm / starts / quick …）。
  if(id==='assistant'){
    const opts=Object.assign({index:Number(index)||0},options||{});
    cardRouteOptions=opts;
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await assistantRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // ⭐ 问题反馈卡（2026-10-18 深夜）：单张大二级，没有三级。options.section = write / images / diag / send。
  if(id==='feedback'){
    const opts=Object.assign({index:Number(index)||0},options||{});
    cardRouteOptions=opts;
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await feedbackRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // ⭐ 社区卡（2026-10-20）：单张大二级，没有三级。options.section = rank / hot / web。
  if(id==='community'){
    const opts=Object.assign({index:Number(index)||0},options||{});
    cardRouteOptions=opts;
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await communityRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // ⭐ 外挂能力卡（2026-10-01）：同样没有三级，路由进来直接开大二级。
  //   ⚠ 必须放在通用导航【之前】—— 通用导航会 prepareDetail + 重画三级，
  //     外挂卡没有三级内容，走进去会得到一个空的三级面板。
  //   options 可带：{ zone, cap, highlight }
  if(id==='engines'){
    const opts=Object.assign({index:Number(index)||0},options||{});
    // ⚠ 同设置卡：这里就得写 cardRouteOptions —— 通用导航里那句在这条早返回【之后】，
    //   不补的话 host.routeOptions() 拿到的是上一次的参数。
    cardRouteOptions=opts;
    if(window.V7Workspaces?.hasEmbedded?.()){
      const accepted=await V7Workspaces.requestCloseAll();
      if(!accepted||epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    }
    const done=await enginesRoute(target,opts);
    if(epoch!==cardRouteEpoch) return {body:document.getElementById('dcBody'),cancelled:true};
    return done;
  }
  // Apply the saved visibility/order before revealing a destination. A late
  // startup layout must not hide the requested card and reset cur mid-route.
  if(window.V7Workspaces?.hasEmbedded?.()){
    const accepted=await V7Workspaces.requestCloseAll();
    if(!accepted||epoch!==cardRouteEpoch)return {body:document.getElementById('dcBody'),cancelled:true};
  }
  const navigation=window.V7NavigationShell?.begin(id,index,options);
  cardRouteOptions=options||{};
  if(isCollapsed)setCollapsed(false);
  layoutHidden.delete(target);
  cur=target;lastDir=1;window.V7FreeMode?.expandGroup('card:'+id);setStack();selectZone(Number(index)||0);fillZonesNow();updateZoneBg(cur);
  // Explicit navigation rebuilds a selected subpage even when the main category is unchanged.
  const body=document.getElementById('dcBody');V7CardArchitecture.prepareDetail(body,'navigation:'+Date.now());
  body.replaceChildren();detail.querySelector('.dc-scroll').scrollTop=0;openDetail(false);detailUsed=true;
  const requested=cardRouteOptions;
  await new Promise(resolve=>setTimeout(resolve,220));
  if(epoch===cardRouteEpoch&&cur===target&&zoneSel===(Number(index)||0)){
    // ⚠⚠⚠ 2026-10-11 审计修（用户要求遍历所有交互、找"人为操作"的坑）：
    //   原来这里只在 `body`（=#dcBody 三级卡容器）里找目标节点。
    //   ⚠ 但【设置卡的内容不挂在 #dcBody 里】——它挂在 #settingsZone。
    //     实测（Electron 真页面，走 settings/layout 路由全程采样）：
    //       t=30ms → t=2435ms 期间  #dcBody.children.length 恒为 0
    //       [data-layout-section] 在页面上（anywhere=true）但【不在 body 里】（inBody=false）
    //     ⇒ node 恒为 null ⇒ 高亮不生效、【懒挂载的折叠也不会展开】。
    //   ⚠ 后果（用户能看到的）：点"布局恢复 / 保存布局"跳到那一节时，
    //     那一节是【折叠着的空壳】—— 里面的布局面板要展开才挂（card-architecture.js:482-487），
    //     而展开要靠 expandAncestors；expandAncestors 又因为 node 是 null 从没被调用。
    //     ⇒ 用户点进去看到一片空，以为功能坏了。这就是铁律 17 说的静默失效。
    //   ⇒ 先在 body 里找；找不到就退到整篇文档里找。
    //     ⚠ 为什么不能只查 document：同一时刻可能有别的容器也有同名钩子，
    //       优先当前卡容器更准（body 命中时行为与以前完全一致）。
    const findNode=sel=>body.querySelector(sel)||document.querySelector(sel);
    const node=requested.highlight?findNode(requested.highlight):requested.section==='layout'?findNode('[data-layout-section]'):null;
    if(node){
      // ⭐ 2026-10-06 docs/150 §4.3：通用导航高亮也要先展开折叠体（records/backup 那三条走这条）。
      window.V7CardArchitecture?.expandAncestors?.(node);
      node.scrollIntoView({block:'nearest',behavior:'smooth'});node.classList.add('route-highlight');setTimeout(()=>node.classList.remove('route-highlight'),3300);
    }
    const focusTargets=node?.matches('input,button,select,textarea')?[node]:[...body.querySelectorAll('input:not([type=hidden]),button:not(.v7-help),select,textarea,summary')];
    const focus=focusTargets.find(el=>!el.disabled&&!el.closest('[hidden],[inert]')&&el.checkVisibility());
    if(focus)focus.focus({preventScroll:true});
  }
  const cancelled=epoch!==cardRouteEpoch||cur!==target||zoneSel!==(Number(index)||0);
  window.V7NavigationShell?.commit(navigation,cancelled);
  return {body,cancelled};
}
function fillArchitectureDetail(animate,dir){
  const id=cards[cur].dataset.card,index=zoneSel;
  specialDetailFill(()=>{
    const body=document.getElementById('dcBody');detail.querySelector('.dc-name').textContent=ZONE_SETS[cur][index][1];
    // ⭐ 2026-10-06 卡片拆分：优先走总管理员（cards/card-*.js 各自实现的 mount）。
    //   ⚠ 必须带回落 —— 管理员登记表里没有这张卡时，一字不差地走老路径。
    //     这样拆到一半时行为完全不变（cards/_CONTRACT.md 写的就是这条规矩）。
    if(window.V7CardManager&&typeof V7CardManager.mount==='function')V7CardManager.mount(id,body,index);
    else V7CardArchitecture[id](body,index);
  },animate,dir);
}
window.V7CardRoutes={open:navigateCard,errorTarget:code=>{
  if(/^(PROVIDER_|AI_KEY_|AI_URL_)/.test(code))return ()=>navigateCard('settings',0,{section:'own',highlight:'[data-setting="provider"]'});
  if(/^(BACKEND_ACCOUNT_|ACCOUNT_)/.test(code))return ()=>navigateCard('settings',0,{section:'account',highlight:'[data-account-email]'});
  if(/^(SETUP_|PHOTOSHOP_|UXP_INSTALL_|UXP_ROLLBACK_|UXP_PATH_|UXP_PERMISSION_)/.test(code)||['BRIDGE_UNAVAILABLE','BRIDGE_DISCONNECTED','PREACTION_BRIDGE_REQUIRED'].includes(code))return ()=>navigateCard('settings',0,{section:'photoshop',highlight:'[data-action="ps"]'});
  // ⭐⭐ 2026-10-06 docs/150 §5.2/§5.4：原来指 [data-engine-box]/[data-matting-box]（调试卡里的
  //   老钩子，界面上早就不存在了 —— 高亮一直静默落空）。现在统一指外挂卡配置页的状态条。
  if(/^ENGINE_/.test(code))return ()=>navigateCard('engines',0,{highlight:'[data-engine-status]'});
  if(/^MATTING_/.test(code))return ()=>navigateCard('engines',0,{highlight:'[data-engine-status]'});
  if(code==='LAYOUT_FAILED')return ()=>navigateCard('settings',2,{section:'layout'});
  return null;
}};

// ── 填三级卡内容(统一入口) ──
// animate=true 走错落换场; false 首次直接填。正式主卡只渲染参数行。
function fillDetailBody(animate, dir){
  if(cur!==CARD_HISTORY){historyViewSeq++;window.V7HistoryLibrary?.dispose();}
  V7CardArchitecture.prepareDetail(document.getElementById('dcBody'),cur+':'+zoneSel);
  // ⭐ 助手卡（2026-10-17）没有三级了。⚠ 必须排在下一行【前面】：助手卡序号比项目卡大，会先被它吃掉去画旧三级。
  if(cur===CARD_ASSISTANT){ closeAssistantDetail(); return; }
  // ⭐ 问题反馈卡（2026-10-18 深夜）也没有三级。⚠ 同样必须排在下一行前面（序号比项目卡大）。
  if(cur===CARD_FEEDBACK){ closeRecordsDetail(); return; }
  // ⭐ 社区卡（2026-10-20）也没有三级，同样排在下一行前面。
  if(cur===CARD_COMMUNITY){ closeRecordsDetail(); return; }
  if(cur>=CARD_PROJECTS){fillArchitectureDetail(animate,dir);return;}
  // ⭐ 生成卡【没有三级】（2026-10-15 改成单张大二级，用户定"三级卡片就直接不要了"）。
  //   同外挂卡 / 记录卡：明确收掉 + 清空内容，不画任何东西。
  //   ⚠ fillGenerationDetail / renderGenerationPanel 两个函数【还留着】—— 大二级里的三节
  //     复用的就是 renderGenerationPanel 的内容；老测试也直接调它们。
  if(cur===CARD_GENERATION){ closeGenerationDetail(); return; }
  if(cur===CARD_PRESETS){
    if(window.PRESETUI){ PRESETUI.fillDetail(animate, dir); return; }
    const b=document.getElementById('dcBody');
    if(b) b.innerHTML='<div class="ai-note">预设系统没加载起来（preset-ui.js）。看一眼控制台。</div>';
    return;
  }
  // ⭐ 外挂能力卡【没有三级】（2026-10-01 改成单张大二级）。
  //   同记录卡：明确收掉 + 清空内容，不画任何东西。
  if(cur===CARD_ENGINES){ closeEnginesDetail(); return; }
  // ⭐ 记录卡【没有三级】（2026-09-30 修，docs/96 问题一）。
  //   以前这里走 fillHistoryDetail，把【老版历史库】画进三级 ——
  //   从设置卡滚轮一路切到记录卡时，三级框还开着，标题写着"记录与恢复"，
  //   内容却是"关键词 / 照片 / 全部照片…"那套老界面，用户看到的就是一个残留框。
  //   现在明确收掉 + 清空内容，什么都不画。
  if(cur===CARD_HISTORY){ closeRecordsDetail(); return; }
  if(cur===CARD_SETTINGS){
    if(typeof fillSettingsDetail==='function'){ fillSettingsDetail(animate, dir); return; }
    // 设置渲染器还未就位时保持简单占位，不回退到测试卡。
    const fallback=ZONE_SETS[CARD_SETTINGS]&&ZONE_SETS[CARD_SETTINGS][zoneSel]; const fallbackBody=document.getElementById('dcBody');
    if(fallback&&fallbackBody){const title=detail.querySelector('.dc-name');if(title)title.textContent=fallback[1];fallbackBody.innerHTML=window.V7Format?V7Format.skeletonHtml(6):'<div class="settings-note">设置页加载中，请稍候。</div>';}
    return;
  }
  // ⚠ 走到这里 = 有主卡没写自己的详情渲染器。
  //   原来这里是一段通用渲染: 假参数行 + 假开始按钮(点了弹（占位）)。
   //   四张占位主卡删掉后它已经永远走不到，且留着有害 ——
  //   以后加回真卡片却忘了接线时，会安静地退化成一个看起来能用的假页面。
  //   现在改成明着说没接线，坏得看得见。
  const body=document.getElementById("dcBody");
  const nameEl=detail.querySelector(".dc-name");
  const label=(ZONE_SETS[cur]&&ZONE_SETS[cur][zoneSel]&&ZONE_SETS[cur][zoneSel][1])||("主卡 "+cur);
  if(nameEl) nameEl.textContent=label;
  if(body) body.innerHTML='<div class="ai-note">这张卡还没有接入详情渲染器（主卡 '+cur+' / 分区 '+zoneSel+'）。<br>加主卡的规矩见 docs/22_占位清理记录.md：先写好功能，再放界面入口。</div>';
}

// 【外框不动, 内容上下滑】外框(.zone)保持原位, 内容层(.z-body)在框内上下滑走/滑入,
// 靠外框的 overflow:hidden 裁切 —— 视觉上就是"内容被推上去, 新的顶上来", 与主卡平移同一语言。
// 【为什么不用 3D 翻转】主卡是平移, 分区翻转 → 两套动作语言, 割裂。
const SLIDE_Z=44;                    // 二级内容滑出距离(略大于内容高度, 确保滑干净)
const SLIDE_D=56;                    // 三级内容整体滑出距离(卡更高, 位移相应加大)
// ── 静默填充二级内容(按当前 cur, 无动画) ──
// ⚠ 必须在"弹出二级的那一刻"调用: 二级卡文字是静态 HTML, 只有 syncZonesToCard 会更新它,
//   而那个函数只在"二级/三级已开"时才被调用 → 二级未开时切主卡, 内容不会更新,
//   之后弹出二级就会显示上一个主卡的旧内容(内容与一级不对应的根因)。
// ⭐ 记录与恢复卡（2026-09-30）：卡面 + 大二级的宿主胶水。
//   ⚠ 数据只在这里读一次缓存（host.cache.list），别的模块（项目卡的历史库等）读它们的。
//     cache.list() 是磁盘扫描，别在每次重画时都调 —— 靠 wheelchair:records-changed 事件驱动。
function recordsCardEl(){ return document.getElementById('recordsZone'); }
function isRecordsCard(){ return cur===CARD_HISTORY; }
// ⭐ 设置卡（2026-10-01）：和记录卡同一族的"单张大二级"。
function settingsCardEl(){ return document.getElementById('settingsZone'); }
function isSettingsCard(){ return cur===CARD_SETTINGS; }
// ⭐ 外挂能力卡（2026-10-01）：同族的"单张大二级"。
function enginesCardEl(){ return document.getElementById('enginesZone'); }
function isEnginesCard(){ return cur===CARD_ENGINES; }
// ⭐ 生成卡（2026-10-15）：同族的"单张大二级"，没有三级。
function generationCardEl(){ return document.getElementById('generationZone'); }
function isGenerationCard(){ return cur===CARD_GENERATION; }
function assistantCardEl(){ return document.getElementById('assistantZone'); }
function isAssistantCard(){ return cur===CARD_ASSISTANT; }
function feedbackCardEl(){ return document.getElementById('feedbackZone'); }
function isFeedbackCard(){ return CARD_FEEDBACK>=0&&cur===CARD_FEEDBACK; }
function communityCardEl(){ return document.getElementById('communityZone'); }
function isCommunityCard(){ return CARD_COMMUNITY>=0&&cur===CARD_COMMUNITY; }
// 彻底收掉三级：不只藏起来，还把内容清空。
// ⚠ 只 remove('show') 会留下"看不见但还挂着老内容"的 #dcBody ——
//   下次谁把三级打开（比如从别的卡切回来时那个 120ms 延迟重绘），老内容就冒出来了。
//   docs/96 场景 B 记的就是这种"隐形残留"。
function closeRecordsDetail(){
  historyViewSeq++;
  try{ window.V7HistoryLibrary?.dispose(); }catch(_){}
  detail.classList.remove('show','closing');
  detailUsed=false;
  const body=document.getElementById('dcBody');
  if(body){ V7CardArchitecture?.reset?.(body); body.replaceChildren(); }
}
let recordsCard=null;
let recordsRowsCache=null;
let recordsLoadSeq=0;

function recordsCardMount(){
  const zone=recordsCardEl();
  if(!zone || !window.V7RecordsCard) return null;
  if(recordsCard) return recordsCard;
  V7RecordsCard.setIconRenderer(function(name,size){
    try{ return window.ICON?ICON.render(name,size):''; }catch(_){ return ''; }
  });
  recordsCard=V7RecordsCard.create({
    zone:zone,
    loadImage:recordsLoadImage,
    releaseImage:recordsReleaseImage,
    checkpointEnabled:()=>settingsRuntime.checkpointEnabled===true,
    checkpointIntervalMin:()=>checkpointIntervalValue(),
    load:recordsLoadData,
    onFace:recordsRenderFace,
    // ⚠ 2026-10-07：面板露出来但还没打开（比如一条记录都没有）时，卡片要拿这句话去填里面，
    //   否则就是一块空白。复用现成的 recordsEmptyHtml()，别再写一份文案。
    emptyHtml:()=>recordsEmptyHtml(''),
    onError:error=>ERR.report('HISTORY_OPERATION_FAILED',{message:String(error&&error.message||error)}),
    openCheckpointSettings:()=>navigateCard('settings',3,{section:'storage'}).catch(()=>{}),
    openCheckpoint:cp=>recordsOpenCheckpoint(cp),
    revealCheckpoint:cp=>recordsRevealCheckpoint(cp),
    revealTask:row=>recordsRevealTask(row),
    reuseTask:(meta,row)=>recordsReuse(meta,row),
    restoreTask:(meta,row)=>recordsRestore(row),
    reusePrompt:meta=>recordsReusePrompt(meta),
    viewImage:(row,index)=>recordsViewShot(row,index),
    sendShot:(row,index)=>recordsSendShot(row,index),
    sendShots:(row,indexes)=>recordsSendShots(row,indexes)
  });
  recordsCard.mount();
  // ⚠ 攒光带【现在不挂在这儿了】（2026-10-09，docs/192）——
  //   它从二级面板挪到了【一级卡面的 .rec-list】上（见 mountRecordsEdges 的说明）。
  //   而 mount() 这个时机卡面还没建出来 ⇒ 这里找不到 .rec-list，挂了也是白挂。
  //   真正的挂载点在 recordsRenderFace() 末尾（每次画完卡面都补一次，幂等）。
  //   ⚠ 这里保留一次【带守卫的】尝试：万一哪天卡面先建好了，这里就能兜住；
  //     守卫用 typeof —— 本函数定义在文件更下面，别赌函数提升。
  if(typeof mountRecordsEdges==='function') mountRecordsEdges();
  return recordsCard;
}

// 取一张缓存图 → blob URL。⚠ 桌面壳【没有】"给我个文件 URL" 这种同步接口，
//   历史库也是这么干的（readFile 拿字节 → Blob → createObjectURL）。
//   ⚠ 拿到的 URL 必须由调用方 releaseImage 释放，不然几十张缩略图会把内存钉死。
//   ⚠ 大图不进这里：记录卡只要 thumb_*.jpg / canvas_thumb.jpg（都是几百 KB 的 JPEG）。
//     原图走 viewer（它自己 stream），别把 4K PNG 变成 blob 挂在 DOM 上（docs/21 的规矩）。
function recordsLoadImage(project,runId,name){
  if(!cacheAvailable()) return Promise.resolve('');
  if(!/\.(jpe?g|png|webp)$/i.test(String(name||''))) return Promise.resolve('');
  return uiwin.cache.readFile(project,runId,name).then(bytes=>{
    if(!bytes||!bytes.length) return '';
    const mime=/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':'image/jpeg';
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:mime}));
  }).catch(()=>'');
}
function recordsReleaseImage(url){
  try{ if(url) URL.revokeObjectURL(url); }catch(_){}
}

// 读一次缓存 → 分成「项目」和「检查点」两份。返回给记录卡模块的形状固定，别改。
async function recordsLoadData(){
  if(!cacheAvailable()) return {projects:[],rows:[],checkpoints:[]};
  const mine=++recordsLoadSeq;
  const namespace=cacheNamespaceId();
  const result=await uiwin.cache.list();
  if(mine!==recordsLoadSeq) return recordsRowsCache||{projects:[],rows:[],checkpoints:[]};
  if(!result||!result.ok||!Array.isArray(result.runs)) throw new Error('缓存目录读取失败，请检查缓存位置。');
  const core=window.V7RecordsCore;
  if(!core) return {projects:[],rows:[],checkpoints:[]};
  // 只认本账号的、不是检查点的那些行
  const rows=result.runs.filter(row=>row&&row.meta&&cacheOwnsEntry(row))
    .filter(row=>String(row.meta.namespaceId||'')===namespace||!row.meta.namespaceId);
  const checkpoints=cacheCheckpointList(result.runs);
  const projects=core.groupRows(rows);
  recordsRowsCache={projects:projects,rows:rows,checkpoints:checkpoints};
  return recordsRowsCache;
}
// 检查点：缓存里 kind==='checkpoint' 的那些行，参考点名字段已经在 checkpoint.json 里。
function cacheCheckpointList(runs){
  return (runs||[]).filter(row=>row&&row.meta&&row.meta.kind==='checkpoint')
    .map(row=>Object.assign({},row.meta,{cacheRef:row.meta.cacheRef||('cache:'+row.project+'/'+row.runId+'/canvas.png')}));
}
// 重新加载 + 重画（事件驱动，不是轮询）
function recordsCardReload(){
  const card=recordsCardMount();
  if(!card) return;
  card.reload();
}
window.addEventListener('wheelchair:records-changed',()=>{ if(recordsCard) recordsCard.reload(); });
// ⭐ 2026-09-30 用户定案：检查点开着时，ESC = 退出检查点（跟"点左边空白处"同一个动作）。
//   ⚠ 必须用【捕获阶段】(capture:true) 并且注册在这个文件后面那个全局 ESC 之前 ——
//     全局那条在冒泡阶段做"后退/关二级"，不拦的话 ESC 会先被它吃掉，检查点退不掉。
//   ⚠ 只在真的开着检查点时拦：没开检查点时不碰 ESC，让它照常走全局那条。
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||event.defaultPrevented) return;
  if(!recordsCard||!recordsCard.isOpen()) return;
  if(recordsCard.checkpointState()==='rest') return;
  if(event.target&&(event.target.matches&&event.target.matches('input,textarea'))) return;
  event.preventDefault(); event.stopPropagation();
  recordsCard.collapseCheckpoint();
},true);
// 账号/存储切换时清掉缓存，避免把上一个账号的记录画出来
window.addEventListener('wheelchair:storage-context',()=>{ recordsRowsCache=null; if(recordsCard) recordsCard.reload(); });
// ⚠⚠ 账号/存储切换时设置卡也必须重建（2026-10-01）。
//   设置内容现在画在 #settingsZone 里，而上面那个大处理器只 reset(#dcBody) ——
//   它碰不到我们，于是上一个账号的表单（连 Key 一起）会留在 DOM 上。
//   test-card-account-isolation 实测抓到"Account A form/control nodes survived the account switch"。
// ⚠⚠ 必须【延后一拍】重建，不能同步重建！
//   大处理器（文件更下面那个 storage-context 监听器，负责 settingsLoad() 把新账号的
//   设置读进 settingsRuntime）是【后注册】的 —— 按注册顺序，我这个监听器会先跑，
//   那时 runtime 里还是【上一个账号】的值，画出来就是 A 的 URL（实测抓到
//   "Account B URL was not loaded from its own settings"）。
//   丢进 setTimeout(0) 让它排到所有同步处理器之后，读到的才是 B 的值。
window.addEventListener('wheelchair:storage-context',()=>{
  if(!settingsCard) return;
  settingsCard.invalidate();                              // ① 同步：旧节点立刻拆掉（隔离）
  setTimeout(()=>{ if(settingsCard) settingsCard.reload(); },0);   // ② 延后：runtime 已是新账号，再画
});

// ── 一级卡面：搜索框 + 项目横条列表 ──
// ⚠ 这一段画在【一级卡】里（.block-card[data-card="history"]），不在 #recordsZone 里。
function recordsRenderFace(info){
  const card=cards[CARD_HISTORY];
  if(!card) return;
  // ⚠⚠ 这个标记【必须写进 DOM】(2026-09-30 实装时只查不写，是个真 bug)：
  //   写不进去的话每次重画都判定"首次"，把 .bc-inner 整个 innerHTML 重建 ——
  //   后果：① 搜索框每次被销毁重建 → 正在输入的字被截断、焦点丢失
  //        ② 监听器一遍遍往同一个节点上叠 → 点击行为错乱
  //   （用户实测："搜索处截过了""在主卡片点击没反应"）
  const inner=card.querySelector('.bc-inner');
  if(!inner) return;
  // ⚠⚠ 2026-09-30 第二次修这里：上一版"标记写进 DOM"只写了一半 ——
  //   标记写在 inner【自己】身上，却用 inner.querySelector(...) 去找，
  //   querySelector 只搜【子孙】，永远找不到它自己 → 每次重画照样整块重建（搜索框被毁、字丢、焦点丢）。
  //   现在直接判"卡面里真正要用的那个节点在不在"：在就是已建好，不在（首次、或被别的代码冲掉）才重建。
  const built=inner.querySelector('[data-records-list-inner]')&&inner.querySelector('[data-records-search-toggle]');
  if(!built){
    inner.dataset.recordsFace='';
    inner.innerHTML=
      // ⭐ 左上角放大镜：跟右上角折叠按钮【镜像对称】（同尺寸/同位置/同样式），点开才挤出搜索框
      '<button class="rs-toggle" type="button" data-records-search-toggle aria-label="搜索记录" aria-expanded="false" title="搜索（任务 · 提示词 · 日期）">'
      +'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg></button>'
      +'<div class="rec-search" data-records-search>'
      +'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
      +'<input type="text" data-records-query placeholder="搜任务 · 提示词 · 日期（如 昨天 / 09-28）" autocomplete="off" spellcheck="false">'
      +'<span class="rs-count" data-records-count hidden></span>'
      +'<button class="rs-clear" data-records-clear type="button" aria-label="清空搜索"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
      +'</div>'
      +'<div class="rec-listwrap" data-records-listwrap><div class="rec-list" data-records-list><div class="rec-list-inner" data-records-list-inner></div></div></div>'
      +'<div class="bc-foot"><span class="bc-foot-name">记录与恢复</span><span class="bc-foot-info" data-records-foot></span></div>';
    bindRecordsFace(inner);
  }
  const list=info&&Array.isArray(info.projects)?info.projects:[];
  // ⚠ 只重画【列表内容】，绝不碰搜索框 —— 搜索框是上面那次建的，
  //   重建它会让用户正在输入的字丢掉、焦点也没了。
  const listInner=inner.querySelector('[data-records-list-inner]');
  if(listInner){
    // ⚠⚠ 滚动位置必须保住（2026-09-30 用户实测"点一下项目条，列表跳回顶部"）：
    //   主因是上面那个"每次都整块重建"的判断 bug（连滚动容器 .rec-list 一起换成新的，scrollTop 归零）；
    //   这里再显式记一次：内容换掉的一瞬间高度可能变短，浏览器会把 scrollTop 夹小，换完再放回去。
    //   ⚠ 例外：搜索词变了 = 换了一份结果，这时回到顶部才对。
    const scroller=inner.querySelector('[data-records-list]');
    const q=String(info&&info.query||'');
    const keep=scroller&&q===recordsFaceLastQuery?scroller.scrollTop:0;
    recordsFaceLastQuery=q;
    listInner.innerHTML=list.length?list.map(recordsTileHtml).join(''):recordsEmptyHtml(info&&info.query);
    if(scroller) scroller.scrollTop=keep;
  }
  const foot=inner.querySelector('[data-records-foot]');
  if(foot&&info&&info.footprint) foot.textContent=info.footprint.text;
  const query=inner.querySelector('[data-records-query]');
  const search=inner.querySelector('[data-records-search]');
  const clear=inner.querySelector('[data-records-count]');
  if(query&&recordsCard&&document.activeElement!==query&&query.value!==recordsCard.query()) query.value=recordsCard.query();
  if(search) search.classList.toggle('has-q',!!(recordsCard&&recordsCard.query()));
  if(clear){
    const hit=info&&info.query?(list.reduce((n,p)=>n+(p.matches||0),0)||list.length):0;
    clear.hidden=!(info&&info.query);
    clear.textContent=String(hit);
    clear.classList.toggle('hit',hit>0);
  }
  // 有搜索词（比如从别处路由带着 query 进来）→ 搜索框必须是展开的，不然结果被筛了用户却看不到在搜什么
  if(info&&info.query) recordsSearchOpen=true;
  recordsSyncSearchUi();
  // ⭐⭐⭐ 2026-10-09（docs/192，用户定案）：攒光带挂在【一级卡面的 .rec-list】上。
  //   ⚠ 必须在每次画完卡面之后补挂 —— 两个原因：
  //     ① 启动时那次 mountRecordsEdges() 跑在【卡面建出来之前】，找不到 .rec-list ⇒ 挂不上；
  //     ② 卡面内容每次重画都可能把光带冲掉（历史教训：2026-10-07 记录卡的光带
  //        被 innerHTML 冲掉后"永远不亮"，用户报"光没了"）。
  //   ⚠ 函数是幂等的（先拆旧的再建新的），放这里每次重画都调也不会攒出重影。
  mountRecordsEdges();
}
// ── 搜索框的展开/收起（左上角放大镜控制）──
// ⚠ 状态挂在【一级卡元素】上（.rs-open），不挂在卡面内容里 —— 卡面内容可能被重建，卡本身不会。
// ⚠ 用 var 不用 let：recordsRenderFace 定义在这两行【上面】，启动早期若先被调到，
//   let 在暂时性死区里一读就 ReferenceError（本文件 stampWatch 踩过同一个坑）。var 会提升，安全。
var recordsSearchOpen=false;
var recordsFaceLastQuery='';
function recordsSyncSearchUi(){
  const card=cards[CARD_HISTORY];
  if(!card) return;
  card.classList.toggle('rs-open',recordsSearchOpen);
  const btn=card.querySelector('[data-records-search-toggle]');
  if(btn) btn.setAttribute('aria-expanded',recordsSearchOpen?'true':'false');
}
function recordsSetSearchOpen(open,opts){
  recordsSearchOpen=!!open;
  recordsSyncSearchUi();
  const card=cards[CARD_HISTORY];
  const query=card&&card.querySelector('[data-records-query]');
  if(recordsSearchOpen){
    // ⚠ 等挤压动画起步再聚焦：同一帧里 focus 会让浏览器为了把输入框滚进视野而跳一下
    if(query&&!(opts&&opts.noFocus)) requestAnimationFrame(()=>requestAnimationFrame(()=>query.focus({preventScroll:true})));
  }else{
    // 收起时【连搜索一起清掉】：否则列表还被筛着，搜索框却看不见了 —— 用户会以为记录丢了
    clearTimeout(recordsQueryTimer);
    if(query){ query.value=''; query.blur(); }
    card&&card.querySelector('[data-records-search]')?.classList.remove('has-q');
    if(recordsCard&&recordsCard.query()) recordsCard.clearSearch();
  }
}
function recordsTileHtml(p){
  const core=window.V7RecordsCore;
  const cost=core.formatUsd(p.cost.usd);
  const cover=p.cover?' style="background-image:url('+escapeHtml(p.cover)+')"':'';
  return '<div class="ptile'+(p.selected?' sel':'')+'" data-records-project="'+escapeHtml(p.project)+'"'+cover+'>'
    +'<div class="pt-badges">'
    +(p.live?'<span class="pt-chip"><span class="dot"></span>生成中</span>':'')
    +(p.matches?'<span class="pt-chip match">'+p.matches+' 个匹配</span>':'')
    +'</div>'
    +'<div class="pt-body"><div class="pt-row"><div style="min-width:0">'
    +'<div class="pt-name">'+escapeHtml(p.label)+'</div>'
    +'<div class="pt-meta">'+p.count+' 次计算 · '+escapeHtml(core.whenLabel(p.lastAt))+'</div></div>'
    +'<div class="pt-cost">'+cost+(p.cost.pending?'<small>以账单为准 '+p.cost.pending+' 项</small>':'')+'</div>'
    +'</div></div></div>';
}
function recordsEmptyHtml(query){
  return '<div class="rec-empty">'+(query?'没有找到匹配的任务<br><small>试试：修脸 · 海边 · 昨天 · 09-28</small>':'还没有计算记录<br><small>点一次计算，这里就会出现整张画布</small>')+'</div>';
}
let recordsQueryTimer=0;
function bindRecordsFace(inner){
  const query=inner.querySelector('[data-records-query]');
  if(query){
    query.addEventListener('input',()=>{
      const has=!!query.value.trim();
      inner.querySelector('[data-records-search]')?.classList.toggle('has-q',has);
      clearTimeout(recordsQueryTimer);
      recordsQueryTimer=setTimeout(()=>recordsCard&&recordsCard.runSearch(query.value),220);
    });
    query.addEventListener('keydown',event=>{
      // Esc 在搜索框里 = 收起搜索（并清空）。⚠ 拦下来，别让它冒泡成"全局 Esc 关二级/后退"
      if(event.key==='Escape'){ event.preventDefault(); event.stopPropagation(); recordsSetSearchOpen(false); return; }
      if(event.key!=='Enter') return;
      clearTimeout(recordsQueryTimer);
      recordsCard&&recordsCard.runSearch(event.target.value);
    });
  }
  inner.querySelector('[data-records-search-toggle]')?.addEventListener('click',event=>{
    event.stopPropagation();
    recordsSetSearchOpen(!recordsSearchOpen);
  });
  inner.querySelector('[data-records-clear]')?.addEventListener('click',()=>{
    clearTimeout(recordsQueryTimer);
    if(query) query.value='';
    recordsCard&&recordsCard.clearSearch();
    query&&query.focus();
  });
  inner.querySelector('[data-records-list]')?.addEventListener('click',event=>{
    const tile=event.target.closest&&event.target.closest('[data-records-project]');
    if(tile&&recordsCard){recordsCard.clickProject(tile.dataset.recordsProject);recordsOpenZone();}
  });
  // 往右推：推到哪个项目条上就弹哪个项目（方向 3px / 速度 25px / 离右缘 80px）
  let lastX=null;
  inner.addEventListener('mousemove',event=>{
    if(!isRecordsCard()||!recordsCard) return;
    const dx=lastX==null?0:event.clientX-lastX; lastX=event.clientX;
    const tile=event.target.closest&&event.target.closest('[data-records-project]');
    if(tile&&dx>=3&&dx<=25){
      const box=cards[CARD_HISTORY].getBoundingClientRect();
      recordsEdgeHint(Math.max(0,Math.min(1,(event.clientX-box.left-150)/70)));
      if(event.clientX>=box.right-80){recordsCard.hoverProject(tile.dataset.recordsProject);recordsOpenZone();}
    } else if(dx<0||!tile) recordsEdgeHint(0);
  });
  inner.addEventListener('mouseleave',()=>{lastX=null;recordsEdgeHint(0);});
}
function recordsEdgeHint(p){
  const hint=cards[CARD_HISTORY]&&cards[CARD_HISTORY].querySelector('.edgehint');
  if(!hint) return;
  if(p>0) hint.classList.remove('recoil');
  hint.style.width=(p*44)+'px';
  hint.style.opacity=String(p);
}

// ── 记录卡的复用 / 恢复 / 看图 回调 ──
// ⚠ 这些全部走【现成接口】，不自己写一套：
//   提示词 → V7HistoryPrompts.apply；工作流 → PRESETUI 按 id 载入；工具 → 打开同一个工具。
function recordsReuse(meta,row){
  const kind=String(meta&&meta.kind||'generation');
  if(kind==='generation'&&String(meta.workflowPresetId||'')){
    try{ if(window.PRESETUI&&PRESETUI.loadPresetById) PRESETUI.loadPresetById(meta.workflowPresetId,true); return; }catch(_){}
  }
  if(String(meta&&meta.prompt||'').trim()){
    recordsReusePrompt(meta);
    return;
  }
  recordsReuseTool(meta);
}
function recordsReusePrompt(meta){
  try{
    if(window.V7HistoryPrompts&&typeof V7HistoryPrompts.apply==='function'){
      V7HistoryPrompts.apply({prompt:String(meta&&meta.prompt||'')});
      recordsToast('提示词已填回输入框','ok',2200);
      return;
    }
    aiRuntime.prompt=String(meta&&meta.prompt||'');
    if(typeof aiRefreshInPlace==='function') aiRefreshInPlace();
    recordsToast('提示词已填回输入框','ok',2200);
  }catch(error){ ERR.report('HISTORY_OPERATION_FAILED',{message:String(error&&error.message||error)}); }
}
function recordsReuseTool(meta){
  const kind=String(meta&&meta.kind||'');
  const route=kind==='glow'?'glow':kind==='dlss'?'dlss':kind==='matting'?'matting':kind==='segment'||kind==='sam2'?'matting':'generation';
  try{
    if(window.V7RouteRegistry&&V7RouteRegistry.routes[route]) V7RouteRegistry.open(route);
    else navigateCard('generation',0,{});
  }catch(error){ ERR.report('HISTORY_OPERATION_FAILED',{message:String(error&&error.message||error)}); }
}
async function recordsRestore(row){
  try{
    // ⚠ 走【现成的】cacheRestoreOne（历史库的"恢复到任务栏"用的就是它）。
    //   ⚠ 已在任务栏的不用再恢复，直接提示，免得重复建卡。
    if(taskList.some(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId)){
      recordsToast('这次计算已经在任务栏里','info',2200);
      return;
    }
    const ok=await cacheRestoreOne(row);
    recordsToast(ok===false?'恢复未完成':'已恢复到任务栏',ok===false?'warn':'ok',2400);
    broadcastRecordsChanged();
  }catch(error){ ERR.report('HISTORY_OPERATION_FAILED',{message:String(error&&error.message||error)}); }
}
// 看图：走内置预览框（跟历史库的「查看结果」同一条路）。
// ⚠ 绝不用 window.open —— 这是桌面壳，弹浏览器窗口是错的（而且 CSP 也会拦 blob）。
function recordsViewShot(row,index){
  const shot=Number(index)||0;
  const project=row.project,runId=row.runId;
  uiwin.cache.readFile(project,runId,'output_'+(shot+1)+'.png').then(bytes=>{
    if(!bytes||!bytes.length){recordsToast('这张图不在缓存里','warn',2400);return;}
    // ⭐ 2026-10-04：改走内置预览框（docs/132 §三）
    if(window.V7Tween){ window.V7Tween.showImage(bytes); return; }
    return uiwin.viewer.open({bytes,mime:'image/png',num:shot+1,total:(row.meta&&row.meta.shots&&row.meta.shots.length)||1,reset:true});
  }).catch(()=>recordsToast('图片读取失败','warn',2400));
}
// 单张传回：先把这次计算恢复到任务栏（拿到一个真任务对象），再走现成的
// aiTransfer(task,[index]) —— 这条路已经处理好了"跳过已传回的 / 文档绑定 / 羽化"。
// ⚠ 不自己往 PS 里贴：那要重写一遍 ps.layer.place 的参数，必然漏东西。
async function recordsSendShot(row,index){
  const shot=Number(index)||0;
  try{
    let task=taskList.find(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId);
    if(!task){
      const ok=await cacheRestoreOne(row);
      if(ok===false) throw new Error('恢复到任务栏失败，无法传回');
      task=taskList.find(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId);
    }
    if(!task) throw new Error('找不到刚恢复的任务');
    recordsToast('正在传回图像…','info');
    await aiTransfer(task,[shot]);
  }catch(error){
    ERR.report('HISTORY_OPERATION_FAILED',{message:String(error&&error.message||error)});
  }
}
// 多张传回（详情里勾了 ✓ 的那几张一起传）。
// ⚠⚠ 一律走【一次】aiTransfer(task, 多个 index)，绝对不能循环调 recordsSendShot ——
//   那个函数里 aiTransfer 自己有在途锁（task._transferBusy），循环第二次会被锁挡住，
//   结果"点了 5 张只传回去 1 张"；而且每张都重新 cacheRestoreOne 一遍纯属浪费。
//   一次传多个 index 也是 PS 那边期望的批处理形态（贴成一个批次，不是五次单贴）。
async function recordsSendShots(row,indexes){
  const shots=(Array.isArray(indexes)?indexes:[]).map(Number).filter(n=>Number.isFinite(n)&&n>=0);
  if(!shots.length) return;
  try{
    let task=taskList.find(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId);
    if(!task){
      const ok=await cacheRestoreOne(row);
      if(ok===false) throw new Error('恢复到任务栏失败，无法传回');
      task=taskList.find(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId);
    }
    if(!task) throw new Error('找不到刚恢复的任务');
    recordsToast(shots.length>1?('正在传回 '+shots.length+' 张图像…'):'正在传回图像…','info');
    await aiTransfer(task,shots);
  }catch(error){
    ERR.report('HISTORY_OPERATION_FAILED',{message:String(error&&error.message||error)});
  }
}
async function recordsOpenCheckpoint(cp){
  try{
    // ⚠⚠ 这里原来传的是 cacheOwnsEntry —— 那是个收【整条缓存记录】的函数（要用 entry.project / entry.meta），
    //   而 V7Checkpoints.openFolder 的 ownsProject 收的是【项目名字符串】。
    //   传错的后果：拿到的是一根字符串 → entry.meta 不存在 → cacheOwnsEntry 恒返回 false
    //   → openFolder 直接抛「这个检查点不属于当前账号」。
    //   用户实测点「在 PS 中打开」必弹这个错；而账号系统还没实装，所以看着更像"账号坏了"，
    //   掩盖了真因（就是个类型不匹配的笔误）。
    //   正确写法与 historyLibraryHost 里那条保持一致：只判项目名前缀。
    await V7Checkpoints.openFolder(cp,{cache:uiwin.cache,
      ownsProject:project=>!window.WHEELCHAIR_STORAGE||WHEELCHAIR_STORAGE.ownsCacheProject(project)});
  }
  catch(error){ ERR.report(error&&error.code||'CHECKPOINT_FOLDER_FAILED',{message:String(error&&error.message||error)}); }
}
async function recordsRevealCheckpoint(cp){
  try{
    const ref=V7Checkpoints.parseCacheRef(cp&&cp.cacheRef);
    await uiwin.cache.openFolder(ref.project,ref.runId);
  }catch(error){ ERR.report(error&&error.code||'CHECKPOINT_FOLDER_FAILED',{message:String(error&&error.message||error)}); }
}
// ⭐ 2026-10-06 用户要的：任务详情里"打开这次计算的缓存文件夹"按钮（跟检查点那颗同一套通道）。
//   ⚠ 只用现成的 uiwin.cache.openFolder（双壳同名同形，不新增宿主 API）。
async function recordsRevealTask(row){
  try{
    if(!row||!row.project||!row.runId) throw new Error('这条记录没有缓存位置');
    await uiwin.cache.openFolder(row.project,row.runId);
  }catch(error){ ERR.report(error&&error.code||'CHECKPOINT_FOLDER_FAILED',{message:String(error&&error.message||error)}); }
}
// 路由进记录卡：切到那张卡 + 直接开大二级（没有三级）。
// options 支持 { project, query, checkpoint }
async function recordsRoute(target,options){
  const opts=options||{};
  if(isCollapsed) setCollapsed(false);
  layoutHidden.delete(target);
  cur=target; lastDir=1;
  window.V7FreeMode?.expandGroup('card:'+cards[target].dataset.card);
  setStack();
  // ⚠ 记录卡只有一个分区 —— 和预设卡同理，zoneSel 必须归 0，
  //   否则从别的卡的第 4 分区切过来会算出野槽位（主题包永远对不上）。
  zoneSel=0;
  selectZone(0);
  fillZonesNow();
  updateZoneBg(cur);
  // 三级：记录卡没有三级，明确关掉【并且清空内容】。
  // ⚠ 以前这里只是 remove('show')，框是看不见了，但 #dcBody 里还留着上一个卡的正文
  //   （docs/96 场景 B 实测：到达记录卡后 bodyLen 还有 15685 字）。
  //   那种"隐形残留"平时看不见，等谁再把三级打开就冒出来 —— 统一走 closeRecordsDetail。
  closeRecordsDetail();
  const card=recordsCardMount();
  // 等缓存读完再决定开哪个项目 —— 不然路由带过来的 project 还不在列表里
  await recordsCardReloadAndWait();
  if(opts.query){
    const query=cards[CARD_HISTORY]&&cards[CARD_HISTORY].querySelector('[data-records-query]');
    if(query) query.value=String(opts.query);
    recordsCard&&recordsCard.runSearch(String(opts.query));
  }
  if(opts.project){ recordsCard&&recordsCard.clickProject(String(opts.project)); }
  else if(opts.checkpoint){
    // 带检查点进来：先定位到它属于哪个项目，再把它固定住
    const list=recordsRowsCache&&recordsRowsCache.checkpoints||[];
    const hit=list.find(cp=>String(cp.cacheRef||'')===String(opts.checkpoint));
    const ref=hit?V7Checkpoints.parseCacheRef(hit.cacheRef):null;
    if(ref){ recordsCard&&recordsCard.clickProject(ref.project); recordsCard&&recordsCard.setCp('full',String(opts.checkpoint)); }
  } else if(!opts.keepProject && recordsCard && !opts.query){
    // 不带参数进来：默认展开最近有动静的那个项目（用户点"记录与恢复"就是想看最近的）
    const first=recordsRowsCache&&recordsRowsCache.projects&&recordsRowsCache.projects[0];
    if(first&&!recordsCard.isOpen()) recordsCard.openProject(first.project,'route');
  }
  if(opts.checkpoint||opts.project||opts.query||(recordsCard&&recordsCard.isOpen())) recordsOpenZone();
  broadcastRecordsChanged();
  return {body:document.getElementById('dcBody'),cancelled:false,records:true};
}
// 等这次缓存读完（路由要用读到的东西决定开哪个项目）
function recordsCardReloadAndWait(){
  const card=recordsCardMount();
  if(!card) return Promise.resolve(null);
  return Promise.resolve(card.reload());
}

