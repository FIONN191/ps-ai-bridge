(function(root){
  'use strict';
  const failure=(code,message)=>Object.assign(new Error(message),{code});
  const clone=value=>JSON.parse(JSON.stringify(value));
  const uid=prefix=>prefix+'-'+crypto.randomUUID();
  const types=new Set(['image','generate','compose','output','prompt','promptcat','crop','pad','resize','pscapture','psregion'].map(kind=>'wheelchair/'+kind));
  const nodeTitles={image:'图片来源',generate:'预设生成',compose:'拼接',output:'输出',prompt:'提示词',promptcat:'拼词',crop:'裁剪',pad:'扩边',resize:'缩放',pscapture:'PS 抓取',psregion:'PS 区域'};
  function validateGraph(value){
    if(!value||!Array.isArray(value.nodes)||value.nodes.length>256||!Array.isArray(value.links)||value.links.length>1024)throw failure('CANVAS_GRAPH_INVALID','幕布数据无效或节点过多');
    const graph={nodes:clone(value.nodes),links:clone(value.links),groups:[],config:{},extra:{},version:.4};
    const ids=new Set();
    for(const node of graph.nodes){
      if(!types.has(node.type)||!Number.isSafeInteger(node.id)||ids.has(node.id))throw failure('CANVAS_GRAPH_INVALID','幕布包含不支持的节点');
      ids.add(node.id);
      if(JSON.stringify(node.properties||{}).length>131072)throw failure('CANVAS_GRAPH_INVALID','单个节点内容过大');
      const incoming=node.inputs||[];
      if(!Array.isArray(incoming)||!Array.isArray(node.outputs)||incoming.length>32||node.outputs.length!==1)throw failure('CANVAS_GRAPH_INVALID','幕布节点端口数量无效');
      const position=Array.isArray(node.pos)?node.pos:[0,0];if(position.length!==2||!position.every(n=>Number.isFinite(n)&&Math.abs(n)<=1000000))throw failure('CANVAS_GRAPH_INVALID','幕布节点位置无效');
      const allowed=['revision','status','resultAssetIds','selectedAssetId','assetId','parameters','batch','text','textResult','prompt','sep','rect','padRatio','padColor','longEdge','layout','opacity','region','destination','presetId','migrationNote','model','channel','error','source','executionParameters','lastRun'];
      const properties={};for(const key of allowed)if(Object.prototype.hasOwnProperty.call(node.properties||{},key))properties[key]=node.properties[key];
      if(properties.resultAssetIds!=null&&(!Array.isArray(properties.resultAssetIds)||properties.resultAssetIds.length>128||!properties.resultAssetIds.every(id=>typeof id==='string')))throw failure('CANVAS_GRAPH_INVALID','幕布结果引用无效');
      properties.parameters=properties.parameters&&typeof properties.parameters==='object'&&!Array.isArray(properties.parameters)?properties.parameters:{};
      const inputs=incoming.map(input=>({name:String(input.name||'输入').slice(0,64),type:input.type,link:null,optional:input.optional===true}));
      const outputs=node.outputs.map(output=>({name:String(output.name||'输出').slice(0,64),type:output.type,links:[]}));
      if([...inputs,...outputs].some(port=>!['image','prompt'].includes(port.type)))throw failure('CANVAS_GRAPH_INVALID','幕布端口类型无效');
      const canonical={id:node.id,type:node.type,title:String(node.title||nodeTitles[node.type.replace('wheelchair/','')]).slice(0,120),pos:position,size:[Math.max(232,Math.min(1024,Number(node.size?.[0])||232)),Math.max(208,inputs.length*20+172,Math.min(2048,Number(node.size?.[1])||208))],flags:{collapsed:node.flags?.collapsed===true},properties,inputs,outputs};
      for(const key of Object.keys(node))delete node[key];Object.assign(node,canonical);
      if(node.properties&&/^(running|queued)$/.test(node.properties.status)){node.properties.status='interrupted';node.properties.error='上次运行被中断，未自动重试';}
    }
    const linkIds=new Set(),targets=new Set();
    for(const link of graph.links){
      if(!Array.isArray(link)||link.length<6||!Number.isSafeInteger(link[0])||linkIds.has(link[0])||!ids.has(link[1])||!ids.has(link[3]))throw failure('CANVAS_GRAPH_INVALID','幕布连接指向不存在的节点');
      const from=graph.nodes.find(n=>n.id===link[1]),to=graph.nodes.find(n=>n.id===link[3]),output=from.outputs?.[link[2]],input=to.inputs?.[link[4]],target=link[3]+':'+link[4];
      if(!output||!input||input.type!==output.type||!['image','prompt'].includes(input.type)||targets.has(target))throw failure('CANVAS_GRAPH_INVALID','幕布端口类型或连线无效');
      linkIds.add(link[0]);targets.add(target);
    }
    // Rebuild socket references from the canonical link table. Imported stale
    // links must never point at an unrelated node after LiteGraph.configure.
    for(const node of graph.nodes){for(const input of node.inputs||[])input.link=null;for(const output of node.outputs||[])output.links=[];}
    for(const link of graph.links){graph.nodes.find(n=>n.id===link[1]).outputs[link[2]].links.push(link[0]);graph.nodes.find(n=>n.id===link[3]).inputs[link[4]].link=link[0];}
    graph.last_node_id=Math.max(0,...ids);graph.last_link_id=Math.max(0,...linkIds);
    return graph;
  }
  function migrateV6(bundle){
    if(bundle?._wcCanvas!==1||!bundle.nodes||Array.isArray(bundle.nodes)||!Array.isArray(bundle.wires)||Object.keys(bundle.nodes).length>256||bundle.wires.length>1024)throw failure('CANVAS_GRAPH_INVALID','这不是可识别的 V6 幕布工作流');
    const graph={nodes:[],links:[],groups:[],config:{},extra:{},version:.4},assets=[],ids=new Map(),warnings=[];
    const titles={image:'图片来源',generate:'预设生成',compose:'拼接',output:'输出',prompt:'提示词',promptcat:'拼词',crop:'裁剪',pad:'扩边',resize:'缩放',pscapture:'PS 抓取',psregion:'PS 区域'};
    for(const [key,old] of Object.entries(bundle.nodes)){
      const type=old.type==='combine'?'compose':['tops','save'].includes(old.type)?'output':old.type;
      if(!types.has('wheelchair/'+type))throw failure('CANVAS_GRAPH_INVALID','V6 工作流包含无法迁移的节点：'+old.type);
      const id=ids.size+1;ids.set(key,id);const textual=['prompt','promptcat'].includes(type);
      const p={revision:0,status:'idle',resultAssetIds:[],selectedAssetId:'',parameters:{},text:String(old.text||''),prompt:'',sep:old.sep??', ',batch:Math.max(1,Math.min(18,Number(old.count)||1)),rect:old.rect||{x:0,y:0,w:1,h:1},padRatio:old.padRatio||'1:1',padColor:old.padColor||'transparent',longEdge:Number(old.longEdge)||1024,layout:{h:'horizontal',v:'vertical',grid:'grid'}[old.layout]||'horizontal'};
      if(type==='generate'){p.presetId='';p.migrationNote='V6 渠道 '+String(old.provider||'')+' / '+String(old.model||'')+'：请选择 V7 预设后运行';warnings.push('生成节点需要绑定 V7 预设；未导入旧账号或密钥');}
      if(type==='psregion'){p.region=null;warnings.push('V6 导出没有可靠区域绑定；请重新记录 Photoshop 区域');}
      if(old.type==='tops')p.destination='photoshop';if(old.type==='save')p.destination='file';
      const inputs=[];
      if(!['image','prompt','promptcat','pscapture','psregion'].includes(type))inputs.push({name:'图片',type:'image',link:null});
      if(type==='generate')inputs.push({name:'提示词',type:'prompt',link:null,optional:true});
      graph.nodes.push({id,type:'wheelchair/'+type,title:String(old.name||titles[type]),pos:[Number(old.x)||0,Number(old.y)||0],size:[232,208],flags:{},properties:p,inputs,outputs:[{name:textual?'提示词':'图片',type:textual?'prompt':'image',links:[]}]});
      if(old.imgB64&&type==='image'){const assetId='v6-'+id;p.assetId=assetId;p.status='done';assets.push({id:assetId,mime:old.mime||'image/png',base64:old.imgB64,source:{kind:'v6',name:old.name||'V6 素材'}});}
    }
    for(const wire of bundle.wires){
      const from=graph.nodes.find(n=>n.id===ids.get(String(wire.from?.node))),to=graph.nodes.find(n=>n.id===ids.get(String(wire.to?.node)));
      if(!from||!to)throw failure('CANVAS_GRAPH_INVALID','V6 工作流包含失效连线');
      const type=from.outputs[0].type;let slot;
      if(type==='prompt'&&to.type==='wheelchair/generate')slot=1;
      else if((to.type==='wheelchair/promptcat'&&type==='prompt')||(['wheelchair/compose','wheelchair/generate'].includes(to.type)&&type==='image')){
        slot=to.inputs.findIndex(input=>input.type===type&&input.link==null);
        if(slot<0){slot=to.inputs.length;to.inputs.push({name:type==='prompt'?'提示词 '+(slot+1):'图片 '+(slot+1),type,optional:to.type==='wheelchair/generate',link:null});}
      }else slot=0;
      if(!to.inputs[slot]||to.inputs[slot].type!==type||to.inputs[slot].link!=null)throw failure('CANVAS_GRAPH_INVALID','V6 工作流的输入类型不匹配');
      const id=graph.links.length+1;to.inputs[slot].link=id;graph.links.push([id,from.id,0,to.id,slot,type]);from.outputs[0].links.push(id);
    }
    for(const node of graph.nodes){if(node.type==='wheelchair/promptcat'&&!node.inputs.length)node.inputs.push({name:'提示词',type:'prompt',link:null,optional:true});}
    return {format:'wheelchair.canvas',version:1,name:'V6 导入幕布',graph:validateGraph(graph),assets,warnings:[...new Set(warnings)]};
  }
  function create(options={}){
    const name=options.name||(root.WHEELCHAIR_STORAGE?root.WHEELCHAIR_STORAGE.dbName('canvas.v1'):'wheelchair.anonymous.canvas.v1');
    const loaded=new Map();let database;
    const open=()=>database||(database=new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,1);
      request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('boards',{keyPath:'id'});db.createObjectStore('assets',{keyPath:'id'});};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    }));
    async function transaction(store,mode,operation){
      const db=await open();return new Promise((resolve,reject)=>{
        const tx=db.transaction(store,mode),request=operation(tx.objectStore(store));let result;
        request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||failure('CANVAS_SAVE_FAILED','本机保存中断'));
      });
    }
    async function save(board){
      const row={id:String(board.id||uid('board')),name:String(board.name||'未命名幕布').slice(0,120),graph:validateGraph(board.graph),createdAt:board.createdAt||Date.now(),updatedAt:Date.now()};
      await transaction('boards','readwrite',store=>store.put(row));return row;
    }
    async function load(id){const row=await transaction('boards','readonly',store=>store.get(id));if(row)row.graph=validateGraph(row.graph);return row||null;}
    async function list(){return (await transaction('boards','readonly',store=>store.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt).map(({id,name,updatedAt})=>({id,name,updatedAt}));}
    async function importBlob(blob,source={}){
      if(!(blob instanceof Blob)||!/^image\/(png|jpeg|webp|gif|bmp)$/.test(blob.type)||!blob.size||blob.size>64*1024*1024)throw failure('CANVAS_IMAGE_INVALID','请选择 64 MB 以内的 PNG、JPEG、WebP、GIF 或 BMP 图片');
      const bitmap=await createImageBitmap(blob);let thumb;
      try{
        if(bitmap.width*bitmap.height>100000000)throw failure('CANVAS_IMAGE_INVALID','图片像素过大，请先缩小图片');
        const scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));
        const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
        canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
        thumb=await canvas.convertToBlob({type:'image/jpeg',quality:0.78});
        const row={id:uid('asset'),mime:blob.type,width:bitmap.width,height:bitmap.height,full:blob,thumb,source:safeSource(source),createdAt:Date.now()};
        await transaction('assets','readwrite',store=>store.put(row));return metadata(row);
      }finally{bitmap.close();}
    }
    function safeSource(source){
      const clean={kind:String(source.kind||'file').slice(0,40),name:String(source.name||'').slice(0,200),importedAt:source.importedAt||new Date().toISOString()};
      for(const field of ['pageUrl','imageUrl'])if(source[field]){try{const url=new URL(source[field]);if(/^https?:$/.test(url.protocol)){url.username='';url.password='';clean[field]=url.href;}}catch(_){}}
      return clean;
    }
    const metadata=row=>({id:row.id,mime:row.mime,width:row.width,height:row.height,source:row.source,createdAt:row.createdAt});
    async function asset(id){const row=await transaction('assets','readonly',store=>store.get(id));if(!row)throw failure('CANVAS_IMAGE_MISSING','幕布素材已不存在，请重新导入');return row;}
    async function image(id){
      if(loaded.has(id)&&root.IMG.has(loaded.get(id)))return loaded.get(id);
      const row=await asset(id);
      const imageId=root.IMG.putFromCache(new Uint8Array(await row.thumb.arrayBuffer()),row.mime,async()=>new Uint8Array(await (await asset(id)).full.arrayBuffer()));
      loaded.set(id,imageId);return imageId;
    }
    async function importImageId(imageId,source={},mime='image/png'){
      const dimensions=root.IMG.size(imageId),bytes=await root.IMG.fullBytes(imageId),thumb=await root.IMG.thumbBytes(imageId);
      if(!dimensions.w||!dimensions.h)return importBlob(new Blob([bytes],{type:mime}),source);
      const row={id:uid('asset'),mime,width:dimensions.w,height:dimensions.h,full:new Blob([bytes],{type:mime}),thumb:new Blob([thumb],{type:'image/jpeg'}),source:safeSource(source),createdAt:Date.now()};
      await transaction('assets','readwrite',store=>store.put(row));return metadata(row);
    }
    async function remove(id){
      await transaction('boards','readwrite',store=>store.delete(id));
      const boards=await transaction('boards','readonly',store=>store.getAll());
      const used=new Set();for(const board of boards)for(const node of board.graph.nodes||[]){const p=node.properties||{};[p.assetId,p.selectedAssetId,...(p.resultAssetIds||[])].filter(Boolean).forEach(id=>used.add(id));}
      const assets=await transaction('assets','readonly',store=>store.getAll());
      for(const item of assets)if(!used.has(item.id)){if(loaded.has(item.id)){root.IMG.release(loaded.get(item.id));loaded.delete(item.id);}await transaction('assets','readwrite',store=>store.delete(item.id));}
    }
    async function exportBundle(board){
      const graph=validateGraph(board.graph),ids=new Set(),assets=[];let bytes=0;
      for(const node of graph.nodes){const p=node.properties||{};[p.assetId,p.selectedAssetId,...p.resultAssetIds||[]].filter(Boolean).forEach(id=>ids.add(id));}
      for(const id of ids){const row=await asset(id);bytes+=row.full.size;if(bytes>128*1024*1024)throw failure('CANVAS_SAVE_FAILED','便携幕布包超过 128 MB，请减少结果图片后导出');
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(row.full);});
        assets.push({id,mime:row.mime,base64,source:safeSource(row.source)});
      }
      return {format:'wheelchair.canvas',version:1,name:String(board.name||'幕布'),graph,assets};
    }
    async function importBundle(value){
      const bundle=value?._wcCanvas===1?migrateV6(value):value;
      if(!bundle||bundle.format!=='wheelchair.canvas'||bundle.version!==1||!Array.isArray(bundle.assets)||bundle.assets.length>2048)throw failure('CANVAS_GRAPH_INVALID','请选择 V6 或 V7 幕布导出的 JSON 文件');
      const graph=validateGraph(bundle.graph),ids=new Set(),decoded=[];let total=0;
      for(const item of bundle.assets){
        if(!item||typeof item.id!=='string'||ids.has(item.id)||!/^image\/(png|jpeg|webp|gif|bmp)$/.test(item.mime)||typeof item.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))throw failure('CANVAS_IMAGE_INVALID','工作流包含无效或重复素材');
        total+=item.base64.length;if(total>180*1024*1024)throw failure('CANVAS_IMAGE_INVALID','便携幕布包过大');ids.add(item.id);
        const raw=atob(item.base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);decoded.push({item,blob:new Blob([bytes],{type:item.mime})});
      }
      for(const node of graph.nodes){const p=node.properties||{};for(const id of [p.assetId,p.selectedAssetId,...p.resultAssetIds||[]].filter(Boolean))if(!ids.has(id))throw failure('CANVAS_IMAGE_MISSING','工作流缺少随包素材，请从原幕布重新导出');}
      const map=new Map();for(const {item,blob} of decoded)map.set(item.id,(await importBlob(blob,item.source||{})).id);
      for(const node of graph.nodes){const p=node.properties||{};if(p.assetId)p.assetId=map.get(p.assetId);if(p.selectedAssetId)p.selectedAssetId=map.get(p.selectedAssetId);p.resultAssetIds=(p.resultAssetIds||[]).map(id=>map.get(id));}
      const board=await save({id:uid('board'),name:String(bundle.name||'导入幕布'),graph});return {board,warnings:bundle.warnings||[]};
    }
    function release(){for(const id of loaded.values())root.IMG.release(id);loaded.clear();}
    return {name,save,load,list,importBlob,importImageId,image,asset,remove,release,uid,validateGraph,exportBundle,importBundle};
  }
  root.V7CanvasStore={create,validateGraph,migrateV6};
})(window);
