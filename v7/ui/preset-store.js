// ============================================================
//  preset-store.js — 预设系统 · 数据层
//  window.PRESETS = 数据层唯一出入口
//
//  管三样东西:
//    1. 素材(asset)  —— 剪影画布上的一块, 一对图 + 名字 + 摆放
//    2. 预设(preset) —— V6 原格式的 json, category 字段指向素材 id
//    3. 画布(canvas) —— 摆放信息的容器 + 迁移标记
//
//  ⚠ 图片一律存 Blob, 不存 base64 字符串(CLAUDE.md 铁律 13)。
//  ⚠ 命中检测的像素数据降采样到最长边 256 再读 —— 4K 素材逐像素读会爆内存。
//  设计文档: docs/28_预设系统设计.md
// ============================================================
(function () {
  'use strict';

  // ═══ 存储 ═══
  const DB_VER = 1;
  const S_ASSET = 'assets', S_PRESET = 'presets', S_META = 'meta';

  let dbPromise = null;
  let storageEpoch = 0;
  let assetRevision = 0;
  const storageTransactions = new Set();
  function dbName() {
    return window.WHEELCHAIR_STORAGE
      ? window.WHEELCHAIR_STORAGE.dbName('presets') : 'v8.presets';
  }
  function storageOperation() {
    const name = dbName(), epoch = storageEpoch;
    return { name, check() {
      if (name !== dbName() || epoch !== storageEpoch) throw Object.assign(new Error('账号已切换，预设操作已停止'), { code: 'BACKUP_ACCOUNT_CHANGED' });
    } };
  }
  function openDb(operation = storageOperation()) {
    operation.check();
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(operation.name, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(S_ASSET)) db.createObjectStore(S_ASSET);
        if (!db.objectStoreNames.contains(S_PRESET)) db.createObjectStore(S_PRESET);
        if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META);
      };
      req.onsuccess = () => { try { operation.check(); resolve(req.result); } catch (error) { req.result.close(); reject(error); } };
      req.onerror = () => reject(req.error || new Error('IndexedDB 打不开'));
    });
    return dbPromise;
  }
  function tx(store, mode, fn, operation = storageOperation()) {
    return openDb(operation).then(db => new Promise((resolve, reject) => {
      operation.check();
      const t = db.transaction(store, mode);
      storageTransactions.add(t);
      let out;
      t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(out && out.__req ? out.__req.result : out); } catch (error) { reject(error); } };
      t.onabort = t.onerror = () => { storageTransactions.delete(t); try { operation.check(); } catch (error) { reject(error); return; } reject(t.error || new Error('数据库操作失败')); };
      try { out = fn(t.objectStore(store)); } catch (error) { t.abort(); reject(error); }
    }));
  }
  function dbPut(store, key, val, operation) { return tx(store, 'readwrite', s => { s.put(val, key); return true; }, operation); }
  function dbDel(store, key, operation) { return tx(store, 'readwrite', s => { s.delete(key); return true; }, operation); }
  function dbGet(store, key, operation) {
    return tx(store, 'readonly', s => ({ __req: s.get(key) }), operation);
  }
  function dbAll(store, operation) {
    return tx(store, 'readonly', s => ({ __req: s.getAll() }), operation);
  }

  function rebindStorage() {
    storageEpoch++;
    assetRevision++;
    for (const transaction of storageTransactions) { try { transaction.abort(); } catch (_) {} }
    if (dbPromise) dbPromise.then(db => { try { db.close(); } catch (_) {} }).catch(() => {});
    dbPromise = null;
    initPromise = null;
    mem.assets.forEach(releaseAssetUrls);
    mem.assets = [];
    mem.presets = [];
    mem.ready = false;
    mem.lastError = '';
    mem.canvasAspect = DEFAULT_ASPECT;
  }
  window.addEventListener?.('wheelchair:storage-context', rebindStorage);

  // ═══ 内存镜像 ═══
  // 界面读得非常频繁(每次 mousemove 都要查命中), 全部先读进内存, 写时同步落库。
  const DEFAULT_ASPECT = 2 / 3;   // 画布长宽比(宽/高)。V6 人体图是 2000×3000。
  const mem = {
    assets: [],          // [{id,name,icon,x,y,w,h,z, display:Blob, mask:Blob, _dispUrl, _maskUrl, _hit:{w,h,data}}]
    presets: [],         // V6 格式 json 数组
    // ⚠ 画布长宽比必须跟着素材走, 不能跟着卡片走。
    //   素材的 x/y/w/h 是【相对画布】的百分比, 而画布如果被拉成卡片的形状(0.84),
    //   跟原图(0.667)对不上, 整个人就横向拉胖 26% —— 2026-09-10 用户一眼看出来的那个 bug。
    //   正确做法: 画布保持这个比例, 等比放进卡片里, 两边留边。
    canvasAspect: DEFAULT_ASPECT,
    ready: false,
    lastError: ''
  };

  function uid(p) { return p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }

  // ═══════════════════════════════════════════════════════════
  //  V6 内置人体剪影 —— 17 个部位的颜色定义
  //  ⚠ id 一个都不能改: V6 预设的 category 字段就是它们(docs/28 §2.6)
  // ═══════════════════════════════════════════════════════════
  const V6_PARTS = [
    { id: 'head', name: '头部面部', icon: 'head', rgb: [255, 0, 0] },
    { id: 'hair', name: '头发', icon: 'hair', rgb: [0, 255, 0] },
    { id: 'neck', name: '颈部', icon: 'bone', rgb: [0, 0, 255] },
    { id: 'torso', name: '躯干腰腹', icon: 'shirt', rgb: [255, 255, 0] },
    { id: 'arms', name: '手臂', icon: 'arm', rgb: [0, 255, 255] },
    { id: 'hands', name: '手部', icon: 'hand', rgb: [255, 0, 255] },
    { id: 'legs', name: '腿部', icon: 'leg', rgb: [255, 128, 0] },
    { id: 'feet', name: '脚部', icon: 'foot', rgb: [128, 0, 255] },
    { id: 'clothing', name: '服装', icon: 'dress', rgb: [255, 0, 128] },
    { id: 'accessory', name: '配饰', icon: 'ring', rgb: [128, 64, 0] },
    { id: 'fullbody', name: '全身', icon: 'person', rgb: [128, 128, 128] },
    { id: 'lighting', name: '光影', icon: 'bulb', rgb: [192, 192, 192] },
    { id: 'background', name: '背景', icon: 'landscape', rgb: [0, 128, 0] },
    { id: 'weapon', name: '武器', icon: 'sword', rgb: [0, 0, 128] },
    { id: 'cleanup', name: '去杂物', icon: 'broom', rgb: [128, 128, 0] },
    { id: 'effects', name: '特效', icon: 'sparkles', rgb: [255, 128, 255] },
    { id: 'other', name: '其他', icon: 'package', rgb: [64, 64, 64] }
  ];
  const UNSORTED_ID = '__unsorted';        // 删素材后预设的去处(docs/28 §"回收区")

  // ═══════════════════════════════════════════════════════════
  //  图片工具
  // ═══════════════════════════════════════════════════════════
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败: ' + String(src).slice(0, 80)));
      img.src = src;
    });
  }
  function canvasToBlob(cv, type) {
    return new Promise((resolve, reject) => {
      cv.toBlob(b => b ? resolve(b) : reject(new Error('导出图片失败')), type || 'image/png');
    });
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读图片失败'));
      fr.readAsDataURL(blob);
    });
  }
  // ⚠ 2026-10-24（V7待办/07，反馈 #6「参考图编码损坏」重复 3 次）：原来只靠 fetch(dataURL) 解码，
  //   那位用户机器上就坏在这一步，原因查不到（同内核 48MB 实测能解；杀毒注入 / WebView2 版本都可能）。
  //   兜底：base64 的 dataURL 先自己逐段解（atob，每段 1MB，去空白、认 URL 安全字符），不走网络层；
  //   自己解失败才退回 fetch。两条都失败时把两条的原因都带出去。
  function decodeBase64DataUrl(text) {
    const comma = text.indexOf(',');
    const head = comma > 0 ? text.slice(0, comma) : '';
    if (!/^data:[^,]*;base64$/i.test(head) || typeof atob !== 'function') return null;
    const mime = head.slice(5, head.indexOf(';')) || 'application/octet-stream';
    let b64 = text.slice(comma + 1).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (b64.length % 4 === 1) throw new Error('base64 长度不对（' + b64.length + '），数据被截断了');
    while (b64.length % 4) b64 += '=';
    const STEP = 1 << 20; // 4 的倍数：每段都能单独解
    const parts = [];
    for (let i = 0; i < b64.length; i += STEP) {
      const bin = atob(b64.slice(i, i + STEP));
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      parts.push(bytes);
    }
    return new Blob(parts, { type: mime });
  }
  function dataUrlToBlob(url) {
    const text = String(url || '');
    let own = null;
    try { const blob = decodeBase64DataUrl(text); if (blob) return Promise.resolve(blob); }
    catch (error) { own = error; }
    return fetch(text).then(r => r.blob()).catch(error => {
      if (own) error.ownDecodeError = String(own && (own.name + ': ' + own.message) || own);
      throw error;
    });
  }

  // ── 命中数据: 把选区图降采样到最长边 HIT_MAX 再读 alpha ──
  // ⚠ 不降采样的话, 一张 4K 选区图 = 3840×2160×4 ≈ 33MB, 17 个素材直接爆内存。
  const HIT_MAX = 256;
  function buildHitData(img) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return null;
    const k = Math.min(1, HIT_MAX / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;

    // 主路径: 看透明度
    const alpha = new Uint8Array(w * h);
    let anyTransparent = false, anyOpaque = false;
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      const a = px[i + 3];
      if (a < 128) anyTransparent = true; else anyOpaque = true;
      alpha[p] = a >= 128 ? 1 : 0;
    }
    // 兜底: 整张都不透明(用户画在白底/不透明底上) → 把出现最多的颜色当背景
    let mode = 'alpha';
    if (!anyTransparent && anyOpaque) {
      const count = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        count.set(key, (count.get(key) || 0) + 1);
      }
      let bg = 0, best = -1;
      count.forEach((n, key) => { if (n > best) { best = n; bg = key; } });
      const br = (bg >> 16) & 255, bg2 = (bg >> 8) & 255, bb = bg & 255;
      for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        const near = Math.abs(px[i] - br) <= 12 && Math.abs(px[i + 1] - bg2) <= 12 && Math.abs(px[i + 2] - bb) <= 12;
        alpha[p] = near ? 0 : 1;
      }
      mode = 'color';
    }
    return { w, h, data: alpha, mode };
  }

  // ═══════════════════════════════════════════════════════════
  //  首次运行: 把 V6 人体图切成 17 个独立素材
  //  ⚠ 一个素材一个区域(用户定案), 所以整张图必须拆开。
  //    拼回去跟原图像素级一致 —— 只是把互不重叠的块摆回原位。
  // ═══════════════════════════════════════════════════════════
  const SPLIT_TOL = 30;      // 颜色容差, 跟 V6 的 _buildCatMaskCache 一致
  const DILATE = 1;          // 边缘外扩像素数, 补抗锯齿交界的缝(docs/28 §2.4 风险项)

  async function splitV6Body() {
    const [bodyImg, mapImg] = await Promise.all([
      loadImage('assets/body/body_full.png'),
      loadImage('assets/body/body_full_map.png')
    ]);
    const W = mapImg.naturalWidth, H = mapImg.naturalHeight;

    const mapCv = document.createElement('canvas');
    mapCv.width = W; mapCv.height = H;
    const mapCtx = mapCv.getContext('2d', { willReadFrequently: true });
    mapCtx.drawImage(mapImg, 0, 0);
    const map = mapCtx.getImageData(0, 0, W, H).data;

    // 显示图按 map 尺寸重绘一次, 保证两者像素一一对应
    const bodyCv = document.createElement('canvas');
    bodyCv.width = W; bodyCv.height = H;
    const bodyCtx = bodyCv.getContext('2d', { willReadFrequently: true });
    bodyCtx.drawImage(bodyImg, 0, 0, W, H);
    const body = bodyCtx.getImageData(0, 0, W, H).data;

    const out = [];
    for (let pi = 0; pi < V6_PARTS.length; pi++) {
      const part = V6_PARTS[pi];
      const [tr, tg, tb] = part.rgb;

      // 1) 标记属于这块的像素 + 求包围盒
      const belong = new Uint8Array(W * H);
      let minX = W, minY = H, maxX = -1, maxY = -1, n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (map[i + 3] < 128) continue;
          if (Math.abs(map[i] - tr) > SPLIT_TOL) continue;
          if (Math.abs(map[i + 1] - tg) > SPLIT_TOL) continue;
          if (Math.abs(map[i + 2] - tb) > SPLIT_TOL) continue;
          belong[y * W + x] = 1; n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (n === 0 || maxX < 0) continue;   // map 里没这个颜色, 跳过

      // 2) 外扩 DILATE 像素 —— 补抗锯齿交界的 1px 缝
      if (DILATE > 0) {
        const grown = new Uint8Array(belong);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (belong[y * W + x]) continue;
            let hit = false;
            for (let dy = -DILATE; dy <= DILATE && !hit; dy++) {
              for (let dx = -DILATE; dx <= DILATE; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                if (belong[ny * W + nx]) { hit = true; break; }
              }
            }
            if (hit) grown[y * W + x] = 1;
          }
        }
        belong.set(grown);
        minX = Math.max(0, minX - DILATE); minY = Math.max(0, minY - DILATE);
        maxX = Math.min(W - 1, maxX + DILATE); maxY = Math.min(H - 1, maxY + DILATE);
      }

      const bw = maxX - minX + 1, bh = maxY - minY + 1;

      // 3) 裁出显示图(只留本块像素) + 选区图(本块涂实色)
      const dCv = document.createElement('canvas'); dCv.width = bw; dCv.height = bh;
      const mCv = document.createElement('canvas'); mCv.width = bw; mCv.height = bh;
      const dCtx = dCv.getContext('2d'), mCtx = mCv.getContext('2d');
      const dImg = dCtx.createImageData(bw, bh), mImg = mCtx.createImageData(bw, bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const src = ((y + minY) * W + (x + minX));
          const di = (y * bw + x) * 4;
          if (!belong[src]) { dImg.data[di + 3] = 0; mImg.data[di + 3] = 0; continue; }
          const si = src * 4;
          dImg.data[di] = body[si]; dImg.data[di + 1] = body[si + 1];
          dImg.data[di + 2] = body[si + 2]; dImg.data[di + 3] = body[si + 3];
          // 选区图: 用该部位的 V6 颜色涂实(颜色只为好认, 命中只看 alpha)
          mImg.data[di] = tr; mImg.data[di + 1] = tg; mImg.data[di + 2] = tb; mImg.data[di + 3] = 255;
        }
      }
      dCtx.putImageData(dImg, 0, 0); mCtx.putImageData(mImg, 0, 0);

      out.push({
        id: part.id, name: part.name, icon: part.icon,
        x: minX / W, y: minY / H, w: bw / W, h: bh / H,
        z: pi,
        display: await canvasToBlob(dCv),
        mask: await canvasToBlob(mCv)
      });
    }
    // 画布比例 = 原图比例。素材的百分比坐标全是相对它算的，丢了就会拉伸。
    return { parts: out, aspect: W / H };
  }

  // ═══════════════════════════════════════════════════════════
  //  素材: 读写
  // ═══════════════════════════════════════════════════════════
  function assetUrls(a) {
    if (a._dispUrl) { try { URL.revokeObjectURL(a._dispUrl); } catch (_) { } }
    if (a._maskUrl) { try { URL.revokeObjectURL(a._maskUrl); } catch (_) { } }
    a._dispUrl = a.display ? URL.createObjectURL(a.display) : '';
    a._maskUrl = a.mask ? URL.createObjectURL(a.mask) : '';
  }
  function releaseAssetUrls(a) {
    for (const key of ['_dispUrl', '_maskUrl']) { if (a[key]) { try { URL.revokeObjectURL(a[key]); } catch (_) {} a[key] = ''; } }
  }
  async function hydrateAsset(a, operation = storageOperation()) {
    operation.check();
    assetUrls(a);
    if (a._maskUrl) {
      try { const image = await loadImage(a._maskUrl); operation.check(); a._hit = buildHitData(image); }
      catch (e) { try { operation.check(); } catch (error) { releaseAssetUrls(a); throw error; } a._hit = null; mem.lastError = '素材 ' + a.name + ' 选区图读不了: ' + e.message; }
    }
    return a;
  }
  function plainAsset(a) {
    return { id: a.id, name: a.name, icon: a.icon, x: a.x, y: a.y, w: a.w, h: a.h, z: a.z, hidden: a.hidden === true, display: a.display, mask: a.mask };
  }
  async function saveAsset(a, operation = storageOperation()) {
    operation.check();
    await dbPut(S_ASSET, a.id, plainAsset(a), operation);
    operation.check();
    const i = mem.assets.findIndex(x => x.id === a.id);
    if (i >= 0) {
      // ⚠ 被顶掉的是【另一个对象】时，它的 blob 地址必须 revoke ——
      //   blob 不在 JS 堆里，泄漏了看内存曲线也查不出来(同 bg-manager 的教训)。
      const old = mem.assets[i];
      if (old !== a) {
        if (old._dispUrl) { try { URL.revokeObjectURL(old._dispUrl); } catch (_) { } }
        if (old._maskUrl) { try { URL.revokeObjectURL(old._maskUrl); } catch (_) { } }
      }
      mem.assets[i] = a;
    } else mem.assets.push(a);
    sortAssets();
    assetRevision++;
    return a;
  }
  function sortAssets() { mem.assets.sort((p, q) => (p.z || 0) - (q.z || 0)); }

  async function deleteAsset(id, operation = storageOperation()) {
    operation.check();
    // 预设不删, 全部转进「未分类」(用户定案: 数据不因摆弄界面而丢)
    let moved = 0;
    for (const p of mem.presets) {
      if ((p.category || '') === id) {
        operation.check();
        p.category = UNSORTED_ID;
        await dbPut(S_PRESET, p.id, p, operation);
        moved++;
      }
    }
    await dbDel(S_ASSET, id, operation);
    operation.check();
    const i = mem.assets.findIndex(x => x.id === id);
    if (i >= 0) {
      const a = mem.assets[i];
      if (a._dispUrl) { try { URL.revokeObjectURL(a._dispUrl); } catch (_) { } }
      if (a._maskUrl) { try { URL.revokeObjectURL(a._maskUrl); } catch (_) { } }
      mem.assets.splice(i, 1);
    }
    assetRevision++;
    return { moved };
  }

  // 从一对图新建素材。displaySrc / maskSrc 可以是 dataURL 或 blob 地址
  async function createAsset(opts, operation = storageOperation()) {
    // Capture the account/database before any image conversion await.  Without
    // this, a slow dataURL decode could finish after an account switch and the
    // new asset would be written into the newly selected account.
    operation.check();
    const dispBlob = opts.display instanceof Blob ? opts.display : await dataUrlToBlob(opts.display);
    const maskBlob = opts.mask instanceof Blob ? opts.mask : await dataUrlToBlob(opts.mask);
    operation.check();
    const a = {
      id: opts.id || uid('a_'),
      name: opts.name || '新部位',
      icon: opts.icon || 'pin',
      x: opts.x != null ? opts.x : 0.35, y: opts.y != null ? opts.y : 0.35,
      w: opts.w != null ? opts.w : 0.3, h: opts.h != null ? opts.h : 0.3,
      z: opts.z != null ? opts.z : (mem.assets.reduce((m, v) => Math.max(m, v.z || 0), 0) + 1),
      // ⭐ 隐藏（2026-09-14 用户要求）：在剪影上不显示，但【数据保留】。
      //   ⚠ 和删除是两回事：删了那个部位下面的预设会掉进回收区（docs/28），
      //   而隐藏只是眼不见，随时能开回来。
      //   编辑器里那条 `.lib-item.hidden-asset` 的样式早就写好了，
      //   但一直没有代码在用 —— 现在补上。
      hidden: opts.hidden === true,
      display: dispBlob, mask: maskBlob
    };
    await hydrateAsset(a, operation);
    await saveAsset(a, operation);
    operation.check();
    return a;
  }

  function assetById(id) { return mem.assets.find(a => a.id === id) || null; }

  // ── 命中检测: 从最上层往下找第一个命中的素材 ──
  // ux / uy = 画布归一化坐标(0~1)
  // ═══════════════════════════════════════════════════════════
  //  内置「工具」素材
  //
  //  ⭐ 用户 2026-09-14 定：新建一个工具类别（扳手图标），
  //    抠像和以后的外挂模型都放这儿；默认隐藏，要用的自己打开、摆到想要的位置。
  //
  //  ⚠ 为什么做成普通素材而不是写死在界面上：
  //    做成素材就白嫖了整套现成能力 —— 位置/大小/层级/隐藏/命中检测/二级推进，
  //    一行新代码都不用写。界面上写死的话这些全要另做一遍。
  //  ⚠ id 写死成 __tool__，别用随机 id —— 升级时要靠它认出"这条已经建过了"。
  // ═══════════════════════════════════════════════════════════
  const TOOL_ID = '__tool__';

  function toolSvg(fill) {
    // 扳手。⚠ 和 icons.js 的 G.wrench 是同一个形状，但这里必须自带一份 ——
    //   preset-store 是数据层，不该依赖界面层的 ICON（加载顺序也不保证）。
    //   ⚠ 改形状时两处一起改（搜 "G.wrench"）。
    const d = 'M15.5 3.2a5.6 5.6 0 0 0-5 8.2L3.5 18.4a2 2 0 0 0 2.8 2.8l7-7'
            + 'a5.6 5.6 0 0 0 7-7l-3.1 3.1-2.8-.7-.7-2.8 3.1-3.1a5.6 5.6 0 0 0-1.3-.5Z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="256" height="256">'
         + '<path d="' + d + '" fill="' + fill + '"/></svg>';
  }

  function svgToBlob(svg) {
    return new Blob([svg], { type: 'image/svg+xml' });
  }

  // ═══════════════════════════════════════════════════════════
  //  抠像参数的默认值
  //
  //  ⚠ 每一项都写清"治什么"，因为这些参数【用户看不出该调哪个】——
  //    界面上要把这段说明显示出来，光给个滑块等于没给。
  //  ⚠ 默认值的取法：一律取"不动原图"那一端。
  //    宁可让用户觉得"没效果去调调看"，也不能默认就把发丝糊掉。
  // ═══════════════════════════════════════════════════════════
  const MATTING_DEFAULTS = {
    // ⭐⭐ 结果怎么进 Photoshop（2026-09-14 深夜，用户定的新方式）
    //   'mask'  盖印当前画面 + 把抠出来的 alpha 做成图层蒙版（默认）
    //           好处：① 引擎只回 alpha 一个通道，数据量实测省 8 倍（1.77MB → 222KB）
    //                ② 没有"贴到哪、多大"的问题，坑55 那套 bbox 补丁用不着
    //                ③ 结果是普通图层+蒙版，拿画笔就能二次微调（PS 原生工作流）
    //   'layer' 老路：贴一张透明的智能对象图层
    //   ⚠ 为什么还留着 'layer'：'mask' 那条路【还没在真 Photoshop 里验过】。
    //     万一 UXP 那边有意外，用户至少还有一条能用的路，而不是连抠图都废了。
    //     验通之后可以考虑去掉这个开关（但别急，等用户实际用一阵）。
    applyMode: 'mask',
    tier: 'auto',      // 模型档位。auto = 用当前能跑的最高档
    // ⭐⭐ 抓图分辨率（2026-09-14 下半场加，用户定 0）。0 = 原始尺寸，一个像素都不缩。
    //
    //   ⚠⚠ 抠像和生成【根本不一样】，别再套用"发给 AI 的图"那个 2048 上限：
    //     生成是 AI 重画一张，输入缩一点无所谓；
    //     抠像是【给原图加一层透明】—— 缩了就等于把用户的原图降质，
    //     抠完贴回去还要被拉大回选区尺寸，糊上加糊。
    //     这正是用户报的"分辨率极低"的头号原因。
    //   ⚠ 代价说在明处：原始尺寸 = 一来一回的数据量按面积涨。
    //     8000px 那种超大选区没实测过，卡的话在面板里改成 4096。
    res: 0,
    refine: true,      // 边缘精修（引导滤波）。⭐ 对大图质量提升最大，默认开
    threshold: 0,      // 边缘阈值 0~100。0 = 不处理，保留模型原始的半透明过渡
    contrast: 0,       // 边缘对比 0~100。把"半透明的一圈"收紧，0 = 不动
    shrink: 0,         // 收缩/扩张 -5~+5 像素。负=往里收(去背景色边)，正=往外扩(别吃掉主体)
    despeckle: 0,      // 去碎片：小于这个面积占比(‰)的独立块丢掉。0 = 不处理
    feather: 0         // 羽化半径。⚠ 默认 0 —— 边缘质量是模型决定的，
                       //   默认加羽化会把模型算准的发丝糊掉
  };

  async function ensureMattingPreset(list, operation) {
    const ID = '__matting_default__';
    if (list.some(p => p.id === ID)) return;
    const p = normalizePreset({
      id: ID,
      title: '抠像',
      kind: KIND_MATTING,
      category: TOOL_ID,              // 挂在「工具」素材下
      content: JSON.stringify(MATTING_DEFAULTS),
      _isFactory: true                // 出厂的，界面上标一下、别让用户误删
    });
    await dbPut(S_PRESET, p.id, p, operation);
    list.push(p);
  }

  // ═══════════════════════════════════════════════════════════
  //  人体解析（语义分割）的默认值
  //
  //  产物形态是用户 2026-09-14 深夜定的，原话：
  //    「新建一个组 组里是我的多份原图，原图会有蒙版，蒙版就是推理出的部位和范围
  //      图层的名字是部位名字」
  //  → 盖印一次 → 转智能对象 → 复制 N 份（共享源，不会胖 N 倍）→ 每份挂一个部位蒙版
  //
  //  ⚠ parts 空数组 = 【全要】（引擎按 minPercent 过滤掉几乎不存在的部位）。
  //    不要把默认值写成"预先勾好某几个"—— 用户第一次点开会以为自己调过了。
  // ═══════════════════════════════════════════════════════════
  const SEGMENT_DEFAULTS = {
    tier: 'auto',      // 模型档位。auto = 用当前能跑的最高档（档2 = SCHP，主力）
    res: 0,            // 抓图分辨率。0 = 原始尺寸，和抠像同一个含义（见 MATTING_DEFAULTS.res）
    parts: [],         // 要哪些部位（存的是部位 id 数组）。空 = 全要
    minPercent: 0.3,   // 占比低于这个数的部位不报（‰ 不是 %，0.3 = 0.3%）
    groupName: ''      // PS 里那个组叫什么。空 = 用预设的标题
  };

  // ═══════════════════════════════════════════════════════════
  //  SAM2（点选/框选抠图）的默认值
  //
  //  ⚠ SAM2 和抠像的根本区别：抠像是"它自己找主角"，SAM2 是"你指哪它抠哪"。
  //    第一版用【PS 里拉的选区当框】——不用另做预览界面，和抠像共用同一条抓选区的路。
  //  ⚠ pick 默认 'ask'：SAM2 每次会同时给三个候选（比如点在领口上 →
  //    整个人 / 上衣 / 领子），默认把三个都摆到任务卡上让用户挑，而不是替他决定。
  //    这是用户 2026-09-14 深夜明确选的。
  // ═══════════════════════════════════════════════════════════
  const SAM2_DEFAULTS = {
    tier: 'auto',      // 档位：1 tiny / 2 base+ / 3 large
    res: 0,            // 抓图分辨率，同上
    mode: 'box',       // 'box' = 用 PS 选区当框；'point' = 面板里点（第一版没做界面）
    pick: 'ask'        // 'ask' = 三个候选摆出来让用户挑；'auto' = 直接用置信度最高那个
  };

  const GLOW_DEFAULTS = { threshold:70, radius:1.5, strength:45, blend:'softLight', copyHighlights:true };
  async function ensureGlowPreset(list, operation) {
    const id='__glow_default__';
    if(list.some(p=>p.id===id)) return;
    const p=normalizePreset({id,title:'辉光',kind:KIND_GLOW,category:TOOL_ID,
      content:JSON.stringify(GLOW_DEFAULTS),_isFactory:true});
    await dbPut(S_PRESET,p.id,p,operation);list.push(p);
  }

  async function ensureSegmentPreset(list, operation) {
    const ID = '__segment_default__';
    if (list.some(p => p.id === ID)) return;
    const p = normalizePreset({
      id: ID,
      title: '人体解析',
      kind: KIND_SEGMENT,
      category: TOOL_ID,              // ⚠ 挂在同一个「工具」素材下，不另建素材
      content: JSON.stringify(SEGMENT_DEFAULTS),
      _isFactory: true
    });
    await dbPut(S_PRESET, p.id, p, operation);
    list.push(p);
  }

  async function ensureSAM2Preset(list, operation) {
    const ID = '__sam2_default__';
    if (list.some(p => p.id === ID)) return;
    const p = normalizePreset({
      id: ID,
      title: '指哪抠哪',              // ⚠ 界面上不写 "SAM2" —— 用户看不懂英文缩写
      kind: KIND_SAM2,
      category: TOOL_ID,
      content: JSON.stringify(SAM2_DEFAULTS),
      _isFactory: true
    });
    await dbPut(S_PRESET, p.id, p, operation);
    list.push(p);
  }

  async function ensureToolAsset(list, operation) {
    if (list.some(a => a.id === TOOL_ID)) return;      // 建过了
    const a = {
      id: TOOL_ID,
      name: '工具',
      icon: 'wrench',                 // ⚠ 界面上会被 ICON.iconForPart 换成 SVG 扳手
      // 默认摆右上角空白处。⚠ 这只是初始值 —— 用户能在管理器里自己挪
      x: 0.72, y: 0.02, w: 0.16, h: 0.12,
      z: 999,                      // 压在人体之上，免得被部位盖住
      hidden: true,                // ⭐ 默认隐藏（用户定）
      builtin: true,               // ⚠ 标记内置：以后要做"不许删"之类的保护时认它
      display: svgToBlob(toolSvg('rgba(235,240,250,.92)')),
      // 选区图 = 同一个形状的实心版。⚠ 命中检测只看 alpha，颜色无所谓
      mask: svgToBlob(toolSvg('#ffffff'))
    };
    await dbPut(S_ASSET, a.id, a, operation);
    list.push(a);
  }

  function hitTest(ux, uy) {
    for (let i = mem.assets.length - 1; i >= 0; i--) {
      const a = mem.assets[i];
      // ⚠ 隐藏的不参与命中（2026-09-14）。不加这条的话：画布上看不见它，
      //   鼠标划过那片区域却会高亮/点中一个不存在的东西 —— 典型的"看不见的挡板"。
      if (a.hidden) continue;
      if (!a._hit) continue;
      if (ux < a.x || uy < a.y || ux > a.x + a.w || uy > a.y + a.h) continue;
      const lx = Math.floor(((ux - a.x) / a.w) * a._hit.w);
      const ly = Math.floor(((uy - a.y) / a.h) * a._hit.h);
      if (lx < 0 || ly < 0 || lx >= a._hit.w || ly >= a._hit.h) continue;
      if (a._hit.data[ly * a._hit.w + lx]) return a;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  //  预设: 读写
  // ═══════════════════════════════════════════════════════════
  // ⭐ 预设的"种类"（2026-09-14 起）。这是 docs/42 第二批那套多 kind 预设的地基。
  //
  //   prompt   提示词预设（默认。V6 搬过来的全是这种，content 是提示词正文）
  //   matting  抠像参数（content 是一段 JSON：模型档位/边缘精修/阈值…）
  //   ⬜ 以后：forge / comfyui / api …
  //
  // ⚠⚠ 三条不能破的约定：
  //   ① 不写 kind 的一律当 prompt —— 老数据、V6 搬来的、用户手写的，全都照常工作
  //   ② kind 是【多出来的字段】，V6 读到不认识会自动忽略（docs/28 §3.1 的约定）
  //   ③ 界面按 kind 决定"点开长什么样"，但【分类树是同一棵】——
  //      用户原话："他们在预设内一样在各个分类内，点开来是不同的调度和参数设置"
  const KIND_PROMPT = 'prompt';
  const KIND_MATTING = 'matting';
  // ⭐ 2026-09-14 深夜新增的两种。都挂在同一个「工具」素材下、同一棵分类树里，
  //   只是"点开来长什么样、开始计算走哪条路"不同（约定③）。
  const KIND_SEGMENT = 'segment';   // 人体解析：一次认出十几个部位，做成一组带蒙版的图层
  const KIND_SAM2    = 'sam2';      // 指哪抠哪：用 PS 选区当框，三个候选挑一个
  const KIND_GLOW    = 'glow';      // 外置辉光预览及原尺寸计算

  function normalizePreset(p) {
    const now = new Date().toISOString();
    const out = {
      id: p.id || uid('p_'),
      title: String(p.title || '未命名'),
      content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content || ''),
      category: String(p.category || UNSORTED_ID),
      subCategory: String(p.subCategory || ''),      // 留着不用(docs/28 §8.2)
      refImages: Array.isArray(p.refImages) ? p.refImages.slice() : [],
      _isFactory: !!p._isFactory,
      starred: !!p.starred,
      // ⚠ 空值一律归到 prompt，不要留空 —— 后面所有判断就不用到处写 `|| 'prompt'`
      kind: String(p.kind || KIND_PROMPT),
      version: Number.isFinite(Number(p.version)) ? Math.max(1, Number(p.version)) : 1,
      author: String(p.author || ''),
      source: String(p.source || 'local'),
      createdAt: String(p.createdAt || now),
      updatedAt: String(p.updatedAt || now),
      importedAt: String(p.importedAt || '')
    };
    if (p.preActions != null) {
      if (!window.V7PresetPreActionContract) throw new Error('预设前置动作校验模块未加载');
      out.preActions = window.V7PresetPreActionContract.normalize(p.preActions);
    }
    // Migration metadata is deliberately retained in the V7 record.  Older
    // V6 consumers ignore these extension fields, while the migration report
    // and Forge -> ComfyUI review queue need them after IndexedDB import.
    ['provider', 'sourceKind', 'sourceRelativePath', 'sourceHash', 'sourceCategory', 'migrationState',
      'v6OriginalTitle', 'legacyId', 'negativePrompt', 'legacyForgeParameters', 'forgeWorkflow', 'needsReview', 'metadata'].forEach(function (key) {
      if (p[key] !== undefined && p[key] !== null) out[key] = p[key];
    });
    if (p.comfyuiParams && typeof p.comfyuiParams === 'object') out.comfyuiParams = p.comfyuiParams;
    // Provider/workflow/Agent integrations extend the preset contract. Preserve
    // extension data through edit/export/import, excluding credential fields
    // and special object keys which must never be part of a preset record.
    Object.keys(p).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(out, key) &&
          !/^(?:__proto__|constructor|prototype|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)$/i.test(key)) out[key] = p[key];
    });
    if (typeof p.order === 'number') out.order = p.order;
    return out;
  }

  // 读预设里的参数（kind !== prompt 时 content 是 JSON）。
  // ⚠ 解析失败返回 {} 而不是抛 —— 一条预设坏了不该让整个列表打不开。
  function presetParams(p) {
    if (!p || (p.kind || KIND_PROMPT) === KIND_PROMPT) return {};
    try { return JSON.parse(p.content || '{}') || {}; } catch (_) { return {}; }
  }

  const REF_PREFIX = 'preset.reference.v1:';
  // ⚠ 2026-10-13：原来这里写死 `REF_LIMIT = 12`，与 reference-limits.js 的唯一出处脱节。
  //   现在改成【用时现取】STORED_MAX（= 12，见 reference-limits.js 文件头「例外」）。
  //   ⚠⚠ 为什么不能在模块顶部直接读：脚本加载顺序是 preset-store.js(3278) 在
  //     reference-limits.js(3280) 之前 —— 顶部读会拿到 undefined，把 12 变成 NaN，
  //     结果是"任何参考图都存不进去"，而且是静默的（铁律 17）。
  //   ⚠ 读老预设仍按 12 放行是【有意的】：降到 5 会让已经存了 6~12 张的老预设直接读不出来
  //     （2026-10-02 实装时查到，见 docs/121）。新加的图由闸门卡在 5。
  //   兜底 12 与 reference-limits.js 的 STORED_MAX 一致；读不到就用兜底，行为不变。
  function refLimit() {
    return window.V7ReferenceLimits?.STORED_MAX || 12;
  }
  const REF_BYTES = 96 * 1024 * 1024;
  function referenceError(message) { return Object.assign(new Error(message), {code:'PRESET_REFERENCE_FAILED'}); }
  function referenceDescriptor(asset) {
    return {assetId:asset.assetId, name:String(asset.name || '参考图'), mime:asset.mime,
      width:asset.width, height:asset.height, size:asset.full.size};
  }
  async function createReferenceAsset(input) {
    const row = typeof input === 'string' ? {imageBase64:input} : input || {};
    let full = input instanceof Blob ? input : row.full;
    if (!(full instanceof Blob)) {
      const encoded = String(row.imageBase64 || row.base64 || row.dataUrl || row.dataURL || row.data || '');
      if (!encoded || encoded.length > REF_BYTES * 1.4) throw referenceError('参考图数据为空或过大');
      const url = encoded.startsWith('data:') ? encoded : 'data:' + (row.mime || 'image/png') + ';base64,' + encoded;
      if (!/^data:image\/(png|jpeg|webp);base64,/i.test(url)) throw referenceError('参考图仅支持 PNG、JPEG 或 WebP');
      try { full = await dataUrlToBlob(url); }
      catch (error) {
        // 真实原因带进报错卡和「反馈这个问题」（head 只取前 40 个字符，不带图内容）
        const detail = String(error && (error.name + ': ' + error.message) || error) + (error && error.ownDecodeError ? '；自己解码：' + error.ownDecodeError : '');
        throw Object.assign(referenceError('参考图编码损坏（' + detail + '）'), { detail: detail, size: url.length, head: url.slice(0, 40) });
      }
    }
    if (!/^image\/(png|jpeg|webp)$/i.test(full.type) || !full.size || full.size > REF_BYTES) throw referenceError('参考图格式无效或超过 96 MB');
    const bytes = await full.arrayBuffer();
    // ⚠⚠ 2026-10-18 深夜（线上 8 台机器 459 次 CACHE_WRITE_FAILED「The requested file could not be read…」）：
    //   从磁盘选 / 拖进来的图，full 原来就是那个 File —— 它只是【指向磁盘文件的引用】，以后每次读都回磁盘读。
    //   用户把原文件挪走 / 改了 / 截图工具删了临时文件之后，存缓存时一读就抛，整单缓存（连提示词、记录）都没写成。
    //   ⇒ 这里已经把字节读进内存了，直接换成内存里的副本，以后不再碰磁盘文件。
    if (typeof File !== 'undefined' && full instanceof File) full = new Blob([bytes], { type: full.type });
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const assetId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
    let image;
    try { image = await createImageBitmap(full); } catch (_) { throw referenceError('参考图无法解码'); }
    try {
      const width=image.width,height=image.height;
      if (!width || !height || width * height > 100000000) throw referenceError('参考图尺寸无效或超过一亿像素');
      const tier = async edge => {
        const scale=Math.min(1,edge/Math.max(width,height)), cv=document.createElement('canvas');
        cv.width=Math.max(1,Math.round(width*scale)); cv.height=Math.max(1,Math.round(height*scale));
        cv.getContext('2d').drawImage(image,0,0,cv.width,cv.height);
        return canvasToBlob(cv,'image/png');
      };
      return {assetId,name:String(row.name || input.name || '参考图'),mime:full.type,width,height,full,
        thumb:await tier(256),view:await tier(1600)};
    } finally { image.close(); }
  }
  async function prepareReferenceImages(list, operation = storageOperation()) {
    if (!Array.isArray(list) || list.length > refLimit()) throw referenceError('最多保存 ' + refLimit() + ' 张参考图');
    const assets=[]; let bytes=0;
    for (const row of list) {
      operation.check();
      let asset;
      if (row && row.assetId && !(row.full instanceof Blob)) {
        asset=await dbGet(S_META,REF_PREFIX+row.assetId,operation);
        if (!asset || !(asset.full instanceof Blob)) throw referenceError('预设参考图缺失，请从原设备导出完整预设包后重新导入');
        asset={...asset,name:String(row.name || asset.name)};
      } else if (row && row.full instanceof Blob && row.thumb instanceof Blob && row.view instanceof Blob && row.assetId) asset=row;
      else asset=await createReferenceAsset(row);
      operation.check(); bytes+=asset.full.size;
      if (bytes>REF_BYTES) throw referenceError('参考图总量超过 96 MB');
      assets.push(asset);
    }
    return assets;
  }
  // ⭐ 2026-10-21（docs/261 B1，线上一个用户点了 96 次）：V6 搬家时【一张】参考图读不出来（空 / 格式不对 / 解不开），
  //   以前整批搬家直接失败、一条都进不来，框还开着让人反复点。搬家改成一张一张试：读不出来的跳过、记下来，预设照样搬。
  //   ⚠ 只给搬家用；平时存预设仍走上面严格的 prepareReferenceImages（存坏图要当场报）。
  //   ⚠ 只吞「参考图本身坏了」（PRESET_REFERENCE_FAILED）；换账号 / 存储被打断等照样往上抛。
  async function prepareReferenceImagesLenient(list, operation) {
    const assets=[], skipped=[]; let bytes=0;
    for (const row of (Array.isArray(list) ? list : [])) {
      operation.check();
      const name=String(row && row.name || '参考图');
      if (assets.length >= refLimit()) { skipped.push({name, reason:'超过 ' + refLimit() + ' 张上限'}); continue; }
      let asset;
      try { asset=(await prepareReferenceImages([row],operation))[0]; }
      catch (error) {
        if (!error || error.code !== 'PRESET_REFERENCE_FAILED') throw error;
        skipped.push({name, reason:String(error.message || '读不出来')}); continue;
      }
      if (bytes + asset.full.size > REF_BYTES) { skipped.push({name, reason:'参考图总量超过 96 MB'}); continue; }
      bytes+=asset.full.size; assets.push(asset);
    }
    return {assets, skipped};
  }
  async function resolveReferenceImages(preset, operation = storageOperation()) {
    return prepareReferenceImages(preset && preset.refImages || [],operation);
  }
  async function exportPresetsPortable(list) {
    const operation=storageOperation(), result=JSON.parse(exportPresetsJson(list));
    for (const preset of result.items) {
      const assets=await resolveReferenceImages(preset,operation);
      preset.refImages=[];
      for (const asset of assets) {
        const data=await blobToDataUrl(asset.full); operation.check();
        preset.refImages.push({name:asset.name,mime:asset.mime,imageBase64:data.slice(data.indexOf(',')+1)});
      }
    }
    operation.check(); return JSON.stringify(result,null,2);
  }
  async function savePreset(p, operation = storageOperation()) {
    operation.check();
    const n = normalizePreset(p),previous=presetById(p.id);
    const assets=await prepareReferenceImages(n.refImages,operation);
    n.refImages=assets.map(referenceDescriptor);
    const db=await openDb(operation); operation.check();
    await new Promise((resolve,reject)=>{
      const transaction=db.transaction([S_PRESET,S_META],'readwrite'); storageTransactions.add(transaction);
      transaction.oncomplete=()=>{storageTransactions.delete(transaction);try{operation.check();resolve();}catch(e){reject(e);}};
      transaction.onabort=transaction.onerror=()=>{storageTransactions.delete(transaction);reject(transaction.error||referenceError('参考图保存失败'));};
      try {
        for(const asset of assets)transaction.objectStore(S_META).put(asset,REF_PREFIX+asset.assetId);
        transaction.objectStore(S_PRESET).put(n,n.id);
      } catch(error){transaction.abort();reject(error);}
    });
    const i = mem.presets.findIndex(x => x.id === n.id);
    if (i >= 0) mem.presets[i] = n; else mem.presets.push(n);
    if((previous?.refImages||[]).some(row=>row?.assetId&&!n.refImages.some(ref=>ref.assetId===row.assetId)))await cleanupReferences(operation);
    return n;
  }
  async function deletePreset(id) {
    const operation=storageOperation();
    await dbDel(S_PRESET, id, operation);
    const i = mem.presets.findIndex(x => x.id === id);
    if (i >= 0) mem.presets.splice(i, 1);
    await cleanupReferences(operation);
  }
  async function cleanupReferences(operation=storageOperation()){
    try{
      const db=await openDb(operation);operation.check();
      await new Promise((resolve,reject)=>{
        const t=db.transaction([S_PRESET,S_META],'readwrite');storageTransactions.add(t);
        const ps=t.objectStore(S_PRESET),ms=t.objectStore(S_META),requests=[ps.getAll(),ms.get(V6_MIGRATION_KEY),ms.get('cloud.account.before.v1'),ms.get(TRASH_KEY)];
        let remaining=requests.length;
        const loaded=()=>{
          if(--remaining)return;
          const keep=new Set(),mark=rows=>{for(const preset of rows||[])for(const ref of preset?.refImages||[])if(ref?.assetId)keep.add(REF_PREFIX+ref.assetId);};
          mark(requests[0].result);mark(requests[1].result?.snapshot);mark(requests[1].result?.after);mark(requests[2].result?.presets);
          // 「最近删除」里的预设还能恢复，它们的参考图不能被当成没人用的清掉
          mark((requests[3].result?.items||[]).map(row=>row?.preset));
          const cursor=ms.openKeyCursor(IDBKeyRange.bound(REF_PREFIX,REF_PREFIX+'\uffff'));
          cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(!keep.has(row.key))ms.delete(row.key);row.continue();};
        };
        for(const request of requests)request.onsuccess=loaded;
        t.oncomplete=()=>{storageTransactions.delete(t);try{operation.check();resolve();}catch(error){reject(error);}};
        t.onabort=t.onerror=()=>{storageTransactions.delete(t);reject(t.error||referenceError('参考图清理失败'));};
      });
    }catch(error){operation.check();window.ERR?.report('PRESET_REFERENCE_CLEANUP_FAILED',{message:String(error.message||error)});}
  }
  function presetById(id) { return mem.presets.find(p => p.id === id) || null; }

  // ═══════════════════════════════════════════════════════════
  //  剪影编辑器里的预设管理（2026-10-15 用户定：先做预设管理；「组」= 剪影部位）
  //
  //  编辑器只"摆"，改动在那边暂存；点保存后主窗口调 applyPresetEdits，【一个事务】写完：
  //    updates  挪组 / 改名          [{id, category?, title?, expectUpdatedAt}]
  //    copies   复制一份             [{sourceId, title, category}]
  //    deletes  删除（进「最近删除」）[{id, expectUpdatedAt}]
  //    restores 从「最近删除」恢复   [{id, category, title?}]
  //    purges   彻底删除             [id]
  //  ⚠ 出厂预设（_isFactory，启动时 ensure() 建的工具预设）和 Agent 收件箱里的不让动：
  //    挪走/删掉出厂的，下次启动会被重建成两份。
  //  ⚠ 编辑器开着期间这边又改过的那条（updatedAt 对不上）不动，记进 conflicts 让界面说出来，不静默覆盖。
  //  ⚠ 删除先进「最近删除」（meta 里一份，最多 200 条 / 30 天），参考图跟着留（cleanupReferences 认它）。
  // ═══════════════════════════════════════════════════════════
  const TRASH_KEY = 'preset.trash.v1', TRASH_MAX = 200, TRASH_DAYS = 30;
  const AGENT_INBOX_ID = '__agent_inbox__';
  function presetLocked(p) { return !p || !!p._isFactory || p.category === AGENT_INBOX_ID; }
  function pruneTrash(items, now = Date.now()) {
    return (Array.isArray(items) ? items : []).filter(row => row && row.preset && typeof row.preset.id === 'string' &&
      now - (Date.parse(row.deletedAt) || 0) < TRASH_DAYS * 86400000).slice(-TRASH_MAX);
  }
  async function loadTrash(operation = storageOperation()) {
    const value = await dbGet(S_META, TRASH_KEY, operation);
    return pruneTrash(value && value.items);
  }
  // 复制出来的是"我的"预设：去掉一切会让它被认成内置原件 / V6 原件 / 旧版的标记。
  //   ⚠ 不去的话，下次内置目录升级（importCloudCatalog 按 builtinCatalogId 认旧版）会把副本覆盖掉或标成"已被取代"。
  const COPY_DROP_KEYS = ['builtinCatalogId', 'builtinCatalogVersion', 'supersededBy', 'legacyId', 'sourceHash',
    'sourceRelativePath', 'importedAt', 'order', 'v6OriginalTitle', 'qwenFactory', 'qwenFactoryContent'];
  function copyRecord(src, title, category, now) {
    const out = structuredClone(src);
    COPY_DROP_KEYS.forEach(key => { delete out[key]; });
    return Object.assign(out, { id: uid('p_'), title, category, source: 'local', _isFactory: false, starred: false,
      createdAt: now, updatedAt: now });
  }
  async function applyPresetEdits(edits, operation = storageOperation()) {
    operation.check();
    const list = key => Array.isArray(edits && edits[key]) ? edits[key] : [];
    const validCategory = c => c === UNSORTED_ID || !!assetById(c);
    const cleanTitle = t => String(t == null ? '' : t).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
    const fresh = (row, p) => !row.expectUpdatedAt || String(p.updatedAt || '') === String(row.expectUpdatedAt);
    const now = new Date().toISOString();
    const result = { moved: 0, renamed: 0, copied: 0, deleted: 0, restored: 0, purged: 0, conflicts: [], skipped: 0 };
    const puts = new Map(), removes = new Set();
    const current = id => puts.get(id) || presetById(id);
    const raw = await dbGet(S_META, TRASH_KEY, operation);
    operation.check();
    const rawTrash = Array.isArray(raw && raw.items) ? raw.items : [];
    let trash = pruneTrash(rawTrash);
    let trashChanged = trash.length !== rawTrash.length;   // 过期的顺手清掉

    for (const row of list('updates')) {
      const p = presetById(row && row.id);
      if (!p || presetLocked(p)) { result.skipped++; continue; }
      if (!fresh(row, p)) { result.conflicts.push(p.title); continue; }
      const next = Object.assign({}, current(p.id));
      let changed = false;
      if (row.category !== undefined) {
        const c = validCategory(String(row.category)) ? String(row.category) : UNSORTED_ID;
        // 挪到新组就排到那组末尾：带着旧组的 order 过去会插在莫名其妙的位置
        if (c !== (next.category || UNSORTED_ID)) { next.category = c; delete next.order; result.moved++; changed = true; }
      }
      if (row.title !== undefined) {
        const t = cleanTitle(row.title);
        if (t && t !== next.title) { next.title = t; result.renamed++; changed = true; }
      }
      if (changed) { next.updatedAt = now; puts.set(p.id, next); }
    }
    // 复制在删除之前做：同一批里"复制一份再把原件删掉"要能成立
    for (const row of list('copies')) {
      const src = current(row && row.sourceId);
      if (!src || presetLocked(src)) { result.skipped++; continue; }
      const c = validCategory(String(row.category)) ? String(row.category) : (src.category || UNSORTED_ID);
      const copy = copyRecord(src, cleanTitle(row.title) || (src.title + ' 副本'), validCategory(c) ? c : UNSORTED_ID, now);
      puts.set(copy.id, copy); result.copied++;
    }
    for (const row of list('deletes')) {
      const p = presetById(row && row.id);
      if (!p || presetLocked(p)) { result.skipped++; continue; }
      if (!fresh(row, p)) { result.conflicts.push(p.title); continue; }
      puts.delete(p.id); removes.add(p.id);
      trash.push({ preset: structuredClone(p), deletedAt: now, fromCategory: p.category || UNSORTED_ID });
      result.deleted++; trashChanged = true;
    }
    for (const row of list('restores')) {
      const i = trash.findIndex(item => item.preset.id === (row && row.id));
      if (i < 0) { result.skipped++; continue; }
      let rec = structuredClone(trash[i].preset);
      const wanted = row.category !== undefined ? String(row.category) : String(rec.category || '');
      const c = validCategory(wanted) ? wanted : UNSORTED_ID;
      const t = cleanTitle(row.title) || rec.title;
      // 同编号已经又有一条了（比如内置目录升级把它装回来了）→ 恢复成一条新的"我的"，不顶掉现有那条
      if (presetById(rec.id) || puts.has(rec.id)) rec = copyRecord(rec, t, c, now);
      else { rec.category = c; rec.title = t; delete rec.order; rec.updatedAt = now; }
      trash.splice(i, 1); puts.set(rec.id, rec); result.restored++; trashChanged = true;
    }
    for (const id of list('purges')) {
      const i = trash.findIndex(item => item.preset.id === id);
      if (i >= 0) { trash.splice(i, 1); result.purged++; trashChanged = true; }
    }
    const capped = pruneTrash(trash);
    if (capped.length !== trash.length) { trash = capped; trashChanged = true; }
    // 离开「最近删除」又不是恢复回去的（彻底删除 / 过期 / 超过 200 条挤掉的）→ 它们的参考图要清
    const dropped = rawTrash.length + result.deleted - result.restored - trash.length;
    if (!puts.size && !removes.size && !trashChanged) return result;

    const db = await openDb(operation); operation.check();
    await new Promise((resolve, reject) => {
      const t = db.transaction([S_PRESET, S_META], 'readwrite'); storageTransactions.add(t);
      t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(); } catch (error) { reject(error); } };
      t.onabort = t.onerror = () => {
        storageTransactions.delete(t);
        try { operation.check(); } catch (error) { reject(error); return; }
        reject(t.error || Object.assign(new Error('预设改动没写进去，原样保留'), { code: 'PRESET_SAVE_FAILED' }));
      };
      try {
        const ps = t.objectStore(S_PRESET);
        for (const [id, rec] of puts) ps.put(rec, id);
        for (const id of removes) ps.delete(id);
        if (trashChanged) t.objectStore(S_META).put({ items: trash }, TRASH_KEY);
      } catch (error) { try { t.abort(); } catch (_) { } reject(error); }
    });
    // 内存只跟已经提交的走（事务失败上面就抛了，内存一条不动）
    for (const id of removes) { const i = mem.presets.findIndex(x => x.id === id); if (i >= 0) mem.presets.splice(i, 1); }
    for (const [id, rec] of puts) { const i = mem.presets.findIndex(x => x.id === id); if (i >= 0) mem.presets[i] = rec; else mem.presets.push(rec); }
    if (dropped > 0) await cleanupReferences(operation);
    return result;
  }

  // ⭐ 千问模式出厂预设（2026-10-15 用户给的 98 个千问提示词，ui-pure/qwen-factory-presets.js）。
  //   装进本账号时打上 presetSet='qwen'（普通模式看不见，见 inMode）。
  //   版本变高才动：没改过提示词的跟着出厂更新，改过的留用户的（qwenFactoryContent 记着出厂原文用来比）；
  //   用户挪过的部位、改过的名字、收藏、排序都不动；进了「最近删除」的不再装回来。
  const QWEN_FACTORY_META = 'qwenFactoryVersion';
  async function installQwenFactory(bundle, operation = storageOperation()) {
    operation.check();
    const version = Number(bundle && bundle.version) || 0;
    const items = Array.isArray(bundle && bundle.items) ? bundle.items : [];
    if (!version || !items.length) return { skipped: true };
    const meta = await loadMeta(operation); operation.check();
    if (Number(meta[QWEN_FACTORY_META] || 0) >= version) return { skipped: true, alreadyInstalled: true };
    const raw = await dbGet(S_META, TRASH_KEY, operation); operation.check();
    const trashed = new Set((raw && Array.isArray(raw.items) ? raw.items : []).map(row => row && row.preset && row.preset.id));
    const now = new Date().toISOString(), puts = [];
    let added = 0, updated = 0, kept = 0;
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.content || trashed.has(item.id)) continue;
      const fresh = { kind: KIND_PROMPT, presetSet: 'qwen', source: 'qwen-factory', qwenFactory: version, qwenFactoryContent: item.content,
        qwenImages: item.qwenImages || 1, qwenNote: item.qwenNote || '', qwenOutputLayer: item.qwenOutputLayer || '', sourceTitle: item.sourceTitle || '' };
      const current = presetById(item.id);
      if (!current) {
        puts.push(normalizePreset(Object.assign({ id: item.id, title: item.title, content: item.content,
          category: assetById(item.category) ? item.category : UNSORTED_ID, order: item.order, createdAt: now, updatedAt: now }, fresh)));
        added++;
        continue;
      }
      const edited = typeof current.qwenFactoryContent === 'string' && current.content !== current.qwenFactoryContent;
      const next = Object.assign({}, current, fresh, { content: edited ? current.content : item.content, updatedAt: now });
      if (edited) kept++; else updated++;
      puts.push(next);
    }
    if (puts.length) {
      const db = await openDb(operation); operation.check();
      await new Promise((resolve, reject) => {
        const t = db.transaction(S_PRESET, 'readwrite'); storageTransactions.add(t);
        t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(); } catch (error) { reject(error); } };
        t.onabort = t.onerror = () => { storageTransactions.delete(t); try { operation.check(); } catch (error) { reject(error); return; } reject(t.error || new Error('开源模型出厂预设没写进去')); };
        try { const store = t.objectStore(S_PRESET); for (const rec of puts) store.put(rec, rec.id); }
        catch (error) { try { t.abort(); } catch (_) { } reject(error); }
      });
      for (const rec of puts) { const i = mem.presets.findIndex(x => x.id === rec.id); if (i >= 0) mem.presets[i] = rec; else mem.presets.push(rec); }
    }
    await saveMeta({ [QWEN_FACTORY_META]: version }, operation);
    return { version, added, updated, kept };
  }

  // ⭐ 云端官方预设同步（2026-10-15 用户定：连上云端就把预设拉下来，结果放报错栏）。
  //   云端只给参数说明，不给工作流本体（后台 display_preset 删掉了），这种预设只能平台跑（workflow-runtime 会拦本地）。
  //   规则：新的加进来；已有的（同编号 / 软件自带那份）不动名字、部位、收藏、排序，提示词改过的留用户的；
  //   下拉选项（模型 / LoRA / 采样器）换成云端最新的，选着的被下架了就回默认；
  //   本机带完整工作流的那份只换选项、不动结构（保证还能本地跑）；用户自己的预设、「最近删除」里的一律不碰。
  const OFFICIAL_META = 'cloudOfficialHash';
  async function syncOfficialPresets(bundle, operation = storageOperation()) {
    operation.check();
    const items = Array.isArray(bundle && bundle.items) ? bundle.items.filter(item => item && typeof item.id === 'string' && item.id && item.title) : [];
    const hash = String(bundle && bundle.hash || '');
    const meta = await loadMeta(operation); operation.check();
    if (hash && meta[OFFICIAL_META] === hash) return { skipped: true, unchanged: true, added: 0, updated: 0 };
    const raw = await dbGet(S_META, TRASH_KEY, operation); operation.check();
    const trashed = new Set((raw && Array.isArray(raw.items) ? raw.items : []).map(row => row && row.preset && row.preset.id));
    const now = new Date().toISOString(), puts = [];
    let added = 0, updated = 0;
    const hasGraph = p => !!(p && p.workflow && typeof p.workflow === 'object' && Object.values(p.workflow).some(node => node && typeof node === 'object' && node.class_type));
    for (const item of items) {
      const existing = mem.presets.find(p => !p.supersededBy && (p.cloudOfficialId === item.id || p.builtinCatalogId === item.id || p.id === item.id || p.id === 'cloud-' + item.id));
      if (!existing) {
        if (trashed.has('cloud-' + item.id)) continue;
        puts.push(normalizePreset(Object.assign(JSON.parse(JSON.stringify(item)), {
          id: 'cloud-' + item.id, source: 'cloud-official', cloudOfficialId: item.id, cloudOfficialContent: item.content || '',
          category: assetById(item.category) ? item.category : UNSORTED_ID, _isFactory: false, starred: false, createdAt: now, updatedAt: now })));
        added++;
        continue;
      }
      const next = JSON.parse(JSON.stringify(existing));
      next.cloudOfficialId = item.id;
      // 提示词：记得住出厂原文的，没改过才跟着换；记不住的（软件自带那份）先看一样不一样，一样才开始记
      if (typeof existing.cloudOfficialContent === 'string') {
        if (existing.content === existing.cloudOfficialContent && typeof item.content === 'string') next.content = item.content;
        next.cloudOfficialContent = item.content || '';
      } else if (existing.content === item.content) next.cloudOfficialContent = item.content || '';
      const fresh = new Map((item.parameterBindings || []).map(binding => [binding.key, binding]));
      if (hasGraph(existing)) {
        // 本机能跑的那份：只换下拉选项，结构（节点编号）不动
        (next.parameterBindings || []).forEach(binding => {
          const upstream = fresh.get(binding.key);
          if (binding.selectable && upstream && upstream.selectable && Array.isArray(upstream.options)) binding.options = upstream.options.slice();
        });
      } else {
        ['parameterBindings', 'promptBindings', 'inputNodeIds', 'referenceNodeIds', 'outputNodeIds', 'batchBinding', 'platformPresetId', 'workflow', 'platformOnly']
          .forEach(key => { if (item[key] !== undefined) next[key] = JSON.parse(JSON.stringify(item[key])); });
      }
      // 选着的选项被云端下架了 → 回默认（不然一发请求就被后台拒）
      (next.parameterBindings || []).forEach(binding => {
        if (!binding.selectable || !Array.isArray(binding.options) || !next.parameters || next.parameters[binding.key] === undefined) return;
        if (binding.options.indexOf(next.parameters[binding.key]) < 0) next.parameters[binding.key] = binding.default;
      });
      if (JSON.stringify(next) !== JSON.stringify(existing)) { next.updatedAt = now; puts.push(next); updated++; }
    }
    if (puts.length) {
      const db = await openDb(operation); operation.check();
      await new Promise((resolve, reject) => {
        const t = db.transaction(S_PRESET, 'readwrite'); storageTransactions.add(t);
        t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(); } catch (error) { reject(error); } };
        t.onabort = t.onerror = () => { storageTransactions.delete(t); try { operation.check(); } catch (error) { reject(error); return; } reject(t.error || new Error('云端预设没写进去')); };
        try { const store = t.objectStore(S_PRESET); for (const rec of puts) store.put(rec, rec.id); }
        catch (error) { try { t.abort(); } catch (_) { } reject(error); }
      });
      for (const rec of puts) { const i = mem.presets.findIndex(x => x.id === rec.id); if (i >= 0) mem.presets[i] = rec; else mem.presets.push(rec); }
    }
    if (hash) await saveMeta({ [OFFICIAL_META]: hash }, operation);
    return { added, updated, total: items.length };
  }

  // ⭐ 2026-10-24 晚：云端预设库（V7待办/16 简化版，后端 backend/cloud_presets.py，入口 cloud-presets.js）。用户定的规则：
  //   · 本机没有 → 加上（能改能删，不锁）；本机有一条内容一样的（比如 V6 搬家搬来的那份）→ 不新加，把云端编号认领到那条上；
  //   · 没改过（本机指纹 == 上次下载时的云端指纹）→ 跟着更新；改过 → 留用户的；
  //   · 用户删过（下载过、现在本机没有了：在最近删除里 / 彻底删了）→ 不再放回；后台点名 + force 下发才放回；
  //   · 云端撤下 → 本机的一律不删，只是不再更新（去掉跟云端的关联）。
  //   用户改名、挪部位、收藏、排序：一律不碰。指纹只用 V6Migration.contentHash（全项目唯一一份）。
  //   meta：cloudLibraryCursor（增量游标）、cloudLibrarySeen（下载过的云端编号 —— 分得清「没下过」和「删过」）。
  const CLOUD_LIB_CURSOR = 'cloudLibraryCursor', CLOUD_LIB_SEEN = 'cloudLibrarySeen';
  async function syncCloudLibrary(bundle, operation = storageOperation()) {
    operation.check();
    const hashOf = window.V6Migration && window.V6Migration.contentHash;
    if (typeof hashOf !== 'function') throw Object.assign(new Error('去重规则没加载（v6-migration.js）'), { code: 'CLOUD_LIBRARY_UNAVAILABLE' });
    const items = Array.isArray(bundle && bundle.items) ? bundle.items.filter(i => i && typeof i.id === 'string' && i.id && i.title && /^[0-9a-f]{64}$/.test(i.contentHash || '')) : [];
    const meta = await loadMeta(operation); operation.check();
    const seen = new Set(Array.isArray(meta[CLOUD_LIB_SEEN]) ? meta[CLOUD_LIB_SEEN] : []);
    const now = new Date().toISOString(), puts = new Map();
    const result = { added: 0, updated: 0, claimed: 0, keptYours: 0, skippedDeleted: 0, withdrawn: 0, total: items.length };
    // 本机每条提示词预设的指纹（一次算好；工具类、千问那套、Agent 收件箱不参加）
    const local = [];
    for (const p of mem.presets) {
      if (p.supersededBy || p.presetSet === 'qwen' || (p.kind && p.kind !== 'prompt') || p.category === AGENT_INBOX_ID) continue;
      local.push({ p, hash: await hashOf(p) }); operation.check();
    }
    for (const item of items) {
      const mine = mem.presets.find(p => p.cloudPresetId === item.id);
      if (item.status === 'withdrawn') {
        // 撤下：本机的不删，只是断开（以后不再跟着更新）
        if (mine) { const next = structuredClone(puts.get(mine.id) || mine); delete next.cloudPresetId; delete next.cloudContentHash; delete next.cloudVersion; next.cloudWithdrawnAt = now; puts.set(next.id, next); result.withdrawn++; }
        continue;
      }
      if (mine) {
        const current = await hashOf(mine); operation.check();
        if (current === item.contentHash) { if (mine.cloudContentHash !== item.contentHash) { const next = structuredClone(mine); next.cloudContentHash = item.contentHash; next.cloudVersion = item.version; puts.set(next.id, next); } continue; }
        if (current !== mine.cloudContentHash) { result.keptYours++; continue; }       // 用户改过 ⇒ 留他的
        const next = structuredClone(mine);
        next.content = item.content; next.negativePrompt = item.negativePrompt || '';
        next.cloudContentHash = item.contentHash; next.cloudVersion = item.version; next.updatedAt = now;
        puts.set(next.id, next); result.updated++;
        continue;
      }
      // 本机没有挂这个云端编号的
      if (seen.has(item.id) && !item.force) { result.skippedDeleted++; continue; }       // 下载过、被用户删了 ⇒ 不放回
      const twin = local.find(row => row.hash === item.contentHash && !row.p.cloudPresetId && !puts.has(row.p.id));
      if (twin) {                                                                          // 内容一样的（搬家来的那份）⇒ 认领，不新加
        const next = structuredClone(twin.p);
        next.cloudPresetId = item.id; next.cloudContentHash = item.contentHash; next.cloudVersion = item.version;
        if (next._isFactory && next.source === 'v6') { delete next._isFactory; next.v6Factory = true; }   // 认领到的一律能改
        // 搬家时撞名加的「 V2」：跟云端同名、而且这个名字空着 ⇒ 改回去（跟去重的规矩一样）
        if (next.title !== item.title && /\sV[2-9]\d*$/.test(next.title || '') && next.title.replace(/\sV[2-9]\d*$/, '') === item.title
          && !mem.presets.some(p => p.id !== next.id && p.title === item.title)) next.title = item.title;
        puts.set(next.id, next); seen.add(item.id); result.claimed++;
        continue;
      }
      let id = 'cloudlib-' + item.id;
      if (mem.presets.some(p => p.id === id)) id += '~' + Date.now().toString(36);
      puts.set(id, normalizePreset({
        id, kind: 'prompt', title: item.title, content: item.content, negativePrompt: item.negativePrompt || '',
        category: assetById(item.category) ? item.category : UNSORTED_ID, source: 'cloud-library',
        cloudPresetId: item.id, cloudContentHash: item.contentHash, cloudVersion: item.version,
        _isFactory: false, starred: false, refImages: [], createdAt: now, updatedAt: now }));
      seen.add(item.id); result.added++;
    }
    for (const rec of puts.values()) if (rec.cloudPresetId) seen.add(rec.cloudPresetId);
    if (puts.size) {
      const db = await openDb(operation); operation.check();
      await new Promise((resolve, reject) => {
        const t = db.transaction(S_PRESET, 'readwrite'); storageTransactions.add(t);
        t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(); } catch (error) { reject(error); } };
        t.onabort = t.onerror = () => { storageTransactions.delete(t); try { operation.check(); } catch (error) { reject(error); return; } reject(t.error || new Error('云端预设没写进去')); };
        try { const store = t.objectStore(S_PRESET); for (const rec of puts.values()) store.put(rec, rec.id); }
        catch (error) { try { t.abort(); } catch (_) { } reject(error); }
      });
      for (const rec of puts.values()) { const i = mem.presets.findIndex(x => x.id === rec.id); if (i >= 0) mem.presets[i] = rec; else mem.presets.push(rec); }
    }
    // 游标和「下载过的」跟预设一起才算数：预设没写进去（上面抛了）就不往前挪，下次重拉
    await saveMeta({ [CLOUD_LIB_CURSOR]: String(bundle && bundle.cursor || meta[CLOUD_LIB_CURSOR] || ''), [CLOUD_LIB_SEEN]: Array.from(seen) }, operation);
    result.changed = puts.size;
    return result;
  }
  function cloudLibraryCursor() { return loadMeta().then(m => String(m[CLOUD_LIB_CURSOR] || '')); }
  function cloudLibraryCount() { return mem.presets.filter(p => p.cloudPresetId).length; }

  // 一组内的排序: 收藏在前, 然后按 order, 没 order 的按名字垫底
  function sortGroup(list) {
    return list.slice().sort((a, b) => {
      if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
      const ao = typeof a.order === 'number' ? a.order : 1e9;
      const bo = typeof b.order === 'number' ? b.order : 1e9;
      if (ao !== bo) return ao - bo;
      return String(a.title).localeCompare(String(b.title), 'zh');
    });
  }
  // ⭐ 千问模式（2026-10-15 用户定：两套预设分开）：列表 / 计数 / 搜索 / 拖动排序只认当前这一套，
  //   规则在 qwen-mode.js 的 visible（工具类、Agent 收件箱两边都显示）。
  //   没加载 qwen-mode.js 时（测试、老壳）：千问那套一律不显示，普通模式行为跟以前完全一样。
  function inMode(p) { return window.V7QwenMode ? window.V7QwenMode.visible(p) : !(p && p.presetSet === 'qwen'); }
  function listByCategory(cat) {
    const all = (cat ? mem.presets.filter(p => (p.category || UNSORTED_ID) === cat) : mem.presets.slice()).filter(inMode);
    return sortGroup(all);
  }
  // Read current records and commit every order in one transaction; memory follows commit.
  async function reorder(cat, orderedIds, operation = storageOperation()) {
    operation.check();
    const invalid = () => Object.assign(new Error('预设列表已变化，请重新拖动排序'), { code: 'PRESET_SAVE_FAILED' });
    if (!Array.isArray(orderedIds) || orderedIds.some(id => typeof id !== 'string' || !id) || new Set(orderedIds).size !== orderedIds.length) throw invalid();
    const ids = orderedIds.slice(), category = cat || null;
    const db = await openDb(operation); operation.check();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(S_PRESET, 'readwrite');
      storageTransactions.add(transaction);
      let failure = null;
      transaction.oncomplete = () => {
        storageTransactions.delete(transaction);
        try {
          operation.check();
          ids.forEach((id, order) => { const preset = presetById(id); if (preset) preset.order = order; });
          resolve();
        } catch (error) { reject(error); }
      };
      transaction.onabort = transaction.onerror = () => {
        storageTransactions.delete(transaction);
        try { operation.check(); reject(failure || transaction.error || new Error('预设排序未保存，原顺序已保留')); }
        catch (error) { reject(error); }
      };
      const store = transaction.objectStore(S_PRESET), request = store.getAll();
      request.onsuccess = () => {
        try {
          operation.check();
          // 只核对当前这一套（千问模式两套预设分开：同一个部位里另一套的预设界面上看不到，不参与排序）
          const records = request.result.filter(preset => (!category || (preset.category || UNSORTED_ID) === category) && inMode(preset));
          const byId = new Map(records.map(preset => [preset.id, preset]));
          if (records.length !== ids.length || ids.some(id => !byId.has(id))) throw invalid();
          ids.forEach((id, order) => store.put({ ...byId.get(id), order }, id));
        } catch (error) {
          failure = error;
          // Account changes can already have aborted this transaction.
          try { transaction.abort(); } catch (_) { reject(error); }
        }
      };
    });
  }
  function countByCategory() {
    const m = {};
    mem.presets.forEach(p => { if (!inMode(p)) return; const c = p.category || UNSORTED_ID; m[c] = (m[c] || 0) + 1; });
    return m;
  }

  // ═══════════════════════════════════════════════════════════
  //  搜索: 中文子串 + 拼音首字母
  //  ⚠ V6 是手打 360 字表, 只覆盖它自带预设的字。这里用常用字表(见 pinyin-initials.js),
  //    覆盖面大得多, 但仍不是全字库 —— 生僻字搜不到是已知限制, 不是 bug。
  // ═══════════════════════════════════════════════════════════
  function initials(str) {
    const py = window.PYIN;
    let r = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      r += py ? py.of(ch) : ch.toLowerCase();
    }
    return r;
  }
  function compactSub(text, q, maxGap) {
    let ti = 0, qi = 0, last = -1;
    while (ti < text.length && qi < q.length) {
      if (text.charAt(ti) === q.charAt(qi)) {
        if (last < 0 || (ti - last - 1) <= maxGap) { last = ti; qi++; }
      }
      ti++;
    }
    return qi === q.length;
  }
  function fuzzyScore(text, q) {
    if (!text || !q) return 0;
    const name = String(text).toLowerCase();
    if (name.indexOf(q) >= 0) return 100;
    if (q.length >= 2 && initials(String(text)).indexOf(q) >= 0) return 80;
    if (q.length >= 2 && compactSub(name, q, 2)) return 60;
    return 0;
  }
  function search(query, cat) {
    const q = String(query || '').trim().toLowerCase();
    let base = (cat ? mem.presets.filter(p => (p.category || UNSORTED_ID) === cat) : mem.presets.slice()).filter(inMode);
    if (!q) return sortGroup(base);
    const scored = [];
    base.forEach(p => {
      const a = assetById(p.category);
      let s = 0;
      s = Math.max(s, fuzzyScore(p.title, q) * 1.0);
      if (a) s = Math.max(s, fuzzyScore(a.name, q) * 0.5);
      if (p.content && String(p.content).toLowerCase().indexOf(q) >= 0) s = Math.max(s, 30);
      if (s > 0) scored.push({ p, s });
    });
    scored.sort((x, y) => y.s - x.s);
    // 收藏仍然置顶, 组内保持分数序
    const arr = scored.map(x => x.p);
    return arr.filter(p => p.starred).concat(arr.filter(p => !p.starred));
  }

  // ═══════════════════════════════════════════════════════════
  //  从 V6 搬家
  //  ⚠ 实测这台机器有 8 个 V6 预设目录(不同 PS 版本 / Developer+External /
  //    不同插件 id), 各自有独有的用户预设 —— 必须全扫再合并去重。
  // ═══════════════════════════════════════════════════════════
  function fsApi() { return (window.uiwin && window.uiwin.presetfs) || null; }

  async function scanV6() {
    const fs = fsApi();
    if (!fs || !fs.findV6) return { ok: false, error: '当前壳没有提供文件接口', dirs: [], items: [] };
    let dirs;
    try { dirs = (await fs.findV6()) || []; }
    catch (e) { return { ok: false, error: '扫描失败: ' + (e && e.message || e), dirs: [], items: [] }; }
    const manifest = { schema: 'wheelchair-v7-v6-migration-manifest', schemaVersion: 1,
      sourceRoot: 'V6 UXP preset directories', generatedAt: new Date().toISOString(), entries: [] };
    let raw = 0;
    const directoryErrors = [];
    for (const d of dirs) {
      let files;
      try { files = (await fs.scanDir(d.path || d)) || []; }
      catch (error) { directoryErrors.push({ path: d.path || d, error: String(error.message || error) }); continue; }
      raw += files.length;
      const scan = migrationPlanner().manifestFromFiles(files, d.path || d, d.kind);
      scan.entries.forEach(entry => { entry.sourceRelativePath = String(d.path || d) + '/' + entry.sourceFile; });
      manifest.entries.push(...scan.entries);
    }
    const plan = migrationPlanner().planImport(manifest, []);
    const items = plan.records.filter(r => r.action === 'add').map(r => r.item);
    return { ok: true, dirs, items, manifest, raw, directoryErrors,
      bad: manifest.entries.filter(entry => !entry.parseOk).length,
      unique: items.length, forgeCount: items.filter(p => p.sourceKind === 'forge').length,
      userCount: items.filter(p => !p.v6Factory).length };
  }

  function presetSignature(p) {
    return JSON.stringify({ kind: p.kind || KIND_PROMPT, title: p.title || '', content: p.content || '', category: p.category || '', refImages: (p.refImages || []).map(row=>row&&row.assetId?{assetId:row.assetId,name:row.name||'参考图'}:row),
      provider:p.provider || '', workflow:p.workflow || null, parameters:p.parameters || null,
      parameterBindings:p.parameterBindings || null, promptBindings:p.promptBindings || null,
      inputNodeIds:p.inputNodeIds || null, referenceNodeIds:p.referenceNodeIds || null, outputNodeIds:p.outputNodeIds || null, batchBinding:p.batchBinding || null });
  }

  function nextVersionTitle(base, knownTitles) {
    let version = 2;
    let title = String(base || '未命名') + ' V' + version;
    while (knownTitles.has(title)) title = String(base || '未命名') + ' V' + (++version);
    return { title, version };
  }

  // 把扫到的预设写进库。相同 id/内容跳过；同名不同内容保留并生成 V2/V3。
  async function importPresets(items, opts, operation = storageOperation()) {
    operation.check();
    opts = opts || {};
    if (!Array.isArray(items) && items && Array.isArray(items.items)) items = items.items;
    if (!Array.isArray(items)) items = [];
    // Validate every image before committing any preset from a portable file.
    const prepared=[];
    for(const item of items) prepared.push({...item,refImages:await prepareReferenceImages(item.refImages||[],operation)});
    let added = 0, skipped = 0, replaced = 0;
    const knownIds = new Set(mem.presets.map(p => p.id));
    const knownTitles = new Set(mem.presets.map(p => p.title));
    const validCats = new Set(mem.assets.map(a => a.id));
    for (const it of prepared) {
      operation.check();
      const n = normalizePreset(it);
      // 分类对不上任何素材 → 丢进未分类, 不让它凭空消失
      if (!validCats.has(n.category)) n.category = UNSORTED_ID;
      const dupId = knownIds.has(n.id);
      const sameContent = mem.presets.some(p => presetSignature(p) === presetSignature(n));
      if (dupId || sameContent) {
        if (!opts.overwrite) { skipped++; continue; }
        const old = dupId ? presetById(n.id) : mem.presets.find(p => presetSignature(p) === presetSignature(n));
        if (old) n.id = old.id;
        replaced++;
      } else {
        if (knownTitles.has(n.title)) {
          const versioned = nextVersionTitle(n.title, knownTitles);
          n.title = versioned.title;
          n.version = versioned.version;
        } else if (!n.version) n.version = 1;
        n.importedAt = new Date().toISOString();
        added++;
      }
      await savePreset(n, operation);
      knownIds.add(n.id); knownTitles.add(n.title);
    }
    return { added, skipped, replaced };
  }

  // Import the built-in Forge -> ComfyUI catalog through the same IndexedDB
  // path as user/V6 presets. The workflow stays a normal `provider: comfyui`
  // preset, while sourceKind/legacyForgeParameters keep the migration audit.
  async function importComfyCatalog(catalog, opts, operation = storageOperation()) {
    operation.check();
    opts = opts || {};
    const items = catalog && catalog.presets && typeof catalog.presets === 'object'
      ? Object.values(catalog.presets) : Array.isArray(catalog) ? catalog : [];
    const version = Number(catalog && catalog.version) || 1;
    if (version >= 3) return importCloudCatalog(items, version, operation);
    const result = await importPresets(items.map(item => Object.assign({
      source: 'comfyui-migration', importedAt: item.importedAt || new Date().toISOString()
    }, item, version > 1 ? {id:String(item.id)+'@catalog-v'+version, builtinCatalogId:item.id, builtinCatalogVersion:version} : {})), opts, operation);
    operation.check();
    if (version > 1) {
      for (const item of items) {
        const old = presetById(item.id);
        if (old && old.source === 'comfyui-migration' && old.sourceKind === 'forge' &&
            Object.values(old.workflow || {}).some(node => /^TextEncodeQwenImageEdit/.test(node.class_type || ''))) {
          await savePreset(Object.assign({}, old, {needsReview:true, supersededBy:String(item.id)+'@catalog-v'+version,
            migrationState:'superseded-invalid-template', metadata:Object.assign({}, old.metadata, {
              supersededReason:'Earlier Forge conversion used a different model family; use the Aki-compatible catalog revision.'
            })}), operation);
        }
      }
    }
    return Object.assign({ catalogVersion: catalog && catalog.version || 1 }, result);
  }

  // ⭐ 2026-10-15 内置目录 v3（docs/220）：原厂预设改成「云端通用模板 + 参数」。
  //   同一个原厂预设的旧版本（v1 原编号 / v2「@catalog-v2」）【原地升级】：保留编号、收藏、排序、
  //   用户挪过的分类，用户改过提示词就留用户的；不新建第二份，免得列表里新旧并排。
  //   同一个原厂预设如果旧库里同时有 v1 和 v2，只升级一条，另一条标「已被新版取代」挡住生成。
  async function importCloudCatalog(items, version, operation) {
    let added = 0, replaced = 0, skipped = 0;
    for (const item of items) {
      operation.check();
      const baseId = String(item.id);
      const current = presetById(baseId + '@catalog-v' + version);
      if (current) { skipped++; continue; }
      const older = mem.presets.filter(p => p.source === 'comfyui-migration' && !p.supersededBy &&
        (p.builtinCatalogId === baseId || p.id === baseId) && (Number(p.builtinCatalogVersion) || 1) < version)
        .sort((a, b) => (Number(b.builtinCatalogVersion) || 1) - (Number(a.builtinCatalogVersion) || 1));
      const fresh = Object.assign({}, JSON.parse(JSON.stringify(item)), {
        source: 'comfyui-migration', builtinCatalogId: baseId, builtinCatalogVersion: version,
        importedAt: new Date().toISOString()
      });
      if (!older.length) {
        await savePreset(Object.assign(fresh, { id: baseId + '@catalog-v' + version }), operation);
        added++;
        continue;
      }
      const keep = older[0];
      const factoryPrompt = String((keep.legacyForgeParameters && keep.legacyForgeParameters.positivePrompt) || '').trimEnd();
      const userEditedPrompt = typeof keep.content === 'string' && keep.content.trimEnd() !== factoryPrompt && keep.content !== fresh.content;
      await savePreset(Object.assign(fresh, {
        id: keep.id, title: keep.title || fresh.title, category: keep.category || fresh.category,
        starred: keep.starred, order: keep.order, createdAt: keep.createdAt,
        content: userEditedPrompt ? keep.content : fresh.content
      }), operation);
      replaced++;
      for (const extra of older.slice(1)) {
        await savePreset(Object.assign({}, extra, { needsReview: true, supersededBy: keep.id, migrationState: 'superseded',
          reviewReasons: ['这条是旧版，已升级到「' + (keep.title || baseId) + '」'] }), operation);
      }
    }
    return { catalogVersion: version, added, replaced, skipped };
  }

  // V6 用户自己的 Forge 预设：导入时是「待验证」（只存了参数），这里用内置目录里的云端模板翻成能跑的。
  // 只动还跑不了的（needsReview / 没有 workflow）且是用旧目录翻过的；已经能跑的不碰，免得冲掉用户改动。
  // 云端以后装了更多模型（目录版本变高），之前因为"云端没有这个模型"挡住的会自动再试一次。
  async function upgradeLegacyForgePresets(catalog, operation = storageOperation()) {
    const convert = window.V7ForgeConvert;
    if (!convert || !catalog || !catalog.templates || Number(catalog.version) < 3) return { skipped: true };
    let converted = 0, blocked = 0;
    for (const p of mem.presets.slice()) {
      operation.check();
      if (p.source === 'comfyui-migration' || p.sourceKind !== 'forge' || !p.legacyForgeParameters) continue;
      if (p.workflow && !p.needsReview) continue;
      if ((Number(p.forgeConversion && p.forgeConversion.catalogVersion) || 0) >= Number(catalog.version)) continue;
      const result = convert.convert(p.legacyForgeParameters, catalog);
      const next = convert.toPreset(result, p, catalog);
      // 用户在 V7 里改过提示词就留用户的（V6 原文还在 legacyForgeParameters 里）。
      const original = String(p.legacyForgeParameters.positivePrompt || p.legacyForgeParameters.prompt || '').trimEnd();
      if (typeof p.content === 'string' && p.content.trimEnd() !== original) next.content = p.content;
      await savePreset(next, operation);
      if (result.ok) converted++; else blocked++;
    }
    return { converted, blocked };
  }

  // ═══════════════════════════════════════════════════════════
  //  V6 manifest import (reviewed, reversible)
  //
  //  The command-line migrator is intentionally read-only.  This browser-side
  //  entry point is the only place that writes a reviewed manifest into the
  //  user's IndexedDB.  It keeps one complete preset snapshot and a report so
  //  a failed/undesired migration can be restored without touching V6.
  // ═══════════════════════════════════════════════════════════
  const V6_MIGRATION_KEY = 'v6.migration.latest';
  const V6_REPORT_KEY = 'v6.migration.report';

  function migrationPlanner() {
    if (!window.V6Migration) throw new Error('V6_MIGRATION_PLANNER_UNAVAILABLE');
    return window.V6Migration;
  }
  function planV6Manifest(manifest, opts) {
    return migrationPlanner().planImport(manifest, mem.presets, Object.assign({}, opts, {
      validCategories: mem.assets.map(a => a.id)
    }));
  }

  // Snapshot, presets, canvas migration flag and report commit in ONE IDB
  // transaction. Any quota, serialization or abort failure rolls all of them
  // back; no half-import and no early modification of the memory mirror.
  function migrationTransaction(operation, storage = storageOperation()) {
    const scope = dbName();
    return openDb(storage).then(db => new Promise((resolve, reject) => {
      storage.check();
      if (scope !== dbName() || db.name !== scope) { reject(new Error('V6_MIGRATION_ACCOUNT_CHANGED')); return; }
      const t = db.transaction([S_PRESET, S_META], 'readwrite');
      storageTransactions.add(t);
      const presetStore = t.objectStore(S_PRESET), metaStore = t.objectStore(S_META);
      const current = [];
      let latest, meta, result, failure, pending = 3;
      const ready = () => {
        if (--pending !== 0) return;
        try {
          storage.check();
          if (scope !== dbName()) throw new Error('V6_MIGRATION_ACCOUNT_CHANGED');
          result = operation({ current, latest, meta, presetStore, metaStore });
        } catch (error) { failure = error; try { t.abort(); } catch (_) { /* Already aborted by IDB. */ } }
      };
      const cursor = presetStore.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (entry) { current.push(entry.value); entry.continue(); } else ready();
      };
      const latestRequest = metaStore.get(V6_MIGRATION_KEY);
      latestRequest.onsuccess = () => { latest = latestRequest.result; ready(); };
      const metaRequest = metaStore.get(META_KEY);
      metaRequest.onsuccess = () => { meta = metaRequest.result || {}; ready(); };
      t.onabort = () => {storageTransactions.delete(t);reject(failure || t.error || new Error('V6_MIGRATION_WRITE_ABORTED'));};
      t.onerror = () => { failure = failure || t.error; };
      t.oncomplete = () => {
        storageTransactions.delete(t);
        try{storage.check();}catch(error){reject(error);return;}
        // A login can change scope while disk commits; never put another
        // account's records into the newly bound UI memory.
        if (scope !== dbName()) { reject(new Error('V6_MIGRATION_ACCOUNT_CHANGED_AFTER_COMMIT')); return; }
        if (result && result.presets) mem.presets = result.presets;
        resolve(result.report);
      };
    }));
  }

  async function importV6Manifest(manifest, opts) {
    opts = opts || {};
    if (!opts.confirm) throw new Error('V6_MIGRATION_CONFIRMATION_REQUIRED');
    const storage=storageOperation(),referenceAssets=new Map(),refSkipped=[];
    const selected=new Set(migrationPlanner().planImport(manifest,mem.presets,Object.assign({},opts,{validCategories:mem.assets.map(a=>a.id)})).records.filter(row=>row.action==='add').map(row=>row.index));
    const entries=[];
    for(const [index,entry]of (manifest.entries||[]).entries()){
      if(selected.has(index)&&entry.payload&&Array.isArray(entry.payload.refImages)&&entry.payload.refImages.length){
        const {assets,skipped}=await prepareReferenceImagesLenient(entry.payload.refImages,storage);referenceAssets.set(index,assets);
        if(skipped.length)refSkipped.push({index,title:String(entry.payload.title||entry.payload.name||('第 '+(index+1)+' 条')),skipped});
        entries.push({...entry,payload:{...entry.payload,refImages:assets.map(referenceDescriptor)}});
      }else entries.push(entry);
    }
    manifest={...manifest,entries};
    return migrationTransaction(({ current, meta, presetStore, metaStore }) => {
      const plan = migrationPlanner().planImport(manifest, current, Object.assign({}, opts, {
        validCategories: mem.assets.map(a => a.id)
      }));
      const added = plan.records.filter(r => r.action === 'add').map(r => normalizePreset(r.item));
      const after = current.concat(added);
      const report = { schema: 'wheelchair-v7-v6-import-report', id: uid('v6mig_'),
        status: added.length ? 'applied' : 'unchanged', sourceRoot: plan.sourceManifest,
        startedAt: plan.createdAt, finishedAt: new Date().toISOString(),
        snapshotCount: current.length, afterCount: after.length,
        counts: { added: added.length, skipped: plan.counts.skipped, forgeReview: plan.counts.forgeReview,
          refSkipped: refSkipped.reduce((n, row) => n + row.skipped.length, 0) },
        refSkipped,
        // Reports contain identity/outcome only, never the whole preset data.
        records: plan.records.map(({ item, ...record }) => record)
      };
      if (added.length) {
        for(const row of plan.records.filter(row=>row.action==='add'))for(const asset of referenceAssets.get(row.index)||[])metaStore.put(asset,REF_PREFIX+asset.assetId);
        added.forEach(item => presetStore.add(item, item.id));
        metaStore.put({ id: report.id, snapshot: current, after, metaBefore: meta, report }, V6_MIGRATION_KEY);
        metaStore.put(Object.assign({}, meta, { v6Migrated: true, v6MigratedAt: Date.now(),
          v6Info: { id: report.id, counts: report.counts } }), META_KEY);
      }
      // An all-skipped re-import must not erase the useful rollback snapshot.
      metaStore.put(report, V6_REPORT_KEY);
      return { presets: after, report };
    },storage).then(async result => {
      // 刚导进来的 V6 Forge 预设马上翻成云端模板（不用等下次启动）；失败不影响导入本身。
      try { result.forgeUpgrade = await upgradeLegacyForgePresets(window.__V7_FORGE_COMFY_CATALOG__, storage); }
      catch (error) { console.warn('[预设] V6 Forge 预设升级到云端模板失败', error); }
      return result;
    });
  }

  async function importV6Plan(plan, opts) { return importV6Manifest(migrationPlanner().manifestFromPlan(plan), opts); }

  async function latestV6Migration() {
    const value = await dbGet(S_META, V6_MIGRATION_KEY);
    return value && value.report ? value.report : null;
  }
  async function v6MigrationReport() { return (await dbGet(S_META, V6_REPORT_KEY)) || null; }

  async function rollbackV6Migration(id, opts) {
    if (!(opts && opts.confirm)) throw new Error('V6_MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED');
    return migrationTransaction(({ current, latest, presetStore, metaStore }) => {
      if (!latest || !Array.isArray(latest.snapshot) || (id && latest.id !== id)) throw new Error('V6_MIGRATION_SNAPSHOT_NOT_FOUND');
      if (latest.report.status === 'rolled_back') throw new Error('V6_MIGRATION_ALREADY_ROLLED_BACK');
      const ordered = values => values.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (migrationPlanner().stable(ordered(current)) !== migrationPlanner().stable(ordered(latest.after || []))) {
        // Never clear user presets added/edited after the import. The caller
        // must first export/resolve those changes; there is no force flag.
        throw new Error('V6_MIGRATION_ROLLBACK_HAS_NEW_CHANGES');
      }
      const report = Object.assign({}, latest.report, { status: 'rolled_back',
        rolledBackAt: new Date().toISOString(), restoredCount: latest.snapshot.length });
      presetStore.clear();
      latest.snapshot.forEach(p => presetStore.add(p, p.id));
      metaStore.put(latest.metaBefore || {}, META_KEY);
      metaStore.put(Object.assign({}, latest, { report }), V6_MIGRATION_KEY);
      metaStore.put(report, V6_REPORT_KEY);
      return { presets: latest.snapshot, report };
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  导入 / 导出
  // ═══════════════════════════════════════════════════════════
  // 预设导出: 保留 V6 可忽略的扩展字段，V7 工具 kind/作者/时间不能丢。
  function exportPresetsJson(list) {
    // Use the same retained-field contract as IndexedDB. Exporting and
    // re-importing must not turn a pending Forge workflow into a plain prompt.
    const clean = (list || mem.presets).map(normalizePreset);
    return JSON.stringify({ format: 'wheelchair-presets', version: 2, items: clean }, null, 2);
  }

  // 整套剪影导出: 素材(内嵌 base64 图) + 摆放
  // ⚠ 带版本号 —— 以后格式变了才有得兼容(docs/28 §8.3)
  async function exportSilhouette() {
    const assets = [];
    for (const a of mem.assets) {
      assets.push({
        id: a.id, name: a.name, icon: a.icon,
        x: a.x, y: a.y, w: a.w, h: a.h, z: a.z, hidden: a.hidden === true,
        display: await blobToDataUrl(a.display),
        mask: await blobToDataUrl(a.mask)
      });
    }
    // ⚠ aspect 必须带上: 素材坐标是相对画布的百分比, 收图的人画布比例不一样就整体拉伸。
    return JSON.stringify({ format: 'wheelchair-silhouette', version: 2, aspect: mem.canvasAspect, assets }, null, 2);
  }

  async function importSilhouette(text, opts) {
    opts = opts || {};
    let obj;
    try { obj = JSON.parse(text); } catch (_) { throw new Error('这不是一个能读的剪影文件(JSON 解析失败)'); }
    if (!obj || obj.format !== 'wheelchair-silhouette' || !Array.isArray(obj.assets)) {
      throw new Error('这不是剪影素材包(缺 format 标记)');
    }
    if (obj.version > 2) throw new Error('这个剪影包是更新版本的(v' + obj.version + ')，当前程序读不了');
    if (opts.replace) {
      for (const a of mem.assets.slice()) await deleteAsset(a.id);
    }
    // 整套替换时才跟着换画布比例；只是往现有剪影里添几块的话，换比例会让原有素材全跑位。
    if (opts.replace && Number(obj.aspect) > 0) await setCanvasAspect(Number(obj.aspect));
    let n = 0;
    for (const a of obj.assets) {
      if (!a || !a.display || !a.mask) continue;
      await createAsset(a);
      n++;
    }
    return { count: n };
  }

  // ═══════════════════════════════════════════════════════════
  //  启动
  // ═══════════════════════════════════════════════════════════
  const META_KEY = 'canvas.v1';
  async function loadMeta(operation) { return (await dbGet(S_META, META_KEY, operation)) || {}; }

  // ⭐ 一次性迁移（2026-09-29）：工具能钉到剪影上了 —— 编辑页里设成「显示」的工具会出现在主卡剪影上。
  //   但 AI 修图痕迹检测的剪影出厂是「显示」，以前被「工具箱」一刀切过滤藏着，用户看到的一直是全部隐藏。
  //   放开过滤后它会突然冒出来，所以把【没动过的出厂工具】统一改回隐藏；
  //   用户改过的（改名/挪位/换图）一律不碰。只跑一次（meta 记标记），之后用户自己点显示不会被改回去。
  const TOOL_PIN_MIGRATION_KEY = 'toolPinsHiddenByDefault.v1';
  async function hideFactoryToolsOnce(raw, operation) {
    const api = window.V7ToolSilhouettes;
    if (!api || typeof api.isFactoryAsset !== 'function' || typeof api.get !== 'function') return;
    const meta = await loadMeta(operation); operation.check();
    if (meta[TOOL_PIN_MIGRATION_KEY]) return;
    for (const asset of raw) {
      if (!asset || asset.hidden || !api.get(asset.id) || !api.isFactoryAsset(asset)) continue;
      asset.hidden = true;
      await dbPut(S_ASSET, asset.id, asset, operation); operation.check();
    }
    await saveMeta({ [TOOL_PIN_MIGRATION_KEY]: true }, operation);
  }
  async function saveMeta(patch, operation = storageOperation()) {
    const cur = await loadMeta(operation);
    const next = Object.assign({}, cur, patch);
    await dbPut(S_META, META_KEY, next, operation);
    return next;
  }

  async function importBuiltInComfyCatalog(force, operation = storageOperation()) {
    operation.check();
    const embeddedCatalog = window.__V7_FORGE_COMFY_CATALOG__;
    if (!force && window.__V7_IMPORT_BUILTIN_WORKFLOWS__ === false
      || (!embeddedCatalog && typeof fetch !== 'function')) return { skipped: true };
    const meta = await loadMeta(operation);
    try {
      // Electron/Tauri both load ui.html from file://. Chromium may reject a
      // relative fetch for local files even though the JSON is bundled. The
      // generated script is loaded before this file and provides an exact
      // local copy; fetch remains useful for HTTP/dev hosts and old bundles.
      let catalog = embeddedCatalog;
      if (!catalog || typeof catalog !== 'object') {
        const response = await fetch('workflows/forge-comfyui-catalog.json', { cache: 'no-store' });
        operation.check();
        if (!response.ok) throw new Error('HTTP ' + response.status);
        catalog = await response.json();
        operation.check();
      }
      // V6 用户自己的 Forge 预设每次启动都检查一遍（只碰还跑不了的，见 upgradeLegacyForgePresets）。
      try { await upgradeLegacyForgePresets(catalog, operation); } catch (error) {
        operation.check();
        console.warn('[预设] V6 Forge 预设升级到云端模板失败（不影响其它预设）', error);
      }
      if (!force && meta.forgeComfyCatalogImportedAt && Number(meta.forgeComfyCatalogVersion || 1) >= Number(catalog.version || 1)) return { skipped: true, alreadyImported: true };
      const result = await importComfyCatalog(catalog, { overwrite: false }, operation);
      await saveMeta({ forgeComfyCatalogImportedAt: new Date().toISOString(), forgeComfyCatalogCount: result.added, forgeComfyCatalogVersion: catalog.version || 1 }, operation);
      return result;
    } catch (error) {
      operation.check();
      console.warn('[预设] 内置 Forge→ComfyUI 目录暂不可用', error);
      return { skipped: true, error: String(error && error.message || error) };
    }
  }
  async function refreshBuiltInComfyCatalog() { return importBuiltInComfyCatalog(true); }

  let initPromise = null;
  function init() {
    if (initPromise) return initPromise;
    const operation = storageOperation();
    initPromise = (async () => {
      const meta = await loadMeta(operation); operation.check();
      if (Number(meta.canvasAspect) > 0) mem.canvasAspect = Number(meta.canvasAspect);

      // 1) 素材
      let raw = await dbAll(S_ASSET, operation); operation.check();
      if (!raw.length && !meta.bodySplitDone) {
        // 首次运行: 切 V6 人体图
        try {
          const split = await splitV6Body();
          operation.check();
          const parts = split.parts;
          for (const p of parts) await dbPut(S_ASSET, p.id, p, operation);
          raw = parts;
          mem.canvasAspect = split.aspect;
          await saveMeta({ bodySplitDone: true, bodySplitAt: Date.now(), bodySplitCount: parts.length, canvasAspect: split.aspect }, operation);
        } catch (e) {
          operation.check();
          mem.lastError = '内置剪影切割失败: ' + (e && e.message || e);
          console.error('[预设] 内置剪影切割失败', e); if(window.ERR) ERR.report('PRESET_SILHOUETTE_FAILED',{message:String(e&&e.message||e)});
          raw = [];
        }
      }
      // ⭐ 内置「工具」素材（2026-09-14 用户定）。
      //   抠像、以及以后的外挂模型（分割/超分…）都挂这个类别下。
      //   ⚠ 三条约定：
      //     ① 默认【隐藏】—— 不打扰只想用提示词预设的人，要用的自己在管理器里打开
      //     ② 它是内置的，但仍然是一条普通素材记录 ——
      //        这样位置、大小、隐藏与否全部复用现成的管理器，不用另写一套
      //     ③ 用 SVG 现画，不依赖任何图片文件（打包时少一份资源）
      try { await ensureToolAsset(raw, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 内置工具素材建不起来（不影响其它功能）', e);
      }
      try {
        if(window.V7ToolSilhouettes?.ensureHub)await window.V7ToolSilhouettes.ensureHub({assets:raw,putAsset:a=>dbPut(S_ASSET,a.id,a,operation),check:()=>operation.check()});
        if(window.V7ToolSilhouettes)await window.V7ToolSilhouettes.ensure({assets:raw,putAsset:a=>dbPut(S_ASSET,a.id,a,operation),check:()=>operation.check()});
        await hideFactoryToolsOnce(raw, operation);
      } catch(error){operation.check();window.ERR?.report('PRESET_SILHOUETTE_FAILED',{message:'独立工具剪影初始化未完成：'+String(error.message||error)});}

      operation.check(); mem.assets = raw.slice();
      sortAssets();
      for (const a of raw) { await hydrateAsset(a, operation); operation.check(); }

      // ── 素材自检 ──
      // ⚠ 成功失败都打(CLAUDE.md 铁律 17): 只打失败会骗人 —— "零条异常"既可能是全对,
      //   也可能是根本没跑。这条日志是排查"剪影有缝 / 某块点不到"的第一手证据。
      const bad = [];
      const boxes = mem.assets.map(a => {
        const pct = v => Math.round(v * 1000) / 10;
        if (!a._hit) bad.push(a.id + '(选区图没读出来)');
        else if (!a._hit.data.some(v => v)) bad.push(a.id + '(选区图全透明, 点不到)');
        if (a.w <= 0.001 || a.h <= 0.001) bad.push(a.id + '(尺寸几乎为0)');
        return a.id + ' ' + pct(a.x) + ',' + pct(a.y) + ' ' + pct(a.w) + '×' + pct(a.h)
          + (a._hit ? '/' + a._hit.mode : '/无');
      });
      mem.selfCheck = { total: mem.assets.length, bad, boxes, aspect: mem.canvasAspect };

      // 2) 预设
      const presets = await dbAll(S_PRESET, operation); operation.check(); mem.presets = presets || [];
      for(const preset of mem.presets.slice()){
        if(!(preset.refImages||[]).some(row=>!row||!row.assetId))continue;
        try{await savePreset(preset,operation);}catch(error){
          operation.check();
          // Keep the original disk record available for recovery; UI memory contains no encoded full images.
          const index=mem.presets.findIndex(row=>row.id===preset.id);
          mem.presets[index]={...preset,refImages:[{name:'参考图读取失败',missing:true}]};
          window.ERR?.report('PRESET_REFERENCE_FAILED',{presetId:preset.id,message:String(error.message||error)});
        }
      }
      // ⭐ 出厂的抠像预设（挂在「工具」素材下）。
      //   ⚠ 建不起来不能影响其它预设 —— 它只是多一条，不是主链路。
      try { await ensureMattingPreset(mem.presets, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 出厂抠像预设建不起来（不影响其它预设）', e);
      }
      // ⚠ 三条各自 try —— 一条建不起来不许连累另外两条，也不许连累提示词预设
      try { await ensureSegmentPreset(mem.presets, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 出厂人体解析预设建不起来（不影响其它预设）', e);
      }
      try { await ensureSAM2Preset(mem.presets, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 出厂指哪抠哪预设建不起来（不影响其它预设）', e);
      }
      try { await ensureGlowPreset(mem.presets, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 出厂辉光预设建不起来（不影响其它预设）', e);
      }
      try {
        if(window.V7ToolSilhouettes)await window.V7ToolSilhouettes.ensure({presets:mem.presets,putPreset:p=>dbPut(S_PRESET,p.id,p,operation),normalize:normalizePreset,
          defaults:row=>row.module==='V7CreativeTools'?{...window.V7CreativeCore.initial(),mode:row.mode}:{},check:()=>operation.check()});
      } catch(error){operation.check();window.ERR?.report('PRESET_SAVE_FAILED',{message:'独立工具预设初始化未完成：'+String(error.message||error)});}
      try { await importBuiltInComfyCatalog(false, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 内置 ComfyUI 目录导入失败（不影响已有预设）', e);
      }
      // 千问模式的出厂预设（98 条，presetSet='qwen'，普通模式看不见）。装不上不影响别的预设
      try { if (window.__V7_QWEN_FACTORY_PRESETS__) await installQwenFactory(window.__V7_QWEN_FACTORY_PRESETS__, operation); } catch (e) {
        operation.check();
        console.warn('[预设] 开源模型出厂预设装不上（不影响已有预设）', e);
        window.ERR?.report('PRESET_SAVE_FAILED', { message: '开源模型出厂预设没装上：' + String(e && e.message || e) });
      }
      // ⚠ 老数据没有 kind 字段 —— 这里【不改库】，只在内存里补默认值。
      //   改库是数据迁移，属于"动数据格式"，要单独一轮 + 先备份（docs/42）。
      //   而且不改也没问题：normalizePreset 存的时候会自动补上。
      operation.check(); for (const p of mem.presets) if (!p.kind) p.kind = KIND_PROMPT;
      // ⭐ 2026-10-24（V7待办/16）：解锁 V6 搬来的出厂提示词 + 老用户去重一次。失败不影响别的预设
      let dedupe = null;
      try { dedupe = await migrateDedupeOnce(operation); } catch (error) {
        operation.check();
        console.warn('[预设] 去重没做成（不影响其它预设）', error);
        window.ERR?.report('PRESET_DEDUP_FAILED', { message: String(error && error.message || error) });
      }

      mem.ready = true;
      return {
        assets: mem.assets.length,
        presets: mem.presets.length,
        migrated: !!meta.v6Migrated,
        firstRun: !meta.v6Migrated,
        dedupe
      };
    })();
    return initPromise;
  }

  // ═══════════════════════════════════════════════════════════
  //  ⭐ 2026-10-24（V7待办/16，用户定：自动去重 + 老用户清一次）
  //
  //  两件事，都是"开软件顺手做一次"，做完记标记，不再重复：
  //    ① 解锁：V6 搬来的出厂提示词以前原样带着 _isFactory，被当成「出厂·不能动」锁死。
  //       它们其实不会被重建 —— 改成 v6Factory，让用户能挪、能改、能删。
  //    ② 去重：标题 + 正文一样（空格 / 换行 / 全半角不算）的只留一条，规则全在 v6-migration.js 的 planDedupe。
  //       删掉的进「最近删除」（能恢复），同时存一份去重前快照 + 报告，能一键撤销。
  //  ⚠ 只动提示词和工作流预设。抠像 / 人体解析 / 辉光 / 18 个工具入口是工具开关，删了会被重建，不碰。
  //  ⚠ 一步一个判断，识别不了就整步跳过（返回 skipped），绝不猜着删。
  // ═══════════════════════════════════════════════════════════
  const DEDUP_KEY = 'presetDedup.v1', DEDUP_SNAPSHOT_KEY = 'presetDedup.snapshot.v1';
  function dedupPlanner() { return window.V6Migration && window.V6Migration.planDedupe ? window.V6Migration : null; }
  // 工具类 kind 的兜底名单（tool-silhouettes 没加载时也认得出）
  const TOOL_KINDS_MIN = ['matting', 'segment', 'sam2', 'glow'];
  function dedupSkip(p) {
    if (!p || p.presetSet === 'qwen') return true;                 // 千问那套单独管
    if (p.category === AGENT_INBOX_ID) return true;
    if (typeof p.kind === 'string' && p.kind !== KIND_PROMPT && TOOL_KINDS_MIN.includes(p.kind)) return true;
    if (p.toolLauncher || p.source === 'builtin-tool') return true;
    return false;
  }

  // 解锁：只碰 V6 搬来的、还是提示词、还带着 _isFactory 的
  async function unlockV6FactoryPresets(list, operation) {
    let unlocked = 0;
    for (const p of list) {
      if (!p || p.source !== 'v6' || p._isFactory !== true) continue;
      if ((p.kind || KIND_PROMPT) !== KIND_PROMPT) continue;
      operation.check();
      p._isFactory = false; p.v6Factory = true; p.updatedAt = new Date().toISOString();
      await dbPut(S_PRESET, p.id, p, operation);
      unlocked++;
    }
    return unlocked;
  }

  // 去重：一个事务删旧的、改留的、写最近删除和快照
  async function dedupeOnce(operation = storageOperation()) {
    operation.check();
    const planner = dedupPlanner();
    if (!planner) return { skipped: true, reason: 'planner-unavailable' };
    const plan = planner.planDedupe(mem.presets, { skip: dedupSkip });
    if (!plan.groups.length) return { groups: 0, removed: 0 };
    const now = new Date().toISOString();
    const raw = await dbGet(S_META, TRASH_KEY, operation); operation.check();
    let trash = pruneTrash(raw && raw.items);
    const puts = new Map(), removes = new Set();
    for (const group of plan.groups) {
      const keep = Object.assign({}, group.keep, group.patch, { updatedAt: now });
      puts.set(keep.id, keep);
      for (const gone of group.drop) {
        removes.add(gone.id);
        trash.push({ preset: structuredClone(gone), deletedAt: now, fromCategory: gone.category || UNSORTED_ID, reason: 'dedup' });
      }
    }
    trash = pruneTrash(trash);
    const report = { at: now, groups: plan.groups.length, removed: plan.dropCount,
      items: plan.groups.map(g => ({ keep: g.keep.title, keptId: g.keep.id, dropped: g.drop.map(p => p.title) })) };
    // 去重做完那一刻的样子（id + 更新时间）：撤销时用来判断"之后有没有人再动过"
    const after = mem.presets.filter(p => !removes.has(p.id)).map(p => puts.get(p.id) || p);
    const snapshot = { at: now, presets: mem.presets.map(p => structuredClone(p)), afterKey: dedupeStateKey(after) };
    const db = await openDb(operation); operation.check();
    await new Promise((resolve, reject) => {
      const t = db.transaction([S_PRESET, S_META], 'readwrite'); storageTransactions.add(t);
      t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(); } catch (error) { reject(error); } };
      t.onabort = t.onerror = () => {
        storageTransactions.delete(t);
        try { operation.check(); } catch (error) { reject(error); return; }
        reject(t.error || Object.assign(new Error('预设去重没写进去，原样保留'), { code: 'PRESET_SAVE_FAILED' }));
      };
      try {
        const ps = t.objectStore(S_PRESET), ms = t.objectStore(S_META);
        for (const [id, rec] of puts) ps.put(rec, id);
        for (const id of removes) ps.delete(id);
        ms.put({ items: trash }, TRASH_KEY);
        ms.put(report, DEDUP_KEY);
        ms.put(snapshot, DEDUP_SNAPSHOT_KEY);
      } catch (error) { try { t.abort(); } catch (_) { } reject(error); }
    });
    for (const id of removes) { const i = mem.presets.findIndex(x => x.id === id); if (i >= 0) mem.presets.splice(i, 1); }
    for (const [id, rec] of puts) { const i = mem.presets.findIndex(x => x.id === id); if (i >= 0) mem.presets[i] = rec; else mem.presets.push(rec); }
    return { groups: report.groups, removed: report.removed };
  }

  // 撤销整次去重：把快照写回。⚠ 去重之后用户又改过的，绝不覆盖（跟搬家撤销同一个态度）
  async function undoLedup(operation = storageOperation()) {
    operation.check();
    const snapshot = await dbGet(S_META, DEDUP_SNAPSHOT_KEY, operation);
    if (!snapshot || !Array.isArray(snapshot.presets)) throw Object.assign(new Error('没有可恢复的去重快照'), { code: 'PRESET_DEDUP_NO_SNAPSHOT' });
    // 现状必须还是"去重刚做完"那份：一条不多、一条不少、留着的也没被再动过
    if (!snapshot.afterKey || dedupeStateKey(mem.presets) !== snapshot.afterKey) {
      throw Object.assign(new Error('去重之后预设又改过，不能整次恢复'), { code: 'PRESET_DEDUP_HAS_NEW_CHANGES' });
    }
    const db = await openDb(operation); operation.check();
    await new Promise((resolve, reject) => {
      const t = db.transaction([S_PRESET, S_META], 'readwrite'); storageTransactions.add(t);
      t.oncomplete = () => { storageTransactions.delete(t); try { operation.check(); resolve(); } catch (error) { reject(error); } };
      t.onabort = t.onerror = () => {
        storageTransactions.delete(t);
        try { operation.check(); } catch (error) { reject(error); return; }
        reject(t.error || Object.assign(new Error('恢复没有写进去'), { code: 'PRESET_SAVE_FAILED' }));
      };
      try {
        const ps = t.objectStore(S_PRESET);
        ps.clear();
        snapshot.presets.forEach(p => ps.put(p, p.id));
        t.objectStore(S_META).delete(DEDUP_KEY);
        t.objectStore(S_META).delete(DEDUP_SNAPSHOT_KEY);
      } catch (error) { try { t.abort(); } catch (_) { } reject(error); }
    });
    mem.presets = snapshot.presets.map(p => p);
    return { restored: mem.presets.length };
  }
  // 去重做完那一刻的标志：id + 更新时间。用来判断"之后有没有人再动过"
  function dedupeStateKey(list) { return list.map(p => p.id + '@' + String(p.updatedAt || '')).sort().join('|'); }
  async function dedupeReport(operation = storageOperation()) { return (await dbGet(S_META, DEDUP_KEY, operation)) || null; }

  // 启动时一步做完：解锁（每次都对已搬来的 V6 提示词生效，已经是 false 的不会再动）→ 去重（只做一次）
  async function migrateDedupeOnce(operation) {
    const unlocked = await unlockV6FactoryPresets(mem.presets, operation);
    // ⚠ 去重报告单独一个键存（不是 canvas.v1 那份 meta），所以这里查报告，别查 loadMeta()
    const done = await dedupeReport(operation); operation.check();
    if (done) return { unlocked, groups: 0, removed: 0, alreadyDone: true };
    return Object.assign({ unlocked }, await dedupeOnce(operation));
  }

  async function setCanvasAspect(v) {
    const n = Number(v);
    if (!(n > 0.05 && n < 20)) return mem.canvasAspect;    // 明显离谱的值不收
    mem.canvasAspect = n;
    await saveMeta({ canvasAspect: n });
    return n;
  }

  async function markMigrated(info) { return saveMeta({ v6Migrated: true, v6MigratedAt: Date.now(), v6Info: info || null }); }
  async function isMigrated() { return !!(await loadMeta()).v6Migrated; }
  // ⭐ 10-25（反馈 #63「每次打开都提示 V6 搬家」）：原来只有搬家【成功】才记，点取消 / 导入出错 / 一条都没新的都不记 ⇒ 每次开软件再问。
  //   另记一个「自动问过了」：问过一次就不再自动弹（不冒充「搬过了」—— 预设卡上「从 V6 搬家」照旧随时能手动点）
  async function markV6Asked(why) { return saveMeta({ v6Asked: true, v6AskedAt: Date.now(), v6AskedWhy: String(why || '') }); }
  async function shouldAskV6() { const m = await loadMeta(); return !m.v6Migrated && !m.v6Asked; }

  // 只在开发期用: 清空重来
  async function wipe() {
    await tx(S_ASSET, 'readwrite', s => { s.clear(); return true; });
    await tx(S_PRESET, 'readwrite', s => { s.clear(); return true; });
    await tx(S_META, 'readwrite', s => { s.clear(); return true; });
    mem.assets = []; mem.presets = []; initPromise = null;
  }

  // ═══════════════════════════════════════════════════════════
  //  工具平铺列表的顺序（2026-09-28 新增）
  //
  //  ⚠ 为什么不能复用 reorder(category, ids)：
  //    那个接口是【按分类】整体重写的，而且校验"记录数必须与传入 id 数相等"。
  //    但平铺的工具列表横跨 13 个分类（每个工具一个 __tool_xxx__ 素材分类），
  //    还混着 6 个没有预设记录的附加入口 —— 传进去必然抛"列表已变化"。
  //
  //  所以单独存一份"工具 key 的顺序数组"到 meta：键与顺序解耦。
  //  它只是【展示顺序】，不碰任何预设记录；删掉这条 meta 就回到默认顺序。
  // ═══════════════════════════════════════════════════════════
  const TOOL_ORDER_KEY = 'toolOrder.v1';
  async function toolOrder(operation = storageOperation()) {
    const meta = await loadMeta(operation);
    const list = meta[TOOL_ORDER_KEY];
    return Array.isArray(list) ? list.filter(k => typeof k === 'string' && k) : [];
  }
  async function saveToolOrder(keys) {
    if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string' || !k)) {
      throw Object.assign(new Error('工具顺序无效'), { code: 'PRESET_SAVE_FAILED' });
    }
    await saveMeta({ [TOOL_ORDER_KEY]: keys.slice() });
    return true;
  }

  window.PRESETS = {
    init, wipe, rebindStorage, mem,
    // 素材
    V6_PARTS, UNSORTED_ID,
    assets: () => mem.assets, assetById, createAsset, saveAsset, deleteAsset, hitTest,
    // Monotonic revision for cross-window edit conflict detection.  It is an
    // in-memory counter on purpose; the persisted data format stays unchanged.
    assetVersion: () => assetRevision,
    splitV6Body,
    canvasAspect: () => mem.canvasAspect, setCanvasAspect,
    // 预设
    presets: () => mem.presets, presetById, savePreset, deletePreset,
    listByCategory, reorder, countByCategory, search,
    // 剪影编辑器里的预设管理（挪组 / 改名 / 复制 / 删除进「最近删除」/ 恢复）
    applyPresetEdits, loadTrash, presetLocked,
    // 去重（V7待办/16）：启动自动一次 / 手动再整理 / 撤销 / 看报告
    dedupe: dedupeOnce, undoDedupe: undoLedup, dedupeReport, dedupeSkip: dedupSkip,
    // 千问模式：当前模式下看得见哪些预设 / 装出厂千问预设
    visible: inMode, installQwenFactory,
    // 云端官方预设同步（cloud-presets.js 调）
    syncOfficialPresets, syncCloudLibrary, cloudLibraryCursor, cloudLibraryCount,
    // 工具平铺列表的展示顺序（独立于预设分类，见上方注释）
    toolOrder, saveToolOrder,
    // ⭐ 多 kind 预设（2026-09-14，docs/42 第二批的地基）
    KIND_PROMPT, KIND_MATTING, KIND_SEGMENT, KIND_SAM2, KIND_GLOW, TOOL_ID, presetParams,
    mattingDefaults: () => Object.assign({}, MATTING_DEFAULTS),
    segmentDefaults: () => Object.assign({}, SEGMENT_DEFAULTS),
    sam2Defaults:    () => Object.assign({}, SAM2_DEFAULTS),
    glowDefaults:   () => Object.assign({}, GLOW_DEFAULTS),
    // ⚠ 哪些 kind 属于"工具类预设"（点开来是参数面板、开始计算走外挂引擎）。
    //   ⭐ 新加一种外挂能力时【只改这一行】，别再去各处补 `kind==='xxx'||...`
    //      —— 那种散落的判断必然漏，而且漏了不报错。
    TOOL_KINDS: [...new Set([KIND_MATTING, KIND_SEGMENT, KIND_SAM2, KIND_GLOW, 'camera-light', 'scene-pack', 'hemisynth', 'kao',...(window.V7ToolSilhouettes?.definitions||[]).map(row=>row.kind)])],
    isToolKind: (k) => !!window.V7ToolSilhouettes?.getPreset({kind:k})||[KIND_MATTING, KIND_SEGMENT, KIND_SAM2, KIND_GLOW, 'camera-light', 'scene-pack', 'hemisynth', 'kao'].includes(k),
    // 迁移 / 导入导出
    scanV6, importPresets, importComfyCatalog, refreshBuiltInComfyCatalog, upgradeLegacyForgePresets, planV6Manifest, importV6Manifest, importV6Plan, latestV6Migration, v6MigrationReport, rollbackV6Migration, markMigrated, isMigrated, markV6Asked, shouldAskV6,
    exportPresetsJson, exportPresetsPortable, exportSilhouette, importSilhouette,
    createReferenceAsset, prepareReferenceImages, resolveReferenceImages, referenceDescriptor,
    // 工具
    blobToDataUrl, dataUrlToBlob, loadImage, canvasToBlob, buildHitData, uid,
    normalizePreset
  };
})();
