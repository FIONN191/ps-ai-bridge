// ═══ ui-main/08-matting.js —— 主界面主程序第 8 / 21 段 ═══
//   管什么：抠像链路 · 抠像的唯一入口
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 抠像链路（2026-09-14）════════════════════════════════════
//   抓 PS 选区/画布 → 送引擎抠图 → 贴回一个带透明通道的图层
//
// ⚠ 和生成链路的关键不同：抠像【没有本机兜底】。
//   引擎没起、模型没装 —— 一律弹卡说清楚，不能静默什么都不发生（docs/40 规矩5）。
// ⚠ 每一步失败都要说【是哪一步】。"抠像失败"是废话，
//   "没找到选区"和"引擎没响应"是完全不同的下一步动作（铁律 15）。
let mattingBusy = false;

// 抠像的抓图上限。⚠ 故意【不】读设置里那个"抓取分辨率"——
//   那一项写的是"发给 AI 的图"，默认 2048。抠像是给原图加一层透明，
//   缩了就是把用户的原图降质，贴回去还要拉大回选区尺寸（用户报的"分辨率极低"）。
//   0 / 没填 = 原始尺寸不缩。
// ⚠ 不缩的时候必须给一个【很大的数】而不是 0：桥那边是
//   `if (p.maxResolution) settings.maxResolution = ...`，传 0 会让它沿用上一次的值
//   （settings.maxResolution 是个粘住的全局）——那正好又缩回 2048。
const MATTING_NO_LIMIT = 999999;
function mattingMaxEdge(params){
  const v = Number(params && params.res) || 0;
  return v > 0 ? v : MATTING_NO_LIMIT;
}

// 把选区夹进画布范围。⚠ 读不到文档尺寸就原样返回 —— 宁可不夹，也不要拿 0 去夹成空。
function mattingClampSelection(sel, docW, docH){
  if(!sel) return null;
  const dw = Number(docW)||0, dh = Number(docH)||0;
  if(dw<=0 || dh<=0) return sel;
  const left   = Math.max(0,  Math.min(dw, Math.round(Number(sel.left)||0)));
  const top    = Math.max(0,  Math.min(dh, Math.round(Number(sel.top)||0)));
  const right  = Math.max(left+1, Math.min(dw, Math.round(Number(sel.right)|| (left+(Number(sel.width)||0)))));
  const bottom = Math.max(top+1,  Math.min(dh, Math.round(Number(sel.bottom)||(top +(Number(sel.height)||0)))));
  return {left, top, right, bottom, width:right-left, height:bottom-top};
}

