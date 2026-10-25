// A1111 API: https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API
// ControlNet: https://github.com/Mikubill/sd-webui-controlnet/wiki/API
// Workflow execution is delegated to the existing ComfyUI adapter, never to a text-to-image substitute.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR } from '../lib/paths.mjs';
import { atomicJson, readJson, recordId } from '../lib/store.mjs';
import { createJob, publicJob, persist, useUpload } from '../lib/jobs.mjs';
import { comfyui, comfyRoutes, workflows, validateWorkflow } from './comfyui.mjs';

const root = path.join(DATA_DIR, 'model-tools');
const connectionFile = path.join(root, 'forge.json');
const bindingsFile = path.join(root, 'bindings.json');
const presetsFile = path.join(root, 'forge-presets.json');
const connection = () => readJson(connectionFile, { url: 'http://127.0.0.1:7860', username: '', password: '', enabled: false });
const bindings = () => readJson(bindingsFile, []);
const presets = () => readJson(presetsFile, []);
const publicConnection = c => ({ url: c.url, username: c.username, enabled: c.enabled, hasPassword: Boolean(c.password) });
const fail = message => { throw new Error(message); };
const plain = v => v && typeof v === 'object' && !Array.isArray(v);

async function request(c, endpoint, { body, signal, optional = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (c.username || c.password) headers.authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
  let r;
  try {
    r = await fetch(c.url + endpoint, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body ? 1800000 : 15000)]) : AbortSignal.timeout(15000) });
  } catch (e) { throw new Error(`Forge 服务无法访问：${endpoint} · ${e.message}`); }
  if (optional && r.status === 404) return null;
  if (!r.ok) throw new Error(`Forge ${endpoint} HTTP ${r.status}；检查 --api、认证及模型依赖`);
  return r.json();
}
export async function forgeInventory() {
  const c = connection();
  const [models, loras, upscalers, samplers, controlModels, controlModules, scripts] = await Promise.all([
    request(c, '/sdapi/v1/sd-models'), request(c, '/sdapi/v1/loras', { optional: true }),
    request(c, '/sdapi/v1/upscalers'), request(c, '/sdapi/v1/samplers'),
    request(c, '/controlnet/model_list', { optional: true }), request(c, '/controlnet/module_list', { optional: true }),
    request(c, '/sdapi/v1/scripts'),
  ]);
  return { models, loras: loras || [], upscalers, samplers, controlModels: controlModels?.model_list || [],
    controlModules: controlModules?.module_list || [], controlNetAvailable: Boolean(controlModels && controlModules), scripts,
    loraInventoryAvailable: loras !== null };
}
const supported = new Set(['title','model','prompt','negative_prompt','steps','cfg_scale','seed','sampler_name','denoising_strength','width','height','loras','controlnet']);
function normalizePreset(input) {
  if (!plain(input)) fail('请导入 Forge/A1111 参数 JSON 对象');
  const p = { ...input };
  // Only this documented per-request override can be represented without changing global server settings.
  if (plain(p.override_settings) && Object.keys(p.override_settings).length === 1 && p.override_settings.sd_model_checkpoint) {
    p.model = p.model || p.override_settings.sd_model_checkpoint; delete p.override_settings;
  }
  return p;
}
export function forgePreflight(input, inventory) {
  const p = normalizePreset(input), errors = [], warnings = ['检查只验证参数与依赖是否存在，不承诺转换等价、模型架构兼容或相同画面。'];
  for (const key of Object.keys(p)) if (!supported.has(key)) errors.push(`不支持的导入字段：${key}；未转换、未忽略`);
  const model = inventory.models.find(m => [m.title, m.model_name, m.sha256, m.hash].filter(Boolean).includes(p.model));
  if (!model) errors.push(`模型缺失或未明确指定：${p.model || '(空)'}；请选择服务返回的 checkpoint`);
  if (p.sampler_name && !inventory.samplers.some(s => s.name === p.sampler_name)) errors.push(`采样器缺失：${p.sampler_name}`);
  const ranges = { steps:[1,150,true], cfg_scale:[0,30], seed:[-1,2147483647,true], denoising_strength:[0,1], width:[64,4096,true], height:[64,4096,true] };
  for (const [key,[min,max,integer]] of Object.entries(ranges)) if (p[key] !== undefined && (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key]<min || p[key]>max || (integer&&!Number.isInteger(p[key])))) errors.push(`${key} 需要 ${min}–${max}${integer?' 整数':''}`);
  if ((p.width === undefined) !== (p.height === undefined)) errors.push('width 与 height 必须同时指定');
  for (const k of ['prompt','negative_prompt']) if (p[k] !== undefined && typeof p[k] !== 'string') errors.push(`${k} 必须是文本`);
  const loras = Array.isArray(p.loras) ? p.loras : [];
  if (p.loras !== undefined && !Array.isArray(p.loras)) errors.push('loras 必须是 [{name, weight}]');
  const embedded = [...String(p.prompt || '').matchAll(/<lora:([^:>]+):([^>]+)>/g)].map(m=>({ name:m[1], weight:Number(m[2]) }));
  for (const l of [...loras,...embedded]) {
    if (!l || typeof l.name !== 'string' || /[<>:\r\n]/.test(l.name) || !inventory.loras.some(x => x.name===l.name || x.alias===l.name)) errors.push(`LoRA 缺失或名称无效：${l?.name}`);
    if (!Number.isFinite(l?.weight) || Math.abs(l.weight)>2) errors.push(`LoRA 权重无效：${l?.name}`);
  }
  const controls = Array.isArray(p.controlnet) ? p.controlnet : [];
  if (p.controlnet !== undefined && !Array.isArray(p.controlnet)) errors.push('controlnet 必须是数组');
  if (controls.length && (!inventory.controlNetAvailable || ![...(inventory.scripts?.img2img||[])].some(s=>s.toLowerCase()==='controlnet'))) errors.push('服务未提供兼容的 ControlNet API / img2img 脚本');
  for (const c of controls) {
    if (!plain(c)) { errors.push('ControlNet 单元必须是对象'); continue; }
    for (const key of Object.keys(c)) if (!['model','module','weight','guidance_start','guidance_end','source','index'].includes(key)) errors.push(`ControlNet 不支持字段：${key}`);
    if (!inventory.controlModels.includes(c.model)) errors.push(`ControlNet 模型缺失：${c.model}`);
    if (!inventory.controlModules.includes(c.module || 'none')) errors.push(`ControlNet 预处理器缺失：${c.module}`);
    if (!['image','reference'].includes(c.source)) errors.push('ControlNet 必须明确指定 source: image 或 reference');
    if (c.source==='reference' && (!Number.isInteger(c.index) || c.index<0 || c.index>15)) errors.push('ControlNet reference 需要 0–15 的 index');
    for (const key of ['weight','guidance_start','guidance_end']) if (c[key]!==undefined && (!Number.isFinite(c[key])||c[key]<0||c[key]>(key==='weight'?2:1))) errors.push(`ControlNet ${key} 无效`);
    if ((c.guidance_start??0)>(c.guidance_end??1)) errors.push('ControlNet guidance_start 不能大于 guidance_end');
  }
  return { ok:!errors.length, errors, warnings, equivalentConversion:false,
    requirements:{ model:p.model||null, loras:[...loras,...embedded].map(l=>l?.name), controlnet:controls.map(c=>c?.model) },
    preset:{...p, model:model?.title||p.model} };
}

