import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-comfy-'));process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {comfyRoutes,comfyui,validateWorkflow}=await import('../providers/comfyui.mjs');
const buf=await sharp({create:{width:8,height:12,channels:3,background:'red'}}).png().toBuffer();
let submitted=null;
const server=http.createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);
 res.setHeader('content-type','application/json');
 if(req.url==='/upload/image')return res.end(JSON.stringify({name:'source.png',subfolder:'',type:'input'}));
 if(req.url==='/prompt'){submitted=JSON.parse(Buffer.concat(chunks));return res.end(JSON.stringify({prompt_id:'remote-one'}));}
 if(req.url==='/history/remote-one')return res.end(JSON.stringify({'remote-one':{outputs:{'3':{images:[{filename:'result.png',subfolder:'',type:'output'}]}},status:{completed:true}}}));
 if(req.url.startsWith('/view?'))return res.end(buf);
 if(req.url==='/system_stats')return res.end(JSON.stringify({devices:[{name:'test'}]}));
 res.statusCode=404;res.end('{}');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const post=(p,b)=>comfyRoutes('POST',['comfyui',p],b);
const prompt={'1':{class_type:'Text',inputs:{text:'old'}},'2':{class_type:'LoadImage',inputs:{image:'old.png'}},'3':{class_type:'SaveImage',inputs:{images:['2',0]}}};
test('ComfyUI uploads and maps the image and prompt, persists task ID, downloads actual output',async()=>{
 await post('connection',{url:`http://127.0.0.1:${server.address().port}`,key:'test-secret',enabled:true});
 const config=await comfyRoutes('GET',['comfyui'],{});assert.equal(config.connection.key,undefined);assert.equal(config.connection.hasKey,true);
 const w=await post('save',{title:'test',prompt,mapping:[{node:'1',field:'text',source:'prompt'},{node:'2',field:'image',source:'image'}],outputNode:'3'});
 const input=path.join(dir,'input.png');fs.writeFileSync(input,buf);
 const job={id:'test',dir,model:w.id,prompt:'new prompt',inputPath:input,refPaths:[],aspect:'2:3',resolution:'1K',abort:new AbortController()};
 const out=await comfyui.run(job,{log:()=>{},signal:job.abort.signal});
 assert.equal(submitted.prompt['1'].inputs.text,'new prompt');assert.equal(submitted.prompt['2'].inputs.image,'source.png');
 assert.equal(out.width,8);assert.equal(out.height,12);assert.equal(job.upstream.taskId,'remote-one');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'job.json'))).upstream.state,'downloaded');
});
test('workflow canvas JSON and invalid mapping fail before execution',async()=>{
 assert.throws(()=>validateWorkflow({nodes:[]}),/API/);
 await assert.rejects(()=>post('save',{title:'bad',prompt,mapping:[{node:'999',field:'x',source:'image'}]}),/映射/);
});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
