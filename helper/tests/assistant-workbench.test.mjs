import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import sharp from 'sharp';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-assistant-test-'));
process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(dir,'outputs');
const jobs=await import('../lib/jobs.mjs');
const presets=await import('../lib/presets.mjs');
const {atomicJson}=await import('../lib/store.mjs');
const {regionRoutes}=await import('../lib/regions.mjs');
const {createAssistantWorkbench,validatePresetProposal,validateRetouchPlan}=await import('../lib/assistant-workbench.mjs');
const {assistChat}=await import('../lib/assist.mjs');
const {channelRoutes,channelAssist}=await import('../providers/channels.mjs');
const target={session:'session-test',docId:42,width:24,height:24,name:'original.psd'};
const bounds={left:0,top:0,right:24,bottom:24};
const image=await sharp({create:{width:24,height:24,channels:4,background:'#7799bb'}}).png().toBuffer();
let bridgeCalls=[],generationCalls=[],currentTarget={...target},blockBridge=null,blockGeneration=null;
const context={
  providers:{fake:{async run(j){generationCalls.push(j.id);if(blockGeneration)await blockGeneration;const file=path.join(j.dir,'actual.png');fs.copyFileSync(j.inputPath,file);return {path:file,width:24,height:24};}}},
  capabilities:{fake:{aspects:['1:1'],models:['test-image'],resolutions:['1K']}},
  bridge:{async request(c){bridgeCalls.push(structuredClone(c));if(c.type==='documents')return {session:currentTarget.session,documents:[{...currentTarget,activeLayerId:7}]};if(blockBridge)await blockBridge;
    if(c.type==='capture-region')return regionRoutes('POST',['regions','capture'],{target:c.target,rect:c.rect,uploadId:jobs.saveUpload(image,'image/png')});
    return {docId:c.target.docId,jobId:c.jobId||null,captureId:c.captureId||null,output:c.output||null,type:c.type};
  }},
};
let workbench=createAssistantWorkbench(context);
const route=(method,suffix='',body={})=>workbench.route(method,['assistant-workbench',...suffix.split('/').filter(Boolean)],body);
const post=(suffix,body)=>route('POST',suffix,body);
const get=suffix=>route('GET',suffix);
const approval=r=>({approved:true,revision:r.revision});
const planBody=(steps)=>({target,plan:{title:'Bound retouch',steps}});
const capture={type:'capture-region',title:'Capture source',rect:bounds};
const generate={type:'generate',title:'Generate preview',captureStep:0,provider:'fake',model:'test-image',prompt:'Preserve identity',aspect:'1:1',resolution:'1K'};
const paste={type:'paste-bound',title:'Place reviewed result',captureStep:0,jobStep:1};
async function execute(p){return post(`plans/${p.id}/execute`,{...approval(p),stepId:p.steps.find(s=>s.status!=='done').id});}
async function settled(p){for(let i=0;i<300;i++){const r=await get(`plans/${p.id}`);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,10));}assert.fail('job did not settle');}
let replies=[],requests=[];
const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  const next=replies.shift()??'ok';const answer=typeof next==='function'?await next(body):next;
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:answer}}]}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
await channelRoutes('POST',['channels','save'],{revision:0,kind:'custom',title:'Fixture channel',url:`http://127.0.0.1:${server.address().port}`,protocol:'images',key:'fixture-not-secret',model:'test-image',textModel:'test-chat',enabled:true,useForAssist:true});

