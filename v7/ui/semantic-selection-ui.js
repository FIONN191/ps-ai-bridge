(function(root){
  'use strict';
  let activeCancel=null;
  const NS='http://www.w3.org/2000/svg';
  function confirm(options){
    if(activeCancel)return Promise.reject(Object.assign(new Error('已有一个部位确认窗口，请先完成或取消'),{code:'SEMANTIC_PREVIEW_BUSY'}));
    const {session,expand}=options,multiple=session.candidates.length>1;
    const dialog=document.createElement('dialog');dialog.className='semantic-selection-dialog';
    dialog.innerHTML='<h2>确认人物或部位</h2><div class="semantic-help"></div><svg class="semantic-image" role="img" aria-label="原画布及待确认的矩形选区"></svg><label class="semantic-target">选择目标<select aria-label="选择识别目标"></select></label><label class="semantic-margin">每条边向外留 <b></b><input type="range" min="0" max="50" step="1" aria-label="每边外扩百分比"></label><div class="semantic-rect" role="status"></div><div class="semantic-actions"><button data-cancel>取消</button><button data-confirm disabled>在 Photoshop 建立此选区</button></div>';
    dialog.querySelector('.semantic-help').textContent='文档：'+session.document.docName+'。'+(multiple?'识别到多个目标，请亲自选择要处理的一个。':'请核对画面中框住的目标。')+'确认后会替换原文档的选区，不会生成图像。'+(session.truncated?'本次只显示前20个候选，还有其他命中目标。':'');
    const svg=dialog.querySelector('svg');svg.setAttribute('viewBox','0 0 '+session.document.width+' '+session.document.height);
    const url=URL.createObjectURL(session.image),image=document.createElementNS(NS,'image');image.setAttribute('href',url);image.setAttribute('width',session.document.width);image.setAttribute('height',session.document.height);svg.append(image);
    const box=document.createElementNS(NS,'rect');box.classList.add('semantic-box');box.setAttribute('vector-effect','non-scaling-stroke');svg.append(box);
    const select=dialog.querySelector('select'),slider=dialog.querySelector('input'),value=dialog.querySelector('.semantic-margin b'),status=dialog.querySelector('.semantic-rect'),apply=dialog.querySelector('[data-confirm]');
    if(multiple){const empty=document.createElement('option');empty.value='';empty.textContent='请先选择目标';select.append(empty);}
    for(const candidate of session.candidates){const option=document.createElement('option');option.value=candidate.id;option.textContent=candidate.label+' · 模型评分 '+Math.round(candidate.score*100)+'%';select.append(option);}
    // Multiple instances are never preselected, even when the model supplied candidateId.
    select.value=multiple?'':session.candidates[0].id;
    let selected=null;
    const paint=()=>{
      selected=session.candidates.find(c=>c.id===select.value)||null;
      value.textContent=slider.value+'%';
      if(!selected){apply.disabled=true;box.setAttribute('visibility','hidden');status.textContent='先选择目标，再检查高亮矩形是否正确。';return;}
      const rect=expand(selected.rect,Number(slider.value),session.document.width,session.document.height);
      for(const name of ['width','height'])box.setAttribute(name,rect[name]);box.setAttribute('x',rect.left);box.setAttribute('y',rect.top);box.setAttribute('visibility','visible');
      status.textContent=rect.caption||('将建立 '+rect.width+' × '+rect.height+' 像素矩形 · 每条边外扩 '+slider.value+'%（遇到画布边缘会截住）');apply.disabled=false;
    };
    slider.value=String(Number.isFinite(Number(options.marginPercent))?Math.max(0,Math.min(50,Number(options.marginPercent))):(session.candidates[0].marginPercent||0));
    select.addEventListener('change',()=>{const item=session.candidates.find(c=>c.id===select.value);if(item&&options.marginPercent===undefined)slider.value=item.marginPercent;paint();});
    slider.addEventListener('input',paint);paint();document.body.append(dialog);dialog.showModal();
    return new Promise(resolve=>{
      let closed=false;
      const finish=result=>{if(closed)return;closed=true;activeCancel=null;dialog.remove();URL.revokeObjectURL(url);resolve(result);};
      activeCancel=()=>finish(null);
      dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});dialog.querySelector('[data-cancel]').addEventListener('click',()=>finish(null));
      apply.addEventListener('click',()=>{if(selected)finish({candidateId:selected.id,marginPercent:Number(slider.value)});});
    });
  }
  root.V7SemanticSelectionUI={confirm,cancel(){if(activeCancel)activeCancel();}};
})(window);
