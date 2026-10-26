(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.V7AssistantGeneration=api;})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  const error=(code,message)=>Object.assign(new Error(message||code),{code});
  function rectangle(value){
    if(!value)return null;
    const left=Number(value.left??value.x),top=Number(value.top??value.y);
    const right=Number(value.right??(left+Number(value.width))),bottom=Number(value.bottom??(top+Number(value.height)));
    return [left,top,right,bottom].every(Number.isFinite)?{left,top,right,bottom}:null;
  }
  function sameTarget(a,b){
    if(!a||!b||String(a.docId)!==String(b.docId)||String(a.docName)!==String(b.docName)||Number(a.docWidth)!==Number(b.docWidth)||Number(a.docHeight)!==Number(b.docHeight))return false;
    const x=rectangle(a.selection),y=rectangle(b.selection);
    if(!x||!y)return x===y;
    return Object.keys(x).every(k=>Math.abs(x[k]-y[k])<=1);
  }
  function create(host){
    const plans=new Map();let epoch=0;
    const now=host.now||Date.now;
    const current=plan=>plan.scope===host.scope()&&plan.epoch===epoch;
    async function prepare(input){
      const scope=host.scope(),version=epoch;
      const count=Number(input.count||1);
      if(!Number.isInteger(count)||count<1||count>18)throw error('ASSISTANT_BATCH_INVALID','每批请选择 1 至 18 次');
      const prepared=await host.prepare({...input,count,checkContext(){if(scope!==host.scope()||version!==epoch)throw error('ASSISTANT_SESSION_CHANGED');}});
      if(scope!==host.scope()||version!==epoch)throw error('ASSISTANT_SESSION_CHANGED');
      if(!prepared||!prepared.preview||!prepared.target)throw error('ASSISTANT_PLAN_INVALID');
      if(plans.size>=10)plans.delete(plans.keys().next().value);
      const planId=host.id(),expiresAt=now()+5*60*1000;
      const plan={...prepared,scope,epoch:version,planId,expiresAt,busy:false};plans.set(planId,plan);
      // The model only sees the public preview; host connection credentials,
      // captured images and closures never enter a tool response.
      return {ok:true,planId,expiresAt,requiresUserConfirmation:true,...prepared.preview};
    }
    async function execute(planId){
      const plan=plans.get(String(planId));
      if(!plan||!current(plan)||now()>=plan.expiresAt)throw error('ASSISTANT_PLAN_EXPIRED','这份生成计划已失效，请重新准备');
      if(plan.busy)throw error('ASSISTANT_PLAN_BUSY','这份计划正在等待确认或执行');
      plan.busy=true;
      try{
        const agreed=await host.confirm({...plan.preview,planId:plan.planId});
        if(!current(plan))throw error('ASSISTANT_SESSION_CHANGED');
        if(!agreed)return {ok:false,cancelled:true};
        if(now()>=plan.expiresAt)throw error('ASSISTANT_PLAN_EXPIRED','确认时间过长，请重新准备');
        const actual=await host.target();
        if(!current(plan))throw error('ASSISTANT_SESSION_CHANGED');
        if(!sameTarget(plan.target,actual))throw error('ASSISTANT_TARGET_CHANGED','Photoshop 的文档或选区已改变，尚未生成或扣费，请重新准备计划');
        plans.delete(plan.planId); // Consumed before handing off any billable call.
        return await host.run({...plan,checkContext(){if(!current(plan))throw error('ASSISTANT_SESSION_CHANGED');}});
      }finally{plan.busy=false;}
    }
    return {prepare,execute,clear(){epoch++;plans.clear();}};
  }
  return {create,sameTarget,rectangle};
});
