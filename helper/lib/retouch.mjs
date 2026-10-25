import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {DATA_DIR} from './paths.mjs';
import {config} from './config.mjs';
import {atomicJson,readJson,recordId} from './store.mjs';
import {getJob,useUpload,variantPath,appliedVariant,createLocalResult} from './jobs.mjs';
import {alignOutput,makeVariant,CC_MODES} from './post.mjs';
import * as psBridge from './bridge.mjs';
import {regionRecord,validateTarget,validateRect} from './regions.mjs';
import {assertStorageQuota,reserveStorageQuota} from './storage.mjs';
const root=path.join(DATA_DIR,'workbench','retouch');
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const number=(n,d,min,max)=>{n=n==null?d:Number(n);if(!Number.isFinite(n)||n<min||n>max)throw new Error('参数超出范围');return n;};
async function image(ref){if(ref?.jobId){const j=getJob(ref.jobId);if(j?.status!=='done'||!j.result||!fs.existsSync(j.result.path))throw new Error('所选结果未完成或文件不存在');return variantPath(j,appliedVariant(j));}const p=useUpload(ref?.uploadId);if(!p)throw new Error('图片已失效，请重新选择');return p;}
export function roi(value,w,h){const r=value||{x:0,y:0,w:1,h:1};if(!['x','y','w','h'].every(k=>Number.isFinite(Number(r[k])))||r.x<0||r.y<0||r.w<=0||r.h<=0||Number(r.x)+Number(r.w)>1.00001||Number(r.y)+Number(r.h)>1.00001)throw new Error('采样框必须位于图像内');const left=Math.min(w-1,Math.floor(r.x*w)),top=Math.min(h-1,Math.floor(r.y*h));return {left,top,width:Math.max(1,Math.min(w-left,Math.round(r.w*w))),height:Math.max(1,Math.min(h-top,Math.round(r.h*h)))};}
async function mean(src,r){const m=await sharp(src).metadata(),b=roi(r,m.width,m.height);const {data,info}=await sharp(src).extract(b).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});let count=0,s=[0,0,0];for(let i=0;i<data.length;i+=info.channels){const a=data[i+3]/255;count+=a;for(let c=0;c<3;c++)s[c]+=data[i+c]*a;}if(count<1)throw new Error('采样框内没有不透明像素');return s.map(n=>n/count);}
const previewFile=id=>path.join(root,recordId(id),'preview.json');
const sameTarget=(a,b)=>a&&b&&['session','docId','width','height'].every(k=>a[k]===b[k]);
const sameRect=(a,b)=>a&&b&&['left','top','right','bottom'].every(k=>a[k]===b[k]);
const saveLocks=new Map();
async function savePreview(body){
 const id=recordId(body.id),previous=saveLocks.get(id)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  const p=readJson(previewFile(id),null);if(!p)throw new Error('请先计算预览');
  const key=body.layer?'layerJobId':'jobId',existing=getJob(p[key]);
  if(existing?.status==='done'&&existing.result&&fs.existsSync(existing.result.path))return {jobId:existing.id};
  if(body.layer&&!p.layer)throw new Error('这项调整没有独立图层');
  const j=await createLocalResult({sourcePath:p.source,buffer:fs.readFileSync(body.layer?p.layer:p.output),title:p.title+(body.layer?' · 独立光效层':''),parameters:{...p.parameters,blend:body.layer?p.parameters.blend:'normal'}});
  p[key]=j.id;atomicJson(previewFile(id),p);return {jobId:j.id};
 });
 saveLocks.set(id,task);
 try{return await task;}finally{if(saveLocks.get(id)===task)saveLocks.delete(id);}
}

// Persisted inspection rectangles only. This never submits an image generation job.
// No mapping is guessed for a crop or a differently sized Photoshop canvas.
export async function locateSuggestion(body,bridge=psBridge){
 const p=readJson(previewFile(body.id),null);
 if(!p?.report||p.report.coordinateSpace!=='source-pixels')throw new Error('请重新计算变化检查预览');
 if(!Number.isInteger(body.index)||!p.report.regions[body.index])throw new Error('变化候选不存在');
 const target=validateTarget(body.target);
 if(target.width!==p.width||target.height!==p.height)throw new Error('定位只支持与源图同尺寸的完整文档画布，不能猜测裁剪或缩放映射');
 const r=p.report.regions[body.index],rect=validateRect({left:r.left,top:r.top,right:r.right,bottom:r.bottom},target);
 const check=async()=>{
  const result=await bridge.request({type:'documents'});
  if(!Array.isArray(result?.documents)||!result.documents.some(d=>sameTarget(d.target||d,target)))throw new Error('所选 PS 文档已关闭、重开或尺寸改变，请重新选择');
 };
 await check();
 const captured=await bridge.request({type:'capture-region',target,rect,useSelection:false});
 const c=regionRecord(recordId(captured?.id));
 if(c.kind!=='capture'||!sameTarget(c.target,target)||!sameTarget(captured.target,target)||!sameRect(c.rect,rect)||!sameRect(captured.rect,rect))throw new Error('捕获回执与所选文档或候选矩形不一致，未定位');
 await check();
 const latest=regionRecord(c.id);
 if(!sameTarget(latest.target,target)||!sameRect(latest.rect,rect))throw new Error('捕获绑定已改变，未定位');
 const result=await bridge.request({type:'locate-region',captureId:c.id,target,rect,mask:null});
 if(result?.docId!==target.docId)throw new Error('PS 没有确认定位到所选文档');
 return {captureId:c.id,target,rect,result};
}

