// ═══ ui-main/04-tasks.js —— 主界面主程序第 4 / 21 段 ═══
//   管什么：外挂能力卡卡面 · 任务卡（虚拟任务 / 抠像任务卡 / 操作行 / 版本切换）· 指哪抠哪 · 渲染单张任务卡 · 叠压布局
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ⭐ 外挂能力卡卡面（2026-10-04 深夜重排）。
//   ⚠⚠ 卡面现在是【一张总表】：横轴三档、纵轴能力，格子里写"这一档下它是什么形态"。
//     结构比上一版简单得多 —— 只有一个 .ec-stack，表头和数据行都由
//     V7EnginesCard 自己建（它才知道有几样能力、当下是哪一档）。
//   ⚠ 这里【不再有】.ec-legend / .el-cur / .el-hint：
//     上一版顶部那行"当前 N 档 xxx"和"点档位看详情"已经并进表头了
//     （选中哪一档 = 那一列亮绿，状态写在档位名下面一行）。
//     留着这三个节点的话，卡里会飘着一行没有任何 JS 去填的空元素。
//   ⚠⚠ 卡面骨架【一次建好、常驻】，之后只切 class（docs/12 坑 17）。
//     这里只保证宿主节点在，真正的表由 V7EnginesCard 自己建。
function renderEnginesCardFields(){
  const host=document.querySelector('.block-card[data-card="engines"] [data-engines-fields]');
  if(host){
    // 幂等：已经建过就不重建（重建会把动画一起打断）
    if(!host.querySelector('.ec-stack')){
      host.innerHTML='<div class="ec-stack"></div>';
    }
    const card=enginesCardMount();
    if(card) card.reload();
  }
}
// 卡面控件的事件绑定。⚠ 和设置页共用 settingsReadFields —— 不要另写一套读值逻辑，
//   否则两边对同一个键的解析会漂（铁律 16 那类"以为调过了"的来源）。
// ⚠⚠ 2026-10-11 审计修：加"已绑过就不再绑"的标记。
//   起因（docs/207 记的那处低危冗余）：调色控件拖一下颜色，applyThemeColors 会跑【2 次】——
//     ① 本函数给所有 [data-setting] 挂了 input/change
//     ② 下面「调色控件」那段又给 input[type=color][data-setting] 【单独】挂了 input
//   实测：拖色时 settingsReadFields 跑 0 次、applyThemeColors 跑 1 次；
//         但派发 change 时 applyThemeColors 跑【2 次】（通用 sync + 颜色自己的重绘）。
//   多刷一遍肉眼看不出来，但它是"同一件事被两处驱动"的结构性问题：
//   将来谁改了主题重绘的入口，很容易只改一处、另一处继续用旧逻辑跑。
//   ⇒ 用 WeakSet 按元素去重（不是按选择器）——同一个元素绑第二次直接跳过。
//     ⚠ 为什么不直接把下面那段颜色绑定删掉：那段还要做
//       removeAttribute('data-unset') 和启用「默认」按钮，是它的独有职责。
//       去重的正确位置是"绑定"这个动作本身。
const boundFieldInputs=new WeakSet();
function bindCardFieldInputs(root){
  root.querySelectorAll('[data-setting]').forEach(el=>{
    if(boundFieldInputs.has(el))return;      // 已经绑过：同一次挂载里别重复挂
    boundFieldInputs.add(el);
    const sync=()=>{
      settingsReadFields(root);
      renderSettingsCardFields(); renderEnginesCardFields();
    };
    el.addEventListener('change',sync);
    el.addEventListener('input',sync);
  });
}

// 生成卡底部那串实时信息：张数 · 分辨率 · 比例 · 模型（用户 2026-09-13 定的顺序）。
// ⚠ try/catch 兜底：这是显示信息，读不到不能影响叠卡布局。
function generationFootInfo(){
  try{
    const r=(typeof aiRuntime==='object')?aiRuntime:{};
    if(r.workflowPresetId){
      const p=window.PRESETS&&PRESETS.presetById(r.workflowPresetId);
      return [(r.batch||1)+' 张',p&&/^(rh|runninghub)$/.test(p.provider)?'RH':'ComfyUI',r.workflowParameters&&r.workflowParameters.resolution?String(r.workflowParameters.resolution)+'px':''].filter(Boolean).join(' · ');
    }
    // 千问模式（2026-10-16）：模型锁成千问 2.1，卡底写它而不是原来那个 Banana 模型名
    const qwen=typeof qwenCardActive==='function'&&qwenCardActive();
    return [ (r.batch||1)+' 张', r.size||'2K', r.aspectRatio||'Auto', qwen?'ComfyUI 工作流':(r.model||'') ]
      .filter(Boolean).join(' · ');
  }catch(_){ return ''; }
}

function setStack(){
  const freeMode=window.V7FreeMode&&window.V7FreeMode.isActive();
  if(freeMode){
    window.V7FreeMode.activate(window.V7FreeMode.cardUnitId(cards[cur].dataset.card));
    cards.forEach((c,i)=>{
      if(layoutHidden.has(i)){c.hidden=true;c.style.display='none';c.style.pointerEvents='none';c.style.visibility='hidden';c.classList.remove('stack-overflow-hidden');return;}
      c.hidden=false;c.style.display='';
      c.style.visibility='visible';
      c.classList.remove('stack-overflow-hidden');
      const id=window.V7FreeMode.cardUnitId(c.dataset.card);
      const unit=window.V7FreeMode.unit(id);
      c.classList.toggle('is-current',i===cur);
      c.style.zIndex=String(window.V7FreeMode.zIndex(id));
      c.style.opacity='1';
      const dim=c.querySelector('.bc-dim');if(dim)dim.style.opacity='0';
      c.style.setProperty('--collapse-delay','0s');
      c.style.left=(unit?unit.x:0)+'px';c.style.top=(unit?unit.y:0)+'px';
      c.style.transform='none';c.style.pointerEvents='auto';
      const kind=c.dataset.card;
      if(kind==='generation'){const gi=c.querySelector('.gc-foot-info');if(gi)gi.textContent=generationFootInfo();}
    });
    window.V7FreeMode.applyPositions();
    window.V7StackOcclusion?.sync();
    updateCollapsePill();
    return;
  }
  const visible=layoutVisibleIndices();
  const count=Math.max(1,visible.length);
  const currentPos=Math.max(0,visible.indexOf(cur));
  cards.forEach((c,i)=>{
    if(layoutHidden.has(i)){c.hidden=true;c.style.display='none';c.style.pointerEvents='none';c.style.visibility='hidden';c.classList.remove('stack-overflow-hidden');return;}
    c.hidden=false;c.style.display='';
    const pos=visible.indexOf(i);
    const d=(pos-currentPos+count)%count;    // 0=顶层, 越深越靠后
    c.classList.toggle('is-current', d===0);
    // 超过四层的卡仍留在轮换序列中，但不再绘制无效的重叠内容。
    // visibility 保留原矩形，避免改变堆叠几何和 buriedCardAt() 的坐标合同。
    const overflowHidden=d>=MAX_STACK_VISIBLE;
    // Keep the class as a stable depth marker, but let CSS decide whether it
    // is actually hidden. This preserves the historical 100% appearance and
    // lets settingsApplyAppearance() restore it by removing the dataset only.
    c.classList.toggle('stack-overflow-hidden',overflowHidden);
    c.style.visibility='visible';
    c.style.zIndex = count-d;
    // ⭐⭐ 2026-09-13 用户定案：**不是"透明"，是"暗"** —— 这两件事不一样：
    //     透明(opacity) = 能看穿到后面去 → 下面那张的标题和背景糊在一起，看不清
    //     暗(压一层黑)  = 不透明，只是像被压在阴影里 → 层次有了，字还看得清
    //   所以 opacity 恒为 1，靠上面那层 .bc-dim 越往下压得越黑。
    c.style.opacity = 1;
    const clamped=Math.min(d,stackVisibleDepth(count));
    const dim=c.querySelector('.bc-dim');
    if(dim) dim.style.opacity = Math.min(0.62, clamped*0.2);   // 深度每加一层暗 20%，封顶 62%
    // 卡面底栏的实时信息 —— 切卡时刷新（引擎在不在线、开了哪些开关都会变）
    const kind=c.getAttribute('data-card');
    if(kind==='generation'){
      const gi=c.querySelector('.gc-foot-info');
      if(gi) gi.textContent=generationFootInfo();
    }else if(kind==='settings'){ try{ renderSettingsCardFields(); }catch(_){ } }
    else if(kind==='engines'){ try{ renderEnginesCardFields(); }catch(_){ } }
    // 折叠收回沿堆叠深度做很轻的错落，仍是整卡整体滚动，不拆成逐元素动画。
    c.style.setProperty('--collapse-delay', (d * 0.03) + 's');
    const off = clamped*STEP;
    // 只往下平移, 不往右 → 宽度始终=卡的宽度; 露边加大 + 透明度提高, 后面卡清晰可见
    c.style.transform = `translate(0, ${off}px)`;
    // ⚠ 层次全靠阴影：被压住的卡【上缘】加一道内收阴影 = "上面压着东西"，
    //   顶层那张投得最重（它压着下面所有卡）。同任务堆的做法。
    const buried=d>clamped;
    c.style.boxShadow = buried ? 'none' : d>0
      ? '0 -6px 18px rgba(0,0,0,.42), 0 10px 28px rgba(0,0,0,.22)'
      : '0 18px 50px rgba(0,0,0,.45)';
    // ⚠ 只有顶层(d=0)那张能交互 —— 否则叠压在下面露边的卡片也能点到它的按钮(bug)。
    //   CSS 里 .block-card{pointer-events:auto} 是给所有卡开的, 这里按深度纠正。
    c.style.pointerEvents = (d===0) ? 'auto' : 'none';
  });
  window.V7StackOcclusion?.sync();
  updateCollapsePill();
}
setStack();

// 主卡核心按钮：点了直接展开这张卡的分区。
// ⚠ 原来这里还有一条"弹一句（占位）"的兜底分支，是给修图/特效/合成/上课四张
//   占位卡用的。那四张卡已于 2026-09-08 删除(docs/22)，兜底分支跟着删 ——
//   留着的话，以后加回真卡片时忘了接线，会安静地退化成假按钮。
cards.forEach(card=>{
  const core=card.querySelector('.bc-corebtn');
  if(!core) return;
  core.addEventListener('click', e=>{
    e.preventDefault(); e.stopPropagation();
    cur=Number(card.dataset.b)||0;
    setStack();
    fillZonesNow();
    zoneOpen=true;
    zones.classList.remove('closing');
    zones.classList.add('show');
    detail.classList.remove('show');
    detail.classList.remove('closing');
    detailUsed=false;
  });
  const taskTest=card.querySelector('[data-task-test]');
  if(taskTest) taskTest.addEventListener('click', e=>{
    e.preventDefault(); e.stopPropagation();
    addTask(makeVirtualTask());
  });
});

// ═══════════════════════════════════════════════════════════
//  任务区 —— 数据驱动版
//  任务不是常驻的: 由正式业务调度接口添加, 10~20 秒后自动消失。
//  入场: 从主卡下方"分离"进入(Apple 语言) → 新任务加在堆叠顶部
//  出场: 向下滑出
// ═══════════════════════════════════════════════════════════
const PER = 4;              // 预览一行最多几张
const MAX_SHOTS = 16;       // 单个任务最多几张图
// ⭐⭐⭐ 2026-10-08（docs/170 §十四 · 用户拍板）：启动时【一次性】清掉历史遗留的插帧文件。
//
//  背景：插帧帧以前会落盘（10-05 那版「省下次重算」），实测攒了
//    3348 个 tween_* 文件 / 22.80 GB。用户 10-08 拍板不再存硬盘，
//    所以这些遗留文件这辈子不会再被用到 —— 清掉把空间还给他。
//
//  ⚠ 只清一次：localStorage 记个标记。每次启动都扫一遍几千个文件的目录，
//    会让开机变慢，而这件事第二次做时已经无事可做。
//  ⚠ 清了要【告诉用户】：「清理了 N 个插帧缓存文件、释放 X GB」——
//    悄悄删掉几个 G 是个很坏的体验（用户会以为软件在偷他的东西）。
//  ⚠ 删的是【插帧帧文件】，绝不碰成品/底版/原图（Rust 那边白名单式判定保证）。
//  ⚠ 失败不报错、不打断启动：它只是清垃圾，清不动不该挡着用户用软件。
async function purgeLegacyTweenFilesOnce(){
  const FLAG = 'tween.legacyPurged.v1';
  try{ if(window.localStorage && localStorage.getItem(FLAG)) return; }catch(_){ return; }
  const cache = window.uiwin && window.uiwin.cache;
  if(!cache || typeof cache.purgeTweenFiles !== 'function' || typeof cache.list !== 'function'){
    // ⚠ 接口不在（测试环境 / 老客户端）⇒ 不打标记，下次启动还会再试
    return;
  }
  let removed = 0, bytes = 0;
  try{
    const listing = await cache.list();
    const runs = (listing && listing.runs) || [];
    for(const run of runs){
      if(!run || !run.project || !run.runId) continue;
      // 一轮一轮地清；Rust 那边每次有上限（默认 400），避免长时间占着缓存
      for(let guard = 0; guard < 50; guard++){
        const res = await cache.purgeTweenFiles({
          namespaceId: String((run.meta && run.meta.namespaceId) || ''),
          project: run.project, runId: run.runId, batch: 400,
        });
        if(!res || res.ok !== true) break;
        removed += Number(res.removed) || 0;
        bytes += Number(res.bytes) || 0;
        if(!res.remaining) break;      // 这一条清干净了
      }
    }
  }catch(e){
    // ⚠ 不报错、不打断启动；也不打标记（下次启动再试）
    return;
  }
  try{ if(window.localStorage) localStorage.setItem(FLAG, '1'); }catch(_){}
  if(removed > 0){
    const gb = (bytes / 1073741824).toFixed(2);
    // ⚠ 必须说：用户有权知道删了什么、释放了多少
    if(typeof UI !== 'undefined' && UI.toast){
      UI.toast('已清理 ' + removed + ' 个插帧缓存文件 · 释放 ' + gb + ' GB', 'info', 4200);
    } else if(typeof log === 'function'){
      log('插帧缓存清理：' + removed + ' 个文件 · ' + gb + ' GB');
    }
  }
}
const tasksEl = document.getElementById('tasks');

