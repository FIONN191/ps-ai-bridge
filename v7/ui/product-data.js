/*
 * Durable product data that is safe to keep on the desktop.
 *
 * Image bytes stay in the existing cache/image store. This module stores only
 * prompt text, opaque references, project status and checkpoint metadata.
 * Every key is scoped through WHEELCHAIR_STORAGE so an account switch cannot
 * expose another account's history or project list.
 */
(function (root) {
  'use strict';

  var MAX_HISTORY = 500;
  var MAX_PROJECTS = 200;
  var CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  var forbidden = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|base64|data:image)/i;
  var forbiddenValue = /(?:data:image\/[^;]+;base64,|\bsk-[a-zA-Z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[^\s"']{8,})/i;

  function storageKey(name) {
    var scoped = root.WHEELCHAIR_STORAGE && root.WHEELCHAIR_STORAGE.key;
    return scoped ? scoped('product.' + name) : 'wheelchair.product.' + name;
  }

  function read(name, fallback) {
    try {
      var raw = root.localStorage && root.localStorage.getItem(storageKey(name));
      if (!raw) return fallback;
      var value = JSON.parse(raw);
      return value == null ? fallback : value;
    } catch (_) { return fallback; }
  }

  function write(name, value) {
    if (!root.localStorage) return false;
    try { root.localStorage.setItem(storageKey(name), JSON.stringify(value)); return true; } catch (_) { return false; }
  }

  function id(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function safeText(value, max, label) {
    var text = String(value == null ? '' : value).trim();
    if (text.length > (max || 20000)) throw new Error((label || '内容') + '过长');
    if (forbiddenValue.test(text)) throw new Error('本地记录不能包含密钥或图片正文');
    return text;
  }

  function safeObject(value) {
    if (value == null) return {};
    if (typeof value === 'string') { safeText(value, 20000, '内容'); return value; }
    if (Array.isArray(value)) return value.map(safeObject);
    if (typeof value !== 'object') return value;
    var output = {};
    Object.keys(value).forEach(function (key) {
      if (forbidden.test(String(key)) || ['__proto__','prototype','constructor'].includes(key)) throw new Error('本地记录不能包含密钥、图片正文或无效字段');
      output[key] = safeObject(value[key]);
    });
    return output;
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function historyList() {
    try {
      var raw = root.localStorage.getItem(storageKey('history'));
      var list = raw == null ? [] : JSON.parse(raw);
      if (!Array.isArray(list) || list.some(function (row) { return !row || typeof row.id !== 'string' || typeof row.prompt !== 'string'; })) throw new Error('历史记录格式无效');
      return list;
    } catch (error) { throw Object.assign(new Error('历史读取失败，原始记录已保留：' + error.message), { code: 'HISTORY_READ_FAILED' }); }
  }
  function saveHistory(list) {
    if (!write('history', list)) throw Object.assign(new Error('历史保存失败，请检查本机存储空间；本次记录尚未保存'), { code: 'HISTORY_SAVE_FAILED' });
  }

  function addHistory(input) {
    input = input || {};
    var prompt = safeText(input.prompt, 20000, '提示词');
    if (!prompt) throw new Error('提示词不能为空');
    var now = new Date().toISOString();
    var list = historyList();
    var taskId = input.taskId ? safeText(input.taskId, 256, '任务') : '';
    // Each generation owns its association. Repeated progress for one task is
    // idempotent; identical prompts on other photos never overwrite this row.
    var existing = taskId && list.find(function (item) { return item.taskId === taskId; });
    var item = existing || { id: id('prompt'), taskId: taskId || null, createdAt: now, useCount: 1 };
    item.prompt = prompt;
    item.lastUsedAt = input.createdAt || item.createdAt;
    ['presetId', 'presetVersion', 'presetTitle', 'workflowPresetId', 'projectId', 'documentName', 'model', 'provider', 'protocol'].forEach(function (key) {
      if (input[key] != null) item[key] = safeText(input[key], key === 'documentName' ? 1024 : 256, key);
    });
    if (input.parameters) item.parameters = safeObject(input.parameters);
    if (input.cacheRef) item.cacheRef = safeObject(input.cacheRef);
    if (input.outputIndices) item.outputIndices = input.outputIndices.filter(function (n) { return Number.isInteger(n) && n >= 0 && n < 18; });
    if (input.status) item.status = safeText(input.status, 64);
    if (existing) {
      list = list.map(function (row) { return row.id === item.id ? item : row; });
    } else {
      list.unshift(item);
    }
    // Do not silently throw away older associations at an arbitrary row count.
    saveHistory(list);
    return clone(item);
  }

  function searchHistory(query, options) {
    var q = String(query || '').trim().toLowerCase();
    var limit = Math.max(1, Math.min(200, Number(options && options.limit) || 50));
    return historyList().filter(function (item) {
      if (options && options.projectId && item.projectId !== options.projectId) return false;
      if (!q) return true;
      return [item.prompt, item.presetTitle, item.documentName, item.model, item.presetId].join(' ').toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)); }).slice(Math.max(0,Number(options&&options.offset)||0), Math.max(0,Number(options&&options.offset)||0)+limit).map(clone);
  }

  function recentPrompts(limit, query, offset) {
    var groups = new Map(), q = String(query || '').toLowerCase().trim();
    historyList().slice().sort(function (a, b) { return String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)); }).forEach(function (row) {
      if (q && !String(row.prompt || '').toLowerCase().includes(q)) return;
      if (!groups.has(row.prompt)) groups.set(row.prompt, Object.assign({}, row, { sourceIds: [], useCount: 0 }));
      var group = groups.get(row.prompt); group.sourceIds.push(row.id); group.useCount += Number(row.useCount) || 1;
    });
    var start=Math.max(0,Number(offset)||0);
    return Array.from(groups.values()).slice(start, start+Math.max(1, Math.min(200, Number(limit) || 20))).map(clone);
  }
  function removeHistory(recordId, options) {
    if (!options || options.confirm !== true) throw new Error('删除历史记录需要确认');
    var list = historyList(), index = list.findIndex(function (row) { return row.id === recordId; });
    var next = list.filter(function (row) { return row.id !== recordId; });
    saveHistory(next);
    // ⭐ 2026-10-22（docs/263 第 6 条「删了能撤销」）：把删掉的那条和原位置交回去，撤销时 restoreHistory 放回
    return { ok: true, deleted: list.length - next.length, removed: index >= 0 ? clone(list[index]) : null, index: index };
  }
  function restoreHistory(row, index) {
    if (!row || typeof row.id !== 'string' || typeof row.prompt !== 'string') throw new Error('要放回的记录无效');
    var list = historyList();
    if (list.some(function (item) { return item.id === row.id; })) return { ok: true, restored: 0 };
    var at = Math.max(0, Math.min(list.length, Number(index) || 0));
    list.splice(at, 0, row);
    saveHistory(list);
    return { ok: true, restored: 1 };
  }
  function reuseHistory(recordId, parts) {
    var row = historyList().find(function (item) { return item.id === recordId; });
    if (!row) throw new Error('历史记录已不存在');
    var result = {};
    if (parts && parts.prompt) result.prompt = row.prompt;
    if (parts && parts.preset) result.preset = { id: row.presetId || '', version: row.presetVersion || '', title: row.presetTitle || '' };
    if (parts && parts.model) result.model = { id: row.model || (row.parameters || {}).model || '', provider: row.provider || (row.parameters || {}).provider || '', protocol: row.protocol || (row.parameters || {}).protocol || '' };
    if (parts && parts.parameters) {
      result.parameters = {};
      if (row.workflowPresetId) result.workflowPresetId = row.workflowPresetId;
      Object.keys(row.parameters || {}).forEach(function (key) { if (!['provider', 'protocol', 'model'].includes(key)) result.parameters[key] = row.parameters[key]; });
    }
    return clone(result);
  }

  function readProjectList(name) {
    try {
      if (!root.localStorage) throw new Error('本机存储不可用');
      var raw = root.localStorage.getItem(storageKey(name));
      if (raw == null) return [];
      var list = JSON.parse(raw);
      if (!Array.isArray(list) || list.some(function (row) {
        if (!row || typeof row.id !== 'string' || !row.id) return true;
        if (name === 'projects') return !Array.isArray(row.items) || row.items.some(function (item) {
          return !item || typeof item.sourceRef !== 'string' || !item.sourceRef;
        });
        return typeof row.projectId !== 'string' || typeof row.sourceRef !== 'string';
      })) throw new Error('记录格式无效');
      return list;
    } catch (error) {
      throw Object.assign(new Error('项目记录读取失败，原记录已保留；请检查本机存储后重试：' + error.message), { code: 'PROJECT_READ_FAILED' });
    }
  }
  function projects() { return readProjectList('projects'); }
  function saveProjects(list) { if (!write('projects', list)) throw Object.assign(new Error('项目记录保存失败，请检查本机存储空间'), { code: 'PROJECT_SAVE_FAILED' }); }

  function createProject(name, metadata) {
    var title = safeText(name, 256, '项目名称');
    if (!title) throw new Error('项目名称不能为空');
    var now = new Date().toISOString();
    var project = { id: id('project'), name: title, status: 'active', metadata: metadata && typeof metadata === 'object' ? safeObject(metadata) : {}, items: [], createdAt: now, updatedAt: now };
    var list = projects(); if (list.length >= MAX_PROJECTS) throw new Error('项目已达 200 个，请先清理不再需要的本机项目记录');
    list.unshift(project); saveProjects(list); return clone(project);
  }

  function getProject(projectId) { return projects().find(function (item) { return item.id === projectId; }) || null; }

  function updateProject(projectId, patch) {
    var list = projects(); var project = list.find(function (item) { return item.id === projectId; });
    if (!project) throw new Error('项目不存在');
    patch = patch || {};
    if (patch.name != null) { project.name = safeText(patch.name, 256, '项目名称'); if (!project.name) throw new Error('项目名称不能为空'); }
    if (patch.status && ['active', 'completed', 'abandoned', 'archived'].indexOf(patch.status) >= 0) project.status = patch.status;
    if (patch.metadata && typeof patch.metadata === 'object') project.metadata = safeObject(patch.metadata);
    project.updatedAt = new Date().toISOString(); saveProjects(list); return clone(project);
  }

  function setProjectItem(projectId, sourceRef, patch) {
    var list = projects(); var project = list.find(function (item) { return item.id === projectId; });
    if (!project) throw new Error('项目不存在');
    var ref = safeText(sourceRef, 1024, '图片引用');
    if (!ref || /^data:/i.test(ref)) throw new Error('项目项必须使用图片管家引用');
    var item = project.items.find(function (entry) { return entry.sourceRef === ref; });
    if (!item) { item = { id: id('item'), sourceRef: ref, status: 'pending', note: '', updatedAt: new Date().toISOString() }; project.items.push(item); }
    patch = patch || {};
    if (patch.status && ['pending', 'completed', 'abandoned', 'exported', 'reworking'].indexOf(patch.status) >= 0) item.status = patch.status;
    if (patch.note != null) item.note = safeText(patch.note, 2000, '项目备注');
    if (patch.document && typeof patch.document === 'object') item.document = safeObject(patch.document);
    if (patch.eagleId != null) item.eagleId = safeText(patch.eagleId, 128, 'Eagle 图片编号');
    item.updatedAt = project.updatedAt = new Date().toISOString(); saveProjects(list); return clone(item);
  }

  function removeProjectItem(projectId, sourceRef, confirm) {
    if (confirm !== true) throw new Error('移除项目图片记录需要确认');
    var list = projects(), project = list.find(function (p) { return p.id === projectId; });
    if (!project) throw new Error('项目不存在');
    var index = project.items.findIndex(function (row) { return row.sourceRef === sourceRef; });
    var removed = index >= 0 ? clone(project.items[index]) : null;
    project.items = project.items.filter(function (row) { return row.sourceRef !== sourceRef; });
    project.updatedAt = new Date().toISOString(); saveProjects(list);
    // ⭐ 2026-10-22（docs/263 第 6 条「删了能撤销」）：交回删掉的那条和原位置
    return { ok: true, removed: removed, index: index };
  }
  function restoreProjectItem(projectId, item, index) {
    if (!item || typeof item.sourceRef !== 'string') throw new Error('要放回的项目记录无效');
    var list = projects(), project = list.find(function (p) { return p.id === projectId; });
    if (!project) throw new Error('项目已经不在了，这条记录放不回去');
    if (project.items.some(function (row) { return row.sourceRef === item.sourceRef; })) return { ok: true, restored: 0 };
    project.items.splice(Math.max(0, Math.min(project.items.length, Number(index) || 0)), 0, item);
    project.updatedAt = new Date().toISOString(); saveProjects(list); return { ok: true, restored: 1 };
  }
  function removeProject(projectId, confirm) {
    if (confirm !== true) throw new Error('删除项目记录需要确认');
    var list = projects(), index = list.findIndex(function (p) { return p.id === projectId; });
    var removed = index >= 0 ? clone(list[index]) : null;
    saveProjects(list.filter(function (p) { return p.id !== projectId; }));
    return { ok: true, removed: removed, index: index };
  }
  function restoreProject(project, index) {
    if (!project || typeof project.id !== 'string') throw new Error('要放回的项目无效');
    var list = projects();
    if (list.some(function (p) { return p.id === project.id; })) return { ok: true, restored: 0 };
    list.splice(Math.max(0, Math.min(list.length, Number(index) || 0)), 0, project);
    saveProjects(list); return { ok: true, restored: 1 };
  }
  function projectEvents() { return readProjectList('project.events'); }
  function queueProjectEvent(event) {
    var list = projectEvents(); if (list.some(function (row) { return row.id === event.id; })) return;
    list.push(safeObject(event));
    if (!write('project.events', list)) throw Object.assign(new Error('项目待确认事项保存失败'), { code: 'PROJECT_SAVE_FAILED' });
  }
  function resolveProjectEvent(eventId) {
    if (!write('project.events', projectEvents().filter(function (row) { return row.id !== eventId; }))) throw Object.assign(new Error('项目待确认事项保存失败'), { code: 'PROJECT_SAVE_FAILED' });
  }

  // ⭐ 2026-09-30 记录与恢复卡：间隔改成可传参（设置里能调 1–60 分钟）。
  //   ⚠ 间隔放到【第 4 个】参数，前三个不动 —— 老调用点（和现有测试）按三个参数传，
  //     不传就走默认 5 分钟，行为和改造前完全一致。
  function shouldCreateCheckpoint(lastCreatedAt, now, enabled, intervalMs) {
    if (!enabled) return false;
    var last = Number(lastCreatedAt || 0); var current = Number(now || Date.now());
    var span = Number(intervalMs) > 0 ? Number(intervalMs) : CHECKPOINT_INTERVAL_MS;
    return !last || current - last >= span;
  }

  function checkpoints() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(storageKey('checkpoints'));
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list) || list.some(function (item) { return !item || typeof item.cacheRef !== 'string'; })) throw new Error('检查点索引格式错误');
      return list;
    } catch (error) { throw Object.assign(new Error('检查点索引无法读取，旧记录已保留：' + error.message), { code: 'CHECKPOINT_INDEX_FAILED' }); }
  }
  function removeCheckpoint(cacheRef) {
    if (!write('checkpoints', checkpoints().filter(function (item) { return item.cacheRef !== cacheRef; }))) {
      throw Object.assign(new Error('检查点文件已清理，但索引更新失败；请检查本地存储空间'), { code: 'CHECKPOINT_INDEX_FAILED' });
    }
  }

  function saveCheckpoint(input) {
    input = input || {};
    var cacheRef = String(input.cacheRef == null ? '' : input.cacheRef).trim();
    if (!cacheRef || /^data:/i.test(cacheRef) || forbidden.test(cacheRef)) throw new Error('检查点必须使用缓存引用');
    var item = { id: id('checkpoint'), projectId: input.projectId ? safeText(input.projectId, 256, '项目') : null,
      documentRef: safeText(input.documentRef, 1024, '文档引用'), cacheRef: cacheRef,
      width: Number(input.width) || null, height: Number(input.height) || null, sizeBytes: Math.max(0, Number(input.sizeBytes) || 0),
      durationMs: Math.max(0, Number(input.durationMs) || 0), docName: safeText(input.docName, 256, '文档名称'),
      format: 'png', compression: 0,
      createdAt: new Date().toISOString() };
    var list = checkpoints(); list.unshift(item);
    if (!write('checkpoints', list)) {
      var storageError = new Error('PNG 已保存，但检查点索引写入失败；请检查本地存储空间');
      storageError.code = 'CHECKPOINT_INDEX_FAILED';
      throw storageError;
    }
    return clone(item);
  }

  root.V7ProductData = {
    addHistory: addHistory, searchHistory: searchHistory, recentPrompts: recentPrompts, removeHistory: removeHistory, restoreHistory: restoreHistory, reuseHistory: reuseHistory,
    projects: projects, createProject: createProject, getProject: getProject, updateProject: updateProject, setProjectItem: setProjectItem,
    removeProject: removeProject, removeProjectItem: removeProjectItem, restoreProject: restoreProject, restoreProjectItem: restoreProjectItem, projectEvents: projectEvents, queueProjectEvent: queueProjectEvent, resolveProjectEvent: resolveProjectEvent,
    shouldCreateCheckpoint: shouldCreateCheckpoint, saveCheckpoint: saveCheckpoint, checkpoints: checkpoints, removeCheckpoint: removeCheckpoint,
    intervalMs: CHECKPOINT_INTERVAL_MS
  };
})(window);
