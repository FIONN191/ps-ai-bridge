(function(root){
  'use strict';
  // ⭐ 2026-10-21：otherProfileKeys = 自定义渠道「其他几套方案」的 Key 打成的一包（ui-pure/other-profiles.js）。
  //   不进云备份的话换电脑恢复后方案名、地址都在，Key 是空的。⚠ 后台 1.9.6 起才认这个名字（见 uploadKeys 里的放过）。
  const KEY_NAMES=['ajiKey','momoKey','grsKey','otherKey','comfyKey','runninghubKey','llmKey','otherProfileKeys'];
  const OPTIONAL_KEYS=new Set(['otherProfileKeys']);
  let host={},bound=null,boundOptions={},busy=false,timer=null,accountScope='',accountSession,status='默认不自动上传。',lastInfo=null,checkVersion=0;
  const scope=()=>root.V7AccountBackupStore.scope();
  const key=()=>root.WHEELCHAIR_STORAGE.key('cloud-backup.preferences.v1');
  const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const signed=()=>!!root.V7Backend.state().signedIn;
  function prefs(){let data={};try{data=JSON.parse(localStorage.getItem(key())||'{}');}catch(_){}return {enabled:false,intervalMinutes:30,choice:'pending',pendingUpload:false,keySync:false,consent:false,consentAsked:false,...data};}
  // ⭐⭐ 2026-10-10（用户定）：「云备份需要让用户提醒，需要有弹窗提示」
  //   + 同意书要写清「管理员理论上可以解密你的数据」（用户明确要求写清楚）
  //   ⇒ 第一次上传前必须先过这一关，不默认勾选。
  //
  // ⚠ 为什么要把"管理员能解密"写进去（不是走过场）：
  //   云备份里的 API Key 是加密存的，但密钥在服务器上（V7_MASTER_KEY，
  //   部署脚本 12_service.py 生成、写在 /etc/v7/backend.env）。
  //   有服务器权限的人就能解出来 —— 这是事实，瞒着用户反而更糟：
  //   用户会以为"加密了=只有我能看"，然后把自己的主 Key 传上去。
  // ⚠ 措辞要具体：说清【传什么】【传哪去】【谁能看】【怎么撤回】，别写空话。
  function consentBody(){
    return '会把这些东西传到夏三七的服务器：\n'
      +'  · 基础设置、预设、剪影位置、已审核头像、助手预设\n'
      +'  · （如果你另外开启）各家服务商的 API Key\n\n'
      +'不会传的：参考图、自定义剪影图片、缓存、项目、幕布、聊天记录 —— 这些只留在你本机。\n\n'
      +'⚠ 关于安全，说清楚：\n'
      +'  基础设置、预设等以普通数据保存；API Key 单独加密保存，【解密密钥在服务器上】。\n'
      +'  ⇒ 有相应服务器权限的管理员可以读取普通备份，也可以解密 API Key。\n'
      +'  如果你不能接受这一点，就别开云备份 —— 只留在本机也是完整可用的。\n\n'
      +'你随时可以在设置里撤回同意，撤回时云端那一份会被删掉。\n\n'
      +'同意把上面这些传到云端吗？';
  }
  // 没同意过就弹一次，同意后记住；返回 false 表示用户拒绝（调用方必须就此打住）
  // ⚠⚠ 2026-10-10 补（企业级要求：只问一次、记得答案）：
  //   原来只看 consent 一个标志 ⇒ 用户【明确拒绝】之后 consent 仍是 false，
  //   于是每次触发上传都会再弹一次同样的同意书 —— 那是骚扰，而且用户会觉得"我说了不算"。
  //   ⇒ 加 consentAsked：不管同意还是拒绝都记下来。
  //     · 从没问过（consentAsked=false）→ 弹一次
  //     · 问过且同意（consent=true）    → 直接放行
  //     · 问过但拒绝（consentAsked=true 且 consent=false）→ 不弹、直接拒绝
  //   ⚠ 用户想改主意：【设置里那个「再看一遍说明」按钮】会清掉 consentAsked 重新问
  //     （否则就是"拒绝了就再也没机会同意"，那也不对）。
  async function requireConsent(){
    const op=operation(),p=prefs();
    if(p.consent===true)return true;
    if(p.consentAsked===true)return false;   // 问过了、答案是"不" —— 不再骚扰
    const agreed=await confirm('开云备份前，请先看清楚',consentBody(),'我同意，传云端');
    op.check();
    // ⚠ 不管同意还是拒绝都记：同意记 consent，拒绝记 consentAsked
    if(agreed)save({consent:true,consentAsked:true});
    else save({consentAsked:true});
    return agreed;
  }
  function save(patch){localStorage.setItem(key(),JSON.stringify({...prefs(),...patch}));schedule();}
  function inform(message){status=message;render();if(root.UI?.toast)root.UI.toast(message,'info',5000);}
  function confirm(title,body,label='确认'){
    const ask=()=>new Promise(resolve=>{if(!root.UI?.dialog)return resolve(false);root.UI.dialog({title,body,confirm:label,onConfirm:()=>resolve(true),onCancel:()=>resolve(false)});});
    return root.V7FocusScope?.outsideModal?root.V7FocusScope.outsideModal(ask):ask();
  }
  function current(expected,version){if(scope()!==expected||version!==checkVersion||!signed())throw Object.assign(new Error('账号已切换，本次操作停止'),{code:'BACKUP_ACCOUNT_CHANGED'});}
  function operation(requireSigned=true){
    const started=scope(),version=checkVersion,wasSigned=signed();
    const check=()=>{if(requireSigned)current(started,version);else if(scope()!==started||version!==checkVersion||signed()!==wasSigned)throw Object.assign(new Error('账号已切换，本次操作停止'),{code:'BACKUP_ACCOUNT_CHANGED'});};
    check();return {scope:started,check};
  }
  function report(error){status=String(error.message||error);root.ERR?.report(error.code||'CLOUD_BACKUP_FAILED',{message:status});render();}
  function automaticAllowed(){const p=prefs();return p.enabled&&p.choice!=='pending'&&!p.pendingUpload&&!p.limitLocked;}
  function localState(){return {settings:host.getSettings?.()||{},assistantConnection:host.getAssistantConnection?.()||{},assistantPresets:host.getAssistantPresets?.()||[]};}
  async function apply(state,check){
    for(const [method,value]of [['applySettings',state.settings||{}],['applyAssistantConnection',state.assistantConnection||{}],['applyAssistantPresets',state.assistantPresets||[]]]){
      check();await host[method]?.(value);check();
    }
  }
  async function recover(op,restoreId){op.check();await root.V7AccountBackupStore.recover((state,check)=>apply(state,()=>{op.check();check?.();}),op.check,restoreId);op.check();}
  async function manifest(){const state=localState(),account=root.V7Backend.state().account||{};const out=await root.V7AccountBackupStore.exportAccount(state.settings,{assistantPresets:state.assistantPresets,assistantConnection:state.assistantConnection});if(account.approved_avatar)out.avatar=account.approved_avatar;return out;}
  async function upload(automatic=false){
    if(!signed())throw new Error('请先登录账号');
    const started=scope(),version=checkVersion,p=prefs();
    if(automatic&&!automaticAllowed())return;
    // ⚠ 首次上传前必须先过同意书（用户 2026-10-10 定）。自动上传也一样过 ——
    //   不然用户开了自动备份、某天突然发现自己没同意过就传上去了。
    //   ⚠ 拒绝就【就此打住】：不传、也不偷偷留着"下次再传"的标记。
    if(!await requireConsent()){status='已取消：你还没同意把数据传到云端。';return;}
    // ⚠⚠ 2026-10-10 审查时补：上面 await 期间 requireConsent 会写 consent=true 进 localStorage，
    //   所以那一句之后 p 已经是【旧快照】了。后面要读跟"同意"相关的偏好就必须重读，
    //   否则将来往 prefs 里加字段时，这个陈旧读法会变成很难查的 bug。
    //   （实测当前这一版：p.choice / p.pendingUpload 都不受 consent 影响，所以行为没变，
    //     但"读过期的快照"这件事本身要修掉。）
    const p2=prefs();
    if(root.navigator?.onLine===false){save({pendingUpload:true});throw new Error('当前离线；恢复网络后会提示你确认上传');}
    if(!automatic&&p2.choice==='pending'&&!await confirm('以本机为准','这会用当前电脑的基础设置和预设替换云端唯一一份备份。','设本机为默认并上传'))return;
    current(started,version);
    const data=await manifest();current(started,version);
    if(automatic&&!automaticAllowed())return;
    try{
      const response=await root.V7Backend.syncBackup(data);current(started,version);lastInfo=response;
      save({choice:'local',pendingUpload:false,limitLocked:false,lastUpload:new Date().toISOString()});
      status='已保存云端最新一份备份（'+Math.ceil(response.backup.size_bytes/1024)+' KB）。';
      if(prefs().keySync)await uploadKeys(false);
    }catch(error){if(scope()===started&&version===checkVersion){save(error.code==='BACKUP_QUOTA_EXCEEDED'?{limitLocked:true}:{pendingUpload:true});}throw error;}
  }
  // ⚠ 对外的 restore 永远先问（不收参数）；只有登录时那个「现在恢复」对话框走 restoreAccount(true)
  function restore(){return restoreAccount(false);}
  async function restoreAccount(preAgreed){
    const op=operation(),response=await root.V7Backend.readBackup();op.check();
    if(!response.backup)throw new Error('云端还没有备份');
    const data=response.backup.manifest;
    // preAgreed：登录时「发现另一台电脑的云备份」那个对话框里已经点了「现在恢复」（说明文字在那边说全了），不再问第二遍
    const agreed=preAgreed===true||await confirm('恢复账号备份','将覆盖这台电脑当前账号的基础设置、预设和助手预设。开始前会保留一份本机恢复点；本机图片、历史和聊天不参与覆盖。','备份本机并恢复');op.check();
    if(!agreed){save({choice:'pending',enabled:false});return;}
    const result=await root.V7AccountBackupStore.restore(data,localState(),{settings:data.settings||{},assistantConnection:data.assistantConnection||{},assistantPresets:data.assistantPresets||[]},op.check);
    op.check();
    try{await recover(op,result.restoreId);}catch(error){
      op.check();
      try{await root.V7AccountBackupStore.rollback(op.check,result.restoreId);op.check();await recover(op,result.restoreId);}
      catch(rollbackError){op.check();throw new Error('恢复未完成，本机恢复点也未能完整恢复；请在云备份页面重试本机恢复点。');}
      throw error;
    }
    op.check();
    save({choice:'restored',pendingUpload:false});
    status='已恢复 '+result.presets+' 条预设。'+(result.missingAssets.length?'有 '+result.missingAssets.length+' 个自定义剪影素材未随云备份传输，请在本机导入素材。':'');
  }
  async function rollback(){
    const op=operation(false),agreed=await confirm('回到恢复前','用恢复云备份前的本机恢复点覆盖当前账号设置和预设。','恢复本机恢复点');op.check();if(!agreed)return;
    await root.V7AccountBackupStore.rollback(op.check);op.check();await recover(op);op.check();
    save({choice:'pending',enabled:false});status='已恢复本机恢复点；自动上传已暂停。';
  }
  async function keyValues(started,version){const values={...host.getSecrets?.()};const vault=root.uiwin?.secrets;if(vault)for(const name of KEY_NAMES){if(!values[name]){current(started,version);const result=await vault.get(name,started);current(started,version);if(result?.ok!==true)throw new Error('读取本机安全存储失败：'+name+'；请检查桌面安全存储后重试');if(result.value)values[name]=result.value;}}return values;}
  async function uploadKeys(ask=true){
    const started=scope(),version=checkVersion;if(!signed())throw new Error('请先登录账号');
    if(ask&&!await confirm('启用 Key 云同步','API Key 会加密上传到平台服务器，供你主动在其他电脑取回。设置和预设备份本身不包含 Key。','同意加密上传'))return;
    current(started,version);const values=await keyValues(started,version);current(started,version);const sent=[];
    try{for(const name of KEY_NAMES){if(!values[name])continue;current(started,version);
      // 后台还是旧版不认 otherProfileKeys ⇒ 只跳过这一项，别把整次 Key 同步算成失败
      try{await root.V7Backend.syncSecret(name,values[name],true);}catch(error){if(OPTIONAL_KEYS.has(name)&&!/ACCOUNT_CHANGED|SCOPE/i.test(String(error&&error.code||'')))continue;throw error;}
      current(started,version);sent.push(name);}}
    catch(error){throw Object.assign(new Error('已上传 '+sent.length+' 项 Key；其余未完成：'+String(error.message||error)),{code:error.code});}
    save({keySync:true});status='Key 同步已启用；本次加密上传 '+sent.length+' 项。';
  }
  async function stopKeys(remove){
    const op=operation();
    if(remove){const agreed=await confirm('停止并删除云端 Key','这会删除当前账号云端保存的全部 Key 副本。本机安全保存的 Key 继续保留。','停止并删除');op.check();if(!agreed)return;}
    op.check();
    save({keySync:false});
    if(remove){await root.V7Backend.deleteCloudSecrets();op.check();}
    status=remove?'已停止同步并删除云端 Key 副本。':'已停止后续 Key 同步，云端现有副本继续保留。';
  }
  async function restoreKeys(){
    const op=operation(),cloud=await root.V7Backend.listCloudSecrets();op.check();
    const names=[...new Set((cloud.secrets||[]).map(s=>s.name).filter(name=>KEY_NAMES.includes(name)))];
    if(!names.length)throw new Error('云端没有可以取回的 Key');
    const agreed=await confirm('取回云端 Key','将取回 '+names.length+' 项 Key，替换本机同名连接凭据，并保存到系统保护的本机安全存储。','取回并保存');op.check();if(!agreed)return;
    const vault=root.uiwin?.secrets;if(!vault)throw new Error('当前运行环境没有本机安全存储，请在桌面软件中操作');
    const values={},before={},written=[];let sessionApplied=false;
    for(const name of names){
      op.check();const response=await root.V7Backend.restoreCloudSecret(name);op.check();
      if(typeof response?.value!=='string')throw new Error('云端 Key 返回无效，请重新查询后重试');
      values[name]=response.value;const prior=await vault.get(name,op.scope);op.check();
      if(prior?.ok!==true)throw new Error('读取本机安全存储失败');before[name]=prior.value||'';
    }
    try{
      for(const name of names){op.check();written.push(name);const result=await vault.set({name,value:values[name],scope:op.scope});if(result?.ok!==true)throw new Error('保存 Key 到本机安全存储失败');op.check();}
      op.check();sessionApplied=true;await host.applySecrets?.(values);op.check();
    }catch(error){
      // Compensation is pinned to the original vault namespace even after logout.
      const failures=[];
      for(const name of written.reverse()){
        try{
          const actual=await vault.get(name,op.scope);if(actual?.ok!==true)throw new Error('read');
          if((actual.value||'')===before[name])continue;
          if(actual.value!==values[name])throw new Error('changed');
          const result=before[name]?await vault.set({name,value:before[name],scope:op.scope}):await vault.remove(name,op.scope);
          if(result?.ok!==true)throw new Error('write');
        }catch(_){failures.push(name);}
      }
      if(sessionApplied){
        let sameAccount=true;try{op.check();}catch(_){sameAccount=false;}
        if(sameAccount)try{await host.applySecrets?.(before);op.check();}catch(_){failures.push('session');}
      }
      if(failures.length)throw new Error('Key 取回未完成，'+failures.length+' 项本机凭据未能恢复；请回原账号检查连接设置及系统安全存储后重试。');
      throw error;
    }
    status='已取回 '+names.length+' 项 Key；使用前仍需测试连接。';
  }
  function schedule(){if(timer)clearInterval(timer);timer=null;const p=prefs();if(!p.enabled||!signed())return;const scheduledScope=scope(),version=checkVersion;timer=setInterval(()=>{if(scope()!==scheduledScope||version!==checkVersion||!signed()||!automaticAllowed())return;return run(()=>upload(true));},Math.max(5,Math.min(1440,Number(p.intervalMinutes)||30))*60000);}
  async function run(action){if(busy)return;busy=true;render();try{await action();}catch(error){report(error);}finally{busy=false;render();}}
  function markup(){
    const p=prefs(),info=lastInfo?.backup,selected=boundOptions.section||'all';
    const backup=selected==='all'||selected==='backup',preferences=selected==='all'||selected==='preferences',keys=selected==='all'||selected==='keys';
    let html='<div class="settings-panel" data-cloud-section="'+escape(selected)+'">';
    if(backup)html+='<div class="settings-intro"><strong>账号云备份</strong>只保存最近一次基础设置、预设、剪影位置、已审核头像和助手预设。参考图、自定义剪影图片、缓存、项目、幕布和聊天留在本机。</div>'
      // ⭐⭐ 2026-10-10（用户定）：同意状态 + 撤回入口 + 把"管理员能解密"写在界面上。
      //   ⚠ 不能只写在弹窗里 —— 用户同意完就忘了，回头想撤回找不到地方。
      +'<div class="settings-section"><div class="settings-section-title">传到云端的东西 + 你的同意</div>'
      +'<div class="settings-note" role="status">'+(p.consent
        ? '✔ 你已经同意过把上面那些传到云端。<br>⚠ 提醒：云端是加密存的，但解密密钥在服务器上 —— 理论上有服务器权限的人（平台管理员）可以解开。不接受就点下面「撤回同意」。'
        : (p.consentAsked
            ? '你上次没有同意。现在不会往云端传任何东西 —— 只留在本机也是完整可用的。想改主意就点「再看一遍说明」。'
            : '你还没同意过。第一次上传时会弹一次说明，看清楚再决定。'))+'</div>'
      +'<div class="settings-actions">'
      +'<button class="settings-btn" data-cloud="consentText">再看一遍说明</button>'
      +'<button class="settings-btn danger" data-cloud="revokeConsent" '+(p.consent?'':'disabled')+'>撤回同意（并删除云端备份）</button>'
      +'</div></div>'
      +'<div class="settings-section"><div class="settings-section-title">备份与恢复点</div><div class="settings-note" role="status">'+escape(info?('云备份时间：'+info.created_at+' · '+Math.ceil(info.size_bytes/1024)+' KB / '+Math.floor((lastInfo.quotaBytes||20971520)/1024)+' KB'):'尚未查询云备份')+'</div><div class="settings-actions"><button class="settings-btn" data-cloud="refresh">查询云备份</button><button class="settings-btn" data-cloud="upload">上传本机备份</button><button class="settings-btn" data-cloud="restore">恢复云备份</button><button class="settings-btn" data-cloud="rollback">恢复前的本机恢复点</button><button class="settings-btn danger" data-cloud="delete">删除云备份</button></div></div>';
    if(preferences)html+='<div class="settings-section"><div class="settings-section-title">自动备份设置</div><div class="settings-grid"><label class="settings-field"><span>自动上传备份</span><input type="checkbox" data-cloud-auto '+(p.enabled?'checked':'')+'></label><label class="settings-field"><span>间隔分钟（5–1440）</span><input type="number" data-cloud-interval min="5" max="1440" value="'+escape(p.intervalMinutes)+'"></label></div><div class="settings-note">默认关闭。只在软件打开且登录时运行。断网后保留待上传提示，恢复网络后由你确认；超过额度会暂停上传，清理后可重试。</div></div>';
    if(keys)html+='<div class="settings-section"><div class="settings-section-title">API Key 云同步</div><div class="settings-note" role="status">'+(p.keySync?'已同意加密上传。':'云端同步关闭。')+' 本机由系统安全存储保护，不保存到普通设置文件。</div><div class="settings-actions"><button class="settings-btn" data-cloud="enableKeys">同意并上传 Key</button><button class="settings-btn" data-cloud="restoreKeys">取回云端 Key</button><button class="settings-btn" data-cloud="stopKeys">停止后续同步</button><button class="settings-btn danger" data-cloud="deleteKeys">停止并删除云端 Key</button></div></div>';
    html+='<div class="settings-status" role="status" aria-live="polite"><span>'+escape(status)+'</span></div>';
    if(!signed())html+='<div class="settings-actions"><button class="settings-btn" data-cloud-route="settings/account">登录账号</button></div>';
    if(selected==='backup')html+='<div class="settings-actions"><button class="settings-btn" data-cloud-route="settings/backup">自动备份设置</button><button class="settings-btn" data-cloud-route="settings/keys">API Key 同步设置</button></div>';
    if(selected==='preferences')html+='<div class="settings-actions"><button class="settings-btn" data-cloud-route="records/backup">备份与恢复记录</button></div>';
    if(boundOptions.showBack!==false)html+='<div class="settings-actions"><button class="settings-btn" data-cloud="back">返回连接设置</button></div>';
    return html+'</div>';
  }
  function render(){if(!bound?.isConnected)return;bound.innerHTML=markup();bound.querySelectorAll('[data-cloud]').forEach(button=>{const name=button.dataset.cloud;button.disabled=busy&&name!=='back'||!signed()&&!['back','rollback'].includes(name);button.onclick=()=>run(async()=>{
    if(name==='refresh'){const op=operation(),info=await root.V7Backend.backupInfo();op.check();lastInfo=info;status=lastInfo.backup?'已读取备份信息。':'云端暂无备份。';}
    if(name==='upload')await upload();if(name==='restore')await restore();if(name==='rollback')await rollback();
    if(name==='delete'){const op=operation(),agreed=await confirm('删除云端备份','云端只保存这一份备份；删除后需要重新上传。','删除备份');op.check();if(agreed){await root.V7Backend.deleteBackup();op.check();lastInfo=null;save({choice:'local'});status='已删除云端备份。';}}
    if(name==='enableKeys')await uploadKeys();if(name==='restoreKeys')await restoreKeys();if(name==='stopKeys')await stopKeys(false);if(name==='deleteKeys')await stopKeys(true);
    // ⭐ 2026-10-10：同意书——"再看一遍"和"撤回"
    //   ⚠ "再看一遍"要【重新问】：不清 consentAsked 的话，用户拒绝过一次就再也没机会同意了。
    //     清掉之后下次上传会重新弹 —— 这才是"可以改主意"。
    if(name==='consentText'){save({consentAsked:false});await confirm('云备份会传什么、谁能看',consentBody(),'知道了');}
    if(name==='revokeConsent'){
      const op=operation();
      const agreed=await confirm('撤回同意并删除云端备份',
        '撤回后：\n  · 云端那一份备份会被删掉（不可恢复）\n  · 自动上传会一起关掉\n  · 你本机的设置和预设【不受影响】，照常能用\n\n确定要撤回吗？','撤回并删除');
      op.check();
      if(agreed){
        // ⚠ 顺序：先删云端再改标记。反过来的话，删失败了但标记已经变成"没同意"，
        //   用户会以为云端已经空了 —— 而数据还在。
        await root.V7Backend.deleteBackup();op.check();
        lastInfo=null;
        save({consent:false,consentAsked:false,enabled:false,keySync:false,choice:'pending'});
        status='已撤回同意，云端备份已删除；自动上传也关了。';
      }
    }
    if(name==='back'){bound=null;host.back?.();}
  });});
    bound.querySelectorAll('[data-cloud-route]').forEach(button=>button.onclick=()=>root.V7RouteRegistry?.open(button.dataset.cloudRoute));
    const automatic=bound.querySelector('[data-cloud-auto]');if(automatic)automatic.onchange=event=>run(()=>{if(!signed()){event.target.checked=false;return inform('请先登录账号');}save({enabled:event.target.checked});status=prefs().choice==='pending'?'先选择恢复云备份，或手动上传以本机为默认，之后才开始自动上传。':'已更新定时上传设置。';});
    const interval=bound.querySelector('[data-cloud-interval]');if(interval)interval.onchange=event=>run(()=>{save({intervalMinutes:Math.max(5,Math.min(1440,Number(event.target.value)||30))});});
  }
  async function changed(){const next=signed()?scope():'',session=root.V7Backend.state().sessionVersion;if(next===accountScope&&session===accountSession)return;accountScope=next;accountSession=session;lastInfo=null;const version=++checkVersion;schedule();if(!next)return;
    try{await recover(operation());current(next,version);const info=await root.V7Backend.backupInfo();current(next,version);lastInfo=info;
      if(!info.backup||info.backup.device_id===root.V7Backend.state().deviceId){if(prefs().choice==='pending')save({choice:'local'});}
      else if(prefs().choice==='pending'){status='此账号有另一台电脑的云备份。恢复或手动上传以本机为准之前，不会自动覆盖云端。';
        // ⭐ 2026-10-21（用户定）：换电脑登录 → 直接问要不要恢复（原来只弹一条通知让用户自己去找）。同一份备份只问一次，之后照旧只提醒。
        const sig=String(info.backup.id||'')+'|'+String(info.backup.updated_at||info.backup.created_at||'');
        if(prefs().askedRestoreFor!==sig){
          save({askedRestoreFor:sig});
          const ok=await confirm('发现这个账号的云备份','这个账号在另一台电脑上传过云备份（基础设置、预设、助手预设）。要恢复到这台电脑吗？\n\n恢复前会先给这台电脑留一份恢复点；本机的图片、历史和聊天不会被覆盖。主题、卡片排布和快捷键跟这台电脑走，不会被改。\n\n现在不恢复也行，以后在「记录与恢复 → 恢复与备份 → 账号备份」里随时可以恢复。','现在恢复');
          current(next,version);
          if(ok)run(()=>restoreAccount(true));
        }else if(root.UI?.notice)root.UI.notice({title:'发现账号云备份',body:status,detail:'在记录与恢复 → 恢复与备份 → 账号备份中选择。',level:'info'});}
      render();
    }catch(error){if(version===checkVersion)report(error);}
  }
  function configure(options){host=options||{};root.V7Backend.onChange(changed);root.addEventListener('wheelchair:storage-context',()=>{checkVersion++;lastInfo=null;if(timer)clearInterval(timer);timer=null;});root.addEventListener('online',()=>{if(prefs().pendingUpload)inform('网络已恢复；有一份待上传备份，请在云备份页面点击上传确认。');});changed();}
  function open(element,options={}){bound=element;boundOptions=options;render();return ()=>{if(bound===element){bound=null;boundOptions={};}};}
  root.V7CloudBackup={configure,open,upload,restore,rollback,restoreKeys,uploadKeys,stopKeys,scopeChanged:changed};
})(window);
