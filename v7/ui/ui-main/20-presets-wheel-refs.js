// ═══ ui-main/20-presets-wheel-refs.js —— 主界面主程序第 20 / 21 段 ═══
//   管什么：预设二级攒光切主卡 · 预设滚轮 · 参考图卡 · 示波器轮询 · 主卡跳二级 · 反馈 / 社区卡面
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══════════════════════════════════════════════════════════
//  预设系统接线 (docs/28_预设系统设计.md)
//  ⚠ 预设卡跟别的主卡不是一套逻辑, 所以它的"什么时候开二级/三级"由
//    preset-ui.js 自己决定, 通过下面这几个回调反过来驱动本文件的动画。
// ═══════════════════════════════════════════════════════════
syncZoneKind();                         // 开机先把二级的形态摆对(现在 cur=生成 → 藏单卡)

// ═══ 预设二级「到底再推」攒光切主卡 ═══
// 用户 2026-09-11 定案。见上面 wheel 处理里的说明。
// ── 判定模型: 滑动时间窗口(用户 2026-09-11 定案) ──
//
//   记住【最近 PZ_WINDOW 毫秒内】滚了多少，加起来 ≥ PZ_NEED 就翻页。
//
// ⚠ 为什么不是"每一下单独判速度"(上一版的做法):
//   那一版要给每次滚轮算 速度=滚动量÷距上一下的间隔，于是被迫加了个"间隔上限"，
//   结果是【在底部停一下再滚，第一下必然不算数】—— 一个说不清的怪毛病。
//   滑动窗口一样能挡住慢推(滚得慢，老的滚动量会自己从窗口里过期掉)，
//   但参数从 7 个减到 3 个，而且没有那个坑。
//
//   慢滚(每秒 3~5 格)：400ms 窗口里最多攒到 100~200，永远够不着 380 ✓
//   猛滚(每秒 10 格以上)：400ms 里能攒 400~800，一下就过 ✓
const PZ_WINDOW = 450;   // 滑动窗口(ms)
const PZ_MAXH   = 30;    // 光带最高多少像素
// 窗口内要攒够多少才翻页。⚠ 从【设置】里读，用户自己能调(设置 → 外观与交互 → 交互手感)。
// 一格滚轮按 100px 算，所以 N 格 = N×100。
// 它实际控制的是【要求的滚动速度】: N 格 ÷ 450ms。N=6 约等于每秒 13 格，得是一记有意识的猛推。
function pzNeed(){
  const n=Number(settingsRuntime && settingsRuntime.presetFlipNotches);
  return Math.max(2, Math.min(30, Number.isFinite(n)&&n>0 ? n : 10)) * 100;
}
const PZ_EASE   = 0.28;  // 每帧向目标靠拢的比例。大=跟手，小=顺滑
const PZ_FLASH  = 200;   // 翻页瞬间那记闪光多久(ms)

// ── 冻结: 不是固定时长，而是"等你真停手" ──
// ⚠ 固定时长必然二选一: 给短了猛滚的余势会连翻，给长了想连翻两张时又被挡。
//   改成：先至少冻住 MIN(盖住切卡动画本身)，之后只要还在滚就一直往后推，
//   直到安静 QUIET 毫秒才解冻；MAX 是保险丝，防万一卡住。
const FREEZE_MIN   = 360;   // 最少冻这么久 —— 切卡动画是 340ms，不能让它被打断
const FREEZE_QUIET = 140;   // 停手这么久才解冻
const FREEZE_MAX   = 1200;  // 保险丝: 再怎么滚也不会冻超过这个
let cardSwitchFrozenUntil=0, cardSwitchFreezeCap=0;

// 窗口里的滚动记录 [{t,d}]；光效由 rAF 每帧按窗口实时重算，所以它就是一块"用力表"
let pzEvents=[], pzDir=0, pzShown=0, pzRaf=null, pzFlashAt=0, pzFlashDir=0;

// 光带元素挂在 #presetZone 上(不是 .pz-body 里) —— fillZone 会重刷 .pz-body 的
// innerHTML，挂在里面每次重画就没了。同 .zone-glow 的做法：append 在 .z-body 之后，
// 不会被那层合成层盖住。
let pzEdgeTop=null, pzEdgeBottom=null;
if(presetZoneEl){
  pzEdgeTop=document.createElement('div');    pzEdgeTop.className='pz-edge top';
  pzEdgeBottom=document.createElement('div'); pzEdgeBottom.className='pz-edge bottom';
  presetZoneEl.appendChild(pzEdgeTop);
  presetZoneEl.appendChild(pzEdgeBottom);
}

// p = 0~1 的攒光进度; dir>0 亮下边(往下推), dir<0 亮上边
function pzPushPaint(p, dir){
  const on  = dir>0 ? pzEdgeBottom : pzEdgeTop;
  const off = dir>0 ? pzEdgeTop    : pzEdgeBottom;
  if(off){ off.style.opacity='0'; off.style.height='0px'; off.style.setProperty('--edge-bright','0'); }
  if(!on) return;
  if(p<=0){ on.style.opacity='0'; on.style.height='0px'; on.style.setProperty('--edge-bright','0'); return; }
  // 幂曲线: 跟 .edgehint 同一套手感(中低段拉长, 快到头才猛亮)
  const k=Math.pow(p,1.3);
  on.style.height  = (k*PZ_MAXH)+'px';
  on.style.opacity = String(0.2+k*0.8);
  on.style.setProperty('--edge-bright', String(Math.pow(p,3)));   // 亮线只在临界前冒出来
}
// 窗口内的累计量。顺手把过期的记录扔掉 —— 这就是"慢推攒不满"的全部原理:
// 滚得慢, 老的还没等到新的来就已经过期了。
function pzSum(now){
  while(pzEvents.length && now-pzEvents[0].t > PZ_WINDOW) pzEvents.shift();
  let s=0;
  for(let i=0;i<pzEvents.length;i++) s+=pzEvents[i].d;
  return s;
}

// 翻页瞬间那一记闪光: 从满格往外炸开一点, 同时淡掉。f = 0~1
function pzPaintFlash(f, dir){
  const on  = dir>0 ? pzEdgeBottom : pzEdgeTop;
  const off = dir>0 ? pzEdgeTop    : pzEdgeBottom;
  if(off){ off.style.opacity='0'; off.style.height='0px'; off.style.setProperty('--edge-bright','0'); }
  if(!on) return;
  const out=1-Math.pow(1-f,2);                 // 先快后慢地散开
  on.style.height  = (PZ_MAXH*(1+out*0.9))+'px';
  on.style.opacity = String(1-out);
  on.style.setProperty('--edge-bright', String(1-out));
}

// 每帧: 按窗口实时重算目标, 再用缓动逼近。
// ⚠ 光必须在 rAF 里画, 不能只在滚轮事件里画 ——
//   只在事件里画的话, 你一停手光就【卡在原地不动】, 得等超时才硬清零, 很假。
//   放 rAF 里, 窗口里的记录自己过期, 光就自然地退回去了, 这才是"用力表"该有的样子。
function pzTick(){
  const now=performance.now();

  if(pzFlashAt){
    const f=(now-pzFlashAt)/PZ_FLASH;
    if(f<1){ pzPaintFlash(f, pzFlashDir); pzRaf=requestAnimationFrame(pzTick); return; }
    pzFlashAt=0; pzShown=0; pzDir=0; pzPushPaint(0,0); pzRaf=null; return;
  }

  const target=Math.min(1, pzSum(now)/pzNeed());
  pzShown += (target-pzShown)*PZ_EASE;
  if(target<=0 && pzShown<0.004){          // 退干净了就停, 别空转烧 CPU
    pzShown=0; pzDir=0; pzPushPaint(0,0); pzRaf=null; return;
  }
  pzPushPaint(pzShown, pzDir);
  pzRaf=requestAnimationFrame(pzTick);
}
function pzKick(){ if(!pzRaf) pzRaf=requestAnimationFrame(pzTick); }

// ── 进度被清掉时点名 ──
// ⚠ "攒着攒着就没了"这种间歇性问题，靠复现和猜都很费劲，靠日志一次就定位。
//   只报【攒了不少却被清掉】的情况，正常的清零不刷屏。
function pzDropLog(reason){
  const had = pzShown;
  if(had < 0.25) return;
  const msg='[预设] ⚠ 攒到 '+Math.round(had*100)+'% 被清掉，原因='+reason;
  console.log(msg);
  if(window.__TAURI__ && window.__TAURI__.core){
    window.__TAURI__.core.invoke('debug_log',{message:msg}).catch(()=>{});
  }
}