let taskList = [];          // [{ id, label, icon, shots:[{done}], pct, status, sub, timer }]
let browserTaskLockController=null;
function refreshBrowserTaskLock(){
  if(!window.V7BrowserPreferences||!window.uiwin?.browser||typeof taskList==='undefined')return;
  try{
    if(!browserTaskLockController)browserTaskLockController=V7BrowserPreferences.createTaskLock({onChange:state=>{try{const request=window.uiwin.browser.taskLock(!!state.locked);if(request&&typeof request.catch==='function')request.catch(()=>{});}catch(_){}}});
    const preferences=window.V7BrowserBookmarks?.read?.()||V7BrowserPreferences.defaults();
    const count=taskList.filter(task=>task&&!aiTaskIsTerminal(task)).length;
    browserTaskLockController.update({idleLock:preferences.idleLock,taskCount:count});
  }catch(error){try{browserTaskLockController?.update({idleLock:true,taskCount:null});}catch(_){};if(window.ERR)ERR.report('BROWSER_PREFERENCES_FAILED',{message:String(error.message||error)});}
}
if(window.V7CommunityPresence)window.V7CommunityPresence.configure({hasPendingGeneration:()=>taskList.some(task=>task&&task.kind==='generation'&&!aiTaskIsTerminal(task))});
let tcur = 0;               // 当前显示的任务下标
let taskSeq = 0;            // 自增 id

// 随机任务类型池(与主卡的五个区块呼应)
// 2026-10-22（docs/263 §1.5）：图标一律用 ICON 的矢量名，不再用 emoji
//   （emoji 各系统长得不一样、不跟主题色、会把行高撑歪）。
const TASK_TYPES = [
  { label: '修图·调色', icon: 'palette' }, { label: '修图·裁剪', icon: 'scissors' },
  { label: '修图·抠图', icon: 'broom' }, { label: '修图·精修', icon: 'sliders' },
  { label: '特效·光效', icon: 'bulb' }, { label: '特效·氛围', icon: 'fog' },
  { label: '特效·风格', icon: 'film' }, { label: '合成·拼接', icon: 'thread' },
  { label: '合成·蒙版', icon: 'mask' }, { label: '合成·多重曝光', icon: 'image' },
  { label: '上课·演示', icon: 'chart' }, { label: '上课·讲义', icon: 'note' }
];
const SIZES = ['1K', '2K', '4K'];

// 生成任务统一标准：所有生成请求都必须先创建任务卡，再进入提交/执行阶段。
// 任务卡是唯一的用户可见进度载体，状态只允许 queued/submitting/running/done/failed/cancelled。
const GENERATION_TASK_STANDARD = Object.freeze({
  version: 'v7-generation-task-1',
  states: Object.freeze(['queued','submitting','running','done','failed','cancelled']),
  required: Object.freeze(['provider','model','size','aspectRatio','batch','prompt']),
  errorShape: Object.freeze(['code','level','stage','message','raw'])
});

// 占位缩略图
function placeholderSVG(hue){
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${hue+40},60%,40%)"/></linearGradient></defs><rect width="84" height="84" fill="url(#g)"/><text x="42" y="48" font-size="16" fill="rgba(255,255,255,.7)" text-anchor="middle">IMG</text></svg>`);
}
function escapeHtml(value){
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[ch]);
}

// ── 建一个虚拟任务(随机类型 / 随机张数 / 随机存活时长) ──
function makeVirtualTask(){
  const t = TASK_TYPES[Math.floor(Math.random() * TASK_TYPES.length)];
  const n = 1 + Math.floor(Math.random() * MAX_SHOTS);       // 1~16 张
  const doneCount = Math.floor(Math.random() * (n + 1));      // 已完成几张
  const pct = Math.round(doneCount / n * 100);
  const allDone = doneCount === n;
  // 任务卡背景 = "准备计算的图"(生成流程喂进来的源图)。虚拟任务用占位图模拟。
  const srcHue = Math.floor(Math.random() * 360);
  const sourceImg = placeholderSVG(srcHue);
  return {
    id: ++taskSeq,
    label: t.label,
    icon: allDone ? 'check' : 'hourglass',
    shots: Array.from({ length: n }, (_, i) => ({ done: i < doneCount })),
    pct,
    status: allDone ? 'done' : 'running',
    sub: allDone
      ? `${SIZES[Math.floor(Math.random()*3)]} ×${n} · ${(1 + Math.random()*8).toFixed(1)}s`
      : `进行中 ${doneCount}/${n} · 预计 ${Math.ceil(Math.random()*20)}s`,
    page: 0,
    sourceImg,
    life: 10000 + Math.random() * 10000    // 10~20 秒后自动消失
  };
}

// 任务卡背景(输入图)的唯一登记入口。
// ⚠ 必须过图片管家: 直接把完整 base64 当 CSS 背景 = 21MB 字符串 + 整图解码提主题色,
//   正是 docs/21 要根治的东西; 而且不登记就没有 imgId, 缓存判定"没有输入图",
//   重启后卡片背景会变回占位渐变。
// ⚠ 会被调用两次(建卡时 / 抓到图后), 已经登记过就不重复做。
const sourceImageRegistering = new Map();
let sourceImageEpoch = 0;
function registerTaskSourceImage(taskId, base64, mime){
  if(!base64 || !window.IMG) return;
  const key = String(taskId);
  const find = ()=>taskList.find(t=>String(t.id)===key||String(t.taskId||'')===key);
  const existing = find(), previous = sourceImageRegistering.get(key);
  if(existing && existing.sourceImgId) return;
  if(previous && previous.epoch===sourceImageEpoch && (!previous.task || previous.task===existing)) return previous.pending;
  const operation = {epoch:sourceImageEpoch,task:existing};
  sourceImageRegistering.set(key,operation);
  // makeGenerationTask registers before addTask; bind identity after that synchronous insertion.
  operation.pending = Promise.resolve().then(async()=>{
    if(operation.epoch!==sourceImageEpoch) return;
    const task=operation.task||find(); operation.task=task;
    if(!task || find()!==task || task.sourceImgId) return;
    const imgId=await window.IMG.putFromBase64(base64,mime||'image/png');
    try{
      if(operation.epoch!==sourceImageEpoch || find()!==task || task.sourceImgId) return;
      updateTask(taskId,{sourceImg:window.IMG.thumb(imgId),sourceImgId:imgId});
      // The input thumbnail can finish registering after a terminal task was saved.
      if(!task.restoredFromCache && typeof aiTaskIsTerminal==='function' && aiTaskIsTerminal(task)
        && typeof cachePersistTask==='function') cachePersistTask(task);
    }finally{
      if(operation.epoch!==sourceImageEpoch || find()!==task || task.sourceImgId!==imgId) window.IMG.release(imgId);
    }
  })
    .catch(e=>{ ERR.report('SOURCE_IMAGE_REGISTER_FAILED',{message:String(e&&e.message||e)}); })
    .finally(()=>{ if(sourceImageRegistering.get(key)===operation) sourceImageRegistering.delete(key); });
  return operation.pending;
}
function makeGenerationTask(payload){
  const total=Math.max(1, Math.min(MAX_SHOTS, Number(payload&&payload.batch)||1));
  // 主图始终显示用户可见的正常原图；抗截断后的 inputImageBase64 只作为 Banana 内部输入。
  const sourceBase64=payload&&(payload.sourceImageBase64||payload.inputImageBase64);
  // 生成任务必须保存自己的 Photoshop 来源快照。不要让任务卡在后续抓取/切换文档后
  // 退回读取全局 aiRuntime.capture，否则完成传回会误贴到另一份文档/选区。
  const captureSnapshot=payload&&payload.captureSnapshot ? aiCaptureSnapshot(payload.captureSnapshot) : null;
  const taskId=++taskSeq;
  // 任务卡背景先给占位渐变，缩略图做好了再淡入(updateTask 里本来就有交叉淡入)。
  // ⚠ 以前这里直接把源图的完整 base64 当 CSS 背景挂上去：一张 4K 图 21MB 字符串，
  //   还要跑一次正则清洗、再整图解码去提主题色 —— 全是给一个 300px 宽的卡片背景干的。
  const source=placeholderSVG((taskId*53)%360);
  // ⚠ 建卡时来源快照多半还是 null(真正的抓取在这之后)，所以这里常常登记不上；
  //   aiGenerateNow 拿到快照后会再调一次同一个函数补上。两条路共用一个入口。
  registerTaskSourceImage(taskId, sourceBase64, payload&&payload.inputMime);
  const provider=String(payload&&payload.provider||'Banana');
  const model=String(payload&&payload.model||'未选模型');
  // ⭐ 记录与恢复卡记账用（2026-09-30）。这两个字段只给记录卡算钱/分类用，不参与请求。
  //   ⚠ provider 不够用：V7 只有 aji/momo/other 三种，grs 是 provider='other'
  //     配 connectionSlot='grs'（见 provider-connections.js）。少存 connectionSlot，
  //     记录卡就会把 grs 和自定义服务商混成一笔，价格全错。
  //   computeSource 区分「自己的 key」和「平台积分」—— 后者未必按本地价目表算。
  //   两个都可能缺（老记录/其它入口建的任务），记录卡会退回「以账单为准」兜底。
  const workflowMode=!!String(payload&&payload.workflowPresetId||'')||!!(payload&&payload.workflow);
  // ⭐ 2026-10-16（用户：「使用千问模式下的话，生成任务卡片的右下角还是会显示Banana的渠道」）：
  //   改走千问的单，卡上写「云端 · 千问 2.1」；记账的通道 / 算力来源也按千问记（connectionSlot='qwen'，
  //   记录卡 records-core 认它 →「以账单为准」，不再按阿吉价目表白算一笔钱）。
  //   ⚠ provider / model 原样留着（重新生成要拿它们重发；千问模式还开着就照样改道）。
  const qwenTask=aiWillQwen(payload);
  const computeSource=qwenTask?V7QwenMode.source():String(payload&&payload.computeSource||(workflowMode?settingsRuntime.workflowSource:settingsRuntime.imageComputeSource)||'own');
  const connectionSlot=qwenTask?'qwen':String((aiRuntime&&aiRuntime.connectionSlot)||provider);
  const channelLabel=qwenTask?aiQwenChannelLabel():'';
  return {
    id:taskId, kind:'generation', taskId:String(payload&&payload.taskId||''), antiMode:Math.max(0,Math.min(2,Number(payload&&payload.antiMode)||0)), standard:GENERATION_TASK_STANDARD.version,
    computeSource, connectionSlot, channelLabel,
    // ⭐⭐ 标题【永远显示预设名】（2026-09-13 用户定案）。
    //   优先级：预设名 > 张数·渠道·模型。
    //   理由：任务栏里叠着七八个任务时，"aji · AJbanana3"每一张都长一样，
    //   分不出谁是谁；而"甜美偶像风格面部精修"一眼就知道这是哪一批。
    //   ⚠ 没选预设（手打提示词）时显示【自定义提示词】，**不退回渠道·模型** ——
    //     那两样已经在底栏右边了，标题位再放一遍等于浪费最显眼的位置。
    //
    // 📌 留的口子：以后要接本地微型 LLM，给手打的提示词自动起个名
    //    （比如"甜美偶像风·大眼"），就替换下面这个 taskTitleOf 的兜底分支，
    //    别的地方一个字都不用动 —— 标题的唯一来源就是这里。
    label:taskTitleOf(payload),
    presetTitle:String(payload&&payload.presetTitle||''),
    presetId:String(payload&&payload.presetId||''),presetVersion:String(payload&&payload.presetVersion||''),protocol:payload&&payload.protocol,
    icon:'hourglass', shots:Array.from({length:total},()=>({done:false})),
    pct:0, status:'queued', sub:'准备提交 · '+String(payload&&payload.size||'2K')+' · '+String(payload&&payload.aspectRatio||'Auto')+' · '+total+' 张',
    page:0, sourceImg:source, sourceImgId:'', errorInfo:null, life:0, startedAt:Date.now(),
    captureSnapshot,
    outputs:[], errors:[],
    sourceDocId:captureSnapshot&&captureSnapshot.docId,
    sourceDocName:captureSnapshot&&captureSnapshot.docName,
    sourceSelection:captureSnapshot&&captureSnapshot.selection,
    sourceImageBase64:captureSnapshot&&captureSnapshot.sourceImageBase64,
    inputImageBase64:captureSnapshot&&captureSnapshot.inputImageBase64,
    provider,model,size:payload.size,aspectRatio:payload.aspectRatio,batch:total,prompt:payload.prompt,
    workflow:aiClonePlain(payload.workflow||null),workflowParameters:aiClonePlain(payload.workflowParameters||{}),workflowPresetId:String(payload.workflowPresetId||''),
    // ⭐ Phase F：这单是在"校色引擎没开"的条件下发的 —— 任务卡上给一行非阻断提示
    //   （说明为什么以后切不了底版），不挡生成。
    noMatchEngine:!!(aiRuntime&&aiRuntime.noMatchEngineHint),
    cancelRequested:false,returnState:'idle'
  };
}

