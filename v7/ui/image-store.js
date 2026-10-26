// ═══ 图片管家 —— 全项目唯一的图片出入口 ═══
//
// 规矩见 docs/21_性能开销优化守则.md。一句话：
//   界面上只准挂缩略图，原图存 Blob 不存 base64 字符串，谁创建谁释放。
//
// 为什么非要有这个东西(2026-09-08 实测账)：
//   一张 4K 图的 base64 字符串，JS 里按 UTF-16 存 = 21MB；
//   解码成位图 = 67MB(跟你显示多大没关系)；
//   之前一张图被留了 2~4 份字符串 + 进 DOM 又两份 → 单张约 235MB(抗截断开着时)。
//   8 张就是 1.9GB。界面卡的不是算法，是内存。
//
// ⚠ 最重要的一条：**原图那份一个字节都不许动。**
//   传回进 Photoshop 用的就是它。压缩只产生"另外一张"缩略图，
//   绝不能拿压缩结果去顶替原图 —— 否则贴进 PS 的画质被悄悄糟蹋，用户还发现不了。
(function(){
  'use strict';

  // 缩略图长边。为什么是 512 不是 256：
  //   预览格子 88px，悬停放大 1.32 倍 = 116px，2 倍屏 = 232px；
  //   任务卡背景 300px 宽，2 倍屏 = 600px。
  //   512 兜得住绝大多数，再大就是白给(512 解码后才 1MB)。
  const THUMB_EDGE = 512;
  const THUMB_QUALITY = 0.78;

  const store = new Map();   // id -> { fullBlob, fullUrl, thumbBlob, thumbUrl, mime, w, h }
  let seq = 0;

  // ⭐⭐ 2026-10-16（用户报「点开工具的一瞬间整个面板假死」，现场：面板渲染进程 3.9 GB、一个核 100%）：
  //   原图【只进不出】—— 旧任务的原图按需从磁盘读进来后一直留着；新生成的图写进缓存后也一直留着。
  //   开几个小时、生成几十上百张，就把面板撑到 JS 堆上限（4 GB），浏览器反复清垃圾、整个界面卡死。
  //   （刚重开软件用一小会儿实测就有 78 张 / 300 MB。）
  //   ⇒ 有磁盘副本（fullLoader）的原图按「最近用过」排，内存里原图总量超过预算就放掉最久没用的
  //     （⚠ objectURL 一起撤销，只删引用不还内存，见记忆「淘汰缓存必须真撤销 blob」），下次要用 ensureFull 自己从磁盘读回来。
  //   ⚠ 不放的：没有磁盘副本的（放了就找不回来）、正在从磁盘读的、最近 15 秒用过的（地址可能刚交出去还没加载完）。
  let FULL_BUDGET = 768 * 1024 * 1024;
  let PROTECT_MS = 15000;
  let clock = 0;
  function touch(rec){ rec.lastUsed = ++clock; rec.usedAt = Date.now(); }
  function trimFull(keep){
    let total = 0;
    const candidates = [];
    store.forEach(function(rec){
      if (!rec.fullBlob) return;
      total += rec.fullBlob.size;
      if (rec.fullLoader && !rec.fullPromise && rec !== keep && Date.now() - (rec.usedAt || 0) >= PROTECT_MS) candidates.push(rec);
    });
    if (total <= FULL_BUDGET) return 0;
    candidates.sort(function(a, b){ return (a.lastUsed || 0) - (b.lastUsed || 0); });
    let freed = 0;
    for (const rec of candidates) {
      if (total <= FULL_BUDGET) break;
      total -= rec.fullBlob.size;
      if (rec.fullUrl) { URL.revokeObjectURL(rec.fullUrl); rec.fullUrl = null; }
      rec.fullBlob = null;
      freed += 1;
    }
    return freed;
  }
  // 结果写进缓存以后补上「能从磁盘重读」的口子，它才能在内存紧的时候被放掉（ui.html 写缓存那段调）
  function attachLoader(id, loader){
    const rec = store.get(String(id||''));
    if (!rec || rec.released || typeof loader !== 'function') return false;
    if (!rec.fullLoader) rec.fullLoader = loader;
    trimFull();
    return true;
  }
  // 测试 / 诊断用：改预算和保护时间
  function setFullBudget(bytes, options){
    if (Number.isFinite(bytes) && bytes >= 0) FULL_BUDGET = bytes;
    if (options && Number.isFinite(options.protectMs) && options.protectMs >= 0) PROTECT_MS = options.protectMs;
    return { budget: FULL_BUDGET, protectMs: PROTECT_MS };
  }

  function nextId(){ seq += 1; return 'img_' + seq; }

  // ── base64 → Blob ──
  // 用 fetch 解 data URL：浏览器原生处理，不用在 JS 里过一遍 atob 二进制字符串。
  // 拼出来的 data URL 字符串是一次性的，转完就丢，不留在任何地方。
  function base64ToBlob(b64, mime){
    const type = mime || 'image/png';
    const url = String(b64||'').indexOf('data:')===0 ? String(b64) : ('data:'+type+';base64,'+b64);
    return fetch(url).then(r=>r.blob());
  }

  function blobToBase64(blob){
    return new Promise((resolve,reject)=>{
      const fr = new FileReader();
      fr.onload = ()=>{
        const s = String(fr.result||'');
        const comma = s.indexOf(',');
        // 传回统一给裸 base64。UXP 桥的 cleanBase64 按第一个逗号切，
        // 裸 base64 里不会出现逗号，所以两种形式它都吃 —— 给裸的最省。
        resolve(comma>=0 ? s.slice(comma+1) : s);
      };
      fr.onerror = ()=>reject(new Error('图片转 base64 失败'));
      fr.readAsDataURL(blob);
    });
  }

  // ── 从任意可绘制的源缩出缩略图 ──
  // source 可以是 canvas / ImageBitmap / HTMLImageElement
  function makeThumbBlob(source, w, h){
    const scale = Math.min(1, THUMB_EDGE / Math.max(w||1, h||1));
    const tw = Math.max(1, Math.round((w||1) * scale));
    const th = Math.max(1, Math.round((h||1) * scale));
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, tw, th);
    return new Promise(resolve=>{
      // 缩略图用 JPEG：只用来看，不用来传回，有损无所谓，体积小一个数量级。
      cv.toBlob(b=>resolve(b), 'image/jpeg', THUMB_QUALITY);
    });
  }

  function register(fullBlob, thumbBlob, mime, w, h){
    const registered = registerRecord(fullBlob, thumbBlob, mime, w, h);
    const rec = store.get(registered);
    if (rec) { touch(rec); trimFull(rec); }
    return registered;
  }
  function registerRecord(fullBlob, thumbBlob, mime, w, h){
    const id = nextId();
    const rec = {
      fullBlob: fullBlob,
      fullUrl: null,                 // 懒创建：没人看大图就不占地址
      thumbBlob: thumbBlob || null,
      thumbUrl: thumbBlob ? URL.createObjectURL(thumbBlob) : null,
      mime: mime || 'image/png',
      w: w||0, h: h||0
    };
    store.set(id, rec);
    return id;
  }

  // ── 入口一：从画布收图(抗截断还原后走这条) ──
  // ⚠ 原图用 PNG 无损导出，和原来的 toDataURL('image/png') 像素完全一致。
  //   缩略图直接从同一张画布缩，不用再解码一次 —— 白捡的性能。
  function putFromCanvas(canvas, mime){
    const w = canvas.width, h = canvas.height;
    return new Promise((resolve,reject)=>{
      canvas.toBlob(fullBlob=>{
        if(!fullBlob){ reject(new Error('图片导出失败')); return; }
        makeThumbBlob(canvas, w, h)
          .then(thumb=>resolve(register(fullBlob, thumb, 'image/png', w, h)))
          // 缩略图失败时仍保留原图供传回，但列表必须显示占位，
          // 绝不能把大图挂到缩略图 <img> 上。
          .catch(()=>resolve(register(fullBlob, null, 'image/png', w, h)));
      }, 'image/png');
    });
  }

  // ── 入口二：从 base64 收图(抗截断关、参考图、抓取图走这条) ──
  // ⚠ 原图【不重新编码】，原始字节原样包成 Blob。
  //   重新编码 = 画质被动，传回进 PS 就废了。
  function putFromBase64(b64, mime){
    if(!b64) return Promise.reject(new Error('空图片数据'));
    const type = mime || 'image/png';
    return base64ToBlob(b64, type).then(fullBlob=>{
      return createImageBitmap(fullBlob)
        .then(bmp=>{
          const w = bmp.width, h = bmp.height;
          return makeThumbBlob(bmp, w, h)
            .then(thumb=>register(fullBlob, thumb, type, w, h))
            .catch(()=>register(fullBlob, null, type, w, h))
            .finally(()=>{ if(bmp.close) bmp.close(); });
        })
        .catch(()=>register(fullBlob, null, type, 0, 0));
    });
  }

  // ── 入口三：从磁盘缓存恢复(重启后走这条) ──
  // ⚠ 缩略图【直接用磁盘上那张】，不从原图重新缩 ——
  //   重新缩就要把每张 4K 原图解码一遍，启动会卡好几秒(docs/21 铁律 1 的精神)。
  // ⚠ 原图这里【不加载】，只记住怎么取。看大图或传回时才按需拉，
  //   否则一开机就把几百 MB 原图全读进内存，等于什么都没优化。
  function putFromCache(thumbBytes, mime, loadFull){
    const type = mime || 'image/png';
    const thumbBlob = new Blob([thumbBytes], { type: 'image/jpeg' });
    const id = nextId();
    store.set(id, {
      fullBlob: null,
      fullLoader: loadFull,          // () => Promise<Uint8Array>
      fullUrl: null,
      thumbBlob: thumbBlob,
      thumbUrl: URL.createObjectURL(thumbBlob),
      mime: type,
      w: 0, h: 0
    });
    return id;
  }

  // 按需把原图从磁盘拉进来。已经在内存里就直接返回。
  function releasedError(){ return Object.assign(new Error('图片已释放'), { code:'IMAGE_RELEASED' }); }
  function assertLive(rec){
    if(rec.released) throw releasedError();
  }
  function ensureFull(rec){
    if(rec.released) return Promise.reject(releasedError());
    if (rec.fullBlob) { touch(rec); return Promise.resolve(rec.fullBlob); }
    if (rec.fullPromise) return rec.fullPromise;
    if (!rec.fullLoader) return Promise.reject(new Error('原图不可用'));
    const loader=rec.fullLoader;
    // Viewing/exporting the same cached image may overlap. Share the pending
    // disk read; release invalidates it before it can retain bytes or a URL.
    rec.fullPromise=Promise.resolve().then(function(){ assertLive(rec); return loader(); }).then(function(bytes){
      assertLive(rec);
      if (!bytes || !bytes.length) throw new Error('原图读取失败');
      rec.fullBlob = new Blob([bytes], { type: rec.mime });
      touch(rec);
      trimFull(rec);
      return rec.fullBlob;
    }).finally(function(){ rec.fullPromise=null; });
    return rec.fullPromise;
  }

  function get(id){ return store.get(String(id||'')) || null; }

  // 缩略图地址：界面上所有 <img src> 都只准用这个。
  function thumb(id){
    const rec = get(id);
    if(!rec) return '';
    // 没有缩略图时返回空地址，让调用方显示占位或重试；原图只允许
    // 通过 fullUrl/fullBytes 主动请求，避免列表在失败路径解码大图。
    return rec.thumbUrl || '';
  }

  // 原图地址。只给大图/导出用，绝不能挂进列表。
  function fullUrl(id){
    const rec = get(id);
    if(!rec) return Promise.reject(new Error('图片不存在'));
    return ensureFull(rec).then(function(){
      assertLive(rec);
      if(!rec.fullUrl) rec.fullUrl = URL.createObjectURL(rec.fullBlob);
      return rec.fullUrl;
    });
  }

  // 原图二进制。跨窗口传大图用这个，不传 base64
  // (传 base64 等于在另一个进程里再复制一整份 21MB 字符串)。
  function fullBytes(id){
    const rec = get(id);
    if(!rec) return Promise.reject(new Error('图片不存在'));
    return ensureFull(rec).then(function(blob){ assertLive(rec); return blob.arrayBuffer(); })
      .then(function(bytes){ assertLive(rec); return bytes; });
  }

  // 原图 base64。只在真正要传回 Photoshop 的那一刻才调，用完即弃，不留存。
  function base64(id){
    const rec = get(id);
    if(!rec) return Promise.reject(new Error('图片不存在'));
    return ensureFull(rec).then(function(blob){ assertLive(rec); return blobToBase64(blob); })
      .then(function(value){ assertLive(rec); return value; });
  }

  function size(id){ const rec=get(id); return rec?{w:rec.w,h:rec.h}:{w:0,h:0}; }
  function byteSizes(id){ const rec=get(id); return { fullBytes:rec&&rec.fullBlob?rec.fullBlob.size:0, thumbBytes:rec&&rec.thumbBlob?rec.thumbBlob.size:0 }; }
  function has(id){ return store.has(String(id||'')); }

  // ── 释放 ──
  // ⚠ 不释放的 Blob 会一直占着，而且比 base64 更难发现(不在 JS 堆里)。
  //   任务删除、清空结果时必须调。
  function release(id){
    const key = String(id||'');
    const rec = store.get(key);
    if(!rec) return;
    rec.released=true;
    if(rec.fullUrl) URL.revokeObjectURL(rec.fullUrl);
    if(rec.thumbUrl) URL.revokeObjectURL(rec.thumbUrl);
    rec.fullUrl=null;rec.thumbUrl=null;rec.fullBlob=null;rec.thumbBlob=null;rec.fullLoader=null;
    store.delete(key);
  }
  function releaseMany(ids){ (ids||[]).forEach(release); }

  function stats(){
    let full=0, thumb=0, inMemory=0, evictable=0;
    store.forEach(r=>{ full += (r.fullBlob&&r.fullBlob.size)||0; thumb += (r.thumbBlob&&r.thumbBlob.size)||0; if(r.fullBlob){inMemory++; if(r.fullLoader)evictable++;} });
    return { count:store.size, fullBytes:full, thumbBytes:thumb, fullInMemory:inMemory, evictable, budget:FULL_BUDGET };
  }

  // 缩略图/原图的二进制。写缓存时用，不经过 base64。
  function thumbBytes(id){
    const rec = get(id);
    if(!rec || !rec.thumbBlob) return Promise.reject(new Error('缩略图不存在'));
    return rec.thumbBlob.arrayBuffer();
  }

  // Workers already encode the original PNG and a separate JPEG thumbnail.
  // Register those blobs without decoding a full resolution image on the UI thread.
  function putEncoded(fullBlob, thumbBlob, width, height){
    if(!(fullBlob instanceof Blob)||!fullBlob.size||!(thumbBlob instanceof Blob)||!thumbBlob.size)
      throw new Error('图片或缩略图数据无效');
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)
      throw new Error('图片尺寸无效');
    return register(fullBlob,thumbBlob,fullBlob.type||'image/png',width,height);
  }

  // ⭐ 2026-10-17 夜：用一张图的原图字节现做一张缩略图（JPEG 字节），给 putFromCache 用。
  //   起因（用户：「在任务卡片里面点击切换校色之后，任务卡片的预览图没有实时的变化」）：
  //   切校色版本时从磁盘拿回某一版，以前缩略图直接借【当前那张】的 —— 于是切了版本小图和大预览都不变。
  //   ⚠ 只解码一次做缩略图，原图不留在内存里（还是按需从磁盘拉）。
  async function thumbFromBytes(bytes, mime){
    const blob = new Blob([bytes], { type: mime || 'image/png' });
    const bmp = await createImageBitmap(blob);
    try{
      const thumb = await makeThumbBlob(bmp, bmp.width, bmp.height);
      return thumb ? new Uint8Array(await thumb.arrayBuffer()) : null;
    }finally{ if(bmp.close) bmp.close(); }
  }

  window.IMG = {
    putFromCanvas, putFromBase64, putFromCache, putEncoded, thumbFromBytes,
    thumb, fullUrl, fullBytes, thumbBytes, base64,
    size, byteSizes, has, release, releaseMany, stats, attachLoader, setFullBudget,
    THUMB_EDGE
  };
})();
