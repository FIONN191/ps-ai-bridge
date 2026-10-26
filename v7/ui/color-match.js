// ═══ 校色 / 对齐 · 档 1（纯 CPU，无任何依赖）═══════════════
//
// 用途：AI 生成的图贴回 Photoshop 原选区时，把颜色拉回原图的色调、
//       并修掉生成过程带来的轻微位移。
//
// ⚠ 这个文件【不碰 DOM、不碰 canvas】，全是纯函数：
//   进出都是 {data:Uint8ClampedArray(RGBA), width, height}。
//   这样它能在 Node 里直接跑数值测试 —— 校色对不对不能靠肉眼看图，
//   得能算出"色彩距离降了多少"才说得清。
//
// ── 比 V6 强在哪（V6: tiles/tile-colormatch.js）──
//   ① 全局校色  Reinhard(Lab 均值/方差) → MKL(3×3 协方差匹配)
//      Reinhard 把 R/G/B 当成互相独立的三路分别拉齐，可实际上它们高度相关。
//      协方差匹配连"通道之间的关系"一起对齐，能修正偏色方向而不只是亮度。
//   ② 低频提取  3 次 box blur → 引导滤波
//      box blur 在强边缘处会把两侧颜色糊到一起，人物边缘会出现一圈色晕。
//      引导滤波以回图自身为引导，边缘处不跨越，色晕基本消失。
//   ③ 对齐      只解位移 → 位移 + 旋转 + 缩放（仿射，RANSAC 去外点）
//
// ── 从 V6 继承的一个坑（别删）──
//   抗截断会把选区补白成正方形。做低频的时候白边会被算进去，
//   导致整张图校色偏亮/偏灰。所有统计和滤波都必须限定在 crop 内容区里。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.COLORMATCH = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ═══ 基础工具 ═══════════════════════════════════════════════

  // 内容区。没给就是整张图。
  function normCrop(crop, w, h) {
    if (!crop) return { l: 0, t: 0, r: w, b: h };
    const l = Math.max(0, Math.round(crop.left || 0));
    const t = Math.max(0, Math.round(crop.top || 0));
    const r = Math.min(w, Math.round((crop.left || 0) + (crop.width || w)));
    const b = Math.min(h, Math.round((crop.top || 0) + (crop.height || h)));
    if (r <= l || b <= t) return { l: 0, t: 0, r: w, b: h };
    return { l, t, r, b };
  }

  // 取某个通道成 Float32（只取内容区之外也要，但统计只用内容区）
  function channel(data, w, h, ci) {
    const out = new Float32Array(w * h);
    for (let i = 0, p = ci; i < out.length; i++, p += 4) out[i] = data[p];
    return out;
  }

  // ═══ 均值滤波（积分图，O(1) 每像素，与半径无关）═══════════
  // ⚠ 用积分图而不是滑动窗口：引导滤波要跑 6 次均值滤波，
  //   半径又跟图尺寸成正比(4K 时半径上百)，滑动窗口会慢一个量级。
  function boxMean(src, w, h, r) {
    // 积分图多一行一列，省掉边界判断
    const sat = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const a = sat[y0 * (w + 1) + x0];
        const b = sat[y0 * (w + 1) + (x1 + 1)];
        const c = sat[(y1 + 1) * (w + 1) + x0];
        const d = sat[(y1 + 1) * (w + 1) + (x1 + 1)];
        // ⚠ 除以【实际窗口像素数】而不是 (2r+1)^2 ——
        //   边角处窗口被截断，用理论面积会让边缘发暗（V6 也踩过，注释里写着）。
        out[y * w + x] = (d - b - c + a) / ((y1 - y0 + 1) * (x1 - x0 + 1));
      }
    }
    return out;
  }

  // ═══ 引导滤波 ═══════════════════════════════════════════════
  //  q = a·I + b，a/b 在局部窗口里由最小二乘解出：
  //    a = cov(I,p) / (var(I) + eps)
  //    b = mean(p) − a·mean(I)
  //  I 是引导图（这里用回图自己），p 是被滤的图。
  //  边缘处 var(I) 大 → a→1 → 输出跟随引导图的边缘，不跨越边界糊色。
  function guidedFilter(p, I, w, h, r, eps) {
    const meanI = boxMean(I, w, h, r);
    const meanP = boxMean(p, w, h, r);
    const n = w * h;
    const Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const meanIp = boxMean(Ip, w, h, r);
    const meanII = boxMean(II, w, h, r);
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const cov = meanIp[i] - meanI[i] * meanP[i];
      const varI = meanII[i] - meanI[i] * meanI[i];
      a[i] = cov / (varI + eps);
      b[i] = meanP[i] - a[i] * meanI[i];
    }
    const meanA = boxMean(a, w, h, r);
    const meanB = boxMean(b, w, h, r);
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = meanA[i] * I[i] + meanB[i];
    return q;
  }

  // ═══ 3×3 对称矩阵的特征分解（Jacobi 旋转）═══════════════════
  // MKL 需要矩阵的平方根和逆平方根，对称矩阵靠特征分解最稳。
  // 3×3 规模下 Jacobi 十来次扫描就收敛，比通用 SVD 简单得多。
  function eigenSym3(M) {
    const a = [M[0].slice(), M[1].slice(), M[2].slice()];
    let V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 24; sweep++) {
      let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-12) break;
      for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: V };
  }

  function mat3mul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
    return C;
  }
  function mat3T(A) { return [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]]; }
  // 对称矩阵的幂（p=0.5 求平方根，p=-0.5 求逆平方根）
  function symPow(M, p) {
    const e = eigenSym3(M);
    const D = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      // ⚠ 特征值可能因浮点误差出现极小负数 → 夹到正数，否则 pow 出 NaN，
      //   整张图会变成一片黑（这种错最难查，因为它只在特定图片上出现）。
      const v = Math.max(e.values[i], 1e-8);
      D[i][i] = Math.pow(v, p);
    }
    return mat3mul(mat3mul(e.vectors, D), mat3T(e.vectors));
  }

  // ═══ 统计：内容区内的均值和协方差 ═══════════════════════════
  function stats(data, w, h, crop) {
    const c = normCrop(crop, w, h);
    let n = 0;
    const mean = [0, 0, 0];
    for (let y = c.t; y < c.b; y++) {
      for (let x = c.l; x < c.r; x++) {
        const p = (y * w + x) * 4;
        mean[0] += data[p]; mean[1] += data[p + 1]; mean[2] += data[p + 2];
        n++;
      }
    }
    if (!n) return null;
    mean[0] /= n; mean[1] /= n; mean[2] /= n;
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let y = c.t; y < c.b; y++) {
      for (let x = c.l; x < c.r; x++) {
        const p = (y * w + x) * 4;
        const d0 = data[p] - mean[0], d1 = data[p + 1] - mean[1], d2 = data[p + 2] - mean[2];
        cov[0][0] += d0 * d0; cov[0][1] += d0 * d1; cov[0][2] += d0 * d2;
        cov[1][1] += d1 * d1; cov[1][2] += d1 * d2; cov[2][2] += d2 * d2;
      }
    }
    const inv = 1 / Math.max(1, n - 1);
    cov[0][0] *= inv; cov[0][1] *= inv; cov[0][2] *= inv;
    cov[1][1] *= inv; cov[1][2] *= inv; cov[2][2] *= inv;
    cov[1][0] = cov[0][1]; cov[2][0] = cov[0][2]; cov[2][1] = cov[1][2];
    // 加一点点对角项，防止纯色图(协方差全 0)导致矩阵不可逆
    for (let i = 0; i < 3; i++) cov[i][i] += 1e-6;
    return { mean, cov, n };
  }

  // ═══ 整体校色 · MKL 线性色彩迁移 ═══════════════════════════
  //  求一个线性变换 T，把 src 的 RGB 分布(均值+协方差)整体搬到 ref 的分布上。
  //  T = Σs^(-1/2) · ( Σs^(1/2) Σr Σs^(1/2) )^(1/2) · Σs^(-1/2)
  //  这是"把一个高斯分布搬成另一个高斯分布"的最优线性解(Monge-Kantorovich)。
  //
  //  ⚠ 和 Reinhard 的区别：Reinhard 只按通道各自拉齐均值和标准差，
  //    等于假设 R/G/B 互不相关；真实照片里它们强相关，所以 Reinhard
  //    修得了"整体偏亮"，修不了"偏青/偏品"这种带方向的色偏。
  //
  //  amount: 0~1，迁移强度。1=完全对齐到参考图，0.7 左右通常更自然。
  function transferMKL(src, ref, opts) {
    opts = opts || {};
    const amount = opts.amount == null ? 1 : Math.max(0, Math.min(1, opts.amount));
    const w = src.width, h = src.height;
    const s = stats(src.data, w, h, opts.crop);
    const r = stats(ref.data, ref.width, ref.height, opts.refCrop || opts.crop);
    if (!s || !r) return src;

    const Ss12 = symPow(s.cov, 0.5);
    const Ssm12 = symPow(s.cov, -0.5);
    const mid = symPow(mat3mul(mat3mul(Ss12, r.cov), Ss12), 0.5);
    let T = mat3mul(mat3mul(Ssm12, mid), Ssm12);

    // 强度插值：T' = (1-a)·I + a·T，均值同理。
    if (amount < 1) {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        T[i][j] = (i === j ? (1 - amount) : 0) + amount * T[i][j];
      }
    }
    const out = new Uint8ClampedArray(src.data);
    const mr = [
      s.mean[0] + (r.mean[0] - s.mean[0]) * amount,
      s.mean[1] + (r.mean[1] - s.mean[1]) * amount,
      s.mean[2] + (r.mean[2] - s.mean[2]) * amount
    ];
    for (let i = 0; i < out.length; i += 4) {
      const d0 = src.data[i] - s.mean[0], d1 = src.data[i + 1] - s.mean[1], d2 = src.data[i + 2] - s.mean[2];
      out[i] = T[0][0] * d0 + T[0][1] * d1 + T[0][2] * d2 + mr[0];
      out[i + 1] = T[1][0] * d0 + T[1][1] * d1 + T[1][2] * d2 + mr[1];
      out[i + 2] = T[2][0] * d0 + T[2][1] * d1 + T[2][2] * d2 + mr[2];
    }
    return { data: out, width: w, height: h };
  }

  // ═══ 精准校色 · 低频替换（引导滤波版）═════════════════════
  //  结果 = 回图 − lowpass(回图) + lowpass(原图)
  //  也就是：保留回图的细节(高频)，换上原图的颜色(低频)。
  //
  //  ⚠ V6 用 3 次 box blur 取低频，强边缘两侧的颜色会互相糊进去，
  //    人物轮廓会出现一圈色晕。这里改用引导滤波，以【回图自身】为引导：
  //    边缘处 a→1，输出跟着边缘走，不跨越边界混色。
  //
  //  ⚠ 白边隔离(继承 V6)：抗截断把图补白成正方形时，白边会污染低频统计。
  //    这里的做法比 V6 更直接 —— 先把内容区外的像素替换成内容区均值再滤波。
  function transferLowFreq(src, ref, opts) {
    opts = opts || {};
    const amount = opts.amount == null ? 1 : Math.max(0, Math.min(1, opts.amount));
    const w = src.width, h = src.height;
    const c = normCrop(opts.crop, w, h);
    // 半径跟图尺寸走：太小换不动颜色，太大等于全局均值
    const r = opts.radius || Math.max(4, Math.round(Math.min(c.r - c.l, c.b - c.t) / 16));
    const eps = opts.eps == null ? 1e-4 * 255 * 255 : opts.eps;

    const out = new Uint8ClampedArray(src.data);
    // 引导图用回图的灰度（三个通道共用一个引导，边缘位置才一致；
    // 各通道各用各的引导会让 RGB 边缘错开，出现彩边）
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * src.data[p] + 0.587 * src.data[p + 1] + 0.114 * src.data[p + 2];
    }
    fillOutsideWithMean(gray, w, h, c);

    for (let ci = 0; ci < 3; ci++) {
      const sCh = channel(src.data, w, h, ci);
      const rCh = channel(ref.data, ref.width, ref.height, ci);
      fillOutsideWithMean(sCh, w, h, c);
      fillOutsideWithMean(rCh, w, h, c);
      const sLow = guidedFilter(sCh, gray, w, h, r, eps);
      const rLow = guidedFilter(rCh, gray, w, h, r, eps);
      for (let i = 0, p = ci; i < sCh.length; i++, p += 4) {
        const shifted = sCh[i] - sLow[i] + rLow[i];
        out[p] = sCh[i] + (shifted - sCh[i]) * amount;
      }
    }
    return { data: out, width: w, height: h };
  }

  // 把内容区外的像素置成内容区均值。
  // ⚠ 这是从 V6 学来的：不做的话，补白的白边会被 blur 窗口吸进去，
  //   靠近边缘的区域低频被拉高 → 校色结果整体发灰/发亮。
  function fillOutsideWithMean(buf, w, h, c) {
    if (c.l === 0 && c.t === 0 && c.r === w && c.b === h) return;
    let sum = 0, n = 0;
    for (let y = c.t; y < c.b; y++) for (let x = c.l; x < c.r; x++) { sum += buf[y * w + x]; n++; }
    const m = n ? sum / n : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y < c.t || y >= c.b || x < c.l || x >= c.r) buf[y * w + x] = m;
      }
    }
  }

  // ═══ 降采样 / 上采样（性能的关键）═════════════════════════
  //  ⚠ 为什么必须有这一层（2026-09-11 实测账）：
  //    2048×2048 全分辨率做一次精准校色要 710ms，一批 18 张就是 12.8 秒，
  //    4K 更是接近一分钟 —— 而且卡在主线程上，界面直接僵住。
  //
  //  利用的性质：**低频本来就是平滑的**。
  //    在缩小的图上算出"该加多少颜色"，再把这张【差异图】放大贴回原图，
  //    结果和全分辨率算几乎一样，因为差异图本身就没有高频内容。
  //    细节全部来自原图，一个像素都没动过。
  function downsampleRGB(img, maxEdge) {
    const w = img.width, h = img.height;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    if (scale >= 1) return { img, scale: 1 };
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const out = new Uint8ClampedArray(nw * nh * 4);
    // 盒式平均降采样。⚠ 不能用最近邻：那会把噪声当成信号采进来，
    //   低频统计被单个像素带偏。
    const bx = w / nw, by = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * by), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * by)));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * bx), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * bx)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const p = (yy * w + xx) * 4;
            r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++;
          }
        }
        const q = (y * nw + x) * 4;
        out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = 255;
      }
    }
    return { img: { data: out, width: nw, height: nh }, scale };
  }

  // 把小图上的【差异】双线性放大到原尺寸。差异图是平滑的，双线性足够。
  function upsampleDelta(delta, sw, sh, w, h) {
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, (y + 0.5) * sh / h - 0.5);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, (x + 0.5) * sw / w - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        const i00 = (y0 * sw + x0) * 3, i01 = (y0 * sw + x1) * 3;
        const i10 = (y1 * sw + x0) * 3, i11 = (y1 * sw + x1) * 3;
        const o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          const top = delta[i00 + c] * (1 - wx) + delta[i01 + c] * wx;
          const bot = delta[i10 + c] * (1 - wx) + delta[i11 + c] * wx;
          out[o + c] = top * (1 - wy) + bot * wy;
        }
      }
    }
    return out;
  }

  // ═══ 精准校色 · 快速版（默认走这个）═══════════════════════
  //  在小图上算颜色差异 → 放大 → 加回原图。
  //  ⚠ 细节完全来自原图：这个函数【只加一层平滑的颜色偏移】，
  //    不碰任何高频，所以不会让画面变糊 —— 这一点是它敢用降采样的根据。
  function transferLowFreqFast(src, ref, opts) {
    opts = opts || {};
    const maxEdge = opts.workEdge || 512;
    const amount = opts.amount == null ? 1 : Math.max(0, Math.min(1, opts.amount));
    const w = src.width, h = src.height;
    if (Math.max(w, h) <= maxEdge) return transferLowFreq(src, ref, opts);

    const ds = downsampleRGB(src, maxEdge);
    const dr = downsampleRGB(ref, maxEdge);
    const sw = ds.img.width, sh = ds.img.height;
    // 参考图缩到和源一样大小才能逐像素比
    const refSmall = (dr.img.width === sw && dr.img.height === sh)
      ? dr.img : resampleTo(dr.img, sw, sh);
    // crop 也要跟着缩
    const cropSmall = opts.crop ? {
      left: opts.crop.left * sw / w, top: opts.crop.top * sh / h,
      width: opts.crop.width * sw / w, height: opts.crop.height * sh / h
    } : null;
    const matched = transferLowFreq(ds.img, refSmall, Object.assign({}, opts, { crop: cropSmall, amount: 1 }));
    // 小图上的差异
    const delta = new Float32Array(sw * sh * 3);
    for (let i = 0, p = 0; i < sw * sh; i++, p += 4) {
      delta[i * 3] = matched.data[p] - ds.img.data[p];
      delta[i * 3 + 1] = matched.data[p + 1] - ds.img.data[p + 1];
      delta[i * 3 + 2] = matched.data[p + 2] - ds.img.data[p + 2];
    }
    const big = upsampleDelta(delta, sw, sh, w, h);
    const out = new Uint8ClampedArray(src.data);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      out[p] = src.data[p] + big[i * 3] * amount;
      out[p + 1] = src.data[p + 1] + big[i * 3 + 1] * amount;
      out[p + 2] = src.data[p + 2] + big[i * 3 + 2] * amount;
    }
    return { data: out, width: w, height: h };
  }

  // 双线性缩放到指定尺寸（参考图和源图尺寸不一致时用）
  function resampleTo(img, nw, nh) {
    const w = img.width, h = img.height;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const fy = Math.min(h - 1, (y + 0.5) * h / nh - 0.5);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < nw; x++) {
        const fx = Math.min(w - 1, (x + 0.5) * w / nw - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
        const q = (y * nw + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = img.data[(y0 * w + x0) * 4 + c] * (1 - wx) + img.data[(y0 * w + x1) * 4 + c] * wx;
          const bot = img.data[(y1 * w + x0) * 4 + c] * (1 - wx) + img.data[(y1 * w + x1) * 4 + c] * wx;
          out[q + c] = top * (1 - wy) + bot * wy;
        }
        out[q + 3] = 255;
      }
    }
    return { data: out, width: nw, height: nh };
  }

  // ═══ 对齐 ═══════════════════════════════════════════════════
  //  AI 生成的图和原图内容大体一致，但常有几像素到几十像素的位移/缩放。
  //  不修的话贴回 Photoshop 会跟原选区错位。
  //
  //  ⚠⚠ 最重要的一条：**没把握就不要动**（用户 2026-09-11 定案）。
  //    校色算错顶多颜色不对；**对齐算错会把整张图扭变形**，比不对齐糟得多。
  //    AI 有时候会大改构图，那种情况根本不存在"正确的对齐"。
  //    所以这里算出置信度，低于阈值就返回 null，调用方原样用回图。
  //
  //  做法：灰度降采样 → 网格取块 → 每块用 NCC 找匹配 → RANSAC 拟合平移+缩放
  //  ⚠ 只解【平移 + 各向同性缩放】三个参数，不解旋转和错切：
  //    参数越多越容易过拟合到噪声上，而 AI 生成图基本不会整体旋转。
  //    宁可修不全，也不要修坏。

  function toGray(img, maxEdge) {
    const d = downsampleRGB(img, maxEdge);
    const w = d.img.width, h = d.img.height;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.299 * d.img.data[p] + 0.587 * d.img.data[p + 1] + 0.114 * d.img.data[p + 2];
    }
    return { g, w, h, scale: d.scale };
  }

  // 归一化互相关：对整体亮度/对比度变化免疫。
  // ⚠ 不能用 SSD —— 校色前两张图亮度本来就差一截，SSD 会被亮度差带跑。
  function ncc(A, aw, ax, ay, B, bw, bh, bx, by, ps) {
    let sa = 0, sb = 0, n = 0;
    for (let j = 0; j < ps; j++) {
      const yA = ay + j, yB = by + j;
      if (yB < 0 || yB >= bh) return -1;
      for (let i = 0; i < ps; i++) {
        const xB = bx + i;
        if (xB < 0 || xB >= bw) return -1;
        sa += A[yA * aw + ax + i]; sb += B[yB * bw + xB]; n++;
      }
    }
    if (!n) return -1;
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let j = 0; j < ps; j++) {
      for (let i = 0; i < ps; i++) {
        const va = A[(ay + j) * aw + ax + i] - ma;
        const vb = B[(by + j) * bw + bx + i] - mb;
        num += va * vb; da += va * va; db += vb * vb;
      }
    }
    if (da < 1e-6 || db < 1e-6) return -1;   // 纯色块，没有可匹配的结构
    return num / Math.sqrt(da * db);
  }

  //  返回 {dx,dy,scale,confidence,inliers,total}（像素单位，对应【原始尺寸】）
  //
  //  ⚠⚠ dx/dy 的语义是【要把 src 搬回去，得移动多少】，
  //     不是"src 偏了多少" —— 两者符号正好相反，很容易看反。
  //     例：src 的内容比 ref 右移了 10px，这里返回的 dx 是 -10（往左搬 10 才对得上）。
  //     它和 applyAlign 是配对使用的，只要成对用就永远不会错；
  //     但如果你拿这个数去做别的事（比如显示"偏移了多少"），记得取反。
  //     2026-09-11 写测试时我自己先看反了一次。
  //
  //  confidence 低于 minConfidence 时返回带 rejected:true 的对象（或 null）。
  function estimateAlign(src, ref, opts) {
    opts = opts || {};
    const workEdge = opts.workEdge || 256;
    const minConf = opts.minConfidence == null ? 0.55 : opts.minConfidence;
    const S = toGray(src, workEdge), R = toGray(ref, workEdge);
    if (S.w < 24 || S.h < 24) return null;         // 太小，匹配没意义
    // 参考图缩到和源同尺寸
    let Rg = R.g, rw = R.w, rh = R.h;
    if (rw !== S.w || rh !== S.h) {
      const rs = resampleTo(ref, S.w, S.h);
      Rg = new Float32Array(S.w * S.h);
      for (let i = 0, p = 0; i < Rg.length; i++, p += 4) {
        Rg[i] = 0.299 * rs.data[p] + 0.587 * rs.data[p + 1] + 0.114 * rs.data[p + 2];
      }
      rw = S.w; rh = S.h;
    }
    const ps = Math.max(12, Math.round(Math.min(S.w, S.h) / 10));   // 块大小
    const search = Math.max(6, Math.round(Math.min(S.w, S.h) / 12)); // 搜索半径
    const grid = 7;
    const pts = [];
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const ax = Math.round((S.w - ps) * (gx + 0.5) / grid);
        const ay = Math.round((S.h - ps) * (gy + 0.5) / grid);
        if (ax < 0 || ay < 0) continue;
        let best = -1, bdx = 0, bdy = 0;
        for (let dy = -search; dy <= search; dy++) {
          for (let dx = -search; dx <= search; dx++) {
            const v = ncc(S.g, S.w, ax, ay, Rg, rw, rh, ax + dx, ay + dy, ps);
            if (v > best) { best = v; bdx = dx; bdy = dy; }
          }
        }
        // 相关性太低 = 这块没找到可信的对应，丢掉
        if (best > 0.5) pts.push({ x: ax + ps / 2, y: ay + ps / 2, dx: bdx, dy: bdy, w: best });
      }
    }
    if (pts.length < 6) return null;

    // ── RANSAC 拟合「平移 + 缩放」──
    // 模型: x' = s·(x−cx) + cx + tx, y' 同理
    const cx = S.w / 2, cy = S.h / 2;
    let bestModel = null, bestCount = 0;
    const tol = Math.max(1.5, search * 0.35);
    for (let iter = 0; iter < 120; iter++) {
      const a = pts[(iter * 7 + 1) % pts.length], b = pts[(iter * 13 + 5) % pts.length];
      const dax = a.x - cx, day = a.y - cy, dbx = b.x - cx, dby = b.y - cy;
      const den = (dax - dbx) * (dax - dbx) + (day - dby) * (day - dby);
      if (den < 4) continue;
      // 两点解出缩放和平移
      const s = 1 + (((a.dx - b.dx) * (dax - dbx) + (a.dy - b.dy) * (day - dby)) / den);
      if (!isFinite(s) || s < 0.8 || s > 1.25) continue;    // 缩放超出合理范围 → 这组点不可信
      const tx = a.dx - (s - 1) * dax, ty = a.dy - (s - 1) * day;
      let count = 0, wsum = 0;
      for (const p of pts) {
        const px = (s - 1) * (p.x - cx) + tx, py = (s - 1) * (p.y - cy) + ty;
        if (Math.abs(px - p.dx) <= tol && Math.abs(py - p.dy) <= tol) { count++; wsum += p.w; }
      }
      if (count > bestCount) { bestCount = count; bestModel = { s, tx, ty, wsum }; }
    }
    if (!bestModel || bestCount < 6) return null;

    // 置信度 = 内点占比 × 内点平均相关性。两者都高才算可信。
    const inlierRatio = bestCount / pts.length;
    const avgNcc = bestModel.wsum / bestCount;
    const confidence = inlierRatio * avgNcc;
    const inv = 1 / S.scale;   // 换算回原始像素
    const out = {
      dx: bestModel.tx * inv, dy: bestModel.ty * inv, scale: bestModel.s,
      confidence, inliers: bestCount, total: pts.length, inlierRatio, avgNcc
    };
    if (confidence < minConf) { out.rejected = true; return out; }
    return out;
  }

  // 按估计出来的变换把图搬正（双线性采样）
  function applyAlign(img, tf) {
    const w = img.width, h = img.height;
    const out = new Uint8ClampedArray(img.data.length);
    const cx = w / 2, cy = h / 2, s = tf.scale || 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 反向映射：目标像素 ← 源位置
        const sx = (x - cx - tf.dx) / s + cx;
        const sy = (y - cy - tf.dy) / s + cy;
        const q = (y * w + x) * 4;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) {
          // 超出原图范围 → 用边缘像素填，不要留黑边
          const ex = Math.min(w - 1, Math.max(0, Math.round(sx)));
          const ey = Math.min(h - 1, Math.max(0, Math.round(sy)));
          const p = (ey * w + ex) * 4;
          out[q] = img.data[p]; out[q + 1] = img.data[p + 1]; out[q + 2] = img.data[p + 2]; out[q + 3] = 255;
          continue;
        }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        for (let c = 0; c < 3; c++) {
          const top = img.data[(y0 * w + x0) * 4 + c] * (1 - fx) + img.data[(y0 * w + x1) * 4 + c] * fx;
          const bot = img.data[(y1 * w + x0) * 4 + c] * (1 - fx) + img.data[(y1 * w + x1) * 4 + c] * fx;
          out[q + c] = top * (1 - fy) + bot * fy;
        }
        out[q + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  // ═══ 网格变形对齐（2026-09-29 从加速引擎 engine/match_server.py 的 mesh_warp 搬进来）═══
  //  ⭐ 用户要求：默认的「网格对齐 + 颜色匹配」不再依赖 Python 引擎，装完软件就能用。
  //  ⚠ 算法、参数、判据和引擎【逐条一致】（引擎那边的注释记着 09-12 实测修过的坑，这里原样照做）：
  //    ① 10×10 个控制点，网格点铺满整张图（0 … w-1），边缘的块 clamp 回图内取；
  //    ② 每格在「短边 2%」范围里用零均值归一化相关（= OpenCV TM_CCOEFF_NORMED）找最像的位置 ——
  //       不用 SSD：校色前两张图亮度本来就不同，SSD 会被亮度差带跑；
  //    ③ 模板标准差 < 3 的格子太平、不参与；相关度 > 0.4 才算可信；可信格不到 1/4 → 整个放弃，不硬扭；
  //    ④ 不可信的格子填可信格的中位数，再 3×3 中值 + 3×3 高斯（[.25 .5 .25]）抹平。
  //       低自由度本身就是安全阀：扭不动「瘦脸 / 放大眼睛」这种局部有意修改 ——
  //       这正是引擎 09-12 把默认从稠密光流换成它的原因；
  //    ⑤ 位移场按 OpenCV resize(INTER_LINEAR) 的像素中心约定放大到整图；反向取样时【减】位移：
  //       匹配算的是 src→ref，取样要 ref→src。写成加号会往反方向搬、偏差差不多翻倍（引擎 09-12 实测 2.27→4.44px）。
  //  和引擎唯一的不同：为了在软件里跑得动，匹配改成「小图粗找 → 逐级放大、每级 ±2px 细找」，
  //    最细一级短边不超过 1536，再用抛物线插值到亚像素；引擎是整图一次找、整数像素。
  //    所以平坦判据（③的标准差）照引擎在【原图】上算，相关度取最细一级的。
  const MESH_GRID = 10, MESH_MAX_SHIFT = 0.02, MESH_FINE_EDGE = 1536;

  // 原图 RGBA → 按 k×k 块平均的灰度（k = 1 就是原分辨率灰度）。大图不先转整张灰度，省内存。
  function grayBlock(img, k) {
    const w = img.width, h = img.height, d = img.data;
    const nw = Math.max(1, Math.floor(w / k)), nh = Math.max(1, Math.floor(h / k));
    const out = new Float32Array(nw * nh), inv = 1 / (k * k);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let s = 0;
        for (let j = 0; j < k; j++) {
          let p = ((y * k + j) * w + x * k) * 4;
          for (let i = 0; i < k; i++, p += 4) s += 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        }
        out[y * nw + x] = s * inv;
      }
    }
    return { g: out, w: nw, h: nh };
  }
  function halveGray(L) {
    const w = L.w, h = L.h, nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Float32Array(nw * nh), g = L.g;
    for (let y = 0; y < nh; y++) {
      const r0 = 2 * y * w, r1 = Math.min(h - 1, 2 * y + 1) * w;
      for (let x = 0; x < nw; x++) {
        const x0 = 2 * x, x1 = Math.min(w - 1, 2 * x + 1);
        out[y * nw + x] = (g[r0 + x0] + g[r0 + x1] + g[r1 + x0] + g[r1 + x1]) * 0.25;
      }
    }
    return { g: out, w: nw, h: nh };
  }
  // 原图上一块的灰度标准差（引擎的平坦判据 tpl.std() < 3 就在原图上算）
  function patchStd(img, x0, y0, p) {
    const w = img.width, d = img.data;
    let s = 0, s2 = 0;
    for (let y = y0; y < y0 + p; y++) {
      let q = (y * w + x0) * 4;
      for (let x = 0; x < p; x++, q += 4) {
        const v = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
        s += v; s2 += v * v;
      }
    }
    const n = p * p, m = s / n;
    return Math.sqrt(Math.max(0, s2 / n - m * m));
  }
  // 零均值归一化相关：模板 T（已减均值，tss = ΣT²）对 R 里左上角 (bx,by) 的同尺寸窗口
  function nccAt(T, tss, p, R, rw, bx, by) {
    let s = 0, s2 = 0, st = 0;
    for (let j = 0; j < p; j++) {
      const row = (by + j) * rw + bx, trow = j * p;
      for (let i = 0; i < p; i++) {
        const v = R[row + i];
        s += v; s2 += v * v; st += T[trow + i] * v;
      }
    }
    const n = p * p, vr = s2 - s * s / n;
    if (vr < 1e-6 || tss < 1e-6) return -1;
    return st / Math.sqrt(tss * vr);          // ΣT'·I' = ΣT'·I（T' 的和为 0）
  }
  function templateOf(S, sw, x0, y0, p) {
    const T = new Float32Array(p * p);
    let s = 0;
    for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) { const v = S[(y0 + j) * sw + x0 + i]; T[j * p + i] = v; s += v; }
    const m = s / (p * p);
    let tss = 0;
    for (let q = 0; q < T.length; q++) { T[q] -= m; tss += T[q] * T[q]; }
    return { T, tss };
  }
  function median(values) {
    const a = values.slice().sort((x, y) => x - y), n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  // cv2.medianBlur(3)：边界 REPLICATE
  function medianBlur3(v, n) {
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const k = [];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const yy = Math.min(n - 1, Math.max(0, y + j)), xx = Math.min(n - 1, Math.max(0, x + i));
        k.push(v[yy * n + xx]);
      }
      k.sort((a, b) => a - b); out[y * n + x] = k[4];
    }
    return out;
  }
  // cv2.GaussianBlur((3,3), 0)：OpenCV 对 ksize 3 用固定核 [.25 .5 .25]；边界 REFLECT_101
  function gauss3(v, n) {
    const reflect = i => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
    const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      tmp[y * n + x] = .25 * v[y * n + reflect(x - 1)] + .5 * v[y * n + x] + .25 * v[y * n + reflect(x + 1)];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      out[y * n + x] = .25 * tmp[reflect(y - 1) * n + x] + .5 * tmp[y * n + x] + .25 * tmp[reflect(y + 1) * n + x];
    return out;
  }
  // cv2.resize(INTER_LINEAR) 一个方向的取样表：输出第 x 个像素 ← 网格的 (i0, i1, a)
  function resizeTable(n, size) {
    const i0 = new Int32Array(size), i1 = new Int32Array(size), a = new Float32Array(size);
    for (let x = 0; x < size; x++) {
      let f = (x + 0.5) * (n / size) - 0.5, s = Math.floor(f);
      f -= s;
      if (s < 0) { s = 0; f = 0; }
      if (s >= n - 1) { s = n - 1; f = 0; }
      i0[x] = s; i1[x] = Math.min(n - 1, s + 1); a[x] = f;
    }
    return { i0, i1, a };
  }

  //  src 往 ref 上对齐。返回 {img, applied, note, grid}：applied=false 时 img 就是原来的 src（没动）。
  function meshWarp(src, ref, opts) {
    opts = opts || {};
    const grid = opts.grid || MESH_GRID, w = src.width, h = src.height;
    if (ref.width !== w || ref.height !== h) ref = resampleTo(ref, w, h);
    if (Math.min(w, h) < 32) return { img: src, applied: false, note: '网格变形：图太小，跳过' };
    const patch = Math.max(16, Math.floor(Math.min(w, h) / (grid * 1.2)));
    const search = Math.max(4, Math.floor(Math.min(w, h) * MESH_MAX_SHIFT));
    // 金字塔：F = 最细的匹配层（短边 ≤ 1536），C = 最粗层（那一层的搜索半径 ≤ 6 像素，块不小于 12）
    let F = 0;
    while (Math.min(w, h) / (1 << F) > MESH_FINE_EDGE) F++;
    let C = F;
    while (search / (1 << (C + 1)) >= 1 && search / (1 << C) > 6 && patch / (1 << (C + 1)) >= 12) C++;
    const src0 = grayBlock(src, 1 << F), ref0 = grayBlock(ref, 1 << F);
    const S = [src0], R = [ref0];
    for (let L = F + 1; L <= C; L++) { S.push(halveGray(S[S.length - 1])); R.push(halveGray(R[R.length - 1])); }
    // 引擎的网格点：np.linspace(0, w-1, grid).astype(int)（截断取整）
    const gx = [], gy = [];
    for (let i = 0; i < grid; i++) { gx.push(Math.trunc(i * (w - 1) / (grid - 1))); gy.push(Math.trunc(i * (h - 1) / (grid - 1))); }
    const dx = new Float32Array(grid * grid), dy = new Float32Array(grid * grid), conf = new Float32Array(grid * grid);
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const cell = j * grid + i;
        const y0 = Math.max(0, Math.min(h - patch, gy[j] - Math.floor(patch / 2)));
        const x0 = Math.max(0, Math.min(w - patch, gx[i] - Math.floor(patch / 2)));
        if (patchStd(src, x0, y0, patch) < 3.0) continue;            // 这块太平，没有可匹配的结构
        // 引擎的搜索窗：[x0-search, x0+patch+search] ∩ 图内。窗口不比块大就跳过
        const sx0 = Math.max(0, x0 - search), sx1 = Math.min(w, x0 + patch + search);
        const sy0 = Math.max(0, y0 - search), sy1 = Math.min(h, y0 + patch + search);
        if (sx1 - sx0 <= patch || sy1 - sy0 <= patch) continue;
        const lo = { x: sx0 - x0, y: sy0 - y0 }, hi = { x: sx1 - patch - x0, y: sy1 - patch - y0 };   // 允许的位移范围（原图像素）
        let ux = 0, uy = 0, best = -1, around = null;
        for (let L = C; L >= F; L--) {
          const k = 1 << L, Ls = S[L - F], Lr = R[L - F];
          const p = Math.max(4, Math.round(patch / k));
          const px = Math.min(Ls.w - p, Math.max(0, Math.round(x0 / k))), py = Math.min(Ls.h - p, Math.max(0, Math.round(y0 / k)));
          if (px < 0 || py < 0) { best = -1; break; }
          const t = templateOf(Ls.g, Ls.w, px, py, p);
          // 这一层允许的位移（原图范围按比例缩小）；最粗层全范围找，往下每层在上一层 ×2 的附近 ±2 找
          const minX = Math.ceil(lo.x / k), maxX = Math.floor(hi.x / k), minY = Math.ceil(lo.y / k), maxY = Math.floor(hi.y / k);
          const cx = L === C ? 0 : ux * 2, cy = L === C ? 0 : uy * 2, r = L === C ? Math.ceil(search / k) : 2;
          best = -1; around = new Map();
          for (let v = Math.max(minY, cy - r); v <= Math.min(maxY, cy + r); v++) {
            for (let u = Math.max(minX, cx - r); u <= Math.min(maxX, cx + r); u++) {
              if (px + u < 0 || py + v < 0 || px + u + p > Lr.w || py + v + p > Lr.h) continue;
              const val = nccAt(t.T, t.tss, p, Lr.g, Lr.w, px + u, py + v);
              around.set(u + ',' + v, val);
              if (val > best) { best = val; ux = u; uy = v; }
            }
          }
          if (best <= -1) break;
        }
        if (best <= -1) continue;
        // 最细一级抛物线插值到亚像素（邻居没算过就不插）
        const sub = (a, b, c) => { const den = a - 2 * b + c; return den < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0; };
        const at = (u, v) => around.get(u + ',' + v);
        let ox = 0, oy = 0;
        if (at(ux - 1, uy) != null && at(ux + 1, uy) != null) ox = sub(at(ux - 1, uy), best, at(ux + 1, uy));
        if (at(ux, uy - 1) != null && at(ux, uy + 1) != null) oy = sub(at(ux, uy - 1), best, at(ux, uy + 1));
        const kF = 1 << F;
        dx[cell] = Math.max(lo.x, Math.min(hi.x, (ux + ox) * kF));
        dy[cell] = Math.max(lo.y, Math.min(hi.y, (uy + oy) * kF));
        conf[cell] = best;
      }
    }
    const good = [];
    for (let q = 0; q < conf.length; q++) if (conf[q] > 0.4) good.push(q);
    if (good.length < grid * grid * 0.25) {
      return { img: src, applied: false, note: '网格变形：可匹配的格子太少(' + good.length + '/' + grid * grid + ')，跳过', grid: { dx, dy, conf } };
    }
    // 不可信的格子填中位数 → 3×3 中值 → 3×3 高斯（单个错配的格子不然会在图上拧出一个涡旋）
    const mdx = median(good.map(q => dx[q])), mdy = median(good.map(q => dy[q]));
    for (let q = 0; q < conf.length; q++) if (!(conf[q] > 0.4)) { dx[q] = mdx; dy[q] = mdy; }
    const fdx = gauss3(medianBlur3(dx, grid), grid), fdy = gauss3(medianBlur3(dy, grid), grid);
    // 放大到整图 + 反向取样（减号！见上面 ⑤）+ 边缘复制
    const tx = resizeTable(grid, w), ty = resizeTable(grid, h);
    const out = new Uint8ClampedArray(w * h * 4), d = src.data;
    const rowDx = new Float32Array(grid), rowDy = new Float32Array(grid);
    for (let y = 0; y < h; y++) {
      const j0 = ty.i0[y], j1 = ty.i1[y], b = ty.a[y];
      for (let i = 0; i < grid; i++) {
        rowDx[i] = fdx[j0 * grid + i] * (1 - b) + fdx[j1 * grid + i] * b;
        rowDy[i] = fdy[j0 * grid + i] * (1 - b) + fdy[j1 * grid + i] * b;
      }
      for (let x = 0; x < w; x++) {
        const a = tx.a[x], sxv = x - (rowDx[tx.i0[x]] * (1 - a) + rowDx[tx.i1[x]] * a);
        const syv = y - (rowDy[tx.i0[x]] * (1 - a) + rowDy[tx.i1[x]] * a);
        const fx0 = Math.floor(sxv), fy0 = Math.floor(syv), ax = sxv - fx0, ay = syv - fy0;
        const xa = fx0 < 0 ? 0 : fx0 > w - 1 ? w - 1 : fx0, xb = fx0 + 1 < 0 ? 0 : fx0 + 1 > w - 1 ? w - 1 : fx0 + 1;
        const ya = fy0 < 0 ? 0 : fy0 > h - 1 ? h - 1 : fy0, yb = fy0 + 1 < 0 ? 0 : fy0 + 1 > h - 1 ? h - 1 : fy0 + 1;
        const p00 = (ya * w + xa) * 4, p01 = (ya * w + xb) * 4, p10 = (yb * w + xa) * 4, p11 = (yb * w + xb) * 4, q = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          const top = d[p00 + c] * (1 - ax) + d[p01 + c] * ax, bot = d[p10 + c] * (1 - ax) + d[p11 + c] * ax;
          out[q + c] = top * (1 - ay) + bot * ay;
        }
      }
    }
    let sum = 0, max = 0;
    for (const q of good) { const m = Math.hypot(fdx[q], fdy[q]); sum += m; if (m > max) max = m; }
    return {
      img: { data: out, width: w, height: h }, applied: true,
      note: '网格变形 ' + grid + '×' + grid + ' · 平均 ' + (sum / good.length).toFixed(2) + 'px / 最大 ' + max.toFixed(2) + 'px · 可用格 ' + good.length + '/' + grid * grid,
      grid: { dx: fdx, dy: fdy, conf }
    };
  }

  // ═══ 混合判据校色（档 1 / 纯 JS 版）════════════════════════════
  //
  // ⚠⚠ 2026-10-05：引擎侧主链路已改成【混合判据】（engine/match_server.py 的
  //   color_hybrid）。档 1 必须跟着改成同一套 —— 否则"装不装加速引擎"出来的
  //   颜色不一样，那是本项目最难查的一类不一致（同一张图两个结果，用户不知道信哪个）。
  //
  //   三块，与引擎逐条对应（改这边的时候那边一起改）：
  //     ①颜色判据  两边【都先低频化】再比色差。逐像素比比的是纹理噪点，
  //                不是"这块地方整体什么颜色"，结果会是满屏碎斑。
  //     ②结构判据  按【细节能量】的差异判"这里的内容是不是被 AI 换掉了"。
  //     ③两个相乘  结构判据挡住"内容真的变了"，颜色判据挡住"颜色本来就该差这么多"。
  //                （docs/融合方案-B01：颜色差异本身不能作为拒绝锚点的唯一依据，
  //                  因为颜色变化正是待校正的内容。）
  //
  //   ⚠ 与引擎的两点【已知差异】，不假装一样：
  //     · 没有稠密光流：原图靠 meshWarp 搬（低自由度）。搬得没那么准，
  //       但也不会把 AI 的有意修改扭掉 —— 这本来就是档 1 的取舍。
  //     · 判据在【降采样后】算（理由同 transferLowFreqFast：判据图本身平滑，
  //       小图算完放大结果几乎一样，而快得多）。
  //   ⚠ 代价：比原来的 transferLowFreqFast 约慢一倍（判据要多次滤波）。
  //     档 1 用户本来就没引擎，这是换取"两档结果一致"的必要代价。

  // 灰度。⚠ 三通道共用一组系数（和引擎一致）——
  //   各通道各算各的会让 RGB 边缘错开，判据图上浮出彩边。
  function grayOf(img) {
    const n = img.width * img.height, g = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      g[i] = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
    }
    return g;
  }
  function subArr(a, b) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; }
  function mulArr(a, b) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i]; return o; }
  function sqArr(a) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * a[i]; return o; }
  function sqrtClamp(a, lo) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.sqrt(Math.max(lo, a[i])); return o; }

  // OpenCV 的 ksize → sigma 换算（cv2.GaussianBlur(x, (ks,ks), 0) 内部就是这么算的）。
  // ⚠ 必须照抄：引擎那边用的是 cv2.GaussianBlur，模糊半径必须一致，
  //   否则两个判据的尺度不同，两档结果又对不上了。
  function sigmaOfKsize(ks) { return 0.3 * ((ks - 1) * 0.5 - 1) + 0.8; }
  function smoothBySigma(src, w, h, sigma) {
    if (!(sigma > 0.3)) return src;
    // 三次盒式模糊近似高斯（积分图，O(1) 每像素）。判据只是权重图，形状对就够。
    let cur = src;
    const r = Math.max(1, Math.round(sigma));
    for (let i = 0; i < 3; i++) cur = boxMean(cur, w, h, r);
    return cur;
  }
  function blurByKsize(src, w, h, ks) {
    const k = ks % 2 ? ks : ks + 1;
    const inner = Math.max(1, (k - 1) / 2);
    const r = Math.max(1, Math.round(inner));
    let cur = src;
    for (let i = 0; i < 3; i++) cur = boxMean(cur, w, h, r);
    return cur;
  }
  // 分位数。⚠ 全量排序在 4K 上是上千万个数，抽样到两万以内够用（判据本来就平滑）
  function percentileOf(arr, p) {
    const step = Math.max(1, Math.floor(arr.length / 20000));
    const v = [];
    for (let i = 0; i < arr.length; i += step) v.push(arr[i]);
    if (!v.length) return 0;
    v.sort((a, b) => a - b);
    const idx = Math.round((v.length - 1) * p);
    return v[idx < 0 ? 0 : (idx >= v.length ? v.length - 1 : idx)];
  }
  // 单通道双线性放大（3 通道的用 upsampleDelta）
  function upsample1(src, sw, sh, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, (y + 0.5) * sh / h - 0.5);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, (x + 0.5) * sw / w - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        const top = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx;
        const bot = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx;
        out[y * w + x] = top * (1 - wy) + bot * wy;
      }
    }
    return out;
  }

  function colorHybridFast(src, ref, opts) {
    opts = opts || {};
    const notes = [];
    const w = src.width, h = src.height;
    const workEdge = opts.workEdge || 512;

    const dsS = downsampleRGB(src, workEdge);
    const dsR = downsampleRGB(ref, workEdge);
    const S = dsS.img, sw = S.width, sh = S.height;
    const R = (dsR.img.width === sw && dsR.img.height === sh) ? dsR.img : resampleTo(dsR.img, sw, sh);

    // ── 低频层：①用它比色差，③用它算校正量 ──────────────────
    // ⚠ 半径/eps 与引擎逐字一致（r = min(w,h)/16、eps = 1e-4·255²）。
    const r = Math.max(4, Math.round(Math.min(sw, sh) / 16));
    const eps = 1e-4 * 255 * 255;
    const gS = grayOf(S), gR = grayOf(R);
    const sLow = [], rLow = [];
    for (let c = 0; c < 3; c++) {
      sLow.push(guidedFilter(channel(S.data, sw, sh, c), gS, sw, sh, r, eps));
      rLow.push(guidedFilter(channel(R.data, sw, sh, c), gR, sw, sh, r, eps));
    }

    // ── ① 颜色判据 ─────────────────────────────────────────
    const THRESH = 28.0;
    const gateC0 = new Float32Array(sw * sh);
    const diffMed = new Float32Array(sw * sh);   // 只为日志用（低频色差的中位）
    for (let i = 0; i < gateC0.length; i++) {
      const diff = (Math.abs(sLow[0][i] - rLow[0][i]) + Math.abs(sLow[1][i] - rLow[1][i])
                  + Math.abs(sLow[2][i] - rLow[2][i])) / 3;
      diffMed[i] = diff;
      const v = 1 - (diff - THRESH * 0.4) / (THRESH * 0.6);
      gateC0[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    const gateC = smoothBySigma(gateC0, sw, sh, sigmaOfKsize(Math.round(Math.max(6, Math.min(sw, sh) / 90)) * 2 + 1));

    // ── ② 结构判据 ─────────────────────────────────────────
    // 原图先搬到 AI 图的位置上（档 1 只有网格变形可用）
    const warped = meshWarp(R, S, {});
    const Rw = warped.img;
    const gRw = grayOf(Rw);
    // 抠细节层：DoG。半径自动值 = min(w,h)/200（与引擎 detail_prepare 一致）
    const ksDog = Math.max(2, Math.round(Math.min(sw, sh) / 200)) * 2 + 1;
    const hiAI = subArr(gS, blurByKsize(gS, sw, sh, ksDog));
    const hiOR = subArr(gRw, blurByKsize(gRw, sw, sh, ksDog));
    // 局部细节强度（RMS）
    const ksE = Math.max(5, (Math.floor(Math.min(sw, sh) / 40)) | 1);
    const Eo = sqrtClamp(blurByKsize(sqArr(hiOR), sw, sh, ksE), 0);
    const Ea = sqrtClamp(blurByKsize(sqArr(hiAI), sw, sh, ksE), 0);
    const tot = new Float32Array(Eo.length);
    for (let i = 0; i < tot.length; i++) tot[i] = Eo[i] + Ea[i];
    const floorE = percentileOf(tot, 0.5) * 0.12 + 1e-3;
    const gateE0 = new Float32Array(tot.length);
    for (let i = 0; i < tot.length; i++) {
      const mm = Math.abs(Eo[i] - Ea[i]) / (tot[i] + floorE);
      gateE0[i] = 1 - (mm > 1 ? 1 : mm);
    }
    // 两边都有东西时再看"是不是同一个东西" —— 拿局部相关性收紧。
    // ⚠ 两边都空的地方（纯色区）不受这条影响，否则纯色区会被判成"内容变了"。
    const ksC = Math.max(5, (Math.floor(Math.min(sw, sh) / 64)) | 1);
    const muA = blurByKsize(gS, sw, sh, ksC), muW = blurByKsize(gRw, sw, sh, ksC);
    const va = subArr(blurByKsize(sqArr(gS), sw, sh, ksC), mulArr(muA, muA));
    const vw = subArr(blurByKsize(sqArr(gRw), sw, sh, ksC), mulArr(muW, muW));
    const cov = subArr(blurByKsize(mulArr(gS, gRw), sw, sh, ksC), mulArr(muA, muW));
    const CONF_FLOOR = 0.25;
    const tC = new Float32Array(tot.length);
    for (let i = 0; i < tot.length; i++) {
      const ncc = cov[i] / Math.sqrt(Math.max(va[i], 1e-6) * Math.max(vw[i], 1e-6));
      const tt = (ncc - CONF_FLOOR) / (1 - CONF_FLOOR);
      tC[i] = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
    }
    const conf = blurByKsize(tC, sw, sh, ksC);
    const bothThresh = percentileOf(tot, 0.7) * 0.25;
    const gateE1 = new Float32Array(tot.length);
    for (let i = 0; i < tot.length; i++) {
      const both = Math.min(Eo[i], Ea[i]) > bothThresh ? 1 : 0;
      const struct = conf[i] * both + (1 - both);
      const v = gateE0[i] * struct;
      gateE1[i] = v;
    }
    const gateE = smoothBySigma(gateE1, sw, sh, sigmaOfKsize(Math.round(Math.max(6, Math.min(sw, sh) / 90)) * 2 + 1));

    // ── ③ 相乘 ─────────────────────────────────────────────
    const gate = mulArr(gateC, gateE);

    // ── 算校正量，放大回原尺寸，加到图上 ────────────────────
    const delta = new Float32Array(sw * sh * 3);
    for (let i = 0; i < sw * sh; i++) {
      delta[i * 3] = gate[i] * (rLow[0][i] - sLow[0][i]);
      delta[i * 3 + 1] = gate[i] * (rLow[1][i] - sLow[1][i]);
      delta[i * 3 + 2] = gate[i] * (rLow[2][i] - sLow[2][i]);
    }
    const big = upsampleDelta(delta, sw, sh, w, h);
    const out = new Uint8ClampedArray(src.data);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      out[p] = src.data[p] + big[i * 3];
      out[p + 1] = src.data[p + 1] + big[i * 3 + 1];
      out[p + 2] = src.data[p + 2] + big[i * 3 + 2];
    }

    // ── 与引擎同口径的日志（用户排查"校没校、校了多少"靠它）────
    let changed = 0, gsum = 0;
    for (let i = 0; i < gate.length; i++) { gsum += gate[i]; if (gate[i] < 0.35) changed++; }
    let eSum = 0, eChanged = 0;
    for (let i = 0; i < gateE.length; i++) { eSum += gateE[i]; if (gateE[i] < 0.35) eChanged++; }
    notes.push('①颜色判据 · 低频色差中位 ' + percentileOf(diffMed, 0.5).toFixed(1)
      + ' · 判\'差得多\'占 ' + ((1 - (gateC.reduce((a, b) => a + b, 0) / gateC.length)) * 100).toFixed(1) + '%');
    notes.push('②结构判据 · 判\'内容变了\'占 ' + (eChanged / gateE.length * 100).toFixed(1)
      + '% · 阀均值 ' + (eSum / gateE.length).toFixed(2));
    notes.push('③混合判据 · 判\'内容变了\'占 ' + (changed / gate.length * 100).toFixed(1)
      + '% · 阀均值 ' + (gsum / gate.length).toFixed(2));
    return { img: { data: out, width: w, height: h }, notes };
  }

  // ═══ 档 1 完整流程（后台线程 match-worker.js 和主线程 match-engine.js 共用这一份）═══
  //  ⚠ 以前两边各写一份，后台线程那份漏了「长宽比保护」（2026-09-29 查到）：
  //    参考图被非等比拉伸时，按位置的对齐和精准校色都会把颜色 / 形状搬错地方。
  //  opts: {align, alignMode:'mesh'|'flow'|'off', color, method:'lowfreq'|'mkl', aspectOff, detailBoost}
  function runTier1(src, ref, opts) {
    opts = opts || {};
    const notes = [];
    let cur = src;
    if (ref.width !== src.width || ref.height !== src.height) ref = resampleTo(ref, src.width, src.height);
    const aspectOff = Number(opts.aspectOff) || 1, geoTrust = aspectOff <= 1.03;
    if (!geoTrust) notes.push('长宽比差 ' + Math.round((aspectOff - 1) * 100) + '% · 跳过对齐 · 校色也跳过（见下面）');
    const mode = opts.alignMode || 'mesh';
    if (geoTrust && opts.align !== false && mode !== 'off') {
      // 稠密光流（逐像素位移）要加速引擎；本机用最接近的网格变形代替，并如实写一行（不做假开关，铁律 16）
      if (mode === 'flow') notes.push('稠密光流要加速引擎，本机用网格变形代替');
      const r = meshWarp(cur, ref);
      cur = r.img; notes.push(r.note);
    }
    // ⭐⭐⭐ 2026-10-08（docs/170 §10.1 H1）：档 1 也产底版。
    //   【底版 = 对齐后、校色前的那一刻】—— 和引擎 match_server.py:1541 同一个位置。
    //   ⚠ 为什么以前没有：底版原来全挂在引擎档上（docs/143 §十三-4）。
    //     但"没装引擎"和"没显卡"是两种人：装机自带引擎、只是没 N 卡的人，
    //     校色这一侧走得到引擎，滚轮/切版本那一侧也应该能用。
    //   ⚠ opts.wantBase：不传就不产（多一份 4K 数据要占内存，别默认付这个代价）。
    //   ⚠ 与引擎档的【已知差异】：档 1 的 meshWarp 是低自由度版，
    //     所以这里产出的底版和引擎档的不完全一样。这不是 bug，是两档的固有差别。
    let base = null;
    if (opts.wantBase !== false) {
      // ⚠ 必须 copy：下面 cur 会被校色换成新对象，但万一将来改成就地改，
      //   底版就被校色污染了 —— 而且是静默的（用户以为能切回原样）。
      base = { data: new Uint8ClampedArray(cur.data), width: cur.width, height: cur.height };
    }
    if (opts.color !== false) {
      // ⭐⭐⭐ 2026-10-08（docs/170 §4.2 / §4.6）：档 1 也按【校色方式】走三种。
      //   ⚠ 改之前这里写死 colorHybridFast —— 设置里选了全局/精准，档 1 用户跑的
      //     还是混合，正是铁律 16 那类「能存不生效的开关」。
      //   ⚠ 铁律：档 1 和引擎档必须【同一套规则】，否则"同一张图两个结果"，
      //     那是本项目最难查的一类问题。
      //
      //   三种对应关系（和引擎 match_server.py 的 /process 分发逐字一致）：
      //     'global'  → transferMKL         （全局：整张图按颜色统计配平，不看位置）
      //     'precise' → transferLowFreqFast （精准：按位置搬原图的大块颜色）
      //     'hybrid'  → colorHybridFast     （混合：精准 + 两道阀门）
      let method = String(opts.method || 'hybrid').toLowerCase();
      if (method !== 'global' && method !== 'precise' && method !== 'hybrid') {
        notes.push('认不出校色方式「' + method + '」，按混合判据算');
        method = 'hybrid';
      }
      // ⭐ 比例不符时【自动改用全局】（拍板点 4-B）：
      //   全局不看位置、对拉伸免疫（docs/33 §10.3 那张对照表）；
      //   §10.4 的原做法就是「精准校色自动降级成整体校色」。
      //   不这么做的话，设置里选了全局、比例一对不上就什么都不校了，跟拍板相反。
      let skipped = false;
      if (!geoTrust) {
        if (method === 'global') {
          notes.push('比例对不上，已改用整体校色（它不看位置，对拉伸免疫）');
        } else {
          // 精准/混合都是按位置算的，参考图被拉伸就没有可信位置 ⇒ 跳过，不硬搬。
          //   （"用没法判断内容有没有变的方法硬搬颜色"正是鬼影的来源。）
          notes.push('跳过校色 · 长宽比差 ' + Math.round((aspectOff - 1) * 100) + '%，参考图已被拉伸，位置对不上');
          skipped = true;
        }
      }
      if (!skipped) {
        const before = colorDistance(cur, ref);
        // ⚠⚠ 三种的返回【形状不同】，必须先归一（别假设它们一样）：
        //   · transferMKL        → { data, width, height }   （裸 ImageData，没有 notes）
        //   · transferLowFreqFast→ { data, width, height }   （同上）
        //   · colorHybridFast    → { img, notes }
        //   前两个是「已停用·仅实验台」的，当年没统一成 {img, notes}。
        //   我第一版按同一种读法用了 ⇒ 直接炸在 reading 'width' 上。
        let img = null, extra = [];
        if (method === 'global') {
          img = transferMKL(cur, ref, {});
        } else if (method === 'precise') {
          img = transferLowFreqFast(cur, ref, {});
        } else {
          const hy = colorHybridFast(cur, ref, {});
          img = hy.img; extra = hy.notes || [];
        }
        // 归一：裸 ImageData 直接用；{img} 形状取 .img
        cur = (img && img.img) ? img.img : img;
        for (let i = 0; i < extra.length; i++) notes.push(extra[i]);
        notes.push('校色(' + (method === 'global' ? '整体' : method === 'precise' ? '精准' : '混合判据')
                 + ') 色差 ' + before.toFixed(1) + '→' + colorDistance(cur, ref).toFixed(1));
      }
    }
    // 档 1 没有细节补偿（引擎独有），开着就如实说一句（铁律 16 / 17）
    if (opts.detailBoost === true) notes.push('跳过细节补偿 · 本机算法(档1)没有这个能力，要启动加速引擎');
    // ⭐ 2026-10-08：把底版一起交出去（H1 要它穿过 6 层才能落盘）
    return { img: cur, notes, base: base };
  }

  // ═══ 质量度量（给测试和日志用）═════════════════════════════
  //  两张图在内容区内的平均通道差。校色效果好不好不能靠感觉，
  //  要能报出"色差从 X 降到 Y"。
  function colorDistance(a, b, crop) {
    const w = a.width, h = a.height;
    const c = normCrop(crop, w, h);
    let sum = 0, n = 0;
    for (let y = c.t; y < c.b; y++) {
      for (let x = c.l; x < c.r; x++) {
        const p = (y * w + x) * 4;
        sum += Math.abs(a.data[p] - b.data[p])
             + Math.abs(a.data[p + 1] - b.data[p + 1])
             + Math.abs(a.data[p + 2] - b.data[p + 2]);
        n += 3;
      }
    }
    return n ? sum / n : 0;
  }

  return {
    // ⚠⚠ 2026-10-05：主链路（runTier1 的自动校色）走 colorHybridFast —— 混合判据。
    //   下面 transferMKL / transferLowFreq / transferLowFreqFast 【已不在主链路】，
    //   留着是给测试做对照基准线（tests/color-match-mesh.test.js 要它们证明
    //   "旧算法确实会出问题"，删掉就失去了对照）。
    colorHybridFast,
    transferMKL,
    transferLowFreq,
    transferLowFreqFast,
    colorDistance,
    estimateAlign, applyAlign,
    meshWarp, runTier1,
    downsampleRGB, resampleTo,
    // 下面这些导出来是为了能单独测：算法出问题时要能定位到是哪一层
    _internal: { boxMean, guidedFilter, eigenSym3, symPow, stats, normCrop,
                 grayOf, blurByKsize, percentileOf, colorHybridFast }
  };
});
