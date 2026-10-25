import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-runs-'));process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(dir,'outputs');
const jobs=await import('../lib/jobs.mjs');
const {createRuns}=await import('../lib/runs.mjs');
const {planTiles,mergeTiles}=await import('../lib/tiles.mjs');
const source=await sharp({create:{width:160,height:192,channels:4,background:{r:60,g:90,b:130,alpha:.5}}}).png().toBuffer();
let calls=[],failOnce=true;
const ctx={providers:{fake:{async run(j){calls.push({prompt:j.prompt,input:fs.readFileSync(j.inputPath)});if(j.prompt==='fail-once'&&failOnce){failOnce=false;throw new Error('simulated provider failure');}const out=path.join(j.dir,'generated.png');if(j.prompt==='blue')await sharp({create:{width:160,height:192,channels:3,background:'blue'}}).png().toFile(out);else fs.copyFileSync(j.inputPath,out);const m=await sharp(out).metadata();return {path:out,width:m.width,height:m.height};}}},capabilities:{fake:{aspects:['1:1','5:6']}}};
let runs=createRuns(ctx);const post=(p,b={})=>runs.route('POST',p.split('/'),b);
const step=prompt=>({provider:'fake',prompt,post:{align:false,cc:'none'}});
async function settle(){for(let i=0;i<200&&jobs.listJobs().some(j=>['queued','running'].includes(j.status));i++)await new Promise(r=>setTimeout(r,10));}
test('chain pins previous output, pauses for review, resumes after restart without duplicate generation',async()=>{
 const r=await post('runs',{mode:'chain',uploadId:jobs.saveUpload(source,'image/png'),steps:[{...step('blue'),aspect:'auto'},step('identity')],reviewEach:true});
 assert.equal(r.steps[0].options.aspect,'5:6');
 await runs.tick();assert.equal(calls.length,0);await post(`runs/${r.id}/start`);await runs.tick();await settle();await runs.tick();
 let saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);assert.equal(saved.status,'paused');assert.equal(saved.steps[0].status,'done');assert.equal(calls.length,1);
 runs.close();runs=createRuns(ctx);await post(`runs/${r.id}/start`);await runs.tick();await settle();await runs.tick();
 saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);assert.equal(saved.status,'done');assert.equal(calls.length,2);
 const pixel=await sharp(calls[1].input).raw().toBuffer();assert.deepEqual([...pixel.subarray(0,3)],[0,0,255]);
 await runs.tick();assert.equal(calls.length,2);
});
test('tile run preserves full dimensions and alpha, persists composed result once',async()=>{
 const r=await post('runs',{mode:'tiles',uploadId:jobs.saveUpload(source,'image/png'),size:128,overlap:32,options:step('identity'),reviewEach:false});
 assert.equal(r.steps.length,4);await post(`runs/${r.id}/start`);
 let saved;
 for(let i=0;i<10;i++){await runs.tick();await settle();saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);if(saved.status==='done')break;}
 assert.equal(saved.status,'done');const result=jobs.getJob(saved.resultJobId);assert.equal(result.result.width,160);assert.equal(result.result.height,192);
 const alpha=await sharp(result.result.path).extractChannel('alpha').raw().toBuffer();assert.equal(new Set(alpha).size,1);assert.equal(alpha[0],128);
 const count=jobs.listJobs().length;await runs.tick();assert.equal(jobs.listJobs().length,count);
});
test('tile planner covers odd edges and merge refuses uncovered pixels',async()=>{
 const regions=planTiles(301,287,128,32);assert.equal(Math.max(...regions.map(r=>r.left+r.width)),301);assert.equal(Math.max(...regions.map(r=>r.top+r.height)),287);
 assert.throws(()=>planTiles(500,500,128,64),/无效/);
 await assert.rejects(()=>mergeTiles(10,10,[],0,path.join(dir,'bad.png')),/覆盖/);
});
test('failed chains retry only the failed step after explicit review; cancelled runs never submit',async()=>{
 const r=await post('runs',{mode:'chain',uploadId:jobs.saveUpload(source,'image/png'),steps:[step('blue'),step('fail-once'),step('identity')],reviewEach:false});
 const before=calls.length;await post(`runs/${r.id}/start`);
 for(let i=0;i<4;i++){await runs.tick();await settle();}
 let saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);assert.equal(saved.status,'needs-attention');assert.equal(calls.length-before,2);
 await assert.rejects(()=>post(`runs/${r.id}/retry`),/核对/);
 await post(`runs/${r.id}/retry`,{verified:true});await post(`runs/${r.id}/start`);
 for(let i=0;i<4;i++){await runs.tick();await settle();}
 saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);assert.equal(saved.status,'done');assert.deepEqual(calls.slice(before).map(x=>x.prompt),['blue','fail-once','fail-once','identity']);
 const cancelled=await post('runs',{mode:'chain',uploadId:jobs.saveUpload(source,'image/png'),steps:[step('blue')]});const count=calls.length;
 await post(`runs/${cancelled.id}/cancel`);await runs.tick();assert.equal(calls.length,count);await assert.rejects(()=>post(`runs/${cancelled.id}/start`),/结束/);
});
test.after(()=>{runs.close();fs.rmSync(dir,{recursive:true,force:true});});