// 清空窗口。⚠ 不直接把光抹成 0 —— 让 rAF 把它顺滑地收回去，
//   否则反向滚一下会"啪"地一下灭掉，很硬。
function pzPushReset(reason){
  if(!pzEvents.length && !pzShown) return;
  pzDropLog(reason||'未注明');
  pzEvents.length=0;
  pzKick();
}
// 返回 true = 窗口内攒够了, 该切主卡
function pzPushGate(dir, deltaY){
  const now=performance.now();

  // ── 冻结期 ──
  // ⚠ 这段时间的滚轮是上一记猛滚的【余势】, 不是新意图, 一律吞掉。
  //   而且只要还在滚就把解冻时间往后推 —— 冻到你真的停手为止(封顶 FREEZE_MAX)。
  //   这样短促一记很快解冻(跟手), 长长一记也绝不会连翻(安全), 不用赌一个固定值。
  if(now < cardSwitchFrozenUntil){
    cardSwitchFrozenUntil = Math.min(Math.max(cardSwitchFrozenUntil, now+FREEZE_QUIET), cardSwitchFreezeCap);
    pzDropLog('翻页后的冻结期');
    pzEvents.length=0;
    return false;
  }

  if(dir!==pzDir){ pzDropLog('反向滚动'); pzEvents.length=0; pzDir=dir; }   // 反向滚一下 → 窗口清空, 光自己顺滑退回去
  pzEvents.push({t:now, d:Math.abs(deltaY)||100});
  pzKick();

  if(pzSum(now) >= pzNeed()){
    pzEvents.length=0;
    pzFlashAt=now; pzFlashDir=dir;                   // 放那一记闪光
    cardSwitchFrozenUntil = now + FREEZE_MIN;
    cardSwitchFreezeCap   = now + FREEZE_MAX;
    pzKick();
    return true;
  }
  return false;
}

// ═══ 预设二级的专用滚轮监听（非 passive，完全接管）═══
//
// ⚠⚠ 为什么非要单开一个:
//   预设自己的监听仍使用 {passive:false}，在内容区内显式拦截默认滚动。
//   于是到底是"浏览器滚了一次"还是"我手动滚了一次"还是"两次都滚了"，
//   完全不可控 —— 2026-09-11 连着翻车两次:
//     ① 手动滚 + 以为浏览器也在滚 → 判断成翻倍，其实浏览器没滚
//     ② 把手动那行删了 → 彻底滚不动
//   挂到元素上、preventDefault + stopPropagation 之后，滚多少、什么时候切卡，
//   全是我们说了算，不再有"到底谁在滚"这种问题。
//
// ⚠ deltaY 的单位不一定是像素！deltaMode=1 是"行"(一格才 3)，=2 是"页"。
//   不归一化的话，一格只滚 3px，表现就是"怎么滚都不动"，而且攒光永远攒不满。
function pzNormalizeDelta(e, viewH){
  const m = e.deltaMode;
  if(m === 1) return e.deltaY * 16;          // 行 → 像素(按 16px 行高)
  if(m === 2) return e.deltaY * (viewH||300); // 页 → 像素
  return e.deltaY;                            // 0 = 本来就是像素
}

let pzWheelProbed = false;
if(presetZoneEl){
  // ⚠⚠ 挂在 window 的【捕获阶段】+ 用【几何坐标】判断，不挂在 #presetZone 上。
  //
  //   原来是挂在 #presetZone 元素上的，有个很隐蔽的毛病(2026-09-11 用户实测):
  //   【鼠标不动、一直滚】时，浏览器不会重新做命中测试，而且滚轮有 latching ——
  //   一次连续手势会把事件锁定在最初那个元素上。切主卡时 #presetZone 的
  //   display 被切换，旧目标失效，事件就【不再经过它】了 ——
  //   表现是"第二次切到预设卡时攒光完全不更新，动一下鼠标才好"。
  //
  //   捕获阶段在 window 上，不管事件被锁定在哪个元素、目标是不是已经失效，
  //   都一定看得到；再用 clientX/clientY 几何判断是不是落在预设二级上。
  //   这是这个项目一贯的做法 —— 别处的命中判断也全是几何的(见 inConnected 的注释)。
  // 从鼠标下的元素往上找到 stopAt（不含）为止：第一个「自己能滚、而且这个方向还没到头」的元素（V7待办/03）
  function pzInnerScrollTarget(target, stopAt, dir){
    for(let el=target&&target.nodeType===1?target:target&&target.parentElement; el&&el!==stopAt; el=el.parentElement){
      const oy=getComputedStyle(el).overflowY;
      if(!/(auto|scroll)/.test(oy) || el.scrollHeight<=el.clientHeight+1) continue;
      if(dir>0 ? el.scrollTop+el.clientHeight<el.scrollHeight-1 : el.scrollTop>0) return el;
    }
    return null;
  }
  window.addEventListener('wheel', e=>{
    if(e.target.closest?.('.v7-floating-bar'))return;
    // ⚠ 工具工作面开着时，预设二级被大卡整块盖住 —— 这里不能再按几何抢滚轮，
    //   否则在大卡中间一滚，被盖住的列表会接走，攒满就切主卡（2026-09-28）。
    if(document.body.classList.contains('v7tw-covering')) return;
    if(!isPresetCard() || !zones.classList.contains('show')) return;
    if(v7OverlayOpen()) return;
    if(document.getElementById('popupLock').classList.contains('on')) return;
    if(viewerOpen || isCollapsed) return;
    const pzCur = presetZoneKind==='prompt' ? promptZoneEl : presetZoneEl;
    if(!hitRect(e.clientX, e.clientY, pzCur)) return;   // 不在预设二级上 → 不管
    // ⚠ 横向滚动/杂散事件的 deltaY 是 0，不能当成一次纵向滚动 ——
    //   下面 pzEvents 里有个 `Math.abs(d)||100` 的兜底，0 会被算成整整一格，
    //   白送 1/10 的进度。直接不理。
    if(!e.deltaY) return;

    e.preventDefault();     // 关掉浏览器自己的滚动，这块归我们管
    e.stopPropagation();    // 别再冒到 window 那个全局监听上去

    // 提示词形态: 滚的是 .qz-scroll(内容); 列表形态: 滚 .pz-list
    const pl = presetZoneKind==='prompt' ? promptZoneEl.querySelector('.qz-scroll') : presetZoneEl.querySelector('.pz-list');
    const dir = e.deltaY > 0 ? 1 : -1;
    const dy = pzNormalizeDelta(e, pl ? pl.clientHeight : 300);

    // 一次性探针: 把真实数值打出来。滚不动这类问题必须量, 不能猜(铁律 17)。
    if(!pzWheelProbed && pl){
      pzWheelProbed = true;
      const msg = '[预设] 滚轮探针 deltaMode='+e.deltaMode+' deltaY='+e.deltaY
        +' 归一化='+Math.round(dy)+' | 列表可视='+pl.clientHeight+'px 内容='+pl.scrollHeight+'px'
        +' scrollTop='+pl.scrollTop+' → '+(pl.scrollHeight>pl.clientHeight+1?'该能滚':'⚠ 不该能滚');
      console.log(msg);
      if(window.__TAURI__ && window.__TAURI__.core){
        window.__TAURI__.core.invoke('debug_log',{message:msg}).catch(()=>{});
      }
    }

    if(pl){
      // ⭐ 2026-10-24（V7待办/03，反馈 #16「这个地方的滚动条鼠标没法滚动」）：提示词形态下【由里往外】——
      //   鼠标下面有自己能滚的东西（长提示词框、以后可能有的长下拉列表）而且这个方向还没到头 ⇒ 先滚它。
      //   原来一律只滚外层 .qz-scroll，里面那层永远收不到滚轮。列表形态（攒光切主卡）一字不动。
      const inner=presetZoneKind==='prompt'?pzInnerScrollTarget(e.target,pl,dir):null;
      if(inner){ inner.scrollTop += dy; pzKick(); return; }
      const more = dir>0
        ? (pl.scrollTop + pl.clientHeight < pl.scrollHeight - 1)
        : (pl.scrollTop > 0);
      if(more){
        pl.scrollTop += dy;    // 还能滚 → 我们自己滚
        // ⚠ 这里【不能硬清零】攒的进度(以前是 pzPushReset())。
        //   more 是根据 scrollTop/scrollHeight 算的，而这些值在高 DPI 下是小数、
        //   列表重绘时还会变 —— 只要有一次抖动误判成"还能滚"，
        //   攒到 90% 的进度就瞬间归零。用户报的"有时候积攒会消失"就是这个。
        //   改成软的: 不往窗口里加就行了，窗口里的旧记录 450ms 后自己过期，光自然淡掉。
        //   一次误判最多少攒一格，不会把整条进度吃掉。
        pzKick();
        return;
      }
    }
    // 到边了(或没东西可滚) → 攒光。长短列表一视同仁, 不再有"短列表滚一下直接切"的特例。
    if(pzPushGate(dir, dy)) switchMainCard(dir, '攒光达标');
  }, {passive:false, capture:true});
}

// ⚠ 明着挡住"卡不在/元素不在"的情况。不挡的话 buildCard 会安静地什么都不做，
//   表现是"预设卡整张空白但一条错都不报" —— 正是铁律 17 说的静默失效。
if(CARD_PRESETS < 0) console.error('[预设] 找不到 data-card="presets" 的主卡，预设系统不启动');
if(!presetZoneEl) console.error('[预设] 找不到 #presetZone，二级列表没地方画');

