/* Combines independent precision and seam evidence for review prioritization. */
(function (root) {
  "use strict";

  const DEFAULT_CELL_SIZE = 16;
  const DEFAULTS = {
    boundaryDistanceCells: 2,
    minimumRisk: 30,
    minimumRiskDelta: 18,
    minimumCoverage: 0.3,
    minimumSamples: 3
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function normalizeBox(candidate, index, width, height) {
    if (!candidate || !finite(candidate.x) || !finite(candidate.y) ||
        !finite(candidate.width) || !finite(candidate.height)) return null;
    const x0 = clamp(Number(candidate.x), 0, width);
    const y0 = clamp(Number(candidate.y), 0, height);
    const x1 = clamp(Number(candidate.x) + Number(candidate.width), 0, width);
    const y1 = clamp(Number(candidate.y) + Number(candidate.height), 0, height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { index, x: x0, y: y0, width: x1 - x0, height: y1 - y0, source: candidate };
  }

  function normalizeLine(candidate, index, width, height) {
    if (!candidate || ![candidate.x0, candidate.y0, candidate.x1, candidate.y1].every(finite)) return null;
    const axis = candidate.axis;
    if (axis !== "vertical" && axis !== "horizontal") return null;
    const x0 = clamp(Number(candidate.x0), 0, width);
    const y0 = clamp(Number(candidate.y0), 0, height);
    const x1 = clamp(Number(candidate.x1), 0, width);
    const y1 = clamp(Number(candidate.y1), 0, height);
    if (axis === "vertical") {
      if (Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) < 1) return null;
      return {
        index, axis, position: (x0 + x1) / 2, start: Math.min(y0, y1), end: Math.max(y0, y1),
        source: candidate
      };
    }
    if (Math.abs(y1 - y0) > 2 || Math.abs(x1 - x0) < 1) return null;
    return {
      index, axis, position: (y0 + y1) / 2, start: Math.min(x0, x1), end: Math.max(x0, x1),
      source: candidate
    };
  }

  function overlapRatio(a, b) {
    const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    return overlap / Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  }

  function seamStrength(line) {
    return finite(line.source.score) ? Number(line.source.score) : 0;
  }

  function dedupeSeams(candidates, width, height, cellSize) {
    const lines = candidates.map((candidate, index) => normalizeLine(candidate, index, width, height))
      .filter(Boolean)
      .sort((a, b) => seamStrength(b) - seamStrength(a));
    const unique = [];
    for (const line of lines) {
      const duplicate = unique.find(existing => existing.axis === line.axis &&
        Math.abs(existing.position - line.position) <= Math.max(4, cellSize * 0.5) &&
        overlapRatio(existing, line) >= 0.5);
      if (!duplicate) unique.push(line);
    }
    return unique;
  }

  function makeRiskGrid(cells, width, height, cellSize) {
    const cols = Math.ceil(width / cellSize);
    const rows = Math.ceil(height / cellSize);
    const values = new Float32Array(cols * rows);
    const present = new Uint8Array(cols * rows);
    for (const cell of cells || []) {
      if (!cell || !finite(cell.x) || !finite(cell.y) || !finite(cell.risk)) continue;
      const col = Math.floor(Number(cell.x) / cellSize);
      const row = Math.floor(Number(cell.y) / cellSize);
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const index = row * cols + col;
      values[index] = clamp(Number(cell.risk), 0, 100);
      present[index] = 1;
    }
    return {
      cols, rows,
      at(x, y) {
        const col = Math.floor(x / cellSize);
        const row = Math.floor(y / cellSize);
        if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
        const index = row * cols + col;
        return present[index] ? values[index] : null;
      }
    };
  }

  function boxContains(box, x, y, margin = 0) {
    return x >= box.x - margin && x <= box.x + box.width + margin &&
      y >= box.y - margin && y <= box.y + box.height + margin;
  }

  function distanceToBoundary(box, axis, position) {
    const start = axis === "vertical" ? box.x : box.y;
    const end = start + (axis === "vertical" ? box.width : box.height);
    return Math.min(Math.abs(position - start), Math.abs(position - end));
  }

  function orthogonalOverlap(line, box, cellSize) {
    const start = line.axis === "vertical" ? box.y : box.x;
    const end = start + (line.axis === "vertical" ? box.height : box.width);
    const from = Math.max(line.start, start - cellSize);
    const to = Math.min(line.end, end + cellSize);
    return { start: from, end: to };
  }

  function sampleBoundary(line, box, grid, width, height, cellSize, options) {
    const boundaryDistance = distanceToBoundary(box, line.axis, line.position);
    if (boundaryDistance > options.boundaryDistanceCells * cellSize) return null;

    const overlap = orthogonalOverlap(line, box, cellSize);
    if (overlap.end - overlap.start < options.minimumSamples * cellSize) return null;
    const step = cellSize;
    const half = cellSize * 0.5;
    const probeDistances = [half, cellSize * 1.5];
    let samples = 0;
    let hits = 0;
    let totalDelta = 0;
    let totalHigh = 0;
    let maxDelta = 0;
    const highSides = { negative: 0, positive: 0 };

    for (let along = overlap.start + step / 2; along < overlap.end; along += step) {
      let found = null;
      for (const distance of probeDistances) {
        const negative = line.axis === "vertical"
          ? grid.at(line.position - distance, along)
          : grid.at(along, line.position - distance);
        const positive = line.axis === "vertical"
          ? grid.at(line.position + distance, along)
          : grid.at(along, line.position + distance);
        if (negative === null || positive === null) continue;
        const delta = Math.abs(negative - positive);
        const highSide = negative >= positive ? "negative" : "positive";
        const highRisk = Math.max(negative, positive);
        const highPoint = line.axis === "vertical"
          ? { x: line.position + (highSide === "positive" ? distance : -distance), y: along }
          : { x: along, y: line.position + (highSide === "positive" ? distance : -distance) };
        if (!boxContains(box, highPoint.x, highPoint.y, cellSize * 0.35)) continue;
        const pair = { delta, highRisk, highSide };
        if (!found || pair.delta > found.delta) found = pair;
      }
      if (!found) continue;
      samples++;
      totalDelta += found.delta;
      totalHigh += found.highRisk;
      maxDelta = Math.max(maxDelta, found.delta);
      if (found.delta >= options.minimumRiskDelta && found.highRisk >= options.minimumRisk) {
        hits++;
        highSides[found.highSide]++;
      }
    }

    const coverage = hits / Math.max(1, samples);
    if (samples < options.minimumSamples || coverage < options.minimumCoverage) return null;
    const meanRiskDelta = totalDelta / samples;
    const meanHighRisk = totalHigh / samples;
    const highSide = highSides.positive >= highSides.negative ? "positive" : "negative";
    return {
      boundaryDistancePx: Math.round(boundaryDistance * 10) / 10,
      samples,
      corroboratingSamples: hits,
      coverage: Math.round(coverage * 1000) / 1000,
      meanRiskDelta: Math.round(meanRiskDelta * 10) / 10,
      maxRiskDelta: Math.round(maxDelta * 10) / 10,
      meanHighRisk: Math.round(meanHighRisk * 10) / 10,
      highRiskSide: highSide
    };
  }

  function lineGeometry(line) {
    return line.axis === "vertical"
      ? { x0: line.position, y0: line.start, x1: line.position, y1: line.end }
      : { x0: line.start, y0: line.position, x1: line.end, y1: line.position };
  }

  function lineBounds(line) {
    const geometry = lineGeometry(line);
    return {
      x: geometry.x0,
      y: geometry.y0,
      width: Math.max(1, geometry.x1 - geometry.x0),
      height: Math.max(1, geometry.y1 - geometry.y0)
    };
  }

  function boxGeometry(box) {
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  function combine(precisionCandidates, seamCandidates, cells, width, height, cellSize = DEFAULT_CELL_SIZE) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new TypeError("width and height must be positive integer pixel dimensions");
    }
    if (!Number.isFinite(cellSize) || cellSize < 1) throw new TypeError("cellSize must be a positive number");
    const options = DEFAULTS;
    const boxes = (precisionCandidates || []).map((candidate, index) => normalizeBox(candidate, index, width, height))
      .filter(Boolean);
    const lines = dedupeSeams(seamCandidates || [], width, height, cellSize);
    const grid = makeRiskGrid(cells, width, height, cellSize);
    const matchesByBox = new Map();
    const unmatchedLines = [];

    for (const line of lines) {
      const matches = boxes.map(box => ({
        box,
        boundary: sampleBoundary(line, box, grid, width, height, cellSize, options)
      })).filter(match => match.boundary)
        .sort((a, b) => b.boundary.coverage - a.boundary.coverage ||
          b.boundary.meanRiskDelta - a.boundary.meanRiskDelta ||
          Number(b.box.source.peak || b.box.source.score || 0) - Number(a.box.source.peak || a.box.source.score || 0));
      if (!matches.length) {
        unmatchedLines.push(line);
        continue;
      }
      const best = matches[0];
      if (!matchesByBox.has(best.box.index)) matchesByBox.set(best.box.index, []);
      matchesByBox.get(best.box.index).push({ line, boundary: best.boundary });
    }

    const items = [];
    const matchedBoxIndices = new Set(matchesByBox.keys());
    for (const box of boxes) {
      const matchedLines = matchesByBox.get(box.index);
      if (matchedLines && matchedLines.length) {
        const strongest = [...matchedLines].sort((a, b) => b.boundary.coverage - a.boundary.coverage ||
          b.boundary.meanRiskDelta - a.boundary.meanRiskDelta)[0];
        items.push({
          id: `joint:p${box.index}:s${matchedLines.map(item => item.line.index).join("-")}`,
          type: "joint",
          label: "接缝与精度变化吻合",
          priority: "high",
          priorityOrder: 1,
          geometry: "box-with-lines",
          ...boxGeometry(box),
          precisionBox: boxGeometry(box),
          seamLines: matchedLines.map(item => ({
            ...lineGeometry(item.line), axis: item.line.axis, score: item.line.source.score,
            profile: item.line.source.profile
          })),
          evidence: {
            precision: {
              score: box.source.score ?? null,
              peak: box.source.peak ?? null,
              cellCount: box.source.cellCount ?? null
            },
            seams: matchedLines.map(item => ({
              axis: item.line.axis,
              score: item.line.source.score ?? null,
              profile: item.line.source.profile ?? null,
              boundaryChange: item.boundary
            })),
            strongestBoundaryChange: strongest.boundary,
            note: "优先级表示两类线索共同出现，不是缺陷概率。"
          },
          sourceIndices: { precision: box.index, seams: matchedLines.map(item => item.line.index) }
        });
      } else {
        items.push({
          id: `precision:p${box.index}`,
          type: "precision-only",
          label: "局部精度下降",
          priority: "review",
          priorityOrder: 2,
          geometry: "box",
          ...boxGeometry(box),
          precisionBox: boxGeometry(box),
          evidence: {
            precision: {
              score: box.source.score ?? null,
              peak: box.source.peak ?? null,
              cellCount: box.source.cellCount ?? null
            },
            note: "仅精度检测提供线索，仍保留复核。"
          },
          sourceIndices: { precision: box.index, seams: [] }
        });
      }
    }

    for (const line of unmatchedLines) {
      const geometry = lineGeometry(line);
      items.push({
        id: `seam:s${line.index}`,
        type: "seam-only",
        label: "边界变化线索",
        priority: "review",
        priorityOrder: 2,
        geometry: "line",
        ...lineBounds(line),
        line: geometry,
        axis: line.axis,
        evidence: {
          seam: {
            score: line.source.score ?? null,
            profile: line.source.profile ?? null,
            coherence: line.source.coherence ?? null,
            persistence: line.source.persistence ?? null
          },
          note: "未发现沿线相邻精度风险跃迁；单独保留，不代表接缝缺陷。"
        },
        sourceIndices: { precision: [], seams: [line.index] }
      });
    }

    items.sort((a, b) => a.priorityOrder - b.priorityOrder ||
      (b.evidence?.precision?.peak || b.evidence?.precision?.score || b.evidence?.seam?.score || 0) -
      (a.evidence?.precision?.peak || a.evidence?.precision?.score || a.evidence?.seam?.score || 0));
    return items;
  }

  const api = { combine, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FusionDetector = api;
})(typeof self !== "undefined" ? self : globalThis);
