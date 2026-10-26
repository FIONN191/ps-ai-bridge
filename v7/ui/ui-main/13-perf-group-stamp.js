// ═══ ui-main/13-perf-group-stamp.js —— 主界面主程序第 13 / 21 段 ═══
//   管什么：性能监视 · 自动编组 + 图层联动 · 悬停联动 PS · 盖印后自动收起任务卡
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 性能监视 ═══
// ⚠⚠ 这一段【只负责取数和分发】，不关心显示在哪里。
//   现在的消费者是一张 L3 报错卡，但用户明说以后可能挪到别处
//   (独立面板 / 顶栏 / 设置页都有可能)。挪的时候：
//     - 不要动 perfMonitor，它是数据源
//     - 只写一个新的订阅者，然后把旧的 L3 渲染删掉
//   订阅者签名固定为 (sample) => void，sample 结构见 perfSampleShape 注释。
//
// 采样内容 = 壳给的(内存/CPU/GPU) + 界面自己的(图片缓存占用)。
// 图片那部分是我们自己最该盯的：docs/21 治理的就是它。
const perfMonitor=(function(){
  const subscribers=new Set();
  let timer=null, intervalMs=1000, last=null, running=false;

  async function tick(){
    if(running) return;                 // 上一次还没回来就跳过，别堆积
    running=true;
    try{
      const shell=(window.uiwin&&window.uiwin.perf)
        ? await window.uiwin.perf.sample()
        : {ok:false,error:'当前环境不支持性能采样'};
      const img=(window.IMG&&window.IMG.stats)?window.IMG.stats():{count:0,fullBytes:0,thumbBytes:0};
      last=Object.assign({},shell,{
        images:{
          count:img.count,
          fullMB:Math.round(img.fullBytes/1048576*10)/10,
          thumbMB:Math.round(img.thumbBytes/1048576*10)/10
        },
        tasks:(typeof taskList!=='undefined'&&taskList)?taskList.length:0
      });
      subscribers.forEach(fn=>{ try{ fn(last); }catch(_){ } });
    }catch(e){
      last={ok:false,error:(e&&e.message)||String(e)};
      subscribers.forEach(fn=>{ try{ fn(last); }catch(_){ } });
    }finally{ running=false; }
  }

  function ensureTimer(){
    if(timer||!subscribers.size) return;
    tick();                              // 立刻来一发，别让用户等一秒才看到数
    timer=setInterval(tick,intervalMs);
  }
  return {
    // 订阅。返回取消函数 —— ⚠ 没人订阅时定时器会自己停，不空转。
    subscribe(fn){
      subscribers.add(fn);
      if(last) { try{ fn(last); }catch(_){ } }
      ensureTimer();
      return ()=>{
        subscribers.delete(fn);
        if(!subscribers.size&&timer){ clearInterval(timer); timer=null; }
      };
    },
    setInterval(ms){
      intervalMs=Math.max(300,Math.min(10000,Number(ms)||1000));
      if(timer){ clearInterval(timer); timer=null; ensureTimer(); }
    },
    latest(){ return last; }
  };
})();

// ⚠ 所有数字都必须过这个函数再显示。
//   数据源是 Rust 的 f32(sysinfo 给的就是 32 位浮点)，转成 JSON 会渗出精度垃圾：
//   0.6 变成 0.6000000238418579。Rust 那边已经先转 f64 了，这里再兜一道 ——
//   以后换数据源、加新指标，都不用担心又漏一串小数点出来。
function perfNum(value, digits){
  const n=Number(value);
  if(!Number.isFinite(n)) return '—';
  const d=digits==null?1:digits;
  // 整数就不显示 .0，看着干净
  return Number.isInteger(n) ? String(n) : n.toFixed(d);
}
// 把一次采样压成一行给人看的字。挪位置时这个函数可以直接复用。
function perfSummaryLine(s){
  if(!s) return '正在采样…';
  if(!s.ok) return '采样不可用：'+(s.error||'未知原因');
  const p=s.process||{}, g=s.gpu||{}, im=s.images||{};
  return ['内存 '+perfNum(p.memMB)+' MB',
          'CPU '+perfNum(p.cpuPercent)+'%',
          'GPU '+(g.supported?(perfNum(g.utilPercent,0)+'%'):'不支持'),
          '图片 '+perfNum(im.count,0)+' 张 / '+perfNum((im.fullMB||0)+(im.thumbMB||0))+' MB'
         ].join('　·　');
}
// 详细信息(报错卡向右滑出的那一层)。同样可复用。
function perfDetailText(s){
  if(!s||!s.ok) return '暂无数据。';
  const p=s.process||{}, sy=s.system||{}, g=s.gpu||{}, im=s.images||{};
  const rows=[
    '进程内存　　'+perfNum(p.memMB)+' MB（含 '+perfNum(p.processCount,0)+' 个进程）',
    '进程 CPU　　'+perfNum(p.cpuPercent)+'%（整机口径）／ '+perfNum(p.cpuPercentOfOneCore)+'%（单核口径）',
    '系统内存　　'+perfNum(sy.memUsedMB,0)+' / '+perfNum(sy.memTotalMB,0)+' MB　核心数 '+perfNum(sy.cores,0),
    g.supported
      ? ('显卡　　　　'+(g.name||'')+'　占用 '+perfNum(g.utilPercent,0)+'%　显存 '+perfNum(g.memUsedMB,0)+' / '+perfNum(g.memTotalMB,0)+' MB')
      : ('显卡　　　　不支持（'+(g.reason||'')+'）'),
    '图片缓存　　'+perfNum(im.count,0)+' 张　原图 '+perfNum(im.fullMB)+' MB　缩略图 '+perfNum(im.thumbMB)+' MB',
    '任务卡　　　'+perfNum(s.tasks,0)+' 个'
  ];
  return rows.join('\n');
}