if(window.PRESETUI && CARD_PRESETS >= 0 && presetZoneEl){
  // Photoshop 前置动作只通过统一链路执行，UI 不直接操作 UXP。
  if(window.V7PresetPreActions) V7PresetPreActions.configure({
    run(action, params){ return new Promise((resolve, reject) => {
      linkQueue(action, params || {}, { after: resolve, afterError: result => reject(Object.assign(new Error(linkResultMessage(result)), { code: result && result.error && result.error.code || 'PREACTION_PS_FAILED' })) });
    }); },
    getDocument(){ return this.run('ps.doc.info', {}); },
    onSaved(){ if(window.PRESETUI) PRESETUI.refreshListOnly(); }
  });
  // ⭐ 参考图变了 → 重画生成卡 + 刷新参考图卡（2026-10-13 常驻卡）。
  //   ⚠ 卡片自己会判"有没有图"：没图就整张不挂，有图且是刚冒出来的就播弹出光。
  V7PresetReferences.configure(()=>{aiRefreshInPlace();window.V7ReferenceCard?.refresh();});
  // ⭐ 参考图闸门 + 弹窗（融合方案-C01）。
  //   闸门要知道「现在是什么模型 / 协议 / 走不走工作流」才能算能加几张 —— 由这里告诉它（它自己不读 ui.html 的变量）。
  if(window.V7ReferenceGate)V7ReferenceGate.setContext(()=>({
    protocol:String(aiRuntime.protocol||''),model:String(aiRuntime.model||''),
    modelName:(aiModelOptions().find(x=>x[0]===aiRuntime.model)||[])[1]||String(aiRuntime.model||''),
    // 走工作流 = 选的预设带工作流（R6：工作流不受 5 张限制，按工作流自己的映射来）
    workflow:aiRuntime.workflowPresetId?String(settingsRuntime.workflowSource||'local'):'',
    hasMain:true
  }));
  // 2026-10-18：旧参考图弹窗（融合方案-C01）的装配跟弹窗一起删了 —— 参考图卡（下面那段）是唯一的一条路。
}

// ⚠⚠ 2026-10-14：参考图卡这一段【从上面那个 PRESETUI 的 if 块里挪出来】。
//   它跟 PRESETUI / 预设卡没有任何关系 —— 只要 window.V7ReferenceCard 在就该装配。
//   2026-10-14 复核：入口能执行；先前读数来自旧的内嵌资源，不能据此认定钩子没执行。
if(window.V7ReferenceCard){
  // ⭐⭐ 参考图卡（2026-10-13）：参考图从"弹窗"改成"报错栏那一片的常驻卡"。
  //   宿主只给三个能力（卡片自己不读 ui.html 的变量，跟旧弹窗同一套接法）。
  if(window.V7ReferenceCard)V7ReferenceCard.configure({
    captureSelection:referenceCaptureSelection,
    viewImage:(kind,index,anchorEl,geometry)=>referenceOpenView(kind,index,anchorEl,geometry).catch(V7PresetReferences.report),
    holdPreview:referenceHoldPreview,
    leavePreview:referenceLeavePreview,
    previewChainHit:anchorEl=>window.V7Tween?.imageChainHit(anchorEl),
    // 2026-10-14 用户更新：参考图大图与任务卡共用位置计算，不能另定 300×345。
    // 传面板元素，V7Tween 实时量布局；自由模式仍只认这张卡自己的面板。
    geometry:()=>({previewEl:document.querySelector('#refs .ref-panel')}),
    icon:(name,size)=>(window.ICON&&ICON.render)?ICON.render(name,size):''
  });
}
if(window.PRESETUI && CARD_PRESETS >= 0 && presetZoneEl){
  PRESETUI.init({
    cardEl: cards[CARD_PRESETS],
    zoneEl: presetZoneEl,
    detailBody: ()=>document.getElementById('dcBody'),
    // 三级"整体上下滚动"换内容。⚠ 预设系统不自己写一套动画 ——
    //   参数、时长、方向全项目共用 specialDetailFill 这一份，
    //   各写各的迟早跟别的主卡对不上(用户 2026-09-11 报"部分页面没有切换动画")。
    slideDetail: (writeAll,dir,animate=true)=>specialDetailFill(writeAll,animate,dir),
    detailName: ()=>detail.querySelector('.dc-name'),
    refreshDetailBackground: updateDetailBg,

    // 点了剪影上的部位 → 弹二级(复用现成的展开动画和弹出光)
    // 点了剪影上的部位 → 弹列表二级(形态 list)。提示词框开着时会被替换掉(用户定案)。
    openZone(){ openPresetZone('list', false); },
    // 点剪影空白 → 收二级(用户定案: 点空白收, 点部位切分组)
    closeZone(){ closeAll(); },
    // 提示词二级卡的 body / 名字(路线 A); 三级的还是 dcBody
    promptZoneBody: ()=>promptZoneEl && promptZoneEl.querySelector('.qz-body'),

    // 点了某个预设 → 弹三级。withGlow=true 是行上右滑推进触发的, 播弹出光。
    openDetail(withGlow){
      openDetail(!!withGlow);
      // ⚠ 标记"用过": 挑预设是明确的意图, 不是误触。
      //   不标的话鼠标一移开, "没用过就走"的规则会立刻把刚打开的提示词框收掉。
      detailUsed=true;
    },
    closeDetail(){ closeAll(); },

    toast(msg, level){ UI.toast(msg, level==='ok'?'ok':level==='err'?'err':level==='warn'?'warn':'info'); },
    dialog(o){ UI.dialog(o); },

    // 提示词一变就同步给生成运行时。
    // ⚠ 生成走的是 aiRuntime.prompt，不同步的话会出现"选了预设，生成的却是上次那段词"。
    //   这里也顺手把生成卡里那个提示词输入框刷一下(它开着的话)。
    // ⚠⚠ 第二个参数 presetTitle 以前【被丢掉了】（2026-09-13 修）。
    //   preset-ui.js 一直在传：`S.host.onPromptChange(St.text, St.presetTitle)`，
    //   但这里只收了 text —— 所以任务卡从来不知道自己是用哪条预设跑的，
    //   只能显示"aji · AJbanana3"这种谁看都一样的东西。
    onPromptChange(text, presetTitle){
      if(typeof aiRuntime!=='object') return;
      aiRuntime.prompt=String(text||'');
      // ⚠⚠ 2026-09-13 起 aiRuntime.presetTitle 只是一份【镜像】，不再是真源。
      //   真源是预设侧的 originTitle/originEdited，提交那一刻由 presetTitleNow() 现取。
      //   这份镜像只剩两个用处：① 预设系统没起来时的兜底 ② 调试时看一眼。
      //   ⚠ 别再往它上面加消费方 —— 它有个治不好的毛病：重启后是空的
      //     （提示词正文走临时缓存会自己回来，它不会），那正是"显示自定义"的老病根。
      if(presetTitle!==undefined) aiRuntime.presetTitle=String(presetTitle||'');
      if(typeof aiSaveTempCache==='function') aiSaveTempCache();
      const ta=document.querySelector('#dcBody [data-ai-field="prompt"]');
      if(ta && ta.value!==aiRuntime.prompt) ta.value=aiRuntime.prompt;
    },

    // Workflow controls live in the preset card but are part of the same
    // generation snapshot. Replacing this object on preset selection clears
    // values from the previous preset; editing a control updates the visible
    // generation card and the queue/history snapshot together.
    getWorkflowSource(){ return settingsRuntime.workflowSource; },
    onWorkflowParametersChange(values, presetId){
      if(typeof aiRuntime!=='object') return;
      // ⭐ 2026-10-19（docs/250 第 6 条）：张数分三套 —— 先记下「改之前属于哪一套」（换成工作流预设以后就算不出来了）
      const prevKind=aiRuntime.batchKind||currentBatchKind();
      aiRuntime.workflowParameters=aiClonePlain(values||{});
      aiRuntime.workflowPresetId=String(presetId||'');
      const count=Number(aiRuntime.workflowParameters.imageCount||aiRuntime.workflowParameters.batch);
      batchKindSwitch(prevKind,(presetId && Number.isFinite(count) && count>0)?count:null);
      if(typeof aiSaveTempCache==='function') aiSaveTempCache();
      if(typeof aiRefreshInPlace==='function') aiRefreshInPlace();
    },

    // ▶ 开始计算
    // ⚠ 先问一句"现在选着的是不是工具类预设"。是的话走工具自己的链路（抠像…），
    //   提示词那套检查(空词提醒)对它没意义 —— 抠像根本没有提示词。
    //   ⚠ 和快捷键走的是同一个 runNow，不存在两套逻辑。
    onRun(text){
      const PU=window.PRESETUI;
      if(PU&&typeof PU.getToolPreset==='function'&&PU.getToolPreset()){ runNow(null); return; }
      const t=String(text||'').trim();
      const workflow=aiWorkflowSnapshot().workflowPreset;
      if(!t&&!(workflow&&(workflow.workflow||workflow.forgeWorkflow))){ UI.toast('提示词是空的，先写点东西或挑个预设','warn'); return; }
      if(typeof aiRuntime==='object'){
        aiRuntime.prompt=t;
        if(typeof aiSaveTempCache==='function') aiSaveTempCache();
      }
      if(typeof generationRunNow!=='function'){
        UI.toast('生成链路还没接上（generationRunNow 不可用）','warn');
        return;
      }
      // ⚠ 传 null 不传 document: generationRunNow 会拿 root 去 aiReadFields,
      //   而这会儿三级卡里是提示词框、不是生成表单，读一遍等于拿空表单去覆盖刚设好的值。
      //   传 null 它会自己找生成面板，找不到就跳过读表单 —— 正是我们要的。
      try{ generationRunNow(null); }
      catch(e){ console.warn('[预设] 调用生成失败', e);
        ERR.report('PRESET_START_FAILED',{message:String(e&&e.message||e),raw:e&&e.stack}); }
    }
  }).then(info=>{
    if(!info) return;
    // 诊断日志成功失败都打 —— "零条失败"既可能是全成功也可能是根本没跑(铁律 17)
    const sc=(window.PRESETS && PRESETS.mem.selfCheck)||null;
    const msg='[预设] '+info.assets+' 个素材 / '+info.presets+' 条预设'+(info.migrated?' / 已迁移过':' / 还没迁移')
      +(sc ? (' / 画布比例 '+sc.aspect.toFixed(3)) : '')
      +(sc ? (sc.bad.length ? ' / ⚠ 异常: '+sc.bad.join(' ') : ' / 素材自检全过') : '');
    console.log(msg);
    if(sc) console.log('[预设] 素材位置: '+sc.boxes.join(' | '));
    if(window.__TAURI__ && window.__TAURI__.core){
      window.__TAURI__.core.invoke('debug_log',{message:msg}).catch(()=>{});
      if(sc) window.__TAURI__.core.invoke('debug_log',{message:'[预设] 素材位置 '+sc.boxes.join(' | ')}).catch(()=>{});
    }
  }).catch(e=>{
    // ⭐ 2026-10-20（docs/256 F2b）：被换账号打断的这次启动不算失败 —— 新账号会走 PRESETUI.rebindStorage() 重新加载（同 preset-ui.js init 里那段）
    if(e && e.code==='BACKUP_ACCOUNT_CHANGED'){ console.info('[预设] 这次启动被换账号打断，新账号会重新加载'); return; }
    console.error('[预设] 启动失败', e);
    if(window.ERR) ERR.report('PRESET_BOOT_FAILED',{message:String(e&&e.message||e),raw:e&&e.stack});
    if(window.__TAURI__ && window.__TAURI__.core){
      window.__TAURI__.core.invoke('debug_log',{message:'[预设] 启动失败: '+(e&&e.message||e)}).catch(()=>{});
    }
  });
}else if(!window.PRESETUI){
  console.error('[预设] preset-ui.js 没加载 —— 预设卡整张是空的');
  if(window.ERR) ERR.report('PRESET_BOOT_FAILED',{message:'preset-ui.js 没有加载，预设卡整张是空的'});
}

