(function(root){
  'use strict';
  let host={},busy=false,epoch=0,target=null,report=null;
  const mounts=new Set();
  const defaults={strategy:'restore',imageKind:'transparent-frame',layerType:'smartObject',target:'canvas'};
  let form={...defaults};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const help=text=>'<button type="button" class="v7-help" aria-label="说明：'+esc(text)+'" data-help-text="'+esc(text)+'">?</button>';
  const choices={strategy:[['legacy','A · 原链路（问题对照）'],['restore','B · 显隐保护（正式默认）'],['anchor','C · 独立锚层 + 显隐保护']],imageKind:[['transparent-frame','透明中心 · 彩色边框'],['corner-marks','透明中心 · 四角标记'],['opaque-reference','全幅不透明 · 覆盖对照']],layerType:[['smartObject','智能对象'],['pixel','像素图层']],target:[['canvas','整张画布'],['selection','当前选区边界']]};
  const countChanges=r=>{const c=r?.changes;return c?['removed','visibilityChanged','effectiveVisibilityChanged','parentChanged','ancestorChanged'].reduce((n,k)=>n+(c[k]?.length||0),0):null;};
  function summary(r){
    if(!r)return '尚未执行。先读取并绑定 Photoshop 当前文档。';
    if(!r.before)return r.ok===false?'读取未完成：'+(r.error?.message||'查看报告'):'已读取图层状态，尚未回图。';
    const changes=countChanges(r);
    const drift=r.targetDrift?'调用等待期间目标区域发生变化。':'';
    const baseline=r.baselineSource==='modal-entry'?'已在 Photoshop modal 入口建立基线。':'当前桥未提供 modal 入口基线，阶段归因需人工谨慎解释。';
    return (r.manualAfterError?'重读失败，原实验报告保留。':'')+drift+(r.ok?'实验动作执行完成':'实验未完成，请查看报告')+'；原有图层变化 '+(changes===null?'无法确认':changes)+' 项。'+baseline+
      (r.firstChangedStage?'首次变化：'+r.firstChangedStage+'。':'')+
      (r.ok&&changes===0?'图层状态未变不等于画面未被覆盖；请看透明中心和 Photoshop 图层眼睛。':'')+
      (r.receipt?.historyGrouped===true?'可在 Photoshop 历史面板撤销“V7 回图对照实验”。':'请在 Photoshop 历史面板核对实验步骤后撤销。');
  }
  function render(){for(const node of mounts){
    node.querySelectorAll('[data-return-field]').forEach(el=>{el.value=form[el.dataset.returnField];el.disabled=busy;});
    node.querySelector('[data-return-bind]').disabled=busy;
    node.querySelector('[data-return-run]').disabled=busy||!target;
    node.querySelector('[data-return-read]').disabled=busy||!target;
    node.querySelector('[data-return-copy]').disabled=!report||busy;
    node.querySelector('[data-return-doc]').textContent=target?target.name+' · 文档 '+target.docId:'未绑定文档';
    node.querySelector('[data-return-status]').textContent=busy?'正在执行，请勿重复回图…':summary(report);
    node.querySelector('[data-return-result]').value=report?JSON.stringify(report,null,2):'';
    node.querySelector('[data-return-preview]').src='assets/return-probes/'+form.imageKind+'.png';
  }}
  async function command(kind){
    if(busy)return;
    const generation=epoch,scope=host.scope?.();busy=true;render();
    try{
      const bind=kind==='bind',action=kind==='run'?'ps.returnProbe.run':'ps.returnProbe.snapshot';
      if(!bind&&!target)throw Error('先读取并绑定 Photoshop 当前文档');
      const data=await host.bridge(action,bind?{}:{docId:target.docId,...(kind==='run'?form:{})});
      if(generation!==epoch||scope!==host.scope?.())return;
      if(bind){target={docId:data.docId,name:data.document?.name||'Photoshop 文档'};report=data;}
      else if(kind==='read'&&report?.before)report={...report,manualAfter:data};
      else report=data;
      if(data?.ok===false)host.error?.(new Error(data.error?.message||'诊断未完成；请检查报告中的已置入图层，避免重复回图'));
    }catch(error){if(generation===epoch){const issue={message:String(error.message||error)};if(kind==='read'&&report?.before)report={...report,manualAfterError:issue};else report={ok:false,error:issue,notice:'此错误不能证明 Photoshop 未执行；检查原文档后再决定是否重试。'};host.error?.(error);}}
    finally{busy=false;render();}
  }
  function mount(node){
    node.classList.add('return-lab');node.dataset.bgkey='detail.debug.return-probe';
    node.innerHTML='<h3 class="settings-section-title">虚拟回图 · 图层显隐对照 '+help('不调用 AI、不计费。每次新增一张 256×256 测试图并缩放到目标区域。A 是问题对照；B 是正式回图默认并恢复原有图层显隐；C 跳过选择顶层，使用独立临时锚层后恢复显隐。')+'</h3>'+ 
      '<div class="return-lab-fields">'+Object.entries(choices).map(([key,rows])=>'<label><span>'+({strategy:'回图方案',imageKind:'测试素材',layerType:'输出图层',target:'放置区域'}[key])+'</span><select data-return-field="'+key+'">'+rows.map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')+'</select></label>').join('')+'</div>'+
      '<div class="return-lab-preview"><img width="72" height="72" data-return-preview alt="回图探针缩略图"><span>透明中心用来观察原图层</span></div>'+
      '<p data-return-doc></p><div class="settings-actions"><button class="settings-btn" data-return-bind>读取并绑定当前文档</button><button class="settings-btn" data-return-run>向已绑定文档回图</button><button class="settings-btn" data-return-read>重读该文档图层</button></div>'+
      '<p data-return-status role="status"></p><details><summary>前后图层与阶段报告</summary><textarea data-return-result readonly aria-label="回图诊断 JSON 报告" spellcheck="false"></textarea></details><button class="settings-btn" data-return-copy>复制诊断报告</button>';
    mounts.add(node);
    node.querySelectorAll('[data-return-field]').forEach(el=>el.addEventListener('change',()=>{form[el.dataset.returnField]=el.value;render();}));
    for(const action of ['bind','run','read'])node.querySelector('[data-return-'+action+']').onclick=()=>command(action);
    node.querySelector('[data-return-copy]').onclick=async()=>{try{await host.copy(JSON.stringify(report,null,2));node.querySelector('[data-return-status]').textContent='诊断报告已复制。';}catch(error){host.error?.(error);}};
    render();return()=>mounts.delete(node);
  }
  root.addEventListener('wheelchair:storage-context',()=>{epoch++;target=null;report=null;form={...defaults};render();});
  root.V7ReturnLab={configure:options=>{host=options;},mount};
})(window);
