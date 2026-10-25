import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-retouch-review-'));
process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(dir,'outputs');
const {alignOutput,makeVariant}=await import('../lib/post.mjs');
const {retouchRoutes,locateSuggestion}=await import('../lib/retouch.mjs');
const jobs=await import('../lib/jobs.mjs');
const {regionRoutes}=await import('../lib/regions.mjs');
const {storageRoutes,reserveStorageQuota}=await import('../lib/storage.mjs');
const post=(type,body)=>retouchRoutes('POST',['retouch',type],body);
const upload=buffer=>({uploadId:jobs.saveUpload(buffer,'image/png')});
const png=(buffer,width,height,channels=4)=>sharp(buffer,{raw:{width,height,channels}}).png().toBuffer();
const alpha=file=>sharp(file).extractChannel('alpha').raw().toBuffer();
const mae=(a,b)=>a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
let movedFixture;
async function fixture(){
 if(movedFixture)return movedFixture;
 const W=192,H=160,dx=7,dy=-5,pixels=Buffer.alloc(W*H*4);
 let seed=1234567;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const p=(y*W+x)*4;pixels[p]=255;pixels[p+2]=255; // deliberately hostile hidden RGB
  if(x>=30&&x<160&&y>=25&&y<135){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;
   pixels[p]=40+seed%130;pixels[p+1]=80+(seed>>>8)%160;pixels[p+2]=20+(seed>>>16)%100;
   const edge=Math.min(x-30,159-x,y-25,134-y);
   pixels[p+3]=edge<12?Math.round((edge+1)/13*255):255;
  }
 }
 const moved=Buffer.alloc(pixels.length);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const p=(y*W+x)*4,sx=x-dx,sy=y-dy;
  if(sx>=0&&sx<W&&sy>=0&&sy<H)pixels.copy(moved,p,(sy*W+sx)*4,(sy*W+sx)*4+4);
  else {moved[p]=255;moved[p+2]=255;}
 }
 const input=path.join(dir,'original.png'),output=path.join(dir,'moved.png');
 await sharp(pixels,{raw:{width:W,height:H,channels:4}}).png().toFile(input);
 await sharp(moved,{raw:{width:W,height:H,channels:4}}).png().toFile(output);
 return movedFixture={W,H,dx,dy,input,output,pixels,moved};
}

test('applied alignment moves a real transparent image and its soft alpha edge together',async()=>{
 const f=await fixture(),out=path.join(dir,'aligned.png');
 const result=await alignOutput(f.input,f.output,null,out);
 assert.equal(result.applied,true,'fixture must exercise the applied branch, not the identity early return');
 assert.equal(result.path,out);assert.ok(Math.abs(result.shift.x*f.W-f.dx)<=1);assert.ok(Math.abs(result.shift.y*f.H-f.dy)<=1);
 const metadata=await sharp(out).metadata();assert.equal(metadata.width,f.W);assert.equal(metadata.height,f.H);assert.equal(metadata.hasAlpha,true);
 const [expected,before,after]=await Promise.all([alpha(f.input),alpha(f.output),alpha(out)]);
 assert.ok(mae(after,expected)<mae(before,expected)*.12,`alpha registration must improve: ${mae(before,expected)} -> ${mae(after,expected)}`);
 assert.ok(mae(after,expected)<2);assert.ok(after.includes(0));assert.ok(after.includes(255));assert.ok(after.some(a=>a>0&&a<255));
 const rgba=await sharp(out).ensureAlpha().raw().toBuffer();let visibleError=0,count=0;
 for(let i=0;i<expected.length;i++)if(expected[i]>80){for(let c=0;c<3;c++){visibleError+=Math.abs(rgba[i*4+c]-f.pixels[i*4+c]);count++;}}
 assert.ok(visibleError/count<8,'RGB and alpha must land on the same source pixels');
 // Follow-on colour adjustment must retain the aligned mask, not the old shifted mask.
 const variant=path.join(dir,'variant.png');await makeVariant({inputPath:f.input,basePath:out,cc:'global',tex:false,t:1,outPath:variant});assert.deepEqual(await alpha(variant),after);
});

