import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
const base=fs.mkdtempSync(path.join(os.tmpdir(),'psai-storage-'));
process.env.PS_AI_BRIDGE_DATA_DIR=path.join(base,'global-data');fs.mkdirSync(process.env.PS_AI_BRIDGE_DATA_DIR);
const {createStorage,storageRequestGuard,assertStorageQuota,reserveStorageQuota,STORAGE_JSON_LIMITS}=await import('../lib/storage.mjs');
const {config}=await import('../lib/config.mjs');
const {atomicJson}=await import('../lib/store.mjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
let sequence=0;
function fixture(extra={}) {
 const root=path.join(base,`case-${++sequence}`),data=path.join(root,'data'),source=path.join(root,'source');fs.mkdirSync(data,{recursive:true});fs.mkdirSync(source);fs.mkdirSync(path.join(source,'empty'));
 const jobDir=path.join(source,'20261026','job-one'),input=path.join(jobDir,'input.png'),output=path.join(jobDir,'output.png');write(input,'input-original');write(output,'generated-original');
 write(path.join(jobDir,'job.json'),{id:'job-one',status:'done',dir:jobDir,inputPath:input,result:{path:output,base:output,variants:{none:output}},log:[`text mentioning ${source}`],unrelated:`${source}-sibling/file`});
 const dependent=path.join(data,'workbench','runs','r','run.json');write(dependent,{id:'r',status:'paused',inputPath:input,steps:[{status:'done',outputPath:output}]});
 const userConfig=path.join(data,'config.json');write(userConfig,{outputDir:source,apiKey:'never-expose-this-secret',other:{keep:true}});
 const destination=path.join(fs.realpathSync(root),'destination');
 const options={dataDir:data,outputDir:source,userConfig,overrideFile:null,getJobs:()=>[],availableBytes:()=>1e12,...extra};
 const storage=createStorage(options);storage.requestGuard('GET',['storage'])();
 const post=(route,body={})=>storage.route('POST',['storage',...route.split('/')],body);
 return {root,data,source,jobDir,input,output,dependent,userConfig,destination,storage,post,options};
}
const migration=async f=>{const plan=await f.post('preflight',{destination:f.destination});return f.post('migrate',{token:plan.token,confirmed:true});};

test('user-confirmed migration copies and hashes every file, rewrites dependencies, preserves originals, commits config last and requires restart',async()=>{
 const writes=[],f=fixture({writeBytes:(file,buffer)=>{writes.push(path.basename(file));atomicJson(file,JSON.parse(buffer));}});
 const before=fs.readFileSync(f.userConfig),originalJob=fs.readFileSync(path.join(f.jobDir,'job.json'));
 const plan=await f.post('preflight',{destination:f.destination});assert.equal(fs.existsSync(f.destination),false);assert.deepEqual(fs.readFileSync(f.userConfig),before);
 await assert.rejects(()=>f.post('migrate',{token:plan.token}),/确认/);
 const inProgress=f.post('migrate',{token:plan.token,confirmed:true});
 assert.throws(()=>f.storage.requestGuard('POST',['jobs']),/迁移/);
 assert.throws(()=>f.storage.requestGuard('GET',['jobs','job-one','thumb']),/迁移/);
 const result=await inProgress;assert.equal(result.status,'committed');assert.equal(result.requiresRestart,true);
 assert.deepEqual(fs.readFileSync(path.join(f.jobDir,'job.json')),originalJob);assert.equal(fs.readFileSync(f.input,'utf8'),'input-original');assert.equal(writes.at(-1),'config.json');
 const copiedJob=JSON.parse(fs.readFileSync(path.join(f.destination,'20261026','job-one','job.json')));
 assert.equal(copiedJob.dir,path.join(f.destination,'20261026','job-one'));assert.equal(copiedJob.result.path,path.join(copiedJob.dir,'output.png'));
 assert.equal(copiedJob.log[0],`text mentioning ${f.source}`);assert.equal(copiedJob.unrelated,`${f.source}-sibling/file`);
 assert.ok(fs.statSync(path.join(f.destination,'empty')).isDirectory());
 const dependency=JSON.parse(fs.readFileSync(f.dependent));assert.equal(dependency.steps[0].outputPath,copiedJob.result.path);
 const cfg=JSON.parse(fs.readFileSync(f.userConfig));assert.equal(cfg.outputDir,f.destination);assert.equal(cfg.apiKey,'never-expose-this-secret');assert.deepEqual(cfg.other,{keep:true});
 const manifest=await f.storage.route('GET',['storage','manifest']);assert.equal(manifest.files.length,3);
 for(const row of manifest.files){assert.equal(hash(fs.readFileSync(path.join(f.source,row.path))),row.sourceSha256);assert.equal(hash(fs.readFileSync(path.join(f.destination,row.path))),row.sha256);}
 const state=await f.storage.route('GET',['storage']);assert.equal(state.requiresRestart,true);assert.ok(!JSON.stringify(state).includes('never-expose'));
 assert.throws(()=>f.storage.requestGuard('POST',['uploads']),/重启/);
 const duplicate=await f.post('migrate',{token:plan.token,confirmed:true});assert.equal(duplicate.id,result.id);assert.equal(writes.length,2);
 const restarted=createStorage({...f.options,outputDir:f.destination});restarted.requestGuard('GET',['storage'])();assert.equal((await restarted.route('GET',['storage'])).requiresRestart,false);restarted.requestGuard('POST',['jobs'])();
});

test('failure after dependent metadata write rolls back exact bytes, with copied results and restricted backups preserved',async()=>{
 let writes=0;const f=fixture({writeBytes:(file,buffer)=>{if(++writes===2)throw new Error('simulated disk failure');atomicJson(file,JSON.parse(buffer));}});
 const configBefore=fs.readFileSync(f.userConfig),dependentBefore=fs.readFileSync(f.dependent);
 await assert.rejects(()=>migration(f),/未提交/);
 assert.deepEqual(fs.readFileSync(f.userConfig),configBefore);assert.deepEqual(fs.readFileSync(f.dependent),dependentBefore);assert.ok(fs.existsSync(f.input));assert.ok(fs.existsSync(f.destination));
 const state=await f.storage.route('GET',['storage']);assert.equal(state.migration.status,'failed-rolled-back');assert.equal(state.requiresRestart,false);f.storage.requestGuard('POST',['jobs'])();
 const backup=path.join(f.data,'storage','migrations',state.migration.id,'backups','1.bin');assert.deepEqual(fs.readFileSync(backup),configBefore);assert.equal(fs.statSync(backup).mode&0o077,0);
});

test('manual rollback validates all targets before restoring, rejects new destination work, and is idempotent',async()=>{
 const f=fixture(),before=fs.readFileSync(f.dependent);const r=await migration(f);
 write(f.dependent,{...JSON.parse(before),externalEdit:true});
 await assert.rejects(()=>f.post('rollback',{id:r.id,confirmed:true}),/冲突/);assert.equal(JSON.parse(fs.readFileSync(f.userConfig)).outputDir,f.destination);
 const journal=JSON.parse(fs.readFileSync(path.join(f.data,'storage','migrations',r.id,'journal.json')));
 write(f.dependent,fs.readFileSync(path.join(f.data,'storage','migrations',r.id,journal.changes[0].staged)));
 const restarted=createStorage({...f.options,outputDir:f.destination});restarted.requestGuard('GET',['storage'])();
 write(path.join(f.destination,'new-output.png'),'new generation');await assert.rejects(()=>restarted.route('POST',['storage','rollback'],{id:r.id,confirmed:true}),/新增/);fs.unlinkSync(path.join(f.destination,'new-output.png'));
 const undone=await restarted.route('POST',['storage','rollback'],{id:r.id,confirmed:true});assert.equal(undone.requiresRestart,true);assert.deepEqual(fs.readFileSync(f.dependent),before);assert.ok(fs.existsSync(f.destination));
 assert.throws(()=>restarted.requestGuard('POST',['jobs']),/重启/);
 const again=await restarted.route('POST',['storage','rollback'],{id:r.id,confirmed:true});assert.equal(again.status,'rolled-back');
});

test('interrupted commit blocks a fresh helper until explicit rollback; no migration is replayed automatically',async()=>{
 const f=fixture(),beforeConfig=fs.readFileSync(f.userConfig),beforeDependency=fs.readFileSync(f.dependent);const r=await migration(f);
 const journalFile=path.join(f.data,'storage','migrations',r.id,'journal.json'),j=JSON.parse(fs.readFileSync(journalFile));j.status='applying';write(journalFile,j);write(f.userConfig,beforeConfig);
 const resumed=createStorage(f.options);resumed.requestGuard('GET',['storage'])();assert.throws(()=>resumed.requestGuard('POST',['jobs']),/未完成/);
 assert.notDeepEqual(fs.readFileSync(f.dependent),beforeDependency);
 await resumed.route('POST',['storage','rollback'],{id:r.id,confirmed:true});assert.deepEqual(fs.readFileSync(f.dependent),beforeDependency);assert.deepEqual(fs.readFileSync(f.userConfig),beforeConfig);
});

test('idle barrier catches in-memory jobs, persisted queues, creative nested slots/proposals, assistant work and admitted HTTP operations',async()=>{
 const shapes=[['workbench/runs/x/run.json',{status:'running'}],['workbench/batches/x.json',{status:'paused',items:[{status:'running'}]}],['workbench/creative/executions/x.json',{status:'awaiting-selection'}],['workbench/creative/executions/x.json',{status:'paused',nodes:{n:{slots:[{status:'submitting'}]}}}],['workbench/creative/proposals/x.json',{status:'analyzing'}],['assistant-workbench/plans/x.json',{status:'running'}],['assistant-workbench/sessions/x.json',{status:'responding'}],['assistant-workbench/proposals/x.json',{status:'saving'}]];
 for(const [relative,value]of shapes){const f=fixture();write(path.join(f.data,relative),{id:'x',...value});await assert.rejects(()=>f.post('preflight',{destination:f.destination}),/活动任务/);assert.equal(fs.existsSync(f.destination),false);}
 const f=fixture({getJobs:()=>[{id:'memory-only',status:'awaiting-selection'}]});await assert.rejects(()=>f.post('preflight',{destination:f.destination}),/活动任务/);
 const h=fixture(),release=h.storage.requestGuard('POST',['retouch','glow']);await assert.rejects(()=>h.post('preflight',{destination:h.destination}),/活动任务/);release();release();await h.post('preflight',{destination:h.destination});
 const unmounted=createStorage(h.options);await assert.rejects(()=>unmounted.route('POST',['storage','preflight'],{destination:h.destination}),/storageRequestGuard/);
});

test('space, stale snapshots, malformed JSON, unsafe destination and nested symlinks stop before config changes',async()=>{
 const low=fixture({availableBytes:()=>1});await assert.rejects(()=>low.post('preflight',{destination:low.destination}),/空间不足/);
 const f=fixture();
 for(const dest of [f.source,path.join(fs.realpathSync(f.source),'inside'),fs.realpathSync(f.root),path.join(fs.realpathSync(f.data),'inside'),'relative-folder'])await assert.rejects(()=>f.post('preflight',{destination:dest}));
 const alias=path.join(fs.realpathSync(f.root),'alias');fs.symlinkSync(fs.realpathSync(f.source),alias);await assert.rejects(()=>f.post('preflight',{destination:path.join(alias,'new')}),/符号链接/);
 fs.symlinkSync(f.input,path.join(f.source,'linked.png'));await assert.rejects(()=>f.post('preflight',{destination:f.destination}),/符号链接/);fs.unlinkSync(path.join(f.source,'linked.png'));
 const plan=await f.post('preflight',{destination:f.destination});write(f.input,'changed after preflight');await assert.rejects(()=>f.post('migrate',{token:plan.token,confirmed:true}),/发生变化/);assert.equal(fs.existsSync(f.destination),false);
 write(path.join(f.data,'bad.json'),'invalid secret-key-content');await assert.rejects(()=>f.post('preflight',{destination:f.destination}),e=>e.message.includes('JSON')&&!e.message.includes('secret-key'));
});

test('trusted macOS tmpdir aliases canonicalize while source references are remapped correctly',async()=>{
 const f=fixture();const state=await f.storage.route('GET',['storage']);assert.equal(state.outputDir,fs.realpathSync(f.source));await migration(f);
 assert.equal(JSON.parse(fs.readFileSync(f.dependent)).inputPath,path.join(f.destination,'20261026','job-one','input.png'));
});

test('external modifications during asynchronous copying abort without overwriting the external edit',async()=>{
 const f=fixture();const beforeConfig=fs.readFileSync(f.userConfig),plan=await f.post('preflight',{destination:f.destination});
 const task=f.post('migrate',{token:plan.token,confirmed:true});
 write(f.dependent,{id:'r',status:'paused',externalEdit:'keep-me'});
 await assert.rejects(()=>task,/变化|改变/);assert.equal(JSON.parse(fs.readFileSync(f.dependent)).externalEdit,'keep-me');assert.deepEqual(fs.readFileSync(f.userConfig),beforeConfig);
});

test('preview quota counts workbench inputs but only retouch outputs/layers; sources and checkpoints are protected',async()=>{
 const f=fixture();
 write(path.join(f.data,'workbench','preview-assets','p','input.png'),'1234');write(path.join(f.data,'workbench','preview-assets','p','output.png'),'12345');
 write(path.join(f.data,'workbench','previews','p.json'),{id:'p',sourcePath:path.join(f.data,'workbench','preview-assets','p','input.png'),outputPath:path.join(f.data,'workbench','preview-assets','p','output.png')});
 const retouch=path.join(f.data,'workbench','retouch','retouch-one');write(path.join(retouch,'input.png'),'source');write(path.join(retouch,'reference.png'),'reference');write(path.join(retouch,'output.png'),'derived');write(path.join(retouch,'layer.png'),'layer');write(path.join(retouch,'preview.json'),{id:'retouch-one',source:path.join(retouch,'input.png'),output:path.join(retouch,'output.png'),layer:path.join(retouch,'layer.png')});
 write(path.join(f.source,'_checkpoints','cp.png'),'checkpoint');
 write(path.join(f.data,'workbench','projects','pin.json'),{path:fs.realpathSync(path.join(retouch,'output.png'))});
 const state=await f.storage.route('GET',['storage']);assert.equal(state.quota.checkpointLimitBytes,(Number(config.checkpointMaxGB)||20)*1024**3);assert.equal(state.quota.previewBytes,21);
 await f.post('quota',{previewLimitBytes:state.quota.previewBytes+10,checkpointLimitBytes:10});
 assert.equal(f.storage.quotaPreflight('preview',11).allowed,false);assert.equal(f.storage.quotaPreflight('checkpoint',1).allowed,false);
 const release=f.storage.reserveQuota('preview',8);assert.throws(()=>f.storage.reserveQuota('preview',3),/配额/);await assert.rejects(()=>f.post('preflight',{destination:f.destination}),/活动任务/);release();assert.equal(f.storage.quotaPreflight('preview',10).allowed,true);
 const proposal=await f.storage.route('GET',['storage','cleanup-proposal']);assert.equal(proposal.automaticDeletion,false);assert.ok(proposal.candidates.some(x=>x.path.endsWith('layer.png')));assert.ok(!proposal.candidates.some(x=>x.path.endsWith('input.png')||x.path.endsWith('reference.png')));assert.ok(!proposal.candidates.some(x=>x.path===path.join('workbench','retouch','retouch-one','output.png')));assert.equal(fs.readFileSync(path.join(retouch,'input.png'),'utf8'),'source');assert.equal(proposal.protectedCheckpointBytes,10);
 await f.post('quota',{previewLimitBytes:0,checkpointLimitBytes:0});assert.equal(f.storage.quotaPreflight('checkpoint',1e9).allowed,true);
});

test('exported quota hooks reject real writes before creation and count held reservations',async()=>{
 const globalData=process.env.PS_AI_BRIDGE_DATA_DIR;config.outputDir=path.join(base,'global-output');fs.mkdirSync(config.outputDir);storageRequestGuard('GET',['storage'])();
 write(path.join(globalData,'storage','settings.json'),{previewLimitBytes:5,checkpointLimitBytes:5});
 const dest=path.join(globalData,'workbench','preview-assets','new','output.png');
 assert.throws(()=>{assertStorageQuota('preview',6);write(dest,'123456');},/配额/);assert.equal(fs.existsSync(dest),false);
 const release=reserveStorageQuota('preview',4);assert.throws(()=>assertStorageQuota('preview',2),/配额/);release();assertStorageQuota('preview',4);write(dest,'1234');assert.throws(()=>assertStorageQuota('preview',2),/配额/);
});

test('large inline-reference presets cannot break status, quota checks, reservations or real preview writes',async()=>{
 const f=fixture(),preset=path.join(f.data,'presets','p_msg2dbh7_r4nuzw.json');
 write(preset,{id:'p_msg2dbh7_r4nuzw',title:'large reference',references:[{dataUrl:'data:image/png;base64,'+Buffer.alloc(13*1024*1024,65).toString('base64')}]});
 assert.ok(fs.statSync(preset).size>16*1024*1024);
 const originalHash=hash(fs.readFileSync(preset)),read=fs.readFileSync;let presetReads=0;
 fs.readFileSync=function(file,...args){if(String(file).includes('p_msg2dbh7_r4nuzw.json')){presetReads++;throw new Error('must not read presets for status or quota');}return read.call(this,file,...args);};
 try{
  const state=await f.storage.route('GET',['storage']);assert.equal(state.active.length,0);
  assert.equal(f.storage.quotaPreflight('preview',4).allowed,true);
  const release=f.storage.reserveQuota('preview',4);
  try{f.storage.assertQuota('preview',4);write(path.join(f.data,'workbench','retouch','small','output.png'),'1234');}finally{release();}
  assert.equal((await f.storage.route('GET',['storage'])).quota.previewBytes,4);
  assert.equal(presetReads,0);
 }finally{fs.readFileSync=read;}
 // Full migration explicitly scans the same >16 MiB JSON and preserves its embedded bytes.
 const migrated=await migration(f);assert.equal(migrated.status,'committed');assert.equal(hash(fs.readFileSync(preset)),originalHash);
});

test('quota accounting never parses unrelated, job, run or preview JSON contents',async()=>{
 const f=fixture();write(path.join(f.data,'presets','broken.json'),'malformed unrelated JSON');
 write(path.join(f.jobDir,'job.json'),'malformed job JSON');write(f.dependent,'malformed run JSON');
 write(path.join(f.data,'workbench','retouch','r','preview.json'),'malformed preview JSON');write(path.join(f.data,'workbench','retouch','r','output.png'),'123');
 const read=fs.readFileSync;let reads=0;
 fs.readFileSync=function(file,...args){if(String(file).endsWith('.json')){reads++;throw new Error('quota should only stat managed image files');}return read.call(this,file,...args);};
 try{assert.equal(f.storage.quotaPreflight('preview',1).usedBytes,3);f.storage.assertQuota('checkpoint',1);f.storage.reserveQuota('preview',1)();assert.equal(reads,0);}finally{fs.readFileSync=read;}
 const state=await f.storage.route('GET',['storage']);assert.ok(state.active.some(x=>x.status==='unverified'));assert.equal(state.quota.previewBytes,3);
 await assert.rejects(()=>f.post('preflight',{destination:f.destination}),/JSON/);
});

test('migration reports individual and aggregate JSON budgets before parsing oversized files; storage/quota stay usable',async()=>{
 for(const aggregate of [false,true]){
  const f=fixture(),presetRoot=path.join(f.data,'presets');fs.mkdirSync(presetRoot);
  const count=aggregate?Math.floor(STORAGE_JSON_LIMITS.totalBytes/STORAGE_JSON_LIMITS.fileBytes)+1:1;
  for(let i=0;i<count;i++){const fd=fs.openSync(path.join(presetRoot,`large-${i}.json`),'w');try{fs.ftruncateSync(fd,STORAGE_JSON_LIMITS.fileBytes+(aggregate?0:1));}finally{fs.closeSync(fd);}}
  const read=fs.readFileSync;let reads=0;
  fs.readFileSync=function(file,...args){if(String(file).includes(`${path.sep}presets${path.sep}`)){reads++;throw new Error('budget must be checked before JSON read');}return read.call(this,file,...args);};
  try{
   assert.equal((await f.storage.route('GET',['storage'])).active.length,0);
   await f.post('quota',{previewLimitBytes:1024,checkpointLimitBytes:1024});f.storage.assertQuota('preview',8);
   await assert.rejects(()=>f.post('preflight',{destination:f.destination}),e=>e.statusCode===409&&e.message.includes(aggregate?'512 MiB':'128 MiB')&&e.message.includes('状态和配额仍可使用'));
   assert.equal(reads,0);assert.equal(fs.existsSync(f.destination),false);assert.equal(JSON.parse(read(f.userConfig)).outputDir,f.source);
  }finally{fs.readFileSync=read;}
 }
});

test('storage UI is syntax valid, CSP-compatible, manual only, with no main/preload dependency',()=>{
 const source=fs.readFileSync(new URL('../../desktop/src/renderer/storage.js',import.meta.url),'utf8');new vm.Script(source);assert.doesNotMatch(source,/style=|<style[ >]/);assert.match(source,/confirmed:true/);assert.match(source,/\/storage\/preflight/);assert.match(source,/bridge.open\('output'\)/);
});
test.after(()=>fs.rmSync(base,{recursive:true,force:true}));
