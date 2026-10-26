/* ═══════════════════════════════════════════════════════════════
   分割（新增物体抠图）· 算法核心（2026-10-25，docs/289）

   照 tools/addmask-lab/core_diff.py 一比一搬过来（用户 10-25 拍板：直接差值为主干，进 V7 只做到 D2 + 五个调节）：
     ① 直接差值：三通道绝对差取平均，逐像素，不模糊（和 PS 差值一致）
     ② 门槛 = 大津阈值 × 灵敏度系数
     ③ D1 去碎点（面积够大或够细长的块才留）
     ④ D2 往外长（每一片弱差值要么整片收、要么一点不收）
     ⑤ 保持连续 → ⑥ 平滑 → ⑦ 模糊（模糊 0 时只留 1 像素抗锯齿）

   ⚠ 为什么不放本机引擎（10-25 改的）：引擎是可选的大包，走云端的用户本机没有；这套只要基础图像运算，
     放界面里算所有人都能用、拖滑块不用来回传图。跑在 diff-mask-worker.js 里，不卡界面。
   ⚠ 对齐 Python 的几处细节（tests/diff-mask-core.test.js 和 tools/addmask-lab/parity_js.py 逐张比过）：
     · 大津阈值照 OpenCV getThreshVal_Otsu_8u 原样写（连它那个 continue 的写法一起）
     · 距离变换用 OpenCV 同款倒角距离（3×3：0.955/1.3693；5×5：1/1.4/2.1969），不是精确欧氏距离
     · 高斯核大小照 OpenCV：浮点图 ksize = round(σ×8+1)|1，边界 BORDER_REFLECT_101
     · Python 的 round 是「四舍六入五成双」，几处取整用 pyRound
   ⚠ 差值永远不模糊；平滑 / 模糊只是收边，D2 往外长用的是没收过边的 D1。

   纯函数，不碰 DOM：worker 里 importScripts，node 测试里 require。
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    sens: 50,        // 差值灵敏度 0~100，50 = 自动
    denoise: 33,     // 去碎点强度 0~100
    keep: 0,         // 保持连续 0 关 / 1 宽松 / 2 标准 / 3 严格
    smooth: 0,       // 平滑 0~100
    feather: 0,      // 模糊 0~100
    featherOut: true,// 模糊只往外
    growK: 0.5, growPx: 0, covMin: 0.6, aa: true
  });
  const KEEP_NAMES = ['关', '宽松', '标准', '严格'];

  // Python round()：四舍六入五成双
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }
  // OpenCV cvRound / saturate_cast<int>：也是五成双（用的是 lrint）
  const cvRound = pyRound;

  // ─── ① 差值 ────────────────────────────────────────────────
  /** orig / gen：同尺寸 RGBA（Uint8ClampedArray / Uint8Array），返回 Float32 差值 */
  function absdiff(orig, gen, n) {
    const d = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      // ⚠ 和 numpy 一样先在 float32 上算三个通道的差再平均
      d[i] = Math.fround((Math.abs(gen[j] - orig[j]) + Math.abs(gen[j + 1] - orig[j + 1]) + Math.abs(gen[j + 2] - orig[j + 2])) / 3);
    }
    return d;
  }

  /** OpenCV getThreshVal_Otsu_8u 原样 */
  function otsu(du) {
    const h = new Float64Array(256), N = du.length;
    for (let i = 0; i < N; i++) h[du[i]]++;
    let mu = 0;
    for (let i = 0; i < 256; i++) { h[i] /= N; mu += i * h[i]; }
    let q1 = 0, mu1 = 0, maxSigma = 0, maxVal = 0;
    const EPS = 1.1920928955078125e-7;
    for (let i = 0; i < 256; i++) {
      const p = h[i];
      mu1 *= q1;
      q1 += p;
      const q2 = 1 - q1;
      if (Math.min(q1, q2) < EPS || Math.max(q1, q2) > 1 - EPS) continue;
      mu1 = (mu1 + i * p) / q1;
      const mu2 = (mu - q1 * mu1) / q2;
      const sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);
      if (sigma > maxSigma) { maxSigma = sigma; maxVal = i; }
    }
    return maxVal;
  }

  // ─── 连通块（8 邻域，两遍 + 并查集）──────────────────────────
  /** 返回 { n, lab:Int32Array, area, w, h }（0 号 = 背景，和 OpenCV 一样） */
  function components(mask, W, H, withStats) {
    const N = W * H, lab = new Int32Array(N);
    let parent = new Int32Array(1024), next = 1;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } return a < b ? a : b; };
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (!mask[i]) continue;
        let l = 0;
        if (y > 0) {
          const up = i - W;
          if (x > 0 && lab[up - 1]) l = lab[up - 1];
          if (lab[up]) l = l ? union(l, lab[up]) : lab[up];
          if (x < W - 1 && lab[up + 1]) l = l ? union(l, lab[up + 1]) : lab[up + 1];
        }
        if (x > 0 && lab[i - 1]) l = l ? union(l, lab[i - 1]) : lab[i - 1];
        if (!l) {
          if (next >= parent.length) { const p = new Int32Array(parent.length * 2); p.set(parent); parent = p; }
          parent[next] = next; l = next++;
        }
        lab[i] = l;
      }
    }
    // 压成连续编号（按第一次出现的扫描顺序）
    const remap = new Int32Array(next);
    let n = 1;
    for (let l = 1; l < next; l++) { const r = find(l); if (!remap[r]) remap[r] = n++; remap[l] = remap[r]; }
    const out = { n, lab };
    if (!withStats) {
      for (let i = 0; i < N; i++) if (lab[i]) lab[i] = remap[lab[i]];
      return out;
    }
    const area = new Float64Array(n), x0 = new Int32Array(n).fill(W), y0 = new Int32Array(n).fill(H), x1 = new Int32Array(n).fill(-1), y1 = new Int32Array(n).fill(-1);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (!lab[i]) continue;
        const l = lab[i] = remap[lab[i]];
        area[l]++;
        if (x < x0[l]) x0[l] = x; if (x > x1[l]) x1[l] = x;
        if (y < y0[l]) y0[l] = y; if (y > y1[l]) y1[l] = y;
      }
    }
    const bw = new Int32Array(n), bh = new Int32Array(n);
    for (let l = 1; l < n; l++) { bw[l] = x1[l] - x0[l] + 1; bh[l] = y1[l] - y0[l] + 1; }
    out.area = area; out.bw = bw; out.bh = bh;
    return out;
  }

  // ─── 滑块换算（和 core_diff.py 同名函数一一对应）──────────────
  function speckle_px(strength, h, w) {
    const s = Math.min(100, Math.max(0, Number(strength)));
    if (s <= 0) return [0, 0];
    const lo = Math.log10(4), hi = Math.log10(Math.max(400, h * w * 0.01));
    const px = pyRound(Math.pow(10, lo + (hi - lo) * s / 100));
    return [px, Math.max(12, pyRound(2.2 * Math.sqrt(px)))];
  }
  function sens_factor(s) {
    s = Math.min(100, Math.max(0, Number(s)));
    return s <= 50 ? 1 + (50 - s) / 50 : Math.pow(2, -(s - 50) / 25);
  }
  function thr_of(t0, s) { return Math.max(1, t0 * sens_factor(s)); }
  function smooth_px(s, h, w) { s = Math.min(100, Math.max(0, Number(s))); return s / 100 * Math.max(4, Math.min(h, w) / 170); }
  function feather_px(s, h, w) { s = Math.min(100, Math.max(0, Number(s))); return s / 100 * Math.max(4, Math.min(h, w) / 100); }
  function keep_px(level, h, w) {
    level = Math.trunc(Number(level) || 0);
    if (level <= 0) return null;
    return ({ 1: Math.min(h, w) / 35, 2: Math.min(h, w) / 100, 3: 0 })[level] ?? 0;
  }

  // ─── ② ~ ④ 主干 ───────────────────────────────────────────
  /** 一次性准备（拖滑块时不重算）。orig/gen 已经缩到同一个工作尺寸 */
  function prepare(orig, gen, w, h, P) {
    P = Object.assign({}, DEFAULTS, P || {});
    const n = w * h, d = absdiff(orig, gen, n), du = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const v = d[i]; du[i] = v <= 0 ? 0 : v >= 255 ? 255 : (v | 0); }   // ⚠ 截断取整
    return { w, h, d, du, t0: otsu(du), lv: null, steps: Math.trunc(P.growPx) || Math.max(4, pyRound(Math.min(h, w) / 100)) };
  }

  function level(b, t, P) {
    if (b.lv && b.lv.t === t) return b.lv;
    const { w, h, d, du } = b, n = w * h, growT = t * P.growK;
    const m0 = new Uint8Array(n), allow = new Uint8Array(n);
    for (let i = 0; i < n; i++) { if (du[i] > t) { m0[i] = 1; allow[i] = 1; } else if (d[i] > growT) allow[i] = 1; }
    const c0 = components(m0, w, h, true), ca = components(allow, w, h, false);
    const areaa = new Float64Array(ca.n);
    for (let i = 0; i < n; i++) areaa[ca.lab[i]]++;
    b.lv = { t, m0, c0, allow, laba: ca.lab, na: ca.n, areaa };
    return b.lv;
  }

  /** 限距离生长 = 在 allow 里做 8 邻域广度优先，最多 steps 层（和 n 次 3×3 膨胀 ∩ allow 等价） */
  function grow(seed, allow, w, h, steps) {
    const n = w * h, out = Uint8Array.from(seed);
    let front = [];
    for (let i = 0; i < n; i++) if (seed[i]) front.push(i);
    for (let s = 0; s < steps && front.length; s++) {
      const nf = [];
      for (const i of front) {
        const x = i % w, y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!out[j] && allow[j]) { out[j] = 1; nf.push(j); }
          }
        }
      }
      front = nf;
    }
    return out;
  }

  /** D1 去碎点 + D2 往外长 → { m1, m2, minPx, minLen, t } */
  function d1d2(b, P) {
    P = Object.assign({}, DEFAULTS, P || {});
    const t = thr_of(b.t0, P.sens), lv = level(b, t, P), { w, h } = b, n = w * h;
    const [minPx, minLen] = speckle_px(P.denoise, h, w);
    const c0 = lv.c0, keep = new Uint8Array(c0.n);
    for (let l = 1; l < c0.n; l++) keep[l] = (c0.area[l] >= minPx || Math.max(c0.bw[l], c0.bh[l]) >= minLen) ? 1 : 0;
    const m1 = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const l = c0.lab[i]; if (l && keep[l]) m1[i] = 1; }
    const g = grow(m1, lv.allow, w, h, b.steps);
    const got = new Float64Array(lv.na);
    for (let i = 0; i < n; i++) if (g[i]) got[lv.laba[i]]++;
    const whole = new Uint8Array(lv.na);
    for (let l = 1; l < lv.na; l++) whole[l] = got[l] >= P.covMin * lv.areaa[l] ? 1 : 0;
    const m2 = new Uint8Array(n);
    for (let i = 0; i < n; i++) m2[i] = (m1[i] || whole[lv.laba[i]]) ? 1 : 0;
    return { m1, m2, minPx, minLen, t };
  }

  // ─── 距离变换（OpenCV 倒角距离：两遍扫描）─────────────────────
  /** 每个「非零」像素到最近「零」像素的距离。src[i] 非零 = 要算距离的点。mask 3 或 5。
   *  maxD（可选）：只关心 ≤ maxD 的距离 —— 只算「零像素外接框 + 够得着的边距」那一块，框外一律当 INF。
   *  ⚠ 这样截是精确的：倒角距离每走一格（切比雪夫距离 1）至少花 0.955（3×3）/ 1（5×5），
   *    框外的点离零像素的切比雪夫距离已经超过 maxD / 最小步长，倒角距离不可能 ≤ maxD；最短路径是单调的，不会绕出框再回来。 */
  function distance(src, w, h, maskSize, maxD) {
    const INF = 1e20, n = w * h, D = new Float32Array(n);
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (maxD != null && isFinite(maxD)) {
      let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
      for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) if (!src[row + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; } }
      D.fill(INF);
      if (bx1 < 0) return D;
      const m = Math.ceil(maxD / (maskSize === 5 ? 1 : 0.955)) + 2;
      x0 = Math.max(0, bx0 - m); y0 = Math.max(0, by0 - m); x1 = Math.min(w - 1, bx1 + m); y1 = Math.min(h - 1, by1 + m);
    }
    for (let y = y0; y <= y1; y++) { const row = y * w; for (let x = x0; x <= x1; x++) D[row + x] = src[row + x] ? INF : 0; }
    if (maskSize === 5) {
      const a = 1, b = 1.4, c = 2.1969;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x; let v = D[i]; if (!v) continue; let u;
        if (x > x0) { u = D[i - 1] + a; if (u < v) v = u; }
        if (y > y0) {
          const up = i - w;
          u = D[up] + a; if (u < v) v = u;
          if (x > x0) { u = D[up - 1] + b; if (u < v) v = u; }
          if (x < x1) { u = D[up + 1] + b; if (u < v) v = u; }
          if (x > x0 + 1) { u = D[up - 2] + c; if (u < v) v = u; }
          if (x < x1 - 1) { u = D[up + 2] + c; if (u < v) v = u; }
          if (y > y0 + 1) {
            const up2 = up - w;
            if (x > x0) { u = D[up2 - 1] + c; if (u < v) v = u; }
            if (x < x1) { u = D[up2 + 1] + c; if (u < v) v = u; }
          }
        }
        D[i] = v;
      }
      for (let y = y1; y >= y0; y--) for (let x = x1; x >= x0; x--) {
        const i = y * w + x; let v = D[i]; if (!v) continue; let u;
        if (x < x1) { u = D[i + 1] + a; if (u < v) v = u; }
        if (y < y1) {
          const dn = i + w;
          u = D[dn] + a; if (u < v) v = u;
          if (x < x1) { u = D[dn + 1] + b; if (u < v) v = u; }
          if (x > x0) { u = D[dn - 1] + b; if (u < v) v = u; }
          if (x < x1 - 1) { u = D[dn + 2] + c; if (u < v) v = u; }
          if (x > x0 + 1) { u = D[dn - 2] + c; if (u < v) v = u; }
          if (y < y1 - 1) {
            const dn2 = dn + w;
            if (x < x1) { u = D[dn2 + 1] + c; if (u < v) v = u; }
            if (x > x0) { u = D[dn2 - 1] + c; if (u < v) v = u; }
          }
        }
        D[i] = v;
      }
    } else {
      const a = 0.955, b = 1.3693;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x; let v = D[i]; if (!v) continue; let u;
        if (x > x0) { u = D[i - 1] + a; if (u < v) v = u; }
        if (y > y0) {
          const up = i - w;
          u = D[up] + a; if (u < v) v = u;
          if (x > x0) { u = D[up - 1] + b; if (u < v) v = u; }
          if (x < x1) { u = D[up + 1] + b; if (u < v) v = u; }
        }
        D[i] = v;
      }
      for (let y = y1; y >= y0; y--) for (let x = x1; x >= x0; x--) {
        const i = y * w + x; let v = D[i]; if (!v) continue; let u;
        if (x < x1) { u = D[i + 1] + a; if (u < v) v = u; }
        if (y < y1) {
          const dn = i + w;
          u = D[dn] + a; if (u < v) v = u;
          if (x < x1) { u = D[dn + 1] + b; if (u < v) v = u; }
          if (x > x0) { u = D[dn - 1] + b; if (u < v) v = u; }
        }
        D[i] = v;
      }
    }
    return D;
  }

  // ─── 高斯模糊（可分离，BORDER_REFLECT_101，只算有内容的那一框）───────
  function gaussKernel(sig, ksize) {
    const k = ksize || ((cvRound(sig * 8 + 1)) | 1), r = k >> 1, out = new Float64Array(k);
    let s = 0;
    for (let i = 0; i < k; i++) { const x = i - r; out[i] = Math.exp(-(x * x) / (2 * sig * sig)); s += out[i]; }
    for (let i = 0; i < k; i++) out[i] /= s;
    return out;
  }
  function reflect101(p, len) {
    if (len === 1) return 0;
    while (p < 0 || p >= len) p = p < 0 ? -p : 2 * len - 2 - p;
    return p;
  }
  /** 0/1 蒙版做高斯，返回 Float32；整张图没内容的地方结果就是 0，所以只算外接框 + 半径那一块 */
  function gaussian(src, w, h, sig, ksize) {
    const K = gaussKernel(sig, ksize), r = K.length >> 1, out = new Float32Array(w * h);
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (src[y * w + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    if (bx1 < 0) return out;
    // ⚠ 反射边界下，框外的值也可能被「镜像」回来 —— 框贴边时直接扩到整张，简单可靠
    const X0 = bx0 - r <= 0 ? 0 : bx0 - r, X1 = bx1 + r >= w - 1 ? w - 1 : bx1 + r;
    const Y0 = by0 - r <= 0 ? 0 : by0 - r, Y1 = by1 + r >= h - 1 ? h - 1 : by1 + r;
    const tw = X1 - X0 + 1, tmp = new Float32Array(tw * h), side = 2 * r + 1;
    // ⭐ 捷径（结果一个比特都不变）：输入只有 0 / 1。窗口全在图里、而且全是 0 或全是 1 的点，
    //   逐项相加的结果是确定的（0，或者按同样顺序把核加一遍）—— 直接填，只有边缘附近的点才真去乘加。
    //   大块蒙版的内部和远处背景占绝大多数，2048 的图从约 0.85 秒降到零点几秒。
    let ks1 = 0; for (let k = 0; k < side; k++) ks1 += K[k];
    const ks1f = Math.fround(ks1);
    let kv1 = 0; for (let k = 0; k < side; k++) kv1 += K[k] * ks1f;
    // 积分图：I[(y)*(w+1)+x] = 左上角 [0,x)×[0,y) 里 1 的个数
    const W1 = w + 1, I = new Int32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) { let s = 0; const row = y * w, o = (y + 1) * W1, p = y * W1; for (let x = 0; x < w; x++) { s += src[row + x] ? 1 : 0; I[o + x + 1] = I[p + x + 1] + s; } }
    const box = (xa, ya, xb, yb) => I[(yb + 1) * W1 + xb + 1] - I[ya * W1 + xb + 1] - I[(yb + 1) * W1 + xa] + I[ya * W1 + xa];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = X0; x <= X1; x++) {
        let s = 0;
        if (x >= r && x + r < w) {
          const c = box(x - r, y, x + r, y);
          if (c === 0) { tmp[y * tw + (x - X0)] = 0; continue; }
          if (c === side) { tmp[y * tw + (x - X0)] = ks1; continue; }
          for (let k = -r; k <= r; k++) s += K[k + r] * src[row + x + k];
        } else {
          for (let k = -r; k <= r; k++) s += K[k + r] * src[row + reflect101(x + k, w)];
        }
        tmp[y * tw + (x - X0)] = s;
      }
    }
    for (let y = Y0; y <= Y1; y++) {
      const inY = y >= r && y + r < h;
      for (let x = X0; x <= X1; x++) {
        if (inY && x >= r && x + r < w) {
          const c = box(x - r, y - r, x + r, y + r);
          if (c === 0) continue;                                   // out 本来就是 0
          if (c === side * side) { out[y * w + x] = kv1; continue; }
        }
        let s = 0;
        for (let k = -r; k <= r; k++) s += K[k + r] * tmp[reflect101(y + k, h) * tw + (x - X0)];
        out[y * w + x] = s;
      }
    }
    return out;
  }

  // ─── 形态学（椭圆核 = getStructuringElement(MORPH_ELLIPSE)）────────────
  function ellipseHalfWidths(r) {
    const hw = [];
    for (let dy = -r; dy <= r; dy++) hw.push(cvRound(r * Math.sqrt((r * r - dy * dy) / (r * r))));
    return hw;
  }
  /** 开运算 = 先腐蚀后膨胀。⚠ 边界照 OpenCV：腐蚀时图外算 1、膨胀时图外算 0 */
  function openEllipse(m, w, h, r) {
    const hw = ellipseHalfWidths(r), n = w * h;
    const rowPrefix = src => { const P = new Int32Array((w + 1) * h); for (let y = 0; y < h; y++) { let s = 0; const o = y * (w + 1); for (let x = 0; x < w; x++) { s += src[y * w + x]; P[o + x + 1] = s; } } return P; };
    const cnt = (P, y, a, b) => { const o = y * (w + 1); return P[o + b + 1] - P[o + a]; };
    // 腐蚀：核里每一行那一段都得全是 1（图外的部分不算）
    const P1 = rowPrefix(m), er = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      let ok = 1;
      for (let k = 0; k < hw.length && ok; k++) {
        const yy = y + k - r; if (yy < 0 || yy >= h) continue;
        const a = Math.max(0, x - hw[k]), b = Math.min(w - 1, x + hw[k]);
        if (cnt(P1, yy, a, b) !== b - a + 1) ok = 0;
      }
      er[y * w + x] = ok;
    }
    // 膨胀：核里任意一行那一段有 1 就行（只看腐蚀结果外接框 + 半径那一块，框外不可能是 1）
    const P2 = rowPrefix(er), out = new Uint8Array(n);
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (er[y * w + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    if (bx1 < 0) return out;
    for (let y = Math.max(0, by0 - r); y <= Math.min(h - 1, by1 + r); y++) for (let x = Math.max(0, bx0 - r); x <= Math.min(w - 1, bx1 + r); x++) {
      for (let k = 0; k < hw.length; k++) {
        const yy = y + k - r; if (yy < 0 || yy >= h) continue;
        const a = Math.max(0, x - hw[k]), b = Math.min(w - 1, x + hw[k]);
        if (cnt(P2, yy, a, b) > 0) { out[y * w + x] = 1; break; }
      }
    }
    return out;
  }
  function dilate3(m, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && m[yy * w + xx]) { v = 1; break; } } }
      out[y * w + x] = v;
    }
    return out;
  }

  // ─── ⑤ ~ ⑦ 收边 ────────────────────────────────────────────
  function keep_main(m, lvl, w, h) {
    const r = keep_px(lvl, h, w);
    if (r === null) return m;
    let any = false; for (let i = 0; i < m.length; i++) if (m[i]) { any = true; break; }
    if (!any) return m;
    const c = components(m, w, h, true);
    if (c.n <= 2) return m;
    let keep = new Uint8Array(c.n), best = 1;
    for (let l = 2; l < c.n; l++) if (c.area[l] > c.area[best]) best = l;
    keep[best] = 1;
    if (r > 0) {
      for (let it = 0; it < 12; it++) {
        const notCur = new Uint8Array(m.length);
        for (let i = 0; i < m.length; i++) notCur[i] = keep[c.lab[i]] ? 0 : 1;
        const dist = distance(notCur, w, h, 3, r);
        const nk = Uint8Array.from(keep);
        for (let i = 0; i < m.length; i++) if (m[i] && dist[i] <= r) nk[c.lab[i]] = 1;
        nk[0] = 0;
        let same = true; for (let l = 0; l < c.n; l++) if (nk[l] !== keep[l]) { same = false; break; }
        if (same) break;
        keep = nk;
      }
    }
    const out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = keep[c.lab[i]];
    return out;
  }

  function smooth(m, sig, w, h) {
    let any = false; for (let i = 0; i < m.length; i++) if (m[i]) { any = true; break; }
    if (sig < 0.5 || !any) return m;
    const f = gaussian(m, w, h, sig), out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = f[i] > 0.5 ? 1 : 0;
    const r = Math.max(1, pyRound(sig));
    const thick = openEllipse(m, w, h, r), thin = new Uint8Array(m.length);
    let anyThin = false;
    for (let i = 0; i < m.length; i++) if (m[i] && !thick[i]) { thin[i] = 1; anyThin = true; }
    if (anyThin) {
      const c = components(thin, w, h, true), keep = new Uint8Array(c.n), minL = Math.max(12, 6 * sig);
      for (let l = 1; l < c.n; l++) keep[l] = Math.max(c.bw[l], c.bh[l]) >= minL ? 1 : 0;
      for (let i = 0; i < m.length; i++) if (keep[c.lab[i]]) out[i] = 1;
    }
    return out;
  }

  function feather(m, sig, outward, w, h) {
    const n = m.length, out = new Float32Array(n);
    if (sig < 0.3) { for (let i = 0; i < n; i++) out[i] = m[i]; return out; }
    if (!outward) { const g = gaussian(m, w, h, sig); for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, g[i])); return out; }
    const inv = new Uint8Array(n); for (let i = 0; i < n; i++) inv[i] = m[i] ? 0 : 1;
    // 只算到 3.6σ：再远 exp(-q²/2) < 1/510，转成 0~255 就是 0（tune 出的蒙版一个值都不差）
    const dist = distance(inv, w, h, 5, 3.6 * sig);
    for (let i = 0; i < n; i++) { const q = dist[i] / sig; out[i] = q > 1e9 ? 0 : Math.exp(-0.5 * q * q); }
    return out;
  }

  function soften(m, w, h) {
    const n = m.length, f = new Float32Array(n), outer = dilate3(m, w, h);
    for (let i = 0; i < n; i++) { f[i] = m[i]; if (m[i]) outer[i] = 0; }
    const soft = gaussian(m, w, h, 0.7, 3);
    for (let i = 0; i < n; i++) if (outer[i]) f[i] = soft[i];
    return f;
  }

  /** 二值 → 最终 alpha（Float32 0~1）。顺序：保持连续 → 平滑 → 模糊 */
  function finish(m, P, w, h) {
    P = Object.assign({}, DEFAULTS, P || {});
    const k = keep_main(m, P.keep, w, h);
    const mb = smooth(k, smooth_px(P.smooth, h, w), w, h);
    const fs = feather_px(P.feather, h, w);
    if (fs >= 0.3) return feather(mb, fs, P.featherOut !== false, w, h);
    if (P.aa) return soften(mb, w, h);
    const out = new Float32Array(mb.length); for (let i = 0; i < mb.length; i++) out[i] = mb[i]; return out;
  }

  /** 拖一下滑块走这一条：D1/D2 + 收边 → Uint8 蒙版（0~255，C.u8 同款取整） */
  function tune(b, P) {
    P = Object.assign({}, DEFAULTS, P || {});
    const r = d1d2(b, P), a = finish(r.m2, P, b.w, b.h), u = new Uint8Array(a.length);
    let on = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i] * 255 + 0.5; u[i] = v <= 0 ? 0 : v >= 255 ? 255 : (v | 0); if (r.m2[i]) on++; }
    return { mask: u, t: r.t, t0: b.t0, minPx: r.minPx, minLen: r.minLen, coverage: on / a.length };
  }

  const api = { DEFAULTS, KEEP_NAMES, pyRound, absdiff, otsu, components, speckle_px, sens_factor, thr_of, smooth_px, feather_px, keep_px,
    prepare, level, grow, d1d2, distance, gaussKernel, gaussian, openEllipse, keep_main, smooth, feather, soften, finish, tune };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7DiffMask = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)));
