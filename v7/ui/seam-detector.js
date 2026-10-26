/* Finished-image review aid. Returns straight-boundary candidates, not defect verdicts. */
(function (root) {
  "use strict";

  function blurSmall(src, width, height) {
    const n = width * height;
    const tmp = new Float32Array(n * 3);
    const k = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        for (let d = -2; d <= 2; d++) {
          const j = (y * width + Math.max(0, Math.min(width - 1, x + d))) * 3;
          const weight = k[d + 2];
          tmp[i] += src[j] * weight;
          tmp[i + 1] += src[j + 1] * weight;
          tmp[i + 2] += src[j + 2] * weight;
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        let r = 0, g = 0, b = 0;
        for (let d = -2; d <= 2; d++) {
          const j = (Math.max(0, Math.min(height - 1, y + d)) * width + x) * 3;
          const weight = k[d + 2];
          r += tmp[j] * weight;
          g += tmp[j + 1] * weight;
          b += tmp[j + 2] * weight;
        }
        src[i] = r; src[i + 1] = g; src[i + 2] = b;
      }
    }
    return src;
  }

  function directionalResidual(smooth, sourceWidth, sourceHeight, axis) {
    const vertical = axis === "vertical";
    const across = vertical ? sourceWidth - 3 : sourceHeight - 3;
    const along = vertical ? sourceHeight : sourceWidth;
    const raw = new Float32Array(along * across * 3);
    const result = new Float32Array(raw.length);
    for (let t = 0; t < along; t++) {
      for (let c = 0; c < across; c++) {
        const i = (t * across + c) * 3;
        const a = vertical ? (t * sourceWidth + c) * 3 : (c * sourceWidth + t) * 3;
        const b = vertical ? a + 9 : a + sourceWidth * 9;
        raw[i] = smooth[b] - smooth[a];
        raw[i + 1] = smooth[b + 1] - smooth[a + 1];
        raw[i + 2] = smooth[b + 2] - smooth[a + 2];
      }
    }
    // A 41-pixel box approximates the broad across-boundary Gaussian baseline.
    const radius = 20;
    for (let t = 0; t < along; t++) {
      let r = 0, g = 0, b = 0;
      const row = t * across * 3;
      for (let c = 0; c < across; c++) {
        if (c === 0) {
          for (let q = 0; q <= radius && q < across; q++) {
            const j = row + q * 3;
            r += raw[j]; g += raw[j + 1]; b += raw[j + 2];
          }
        } else {
          if (c + radius < across) {
            const j = row + (c + radius) * 3;
            r += raw[j]; g += raw[j + 1]; b += raw[j + 2];
          }
          if (c > radius) {
            const h = row + (c - radius - 1) * 3;
            r -= raw[h]; g -= raw[h + 1]; b -= raw[h + 2];
          }
        }
        const count = Math.min(across - 1, c + radius) - Math.max(0, c - radius) + 1;
        const i = row + c * 3;
        result[i] = raw[i] - r / count;
        result[i + 1] = raw[i + 1] - g / count;
        result[i + 2] = raw[i + 2] - b / count;
      }
    }
    return { values: result, across, along };
  }

  function candidatesForProfile(residual, axis, profile, originalWidth, originalHeight, scale, topCount) {
    const { values, across, along } = residual;
    const sizeRatio = Math.min(originalWidth, originalHeight) / 3899;
    const lengths = (profile === "strong" ? [900, 1600] : [2200, 3000])
      .map(length => Math.round(length * sizeRatio));
    const bestScore = new Float32Array(across);
    const bestCenter = new Int32Array(across);
    const bestLength = new Int32Array(across);
    for (const originalLength of lengths) {
      const length = Math.max(32, Math.round(originalLength * scale));
      if (length >= along) continue;
      const stride = Math.max(8, Math.floor(length / 12));
      const sum = new Float64Array(across * 3);
      let start = 0;
      let end = 0;
      const gain = Math.sqrt(originalLength / lengths[0]) / length;
      for (let center = Math.floor(length / 2); center < along - Math.floor(length / 2); center += stride) {
        const targetStart = center - Math.floor(length / 2);
        const targetEnd = targetStart + length;
        while (end < targetEnd) {
          const offset = end * across * 3;
          for (let i = 0; i < sum.length; i++) sum[i] += values[offset + i];
          end++;
        }
        while (start < targetStart) {
          const offset = start * across * 3;
          for (let i = 0; i < sum.length; i++) sum[i] -= values[offset + i];
          start++;
        }
        for (let c = 0; c < across; c++) {
          const i = c * 3;
          const score = Math.hypot(sum[i], sum[i + 1], sum[i + 2]) * gain;
          if (score > bestScore[c]) {
            bestScore[c] = score;
            bestCenter[c] = center;
            bestLength[c] = length;
          }
        }
      }
    }
    const sorted = Array.from({ length: across }, (_, c) => c).sort((a, b) => bestScore[b] - bestScore[a]);
    const chosen = [];
    const minimumGap = Math.max(2, 48 * scale);
    for (const c of sorted) {
      if (bestScore[c] < 2) break;
      if (chosen.some(item => Math.abs(item.scanPosition - c) < minimumGap)) continue;
      const lineAt = (c + 1.5) / scale;
      const begin = Math.max(0, (bestCenter[c] - Math.floor(bestLength[c] / 2)) / scale);
      const end = Math.min(along / scale, (bestCenter[c] + Math.floor(bestLength[c] / 2)) / scale);
      chosen.push({
        profile, axis, rank: chosen.length + 1,
        score: Math.round(bestScore[c] * 100) / 100,
        scanPosition: c,
        x0: Math.round(axis === "vertical" ? lineAt : begin),
        y0: Math.round(axis === "vertical" ? begin : lineAt),
        x1: Math.round(axis === "vertical" ? lineAt : end),
        y1: Math.round(axis === "vertical" ? end : lineAt)
      });
      if (chosen.length >= topCount) break;
    }
    return chosen;
  }

  function fineEdgeEvidence(candidate, imageData, originalWidth, originalHeight) {
    const { width, height, data } = imageData;
    const vertical = candidate.axis === "vertical";
    const across = vertical ? width : height;
    const along = vertical ? height : width;
    const originalAlong = vertical ? originalHeight : originalWidth;
    const first = Math.max(0, Math.floor((vertical ? candidate.y0 : candidate.x0) * along / originalAlong));
    const last = Math.min(along, Math.ceil((vertical ? candidate.y1 : candidate.x1) * along / originalAlong));
    const count = last - first;
    let best = null;
    // The broad detector's three-pixel step places the actual one-pixel jump
    // near its center. Evaluate fixed pixel columns, never following an edge.
    for (let p = Math.max(1, candidate.scanPosition - 1); p <= Math.min(across - 2, candidate.scanPosition + 4); p++) {
      let r = 0, g = 0, b = 0;
      let ar = 0, ag = 0, ab = 0;
      for (let t = first; t < last; t++) {
        const i = (vertical ? t * width + p : p * width + t) * 4;
        const j = i + (vertical ? 4 : width * 4);
        const dr = data[j] - data[i];
        const dg = data[j + 1] - data[i + 1];
        const db = data[j + 2] - data[i + 2];
        r += dr; g += dg; b += db;
        ar += Math.abs(dr); ag += Math.abs(dg); ab += Math.abs(db);
      }
      const strength = Math.hypot(r, g, b) / count;
      const coherence = Math.hypot(r, g, b) / Math.max(1, Math.hypot(ar, ag, ab));
      if (!best || strength > best.strength) best = { position: p, strength, coherence };
    }
    if (!best || count < 32) return null;
    let fixedColumnBlocks = 0;
    let blocks = 0;
    const blockSize = 32;
    for (let block = first; block + blockSize <= last; block += blockSize) {
      let bestBlockPosition = -1;
      let bestBlockStrength = -1;
      for (let p = Math.max(1, candidate.scanPosition - 1); p <= Math.min(across - 2, candidate.scanPosition + 4); p++) {
        let r = 0, g = 0, b = 0;
        for (let t = block; t < block + blockSize; t++) {
          const i = (vertical ? t * width + p : p * width + t) * 4;
          const j = i + (vertical ? 4 : width * 4);
          r += data[j] - data[i];
          g += data[j + 1] - data[i + 1];
          b += data[j + 2] - data[i + 2];
        }
        const strength = Math.hypot(r, g, b);
        if (strength > bestBlockStrength) {
          bestBlockStrength = strength;
          bestBlockPosition = p;
        }
      }
      if (bestBlockPosition === best.position) fixedColumnBlocks++;
      blocks++;
    }
    best.persistence = fixedColumnBlocks / Math.max(1, blocks);
    return best;
  }

  function refineCandidates(candidates, imageData, originalWidth, originalHeight, topCount) {
    const groups = new Map();
    for (const candidate of candidates) {
      const evidence = fineEdgeEvidence(candidate, imageData, originalWidth, originalHeight);
      if (!evidence) continue;
      // A pasted rectangular boundary repeatedly changes color at exactly one
      // image column. Natural lines tend to wander, so their signed jumps cancel.
      const minimumCoherence = candidate.profile === "strong" ? 0.60 : 0.55;
      const minimumStrength = candidate.profile === "strong" ? 2.5 : 1.25;
      if (evidence.coherence < minimumCoherence || evidence.strength < minimumStrength ||
          evidence.persistence < 0.5) continue;
      const scanScale = candidate.axis === "vertical" ? imageData.width / originalWidth : imageData.height / originalHeight;
      const position = Math.round((evidence.position + 0.5) / scanScale);
      const originalAcross = candidate.axis === "vertical" ? originalWidth : originalHeight;
      if (position < 8 || position > originalAcross - 8) continue;
      if (candidate.axis === "vertical") candidate.x0 = candidate.x1 = position;
      else candidate.y0 = candidate.y1 = position;
      candidate.score = Math.round(evidence.strength * evidence.coherence * evidence.coherence *
        evidence.persistence * 100) / 100;
      candidate.coherence = Math.round(evidence.coherence * 100) / 100;
      candidate.persistence = Math.round(evidence.persistence * 100) / 100;
      candidate.scanPixelPitch = Math.round(1 / scanScale * 10) / 10;
      const key = `${candidate.axis}:${candidate.profile}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    }
    const refined = [];
    for (const group of groups.values()) {
      group.sort((a, b) => b.score - a.score);
      for (const candidate of group.slice(0, topCount)) {
        candidate.rank = refined.filter(item => item.axis === candidate.axis && item.profile === candidate.profile).length + 1;
        refined.push(candidate);
      }
    }
    return refined;
  }

  function scanSeams(imageData, originalWidth = imageData.width, originalHeight = imageData.height,
    topCount = 8) {
    const { width, height, data } = imageData;
    if (!width || !height || data.length !== width * height * 4) throw new Error("Invalid ImageData");
    const scale = width / originalWidth;
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
    }
    const smooth = blurSmall(rgb, width, height);
    const candidates = [];
    for (const axis of ["vertical", "horizontal"]) {
      const residual = directionalResidual(smooth, width, height, axis);
      for (const profile of ["strong", "long"]) {
        candidates.push(...candidatesForProfile(residual, axis, profile, originalWidth, originalHeight, scale,
          Math.max(96, topCount * 12)));
      }
    }
    const refined = refineCandidates(candidates, imageData, originalWidth, originalHeight, topCount);
    for (const axis of ["vertical", "horizontal"]) {
      refined.push(...localSubtleCandidates(imageData, originalWidth, originalHeight, axis, topCount));
    }
    return refined;
  }

  function localSubtleCandidates(imageData, originalWidth, originalHeight, axis, topCount) {
    const { width, height, data } = imageData;
    const vertical = axis === "vertical";
    const across = vertical ? width : height;
    const along = vertical ? height : width;
    const acrossScale = across / (vertical ? originalWidth : originalHeight);
    const alongScale = along / (vertical ? originalHeight : originalWidth);
    const blockSize = Math.max(32, Math.round(96 * alongScale));
    const backgroundRadius = 10;
    const backgroundStart = 4;
    const edgeMargin = 12;
    const blocks = Math.floor(along / blockSize);
    const hits = new Float32Array(blocks * across);
    const jump = new Float32Array(across * 3);
    const magnitude = new Float32Array(across);
    for (let block = 0; block < blocks; block++) {
      jump.fill(0);
      for (let t = block * blockSize; t < (block + 1) * blockSize; t++) {
        for (let p = 1; p < across; p++) {
          const i = (vertical ? t * width + p : p * width + t) * 4;
          const j = i - (vertical ? 4 : width * 4);
          const q = p * 3;
          jump[q] += data[i] - data[j];
          jump[q + 1] += data[i + 1] - data[j + 1];
          jump[q + 2] += data[i + 2] - data[j + 2];
        }
      }
      for (let p = 1; p < across; p++) {
        const q = p * 3;
        jump[q] /= blockSize; jump[q + 1] /= blockSize; jump[q + 2] /= blockSize;
        magnitude[p] = Math.hypot(jump[q], jump[q + 1], jump[q + 2]);
      }
      for (let p = edgeMargin; p < across - edgeMargin; p++) {
        const peak = magnitude[p];
        if (peak < 0.9 || peak < magnitude[p - 1] || peak < magnitude[p + 1]) continue;
        let background = 0;
        let backgroundCount = 0;
        for (let d = backgroundStart; d <= backgroundRadius; d++) {
          background += magnitude[p - d] + magnitude[p + d];
          backgroundCount += 2;
        }
        background /= Math.max(1, backgroundCount);
        if (peak < 2.5 * (background + 0.2)) continue;
        let left = p, right = p;
        while (left > p - 5 && magnitude[left - 1] > peak * 0.45) left--;
        while (right < p + 5 && magnitude[right + 1] > peak * 0.45) right++;
        if (right - left + 1 > Math.max(2, Math.ceil(2.5 * acrossScale))) continue;
        hits[block * across + p] = peak / (background + 0.8);
      }
    }
    const proposals = [];
    for (let p = edgeMargin; p < across - edgeMargin; p++) {
      let first = -1, last = -1, positive = 0, score = 0, best = null;
      const finish = () => {
        if (positive >= 3 && last - first + 1 <= positive * 1.4) {
          const value = score * Math.sqrt(positive);
          if (!best || value > best.value) best = { first, last, positive, value };
        }
        first = -1; last = -1; positive = 0; score = 0;
      };
      for (let block = 0; block < blocks; block++) {
        const strength = hits[block * across + p];
        if (strength) {
          if (first < 0) first = block;
          last = block; positive++; score += Math.min(6, strength);
        } else if (first >= 0 && block - last >= 2) finish();
      }
      finish();
      if (best && best.value >= 30) proposals.push({ p, ...best });
    }
    proposals.sort((a, b) => b.value - a.value);
    const chosen = [];
    for (const item of proposals) {
      if (chosen.some(c => Math.abs(c.scanPosition - item.p) < 8)) continue;
      const position = Math.round(item.p / acrossScale);
      const begin = Math.round(item.first * blockSize / alongScale);
      const end = Math.round((item.last + 1) * blockSize / alongScale);
      chosen.push({ profile: "local", axis, rank: chosen.length + 1,
        score: Math.round(item.value * 100) / 100, scanPosition: item.p,
        x0: vertical ? position : begin, y0: vertical ? begin : position,
        x1: vertical ? position : end, y1: vertical ? end : position,
        persistence: Math.round(item.positive / (item.last - item.first + 1) * 100) / 100,
        detail: "窄幅局部色差" });
      if (chosen.length >= topCount) break;
    }
    return chosen;
  }

  root.SeamDetector = { scanSeams };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SeamDetector;
})(typeof globalThis !== "undefined" ? globalThis : this);
