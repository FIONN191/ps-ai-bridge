// ═══ ui-main/05-errors-stack.js —— 主界面主程序第 5 / 21 段 ═══
//   管什么：报错堆 · 一键清 · 添加任务（入场动画）
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 报错堆: 独立于任务堆的卡片堆(主卡下方), 多条报错像任务堆一样叠压 ═══
// 报错卡按插入顺序叠压: index 0 = 最上(最新)。确认后消失 → 剩余重排。
// ⚠【动态位置】报错堆起点 = 主卡叠压边界 + 间距。任务堆在报错堆下方，根据报错数量动态错开。
const errorsEl = document.getElementById('errors');
let ecur = 0;                 // 当前报错卡索引(滚轮切换)

// 使用未受折叠动画影响的稳定布局尺寸，避免 getBoundingClientRect() 读到过渡中的压缩矩形。
function mainStackMetrics(){
  const anchor=document.querySelector('.anchor');
  const style=anchor ? getComputedStyle(anchor) : null;
  const left=style ? (parseFloat(style.left)||60) : 60;
  const top=style ? (parseFloat(style.top)||60) : 60;
  const scale=UI_SCALE;
  const height=400*scale;
  const step=STEP*scale;
  return {
    top,
    left,
    bottom:top+height,
    step,
    // 主卡堆与视觉保持一致：深层卡片仍可轮换，但不再为不可见的层预留空间。
    bottomWithStack:top+height + stackVisibleDepth(N)*step
  };
}

// 动态计算报错堆和任务堆的位置
function updateStackPositions(){
  const anchor = document.querySelector('.anchor');
  if(!anchor) return;
  if(window.V7FreeMode&&window.V7FreeMode.isActive()){
    setTasks();
    window.V7FreeMode.applyPositions();
    return;
  }
  const metrics=mainStackMetrics();
  // ⭐⭐ 2026-09-13 换序：主卡 → **任务堆** → **报错堆**（原来是报错堆在上）。
  //
  //   原因（用户反馈）：报错堆在上的话，**弹一张报错卡就把整个任务堆往下推** ——
  //   用户正要点任务卡上的按钮，按钮自己跑了。而报错卡恰恰最容易在
  //   "正在生成、用户盯着任务卡"的时候弹出来。
  //
  //   ⭐ 换序之后：**任务堆的位置只由主卡决定，报错来多少张都不动它**。
  //     代价是报错堆要往下让，可能被挤出窗口 —— 下面 setErrors 里有夹取。
  //
  //   ⚠ 层级关系【不变】：任务卡(z 高) 仍在报错卡(z 低) 上方。这里只动纵向位置。
  const taskHeights=[...tasksEl.querySelectorAll('.task:not(.leaving)')].map(el=>el.offsetHeight||150);
  const taskHeight=taskHeights.length?Math.max(...taskHeights):150;
  // 任务堆锚定在主卡堆之后；报错堆在 setErrors 中根据任务堆实际底部选择下方、上方或侧边。
  tasksEl.style.top = Math.max(8,Math.min(metrics.bottomWithStack+16,(window.innerHeight||1100)-taskHeight-6))+'px';
  tasksEl.style.left = metrics.left + 'px';
  // 拖动主卡或改变窗口大小后，任务露出层数也要重新计算。
  // setTasks 会在任务布局完成后刷新报错堆位置。
  setTasks();
}

