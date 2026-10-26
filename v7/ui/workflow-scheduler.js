/* Client-side control plane for ComfyUI and RunningHub. Image bytes and
 * credentials stay in the provider/cache path; the backend receives only IDs.
 * Adapters and backend transport are injected so both desktop shells share
 * the same state transitions and tests can exercise the whole boundary. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7UnifiedScheduler = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function failure(code, message) { return Object.assign(new Error(message || code), { code }); }
  function normalizeProvider(value) {
    const provider = String(value || '').toLowerCase();
    return provider === 'rh' ? 'runninghub' : provider === 'comfy' ? 'comfyui' : provider;
  }
  function opaque(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const text = String(value);
    // Signed download URLs can contain credentials. They are never output IDs.
    if (text.length > 1024 || /[\x00\r\n]/.test(text) || /^(?:data:|https?:)/i.test(text)) {
      throw failure('OUTPUT_REFERENCE_INVALID', '输出必须使用缓存或供应商编号引用');
    }
    return text;
  }
  function outputMetadata(item, index) {
    const value = item && typeof item === 'object' ? item : {};
    const result = { index, status: 'succeeded', providerOutputId: opaque(value.providerOutputId || value.id || value.filename || value.name) || 'output-' + index };
    if (value.cacheRef) result.cacheRef = opaque(value.cacheRef);
    return result;
  }
  function outputItems(value) {
    if (Array.isArray(value)) return value;
    return value && (Array.isArray(value.outputs) ? value.outputs : Array.isArray(value.images) ? value.images : []) || [];
  }

  function createUnifiedScheduler(options = {}) {
    const backend = options.backend;
    if (!backend || !['quote', 'createTask', 'setProviderTask', 'recordTaskOutputs', 'cancelTask'].every(name => typeof backend[name] === 'function')) {
      throw failure('BACKEND_REQUIRED', '缺少报价、任务、上游编号、结果或取消接口');
    }
    const adapters = options.adapters || {};
    const cacheWriter = typeof options.cacheWriter === 'function' ? options.cacheWriter : null;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = options.now || (() => Date.now());
    const active = new Map(), byIdempotency = new Map();

    function assertActive(control) {
      if (control.cancelled || control.signal && control.signal.aborted) throw failure('TASK_CANCELLED', '任务已取消');
    }
    function progress(request, control, value) {
      if (typeof request.onProgress === 'function') {
        try { request.onProgress({ taskId: control.taskId, provider: control.provider, ...value }); } catch (_) {}
      }
    }
    async function cancelUpstream(control, adapter, request) {
      if (!control.providerTaskId || typeof adapter.cancel !== 'function') return { requested: false };
      return control.provider === 'runninghub'
        ? adapter.cancel(control.providerTaskId)
        : adapter.cancel({ ...request, signal: undefined, promptId: control.providerTaskId });
    }
    async function execute(request, idempotencyKey) {
      const provider = normalizeProvider(request.provider || request.route);
      const adapter = adapters[provider];
      if (!adapter || !['submit', 'poll'].every(name => typeof adapter[name] === 'function') || provider === 'comfyui' && typeof adapter.output !== 'function') {
        throw failure('ADAPTER_LIFECYCLE_INVALID', '生成适配器不完整');
      }
      if (!['comfyui', 'runninghub'].includes(provider)) throw failure('PROVIDER_UNSUPPORTED', '统一工作流调度尚未支持此渠道');
      const count = Number(request.requestedCount ?? request.batch ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 18) throw failure('TASK_COUNT_INVALID', '每批生成张数需要在 1 到 18 之间');
      const control = { taskId: '', provider, providerTaskId: '', cancelled: false, signal: request.signal, cancelPromise: null, request };
      assertActive(control);
      const quoted = await backend.quote(provider, count);
      const estimate = quoted && (quoted.estimate || quoted);
      if (typeof request.onQuote === 'function' && await request.onQuote(estimate) === false) {
        throw failure('QUOTE_DECLINED', '用户未确认本次费用');
      }
      assertActive(control);
      const charged = await backend.createTask({ idempotencyKey, route: provider, requestedCount: count,
        taskKind: request.taskKind || 'generation', presetId: request.presetId, presetVersion: request.presetVersion,
        sourceImageRef: request.sourceImageRef, photoshopSnapshotRef: request.photoshopSnapshotRef });
      const durableTask = charged && charged.task;
      if (!durableTask || !durableTask.id) throw failure('BACKEND_TASK_ID_MISSING', '后端未返回任务编号');
      control.taskId = String(durableTask.id);
      // A replay must never submit upstream again, even if its previous state
      // is ambiguous after a crash. Resume/reconcile is a separate operation.
      if (charged.created !== true) return { taskId: control.taskId, existing: true, estimate, task: durableTask, outputs: durableTask.outputs || [] };
      active.set(control.taskId, control);
      let outputRecorded = false, values = [];
      try {
        assertActive(control);
        progress(request, control, { status: 'charged', estimate });
        let executionRequest = { ...request };
        if (typeof adapter.prepare === 'function') executionRequest = await adapter.prepare(executionRequest);
        assertActive(control);
        const submitted = provider === 'runninghub'
          ? await adapter.submit(executionRequest.workflow || {}, executionRequest.input || {})
          : await adapter.submit({ ...executionRequest, prompt: executionRequest.prompt || executionRequest.apiPrompt || executionRequest.workflowPrompt || executionRequest.workflow });
        control.providerTaskId = String(submitted && (submitted.promptId || submitted.taskId || submitted.id) || '');
        if (!control.providerTaskId) throw failure('PROVIDER_TASK_ID_MISSING', '生成服务没有返回任务编号');
        if (control.cancelled) {
          await cancelUpstream(control, adapter, request);
          assertActive(control);
        }
        await backend.setProviderTask(control.taskId, control.providerTaskId);
        progress(request, control, { status: 'running', providerTaskId: control.providerTaskId });
        if (provider === 'comfyui') {
          const pollArgs = { ...executionRequest, comfyUrl: submitted.baseUrl || request.comfyUrl || request.baseUrl, promptId: control.providerTaskId,
            onProgress: value => progress(request, control, value) };
          const completed = await adapter.poll(pollArgs);
          assertActive(control);
          values = await adapter.output({ ...pollArgs, images: completed.images || [], history: completed.history });
        } else {
          const timeout = Math.max(1, Number(request.timeoutMs || options.timeoutMs || 3600000));
          const started = now();
          while (true) {
            assertActive(control);
            if (now() - started >= timeout) throw failure('PROVIDER_TIMEOUT', '生成服务等待超时');
            const result = await adapter.poll(control.providerTaskId);
            progress(request, control, { status: result.status || 'running' });
            if (result.done) {
              if (result.ok === false) throw failure('PROVIDER_EXECUTION_FAILED', '生成服务执行失败');
              values = outputItems(result);
              break;
            }
            await sleep(Math.max(0, Number(request.pollIntervalMs ?? options.pollIntervalMs ?? 1000)));
          }
        }
        assertActive(control);
        const records = [], cacheErrors = [];
        for (let index = 0; index < values.length; index += 1) {
          let item = values[index];
          // A local cache failure must not falsify the upstream success count.
          if (cacheWriter) {
            try { item = { ...item, ...(await cacheWriter(item, { taskId: control.taskId, provider, index })) }; }
            catch (error) { cacheErrors.push({ index, code: 'CACHE_WRITE_FAILED', message: String(error.message || error) }); }
          }
          records.push(outputMetadata(item, index));
        }
        for (let index = values.length; index < count; index += 1) records.push({ index, status: 'failed', errorCode: 'OUTPUT_NOT_RETURNED' });
        const recorded = await backend.recordTaskOutputs(control.taskId, records);
        outputRecorded = true;
        if (!values.length) throw failure('NO_OUTPUTS', '生成服务未返回图片');
        progress(request, control, { status: values.length >= count ? 'succeeded' : 'partial', count: values.length });
        return { taskId: control.taskId, provider, estimate, providerTaskId: control.providerTaskId,
          outputs: records, images: values, cacheErrors, task: recorded && recorded.task };
      } catch (error) {
        if (control.cancelled || error.code === 'TASK_CANCELLED') {
          if (!control.cancelPromise) await backend.cancelTask(control.taskId);
        } else if (!outputRecorded) {
          try { await backend.recordTaskOutputs(control.taskId, Array.from({ length: count }, (_, index) => ({ index, status: 'failed', errorCode: String(error.code || 'PROVIDER_FAILED') }))); }
          catch (recordError) { error.recordError = recordError; }
        }
        progress(request, control, { status: control.cancelled ? 'cancelled' : 'failed', code: error.code || 'PROVIDER_FAILED' });
        throw error;
      } finally { active.delete(control.taskId); }
    }

    function run(request = {}) {
      const key = String(request.idempotencyKey || ('v7-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)));
      if (byIdempotency.has(key)) return byIdempotency.get(key);
      const promise = execute(request, key).finally(() => byIdempotency.delete(key));
      byIdempotency.set(key, promise);
      return promise;
    }
    async function cancel(taskId) {
      const key = String(taskId || ''), control = active.get(key);
      if (!control) return backend.cancelTask(key);
      if (control.cancelPromise) return control.cancelPromise;
      control.cancelled = true;
      control.cancelPromise = (async () => {
        let upstream, upstreamError;
        try { upstream = await cancelUpstream(control, adapters[control.provider], control.request); }
        catch (error) { upstreamError = String(error.code || 'UPSTREAM_CANCEL_FAILED'); }
        // Even if the supplier cannot cancel, the local task must stop and the
        // durable record must preserve the user's cancel intent.
        const durable = await backend.cancelTask(key);
        return { taskId: key, cancelled: true, upstream, upstreamError, task: durable && durable.task };
      })();
      return control.cancelPromise;
    }
    return Object.freeze({ run, cancel, active });
  }
  return { createUnifiedScheduler, outputMetadata, outputItems };
});
