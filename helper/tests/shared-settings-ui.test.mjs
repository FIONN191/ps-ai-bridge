import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('settings sync retains fast changes and merges latest cross-client fields',async()=>{
 const fields=Object.fromEntries(['provider','model','aspect','cc'].map(id=>[id,{value:id==='provider'?'aistudio':id==='aspect'?'auto':'',type:'text',tagName:'INPUT',events:{},addEventListener(n,f){this.events[n]=f;}}]));
 let state={revision:1,values:{provider:'aistudio',aspect:'auto'}},timer,release,hold=false;
 const context={module:{exports:{}},document:{getElementById:id=>fields[id],querySelector:()=>null,activeElement:null},setInterval:f=>(timer=f,1),clearInterval:()=>{},Promise,Object,String,console};
 vm.runInNewContext(fs.readFileSync(new URL('../../plugin/shared-settings.js',import.meta.url),'utf8'),context);
 const request=async(method,p,b)=>{if(method==='GET'){if(hold){hold=false;await new Promise(r=>release=r);}return structuredClone(state);}assert.equal(b.revision,state.revision);state={revision:state.revision+1,values:{...state.values,...b.values}};return structuredClone(state);};
 const sync=context.module.exports({request,ready:()=>true,onProvider:()=>{},onError:e=>{throw e;}});await new Promise(r=>setImmediate(r));
 hold=true;fields.model.value='new-model';fields.model.events.change();await new Promise(r=>setImmediate(r));fields.aspect.value='2:3';fields.aspect.events.change();state={revision:2,values:{...state.values,cc:'global'}};release();await new Promise(r=>setImmediate(r));await timer();await timer();
 assert.equal(state.values.model,'new-model');assert.equal(state.values.aspect,'2:3');assert.equal(fields.cc.value,'global');sync.stop();
});
