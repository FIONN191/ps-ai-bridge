(function(root){
  'use strict';
  const doc=root.document,detail=doc.querySelector('.detail-card'),tasks=doc.getElementById('tasks'),errors=doc.getElementById('errors');
  if(!detail||!tasks||!errors||root.V7WorkspaceStackRail)return;
  let frame=0,rail=null,mounted=null,busy=false,active=false;
  const counts=()=>({tasks:tasks.querySelectorAll('.task:not(.leaving)').length,errors:errors.querySelectorAll('.error-card:not(.ec-l3):not(.ec-l4)').length});
  const blocking=()=>errors.classList.contains('has-blocking')||errors.hasAttribute('data-v7-confirmation')||!!errors.querySelector('.error-card.ec-l3,.error-card.ec-l4');
  function isHidden(kind){return active&&(kind==='tasks'||kind==='errors'&&!blocking());}
  function clear(){
    active=false;doc.body.classList.remove('v7-workspace-stacks-summary');
    tasks.removeAttribute('aria-hidden');errors.removeAttribute('aria-hidden');
    rail?.remove();rail=null;mounted=null;
  }
  function focusStack(kind){
    const container=kind==='tasks'?tasks:errors;
    const card=container.querySelector(kind==='tasks'?'.task:not(.leaving)':'.error-card');
    if(!card)return;
    const control=card.querySelector('button,[tabindex]')||card;
    const hadTabIndex=control.hasAttribute('tabindex');
    if(!hadTabIndex)control.setAttribute('tabindex','-1');
    control.focus({preventScroll:true});
    container.classList.add('v7-stack-revealed');
    setTimeout(()=>{container.classList.remove('v7-stack-revealed');if(!hadTabIndex)control.removeAttribute('tabindex');},900);
  }
  async function reveal(kind){
    if(busy||!active)return false;
    busy=true;if(rail)rail.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{
      const workspace=mounted;
      if(await root.V7Workspaces.requestCloseAll()===false)return false;
      refresh();
      if(root.V7NavigationShell?.back)await root.V7NavigationShell.back();
      setTimeout(()=>focusStack(kind),120);
      return true;
    }catch(error){root.ERR?.report('LAYOUT_FAILED',{message:String(error?.message||error)});return false;}
    finally{busy=false;refresh();}
  }
  function refresh(){
    frame=0;
    const workspace=detail.classList.contains('workspace-host')&&detail.classList.contains('show')?detail.querySelector('.v7-workspace-inline'):null;
    if(!workspace){clear();return;}
    if(mounted!==workspace){
      clear();mounted=workspace;rail=doc.createElement('nav');rail.className='v7-workspace-stack-rail';rail.setAttribute('aria-label','任务与提示');
      for(const [id,label]of [['tasks','任务'],['errors','提示']]){
        const button=doc.createElement('button');button.type='button';button.dataset.workspaceStack=id;button.textContent=label;button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();reveal(id);});rail.append(button);
      }
      const help=doc.createElement('span');help.textContent='返回查看';rail.append(help);
      detail.querySelector('.dc-scroll')?.prepend(rail);
    }
    active=true;doc.body.classList.add('v7-workspace-stacks-summary');tasks.setAttribute('aria-hidden','true');
    if(blocking())errors.removeAttribute('aria-hidden');else errors.setAttribute('aria-hidden','true');
    const values=counts();
    for(const [id,label]of [['tasks','任务'],['errors','提示']]){
      const button=rail.querySelector('[data-workspace-stack="'+id+'"]'),value=label+' '+values[id];
      if(button.textContent!==value)button.textContent=value;
      button.disabled=busy||!values[id];
      button.setAttribute('aria-label','保存并返回查看'+label+'，共 '+values[id]+' 项');
      button.title='先保存并返回，再查看原'+label+'卡片；任务会继续运行';
    }
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(refresh);}
  new MutationObserver(schedule).observe(detail,{subtree:false,childList:false,attributes:true,attributeFilter:['class']});
  new MutationObserver(schedule).observe(doc.getElementById('dcBody'),{subtree:false,childList:true});
  new MutationObserver(schedule).observe(tasks,{childList:true,subtree:false,attributes:false});
  new MutationObserver(schedule).observe(errors,{childList:true,subtree:false,attributes:true,attributeFilter:['class','data-v7-confirmation']});
  root.addEventListener('wheelchair:storage-context',clear);
  root.V7WorkspaceStackRail={refresh:schedule,isHidden,reveal};
  refresh();
})(window);
