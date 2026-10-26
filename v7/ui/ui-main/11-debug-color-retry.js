// ═══ ui-main/11-debug-color-retry.js —— 主界面主程序第 11 / 21 段 ═══
//   管什么：调试模式运行状态播报 · 自动校色 / 对齐（档 1）· 失败任务重跑
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 调试模式 · 运行状态播报(2026-09-12) ═══════════════════
//
//  设置里打开「调试模式」后，运行过程中的关键状态都会弹成 L1 胶囊：
//  抓取 / 生成请求 / 校色走了哪档 / 当前算到第几张 / 耗时 / 传回。
//
//  ⚠ 三条设计规矩，不然它会变成灾难：
//
//  ① **绝不能把真报错淹掉**。报错堆最多显示 4 层（ERR_MAX_VISIBLE），
//     生成 18 张时调试消息有几十条 —— 不节流的话真出错了那张卡
//     会被瞬间挤掉，用户根本看不见。
//     所以：同类消息在 700ms 内合并，只显示最后一条。
//
//  ② **显示时间要短**（1.8s）。它是"扫一眼就过"的东西，
//     不是要用户读完的报错。
//
//  ③ **关掉时零开销**。所有调试调用先查开关再拼字符串 ——
//     不能为了一个默认关闭的功能，在热路径上白白拼几十个字符串。
const dbgThrottle = new Map();   // 分类 → {timer, last}

function isDebugOn(){ return settingsRuntime.debugMode === true; }

//  dbg(分类, 消息) —— 分类相同的会互相合并
function dbg(kind, message, level){
  // ③ 关着就立刻返回，连字符串都不拼
  if(!isDebugOn()) return;
  const text = '[' + kind + '] ' + String(message == null ? '' : message);
  // 日志永远写（即使调试模式关着也该有日志，但那由各自的 log 函数负责，
  // 这里只管调试模式下的额外播报）
  try{ console.log('[调试] ' + text); }catch(_){}

  // ① 同类合并：700ms 内只弹最后一条
  const slot = dbgThrottle.get(kind) || {};
  slot.last = text;
  if(slot.timer){ dbgThrottle.set(kind, slot); return; }
  slot.timer = setTimeout(()=>{
    const s = dbgThrottle.get(kind);
    if(s){ s.timer = null; }
    if(window.UI && window.UI.toast && isDebugOn()){
      UI.toast(s ? s.last : text, level || 'info', 1800);   // ② 短
    }
  }, 700);
  dbgThrottle.set(kind, slot);
}

// 校色日志的统一出口。⚠ 三个地方都要写(2026-09-12)：
//   ① 界面日志区 —— 用户能看
//   ② 浏览器控制台 —— 开 devtools 能看
//   ③ Rust 控制台 —— 【排查的人能看】
// 原来只写①，用户反馈"压根没有日志"(其实是写了，但要切到日志分区才看得见)，
// 而我在外面也看不到，等于这条链路是瞎的。
// 校色是最容易出问题的一环(算法+外部引擎+两张图配对)，日志必须可见。
function colorMatchLog(msg){
  const line='[校色] '+String(msg||'');
  aiAddLog(line,'info');
  try{ console.log(line); }catch(_){}
  try{
    if(window.__TAURI__&&window.__TAURI__.core)
      window.__TAURI__.core.invoke('debug_log',{message:line}).catch(()=>{});
  }catch(_){}
  // 调试模式下同时弹出来看（关着时 dbg 会立刻返回，零开销）
  dbg('校色', msg);
}
// ═══ 自动校色 / 对齐（档 1，纯 CPU）═══════════════════════════
//  把 AI 回图的颜色拉回原图色调，并修掉生成带来的轻微位移。
//  ⚠ 插在【存进图片管家之前】—— 预览和传回都取自图片管家，
//    所以这一处改完两边天然都是处理后的内容，不用改两个地方。
//
//  ⚠ 不开校色时【一个字节都不碰】：直接返回 null 让调用方走原来的
//    "原始字节原样存"路径。绕开 canvas 是有原因的 ——
//    canvas 会把图强制转成 sRGB，AI 图若带别的色彩配置，像素值会被悄悄改掉。
//    反正开了校色本来就要改像素，那时候再进 canvas 才划算。
//
// ⭐ 长宽比容差（2026-09-12）。超过它就认为"原图不是可信的位置基准"。
//   3% 是算法护栏，不是用户护栏 —— 真实数据里正常只差 0.1~0.3%
//   （递交 1150×2048 → 回图 1536×2738，差 0.2%），
//   而用户 2026-09-12 复现那次（选区 16:9 + 生图 1:1）差了 78%。
//   中间空得很，不会误伤。
const ASPECT_TOLERANCE=1.03;
// 同一批只提示一次。⚠ 一批 10 张会各走一次校色，不去重就是刷 10 条。
//   用「回图尺寸 + 原图尺寸」当签名：同一批这两个值是一样的。
const aspectWarned=new Map();
function notifyAspectMismatch(off, w, h, refW, refH){
  const key=w+'x'+h+'@'+refW+'x'+refH;
  const now=Date.now();
  const last=aspectWarned.get(key)||0;
  if(now-last<30000) return;                 // 30 秒内同一批不重复
  aspectWarned.set(key, now);
  if(aspectWarned.size>20) aspectWarned.clear();   // 别无限长
  const pct=Math.round((off-1)*100);
  // ⭐⭐⭐ 2026-10-08（docs/170 §4.8 · E11）：这句原来【说假话】。
  //   老文案写「精准校色降级为整体校色」，而引擎在 10-05~10-08 那段时间
  //   是【直接跳过校色】的 —— 用户以为换了种算法接着校，其实什么都没做。
  //   现在引擎按 method 分发（第 1 步）之后，比例不符时前端会把 method 换成
  //   'global'（拍板点 4-B），所以「已自动改用全局校色」是【真的】。
  const msg='选区比例和生图比例差 '+pct+'% · 已跳过对齐 · 已自动改用全局校色';
  aiAddLog(msg+'（原图 '+refW+'×'+refH+' → 回图 '+w+'×'+h+'）','warn');
  // L1 胶囊：零打断、自动消失。⚠ 这不是报错，是"我替你降级了"的知会 ——
  //   用 L2 每批弹一张卡会很烦，但完全不说又是静默失效。L1 正好。
  if(window.ERR) ERR.report('ASPECT_MISMATCH',{
    // ⚠ 措辞跟上面那句日志保持一致（用户会在两处看到同一件事）
    message:'比例差 '+pct+'%，已自动改用全局校色',
    context:{'选区/原图':refW+'×'+refH,'AI 回图':w+'×'+h,
             '想用精准/混合':'把「宽高比」改成 Auto，让回图跟着选区走'}
             // ⚠ 原来这里只写「精准校色」—— 四态之后【混合】也受同一道闸门限制
             //   （两者都按位置算），所以两个都要提。
  });
}