// 任务堆往下伸多高（顶层卡高 + 叠压露出的部分）。没有任务卡时是 0。
// ⚠ 和报错堆那边的算法保持一致，改一个要改两个。
function taskStackExtent(){
  const els=[...tasksEl.querySelectorAll('.task')].filter(t=>!t.classList.contains('leaving'));
  const n=els.length;
  if(!n) return 0;
  let maxH=0;
  els.forEach(t=>{ const h=t.offsetHeight||150; if(h>maxH) maxH=h; });   // 150 是兜底
  return maxH + (taskVisibleCount(els) - 1) * STEP;
}
function setErrors(){
  const els = [...errorsEl.querySelectorAll('.error-card')];
  const n = els.length;

  // ── 报错堆起点 = 任务堆底部 + 间距（2026-09-13 换序后）──
  //   ⚠ 任务堆的 top 在 updateStackPositions 里已经定好了，这里【只读不写】。
  //     以前这个函数会反过来改 tasks.style.top，那正是"报错一弹任务卡就跑"的根源。
  const metrics = mainStackMetrics();
  const taskTop = parseFloat(tasksEl.style.top) || (metrics.bottomWithStack + 16);
  const tExtent = taskStackExtent();
  const taskBottom = taskTop + tExtent;
  const gap = 24;
  let errTop = taskBottom + (tExtent ? gap : 0);   // 没有任务卡就紧贴主卡堆
  let errLeft = metrics.left;

  // 报错堆整体避让任务堆与主卡可见堆；不能只看任务卡上方还有多少高度。
  const winW = window.innerWidth || 1020;
  const winH = window.innerHeight || 920;
  const errW = Math.max(300,...els.map(el=>el.offsetWidth||300));
  const errH = Math.max(0,...els.map(el=>el.offsetHeight||100)) || 100;
  const errExtent0 = errH + Math.max(0,Math.min(n,ERR_MAX_VISIBLE)-1)*ERR_STEP;
  // ⭐ 2026-10-22（第二批踩到）：超过 4 条时下面还有一颗「还有 N 条 · 展开」，它也是这个堆的一部分 ——
  //   以前没把它算进高度，按钮直接伸到堆的外面，被底部悬浮条（夏三六）盖住，点不到。
  const moreRoom = n > ERR_MAX_VISIBLE ? 32 : 0;
  const errExtent = errExtent0 + moreRoom;
  // ⭐ 底部悬浮条（夏三六 / 主导航）也是障碍物：它永远压在下面那一片，报错堆不能伸进去。
  const floating = [...document.querySelectorAll('.v7-agent-dock, #v7PrimaryNav.v7-floating-bar, .v7-floating-moving')]
    .filter(el => el.getBoundingClientRect().height > 0)
    .map(el => { const r = el.getBoundingClientRect(); return {left:r.left, top:r.top, right:r.right, bottom:r.bottom}; });
  // ⚠⚠ 2026-10-22 修：maxErrTop 原来只按窗口底部算（winH - 堆高 - 20），
  //   可 10-22 又把悬浮条加进了障碍物 —— 窗口 1100 高时悬浮条从 1004 起，
  //   报错堆放到 854（还在 982 以内）就已经压到它 ⇒ 每一个候选位置都判「放不下」，
  //   最后走兜底分支直接叠在任务卡上（实测：报错卡 576~748 和任务卡 578~762 完全重合）。
  //   现在上限取「窗口底部」和「悬浮条顶边」里更靠上的那个。
  const dockTop = floating.length ? Math.min(...floating.map(r => r.top)) : winH;
  const maxErrTop = Math.min(winH, dockTop - 12) - errExtent - 20;
  const mainW = Math.max(300,...cards.filter(el=>!el.hidden).map(el=>el.offsetWidth||300))*UI_SCALE;
  const mainBounds = {left:metrics.left,top:metrics.top,right:metrics.left+mainW,bottom:metrics.bottomWithStack};
  const taskLeft = parseFloat(tasksEl.style.left) || metrics.left;
  const taskW = Math.max(300,...[...tasksEl.querySelectorAll('.task:not(.leaving)')].map(el=>el.offsetWidth||300));
  const taskBounds = {left:taskLeft,top:taskTop,right:taskLeft+taskW,bottom:taskBottom};
  const obstacles = (tExtent ? [mainBounds,taskBounds] : [mainBounds]).concat(floating);
  const canPlace = ({left,top}) => left>=8 && left+errW<=winW-8 && top>=8 && top<=maxErrTop &&
    obstacles.every(rect=>left+errW<=rect.left || left>=rect.right || top+errExtent<=rect.top || top>=rect.bottom);
  errorsEl.classList.remove('layout-overlap-fallback');
  if (!canPlace({left:errLeft,top:errTop})) {
    // 下方放不下时先找左右侧列；上方/空隙候选也必须避开整块主卡可见堆。
    const sideTop = Math.max(8,Math.min(taskTop,maxErrTop));
    const sideRight = Math.max(...obstacles.map(rect=>rect.right))+32;
    const sideLeft = Math.min(...obstacles.map(rect=>rect.left))-errW-32;
    const dockTop = floating.length ? Math.min(...floating.map(r=>r.top)) : winH;
    const candidates = [
      {left:sideRight,top:sideTop},
      {left:sideLeft,top:sideTop},
      // ⚠ 2026-10-22 修：窗口窄、主卡又被拖到右边时，左边那一整列是空的，
      //   可候选里只有 sideLeft（= 最左边障碍物再往左 = 负坐标，永远过不了 left>=8）。
      //   实测 768 高、主卡 left=660：任务堆占 660~960、主卡堆也占 660~960，
      //   所有候选都判「压住」，只能走兜底叠在任务卡上（报错 576~748 / 任务 578~762 完全重合）。
      //   ⇒ 补最左边一列：贴着窗口左沿放，位置照样要过 canPlace（别的卡在那儿就不去）。
      {left:8,top:sideTop},
      {left:8,top:maxErrTop},
      {left:metrics.left,top:taskTop-errExtent-gap},
      {left:metrics.left,top:metrics.top-errExtent-gap},
      {left:metrics.left,top:metrics.bottomWithStack+gap},
      {left:metrics.left,top:dockTop-errExtent-12},
      {left:metrics.left,top:8},
      {left:metrics.left,top:maxErrTop}
    ];
    const position = candidates.find(canPlace);
    if (position) {
      errLeft = position.left;
      errTop = position.top;
    } else {
      // 窗口连一个独立报错堆都容不下时，保留既有可视区兜底。
      errTop = Math.max(8,Math.min(errTop,maxErrTop));
      errorsEl.classList.add('layout-overlap-fallback');
    }
  }
  if(!(window.V7FreeMode&&window.V7FreeMode.isActive())){
    errorsEl.style.top  = errTop + 'px';
    errorsEl.style.left = errLeft + 'px';
  }

  // ⭐⭐ 2026-10-14【"报错卡消失后参考图卡不往上靠"的根因，实测确认】——
  //   ⚠⚠ 下面第 6021 行有一句 `if(!n){ ...; return; }`：**没有报错卡时直接 return**。
  //     而参考图卡的重排原来只写在【函数末尾】⇒ 报错卡一关完（n===0）就从这儿走了，
  //     末尾那句永远跑不到 ⇒ 参考图卡停在"被推开"的旧位置不动。
  //   实测证据（改之前）：
  //     起点（无报错卡）      #refs transform = translate(0px, 0px)
  //     加一张报错卡          #refs transform = translate(0px, 112px)   ← 让位（对）
  //     关掉报错卡（等 3 秒） #refs transform = translate(0px, 112px)   ← 🔴 停在旧值
  //     手动调 reposition()   → translate(0px, 0px)                     ← 算法本来是好的
  //   用户的感受就是"它不动，我得点它一下它才往上动一下"。
  //   ⇒ 修法：把重排【挪到 return 之前】，保证 n===0 这条早退路径也走得到；
  //     函数末尾那次保留（n>0 时堆内部还有逐张叠压要算）。
  //   ⚠ 只加调用，不改算法 —— reposition() 里已经是"没有报错卡就 translate(0,0)"，
  //     避让算法不重复写第二份（两份必然漂移）。
  const refCardReposition = () => window.V7ReferenceCard?.reposition();

  if(!n){ ecur = 0; window.V7FreeMode?.syncSpecialUnit('errors'); window.V7FreeMode?.syncEmptyUnits(); refCardReposition(); return; }

  // A direct L3 confirmation is a decision surface, not a background notice.
  // Keep it at the visible top while it is waiting for the user's answer;
  // later L1/L2 notices stay in the same legacy stack underneath it.
  const directConfirmation = els.find(el => el.dataset.v7DirectConfirmation === '');
  if(directConfirmation) ecur = els.indexOf(directConfirmation);

  // 修正 ecur 边界
  if(ecur >= n) ecur = n - 1;
  if(ecur < 0) ecur = 0;

  const visible = Math.min(n, ERR_MAX_VISIBLE);
  els.forEach((e, i) => {
    const relIdx = (i - ecur + n) % n;      // 相对当前卡的偏移(0=当前, 1=下一张...)
    const clamped = Math.min(relIdx, visible - 1);
    // ⚠ z-index 层级：报错卡主层和主卡叠压层平齐，报错卡叠压层在主卡叠压层下方
    //   主卡范围 1~N (顶层=N, 最深=1)
    //   报错卡主层 = N-1 (和主卡第2层平齐)
    //   报错卡叠压层 < N-1 (在主卡叠压层下方)
    const baseZ = N - 1;  // 报错卡主层的 z-index
    e.style.zIndex = baseZ - relIdx;
    // ⭐ 同任务堆（2026-09-13）：不透明 + 靠阴影分层。报错卡更要看得清。
    e.style.opacity = 1;
    e.style.transform = 'translate(0, ' + (clamped * ERR_STEP) + 'px)';
    // ⚠ 同任务堆（2026-09-14）：压到最大深度之后看不见的卡不投影，否则阴影叠成一坨黑。
    const buried = relIdx > clamped;
    e.style.boxShadow = buried ? 'none' : clamped > 0
      ? '0 -6px 18px rgba(0,0,0,.42), 0 10px 28px rgba(0,0,0,.22)'
      : '0 18px 50px rgba(0,0,0,.45)';
    e.style.pointerEvents = (relIdx===0) ? 'auto' : 'none';   // 只有当前能点
    // 2026-10-22（docs/263 第 13 条）：压在下面的不算毛玻璃（样式见 04-tasks.css .stack-under）
    e.classList.toggle('stack-under', relIdx>0);

    // 详情层跟着报错卡一起叠压
    const detailEl = e._detailEl;
    if(detailEl){
      detailEl.style.zIndex = baseZ - relIdx + 1;  // 详情层比报错卡高一层
      detailEl.style.transform = 'translate(0, ' + (clamped * ERR_STEP) + 'px)';
      // 只有顶层报错卡的详情层可以显示
      if(relIdx !== 0 && detailEl.classList.contains('show') && e.dataset.v7DirectConfirmation !== ''){
        detailEl.classList.remove('show');
      }
    }
  });
  if(window.V7FreeMode&&window.V7FreeMode.isActive())window.V7FreeMode.syncSpecialUnit('errors');
  // ⭐ 2026-10-22（docs/263 §2「报错堆只露 4 张」）：超过 ERR_MAX_VISIBLE 的那些以前就这么【消失了】——
  //   用户只看到 4 条，以为只有 4 个问题。这里在堆的最下面标一句「还有 N 条」。
  // ⭐ 2026-10-22 第二批（对照台第 4 条，用户拍板「实装」）：它是个按钮，点开列出全部报错的标题 ——
  //   点某一条 = 把它翻到最上面；右边 × = 按这张卡自己的安全方式关掉（_v7clear：要你决定的卡当「取消」）。
  //   ⚠ 位置要放在【最后一张卡的底边下面】：卡高 100，第一版写成 visible*ERR_STEP(=96) 被压在卡底下，看不见。
  {
    const hidden = Math.max(0, n - visible);
    let more = errorsEl.querySelector('.errors-more');
    let list = errorsEl.querySelector('.errors-more-list');
    if (!hidden) { if (more) more.remove(); if (list) list.remove(); errMoreOpen = false; }
    else {
      if (!more) {
        more = document.createElement('button');
        more.type = 'button';
        more.className = 'errors-more';
        more.addEventListener('click', ev => { ev.stopPropagation(); errMoreOpen = !errMoreOpen; setErrors(); });
        errorsEl.appendChild(more);
      }
      const cardH = Math.max(0, ...els.map(el => el.offsetHeight || 100)) || 100;
      const top = (visible - 1) * ERR_STEP + cardH + 6;
      more.style.top = top + 'px';
      more.innerHTML = '还有 ' + hidden + ' 条 · ' + (errMoreOpen ? '收起' : '展开');
      more.setAttribute('aria-expanded', errMoreOpen ? 'true' : 'false');
      if (!errMoreOpen) { if (list) list.remove(); }
      else {
        if (!list) { list = document.createElement('div'); list.className = 'errors-more-list'; list.setAttribute('role', 'list'); errorsEl.appendChild(list); }
        list.style.top = (top + 28) + 'px';
        list.replaceChildren();
        // 从当前最上面那张开始往下列，跟堆里的顺序一致
        for (let k = 0; k < n; k++) {
          const card = els[(ecur + k) % n];
          const row = document.createElement('div');
          row.className = 'errors-more-row' + (k === 0 ? ' is-top' : '');
          row.setAttribute('role', 'listitem');
          const go = document.createElement('button');
          go.type = 'button'; go.className = 'errors-more-go';
          go.textContent = (card.querySelector('.ec-title')?.textContent || '提示').trim();
          go.title = (card.querySelector('.ec-desc')?.textContent || go.textContent).trim();
          go.addEventListener('click', ev => { ev.stopPropagation(); ecur = els.indexOf(card); errMoreOpen = false; setErrors(); });
          const x = document.createElement('button');
          x.type = 'button'; x.className = 'errors-more-x'; x.setAttribute('aria-label', '关掉这条');
          x.innerHTML = window.ICON ? ICON.render('close', 12) : '×';
          x.addEventListener('click', ev => { ev.stopPropagation(); if (typeof card._v7clear === 'function') card._v7clear(); else card.remove(); });
          row.append(go, x);
          list.appendChild(row);
        }
      }
    }
  }
  window.V7FreeMode?.syncEmptyUnits();
  // ⭐ 这里【不再碰任务堆】（2026-09-13）。
  //   以前这段会把 tasks.style.top 推到"报错堆底部 + 24"，
  //   于是每弹一张报错卡，任务卡就往下跳一次 —— 用户正要点的按钮自己跑了。
  //   现在任务堆的位置只由主卡决定（见 updateStackPositions），报错堆往下让。
  // ⭐ 2026-10-13：参考图卡跟在报错堆下面（用户定"报错来了参考图让位"）。
  //   ⚠ 只加这一行调用 —— 避让算法不重复写一份（两份必然漂移）。
  //   ⚠⚠ 2026-10-14：这一句【单独不够】—— 上面 n===0 那条早退路径也必须有（见 6021 行上方注释）。
  refCardReposition();
  stackTrashSync('errors');   // 2026-10-18 深夜：垃圾桶挪到当前最上面那张卡上
}

