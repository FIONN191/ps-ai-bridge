(function(root){
  'use strict';
  const PART_BYTES=1024*1024,MAX_BYTES=200*1024*1024;
  const defaults={style:0,scale:1,intensity:1,localTone:1,localStruct:1,skin:1,smoothProtect:0.6,uiCorrection:0,colorMatch:false};
  const fail=(code,message)=>Object.assign(new Error(message||code),{code});
  const bytes=encoded=>Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  function base64(raw){let value='';for(let at=0;at<raw.length;at+=32768)value+=String.fromCharCode(...raw.subarray(at,at+32768));return btoa(value);}
  async function digest(blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');}
  function tiles(source,size){
    const selection=source.selection,out=[];
    for(let y=0;y<selection.height;y+=size)for(let x=0;x<selection.width;x+=size){
      const left=selection.left+x,top=selection.top+y,width=Math.min(size,selection.width-x),height=Math.min(size,selection.height-y);
      out.push({left,top,right:left+width,bottom:top+height,width,height});
    }
    return out;
  }
  function create(host){
    let current=null,busy=false,revision=0;
    const account=()=>{const state=host.backend.state();return state.signedIn?state.account.id+':'+state.deviceId+':'+state.sessionVersion:'';};
    function check(run){if(!run||current!==run||run.revision!==revision||account()!==run.account)throw fail('DLSS_ACCOUNT_CHANGED','账号已切换，已停止原账号的处理');if(run.cancelled)throw fail('DLSS_CANCELLED','本次处理已取消');}
    function update(run,stage,progress){check(run);run.stage=stage;run.progress=progress;host.changed&&host.changed(run);}
    function finish(run){run.tiles.clear();run.downloads={};run.result=null;run.original=null;run.error=null;update(run,'已完成',100);return run;}
    const call=(path,body)=>host.backend.dlssRequest(path,{method:body===undefined?'GET':'POST',body,timeoutMs:180000});
    async function download(run,kind,info){
      if(!Number.isSafeInteger(info.bytes)||info.bytes<1||info.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(info.sha256))throw fail('DLSS_RESULT_INVALID','增强结果元数据无效');
      const data=run.downloads[kind]||(run.downloads[kind]={offset:0,chunks:[],sha256:info.sha256});
      if(data.sha256!==info.sha256)throw fail('DLSS_RESULT_CHANGED','服务器结果已经变化，已停止拼接');
      while(data.offset<info.bytes){
        check(run);const part=await call('/v1/dlss/jobs/'+run.job.id+'/download?kind='+kind+'&offset='+data.offset+'&length='+PART_BYTES);check(run);
        const raw=bytes(part.base64);
        if(part.offset!==data.offset||part.length!==raw.length||raw.length<1||part.total!==info.bytes||part.sha256!==info.sha256||data.offset+raw.length>info.bytes)throw fail('DLSS_RESULT_INVALID','下载分片不连续，已保留已收到的分片');
        data.chunks.push(raw);data.offset+=raw.length;update(run,kind==='input'?'下载校色原图':'下载增强结果',75+Math.round(data.offset/info.bytes*20));
      }
      const blob=new Blob(data.chunks,{type:'image/png'});
      if(await digest(blob)!==info.sha256)throw fail('DLSS_RESULT_INVALID','下载结果校验失败，请保留任务并重试');
      check(run);return blob;
    }
    async function execute(run){
      if(busy)throw fail('DLSS_BUSY','当前传输尚未结束');
      busy=true;
      try{
        check(run);
        if(!run.job){
          await call('/v1/dlss/status');check(run);
          run.job=(await call('/v1/dlss/jobs',{width:run.source.selection.width,height:run.source.selection.height})).job;check(run);
        }else{run.job=(await call('/v1/dlss/jobs/'+run.job.id)).job;check(run);}
        if(run.job.stage==='uploading'){
          const regions=tiles(run.source,run.job.tileSize);
          if(regions.length!==run.job.total)throw fail('DLSS_UPLOAD_INVALID','分块规划与服务器不一致');
          for(let index=0;index<regions.length;index++){
            check(run);if(run.job.tiles[String(index)]?.complete)continue;
            let raw=run.tiles.get(index);
            if(!raw){
              const capture=await host.capture(run.source,regions[index]);check(run);
              if(capture.width!==regions[index].width||capture.height!==regions[index].height||String(capture.docId)!==String(run.source.docId))throw fail('DLSS_CAPTURE_INVALID','Photoshop 抓取结果并非原始尺寸，已停止增强');
              raw=bytes(capture.imageBase64);run.bytes+=raw.length;if(run.bytes>MAX_BYTES)throw fail('DLSS_IMAGE_TOO_LARGE','上传图片总量超过 200 MB');run.tiles.set(index,raw);
            }
            const parts=Math.ceil(raw.length/PART_BYTES);
            for(let part=0;part<parts;part++){
              if(run.job.tiles[String(index)]?.received?.[String(part)])continue;
              const received=await call('/v1/dlss/jobs/'+run.job.id+'/upload',{index,parts,part,base64:base64(raw.subarray(part*PART_BYTES,Math.min(raw.length,(part+1)*PART_BYTES)))});check(run);run.job=received.job;
              update(run,'上传 '+(index+1)+' / '+regions.length+' 块',Math.round((index+(part+1)/parts)/regions.length*45));
            }
            run.tiles.delete(index);
          }
          if(!run.taskId){
            await call('/v1/dlss/status');check(run);
            const context={dlssSettings:run.parameters,taskKind:'operation'};
            const quote=await host.backend.quote('dlss',1,context);check(run);
            if(!await host.confirm(quote.estimate)){check(run);update(run,'尚未扣费，可继续或取消',45);return {cancelled:true};}check(run);
            run.charging=true;run.chargeUncertain=true;
            let charged;try{charged=await host.backend.createTask({...context,route:'dlss',requestedCount:1,idempotencyKey:'dlss-'+run.job.id,expectedPoints:quote.estimate.points});}finally{run.charging=false;}check(run);
            run.chargeUncertain=false;
            run.taskId=charged.task.id;run.paid=charged.task.billing_state==='charged';update(run,'已扣费，准备增强',50);
          }
          run.job=(await call('/v1/dlss/jobs/'+run.job.id+'/process',{taskId:run.taskId})).job;check(run);
        }
        const deadline=Date.now()+20*60*1000;
        while(run.job.stage==='processing'){
          update(run,'正在增强…',65);
          await (host.wait?host.wait():new Promise(resolve=>setTimeout(resolve,1000)));check(run);
          run.job=(await call('/v1/dlss/jobs/'+run.job.id)).job;check(run);
          if(Date.now()>deadline)throw fail('DLSS_WAIT_TIMEOUT','等待超时，可恢复查看结果；不要重新提交扣费');
        }
        if(run.job.stage==='received'&&run.saved)return finish(run);
        if(run.job.stage!=='succeeded')throw fail(run.job.error||'DLSS_RESULT_UNAVAILABLE',run.job.stage==='received'?'服务器结果已确认接收，请使用本机任务结果':'增强未完成，已扣费用不自动退回');
        if(!run.saved){
          run.result=await download(run,'result',run.job.results.result);
          if(run.parameters.colorMatch){if(!run.job.results.input)throw fail('DLSS_ORIGINAL_MISSING','缺少原图，无法执行已开启的精准校色');run.original=await download(run,'input',run.job.results.input);}
          update(run,'已下载，准备保存',97);
          await host.complete(run);check(run);run.saved=true;
        }
        const checksums=Object.fromEntries(Object.entries(run.job.results).map(([kind,info])=>[kind,info.sha256]));
        await call('/v1/dlss/jobs/'+run.job.id+'/ack',{checksums});check(run);
        return finish(run);
      }catch(error){if(current===run&&run.revision===revision&&account()===run.account){run.error=error;host.failed&&host.failed(run,error);}throw error;}
      finally{busy=false;}
    }
    async function start(source,parameters){
      if(busy)throw fail('DLSS_BUSY','当前传输尚未结束');
      const owner=account();if(!owner)throw fail('AUTH_REQUIRED','请先登录平台账号');
      const selection=source&&source.selection;
      if(!selection||![selection.width,selection.height,selection.left,selection.top].every(Number.isSafeInteger)||selection.width<1||selection.height<1||selection.width*selection.height>40000000)throw fail('DLSS_CAPTURE_INVALID','当前 DLSS 引擎支持最多 4000 万像素原尺寸增强，请缩小选区后重试；尚未扣费');
      current={account:owner,revision:++revision,source,parameters:{...defaults,...parameters,scale:1},tiles:new Map(),bytes:0,downloads:{},job:null,taskId:null,paid:false,progress:0,stage:'准备上传',error:null};
      host.started&&host.started(current);return execute(current);
    }
    async function cancel(){const run=current;if(!run)return;check(run);if(run.charging||run.chargeUncertain)throw fail('DLSS_CHARGE_PENDING','扣费回执尚未确认，请先恢复传输取得本次任务状态，避免误判为未扣费');if(run.job)await call('/v1/dlss/jobs/'+run.job.id+'/cancel',{taskId:run.taskId});check(run);run.cancelled=true;run.tiles.clear();run.downloads={};host.cancelled&&host.cancelled(run);}
    function invalidate(){revision++;if(current){current.tiles.clear();current.downloads={};current.result=null;current.original=null;}current=null;}
    return {start,resume:()=>execute(current),cancel,invalidate,state:()=>current,busy:()=>busy};
  }
  const api={create,tiles,digest,defaults,base64};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.V7DLSSRuntime=api;
})(typeof window!=='undefined'?window:globalThis);
