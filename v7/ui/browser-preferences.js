(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.V7BrowserPreferences=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const KEY='browser.preferences.v1',MAX_BOOKMARKS=200,GRACE_MS=4000;
  const DEFAULTS=[
    {name:'Pinterest',url:'https://www.pinterest.com/'},
    {name:'抖音搜索',url:'https://www.douyin.com/search/'},
    {name:'ArtStation',url:'https://www.artstation.com/'},
    {name:'Civitai',url:'https://civitai.com/'},
    {name:'HuggingFace',url:'https://huggingface.co/'},
    {name:'百度',url:'https://www.baidu.com/'},
    {name:'Google',url:'https://www.google.com/'}
  ];
  const fail=message=>Object.assign(new Error(message),{code:'BROWSER_PREFERENCES_FAILED'});
  function webUrl(value){
    if(typeof value!=='string'||value.trim().length>2048)throw fail('书签网址不得超过 2048 个字符');
    let url;try{url=new URL(value.trim());}catch(_){throw fail('请填写完整的 HTTP 或 HTTPS 书签网址');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('书签只支持不含账号口令的 HTTP 或 HTTPS 地址');
    return url.href;
  }
  function normalize(value){
    if(!value||value.version!==1||!Array.isArray(value.bookmarks)||value.bookmarks.length>MAX_BOOKMARKS||typeof value.idleLock!=='boolean')throw fail('浏览器设置格式无效，请保留原数据并重新打开');
    return {version:1,idleLock:value.idleLock,bookmarks:value.bookmarks.map(row=>{
      if(!row||typeof row.name!=='string'||!row.name.trim()||row.name.trim().length>120)throw fail('每个书签需要 1 至 120 个字符的名称');
      return {name:row.name.trim(),url:webUrl(row.url)};
    })};
  }
  function defaults(){return normalize({version:1,idleLock:true,bookmarks:DEFAULTS});}
  function createStore({storage,key,check=()=>{}}){
    let original;
    const read=()=>{check();const raw=storage.getItem(key);if(raw&&raw.length>1024*1024)throw fail('浏览器设置超过本机读取上限');return raw;};
    return {
      load(){original=read();if(original===null)return defaults();try{return normalize(JSON.parse(original));}catch(error){throw fail('本机浏览器设置无法读取，原数据已保留：'+error.message);}},
      save(value){check();const clean=normalize(value);if(original===undefined)throw fail('请先读取浏览器设置');if(read()!==original)throw fail('浏览器设置已在另一处改变，请重新打开后再编辑');const text=JSON.stringify(clean);storage.setItem(key,text);original=text;return clean;}
    };
  }
  function createTaskLock({onChange=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
    let timer=null,disposed=false,current={locked:true,grace:false,reason:'正在读取进行中任务'};
    const emit=next=>{if(disposed)return;if(Object.keys(next).some(key=>next[key]!==current[key])){current=next;onChange({...current});}};
    const cancel=()=>{if(timer!==null){clearTimer(timer);timer=null;}};
    return {
      state:()=>({...current}),
      update({idleLock=true,taskCount=null}={}){
        if(disposed)return;
        if(idleLock===false){cancel();emit({locked:false,grace:false,reason:'未启用任务锁，可自由浏览'});return;}
        if(!Number.isSafeInteger(taskCount)||taskCount<0){cancel();emit({locked:true,grace:false,reason:'暂时无法读取进行中任务'});return;}
        if(taskCount>0){cancel();emit({locked:false,grace:false,reason:'有 '+taskCount+' 个任务进行中'});return;}
        if(current.locked){cancel();emit({locked:true,grace:false,reason:'当前没有进行中的任务'});return;}
        if(timer===null){emit({locked:false,grace:true,reason:'任务已结束，4 秒后锁定网页'});timer=setTimer(()=>{timer=null;emit({locked:true,grace:false,reason:'当前没有进行中的任务'});},GRACE_MS);}
      },
      dispose(){disposed=true;cancel();}
    };
  }
  return {KEY,MAX_BOOKMARKS,GRACE_MS,fail,webUrl,normalize,defaults,createStore,createTaskLock};
});