// 取当前 ecur 对应的报错卡 DOM(报错堆是动态增删的)
function topErrorEl(){
  const els = [...errorsEl.querySelectorAll('.error-card')];
  if(!els.length) return null;
  return els[Math.min(ecur, els.length - 1)];
}

// ⚠ 报错堆在主卡下方、任务堆上方, 高度有限。报错多了报错堆往下伸会和任务堆重叠。
//   简单处理: 报错堆出现/消失时, 任务堆动态上移/下移错开 — 但用户要"两堆互不推挤"。
//   ⚠ 为防重叠, 报错堆叠压深度用更小的步长(报错卡更高, 露边更少), 且最多叠 3 层。
function addErrorCard(o={}){
  // o: { severity:'L1'|'L2'|'L3'|'L4', level:'ok'|'info'|'warn'|'err', title, body,
  //      detail, confirm, cancel, danger, blocking, duration, onConfirm, onCancel }
  if(!errorsEl) return;
  const lv = SEM_ICO[o.level] ? o.level : 'info';
  const severity=resolveErrorSeverity(o);
  const isL1 = severity==='L1';
  // L4 不进入报错堆，直接创建显示器级冻结窗口。
  if(severity==='L4') return openL4Window(o);

  // 报错卡: 显示图标 + 标题 + 简短描述
  const e = document.createElement('div');
  e.className = 'error-card ec-'+severity.toLowerCase();
  e.dataset.severity=severity;
  e.dataset.level=lv;
  let html = '';

  if(isL1){
    // L1 胶囊: 图标 + 文字横排一行
    html += '<div class="ec-header">';
    html += '<span class="ec-ico '+lv+'">'+(window.ICON?ICON.render(SEM_ICO[lv],20):SEM_ICO[lv])+'</span>';
    html += '<span class="ec-title">'+escapeHtml(o.title||o.body||'提示')+'</span>';
    // ⭐ 2026-10-22（docs/263 第 6 条「删除改成能撤销」）：胶囊右边可以带一个操作按钮（「撤销」）。
    //   用 o.action = { label, run }；点了先跑 run 再收卡。见下面 offerUndo()。
    if(o.action && typeof o.action.run==='function'){
      html += '<button type="button" class="ec-action" data-ec-action>'+escapeHtml(o.action.label||'撤销')+'</button>';
    }
    html += '</div>';
  } else {
    // L2/L3/L4: 图标 + 标题在同一行, 描述在下方
    html += '<div class="ec-header">';
    html += '<span class="ec-ico '+lv+'">'+(window.ICON?ICON.render(SEM_ICO[lv],20):SEM_ICO[lv])+'</span>';
    html += '<span class="ec-title">'+escapeHtml(o.title||'提示')+'</span>';
    html += '</div>';
    if(o.body && !o.bodyNode){
      html += '<div class="ec-desc">'+escapeHtml(o.body)+'</div>';
    }
  }
  // 添加光效元素(完全仿照任务卡), 统一放入圆角裁切层
  html += '<div class="error-light-clip">';
  html += '<div class="error-glow"></div>';
  html += '<div class="error-bright"></div>';
  html += '<div class="error-edgehint"></div>';
  html += '</div>';
  e.innerHTML = html;
  // ⭐ 2026-10-15（公告要用）：o.bodyNode = 调用方用 textContent 建好的正文节点（富文本公告）。
  //   ⚠ 只收 DOM 节点、不收 HTML 字符串 —— 公告正文来自公开接口，不许走 innerHTML。
  //   带它的卡用 .ec-rich 变高（最高约 240，超出在卡内滚，见 .error-card.ec-rich 样式）。
  if(!isL1 && o.bodyNode && typeof o.bodyNode==='object' && o.bodyNode.nodeType===1){
    const desc=document.createElement('div');
    desc.className='ec-desc ec-rich-body';
    desc.append(o.bodyNode);
    e.querySelector('.ec-header')?.after(desc);
    e.classList.add('ec-rich');
  }
  // ⭐ 2026-10-15（用户定「公告在报错卡片的最顶层」）：钉顶卡。见下面插入那段。
  if(o.pin==='top') e.dataset.pinTop='';
  if(window.BG && window.BG.applyErrorToCard) window.BG.applyErrorToCard(e, severity);

  // 报错详情层: 独立的弹出层(向右滑动显示)
  let detailEl = null;
  if(!isL1 && (o.detail || o.confirm!==false)){
    detailEl = document.createElement('div');
    detailEl.className = 'error-detail';
    let detailHtml = '';

    // 详细信息
    if(o.detail){
      detailHtml += '<div class="ed-body">'+escapeHtml(o.detail)+'</div>';
    }

    // 按钮行
    if(o.confirm!==false){
      detailHtml += '<div class="ed-btns">';
      // ⭐ 2026-10-14 新增（公告要用）：调用方可以给一组【自己的按钮】。
      //   o.actions = [{ key:'settings', label:'到设置里看完整公告', primary:false }]
      //   ⚠ 跟 confirm/cancel 的区别：这些按钮【按了不关卡片】——
      //     它们只是"去做另一件事"（比如跳到设置卡），用户回来还得能点"我已知晓"。
      //     所以下面绑定时不能走 close()。
      //   ⚠ 老调用方不传 o.actions，行为一个字不变。
      if(Array.isArray(o.actions)){
        o.actions.forEach(a=>{
          if(!a||!a.key||!a.label) return;
          detailHtml += '<button class="ed-btn'+(a.primary?' primary':'')+'" data-custom="'+escapeHtml(a.key)+'">'+escapeHtml(a.label)+'</button>';
        });
      }
      // ⭐ 2026-10-18 深夜（用户定：L2 / L3 报错卡加「反馈这个问题」，自动带上错误码和当时情况）。
      //   只给 ERR.report 出来的【真报错】（带 code、level 是 err / warn）；公告（钉顶）不给；
      //   L3 只给「只是告诉你」的那种 —— 要你做决定的（带 onConfirm / onCancel）不给，免得点了反馈等于替你做了决定。
      const canFeedback=!!(window.V7Feedback&&o.code&&o.pin!=='top'&&(lv==='err'||lv==='warn')
        &&(severity==='L2'||(severity==='L3'&&!o.onConfirm&&!o.onCancel)));
      if(canFeedback) detailHtml += '<button class="ed-btn" data-feedback-error>反馈这个问题</button>';
      // ⭐ 2026-10-22（docs/263 §2「报错卡上没有重试」）：调用方传了 o.retry 就给一个「重试」主按钮。
      //   以前报错卡只有「知道了」—— 提示里写着「稍后再点一次传回」，可那个按钮在另一张卡上。
      //   ⚠ 传了 retry 就不再给「确定」：两个主按钮等于没有主按钮（用户不知道该点哪个）。
      if(typeof o.retry==='function'){
        detailHtml += '<button class="ed-btn primary" data-retry>'+escapeHtml(o.retryLabel||'重试')+'</button>';
      }
      // ⭐ 2026-10-24（V7待办/08「插件需要更新」）：o.persistent = 关不掉的常驻卡 —— 只留自己的按钮，
      //   没有「取消 / 知道了」，垃圾桶一键清也跳过它；由调用方在事情解决后用返回的 close() 收掉。
      if(o.cancel!==false && !o.persistent){
        detailHtml += '<button class="ed-btn" data-a="cancel">'+escapeHtml(o.cancel||'取消')+'</button>';
      }
      if(typeof o.retry!=='function' && !o.persistent){
        detailHtml += '<button class="ed-btn '+(o.danger?'danger':'primary')+'" data-a="confirm">'+escapeHtml(o.confirm||'确定')+'</button>';
      }
      detailHtml += '</div>';
    }

    detailEl.innerHTML = detailHtml;
    e._detailEl = detailEl;  // 关联详情层

    // 绑定按钮事件
    const btns = detailEl.querySelectorAll('[data-a]');
    btns.forEach(btn=>{
      btn.addEventListener('click', ev=>{
        ev.stopPropagation();
        const a = btn.dataset.a;
        try{
          if(a==='confirm' && o.onConfirm) o.onConfirm();
          if(a==='cancel' && o.onCancel) o.onCancel();
        } finally { close(); }
      });
    });
    // ⭐ 自定义按钮（2026-10-14）：按了【不关卡片】—— 只是去做另一件事。
    //   ⚠ 这里刻意不调 close()：公告那张卡上，用户点了"到设置里看完整公告"
    //     跳走再回来，还得能点"我已知晓"；卡片自己没了就等于没确认过。
    detailEl.querySelectorAll('[data-custom]').forEach(btn=>{
      btn.addEventListener('click', ev=>{
        ev.stopPropagation();
        const key = btn.dataset.custom;
        const item = Array.isArray(o.actions) ? o.actions.find(x=>x && x.key===key) : null;
        try{ if(item && typeof item.run==='function') item.run(); }
        catch(error){ if(window.ERR) ERR.report('UI_ACTION_FAILED',{message:String(error&&error.message||error)}); }
      });
    });
    // ⭐ 2026-10-22：重试按钮 —— 先收掉卡片再执行（重试往往会弹新卡，旧卡留着会叠两层），
    //   执行里的异常照「自定义按钮」那套兜住，不能因为重试失败把整个报错堆搞崩。
    const retryBtn=detailEl.querySelector('[data-retry]');
    if(retryBtn) retryBtn.addEventListener('click', ev=>{
      ev.stopPropagation();
      close();
      try{ o.retry(); }
      catch(error){ if(window.ERR) ERR.report('UI_ACTION_FAILED',{message:'重试没发出去：'+String(error&&error.message||error)}); }
    });
    // 「反馈这个问题」：L2 卡留着（跟自定义按钮一样，只是去做另一件事）；L3 卡先收掉 —— 它开着时界面只认它，反馈卡打不开
    const fbBtn=detailEl.querySelector('[data-feedback-error]');
    if(fbBtn) fbBtn.addEventListener('click', ev=>{
      ev.stopPropagation();
      const info={code:o.code,level:severity,title:o.title,body:o.body,detail:o.detail};
      if(severity==='L3') close();
      try{ window.V7Feedback.fromError(info); }
      catch(error){ if(window.ERR) ERR.report('UI_ACTION_FAILED',{message:'打开问题反馈失败：'+String(error&&error.message||error)}); }
    });
  }

  // L4 冻结遮罩用计数管理，多个 L4 同时存在时关闭其中一个不会提前解锁。
  const isBlocking=severity==='L4' || !!o.blocking;
  if(isBlocking){ blockingCount++; syncBlockingLock(); }

  // 入场: 从主卡下分离(跟任务卡进场同款)
  e.style.opacity='0'; e.style.transform='translateY(-46px) scaleY(.86) scaleX(.97)';
  // ⭐ 2026-10-15 钉顶：已经有钉顶卡（启动公告 / 连不上服务器）时，后来的普通卡插在它【下面】，
  //   钉顶卡一直是堆顶那张，直到用户点掉它。新的钉顶卡照常插最上面。
  // ⭐⭐ 2026-10-18 深夜（用户实测界面假死）：报错堆从上到下固定排成 ① 要你决定的卡（L3）② 钉顶的卡（公告）③ 其余。
  //   原来钉顶的公告永远在最上面，新弹的 L3 决定卡插在它下面 —— L3 一出来就把界面冻住、只认它（V7FocusScope），
  //   可它被公告压着点不到，界面就死了（例：公告没点「已知晓」时，Agent 测试连接要「同意」那张卡）。
  if(severity==='L3') e.dataset.decision='';
  const lastOf=sel=>[...errorsEl.querySelectorAll(':scope > .error-card'+sel)].pop();
  const after=severity==='L3'?null:o.pin==='top'?lastOf('[data-decision]'):(lastOf('[data-pin-top]')||lastOf('[data-decision]'));
  const anchor=after?after.nextSibling:errorsEl.firstChild;
  errorsEl.insertBefore(e, anchor);   // 插到堆顶(index 0 = 最上)；有钉顶卡就插在它后面
  if(detailEl){
    errorsEl.insertBefore(detailEl, e);  // 详情层紧挨着插在卡片前面（跟原来插 firstChild 的相对顺序一致）
  }
  // ⭐ 2026-10-06 晚：非模态动作卡可以直接把详情层摊开（引擎离线那种）。
  //   ⚠ 摊开 ≠ 注册：不进 directConfirmations、不触发 V7FocusScope 的背景隔离，
  //     全局鼠标手势（含任务卡右滑）照常可用。L3 注册卡仍由 registerConfirmation 摊开。
  if(detailEl && o.expand){ detailEl.classList.add('show'); window.__errDetail=detailEl; }
  // ⭐⭐ 2026-10-22（P0：用户报「黄色的报错框无法点按」）：
  //   详情层（里面有「重试 / 知道了」）以前【只能】靠鼠标从卡片往右「推进」才弹（07-wheel-routing.js 里的手势）。
  //   触控板 / 没推动 / 卡片被压在别的层下时，用户看到的就是一张写着「点重试」却点不动的卡 —— 界面完全卡死。
  //   ⇒ 卡片本体加【点击展开】：点卡片 = 展开详情（按钮就出来了）；点第二下 = 收起。
  //   ⚠ 只认真正的点击：拖拽（卡片能拖）/ 横向推进手势都不该触发，所以判位移。
  //   ⚠ 只有堆顶那张能点（setErrors 里 pointerEvents 已按 relIdx 设，这里再加一道兜底）。
  if(detailEl){
    let downX=0, downY=0, downT=0;
    e.addEventListener('pointerdown', ev=>{ downX=ev.clientX; downY=ev.clientY; downT=Date.now(); });
    e.addEventListener('click', ev=>{
      if(Math.abs(ev.clientX-downX)>4 || Math.abs(ev.clientY-downY)>4) return;   // 拖着走的不算点击
      if(Date.now()-downT>600) return;                                          // 按住不放的不算
      if(ev.target.closest && ev.target.closest('button,[data-ec-action]')) return;
      if(detailEl.classList.contains('show')){ detailEl.classList.remove('show'); if(window.__errDetail===detailEl) window.__errDetail=null; }
      else { detailEl.classList.add('show'); window.__errDetail=detailEl; }
    });
  }
  ecur = 0;  // 新报错卡插入后, 当前索引归零(显示最新的)
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    e.style.transition='opacity .22s var(--ease-soft), transform .28s var(--ease-out)';
    e.style.opacity='1'; e.style.transform='translateY(0) scale(1)';
    setErrors();   // 立即叠压所有报错卡
    // 动画完成后再次调用，确保高度计算准确
    setTimeout(()=>setErrors(), 300);
  }));

  // 关闭逻辑
  let closed=false;
  // ⚠ 2026-10-22：改成 let —— L1 的自动消失要在 close 外面包一层清计时器（见下面 L1 那段）
  let close=()=>{
    if(closed) return;
    closed=true;
    if(severity==='L3' && window.V7FocusScope?.unregisterConfirmation){
      window.V7FocusScope.unregisterConfirmation(e);
    }
    // L4 清理冻结遮罩
    if(isBlocking){ blockingCount=Math.max(0, blockingCount-1); syncBlockingLock(); }
    // 隐藏详情层
    if(detailEl && detailEl.classList.contains('show')){
      detailEl.classList.remove('show');
    }
    // 卡片出场动画
    e.style.transition='opacity .2s var(--ease-soft), transform .22s var(--ease-out)';
    e.style.opacity='0'; e.style.transform='translateY(16px) scale(.97)';
    setTimeout(()=>{
      e.remove();
      if(detailEl) detailEl.remove();
      setErrors();      // 剩余报错重排, 堆自动上移
    }, 240);
  };

  // L1 自动消失
  // ⭐ 2026-10-22：胶囊上的操作按钮（撤销）
  if(isL1 && o.action && typeof o.action.run==='function'){
    const actBtn=e.querySelector('[data-ec-action]');
    if(actBtn) actBtn.addEventListener('click', ev=>{
      ev.preventDefault(); ev.stopPropagation();
      if(closed) return;
      try{ o.action.run(); }
      catch(error){ console.warn('[提示卡] 操作按钮出错', error); }
      close();
    });
  }
  // ⭐ 2026-10-22（docs/263 §2「提示固定 3 秒」）：以前写死 3000ms，85 处调用都没传时长 ——
  //   28 个字的提示 3 秒读不完就没了。现在按字数算：基础 2 秒 + 每 10 个字 1 秒，上限 8 秒。
  //   调用方显式传了 duration 的照旧听它的（有些提示就是要短）。
  //   ⚠ 悬停暂停：鼠标停在上面就不走，移开后再给 1 秒 —— 用户正在读的时候不能消失。
  if(isL1){
    const textForLength=String(o.title||'')+String(o.body||'');
    const autoMs=Math.min(8000, 2000 + Math.ceil([...textForLength].length/10)*1000);
    const duration=Number.isFinite(Number(o.duration)) && Number(o.duration)>0 ? Number(o.duration) : autoMs;
    let remaining=duration, timer=null, startedAt=0;
    const start=()=>{ startedAt=Date.now(); timer=setTimeout(close, remaining); };
    const pause=()=>{ if(!timer) return; clearTimeout(timer); timer=null; remaining=Math.max(0, remaining-(Date.now()-startedAt)); };
    const resume=()=>{ if(timer) return; start(); };
    start();
    e.addEventListener('mouseenter', pause);
    e.addEventListener('mouseleave', resume);
    // 关闭时清掉计时器，别让它在卡已经移除后再跑一次
    const origClose=close;
    close=()=>{ if(timer){clearTimeout(timer);timer=null;} origClose(); };
  }

  // ⭐ 2026-10-18 深夜：报错卡垃圾桶一键清（clearAllErrorCards）按这张卡的「安全选项」收掉 ——
  //   用户定：L3 要你决定的卡当作「取消」（不替用户做决定）；取消是危险操作的卡（退出软件 / 放弃任务）调用方传 safeClear:'none' 只收不选；
  //   公告传 safeClear:'confirm'（清掉 = 已读，不再弹）。其余只收起。
  if(o.persistent) e.dataset.persistent='';
  e._v7clear=()=>{
    if(closed || o.persistent) return;
    const how=o.safeClear||(severity==='L3'?'cancel':'none');
    try{
      if(how==='confirm'&&o.onConfirm) o.onConfirm();
      else if(how==='cancel'&&o.onCancel) o.onCancel();
    }catch(error){ console.warn('[报错卡] 一键清时回调出错', error); }
    close();
  };
  return { close, el: e, detailEl };
}

