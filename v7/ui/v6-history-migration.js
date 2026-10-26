(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.V7V6HistoryMigration=api;
})(typeof window==='undefined'?globalThis:window,function(root){
  'use strict';
  const MAX_IMAGE=64*1024*1024,MAX_INDEX=32*1024*1024,MAX_ITEMS=10000,BATCH=18;
  let epoch=0,busy=false;
  root.addEventListener?.('wheelchair:storage-context',()=>{epoch++;});
  const text=(value,max=20000)=>String(value??'').slice(0,max);
  const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
  async function digest(value){const bytes=new TextEncoder().encode(stable(value));return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
  function sourceName(value){
    const name=text(value,512);
    if(!name||/[\\/:\x00-\x1f]/.test(name)||name==='.'||name==='..')throw new Error('V6 历史图片路径无效，请检查旧目录中的索引。');
    return name;
  }
  function forgeSnapshot(value){
    const out={};
    for(const key of ['model','lora','loraWeight','step','steps','resolution','imageCount','positivePrompt','negativePrompt','denoisingStrength','cfgScale','seed','sampler','scheduler']){
      const v=value?.[key];if(['string','number','boolean'].includes(typeof v))out[key]=typeof v==='string'?v.slice(0,20000):v;
    }
    return out;
  }
  async function prepare(files){
    if(!files?.length||files.length>60000)throw new Error('请选择一个 V6 recycle_bin 文件夹，目录文件数量不能超过 60000。');
    const paths=new Map();
    for(const file of files){
      const path=String(file.webkitRelativePath||file.name).replace(/\\/g,'/');
      if(path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..')||paths.has(path))throw new Error('所选目录存在无效或重复文件路径。');
      paths.set(path,file);
    }
    const candidates=Array.from(paths.keys()).filter(p=>/(?:^|\/)index\.json(?:\.bak)?$/i.test(p));
    const folders=Array.from(new Set(candidates.map(p=>p.slice(0,p.lastIndexOf('/')+1))));
    if(folders.length!==1)throw new Error('请选择包含 index.json 的单个 recycle_bin 文件夹。');
    const folder=folders[0];let items,indexName='',mainError='';
    for(const name of ['index.json','index.json.bak']){
      const file=paths.get(folder+name);if(!file)continue;
      try{
        if(file.size>MAX_INDEX)throw new Error('索引超过 32 MB');
        const parsed=JSON.parse(await file.text());
        if(!Array.isArray(parsed)||parsed.length>MAX_ITEMS)throw new Error('索引须为不超过 10000 条记录的数组');
        items=parsed;indexName=name;break;
      }catch(error){mainError=error.message;}
    }
    if(!items)throw new Error('V6 主索引及备份均不可用：'+mainError);
    const grouped=new Map(),issues=[];
    for(let index=0;index<items.length;index++){
      const item=items[index];
      if(!item||typeof item!=='object'||Array.isArray(item)||!item.id){issues.push('第 '+(index+1)+' 条缺少任务 ID，未导入');continue;}
      const imageName=item.imagePath?sourceName(item.imagePath):'';
      const file=imageName?paths.get(folder+imageName):null;
      const record={id:text(item.id,256),batchId:text(item.batchId||item.id,256),createdAt:Number(item.createdAt)||0,
        status:text(item.status,40),workflow:text(item.workflow,80),prompt:item.promptProtected?'':text(item.prompt),promptProtected:!!item.promptProtected,
        model:text(item.model,200),provider:text(item.provider,100),size:text(item.size,40),aspectRatio:text(item.aspectRatio,40),
        presetTitle:text(item.presetTitle,240),presetKind:text(item.presetKind,80),error:text(item.error,2000),
        docName:text(item.context?.docName,240),forgeSnapshot:item.promptProtected?{}:forgeSnapshot(item.forgeSnapshot),imageName,
        file:file||null,fileSize:file?.size||0,fileModified:file?.lastModified||0};
      const key=stable([record.batchId,record.docName]);
      if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(record);
    }
    const groups=[];
    for(const records of grouped.values()){
      records.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
      for(let offset=0;offset<records.length;offset+=BATCH){
        const entries=records.slice(offset,offset+BATCH);
        const fingerprint=await digest(entries.map(({file,...record})=>record));
        groups.push({fingerprint,runId:'v6-'+fingerprint,entries,missing:entries.filter(e=>e.imageName&&!e.file).map(e=>e.imageName)});
      }
    }
    return {groups,issues,indexName,usedBackup:indexName.endsWith('.bak'),count:items.length,imageCount:groups.reduce((n,g)=>n+g.entries.filter(e=>e.file).length,0)};
  }
  async function decodeImage(file){
    if(!file?.size||file.size>MAX_IMAGE)throw new Error('单张历史图片须小于 64 MB。');
    const bitmap=await root.createImageBitmap(file);
    try{
      if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>100000000)throw new Error('历史图片尺寸超过 1 亿像素。');
      const canvas=root.document.createElement('canvas'),scale=Math.min(1,200/Math.max(bitmap.width,bitmap.height));
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const thumb=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
      if(!thumb)throw new Error('历史缩略图生成失败');
      // The V6 archive stores original encoded bytes under .png, as does cache.v1.
      return {full:new Uint8Array(await file.arrayBuffer()),thumb:new Uint8Array(await thumb.arrayBuffer())};
    }finally{bitmap.close();}
  }
  async function importPlan(plan,host){
    if(busy)throw new Error('已有 V6 历史正在导入。');
    const scope=host.scope(),startedEpoch=epoch,report={version:1,namespaceId:scope,createdAt:Date.now(),imported:[],skipped:[],failed:[],issues:plan.issues.slice(),usedBackup:plan.usedBackup};
    const current=()=>host.scope()===scope&&epoch===startedEpoch&&!host.cancelled?.();
    const check=()=>{if(!current())throw new Error('导入已停止：账号已切换或已取消。');};
    const write=async action=>{check();const result=await action();check();if(!result?.ok)throw new Error(result?.error||'历史缓存写入失败');};
    const capacity=host.withCapacity||((_bytes,action)=>action());
    busy=true;
    try{
      const listed=await host.cache.list();check();
      if(!listed?.ok||!Array.isArray(listed.runs))throw new Error('当前缓存读取失败，尚未开始导入。');
      const existing=new Map(listed.runs.map(r=>[r.project+'/'+r.runId,r]));
      for(const group of plan.groups){
        check();const first=group.entries[0],project=host.project('v6-history-'+(await digest(first.docName)).slice(0,20)),runId=group.runId;
        check();const before=existing.get(project+'/'+runId);
        if(before){
          if(before.meta?.namespaceId===scope&&before.meta?.migration?.fingerprint===group.fingerprint)report.skipped.push(runId);
          else report.failed.push({runId,error:'缓存记录标识冲突，未覆盖现有记录'});
          host.progress?.(report);continue;
        }
        try{
          if(group.missing.length)throw new Error('缺少原图：'+group.missing.join('、'));
          const shots=[];
          for(let index=0;index<group.entries.length;index++){
            check();const entry=group.entries[index];
            if(entry.file){
              const image=await (host.decode||decodeImage)(entry.file);check();
              await capacity(image.full.byteLength+image.thumb.byteLength,async()=>{
                await write(()=>host.cache.writeFile(project,runId,'output_'+(index+1)+'.png',image.full));
                await write(()=>host.cache.writeFile(project,runId,'thumb_'+(index+1)+'.jpg',image.thumb));
              });
            }
            shots.push({index,done:!!entry.file,hasImage:!!entry.file,restoreState:entry.file?'done':'failed',error:entry.file?'':entry.error||'旧记录没有结果图片',legacyId:entry.id});
          }
          const meta={version:1,repository:'cache.v1',namespaceId:scope,project,runId,taskId:runId,kind:'generation',inTaskbar:false,
            label:first.presetTitle||'V6 历史',presetTitle:first.presetTitle,provider:first.provider,model:first.model,size:first.size,aspectRatio:first.aspectRatio,
            prompt:first.prompt,promptProtected:first.promptProtected,batch:shots.length,status:shots.some(s=>s.hasImage)?'done':'failed',pct:100,startedAt:first.createdAt,savedAt:Date.now(),
            sourceDocId:null,sourceDocName:first.docName||'V6 历史',captureSnapshot:null,psLayerIds:[],psLayerByShot:{},psDocId:null,psGroupId:null,hasInput:false,shots,
            migration:{source:'v6',fingerprint:group.fingerprint,indexName:plan.indexName,importedAt:Date.now(),returnBlocked:true,legacyBatchId:first.batchId,legacyForgeParameters:first.forgeSnapshot,
              entries:group.entries.map(({file,...record})=>record)}};
          await capacity(new TextEncoder().encode(JSON.stringify(meta)).byteLength+first.prompt.length*3,async()=>{
            await write(()=>host.cache.writeFile(project,runId,'prompt.txt',new TextEncoder().encode(first.prompt)));
            // Only a complete group gets metadata and becomes visible in cache.v1.
            await write(()=>host.cache.writeMeta(project,runId,meta));
          });
          report.imported.push(runId);existing.set(project+'/'+runId,{meta});
        }catch(error){if(!current())throw error;report.failed.push({runId,error:text(error.message,2000)});}
        host.progress?.(report);
      }
      check();return report;
    }finally{busy=false;}
  }
  function mount(container,host){
    const scope=host.scope(),startedEpoch=epoch;let plan=null,stopped=false,running=false;
    const current=()=>container.isConnected&&host.scope()===scope&&epoch===startedEpoch&&host.active();
    container.innerHTML='<div class="settings-actions"><button class="settings-btn" data-v6-history-pick>选择 V6 历史文件夹</button><input type="file" webkitdirectory multiple hidden data-v6-history-files><button class="settings-btn" data-v6-history-import disabled>导入历史</button><button class="settings-btn" data-v6-history-cancel hidden>停止导入</button></div><div role="status" data-v6-history-status></div>';
    const input=container.querySelector('[data-v6-history-files]'),pick=container.querySelector('[data-v6-history-pick]'),start=container.querySelector('[data-v6-history-import]'),cancel=container.querySelector('[data-v6-history-cancel]'),status=container.querySelector('[data-v6-history-status]');
    const fail=error=>{if(current()){status.textContent=error.message||String(error);root.ERR?.report('HISTORY_OPERATION_FAILED',{message:status.textContent});}};
    const summary=report=>'已导入 '+report.imported.length+' 批，已存在 '+report.skipped.length+' 批，失败 '+report.failed.length+' 批'+(report.failed.length?'：'+report.failed.slice(0,3).map(e=>e.error).join('；'):'');
    try{const saved=JSON.parse(root.localStorage.getItem(root.WHEELCHAIR_STORAGE.key('v6-history-report'))||'null');if(saved?.namespaceId===scope&&Array.isArray(saved.imported)&&Array.isArray(saved.skipped)&&Array.isArray(saved.failed))status.textContent=summary(saved);}catch(_){ }
    pick.onclick=()=>{if(!running&&current())input.click();};
    input.onchange=async()=>{
      plan=null;start.disabled=true;pick.disabled=true;
      try{
        const prepared=await prepare(Array.from(input.files||[]));if(!current())return;plan=prepared;
        const missing=plan.groups.filter(g=>g.missing.length).length;
        status.textContent=(plan.usedBackup?'主索引不可用，将读取备份。':'')+plan.groups.length+' 批记录，'+plan.imageCount+' 张图片'+(missing?'，'+missing+' 批缺少原图':'')+(plan.issues.length?'，'+plan.issues.length+' 条无效记录':'')+'。导入到当前账号；原目录保持原样，旧结果不绑定 Photoshop 文档。';
        start.disabled=!plan.groups.length;
      }catch(error){fail(error);}finally{pick.disabled=false;input.value='';}
    };
    cancel.onclick=()=>{stopped=true;cancel.disabled=true;};
    start.onclick=async()=>{
      if(!plan||running||!current())return;running=true;stopped=false;start.disabled=true;pick.disabled=true;cancel.hidden=false;cancel.disabled=false;
      try{
        const report=await importPlan(plan,{...host,cancelled:()=>stopped||!current(),progress:r=>{if(current())status.textContent=summary(r);}});
        if(!current())return;
        root.localStorage.setItem(root.WHEELCHAIR_STORAGE.key('v6-history-report'),JSON.stringify(report));
        status.textContent=summary(report);if(report.imported.length)await host.changed?.();
      }catch(error){fail(error);}finally{running=false;cancel.hidden=true;pick.disabled=false;start.disabled=!plan;}
    };
    return ()=>{stopped=true;plan=null;};
  }
  return {prepare,importPlan,decodeImage,mount};
});
