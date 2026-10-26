(function(root){
  'use strict';

  const MAX_ASSET_BYTES = 512 * 1024 * 1024;
  let epoch = 0;
  const active = new Set();
  root.addEventListener('wheelchair:storage-context', () => {
    epoch++;
    for (const tx of active) try { tx.abort(); } catch (_) {}
  });

  function changedError(){
    return Object.assign(new Error('账号已切换，请在当前账号重新打开相机与灯光'), {code:'LIGHTING_ACCOUNT_CHANGED'});
  }
  function create(){
    const initial = epoch;
    const name = root.WHEELCHAIR_STORAGE.dbName('camera-light.v1');
    let db;
    function check(){ if(initial !== epoch) throw changedError(); }
    const open = () => db || (db = new Promise((resolve,reject) => {
      check();
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        const names = database.objectStoreNames;
        if(!names || !names.contains || !names.contains('state')) database.createObjectStore('state');
        if(!names || !names.contains || !names.contains('assets')) database.createObjectStore('assets');
      };
      req.onsuccess = () => {
        try { check(); resolve(req.result); }
        catch(error){ try { req.result.close(); } catch (_) {} reject(error); }
      };
      req.onerror = () => reject(req.error || new Error('灯光数据库打不开'));
    }));

    async function tx(store, mode, fn){
      check();
      const database = await open();
      check();
      return new Promise((resolve,reject) => {
        const transaction = database.transaction(store, mode);
        active.add(transaction);
        let value;
        try {
          const request = fn(transaction.objectStore(store));
          if(request && typeof request === 'object') request.onsuccess = () => { value = request.result; };
        } catch(error){ try { transaction.abort(); } catch (_) {} reject(error); return; }
        transaction.oncomplete = () => {
          active.delete(transaction);
          try { check(); resolve(value); } catch(error){ reject(error); }
        };
        transaction.onabort = transaction.onerror = () => {
          active.delete(transaction);
          try { check(); reject(transaction.error || new Error('灯光项目保存中断')); }
          catch(error){ reject(error); }
        };
      });
    }

    async function usage(){
      check();
      const database = await open();
      check();
      return new Promise((resolve,reject) => {
        const transaction = database.transaction('assets','readonly');
        active.add(transaction);
        let bytes = 0, count = 0;
        const request = transaction.objectStore('assets').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if(!cursor) return;
          count++;
          if(cursor.value && Number.isFinite(cursor.value.size)) bytes += cursor.value.size;
          cursor.continue();
        };
        transaction.oncomplete = () => { active.delete(transaction); try { check(); resolve({bytes,count,limit:MAX_ASSET_BYTES}); } catch(error){ reject(error); } };
        transaction.onabort = transaction.onerror = () => { active.delete(transaction); try { check(); reject(transaction.error || new Error('灯光资产统计失败')); } catch(error){ reject(error); } };
      });
    }

    async function prune(keepIds){
      const keep = new Set((keepIds || []).map(String));
      check();
      const database = await open();
      check();
      return new Promise((resolve,reject) => {
        const transaction = database.transaction('assets','readwrite');
        active.add(transaction);
        const removed = [];
        const request = transaction.objectStore('assets').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if(!cursor) return;
          if(!keep.has(String(cursor.key))){ removed.push(String(cursor.key)); cursor.delete(); }
          cursor.continue();
        };
        transaction.oncomplete = () => { active.delete(transaction); try { check(); resolve(removed); } catch(error){ reject(error); } };
        transaction.onabort = transaction.onerror = () => { active.delete(transaction); try { check(); reject(transaction.error || new Error('灯光资产回收失败')); } catch(error){ reject(error); } };
      });
    }

    async function remove(ids){
      const keys = [...new Set((ids || []).map(String))];
      if(!keys.length) return [];
      await tx('assets','readwrite',store => { keys.forEach(id => store.delete(id)); return null; });
      return keys;
    }

    return {
      check,
      load: () => tx('state','readonly',s => s.get('current')),
      save: value => tx('state','readwrite',s => s.put(value,'current')),
      asset: id => tx('assets','readonly',s => s.get(id)),
      usage,
      prune,
      remove,
      MAX_ASSET_BYTES,
      async put(blob, options){
        if(!(blob instanceof Blob) || !blob.size || blob.size > 80*1024*1024)
          throw new Error('灯光图片大小无效');
        const current = await usage();
        if(current.bytes + blob.size > MAX_ASSET_BYTES && options && Array.isArray(options.evict))
          await remove(options.evict);
        const after = await usage();
        if(after.bytes + blob.size > MAX_ASSET_BYTES)
          throw Object.assign(new Error('灯光项目资产已达到 512MB 上限，请删除旧结果后重试'), {code:'LIGHTING_ASSET_BUDGET'});
        const id = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : ('light-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
        await tx('assets','readwrite',s => s.put(blob,id));
        return id;
      },
      async close(){ if(db) (await db).close(); }
    };
  }
  root.V7CameraLightStore={create,MAX_ASSET_BYTES};
})(window);
