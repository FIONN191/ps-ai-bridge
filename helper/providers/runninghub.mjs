import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR } from '../lib/paths.mjs';
import { atomicJson, readJson } from '../lib/store.mjs';
import { persist } from '../lib/jobs.mjs';
const file=path.join(DATA_DIR,'runninghub.json');
const settings=()=>readJson(file,{url:'https://www.runninghub.ai',key:'',enabled:false,workflows:[]});
const sanitize=(message,key)=>String(message||'').split(key||'\u0000').join('[已隐藏]').slice(0,600);
async function request(c,route,body,signal,form=false){
 const r=await fetch(c.url+route,{method:'POST',headers:{authorization:`Bearer ${c.key}`,...(!form?{'content-type':'application/json'}:{})},body:form?body:JSON.stringify({apiKey:c.key,...body}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error(`RunningHub HTTP ${r.status}`);return r.json();
}
export async function runninghubRoutes(method,parts,body={}){
 if(parts[0]!=='runninghub')return undefined;const c=settings();
 if(method==='GET')return {...c,key:undefined,hasKey:!!c.key};
 if(method!=='POST')throw new Error('请求方式无效');
 if(parts[1]==='connection'){
  const u=new URL(body.url);if(u.protocol!=='https:'||!['www.runninghub.ai','www.runninghub.cn'].includes(u.hostname)||u.username||u.password||u.pathname!=='/')throw new Error('请选择 RunningHub 官方服务地址');
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
  const c=settings(),w=c.workflows.find(w=>w.id===job.model);if(!c.enabled||!c.key||!w)throw new Error('RunningHub 连接或工作流未配置');
  if(job.inputPath&&!w.mapping.some(m=>m.source==='image'))throw new Error('工作流未映射原图节点，已停止提交');
  if(job.refPaths.length&&!w.mapping.some(m=>m.source==='reference'))throw new Error('工作流未映射参考图节点');
  const uploads=new Map();async function upload(p){if(!p)throw new Error('映射需要的图片不存在');if(uploads.has(p))return uploads.get(p);const data=fs.readFileSync(p);if(data.length>30*1024*1024)throw new Error('RunningHub 单张上传超过 30 MB');const form=new FormData();form.append('apiKey',c.key);form.append('fileType','input');form.append('file',new Blob([data],{type:p.endsWith('.png')?'image/png':'image/jpeg'}),path.basename(p));const r=await request(c,'/task/openapi/upload',form,signal,true);if(r.code!==0||!r.data?.fileName)throw new Error(`上传失败 ${r.code}: ${sanitize(r.msg,c.key)}`);uploads.set(p,r.data.fileName);return r.data.fileName;}
  const [rw,rh]=job.aspect.split(':').map(Number), side=job.resolution==='4K'?4096:job.resolution==='1K'?1024:2048;
  const nodeInfoList=[];for(const m of w.mapping){let value=m.value;if(m.source==='prompt')value=job.prompt;if(m.source==='image')value=await upload(job.inputPath);if(m.source==='reference')value=await upload(job.refPaths[Number(m.index)||0]);if(m.source==='seed')value=crypto.randomInt(0,2147483647);if(m.source==='width')value=Math.round(side*Math.min(1,rw/rh)/8)*8;if(m.source==='height')value=Math.round(side*Math.min(1,rh/rw)/8)*8;nodeInfoList.push({nodeId:m.nodeId,fieldName:m.fieldName,fieldValue:value});}
  job.upstream={kind:'runninghub',url:c.url,workflowId:w.workflowId,state:'submitting'};persist(job);log('RunningHub：提交工作流');
  const r=await request(c,'/task/openapi/create',{workflowId:w.workflowId,nodeInfoList},signal);
  if(r.code!==0||!r.data?.taskId)throw new Error(`RunningHub ${r.code}: ${sanitize(r.msg,c.key)}`);
  const taskId=String(r.data.taskId);job.upstream.taskId=taskId;job.upstream.state='submitted';persist(job);log(`RunningHub：任务 ${taskId}`);
  try{
   for(let i=0;i<720;i++){
    const d=await request(c,'/task/openapi/outputs',{taskId},signal);
    if([804,813].includes(d.code)){await sleep(signal);continue;}
    if(d.code!==0)throw new Error(`RunningHub ${d.code}: ${sanitize(d.msg,c.key)}`);
    if(!Array.isArray(d.data)||!d.data.length){await sleep(signal);continue;}
    job.upstream.outputs=d.data;persist(job);
    const images=d.data.filter(x=>/^(png|jpg|jpeg|webp)$/i.test(x.fileType||'')&&(!w.outputNode||String(x.nodeId)===w.outputNode));
    if(images.length!==1)throw new Error(`指定输出包含 ${images.length} 张图，请选择单图输出节点；云端结果已保留`);
    const image=images[0],u=new URL(image.fileUrl);if(u.protocol!=='https:')throw new Error('结果链接不是 HTTPS');
    const result=await fetch(u,{signal:AbortSignal.any([signal,AbortSignal.timeout(90000)])});if(!result.ok)throw new Error('结果下载失败，可按任务 ID 在 RunningHub 找回');
    const out=path.join(job.dir,'result-runninghub.png');const info=await sharp(Buffer.from(await result.arrayBuffer())).png().toFile(out);job.upstream.state='downloaded';persist(job);return {path:out,width:info.width,height:info.height,source:`RunningHub · ${w.title}`};
   }
   throw new Error('一小时内未完成，请用任务 ID 在 RunningHub 核对');
  }catch(e){if(signal.aborted){const cancelled=await request(c,'/task/openapi/cancel',{taskId}).catch(()=>null);job.upstream.cancelConfirmed=cancelled?.code===0;persist(job);log(job.upstream.cancelConfirmed?'RunningHub 已确认取消':'本地等待已停止，云端取消未确认，请按任务 ID 核对');}throw e;}
 },
};