// ═══ 删了能撤销（2026-10-22，docs/263 第 6 条，用户在对照台拍板「实装」）════════════
//   以前 63 处删除里 40 处点了直接没、23 处弹确认框（点多了大家闭眼点「确定」）。
//   现在普通删除：先删（立刻生效），底部弹一条「已删除「X」 撤销」，6 秒内点撤销就放回去。
//   ⚠ 只给「放得回去」的删除用（列表里的一条数据）；真删文件 / 清空全部这种回不来的，照旧用确认框。
//   用法：V7Undo.offer('已删除「基础修脸」', () => { 把它放回去 });
function offerUndo(title, undo, opts){
  if(typeof undo!=='function') return null;
  const o=opts||{};
  let done=false;
  const run=()=>{ if(done) return; done=true; undo(); };
  const duration=Number(o.duration)||6000;
  // ⚠ 在模态弹窗里删的（项目日程、布局管理……）要传 host = 弹窗元素：
  //   弹窗开着时 focus-scope 会把弹窗外面全部 inert，底部报错堆里的「撤销」点不到。
  //   ⇒ 这种情况把撤销条挂在弹窗自己底部（sticky）。⚠ host 要选【不会被重画】的那层（别选 innerHTML 会整块换掉的内容区）。
  if(o.host && o.host.isConnected){
    o.host.querySelectorAll(':scope > .v7-undo-inline').forEach(x=>x.remove());
    const bar=document.createElement('div');
    bar.className='v7-undo-inline'; bar.setAttribute('role','status');
    bar.innerHTML='<span>'+escapeHtml(String(title||'已删除'))+'</span><button type="button">'+escapeHtml(o.label||'撤销')+'</button>';
    const timer=setTimeout(()=>bar.remove(), duration);
    bar.querySelector('button').addEventListener('click', ev=>{
      ev.preventDefault(); ev.stopPropagation(); clearTimeout(timer); bar.remove();
      try{ run(); }catch(error){ console.warn('[撤销] 出错', error); }
    });
    o.host.appendChild(bar);
    return { close:()=>{ clearTimeout(timer); bar.remove(); }, el:bar };
  }
  return addErrorCard({
    severity:'L1', level:'info', title:String(title||'已删除'),
    duration,
    action:{ label:o.label||'撤销', run }
  });
}
window.V7Undo={ offer:offerUndo };

