// ============================================================
//  bg-manager.js — 统一卡片背景管理
//  每张卡一个 bgkey, 背景图存 localStorage(按 key)
//  提供 getBg / setBg / applyAll / 图库列表
//  在 ui.html 里 <script> 引入后, window.BG = ...
// ============================================================
(function(){
  // ═══ 存储层: IndexedDB + Blob ═══
  // ⚠ 为什么不用 localStorage(2026-09-10 改):
  //   ① localStorage 配额只有约 5MB
  //   ② 它只能存字符串 → 图片被迫转 base64 → 体积再涨 33%
  //   一套 X4 主题(23 个槽位)约 10MB，直接爆一倍。X2 约 3MB 也已经贴着上限。
  //   IndexedDB 配额几百 MB 起，而且【能直接存 Blob，没有 base64 膨胀】。
  //   这条同 docs/21 铁律 13: 原图存 Blob，不存 base64 字符串。
  const DB_STORE = 'bg', DB_VER = 1;
  // ⭐ 2026-10-21（用户定「主题跟电脑走」）：背景图和主题色改存【这台电脑】那份（不带账号）。
  //   原来跟账号存：登录过期掉回 anonymous（空的那一格）⇒ 背景全变回默认，用户以为丢了。
  //   旧的账号那份不删，第一次由真账号登录时整份接过来（adoptAccountTheme），之后只认本机这份。
  function storage(){ return window.WHEELCHAIR_STORAGE || null; }
  function machineScoped(){ const S = storage(); return !!(S && typeof S.localDbName === 'function'); }
  function dbName(){
    const S = storage();
    if (!S) return 'v8.theme';
    return machineScoped() ? S.localDbName('theme') : S.dbName('theme');
  }
  const THEME_KEY = 'v8.cardtheme';       // 主题色逻辑名
  function themeKey(){
    const S = storage();
    if (!S) return THEME_KEY;
    return typeof S.localKey === 'function' ? S.localKey(THEME_KEY) : S.key(THEME_KEY);
  }
  const cache = {};                        // key -> blob: 地址(短字符串, 给 CSS 用)
  const blobCache = {};                    // key -> Blob(原始字节, 跨窗口/导出时用)
  const themeCache = {};                   // 主题色内存缓存 {key: {h,s,l}|null}
  let dbPromise = null, ready = false;
  // Every asynchronous image/theme operation captures this epoch.  Storage
  // context changes invalidate work that was started for the previous
  // account, including compression and colour extraction callbacks.
  let storageEpoch = 0;
  function storageDbName(){ return dbName(); }
  function contextChangedError(){
    return Object.assign(new Error('账号已切换，已忽略旧主题写入'), { code:'BG_ACCOUNT_CHANGED' });
  }
  function operationValid(epoch, expectedDb){
    return epoch === storageEpoch && (!expectedDb || storageDbName() === expectedDb);
  }
  function assertOperation(epoch, expectedDb){ if(!operationValid(epoch, expectedDb)) throw contextChangedError(); }

  function openDb(){
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName(), DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打不开'));
    });
    return dbPromise;
  }
  function dbPut(key, blob, operation, expectedDb){
    return openDb().then(db => new Promise((resolve, reject) => {
      if(operation !== undefined && (!operationValid(operation, expectedDb) || (db.name && db.name !== expectedDb))) return reject(contextChangedError());
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(blob, key);
      tx.oncomplete = () => {
        try { if(operation !== undefined) assertOperation(operation, expectedDb); resolve(true); }
        catch(error){ reject(error); }
      };
      tx.onerror = () => reject(tx.error || new Error('写入失败'));
    }));
  }
  function dbDeleteAll(){
    return openDb().then(db => new Promise(resolve => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    }));
  }
  // 一次性把所有背景读进内存(建 blob 地址)。启动时调一次。
  function dbLoadAll(operation, expectedDb){
    return openDb().then(db => new Promise(resolve => {
      if(operation !== undefined && (!operationValid(operation, expectedDb) || (db.name && db.name !== expectedDb))) return resolve(null);
      const out = {};
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          if(operation !== undefined && !operationValid(operation, expectedDb)) return resolve(null);
          resolve(out); return;
        }
        out[cur.key] = cur.value;
        cur.continue();
      };
      req.onerror = () => resolve(out);
    })).catch(() => ({}));
  }
  // ── 搬家：账号那份 → 这台电脑这份（2026-10-21）──
  //   · 本机这份还没从【真账号】接过（没有标记）⇒ 账号那份有图就整份接过来、主题色一起接；打标记，只接这一次。
  //   · 开机先站在 anonymous 那一格（自动登录回来才是真账号）⇒ 这时只在本机还空着时临时接 anonymous 那份，不打标记。
  //   ⚠ 旧的账号那份原样留着（不删），真出问题还能找回。
  function adoptedKey(){ const S = storage(); return S.localKey('theme-from-account.v1'); }
  function openNamed(name){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VER);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打不开'));
    });
  }
  function readEntries(db){
    return new Promise(resolve => {
      const out = [], tx = db.transaction(DB_STORE, 'readonly'), req = tx.objectStore(DB_STORE).openCursor();
      req.onsuccess = () => { const cur = req.result; if (!cur) return resolve(out); out.push([cur.key, cur.value]); cur.continue(); };
      req.onerror = () => resolve(out);
    });
  }
  function replaceEntries(db, entries){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite'), store = tx.objectStore(DB_STORE);
      store.clear(); entries.forEach(([k, v]) => store.put(v, k));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('写入失败'));
    });
  }
  async function adoptAccountTheme(operation){
    if (!machineScoped() || !window.indexedDB) return;
    const S = storage();
    try { if (localStorage.getItem(adoptedKey()) === '1') return; } catch (_) { return; }
    const signedIn = typeof S.isSignedInContext === 'function' && S.isSignedInContext();
    const source = await openNamed(S.dbName('theme'));
    let entries;
    try { entries = await readEntries(source); } finally { try { source.close(); } catch (_) {} }
    if (!operationValid(operation)) return;
    const target = await openDb();
    if (!operationValid(operation)) return;
    const existing = signedIn ? null : await readEntries(target);
    let colors = null;
    try { colors = localStorage.getItem(S.key(THEME_KEY)); } catch (_) {}
    if (signedIn ? entries.length > 0 : (entries.length > 0 && existing.length === 0)) {
      await replaceEntries(target, entries);
      if (colors) try { localStorage.setItem(themeKey(), colors); } catch (_) {}
    } else if (signedIn && colors && !localStorage.getItem(themeKey())) {
      try { localStorage.setItem(themeKey(), colors); } catch (_) {}
    }
    if (signedIn && operationValid(operation)) try { localStorage.setItem(adoptedKey(), '1'); } catch (_) {}
  }

  // ⚠ 换图时旧的 blob 地址必须 revoke，否则一直占着内存(且不在 JS 堆里，很难发现)
  function setCacheBlob(key, blob){
    if (cache[key]) { try { URL.revokeObjectURL(cache[key]); } catch(_){} }
    blobCache[key] = blob || null;
    cache[key] = blob ? URL.createObjectURL(blob) : '';
  }
  function notifyBackgroundChange(){
    window.dispatchEvent(new Event('wheelchair:background-change'));
  }

  // ══ 按面板实际显示尺寸压缩 ══
  // 每级卡片的 CSS 显示尺寸(见 ui.html): 主卡/三级 300×400, 二级 200×88。
  // 存 2 倍图应付高 DPI 屏, 再大就是纯浪费(解码全尺寸位图还拖慢重绘)。
  // ══ 出图尺寸 ══
  // BASE 是各槽位的【CSS 显示尺寸】，实际存储 = BASE × scale。
  // scale 由用户在设置里选 1/2/4（清晰度）。默认 4 —— 改了 IndexedDB 之后装得下了。
  // ⚠ 主题包一律按 X4 出图，导入时按当前 scale 降采样，作者不用出多套。
  //   槽位清单和出图规范见 docs/24_主题开发规范.md。
  const BASE = {
    card:    { w: 300, h: 400 },   // 一级主卡
    detail:  { w: 300, h: 400 },   // 三级详情
    zone:    { w: 200, h:  88 },   // 二级选择框
    task:    { w: 572, h: 150 },   // 任务预览外框
    free:    { w: 300, h: 110 },   // 自由模式的任务/报错堆空位
    error:   { L1:{ w:300, h:50 }, L2:{ w:300, h:100 }, L3:{ w:300, h:100 }, L4:{ w:300, h:100 } }
  };
  let scale = 4;
  function setScale(v){ const n=Number(v); if([1,2,4].indexOf(n)>=0) scale=n; return scale; }
  function getScale(){ return scale; }

  // ⭐ 全局纯色底（2026-09-14）。设置 → 外观与交互 → 配色 → 卡片底色。
  // 空 = 不覆盖，每张卡回到自己的默认渐变。
  // ⚠ 只盖【没单独设过背景图】的卡 —— 见 applyToCard 里的优先级说明。
  let solidOverride = '';
  let solidGlow = '';          // 配套的光效色("H S% L%")，纯色时让边缘光也跟着统一
  function setSolid(color, glowHsl){
    solidOverride = String(color || '');
    solidGlow = String(glowHsl || '');
    applyAll();                // 立刻重刷所有卡，不用等下次切卡
  }

  // ⚠ key 用【点】分段(card.generation / zone.generation.results / error.L4)，
  //   不再用短横线 —— 见下方 slotKey 的说明。
  function targetFor(key){
    const parts = String(key).split('.');
    const kind = parts[0];
    const base = (kind === 'error')
      ? (BASE.error[parts[1]] || BASE.error.L2)
      : (BASE[kind] || BASE.card);
    return { w: Math.round(base.w * scale), h: Math.round(base.h * scale) };
  }

  const ERROR_DEFAULTS={
    L1:'linear-gradient(135deg, rgba(42,86,122,.96), rgba(22,31,47,.98))',
    L2:'linear-gradient(135deg, rgba(52,93,82,.96), rgba(22,34,39,.98))',
    L3:'linear-gradient(135deg, rgba(112,76,52,.96), rgba(38,29,28,.98))',
    L4:'linear-gradient(135deg, rgba(112,54,62,.98), rgba(39,22,28,.99))'
  };
  function normalizeErrorLevel(level){
    const lv=String(level||'L2').toUpperCase();
    return ERROR_DEFAULTS[lv] ? lv : 'L2';
  }
  // ═══ 槽位 key ═══
  // ⚠ 一律用【语义名】，绝不用序号。
  //   旧方案是 card-0 / zone-0-2，序号是卡片在 DOM 里的位置 ——
  //   2026-09-08 删掉四张占位主卡时整套错位，不得不写一次性迁移代码。
  //   主题包要能长期用，key 就必须跟增删卡片无关。加卡片时已有的 key 一个都不动。
  //   完整清单见 docs/24_主题开发规范.md。
  function slotKey(kind, card, zone){
    if (kind === 'card')   return 'card.' + card;
    if (kind === 'zone')   return 'zone.' + card + '.' + zone;
    if (kind === 'detail') return 'detail.' + card + '.' + zone;
    return String(kind);
  }
  function errorKey(level){ return 'error.'+normalizeErrorLevel(level); }
  function getErrorBg(level){ return getBg(errorKey(level)); }
  function setErrorBg(level, dataUrl){ setBg(errorKey(level), dataUrl); }
  function setErrorBgFromFile(level, file){ return setBgFromFile(errorKey(level), file); }
  function errorDefault(level){ return ERROR_DEFAULTS[normalizeErrorLevel(level)]; }
  // 给动态报错卡统一应用默认/自定义背景和光效主题色。
  function applyErrorToCard(el, level){
    if(!el) return;
    const lv=normalizeErrorLevel(level);
    const bg=getErrorBg(lv);
    const base='linear-gradient(180deg, rgba(10,13,20,.52), rgba(10,13,20,.28) 42%, rgba(10,13,20,.5)),';
    // Keep the image/gradient in the card background layer. The card content
    // must remain fully opaque when the UI background-opacity setting changes.
    el.style.setProperty('--card-bg-image', bg ? base+'url("'+bg+'")' : errorDefault(lv));
    el.style.backgroundImage='none';
    el.style.backgroundSize='cover';
    el.style.backgroundPosition='center';
    el.classList.toggle('has-bg', !!bg);
    const c=bg ? getThemeColor(errorKey(lv)) : null;
    const fallback={L1:[212,100,68],L2:[142,69,58],L3:[32,100,68],L4:[0,84,65]}[lv];
    const col=c || {h:fallback[0],s:fallback[1],l:fallback[2]};
    el.style.setProperty('--glow-hsl', col.h+' '+col.s+'% '+col.l+'%');
  }

  // ══ 从背景图反推主题色(给光效用) ══
  // 做法: 画到 32×32 小画布读像素 → 挑【最鲜艳】的色(不是平均色, 平均会得到灰泥色)
  //   → 转 HSL → 强制拉高饱和/亮度(保证在深色卡上够亮) → 只保留色相
  // ⚠ 兜底: 图是纯灰/黑白(饱和度太低)时提不出有意义的色相 → 返回 null, 调用方用该层默认色
  // ⚠ 不加层级色相偏移(用户定案): 颜色完全跟图走
  function pickThemeColor(imgOrCanvasSrc){
    try{
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(imgOrCanvasSrc, 0, 0, 32, 32);
      const data = cx.getImageData(0, 0, 32, 32).data;
      let best = null, bestScore = -1;
      for (let i = 0; i < data.length; i += 4){
        const r = data[i]/255, g = data[i+1]/255, b = data[i+2]/255;
        const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
        const l = (mx+mn)/2;
        if (mx === mn) continue;                       // 纯灰, 无色相
        const d = mx - mn;
        const s = l > .5 ? d/(2-mx-mn) : d/(mx+mn);
        // 评分: 饱和度为主, 亮度适中加分(太暗太亮都不适合当光效)
        const score = s * (1 - Math.abs(l - .55) * 1.2);
        if (score > bestScore){
          bestScore = score;
          let h;
          if (mx === r) h = ((g-b)/d + (g < b ? 6 : 0));
          else if (mx === g) h = (b-r)/d + 2;
          else h = (r-g)/d + 4;
          best = { h: Math.round(h*60), s, l };
        }
      }
      if (!best || best.s < 0.15) return null;         // 饱和太低 → 让调用方回落默认色
      // 归一化: 只保留色相, 饱和/亮度拉到"够亮"的档位, 保证光效在深色卡上看得见
      return { h: (best.h + 360) % 360, s: 78, l: 66 };
    }catch(_){ return null; }                          // canvas 被污染/解码失败等
  }

  // ── 平均亮度(0~1) —— 给"文字该用白还是黑"用 ──
  // 跟 pickThemeColor 同样 32×32 采样。感知亮度用 Rec.601 权重(人眼对绿最敏感)。
  // ⚠ 只看【上半部】: 任务卡的标题/按钮都在上面, 底部亮不亮无所谓。
  function meanLuminance(imgOrCanvasSrc){
    try{
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(imgOrCanvasSrc, 0, 0, 32, 32);
      const d = cx.getImageData(0, 0, 32, 16).data;   // 上半 32×16
      let sum = 0, cnt = 0;
      for (let i = 0; i < d.length; i += 4){
        if (d[i+3] < 40) continue;                       // 透明像素不算
        sum += (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) / 255;
        cnt++;
      }
      return cnt ? sum / cnt : null;
    }catch(_){ return null; }
  }
  function luminanceFromDataUrl(dataUrl){
    return new Promise(resolve => {
      if (!dataUrl) return resolve(null);
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => resolve(meanLuminance(img));
      img.src = dataUrl;
    });
  }

  // 从 dataURL 提主题色(异步, 因为要等图解码). 返回 Promise<{h,s,l}|null>
  function themeColorFromDataUrl(dataUrl){
    return new Promise(resolve => {
      if (!dataUrl) return resolve(null);
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => resolve(pickThemeColor(img));
      img.src = dataUrl;
    });
  }

  // 把 File 压成 Blob: 按 cover 规则裁切填满目标框, 转 JPEG
  // ⚠ 返回 Blob 不是 dataURL —— 存 IndexedDB 用二进制, 没有 base64 那 33% 的膨胀。
  // 返回 Promise<Blob>
  function compress(file, key){
    return new Promise((resolve, reject) => {
      const t = targetFor(key);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败(格式不支持?)')); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        try{
          const cv = document.createElement('canvas');
          cv.width = t.w; cv.height = t.h;
          const cx = cv.getContext('2d');
          cx.imageSmoothingEnabled = true;
          cx.imageSmoothingQuality = 'high';
          // cover: 按较大的缩放比铺满, 溢出的居中裁掉(和 CSS background-size:cover 一致)
          const k = Math.max(t.w / img.width, t.h / img.height);
          const dw = img.width * k, dh = img.height * k;
          cx.drawImage(img, (t.w - dw) / 2, (t.h - dh) / 2, dw, dh);
          // PNG 透明通道用不上(卡片背景本来压在遮罩下), JPEG 体积小得多
          cv.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), 'image/jpeg', 0.82);
        }catch(e){ reject(e); }
      };
      img.src = url;
    });
  }

  // ── 存一张卡的背景: 压缩后写入 + 顺手提主题色(给光效用)。返回 Promise<{ok, bytes, err}> ──
  // ⚠ 提色在"存图时算一次"就缓存, 不要每次弹光效时算(浪费)。
  function setBgFromFile(key, file){
    if (!key || !file) return Promise.resolve({ ok:false, err:'缺少 key 或文件' });
    const operation = storageEpoch, expectedDb = storageDbName();
    return compress(file, key).then(blob => {
      assertOperation(operation, expectedDb);
      setCacheBlob(key, blob);
      applyToCard(key);
      notifyBackgroundChange();
      // 异步提色 → 存进 themeCache, 完成后重新应用(光效颜色跟着更新)
       themeColorFromDataUrl(cache[key]).then(col => {
         if(!operationValid(operation, expectedDb)) return;
         themeCache[key] = col;                 // 可能是 null(纯灰图) → 调用方回落默认色
         persistTheme();
         applyToCard(key);
       });
       return dbPut(key, blob, operation, expectedDb)
         .then(() => ({ ok:true, bytes: blob.size, err:null }))
        // ⚠ 别静默: 写盘失败时内存里有图、界面正常, 重启全没了, 且毫无提示。
        .catch(e => { console.error('[BG] 背景写入 IndexedDB 失败:', e); if(window.ERR) ERR.report('BG_SAVE_FAILED',{message:String(e&&e.message||e)});
                      return { ok:false, bytes:blob.size, err:'保存失败: '+e.message }; });
    }).catch(e => {
      if(e && e.code === 'BG_ACCOUNT_CHANGED') return { ok:false, stale:true, err:e.message };
      return { ok:false, err: e.message };
    });
  }

  // ── 主题色缓存(跟背景图分开存, 体积很小) ──
  function loadThemes(){
    try { return JSON.parse(localStorage.getItem(themeKey())) || {}; }
    catch(_){ return {}; }
  }
  function persistTheme(){
    try { localStorage.setItem(themeKey(), JSON.stringify(themeCache)); return true; }
    catch(e){ console.error('[BG] 主题色保存失败:', e.name); return false; }
  }
  // 取某张卡的主题色。无背景图/提不出色 → 返回 null(调用方用该层默认色)
  function getThemeColor(key){
    if (!key) return null;
    if (!cache[key] && cache[legacyFallback(key)]) key = legacyFallback(key);
    if (themeCache[key] !== undefined) return themeCache[key];
    const all = loadThemes();
    Object.keys(all).forEach(k => { themeCache[k] = all[k]; });
    return themeCache[key] || null;
  }
  // 转成 CSS 用的 hsl 字符串(带透明度)
  function themeCss(key, alpha){
    const c = getThemeColor(key);
    if (!c) return null;
    const a = (alpha === undefined) ? 1 : alpha;
    return 'hsla(' + c.h + ',' + c.s + '%,' + c.l + '%,' + a + ')';
  }

  // ── 已用空间统计(给 UI 显示) ──
  // ⚠ 现在统计的是 Blob 的真实字节, 不再是 base64 字符串长度(那个虚高 33%)
  function usage(){
    let bytes = 0, count = 0;
    Object.keys(blobCache).forEach(k => { if (blobCache[k]) { bytes += blobCache[k].size; count++; } });
    return { count, bytes, kb: Math.round(bytes / 1024) };
  }

  // ── 读取某张卡的背景 ──
  // ⚠ 返回的是 blob: 地址(短字符串), 不是 dataURL。CSS 里照用不误。
  //   ⚠ blob 地址【只在本窗口有效】, 跨窗口(L4)要用下面的 getBgDataUrl。
  function getBg(key){
    if (!key) return '';
    return cache[key] || cache[legacyFallback(key)] || '';
  }

  // The engines card became one panel. Its old primary theme remains the
  // fallback until the user explicitly supplies artwork for the new panel.
  function legacyFallback(key){
    return key==='zone.engines.all'?'zone.engines.engine':key==='detail.engines.all'?'detail.engines.engine':'';
  }

  // ── 跨窗口用的 dataURL(只给 L4 这种独立窗口) ──
  // ⚠ blob 地址是绑当前文档的, 传给另一个窗口用不了(那边解析不出来)。
  //   L4 是独立窗口, 只能传 dataURL。返回 Promise<string>。
  function getBgDataUrl(key){
    const blob = blobCache[key] || blobCache[legacyFallback(key)];
    if (!blob) return Promise.resolve('');
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  }
  function getErrorBgDataUrl(level){ return getBgDataUrl(errorKey(level)); }

  // ── 设置某张卡的背景(直接给 Blob) ──
  function setBg(key, blob){
    if (!key) return Promise.resolve(false);
    const operation = storageEpoch, expectedDb = storageDbName();
    if (!blob) {                                  // 传空 = 清掉这一张
      setCacheBlob(key, null);
      applyToCard(key);
      notifyBackgroundChange();
      return openDb().then(db => new Promise(resolve => {
        if(!operationValid(operation, expectedDb) || (db.name && db.name !== expectedDb)) return resolve(false);
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = () => resolve(operationValid(operation, expectedDb));
        tx.onerror = () => resolve(false);
      })).catch(() => false);
    }
    setCacheBlob(key, blob);
    applyToCard(key);
    notifyBackgroundChange();
    return dbPut(key, blob, operation, expectedDb).then(() => true).catch(() => false);
  }

  // ── 默认渐变调色板: 每个卡片不同, 按 key 稳定映射 ──
  // key 形如 card-0 / zone-0-0 / detail, 用其中的数字序号稳定选色
  const DEFAULT_GRADS = [
    'linear-gradient(150deg,#3b5f8f 0%,#22375a 55%,#1a2740 100%)',  // 蓝
    'linear-gradient(150deg,#8f5f3b 0%,#5a3b22 55%,#402a1a 100%)',  // 橙
    'linear-gradient(150deg,#3b8f5f 0%,#225a3b 55%,#1a402a 100%)',  // 绿
    'linear-gradient(150deg,#6f3b8f 0%,#48225a 55%,#321a40 100%)',  // 紫
    'linear-gradient(150deg,#8f3b5f 0%,#5a2248 55%,#401a32 100%)',  // 玫红
    'linear-gradient(150deg,#3b7a8f 0%,#224a5a 55%,#1a3440 100%)',  // 青
    'linear-gradient(150deg,#8f8f3b 0%,#5a5a22 55%,#40401a 100%)',  // 橄榄
    'linear-gradient(150deg,#5f3b8f 0%,#3b225a 55%,#2a1a40 100%)',  // 紫蓝
    'linear-gradient(150deg,#3b8f8f 0%,#225a5a 55%,#1a4040 100%)',  // 蓝绿
    'linear-gradient(150deg,#8f6f3b 0%,#5a4822 55%,#40371a 100%)',  // 棕金
    'linear-gradient(150deg,#5f8f3b 0%,#3b5a22 55%,#2a401a 100%)',  // 青绿
    'linear-gradient(150deg,#8f3b3b 0%,#5a2222 55%,#401a1a 100%)',  // 红
    'linear-gradient(150deg,#3b5f8f 0%,#22375a 55%,#1a2740 100%)',  // 回环
  ];
  // 备用: 简易 HSL→CSS 渐变(给每张卡生成稳定、可区分的颜色)
  function hslGrad(h, s, l1, l2){
    return `linear-gradient(150deg, hsl(${h},${s}%,${l1}%) 0%, hsl(${h+20},${s}%,${l2}%) 55%, hsl(${h+40},${s}%,${Math.max(10,l2-8)}%) 100%)`;
  }
  // ── 按 key 算出该卡的 HSL(默认渐变的色相/饱和/亮度), keyToGrad 和光效默认色共用 ──
  // ⚠ 抽出来是为了让"无背景图时光效跟底色走"跟渐变**用同一个色相**, 不会对不上。
  // 字符串 → 稳定的小整数。⚠ key 从"序号"改成"语义名"之后必须有这个 ——
  //   原来是 parseInt(parts[1]) 拿序号算色，语义名会得到 NaN→0，
  //   结果所有卡片的默认渐变变成同一个颜色。
  //   同一个名字永远得到同一个数，所以颜色是稳定的、可预期的。
  function hashStr(s){
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function keyToHsl(key){
    const parts = String(key).split('.');
    const lv = parts[0];
    const b = hashStr(parts[1] || '');       // 主卡语义名
    const p = hashStr(parts[2] || '');       // 分区语义名
    // [起始色相, 带宽] —— 每级锁在自己的色带内, 一/二/三级永不撞色
    const BAND = { card:[195,70], zone:[85,80], detail:[275,80], task:[20,40] };
    const band = BAND[lv] || [20,60];
    // 在带内散开: 主卡跨度大, 分区在主卡附近细分
    const off = (b*29 + p*13) % band[1];
    const h = (band[0] + off) % 360;
    // 亮度/饱和也随名字微调, 相近色相也能分辨
    const s = 48 + ((b*7 + p*11) % 14);
    const l = 44 + ((b*5 + p*3) % 8);
    return { h, s, l };
  }
  function keyToGrad(key){
    // 每级锁在自己的色带内(取模只在带宽内绕), 保证:
    //   ① 一/二/三级永不撞色  ② 同级内每张卡不同
    // ⚠ 旧写法 h = 300 + b*45 直接对 360 取模, b=2 会跑到 30°(橙)、b=4 跑到 120°(绿),
    //   反而撞进二级的绿区 —— 这是三级看起来同色/乱色的根源之一。
    const c = keyToHsl(key);
    return hslGrad(c.h, c.s, c.l, c.l - 16);
  }

  // ── 把背景应用到 DOM(按 bgkey 找到卡片) ──
  // 查找顺序: [data-bgkey], 其次通过主卡/zone/detail 的选择器
  function applyToCard(key){
    if(key==='zone.engines.engine')applyToCard('zone.engines.all');
    if(key==='detail.engines.engine')applyToCard('detail.engines.all');
    const el = document.querySelector('[data-bgkey="' + key + '"]');
    if (!el) return;
    // ⚠ 二级卡(.zone)的背景必须设在内层 .z-body 上 —— 因为背景要跟内容一起上下滑动换新。
    //   .z-body 是 absolute inset:0 铺满 .zone 的, 设在 .zone 上会被它完全盖住 → "换了背景没用"。
    const bgEl = el.querySelector(':scope > .z-body') || el;
    const bg = getBg(key);
    if (bg){
      bgEl.style.setProperty('--card-bg-image', 'url("' + bg + '")');
      bgEl.style.backgroundImage = 'none';
      bgEl.style.backgroundColor = 'transparent';
      el.classList.add('has-bg');
    } else if (solidOverride){
      // ⭐ 全局纯色（设置 → 外观与交互 → 配色 → 卡片底色，2026-09-14 用户要求）
      // 等价于"把主题里所有图都换成同一张纯色图"。
      // ⚠ 优先级：用户给这张卡单独设的图 > 全局纯色 > 每张卡的默认渐变。
      //   单独设过图的卡不受影响 —— 那是他明确为这张卡选的，全局设置不该覆盖它。
      bgEl.style.setProperty('--card-bg-image', 'linear-gradient(' + solidOverride + ',' + solidOverride + ')');
      bgEl.style.backgroundImage = 'none';
      // The pseudo-element owns the visible background so the global opacity
      // can fade this pure-color theme too; leave the host transparent.
      bgEl.style.backgroundColor = 'transparent';
      el.classList.add('has-bg');     // 走"有背景"那套遮罩，不然文字压在纯色上偏淡
    } else {
      // ⭐⭐ 2026-10-22（docs/263 第 19 条，用户拍板「我不要顶上的颜色」）：没设背景图 → 统一中性底。
      //   ⚠⚠ 这里原来是 keyToGrad(key) —— 按卡片名字算一张彩色渐变（生成卡绿、设置卡蓝…）。
      //     它是「统一深色底」那个开关要对付的东西，也正是大二级卡整块发绿的真凶：
      //     开关那套只是【盖】在它上面，任何一次重画跑回这个分支，彩色又出来了
      //     （2026-10-22 实测：截图里生成大二级整块绿、探针量到 --card-bg-image 还是 150deg 那串）。
      //   现在默认就是 #0e121a 平铺（跟 --card-h 默认值同一个色），想换颜色去设置里「卡片底色」。
      const neutral = '#0e121a';
      bgEl.style.setProperty('--card-bg-image', 'linear-gradient(' + neutral + ',' + neutral + ')');
      bgEl.style.backgroundImage = 'none';
      bgEl.style.backgroundColor = 'transparent';
      el.classList.add('has-bg');     // 跟纯色底同一条路（那层遮罩负责压字可读性）
    }
    bgEl.style.backgroundSize = 'cover';
    bgEl.style.backgroundPosition = 'center';
    // ⚠ 光效色 --glow-hsl("H S% L%" 三分量, CSS 里用 hsl(var(--glow-hsl) / .6) 控透明度):
    //   ① 有背景图 → 从图反推的主题色(themeCache)
    //   ② 无背景图(默认渐变) → 跟【底色】走: 用 keyToHsl 的色相(与渐变同一个算法, 不会对不上),
    //      饱和/亮度拉到 78%/66% 保证光在深色卡上够亮
    //   ③ 有图但提不出色(纯灰图) → 也回落到 ② 的底色
    const c = bg ? getThemeColor(key) : null;
    if (c){
      el.style.setProperty('--glow-hsl', c.h + ' ' + c.s + '% ' + c.l + '%');
    } else if (solidOverride && solidGlow){
      // ⭐ 全局纯色时，光效也跟这个色走 —— 否则卡片是统一的纯色，
      //   边缘的光却还按卡片名字散成五颜六色，看着更乱。
      el.style.setProperty('--glow-hsl', solidGlow);
    } else {
      // ⭐ 2026-10-22：光效也统一（原来跟 keyToHsl 走，生成卡绿光、设置卡蓝光 —— 那是"顶上的颜色"的一部分）
      el.style.setProperty('--glow-hsl', solidGlow || '220 20% 60%');
    }
  }

  // ── 应用所有已设置的背景(页面加载完调用) ──
  // 遍历所有 [data-bgkey] 卡片: 有自定义图用图, 无则用该卡独有的默认渐变
  // ⚠ IndexedDB 是异步的, 所以这里分两拍:
  //   第一拍(同步): 先把默认渐变铺上, 界面立刻有东西, 不会白屏
  //   第二拍(异步): 图读回来后再刷一次
  //   这样即使 IndexedDB 慢或者失败, 界面也是完整的(只是没自定义图)。
  function applyAll(){
    const operation = storageEpoch, expectedDb = storageDbName();
    document.querySelectorAll('[data-bgkey]').forEach(el => applyToCard(el.dataset.bgkey));
    // 先搬家（只有第一次真会搬），再读本机这份；搬家失败不挡读图
    return adoptAccountTheme(operation).catch(e => console.warn('[BG] 账号背景接到本机失败:', e))
      .then(() => { if (operationValid(operation, expectedDb)) Object.keys(themeCache).forEach(k => delete themeCache[k]); return dbLoadAll(operation, expectedDb); })
      .then(all => {
      if(all === null || !operationValid(operation, expectedDb)) return 0;
      Object.keys(all).forEach(k => setCacheBlob(k, all[k]));
      ready = true;
      document.querySelectorAll('[data-bgkey]').forEach(el => applyToCard(el.dataset.bgkey));
      notifyBackgroundChange();
      document.querySelectorAll('.error-card[data-severity]').forEach(el => applyErrorToCard(el, el.dataset.severity));
      return Object.keys(all).length;
    }).catch(e => { console.error('[BG] 读取背景失败:', e); if(window.ERR) ERR.report('BG_READ_FAILED',{message:String(e&&e.message||e)}); ready = true; return 0; });
  }
  function rebindStorage(){
    storageEpoch++;
    Object.keys(cache).forEach(k => { if (cache[k]) { try { URL.revokeObjectURL(cache[k]); } catch (_) {} } delete cache[k]; });
    Object.keys(blobCache).forEach(k => delete blobCache[k]);
    Object.keys(themeCache).forEach(k => delete themeCache[k]);
    if (dbPromise) dbPromise.then(db => { try { db.close(); } catch (_) {} }).catch(() => {});
    dbPromise = null;
    ready = false;
    notifyBackgroundChange();
    return applyAll();
  }
  if(window.addEventListener) window.addEventListener('wheelchair:storage-context', () => { storageEpoch++; });
  function isReady(){ return ready; }

  // ── 图库列表: 所有可设置背景的卡片 ──
  // cards: [{key, label, type, el}] 由调用方传入或自动扫描
  function listAll(){
    const out = [];
    document.querySelectorAll('[data-bgkey]').forEach(el => {
      out.push({
        key: el.dataset.bgkey,
        label: el.dataset.bglabel || el.dataset.bgkey,
        type: el.dataset.bgtype || '',
        el: el,
        has: !!getBg(el.dataset.bgkey)
      });
    });
    return out;
  }

  // ── 清空所有背景(回到默认渐变) + 主题色 ──
  function clearAll(){
    // ⚠ blob 地址要一个个 revoke, 不然内存一直占着
    Object.keys(cache).forEach(k => { if (cache[k]) { try{ URL.revokeObjectURL(cache[k]); }catch(_){} } delete cache[k]; });
    Object.keys(blobCache).forEach(k => delete blobCache[k]);
    Object.keys(themeCache).forEach(k => delete themeCache[k]);
    try { localStorage.removeItem(themeKey()); } catch(_){}
    document.querySelectorAll('[data-bgkey]').forEach(el => applyToCard(el.dataset.bgkey));
    document.querySelectorAll('.error-card[data-severity]').forEach(el => applyErrorToCard(el, el.dataset.severity));
    notifyBackgroundChange();
    return dbDeleteAll();
  }

  window.BG = { getBg, setBg, setBgFromFile, compress, applyAll, listAll,
                keyToGrad, keyToHsl, usage, clearAll, targetFor,
                // 槽位 key(语义名, 见 docs/24)
                slotKey, setScale, getScale, isReady, setSolid, applyToCard,
                // 跨窗口取图(L4 那种独立窗口用, blob 地址在别的窗口无效)
                getBgDataUrl, getErrorBgDataUrl,
                errorKey, errorDefault, getErrorBg, setErrorBg, setErrorBgFromFile,
                applyErrorToCard, normalizeErrorLevel, ERROR_DEFAULTS, rebindStorage,
                // 主题色(从背景图反推, 给光效用)
                getThemeColor, themeCss, pickThemeColor, themeColorFromDataUrl,
                // 平均亮度(给任务卡文字自动切黑白用)
                meanLuminance, luminanceFromDataUrl };
})();
