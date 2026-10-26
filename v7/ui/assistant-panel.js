(function (root) {
  'use strict';
  const TIERS = { readonly: '只读与建议', preset_editor: '编辑预设文件', software_developer: '修改软件功能', administrator: '修改与删除软件文件' };
  let host = {}, assistant, transcript = [], scope = '', status = '尚未连接语言模型', modelRows = [], boundRoot = null;
  let draft = null, promptDraft = '', attachment = null, imageOmitted=false, attachmentEpoch=0, sessionEpoch = 0, upgradeNotified = '';
  let conversations = [], currentConversationId = '';
  let proactive=null,proactiveState={enabled:false,mode:'viewport',status:'off',suggestions:[]};
  let suggestionSource='local',suggestionEpoch=0,cloudGrant=null,sendEpoch=0;
  let sendPending=false,stateQueued=false,sendError=null;
  // ⭐ 2026-10-17 晚（用户：主卡要像「进程清单」—— 它调了什么工具、干了什么、接下来准备干什么）：
  //   activity = 每个工具调用 / 大脑中途说的话 / 全自动替你点的同意；plan = 大脑用 task_plan 写的计划；pendingAsk = 大脑用 ask_user 问的问题
  //   agentTurn = 夏三六正在跑一轮（只有这时候「全自动」才替你点同意；你自己在界面上点的删除、测试等照旧弹确认）
  let activity=[],plan=[],pendingAsk=null,agentTurn=false,activitySeq=0;
  const TOOL_SHORT={software_list_files:'查软件文件',software_read_file:'读软件文件',software_backups:'看恢复节点',software_upgrade_status:'看升级保留',software_diff:'看改动',
    preset_list:'找预设',preset_read:'读预设',preset_import:'导入预设',preset_backups:'看预设节点',preset_restore:'恢复预设',software_help_search:'查说明书',current_generation_status:'看生成状态',
    generation_prepare:'准备生成',generation_execute:'执行生成',eagle_catalog:'查 Eagle',eagle_archive_propose:'Eagle 归档',semantic_candidates:'SAM 3 找东西',semantic_apply_selection:'给你挑候选',
    canvas_look:'看画布',ps_select_shapes:'按坐标建选区'};
  const PARALLEL_TOOLS=new Set(['software_list_files','software_read_file','software_backups','software_upgrade_status','software_diff','preset_list','preset_read','preset_backups','software_help_search','current_generation_status','eagle_catalog']);
  const excerpt=(value,n)=>{const t=String(value??'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};
  function argsText(name,a){
    a=a||{};
    if(name==='canvas_look')return a.region?'放大 '+[a.region.left,a.region.top].join(',')+'～'+[a.region.right,a.region.bottom].join(','):(Array.isArray(a.marks)&&a.marks.length?'画框核对 '+a.marks.length+' 个':'整张');
    if(name==='ps_select_shapes')return (Array.isArray(a.shapes)?a.shapes.length:0)+' 个框'+(a.mode==='add'?'（加选）':'');
    if(name==='ps_action')return String(a.action||'');
    if(name==='ps_layer')return [a.op,a.name].filter(Boolean).join(' ');
    if(name==='settings_write')return Object.keys(a.changes||{}).join('、');
    if(name==='app_open')return a.tool?'工具 '+a.tool:[a.card,a.section].filter(Boolean).join(' / ');
    if(name==='task_action'||name==='records_action'||name==='trace_check'||name==='generation_refs')return String(a.op||'')+(a.taskId!=null?' #'+a.taskId:'');
    if(name==='generation_setup')return Object.keys(a).filter(k=>k!=='prompt').map(k=>k+'='+a[k]).concat(a.prompt!=null?['提示词']:[]).join(' ');
    const first=Object.values(a).find(v=>typeof v==='string'||typeof v==='number');
    return first==null?'':excerpt(first,36);
  }
  function logActivity(entry){activity.push({seq:++activitySeq,at:Date.now(),...entry});if(activity.length>80)activity=activity.slice(-80);notifyState();}
  function onToolEvent(e){
    if(e.name==='task_plan')return;   // 计划单独显示，不进过程
    if(e.type==='tool-start')logActivity({kind:'tool',id:e.id||'',name:e.name,label:TOOL_SHORT[e.name]||e.short||e.label||e.name,detail:argsText(e.name,e.args),state:'run'});
    else{
      const row=[...activity].reverse().find(r=>r.kind==='tool'&&r.state==='run'&&(e.id?r.id===e.id:r.name===e.name));
      const failed=e.result&&e.result.ok===false;
      const note=failed?excerpt(e.result.message||e.result.code||'没做成',60):e.result&&e.result.cancelled?'取消了':'';
      if(row){row.state=failed?'fail':'ok';row.ms=Number(e.ms)||0;row.note=note;notifyState();}
      else logActivity({kind:'tool',name:e.name,label:TOOL_SHORT[e.name]||e.name,detail:'',state:failed?'fail':'ok',ms:Number(e.ms)||0,note});
    }
  }
  const autoMode=()=>!!(agentPrefs&&agentPrefs.mode==='auto');
  const stateSubscribers=new Set();
  function publicText(value){
    const secrets=[assistant?.config?.apiKey,draft?.apiKey].concat(host.secrets?host.secrets():[]);
    return root.V7AssistantRuntime.scrub(String(value??''),secrets);
  }
  function deliverState(listener){
    try{listener(quickState());}catch(error){report(error);}
  }
  function notifyState(){
    if(stateQueued)return;stateQueued=true;
    queueMicrotask(()=>{stateQueued=false;root.dispatchEvent(new CustomEvent('wheelchair:assistant-state',{detail:quickState()}));for(const listener of [...stateSubscribers])deliverState(listener);});
  }
  function quickState(){
    const connection=connectionState();
    return {scope:secretScope(),sessionId:currentConversationId,sessionEpoch,status:publicText(status),...connection,model:publicText(connection.model),busy:sendPending||!!assistant?.busy,prompt:publicText(promptDraft),conversationTitle:publicText(currentConversation()?.title||'新会话'),conversations:conversations.map(row=>({id:row.id,title:publicText(row.title)})),messages:transcript.slice(-50).map(row=>({role:row.role,text:publicText(row.text),at:row.at})),hasAttachment:!!attachment,lastReply:publicText([...transcript].reverse().find(message=>message.role==='assistant')?.text||''),error:sendError?{code:publicText(sendError.code),message:publicText(sendError.message)}:null,
      activity:activity.slice(-40).map(r=>({seq:r.seq,at:r.at,kind:r.kind,name:r.name||'',label:publicText(r.label||''),detail:publicText(r.detail||''),state:r.state||'',ms:r.ms||0,note:publicText(r.note||''),text:publicText(r.text||'')})),
      plan:plan.map(s=>({text:publicText(s.text),status:s.status})),ask:pendingAsk?{question:publicText(pendingAsk.question),options:pendingAsk.options.map(publicText)}:null,auto:autoMode()};
  }
  function subscribe(listener){
    if(typeof listener!=='function')throw new TypeError('助手状态订阅需要一个回调函数');
    stateSubscribers.add(listener);deliverState(listener);
    return ()=>stateSubscribers.delete(listener);
  }
  const epochNow = () => ({ scope: storageKey(), epoch: sessionEpoch });
  const isCurrent = token => token.scope === storageKey() && token.epoch === sessionEpoch;
  const secretScope = () => root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.namespaceId() : 'anonymous';
  const escape = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function storageKey() { return root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.key('assistant.conversations.v1') : 'wheelchair.assistant.conversations.v1'; }
  function keyForSettings() { return storageKey().replace('conversations', 'connection'); }
  function report(e) { if (root.ERR) root.ERR.report('ASSISTANT_OPERATION_FAILED', { message: publicText(e && e.message || e), context: { code: publicText(e && e.code || '') } }); }
  async function confirm(title, body, button) {
    // ⭐ 2026-10-17 晚（用户：「即便我开了全部同意，就自动模式，它也还要同意。我希望在自动模式下就极其的自动」）：
    //   全自动 + 夏三六正在跑这一轮 → 替你点同意，并记进进程清单（不偷偷点）。你自己在界面上点的删除、测试等照旧弹确认。
    if (agentTurn && autoMode()) { logActivity({ kind: 'auto', text: '全自动：替你点了「' + (button || '同意') + '」——' + title }); traceNote('全自动替用户点了同意：' + (button || '同意') + ' —— ' + title); return true; }
    const token=epochNow(),version=sendEpoch;
    const ask = () => new Promise(resolve => {
      if (!root.UI || !root.UI.dialog) { resolve(false); return; }
      root.UI.dialog({ title, body, confirm: button || '同意', onConfirm: () => resolve(true), onCancel: () => resolve(false) });
    });
    const approved=await (root.V7FocusScope?.outsideModal ? root.V7FocusScope.outsideModal(ask) : ask());
    // Callers retain their account-change error; a cancelled turn in the same
    // session cannot act on its older approval.
    return !!approved&&(!isCurrent(token)||version===sendEpoch);
  }
  function storageLoad() {
    scope = storageKey();
    let saved;try { saved = JSON.parse(localStorage.getItem(scope) || 'null'); } catch (_) {}
    const messages = rows => (Array.isArray(rows) ? rows : []).filter(v => v && ['user', 'assistant', 'operation'].includes(v.role) && typeof v.text === 'string').slice(-200).map(v => ({role:v.role,text:v.text,at:Number(v.at)||Date.now()}));
    conversations=[];
    if(saved?.version===2 && Array.isArray(saved.conversations)){
      const ids=new Set();
      for(const row of saved.conversations){
        if(!row||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(row.id)||ids.has(row.id))continue;
        ids.add(row.id);conversations.push({id:row.id,title:String(row.title||'新会话').slice(0,60),messages:messages(row.messages),createdAt:Number(row.createdAt)||Date.now(),updatedAt:Number(row.updatedAt)||Date.now()});
      }
    }
    if(!conversations.length){const row=createConversation(Array.isArray(saved)&&saved.length?'之前的聊天':'新会话');row.messages=messages(saved);conversations.push(row);}
    currentConversationId=conversations.some(row=>row.id===saved?.activeId)?saved.activeId:conversations[0].id;
    transcript=currentConversation().messages;promptDraft='';
    if(Array.isArray(saved)&&saved.length)saveTranscript();
  }
  function createConversation(title='新会话'){return {id:root.crypto.randomUUID(),title,messages:[],createdAt:Date.now(),updatedAt:Date.now()};}
  function currentConversation(){return conversations.find(row=>row.id===currentConversationId);}
  function saveTranscript() {
    if (scope !== storageKey()) return;
    const row=currentConversation();if(!row)return;row.messages=transcript.slice(-200);
    try { localStorage.setItem(scope, JSON.stringify({version:2,activeId:currentConversationId,conversations:conversations.map(item=>({id:item.id,title:item.title,messages:item.messages.slice(-200),createdAt:item.createdAt,updatedAt:item.updatedAt}))})); } catch (e) { report(e); }
  }
  function add(role, text) {
    transcript.push({ role, text: assistant ? assistant.safe(String(text)) : String(text), at: Date.now() });
    const row=currentConversation();if(row){row.updatedAt=Date.now();if(role==='user'&&row.title==='新会话')row.title=transcript.at(-1).text.replace(/\s+/g,' ').slice(0,24)||'新会话';}
    saveTranscript(); renderMessages();renderConversations();notifyState();
  }
  function switchConversation(id,force=false){
    const next=conversations.find(row=>row.id===id);if(!next||(!force&&id===currentConversationId))return;
    const prior=currentConversation();if(prior)prior.draft=boundRoot?.querySelector('[data-assistant-prompt]')?.value||promptDraft;
    saveTranscript();
    const old=assistant,config=old?.config,verified=old?.verified;
    sessionEpoch++;stopSuggestions();stopImageAnalyses();clearPlans();if(old){old.onEvent=()=>{};old.stop().catch(report);}assistant=null;
    currentConversationId=id;transcript=next.messages;promptDraft=next.draft||'';removeImage();imageOmitted=false;activity=[];plan=[];pendingAsk=null;
    if(config?.baseUrl){const active=getAssistant();active.configure(config);if(verified===active.fingerprint())active.verified=verified;}
    status=connectionState().ready?'已切换会话 · 下一次发送前确认上下文':'已切换会话 · 请先连接语言模型';
    saveTranscript();renderMessages();renderConversations();renderStatus();
    if(boundRoot){boundRoot.querySelector('[data-assistant-prompt]').value=promptDraft;resetActionButtons();}
  }
  function resetActionButtons(){boundRoot?.querySelectorAll('button.settings-btn').forEach(button=>button.disabled=false);}
  function newConversation(){const row=createConversation();conversations.unshift(row);switchConversation(row.id);}
  function renameConversation(title){
    const row=currentConversation(),name=(assistant?assistant.safe(String(title??'')):String(title??'')).trim().slice(0,60);
    if(!row||!name)throw new Error('请填写会话名称');
    row.title=name;row.updatedAt=Date.now();saveTranscript();renderConversations();notifyState();return {ok:true};
  }
  async function deleteConversation(){
    const token=epochNow(),row=currentConversation();if(!row)return {ok:false};
    // ⭐ 2026-10-22（docs/263 第 6 条，用户拍板）：不再弹「无法恢复」的确认框 —— 先删，底部给「撤销」，点了把会话原样放回并切回去。
    //   会话只是本机的一份聊天记录，放得回去。
    if(!isCurrent(token))return {ok:false,cancelled:true};
    const index=conversations.findIndex(item=>item.id===row.id);
    conversations=conversations.filter(item=>item.id!==row.id);
    const placeholder=!conversations.length?createConversation():null;
    if(placeholder)conversations.push(placeholder);
    switchConversation(conversations[0].id);status='会话已删除';renderStatus();
    if(root.V7Undo)root.V7Undo.offer('已删除会话「'+publicText(row.title)+'」',()=>{
      if(conversations.some(item=>item.id===row.id))return;
      // 删完自动建的那个空会话还没用过就收掉，免得撤销后多出一个空会话
      if(placeholder&&!(placeholder.messages||[]).length)conversations=conversations.filter(item=>item.id!==placeholder.id);
      conversations.splice(Math.max(0,Math.min(conversations.length,index)),0,row);
      switchConversation(row.id,true);status='会话已放回';renderStatus();
    },{host:boundRoot?.closest?.('dialog[open]')||null});
    return {ok:true};
  }
  function renderConversations(){
    const list=boundRoot?.querySelector('[data-assistant-conversations]');if(!list)return;
    list.replaceChildren();
    for(const row of conversations){const button=document.createElement('button');button.type='button';button.className='assistant-conversation';button.dataset.assistantConversation=row.id;button.setAttribute('aria-current',String(row.id===currentConversationId));button.textContent=row.title;button.title=row.title;button.addEventListener('click',()=>{switchConversation(row.id);boundRoot?.querySelector('[data-assistant-conversation="'+row.id+'"]')?.focus();});list.append(button);}
    const title=boundRoot.querySelector('[data-assistant-conversation-title]');if(title&&document.activeElement!==title)title.value=currentConversation()?.title||'';
    renderContext();
  }
  function renderContext(){const el=boundRoot?.querySelector('[data-assistant-context]');if(el)el.textContent='当前上下文：本会话文字'+(attachment?'、已附加的 Photoshop 画布':'；未附加画布')+'。可按授权读取软件说明、预设和软件文件。';}
  function tool(name, label, properties, required, run) { return { name, label, description: label, parameters: { type: 'object', properties, required, additionalProperties: false }, run }; }
  const string = { type: 'string' };
  const RECT = { left: { type: 'number' }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' } };
  function agentCall(method, value) {
    if (!root.uiwin || !root.uiwin.agent || !root.uiwin.agent[method]) throw new Error('当前桌面版本未连接 Agent 工具');
    return root.uiwin.agent[method](value);
  }
  // 生成的扣费确认：全自动 + 夏三六正在跑 → 不弹框直接执行（照样扣费，记进进程清单）；其余照旧弹确认
  function generationHost() {
    const g = host.generation; if (!g) return g;
    return { ...g, confirm: async preview => {
      if (agentTurn && autoMode()) { logActivity({ kind: 'auto', text: '全自动：没问你，直接生成 ' + preview.count + ' 次（预计 ' + preview.cost + '）' }); traceNote('全自动直接生成（没弹扣费确认）', { count: preview.count, cost: preview.cost, preset: preview.preset }); return true; }
      return g.confirm(preview);
    } };
  }
  // 工具箱（agent-tools.js）：PS 全套、引擎查修、上网、写计划、问用户
  // ⭐ 2026-10-17 夜 + 软件接口（agent-app-tools.js）：设置 / 账号 / 生图模型 / 任务栏 / 记录 / 抠像人体解析 / 痕迹检测 / 示波器
  //   接线由 ui.html 的 agentAppHost() 经 configure({app}) 交进来；note = 改了东西记进对话（换了会话就不记）
  function extraTools(token) {
    const out = [];
    if (root.V7AgentTools) {
      try { out.push(...root.V7AgentTools.build({ setPlan: steps => { plan = steps; notifyState(); }, mode: () => agentPrefs ? agentPrefs.mode : '', status: host.status ? () => host.status() : null })); }
      catch (e) { report(e); }
    }
    if (root.V7AgentAppTools && host.app) {
      try { out.push(...root.V7AgentAppTools.build({ ...host.app, note: text => { if (isCurrent(token)) add('operation', text); } })); }
      catch (e) { report(e); }
    }
    return out;
  }
  function availableTools() {
    const token = epochNow();
    const generation = host.generation ? generationHost() : null;
    if (generation && root.V7AssistantGeneration && !host.generationController) host.generationController = root.V7AssistantGeneration.create(generation);
    return [
      tool('software_list_files', '查找软件文件', { path: string, recursive: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['path'], a => agentCall('listFiles', a)),
      tool('software_read_file', '读取软件文件', { path: string }, ['path'], a => agentCall('readFile', a)),
      tool('software_apply_changes', '先备份，再修改软件文件', {
        reason: string, changes: { type: 'array', maxItems: 100, items: { type: 'object', properties: { path: string, operation: { type: 'string', enum: ['write', 'delete'] }, content: string }, required: ['path', 'operation'], additionalProperties: false } }
      }, ['reason', 'changes'], async a => {
        const paths = Array.isArray(a.changes) ? a.changes.map(change => String(change.path || '')).join('\n') : '';
        if (!await confirm('确认本次软件修改', String(a.reason || '修改软件界面') + '\n\n' + paths + '\n\n修改前会保存恢复节点，重新打开软件后加载修改。', '备份并修改')) return { ok: false, code: 'USER_DECLINED' };
        if (!isCurrent(token)) return { ok: false, code: 'ASSISTANT_SESSION_CHANGED' };
        const result = await agentCall('applyChanges', a);
        if (result.ok && isCurrent(token)) add('operation', '软件修改已保存。恢复节点：' + result.backupId + '\n' + (result.diff.changes || []).map(c => c.status + ' ' + c.path).join('\n'));
        return result;
      }),
      tool('software_backups', '列出软件恢复节点', {}, [], () => agentCall('listBackups')),
      tool('software_upgrade_status', '查看官方升级后的修改保留和冲突归档结果', {}, [], () => agentCall('upgradeStatus')),
      tool('software_diff', '查看恢复节点之后的改动', { backupId: string }, ['backupId'], a => agentCall('diff', a.backupId)),
      tool('software_restore', '恢复软件备份节点', { backupId: string }, ['backupId'], async a => {
        if (!await confirm('恢复软件修改', '将恢复到所选节点；恢复前还会保存当前版本。用户图片和缓存不在恢复范围内。', '恢复')) return { ok: false, code: 'USER_DECLINED' };
        if (!isCurrent(token)) return { ok: false, code: 'ASSISTANT_SESSION_CHANGED' };
        const result = await agentCall('rollback', a);
        if (result.ok && isCurrent(token)) add('operation', '已恢复到节点 ' + a.backupId + '。恢复前节点：' + result.beforeBackupId);
        return result;
      }),
      tool('preset_list', '查找当前用户的预设', { query: string }, [], a => {
        const q = String(a.query || '').toLowerCase();
        return { presets: (root.PRESETS ? root.PRESETS.presets() : []).filter(p => !root.PRESETS.visible || root.PRESETS.visible(p)).filter(p => !q || [p.title, p.content].join(' ').toLowerCase().includes(q)).slice(0, 100).map(p => ({ id: p.id, title: p.title, kind: p.kind, category: p.category, provider: p.provider })) };
      }),
      tool('preset_read', '读取指定预设的提示词和公开参数', { id: string }, ['id'], a => {
        const p = root.PRESETS && root.PRESETS.presetById(String(a.id));
        return p ? { id: p.id, title: p.title, kind: p.kind, content: p.content, category: p.category, provider: p.provider, model: p.model } : { ok: false, code: 'PRESET_NOT_FOUND' };
      }),
      tool('preset_import', '按标准导入助手写好的预设，包含名字、写作时间和作者；先保存预设恢复节点，要求用户已授予编辑预设权限', {
        name: string, createdAt: string, author: string, preset: { type: 'object' }
      }, ['name', 'createdAt', 'author', 'preset'], async a => {
        if (!root.V7AgentPresets) return { ok: false, code: 'AGENT_PRESET_UNAVAILABLE' };
        const result = await root.V7AgentPresets.import(a);
        if (result.ok && !result.skipped && isCurrent(token)) add('operation', '预设已导入 Agent 预设区：' + (result.preset && result.preset.title || a.name) + '。预设恢复节点：' + result.backupId);
        return result;
      }),
      tool('preset_backups', '列出预设库恢复节点（与软件文件备份分开）', {}, [], () => root.V7AgentPresets ? root.V7AgentPresets.listBackups() : { ok: false, code: 'AGENT_PRESET_UNAVAILABLE' }),
      tool('preset_restore', '经用户确认恢复指定预设节点，已有更新时拒绝覆盖', { backupId: string }, ['backupId'], async a => {
        if (!root.V7AgentPresets) return { ok: false, code: 'AGENT_PRESET_UNAVAILABLE' };
        if (!await confirm('恢复预设库', '恢复所选的预设修改节点。已有更新时会拒绝覆盖；软件代码和图片不在本次恢复范围内。', '恢复预设')) return { ok: false, code: 'USER_DECLINED' };
        if (!isCurrent(token)) return { ok: false, code: 'ASSISTANT_SESSION_CHANGED' };
        const result = await root.V7AgentPresets.rollback({ backupId: a.backupId, confirm: true });
        if (result.ok && isCurrent(token)) add('operation', '已恢复预设库节点：' + a.backupId + '；恢复前节点：' + result.beforeBackupId);
        return result;
      }),
      tool('software_help_search', '检索软件使用说明（尚未导入作者正式修图课程）', { query: string }, [], a => {
        if (!host.knowledge) return { entries: [], message: '使用说明尚未加载' };
        return { entries: host.knowledge.search(a.query), authorCurriculumAvailable: false };
      }),
      tool('current_generation_status', '读取当前生成设置与任务状态，不含密钥', {}, [], () => host.status ? host.status() : { ok: false, code: 'STATUS_UNAVAILABLE' }),
      tool('generation_prepare', '根据当前 Photoshop 画布/选区准备生成方案，只返回预设、部位、次数、费用和时间；不会扣费或生成', {
        count: { type: 'integer', minimum: 1, maximum: 18 }, presetId: string
      }, ['count'], async a => {
        if (!generation || !root.V7AssistantGeneration) return { ok: false, code: 'GENERATION_UNAVAILABLE' };
        const presetId = String(a.presetId || (root.PRESETUI && root.PRESETUI.prompt && root.PRESETUI.prompt.presetId) || '');
        const preset = root.PRESETS && root.PRESETS.presetById(presetId);
        // ⭐ 2026-10-20（docs/256 F3，用户报「Cannot read properties of null (reading 'prepare')」）：
        //   控制器在 clearPlans()（换授权方式 / 换连接 / 关面板）时会被清成 null，工具清单却还是之前那份 ——
        //   原来这里直接 .prepare()，5 毫秒就崩；「执行」那个工具一直有这句补建，这里漏了。
        if (!host.generationController) host.generationController = root.V7AssistantGeneration.create(generation);
        return host.generationController.prepare({ count: a.count, presetId, presetTitle: preset && preset.title || (root.PRESETUI && root.PRESETUI.getPresetTitle && root.PRESETUI.getPresetTitle()) || '当前预设' });
      }),
      tool('generation_execute', '执行已准备好的生成方案（planId 来自 generation_prepare）：「每步都问 / 开工前问一次」会弹确认框让用户点；「全自动」直接执行（照样扣费，记进进程清单）。目标图或账号变了会拦下', { planId: string }, ['planId'], async a => {
        if (!generation || !root.V7AssistantGeneration) return { ok: false, code: 'GENERATION_UNAVAILABLE' };
        // Each assistant session gets a private controller so a model cannot
        // execute a plan prepared by a different account/session.
        if (!host.generationController) host.generationController = root.V7AssistantGeneration.create(generation);
        return host.generationController.execute(a.planId);
      }),
      tool('eagle_catalog', '读取已配对Eagle资料库的当前选中项或按关键词查找，只返回条目名称、标签和分类，不读取图片文件', { query: string }, [], a => root.V7EagleUI ? root.V7EagleUI.catalog(a.query || '') : { ok: false, code: 'EAGLE_UNAVAILABLE' }),
      tool('eagle_archive_propose', '准备Eagle新增标签或移动分类清单，必须由用户在本机界面及Eagle中确认后执行；不能删除、改名或覆盖条目', { itemIds: { type: 'array', items: string, minItems: 1, maxItems: 50 }, addTags: { type: 'array', items: string }, fromFolderId: string, toFolderId: string }, ['itemIds'], a => root.V7EagleUI ? root.V7EagleUI.propose(a) : { ok: false, code: 'EAGLE_UNAVAILABLE' }),
      // ⭐ 2026-10-17（用户：「放开找东西的词条」）：除了 11 个中文词，也认任意英文物体名（semantic-selection.js partOf）
      tool('semantic_candidates', '用本机 SAM 3 按名字找画面里的东西，返回实际检测到的候选框（rect 是原图像素坐标）和把握度。part 可以是这 11 个中文词：人物、服装、上衣、裤子、连衣裙、脸、头发、手、手臂、腿、鞋；别的东西直接写英文名（例如 phone、bag、cable、hairpin）。找不到就是找不到：不准换成别的东西凑数，先告诉用户', { part: string, docId: { type: 'integer' } }, ['part'], async a => {
        if (!root.V7SemanticSelection) return { ok: false, code: 'SEMANTIC_UNAVAILABLE' };
        const found = await root.V7SemanticSelection.suggest(a);
        // 记下是哪张图：之后按候选框坐标建选区（ps_select_shapes）要对得上号
        const d = found && found.document;
        if (d && root.V7AgentLook) root.V7AgentLook.remember({ docId: d.docId, docName: d.docName, docWidth: d.width, docHeight: d.height });
        return found;
      }),
      // ⭐ 2026-10-17 夜（用户：「选区尽可能的是正方形，并且多包裹一点……方便后续抠擦」）：夏三六走这条时也做成正方形 + 往外多包
      //   （agent-look.js squareFit）。预览里的滑条 = 往外多包物体长边的百分之几，用户拖到 0 就是不多包（只做正方形）。
      tool('semantic_apply_selection', '展示候选区域，请用户选人物、确认外扩范围后在 Photoshop 建立选区。软件会做成正方形并往外多包一圈（marginPercent = 每边多包物体长边的百分之几，默认 15），预览里用户还能再调', { candidateId: string, marginPercent: { type: 'number', minimum: 0, maximum: 50 } }, ['candidateId'], async a => {
        if (!root.V7SemanticSelection) return { ok: false, code: 'SEMANTIC_UNAVAILABLE' };
        const L = root.V7AgentLookCore;
        const fit = L ? (rect, percent, width, height) => {
          const p = Math.max(0, Math.min(50, Number(percent) || 0));
          const f = L.squareFit(rect, width, height, { padPercent: p, minPadPx: p > 0 ? L.FIT.minPadPx : 0 });
          return { left: f.left, top: f.top, right: f.right, bottom: f.bottom, width: f.right - f.left, height: f.bottom - f.top,
            caption: '将建立 ' + (f.right - f.left) + ' × ' + (f.bottom - f.top) + ' 像素' + (f.square ? '正方形' : '矩形') + ' · 往外多包物体长边的 ' + p + '%（贴着画布边会整块往里挪）' + (f.notes.length ? ' · ' + f.notes.join('；') : '') };
        } : null;
        const result = await root.V7SemanticSelection.apply({ ...a, marginPercent: a.marginPercent == null ? (L ? L.FIT.padPercent : undefined) : a.marginPercent, confirm: true, ...(fit ? { fit } : {}) });
        if (isCurrent(token) && result.ok && result.applied) add('operation', '已在 Photoshop 建立确认过的选区：' + result.part + '；' + (fit ? '正方形，往外多包物体长边的 ' : '每边外扩 ') + result.marginPercent + '%。尚未发起生成。');
        return result;
      }),
      // ⭐ 2026-10-17（用户：「我要求我们的Agent能够把图片拉出来计算出坐标」）：看图量坐标 + 按坐标建选区（agent-look.js）
      tool('canvas_look', '看画布、量坐标：把 Photoshop 画布（整张，或用 region 放大某一块）拉出来给你看，图四周有标着【原图像素坐标】的刻度尺和格线，读刻度就是原图坐标。用 marks 可以把打算框的位置画成彩色框再看一遍核对。只读：不改图、不花积分（每看一次会多发一张图给大脑）', {
        region: { type: 'object', description: '要放大看的那一块（原图像素坐标）；不给就看整张', properties: RECT, required: ['left', 'top', 'right', 'bottom'], additionalProperties: false },
        marks: { type: 'array', maxItems: 5, description: '画在图上核对用的框（原图像素坐标），按顺序是红、蓝、黄、绿、粉', items: { type: 'object', properties: { ...RECT, label: string, shape: { type: 'string', enum: ['rect', 'ellipse'] } }, required: ['left', 'top', 'right', 'bottom'], additionalProperties: false } },
        docId: { type: 'integer' }
      }, [], a => root.V7AgentLook ? root.V7AgentLook.look(a) : { ok: false, code: 'AGENT_LOOK_UNAVAILABLE' }),
      // ⭐ 2026-10-17 夜：默认做成正方形 + 往外多包（agent-look.js squareFit）；exact 只在用户明说「就按这个框」时用
      tool('ps_select_shapes', '按原图像素坐标在 Photoshop 建选区：给几个框就合并成一个选区；mode=add 是加到原来的选区上。⭐ 你给【紧贴物体】的框就行：软件会自动把每个框做成正方形、往外多包一圈（每边多包物体长边的 padPercent%，默认 15、最少 10；贴着画布边会整块往里挪；一定把东西整个包住），方便后面抠和擦，别自己再留边。exact=true 是原样建（只在用户明确要求「就按这个框」时用）。只建选区：不动像素、不动图层、不花积分，用户 Ctrl+Z 能撤；建完软件会回读核对。坐标要先用 canvas_look 量过（最好用 marks 核对过），或者用 semantic_candidates 找到的框', {
        shapes: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { ...RECT, shape: { type: 'string', enum: ['rect', 'ellipse'] } }, required: ['left', 'top', 'right', 'bottom'], additionalProperties: false } },
        mode: { type: 'string', enum: ['replace', 'add'] }, docId: { type: 'integer' },
        padPercent: { type: 'number', minimum: 10, maximum: 100 }, exact: { type: 'boolean' }
      }, ['shapes'], async a => {
        if (!root.V7AgentLook) return { ok: false, code: 'AGENT_LOOK_UNAVAILABLE' };
        const result = await root.V7AgentLook.select(a);
        if (isCurrent(token) && result.ok) add('operation', '夏三六按坐标在 Photoshop 建了选区：' + (result.shapes || []).map(s => (s.shape === 'ellipse' ? '椭圆 ' : '矩形 ') + s.left + ',' + s.top + '～' + s.right + ',' + s.bottom + '（' + (s.right - s.left) + '×' + (s.bottom - s.top) + '）').join('；') +
          (result.fit === 'square' ? '，已做成正方形并往外多包物体长边的 ' + result.padPercent + '%' : '，按给的框原样建') + (result.fitNotes ? '（' + result.fitNotes.join('；') + '）' : '') +
          (result.verified ? '（已回读核对）' : '（这台 Photoshop 读不回选区，没法核对，请看一眼）') + '。没动像素和图层，可以 Ctrl+Z 撤销。');
        return result;
      })
    ].concat(extraTools(token)).map(t => ({ ...t, parallel: !!(t.parallel || PARALLEL_TOOLS.has(t.name)), run: a => isCurrent(token) ? t.run(a) : { ok: false, code: 'ASSISTANT_SESSION_CHANGED' } }));
  }
  // ⭐ 2026-10-17 夜（用户：「能够直接读取这个助手的提示词和调用工具的状态……看看它卡在哪了」）：黑匣子（agent-trace.js）。
  //   全程只建一个；每件事一行写进磁盘（uiwin.agentTrace.append，两壳都有），写不进去也不耽误干活（只在 live() 里报 sinkError）。
  let traceRec = null;
  function traceRecorder() {
    if (traceRec || !root.V7AgentTrace) return traceRec;
    traceRec = root.V7AgentTrace.recorder({
      sink: (day, line) => root.uiwin && root.uiwin.agentTrace && root.uiwin.agentTrace.append ? root.uiwin.agentTrace.append(day, line) : { ok: false, error: '这个版本没有黑匣子写盘接口' },
      context: () => ({ mode: agentPrefs ? agentPrefs.mode || '' : '', care: agentPrefs ? agentPrefs.care || '' : '', fallback: agentPrefs ? agentPrefs.fallback || '' : '', conversation: currentConversationId, scope: secretScope() })
    });
    return traceRec;
  }
  function traceNote(text, extra) { try { if (traceRecorder()) traceRecorder().note(text, extra); } catch (_) {} }
  function getAssistant() {
    if (assistant) return assistant;
    if (!root.uiwin || !root.uiwin.http) throw new Error('请在桌面软件内连接助手');
    const createdScope = epochNow();
    assistant = new root.V7AssistantRuntime.Assistant({ http: root.uiwin.http, tools: agentTools(), trace: traceRecorder(), secrets: () => host.secrets ? host.secrets() : [], onEvent: e => {
      if (!isCurrent(createdScope)) return;
      if (e.type === 'user' || e.type === 'assistant') add(e.type, e.text);
      if (e.type === 'assistant' && e.text) logActivity({ kind: 'say', text: excerpt(e.text, 90) });
      if (e.type === 'user' && e.text) logActivity({ kind: 'user', text: excerpt(String(e.text).split('\n[附加画布')[0], 60) });
      if (e.type === 'tool-start' || e.type === 'tool-end') onToolEvent(e);
      if (e.type === 'tool-start') { status = TOOL_SHORT[e.name] || e.label; renderStatus(); }
      if (e.type === 'tool-end') { status = e.result && e.result.ok === false ? '操作未完成，正在解释原因…' : '正在整理结果…'; renderStatus(); }
    } });
    assistant.messages = transcript.filter(m => m.role === 'user' || m.role === 'assistant').slice(-60).map(m => ({ role: m.role, text: m.text }));
    applyAgentPrefsTo(assistant);
    return assistant;
  }
  // ⭐ 夏三六（2026-10-17，docs/231）：中间人 V7AgentService 把用户选的工作方式交过来以后，
  //   ① 系统提示词换成夏三六的（agent-prompt.js），② 思考强度按设置发，
  //   ③ 「改软件文件 / 恢复软件备份」两个工具不交给大脑 —— 用户定：夏三六只修环境、不改软件代码。
  //   ⚠ 没交过工作方式（老测试单独加载本文件时）一切照旧，工具不删。
  const AGENT_BLOCKED_TOOLS = ['software_apply_changes', 'software_restore'];
  let agentPrefs = null;
  function agentTools() { const all = availableTools(); return agentPrefs ? all.filter(t => !AGENT_BLOCKED_TOOLS.includes(t.name)) : all; }
  function applyAgentPrefsTo(a) {
    if (!a || !agentPrefs) return;
    if (root.V7AgentPrompt) a.setSystem(root.V7AgentPrompt.build(agentPrefs));
    if (typeof a.setReasoning === 'function') a.setReasoning(agentPrefs.reasoning || '');
    // 一轮能转多少圈：全自动要「自己想办法」，多给（循环上限只是防死循环的保险）
    if (typeof a.setMaxRounds === 'function') a.setMaxRounds(agentPrefs.mode === 'auto' ? 60 : 24);
    a.tools = agentTools();
  }
  function applyAgentPrefs(prefs) { agentPrefs = { ...(prefs || {}) }; applyAgentPrefsTo(assistant); return { ok: true }; }
  async function probeCapabilities() {
    const token = epochNow();
    let a; try { a = getAssistant(); a.configure(configFromPanel()); } catch (e) { return { ok: false, code: 'ASSISTANT_UNAVAILABLE', message: publicText(e && e.message || e) }; }
    if (!a.verified || a.verified !== a.fingerprint()) return { ok: false, code: 'ASSISTANT_NOT_VERIFIED', message: '请先选择模型并通过连接测试' };
    if (!await confirm('能力自测', '会向「' + publicText(a.config.model) + '」发 2 个很小的请求：一个测会不会调工具，一个带一张 8×8 的小图测能不能看图。可能产生几分钱费用。', '开始自测')) return { ok: false, cancelled: true };
    if (!isCurrent(token)) return { ok: false, cancelled: true };
    try { const result = await a.probe(true); return isCurrent(token) ? { ok: true, result } : { ok: false, cancelled: true }; }
    catch (e) { return { ok: false, code: publicText(e && e.code || 'PROBE_FAILED'), message: publicText(e && e.message || e) }; }
  }
  async function captureCanvas() {
    try { await prepareCanvas(); return { ok: !!attachment }; }
    catch (e) { report(e); return { ok: false, message: publicText(e && e.message || e) }; }
  }
  function attachmentPreview() {
    if (!attachment) return null;
    return { src: attachment.thumbId && root.IMG ? root.IMG.thumb(attachment.thumbId) : '', name: publicText(attachment.docName || '当前画布'), width: attachment.width, height: attachment.height };
  }
  function invalidateSend(){sendEpoch++;attachmentEpoch++;sendPending=false;sendError=null;if(assistant&&assistant.busy)assistant.stop().catch(report);notifyState();}
  function clearPlans(){invalidateSend();if(host.generationController){host.generationController.clear();host.generationController=null;}}
  function fullMarkup() {
    return '<section class="settings-section" data-assistant-panel><div class="settings-section-title">修图助手</div>' +
      '<div class="settings-note">连接成功后，可以查用法、写提示词、检查软件并按授权修改。课程修图知识仅学生可用；作者正式课程尚未导入时，助手会说明。每个会话在本机保留最近 200 条记录，不上传账号备份。</div>' +
      '<details><summary>连接语言模型</summary><div class="settings-grid">' +
      '<label class="settings-field"><span>服务商地址</span><input data-assistant-url type="url" placeholder="沿用生图服务商的 API 地址"></label>' +
      '<label class="settings-field"><span>API Key</span><input data-assistant-key type="password" autocomplete="off" placeholder="连接测试成功后安全保存在本机"></label>' +
      '<label class="settings-field"><span>接口类型</span><select data-assistant-protocol><option value="openai">GPT 兼容接口（多数中转站）</option><option value="gemini">Gemini 原生接口</option><option value="anthropic">Claude 原生接口</option></select></label></div>' +
      '<div class="settings-actions"><button class="settings-btn" data-assistant-copy>沿用当前生图连接</button><button class="settings-btn" data-assistant-discover>读取语言模型</button></div>' +
      '<label class="settings-field"><span>筛选出的语言模型</span><select data-assistant-model><option value="">先读取模型列表</option></select></label>' +
      '<label class="settings-field"><span>或填写服务商给出的模型名</span><input data-assistant-model-manual placeholder="列表未列出时使用"></label>' +
      '<div class="settings-note">模型标签仅供选择参考；价格以服务商为准。点选模型后，经你同意才会发起少量 Token 的真实测试；测试失败不会显示连接成功。</div>' +
      '<div class="settings-actions"><button class="settings-btn" data-assistant-test>测试填写的模型</button><button class="settings-btn" data-assistant-forget-key>删除本机助手 Key</button></div></details>' +
      '<div class="settings-status" data-assistant-status role="status"></div>' +
      '<div class="assistant-suggestions"><label class="settings-field assistant-suggestion-toggle"><span>启用预设建议</span><input data-assistant-proactive type="checkbox"></label><label class="settings-field"><span>建议来源</span><select data-assistant-suggestion-source><option value="local">本机语义识别</option><option value="cloud">所选语言模型</option></select></label><label class="settings-field"><span>关注范围</span><select data-assistant-focus><option value="viewport">Photoshop 可见区域</option><option value="selection">当前手动选区</option></select></label><div class="settings-note" data-assistant-proactive-status></div><div data-assistant-suggestions></div></div>' +
      '<div class="assistant-transcript" data-assistant-messages aria-live="polite"></div>' +
      '<label class="settings-field"><span>告诉助手你想做什么</span><textarea data-assistant-prompt rows="4" placeholder="例如：帮我写一段修脸提示词，保留皮肤质感"></textarea></label>' +
      '<div data-assistant-attachment></div><div class="settings-actions"><button class="settings-btn" data-assistant-capture>附加 PS 当前画布</button><button class="settings-btn" data-assistant-remove-image>移除画布</button></div>' +
      '<div class="settings-actions"><button class="settings-btn" data-assistant-send>发送</button><button class="settings-btn" data-assistant-stop>停止回答</button><button class="settings-btn" data-assistant-new>新会话</button><button class="settings-btn danger" data-assistant-clear>清空当前聊天</button></div>' +
      '<details><summary>Agent 权限与软件恢复</summary><label class="settings-field"><span>本次访问范围</span><select data-agent-tier>' + Object.entries(TIERS).map(([key, label]) => '<option value="' + key + '">' + label + '</option>').join('') + '</select></label>' +
      '<button class="settings-btn" data-agent-grant>设置访问范围</button><div class="settings-note" data-agent-current></div>' +
       '<div class="settings-note">编辑前自动保存恢复节点；权限由桌面授权窗口确认，30 分钟后失效。修改软件代码可能影响软件运行。文件工具限制不等于修改后代码的系统沙箱。</div>' +
       '<button class="settings-btn" data-agent-refresh>查看恢复节点</button><div class="settings-note" data-agent-upgrade></div><div data-agent-backups></div></details></section>';
  }
  function markup() {
    return '<section class="settings-section assistant-launcher" data-assistant-launcher>' +
      '<div class="settings-section-title">修图助手</div>' +
      '<div class="settings-note">助手在独立工作面中运行，可分别管理不同会话。每个会话最近 200 条聊天记录仅保存在本机。</div>' +
      '<div class="settings-actions"><button type="button" class="settings-btn" data-assistant-open>打开助手工作面</button></div>' +
      '<div class="settings-status" data-assistant-launch-status role="status"></div></section>';
  }
  function prepareWorkbench(dialog) {
    const panel = dialog.querySelector('[data-assistant-panel]');
    if (!panel) return;
    const controls = document.createElement('aside'); controls.className = 'assistant-workbench-controls'; controls.setAttribute('aria-label', '助手配置');
    const conversation = document.createElement('div'); conversation.className = 'assistant-workbench-conversation';
    const compose = document.createElement('div'); compose.className = 'assistant-workbench-compose';
    const transcript = panel.querySelector('[data-assistant-messages]');
    const prompt = panel.querySelector('[data-assistant-prompt]')?.closest('label');
    const attachmentHost = panel.querySelector('[data-assistant-attachment]');
    const captureActions = panel.querySelector('[data-assistant-capture]')?.closest('.settings-actions');
    const sendActions = panel.querySelector('[data-assistant-send]')?.closest('.settings-actions');
    const status = panel.querySelector('[data-assistant-status]');
    const suggestions = panel.querySelector('.assistant-suggestions');
    const suggestionDetails = document.createElement('details'); suggestionDetails.dataset.assistantSuggestionsConfig = '';
    suggestionDetails.innerHTML = '<summary>预设建议</summary>'; suggestionDetails.append(suggestions);
    panel.querySelector('.settings-section-title')?.remove();
    const connection = panel.querySelector('details'); connection.dataset.assistantConnectionConfig = '';
    panel.querySelectorAll('details').forEach(el => el.classList.add('assistant-config-group'));
    suggestionDetails.className = 'assistant-config-group';
    [...panel.children].forEach(child => {
      if (child === transcript || child === prompt || child === attachmentHost || child === captureActions || child === sendActions || child === status) return;
      controls.append(child);
    });
    connection.after(suggestionDetails);
    const sessions=document.createElement('details');sessions.className='assistant-config-group assistant-session-manager';sessions.open=true;
    sessions.innerHTML='<summary>会话</summary><div class="settings-actions assistant-session-actions" data-assistant-session-actions></div><nav class="assistant-conversations" data-assistant-conversations aria-label="本机助手会话"></nav><label class="settings-field"><span>会话名称</span><input data-assistant-conversation-title maxlength="60" placeholder="给这个会话起个名字"></label><div class="settings-actions"><button type="button" class="settings-btn" data-assistant-rename>重命名</button><button type="button" class="settings-btn danger" data-assistant-delete>删除会话</button></div>';
    sessions.querySelector('[data-assistant-session-actions]').append(sendActions.querySelector('[data-assistant-new]'),sendActions.querySelector('[data-assistant-clear]'));
    controls.prepend(sessions);
    const context=document.createElement('p');context.className='settings-note assistant-context';context.dataset.assistantContext='';
    [attachmentHost, prompt, captureActions, sendActions].forEach(child => { if (child) compose.append(child); });
    conversation.append(status,context,transcript,compose); panel.append(controls, conversation);
  }
  function open(section) {
    if(typeof host.navigate==='function')return host.navigate(typeof section==='string'?section:'chat');
    return openWorkspace();
  }
  function openWorkspace() {
    const old = document.querySelector('dialog.assistant-workbench[open]');
    if (old) { old.querySelector('[data-assistant-prompt]')?.focus(); return old; }
    const dialog = document.createElement('dialog'); dialog.className = 'assistant-workbench'; dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'assistant-workbench-title');
    dialog.innerHTML = '<header class="assistant-workbench-heading"><div><h2 id="assistant-workbench-title">修图助手</h2><p>用文字提问，按需附加当前画布。</p></div><button type="button" class="settings-btn" data-assistant-close>关闭</button></header>' + fullMarkup();
    document.body.append(dialog); prepareWorkbench(dialog); dialog.showModal();
    dialog.querySelector('[data-assistant-close]').addEventListener('click', () => close());
    dialog.addEventListener('close', () => { if (dialog.dataset.v7ModalSuspended) return; if (boundRoot && dialog.contains(boundRoot)) boundRoot = null; dialog.remove(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    mount(dialog); dialog.querySelector('[data-assistant-prompt]')?.focus(); return dialog;
  }
  function close(options={}) { const dialog = document.querySelector('dialog.assistant-workbench[open]'); if (dialog) { if(options.restore===false)dialog.dataset.assistantReturnSuppressed='1';dialog.close(); } if (boundRoot && !boundRoot.isConnected) boundRoot = null; }
  function renderStatus() {
    const el = boundRoot && boundRoot.querySelector('[data-assistant-status]'); if (el) el.textContent = status;
    document.querySelectorAll?.('[data-assistant-launch-status]').forEach(label => { label.textContent = status; });
    notifyState();
  }
  function renderSuggestions(){
    if(!boundRoot)return;
    const toggle=boundRoot.querySelector('[data-assistant-proactive]'),mode=boundRoot.querySelector('[data-assistant-focus]'),label=boundRoot.querySelector('[data-assistant-proactive-status]'),rows=boundRoot.querySelector('[data-assistant-suggestions]');
    if(!toggle||!rows)return;
    toggle.checked=proactiveState.enabled;mode.value=proactiveState.mode;
    boundRoot.querySelector('[data-assistant-suggestion-source]').value=suggestionSource;
    const labels={off:'已关闭',waiting:'等待 Photoshop',cooldown:'视图稳定后更新',analyzing:'本机识别中',ready:proactiveState.suggestions.length?'已找到相关预设':'没有匹配的预设',failed:proactiveState.error||'本机识别未完成',unavailable:proactiveState.reason==='SELECTION_REQUIRED'?'请在 Photoshop 中建立选区':proactiveState.reason==='VIEWPORT_CLIENT_BOUNDS_UNVERIFIED'?'当前 Photoshop 未提供可验证的视野边界，可选择手动选区。':'Photoshop 暂不可用'};
    label.textContent=proactiveState.status==='analyzing'&&suggestionSource==='cloud'?'模型分析中':labels[proactiveState.status]||'';
    if(proactiveState.status==='limit')label.textContent='本次云端建议已达到20次上限';
    if(cloudGrant)label.textContent+=' · 本次已发送 '+cloudGrant.requests+'/20';
    rows.replaceChildren();
    for(const item of proactiveState.suggestions||[]){
      const row=document.createElement('div');row.className='assistant-suggestion';
      const title=document.createElement('span');title.textContent=item.title+' · '+item.partLabel;
      const button=document.createElement('button');button.className='settings-btn';button.textContent=item.cloud?'确认选区并生成':'选择对象并生成';
      button.onclick=async()=>{
        button.disabled=true;const token=epochNow(),viewToken=proactive&&proactive.current();
        try{
          if(!proactive||!proactive.isCurrent(viewToken)||!proactiveState.suggestions.includes(item))throw new Error('建议已更新，请重新选择');
          const latest=await host.viewState(viewToken.mode);
          if(!isCurrent(token)||!proactive.isCurrent(viewToken)||root.V7AssistantProactive.signature(latest,viewToken.mode)!==viewToken.key)throw new Error('Photoshop 视图已改变，请等待建议更新');
          if(item.cloud){
            if(viewToken.mode!=='selection'||!root.V7AssistantProactive.verifiedFocus(latest,'selection'))throw new Error('请先在 Photoshop 框选要处理的对象，再切换到“当前手动选区”等待建议更新');
            if(!await confirm('确认处理对象','对当前 Photoshop 手动选区使用预设「'+item.title+'」。请确认框中是要处理的人物或部位；下一步会显示生成费用。','确认对象'))return;
            if(!isCurrent(token)||!proactive.isCurrent(viewToken))return;
            const confirmed=await host.viewState(viewToken.mode);
            if(!isCurrent(token)||!proactive.isCurrent(viewToken)||root.V7AssistantProactive.signature(confirmed,viewToken.mode)!==viewToken.key)throw new Error('Photoshop 选区已改变，请重新确认');
            stopSuggestions();
          }else{
            stopSuggestions();
            const chosen=await root.V7SemanticSelection.apply({candidateId:item.candidateId,confirm:true});
            if(!chosen||!chosen.ok||!isCurrent(token))return;
          }
          if(!host.generationController)host.generationController=root.V7AssistantGeneration.create(generationHost());
          const plan=await host.generationController.prepare({count:1,presetId:item.presetId,presetTitle:item.title});
          if(isCurrent(token))await host.generationController.execute(plan.planId);
        }catch(error){if(isCurrent(token))report(error);}finally{button.disabled=false;}
      };
      row.append(title,button);rows.append(row);
    }
  }
  function stopSuggestions(){suggestionEpoch++;cloudGrant=null;if(proactive)proactive.stop();}
  async function enableSuggestions(){
    stopSuggestions();
    const version=suggestionEpoch,token=epochNow();
    suggestionSource=boundRoot.querySelector('[data-assistant-suggestion-source]').value==='cloud'?'cloud':'local';
    if(suggestionSource==='cloud'){
      if(root.V7FirstRun&&!root.V7FirstRun.isComplete()&&!await root.V7FirstRun.require())return;
      if(version!==suggestionEpoch||!isCurrent(token))return;
      const source=getAssistant();source.configure(configFromPanel());
      if(!source.verified||source.verified!==source.fingerprint())throw new Error('请先选择语言模型并通过连接测试');
      const fingerprint=source.fingerprint();
      const approved=await confirm('开启本次云端预设建议','向已验证模型「'+source.config.model+'」发送 Photoshop 整张画布缩略图、关注区域坐标及最多100条预设的名称与分类，不发送聊天或软件文件。每次视图稳定后最多每60秒发送一次，本次最多20次；图片和文字均可能产生服务商费用，金额以服务商为准。关闭、停止、切号或更换连接后停止发送。','同意并开启');
      if(!approved||version!==suggestionEpoch||!isCurrent(token)||assistant!==source||source.fingerprint()!==fingerprint)return;
      cloudGrant={source,fingerprint,token,requests:0,lastSentAt:-Infinity};
    }
    startSuggestions();
  }
  async function cloudSuggestions(view,options){
    const grant=cloudGrant;
    const check=()=>{
      if(!grant||cloudGrant!==grant||!isCurrent(grant.token)||assistant!==grant.source||grant.source.fingerprint()!==grant.fingerprint||options.signal.aborted)throw new Error('云端建议已停止或连接已变化');
    };
    check();
    if(grant.requests>=20){stopSuggestions();proactiveState.status='limit';renderSuggestions();return [];}
    const presets=(root.PRESETS?root.PRESETS.presets():[]).filter(p=>(!p.kind||p.kind==='prompt')&&!p.needsReview&&(!root.PRESETS.visible||root.PRESETS.visible(p))).slice(0,100);
    if(!presets.length)return [];
    const captured=await host.capture();check();
    const latest=await host.viewState(options.mode);check();
    if(!captured||captured.docId!==view.docId||root.V7AssistantProactive.signature(latest,options.mode)!==root.V7AssistantProactive.signature(view,options.mode))throw new Error('抓图期间 Photoshop 视图发生变化，未发送图片');
    const image={mime:captured.mime||'image/png',base64:captured.imageBase64};
    validateAnalysisImage(image);
    const text='根据整张画布中的关注区域推荐最多5条已有预设，只返回JSON数组：[{"presetId":"已有ID","partLabel":"部位和简短原因"}]。无法判断时返回[]。不要生成坐标，不执行操作。画布尺寸：'+captured.docWidth+'x'+captured.docHeight+'；关注区域：'+JSON.stringify({bounds:options.focus,polygon:options.polygon})+'；预设目录：'+JSON.stringify(presets.map(p=>({id:String(p.id),title:String(p.title||'').slice(0,120),category:String(p.category||'').slice(0,80)})));
    check();grant.requests++;grant.lastSentAt=Date.now();
    const result=await runIsolatedAnalysis(grant.source,grant.token,grant.fingerprint,text,image,options);check();
    let rows;try{rows=JSON.parse(result.text);}catch(_){throw new Error('模型没有返回可识别的预设建议');}
    if(!Array.isArray(rows))throw new Error('模型返回的预设建议格式无效');
    const seen=new Set(),output=[];
    for(const row of rows.slice(0,20)){
      const preset=row&&presets.find(p=>String(p.id)===String(row.presetId));
      if(!preset||seen.has(preset.id))continue;seen.add(preset.id);
      output.push({presetId:preset.id,title:preset.title,partLabel:String(row.partLabel||'模型建议').slice(0,160),cloud:true});
      if(output.length===5)break;
    }
    return output;
  }
  function startSuggestions(){
    if(!root.V7AssistantProactive||!host.viewState||!root.V7SemanticSelection)throw new Error('当前版本未连接本机预设建议');
    const mode=boundRoot.querySelector('[data-assistant-focus]').value;
    if(proactive)proactive.stop();
    proactive=root.V7AssistantProactive.create({probe:mode=>host.viewState(mode),minimumMs:suggestionSource==='cloud'?60000:30000,lastAttemptAt:()=>cloudGrant?cloudGrant.lastSentAt:-Infinity,onlyOnChange:suggestionSource==='cloud',onState:value=>{proactiveState=value;renderSuggestions();},onError:report,
      analyze:async(view,options)=>{
        if(suggestionSource==='cloud')return cloudSuggestions(view,options);
        const presets=root.PRESETS?root.PRESETS.presets().filter(p=>(!p.kind||p.kind==='prompt')&&!p.needsReview&&(!root.PRESETS.visible||root.PRESETS.visible(p))):[];
        const groups=[['face','脸',/脸|面部|皮肤|face|skin/i],['clothes','服装',/服装|衣服|上衣|裤|裙|clothes|clothing|dress/i],['hair','头发',/头发|发型|hair/i],['person','人物',/人像|人物|人体|portrait|person/i]];
        const result=[];
        for(const [part,label,pattern] of groups){
          const matches=presets.filter(p=>pattern.test([p.title,p.category,(p.tags||[]).toString()].join(' '))).slice(0,3);
          if(!matches.length)continue;
          let found;
          try{found=await root.V7SemanticSelection.suggest({part,docId:view.docId,signal:options.signal});}
          catch(error){if(error.code==='SEMANTIC_NO_CANDIDATES')continue;throw error;}
          if(options.signal.aborted)return [];
          const candidates=found.candidates.map(c=>({candidate:c,score:root.V7AssistantProactive.relevance(c.rect,options.focus,options.polygon)*c.score})).filter(c=>c.score>=.01).sort((a,b)=>b.score-a.score);
          if(candidates.length)for(const preset of matches)result.push({presetId:preset.id,title:preset.title,partLabel:label,candidateId:candidates[0].candidate.id,score:candidates[0].score});
        }
        return result.sort((a,b)=>b.score-a.score).slice(0,5);
      }});
    proactive.start({mode});
  }
  function renderMessages() {
    const el = boundRoot && boundRoot.querySelector('[data-assistant-messages]'); if (!el) return;
    el.replaceChildren();
    for (const item of transcript.slice(-50)) {
      const message = document.createElement('div'); message.className = 'assistant-message';
      const label = document.createElement('strong'); label.textContent = item.role === 'user' ? '你' : item.role === 'operation' ? '操作记录' : '助手';
      const text = document.createElement('div'); text.textContent = item.text;
      message.append(label, text); el.append(message);
    }
    el.scrollTop = el.scrollHeight;
  }
  function configFromPanel() {
    if(!boundRoot?.isConnected){let saved={};try{saved=JSON.parse(localStorage.getItem(keyForSettings())||'{}');}catch(_){}return {...(draft||assistant?.config||saved)};}
    const value = name => { const el = boundRoot.querySelector('[data-assistant-' + name + ']'); return el ? el.value.trim() : ''; };
    return { baseUrl: value('url'), apiKey: value('key'), protocol: value('protocol'), model: value('model-manual') || value('model') };
  }
  function removeImage() {
    attachmentEpoch++;
    if (attachment && attachment.thumbId && root.IMG) root.IMG.release(attachment.thumbId);
    attachment = null; renderAttachment();
  }
  async function prepareCanvas(){
    if(!host.capture)throw new Error('当前版本未连接 Photoshop 画布读取');
    const token=epochNow(),version=++attachmentEpoch,captured=await host.capture();
    if(!isCurrent(token)||version!==attachmentEpoch)return;
    if(!captured||!captured.imageBase64)throw new Error('Photoshop 没有返回画布图片');
    const next={...captured};
    if(root.IMG)next.thumbId=await root.IMG.putFromBase64(captured.imageBase64,captured.mime||'image/png');
    if(!isCurrent(token)||version!==attachmentEpoch){if(next.thumbId&&root.IMG)root.IMG.release(next.thumbId);return;}
    removeImage();attachment=next;imageOmitted=false;renderAttachment();
  }
  function renderAttachment() {
    notifyState();
    renderContext();
    const el = boundRoot && boundRoot.querySelector('[data-assistant-attachment]'); if (!el) return;
    el.replaceChildren();
    const remove = boundRoot.querySelector('[data-assistant-remove-image]'); if (remove) remove.hidden = !attachment;
    if (!attachment) return;
    const image = document.createElement('img'); image.alt = '准备发送给助手的 Photoshop 整张画布';
    if (attachment.thumbId && root.IMG) image.src = root.IMG.thumb(attachment.thumbId);
    const preview=document.createElement('div');preview.className='assistant-attachment-preview';preview.style.aspectRatio=Number(attachment.docWidth)+' / '+Number(attachment.docHeight);preview.append(image);
    const focus=root.V7AssistantProactive&&root.V7AssistantProactive.focusOf(attachment);
    if(focus&&attachment.docWidth>0&&attachment.docHeight>0){
      if(focus.polygon){
        const shape=document.createElementNS('http://www.w3.org/2000/svg','svg'),outline=document.createElementNS('http://www.w3.org/2000/svg','polygon');
        shape.classList.add('assistant-focus-shape');shape.setAttribute('viewBox','0 0 '+attachment.docWidth+' '+attachment.docHeight);shape.setAttribute('aria-label','Photoshop 可见区域');
        outline.setAttribute('points',focus.polygon.map(p=>p.x+','+p.y).join(' '));shape.append(outline);preview.append(shape);
      }else{
      const r=focus.bounds,mark=document.createElement('span');mark.className='assistant-focus-box';mark.title=focus.kind==='selection'?'当前选区':'可见区域';
      const left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(attachment.docWidth,r.right),bottom=Math.min(attachment.docHeight,r.bottom);
      if(right>left&&bottom>top){mark.style.left=100*left/attachment.docWidth+'%';mark.style.top=100*top/attachment.docHeight+'%';mark.style.width=100*(right-left)/attachment.docWidth+'%';mark.style.height=100*(bottom-top)/attachment.docHeight+'%';preview.append(mark);}
      }
    }
    const info = document.createElement('div'); info.className = 'settings-note';
    info.textContent = (attachment.docName || '当前画布') + ' · ' + attachment.width + '×' + attachment.height + '；只在你点击发送后交给所选模型，本次会话结束后不保存图片。';
    el.append(preview, info);
  }
  // ⭐ 2026-10-24（V7待办/09，反馈 #10「每次重新打开 PS 都要填 API 网址」）：原来地址 / 模型 / Key 只在「测试连接」成功
  //   那一刻才存 —— 没测或测失败就关软件，下次全空。用户定「填了就记住（持久记忆），Key 也存，存系统安全存储」。
  //   ⇒ 输入停 800ms 就存：地址 / 协议 / 模型进本账号的 localStorage，Key 进系统安全存储（跟阿吉 Key 同一处，按账号分开）。
  //   ⚠ 「测过了」的记号（rememberConnection）照旧只在测试成功时写 —— 没测过的连接下次照样要测一次，只是不用再填。
  let persistTimer = 0;
  function stopPersistTimer() { if (persistTimer && typeof clearTimeout === 'function') clearTimeout(persistTimer); persistTimer = 0; }
  function persistDraftSoon() {
    stopPersistTimer();
    if (typeof setTimeout !== 'function') return;
    const scopeAtInput = keyForSettings(), vaultScope = secretScope();
    persistTimer = setTimeout(() => {
      if (scopeAtInput !== keyForSettings()) return;      // 这 800ms 里换了账号：不往别人那份里写
      const config = configFromPanel();
      if (!config.baseUrl && !config.model) return;
      try { saveConnection(config); } catch (_) {}
      if (config.apiKey && !isLocalConnection(config) && root.uiwin && root.uiwin.secrets) root.uiwin.secrets.set({ name: 'llmKey', value: config.apiKey, scope: vaultScope }).catch(() => {});
    }, 800);
  }
  function saveConnection(config) { localStorage.setItem(keyForSettings(), JSON.stringify({ baseUrl: config.baseUrl, protocol: config.protocol, model: config.model })); }
  function isLocalConnection(config){try{return ['127.0.0.1','localhost','[::1]'].includes(new URL(config.baseUrl).hostname);}catch(_){return false;}}
  async function useLocalConnection(config,options={}){
    if(!config||config.baseUrl!=='http://127.0.0.1:11434/v1'||typeof config.model!=='string'||!config.model.trim()||config.model.length>200)throw new Error('本机助手连接配置无效');
    const token=epochNow(),version=sendEpoch;
    const check=()=>{if(!isCurrent(token)||version!==sendEpoch||options.signal?.aborted||options.isCurrent&&!options.isCurrent())throw Object.assign(new Error('本机助手准备已停止，请重新连接'),{code:'ASSISTANT_SESSION_CHANGED'});};
    check();
    const local={baseUrl:config.baseUrl,model:config.model.trim(),protocol:'openai',apiKey:''};
    const probe=new root.V7AssistantRuntime.Assistant({http:root.uiwin.http,tools:[]});probe.configure(local);
    const abort=()=>probe.stop().catch(report);options.signal?.addEventListener('abort',abort,{once:true});imageAnalyses.add(probe);
    try{await probe.test(true);check();}
    catch(error){check();throw error;}
    finally{options.signal?.removeEventListener('abort',abort);imageAnalyses.delete(probe);}
    const verified=probe.verified;
    stopSuggestions();clearPlans();
    const old=assistant;assistant=null;sessionEpoch++;
    if(old){old.onEvent=()=>{};old.stop().catch(report);}
    const next=getAssistant();next.configure(local);next.verified=verified;
    draft=local;saveConnection(local);status='已连接本机助手：'+local.model;
    if(boundRoot&&boundRoot.isConnected){for(const [field,name] of [['url','baseUrl'],['key','apiKey'],['protocol','protocol'],['model-manual','model']])boundRoot.querySelector('[data-assistant-'+field+']').value=local[name];}renderStatus();
    return {ok:true,model:local.model};
  }
  async function testModel() {
    invalidateSend();
    const token = epochNow(), vaultScope = secretScope(), a = getAssistant(), config = configFromPanel();
    a.configure(config); status = '等待你确认连接测试'; renderStatus();
    const approved = await confirm('测试语言模型', '将向“' + config.model + '”发送一条极短测试消息，可能产生少量 Token 费用。成功后 Key 会受操作系统保护保存在本机，不会因此上传云端。', '同意并测试');
    if (!isCurrent(token)) return;
    if (!approved) { status = '未进行测试'; renderStatus(); return; }
    status = '正在测试，尚未连接成功'; renderStatus();
    try {
      await a.test(true); if (!isCurrent(token)) return;
      saveConnection(config); status = '已连接：' + config.model;
      rememberConnection(a);
      if (config.apiKey) {
        const saved = root.uiwin.secrets ? await root.uiwin.secrets.set({ name: 'llmKey', value: config.apiKey, scope: vaultScope }) : { ok: false };
        if (!isCurrent(token)) return;
        if (!saved.ok) status += '（本机安全存储不可用，Key 仅留在本次会话）';
      }
    } catch (e) { if (isCurrent(token)) { status = '连接失败：' + publicText(e && e.message || e); throw e; } }
    finally { if (isCurrent(token)) renderStatus(); }
  }
  async function showAccess() {
    const token=epochNow();
    const result = await agentCall('tierInfo');
    if(!isCurrent(token))return;
    const el = boundRoot && boundRoot.querySelector('[data-agent-current]');
    if (el) el.textContent = result.ok ? '当前：' + (TIERS[result.name] || result.name) + (result.expiresAt ? ' · 至 ' + new Date(result.expiresAt).toLocaleTimeString() : '') : '当前访问范围不可用';
  }
  async function backups() {
    const token=epochNow();
    await showUpgradeReport();
    if(!isCurrent(token))return;
    const result = await agentCall('listBackups');
    if(!isCurrent(token)||!boundRoot)return;
    if (!result.ok) throw new Error(result.error);
    const el = boundRoot.querySelector('[data-agent-backups]'); el.replaceChildren();
    if (!result.backups.length) { if (root.V7Format) el.innerHTML = root.V7Format.emptyHtml({ title: '还没有恢复节点', hint: '夏三六改软件设置之前，会自动存一个能退回去的节点' }); else el.textContent = '还没有软件修改恢复节点'; return; }
    for (const item of result.backups.slice(0, 30)) {
      const row = document.createElement('div'); row.className = 'assistant-backup';
      const label = document.createElement('div'); label.textContent = (window.V7Format ? window.V7Format.ago(item.createdAt) : new Date(item.createdAt).toLocaleString()) + ' · ' + (item.meta.reason || '软件修改'); if (window.V7Format) label.title = window.V7Format.full(item.createdAt);
      const view = document.createElement('button'); view.className = 'settings-btn'; view.textContent = '查看改动';
      view.onclick = async () => { try { const d = await agentCall('diff', item.backupId); if (!d.ok) throw new Error(d.error); root.UI.notice({ title: '备份之后的改动', body: d.changed ? d.changes.map(c => c.status + ' ' + c.path).join('\n') : '与备份一致' }); } catch (e) { report(e); } };
      const restore = document.createElement('button'); restore.className = 'settings-btn'; restore.textContent = '恢复';
      restore.onclick = async () => { try {
        if (!await confirm('恢复软件修改', '恢复所选节点，并为恢复前的状态再做一次备份。', '恢复')) return;
        if(!isCurrent(token))return;
        const r = await agentCall('rollback', { backupId: item.backupId }); if (!r.ok) throw new Error(r.error || r.code);
        if(!isCurrent(token))return;
        add('operation', '已恢复：' + item.backupId + '；恢复前节点：' + r.beforeBackupId); await backups();
      } catch (e) { report(e); } };
      row.append(label, view, restore); el.append(row);
    }
  }
  async function sendQuickMessage(value) {
    const entered=String(value??'');
    if(!entered.trim())throw Object.assign(new Error('先写下想问的问题'),{code:'ASSISTANT_EMPTY_PROMPT'});
    if(sendPending||assistant?.busy)throw Object.assign(new Error('助手正在处理，请等待本轮完成或先停止回答'),{code:'ASSISTANT_BUSY'});
    const token=epochNow(),version=++sendEpoch,current=()=>isCurrent(token)&&version===sendEpoch;
    const cancelled=()=>({ok:false,cancelled:true});
    sendPending=true;sendError=null;pendingAsk=null;notifyState();
    // 夏三六这一轮正在跑（全自动替你点同意只认这个）；用编号防「停掉的旧一轮收尾时把新一轮的标记清掉」
    const turn=agentPrefs?++activitySeq:0;if(turn)agentTurn=turn;
    try{
      if(root.V7FirstRun&&!root.V7FirstRun.isComplete()&&!await root.V7FirstRun.require())return cancelled();
      if(!current())return cancelled();
      const config=configFromPanel();
      if(!config.baseUrl||!config.model)throw Object.assign(new Error('请先选择模型并通过连接测试'),{code:'ASSISTANT_NOT_VERIFIED'});
      const a=getAssistant();a.configure(config);
      // ⭐ 2026-10-20（docs/256 F3c）：新开会话 / 重开软件时助手实例是新的，「测过 / 同意过」要从记下的摘要里认回来 —— 只问第一次
      if((!a.verified||a.verified!==a.fingerprint())&&await rememberedMatches(a,false)){if(!current())return cancelled();a.verified=a.fingerprint();}
      if(!a.verified||a.verified!==a.fingerprint())throw Object.assign(new Error('请先选择模型并通过连接测试'),{code:'ASSISTANT_NOT_VERIFIED'});
      if(!a.consent&&await rememberedMatches(a,true)){if(!current())return cancelled();a.allowSession();}
      if(!a.consent){
        if(!await confirm('开启本次助手会话','会向你选择的模型发送本次提问、会话，以及回答所需的软件说明、预设或软件文件。助手不会发送 API Key、密码和 Cookie。后续同类读取不再逐条确认；图片需要另外选取。\n同意一次后，这台电脑上这个账号用这套连接就不再问；换了地址、模型或 Key 会再问一次。','同意并开始'))return cancelled();
        if(!current())return cancelled();a.allowSession();rememberConnection(a,{consent:true});
      }
      // ⭐ 2026-10-17（用户在夏三六里发「你好」报 PS 的 "only allowed from inside a modal scope"）：
      //   抓画布失败不能拖累整条消息 —— 抓不到就只发文字，回答完在状态行说明。
      //   （根上的修法在 uxp-bridge/ps-actions.js：ps.assistant.capture 包进 executeAsModal）
      // ⭐ 10-17 晚（用户：「每次对话的时候，它都要抓图，然后还需要人工同意」）：夏三六有 canvas_look 自己看图，
      //   不再每句话都先抓整张画布；你点「抓画布」手动附上的照旧发。（没接夏三六的老用法不变）
      let captureNote='';
      if(!agentPrefs&&!attachment&&!imageOmitted&&host.canvasAvailable&&await host.canvasAvailable()){
        if(!current())return cancelled();
        try{await prepareCanvas();}catch(captureError){captureNote='这次没附上画布（'+publicText(captureError&&captureError.message||captureError).slice(0,90)+'），只发了文字';}
      }
      if(!current())return cancelled();
      const selectedAttachment=attachment;
      const image=selectedAttachment?{mime:selectedAttachment.mime||'image/png',base64:selectedAttachment.imageBase64}:null;
      if(image){
        // An attachment must remain reviewable when sending from a primary card.（全自动不跳页面、不弹框）
        if(!autoMode()&&!boundRoot?.querySelector('[data-assistant-attachment] img')?.isConnected)await open('chat');
        if(!current())return cancelled();
        if(!await confirm('把这张画布发给助手','将发送你预览的整张画布及其关注区域信息到当前选择的语言模型，可能产生图片输入费用。','同意发送'))return cancelled();
      }
      if(!current())return cancelled();
      let text=entered;
      if(selectedAttachment)text+='\n[附加画布：'+selectedAttachment.docName+'，原始尺寸 '+selectedAttachment.docWidth+'×'+selectedAttachment.docHeight+'，关注范围：'+JSON.stringify(selectedAttachment.focus||selectedAttachment.selection||null)+'；坐标以原始画布为准。]';
      const box=boundRoot?.querySelector('[data-assistant-prompt]');if(box?.value===entered)box.value='';if(promptDraft===entered)promptDraft='';
      status='助手正在处理';renderStatus();
      try{
        const r=await a.ask(text,image?{image}:{});if(!current())return cancelled();
        if(attachment===selectedAttachment)removeImage();imageOmitted=false;
        // 大脑用 ask_user 停下来问你：问题和选项进对话，主卡显示成按钮
        if(r&&r.asked&&r.asked.question){pendingAsk={question:r.asked.question,options:r.asked.options||[]};add('assistant',r.asked.question+(pendingAsk.options.length?'\n可以选：'+pendingAsk.options.join(' ／ '):''));status='等你回答';return {ok:true,asked:{...pendingAsk}};}
        status=captureNote?'回答完成（'+captureNote+'）':'回答完成';return {ok:true};
      }
      catch(error){if(current())throw error;return cancelled();}
    }catch(error){
      if(!current())return cancelled();
      const safeError=Object.assign(new Error(publicText(error?.message||error)),{code:publicText(error?.code||'ASSISTANT_OPERATION_FAILED')});
      sendError={code:safeError.code,message:safeError.message};status=safeError.code==='ASSISTANT_NOT_VERIFIED'?'请先连接并测试语言模型':safeError.message;
      throw safeError;
    }finally{
      if(turn&&agentTurn===turn)agentTurn=false;
      if(current()){sendPending=false;renderStatus();}
      // Native cancellation can return before the request settles. Publish the
      // runtime's final busy flag without replacing a newer session's status.
      else notifyState();
    }
  }
  async function stopQuickMessage(){
    const token=epochNow(),active=assistant;clearPlans();stopSuggestions();
    if(active)await active.stop();
    if(!isCurrent(token))return {ok:false,cancelled:true};
    status='已请求停止本轮';renderStatus();return {ok:true};
  }
  function mount(element) {
    const launcherRoot = element.querySelector('[data-assistant-launcher]') || element.querySelector('[data-assistant-panel]');
    if (!launcherRoot) return;
    const launcher = launcherRoot.querySelector('[data-assistant-open]');
    if (launcher && !launcher.dataset.bound) {
      launcher.dataset.bound = '1';
      launcher.addEventListener('click', () => open());
      const state = launcherRoot.querySelector('[data-assistant-launch-status]');
      if (state) state.textContent = connectionState().ready ? '已连接 · 打开后可继续当前会话' : '尚未连接语言模型';
    }
    if (launcher) return;
    boundRoot = launcherRoot;
    if (!boundRoot || !boundRoot.querySelector('[data-assistant-prompt]')) return;
    if (scope !== storageKey()) storageLoad();
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(keyForSettings()) || '{}'); } catch (_) {}
    const config = draft || (assistant ? assistant.config : saved);
    const mountToken = epochNow(), mounted = boundRoot;
    const restoreFingerprint=JSON.stringify([config.baseUrl||'',config.protocol||'openai',config.model||'']);
    if (!config.apiKey && !isLocalConnection(config) && root.uiwin && root.uiwin.secrets) root.uiwin.secrets.get('llmKey', secretScope()).then(r => {
      if (!isCurrent(mountToken) || mounted !== boundRoot || !r.ok || !r.value) return;
      const current=configFromPanel();
      if(isLocalConnection(current)||JSON.stringify([current.baseUrl,current.protocol,current.model])!==restoreFingerprint)return;
      const input = mounted.querySelector('[data-assistant-key]'); if (!input.value) { input.value = r.value; draft = configFromPanel(); }
    }).catch(e => { if (isCurrent(mountToken)) report(e); });
    for (const [field, name] of [['url', 'baseUrl'], ['key', 'apiKey'], ['protocol', 'protocol'], ['model-manual', 'model']]) {
      if (config[name]) boundRoot.querySelector('[data-assistant-' + field + ']').value = config[name];
    }
    const choices = boundRoot.querySelector('[data-assistant-model]');
    boundRoot.querySelector('[data-assistant-proactive]').addEventListener('change',async e=>{try{if(e.target.checked)await enableSuggestions();else stopSuggestions();}catch(error){stopSuggestions();report(error);}finally{renderSuggestions();}});
    boundRoot.querySelector('[data-assistant-suggestion-source]').addEventListener('change',e=>{const value=e.target.value;stopSuggestions();suggestionSource=value==='cloud'?'cloud':'local';renderSuggestions();});
    boundRoot.querySelector('[data-assistant-focus]').addEventListener('change',e=>{const mode=e.target.value;if(proactiveState.enabled)startSuggestions();else proactiveState.mode=mode;});
    for (const m of modelRows) choices.append(new Option(m.id + (m.tags.length ? ' · ' + m.tags.join(' / ') : ''), m.id));
    boundRoot.querySelector('[data-assistant-prompt]').value = promptDraft;
    boundRoot.addEventListener('input', event => { draft = configFromPanel(); promptDraft = boundRoot.querySelector('[data-assistant-prompt]').value;
      if(event.target.matches('[data-assistant-url],[data-assistant-key],[data-assistant-protocol],[data-assistant-model-manual]')){invalidateSend();persistDraftSoon();}
      if(cloudGrant&&JSON.stringify([draft.baseUrl,draft.apiKey,draft.protocol,draft.model])!==cloudGrant.fingerprint)stopSuggestions();
      notifyState();
    });
    const bind = (name, fn) => boundRoot.querySelector('[data-' + name + ']').addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation(); const button = e.currentTarget, token = epochNow(); button.disabled = true;
      try { await fn(); } catch (err) { if (isCurrent(token)) report(err); } finally { if(isCurrent(token))button.disabled = false; }
    });
    bind('assistant-copy', () => { invalidateSend();stopSuggestions();const c = host.connection ? host.connection() : {}; boundRoot.querySelector('[data-assistant-url]').value = c.baseUrl || ''; boundRoot.querySelector('[data-assistant-key]').value = c.apiKey || ''; draft = configFromPanel(); });
    bind('assistant-discover', async () => {
      const token = epochNow(), a = getAssistant(); a.configure(configFromPanel()); status = '正在读取语言模型'; renderStatus();
      let rows;
      try { rows = await a.discover(); }
      catch (e) {
        // 读失败要把原因写在状态行上（以前只进报错卡，状态行一直停在「正在读取」）
        if (isCurrent(token)) { status = '读取模型失败：' + publicText(e && e.message || e) + ' —— 也可以直接在「或填写服务商给出的模型名」里手填模型名，再点「测试填写的模型」。'; renderStatus(); }
        throw e;
      }
      if (!isCurrent(token)) return; modelRows = rows;
      const select = boundRoot.querySelector('[data-assistant-model]'); select.replaceChildren(new Option('请选择模型并测试', ''));
      for (const m of modelRows) select.append(new Option(m.id + (m.tags.length ? ' · ' + m.tags.join(' / ') : ''), m.id));
      // ⭐ 2026-10-17：说清楚服务商给了几个、认出几个；一个都没有时把服务商原话和实际请求地址摆出来（是 Key 没开通还是不给列表，一看就知道）
      const info = a.lastDiscovery || {};
      status = modelRows.length
        ? '已找到 ' + modelRows.length + ' 个语言模型（服务商一共给了 ' + (info.rawCount ?? modelRows.length) + ' 个），在下面的下拉框里选一个，会自动测试'
        : '服务商返回的模型列表是空的：这个 Key 可能还没开通模型，或者这个中转站不提供模型列表。直接在「或填写服务商给出的模型名」里手填模型名，再点「测试填写的模型」。实际请求地址：' + publicText(info.url || '') + '；服务商原话：' + publicText(info.sample || '');
      renderStatus();
    });
    boundRoot.querySelector('[data-assistant-model]').addEventListener('change', async () => {
      stopSuggestions();
      boundRoot.querySelector('[data-assistant-model-manual]').value = '';
      draft = configFromPanel();
      try { await testModel(); } catch (e) { report(e); }
    });
    bind('assistant-test', testModel);
    bind('assistant-forget-key', async () => {
      const token = epochNow(), vaultScope = secretScope();
      if (!await confirm('删除本机助手 Key', '删除当前账号在这台电脑保存的助手 Key，并断开本次助手连接。其他服务商的 Key 不受影响。', '删除')) return;
      if (!isCurrent(token)) return;
      if (root.uiwin.secrets) { const r = await root.uiwin.secrets.remove('llmKey', vaultScope); if (!r.ok) throw new Error('本机安全存储删除失败'); }
      if (!isCurrent(token)) return;
      const old = assistant; assistant = null; sessionEpoch++;
      stopSuggestions();
      clearPlans();
      if (old) { old.onEvent = () => {}; await old.stop(); }
      boundRoot.querySelector('[data-assistant-key]').value = ''; draft = configFromPanel(); status = '本机助手 Key 已删除，请重新连接'; renderStatus();
    });
    bind('assistant-send',()=>sendQuickMessage(boundRoot.querySelector('[data-assistant-prompt]').value));
    bind('assistant-capture', prepareCanvas);
    bind('assistant-remove-image',()=>{imageOmitted=true;removeImage();});
    bind('assistant-stop',stopQuickMessage);
    bind('assistant-new', newConversation);
    bind('assistant-rename',()=>renameConversation(boundRoot.querySelector('[data-assistant-conversation-title]').value));
    bind('assistant-delete',deleteConversation);
    bind('assistant-clear', async () => { const token=epochNow();if (!await confirm('清空当前聊天', '只清空当前会话的本机聊天记录，其他会话、预设和软件恢复节点保留。', '清空')||!isCurrent(token)) return; transcript = [];currentConversation().messages=[];switchConversation(currentConversationId,true);status='当前聊天已清空';renderStatus(); });
    bind('agent-grant', async () => { const value = boundRoot.querySelector('[data-agent-tier]').value; const r = await agentCall('requestAccess', value); if (!r.ok) throw new Error(r.error || r.code); await showAccess(); });
    bind('agent-refresh', backups);
    renderStatus(); renderMessages();renderConversations();renderAttachment(); renderSuggestions(); showAccess().catch(report); showUpgradeReport().catch(report);
  }
  async function showUpgradeReport() {
    if (!root.uiwin || !root.uiwin.agent || !root.uiwin.agent.upgradeStatus) return;
    const token=epochNow();
    const result = await agentCall('upgradeStatus');
    if(!isCurrent(token))return;
    const el = boundRoot && boundRoot.querySelector('[data-agent-upgrade]');
    if (!result.ok) {
      if (el) el.textContent = '软件修改工作区暂不可用，已使用官方界面。';
      if (upgradeNotified !== 'failed' && root.ERR) root.ERR.report('AGENT_WORKSPACE_FAILED', { message: result.detail || result.error || result.code });
      upgradeNotified = 'failed'; return;
    }
    const rows = result.files || [], conflicts = rows.filter(row => String(row.status).startsWith('disabled'));
    if (el) el.textContent = (result.officialOnly ? '当前使用官方界面恢复模式。' : '') +
      '官方版本：' + (result.version || '-') + '；保留修改 ' + rows.filter(row => row.status === 'retained').length + ' 项；停用冲突 ' + conflicts.length + ' 项。' +
      (conflicts.length ? '\n' + conflicts.map(row => row.path + ' → ' + row.archive).join('\n') : '');
    if (conflicts.length && upgradeNotified !== result.build && root.ERR) {
      root.ERR.report('AGENT_UPGRADE_CONFLICT', { message: conflicts.map(row => row.path).join('\n') }); upgradeNotified = result.build;
    }
  }
  function configure(options) {
    host = Object.assign(host,options||{}); storageLoad();notifyState(); queueMicrotask(() => showUpgradeReport().catch(report));
    // ⭐ 2026-10-20（docs/256 F3c）：本机模型（Ollama 之类）不用 Key、不会有「Key 恢复」那一下 —— 读完设置就比对一次
    if (draft && isLocalConnection(draft) && root.uiwin && root.uiwin.http) { const token = epochNow(); queueMicrotask(() => restoreRemembered(draft, token)); }
  }
  root.addEventListener('wheelchair:secrets-restored', async () => {
    const token = epochNow();
    if(isLocalConnection(draft||assistant&&assistant.config||{}))return;
    if (!root.uiwin || !root.uiwin.secrets) return;
    try {
      const saved = await root.uiwin.secrets.get('llmKey', secretScope());
      if (!isCurrent(token) || !saved.ok) return;
      const old = assistant; assistant = null; sessionEpoch++;
      stopSuggestions();
      clearPlans();
      if (old) { old.onEvent = () => {}; old.stop().catch(report); }
      if (boundRoot && boundRoot.isConnected) { boundRoot.querySelector('[data-assistant-key]').value = saved.value || ''; draft = configFromPanel(); }
      else { let stored = {}; try { stored = JSON.parse(localStorage.getItem(keyForSettings()) || '{}') || {}; } catch (_) {} draft = { ...(stored.baseUrl ? { baseUrl: stored.baseUrl, protocol: stored.protocol, model: stored.model } : {}), ...(draft || {}), apiKey: saved.value || '' }; }
      // ⭐ 2026-10-20（docs/256 F3c）：这套连接上次测过 ⇒ 直接算已连接（不再黄灯、不用再测）
      // 2026-10-24：先比对再写状态 —— 原来先写「请测试连接」再改成已连接，开软件会闪一下黄字
      const restored = draft ? await restoreRemembered(draft, token) : false;
      if (!restored && isCurrent(token)) { status = '助手地址和 Key 已恢复，测一次连接就能用（测过一次以后不用再测）'; renderStatus(); }
    } catch (e) { if (isCurrent(token)) report(e); }
  });
  root.addEventListener('wheelchair:storage-context', () => {
    stopSuggestions();
    sessionEpoch++;
    clearPlans();
    const old = assistant; assistant = null;
    draft = null; promptDraft = ''; modelRows = []; removeImage();imageOmitted=false;activity=[];plan=[];pendingAsk=null;
    if (old) { old.onEvent = () => {}; old.stop().catch(report); }
    stopPersistTimer();
    storageLoad(); status = '账号已切换，请重新连接助手';
    // 2026-10-24（V7待办/09）：换账号（含开软件时匿名 → 登录）后把【这个账号】存过的地址 / 模型填回来；Key 等 secrets-restored 再补
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(keyForSettings()) || '{}') || {}; } catch (_) {}
    if (boundRoot && boundRoot.isConnected) {
      for (const name of ['key', 'url', 'model-manual']) boundRoot.querySelector('[data-assistant-' + name + ']').value = '';
      if (saved.baseUrl) boundRoot.querySelector('[data-assistant-url]').value = saved.baseUrl;
      if (saved.model) boundRoot.querySelector('[data-assistant-model-manual]').value = saved.model;
      if (saved.protocol) { const p = boundRoot.querySelector('[data-assistant-protocol]'); if (p) p.value = saved.protocol; }
      if (saved.baseUrl) { draft = configFromPanel(); status = '已读回这个账号存的助手地址，等 Key 恢复'; }
      renderMessages();renderConversations();boundRoot.querySelector('[data-assistant-prompt]').value='';resetActionButtons();
    }
    renderStatus();
  });
  // ⭐ 2026-10-20（docs/256 F3c，学员报「夏三六连接状态总是黄灯，自动连接不要每次都授权，首次授权即可」）：
  //   原来「连接测试通过」和「同意开启助手会话」都只记在内存里 —— 每次开软件 Key 恢复后都要重新测试（一直黄灯）、
  //   每开一次会话都要再点一次同意。改成：按账号记住【这套连接测过了 / 同意过】，换了地址、模型、协议或 Key 才重测重问。
  //   ⚠ 连接指纹里有 Key 原文（assistant-runtime.js fingerprint()）—— 只存它的 SHA-256 摘要，反推不出 Key；比对时现算一遍。
  // ⚠⚠ 2026-10-24（V7待办/09 真正的根因）：这里原来也叫 'assistant.connection.v1' —— 跟上面 keyForSettings()
  //   （'assistant.conversations.v1' 换字得到的）【是同一个存储格】。测试成功时先 saveConnection 存地址，
  //   紧跟着 rememberConnection 用 {digest} 把它整个盖掉 ⇒ 下次开软件地址 / 模型全没了（反馈 #10「每次都要重填」）。
  //   现在分开存；老格子里如果是 {digest} 就当「测过的记号」读一次（OLD_REMEMBER_KEY），地址那边已经丢了，只能填一次。
  const REMEMBER_KEY = 'assistant.connection-verified.v1', OLD_REMEMBER_KEY = 'assistant.connection.v1';
  function rememberedKey(name) { return root.WHEELCHAIR_STORAGE && typeof root.WHEELCHAIR_STORAGE.key === 'function' ? root.WHEELCHAIR_STORAGE.key(name || REMEMBER_KEY) : ''; }
  async function connectionDigest(fingerprint) {
    const bytes = new TextEncoder().encode(String(fingerprint || ''));
    const hash = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  function readRemembered() {
    try {
      const k = rememberedKey(); if (!k) return null;
      const now = JSON.parse(root.localStorage.getItem(k) || 'null');
      if (now) return now;
      const old = JSON.parse(root.localStorage.getItem(rememberedKey(OLD_REMEMBER_KEY)) || 'null');
      return old && old.digest ? old : null;
    } catch (_) { return null; }
  }
  // 这套连接（地址 / Key / 协议 / 模型都一样）以前测过吗？needConsent=true 时还要同意过
  async function rememberedMatches(a, needConsent) {
    try {
      const saved = readRemembered();
      if (!saved || !saved.digest || (needConsent && !saved.consent) || !a || !a.config || !a.config.baseUrl) return false;
      return await connectionDigest(a.fingerprint()) === saved.digest;
    } catch (_) { return false; }
  }
  async function rememberConnection(a, opts) {
    try {
      const k = rememberedKey();
      if (!k || !a || !a.verified || a.verified !== a.fingerprint()) return;
      const digest = await connectionDigest(a.verified), prev = readRemembered();
      const consent = opts && opts.consent === true ? true : !!(prev && prev.digest === digest && prev.consent);
      root.localStorage.setItem(k, JSON.stringify({ v: 1, digest, consent }));
    } catch (_) { /* 记不住只是下次要重测，不影响这次 */ }
  }
  // 开软件 / Key 恢复后：这套连接以前测过就直接算「已连接」，同意过就不再问
  async function restoreRemembered(config, token) {
    try {
      const saved = readRemembered();
      if (!saved || !saved.digest || !config || !config.baseUrl || !config.model) return false;
      const a = getAssistant(); a.configure(config);
      const fingerprint = a.fingerprint();
      if (await connectionDigest(fingerprint) !== saved.digest || !isCurrent(token) || a !== assistant || a.fingerprint() !== fingerprint) return false;
      a.verified = fingerprint;
      if (saved.consent) a.allowSession();
      status = '已连接：' + config.model + '（上次测过，不用再测）'; renderStatus(); notifyState();
      return true;
    } catch (_) { return false; }
  }
  function connectionState() {
    if (!assistant) return { ready: false, model: '' };
    const ready = !!assistant.verified && assistant.verified === assistant.fingerprint();
    return { ready, model: ready ? assistant.config.model : '', busy: !!assistant.busy };
  }
  const imageAnalyses = new Set();
  root.addEventListener('beforeunload',stopSuggestions);
  function stopImageAnalyses() { for (const active of imageAnalyses) active.stop().catch(report); }
  root.addEventListener('wheelchair:storage-context', stopImageAnalyses);
  root.addEventListener('wheelchair:secrets-restored', stopImageAnalyses);
  function validateAnalysisImage(image){
    if (image && (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime) || typeof image.base64 !== 'string' || !image.base64 || image.base64.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(image.base64))) throw new Error('图片格式无效或超过分析大小限制');
  }
  async function analyzeContent(text, image, options = {}) {
    const source = assistant, token = epochNow();
    if (!source || !source.verified || source.verified !== source.fingerprint()) throw new Error('请先在助手设置中选择语言模型并通过连接测试');
    validateAnalysisImage(image);
    if (!String(text || '').trim() || String(text).length > 20000) throw new Error('图片分析要求为空或过长');
    if (options.confirm === false) throw new Error('图片分析必须先确认发送范围和可能费用');
    const fingerprint = source.fingerprint();
    if (!await confirm(image?'确认发送图片分析':'确认发送文本分析', (image?'将这一张图片和本次分析要求':'将本次填写资料和字段要求')+'发送给已验证的模型「' + source.config.model + '」，可能按服务商标准产生费用。', image?'发送图片':'发送文本')) return { ok: false, cancelled: true };
    return runIsolatedAnalysis(source,token,fingerprint,text,image,options);
  }
  async function runIsolatedAnalysis(source,token,fingerprint,text,image,options){
    if (!isCurrent(token) || assistant !== source || source.fingerprint() !== fingerprint) throw Object.assign(new Error('账号或助手连接已变化，请重新分析'), { code: 'ASSISTANT_SESSION_CHANGED' });
    const isolated = new root.V7AssistantRuntime.Assistant({ http: root.uiwin.http, tools: [], secrets: () => host.secrets ? host.secrets() : [] });
    isolated.configure({ ...source.config }); isolated.verified = fingerprint; isolated.allowSession();
    imageAnalyses.add(isolated);
    const onAbort = () => isolated.stop().catch(report);
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (options.signal && options.signal.aborted) throw Object.assign(new Error('图片分析已取消'), { code: 'ASSISTANT_STOPPED' });
      const result = await isolated.ask(String(text), image?{ image: { mime: image.mime, base64: image.base64 } }:{});
      if (!isCurrent(token) || assistant !== source || source.fingerprint() !== fingerprint) throw Object.assign(new Error('账号或助手连接已变化，旧分析结果未应用'), { code: 'ASSISTANT_SESSION_CHANGED' });
      if (isolated.stopped) throw Object.assign(new Error('图片分析已取消'), { code: 'ASSISTANT_STOPPED' });
      return { ok: true, text: result.text };
    } catch(error){
      if(!isCurrent(token)||assistant!==source||source.fingerprint()!==fingerprint)throw Object.assign(new Error('账号或助手连接已变化，旧分析结果未应用'),{code:'ASSISTANT_SESSION_CHANGED'});
      throw error;
    } finally {
      imageAnalyses.delete(isolated); isolated.messages = []; isolated.config.apiKey = '';
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }
  function analyzeImage(text,image,options){if(!image)throw new Error('缺少分析图片');return analyzeContent(text,image,options);}
  function mountSection(container, section) {
    // Navigation already chose the destination. Closing an expanded chat here
    // must not let its delayed close event navigate back over that choice.
    close({restore:false});
    const view=document.createElement('div');view.className='assistant-embedded';view.dataset.assistantSection=section||'chat';
    view.innerHTML=fullMarkup();container.append(view);prepareWorkbench(view);mount(view);
    const panel=view.querySelector('[data-assistant-panel]'),controls=view.querySelector('.assistant-workbench-controls'),conversation=view.querySelector('.assistant-workbench-conversation');
    const connection=view.querySelector('[data-assistant-connection-config]'),suggestions=view.querySelector('[data-assistant-suggestions-config]'),sessions=view.querySelector('.assistant-session-manager');
    const agent=view.querySelector('[data-agent-tier]').closest('details');
    for(const child of controls.children)child.hidden=true;
    conversation.hidden=section!=='chat';
    if(section==='chat'){
      sessions.hidden=false;suggestions.hidden=false;sessions.open=false;suggestions.open=false;
      const expand=document.createElement('button');expand.type='button';expand.className='settings-btn';expand.dataset.assistantExpand='';expand.textContent='展开对话工作面';
      expand.onclick=()=>{
        promptDraft=view.querySelector('[data-assistant-prompt]').value;draft=configFromPanel();
        const route=container.dataset.cardRoute,sourceToken=epochNow();view.remove();if(boundRoot===panel)boundRoot=null;
        const dialog=openWorkspace();
        const returnToSource=()=>{if(dialog.dataset.v7ModalSuspended)return;dialog.removeEventListener('close',returnToSource);if(!dialog.dataset.assistantReturnSuppressed&&isCurrent(sourceToken)&&container.isConnected&&container.dataset.cardRoute===route){if(host.navigate)host.navigate('chat');else mountSection(container,'chat');}};
        dialog.addEventListener('close',returnToSource);
      };
      conversation.prepend(expand);
    }else if(section==='connection'){
      connection.hidden=false;connection.open=true;
      // ⭐ 2026-10-17 修（用户报「点读取语言模型没反应」）：状态行被 prepareWorkbench 挪进了聊天区，
      //   而只显示「连接」时聊天区整块是藏着的 ⇒ 读到几个模型 / 为什么失败全写在看不见的地方，看起来就是没反应。
      //   ⇒ 把状态行挪到「读取语言模型」那排按钮正下方（点完就看得到；还在 boundRoot 里，原来那些按钮照样找得到它）。设置卡「助手模型」那节同样受益。
      //   （第一版挪到整块连接设置的后面，用户截图时那一行在屏幕外面，还是像没反应 —— 10-17 第二次改）
      const statusLine=view.querySelector('[data-assistant-status]'),discoverRow=view.querySelector('[data-assistant-discover]')?.closest('.settings-actions');
      if(statusLine)(discoverRow||connection).after(statusLine);
    }
    else{
      agent.hidden=false;agent.open=true;
      const tier=view.querySelector('[data-agent-tier]').closest('label'),grant=view.querySelector('[data-agent-grant]'),current=view.querySelector('[data-agent-current]');
      const refresh=view.querySelector('[data-agent-refresh]'),backupsNode=view.querySelector('[data-agent-backups]'),upgrade=view.querySelector('[data-agent-upgrade]');
      for(const node of [tier,grant,current])node.hidden=section==='recovery';
      for(const node of [refresh,backupsNode,upgrade])node.hidden=section!=='recovery';
      agent.querySelector('summary').textContent=section==='recovery'?'恢复节点':'Agent 权限';
      if(section==='recovery')refresh.click();
    }
    let disposed=false;
    return ()=>{if(disposed)return;disposed=true;if(boundRoot===panel){promptDraft=panel.querySelector('[data-assistant-prompt]').value;draft=configFromPanel();boundRoot=null;}view.remove();};
  }
  root.V7AssistantPanel = { markup, mount, mountSection, open, openWorkspace, close, configure, connectionState, quickState, sendQuickMessage, stopQuickMessage, submit:sendQuickMessage, cancel:stopQuickMessage, getState:quickState, subscribe, newConversation, switchConversation, renameConversation, deleteConversation, useLocalConnection, analyzeImage, analyzeText:(text,options)=>analyzeContent(text,null,options), applyAgentPrefs, probeCapabilities, captureCanvas, attachmentPreview, removeAttachment:()=>{imageOmitted=true;removeImage();},
    // ⭐ 2026-10-17 夜：黑匣子 —— traceLive() 现在卡在哪、卡了几秒；traceRecent(n) 最近几轮的全过程（磁盘上也有一份，见 agent-trace.js）
    traceLive:()=>traceRecorder()?traceRecorder().live():null, traceRecent:n=>traceRecorder()?traceRecorder().recent(n):[], tracePath:()=>root.uiwin?.agentTrace?.path?.() };
})(window);