test('strict schemas reject generated commands, polluted objects, unknown fields and out-of-bound steps',async()=>{
  for(const payload of [
    {title:'x',category:'other',content:'x',script:'rm -rf /'},
    {title:'x',category:'other',content:'x',workflow:{nodes:[]}},
    JSON.parse('{"title":"x","category":"other","content":"x","__proto__":{"admin":true}}'),
    {title:'x',category:'other',content:{tool:'exec'}},
    {title:'x',category:'bad',content:'x'},
  ])assert.throws(()=>validatePresetProposal(payload));
  const invalid=[
    [{type:'shell',title:'bad',command:'touch /tmp/no'}],
    [{type:'capture-region',title:'bad',rect:{...bounds,right:25}}],
    [{type:'select-subject',title:'bad',target:{...target,docId:99}}],
    [capture,{...generate,captureStep:1}],
    [capture,{...generate,provider:'__proto__'}],
    [capture,{...generate,aspect:'9:16'}],
    [capture,{...generate,model:'injected'}],
    [capture,generate,{...paste,jobStep:0}],
    [capture,generate,{type:'apply-mask',title:'bad',captureStep:0,jobStep:1,mode:'luma',output:'mask',layerId:7}],
    Array.from({length:13},()=>({type:'select-subject',title:'too many'})),
  ];
  const count=(await get()).plans.length,calls=bridgeCalls.length;
  for(const steps of invalid)await assert.rejects(()=>post('plans',planBody(steps)));
  assert.equal((await get()).plans.length,count);assert.equal(bridgeCalls.length,calls);
  assert.throws(()=>validateRetouchPlan({title:'x',steps:[capture],code:'eval()'},target,context.providers,context.capabilities));
  await assert.rejects(()=>get('sessions/../../config'));
  assert.equal(await workbench.route('GET',['elsewhere']),undefined);
});

test('knowledge citations are real source line ranges and preserved text, with no seeded proprietary material',async()=>{
  assert.equal((await get()).knowledge.length,0);
  const content='\n# My manual\nPreserve venue background.\nSkin: keep pores and texture.\nNever change clothing.\n';
  const source=await post('knowledge',{name:'personal.md',text:content});
  assert.equal(source.text,content);assert.equal(source.lineCount,6);
  const duplicate=await post('knowledge',{name:'personal.md',text:content});assert.equal(source.id,duplicate.id);
  const {sources}=await post('knowledge/search',{query:'skin texture'});assert.equal(sources[0].sourceId,source.id);
  assert.equal(sources[0].excerpt,content.split('\n').slice(sources[0].startLine-1,sources[0].endLine).join('\n'));
  assert.equal((await get(`knowledge/${source.id}`)).digest,sources[0].digest);
  assert.deepEqual((await post('knowledge/search',{query:'unfindablezebra'})).sources,[]);
  await assert.rejects(()=>post('knowledge',{name:'evil.js',text:'script'}));
  await assert.rejects(()=>post('knowledge',{name:'../leak.md',text:'x'}));
});

test('channel conversation preserves roles, images and retrieval across restart; old assist still uses its prompt contract',async()=>{
  let s=await post('sessions',{title:'Vision thread'});const upload=jobs.saveUpload(image,'image/png');
  replies.push('Advice only');s=await post(`sessions/${s.id}/messages`,{text:'skin texture',uploadIds:[upload],backend:'channel'});
  assert.equal(s.status,'idle');assert.equal(s.messages[1].sources.length,1);assert.equal(s.messages[1].source.model,'test-chat');
  const first=requests.at(-1);assert.equal(first.messages[1].role,'user');assert.equal(first.messages[1].content[1].type,'image_url');
  const pinned=path.join(dir,'assistant-workbench','assets',s.id,s.messages[0].images[0]);assert.ok(fs.existsSync(pinned));fs.unlinkSync(jobs.useUpload(upload));
  workbench.close();workbench=createAssistantWorkbench(context);
  replies.push('Follow-up');s=await post(`sessions/${s.id}/messages`,{text:'Continue carefully',backend:'channel'});
  const second=requests.at(-1);assert.deepEqual(second.messages.map(m=>m.role),['system','user','assistant','user']);
  assert.equal(second.messages[1].content[1].image_url.url,first.messages[1].content[1].image_url.url);
  assert.equal(second.messages[2].content,'Advice only');assert.equal(s.messages.length,4);
  replies.push('Original helper response');assert.equal(await channelAssist({text:'brighten'}),'Original helper response');assert.match(requests.at(-1).messages[0].content[0].text,/只输出提示词/);
});