// ⭐ 参考图卡（2026-10-13）：建容器 + 首次渲染。
//   ⚠ 没图时 mount() 会让容器保持 hidden（用户定：没图就不该有这张卡）。
//   ⚠ 位置刷新交给 setErrors() 末尾统一带一次（那里已经有完整的避让算法，不重复一份）。
if(window.V7ReferenceCard)V7ReferenceCard.mount();

async function regionWorkbenchDialog(options){
  const pane=document.querySelector('.region-workbench');if(pane)pane.style.visibility='hidden';
  try{return await new Promise(resolve=>UI.dialog({...options,confirm:'确认',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)}));}
  finally{if(pane&&pane.isConnected)pane.style.visibility='';}
}
function cameraLightBase64(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}
// Lighting now lives in the ordinary card workspace. There is no native dialog
// to close/reopen; restoring it with showModal() discarded successful results.
async function cameraLightOutsideModal(action){return await action();}
async function cameraLightBridge(action,params){const result=await linkOnce(action,params);if(!result?.ok)throw Object.assign(new Error(result?.error||linkResultMessage(result)),{code:result?.code||'LIGHTING_FAILED'});return result.data;}
if(window.V7CameraLight)V7CameraLight.configure({
  models:()=>aiModelOptions(),
  rebind:async capture=>{const docs=await cameraLightBridge('ps.doc.listOpen',{});const doc=(docs.documents||[]).find(d=>Number(d.id)===Number(capture.docId)&&d.name===capture.docName);if(!doc)throw new Error('原文档未打开或编号已变化，请重新打开原文档并重新抓取');return cameraLightOutsideModal(()=>new Promise(resolve=>UI.dialog({title:'确认原 Photoshop 文档',body:doc.name+' · 文档 '+doc.id,detail:'请核对原文档和区域仍与保存时一致，确认后允许传回保存结果。',confirm:'确认原文档',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})));},
  confirm:(title,body)=>cameraLightOutsideModal(()=>new Promise(resolve=>UI.dialog({title,body,confirm:'确认',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)}))),
  presetName:async initial=>{const name=await cameraLightOutsideModal(()=>new Promise(resolve=>UI.dialog({title:'保存相机与灯光预设',body:initial,confirm:'保存',cancel:'取消',onConfirm:()=>resolve(initial),onCancel:()=>resolve(null)})));return name;},
  capture:()=>new Promise((resolve,reject)=>aiCapture(async data=>{try{const snap=aiCaptureSnapshot(data,0);if(snap.docId==null||!snap.selection)throw new Error('缺少原文档或抓取区域信息，请重新连接 Photoshop');const blob=await(await fetch('data:'+snap.mime+';base64,'+snap.imageBase64)).blob();delete snap.imageBase64;delete snap.inputImageBase64;delete snap.sourceImageBase64;resolve({blob,target:snap});}catch(error){reject(error);}},0,result=>reject(new Error(linkResultMessage(result))),{allowFullCanvas:true})),
  analyze:async(blob,prompt)=>{const image={mime:blob.type,base64:await cameraLightBase64(blob)};return cameraLightOutsideModal(()=>V7AssistantPanel.analyzeImage(prompt,image,{confirm:true}));},
  async generate(request){
    const editor=V7CameraLight.state();editor.store.check();
    if(window.V7FirstRun&&!V7FirstRun.isComplete()){const accepted=await cameraLightOutsideModal(()=>V7FirstRun.require());editor.store.check();if(!accepted)throw new Error('需要先同意使用条款');}
    const c=request.config,imageBase64=await cameraLightBase64(request.blob),taskId=aiNewTaskId('lighting');editor.store.check();request.setTaskId(taskId);
    const refs=request.diagram?[{imageBase64:await cameraLightBase64(request.diagram),mime:'image/png',label:'灯光布局'}]:[];editor.store.check();
    const snapshot=Object.assign({},aiRuntime,aiWorkflowSnapshot(),{taskId,presetTitle:request.title,prompt:request.prompt,batch:request.batch,model:c.model||aiRuntime.model,size:c.size,aspectRatio:c.aspect,antiMode:0,refImages:refs,preserveGeneratedAppearance:true,capture:null,captureSnapshot:{...request.capture,imageBase64,sourceImageBase64:imageBase64}});
    if(c.channel){snapshot.provider=c.channel;snapshot.baseUrl=settingsRuntime[c.channel+'Url'];snapshot.apiKey=settingsRuntime[c.channel+'Key'];snapshot.endpoint='';}
    const result=await aiGenerateNow(snapshot,{autoReturn:false,confirm:estimate=>cameraLightOutsideModal(()=>new Promise(resolve=>UI.dialog({title:'确认本次灯光生成',body:request.title+' · '+request.batch+' 张 · '+estimate.points+' 积分',detail:billingNoRefundText(estimate.points),confirm:'确认并生成',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})))});
    editor.store.check();const task=taskById(taskId);if(task)historyRecordTask(task);
    if(!task?.outputs?.length)throw new Error(result?.error||'没有返回可用图像');return task.outputs;
  },
  cancel:taskId=>taskId?aiCancel(taskId):Promise.resolve(),
  async transfer(result,capture,store,properties){store.check();const blob=await store.asset(result.id);store.check();const imageBase64=await cameraLightBase64(blob);store.check();const placed=await cameraLightBridge('ps.layer.place',{imageBase64,targetDocId:capture.docId,targetSelection:aiClonePlain(capture.selection),strictTarget:true,layerType:settingsRuntime.layerType||'smartObject'});if(!placed?.layerId)throw new Error('Photoshop 没有返回新图层编号，请检查原文档，避免重复传回');return {docId:capture.docId,layerId:placed.layerId,properties:properties||null,styled:!properties};},
  style:(placed,capture)=>cameraLightBridge('ps.layer.properties',{docId:capture.docId,layerId:placed.layerId,...placed.properties}),
  async attachment(item,capture){
    const editor=V7CameraLight.state(),blob=await(await fetch('assets/light-handdrawn/light_'+String(item.attachment+1).padStart(2,'0')+'.png')).blob();editor.store.check();const bitmap=await createImageBitmap(blob);const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();ctx.globalCompositeOperation='source-atop';ctx.fillStyle=V7CameraLightCore.color(item);ctx.fillRect(0,0,canvas.width,canvas.height);const imageBase64=canvas.toDataURL('image/png').split(',')[1],area=capture.selection;editor.store.check();const side=Math.min(area.width,area.height)*item.scale;const targetSelection={left:area.left+area.width*item.x-side/2,top:area.top+area.height*item.y-side/2,width:side,height:side};const placed=await cameraLightBridge('ps.layer.place',{imageBase64,targetDocId:capture.docId,targetSelection,strictTarget:true,layerType:'smartObject'});editor.store.check();await cameraLightBridge('ps.layer.properties',{docId:capture.docId,layerId:placed.layerId,name:item.name,visible:true});
  }
});
async function creativeBridge(action,params){const result=await linkOnce(action,params);if(!result?.ok)throw Object.assign(new Error(result?.error||linkResultMessage(result)),{code:result?.code||'CREATIVE_TOOL_FAILED'});return result.data;}
// ── 示波器实时轮询的通道（2026-09-29 用户要求：打开就自动轮询采样 PS 整张画布）──
//   ⚠ 每秒一次，所以和 creativeBridge 不一样的地方全是为轮询准备的：
//     ① quiet：成功不写调试卡日志（每秒两条会把日志刷满），失败照记；
//     ② 超时：linkOnce 没有超时，插件卡住时轮询会永远等下去；
//     ③ 同一时间只挂一个请求：超时了也要等那个请求真回来（或 60 秒兜底）才发下一个，不在队列里越积越多；
//     ④ 插件没连上就不发（见下面 docInfo）：否则重连后插件一口气执行一堆过期的读取。
let scopeBridgeInflight=0;
function scopeBridge(action,params,timeout){
  if(scopeBridgeInflight>0)return Promise.reject(Object.assign(new Error('上一次读取还没回来，稍后自动重试'),{code:'IMAGE_SCOPES_BUSY'}));
  scopeBridgeInflight++;
  let released=false;const release=()=>{if(!released){released=true;scopeBridgeInflight--;}};
  const guard=setTimeout(release,60000);
  return new Promise((resolve,reject)=>{
    let done=false;const finish=(error,data)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(data);};
    const settle=(error,data)=>{clearTimeout(guard);release();finish(error,data);};
    const timer=setTimeout(()=>finish(Object.assign(new Error('Photoshop 没有及时回应（可能开着对话框或正忙），好了会自动继续'),{code:'IMAGE_SCOPES_TIMEOUT'})),timeout||8000);
    linkQueue(action,params,{quiet:true,after:data=>settle(null,data),afterError:result=>settle(Object.assign(new Error(linkResultMessage(result)),{code:result?.error?.code||'IMAGE_SCOPES_FAILED'}))})
      .then(reply=>{if(!reply||(reply.ok===false)||reply.success===false)settle(new Error((reply&&(reply.error?.message||reply.error))||'入队失败'));})
      .catch(error=>settle(error));
  });
}
V7ImageScopes.configure({
  // 只读文档信息（带 historyStateId）：大卡每秒问一次「画面变没变」，变了才读像素。
  docInfo:()=>{
    if(!linkRuntime.connected)return Promise.reject(Object.assign(new Error('联动插件没连上：在 PS 里重载插件，连上后自动继续'),{code:'IMAGE_SCOPES_OFFLINE'}));
    return scopeBridge('ps.doc.info',{},8000);
  },
  // 读整张画布（插件里已进 executeAsModal）。known = 刚问到的文档信息，省一次往返。
  capture:async(maxEdge,known)=>{
    const doc=known&&known.id!=null?known:await scopeBridge('ps.doc.info',{},8000);
    if(!doc||doc.hasDoc===false||doc.id==null)throw Object.assign(new Error('Photoshop 里没有打开的文档'),{code:'NO_DOCUMENT'});
    const result=await scopeBridge('ps.regions.capture',{docId:doc.id,expected:{id:doc.id,name:doc.name,width:doc.width,height:doc.height},selection:{left:0,top:0,right:doc.width,bottom:doc.height,width:doc.width,height:doc.height},maxEdge},20000);
    return {name:result.docName,blob:await(await fetch('data:'+result.mime+';base64,'+result.imageBase64)).blob()};
  }
});
if(window.V7SeamReview)V7SeamReview.configure({bridge:(action,params,timeout)=>new Promise((resolve,reject)=>{
  let done=false,requestId=null;
  const finish=(error,data)=>{if(done)return;done=true;clearTimeout(timer);if(requestId)linkRuntime.pending.delete(requestId);error?reject(error):resolve(data);};
  const timer=setTimeout(()=>finish(Object.assign(new Error(action==='ps.seam.apply'?'Photoshop 传回尚未确认，请先检查图层面板，不要连续重试':action==='ps.seam.focus'||action==='ps.group.soloOwned'||action==='ps.group.showOwned'?'Photoshop 跳转超时，请检查目标文档仍处于打开状态、Photoshop 没有被对话框挡住':'Photoshop 读取超时，请检查联动插件连接后重试'),{code:'SEAM_REVIEW_TIMEOUT'})),timeout);
  linkQueue(action,params,{after:data=>finish(null,data),afterError:result=>finish(Object.assign(new Error(linkResultMessage(result)),{code:result?.error?.code||'SEAM_REVIEW_FAILED',raw:result?.error}))}).then(reply=>{requestId=reply?.requestId;if(done&&requestId)linkRuntime.pending.delete(requestId);if(!reply?.ok)finish(new Error(reply?.error?.message||reply?.error||'接缝请求未入队'));}).catch(finish);
})});
if(window.V7CreativeTools)V7CreativeTools.configure({
  models:()=>aiModelOptions(),
  confirm:(title,body)=>new Promise(resolve=>UI.dialog({title,body,confirm:'确认',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})),
  capture:()=>new Promise((resolve,reject)=>aiCapture(async data=>{try{const target=aiCaptureSnapshot(data,0);if(!target.docId||!target.selection)throw new Error('缺少 Photoshop 来源区域');const blob=await(await fetch('data:'+target.mime+';base64,'+target.imageBase64)).blob();delete target.imageBase64;delete target.inputImageBase64;delete target.sourceImageBase64;resolve({blob,target});}catch(error){reject(error);}},0,result=>reject(new Error(linkResultMessage(result))),{allowFullCanvas:true})),
  analyze:async(text,blob)=>{const editor=V7CreativeTools.state();editor.store.check();const image=blob?{mime:blob.type,base64:await V7CreativeMedia.base64(blob)}:null;editor.store.check();return V7CreativeTools.outside(()=>image?V7AssistantPanel.analyzeImage(text,image,{confirm:true}):V7AssistantPanel.analyzeText(text,{confirm:true}));},
  async generate({job,input,references,setTaskId}){
    const editor=V7CreativeTools.state();editor.store.check();
    if(window.V7FirstRun&&!V7FirstRun.isComplete()){const accepted=await V7CreativeTools.outside(()=>V7FirstRun.require());editor.store.check();if(!accepted)throw new Error('需要先同意使用条款');}
    const imageBase64=await V7CreativeMedia.base64(input.full),taskId=aiNewTaskId('creative');editor.store.check();await setTaskId(taskId);editor.store.check();
    const refImages=[];for(const ref of references){refImages.push({imageBase64:await V7CreativeMedia.base64(ref.asset.full),mime:ref.asset.mime,label:ref.name});editor.store.check();}
    const c=job.settings,capture=job.capture?.target||{},snapshot=Object.assign({},aiRuntime,aiWorkflowSnapshot(),{taskId,presetTitle:job.title,prompt:job.prompt,batch:job.batch,model:c.model||aiRuntime.model,size:c.size,aspectRatio:job.mode==='poster'?V7CreativeCore.generationAspect(job.output.width,job.output.height):c.aspect,antiMode:0,refImages,preserveGeneratedAppearance:true,skipCheckpoint:!capture.docId,capture:null,captureSnapshot:{...capture,width:input.width,height:input.height,mime:input.mime,imageBase64,sourceImageBase64:imageBase64}});
    const result=await aiGenerateNow(snapshot,{autoReturn:false,confirm:estimate=>V7CreativeTools.outside(()=>new Promise(resolve=>UI.dialog({title:'确认创作生成',body:job.title+' · '+job.batch+' 张 · '+estimate.points+' 积分',detail:billingNoRefundText(estimate.points),confirm:'确认并生成',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})))});
    editor.store.check();const task=taskById(taskId);if(task)historyRecordTask(task);if(!task?.outputs?.length)throw new Error(result?.error||'没有返回可用图像');
    const outputs=[];for(const image of task.outputs){const full=new Blob([await IMG.fullBytes(image.imgId)],{type:image.mime||'image/png'});editor.store.check();outputs.push({full});}return outputs;
  },
  cancel:taskId=>taskId?aiCancel(taskId):Promise.resolve(),
  async validateTarget(target){const response=await creativeBridge('ps.doc.listOpen',{}),doc=(response.documents||[]).find(d=>Number(d.id)===Number(target.docId)&&(!target.docName||d.name===target.docName));if(!doc||target.docWidth&&Number(doc.width)!==target.docWidth||target.docHeight&&Number(doc.height)!==target.docHeight)throw new Error('原 Photoshop 文档未打开或尺寸已变化，请核对原文档');},
  createDocument:params=>creativeBridge('ps.doc.create',params),
  async transfer(asset,target){const editor=V7CreativeTools.state(),imageBase64=await V7CreativeMedia.base64(asset.full);editor.store.check();return creativeBridge('ps.layer.place',{imageBase64,targetDocId:target.docId,targetSelection:aiClonePlain(target.selection),strictTarget:true,layerType:settingsRuntime.layerType||'smartObject'});}
});
// ⭐ 10-25 工具「眼神调整」：抓选区 / 传回 / 改图层名都走联动插件；图层类型跟设置走
if(window.V7EyeGaze)V7EyeGaze.configure({
  bridge:(action,params)=>new Promise((resolve,reject)=>{linkQueue(action,params||{},{after:resolve,afterError:r=>reject(Object.assign(new Error(linkResultMessage(r)),{code:r&&r.code}))}).catch(reject);}),
  layerType:()=>settingsRuntime.layerType||'smartObject'
});
if(window.V7DLSS)V7DLSS.configure({
  bridge:(action,params)=>new Promise((resolve,reject)=>{linkQueue(action,params||{},{after:resolve,afterError:r=>reject(Object.assign(new Error(linkResultMessage(r)),{code:r&&r.code}))}).catch(reject);}),
  confirm:request=>new Promise(resolve=>UI.dialog({...request,confirm:request.confirm||'确认并增强',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})),
  layerType:()=>settingsRuntime.layerType||'smartObject',autoReturn:()=>settingsRuntime.autoReturn===true
});
if(window.V7RegionWorkbench)V7RegionWorkbench.configure({
  presets:()=>window.PRESETS?PRESETS.presets().filter(p=>!p.hidden&&(!PRESETS.visible||PRESETS.visible(p))):[],
  bridge:(action,params)=>new Promise((resolve,reject)=>{linkQueue(action,params||{},{after:resolve,afterError:r=>reject(Object.assign(new Error(linkResultMessage(r)),{code:r&&r.code}))}).catch(reject);}),
  confirm:regionWorkbenchDialog,
  async prepare(run){
    if(window.V7FirstRun&&!V7FirstRun.isComplete()){
      const pane=document.querySelector('.region-workbench');if(pane)pane.style.visibility='hidden';let agreed;
      try{agreed=await V7FirstRun.require();}finally{if(pane&&pane.isConnected)pane.style.visibility='';}
      if(!agreed)throw new Error('需要先同意使用条款');
    }
    const preset=PRESETS.presetById(run.presetId);if(!preset)throw new Error('生成预设已不存在，请新建区域记录');
    const refImages=await V7PresetReferences.payload(PRESETS.resolveReferenceImages(preset));
    return Object.assign({},aiClonePlain(aiRuntime),aiWorkflowSnapshot(),{workflowPreset:aiClonePlain(preset),workflowPresetId:preset.id,workflowParameters:aiClonePlain(preset.parameters||{}),presetId:preset.id,presetTitle:preset.title,prompt:run.prompt,antiMode:0,refImages,capture:null,captureSnapshot:null,autoReturn:false});
  },
  async generate(request){
    const taskId=aiNewTaskId('region');request.setTaskId(taskId);
    const imageBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(request.input.full);});
    const first=request.regions[0],stitch=request.run.mode==='stitch';
    const snapshot=Object.assign({},request.prepared,{taskId,batch:request.count,skipCheckpoint:stitch,captureSnapshot:{docId:stitch?null:first.doc.id,docName:stitch?'多区拼接':first.doc.name,docWidth:first.doc.width,docHeight:first.doc.height,hasSelection:true,width:request.input.width,height:request.input.height,mime:request.input.full.type,imageBase64,sourceImageBase64:imageBase64,selection:stitch?{left:0,top:0,right:request.input.width,bottom:request.input.height,width:request.input.width,height:request.input.height}:aiClonePlain(first.selection)}});
    const result=await aiGenerateNow(snapshot,{autoReturn:false,confirm:estimate=>regionWorkbenchDialog({title:'确认本次平台生成',body:request.prepared.presetTitle+' · '+request.count+' 张 · '+estimate.points+' 积分',detail:billingNoRefundText(estimate.points)})});
    const task=taskById(taskId);if(task)historyRecordTask(task);
    if(!result||!result.ok)throw new Error(result&&result.error||'区域生成没有返回可用结果');
    const outputs=[];for(const image of task.outputs||[]){const blob=new Blob([await IMG.fullBytes(image.imgId)],{type:image.mime||'image/png'});outputs.push({full:blob});}return outputs;
  },
  cancel:taskId=>aiCancel(taskId),
  async transfer(request){
    const imageBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(request.asset.full);});
    const result=await linkOnce('ps.layer.place',{imageBase64,targetDocId:request.doc.id,targetSelection:request.selection,strictTarget:true,layerType:settingsRuntime.layerType||'smartObject',feather:request.feather});
    if(!result||!result.ok)throw new Error(result&&result.error||'区域传回失败');return result.data;
  }
});
if(window.V7CanvasWorkbench)V7CanvasWorkbench.configure({
  bridge:creativeBridge,
  presets:()=>window.PRESETS?PRESETS.presets().filter(p=>(!p.kind||p.kind==='prompt')&&!p.hidden&&(!PRESETS.visible||PRESETS.visible(p))):[],models:()=>aiModelOptions(),
  channels:()=>[['aji','AJI'],['grs','GRS'],['other','其他']],workflowSource:()=>settingsRuntime.workflowSource,
  enter:async()=>{if(window.uiwin&&uiwin.browser)await uiwin.browser.workspace({open:true});},
  capture:()=>new Promise((resolve,reject)=>aiCapture(async data=>{try{const blob=await(await fetch('data:'+(data.mime||'image/png')+';base64,'+(data.imageBase64||data.inputImageBase64))).blob();resolve({blob,source:{kind:'photoshop',name:data.docName||'Photoshop'}});}catch(error){reject(error);}},0,result=>reject(new Error(linkResultMessage(result))),{allowFullCanvas:true})),
  async generate(request){
    if(window.V7FirstRun&&!V7FirstRun.isComplete()){
      await V7CanvasWorkbench.browserVisible(false);let agreed;
      try{agreed=await V7FirstRun.require();}finally{await V7CanvasWorkbench.browserVisible(true);}
      if(!agreed)throw Object.assign(new Error('需要先同意使用条款'),{code:'TERMS_REQUIRED'});
    }
    const preset=PRESETS.presetById(request.presetId);if(!preset)throw Object.assign(new Error('预设已不存在，请重新选择'),{code:'CANVAS_PRESET_REQUIRED'});
    const taskId=aiNewTaskId('canvas');request.setTaskId(taskId);
    const imageBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(request.inputAsset.full);});
    const refImages=await V7PresetReferences.payload(PRESETS.resolveReferenceImages(preset));
    for(const [index,asset] of (request.referenceAssets||[]).entries()){
      const imageBase64=await V7CreativeMedia.base64(asset.full);
      refImages.push({imageBase64,mime:asset.mime||asset.full.type||'image/png',label:'幕布参考图 '+(index+1)});
    }
    const snapshot=Object.assign({},aiRuntime,aiWorkflowSnapshot(),{taskId,workflowPreset:aiClonePlain(preset),workflowPresetId:preset.id,workflowParameters:aiClonePlain(request.parameters||{}),presetTitle:preset.title,prompt:String(request.prompt??preset.content??''),batch:request.batch,model:request.model||aiRuntime.model,antiMode:0,refImages,skipCheckpoint:true,capture:null,captureSnapshot:{docId:null,docName:'幕布 · '+preset.title,hasSelection:true,width:request.inputAsset.width,height:request.inputAsset.height,mime:request.inputAsset.mime,imageBase64,sourceImageBase64:imageBase64,selection:{left:0,top:0,width:request.inputAsset.width,height:request.inputAsset.height}}});
    if(['aji','grs','other'].includes(request.channel)){snapshot.provider=request.channel;snapshot.baseUrl=settingsRuntime[request.channel+'Url'];snapshot.apiKey=settingsRuntime[request.channel+'Key'];snapshot.endpoint='';}
    snapshot.fieldHistorySnapshot=window.PRESETUI&&PRESETUI.captureFieldHistory?PRESETUI.captureFieldHistory({presetId:preset.id,text:snapshot.prompt,workflowParameters:snapshot.workflowParameters}):null;
    const result=await aiGenerateNow(snapshot,{autoReturn:false,confirm:async estimate=>{
      await V7CanvasWorkbench.browserVisible(false);
      try{return await new Promise(resolve=>UI.dialog({title:'确认本次平台生成',body:preset.title+' · '+request.batch+' 张 · '+estimate.points+' 积分 · 约 '+estimate.etaSeconds+' 秒',detail:billingNoRefundText(estimate.points),confirm:'确认并生成',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)}));}
      finally{await V7CanvasWorkbench.browserVisible(true);}
    }});
    const task=taskById(taskId);if(task)historyRecordTask(task);
    if(!result||!result.ok)throw Object.assign(new Error(result&&result.error||'生成没有返回可用图片'),{code:'CANVAS_NO_RESULT'});
    return {images:task.outputs,parameters:task.workflowParameters};
  },
  cancel:taskId=>aiCancel(taskId),
  // 10-25：幕布节点「查看」也走预览框（原来直接开老的独立大图窗口，docs/132 §三 定过不再用它）；预览框没加载才退回老窗口
  view:async imageId=>{
    if(window.V7Tween&&typeof V7Tween.showImage==='function'){
      const buf=await window.IMG.fullBytes(imageId);
      V7Tween.showImage(ArrayBuffer.isView(buf)?new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength):new Uint8Array(buf));
      return;
    }
    viewerOpen=true;bigTask=null;bigSendImage(imageId,1,1,true);
  },
  transfer:asset=>new Promise((resolve,reject)=>aiCapture(async data=>{
    try{
      const imageBase64=await new Promise((yes,no)=>{const reader=new FileReader();reader.onload=()=>yes(String(reader.result).split(',')[1]);reader.onerror=()=>no(reader.error);reader.readAsDataURL(asset.full);});
      await linkQueue('ps.layer.place',{imageBase64,targetDocId:data.docId,targetSelection:aiClonePlain(data.selection),strictTarget:true,layerType:settingsRuntime.layerType||'smartObject'},{after:resolve,afterError:result=>reject(new Error(linkResultMessage(result)))});
    }catch(error){reject(error);}
  },0,result=>reject(new Error(linkResultMessage(result))),{allowFullCanvas:true}))
});
V7ReturnLab.configure({
  scope:cacheNamespaceId,
  bridge:async(action,params)=>{const result=await linkOnce(action,params);if(!result.ok)throw new Error(result.error);return result.data;},
  error:error=>ERR.report('RETURN_PROBE_FAILED',{message:String(error?.message||error)}),
  copy:async text=>{if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const input=document.createElement('textarea');input.value=text;document.body.append(input);try{input.select();if(!document.execCommand('copy'))throw new Error('复制失败，请从报告文本框手动复制');}finally{input.remove();}}
});
V7CardArchitecture.configure({
  navigate:navigateCard,routeOptions:()=>cardRouteOptions,
  mountProjectRecords,
  settingsMarkup:legacySettingsMarkup,bindSettings:bindSettingsDetail,
  // ⭐ 生成卡自带的「生成与传回设置」（2026-10-01 真搬家）。
  //   ⚠ 以前是 card-architecture 的 generation() 用 source(1) 从设置卡借 ——
  //     那叫借用不叫搬家（改一边动两边）。现在生成卡自己有定义。
  generationMarkup:generationMarkup,
  // ⭐ 2026-10-05：设置卡「对齐与校色」页的两根接线。
  //   ⚠ 内容源就是下面这两个函数（enginesCapSettingsHtml/Bind 的 align 分支）——
  //     单一真源。外挂卡那边已改成"只放一个跳过来的按钮"，不再自己出一份控件。
  alignSettingsMarkup:()=>enginesCapSettingsHtml('align'),
  alignSettingsBind:body=>enginesCapSettingsBind(body,'align'),
  // ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：设置卡「传回」页的内容源。
  //   ⚠⚠ 必须在这里暴露 —— card-architecture.js 是【另一个文件】，
  //     它只认 host 上挂的东西。第一版我写了 returnSettingsMarkup() 却没暴露，
  //     结果那一页的格子是空的，而且【一句错都不报】（探针才抓到）。
  //     同一个坑上面 alignSettingsMarkup 那条注释已经记过一次。
  returnSettingsMarkup:returnSettingsMarkup,
  // ⭐ 调试卡自带的标记（2026-10-01）：那几段原来长在设置 zone 3 里，
  //   搬家后设置那份删了，调试卡必须自带，否则取 null 崩。
  debugMarkup:debugMarkup,
  mountCache:host=>window.V7CacheSettings&&window.uiwin?.cache?V7CacheSettings.mount(host,{cache:uiwin.cache,canMigrate:()=>!(taskList||[]).some(task=>task&&!aiTaskIsTerminal(task)),afterChanged:()=>broadcastRecordsChanged(),confirm:message=>new Promise(resolve=>UI.dialog({title:'请确认',body:String(message||''),confirm:'继续',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)}))}):null,
  bindLogs:bindLogDetail,
  refreshLogs:(body,kind)=>{const panel=body.querySelector('[data-log-zone]');if(panel&&kind!==undefined)panel.dataset.logZone=String(kind);refreshLogDetailInPlace();},
  error:error=>ERR.report('LAYOUT_FAILED',{message:String(error?.message||error)})
});
V7MainCardShortcuts.configure({
  navigate:navigateCard,settings:()=>settingsRuntime,settingsScope:settingsStorageKey,
  readSetting:(node,input)=>settingsReadFields(node,input),cacheAvailable,
  // ⚠ 这里原来传 history:loadMainCardHistory —— 那个函数每次把整个 cache 目录扫一遍，
  //   扫完的结果交给 refreshRecordsFace，而宿主从来没实现过那个回调，纯白扫（2026-09-30 删）。
  inTaskbar:row=>taskList.some(task=>task.cacheProject===row.project&&task.cacheRunId===row.runId),
  restoreHistory:row=>cacheOwnsEntry(row)?cacheRestoreOne(row):Promise.resolve(false),
  openPerformance:openPerfCard,copyLogs:copyLogText,
  debugSummary:()=>linkRuntime.logs.length+' 条日志 · '+(settingsRuntime.debugMode?'详细日志已开启':'详细日志已关闭'),
  // ⭐ 设置卡正脸（总览）要的真值（2026-10-01）。⚠ 只给真能读到的：
  //   · 积分只用现成缓存（generationPointsCache），不为了正脸单独打后端
  //   · 服务商"已配置"跟 V7Setup.providerConfigured 同一个判定，别另起一套
  //   · 没有后端连通状态可给 —— 项目里没人测过，正脸那行就不画点
  settingsSummary:()=>{
    const account=window.V7Backend?.state?.()||{};
    const balances=generationPointsCache?.balances;
    return {
      signedIn:!!account.signedIn,email:account.account?.email||'',
      points:balances?{common:Number(balances.common||0),banana:Number(balances.banana||0)}:null,
      providerLabel:(window.V7ComputeSlots&&V7ComputeSlots.customName(settingsRuntime.computeSlotNames,settingsRuntime.provider==='other'&&settingsRuntime.otherConnection==='grs'?'grs':settingsRuntime.provider))||({aji:'AJI',momo:'MOMO',other:'Others'})[settingsRuntime.provider]||String(settingsRuntime.provider||'未选'),
      providerReady:aiProviderReady(),
      imageSource:settingsRuntime.imageComputeSource,flowSource:settingsRuntime.workflowSource,
      backendUrl:settingsRuntime.backendUrl,
      checkpoint:settingsRuntime.checkpointEnabled===true,
      blur:Number(settingsRuntime.blur)||0,
      noTint:settingsRuntime.themeNoTint===true,
      // ⭐ 2026-10-14：正脸的「自由摆放」标签要显示真状态 —— 以窗口当前是不是自由模式为准
      //   （退出失败时窗口可能还停在自由模式，存的偏好和真实状态会不一致，以真实为准）。
      freeMode:window.V7FreeMode?V7FreeMode.isActive():settingsRuntime.freeMode===true,
      // ⭐ 2026-10-15：设置卡正脸新加的几个标签读这些（main-card-shortcuts.js SETTINGS_TAGS）
      autoGroup:settingsRuntime.autoGroup===true,autoAlign:settingsRuntime.autoAlign===true,
      sound:settingsRuntime.soundEnabled===true,hoverPreview:settingsRuntime.hoverOpensPreview===true,
      feather:settingsRuntime.returnFeather===true,cacheGB:Number(settingsRuntime.cacheCapacityGB)||0,
      shortcut:formatShortcutValue(settingsRuntime.generationShortcut||'')||'没设'
      // ⚠ 2026-10-14：这里原来还有一行 hints:!!window.V7Tutorial?.hintsEnabled?.()
      //   —— 给设置卡正脸那个「教程提示」tag 读状态的。教程整块删了，这一行跟着删。
      //   ⚠ 它是【可选链】写的（?.），所以就算忘了删也不会抛 —— 属于"不会报错的脏东西"，
      //     更要主动清掉。重做教程时加回来，见 docs/217。
    };
  },
  error:(code,error)=>ERR.report(code,{message:String(error?.message||error)})
});
V7NetworkDoctor.configure({settings:()=>({backendUrl:settingsRuntime.backendUrl,comfyUrl:settingsRuntime.comfyUrl})});
V7AccountCenter.configure({navigate:section=>navigateCard('settings',0,{section})});
// ⭐ 2026-09-29 方案 B：项目卡重排后 index 变了（0 项目管理 / 1 本项目记录 / 2 拍摄日程 / 3 Eagle 归档）。
//   ⚠ 这张表是第二处没跟着重排的旧映射 —— 早先是 ['projects','schedule','eagle']，
//     open('schedule') 会落到第 2 格（现在是「本项目记录」），日程页再也打不开。
V7ProjectSchedule.configure({navigate:section=>navigateCard('projects',{projects:0,schedule:2,eagle:3}[section]??0)});
// ⚠⚠ 2026-10-14 改（删「使用教程」卡时踩出来的）：这里原来是
//     V7Manual.configure({navigate:topic=>navigateCard('tutorial',3,{topic})});
//   —— 手册里点一条主题，跳到【教程卡的第 3 格】。教程卡整张删了 ⇒
//   navigateCard('tutorial',…) 会报「找不到功能主卡：tutorial」，
//   **手册里的主题链接就全点不动了**（而且手册本身是从设置卡进的，用户会以为手册坏了）。
//   ⇒ 现在【不配 navigate】：manual-center.js 的 open(id) 在没有 navigate 时
//     会自己建一个浮层（那正是它的第一分支），主题链接照样能翻页。
//   ⚠ 重做教程卡时可以把 navigate 配回去，让手册回到"占卡的一格"那种形态（见 docs/217）。
V7Manual.configure({});
V7AssistantPanel.configure({navigate:section=>navigateCard('assistant',0,{section:String(section||'chat')})});
// ⭐ 2026-10-17 夏三六：主卡卡面 / 悬浮框要跳进二级某一节（chat / model / starts …）走同一条路
if(window.V7AgentZone)V7AgentZone.configure({navigate:section=>navigateCard('assistant',0,{section:String(section||'chat')})});
// ⭐ 2026-10-18 深夜：问题反馈卡 —— 卡面现在就画；没登录点发送时带去「设置 → 登录账号」
if(window.V7Feedback){
  V7Feedback.configure({
    navigate:section=>navigateCard('feedback',0,{section:String(section||'write')}),
    login:()=>navigateCard('settings',0,{section:'account'}),
    report:error=>ERR.report('UI_ACTION_FAILED',{message:'问题反馈卡：'+String(error&&error.message||error)})
  });
  try{ document.querySelectorAll('[data-feedback-face]').forEach(node=>V7Feedback.renderFace(node)); }catch(e){ console.warn('[问题反馈] 卡面渲染失败',e); }
}
// ⭐ 2026-10-20：社区卡 —— 卡面现在就画（没登录时卡面自己说「登录后能看」）
if(window.V7Community){
  V7Community.configure({
    navigate:section=>navigateCard('community',0,{section:String(section||'rank')}),
    login:()=>navigateCard('settings',0,{section:'account'}),
    // 进社区：跟设置卡「社区」那一节同一条路（先要进门条子再开浏览器）
    openWeb:async()=>{
      const info=await window.V7Backend?.publicCommunity?.();
      const url=String(info&&info.url||'').trim();
      if(!/^https?:\/\/[^/\s]+/i.test(url)) return {ok:false,message:'社区网页还没开放（后台「社区网址」没配）。'};
      if(!window.V7CardArchitecture?.openCommunity) return {ok:false,message:'这个版本还不能从这里进社区。'};
      return V7CardArchitecture.openCommunity(url);
    },
    importItems:items=>window.PRESETUI&&typeof PRESETUI.importItems==='function'?PRESETUI.importItems(items):Promise.reject(new Error('预设库还没准备好')),
    report:error=>ERR.report('UI_ACTION_FAILED',{message:'社区卡：'+String(error&&error.message||error)})
  });
  try{ document.querySelectorAll('[data-community-face]').forEach(node=>V7Community.renderFace(node)); }catch(e){ console.warn('[社区] 卡面渲染失败',e); }
}

