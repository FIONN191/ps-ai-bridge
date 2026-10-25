// Versioned shared settings. Only changed fields are merged; a stale client never overwrites unrelated edits.
function mountSharedSettings({request,ready,onProvider,onError}) {
 const fields=['provider','model','aspect','resolution','thinking','count','keepComposition','fallback','padding','cc','shrink','blur','returnAs','groupColor','checkpointMin','maskWithSelection','align','sound','tex','autoReturn'];
 let revision=null,busy=false,applying=false,pending={},stopped=false;
 const el=id=>document.getElementById(id),check=e=>e.type==='checkbox'||e.tagName==='SP-CHECKBOX';
 const read=()=>Object.fromEntries(fields.filter(id=>el(id)).map(id=>[id,check(el(id))?!!el(id).checked:String(el(id).value??'')]));
 function apply(s) { applying=true;try {for(const id of fields){const e=el(id),v=s.values[id];if(!e||v===undefined||id in pending)continue;if(check(e))e.checked=v;else {const options=e._dd?.items?.map(x=>x[0])||(e.options?[...e.options].map(o=>o.value):null);if(!options||options.includes(String(v)))e.value=String(v);}if(id==='provider')onProvider?.();}revision=s.revision;}finally{applying=false;} }
 async function flush() {
  if(busy||stopped||!ready()||!Object.keys(pending).length)return;
  busy=true;const patch=pending;pending={};
  try {let state=await request('GET','/shared-settings');let result;
   try{result=await request('POST','/shared-settings',{revision:state.revision,values:patch});}
   catch(e){state=await request('GET','/shared-settings');result=await request('POST','/shared-settings',{revision:state.revision,values:patch});}
   revision=null; // Refresh the complete merged state once editing focus leaves.
  }catch(e){pending={...patch,...pending};onError?.(e);}finally{busy=false;}
 }
 async function refresh() {
  if(stopped||busy||!ready())return;
  if(Object.keys(pending).length){await flush();return;}
  if(document.querySelector('.dd.open')||['INPUT','TEXTAREA','SELECT','SP-SLIDER'].includes(document.activeElement?.tagName))return;
  busy=true;try{let s=await request('GET','/shared-settings');if(s.revision===0)s=await request('POST','/shared-settings',{revision:0,values:read()});if(s.revision!==revision)apply(s);}catch(e){onError?.(e);}finally{busy=false;}
 }
 for(const id of fields)el(id)?.addEventListener('change',()=>{if(applying)return;const values=read(),patch=id==='provider'?Object.fromEntries(['provider','model','aspect','resolution','thinking'].filter(k=>k in values).map(k=>[k,values[k]])):{[id]:values[id]};pending={...pending,...patch};void flush();});
 const timer=setInterval(refresh,4000);void refresh();return {refresh,stop:()=>{stopped=true;clearInterval(timer);}};
}
if(typeof module!=='undefined')module.exports=mountSharedSettings;