// ═══ 抠像任务卡（2026-09-14 下半场）═════════════════════════
//  ⚠ 为什么抠像也要建任务卡：docs/20 写死的规矩 ——
//    "任务卡是用户看到状态的唯一入口"。原来抠像只往日志里写几行字，
//    用户点完看不见任何东西，以为没反应（这就是他报的"没有进入到任务栏"）。
//
//  ⚠ 和生成任务【共用同一套渲染和更新函数】，只有 kind 不一样：
//    进度条、缩略图、报错卡、✕ 收起 全是现成的。
//    唯一要注意的是那些只对生成成立的东西（张数·渠道·模型、传回/提升纹理按钮）
//    都已经按 kind 关掉了 —— 加新的任务种类时照着这条检查一遍。
function makeMattingTask(payload){
  const taskId=++taskSeq;
  const source=placeholderSVG((taskId*53)%360);
  return {
    id:taskId, kind:'matting', taskId:String(payload&&payload.taskId||''),
    // 标题就是那条预设的名字 —— 和生成任务卡同一条规矩（预设名 > 一切）
    label:String(payload&&payload.label||'抠像'),
    presetTitle:String(payload&&payload.label||''),
    icon:'hourglass',
    // 抠像一次就是一张，进度条只有一格
    shots:[{done:false}],
    pct:0, status:'queued', sub:'准备开始 · 等 Photoshop 选区',
    page:0, sourceImg:source, sourceImgId:'', errorInfo:null, life:0, startedAt:Date.now(),
    outputs:[], errors:[],
    // 报错卡的现场信息（见 updateGenerationTask 里按 kind 分流的那段）
    mattingTierName:'', mattingSize:'',
    sourceDocId:null, sourceDocName:'', sourceSelection:null,
    cancelRequested:false, returnState:'idle'
  };
}

function taskErrorInfo(error, stage, code){
  const raw=error&&typeof error==='object' ? error : {message:String(error||'未知错误')};
  const message=String(raw.message||raw.error||error||'未知错误');
  return {code:String(code||raw.code||'TASK_FAILED'),level:'error',stage:String(stage||'unknown'),message,raw};
}

function taskIsDone(status){return status==='done'||status==='success'||status==='completed';}
// ⭐ 2026-10-19（docs/250 第 20 条，用户定）：整单都失败的生成任务给一个「重跑」——原来的提示词、原图、区域原样再发一次，新任务顶掉这张卡。
//   只给「算的时候失败」的：抓图 / 检查参数 / 准备（参考图、前置动作、GRS 取 key）那几步失败的不给 —— 要么没有原图，要么重跑还是一样失败。
//   ⚠ 失败在哪一步记在 errorInfo.stage；重启恢复回来的任务 errorInfo 是空的，看 meta 存的 failedStage（cacheMetaFromTask）。
//   ⚠ 「请求成功、但一张图都没回来」那条路不写 errorInfo（stage 为空）—— 那就是算的时候失败，给。
//   ⚠ 重启恢复回来的工作流任务：工作流本体不进 meta，要靠预设库里还在的同一条预设，不在了就不给。
function taskWasWorkflow(task){
  return !!(task&&(task.workflow||/^(comfyui|forge|runninghub|rh)$/i.test(String(task.provider||''))));
}
function taskRerunEligible(task){
  if(!task||task.kind!=='generation'||task.status!=='failed'||task._rerunning)return false;
  if(task.migration&&task.migration.returnBlocked)return false;
  if((task.shots||[]).some(s=>s&&s.done)||(task.outputs||[]).length)return false;
  const stage=String(task.errorInfo&&task.errorInfo.stage||task.failedStage||'');
  if(['capture','validate','prepare'].indexOf(stage)>=0)return false;
  const snap=task.captureSnapshot;
  if(!snap)return false;
  if(!(snap.inputImageBase64||snap.imageBase64)&&!(task.sourceImgId&&window.IMG&&window.IMG.has(task.sourceImgId)))return false;
  if(!task._rerun&&taskWasWorkflow(task)){
    const preset=window.PRESETS&&typeof PRESETS.presetById==='function'?PRESETS.presetById(task.workflowPresetId):null;
    if(!(preset&&(preset.workflow||preset.forgeWorkflow)))return false;
  }
  return true;
}
// ⭐ 任务卡的操作行（2026-09-13 用户定案）。放在进度和状态文字【下面】单独一行，
//   不挤头部 —— 卡片只有 300px 宽，头部塞不下。
//
// 两个按钮，出现条件都跟着"现在能干什么"走：
//   · 提前结束 —— 还在跑时才有。把【已完成的先传回】，剩下的继续后台算
//   · 传回     —— 有【已完成但还没传回】的图时才有，括号里是张数
//
// ⚠ "提升纹理"（替换/增益）那两个按钮【不在这里】，在缩略图上，
//   而且只在那一张【已经传回 PS】之后才显示 —— 没传回就没有图层可嵌，
//   点了必然撞到"找不到图层"那道阀。这是用户 2026-09-13 指出的，从源头堵住。
function taskActionsHtml(task){
  if(task&&task.kind==='dlss')return '<div class="t-acts"><button class="t-act primary" data-dlss-task type="button">打开 DLSS 任务</button></div>';
  if(!task || !['generation','glow'].includes(task.kind)) return '';
  const running = !aiTaskIsTerminal(task);
  const pending = taskPendingTransfer(task);
  // ⭐⭐ 2026-10-05（docs/143 §五）：任务级「小眼睛」—— 整个任务共用一个开关，
  //   管的是【这一批所有图显示哪一版】：校色版（默认）↔ 底版（掰正了没校色）。
  //
  //   ⚠⚠ 用户拍板：小眼睛是【任务级】的（"整个任务卡一个"），
  //     但存储上仍然是【每张图各存一份 base】—— 这两件事不矛盾：
  //     就像一个总闸控制全屋灯，但每个房间都要有灯泡。
  //   ⚠ 为什么放在 t-acts 这一行、而且【不看 running/pending】：
  //     这一行以前只在"没跑完 / 还有图没传回"时出现，跑完传完就整行收掉。
  //     而切版本恰恰是【跑完之后】才做的事 —— 跟着那两个条件走等于永远看不见它。
  //   ⚠ 老任务（没有 base_N.png）→ 置灰 + 点了弹"缺少文件"，不做迁移（用户拍板）。
  // ⭐⭐ 2026-10-08（docs/170 §4.4 / §4.3 不变量 6、10）：四态版本。
  //   ⚠ 原来这里是 taskColorVersion(task) —— 那个只认 'base'/其余两态，
  //     四态之后必须用 shotCurrentVersion（会把 'colormatched' 归一成自动方式那种）。
  const liveShot = (task.shots||[]).find(s=>s&&s.done) || (task.shots||[])[0] || null;
  const version = shotCurrentVersion(task, liveShot);
  const versionLabel = COLOR_VERSION_LABEL[version] || version;
  const hasBase = taskHasAnyBase(task);
  // 不变量 10：被覆盖过的老单子如实说，别把它叫做"混合"。
  const versionNote = colorVersionNote(task, liveShot);
  const eyeTitle = !hasBase
    ? '这一单缓存里没有底版（老任务或者档 1 算的）—— 缺文件，没法切'
    : (versionNote ? (versionNote + ' —— 点一下选看哪一版')
       : ('现在显示【' + versionLabel + '】—— 点一下选看哪一版（底版 / 全局 / 精准 / 混合，没算过的选了才算）'))
    ;
  // ⚠⚠ 这里【不能加 disabled 属性】：用户拍板"没有底版的老任务，点了要弹窗明说缺少文件"。
  //   被 disabled 的按钮【根本不触发 click】，那条弹窗永远走不到 ——
  //   用户只会看到一个点不动的按钮，以为软件坏了（正好是用户要避免的那种体验）。
  //   ⇒ 视觉上压淡用 .off 类表达，行为上让 click 走进去、由 toggleTaskColorVersion 弹说明。
  // ⚠ 按钮上只放 4 个字的版本名：卡面格子窄（docs/170 §4.8 同样的约束）。
  // ⚠ 用 if/else 而不是三元 —— 三元的分支里【不能夹注释】（注释不产生值，冒号会悬空）。
  let eye = '';
  if(task.kind==='generation'){
    // ⚠ 老任务没底版时：视觉上压淡用 .off，但【不加 disabled】——
    //   被 disabled 的按钮根本不触发 click，那条"缺少文件"的弹窗就永远走不到。
    // ⭐ 2026-10-19（docs/251 第 7 条）：.on 改成「显示的不是生成时那一版」才亮。
    //   以前默认校色，「看底版」就是切走了；默认不校色以后底版就是生成时那张，照老规则每张卡都会亮，意思反了。
    const eyeCls = 't-act t-eye' + (version!==shotAutoVersion(task, liveShot)?' on':'') + (hasBase?'':' off') + (task._colorSwitch?' busy':'');
    // ⚠ 被覆盖的老单子（不变量 10）：按钮上加一个 "?" 记号，
    //   让用户不用悬停也知道有情况。
    const mark = versionNote ? ' ?' : '';
    // ⭐ 2026-10-19（docs/251 第 7 条④）：正在切 / 现算时显示「全局 2/6」（进度记在 task._colorSwitch，重画也不会冲掉）
    const sw = task._colorSwitch;
    const eyeText = sw ? ((COLOR_VERSION_LABEL[sw.version]||sw.version) + ' ' + sw.done + '/' + sw.total) : (versionLabel + mark);
    eye = '<button class="' + eyeCls + '" data-task-eye type="button" aria-haspopup="menu"'
        + ' title="' + escapeHtml(eyeTitle) + '">'
        + escapeHtml(eyeText) + '</button>';
  }
  const rerun = taskRerunEligible(task);
  // ⭐ 10-25（用户定）：「传回」右边加「分割」—— 抠出 AI 新加的东西，带蒙版传回（segment-panel.js，docs/289）。有出好的图就一直在
  const seg = task.kind==='generation' && !!(window.V7SegmentPanel && V7SegmentPanel.eligible(task));
  if(!running && !pending && !eye && !rerun && !seg) return '';
  let h='<div class="t-acts">';
  if(running && task.kind==='generation'){
    h+='<button class="t-act" data-task-finish type="button"'
      +' title="把已经出好的图先传回 Photoshop，剩下的继续在后台算，算完了这里会出现「传回」按钮">提前结束</button>';
  }
  if(pending){
    h+='<button class="t-act primary" data-task-send type="button"'
      +' title="把已经出好、还没传回的图贴进 Photoshop">传回 '+pending+'</button>';
  }
  if(seg){
    h+='<button class="t-act" data-task-segment type="button"'
      +' title="只抠出 AI 新加的东西：调好后回传，图层照常贴、外加一个蒙版（已经传回过的就给那个图层换上蒙版）">分割</button>';
  }
  if(rerun){
    h+='<button class="t-act primary" data-task-rerun type="button"'
      +' title="用这单原来的提示词、原图和区域原样再算一次（不用重新框选）；新任务会顶掉这张卡，失败记录在「记录与恢复」里还留着">重跑</button>';
  }
  h+=eye;
  return h+'</div>';
}