// useUpload also resolves persisted 16-hex PNG names, so publication can be
// atomic without leaving a partial transfer file when disk writes fail.
function publishPreviewUpload(buffer,published){
 const folder=path.join(config.outputDir,'_uploads');fs.mkdirSync(folder,{recursive:true});
 let id,file;do{id=crypto.randomBytes(8).toString('hex');file=path.join(folder,`${id}.png`);}while(fs.existsSync(file));
 const temp=path.join(folder,`.retouch-${crypto.randomUUID()}.tmp`);let fd;
 try{
  fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,buffer);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temp,file);published.push(file);return id;
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temp,{force:true});}
}

async function normalized(source,destination){
 return sharp(source,{limitInputPixels:40000000}).rotate().toColourspace('srgb').png().toFile(destination);
}
export async function retouchRoutes(method,parts,body={}){
 if(method!=='POST')throw new Error('图像工具需要 POST');
 if(parts[1]==='save')return savePreview(body);
 if(parts[1]==='locate')return locateSuggestion(body);
 if(!['variant','match','glow','inspect'].includes(parts[1]))throw new Error('未知修图工具');
 return createPreview(parts,body);
}
async function createPreview(parts,body){
 const source=await image(body.source);
 const dimensions=await sharp(source,{limitInputPixels:40000000}).metadata();
 const pixels=dimensions.width*dimensions.height;
 if(!Number.isSafeInteger(pixels)||pixels<1||pixels>40000000)throw new Error('图像尺寸无效或超过 4000 万像素');
 // Only derived output + optional glow layer consume preview quota. Include
 // PNG scanline/encoding headroom; input/reference copies remain protected.
 const outputCount=parts[1]==='glow'?2:1;
 const estimatedBytes=(Math.ceil((pixels*4+Math.max(dimensions.width,dimensions.height))*1.01)+4096)*outputCount;
 assertStorageQuota('preview',estimatedBytes);
 const releaseQuota=reserveStorageQuota('preview',estimatedBytes);
 const id=crypto.randomUUID(),dir=path.join(root,id);
 let created=false;
 const input=path.join(dir,'input.png'),output=path.join(dir,'output.png'),published=[];
 const upload=buffer=>publishPreviewUpload(buffer,published);
 try{
 fs.mkdirSync(root,{recursive:true});fs.mkdirSync(dir);created=true;
 // All returned sizes and ROI coordinates refer to decoded, auto-oriented pixels.
 const meta=await normalized(source,input);
 let reference;
 if(parts[1]!=='glow'){reference=path.join(dir,'reference.png');await normalized(await image(body.reference),reference);}
 let title,parameters={},layer,report;
 if(parts[1]==='variant'){
  const ref=path.join(dir,'reference-sized.png');await sharp(reference).resize(meta.width,meta.height,{fit:'fill'}).png().toFile(ref);
  let base=input;
  let alignment={applied:false};
  if(body.align===true){const aligned=await alignOutput(ref,input,null,path.join(dir,'aligned.png'));base=aligned.path;const {path:alignedPath,...details}=aligned;alignment=details;}
  const cc=body.cc||'none';if(!CC_MODES.includes(cc))throw new Error('校色模式无效');const t=number(body.strength,1,0,1);
  await makeVariant({inputPath:ref,basePath:base,cc,tex:body.texture===true,t,outPath:output});title='独立对齐 / 校色 / 强度';parameters={align:body.align===true,alignment,cc,texture:body.texture===true,strength:t};
 }else if(parts[1]==='match'){
  const a=await mean(input,body.sourceROI),b=await mean(reference,body.referenceROI),strength=number(body.strength,1,0,1),maxDelta=number(body.maxDelta,48,0,255);
  const {data,info}=await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject:true}),delta=b.map((v,c)=>clamp(v-a[c],-maxDelta,maxDelta)*strength);
  for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++)data[i+c]=clamp(Math.round(data[i+c]+delta[c]),0,255);
  await sharp(data,{raw:info}).png().toFile(output);title='双区颜色匹配';parameters={sourceROI:body.sourceROI,referenceROI:body.referenceROI,strength,maxDelta,delta,algorithm:'sRGB 区域均值偏移，保留 alpha，不还原空间纹理'};
 }else if(parts[1]==='glow'){
  const threshold=number(body.threshold,.7,0,1),radius=number(body.radius,12,.3,100),strength=number(body.strength,.4,0,1),blend=body.blend||'screen';if(!['screen','add','soft-light'].includes(blend))throw new Error('混合模式无效');
  const {data,info}=await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(let i=0;i<data.length;i+=4){const lum=(.2126*data[i]+.7152*data[i+1]+.0722*data[i+2])/255;data[i+3]=Math.round(data[i+3]*clamp((lum-threshold)/Math.max(.001,1-threshold),0,1)*strength);}
  const glow=await sharp(data,{raw:info}).blur(radius).png().toBuffer();layer=path.join(dir,'layer.png');fs.writeFileSync(layer,glow);
  const composite=await sharp(input).composite([{input:glow,blend}]).removeAlpha().raw().toBuffer();
  const alpha=await sharp(input).ensureAlpha().extractChannel('alpha').raw().toBuffer();
  await sharp(composite,{raw:{width:info.width,height:info.height,channels:3}}).joinChannel(alpha,{raw:{width:info.width,height:info.height,channels:1}}).png().toFile(output);title='阈值辉光';parameters={threshold,radius,strength,blend};
 }else if(parts[1]==='inspect'){
  const scale=Math.min(1,512/Math.max(meta.width,meta.height)),w=Math.max(1,Math.round(meta.width*scale)),h=Math.max(1,Math.round(meta.height*scale));
  const a=await sharp(input).resize(w,h,{fit:'fill'}).ensureAlpha().raw().toBuffer(),b=await sharp(reference).resize(w,h,{fit:'fill'}).ensureAlpha().raw().toBuffer();
  const overlay=Buffer.alloc(w*h*4),blocks=[],size=32,threshold=number(body.threshold,.18,0,1);
  for(let y=0;y<h;y+=size)for(let x=0;x<w;x+=size){
   let sum=0,n=0;
   for(let yy=y;yy<Math.min(h,y+size);yy++)for(let xx=x;xx<Math.min(w,x+size);xx++){
    const i=(yy*w+xx)*4,aa=a[i+3]/255,ba=b[i+3]/255;let d=0;
    // Compare visible appearance on black and white. Hidden RGB is irrelevant;
    // an alpha-only change must still be offered for review.
    for(let c=0;c<3;c++){const black=a[i+c]*aa-b[i+c]*ba;d+=Math.max(Math.abs(black),Math.abs(black+255*(ba-aa)));}
    sum+=d/(3*255);n++;
   }
   const score=sum/n;
   if(score>threshold){
    const bounds={left:Math.floor(x/w*meta.width),top:Math.floor(y/h*meta.height),right:Math.min(meta.width,Math.ceil((x+size)/w*meta.width)),bottom:Math.min(meta.height,Math.ceil((y+size)/h*meta.height))};
    blocks.push({score,...bounds});
    for(let yy=y;yy<Math.min(h,y+size);yy++)for(let xx=x;xx<Math.min(w,x+size);xx++){const i=(yy*w+xx)*4;overlay[i]=255;overlay[i+3]=Math.round(clamp(score,0,1)*180);}
   }
  }
  const heat=await sharp(overlay,{raw:{width:w,height:h,channels:4}}).resize(meta.width,meta.height).png().toBuffer();await sharp(input).composite([{input:heat}]).png().toFile(output);
  report={algorithm:'透明感知的缩略图分块平均绝对差（黑 / 白背景）',notice:'这些是变化候选，不代表确定的残影或缺陷；有意改图也会被标记。',coordinateSpace:'source-pixels',width:meta.width,height:meta.height,regions:blocks.sort((a,b)=>b.score-a.score).slice(0,100)};
  title='变化 / 痕迹检查建议';parameters={threshold};
 }else throw new Error('未知修图工具');
 // Working intermediates are neither source assets nor retained previews.
 for(const name of ['aligned.png','reference-sized.png'])fs.rmSync(path.join(dir,name),{force:true});
 const result={id,sourceUploadId:upload(fs.readFileSync(input)),uploadId:upload(fs.readFileSync(output)),layerUploadId:layer?upload(fs.readFileSync(layer)):null,parameters,report,width:meta.width,height:meta.height};
 // Commit metadata last; an unsuccessful operation never becomes a saved preview.
 atomicJson(path.join(dir,'preview.json'),{id,source:input,reference,output,layer,title,parameters,report,width:meta.width,height:meta.height});
 return result;
 }catch(e){
  // These are exclusively this attempt's copies. Existing uploads, completed
  // previews, jobs and their original/reference assets must not be touched.
  for(const file of published)fs.rmSync(file,{force:true});
  if(created)fs.rmSync(dir,{recursive:true,force:true});
  throw e;
 }finally{releaseQuota();}
}
