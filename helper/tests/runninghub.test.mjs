import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-rh-'));
process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {runninghubRoutes,runninghub}=await import('../providers/runninghub.mjs');
const post=(p,b={})=>runninghubRoutes('POST',['runninghub',p],b);
const image=await sharp({create:{width:16,height:24,channels:3,background:'blue'}}).png().toBuffer();
const input=path.join(dir,'input.png');fs.writeFileSync(input,image);
const originalFetch=globalThis.fetch;
let submitted,controller,cancelled,mode='success';
globalThis.fetch=async(url,options={})=>{
 const route=new URL(url).pathname;
 const body=typeof options.body==='string'?JSON.parse(options.body):null;
 const json=data=>Response.json(data);
 if(route==='/image.png'){assert.equal(options.headers,undefined);return new Response(image);}
 assert.equal(options.headers.authorization,'Bearer fake-secret');
 if(route.endsWith('/upload')){assert.equal(options.body.get('fileType'),'input');return json({code:0,data:{fileName:'uploads/source.png'}});}
 if(route.endsWith('/create')){submitted=body;return json({code:0,data:{taskId:'123456'}});}
 if(route.endsWith('/outputs')){
  if(mode==='cancel'){controller.abort();throw new Error('aborted');}
  return json({code:0,data:[{fileType:'png',nodeId:'9',fileUrl:'https://output.example/image.png'},...(mode==='multiple'?[{fileType:'png',nodeId:'9',fileUrl:'https://output.example/image.png'}]:[])]});
 }
 if(route.endsWith('/cancel')){cancelled=body.taskId;return json({code:0});}
 if(route.endsWith('/accountStatus'))return json({code:401,msg:'invalid fake-secret'});
 throw new Error(`Unexpected route ${route}`);
};
let workflow;
test('RunningHub maps uploads, parameters, persists remote ID, and keeps keys off result downloads',async()=>{
 await post('connection',{url:'https://www.runninghub.ai',key:'fake-secret',enabled:true});
 const c=await runninghubRoutes('GET',['runninghub']);assert.equal(c.key,undefined);assert.equal(c.hasKey,true);
 workflow=await post('workflow',{title:'test',workflowId:'987',outputNode:'9',mapping:[{nodeId:'1',fieldName:'image',source:'image'},{nodeId:'2',fieldName:'text',source:'prompt'},{nodeId:'3',fieldName:'width',source:'width'}]});
 const job=makeJob('success');const result=await runninghub.run(job,{signal:controller.signal,log:()=>{}});
 assert.equal(submitted.nodeInfoList[0].fieldValue,'uploads/source.png');assert.equal(submitted.nodeInfoList[1].fieldValue,'edit');assert.equal(submitted.nodeInfoList[2].fieldValue,680);
 assert.equal(job.upstream.taskId,'123456');assert.equal(result.width,16);assert.equal(result.height,24);
 assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir,'job.json'))).upstream.state,'downloaded');
});
function makeJob(name){controller=new AbortController();const target=path.join(dir,name);fs.mkdirSync(target,{recursive:true});return {id:name,dir:target,model:workflow.id,inputPath:input,refPaths:[],prompt:'edit',aspect:'2:3',resolution:'1K'};}
test('RunningHub cancellation targets its own task and records confirmation',async()=>{
 mode='cancel';cancelled=null;const job=makeJob('cancel');await assert.rejects(()=>runninghub.run(job,{signal:controller.signal,log:()=>{}}),/aborted/);
 assert.equal(cancelled,'123456');assert.equal(job.upstream.cancelConfirmed,true);
});
test('ambiguous output is retained for review and diagnostic errors redact keys',async()=>{
 mode='multiple';const job=makeJob('multiple');await assert.rejects(()=>runninghub.run(job,{signal:controller.signal,log:()=>{}}),/2 张图/);assert.equal(job.upstream.outputs.length,2);
 await assert.rejects(()=>post('test'),e=>!e.message.includes('fake-secret')&&e.message.includes('已隐藏'));
 await assert.rejects(()=>post('connection',{url:'https://other.example',key:'secret'}),/官方/);
});
test.after(()=>{globalThis.fetch=originalFetch;fs.rmSync(dir,{recursive:true,force:true});});