test('malicious generated JSON remains a failed proposal, never a saved preset or action',async()=>{
  const before=presets.listPresets().length,calls=bridgeCalls.length;
  let s=await post('sessions',{title:'Malicious generated proposal'});
  replies.push('{"title":"evil","category":"other","content":"text","shell":"rm -rf /"}');
  s=await post(`sessions/${s.id}/messages`,{text:'Create preset',mode:'preset',backend:'channel'});
  assert.match(s.messages.at(-1).validationError,/不允许的字段/);assert.equal(s.messages.at(-1).proposalId,undefined);
  replies.push('{"title":"evil","steps":[{"type":"eval","title":"run","code":"process.exit()"}]}');
  s=await post(`sessions/${s.id}/messages`,{text:'Create plan',mode:'plan',target,backend:'channel'});
  assert.match(s.messages.at(-1).validationError,/不允许的动作/);assert.equal(s.messages.at(-1).planId,undefined);
  replies.push('I have already executed all Photoshop tools.');
  s=await post(`sessions/${s.id}/messages`,{text:'What happened?',backend:'channel'});
  assert.equal(presets.listPresets().length,before);assert.equal(bridgeCalls.length,calls);
});

test('preset inbox requires exact approval, preserves revisions, detects conflicts and restores without overwriting newer work',async()=>{
  const existing=presets.savePreset({title:'Original',category:'cleanup',content:'Before'});
  let p=await post('proposals',{proposal:{title:'Revised',category:'cleanup',content:'After'},presetId:existing.id,expectedRevision:existing.revision});
  assert.equal(presets.getPreset(existing.id).content,'Before');
  await assert.rejects(()=>post(`proposals/${p.id}/approve`,{}),/批准/);
  await assert.rejects(()=>post(`proposals/${p.id}/approve`,{approved:true,revision:0}),/批准/);
  const approvedOnce=await post(`proposals/${p.id}/approve`,approval(p));assert.equal(approvedOnce.status,'saved');assert.equal(approvedOnce.saved.revision,2);
  await assert.rejects(()=>post(`proposals/${p.id}/approve`,approval(approvedOnce)),/重复/);
  p=await post(`proposals/${p.id}/restore`,approval(approvedOnce));assert.equal(p.status,'restored');assert.equal(p.restored.revision,3);assert.equal(presets.getPreset(existing.id).content,'Before');
  assert.deepEqual(presets.listRevisions(existing.id).map(r=>r.content),['After','Before']);
  let conflict=await post('proposals',{proposal:{title:'Stale',category:'cleanup',content:'stale'},presetId:existing.id,expectedRevision:3});
  presets.savePreset({id:existing.id,title:'External',category:'cleanup',content:'newer',expectedRevision:3});
  conflict=await post(`proposals/${conflict.id}/approve`,approval(conflict));assert.equal(conflict.status,'needs-attention');assert.equal(presets.getPreset(existing.id).content,'newer');
  let rejected=await post('proposals',{proposal:{title:'Rejected',category:'other',content:'unused'}});rejected=await post(`proposals/${rejected.id}/reject`,approval(rejected));await assert.rejects(()=>post(`proposals/${rejected.id}/approve`,approval(rejected)));
});

test('retouch executes exactly one approved step, records actual capture/job results, then requires separate placement approval',async()=>{
  const before=bridgeCalls.length,jobsBefore=generationCalls.length;
  let p=await post('plans',planBody([capture,generate,paste,{type:'apply-mask',title:'Load luma selection',captureStep:0,jobStep:1,mode:'luma'}]));
  assert.equal(bridgeCalls.length,before);assert.equal(generationCalls.length,jobsBefore);
  await assert.rejects(()=>post(`plans/${p.id}/execute`,{stepId:p.steps[0].id}),/批准/);
  await assert.rejects(()=>post(`plans/${p.id}/execute`,{...approval(p),stepId:p.steps[1].id}),/下一/);
  const preview=p;p=await execute(p);assert.equal(p.steps[0].status,'done');assert.equal(p.status,'ready');assert.ok(p.steps[0].result.id);
  await assert.rejects(()=>execute(preview),/批准/);
  p=await execute(p);assert.ok(p.steps[1].jobId);p=await settled(p);assert.equal(p.steps[1].status,'done');assert.equal(generationCalls.length,jobsBefore+1);
  assert.ok(fs.existsSync(jobs.getJob(p.steps[1].jobId).result.path));assert.equal(bridgeCalls.slice(before).some(c=>c.type==='paste-bound'),false);
  p=await execute(p);assert.equal(p.steps[2].status,'done');assert.equal(p.status,'ready');
  const placed=bridgeCalls.findLast(c=>c.type==='paste-bound');assert.deepEqual(placed.target,target);assert.equal(placed.jobId,p.steps[1].jobId);assert.equal(placed.captureId,p.steps[0].result.id);
  p=await execute(p);assert.equal(p.status,'done');const mask=bridgeCalls.at(-1);assert.equal(mask.output,'selection');assert.equal(mask.mode,'luma');assert.equal(mask.jobId,p.steps[1].jobId);
  await assert.rejects(()=>execute(p));
});

