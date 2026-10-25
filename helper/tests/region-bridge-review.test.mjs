import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import sharp from 'sharp';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-region-review-'));process.env.PS_AI_BRIDGE_DATA_DIR=dir;
const {config}=await import('../lib/config.mjs');config.outputDir=path.join(dir,'outputs');
const jobs=await import('../lib/jobs.mjs');
const {regionRoutes,regionRecord,regionFile,validateTarget,validateRect}=await import('../lib/regions.mjs');
const createBridge=createRequire(import.meta.url)('../../plugin/region-bridge.js');
const post=(op,body)=>regionRoutes('POST',['regions',op],body);
const root=path.join(dir,'workbench','regions');
const target={session:'test-session',docId:7,name:'Original',width:20,height:16};
const rect={left:2,top:3,right:6,bottom:7};
const png=(color,w=4,h=4)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
const capture=async(t=target,color='red')=>post('capture',{target:t,rect,uploadId:jobs.saveUpload(await png(color),'image/png')});
const makeJob=async pack=>{const file=jobs.useUpload(pack.uploadId);return jobs.createLocalResult({sourcePath:file,buffer:fs.readFileSync(file),title:'Generated pack'});};

test('durable region IDs, cropped masks and repeat/concurrent split',async t=>{
 await t.test('binding IDs are not truncated or aliased and rectangles are normalized',()=>{
  assert.throws(()=>validateTarget({...target,session:'x'.repeat(101)}),/绑定/);assert.throws(()=>validateTarget({...target,docId:-1}),/绑定/);
  assert.deepEqual(validateRect({...rect,unexpected:1},target),rect);
 });
 await t.test('capture failure removes only its new incomplete directory',async()=>{
  const before=fs.existsSync(root)?fs.readdirSync(root):[];
  await assert.rejects(async()=>post('capture',{target,rect,uploadId:jobs.saveUpload(await png('red',2,2),'image/png')}),/尺寸/);
  assert.deepEqual(fs.readdirSync(root),before);
 });
 await t.test('gray+alpha mask is single-channel and clipped to capture rectangle',async()=>{
  const b={left:0,top:0,right:8,bottom:8},mask=await png({r:128,g:128,b:128,alpha:.5},8,8);
  const c=await post('capture',{target,rect,uploadId:jobs.saveUpload(await png('red'),'image/png'),maskUploadId:jobs.saveUpload(mask,'image/png'),maskBounds:b});
  assert.deepEqual(c.mask,rect);const raw=await regionFile(c.id,'mask-raw');assert.equal(raw.buffer.length,16);assert.ok(raw.buffer.every(x=>x===128));
 });
 const a=await capture(),b=await capture({...target,docId:8,name:'Second'},'blue');
 const pack=await post('pack',{ids:[a.id,b.id],columns:2}),job=await makeJob(pack);
 await t.test('split captures have their own stable targets after original capture rebind',async()=>{
  await post('rebind',{id:a.id,target:{...target,docId:99,session:'new-session'}});
  const split=await post('split',{id:pack.id,jobId:job.id}),s=split.splits[0];assert.equal(s.status,'done');assert.equal(s.outputs.length,2);
  const out=s.outputs[0],boundCapture=regionRecord(out.captureId);assert.notEqual(out.captureId,a.id);assert.equal(boundCapture.target.docId,7);assert.deepEqual(boundCapture.rect,rect);assert.equal(out.sourceCaptureId,a.id);
  const outJob=jobs.getJob(out.jobId);assert.equal(outJob.meta.parameters.captureId,out.captureId);assert.deepEqual(outJob.meta.parameters.target,target);
  assert.ok(fs.existsSync(path.join(root,pack.id,s.sourceFile)));assert.match(s.sourceSha256,/^[a-f0-9]{64}$/);
 });
 await t.test('concurrent repeated split returns identical jobs and immutable pack mappings',async()=>{
  const original=regionRecord(pack.id);const counts=jobs.listJobs(10000).length;
  const results=await Promise.all(Array.from({length:3},()=>post('split',{id:pack.id,jobId:job.id})));
  for(const r of results){assert.equal(r.splits.length,1);assert.deepEqual(r.splits[0].outputs,original.splits[0].outputs);assert.deepEqual(r.mapping,pack.mapping);}
  assert.equal(jobs.listJobs(10000).length,counts);
 });
 await t.test('lost output append resumes saved jobs instead of duplicating them',async()=>{
  const r=regionRecord(pack.id),ids=r.splits[0].outputs.map(x=>x.jobId),count=jobs.listJobs(10000).length;
  r.splits[0].outputs=[];r.splits[0].status='error';fs.writeFileSync(path.join(root,pack.id,'record.json'),JSON.stringify(r));
  const resumed=await post('split',{id:pack.id,jobId:job.id});assert.deepEqual(resumed.splits[0].outputs.map(x=>x.jobId),ids);assert.equal(jobs.listJobs(10000).length,count);
 });
 await t.test('variant selection and different source bytes create distinct pinned split records',async()=>{
  const real=jobs.getJob(job.id);real.applied={variant:{cc:'none',tex:false,t:.5}};
  const second=await post('split',{id:pack.id,jobId:job.id});assert.equal(second.splits.length,2);assert.equal(second.splits[1].sourceVariant.t,.5);
  assert.notEqual(second.splits[0].outputs[0].captureId,second.splits[1].outputs[0].captureId);
  const p=await post('pack',{ids:[a.id,b.id],columns:2}),j=await makeJob(p);
  await post('split',{id:p.id,jobId:j.id});fs.writeFileSync(j.result.path,await png('green',8,4));
  const changed=await post('split',{id:p.id,jobId:j.id});assert.equal(changed.splits.length,2);assert.notEqual(changed.splits[0].sourceSha256,changed.splits[1].sourceSha256);
 });
 await t.test('malformed grid / column inputs are rejected rather than silently defaulted',async()=>{
  await assert.rejects(()=>post('grid',{target,size:0}),/尺寸/);await assert.rejects(()=>post('pack',{ids:[a.id],columns:0}),/正整数/);
  await assert.rejects(()=>post('pack',{ids:[a.id],columns:Infinity}),/正整数/);
 });
});