export async function forgeRoutes(method, parts, body = {}) {
  if (parts[0] !== 'forge') return undefined;
  if (method === 'GET' && parts.length === 1) return { connection:publicConnection(connection()), presets:presets() };
  if (method !== 'POST') fail('未知 Forge 操作');
  if (parts[1] === 'connection') {
    const u = new URL(body.url);
    if (!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash) fail('请输入不含账号与查询参数的 HTTP 地址');
    const old = connection(), next = {url:u.href.replace(/\/$/,''), username:String(body.username||''), password:body.clearPassword?'':body.password||old.password, enabled:body.enabled===true};
    atomicJson(connectionFile,next); return publicConnection(next);
  }
  if (parts[1] === 'inspect' || parts[1] === 'test') return forgeInventory();
  if (parts[1] === 'preflight') return forgePreflight(body.preset, await forgeInventory());
  if (parts[1] === 'import') {
    const report = forgePreflight(body.preset, await forgeInventory());
    if (!report.ok) fail(report.errors.join('\n'));
    if (!String(body.title||report.preset.title||'').trim()) fail('请输入预设名称');
    const p = {id:body.id?recordId(body.id):crypto.randomUUID(),title:String(body.title||report.preset.title).trim().slice(0,200),parameters:report.preset,report,updatedAt:Date.now()};
    atomicJson(presetsFile,[...presets().filter(x=>x.id!==p.id),p]); return p;
  }
  fail('未知 Forge 操作');
}
export const forge = {
  label:'Forge / A1111 · 自有服务',
  async status() { const c=connection(), ps=presets(); return {available:c.enabled&&ps.length>0,note:!c.enabled?'连接未启用':!ps.length?'先导入并检查参数预设':'运行前将重新检查依赖',models:ps.map(p=>p.id),modelLabels:Object.fromEntries(ps.map(p=>[p.id,p.title]))}; },
  prepare(job) { const p=presets().find(p=>p.id===job.model); if(!p) fail('Forge 预设不存在'); job.meta.forgePreset=structuredClone(p); job.fallbacks=[]; },
  async run(job,{log,signal}) {
    signal.throwIfAborted();const c=connection(); if(!c.enabled) fail('Forge 连接未启用');
    const saved=job.meta?.forgePreset||presets().find(p=>p.id===job.model); if(!saved) fail('Forge 预设不存在');
    const inventory=await forgeInventory();signal.throwIfAborted();const report=forgePreflight({...saved.parameters,prompt:job.prompt},inventory);
    if(!report.ok) fail(report.errors.join('\n'));
    const p=report.preset, refs=job.refPaths||[], controls=p.controlnet||[];
    if(refs.some((_,i)=>!controls.some(c=>c.source==='reference'&&c.index===i))) fail('参考图没有 ControlNet 映射，已停止以免忽略参考图');
    if(controls.length&&!job.inputPath) fail('此 ControlNet 适配只支持带原图的 img2img');
    const encode=file=>{if(!file||!fs.existsSync(file))fail('ControlNet / img2img 原图不存在');return fs.readFileSync(file).toString('base64');};
    let dimensions={width:p.width||1024,height:p.height||1024};
    if(job.inputPath && !p.width) { const m=await sharp(job.inputPath).rotate().metadata(); dimensions={width:Math.max(64,Math.round(m.width/8)*8),height:Math.max(64,Math.round(m.height/8)*8)}; if(dimensions.width>4096||dimensions.height>4096)fail('原图超过 4096 像素，请明确设置 width / height'); }
    else if(!job.inputPath&&!p.width) {const [w,h]=job.aspect.split(':').map(Number); const side=job.resolution==='4K'?4096:job.resolution==='1K'?1024:2048; dimensions={width:Math.max(64,Math.round(side*Math.min(1,w/h)/8)*8),height:Math.max(64,Math.round(side*Math.min(1,h/w)/8)*8)};}
    const payload={prompt:[job.prompt,...(p.loras||[]).map(l=>`<lora:${l.name}:${l.weight}>`)].join(' '),negative_prompt:p.negative_prompt||'',steps:p.steps??20,cfg_scale:p.cfg_scale??7,seed:p.seed??-1,...dimensions,batch_size:1,n_iter:1,override_settings:{sd_model_checkpoint:p.model},override_settings_restore_afterwards:true,send_images:true,save_images:false};
    if(p.sampler_name) payload.sampler_name=p.sampler_name;
    if(job.inputPath) Object.assign(payload,{init_images:[encode(job.inputPath)],denoising_strength:p.denoising_strength??0.35});
    if(controls.length) payload.alwayson_scripts={ControlNet:{args:controls.map(({source,index,...unit})=>({...unit,module:unit.module||'none',enabled:true,image:encode(source==='image'?job.inputPath:refs[index])}))}};
    const endpoint=job.inputPath?'/sdapi/v1/img2img':'/sdapi/v1/txt2img';
    job.upstream={kind:'forge',url:c.url,endpoint,state:'submitting',submittedAt:Date.now()}; persist(job); log('Forge：提交单图任务');
    let data;
    try { data=await request(c,endpoint,{body:payload,signal}); }
    catch(e) { job.upstream.state='unknown';persist(job);throw new Error(`${e.message}；服务端可能仍在执行，请核对服务端后再重试。未调用全局 interrupt。`); }
    if(!Array.isArray(data.images)||data.images.length!==1) fail('Forge 必须返回一张图像；请检查批次与脚本');
    const output=path.join(job.dir,'result-forge.png');
    const info=await sharp(Buffer.from(data.images[0].replace(/^data:image\/[^;]+;base64,/,''),'base64')).png().toFile(output);
    job.upstream.state='downloaded';persist(job);return {path:output,width:info.width,height:info.height,source:`Forge · ${saved.title}`};
  },
};

