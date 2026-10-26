/* Shared Electron/Tauri workflow path. Uses only uiwin.http, so API keys stay
 * in the desktop's current session. Official GPU execution uses a one-use
 * ticket; own/local computation never creates a platform charge. */
(function (root) {
  'use strict';
  const active = new Map();
  const error = (code, message) => Object.assign(new Error(message || code), { code });
  const normalize = value => /^(?:rh|runninghub)$/i.test(value) ? 'runninghub' : /^(?:comfy|comfyui|forge)$/i.test(value) ? 'comfyui' : '';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const resourceInputs = new Set(['ckpt_name','unet_name','lora_name','sampler_name','scheduler']);
  function transientBinding(binding) {
    return binding.type === 'string' && !resourceInputs.has(binding.input) &&
      (/prompt/i.test(String(binding.key)) || binding.source === 'prompt' || binding.editor === 'textarea' || binding.transient === true);
  }
  async function http(options) {
    const reply = await root.uiwin.http.fetch(options);
    if (options.responseType === 'base64') { if (!reply.ok) throw error('WORKFLOW_HTTP_ERROR', '输出图下载失败'); return reply.body; }
    let data; try { data = JSON.parse(reply.body || '{}'); } catch (_) { throw error('WORKFLOW_RESPONSE_INVALID', '工作流接口返回了无效数据'); }
    // ⭐ 2026-10-24（V7待办/10）：算力机执行器现在会带 detail（真实原因，脱敏过）。原来只有一句「工作流执行未完成」，
    //   用户和我们都看不到为什么。detail 拼进报错原文（报错卡、「反馈这个问题」都会带上），另挂 .detail 给调用方。
    if (!reply.ok) {
      const detail = typeof data.detail === 'string' ? data.detail.slice(0, 500) : '';
      throw Object.assign(error(data.code || 'WORKFLOW_HTTP_ERROR', (data.message || '工作流服务请求失败') + (detail ? '。原因：' + detail : '')), detail ? { detail } : {});
    }
    return data;
  }
  // ⭐ 2026-10-21（用户：「前方排队和云端计算的当前进度条」）：云端那一单跑着时，每 1.5 秒问后台一次进度
  //   （算力机从 ComfyUI 长连接拿到 → 报给后台，见 foundation/engine/comfy-progress.js），交给 onProgress。
  //   ⚠ 问不到 / 后台还是旧版没有 progress ⇒ 什么都不报，任务卡照旧「工作流 · 处理中」。
  function cloudProgressText(p) {
    if (p.phase === 'queued') return p.ahead > 0 ? '云端排队 · 前面还有 ' + p.ahead + ' 单' : '云端排队中';
    if (p.phase === 'done') return '云端算完 · 正在取图';
    if (p.max > 0) return '云端 · ' + (p.segments > 1 ? '第 ' + p.segment + '/' + p.segments + ' 段 · ' : '') + (p.label || '计算') + ' ' + p.value + '/' + p.max;
    return '云端计算中';
  }
  function watchCloudProgress(taskId, onProgress, intervalMs) {
    const B = root.V7Backend;
    if (typeof onProgress !== 'function' || !B || typeof B.getTask !== 'function' || !taskId) return () => {};
    let stopped = false, busy = false, last = '';
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const reply = await B.getTask(taskId), p = reply && reply.progress;
        if (!stopped && p && typeof p === 'object') {
          const text = cloudProgressText(p), sig = text + '|' + p.fraction;
          if (sig !== last) { last = sig; onProgress({ status: text, cloudProgress: p }); }
        }
      } catch (_) { /* 问不到就下一轮再问，不影响出图 */ }
      finally { busy = false; }
    };
    const timer = setInterval(tick, intervalMs || 1500);
    const first = setTimeout(tick, Math.min(600, intervalMs || 600));
    return () => { stopped = true; clearInterval(timer); clearTimeout(first); };
  }
  function baseUrl(value) {
    let url; try { url = new URL(String(value || '')); } catch (_) { throw error('AI_URL_MISSING', '请先填写工作流服务地址'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw error('WORKFLOW_URL_INVALID', '工作流地址格式无效');
    return url.href.replace(/\/+$/, '');
  }
  function bytes64(bytes) { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); }
  function multipart(base64, field = 'image', mime = 'image/png') {
    if(!/^image\/(png|jpeg|webp)$/.test(mime))throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED','参考图格式无效');
    const boundary = '----wheelchair-' + Date.now().toString(36);
    const prefix = new TextEncoder().encode('--' + boundary + '\r\nContent-Disposition: form-data; name="'+field+'"; filename="capture.'+mime.split('/')[1]+'"\r\nContent-Type: '+mime+'\r\n\r\n');
    const suffix = new TextEncoder().encode('\r\n--' + boundary + '--\r\n');
    const raw = atob(String(base64).replace(/^data:[^,]+,/, ''));
    const bytes = new Uint8Array(prefix.length + raw.length + suffix.length);
    bytes.set(prefix); for (let i = 0; i < raw.length; i++) bytes[prefix.length + i] = raw.charCodeAt(i); bytes.set(suffix, prefix.length + raw.length);
    return { boundary, body: bytes64(bytes) };
  }
  function coerceBindingValue(binding, value, fallback) {
    if (value === undefined || value === null || binding.type === 'number' && value === '') value = fallback;
    if (binding.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      const min = Number.isFinite(Number(binding.min)) ? Number(binding.min) : -Infinity;
      const max = Number.isFinite(Number(binding.max)) ? Number(binding.max) : Infinity;
      return Math.max(min, Math.min(max, n));
    }
    if (binding.type === 'boolean') return value === true || value === 'true';
    return value === undefined ? undefined : String(value == null ? '' : value);
  }
  // Catalog entries historically stored the API prompt under `workflow` and
  // kept mappings beside it. RH imports use a wrapper with `prompt` instead.
  // Normalize both forms before any adapter touches the graph so a preset
  // switch cannot leave bindings from the previous preset behind.
  function normalizeWorkflowConfig(value, extras) {
    const source = value && typeof value === 'object' ? value : {};
    const looksLikePrompt = Object.keys(source).some(key => {
      const node = source[key]; return node && typeof node === 'object' && node.class_type && node.inputs;
    });
    const config = looksLikePrompt
      ? { prompt: source }
      : { ...source };
    if (!config.prompt && config.apiPrompt) config.prompt = config.apiPrompt;
    if (!config.prompt && config.workflow && typeof config.workflow === 'object') {
      const nested = normalizeWorkflowConfig(config.workflow);
      config.prompt = nested.prompt;
      ['inputNodeIds','referenceNodeIds','outputNodeIds','promptBindings','parameterBindings','batchBinding','nodeInfoList','inputMode'].forEach(key => {
        if (config[key] == null && nested[key] != null) config[key] = nested[key];
      });
    }
    const add = extras && typeof extras === 'object' ? extras : {};
    ['inputNodeIds','referenceNodeIds','outputNodeIds','promptBindings','parameterBindings','batchBinding','nodeInfoList','inputMode','workflowId'].forEach(key => {
      if (add[key] != null) config[key] = add[key];
    });
    config.inputNodeIds = Array.isArray(config.inputNodeIds) ? config.inputNodeIds.map(String) : [];
    config.referenceNodeIds = Array.isArray(config.referenceNodeIds) ? config.referenceNodeIds.map(String) : [];
    config.outputNodeIds = Array.isArray(config.outputNodeIds) ? config.outputNodeIds.map(String) : [];
    config.promptBindings = Array.isArray(config.promptBindings) ? config.promptBindings : [];
    config.parameterBindings = Array.isArray(config.parameterBindings) ? config.parameterBindings : [];
    return config;
  }
  // Persistence copies retain ordinary controls but never credentials or embedded image bytes.
  function persistentParameters(parameters, workflow, extras) {
    const config = normalizeWorkflowConfig(workflow, extras);
    const sensitive = new Set(config.parameterBindings.filter(b => b && b.sensitive).map(b => String(b.key)));
    const secretName = /^(?:key|token)$|api.?key|access.?token|refresh.?token|password|secret|authorization|credential|base64|image.?bytes/i;
    const imageValue = /^(?:data:|blob:)|^(?:iVBORw0KGgo|\/9j\/|UklGR)[A-Za-z0-9+/=\s]{40,}$|^[A-Za-z0-9+/=\s]{1024,}$/i;
    const secretValue = /\bsk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[^\s"']{8,}/i;
    let budget = 65536;
    function copy(value, key, depth) {
      if (depth > 8 || sensitive.has(key) || secretName.test(key) || ['__proto__','constructor','prototype'].includes(key)) return undefined;
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value === 'string') {
        if (value.length > 20000 || imageValue.test(value) || secretValue.test(value)) return undefined;
        if (/^https?:/i.test(value)) {
          try { const url = new URL(value); if (url.username || url.password || [...url.searchParams.keys()].some(k => secretName.test(k))) return undefined; } catch (_) { return undefined; }
        }
        budget -= value.length + key.length;
        return budget >= 0 ? value : undefined;
      }
      if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Object.prototype.toString.call(value) !== '[object Object]' && !Array.isArray(value)) return undefined;
      if (Array.isArray(value)) return value.length <= 256 ? value.map(v => copy(v, '', depth + 1)).filter(v => v !== undefined) : undefined;
      const out = {};
      for (const name of Object.keys(value).slice(0, 256)) {
        budget -= name.length + 8;
        if (budget < 0) break;
        const next = copy(value[name], name, depth + 1);
        if (next !== undefined) out[name] = next;
      }
      return out;
    }
    return copy(parameters || {}, '', 0) || {};
  }
  function applyParameterBindings(prompt, config, params, promptText) {
    for (const binding of config.parameterBindings || []) {
      const node = prompt[String(binding.nodeId)];
      if (!node || !node.inputs) throw error('WORKFLOW_MAPPING_REQUIRED', '找不到参数映射节点 ' + String(binding.nodeId));
      // The visible prompt is the single source of truth for positivePrompt.
      // Do not let the imported default overwrite text the user just edited.
      const fallback = binding.source === 'prompt' || binding.key === 'positivePrompt' ? promptText : binding.default !== undefined ? binding.default : node.inputs[binding.input];
      const raw = binding.key === 'positivePrompt' ? promptText : params && params[binding.key];
      const value = coerceBindingValue(binding, raw, fallback);
      if (value !== undefined) {
        node.inputs[binding.input] = value;
        // Aki's LoRA and resolution controls expose two mirrored inputs. The
        // preset keeps one user-facing value, then applies it to both sides.
        for (const input of binding.mirrorInputs || []) node.inputs[input] = value;
      }
    }
  }
  function applyPromptBindings(prompt, config, promptText) {
    for (const binding of config.promptBindings || []) {
      const node = prompt[String(binding.nodeId)];
      if (!node || !node.inputs) {
        throw error('WORKFLOW_MAPPING_REQUIRED', '找不到工作流提示词节点 ' + String(binding.nodeId));
      }
      node.inputs[binding.input || 'text'] = promptText;
    }
  }
  function batchBindingOf(config) {
    if (config.batchBinding) return config.batchBinding;
    const binding = config.parameterBindings.find(item => item && /^(?:imageCount|batch|count)$/i.test(String(item.key)));
    return binding ? { nodeId: String(binding.nodeId), input: binding.input } : null;
  }
  function resolveParameters(config, parameters, promptText, batch, random) {
    const next = { ...(parameters || {}) };
    for (const binding of config.parameterBindings || []) {
      const raw = binding.source === 'prompt' || binding.key === 'positivePrompt' ? promptText
        : /^(imageCount|batch|count)$/.test(binding.key) ? batch : next[binding.key];
      const nodeValue = config.prompt && config.prompt[String(binding.nodeId)] && config.prompt[String(binding.nodeId)].inputs[binding.input];
      let value = coerceBindingValue(binding, raw, binding.default !== undefined ? binding.default : nodeValue);
      if (binding.randomizeWhen !== undefined && value === binding.randomizeWhen) {
        const sample = typeof random === 'function' ? random() : Math.random();
        value = Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, sample)) * Number.MAX_SAFE_INTEGER);
      }
      if (value !== undefined) next[binding.key] = value;
    }
    return next;
  }
  function platformReferences(value = []) {
    if (!Array.isArray(value) || value.length > 12) throw error('WORKFLOW_REFERENCE_LIMIT', '参考图最多支持 12 张');
    let total = 0;
    return Array.from(value, ref => {
      let base64 = typeof ref === 'string' ? ref : ref?.imageBase64 || ref?.base64;
      let mime = typeof ref === 'object' ? ref?.mime : '';
      if (typeof base64 !== 'string') throw error('WORKFLOW_REFERENCE_INVALID', '参考图数据无效');
      if (base64.startsWith('data:')) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(base64);
        if (!match || mime && mime !== match[1]) throw error('WORKFLOW_REFERENCE_INVALID', '参考图格式无效');
        mime = match[1]; base64 = match[2];
      }
      mime = mime || 'image/png';
      if (!/^image\/(?:png|jpeg|webp)$/.test(mime) || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) throw error('WORKFLOW_REFERENCE_INVALID', '参考图格式或数据无效');
      if (base64.length > 128 * 1024 * 1024) throw error('WORKFLOW_REFERENCE_LIMIT', '参考图总大小不能超过 96 MiB');
      let bytes;
      try { bytes = atob(base64); } catch (_) { throw error('WORKFLOW_REFERENCE_INVALID', '参考图编码无效'); }
      if (!bytes.length || btoa(bytes).replace(/=+$/, '') !== base64.replace(/=+$/, '')) throw error('WORKFLOW_REFERENCE_INVALID', '参考图编码无效');
      total += bytes.length;
      if (total > 96 * 1024 * 1024) throw error('WORKFLOW_REFERENCE_LIMIT', '参考图总大小不能超过 96 MiB');
      return { base64, mime };
    });
  }
  function validateReferences(p,config=normalizeWorkflowConfig(p.workflow,p.workflowMeta)){
    if (p.computeSource === 'platform') return platformReferences(p.refImages);
    const refs=p.refImages||[],nodes=config.referenceNodeIds||[];
    if(refs.length!==nodes.length)throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED','参考图数量与工作流图片映射不一致，请在参考图片中设置图片节点');
    if(!refs.length)return;
    if(new Set(nodes).size!==nodes.length||nodes.some(id=>config.inputNodeIds.includes(id)))throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED','参考图节点不能重复或覆盖 Photoshop 主图节点');
    for(let index=0;index<refs.length;index++){
      const node=config.prompt?.[nodes[index]],ref=refs[index];
      if(!node?.inputs||!Object.prototype.hasOwnProperty.call(node.inputs,'image')||Array.isArray(node.inputs.image))throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED','找不到可写入参考图的图片节点：'+nodes[index]);
      if(!String(typeof ref==='string'?ref:ref?.imageBase64||ref?.base64||''))throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED','参考图数据缺失');
      if((config.parameterBindings||[]).some(binding=>String(binding.nodeId)===nodes[index]&&[binding.input,...binding.mirrorInputs||[]].includes('image'))||(config.promptBindings||[]).some(binding=>String(binding.nodeId)===nodes[index]&&binding.input==='image'))throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED','参考图图片节点与参数映射冲突');
    }
  }
  function comfyAdapter(p, config, guard=()=>{}) {
    const request=async options=>{guard();const value=await http(options);guard();return value;};
    const base = baseUrl(p.baseUrl), promptIds = new Set();
    const authorization = p.apiKey ? {Authorization:'Bearer '+p.apiKey} : {};
    const call = (path, method = 'GET', body) => request({ url: base + path, method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...authorization } });
    const cancelCall=(path,method='GET',body)=>http({url:base+path,method,body:body===undefined?undefined:JSON.stringify(body),headers:{'Content-Type':'application/json',...authorization}});
    async function cancelPrompt(promptId){
      promptIds.delete(promptId);const queue=await cancelCall('/queue');
      if((queue.queue_running||[]).some(item=>String(item[1])===promptId))await cancelCall('/interrupt','POST',{});
      else if((queue.queue_pending||[]).some(item=>String(item[1])===promptId))await cancelCall('/queue','POST',{delete:[promptId]});
      return {cancelled:true};
    }
    return {
      async prepare(args) {
        const prompt = JSON.parse(JSON.stringify(config.prompt || config.apiPrompt || {}));
        if (!Object.keys(prompt).length || prompt.nodes) throw error('WORKFLOW_API_PROMPT_REQUIRED', '请导入 API 格式工作流并配置映射节点');
        if (p.inputImageBase64) {
          if (!Array.isArray(config.inputNodeIds) || !config.inputNodeIds.length) throw error('WORKFLOW_MAPPING_REQUIRED', '工作流未指定 Photoshop 输入节点');
          const part = multipart(p.inputImageBase64);
          const uploaded = await request({ url: base + '/upload/image', method: 'POST', body: part.body, bodyEncoding: 'base64', headers: { 'Content-Type': 'multipart/form-data; boundary=' + part.boundary, ...authorization } });
          for (const nodeId of config.inputNodeIds) {
            if (!prompt[String(nodeId)]?.inputs) throw error('WORKFLOW_MAPPING_REQUIRED', '找不到工作流输入节点');
            prompt[String(nodeId)].inputs.image = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name;
          }
        }
        for(let index=0;index<(p.refImages||[]).length;index++){
          const ref=p.refImages[index],part=multipart(typeof ref==='string'?ref:ref.imageBase64||ref.base64,'image',ref.mime||'image/png');
          const uploaded=await request({url:base+'/upload/image',method:'POST',body:part.body,bodyEncoding:'base64',headers:{'Content-Type':'multipart/form-data; boundary='+part.boundary,...authorization}});
          if(!uploaded.name)throw error('WORKFLOW_HTTP_ERROR','参考图上传未返回文件名');
          prompt[config.referenceNodeIds[index]].inputs.image=uploaded.subfolder?uploaded.subfolder+'/'+uploaded.name:uploaded.name;
        }
        applyPromptBindings(prompt, config, p.prompt);
        applyParameterBindings(prompt, config, p.workflowParameters || {}, p.prompt);
        const batchBinding = batchBindingOf(config);
        if (batchBinding) {
          const batchNode = prompt[String(batchBinding.nodeId)];
          if (!batchNode || !batchNode.inputs) throw error('WORKFLOW_MAPPING_REQUIRED', '找不到工作流张数映射节点');
          batchNode.inputs[batchBinding.input] = Number(p.batch) || 1;
        }
        else if (Number(p.batch) > 1) throw error('WORKFLOW_BATCH_UNSUPPORTED', '工作流没有张数映射，请使用 1 张或补全映射');
        return { ...args, prompt };
      },
      async submit(args) {guard();const value=await cancelCall('/prompt','POST',{prompt:args.prompt});if(!value.prompt_id)throw error('PROVIDER_TASK_ID_MISSING');promptIds.add(value.prompt_id);try{guard();}catch(failure){await cancelPrompt(value.prompt_id);throw failure;}return {promptId:value.prompt_id,baseUrl:base};},
      async poll(args) {
        const started = Date.now();
        while (Date.now() - started < 570000) {
          if (!promptIds.has(args.promptId)) throw error('TASK_CANCELLED');
          const entries = await call('/history/' + encodeURIComponent(args.promptId)), entry = entries[args.promptId];
          if (entry?.status?.status_str === 'error') throw error('COMFY_EXECUTION_ERROR', 'ComfyUI 节点执行失败');
          if (entry?.status?.completed || entry?.status?.status_str === 'success') {
            const images = [];
            for (const id of config.outputNodeIds || []) for (const image of entry.outputs?.[String(id)]?.images || []) images.push({ ...image, nodeId: String(id) });
            return { images, history: entry };
          }
          await wait(1000);
        }
        throw error('PROVIDER_TIMEOUT', '工作流等待超时');
      },
      async output(args) { const output = []; for (const image of args.images) { const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' }); output.push({ ...image, base64: await request({ url: base + '/view?' + query, headers:authorization, responseType: 'base64' }), mime: 'image/png' }); } return output; },
      async cancel(args) {
        return cancelPrompt(args.promptId);
      }
    };
  }
  function rhAdapter(p, config, guard=()=>{}) {
    const request=async options=>{guard();const value=await http(options);guard();return value;};
    const base = baseUrl(p.baseUrl);
    if (!p.apiKey) throw error('RH_KEY_REQUIRED', '请先填写自己的 RH API Key');
    const adapter = root.V7RunningHub.createRunningHubAdapter({ baseUrl:base, token:p.apiKey,
      request:req=>{const options={...req,headers:{'Content-Type':'application/json',...req.headers},body:req.body===undefined?undefined:JSON.stringify(req.body)};if(req.url.endsWith('/cancel'))return http(options);if(req.url.endsWith('/create')){guard();return http(options);}return request(options);} });
    return { ...adapter, async submit(workflow,input){guard();const result=await adapter.submit(workflow,input);try{guard();}catch(failure){await adapter.cancel(result.taskId);throw failure;}return result;},async prepare(args) {
      const nodeInfoList = JSON.parse(JSON.stringify(config.nodeInfoList || []));
      for (const binding of config.promptBindings || []) nodeInfoList.push({ nodeId:String(binding.nodeId), fieldName:binding.input||'text', fieldValue:p.prompt });
      for (const binding of config.parameterBindings || []) {
        const raw = binding.key === 'positivePrompt' || binding.source === 'prompt' ? p.prompt : p.workflowParameters && p.workflowParameters[binding.key];
        const val = coerceBindingValue(binding, raw, binding.default);
        if (val !== undefined) for (const input of [binding.input, ...(binding.mirrorInputs || [])]) {
          nodeInfoList.push({ nodeId:String(binding.nodeId), fieldName:input, fieldValue:val });
        }
      }
      if (p.inputImageBase64 && config.inputMode !== 'none') {
        if (!config.inputNodeIds?.length) throw error('WORKFLOW_MAPPING_REQUIRED', 'RH 预设需要指定 Photoshop 图片的输入节点');
        const part = multipart(p.inputImageBase64, 'file');
        const response = await request({ url:base+'/openapi/v2/media/upload/binary', method:'POST', body:part.body, bodyEncoding:'base64',
          headers:{ 'Content-Type':'multipart/form-data; boundary='+part.boundary, Authorization:'Bearer '+p.apiKey } });
        if (response.code !== 0 || !response.data?.fileName) throw error('RH_UPLOAD_FAILED', 'RH 图片上传失败');
        for (const id of config.inputNodeIds) nodeInfoList.push({ nodeId:String(id), fieldName:'image', fieldValue:response.data.fileName });
      }
      for(let index=0;index<(p.refImages||[]).length;index++){
        const ref=p.refImages[index],part=multipart(typeof ref==='string'?ref:ref.imageBase64||ref.base64,'file',ref.mime||'image/png');
        const response=await request({url:base+'/openapi/v2/media/upload/binary',method:'POST',body:part.body,bodyEncoding:'base64',headers:{'Content-Type':'multipart/form-data; boundary='+part.boundary,Authorization:'Bearer '+p.apiKey}});
        if(response.code!==0||!response.data?.fileName)throw error('RH_UPLOAD_FAILED','RH 参考图上传失败');
        nodeInfoList.push({nodeId:config.referenceNodeIds[index],fieldName:'image',fieldValue:response.data.fileName});
      }
      const batchBinding = batchBindingOf(config);
      if (batchBinding) {
        nodeInfoList.push({ nodeId:String(batchBinding.nodeId), fieldName:batchBinding.input, fieldValue:Number(p.batch)||1 });
      }
      else if (Number(p.batch)>1) throw error('WORKFLOW_BATCH_UNSUPPORTED', '请使用一张或配置 RH 工作流张数映射');
      const deduplicated = new Map(nodeInfoList.map(item => [String(item.nodeId) + ':' + item.fieldName, item]));
      return { ...args, workflow:config, input:{nodeInfoList:Array.from(deduplicated.values())} };
    } };
  }
  function billingParameters(p, config = normalizeWorkflowConfig(p.workflow, p.workflowMeta)) {
    const result = {};
    for (const binding of config.parameterBindings || []) {
      if (transientBinding(binding)) continue;
      const value = /^(imageCount|batch|count)$/.test(binding.key) ? p.batch : p.workflowParameters && p.workflowParameters[binding.key];
      if (value !== undefined) result[binding.key] = value;
    }
    return result;
  }
  async function generate(p, task, hooks = {}) {
    const guard=()=>hooks.guard?.();guard();
    p = { ...p };
    const provider = normalize(p.provider), config = normalizeWorkflowConfig(p.workflow, p.workflowMeta);
    if (provider === 'runninghub') p.computeSource = 'own';
    if (!provider) throw error('WORKFLOW_PROVIDER_INVALID');
    if (p.workflowNeedsReview) throw error('WORKFLOW_REVIEW_REQUIRED', '此预设的 Forge 迁移工作流尚未验证');
    const references = validateReferences(p,config);
    if (p.computeSource === 'platform') {
      // The account service stores billing inputs only. Prompt text stays on
      // the execution path between the desktop and GPU worker.
      const chargedParameters = billingParameters(p, config);
      if (!root.V7Backend.state().signedIn) throw error('PLATFORM_LOGIN_REQUIRED', '请先登录平台账号');
      const available = await root.V7Backend.workflowAvailability(p.platformPresetId || p.presetId, provider, p.batch, references.length);
      guard();
      if (references.length && (available?.referenceInput?.version !== 1 || available.referenceInput.count !== references.length)) throw error('WORKFLOW_REFERENCE_UNSUPPORTED', '平台未提供与本次参考图匹配的输入能力，本次未扣费');
      if (available?.referenceInput && available.referenceInput.count !== references.length) throw error('WORKFLOW_REFERENCE_COUNT_MISMATCH', '参考图数量与平台预设不一致，本次未扣费');
      // 千问一张一单：带上「这一组的编号 + 一共几张」，后台按账号核对一次最多几张（2026-10-16）
      const group = p.qwenGroup && p.qwenGroup.id ? { group: { id: String(p.qwenGroup.id), size: Number(p.qwenGroup.size) || 1 } } : {};
      const quoted = await root.V7Backend.quote(provider, p.batch, { presetId:p.platformPresetId || p.presetId, workflowParameters:chargedParameters, referenceCount:references.length, ...group });
      guard();
      const quotedContract = quoted.estimate.workflowReferenceContract;
      if (references.length && (quotedContract?.version !== 1 || !Array.isArray(quotedContract.referenceNodeIds) || quotedContract.referenceNodeIds.length !== references.length || !Array.isArray(quotedContract.inputNodeIds))) throw error('WORKFLOW_REFERENCE_UNSUPPORTED', '平台报价未绑定本次参考图输入，本次未扣费');
      if (references.length && quotedContract.inputNodeIds.length && !p.inputImageBase64) throw error('WORKFLOW_REFERENCE_MAPPING_REQUIRED', '平台预设需要 Photoshop 主图，本次未扣费');
      if (hooks.confirm && await hooks.confirm(quoted.estimate) !== true) throw error('QUOTE_DECLINED', '已取消本次生成');
      guard();
      const charged = await root.V7Backend.createTask({ idempotencyKey: 'workflow-' + p.taskId, route: provider, requestedCount: p.batch, presetId: p.platformPresetId || p.presetId, presetVersion: String(p.presetVersion || ''), workflowParameters:chargedParameters, referenceCount:references.length, ...group, ...(quotedContract ? { expectedReferenceContract:quotedContract } : {}), expectedPoints:quoted.estimate.points });
      task.platformBilling = { taskId: charged.task.id, estimate: quoted.estimate };
      guard();
      let frozenEstimate = charged.task.estimate;
      if (!frozenEstimate && charged.task.estimate_json) {
        try { frozenEstimate = JSON.parse(charged.task.estimate_json); } catch (_) { throw error('WORKFLOW_RESPONSE_INVALID', '平台任务返回了无效参数快照'); }
      }
      task.workflowParameters = JSON.parse(JSON.stringify({ ...(p.workflowParameters || {}), ...(frozenEstimate && frozenEstimate.executionParameters || {}) }));
      const permit = await root.V7Backend.executionTicket(charged.task.id);
      guard();
      const worker = baseUrl(permit.workerUrl);
      const stopWatch = watchCloudProgress(charged.task.id, hooks.onProgress, hooks.progressIntervalMs);
      let result;
      try {
        result = await http({ url: worker + '/v1/execute', method: 'POST', requestId: 'workflow-' + p.taskId, timeoutMs: 600000,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: permit.ticket, input: { prompt: p.prompt, inputImageBase64: p.inputImageBase64, referenceImages:references, parameters: p.workflowParameters || {} } }) });
      } finally { stopWatch(); }
      guard();
      return { ...result, taskId: p.taskId };
    }
    if (!['local', 'own'].includes(p.computeSource)) throw error('WORKFLOW_SOURCE_REQUIRED', '请选择平台、本地或自有 Key 算力');
    // ⭐ 2026-10-15 云端预设同步：官方云端预设只带参数说明、不带工作流本体（本体留在云端）。
    //   这种预设拿去本地 / 自己的服务跑 = 发一张空工作流过去，必须明着拦下说清楚。
    if (provider === 'comfyui' && !Object.keys(config.prompt || {}).length) throw error('WORKFLOW_PLATFORM_ONLY', '这条是云端预设，只能用「平台云算力」跑（设置 → 工作流算力来源）');
    p.workflowParameters = resolveParameters(config, p.workflowParameters, p.prompt, p.batch, hooks.random);
    task.workflowParameters = JSON.parse(JSON.stringify(p.workflowParameters));
    if (provider === 'comfyui' && (!Array.isArray(config.outputNodeIds) || !config.outputNodeIds.length)) throw error('WORKFLOW_MAPPING_REQUIRED', '工作流作者还没有指定最终结果出口');
    const control = { quote: async () => ({ estimate: { points: 0, currency: 'external', source: p.computeSource } }),
      createTask: async () => ({ created: true, task: { id: p.taskId } }), setProviderTask: async () => ({}),
      recordTaskOutputs: async (id, outputs) => ({ task: { id, outputs } }), cancelTask: async () => ({}) };
    const scheduler = root.V7UnifiedScheduler.createUnifiedScheduler({ backend: control, adapters: { [provider]: provider === 'comfyui' ? comfyAdapter(p, config, guard) : rhAdapter(p, config, guard) } });
    active.set(p.taskId, scheduler);
    try {
      guard();
      const result = await scheduler.run({ provider, requestedCount: p.batch, idempotencyKey: p.taskId, workflow: config.workflow || config.prompt || {}, input: { prompt: p.prompt }, onProgress: hooks.onProgress });
      guard();
      const results = [];
      for (const image of result.images) { guard();const b64 = image.base64 || image.imageBase64 || (image.url ? await http({ url: image.url, responseType: 'base64' }) : '');guard(); if (b64) results.push({ index: results.length, imageBase64: b64, mime: image.mime || 'image/png' }); }
      return { ok: results.length > 0, taskId: p.taskId, results, errors: result.outputs.filter(item => item.status === 'failed').map(item => ({ index: item.index, code: item.errorCode, message: '工作流未返回此张图片' })) };
    } finally { active.delete(p.taskId); }
  }
  async function importRunningHub(options) {
    const adapter = rhAdapter({ baseUrl:options.url, apiKey:options.key }, {});
    await adapter.testConnection();
    const prompt = await adapter.getWorkflow(options.workflowId);
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) throw error('WORKFLOW_RESPONSE_INVALID','RH 未返回有效工作流');
    const entries = Object.entries(prompt);
    const inputs = entries.filter(([,node])=>node.class_type==='LoadImage').map(([id])=>id);
    const textNodes = entries.filter(([,node])=>node.class_type==='CLIPTextEncode').map(([id])=>id);
    const title = String(options.name || 'RH 工作流 '+options.workflowId).trim();
    const existing = root.PRESETS.presets().filter(item=>item.title===title||item.title.startsWith(title+' V'));
    const item = await root.PRESETS.savePreset({ title:existing.length?title+' V'+(existing.length+1):title, content:'', provider:'runninghub',
      importedAt:new Date().toISOString(), workflow:{ workflowId:String(options.workflowId), prompt,
        nodeInfoList:[], inputMode:inputs.length===0?'none':'image', inputNodeIds:inputs.length===1?inputs:[],
        promptBindings:textNodes.length===1?[{nodeId:textNodes[0],input:'text'}]:[] } });
    return { preset:item, needsInputMapping:inputs.length>1, keptDefaultPrompts:textNodes.length!==1 };
  }
  root.V7Workflows = { isWorkflow: p => !!normalize(p && p.provider), normalizeConfig: normalizeWorkflowConfig, persistentParameters, transientBinding, resolveParameters, billingParameters, validateReferences, generate, importRunningHub, cloudProgressText, watchCloudProgress,
    testRunningHub: options => rhAdapter({baseUrl:options.url,apiKey:options.key},{}).testConnection(),
    cancel: async taskId => { const scheduler = active.get(taskId); if (scheduler) return scheduler.cancel(taskId); return root.uiwin.http.cancel('workflow-' + taskId); } };
})(window);
