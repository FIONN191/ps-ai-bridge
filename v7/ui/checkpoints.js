/* Opt-in five-minute Photoshop canvas checkpoints.
 *
 * The controller uses the existing link/cache contracts in both desktop
 * shells. PNG bytes never enter the renderer, task JSON or localStorage.
 * Only a completed native export and durable metadata advance the timer.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7Checkpoints = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var INTERVAL_MS = 5 * 60 * 1000;
  function fail(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function safePart(value) {
    var text = String(value || '').trim();
    if (!text || /[\\/]|\.\.|[\u0000-\u001f]/.test(text)) throw fail('CHECKPOINT_PATH_INVALID', '检查点缓存目录无效');
    return text;
  }
  function cachePath(root, project, runId) {
    var base = String(root || '').trim().replace(/[\\/]+$/, '');
    if (!base || !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(base)) throw fail('CHECKPOINT_PATH_INVALID', '检查点缓存根目录不可用');
    var sep = /\\/.test(base) ? '\\' : '/';
    return base + sep + safePart(project) + sep + safePart(runId) + sep + 'canvas.png';
  }

  function parseCacheRef(value) {
    var match = /^cache:([^/]+)\/([^/]+)\/canvas\.png$/.exec(String(value || ''));
    if (!match) throw fail('CHECKPOINT_PATH_INVALID', '检查点缓存引用无效');
    return { project: safePart(match[1]), runId: safePart(match[2]) };
  }

  async function openFolder(checkpoint, deps) {
    deps = deps || {};
    var ref = parseCacheRef(checkpoint && checkpoint.cacheRef);
    if (typeof deps.ownsProject === 'function' && !deps.ownsProject(ref.project)) throw fail('CHECKPOINT_PATH_INVALID', '这个检查点不属于当前账号');
    if (!deps.cache || typeof deps.cache.openFolder !== 'function') throw fail('CHECKPOINT_FOLDER_FAILED', '当前客户端没有打开检查点文件夹的接口');
    var result = await deps.cache.openFolder(ref.project, ref.runId);
    if (!result || result.ok !== true) throw fail('CHECKPOINT_FOLDER_FAILED', result && result.error || '检查点文件夹无法打开');
    return result;
  }

  function createController(deps) {
    deps = deps || {};
    var clock = deps.now || Date.now;
    var enabled = false;
    var enabledAt = 0;
    var enabledScope = '';
    var sequence = 0;
    var epoch = 0;
    var serial = Promise.resolve();
    var inFlight = new Map();
    var completedAt = new Map();
    var skippedWarned = false;
    var cache = deps.cache;
    var productData = deps.productData;

    // ⭐ 2026-09-30：间隔从设置来（1–60 分钟），控制器只负责"问一下现在是多少"。
    //   ⚠ 做成函数而不是构造时读一次：用户在设置里改完滑条要【立刻】生效，
    //     不用重开面板。取不到（没传/传了非法值）就退回默认 5 分钟。
    function interval() {
      var value = typeof deps.intervalMs === 'function' ? Number(deps.intervalMs()) : Number(deps.intervalMs);
      return value > 0 ? value : INTERVAL_MS;
    }

    function setEnabled(value) {
      var next = value === true;
      var scope = typeof deps.scope === 'function' ? deps.scope() : '';
      if (next !== enabled || scope !== enabledScope) { epoch++; inFlight.clear(); }
      if (next && (!enabled || scope !== enabledScope)) enabledAt = clock();
      if (!next) enabledAt = 0;
      enabledScope = scope;
      enabled = next;
      return { enabled: enabled, nextEligibleAt: enabled ? enabledAt + interval() : null };
    }

    function lastCreatedAt(documentRef, project) {
      var last = completedAt.get(project + '\n' + documentRef) || 0;
      var list = productData && productData.checkpoints ? productData.checkpoints() : [];
      list.forEach(function (item) {
        if (item.documentRef !== documentRef) return;
        // References include the account/device namespace in project; another
        // namespace cannot delay or reveal this account's checkpoints.
        if (String(item.cacheRef || '').indexOf('cache:' + project + '/') !== 0) return;
        last = Math.max(last, Date.parse(item.createdAt) || 0);
      });
      return Math.max(enabledAt, last);
    }

    async function writeFile(project, runId, name, bytes) {
      var result = await cache.writeFile(project, runId, name, bytes);
      if (!result || result.ok !== true) {
        var error = fail('CHECKPOINT_CACHE_FAILED', result && result.error || '检查点文件写入失败');
        // 2026-10-24：外壳回的 kind / path 带出去，报错卡按原因说话（ERR.cacheFailure）
        error.cacheKind = result && result.kind || '';
        error.cachePath = result && result.path || '';
        throw error;
      }
      return result;
    }

    function operation() { return { epoch: epoch, scope: typeof deps.scope === 'function' ? deps.scope() : '', namespaceId: typeof deps.namespaceId === 'function' ? deps.namespaceId() : '' }; }
    function assertCurrent(started) {
      if (started.epoch !== epoch || started.scope !== (typeof deps.scope === 'function' ? deps.scope() : '')) {
        throw fail('CHECKPOINT_ACCOUNT_CHANGED', '账号或检查点开关已变化，旧操作已停止；请在当前账号重新生成');
      }
    }
    async function enforceCapacity(started, keepRef, incomingBytes) {
      if (typeof deps.capacityBytes !== 'function') return;
      assertCurrent(started);
      var limit = Number(deps.capacityBytes());
      if (!(limit > 0) || !cache || !cache.checkpointInventory || !cache.purgeCheckpoint || !deps.namespaceId) {
        throw fail('CHECKPOINT_CAPACITY_FAILED', '检查点容量接口不可用，请重启或更新客户端');
      }
      var namespaceId = started.namespaceId;
      var inventory = await cache.checkpointInventory({ namespaceId: namespaceId });
      assertCurrent(started);
      // 10-25（docs/286 P1-6）：外壳把不完整的检查点目录跳过了（原来一个坏的就整次失败、每次生成报一遍）⇒ 这里只提一次是哪几个
      if (inventory && Array.isArray(inventory.skipped) && inventory.skipped.length && typeof deps.warn === 'function' && !skippedWarned) {
        skippedWarned = true;
        deps.warn('有 ' + inventory.skipped.length + ' 个检查点目录不完整，已跳过（不影响生成）：' + inventory.skipped.slice(0, 3).map(function (s) { return s.project + '/' + s.runId + '（' + s.error + '）'; }).join('；'));
      }
      if (!inventory || inventory.ok !== true || !Array.isArray(inventory.items) || !Number.isFinite(inventory.totalBytes)) {
        throw fail('CHECKPOINT_CAPACITY_FAILED', inventory && inventory.error || '缓存占用无法读取');
      }
      var remaining = inventory.totalBytes + Math.max(0, Number(incomingBytes) || 0);
      if (remaining <= limit) return;
      var candidates = inventory.items.filter(function (item) { return item.cacheRef !== keepRef; });
      if (candidates.some(function (item) { return !Number.isFinite(Date.parse(item.createdAt)) || !(item.sizeBytes >= 0); })) {
        throw fail('CHECKPOINT_CAPACITY_FAILED', '检查点时间或大小无效，请先检查缓存目录');
      }
      candidates.sort(function (a, b) { return Date.parse(a.createdAt) - Date.parse(b.createdAt) || String(a.cacheRef).localeCompare(String(b.cacheRef)); });
      var selected = [];
      for (var item of candidates) {
        if (remaining <= limit) break;
        selected.push(item); remaining -= item.sizeBytes;
      }
      if (remaining > limit || !selected.length) throw fail('CHECKPOINT_CAPACITY_BLOCKED', '缓存已超过容量上限，旧检查点不足以腾出空间；请清理生成缓存或增加容量上限');
      var confirmed = typeof deps.confirmCleanup === 'function' && await deps.confirmCleanup({ items: selected, totalBytes: inventory.totalBytes, incomingBytes: incomingBytes || 0, limitBytes: limit, freedBytes: selected.reduce(function (sum, entry) { return sum + entry.sizeBytes; }, 0) });
      assertCurrent(started);
      if (!confirmed) throw fail('CHECKPOINT_CAPACITY_DECLINED', '已保留全部检查点；清理缓存或增加上限后再保存检查点');
      for (var entry of selected) {
        assertCurrent(started);
        var removed = await cache.purgeCheckpoint({ namespaceId: namespaceId, project: entry.project, runId: entry.runId });
        assertCurrent(started);
        if (!removed || removed.ok !== true) throw fail('CHECKPOINT_CAPACITY_FAILED', removed && removed.error || '检查点清理失败，后续文件已停止清理');
        if (!productData.removeCheckpoint) throw fail('CHECKPOINT_INDEX_FAILED', '检查点索引清理接口不可用');
        productData.removeCheckpoint(entry.cacheRef);
      }
    }

    async function create(input, documentRef, project, started) {
      assertCurrent(started);
      if (!cache || typeof cache.root !== 'function' || typeof cache.writeFile !== 'function') throw fail('CHECKPOINT_CACHE_UNAVAILABLE', '当前客户端没有检查点缓存接口');
      if (!productData || typeof productData.saveCheckpoint !== 'function') throw fail('CHECKPOINT_STORE_UNAVAILABLE', '检查点记录模块不可用');
      if (typeof deps.bridge !== 'function') throw fail('BRIDGE_UNAVAILABLE', 'Photoshop 桥未连接');
      await enforceCapacity(started);
      assertCurrent(started);
      var runId = 'checkpoint-' + clock().toString(36) + '-' + (++sequence).toString(36);
      var path = cachePath(await cache.root(), project, runId);
      assertCurrent(started);
      // Native UXP getEntryWithUrl needs an existing File entry. The desktop
      // cache contract creates only this unique, initially empty destination.
      await writeFile(project, runId, 'canvas.png', new Uint8Array(0));
      assertCurrent(started);
      var startedAt = clock();
      var result = await deps.bridge('ps.doc.exportCheckpoint', {
        path: path, docId: input.docId, expiresAt: startedAt + 120000
      }, 120000);
      if (!result || result.exported !== true || result.checkpoint !== true || String(result.docId) !== String(input.docId)
          || result.mime !== 'image/png' || result.lossless !== true || Number(result.compression) !== 0
          || !(Number(result.width) > 0) || !(Number(result.height) > 0) || !(Number(result.sizeBytes) > 0)) {
        throw fail('CHECKPOINT_EXPORT_INVALID', 'Photoshop 未返回完整的检查点保存回执');
      }
      var data = { projectId: input.projectId || null, documentRef: documentRef,
        cacheRef: 'cache:' + project + '/' + runId + '/canvas.png', width: Number(result.width), height: Number(result.height),
        sizeBytes: Number(result.sizeBytes), durationMs: Number(result.durationMs) || clock() - startedAt,
        docName: String(result.docName || input.docName || ''), format: 'png', compression: 0 };
      // Separate from generation meta.json: cache:list must not treat a canvas
      // checkpoint as a generated task/result or count it on the leaderboard.
      var json = JSON.stringify(Object.assign({ version: 1, kind: 'checkpoint', namespaceId: started.namespaceId || undefined, createdAt: new Date(clock()).toISOString() }, data), null, 2);
      await writeFile(project, runId, 'checkpoint.json', new TextEncoder().encode(json));
      assertCurrent(started);
      var saved = productData.saveCheckpoint(data);
      completedAt.set(project + '\n' + documentRef, clock());
      try { await enforceCapacity(started, data.cacheRef); }
      catch (error) { error.checkpointSaved = true; error.checkpointRef = data.cacheRef; throw error; }
      return { ok: true, created: true, checkpoint: saved };
    }

    function beforeGeneration(input) {
      input = input || {};
      if (!enabled) return Promise.resolve({ ok: true, created: false, reason: 'disabled' });
      if (input.docId == null || input.docId === '') return Promise.reject(fail('CHECKPOINT_DOCUMENT_REQUIRED', '本次任务没有 Photoshop 文档来源，无法保存检查点'));
      var project;
      try { project = safePart(input.cacheProject); } catch (e) { return Promise.reject(e); }
      var documentRef = 'ps:' + String(input.docId);
      var key = project + '\n' + documentRef;
      if (inFlight.has(key)) return inFlight.get(key);
      if (clock() - lastCreatedAt(documentRef, project) < interval()) return Promise.resolve({ ok: true, created: false, reason: 'interval' });
      var started = operation();
      var pending = serial.then(function () { return create(input, documentRef, project, started); }).finally(function () { if (inFlight.get(key) === pending) inFlight.delete(key); });
      serial = pending.catch(function () {});
      inFlight.set(key, pending);
      return pending;
    }

    function withCacheCapacity(incomingBytes, write) {
      var started = operation();
      var pending = serial.then(async function () {
        await enforceCapacity(started, null, incomingBytes); assertCurrent(started);
        var value = await write(); assertCurrent(started);
        await enforceCapacity(started);
        return value;
      });
      serial = pending.catch(function () {});
      return pending;
    }

    // ⚠ intervalMs 这里继续吐【默认值】：它是"没配置时是多少"的答案，
    //   不是"现在生效的间隔"。现在生效的那个走 interval()，由设置驱动。
    return { setEnabled: setEnabled, beforeGeneration: beforeGeneration, withCacheCapacity: withCacheCapacity, intervalMs: INTERVAL_MS, effectiveIntervalMs: interval };
  }

  return { createController: createController, cachePath: cachePath, parseCacheRef: parseCacheRef, openFolder: openFolder, intervalMs: INTERVAL_MS };
});
