import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-channels-'));
process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {channelRoutes,registerChannels,normalizeBase,channelAssist}=await import('../providers/channels.mjs');
const providers={},capabilities={};registerChannels(providers,capabilities);
const read=()=>channelRoutes('GET',['api-channels']);
const post=(p,b)=>channelRoutes('POST',['api-channels',p],b);
async function save(fields){return post('save',{revision:(await read()).revision,kind:'momo',title:'Momo',url:'https://api2.momoapi.icu/v1/',protocol:'gemini',key:'test-secret',model:'gemini-test-image',enabled:true,...fields});}
const original=globalThis.fetch;
const png=await sharp({create:{width:16,height:24,channels:4,background:{r:20,g:30,b:40,alpha:0.5}}}).png().toBuffer();
const input=path.join(dir,'input.png');fs.writeFileSync(input,png);
let calls=[],mode='normal';
globalThis.fetch=async(url,o={})=>{
 const u=new URL(url),route=u.pathname;calls.push({url:String(url),options:o});
 if(route==='/result.png'){assert.equal(o.headers,undefined);return new Response(png);}
 assert.equal(o.redirect,'error');assert.equal(o.headers.authorization,'Bearer test-secret');
 if(mode==='badkey')return Response.json({error:{message:'bad test-secret and sk-test-here'}});
 if(route==='/v1/models')return Response.json({data:[{id:'gemini-test-image'},{id:'gpt-image-2'},{id:'chat-only'}]});
 if(route==='/api/usage/token')return Response.json({code:true,data:{total_available:0,total_used:30,unlimited_quota:false}});
 if(route==='/client/openapi/getAPIKeyCredits'){assert.equal(JSON.parse(o.body).apiKey,'test-secret');return Response.json({code:0,data:{credits:0}});}
 if(route.endsWith(':generateContent')){assert.equal(JSON.parse(o.body).contents[0].parts[1].inlineData.mimeType,'image/png');return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});}
 if(route==='/v1/images/edits'){assert.equal(o.body.get('model'),'gpt-image-2');assert.equal(o.body.getAll('image[]').length,2);assert.equal(o.headers['content-type'],undefined);return Response.json({data:[{url:'https://result.example/result.png'}]});}
 if(route==='/v1/images/generations')return Response.json({data:[{b64_json:png.toString('base64')}]});
 if(route==='/v1/draw/nano-banana'||route==='/v1/draw/completions'){assert.equal(JSON.parse(o.body).webHook,'-1');assert.match(JSON.parse(o.body).urls[0],/^data:image\/png;base64,/);return Response.json({code:0,data:{id:'remote-123'}});}
 if(route==='/v1/draw/result'){assert.equal(JSON.parse(o.body).id,'remote-123');return Response.json({code:0,data:{status:'succeeded',results:[{url:'https://result.example/result.png'}]}});}
 if(route==='/v1/chat/completions'){assert.equal(JSON.parse(o.body).model,'chat-only');return Response.json({choices:[{message:{content:'保持背景，只调整衣服'}}]});}
 throw new Error('Unexpected '+route);
};
function job(name,model=''){const folder=path.join(dir,name);fs.mkdirSync(folder,{recursive:true});return {id:name,dir:folder,provider:'api-momo',model,inputPath:input,refPaths:[input],prompt:'edit',aspect:'2:3',resolution:'2K'};}
const ctx=()=>({signal:new AbortController().signal,log:()=>{}});
test('profiles normalize addresses, redact keys, preserve blank keys and reject stale edits',async()=>{
 const r=await save({id:'momo'});assert.equal(r.profile.url,'https://api2.momoapi.icu');assert.equal(r.profile.key,undefined);assert.equal(r.profile.hasKey,true);
 const state=await read();assert.ok(!JSON.stringify(state).includes('test-secret'));assert.equal(fs.statSync(path.join(dir,'api-channels.json')).mode&0o777,0o600);
 await save({id:'momo',key:'',title:'new name'});assert.equal((await read()).profiles.find(p=>p.id==='momo').hasKey,true);
 await assert.rejects(()=>post('save',{...r.profile,revision:0}),/另一窗口/);
 assert.equal(normalizeBase('https://x.example/proxy/v1beta/'),'https://x.example/proxy');
 for(const bad of ['http://remote.example','https://x.example?key=secret','https://user:pw@x.example'])assert.throws(()=>normalizeBase(bad));
 await assert.rejects(()=>save({id:'momo',kind:'custom',url:'https://other.example',key:''}),/重新输入/);
});
test('model and quota reads never submit generation and redact provider errors',async()=>{
 calls=[];const m=await post('models',{id:'momo'});assert.deepEqual(m.models,['gemini-test-image','gpt-image-2']);assert.equal(m.allModels.length,3);
 assert.equal((await post('balance',{id:'momo'})).available,0);assert.equal((await post('test',{id:'momo'})).ok,true);assert.ok(calls.every(x=>!x.url.includes('draw')&&!x.url.includes('generateContent')));
 mode='badkey';await assert.rejects(()=>post('test',{id:'momo'}),e=>!e.message.includes('test-secret')&&!e.message.includes('sk-test-here'));mode='normal';
});
test('queued connections are pinned; Gemini preserves alpha and secrets never enter jobs',async()=>{
 const p=providers['api-momo'],j=job('gemini');p.prepare(j);await save({id:'momo',url:'https://api1.momoapi.icu',model:'different-image'});calls=[];
 const out=await providers['api-momo'].run(j,ctx());assert.match(calls[0].url,/api2.momoapi.icu\/v1beta/);assert.equal(j.model,'gemini-test-image');assert.equal(out.height,24);assert.equal((await sharp(out.path).metadata()).hasAlpha,true);assert.ok(!fs.readFileSync(path.join(j.dir,'job.json'),'utf8').includes('test-secret'));
});
test('OpenAI compatible edits send all images; downloads have no credentials',async()=>{
 const {profile}=await save({kind:'custom',protocol:'images',url:'https://images.example/v1',model:'gpt-image-2'});const p=providers[`api-${profile.id}`],j=job('images','gpt-image-2');p.prepare(j);await p.run(j,ctx());
});
test('GRS banana and GPT retain task IDs and poll once without resubmitting',async()=>{
 for(const protocol of ['grs-banana','grs-gpt']){const {profile}=await save({kind:'grs',url:'https://grsaiapi.com',protocol,model:protocol==='grs-gpt'?'gpt-image-2':'nano-banana-2'});const p=providers[`api-${profile.id}`],j=job(protocol,profile.model);p.prepare(j);calls=[];await p.run(j,ctx());assert.equal(j.upstream.taskId,'remote-123');assert.equal(calls.filter(c=>c.url.includes('/draw/')&&!c.url.endsWith('/result')).length,1);assert.equal((await post('balance',{id:profile.id})).available,0);}
});
test('assistant routes only when explicitly selected, clear key disables availability',async()=>{
 assert.equal(await channelAssist({text:'edit'}),null);await save({id:'momo',textModel:'chat-only',useForAssist:true});assert.equal(await channelAssist({text:'edit',imagePath:input}),'保持背景，只调整衣服');
 await save({id:'momo',key:'',clearKey:true});assert.equal((await providers['api-momo'].status()).available,false);assert.equal(await channelAssist({text:'edit'}),null);
});
test.after(()=>{globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});});
