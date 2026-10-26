(function(root){
  'use strict';
  let epoch=0, selection=0, revision=0, fixed=[], temporary=[], selectedId='', loading=false, failure=null;
  let ready=Promise.resolve([]), change=()=>{}, selectedSignature='', mutation=null;
  async function mutate(action){
    if(mutation)throw fail('参考图正在保存或加载，请稍后再试');
    const token={};mutation=token;notify();
    try{return await action();}finally{if(mutation===token){mutation=null;notify();}}
  }
  const scope=()=>root.WHEELCHAIR_STORAGE?.namespaceId?.()||'local';
  const fail=message=>Object.assign(new Error(message),{code:'PRESET_REFERENCE_FAILED'});
  function context(){const account=scope(),version=epoch,seq=selection,rev=revision;return {check(selected=false){if(account!==scope()||version!==epoch||selected&&(seq!==selection||rev!==revision))throw fail('账号、预设或参考图已改变，本次操作已停止');}};}
  function release(rows){for(const row of rows){if(row.thumbUrl)URL.revokeObjectURL(row.thumbUrl);if(row.viewUrl)URL.revokeObjectURL(row.viewUrl);}}
  function display(asset){return {...asset,thumbUrl:URL.createObjectURL(asset.thumb),viewUrl:''};}
  function notify(){change();}
  // 2026-10-24（V7待办/07）：解码失败的真实原因 / 数据长度 / 开头 40 字符带进详情，「反馈这个问题」会一起发
  function report(error){root.ERR?.report(error.code||'PRESET_REFERENCE_FAILED',{message:String(error.message||error),context:error&&error.detail?{'真实原因':error.detail,'数据长度':String(error.size||''),'数据开头':String(error.head||'')}:undefined});}
  // ⭐ 2026-10-02 融合方案-C01：「能加几张」统一问闸门（reference-gate.js），这里不再写死 12 / 96MB。
  //   闸门没加载到（老页面 / 测试沙箱）时退回原来的数字，不让整个参考图功能挂掉。
  function gateCheck(count,bytes,adding,addingBytes){
    if(root.V7ReferenceGate)return root.V7ReferenceGate.check({count,bytes,adding,addingBytes});
    const allowed=count+adding<=12&&bytes+addingBytes<=96*1024*1024;
    return {allowed,max:12,remaining:Math.max(0,12-count),reason:allowed?'':(count+adding>12?'最多使用 12 张参考图':'参考图总量超过 96 MB'),blockedBy:''};
  }
  const sizeOf=rows=>rows.reduce((sum,row)=>sum+(row.full?.size||0),0);
  function select(preset){
    const signature=JSON.stringify(preset?.refImages||[]);
    if(preset&&selectedId===String(preset.id)&&selectedSignature===signature)return ready;
    // ⭐ R5（用户 2026-10-01）：「预设有带参考图，就清空用户添加的、换为预设的」＋「空预设就保留参考图」。
    //   ⚠⚠ C01 §5.3 坑 1：「这个预设带没带图」必须在 await【之前】用 preset.refImages 判定 ——
    //     等读完再判就分不清「本来没带图」和「带了但读失败了」。
    //   ⚠ 预设自己的图（fixed）不管哪种情况都要换掉 —— 那是上一个预设的。
    //   ⚠ 换账号不走「保留」：storage-context 监听会先把临时图清掉再调这里（L4，图是账号隔离的）。
    //   ⚠ guard / revision 照旧走（C01 §5.3 坑 2）：切到一半换账号，旧的加载结果会被丢掉。
    const presetHasRefs=!!preset?.refImages?.length;
    const seq=++selection;revision++;const guard=context();mutation=null;release(fixed);fixed=[];
    if(presetHasRefs){release(temporary);temporary=[];}
    selectedId=String(preset?.id||'');selectedSignature=signature;failure=null;loading=presetHasRefs;notify();
    ready=Promise.resolve().then(()=>root.PRESETS.resolveReferenceImages(preset)).then(assets=>{
      guard.check();
      if(seq===selection){fixed=assets.map(display);loading=false;notify();}
      return assets;
    },error=>{if(seq===selection){loading=false;failure=error;notify();report(error);}throw error;});
    ready.catch(()=>{});
    return ready;
  }
  function capture(){
    if(mutation)return Promise.reject(fail('参考图正在加载或保存，请完成后再生成'));
    const guard=context(), pending=ready, temps=temporary.slice();
    // Blobs are immutable. A submitted request owns these references even after UI URLs are released.
    return pending.then(assets=>{guard.check();const result=assets.concat(temps).map(row=>({...row,thumbUrl:undefined,viewUrl:undefined}));Object.defineProperty(result,'check',{value:()=>guard.check()});return result;});
  }
  async function payload(snapshot){
    const guard=context(),assets=await snapshot,result=[];guard.check();assets.check?.();
    for(const asset of assets){const data=await root.PRESETS.blobToDataUrl(asset.full);guard.check();assets.check?.();result.push({imageBase64:data.slice(data.indexOf(',')+1),mime:asset.mime,name:asset.name});}
    return result;
  }
  async function append(inputs,guard=context()){
    guard.check(true);const assets=await root.PRESETS.prepareReferenceImages(inputs);guard.check(true);
    await ready;guard.check(true);
    // L1 / L2（C01 §5.2）：张数和总量都问闸门。拒绝时抛的是闸门给的人话原因，签名不变（4 个调用方，C01 §5.1）。
    const verdict=gateCheck(fixed.length+temporary.length,sizeOf([...fixed,...temporary]),assets.length,sizeOf(assets));
    if(!verdict.allowed)throw fail(verdict.reason||'参考图加不进去了');
    temporary.push(...assets.map(display));revision++;notify();return true;
  }
  async function remove(kind,index){
    const guard=context();await ready;guard.check(true);
    const rows=kind==='fixed'?fixed:temporary,row=rows[index];if(!row)return;
    if(kind==='fixed'){
      const preset=root.PRESETS.presetById(selectedId);if(!preset)throw fail('当前预设不存在');
      const saved=await root.PRESETS.savePreset({...preset,refImages:fixed.filter((_,i)=>i!==index)});guard.check(true);selectedSignature=JSON.stringify(saved.refImages);
    }
    rows.splice(index,1);release([row]);ready=Promise.resolve(fixed.slice());revision++;notify();
    // ⭐ 2026-10-22（docs/263 第 6 条「删了能撤销」）：把删掉的那张交回去，撤销时用 restore() 放回原位。
    //   缩略图地址已经释放了，这里只留原图数据（Blob 不可变，留着不占额外内存）。
    return {kind,index,presetId:selectedId,asset:{...row,thumbUrl:undefined,viewUrl:undefined}};
  }
  async function restore(token){
    if(!token||!token.asset)return false;
    const guard=context();await ready;guard.check(true);
    if(token.kind==='fixed'&&token.presetId!==selectedId)throw fail('已经换了预设，这张参考图放不回原来的预设了');
    const rows=token.kind==='fixed'?fixed:temporary;
    const at=Math.max(0,Math.min(rows.length,Number(token.index)||0));
    const next=rows.slice();next.splice(at,0,display(token.asset));
    if(token.kind==='fixed'){
      const preset=root.PRESETS.presetById(selectedId);if(!preset)throw fail('当前预设不存在');
      const saved=await root.PRESETS.savePreset({...preset,refImages:next});guard.check(true);selectedSignature=JSON.stringify(saved.refImages);
      fixed.length=0;fixed.push(...next);
    }else{
      temporary.length=0;temporary.push(...next);
    }
    ready=Promise.resolve(fixed.slice());revision++;notify();return true;
  }
  // 排序：把第 index 张往前(-1)/往后(+1)挪一位。
  // ⚠ 只在【同一种】内部换位：fixed（预设自带）和 temporary（这次加的）不互相穿插 ——
  //   否则"这次的图"会被写进预设，"预设的图"会被当成临时的丢掉（L3 那次踩过的同类坑）。
  // ⚠ fixed 挪动要落盘（跟 remove 一样走 savePreset）；temporary 只在内存里，不同步。
  async function move(kind,index,dir){
    const step=Number(dir)<0?-1:1, rows=kind==='fixed'?fixed:temporary, target=index+step;
    if(!Number.isInteger(index)||!rows[index]||target<0||target>=rows.length)return false;
    const guard=context();await ready;guard.check(true);
    const next=rows.slice();
    const tmp=next[index];next[index]=next[target];next[target]=tmp;
    if(kind==='fixed'){
      const preset=root.PRESETS.presetById(selectedId);if(!preset)throw fail('当前预设不存在');
      const saved=await root.PRESETS.savePreset({...preset,refImages:next});guard.check(true);
      selectedSignature=JSON.stringify(saved.refImages);
      fixed.length=0;fixed.push(...next);
    }else{
      temporary.length=0;temporary.push(...next);
    }
    ready=Promise.resolve(fixed.slice());revision++;notify();return true;
  }
  // ⭐ 2026-10-14（用户要求"让参考图直接可以拖拽排序"）：
  //   把第 from 张拖到同组内的 to 位置（不是相邻换位，是任意距离）。
  //   ⚠⚠ 跟 move() 同一条铁律，一个字都不能松：**只允许在【同一种】内部挪**。
  //     fixed（预设自带）和 temporary（这次加的）不互相穿插 ——
  //     否则"这次的图"会被写进预设、"预设的图"会被当成临时的丢掉（L3 那次踩过的同类坑）。
  //     调用方（参考图卡的拖拽）负责不让跨组拖；这里再兜一道，越界直接返回 false，
  //     不抛错 —— 拖拽途中的中间态本来就会越界，抛错会把整个拖拽打断。
  //   ⚠ fixed 挪动要落盘（跟 move/remove 一样走 savePreset）；temporary 只在内存里。
  async function moveTo(kind,from,to){
    const rows=kind==='fixed'?fixed:temporary;
    const a=Number(from), b=Number(to);
    if(!Number.isInteger(a)||!Number.isInteger(b))return false;
    if(!rows[a]||b<0||b>=rows.length||a===b)return false;
    const guard=context();await ready;guard.check(true);
    const next=rows.slice();
    const moved=next.splice(a,1)[0];
    next.splice(b,0,moved);
    if(kind==='fixed'){
      const preset=root.PRESETS.presetById(selectedId);if(!preset)throw fail('当前预设不存在');
      const saved=await root.PRESETS.savePreset({...preset,refImages:next});guard.check(true);
      selectedSignature=JSON.stringify(saved.refImages);
      fixed.length=0;fixed.push(...next);
    }else{
      temporary.length=0;temporary.push(...next);
    }
    ready=Promise.resolve(fixed.slice());revision++;notify();return true;
  }
  async function saveFixed(){
    const guard=context();await ready;guard.check(true);
    const preset=root.PRESETS.presetById(selectedId);if(!preset)throw fail('请先选择或保存一个预设');
    const saved=await root.PRESETS.savePreset({...preset,refImages:fixed.concat(temporary)});guard.check(true);
    selectedSignature=JSON.stringify(saved.refImages);
    fixed.push(...temporary);temporary=[];ready=Promise.resolve(fixed.slice());revision++;notify();return saved;
  }
  // R3（用户 2026-10-02 定：「弹窗开着时才算数」）：弹窗一关就清掉临时参考图。预设自己的图不动。
  function clear(){
    if(!temporary.length)return;
    release(temporary);temporary=[];revision++;notify();
  }
  // 弹窗「全部清空」：这一次一张参考图都不带（用户 2026-10-02 定：【只清这次，不动预设】）。
  //   ⚠ 预设里存的图不删 —— 只是这一次不用；重新选这个预设又会出现。
  //   ⚠ ready 也要换成空的：capture() 读的是 ready 里的那份，只清数组的话生成时预设的图还会被带上。
  function clearAll(){
    if(!fixed.length&&!temporary.length)return;
    release(fixed);release(temporary);fixed=[];temporary=[];ready=Promise.resolve([]);revision++;notify();
  }
  function view(kind,index){const row=(kind==='fixed'?fixed:temporary)[index];if(!row)return '';if(!row.viewUrl)row.viewUrl=URL.createObjectURL(row.view);return row.viewUrl;}
  // state() 新增三个字段（C01 §5.1，只加不改旧字段）：
  //   limit   = 闸门说的最多几张（⚠ 不含原图）
  //   blocked = 现在还能不能再加
  //   reason  = 不能加时的人话原因（比如老预设本来就存了 8 张）
  function state(){
    const verdict=gateCheck(fixed.length+temporary.length,sizeOf([...fixed,...temporary]),1,0);
    return {fixed:fixed.map(row=>({name:row.name,thumbUrl:row.thumbUrl})),temporary:temporary.map(row=>({name:row.name,thumbUrl:row.thumbUrl})),selectedId,loading:loading||!!mutation,error:failure?String(failure.message||failure):'',
      limit:verdict.max,blocked:!verdict.allowed,reason:verdict.reason||''};
  }
  // L4：换账号 → 全清（临时图也清，图是账号隔离的）。⚠ 不能只调 select(null)：R5 之后 select(null) 会【保留】临时图。
  root.addEventListener?.('wheelchair:storage-context',()=>{epoch++;release(temporary);temporary=[];select(null);});
  root.V7PresetReferences={select,capture,payload,append:(...args)=>mutate(()=>append(...args)),remove:(...args)=>mutate(()=>remove(...args)),restore:(...args)=>mutate(()=>restore(...args)),move:(...args)=>mutate(()=>move(...args)),moveTo:(...args)=>mutate(()=>moveTo(...args)),saveFixed:()=>mutate(saveFixed),clear,clearAll,view,state,context,report,configure(fn){change=typeof fn==='function'?fn:()=>{};}};
})(window);
