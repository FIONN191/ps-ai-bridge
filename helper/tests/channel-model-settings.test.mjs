import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-model-settings-'));
process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const channelsUrl=new URL('../providers/channels.mjs',import.meta.url);
const {channelRoutes,registerChannels}=await import(channelsUrl);
const providers={},capabilities={};registerChannels(providers,capabilities);
const read=()=>channelRoutes('GET',['api-channels']);
const post=body=>channelRoutes('POST',['api-channels','save'],body);
const file=path.join(dir,'api-channels.json');
async function save(fields={}){return post({revision:(await read()).revision,kind:'custom',title:'Studio',url:'https://images.example',protocol:'images',key:'private-fixture-key',model:'gpt-image-primary',models:['gpt-image-primary','gpt-image-spare'],enabled:true,...fields});}
async function update(id,fields={}){const state=await read();return post({...state.profiles.find(p=>p.id===id),revision:state.revision,...fields});}

test('old profiles gain defaults without rewriting credentials or settings on read',async()=>{
 const initial=await read();assert.ok(initial.profiles.every(p=>p.concurrency===1));
 const {profile}=await save();const old=JSON.parse(fs.readFileSync(file));
 for(const p of old.profiles){delete p.concurrency;delete p.modelLabels;delete p.hiddenModels;}
 fs.writeFileSync(file,JSON.stringify(old));const before=fs.readFileSync(file,'utf8');
 const p=(await read()).profiles.find(p=>p.id===profile.id);
 assert.equal(p.concurrency,1);assert.deepEqual(p.hiddenModels,[]);assert.deepEqual(p.modelLabels,{});
 assert.equal(p.hasKey,true);assert.equal(p.key,undefined);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('visible IDs, labels and concurrency persist per profile and survive a helper restart',async()=>{
 const a=(await save({concurrency:4,modelLabels:{'gpt-image-primary':'主力 <模型>','gpt-image-spare':'备选'},hiddenModels:['gpt-image-spare']})).profile;
 const b=(await save()).profile;
 assert.equal(providers[`api-${a.id}`].concurrency,4);assert.equal(providers[`api-${b.id}`].concurrency,1);
 const status=await providers[`api-${a.id}`].status();
 assert.deepEqual(status.models,['gpt-image-primary']);assert.equal(status.defaultModel,'gpt-image-primary');assert.equal(status.modelLabels['gpt-image-primary'],'主力 <模型>');
 assert.deepEqual(capabilities[`api-${b.id}`].models,['gpt-image-primary','gpt-image-spare']);
 assert.ok(!JSON.stringify(await read()).includes('private-fixture-key'));
 const restarted=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`const {registerChannels}=await import(${JSON.stringify(channelsUrl.href)});const p={},c={};registerChannels(p,c);console.log(JSON.stringify({concurrency:p[${JSON.stringify(`api-${a.id}`)}].concurrency,status:await p[${JSON.stringify(`api-${a.id}`)}].status()}));`],{env:{...process.env,PS_AI_BRIDGE_DATA_DIR:dir},encoding:'utf8'}));
 assert.equal(restarted.concurrency,4);assert.deepEqual(restarted.status.models,status.models);
 // An older client omitting the new fields must not erase the preferences.
 await save({id:a.id,key:'',title:'renamed'});
 const retained=(await read()).profiles.find(p=>p.id===a.id);
 assert.equal(retained.concurrency,4);assert.deepEqual(retained.hiddenModels,['gpt-image-spare']);assert.equal(retained.modelLabels['gpt-image-primary'],'主力 <模型>');
});

test('all four integer limits work; invalid limits cannot change disk or the live registry',async()=>{
 const {profile}=await save();
 for(const concurrency of [1,2,3,4]){await update(profile.id,{concurrency});assert.equal(providers[`api-${profile.id}`].concurrency,concurrency);}
 for(const concurrency of [0,5,-1,1.5,'2','',true,false,null,NaN,Infinity,{},[],undefined]){
  const before=fs.readFileSync(file,'utf8');
  await assert.rejects(update(profile.id,{concurrency}),/1–4/);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(providers[`api-${profile.id}`].concurrency,4);
 }
});

test('hiding a default is rejected; switching the default and hiding the old one is atomic',async()=>{
 const {profile}=await save();const before=fs.readFileSync(file,'utf8');
 await assert.rejects(update(profile.id,{hiddenModels:['gpt-image-primary']}),/默认模型不能隐藏/);
 assert.equal(fs.readFileSync(file,'utf8'),before);
 await update(profile.id,{model:'gpt-image-spare',hiddenModels:['gpt-image-primary']});
 assert.deepEqual(capabilities[`api-${profile.id}`].models,['gpt-image-spare']);assert.equal(capabilities[`api-${profile.id}`].defaultModel,'gpt-image-spare');
 await update(profile.id,{hiddenModels:[]});assert.equal(capabilities[`api-${profile.id}`].models.length,2);
});

