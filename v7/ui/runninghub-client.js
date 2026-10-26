/* RunningHub official OpenAPI contract, verified against the 2026-09-21
 * documentation saved in docs/references/runninghub. A custom bridge may
 * opt into protocol:'bridge'; ordinary RH connections use official routes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7RunningHub = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function createRunningHubAdapter(options = {}) {
    const base = String(options.baseUrl || 'https://www.runninghub.cn').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new Error('RH_BASE_URL_INVALID');
    const token = String(options.token || ''), request = options.request;
    if (typeof request !== 'function') throw new Error('RH_TRANSPORT_REQUIRED');
    const bridge = options.protocol === 'bridge';
    const paths = { ...(bridge ? { submit:'/v1/workflows/run', status:'/v1/tasks/{id}', cancel:'/v1/tasks/{id}/cancel', test:'/v1/health' }
      : { submit:'/task/openapi/create', status:'/openapi/v2/query', cancel:'/task/openapi/cancel', test:'/uc/openapi/accountStatus', workflow:'/api/openapi/getJsonApiFormat' }), ...options.paths };
    async function call(name, body, taskId) {
      const path = paths[name].replace('{id}', encodeURIComponent(String(taskId || '')));
      const response = await request({ method: bridge && ['status','test'].includes(name) ? 'GET' : 'POST',
        url: base + '/' + path.replace(/^\/+/, ''), headers: token ? { Authorization: 'Bearer ' + token } : {}, body });
      if (response && response.code !== undefined && Number(response.code) !== 0) throw Object.assign(new Error('RH 返回错误 '+response.code), { code:'RH_PROVIDER_ERROR', providerCode:response.code });
      return response;
    }
    async function submit(workflow, input = {}) {
      const config = workflow || {};
      if (!bridge && !config.workflowId) throw Object.assign(new Error('请填写 RH 工作流编号'), { code:'RH_WORKFLOW_ID_REQUIRED' });
      const body = bridge ? { workflow, input, client:'wheelchair-v7' }
        : { apiKey:token, workflowId:String(config.workflowId), nodeInfoList:input.nodeInfoList || config.nodeInfoList || [] };
      if (!bridge && config.instanceType) body.instanceType = config.instanceType;
      const raw = await call('submit', body), data = raw.data || raw;
      const taskId = data.taskId || data.id;
      if (!taskId) throw Object.assign(new Error('RH 未返回任务编号'), { code:'RH_TASK_ID_MISSING' });
      return { taskId:String(taskId) };
    }
    async function poll(taskId) {
      const raw = await call('status', bridge ? undefined : { taskId:String(taskId) }, taskId), data = raw.data || raw;
      const status = String(data.status || data.state || 'running').toLowerCase();
      return { taskId:String(taskId), status, done:['success','succeeded','completed','done','failed','error','cancelled','canceled'].includes(status),
        ok:!['failed','error','cancelled','canceled'].includes(status), outputs:(data.results || data.outputs || []).filter(item => !item.outputType || /^(png|jpg|jpeg|webp)$/i.test(item.outputType)) };
    }
    async function cancel(taskId) { return call('cancel', bridge ? {} : { apiKey:token, taskId:String(taskId) }, taskId); }
    async function testConnection() { const result = await call('test', bridge ? undefined : { apikey:token }); return { ok:true, account:result.data || result }; }
    async function getWorkflow(workflowId) {
      const result = await call('workflow', { apiKey:token, workflowId:String(workflowId) });
      const raw = result.data && result.data.prompt;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    return Object.freeze({ provider:'runninghub', submit, poll, cancel, testConnection, getWorkflow });
  }
  return { createRunningHubAdapter };
});