if(window.V7LayoutManager)V7LayoutManager.configure({
  applyCards:applyLayoutCards,
  active:layoutActiveId,
  recoveryCard:'settings',
  navigateToLayout:()=>navigateCard('settings',2,{section:'layout'}),
  appearance:layoutAppearance,
  applyAppearance:layoutApplyAppearance,
  error:error=>window.ERR?.report('LAYOUT_FAILED',{message:String(error?.message||error)})
});
function openSetupSettings(zone){
  if(zone===3)return navigateCard('assistant',1);
  // Checkpoint capacity is rendered in Settings → 存储与检查点 (zone 3).
  // Older callers passed 1 for this action; keep that argument compatible but
  // route it to the actual owner page instead of the interaction settings.
  if(zone===1)return navigateCard('settings',3,{section:'storage'});
  return navigateCard('settings',zone,{section:zone===0?'own':''});
}
if(window.V7Setup){
  V7Setup.configure({openEmbedded:()=>navigateCard('settings',0,{section:'photoshop'}),providerConfigured:()=>aiProviderReady(),openProvider:()=>openSetupSettings(0),openAssistant:()=>openSetupSettings(3),openGuide:()=>window.V7Manual?.open('start'),autoOpen:!new URLSearchParams(location.search).has('ui-test')&&!window.__V7_TUTORIAL__});
  V7Setup.boot().catch(error=>ERR.report('SETUP_OPERATION_FAILED',{message:String(error.message||error)}));
  // ⭐ 2026-10-08：「下次自动开」在这里生效。
  //   ⚠ 延后 6 秒再跑 —— 开机瞬间有引导、连接检查、模型清单好几件事在抢网络和磁盘，
  //     这时候去下 3GB 会让整个软件看起来卡住（用户会以为坏了）。
  //     6 秒之后用户已经能看到界面了，进度线也就能正常显示出来。
  //   ⚠ 勾了但加速档已经就绪时，它一个字都不做（见 tryAutoAccel 里的判断）。
  setTimeout(()=>{ try{ tryAutoAccel(); }catch(_){ } },6000);
}