test('standalone variant reports actual applied alignment and saves the exact transparent preview once',async()=>{
 const f=await fixture();const source=upload(fs.readFileSync(f.output)),reference=upload(fs.readFileSync(f.input));
 const r=await post('variant',{source,reference,align:true,cc:'none',strength:1});assert.equal(r.parameters.alignment.applied,true);
 const out=jobs.useUpload(r.uploadId),after=await alpha(out),expected=await alpha(f.input);assert.ok(mae(after,expected)<2);
 const [a,b]=await Promise.all([post('save',{id:r.id}),post('save',{id:r.id})]);assert.equal(a.jobId,b.jobId);
 assert.deepEqual(fs.readFileSync(jobs.getJob(a.jobId).result.path),fs.readFileSync(out));
});

test('RGBA alignment interpolates associated colours and keeps exposed borders transparent',async()=>{
 const f=await fixture();
 const result=await alignOutput(f.input,f.output,{x0:.35,y0:.3,x1:.65,y1:.7},path.join(dir,'local-aligned.png'));
 assert.equal(result.applied,true);const {data,info}=await sharp(result.path).raw().toBuffer({resolveWithObject:true});assert.equal(info.channels,4);
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
  const p=(y*info.width+x)*4;
  if(data[p+3]===0)assert.deepEqual([...data.subarray(p,p+3)],[0,0,0]);
  if(data[p+3]>0&&data[p+3]<200)assert.ok(data[p]<=170&&data[p+2]<=120,'hidden magenta must not fringe the soft edge');
 }
});