// ── ⭐⭐ 版本切换（docs/143 §五）─────────────────────────────
// 现在显示哪一版。默认校色版。存在 task 上（不是 shot 上）—— 用户拍板"整个任务卡一个"。
function taskColorVersion(task){
  return (task && task.colorVersion==='base') ? 'base' : 'colormatched';
}
// 这一单有没有【任何一张】底版。⚠ "任何一张"是对的口径：
//   整个任务共用一个开关，只要有一张能切，开关就该是能点的
//   （切的时候每张各自处理：有 base 的换、没有的保持原样）。
//   ⚠ 判据用 taskColorVersionAvailable（含"磁盘上有、内存里已释放"那种）——
//     只认内存里的 id 会把"刚生成完就切"误判成"没有底版"（见 versionImgFor 的注释）。
// ⭐⭐ 2026-10-08（docs/170 §4.3 不变量 10）：这一单的校色版是不是【已经被覆盖】？
//
//  背景（实测）：切过底版的老单子里，27 张有 24 张 output_N.png 与 base_N.png 字节完全相同
//   —— 因为旧代码写 output 用的是 shot.imgId，切底版时它变成了底版。
//   （那个 bug 已在本版修掉：写 output 改用 autoImgId）
//
//  ⚠⚠ 判据只能用在【没有版本表的老任务】上：
//     新任务选了"不校色"时 output 本来就等于底版；
//     混合判据阀门全关时结果也可能与底版逐字节相同。
//     拿"字节相同"去判新任务 ⇒ 会把正常单子误标成"被覆盖过"，
//     那又是一种静默不一致。
//
//  ⚠ 文案【不能断言原因】：老任务分不清是"被覆盖过"还是"当时就没校"。
//     所以只说"两个文件完全一样"，把两种可能都写出来。
//
//  返回：'' = 不表示任何异常；否则是要显示给用户的那句话。
function colorVersionNote(task, shot){
  if(!task || !shot) return '';
  // ① 有 autoVersion（新任务）：以记录为准，不做字节比对
  if(shot.autoVersion){
    // ⭐ 2026-10-19（docs/251 第 7 条①）：默认不校色以后「自动方式就是不校色」是常态，不再挂「?」提示
    return '';
  }
  // ② 老任务：只有【确定两个文件都在磁盘上且字节相同】才提示
  //    ⚠ 这里不真去读文件（读两张 4K PNG 太贵，切一次版本卡一下）。
  //      用便宜的信号：没记过 colorImgId 又没有 versions 表 ⇒ 很可能就是被覆盖的那批。
  if(shot.versions) return '';                 // 有版本表 ⇒ 不是老数据
  if(!shot.baseImgId && !shot.baseSaved) return '';   // 没底版 ⇒ 谈不上覆盖
  if(shot.colorImgId && shot.colorImgId !== shot.baseImgId) return '';   // 两个 id 不同 ⇒ 没被覆盖
  return '这一单的校色版和底版完全一样（可能被覆盖过，也可能当时就没校）';
}
function taskHasAnyBase(task){
  return taskColorVersionAvailable(task);
}
// 切版本。三件事（docs/143 §5.2），一件都不能少：
//   ① 换 shot.imgId：colormatched → 用校色那张；base → 用底版
//   ② 作废该批的 tween 帧（否则滚强度看到的是旧版本插出来的帧 —— 静默错误）
//   ③ 清掉 shot.tweenStrength（端点变了，旧的强度百分比不再对应同一张图）
//
// ⚠⚠ 为什么要动 shot.imgId 而不是另外记一个"当前显示 id"：
//   传回（aiTransfer）、记录卡、缩略图【全都读 shot.imgId】。
//   另外记一个字段 = 这三处各要改一次、漏一处就是"传回的图和看到的不一样"
//   这种最难受的静默错误。换个字段名不如换掉那个唯一的真源。
// ⚠ 换之前先把【原来的那张】记下来（shot.colorImgId / shot.baseImgId），
//   不然切过去就切不回来了。
// 把某一版的图【拿到手】，拿不到就从磁盘拉回来。
//
// ⚠⚠ 为什么要这个（2026-10-05 我自己埋的雷，写探针时才发现）：
//   cacheSaveTask 写完 base_N.png 就把 shot.baseImgId 从内存【释放】了
//   （跟 raw 一样 —— 一批 18 张 4K 全留在内存就是几百 MB）。
//   于是【同一场会话里】生成完马上点小眼睛，内存里的 baseImgId 已经没了 →
//   taskHasAnyBase 返回 false → 按钮是灰的、点了弹"缺少文件"，
//   而磁盘上 base_1.png 明明在。用户会说"刚生成完就切不了，重启一下又能切了"。
//
//   ⇒ 换版本时按需从磁盘拉一份回来（跟 cacheRestoreOne 恢复老任务时同一套做法：
//     putFromCache 的第三个参数是【懒加载】，不点开大图就不读磁盘）。
// ⚠ 读不到就是真没有（老任务）→ 返回 ''，由调用方决定怎么提示。
// ══════════════════════════════════════════════════════════
//  ⭐⭐ 2026-10-08（docs/170 §4.3 不变量 2/5/6）：校色的【版本表】
//
//  为什么要它：用户要能在 底版 / 全局 / 精准 / 混合 之间切换对比。
//  每种版本各存各的文件；【自动方式那一种就是 output_N.png，不重复存】。
//
//  ⚠ 三个必须守住的语义（施工和测试都按这几条来）：
//   ① output_N.png = 【生成时自动方式】的结果，生成后【永不被切换改写】
//      （记录卡 / 历史 / 传回都读它。这条以前被破坏过：切底版会把底版写进去）
//   ② shot.imgId     = 【当前显示】的那张（切版本改它）
//      shot.autoImgId = 【自动方式】那张的 id（切版本绝不碰它）
//   ③ shot.versions  = 每个版本各自的图片 id，按需惰性填
//      shot.autoVersion = 生成时用的那种（跳过校色则为 'base'）
//
//  ⚠ 兼容旧值（不变量 6）：task.colorVersion 的 'colormatched' 视为 autoVersion，
//     'base' 不变。老任务没有 versions 表，按需惰性补。
// ══════════════════════════════════════════════════════════
// 四态的顺序 = 轮换顺序（不变量之外的界面约定，见 §4.4）
const COLOR_VERSIONS = ['base','global','precise','hybrid'];
// 版本的中文名（界面文案，别再各写一份）
const COLOR_VERSION_LABEL = { base:'底版', global:'全局', precise:'精准', hybrid:'混合' };
// 这个版本对应磁盘上哪个文件名。
//   ⚠ 自动方式那一种【不单独存】——它就是 output_N.png（不变量 2），
//     所以这里返回 null，由调用方回落到 output。
function colorVersionFile(version, index, autoVersion){
  const n = index + 1;
  // ⚠ 先认「自动方式那一种」：2026-10-19（docs/251 第 7 条③）默认不校色以后，自动方式常常【就是底版】——
  //   那时底版就是 output_N.png，不另存 base_N.png（两份一模一样白占地方）。
  if(version === autoVersion) return 'output_' + n + '.png';
  if(version === 'base') return 'base_' + n + '.png';
  return null;   // 非自动方式的校色版本：文件名见 colorVersionExtraFile
}
// 非自动方式那些版本的文件名（按需算出来才会存）
function colorVersionExtraFile(version, index){
  return 'color_' + version + '_' + (index + 1) + '.png';
}
// 这一张的自动方式是哪种。⚠ 老任务没有 autoVersion 字段 ⇒ 回落到 'hybrid'
//   （10-05 起主链路只有混合；旧存档里没这个字段的，实际也是混合算的）。
function shotAutoVersion(task, shot){
  const v = shot && shot.autoVersion;
  if(v && COLOR_VERSIONS.indexOf(v) >= 0) return v;
  return 'hybrid';
}
// 当前显示的是哪一种版本。
//   ⚠ 兼容旧值（不变量 6）：'base' → base；其余（含 'colormatched' / undefined）→ 自动方式那种。
function shotCurrentVersion(task, shot){
  if(task && task.colorVersion === 'base') return 'base';
  const v = task && task.colorVersion;
  if(v && v !== 'colormatched' && COLOR_VERSIONS.indexOf(v) >= 0) return v;
  return shotAutoVersion(task, shot);
}
async function versionImgFor(task, shot, which){
  if(!task || !shot) return '';
  // ⭐⭐ 2026-10-17 夜重写（用户：「在任务卡片里面点击切换校色之后，预览图没有实时的变化，传回的内容好像有时候也不会出现变化」）。
  //   老版本两个坑，都是静默的：
  //   ① 只有两个「抽屉」：底版 baseImgId、校色版 colorImgId。要全局 / 精准时也先翻 colorImgId ——
  //      那里放的是【生成时自动用的那一种】（一般是混合）⇒ 切到全局 / 精准拿到的其实是混合：图不变、传回也是混合，
  //      真正去算全局 / 精准的那一步永远不会走到。
  //   ② 从磁盘拿某一版时，缩略图直接借【当前那张】的、原图只记「怎么读」不先确认文件在不在 ⇒
  //      切了版本小图和大预览都不变；文件根本没有（还没算过）也算「切成功」，看大图 / 传回时才读不到。
  //   现在：每一版各认各的 —— 版本表里有就用；老抽屉只认【底版】和【自动那一种】；
  //   从磁盘拿之前先把原图读出来（读不到 = 这一版还没有 ⇒ 返回 ''，调用方去现算），顺手用它现做真缩略图。
  const want = which==='color' ? shotAutoVersion(task, shot) : which;
  const autoV = shotAutoVersion(task, shot);
  const remember = id => { if(!shot.versions) shot.versions = {}; shot.versions[want] = id; return id; };
  if(shot.versions && shot.versions[want] && window.IMG.has(shot.versions[want])) return shot.versions[want];
  // 老数据（没有版本表）：底版 → baseImgId；自动那一种 → autoImgId / colorImgId。别的版本不许借这两个抽屉。
  // ⭐ 2026-10-19：自动那一种是底版（默认不校色）时，底版就是成品那张（autoImgId），不在 baseImgId 抽屉里
  const legacy = want===autoV ? (shot.autoImgId || shot.colorImgId || (want==='base' ? shot.baseImgId : '')) : (want==='base' ? shot.baseImgId : '');
  if(legacy && window.IMG.has(legacy)) return remember(legacy);
  // 磁盘里找：base → base_N.png ／ 自动那一种 → output_N.png ／ 其余 → color_<版本>_N.png
  const project = task.cacheProject, runId = task.cacheRunId;
  if(!project || !runId || !window.uiwin || !window.uiwin.cache) return '';
  const idx = (task.shots||[]).indexOf(shot);
  if(idx < 0) return '';
  const name = colorVersionFile(want, idx, autoV) || colorVersionExtraFile(want, idx);
  let bytes = null;
  try{ bytes = await window.uiwin.cache.readFile(project, runId, name); }catch(_){ bytes = null; }
  if(!bytes || !bytes.length) return '';   // 磁盘上没有这一版（还没算过）⇒ 调用方去现算，不装作有
  const full = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
  // 用这一版自己的原图现做缩略图（只解码一次，原图不留在内存里）；万一做不出来，才退回借 thumb_N.jpg（只对自动那一种才对得上）
  let thumbBytes = null;
  try{ if(window.IMG.thumbFromBytes) thumbBytes = await window.IMG.thumbFromBytes(full, 'image/png'); }catch(_){ thumbBytes = null; }
  if((!thumbBytes || !thumbBytes.length) && want===autoV){
    try{ const b = await window.uiwin.cache.readFile(project, runId, 'thumb_'+(idx+1)+'.jpg'); if(b && b.length) thumbBytes = (b instanceof Uint8Array) ? b : new Uint8Array(b); }catch(_){}
  }
  if(!thumbBytes || !thumbBytes.length) return '';   // 一张对得上的缩略图都没有 ⇒ 宁可不切，也不给错图
  try{
    const id = window.IMG.putFromCache(thumbBytes, 'image/png', function(){ return window.uiwin.cache.readFile(project, runId, name); });
    // ⚠ 自动那一种是底版时，读回来的是 output_N.png ⇒ 记进 colorImgId（自动那一格），【不】记进 baseImgId ——
    //   记进 baseImgId 的话 cacheSaveTask 会把它当底版另写一份 base_N.png、写完还把它释放掉（正在显示的图就没了）
    if(want==='base' && autoV!=='base') shot.baseImgId = id;
    else if(want===autoV) shot.colorImgId = id;
    return remember(id);
  }catch(_){ return ''; }
}
// 这一单某一版【磁盘上到底有没有】—— 不读内容，只看元数据和已登记的 id。
// ⚠ 为什么不直接 readFile 试探：那是同步 I/O，切版本时逐张探会很卡。
//   有 id（内存或磁盘拉回的）就算有；老任务两个都没有 → 没有。
function taskColorVersionAvailable(task){
  const shots=(task&&task.shots)||[];
  for(const s of shots){
    if(!s || !s.done) continue;
    if((s.baseImgId && window.IMG.has(s.baseImgId)) || (s.baseSaved && task.cacheProject && task.cacheRunId)) return true;
    // ⭐ 2026-10-19（docs/251 第 7 条③）：自动方式就是底版（默认不校色）⇒ 成品就是底版，有成品就有底版
    if(s.autoVersion==='base' && ((s.autoImgId && window.IMG.has(s.autoImgId)) || (s.imgId && window.IMG.has(s.imgId)) || (task.cacheProject && task.cacheRunId))) return true;
  }
  return false;
}
// ══════════════════════════════════════════════════════════
//  ⭐⭐⭐ 2026-10-08（docs/170 §4.4 / §4.6 第 2 步）：按需重算一个版本
//
//  什么时候用：用户切到一个【还没算过】的校色方式（比如一直用混合，
//    今天想看看全局）—— 这时磁盘上没有 color_global_N.png，要现算。
//
//  ⚠ 三条铁律（写错了就是静默错误）：
//    ① 输入必须是【底版】（对齐后、校色前），不是 output。
//       拿 output 当输入 = 在已经校过色的图上再校一遍（二次校色，颜色会跑偏）。
//    ② 算出来的是【非自动方式】的版本 ⇒ 存 color_<版本>_<n>.png，
//       【绝不覆盖 output_N.png】（docs/170 §4.3 不变量 1/8）。
//    ③ 中途切了账号 / 命名空间要安全中止（沿用 cacheSaveTask 的 assertNamespace 做法），
//       不然会写到别人的缓存目录里。
//
//  返回：新算出来的图片 id；算不了就返回 ''（调用方如实说，不装作切了）。
// ⭐⭐ 第 2 步：现算时把进度写在小眼睛按钮上（例：「全局 2/6」）。
//
//  ⚠ 为什么只改按钮文字、不重画整张卡：
//    重画会把正在算的那一批打断（按钮 DOM 被换掉、引用失效）。
//  ⚠ 找不到按钮就静默跳过：进度显示失败不该影响算图。
function setEyeProgress(taskId, version, done, total){
  const el = tasksEl && tasksEl.querySelector('.task[data-task="'+taskId+'"]');
  if(!el) return;
  const btn = el.querySelector('[data-task-eye]');
  if(!btn) return;
  const label = COLOR_VERSION_LABEL[version] || version;
  btn.textContent = label + ' ' + done + '/' + total;
  btn.classList.add('busy');
}
async function recomputeColorVersion(task, shot, version, onProgress){
  if(!task || !shot) return '';
  const idx = (task.shots||[]).indexOf(shot);
  if(idx < 0) return '';
  // ① 原图（ref）：优先内存里的 sourceImageBase64；
  //   ⭐ 2026-10-19（docs/251 第 7 条⑤）：重启恢复回来的任务内存里没有它 ⇒ 从缓存 input.png 读（sourceImgId）。
  //   原来只认内存那份，重启后一切版本就报「这一单没留下原图」—— 默认不校色以后「过后再切」会变多，这条必须通。
  let refB64 = String(task.sourceImageBase64 || '');
  if(!refB64 && task.sourceImgId && window.IMG && window.IMG.has(task.sourceImgId)){
    try{ refB64 = String(await window.IMG.base64(task.sourceImgId) || ''); }catch(_){ refB64 = ''; }
  }
  if(!refB64 || !window.MATCHENGINE){
    if(window.ERR) ERR.report('COLOR_RECOMPUTE_NO_REF',{severity:'L2',stage:'color',
      message:'这一单没留下原图，算不了别的校色方式（老任务只能看已经算过的那一种）。'});
    return '';
  }
  // ② 底版（src）：对齐后、校色前那张。
  //   ⚠ 底版可能已被 release（cacheSaveTask 写完就释放内存）⇒ 用 versionImgFor 从磁盘拉。
  const baseId = await versionImgFor(task, shot, 'base');
  if(!baseId){
    if(window.ERR) ERR.report('COLOR_BASE_MISSING',{severity:'L2',stage:'color',
      message:'这一单没有底版，算不了别的校色方式（底版只有引擎档 / 新版本生成的才有）。'});
    return '';
  }
  let baseCanvas = null;
  try{
    const bytes = new Uint8Array(await window.IMG.fullBytes(baseId));
    const blob = new Blob([bytes], {type:'image/png'});
    const bmp = await createImageBitmap(blob);
    baseCanvas = document.createElement('canvas');
    baseCanvas.width = bmp.width; baseCanvas.height = bmp.height;
    baseCanvas.getContext('2d').drawImage(bmp,0,0);
    if(bmp.close) bmp.close();
  }catch(e){
    if(window.ERR) ERR.report('COLOR_RECOMPUTE_DECODE_FAILED',{severity:'L2',stage:'color',
      message:'底版读不出来，算不了别的校色方式：'+String(e&&e.message||e)});
    return '';
  }
  // ③ 走【真实那条路】：aiColorMatchCanvas 会做尺寸对齐、比例差、引擎/档 1 分发，
  //   ⚠ 不自己另写一套 —— 两套必然漂移（这是本项目的老坑）。
  //   ⚠ 但 method 要换成【目标方式】，不能跟着设置走：settingsRuntime.colorMatchMode
  //     决定的是"生成时自动用哪种"，这里要的是"用户此刻想看哪种"。
  //   ⭐ 2026-10-17 夜：直接点名（options.mode），不再临时改全局设置再改回 ——
  //     改全局那几秒跟生成卡的下拉框、正在出的新图、存设置都会打架（用户报「是否会打架」）。
  let out = null;
  out = await aiColorMatchCanvas(baseCanvas, baseCanvas.width, baseCanvas.height, refB64,
                                 typeof colorMatchLog === 'function' ? colorMatchLog : null,
                                 { mode: version, job: { kind:'color-version', priority:0, taskId:String(task.taskId||task.id), shot:idx, label:COLOR_VERSION_LABEL[version]||version } });
  if(!out){ return ''; }
  // ④ 登记成图片 id
  let newId = '';
  try{ newId = await window.IMG.putFromCanvas(out, 'image/png'); }catch(_){ newId = ''; }
  if(!newId) return '';
  if(!shot.versions) shot.versions = {};
  shot.versions[version] = newId;
  // ⑤ 立刻落盘成 color_<版本>_<n>.png
  //   ⚠ 非自动方式【不写 output】—— output 永远是生成时自动方式的结果（不变量 1）。
  try{
    const project = task.cacheProject, runId = task.cacheRunId;
    if(project && runId && window.uiwin && window.uiwin.cache){
      const bytes = new Uint8Array(await window.IMG.fullBytes(newId));
      await window.uiwin.cache.writeFile(project, runId,
        colorVersionExtraFile(version, idx), bytes);
      shot.versionSaved = shot.versionSaved || {};
      shot.versionSaved[version] = true;
    }
  }catch(e){
    // ⚠ 写盘失败不算失败（图已经在内存里、能用），但要如实记一笔 ——
    //   不然后果是"切过去看着正常、重启后这一版没了"，用户以为软件吃了他的图。
    if(window.ERR) ERR.report('COLOR_VERSION_SAVE_FAILED',{severity:'L2',stage:'color',
      message:'新算的'+COLOR_VERSION_LABEL[version]+'版没能存进缓存（这次仍能看，重启后会没）：'
              +String(e&&e.message||e)});
  }
  if(typeof onProgress === 'function') onProgress();
  return newId;
}
async function toggleTaskColorVersion(taskId){
  const task=taskById(taskId);
  if(!task) return;
  // ⭐⭐ 2026-10-08（docs/170 §4.4）：四态轮换 底版 → 全局 → 精准 → 混合 → 底版。
  //   ⚠ 顺序固定，不许按"可用性"重排 —— 用户要的是"每点一下换一种"，
  //     顺序会记在肌肉记忆里。不可用的自动跳过（下面那个循环）。
  //   ⚠ 兼容旧值：'colormatched' 先归一成"自动方式那种"（不变量 6）。
  const fromVersion = shotCurrentVersion(task, (task.shots||[]).find(s=>s&&s.done) || (task.shots||[])[0]);
  const startIdx = Math.max(0, COLOR_VERSIONS.indexOf(fromVersion));
  // ⚠ 先只做"能切到已有版本"；拿不到的那些当"不可用"跳过。
  //   "按需重算"在施工第 2 步 —— 这里绝不能卡在拿不到的那一种上出不来。
  let to = fromVersion;
  for(let step=1; step<=COLOR_VERSIONS.length; step++){
    const cand = COLOR_VERSIONS[(startIdx+step) % COLOR_VERSIONS.length];
    if(cand === fromVersion) continue;                 // 绕回自己了，别再试
    if(cand === 'base'){ if(taskHasAnyBase(task)){ to = cand; break; } continue; }
    // 校色版本：
    //   ① 先看有没有（内存 / 磁盘都算）—— versionImgFor 自己会查两处
    //   ② 没有就【现算】（docs/170 §4.4：第一次切到没算过的版本要能出来）
    //   ⚠ 算得出来才算「可用」；算不出来就跳过这一种（不装作切了）
    const probe = (task.shots||[]).find(s=>s&&s.done);
    if(probe && await versionImgFor(task, probe, cand)){ to = cand; break; }
    if(probe && await recomputeColorVersion(task, probe, cand)){ to = cand; break; }
  }
  if(to === fromVersion){
    // 一个都切不了：如实说，别装作切了（静默失效是本项目最忌的形态）。
    if(window.ERR) ERR.report('COLOR_VERSION_UNAVAILABLE',{severity:'L2',stage:'color',
      message:'这一单目前只有【'+COLOR_VERSION_LABEL[fromVersion]+'】可看；其它版本还没算（要用加速引擎算，或等按需重算做好）。'});
    return;
  }
  if(to==='base' && !taskHasAnyBase(task)){
    // ⚠ 用户拍板：老任务不做迁移，点了【明说缺少文件】。
    //   不说的话用户只会看到按钮点不动 / 图没变，以为软件坏了。
    if(window.ERR) ERR.report('COLOR_BASE_MISSING',{severity:'L2',stage:'color',
      message:'这一单没有底版文件（老任务，或者档 1 算的图——底版只有引擎档才有）。'});
    return;
  }
  return applyTaskColorVersion(task, to, fromVersion);
}
// ⭐ 2026-10-19（docs/251 第 7 条④，测试用户：「点一下下拉弹窗，然后去选择之后开始算，节省切换时间」）：
//   小眼睛改成菜单（openColorVersionMenu），选哪版切哪版；老的「按顺序换下一种」（上面 toggleTaskColorVersion）也走这一段。
//   ⚠ 改选就停（用户 10-19 定「停掉没算完的、算好的留着、改算新选的」）：每次切换领一个号（task._colorSwitchSeq），
//     用户中途又选了别的 ⇒ 这一轮在下一张之前停下；正在算的那一张算完照样存进 shot.versions（算好的留着），
//     只是不再把它换上显示 —— 显示交给新的那一轮。
async function switchTaskColorVersion(taskId, to){
  const task=taskById(taskId);
  if(!task || COLOR_VERSIONS.indexOf(to)<0) return false;
  const fromVersion = shotCurrentVersion(task, (task.shots||[]).find(s=>s&&s.done) || (task.shots||[])[0]);
  // 正在看的就是这一版、也没有别的在算 ⇒ 什么都不做（有别的在算时选回当前这版 = 取消那一轮）
  if(to===fromVersion && !task._colorSwitch) return true;
  if(to==='base' && !taskHasAnyBase(task)){
    if(window.ERR) ERR.report('COLOR_BASE_MISSING',{severity:'L2',stage:'color',
      message:'这一单没有底版文件（老任务，或者档 1 算的图——底版只有引擎档才有）。'});
    return false;
  }
  return applyTaskColorVersion(task, to, fromVersion);
}
// ⭐ 2026-10-19（docs/251 第 7 条④）：小眼睛的菜单 —— 四项「底版（不校色）/ 全局 / 精准 / 混合」，每项后面标状态。
//   ⚠ 新的全窗口浮层（挂在 body 上）必须在 overUI 登记，不然鼠标一过去就穿透给 PS（项目里栽过四次）：见 overUI 里 colorMenuHit。
//   ⚠ 样子沿用下拉框的 .uisel-panel / .uisel-item（跟着主题色走），不另起一套。
let colorMenu=null;
function colorMenuClose(){
  if(!colorMenu) return;
  const m=colorMenu; colorMenu=null;
  m.panel.remove();
  document.removeEventListener('mousedown', m.onOutside, true);
  document.removeEventListener('keydown', m.onKey, true);
  window.removeEventListener('resize', colorMenuClose);
  window.removeEventListener('wheel', m.onWheel, true);
}
function colorMenuHit(x, y){
  if(!colorMenu || !colorMenu.panel.isConnected) return false;
  const r=colorMenu.panel.getBoundingClientRect();
  return x>=r.left-4 && x<=r.right+4 && y>=r.top-4 && y<=r.bottom+4;
}
// 这一版现在有没有（不用现算）—— 只看第一张，够菜单上写个状态
function colorVersionReady(task, version){
  const s=(task.shots||[]).find(x=>x&&x.done);
  if(!s) return false;
  if(version===shotAutoVersion(task, s)) return true;
  if(version==='base') return taskHasAnyBase(task);
  if(s.versions && s.versions[version] && window.IMG.has(s.versions[version])) return true;
  return !!(s.versionSaved && s.versionSaved[version]);
}
function openColorVersionMenu(taskId, anchor){
  const task=taskList.find(t=>t.id===taskId);
  if(!task || !anchor) return;
  if(colorMenu && colorMenu.taskId===taskId){ colorMenuClose(); return; }   // 再点一下小眼睛 = 收起
  colorMenuClose();
  const names={base:'底版（不校色）', global:'全局校色', precise:'精准校色', hybrid:'混合校色'};
  const first=(task.shots||[]).find(s=>s&&s.done)||(task.shots||[])[0];
  const current=shotCurrentVersion(task, first), sw=task._colorSwitch;
  const panel=document.createElement('div');
  panel.className='uisel-panel color-menu'; panel.setAttribute('role','menu'); panel.setAttribute('aria-label','选看哪一版');
  panel.innerHTML=COLOR_VERSIONS.map(v=>{
    const on = sw ? sw.version===v : v===current;
    const state = sw&&sw.version===v ? ('正在算 '+sw.done+'/'+sw.total) : (!sw&&v===current ? '正在看' : (colorVersionReady(task, v) ? '已算好' : '选了再算'));
    return '<button type="button" role="menuitemradio" aria-checked="'+on+'" class="uisel-item cm-row'+(on?' cur':'')+'" data-color-version="'+v+'">'
      +'<span class="cm-name">'+escapeHtml(names[v]||v)+'</span><span class="cm-state">'+escapeHtml(state)+'</span></button>';
  }).join('');
  document.body.appendChild(panel);
  // 贴在小眼睛下面；下面放不下就往上
  const r=anchor.getBoundingClientRect(), w=panel.offsetWidth, h=panel.offsetHeight;
  const below=r.bottom+6+h<=innerHeight-8;
  panel.style.left=Math.max(8, Math.min(innerWidth-w-8, r.left))+'px';
  panel.style.top=(below ? r.bottom+6 : Math.max(8, r.top-6-h))+'px';
  if(!below) panel.classList.add('up');
  const onOutside=e=>{ if(panel.contains(e.target) || anchor.contains(e.target)) return; colorMenuClose(); };
  const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); colorMenuClose(); } };
  const onWheel=e=>{ if(!panel.contains(e.target)) colorMenuClose(); };     // 滚轮翻任务卡时菜单别留在原地
  panel.addEventListener('mousedown', e=>e.stopPropagation());
  panel.addEventListener('click', e=>{
    const b=e.target.closest('[data-color-version]'); if(!b) return;
    e.preventDefault(); e.stopPropagation();
    const v=b.dataset.colorVersion;
    colorMenuClose();
    switchTaskColorVersion(taskId, v);
  });
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', colorMenuClose);
  window.addEventListener('wheel', onWheel, {capture:true, passive:true});
  colorMenu={panel, taskId, anchor, onOutside, onKey, onWheel};
}
async function applyTaskColorVersion(task, to, fromVersion){
  const token = (task._colorSwitchSeq = (task._colorSwitchSeq||0) + 1);
  const live = () => task._colorSwitchSeq === token;
  const taskId = task.id;
  let swapped=0, skipped=0;
  // ⭐ 第 2 步：现算时的进度用（按钮上显示「全局 2/6」）
  let done = 0, processed = 0;
  const total = (task.shots||[]).filter(s=>s&&s.done).length;
  const fromV = fromVersion;
  // 进度记在任务上（taskActionsHtml 画小眼睛时也认它 —— 别的进度事件把操作行重画了，进度也不会被冲掉）
  task._colorSwitch = {version:to, done:0, total};
  try{ setEyeProgress(taskId, to, 0, total); }catch(_){}
  // ⚠ 逐张 await（versionImgFor 要读磁盘、用那一版的原图现做缩略图，一张零点几秒）。
  //   ⭐ 2026-10-17 夜：每张都在按钮上报进度（以前只有现算时报 —— 读盘做缩略图那一两秒按钮像卡住了）。
  for(const s of (task.shots||[])){
    if(!live()) return false;                     // 改选了：停在这一张之前
    if(!s || !s.done) continue;
    // ⭐ 切走之前把【当前这张】登记进它自己那一版（切回来不用再读盘）
    if(s.imgId && window.IMG.has(s.imgId)){ if(!s.versions) s.versions = {}; if(!s.versions[fromV]) s.versions[fromV] = s.imgId; }
    // ⭐ 按【版本名】取（versionImgFor 已泛化）
    //   ⚠ 它内部会惰性登记进 shot.versions，所以第二次切同一版就不用再查磁盘。
    let want = await versionImgFor(task, s, to);
    if(!want && live()){
      // ⭐ 第 2 步：没算过就现算（docs/170 §4.4）
      //   ⚠ 逐张算、算完一张换一张 —— 界面不能卡死。
      want = await recomputeColorVersion(task, s, to, function(){
        done++;
      });
    }
    // 改选了：这张算好的已经进了 shot.versions（留着），但不换上显示 —— 显示交给新的那一轮
    if(!live()) return false;
    // 第一张就拿不到（没原图 / 没底版 / 算失败，原因已经报过一次）⇒ 整轮作罢，别每张都再报一遍、也别切成半截
    if(!want && !swapped && !skipped){
      task._colorSwitch = null;
      const host=tasksEl.querySelector('.task[data-task="'+taskId+'"]');
      if(host){ host._actsSig=''; syncTaskActions(host, task); }
      return false;
    }
    processed++;
    task._colorSwitch.done = processed;
    try{ setEyeProgress(taskId, to, processed, total); }catch(_){}
    if(want){
      // ⚠ 去的时候先把【现在这张】记下来，回来才有据可依。
      //   colorImgId 只在第一次切走时记 —— 反复切不能把它覆盖成底版那张。
      // ⭐⭐ 2026-10-08（docs/170 §4.3 不变量 8）：
      //   切之前先把 autoImgId 定下来 —— 此处最清楚"切之前 imgId 是什么"。
      //   ⚠ 只在为空时补，【绝不能覆盖已有的】—— 已有值才是真正的生成时自动方式。
      //   ⚠ 老任务没有这个字段：那张的 imgId 此刻还是自动方式那张（还没被切过），
      //     所以此刻补上是对的；补晚了（等切完再补）就会把底版钉成"自动方式"。
      if(!s.autoImgId) s.autoImgId=s.imgId;
      // ⭐ 2026-10-17 夜：「校色版」抽屉只放【自动那一种】—— 当前是全局 / 精准时切去底版，不能把它们当成自动那张记下
      if(to==='base' && !s.colorImgId && fromV===shotAutoVersion(task, s)) s.colorImgId=s.imgId;
      s.imgId=want; swapped++;
    } else skipped++;
  }
  if(!live()) return false;
  task._colorSwitch = null;
  // ⭐ 记当前版本（不变量 6：'base' 保持 'base'，其余记版本名）
  //   ⚠ 旧代码把非 base 一律记成 'colormatched' —— 那分不清是全局还是混合，
  //     四态之后就丢了信息。新代码记真名；读了旧值的走 shotCurrentVersion 归一。
  task.colorVersion = to;
  // ⚠ outputs 也要跟着换 —— 它是"能不能传回 / 传回哪张"的真源之一（见 aiTransfer）。
  //   不换的话切到底版之后点传回，传出去的是校色版（用户看到的是底版）→ 静默不一致。
  (task.outputs||[]).forEach(o=>{
    if(!o) return;
    const s=(task.shots||[])[o.index];
    if(s && s.imgId) o.imgId=s.imgId;
  });
  // ⭐⭐ 2026-10-06 审查补：作废这一批的过渡帧。
  //   ⚠⚠ 上面 toggleTaskColorVersion 的函数头注释（§4841-4842）早就写着切版本要
  //     "② 作废该批的 tween 帧（否则滚强度看到的是旧版本插出来的帧 —— 静默错误）
  //      ③ 清掉 shot.tweenStrength（端点变了，旧的强度百分比不再对应同一张图）"，
  //     **但这两件事在代码里一件都没做** —— V7Tween.purgeTaskFrames 写好了、导出了、
  //     从来没人调（全 ui-pure 搜不到调用点）。
  //   后果两条：① 滚强度看到的是拿【另一个版本】的两个端点插出来的帧；
  //             ② 缓存里 tween_*.png 只增不减（实测 18.84 GB / 3168 个文件）。
  //   ⇒ 切版本时整批作废：内存表清掉 + 磁盘那份标记 json 覆盖成空（读盘有 key 校验兜底）。
  //     ⚠ 不 await —— 它是后台清理，不该让"切个版本"等磁盘写。
  try{
    if(window.V7Tween && typeof V7Tween.purgeTaskFrames==='function') V7Tween.purgeTaskFrames(task);
  }catch(_){}
  // ③ 清掉强度：端点换了，旧的百分比不再对应同一张图（否则滚轮一上去就是错的那张）
  (task.shots||[]).forEach(s=>{ if(s && s.tweenStrength!=null) s.tweenStrength=null; });
  // 缩略图 / 大预览 / 预览条一起重画
  const el=tasksEl.querySelector('.task[data-task="'+task.id+'"]');
  if(el){ el._actsSig=''; syncTaskActions(el, task); buildPreview(el, task); }
  // ⭐ 2026-10-17 夜：大预览框正开着这一单 → 马上按新版本换图（以前要等鼠标再动一下）
  try{ if(window.V7Tween && typeof window.V7Tween.refreshBox==='function') window.V7Tween.refreshBox(task); }catch(_){}
  aiAddLog(to==='base'
    ? ('已切到【底版】：'+swapped+' 张（没校色，掰正过的样子）'+(skipped?(' · '+skipped+' 张没有底版，保持原样'):''))
    : ('已切到【'+(COLOR_VERSION_LABEL[to]||to)+'】校色版：'+swapped+' 张'+(skipped?(' · '+skipped+' 张没切过来'):'')),'info');
  // 记录卡 / 历史那边也刷一次（它们显示的是同一批图）
  try{ if(typeof broadcastRecordsChanged==='function') broadcastRecordsChanged(); }catch(_){}
}

