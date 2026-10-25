// Load after workspace.js. Existing manager/studio classes keep this CSP-compatible.
(() => {
  if (document.getElementById('tab-storage')) return;
  const tab=document.createElement('button');tab.className='tab-btn';tab.dataset.tab='storage';tab.setAttribute('role','tab');tab.textContent='存储与配额';
  tab.addEventListener('click',()=>showTab('storage'));document.querySelector('.tabs').append(tab);
  const panel=document.createElement('section');panel.id='tab-storage';panel.className='tab manager';panel.hidden=true;
  panel.innerHTML=`<header class="manager-toolbar"><h2>存储与配额</h2><button id="stgRefresh">刷新</button><button id="stgOpen">打开当前输出目录</button><span id="stgStatus" role="status" aria-live="polite"></span></header><p id="stgCurrent" class="mute"></p><div class="studio-grid"><article class="studio-card"><h3>迁移输出目录</h3><p>选择新目录，先预检再明确确认。复制后逐文件校验 SHA-256，原目录完整保留。元数据和配置提交后必须在空闲时重启 helper；本页不会自动重启。</p><label class="field">新输出目录的绝对路径<input id="stgDestination" type="text" placeholder="/Volumes/External/ps-ai-bridge-new" autocomplete="off"></label><p class="mute">目标父目录必须已存在，新目录必须尚不存在。不能位于当前输出或应用数据目录内，也不能使用符号链接。</p><button id="stgPreflight">预检目录与空间</button><p id="stgPlan"></p><label class="check"><input id="stgConfirm" type="checkbox">确认复制到上述目录，并在验证后更新配置</label><button id="stgMigrate" disabled>复制、校验并提交迁移</button><div id="stgMigration"></div><button id="stgRollback" hidden>回滚当前迁移</button></article><article class="studio-card"><h3>预览与检查点配额</h3><p id="stgUsage"></p><label class="field">预览上限（MiB，0 不限额）<input id="stgPreviewLimit" type="number" min="0" step="1"></label><label class="field">检查点上限（MiB，0 不限额）<input id="stgCheckpointLimit" type="number" min="0" step="1"></label><button id="stgQuota">保存配额</button><p class="mute">超额会阻止新写入，不会删除旧文件。工具预览计输入和输出；修图仅计 output.png / layer.png，不计输入、参考图、中间文件和元数据。所有源图片与检查点受保护。</p><button id="stgProposal">生成清理建议（不删除）</button><div id="stgCleanup"></div></article></div>`;
  document.body.append(panel);
  let state=null,plan=null,busy=false,refreshing=false;
  const bytes=n=>`${(Number(n||0)/1024**2).toFixed(1)} MiB`;
  const message=text=>{$('stgStatus').textContent=text;};
  const guard=fn=>async()=>{if(busy)return;busy=true;try{await fn();}catch(e){message(reason(e));}finally{busy=false;}};
  function clearPlan(){plan=null;$('stgConfirm').checked=false;$('stgMigrate').disabled=true;$('stgPlan').textContent='';}
  async function refresh(){
    if(refreshing)return;refreshing=true;
    try{
      state=await api('GET','/storage');
      $('stgCurrent').textContent=`当前 helper：${state.outputDir}${state.requiresRestart?` · 下次启动：${state.configuredOutputDir}`:''}`;
      const q=state.quota;$('stgUsage').textContent=`工具预览与修图派生输出：${bytes(q.previewBytes)} · 检查点：${bytes(q.checkpointBytes)} · 输出目录：${bytes(q.outputBytes)}`;
      if(!['stgPreviewLimit','stgCheckpointLimit'].includes(document.activeElement?.id)){$('stgPreviewLimit').value=q.previewLimitBytes/1024**2;$('stgCheckpointLimit').value=q.checkpointLimitBytes/1024**2;}
      $('stgMigration').textContent=state.migration?`迁移 ${state.migration.id} · ${state.migration.status} · ${state.migration.fileCount} 个文件 · 清单：${state.migration.manifestPath}`:'';
      $('stgRollback').hidden=!state.migration?.canRollback;
      $('stgPreflight').disabled=!state.guardMounted||state.busy||!!state.blockedReason||state.active.length>0;
      if(state.busy)message(`迁移中：${state.progress?.stage||'准备'} · ${state.progress?.completed||0}/${state.progress?.total||0}`);
      else if(state.blockedReason)message(state.blockedReason);
      else if(!state.guardMounted)message('服务器尚未接入存储写入屏障，迁移不可用。');
      else if(state.active.length)message(`${state.active.length} 项活动任务或操作，请完成或暂停后再迁移。`);
    }catch(e){message(reason(e));}finally{refreshing=false;}
  }
  $('stgDestination').addEventListener('input',clearPlan);
  $('stgConfirm').addEventListener('change',()=>{$('stgMigrate').disabled=!plan||!$('stgConfirm').checked;});
  $('stgPreflight').addEventListener('click',guard(async()=>{
    clearPlan();message('正在预检目录、依赖和可用空间…');plan=await api('POST','/storage/preflight',{destination:$('stgDestination').value.trim()});
    $('stgPlan').textContent=`${plan.source} → ${plan.destination}；${plan.fileCount} 个文件，共 ${bytes(plan.bytes)}。更新 ${plan.metadataFiles} 个依赖记录及配置。目标需可用 ${bytes(plan.requiredDestinationBytes)}，保留原件；确认后执行。`;
    message('预检通过，请核对目标并勾选确认。');
  }));
  $('stgMigrate').addEventListener('click',guard(async()=>{
    if(!plan||!$('stgConfirm').checked)return;
    const token=plan.token;clearPlan();message('正在复制和校验；可在本页刷新进度。');
    const r=await api('POST','/storage/migrate',{token,confirmed:true});await refresh();message(`迁移状态：${r.status}。请在空闲时重启 helper，原目录已保留。`);
  }));
  $('stgRollback').addEventListener('click',guard(async()=>{
    if(!state?.migration||!window.confirm('确认恢复迁移前的元数据和配置？复制目录会保留；如配置已切换，回滚后仍需重启 helper。'))return;
    const r=await api('POST','/storage/rollback',{id:state.migration.id,confirmed:true});clearPlan();await refresh();message(r.requiresRestart?'回滚完成，请在空闲时重启 helper。':'回滚完成；原目录和复制文件均保留。');
  }));
  $('stgQuota').addEventListener('click',guard(async()=>{
    await api('POST','/storage/quota',{previewLimitBytes:Math.round(Number($('stgPreviewLimit').value)*1024**2),checkpointLimitBytes:Math.round(Number($('stgCheckpointLimit').value)*1024**2)});await refresh();message('配额已保存，不会自动删除任何图片。');
  }));
  $('stgProposal').addEventListener('click',guard(async()=>{
    const r=await api('GET','/storage/cleanup-proposal');
    $('stgCleanup').innerHTML=`<p>${esc(r.note)}</p><p>可审查的派生预览：${r.candidates.length} 个，${bytes(r.reclaimableBytes)}。受保护文件：${r.protectedFiles.length} 个；检查点 ${bytes(r.protectedCheckpointBytes)}。</p><ul>${r.candidates.slice(0,100).map(x=>`<li>${esc(x.path)} · ${bytes(x.bytes)}</li>`).join('')}</ul>${r.candidates.length>100?'<p>仅展示前 100 项。</p>':''}`;
    message('已生成建议，没有删除或移动文件。');
  }));
  $('stgRefresh').addEventListener('click',refresh);
  $('stgOpen').addEventListener('click',guard(()=>window.bridge.open('output')));
  document.addEventListener('workspace-tab',e=>{if(e.detail==='storage')refresh();});
  const timer=setInterval(()=>{if(!panel.hidden)refresh();},3000);window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});
})();