// ═══ 抠像的唯一入口（2026-09-14 下半场重做）═════════════════
//
//  ⭐ 和生成一样：先建任务卡，再干活。docs/20 的规矩——
//    "任务卡是用户看到状态的唯一入口"。原来这条链路只往日志里写几行，
//    用户点完屏幕上什么都不变（他报的"抠像没有进入到任务栏"）。
//
//  ⚠ 失败一律走 updateGenerationTask(status:'failed')，
//    报错卡由那个出口统一弹 —— 别在这里自己再 ERR.report 一遍，会弹两张。
// ⭐ 2026-10-15（用户要求「每次使用的时候按需要把这个东西调度起来，然后冷启动」）：
//   抠像 / 人体解析 / 指哪抠哪 点下去时引擎没开着 ⇒ 自己拉起来、等它就绪再往下走，
//   不再报"去外挂能力卡点「启动」"。拉不起来才交给后面的 unusableReason 报错（带原因）。
//   ⚠ 同时点了好几个工具只拉一次（共用同一个启动过程）。
let toolEngineStarting=null;
async function toolEngineReady(id,label){
  // ⭐ 2026-10-18 云端外挂（docs/237）：开着云端就先问云端 —— 能用就不碰本机引擎（不带模型的包本来也没有）；
  //   云端不行时 cloud-tools.js 已经【如实提示过】并决定好退回本机（route='local'，下面照旧拉起本机）还是没路可退（'none'）。
  if(window.V7CloudTools&&V7CloudTools.enabled()){
    const say=sub=>{if(id==null)return;try{updateGenerationTask(id,sub);}catch(_){}};
    say({sub:'正在连云端…',pct:4});
    const r=await V7CloudTools.ensureReady();
    if(r.route==='cloud'){ await MATTINGENGINE.probe(true); return; }
    if(r.route==='none'){ say({sub:(r.why&&r.why.text)||'云端连不上'}); return; }
    say({sub:'云端连不上，改用本机引擎…',pct:4});
  }
  await MATTINGENGINE.probe(true);
  if(MATTINGENGINE.snapshot().available) return;
  if(!(window.uiwin&&uiwin.engine&&uiwin.engine.start)) return;
  const say=sub=>{if(id==null)return;try{updateGenerationTask(id,sub);}catch(_){}};
  say({sub:'正在启动'+label+'引擎（冷启动，第一次要等十几秒）',pct:4});
  aiAddLog('['+label+'] 引擎没开着，自动启动…','info');
  if(!toolEngineStarting){
    toolEngineStarting=engineStartAndWait(m=>say({sub:label+'引擎 · '+m}),'matting')
      .finally(()=>{toolEngineStarting=null;});
  }
  const r=await toolEngineStarting;
  if(r&&!r.ok) aiAddLog('['+label+'] 自动启动没成功：'+r.error,'warn');
  else aiAddLog('['+label+'] 引擎已启动','success');
  await MATTINGENGINE.probe(true);
}
// 给自包含的模块用（改动强度 / 助手语义识别）：没有任务卡可写，只拉引擎
window.V7EngineEnsure=label=>toolEngineReady(null,label||'外挂');
// ⭐ 2026-10-15（用户定：空闲 10 分钟就关闭）：由【引擎自己】看门退出（multi_engine_server.py 的 _idle_watchdog）。
//   ⚠⚠ 界面这边【不许】定时去调 uiwin.engine.stop：两个壳的停止入口都故意弹确认框，
//     第一版就是这么写的 ⇒ 每分钟弹一次「停止抠像引擎」框（用户截图报的），点取消还会接着弹。
//   退出后下次用到，上面的 toolEngineReady 会自动拉起来。
async function startMatting(preset, params){
  if(!window.MATTINGENGINE){
    ERR.report('MATTING_START_FAILED',{message:'matting-engine.js 没加载'});
    return false;
  }
  if(mattingBusy){
    // ⚠ 引擎一次只加载一个模型，两个请求打进去会互相等/爆显存。这里就闸住。
    ERR.report('MATTING_BUSY',{message:'上一次还没跑完，等它完事再按'});
    return false;
  }
  const PU = window.PRESETUI;
  const p = preset || (PU && PU.getToolPreset && PU.getToolPreset()) || null;
  const vals = params || (PU && PU.getToolParams && PU.getToolParams()) || {};
  const label = String((p && p.title) || '抠像');

  const runId = aiNewTaskId('mt');
  const task = addTask(makeMattingTask({taskId:runId, label}));
  const id = task.id;
  const t0 = Date.now();
  mattingBusy = true;

  // ⚠ 第四个参数 true = "上游已经弹过更详细的卡了"，这里只改任务状态别再弹一张。
  // ⚠⚠ 必须把【已经抠出来的那张】保住：updateGenerationTask 在转 failed 时，
  //   如果调用方没给 shots，会把所有没完成的格子刷成错误态、连 imgId 一起清掉。
  //   贴回那一步失败时图其实已经在手上了，清掉等于让用户白跑一趟。
  const fail = (message, stage, code, alreadyReported)=>{
    const live = taskById(id);
    const keep = live && Array.isArray(live.shots) && live.shots.some(s=>s&&s.done&&s.imgId)
      ? {shots:live.shots} : {};
    updateGenerationTask(id, Object.assign({status:'failed', stage, errorCode:code||'MATTING_RUN_FAILED',
      error:String(message||'抠像失败'), _errorReported:!!alreadyReported}, keep));
    aiAddLog('[抠像] 失败（'+(stage||'?')+'）：'+String(message||''),'warn');
  };

  try{
    // ── ① 引擎能不能用。先问，别让用户白等一次抓图 ──
    updateGenerationTask(id,{status:'running', sub:'检查抠像引擎', pct:5});
    await toolEngineReady(id,'抠像');
    const why = MATTINGENGINE.unusableReason();
    if(why){ fail(why,'engine','MATTING_UNUSABLE'); return true; }
    // 用户在面板里挑的档位 ∩ 引擎实际能给的（两边取严，见 matting-engine 的 pickTier）
    const tierNotes = [];
    const useTier = MATTINGENGINE.pickTier(vals.tier, tierNotes);
    updateTask(id,{mattingTierName:MATTINGENGINE.tierName(useTier)});
    // ⚠ 降档了必须说（docs/40 规矩4）：用户选了高清档却跑了标准档，
    //   不说的话他会一直以为"这就是高清档的效果"。
    tierNotes.forEach(n=>aiAddLog('[抠像] '+n,'warn'));

    // ── ② 抓图（原始尺寸，不缩）──
    const maxEdge = mattingMaxEdge(vals);
    updateGenerationTask(id,{sub:'从 Photoshop 抓选区', pct:12});
    aiAddLog('[抠像] 开始 · 正在从 Photoshop 抓图'+(maxEdge===MATTING_NO_LIMIT?'（原始尺寸）':('（上限 '+maxEdge+'）')),'info');
    const cap = await new Promise((res,rej)=>{
      linkQueue('ps.selection.capture',
        {allowFullCanvas:!!settingsRuntime.autoFullCanvas, maxResolution:maxEdge},
        { after:(d)=>res(d),
          // ⚠ 把桥给的诊断现场原样带出来 —— 它知道"文档是16位"这种真正有用的信息
          afterError:(r)=>rej(new Error(linkResultMessage(r))) }
      ).catch(e=>rej(e));
    });
    const b64 = cap && (cap.imageBase64 || cap.inputImageBase64);
    if(!b64){ fail('抓回来的数据里没有图片','capture','PS_CAPTURE_FAILED'); return true; }

    const capW = Number(cap.width)||0, capH = Number(cap.height)||0;
    updateTask(id,{
      sourceDocId:cap.docId, sourceDocName:cap.docName||'',
      sourceSelection:cap.selection||null,
      mattingSize:capW+'×'+capH
    });
    // 任务卡的背景 = 这次抠的那张图。⚠ 必须过图片管家，不能直接把 base64 当背景。
    registerTaskSourceImage(id, b64, cap.mime||'image/png');
    updateGenerationTask(id,{sub:'已抓 '+capW+'×'+capH+' · 正在抠', pct:30});
    aiAddLog('[抠像] 已抓取 '+capW+'×'+capH+' · 正在抠','info');
    // ⚠ 超大图只提醒不拦：拦了用户就没法用原始尺寸，而他明确要的就是原始尺寸。
    if(Math.max(capW,capH) > 6000){
      aiAddLog('[抠像] ⚠ 这张有 '+capW+'×'+capH+'，一来一回的数据量很大，慢是正常的。'
             + '嫌慢就在抠像面板里把「抓图分辨率」调低一档','warn');
    }

    // ── ③ 送引擎 ──
    // ⚠ base64 转二进制再发：引擎那边按二进制读，
    //   直接发 base64 会多 33% 体积还要多解一次码（docs/21 的账）。
    const bin = base64ToBytes(String(b64).replace(/^data:[^,]+,/,''));
    const tier = vals && vals.tier;
    // ⭐ 盖印+蒙版那条路只要 alpha 一个通道（RGB 全黑），实测比整张 RGBA 省 8 倍
    //   （2000×1333 的图：1.77MB → 222KB）。老的"贴透明图层"那条路还是要 RGBA。
    const useMask = String(vals.applyMode || 'mask') === 'mask';
    const qp = [];
    if(tier && tier !== 'auto') qp.push('model=' + encodeURIComponent(MATTINGENGINE.keyForTier(Number(tier), 'matting') || ''));
    if(useMask) qp.push('out=alpha');
    const qs = qp.length ? ('?' + qp.join('&')) : '';
    let resp;
    try{
      resp = await fetch(MATTINGENGINE.base + '/matting' + qs, {
        method:'POST',
        headers:{ 'Content-Type':'image/png',
                  'X-Matting-Params': encodeURIComponent(JSON.stringify(vals||{})) },
        body: bin
      });
    }catch(e){
      fail('引擎没应答：'+String(e&&e.message||e),'matting','MATTING_RUN_FAILED'); return true;
    }
    if(!resp.ok){
      let msg = 'HTTP ' + resp.status, code = 'MATTING_RUN_FAILED';
      try{ const j = await resp.json(); if(j && j.error) msg = j.error; if(j && j.code) code = j.code; }catch(_){}
      fail(msg,'matting',code); return true;
    }
    const buf = await resp.arrayBuffer();
    let info = null;
    try{ info = JSON.parse(decodeURIComponent(resp.headers.get('X-Matting-Info')||'')); }catch(_){}

    // ⚠ 用户开了某项但这台机器做不了 → 必须说（docs/40 规矩4）
    if(info && info.skipped && info.skipped.length){
      aiAddLog('[抠像] ⚠ 这几项没做成（缺 opencv）：'+info.skipped.join('、'),'warn');
    }

    // ── ④ 算贴回的位置 ──
    //
    // ⚠⚠ 这一段是 2026-09-14 那次"回图比例错误"的正解，动之前先读完：
    //
    //   贴回的实现（ps-io.js 的 _placeCoreInModal）是：量一下贴进去那个图层多大，
    //   然后【横竖分别拉伸】到目标框那么大。对生成的图没问题——它不透明，
    //   图层大小就是整张图。
    //   但抠出来的图是【透明】的，Photoshop 报的图层大小是"只框住主体那一块"，
    //   不是整张图。于是"主体那一小块"被硬拉成"整个选区那么大"
    //   —— 比例扭了、位置错了、还被放大好几倍（用户报的那两条症状）。
    //
    //   解法：引擎把图【裁到主体那一块】再回来，同时告诉我们这块在原图里的位置
    //   （info.bbox）。裁完之后"图层大小 == 整张图"重新成立，
    //   原来那套拉伸逻辑就又对了，只要把目标框也换成对应的那一小块。
    //   ⭐ 这个改法不依赖"Photoshop 到底怎么量图层大小"——两种量法结果都对。
    // ⚠ 选区可能框到画布外面去（框选时拖出了边）。Photoshop 抓像素时会把范围
    //   裁回画布内，但报上来的 selection 还是没裁的那个 —— 两者对不上，
    //   拿它换算位置就会整块偏。先按文档尺寸夹一刀（正常选区夹了等于没夹）。
    const sel = mattingClampSelection(cap.selection, cap.docWidth, cap.docHeight);
    let target = sel;
    const bb = info && Array.isArray(info.bbox) && info.bbox.length===4 ? info.bbox : null;
    const iw = (info && info.size && Number(info.size[0])) || capW;
    const ih = (info && info.size && Number(info.size[1])) || capH;
    // ⚠ 夹完还对不上就是还有别的没想到的情况 —— 明着说出来，别静默算一个错位置。
    //   （铁律 17：宁可坏得看得见，也不要安静地不对）
    if(sel && iw>0 && ih>0 && sel.width>0 && sel.height>0){
      const r1 = sel.width/sel.height, r2 = iw/ih;
      if(Math.abs(r1-r2) > 0.02*Math.max(r1,r2)){
        aiAddLog('[抠像] ⚠ 选区('+sel.width+'×'+sel.height+')和抓回来的图('+iw+'×'+ih+')比例对不上，'
               + '贴回的位置可能有偏差。把这句连同选区大小报给开发','warn');
      }
    }
    // ⚠⚠ 上面这整套 bbox 换算【只有"贴透明图层"那条老路才需要】。
    //   走"盖印 + 蒙版"时根本没有"贴到哪、多大"的问题：
    //   alpha 是整张（没裁），目标就是选区本身，蒙版直接盖在盖印层上。
    //   这正是用户那句「直接盖印当前画面然后生成一个蒙版」最值钱的地方 ——
    //   它把坑55 那一整套补丁连根拔掉了。
    if(!useMask && sel && bb && iw>0 && ih>0){
      // 抓图可能被缩过（用户把分辨率调低了），所以是"图片像素 → 文档像素"的换算，
      // 不是直接加 —— 两边尺寸不一样时直接加会整块错位。
      const kx = (Number(sel.width)||iw) / iw;
      const ky = (Number(sel.height)||ih) / ih;
      const left   = Math.round(Number(sel.left) + bb[0]*kx);
      const top    = Math.round(Number(sel.top)  + bb[1]*ky);
      const right  = Math.round(Number(sel.left) + bb[2]*kx);
      const bottom = Math.round(Number(sel.top)  + bb[3]*ky);
      target = { left, top, right, bottom,
                 width: Math.max(1, right-left), height: Math.max(1, bottom-top) };
    }

    // ── ⑤ 结果先进任务卡，再贴回 ──
    // ⚠ 顺序是有讲究的：先登记缩略图，万一贴回失败（比如文档被关了），
    //   用户至少还能在任务卡里看到抠出来的东西，不是白跑一趟。
    const outBytes = new Uint8Array(buf);
    const outB64 = 'data:image/png;base64,' + bytesToBase64(outBytes);
    let outImgId = '';
    try{
      if(window.IMG) outImgId = await window.IMG.putFromBase64(outB64, 'image/png');
    }catch(e){ aiAddLog('[抠像] 缩略图登记失败（不影响贴回）：'+String(e&&e.message||e),'warn'); }
    updateGenerationTask(id,{sub: useMask ? '抠好了 · 正在盖印并加蒙版' : '抠好了 · 正在贴回 Photoshop',
      pct:80, shots:[{done:true, imgId:outImgId}]});

    await new Promise((res,rej)=>{
      const done = { after:()=>res(), afterError:(r)=>rej(new Error(linkResultMessage(r))) };
      if(useMask){
        // ⭐ 盖印当前画面 + 把 alpha 做成图层蒙版（用户 2026-09-14 晚定的新方式）。
        //   ⚠ 位置交给 selection 就够了 —— 不用 bbox，见上面那段注释。
        linkQueue('ps.mask.applyStamp',
          { docId: cap.docId,
            alphaBase64: outB64,
            selection: sel || cap.selection,
            layerName: label },
          done).catch(e=>rej(e));
      }else{
        linkQueue('ps.layer.place',
          { imageBase64: outB64,
            targetDocId: cap.docId,
            targetSelection: target,
            // ⚠ 必须 smartObject：抠出来的图层用户多半还要缩放/变形，
            //   普通像素层缩一次就掉画质
            layerType: 'smartObject' },
          done).catch(e=>rej(e));
      }
    });

    const ms = Date.now()-t0;
    const seg = info && info.ms ? ('推理 '+info.ms.infer+'ms · ') : '';
    const outSize = bb ? ((bb[2]-bb[0])+'×'+(bb[3]-bb[1])) : (capW+'×'+capH);
    // ⚠ 结尾这句话要跟【实际做了什么】对上。两条路产物完全不同，
    //   都写"已贴回"的话，用户去图层面板找那张透明图会找不到（他拿到的是带蒙版的盖印层）。
    const doneWord = useMask ? '已盖印并加好蒙版' : '已贴回';
    updateGenerationTask(id,{status:'done', pct:100,
      sub:outSize+' · '+seg+'共 '+ms+'ms · '+doneWord});
    aiAddLog('[抠像] 完成 · '+outSize+' · 共 '+ms+'ms '+(seg?('（'+seg.replace(/ · $/,'')+'）'):'')+' · '+doneWord
      +(useMask?'（想改边缘就拿画笔在蒙版上涂：白色=露出，黑色=挡住）':''),'success');
  }catch(e){
    // ⚠ 走到这儿的只剩"贴回"那一步抛的（前面几步都自己 fail 过并 return 了）
    fail(String(e&&e.message||e),'transfer','MATTING_PLACE_FAILED');
  }finally{
    mattingBusy = false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  人体解析 / 指哪抠哪（2026-09-14 深夜）
//
//  ⚠⚠ 这两条链路和抠像【共用同一条路】，照 startMatting 的骨架写的：
//      检查引擎 → 抓选区 → 送引擎 → 结果进任务卡 → 盖印做蒙版
//    共用的东西有：抓图(ps.selection.capture)、抓图分辨率(mattingMaxEdge)、
//    选区夹取(mattingClampSelection)、任务卡渲染、报错卡、盖印蒙版的桥动作。
//    ⚠ 改其中任何一条时先想想另外两条会不会一起受影响。
//
//  ⚠ 三个 busy 闸【分开】：引擎一次只加载一个大模型，但三个功能各跑各的时
//    互相等是对的，而"抠像在跑就不让点分割"会让用户以为界面卡死。
//    真正的串行由引擎那边保证（它自己一次只留一个会话）。
// ═══════════════════════════════════════════════════════════
let segmentBusy = false, sam2Busy = false;

// ⭐ 哪些任务种类属于"工具类"（走外挂引擎、报错现场是同一套）。
//   ⚠ 再加一种外挂能力时【只改这一行】——别去各处补 `kind==='xxx'||...`，
//     那种散落的判断必然漏，而且漏了不报错（铁律 17）。
const TOOL_TASK_KINDS = ['matting','segment','sam2','glow','dlss'];

// 指哪抠哪：三个候选的原始数据先寄存在这儿，用户挑中哪个再取哪个。
// ⚠ 故意【不挂在 task 对象上】：task 会被写进生成记录/缓存，
//   带着三份 base64 进去等于把缓存撑大好几倍（docs/21 那笔账）。
const sam2Pending = new Map();      // taskId -> [{index, alphaBase64}, ...]

function makeToolTask(kind, payload, shotCount){
  const taskId=++taskSeq;
  const n=Math.max(1, Number(shotCount)||1);
  return {
    id:taskId, kind:String(kind), taskId:String(payload&&payload.taskId||''),
    label:String(payload&&payload.label||''),
    presetTitle:String(payload&&payload.label||''),
    icon:'hourglass',
    shots:Array.from({length:n},()=>({done:false})),
    pct:0, status:'queued', sub:'准备开始 · 等 Photoshop 选区',
    page:0, sourceImg:placeholderSVG((taskId*53)%360), sourceImgId:'',
    errorInfo:null, life:0, startedAt:Date.now(),
    outputs:[], errors:[],
    mattingTierName:'', mattingSize:'',
    sourceDocId:null, sourceDocName:'', sourceSelection:null,
    cancelRequested:false, returnState:'idle'
  };
}

// 三条链路共用的"抓选区"。返回 {cap, b64, capW, capH} 或抛错。
async function toolCaptureSelection(id, vals, opts){
  const maxEdge = mattingMaxEdge(vals);
  updateGenerationTask(id,{sub:'从 Photoshop 抓选区', pct:12});
  const cap = await new Promise((res,rej)=>{
    linkQueue('ps.selection.capture',
      { allowFullCanvas: (opts&&opts.allowFullCanvas!==undefined)
          ? !!opts.allowFullCanvas : !!settingsRuntime.autoFullCanvas,
        maxResolution: maxEdge },
      { after:(d)=>res(d),
        // ⚠ 把桥给的诊断现场原样带出来 —— 它知道"文档是16位"这种真正有用的信息
        afterError:(r)=>rej(new Error(linkResultMessage(r))) }
    ).catch(e=>rej(e));
  });
  const b64 = cap && (cap.imageBase64 || cap.inputImageBase64);
  if(!b64) throw Object.assign(new Error('抓回来的数据里没有图片'),{code:'PS_CAPTURE_FAILED',stage:'capture'});
  return { cap, b64, capW:Number(cap.width)||0, capH:Number(cap.height)||0 };
}

// ───────────────────────────────────────────────────────────
//  人体解析：一次认出十几个部位 → 一个组，每个部位一个图层 + 蒙版
//  产物形态是用户定的：「新建一个组 组里是我的多份原图，原图会有蒙版，
//  蒙版就是推理出的部位和范围，图层的名字是部位名字」
// ───────────────────────────────────────────────────────────
async function startSegment(preset, params){
  if(!window.MATTINGENGINE){ ERR.report('SEGMENT_RUN_FAILED',{message:'matting-engine.js 没加载'}); return false; }
  if(segmentBusy){ ERR.report('SEGMENT_BUSY',{message:'上一次还没跑完，等它完事再按'}); return false; }
  const PU = window.PRESETUI;
  const p = preset || (PU && PU.getToolPreset && PU.getToolPreset()) || null;
  const vals = params || (PU && PU.getToolParams && PU.getToolParams()) || {};
  const label = String((p && p.title) || '人体解析');

  const runId = aiNewTaskId('sg');
  const task = addTask(makeToolTask('segment',{taskId:runId, label},1));
  const id = task.id;
  const t0 = Date.now();
  segmentBusy = true;

  const fail = (message, stage, code)=>{
    const live = taskById(id);
    const keep = live && Array.isArray(live.shots) && live.shots.some(s=>s&&s.done&&s.imgId) ? {shots:live.shots} : {};
    updateGenerationTask(id, Object.assign({status:'failed', stage,
      errorCode:code||'SEGMENT_RUN_FAILED', error:String(message||'人体解析失败')}, keep));
    aiAddLog('[人体解析] 失败（'+(stage||'?')+'）：'+String(message||''),'warn');
  };

  try{
    // ── ① 引擎能不能用 ──
    updateGenerationTask(id,{status:'running', sub:'检查人体解析引擎', pct:5});
    await toolEngineReady(id,'人体解析');
    const why = MATTINGENGINE.unusableReason('segment');
    if(why){ fail(why,'engine','SEGMENT_UNUSABLE'); return true; }
    const tierNotes = [];
    const useTier = MATTINGENGINE.pickTier(vals.tier, tierNotes, 'segment');
    updateTask(id,{mattingTierName:MATTINGENGINE.tierName(useTier,'segment')});
    tierNotes.forEach(n=>aiAddLog('[人体解析] '+n,'warn'));

    // ── ② 抓图 ──
    const { cap, b64, capW, capH } = await toolCaptureSelection(id, vals, {});
    updateTask(id,{sourceDocId:cap.docId, sourceDocName:cap.docName||'',
      sourceSelection:cap.selection||null, mattingSize:capW+'×'+capH});
    registerTaskSourceImage(id, b64, cap.mime||'image/png');
    updateGenerationTask(id,{sub:'已抓 '+capW+'×'+capH+' · 正在认部位', pct:30});

    // ── ③ 送引擎 ──
    const bin = base64ToBytes(String(b64).replace(/^data:[^,]+,/,''));
    const qp = [];
    if(vals.tier && vals.tier!=='auto') qp.push('model='+encodeURIComponent(MATTINGENGINE.keyForTier(Number(vals.tier),'segment')||''));
    let resp;
    try{
      resp = await fetch(MATTINGENGINE.base + '/segment' + (qp.length?('?'+qp.join('&')):''), {
        method:'POST',
        headers:{ 'Content-Type':'image/png',
                  'X-Params': encodeURIComponent(JSON.stringify({
                    parts: Array.isArray(vals.parts)?vals.parts:[],
                    minPercent: Number(vals.minPercent)||0.3,
                    masks: true
                  })) },
        body: bin
      });
    }catch(e){ fail('引擎没应答：'+String(e&&e.message||e),'segment','SEGMENT_RUN_FAILED'); return true; }
    if(!resp.ok){
      let msg='HTTP '+resp.status, code='SEGMENT_RUN_FAILED';
      try{ const j=await resp.json(); if(j&&j.error) msg=j.error; if(j&&j.code) code=j.code; }catch(_){}
      fail(msg,'segment',code); return true;
    }
    const data = await resp.json();

    // ── ④ 挑出要做成图层的部位 ──
    // ⚠ 背景(id 0)永远不做 —— 用户要的是主体的部位，把背景做成图层没有意义。
    const want = new Set((Array.isArray(vals.parts)?vals.parts:[]).map(Number));
    const parts = (data.parts||[])
      .filter(x => Number(x.id)!==0 && x.alphaB64)
      .filter(x => !want.size || want.has(Number(x.id)));
    if(!parts.length){
      // ⚠ 分两种情况说，否则用户查不下去：是"这图里没人"还是"你勾的那几个没有"
      if(want.size) fail('你勾的那几个部位，这张图里一个都没认出来','segment','SEGMENT_NO_PICKED_PART');
      else fail('模型在这块区域里没认出人','segment','SEGMENT_EMPTY');
      return true;
    }

    // ── ⑤ 每个部位的预览先进任务卡 ──
    // ⚠ 顺序有讲究：先登记缩略图，万一做进 PS 失败（比如文档被关了），
    //   用户至少还能看到认出了哪些部位，不是白跑一趟。
    const shots=[];
    for(const x of parts){
      let imgId='';
      try{
        if(window.IMG) imgId = await window.IMG.putFromBase64('data:image/png;base64,'+x.alphaB64, 'image/png');
      }catch(e){ aiAddLog('[人体解析] 「'+x.name+'」缩略图登记失败（不影响做图层）：'+String(e&&e.message||e),'warn'); }
      shots.push({done:true, imgId});
    }
    updateGenerationTask(id,{sub:'认出 '+parts.length+' 个部位 · 正在做进 Photoshop', pct:80, shots});
    aiAddLog('[人体解析] 认出 '+parts.length+' 个部位：'+parts.map(x=>x.name+' '+x.percent+'%').join('、'),'info');

    // ── ⑥ 盖印 → 转智能对象 → 复制 N 份各挂一个部位蒙版 → 装进一个组 ──
    const sel = mattingClampSelection(cap.selection, cap.docWidth, cap.docHeight) || cap.selection;
    const applied = await new Promise((res,rej)=>{
      linkQueue('ps.mask.applyGroup',
        { docId: cap.docId,
          selection: sel,
          groupName: String(vals.groupName||'').trim() || label,
          parts: parts.map(x=>({ name:x.name, alphaBase64:'data:image/png;base64,'+x.alphaB64 })) },
        { after:(d)=>res(d), afterError:(r)=>rej(new Error(linkResultMessage(r))) }
      ).catch(e=>rej(e));
    });

    // ⚠⚠ 桥那边【单个部位失败会跳过继续】，所以做成的数可能少于要求的数。
    //   少了必须说 —— 不说就是静默少做（铁律 17）。
    const madeN = (applied && Number(applied.count)) || parts.length;
    if(madeN < parts.length){
      ERR.report('SEGMENT_PARTIAL',{
        message:'要做 '+parts.length+' 个部位，实际做成 '+madeN+' 个',
        stage:'apply', taskId:runId,
        context:{'做成的':(applied&&applied.names||[]).join('、')}
      });
    }
    const ms = Date.now()-t0;
    const seg = data.ms ? ('推理 '+data.ms.infer+'ms · ') : '';
    updateGenerationTask(id,{status:'done', pct:100,
      sub:madeN+' 个部位 · '+seg+'共 '+ms+'ms · 已建组'});
    aiAddLog('[人体解析] 完成 · 组「'+((applied&&applied.groupName)||label)+'」共 '+madeN+' 个图层，'
      +'每个图层都带一个部位蒙版，拿画笔在蒙版上就能改','success');
  }catch(e){
    fail(String(e&&e.message||e), e&&e.stage||'apply', e&&e.code||'SEGMENT_APPLY_FAILED');
  }finally{
    segmentBusy = false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────
//  指哪抠哪（SAM2）：用 PS 选区当框 → 三个候选 → 用户挑一个 → 盖印+蒙版
// ───────────────────────────────────────────────────────────
async function startSAM2(preset, params){
  if(!window.MATTINGENGINE){ ERR.report('SAM2_RUN_FAILED',{message:'matting-engine.js 没加载'}); return false; }
  if(sam2Busy){ ERR.report('SAM2_BUSY',{message:'上一次还没跑完，等它完事再按'}); return false; }
  const PU = window.PRESETUI;
  const p = preset || (PU && PU.getToolPreset && PU.getToolPreset()) || null;
  const vals = params || (PU && PU.getToolParams && PU.getToolParams()) || {};
  const label = String((p && p.title) || '指哪抠哪');

  const runId = aiNewTaskId('sm');
  const task = addTask(makeToolTask('sam2',{taskId:runId, label},1));
  const id = task.id;
  const t0 = Date.now();
  sam2Busy = true;

  const fail = (message, stage, code)=>{
    const live = taskById(id);
    const keep = live && Array.isArray(live.shots) && live.shots.some(s=>s&&s.done&&s.imgId) ? {shots:live.shots} : {};
    updateGenerationTask(id, Object.assign({status:'failed', stage,
      errorCode:code||'SAM2_RUN_FAILED', error:String(message||'指哪抠哪失败')}, keep));
    aiAddLog('[指哪抠哪] 失败（'+(stage||'?')+'）：'+String(message||''),'warn');
  };

  try{
    // ── ① 引擎能不能用 ──
    updateGenerationTask(id,{status:'running', sub:'检查引擎', pct:5});
    await toolEngineReady(id,'指哪抠哪');
    const why = MATTINGENGINE.unusableReason('sam2');
    if(why){ fail(why,'engine','SAM2_UNUSABLE'); return true; }
    const tierNotes = [];
    const useTier = MATTINGENGINE.pickTier(vals.tier, tierNotes, 'sam2');
    updateTask(id,{mattingTierName:MATTINGENGINE.tierName(useTier,'sam2')});
    tierNotes.forEach(n=>aiAddLog('[指哪抠哪] '+n,'warn'));

    // ── ② 抓图 ──
    // ⚠⚠ 这个功能【必须有真选区】—— 它的全部意义就是"你框哪我抠哪"。
    //   allowFullCanvas 关掉：没框就整张画布当框的话，它会去抠"整个画面里最像一个东西的那块"，
    //   结果完全不是用户想要的，而且用户不知道为什么。
    let capRes;
    try{
      capRes = await toolCaptureSelection(id, vals, {allowFullCanvas:false});
    }catch(e){
      fail('先在 Photoshop 里框住你要的东西，再按开始计算。（'+String(e&&e.message||e)+'）','capture','SAM2_NO_BOX');
      return true;
    }
    const { cap, b64, capW, capH } = capRes;
    if(!cap.selection){ fail('没拿到选区','capture','SAM2_NO_BOX'); return true; }
    updateTask(id,{sourceDocId:cap.docId, sourceDocName:cap.docName||'',
      sourceSelection:cap.selection||null, mattingSize:capW+'×'+capH});
    registerTaskSourceImage(id, b64, cap.mime||'image/png');
    updateGenerationTask(id,{sub:'已抓 '+capW+'×'+capH+' · 正在算', pct:30});

    // ── ③ 送引擎 ──
    // ⚠ 抓回来的图【就是选区那一块】，所以在这张图的坐标系里，
    //   用户框的那个框就是"整张图" —— box = [0,0,W,H]。别再去换算一次。
    const bin = base64ToBytes(String(b64).replace(/^data:[^,]+,/,''));
    const qp = [];
    if(vals.tier && vals.tier!=='auto') qp.push('model='+encodeURIComponent(MATTINGENGINE.keyForTier(Number(vals.tier),'sam2')||''));
    let resp;
    try{
      resp = await fetch(MATTINGENGINE.base + '/sam2' + (qp.length?('?'+qp.join('&')):''), {
        method:'POST',
        headers:{ 'Content-Type':'image/png',
                  'X-Params': encodeURIComponent(JSON.stringify({ mode:'box', box:[0,0,capW,capH] })) },
        body: bin
      });
    }catch(e){ fail('引擎没应答：'+String(e&&e.message||e),'sam2','SAM2_RUN_FAILED'); return true; }
    if(!resp.ok){
      let msg='HTTP '+resp.status, code='SAM2_RUN_FAILED';
      try{ const j=await resp.json(); if(j&&j.error) msg=j.error; if(j&&j.code) code=j.code; }catch(_){}
      fail(msg,'sam2',code); return true;
    }
    const data = await resp.json();
    const cands = (data.candidates||[]).filter(c=>c && c.alphaB64);
    if(!cands.length || !cands.some(c=>Number(c.pixels)>0)){
      fail('三个答案都是空的。把框拉得更贴近你要的那个东西再试一次','sam2','SAM2_EMPTY');
      return true;
    }

    // ── ④ 三个候选都登记成缩略图 ──
    const view=[];
    for(const c of cands){
      let imgId='';
      try{
        if(window.IMG) imgId = await window.IMG.putFromBase64('data:image/png;base64,'+c.alphaB64, 'image/png');
      }catch(e){ aiAddLog('[指哪抠哪] 候选缩略图登记失败：'+String(e&&e.message||e),'warn'); }
      view.push({index:Number(c.index), iou:Number(c.iou)||0, pixels:Number(c.pixels)||0, imgId});
    }
    // 原始数据寄存起来（不挂 task，见上面 sam2Pending 的注释）
    sam2Pending.set(id, cands.map(c=>({index:Number(c.index), alphaBase64:'data:image/png;base64,'+c.alphaB64})));

    const best = Number(data.best)||0;
    const ms1 = Date.now()-t0;
    updateTask(id,{sam2Candidates:view, sam2Best:best, sam2Picked:null,
      sam2DocId:cap.docId, sam2Selection:mattingClampSelection(cap.selection, cap.docWidth, cap.docHeight)||cap.selection,
      sam2Label:label});

    // ── ⑤ 自动用最好的那个，还是摆出来让用户挑 ──
    if(String(vals.pick||'ask')==='auto'){
      const bestShot = view.find(v=>v.index===best) || view[0];
      updateGenerationTask(id,{sub:'算好了 · 正在盖印并加蒙版', pct:80,
        shots:[{done:true, imgId:bestShot.imgId}]});
      await applySAM2Candidate(id, bestShot.index);
    }else{
      // ⚠ 状态要停在"等你挑"，不能标成 done —— 标 done 用户会以为已经进 PS 了。
      updateGenerationTask(id,{status:'running', pct:70,
        sub:'算好了（'+ms1+'ms）· 三个答案，点一个',
        shots:[{done:true, imgId:(view.find(v=>v.index===best)||view[0]).imgId}]});
      aiAddLog('[指哪抠哪] 给了三个答案，在任务卡上点一个（把握：'
        +view.map(v=>Math.round(v.iou*100)+'%').join(' / ')+'）','info');
    }
  }catch(e){
    fail(String(e&&e.message||e), e&&e.stage||'apply', e&&e.code||'SAM2_APPLY_FAILED');
  }finally{
    sam2Busy = false;
  }
  return true;
}

// 用户在任务卡上点中了某个候选（或 pick=auto 时自动调）→ 盖印 + 做成蒙版
async function applySAM2Candidate(taskId, index){
  const task = taskById(taskId);
  if(!task) return;
  const list = sam2Pending.get(taskId);
  const hit = Array.isArray(list) ? list.find(x=>Number(x.index)===Number(index)) : null;
  if(!hit){
    ERR.report('SAM2_APPLY_FAILED',{message:'这个答案的数据已经不在了（任务可能过期了）。重新跑一次',stage:'apply'});
    return;
  }
  // ⚠ 先把挑选条收起来再干活：不收的话用户能连点好几下，
  //   每点一次就往 PS 里塞一个图层（"点了没反应就再点"是最常见的用户行为）。
  updateTask(taskId,{sam2Picked:Number(index)});
  updateGenerationTask(taskId,{status:'running', pct:85, sub:'正在盖印并加蒙版'});
  try{
    await new Promise((res,rej)=>{
      linkQueue('ps.mask.applyStamp',
        { docId: task.sam2DocId,
          alphaBase64: hit.alphaBase64,
          selection: task.sam2Selection,
          layerName: String(task.sam2Label||task.label||'指哪抠哪') },
        { after:()=>res(), afterError:(r)=>rej(new Error(linkResultMessage(r))) }
      ).catch(e=>rej(e));
    });
    const v=(task.sam2Candidates||[]).find(x=>Number(x.index)===Number(index));
    updateGenerationTask(taskId,{status:'done', pct:100,
      sub:'已盖印并加好蒙版'+(v?(' · 把握 '+Math.round(v.iou*100)+'%'):'')});
    aiAddLog('[指哪抠哪] 完成 · 已盖印并加好蒙版（想改边缘就拿画笔在蒙版上涂：白色=露出，黑色=挡住）','success');
    sam2Pending.delete(taskId);       // 用完就丢，别占着内存
  }catch(e){
    // ⚠ 失败要把挑选条【放回去】，让用户能换一个再试 —— 否则他就卡死在这儿了
    updateTask(taskId,{sam2Picked:null});
    updateGenerationTask(taskId,{status:'failed', stage:'apply',
      errorCode:'SAM2_APPLY_FAILED', error:String(e&&e.message||e)});
    aiAddLog('[指哪抠哪] 做进 Photoshop 失败：'+String(e&&e.message||e),'warn');
  }
}

// base64 ↔ 二进制。⚠ 大图不要用 atob 一次性转字符串再 split，那会多占一份内存
function base64ToBytes(b64){
  const s = atob(b64);
  const n = s.length;
  const a = new Uint8Array(n);
  for(let i=0;i<n;i++) a[i] = s.charCodeAt(i);
  return a;
}
function bytesToBase64(bytes){
  // ⚠ 分块拼 —— 一次 apply 几 MB 会爆调用栈（4K 图必炸）
  let out = '';
  const CH = 0x8000;
  for(let i=0;i<bytes.length;i+=CH){
    out += String.fromCharCode.apply(null, bytes.subarray(i, i+CH));
  }
  return btoa(out);
}
function runLinkTransfer(){
  const image=linkRuntime.generated||linkRuntime.capture||makeLinkPlaceholder();
  if(!linkRuntime.capture&&!linkRuntime.generated) addLinkLog({direction:'UI',level:'warn',message:'传回测试没有历史图片，使用固定占位图'});
  return linkQueue('ps.layer.place',{imageBase64:image.imageBase64,targetDocId:linkRuntime.capture&&linkRuntime.capture.docId,targetSelection:linkRuntime.capture&&linkRuntime.capture.selection,layerType:'smartObject'},{testKey:'transfer'});
}
function runLinkGenerateAfterCapture(){
  const source=linkRuntime.capture;
  if(!source){setLinkTest('generate','failed','没有可生成的抓取图');return Promise.resolve({ok:false});}
  const image=makeLinkPlaceholder(); linkRuntime.generated=image;
  const taskId='link-gen-'+Date.now().toString(36);
  const task=makeGenerationTask({taskId,provider:'链路验证',model:'占位生成',size:'1K',aspectRatio:'1:1',batch:1,inputImageBase64:source.imageBase64,sourceImageBase64:source.sourceImageBase64||source.imageBase64,captureSnapshot:aiCaptureSnapshot(source,0),prompt:'链路验证占位生成'});
  addTask(task);
  updateGenerationTask(taskId,{status:'running',pct:50,shots:[{done:false}],sub:'占位图已生成 · 等待传回 Photoshop'});
  addLinkLog({direction:'UI',level:'info',message:'固定占位生成图已创建',outputBytes:linkSize(image)});
  return linkQueue('ps.layer.place',{imageBase64:image.imageBase64,targetDocId:source.docId,targetSelection:source.selection,layerType:'smartObject'},{testKey:'generate',after:()=>updateGenerationTask(taskId,{status:'done',pct:100,shots:[{done:true,src:linkImageSrc(image)}],sub:'链路验证完成 · 已传回 Photoshop'}),afterError:result=>updateGenerationTask(taskId,{status:'failed',sub:'传回失败：'+linkResultMessage(result)})});
}
function runLinkGenerate(){
  if(linkRuntime.capture) return runLinkGenerateAfterCapture();
  setLinkTest('generate','queued','等待抓取测试完成');
  return runLinkCapture(()=>runLinkGenerateAfterCapture());
}
function runLinkFull(){
  setLinkTest('capture','queued','完整链路第 1 步');
  setLinkTest('generate','queued','等待完整链路');
  return runLinkCapture(()=>runLinkGenerateAfterCapture());
}
function runLinkPSAction(action){
  const params=linkParamsForAction(action);
  return linkQueue(action,params,{testKey:'control'});
}
function bindLinkDetail(root){
  root.querySelectorAll('[data-link-test]').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation(); const kind=btn.dataset.linkTest;
    if(kind==='capture') runLinkCapture();
    else if(kind==='transfer') runLinkTransfer();
    else if(kind==='generate') runLinkGenerate();
    else if(kind==='full') runLinkFull();
  }));
  root.querySelectorAll('[data-link-ps-action]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();runLinkPSAction(btn.dataset.linkPsAction);}));
  root.querySelectorAll('[data-link-field]').forEach(input=>input.addEventListener('input',()=>{linkRuntime.form[input.dataset.linkField]=input.value;}));
  const auto=root.querySelector('#linkAutoFullCanvas');
  if(auto) auto.addEventListener('change',()=>{linkRuntime.autoFullCanvas=!!auto.checked; addLinkLog({direction:'UI',level:'info',message:'无选区自动整图：'+(auto.checked?'开':'关')});});
  root.querySelectorAll('[data-link-visible]').forEach(input=>input.addEventListener('change',()=>{linkRuntime.form.visible=!!input.checked;}));
}
// 二级卡【内容层】整体上下滚动换内容。
// 预设卡的二级(列表 / 提示词框)用它，时序和位移量跟普通二级卡的错落换内容一致，
// 只是它只有一张卡、没有错落延迟。
// ⚠ 拿不到内容层就直接写，绝不能因为动画做不了就不换内容 ——
//   那会变成"切了主卡但二级还是上一张的内容"，比没动画糟得多。
// fresh = 这张卡刚从 display:none 冒出来（换了二级种类）。
// ⚠⚠ fresh 时【绝不能走淡出那一段】：它身上是上一次留下的旧内容，
//   淡出旧内容 = 用户先看到一堆不相干的东西闪一下，再等 150ms 才看到新的。
//   2026-09-14 用户实测报的"慢一拍 + 闪烁感"就是这个。
//   正确做法：立刻写新内容，然后只播滑入。
function slideZoneBody(inner, writeAll, dir, fresh){
  if(!inner){ writeAll(); return; }
  const out = dir>0 ? -SLIDE_Z : SLIDE_Z;
  const inn = dir>0 ?  SLIDE_Z : -SLIDE_Z;
  if(fresh){
    writeAll();
    inner.style.transition='none';
    inner.style.transform='translateY('+inn+'px)';
    inner.style.opacity='0';
    requestAnimationFrame(()=>{
      inner.style.transition='transform .18s var(--ease-out), opacity .15s var(--ease-soft)';
      inner.style.transform='translateY(0)';
      inner.style.opacity='1';
      setTimeout(()=>{
        if(inner.style.transform==='translateY(0px)'||inner.style.transform==='translateY(0)'){
          inner.style.transform=''; inner.style.transition='';
        }
      },200);
    });
    return;
  }
  inner.style.transition='transform .15s var(--ease-out), opacity .15s var(--ease-soft)';
  inner.style.transform='translateY('+out+'px)';
  inner.style.opacity='0';
  setTimeout(()=>{
    writeAll();
    inner.style.transition='none';
    inner.style.transform='translateY('+inn+'px)';
    requestAnimationFrame(()=>{
      inner.style.transition='transform .18s var(--ease-out), opacity .15s var(--ease-soft)';
      inner.style.transform='translateY(0)';
      inner.style.opacity='1';
      // ⚠ 播完把内联 transform 清干净。残留的 transform 会让它变成
      //   包含块，里面任何 position:fixed 的东西都会被"关小黑屋"
      //   (记忆里栽过这个坑)。现在下拉面板是挂在 body 下的、不受影响，
      //   但以后要是有人往二级里塞浮层，留着这行残留就是个雷。
      setTimeout(()=>{
        if(inner.style.transform==='translateY(0px)'||inner.style.transform==='translateY(0)'){
          inner.style.transform=''; inner.style.transition='';
        }
      },200);
    });
  },150);
}
let detailFillSeq=0;
function specialDetailFill(writeAll,animate,dir){
  const sequence=++detailFillSeq,route=cur+':'+zoneSel,slide=detail.querySelector('.dc-slide');
  const write=()=>{if(sequence!==detailFillSeq||route!==cur+':'+zoneSel)return false;writeAll();return true;};
  if(!animate||!slide){write();if(slide){slide.style.transition='none';slide.style.transform='translateY(0)';slide.style.opacity='1';}return;}
  const out=dir>0?-SLIDE_D:SLIDE_D,inn=dir>0?SLIDE_D:-SLIDE_D;
  slide.style.transition='transform .2s var(--ease-out), opacity .18s var(--ease-soft)';slide.style.transform='translateY('+out+'px)';slide.style.opacity='0';
  setTimeout(()=>{if(!write())return;slide.style.transition='none';slide.style.transform='translateY('+inn+'px)';requestAnimationFrame(()=>{if(sequence!==detailFillSeq)return;slide.style.transition='transform .2s var(--ease-out), opacity .18s var(--ease-soft)';slide.style.transform='translateY(0)';slide.style.opacity='1';});},190);
}
function fillLinkDetail(animate,dir){
  const set=LINK_ZONE_SET; const item=set[zoneSel]||set[0]; const body=document.getElementById('dcBody'); const nameEl=detail.querySelector('.dc-name'); if(!body||!item)return;
  // 同一分区的状态回执只更新节点，不能重新创建输入框或 action 列表。
  if(!animate && linkPanelForZone(zoneSel)){
    if(nameEl) nameEl.textContent=item[1];
    refreshLinkStatusInPlace();
    refreshLinkDynamicInPlace();
    return;
  }
  const writeAll=()=>{
    if(nameEl) nameEl.textContent=item[1];
    const connected=linkRuntime.connected, status=linkRuntime.tests[zoneSel===0?'capture':zoneSel===1?'transfer':zoneSel===2?'generate':'control'];
    let html='<div class="link-panel" data-link-zone="'+zoneSel+'"><div class="link-state '+(connected?'ok':'')+'"><span class="link-dot"></span><span data-link-connection>'+(connected?'UXP 已连接':'等待 UXP 连接')+'</span><span data-link-test-status>'+linkStatusText(status)+'</span></div>';
    if(zoneSel===0){
      html+='<label class="link-switch"><input id="linkAutoFullCanvas" type="checkbox" '+(linkRuntime.autoFullCanvas?'checked':'')+'>无选区时自动使用整张画布</label>';
      html+='<button class="link-btn" data-link-test="capture">执行抓取测试</button>';
      html+='<div data-link-dynamic>'+linkDynamicHtml(0)+'</div>';
    }else if(zoneSel===1){
      html+='<button class="link-btn" data-link-test="transfer">执行传回测试</button>';
      html+='<div data-link-dynamic>'+linkDynamicHtml(1)+'</div>';
    }else if(zoneSel===2){
      html+='<button class="link-btn" data-link-test="generate">执行生成测试</button><button class="link-btn" data-link-test="full">运行完整链路</button>';
      html+='<div data-link-dynamic>'+linkDynamicHtml(2)+'</div>';
      html+='<div class="devrow"><span>生成器</span><span class="dv-val">固定占位图（未接真实引擎）</span></div>';
    }else{
      html+='<div class="link-fields">'+
        '<input data-link-field="docId" value="'+escapeHtml(linkRuntime.form.docId)+'" placeholder="文档 ID">'+
        '<input data-link-field="layerId" value="'+escapeHtml(linkRuntime.form.layerId)+'" placeholder="图层 ID">'+
        '<input data-link-field="layerName" value="'+escapeHtml(linkRuntime.form.layerName)+'" placeholder="图层名称">'+
        '<input data-link-field="opacity" value="'+escapeHtml(linkRuntime.form.opacity)+'" placeholder="不透明度">'+
        '<input data-link-field="aspect" value="'+escapeHtml(linkRuntime.form.aspect)+'" placeholder="选框比例">'+
        '<input data-link-field="channelId" value="'+escapeHtml(linkRuntime.form.channelId)+'" placeholder="通道 ID">'+
        '<input data-link-field="groupIds" value="'+escapeHtml(linkRuntime.form.groupIds)+'" placeholder="图层 ID（逗号分隔）">'+
         '<input data-link-field="groupName" value="'+escapeHtml(linkRuntime.form.groupName)+'" placeholder="编组名称">'+
         '<input data-link-field="exportPath" value="'+escapeHtml(linkRuntime.form.exportPath)+'" placeholder="导出 file:/ 路径">'+
         '<label class="link-switch"><input data-link-visible type="checkbox" '+(linkRuntime.form.visible?'checked':'')+'>可见</label></div>';
      html+='<div class="link-action-list">'+linkRuntime.actions.map(linkActionRowHtml).join('')+'</div>';
    }
    html+='</div>'; body.innerHTML=html;
    const actionList=body.querySelector('.link-action-list');
    if(actionList) actionList.dataset.signature=linkActionSignature();
    bindLinkDetail(body);
  };
  specialDetailFill(writeAll,animate,dir);
}
async function copyLogText(){
  const text=linkRuntime.logs.map(l=>[l.at,l.direction,l.level,l.action||'',l.requestId||'',l.message].join(' | ')).join('\n');
  if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
  else{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);try{ta.select();if(!document.execCommand('copy'))throw new Error('复制失败，请检查剪贴板权限。');}finally{ta.remove();}}
  addLinkLog({level:'success',message:'日志文本已复制'});
}
function bindLogDetail(root){
  const clear=root.querySelector('[data-log-clear]'); if(clear) clear.addEventListener('click',e=>{e.stopPropagation();linkRuntime.logs.length=0;addLinkLog({level:'info',message:'日志已清空'});});
  const copy=root.querySelector('[data-log-copy]'); if(copy) copy.addEventListener('click',e=>{e.stopPropagation();copyLogText().catch(error=>ERR.report('LAYOUT_FAILED',{message:String(error.message||error)}));});
}
function fillLogDetail(animate,dir){
  const set=LOG_ZONE_SET; const item=set[zoneSel]||set[0]; const body=document.getElementById('dcBody'); const nameEl=detail.querySelector('.dc-name'); if(!body||!item)return;
  if(!animate && body.querySelector('.link-panel[data-log-zone="'+String(zoneSel)+'"]')){
    if(nameEl) nameEl.textContent=item[1];
    refreshLogDetailInPlace();
    return;
  }
  const writeAll=()=>{
    if(nameEl) nameEl.textContent=item[1];
    const logs=visibleLinkLogs();
    let html='<div class="link-panel" data-log-zone="'+zoneSel+'">';
    if(zoneSel===2){html+='<button class="link-btn" data-log-clear>清空本地日志</button><div class="devrow"><span>当前记录</span><span class="dv-val" data-log-count>'+linkRuntime.logs.length+' 条</span></div>';}else if(zoneSel===3){html+='<button class="link-btn" data-log-copy>复制全部日志</button><div class="devrow"><span>当前记录</span><span class="dv-val" data-log-count>'+linkRuntime.logs.length+' 条</span></div>';}else{
      const entries=logs.length?logs.slice().reverse().map(logEntryHtml).join(''):'<div class="devrow"><span>暂无日志</span><span class="dv-val">等待链路事件</span></div>';
      html+='<div class="log-list" data-log-list>'+entries+'</div>';
    }
    html+='</div>';body.innerHTML=html;bindLogDetail(body);
  };
  specialDetailFill(writeAll,animate,dir);
}

