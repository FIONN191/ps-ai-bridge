(function(root){
  'use strict';
  const kinds=new Set(['scene-pack','poster','hemisynth','kao']),C=root.V7CreativeCore,M=root.V7CreativeMedia;
  async function exportPackage(raw){
    const result=JSON.parse(raw),store=root.V7CreativeStore.create();
    try{result.creativeBundles=[];let bytes=0;for(const preset of result.items||[]){if(!kinds.has(preset.kind))continue;const bundle=await M.exportBundle(C.state(JSON.parse(preset.content)),store);store.check();bytes+=bundle.assets.reduce((n,row)=>n+row.base64.length,0);if(bytes>132*1024*1024)throw C.fail('创作预设附件超过 96 MB，请分组导出');result.creativeBundles.push({presetId:preset.id,bundle});}return JSON.stringify(result,null,2);}finally{await store.close();}
  }
  async function importPackage(raw){
    if(!raw||raw.format!=='wheelchair-presets'||!Array.isArray(raw.items)||raw.items.length>1000)throw C.fail('预设包格式无效');
    const items=raw.items.map(p=>root.PRESETS.normalizePreset(p)),rows=raw.creativeBundles||[];
    if(!Array.isArray(rows)||rows.length>100)throw C.fail('创作预设附件格式无效');
    const ids=new Set(),prepared=[],store=root.V7CreativeStore.create();let bytes=0;
    try{
      for(const row of rows){if(!row||typeof row.presetId!=='string'||ids.has(row.presetId))throw C.fail('创作预设附件重复或无效');ids.add(row.presetId);const preset=items.find(p=>p.id===row.presetId);if(!preset||!kinds.has(preset.kind))throw C.fail('创作附件找不到对应预设');const expected=C.portable(JSON.parse(preset.content));if(JSON.stringify(expected)!==JSON.stringify(C.portable(row.bundle?.state)))throw C.fail('创作附件与预设配置不一致');const value=await M.importBundle(row.bundle);store.check();bytes+=value.assets.reduce((n,a)=>n+a.asset.full.size,0);if(bytes>96*1024*1024)throw C.fail('创作预设附件超过 96 MB');prepared.push({preset,data:value.data,assets:value.assets});}
      for(const preset of items){if(kinds.has(preset.kind)){const value=C.state(JSON.parse(preset.content));if(C.referenceIds(value).length&&!ids.has(preset.id))throw C.fail('创作预设缺少图片附件，请从原设备导出完整预设包');}}
      const known=new Set(root.PRESETS.presets().map(p=>p.id)),writes=prepared.filter(p=>!known.has(p.preset.id));
      for(const row of writes)row.preset.content=JSON.stringify(row.data);
      // Complete attachment validation before the first write; fresh IDs never replace another preset's images.
      await store.bundle(null,writes.flatMap(p=>p.assets));store.check();
      const result=await root.PRESETS.importPresets(items);store.check();
      for(const row of writes)if(root.PRESETS.presetById(row.preset.id)){await store.pin(row.preset.id,row.data);store.check();}
      return result;
    }finally{await store.close();}
  }
  root.V7CreativePresets={exportPackage,importPackage};
})(window);