// 初始化报错堆和任务堆位置
// ═══ 一键清（2026-10-18 深夜，用户定）══════════════════════════════
//  「报错卡片比较频繁，包括任务卡也是。希望有一个高优先级的、能一键清除所有任务卡片和报错卡片」：
//   · 报错堆最上面那张卡的左上角一个垃圾桶 → 强制清 L1~L3 全部（L4 是单独的全屏窗口，不在这里）。
//     每张按自己的「安全选项」收（addErrorCard 的 e._v7clear）：L3 要你决定的当作「取消」；公告算已读；
//     取消是危险操作的卡（退出软件 / 放弃任务）只收不选。
//   · 任务堆最上面那张卡的左上角同样一个 → 只清【已经结束的】（完成 / 失败 / 取消），还在生成的留着；
//     走跟任务卡 ✕ 同一条路（cacheSetTaskbar(false) + removeTask），图都还在「记录与恢复」里。
//   ⚠ 垃圾桶是一个按钮，每次重排（setErrors / setTasks 末尾）挪到当前最上面那张卡上。
var STACK_TRASH_SVG='<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
var stackTrash={errors:null,tasks:null};   // ⚠ var 不用 const：setErrors / setTasks 在加载早期就会被调，const 还没到那一行会直接抛错
function clearAllErrorCards(){
  const cards=[...errorsEl.querySelectorAll(':scope > .error-card')];
  // 先清要你决定的（它们一走，界面立刻解冻），再清别的
  cards.sort((a,b)=>(b.hasAttribute('data-decision')?1:0)-(a.hasAttribute('data-decision')?1:0));
  let n=0;
  // 常驻卡（插件需要更新）一键清也不收 —— 用户定「关不掉，更新完才消失」
  cards.forEach(card=>{ if(card.hasAttribute('data-persistent')) return; if(typeof card._v7clear==='function'){ card._v7clear(); n++; } else { card.remove(); n++; } });
  // 卡片自己的 close 有 240ms 动画；兜底再排一次
  setTimeout(()=>{ errorsEl.querySelectorAll(':scope > .error-detail').forEach(d=>{ if(!d.nextElementSibling||!d.nextElementSibling.classList.contains('error-card'))d.remove(); }); setErrors(); },320);
  return n;
}
function clearFinishedTasks(){
  const done=taskList.filter(t=>t&&aiTaskIsTerminal(t));
  done.forEach(t=>{ try{ cacheSetTaskbar(t,false); }catch(_){} removeTask(t.id); });
  return done.length;
}
function stackTrashSync(kind){
  const host=kind==='errors'?errorsEl:tasksEl;
  if(!host||!stackTrash) return;
  const items=kind==='errors'
    ?[...host.querySelectorAll(':scope > .error-card')].filter(el=>el.style.opacity!=='0')
    :[...host.querySelectorAll(':scope > .task:not(.leaving)')];
  const cur=kind==='errors'?ecur:tcur;
  const top=items[cur]||items[0]||null;
  const want=!!top&&(kind==='errors'||taskList.some(t=>t&&aiTaskIsTerminal(t)));
  let btn=stackTrash[kind];
  if(!want){ if(btn) btn.remove(); return; }
  if(!btn){
    btn=document.createElement('button');
    btn.type='button';btn.className='v7-stack-trash';btn.dataset.stackTrash=kind;btn.innerHTML=STACK_TRASH_SVG;
    btn.title=kind==='errors'?'清掉全部报错卡（要你决定的当作「取消」；公告算已读）':'清掉所有已经结束的任务卡（还在生成的留着；图都在「记录与恢复」里）';
    btn.setAttribute('aria-label',kind==='errors'?'清掉全部报错卡':'清掉已结束的任务卡');
    // ⚠ 吃掉按下 / 点击：不然会连带触发卡片自己的展开、拖动、右滑
    ['pointerdown','mousedown'].forEach(t=>btn.addEventListener(t,ev=>ev.stopPropagation()));
    btn.addEventListener('click',ev=>{
      ev.preventDefault();ev.stopPropagation();
      // ⚠ 不弹「清掉了 N 张」：提示本身也是报错堆里的一张卡，刚清完又冒一张（10-18 深夜实测）
      if(kind==='errors')clearAllErrorCards();else clearFinishedTasks();
    });
    stackTrash[kind]=btn;
  }
  if(btn.parentElement!==top) top.appendChild(btn);
}
updateStackPositions();
// 窗口大小变化时重新计算位置
window.addEventListener('resize', () => {
  updateStackPositions();
});

