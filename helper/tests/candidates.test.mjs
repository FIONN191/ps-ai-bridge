import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import vm from 'node:vm';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psai-candidates-'));
process.env.PS_AI_BRIDGE_DATA_DIR = dir;
const { config } = await import('../lib/config.mjs');
config.outputDir = path.join(dir, 'outputs');
const jobs = await import('../lib/jobs.mjs');
const { createRuns } = await import('../lib/runs.mjs');
const red = await sharp({ create: { width: 16, height: 24, channels: 3, background: 'red' } }).png().toBuffer();
const blue = await sharp({ create: { width: 16, height: 24, channels: 3, background: 'blue' } }).png().toBuffer();
const wait = async predicate => {
  for (let i=0;i<300;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,10)); }
  assert.fail('Timed out waiting for job');
};
let calls = 0, resumed = 0, downloads = 0, failDownload = false;
const ctx = { providers: { comfyui: {
  async run(job, { signal }) {
    calls++;
    job.upstream = {kind:'comfyui',taskId:`stored-${calls}`,url:'http://localhost',state:'submitted'};
    jobs.persist(job);
    if (job.prompt === 'uncertain') throw new Error('simulated interruption');
    return output(job,signal);
  },
  async resume(job,{signal}) { resumed++; return output(job,signal); },
}}, capabilities:{ comfyui:{aspects:['2:3']} } };
async function output(job, signal) {
  return jobs.downloadCandidates(job, [red,blue], async bytes => {
    downloads++;
    if (failDownload && bytes === blue) throw new Error('simulated interrupted second download');
    return new Response(bytes);
  }, {signal,source:'test'});
}
const make = (prompt='edit') => jobs.createJob({provider:'comfyui',prompt,aspect:'2:3',post:{align:false,cc:'none'}},ctx.providers,ctx.capabilities);
const route = (method,route,body={}) => jobs.candidateRoutes(method,route.split('/'),body,ctx.providers);

test('multi-output waits without result/processing, releases queue slot and selects only the requested candidate once',async()=>{
  const first=make(), second=make();
  await wait(()=>first.status==='awaiting-selection'&&second.status==='awaiting-selection');
  assert.equal(first.result,null);assert.equal(first.finishedAt,null);assert.equal(first.selectedCandidateId,undefined);
  assert.ok(!fs.existsSync(path.join(first.dir,'thumb.jpg')));
  const disk=JSON.parse(fs.readFileSync(path.join(first.dir,'job.json')));assert.equal(disk.status,'awaiting-selection');
  const pending=await route('GET','candidates');assert.ok(pending.jobs.some(j=>j.id===first.id));
  const thumb=await route('GET',`candidates/${first.id}/candidate-2/thumb`);assert.equal((await sharp(thumb.file).metadata()).format,'jpeg');
  assert.equal(first.result,null);
  await assert.rejects(()=>route('POST',`candidates/${first.id}/select`,{candidateId:'../../bad'}),/不存在/);
  const before=calls;
  const a=jobs.selectCandidate(first.id,'candidate-2'),b=jobs.selectCandidate(first.id,'candidate-2');assert.equal(a,b);
  await assert.rejects(()=>jobs.selectCandidate(first.id,'candidate-1'),/其他候选/);
  await Promise.all([a,b]);
  assert.equal(first.status,'done');assert.equal(first.selectedCandidateId,'candidate-2');assert.equal(first.result.candidateId,'candidate-2');
  const pixel=await sharp(first.result.path).raw().toBuffer();assert.deepEqual([...pixel.subarray(0,3)],[0,0,255]);
  const finish=first.finishedAt;await jobs.selectCandidate(first.id,'candidate-2');assert.equal(first.finishedAt,finish);assert.equal(calls,before);
  jobs.cancelJob(second.id);await assert.rejects(()=>jobs.selectCandidate(second.id,'candidate-1'),/不能选择/);
});

test('cancellation during selected-image postprocessing cannot transition to done',async()=>{
  const job=make();await wait(()=>job.status==='awaiting-selection');
  const processing=jobs.selectCandidate(job.id,'candidate-1');jobs.cancelJob(job.id);
  await assert.rejects(()=>processing,/已取消/);
  assert.equal(job.status,'error');assert.equal(job.result,null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir,'job.json'))).status,'error');
});

