import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../lib/paths.mjs';
import { atomicJson, readJson } from '../lib/store.mjs';
import { persist, downloadCandidates } from '../lib/jobs.mjs';
const file=path.join(DATA_DIR,'runninghub.json');
const settings=()=>readJson(file,{url:'https://www.runninghub.ai',key:'',enabled:false,workflows:[]});
const sanitize=(message,key)=>String(message||'').split(key||'\u0000').join('[已隐藏]').slice(0,600);
async function request(c,route,body,signal,form=false){
 signal?.throwIfAborted();
 let r;try{r=await fetch(c.url+route,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${c.key}`,...(!form?{'content-type':'application/json'}:{})},body:form?body:JSON.stringify({apiKey:c.key,...body}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(30000)});}catch{throw new Error(signal?.aborted?'已取消':'RunningHub 连接失败，请核对服务地址');}
 if(!r.ok)throw new Error(`RunningHub HTTP ${r.status}`);try{return await r.json();}catch{throw new Error('RunningHub 返回无效数据，请在服务端核对');}
}
export async function runninghubRoutes(method,parts,body={}){
 if(parts[0]!=='runninghub')return undefined;const c=settings();
 if(method==='GET')return {...c,key:undefined,hasKey:!!c.key};
 if(method!=='POST')throw new Error('请求方式无效');
 if(parts[1]==='connection'){
  const u=new URL(body.url);if(u.protocol!=='https:'||!['www.runninghub.ai','www.runninghub.cn'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('请选择 RunningHub 官方服务地址');
  const next={...c,url:u.origin,key:body.clearKey?'':body.key||c.key,enabled:body.enabled===true};atomicJson(file,next);return {...next,key:undefined,hasKey:!!next.key};
 }
 if(parts[1]==='workflow'){
  if(!body.title?.trim()||!/^\d+$/.test(body.workflowId||''))throw new Error('填写名称及数字工作流 ID');
  const nodes=body.mapping;if(!Array.isArray(nodes)||nodes.length>100)throw new Error('节点映射无效');
  for(const n of nodes)if(!/^\d+$/.test(n.nodeId)||!n.fieldName||!['prompt','image','reference','seed','width','height','literal'].includes(n.source))throw new Error('节点 ID、字段或参数来源无效');
  const w={id:body.id||crypto.randomUUID(),title:body.title.trim().slice(0,200),workflowId:body.workflowId,mapping:nodes,outputNode:String(body.outputNode||'')};
  c.workflows=[...c.workflows.filter(x=>x.id!==w.id),w];atomicJson(file,c);return w;
 }
 if(parts[1]==='test'){
  if(!c.key)throw new Error('先保存 RunningHub 密钥');const start=Date.now();const r=await request(c,'/uc/openapi/accountStatus',{apikey:c.key});if(r.code!==0)throw new Error(`RunningHub ${r.code}: ${sanitize(r.msg,c.key)}`);
  return {ok:true,latency:Date.now()-start,balance:r.data?.remainCoins??null,activeTasks:r.data?.currentTaskCounts??null};
 }
 throw new Error('未知 RunningHub 操作');
}
const sleep=signal=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(t);reject(new Error('已取消'));};const t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},5000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
export const runninghub={
 label:'RunningHub · 自有工作流',
 async status(){const c=settings();return {available:c.enabled&&!!c.key&&c.workflows.length>0,note:!c.enabled?'未启用连接':!c.key?'未填密钥':!c.workflows.length?'请添加工作流':'',models:c.workflows.map(w=>w.id),modelLabels:Object.fromEntries(c.workflows.map(w=>[w.id,w.title]))};},
 async run(job,{log,signal}){
  if(job.upstream)throw new Error('已有上游提交记录，请恢复已有任务或人工核对，不能再次提交');
  const c=settings(),w=c.workflows.find(w=>w.id===job.model);if(!c.enabled||!c.key||!w)throw new Error('RunningHub 连接或工作流未配置');
  if(job.inputPath&&!w.mapping.some(m=>m.source==='image'))throw new Error('工作流未映射原图节点，已停止提交');
  if(job.refPaths.length&&!w.mapping.some(m=>m.source==='reference'))throw new Error('工作流未映射参考图节点');
  const uploads=new Map();async function upload(p){if(!p)throw new Error('映射需要的图片不存在');if(uploads.has(p))return uploads.get(p);const data=fs.readFileSync(p);if(data.length>30*1024*1024)throw new Error('RunningHub 单张上传超过 30 MB');const form=new FormData();form.append('apiKey',c.key);form.append('fileType','input');form.append('file',new Blob([data],{type:p.endsWith('.png')?'image/png':'image/jpeg'}),path.basename(p));const r=await request(c,'/task/openapi/upload',form,signal,true);if(r.code!==0||!r.data?.fileName)throw new Error(`上传失败 ${r.code}: ${sanitize(r.msg,c.key)}`);uploads.set(p,r.data.fileName);return r.data.fileName;}
  const [rw,rh]=job.aspect.split(':').map(Number), side=job.resolution==='4K'?4096:job.resolution==='1K'?1024:2048;
  const nodeInfoList=[];for(const m of w.mapping){let value=m.value;if(m.source==='prompt')value=job.prompt;if(m.source==='image')value=await upload(job.inputPath);if(m.source==='reference')value=await upload(job.refPaths[Number(m.index)||0]);if(m.source==='seed')value=crypto.randomInt(0,2147483647);if(m.source==='width')value=Math.round(side*Math.min(1,rw/rh)/8)*8;if(m.source==='height')value=Math.round(side*Math.min(1,rh/rw)/8)*8;nodeInfoList.push({nodeId:m.nodeId,fieldName:m.fieldName,fieldValue:value});}
  job.upstream={kind:'runninghub',url:c.url,workflowId:w.workflowId,outputNode:w.outputNode||'',title:w.title,state:'submitting'};persist(job);log('RunningHub：提交工作流');
  const r=await request(c,'/task/openapi/create',{workflowId:w.workflowId,nodeInfoList},signal);
  if(r.code!==0||!['string','number'].includes(typeof r.data?.taskId)||(typeof r.data.taskId==='number'&&!Number.isSafeInteger(r.data.taskId))||!/^[a-zA-Z0-9_-]{1,200}$/.test(String(r.data.taskId)))throw new Error('RunningHub 提交未返回有效任务 ID，请在服务端核对');
  const taskId=String(r.data.taskId);job.upstream.taskId=taskId;job.upstream.state='submitted';persist(job);log(`RunningHub：任务 ${taskId}`);
  return pollRunninghub(job,{c,log,signal,cancelRemote:true});
 },
 async resume(job,{log,signal}){
  const c=settings();
  if(job.upstream?.kind!=='runninghub'||typeof job.upstream.taskId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(job.upstream.taskId))throw new Error('没有可恢复的 RunningHub 任务 ID');
  if(c.url!==job.upstream.url||!c.key)throw new Error('请恢复原 RunningHub 连接和密钥后查询已有任务');
  return pollRunninghub(job,{c,log,signal,cancelRemote:false});
 },
};

async function pollRunninghub(job,{c,log,signal,cancelRemote}){
 const taskId=job.upstream.taskId,w=c.workflows.find(w=>w.id===job.model);
 const outputNode=job.upstream.outputNode??w?.outputNode??'';
 try{
  for(let i=0;i<720;i++){
   signal.throwIfAborted();
   const d=await request(c,'/task/openapi/outputs',{taskId},signal);
   if([804,813].includes(d.code)){await sleep(signal);continue;}
   if(d.code!==0)throw new Error('RunningHub 未返回成功结果');
   if(!Array.isArray(d.data)||!d.data.length){await sleep(signal);continue;}
   const images=d.data.filter(x=>/^(png|jpg|jpeg|webp)$/i.test(x.fileType||'')&&(!outputNode||String(x.nodeId)===outputNode));
   // Signed URLs are credentials too: keep them only in memory and fetch fresh links on recovery.
   job.upstream.outputs=images.slice(0,16).map(({nodeId,fileType})=>({nodeId,fileType}));persist(job);
   return await downloadCandidates(job,images,async image=>{
    const u=new URL(image.fileUrl);if(u.protocol!=='https:'||u.username||u.password)throw new Error('结果链接无效');
    return fetch(u,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(90000)])});
   },{signal,source:`RunningHub · ${job.upstream.title||w?.title||'已有任务'}`});
  }
  throw new Error('一小时内未完成，请用任务 ID 在 RunningHub 核对');
 }catch(e){
  if(signal.aborted){
   if(cancelRemote){const cancelled=await request(c,'/task/openapi/cancel',{taskId}).catch(()=>null);job.upstream.cancelConfirmed=cancelled?.code===0;persist(job);log(job.upstream.cancelConfirmed?'RunningHub 已确认取消':'本地等待已停止，云端取消未确认，请按任务 ID 核对');}
   else log('已停止本地恢复，未修改上游任务');
   throw new Error('已取消');
  }
  throw new Error(`RunningHub 查询或下载失败；已有任务 ID 已保留，请核对服务和输出限制${/超过.*限制/.test(e.message)?'（候选图超过大小限制）':''}`);
 }
}