test('closed or changed PS targets and rebound captures stop before any mutating bridge call',async()=>{
  let p=await post('plans',planBody([{type:'select-subject',title:'Subject'}]));currentTarget={...target,session:'different-session'};const before=bridgeCalls.length;
  p=await execute(p);assert.equal(p.status,'needs-attention');assert.match(p.error,/目标文档/);assert.deepEqual(bridgeCalls.slice(before).map(c=>c.type),['documents']);currentTarget={...target};
  p=await post('plans',planBody([capture,{type:'locate-region',title:'Locate',captureStep:0}]));p=await execute(p);
  await regionRoutes('POST',['regions','rebind'],{id:p.steps[0].result.id,target:{...target,docId:43}});
  p=await execute(p);assert.equal(p.status,'needs-attention');assert.match(p.error,/捕获绑定/);
});

test('concurrent execution and stop cannot dispatch the next step or erase a late PS result',async()=>{
  let release;blockBridge=new Promise(r=>{release=r;});let p=await post('plans',planBody([{type:'select-subject',title:'First'},{type:'select-subject',title:'Second'}]));
  const running=execute(p);await new Promise(r=>setImmediate(r));const current=await get(`plans/${p.id}`);assert.equal(current.status,'running');
  await assert.rejects(()=>execute(current),/不能执行/);const cancelled=await post(`plans/${p.id}/cancel`);assert.equal(cancelled.status,'cancelled');release();blockBridge=null;
  p=await running;assert.equal(p.status,'cancelled');assert.equal(p.steps[0].result.docId,target.docId);assert.match(p.steps[0].note,/可能已完成/);assert.equal(p.steps[1].status,'cancelled');await assert.rejects(()=>execute(p));
});

test('restart interrupts generation without resubmission; explicit reconciliation adopts a real completed job',async()=>{
  let release;blockGeneration=new Promise(r=>{release=r;});let p=await post('plans',planBody([capture,generate,paste]));p=await execute(p);p=await execute(p);const jobId=p.steps[1].jobId,count=generationCalls.length;
  workbench.close();workbench=createAssistantWorkbench(context);p=await get(`plans/${p.id}`);assert.equal(p.status,'interrupted');assert.equal(p.steps[1].jobId,jobId);
  await assert.rejects(()=>execute(p),/不能执行/);await assert.rejects(()=>post(`plans/${p.id}/reconcile`,approval(p)),/尚无/);
  release();blockGeneration=null;for(let i=0;i<300&&jobs.getJob(jobId).status!=='done';i++)await new Promise(r=>setTimeout(r,10));
  p=await post(`plans/${p.id}/reconcile`,approval(p));assert.equal(p.status,'ready');assert.equal(p.steps[1].status,'done');assert.equal(generationCalls.length,count);assert.equal(p.steps[2].status,'pending');
});

test('restart during unknown PS/preset writes and chat response is retained for manual review and never replayed',async()=>{
  let p=await post('plans',planBody([{type:'select-subject',title:'Unknown'}]));p.status='running';p.steps[0].status='running';atomicJson(path.join(dir,'assistant-workbench','plans',`${p.id}.json`),p);
  let proposal=await post('proposals',{proposal:{title:'Unknown write',category:'other',content:'text'}});proposal.status='saving';atomicJson(path.join(dir,'assistant-workbench','proposals',`${proposal.id}.json`),proposal);
  let s=await post('sessions',{title:'Unknown response'});s.status='responding';s.messages=[{id:'x',role:'user',text:'hello',status:'pending'}];atomicJson(path.join(dir,'assistant-workbench','sessions',`${s.id}.json`),s);
  const before=bridgeCalls.length,count=presets.listPresets().length;
  workbench.close();workbench=createAssistantWorkbench(context);
  p=await get(`plans/${p.id}`);assert.equal(p.status,'interrupted');await assert.rejects(()=>post(`plans/${p.id}/reconcile`,approval(p)),/不能重放/);
  proposal=await get(`proposals/${proposal.id}`);assert.equal(proposal.status,'interrupted');await assert.rejects(()=>post(`proposals/${proposal.id}/approve`,approval(proposal)));
  s=await get(`sessions/${s.id}`);assert.equal(s.status,'interrupted');assert.equal(s.messages[0].status,'interrupted');assert.equal(bridgeCalls.length,before);assert.equal(presets.listPresets().length,count);
});

