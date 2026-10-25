import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { DATA_DIR } from './paths.mjs';
import { ROOT } from './config.mjs';
import { atomicJson, readJson, recordId } from './store.mjs';
import { useUpload, getJob, variantPath, appliedVariant, createLocalResult, persist } from './jobs.mjs';
const dir=path.join(DATA_DIR,'engines','matting'), modelsDir=path.join(dir,'models');
const python=path.join(dir,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const stateFile=path.join(dir,'state.json');
const work=new Map();
const children=new Set();
let maintenance=null, maintenanceAbort=null, stopping=null;
const activeRuns=new Set();
const trashDir=path.join(DATA_DIR,'engines','trash');
function signalWorker(child,signal='SIGTERM'){
 if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,signal);return;}catch(e){if(e.code==='ESRCH')return;}}
 child.kill(signal);
}
process.on('exit',()=>{for(const child of children)signalWorker(child);});
export const engineCatalog=[
 {id:'u2netp',name:'轻量抠像',file:'u2netp.onnx',size:'约 5 MB',md5:'8e83ca70e441ab06c318d82300c84806'},
 {id:'u2net_human_seg',name:'人物抠像',file:'u2net_human_seg.onnx',size:'约 176 MB',md5:'c09ddc2e0104f800e3e1bb4652583d1f'},
 {id:'isnet-general-use',name:'通用精细抠像',file:'isnet-general-use.onnx',size:'约 179 MB',md5:'fc16ebd8b0c10d971d3513d564d01e29'},
].map(m=>({...m,source:`https://github.com/danielgatis/rembg/releases/download/v0.0.0/${m.file}`,publisher:'danielgatis/rembg',checksumSource:'https://github.com/danielgatis/rembg/tree/main/rembg/sessions',runtime:'rembg[cpu]==2.0.86',backend:'CPUExecutionProvider'}));
const catalog=engineCatalog;
const modelFile=m=>[path.join(modelsDir,'models',m.id,m.file),path.join(modelsDir,m.file)].find(fs.existsSync);
let state=readJson(stateFile,{phase:'missing',log:[],ready:false});
if(['installing','downloading','probing'].includes(state.phase))state={...state,phase:'interrupted',error:'上次安装或下载被中断，可以重试'};
const runsDir=path.join(dir,'runs');
if(fs.existsSync(runsDir))for(const id of fs.readdirSync(runsDir)){const r=readJson(path.join(runsDir,id,'operation.json'),null);if(r){if(r.status==='running'){r.status='interrupted';r.error='服务重启，本地推理已中断，请重新运行';}work.set(id,{...r,abort:new AbortController()});}}
const set=s=>{state={...state,...s,updatedAt:Date.now()};atomicJson(stateFile,state);};
function status(){return {...state,ready:state.ready&&fs.existsSync(python),pythonReady:fs.existsSync(python),busy:busy(),backend:'CPUExecutionProvider',
 models:catalog.map(m=>({...m,installed:!!modelFile(m),verification:state.models?.[m.id]||null})),
 trash:fs.existsSync(trashDir)?fs.readdirSync(trashDir).map(id=>readJson(path.join(trashDir,id,'manifest.json'),null)).filter(Boolean):[],
 operations:[...work.values()].map(({child,abort,...r})=>r)};}
