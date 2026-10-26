// ═══ ui-main/07-wheel-routing.js —— 主界面主程序第 7 / 21 段 ═══
//   管什么：二级下拉面板 · 滚轮按几何范围归属 · 点被压住的卡翻到它 · 任务预览跟随 · 二三级换内容
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══════════════════════════════════════════════════════════
//  悬停触发判定 —— 六条规则(见 docs/12 第五点五节)
//   1 方向性: 向右移动才弹, 向左进入不弹(阈值 3px)
//   2 连通保持: 已弹出且在连通区内, 不论方向一律保持
//   3 斜线容差: 判定区上下各多 20px
//   4 速度过滤: >25px/帧 判定为甩过去, 不触发
//   5 滞回: 进 80 / 出 110
//   6 弹出方向自适应 —— 待做(见文档)
// ═══════════════════════════════════════════════════════════
const EDGE_IN=80, EDGE_OUT=110;   // 滞回: 进/出用不同边界
const PAD_Y=20;                   // 斜线容差: 上下各多留
const DIR_MIN=3;                  // 方向判定最小位移
const SPEED_MAX=25;               // 速度过滤: 超过判定为甩过去

// ⚠ 正在卡面上拖参数条时，横向推进那一套必须停手(2026-09-11)：
//   拖条本来就是往右拉，不拦的话拖到一半二级卡就弹出来了。
//   在 renderGenerationCardFields 里按下置 true，全局 mouseup 复位。
let gcDragging=false;
window.addEventListener('mouseup',()=>{ gcDragging=false; });

let lastMX=null, lastMY=null, lastMoveMs=0;   // lastMoveMs: 上一帧 mousemove 的时间戳(判"中间断过档")
// 推进速度追踪: 用于把"鼠标从左往右推进的速度"映射成二级弹出光的时长。
let pushStartX=null, pushStartT=0;   // 开始往右推的起点X + 时间戳
let pushSpeed=0.7;                   // 推算出的当前推进速度(px/ms), 默认中等
let movingRightPrev=false, lastMXPrevPush=null;   // 上次推进状态(判左移用)

// 给每张主卡插一条右缘光带(触发前的可供性暗示)
cards.forEach(c=>{
  if(!c.querySelector('.edgehint')){
    const h=document.createElement('div'); h.className='edgehint';
    c.appendChild(h);
  }
});

// 取当前 index 对应的任务卡 DOM(任务区是动态增删的)
function topTaskEl(){
  const els = [...tasksEl.querySelectorAll('.task:not(.leaving)')];
  if(!els.length) return null;
  return els[Math.min(tcur, els.length - 1)];
}
// 自由模式展开方向取实际面板位置；普通模式仍沿用既有向右推进规则。
function navigationSide(source,target){
  if(!window.V7FreeMode?.isActive()||!source||!target)return 1;
  const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
  return b.left+b.width/2<a.left+a.width/2?-1:1;
}
function navigationGapHit(mx,my,source,target){
  if(!window.V7FreeMode?.isActive()||!source||!target)return false;
  const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
  if(!a.width||!a.height||!b.width||!b.height)return false;
  const left=a.right<=b.left?a.right:b.right<=a.left?b.right:null;
  if(left===null)return false;
  const right=a.right<=b.left?b.left:a.left;
  // 只保留两张关联卡之间有共同高度的走廊，不能把整个空白屏幕接管。
  return mx>=left&&mx<=right&&my>=Math.max(a.top,b.top)-PAD_Y&&my<=Math.min(a.bottom,b.bottom)+PAD_Y;
}
function freeNavigationBridgeHit(mx,my){
  if(!window.V7FreeMode?.isActive())return false;
  if(zones.classList.contains('show')&&navigationGapHit(mx,my,cards[cur],zones))return true;
  if(detail.classList.contains('show')&&navigationGapHit(mx,my,zones,detail))return true;
  const task=topTaskEl(),preview=task?.querySelector('.task-preview.show');
  if(!window.V7WorkspaceStackRail?.isHidden('tasks')&&preview&&navigationGapHit(mx,my,task,preview))return true;
  const error=topErrorEl(),errorDetail=error?._detailEl;
  return !!(!window.V7WorkspaceStackRail?.isHidden('errors')&&errorDetail?.classList.contains('show')&&navigationGapHit(mx,my,error,errorDetail));
}
function navigationHintSide(hint,side){
  if(!hint)return;
  hint.style.left=side<0?'0px':'';hint.style.right=side<0?'auto':'';
  hint.style.transform=side<0?'scaleX(-1)':'';
}
// 判断鼠标是否在"连通区域"(主卡+分区+详情 / 任务卡+预览)内
// ⚠ 用几何矩形判断, 不用 elementFromPoint —— 避免浮层盖住卡片时误判"离开了"
// ⭐ 2026-10-15（用户报）：二级里的下拉框展开后，选项面板是挂在 body 上的浮层（ui-select.js），
//   伸出二级卡外的那一截不在任何卡的矩形里 ⇒ 鼠标移上去被判"离开" ⇒ 二级当场收起。
//   ⇒ 下拉面板开着时，面板自己那块也算连通区（二级、三级的"移出即收"两处都认它）。
function inOpenSelectPanel(mx,my){
  const p=window.UISelect?.isOpen?.()?window.UISelect.panelEl?.():null;
  return !!(p&&hitRect(mx,my,p,0,0));
}
function inConnected(mx,my,kind){
  if(kind==='zones'){
    const c=cards[cur];
    if(c && hitRect(mx,my,c,0,PAD_Y)) return true;
    if(inOpenSelectPanel(mx,my)) return true;
    if(zones.classList.contains('show') && hitRect(mx,my,zones,0,PAD_Y)) return true;
    if(detail.classList.contains('show') && hitRect(mx,my,detail,0,PAD_Y)) return true;
    if(zones.classList.contains('show')&&navigationGapHit(mx,my,c,zones))return true;
    if(detail.classList.contains('show')&&navigationGapHit(mx,my,zones,detail))return true;
    return false;
  }
  const topTask=topTaskEl();
  if(!topTask) return false;
  // ⚠ 2026-10-03 晚：上方那个大预览框也算连通区的一块（用户实测：鼠标移到框上
  //   就被判成"离开"，框当场消失，缩放根本来不及用）。
  //   用户要的规矩：任务卡/预览条 → 大框 → 拉回预览条 = 都算在里面，不许收；
  //   真移出这一整块才一起收。判定在 tween-preview.js 里（它才知道框的矩形）。
  if(window.V7Tween&&typeof V7Tween.boxHit==='function'&&V7Tween.boxHit(mx,my)) return true;
  if(hitRect(mx,my,topTask,0,PAD_Y)) return true;
  // ⚠ 同 overUI: 必须带 .show。隐藏的 .task-preview 依然占着矩形(display:flex 从不置 none)。
  const pv=topTask.querySelector('.task-preview.show');
  return !!(pv && (hitRect(mx,my,pv,0,PAD_Y)||navigationGapHit(mx,my,topTask,pv)));
}

// 自由模式每张一级卡都有自己的屏幕坐标。悬停导航必须按指针实际命中的卡计算，
// 不能沿用普通模式的 cards[cur]，否则非当前卡只有先点击才能触发右滑。
function freeOwnerCard(mx,my,target){
  if(!window.V7FreeMode?.isActive())return null;
  if(target?.closest?.('#tasks,#errors,#zones,#detail'))return null;
  const direct=target?.closest?.('#stack .block-card');
  if(direct&&!direct.hidden&&!direct.matches('.free-group-hidden,.free-pile-buried'))return direct;
  return window.V7FreeMode.cardAtPoint?.(mx,my)||null;
}