// ⭐⭐ 2026-09-13 新增：让操作行【跟着状态重画】。
//
// ⚠⚠ 这是用户实测的"传回按钮数字不变 / 传完了按钮还在 / 一直能再点一次"的真因：
//   这一行以前只在 renderTaskEl(建卡那一刻) 画过一次，之后 updateTask 只更新
//   图标/名字/百分比/进度条/状态文字，【从来不管这一行】。所以
//     · 任务刚建时 pending=0 → 根本没有「传回」按钮，后面出了图也不会长出来
//     · 传完了 pending 变 0 → 按钮也不会消失，用户再点一次就重复传
//     · 跑完了 → 「提前结束」赖着不走
//
// ⚠ 只有内容【真的变了】才动 DOM（拿 HTML 当签名比一下）——
//   updateTask 每来一个进度事件就调一次，无条件重建会让悬停高亮一直闪。
// ⚠ 事件绑定只在这里做，不要再在 buildPreview 里绑一遍：
//   重建出来的是新元素，两边都绑就是绑两次 → 点一下发两次传回。
// ⚠ 新加子元素记得看 CSS 那行 `.task > .t-sub,.task > .t-acts{z-index:3}` ——
//   不在里面就会被光裁切层(z2)盖住（"看得见位置但看不到、鼠标却能点中"那个坑）。
function syncTaskActions(el, task){
  if(!el || !task) return;
  const html=taskActionsHtml(task);
  if(el._actsSig===html) return;            // 没变化，一个字节都不动
  el._actsSig=html;
  const old=el.querySelector(':scope > .t-acts');
  if(!html){ if(old) old.remove(); return; }
  const box=document.createElement('div');
  box.innerHTML=html;
  const next=box.firstElementChild;
  if(!next) return;
  if(old) old.replaceWith(next);
  else {
    // 位置：状态文字下面。进度条是绝对定位钉在下沿的，插在它前面不影响外观。
    const sub=el.querySelector(':scope > .t-sub'), bar=el.querySelector(':scope > .t-bar');
    if(sub) sub.insertAdjacentElement('afterend',next);
    else if(bar) el.insertBefore(next,bar);
    else el.appendChild(next);
  }
  // ⚠ stopPropagation 必须有：按钮坐在任务卡里，不拦会连带触发任务卡自己的点击和拖拽。
  const finishBtn=next.querySelector('[data-task-finish]');
  const dlssBtn=next.querySelector('[data-dlss-task]');
  if(dlssBtn){dlssBtn.addEventListener('mousedown',e=>e.stopPropagation());dlssBtn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();V7DLSS.openTask(task);});}
  if(finishBtn){
    finishBtn.addEventListener('mousedown',e=>e.stopPropagation());
    finishBtn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();aiFinishEarly(task);});
  }
  const sendBtn=next.querySelector('[data-task-send]');
  if(sendBtn){
    sendBtn.addEventListener('mousedown',e=>e.stopPropagation());
    sendBtn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();aiTransfer(task);});
  }
  // ⭐ 10-25：分割（按 id 取最新那份）
  const segBtn=next.querySelector('[data-task-segment]');
  if(segBtn){
    segBtn.addEventListener('mousedown',e=>e.stopPropagation());
    segBtn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();taskOpenSegment(taskList.find(t=>t.id===task.id)||task,el);});
  }
  // ⭐ 2026-10-19（docs/250 第 20 条）：失败任务「重跑」。按 id 取最新那份（闭包里的 task 是这次渲染时的快照）。
  const rerunBtn=next.querySelector('[data-task-rerun]');
  if(rerunBtn){
    rerunBtn.addEventListener('mousedown',e=>e.stopPropagation());
    rerunBtn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();aiRerunFailedTask(taskList.find(t=>t.id===task.id)||task);});
  }
  // ⭐⭐ 2026-10-05（docs/143 §五）：小眼睛切版本。
  //   ⚠ 用 taskById 取最新那份 —— 闭包里的 task 是这次渲染时的快照，
  //     而切换会改 imgId / tweenStrength，拿旧快照切会丢一半改动。
  // ⭐ 2026-10-19（docs/251 第 7 条④）：点小眼睛弹菜单选版本（openColorVersionMenu），不再按顺序换下一种。
  const eyeBtn=next.querySelector('[data-task-eye]');
  if(eyeBtn){
    eyeBtn.addEventListener('mousedown',e=>e.stopPropagation());
    eyeBtn.addEventListener('click',e=>{
      e.preventDefault(); e.stopPropagation();
      openColorVersionMenu(task.id, eyeBtn);
    });
  }
}

