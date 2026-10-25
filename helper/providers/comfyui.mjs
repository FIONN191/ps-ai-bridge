// Self-hosted ComfyUI API adapter. No imported workflow JavaScript is executed here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../lib/paths.mjs';
import { atomicJson, readJson, recordId } from '../lib/store.mjs';
import { persist, downloadCandidates } from '../lib/jobs.mjs';
const root=path.join(DATA_DIR,'comfyui');
const settingsFile=path.join(root,'connection.json');
const settings=()=>readJson(settingsFile,{url:'http://127.0.0.1:8188',key:'',enabled:false});
const publicSettings=c=>({...c,key:undefined,hasKey:Boolean(c.key)});
export const workflows=()=>fs.existsSync(path.join(root,'workflows'))?fs.readdirSync(path.join(root,'workflows')).filter(f=>f.endsWith('.json')).map(f=>readJson(path.join(root,'workflows',f))):[];
export function validateWorkflow(prompt){
 if(!prompt||typeof prompt!=='object'||Array.isArray(prompt)||prompt.nodes)throw new Error('请导入 ComfyUI 的 API 格式工作流，不是画布 JSON');
 const entries=Object.entries(prompt);if(!entries.length||entries.length>1000)throw new Error('工作流需要 1–1000 个节点');
 for(const[id,node]of entries){if(!/^[\w-]+$/.test(id)||!node||typeof node.class_type!=='string'||!node.inputs||typeof node.inputs!=='object'||Array.isArray(node.inputs))throw new Error(`节点 ${id} 不是 API 格式`);}
 return prompt;
}
function checkMapping(prompt,mapping){
 if(!Array.isArray(mapping)||mapping.length>100)throw new Error('参数映射格式错误');
 for(const m of mapping){if(!prompt[m.node]?.inputs||!Object.hasOwn(prompt[m.node].inputs,m.field)||!['prompt','image','reference','seed','width','height','literal'].includes(m.source))throw new Error(`参数映射无效：${m.node}.${m.field}`);}
}
async function request(c,p,{method='GET',body,signal,form=false}={}){
 const headers=c.key?{authorization:`Bearer ${c.key}`} : {};
 if(body&&!form)headers['content-type']='application/json';
 signal?.throwIfAborted();
 let r;try{r=await fetch(c.url.replace(/\/$/,'')+p,{method,redirect:'error',headers,body:body?(form?body:JSON.stringify(body)):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(15000)});}catch{throw new Error(signal?.aborted?'已取消':'ComfyUI 连接失败，请核对服务地址');}
 if(!r.ok)throw new Error(`ComfyUI ${r.status}，检查服务地址、认证和节点配置`);
 return r;
}
async function json(response){try{return await response.json();}catch{throw new Error('ComfyUI 返回无效数据，请在服务端核对');}}
export async function comfyRoutes(method,parts,body){
 if(parts[0]!=='comfyui')return undefined;
 const c=settings();
 if(method==='GET')return {connection:publicSettings(c),workflows:workflows()};
 if(method!=='POST')throw new Error('请求方式不支持');
 if(parts[1]==='connection'){
  const u=new URL(body.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('请输入不含账号、查询参数的 HTTP 服务地址');
  const next={url:u.href.replace(/\/$/,''),key:body.clearKey?'':body.key||c.key,enabled:body.enabled===true};atomicJson(settingsFile,next);return publicSettings(next);
 }
 if(parts[1]==='test'){
  const start=Date.now();const stats=await json(await request(c,'/system_stats'));return {ok:true,latency:Date.now()-start,devices:(stats.devices||[]).map(x=>({name:x.name,type:x.type,vram_total:x.vram_total}))};
 }
 if(parts[1]==='save'){
  validateWorkflow(body.prompt);const mapping=body.mapping||[];checkMapping(body.prompt,mapping);
  if(!body.title?.trim())throw new Error('请输入工作流名称');
  const w={id:body.id?recordId(body.id):crypto.randomUUID(),title:body.title.trim().slice(0,200),prompt:body.prompt,mapping,outputNode:String(body.outputNode||''),updatedAt:Date.now()};
  if(w.outputNode&&!w.prompt[w.outputNode])throw new Error('输出节点不存在');
  atomicJson(path.join(root,'workflows',`${w.id}.json`),w);return w;
 }
 if(parts[1]==='inspect'){
  validateWorkflow(body.prompt);const info=await json(await request(c,'/object_info'));
  const missing=[],invalid=[];
  for(const[id,node]of Object.entries(body.prompt)){
   const spec=info[node.class_type];if(!spec){missing.push({id,type:node.class_type});continue;}
   for(const[k,v]of Object.entries(node.inputs)){const input=spec.input?.required?.[k]||spec.input?.optional?.[k];if(Array.isArray(input?.[0])&&!Array.isArray(v)&&!input[0].includes(v))invalid.push({node:id,field:k,value:v,available:input[0].slice(0,100)});}
  }
  return {ok:!missing.length&&!invalid.length,missing,invalid};
 }
 throw new Error('未知 ComfyUI 操作');
}
const pause=signal=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(t);reject(new Error('已取消'));};const t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1500);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
export const comfyui={
 label:'ComfyUI · 自有工作流',
 async status(){const c=settings(),ws=workflows();return {available:c.enabled&&ws.length>0,note:!c.enabled?'未启用连接':!ws.length?'请先导入工作流':'',models:ws.map(w=>w.id),modelLabels:Object.fromEntries(ws.map(w=>[w.id,w.title]))};},
 async run(job,{log,signal}){
  if(job.upstream)throw new Error('已有上游提交记录，请恢复已有任务或人工核对，不能再次提交');
  const c=settings(),w=workflows().find(w=>w.id===job.model);if(!c.enabled||!w)throw new Error('ComfyUI 连接或工作流不存在');
  const prompt=structuredClone(w.prompt);checkMapping(prompt,w.mapping);
  if(job.inputPath&&!w.mapping.some(m=>m.source==='image'))throw new Error('工作流没有映射原图入口，已停止以免原图被忽略');
  if(job.refPaths.length&&!w.mapping.some(m=>m.source==='reference'))throw new Error('工作流没有映射参考图入口');
  const uploaded=new Map();
  async function upload(file){if(!file)throw new Error('映射需要的原图或参考图不存在');if(uploaded.has(file))return uploaded.get(file);
   const form=new FormData();form.append('image',new Blob([fs.readFileSync(file)]),`psai-${crypto.randomUUID()}.png`);form.append('type','input');
   const r=await json(await request(c,'/upload/image',{method:'POST',body:form,form:true,signal}));if(!r.name)throw new Error('ComfyUI 未返回上传文件名');const name=r.subfolder?`${r.subfolder}/${r.name}`:r.name;uploaded.set(file,name);return name;
  }
  const [rw,rh]=job.aspect.split(':').map(Number);const side=job.resolution==='4K'?4096:job.resolution==='1K'?1024:2048;
  for(const m of w.mapping){let v=m.value;
   if(m.source==='prompt')v=job.prompt;
   if(m.source==='image')v=await upload(job.inputPath);
   if(m.source==='reference')v=await upload(job.refPaths[Number(m.index)||0]);
   if(m.source==='seed')v=crypto.randomInt(0,2147483647);
   if(m.source==='width')v=Math.round(side*Math.min(1,rw/rh)/8)*8;
   if(m.source==='height')v=Math.round(side*Math.min(1,rh/rw)/8)*8;
   prompt[m.node].inputs[m.field]=v;
  }
  // Record submission intent before the network request. A timeout must not trigger a blind retry.
  job.upstream={kind:'comfyui',url:c.url,clientId:crypto.randomUUID(),state:'submitting',workflowId:w.id,outputNode:w.outputNode||'',title:w.title};persist(job);
  log('ComfyUI：提交工作流');
  const data=await json(await request(c,'/prompt',{method:'POST',body:{prompt,client_id:job.upstream.clientId},signal}));
  if(typeof data.prompt_id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(data.prompt_id))throw new Error('工作流提交未返回有效任务 ID，请核对服务端节点和模型');
  job.upstream.taskId=data.prompt_id;job.upstream.state='submitted';persist(job);
  log(`ComfyUI：等待任务 ${data.prompt_id}`);
  return pollComfy(job,{c,log,signal,cancelRemote:true});
 },
 async resume(job,{log,signal}){
  const c=settings();
  if(job.upstream?.kind!=='comfyui'||typeof job.upstream.taskId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(job.upstream.taskId))throw new Error('没有可恢复的 ComfyUI 任务 ID');
  if(c.url!==job.upstream.url)throw new Error('ComfyUI 地址已改变，请恢复原连接后查询已有任务');
  return pollComfy(job,{c,log,signal,cancelRemote:false});
 },
};

