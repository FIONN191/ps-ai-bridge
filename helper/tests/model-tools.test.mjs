import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import sharp from 'sharp';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-model-tools-'));
process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {forge,forgeRoutes,forgeInventory,forgePreflight,modelTools,modelToolsRoutes,mapModelToolInputs}=await import('../providers/forge.mjs');
const {comfyRoutes,workflows}=await import('../providers/comfyui.mjs');
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(dir,'output');
const {saveUpload,getJob}=await import('../lib/jobs.mjs');
const source=await sharp({create:{width:8,height:12,channels:4,background:{r:200,g:60,b:80,alpha:0.5}}}).png().toBuffer();
const gray=await sharp({create:{width:8,height:12,channels:3,background:'#808080'}}).png().toBuffer();
const colored=await sharp({create:{width:8,height:12,channels:3,background:'red'}}).png().toBuffer();
let outputBuffer=gray,submitted=null,forgePayload=null,missingNode=false,missingModel=false,controlAvailable=true,pending=false;
const calls=[];
const server=http.createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);calls.push({url:req.url,method:req.method,auth:req.headers.authorization});
 res.setHeader('content-type','application/json');const send=x=>res.end(JSON.stringify(x));
 const endpoints={
  '/sdapi/v1/sd-models':[{title:'photo [123]',model_name:'photo',sha256:'a'.repeat(64)}],
  '/sdapi/v1/loras':[{name:'detail',alias:'detail'}],'/sdapi/v1/upscalers':[{name:'4x-test'}],'/sdapi/v1/samplers':[{name:'Euler'}],
  '/sdapi/v1/scripts':{img2img:controlAvailable?['ControlNet']:[],txt2img:[]},
 };
 if(req.url in endpoints)return send(endpoints[req.url]);
 if(req.url.startsWith('/controlnet/')){if(!controlAvailable){res.statusCode=404;return send({});}return send(req.url.endsWith('model_list')?{model_list:['control-test']}:{module_list:['none']});}
 if(['/sdapi/v1/img2img','/sdapi/v1/txt2img'].includes(req.url)){forgePayload=JSON.parse(Buffer.concat(chunks));return send({images:[colored.toString('base64')]});}
 if(req.url==='/system_stats')return send({devices:[{name:'mock CPU'}]});
 if(req.url==='/object_info')return send({LoadImage:{input:{required:{image:['STRING']}}},SaveImage:{input:{required:{images:['IMAGE']}}},
  ...(missingNode?{}:{Segment:{input:{required:{text:['STRING'],points_json:['STRING'],box_json:['STRING'],include:['STRING'],exclude:['STRING'],model:[[missingModel?'other.onnx':'segment.onnx']]}}}}),
  Upscale:{input:{required:{upscaler:[['real-upscale.pth']],scale:['FLOAT']}}}});
 if(req.url==='/upload/image')return send({name:'actual-upload.png',type:'input'});
 if(req.url==='/prompt'){submitted=JSON.parse(Buffer.concat(chunks));return send({prompt_id:'remote-test'});}
 if(req.url==='/history/remote-test')return send(pending?{}:{'remote-test':{outputs:{'9':{images:[{filename:'actual-result.png',type:'output'}]}},status:{completed:true}}});
 if(req.url.startsWith('/view?'))return res.end(outputBuffer);
 if(req.url==='/queue')return send({});
 res.statusCode=404;send({});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
const fp=(action,body={})=>forgeRoutes('POST',['forge',action],body);
const mp=(action,body={})=>modelToolsRoutes('POST',['model-tools',action],body);
const ctx=()=>({log:()=>{},signal:new AbortController().signal});
function job(model,extra={}){const id=crypto.randomUUID(),folder=path.join(dir,id);fs.mkdirSync(folder);const input=path.join(folder,'input.png');fs.writeFileSync(input,source);return {id,dir:folder,model,prompt:'keep identity',meta:{},inputPath:input,refPaths:[],aspect:'2:3',resolution:'1K',...extra};}
const prompt={
 '1':{class_type:'LoadImage',inputs:{image:'old.png'}},
 '6':{class_type:'Segment',inputs:{image:['1',0],text:'old',points_json:'[]',box_json:'[]',include:'',exclude:'',model:'segment.onnx'}},
 '7':{class_type:'Upscale',inputs:{image:['1',0],upscaler:'real-upscale.pth',scale:2}},
 '9':{class_type:'SaveImage',inputs:{images:['6',0]}},
};
let workflow,binding,preset;
const inputs={text:'hair',points:[{x:2,y:3,label:1}],box:[0,0,7,11],includeParts:['hair','face'],excludeParts:['hands']};