test('malformed metadata and stale concurrent edits leave the saved configuration intact',async()=>{
 const {profile}=await save();
 for(const fields of [{modelLabels:null},{modelLabels:[]},{modelLabels:{unknown:'x'}},{modelLabels:{'gpt-image-primary':false}},{modelLabels:{'gpt-image-primary':'x'.repeat(101)}},{modelLabels:{'gpt-image-primary':'line\nbreak'}},{hiddenModels:'gpt-image-spare'},{hiddenModels:[null]},{hiddenModels:['unknown']}]){
  const before=fs.readFileSync(file,'utf8');await assert.rejects(update(profile.id,fields));assert.equal(fs.readFileSync(file,'utf8'),before);
 }
 const state=await read();await update(profile.id,{concurrency:3});const before=fs.readFileSync(file,'utf8');
 await assert.rejects(post({...profile,revision:state.revision,concurrency:2}),/另一窗口/);
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(providers[`api-${profile.id}`].concurrency,3);
});

test('labels and later hiding do not rewrite a queued request or leak credentials into jobs',async()=>{
 const {profile}=await save({modelLabels:{'gpt-image-primary':'Pretty name'}});
 const folder=path.join(dir,'queued-job');fs.mkdirSync(folder);
 const job={id:'queued-job',dir:folder,model:'',prompt:'Keep composition',aspect:'1:1'};
 providers[`api-${profile.id}`].prepare(job);
 await update(profile.id,{model:'gpt-image-spare',hiddenModels:['gpt-image-primary'],concurrency:2});
 const png=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({data:[{b64_json:png.toString('base64')}]});};
 try{await providers[`api-${profile.id}`].run(job,{signal:new AbortController().signal,log:()=>{}});}finally{globalThis.fetch=original;}
 assert.equal(calls.length,1);assert.equal(calls[0].body.model,'gpt-image-primary');assert.equal(job.model,'gpt-image-primary');
 assert.ok(!fs.readFileSync(path.join(folder,'job.json'),'utf8').includes('private-fixture-key'));
});

test('desktop editor saves labels, hides/unhides models, guards the default and reports invalid concurrency', {skip:!fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')},async()=>{
 const {chromium}=await import('playwright-core');
 const pluginPath=new URL('../../plugin/api-settings.js',import.meta.url),desktopPath=new URL('../../desktop/src/renderer/api-settings.js',import.meta.url);
 assert.equal(fs.readFileSync(pluginPath,'utf8'),fs.readFileSync(desktopPath,'utf8'));
 const {profile}=await save();
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('fixtureRequest',(method,route,body)=>channelRoutes(method,route.split('/').filter(Boolean),body));
  await page.setContent('<main id="settings"></main>');
  await page.addScriptTag({path:desktopPath.pathname});
  await page.evaluate(async()=>{window.editor=mountApiSettings({root:document.getElementById('settings'),request:window.fixtureRequest,openLink:()=>{},select:(el,items,value)=>{el.replaceChildren(...items.map(([id,label])=>new Option(label,id)));el.value=items.some(([id])=>id===value)?value:items[0]?.[0]||'';}});await editor.refresh();});
  const field=name=>page.locator(`[data-api="${name}"]`);
  await field('profile').selectOption(profile.id);
  await field('modelLabel').fill('Primary <safe>');await field('concurrency').fill('4');
  await field('manageModel').selectOption('gpt-image-spare');await field('modelLabel').fill('Spare');await field('modelHidden').check();
  assert.deepEqual(await field('models').locator('option').evaluateAll(es=>es.map(e=>e.value)),['','gpt-image-primary']);
  await field('save').click();await page.waitForFunction(()=>document.querySelector('[data-api="status"]').textContent.startsWith('已保存'));
  let stored=(await read()).profiles.find(p=>p.id===profile.id);
  assert.equal(stored.concurrency,4);assert.equal(stored.modelLabels['gpt-image-primary'],'Primary <safe>');assert.deepEqual(stored.hiddenModels,['gpt-image-spare']);
  assert.equal(await field('modelLabel').inputValue(),'Primary <safe>');assert.equal(await page.locator('safe').count(),0);
  await field('modelHidden').click();assert.equal(await field('modelHidden').isChecked(),false);assert.match(await field('status').textContent(),/默认模型不能隐藏/);
  await field('manageModel').selectOption('gpt-image-spare');await field('modelHidden').uncheck();await field('models').selectOption('gpt-image-spare');
  await field('manageModel').selectOption('gpt-image-primary');await field('modelHidden').check();
  const revision=(await read()).revision;await field('concurrency').fill('2.5');await field('save').click();
  await page.waitForFunction(()=>document.querySelector('[data-api="status"]').textContent.includes('1–4'));
  assert.equal((await read()).revision,revision);
  await field('concurrency').fill('2');await field('save').click();await page.waitForFunction(()=>document.querySelector('[data-api="status"]').textContent.startsWith('已保存'));
  stored=(await read()).profiles.find(p=>p.id===profile.id);assert.equal(stored.model,'gpt-image-spare');assert.deepEqual(stored.hiddenModels,['gpt-image-primary']);assert.equal(stored.concurrency,2);
  // Refreshing discovery must preserve hidden metadata even if the service omits a model.
  const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({data:[{id:'gpt-image-new'}]});
  try{await field('fetch').click();await page.waitForFunction(()=>document.querySelector('[data-api="status"]').textContent.includes('选好默认模型'));}finally{globalThis.fetch=original;}
  await field('save').click();await page.waitForFunction(()=>document.querySelector('[data-api="status"]').textContent.startsWith('已保存'));
  stored=(await read()).profiles.find(p=>p.id===profile.id);assert.ok(stored.models.includes('gpt-image-new'));assert.deepEqual(stored.hiddenModels,['gpt-image-primary']);assert.equal(stored.modelLabels['gpt-image-primary'],'Primary <safe>');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