function fixture(){
 const state={modal:false,calls:[],put:[],layers:[],disposed:0,filesDeleted:0,selectionReads:0,closed:false,pasteCount:0,maskBytes:new Uint8Array([0,128,255,64])};
 function doc(id,title){const d={id,title,width:10,height:8,mode:'CMYK',bitsPerChannel:32,activeLayers:[{id:4}],layers:[{id:3,layers:[{id:4}]}],channels:[],activeChannels:[]};
  let selection={bounds:null,pixels:null};d.selection={get bounds(){state.selectionReads++;return selection.bounds;},
   async deselect(){selection={bounds:null,pixels:null};},async selectRectangle(b){selection={bounds:{...b},pixels:null};},
   async save(name){const snap=structuredClone(selection),channel={name,snap,async remove(){d.channels=d.channels.filter(c=>c!==channel);}};d.channels.push(channel);},
   async load(channel){selection=structuredClone(channel.snap);},
   setState(value){selection=value;},getState(){return structuredClone(selection);},
  };
  d.duplicate=async(name,merge)=>{assert.equal(state.modal,true);assert.equal(merge,true);const tmp=doc(77,name);tmp.selection.setState(d.selection.getState());state.tmp=tmp;state.app.documents.push(tmp);state.app.activeDocument=tmp;return tmp;};
  d.crop=async bounds=>{state.crop=bounds;d.width=bounds.right-bounds.left;d.height=bounds.bottom-bounds.top;};d.changeMode=async mode=>{d.mode=mode;};d.convertProfile=async(...args)=>{state.profile=args;};
  d.saveAs={png:async()=>{assert.equal(d.mode,'RGB');assert.equal(d.bitsPerChannel,8);if(state.exportError)throw new Error('export failed');}};
  d.closeWithoutSaving=()=>{state.closed=true;state.app.documents=state.app.documents.filter(x=>x!==d);if(state.app.activeDocument===d)state.app.activeDocument=state.app.documents[0];};
  return d;
 }
 const d=doc(1,'Target'),other=doc(2,'Other');state.doc=d;state.other=other;state.app={documents:[d,other],activeDocument:other};
 const deps={app:state.app,constants:{DocumentMode:{RGB:'RGB'},ChangeMode:{RGB:'RGB'},BitsPerChannelType:{EIGHT:8},Intent:{RELATIVECOLORIMETRIC:'relative'}},
  core:{executeAsModal:async fn=>{assert.equal(state.modal,false);state.modal=true;try{return await fn({hostControl:{registerAutoCloseDocument:async id=>state.calls.push(['register',id]),unregisterAutoCloseDocument:async id=>state.calls.push(['unregister',id])}});}finally{state.modal=false;}}},
  action:{addNotificationListener:async(events,fn)=>{assert.deepEqual(events,['close']);state.onClose=fn;},batchPlay:async descriptors=>state.bpError?[{_obj:'error',message:'action failed'}]:descriptors.map(()=>({}))},
  imaging:{getSelection:async options=>{state.selectionOptions=options;return {sourceBounds:options.sourceBounds,imageData:{width:2,height:2,components:1,componentSize:16,getData:async options=>{assert.equal(options.fullRange,false);return new Uint16Array([0,16384,32768,8192]);},dispose:()=>state.disposed++}};},
   createImageDataFromBuffer:async(buffer,options)=>{state.created={buffer:[...buffer],options};return {pixels:buffer,dispose:()=>state.disposed++};},
   putSelection:async options=>{assert.equal(state.modal,true);state.put.push(options);const b=options.targetBounds;d.selection.setState({bounds:{left:b.left,top:b.top,right:b.left+2,bottom:b.top+2},pixels:[...options.imageData.pixels]});},
   putLayerMask:async options=>{assert.equal(state.modal,true);state.layers.push(options);},
  },formats:{binary:'binary'},HELPER:'http://mock',HEADERS:{'x-bridge':'1'},
  tempFile:async()=>({read:async()=>new Uint8Array([1,2,3]),delete:async()=>state.filesDeleted++}),
  uploadBytes:async()=>{assert.equal(state.modal,false);return 'image-upload';},post:async(_path,body)=>{assert.equal(state.modal,false);state.capture=body;return {ok:true,json:async()=>({id:'durable-capture',...body})};},
  pasteHistory:async(_job,context)=>{state.pasteCount++;state.context=context;if(state.pasteError)throw new Error('placement failed');},
 };
 state.bridge=createBridge(deps);state.fetch=async(input,opts)=>{
  assert.equal(state.modal,false,'network request must be outside executeAsModal');state.calls.push(['fetch',input]);
  if(input.includes('/masks/raw')){state.uploadMask=[...opts.body];return {ok:true,json:async()=>({uploadId:'mask-upload'})};}
  if(state.beforeMask)state.beforeMask();return {ok:true,headers:{get:()=>JSON.stringify({left:2,top:1,right:4,bottom:3})},arrayBuffer:async()=>state.maskBytes.buffer};
 };state.target=()=>({session:state.bridge.session,docId:d.id,width:d.width,height:d.height,name:d.title});return state;
}