test('Forge / model workflows / engine management',async t=>{
 await fp('connection',{url,username:'user',password:'secret',enabled:true});
 await comfyRoutes('POST',['comfyui','connection'],{url,enabled:true});
 await t.test('connection secrets stay private and inventory uses actual API paths',async()=>{
  const state=await forgeRoutes('GET',['forge']);assert.equal(state.connection.password,undefined);assert.equal(state.connection.hasPassword,true);
  const inv=await forgeInventory();assert.equal(inv.models[0].model_name,'photo');assert.equal(inv.controlNetAvailable,true);assert.equal(calls.at(-1).auth,`Basic ${Buffer.from('user:secret').toString('base64')}`);
 });
 await t.test('preflight reports missing model, LoRA, ControlNet and unknown settings without conversion',async()=>{
  const inv=await forgeInventory();const r=forgePreflight({model:'missing',loras:[{name:'absent',weight:1}],controlnet:[{model:'missing',module:'none',source:'image'}],enable_hr:true},inv);
  assert.equal(r.ok,false);assert.equal(r.equivalentConversion,false);assert.match(r.errors.join(' '),/模型缺失/);assert.match(r.errors.join(' '),/LoRA/);assert.match(r.errors.join(' '),/ControlNet/);assert.match(r.errors.join(' '),/enable_hr/);
  await assert.rejects(()=>fp('import',{title:'bad',preset:{model:'missing'}}),/模型缺失/);
 });
 await t.test('optional ControlNet absent blocks only ControlNet presets',async()=>{
  controlAvailable=false;try{const inv=await forgeInventory();assert.equal(forgePreflight({model:'photo'},inv).ok,true);assert.equal(forgePreflight({model:'photo',controlnet:[{model:'control-test',source:'image'}]},inv).ok,false);}finally{controlAvailable=true;}
 });
 await t.test('img2img submits actual input, exact checkpoint, LoRA and explicit ControlNet reference',async()=>{
  preset=await fp('import',{title:'Portrait',preset:{model:'photo',steps:12,sampler_name:'Euler',loras:[{name:'detail',weight:0.8}],controlnet:[{model:'control-test',module:'none',source:'reference',index:0}]}});
  const j=job(preset.id);j.refPaths=[j.inputPath];forge.prepare(j);const out=await forge.run(j,ctx());
  assert.equal(forgePayload.init_images[0],source.toString('base64'));assert.equal(forgePayload.override_settings.sd_model_checkpoint,'photo [123]');assert.equal(forgePayload.alwayson_scripts.ControlNet.args[0].image,source.toString('base64'));assert.match(forgePayload.prompt,/<lora:detail:0.8>/);assert.equal(forgePayload.batch_size,1);assert.equal(out.width,8);assert.equal(j.upstream.state,'downloaded');
 });
 await t.test('txt2img uses the documented endpoint and refuses unmapped references / unavailable models',async()=>{
  const p=await fp('import',{title:'Text',preset:{model:'photo'}}),j=job(p.id,{inputPath:null});forge.prepare(j);await forge.run(j,ctx());assert.equal(j.upstream.endpoint,'/sdapi/v1/txt2img');assert.equal(forgePayload.init_images,undefined);
  const bad=job(p.id);bad.refPaths=[bad.inputPath];await assert.rejects(()=>forge.run(bad,ctx()),/参考图没有/);
  bad.refPaths=[];bad.meta.forgePreset={...p,parameters:{model:'missing'}};await assert.rejects(()=>forge.run(bad,ctx()),/模型缺失/);
 });
 await t.test('persistent Qwen role binding maps all semantic inputs into explicit literal fields',async()=>{
  workflow=await comfyRoutes('POST',['comfyui','save'],{title:'User Qwen segmentation',prompt,mapping:[{node:'1',field:'image',source:'image'},{node:'6',field:'text',source:'prompt'}],outputNode:'9'});
  binding=await mp('save',{title:'Qwen mask',family:'qwen',role:'segmentation',workflowId:workflow.id,outputNode:'9',output:'gray',mappings:[
   {source:'text',node:'6',field:'text',encoding:'value'},{source:'points',node:'6',field:'points_json',encoding:'json'},
   {source:'box',node:'6',field:'box_json',encoding:'json'},{source:'includeParts',node:'6',field:'include',encoding:'csv'},{source:'excludeParts',node:'6',field:'exclude',encoding:'csv'}]});
  const mapped=mapModelToolInputs(binding,workflow,inputs);assert.equal(mapped.prompt['6'].inputs.text,'hair');assert.equal(mapped.prompt['6'].inputs.points_json,JSON.stringify(inputs.points));assert.equal(mapped.prompt['6'].inputs.include,'hair,face');assert.deepEqual(workflows().find(w=>w.id===workflow.id).prompt,prompt);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'model-tools','bindings.json')))[0].family,'qwen');
 });
 await t.test('invalid graph mapping and silent ignored semantic inputs are rejected',async()=>{
  await assert.rejects(()=>mp('save',{...binding,mappings:[{source:'text',node:'6',field:'image'}]}),/字面量/);
  assert.throws(()=>mapModelToolInputs(binding,workflow,{...inputs,unknown:1}),/不支持输入/);
  assert.throws(()=>mapModelToolInputs(binding,workflow,{text:'hair'}),/请明确提供/);
  assert.throws(()=>mapModelToolInputs(binding,workflow,{...inputs,box:[5,5,2,2]}),/box/);
  assert.throws(()=>mapModelToolInputs({...binding,mappings:[{source:'points',node:'6',field:'points_json',encoding:'value'}]},workflow,{points:inputs.points}),/encoding: json/);
 });
 await t.test('detached semantic or enhancement fields cannot claim to affect the selected output',async()=>{
  await assert.rejects(()=>mp('save',{...binding,role:'enhancement',output:'image',mappings:[{source:'upscaler',node:'7',field:'upscaler'}]}),/未连接到所选输出/);
 });
 await t.test('missing nodes and missing weights fail preflight before prompt submission',async()=>{
  const count=calls.filter(c=>c.url==='/prompt').length;
  missingNode=true;await assert.rejects(()=>mp('inspect',{id:binding.id,inputs}),/Segment/);missingNode=false;
  missingModel=true;await assert.rejects(()=>mp('inspect',{id:binding.id,inputs}),/segment.onnx/);missingModel=false;
  assert.equal(calls.filter(c=>c.url==='/prompt').length,count);
 });
 await t.test('normal queued job returns transparent source plus gray mask and preserves source alpha',async()=>{
  outputBuffer=gray;const response=await mp('run',{id:binding.id,inputs,uploadId:saveUpload(source,'image/png')});
  let j;for(let i=0;i<100;i++){j=getJob(response.id);if(['done','error'].includes(j.status))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(j.status,'done',j.error);assert.equal(j.result.provider,'model-tools');assert.equal(j.post.align,false);assert.equal(submitted.prompt['6'].inputs.text,'hair');assert.equal(submitted.prompt['6'].inputs.points_json,JSON.stringify(inputs.points));assert.equal(submitted.prompt['1'].inputs.image,'actual-upload.png');
  const alpha=await sharp(j.result.path).extractChannel('alpha').raw().toBuffer();assert.ok(alpha.every(x=>x===64));assert.ok(fs.existsSync(j.meta.mask.path));assert.ok(fs.existsSync(path.join(j.dir,'model-tool-workflow.json')));assert.equal(workflows().length,1);
 });
 await t.test('colored or wrong-size output cannot masquerade as segmentation; snapshots clean up',async()=>{
  const task={binding,inputs,snapshot:mapModelToolInputs(binding,workflow,inputs)};
  outputBuffer=colored;await assert.rejects(()=>modelTools.run(job(binding.id,{meta:{modelTool:task}}),ctx()),/彩色像素/);
  outputBuffer=await sharp(gray).resize(16,24).png().toBuffer();await assert.rejects(()=>modelTools.run(job(binding.id,{meta:{modelTool:task}}),ctx()),/尺寸与原图不同/);
  outputBuffer=gray;assert.equal(workflows().length,1);
 });
 await t.test('alpha output requires a genuine alpha channel',async()=>{
  const b={...binding,output:'alpha'},task={binding:b,inputs,snapshot:mapModelToolInputs(b,workflow,inputs)};
  outputBuffer=gray;await assert.rejects(()=>modelTools.run(job(b.id,{meta:{modelTool:task}}),ctx()),/没有 alpha/);
  outputBuffer=source;const out=await modelTools.run(job(b.id,{meta:{modelTool:task}}),ctx());const alpha=await sharp(out.path).extractChannel('alpha').raw().toBuffer();assert.ok(alpha.every(x=>x===64));outputBuffer=gray;
 });
 await t.test('enhancement requires explicit real upscaler and validates its server enum',async()=>{
  const enhancePrompt=structuredClone(prompt);enhancePrompt['9'].inputs.images=['7',0];
  const enhanceWorkflow=await comfyRoutes('POST',['comfyui','save'],{title:'Enhance workflow',prompt:enhancePrompt,mapping:[{node:'1',field:'image',source:'image'}],outputNode:'9'});
  const b=await mp('save',{title:'Upscale',role:'enhancement',workflowId:enhanceWorkflow.id,outputNode:'9',output:'image',mappings:[{source:'upscaler',node:'7',field:'upscaler'},{source:'scale',node:'7',field:'scale'}]});
  await assert.rejects(()=>mp('inspect',{id:b.id,inputs:{upscaler:'missing.pth',scale:2}}),/missing.pth/);
  assert.throws(()=>mapModelToolInputs(b,enhanceWorkflow,{upscaler:'Lanczos',scale:2}),/普通插值/);
  const values={upscaler:'real-upscale.pth',scale:2};const out=await modelTools.run(job(b.id,{meta:{modelTool:{binding:b,inputs:values,snapshot:mapModelToolInputs(b,enhanceWorkflow,values)}}}),ctx());assert.match(out.source,/real-upscale.pth/);assert.equal(submitted.prompt['7'].inputs.upscaler,'real-upscale.pth');
  fs.unlinkSync(path.join(dir,'comfyui','workflows',`${enhanceWorkflow.id}.json`));
 });
 await t.test('cancellation removes only own queued Comfy prompt, never global interrupt',async()=>{
  pending=true;const controller=new AbortController(),j=job(binding.id,{meta:{modelTool:{binding,inputs,snapshot:mapModelToolInputs(binding,workflow,inputs)}}});
  const promise=modelTools.run(j,{log:()=>{},signal:controller.signal});
  for(let i=0;i<100&&j.upstream?.state!=='submitted';i++)await new Promise(r=>setTimeout(r,5));controller.abort();
  await assert.rejects(()=>promise);pending=false;assert.equal(workflows().length,1);assert.equal(calls.some(c=>c.url.includes('interrupt')),false);
 });
 await t.test('engine catalog provenance, reversible trash, busy guard and stop wait for child close',async t=>{
  const engineRoot=path.join(dir,'engines','matting'),python=path.join(engineRoot,'venv','bin','python'),modelFile=path.join(engineRoot,'models','u2netp.onnx');
  fs.mkdirSync(path.dirname(python),{recursive:true});fs.mkdirSync(path.dirname(modelFile),{recursive:true});
  fs.writeFileSync(python,`#!${process.execPath}\nprocess.on('SIGTERM',()=>setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(path.join(dir,'probe-closed'))},'closed');process.exit(0);},80));require('fs').writeFileSync(${JSON.stringify(path.join(dir,'probe-started'))},String(process.pid));setTimeout(()=>{},60000);\n`,{mode:0o755});
  fs.writeFileSync(modelFile,'mock weights');fs.writeFileSync(path.join(engineRoot,'state.json'),JSON.stringify({phase:'ready',ready:true}));
  const {engineRoutes,engineCatalog}=await import('../lib/engines.mjs');const ep=(p,b={})=>engineRoutes('POST',['engine',p],b);
  // Observe the actual spawned child, rather than inferring reaping from a marker file.
  const nativeSpawn=childProcess.spawn,workers=[];
  const spawnSpy=t.mock.method(childProcess,'spawn',(...args)=>{
   const child=nativeSpawn(...args);
   if(args[0]===python){const worker={child,closed:false};workers.push(worker);child.once('close',()=>{worker.closed=true;});}
   return child;
  });
  syncBuiltinESMExports();
  t.after(()=>{spawnSpy.mock.restore();syncBuiltinESMExports();});
  const originalHash=engineCatalog[0].md5;assert.match(engineCatalog[0].source,/github.com\/danielgatis/);assert.equal(originalHash,'8e83ca70e441ab06c318d82300c84806');
  // Only the isolated test catalog accepts tiny mock bytes; no weights or packages are downloaded.
  engineCatalog[0].md5=crypto.createHash('md5').update('mock weights').digest('hex');
  t.after(async()=>{await ep('stop');engineCatalog[0].md5=originalHash;});
  await ep('probe',{model:'u2netp'});await assert.rejects(()=>ep('uninstall',{target:'environment'}),/正在运行/);
  // Readiness is written only AFTER installing SIGTERM handling, avoiding a startup race.
  const readyFile=path.join(dir,'probe-started'),deadline=Date.now()+10000;
  let workerPid=0;
  while(Date.now()<deadline){
   const marker=fs.existsSync(readyFile)?fs.readFileSync(readyFile,'utf8').trim():'';
   if(/^[1-9][0-9]*$/.test(marker)){workerPid=Number(marker);break;}
   await new Promise(r=>setTimeout(r,20));
  }
  assert.ok(workerPid>0,'mock worker did not publish a complete PID marker');
  assert.equal(workers.length,1,'probe must launch exactly one worker');
  assert.equal(workers[0].child.pid,workerPid,'stop must track the actual worker PID');
  const stopped=await ep('stop');
  assert.ok(fs.existsSync(path.join(dir,'probe-closed')));assert.equal(stopped.busy,false);
  assert.equal(workers[0].closed,true,'stop must await this worker close, not just signal delivery');
  assert.equal(workers[0].child.exitCode,0,'worker must complete its SIGTERM cleanup');
  assert.equal(workers[0].child.signalCode,null);
  // A kernel PID-existence probe is separate from Node's child close notification.
  // Allow a bounded visibility window, but still require ESRCH; never accept EPERM
  // or a live worker, and never send another signal to a potentially reused PID.
  const reapDeadline=performance.now()+2000;let reapPolls=0;
  for(;;){
   try{process.kill(workerPid,0);}catch(e){if(e.code!=='ESRCH')throw e;break;}
   if(performance.now()>=reapDeadline)break;
   reapPolls++;await new Promise(r=>setTimeout(r,20));
  }
  assert.throws(()=>process.kill(workerPid,0),{code:'ESRCH'});
  if(reapPolls)t.diagnostic(`Worker ${workerPid} closed with exitCode=0; PID disappeared after ${reapPolls} visibility polls`);
  assert.ok(fs.existsSync(python));assert.ok(stopped.models[0].verification.sha256);
  const secondModel=path.join(engineRoot,'models','models','u2netp','u2netp.onnx');fs.mkdirSync(path.dirname(secondModel),{recursive:true});fs.copyFileSync(modelFile,secondModel);
  let state=await ep('uninstall',{target:'model',model:'u2netp'});assert.equal(fs.existsSync(secondModel),false);assert.equal(fs.existsSync(modelFile),false);assert.ok(state.trash[0].id);await ep('restore',{id:state.trash[0].id});assert.equal(fs.readFileSync(modelFile,'utf8'),'mock weights');assert.ok(fs.existsSync(secondModel));
  fs.mkdirSync(path.join(engineRoot,'python'),{recursive:true});fs.writeFileSync(path.join(engineRoot,'python','test-runtime'),'runtime');
  state=await ep('uninstall',{target:'environment'});assert.equal(fs.existsSync(path.join(engineRoot,'python')),false);assert.equal(fs.existsSync(python),false);await ep('restore',{id:state.trash.find(x=>x.target==='environment').id});assert.ok(fs.existsSync(python));assert.ok(fs.existsSync(path.join(engineRoot,'python','test-runtime')));
  await assert.rejects(()=>ep('restore',{id:'../../bad'}),/ID/);await assert.rejects(()=>ep('run',{model:'absent'}),/先安装/);
  engineCatalog[0].md5=originalHash;
 });
 await t.test('matting refinement denoises, thresholds and never expands original alpha',()=>{
  const py=spawnSync('python3',['-c',`import sys\nsys.path.insert(0, 'engine')\nfrom matting import refine_mask\nfrom PIL import Image\na=Image.new('L',(5,5),128); a.putpixel((0,0),0)\nm=Image.new('L',(5,5),255);m.putpixel((2,2),0)\nr=refine_mask(m,a,denoise=1,erode=-1,feather=1)\nassert r.getpixel((2,2))==128 and r.getpixel((0,0))==0\nassert all(x<=y for x,y in zip(r.getdata(),a.getdata()))\nm=Image.new('L',(5,5),100)\nassert refine_mask(m,a,threshold=.5).getextrema()==(0,0)\nassert refine_mask(Image.new('L',(5,5),255),a).tobytes()==a.tobytes()\n`],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(py.status,0,py.stderr);
 });
});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});