// ⭐ 10-25：「分割」框的宿主（segment-panel.js 只管界面和算蒙版，传回 / 换蒙版在这边做）。
//   · 这张还没传过 → aiTransfer 照常传，额外带上这张的蒙版（插件那边这一张不加边缘羽化 —— 用户说「羽化要避让」）
//   · 已经传过（psLayerByShot 里有图层号）→ ps.layer.applyMask 给那个图层换上这个蒙版（原来的羽化蒙版被替换掉）
function segmentHost(){
  return {
    loadBlob:imgId=>Promise.resolve(window.IMG.fullBytes(imgId)).then(buf=>new Blob([buf])),
    // ⭐ 10-26（用户：调了强度的图，点分割要继承那个强度）：调过强度就用调好的那一帧（跟「传回」用的是同一个 frameBytesFor），没调过 / 100% 用原图
    loadGen:(task,idx)=>{
      const shot=task.shots[idx],T=window.V7Tween;
      const strength=T&&T.currentStrength?Number(T.currentStrength(task,shot)):1;
      const frame=T&&typeof T.frameBytesFor==='function'?T.frameBytesFor(task,shot.imgId):null;
      return Promise.resolve(frame).then(bytes=>bytes?{blob:new Blob([bytes]),strength}:Promise.resolve(window.IMG.fullBytes(shot.imgId)).then(buf=>({blob:new Blob([buf]),strength:1})));
    },
    // 分割框骑在大预览框上：给这张图打开（或换到）大预览框，交回框元素
    attachBox:(task,taskEl,idx)=>{
      const T=window.V7Tween,shot=task.shots[idx];
      if(!T||typeof T.openShot!=='function'||!shot||!taskEl)return null;
      if(!T.openShot(taskEl,task,shot))return null;
      if(T.cancelPendingHide)T.cancelPendingHide();
      return document.querySelector('.tween-box.show');
    },
    boxShot:task=>window.V7Tween&&V7Tween.boxShotOf?V7Tween.boxShotOf(task):-1,
    keepBox:()=>{if(window.V7Tween&&V7Tween.cancelPendingHide)V7Tween.cancelPendingHide();},
    geometry:taskEl=>window.V7Tween&&V7Tween.geometryForTask?V7Tween.geometryForTask(taskEl):null,
    latestTask:task=>taskList.find(t=>t.id===task.id)||task,
    report:(code,ctx)=>{try{ERR.report(code,ctx);}catch(_){}},
    returnWithMask:(task,idx,mask)=>{
      const layerId=task&&task.psLayerByShot?task.psLayerByShot[idx]:null;
      if(layerId==null){
        return Promise.resolve(aiTransfer(task,[idx],{masks:{[idx]:mask}})).then(r=>{
          if(r&&r.ok){aiAddLog('第 '+(idx+1)+' 张已带分割蒙版传回（这张没加边缘羽化）','success');return r;}
          return {ok:false,error:(r&&r.error)||'传回没完成（看左下角报错卡）'};
        });
      }
      const c=aiCaptureSnapshot(task.captureSnapshot||task,0)||{};
      const docId=task.psDocId!=null?task.psDocId:c.docId;
      if(docId==null||!c.selection)return Promise.resolve({ok:false,error:'这单缺少 Photoshop 来源快照（文档 / 选区），没法给图层换蒙版'});
      return new Promise(resolve=>{
        linkQueue('ps.layer.applyMask',{docId,layerId,maskRle:mask.rle,maskWidth:mask.width,maskHeight:mask.height,selection:aiClonePlain(c.selection)},{
          after:()=>{aiAddLog('第 '+(idx+1)+' 张：PS 里那个图层已换上分割蒙版','success');resolve({ok:true});},
          afterError:result=>{const msg=linkResultMessage(result);try{ERR.report('ADDMASK_RETURN_FAILED',{message:msg,context:{'第几张':idx+1,'图层号':layerId}});}catch(_){}resolve({ok:false,error:msg});}
        }).then(reply=>{if(reply&&reply.ok===false)resolve({ok:false,error:reply.error||'Photoshop 没有回应'});}).catch(error=>resolve({ok:false,error:String(error&&error.message||error)}));
      });
    }
  };
}
function taskOpenSegment(task,el){
  if(!window.V7SegmentPanel){aiAddLog('分割模块没加载起来，重启软件再试','error');return;}
  V7SegmentPanel.setHost(segmentHost());
  // ⭐ 10-26（用户真机报：点开分割「预览图在、缩略图不在」）：鼠标从缩略图条移回任务卡点「分割」时，条按正常规则已经收了。
  //   分割框摆在大预览框的位置，底下应该照样有这一单的缩略图条 ⇒ 打开前主动把条弹出来（跟右滑弹条同一套：先清别的、登记归属）。
  //   分割框开着时整个窗口是工作面，鼠标移动不走收条那条路（v7HoverOverlayOpen），关掉分割框后按正常规则收。
  const pv=el&&el.querySelector('.task-preview');
  if(pv&&!pv.classList.contains('show')){
    try{ if(typeof buildPreview==='function') buildPreview(el,task); }catch(_){}
    clearPreview(); pv.classList.add('show'); window.__pv=pv;   // 不设 pvKeepOpen：关掉分割框后鼠标一离开就按正常规则收，别让条赖着
    if(window.V7Tween&&typeof V7Tween.setBoxOwner==='function') V7Tween.setBoxOwner(el.dataset.task);
  }
  // 鼠标移到「分割」按钮那一下可能已经排了「160ms 后收条」—— 取消掉，不然刚弹出的条转眼就被收（真机实测）
  if(window.V7Tween&&typeof V7Tween.cancelPendingHide==='function') V7Tween.cancelPendingHide();
  // 从哪张开：大预览框正开着这一单的某张就从那张开（V7Tween.boxShotOf），否则第一张出好的；框里有「‹ ›」能换
  const idx=window.V7Tween&&V7Tween.boxShotOf?V7Tween.boxShotOf(task):-1;
  if(!V7SegmentPanel.open(task,el,idx))aiAddLog('这单没有能分割的图（要有出好的图和原图）','warn');
}