// Keep in-memory task/preset/theme state aligned when the account changes
// without closing the desktop window. Old task cards must never remain visible
// after a logout or a switch to another account namespace.
window.addEventListener('wheelchair:storage-context', function () {
  window.V7FreeMode?.rebind();
  const scope=settingsStorageKey(),epoch=++settingsContextEpoch;
  detailFillSeq++;cardRouteEpoch++;
  window.UISelect?.close();cardRouteOptions={};
  const body=document.getElementById('dcBody');
  V7CardArchitecture.reset(body);delete body.dataset.cardRoute;delete body.dataset.settingsScope;
  sourceImageEpoch++;
  sourceImageRegistering.clear();
  try{if(settingsVault)settingsVault.clear();const serviceUrl=settingsRuntime.backendUrl;Object.assign(settingsRuntime,SETTINGS_DEFAULTS,{backendUrl:serviceUrl});settingsLoad();settingsMigrateShortcutsNone();settingsMigrateRunningHubOff();settingsMigrateColorDefaultOff();settingsMigrateAlignFlowOff();settingsMigrateLineMode();settingsSyncAiRuntime();settingsApplyAppearance();shortcutApplyIfChanged();loadSettingsSecrets();}catch(e){settingsVaultError(e);}
  try {
    (taskList || []).forEach(function (task) {
      if(task){
        task.cancelRequested=true;
        if(task.status==='running'||task.status==='queued'){
          try{const pending=task.workflow&&window.V7Workflows?V7Workflows.cancel(task.id):window.uiwin?.ai?.cancel?.(task.id);if(pending&&pending.catch)pending.catch(()=>{});}catch(_){}
          try{if(window.V7QwenMode)V7QwenMode.cancel(task.id).catch(()=>{});}catch(_){}
        }
      }
      if (task && task.timer) clearTimeout(task.timer);
      if (window.IMG && typeof window.IMG.release === 'function') {
        taskImageIds(task).forEach(function (id) { try { window.IMG.release(id); } catch (_) {} });
      }
    });
    taskList.length = 0;
    if (typeof aiRuntime === 'object') {
      aiRuntime.currentTaskId = '';
      aiRuntime.outputs = [];
      aiRuntime.queue = [];
      aiRuntime.activeTasks = Object.create(null);
    }
    setTasks();
  } catch (_) {}
  try { if (window.BG && window.BG.rebindStorage) window.BG.rebindStorage(); } catch (_) {}
  // ⭐ 2026-10-17 夜：生成那几样（模型 / 尺寸 / 比例 / 张数 / 提示词…）按新账号重读（见 aiReloadTempCacheForAccount）。
  //   ⚠ 必须排在下面 PRESETUI.rebindStorage() 之前：它会把新账号提示词框里显示的内容同步过来，显示的要最后说了算。
  try { if (typeof aiReloadTempCacheForAccount === 'function') aiReloadTempCacheForAccount(); } catch (_) {}
  try {
    if (window.PRESETUI && window.PRESETUI.rebindStorage) {
      window.PRESETUI.rebindStorage().then(()=>{if(epoch===settingsContextEpoch&&scope===settingsStorageKey()&&cur===CARD_PRESETS&&detail.classList.contains('show'))fillDetailBody(false);}).catch(function () {});
    }
  } catch (_) {}
  queueMicrotask(()=>{
    if(epoch!==settingsContextEpoch||scope!==settingsStorageKey())return;
    renderGenerationCardFields();renderSettingsCardFields();renderEnginesCardFields();
    zoneSel=Math.min(zoneSel,Math.max(0,ZONE_SETS[cur].length-1));fillZonesNow();
    if(cur!==CARD_PRESETS&&detail.classList.contains('show'))fillDetailBody(false);
  });
  setTimeout(function () { if (typeof cacheRestoreTasks === 'function') cacheRestoreTasks(); }, 0);
});

