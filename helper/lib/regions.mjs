import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {planTiles} from './tiles.mjs';
import {DATA_DIR} from './paths.mjs';
import {atomicJson,readJson,recordId} from './store.mjs';
import {useUpload,saveUpload,getJob,listJobs,variantPath,appliedVariant,normalizeVariant,createLocalResult} from './jobs.mjs';
const root=path.join(DATA_DIR,'workbench','regions');
const folder=id=>path.join(root,recordId(id));
export function regionRecord(id){const r=readJson(path.join(folder(id),'record.json'),null);if(!r)throw new Error('区域记录不存在');if(r.id!==id)throw new Error('区域记录 ID 与目录不一致');return r;}
const save=r=>{atomicJson(path.join(folder(r.id),'record.json'),r);return r;};
export function validateTarget(t){
 if(!t||typeof t.session!=='string'||!t.session.trim()||t.session.length>100||!Number.isSafeInteger(t.docId)||t.docId<1||!Number.isSafeInteger(t.width)||!Number.isSafeInteger(t.height)||t.width<1||t.height<1||t.width*t.height>40000000)throw new Error('文档绑定无效或超过 4000 万像素');
 return {session:t.session,docId:t.docId,width:t.width,height:t.height,name:String(t.name||'').slice(0,200)};
}
export function validateRect(r,t){if(!r||!['left','top','right','bottom'].every(k=>Number.isSafeInteger(r[k]))||r.left<0||r.top<0||r.right>t.width||r.bottom>t.height||r.right<=r.left||r.bottom<=r.top)throw new Error('区域超出目标画布');return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};}
function intersect(a,b){const r={left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)};if(r.right<=r.left||r.bottom<=r.top)throw new Error('选区与捕获区域没有交集');return r;}
export async function regionFile(id,kind){const r=regionRecord(id);if(kind==='image')return {buffer:fs.readFileSync(path.join(folder(id),'input.png')),type:'image/png'};
 if(kind==='mask-raw'){
  if(!r.mask)throw new Error('该区域没有保存异形选区');const b=validateRect(r.mask,r.target);
  const {data,info}=await sharp(path.join(folder(id),'mask.png')).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
  if(info.width!==b.right-b.left||info.height!==b.bottom-b.top||data.length!==info.width*info.height)throw new Error('保存的选区尺寸不一致，请重新捕获');
  return {buffer:data,type:'application/octet-stream',bounds:b};
 }
 throw new Error('未知区域文件');
}
// Serialize per-pack mutations. Retrying the same source pixels + variant resumes the same split.
const splitLocks=new Map();
async function withSplitLock(id,fn){const prior=splitLocks.get(id)||Promise.resolve();const task=prior.catch(()=>{}).then(fn);splitLocks.set(id,task);try{return await task;}finally{if(splitLocks.get(id)===task)splitLocks.delete(id);}}
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
async function splitPack(body){
 const r=regionRecord(body.id),j=getJob(body.jobId);if(r.kind!=='pack'||j?.status!=='done'||!j.result)throw new Error('请选择拼接计划及完成的生成结果');
 const variant=normalizeVariant(structuredClone(body.variant||appliedVariant(j)));
 const source=await variantPath(j,variant),bytes=fs.readFileSync(source),meta=await sharp(bytes).metadata();
 if(!meta.width||!meta.height||Math.abs((meta.width*r.height)/(meta.height*r.width)-1)>.005)throw new Error('生成比例与拼接画布不一致，停止拆分以免贴错位置');
 const sourceSha256=sha256(bytes),key=sha256(JSON.stringify({jobId:j.id,variant,sourceSha256}));
 let split=(r.splits||[]).find(s=>s.key===key);
 if(split?.status==='done')return r;
 if(!split){split={id:crypto.randomUUID(),key,status:'running',createdAt:Date.now(),sourceJobId:j.id,sourceVariant:variant,sourceSha256,outputs:[]};r.splits=[...(r.splits||[]),split];}
 split.status='running';delete split.error;save(r);
 try{
  const splitDir=path.join(folder(r.id),'splits',split.id);fs.mkdirSync(splitDir,{recursive:true});
  // Keep the exact selected file, not just a mutable job/variant reference.
  const sourceFile=path.join(splitDir,'source.image');if(!fs.existsSync(sourceFile))fs.writeFileSync(sourceFile,bytes,{flag:'wx'});
  if(sha256(fs.readFileSync(sourceFile))!==sourceSha256)throw new Error('拆分原图校验失败，未继续创建结果');
  split.sourceFile=path.relative(folder(r.id),sourceFile);save(r);
  const full=await sharp(bytes).resize(r.width,r.height,{fit:'fill'}).png().toBuffer();
  for(const [index,m] of r.mapping.entries()){
   if(split.outputs[index])continue;
   // A distinct, durable capture is necessary: the server resolves paste-bound via captureId.
   // Rebinding the original capture must never redirect a previously packed result.
   const captureId=`${split.id}-${index}`,captureDir=folder(captureId);
   if(!fs.existsSync(path.join(captureDir,'record.json'))){
    const original=regionRecord(m.captureId);fs.mkdirSync(captureDir,{recursive:true});
    fs.copyFileSync(path.join(folder(m.captureId),'input.png'),path.join(captureDir,'input.png'));
    if(m.mask)fs.copyFileSync(path.join(folder(m.captureId),'mask.png'),path.join(captureDir,'mask.png'));
    save({id:captureId,kind:'capture',createdAt:Date.now(),title:`拆分绑定 · ${original.title}`,target:structuredClone(m.target),rect:structuredClone(m.rect),mask:structuredClone(m.mask||null),sourceCaptureId:m.captureId,packId:r.id,splitId:split.id});
   }
   const parameters={packId:r.id,splitId:split.id,splitIndex:index,sourceJobId:j.id,sourceVariant:variant,sourceSha256,captureId,sourceCaptureId:m.captureId,target:structuredClone(m.target),rect:structuredClone(m.rect)};
   // Recover a job already saved if the helper stopped before appending its ID below.
   let job=listJobs(100000).find(x=>x.status==='done'&&x.meta?.parameters?.splitId===split.id&&x.meta.parameters.splitIndex===index&&x.meta.parameters.sourceSha256===sourceSha256&&x.result&&fs.existsSync(x.result.path));
   if(!job){const buffer=await sharp(full).extract({left:m.left,top:m.top,width:m.width,height:m.height}).png().toBuffer();job=await createLocalResult({sourcePath:path.join(captureDir,'input.png'),buffer,title:`多区拆分 · ${r.title}`,parameters});}
   split.outputs.push({jobId:job.id,captureId,sourceCaptureId:m.captureId,target:structuredClone(m.target),rect:structuredClone(m.rect)});save(r);
  }
  split.status='done';split.finishedAt=Date.now();return save(r);
 }catch(e){split.status='error';split.error=e.message;save(r);throw e;}
}
export async function regionRoutes(method,parts,body={}){
 if(parts[0]!=='regions')return undefined;
 if(method==='GET'&&parts.length===1)return {regions:fs.existsSync(root)?fs.readdirSync(root).filter(id=>fs.existsSync(path.join(root,id,'record.json'))).map(regionRecord).sort((a,b)=>b.createdAt-a.createdAt):[]};
 if(method!=='POST')throw new Error('请求方式无效');
 if(parts[1]==='grid'){const t=validateTarget(body.target);return {rects:planTiles(t.width,t.height,Number(body.size??1024),Number(body.overlap??128)).map(r=>({left:r.left,top:r.top,right:r.left+r.width,bottom:r.top+r.height}))};}
 if(parts[1]==='capture'){
  const target=validateTarget(body.target),rect=validateRect(body.rect,target),src=useUpload(body.uploadId);if(!src)throw new Error('捕获图片已失效');
  const id=crypto.randomUUID(),dir=folder(id);fs.mkdirSync(dir,{recursive:true});
  try{
   const m=await sharp(src).rotate().png().toFile(path.join(dir,'input.png'));
   if(m.width!==rect.right-rect.left||m.height!==rect.bottom-rect.top)throw new Error('捕获尺寸与文档区域不一致');
   let mask=null;
   if(body.maskUploadId){
    const source=useUpload(body.maskUploadId);if(!source)throw new Error('选区数据已失效');const b=validateRect(body.maskBounds,target),mm=await sharp(source).metadata();
    if(mm.width!==b.right-b.left||mm.height!==b.bottom-b.top)throw new Error('选区尺寸不一致');
    mask=intersect(b,rect);
    await sharp(source).extract({left:mask.left-b.left,top:mask.top-b.top,width:mask.right-mask.left,height:mask.bottom-mask.top}).removeAlpha().greyscale().png().toFile(path.join(dir,'mask.png'));
   }
   return save({id,kind:'capture',createdAt:Date.now(),target,rect,mask,title:String(body.title||target.name).slice(0,200)});
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
 }
 if(parts[1]==='rebind'){
  const r=regionRecord(body.id),target=validateTarget(body.target);if(r.kind!=='capture')throw new Error('只能重绑原始捕获');
  if(target.width!==r.target.width||target.height!==r.target.height)throw new Error('新文档尺寸与捕获时不一致，不能自动重绑');
  r.previousTargets=[...(r.previousTargets||[]),r.target];r.target=target;return save(r);
 }
 if(parts[1]==='pack'){
  if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>30||new Set(body.ids).size!==body.ids.length)throw new Error('请选择 1–30 个不同区域');
  const captures=body.ids.map(regionRecord);if(captures.some(c=>c.kind!=='capture'))throw new Error('只能拼接原始捕获');
  const requestedColumns=Number(body.columns??2);if(!Number.isInteger(requestedColumns)||requestedColumns<1)throw new Error('列数必须为正整数');const columns=Math.min(captures.length,requestedColumns);
  const cw=Math.max(...captures.map(c=>c.rect.right-c.rect.left)),ch=Math.max(...captures.map(c=>c.rect.bottom-c.rect.top));
  const width=cw*columns,height=ch*Math.ceil(captures.length/columns);if(width*height>40000000)throw new Error('拼接画布超过 4000 万像素，请减少区域');
  const id=crypto.randomUUID(),dir=folder(id);fs.mkdirSync(dir,{recursive:true});
  try{
   const mapping=captures.map((c,i)=>({captureId:c.id,target:structuredClone(c.target),rect:structuredClone(c.rect),mask:structuredClone(c.mask),left:(i%columns)*cw,top:Math.floor(i/columns)*ch,width:c.rect.right-c.rect.left,height:c.rect.bottom-c.rect.top}));
   await sharp({create:{width,height,channels:4,background:'#808080'}}).composite(mapping.map(m=>({input:path.join(folder(m.captureId),'input.png'),left:m.left,top:m.top}))).png().toFile(path.join(dir,'input.png'));
   return save({id,kind:'pack',createdAt:Date.now(),title:String(body.title||'多区拼接').slice(0,200),width,height,mapping,uploadId:saveUpload(fs.readFileSync(path.join(dir,'input.png')),'image/png')});
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
 }
 if(parts[1]==='split')return withSplitLock(recordId(body.id),()=>splitPack(body));
 if(parts[1]==='upload'){const r=regionRecord(body.id);return {uploadId:saveUpload(fs.readFileSync(path.join(folder(r.id),'input.png')),'image/png'),name:r.title,width:r.width||r.rect.right-r.rect.left,height:r.height||r.rect.bottom-r.rect.top};}
 throw new Error('未知区域操作');
}