//  返回 Promise<canvas|null>：null = 没做处理（调用方按原路走）
function aiColorMatchCanvas(img, w, h, refB64, log, options){
  if(!window.COLORMATCH || !refB64) return Promise.resolve(null);
  // ⭐ 2026-10-17 夜（用户：「生成卡片里面的校色方式选择和任务卡片里面校色方式的选择是否会冲突？是否会打架？」）：
  //   任务卡现算某一版时用 options.mode 直接点名要哪种，【不再临时改全局设置】——
  //   以前 recomputeColorVersion 把 settingsRuntime.colorMatchMode 临时改掉、算完再改回：算的那几秒里
  //   你在生成卡改下拉框会被改回去、恰好在出的新图会用错方式、任何一次存设置会把临时值永久存下。
  const mode=(options&&options.mode)||wantColorMode();
  const wantColor=mode!=='off';   // ⭐ 四态
  const wantAlign=settingsRuntime.autoAlign!==false;
  if(!wantColor && !wantAlign) return Promise.resolve(null);
  return new Promise(resolve=>{
    const ref=new Image();
    // ⚠ async：下面要 await 调度层(外部引擎是 HTTP 调用)。
    //   整个 aiColorMatchCanvas 已经返回 Promise，这里变成 async 不影响调用方。
    ref.onload=async()=>{
      try{
        const t0=performance.now();
        const c=document.createElement('canvas'); c.width=w; c.height=h;
        const ctx=c.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(img,0,0,w,h);
        let cur={data:ctx.getImageData(0,0,w,h).data,width:w,height:h};
        // ⚠⚠ 真实长宽比差【必须在这里算】，而且必须算在拉伸之前（2026-09-12）。
        //
        //   下面那句 drawImage(ref,0,0,w,h) 是【非等比】拉伸 —— 2:1 的原图会被
        //   竖向拉长成 1:1。拉完之后两张图尺寸一模一样，
        //   **引擎再怎么算长宽比差都恒等于 1.000**，它那道
        //   「差超过 3% 就跳过对齐」的护栏从上线到现在【一次都没触发过】。
        //   真实比例只有这里知道，所以由这里算好、当参数传下去。
        //
        //   用户 2026-09-12 复现：选区 16:9、生图比例设 1:1、再开着精准校色 ——
        //   出来的图整片发雾。因为精准校色是【按位置】换颜色的，
        //   基准图被竖向拉长之后，额头的颜色盖到了眼睛上。
        const refW=ref.naturalWidth||ref.width||w, refH=ref.naturalHeight||ref.height||h;
        const ra=(w/Math.max(1,h)), rb=(refW/Math.max(1,refH));
        const aspectOff=Math.max(ra,rb)/Math.max(1e-6,Math.min(ra,rb));

        // ⚠ 照旧拉伸，不改数据通路 —— 因为超差时所有"看位置"的算法都会被关掉，
        //   剩下的整体校色(MKL)只统计全图颜色、根本不看位置，对拉伸免疫。
        //   （不拉的话档 1 的 transferLowFreqFast/estimateAlign 都得改成能吃
        //     不同尺寸，风险大收益小，而它们在超差时压根不会被调用。）
        const rc=document.createElement('canvas'); rc.width=w; rc.height=h;
        rc.getContext('2d',{willReadFrequently:true}).drawImage(ref,0,0,w,h);
        const refImg={data:rc.getContext('2d').getImageData(0,0,w,h).data,width:w,height:h};

        // ⭐ 交给调度层：能用外部引擎(档2/3)就用，用不了自动回落档 1。
        //   ⚠ 引擎是 HTTP 服务，图片得 base64 进出；这边手上是 canvas，
        //     所以编解码器由这里提供 —— 调度层不碰 DOM，它不知道怎么编码。
        // ⭐ 走【二进制】不走 base64（2026-09-12 改，见 match-engine.js 的说明）。
        //   canvas.toBlob 直接给字节，全程不产生 base64 长字符串。
        const toBlob=(im)=>new Promise((res,rej)=>{
          const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
          cv.getContext('2d').putImageData(new ImageData(im.data,im.width,im.height),0,0);
          cv.toBlob(b=>b?res(b):rej(new Error('图片编码失败')),'image/png');
        });
        const fromBlob=(blob)=>createImageBitmap(blob).then(bmp=>{
          const cv=document.createElement('canvas'); cv.width=bmp.width; cv.height=bmp.height;
          const cc=cv.getContext('2d',{willReadFrequently:true});
          cc.drawImage(bmp,0,0);
          // ⚠ 位图用完立刻放掉，别留着占内存（同 image-store.js 的做法）
          if(bmp.close) bmp.close();
          return {data:cc.getImageData(0,0,cv.width,cv.height).data,width:cv.width,height:cv.height};
        });

        const r=await MATCHENGINE.process(cur,refImg,{
          // ⭐ 2026-10-19（docs/251 第 7 条②，实测 tmp/align-probe）：不校色 + 快速对齐（网格）时【强制本机档 1】——
          //   本机 CPU 网格对齐 2048 图 0.17 秒、3072 图 0.19 秒，跟引擎算出来的几乎一样（误差 2.25 对 2.23，两张差 0.3 个灰度）；
          //   走引擎就算是本机显卡也要 1 秒，走云端还得把两张图传上去（默认不校色以后，这一步就是「回图要不要上传」的全部原因）。
          //   精确对齐（flow）和细节补偿只有引擎能做 ⇒ 照旧按设置的档位。
          tier:(!wantColor&&String(settingsRuntime.alignMode||'mesh')==='mesh'&&settingsRuntime.detailBoost!==true)?1:Number(settingsRuntime.matchTier||3),
          align:wantAlign, color:wantColor,
          // ⭐⭐⭐ 2026-10-08（docs/170 §4.6）：method 跟着设置走。
          //   ⚠ 10-05 这里写死 'hybrid' 是【当时只有一条路】的写法；
          //     四态之后必须跟着 settingsRuntime.colorMatchMode 走，
          //     否则设置里选了"全局"，跑的还是混合 —— 正是铁律 16 那类"能存不生效的开关"。
          //   ⭐ 比例不符时【自动改用全局】（拍板点 4-B）：全局不看位置、对拉伸免疫。
          //     依据 docs/33 §10.3 那张对照表 + §10.4 的原做法
          //     （历史说法是「精准校色自动降级成整体校色」，10-05 被删，本次恢复成
    //      「自动改用全局校色」—— 说法变了，因为现在真的有三种方式可选）。
          method:(aspectOff>ASPECT_TOLERANCE && mode!=='off') ? 'global' : mode,
          // ⭐ 对齐方式和细节补偿(2026-09-12，外挂能力卡里配的)
          alignMode:String(settingsRuntime.alignMode||'mesh'),
          // ⚠ 用 ===true 不是 !==false：这个功能 2026-09-12 起默认【关】，
          //   写成 !==false 的话"没设置过"会被当成开，正好反了。
          detailBoost:settingsRuntime.detailBoost===true,
          detailStrength:Math.max(0,Math.min(1.5,(Number(settingsRuntime.detailStrength)||150)/100)),
          // ⭐ 真实长宽比差(2026-09-12)。超差时调度层会关掉所有"看位置"的算法：
          //   跳过对齐 + 精准/混合【自动改用全局校色】。三种方式都认这个参数。
//   ⚠ 2026-10-08（docs/170 §十 L1）：这句注释原来写「精准校色降级为整体校色」——
//     用户看不到，但会误导下一个改代码的人（他那会儿引擎其实是【直接跳过】）。
          aspectOff:aspectOff,
          toBlob, fromBlob,
          // ⭐ 2026-10-19（docs/249）：这一单是什么、多急、属于哪个任务的第几张 —— 云端任务队列拿它排序、画状态
          job:(options&&options.job)||null
        });
        // ⚠ 降级了就【必须说】。用户选的是"精准"、实际跑的是"整体"，
        //   不吭声就是铁律 16 那条"能存不生效的开关比没有更坏"。
        //   ⚠ 但一批 10 张会走 10 次这里 —— 同一批只提示一次，否则刷屏。
        if(aspectOff>ASPECT_TOLERANCE) notifyAspectMismatch(aspectOff, w, h, refW, refH);
        // ⭐ 2026-10-19：云端 / 引擎没成、改用了本机简化算法 —— 记在画布上带回去（缩略图打「简」角标、提示一句）
        if(r.fallback) c.__v7Fallback=String(r.fallback);
        cur=r.img;
        const outId=new ImageData(new Uint8ClampedArray(cur.data),w,h);
        ctx.putImageData(outId,0,0);
        // ⭐⭐ 2026-10-05（docs/143 §二 §四）：引擎顺手回的【底版】——
        //   掰正过、没校色的那一张。挂在这张画布上带回去（见 cacheSaveTask 写 base_N.png）。
        //
        //   ⚠ 为什么挂在 canvas 上当属性、而不是改返回结构：这个函数的返回被两处调用
        //     （下面的 m===0 那条 + 抗截断开那条），改成 {canvas,base} 要同时动两处、
        //     还得防着漏改一处变静默失效（铁律 17）。挂属性是【纯增量】，老调用方
        //     拿到 canvas 照旧能用，不会因为不认识新结构而出错。
        //   ⚠ 档 1（本机 JS 算法）没有这张 —— 底版是全挂在引擎档上的（docs/143 §十三-4）。
        //     没有就是没有，下面按"没有"处理，调用方自己兜。
        if(r.base&&r.base.data){
          try{
            const bc=document.createElement('canvas'); bc.width=r.base.width; bc.height=r.base.height;
            bc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.base.data),r.base.width,r.base.height),0,0);
            c.__v7BaseCanvas=bc;
          }catch(_){ /* 底版构造失败不算错 —— 它只是"事后能切回去"，不该影响出图 */ }
        }
        // ⭐⭐ 2026-10-18（docs/235 后续）：记下这张【实际】用的是哪种校色 —— 任务卡切版本靠它分辨「自动那一种」。
        //   以前这一步从来没记（10-08 做四态时漏了），于是所有图都被当成「混合」：
        //   用全局 / 精准 / 关着校色出的图，点到「混合」看到的还是它自己那张，切了像没反应。
        //   ⚠ 比例对不上时上面已经改用全局 ⇒ 记全局；关着校色（只对齐）⇒ 记底版。
        c.__v7ColorVersion=wantColor?((aspectOff>ASPECT_TOLERANCE)?'global':mode):'base';
        if(typeof log==='function'){
          log('已处理 '+w+'×'+h+' · 档'+r.tier+' · '+r.notes.join(' · ')
            +' · 耗时 '+Math.round(performance.now()-t0)+'ms');
        }
        resolve(c);
      }catch(e){
        // ⚠ 校色失败【不能让整张图丢掉】：返回 null，调用方照常用未处理的原图。
        //   这一步是锦上添花，不该成为生成链路的单点故障。
        if(window.ERR) ERR.report('COLORMATCH_FAILED',{message:String(e&&e.message||e)});
        resolve(null);
      }
    };
    ref.onerror=()=>resolve(null);
    ref.src=refB64.indexOf('data:')===0?refB64:('data:image/png;base64,'+refB64);
  });
}