test('cancelled chat rejects parallel turns and cannot publish a late generated plan',async()=>{
  let release,observed;const arrived=new Promise(r=>{observed=r;});const waiting=new Promise(r=>{release=r;});replies.push(async()=>{observed();await waiting;return JSON.stringify({title:'Never execute',steps:[{type:'select-subject',title:'Subject'}]});});
  const s=await post('sessions',{title:'Cancel test'}),before=(await get()).plans.length;
  const pending=post(`sessions/${s.id}/messages`,{text:'Plan',mode:'plan',target,backend:'channel'});
  await arrived;await assert.rejects(()=>post(`sessions/${s.id}/messages`,{text:'Parallel'}),/回复/);
  await post(`sessions/${s.id}/cancel`);release();const ended=await pending;assert.equal(ended.status,'cancelled');assert.equal((await get()).plans.length,before);
});


test('generated proposals stay pending, double approval saves once, and successful generated plans retain the user target',async()=>{
  let s=await post('sessions',{title:'Valid generation'});const count=presets.listPresets().length,calls=bridgeCalls.length;
  replies.push(JSON.stringify({title:'Generated preset',category:'cleanup',content:'Preserve background'}));
  s=await post(`sessions/${s.id}/messages`,{text:'Create a preset',mode:'preset',backend:'channel'});
  const proposal=await get(`proposals/${s.messages.at(-1).proposalId}`);assert.equal(proposal.status,'pending');assert.equal(presets.listPresets().length,count);
  const approvals=await Promise.allSettled([post(`proposals/${proposal.id}/approve`,approval(proposal)),post(`proposals/${proposal.id}/approve`,approval(proposal))]);
  assert.equal(approvals.filter(a=>a.status==='fulfilled').length,1);assert.equal(presets.listPresets().length,count+1);
  replies.push(JSON.stringify({title:'Generated plan',steps:[{type:'select-subject',title:'Subject'}]}));
  s=await post(`sessions/${s.id}/messages`,{text:'Create plan',mode:'plan',target,backend:'channel'});
  const plan=await get(`plans/${s.messages.at(-1).planId}`);assert.equal(plan.status,'preview');assert.deepEqual(plan.target,target);assert.equal(bridgeCalls.length,calls);
});

test('empty or wrong-document success receipts are not reported as completed Photoshop actions',async()=>{
  const original=context.bridge.request;
  try{
    for(const receipt of [{},{docId:999},{ok:false,docId:target.docId}]){
      context.bridge.request=async c=>c.type==='documents'?{documents:[target]}:receipt;
      let p=await post('plans',planBody([{type:'select-subject',title:'Subject'}]));p=await execute(p);
      assert.equal(p.status,'needs-attention');assert.equal(p.steps[0].status,'error');
    }
  }finally{context.bridge.request=original;}
});

test('restart recovers job identity from durable metadata if the job-id write was interrupted',async()=>{
  let p=await post('plans',planBody([capture,generate]));p=await execute(p);p=await execute(p);p=await settled(p);
  const jobId=p.steps[1].jobId,count=generationCalls.length;p.status='running';p.steps[1].status='running';delete p.steps[1].jobId;delete p.steps[1].result;
  atomicJson(path.join(dir,'assistant-workbench','plans',`${p.id}.json`),p);
  workbench.close();workbench=createAssistantWorkbench(context);p=await get(`plans/${p.id}`);assert.equal(p.steps[1].jobId,jobId);assert.equal(p.status,'interrupted');
  p=await post(`plans/${p.id}/reconcile`,approval(p));assert.equal(p.status,'done');assert.equal(generationCalls.length,count);
});

