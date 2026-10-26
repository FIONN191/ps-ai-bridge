/* Account backup restore journal. The preset database commits presets, layout,
 * the previous local state and a settings commit marker in one transaction.
 * A restart completes the settings marker before exposing restored controls. */
(function(root){
  'use strict';
  const BEFORE='cloud.account.before.v1',JOURNAL='cloud.account.restore.v1',CANVAS='canvas.v1';
  const omit=new Set(['refimages','referenceimages','chat','chats','messages','transcript','projects','projectitems','history','checkpoints','canvasnodes','cache','cacheref','imagebase64','inputimagebase64','sourceimagebase64','blob','backendurl','cachedir','cachepath']);
  const normalized=value=>String(value).toLowerCase().replace(/[^a-z0-9]/g,'');
  function clean(value,key=''){
    if(['__proto__','constructor','prototype'].includes(key))return undefined;
    const name=normalized(key);
    if(omit.has(name)||/apikey|accesstoken|refreshtoken|password|secret|authorization|credential/.test(name)||name.endsWith('key')&&!['hotkey','shortcutkey'].includes(name)||name.endsWith('token'))return undefined;
    if(typeof value==='string')return /^data:/i.test(value.trim())?undefined:value;
    if(value===null||typeof value==='boolean'||typeof value==='number')return value;
    if(Array.isArray(value))return value.map(item=>clean(item)).filter(item=>item!==undefined);
    if(value&&Object.getPrototypeOf(value)===Object.prototype){const out={};for(const [k,v]of Object.entries(value)){if(k.startsWith('_')&&['dispUrl','maskUrl','hit'].some(x=>k.includes(x)))continue;const item=clean(v,k);if(item!==undefined)out[k]=item;}return out;}
    return undefined;
  }
  function scope(){return root.WHEELCHAIR_STORAGE?root.WHEELCHAIR_STORAGE.namespaceId():'local';}
  function dbName(){return root.WHEELCHAIR_STORAGE?root.WHEELCHAIR_STORAGE.dbName('presets'):'v8.presets';}
  let epoch=0,sequence=0;
  const transactions=new Set();
  root.addEventListener?.('wheelchair:storage-context',()=>{epoch++;for(const transaction of transactions){try{transaction.abort();}catch(_){}}});
  function accountChanged(){return Object.assign(new Error('账号已切换，本次操作停止'),{code:'BACKUP_ACCOUNT_CHANGED'});}
  function context(guard){
    const started=scope(),name=dbName(),version=epoch;
    return {scope:started,name,check(){if(started!==scope()||version!==epoch)throw accountChanged();if(guard)guard();}};
  }
  async function open(operation){
    operation.check();
    // The existing store owns schema creation; never race a partial schema.
    if(root.PRESETS&&root.PRESETS.init)await root.PRESETS.init();
    operation.check();
    return new Promise((resolve,reject)=>{const request=indexedDB.open(operation.name,1);request.onsuccess=()=>{try{operation.check();resolve(request.result);}catch(error){request.result.close();reject(error);}};request.onerror=()=>reject(request.error);});
  }
  async function transact(operation,stores,mode,execute){
    const db=await open(operation);
    try{operation.check();}catch(error){db.close();throw error;}
    return new Promise((resolve,reject)=>{
      let transaction,result,failure;
      const finish=()=>{transactions.delete(transaction);db.close();};
      const abort=error=>{failure=error;try{transaction.abort();}catch(_){finish();reject(error);}};
      try{transaction=db.transaction(stores,mode);transactions.add(transaction);}catch(error){db.close();reject(error);return;}
      transaction.oncomplete=()=>{finish();try{operation.check();resolve(result);}catch(error){reject(error);}};
      transaction.onabort=transaction.onerror=()=>{finish();try{operation.check();}catch(error){failure=error;}reject(failure||transaction.error||new Error('BACKUP_TRANSACTION_ABORTED'));};
      try{execute(transaction,value=>{result=value;},abort);}catch(error){abort(error);}
    });
  }
  function readMeta(key,operation=context()){
    return transact(operation,'meta','readonly',(transaction,result)=>{const request=transaction.objectStore('meta').get(key);request.onsuccess=()=>result(request.result||null);});
  }
  function clearJournal(operation,marker){
    return transact(operation,'meta','readwrite',(transaction,result,abort)=>{
      const store=transaction.objectStore('meta'),request=store.get(JOURNAL);
      request.onsuccess=()=>{try{operation.check();if(JSON.stringify(request.result)!==JSON.stringify(marker))throw new Error('恢复记录已更新，请重新打开云备份页面');store.delete(JOURNAL);result(true);}catch(error){abort(error);}};
    });
  }
  function validate(manifest){
    if(!manifest||manifest.schema!=='wheelchair-account-backup'||manifest.version!==1||!Array.isArray(manifest.presets))throw new Error('BACKUP_VERSION_UNSUPPORTED');
    const ids=new Set();
    const presets=manifest.presets.map(p=>{if(!p||typeof p.id!=='string'||!p.id||ids.has(p.id))throw new Error('BACKUP_PRESET_ID_INVALID');ids.add(p.id);return root.PRESETS.normalizePreset(clean(p));});
    return {presets,layout:manifest.layout||{}};
  }
  async function refresh(operation){
    operation.check();
    if(root.PRESETUI&&root.PRESETUI.rebindStorage)await root.PRESETUI.rebindStorage();
    else if(root.PRESETS)root.PRESETS.rebindStorage();
    operation.check();
    // The UI adapter can swallow initialization errors; the cached promise is authoritative.
    if(root.PRESETS)await root.PRESETS.init();
    operation.check();
  }
  async function restore(manifest,beforeSettings,nextSettings,guard){
    const operation=context(guard);operation.check();
    const data=validate(manifest),restoreId=Date.now().toString(36)+'-'+(++sequence).toString(36);
    return transact(operation,['presets','assets','meta'],'readwrite',(t,result,abort)=>{
      const ps=t.objectStore('presets'),as=t.objectStore('assets'),ms=t.objectStore('meta');
      const pr=ps.getAll(),ar=as.getAll(),mr=ms.get(CANVAS);let pending=3;
      const ready=()=>{if(--pending)return;try{
        operation.check();
        const before={createdAt:new Date().toISOString(),restoreId,scope:operation.scope,presets:pr.result,assets:ar.result,meta:mr.result||{},settings:beforeSettings};
        ms.put(before,BEFORE);ms.put({createdAt:before.createdAt,restoreId,scope:operation.scope,settings:nextSettings},JOURNAL);
        ps.clear();for(const p of data.presets)ps.add(p,p.id);
        const known=new Map(ar.result.map(a=>[a.id,a])),missing=[];
        for(const pos of data.layout.assets||[]){
          const current=known.get(pos.id);if(!current){missing.push(pos.id);continue;}
          const patch={};for(const name of ['x','y','w','h','z'])if(Number.isFinite(Number(pos[name])))patch[name]=Number(pos[name]);
          for(const name of ['hidden','locked'])if(typeof pos[name]==='boolean')patch[name]=pos[name];
          if(typeof pos.name==='string')patch.name=pos.name;
          as.put({...current,...patch},current.id);
        }
        const aspect=Number(data.layout.canvasAspect);if(aspect>0.05&&aspect<20)ms.put({...before.meta,canvasAspect:aspect},CANVAS);
        result({presets:data.presets.length,missingAssets:missing,scope:operation.scope,restoreId});
      }catch(error){abort(error);}};
      pr.onsuccess=ar.onsuccess=mr.onsuccess=ready;
    });
  }
  async function rollback(guard,restoreId){
    const operation=context(guard);operation.check();
    return transact(operation,['presets','assets','meta'],'readwrite',(t,result,abort)=>{
      const ms=t.objectStore('meta'),r=ms.get(BEFORE);
      r.onsuccess=()=>{try{operation.check();const before=r.result;if(!before)throw new Error('BACKUP_LOCAL_SNAPSHOT_MISSING');
        if(before.scope!==operation.scope)throw accountChanged();
        if(restoreId&&before.restoreId!==restoreId)throw new Error('恢复点已更新，请在云备份页面重新选择');
        for(const name of ['presets','assets']){const store=t.objectStore(name);store.clear();for(const item of before[name])store.put(item,item.id);}
        ms.put(before.meta||{},CANVAS);ms.put({scope:operation.scope,restoreId:before.restoreId,settings:before.settings,rollback:true},JOURNAL);result(before.settings);
      }catch(error){abort(error);}};
    });
  }
  async function recover(apply,guard,restoreId){
    const operation=context(guard),marker=await readMeta(JOURNAL,operation);operation.check();
    if(!marker)return false;if(marker.scope!==operation.scope)throw accountChanged();
    if(restoreId&&marker.restoreId!==restoreId)throw new Error('恢复记录已更新，请重新打开云备份页面');
    await apply(marker.settings,operation.check);operation.check();
    await refresh(operation);await clearJournal(operation,marker);return true;
  }
  async function exportAccount(settings,extras={}){
    await root.PRESETS.init();
    const layout={canvasAspect:root.PRESETS.canvasAspect(),assets:root.PRESETS.assets().map(a=>{const out={id:a.id};for(const key of ['name','x','y','w','h','z','hidden','locked'])if(a[key]!==undefined)out[key]=a[key];return out;})};
    return {schema:'wheelchair-account-backup',version:1,settings:clean(settings),presets:clean(root.PRESETS.presets()),layout,...clean(extras)};
  }
  root.V7AccountBackupStore={clean,exportAccount,restore,rollback,recover,localInfo:()=>readMeta(BEFORE),scope};
})(window);