// ── 添加任务(入场动画 + 成功反馈) ──
function addTask(task){
  taskList.unshift(task);                 // 新任务放数组头 = 堆叠顶部
  const el = renderTaskEl(task);
  tasksEl.insertBefore(el, tasksEl.firstChild);
  tcur = 0;                               // 视图切到新任务
  buildPreview(el, task);
  // ⚠ 必须调一次：renderTaskEl 里那行操作行是【裸 HTML 没有事件】的，
  //   绑定统一在 syncTaskActions 里做（以前绑在 buildPreview 里，重画后就丢了）。
  syncTaskActions(el, task);

  // 入场: 起点在主卡下方(被遮住), 滑出到位
  el.classList.add('entering');
  setTasks();
  el.addEventListener('animationend', function onEnd(){
    el.removeEventListener('animationend', onEnd);
    el.classList.remove('entering');
    el.classList.add('flash');            // 添加成功反馈: 描边闪一下
    setTimeout(() => el.classList.remove('flash'), 620);
    setTasks();                           // 动画结束后接管 transform
  }, { once: true });

  // 到点自动消失
  if(Number(task.life)>0) task.timer = setTimeout(() => removeTask(task.id), task.life);
  // ⚠ 任务栏变了，记录卡里"在不在任务栏"的状态也要跟着变。
  //   （原来是 renderHistoryCardFace → 白扫整个缓存目录，2026-09-30 删掉；
  //     记录卡本来就是事件驱动的，广播一下它自己会重读。）
  // ⭐ 记录与恢复卡（2026-09-30）：点下计算【那一刻】就要出现在记录里，
  //   状态是「生成中」。用户的原话是"点下计算整张画布立刻出现在一级和二级"，
  //   所以这里不能等算完才写 —— cacheSaveTask 本来就是增量写，
  //   算完会再调一次补结果（它靠 task._cachedFiles 跳过已经写过的图）。
  //   ⚠ 只有缓存类任务才记：链路验证那种不进记录。
  //   ⚠ 不 await：写盘慢不该拖住任务卡入场。失败了 cacheSaveTask 自己会记日志。
  if(typeof cacheScheduleRecordsStart==='function') cacheScheduleRecordsStart(task);
  return task;
}

// 点下计算立刻落一条「生成中」记录 + 抓整画布小图。
// 拆出来是为了：① addTask 里不 await 拖慢入场；② 整画布抓图是可选能力，
// 插件没 Reload 时这里要静默退回选区缩略图，不能报错。
function cacheScheduleRecordsStart(task){
  if(!task || !isCachedKindSafe(task.kind)) return;
  if(!cacheAvailable()) return;
  // ⭐ 2026-10-19（docs/251 第七节，用户同意一起修）：从缓存恢复回来的卡（启动恢复 / 记录卡「放回任务栏」）——
  //   盘上本来就有这一单，只把 meta 记成「在任务栏」（「放回任务栏」靠的就是这一下）。
  //   原来这里照新任务那样走：cacheSaveTask 把这单每张图从盘上读出来再原样写回去；
  //   cacheCanvasThumb 还用 PS【现在】的画面盖掉这条记录当时那张整画布小图。
  if(task.restoredFromCache){
    cacheSetTaskbar(task,true).then(broadcastRecordsChanged,broadcastRecordsChanged);
    return;
  }
  // ⚠⚠ 还不知道是哪个 PS 文档时【先不写】（2026-09-30 修，docs/96 缺陷 2）：
  //   多数任务是先建卡、后抓图，建卡那一刻没有文档名/docId。以前照写不误 →
  //   项目名被定成「未保存文档-未知」且再也不改，所有新计算挤进同一个项目，
  //   检查点（抓图后才算项目名）也永远配不上。
  //   现在只挂个标记，等 updateTask 收到文档信息时再补调这里（见 updateTask）。
  //   代价：记录卡里的「生成中」要等抓图完成才出现（用户已同意），任务卡不受影响。
  if(!task.cacheProject && !cacheTaskHasSource(task)){ task._recordsStartPending=true; return; }
  task._recordsStartPending=false;
  // 先算 cacheProject / cacheRunId，再写。⚠ 这两个值原来只在 cacheSaveTask 里算，
  //   不提前算的话这里写的文件夹和算完补写的那次对不上，记录会裂成两条。
  try{
    if(!task.cacheProject) task.cacheProject = cacheScopedProject(cacheProjectName(task));
    if(!task.cacheRunId) task.cacheRunId = cacheStamp(task.startedAt)+'-'+task.id;
  }catch(_){ return; }
  // 整画布小图：异步、不阻塞。写完再广播一次。
  cacheCanvasThumb(task).then(function(){
    broadcastRecordsChanged();
  }, function(){});
  cacheSaveTask(task).then(function(){
    broadcastRecordsChanged();
  }, function(){
    broadcastRecordsChanged();
  });
}
function isCachedKindSafe(kind){
  if(window.V7RecordsCore && typeof V7RecordsCore.isCachedKind==='function') return V7RecordsCore.isCachedKind(kind);
  return ['generation','glow','dlss','matting','segment','sam2'].includes(String(kind||''));
}
// 整画布小图：长边 512 的 JPEG，写成 canvas_thumb.jpg。
// ⚠ 这是【可选】能力 —— PS 插件没 Reload 时没有 ps.doc.canvasThumb 这个动作，
//   退回用任务自己的选区缩略图（就是任务卡背景那张），一样能显示，只是范围小。
// ⚠ 抓图会走 UXP 保护区（executeAsModal），失败绝不冒泡到界面上 ——
//   抓不到小图不该让这次生成失败。
async function cacheCanvasThumb(task){
  if(!task || !task.cacheProject || !task.cacheRunId) return false;
  if(task._canvasThumbWritten) return true;
  const cache = window.uiwin && window.uiwin.cache;
  if(!cache || typeof cache.writeFile!=='function') return false;
  const docId = task.sourceDocId!=null ? task.sourceDocId : (task.captureSnapshot&&task.captureSnapshot.docId);
  if(docId==null) return false;                      // 没有文档来源，无从抓整画布
  // ⚠ 走仓库既有的 linkQueue（全站统一的桥入口），不要另造一个 window.V7UxpBridge ——
  //   那种"看着对、其实没定义"的判断会让整段永远静默 return（本项目最常见的故障形态）。
  let result=null;
  try{
    result = await new Promise((resolve,reject)=>{
      linkQueue('ps.doc.canvasThumb',{docId:String(docId),maxEdge:512},{after:resolve,afterError:reject}).catch(reject);
    });
  }catch(error){
    // 插件没 Reload / 没有这个动作 → 静默退回选区缩略图，不报错。
    logRecordsDiag('整画布小图不可用，已退回选区缩略图：'+String(error&&error.message||error));
    return false;
  }
  const base64 = result && (result.base64||result.data||result.image);
  if(!base64) return false;
  let bytes;
  try{ bytes = base64ToBytes(String(base64)); }
  catch(error){ logRecordsDiag('整画布小图解码失败：'+String(error&&error.message||error)); return false; }
  if(!bytes || !bytes.length) return false;
  try{
    const written = await cache.writeFile(task.cacheProject, task.cacheRunId, 'canvas_thumb.jpg', bytes);
    if(written && written.ok===true){ task._canvasThumbWritten=true; return true; }
    logRecordsDiag('整画布小图写入失败：'+String(written&&written.error||''));
  }catch(error){
    logRecordsDiag('整画布小图写入失败：'+String(error&&error.message||error));
  }
  return false;
}
// ⚠⚠ 2026-10-06 审查修：这里原来还有【第二份】base64ToBytes ——
//   和文件下方那份（带"大图别用 atob 再 split"注释的）同名、同义、同一个 script 块。
//   JS 函数声明会提升，**后声明的那份覆盖前面这份** ⇒ 这一份从写下来那天起就是死代码。
//   ⚠ 同名函数重复定义【不报错、不警告】，只是静默用后一个 —— 加函数前先 grep 名字。
//   ⇒ 已删，只留下方那一份。
// 记录卡靠这个事件刷新自己。没有监听者时它什么都不做 —— 不报错。
function broadcastRecordsChanged(){
  try{ window.dispatchEvent(new CustomEvent('wheelchair:records-changed')); }catch(_){}
}
// 「正在备份检查点…」「正在传回图像…」这类【过程提示】。
// 用现成的 L1 胶囊（addErrorCard，指定时长、返回关闭把手），不另造一套。
// ⚠ 它返回 {close}；调用方拿回执后必须 close，否则胶囊会赖在界面上。
// ⚠ 拿不到报错堆时返回一个空壳 close —— 调用方就不用写判空。
function recordsToast(title,level,durationMs){
  const noop={close:()=>{}};
  try{
    if(typeof addErrorCard!=='function') return noop;
    const handle=addErrorCard({severity:'L1',level:level||'info',title:String(title||''),duration:Number(durationMs)||0});
    return handle&&typeof handle.close==='function'?handle:noop;
  }catch(_){ return noop; }
}
function logRecordsDiag(message){
  try{ if(typeof addLinkLog==='function') addLinkLog({direction:'AI',level:'info',message:'[记录] '+String(message||'')}); }catch(_){}
}

