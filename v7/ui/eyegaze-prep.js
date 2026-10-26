/* ═══════════════════════════════════════════════════════════════
   眼神调整 · 准备（找眼睛之后的全部：精修眼珠圈、眼眶、抠眼珠补全、眼神光、眼白补洞、明暗图）
   2026-10-26（用户：「眼神调整需要装 python，有些人电脑没有，能不能绕过 python」→ 选方案 A：整个搬进软件里算）

   ⚠ 这是 engine/eyegaze/eyelib.py + service.py 的逐行 JS 版（函数名、顺序、常数、注释里的实测结论都照搬），
     图像操作用网页版 OpenCV（ui-pure/vendor/opencv-4.12.0，跟 Python 的 cv2 同一套算法，GrabCut 也定同一个种子）。
     改算法时两边要一起改；对照脚本 tools/eyegaze/parity/eg_parity.cjs（拿 Python 版存的基准逐层比）。
   ⚠ 只管「图 + 关键点 → 界面要的图层」，不找脸（找脸在 eyegaze-worker.js 里用网页版 MediaPipe）。
     纯函数、不碰 DOM：后台线程和 node 对照脚本都用它。
   ⚠ numpy 的 float32 运算这里用 Math.fround 跟着舍（f()），阈值判断和找圆的打分才会跟 Python 落在同一边。

   图的表示：{ w, h, c, d }，d 是 Float32Array / Uint8Array，按行、每像素 c 个通道挨着放（跟 numpy 的 HWC 一样）。
   彩图都是 BGR（跟 cv2 一样），出图层时再按 service.py 的方式换成浏览器读 PNG 后的 RGBA 排法。
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const f = Math.fround;

  const EYE_UPPER = { R: [33, 246, 161, 160, 159, 158, 157, 173, 133], L: [263, 466, 388, 387, 386, 385, 384, 398, 362] };
  const EYE_LOWER = { R: [133, 155, 154, 153, 145, 144, 163, 7, 33], L: [362, 382, 381, 380, 374, 373, 390, 249, 263] };
  const IRIS_GROUPS = [[468, 469, 470, 471, 472], [473, 474, 475, 476, 477]];
  const SDF_SCALE = 8.0;
  const MAX_SIDE = 2048, MAX_UP = 3.0, WORK_MAX = 4096, RNG_SEED = 20261025;
  const GC_BGD = 0, GC_FGD = 1, GC_PR_BGD = 2, GC_PR_FGD = 3;

  class EyeGazeError extends Error { constructor(msg) { super(msg); this.code = 'EYEGAZE_UNUSABLE'; } }

  // ─── 跟 Python 对齐的小工具 ───────────────────────────────────
  // Python 的 round()：四舍六入五成双
  function pyRound(x) {
    const r = Math.round(x);
    const v = (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
    return v === 0 ? 0 : v;      // Python 的 round 回的是整数 0，没有 -0
  }
  // Python 的 "%.Nf"：逢正好一半时也是五成双（toFixed 是往远离 0 的方向）
  function pyFixed(x, n) {
    const s = x.toFixed(n), k = Math.pow(10, n), y = x * k;
    if (Math.abs(y - Math.trunc(y)) === 0.5 && Number.isFinite(y)) {
      const lo = Math.trunc(y), pick = (lo % 2 === 0) ? lo : lo + Math.sign(y);
      return (pick / k).toFixed(n);
    }
    return s;
  }
  function img(w, h, c, Ctor) { return { w, h, c, d: new (Ctor || Float32Array)(w * h * c) }; }
  function chan(a, k) {          // 取第 k 个通道
    const o = img(a.w, a.h, 1), n = a.w * a.h, c = a.c;
    for (let i = 0; i < n; i++) o.d[i] = a.d[i * c + k];
    return o;
  }
  // dbl = 输入是 float64（numpy 里那个数组已经变成 float64 了）：不按 float32 舍
  function median(arr, dbl) {    // np.median：偶数个时取中间两个的平均
    const n = arr.length;
    if (!n) return NaN;
    const s = (dbl ? Float64Array : Float32Array).from(arr).sort();
    if (n % 2) return s[(n - 1) >> 1];
    return dbl ? (s[n / 2 - 1] + s[n / 2]) / 2 : f(f(s[n / 2 - 1] + s[n / 2]) / 2);
  }
  function percentile(arr, q, dbl) {  // np.percentile 默认「linear」
    const n = arr.length;
    const s = (dbl ? Float64Array : Float32Array).from(arr).sort();
    const idx = (n - 1) * (q / 100), lo = Math.floor(idx), hi = Math.min(n - 1, lo + 1), t = idx - lo;
    const a = s[lo], b = s[hi], v = t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t;
    return dbl ? v : f(v);
  }
  // numpy 对一行 float32 求和（np.add.reduce 走 pairwise_sum：8 路分开累加再两两合并）
  function pairwiseF32(a, off, n) {
    if (n < 8) { let r = 0; for (let i = 0; i < n; i++) r = f(r + a[off + i]); return r; }
    if (n <= 128) {
      const r = [a[off], a[off + 1], a[off + 2], a[off + 3], a[off + 4], a[off + 5], a[off + 6], a[off + 7]];
      let i = 8;
      for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = f(r[j] + a[off + i + j]);
      let res = f(f(f(r[0] + r[1]) + f(r[2] + r[3])) + f(f(r[4] + r[5]) + f(r[6] + r[7])));
      for (; i < n; i++) res = f(res + a[off + i]);
      return res;
    }
    let n2 = Math.floor(n / 2); n2 -= n2 % 8;
    return f(pairwiseF32(a, off, n2) + pairwiseF32(a, off + n2, n - n2));
  }
  function linspace(a, b, n, endpoint) {
    const div = endpoint ? n - 1 : n, step = (b - a) / div, out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = i * step + a;
    if (endpoint && n > 1) out[n - 1] = b;
    return out;
  }
  function arange(a, b, step) {   // np.arange：先算头两个，之后按「第二个 - 第一个」的步长填（numpy 的 fill 就是这么干的）
    const n = Math.max(0, Math.ceil((b - a) / step)), out = new Float64Array(n);
    if (n > 0) out[0] = a;
    if (n > 1) out[1] = a + step;
    const delta = (a + step) - a;
    for (let i = 2; i < n; i++) out[i] = a + i * delta;
    return out;
  }
  // np.linalg.norm（float32 的两个数）：平方和开方，都在 float32 里
  const norm2 = (ax, ay, bx, by) => { const dx = f(ax - bx), dy = f(ay - by); return f(Math.sqrt(f(f(dx * dx) + f(dy * dy)))); };

  // cv2.distanceTransform(src, DIST_L2, 5)：5×5 倒角距离（权重 1 / 1.4 / 2.1969），两遍扫描，float32 累加；src 里 0 的像素是「目标」
  function chamfer5(a) {
    const W = a.w, H = a.h, src = a.d, A = f(1), B = f(1.4), C = f(2.1969);
    const SW = W + 4, t = new Float32Array((H + 4) * SW).fill(f(1e20));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y + 2) * SW + x + 2;
      if (!src[y * W + x]) { t[k] = 0; continue; }
      let m = f(t[k - 2 * SW - 1] + C), v;
      if ((v = f(t[k - 2 * SW + 1] + C)) < m) m = v;
      if ((v = f(t[k - SW - 2] + C)) < m) m = v;
      if ((v = f(t[k - SW - 1] + B)) < m) m = v;
      if ((v = f(t[k - SW] + A)) < m) m = v;
      if ((v = f(t[k - SW + 1] + B)) < m) m = v;
      if ((v = f(t[k - SW + 2] + C)) < m) m = v;
      if ((v = f(t[k - 1] + A)) < m) m = v;
      t[k] = m;
    }
    const o = img(W, H, 1);
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const k = (y + 2) * SW + x + 2;
      let m = t[k], v;
      if (m > A) {
        if ((v = f(t[k + 2 * SW + 1] + C)) < m) m = v;
        if ((v = f(t[k + 2 * SW - 1] + C)) < m) m = v;
        if ((v = f(t[k + SW + 2] + C)) < m) m = v;
        if ((v = f(t[k + SW + 1] + B)) < m) m = v;
        if ((v = f(t[k + SW] + A)) < m) m = v;
        if ((v = f(t[k + SW - 1] + B)) < m) m = v;
        if ((v = f(t[k + SW - 2] + C)) < m) m = v;
        if ((v = f(t[k + 1] + A)) < m) m = v;
        t[k] = m;
      }
      o.d[y * W + x] = m;
    }
    return o;
  }

  // ─── OpenCV 搬运（Mat 用完就 delete，WASM 内存不会自己回收）──
  function makeCv(cv) {
    const T32 = c => cv.CV_32F + ((c - 1) << 3), T8 = c => cv.CV_8U + ((c - 1) << 3);
    function toMat(a) {
      const isU8 = a.d instanceof Uint8Array, m = new cv.Mat(a.h, a.w, isU8 ? T8(a.c) : T32(a.c));
      (isU8 ? m.data : m.data32F).set(a.d);
      return m;
    }
    function fromMat(m, c) {
      const t = m.type() & 7;
      const o = { w: m.cols, h: m.rows, c: c || m.channels(), d: t === cv.CV_8U ? Uint8Array.from(m.data) : t === cv.CV_32S ? Int32Array.from(m.data32S) : Float32Array.from(m.data32F) };
      return o;
    }
    function run(inputs, fn) {   // inputs: 图 → Mat；fn(mats, out) 往 out 里写；返回 out 的图，全部 delete
      const mats = inputs.map(toMat), out = new cv.Mat();
      try { fn(mats, out); return fromMat(out); } finally { mats.forEach(m => m.delete()); out.delete(); }
    }
    return {
      resize: (a, w, h, interp) => run([a], ([m], o) => cv.resize(m, o, new cv.Size(w, h), 0, 0, interp)),
      blur: (a, sx, sy) => run([a], ([m], o) => cv.GaussianBlur(m, o, new cv.Size(0, 0), sx, sy == null ? 0 : sy, cv.BORDER_DEFAULT)),
      // ⚠ 不用 cv.distanceTransform：网页版 OpenCV 没带 IPP，走 16 位定点（1.4 算成 1.39999），
      //   Python 的 cv2 带 IPP、是浮点（1.4 就是 1.4）。差 0.0002 也会让「眼眶里 > 0」这类判断翻个别像素，
      //   GrabCut 的输入差一个像素结果就全变（10-26 对照实测）⇒ 自己按 float32 两遍扫描算（跟 IPP 逐像素一样，
      //   只有离边 30 像素以外的个别点差最后一位，那么远的值出图层时早被夹掉了）。
      dist: a => chamfer5(a),
      lab: a => run([a], ([m], o) => cv.cvtColor(m, o, cv.COLOR_BGR2Lab)),
      dilate: (a, kind, k) => run([a], ([m], o) => {
        const ker = kind === 'ellipse' ? cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)) : cv.Mat.ones(k, k, cv.CV_8U);
        try { cv.dilate(m, o, ker, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue()); } finally { ker.delete(); }
      }),
      blackhat: (a, k) => run([a], ([m], o) => {
        const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
        try { cv.morphologyEx(m, o, cv.MORPH_BLACKHAT, ker, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue()); } finally { ker.delete(); }
      }),
      // remap：xs / ys 是同样大小的 float32 坐标图
      remap: (a, xs, ys, interp, border) => {
        const m = toMat(a), mx = toMat(xs), my = toMat(ys), o = new cv.Mat();
        try {
          cv.remap(m, o, mx, my, interp == null ? cv.INTER_LINEAR : interp, border == null ? cv.BORDER_REPLICATE : border, new cv.Scalar(0, 0, 0, 0));
          return fromMat(o);
        } finally { m.delete(); mx.delete(); my.delete(); o.delete(); }
      },
      fillPoly: (a, pts, val, shift) => {     // pts: Int32Array [x0,y0,x1,y1…]；原地改 a（u8 单通道）
        const m = toMat(a), p = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, Array.from(pts)), v = new cv.MatVector();
        v.push_back(p);
        try { cv.fillPoly(m, v, new cv.Scalar(val, val, val, val), cv.LINE_8, shift || 0, new cv.Point(0, 0)); a.d.set(m.data); }
        finally { m.delete(); p.delete(); v.delete(); }
      },
      polyline: (a, pts, val) => {
        const m = toMat(a), p = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, Array.from(pts)), v = new cv.MatVector();
        v.push_back(p);
        try { cv.polylines(m, v, false, new cv.Scalar(val, val, val, val), 1, cv.LINE_8, 0); a.d.set(m.data); }
        finally { m.delete(); p.delete(); v.delete(); }
      },
      // → { n, labels(Int32Array), stats: [[x,y,w,h,area]…] }
      ccStats: (a, conn) => {
        const m = toMat(a), lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
        try {
          const n = cv.connectedComponentsWithStats(m, lab, st, ce, conn, cv.CV_32S);
          const S = [];
          for (let i = 0; i < n; i++) S.push(Array.from(st.data32S.subarray(i * 5, i * 5 + 5)));
          return { n, labels: Int32Array.from(lab.data32S), stats: S };
        } finally { m.delete(); lab.delete(); st.delete(); ce.delete(); }
      },
      cc: (a, conn) => {
        const m = toMat(a), lab = new cv.Mat();
        try { const n = cv.connectedComponents(m, lab, conn, cv.CV_32S); return { n, labels: Int32Array.from(lab.data32S) }; }
        finally { m.delete(); lab.delete(); }
      },
      // 最大的那条外轮廓（同面积取先出现的，跟 Python 的 max() 一样）→ Float32Array [x,y…] 或 null
      biggestContour: a => {
        const m = toMat(a), cs = new cv.MatVector(), hi = new cv.Mat();
        try {
          cv.findContours(m, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
          let best = -1, bi = -1;
          for (let i = 0; i < cs.size(); i++) { const c = cs.get(i); const ar = cv.contourArea(c); if (ar > best) { best = ar; bi = i; } c.delete(); }
          if (bi < 0) return null;
          const c = cs.get(bi), out = Float32Array.from(c.data32S);
          c.delete();
          return out;
        } finally { m.delete(); cs.delete(); hi.delete(); }
      },
      grabCut: (bgr8, mask, iters) => {        // 原地改 mask.d；失败返回 false
        const m = toMat(bgr8), mk = toMat(mask), bg = new cv.Mat(), fg = new cv.Mat();
        try { cv.grabCut(m, mk, new cv.Rect(0, 0, 0, 0), bg, fg, iters, cv.GC_INIT_WITH_MASK); mask.d.set(mk.data); return true; }
        catch (_) { return false; }
        finally { m.delete(); mk.delete(); bg.delete(); fg.delete(); }
      },
      filterRadial: P => {     // cv2.filter2D(P, -1, [[.25],[.5],[.25]], BORDER_REPLICATE)：沿行方向（第一维）三点平滑
        const o = img(P.w, P.h, P.c), W = P.w * P.c, a = f(0.25), b = f(0.5);
        for (let y = 0; y < P.h; y++) {
          const u = Math.max(0, y - 1) * W, m0 = y * W, dn = Math.min(P.h - 1, y + 1) * W;
          for (let x = 0; x < W; x++) o.d[m0 + x] = f(f(f(P.d[u + x] * a) + f(P.d[m0 + x] * b)) + f(P.d[dn + x] * a));
        }
        return o;
      },
      cv,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  小工具（eyelib.py 同名函数）
  // ═══════════════════════════════════════════════════════════════
  const W114 = f(0.114), W587 = f(0.587), W299 = f(0.299);
  const isD = a => a.d instanceof Float64Array;
  function lum(bgr) {
    const n = bgr.w * bgr.h, d = bgr.d;
    if (isD(bgr)) {
      const o = img(bgr.w, bgr.h, 1, Float64Array);
      for (let i = 0, j = 0; i < n; i++, j += 3) o.d[i] = d[j] * 0.114 + d[j + 1] * 0.587 + d[j + 2] * 0.299;
      return o;
    }
    const o = img(bgr.w, bgr.h, 1);
    for (let i = 0, j = 0; i < n; i++, j += 3) o.d[i] = f(f(f(d[j] * W114) + f(d[j + 1] * W587)) + f(d[j + 2] * W299));
    return o;
  }
  function sat(bgr) {
    const n = bgr.w * bgr.h, d = bgr.d, dbl = isD(bgr), o = img(bgr.w, bgr.h, 1, dbl ? Float64Array : Float32Array), tiny = dbl ? 1e-4 : f(1e-4);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const mx = Math.max(d[j], d[j + 1], d[j + 2]), mn = Math.min(d[j], d[j + 1], d[j + 2]);
      o.d[i] = dbl ? (mx - mn) / Math.max(mx, tiny) : f(f(mx - mn) / Math.max(mx, tiny));
    }
    return o;
  }

  function catmull(pts, n) {     // pts: [[x,y]…] float64 运算，最后转 float32
    n = n || 12;
    const N = pts.length, P = [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]]].concat(pts.map(p => [p[0], p[1]]), [[2 * pts[N - 1][0] - pts[N - 2][0], 2 * pts[N - 1][1] - pts[N - 2][1]]]);
    const t = linspace(0, 1, n, false), out = [];
    for (let i = 1; i < P.length - 2; i++) {
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      for (let k = 0; k < n; k++) {
        const tt = t[k], t2 = tt * tt, t3 = tt * tt * tt, q = [0, 0];
        for (let c = 0; c < 2; c++) q[c] = f(0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * tt + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
        out.push(q);
      }
    }
    out.push([f(pts[N - 1][0]), f(pts[N - 1][1])]);
    return out;
  }

  function openingSdf(K, upper, lower, w, h, ss) {
    ss = ss || 4;
    const cu = catmull(upper), cl = catmull(lower);
    const poly = cu.concat(cl.slice(1, -1));
    const hi = img(w * ss, h * ss, 1, Uint8Array);
    const half = f((ss - 1) / 2.0), pts = new Int32Array(poly.length * 2);
    poly.forEach((p, i) => { pts[2 * i] = pyRoundF(f(f(f(p[0] * ss) + half) * 16)); pts[2 * i + 1] = pyRoundF(f(f(f(p[1] * ss) + half) * 16)); });
    K.fillPoly(hi, pts, 255, 4);
    const sd = sdfOf(K, hi, w, h, ss);
    const dist = [];
    for (const cur of [cu, cl.slice(1, -1)]) {
      const line = img(w, h, 1, Uint8Array); line.d.fill(255);
      const q = new Int32Array(cur.length * 2);
      cur.forEach((p, i) => { q[2 * i] = pyRoundF(p[0]); q[2 * i + 1] = pyRoundF(p[1]); });
      K.polyline(line, q, 0);
      dist.push(K.dist(line));
    }
    const near = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) near[i] = dist[0].d[i] < dist[1].d[i] ? 1 : 0;
    return { sd, poly, near };
  }
  // np.round（float32 输入）：五成双
  function pyRoundF(x) { return pyRound(x); }
  // 超采样二值图 → 有符号距离（缩回原尺寸）
  function sdfOf(K, hi, w, h, ss) {
    const din = K.dist(hi);
    const inv = img(hi.w, hi.h, 1, Uint8Array);
    for (let i = 0; i < inv.d.length; i++) inv.d[i] = 255 - hi.d[i];
    const dout = K.dist(inv), diff = img(hi.w, hi.h, 1), s = f(ss);
    for (let i = 0; i < diff.d.length; i++) diff.d[i] = f(f(din.d[i] - dout.d[i]) / s);
    return K.resize(diff, w, h, K.cv.INTER_AREA);
  }

  function sdfFromMask(K, soft, ss) {
    ss = ss || 4;
    const w = soft.w, h = soft.h;
    const up = K.resize(soft, w * ss, h * ss, K.cv.INTER_LINEAR);
    const hi = img(w * ss, h * ss, 1, Uint8Array);
    const thr = f(0.5);
    for (let i = 0; i < hi.d.length; i++) hi.d[i] = up.d[i] > thr ? 255 : 0;
    const sd = sdfOf(K, hi, w, h, ss);
    const c = K.biggestContour(hi);
    let poly = null;
    if (c) {
      const half = f((ss - 1) / 2.0);
      poly = [];
      for (let i = 0; i < c.length; i += 2) poly.push([f(f(c[i] - half) / ss), f(f(c[i + 1] - half) / ss)]);
    }
    return { sd, poly };
  }

  function refineOpening(K, crop, sd, r0m, near) {
    const h = sd.h, w = sd.w, n = w * h;
    const k = Math.max(2.0, 0.2 * r0m), kf = f(k), km = f(-k);
    const mask = img(w, h, 1, Uint8Array);
    let nf = 0, nb = 0;
    for (let i = 0; i < n; i++) {
      const v = sd.d[i];
      let m = GC_PR_BGD;
      if (v > 0) m = GC_PR_FGD;
      if (v > kf) m = GC_FGD;
      if (v < km) m = GC_BGD;
      if (near[i] && v < -1.0) m = GC_BGD;
      mask.d[i] = m;
      if (m === GC_FGD) nf++; else if (m === GC_BGD) nb++;
    }
    if (nf < 20 || nb < 20) return { sd, poly: null, why: '眼睛太小，眼眶线没精修' };
    const img8 = img(w, h, 3, Uint8Array), c255 = f(255), half = f(0.5);
    for (let i = 0; i < n * 3; i++) img8.d[i] = Math.min(255, Math.max(0, f(f(crop.d[i] * c255) + half))) | 0;
    if (!K.grabCut(img8, mask, 4)) return { sd, poly: null, why: '眼眶线精修失败，用的关键点原线' };
    const fg = img(w, h, 1, Uint8Array);
    for (let i = 0; i < n; i++) fg.d[i] = (mask.d[i] === GC_FGD || mask.d[i] === GC_PR_FGD) ? 1 : 0;
    const cs = K.ccStats(fg, 8);
    if (cs.n <= 1) return { sd, poly: null, why: '眼眶线精修失败，用的关键点原线' };
    let big = 1;
    for (let i = 2; i < cs.n; i++) if (cs.stats[i][4] > cs.stats[big][4]) big = i;
    for (let i = 0; i < n; i++) fg.d[i] = cs.labels[i] === big ? 1 : 0;
    // 补掉里面的小洞（眼神光、瞳孔有时会被分成背景）
    const inv = img(w, h, 1, Uint8Array);
    for (let i = 0; i < n; i++) inv.d[i] = 1 - fg.d[i];
    const c2 = K.ccStats(inv, 4);
    const fillIt = new Uint8Array(c2.n);
    for (let i = 1; i < c2.n; i++) { const [x, y, ww, hh] = c2.stats[i]; if (x > 0 && y > 0 && x + ww < w && y + hh < h) fillIt[i] = 1; }
    for (let i = 0; i < n; i++) if (fillIt[c2.labels[i]]) fg.d[i] = 1;
    let a0 = 0, a1 = 0;
    for (let i = 0; i < n; i++) { if (sd.d[i] > 0) a0++; a1 += fg.d[i]; }
    if (a1 < 0.65 * a0 || a1 > 1.35 * a0) return { sd, poly: null, why: '眼眶线精修结果离谱(面积变' + pyFixed(100 * (a1 / Math.max(a0, 1) - 1), 0) + '%)，用的关键点原线' };
    const ff = img(w, h, 1);
    for (let i = 0; i < n; i++) ff.d[i] = fg.d[i];
    const r = sdfFromMask(K, K.blur(ff, 1.0));
    return { sd: r.sd, poly: r.poly, why: null };
  }

  // 只用权重 w>0 的像素（眼白）去估整块的颜色（eyelib._norm_conv_fill）
  function normConvFill(K, im, wgt, sigmas) {
    const n = im.w * im.h;
    let sw = 0;
    const fb = [0, 0, 0];
    for (let i = 0; i < n; i++) { const ww = wgt.d[i]; sw += ww; for (let c = 0; c < 3; c++) fb[c] += f(im.d[i * 3 + c] * ww); }
    const fbv = fb.map(v => f(v / Math.max(sw, 1e-6)));
    const iw = img(im.w, im.h, 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) iw.d[i * 3 + c] = f(im.d[i * 3 + c] * wgt.d[i]);
    let out = null;
    const order = sigmas.slice().sort((a, b) => -(a[0] * a[1]) + (b[0] * b[1]));
    const t4 = f(1e-4), t6 = f(1e-6), c12 = f(0.12);
    for (const [sx, sy] of order) {
      const ws = K.blur(wgt, sx, sy), num = K.blur(iw, sx, sy);
      const cur = img(im.w, im.h, 3);
      for (let i = 0; i < n; i++) {
        const wv = ws.d[i], ok = wv > t4, den = Math.max(wv, t6), conf = Math.min(1, Math.max(0, f(wv / c12)));
        for (let c = 0; c < 3; c++) {
          const fv = ok ? f(num.d[i * 3 + c] / den) : fbv[c];
          cur.d[i * 3 + c] = out ? f(f(conf * fv) + f(f(1 - conf) * out.d[i * 3 + c])) : fv;
        }
      }
      out = cur;
    }
    return out;
  }

  // 极坐标展开后逐圈补（eyelib._fill_polar_rows）。P: { w: Nt, h: Nr, c }，vis: Uint8Array(Nr*Nt)
  function fillPolarRows(K, P0, vis) {
    const Nr = P0.h, Nt = P0.w, C = P0.c;
    const P = { w: Nt, h: Nr, c: C, d: Float32Array.from(P0.d) };
    const have = new Uint8Array(Nr);
    for (let i = 0; i < Nr; i++) {
      const v = vis.subarray(i * Nt, (i + 1) * Nt);
      let all = true;
      for (let t = 0; t < Nt; t++) if (!v[t]) { all = false; break; }
      if (all) { have[i] = 1; continue; }
      const vidx = [];
      for (let t = 0; t < Nt; t++) if (v[t]) vidx.push(t);
      const M = vidx.length;
      if (M < 3) continue;
      have[i] = 1;
      const inv = t => !v[((t % Nt) + Nt) % Nt];
      const row = P.d.slice(i * Nt * C, (i + 1) * Nt * C);
      const ssorted = (x) => { let lo = 0, hi = M; while (lo < hi) { const mid = (lo + hi) >> 1; if (vidx[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
      for (let a = 0; a < Nt; a++) {
        if (!(inv(a) && !inv(a - 1))) continue;     // 每段看不见的角度的起点
        let nn = 0;
        while (inv(a + nn)) nn++;
        const kl = ssorted(((a - 1) % Nt + Nt) % Nt), kr = ssorted((a + nn) % Nt);
        for (let ks = 0; ks < nn; ks++) {
          const li = vidx[(((kl - ks) % M) + M) % M], ri = vidx[(kr + (nn - 1 - ks)) % M];
          const t = (ks + 1) / (nn + 1.0);
          let wg = Math.min(1, Math.max(0, (t - 0.3) / 0.4));
          wg = wg * wg * (3 - 2 * wg);
          const dst = (i * Nt + ((a + ks) % Nt)) * C;
          for (let c = 0; c < C; c++) P.d[dst + c] = f((1 - wg) * row[li * C + c] + wg * row[ri * C + c]);
        }
      }
    }
    // 一点都看不见的圈：抄最近的有内容的圈
    let anyHave = false, allHave = true;
    for (let i = 0; i < Nr; i++) { if (have[i]) anyHave = true; else allHave = false; }
    if (!allHave && anyHave) {
      const idx = [];
      for (let i = 0; i < Nr; i++) if (have[i]) idx.push(i);
      for (let i = 0; i < Nr; i++) {
        if (have[i]) continue;
        let best = idx[0];
        for (const j of idx) if (Math.abs(j - i) < Math.abs(best - i)) best = j;
        P.d.copyWithin(i * Nt * C, best * Nt * C, (best + 1) * Nt * C);
      }
    }
    const sm = K.filterRadial(P);
    const out = { w: Nt, h: Nr, c: C, d: new Float32Array(P.d.length) };
    for (let p = 0; p < Nr * Nt; p++) for (let c = 0; c < C; c++) out.d[p * C + c] = vis[p] ? P.d[p * C + c] : sm.d[p * C + c];
    return out;
  }

  function fillNanNearest(a) {
    const good = [];
    for (let k = 0; k < a.length; k++) if (!Number.isNaN(a[k])) good.push(k);
    if (!good.length) return null;
    const out = Float32Array.from(a);
    for (let k = 0; k < a.length; k++) {
      if (!Number.isNaN(a[k])) continue;
      let best = good[0];
      for (const g of good) if (Math.abs(g - k) < Math.abs(best - k)) best = g;
      out[k] = a[best];
    }
    return out;
  }

  // 双线性取样（= _sample：cv2.remap，INTER_LINEAR，BORDER_REPLICATE）。xs/ys 同形状的 Float32Array
  function sample(K, im, xs, ys, cols, rows, interp, border) {
    return K.remap(im, { w: cols, h: rows, c: 1, d: xs }, { w: cols, h: rows, c: 1, d: ys }, interp, border);
  }

  // ═══════════════════════════════════════════════════════════════
  //  第一段：裁眼、眼眶距离场、"和眼白差多少"图、找圆的打分表（eyelib._stage1）
  // ═══════════════════════════════════════════════════════════════
  function stage1(K, im, eye, r0m, rs) {
    const H = im.h, W = im.w;
    const up = eye.upper, lo = eye.lower;
    const r0 = eye.iris_r, c0 = eye.iris_c;
    const allp = up.concat(lo);
    const width = norm2(up[0][0], up[0][1], up[8][0], up[8][1]);
    const pad = Math.max(r0m * 1.6, 0.15 * width, 6.0);
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of allp) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); }
    const fp = f(pad);
    const x0 = Math.floor(Math.max(0, f(mnx - fp))), y0 = Math.floor(Math.max(0, f(mny - fp)));
    const x1 = Math.ceil(Math.min(W, f(mxx + fp))), y1 = Math.ceil(Math.min(H, f(mxy + fp)));
    const w = x1 - x0, h = y1 - y0, n = w * h;
    const crop = img(w, h, 3), c255 = f(255.0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) crop.d[(y * w + x) * 3 + c] = f(im.d[((y + y0) * W + x + x0) * 3 + c] / c255);
    const off = [x0, y0];
    const c0c = [f(c0[0] - x0), f(c0[1] - y0)];
    const shift = pts => pts.map(p => [f(p[0] - x0), f(p[1] - y0)]);
    const os = openingSdf(K, shift(up), shift(lo), w, h);
    let sd = os.sd, poly = os.poly;
    const poly0 = os.poly, sd0 = os.sd, near = os.near;
    const rf = refineOpening(K, crop, sd, r0m, near);
    sd = rf.sd;
    if (rf.poly) poly = rf.poly;
    const gray = lum(crop);

    // 眼白参考色：眼眶里、关键点眼珠圈外，"亮且不饱和"的前 30%
    const lab = K.lab(crop);
    const chroma = new Float32Array(n);
    for (let i = 0; i < n; i++) chroma[i] = f(Math.hypot(lab.d[i * 3 + 1], lab.d[i * 3 + 2]));
    const t115 = f(1.15 * r0), t15 = f(1.5);
    let pool = new Uint8Array(n), npool = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (sd.d[i] > t15 && f(Math.hypot(f(x - c0c[0]), f(y - c0c[1]))) > t115) { pool[i] = 1; npool++; }
    }
    if (npool < 8) { npool = 0; for (let i = 0; i < n; i++) { pool[i] = sd.d[i] > 0.5 ? 1 : 0; npool += pool[i]; } }
    const sc = [], c15 = f(1.5);
    for (let i = 0; i < n; i++) if (pool[i]) sc.push(f(lab.d[i * 3] - f(c15 * chroma[i])));
    const p70 = percentile(sc, 70);
    const top = new Uint8Array(n);
    for (let i = 0, k = 0; i < n; i++) if (pool[i]) { top[i] = sc[k++] >= p70 ? 1 : 0; }
    const refLab = [0, 1, 2].map(c => { const v = []; for (let i = 0; i < n; i++) if (top[i]) v.push(lab.d[i * 3 + c]); return median(v); });
    const gv = []; for (let i = 0; i < n; i++) if (top[i]) gv.push(gray.d[i]);
    const refGray = median(gv);
    // "和眼白差多少"：眼珠不管深色、蓝色还是粉色美瞳，和眼白的颜色差都大
    const Q = img(w, h, 1), c100 = f(100.0);
    for (let i = 0; i < n; i++) {
      const a = f(lab.d[i * 3] - refLab[0]), b = f(lab.d[i * 3 + 1] - refLab[1]), c = f(lab.d[i * 3 + 2] - refLab[2]);
      Q.d[i] = f(f(Math.sqrt(f(f(f(a * a) + f(b * b)) + f(c * c)))) / c100);
    }
    const Qb = K.blur(Q, 0.6);

    // Daugman：每个(圆心, 半径)只看露在眼眶里的弧段，"圈里差得多、圈外差得少"越明显分越高
    const step = Math.max(0.5, r0m / 25.0);
    const offs = arange(-0.6 * r0m, 0.6 * r0m + 1e-6, step);
    const no = offs.length, Nc = no * no, Nr = rs.length, NA = 96;
    const GX = new Float64Array(Nc), GY = new Float64Array(Nc);
    for (let i = 0; i < no; i++) for (let j = 0; j < no; j++) { GX[i * no + j] = c0c[0] + offs[i]; GY[i * no + j] = c0c[1] + offs[j]; }
    const ang = linspace(0, 2 * Math.PI, NA, false), co = ang.map(Math.cos), si = ang.map(Math.sin);
    const rowsN = Nc * Nr;
    const xin = new Float32Array(rowsN * NA), yin = new Float32Array(rowsN * NA), xo = new Float32Array(rowsN * NA), yo = new Float32Array(rowsN * NA);
    for (let ci = 0; ci < Nc; ci++) for (let ri = 0; ri < Nr; ri++) {
      const row = ci * Nr + ri, CX = GX[ci], CY = GY[ci], RR = rs[ri], dl = Math.max(1.0, 0.08 * RR);
      for (let a = 0; a < NA; a++) {
        const k = row * NA + a;
        xin[k] = CX + (RR - dl) * co[a]; yin[k] = CY + (RR - dl) * si[a];
        xo[k] = CX + (RR + dl) * co[a]; yo[k] = CY + (RR + dl) * si[a];
      }
    }
    const qin = sample(K, Qb, xin, yin, NA, rowsN), qout = sample(K, Qb, xo, yo, NA, rowsN);
    const sin_ = sample(K, sd, xin, yin, NA, rowsN), sout = sample(K, sd, xo, yo, NA, rowsN);
    const score = new Float64Array(rowsN), diffA = new Float64Array(rowsN), arcA = new Float64Array(rowsN);
    const dq = new Float32Array(NA);
    for (let row = 0; row < rowsN; row++) {
      let cnt = 0;
      for (let a = 0; a < NA; a++) {
        const k = row * NA + a;
        if (sin_.d[k] > t15 && sout.d[k] > t15) { cnt++; dq[a] = f(qin.d[k] - qout.d[k]); } else dq[a] = 0;
      }
      // np.where(vis, qin - qout, 0).sum(1) / np.maximum(cnt, 1)：float32 的和 ÷ 整数 ⇒ 结果是 float64
      const diff = pairwiseF32(dq, 0, NA) / Math.max(cnt, 1);
      const ci = (row / Nr) | 0;
      const pen = 0.06 * Math.hypot(GX[ci] - c0c[0], GY[ci] - c0c[1]) / r0m;
      score[row] = cnt >= 0.2 * NA ? diff - pen : -1e9;
      diffA[row] = diff; arcA[row] = cnt / NA;
    }
    return { eye, crop: [x0, y0, w, h], off, img: crop, sd, poly, poly0, notes0: rf.why ? [rf.why] : [], lab, refLab, sd0, nearUpper: near,
      gray, Q, refGray, width, r0, GX, GY, Nc, Nr, score, diff: diffA, arc: arcA };
  }

  // 两只眼一起定半径，再各自在这个半径 ±5% 里挑最好的圆心（eyelib._choose_circles）
  function chooseCircles(stages, rs, fixedR) {
    const Nr = rs.length, joint = new Float64Array(Nr);
    for (const s of stages) {
      for (let r = 0; r < Nr; r++) {
        let b = -Infinity;
        for (let c = 0; c < s.Nc; c++) b = Math.max(b, s.score[c * Nr + r]);
        joint[r] += b < -1e8 ? -0.05 : b;
      }
    }
    let j = 0;
    if (fixedR) { for (let r = 1; r < Nr; r++) if (Math.abs(rs[r] - fixedR) < Math.abs(rs[j] - fixedR)) j = r; }
    else { for (let r = 1; r < Nr; r++) if (joint[r] > joint[j]) j = r; }
    const k = Math.max(1, pyRound(0.05 / ((rs[Nr - 1] - rs[0]) / rs[0] / Math.max(1, Nr - 1))));
    const lo = Math.max(0, j - k), hi = Math.min(Nr, j + k + 1);
    return stages.map(s => {
      let best = -Infinity, bc = 0, br = 0;
      for (let c = 0; c < s.Nc; c++) for (let r = lo; r < hi; r++) { const v = s.score[c * Nr + r]; if (v > best) { best = v; bc = c; br = r; } }
      if (best < -1e8) {
        const c = s.eye.iris_c;
        return { c: [f(c[0] - s.off[0]), f(c[1] - s.off[1])], R: rs[j], contrast: 0.0, arc: 0.0 };
      }
      return { c: [s.GX[bc], s.GY[bc]], R: rs[br], contrast: s.diff[bc * Nr + br], arc: s.arc[bc * Nr + br] };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  第二段：圆定了以后，出前端要的全部图层（eyelib._stage2）
  // ═══════════════════════════════════════════════════════════════
  function stage2(K, s, circle) {
    const cx = circle.c[0], cy = circle.c[1], R = circle.R, contrast = circle.contrast, arc = circle.arc;
    const crop = s.img, gray = s.gray, h = gray.h, w = gray.w, n = w * h;
    let sd = s.sd;
    const notes = s.notes0.slice();
    if (contrast < 0.085) notes.push('⚠ 自动找的眼珠圈可能不准(边缘对比' + pyFixed(contrast, 2) + ')，挪动后不对劲就点「手动调眼珠圈」');
    let inside = new Uint8Array(n), visCore = new Uint8Array(n);
    const rho = new Float32Array(n);
    const fcx = f(cx), fcy = f(cy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; rho[i] = f(Math.hypot(f(x - fcx), f(y - fcy))); }
    const setMasks = () => { for (let i = 0; i < n; i++) { inside[i] = sd.d[i] > 0 ? 1 : 0; visCore[i] = sd.d[i] > 1.5 ? 1 : 0; } };
    setMasks();
    const soft = Math.max(1.0, 0.05 * R);
    const refL = s.refGray;
    const fR = f(R);

    // ① 每一圈的中位亮度（同心圈）→ 瞳孔大小 + 眼神光 + 盖在眼珠上的睫毛 都靠它
    const nring = Math.trunc(R) + 3;
    const ring = new Int32Array(n);
    for (let i = 0; i < n; i++) ring[i] = Math.min(nring - 1, Math.max(0, Math.trunc(rho[i])));
    const buckets = Array.from({ length: nring }, () => []);
    for (let i = 0; i < n; i++) if (visCore[i] && rho[i] < fR) buckets[ring[i]].push(gray.d[i]);
    let ref = new Float32Array(nring).fill(NaN);
    for (let k = 0; k < nring; k++) if (buckets[k].length >= 3) ref[k] = median(buckets[k]);
    let ref2 = fillNanNearest(ref);
    if (!ref2) {
      const gin = []; for (let i = 0; i < n; i++) if (inside[i]) gin.push(gray.d[i]);
      ref2 = new Float32Array(nring).fill(gin.length ? median(gin) : 0.5);
    }
    ref = ref2;
    const excess = new Float32Array(n);
    for (let i = 0; i < n; i++) excess[i] = f(gray.d[i] - ref[ring[i]]);
    const exs = []; for (let i = 0; i < n; i++) if (rho[i] < fR && visCore[i]) exs.push(Math.abs(excess[i]));
    const mad = exs.length ? median(exs) : 0.02;

    // 瞳孔：最暗的那圈往外，亮度回升到一半的位置
    let pupil = 0.35;
    const rn = new Float64Array(nring);
    for (let k = 0; k < nring; k++) rn[k] = (k + 0.5) / R;
    const inner = []; for (let k = 0; k < nring; k++) if (rn[k] <= 0.6) inner.push(k);
    const outer = []; for (let k = 0; k < nring; k++) if (rn[k] > 0.6 && rn[k] < 0.9) outer.push(ref[k]);
    if (inner.length && outer.length) {
      let im = inner[0];
      for (const k of inner) if (ref[k] < ref[im]) im = k;
      const ctr = median(outer) - ref[im];
      if (ctr >= 0.04) {
        const thr = f(ref[im] + f(0.5 * ctr));
        let ab = -1;
        for (let k = 0; k < nring; k++) if (k > im && ref[k] > thr) { ab = k; break; }
        if (ab >= 0) pupil = Math.min(0.7, Math.max(0.12, rn[ab]));
      } else notes.push('瞳孔不明显，瞳孔大小滑块按默认值估');
    }

    // ② 眼神光：在眼珠里、比同一圈亮一大截、而且比眼白还亮
    const coreM = new Uint8Array(n);
    const tA = f(Math.max(0.15, 4 * mad)), tB = f(Math.max(0.45, 0.9 * refL)), t35 = f(0.35), r95 = f(0.95 * R);
    for (let i = 0; i < n; i++) coreM[i] = (((excess[i] > tA && gray.d[i] > tB) || excess[i] > t35) && rho[i] < r95 && sd.d[i] > 1.5) ? 1 : 0;
    const ccC = K.ccStats({ w, h, c: 1, d: coreM }, 8);
    const keepSet = new Uint8Array(ccC.n); let nKeep = 0;
    for (let i = 1; i < ccC.n; i++) if (ccC.stats[i][4] >= 2) { keepSet[i] = 1; nKeep++; }
    const core = img(w, h, 1, Uint8Array);
    for (let i = 0; i < n; i++) core.d[i] = keepSet[ccC.labels[i]] ? 1 : 0;
    const catchD = K.dilate(core, 'ellipse', 3);
    const catchM = new Uint8Array(n); for (let i = 0; i < n; i++) catchM[i] = catchD.d[i] > 0 ? 1 : 0;
    const catchF = img(w, h, 1); for (let i = 0; i < n; i++) catchF.d[i] = catchM[i];
    const cb = K.blur(catchF, 0.7), catchA = img(w, h, 1), c13 = f(1.3);
    for (let i = 0; i < n; i++) catchA.d[i] = Math.min(1, Math.max(0, f(cb.d[i] * c13)));
    if (nKeep) notes.push('眼神光 ' + nKeep + ' 处');

    // ③ 盖在眼珠上的睫毛：靠近上眼皮、在瞳孔外、是"细条状的暗线"（黑帽运算）
    const kz = Math.max(3, pyRound(0.25 * R) | 1);
    const bh = K.blackhat(gray, kz);
    const bsv = []; for (let i = 0; i < n; i++) if (rho[i] < fR && visCore[i]) bsv.push(bh.d[i]);
    const bmad = bsv.length ? median(bsv) : 0.01;
    const lashIrisM = img(w, h, 1);
    const tb = f(Math.max(0.06, 4 * bmad)), tsd = f(0.3 * R + 2), tp = f(1.3 * pupil * R), tR1 = f(R + 1);
    for (let i = 0; i < n; i++) lashIrisM.d[i] = (bh.d[i] > tb && sd.d[i] < tsd && s.nearUpper[i] && rho[i] > tp && rho[i] < tR1) ? 1 : 0;
    const lashIris = K.blur(lashIrisM, 0.5);

    // ③b 眼眶二次修正
    const lab = s.lab;
    let polyOut = s.poly;
    let lidFront = img(w, h, 1);
    const ringSel = []; const t65 = f(0.65 * R);
    for (let i = 0; i < n; i++) if (rho[i] > t65 && rho[i] < r95 && visCore[i] && !catchM[i]) ringSel.push(i);
    let irisLab = null;
    if (ringSel.length >= 5) irisLab = [0, 1, 2].map(c => median(ringSel.map(i => lab.d[i * 3 + c])));
    let irisLikeCol = null;
    if (irisLab) {
      irisLikeCol = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const L0 = lab.d[i * 3], A0 = lab.d[i * 3 + 1], B0 = lab.d[i * 3 + 2];
        const di = f(Math.sqrt(f(f(f(f(L0 - irisLab[0]) ** 2) + f(f(A0 - irisLab[1]) ** 2)) + f(f(B0 - irisLab[2]) ** 2))));
        const ds = f(Math.sqrt(f(f(f(f(L0 - s.refLab[0]) ** 2) + f(f(A0 - s.refLab[1]) ** 2)) + f(f(B0 - s.refLab[2]) ** 2))));
        irisLikeCol[i] = (di < f(F07 * ds) && Math.abs(f(L0 - irisLab[0])) < 22) ? 1 : 0;
      }
      const kk = Math.max(2.0, 0.2 * R), fkk = f(kk), fmkk = f(-kk);
      const nu = s.nearUpper;
      const lidThr = f(f(0.45) * irisLab[0]), tp12 = f(1.2 * pupil * R), t13R = f(1.3 * R);
      const lidlike = new Uint8Array(n), lowIris = new Uint8Array(n), seed = new Uint8Array(n);
      const lidF = img(w, h, 1);
      for (let i = 0; i < n; i++) {
        lidlike[i] = (nu[i] && sd.d[i] < fkk && lab.d[i * 3] < lidThr && rho[i] > tp12) ? 1 : 0;
        lidF.d[i] = lidlike[i];
        lowIris[i] = (!nu[i] && sd.d[i] > fmkk && sd.d[i] <= 0 && irisLikeCol[i] && rho[i] < t13R) ? 1 : 0;
        seed[i] = (rho[i] < fR && sd.d[i] > 0) ? 1 : 0;
      }
      lidFront = K.blur(lidF, 0.6);
      const un = img(w, h, 1, Uint8Array);
      let anySeed = false;
      for (let i = 0; i < n; i++) { un.d[i] = (seed[i] || lowIris[i]) ? 1 : 0; if (seed[i]) anySeed = true; }
      const conn = K.cc(un, 8).labels;
      if (anySeed) {
        const cnt = new Map();
        for (let i = 0; i < n; i++) if (seed[i]) cnt.set(conn[i], (cnt.get(conn[i]) || 0) + 1);
        let ci = -1, cm = -1;
        for (const [lbl, c] of [...cnt.entries()].sort((a, b) => a[0] - b[0])) if (c > cm) { cm = c; ci = lbl; }
        for (let i = 0; i < n; i++) if (lowIris[i] && conn[i] !== ci) lowIris[i] = 0;
      }
      const newM = img(w, h, 1);
      let changedM = false;
      for (let i = 0; i < n; i++) {
        const om = sd.d[i] > 0 ? 1 : 0, nm = ((om && !lidlike[i]) || lowIris[i]) ? 1 : 0;
        newM.d[i] = nm;
        if (nm !== om) changedM = true;
      }
      if (changedM) {
        const r = sdfFromMask(K, K.blur(newM, 0.7));
        sd = r.sd;
        setMasks();
        if (r.poly) polyOut = r.poly;
      }
    }

    // ④ 要挖掉的范围：圆再大一圈 + 圆外面"颜色像眼珠、又和眼珠连着"的像素
    const margin = Math.max(2.0, 0.12 * R), holeR = f(R + margin);
    const holeM = new Uint8Array(n);
    for (let i = 0; i < n; i++) holeM[i] = rho[i] < holeR ? 1 : 0;
    if (irisLab) {
      const likeIris = new Uint8Array(n), t14 = f(1.4 * R);
      const g0 = img(w, h, 1, Uint8Array);
      for (let i = 0; i < n; i++) {
        likeIris[i] = (irisLikeCol[i] && rho[i] < t14 && sd.d[i] > -1.0 && !(s.nearUpper[i] && s.sd0.d[i] < 0.5)) ? 1 : 0;
        g0.d[i] = (likeIris[i] || holeM[i]) ? 1 : 0;
      }
      const grown = K.dilate(g0, 'ones', 3);
      const lc = K.cc(grown, 8).labels;
      const ci = lc[Math.min(h - 1, Math.max(0, pyRound(cy))) * w + Math.min(w - 1, Math.max(0, pyRound(cx)))];
      if (ci > 0) {
        const extra = img(w, h, 1, Uint8Array);
        let ne = 0;
        for (let i = 0; i < n; i++) { extra.d[i] = (lc[i] === ci && likeIris[i] && !holeM[i]) ? 1 : 0; ne += extra.d[i]; }
        if (ne > 0.5 * Math.PI * R * R) notes.push('眼珠外圈颜色和周围太像，按圆挖');
        else { const ed = K.dilate(extra, 'ones', 3); for (let i = 0; i < n; i++) if (ed.d[i]) holeM[i] = 1; }
      }
    }
    const holeF = img(w, h, 1); for (let i = 0; i < n; i++) holeF.d[i] = holeM[i];
    const holeSoft = K.blur(holeF, 0.7);

    // ⑤ 眼白：只拿"亮、不太饱和、不在洞里"的像素来估颜色
    const satC = sat(crop);
    const wgt = img(w, h, 1);
    const l45 = f(0.45 * refL), l25 = f(0.25 * refL), s3 = f(0.3), s25 = f(0.25), h05 = f(0.05);
    let sw = 0, ncand = 0;
    const cand = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      cand[i] = (sd.d[i] > 1.0 && holeSoft.d[i] < h05 && !catchM[i]) ? 1 : 0;
      ncand += cand[i];
      const like = f(Math.min(1, Math.max(0, f(f(gray.d[i] - l45) / l25))) * Math.min(1, Math.max(0, f(1 - f(f(satC.d[i] - s3) / s25)))));
      wgt.d[i] = cand[i] * like;
      sw += wgt.d[i];
    }
    if (sw < 5) {
      notes.push('露出来的眼白太少，眼白颜色是猜的');
      for (let i = 0; i < n; i++) wgt.d[i] = ncand >= 5 ? cand[i] : inside[i];
    }
    let F = normConvFill(K, crop, wgt, [[1.6 * R, Math.max(0.8, 0.12 * R)], [2.0 * R, 0.4 * R], [3.0 * R, 1.5 * R]]);

    // ⑤b 上眼皮的影子：眼白越贴近上眼皮越暗
    const D = Math.max(3.0, 0.5 * R), fD = f(D);
    const nu = s.nearUpper, s45 = f(0.45);
    const lumC = lum(crop);
    const profIdx = [];
    for (let i = 0; i < n; i++) if (sd.d[i] > 0 && nu[i] && holeSoft.d[i] < h05 && !catchM[i] && satC.d[i] < s45) profIdx.push(i);
    if (profIdx.length >= 12) {
      const nb = Math.ceil(D) + 1;
      const bins = Array.from({ length: nb }, () => []);
      for (const i of profIdx) bins[Math.min(nb - 1, Math.max(0, Math.trunc(sd.d[i])))].push(lumC.d[i]);
      let prof = new Float64Array(nb);
      for (let b = 0; b < nb; b++) prof[b] = bins[b].length >= 3 ? median(bins[b]) : NaN;
      const farV = [];
      for (let i = 0; i < n; i++) if (sd.d[i] >= fD && holeSoft.d[i] < h05 && !catchM[i] && satC.d[i] < s45) farV.push(lumC.d[i]);
      let pFar;
      if (farV.length >= 5) pFar = median(farV);
      else { pFar = -Infinity; for (const v of prof) if (!Number.isNaN(v)) pFar = Math.max(pFar, v); if (pFar === -Infinity) pFar = NaN; }
      const pf = fillNanNearest(Float64Array.from(prof));
      if (pf) {
        let acc = -Infinity;
        for (let b = 0; b < nb; b++) { acc = Math.max(acc, pf[b]); pf[b] = Math.min(acc, pFar); }
        const LFo = lum(F);
        const wz = img(w, h, 1);
        for (let i = 0; i < n; i++) wz.d[i] = (nu[i] && sd.d[i] < fD && sd.d[i] > -1) ? f(Math.min(1, Math.max(0, f(1 - f(sd.d[i] / fD))))) : 0;
        const wzb = K.blur(wz, 0.8);
        // ⚠ numpy：k 是 float64 ⇒ F 从这里起变成 float64（后面 base / LF / Lb 都跟着是 float64）
        const F2 = img(w, h, 3, Float64Array);
        for (let i = 0; i < n; i++) {
          const dd = Math.min(nb - 1, Math.max(0, sd.d[i]));
          const lo = Math.floor(dd), hi = Math.min(nb - 1, lo + 1);
          const target = lo === hi ? pf[lo] : (pf[hi] - pf[lo]) * (dd - lo) + pf[lo];   // np.interp：斜率 ×(x - xp[j]) + fp[j]
          const k = Math.min(1.0, Math.max(0.3, target / Math.max(LFo.d[i], f(1e-3))));
          const wv = wzb.d[i];
          for (let c = 0; c < 3; c++) F2.d[i * 3 + c] = F.d[i * 3 + c] * (f(1 - wv) + wv * k);
        }
        F = F2;
      }
    }

    // ⑥ 挖掉原眼珠，洞里填眼白
    const fd = isD(F), base = img(w, h, 3, fd ? Float64Array : Float32Array);
    for (let i = 0; i < n; i++) {
      const ha = f(Math.max(holeSoft.d[i], catchA.d[i]) * Math.min(1, Math.max(0, f(sd.d[i] + 1.0))));
      for (let c = 0; c < 3; c++) {
        const keep = f(crop.d[i * 3 + c] * f(1 - ha));
        base.d[i * 3 + c] = fd ? keep + F.d[i * 3 + c] * ha : f(keep + f(F.d[i * 3 + c] * ha));
      }
    }

    // ⑦ 明暗图：眼白本身的亮度变化
    const LF = lum(F);
    let refW;
    const lfv = []; for (let i = 0; i < n; i++) if (sd.d[i] > 1) lfv.push(LF.d[i]);
    if (lfv.length) refW = percentile(lfv, 95, fd); else { refW = -Infinity; for (let i = 0; i < n; i++) refW = Math.max(refW, LF.d[i]); }
    const S = img(w, h, 1), rwm = Math.max(refW, 1e-3), rw = fd ? rwm : f(rwm);
    for (let i = 0; i < n; i++) S.d[i] = f(Math.min(1.0, Math.max(0.3, fd ? LF.d[i] / rw : f(LF.d[i] / rw))));

    // ⑧ 挡在眼球前面的东西单独一层
    const Lb = lum(base);
    const darkM = img(w, h, 1);
    for (let i = 0; i < n; i++) darkM.d[i] = fd ? f((LF.d[i] - gray.d[i]) / Math.max(LF.d[i], 1e-3)) : f(f(LF.d[i] - gray.d[i]) / Math.max(LF.d[i], f(1e-3)));
    const dark = K.blur(darkM, 0.6);
    const lashA = img(w, h, 1), bandOff = f(1.25 * R + 2);
    for (let i = 0; i < n; i++) {
      const band = Math.min(1, Math.max(0, f(f(f(rho[i] - bandOff) / 1.0) + 0.5)));
      let v = f(f(Math.min(1, Math.max(0, f(f(dark.d[i] - f(0.10)) / f(0.30)))) * band) * f(1 - holeSoft.d[i]));
      v = Math.max(Math.max(v, lashIris.d[i]), lidFront.d[i]);
      lashA.d[i] = v;
    }
    const satB = sat(base);
    const whiteM = img(w, h, 1);
    const clip01 = v => Math.min(1, Math.max(0, v));
    for (let i = 0; i < n; i++) whiteM.d[i] = fd ? f(clip01(1 - (satB.d[i] - 0.3) / 0.25) * f(1 - lashA.d[i])) : f(clip01(f(1 - f(f(satB.d[i] - s3) / s25))) * f(1 - lashA.d[i]));
    const whiteB = K.blur(whiteM, 0.6), white = img(w, h, 1);
    for (let i = 0; i < n; i++) white.d[i] = f(whiteB.d[i] * Math.min(1, Math.max(0, f(sd.d[i] + 0.5))));
    const wsv = [], L45 = 0.45 * refL, L25 = 0.25 * refL;
    for (let i = 0; i < n; i++) {
      const likeB = fd ? clip01((Lb.d[i] - L45) / L25) * clip01(1 - (satB.d[i] - 0.3) / 0.25)
        : f(clip01(f(f(Lb.d[i] - l45) / l25)) * clip01(f(1 - f(f(satB.d[i] - s3) / s25))));
      if (likeB > 0.5 && sd.d[i] > 1) wsv.push(Lb.d[i]);
    }
    const scleraRef = wsv.length >= 5 ? percentile(wsv, 90, fd) : refW;

    // ⑨ 眼珠：极坐标展开 → 补全 → 卷回圆形
    const Rmax = R * 1.12 + 1.0;
    const Nr = Math.ceil(Rmax * 2) + 1;
    const Nt = Math.max(72, Math.ceil(2 * Math.PI * Rmax * 1.5 / 4) * 4);
    const rr = Float32Array.from(linspace(0, Rmax, Nr, true));
    const tt = Float32Array.from(linspace(0, 2 * Math.PI, Nt, false));
    const ct = tt.map(v => f(Math.cos(v))), st = tt.map(v => f(Math.sin(v)));
    const px = new Float32Array(Nr * Nt), py = new Float32Array(Nr * Nt);
    for (let i = 0; i < Nr; i++) for (let t = 0; t < Nt; t++) { px[i * Nt + t] = f(fcx + f(rr[i] * ct[t])); py[i * Nt + t] = f(fcy + f(rr[i] * st[t])); }
    const Praw = sample(K, crop, px, py, Nt, Nr);
    const Sp = sample(K, S, px, py, Nt, Nr);
    const blocked = img(w, h, 1);
    for (let i = 0; i < n; i++) blocked.d[i] = Math.max(catchM[i], lashIris.d[i] > 0.3 ? 1 : 0);
    const sdp = sample(K, sd, px, py, Nt, Nr), blp = sample(K, blocked, px, py, Nt, Nr);
    const visp = new Uint8Array(Nr * Nt);
    let vin = 0, vtot = 0;
    for (let i = 0; i < Nr; i++) for (let t = 0; t < Nt; t++) {
      const k = i * Nt + t;
      visp[k] = (sdp.d[k] > t15g && blp.d[k] < f(0.3)) ? 1 : 0;
      if (rr[i] <= fR) { vin += visp[k]; vtot++; }
    }
    const visFrac = vtot ? vin / vtot : 0;
    if (visFrac < 0.15) notes.push('眼珠露出来太少(' + pyFixed(visFrac * 100, 0) + '%)，补出来的多半不像');
    const cat = { w: Nt, h: Nr, c: 6, d: new Float32Array(Nr * Nt * 6) };
    for (let k = 0; k < Nr * Nt; k++) for (let c = 0; c < 3; c++) {
      cat.d[k * 6 + c] = Praw.d[k * 3 + c];
      cat.d[k * 6 + 3 + c] = Math.min(1, Math.max(0, f(Praw.d[k * 3 + c] / Sp.d[k])));
    }
    const PP = fillPolarRows(K, cat, visp);

    const T = 2 * Math.ceil(Rmax) + 1, tc = (T - 1) / 2.0;
    const PW3a = img(Nt + 1, Nr, 3), PW3b = img(Nt + 1, Nr, 3);
    for (let i = 0; i < Nr; i++) for (let t = 0; t <= Nt; t++) {
      const src = (i * Nt + (t === Nt ? 0 : t)) * 6, dst = (i * (Nt + 1) + t) * 3;
      for (let c = 0; c < 3; c++) { PW3a.d[dst + c] = PP.d[src + c]; PW3b.d[dst + c] = PP.d[src + 3 + c]; }
    }
    const mt = new Float32Array(T * T), mr = new Float32Array(T * T), rt = new Float32Array(T * T);
    const ftc = f(tc), twoPi = f(2 * Math.PI), fRmax = f(Rmax), nr1 = f(Nr - 1), fNt = f(Nt);
    for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) {
      const k = i * T + j, dy = f(i - ftc), dx = f(j - ftc);
      rt[k] = f(Math.hypot(dx, dy));
      let th = f(Math.atan2(dy, dx));
      th = f(((th % twoPi) + twoPi) % twoPi);
      mr[k] = f(f(rt[k] / fRmax) * nr1);
      mt[k] = f(f(th / twoPi) * fNt);
    }
    const texRaw = sample(K, PW3a, mt, mr, T, T), texFlat = sample(K, PW3b, mt, mr, T, T);
    const texA = img(T, T, 1), fsoft = f(soft);
    for (let k = 0; k < T * T; k++) texA.d[k] = Math.min(1, Math.max(0, f(f(f(fR - rt[k]) / fsoft) + 0.5)));

    // ⑩ 眼球几何
    const cor = s.eye.corners;
    const ballMid = [f(f(f(cor[0][0] - s.off[0]) + f(cor[1][0] - s.off[0])) / 2), f(f(f(cor[0][1] - s.off[1]) + f(cor[1][1] - s.off[1])) / 2)];
    const ballR = 0.5 * (1.7 * s.r0 + 0.35 * s.width);

    return {
      side: s.eye.side, crop: s.crop,
      iris: [cx, cy], R, R_landmark: s.r0, pupil, soft,
      texSize: T, ballMid, ballR, eyeWidth: s.width, contrast, arcVisible: arc, irisVisible: visFrac,
      scleraRef: Math.max(0.05, scleraRef),
      poly: polyOut, notes,
      _layers: { orig: crop, base, S, sd, white, lash_a: lashA, catch_a: catchA, tex_raw: texRaw, tex_flat: texFlat, tex_a: texA },
    };
  }
  const t15g = f(1.5), F07 = f(0.7);

  // 自检：眼珠放回原位置叠一遍（eyelib.render_neutral，shift=0、shade_on），返回眼眶里的平均误差 ×255
  function neutralErr(K, L, meta) {
    const base = L.base, h = base.h, w = base.w, n = w * h, T = meta.texSize, tc = (T - 1) / 2.0, dbl = isD(base);
    const cx = meta.iris[0], cy = meta.iris[1];
    const tx = new Float32Array(n), ty = new Float32Array(n);
    const ftx = f(f(tc) - f(cx)), fty = f(f(tc) - f(cy));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; tx[i] = f(f(x - f(cx)) + f(tc)); ty[i] = f(f(y - f(cy)) + f(tc)); }
    void ftx; void fty;
    const col = sample(K, L.tex_flat, tx, ty, w, h);
    const a = sample(K, L.tex_a, tx, ty, w, h, K.cv.INTER_LINEAR, K.cv.BORDER_CONSTANT);
    const ca = L.catch_a;
    let sum = 0, cnt = 0;
    const k12 = f(2 * 0.6);
    for (let i = 0; i < n; i++) {
      const m = Math.min(1, Math.max(0, f(f(L.sd.d[i] / k12) + 0.5)));
      const av = f(a.d[i] * m), la = L.lash_a.d[i], cav = f(ca.d[i] * m);
      let e = 0;
      for (let c = 0; c < 3; c++) {
        const o = L.orig.d[i * 3 + c], cl = f(col.d[i * 3 + c] * L.S.d[i]);
        let v;
        if (dbl) {           // base 是 float64 ⇒ 整串都是 float64（跟 render_neutral 一样）
          v = base.d[i * 3 + c] * f(1 - av) + f(cl * av);
          v = v * f(1 - la) + f(o * la);
          v = v * f(1 - cav) + f(o * cav);
        } else {
          v = f(f(base.d[i * 3 + c] * f(1 - av)) + f(cl * av));
          v = f(f(v * f(1 - la)) + f(o * la));
          v = f(f(v * f(1 - cav)) + f(o * cav));
        }
        e += Math.abs(v - o);
      }
      if (L.sd.d[i] > 0) { sum += e / 3; cnt++; }
    }
    return cnt ? (sum / cnt) * 255 : undefined;
  }

  // ═══════════════════════════════════════════════════════════════
  //  找到的关键点 → 每张脸两只眼（eyelib.detect_faces 后半段）
  //  faces: [[[x,y]…478 个，像素坐标]…]
  // ═══════════════════════════════════════════════════════════════
  function facesFromPoints(facesPts) {
    const faces = [];
    for (const pts0 of facesPts || []) {
      if (!pts0 || pts0.length < 478) continue;   // 没带眼珠点的旧模型
      const pts = pts0.map(p => [f(p[0]), f(p[1])]);
      const eyes = {};
      for (const side of ['R', 'L']) {
        const up = EYE_UPPER[side].map(i => pts[i]), lo = EYE_LOWER[side].map(i => pts[i]);
        eyes[side] = { side, upper: up, lower: lo, corners: [up[0], up[8]] };
      }
      for (const g of IRIS_GROUPS) {
        const c = pts[g[0]];
        let rsum = 0;
        for (const k of g.slice(1)) rsum = f(rsum + norm2(pts[k][0], pts[k][1], c[0], c[1]));
        const r = f(rsum / 4);
        const centre = side => {     // 眼眶 18 个点的平均：numpy 沿第 0 维求和是一个个加（不走 pairwise），float32
          const all = eyes[side].upper.concat(eyes[side].lower);
          let sx = all[0][0], sy = all[0][1];
          for (let q = 1; q < all.length; q++) { sx = f(sx + all[q][0]); sy = f(sy + all[q][1]); }
          return [f(sx / all.length), f(sy / all.length)];
        };
        const cR = centre('R'), cL = centre('L');
        const side = norm2(cR[0], cR[1], c[0], c[1]) <= norm2(cL[0], cL[1], c[0], c[1]) ? 'R' : 'L';
        eyes[side].iris_c = [c[0], c[1]];
        eyes[side].iris_r = r;
      }
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const p of pts) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); }
      faces.push({ eyes: [eyes.R, eyes.L], size: Math.max(f(mxx - mnx), f(mxy - mny)) });
    }
    faces.sort((a, b) => b.size - a.size);
    return faces;
  }

  // eyelib.prepare：处理用的图（BGR uint8）+ 关键点 → { meta, baseFull }
  function prepareCore(K, im8, facesPts, overrides) {
    overrides = overrides || {};
    const faces = facesFromPoints(facesPts);
    if (!faces.length) throw new EyeGazeError('没找到人脸（要正脸或微侧脸、眼睛睁开）');
    const face = faces[0];
    const eyesIn = face.eyes.filter(e => e.iris_c);
    const r0m = eyesIn.reduce((a, e) => a + e.iris_r, 0) / eyesIn.length;
    // 半径搜到 1.7 倍：大号美瞳（s14 实测）比 MediaPipe 按真人眼珠估的大将近一倍
    const rs = linspace(0.8, 1.7, 31, true).map(v => r0m * v);
    const ovs = Object.values(overrides);
    const rCrop = Math.max(r0m, ...ovs.map(v => Number(v[2]) / 1.3));
    const im = { w: im8.w, h: im8.h, c: 3, d: im8.d };
    const stages = eyesIn.map(e => stage1(K, im, e, rCrop, rs));
    const fixedR = ovs.length ? ovs.reduce((a, v) => a + Number(v[2]), 0) / ovs.length : null;
    const circles = chooseCircles(stages, rs, fixedR);
    stages.forEach((s, i) => {
      const ov = overrides[s.eye.side];
      if (ov) {
        circles[i] = { c: [Number(ov[0]) - s.off[0], Number(ov[1]) - s.off[1]], R: Number(ov[2]), contrast: 1.0, arc: 1.0 };
        s.notes0.push('眼珠圈是手动调的');
      }
    });
    const baseFull = { w: im8.w, h: im8.h, c: 3, d: Uint8Array.from(im8.d) };
    const eyes = [];
    stages.forEach((s, i) => {
      const m = stage2(K, s, circles[i]);
      const [x0, y0, w, h] = m.crop, b = m._layers.base.d, c255 = f(255), half = f(0.5), dbl = b instanceof Float64Array;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
        const v = b[(y * w + x) * 3 + c];
        baseFull.d[((y + y0) * im8.w + x + x0) * 3 + c] = Math.min(255, Math.max(0, dbl ? v * 255 + 0.5 : f(f(v * c255) + half))) | 0;
      }
      const e = neutralErr(K, m._layers, m);
      if (e !== undefined) m.neutralErr = e;
      eyes.push(m);
    });
    // 鼻子方向（往里转是哪边）：另一只眼在哪边就是哪边
    if (eyes.length === 2) {
      for (const [a, b] of [[0, 1], [1, 0]]) {
        const ca = eyes[a].crop[0] + eyes[a].iris[0], cb = eyes[b].crop[0] + eyes[b].iris[0];
        eyes[a].nasal = cb > ca ? 1.0 : -1.0;
      }
    }
    return { meta: { w: im8.w, h: im8.h, faces: faces.length, eyes }, baseFull };
  }

  // service.py 的前半段：解码后的图（BGR uint8，原尺寸）→ 处理用的图（长边 ≤2048 缩小；up>1 先放大）
  function workImage(K, bgr8, up) {
    let im = bgr8;
    const h0 = im.h, w0 = im.w, s = 2048.0 / Math.max(h0, w0);
    if (s < 1.0) im = K.resize(im, pyRound(w0 * s), pyRound(h0 * s), K.cv.INTER_AREA);
    up = Number(up) || 1.0;
    if (up > 1.01) {
      const hh = im.h, ww = im.w;
      up = Math.min(up, MAX_UP, WORK_MAX / Math.max(hh, ww));
      if (up > 1.01) im = K.resize(im, pyRound(ww * up), pyRound(hh * up), K.cv.INTER_LANCZOS4);
    }
    return im;
  }

  // service.py 的后半段：出图层（浏览器读 PNG 后的 RGBA 排法，跟引擎回的 PNG 解出来一模一样）
  function u8(v) { return Math.min(255, Math.max(0, f(f(v * f(255)) + f(0.5)))) | 0; }
  function layersOf(m, baseFull, im8) {
    const [x0, y0, cw, ch] = m.crop, L = m._layers, n = cw * ch;
    const rgba = () => new Uint8ClampedArray(n * 4);
    const base = rgba(), orig = rgba(), maps1 = rgba(), maps2 = rgba(), texRaw = rgba(), texFlat = rgba(), texA = rgba();
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x, q = i * 4, g = ((y + y0) * im8.w + x + x0) * 3;
      base[q] = baseFull.d[g + 2]; base[q + 1] = baseFull.d[g + 1]; base[q + 2] = baseFull.d[g]; base[q + 3] = 255;
      orig[q] = im8.d[g + 2]; orig[q + 1] = im8.d[g + 1]; orig[q + 2] = im8.d[g]; orig[q + 3] = 255;
      // ⚠ service.py：cv2 写的是 BGR ⇒ dstack 的第 0 层落在 PNG 的蓝色
      maps1[q] = u8(L.S.d[i]); maps1[q + 1] = Math.min(255, Math.max(0, f(f(128 + f(L.sd.d[i] * f(SDF_SCALE))) + f(0.5)))) | 0; maps1[q + 2] = u8(L.white.d[i]); maps1[q + 3] = 255;
      maps2[q] = u8(L.lash_a.d[i]); maps2[q + 1] = u8(L.catch_a.d[i]); maps2[q + 2] = 0; maps2[q + 3] = 255;
    }
    const T = m.texSize;
    const TT = T * T, tr = new Uint8ClampedArray(TT * 4), tf = new Uint8ClampedArray(TT * 4), ta = new Uint8ClampedArray(TT * 4);
    for (let k = 0; k < TT; k++) {
      const q = k * 4;
      tr[q] = u8(L.tex_raw.d[k * 3 + 2]); tr[q + 1] = u8(L.tex_raw.d[k * 3 + 1]); tr[q + 2] = u8(L.tex_raw.d[k * 3]); tr[q + 3] = 255;
      tf[q] = u8(L.tex_flat.d[k * 3 + 2]); tf[q + 1] = u8(L.tex_flat.d[k * 3 + 1]); tf[q + 2] = u8(L.tex_flat.d[k * 3]); tf[q + 3] = 255;
      const a = u8(L.tex_a.d[k]); ta[q] = a; ta[q + 1] = a; ta[q + 2] = a; ta[q + 3] = 255;
    }
    void texRaw; void texFlat; void texA;
    const lay = (d, w, h) => ({ w, h, data: d });
    return { base: lay(base, cw, ch), orig: lay(orig, cw, ch), maps1: lay(maps1, cw, ch), maps2: lay(maps2, cw, ch),
      tex_raw: lay(tr, T, T), tex_flat: lay(tf, T, T), tex_a: lay(ta, T, T) };
  }

  // 整个准备：处理用的图 + 关键点 → 跟引擎 /eyegaze/prepare 一样的结果（图层是 {w,h,data:RGBA} 而不是 PNG）
  function prepare(cv, work8, facesPts, overrides, info) {
    const K = makeCv(cv);
    const t0 = Date.now();
    cv.setRNGSeed(RNG_SEED);     // ⚠ GrabCut 有随机初始化：定死种子，同一张图每次结果一样（同 service.py）
    const { meta, baseFull } = prepareCore(K, work8, facesPts, overrides);
    const dt = (Date.now() - t0) / 1000;
    const eyes = meta.eyes.map(m => {
      const layers = layersOf(m, baseFull, work8);
      const out = Object.assign({}, m);
      delete out._layers;
      out.layers = layers;
      return out;
    });
    const inW = (info && info.inW) || work8.w, inH = (info && info.inH) || work8.h;
    return { ok: true, w: work8.w, h: work8.h, inW, inH, scale: inW ? work8.w / inW : 1.0,
      faces: meta.faces, seconds: Math.round(dt * 100) / 100, sdfScale: SDF_SCALE, eyes };
  }

  const api = { prepare, workImage, makeCv, facesFromPoints, prepareCore, layersOf, EyeGazeError, pyRound, pyFixed, SDF_SCALE, RNG_SEED,
    // 对照排查用（tools/eyegaze/parity/ 那套逐层跟 Python 比）
    _internal: { catmull, openingSdf, refineOpening, sdfFromMask, stage1, stage2, chooseCircles, median, percentile, pairwiseF32, arange, linspace } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7EyeGazePrep = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null));