// 哪几张"已经出好、但还没传回 PS"。这是【传回】和【提前结束】共用的唯一判据。
//
// ⚠ 判据用 psLayerByShot —— 那张对照表是【传回成功后】写的，最准。
//   不能用 task.status / task.outputs：
//     · status 到终态才变，中途传不了
//     · outputs 是整批跑完才赋值的（就是这个坑让「提前结束」点了没反应）
//   用它还天然支持【分几次传回】：传过的不会再传第二遍，不会重复贴图层。
// ═══ 指哪抠哪：三个候选挑一个（2026-09-14 深夜，用户定的交互）═══
//
// SAM2 每次推理会【同时给三个答案】（比如框住领口 → 整个人 / 上衣 / 领子），
// 各带一个置信度。用户明确要的是"三个都摆出来我自己挑"，而不是替他决定。
// 面板里那个「三个答案怎么办」可以切成"直接用最有把握的"。
//
// ⚠ 和 syncTaskActions 同一套规矩：内容没变就【一个字节都不动 DOM】——
//   updateTask 每来一个进度事件就调一次，无条件重建会让悬停高亮一直闪。
// ⚠ 事件只在这里绑，别处不许再绑一遍：重建出来是新元素，两边都绑 = 点一下跑两次。
function taskPickSig(task){
  if(!task || task.kind!=='sam2') return '';
  if(task.sam2Picked!=null) return '';                 // 已经挑过了 → 收起来
  const c=task.sam2Candidates;
  if(!Array.isArray(c) || !c.length) return '';
  return 'sam2|'+task.id+'|'+c.map(x=>x.index+':'+(x.imgId||'')+':'+(x.iou||0)).join(',');
}
function syncTaskPick(el, task){
  if(!el) return;
  const slot=el.querySelector(':scope > .t-pick');
  if(!slot) return;
  const sig=taskPickSig(task);
  if(el._pickSig===sig) return;
  el._pickSig=sig;
  if(!sig){ slot.classList.remove('on'); slot.textContent=''; return; }

  const cands=task.sam2Candidates;
  slot.textContent='';
  const tip=document.createElement('div');
  tip.className='t-pick-tip';
  tip.textContent='三个答案，点一个：';
  slot.appendChild(tip);
  const row=document.createElement('div');
  row.className='t-pick-row';
  cands.forEach(c=>{
    const b=document.createElement('button');
    b.type='button';
    b.className='t-pick-item'+(c.index===task.sam2Best?' best':'');
    // ⚠ 空候选（一个像素都没选中）也要摆出来占位、但不能点 ——
    //   删掉它会让"三个"变成两个，用户以为程序漏了一个。
    const empty=!c.imgId || !(c.pixels>0);
    if(empty) b.disabled=true;
    const im=document.createElement('img');
    im.className='t-pick-thumb';
    // ⚠ 只挂缩略图，原图绝不进 DOM（铁律 13）
    im.src=(window.IMG && c.imgId) ? window.IMG.thumb(c.imgId) : '';
    im.alt='';
    b.appendChild(im);
    const cap=document.createElement('span');
    cap.className='t-pick-cap';
    // ⚠ 不显示 "iou 0.96" 这种术语 —— 用户看不懂。换成"把握"百分比。
    cap.textContent=empty ? '（空的）' : ('把握 '+Math.round((Number(c.iou)||0)*100)+'%');
    b.appendChild(cap);
    b.title=empty ? '这个答案里什么都没有' : ('把握 '+Math.round((Number(c.iou)||0)*100)+'% · 选中约 '+(c.pixels||0).toLocaleString()+' 个像素');
    // ⚠ stopPropagation 必须有：按钮坐在任务卡里，不拦会连带触发任务卡自己的点击和拖拽。
    b.addEventListener('mousedown',e=>e.stopPropagation());
    b.addEventListener('click',e=>{
      e.preventDefault(); e.stopPropagation();
      if(empty) return;
      applySAM2Candidate(task.id, c.index);
    });
    row.appendChild(b);
  });
  slot.appendChild(row);
  slot.classList.add('on');
}

function taskTransferableOutputs(task){
  if(task?.migration?.returnBlocked)return [];
  const shots = Array.isArray(task&&task.shots) ? task.shots : [];
  const map = (task&&task.psLayerByShot) || {};
  const list=[];
  shots.forEach((s,i)=>{
    if(s && s.imgId && s.restoreState==='done' && map[i]==null)
      list.push({index:i, imgId:s.imgId, restoreState:'done'});
  });
  return list;
}
function taskPendingTransfer(task){ return taskTransferableOutputs(task).length; }

// ⭐ 任务标题的【唯一来源】（2026-09-13）。
//
// 📌 **以后接本地微型 LLM 自动起名，只改这一个函数的兜底分支。**
//    别的地方（任务卡渲染 / 缓存 meta / 生成记录）都读 task.label，不用动。
//    接进来时建议：拿 prompt 前 N 字送小模型 → 返回一个 8~12 字的名字 →
//    失败就仍然回落到"自定义提示词"，**绝不能因为起名失败挡住生成**。
function taskTitleOf(payload){
  const t=String(payload&&payload.presetTitle||'').trim();
  if(t) return t;
  return '自定义提示词';
}

function taskStatusText(task,pct){
  if(taskIsDone(task.status)) return '完成';
  if(task.status==='failed') return '失败';
  if(task.status==='cancelled') return '已取消';
  // ⭐ 转后台的要标出来（2026-09-13）：它【还在跑】，只是前台不等了。
  //   不标的话用户看到一个 40% 不动的任务会以为卡死了。
  if(task.backgrounded) return '后台 '+pct+'%';
  return pct+'%';
}

