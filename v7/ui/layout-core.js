(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.V7LayoutCore=api;
})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  // ⚠ 2026-10-14：末尾的 ['tutorial','使用教程'] 删掉了 —— 那张卡整张已删（用户定：教程要重做）。
  //   ⚠ 这张表同时决定"布局里能出现哪些卡"和"卡片显示名"，删了之后
  //     旧布局存档里的 tutorial 会被当成"无法识别"⇒ 布局管理器会报错或丢那一格。
  //     重做教程卡时加回这一行末尾，见 docs/217。
  const definitions=[['generation','生成'],['presets','预设'],['settings','设置'],['engines','外挂能力'],['history','历史'],['projects','项目'],['assistant','助手'],['debug','调试'],['feedback','问题反馈'],['community','社区']];
  // ⭐ 2026-10-18 深夜：末尾加了「问题反馈」（第 9 张，默认显示）。老布局存档里没有它 → cards() 末尾那句会自动补上（hidden:false）。
  // ⭐ 2026-10-20：末尾加了「社区」（第 10 张，默认显示），老存档同上自动补。⚠ 不在这张表里的卡，布局既藏不掉也排不了。
  const requiredIds=['generation','presets','settings','engines','history'];
  const appearanceKeys=['opacity','blur','themeCardBg','themeText','themeAccent','themeNoTint'];
  // ⚠⚠⚠ 2026-10-14：这张表记【已经下线、但老布局存档里可能还留着】的卡 id。
  //   为什么需要它：删掉一张卡（比如「使用教程」）之后，用户机器上的旧布局存档里
  //   还写着那张卡 ⇒ 不认它就报错、整个界面打不开（我删教程时就踩了，见下面的注释）。
  //   所以 cards() 会把【这张表里的】卡静默丢掉（等于平滑降级）。
  //
  //   ⚠⚠ 但不能对所有"不认识的 id"都宽容 —— 那会把真正的坏数据（手改坏的存档、
  //     版本不匹配的导出包）一起吞掉，用户看到的会是"布局莫名其妙少一张"而不是报错。
  //     所以：**只 tolerate 这张表里点名列出的**，其余不认识的照旧报错。
  //   ⚠ 重做某张卡时，把它的 id 从这里【删掉】（它又变成认识的卡了）。
  const retiredIds=['tutorial'];
  const fail=message=>{throw new Error(message);};
  function cards(input){
    // ⚠⚠⚠ 2026-10-14 修（删「使用教程」卡时踩出来的真 bug，整个界面都打不开）：
    //   原来第一句是 `…||input.length>definitions.length`，最后一句会
    //   「definitions 里有、input 里没有的，自动补上」—— 也就是【少了能补，
    //   多了就炸】。我删掉 tutorial 的定义之后，旧布局存档里还留着那张卡 ⇒
    //   input 9 项 > definitions 8 项 ⇒ 抛「布局必须包含原有核心卡」⇒
    //   8 张主卡全打不开（实测：连设置卡都进不去）。
    //   ⇒ 改成：先把【retiredIds 里点名列出的下线卡】丢掉（跟"自动补"对称），再校验。
    //   ⚠⚠ 第一版我写成了"凡是不认识的 id 都丢掉"—— 那是错的：
    //     会把手改坏的存档也一起吞掉（测试里那条 unknown id 就再也不报错了）。
    //     现在只丢 retiredIds 里的，别的照旧报错。
    if(!Array.isArray(input))fail('布局必须包含原有核心卡');
    // ① 先把"彻底不认识的 id"挑出来报错（不宽容 —— 那是坏数据）
    //    ② 再把 retiredIds 里的下线卡丢掉（宽容 —— 那是老存档里的历史残留）
    const isKnown=id=>definitions.some(([id2])=>id2===id);
    if(input.some(row=>row&&typeof row.id==='string'&&!isKnown(row.id)&&retiredIds.indexOf(row.id)<0))fail('布局卡片编号重复或无法识别');
    const known=input.filter(row=>row&&isKnown(row.id));
    if(known.length<requiredIds.length||known.length>definitions.length)fail('布局必须包含原有核心卡');
    const seen=new Set();
    const result=known.map(row=>{
      if(!row||!definitions.some(([id])=>id===row.id)||seen.has(row.id))fail('布局卡片编号重复或无法识别');
      seen.add(row.id);
      if(typeof row.name!=='string'||!row.name.trim()||row.name.length>40||typeof row.hidden!=='boolean')fail('卡片名称或可见性无效');
      return {id:row.id,name:row.name.trim(),hidden:row.id==='settings'?false:row.hidden};
    });
    if(requiredIds.some(id=>!seen.has(id)))fail('布局缺少核心卡');
    // Version 1 exports and saved snapshots retain their order and names.
    for(const [id,name] of definitions)if(!seen.has(id))result.push({id,name,hidden:id==='debug'});
    return result;
  }
  function appearance(input){
    const out={};if(!input||typeof input!=='object')return out;
    for(const key of appearanceKeys){
      if(!(key in input))continue;
      const value=input[key];
      if(key==='themeNoTint'){if(typeof value!=='boolean')fail('主题开关无效');out[key]=value;}
      else if(key==='opacity'||key==='blur'){
        const n=Number(value),min=key==='opacity'?35:0,max=key==='opacity'?100:100;
        if(!Number.isFinite(n)||n<min||n>max)fail('外观数值超出范围');out[key]=String(n);
      }else{if(typeof value!=='string'||!/^$|^#[0-9a-f]{6}$/i.test(value))fail('主题颜色格式无效');out[key]=value;}
    }return out;
  }
  function silhouette(input){
    if(!input)return null;
    if(!Array.isArray(input.assets)||input.assets.length>1000)fail('剪影布局条目过多或格式无效');
    const aspect=Number(input.canvasAspect);if(!Number.isFinite(aspect)||aspect<=.05||aspect>=20)fail('剪影画布比例无效');
    const seen=new Set(),assets=input.assets.map(row=>{
      if(!row||typeof row.id!=='string'||!row.id||row.id.length>160||seen.has(row.id))fail('剪影编号无效或重复');
      seen.add(row.id);const out={id:row.id};
      if(typeof row.name!=='string'||row.name.length>200)fail('剪影名称无效');out.name=row.name;
      for(const key of ['x','y','w','h','z']){
        const n=Number(row[key]);if(!Number.isFinite(n)||Math.abs(n)>100000||(key==='w'||key==='h')&&n<=0)fail('剪影位置或尺寸无效');out[key]=n;
      }
      for(const key of ['hidden','locked'])if(row[key]!==undefined){if(typeof row[key]!=='boolean')fail('剪影可见性无效');out[key]=row[key];}
      return out;
    });return {canvasAspect:aspect,assets};
  }
  function normalize(input){
    if(!input||input.schema!=='wheelchair-layout'||input.version!==1)fail('此文件不是支持的 V7 布局文件');
    const list=cards(input.cards),visible=list.filter(row=>!row.hidden);
    const out={schema:'wheelchair-layout',version:1,cards:list,active:visible.some(row=>row.id===input.active)?input.active:visible[0]?.id||'',appearance:appearance(input.appearance),silhouette:silhouette(input.silhouette)};
    const placement=freePlacement(input.freePlacement);
    if(placement)out.freePlacement=placement;
    return out;
  }
  // ⭐ 2026-10-21（docs/261 U6，用户：「我的布局」点了应用没效果）：开着自由摆放时存布局，顺手存每张卡在屏幕上的位置。
  //   这里只看大样子（细的校验在应用时由 free-layout-core 做）；不像样的直接丢掉 —— 旧快照没有这一项也照常能用。
  //   ⚠ 只在有这一项时才放进结果：没有就不出现这个键（老布局导出 / 比对一个字都不变）。
  function freePlacement(input){
    if(!input||typeof input!=='object'||!input.layout||typeof input.layout!=='object'||!Array.isArray(input.layout.units))return null;
    let text;try{text=JSON.stringify(input);}catch(_){return null;}
    if(text.length>256*1024)return null;
    const value=JSON.parse(text);
    return {layout:value.layout,collapsed:Array.isArray(value.collapsed)?value.collapsed.filter(id=>typeof id==='string'):[]};
  }
  function defaults(){return normalize({schema:'wheelchair-layout',version:1,cards:definitions.map(([id,name])=>({id,name,hidden:id==='debug'})),active:'generation'});}
  function orderedIndices(layout,domIds){return layout.cards.filter(row=>!row.hidden).map(row=>domIds.indexOf(row.id)).filter(i=>i>=0);}
  function parse(text){if(typeof text!=='string'||text.length>1024*1024)fail('布局文件不能超过 1 MB');return normalize(JSON.parse(text));}
  return {definitions,appearanceKeys,cards,appearance,silhouette,normalize,defaults,orderedIndices,parse};
});