// Exercise real DOM/canvas pointer events against mocked APIs; no model is executed.
test('visual model tools map scaled points/boxes to original pixels and preserve advanced inputs',async t=>{
 const {chromium}=await import('playwright-core');
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 if(!fs.existsSync(chrome)){t.skip('Chrome unavailable for renderer integration test');return;}
 const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1000,height:1400}});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 const mappings=[{source:'text',node:'6',field:'text',encoding:'value'},{source:'points',node:'6',field:'points_json',encoding:'json'},{source:'box',node:'6',field:'box_json',encoding:'json'},{source:'includeParts',node:'6',field:'include',encoding:'csv'},{source:'excludeParts',node:'6',field:'exclude',encoding:'csv'}];
 const semantic={id:'visual-binding',title:'Segmentation model',role:'segmentation',family:'user',workflowId:'visual-workflow',outputNode:'9',output:'gray',mappings};
 const image=await sharp({create:{width:320,height:200,channels:3,background:'#8090a0'}}).png().toBuffer();
 await page.route('http://model.test/**',async route=>{
  if(route.request().url().includes('/uploads/'))return route.fulfill({body:image,contentType:'image/png'});
  return route.fulfill({body:'{}',contentType:'application/json'});
 });
 await page.setContent('<style>.studio-grid {width:460px} .model-tools-card {margin:20px} .row {display:flex;gap:8px} [hidden]{display:none!important}</style><section id="tab-studio"><div class="studio-grid"></div></section>');
 await page.evaluate(({semantic,prompt})=>{
  window.$=id=>document.getElementById(id);window.esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.reason=e=>e.message;window.toast=(s)=>{window.lastToast=s;};window.url=p=>'http://model.test'+p;
  window.calls=[];window.work={input:{uploadId:'two',name:'Second image',width:999,height:999},jobs:[]};window.bridge={pickImages:async()=>[{uploadId:'one',name:'Actual source',width:999,height:999}]};window.refreshJobs=async()=>{};window.openViewer=()=>{};
  window.api=async(method,p,body)=>{window.calls.push({method,p,body});if(p==='/model-tools')return {bindings:[semantic,{...semantic,id:'text-only',title:'Text only',mappings:[semantic.mappings[0]]}],workflows:[{id:'visual-workflow',title:'Real workflow',prompt}]};if(p==='/forge')return {connection:{url:'http://localhost:7860'},presets:[]};if(p==='/model-tools/run')return {id:'visual-job'};return {ok:true};};
 },{semantic,prompt});
 await page.addStyleTag({path:path.resolve(import.meta.dirname,'../../desktop/src/renderer/model-tools.css')});
 await page.addScriptTag({path:path.resolve(import.meta.dirname,'../../desktop/src/renderer/model-tools.js')});
 await page.waitForFunction(()=>document.getElementById('mtBindings').options.length===3);
 await page.selectOption('#mtBindings','visual-binding');await page.click('#mtPick');await page.waitForFunction(()=>document.getElementById('mtInputLabel').textContent.includes('320×200'));
 const read=()=>page.$eval('#mtInputs',el=>JSON.parse(el.value));
 const canvas=page.locator('#mtCanvas');await canvas.scrollIntoViewIfNeeded();let b=await canvas.boundingBox();
 await page.mouse.click(b.x+b.width*.25,b.y+b.height*.25);assert.deepEqual((await read()).points,[{x:80,y:50,label:1}]);
 await page.selectOption('#mtPointerMode','exclude');await canvas.scrollIntoViewIfNeeded();b=await canvas.boundingBox();await page.mouse.click(b.x+b.width*.75,b.y+b.height*.75);assert.deepEqual((await read()).points[1],{x:240,y:150,label:0});
 await page.selectOption('#mtPointerMode','box');await canvas.scrollIntoViewIfNeeded();b=await canvas.boundingBox();await page.mouse.move(b.x+b.width*.75,b.y+b.height*.75);await page.mouse.down();await page.mouse.move(b.x+b.width*.25,b.y+b.height*.25,{steps:4});await page.mouse.up();assert.deepEqual((await read()).box,[80,50,240,150]);
 await page.fill('#mtText','hair only');await page.getByRole('checkbox',{name:'包含头发',exact:true}).check();assert.deepEqual((await read()).includeParts,['hair']);
 await page.getByRole('checkbox',{name:'排除头发',exact:true}).check();assert.deepEqual((await read()).includeParts,[]);assert.deepEqual((await read()).excludeParts,['hair']);
 await page.fill('#mtIncludeCustom','face_detail');await page.locator('#mtIncludeCustom').blur();assert.deepEqual((await read()).includeParts,['face_detail']);
 await page.evaluate(()=>document.querySelector('.studio-grid').style.width='300px');await page.selectOption('#mtPointerMode','include');await canvas.scrollIntoViewIfNeeded();b=await canvas.boundingBox();await page.mouse.click(b.x+b.width*.5,b.y+b.height*.5);assert.deepEqual((await read()).points.at(-1),{x:160,y:100,label:1});assert.deepEqual((await read()).box,[80,50,240,150]);
 await page.click('#mtClearBox');assert.deepEqual((await read()).box,[]);await page.click('#mtUndoPoint');assert.equal((await read()).points.length,2);
 await page.locator('summary').filter({hasText:'高级：本次任务输入 JSON'}).click();
 await page.fill('#mtInputs',JSON.stringify({text:'advanced',points:[{x:10,y:20,label:0}],box:[1,2,30,40],includeParts:['custom'],excludeParts:[]}));await page.click('#mtApplyJson');assert.equal(await page.inputValue('#mtText'),'advanced');assert.match(await page.locator('#mtPoints').textContent(),/10, 20/);
 await page.click('#mtRun');await page.waitForFunction(()=>calls.some(c=>c.p==='/model-tools/run'));const submitted=await page.evaluate(()=>calls.find(c=>c.p==='/model-tools/run').body);assert.equal(submitted.uploadId,'one');assert.deepEqual(submitted.inputs.box,[1,2,30,40]);
 await page.click('#mtFromWork');await page.waitForFunction(()=>document.getElementById('mtInputLabel').textContent.includes('Second image'));assert.deepEqual((await read()).points,[]);assert.deepEqual((await read()).box,[]);assert.equal((await read()).text,'advanced');
 await page.click('#mtResetSelection');assert.deepEqual(await read(),{text:'',points:[],box:[],includeParts:[],excludeParts:[]});
 await page.selectOption('#mtBindings','text-only');assert.equal(await page.locator('[data-part-side="includeParts"]').first().isDisabled(),true);assert.equal(await page.locator('#mtCanvas').getAttribute('class'),'mt-disabled');
 assert.deepEqual(pageErrors,[]);
});