// 打开性能监视面板。
//
// ⚠⚠⚠ 2026-10-05 修（用户实测报的）：
//   「调试卡片中一旦打开了性能监测，性能监测会立马作为报错菜单弹出，
//     让我确认或者取消。我无论点确认还是取消，那个性能监测都会消失掉。」
//
//   真因：这里原来调 UI.dialog —— 那是【报错系统的 L3 确认卡】
//   （addErrorCard，天生带"确认/取消"两个按钮、进报错堆、点一下就销毁）。
//   而性能监视是【一块要一直挂着的表】：它不是在问用户"你要不要做这件事"。
//   ⇒ 两个后果都对不上：
//     ① 弹出的位置/形态是"报错菜单"（在报错堆里，用户以为出故障了）
//     ② 一点按钮面板就没了（本来要看的是"持续变化"的数）
//
//   ⇒ 现在它有自己的浮层，右下角常驻，只有那个 × 能关掉它。
//     ⚠ 不重建 DOM：只改文字（每秒重建会让面板闪）。
//     ⚠ 详情区是默认展开的 —— 性能面板要的就是"一眼看全"，
//       而不是报错卡那种"先看标题、想细看再右滑"。
let perfCardHandle=null;
function openPerfCard(){
  if(perfCardHandle){ return perfCardHandle; }   // 已经开着就不重复开
  // ⚠ 挂在 body 上，不挂在卡片里 ——
  //   记忆坑「fixed 全屏层被 transform 祖先困住」：卡片的入场动画会残留 transform，
  //   挂进去 position:fixed 会失效（跟着卡片飘，或者被关进裁切层看不见）。
  const el=document.createElement('section');
  el.className='perf-panel';
  el.setAttribute('role','dialog');
  el.setAttribute('aria-label','性能监视');
  // ⚠⚠ 2026-10-07 修（用户实测报的："点了就卡那了，不可关闭、不可移动"）：
  //   真因不是面板坏了，是它【没登记】——
  //     · overUI()（见文件上半部分）逐条登记每个全窗口浮层，决定"鼠标在这儿算不算在 UI 上"；
  //       没登记 → 面板上被当成"空白" → 窗口切成点击穿透 → 点击漏给下面的 Photoshop
  //       ⇒ 面板上任何按钮都点不到，× 也点不到（用户看到的就是"卡住了"）。
  //   登记方式：在 overUI() 里加一条几何判断（见那里的 2026-10-07 注释）。
  //
  // ⚠⚠⚠ 2026-10-07 晚 重大更正：这里【不能】加 data-ui-overlay！
  //   我第一版就是顺手给它加了 data-ui-overlay="true"（想"照别的工作面的样子登记"），
  //   结果 v7OverlayOpen() 变成恒真 → 全项目都以为"有个大浮层开着" →
  //   **整张卡片、悬浮条、所有按钮的点击全被冻住**（用户实测："别的所有点按全部被冻结"）。
  //   区别在于：大图查看器 / L4 那种确实是【接管整个界面的工作面】，它们配得上这个标记；
  //   性能面板只是右下角一个小浮窗，**不该被当成工作面**。
  //   ⇒ 只登记 overUI 的几何判断（够用：面板上不穿透、别处照旧穿透），
  //     而且不加 data-ui-overlay，`v7OverlayOpen()` 就不会被它带成 true。
  //   ⚠ 顺带记一笔：面板不加这个标记【也不会】被 focus-scope 设成 inert ——
  //     实测过（面板自己 inert=false、祖先里也没有 inert），所以拖拽/关闭照样能用。
  el.innerHTML=
    '<div class="pp-head" data-perf-drag title="拖动这里可以移动面板（双击复位到右下角）"><h4>性能监视</h4>'
    +'<button type="button" class="pp-x" data-perf-close title="关闭" aria-label="关闭">×</button></div>'
    +'<div class="pp-line" data-perf-line>正在采样…</div>'
    +'<button type="button" class="pp-toggle" data-perf-toggle>收起明细</button>'
    +'<pre class="pp-detail" data-perf-detail>启动中…</pre>';
  document.body.appendChild(el);

  // ⚠ 2026-10-07：拖拽 + 记住位置（用户要求"可以拖拽"＋"记住我拖过的位置"）。
  //   做法：把这层从"右下角固定"改成"用 left/top 定位"——
  //     只在【第一次按下拖动】时才把 right/bottom 收掉、算出当时的 left/top，
  //     这样默认位置不变，拖过之后由用户说了算。
  //   ⚠ 拖动期间必须挡住文本选择（否则一拖就选一片字、看着像卡死）。
  (function bindDrag(){
    const head=el.querySelector('[data-perf-drag]');
    if(!head) return;
    let dragging=null;
    // ⚠⚠ 2026-10-07：这个面板位置的字段名只准有【一处口径】。
    //   我第一版就栽在这：保存时写的是 {x,y}，读回来时却去读 {left,top} ——
    //   "有记录"这个判断永远不成立，"记住位置"整个功能等于没接上（而且还是静默的，不报错）。
    //   这跟项目里反复栽过的"两处各写一遍字段名"是同一个坑（memory 坑清单里有）。
    //   ⇒ 统一走这两个函数，别再在别处直接读/写那些字段。
    //   存的是【窗口内坐标】(x,y)：面板住在这张窗户纸里，窗口一挪它也挪，
    //   存屏幕坐标下次开就对不上了。
    const POS_KEYS=['x','y'];
    function readPerfPos(){
      try{
        const s=settingsRuntime&&settingsRuntime.perfPanelPos;
        if(!s) return null;
        const x=Number(s[POS_KEYS[0]]), y=Number(s[POS_KEYS[1]]);
        return (Number.isFinite(x)&&Number.isFinite(y))?{x:x,y:y}:null;
      }catch(_){ return null; }
    }
    function writePerfPos(pos){
      try{ if(!settingsRuntime) return; settingsRuntime.perfPanelPos=pos; settingsSave(); }catch(_){}
    }
    function clampToWindow(){
      const r=el.getBoundingClientRect();
      const maxX=Math.max(0, innerWidth-r.width-8), maxY=Math.max(0, innerHeight-r.height-8);
      const x=Math.min(maxX, Math.max(8, r.left));
      const y=Math.min(maxY, Math.max(8, r.top));
      el.style.left=x+'px'; el.style.top=y+'px';
      el.style.right='auto'; el.style.bottom='auto';
      return {x:Math.round(x), y:Math.round(y)};
    }
    // ① 开的时候：有记过的位置就用它（夹回窗口内），没记过就让它走默认位置
    const saved=readPerfPos();
    if(saved){
      el.style.left=saved.x+'px'; el.style.top=saved.y+'px';
      el.style.right='auto'; el.style.bottom='auto';
      // ⚠ 上次是自由模式（窗口大）、这次是标准模式（窗口小）时，老坐标可能落在窗口外
      //   → 必须夹回来，否则面板一开就在屏幕外看不见。
      clampToWindow();
    }
    head.addEventListener('pointerdown',e=>{
      if(e.button!==0) return;
      if(e.target.closest&&e.target.closest('[data-perf-close]')) return;   // 点 × 不算拖
      const r=el.getBoundingClientRect();
      // 第一次拖：把 right/bottom 定死成 left/top，之后按位移走
      el.style.left=r.left+'px'; el.style.top=r.top+'px';
      el.style.right='auto'; el.style.bottom='auto';
      dragging={dx:e.clientX-r.left, dy:e.clientY-r.top, id:e.pointerId};
      try{ head.setPointerCapture(e.pointerId); }catch(_){}
      el.classList.add('dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove',e=>{
      if(!dragging||e.pointerId!==dragging.id) return;
      el.style.left=(e.clientX-dragging.dx)+'px';
      el.style.top=(e.clientY-dragging.dy)+'px';
    });
    function endDrag(e){
      if(!dragging||(e&&e.pointerId!==dragging.id)) return;
      dragging=null; el.classList.remove('dragging');
      // ② 松手：夹回窗口内 + 记下来（走 writePerfPos，字段名口径只在那两个函数里）
      writePerfPos(clampToWindow());
    }
    head.addEventListener('pointerup',endDrag);
    head.addEventListener('pointercancel',endDrag);
    // ③ 双击标题 → 忘掉记过的位置、回默认（拖飞了也有条退路）
    //   ⚠ 只清 left/top 让它落回 CSS 默认（right:16px + top:70px）。
    //     这里【不能】写 right/bottom —— 我第一版写的 right:16px;bottom:16px
    //     会把面板甩回右下角，跟新的默认位置（右侧中上）不一致，等于双击把人送错地方。
    head.addEventListener('dblclick',e=>{
      if(e.target.closest&&e.target.closest('[data-perf-close]')) return;
      writePerfPos(null);
      el.style.left=''; el.style.top=''; el.style.right=''; el.style.bottom='';
    });
    // 窗口尺寸变了（自由模式切换会改窗口），别把面板留在看不见的地方
    window.addEventListener('resize',()=>{ if(el.style.left&&el.style.left!=='auto') clampToWindow(); });
  })();

  const lineEl=el.querySelector('[data-perf-line]');
  const detailEl2=el.querySelector('[data-perf-detail]');
  const toggleBtn=el.querySelector('[data-perf-toggle]');
  let unsubscribe=null;

  function close(){
    if(unsubscribe){ unsubscribe(); unsubscribe=null; }
    if(el.isConnected) el.remove();
    perfCardHandle=null;
  }
  el.querySelector('[data-perf-close]').addEventListener('click',close);
  toggleBtn.addEventListener('click',()=>{
    const shown=detailEl2.style.display!=='none';
    detailEl2.style.display=shown?'none':'';
    toggleBtn.textContent=shown?'展开明细':'收起明细';
  });

  unsubscribe=perfMonitor.subscribe(s=>{
    // ⚠ 只改文字，不重建 DOM —— 每秒重建一次的话面板会闪。
    if(lineEl) lineEl.textContent=perfSummaryLine(s);
    if(detailEl2) detailEl2.textContent=perfDetailText(s);
  });
  perfCardHandle={el,close};
  return perfCardHandle;
}

// ═══ 自动编组 + 图层联动 ═══
// PS 那一侧的动作全是现成的(桥里已有 ps.group.create 和 conversationLayerVisibility，
// 都是从 V6 生成中心抄过来的成熟实现)，这里只做调度和状态管理。

// 组名先用随机字符(用户 2026-09-08 决定)。以后要改成"提示词+时间"之类，只动这一个函数。
function generationGroupName(){
  return '轮椅-'+Math.random().toString(36).slice(2,8).toUpperCase();
}

// 传回成功后把这批图层收进一个组，并把 ID 记在任务上。
// ⚠ 失败不能影响传回本身 —— 图已经贴进 PS 了，编组只是锦上添花。
// ⭐⭐ 2026-10-11（用户要求）：给传回建的那个组上 PS 标注色。
//
// ⚠ V6 是【写死黄色】（轮椅 4.0 → 6.4.6 八个版本的 host/ps-io.js 都是
//   { color:{_enum:'color',_value:'yellowColor'} }），用户要求 V7 做成可设。
// ⚠ 走 ps.layer.properties（那个口已经能设 name/visible/blendMode，
//   我们给桥加了一个 color 字段）—— 不另造一个桥动作，少一条要维护的路。
function applyGroupColorAfterCreate(groupId, docId, ownsTransfer){
  if(groupId==null) return;                       // 没建成组，没什么可上色的
  const A=window.V7ReturnAppearance;
  if(!A) return;
  const color=A.normalizeGroupColor(settingsRuntime.returnGroupColor);
  if(color==='none') return;                      // 用户选"不给颜色"= 跟 V6 之前一样什么都不做
  linkQueue('ps.layer.properties',{docId,layerId:groupId,color},{
    after:()=>{if(ownsTransfer())aiAddLog('已给组上标注色：'+colorToCn(A,color),'success');},
    // ⚠ 上色失败【不是】传回失败：图和组都在，只是没颜色。
    //   但不能不说 —— 不说的话用户设了颜色却看不到，只会以为功能坏了（铁律 17）。
    afterError:res=>{if(ownsTransfer())aiAddLog('给组上标注色失败：'+linkResultMessage(res)+'（图和组都传回去了，只是没上色）','warn');}
  }).catch(()=>{});
}
function colorToCn(A,value){
  const hit=A.groupColorChoices().find(x=>x[0]===value);
  return hit?hit[1]:value;
}

// ⭐⭐ 2026-10-11（用户要求）：任务完成音效。
//
// ⚠ 三个位的判定跟 V6 对齐（照 V6 的调用点推的）：
//     全成功 → 任务成功音；全失败 → 全部失败音；有成功也有失败 → 单个失败音
//   ⚠ V6 的默认值照搬：成功='三七唐笑'，另两位='none'（即不响）。
// ⚠ 总开关默认【关】（用户 2026-10-11 定：完成音效默认不启用，用户自己去开）。
//   所以这里先判 soundEnabled，没开就一声不吭 —— 这是用户要的默认行为，不是静默失效。
// ⭐ 10-25（反馈 #16）：原来只挂在「自动编组成功」那一个回调里 ⇒ 关了自动编组 / 建组失败 / 第二批传回 / 传回失败都不响。
//   现在挂在「这一次传回结束」（aiTransferSend 成功和失败两头），跟自动编组没关系了。
//   result：传回失败时直接给 {total, ok:0}；不给就照任务里的张数算。
function playTaskResultSound(task, ownsTransfer, result){
  const A=window.V7ReturnAppearance;
  if(!A) return;
  if(settingsRuntime.soundEnabled!==true) return;
  if(!ownsTransfer()) return;
  const live=taskById(task&&(task.taskId||task.id))||task||{};
  const outputs=Array.isArray(live.outputs)?live.outputs:[];
  const sent=Array.isArray(live.sentOutputs)?live.sentOutputs:[];
  const total=result?result.total:(outputs.length||sent.length);
  // ok：这一轮真正传回去的张数（sentOutputs 里非空的那些）
  const ok=result?result.ok:(sent.filter(x=>x!=null).length||outputs.filter(x=>x&&x.ok!==false).length);
  A.playForResult({total,ok},settingsRuntime,{
    warn:(msg,error)=>{try{aiAddLog(msg+(error?('：'+String(error&&error.message||error).slice(0,80)):''),'warn');}catch(_){}}
  });
}
function autoGroupAfterTransfer(task, data, docId, sentOutputs, ownsTransfer){
  ownsTransfer=ownsTransfer||aiTaskContextGuard(task);
  if(!ownsTransfer()) return;
  const raw=(data&&Array.isArray(data.layerIds))?data.layerIds:[];
  if(!raw.length) return;
  // ⚠⚠ 序号对照表 —— 2026-09-08 确诊的 bug 就出在这里。
  //   raw[k] 对应的是【发过去的第 k 张】，而不是【任务里的第 k 张】。
  //   发过去的只有成功的图(outputs 已经滤掉失败项)，所以一旦有图失败，
  //   直接拿 raw[缩略图序号] 就会整体错位 —— 用户表现为"划第3张，PS 显示第5张"，
  //   而且【只在有失败图时才出现】，全成功时碰巧对得上，极具迷惑性。
  //   ⚠ V6 的 placeImagesBatch 是特意 push(null) 保住位置的，
  //     以前那句 .filter(x=>x!=null) 把这份好意毁了，这里不再过滤。
  const outs=Array.isArray(sentOutputs)?sentOutputs:[];
  const layerByShot={};                // 任务里的第几张(0基) → 图层 ID
  const layerIds=[];
  raw.forEach((lid,k)=>{
    if(lid==null) return;              // 这一张贴回失败了，位置留空
    layerIds.push(lid);
    const shotIdx=outs[k]&&outs[k].index;
    if(shotIdx!=null&&Number.isFinite(Number(shotIdx))) layerByShot[Number(shotIdx)]=lid;
  });
  if(!layerIds.length) return;
  const targetDoc=(data&&data.docId!=null)?data.docId:docId;
  // ⚠⚠ 2026-09-13 修（用户实测的"重复传回 / ID 混乱 / 预览错位"总病根）：
  //   这里以前是【整张表覆盖】。分几次传回时：
  //     第一次传 0、1 号 → 表 = {0:图层A, 1:图层B}
  //     第二次传 2、3 号 → 表被换成 {2:图层C, 3:图层D}   ← 0、1 号的记录没了
  //   而这张表是三件事共用的唯一判据，一丢就连锁出三个 bug：
  //     ① taskTransferableOutputs 又把 0、1 号算成"还没传" → 按钮回来，再点一次真的贴第二份
  //     ② generationSoloLayer 找不到 0 号的图层，退回按序号猜 → 指到别的图层(错位)或指不到(没反应)
  //     ③ ps.group.soloOwned 的 ownedLayerIds 只剩最后一批 → 联动漏掉前面那些图层
  //   所以必须【合并】，不能覆盖。
  const prevTask=taskById(task.taskId||task.id)||task;
  const mergedMap=Object.assign({},prevTask.psLayerByShot||{},layerByShot);
  const prevIds=Array.isArray(prevTask.psLayerIds)?prevTask.psLayerIds:[];
  const mergedIds=prevIds.concat(layerIds.filter(id=>prevIds.indexOf(id)<0));
  updateGenerationTask(task.taskId||task.id,{psLayerIds:mergedIds, psLayerByShot:mergedMap, psDocId:targetDoc});
  if(!settingsRuntime.autoGroup) return;
  // ⭐⭐ 分几次传回时，后面那几批要进【原来那个组】，不能另起（2026-09-13 用户定案）。
  //   一个任务的图散在三四个"轮椅-XXXX"组里，用户根本没法管。
  //   ⚠ 判据用 task.psGroupId —— 它是第一次编组成功时写进任务的。
  const liveTask=taskById(task.taskId||task.id)||task;
  const existingGroup=liveTask&&liveTask.psGroupId;
  if(existingGroup!=null){
    linkQueue('ps.group.addTo',{docId:targetDoc,groupId:existingGroup,layerIds},{
      after:()=>{if(ownsTransfer())aiAddLog('已并入原分组 '+(liveTask.psGroupName||existingGroup)+'（'+layerIds.length+' 张）','success');},
      // ⚠ 并组失败不算传回失败：图已经贴进 PS 了，只是没归到组里。
      //   但要说出来 —— 不说的话用户会以为组丢了。
      afterError:res=>{if(ownsTransfer())aiAddLog('并入原分组失败：'+linkResultMessage(res)+'（图已经贴进去了，只是没归组）','warn');}
    }).catch(()=>{});
    cacheSetTaskbar(liveTask, true);
    // ⚠ 基线只在【还没有】的时候补记（老缓存恢复回来的任务没有这个字段）。
    //   已经有基线的【绝不能重记】：重记会把用户这期间盖印的那一层也收进基线，
    //   于是那次盖印永远不会被认出来。
    if(!Array.isArray(liveTask.stampBaseline)) recordStampBaseline(liveTask, existingGroup, targetDoc, ownsTransfer);
    else stampWatch.ensure();
    return;
  }
  const groupName=generationGroupName();
  // ⭐ 2026-10-20（docs/250 第 9 条）：带上贴图那个文档 —— 插件原来只在「当前激活的文档」上建组，中途切了文档就建错 / 失败（隔壁 addTo 早就带了）
  linkQueue('ps.group.create',{docId:targetDoc,layerIds,groupName},{
    after:res=>{
      if(!ownsTransfer()) return;
      updateGenerationTask(task.taskId||task.id,{psGroupId:res&&res.groupId, psGroupName:groupName});
      aiAddLog('已编组：'+groupName+'（'+layerIds.length+' 张）','success');
      // 组信息也要写进缓存，重启后恢复的任务才能继续联动
      cacheSetTaskbar(task, true);
      // ⭐ 编组成功的这一刻记基线，"盖印后自动收起"全靠它防误判。
      recordStampBaseline(task, res&&res.groupId, targetDoc, ownsTransfer);
      // ⭐⭐ 2026-10-11（用户要求）：给这个组上 PS 的标注色。
      //   ⚠ 为什么要等 res.groupId：颜色是打在【组】上的，没有组 ID 就没法定位。
      //     建组失败（res.groupId 是 null）时跳过 —— 不给"误伤别的图层"的机会。
      //   ⚠ 上色失败【不算传回失败】：图已经贴进去了、组也建了，只是没颜色。
      //     但必须说出来，不能说"成功了"然后颜色没上（铁律 17）。
      applyGroupColorAfterCreate(res&&res.groupId, targetDoc, ownsTransfer);
      // 完成音效 10-25 起挪到 aiTransferSend（传回一结束就响，不等编组），见 playTaskResultSound 上面的说明
    },
    afterError:res=>{if(ownsTransfer())aiAddLog('自动编组失败：'+linkResultMessage(res),'warn');}
  }).catch(()=>{});
}

// ⭐ 记一份"同层图层 ID 基线"（2026-09-14）。
// 这是「盖印后自动收起」判定链的第②道，也是防误判的主力：
//   基线 = 编组那一刻，组所在那一层有哪些图层。
//   之后只有【基线里没有的】图层才可能被判成盖印 ——
//   用户原来就摆在组上方的图层，永远不会让任务卡莫名消失。
//
// ⚠ 拿不到基线时【什么都不写】(而不是写个空数组)：
//   空数组会让"所有图层都是新的"，第②道就形同虚设，直接变成误判制造机。
//   eligible() 里用 Array.isArray(task.stampBaseline) 挡着，没基线的任务干脆不参与判定。
function recordStampBaseline(task, groupId, docId, ownsTransfer){
  ownsTransfer=ownsTransfer||aiTaskContextGuard(task);
  if(!ownsTransfer()) return;
  if(groupId==null||!settingsRuntime.autoDismissOnStamp) return;
  linkQueue('ps.group.stampProbe',{docId:docId,groupIds:[groupId]},{
    after:(data)=>{
      if(!ownsTransfer()) return;
      const g=data&&Array.isArray(data.groups)?data.groups.find(x=>Number(x.groupId)===Number(groupId)):null;
      if(!g||g.found!==true||!Array.isArray(g.siblingIds)) return;
      // ⚠ 组自己也在 siblingIds 里，不用剔 —— 第④道会把它当"任务占用的"排除掉。
      updateGenerationTask(task.taskId||task.id,{stampBaseline:g.siblingIds.map(Number)});
      const live=taskById(task.taskId||task.id);
      if(live) cacheSetTaskbar(live, true);          // 基线要落盘，重启后恢复的任务才有判定基准
      if(isDebugOn()){ const m='已记下基线：'+g.siblingIds.length+' 个同层图层（组 index='+g.groupIndex+'）'; aiAddLog('[盖印] '+m,'info'); dbg('盖印',m); }
      stampWatch.ensure();
    },
    // ⚠ 不再静默（2026-09-14）：基线记不下 = 这个任务永远不会被判，用户得知道。
    //   插件旧版报"未注册"时，弹的是那张"去 Reload"的卡，跟 stampWatch 用同一个错误码。
    afterError:(result)=>{
      if(!ownsTransfer()) return;
      const msg=linkResultMessage(result);
      const code=(result&&result.error&&result.error.code)||'';
      try{ if(window.__TAURI__&&window.__TAURI__.core) window.__TAURI__.core.invoke('debug_log',{message:'[盖印] ⚠ 记基线失败 code='+(code||'无')+'：'+msg}).catch(()=>{}); }catch(_){ }
      if(code==='UNKNOWN_ACTION'||/未注册/.test(msg)) ERR.report('STAMP_PROBE_MISSING',{message:'记基线时：'+msg});
      else ERR.report('STAMP_PROBE_FAILED',{message:'基线没记下（这个任务以后不会被判盖印）：'+msg,title:'盖印基线没记下：'+msg.slice(0,90),duration:8000});
    }
  }).catch(()=>{});
}

// ── hover 联动：划到哪张，PS 里就单独显示哪张 ──
// ⚠ 三道闸，缺一个都会出问题：
//   ① 防抖：鼠标扫过一排缩略图会触发几十次，不防抖就是往桥里灌指令
//   ② 丢弃过期：只认最后一次，中间那些扫过的不执行(否则 PS 会一张张补演)
//   ③ 去重：同一张图重复 hover 不重发
let soloPending=null, soloTimer=null, soloCurrent='';
const SOLO_DEBOUNCE_MS=90;      // 停留这么久才发；扫过不触发
// ⭐⭐ 2026-10-14：缩略图【单击 vs 双击】的判定窗。
//   单击 = 开大预览框；双击 = 跳过去并聚焦缩放。两者都挂在同一个 img 上，
//   不做防抖的话双击的第一下会先把大图开出来（用户实测报的就是这个：
//   "它会让我们的点按出大图，打开之后再收回才能跳转到对应的地方"）。
//   ⇒ 单击的处理【延后这么多毫秒】再执行，双击一到就取消它。
//   ⚠ 220ms 是常见双击判定窗（Windows 默认 500ms 偏慢、用户会嫌单击迟钝）。
//     这段延迟只影响"单击开大图"，不影响悬停预览条那条路。
const DBL_MS=220;
// ⭐ 2026-10-19（docs/250 第 4 条）：缩略图「划到哪张、PS 里只显示哪张」只认鼠标真的移过来的那一下（见 hover-intent.js）。
//   ⚠ 用 var：buildPreview 在文件更前面，事件触发时才读它（那时早就有了）；万一没加载上就是 null，退回老行为（照旧触发）。
//   ⚠ 监听只在这里挂一次（顶层），别挪进会反复调用的重绘函数里（记忆：重复挂监听会锁死整机）。
var thumbHover=(window.V7HoverIntent&&typeof V7HoverIntent.create==='function')?V7HoverIntent.create():null;
if(thumbHover){
  window.addEventListener('mousemove',e=>thumbHover.move(e),true);
  window.addEventListener('wheel',()=>thumbHover.wheel(),{capture:true,passive:true});
}
function generationSoloLayer(task, shotIndex, forceFocus){
  if(!task || !settingsRuntime.autoGroup) return;
  // ⚠ 优先用对照表，【绝不能】拿 shotIndex 去索引 psLayerIds ——
  //   那个数组只含"贴回成功的"，和任务里的张数对不上，有失败图就整体错位。
  const map=task.psLayerByShot;
  let layerId=(map&&map[shotIndex]!=null)?map[shotIndex]:null;
  // 兼容: 对照表是 2026-09-09 才加的。之前就在任务栏里的任务、以及旧缓存恢复的任务
  // 都没有它 —— 没有兜底的话它们划上去毫无反应(而且不报错，很难发现)。
  // 退回旧的按序号取值; 这批老任务如果当初有失败图确实可能错位，但总比完全不动强。
  if(layerId==null){
    const ids=Array.isArray(task.psLayerIds)?task.psLayerIds:[];
    if(ids.length) layerId=ids[shotIndex];
  }
  if(layerId==null) return;
  const key=String(task.id)+':'+layerId+(forceFocus?':focus':'');
  if(key===soloCurrent) return;                    // ③ 已经是它了，不重发
  soloPending={task,layerId,key,forceFocus:!!forceFocus};
  if(soloTimer) clearTimeout(soloTimer);           // ② 覆盖掉上一次待发的
  soloTimer=setTimeout(()=>{
    soloTimer=null;
    const job=soloPending; soloPending=null;
    if(!job) return;
    soloCurrent=job.key;
    // ⚠ 用 ps.group.soloOwned 而不是 V6 的 conversationLayerVisibility：
    //   前者以"组"为物理边界(只动组内成员)，且不会一路点亮祖先组。
    //   V6 那个会把父组链全点亮，会改到用户自己建的组。
    const params = {
      docId:job.task.psDocId,
      groupId:job.task.psGroupId,
      ownedLayerIds:job.task.psLayerIds,
      soloLayerId:job.layerId,
      allowSwitchDocument:!!settingsRuntime.soloSwitchDocument,
      // ⭐⭐ 2026-10-14（用户定）：focusRegion 不再由开关控制，改由【双击】触发。
      //   · 划过（单击悬停）→ focusRegion=false：只在 PS 里单独显示那张，不动视口。
      //   · 双击缩略图      → focusRegion=true：跳过去并把图层缩放到填满画面。
      //   ⚠ 键 soloFocusRegion 保留不读（老存档兼容），真正的判据是 job.forceFocus。
      focusRegion:!!job.forceFocus
    };
    // ⚠ 探针：记到调试卡片日志里
    addLinkLog({
      direction:'UI → UXP',
      level:'info',
      message:'[聚焦探针] focusRegion='+params.focusRegion+' 触发='+(job.forceFocus?'双击':'划过')+' layerId='+job.layerId,
      action:'ps.group.soloOwned'
    });
    linkQueue('ps.group.soloOwned',params,{
      // ⚠ 别静默成功/失败都不吭声 —— 这个功能"不生效"时完全没有反馈，
      //   2026-09-09 改坏过一次(要求 groupId，而它一直是 undefined)，查了很久。
      //   现在把结果打到 Rust 控制台，一划就知道卡在哪一步。
      after:res=>{
        // ⚠ UXP 把聚焦日志塞在 applied 数组里({_focusLog:...})，不在 res 顶层
        const focusEntry=res&&Array.isArray(res.applied)?res.applied.find(x=>x&&x._focusLog):null;
        addLinkLog({
          direction:'UXP → UI',
          level:res&&res.ok===false?'error':'info',
          message:'[聚焦探针] 返回 ok='+(res?res.ok:'null')+' reason='+((res&&res.reason)||'无')+
            ' 聚焦日志='+(focusEntry?JSON.stringify(focusEntry._focusLog):'没有(UXP 没执行聚焦代码)'),
          action:'ps.group.soloOwned'
        });
        if(res&&res.ok===false&&window.__TAURI__)
          window.__TAURI__.core.invoke('debug_log',{message:'单显未生效: '+(res.reason||'未知')+
            ' (组ID='+job.task.psGroupId+' 图层='+job.layerId+')'}).catch(()=>{});
      },
      // 图层可能已被用户删掉/文档已关闭 —— 静默降级，不弹报错烦人
      afterError:err=>{
        soloCurrent='';
        addLinkLog({direction:'UXP → UI',level:'error',
          message:'[聚焦探针] 执行失败: '+((err&&err.error&&err.error.message)||'未知'),
          action:'ps.group.soloOwned'});
      }
    }).catch(()=>{ soloCurrent=''; });
  }, SOLO_DEBOUNCE_MS);          // ①
}
// ⚠ 鼠标移出【不恢复全部显示】—— 用户 2026-09-08 定的：停在挪走的那一张。
//   所以这里只清标记，不发 restore 指令。

// ═══ 盖印后自动收起任务卡（2026-09-14 用户要求）═══════════════════
//
// 需求原话：「如果盖印了图层，并且盖印的图层在任务传回组的上方，
//            任务卡片内的被盖印的任务自动消失」
//
// ⭐ 判定链（四道，缺一道都会误判）：
//   ① 位置   —— 候选层必须【压在这个任务的传回组上方】，同一层级(兄弟)
//   ② 新出现 —— 编组那一刻记过一份【同层图层 ID 基线】，只有基线里没有的才算候选。
//                这一道是防误判的主力：用户原来就摆在组上方的图层永远不会中招。
//   ③ 类型   —— 不是图层组、不是智能对象。传回的 AI 图全是智能对象，先排掉自己。
//   ④ 不是别人的 —— 所有任务的 psLayerIds / psGroupId 全部排除，
//                    否则任务 B 的图刚贴到任务 A 的组上方时，会被当成 A 被盖印了。
//
// ⚠⚠ 【认不出盖印的两种情况，都必须是"什么都不做"】，不能反过来：
//   盖印在 PS 里就是个普通图层，名字叫"图层 1"，没有任何标记能证明它是盖印出来的。
//   所以这套判定天生只能靠猜。宁可漏判(卡不消失，用户手点 ✕)，
//   绝不能误判(卡自己消失了，而且现在还找不回来)。所有拿不准的分支一律 return。
//
// ⚠ 收起 = 和用户手点 ✕ 完全一样：cacheSetTaskbar(false) + removeTask()。
//   硬盘缓存保留，不删图。
const stampWatch=(function(){
  let timer=null, busy=false;
  const PROBE_MS=2000;
  const PROBE_ACTION='ps.group.stampProbe';
  // ⚠ 方向常量：doc.layers 的 0 号是【最上面】还是【最下面】，
  //   我们没有本地类型定义可查，也没在真 PS 里实测过（用户当时正在用 PS，不能试）。
  //   现在按 UXP 文档的说法取"0 = 最上面"，也就是【索引越小越靠上】。
  //   万一反了：表现是"盖印了卡不消失"（偏保守那头，不会误删），
  //   把这个常量改成 false 即可，别去改判定逻辑。
  //   ⭐ 每次抓到候选都会往日志里打一行实际拿到的 index/name/kind，对着它校准。
  const INDEX_ZERO_IS_TOP=true;

  // ═══ 排查记录（2026-09-14 用户定案）═══
  // 用户原话：调试模式开着 + 盖印功能开着 → 记录所有关于盖印和新建图层的操作，
  //           并解释这个操作为什么没有触发；不要静默失败；条件由用户来判断。
  // 所以这里【不改判定规则】，只把探针看到的每一个变化和每一道门的裁定写出来。
  //
  // 两条出口：
  //   note(msg) —— 事实和解释。只在调试模式下记，不然平时日志全是它。
  //   失败      —— 一律走 ERR.report / warn，【不管调试模式开没开】。
  // ⚠ 都只在"变了"的时候写，不是每 2 秒一条：状态没变就不重复（onChange）。
  const seenReason={};        // 每个键上一次的"为什么不判"，变了才记
  const snap={};              // 每个组上一轮的样子(同层 ID / 组内 ID / 组位置)，用来找"新出现的图层"
  const verdictSeen={};       // 每个组上一轮的裁定，变了才记
  const errorSeen=new Set();  // 探针失败原因，同一条只报一次
  let missingReported=false;  // "插件是旧版"那张报错卡，一次会话只弹一次

  // ⚠ 三个出口都要写（2026-09-14 用户实测"探针没跑成"却查不到原因）：
  //   ① aiAddLog —— 界面内存日志，用户在日志分区能翻到
  //   ② dbg     —— 调试模式下弹胶囊，用户当场看见
  //   ③ Rust 控制台 —— 【排查的人能看】。只写①②的话我这边是瞎的，
  //      上一版就是这么写的，结果用户截了张只有标题的图，原因一个字没有。
  function toRust(line){ try{ if(window.__TAURI__&&window.__TAURI__.core) window.__TAURI__.core.invoke('debug_log',{message:'[盖印] '+line}).catch(()=>{}); }catch(_){ } }
  function note(msg){ if(!isDebugOn()) return; aiAddLog('[盖印] '+msg,'info'); dbg('盖印',msg); toRust(msg); }
  function warn(msg){ aiAddLog('[盖印] '+msg,'warn'); dbg('盖印',msg,'warn'); toRust('⚠ '+msg); }
  function onChange(key, reason, fn){ if(seenReason[key]===reason) return; seenReason[key]=reason; try{ fn(); }catch(_){ } }
  function describeLayer(it){
    return '「'+((it&&it.name)||'?')+'」(id='+(it&&it.id)+' kind='+((it&&it.kind)||'空')+' index='+(it&&it.index)+')';
  }

  // 这个任务为什么【不】参与判定。返回空串 = 可以判。
  // ⚠ 任何一条不满足都直接排除 —— 判定只在"任务已经安顿好"的状态下做。
  //   每条原因都是给用户看的人话：他要拿这个判断规则该不该改。
  function ineligibleReason(task){
    if(!task||task.kind!=='generation') return '不是生成任务';
    if(task.psGroupId==null) return '没有编组（自动编组关着、或编组失败了）—— 没有组就没有判定基准';
    if(task.psDocId==null) return '没记下它在哪个文档里';
    if(!Array.isArray(task.stampBaseline)) return '没有基线 —— 这个任务编组时盖印功能还没上线（或是从旧缓存恢复的），没记过"编组时同层有哪些图层"。只有【新传回并编组】的任务才会记基线';
    if(task._transferBusy) return '正在往 Photoshop 贴图';
    const pending=taskPendingTransfer(task);
    if(pending>0) return '还有 '+pending+' 张没传回，任务没结束';
    if(task.status==='running'||task.status==='submitting'||task.status==='queued') return '任务还在跑（状态 '+task.status+'）';
    return '';
  }
  function eligible(task){ return ineligibleReason(task)===''; }

  // 所有任务占用的图层/组 ID —— 第④道用。
  // ⚠ 必须跨【全部任务】收集，不能只看当前这个任务自己的。
  function ownedByAnyTask(){
    const own=new Set();
    (taskList||[]).forEach(t=>{
      if(!t) return;
      (Array.isArray(t.psLayerIds)?t.psLayerIds:[]).forEach(id=>own.add(Number(id)));
      if(t.psGroupId!=null) own.add(Number(t.psGroupId));
      (t.shots||[]).forEach(s=>{
        if(s&&s.detailLayerId!=null) own.add(Number(s.detailLayerId));
        // ⭐ 2026-10-05：「应用」贴的那层也是我们的（跟补细节层同一个待遇）
        if(s&&s.tweenLayerId!=null) own.add(Number(s.tweenLayerId));
      });
    });
    return own;
  }

  // 这一层是不是"容器"(图层组)。
  // ⚠ kind 到底是什么字符串我们没实测过，所以做成两条互为兜底、且都偏保守：
  //   · kind 有值 → 只认已知的组类型名
  //   · kind 是空的 → 退回看有没有 layers 属性(桥那边把它报成 hasChildren，
  //     普通图层没有这个属性 → null；组即使是空的也会给 true/false)
  //   拿不准时【当成容器】(=排除掉)，因为漏判比误判安全。
  function looksLikeContainer(item){
    const kind=String(item&&item.kind||'').toLowerCase();
    if(kind) return kind.indexOf('group')>=0||kind.indexOf('layersection')>=0||kind.indexOf('set')>=0;
    return !!item&&item.hasChildren!==null;
  }
  function looksLikeSmartObject(item){
    const kind=String(item&&item.kind||'').toLowerCase();
    return kind.indexOf('smart')>=0;
  }

  // 从组往【上】找候选。返回 {item, above, reason}：
  //   item   命中的那一层；没命中就是 null
  //   above  紧贴组上方那一层(不管有没有命中)，给记录用
  //   reason 人话，说清楚为什么判成/没判成 —— 用户拿它来定规则
  function findStamp(group, baseline, owned){
    if(!group||group.found!==true) return {item:null,above:null,reason:'组在 Photoshop 里找不到了（被删了？）'};
    if(!Array.isArray(group.near)) return {item:null,above:null,reason:'探针没给出组附近的图层'};
    const at=Number(group.groupIndex);
    if(!Number.isFinite(at)||at<0) return {item:null,above:null,reason:'探针没给出组的位置'};
    // ⭐ 只看【紧贴组上方那一层】，不往上多找。
    //
    // ⚠⚠ 我第一版是"往上逐层找、跳过基线里的老图层"，那是个误判制造机：
    //   用户在组上方原本有 5 个老图层(全在基线里)，他在【最顶上】新建一层画草稿，
    //   那种写法会一路跳过那 5 层、撞上最顶那个新图层 → 判成"盖印了"，卡莫名消失。
    //
    // ⭐ 为什么"紧贴"就够：盖印【一定是紧贴的】。选中组按 Ctrl+Alt+E(盖印组)
    //   或 Ctrl+Shift+Alt+E(盖印可见)时，PS 把新层插在【当前选中层的正上方】，
    //   组上方原有的老图层会被顶得更高。所以"紧贴组上方那一层是不是新的"
    //   既是最紧的判据，也最贴合需求原话("盖印的图层在传回组的上方")。
    //
    // ⚠ 代价(明说)：你要是盖印完又往上挪了一层别的东西，就认不出来了 —— 漏判。
    //   漏判只是卡不消失、手点 ✕ 就行；误判是卡自己没了还找不回来。选前者。
    const step=INDEX_ZERO_IS_TOP?-1:1;             // -1 = 索引越小越靠上
    const above=group.near.find(it=>Number(it.index)===at+step);
    if(!above) return {item:null,above:null,reason:'组上方没有图层（组已经在最顶上）'};
    const id=Number(above.id);
    const who='紧贴组上方的是 '+describeLayer(above);
    // 是别的任务(或本任务)的图层/组：不是盖印。
    // ⭐ 这一条同时负责多组消歧：你给 A 组盖印、A 组下面还压着 B 组时，
    //   B 组往上看到的是 A 的东西 → B 不动，只有 A 的卡消失。
    if(owned.has(id)) return {item:null,above,reason:who+' —— 那是某个任务自己传回的图/组，不算盖印'};
    if(new Set(baseline.map(Number)).has(id)) return {item:null,above,reason:who+' —— 编组时它就在那儿了（在基线里），不是新图层'};
    if(looksLikeContainer(above)) return {item:null,above,reason:who+' —— 它是图层组，不是盖印层'};
    if(looksLikeSmartObject(above)) return {item:null,above,reason:who+' —— 它是智能对象，盖印出来的应该是普通像素层'};
    return {item:above,above,reason:who+' —— 新的、普通像素层、紧贴组上方 → 判定为盖印'};
  }

  // 把这一轮探针看到的东西和上一轮比，新出现/消失/挪位的全记下来，然后给裁定。
  // ⚠ 只记变化。状态没变的组一个字都不写。
  function inspect(g, task, data, owned){
    const gid=Number(g.groupId);
    const step=INDEX_ZERO_IS_TOP?-1:1;
    const cur={
      sib:Array.isArray(g.siblingIds)?g.siblingIds.map(Number):[],
      kids:Array.isArray(g.children)?g.children.map(c=>Number(c.id)):[],
      at:Number(g.groupIndex)
    };
    const prev=snap[gid];
    snap[gid]=cur;
    const label='任务「'+(task.label||task.id)+'」的组「'+(task.psGroupName||gid)+'」';
    const near={}; (g.near||[]).forEach(it=>{ near[Number(it.id)]=it; });
    const active=new Set(Array.isArray(data.activeLayerIds)?data.activeLayerIds.map(Number):[]);
    const whereOf=(idx)=>{ const rel=(idx-cur.at)*step; return rel>0?('组上方第 '+rel+' 层'):rel<0?('组下方第 '+(-rel)+' 层'):'组自己的位置'; };
    const nameOf=(id)=>near[id]?describeLayer(near[id]):('id='+id+'（离组太远，探针窗口里拿不到名字和类型）');
    if(!prev){
      // 第一次看到这个组：报一下现状，并把"编组以来新增的"列出来（重启后恢复的任务靠这个补课）
      const base=new Set(task.stampBaseline.map(Number));
      const since=cur.sib.map((id,idx)=>({id,idx})).filter(x=>!base.has(x.id)&&!owned.has(x.id));
      note('开始盯 '+label+'：组在同层第 '+cur.at+' 位（共 '+cur.sib.length+' 层），组内 '+cur.kids.length+' 张，基线 '+task.stampBaseline.length+' 层'
        +(since.length?('；编组以来同层新增 '+since.length+' 层：'+since.slice(0,5).map(x=>nameOf(x.id)+' 在'+whereOf(x.idx)).join('；')):'；编组以来同层没有新图层'));
    }else{
      const prevSib=new Set(prev.sib), prevKids=new Set(prev.kids);
      cur.sib.forEach((id,idx)=>{
        if(prevSib.has(id)) return;
        note('同层新出现图层 '+nameOf(id)+'，在'+whereOf(idx)
          +(active.has(id)?'，现在选中的就是它':'')
          +(owned.has(id)?'，它是某个任务传回的图层':''));
      });
      cur.kids.forEach(id=>{
        if(prevKids.has(id)) return;
        const c=(g.children||[]).find(x=>Number(x.id)===id);
        note('组【内部】新出现图层「'+((c&&c.name)||'?')+'」(id='+id+' kind='+((c&&c.kind)||'空')+')'
          +(active.has(id)?'，现在选中的就是它':'')
          +' —— 盖印层落进了组里面。判定只看组旁边，所以不算。盖印前要在图层面板里点选组本身，别点组里的图');
      });
      prev.sib.forEach(id=>{ if(cur.sib.indexOf(id)<0) note('同层少了一个图层 id='+id+'（被删了或挪走了）'); });
      if(prev.at!==cur.at) note(label+' 从同层第 '+prev.at+' 位挪到了第 '+cur.at+' 位');
    }
    const v=findStamp(g, task.stampBaseline, owned);
    const vkey=(v.above?v.above.id:'-')+'|'+v.reason;
    if(verdictSeen[gid]!==vkey){ verdictSeen[gid]=vkey; note(label+'：'+v.reason); }
    return v;
  }

  // 桥报上来的命令清单里有没有探针。清单还没到(空)时不下结论。
  function probeMissing(){
    const list=linkRuntime.actions;
    if(!Array.isArray(list)||!list.length) return false;
    return !list.some(a=>(Array.isArray(a)?a[0]:(a&&a.name))===PROBE_ACTION);
  }

  async function tick(){
    if(busy) return;
    if(!settingsRuntime.autoDismissOnStamp||!settingsRuntime.autoGroup){
      onChange('tick','off',()=>note('没在盯：设置里「盖印后收起」或「自动编组」关着'));
      return;
    }
    if(!linkRuntime.connected){
      onChange('tick','nobridge',()=>note('没在盯：Photoshop 插件没连上'));
      return;
    }
    // ⚠⚠ 插件是旧版：这是"盖印了卡不消失"最常见的原因(2026-09-14 用户实测撞上)。
    //   编译桌面板不会更新 Photoshop 里的插件，那边得单独 Reload。
    //   以前这条路是静默的 —— 探针报"未注册 action"，回调里一个字不吐。
    if(probeMissing()){
      onChange('tick','missing',()=>{
        if(!missingReported){ missingReported=true; ERR.report('STAMP_PROBE_MISSING',{message:'插件报上来的命令清单里没有 '+PROBE_ACTION}); }
        else warn('插件还是旧版，没有盖印探针，去 UXP Developer Tool 里 Reload');
      });
      return;
    }
    // 逐个任务说清楚为什么不判。变了才记，不刷屏。
    const cands=[];
    (taskList||[]).forEach(t=>{
      if(!t||t.kind!=='generation') return;
      const why=ineligibleReason(t);
      onChange('task:'+t.id, why, ()=>note('任务「'+(t.label||t.id)+'」'+(why?('不参与判定：'+why):'开始参与判定')));
      if(!why) cands.push(t);
    });
    if(!cands.length){
      onChange('tick','idle',()=>note('这一轮没有可判定的任务（原因见上面每个任务那行）'));
      return;
    }
    // ⚠ 只查【当前活动文档】的任务：在用户看不见的文档里判"他盖印了"没有依据。
    //   活动文档是哪个由桥的回执告诉我们(isActiveDocument)，这里先按文档分组，
    //   一次只问一个文档 —— 免得一轮发好几条指令。
    const docId=cands[0].psDocId;
    const sameDoc=cands.filter(t=>String(t.psDocId)===String(docId));
    // ⚠ 任何任务正在贴图时整轮跳过：那会儿图层正在变，
    //   刚贴上、还没写进 psLayerIds 的图层会被当成盖印(第④道来不及生效)。
    if((taskList||[]).some(t=>t&&t._transferBusy)){
      onChange('tick','transfer',()=>note('先不判：有任务正在往 Photoshop 贴图'));
      return;
    }
    onChange('tick','probing',()=>note('开始盯 '+sameDoc.length+' 个任务（文档 '+docId+'），每 2 秒看一次'));
    // ⚠⚠ busy 必须在【回执回来】时才解，不能在 linkQueue 的 promise 后面解 ——
    //   linkQueue 的 promise 是"已入队"就 resolve 的，不是"PS 执行完了"。
    //   在那儿解锁的话：用户正在做一次十几秒的大图传回时，探针会每 2 秒往队列里压一条，
    //   全都排在那次传回后面 —— 传回一结束，几十条探针连着轰进 PS。
    //   所以这里在 after / afterError / 入队失败【三个出口】都解，漏一个探针就永久停摆。
    busy=true;
    let released=false;
    let guard=null;
    const release=()=>{ if(!released){ released=true; busy=false; if(guard){ clearTimeout(guard); guard=null; } } };
    // ⚠ 兜底闹钟：UXP 插件被卸载/PS 崩了的时候，回执【两个回调都不会来】——
    //   没这个闹钟 busy 就永久是 true，整个功能从此静默失效(而且完全没有报错，最难查的那种)。
    //   15 秒足够慢的 PS 走完一次只读探针；超时就当这轮没发生，下轮重来。
    guard=setTimeout(release,15000);
    try{
      const byGroup={};
      sameDoc.forEach(t=>{ byGroup[Number(t.psGroupId)]=t; });
      const res=await linkQueue(PROBE_ACTION,{docId:docId,groupIds:Object.keys(byGroup).map(Number)},{
        after:(data)=>{
          release();
          if(!data||data.ok!==true){
            onChange('probe','notok:'+(data&&data.reason),()=>note('探针回来说：'+((data&&data.reason==='DOCUMENT_CLOSED')?'那个文档已经关了':('没成功（'+(data&&data.reason||'没说原因')+'）'))));
            return;
          }
          if(!Array.isArray(data.groups)) return;
          if(data.isActiveDocument!==true){
            onChange('probe','inactive',()=>note('先不判：任务所在的文档不是 Photoshop 当前正在看的那个'));
            return;
          }
          onChange('probe','ok',()=>{});
          const owned=ownedByAnyTask();
          data.groups.forEach(g=>{
            const task=byGroup[Number(g.groupId)];
            if(!task) return;
            // ⚠ 每个组单独兜住：一个组的记录/裁定抛了错，不能把后面的组一起带走，
            //   而且抛出去只会落到 linkHandleResult 那句"后续链路步骤异常"，看不出是哪个组。
            try{
              const why=ineligibleReason(task);               // 等回执这段时间里状态可能变了，重新验一遍
              if(why){ onChange('task:'+task.id, why, ()=>note('任务「'+(task.label||task.id)+'」不参与判定：'+why)); return; }
              const v=inspect(g, task, data, owned);
              if(!v.item) return;
              const hit=v.item;
              // ⭐ 收起这一条【不管调试模式】都记 —— 卡自己没了，用户必须知道是谁干的。
              //   把实际拿到的事实一起打出来，kind 的真实取值就靠这行校准。
              const line='检测到盖印层'+describeLayer(hit)+'（组 index='+g.groupIndex+'），任务「'+(task.label||task.id)+'」已自动从任务栏收起（硬盘上的图保留，历史卡里能找回）';
              aiAddLog(line,'info'); toRust(line);
              cacheSetTaskbar(task,false);
              removeTask(task.id);
            }catch(e){ warn('处理组 '+g.groupId+' 的回执时出错：'+String(e&&e.message||e)); }
          });
        },
        // 组被删了/文档关了/插件旧版/PS 正忙都会走到这里。⚠ 不再静默：同一原因只报一次。
        afterError:(result)=>{
          release();
          const msg=linkResultMessage(result);
          const code=(result&&result.error&&result.error.code)||'';
          // 原因先打到日志和 Rust 控制台（每次都打，dedupe 只管弹卡）
          warn('探针失败 code='+(code||'无')+'：'+msg);
          if(errorSeen.has(msg)) return;
          errorSeen.add(msg);
          if(code==='UNKNOWN_ACTION'||/未注册/.test(msg)){
            if(!missingReported){ missingReported=true; ERR.report('STAMP_PROBE_MISSING',{message:msg}); }
          }else{
            // ⚠ L1 提示只显示标题 —— 原因必须塞进标题里，不然用户只看到"没跑成"三个字(2026-09-14 实测)。
            ERR.report('STAMP_PROBE_FAILED',{message:msg,title:'盖印探针没跑成：'+msg.slice(0,90),duration:8000});
          }
        }
      });
      // 入队本身就失败了(桥断了等)：回执永远不会来，必须在这儿解锁。
      if(!res||res.ok===false){ release(); warn('探针没能入队：'+((res&&res.error)||'桥不可用')); }
    }catch(e){ release(); warn('探针这一轮出错：'+String(e&&e.message||e)); }
  }

  // ⚠ 表【一直走】，不再"没任务就停、等人来叫醒"。
  //   以前那套要靠 recordStampBaseline / addTo / cacheRestore 三处记得来 ensure()，
  //   漏一处就是永远不动、而且没有任何声音。现在开着功能就每 2 秒看一眼，
  //   没事干的一轮只是过一遍 taskList，连桥都不碰，代价可以忽略。
  function start(){ if(!timer) timer=setInterval(tick,PROBE_MS); }
  function stop(){ if(timer){ clearInterval(timer); timer=null; } }
  return {
    ensure(){ if(settingsRuntime.autoDismissOnStamp&&settingsRuntime.autoGroup) start(); else stop(); },
    stop:stop
  };
})();
// 定义完就起表(开关关着时 ensure 内部什么都不做)。
try{ stampWatch.ensure(); }catch(_){ }