test('UXP capture, masks, document generations and cleanup',async t=>{
 const originalFetch=globalThis.fetch;
 try{
  await t.test('capture clips to explicit rectangle, converts only duplicate, scales 16-bit mask and uploads outside modal',async()=>{
   const f=fixture();globalThis.fetch=f.fetch;f.doc.selection.setState({bounds:{left:-2,top:-1,right:8,bottom:6}});
   const r=await f.bridge.execute({type:'capture-region',target:f.target(),rect:{left:2,top:1,right:4,bottom:3}});
   assert.deepEqual(f.selectionOptions.sourceBounds,r.rect);assert.deepEqual(f.uploadMask,[0,128,255,64]);assert.deepEqual(r.maskBounds,r.rect);assert.equal(f.doc.mode,'CMYK');assert.equal(f.doc.bitsPerChannel,32);assert.equal(f.app.activeDocument,f.other);assert.equal(f.closed,true);assert.equal(f.disposed,1);assert.equal(f.filesDeleted,1);assert.deepEqual(f.calls[0],['register',77]);
  });
  await t.test('whole-document capture does not read selection and cleans duplicate on export failure',async()=>{
   const f=fixture();globalThis.fetch=f.fetch;f.exportError=true;
   await assert.rejects(()=>f.bridge.execute({type:'capture-region',target:f.target(),useSelection:false}),/export failed/);
   assert.equal(f.selectionReads,0);assert.equal(f.closed,true);assert.equal(f.app.activeDocument,f.other);assert.equal(f.filesDeleted,1);assert.equal(f.capture,undefined);
  });
  await t.test('mask output uses explicit document/layer IDs and rejects malformed byte count',async()=>{
   const f=fixture();globalThis.fetch=f.fetch;const cmd={type:'apply-mask',target:f.target(),rect:{left:2,top:1,right:4,bottom:3},jobId:'job',output:'mask',layerId:4};
   await f.bridge.execute(cmd);assert.equal(f.layers[0].documentID,1);assert.equal(f.layers[0].layerID,4);assert.equal(f.layers[0].kind,'user');assert.equal(f.created.options.components,1);assert.deepEqual(f.layers[0].targetBounds,{left:2,top:1});assert.equal(f.disposed,1);
   f.maskBytes=new Uint8Array([255]);await assert.rejects(()=>f.bridge.execute(cmd),/字节数/);assert.equal(f.layers.length,1);
  });
  await t.test('save-channel output preserves old selection and leaves only requested channel',async()=>{
   const f=fixture();globalThis.fetch=f.fetch;const before={bounds:{left:0,top:0,right:1,bottom:1},pixels:[99]};f.doc.selection.setState(before);
   await f.bridge.execute({type:'apply-mask',target:f.target(),rect:{left:2,top:1,right:4,bottom:3},jobId:'job',output:'channel',mode:'luma',name:'Kept mask'});
   assert.deepEqual(f.doc.selection.getState(),before);assert.deepEqual(f.doc.channels.map(c=>c.name),['Kept mask']);assert.deepEqual(f.doc.channels[0].snap.pixels,[0,128,255,64]);
  });
  await t.test('document changed during mask fetch is revalidated before write and image data disposed',async()=>{
   const f=fixture();globalThis.fetch=f.fetch;const captured=f.target();f.beforeMask=()=>f.doc.width=12;
   await assert.rejects(()=>f.bridge.execute({type:'apply-mask',target:captured,rect:{left:2,top:1,right:4,bottom:3},jobId:'job'}),/尺寸/);assert.equal(f.put.length,0);assert.equal(f.disposed,1);
  });
  await t.test('close notification invalidates reused numeric document ID; refresh returns a new binding',async()=>{
   const f=fixture();const old=f.target();await f.bridge.execute({type:'documents'});f.onClose('close',{documentID:1});
   const docs=await f.bridge.execute({type:'documents'}),next=docs.documents.find(d=>d.docId===1);assert.notEqual(next.session,old.session);assert.throws(()=>f.bridge.bound(old),/会话/);assert.equal(f.bridge.bound(next),f.doc);
  });
  await t.test('repeat successful bound paste removes temporary restored channel even when parent no-ops',async()=>{
   const f=fixture();globalThis.fetch=f.fetch;const cmd={type:'paste-bound',target:f.target(),rect:{left:2,top:1,right:4,bottom:3},captureId:'capture',mask:true,jobId:'job'};
   await f.bridge.execute(cmd);await f.bridge.execute(cmd);assert.equal(f.pasteCount,2);assert.equal(f.doc.channels.length,0);assert.equal(f.doc.selection.bounds,null);assert.equal(f.context.session,cmd.target.session);
  });
  await t.test('batchPlay error descriptors do not report select-subject success',async()=>{
   const f=fixture();f.bpError=true;await assert.rejects(()=>f.bridge.execute({type:'select-subject',target:f.target()}),/action failed/);
  });
 }finally{globalThis.fetch=originalFetch;}
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