function aiRestoreImage(image, mode, refB64, job){
  const m=Math.max(0,Math.min(2,Number(mode)||0));
  const b64=image&&(image.imageBase64||image.base64)||'';
  // 要不要做校色/对齐。⚠ 没有参考图(原图)就一律不做 —— 没得比。
  // ⚠ 这道闸决定"要不要进 aiColorMatchCanvas"。三个开关任意一个开着就得进。
  //   2026-09-12 补上 detailBoost：漏了它的话，用户把对齐和校色都关掉、
  //   只开细节补偿时，整个函数根本不会被调用 —— 开关在，却一声不吭地不生效。
  const wantFix=!!refB64 && !!window.COLORMATCH
    && (wantColorMode()!=='off' || settingsRuntime.autoAlign!==false
        || settingsRuntime.detailBoost===true);
  // ⚠ 图片本体不再往下传：只留元数据 + imgId。整条链路上不许再出现完整 base64 字符串。
  //   (见 docs/21。以前这里的 imageBase64/restoredImage/rawImage 每张图要留 2~4 份，
  //    抗截断开着时单张 4K 约 235MB。)
  const meta=Object.assign({},image||{});
  delete meta.imageBase64; delete meta.base64; delete meta.rawImage;
  // 生成前已按 antiMode 对输入做偏移，因此返回图按同一任务快照统一还原一次。
  // 传回阶段使用这份结果并固定 antiMode=0，避免 UXP 再次叠加滤镜。
  if(!b64)return Promise.resolve(Object.assign({},meta,{imgId:'',restoreState:'failed',restoreApplied:false}));
  if(m===0 && !wantFix){
    // 抗截断关 + 不做校色 → 原始字节【原样】包成 Blob，不重新编码。
    // ⚠ 这条零拷贝路径要留着：不进 canvas 就不会被强制转 sRGB，
    //   像素和 AI 给的一模一样。只有真要改像素时才值得付这个代价。
    // ⭐ 2026-10-19（docs/251 第 7 条③）：记成 autoVersion 'base' —— 这张成品本身就是底版。
    //   原来这条路什么都不记 ⇒ 没有底版 ⇒ 之后切不了校色（对齐、校色都关着的人一张都切不了）。
    //   ⚠ 不另登记一张 baseImgId：成品就是底版，再存一份 base_N.png 是白占地方（colorVersionFile 让 base 指向 output_N.png）。
    return window.IMG.putFromBase64(b64, meta.mime||'image/png')
      .then(imgId=>Object.assign({},meta,{imgId,restoreState:'done',restoreApplied:false,autoVersion:'base'}));
  }
  if(m===0){
    // 抗截断关 + 要校色 → 解码后直接进校色，不做任何抗截断还原。
    return new Promise((resolve,reject)=>{
      const img=new Image();
      img.onload=()=>{
        const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
        if(!w||!h){reject(new Error('还原图片尺寸无效'));return;}
        aiColorMatchCanvas(img,w,h,refB64,colorMatchLog,{job:job||null}).then(c=>{
          if(!c){
            // 校色没做成(置信度不足/出错) → 退回原始字节，一个像素都不动
            // ⭐ 2026-10-19：这张就是没校色的那一版 ⇒ 记成 autoVersion 'base'（之后能切去现算别的校色）
            window.IMG.putFromBase64(b64, meta.mime||'image/png')
              .then(imgId=>resolve(Object.assign({},meta,{imgId,restoreState:'done',restoreApplied:false,autoVersion:'base'})))
              .catch(reject);
            return;
          }
          // ⭐ B01 第 1 步：这条是【抗截断关】的路 —— 也就是默认设置下绝大多数生成走的路。
          //   ⚠ 2026-10-02 第一版只改了下面「抗截断开」那条，探针实跑抓到：默认设置下根本没存原图。
          //   这里的 AI 原图就是返回的原始字节 b64（没做任何还原），直接原样登记，不重新编码。
          const keepRaw=typeof cacheAvailable==='function'&&cacheAvailable();
          // ⚠⚠ 2026-10-05（docs/143 §二）：底版也【必须在这条路上登记】——
          //   这是同一个坑的第二次：B01 那次就是"只改了抗截断开那条，默认这条路漏了"，
          //   而默认设置下绝大多数生成走的就是这一条。探针实跑抓到（base 一个都没写）。
          // ⭐ 2026-10-19（docs/251 第 7 条③）：不校色（只对齐）时成品【就是】底版 —— 不再另登记一张、另写一份一模一样的 base_N.png。
          const baseCanvas=c.__v7ColorVersion==='base'?null:(c.__v7BaseCanvas||null);
          const keepBaseNow=!!baseCanvas&&typeof cacheAvailable==='function'&&cacheAvailable();
          Promise.all([
            window.IMG.putFromCanvas(c,'image/png'),
            keepRaw?window.IMG.putFromBase64(b64,meta.mime||'image/png').catch(()=>''):Promise.resolve(''),
            keepBaseNow?window.IMG.putFromCanvas(baseCanvas,'image/png').catch(()=>''):Promise.resolve('')
          ])
            .then(([imgId,rawImgId,baseImgId])=>resolve(Object.assign({},meta,{imgId,restoreState:'done',restoreApplied:false,colorMatched:true},
              rawImgId?{rawImgId}:{},baseImgId?{baseImgId}:{},c.__v7ColorVersion?{autoVersion:c.__v7ColorVersion}:{},
              // ⭐ 2026-10-19：云端没成、用了本机简化算法 —— 往上带（⚠ 中间每一层都是手写字段，漏一层就静默丢）
              c.__v7Fallback?{colorFallback:c.__v7Fallback}:{})))
            .catch(reject);
        });
      };
      img.onerror=()=>reject(new Error('还原图片解码失败'));
      img.src=linkImageSrc(Object.assign({},meta,{imageBase64:b64}));
    });
  }
  return new Promise((resolve,reject)=>{
    const src=linkImageSrc(Object.assign({},meta,{imageBase64:b64})), img=new Image();
    img.onload=()=>{try{
      const c=document.createElement('canvas'), w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
      if(!w||!h)throw new Error('还原图片尺寸无效'); c.width=w;c.height=h;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);
      // ⚠ 下面这段像素运算一个字都没动：R17 色相反转 / R17+ 再垂直翻转。
      //   改了就是改抗截断本身，出来的图会不对。
      const id=ctx.getImageData(0,0,w,h), d=id.data;
      for(let i=0;i<d.length;i+=4){const mx=Math.max(d[i],d[i+1],d[i+2]),mn=Math.min(d[i],d[i+1],d[i+2]),sum=mx+mn;d[i]=sum-d[i];d[i+1]=sum-d[i+1];d[i+2]=sum-d[i+2];}
      if(m===2){const row=w*4,tmp=new Uint8ClampedArray(row);for(let y=0;y<Math.floor(h/2);y++){const a=y*row,b=(h-1-y)*row;tmp.set(d.subarray(a,a+row));d.copyWithin(a,b,b+row);d.set(tmp,b);}}
      ctx.putImageData(id,0,0);
      // 原图仍是无损 PNG，和原来的 toDataURL('image/png') 像素一致；
      // 缩略图直接从这张【已还原】的画布缩 —— 所以缩略图天生是还原后的，
      // 不会出现 R17 那种"颜色全反"、R17+ 那种"倒过来"的缩略图。
      //
      // ⚠⚠ 校色必须排在抗截断【还原之后】。
      //   抗截断发出去的是色相反转(甚至上下翻转)过的图，回来的也是那个样子。
      //   在还原之前校色 = 拿一张反色的图去跟正常原图比颜色，结果毫无意义，
      //   而且对齐会因为上下翻转彻底匹配不上。顺序不能调。
      // ⭐⭐ 2026-10-05（docs/143 §二 §五）：底版 —— 和成品【一起登记】。
      //   ⚠ 底版【不】在引擎档之外的地方产生：档 1、超差跳过对齐、autoColorMatch 关着
      //     这三种情况下都没有 baseCanvas，那就如实不登记（元数据里 hasBase=false）。
      //   ⚠ 登记两张图（成品 + 底版）在 IMG 里是两笔，
      //     cacheSaveTask 会按 baseImgId 把底版写成 base_N.png。
      const finish=(canvas,fixed,baseCanvas,colorVersion,fallback)=>{
        // ⭐ 2026-10-19（docs/251 第 7 条③）：自动方式是「不校色」时成品就是底版 —— 不另登记、不另写 base_N.png
        const keepBase=!!baseCanvas&&colorVersion!=='base';
        // ⭐ 2026-10-02 B01 第 1 步「缓存加存 AI 原图」（用户已拍板，融合方案-B01 §4.3/§4.5）：
        //   以前只要开着校色/对齐，缓存里就【不可能】存到 AI 原图 —— 写的全是校色后的，
        //   于是「光头上的黑鬼影到底是校色造的、还是二次校色叠出来的」永远分不清（B01 §2.3）。
        //   → 校色/对齐真的改了这张图时，把改之前的那张（已做完抗截断还原 = 真正的 AI 原图）也登记一份，
        //     缓存写成 raw_N.png；写完立刻从内存释放（见 cacheSaveTask）。
        //   ⚠ 没改（fixed=false）就不存 —— 两份一模一样，白占空间。
        //   ⚠ 缓存关着也不存 —— 存了没地方写，只会在内存里白占一张 4K 图。
        //   ⚠ aiColorMatchCanvas 是【新画一张】，不改 c，所以这里的 c 一定是校色前的。
        const keepRaw=!!fixed&&canvas!==c&&typeof cacheAvailable==='function'&&cacheAvailable();
        // ⚠ 底版也只在【缓存开着】时登记 —— 不然后台白占一张 4K 图的内存，还没地方写。
        //   （跟 keepRaw 同一个口径。）
        const keepBaseNow=keepBase&&typeof cacheAvailable==='function'&&cacheAvailable();
        Promise.all([
          window.IMG.putFromCanvas(canvas,'image/png'),
          keepRaw?window.IMG.putFromCanvas(c,'image/png').catch(()=>''):Promise.resolve(''),
          keepBaseNow?window.IMG.putFromCanvas(baseCanvas,'image/png').catch(()=>''):Promise.resolve('')
        ])
          .then(([imgId,rawImgId,baseImgId])=>resolve(Object.assign({},meta,{imgId,restoreState:'done',restoreApplied:true,colorMatched:!!fixed},
            rawImgId?{rawImgId}:{},baseImgId?{baseImgId}:{},colorVersion?{autoVersion:colorVersion}:{},fallback?{colorFallback:fallback}:{})))
          .catch(reject);
      };
      // ⭐ 2026-10-19（docs/251 第 7 条③）：没做校色 / 校色没做成 ⇒ 这张就是底版（autoVersion 'base'），之后能切去现算别的校色
      if(!wantFix){ finish(c,false,null,'base'); return; }
      aiColorMatchCanvas(c,w,h,refB64,colorMatchLog,{job:job||null})
        .then(fixedCanvas=>finish(fixedCanvas||c,!!fixedCanvas,(fixedCanvas&&fixedCanvas.__v7BaseCanvas)||null,(fixedCanvas&&fixedCanvas.__v7ColorVersion)||'base',(fixedCanvas&&fixedCanvas.__v7Fallback)||''));
    }catch(e){reject(e);}};
    img.onerror=()=>reject(new Error('还原图片解码失败')); img.src=src;
  });
}
// ═══════════════════════════════════════════════════════════════
//  GRS 通道（夏算力）前端接线 · F1 拿子 key + F2 生成后回报张数
//
//  ⭐ 2026-10-02 照 V6 做（用户指定参考桌面「新建文件夹 (38)」的顶栏算力配置）：
//     V6 来源：tiles/tile-settings.js:1402-1424（选 key）
//              tiles/tile-tasks-service.js:277-290（生成后回报）
//              core/tile-api.js:243-389（托管/自带两种用法）
//
//  ⚠⚠ GRS【不是】「平台算力」。V6 里它就是一个独立通道（叫「夏算力」），
//     V7 里对应设置里的「Others · 旧 GRS」连接（connectionSlot='grs'）。
//     「平台 Banana 算力」那条路（aiPreparePlatformTask）跟这里无关，别搅在一起。
//
//  GRS 通道里有两种用法（用户 2026-10-02：「都要」）：
//     · 托管（proxy）：登录后跟后端要一把限额子 key，用户不用填 key
//     · 自带（byok） ：用用户自己在设置里填的 GRS key，后端不碰
//     判定照 V6 isUserByokActive：明确选了就听选的；没选（自动）= 填了 key 用自带、没填走托管。
//
//  ⚠⚠ 计费：GRS【不扣香蕉积分】—— 子 key 自带额度就是成本（V6 同样不走积分报价）。
//
//  ⚠⚠ 字段名跟 V6 不一样，【不能拿 V6 插件代码直接贴】：
//     V6 是 key_status / balance_cached、外层 {errno,info}；
//     V7 是 keyStatus / balanceCached、HTTP 状态码 + 直接返回数据。
//     贴错不报错、只是值永远读到 undefined（铁律 17 那种静默失效）。
//
//  ⚠⚠ 后端 /v1/compute/key【一律返回 200】表达业务失败（余额不足、被风控暂停…），
//     失败信息在 body 的 keyStatus 里 —— 必须看返回值，不能靠 catch 判失败。
// ═══════════════════════════════════════════════════════════════

// V6 的默认地址（core/app.js:111、tiles/tile-topbar.js:1052 「国内直连」）。
// 托管模式用户可能从来没填过地址，空着就用这个。
const GRS_DEFAULT_URL='https://grsai.dakka.com.cn';

// keyStatus → 报错码。⚠ 文案统一在 error-report.js 的 CATALOG 里（铁律 15）。
const GRS_KEY_STATUS_CODES={
  no_balance:'COMPUTE_NO_BALANCE',
  paused:'COMPUTE_PAUSED',
  create_failed:'COMPUTE_CREATE_FAILED'
};

// 这一单走不走 GRS 通道。
//   ⚠ task.connectionSlot 是建卡那一刻记下的（makeGenerationTask），最可靠；
//     s.provider==='grs' 是相机灯光那类直接传通道名的入口。
function grsTaskTargets(task,s){
  return String(task&&task.connectionSlot||'')==='grs'
    ||String(s&&s.connectionSlot||'')==='grs'
    ||String(s&&s.provider||'')==='grs';
}

// 现在该走平台额度还是自带官方 Key。
//
// ⭐⭐ 2026-10-09（用户定）：「如果用户选择了 GRS，就可以选择走我的 key 或者走 GRS 官方的 key」
//   ⇒ 下拉从三档（自动/托管/自带）收成【两档明确的】：proxy / byok。
//
//   ⚠⚠ 为什么【删掉"自动"那一档】：老逻辑是"填了 Key = 自带，没填 = 走平台额度"。
//     那意味着**用户什么都没选，我们就默认花他自己的 GRS 额度**（平台额度是真金白银）。
//     这种事不能默认 —— 必须让用户明确选一次。没选就报错让他去选，不替他决定。
//   ⚠ 兼容老存档：老代码里 '' = 自动、旧文案写作"夏三七托管"。
//     现在一律当成"没选"（返回 null 表示要用户去选），不再自动兜底。
//   ⚠ 返回 null / true / false 三态：null = 没选（调用方要拦住并提示）。
function grsKeySource(){
  const mode=String(settingsRuntime.grsMode||'');
  if(mode==='proxy')return true;
  if(mode==='byok')return false;
  return null;   // 没选（含老存档的 '' 自动档）
}
// 保留老函数名（别处还在用）。没选时**抛错**而不是悄悄兜底 —— 见 grsKeySource 的说明。
function grsUsesProxy(){
  const source=grsKeySource();
  if(source===null)throw Object.assign(new Error('请先在设置里选 GRS 用哪把 Key（走平台额度 / 走 GRS 官方 Key）'),{code:'COMPUTE_KEY_SOURCE_REQUIRED'});
  return source;
}

// 生成卡/引导页判断「服务商配好了没」用。
// ⚠ 托管模式用户【没有 key】也算配好了（登录了就行）——
//   不然算力来源下拉会挂着「· 需配置」，引导页也会一直催他去填 key（V6 也是这么区分的）。
function aiProviderReady(){
  if(String(aiRuntime.connectionSlot||'')==='grs'){
    // ⚠ 2026-10-09：grsUsesProxy() 现在在"没选走哪把 Key"时会抛错（那是给生成流程用的，
    //   要拦住用户并告诉他去选）。但这个函数是【渲染时】调的，抛出去就是界面崩。
    //   ⇒ 这里把"没选"当成【没配好】返回 false —— 生成卡会显示"需配置"，
    //     用户点进去就能看到那个下拉，比弹一张报错卡友好。
    let source=null;
    try{ source=grsKeySource(); }catch(_){ return false; }
    if(source===null)return false;
    if(source===true){
      return !!(window.V7Backend&&window.V7Backend.state&&window.V7Backend.state().signedIn);
    }
    // 走官方 Key：必须自己填了 Key 才算配好
    return !!String(settingsRuntime.grsKey||'').trim();
  }
  return !!(aiRuntime.baseUrl&&aiRuntime.apiKey);
}

// 同一次会话里，把「服务端记的模式」同步成本地选的（V6 切换时会调 /compute/byok）。
//   服务端模式影响两件事：后端发不发子 key（byok 时直接回 byok_no_key_on_server），
//   以及后台余额/审计的显示。只同步一次，失败不拦生成。
let grsServerModeSynced='';
async function grsSyncServerMode(mode){
  if(grsServerModeSynced===mode)return;
  if(typeof window.V7Backend?.computeByok!=='function')return;
  await window.V7Backend.computeByok(mode);
  grsServerModeSynced=mode;
}