window.addEventListener('mousemove',e=>{
  const mx=e.clientX, my=e.clientY;
  if(e.target.closest?.('.v7-floating-bar')||window.V7FloatingBars?.isDragging()){lastMX=mx;lastMY=my;return;}
  if(window.V7FreeMode?.isDragging()||window.V7FreeMode?.isTransitioning()){lastMX=mx;lastMY=my;return;}
  // ⭐ 2026-10-06 晚：悬停手势只被"真正的浮层"拦（见 v7HoverOverlayOpen 的说明）。
  //   报错决定卡（L3）不再冻结右滑；点击/键盘/滚轮仍由 focus-scope 拦着。
  if(v7HoverOverlayOpen()){lastMX=mx;lastMY=my;return;}
  // ⭐⭐ 2026-10-06 晚：只认【看得见】的内嵌工作区来关手势。
  //   hasEmbedded() 只问"dialog 还连着没有" —— 一个挂过又被藏进隐藏详情层的工作区
  //   会让它恒真，全局右滑全部失效（用户实测：标准模式跑一会就不灵，切自由模式正常，
  //   因为自由模式进场会 closeAll→requestCloseAll 把它关掉）。
  //   真开着（看得见）的工作区仍然照旧隔离背景。
  if(window.V7Workspaces?.hasVisibleEmbedded?.()??window.V7Workspaces?.hasEmbedded?.()){lastMX=mx;lastMY=my;return;}
  // 工具工作面开着：底下的卡都让位了，鼠标划过不许再触发"右滑推进/攒光"那套
  if(document.body.classList.contains('v7tw-covering')){lastMX=mx;lastMY=my;return;}
  if(isCollapsed){
    lastMX=mx; lastMY=my;
    return;
  }
  // Tauri resumes a transparent window with a document-targeted mousemove.
  // It starts a new local pointer track; stale coordinates from the previous
  // card must not count as a fast swipe across the whole desktop.
  //
  // ⚠⚠⚠ 2026-10-06：原来这里写的是 `V7FreeMode?.isActive() && e.target===document`
  //   —— 自由模式才复位。自由模式是透明窗口，鼠标划过空地时 target 就是 document，
  //   于是"进入即复位"，永远不携带陈旧 dx；标准模式没有这一条，
  //   而它【正是会被陈旧坐标打中的那个模式】：
  //     点进 PS / 关掉大图窗口 / 切程序回来 → 中间没有任何 mousemove 补上，
  //     lastMX 还停在【上一次离开时的位置】→ 回来的第一帧
  //     dx = 新位置 - 旧位置 可能跨半屏 → speed>25 → tooFast → **第一推被吞**。
  //   这就是"时灵时不灵、再推一下就好"的来源。
  //
  //   ⇒ 改成【按事件间隔判】：连续移动的两帧间隔是 8~16ms，
  //     间隔一大（>200ms）就说明中间断过档（切窗口/失焦/鼠标移出又回来），
  //     这一帧的位移【不算】速度，只当作新的起点。
  //     ⚠ 不能用 `e.target===document` 来判：标准模式下从卡上往右推进时，
  //       指针越过卡右缘后 target 也会变成 document —— 那一帧一复位，
  //       dx 永远到不了 DIR_MIN(3)，手势就被自己判死了。
  const nowMs=e.timeStamp||performance.now();
  const staleGap = lastMoveMs!==0 && (nowMs-lastMoveMs)>200;
  lastMoveMs=nowMs;
  if(staleGap){pushStartX=null;pushStartT=0;movingRightPrev=false;lastMXPrevPush=null;}
  const dx = lastMX===null||staleGap ? 0 : mx-lastMX;
  const dy = lastMY===null||staleGap ? 0 : my-lastMY;
  lastMX=mx; lastMY=my;

  const speed = Math.abs(dx)+Math.abs(dy);
  const movingRight = dx >= DIR_MIN;      // 规则1: 向右
  const tooFast = speed > SPEED_MAX;      // 规则4: 甩过去

  // ── 推进速度追踪(用于二级光时长) ──
  //   ⚠ 鼠标左移就重新计算: 一旦不回右(不往右推), 就重置推进起点, 下次往右推从新起点重算。
  const now = performance.now();
  if(movingRight && !tooFast){
    if(pushStartX===null || lastMXPrevPush === null || !movingRightPrev){ pushStartX=mx; pushStartT=now; }
    else if(mx > pushStartX){
      const dt = now - pushStartT;
      pushSpeed = dt>8 ? (mx - pushStartX)/dt : pushSpeed;   // 平均推进速度, 防 dt 过小除零
    }
  }else{
    // 左移/停 → 重新计算起点
    if(mx < lastMX || !movingRight){ pushStartX=null; }
  }
  movingRightPrev = movingRight; lastMXPrevPush = mx;

  // 正在拖卡面上的参数条 → 横向推进/光效全部停手，否则拖到一半会弹出二级。
  // ⚠⚠ 2026-10-06 晚加自愈：没按着鼠标左键就不可能"还在拖"。
  //   mouseup 若丢在窗口外/被别的东西吃掉，gcDragging 会一直为真，
  //   表现是"右滑整个失效、还不报错"，只有随便点一下鼠标才恢复。
  if(gcDragging && !(e.buttons&1)) gcDragging=false;
  if(gcDragging) return;

  // ⭐⭐⭐ 2026-10-04 用户实测报的「自由模式右滑：一旦弹出的内容触及到别的卡片，
  //   别的卡片会被直接唤醒，我原来拉起的卡片会被挤占掉」。
  //   ⚠⚠ 真因就在下面这两行【以前没有护栏】：
  //     鼠标只要划到另一张自由卡上，就无条件 activateCard(那张) 抢走属主。
  //     而 activateCard → selectCard(next)（raise:false）里第一件事就是
  //     closeAll() —— 于是【刚拉起来的二级被当场收掉】，用户看到的就是"被挤占"。
  //   为什么是"偶发"：要鼠标恰好扫过另一张卡的矩形才触发；
  //     停在原地不动、或者两张卡离得远，就一次都碰不上。
  //   ⇒ 正解（也是那条注释本来就写明的意思——"已经拉起的链路属于它原来的主卡"）：
  //     【链子开着的时候，悬停不许换属主】。要换卡就真点一下（点击那条路径
  //     走 selectCard 会自己 closeAll 并切过去，语义清楚）。
  //   ⚠ 为什么用 zoneOpen 而不是"宽限时间"：这不是时序竞态（用户以为是，
  //     其实是【两个真源不同步】的老毛病，见 docs/137 §十一）。开没开是一个
  //     确定的状态，用状态判断才不会在慢机器上时灵时不灵。
  //   ⚠ 也不能一律禁掉悬停换属主：二级/三级都没开的时候，用户划过一张卡就该
  //     能直接右滑它（自由模式每张卡有自己的屏幕坐标，不能只认 cards[cur]）。
  const chainOpen = zoneOpen || detail.classList.contains('show');
  if(!chainOpen){
    const freeOwner=freeOwnerCard(mx,my,e.target);
    if(freeOwner&&freeOwner!==cards[cur])window.V7FreeMode.activateCard?.(freeOwner);
  }

  // ══ 三级"没用过就走"→ 收起二级三级(2026-08-29 用户方案) ══
  // 条件三个都满足才收: ① 三级开着且【没被操作过】(没点按/滚动/滚轮)
  //   ② 鼠标已移出三级卡的矩形 ③ 移出方向【不是往二级走】(即不是往左)
  // 意图: 误触或只看一眼就往外走 → 自动收干净; 真在用它(动过) → 不收, 安心用。
  // ⚠ 不加缓冲(用户定案): 移出即判定。停留不算操作。
  if(detail.classList.contains('show') && !detailUsed){
    const dr = detail.getBoundingClientRect();
    const outOfDetail = !(mx>=dr.left && mx<=dr.right && my>=dr.top && my<=dr.bottom) && !inOpenSelectPanel(mx,my);
    // 往二级走 = 往左(二级在三级左边)。往右/上/下离开都算"走了"。
    // (路线 A 的提示词框现在是真二级卡 #promptZone, 不再借用 #detail, 这条规则只管三级。)
    const towardZones = window.V7FreeMode?.isActive()
      ? hitRect(mx,my,zones,0,PAD_Y)||navigationGapHit(mx,my,zones,detail)||hitRect(mx,my,cards[cur],0,PAD_Y)||navigationGapHit(mx,my,cards[cur],zones)
      : mx < dr.left;
    if(outOfDetail && !towardZones) closeAll();
  }

  // ── 主卡 → 分区 ──
  if(!detail.classList.contains('show')&&!cards[cur].classList.contains('free-collapsed')){
    const c=cards[cur];
    const r=c.getBoundingClientRect();
    const hint=c.querySelector('.edgehint');
    const side=navigationSide(c,zones),movingToward=dx*side>=DIR_MIN;
    const inY = my>=r.top-PAD_Y && my<=r.bottom+PAD_Y;            // 规则3: 斜线容差
    const distFromEdge = side>0?mx-(r.right-4):r.left+4-mx;
    const inZoneIn  = inY && distFromEdge>=0 && distFromEdge<=EDGE_IN;
    const inZoneOut = inY && distFromEdge>=0 && distFromEdge<=EDGE_OUT;

    // ⭐⭐ 2026-10-06 晚（第二次，按实测路径改）：任务预览链开着时，直接【不许开二级】。
    //   实测复现：标准模式里一级卡就在任务卡正上方、大框左缘又压在它的触发带上，
    //   摸大框的"斜上右"路线会经过一级卡 → 被判成"右推开二级" → 二级一开，
    //   预览整体让位（concedeToMainCards）→ 闪回 / 时灵时不灵。
    //   自由模式不犯：任务堆不在主卡正下方，摸大框不经过主卡。
    //   ⇒ 规则从上一版的"0.4s 内摸过卡才让开"改成"预览链开着就不开"：
    //     要开二级先把预览收掉（鼠标移开 >160ms 它自己会收）。行为可预测，没有误判路径。
    //     ⚠ 真"在卡上往右推"的手感不受影响：那时预览链没开。
    const boxState=(window.V7Tween&&typeof V7Tween.boxState==='function')?V7Tween.boxState():null;
    const taskPreviewOn=!!document.querySelector('.task-preview.show')||!!(boxState&&boxState.open);

    // 光晕: 鼠标在主卡上越靠右、或推到右缘外的触发区, 光晕越强(触发前暗示)
    //   ⚠ 基准用【主卡本身】而不是"画面中心"(主卡在屏幕左, 右缘在中心左边,
    //     以中心为基准会算出负值永远不亮)。进度: 卡片中点→右缘=0~1, 进触发区封顶。
    //   ⚠【只在二级/三级都未开时显示】—— 一旦弹出, 光晕立即归零, 且不再被 mousemove 更新,
    //     否则会停在最高亮残留 + 随鼠标闪烁。离开主卡区也强制归零。
    if(hint){
      navigationHintSide(hint,side);
      const canShow = !zoneOpen && !detail.classList.contains('show') && !taskPreviewOn;
      const inCard = hitRect(mx,my,c,0,PAD_Y) || inZoneOut;   // 鼠标在主卡范围或右缘触发带
      if(canShow && !tooFast && inCard){
        const mid = r.left + r.width/2;
        const rightEdge = r.right;
        const t = Math.min(1, Math.max(0, side*(mx - mid) / (rightEdge - mid)));
        if(inZoneIn){
          hint.style.opacity = '1';
          hint.style.width  = '44px';
        }else if(t > 0){
          const p = Math.pow(t, 1.3);
          hint.style.opacity = String(0.15 + p * 0.75);
          hint.style.width  = String(p * 40) + 'px';
        }else{
          hint.style.opacity = '0';
          hint.style.width  = '0px';
        }
      }else{
        hint.style.opacity = '0';
        hint.style.width  = '0px';
      }
    }

    if(!zoneOpen){
      // 规则1+4: 只有向右移动、且不是甩过去, 才弹
      // ⚠ 2026-10-06 晚：预览链开着 → 不许开（见上面 taskPreviewOn 的实测说明）
      if(inZoneIn && movingToward && !tooFast && !taskPreviewOn){
        // ⚠ 路线 A(预设卡专属, 用户 2026-09-11 定案): 从剪影卡右滑 → 【提示词框直接当二级】。
        //   不弹预设列表(那是点部位才有的路线 B)。提示词框本体就是 #detail，只是挪到二级的位置。
        if(isPresetCard()){
          openPresetZone('prompt', true);
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⚠⚠ 2026-10-03 晚【真凶在这】：单张大二级的那几张卡（外挂能力 / 记录 / 设置），
        //   右滑走到这里【没有分支】→ 直接掉进下面的通用逻辑：
        //     ① fillZonesNow() 只填 `.zone:not(.pzone)`，而这几张卡的二级就是 .pzone
        //        → 它【一个子卡都没填】，而且 syncZoneKind 还顺手把它们全 display:none
        //     ② 于是 #zones 亮起来了、里面却【一个可见子卡都没有】
        //     ③ #zones 自身没有宽高，全靠子卡撑 → 空容器 = 0 宽
        //     ④ 下一个 mousemove：inConnected('zones') 量到 0 宽 → 判定"鼠标不在连通区"
        //        → closeZones() 立刻把它收了
        //   用户看到的就是【右滑打不开二级】（或闪一下就没）。
        //   ⚠ 为什么是"有时候能开"：卡的 state.open 是【粘的】——
        //     从别处（点能力行 / 路由进来）开过一次之后它一直是 true，
        //     engOn 就变真，右滑侥幸能开。这正是用户怀疑的"竞态"的真正来源：
        //     不是时序竞争，是【宿主 zoneOpen 与卡片 state.open 两个真源不同步】。
        //   ⇒ 正解：跟预设卡一个待遇 —— 右滑先让【卡自己】开，
        //     卡开的时候会回调 host.onOpen → enginesOpenZone()，宿主那一半自然就位。
        //     ⚠ 只调 enginesOpenZone() 是不够的：它只露容器，不改卡片 state.open，
        //       而 syncZoneKind 下一步就会把 zone 收回 display:none（这就是原 bug）。
        if(isEnginesCard()){
          if(enginesCard&&typeof enginesCard.open==='function'){
            // ⚠ 默认页从 'engine' 改成 'config'（配置信息）—— 右栏换成了四页导航，
            //   老的 'engine' 这一页已经不存在了，传它会静默落到第一页（行为对、名字错）。
            enginesCard.open(enginesCard.zoneId()||'config','swipe');
          }
          enginesOpenZone();          // 兜底：卡还没建起来时至少把容器露出来
          // ⭐ Phase B：右滑也是一次"卡打开"，刷一次状态出口（docs/150 §4.1 刷新时机）。
          enginesStatusRefresh(false).catch?.(()=>{});
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⭐⭐⭐ 2026-10-04 用户实测报的「设置卡右滑有时打不开 / 闪一下就没」（docs/137 §十一）
        //   ⚠⚠ 这跟上面外挂卡那条是【同一个 bug、同一处漏网】，只是漏的是另一张卡。
        //   真因（逐条）：
        //     ① 右滑走到这里，设置卡【没有分支】→ 掉进下面的通用逻辑
        //     ② 通用逻辑先调 fillZonesNow()，而它遇到设置卡【直接 return，什么都不填】
        //        （见 fillZonesNow 里 `if(isSettingsCard()){ return; }`）
        //     ③ 而 fillZonesNow 第一行就是 syncZoneKind()，它按
        //        `settingsCard.isOpen()` 决定 display —— 此刻卡还没开 → **把 zone 收成 display:none**
        //     ④ ⇒ #zones 亮起来了、里面一个可见子卡都没有 → 容器 0 宽
        //     ⑤ 下一个 mousemove：量到 0 宽 → 判"鼠标不在连通区" → closeZones() 立刻收掉
        //   ⇒ 用户看到的就是「闪一下就没」。
        //   ⚠ 为什么"有时候能开"：卡的 state.open 是【粘的】——
        //     从路由 / 点正脸状态行进来开过一次之后它一直是 true，
        //     setOn 就变真，右滑侥幸能开。**这就是他怀疑的"偶发静态"的真正来源：
        //     不是时序竞争，是【宿主 zoneOpen 与卡片 state.open 两个真源不同步】。**
        //   ⇒ 正解：跟外挂卡/预设卡一个待遇 —— 右滑先让【卡自己】开，
        //     卡开的时候会回调 host.onOpen → settingsOpenZone()，宿主那一半自然就位。
        if(isSettingsCard()){
          var setCard=settingsCardMount();
          if(setCard&&typeof setCard.open==='function'){
            // ⚠ tab 不传：让它自己按当前存的 state.tab 走。传了会把用户上次看的页踢回第一页。
            setCard.open(null,null);
          }
          settingsOpenZone();         // 兜底 + 宿主那一半（zoneOpen / .show / 清场定时器）
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⭐ 生成卡（2026-10-15 改成单张大二级）：跟设置卡同一个写法 —— 先让卡自己开，再露宿主那一半。
        //   ⚠ 不写这个分支 = 掉进下面的通用逻辑 = 设置卡 10-04 那个"闪一下就没"的 bug 原样重演。
        if(isGenerationCard()){
          var genCard=generationCardMount();
          if(genCard&&typeof genCard.open==='function') genCard.open(null,null);
          generationOpenZone();
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⭐ 助手卡（2026-10-17 夏三六）：同生成卡 —— 先让卡自己开，再露宿主那一半（不写这个分支 = 「闪一下就没」）。
        if(isAssistantCard()){
          var asCard=assistantCardMount();
          if(asCard) asCard.open(null);
          assistantOpenZone();
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⭐ 问题反馈卡（2026-10-18 深夜）：同生成卡 —— 先让卡自己开，再露宿主那一半。
        if(isFeedbackCard()){
          var fbCard=feedbackCardMount();
          if(fbCard) fbCard.open(null,null);
          feedbackOpenZone();
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⭐ 社区卡（2026-10-20）：同上 —— 先让卡自己开，再露宿主那一半。
        if(isCommunityCard()){
          var ccCard=communityCardMount();
          if(ccCard) ccCard.open(null,null);
          communityOpenZone();
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⭐⭐⭐ 同上：记录卡也是【单张大二级】，右滑同样没有分支（2026-10-04 一并补）
        //   ⚠ 记录卡跟设置卡的区别：它的 open() 需要【一个项目 id】（openProject）。
        //     右滑没有指定项目 → 用第一个项目，跟路由进来时的做法一致
        //     （见 ui.html:13227 `recordsCard.openProject(first.project,'route')`）。
        if(isRecordsCard()){
          var recCard=recordsCardMount();
          if(recCard&&typeof recCard.openProject==='function'){
            var recFirst=null;
            try{ recFirst=(recCard.projectList()||[])[0]||null; }catch(_){}
            if(recFirst&&recFirst.project) recCard.openProject(recFirst.project,'swipe');
          }
          recordsOpenZone();          // 兜底 + 宿主那一半
          if(hint) hint.style.opacity='0';
          return;
        }
        // ⚠ 先按当前 cur 填内容, 再加 .show —— 否则二级会显示上一个主卡的旧内容。
        //   (二级未开时切主卡不会触发 syncZonesToCard, 静态 HTML 没更新)
        // A previous owner's closing animation must not later clear this new chain.
        if(allCloseTimer){clearTimeout(allCloseTimer);allCloseTimer=null;}
        if(zoneCloseTimer){clearTimeout(zoneCloseTimer);zoneCloseTimer=null;}
        fillZonesNow();
        zoneOpen=true; zones.classList.remove('closing'); zones.classList.add('show');
        // 【整条链路统一跟鼠标速度】二级滑入动画的时长 + 光的时长, 都从同一个 pushSpeed 算,
        //   三者(滑入/光带/亮线)同速, 不脱节。快推整体快, 慢推整体慢。
        const pv = Math.max(0.15, Math.min(2.0, pushSpeed));
        const t = (pv - 0.15) / (2.0 - 0.15);                    // 归一化 0~1
        const durS = 0.9 - Math.pow(t, 1.6) * (0.9 - 0.40);      // 幂: 中低速拖长, 快速才短
        // 二级卡滑入动画时长 = durS(覆盖 CSS 的 var(--dur)); opacity 同步
        document.querySelectorAll('#zones .zone').forEach(z=>{
          z.style.transitionDuration = durS + 's, ' + durS + 's, .15s';   // transform, opacity, border-color
        });
        // 光带 + 亮线 一起, 用同一个 durS(同速, 不脱节)
        document.querySelectorAll('#zones .zone .zone-glow').forEach(gl=>{
          gl.style.animationDuration = durS + 's';
          gl.classList.remove('glow');
          void gl.offsetWidth;             // 强制回流, 让连续弹出也能重播动画
          gl.classList.add('glow');
        });
        document.querySelectorAll('#zones .zone .zone-bright').forEach(gl=>{
          gl.style.animationDuration = durS + 's';
          gl.classList.remove('glow');
          void gl.offsetWidth;
          gl.classList.add('glow');
        });
        if(hint) hint.style.opacity='0';
      }
    }else{
      // 规则2: 已弹出 → 在连通区内一律保持, 不看方向
      // 规则5: 滞回 —— 用更大的 EDGE_OUT 判定离开
      // ⚠【二级 → 三级】鼠标在二级上往右推进到二级区右缘触发区 → 弹三级带光.
      //   二级右缘触发区宽度按比例(二级200 vs 一级300, EDGE_IN 80→53); 鼠标Y落在哪个分区就弹哪个.
      // ⚠ 预设卡(路线 B, 列表当二级): 在【某一行】上右滑 = 弹那一行的三级, 跟普通二级卡一样。
      //   不在任何行上(空白/工具条)右滑则什么都不做 —— 不弹空框。(用户 2026-09-11 定案)
      if(!detail.classList.contains('show') && isPresetCard() && presetZoneKind==='list' && presetZoneEl){
        const zr = presetZoneEl.getBoundingClientRect();
        const detailSide=navigationSide(presetZoneEl,detail);
        const zInY = my >= zr.top - PAD_Y && my <= zr.bottom + PAD_Y;
        const zDist = detailSide>0?mx-zr.right:zr.left-mx;
        const edIn = Math.round(EDGE_IN * 200/300);
        if(zInY && zDist >= 0 && zDist <= edIn && dx*detailSide>=DIR_MIN && !tooFast && window.PRESETUI){
          // 右缘触发区里没有行元素可命中，所以按【鼠标 Y】找同一高度上的那一行
          const row=[...presetZoneEl.querySelectorAll('.pz-row')].find(r=>{
            const rr=r.getBoundingClientRect(); return my>=rr.top && my<=rr.bottom;
          });
          if(row) PRESETUI.loadPresetById(row.dataset.presetId, true);
        }
      }
      // ⚠ 记录卡没有三级，不许从这里被推出来（2026-09-30，docs/96 问题一的第 2 条路径）。
      if(!detail.classList.contains('show') && !isPresetCard() && !isRecordsCard()){
        const zr = zones.getBoundingClientRect();
        const detailSide=navigationSide(zones,detail);
        const zInY = my >= zr.top - PAD_Y && my <= zr.bottom + PAD_Y;
        const zDist = detailSide>0?mx-zr.right:zr.left-mx;
        const edIn = Math.round(EDGE_IN * 200/300);        // 按比例缩触发区
        // ── 二级预告光(照一级): 鼠标在某张二级卡上过中线往右移 → 该卡右缘实时渐亮 ──
        // ⚠⚠ 2026-10-08：光要跟着"这张卡到底有没有三级"走。
        //   没有三级的卡（设置/外挂/记录）如果还亮这个光，用户看到的是
        //   "右边有东西能拉出来"——而拉出来什么都没有 ⇒ 比不亮更糟（假承诺）。
        //   守门的判据同 openDetail：V7CardRegistry.hasDetail(当前卡)。
        const hintCardId = (cards[cur] && cards[cur].dataset && cards[cur].dataset.card) || '';
        const hintRegistry = window.V7CardRegistry;
        const hintAllowed = !(hintCardId && hintRegistry && typeof hintRegistry.hasDetail === 'function'
          && !hintRegistry.hasDetail(hintCardId));
        zones.querySelectorAll('.zone:not(.pzone)').forEach(zn=>{
          const eh = zn.querySelector('.zone-edgehint');
          if(!eh) return;
          if(!hintAllowed){ eh.style.opacity='0'; eh.style.width='0px'; return; }
          navigationHintSide(eh,detailSide);
          const zb = zn.getBoundingClientRect();
          const onThis = my >= zb.top - PAD_Y && my <= zb.bottom + PAD_Y;
          const distance=detailSide>0?mx-zb.right:zb.left-mx;
          const inTrig = onThis && distance >= 0 && distance <= edIn;
          if(onThis && !tooFast){
            const mid = zb.left + zb.width/2;
            const tt = Math.min(1, Math.max(0, detailSide*(mx - mid) / (zb.right - mid)));
            if(inTrig){
              eh.style.opacity = '1';
              eh.style.width = '29px';              // 峰值按二级卡宽比例(同弹出光)
            }else if(tt > 0){
              const pp = Math.pow(tt, 1.3);
              eh.style.opacity = String(0.15 + pp * 0.75);
              eh.style.width = String(pp * 26) + 'px';
            }else{
              eh.style.opacity = '0'; eh.style.width = '0px';
            }
          }else{
            eh.style.opacity = '0'; eh.style.width = '0px';
          }
        });
        if(zInY && zDist >= 0 && zDist <= edIn && dx*detailSide>=DIR_MIN && !tooFast){
          // 鼠标 Y 落在哪张分区, 就选哪个分区(用每个 .zone 的矩形判断)
          zones.querySelectorAll('.zone:not(.pzone)').forEach(zn=>{
            const znRect = zn.getBoundingClientRect();
            if(my >= znRect.top - PAD_Y && my <= znRect.bottom + PAD_Y){
              const zIdx = parseInt(zn.dataset.z);
              if(zIdx !== zoneSel) selectZone(zIdx);
            }
          });
          // 弹三级(带光): show + 填充内容 + 触发三级光
          openDetail(true);
        }
      }
      // ⚠ 三级是靠二级当标题的: 三级一开, 二级+三级都常驻, 鼠标移走都不收.
      //   只有明确关闭(Esc/点面板外/失焦)才一起收。三级未开时才按"移出即收二级"。
      if(!detail.classList.contains('show')){
        if(inConnected(mx,my,'zones')) zonesOpenedByNav=0;          // 进来过了：之后照老规矩
        else if(!inZoneOut && !zonesOpenedByNav) closeZones();       // ⭐ 10-19：点按钮跳出来的、鼠标还没进来过 → 不收
      }
    }
  }

  // ── 任务卡 → 预览 ──
  // 【独立于主卡链路】主卡的分区/详情开着时, 任务预览照样能弹, 两条链路互不干扰。
  {
    const topTask=topTaskEl();
    if(topTask){
      const r=topTask.getBoundingClientRect();
      const pv=topTask.querySelector('.task-preview');
      const side=navigationSide(topTask,pv);
      const inY = my>=r.top-PAD_Y && my<=r.bottom+PAD_Y;
      const distFromEdge = side>0?mx-(r.right-4):r.left+4-mx;
      const inZoneIn  = inY && distFromEdge>=0 && distFromEdge<=EDGE_IN;
      const inZoneOut = inY && distFromEdge>=0 && distFromEdge<=EDGE_OUT;
      const pvOpen = pv && pv.classList.contains('show');

      // ⚠⚠⚠ 全文件【只此一处】定义 hoverAutoOpen —— 下面的 else 分支里
      //   原来还有一个同名的局部变量，2026-10-09 实测栽过：
      //   两个同名、不同作用域 ⇒ 改开关只对一半的路生效（看着像「开关没用」）。
      //   ⇒ 已经统一到这里。**以后别再写第二个。**
      //   ⚠ 它管的是「大图会不会【自动】弹出来」：
      //     · 朝预览条方向移动时弹条+弹框（下面第一处）
      //     · 悬停就开（下面第二处）
      //     ✗ 不管「点缩略图」那条 —— 那是用户主动点的，开关关掉之后照样能开。
      //   ⚠ `!== false` 而不是 `=== true`：老存档里没这个键时按【开】处理。
        // ⚠ `!boxAutoOpenSuppressed()`：用户刚手动收起过 —— 1.5 秒内别再自动弹，
      //   否则"点了关不掉"（鼠标还停在上面，同一次交互会立刻弹回来）。
      const hoverAutoOpen=(typeof settingsRuntime!=='object'||settingsRuntime.hoverOpensPreview!==false)
        && !boxAutoOpenSuppressed();

      // ── 任务卡预告光(跟一/二级同款): 鼠标在任务卡上过中线往右移 → 右缘实时渐亮 ──
      const teh = topTask.querySelector('.task-edgehint');
      if(teh){
        navigationHintSide(teh,side);
        const onCard = hitRect(mx,my,topTask,0,PAD_Y);  // ⚠ 只在鼠标真的在卡片上时才显示光效, 不包含触发区
        if(!pvOpen && !tooFast && onCard){
          const mid = r.left + r.width/2;
          const tt = Math.min(1, Math.max(0, side*(mx - mid) / (r.right - mid)));
          if(inZoneIn){
            teh.style.opacity='1'; teh.style.width='44px';    // 峰值同一级(任务卡也300宽)
          }else if(tt > 0){
            const pp = Math.pow(tt, 1.3);
            teh.style.opacity = String(0.15 + pp * 0.75);
            teh.style.width = String(pp * 40) + 'px';
          }else{
            teh.style.opacity='0'; teh.style.width='0px';
          }
        }else{
          teh.style.opacity='0'; teh.style.width='0px';
        }
      }

      if(!pvOpen){
        if(inZoneIn && dx*side>=DIR_MIN && !tooFast && pv){
          clearPreview();                 // 先清别的, 再开自己(顺序不能反, 否则自己关自己)
          pv.classList.add('show');
          window.__pv=pv;                 // 保持标记已在上面的 clearPreview() 里解除
          // ⭐⭐⭐ 2026-10-09（用户报「只出缩略图条、不点大图，移开鼠标条不消失」）：
          //   **条弹出来的这一刻就要认下它归属谁**，跟"弹不弹大图"无关。
          //   ⚠⚠ 为什么必须在这里补：原来"认归属"只发生在 hoverTaskCard 里，
          //     而下面那个 if 被设置项挡着（关掉就不调）⇒
          //     **那个开关顺手把"归属登记"也一起关掉了** ⇒ 收框时 notifyId 是 null
          //     ⇒ 收条通知发不出去 ⇒ 条永远赖着（用户实测）。
          //   ⚠ 这是"收条唯一出口"的前置条件，漏了它整条收尾都断。
          //     以后谁把条弹出来，谁就得顺手登记一下（别再依赖 hoverTaskCard）。
          if(window.V7Tween && typeof V7Tween.setBoxOwner==='function'){
            V7Tween.setBoxOwner(topTask.dataset.task);
          }
          // ⭐ 2026-10-04：预览条弹出的同时，上方弹大预览框（docs/132 §2.2）。
          //   ⚠ 只在这一处调 —— 别在别的地方再调一次，会跟"预览条的开关"脱节。
          // ⭐⭐ 2026-10-09（docs/191）：这一条受设置「鼠标移到缩略图上自动弹出大预览框」管。
          //   ⚠⚠ 追踪器实测抓到的就是这里（栈指向本行）—— 用户说的悬停就弹
          //     其实是「朝预览条方向移动时，条和大图一起弹出来」。
          //   ⚠ 关掉之后【预览条照旧弹】（那是右滑手势，用户 10-04 定的手感，不改），
          //     只是【大图不自动弹】—— 想看大图点一下缩略图（走 openShot）。
          if(hoverAutoOpen && window.V7Tween && taskList.length){
            const curTask=taskById(topTask.dataset.task);
            if(curTask) window.V7Tween.hoverTaskCard(topTask,curTask);
          }
          // 预览弹出 → 任务卡左缘播弹出光(光带+亮线), 速度跟鼠标推进(同二三级)
          const pvv=Math.max(0.15, Math.min(2.0, pushSpeed));
          const tt2=(pvv-0.15)/(2.0-0.15);
          const durT=0.9 - Math.pow(tt2, 1.6)*(0.9-0.40);
          ['.task-glow','.task-bright'].forEach(cls=>{
            const gl=topTask.querySelector(cls);
            if(gl){
              gl.style.animationDuration=durT+'s';
              gl.classList.remove('glow');
              void gl.offsetWidth;
              gl.classList.add('glow');
            }
          });
          if(teh){ teh.style.opacity='0'; teh.style.width='0px'; }   // 预告光让位给弹出光
        }
      }else{
        // ⭐⭐ 2026-10-06 晚：条开着但【框没开】或框指着别的任务时，再推右要把框叫回来。
        //   旧行为是"pvOpen 就什么都不做" —— 一旦进入"条活着、框死了"，
        //   后面每一次右滑都像坏了（用户实测"第一下正常、后面全不正常"）。
        //   门和弹出完全同一套（在触发带内 + 本帧右移≥3 + 不是甩），不会误触；
        //   框已经正常开着、且就是这张任务时【什么都不做】（不打扰缩放/平移）。
        // ⭐⭐ 2026-10-09（docs/191）：这条【也】受「鼠标移到缩略图上自动弹出大预览框」管。
        //   ⚠ 它跟上面 8102 那条是同一类 —— 都是"往预览条方向推一下就把大图叫出来"。
        //     追踪器实测：开关关掉后栈指向本行 ⇒ 说明只关 8102 不够，这里也必须关。
        //     （教训：**"自动弹"有几个入口就要加几道门**。我连漏两次，都是靠栈抓出来的。）
        if(hoverAutoOpen && inZoneIn && dx*side>=DIR_MIN && !tooFast && pv && window.V7Tween && typeof V7Tween.boxState==='function'){
          const owner=V7Tween.boxState();
          const curTask=taskById(topTask.dataset.task);
          if(curTask && (!owner||!owner.open||String(owner.taskId)!==String(topTask.dataset.task))){
            window.V7Tween.hoverTaskCard(topTask,curTask);
          }
        }
        // ⭐⭐⭐ 2026-10-09 修（用户实测：「悬停在已完成的任务上本来会直接打开大图；
        //   但在详情页滚轮切过任务之后，就要点一下才打开」）：
        //
        //   真因：触发大图的门【一直只有"右滑"这一条】——
        //     详情没开 → `if(!pvOpen)` 分支里右滑（dx≥3）才弹；
        //     详情已开 → 上面那个分支，同样要求再右滑一次。
        //   ⇒ 悬停本身从来不是触发器，它是"右滑弹出"的【副产品】。
        //     所以"详情没开、你右滑一次"看起来像"悬停就开"；
        //     而滚轮切过任务之后【详情一直开着】，就只剩"再右滑一次"那条路
        //     ⇒ 表现成"要点一下"（点击有它自己的 openShot 入口，所以点了能开）。
        //
        //   ⇒ 补一条【悬停就开】：详情已经开着、鼠标就在这张任务卡上
        //     （走到这里说明在 inZoneIn 触发带内），就直接把大图叫出来。
        //   ⚠ 只补"详情已开"这一半 —— 详情没开时不能悬停就弹，
        //     那会跟"右滑才弹"打架（用户 10-04 定的手感）。
        //   ⚠ 没有成品图就别叫：hoverTaskCard 自己有 firstReadyShot 那道闸，
        //     这里先判一下是为了【不去占 boxTaskId】（否则会让归错人）。
        //
        // ⭐⭐ 2026-10-09（用户要求）：这一条【悬停就开】现在受设置开关控制。
        //   用户原话：「在设置里面的交互行为里面添加一项，就是默认开启的一项功能，
        //             鼠标选中交互图像时自动弹出预览框，如果说把这个东西关了，
        //             那就只有我点下去之后才会出现大图预览」。
        //   ⚠ 门只加在【这里】—— 上面那个"右滑 ≥3px 才弹"的分支
        //     （inZoneIn && dx*side>=DIR_MIN，用户 10-04 定的手感）【一个字不改】。
        //     理由：关掉开关的语义是"别自动弹"，不是"把右滑也废掉"；
        //     而且右滑本来就需要用户主动推一下，不属于"自动"。
        //   ⚠ 关掉之后点缩略图照样能开（走 buildPreview 里 img 的 click → openShot），
        //     所以这不是"把功能关死"。
        //   ⚠ 读的是 settingsRuntime.hoverOpensPreview，默认 true（保持现在的手感）。
        //     `!== false` 而不是 `=== true`：老存档里没有这个键时按【开】处理，
        //     绝不能让升级后的默认行为变成"悬停不弹了"。
        if(hoverAutoOpen && pv && window.V7Tween && typeof V7Tween.boxState==='function'){
          const hoverTask=taskById(topTask.dataset.task);
          const hasShot=!!(hoverTask && (hoverTask.shots||[]).some(function(s){
            return s && (hoverTask.kind==='generation' ? s.restoreState==='done' : s.done) && s.imgId; }));
          if(hoverTask && hasShot){
            const own=V7Tween.boxState();
            if(!own||!own.open||String(own.taskId)!==String(hoverTask.id)){
              window.V7Tween.hoverTaskCard(topTask,hoverTask);
            }
          }
        }

        if(!inConnected(mx,my,'task') && !inZoneOut){
          // ⚠ 看完大图回来时不收：大图是独立窗口，关掉的瞬间鼠标多半停在屏幕中央，
          //   按正常规则会立刻判定"鼠标不在预览上"把预览收掉，用户就得重新推一次才能看下一张。
          //   保持到用户真的把鼠标放上来为止(下面那个分支解除)。
          if(!pvKeepOpen){
            // ⚠⚠⚠ 2026-10-06：【这里不再自己收！】只把"该收了"这件事交给 V7Tween，
            //   由它【一个判据】把预览条和预览框一起收掉。
            //
            //   为什么绕这一下 —— 这一段我连着改错两次，教训写清楚：
            //
            //   原版（10-05 之前）：这里【立刻】把条收掉，再调 leaveTaskCard()，
            //     而后者 160ms 后【又判一次】stillInPreviewChain（它包含"指针在不在框上"）。
            //     等那一次判断时鼠标多半正停在框上 → 判成"还在" → 框留着。
            //     ⇒ **条没了、框还在** —— 就是用户报的「预览窗口活着，小图标窗口死了」。
            //     根因：一次离开被【两个地方各自判了一次】，两次结论不一致。
            //
            //   我的第一版修法：这里改成"立即把框和条一起收"（hideBoxIfTask）。
            //     条和框倒是同步了，但【丢掉了 160ms 宽限期】——
            //     任何一次瞬时的不连通（框刚弹出、几何还在变）都会立刻双杀，
            //     下一次 mousemove 又满足弹出条件 → 重新弹出。
            //     ⇒ **弹出即闪回**（用户 10-06 报的，标准模式必现、自由模式正常）。
            //
            //   现在：这里【一个字都不动 DOM】，只在离开时喊一声 leaveTaskCard()。
            //     收不收、什么时候收，全由 tween-preview 那【一个】判据说了算：
            //       160ms 内指针回到连通区 → 什么都不发生（宽限）
            //       真走了 → hideBox() → 它反手把预览条也收掉（onBoxClosed 回调）
            //     这样"条和框"必然同生同死，而且保留了防抖。
            if(window.V7Tween&&typeof window.V7Tween.leaveTaskCard==='function'){
              window.V7Tween.leaveTaskCard();
            }else{
              // 兜底：V7Tween 没加载时退回老行为（至少别让条赖着）
              pv.classList.remove('show');
              if(window.__pv===pv) window.__pv=null;
            }
          }
        }else if(pvKeepOpen){
          pvKeepOpen=false;   // 鼠标已经放到预览/连通区上 → 保持解除, 之后按正常规则收
        }
      }
    }
  }

  // ── 报错卡 → 展开 ──
  // 【报错详情层展开】向右推进显示详情层(跟任务预览同款), 带预告光和弹出光
  {
    const topErr=topErrorEl();
    if(topErr && !topErr.classList.contains('ec-l1')){  // L1 胶囊不展开
      const detailEl = topErr._detailEl;  // 获取关联的详情层
      if(detailEl){
        const r=topErr.getBoundingClientRect();
        const side=navigationSide(topErr,detailEl);
        const inY = my>=r.top-PAD_Y && my<=r.bottom+PAD_Y;
        const distFromEdge = side>0?mx-(r.right-4):r.left+4-mx;
        const inZoneIn  = inY && distFromEdge>=0 && distFromEdge<=EDGE_IN;
        const inZoneOut = inY && distFromEdge>=0 && distFromEdge<=EDGE_OUT;
        const detailShown = detailEl.classList.contains('show');

        // ── 报错卡预告光: 鼠标在报错卡上过中线往右移 → 右缘实时渐亮 ──
        const eeh = topErr.querySelector('.error-edgehint');
        if(eeh){
          navigationHintSide(eeh,side);
          const onCard = hitRect(mx,my,topErr,0,PAD_Y);  // ⚠ 只在鼠标真的在卡片上时才显示光效, 不包含触发区
          if(!detailShown && !tooFast && onCard){
            const mid = r.left + r.width/2;
            const tt = Math.min(1, Math.max(0, side*(mx - mid) / (r.right - mid)));
            if(inZoneIn){
              eeh.style.opacity='1'; eeh.style.width='44px';    // 峰值同任务卡(报错卡也300宽)
            }else if(tt > 0){
              const pp = Math.pow(tt, 1.3);
              eeh.style.opacity = String(0.15 + pp * 0.75);
              eeh.style.width = String(pp * 40) + 'px';
            }else{
              eeh.style.opacity='0'; eeh.style.width='0px';
            }
          }else{
            eeh.style.opacity='0'; eeh.style.width='0px';
          }
        }

        if(!detailShown){
          // 向右推进 → 显示详情层 + 播弹出光(光带+亮线)
          if(inZoneIn && dx*side>=DIR_MIN && !tooFast){
            detailEl.classList.add('show');
            window.__errDetail=detailEl;
            // 详情弹出 → 报错卡右缘播弹出光, 速度跟鼠标推进(同任务卡)
            const pvv=Math.max(0.15, Math.min(2.0, pushSpeed));
            const tt2=(pvv-0.15)/(2.0-0.15);
            const durE=0.9 - Math.pow(tt2, 1.6)*(0.9-0.40);
            ['.error-glow','.error-bright'].forEach(cls=>{
              const gl=topErr.querySelector(cls);
              if(gl){
                gl.style.animationDuration=durE+'s';
                gl.classList.remove('glow');
                void gl.offsetWidth;
                gl.classList.add('glow');
              }
            });
            if(eeh){ eeh.style.opacity='0'; eeh.style.width='0px'; }   // 预告光让位给弹出光
          }
        }else{
          // 详情层已显示, 鼠标移出 → 收起
          if(topErr.dataset.v7DirectConfirmation !== '' && !hitRect(mx,my,topErr,0,PAD_Y) && !hitRect(mx,my,detailEl,0,PAD_Y) && !navigationGapHit(mx,my,topErr,detailEl) && !inZoneOut){
            detailEl.classList.remove('show');
            if(window.__errDetail===detailEl) window.__errDetail=null;
          }
        }
      }
    }
  }
});

// ── 滚轮: 按【几何范围】判定归属, 不用 elementFromPoint ──
// 【坑】elementFromPoint 返回最顶层元素, 任务预览被别的层盖住时会误判成"不在任务区",
//   于是滚轮跑去切主卡。且原来的 else 是兜底 —— 鼠标在空白处也会切主卡。
// 正确做法: 用各区域的实际矩形判断归属; 都不命中就什么都不做。
function hitRect(mx,my,el,padX,padY){
  if(!el) return false;
  const r=el.getBoundingClientRect();
  if(r.width===0||r.height===0) return false;
  const px=padX||0, py=padY||0;
  return mx>=r.left-px && mx<=r.right+px && my>=r.top-py && my<=r.bottom+py;
}
function detailWheelScrollTarget(mx,my){
  const outer=detail.querySelector('.dc-scroll');
  if(!outer) return null;
  // 提示词/工作流详情的外层负责裁切，真正可滚动的是内部 .pd-body；
  // 设置、历史等详情则直接滚动 .dc-scroll。按鼠标位置选最深的可滚动层，
  // 避免把 scrollTop 写到 overflow:hidden 的外层而页面看起来不动。
  // .v7tw-params / .v7tw-list：工具工作面（原地展开的大卡）里能滚的两块
  const candidates=[outer,...outer.querySelectorAll('.pd-body,.qz-scroll,.pz-list,.v7tw-params,.v7tw-list')];
  for(let i=candidates.length-1;i>=0;i--){
    const el=candidates[i], style=getComputedStyle(el);
    if(!hitRect(mx,my,el) || !['auto','scroll'].includes(style.overflowY)) continue;
    if(el.scrollHeight>el.clientHeight+1) return el;
  }
  return outer;
}
window.addEventListener('wheel',e=>{
  if(e.target.closest?.('.v7-floating-bar'))return;
  // ⭐ 2026-10-15：公告卡正文长了会在卡里滚。还能往这个方向滚 → 交给原生滚动，不切报错卡；
  //   滚到头了才照旧切卡（跟详情层"滚到头才翻"一个手感）。
  const annBody=e.target.closest?.('.error-card.ec-rich .ec-rich-body');
  if(annBody&&annBody.scrollHeight>annBody.clientHeight+1){
    const canUp=annBody.scrollTop>0, canDown=annBody.scrollTop+annBody.clientHeight<annBody.scrollHeight-1;
    if((e.deltaY<0&&canUp)||(e.deltaY>0&&canDown))return;
  }
  // ⚠ 大图查看器打开时, 滚轮归它; 弹窗锁定时不响应(切卡/滚都锁)
  if(viewerOpen) return;
  if(document.getElementById('popupLock').classList.contains('on')) return;
  if(v7OverlayOpen()) return;   // 任意独立工作面打开 → 滚轮归工作面
  if(window.UISelect && UISelect.isOpen()) return;       // 下拉面板开着 → 滚轮归它
  // ⚠ 2026-10-06 晚：同 mousemove —— 只有【看得见】的内嵌工作区才拦滚轮；
  //   藏在隐藏详情层里的旧工作区不许把滚轮关掉。
  if(window.V7Workspaces?.hasVisibleEmbedded?.()??window.V7Workspaces?.hasEmbedded?.())return;
  if(isCollapsed) return;
  const mx=e.clientX,my=e.clientY;
  const freeMode=window.V7FreeMode?.isActive();
  if(window.V7FreeMode?.isTransitioning())return;
  // 触控板横向滚动使用 deltaX；普通鼠标仍走 deltaY。没有有效轴向时不切卡。
  const axisDelta=Math.abs(e.deltaX||0)>Math.abs(e.deltaY||0)?e.deltaX:e.deltaY;
  if(!axisDelta)return;
  const dir=axisDelta>0?1:-1;
  const freeCard=freeMode?(e.target.closest?.('#stack .block-card')||freeOwnerCard(mx,my,e.target)):null;

  // 【详情优先】鼠标在打开的详情卡上 → 详情内容滚动, 不切主卡/分区(三级内容滚轮浏览)
  if(detail.classList.contains('show') && hitRect(mx,my,detail) && (!window.V7FreeMode?.isActive()||e.target.closest('#detail'))){
    detailUsed=true;                      // ⚠ 在三级上滚轮 = 用过它
    const scroll=detailWheelScrollTarget(mx,my);
    if(scroll){
      // 详情内容由这里统一消费滚轮。全局 wheel 监听必须显式声明
      // passive:false，否则 Chromium 还会执行默认滚动，导致一次滚轮
      // 同时走“手动 scrollTop + 浏览器默认滚动”，实际位移翻倍。
      e.preventDefault();
      const delta = typeof pzNormalizeDelta === 'function'
        ? pzNormalizeDelta(e, scroll.clientHeight)
        : e.deltaY;
      scroll.scrollTop += delta;
    }
    return;
  }

  // 【预设二级】不在这儿处理 —— 它有自己的【非 passive】滚轮监听(见文件末尾 pzWheel)，
  // 那边会 stopPropagation，所以事件根本到不了这里。
  // ⚠ 预设二级仍需单独一套: 它要在自己的内容区内阻止默认滚动并累计翻页阈值，
  //   不能混入详情卡的像素滚动路径。

  // 【报错区】鼠标在报错堆上 → 切换当前报错卡(滚轮切换, 像任务堆)
  const topErr = topErrorEl();
  const overErr = hitRect(mx,my,topErr)&&(!window.V7FreeMode?.isActive()||e.target.closest('#errors'));
  const errCount = errorsEl.querySelectorAll('.error-card').length;

  // 任务区 = 当前任务卡 或 它展开的预览层
  const topTask=topTaskEl();
  const pvEl=topTask&&topTask.querySelector('.task-preview.show');
  const overTaskPreview = hitRect(mx,my,pvEl);
  const overTask = (hitRect(mx,my,topTask) || overTaskPreview)&&(!window.V7FreeMode?.isActive()||e.target.closest('#tasks'));
  const taskCount = tasksEl.querySelectorAll('.task:not(.leaving)').length;   // 动态数量

  // 主卡区 = 当前主卡 / 分区 / 详情
  const curCard=cards[cur];
  const overMain = (freeMode?!!freeCard:hitRect(mx,my,curCard))
                || hitRect(mx,my,zones.classList.contains('show')?zones:null)
                || hitRect(mx,my,detail.classList.contains('show')?detail:null);

  lastDir = dir;
  // 短窗口中报错堆会向上夹取，与任务卡几何重叠；任务卡在视觉上
  // 位于报错卡上方，滚轮也必须先交给可见的任务卡。
  if(overErr && errCount>0 && !overTask){
    ecur=(ecur+dir+errCount)%errCount;
    setErrors();
  }else if(overTask && taskCount<=1){
    // 只有一个任务时，任务主卡和预览区都没有可切换目标。
    // 直接吞掉滚轮，避免 setTasks() 重排 DOM，导致当前详情页被刷新/回到初始状态。
    return;
  }else if(overTask && taskCount>0){
    const wasOpen = !!(pvEl);            // 预览开着 → 跟随过渡, 不关闭
    // ⭐⭐⭐ 2026-10-09 修（用户实测：「从一个有大图到没大图的任务中互相切，
    //   大图会残留」）：
    //   原来这一段只调 followPreview()（它只管【任务卡片详情】，
    //   整个函数里一次都没碰过 V7Tween / 大图）⇒ boxTaskId 还指着旧任务，
    //   大图就留在屏幕上。
    //
    //   ⚠ 为什么"有图→有图"时看着正常：新任务也有成品图 → 下面那段
    //     （条开着、框却指着别的任务）会把框叫回来，于是"大图跟着切了"。
    //     而"有图→无图"时新任务没成品图、开不出新框 ⇒ 旧框【没人管】= 残留。
    //   ⚠ 所以这是"两条路对同一件事各管一半"的老毛病：详情跟着切了，大图没跟。
    const prevTaskId = topTaskEl() ? topTaskEl().dataset.task : null;
    tcur=(tcur+dir+taskCount)%taskCount; // 用动态数量, 不是旧 TN
    setTasks();
    // ① 把【属于旧任务】的大图收掉。⚠ 带归属判断 —— 用户快速划过几张卡时，
    //   框可能已经属于别人了，不能无差别关掉。
    //   ⚠ 必须先取 prevTaskId 再 setTasks()：setTasks 之后 topTaskEl() 已经是新的了。
    if(prevTaskId && window.V7Tween && typeof V7Tween.hideBoxIfTask==='function'){
      V7Tween.hideBoxIfTask(prevTaskId);
    }
    // ② 「看完大图保持展开」那个标记也要清 —— 不清的话它会让收起被抑制，
    //   残留照样在（见 pvKeepOpen 的注释）。
    pvKeepOpen=false;
    if(wasOpen) followPreview(dir);      // 预览内容跟着换(与主卡同一语言)
    else { clearPreview(); window.__pv=null; }
    // 任务卡切换后，详情面板跟着显示该任务自己的状态、进度和结果。
    if(typeof aiRefreshInPlace==='function')aiRefreshInPlace();
  }else if(!freeMode && buriedCardAt(mx,my)>=0){
    // ⭐⭐ 2026-10-01 用户定案：主卡的滚轮行为，【标准模式和自由模式必须一致】。
    //
    //   自由模式下，鼠标放在"卡片叠压露出的那条文字带"上可以直接滚，
    //   不受上方卡片内容的限制（走 freeCard → cycleAtCurrent）。
    //
    //   标准模式原来【没有这一支】，于是那条露出带是个死区：
    //     · 露出带在当前卡的矩形【之外】（实测：当前卡 y 60~460，露出带从 460 往下），
    //       所以上面那三条 capture 监听里的 hitRect(...) 全都不命中 → return；
    //     · 这条全局监听里 overMain 也算不上（它同样按当前卡矩形判）。
    //   → 结果就是"鼠标放在叠压区滚，什么都不发生"。
    //     而且上方卡片那些"先滚内层 / 攒光够数才切"的先期判断，
    //     本来就不该管这块区域（那里根本不是这张卡的内容）。
    //
    //   补齐之后：落在露出带里 = 一步直接切卡，不做任何先期判断。
    //   ⚠ 冻结期照样尊重（cardSwitchFrozenUntil）—— 否则一记猛滚会一路翻穿整摞卡。
    //   ⚠ buriedCardAt() 在自由模式和折叠态自己就返回 -1，所以这里不用再判它们。
    if(performance.now() < cardSwitchFrozenUntil) return;
    e.preventDefault();
    switchMainCard(dir,'叠压带直通');
  }else if(overMain){
    // ⚠ 刚靠"攒光"切过卡 → 冻结一下。
    //   切走之后鼠标就落在普通二级上了，那儿是"滚一下切一张"，
    //   不冻的话一记猛滚的余势会直接把你从预设翻到生成(用户实测提的)。
    if(performance.now() < cardSwitchFrozenUntil) return;
    // ⚠⚠ 鼠标在预设二级上 → 那块有自己的"攒光"规则(见文件末尾的专用监听)，
    //   全局这条"滚一下切一张"【绝不能插手】。
    //   为什么用几何判断而不是靠事件冒泡兜底: 专用监听挂在 #presetZone 上，
    //   而 .zones.show 自己是 pointer-events:auto —— 容器本身也能当事件目标。
    //   只要事件因为任何原因没落在 #presetZone 身上(容器成了 target /
    //   命中了别的层 / .show 状态不同步)，就会漏到这里来一下切一张，
    //   表现就是"列表还没滚到底就翻页了"(2026-09-11 用户实测)。几何判断堵死这个洞。
    if(!freeCard && isPresetCard() && hitRect(mx,my, presetZoneKind==='prompt' ? promptZoneEl : presetZoneEl)) return;
    if(freeMode){e.preventDefault();window.V7FreeMode.cycleAtCurrent(dir,freeCard);}
    else switchMainCard(dir,'全局滚轮');
  }
  // 都不命中(鼠标在空白处) → 什么都不做
},{passive:false});

// ═══ 点被压住的卡的标题 → 连续翻到它（2026-09-14 用户要求）═══
//
// 叠压时下面那几张卡只露出最下面 34px 的标题带（docs/14 §5.5）。用户想点那条标题直接过去。
//
// ⚠ 为什么不能在卡上挂 click：
//   被压住的卡整卡 pointer-events:none（setStack 里按深度设的），
//   子元素还有 `#stack .block-card:not(.is-current) *{pointer-events:none !important}` 护栏 ——
//   两道都是为了"露出来的按钮不能被点到"，不能为了这个功能拆掉。
//   所以点击落在哪张卡上【自己算】：监听挂在 window 上（跟滚轮一个路数），
//   用每张卡的矩形做几何判断。露出带 = 卡的最下面 STEP 像素，且被上一张盖住的部分不算。
//
// ⭐ "连续翻动"而不是"一步跳到"：走 switchMainCard 一张一张翻，每张停 130ms。
//   这样中间那几张卡会依次滑过去，跟滚轮翻的是同一套动作语言（铁律：三层动画统一"整体滚动"）。
//   翻的方向按"哪边近"选：5 张卡里从 0 翻到 4，往上翻一步就到，不绕远。
//
// ⚠ 翻动期间再点/再滚都不接（jumpBusy），免得两条翻动叠在一起把 cur 翻乱。
let jumpBusy=false;
const JUMP_STEP_MS=130;
function jumpToCard(target, why){
  target=Number(target);
  const visible=layoutVisibleIndices();
  if(!Number.isFinite(target)||!visible.includes(target)||target===cur||jumpBusy) return;
  // 最短路：环形距离，正向(dir=1)走几步、反向走几步，取小的
  const from=visible.indexOf(cur),to=visible.indexOf(target),count=visible.length;
  const fwd=(to-from+count)%count, back=(from-to+count)%count;
  const dir=fwd<=back?1:-1;
  let steps=Math.min(fwd,back);
  jumpBusy=true;
  const tick=()=>{
    if(steps<=0||cur===target){ jumpBusy=false; return; }
    switchMainCard(dir, why||'点标题跳卡');
    steps--;
    if(steps>0&&cur!==target) setTimeout(tick, JUMP_STEP_MS);
    else jumpBusy=false;
  };
  tick();
}
// 点在哪张被压住的卡的露出带上。返回卡序号，没命中返回 -1。
// ⚠ 只认【露出带】：卡自身坐标 y ∈ [卡高-STEP, 卡高]，再被上一层盖掉的部分不算。
//   直接用 getBoundingClientRect —— 它已经含了 transform 位移和缩放，不用自己算 d*STEP。
function buriedCardAt(x, y){
  if(window.V7FreeMode?.isActive())return -1;
  if(isCollapsed) return -1;
  // 从浅到深找：浅的盖在深的上面，先命中的就是它
  const visible=layoutVisibleIndices(),currentPos=visible.indexOf(cur),order=[];
  for(let d=1; d<=stackVisibleDepth(visible.length); d++) order.push(visible[(currentPos+d+visible.length)%visible.length]);
  let coverBottom=null;                   // 上一张（更浅的）卡的下沿，它以上的部分被盖住
  const top=cards[cur]&&cards[cur].getBoundingClientRect();
  if(top) coverBottom=top.bottom;
  for(const i of order){
    const c=cards[i]; if(!c) continue;
    const r=c.getBoundingClientRect();
    if(!r.width||!r.height) continue;
    const bandTop=Math.max(r.bottom-STEP*UI_SCALE, coverBottom==null?r.top:coverBottom);
    if(x>=r.left&&x<=r.right&&y>=bandTop&&y<=r.bottom) return i;
    coverBottom=r.bottom;
  }
  return -1;
}
window.addEventListener('click', e=>{
  if(e.target.closest?.('.v7-floating-bar'))return;
  if(e.button!==0||jumpBusy||isCollapsed) return;
  if(v7OverlayOpen()) return;
  if(window.V7Workspaces?.hasEmbedded?.()){
    // A workspace can overlap the exposed bands of the main card pile.
    // Its controls own the click even when the same coordinates hit a buried
    // card. Use the dispatch path because a control may rebuild itself.
    if(e.composedPath().some(node=>node?.matches?.('.detail-card,.zones,.tasks,#errors,.v7-primary-nav,.v7-workspace')))return;
    const destination=buriedCardAt(e.clientX,e.clientY);
    if(destination>=0){e.preventDefault();e.stopImmediatePropagation();navigateCard(cards[destination].dataset.card,0).catch(error=>ERR.report('LAYOUT_FAILED',{message:String(error.message||error)}));}
    return;
  }
  if(document.getElementById('popupLock').classList.contains('on')) return;
  if(viewerOpen) return;
  if(window.UISelect&&UISelect.isOpen()) return;
  // 点在当前卡/二级/三级/任务/报错上的都不管 —— 那些有自己的点击逻辑
  const t=e.target;
  if(t.closest&&(t.closest('.block-card.is-current')||t.closest('.zones')||t.closest('.detail-card')||t.closest('.tasks')||t.closest('#errors')||t.closest('.popup-stack'))) return;
  const i=buriedCardAt(e.clientX, e.clientY);
  if(i<0) return;
  e.preventDefault(); e.stopPropagation();
  jumpToCard(i,'点标题「'+((cards[i]&&cards[i].dataset.bglabel)||i)+'」');
}, true);   // 捕获阶段：抢在 document 那条"点空白就 closeAll" 之前

// 切主卡。抽出来是因为预设二级有自己的滚轮监听(见下面)，两边必须走同一套。
// why = 谁切的。⚠ 只在预设列表可见时打日志 —— "还没滚到底就翻页"这类问题，
//   光看现象分不清是【攒光达标】还是【全局滚轮漏过来】干的，一行日志就分清了。
function switchMainCard(dir, why){
  if(window.V7FreeMode?.isActive()){window.V7FreeMode.cycleAtCurrent(dir);return;}
  const _pl = presetZoneEl && presetZoneEl.querySelector('.pz-list');
  if(_pl && _pl.clientHeight){
    const maxTop = Math.max(0, _pl.scrollHeight - _pl.clientHeight);
    const atEnd = dir>0 ? (_pl.scrollTop >= maxTop-1) : (_pl.scrollTop <= 0);
    const msg='[预设] 切主卡 ← '+(why||'?')+' | 方向'+(dir>0?'下':'上')
      +' 列表位置 '+Math.round(_pl.scrollTop)+'/'+Math.round(maxTop)
      +(atEnd?' 已到头':' ⚠ 没到头');
    console.log(msg);
    if(window.__TAURI__ && window.__TAURI__.core){
      window.__TAURI__.core.invoke('debug_log',{message:msg}).catch(()=>{});
    }
  }
  lastDir = dir;
  const visible=layoutVisibleIndices();
  if(visible.length){const pos=Math.max(0,visible.indexOf(cur));cur=visible[(pos+(dir>0?1:-1)+visible.length)%visible.length];}
  setStack();
  updateZoneBg(cur);                       // 区块切换 → zone 背景跟着换
  updateDetailBg();                        // ⚠ 三级也要跟着换! 漏了这句 → A/B 主卡的三级同色
  // 分区/详情开着 → 跟随过渡(带动画); 都没开 → 静默填内容, 保证下次弹出时是对的
  if(zoneOpen || detail.classList.contains('show')) syncZonesToCard(dir);
  else fillZonesNow();                     // ⚠ 兜底: 不开着也要把内容对上, 防旧内容残留
}

// ── 任务预览跟随切换: 与主卡二级同一套上下错落语言 ──
// 【防闪烁】不做"旧的关+新的开"(两个预览会同时 show, 且位置随任务卡重排而突变),
// 改为【原地换内容】: show 状态全程不变, 只把里面的图翻成新任务的。
function followPreview(dir){
  const newTask = topTaskEl();
  if(!newTask) return;
  const newPv = newTask.querySelector('.task-preview');
  const oldPv = document.querySelector('.task-preview.show');
  if(!newPv) return;

  const out = dir>0 ? -SHIFT_Z : SHIFT_Z;
  const inn = dir>0 ?  SHIFT_Z : -SHIFT_Z;

  // 新预览先无动画就位(不触发弹出动画), 旧的静默下线 —— 全程不闪
  if(oldPv && oldPv!==newPv){
    newPv.style.transition='none';
    newPv.classList.add('show');
    oldPv.classList.remove('show');
    requestAnimationFrame(()=>{ newPv.style.transition=''; });
  }else if(!oldPv){
    newPv.classList.add('show');
  }
  window.__pv=newPv;

  // 内容错落翻转(与主卡二级同一语言)
  // 任务卡自己的预览 DOM 已在数据更新时维护，滚轮切任务时不再整块重建。
  const strip=newPv.querySelector('.pv-strip');
  if(strip){
    strip.classList.add('pv-animating');
    clearTimeout(newPv._animTimer);
    newPv._animTimer=setTimeout(()=>strip.classList.remove('pv-animating'),260);
  }
  const cells=newPv.querySelectorAll('.pv-cell');
  cells.forEach((c,i)=>{
    c.style.transition='none';
    c.style.opacity='0'; c.style.transform='translateY('+inn+'px)';
  });
  requestAnimationFrame(()=>{
    cells.forEach((c,i)=>{
      c.style.transition='opacity .15s var(--ease-soft), transform .15s var(--ease-out)';
      setTimeout(()=>{ c.style.opacity='1'; c.style.transform='translateY(0)'; }, i*18);
    });
  });

  // ⭐⭐ 2026-10-04 用户实测报的 bug（docs/137 §9.2）：切任务卡时大预览框不更新。
  //
  //   真因：大框的"归属"只在【预览条第一次弹出】那一下设定（见上面 6919 那段的
  //     `if(!pvOpen)` 分支里的 hoverTaskCard）。**而切任务卡走的是本函数**，
  //     这里原来一次都没碰过 V7Tween（grep 0 处）。
  //   ⇒ 换了任务卡，大框还指着旧任务 → 缩略图滚不动、框里是旧图、
  //     要等鼠标离开整个连通区才收掉。用户看到的就是"不消失或者更新不及时"。
  //
  //   ⚠ 用 retarget 而不是 hoverTaskCard：
  //     hoverTaskCard 会 yieldMainCard() 去【收二级/三级面板】——
  //     滚一下任务就踹掉用户正在看的二级卡，那是新 bug。
  //     retarget 只改"框指向谁"，框没开就什么都不做。
  const curTask2 = newTask ? taskById(newTask.dataset.task) : null;
  if(curTask2 && window.V7Tween && typeof V7Tween.retarget==='function'){
    window.V7Tween.retarget(newTask, curTask2);
  }
}

// 分区/详情内容跟随当前主卡切换(交叉淡入, 与叠压动画同步)
const LINK_ZONE_SET=[['download','抓取测试','PS → 软件'],['upload','传回测试','软件 → PS'],['sparkles','生成测试','抓取 → 生成 → PS'],['sliders','控制 PS 测试','V6 原子操作']];
// ZONE_SETS 已上移到 zoneSlugOf 之前(2026-09-10) —— 理由见那里的注释。
// 验证期的分区定义保留在运行时层，供正式功能接入时复用；它们不再占用当前主卡。
const LOG_ZONE_SET=[['books','全部日志','所有方向'],['link','桥接日志','UI ↔ UXP'],['broom','清空日志','只清本地记录'],['arrowUpRight','导出日志','复制文本']];
// 2026-10-18：AI_ZONE_SET 跟 fillAiDetail 一起删了（只有它用）。
// ── 二级/三级换内容: 【上下方向】与主卡叠压同一语言, 方向跟滚轮绑定 ──
// 主卡是上下切换的, 所以它的下级也必须上下动 —— 左右动会跟主卡脱节。
// dir: 1=向下滚(主卡向上走) → 内容向上淡出、从下方推入; -1 反之。
const STAGGER=26;        // 错落间隔, 与叠压节奏同源
const SHIFT_Z=12;        // 二级位移量
let lastDir=1;

function linkImageSrc(data){
  if(!data) return '';
  if(typeof data==='string') return data.indexOf('data:')===0 ? data : 'data:image/png;base64,'+data;
  const b64=data.imageBase64||data.base64||'';
  return b64 ? (b64.indexOf('data:')===0 ? b64 : 'data:'+(data.mime||'image/png')+';base64,'+b64) : '';
}
function makeLinkPlaceholder(){
  const canvas=document.createElement('canvas'); canvas.width=256; canvas.height=256;
  const ctx=canvas.getContext('2d');
  const g=ctx.createLinearGradient(0,0,256,256); const 主题=getComputedStyle(document.documentElement); g.addColorStop(0, 主题.getPropertyValue('--accent').trim()||'#5aa9ff'); g.addColorStop(1, 'hsl('+((主题.getPropertyValue('--glow-detail').trim())||'275 100% 76%')+')');
  ctx.fillStyle=g; ctx.fillRect(0,0,256,256);
  ctx.fillStyle='rgba(255,255,255,.88)'; ctx.font='600 24px sans-serif'; ctx.textAlign='center'; ctx.fillText('V8 TEST',128,134);
  const src=canvas.toDataURL('image/png');
  return {imageBase64:src.split(',')[1],mime:'image/png',width:256,height:256};
}
function linkFormValue(id){ const el=document.getElementById(id); return el ? String(el.value||'').trim() : String(linkRuntime.form[id]||''); }
function linkParamsForAction(action){
  const f=linkRuntime.form;
  const ids=String(f.groupIds||'').split(',').map(v=>Number(v.trim())).filter(Number.isFinite);
  if(action==='ps.doc.select'||action==='activateDocument') return {docId:Number(f.docId)};
  if(action==='ps.doc.export') return {path:f.exportPath};
  if(action==='ps.selection.restore'||action==='restoreSelectionFromHistory') return {docId:Number(f.docId)||undefined,selection:linkRuntime.capture&&linkRuntime.capture.selection};
  if(action==='ps.selection.capture'||action==='ps.selection.captureRef'||action==='ps.selection.recaptureRef'||action==='captureRefImage'||action==='recaptureRefImage') return {allowFullCanvas:!!linkRuntime.autoFullCanvas,maxResolution:captureMaxEdge()};
  if(action==='captureForChat'||action==='ps.selection.captureForChat') return {allowFullCanvas:!!linkRuntime.autoFullCanvas,maxResolution:1024};
  if(action==='ps.selection.ops') return {operation:'clear'};
  if(action==='ps.marquee.sync'||action==='syncMarqueeAspect') return {aspect:f.aspect||'1:1'};
  if(action==='ps.layer.select'||action==='ps.layer.delete'||action==='ps.layer.gotoMask'||action==='gotoLayerMask') return {layerId:Number(f.layerId)||undefined,docId:Number(f.docId)||undefined};
  if(action==='ps.layer.create') return {name:f.layerName||'链路验证图层'};
  if(action==='ps.layer.rename') return {layerId:Number(f.layerId)||undefined,name:f.layerName||'链路验证结果'};
  if(action==='ps.layer.visibility') return {layerId:Number(f.layerId)||undefined,visible:!!f.visible};
  if(action==='ps.layer.opacity') return {layerId:Number(f.layerId)||undefined,opacity:Number(f.opacity)||100};
  if(action==='ps.layer.solo'||action==='soloLayer') return {layerId:Number(f.layerId)||undefined};
  if(action==='conversationLayerVisibility') return {mode:'solo',docId:Number(f.docId)||undefined,ownedLayerIds:ids,soloLayerId:Number(f.layerId)||undefined};
  if(action==='ps.layer.place') return {imageBase64:(linkRuntime.generated||linkRuntime.capture||makeLinkPlaceholder()).imageBase64,targetDocId:Number(f.docId)||undefined,targetSelection:linkRuntime.capture&&linkRuntime.capture.selection,layerType:'smartObject'};
  if(action==='ps.layer.placeBatch'){
    const image=linkRuntime.generated||linkRuntime.capture||makeLinkPlaceholder();
    return {targetDocId:Number(f.docId)||undefined,items:[{imageBase64:image.imageBase64,selection:linkRuntime.capture&&linkRuntime.capture.selection,layerType:'smartObject'}]};
  }
  if(action==='ps.group.create') return {layerIds:ids,groupName:f.groupName||'链路验证组'};
  if(action==='ps.mask.feather') return {docId:Number(f.docId)||undefined,layerId:Number(f.layerId)||undefined,selection:linkRuntime.capture&&linkRuntime.capture.selection};
  if(action==='ps.mask.magentaFix') return {groupName:f.groupName||'链路验证组'};
  if(action==='ps.channel.visibility') return {channelId:Number(f.channelId)||undefined,visible:!!f.visible};
  return {};
}
function runLinkCapture(after){
  return linkQueue('ps.selection.capture',{allowFullCanvas:!!linkRuntime.autoFullCanvas,maxResolution:captureMaxEdge()},{testKey:'capture',after});
}

