(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.V7AssistantProactive=api;
})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  function rect(value){
    if(!value)return null;
    const left=Number(value.left),top=Number(value.top),right=Number(value.right??left+Number(value.width)),bottom=Number(value.bottom??top+Number(value.height));
    return [left,top,right,bottom].every(Number.isFinite)&&right>left&&bottom>top?{left,top,right,bottom}:null;
  }
  function area(r){return (r.right-r.left)*(r.bottom-r.top);}
  function polygonArea(points){return Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0))/2;}
  function validPolygon(value){return Array.isArray(value)&&value.length>=3&&value.length<=12&&value.every(p=>p&&typeof p.x==='number'&&typeof p.y==='number'&&Number.isFinite(p.x)&&Number.isFinite(p.y))&&polygonArea(value)>0?value:null;}
  function clipPolygon(points,r){
    let result=points;
    for(const [axis,bound,sign] of [['x',r.left,1],['x',r.right,-1],['y',r.top,1],['y',r.bottom,-1]]){
      const input=result;result=[];
      for(let i=0;i<input.length;i++){
        const p=input[i],q=input[(i+1)%input.length],insideP=(p[axis]-bound)*sign>=0,insideQ=(q[axis]-bound)*sign>=0;
        if(insideP)result.push(p);
        if(insideP!==insideQ){const ratio=(bound-p[axis])/(q[axis]-p[axis]);result.push({x:p.x+(q.x-p.x)*ratio,y:p.y+(q.y-p.y)*ratio});}
      }
    }
    return result;
  }
  function relevance(candidate,focus,polygon){
    const a=rect(candidate),b=rect(focus);if(!a||!b)return 0;
    const shape=validPolygon(polygon);
    if(shape){const overlap=polygonArea(clipPolygon(shape,a));return overlap/area(a)<.15?0:overlap/polygonArea(shape);}
    const overlap=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    if(overlap/area(a)<.15)return 0;
    return overlap/area(b);
  }
  function verifiedFocus(view,mode){
    if(!view||view.docId==null||view.activeDocumentBound!==true)return null;
    const source=mode==='selection'?view.selection:view;
    return source&&(mode==='selection'?source.status==='present':source.status==='available')?rect(source.bounds):null;
  }
  function signature(view,mode){
    return JSON.stringify([view&&view.docId,view&&view.contentRevision,view&&view.windowId,view&&view.viewTransform,view&&view.zoomPercent,view&&view.clientBounds,view&&view.displayBounds,view&&view.scaleFactor,view&&view.viewSignature,mode,verifiedFocus(view,mode),mode==='selection'?null:validPolygon(view&&view.polygon)]);
  }
  function create(host){
    let enabled=false,epoch=0,mode='viewport',timer=null,busy=false,view=null,key='',changedAt=0,lastAttempt=-Infinity,active=null,attemptedKey='';
    const now=host.now||Date.now,set=host.setTimeout||setTimeout,clear=host.clearTimeout||clearTimeout;
    const cooldown=host.cooldownMs??3000,interval=host.intervalMs??1500,minimum=host.minimumMs??30000;
    const emit=value=>host.onState&&host.onState({enabled,mode,...value});
    function invalidate(){epoch++;if(active)active.abort();active=null;}
    function schedule(){if(enabled&&timer===null)timer=set(()=>{timer=null;tick();},interval);}
    async function analyze(current,currentKey,version){
      const ctl=new AbortController();active=ctl;
      try{
        const result=await host.analyze(current,{mode,focus:verifiedFocus(current,mode),polygon:mode==='selection'?null:validPolygon(current.polygon),signal:ctl.signal});
        if(enabled&&version===epoch&&currentKey===key&&!ctl.signal.aborted)emit({status:'ready',view:current,suggestions:result||[]});
      }catch(error){
        if(enabled&&version===epoch&&!ctl.signal.aborted){emit({status:'failed',error:String(error.message||error),suggestions:[]});if(host.onError)host.onError(error);}
      }finally{if(active===ctl)active=null;}
    }
    async function tick(){
      if(!enabled||busy)return;
      busy=true;const version=epoch;
      try{
        const next=await host.probe(mode);
        if(!enabled||version!==epoch)return;
        const nextKey=signature(next,mode);
        view=next;
        if(nextKey!==key){key=nextKey;attemptedKey='';changedAt=now();invalidate();emit({status:'cooldown',suggestions:[]});}
        if(!verifiedFocus(next,mode)){emit({status:'unavailable',reason:mode==='selection'?'SELECTION_REQUIRED':'VIEWPORT_CLIENT_BOUNDS_UNVERIFIED',suggestions:[]});return;}
        const previousAttempt=Math.max(lastAttempt,host.lastAttemptAt?host.lastAttemptAt():-Infinity);
        if(now()-changedAt<cooldown||now()-previousAttempt<minimum||active||host.onlyOnChange&&next.contentRevision!=null&&attemptedKey===key)return;
        lastAttempt=now();attemptedKey=key;emit({status:'analyzing',suggestions:[]});
        void analyze(next,nextKey,epoch);
      }catch(error){
        if(enabled&&version===epoch){invalidate();key='';view=null;emit({status:'unavailable',reason:String(error.message||error),suggestions:[]});}
      }finally{busy=false;schedule();}
    }
    function stop(){enabled=false;invalidate();if(timer!==null)clear(timer);timer=null;view=null;key='';attemptedKey='';lastAttempt=-Infinity;emit({status:'off',suggestions:[]});}
    function start(options={}){stop();mode=options.mode==='selection'?'selection':'viewport';enabled=true;emit({status:'waiting',suggestions:[]});void tick();}
    return {start,stop,tick,current:()=>({enabled,mode,view,key,epoch}),isCurrent:token=>enabled&&token.epoch===epoch&&token.key===key};
  }
  function focusOf(capture){
    const focus=capture&&capture.focus;
    if(focus&&focus.viewport&&focus.viewport.status==='available'&&rect(focus.viewport.bounds))return {kind:'viewport',bounds:rect(focus.viewport.bounds),...(validPolygon(focus.viewport.polygon)?{polygon:focus.viewport.polygon}:{})};
    const selection=focus&&focus.selection;
    if(selection&&selection.status==='present'&&rect(selection.bounds))return {kind:'selection',bounds:rect(selection.bounds)};
    return null;
  }
  return {create,rect,relevance,verifiedFocus,signature,focusOf};
});
