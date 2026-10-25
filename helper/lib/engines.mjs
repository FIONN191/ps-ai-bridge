import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { DATA_DIR } from './paths.mjs';
import { ROOT } from './config.mjs';
import { atomicJson, readJson, recordId } from './store.mjs';
import { useUpload, getJob, variantPath, appliedVariant, createLocalResult } from './jobs.mjs';
const dir=path.join(DATA_DIR,'engines','matting'), modelsDir=path.join(dir,'models');
const python=path.join(dir,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const stateFile=path.join(dir,'state.json');
const work=new Map();
const children=new Set();
process.on('exit',()=>{for(const child of children)child.kill();});
const catalog=[{id:'u2netp',name:'轻量抠像',file:'u2netp.onnx',size:'约 5 MB'},{id:'u2net_human_seg',name:'人物抠像',file:'u2net_human_seg.onnx',size:'约 176 MB'},{id:'isnet-general-use',name:'通用精细抠像',file:'isnet-general-use.onnx',size:'约 179 MB'}];
const modelFile=m=>[path.join(modelsDir,'models',m.id,m.file),path.join(modelsDir,m.file)].find(fs.existsSync);
let state=readJson(stateFile,{phase:'missing',log:[],ready:false});
if(['installing','downloading'].includes(state.phase))state={...state,phase:'interrupted',error:'上次安装或下载被中断，可以重试'};
const runsDir=path.join(dir,'runs');
if(fs.existsSync(runsDir))for(const id of fs.readdirSync(runsDir)){const r=readJson(path.join(runsDir,id,'operation.json'),null);if(r){if(r.status==='running'){r.status='interrupted';r.error='服务重启，本地推理已中断，请重新运行';}work.set(id,{...r,abort:new AbortController()});}}
const set=s=>{state={...state,...s,updatedAt:Date.now()};atomicJson(stateFile,state);};
function status(){return {...state,pythonReady:fs.existsSync(python),models:catalog.map(m=>({...m,installed:!!modelFile(m)})),operations:[...work.values()].map(({child,abort,...r})=>r)};}
function run(exe,args,onLine,signal){return new Promise((resolve,reject)=>{
 const child=spawn(exe,args,{windowsHide:true,env:{...process.env,U2NET_HOME:modelsDir,UV_PYTHON_INSTALL_DIR:path.join(dir,'python'),UV_CACHE_DIR:path.join(dir,'cache'),PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});
 children.add(child);
 let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('操作超时，请查看引擎日志后重试'));},30*60*1000);
 const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
 child.stdout.on('data',b=>{out=(out+b).slice(-30000);onLine?.(String(b));});child.stderr.on('data',b=>{err=(err+b).slice(-30000);onLine?.(String(b));});
 child.once('error',e=>{children.delete(child);clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});
 child.once('close',code=>{children.delete(child);clearTimeout(timer);signal?.removeEventListener('abort',abort);code===0?resolve(out):reject(new Error(signal?.aborted?'已取消':`引擎退出 ${code}：${err.slice(-1200)}`));});
 if(signal?.aborted)abort();
});}
const log=text=>set({log:[...(state.log||[]),...text.trim().split('\n')].slice(-60)});
// Extract only the uv executable from a PyPI wheel, never arbitrary archive paths.
async function bootstrapUv(){
 const existing=[path.join(os.homedir(),'.local','bin',process.platform==='win32'?'uv.exe':'uv'),...String(process.env.PATH||'').split(path.delimiter).map(d=>path.join(d,process.platform==='win32'?'uv.exe':'uv'))].find(fs.existsSync);
 if(existing)return existing;
 const dest=path.join(dir,'bin',process.platform==='win32'?'uv.exe':'uv');if(fs.existsSync(dest))return dest;
 const meta=await(await fetch('https://pypi.org/pypi/uv/0.13.5/json',{signal:AbortSignal.timeout(30000)})).json();
 const suffix=process.platform==='win32'?'win_amd64.whl':process.arch==='arm64'?'macosx_11_0_arm64.whl':'macosx_10_12_x86_64.whl';
 const asset=meta.urls.find(x=>x.filename.endsWith(suffix));if(!asset)throw new Error('当前系统没有匹配的 uv 安装包');
 const response=await fetch(asset.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('uv 下载失败');const buf=Buffer.from(await response.arrayBuffer());
 if(crypto.createHash('sha256').update(buf).digest('hex')!==asset.digests.sha256)throw new Error('uv 下载校验失败');
 let end=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0)throw new Error('uv 安装包格式无效');
 let offset=buf.readUInt32LE(end+16),binary=null;
 for(let i=0;i<buf.readUInt16LE(end+10);i++){
  if(buf.readUInt32LE(offset)!==0x02014b50)throw new Error('uv 文件表无效');
  const method=buf.readUInt16LE(offset+10),compressed=buf.readUInt32LE(offset+20),nameLen=buf.readUInt16LE(offset+28),extra=buf.readUInt16LE(offset+30),comment=buf.readUInt16LE(offset+32),local=buf.readUInt32LE(offset+42),name=buf.subarray(offset+46,offset+46+nameLen).toString();
  if(name.endsWith(process.platform==='win32'?'/uv.exe':'/uv')){const start=local+30+buf.readUInt16LE(local+26)+buf.readUInt16LE(local+28);const data=buf.subarray(start,start+compressed);binary=method===8?inflateRawSync(data):method===0?data:null;break;}
  offset+=46+nameLen+extra+comment;
 }
 if(!binary)throw new Error('安装包未包含 uv');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,binary,{mode:0o755});return dest;
}
async function install(){
 if(['installing','downloading'].includes(state.phase))throw new Error('已有安装或下载正在进行');
 set({phase:'installing',error:null,log:[],ready:false});
 (async()=>{try{const uv=await bootstrapUv();log('准备隔离 Python 3.11 环境');if(!fs.existsSync(python))await run(uv,['venv','--python','3.11',path.join(dir,'venv')],log);log('安装 rembg 与 CPU 推理依赖');await run(uv,['pip','install','--python',python,'rembg[cpu]==2.0.86'],log);await run(python,[path.join(ROOT,'engine','matting.py'),'probe'],log);set({phase:'ready',ready:true});}catch(e){set({phase:'error',error:e.message,ready:false});}})();
 return status();
}
async function download(model){
 if(!state.ready||!fs.existsSync(python))throw new Error('先安装本地引擎');
 if(['installing','downloading'].includes(state.phase))throw new Error('已有安装或下载正在进行');
 if(!catalog.some(m=>m.id===model))throw new Error('未知模型');
 set({phase:'downloading',error:null,log:[]});
 (async()=>{try{await run(python,[path.join(ROOT,'engine','matting.py'),'download','--model',model],log);const file=modelFile(catalog.find(m=>m.id===model));const digest=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');set({phase:'ready',ready:true,lastModel:{id:model,sha256:digest,verifiedAt:Date.now()}});}catch(e){set({phase:'error',error:e.message});}})();return status();
}
export async function engineRoutes(method,parts,body={}){
 if(parts[0]!=='engine')return undefined;
 if(method==='GET')return status();
 if(method!=='POST')throw new Error('请求方式无效');
 if(parts[1]==='install')return install();
 if(parts[1]==='download')return download(body.model);
 if(parts[1]==='cancel'){const r=work.get(body.id);if(r?.status==='running')r.abort.abort();return status();}
 if(parts[1]==='run'){
  if([...work.values()].some(x=>x.status==='running'))throw new Error('本地引擎正在处理另一张图');
  const m=catalog.find(m=>m.id===body.model);if(!m||!state.ready||!modelFile(m))throw new Error('先安装引擎并下载所选模型');
  let src;if(body.jobId){const j=getJob(body.jobId);if(!j?.result)throw new Error('结果不存在');src=await variantPath(j,appliedVariant(j));}else src=useUpload(body.uploadId);
  if(!src)throw new Error('先选择原图');
  const erode=Number(body.erode||0),feather=Number(body.feather||0);if(!Number.isInteger(erode)||Math.abs(erode)>15||!Number.isFinite(feather)||feather<0||feather>30)throw new Error('修边参数无效');
  const id=crypto.randomUUID(),outdir=path.join(dir,'runs',id);fs.mkdirSync(outdir,{recursive:true});const input=path.join(outdir,`input${path.extname(src)}`);fs.copyFileSync(src,input);
  const operation={id,status:'running',stage:'正在本机抠像',createdAt:Date.now(),abort:new AbortController()};work.set(id,operation);atomicJson(path.join(outdir,'operation.json'),{...operation,abort:undefined});
  (async()=>{try{const output=path.join(outdir,'cutout.png'),mask=path.join(outdir,'mask.png');await run(python,[path.join(ROOT,'engine','matting.py'),'matte','--model',m.id,'--input',input,'--output',output,'--mask',mask,'--erode',String(erode),'--feather',String(feather)],t=>{operation.stage=t.trim().slice(-250);},operation.abort.signal);
   const job=await createLocalResult({sourcePath:input,buffer:fs.readFileSync(output),title:`本地抠像 · ${m.name}`,parameters:{model:m.id,erode,feather}});
   fs.copyFileSync(mask,path.join(job.dir,'mask.png'));operation.status='done';operation.jobId=job.id;
  }catch(e){operation.status=operation.abort.signal.aborted?'cancelled':'error';operation.error=e.message;}finally{operation.finishedAt=Date.now();atomicJson(path.join(outdir,'operation.json'),{...operation,abort:undefined});}})();
  return {id,status:'running'};
 }
 throw new Error('未知引擎操作');
}