export const MODEL_TOOL_ROLES = {
  segmentation:{label:'语义选区 / 人体部位',inputs:['points','box','text','includeParts','excludeParts'],outputs:['gray','alpha']},
  enhancement:{label:'专用增强',inputs:['upscaler','scale','text'],outputs:['image']},
};
export const MODEL_TOOL_GUIDANCE = {
  binding:{role:'segmentation',family:'qwen',workflowId:'从 ComfyUI 已保存工作流选择',outputNode:'9',output:'gray',
    mappings:[{source:'text',node:'6',field:'text',encoding:'value'},{source:'points',node:'7',field:'points_json',encoding:'json'}]},
  selection:{points:[{x:120,y:240,label:1},{x:50,y:60,label:0}],box:[10,20,300,400],text:'头发',includeParts:['hair','face'],excludeParts:['hands']},
  explanation:'坐标为原图像素，box=[x1,y1,x2,y2]，points label 1=包含 / 0=排除。字段取决于所选节点。value 传入原值，json 传入 JSON 字符串，csv 仅用于部位列表。JSON 示例必须改成实际工作流的节点/字段；不推断模型或生成分割图。',
};
function workflowFor(binding) { const w=workflows().find(w=>w.id===binding.workflowId); if(!w)fail('绑定的 ComfyUI 工作流不存在，请重新选择'); return w; }
function validateBinding(b,w) {
  const role=MODEL_TOOL_ROLES[b.role];if(!role)fail('未知任务角色');validateWorkflow(w.prompt);
  if(!w.mapping.some(m=>m.source==='image'))fail('工作流必须映射原图 image 入口');
  if(!b.outputNode||!w.prompt[b.outputNode])fail('请选择明确的单图输出节点');
  if(!role.outputs.includes(b.output))fail('选区输出必须是 gray 或 alpha；增强输出必须是 image');
  if(!Array.isArray(b.mappings)||!b.mappings.length||b.mappings.length>100)fail('需要明确的任务输入映射');
  const reachable=new Set();
  function visit(id){if(reachable.has(id))return;reachable.add(id);for(const v of Object.values(w.prompt[id]?.inputs||{}))if(Array.isArray(v)&&v.length===2&&Number.isInteger(v[1])&&w.prompt[String(v[0])])visit(String(v[0]));}
  visit(b.outputNode);
  if(!w.mapping.some(m=>m.source==='image'&&reachable.has(m.node)))fail('输出节点未连接到原图入口');
  const used=new Set();
  for(const m of b.mappings) {
    if(!plain(m)||typeof m.node!=='string'||typeof m.field!=='string')fail('任务映射需要 {source,node,field,encoding} 对象，节点 ID 使用字符串');
    if(!role.inputs.includes(m.source)||!['value','json','csv'].includes(m.encoding||'value'))fail(`任务输入映射无效：${m.source}`);
    if(!reachable.has(m.node))fail(`任务字段未连接到所选输出：${m.node}.${m.field}`);
    const node=w.prompt[m.node];if(!node?.inputs||!Object.hasOwn(node.inputs,m.field))fail(`节点字段不存在：${m.node}.${m.field}`);
    const v=node.inputs[m.field];if(v!==null&&typeof v==='object')fail(`只能映射字面量字段，不可覆盖节点连接：${m.node}.${m.field}`);
    if(m.encoding==='csv'&&!['includeParts','excludeParts'].includes(m.source))fail('csv 只支持部位列表');
    if(w.mapping.some(x=>x.node===m.node&&x.field===m.field&&x.source==='image'))fail('任务输入不可覆盖原图入口');
    const key=`${m.node}.${m.field}`;if(used.has(key))fail(`重复字段映射：${key}`);used.add(key);
  }
  if(b.role==='enhancement'&&!b.mappings.some(m=>m.source==='upscaler'))fail('增强工作流必须明确映射用户选择的 upscaler 模型字段');
  return b;
}
export function mapModelToolInputs(binding, workflow, inputs = {}) {
  validateBinding(binding,workflow);if(!plain(inputs))fail('任务输入必须是 JSON 对象');
  const allowed=MODEL_TOOL_ROLES[binding.role].inputs;
  for(const k of Object.keys(inputs))if(!allowed.includes(k))fail(`此角色不支持输入：${k}`);
  for(const [key,value] of Object.entries(inputs)) {
    if(value===undefined||value===null||value===''||(Array.isArray(value)&&!value.length))continue;
    if(!binding.mappings.some(m=>m.source===key))fail(`工作流未映射 ${key}，已停止以免忽略输入`);
    if(key==='points'&&(!Array.isArray(value)||value.length>1000||value.some(p=>!plain(p)||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||![0,1].includes(p.label))))fail('points 需要 [{x,y,label:0或1}] 原图像素坐标');
    if(key==='box'&&(!Array.isArray(value)||value.length!==4||value.some(v=>!Number.isFinite(v)||v<0)||value[2]<=value[0]||value[3]<=value[1]))fail('box 需要 [x1,y1,x2,y2] 原图像素坐标');
    if(['includeParts','excludeParts'].includes(key)&&(!Array.isArray(value)||value.some(p=>typeof p!=='string'||!p.trim())))fail('人体部位需要非空字符串数组');
    if(['text','upscaler'].includes(key)&&(typeof value!=='string'||value.length>10000))fail(`${key} 必须是文本`);
    if(key==='scale'&&(!Number.isFinite(value)||value<1||value>8))fail('scale 需要 1–8');
  }
  if(binding.role==='segmentation'&&!['points','box','text','includeParts','excludeParts'].some(k=>inputs[k]?.length))fail('请提供点、框、文字或人体部位');
  if(binding.role==='enhancement'&&(!inputs.upscaler?.trim()||/^(none|nearest|bilinear|bicubic|lanczos)$/i.test(inputs.upscaler.trim())))fail('请选择工作流支持的专用 upscaler 模型；普通插值不作为专用增强');
  const snapshot=structuredClone(workflow), replaced=new Set();
  for(const m of binding.mappings) {
    const v=inputs[m.source];if(v===undefined||v===null)fail(`请明确提供已映射的 ${m.source}；无需此项时使用空文本或空数组`);
    const value=m.encoding==='json'?JSON.stringify(v):m.encoding==='csv'?v.join(','):v;
    // Comfy API uses arrays for links; complex literals must be serialized into a node's JSON input.
    if(value!==null&&typeof value==='object')fail(`${m.source} 需要 encoding: json，不能将数组误作节点连接`);
    if(typeof value!==typeof workflow.prompt[m.node].inputs[m.field])fail(`字段类型不匹配：${m.node}.${m.field}，请检查 encoding`);
    snapshot.prompt[m.node].inputs[m.field]=value;replaced.add(`${m.node}.${m.field}`);
  }
  snapshot.mapping=snapshot.mapping.filter(m=>!replaced.has(`${m.node}.${m.field}`));
  // Bind all role fields to literals so an absent prompt mapping cannot overwrite them later.
  for(const m of binding.mappings) {
    snapshot.mapping=snapshot.mapping.filter(x=>!(x.node===m.node&&x.field===m.field));
    snapshot.mapping.push({node:m.node,field:m.field,source:'literal',value:snapshot.prompt[m.node].inputs[m.field]});
  }
  snapshot.outputNode=binding.outputNode;return snapshot;
}
async function inspectSnapshot(snapshot) {
  const c=await comfyRoutes('GET',['comfyui'],{});if(!c.connection.enabled)fail('ComfyUI 连接未启用');
  const report=await comfyRoutes('POST',['comfyui','inspect'],{prompt:snapshot.prompt});
  if(!report.ok)fail(`工作流依赖缺失：${[...report.missing.map(x=>`${x.id}: ${x.type}`),...report.invalid.map(x=>`${x.node}.${x.field}=${x.value}（模型/参数不可用）`)].join('；')}`);
  return report;
}
export const modelTools = {
  label:'模型工具 · 用户工作流',
  async status(){const bs=bindings();return {available:bs.length>0,note:'必须使用模型工具页选择任务输入；运行前检查依赖',models:bs.map(b=>b.id),modelLabels:Object.fromEntries(bs.map(b=>[b.id,b.title]))};},
  prepare(job){if(!job.meta?.modelTool?.snapshot)fail('请从模型工具页提交明确的任务输入');job.post={align:false,cc:'none'};job.fallbacks=[];},
  async run(job,ctx) {
    const task=job.meta?.modelTool;if(!task?.snapshot||!job.inputPath)fail('任务绑定或原图缺失');
    await inspectSnapshot(task.snapshot);ctx.signal.throwIfAborted();
    const source=await sharp(job.inputPath).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
    if(task.inputs.points?.some(p=>p.x>=source.info.width||p.y>=source.info.height)||task.inputs.box&&(task.inputs.box[2]>source.info.width||task.inputs.box[3]>source.info.height))fail('点或框超出原图像素范围');
    // Use the existing provider unchanged. Keep an immutable per-job snapshot for reproducibility;
    // the temporary provider catalog entry is removed on success, failure and cancellation.
    const id=`task-${crypto.randomUUID()}`, ephemeral=path.join(DATA_DIR,'comfyui','workflows',`${id}.json`);
    const snapshot={...task.snapshot,id,title:`${task.binding.title} · ${job.id}`};
    atomicJson(path.join(job.dir,'model-tool-workflow.json'),snapshot);
    const normalizedInput=path.join(job.dir,'model-tool-input.png');
    await sharp(source.data,{raw:{width:source.info.width,height:source.info.height,channels:4}}).png().toFile(normalizedInput);
    atomicJson(ephemeral,snapshot);
    const originalModel=job.model,originalInput=job.inputPath;
    let output;
    try {job.model=id;job.inputPath=normalizedInput;output=await comfyui.run(job,ctx);} finally {job.model=originalModel;job.inputPath=originalInput;fs.rmSync(ephemeral,{force:true});persist(job);}
    if(task.binding.role==='enhancement')return {...output,source:`专用增强 · ${task.inputs.upscaler} · ${task.binding.title}`};
    ctx.signal.throwIfAborted();const meta=await sharp(output.path).metadata();
    if(meta.width!==source.info.width||meta.height!==source.info.height)fail('选区输出尺寸与原图不同；请在工作流内恢复原尺寸，未自动缩放蒙版');
    let mask;
    if(task.binding.output==='alpha') {if(!meta.hasAlpha)fail('所选输出没有 alpha 通道，不能作为分割结果');mask=await sharp(output.path).extractChannel('alpha').raw().toBuffer();}
    else {
      const {data,info}=await sharp(output.path).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
      for(let i=0;i<data.length;i+=info.channels)if(data[i]!==data[i+1]||data[i]!==data[i+2])fail('gray 输出包含彩色像素；不能将生成图当作语义蒙版');
      mask=await sharp(output.path).removeAlpha().greyscale().raw().toBuffer();
    }
    for(let i=0;i<mask.length;i++){mask[i]=Math.round(mask[i]*source.data[i*4+3]/255);source.data[i*4+3]=mask[i];}
    const maskPath=path.join(job.dir,'mask.png'),resultPath=path.join(job.dir,'result-selection.png');
    await sharp(mask,{raw:{width:source.info.width,height:source.info.height,channels:1}}).png().toFile(maskPath);
    await sharp(source.data,{raw:{width:source.info.width,height:source.info.height,channels:4}}).png().toFile(resultPath);
    job.meta.mask={path:maskPath,kind:'gray',width:source.info.width,height:source.info.height,role:'segmentation'};persist(job);
    return {path:resultPath,width:source.info.width,height:source.info.height,source:`语义选区 · ${task.binding.title}`};
  },
};
export async function modelToolsRoutes(method,parts,body={}) {
  if(parts[0]!=='model-tools')return undefined;
  if(method==='GET'&&parts.length===1)return {bindings:bindings(),roles:MODEL_TOOL_ROLES,guidance:MODEL_TOOL_GUIDANCE,workflows:workflows().filter(w=>!w.id.startsWith('task-'))};
  if(method!=='POST')fail('未知模型工具操作');
  if(parts[1]==='save') {
    const b={id:body.id?recordId(body.id):crypto.randomUUID(),title:String(body.title||'').trim().slice(0,200),family:body.family==='qwen'?'qwen':'user',role:body.role,workflowId:body.workflowId,outputNode:String(body.outputNode||''),output:body.output,mappings:body.mappings,updatedAt:Date.now()};
    if(!b.title)fail('请输入绑定名称');validateBinding(b,workflowFor(b));atomicJson(bindingsFile,[...bindings().filter(x=>x.id!==b.id),b]);return b;
  }
  if(parts[1]==='remove') {const id=recordId(body.id);atomicJson(bindingsFile,bindings().filter(b=>b.id!==id));return {ok:true};}
  if(parts[1]==='inspect'||parts[1]==='run') {
    const b=bindings().find(b=>b.id===body.id);if(!b)fail('请先保存并选择任务绑定');
    const snapshot=mapModelToolInputs(b,workflowFor(b),body.inputs||{});
    const report=await inspectSnapshot(snapshot);if(parts[1]==='inspect')return {ok:true,report,workflowId:b.workflowId,family:b.family,note:'依赖检查通过；模型能力由所选工作流决定，须运行验证'};
    if(!useUpload(body.uploadId))fail('原图不存在或已过期，请重新选择');
    const job=createJob({provider:'model-tools',model:b.id,prompt:b.title,uploadId:body.uploadId,post:{align:false,cc:'none'},fallbacks:[],meta:{origin:'model-tools',modelTool:{binding:b,inputs:body.inputs||{},snapshot}}},{'model-tools':modelTools},{});
    return publicJob(job);
  }
  fail('未知模型工具操作');
}
