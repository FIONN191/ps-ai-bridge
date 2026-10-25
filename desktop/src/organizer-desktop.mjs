import { app, BrowserWindow, WebContentsView, session, ipcMain, shell, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

// Organizer desktop boundaries. Renderer owns CSS theme/layout/zoom; main owns
// opacity, the isolated reference view, and the durable reminder delivery ledger.
export function validateOrganizerHTTPS(value) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('请输入有效的 HTTPS 地址');
  let url; try { url = new URL(value); } catch { throw new Error('请输入有效的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('只允许不含凭证的 HTTPS 地址');
  return url.href;
}
export function validateOrganizerLayout(value) {
  if (!value || !['full','compact'].includes(value.mode) || !['dark','light','system'].includes(value.theme)
    || !Number.isFinite(value.zoom) || value.zoom < .75 || value.zoom > 1.5
    || !Number.isFinite(value.opacity) || value.opacity < .5 || value.opacity > 1) throw new Error('布局参数无效');
  return { mode:value.mode, theme:value.theme, zoom:value.zoom, opacity:value.opacity };
}
function organizerProjects(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('提醒项目应为最多 1000 项的列表');
  const seen = new Set();
  return value.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[\w-]{1,180}$/.test(p.id) || seen.has(p.id)
      || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200 || /[\x00-\x1f]/.test(p.title)
      || typeof p.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.due)) throw new Error('提醒项目格式或日期无效');
    const [year,month,day] = p.due.split('-').map(Number), d = new Date(year,month-1,day,9);
    if (year < 2000 || d.getFullYear() !== year || d.getMonth() !== month-1 || d.getDate() !== day) throw new Error('提醒日期无效');
    seen.add(p.id); return {id:p.id,title:p.title.trim(),due:p.due};
  });
}
const organizerDueAt = due => { const [y,m,d]=due.split('-').map(Number); return new Date(y,m-1,d,9).getTime(); };
function atomicOrganizerState(file, value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`; let fd;
  try { fd=fs.openSync(temporary,'wx',0o600); fs.writeFileSync(fd,JSON.stringify(value,null,2)); fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file); }
  finally { if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
}

export function createOrganizerDesktop({
  getWindow, ipc = ipcMain, openHTTPS = url => shell.openExternal(url),
  notificationFile = path.join(app.getPath('userData'),'organizer-notifications.json'),
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console.warn,
  writeState = atomicOrganizerState, makeReferenceView = options => new WebContentsView(options),
  getReferenceSession = () => session.fromPartition('persist:ps-ai-bridge-reference-v1'),
  onNotificationClick, fetchJobs,
  makeFloatingWindow = options => new BrowserWindow(options),
  floatingFile = path.join(app.getPath('userData'),'organizer-floating.json'),
  displayArea = bounds => (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea,
} = {}) {
  if(typeof getWindow!=='function')throw new Error('Organizer requires getWindow');
  const channels=[], MAX_WAIT=60000, ACK_WAIT=30000, MAX_ATTEMPTS=3;
  let state={schemaVersion:1,enabled:false,projects:[]}, timer=null, ready=false, permission='default', pending=null, disposed=false, corrupt=false;
  let reference=null, referenceWidth=420, referenceURL='', referenceError='', referenceLoading=false, attached=null;
  let floating=null, floatingTimer=null, floatingRequest=null, floatingBoundsTimer=null;
  let floatingSnapshot={jobs:[],updatedAt:0,offline:false,scope:'最近 200 条任务'};
  const floatingURL=pathToFileURL(path.join(here,'renderer','floating.html')).href;
  const rendererURL=pathToFileURL(path.join(here,'renderer','index.html')).href;
  function trusted(event, floatingOnly=false) {
    const window=floatingOnly?floating:getWindow();
    if(!window || window.isDestroyed() || event.sender!==window.webContents || !event.senderFrame || event.senderFrame!==window.webContents.mainFrame) throw new Error('不允许此窗口调用桌面接口');
    const url=new URL(event.senderFrame.url);url.search='';url.hash='';
    if(url.href!==(floatingOnly?floatingURL:rendererURL))throw new Error('不允许此页面调用桌面接口');
    return window;
  }
  function save(next) { writeState(notificationFile,next);state=next; }
  function stopTimer(){if(timer!==null)clearTimer(timer);timer=null;}
  function referenceState(){return {open:!!reference,width:reference?.getBounds().width||0,requestedWidth:referenceWidth,url:referenceURL,loading:referenceLoading,error:referenceError};}
  function publishReference(){const w=getWindow();if(w&&!w.isDestroyed())w.webContents.send('organizer:reference-state',referenceState());}
  function layoutReference(){
    if(!reference)return;
    const w=getWindow();if(!w||w.isDestroyed())return;
    const [width,height]=w.getContentSize();
    const bounded=Math.max(0,Math.min(referenceWidth,720,Math.floor(width*.5),width-560));
    reference.setBounds({x:width-bounded,y:0,width:bounded,height:Math.max(0,height)});publishReference();
  }
  function closeReference(){
    if(reference){const old=reference;reference=null;const w=getWindow();if(w&&!w.isDestroyed())w.contentView.removeChildView(old);if(!old.webContents.isDestroyed())old.webContents.close({waitForBeforeUnload:false});}
    referenceURL='';referenceError='';referenceLoading=false;publishReference();return referenceState();
  }
  function validateReferenceURL(value){
    const url=validateOrganizerHTTPS(value),u=new URL(url);
    if(['accounts.google.com','auth.openai.com','auth0.openai.com'].includes(u.hostname)
      || (['chatgpt.com','chat.openai.com'].includes(u.hostname) && /^\/(?:auth|login)(?:\/|$)/.test(u.pathname)))throw new Error('Google / ChatGPT 登录请使用现有专用 Chrome 通道');
    return url;
  }
  function validateReferenceWidth(value){if(!Number.isInteger(value)||value<240||value>720)throw new Error('参考窗宽度应为 240–720');return value;}
  async function openReference(body){
    const url=validateReferenceURL(body?.url);if(body.width!==undefined)validateReferenceWidth(body.width);
    const w=getWindow();if(!w||w.isDestroyed())throw new Error('主窗口不可用');
    if(body.width!==undefined)referenceWidth=body.width;
    if(!reference){
      const partition=getReferenceSession();
      partition.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
      partition.setPermissionCheckHandler(()=>false);
      partition.setDevicePermissionHandler(()=>false);
      partition.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
      // No downloads, permissions, local-file requests, or local helper access in
      // the persistent reference-only session. Never share the app's session.
      partition.removeAllListeners('will-download');
      partition.on('will-download',event=>event.preventDefault());
      partition.webRequest.onBeforeRequest((details,callback)=>{
        let cancel=false;try{const u=new URL(details.url);cancel=!['https:','wss:','data:','blob:'].includes(u.protocol);}catch{cancel=true;}callback({cancel});
      });
      reference=makeReferenceView({webPreferences:{session:partition,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,navigateOnDragDrop:false}});
      const wc=reference.webContents;
      const guardNavigation=(event,legacyURL)=>{
        try{validateReferenceURL(event.url||legacyURL);}catch(e){event.preventDefault();referenceError=e.message;publishReference();}
      };
      wc.on('will-navigate',guardNavigation);wc.on('will-frame-navigate',guardNavigation);wc.on('will-redirect',guardNavigation);
      wc.on('will-attach-webview',event=>event.preventDefault());
      wc.setWindowOpenHandler(({url})=>{try{Promise.resolve(openHTTPS(validateOrganizerHTTPS(url))).catch(()=>{referenceError='无法打开外部 HTTPS 链接';publishReference();});}catch{referenceError='已阻止非 HTTPS 弹出窗口';publishReference();}return {action:'deny'};});
      wc.on('did-start-loading',()=>{referenceLoading=true;publishReference();});
      wc.on('did-stop-loading',()=>{referenceLoading=false;publishReference();});
      wc.on('did-navigate',(_event,url)=>{referenceURL=url;referenceError='';publishReference();});
      wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){referenceError='参考网页未能加载，可重试或在浏览器打开';publishReference();}});
      wc.on('render-process-gone',()=>{closeReference();});
      w.contentView.addChildView(reference);
    }
    const current=reference;referenceURL=url;referenceError='';layoutReference();
    try{await current.webContents.loadURL(url);}catch(e){if(reference===current){referenceError='参考网页未能加载，可重试或在浏览器打开';publishReference();}throw new Error('参考网页加载失败');}
    return referenceState();
  }
  function arm(){
    stopTimer();if(disposed||corrupt||!ready||permission!=='granted'||!state.enabled)return;
    const candidates=state.projects.filter(p=>!p.notifiedAt&&p.attempts<MAX_ATTEMPTS);
    if(!candidates.length&&!pending)return;
    const next=pending?pending.deadline:Math.min(...candidates.map(p=>Math.max(organizerDueAt(p.due),p.lastAttemptAt?p.lastAttemptAt+MAX_WAIT:0)));
    // Recheck at least every minute for wall-clock/DST changes and resume from sleep.
    timer=setTimer(()=>{timer=null;tick();},Math.max(1000,Math.min(MAX_WAIT,next-now())));timer?.unref?.();
  }
  function tick(){
    if(disposed||!ready||permission!=='granted'||!state.enabled||corrupt)return;
    try {
      if(pending){if(pending.deadline>now()){arm();return;}pending=null;}
      const p=state.projects.filter(p=>!p.notifiedAt&&p.attempts<MAX_ATTEMPTS&&organizerDueAt(p.due)<=now()&&(!p.lastAttemptAt||p.lastAttemptAt+MAX_WAIT<=now())).sort((a,b)=>a.due.localeCompare(b.due)||a.id.localeCompare(b.id))[0];
      if(p){
        const w=getWindow();if(!w||w.isDestroyed()){ready=false;return;}
        // Persist the attempt before sending. A crash cannot cause a rapid retry loop.
        const token=crypto.randomUUID(),at=now();
        save({...state,projects:state.projects.map(x=>x.id===p.id?{...x,attempts:x.attempts+1,lastAttemptAt:at,lastStatus:'awaiting-confirmation'}:x)});
        pending={token,id:p.id,due:p.due,deadline:at+ACK_WAIT};
        w.webContents.send('organizer:notification',{token,id:p.id,title:p.title,due:p.due});
      }
      arm();
    }catch{stopTimer();log('[organizer] 提醒状态写入失败，已暂停派发；请在项目页重新启用提醒。');}
  }
  function restore(){
    stopTimer();pending=null;ready=false;disposed=false;
    if(!fs.existsSync(notificationFile))return;
    try{
      const stored=JSON.parse(fs.readFileSync(notificationFile,'utf8'));
      if(stored.schemaVersion!==1||typeof stored.enabled!=='boolean')throw new Error('schema');
      const projects=organizerProjects(stored.projects).map((p,i)=>{
        const old=stored.projects[i];
        if(!Number.isInteger(old.attempts)||old.attempts<0||old.attempts>MAX_ATTEMPTS||!Number.isFinite(old.lastAttemptAt)||old.lastAttemptAt<0||!Number.isFinite(old.notifiedAt)||old.notifiedAt<0)throw new Error('ledger');
        return {...p,attempts:old.attempts,lastAttemptAt:old.lastAttemptAt,notifiedAt:old.notifiedAt,lastStatus:String(old.lastStatus||'').slice(0,40)};
      });
      state={schemaVersion:1,enabled:stored.enabled,projects};corrupt=false;
    }catch{corrupt=true;log('[organizer] 提醒文件损坏，已保留原文件并暂停提醒。');}
    // No Notification constructor or requestPermission here. Preload reports
    // existing permission after DOMContentLoaded; only a user action may request it.
  }
  function registerIpc(){
    const handle=(name,fn,floatingOnly=false)=>{channels.push(name);ipc.handle(name,(event,...args)=>{const w=trusted(event,floatingOnly);return fn(...args,w);});};
    handle('organizer:floating-open',()=>openFloating());
    handle('organizer:floating-close',()=>{floating?.close();return {open:false};});
    handle('organizer:floating-state',()=>floatingSnapshot,true);
    handle('organizer:floating-home',()=>{onNotificationClick?.();return {ok:true};},true);
    handle('organizer:floating-dismiss',()=>{floating?.close();return {open:false};},true);
    handle('organizer:layout',value=>{
      const v=validateOrganizerLayout(value),w=getWindow();w.setOpacity(v.opacity);
      if(Math.abs(w.getOpacity()-v.opacity)>.02)throw new Error('当前系统未应用窗口透明度');
      // Do not setZoomFactor/setZoomLevel: the renderer already applies CSS zoom.
      return {applied:true,opacity:w.getOpacity()};
    });
    handle('organizer:open-https',value=>openHTTPS(validateOrganizerHTTPS(value)));
    handle('organizer:notifications-schedule',body=>{
      const projects=organizerProjects(body?.projects);
      if(corrupt)throw new Error('提醒文件损坏，已保留原文件；请先恢复提醒文件');
      if(projects.length&&body.permission!=='granted')throw new Error('请点击启用提醒并允许通知');
      const next=projects.map(p=>{
        const old=state.projects.find(x=>x.id===p.id&&x.due===p.due);
        return {...p,notifiedAt:old?.notifiedAt||0,attempts:0,lastAttemptAt:0,lastStatus:old?.notifiedAt?'shown':'scheduled'};
      });
      save({schemaVersion:1,enabled:!!projects.length,projects:next});pending=null;permission=body.permission;ready=true;arm();
      return {scheduled:next.filter(p=>!p.notifiedAt).length,dueHourLocal:9};
    });
    handle('organizer:notifications-ready',body=>{ready=true;permission=['granted','denied','default'].includes(body?.permission)?body.permission:'default';arm();return {enabled:state.enabled,pending:state.projects.filter(p=>!p.notifiedAt).length};});
    handle('organizer:notification-result',body=>{
      if(!pending||body?.token!==pending.token)return {accepted:false};
      if(!['shown','failed','permission-blocked'].includes(body.status))throw new Error('通知状态无效');
      const current=pending;
      save({...state,projects:state.projects.map(p=>p.id===current.id&&p.due===current.due?{...p,notifiedAt:body.status==='shown'?now():p.notifiedAt,lastStatus:body.status}:p)});
      pending=null;if(body.status==='permission-blocked')permission='denied';arm();return {accepted:true};
    });
    handle('organizer:notification-open',body=>{if(state.projects.some(p=>p.id===body?.id&&p.due===body?.due&&p.notifiedAt))onNotificationClick();});
    handle('organizer:reference-open',body=>openReference(body));
    handle('organizer:reference-close',()=>closeReference());
    handle('organizer:reference-size',body=>{referenceWidth=validateReferenceWidth(body?.width);layoutReference();return referenceState();});
    handle('organizer:reference-state',()=>referenceState());
  }

  function stopFloatingPoll(){
    if(floatingTimer!==null)clearTimer(floatingTimer);floatingTimer=null;
    floatingRequest?.abort();floatingRequest=null;
    if(floatingBoundsTimer!==null)clearTimer(floatingBoundsTimer);floatingBoundsTimer=null;
  }
  function saveFloatingBounds(){
    if(!floating||floating.isDestroyed())return;
    try{writeState(floatingFile,{schemaVersion:1,bounds:floating.getBounds()});}catch{log('[organizer] 浮动窗口位置保存失败');}
  }
  function floatingBounds(){
    let bounds;
    try{const saved=JSON.parse(fs.readFileSync(floatingFile,'utf8'));const b=saved.bounds;if(saved.schemaVersion===1&&['x','y','width','height'].every(k=>Number.isInteger(b?.[k])&&Math.abs(b[k])<100000))bounds=b;}catch{}
    const area=displayArea(bounds);
    const width=Math.min(area.width,Math.max(280,Math.min(480,bounds?.width||340)));
    const height=Math.min(area.height,Math.max(220,Math.min(620,bounds?.height||390)));
    return {width,height,x:Math.round(Math.max(area.x,Math.min(area.x+area.width-width,bounds?.x??area.x+area.width-width-20))),y:Math.round(Math.max(area.y,Math.min(area.y+area.height-height,bounds?.y??area.y+20)))};
  }
  async function pollFloating(){
    const target=floating;if(!target||target.isDestroyed()||disposed)return;
    const controller=new AbortController();floatingRequest=controller;
    const deadline=setTimer(()=>controller.abort(),5000);deadline?.unref?.();
    try{
      const result=await fetchJobs(controller.signal);
      if(!Array.isArray(result?.jobs))throw new Error('invalid jobs');
      const jobs=result.jobs.slice(0,200).map(j=>({id:String(j.id),title:String(j.meta?.title||j.prompt||j.id).slice(0,120),status:String(j.status),stage:String(j.stage||''),error:j.status==='error'?String(j.error||'任务失败').slice(0,300):'',createdAt:Number(j.createdAt)||0}));
      if(floating===target&&!target.isDestroyed())floatingSnapshot={jobs,updatedAt:now(),offline:false,scope:'最近 200 条任务'};
    }catch{if(floating===target&&!target.isDestroyed())floatingSnapshot={...floatingSnapshot,offline:true};}
    finally{
      clearTimer(deadline);if(floatingRequest===controller)floatingRequest=null;
      if(floating===target&&!target.isDestroyed()&&!disposed){target.webContents.send('organizer:floating-state',floatingSnapshot);floatingTimer=setTimer(()=>{floatingTimer=null;pollFloating();},2500);floatingTimer?.unref?.();}
    }
  }
  function openFloating(){
    if(typeof fetchJobs!=='function')throw new Error('任务状态接口不可用');
    if(floating&&!floating.isDestroyed()){floating.show();floating.focus();return {open:true};}
    floating=makeFloatingWindow({...floatingBounds(),minWidth:280,minHeight:220,maxWidth:480,maxHeight:620,title:'任务进度',alwaysOnTop:true,show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(here,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const current=floating;
    current.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    current.webContents.on('will-navigate',(event)=>event.preventDefault());
    current.webContents.on('will-attach-webview',event=>event.preventDefault());
    current.once('ready-to-show',()=>{current.show();});
    current.on('move',()=>{if(floatingBoundsTimer!==null)clearTimer(floatingBoundsTimer);floatingBoundsTimer=setTimer(()=>{floatingBoundsTimer=null;saveFloatingBounds();},300);});
    current.on('resize',()=>{if(floatingBoundsTimer!==null)clearTimer(floatingBoundsTimer);floatingBoundsTimer=setTimer(()=>{floatingBoundsTimer=null;saveFloatingBounds();},300);});
    current.on('close',saveFloatingBounds);
    current.once('closed',()=>{if(floating===current){floating=null;stopFloatingPoll();}});
    current.loadFile(path.join(here,'renderer','floating.html')).then(()=>{if(floating===current)pollFloating();}).catch(()=>{if(floating===current)current.close();log('[organizer] 浮动窗口加载失败');});
    return {open:true};
  }
  function rendererUnavailable(){ready=false;stopTimer();pending=null;closeReference();}
  function attachWindow(window){
    if(attached){attached.removeListener('resize',layoutReference);attached.webContents.removeListener('did-start-loading',rendererUnavailable);attached.webContents.removeListener('render-process-gone',rendererUnavailable);}
    attached=window;ready=false;
    window.on('resize',layoutReference);window.webContents.on('did-start-loading',rendererUnavailable);window.webContents.on('render-process-gone',rendererUnavailable);
    window.once('closed',rendererUnavailable);
  }
  function dispose(){disposed=true;stopTimer();closeReference();floating?.close();stopFloatingPoll();for(const channel of channels)ipc.removeHandler(channel);channels.length=0;}
  return {restore,registerIpc,attachWindow,dispose};
}
