import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'psai-organizer-')));
process.env.PS_AI_BRIDGE_DATA_DIR=root;
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(root,'outputs');
const jobs=await import('../lib/jobs.mjs');
const {createOrganizer,safePath}=await import('../lib/organizer.mjs');
const {atomicJson}=await import('../lib/store.mjs');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const png=await sharp({create:{width:20,height:25,channels:4,background:{r:20,g:100,b:180,alpha:.5}}}).png().toBuffer();
const put=(rel,value)=>{const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});if(Buffer.isBuffer(value)||typeof value==='string')fs.writeFileSync(f,value);else atomicJson(f,value);return f;};
let calls=[];
const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/info')?{status:'success',data:{version:'4.0'}}:{status:'success'}};};
const org=createOrganizer({bridge:{status:()=>({psOnline:true,commands:true,doc:{name:'private.psd'}})},fetchImpl});
const get=(p,q={})=>org.route('GET',['organizer',...p.split('/')],{},q);
const post=(p,b={})=>org.route('POST',['organizer',...p.split('/')],b);
function fixture(id,extra={}){
 const dir=path.join(config.outputDir,'20200101',id);fs.mkdirSync(dir,{recursive:true});const output=path.join(dir,'output.png');fs.writeFileSync(output,png);
 const j={id,dir,groupId:'original-A',createdAt:Date.UTC(2020,0,1),status:'done',provider:'test',prompt:'retouch old photo',inputPath:output,result:{path:output,base:output,variants:{}},...extra};atomicJson(path.join(dir,'job.json'),j);return j;
}
let old;
test('history reads disk beyond 14 days, paginates and filters original/project with deterministic ordering',async()=>{
 old=fixture('old-001');fixture('old-002');fixture('old-003',{groupId:'original-B'});
 const p=await post('projects',{title:'Portraits',state:'todo',due:'2026-11-01',jobIds:['old-001']});
 assert.equal((await get('history',{limit:1})).hasMore,true);
 const a=await get('history',{limit:1,offset:0}),b=await get('history',{limit:1,offset:1});assert.notEqual(a.items[0].id,b.items[0].id);
 assert.equal((await get('history',{originalId:'original-A'})).total,2);
 const filtered=await get('history',{projectId:p.id});assert.equal(filtered.total,1);assert.equal(filtered.items[0].id,'old-001');assert.equal(filtered.items[0].cost,null);
 await post('history/link',{jobId:'old-001',projectId:'',originalId:'new-original'});
 assert.equal((await get('history',{projectId:p.id})).total,0);assert.equal((await get('history',{originalId:'new-original'})).total,1);
 await assert.rejects(()=>get('history',{offset:-1}),/分页/);await assert.rejects(()=>get('history',{limit:101}),/分页/);
 assert.equal((await org.route('GET','/organizer/history?limit=1')).items.length,1);
});
test('checkpoint restore creates a new local result every time and preserves exact source',async()=>{
 const file=put('outputs/_checkpoints/20261026/portrait-100000.png',png),before=fs.readFileSync(file);
 const list=await get('checkpoints');assert.equal(list.total,1);const id=list.items[0].id;
 assert.match((await post('checkpoints/preview',{id})).dataUrl,/^data:image\/png;base64,/);
 const a=await post('checkpoints/restore',{id}),b=await post('checkpoints/restore',{id});assert.notEqual(a.jobId,b.jobId);
 assert.deepEqual(fs.readFileSync(jobs.getJob(a.jobId).result.path),before);assert.deepEqual(fs.readFileSync(file),before);
 await assert.rejects(()=>post('checkpoints/restore',{id:'../../config.json'}),/路径|检查点/);
});
test('selected stored variant restoration and preview never overwrite old result',async()=>{
 const variant=await sharp(png).modulate({brightness:.5}).png().toBuffer();const f=put('outputs/20200101/old-001/v-test.png',variant);
 const j={...old,result:{...old.result,variants:{test:f}},applied:{path:f,variant:{cc:'none',tex:false,t:1}}};atomicJson(path.join(old.dir,'job.json'),j);
 const r=await post('history/restore',{jobId:old.id,variant:'test'});assert.deepEqual(fs.readFileSync(jobs.getJob(r.jobId).result.path),variant);assert.deepEqual(fs.readFileSync(old.result.path),png);
 const preview=await post('history/preview',{jobId:old.id,variant:'applied'});assert.deepEqual(Buffer.from(preview.dataUrl.split(',')[1],'base64'),variant);
 await assert.rejects(()=>post('history/preview',{jobId:old.id,variant:'missing'}),/版本/);
});
test('path validation rejects traversal, absolute paths, backslash, symlink components and external result paths',async()=>{
 for(const p of ['../config.json','/etc/passwd','x/../y','x\\y','C:/temp','x//y'])assert.throws(()=>safePath(root,p,{missing:true}),/路径/);
 const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'org-outside-')));fs.writeFileSync(path.join(outside,'secret.png'),png);
 try{fs.symlinkSync(outside,path.join(root,'link'));assert.throws(()=>safePath(root,'link/secret.png'),/符号链接/);
 fixture('bad-path',{result:{path:path.join(outside,'secret.png'),variants:{}}});await assert.rejects(()=>post('history/preview',{jobId:'bad-path',variant:'raw'}),/路径/);
 }finally{fs.rmSync(outside,{recursive:true,force:true});}
});
test('trusted macOS root aliases work, missing roots work, nested symlinks remain forbidden',async()=>{
 const alias=path.join(os.tmpdir(),`organizer-root-alias-${crypto.randomUUID()}`);
 fs.symlinkSync(root,alias);
 try {
  const fromAlias=createOrganizer({dataDir:alias,outputDir:path.join(alias,'outputs')});
  assert.ok((await fromAlias.route('GET',['history'])).total>0);
  assert.equal((await fromAlias.route('GET',['layout'])).mode,'full');
  await fromAlias.route('POST',['layout'],{mode:'full',theme:'dark',zoom:1,opacity:1});
  assert.equal(safePath(alias,'organizer/layout.json'),path.join(root,'organizer/layout.json'));
  fs.symlinkSync(path.join(root,'organizer'),path.join(root,'nested-link'));
  assert.throws(()=>safePath(alias,'nested-link/layout.json'),/符号链接/);
  const fresh=createOrganizer({dataDir:path.join(alias,'fresh','data'),outputDir:path.join(alias,'fresh','outputs')});
  assert.equal((await fresh.route('GET',['history'])).total,0);
  await fresh.route('POST',['layout'],{mode:'full',theme:'light',zoom:1,opacity:1});
  assert.equal((await fresh.route('GET',['layout'])).theme,'light');
 }finally{fs.unlinkSync(alias);}
});
test('user-state backup excludes config/browser/credentials recursively and has verifiable manifest',async()=>{
 put('prefs.json',{closeTabsAfterDone:true});put('shortcuts.json',{enabled:false,shortcut:'Cmd+Shift+G'});put('shared-settings.json',{schemaVersion:1,revision:1,values:{provider:'aistudio',sound:false},history:[]});put('config.json',{apiKey:'CONFIG_SECRET'});put('chrome-profile/Cookies','COOKIE_SECRET');put('accounts.json',{token:'ACCOUNT_SECRET'});
 put('presets/sample.json',{id:'demo',title:'preset',content:'safe prompt token=INLINE_SECRET and {"apiKey":"NESTED_SECRET"}',apiKey:'PRESET_SECRET',nested:{authorization:'Bearer AUTH_SECRET',url:'https://name:pass@example.com/ref?token=URL_SECRET'}});
 await post('layout',{mode:'compact',theme:'dark',zoom:1.1,opacity:.8});
 await post('bookmarks',{title:'Docs',url:'https://example.com/docs'});
 const pack=await post('backup/export'),text=JSON.stringify(pack.files.map(f=>Buffer.from(f.content,'base64').toString('utf8')));
 for(const s of ['CONFIG_SECRET','COOKIE_SECRET','ACCOUNT_SECRET','INLINE_SECRET','NESTED_SECRET','PRESET_SECRET','AUTH_SECRET','URL_SECRET','name:pass'])assert.ok(!text.includes(s),s);
 assert.ok(pack.files.some(f=>f.path==='prefs.json'));assert.ok(pack.files.some(f=>f.path==='shared-settings.json'));assert.ok(pack.files.some(f=>f.path==='shortcuts.json'));assert.ok(pack.files.some(f=>f.path==='presets/sample.json'));assert.ok(!pack.files.some(f=>/config|chrome|accounts/.test(f.path)));
 for(const f of pack.files)assert.equal(digest(Buffer.from(f.content,'base64')),f.sha256);
 assert.equal((await post('backup/preflight',{pack})).files.length,pack.files.length);
});
function withFile(pack,name,content){const p=structuredClone(pack),buffer=Buffer.from(content),f={path:name,bytes:buffer.length,sha256:digest(buffer),content:buffer.toString('base64')};p.files=[f];p.manifestHash=digest(JSON.stringify(p.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))));return p;}
test('corrupted or malicious packs are rejected before mutation, including forged valid hashes',async()=>{
 const pack=await post('backup/export'),before=fs.readFileSync(path.join(root,'organizer/layout.json'));
 const broken=structuredClone(pack);broken.files[0].content=Buffer.from('broken').toString('base64');await assert.rejects(()=>post('backup/preflight',{pack:broken}),/校验/);
 const manifest=structuredClone(pack);manifest.manifestHash='0'.repeat(64);await assert.rejects(()=>post('backup/preflight',{pack:manifest}),/清单/);
 for(const name of ['../escape.json','config.json','chrome-profile/state.json','organizer/rollbacks/evil.json','presets/../../config.json'])await assert.rejects(()=>post('backup/preflight',{pack:withFile(pack,name,'{}')}),/路径/);
 await assert.rejects(()=>post('backup/preflight',{pack:withFile(pack,'presets/secret.json','{"authorization":"Bearer abc"}')}),/路径|凭证/);
 await assert.rejects(()=>post('backup/preflight',{pack:withFile(pack,'presets/plain.json','{"apiKey":"test"}')}),/凭证/);
 await assert.rejects(()=>post('backup/preflight',{pack:withFile(pack,'organizer/layout.json','{"mode":"weird"}')}),/布局/);
 assert.deepEqual(fs.readFileSync(path.join(root,'organizer/layout.json')),before);
});
test('preflight token binds pack and current state; import has durable manual rollback',async()=>{
 const pack=await post('backup/export');await post('layout',{mode:'full',theme:'light',zoom:1,opacity:1});
 await assert.rejects(()=>post('backup/import',{pack}),/预检/);
 let p=await post('backup/preflight',{pack});await post('layout',{mode:'full',theme:'system',zoom:1,opacity:1});await assert.rejects(()=>post('backup/import',{pack,token:p.token}),/变化/);
 p=await post('backup/preflight',{pack});const result=await post('backup/import',{pack,token:p.token});assert.equal((await get('layout')).mode,'compact');
 await assert.rejects(()=>post('backup/import',{pack,token:p.token}),/预检/);
 const reloaded=createOrganizer();await reloaded.route('POST',['backup','rollback'],{id:result.id});assert.equal((await get('layout')).theme,'system');
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config.json'))).apiKey,'CONFIG_SECRET');
});
test('failed import automatically restores earlier writes and leaves unrelated files untouched',async()=>{
 const pack=await post('backup/export');await post('layout',{mode:'full',theme:'light',zoom:1.2,opacity:1});const before=fs.readFileSync(path.join(root,'organizer/layout.json'));
 let writes=0;const failing=createOrganizer({writeJson:(file,value)=>{if(++writes===3)throw new Error('simulated disk failure');atomicJson(file,value);}});
 const p=await failing.route('POST',['backup','preflight'],{pack});await assert.rejects(()=>failing.route('POST',['backup','import'],{pack,token:p.token}),/已回滚/);
 assert.deepEqual(fs.readFileSync(path.join(root,'organizer/layout.json')),before);
 assert.ok((await get('backup/rollbacks')).items.some(x=>x.status==='failed-rolled-back'));
});
test('manual rollback refuses to overwrite a subsequent edit',async()=>{
 const pack=await post('backup/export'),p=await post('backup/preflight',{pack}),r=await post('backup/import',{pack,token:p.token});
 await post('layout',{mode:'compact',theme:'system',zoom:1.3,opacity:.9});await assert.rejects(()=>post('backup/rollback',{id:r.id}),/已修改/);
 assert.equal((await get('layout')).zoom,1.3);
});
test('cache trash is preview-only, protects active jobs/runs, rechecks at commit and restores bytes',async()=>{
 put('workbench/preview-assets/free/output.png',png);put('workbench/preview-assets/busy/input.png',png);put('workbench/preview-assets/pinned/output.png',png);
 fixture('active-job',{status:'running',inputPath:path.join(root,'workbench/preview-assets/busy/input.png')});
 put('workbench/runs/r1/run.json',{status:'paused',previewId:'pinned'});
 const r=await get('cache');assert.equal(r.previews.find(p=>p.id==='busy/input.png').protected,true);assert.equal(r.previews.find(p=>p.id==='pinned/output.png').protected,true);
 await assert.rejects(()=>post('cache/trash',{ids:['busy/input.png']}),/活动/);
 await assert.rejects(()=>post('cache/trash',{ids:['../../outputs/20200101/old-001/output.png']}),/路径/);
 const t=await post('cache/trash',{ids:['free/output.png']});assert.ok(!fs.existsSync(path.join(root,'workbench/preview-assets/free/output.png')));assert.ok(fs.existsSync(old.result.path));
 await post('cache/restore',{id:t.id});assert.deepEqual(fs.readFileSync(path.join(root,'workbench/preview-assets/free/output.png')),png);
 const t2=await post('cache/trash',{ids:['free/output.png']});put('workbench/preview-assets/free/output.png','new bytes');await assert.rejects(()=>post('cache/restore',{id:t2.id}),/未覆盖/);
});
test('project dates, delay and calendar reuse existing files and persist layout/bookmarks',async()=>{
 const p=await post('projects',{title:'Calendar',state:'rework',due:'2026-12-30',reminder:true,documents:[{id:'7',name:'portrait.psd'}]});
 const delayed=await post('projects/delay',{id:p.id,days:7});assert.equal(delayed.due,'2027-01-06');assert.equal(delayed.documents[0].id,'7');
 assert.ok((await get('calendar',{today:'2027-01-07'})).items.find(x=>x.id===p.id).overdue);
 await assert.rejects(()=>post('projects',{title:'bad',due:'2026-02-30'}),/日期/);await assert.rejects(()=>post('projects/delay',{id:p.id,days:-1}),/天数/);
 await assert.rejects(()=>post('bookmarks',{url:'javascript:alert(1)'}),/HTTPS/);await assert.rejects(()=>post('bookmarks',{url:'https://user:pass@example.com'}),/HTTPS/);
 const second=createOrganizer();assert.equal((await second.route('GET',['layout'])).zoom,1.3);assert.ok((await second.route('GET',['bookmarks'])).items.length);
});
test('Eagle detection is read-only; explicit selected variant archive preserves files and avoids credential payloads',async()=>{
 calls=[];assert.equal((await get('eagle/detect')).available,true);assert.equal(calls[0].options.method,'GET');assert.equal(calls.length,1);
 await assert.rejects(()=>post('eagle/archive',{jobId:old.id,tags:[]}),/确认/);assert.equal(calls.length,1);
 const before=fs.readFileSync(old.result.path);const r=await post('eagle/archive',{jobId:old.id,variant:'test',tags:['portrait','portrait'],confirm:true});assert.equal(r.originalPreserved,true);
 const c=calls[1];assert.equal(c.url,'http://127.0.0.1:41595/api/item/addFromPath');const b=JSON.parse(c.options.body);assert.equal(b.path,path.join(old.dir,'v-test.png'));assert.deepEqual(b.tags,['portrait']);assert.ok(!('annotation'in b));assert.deepEqual(fs.readFileSync(old.result.path),before);
 const offline=createOrganizer({fetchImpl:async()=>{throw new Error('timeout token=SECRET');}});assert.equal((await offline.route('GET',['eagle','detect'])).available,false);
 await assert.rejects(()=>offline.route('POST',['eagle','archive'],{jobId:old.id,tags:[],confirm:true}),/核对/);
});
test('project associations preserve explicit Photoshop docId/session instead of heartbeat text',async()=>{
 const p=await post('projects',{title:'Document selection',documents:[{docId:42,session:'ps-live-42-2',name:'User selected.psd'}]});
 assert.deepEqual(p.documents,[{id:'42',docId:42,session:'ps-live-42-2',name:'User selected.psd'}]);
 const pack=await post('backup/export');const record=pack.files.find(f=>f.path===`workbench/projects/${p.id}.json`);
 assert.equal(JSON.parse(Buffer.from(record.content,'base64')).documents[0].session,'ps-live-42-2');
 await assert.rejects(()=>post('projects',{title:'bad',documents:[{docId:42,session:'auth-token',name:'bad'}]}),/会话/);
});
test('library metadata, board, hashed PNGs and preset field history round trip with identical image hashes',async()=>{
 const imageId=digest(png),imageName=`library/images/${imageId}.png`,historyName=`presets/.field-history/${digest('demo')}.json`;
 put(imageName,png);
 const library={schemaVersion:1,revision:4,references:[{id:'ref-1',name:'Portrait',imageId,width:20,height:25,bytes:png.length,source:{kind:'photoshop',docId:42,session:'ps-live-42-2',documentName:'User selected.psd'},createdAt:123}],board:{imageId,hotspots:[{id:'head-1',category:'head',x:.1,y:.1,width:.3,height:.3,z:1,visible:true}]}};
 put('library/library.json',library);const history={schemaVersion:1,revision:1,entries:[{id:'entry-1',usedAt:123,presetRevision:1,params:{strength:.5},fills:{scene:'portrait'}}]};put(historyName,history);
 const pack=await post('backup/export');assert.ok(pack.files.some(f=>f.path===historyName));assert.equal(pack.files.find(f=>f.path===imageName).sha256,imageId);
 const target=fs.mkdtempSync(path.join(os.tmpdir(),'organizer-library-restore-'));
 try{
  const destination=createOrganizer({dataDir:target,outputDir:path.join(target,'outputs')});
  const plan=await destination.route('POST',['backup','preflight'],{pack});await destination.route('POST',['backup','import'],{pack,token:plan.token});
  assert.equal(digest(fs.readFileSync(path.join(target,imageName))),imageId);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,'library/library.json'))),library);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,historyName))),history);
  const again=await destination.route('POST',['backup','export']);assert.equal(again.files.find(f=>f.path===imageName).sha256,imageId);
 }finally{fs.rmSync(target,{recursive:true,force:true});}
});
test('library preflight rejects missing assets, renamed hashes, corrupt PNGs, malformed fields and whole oversize packs',async()=>{
 const pack=await post('backup/export');
 const reseal=p=>{p.manifestHash=digest(JSON.stringify(p.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))));return p;};
 let bad=structuredClone(pack);bad.files=bad.files.filter(f=>!f.path.startsWith('library/images/'));await assert.rejects(()=>post('backup/preflight',{pack:reseal(bad)}),/缺图/);
 bad=structuredClone(pack);bad.files.find(f=>f.path.startsWith('library/images/')).path=`library/images/${'a'.repeat(64)}.png`;await assert.rejects(()=>post('backup/preflight',{pack:reseal(bad)}),/哈希/);
 const corrupt=Buffer.from('not a PNG'),corruptId=digest(corrupt);
 bad=withFile(pack,`library/images/${corruptId}.png`,corrupt.toString());await assert.rejects(()=>post('backup/preflight',{pack:bad}));
 bad=withFile(pack,`presets/.field-history/${digest('demo')}.json`,JSON.stringify({schemaVersion:1,revision:1,entries:[{id:'x',usedAt:1,presetRevision:1,params:{bad:'not numeric'},fills:{}}]}));await assert.rejects(()=>post('backup/preflight',{pack:bad}),/字段历史/);
 const original=fs.readFileSync(path.join(root,'library/library.json'));
 bad={...pack,padding:'x'.repeat(40*1024*1024)};await assert.rejects(()=>post('backup/preflight',{pack:bad}),/40 MB/);assert.deepEqual(fs.readFileSync(path.join(root,'library/library.json')),original);
 const oversized=put('presets/oversized.txt','x'.repeat(31*1024*1024));try{await assert.rejects(()=>post('backup/export'),/40 MB/);}finally{fs.unlinkSync(oversized);}
});
test('diagnostics use strict metadata allowlist and help is searchable',async()=>{
 fixture('failed-job',{status:'error',error:'Bearer TOP_SECRET /Users/someone/private',prompt:'SECRET_PROMPT',stage:'secret stage'});
 const r=await get('diagnostics'),text=JSON.stringify(r);for(const s of ['TOP_SECRET','SECRET_PROMPT','private.psd','/Users/','secret stage','CONFIG_SECRET'])assert.ok(!text.includes(s));assert.equal(r.ps.psOnline,true);assert.ok(r.versions.helper);assert.ok(r.failures.length);
 assert.equal((await get('help',{q:'Eagle'})).items[0].id,'eagle');assert.equal(await get('unknown'),undefined);
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
