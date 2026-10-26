(function(root){
  'use strict';
  let host={},busy=false,epoch=0,currentWorker=null,state={phase:'idle',message:'整张画布 · AI 修图痕迹检测 · 独立透明标注层',candidates:[],analysisId:null,manifest:null,focusBusy:false,selectedCandidateId:null};
  const listeners=new Set();
  const fail=(message,code='SEAM_REVIEW_FAILED')=>Object.assign(new Error(message),{code});
  function publish(phase,message,extra={}){state={...extra,phase,message};for(const listener of listeners){try{listener({...state,busy});}catch(_){}}}
  function account(){const s=root.WHEELCHAIR_STORAGE;return JSON.stringify([s?.getContext?.()||{},root.V7Backend?.state?.().sessionVersion??null]);}
  function finite(value){return Number.isFinite(Number(value));}
  function regionOf(item,docWidth,docHeight){
    if(!item||!finite(docWidth)||!finite(docHeight))return null;
    let left,top,right,bottom;
    // FusionDetector.lineBounds() already turns a zero-width/zero-height line
    // into a one-pixel focus rectangle. Prefer that normalized geometry so a
    // vertical seam line is not discarded as an empty region.
    if(finite(item.x)&&finite(item.y)&&finite(item.width)&&finite(item.height)){
      left=Number(item.x);top=Number(item.y);right=left+Number(item.width);bottom=top+Number(item.height);
    }else if(item.line&&finite(item.line.x0)&&finite(item.line.y0)&&finite(item.line.x1)&&finite(item.line.y1)){
      left=Math.min(item.line.x0,item.line.x1);top=Math.min(item.line.y0,item.line.y1);right=Math.max(item.line.x0,item.line.x1);bottom=Math.max(item.line.y0,item.line.y1);
    }else return null;
    left=Math.max(0,Math.min(Number(docWidth),left));top=Math.max(0,Math.min(Number(docHeight),top));right=Math.max(0,Math.min(Number(docWidth),right));bottom=Math.max(0,Math.min(Number(docHeight),bottom));
    if(right<=left||bottom<=top)return null;
    return {left,top,right,bottom,width:right-left,height:bottom-top};
  }
  function makeCandidates(items,manifest,analysisId){
    return (Array.isArray(items)?items:[]).map((item,index)=>{
      const region=regionOf(item,manifest.docWidth,manifest.docHeight);if(!region)return null;
      const id=String(item.id||('candidate-'+(index+1)));
      return {id:analysisId+':'+id,analysisId,index:index+1,type:String(item.type||'review'),label:String(item.label||'需要人工复核'),priority:String(item.priority||'review'),region,anchor:{x:Math.round((region.left+region.right)/2),y:Math.round((region.top+region.bottom)/2)},evidence:item.evidence||null,geometry:item.geometry||null,sourceId:id};
    }).filter(Boolean).slice(0,48);
  }
  root.addEventListener?.('wheelchair:storage-context',()=>{
    epoch++;
    // A candidate manifest belongs to one account context. Do not leave an
    // old account's PSD coordinates clickable after the storage context has
    // changed, even when no worker is currently running.
    state={...state,candidates:[],analysisId:null,manifest:null,reviewItems:[],precisionCandidates:[],seamCandidates:[],selectedCandidateId:null,focusResult:null,focusError:null,phase:'idle',message:'账号已切换，旧的 AI 修图痕迹检测结果已清除'};
    if(currentWorker)currentWorker.cancel(fail('账号已切换，本次 AI 修图痕迹检测停止','SEAM_REVIEW_STALE'));
    else for(const listener of listeners){try{listener({...state,busy});}catch(_){}}
  });
  function analyze(capture){
    return new Promise((resolve,reject)=>{
      let worker,timer,done=false;
      const finish=(error,data)=>{if(done)return;done=true;clearTimeout(timer);worker?.terminate();currentWorker=null;error?reject(error):resolve(data);};
      try{worker=host.createWorker?host.createWorker():new Worker('seam-review-worker.js');
        currentWorker={cancel:error=>finish(error)};
        timer=setTimeout(()=>finish(fail('本机检查超过两分钟，已停止；可关闭其他大型任务后重试','SEAM_REVIEW_TIMEOUT')),120000);
        worker.onmessage=event=>event.data?.ok?finish(null,event.data):finish(fail(event.data?.error||'AI 修图痕迹检测算法未返回结果'));
        worker.onerror=event=>{event.preventDefault?.();finish(fail('AI 修图痕迹检测后台线程无法运行，请重新启动新版软件'));};
        worker.postMessage(capture);
      }catch(error){finish(error);}
    });
  }
  async function run(){
    if(busy)return {ok:false,busy:true};
    busy=true;const started=Date.now(),startEpoch=epoch,scope=account(),requestKey='seam-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    state={phase:'idle',message:'正在准备新的 AI 修图痕迹检测…',candidates:[],analysisId:null,manifest:null,reviewItems:[],focusBusy:false,selectedCandidateId:null,soloCandidateId:null};
    const guard=()=>{if(startEpoch!==epoch||scope!==account())throw fail('账号已切换，本次检查停止；若已提交传回，请检查原文档图层面板','SEAM_REVIEW_STALE');};
    try{
      // ⚠ 这条检查必须在 try 里：以前放在外面，桥没接好时直接抛出、不经 ERR.report，按钮点了毫无反应
      if(typeof host.bridge!=='function')throw fail('AI 修图痕迹检测工具没有完成加载，请重新打开软件');
      publish('capture','1/3 正在读取当前 Photoshop 文档的整张画布…',state);
      const capture=await host.bridge('ps.seam.capture',{requestKey,expiresAt:Date.now()+45000,maxEdge:3200},60000);guard();
      publish('scan','2/3 正在本机检测 AI 修图痕迹，界面仍可操作；请暂时不要修改原画布…',state);
      const analysis=await analyze(capture);guard();
      if(!Array.isArray(analysis.boxes))throw fail('检测结果格式不正确，未传回图层');
      const analysisId=requestKey+':analysis';
      const manifest={version:1,analysisId,requestKey,createdAt:new Date().toISOString(),expiresAt:Date.now()+15*60*1000,docId:capture.docId??null,docName:capture.docName||'',docWidth:Number(capture.docWidth),docHeight:Number(capture.docHeight),historyId:Number.isSafeInteger(Number(capture.historyId))?Number(capture.historyId):null,algorithm:'fusion-v2',candidateCount:0};
      const rawReviewItems=Array.isArray(analysis.reviewItems)&&analysis.reviewItems.length?analysis.reviewItems:(analysis.boxes||[]).map((box,index)=>({id:'box:'+index,type:'review',label:'需要人工复核',x:box.left,y:box.top,width:Math.max(1,Number(box.right)-Number(box.left)),height:Math.max(1,Number(box.bottom)-Number(box.top))}));
      const candidates=makeCandidates(rawReviewItems,manifest,analysisId);manifest.candidateCount=candidates.length;
      const common={analysisId,manifest,candidates,reviewItems:rawReviewItems,precisionCandidates:analysis.precisionCandidates||[],seamCandidates:analysis.seamCandidates||[],stats:analysis.stats||null};
      if(!analysis.boxes.length){const result={ok:true,placed:false,candidateCount:0,...common};publish('empty','本次未发现疑似 AI 修图痕迹，没有新增空图层。这不代表画面一定没有修图痕迹。',result);return result;}
      publish('apply','3/3 正在向原 Photoshop 文档添加透明标注层…',common);
      const result=await host.bridge('ps.seam.apply',{token:capture.token,requestKey,boxes:analysis.boxes,expiresAt:Date.now()+30000},120000);guard();
      if(!result?.placed)throw fail('未收到 Photoshop 的成功回执，请检查图层面板后再操作');
      // ⭐ 2026-09-29：每个痕迹在 PS 里是一个单独图层（装在一个组里）。把图层号对回列表里的候选，
      //   点一条就能「组内只显示它 + 按屏幕大小缩放图层」跳过去。旧版联动插件不回 layerIds，此时候选没有 layerId。
      const traces=bindTraceLayers(candidates,analysis.boxes,result);
      const groupId=Number.isSafeInteger(Number(result.groupId))?Number(result.groupId):null;
      const finalManifest={...manifest,historyId:Number.isSafeInteger(Number(result.historyId))?Number(result.historyId):manifest.historyId,annotationLayerId:result.layerId??null,groupId,traceLayerIds:traces.layerIds};
      const finished={...result,...common,candidates:traces.candidates,manifest:finalManifest,soloCandidateId:null,durationMs:Date.now()-started};
      publish('done',groupId?'已新增 AI 修图痕迹标注组：'+result.candidateCount+' 处痕迹各占一个图层。点列表里的一条，Photoshop 会跳过去并只显示那一处。':'已新增 AI 修图痕迹透明标注层：'+result.candidateCount+' 个候选框（联动插件是旧版，不能逐条跳转，请 Reload 联动插件）。',finished);
      return finished;
    }catch(error){
      const phase=state.phase;publish('error',String(error.message||error));
      root.ERR?.report(error.code==='SEAM_REVIEW_TIMEOUT'?'SEAM_REVIEW_TIMEOUT':'SEAM_REVIEW_FAILED',{message:String(error.message||error),context:{'阶段':phase,'错误码':error.code||'','说明':'若已进入传回，请先检查 Photoshop 图层面板，避免重复添加。'}});
      throw error;
    }finally{busy=false;publish(state.phase,state.message,state);}
  }
  // 把 PS 回执里的图层号对回候选。boxIndexes[i] = 第 i 个图层来自第几条 reviewItem（= 候选 index-1）；
  // 旧回执没有 boxIndexes 时退回用框自带的 itemIndex，再退回数组下标。
  function bindTraceLayers(candidates,boxes,result){
    const ids=Array.isArray(result?.layerIds)?result.layerIds.map(Number):[];
    const indexes=Array.isArray(result?.boxIndexes)?result.boxIndexes:[];
    const byItem=new Map();
    ids.forEach((id,i)=>{if(!Number.isSafeInteger(id))return;const item=Number.isSafeInteger(indexes[i])?indexes[i]:Number.isSafeInteger(boxes?.[i]?.itemIndex)?boxes[i].itemIndex:i;byItem.set(item,id);});
    return {layerIds:ids.filter(Number.isSafeInteger),candidates:(candidates||[]).map(c=>byItem.has(c.index-1)?{...c,layerId:byItem.get(c.index-1)}:c)};
  }
  const SOLO_REASONS={DOCUMENT_CLOSED:'检测的那个 Photoshop 文档已经关闭，请重新打开后再检测',NOT_ACTIVE_DOCUMENT:'检测的文档不是当前文档，请先切回那个文档',SOLO_LAYER_MISSING:'这一条的痕迹图层已被删除，请重新检测',SOLO_NOT_IN_CONTAINER:'这一条的痕迹图层被移出了标注组，请把它放回组里或重新检测',GROUP_MISSING:'「AI修图痕迹检测标注」组已被删除，请重新检测',NOTHING_IN_GROUP:'标注组里已经没有这次的痕迹图层了，请重新检测',NO_TARGET:'这次检测结果没有可用的痕迹图层'};
  function candidateOf(candidateOrId){return typeof candidateOrId==='string'?state.candidates.find(item=>item.id===candidateOrId):candidateOrId;}
  function traceReady(candidate){return !!(candidate&&Number.isSafeInteger(candidate.layerId)&&state.manifest&&Number.isSafeInteger(state.manifest.groupId)&&candidate.analysisId===state.manifest.analysisId);}
  // ⭐ 点列表里的一条：组内只显示这一条 + PS「按屏幕大小缩放图层」跳过去，用户原来选中的图层会还原。
  //   复用 ps.group.soloOwned 的 focusRegion（任务卡悬停聚焦同一套，2026-09-29 真 PS 验证过）。
  //   ⚠ 连点时只跑最后一次：前一次还在路上就排队，结束后跑最新的那条，中间的丢掉。
  // 开跑之前就被拦下的情况也要走 ERR.report（铁律 15/17：不许点了没反应）
  function refuse(message,code){const error=fail(message,code);root.ERR?.report(code==='BRIDGE_UNAVAILABLE'?'TOOL_OPEN_FAILED':'SEAM_REVIEW_FOCUS_FAILED',{message});return error;}
  let selecting=null,queued=null;
  async function select(candidateOrId){
    if(busy)return {ok:false,busy:true};
    if(typeof host.bridge!=='function')throw refuse('AI 修图痕迹检测工具没有完成加载，请重新打开软件','BRIDGE_UNAVAILABLE');
    const candidate=candidateOf(candidateOrId);
    if(!candidate)throw refuse('没有找到这个检测候选，可能已经重新检测','SEAM_REVIEW_CANDIDATE_MISSING');
    if(!state.manifest||candidate.analysisId!==state.manifest.analysisId)throw refuse('检测结果已经更新，请重新检测后再定位','SEAM_REVIEW_STALE');
    if(!traceReady(candidate))throw refuse('这一条没有单独的痕迹图层（联动插件是旧版），请 Reload 联动插件后重新检测','SEAM_REVIEW_FOCUS_FAILED');
    if(selecting){queued=candidate;state.selectedCandidateId=candidate.id;publish(state.phase,state.message,state);return selecting;}
    selecting=(async()=>{
      let current=candidate,last=null;
      while(current){
        queued=null;
        const startEpoch=epoch,scope=account(),label=String(current.index).padStart(2,'0');
        state.focusBusy=true;state.selectedCandidateId=current.id;publish('focus','正在跳到痕迹 '+label+'…',state);
        try{
          const m=state.manifest;
          const result=await host.bridge('ps.group.soloOwned',{docId:m.docId,groupId:m.groupId,ownedLayerIds:m.traceLayerIds,soloLayerId:current.layerId,allowSwitchDocument:true,focusRegion:true},30000);
          if(startEpoch!==epoch||scope!==account())throw fail('账号已切换，本次跳转停止','SEAM_REVIEW_STALE');
          // 跳转途中用户又开始了新检测：这条结果已经不属于当前列表，静默丢弃，别盖掉新检测的进度
          if(busy||state.manifest?.analysisId!==current.analysisId){last={ok:false,stale:true};break;}
          if(!result||result.ok===false)throw fail(SOLO_REASONS[result&&result.reason]||'Photoshop 没有完成跳转','SEAM_REVIEW_FOCUS_FAILED');
          const log=(Array.isArray(result.applied)?result.applied.find(item=>item&&item._focusLog):null)?._focusLog||null;
          const zoomed=!log||log.step==='complete';
          last={ok:true,zoomed,candidateId:current.id,focusLog:log};
          publish('done',zoomed?'已跳到痕迹 '+label+'：组里只显示这一处，点「显示全部」可恢复。':'已只显示痕迹 '+label+'，但 Photoshop 没有缩放过去（'+(log&&log.step||'未知')+'），可在图层面板 Alt+点它手动查看。',{...state,soloCandidateId:current.id,selectedCandidateId:current.id,focusResult:last,focusError:null});
        }catch(error){
          last={ok:false,error};
          publish('error',String(error.message||error),{...state,focusError:error.code||'SEAM_REVIEW_FOCUS_FAILED'});
          root.ERR?.report(error.code==='SEAM_REVIEW_STALE'?'SEAM_REVIEW_FAILED':'SEAM_REVIEW_FOCUS_FAILED',{message:String(error.message||error),context:{'痕迹':label,'图层ID':current.layerId,'组ID':state.manifest?.groupId}});
        }finally{state.focusBusy=false;}
        current=queued;
      }
      publish(state.phase,state.message,state);
      return last;
    })().finally(()=>{selecting=null;});
    return selecting;
  }
  // 「显示全部」：点过某一条后组里只剩它，这里把本次的痕迹图层全部点亮（只动这个组，组外不碰）。
  async function showAll(){
    if(busy)return {ok:false,busy:true};
    if(typeof host.bridge!=='function')throw refuse('AI 修图痕迹检测工具没有完成加载，请重新打开软件','BRIDGE_UNAVAILABLE');
    const m=state.manifest;
    if(!m||!Number.isSafeInteger(m.groupId)||!(m.traceLayerIds||[]).length)throw refuse('还没有可恢复的痕迹标注组，请先检测','SEAM_REVIEW_FOCUS_FAILED');
    try{
      const result=await host.bridge('ps.group.showOwned',{docId:m.docId,groupId:m.groupId,ownedLayerIds:m.traceLayerIds,allowSwitchDocument:true},30000);
      if(!result||result.ok===false)throw fail(SOLO_REASONS[result&&result.reason]||'Photoshop 没有完成显示','SEAM_REVIEW_FOCUS_FAILED');
      publish('done','标注组里的 '+result.applied.length+' 处痕迹已全部显示。',{...state,soloCandidateId:null,focusError:null});
      return {ok:true,shown:result.applied.length};
    }catch(error){
      publish('error',String(error.message||error),{...state,focusError:error.code||'SEAM_REVIEW_FOCUS_FAILED'});
      root.ERR?.report('SEAM_REVIEW_FOCUS_FAILED',{message:String(error.message||error),context:{'操作':'显示全部','组ID':m.groupId}});
      throw error;
    }
  }
  async function focus(candidateOrId,options={}){
    // 有单独图层的候选一律走新路（组内单显 + 缩放）。旧的 ps.seam.focus 依赖一个 PS 并不存在的视图对象，
    // 真 PS 里从来定不了位（2026-09-29 实测 doc.activeView 不存在）—— 只给没有图层号的旧结果兜底。
    const target=candidateOf(candidateOrId);
    if(traceReady(target))return select(target);
    if(busy)return {ok:false,busy:true};
    if(state.focusBusy)return {ok:false,busy:true};
    if(typeof host.bridge!=='function')throw fail('AI 修图痕迹检测工具没有完成加载，请重新打开软件','BRIDGE_UNAVAILABLE');
    const candidate=typeof candidateOrId==='string'?state.candidates.find(item=>item.id===candidateOrId):candidateOrId;
    if(!candidate||!candidate.region)throw fail('没有找到这个检测候选，可能已经重新检测或结果已过期','SEAM_REVIEW_CANDIDATE_MISSING');
    if(!state.manifest||candidate.analysisId!==state.manifest.analysisId)throw fail('检测结果已经更新，请重新检测后再定位','SEAM_REVIEW_STALE');
    if(state.manifest.expiresAt&&Date.now()>Number(state.manifest.expiresAt))throw fail('这份检测结果已过期，请重新检测后再定位','SEAM_REVIEW_EXPIRED');
    const startEpoch=epoch,scope=account();
    const guard=()=>{if(startEpoch!==epoch||scope!==account())throw fail('账号已切换，本次定位停止','SEAM_REVIEW_STALE');};
    state.focusBusy=true;state.selectedCandidateId=candidate.id;publish('focus','正在把 Photoshop 画布定位到候选 '+String(candidate.index).padStart(2,'0')+'…',state);
    try{
      guard();
      const params={analysisId:state.manifest.analysisId,requestKey:state.manifest.requestKey,candidateId:candidate.id,docId:state.manifest.docId,docName:state.manifest.docName,docWidth:state.manifest.docWidth,docHeight:state.manifest.docHeight,historyId:state.manifest.historyId||undefined,region:candidate.region,anchor:candidate.anchor,mode:options.mode||'fit',selectAnnotationLayer:options.selectAnnotationLayer===true,expiresAt:state.manifest.expiresAt};
      const result=await host.bridge('ps.seam.focus',params,60000);guard();
      if(result&&result.ok===false)throw fail(result.error||'Photoshop 没有完成区域定位',result.code||'SEAM_REVIEW_FOCUS_FAILED');
      publish('done','已定位到候选 '+String(candidate.index).padStart(2,'0')+'，请在 Photoshop 中人工复查。',{...state,focusResult:result||{ok:true},selectedCandidateId:candidate.id});
      return result||{ok:true};
    }catch(error){publish('error',String(error.message||error),{...state,focusError:error.code||'SEAM_REVIEW_FOCUS_FAILED'});root.ERR?.report(error.code||'SEAM_REVIEW_FOCUS_FAILED',{message:String(error.message||error),context:{analysisId:state.manifest?.analysisId,candidateId:candidate.id}});throw error;
    }finally{state.focusBusy=false;publish(state.phase,state.message,state);}
  }
  root.V7SeamReview={configure:value=>{host=value||{};},open:run,run,focus,select,showAll,isBusy:()=>busy,snapshot:()=>({...state,busy}),subscribe(fn){listeners.add(fn);fn({...state,busy});return()=>listeners.delete(fn);}};
})(typeof window!=='undefined'?window:globalThis);
