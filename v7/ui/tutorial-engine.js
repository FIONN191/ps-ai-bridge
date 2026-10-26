/* ⭐ 2026-10-18 新手教程 · 假引擎（外挂能力 / 校色 / 调强度在教程里的「示例结果」）。
 *
 * 真软件里这些工具都往本机引擎发请求（127.0.0.1:37894 抠像那一类、37893 校色），开着云端外挂时
 * cloud-tools.js 把同样的请求原样转到云端门卫（<云端地址>/m/xxx、/c/xxx）。
 * 教程里不联网：tutorial-host.js 的 fetch 先问这里「这是不是引擎的请求」，是就由这里现场合成结果，
 * 格式照真引擎（engine/*.py）回 —— 界面那边解析、贴回、任务卡全是真代码。
 *
 *   /health /models         回「档位齐全、模型都在」（抠像 / 人体解析 / 指哪抠哪 / 文字找东西 / 细边 / 过渡帧）
 *   /matting /matte          回一张黑白蒙版（中间偏上一个人形椭圆）+ X-Matting-Info
 *   /segment                 回 头发 / 脸 / 衣服 三个部位的蒙版
 *   /sam2                    回三个大小不同的候选
 *   /sam3                    回一个「找到了」的框
 *   /tween                   回 A→B 之间的过渡帧（一行一个 JSON，跟真引擎一样）
 *   37893 /process           回 [4 字节长度][校色成品][底版]：成品往参考图的平均色靠，底版原样 —— 👁 切版本看得出差别
 *
 * 只在教程里生效（没有 __V7_TUTORIAL__ 就什么都不做）。
 */
