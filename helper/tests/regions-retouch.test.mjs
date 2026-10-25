import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-regions-'));process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(dir,'outputs');
const jobs=await import('../lib/jobs.mjs');const {regionRoutes,regionFile,regionRecord}=await import('../lib/regions.mjs');const {retouchRoutes}=await import('../lib/retouch.mjs');const {sharedSettings}=await import('../lib/shared-settings.mjs');
const png=async(color,w=40,h=30)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
const post=(action,body)=>regionRoutes('POST',['regions',action],body);
let a,b,pack;
test('capture keeps exact alpha mask and rejects wrong pixel/target bounds',async()=>{
 const src=await png('red'),mask=await sharp(Buffer.from(Array.from({length:1200},(_,i)=>i%256)),{raw:{width:40,height:30,channels:1}}).png().toBuffer();
 a=await post('capture',{target:{session:'one',docId:7,width:80,height:60,name:'A'},rect:{left:10,top:15,right:50,bottom:45},uploadId:jobs.saveUpload(src,'image/png'),maskUploadId:jobs.saveUpload(mask,'image/png'),maskBounds:{left:10,top:15,right:50,bottom:45}});
 const result=await regionFile(a.id,'mask-raw');assert.equal(result.buffer.length,1200);assert.deepEqual([...result.buffer.slice(0,256)],[...Array(256).keys()]);
 await assert.rejects(()=>post('capture',{target:a.target,rect:{left:0,top:0,right:200,bottom:30},uploadId:jobs.saveUpload(src,'image/png')}),/超出/);
 await assert.rejects(()=>post('capture',{target:a.target,rect:{left:0,top:0,right:20,bottom:20},uploadId:jobs.saveUpload(src,'image/png')}),/尺寸/);
});
test('multi-document pack split keeps coordinates, colors and captures targets immutably',async()=>{
 b=await post('capture',{target:{session:'one',docId:8,width:100,height:70,name:'B'},rect:{left:3,top:4,right:43,bottom:34},uploadId:jobs.saveUpload(await png('blue'),'image/png')});
 pack=await post('pack',{ids:[a.id,b.id],columns:2});assert.equal(pack.width,80);assert.equal(pack.height,30);
 await post('rebind',{id:a.id,target:{...a.target,session:'two',docId:20}});assert.equal(regionRecord(pack.id).mapping[0].target.docId,7);
 const input=jobs.useUpload(pack.uploadId),j=await jobs.createLocalResult({sourcePath:input,buffer:fs.readFileSync(input),title:'identity'});
 const split=await post('split',{id:pack.id,jobId:j.id});assert.equal(split.splits[0].outputs.length,2);
 const first=jobs.getJob(split.splits[0].outputs[0].jobId),pixels=await sharp(first.result.path).raw().toBuffer();assert.deepEqual([...pixels.slice(0,3)],[255,0,0]);assert.equal(first.meta.parameters.target.docId,7);
 await assert.rejects(()=>post('rebind',{id:b.id,target:{...b.target,width:101}}),/尺寸/);
});
test('shared configuration revision rejects stale writes and supports explicit rollback',()=>{
 const original=sharedSettings('GET');const first=sharedSettings('POST',{revision:original.revision,values:{provider:'aistudio',cc:'mixed',blur:'5'}});
 assert.throws(()=>sharedSettings('POST',{revision:0,values:{cc:'none'}}),/另一端/);
 const second=sharedSettings('POST',{revision:first.revision,values:{cc:'none'}});assert.equal(sharedSettings('POST',{revision:second.revision,restore:1}).values.cc,'mixed');assert.throws(()=>sharedSettings('POST',{revision:3,values:{apiKey:'secret'}}),/不支持/);
});
test('regional color match and threshold glow preserve alpha; save is byte exact and idempotent',async()=>{
 const src=jobs.saveUpload(await png({r:40,g:80,b:120,alpha:.5}),'image/png'),ref=jobs.saveUpload(await png({r:60,g:100,b:140,alpha:1}),'image/png');
 const r=await retouchRoutes('POST',['retouch','match'],{source:{uploadId:src},reference:{uploadId:ref}});const p=await sharp(jobs.useUpload(r.uploadId)).raw().toBuffer();assert.deepEqual([...p.slice(0,4)],[60,100,140,128]);
 const saved=await retouchRoutes('POST',['retouch','save'],{id:r.id});assert.deepEqual(fs.readFileSync(jobs.getJob(saved.jobId).result.path),fs.readFileSync(jobs.useUpload(r.uploadId)));assert.equal((await retouchRoutes('POST',['retouch','save'],{id:r.id})).jobId,saved.jobId);
 const glow=await retouchRoutes('POST',['retouch','glow'],{source:{uploadId:src},threshold:.1,strength:.5});assert.ok(glow.layerUploadId);const alpha=await sharp(jobs.useUpload(glow.uploadId)).extractChannel('alpha').raw().toBuffer();assert.deepEqual(new Set(alpha),new Set([128]));
});
test('document bridge rejects closed or resized/reopened targets before writes',async()=>{
 const create=createRequire(import.meta.url)('../../plugin/region-bridge.js');let writes=0;const doc={id:3,title:'A',width:80,height:60,activeLayers:[]};const app={documents:[doc],activeDocument:doc};const r=create({app,core:{executeAsModal:async fn=>{writes++;return fn();}},action:{batchPlay:async()=>[]}});
 await assert.rejects(()=>r.execute({type:'select-subject',target:{session:'old',docId:3,width:80,height:60}}),/会话/);
 const t=(await r.execute({type:'documents'})).documents[0];doc.width=90;assert.throws(()=>r.bound(t),/尺寸/);app.documents=[];assert.throws(()=>r.bound(t),/会话/);assert.equal(writes,1); // validation inside modal before batchPlay
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