test('inspection uses oriented source coordinates and detects alpha changes without hidden-RGB false positives',async()=>{
 const W=64,H=32,transparent=Buffer.alloc(W*H*4),other=Buffer.alloc(W*H*4);
 for(let i=0;i<W*H;i++){transparent[i*4]=255;other[i*4+2]=255;}
 let r=await post('inspect',{source:upload(await png(transparent,W,H)),reference:upload(await png(other,W,H)),threshold:.01});assert.equal(r.report.regions.length,0);
 for(let y=0;y<H;y++)for(let x=32;x<W;x++)other[(y*W+x)*4+3]=255;
 r=await post('inspect',{source:upload(await png(transparent,W,H)),reference:upload(await png(other,W,H)),threshold:.1});
 assert.equal(r.report.coordinateSpace,'source-pixels');assert.equal(r.report.regions.length,1);assert.deepEqual(r.report.regions[0],{score:1,left:32,top:0,right:64,bottom:32});
 const oriented=await sharp({create:{width:80,height:40,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const reference=await sharp({create:{width:40,height:80,channels:3,background:'blue'}}).png().toBuffer();
 r=await post('inspect',{source:upload(oriented),reference:upload(reference),threshold:.1});
 assert.equal(r.width,40);assert.equal(r.height,80);assert.equal(r.report.width,40);assert.equal(r.report.height,80);
 const sourceMeta=await sharp(jobs.useUpload(r.sourceUploadId)).metadata();assert.equal(sourceMeta.width,40);assert.equal(sourceMeta.height,80);
 for(const b of r.report.regions){assert.ok(b.right<=40);assert.ok(b.bottom<=80);assert.ok(b.right>b.left);assert.ok(b.bottom>b.top);}
});

async function inspection(){
 const source=upload(await sharp({create:{width:64,height:64,channels:4,background:'red'}}).png().toBuffer());
 const reference=upload(await sharp({create:{width:64,height:64,channels:4,background:'blue'}}).png().toBuffer());
 return post('inspect',{source,reference,threshold:.1});
}
function bridgeFixture(target){
 const calls=[];let current={...target},captureId;
 const bridge={request:async c=>{
  calls.push(structuredClone(c));
  if(c.type==='documents')return {documents:current?[{...current,activeLayerId:9}]:[]};
  if(c.type==='capture-region'){
   assert.equal(c.useSelection,false);const buffer=await sharp({create:{width:c.rect.right-c.rect.left,height:c.rect.bottom-c.rect.top,channels:4,background:'red'}}).png().toBuffer();
   const r=await regionRoutes('POST',['regions','capture'],{target:c.target,rect:c.rect,...upload(buffer)});captureId=r.id;return r;
  }
  if(c.type==='locate-region')return {docId:c.target.docId};
  throw new Error('unexpected command '+c.type);
 }};
 return {calls,bridge,setTarget:t=>{current=t;},captureId:()=>captureId};
}
const target={session:'review-session',docId:11,width:64,height:64,name:'Explicit target.psd'};
test('locate captures only the persisted suggestion on the explicit document and never generates',async()=>{
 const p=await inspection(),fixture=bridgeFixture(target),before=jobs.listJobs().length;
 const result=await locateSuggestion({id:p.id,index:1,target,rect:{left:0,top:0,right:1,bottom:1}},fixture.bridge);
 assert.deepEqual(fixture.calls.map(c=>c.type),['documents','capture-region','documents','locate-region']);
 const r=p.report.regions[1],rect={left:r.left,top:r.top,right:r.right,bottom:r.bottom};
 assert.deepEqual(fixture.calls[1].rect,rect);assert.deepEqual(result.rect,rect);assert.deepEqual(fixture.calls.at(-1).target,target);assert.equal(fixture.calls.at(-1).captureId,result.captureId);assert.equal(jobs.listJobs().length,before);
});

test('locate refuses omitted targets, different dimensions, closed sessions and rebound capture records',async()=>{
 const p=await inspection();let fixture=bridgeFixture(target);
 await assert.rejects(()=>locateSuggestion({id:p.id,index:0},fixture.bridge),/绑定/);
 await assert.rejects(()=>locateSuggestion({id:p.id,index:0,target:{...target,width:128}},fixture.bridge),/同尺寸/);assert.equal(fixture.calls.length,0);
 fixture.setTarget({...target,session:'reopened'});await assert.rejects(()=>locateSuggestion({id:p.id,index:0,target},fixture.bridge),/重开/);assert.deepEqual(fixture.calls.map(c=>c.type),['documents']);
 fixture=bridgeFixture(target);const request=fixture.bridge.request;
 fixture.bridge.request=async c=>{const r=await request(c);if(c.type==='capture-region')await regionRoutes('POST',['regions','rebind'],{id:r.id,target:{...target,docId:99}});return r;};
 await assert.rejects(()=>locateSuggestion({id:p.id,index:0,target},fixture.bridge),/不一致/);assert.equal(fixture.calls.some(c=>c.type==='locate-region'),false);
 fixture=bridgeFixture(target);const run=fixture.bridge.request;
 fixture.bridge.request=async c=>{const r=await run(c);if(c.type==='capture-region')fixture.setTarget(null);return r;};
 await assert.rejects(()=>locateSuggestion({id:p.id,index:0,target},fixture.bridge),/关闭/);assert.equal(fixture.calls.some(c=>c.type==='locate-region'),false);
});


const quota=(limit)=>storageRoutes('POST',['storage','quota'],{previewLimitBytes:limit,checkpointLimitBytes:0});
const storageState=()=>storageRoutes('GET',['storage']);
const previewRows=()=>fs.existsSync(path.join(dir,'workbench','retouch'))?fs.readdirSync(path.join(dir,'workbench','retouch')).sort():[];
const uploadRows=()=>fs.readdirSync(path.join(config.outputDir,'_uploads')).sort();

test('retouch quota rejects before writes, estimates only generated output, and reserves the extra glow layer',async()=>{
 const source=upload(await sharp({create:{width:80,height:40,channels:4,background:'red'}}).png().toBuffer()),reference=upload(await sharp({create:{width:80,height:40,channels:4,background:'blue'}}).png().toBuffer());
 const before=previewRows(),uploads=uploadRows(),original=fs.readFileSync(jobs.useUpload(source.uploadId));
 try{
  await quota(1);
  for(const type of ['match','variant','glow','inspect'])await assert.rejects(()=>post(type,{source,reference}),/配额/);
  assert.deepEqual(previewRows(),before);assert.deepEqual(uploadRows(),uploads);assert.deepEqual(fs.readFileSync(jobs.useUpload(source.uploadId)),original);
  const used=(await storageState()).quota.previewBytes,oneOutput=Math.ceil((80*40*4+80)*1.01)+4096;
  await quota(used+oneOutput);
  await assert.rejects(()=>post('glow',{source}),/配额/);assert.deepEqual(previewRows(),before);
  // A source plus reference is allowed with only one derived-output allowance.
  const result=await post('match',{source,reference});assert.ok(jobs.useUpload(result.uploadId));
  assert.equal((await storageRoutes('POST',['storage','quota/preflight'],{kind:'preview',estimatedBytes:0})).reservedBytes,0);
 }finally{await quota(0);}
});

test('failed retouch writes remove their attempt files, preserve inputs, and release the shared reservation',async()=>{
 const source=upload(await sharp({create:{width:48,height:40,channels:4,background:'white'}}).png().toBuffer());
 const before=previewRows(),uploads=uploadRows(),original=fs.readFileSync(jobs.useUpload(source.uploadId)),write=fs.writeFileSync;
 try{
  fs.writeFileSync=(file,...args)=>{
   if(typeof file==='string'&&file.startsWith(path.join(dir,'workbench','retouch')+path.sep)&&file.endsWith('layer.png')){write(file,Buffer.from('partial PNG'));throw new Error('fixture disk write failure');}
   return write(file,...args);
  };
  await assert.rejects(()=>post('glow',{source,threshold:.1}),/fixture disk write failure/);
 }finally{fs.writeFileSync=write;}
 assert.deepEqual(previewRows(),before);assert.deepEqual(uploadRows(),uploads);assert.deepEqual(fs.readFileSync(jobs.useUpload(source.uploadId)),original);
 assert.equal((await storageRoutes('POST',['storage','quota/preflight'],{kind:'preview',estimatedBytes:0})).reservedBytes,0);
 // Failure after upload publication must roll back its temporary copies too.
 const rename=fs.renameSync;
 try{
  fs.renameSync=(from,to)=>{if(typeof to==='string'&&to.startsWith(path.join(dir,'workbench','retouch')+path.sep)&&to.endsWith('preview.json'))throw new Error('fixture metadata commit failure');return rename(from,to);};
  await assert.rejects(()=>post('glow',{source,threshold:.1}),/fixture metadata commit failure/);
 }finally{fs.renameSync=rename;}
 assert.deepEqual(previewRows(),before);assert.deepEqual(uploadRows(),uploads);
 assert.equal((await storageRoutes('POST',['storage','quota/preflight'],{kind:'preview',estimatedBytes:0})).reservedBytes,0);
 // A disk error during transfer publication must not leave a partial upload.
 const open=fs.openSync,writeUpload=fs.writeFileSync,close=fs.closeSync,temporary=new Set();
 try{
  fs.openSync=(file,...args)=>{const fd=open(file,...args);if(typeof file==='string'&&path.basename(file).startsWith('.retouch-'))temporary.add(fd);return fd;};
  fs.closeSync=fd=>{temporary.delete(fd);return close(fd);};
  fs.writeFileSync=(file,...args)=>{if(temporary.has(file)){writeUpload(file,Buffer.from('partial transfer'));throw new Error('fixture transfer failure');}return writeUpload(file,...args);};
  await assert.rejects(()=>post('glow',{source,threshold:.1}),/fixture transfer failure/);
 }finally{fs.openSync=open;fs.writeFileSync=writeUpload;fs.closeSync=close;}
 assert.deepEqual(previewRows(),before);assert.deepEqual(uploadRows(),uploads);
 assert.equal((await storageRoutes('POST',['storage','quota/preflight'],{kind:'preview',estimatedBytes:0})).reservedBytes,0);
 const success=await post('glow',{source,threshold:.1});assert.ok(success.layerUploadId);
});

test('another writer reservation prevents retouch overcommit and releases cleanly for retry',async()=>{
 const source=upload(await sharp({create:{width:64,height:64,channels:4,background:'white'}}).png().toBuffer()),used=(await storageState()).quota.previewBytes;
 const estimate=(Math.ceil((64*64*4+64)*1.01)+4096)*2;
 await quota(used+estimate);const release=reserveStorageQuota('preview',estimate);const before=previewRows();
 try{await assert.rejects(()=>post('glow',{source}),/配额/);assert.deepEqual(previewRows(),before);}
 finally{release();}
 try{const result=await post('glow',{source});assert.ok(result.layerUploadId);}
 finally{await quota(0);}
});

test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