async function pollComfy(job,{c,log,signal,cancelRemote}){
 const taskId=job.upstream.taskId;
 // Old checkpoints can use their saved workflow, but never resubmit it.
 const w=workflows().find(w=>w.id===job.upstream.workflowId);
 const outputNode=job.upstream.outputNode??w?.outputNode??'';
 try{
  for(let i=0;i<2400;i++){
   signal.throwIfAborted();
   const history=await json(await request(c,`/history/${encodeURIComponent(taskId)}`,{signal})),item=history[taskId];
   if(item?.status?.status_str==='error')throw new Error('ComfyUI 执行失败，请检查工作流节点和模型');
   // History can contain partial outputs before completion; do not freeze a partial batch.
   if(item?.outputs&&item.status?.completed!==false){
    const outputs=outputNode?[[outputNode,item.outputs[outputNode]]]:Object.entries(item.outputs);
    const images=outputs.flatMap(([node,out])=>(out?.images||[]).map(image=>({node,...image}))).filter(x=>x.type==='output');
    if(images.length){
     job.upstream.outputs=images.slice(0,16).map(({node,filename,subfolder,type})=>({node,filename,subfolder,type}));persist(job);
     return await downloadCandidates(job,images, image=>{
      const q=new URLSearchParams({filename:image.filename,subfolder:image.subfolder||'',type:'output'});
      return request(c,`/view?${q}`,{signal});
     },{signal,source:`ComfyUI · ${job.upstream.title||w?.title||'已有任务'}`});
    }
    if(item.status?.completed)throw new Error('工作流已完成，但选定节点没有图像输出');
   }
   await pause(signal);
  }
  throw new Error('ComfyUI 一小时内未完成，请按任务 ID 在服务端核对');
 }catch(e){
  if(signal.aborted){
   if(cancelRemote){await request(c,'/queue',{method:'POST',body:{delete:[taskId]}}).catch(()=>{});log('已停止本地等待并移除待执行项；若服务端已经运行，请在 ComfyUI 中停止此任务');}
   else log('已停止本地恢复，未修改上游任务');
   throw new Error('已取消');
  }
  // Network/image decoders may include URLs or response contents in their errors.
  throw new Error(`ComfyUI 查询或下载失败；已有任务 ID 已保留，请核对服务和输出限制${/超过.*限制/.test(e.message)?'（候选图超过大小限制）':''}`);
 }
}
