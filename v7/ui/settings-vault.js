/* No plain-text fallback. Writes are serialized per account/device/name. */
(function(root){
  'use strict';
  function create(options){
    const pending=new Map(),saved=new Map(),loaded=new Set(),edited=new Set();let revision=0;
    const scope=()=>root.WHEELCHAIR_STORAGE?root.WHEELCHAIR_STORAGE.namespaceId():'anonymous';
    const names=()=>Array.from(options.keys());
    const fail=()=>Object.assign(new Error('本机安全存储不可用；Key 仅保留在本次会话'),{code:'SECRET_STORE_UNAVAILABLE'});
    async function save(name,value,target=scope()){
      const identity=target+':'+name,api=root.uiwin?.secrets;
      if(!api)throw fail();
      const job=(pending.get(identity)||Promise.resolve()).catch(()=>{}).then(async()=>{
        const result=value?await api.set({name,value,scope:target}):await api.remove(name,target);
        if(!result?.ok)throw fail();saved.set(identity,value);
      });
      pending.set(identity,job);try{await job;}finally{if(pending.get(identity)===job)pending.delete(identity);}
    }
    async function saveChanges(){const target=scope(),version=revision,values=names().map(name=>[name,String(options.get(name)||'')]);for(const [name,value] of values){if(version!==revision||scope()!==target)return;if(!loaded.has(name)&&!edited.has(name)&&!value)continue;if(saved.get(target+':'+name)!==value&&(value||saved.has(target+':'+name)))await save(name,value,target);}}
    async function load(){const target=scope(),version=++revision,api=root.uiwin?.secrets;if(!api)return;
      loaded.clear();edited.clear();
      for(const name of names()){
        const before=String(options.get(name)||''),result=await api.get(name,target);
        if(version!==revision||scope()!==target)return;
        if(!result?.ok)throw fail();
        saved.set(target+':'+name,String(result.value||''));
        loaded.add(name);
        if(!edited.has(name)&&String(options.get(name)||'')===before&&!before)options.set(name,String(result.value||''));
      }
      options.onLoaded?.();
    }
    function markEdited(name){edited.add(name);}
    // 2026-10-21：这一格从安全存储读完了没有（自定义渠道多套方案要用：没读完就切换，会拿空值把存着的 Key 冲掉）
    function isLoaded(name){return loaded.has(name);}
    function clear(){revision++;loaded.clear();edited.clear();for(const name of names())options.set(name,'');}
    return {load,save,saveChanges,clear,markEdited,isLoaded};
  }
  root.V7SettingsVault={create};
})(window);