// 进度色段按任务结果计数排列：成功永远从左侧占位，失败紧随其后，未完成保持透明。
// 不使用图片原始序号，避免第 6 张先返回时在视觉上跳到最右边。
function taskProgressSegments(task){
  const states=taskProgressStates(task), total=Math.max(1,states.length);
  const success=states.filter(s=>s==='done').length, failed=states.filter(s=>s==='error').length;
  const pending=Math.max(0,total-success-failed), pct=n=>((n/total)*100).toFixed(3)+'%';
  return '<span class="t-progress-layer"><i class="t-progress-segment ok" style="width:'+pct(success)+'"><b class="t-progress-sweep"></b><em class="t-progress-tip"></em></i><i class="t-progress-segment err" style="width:'+pct(failed)+'"><b class="t-progress-sweep"></b><em class="t-progress-tip"></em></i><i class="t-progress-segment pending" style="width:'+pct(pending)+'"><b class="t-progress-live" style="width:'+taskLiveWidth(task,pending)+'"></b></i></span>';
}
// ⭐ 2026-10-21：云端排队/采样进度（task.cloudLive = 0~1）画在「还没完成」那段里，只占【下一张】那一格的宽度。
//   一张都没回来时 = 整条跟着走；回来一张后，剩下那段从头再走。
function taskLiveWidth(task,pending){
  const f=Math.max(0,Math.min(1,Number(task&&task.cloudLive)||0));
  return pending>0?((f/pending)*100).toFixed(3)+'%':'0%';
}
// ⭐ 2026-10-22：工作流采样步数（task.cloudSteps，aiCloudProgressPatch 写）—— 画在缩略图沙漏下面
function taskStepsHtml(task){
  const s=task&&task.cloudSteps;
  if(!s||!(s.max>0))return '';
  const v=Math.min(s.max,s.value);
  return '<div class="pv-steps" data-pv-steps><b>'+v+'</b>/'+s.max+' 步<i><b style="width:'+(v/s.max*100).toFixed(1)+'%"></b></i></div>';
}
function taskProgressStates(task){
  const shots=Array.isArray(task&&task.shots)&&task.shots.length ? task.shots : [
    {done:taskIsDone(task&&task.status),error:task&&task.status==='failed'}
  ];
  let success=0, failed=0;
  shots.forEach(shot=>{
    if(shot&&shot.error) failed++;
    else if(shot&&shot.done) success++;
  });
  const pending=Math.max(0,shots.length-success-failed);
  return Array.from({length:success},()=> 'done')
    .concat(Array.from({length:failed},()=> 'error'))
    .concat(Array.from({length:pending},()=> 'pending'));
}
function taskProgressSignature(task){return taskProgressStates(task).join('|');}
function renderTaskProgress(fill,task,animate){
  if(!fill||!task)return;
  let layer=fill.querySelector('.t-progress-layer');
  if(!layer){fill.innerHTML=taskProgressSegments(task);layer=fill.querySelector('.t-progress-layer');}
  const states=taskProgressStates(task),total=Math.max(1,states.length),ok=states.filter(s=>s==='done').length,err=states.filter(s=>s==='error').length,pending=Math.max(0,total-ok-err),pct=n=>((n/total)*100).toFixed(3)+'%';
  const segments={ok:layer&&layer.querySelector('.t-progress-segment.ok'),err:layer&&layer.querySelector('.t-progress-segment.err'),pending:layer&&layer.querySelector('.t-progress-segment.pending')};
  if(segments.ok)segments.ok.style.width=pct(ok);if(segments.err)segments.err.style.width=pct(err);if(segments.pending)segments.pending.style.width=pct(pending);
  const live=segments.pending&&segments.pending.querySelector('.t-progress-live');if(live)live.style.width=taskLiveWidth(task,pending);
  if(animate){
    task._progressAnimQueue=Math.min(3,(task._progressAnimQueue||0)+1);
    if(!task._progressAnimBusy){
      const play=()=>{task._progressAnimBusy=true;[segments.ok,segments.err].forEach(seg=>{if(!seg||seg.offsetWidth<=0)return;seg.classList.remove('step');void seg.offsetWidth;seg.classList.add('step');});setTimeout(()=>{[segments.ok,segments.err].forEach(seg=>{if(seg)seg.classList.remove('step');});task._progressAnimQueue=Math.max(0,(task._progressAnimQueue||0)-1);if(task._progressAnimQueue>0)play();else task._progressAnimBusy=false;},980);};
      play();
    }
  }
}

// ── 渲染单张任务卡的 DOM ──
function renderTaskEl(task){
  const el = document.createElement('div');
  el.className = 'task' + (taskIsDone(task.status) ? ' done' : '') + (task.status === 'failed' ? ' failed' : '') + (task.status === 'running' ? ' running' : '');
  el.dataset.task = task.id;
  const pct = Math.max(0, Math.min(100, Number(task.pct) || 0));
  el.innerHTML =
    '<div class="task-source-layer"></div>' +
    // ⚠ 压暗层：夹在内容(z3)之下、背景之上。叠压越深压得越黑（setTasks 里设 opacity）。
    '<div class="t-dim"></div>' +
    // ⭐⭐ 2026-09-13 重排：**标题行和进度条一起钉在卡片下沿**。
    //   叠压时下面那几张只露出最下面 STEP=34px —— 以前标题在最上面，
    //   一叠压就全被盖住，用户根本看不出下面压着哪些任务。
    //   现在这 34px 里塞的是【最该看到的两样】：标题 + 进度。
    //   ⚠ ✕ 单独绝对定位到右上角，不跟标题挤 —— 它是"移除"，不是常用动作。
    '<button class="t-close" data-task-close type="button" aria-label="从任务栏移除" title="从任务栏移除（缓存保留）">✕</button>' +
    // ⭐⭐ 底栏排版（2026-09-13 用户定案）：标题和次级信息【挤同一行】。
    //   露出带只有 34px，标题(18)+次级(12)+进度条(6)+间距 放不下三行，
    //   所以次级信息缩成小字跟在标题右边。层级靠【字号】拉开：
    //     标题 15px 粗体  >  张数·渠道·模型 10px 压淡  >  进度数字 12px
    // ⚠ 不放 emoji 图标（2026-09-13 用户要求）：它占掉约 22px，
    //   而标题（预设名）正是这一行最该占满的东西 —— 图标本身不传达任何信息。
    //   任务状态已经由右边的百分比和进度条表达了。
    '<div class="t-head">' +
    '<span class="t-name">' + escapeHtml(task.label) + '</span>' +
    (task.kind==='generation'
      ? '<span class="t-meta">'
        + escapeHtml(((task.shots&&task.shots.length)?(task.shots.length+' 张 · '):'')
          + (task.channelLabel||aiTaskChannelText(task)))
        + '</span>'
      : '') +
    '<span class="t-pct">' + taskStatusText(task,pct) + '</span>' +
    // ⚠⚠ 头部【不放操作按钮】（2026-09-13 用户指出）：
    //   卡片只有 300px 宽，头部已经有 图标+名字+百分比+✕。
    //   我一度往这儿塞了两个按钮，把名字挤得只剩几个字 —— 操作按钮统一走下面的 t-acts 行。
    // 关闭 = 只从任务栏收起，硬盘上的缓存保留(以后"生成记录"还能翻到)。
    '</div>' +
    '<div class="t-sub">' + escapeHtml(task.sub) + '</div>' +
    // ⭐ Phase F：校色引擎没开就发出的单 —— 一行非阻断提示（不挡任何操作）
    (task.noMatchEngine ? '<div class="t-engine-note" data-engine-note>校色引擎没开 · 这单不存底版（对齐用快速版）</div>' : '') +
    taskActionsHtml(task) +
    // ⭐ 指哪抠哪的「三个候选挑一个」放这儿（默认 display:none，有候选时才亮）。
    //   ⚠ 内容由 syncTaskPick() 填，不在这里拼 —— 候选图是异步登记到图片管家的，
    //     建卡那一刻还没有。
    '<div class="t-pick" data-pick="' + task.id + '"></div>' +
    // ⭐⭐ 进度条放【最后】，CSS 里绝对定位到卡片最下沿（2026-09-13 用户要求）。
    //   理由：任务卡叠压时，下面那几张只露出【最下面 STEP=34px】。
    //   进度条原来在头部下方，一叠压就被上面那张完全盖住 ——
    //   而"还有几张没跑完"恰恰是叠压状态下最该一眼看到的信息。
    '<div class="t-bar"><div class="t-fill">' + taskProgressSegments(task) + '</div></div>' +
    '<div class="task-preview" data-preview="' + task.id + '"></div>' +
    // 交互反馈光放入独立裁切层; 右侧预览仍在卡片外部自由展开。
    '<div class="task-light-clip">' +
      '<div class="task-edgehint"></div>' +
      '<div class="task-glow"></div>' +
      '<div class="task-bright"></div>' +
    '</div>';
  // 任务卡背景 = 准备计算的图(运行时喂进来的源图)。虚拟任务用 sourceImg。
  // 多层背景: 深色遮罩在前保证文字可读, 源图在后 cover。
  if (task.sourceImg){
    const safeSrc=String(task.sourceImg).replace(/["\\\r\n]/g,'');
    el.style.backgroundImage =
      'linear-gradient(180deg, hsl(var(--card-h, 220 28%) 6% / calc(.62 * var(--ui-bg-opacity,1))), hsl(var(--card-h, 220 28%) 6% / calc(.35 * var(--ui-bg-opacity,1))) 42%, hsl(var(--card-h, 220 28%) 6% / calc(.52 * var(--ui-bg-opacity,1))))';
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    const layer=el.querySelector('.task-source-layer');
    if(layer) layer.style.backgroundImage='url("'+safeSrc+'")';
    el.classList.add('has-bg');
    // ⚠ 任务卡不在 bg-manager 的 45 张卡体系里(没有 data-bgkey), 所以 applyToCard 不会给它
    //   写 --glow-hsl → 光效只能回落默认橙。这里单独从源图提色, 让任务卡的光也跟图走。
    if (window.BG && window.BG.themeColorFromDataUrl){
      window.BG.themeColorFromDataUrl(safeSrc).then(c=>{
        if (c) el.style.setProperty('--glow-hsl', c.h + ' ' + c.s + '% ' + c.l + '%');
        else el.style.removeProperty('--glow-hsl');   // 纯灰图 → 回落默认橙
      });
      // ⚠ 2026-10-22（方案 C）：这里原来按源图上半部亮度切深字（.on-light）——
      //   字其实在卡片最下面，按上半部判经常判反；而且亮图上深字压在亮图上更糊。现在字永远是浅色 + 自带深描边，不再判亮度。
    }
  }
  return el;
}

// ── 叠压布局(与主卡同一套参数) ──
// 【防越界】任务多了往下叠压会超出窗口底被横切(锐角)。
//   限制最大可见深度 MAX_VISIBLE: 更深的卡统一压到 maxDepth, 不继续往下伸。
const MAX_VISIBLE = 4;              // 最多露出几层(当前+3)
function taskVisibleCount(els){
  if(!els.length) return 0;
  const maxH=Math.max(...els.map(t=>t.offsetHeight||150));
  const top=parseFloat(tasksEl.style.top)||(mainStackMetrics().bottomWithStack+16);
  // 先给当前任务完整卡面留空间，再把剩余高度用于露出底层标题。
  // 即使窗口很矮也保留当前任务；所有任务仍可通过滚轮轮转到顶层。
  const extra=Math.max(0,Math.floor(((window.innerHeight||920)-top-maxH-6)/STEP));
  return Math.min(els.length,MAX_VISIBLE,1+extra);
}
function setTasks(){
  refreshBrowserTaskLock();
  const els = [...tasksEl.querySelectorAll('.task:not(.leaving)')];
  const n = els.length;
  const visible = taskVisibleCount(els);
  tcur=n?((tcur%n)+n)%n:0;
  els.forEach((t, i) => {
    let d = (i - tcur + n) % n;
    const clamped = Math.min(d, visible - 1);          // 超过 visible 层的都压到最大深度
    // ⚠ z-index: 任务卡层级要完全高于报错卡
    //   报错卡最高层 = N-1, 任务卡基准 = N + 10, 确保任务卡最低层也高于报错卡最高层
    const baseZ = N + 10;
    t.style.zIndex = baseZ + (n - d);
    // ⭐⭐ 同主卡（2026-09-13）：**不是透明，是暗**。
    //   opacity 恒为 1（不能看穿，否则标题和背景糊在一起），
    //   靠 .t-dim 那层越往下压得越黑来表达层次。
    t.style.opacity = 1;
    const tdim=t.querySelector('.t-dim');
    if(tdim) tdim.style.opacity = Math.min(0.62, clamped*0.2);
    if (!t.classList.contains('entering')) {
      t.style.transform = 'translate(0, ' + (clamped * STEP) + 'px)';
    }
    // ⚠ 层次感现在全靠阴影：顶层投得最重（它压着下面所有卡），
    //   越深的卡自己投得越轻 —— 它上面已经有别的卡在投影了，再重就糊成一片黑。
    // ⚠⚠ 超过 MAX_VISIBLE 的卡【不投影】（2026-09-14 用户发现）：
    //   它们的位移被压到和最深那张一样，卡身完全叠在同一个位置、被盖得看不见，
    //   但阴影是从卡边缘往外渗的 —— 10 个任务就是 7 份阴影叠在同一圈上，黑成一坨。
    //   卡片有最大叠加数，阴影也得有。
    const buried = d > clamped;                                          // 被压到最大深度之后、完全看不见的
    t.style.boxShadow = buried ? 'none' : clamped > 0
      ? '0 -6px 18px rgba(0,0,0,.42), 0 10px 28px rgba(0,0,0,.22)'   // 上缘加一道内收阴影 = "被压住"
      : '0 18px 50px rgba(0,0,0,.45)';
    // ⚠ 同主卡: 只有顶层(d=0)能交互, 否则叠压在下面露边的任务卡也能点到
    t.style.pointerEvents = (d===0) ? 'auto' : 'none';
    // 2026-10-22（docs/263 第 13 条）：压在下面的不算毛玻璃（样式见 04-tasks.css .stack-under）
    t.classList.toggle('stack-under', d>0);
  });
  if(window.V7FreeMode&&window.V7FreeMode.isActive())window.V7FreeMode.syncSpecialUnit('tasks');
  window.V7FreeMode?.syncEmptyUnits();
  // ⚠⚠ 2026-09-14 修复：任务堆变化时报错堆位置要跟着刷新（报错堆起点要读任务堆高度）
  setErrors();
  stackTrashSync('tasks');   // 2026-10-18 深夜：垃圾桶挪到当前最上面那张卡上
}