// 原地更新任务卡，不重建主卡或详情滚动容器。
function updateTask(taskId, patch={}){
  const task=taskList.find(t=>String(t.taskId||t.id)===String(taskId)||String(t.id)===String(taskId));
  if(!task) return null;
  const previousProgress=taskProgressSignature(task);
  Object.assign(task,patch||{});
  // 建卡时还不知道文档、推迟了的「生成中」记录：文档信息一到就补写（见 cacheScheduleRecordsStart）。
  //   生成/抠像/分割/指哪抠哪/辉光拿到抓图结果都经过这里，所以挂一处就够。
  if(task._recordsStartPending && cacheTaskHasSource(task)) cacheScheduleRecordsStart(task);
  const progressChanged=previousProgress!==taskProgressSignature(task);
  const el=tasksEl.querySelector('.task[data-task="'+task.id+'"]');
  if(el){
    const pct=Math.max(0,Math.min(100,Number(task.pct)||0));
    el.classList.toggle('done',taskIsDone(task.status));
    el.classList.toggle('failed',task.status==='failed');
    el.classList.toggle('running',task.status==='running');
    const icon=el.querySelector('.t-ic'), name=el.querySelector('.t-name'), out=el.querySelector('.t-pct'), fill=el.querySelector('.t-fill'), sub=el.querySelector('.t-sub');
    // 2026-10-22（docs/263 §1.5）：task.icon 现在是 ICON 的矢量名（hourglass/check/close/stop…），
    //   不再是 emoji。⚠ .t-ic 目前 display:none（2026-09-13 起不显示图标），所以这里只为了保证
    //   「以后要显示时能直接显示正确的图标」+ 不再往 DOM 里塞 emoji 字符。
    if(icon){ if(window.ICON) ICON.set(icon, task.icon||'hourglass', 15); else icon.textContent=''; }
    if(name) name.textContent=task.label||'生成任务';
    if(out) out.textContent=taskStatusText(task,pct);
    if(fill) renderTaskProgress(fill,task,progressChanged);
    // ⭐ 2026-10-19：有云端活在跑时，底栏那行字由状态标注接管（「校色 3/6 · 第 4 张 上传 46%」），跑完交还 task.sub
    if(sub){ const live=(typeof jobView!=='undefined'&&jobView)?jobView.summary(task):''; sub.textContent=live||task.sub||''; sub.classList.toggle('t-sub-live',!!live); }
    if(Object.prototype.hasOwnProperty.call(patch,'sourceImg')){
      if(task.sourceImg){
        const safeSrc=String(task.sourceImg).replace(/["\\\r\n]/g,'');
        el.style.backgroundImage='linear-gradient(180deg, hsl(var(--card-h, 220 28%) 6% / calc(.62 * var(--ui-bg-opacity,1))), hsl(var(--card-h, 220 28%) 6% / calc(.35 * var(--ui-bg-opacity,1))) 42%, hsl(var(--card-h, 220 28%) 6% / calc(.52 * var(--ui-bg-opacity,1))))';
        el.style.backgroundSize='cover';
        el.style.backgroundPosition='center';
        const oldLayer=el.querySelector('.task-source-layer');
        if(oldLayer){
          const nextLayer=document.createElement('div');
          nextLayer.className='task-source-layer task-source-next';
          nextLayer.style.backgroundImage='url("'+safeSrc+'")';
          oldLayer.insertAdjacentElement('afterend',nextLayer);
          requestAnimationFrame(()=>nextLayer.classList.add('reveal'));
          setTimeout(()=>{if(oldLayer.isConnected)oldLayer.remove();if(nextLayer.isConnected)nextLayer.classList.remove('task-source-next','reveal');},430);
        }
        el.classList.add('has-bg');
        // ⚠ 2026-10-22：任务卡不再按亮度翻深字（方案 C，见 04-tasks.css）
        if(window.BG&&window.BG.themeColorFromDataUrl){
          window.BG.themeColorFromDataUrl(safeSrc).then(c=>{
            if(c) el.style.setProperty('--glow-hsl',c.h+' '+c.s+'% '+c.l+'%');
          });
        }
      }
    }
    // ⭐ 2026-09-13：缩略图那排也要在【图层对照表变了】的时候重画 ——
    //   每一格的「传回」按钮是靠 psLayerByShot 判断要不要换成「替换/增益」的，
    //   以前只在 patch.shots 时重画，所以传回成功后那一格还挂着「传回」，能再点一次。
    if(patch.shots || Object.prototype.hasOwnProperty.call(patch,'psLayerByShot')) buildPreview(el,task);
    else if(Object.prototype.hasOwnProperty.call(patch,'cloudSteps')){
      // ⭐ 2026-10-22：采样步数就地改（不重画整排缩略图）；还没有那一格 / 步数刚出现或消失 ⇒ 整排重画一次
      const slot=el.querySelector('[data-pv-steps]'), html=taskStepsHtml(task);
      if(slot&&html){ const box=document.createElement('div'); box.innerHTML=html; slot.replaceWith(box.firstElementChild); }
      else if(!!slot!==!!html) buildPreview(el,task);
    }
    // ⭐ 操作行(提前结束 / 传回 N)跟着状态走。内容没变时它自己会直接返回，不动 DOM。
    syncTaskActions(el,task);
    // ⭐ 指哪抠哪的三候选挑选条（2026-09-14 深夜）。同样是"内容没变就不动 DOM"。
    syncTaskPick(el,task);
  }
  setTasks();
  return task;
}

function updateGenerationTask(taskId, patch={}){
  const next=Object.assign({},patch);
  if(next.status==='done'){
    const previous=taskList.find(t=>String(t.taskId||t.id)===String(taskId)||String(t.id)===String(taskId));
    if(previous&&!previous.completedAt)next.completedAt=Date.now();
  }
  if(next.error && !next.errorInfo) next.errorInfo=taskErrorInfo(next.error,next.stage,next.errorCode);
  if(next.errorInfo && typeof next.errorInfo==='object') next.errorInfo=taskErrorInfo(next.errorInfo,next.errorInfo.stage,next.errorInfo.code);
  if(next.status==='done') next.icon='check';
  // ⚠ 必须在改写 next.sub 之前把真实原因取出来存好。
  //   下面任务卡那行字会被换成短状态，缩略图和报错卡都还要用原文。
  let failReason='';
  if(next.status==='failed'){
    next.icon='close';
    failReason=String(next.error||(next.errorInfo&&next.errorInfo.message)||next.sub||'任务失败');
    // ⭐ 任务卡只说"哪一步黄了"，不说"为什么"(2026-09-11)。
    //   原因一律去报错卡 —— 任务卡那行字只有一行高、还会被截断，
    //   以前把整段报错塞进去，结果是既看不全、又没地方放现场信息。
    //   ⚠ 原文没丢：errorInfo.message 里留着完整的，报错卡和缩略图都从那儿取。
    if(next.sub!==undefined||next.error){
      const st=(window.ERR&&ERR.stageLabel(next.stage||(next.errorInfo&&next.errorInfo.stage)))||'';
      next.sub='失败'+(st?' · '+st:'')+'（详情看报错卡）';
    }
    // 整体请求可能在逐张进度回报前就失败；把所有尚未完成的缩略图同步为错误态，
    // 这样右滑预览不会把失败任务误显示成仍在等待。
    //
    // ⚠⚠⚠ 2026-10-09（docs/189）：这里原来只放过 `shot.error` ——
    //   **已经算完的图（shot.done）也会被改成 done:false + imgId 清空**，
    //   等于"一张图出事，整批已完成的图全丢"。
    //
    //   为什么旧版没暴露：旧版走到这里的条件是"整批一张都没成功"
    //   （main.js 里 `if(!ordered.length) throw`），那时候确实没有已完成的图可毁。
    //   现在 11251 那个 TypeError（已修）让"有 9 张成功"也能走到这，
    //   于是这条【一直存在但爬不出来】的路被踩出来了。
    //
    //   ⇒ 语义应该是：任务失败时【只把还没成功的标失败】，
    //     已经成功的原样保留 —— 用户已经拿到的成果不该被抹掉。
    if(!next.shots){
      const task=taskList.find(t=>String(t.taskId||t.id)===String(taskId)||String(t.id)===String(taskId));
      if(task&&Array.isArray(task.shots)){
        const reason=failReason;
        next.shots=task.shots.map(shot=>(shot&&(shot.error||shot.done))?shot:Object.assign({},shot||{},{done:false,error:reason,errorInfo:taskErrorInfo(reason,'generate','AI_TASK_FAILED'),imgId:''}));
      }
    }
  }
  if(next.status==='cancelled') next.icon='stop';
  const task=updateTask(taskId,next);
  // ⭐ 主链路唯一的报错出口(2026-09-11)。
  //   为什么钉在这里而不是在各个失败点分别弹：主链路的失败点有十几个
  //   (抓取/参数/提交/生成/还原/传回各自都有)，逐个去加必然漏，
  //   而漏掉的那个就又变成"只有一条红字、查不出原因"。
  //   所有失败最终都会流经 updateGenerationTask(status:'failed')，堵这一个口就全覆盖。
  //   ⚠ _errorReported 是必须的：同一个任务会被反复 update，不闸住会弹好几张一样的卡。
  //   ⚠ 从缓存恢复回来的历史任务不弹 —— 那是上次的旧账，不是刚发生的事。
  if(task && window.ERR && !task.restoredFromCache){
    if(next.status==='failed' && !task._errorReported){
      task._errorReported=true;
      const info=task.errorInfo||{};
      ERR.report(next.errorCode||info.code||'AI_TASK_FAILED',{
        message:failReason,
        raw:info.raw&&info.raw.message!==info.message?String(info.raw.message||''):'',
        stage:next.stage||info.stage,
        taskId:String(taskId||''),
        // ⚠ 现场按任务种类给。工具类任务（抠像/人体解析/指哪抠哪）没有
        //   模型/比例/张数/提示词这些东西，照生成那套填会得到一排空行 ——
        //   空行比没有更让人以为"读不到"。
        // ⚠ 三种工具任务的现场是同一套（档位/抓图尺寸/来源文档/选区），
        //   所以用 TOOL_TASK_KINDS 一次包住，别写成三个 || —— 以后再加一种外挂能力
        //   只改那个数组，不用回来这儿补（散落的判断必然漏）。
        context: TOOL_TASK_KINDS.indexOf(task.kind)>=0
          ? {
              '用的档位':task.mattingTierName||'', '抓图尺寸':task.mattingSize||'',
              '来源文档':task.sourceDocName||'',
              '选区':task.sourceSelection?(task.sourceSelection.width+'×'+task.sourceSelection.height):''
            }
          : {
              '模型':task.model||'', '尺寸':task.size||'', '比例':task.aspectRatio||'',
              '张数':task.batch||'', '来源文档':task.sourceDocName||'',
              '提示词':task.prompt?String(task.prompt).slice(0,40)+(String(task.prompt).length>40?'…':''):''
            }
      });
    }
    // 一批里挂了几张但还有成功的 —— 按 2026-09-11 定的尺度走 L1，不打断人。
    if(next.status==='done' && Array.isArray(task.errors) && task.errors.length && !task._partialReported){
      task._partialReported=true;
      const okCount=(task.outputs||[]).length, total=okCount+task.errors.length;
      ERR.report('AI_PARTIAL_FAILED',{
        title:'这批有 '+task.errors.length+' 张没出来（成了 '+okCount+'/'+total+'）',
        message:task.errors.map(x=>x&&x.message).filter(Boolean).slice(0,3).join('；'),
        stage:'generate', taskId:String(taskId||'')
      });
    }
    // ⭐ 遥测：任务终态（2026-10-01）。
    //   挂在这里而不是各处调用点 —— updateGenerationTask 是任务状态的唯一出口，
    //   堵这一个口就全覆盖（跟上面报错出口同一个道理）。
    //   ⚠ _telemetrySent 必须闸住：同一个任务会反复 update，不闸会重复上报。
    //   ⚠ 从缓存恢复的历史任务不报：那是上次的旧账，不是刚发生的事。
    if(!task._telemetrySent && !next.restoredFromCache && window.V7Telemetry &&
       (next.status==='done'||next.status==='failed'||next.status==='cancelled')){
      task._telemetrySent=true;
      try{
        const finalStatus=next.status;
        const started=Number(task.startedAt)||0, ended=Number(task.completedAt)||Date.now();
        const okCount=Array.isArray(task.outputs)?task.outputs.length:0;
        // 结果分三档：全成功 / 部分成功 / 全失败 —— 比布尔值信息量大得多
        let result=finalStatus;
        if(finalStatus==='done'){
          const badCount=Array.isArray(task.errors)?task.errors.length:0;
          result=badCount?(okCount?'partial':'failed'):'success';
        }
        V7Telemetry.task({
          feature:String(task.kind||'generation'),
          provider:String(task.connectionSlot||task.provider||''),
          modelType:String(task.model||''),
          size:String(task.size||task.mattingSize||''),
          aspectRatio:String(task.aspectRatio||''),
          batchSize:Number(task.batch)||0,
          result:result,
          // ⚠ 只报耗时档，不报精确毫秒 —— 精确耗时能指纹化
          elapsedMs:started&&ended>started?(ended-started):0,
          // 错误类别用错误码，不带原文（原文在报错卡里）
          errorCategory:finalStatus==='failed'?String(next.errorCode||(task.errorInfo&&task.errorInfo.code)||''):null
        });
        // 成功了就告诉遥测"上次报的错这次没复现" —— 这是衡量你写的报错方案管不管用的关键信号
        if(result==='success'||result==='partial') V7Telemetry.heal(String(task.kind||'generation'));
      }catch(_){ /* 遥测绝不能影响任务本身 */ }
    }
  }
  // 落盘。从缓存恢复回来的任务不再回写，免得把自己覆盖一遍。
  // ⚠⚠ 2026-09-13 改：不能再用一个布尔值(cacheSaved)把落盘永久闸住。
  //   老写法的后果：「提前结束」时传回成功把任务写成终态、落一次盘、闸门关死，
  //   后台【算完的那几张永远写不进缓存】—— 重载后只剩前半批（用户实测撞到）。
  //   现在按"有图的张数 + 状态"当签名：多出图就补存一次。
  //   cacheSaveTask 内部跳过已经写过的图，所以补存只多一次几 KB 的 meta 写入。
  //
  // ⚠⚠⚠ 2026-10-05 修（用户实测报的「生成中闪退，已完成的图全丢」）：
  //   上面那句"多出图就补存一次"以前【只在终态生效】—— 外面套着 aiTaskIsTerminal。
  //   于是从"发出请求"到"整批跑完"这整段时间里，磁盘上【零写入】：
  //   每张图还原完只是 window.IMG.putFromCanvas 登记进内存管家，
  //   那是纯内存、没有磁盘影子。崩在"第 5 张已出好、第 6 张在算"的瞬间，
  //   前 5 张全没，重启只剩一个 input.png 和一份空 meta。
  //   ⇒ 现在只要这批里【已经落袋了图】就写。签名闸门（张数+状态）保证
  //     它只在张数真的变了时才触发，不会每个进度事件都写一遍。
  //   ⚠ 为什么不用"跑完再写"折中：进度回调本来就是逐张来的，
  //     而崩溃恰恰发生在中途 —— 只在终态写等于没写。
  if(task && !task.restoredFromCache && typeof aiTaskIsTerminal==='function' &&
     (aiTaskIsTerminal(task) || (task.shots||[]).filter(s=>s&&s.imgId).length>0)){
    const sig=(task.shots||[]).filter(s=>s&&s.imgId).length+'/'+String(task.status||'');
    if(task._cacheSig!==sig){
      task._cacheSig=sig;
      // ⭐⭐ 2026-09-30 修：落盘完【必须广播】。
      //   这里原来只写盘、不通知任何人 —— 而记录卡是【事件驱动】的：
      //   它只在收到 wheelchair:records-changed 时重读盘。唯一的发车点是
      //   cacheScheduleRecordsStart（点下计算那一刻）—— 于是卡面永远停在「生成中」，
      //   盘上 meta.json 已经是 status:"done"。（用户实测：关卡再开就好了）
      // ⚠ 成功 / 失败都要广播：写盘失败时 meta 可能已经局部更新，而且“卡面刷不刷”
      //   本来就不应该跟写盘结果绑定。
      const announce=()=>{ if(typeof broadcastRecordsChanged==='function') broadcastRecordsChanged(); };
      cacheSaveTask(task).then(announce,announce);
      // ⭐ 补一次整画布小图：它原来只在【点下计算那一刻】试一次，失败就永远没了。
      //   那一刻最容易失败（插件刚连上 / 还在抢 PS 保护区），而 canvas_thumb.jpg
      //   是记录卡封面的第一顺位 —— 缺了封面就只能退到选区图。
      //   ⚠ 内部自带 _canvasThumbWritten 幂等，已经写过的不会再抢一次 PS。
      //   ⚠ 失败静默：抢不到小图不该让这次生成变成失败。
      if(typeof cacheCanvasThumb==='function'){
        Promise.resolve().then(()=>cacheCanvasThumb(task)).then(ok=>{ if(ok) announce(); },()=>{});
      }
    }
  }
  return task;
}

