(function(root){
  'use strict';
  class WorkerClient{
    constructor(worker){
      this.worker=worker;this.seq=0;this.pending=new Map();this.closed=false;
      worker.onmessage=({data:m})=>{const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.ok?p.resolve(m):p.reject(new Error(m.error||'辉光计算失败'));};
      worker.onerror=e=>this.close(new Error(e.message||'辉光计算线程无法启动'));
    }
    call(type,fields){
      if(this.closed)return Promise.reject(new Error('辉光预览已关闭'));
      const id=++this.seq;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>this.close(new Error('辉光计算超时，请缩小选区后重试')),180000);
        this.pending.set(id,{resolve,reject,timer});
        try{this.worker.postMessage({id,type,...fields});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
      });
    }
    close(reason){
      if(this.closed)return;this.closed=true;this.worker.terminate();
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(reason||new Error('辉光预览已关闭'));}
      this.pending.clear();
    }
  }
  function controls(area,raw,onChange){
    const values=root.GLOW_CORE.params(raw),box=document.createElement('div');box.className='glow-controls';
    const fields=[['threshold','高光阈值',0,100,1,'%','越高，只提取越亮的区域。'],['radius','辉光范围',0,10,0.1,'%','以图片长边为基准，调大扩散得更远。'],['strength','强度',0,200,1,'%','0 保持原图；数值越大，效果越明显。']];
    for(const [key,title,min,max,step,unit,help] of fields){
      const label=document.createElement('label'),name=document.createElement('span'),slider=document.createElement('input'),desc=document.createElement('small');
      const paint=()=>name.textContent=title+' · '+values[key]+unit;
      slider.type='range';slider.min=min;slider.max=max;slider.step=step;slider.value=values[key];slider.className='pd-range';slider.setAttribute('aria-label',title);desc.textContent=help;paint();
      slider.addEventListener('input',()=>{values[key]=Number(slider.value);paint();onChange({...values});});
      label.append(name,slider,desc);box.append(label);
    }
    const modes=document.createElement('label');modes.textContent='混合方式';
    const select=document.createElement('select');select.className='pd-field-input';select.setAttribute('aria-label','混合方式');
    for(const [value,title] of [['softLight','柔光'],['linearDodge','线性减淡（添加）'],['overlay','叠加']]){const option=document.createElement('option');option.value=value;option.textContent=title;select.append(option);}
    select.value=values.blend;select.addEventListener('change',()=>{values.blend=select.value;onChange({...values});});modes.append(select);box.append(modes);
    const copy=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=values.copyHighlights;check.setAttribute('aria-label','复制高光');
    check.addEventListener('change',()=>{values.copyHighlights=check.checked;onChange({...values});});copy.append(check,document.createTextNode(' 复制高光'));const desc=document.createElement('small');desc.textContent='在扩散辉光之外再叠加一层清晰高光。';copy.append(desc);box.append(copy);area.append(box);
    return values;
  }
  async function open(options){
    const client=new WorkerClient(new Worker('glow-worker.js'));
    let dialog=null,closed=false,rendering=false,previewBusy=false,revision=0,timer=null,current=root.GLOW_CORE.params(options.params);
    let originalUrl='',previewUrl='';
    let finish;const result=new Promise(resolve=>finish=resolve);
    const cleanup=()=>{clearTimeout(timer);client.close();if(dialog)dialog.remove();if(originalUrl)URL.revokeObjectURL(originalUrl);if(previewUrl)URL.revokeObjectURL(previewUrl);root.removeEventListener('wheelchair:storage-context',cancel);};
    const cancel=()=>{if(closed)return;closed=true;cleanup();finish(null);};
    try{
      const loaded=await client.call('load',{blob:options.blob});
      if(options.onLoaded)await options.onLoaded(loaded);
      dialog=document.createElement('dialog');dialog.className='glow-editor';
      dialog.innerHTML='<h2>辉光预览</h2><div class="glow-help">拖动参数即时预览。确认后按原始尺寸计算；传回位置固定为本次抓取的 Photoshop 文档和区域。参数会保存到当前预设。</div><div class="glow-comparison"><figure><img data-original alt="抓取的原图">原图</figure><figure><img data-result alt="辉光效果预览">辉光</figure></div><div data-controls></div><div class="glow-status" role="status">正在准备预览…</div><div class="glow-actions"><button data-cancel>取消</button><button data-apply disabled>完成计算</button></div>';
      document.body.append(dialog);dialog.showModal();
      const status=dialog.querySelector('.glow-status'),apply=dialog.querySelector('[data-apply]'),output=dialog.querySelector('[data-result]');
      originalUrl=URL.createObjectURL(loaded.original);dialog.querySelector('[data-original]').src=originalUrl;
      let shownRevision=-1;
      const refresh=async()=>{
        if(closed||rendering||previewBusy)return;
        previewBusy=true;const wanted=revision;apply.disabled=true;status.textContent='正在更新辉光预览…';
        try{
          const image=await client.call('preview',{params:current});
          if(!closed&&wanted===revision){
            const next=URL.createObjectURL(image.blob);output.src=next;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=next;shownRevision=wanted;
            status.textContent='预览已更新 · 最终结果保持原始尺寸';apply.disabled=false;
          }
        }catch(e){if(!closed){status.textContent=e.message;options.onError&&options.onError(e);}}
        finally{previewBusy=false;if(!closed&&wanted!==revision)refresh();}
      };
      controls(dialog.querySelector('[data-controls]'),current,next=>{current=next;revision++;apply.disabled=true;clearTimeout(timer);timer=setTimeout(refresh,75);});
      dialog.querySelector('[data-cancel]').addEventListener('click',cancel);
      dialog.addEventListener('cancel',e=>{e.preventDefault();cancel();});
      root.addEventListener('wheelchair:storage-context',cancel);
      apply.addEventListener('click',async()=>{
        if(rendering||shownRevision!==revision)return;
        rendering=true;apply.disabled=true;dialog.querySelectorAll('input,select').forEach(e=>e.disabled=true);status.textContent='正在计算原尺寸结果，可以取消…';
        try{
          const image=await client.call('render',{params:current});
          if(closed)return;closed=true;cleanup();finish({...image,params:{...current}});
        }catch(e){if(!closed){rendering=false;apply.disabled=false;dialog.querySelectorAll('input,select').forEach(el=>el.disabled=false);status.textContent=e.message;options.onError&&options.onError(e);}}
      });
      refresh();return await result;
    }catch(e){cleanup();throw e;}
  }
  const api={WorkerClient,controls,open};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GLOW_TOOL=api;
})(typeof window!=='undefined'?window:globalThis);