// F1：生成前把 GRS 的 key 和地址定下来，写进 payload。
//   ⚠ 两种用法都【必经】这里，不然用户切了用法、这一单还按旧的跑。
//   ⚠ 子 key 不缓存：它是懒创建 + 有有效期的，风控还可能随时把它改成 paused。
//     缓存住会出现「后台已经停了、前端还拿旧 key 猛冲」。每单现拿。
//   ⚠ 出错只抛带码的错误，【不在这里弹卡】—— aiGenerateNow 的 catch 会按码弹，
//     这里再弹就是两张卡。
async function aiAttachGrsKey(task,p,s){
  if(!grsTaskTargets(task,s))return null;
  // 地址空着就用默认（托管用户可能从没填过）
  if(!String(p.baseUrl||'').trim()&&!String(p.endpoint||'').trim()){
    p.baseUrl=GRS_DEFAULT_URL;s.baseUrl=GRS_DEFAULT_URL;
  }
  if(!grsUsesProxy()){
    // 自带：用本地那把，没填就直说，【不许】悄悄退回托管
    if(!String(p.apiKey||'').trim())throw Object.assign(new Error('选了「自带 GRS Key」，但设置里还没填 Key'),{code:'COMPUTE_BYOK_KEY_REQUIRED'});
    task.grsMode='byok';
    if(window.V7Backend?.state?.().signedIn)grsSyncServerMode('byok').catch(()=>{});
    return {mode:'byok'};
  }
  // 托管：必须登录
  if(!window.V7Backend||!window.V7Backend.state().signedIn){
    throw Object.assign(new Error('「夏三七托管」要先登录账号；不想登录可以在设置里改成「自带 GRS Key」'),{code:'COMPUTE_LOGIN_REQUIRED'});
  }
  if(typeof window.V7Backend.computeKey!=='function')throw Object.assign(new Error('当前版本不支持 GRS 托管'),{code:'COMPUTE_KEY_FAILED'});
  let info;
  try{
    await grsSyncServerMode('proxy').catch(()=>{});
    info=await window.V7Backend.computeKey();
    // 服务端还记着 byok（以前切过）→ 切回托管再拿一次（V6 切换时也是先 setByok 再 getKey）
    if(info&&info.mode==='byok'){
      grsServerModeSynced='';
      await grsSyncServerMode('proxy');
      info=await window.V7Backend.computeKey();
    }
  }catch(error){
    throw Object.assign(new Error('拿 GRS 托管 key 失败：'+String(error&&error.message||error)),{code:error&&error.code==='AUTH_REQUIRED'?'COMPUTE_LOGIN_REQUIRED':'COMPUTE_KEY_FAILED'});
  }
  const status=String(info&&info.keyStatus||'');
  if(GRS_KEY_STATUS_CODES[status]){
    throw Object.assign(new Error(info.message||'GRS 托管暂时不能用'),{code:GRS_KEY_STATUS_CODES[status],
      computeContext:{'算力状态':status,'香蕉积分':info.bananaPoints!=null?String(info.bananaPoints):'','重试时间':info.retryAfter||'','暂停原因':info.pausedReason||''}});
  }
  if(!info||!info.key){
    throw Object.assign(new Error('后台没有发 GRS key（状态：'+(status||'未知')+'）'),{code:'COMPUTE_KEY_FAILED'});
  }
  // 余额快用完：不拦，提醒一下（L1 胶囊，不是错误卡）
  if(status==='low_balance'&&window.ERR)ERR.report('COMPUTE_LOW_BALANCE',{message:info.message||'',context:{'剩余':String(info.balanceCached!=null?info.balanceCached:'')}});
  if(info.allocation?.state==='manual'&&window.ERR)ERR.report('COMPUTE_ALLOCATION_PENDING',{message:info.allocation.message||''});
  // 用后台发的子 key，用户在设置里填的那把（如果有）这一单不用
  p.apiKey=String(info.key);
  task.grsMode='proxy';
  return info;
}

// F2：生成后回报张数（同步真实余额 + 记风控账）。
//   ⚠ 时机（用户让我定，照 V6 tile-tasks-service.js:277）：
//     【一单走完报一次】，成功失败都算 —— GRS 按「请求发出去」计费，
//     失败那批一样耗了额度，不报的话风控就算少了。
//     不是每张报一次：后端本来就按 attempts 一批记，逐张报只会把往返翻好几倍。
//   ⚠ 只有托管才报（V6 同样：!byokActive && cs.key）。自带 key 花的是用户自己的钱。
//   ⚠ 请求没真正发出去（比如在拿 key 那一步就停了）不报。
//   ⚠ 账号切换了也不报 —— 不能把旧账号的张数记到新账号头上。
//   ⚠ 这个调用【绝不让生成失败】：用户已经拿到图了，余额晚点同步不影响他。
function aiReportGrsAttempts(task,p){
  if(!task||task._grsReported)return;
  if(task.grsMode!=='proxy'||!task._grsSubmitted)return;
  if(typeof window.V7Backend?.computeRefill!=='function')return;
  task._grsReported=true;
  // 张数 = 请求的张数；服务商一次多吐的图按实际算（不会比请求少报）
  const attempts=Math.max(Number(p&&p.batch)||1,(task.outputs||[]).length);
  window.V7Backend.computeRefill(attempts)
    .then(res=>{
      if(!res)return;
      // 照 V6 core/tile-api.js:424-433 的提示
      if(res.paused)aiAddLog('GRS 托管：今日额度已用满，明天 0 点自动恢复','warn');
      else if(res.throttled)aiAddLog('GRS 托管：短时用得太多被限速，稍等一会再发','warn');
      else if(res.code&&res.message)aiAddLog('GRS 托管：'+res.message,'warn');
      else if(res.remaining!=null)aiAddLog('GRS 余额已同步 · 剩 '+res.remaining,'info');
    })
    .catch(error=>aiAddLog('GRS 张数回报失败（不影响本次结果）：'+String(error&&error.message||error),'warn'));
}

// ⭐⭐ 2026-10-09（用户定）：「直接显示"平台额度余 XXX"」。
//   把香蕉积分（= 平台 GRS 额度）直接摆在设置里 GRS 那一槽下面。
//
//   ⚠ 只在【走平台额度（proxy）】时显示：
//     走官方 Key 花的是用户自己的钱，给他看平台余额只会让人误会要扣。
//   ⚠ 数据源跟「积分与账单」页是同一个（/v1/points 的 balances.banana），不另算一套。
//   ⚠ 取不到就【说原因】，不显示假数字（用户定过："直接写一个数据未接入就好了，诚实一点"）。
//   ⚠ 失败不弹错卡：这是设置页的一个状态行，不是一次用户主动发起的操作。
let grsQuotaBusy=false;
async function refreshGrsQuota(){
  if(grsQuotaBusy)return;
  const boxes=document.querySelectorAll('[data-grs-quota]');
  if(!boxes.length)return;
  const paint=text=>boxes.forEach(b=>{b.textContent=text;});
  // 没走平台额度 → 这一行不该出现（外层还会判一次，这里兜底）
  let source=null;
  try{ source=grsKeySource(); }catch(_){ source=null; }
  if(source!==true){ paint('走 GRS 官方 Key：花你自己的钱，不扣平台额度'); return; }
  if(!window.V7Backend||!window.V7Backend.state||!window.V7Backend.state().signedIn){
    paint('平台额度：还没登录 —— 在下面「平台账号」里登录后就能看到'); return;
  }
  if(typeof window.V7Backend.points!=='function'){ paint('平台额度：当前版本读不到（不显示假数字）'); return; }
  grsQuotaBusy=true;
  paint('平台额度：正在读取…');
  try{
    const p=await window.V7Backend.points();
    const banana=p&&p.balances?p.balances.banana:null;
    if(banana==null){ paint('平台额度：后台没返回余额（不显示假数字）'); return; }
    const n=Number(banana)||0;
    // ⚠ 余额用完要说清后果（生成会被拦），不能只甩一个 0
    paint(n>0
      ? ('平台额度余 '+n.toLocaleString()+'（香蕉积分）· 用完了去「账单与兑换」用卡密充值')
      : '平台额度余 0（香蕉积分）—— 用完了，去「账单与兑换」用卡密充值后就能生成');
  }catch(error){
    paint('平台额度：读取失败（'+String(error&&error.message||error).slice(0,40)+'）');
  }finally{
    grsQuotaBusy=false;
  }
}
// 设置页渲染完 / 设置变化 / 登录状态变化 → 刷一次
try{
  window.addEventListener('wheelchair:settings-changed',()=>{ refreshGrsQuota(); });
  if(window.V7Backend&&window.V7Backend.onChange)window.V7Backend.onChange(()=>{ refreshGrsQuota(); });
}catch(_){}

