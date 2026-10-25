// User-owned API connections. Credentials stay in the helper; queued work pins its connection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import { DATA_DIR } from '../lib/paths.mjs';
import { atomicJson, readJson, recordId } from '../lib/store.mjs';
import { persist } from '../lib/jobs.mjs';

const file = path.join(DATA_DIR, 'api-channels.json');
const snapshots = new WeakMap();
export const CHANNEL_PRESETS = {
 momo: { title: '墨墨', website: 'https://api.momoapi.icu/', urls: ['https://api2.momoapi.icu', 'https://api.momoapi.icu', 'https://api1.momoapi.icu'], protocol: 'gemini', model: '' },
 grs: { title: 'GRS', website: 'https://grsai.com/zh', docs: 'https://grsai.com/zh/dashboard/documents/chat', urls: ['https://grsaiapi.com', 'https://grsai.dakka.com.cn'], protocol: 'grs-banana', model: 'nano-banana-pro' },
 custom: { title: '自定义兼容渠道', website: '', urls: [], protocol: 'gemini', model: '' },
};
const GRSMODELS = {
 'grs-banana': ['nano-banana-pro', 'nano-banana-2.1', 'nano-banana-2', 'nano-banana-fast', 'nano-banana', 'nano-banana-2-cl', 'nano-banana-2-2k-cl', 'nano-banana-2-4k-cl', 'nano-banana-pro-vt', 'nano-banana-pro-cl', 'nano-banana-pro-vip', 'nano-banana-pro-4k-vip'],
 'grs-gpt': ['gpt-image-2', 'gpt-image-2-vip', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
};
const defaultState = () => ({ schema: 1, revision: 0, assistId: '', profiles: ['momo', 'grs'].map(kind => ({ id: kind, kind, title: CHANNEL_PRESETS[kind].title, url: CHANNEL_PRESETS[kind].urls[0], protocol: CHANNEL_PRESETS[kind].protocol, model: CHANNEL_PRESETS[kind].model, models: kind === 'grs' ? GRSMODELS['grs-banana'] : [], textModel: '', key: '', enabled: true })) });
const settings = () => {const state=readJson(file, defaultState());return {...state,profiles:state.profiles.map(p=>({modelLabels:{},hiddenModels:[],...p,concurrency:Number.isInteger(p.concurrency)&&p.concurrency>=1&&p.concurrency<=4?p.concurrency:1}))};};
const safeProfile = ({key, ...p}) => ({...p, hasKey: !!key});
const imageModel = id => /image|banana|imagen|flux|dall-e|sdxl|stable-diffusion/i.test(id);
const modelId = v => {const s = String(v || '').trim().replace(/^models\//, ''); if (s.length > 200 || /[\s?#\\]/.test(s)) throw new Error('模型 ID 无效'); return s;};
export function normalizeBase(value) {
 const u = new URL(String(value).trim());
 if (u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)))) throw new Error('API 地址必须是 HTTPS；本机服务可以使用 HTTP。请勿在地址里填写 Key');
 u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/(v1|v1beta)$/, '');
 return u.toString().replace(/\/$/, '');
}
const scrub = (msg, c) => String(msg || '').split(c.key || '\0').join('[已隐藏]').replace(/sk-[\w-]+/g, '[已隐藏]').slice(0, 400);
async function request(c, route, {body, signal, timeout=30000, method} = {}) {
 if (!c.key) throw new Error('先保存此配置的 API Key');
 const headers = {authorization: `Bearer ${c.key}`};
 if (!(body instanceof FormData)) headers['content-type'] = 'application/json';
 const r = await fetch(c.url + route, {method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'error', headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)});
 if (!r.ok) { const e = new Error(`API HTTP ${r.status}${r.status === 401 || r.status === 403 ? '：Key 无效、权限不足或节点不接受此 Key' : ''}`); e.status = r.status; throw e; }
 let data; try { data = await r.json(); } catch { throw new Error('服务未返回 JSON，请检查 API 地址是否填成了网站页面'); }
 if (data.error || data.success === false || data.code === false || (typeof data.code === 'number' && data.code !== 0)) throw new Error(`API：${scrub(data.error?.message || data.error || data.msg || data.message || data.code, c)}`);
 return data;
}
function findProfile(id, state=settings()) { const c=state.profiles.find(p=>p.id===id&&!p.deleted); if(!c)throw new Error('找不到此 API 配置');return c; }
async function fetchModels(c) {
 if (c.kind === 'grs') return {models: GRSMODELS[c.protocol], source: 'GRS 官方文档预置列表（非 Key 授权检测，可手动补充）'};
 let data;
 try { data = await request(c,'/v1/models'); } catch(e) { if(e.status!==404 || c.protocol!=='gemini')throw e; data=await request(c,'/v1beta/models'); }
 const list=data.data || data.models;
 if(!Array.isArray(list))throw new Error('服务没有返回模型列表');
 const all=[...new Set(list.map(m=>modelId(typeof m==='string'?m:m.id||m.name)).filter(Boolean))].slice(0,2000);
 return {models:all.filter(imageModel), allModels:all, source:'服务返回的模型列表；关键词筛选只供选择，接口支持以服务商为准'};
}
async function balance(c) {
 if(c.kind==='grs') {const r=await request(c,'/client/openapi/getAPIKeyCredits',{body:{apiKey:c.key}});if(!Number.isFinite(r.data?.credits))throw new Error('GRS 未返回有效积分');return {available:r.data.credits,unit:'积分',unlimited:false};}
 try {const r=await request(c,'/api/usage/token');const d=r.data;if(!d || (!d.unlimited_quota&&!Number.isFinite(d.total_available)))throw new Error('该服务没有返回可识别的额度字段');return {available:d.total_available??null,used:d.total_used??null,unlimited:d.unlimited_quota===true,unit:'服务原始额度（非人民币）'};}
 catch(e){if(e.status===404||e.status===405)throw new Error('此渠道不支持 New API 额度查询，请到服务商控制台查看');throw e;}
}
let syncRegistry=()=>{};
// Display preferences are profile-local; provider requests still use the original IDs.
function modelSettings(body,old,models,model) {
 const has=name=>Object.prototype.hasOwnProperty.call(body,name);
 const concurrency=has('concurrency')?body.concurrency:old?.concurrency??1;
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('每套配置的并发数必须是 1–4 的整数');
 const known=new Set(models), labels=has('modelLabels')?body.modelLabels:old?.modelLabels||{};
 if(!labels||typeof labels!=='object'||Array.isArray(labels)||![Object.prototype,null].includes(Object.getPrototypeOf(labels)))throw new Error('模型显示名称必须是 ID 到名称的对象');
 const modelLabels=Object.create(null);
 for(const [id,label]of Object.entries(labels)) {
  if(!known.has(id)){if(has('modelLabels'))throw new Error('显示名称包含未列出的模型 ID');continue;}
  if(typeof label!=='string'||label.length>100||/[\u0000-\u001f\u007f]/.test(label))throw new Error('模型显示名称须为不超过 100 字符的单行文字');
  if(label.trim())modelLabels[id]=label.trim();
 }
 const hidden=has('hiddenModels')?body.hiddenModels:old?.hiddenModels||[];
 if(!Array.isArray(hidden)||hidden.length>2000||hidden.some(id=>typeof id!=='string'||(has('hiddenModels')&&!known.has(id))))throw new Error('隐藏模型必须是已列出模型 ID 的数组');
 const hiddenModels=[...new Set(hidden.filter(id=>known.has(id)))];
 if(model&&hiddenModels.includes(model))throw new Error('默认模型不能隐藏；请先选择另一个可见的默认模型');
 return {concurrency,modelLabels,hiddenModels};
}
export async function channelRoutes(method, parts, body={}) {
 const state=settings(), action=parts[1];
 if(method==='GET'&&!action)return {...state,profiles:state.profiles.filter(p=>!p.deleted).map(safeProfile),presets:CHANNEL_PRESETS};
 if(method!=='POST')throw new Error('请求方式无效');
 if(action==='save') {
  if(body.revision!==state.revision)throw new Error('配置已在另一窗口修改，请刷新后再保存');
  const old=body.id?findProfile(recordId(body.id),state):null;
  if(!CHANNEL_PRESETS[body.kind])throw new Error('未知服务商');
  const protocols=body.kind==='grs'?['grs-banana','grs-gpt']:['gemini','images'];
  if(!protocols.includes(body.protocol))throw new Error('选择正确的接口格式');
  const url=normalizeBase(body.url), key=String(body.key||'').trim();
  const known=CHANNEL_PRESETS[body.kind].urls;
  if(body.kind!=='custom'&&!known.includes(url))throw new Error('请选择服务商预置节点；其他地址请新建自定义渠道');
  if(old?.key&&!key&&!body.clearKey&&url!==old.url&&!(old.kind===body.kind&&known.includes(old.url)&&known.includes(url)))throw new Error('地址已改变，请重新输入对应服务的 Key');
  if(key.length>4096||/[\r\n]/.test(key))throw new Error('API Key 格式无效');
  const model=modelId(body.model), textModel=modelId(body.textModel);
  const models=[...new Set([model,...(Array.isArray(body.models)?body.models:old?.models||[])].map(modelId).filter(Boolean))].slice(0,2000);
  const preferences=modelSettings(body,old,models,model);
  const p={id:old?.id||crypto.randomUUID(),kind:body.kind,title:String(body.title||CHANNEL_PRESETS[body.kind].title).trim().slice(0,100),url,protocol:body.protocol,model,models,...preferences,textModel,key:body.clearKey?'':key||old?.key||'',enabled:body.enabled!==false,updatedAt:Date.now()};
  if(body.useForAssist&&(!textModel||!p.key||!p.enabled))throw new Error('复用 AI 帮写需要启用配置、保存 Key 并填写文本/视觉模型 ID');
  state.profiles=state.profiles.filter(x=>x.id!==p.id).concat(p);
  if(body.useForAssist)state.assistId=p.id;else if(state.assistId===p.id)state.assistId='';
  state.revision++;atomicJson(file,state);syncRegistry();return {profile:safeProfile(p),revision:state.revision};
 }
 const c=findProfile(recordId(body.id),state);
 if(action==='delete') {if(body.revision!==state.revision)throw new Error('配置已改变，请刷新');c.deleted=true;c.enabled=false;if(state.assistId===c.id)state.assistId='';state.revision++;atomicJson(file,state);syncRegistry();return {ok:true};}
 try {
  if(action==='models')return await fetchModels(c);
  if(action==='balance')return await balance(c);
  if(action==='test') {const start=Date.now();if(c.kind==='grs')await balance(c);else await fetchModels(c);return {ok:true,latency:Date.now()-start,note:'认证读取成功；尚未提交生图任务'};}
 } catch(e){throw new Error(scrub(e.message,c));}
 throw new Error('未知 API 设置操作');
}
const ASPECTS=['1:1','2:3','3:2','3:4','4:3','9:16','16:9','4:5','5:4','21:9'];
const sizes={'1:1':'1024x1024','2:3':'1024x1536','3:2':'1536x1024'};
function caps(c){const gpt=['images','grs-gpt'].includes(c.protocol);return {aspects:gpt?Object.keys(sizes):ASPECTS,...(!gpt?{resolutions:['1K','2K','4K']}:{}),models:[...new Set([c.model,...c.models].filter(id=>id&&!c.hiddenModels.includes(id)))],modelLabels:{...c.modelLabels},defaultModel:c.model,concurrency:c.concurrency,family:gpt?'gpt':'banana'};}
function connection(c){if(!c.enabled||!c.key||!c.model||c.deleted)throw new Error('请在 API 设置启用配置、填写 Key 和默认模型');return {...c};}
export function registerChannels(providers, capabilities) {
 syncRegistry=()=>{
  for(const c of settings().profiles) {
   const id=`api-${c.id}`, cp=caps(c);capabilities[id]=cp;
   providers[id]={concurrency:c.concurrency,label:`${cp.family==='gpt'?'GPT Image':'Nano Banana'} · ${c.title}`,async status(){return {...cp,hidden:!!c.deleted,available:!!(c.enabled&&c.key&&c.model&&!c.deleted),note:!c.enabled?'未启用':!c.key?'未填 Key':!c.model?'请选择默认模型':''};},prepare(job){const pinned=connection(c);job.model=modelId(job.model||pinned.model);snapshots.set(job,pinned);job.apiProfile={id:c.id,title:c.title,url:c.url,protocol:c.protocol};},async run(job,ctx){const pinned=snapshots.get(job)||connection(c);return runChannel(pinned,job,ctx);}};
  }
 };syncRegistry();
}
async function imageData(f){const b=await sharp(f).png().toBuffer();if(b.length>30*1024*1024)throw new Error('单张参考图超过 30 MB');return {mimeType:'image/png',data:b.toString('base64')};}
async function saveResult(job, image, signal) {
 let bytes;
 if(image.b64)bytes=Buffer.from(image.b64,'base64');
 else {const u=new URL(image.url);if(u.protocol!=='https:'||u.username||u.password)throw new Error('结果图片链接不是有效 HTTPS 地址');const r=await fetch(u,{signal:AbortSignal.any([signal,AbortSignal.timeout(90000)])});if(!r.ok)throw new Error(`下载结果失败 HTTP ${r.status}`);bytes=Buffer.from(await r.arrayBuffer());}
 if(bytes.length>100*1024*1024)throw new Error('返回图片超过 100 MB');
 const out=path.join(job.dir,'result-channel.png');const info=await sharp(bytes,{limitInputPixels:100000000}).png().toFile(out);return {path:out,width:info.width,height:info.height};
}
export async function runChannel(c,job,{log,signal}) {
 try {
  const images=await Promise.all([job.inputPath,...(job.refPaths||[])].filter(Boolean).map(imageData));
  const model=modelId(job.model||c.model); if(!model)throw new Error('没有选择生成模型');
  log(`${c.title} · ${model}`);
  // Mark before submitting: timeout/abort must not automatically spend again on another provider.
  job.upstream={kind:'api-channel',profileId:c.id,url:c.url,protocol:c.protocol,state:'submitting'};persist(job);
  let result;
  if(c.protocol.startsWith('grs-')) {
   const gpt=c.protocol==='grs-gpt';
   const r=await request(c,gpt?'/v1/draw/completions':'/v1/draw/nano-banana',{body:{model,prompt:job.prompt,aspectRatio:gpt?(sizes[job.aspect]||'auto'):job.aspect,...(!gpt?{imageSize:job.resolution||'2K'}:{}),urls:images.map(i=>`data:${i.mimeType};base64,${i.data}`),webHook:'-1',shutProgress:false},signal,timeout:120000});
   if(!r.data?.id)throw new Error('GRS 未返回任务 ID，请到服务商日志核对');
   job.upstream.taskId=String(r.data.id);job.upstream.state='submitted';persist(job);log(`GRS 任务 ${job.upstream.taskId}`);
   for(let i=0;i<720;i++) {
    const d=(await request(c,'/v1/draw/result',{body:{id:job.upstream.taskId},signal})).data;
    if(d?.status==='failed')throw new Error(`GRS 生成失败：${scrub(d.failure_reason||d.error,c)}`);
    if(d?.status==='succeeded') {const results=d.results?.length?d.results:(d.url?[{url:d.url}]:[]);job.upstream.outputs=results;persist(job);if(results.length!==1)throw new Error(`GRS 返回 ${results.length} 张图，已保留任务 ID 供核对`);result={url:results[0].url};break;}
    await delay(5000,undefined,{signal});
   }
   if(!result)throw new Error('GRS 等待超时，请用任务 ID 查询云端结果');
  } else if(c.protocol==='gemini') {
   const r=await request(c,`/v1beta/models/${encodeURIComponent(model)}:generateContent`,{body:{contents:[{role:'user',parts:[{text:job.prompt},...images.map(inlineData=>({inlineData}))]}],generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:job.aspect,imageSize:job.resolution||'2K'}}},signal,timeout:600000});
   const parts=(r.candidates||[]).flatMap(x=>x.content?.parts||[]).map(p=>p.inlineData||p.inline_data).filter(p=>p&&/^image\//.test(p.mimeType||p.mime_type||''));
   if(parts.length!==1)throw new Error(`Gemini 接口返回 ${parts.length} 张图，未自动选择结果`);result={b64:parts[0].data};
  } else {
   let body;
   if(images.length){body=new FormData();body.set('model',model);body.set('prompt',job.prompt);body.set('size',sizes[job.aspect]||'auto');body.set('n','1');for(const [i,img]of images.entries())body.append('image[]',new Blob([Buffer.from(img.data,'base64')],{type:img.mimeType}),`reference-${i}.png`);}
   else body={model,prompt:job.prompt,size:sizes[job.aspect]||'auto',n:1};
   const r=await request(c,images.length?'/v1/images/edits':'/v1/images/generations',{body,signal,timeout:600000});
   if(r.data?.length!==1)throw new Error('Images 接口没有返回单张图片');result={b64:r.data[0].b64_json,url:r.data[0].url};
  }
  const out=await saveResult(job,result,signal);job.upstream.state='downloaded';persist(job);return {...out,source:`${c.title} · ${model}`};
 } catch(e) {if(signal.aborted)log('已停止本地等待；已提交的云端任务可能继续计费，请到服务商日志核对');throw new Error(scrub(e.message,c));}
}
export async function channelAssist({text,imagePath,signal}) {
 const s=settings();if(!s.assistId)return null;const c=connection(findProfile(s.assistId,s));if(!c.textModel)throw new Error('请在 API 设置填写文本/视觉模型 ID');
 const content=[{type:'text',text:`你是专业修图提示词助手。把用户需求写成明确、可执行的中文图像编辑提示词；保持未要求修改的构图、身份、背景和光影，只输出提示词。用户需求：${text}`}];
 if(imagePath){const img=await imageData(imagePath);content.push({type:'image_url',image_url:{url:`data:${img.mimeType};base64,${img.data}`}});}
 try {const r=await request(c,'/v1/chat/completions',{body:{model:c.textModel,messages:[{role:'user',content}],stream:false},signal,timeout:120000});const answer=r.choices?.[0]?.message?.content;if(typeof answer!=='string'||!answer.trim())throw new Error('推理接口没有返回文字');return answer.trim();}catch(e){throw new Error(scrub(e.message,c));}
}