(function (root) {
  'use strict';
  if (!root.__V7_TUTORIAL__) return;
  var doc = root.document;
  var CLOUD = 'https://tutorial-cloud.invalid';

  var TIERS = { matting: 3, segment: 3, sam2: 3, sam3: 3, matte: 3, tween: 3 };
  var MODELS = {};
  [['matting', '抠像'], ['segment', '人体解析'], ['sam2-enc', '指哪抠哪'], ['sam3', '文字找东西'], ['matte', '细边'], ['tween', '过渡帧']].forEach(function (k) {
    [1, 2, 3].forEach(function (t) { MODELS['tutorial-' + k[0] + '-' + t] = { kind: k[0], tier: t, state: 'ok', enabled: true, name: '教程' + k[1] + ' 档' + t, sizeMB: 0, vramGB: 0 }; });
  });

  // ── 认请求：本机引擎地址，或者云端外挂转过来的地址 ──
  function route(url) {
    var u;
    try { u = new URL(String(url), root.location.href); } catch (_) { return null; }
    var path = u.pathname;
    if (u.origin === CLOUD) {
      if (path.indexOf('/m/') === 0) return { engine: 'm', path: path.slice(2), query: u.searchParams };
      if (path.indexOf('/c/') === 0) return { engine: 'c', path: path.slice(2), query: u.searchParams };
      return { engine: 'gate', path: path, query: u.searchParams };
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      if (u.port === '37894') return { engine: 'm', path: path, query: u.searchParams };
      if (u.port === '37893') return { engine: 'c', path: path, query: u.searchParams };
    }
    return null;
  }
  function json(data, status, headers) {
    return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
  }
  function bodyBytes(init) {
    var b = init && init.body;
    if (!b) return Promise.resolve(new Uint8Array(0));
    if (b instanceof Uint8Array) return Promise.resolve(b);
    if (b instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(b));
    if (b instanceof Blob) return b.arrayBuffer().then(function (x) { return new Uint8Array(x); });
    return Promise.resolve(new Uint8Array(0));
  }
  function decode(bytes) { return root.createImageBitmap(new Blob([bytes])); }
  function canvas(w, h) { var c = doc.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }
  function toPng(c) { return new Promise(function (r) { c.toBlob(function (b) { b.arrayBuffer().then(function (x) { r(new Uint8Array(x)); }); }, 'image/png'); }); }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function headerParams(init, name) { try { var h = new Headers(init && init.headers); return JSON.parse(decodeURIComponent(h.get(name) || '')) || {}; } catch (_) { return {}; } }

  // 一张黑白蒙版：白的是「抠出来的东西」。shape = [cx, cy, rx, ry]（都是 0~1），soft = 边缘柔化宽度
  function mask(w, h, shapes, soft) {
    var c = canvas(w, h), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.filter = 'blur(' + Math.max(1, Math.round(Math.min(w, h) * (soft || 0.01))) + 'px)';
    g.fillStyle = '#fff';
    shapes.forEach(function (s) { g.beginPath(); g.ellipse(s[0] * w, s[1] * h, s[2] * w, s[3] * h, 0, 0, Math.PI * 2); g.fill(); });
    return c;
  }
  var PERSON = [[0.5, 0.3, 0.2, 0.17], [0.5, 0.78, 0.36, 0.36]];

  function imageOf(init) { return bodyBytes(init).then(function (bytes) { return decode(bytes); }); }

  var handlers = {
    m: {
      'GET /health': function () { return json({ ok: true, tiers: TIERS, caps: { onnx: true, numpy: true, pil: true, cv2: true }, models: MODELS, vramGB: 24, device: '教程（示例）', provider: 'tutorial', version: 'tutorial' }); },
      'GET /models': function () { return json({ ok: true, models: MODELS, tiers: TIERS, modelsDir: '' }); },
      'GET /unload': function () { return json({ ok: true }); },
      'GET /shutdown': function () { return json({ ok: true }); },
      'POST /matting': function (r, init) {
        return imageOf(init).then(function (img) {
          var w = img.width, h = img.height;
          var m = mask(w, h, PERSON, 0.012);
          var alphaOnly = r.query.get('out') === 'alpha';
          var out = m;
          if (!alphaOnly) {
            out = canvas(w, h); var g = out.getContext('2d');
            g.drawImage(img, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(alphaFrom(m), 0, 0);
          }
          return toPng(out).then(function (png) {
            return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'X-Matting-Info': encodeURIComponent(JSON.stringify({ size: [w, h], bbox: [0, 0, w, h], tutorial: true })) } });
          });
        });
      },
      'POST /matte': function (r, init) { return handlers.m['POST /matting'](r, init); },
      'POST /segment': function (r, init) {
        return imageOf(init).then(function (img) {
          var w = img.width, h = img.height;
          var parts = [
            { id: 2, name: '头发', shapes: [[0.5, 0.18, 0.22, 0.1]] },
            { id: 13, name: '脸', shapes: [[0.5, 0.32, 0.15, 0.13]] },
            { id: 5, name: '上衣', shapes: [[0.5, 0.8, 0.36, 0.3]] }
          ];
          return Promise.all(parts.map(function (p) { return toPng(mask(w, h, p.shapes, 0.006)); })).then(function (pngs) {
            return json({ ok: true, size: [w, h], parts: parts.map(function (p, i) { return { id: p.id, name: p.name, label: p.name, percent: 12, pixels: Math.round(w * h * 0.12), alphaB64: b64(pngs[i]) }; }) });
          });
        });
      },
      'POST /sam2': function (r, init) {
        return imageOf(init).then(function (img) {
          var w = img.width, h = img.height;
          var sets = [[[0.5, 0.5, 0.3, 0.3]], [[0.5, 0.5, 0.4, 0.42]], [[0.5, 0.5, 0.22, 0.2]]];
          return Promise.all(sets.map(function (s) { return toPng(mask(w, h, s, 0.004)); })).then(function (pngs) {
            return json({ ok: true, best: 0, size: [w, h], candidates: pngs.map(function (p, i) { return { index: i, iou: 0.95 - i * 0.07, pixels: Math.round(w * h * (0.28 - i * 0.06)), alphaB64: b64(p) }; }) });
          });
        });
      },
      'POST /sam3': function (r, init) {
        return imageOf(init).then(function (img) {
          var w = img.width, h = img.height;
          return json({ ok: true, size: [w, h], hit: 1, truncated: false,
            instances: [{ score: 0.9, pixels: Math.round(w * h * 0.1), bbox: [Math.round(w * 0.33), Math.round(h * 0.18), Math.round(w * 0.67), Math.round(h * 0.46)] }] });
        });
      },
      'POST /tween': function (r, init) {
        var headLen = 0;
        try { headLen = Number(new Headers(init && init.headers).get('X-Head-Len')) || 0; } catch (_) {}
        var steps = Math.max(2, Math.min(32, Number(r.query.get('steps')) || 16));
        var only = r.query.has('only') ? Number(r.query.get('only')) : null;
        return bodyBytes(init).then(function (bytes) {
          return Promise.all([decode(bytes.subarray(0, headLen)), decode(bytes.subarray(headLen))]);
        }).then(function (pair) {
          var A = pair[0], B = pair[1], w = B.width, h = B.height;
          var idx = []; for (var i = 0; i < steps; i++) if (only == null || only === i) idx.push(i);
          return Promise.all(idx.map(function (i) {
            var c = canvas(w, h), g = c.getContext('2d');
            g.drawImage(A, 0, 0, w, h); g.globalAlpha = steps > 1 ? i / (steps - 1) : 1; g.drawImage(B, 0, 0, w, h);
            return toPng(c);
          })).then(function (pngs) {
            var lines = [JSON.stringify({ ok: true, mime: 'image/png', width: w, height: h, steps: steps, lossy: false })];
            pngs.forEach(function (p, k) { lines.push(JSON.stringify({ i: idx[k], b64: b64(p) })); });
            return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
          });
        });
      }
    },
    c: {
      'GET /health': function () { return json({ ok: true, tier: 2, vramGB: 24, device: '教程（示例）', version: 'tutorial' }); },
      'GET /unload': function () { return json({ ok: true }); },
      'GET /shutdown': function () { return json({ ok: true }); },
      // 校色：成品 = 生成图往原图（参考）的平均色靠一点；底版 = 生成图原样
      'POST /process': function (r, init) {
        var fd = init && init.body;
        if (!(fd instanceof FormData)) return json({ ok: false, error: '教程假引擎：缺图片' }, 400);
        var meta = {}; try { meta = JSON.parse(fd.get('meta') || '{}'); } catch (_) {}
        return Promise.all([root.createImageBitmap(fd.get('src')), root.createImageBitmap(fd.get('ref'))]).then(function (pair) {
          var src = pair[0], ref = pair[1], w = src.width, h = src.height;
          var avg = canvas(1, 1).getContext('2d'); avg.drawImage(ref, 0, 0, 1, 1);
          var px = avg.getImageData(0, 0, 1, 1).data;
          var colored = canvas(w, h), g = colored.getContext('2d');
          g.drawImage(src, 0, 0);
          g.globalCompositeOperation = 'color'; g.globalAlpha = 0.55; g.fillStyle = 'rgb(' + px[0] + ',' + px[1] + ',' + px[2] + ')'; g.fillRect(0, 0, w, h);
          var base = canvas(w, h); base.getContext('2d').drawImage(src, 0, 0);
          var wantBase = meta.wantBase !== false;
          return Promise.all([toPng(colored), wantBase ? toPng(base) : null]).then(function (out) {
            var headers = { 'content-type': 'application/octet-stream', 'X-Match-Meta': encodeURIComponent(JSON.stringify({ tier: meta.tier || 2, hasBase: !!out[1], notes: ['教程示例校色'] })) };
            if (!out[1]) return new Response(out[0], { status: 200, headers: headers });
            var box = new Uint8Array(4 + out[0].length + out[1].length);
            new DataView(box.buffer).setUint32(0, out[0].length, false);
            box.set(out[0], 4); box.set(out[1], 4 + out[0].length);
            return new Response(box, { status: 200, headers: headers });
          });
        });
      }
    },
    gate: {
      'GET /health': function () { return json({ ok: true, version: 'tutorial', queue: 0 }); }
    }
  };
  function alphaFrom(m) {
    var c = canvas(m.width, m.height), g = c.getContext('2d');
    g.drawImage(m, 0, 0);
    var d = g.getImageData(0, 0, c.width, c.height);
    for (var i = 0; i < d.data.length; i += 4) { d.data[i + 3] = d.data[i]; }
    g.putImageData(d, 0, 0);
    return c;
  }

  // 给 tutorial-host.js 的 fetch 用：是引擎请求就回 Promise<Response>，不是就回 null
  root.__V7_TUTORIAL_ENGINE__ = function (url, init) {
    var r = route(url);
    if (!r) return null;
    var method = String((init && init.method) || 'GET').toUpperCase();
    var fn = handlers[r.engine] && handlers[r.engine][method + ' ' + r.path];
    try { root.parent.postMessage({ v7tutorial: 1, kind: 'engine', payload: { engine: r.engine, path: r.path, method: method } }, '*'); } catch (_) {}
    if (!fn) return Promise.resolve(json({ ok: false, error: '教程里没有这个引擎功能：' + r.path }, 404));
    return Promise.resolve().then(function () { return fn(r, init || {}); }).catch(function (e) { return json({ ok: false, error: '教程假引擎出错：' + (e && e.message || e) }, 500); });
  };
  root.__V7_TUTORIAL_CLOUD__ = CLOUD;
})(window);
