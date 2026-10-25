// Shared settings editor, copied into the desktop renderer by the build script.
function mountApiSettings({ root, request, select, plugin=false, openLink }) {
 const escape=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const dropdown=name=>plugin?`<div class="dd" data-api="${name}"></div>`:`<select data-api="${name}"></select>`;
 root.innerHTML=`<div class="api-editor">
 <p class="small mute">墨墨、GRS、自定义兼容接口。配置在桌面端与 Photoshop 共用，保存后直接生效。</p>
 <label class="field">配置方案${dropdown('profile')}</label><div class="api-actions"><button data-api="new">新增配置 / Key</button><button data-api="refresh">刷新</button><button data-api="delete">移除配置</button></div>
 <label class="field">服务商${dropdown('kind')}</label><label class="field">配置名称<input data-api="title" maxlength="100" placeholder="例如 墨墨 · 主账号"></label>
 <label class="field">API 节点${dropdown('node')}</label><label class="field">Base URL<input data-api="url" placeholder="https://..."></label>
 <label class="field">接口格式${dropdown('protocol')}</label>
 <label class="field">API Key<input data-api="key" type="password" autocomplete="off" placeholder="填写 Key；保存后不回显"></label>
 <div class="api-actions"><button data-api="show">显示输入</button><label class="check"><input type="checkbox" data-api="clear">清除已存 Key</label></div>
 <div class="api-actions"><button data-api="fetch">读取模型列表</button><button data-api="test">检测连接</button><button data-api="balance">查询额度</button></div>
 <label class="check"><input type="checkbox" data-api="filter" checked>仅显示图像模型</label>
 <label class="field">可选模型${dropdown('models')}</label><label class="field">默认模型 ID（可手动填写）<input data-api="model" placeholder="从上方选择，或填写服务商的模型 ID"></label>
 <label class="check"><input type="checkbox" data-api="enabled" checked>启用此生成渠道</label>
 <label class="check"><input type="checkbox" data-api="assist">AI 帮写复用此渠道（会按服务商规则计费）</label>
 <label class="field">帮写用的文本 / 视觉模型 ID<input data-api="textModel" placeholder="支持 Chat Completions；看图需视觉模型"></label>
 <div class="api-actions"><button data-api="save" class="primary">保存 API 配置</button><button data-api="website">获取 Key / 充值</button><button data-api="docs">接口文档</button></div>
 <p class="small mute">检测与查询读取已保存配置，不提交生图。每套配置对应独立的 Key；未选择 API 帮写时沿用 Codex。</p>
 <p class="api-status small" data-api="status" role="status">点击刷新加载配置</p></div>`;
 const el=name=>root.querySelector(`[data-api="${name}"]`);
 let state=null,current=null,allModels=[],models=[],dirty=false,working=false,deleteArmed=false;
 const status=text=>el('status').textContent=text;
 const isImage=id=>/image|banana|imagen|flux|dall-e|sdxl|stable-diffusion/i.test(id);
 function options(name,items,value){select(el(name),items,value);}
 function modelOptions(){const list=el('filter').checked?models:allModels;options('models',[['','请选择或手动填写'],...list.map(v=>[v,v])],el('model').value);}
 function serviceOptions(kind,protocol,url){const p=state.presets[kind];options('node',[[...['','自定义地址']],...p.urls.map((u,i)=>[u,kind==='grs'?(i===0?'海外节点':'国内直连'):u])],url||p.urls[0]||'');options('protocol',kind==='grs'?[['grs-banana','GRS · Nano Banana'],['grs-gpt','GRS · GPT Image']]:[['gemini','Gemini 兼容（Nano Banana）'],['images','OpenAI Images 兼容（GPT Image）']],protocol||p.protocol);el('url').value=url||p.urls[0]||'';el('url').disabled=kind!=='custom';el('node').style.display=kind==='custom'?'none':'block';el('docs').disabled=!p.docs&&kind!=='momo';el('website').disabled=!p.website;}
 function draw(p){current=p||null;models=p?.models?.slice()||[];allModels=models.slice();el('title').value=p?.title||'';options('kind',Object.entries(state.presets).map(([k,v])=>[k,v.title]),p?.kind||'momo');serviceOptions(p?.kind||'momo',p?.protocol,p?.url);el('key').value='';el('key').type='password';el('show').textContent='显示输入';el('key').placeholder=p?.hasKey?'已保存 Key；留空保留，勾选下方可清除':'填写自己的 API Key';el('clear').checked=false;el('enabled').checked=p?.enabled!==false;el('model').value=p?.model||'';el('textModel').value=p?.textModel||'';el('assist').checked=!!p&&state.assistId===p.id;modelOptions();dirty=false;deleteArmed=false;el('delete').textContent='移除配置';el('delete').disabled=!p;}
 async function refresh(id){state=await request('GET','/api-channels');const selected=id===null?null:state.profiles.find(p=>p.id===(id||current?.id))||state.profiles[0];options('profile',[['','新配置'],...state.profiles.map(p=>[p.id,`${p.title}${p.hasKey?' · 已存 Key':''}`])],selected?.id||'');draw(selected);}
 function guard(fn){return async()=>{if(working)return;working=true;try{await fn();}catch(e){status(String(e.message||e).replace(/^Error invoking remote method '[^']+': (Error: )?/,''));}finally{working=false;}};}
 function saved(){if(!current)throw new Error('请先保存配置');if(dirty)throw new Error('有未保存的修改，请先点「保存 API 配置」');return current.id;}
 for(const name of ['title','url','key','model','textModel'])el(name).addEventListener('input',()=>{dirty=true;});
 for(const name of ['clear','enabled','assist'])el(name).addEventListener('change',()=>{dirty=true;});
 el('kind').addEventListener('change',()=>{serviceOptions(el('kind').value);el('model').value='';el('key').value='';models=[];allModels=[];modelOptions();dirty=true;});
 el('node').addEventListener('change',()=>{if(el('node').value)el('url').value=el('node').value;dirty=true;});
 el('protocol').addEventListener('change',()=>{models=[];allModels=[];el('model').value='';modelOptions();dirty=true;});
 el('models').addEventListener('change',()=>{if(el('models').value){el('model').value=el('models').value;dirty=true;}});
 el('filter').addEventListener('change',modelOptions);
 el('profile').addEventListener('change',()=>{if(dirty){options('profile',[['','新配置'],...state.profiles.map(p=>[p.id,p.title])],current?.id||'');status('请先保存修改，或点刷新放弃修改');return;}draw(state.profiles.find(p=>p.id===el('profile').value));status('已切换配置');});
 el('new').onclick=()=>{if(dirty){status('请先保存修改，或点刷新放弃修改');return;}el('profile').value='';draw(null);status('填写新配置，保存后会出现在平台列表');};
 el('refresh').onclick=guard(async()=>{await refresh();status('已刷新（未保存的输入已清除）');});
 el('show').onclick=()=>{el('key').type=el('key').type==='password'?'text':'password';el('show').textContent=el('key').type==='password'?'显示输入':'隐藏输入';};
 el('save').onclick=guard(async()=>{if(!state)throw new Error('先刷新配置');const r=await request('POST','/api-channels/save',{id:current?.id,revision:state.revision,kind:el('kind').value,title:el('title').value,url:el('url').value,protocol:el('protocol').value,key:el('key').value,clearKey:el('clear').checked,model:el('model').value,models,enabled:el('enabled').checked,textModel:el('textModel').value,useForAssist:el('assist').checked});await refresh(r.profile.id);status('已保存；平台列表将自动刷新。Key 不会回显。');});
 el('delete').onclick=guard(async()=>{const id=saved();if(!deleteArmed){deleteArmed=true;el('delete').textContent='确认移除';status('再次点击移除；历史任务和图片会保留');return;}await request('POST','/api-channels/delete',{id,revision:state.revision});await refresh();status('配置已移除；本机配置文件保留归档');});
 el('fetch').onclick=guard(async()=>{const id=saved();status('正在读取模型…');const r=await request('POST','/api-channels/models',{id});models=r.models;allModels=r.allModels||models;modelOptions();dirty=true;status(`${r.source} · ${models.length} 个图像模型。选好默认模型后保存。`);});
 el('test').onclick=guard(async()=>{const id=saved();status('正在检测连接…');const r=await request('POST','/api-channels/test',{id});status(`${r.note} · ${r.latency} ms`);});
 el('balance').onclick=guard(async()=>{const id=saved();status('正在查询额度…');const r=await request('POST','/api-channels/balance',{id});status(r.unlimited?'此 Key 未设置额度上限（不代表账户余额无限）':`Key 可用：${r.available} ${r.unit}${r.used!=null?'；已用：'+r.used:''}`);});
 el('website').onclick=()=>{const p=state?.presets[el('kind').value];if(p?.website)openLink(p.website);};
 el('docs').onclick=()=>{const p=state?.presets[el('kind').value];if(p)openLink(p.docs||p.website);};
 return {refresh:guard(async()=>{if(!dirty){await refresh();status('配置已加载');}})};
}