// Conversation endpoint; the existing single-shot prompt helper stays unchanged.
export async function channelChat({messages, signal}) {
 const s=settings(); if(!s.assistId)return null;
 const c={...findProfile(s.assistId,s)};
 if(!c.enabled||!c.key||!c.textModel)throw new Error('请启用助手渠道并填写 Key 和文本/视觉模型 ID');
 const turns=[];
 for(const m of messages){
  if(!['system','user','assistant'].includes(m.role)||typeof m.text!=='string')throw new Error('对话消息格式错误');
  const content=[{type:'text',text:m.text}];
  for(const imagePath of m.imagePaths||[]){const img=await imageData(imagePath);content.push({type:'image_url',image_url:{url:`data:${img.mimeType};base64,${img.data}`}});}
  turns.push({role:m.role,content:content.length===1?m.text:content});
 }
 try {
  const r=await request(c,'/v1/chat/completions',{body:{model:c.textModel,messages:turns,stream:false},signal,timeout:120000});
  const answer=r.choices?.[0]?.message?.content;
  if(typeof answer!=='string'||!answer.trim())throw new Error('推理接口没有返回文字');
  return {text:answer.trim(),source:{provider:'channel',id:c.id,title:c.title,model:c.textModel}};
 }catch(e){throw new Error(scrub(e.message,c));}
}