function aiPlatformRoute(provider){
  const value=String(provider||'').toLowerCase();
  if(value==='aji')return 'banana';
  if(value==='rh'||value==='runninghub')return 'runninghub';
  if(value==='forge')return 'comfyui';
  return value;
}
async function aiPreparePlatformTask(task,p){
  if(!window.V7Backend||!window.V7Backend.requiresPlatformAccount(p.provider,p.computeSource))return null;
  const account=window.V7Backend.state();
  if(!account.signedIn)throw Object.assign(new Error('平台算力需要先登录 V7 账号；自己的第三方 API 可选择“其他”直接使用'),{code:'PLATFORM_LOGIN_REQUIRED'});
  if(task.platformBilling&&task.platformBilling.taskId)return task.platformBilling;
  if(!window.V7Workflows||!window.V7Workflows.isWorkflow(p))throw Object.assign(new Error('平台 Banana 服务尚未配置。请选择自己的服务 / API Key，或等待管理员开放平台算力；本次未扣费'),{code:'PLATFORM_IMAGE_SERVICE_UNCONFIGURED'});
  const route=aiPlatformRoute(p.provider), count=Math.max(1,Number(p.batch)||1);
  const quote=await window.V7Backend.quote(route,count);
  const estimate=quote&&quote.estimate||{};
  task.billingEstimate={points:Number(estimate.points)||0,etaSeconds:Number(estimate.etaSeconds)||0,route};
  aiAddLog('预计扣除 '+task.billingEstimate.points+' 积分 · 预计 '+task.billingEstimate.etaSeconds+' 秒 · '+route,'info');
  const charged=await window.V7Backend.createTask({
    idempotencyKey:'ui-'+String(p.taskId), route:route, requestedCount:count,
    presetId:p.presetTitle||'', presetVersion:p.presetVersion||''
  });
  task.platformBilling={taskId:charged&&charged.task&&charged.task.id, billingState:charged&&charged.task&&charged.task.billing_state, estimate:estimate};
  return task.platformBilling;
}
// ⭐⭐⭐ 2026-10-09（docs/195 §八，用户定案）：
//   「不退，但要在界面上明确告知用户」。
//   ⇒ 「扣了不退」这句话必须出现在【每一个会扣钱的确认弹窗】里，而且**措辞要一致**。
//   ⚠ 为什么要做成一个函数：界面上有【5 个】会扣钱的确认弹窗
//     （生成卡 / 助手 / 相机灯 / 创意工具 / 画布工作台）。
//     每个各写一份文案 ⇒ 早晚漂移（改了一处漏四处），用户在不同入口看到不同的说法，
//     出了争议时"到底承诺过什么"就说不清了。**只此一份，别在别处再抄一遍。**
//   ⚠ 只对【会扣积分】的路显示。自己的 API / 本机工作流是 0 分
//     （见下面 own/local 那两个 estimate），不扣钱就别吓唬用户。
//     判据：estimate.points > 0。调用方负责先判，本函数只管文案。
//   ⚠ 措辞要具体到"怎么不退"，不能只说"不退"：
//     什么时候扣 / 哪些情况不退 / 重试要重新扣 / 退出软件也损失。
//     这几条是用户会来问的，提前说清比事后解释便宜。
function billingNoRefundText(points){
  const n=Number(points)||0;
  return '⚠ 提交那一刻就扣掉本批费用'+(n>0?('（'+n.toLocaleString('zh-CN')+' 积分）'):'')+'，不是生成完再扣。\n'
    +'⚠ 扣掉的费用【不退回】：生成失败不退、中途取消不退、自己放弃不退；\n'
    +'   失败后点重试会【重新扣一次】（不是补上次那次）。\n'
    +'⚠ 退出软件后没来得及返回的结果会丢失，费用照样不退。\n'
    +'确认要继续吗？';
}
// ⭐ 2026-10-21（用户：云端要显示前面排几单 + 耗时节点的进度）：workflow-runtime 轮询 /v1/tasks/<id> 带回 cloudProgress，
//   这里换成任务卡字段 —— cloudLive 画进度条里「还没完成」那段（taskLiveWidth），withPct=单张任务顺手改右边百分比。
//   千问一张一张回，百分比已经按回了几张算，所以它不改 pct（withPct=false）。
function aiCloudProgressPatch(value,withPct){
  const cp=value&&value.cloudProgress;
  if(!cp||typeof cp!=='object')return {};
  const f=Math.max(0,Math.min(1,Number(cp.fraction)||0)), patch={cloudLive:f};
  // ⭐ 2026-10-22（用户：采样步数显示在缩略图沙漏下面）：有步数就带上，buildPreview 画在下一张那一格
  patch.cloudSteps=(cp.phase!=='queued'&&cp.phase!=='done'&&Number(cp.max)>0)?{value:Math.max(0,Number(cp.value)||0),max:Number(cp.max),label:String(cp.label||'')}:null;
  if(withPct)patch.pct=Math.min(99,Math.round(f*100));
  return patch;
}
async function aiGenerateNow(snapshot,opts){
  const executionScope=cacheNamespaceId(),executionEpoch=sourceImageEpoch;
  let requestedProjectId='';
  try{requestedProjectId=window.V7ProjectSchedule?.quickState?.()?.projectId||'';}catch(_){}
  const guard=()=>{if(executionScope!==cacheNamespaceId()||executionEpoch!==sourceImageEpoch)throw Object.assign(new Error('账号已切换，旧生成任务已停止'),{code:'AI_CONTEXT_CHANGED'});if(opts&&opts.guard)opts.guard();};
  const s=Object.assign({},snapshot||aiTempSnapshot());
  // ⭐ 2026-10-19（docs/250 第 20 条）：这一单的原始请求先记一份，失败了「重跑」原样再发（下面拿到任务卡后挂上去）
  const rerunRecipe=aiRerunRecipe(s,opts);
  if(s.referenceAssets){
    try{
      s.refImages=await V7PresetReferences.payload(s.referenceAssets);guard();
      // ⭐ 融合方案-C01：生成这一刻再问一次闸门（「超了就拒」，不偷偷截掉几张发出去）。
      //   为什么加图时判过了这里还要判：加完图再换模型（比如换成只收 3 张的香蕉1），
      //   或者老预设本来就存了超过 5 张 —— 加图那道关拦不住这两种。
      //   ⚠ 放在这里 = 还没抓检查点、没扣费、没发请求；失败走下面同一个 catch（报错卡 + 任务标失败）。
      if(window.V7ReferenceGate&&s.refImages.length){
        const isWorkflow=!!(s.workflowPreset&&(s.workflowPreset.workflow||s.workflowPreset.forgeWorkflow));
        const verdict=V7ReferenceGate.check({protocol:s.protocol,model:s.model,
          modelName:(aiModelOptions(s.model).find(x=>x[0]===s.model)||[])[1]||s.model,
          workflow:isWorkflow?String(s.workflowSource||'local'):'',count:s.refImages.length});
        if(verdict.max<s.refImages.length)throw Object.assign(new Error(verdict.reason+'。请先在参考图弹窗里删掉 '+(s.refImages.length-verdict.max)+' 张再生成'),{code:'PRESET_REFERENCE_FAILED'});
      }
    }
    catch(error){
      if(executionScope!==cacheNamespaceId()||executionEpoch!==sourceImageEpoch)return {ok:false,cancelled:true,code:'AI_CONTEXT_CHANGED'};
      try{guard();}catch(stopped){aiMarkInactive(s.taskId);updateGenerationTask(s.taskId,{status:'cancelled',cancelRequested:true});return {ok:false,cancelled:true,code:stopped.code};}
      V7PresetReferences.report(error);aiMarkInactive(s.taskId);updateGenerationTask(s.taskId,{status:'failed',stage:'prepare',errorCode:error.code||'PRESET_REFERENCE_FAILED',error:String(error.message||error)});return {ok:false,error:String(error.message||error)};
    }
  }
  if(s.captureSnapshot)s.captureSnapshot=aiCaptureSnapshot(s.captureSnapshot,s.antiMode);
  else if(s.capture)s.captureSnapshot=aiCaptureSnapshot(s.capture,s.antiMode);
  // ⭐ 千问模式（2026-10-15）：原本走 Banana / GPT 的这一单改成千问 2.1 工作流（qwen-mode.js）。
  //   改道后就是一条普通的工作流请求（平台 / 本地 ComfyUI 由设置「千问模式在哪算」决定），下面整条路照常走；
  //   只有"出图"那一步换成 V7QwenMode.generate（一张一张跑，跑完一张回一张）。
  let qwenRoute=null;
  if(window.V7QwenMode&&V7QwenMode.shouldReroute(s)){
    try{qwenRoute=V7QwenMode.reroute(s,text=>aiAddLog(text,'warn'));}
    catch(error){aiMarkInactive(s.taskId);if(window.ERR)ERR.report(error.code||'QWEN_ROUTE_FAILED',{message:error.message});else aiAddLog(error.message,'error');return {ok:false,error:error.message,code:error.code};}
  }
  const p=Object.assign(aiPayload(qwenRoute||s),qwenRoute?{qwenRequested:qwenRoute.qwenRequested,qwenPromoteFirstReference:qwenRoute.qwenPromoteFirstReference===true,batch:qwenRoute.qwenRequested}:{}), isCurrent=()=>String(aiRuntime.currentTaskId||'')===p.taskId;
  let task=taskById(p.taskId), stage='validate';
  try{
    guard();
    // 2026-10-18 深夜：RunningHub 没接线（总开关 window.V7_RUNNINGHUB_OFF）—— 以前导入的 RH 预设，出图前直接说清楚，不发出去
    if(window.V7_RUNNINGHUB_OFF&&/^(rh|runninghub)$/.test(String(p.provider||'')))throw Object.assign(new Error('RunningHub 还没接通，这条预设暂时用不了：换一条平台工作流或本地 ComfyUI 的预设'),{code:'window.V7_RUNNINGHUB_OFF'});
    if(!task){task=addTask(makeGenerationTask(p));if(window.PRESETUI&&PRESETUI.recordFieldHistory&&s.fieldHistorySnapshot)PRESETUI.recordFieldHistory(s.fieldHistorySnapshot);}
    if(!task._rerun)task._rerun=rerunRecipe;
    // 千问：不管卡是在哪建的（开始生成按钮 / 批量工场 / 助手），都写「云端 · 千问 2.1」、按千问记账（见 makeGenerationTask）
    if(qwenRoute){task.channelLabel=aiQwenChannelLabel();task.connectionSlot='qwen';task.computeSource=V7QwenMode.source();}
    if(task.cancelRequested)return {ok:false,taskId:p.taskId,error:'已取消'};
    if(requestedProjectId&&p.captureSnapshot?.docId!=null&&window.V7ProjectSchedule?.projectIdForCapture){
      // ⭐ 10-25（反馈 #16）：认项目要再问一次 PS 开着哪些文档 —— 只是顺手关联，最多等 8 秒，问不到就当没关联，绝不挡住生成
      try{task.productProjectId=await Promise.race([V7ProjectSchedule.projectIdForCapture(p.captureSnapshot,requestedProjectId),new Promise(r=>setTimeout(()=>r(''),8000))])||'';}
      catch(_){task.productProjectId='';}
      guard();
      if(task.productProjectId&&typeof historyRecordTask==='function')historyRecordTask(task);
    }
    task._restorations=new Map();
    task.preserveGeneratedAppearance=s.preserveGeneratedAppearance===true;
    task.colorToolRunId=String(s.colorToolRunId||'');
    if(s.referenceAssets)task.referenceAssets=s.referenceAssets;
    updateGenerationTask(p.taskId,{status:'running',errorInfo:null,error:'',cancelRequested:false,returnState:'idle',returnError:'',
      captureSnapshot:p.captureSnapshot,
      sourceDocId:p.captureSnapshot&&p.captureSnapshot.docId,sourceDocName:p.captureSnapshot&&p.captureSnapshot.docName,
      sourceSelection:p.captureSnapshot&&p.captureSnapshot.selection,sourceImageBase64:p.sourceImageBase64,inputImageBase64:p.inputImageBase64,
      shots:Array.from({length:p.batch},()=>({done:false})),outputs:[],errors:[],pct:0,sub:'已抓取 Photoshop 图片 · 准备提交'});
    // ⚠ 输入图必须过图片管家登记，不能直接把完整 base64 塞进 sourceImg。
    //   ① 直接塞 = 一张 4K 图 21MB 字符串当 CSS 背景 + 整图解码去提主题色，
    //      正是 docs/21 要根治的问题 —— 这条路径当初漏掉了。
    //   ② 不登记就没有 imgId，缓存那边判定"没有输入图"，
    //      重启后任务卡背景就变回占位渐变(实测踩到)。
    //   真正的抓取发生在 makeGenerationTask 之后，所以只能在这里补登记。
    registerTaskSourceImage(p.taskId, p.sourceImageBase64, p.inputMime);
    const workflowMode=!!(window.V7Workflows&&V7Workflows.isWorkflow(p));
    // ⭐ GRS 通道：定下用托管子 key 还是自带 key（见 aiAttachGrsKey）。
    //   ⚠ 必须排在「检查地址」【之前】—— 托管用户可能从没填过 GRS 地址，
    //     这一步会补上默认地址；排在后面就会被「请先填写 API URL」挡住。
    //   ⚠ 工作流那条路不走 GRS，跳过。
    if(!workflowMode){stage='prepare';await aiAttachGrsKey(task,p,s);guard();stage='validate';}
    if(!workflowMode&&!s.baseUrl&&!s.endpoint)throw Object.assign(new Error('还没配生图服务：到设置卡「用哪家生图」填好地址和 API Key'),{code:'AI_URL_MISSING'});
    if(!workflowMode&&!String(s.prompt||'').trim())throw Object.assign(new Error('请先填写提示词'),{code:'AI_PROMPT_MISSING'});
    // This saves the complete source document directly to disk and is not a
    // generation input/result. A checkpoint failure is visible but does not
    // turn a valid generation into a failed or billable retry.
    if(checkpointRuntime&&settingsRuntime.checkpointEnabled===true&&!s.skipCheckpoint){
      try{
        // ⚠ 项目名用任务自己定下的那个（task.cacheProject），不要另算一遍 ——
        //   两边各算各的就会出现「计算在 A 项目、检查点在 B 项目」，时间轴配不上（docs/96 缺陷 2）。
        const cp=await checkpointRuntime.beforeGeneration({docId:p.captureSnapshot&&p.captureSnapshot.docId,
          docName:p.captureSnapshot&&p.captureSnapshot.docName,cacheProject:task.cacheProject||cacheScopedProject(cacheProjectName(task))});
        if(cp&&cp.created){
          task.checkpointRef=cp.checkpoint.cacheRef;
          aiAddLog('已保存完整画布检查点 · '+Math.round(cp.checkpoint.durationMs||0)+' 毫秒','success');
        }
      }catch(checkpointError){
        guard();
        if(checkpointError.checkpointSaved)task.checkpointRef=checkpointError.checkpointRef;
        if(window.ERR&&checkpointError.code==='CHECKPOINT_CACHE_FAILED'&&ERR.cacheFailure)ERR.cacheFailure('CHECKPOINT_CACHE_FAILED',{kind:checkpointError.cacheKind,path:checkpointError.cachePath,error:checkpointError.message,context:{'本次生成':checkpointError.checkpointSaved?'继续执行；本次检查点已保存，容量清理未完成':'继续执行；本次未新增检查点'}});
        else if(window.ERR)ERR.report(checkpointError.code||'CHECKPOINT_EXPORT_FAILED',{message:checkpointError.message,context:{'本次生成':checkpointError.checkpointSaved?'继续执行；本次检查点已保存，容量清理未完成':'继续执行；本次未新增检查点'}});
        else aiAddLog('检查点保存失败：'+checkpointError.message,'warn');
      }
      guard();
      if(task.cancelRequested)return {ok:false,taskId:p.taskId,error:'已取消'};
    }
    guard();
    if(!workflowMode)await aiPreparePlatformTask(task,p);
    guard();
    // ⭐ 10-25（用户定）：带参考图时，图 1 和参考图都补成正方形再发（ref-square-pad.js）。
    //   ⚠ 只改 p（发出去的那份）：任务卡上记的原图在上面 updateGenerationTask 时已经存好了，校色基准 sourceImageBase64 也不动。
    //   ⚠ 图 1 补过 ⇒ task._squarePad 记下位置，aiRestoreTaskImage 先裁回再还原 / 校色。
    if(window.V7RefSquarePad&&V7RefSquarePad.shouldApply({enabled:settingsRuntime.refSquarePad!==false,workflow:workflowMode,qwen:!!qwenRoute,refImages:p.refImages})){
      stage='prepare';
      try{
        const first=await V7RefSquarePad.pad(p.inputImageBase64,p.inputMime);guard();
        const refs=await V7RefSquarePad.padReferences(p.refImages);guard();
        if(first.plan){p.inputImageBase64=first.imageBase64;p.inputMime=first.mime;task._squarePad=first.plan;}
        p.refImages=refs.refs;
        p.aspectRatio='1:1';
        aiAddLog('带参考图 · 补成正方形：图 1 '+(first.plan?(first.plan.width+'×'+first.plan.height+' → '+first.plan.size+'×'+first.plan.size+'（回图裁回原尺寸）'):'本来就是正方形')+' · 参考图补了 '+refs.padded+'/'+p.refImages.length+' 张 · 比例按 1:1 发','info');
      }catch(error){
        if(error&&error.code==='AI_CONTEXT_CHANGED')throw error;
        throw Object.assign(new Error('补正方形失败：'+(error&&error.message||error)+'。可以到设置 → 抓图与出图，关掉「带参考图时自动补成正方形」再试'),{code:'SQUARE_PAD_FAILED'});
      }
      stage='validate';
    }
    stage='submit';
    if(!window.uiwin||!window.uiwin.ai||!window.uiwin.ai.generate)throw Object.assign(new Error('AI 主进程接口不可用'),{code:'AI_BRIDGE_UNAVAILABLE'});
    aiMarkActive(p.taskId,'generate');
    if(isCurrent()){
      aiRuntime.captureSnapshot=s.captureSnapshot;aiRuntime.capture=s.captureSnapshot;
      aiRuntime.status='排队中';aiRuntime.progress=0;aiRuntime.outputs=[];aiRuntime.errors=[];
    }
    aiAddLog('开始真实生成 · '+p.model+' · '+p.size+' · '+p.aspectRatio,'info');aiRefreshInPlace();
    stage='generate';
    // GRS 回报用：请求从这一刻起算「真的发出去了」（见 aiReportGrsAttempts）
    task._grsSubmitted=true;
    const workflowHooks={
      guard,
      confirm:estimate=>opts&&opts.confirm?opts.confirm(estimate):new Promise(resolve=>UI.dialog({title:'确认本次平台生成',body:'预设：'+(p.presetTitle||'当前预设')+' · 文档/部位：'+(p.captureSnapshot&&p.captureSnapshot.docName||'当前选区')+'\n生成 '+(estimate.qwenTotal||p.batch)+' 次 · 预计 '+(estimate.points*(estimate.qwenTotal||1)).toLocaleString('zh-CN')+' 积分 · 约 '+estimate.etaSeconds+' 秒',
        detail:billingNoRefundText(estimate.points),
        confirm:'确认并生成',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})),
      onProgress:value=>{updateGenerationTask(p.taskId,Object.assign({sub:(value.cloudProgress||qwenRoute?'':'工作流 · ')+(value.status||'处理中')},aiCloudProgressPatch(value,!qwenRoute)));}
    };
    // 千问：每回来一张就存图、点亮任务卡那一格（一张一张回）；最后汇总时不再重复存
    const qwenRestored=[];
    const result=qwenRoute?await V7QwenMode.generate(p,task,workflowHooks,async(raw,done,total)=>{
      const image=await aiRestoreTaskImage(task,raw);guard();
      qwenRestored.push(image);
      if(image&&image.restoreState==='done'){
        const shots=task.shots.slice();
        shots[raw.index]=Object.assign({},shots[raw.index],{done:true,error:'',errorInfo:null,imgId:image.imgId,rawImgId:image.rawImgId||'',baseImgId:image.baseImgId||'',autoImgId:image.autoImgId||image.imgId||'',autoVersion:image.autoVersion||'',restoreState:'done'});
        updateGenerationTask(p.taskId,{shots,pct:Math.round(done*100/total),sub:'开源模型 · 已回 '+done+'/'+total+' 张'});
        aiRefreshInPlace();
      }
    }):workflowMode?await V7Workflows.generate(p,task,{
      guard,
      // ⭐ 2026-10-16（用户：「用Forge不用确认。现在每次用Forge之前要点一次确认」）：平台工作流不再弹确认框，
      //   预计扣几分写进任务卡和日志（扣分规则不变：算了就扣、失败也扣，见 billingNoRefundText）。
      //   ⚠ 调用方自己带了 confirm（批量工场等）照旧用它的。
      confirm:estimate=>{if(opts&&opts.confirm)return opts.confirm(estimate);const pts=Number(estimate&&estimate.points)||0;if(pts){aiAddLog('平台工作流：本次预计扣 '+pts+' 积分（'+(p.presetTitle||'当前预设')+'）','info');updateGenerationTask(p.taskId,{sub:'工作流 · 预计扣 '+pts+' 积分'});}return Promise.resolve(true);},
      onProgress:value=>{updateGenerationTask(p.taskId,Object.assign({sub:(value.cloudProgress?'':'工作流 · ')+(value.status||'处理中')},aiCloudProgressPatch(value,true)));}
    }):await window.uiwin.ai.generate(p);
    guard();
    if(!result||!result.ok){
      // ⚠ 错误码不能在这里断掉(2026-09-11)。两个壳都会把每张图的失败原因
      //   放进 result.errors[]，只取 result.error 这一个字符串就把 code 丢了，
      //   报错卡查表查不到，只能显示成"出了点问题"。
      const first=(result&&Array.isArray(result.errors)&&result.errors[0])||null;
      throw Object.assign(new Error(result&&result.error||'生成失败'),
        // serverBody = 服务器拒绝时说的原话，报错卡靠它判断是不是"图太大"。
        {code:first&&first.code||undefined,httpStatus:first&&first.httpStatus,serverBody:first&&first.serverBody});
    }
    stage='restore';
    const restored=qwenRoute?qwenRestored.filter(Boolean):[], restoreErrors=[];
    if(!qwenRoute)for(const raw of (result.results||[])){
      try{guard();restored.push(await aiRestoreTaskImage(task,raw));guard();}
      catch(e){guard();restoreErrors.push({index:raw.index,message:e.message,code:'AI_RESTORE_FAILED',stage:'restore'});}
    }
    task.outputs=restored.filter(x=>x.restoreState==='done').map(aiClonePlain);
    task.errors=(result.errors||[]).concat(restoreErrors).map(aiClonePlain);
    // A provider may return more than one image for a single request. Keep a
    // shot slot for every returned index so all images remain visible,
    // cacheable and transferable instead of truncating to the requested batch.
    const maxResultIndex=restored.reduce((max,image)=>Math.max(max,Number(image&&image.index)||0),-1);
    const shotCount=Math.max(task.shots.length,Number(p.batch)||1,maxResultIndex+1);
    while(task.shots.length<shotCount) task.shots.push({done:false,error:'',restoreState:'pending',imgId:''});
    const shots=Array.from({length:shotCount},(_,index)=>{
      const shot=task.shots[index]||{done:false,error:'',restoreState:'pending',imgId:''};
      const image=restored.find(x=>Number(x.index)===index&&x.restoreState==='done');
      // rawImgId = 校色前的 AI 原图（B01 第 1 步，见 aiRestoreImage 的 finish）
      // baseImgId = 掰正过、没校色的底版（143，同上那条路）
      // ⚠ 两个都必须显式往下传 —— 上面 9379 那处也是同一个坑（只挑几个字段复制）。
      // ⭐⭐ docs/170 §4.3 不变量 8：autoImgId 也要显式带下去 ——
      //   这个项目"手写对象只挑几个字段传、新字段静默消失"已经栽过三次。
      //   ⚠ 兜底 ||image.imgId：老数据可能没有这个字段。
      //
      // ⚠⚠⚠ 2026-10-09（docs/189）：**`if(image)` 这个判断一个都不能少。**
      //   3c49572a（10-08）为了加 autoImgId 手写了新的 return，把这个判断弄丢了
      //   ⇒ 无条件 return ⇒ 下面那个"单张失败就降级"的分支变成【死代码】。
      //   后果（用户实测报的）：一批里只要有一张超时/没回来，
      //     image 就是 undefined → image.imgId 抛 TypeError →
      //     异常冒到 aiGenerateNow 的 catch → 整个任务判 failed →
      //     updateGenerationTask 里那段"把所有未完成的图标失败"连【已算完的图】一起抹掉。
      //   实测（tmp/_prove-shots-crash.cjs）：要 10 张、第 6 张超时 ——
      //     旧版：成功 9 张 / 失败 1 张；丢判断的版本：抛 TypeError，整批全废。
      //   ⚠ 所以：**加字段的时候，别把旧 return 上的条件丢下**。
      if(image)return {done:true,error:'',errorInfo:null,imgId:image.imgId,
      rawImgId:image.rawImgId||'',baseImgId:image.baseImgId||'',
      autoImgId:image.autoImgId||image.imgId||'',autoVersion:image.autoVersion||'',restoreState:'done'};
      const failure=task.errors.find(x=>Number(x.index)===index);
      return Object.assign({},shot,{done:false,error:failure&&failure.message||'',errorInfo:failure?taskErrorInfo(failure,stage,failure.code):null});
    });
    const cancelled=task.cancelRequested||result.cancelled;
    const sub=cancelled?'已取消 · 保留 '+task.outputs.length+' 张':'生成完成 · '+task.outputs.length+'/'+shots.length+' 张';
    // ⚠⚠ 点过「提前结束」的任务【不许自动传回】（2026-09-13 用户定案）。
    //   用户已经把想要的那批手动传走了，剩下的是"慢慢算、自己挑着传"的 ——
    //   这时候再自动整批贴进 PS，等于把他刚才的挑选作废，还会在文档里塞一堆没要的图层。
    //   剩下的怎么传：任务卡上的「传回 N」，或者缩略图上的单张「传回」。
    const willReturn=!cancelled&&!task.backgrounded&&task.outputs.length>0&&opts&&opts.autoReturn;
    if(task.backgrounded&&task.outputs.length>0){
      aiAddLog('后台算完了 '+task.outputs.length+' 张 · 这批不会自动传回，请在任务卡或缩略图上手动传','info');
    }
    updateGenerationTask(p.taskId,{status:cancelled?'cancelled':willReturn?'running':task.outputs.length?'done':'failed',shots,pct:100,sub});
    if(isCurrent()){aiRuntime.outputs=task.outputs;aiRuntime.errors=task.errors;aiRuntime.progress=100;aiRuntime.status=sub;}
    aiRefreshInPlace();
    if(cancelled)return {ok:false,taskId:p.taskId,error:'已取消',results:task.outputs};
    if(!task.outputs.length)return {ok:false,taskId:p.taskId,error:'没有可用的生成结果',errors:task.errors};
    if(willReturn){
      guard();
      stage='transfer';
      aiMarkActive(p.taskId,'transfer');
      const placed=await aiTransfer(task);
      guard();
      aiMarkActive(p.taskId,'generate');
      if(!placed||!placed.ok)return {ok:false,taskId:p.taskId,error:placed&&placed.error||'传回失败',results:task.outputs};
    }
    return result;
  }catch(e){
    if(executionScope!==cacheNamespaceId()||executionEpoch!==sourceImageEpoch)return {ok:false,cancelled:true,taskId:p.taskId,code:'AI_CONTEXT_CHANGED'};
    try{guard();}catch(stopped){if(task)updateGenerationTask(p.taskId,{status:'cancelled',cancelRequested:true,sub:'已停止'});return {ok:false,cancelled:true,taskId:p.taskId,code:stopped.code};}
    if(e.code==='AI_CONTEXT_CHANGED'||e.code==='ASSISTANT_SESSION_CHANGED')return {ok:false,cancelled:true,taskId:p.taskId,code:e.code,error:e.message};
    const cancelled=task&&task.cancelRequested||e.message==='已取消';
    const msg=cancelled?'已取消':e.message||String(e);
    const code=cancelled?'AI_CANCELLED':e.code||'AI_TASK_FAILED';
    if(task){
      task.errors.push({message:msg,stage,code});
      // ⚠ _errorReported=true：生成失败必须先做联网探测才能定性
      //   (「连不上」还是「连上了但响应被拦」是两种病、两种修法)，
      //   所以这里先挂"已报"的牌子，由下面那段异步去报，否则会弹两张卡。
      updateGenerationTask(p.taskId,{status:cancelled?'cancelled':'failed',stage,errorCode:code,error:msg,
        _errorReported:!cancelled});
      if(isCurrent()){
        const st=(window.ERR&&ERR.stageLabel(stage))||'';
        aiRuntime.status=cancelled?'已取消':('失败'+(st?' · '+st:'')+'（详情看报错卡）');
        aiRuntime.outputs=task.outputs;aiRuntime.errors=task.errors;
      }
    }
    if(cancelled){
      aiAddLog(msg,'info');
    }else if(window.ERR){
      // ⭐ 2026-09-11：这一句 `Failed to fetch` 曾经让整条链路查不下去。
      //   reportGenerateFailure 会自动探测服务器，把它拆成两种明确的病。
      // ⭐ 把"这次到底发出去多大"一并报出来。服务器说"太大"的时候，
      //   光有一句"太大"没用 —— 得知道大在哪、离能过还差多少，才谈得上要不要压缩。
      const snap=p.captureSnapshot||{};
      const inB64=String(p.inputImageBase64||'').length;
      const refB64=(p.refImages||[]).reduce((n,r)=>n+String((r&&(r.imageBase64||r.base64))||'').length,0);
      const mb=v=>v?(v/1024/1024).toFixed(1)+'MB':'';
      ERR.reportGenerateFailure(e,{stage,taskId:String(p.taskId||''),code,
        url:String(p.endpoint||p.baseUrl||''),
        context:{'模型':p.model||'','尺寸':p.size||'','比例':p.aspectRatio||'','张数':p.batch||'',
          '输入图尺寸':(snap.pixelWidth||snap.width)?((snap.pixelWidth||snap.width)+'×'+(snap.pixelHeight||snap.height)):'',
          '输入图大小':mb(inB64),
          '参考图':refB64?((p.refImages||[]).length+' 张 · '+mb(refB64)):'',
          '这次发出去':mb(inB64+refB64),
          // GRS 托管拿 key 失败时，报错卡上要看得到「算力状态 / 重试时间」（见 aiAttachGrsKey）
          ...(e&&e.computeContext||{})}});
      // ⭐ 2026-10-24（V7待办/02 竞速选线）：阿吉 / 墨墨自动选线时请求根本没送到（没有 HTTP 状态）⇒ 马上重测一轮线路，
      //   下一单换到通的那条。⚠ 不自动重发这一单：阿吉发送即扣，送没送到我们说不准，重发可能扣两次。
      if(!(e&&e.httpStatus)&&['aji','momo'].includes(String(p.connectionSlot||''))&&typeof providerLinesMaybeRace==='function'){
        try{ providerLinesMaybeRace(true); }catch(_){}
      }
    }else{
      aiAddLog(msg,'error');
    }
    return {ok:false,taskId:p.taskId,error:msg};
  }finally{
    if(task)delete task._restorations;
    if(executionScope===cacheNamespaceId()&&executionEpoch===sourceImageEpoch){
      // ⭐ GRS 托管：一单走完报一次张数（成功失败都报）。
      //   ⚠ 放在 finally 里 —— 成功、失败、中途抛错都要走到；
      //   ⚠ 放在「账号没换」这个判断里 —— 换了账号就不能把旧账号的张数记到新账号头上。
      aiReportGrsAttempts(task,p);
      aiMarkInactive(p.taskId);aiRefreshInPlace();
    }
  }
}
// ═══ 失败任务「重跑」（2026-10-19，docs/250 第 20 条，用户定）═══════════════
//  用户原话：「如果这个任务全部都失败了的话，可以点击那个小按钮直接重新跑一遍 就是用它原有的提示词和区域再跑一遍，
//           然后把原来失败的那个任务直接去顶掉」
//  ① 参数：这一单当时的整份请求（aiGenerateNow 一进来就记下、挂在任务上，只在内存里）；
//     重启恢复回来的任务没有这份 ⇒ 用 meta 里存的那些字段拼（aiRerunRecipeFromCache）。
//  ② 原图和区域：同一次运行里任务上就有（captureSnapshot）；重启恢复的从缓存 input.png 读回来，
//     抗截断开着的话按同一套像素运算重新做出发出去的那张。【不再去 Photoshop 抓图】。
//  ③ 连接：这一单走哪个（阿吉 / 墨墨 / GRS / 自定义）就还走哪个，地址和 Key 从【现在的设置】里现取 —— 任务上不存密钥。
//  ④ 顶掉：原卡跟手点 ✕ 一样收起（removeTask + cacheSetTaskbar(false)），「记录与恢复」里那条失败记录留着。
//  ⑤ 扣费：用户 10-19 定「不用管」—— 不加任何扣费提示，计费规则不动。
//  ⚠ 这几个函数要待在 aiGenerateNow 和 aiBeginImmediate 中间：tests/ai-generation-account-guard.test.js 按这两个标记切源码跑 aiGenerateNow，
//    aiRerunRecipe 挪出去就是 not defined。
function aiRerunRecipe(snapshot,opts){
  // ⚠ 用排除法、不挑字段：这个项目「手写对象只挑几个字段传、新字段静默消失」栽过好几次。
  //   排除的只有：密钥（重跑时现取）、图（原图在任务的 captureSnapshot 上）、抓图之前才用的东西、aiRuntime 里那些运行时状态（日志、队列…）。
  const skip=['taskId','apiKey','comfyKey','runninghubKey','capture','captureSnapshot','fieldHistorySnapshot','preActionPreset',
    'outputs','errors','queue','running','currentTaskId','activePhase','activeTasks','status','progress','logs','lastPlan'];
  const config={};
  for(const key of Object.keys(snapshot||{}))if(skip.indexOf(key)<0)config[key]=snapshot[key];
  return {config,autoReturn:!!(opts&&opts.autoReturn)};
}
function aiRerunUnavailable(what){
  return Object.assign(new Error(what+'，没法原样重跑'),{code:'TASK_RERUN_UNAVAILABLE'});
}
// 连接按原单那个（provider-connections.js 同一套换算），地址和 Key 现取；地址没变就连当时的 endpoint 一起留着
function aiRerunConnection(config){
  const out={comfyUrl:settingsRuntime.comfyUrl,comfyKey:settingsRuntime.comfyKey,runninghubUrl:settingsRuntime.runninghubUrl,runninghubKey:settingsRuntime.runninghubKey};
  const slots=['aji','momo','grs','other'],norm=v=>{const x=String(v||'');return x==='others'?'other':x;};
  // provider 优先：相机灯光那类入口直接把 provider/地址换成别的通道，connectionSlot 还是全局那个；
  //   改走千问的单 connectionSlot 是 'qwen'、provider 还是原来那家；工作流单 provider 是 comfyui 这类（连接用不上）
  const slot=slots.indexOf(norm(config.provider))>=0?norm(config.provider):norm(config.connectionSlot);
  if(slots.indexOf(slot)<0||!window.V7ProviderConnections)return out;
  const next=V7ProviderConnections.runtimePatch(Object.assign({},settingsRuntime,{provider:slot},slot==='other'?{otherConnection:'custom'}:{}),{});
  next.endpoint=next.baseUrl===String(config.baseUrl||'')?String(config.endpoint||''):'';
  return Object.assign(out,next);
}
// 抗截断：跟插件抓图（ps-pixels.js 的 pixelsHueShift180 / pixelsFlipVertical）、aiRestoreImage 里的还原是同一个运算（自逆）。
function aiAntiTruncateUrl(url,mode){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{try{
      const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
      if(!w||!h)throw new Error('原图尺寸无效');
      const c=document.createElement('canvas');c.width=w;c.height=h;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);
      const id=ctx.getImageData(0,0,w,h),d=id.data;
      for(let i=0;i<d.length;i+=4){const mx=Math.max(d[i],d[i+1],d[i+2]),mn=Math.min(d[i],d[i+1],d[i+2]),sum=mx+mn;d[i]=sum-d[i];d[i+1]=sum-d[i+1];d[i+2]=sum-d[i+2];}
      if(mode===2){const row=w*4,tmp=new Uint8ClampedArray(row);for(let y=0;y<Math.floor(h/2);y++){const a=y*row,b=(h-1-y)*row;tmp.set(d.subarray(a,a+row));d.copyWithin(a,b,b+row);d.set(tmp,b);}}
      ctx.putImageData(id,0,0);
      c.toBlob(blob=>{
        if(!blob){reject(new Error('抗截断输入图编码失败'));return;}
        const fr=new FileReader();
        fr.onload=()=>{const text=String(fr.result||'');resolve(text.slice(text.indexOf(',')+1));};
        fr.onerror=()=>reject(fr.error||new Error('抗截断输入图读取失败'));
        fr.readAsDataURL(blob);
      },'image/png');
    }catch(error){reject(error);}};
    img.onerror=()=>reject(new Error('原图解码失败'));
    img.src=url;
  });
}
async function aiRerunCapture(old){
  const snap=old.captureSnapshot||null;
  if(snap&&(snap.inputImageBase64||snap.imageBase64))return snap;
  // 重启恢复回来的任务：快照里只剩文档和选区，原图（用户看到的正常那张）从缓存 input.png 读回来
  if(!snap||!old.sourceImgId||!window.IMG||!window.IMG.has(old.sourceImgId))throw aiRerunUnavailable('这单的原图已经不在了');
  const mode=Math.max(0,Math.min(2,Number(old.antiMode)||0));
  const source=await window.IMG.base64(old.sourceImgId);
  const input=mode?await aiAntiTruncateUrl(await window.IMG.fullUrl(old.sourceImgId),mode):source;
  return Object.assign({},snap,{imageBase64:input,inputImageBase64:input,sourceImageBase64:source,mime:'image/png',antiMode:mode});
}
// 重启恢复的任务带过参考图：缓存里是 ref_1..N（cacheSaveTask 按原格式写的），按顺序读回来，少一张都不跑（不偷偷少发）
async function aiRerunReadReferences(old,count){
  const cache=window.uiwin&&window.uiwin.cache;
  if(!cache||!old.cacheProject||!old.cacheRunId)throw aiRerunUnavailable('这单带的参考图找不到了');
  const types={png:'image/png',jpg:'image/jpeg',webp:'image/webp'},assets=[];
  for(let n=1;n<=count;n++){
    let found=null;
    for(const ext of ['png','jpg','webp']){
      let bytes=null;
      try{bytes=await cache.readFile(old.cacheProject,old.cacheRunId,'ref_'+n+'.'+ext);}catch(_){bytes=null;}
      if(bytes&&bytes.length){found={full:new Blob([bytes],{type:types[ext]}),mime:types[ext],name:'ref_'+n+'.'+ext};break;}
    }
    if(!found)throw aiRerunUnavailable('这单带的第 '+n+' 张参考图在缓存里找不到了');
    assets.push(found);
  }
  return assets;
}
async function aiRerunRecipeFromCache(old){
  const workflow=taskWasWorkflow(old);
  const preset=workflow&&window.PRESETS?PRESETS.presetById(old.workflowPresetId):null;
  if(workflow&&!(preset&&(preset.workflow||preset.forgeWorkflow)))throw aiRerunUnavailable('这单用的工作流预设已经不在预设库里了');
  const qwen=String(old.connectionSlot||'')==='qwen';
  const config={
    provider:old.provider,connectionSlot:old.connectionSlot,protocol:old.protocol,
    model:old.model,size:old.size,aspectRatio:old.aspectRatio,batch:old.batch,prompt:old.prompt,antiMode:Number(old.antiMode)||0,
    presetTitle:old.presetTitle||'',presetId:old.presetId||'',presetVersion:old.presetVersion||'',
    workflowPreset:workflow?aiClonePlain(preset):null,
    workflowParameters:aiClonePlain(old.workflowParameters||{}),workflowPresetId:String(old.workflowPresetId||''),
    // 算力来源：原单记下的那个（工作流记的是工作流那边的、普通生图记的是生图那边的；千问单记的是千问的，生图那边就按现在的设置）
    workflowSource:workflow&&old.computeSource?old.computeSource:settingsRuntime.workflowSource,
    imageComputeSource:!workflow&&!qwen&&old.computeSource?old.computeSource:settingsRuntime.imageComputeSource,
    preserveGeneratedAppearance:old.preserveGeneratedAppearance===true,colorToolRunId:String(old.colorToolRunId||''),
    refImages:[]
  };
  const count=Number(old.referenceCount)||0;
  if(count)config.referenceAssets=await aiRerunReadReferences(old,count);
  return {config,autoReturn:settingsRuntime.autoReturn===true};
}
// 把原卡收起：跟手点 ✕ 一样。⚠ 等这张卡手上那次落盘写完再写「不在任务栏」——
//   刚失败那一刻它正在存缓存（那次写的是「在任务栏」），先写的会被后写的盖掉，重启后它又冒出来。
function aiRetireTask(old){
  removeTask(old.id);
  (async()=>{
    for(let i=0;i<100&&old._cacheWriting;i++)await new Promise(resolve=>setTimeout(resolve,100));
    await cacheSetTaskbar(old,false);
    if(typeof broadcastRecordsChanged==='function')broadcastRecordsChanged();
  })().catch(()=>{});
}
async function aiRerunFailedTask(old){
  if(!taskRerunEligible(old))return null;
  updateTask(old.id,{_rerunning:true});                 // 按钮先收起来，防连点
  let rerun,captureSnapshot;
  try{
    rerun=old._rerun?{config:Object.assign({},old._rerun.config),autoReturn:old._rerun.autoReturn}:await aiRerunRecipeFromCache(old);
    captureSnapshot=await aiRerunCapture(old);
  }catch(error){
    updateTask(old.id,{_rerunning:false});
    if(window.ERR)ERR.report(error.code||'TASK_RERUN_UNAVAILABLE',{message:String(error.message||error),taskId:String(old.taskId||'')});
    return null;
  }
  // 读原图那一会儿里用户把原卡 ✕ 掉了 ⇒ 不跑
  if(taskList.indexOf(old)<0)return null;
  const config=Object.assign(rerun.config,aiRerunConnection(rerun.config));
  // 参考图（Blob）原样再发；换一个新数组，跟原单那次的参考图闸门脱钩
  if(Array.isArray(config.referenceAssets))config.referenceAssets=Array.from(config.referenceAssets);
  const taskId=aiNewTaskId('ai');
  Object.assign(config,{taskId,captureSnapshot,capture:null});
  aiSessionSecrets.set(taskId,String(config.apiKey||''));
  aiMarkActive(taskId,'generate');
  const task=addTask(makeGenerationTask(aiPayload(config)));
  // 记账通道按原单的（makeGenerationTask 读的是现在全局那个连接）；改走千问的单它自己写了 qwen，不动
  if(task.connectionSlot!=='qwen'&&config.connectionSlot&&String(config.connectionSlot)!=='qwen')task.connectionSlot=String(config.connectionSlot);
  if(typeof historyRecordTask==='function')historyRecordTask(task);
  updateGenerationTask(taskId,{status:'running',sub:'重跑 · 原图和原来的参数'});
  aiRetireTask(old);
  aiRefreshInPlace();
  return aiGenerateNow(config,{autoReturn:rerun.autoReturn}).catch(error=>{
    aiMarkInactive(taskId);
    updateGenerationTask(taskId,{status:'failed',stage:'submit',errorCode:error&&error.code||'AI_TASK_FAILED',error:String(error&&error.message||error)});
    return {ok:false,taskId,error:String(error&&error.message||error)};
  });
}
function aiBeginImmediate(opts){
   // Date.now() 可能在连续点击时相同，必须加进程内序号，保证每个点击都是独立任务。
   const taskId=aiNewTaskId('ai');
  aiSessionSecrets.set(taskId,String(aiRuntime.apiKey||''));
  // 立即创建占位任务卡，但每次运行都必须重新读取当前 Photoshop 文档/选区；
  // 不能因为 antiMode 相同就复用上一次 capture。
   // 点击瞬间复制整套表单参数；后续用户改提示词/模型不会改写已经开始的任务。
  const referenceSnapshot=window.V7PresetReferences?V7PresetReferences.capture():null;
  if(referenceSnapshot)referenceSnapshot.catch(()=>{});
  const requestConfig=Object.assign({},aiRuntime,aiWorkflowSnapshot(),{taskId,
      // ⭐ 预设名在这一刻【现取】，取完就跟着这个任务走（见 presetTitleNow 那段注释）。
      //   不能用 aiRuntime.presetTitle —— 那份镜像重启后是空的。
      presetTitle:presetTitleNow(),
      captureSnapshot:null,capture:null,
      // 参考图是数组/对象，不能只做浅拷贝；否则用户修改表单时会改写已启动任务。
      refImages:aiClonePlain(aiRuntime.refImages||[])});
   // 历史中心只记录可复用的提示词和参数，不记录 API Key、图片正文或 PSD 内容。
   const initial=aiPayload(requestConfig);
   aiRuntime.currentTaskId=taskId;
   // 不清空全局最近抓取图：并发任务各自使用 requestConfig/captureSnapshot，
   // 同时允许用户继续把已有抓取图加入队列；完整链路不会因此复用旧图。
   aiMarkActive(taskId,'capture');
  addTask(makeGenerationTask(initial));
  if(window.PRESETUI&&PRESETUI.recordFieldHistory&&requestConfig.fieldHistorySnapshot)PRESETUI.recordFieldHistory(requestConfig.fieldHistorySnapshot);
  if(typeof historyRecordTask==='function') historyRecordTask(taskList.find(t=>t.taskId===taskId));
  updateGenerationTask(taskId,{status:'running',sub:'已接收 · 检查参数'});
  aiRuntime.status='已接收，正在检查参数';
  aiRuntime.progress=0;
  aiAddLog('已接收生成请求 · 等待 Photoshop 图片','info');
  aiRefreshInPlace();
   // alreadyReported=true 表示上游已经弹过更详细的报错卡了(带 Photoshop 现场那种)，
   // 这里只更新任务状态，不再弹第二张 —— 同一件事弹两张卡比不弹更让人糊涂。
   const failImmediate=(message,stage,code,alreadyReported)=>{
      aiMarkInactive(taskId);
     updateGenerationTask(taskId,{status:'failed',stage,errorCode:code,error:message,pct:0,
       _errorReported:!!alreadyReported});
     if(String(aiRuntime.currentTaskId||'')===String(taskId))aiRuntime.status=message;
     aiRefreshInPlace();
   };
  const immediateWorkflow=!!(window.V7Workflows&&V7Workflows.isWorkflow(initial));
  // ⭐ 2026-10-16 审计查实（docs/226 那个「千问模式点生成报请先填写 API URL」的真凶）：
  //   这道检查在【改走千问之前】，原来只认工作流预设 ⇒ 千问模式下没配 aji 的人直接被拦；
  //   用户线索「填了 aji key 之后 qwen 能走通」就是因为填了 key 这道就过了。改走千问的单不查 Banana 的地址。
  if(!immediateWorkflow&&!aiWillQwen(initial)&&!aiRuntime.baseUrl&&!aiRuntime.endpoint){ failImmediate('还没配生图服务：到设置卡「用哪家生图」填好地址和 API Key','validate','AI_URL_MISSING'); return; }
  if(!immediateWorkflow&&(!aiRuntime.prompt||!String(aiRuntime.prompt).trim())){ failImmediate('请先填写提示词','validate','AI_PROMPT_MISSING'); return; }
  updateGenerationTask(taskId,{sub:'参数有效 · 等待 Photoshop 图片'});
  aiRuntime.status='参数有效，正在从 Photoshop 抓取';
  aiRefreshInPlace();
   const mode=Number(aiRuntime.antiMode)||0;
   const allowFullCanvas=!!aiRuntime.autoFullCanvas;
  // “运行生成/完整链路”是一次新的来源采集，不复用旧 capture。
  // 这样从 A 项目切到 B 项目后，B 的文档/选区才会成为本次任务的固定来源。
  const run=data=>{
      const live=taskById(taskId);
      if(live&&live.cancelRequested){
        aiMarkInactive(taskId);
        return;
      }
      const snapshot=aiCaptureSnapshot(data,mode);
      aiMarkActive(taskId,'generate');
    updateGenerationTask(taskId,{captureSnapshot:snapshot,sourceDocId:snapshot&&snapshot.docId,sourceDocName:snapshot&&snapshot.docName,sourceSelection:snapshot&&snapshot.selection,sourceImageBase64:snapshot&&snapshot.sourceImageBase64,inputImageBase64:snapshot&&snapshot.inputImageBase64});
      return aiGenerateNow(Object.assign({},requestConfig,{taskId,captureSnapshot:snapshot,capture:null,antiMode:mode}),opts);
  };
   // 预设声明的前置动作必须在抓图前完成。失败时任务停在准备阶段，不继续扣费或提交。
   const preActionPreset=requestConfig.preActionPreset||requestConfig.workflowPreset;
   const preparePreAction=async()=>{
     if(!preActionPreset||!window.V7PresetPreActions||typeof V7PresetPreActions.beforeGenerate!=='function')return;
     try{await V7PresetPreActions.beforeGenerate(preActionPreset,null);}
     catch(error){failImmediate('预设前置动作未完成：'+String(error&&error.message||error),'prepare',error&&error.code||'PREACTION_VERIFY_FAILED',false);throw error;}
   };
   const startCapture=()=>{
     const live=taskById(taskId); if(!live||live.cancelRequested)return;
     aiCapture(run,mode,result=>{
     // ⚠ 第四个参数 true：aiCapture 的 afterError 已经用 ERR.fromLinkResult 弹过卡了，
     //   那张卡带着 Photoshop 现场，比这里能给的信息多。别再弹一张。
     failImmediate('抓取失败：'+linkResultMessage(result),'capture','PS_CAPTURE_FAILED',true);
     },{ownerTaskId:taskId,allowFullCanvas});
   };
   // 普通预设没有前置动作时保持原有同步入队语义；有前置动作才等待 Photoshop 回执。
   if(referenceSnapshot) referenceSnapshot.then(refs=>{requestConfig.refImages=[];requestConfig.referenceAssets=refs;return preparePreAction();}).then(startCapture).catch(error=>{
     const task=taskById(taskId);if(task&&task.status==='failed')return;
     V7PresetReferences.report(error);failImmediate(String(error.message||error),'prepare',error.code||'PRESET_REFERENCE_FAILED',true);
   });
   else if(preActionPreset&&window.V7PresetPreActions) Promise.resolve().then(preparePreAction).then(startCapture).catch(()=>{});
   else startCapture();
}