test('partial download recovery is explicit, preserves each image and never resubmits or starts duplicate pollers',async()=>{
  failDownload=true;const job=make();await wait(()=>job.status==='error');failDownload=false;
  assert.equal(job.candidates.length,1);assert.equal(job.candidatesReady,false);
  const before=calls,count=downloads,oldResumes=resumed;
  assert.equal(jobs.canRecoverJob(job,ctx.providers),true);
  const response=await route('POST',`candidates/${job.id}/recover`);assert.equal(response.job.status,'running');
  await route('POST',`candidates/${job.id}/recover`);
  await wait(()=>job.status==='awaiting-selection');
  assert.equal(calls,before);assert.equal(resumed,oldResumes+1);assert.equal(downloads,count+1);
  assert.equal(job.result,null);assert.equal(job.candidates.length,2);
  await jobs.selectCandidate(job.id,'candidate-2');
  await route('POST',`candidates/${job.id}/recover`);assert.equal(resumed,oldResumes+1);
  const noId=make('uncertain');await wait(()=>noId.status==='error');delete noId.upstream.taskId;jobs.persist(noId);
  await assert.rejects(()=>route('POST',`candidates/${noId.id}/recover`,{taskId:'fabricated'}),/任务 ID/);
  assert.equal(noId.upstream.taskId,undefined);
});