test('cancelled generation never becomes placement-ready and records the upstream job identity',async()=>{
  let release;blockGeneration=new Promise(r=>{release=r;});let p=await post('plans',planBody([capture,generate,paste]));p=await execute(p);p=await execute(p);
  const jobId=p.steps[1].jobId;p=await post(`plans/${p.id}/cancel`);assert.equal(p.status,'cancelled');assert.equal(jobs.getJob(jobId).abort.signal.aborted,true);
  release();blockGeneration=null;
  for(let i=0;i<100&&!jobs.getJob(jobId).finishedAt;i++)await new Promise(r=>setTimeout(r,10));
  p=await get(`plans/${p.id}`);assert.equal(p.status,'cancelled');assert.equal(p.steps[1].jobId,jobId);assert.equal(p.steps[2].status,'cancelled');await assert.rejects(()=>execute(p));
});

test('renderer mounts a late tab, binds showTab, escapes untrusted text and catches helper failures',async()=>{
  // Lightweight DOM contract test, not a claim of Electron visual acceptance.
  const nodes=new Map(),listeners=new Map(),shown=[],errors=[],intervals=[];
  class Element{
    constructor(tag='div'){this.tag=tag;this.dataset={};this.hidden=false;this.value='';this.children=[];this.attributes={};}
    set innerHTML(value){this.html=value;for(const [,id]of value.matchAll(/\bid="([^"]+)"/g))if(!nodes.has(id))nodes.set(id,new Element());}
    get innerHTML(){return this.html||'';}
    append(node){this.children.push(node);if(node.id)nodes.set(node.id,node);}
    setAttribute(k,v){this.attributes[k]=v;}
    addEventListener(k,v){this[k]=v;}
    querySelectorAll(){return [];}
  }
  const tabbar=new Element(),main=new Element(),settingsMain=new Element();nodes.set('tab-work',{parentElement:main});const document={body:new Element(),getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag),querySelector:s=>s==='.tabs'?tabbar:s==='main'?settingsMain:null,addEventListener:(name,fn)=>listeners.set(name,fn)};
  const escape=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let failApi=false;
  const sandbox={document,window:{addEventListener(){},bridge:{}},showTab:name=>shown.push(name),esc:escape,url:p=>p,reason:e=>e.message,toast:(m,e)=>errors.push({m,e}),setInterval:fn=>(intervals.push(fn),1),clearInterval(){},api:async()=>{if(failApi)throw new Error('Helper offline');return {sessions:[],knowledge:[{id:'source',name:'<img src=x onerror=evil()>',lineCount:1}],proposals:[],plans:[]};}};
  vm.runInNewContext(fs.readFileSync(new URL('../../desktop/src/renderer/assistant-workbench.js',import.meta.url),'utf8'),sandbox);
  assert.equal(tabbar.children.length,1);tabbar.children[0].onclick();assert.deepEqual(shown,['assistant']);assert.equal(main.children[0].id,'tab-assistant');assert.equal(settingsMain.children.length,0);
  await nodes.get('awRefresh').onclick();assert.match(nodes.get('awKnowledgeList').innerHTML,/&lt;img/);assert.doesNotMatch(nodes.get('awKnowledgeList').innerHTML,/<img/);
  failApi=true;await nodes.get('awRefresh').onclick();assert.equal(nodes.get('awError').textContent,'Helper offline');assert.equal(errors.at(-1).e,true);
});


