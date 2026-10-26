(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{
    root.V7SemanticSelectionCore=api;
    const bridge=(action,params)=>new Promise((resolve,reject)=>{
      linkQueue(action,params,{after:resolve,afterError:r=>reject(Object.assign(new Error(linkResultMessage(r)),{code:r&&r.error&&r.error.code}))})
        .then(r=>{if(r&&r.ok===false)reject(new Error(linkResultMessage(r)));}).catch(reject);
    });
    root.V7SemanticSelection=api.createService({capture:params=>bridge('ps.assistant.capture',params),
      applyRect:params=>bridge('ps.assistant.applySelection',params),namespace:()=>cacheNamespaceId(),
      getEngineBase:()=>root.MATTINGENGINE&&root.MATTINGENGINE.base||'http://127.0.0.1:37894',ensureEngine:()=>typeof root.V7EngineEnsure==='function'?root.V7EngineEnsure('语义识别'):null,fetch:(...args)=>fetch(...args),
      confirmCandidate:options=>root.V7SemanticSelectionUI.confirm(options),
      randomId:()=>crypto.randomUUID(),now:()=>Date.now()});
    root.addEventListener('wheelchair:storage-context',()=>{root.V7SemanticSelection.clear();if(root.V7SemanticSelectionUI)root.V7SemanticSelectionUI.cancel();});
  }
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const PARTS={
    person:{label:'人物',query:'person',aliases:['人物','人','人体','整个人'],margin:0},
    clothes:{label:'服装',query:'clothing',aliases:['衣服','服装','clothing'],margin:10},
    upper:{label:'上衣',query:'upper clothing',aliases:['上衣','上装','shirt'],margin:10},
    pants:{label:'裤子',query:'pants',aliases:['裤子','长裤'],margin:10},
    dress:{label:'连衣裙',query:'dress',aliases:['连衣裙','裙子'],margin:10},
    face:{label:'脸',query:'face',aliases:['脸','面部','脸部'],margin:0},
    hair:{label:'头发',query:'hair',aliases:['头发','毛发'],margin:0},
    hand:{label:'手',query:'hand',aliases:['手','手部','hands'],margin:0},
    arm:{label:'手臂',query:'arm',aliases:['手臂','胳膊','arms'],margin:0},
    leg:{label:'腿',query:'leg',aliases:['腿','腿部','legs'],margin:0},
    shoe:{label:'鞋',query:'shoe',aliases:['鞋','鞋子','shoes'],margin:0}
  };
  const error=(code,message)=>Object.assign(new Error(message),{code});
  const PART_NAMES='人物、服装、上衣、裤子、连衣裙、脸、头发、手、手臂、腿、鞋';
  function partOf(value){
    const raw=String(value||'').trim(),name=raw.toLowerCase().replace(/\s+/g,' ');
    for(const [key,part] of Object.entries(PARTS))if(name===key||part.aliases.includes(name))return {key,...part};
    // ⭐ 2026-10-17（用户：「放开找东西的词条」）：表里没有的，允许直接给英文物体名（phone、bag、cable…），
    //   原样交给 SAM 3 —— 它认任意英文词。以前只认上面 11 个，夏三六找不到手机就拿「手」凑数。
    //   中文不在表里的不替它翻译（翻错了等于找错东西），报错让大脑自己换成英文。
    if(/^[a-z][a-z0-9 '-]{0,47}$/.test(name))return {key:name,label:raw,query:name,aliases:[],margin:10,free:true};
    throw error('SEMANTIC_PART_UNSUPPORTED','中文只认这几个词：'+PART_NAMES+'；别的东西请直接写英文名（例如 phone、bag、cable），本机 SAM 3 只认英文');
  }
  function fromBox(box,width,height,docWidth,docHeight){
    if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||box[0]<0||box[1]<0||box[2]>width||box[3]>height||box[2]<=box[0]||box[3]<=box[1])
      throw error('SEMANTIC_RESULT_INVALID','分割引擎返回的部位边界无效，请重新识别');
    const left=Math.floor(box[0]*docWidth/width),top=Math.floor(box[1]*docHeight/height),right=Math.ceil(box[2]*docWidth/width),bottom=Math.ceil(box[3]*docHeight/height);
    return {left,top,right,bottom,width:right-left,height:bottom-top};
  }
  function expand(rect,percent,width,height){
    const p=Number(percent);
    if(!Number.isFinite(p)||p<0||p>50)throw error('SEMANTIC_MARGIN_INVALID','边界余量必须在每边 0–50% 之间');
    const dx=rect.width*p/100,dy=rect.height*p/100;
    const left=Math.max(0,Math.floor(rect.left-dx)),top=Math.max(0,Math.floor(rect.top-dy));
    const right=Math.min(width,Math.ceil(rect.right+dx)),bottom=Math.min(height,Math.ceil(rect.bottom+dy));
    return {left,top,right,bottom,width:right-left,height:bottom-top};
  }
  function chooseModel(health){
    if(!health||health.ok!==true)throw error('SEMANTIC_ENGINE_UNAVAILABLE','语义识别引擎不可用，请先在设置中启动本地能力');
    const models=Object.entries(health.models||{}).filter(([,m])=>m&&m.kind==='sam3'&&m.state==='ok'&&m.enabled!==false);
    models.sort((a,b)=>(Number(b[1].tier)||0)-(Number(a[1].tier)||0));
    if(!models.length)throw error('SEMANTIC_MODEL_MISSING','需要安装可区分人物和部位实例的 SAM 3 模型；当前人体解析结果不能可靠区分多人');
    return models[0][0];
  }
  function createService(host){
    const sessions=new Map();let epoch=0;
    const now=host.now||(()=>Date.now());
    const assertScope=(scope,generation)=>{if(scope!==host.namespace()||generation!==epoch)throw error('SEMANTIC_CONTEXT_CHANGED','账号或工作上下文已经切换，请重新识别');};
    const prune=()=>{for(const [id,s] of sessions)if(s.expiresAt<=now())sessions.delete(id);while(sessions.size>=8)sessions.delete(sessions.keys().next().value);};
    async function request(url,options={},timeout=180000,signal){
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);
      const cancel=()=>ctl.abort();
      if(signal){signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();}
      try{
        const response=await host.fetch(url,{...options,signal:ctl.signal});
        let data;try{data=await response.json();}catch(_){throw error('SEMANTIC_RESULT_INVALID','语义识别引擎返回了无法解析的数据');}
        if(!response.ok||data.ok===false)throw error('SEMANTIC_ENGINE_FAILED',String(data.error||'语义识别失败，请检查本地模型状态'));
        return data;
      }catch(cause){
        if(cause&&cause.code)throw cause;
        throw error('SEMANTIC_ENGINE_FAILED',cause&&cause.name==='AbortError'?'语义识别超时，请检查本地模型状态后重试':'无法连接本地语义引擎：'+String(cause&&cause.message||cause));
      }finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',cancel);}
    }
    async function suggest(options={}){
      const scope=host.namespace(),generation=epoch,part=partOf(options.part);prune();
      const check=()=>{assertScope(scope,generation);if(options.signal&&options.signal.aborted)throw error('SEMANTIC_CANCELLED','已停止本次识别');};
      const base=String(host.getEngineBase()).replace(/\/$/,'');
      check();
      // ⭐ 2026-10-15（用户要求按需冷启动）：引擎没开就先自动拉起来（宿主给了 ensureEngine 才拉；拉不起来下面照旧报错）
      if(typeof host.ensureEngine==='function'){try{await host.ensureEngine();}catch(_){}check();}
      const health=await request(base+'/health',{},10000,options.signal),model=chooseModel(health);check();
      const capture=await host.capture({docId:options.docId,maxEdge:1536,expiresAt:now()+120000});check();
      const [width,height,docWidth,docHeight]=[capture.width,capture.height,capture.docWidth,capture.docHeight].map(Number);
      if(capture.docId==null||![width,height,docWidth,docHeight].every(n=>Number.isSafeInteger(n)&&n>0)||Math.max(width,height)>1536||!capture.imageBase64)
        throw error('SEMANTIC_CAPTURE_INVALID','没有拿到完整且尺寸明确的 Photoshop 画布');
      const imageResponse=await host.fetch('data:'+capture.mime+';base64,'+capture.imageBase64);
      const image=await imageResponse.blob();
      check();
      const data=await request(base+'/sam3?model='+encodeURIComponent(model),{method:'POST',headers:{'Content-Type':capture.mime,
        'X-Params':encodeURIComponent(JSON.stringify({text:part.query,threshold:.45,maxInstances:20,edge:'sharp',refine:false}))},body:image},180000,options.signal);
      check();
      if(!Array.isArray(data.size)||data.size[0]!==width||data.size[1]!==height||!Array.isArray(data.instances)||data.instances.length>20)
        throw error('SEMANTIC_RESULT_INVALID','分割结果和本次画布尺寸不一致，未创建选区');
      const id=host.randomId(),document={docId:capture.docId,docName:String(capture.docName||''),width:docWidth,height:docHeight};
      const candidates=data.instances.filter(item=>Number(item.score)>=.45&&Number(item.score)<=1&&Number(item.pixels)>0&&Number(item.pixels)<=width*height).map((item,index)=>({
        id:id+':'+index,candidateId:id+':'+index,label:part.label+' '+(index+1),part:part.key,
        document:{...document},rect:fromBox(item.bbox,width,height,docWidth,docHeight),score:Number(item.score),marginPercent:part.margin,
        source:{type:'semantic-instance-mask',model,query:part.query,capturedAt:capture.capturedAt,engineVersion:String(health.version||'')}
      }));
      if(!candidates.length)throw error('SEMANTIC_NO_CANDIDATES',part.free
        ?'这张画面没找到可信的「'+part.label+'」。没有自动猜测选区：可以换个英文说法再找，或用看图工具自己量坐标，或请用户手动框选'
        :'这张画面未识别到可信的'+part.label+'。没有自动猜测选区，请手动框选或换个部位重试');
      const expiresAt=now()+10*60*1000;
      sessions.set(id,{id,scope,generation,document,image,candidates,expiresAt,truncated:!!data.truncated,total:Number(data.hit)||candidates.length});
      return {requestId:id,status:'requires_user_confirmation',candidates,document,expiresAt,
        truncated:!!data.truncated,totalDetected:Number(data.hit)||candidates.length,
        notice:'候选框 rect 是原图像素坐标。要建选区：让用户在本机预览里挑（semantic_apply_selection），或者你确定要哪一个时，直接按这个框用 ps_select_shapes 建。合照里谁是主角、谁是路人，先问用户，不能自己替用户挑人。'+(data.truncated?'本次仅显示前20个候选，画面还有其他命中目标。':'')};
    }
    async function apply(options={}){
      if(options.confirm!==true)throw error('SEMANTIC_CONFIRM_REQUIRED','建立选区前需要打开本机预览并由你确认');
      const candidateId=String(options.candidateId||options.candidate&&options.candidate.id||'');
      let session=null;
      for(const s of sessions.values())if(s.candidates.some(c=>c.id===candidateId)){session=s;break;}
      if(!session||session.expiresAt<=now())throw error('SEMANTIC_SELECTION_EXPIRED','候选不属于当前有效识别，请重新识别');
      assertScope(session.scope,session.generation);
      // Every apply opens local UI. confirm:true from a model is not user consent.
      // ⭐ 2026-10-17 夜：夏三六调的时候传 fit（做成正方形 + 往外多包，agent-look.js squareFit），预览和最后建的都按它；
      //   用户自己在界面上点的那条不传，照旧按每边外扩百分比。
      const shapeOf=typeof options.fit==='function'?options.fit:expand;
      const chosen=await host.confirmCandidate({session,requestedId:candidateId,expand:shapeOf,marginPercent:options.marginPercent});
      if(!chosen)return {ok:false,cancelled:true};
      assertScope(session.scope,session.generation);
      if(session.expiresAt<=now())throw error('SEMANTIC_SELECTION_EXPIRED','预览已过期，请重新识别');
      const selected=session.candidates.find(c=>c.id===chosen.candidateId);
      if(!selected)throw error('SEMANTIC_SELECTION_INVALID','选中的候选不在本次识别中');
      const selection=shapeOf(selected.rect,chosen.marginPercent,session.document.width,session.document.height);
      const result=await host.applyRect({docId:session.document.docId,docName:session.document.docName,
        docWidth:session.document.width,docHeight:session.document.height,rect:selection,
        candidateId:selected.id,confirmed:true,expiresAt:session.expiresAt});
      assertScope(session.scope,session.generation);
      if(!result||result.applied!==true||Number(result.docId)!==Number(session.document.docId))throw error('SEMANTIC_APPLY_FAILED','Photoshop 没有确认选区已经建立');
      sessions.delete(session.id);
      return {ok:true,...result,part:selected.part,marginPercent:chosen.marginPercent,source:selected.source};
    }
    return {suggest,apply,clear(){epoch++;sessions.clear();}};
  }
  return {PARTS,partOf,fromBox,expand,chooseModel,createService};
});