test('restart retains pending selection and an interrupted committed selection without running a provider',async()=>{
  const pending=make();await wait(()=>pending.status==='awaiting-selection');
  pending.createdAt=Date.now()-30*24*3600*1000;jobs.persist(pending);
  const selected=make();await wait(()=>selected.status==='awaiting-selection');
  selected.selectedCandidateId='candidate-2';selected.status='running';jobs.persist(selected);
  const unknown=make('uncertain');await wait(()=>unknown.status==='error');unknown.status='running';jobs.persist(unknown);
  const code=`
    const jobs=await import('./helper/lib/jobs.mjs');
    const {config}=await import('./helper/lib/config.mjs');config.outputDir=${JSON.stringify(config.outputDir)};
    jobs.loadHistory();
    const p=jobs.getJob(${JSON.stringify(pending.id)}),s=jobs.getJob(${JSON.stringify(selected.id)}),u=jobs.getJob(${JSON.stringify(unknown.id)});
    if(p.status!=='awaiting-selection'||p.result!==null||s.status!=='awaiting-selection'||s.selectedCandidateId!=='candidate-2'||u.status!=='error'||u.upstream.taskId!==${JSON.stringify(unknown.upstream.taskId)})throw new Error('bad checkpoint');
    await Promise.all([jobs.selectCandidate(s.id,'candidate-2'),jobs.selectCandidate(s.id,'candidate-2')]);
    const at=s.finishedAt;await jobs.selectCandidate(s.id,'candidate-2');if(s.finishedAt!==at)throw new Error('duplicate selection');
    if(!jobs.canRecoverJob(u))throw new Error('not recoverable');
    let resumes=0;
    const providers={comfyui:{run(){throw new Error('must never submit on restart');},async resume(job,{signal}){
      resumes++;if(job.upstream.taskId!==${JSON.stringify(unknown.upstream.taskId)})throw new Error('wrong stored task ID');
      const fs=await import('node:fs');
      return jobs.downloadCandidates(job,[p.candidates[0].path,p.candidates[1].path],async file=>new Response(fs.readFileSync(file)),{signal,source:'recovered'});
    }}};
    jobs.recoverJob(u.id,providers);jobs.recoverJob(u.id,providers);
    for(let i=0;i<200&&u.status==='running';i++)await new Promise(r=>setTimeout(r,10));
    if(u.status!=='awaiting-selection'||u.result!==null)throw new Error('restart recovery did not wait for selection');
    console.log(JSON.stringify({pending:p.status,selected:s.status,candidate:s.result.candidateId,resumes}));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:path.resolve(import.meta.dirname,'../..'),env:process.env,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{pending:'awaiting-selection',selected:'done',candidate:'candidate-2',resumes:1});
  const before=calls;await new Promise(r=>setTimeout(r,20));assert.equal(calls,before);
});

test('bounded candidate count, streaming bytes and decoded image size checks prevent unbounded downloads',async()=>{
  const target=path.join(dir,'limits');fs.mkdirSync(target);
  const job={id:'limits',dir:target,upstream:{state:'submitted'}};
  let n=0;
  const out=await jobs.downloadCandidates(job,Array(20).fill(red),async()=>{n++;return new Response(red);},{signal:new AbortController().signal,source:'test'});
  assert.equal(n,16);assert.equal(out.candidates.length,16);assert.equal(job.candidateCount,20);assert.equal(job.candidatesTruncated,true);
  const signal=new AbortController().signal;
  await assert.rejects(()=>jobs.boundedImageBody(new Response('x',{headers:{'content-length':String(jobs.CANDIDATE_LIMITS.imageBytes+1)}}),signal),/大小限制/);
  let cancelled=false;
  const chunks=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(6));},cancel(){cancelled=true;}});
  await assert.rejects(()=>jobs.boundedImageBody(new Response(chunks),signal,10),/大小限制/);assert.equal(cancelled,true);
  let streamCancelled=false;const midway=new AbortController();
  const blocked=new ReadableStream({pull(){},cancel(){streamCancelled=true;}});
  const reading=jobs.boundedImageBody(new Response(blocked),midway.signal);midway.abort();
  await assert.rejects(()=>reading);assert.equal(streamCancelled,true);
  const abort=new AbortController();abort.abort();await assert.rejects(()=>jobs.boundedImageBody(new Response(red),abort.signal));
  const largeDir=path.join(dir,'large-image');fs.mkdirSync(largeDir);
  await assert.rejects(()=>jobs.downloadCandidates({id:'large',dir:largeDir,upstream:{}},['large'],async()=>new Response('<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"/>'),{signal,source:'test'}),/pixel limit/);
  assert.deepEqual(fs.readdirSync(largeDir),[]);
  job.candidates[0].bytes=jobs.CANDIDATE_LIMITS.totalBytes+1;
  await assert.rejects(()=>jobs.downloadCandidates(job,Array(20).fill(red),()=>{throw new Error('must not download');},{signal,source:'test'}),/总大小/);
});

test('chain waits across runner restart for explicit selection, passes the chosen image downstream once, and cancels pending review',async()=>{
  let runs=createRuns(ctx);runs.close();
  const post=(parts,body={})=>runs.route('POST',parts.split('/'),body);
  const r=await post('runs',{mode:'chain',uploadId:jobs.saveUpload(red,'image/png'),reviewEach:false,steps:[{provider:'comfyui',prompt:'first'},{provider:'comfyui',prompt:'second'}]});
  const before=calls;
  await post(`runs/${r.id}/start`);await runs.tick();
  let saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);
  const first=jobs.getJob(saved.steps[0].jobId);await wait(()=>first.status==='awaiting-selection');await runs.tick();
  saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);assert.equal(saved.steps[0].status,'awaiting-selection');assert.equal(saved.steps[1].status,'pending');assert.equal(calls,before+1);
  runs=createRuns(ctx);runs.close();await post(`runs/${r.id}/start`);await runs.tick();assert.equal(calls,before+1);
  await jobs.selectCandidate(first.id,'candidate-2');
  const runFile=path.join(dir,'workbench','runs',r.id,'run.json');
  const old=JSON.parse(fs.readFileSync(runFile));old.status='needs-attention';old.steps[0].status='error';old.steps[0].error='old interrupted checkpoint';fs.writeFileSync(runFile,JSON.stringify(old));
  await post(`runs/${r.id}/start`);await runs.tick();
  saved=(await runs.route('GET',['runs'])).runs.find(x=>x.id===r.id);
  const second=jobs.getJob(saved.steps[1].jobId);assert.ok(second);
  const pixel=await sharp(second.inputPath).raw().toBuffer();assert.deepEqual([...pixel.subarray(0,3)],[0,0,255]);
  await wait(()=>second.status==='awaiting-selection');await runs.tick();assert.equal(calls,before+2);
  await post(`runs/${r.id}/cancel`);assert.equal(second.status,'error');
  await assert.rejects(()=>jobs.selectCandidate(second.id,'candidate-1'),/不能选择/);await runs.tick();assert.equal(calls,before+2);
});
test('desktop review card renders without a spinner, opens candidate tab and cancels awaiting jobs',async()=>{
 const source=fs.readFileSync(new URL('../../desktop/src/renderer/workspace.js',import.meta.url),'utf8');
 const group={id:'group',jobs:[{id:'job',status:'awaiting-selection',provider:'comfyui',prompt:'edit',createdAt:Date.now()}]};
 let listener,tab,requests=[];
 const elements={groups:{innerHTML:'',addEventListener:(_,fn)=>{listener=fn;}},jobSearch:{value:''},jobFilter:{value:''}};
 const sandbox={$:id=>elements[id],work:{renderedKey:'',jobs:group.jobs},visibleGroups:()=>[group],groupsOf:()=>[group],esc:String,providerLabel:String,titleOf:()=> 'edit',fmtTime:()=>'',sourceText:()=>'',url:x=>x,showTab:name=>{tab=name;},action:fn=>fn(),api:async(method,p)=>{requests.push(p);},refreshJobs:()=>{},openViewer:()=>{throw new Error('Pending images cannot enter result viewer');}};
 vm.createContext(sandbox);
 vm.runInContext(source.slice(source.indexOf('function renderGroups()'),source.indexOf('async function refreshJobs()'))+'\nrenderGroups();',sandbox);
 assert.match(elements.groups.innerHTML,/待选择候选图/);assert.match(elements.groups.innerHTML,/data-review-candidates/);assert.match(elements.groups.innerHTML,/data-cancel/);assert.doesNotMatch(elements.groups.innerHTML,/class="spin"|thumb failed/);
 const start=source.indexOf("$('groups').addEventListener('click'");
 vm.runInContext(source.slice(start,source.indexOf("$('jobSearch').addEventListener",start)),sandbox);
 listener({target:{closest:selector=>selector==='[data-review-candidates]'?{}:null}});assert.equal(tab,'candidates');
 listener({target:{closest:()=>null,dataset:{cancel:'group'}}});await wait(()=>requests.length===1);assert.deepEqual(requests,['/jobs/job/cancel']);
});

test('Photoshop pending review keeps polling without placement, can cancel, then places only after selection becomes done',async()=>{
 const source=fs.readFileSync(new URL('../../plugin/index.js',import.meta.url),'utf8');
 const job={id:'job',status:'awaiting-selection'},group={id:'group',jobs:[job],autoReturn:true,chanName:'bound-selection'};
 let placed=0,dropped=0,cancelled=[],state='awaiting-selection';
 const element={innerHTML:'',querySelector:()=>null};
 const sandbox={groups:[group],$:()=>element,esc:String,health:{providers:{}},HELPER:'http://local',CC_LABELS:{none:'None'},variantKey:()=>'',appliedOf:()=>({}),groupProviderText:()=> 'ComfyUI',bindGroupControls:()=>{},saveGroups:()=>{},fetch:async()=>({ok:true,json:async()=>({id:'job',provider:'comfyui',upstream:{taskId:'real-stored-id'},status:state})}),placeJob:async()=>{placed++;job.placed=true;},dropChannelIfDone:async()=>{dropped++;},post:async p=>{cancelled.push(p);},selectVariant:()=>{throw new Error('Unselected candidate cannot be placed');}};
 vm.createContext(sandbox);
 vm.runInContext(source.slice(source.indexOf('function renderGroups()'),source.indexOf('function bindGroupControls()')),sandbox);
 vm.runInContext(source.slice(source.indexOf('async function pollGroups()'),source.indexOf('async function onGroupsClick(')),sandbox);
 vm.runInContext(source.slice(source.indexOf('async function onGroupsClick('),source.indexOf('// ---------- 历史（检查点）')),sandbox);
 await vm.runInContext('pollGroups()',sandbox);
 assert.equal(placed,0);assert.equal(dropped,0);assert.equal(job.status,'awaiting-selection');assert.match(element.innerHTML,/候选与恢复/);assert.doesNotMatch(element.innerHTML,/pending err/);
 await vm.runInContext("onGroupsClick({target:{closest:()=>null,getAttribute:k=>k==='data-g'?'group':k==='data-act'?'cancel':null}})",sandbox);assert.deepEqual(cancelled,['/jobs/job/cancel']);
 job.status='error';job.recoverable=true;await vm.runInContext('pollGroups()',sandbox);assert.equal(job.status,'awaiting-selection');assert.equal(placed,0);
 state='done';await vm.runInContext('pollGroups()',sandbox);assert.equal(placed,1);assert.equal(job.status,'done');await vm.runInContext('pollGroups()',sandbox);assert.equal(placed,1);
 // The original selection channel remains available while a task is awaiting review or recoverable.
 let modalCalls=0;sandbox.core={executeAsModal:async()=>{modalCalls++;}};
 vm.runInContext(source.slice(source.indexOf('async function dropChannelIfDone('),source.indexOf('// 点缩略图：选这一张')),sandbox);
 job.placed=false;job.status='awaiting-selection';await vm.runInContext('dropChannelIfDone(groups[0])',sandbox);assert.equal(modalCalls,0);
 job.status='error';job.recoverable=true;await vm.runInContext('dropChannelIfDone(groups[0])',sandbox);assert.equal(modalCalls,0);
 job.recoverable=false;await vm.runInContext('dropChannelIfDone(groups[0])',sandbox);assert.equal(modalCalls,1);
});

test('candidate renderer uses external CSS and exposes explicit selection/recovery controls',()=>{
 const script=fs.readFileSync(new URL('../../desktop/src/renderer/candidates.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../../desktop/src/renderer/candidates.css',import.meta.url),'utf8');
 new vm.Script(script);
 assert.doesNotMatch(script,/style=|<style[ >]/);
 assert.match(script,/data-candidate-select/);assert.match(script,/data-candidate-recover/);
 for(const cls of ['candidate-grid','candidate-card','candidate-image'])assert.ok(script.includes(cls)&&css.includes(`.${cls}`));
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
