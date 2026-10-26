/* ═══════════════════════════════════════════════════════════════
   眼神调整（眼珠随动）· 实时叠图核心（2026-10-25，docs/290）

   照原型 tools/eyegaze/app.js 的 gazeFor / renderEye 一比一搬过来（算法、常数、限位一个没改），
   只把「读全局 st / S」改成传参数，纯函数、不碰 DOM —— 工具面板（eyegaze-tool.js）和 node 测试都用它。

   引擎（POST /eyegaze/prepare）把每只眼准备成几层，这里每次滑块一动只把两只眼那一小块逐像素重叠一遍：
     底图 → 眼白提亮 → 眼珠(按视线挪 + 压扁 + 明暗 + 瞳孔) → 挡在前面的层(睫毛/眼皮边) → 眼神光
   每只眼 E = { m(引擎给的几何), w, h, B(去眼珠底图), O(原图), M1, M2, TR, TF, TA(贴图), out } —— 都是 RGBA 字节数组
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const DEG = Math.PI / 180;
  const IPD_CM = 6.3;   // 成人两眼间距约 6.3 厘米，只用来把「远近」换算成好懂的厘米数

  const DEFAULTS = Object.freeze({
    mode: 'target', tx: null, ty: null, depth: 780,
    yaw: 0, pitch: 0, conv: 0, amp: 100, size: 100, pupil: 100, white: 30, follow: 40,
    shrink: 0, feather: 0.6, shade: true, camNeutral: true,
  });
  // 解剖限位（10-18 按用户反馈加的）：眼皮不跟着动时，转过 30° 眼珠就像钻到眼皮底下、像假眼 —— 按角度限，不按向量长度
  const GAZE_LIM = Object.freeze({ x: 32, up: 20, down: 18, total: 38 });

  // 多方向预览（12 格对比）
  const GRID = Object.freeze([
    ['原图（没动过）', { orig: true }],
    ['原位置（重建出来的）', { mode: 'none' }],
    ['往画面左边看', { mode: 'manual', yaw: -30, pitch: 0, conv: 0 }],
    ['往画面右边看', { mode: 'manual', yaw: 30, pitch: 0, conv: 0 }],
    ['往上看', { mode: 'manual', yaw: 0, pitch: 20, conv: 0 }],
    ['往下看', { mode: 'manual', yaw: 0, pitch: -20, conv: 0 }],
    ['斗鸡眼', { mode: 'manual', yaw: 0, pitch: 0, conv: 28 }],
    ['两眼往外分', { mode: 'manual', yaw: 0, pitch: 0, conv: -12 }],
    ['左上', { mode: 'manual', yaw: -25, pitch: 15, conv: 0 }],
    ['右下', { mode: 'manual', yaw: 25, pitch: -15, conv: 0 }],
    ['眼珠放大 125%', { mode: 'none', size: 125 }],
    ['瞳孔放大 180%', { mode: 'none', pupil: 180 }],
  ]);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const depthMul = st => 0.3 * Math.pow(100, st.depth / 1000);   // 0.3 ~ 30 倍眼距
  const depthCm = st => Math.round(depthMul(st) * IPD_CM);

  /** 两眼间距（像素）和两眼中点（整图坐标）。一只眼时按眼宽估 */
  function eyePair(eyes) {
    if (eyes.length === 2) {
      const a = eyes[0], b = eyes[1];
      const ax = a.x0 + a.m.iris[0], ay = a.y0 + a.m.iris[1], bx = b.x0 + b.m.iris[0], by = b.y0 + b.m.iris[1];
      return { ipd: Math.hypot(ax - bx, ay - by), mid: [(ax + bx) / 2, (ay + by) / 2] };
    }
    if (eyes.length === 1) return { ipd: eyes[0].m.eyeWidth * 2.1, mid: [eyes[0].x0 + eyes[0].m.iris[0], eyes[0].y0 + eyes[0].m.iris[1]] };
    return { ipd: 0, mid: null };
  }

  // ─── 视线 → 眼珠位置（app.js gazeFor 原样）──────────────────────
  function gazeFor(E, st, ipd) {
    const m = E.m;
    const bx = st.camNeutral ? m.iris[0] : m.ballMid[0];
    const by = st.camNeutral ? m.iris[1] : m.ballMid[1];
    let gx = 0, gy = 0, gz = 1;
    if (st.mode === 'target' && st.tx != null) {
      const vx = st.tx - (E.x0 + bx), vy = st.ty - (E.y0 + by), vz = depthMul(st) * ipd;
      const n = Math.hypot(vx, vy, vz);
      gx = vx / n; gy = vy / n; gz = vz / n;
    } else if (st.mode === 'manual') {
      const yaw = (st.yaw + st.conv * (m.nasal || 0)) * DEG, pit = st.pitch * DEG;
      gx = Math.sin(yaw) * Math.cos(pit); gy = -Math.sin(pit); gz = Math.cos(yaw) * Math.cos(pit);
    }
    const amp = clamp(st.amp / 100, 0.4, 1);
    const yaw = clamp(Math.atan2(gx, gz) / DEG * amp, -GAZE_LIM.x, GAZE_LIM.x);
    const pit = clamp(Math.asin(clamp(gy, -1, 1)) / DEG * amp, -GAZE_LIM.down, GAZE_LIM.up);
    const cy = Math.cos(pit * DEG), sy = Math.sin(pit * DEG);
    gx = Math.sin(yaw * DEG) * cy; gy = sy; gz = Math.cos(yaw * DEG) * cy;
    const tot = Math.acos(clamp(gz, -1, 1)) / DEG;
    if (tot > GAZE_LIM.total) {
      const k = Math.sin(GAZE_LIM.total * DEG) / Math.max(1e-6, Math.hypot(gx, gy));
      gx *= k; gy *= k; gz = Math.cos(GAZE_LIM.total * DEG);
    }
    return { cx: bx + m.ballR * gx, cy: by + m.ballR * gy, gx, gy, gz, yaw, pit };
  }

  // ─── 一只眼逐像素叠图（app.js renderEye 原样，结果写进 E.out）──────────
  function renderEye(E, st, ipd, sdfScale) {
    const m = E.m, w = E.w, h = E.h, R = m.R, T = m.texSize, tc = (T - 1) / 2;
    const g = gazeFor(E, st, ipd);
    const L = Math.hypot(g.gx, g.gy);
    const c = L > 1e-6 ? g.gx / L : 1, s = L > 1e-6 ? g.gy / L : 0;
    const k = 1 / Math.max(0.2, g.gz), inv = 100 / st.size;
    const a00 = (k * c * c + s * s) * inv, a01 = (k - 1) * c * s * inv, a11 = (k * s * s + c * c) * inv;
    const p0 = m.pupil, p1 = clamp(p0 * st.pupil / 100, 0.06, 0.92), doPupil = Math.abs(p1 - p0) > 1e-4;
    const cdx = (g.cx - m.iris[0]) * st.follow / 100, cdy = (g.cy - m.iris[1]) * st.follow / 100;
    const sdfK = 1 / sdfScale, fe = 2 * st.feather, shr = st.shrink, wAmt = st.white / 100;
    const shadeOn = st.shade, rmax = (R * 1.12 + 1) / R, wGain = 1 / m.scleraRef;
    const B = E.B, O = E.O, M1 = E.M1, M2 = E.M2, TA = E.TA, out = E.out;
    const TX = shadeOn ? E.TF : E.TR;
    const gcx = g.cx, gcy = g.cy;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i4 = (y * w + x) * 4;
        let r = B[i4], gg = B[i4 + 1], b = B[i4 + 2];
        let mm = ((M1[i4 + 1] - 128) * sdfK - shr) / fe + 0.5;
        mm = mm < 0 ? 0 : mm > 1 ? 1 : mm;
        const sh = M1[i4] / 255;
        if (mm > 0) {
          const wa = wAmt * (M1[i4 + 2] / 255) * mm;
          if (wa > 0) {
            const t = Math.min(255, (0.299 * r + 0.587 * gg + 0.114 * b) * wGain);
            r += (t - r) * wa; gg += (t - gg) * wa; b += (t - b) * wa;
          }
          let u = a00 * (x - gcx) + a01 * (y - gcy), v = a01 * (x - gcx) + a11 * (y - gcy);
          const rn = Math.sqrt(u * u + v * v) / R;
          if (rn < rmax) {
            if (doPupil && rn < 1 && rn > 1e-6) {
              const rs = rn < p1 ? rn * p0 / p1 : p0 + (rn - p1) * (1 - p0) / (1 - p1);
              u *= rs / rn; v *= rs / rn;
            }
            const fx = u + tc, fy = v + tc, ix = Math.floor(fx), iy = Math.floor(fy);
            if (ix >= 0 && iy >= 0 && ix < T - 1 && iy < T - 1) {
              const ax = fx - ix, ay = fy - iy;
              const j00 = (iy * T + ix) * 4, j10 = j00 + 4, j01 = j00 + T * 4, j11 = j01 + 4;
              const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
              const ta = (TA[j00] * w00 + TA[j10] * w10 + TA[j01] * w01 + TA[j11] * w11) / 255 * mm;
              if (ta > 0) {
                let cr = TX[j00] * w00 + TX[j10] * w10 + TX[j01] * w01 + TX[j11] * w11;
                let cg = TX[j00 + 1] * w00 + TX[j10 + 1] * w10 + TX[j01 + 1] * w01 + TX[j11 + 1] * w11;
                let cb = TX[j00 + 2] * w00 + TX[j10 + 2] * w10 + TX[j01 + 2] * w01 + TX[j11 + 2] * w11;
                if (shadeOn) { cr *= sh; cg *= sh; cb *= sh; }
                r += (cr - r) * ta; gg += (cg - gg) * ta; b += (cb - b) * ta;
              }
            }
          }
        }
        const la = M2[i4] / 255;
        if (la > 0) { r += (O[i4] - r) * la; gg += (O[i4 + 1] - gg) * la; b += (O[i4 + 2] - b) * la; }
        if (mm > 0) {
          const qx = x - cdx, qy = y - cdy, qi = Math.floor(qx), qj = Math.floor(qy);
          if (qi >= 0 && qj >= 0 && qi < w - 1 && qj < h - 1) {
            const ax = qx - qi, ay = qy - qj;
            const j00 = (qj * w + qi) * 4, j10 = j00 + 4, j01 = j00 + w * 4, j11 = j01 + 4;
            const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
            const ca = (M2[j00 + 1] * w00 + M2[j10 + 1] * w10 + M2[j01 + 1] * w01 + M2[j11 + 1] * w11) / 255 * mm;
            if (ca > 0) {
              r += (O[j00] * w00 + O[j10] * w10 + O[j01] * w01 + O[j11] * w11 - r) * ca;
              gg += (O[j00 + 1] * w00 + O[j10 + 1] * w10 + O[j01 + 1] * w01 + O[j11 + 1] * w11 - gg) * ca;
              b += (O[j00 + 2] * w00 + O[j10 + 2] * w10 + O[j01 + 2] * w01 + O[j11 + 2] * w11 - b) * ca;
            }
          }
        }
        // ⚠ out 是 Uint8ClampedArray：赋值时自动夹到 0~255、四舍五入（浏览器 ImageData 同款）
        out[i4] = r; out[i4 + 1] = gg; out[i4 + 2] = b; out[i4 + 3] = 255;
      }
    }
    return g;
  }

  /** 两只眼都叠一遍；返回每只眼的视线角（界面显示用） */
  function renderAll(eyes, st, sdfScale) {
    const { ipd } = eyePair(eyes);
    return eyes.map(E => renderEye(E, st, ipd, sdfScale));
  }

  /** 两只眼裁剪区的外接框（整图坐标）。padK = 往外留多少（按框大小的比例） */
  function eyesRect(eyes, padK) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const E of eyes) { x0 = Math.min(x0, E.x0); y0 = Math.min(y0, E.y0); x1 = Math.max(x1, E.x0 + E.w); y1 = Math.max(y1, E.y0 + E.h); }
    const pw = (x1 - x0) * (padK || 0), ph = (y1 - y0) * (padK || 0);
    return [x0 - pw, y0 - ph, x1 - x0 + 2 * pw, y1 - y0 + 2 * ph];
  }

  /** 「复原误差」：眼珠放回原位（滑块全默认、看镜头）叠一遍和原图比，眼眶内平均差 /255 —— 搬过来没走样的自检数 */
  function neutralErr(E, sdfScale) {
    const st = Object.assign({}, DEFAULTS, { mode: 'none', white: 0, follow: 40, feather: 0.6, shrink: 0 });
    renderEye(E, st, 0, sdfScale);
    let s = 0, n = 0;
    for (let i = 0, p = 0; p < E.w * E.h; p++, i += 4) {
      if (E.M1[i + 1] <= 128) continue;   // 只算眼眶里（距离场 > 0）
      s += (Math.abs(E.out[i] - E.O[i]) + Math.abs(E.out[i + 1] - E.O[i + 1]) + Math.abs(E.out[i + 2] - E.O[i + 2])) / 3; n++;
    }
    return n ? s / n : 0;
  }

  const api = { DEFAULTS, GAZE_LIM, GRID, IPD_CM, clamp, depthMul, depthCm, eyePair, gazeFor, renderEye, renderAll, eyesRect, neutralErr };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7EyeGazeCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