function busy(){return Boolean(stopping)||Boolean(maintenance)||children.size>0||[...work.values()].some(r=>r.status==='running');}
function assertIdle(){if(busy())throw new Error('引擎正在运行、探测或安装；请先停止并等待进程退出');}
function run(exe,args,onLine,signal){return new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(new Error('已取消'));
 const env={...process.env};delete env.MODEL_CHECKSUM_DISABLED;
 const child=spawn(exe,args,{windowsHide:true,detached:process.platform!=='win32',env:{...env,U2NET_HOME:modelsDir,UV_PYTHON_INSTALL_DIR:path.join(dir,'python'),UV_CACHE_DIR:path.join(dir,'cache'),PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});
 children.add(child);let out='',err='',timedOut=false,killTimer;
 let treeStop=null;
 const stop=()=>{
  if(process.platform==='win32'&&child.pid){
   treeStop??=new Promise(done=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>{child.kill();done();});killer.once('close',done);});
  }else signalWorker(child);
  killTimer??=setTimeout(()=>signalWorker(child,'SIGKILL'),5000);
 };
 const timer=setTimeout(()=>{timedOut=true;stop();},30*60*1000);
 const abort=()=>stop();signal?.addEventListener('abort',abort,{once:true});
 const cleanup=()=>{children.delete(child);clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
 child.stdout.on('data',b=>{out=(out+b).slice(-30000);onLine?.(String(b));});child.stderr.on('data',b=>{err=(err+b).slice(-30000);onLine?.(String(b));});
 child.once('error',e=>{cleanup();reject(e);});
 child.once('close',async code=>{if(treeStop)await treeStop;cleanup();if(signal?.aborted)return reject(new Error('已取消'));if(timedOut)return reject(new Error('操作超时，进程已退出'));code===0?resolve(out):reject(new Error(`引擎退出 ${code}：${err.slice(-1200)}`));});
 if(signal?.aborted)abort();
});}
async function verifyModel(model){
 const file=modelFile(model);if(!file)throw new Error(`模型缺失：${model.file}，请先下载`);
 const md5=crypto.createHash('md5'),sha=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file)){md5.update(chunk);sha.update(chunk);}
 const digest=md5.digest('hex');if(digest!==model.md5)throw new Error(`模型校验失败：${model.file}，请移入回收区后重新下载`);
 const verified={id:model.id,md5:digest,sha256:sha.digest('hex'),verifiedAt:Date.now(),bytes:fs.statSync(file).size,source:model.source};
 set({models:{...state.models,[model.id]:verified},lastModel:verified});return verified;
}
function startMaintenance(phase,action){
 assertIdle();maintenanceAbort=new AbortController();const signal=maintenanceAbort.signal;
 set({phase,error:null,log:[]});
 maintenance=Promise.resolve().then(()=>action(signal)).catch(e=>set({phase:signal.aborted?'stopped':'error',error:e.message})).finally(()=>{maintenance=null;maintenanceAbort=null;});
 return status();
}
const log=text=>set({log:[...(state.log||[]),...text.trim().split('\n')].slice(-60)});
// Extract only the uv executable from a PyPI wheel, never arbitrary archive paths.
async function bootstrapUv(signal){
 signal?.throwIfAborted();
 const existing=[path.join(os.homedir(),'.local','bin',process.platform==='win32'?'uv.exe':'uv'),...String(process.env.PATH||'').split(path.delimiter).map(d=>path.join(d,process.platform==='win32'?'uv.exe':'uv'))].find(fs.existsSync);
 if(existing)return existing;
 const dest=path.join(dir,'bin',process.platform==='win32'?'uv.exe':'uv');if(fs.existsSync(dest))return dest;
 const meta=await(await fetch('https://pypi.org/pypi/uv/0.13.5/json',{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])})).json();
 const suffix=process.platform==='win32'?'win_amd64.whl':process.arch==='arm64'?'macosx_11_0_arm64.whl':'macosx_10_12_x86_64.whl';
 const asset=meta.urls.find(x=>x.filename.endsWith(suffix));if(!asset)throw new Error('当前系统没有匹配的 uv 安装包');
 const response=await fetch(asset.url,{signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])});if(!response.ok)throw new Error('uv 下载失败');const buf=Buffer.from(await response.arrayBuffer());
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
 signal?.throwIfAborted();if(!binary)throw new Error('安装包未包含 uv');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,binary,{mode:0o755});return dest;
}
async function install(){
 return startMaintenance('installing',async signal=>{set({ready:false});const uv=await bootstrapUv(signal);log('准备隔离 Python 3.11 环境');
 if(!fs.existsSync(python))await run(uv,['venv','--python','3.11',path.join(dir,'venv')],log,signal);
 log('安装 rembg 与 CPU 推理依赖');await run(uv,['pip','install','--python',python,'rembg[cpu]==2.0.86'],log,signal);
 const result=await run(python,[path.join(ROOT,'engine','matting.py'),'probe'],log,signal);
 set({phase:'ready',ready:true,probe:JSON.parse(result.trim().split('\n').at(-1))});});
}
async function download(model){
 if(!state.ready||!fs.existsSync(python))throw new Error('先安装本地引擎');
 const m=catalog.find(m=>m.id===model);if(!m)throw new Error('未知模型');
 return startMaintenance('downloading',async signal=>{await run(python,[path.join(ROOT,'engine','matting.py'),'download','--model',model],log,signal);await verifyModel(m);signal.throwIfAborted();set({phase:'ready',ready:true});});
}
export async function stopEngine(){
 if(stopping)return stopping;
 maintenanceAbort?.abort();for(const r of work.values())if(r.status==='running')r.abort.abort();
 stopping=(async()=>{
  try{await Promise.allSettled([...(maintenance?[maintenance]:[]),...activeRuns]);
   if(children.size)throw new Error('进程尚未退出，未移动任何环境或模型文件');
   set({phase:state.ready?'ready':'stopped'});
  }finally{stopping=null;}
  return status();
 })();
 return stopping;
}
// App-managed trash stays on the same volume. Nothing is deleted; runs and outputs are excluded.
const environmentPaths=['venv','python','bin','cache'];
const allowedRecoveryPaths=()=>[...environmentPaths,...catalog.flatMap(c=>[`models/${c.file}`,`models/models/${c.id}/${c.file}`])];
function trash(target,model){
 assertIdle();const id=crypto.randomUUID();let entries;
 if(target==='model'){
  const m=catalog.find(m=>m.id===model);if(!m)throw new Error('未知模型');
  entries=[`models/${m.file}`,`models/models/${m.id}/${m.file}`].filter(p=>fs.existsSync(path.join(dir,p)));
 }else if(target==='environment')entries=environmentPaths.filter(p=>fs.existsSync(path.join(dir,p)));
 else throw new Error('请选择 environment 或 model');
 if(!entries.length)throw new Error(target==='model'?'模型未安装':'环境尚未安装');
 const dest=path.join(trashDir,id);fs.mkdirSync(dest,{recursive:true});
 const manifest={id,target,model:target==='model'?model:null,entries,createdAt:Date.now(),state:'prepared'};atomicJson(path.join(dest,'manifest.json'),manifest);
 const moved=[];
 try{for(const relative of entries){const to=path.join(dest,'payload',relative);fs.mkdirSync(path.dirname(to),{recursive:true});fs.renameSync(path.join(dir,relative),to);moved.push(relative);}}
 catch(e){for(const relative of moved.reverse())fs.renameSync(path.join(dest,'payload',relative),path.join(dir,relative));throw e;}
 manifest.state='trashed';atomicJson(path.join(dest,'manifest.json'),manifest);
 if(target==='environment')set({ready:false,phase:'missing'});return status();
}
function restore(id){
 assertIdle();const folder=path.join(trashDir,recordId(id)),m=readJson(path.join(folder,'manifest.json'),null);
 if(!m||!['prepared','trashed'].includes(m.state))throw new Error('回收记录不存在或已恢复');
 const entries=m.entries||[m.relative],allowed=allowedRecoveryPaths();
 if(!entries.length||entries.some(p=>typeof p!=='string'||!allowed.includes(p.split(path.sep).join('/'))))throw new Error('回收记录路径无效');
 const source=p=>m.entries?path.join(folder,'payload',p):path.join(folder,'payload');
 // A prepared manifest may represent an interrupted multi-file move. Restore only the moved entries.
 const moved=entries.filter(p=>fs.existsSync(source(p)));
 if(!moved.length)throw new Error('回收区没有待恢复文件');
 if(moved.some(p=>fs.existsSync(path.join(dir,p))))throw new Error('目标已有文件；为避免覆盖，请先移入回收区');
 const restored=[];
 try{for(const relative of moved){const dest=path.join(dir,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(source(relative),dest);restored.push(relative);}}
 catch(e){for(const relative of restored.reverse())fs.renameSync(path.join(dir,relative),source(relative));throw e;}
 m.state='restored';m.restoredAt=Date.now();atomicJson(path.join(folder,'manifest.json'),m);
 if(m.target==='environment')set({phase:'restored',ready:false,error:'环境已恢复，请运行安装/修复探测依赖后使用'});return status();
}
export async function engineRoutes(method,parts,body={}){
 if(parts[0]!=='engine')return undefined;
 if(method==='GET')return status();
 if(method!=='POST')throw new Error('请求方式无效');
 if(parts[1]==='stop')return stopEngine();
 if(parts[1]==='uninstall')return trash(body.target,body.model);
 if(parts[1]==='restore')return restore(body.id);
 if(parts[1]==='probe'){
  const m=catalog.find(m=>m.id===body.model);if(!m)throw new Error('请选择要真实推理探测的模型');
  if(!fs.existsSync(python))throw new Error('先安装引擎环境');
  return startMaintenance('probing',async signal=>{await verifyModel(m);const out=await run(python,[path.join(ROOT,'engine','matting.py'),'probe','--inference','--model',m.id],log,signal);set({phase:'ready',ready:true,probe:JSON.parse(out.trim().split('\n').at(-1))});});
 }
 if(parts[1]==='install')return install();
 if(parts[1]==='download')return download(body.model);
 if(parts[1]==='cancel'){const r=work.get(body.id);if(r?.status==='running')r.abort.abort();return status();}
 if(parts[1]==='run'){
  assertIdle();
  const m=catalog.find(m=>m.id===body.model);if(!m||!state.ready||!modelFile(m))throw new Error('先安装引擎并下载所选模型');
  let src;if(body.jobId){const j=getJob(body.jobId);if(!j?.result)throw new Error('结果不存在');src=await variantPath(j,appliedVariant(j));}else src=useUpload(body.uploadId);
  if(!src)throw new Error('先选择原图');
  assertIdle();if(!state.ready||!fs.existsSync(python)||!modelFile(m))throw new Error('引擎或模型已移除，请重新安装');
  const threshold=Number(body.threshold??0),denoise=Number(body.denoise??0);
  if(!Number.isFinite(threshold)||threshold<0||threshold>1||!Number.isInteger(denoise)||denoise<0||denoise>5)throw new Error('threshold 需要 0–1；denoise 需要 0–5 整数');
  const erode=Number(body.erode||0),feather=Number(body.feather||0);if(!Number.isInteger(erode)||Math.abs(erode)>15||!Number.isFinite(feather)||feather<0||feather>30)throw new Error('修边参数无效');
  const id=crypto.randomUUID(),outdir=path.join(dir,'runs',id);fs.mkdirSync(outdir,{recursive:true});const input=path.join(outdir,`input${path.extname(src)}`);fs.copyFileSync(src,input);
  const operation={id,status:'running',stage:'正在本机抠像',createdAt:Date.now(),abort:new AbortController()};work.set(id,operation);atomicJson(path.join(outdir,'operation.json'),{...operation,abort:undefined});
  const pending=(async()=>{try{await verifyModel(m);operation.abort.signal.throwIfAborted();const output=path.join(outdir,'cutout.png'),mask=path.join(outdir,'mask.png');await run(python,[path.join(ROOT,'engine','matting.py'),'matte','--model',m.id,'--input',input,'--output',output,'--mask',mask,'--erode',String(erode),'--feather',String(feather),'--threshold',String(threshold),'--denoise',String(denoise)],t=>{operation.stage=t.trim().slice(-250);},operation.abort.signal);
   const job=await createLocalResult({sourcePath:input,buffer:fs.readFileSync(output),title:`本地抠像 · ${m.name}`,parameters:{model:m.id,erode,feather,threshold,denoise}});
   fs.copyFileSync(mask,path.join(job.dir,'mask.png'));job.meta.mask={path:path.join(job.dir,'mask.png'),kind:'gray',role:'matting'};persist(job);operation.status='done';operation.jobId=job.id;
  }catch(e){operation.status=operation.abort.signal.aborted?'cancelled':'error';operation.error=e.message;}finally{operation.finishedAt=Date.now();atomicJson(path.join(outdir,'operation.json'),{...operation,abort:undefined});}})();
  activeRuns.add(pending);pending.finally(()=>activeRuns.delete(pending));
  return {id,status:'running'};
 }
 throw new Error('未知引擎操作');
}