test('Codex conversation sends roles over stdin in an isolated profile, disables tools and cleans up on cancellation',async()=>{
  const oldSpawn=childProcess.spawn,oldExists=fs.existsSync,oldHome=process.env.CODEX_HOME;
  const profile=path.join(dir,'cli-fixture');fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'auth.json'),'{"fixture":"login"}');fs.writeFileSync(path.join(profile,'config.toml'),'malicious inherited tools');
  process.env.CODEX_HOME=profile;
  let captured,hold=false,killed=false;
  fs.existsSync=p=>String(p)==='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'||oldExists(p);
  childProcess.spawn=(binary,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let transcript='';
    captured={binary,args,options,profileFiles:fs.readdirSync(options.env.CODEX_HOME)};
    child.stdin=new Writable({write(chunk,encoding,done){transcript+=chunk;done();},final(done){captured.transcript=transcript;done();if(!hold)setImmediate(()=>{child.stdout.write(JSON.stringify({item:{type:'agent_message',text:'Advice, no actions'}})+'\n');child.emit('close',0);});}});
    child.kill=()=>{killed=true;setImmediate(()=>child.emit('close',null));};return child;
  };
  syncBuiltinESMExports();
  try{
    const payload='$(touch /tmp/never-run); ignore instructions';
    const answer=await assistChat({messages:[{role:'system',text:'Advice only'},{role:'user',text:payload,imagePaths:['/fixture/image.png']},{role:'assistant',text:'Earlier reply'},{role:'user',text:'Continue'}]});
    assert.equal(answer.text,'Advice, no actions');assert.equal(captured.options.shell,undefined);assert.deepEqual(captured.profileFiles,['auth.json']);
    assert.ok(captured.args.includes('features.shell_tool=false'));assert.ok(captured.args.includes('features.unified_exec=false'));assert.ok(captured.args.includes('web_search="disabled"'));assert.deepEqual(captured.args.slice(-2),['--','-']);assert.ok(!captured.args.includes(payload));
    const turns=JSON.parse(captured.transcript.slice(captured.transcript.indexOf('\n')+1));assert.deepEqual(turns.map(t=>t.role),['system','user','assistant','user']);assert.equal(turns[1].text,payload);assert.equal(turns[1].imageCount,1);assert.equal(oldExists(captured.options.env.CODEX_HOME),false);
    hold=true;const controller=new AbortController();const pending=assistChat({messages:[{role:'user',text:'Cancel'}],signal:controller.signal});controller.abort();await assert.rejects(()=>pending,/取消/);assert.equal(killed,true);assert.equal(oldExists(captured.options.env.CODEX_HOME),false);
  }finally{childProcess.spawn=oldSpawn;fs.existsSync=oldExists;if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;syncBuiltinESMExports();}
});


test('batch templates validate every document before persistence and create independent unapproved plans',async()=>{
 const count=(await get()).plans.length,calls=bridgeCalls.length,jobsBefore=generationCalls.length;
 const second={...target,docId:43,width:32,height:32,name:'Second.psd'},template={title:'Batch preview',steps:[capture,generate,paste]};
 await assert.rejects(()=>post('plans/batch',{plan:template,targets:[target,second]}),/确认/);
 await assert.rejects(()=>post('plans/batch',{approved:true,plan:template,targets:[target,{...second,width:16}]}),/Second.psd/);
 await assert.rejects(()=>post('plans/batch',{approved:true,plan:template,targets:[target,target]}),/重复/);
 await assert.rejects(()=>post('plans/batch',{approved:true,plan:{title:'Bad',steps:[{...capture,jobId:'other-doc-job'}]},targets:[target,second]}),/不允许/);
 assert.equal((await get()).plans.length,count);assert.equal(bridgeCalls.length,calls);
 const batch=await post('plans/batch',{approved:true,plan:template,targets:[target,second]});
 assert.equal(batch.plans.length,2);assert.equal(new Set(batch.plans.map(p=>p.id)).size,2);
 for(const p of batch.plans){assert.equal(p.batchId,batch.batchId);assert.equal(p.status,'preview');assert.equal(p.sessionId,null);assert.ok(p.steps.every(s=>s.status==='pending'&&!s.jobId&&!s.result));}
 assert.equal(new Set(batch.plans.flatMap(p=>p.steps.map(s=>s.id))).size,6);
 assert.equal(generationCalls.length,jobsBefore);assert.equal(bridgeCalls.length,calls);
 workbench.close();workbench=createAssistantWorkbench(context);
 const original=context.bridge.request;
 try{
  context.bridge.request=c=>c.type==='documents'?Promise.resolve({documents:[target,second]}):original(c);
  await assert.rejects(()=>post(`plans/${batch.plans[0].id}/execute`,{stepId:batch.plans[0].steps[0].id}),/批准/);
  const first=await execute(await get(`plans/${batch.plans[0].id}`));
  assert.equal((await get(`plans/${batch.plans[1].id}`)).status,'preview');
  const other=await execute(await get(`plans/${batch.plans[1].id}`));
  assert.deepEqual(first.steps[0].result.target,target);assert.deepEqual(other.steps[0].result.target,second);assert.notEqual(first.steps[0].result.id,other.steps[0].result.id);
  assert.equal(generationCalls.length,jobsBefore);assert.equal(other.steps[1].status,'pending');
 }finally{context.bridge.request=original;}
});

test.after(async()=>{workbench.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
