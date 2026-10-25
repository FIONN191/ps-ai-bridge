// 给页面用的接口：只开放这几个调用，页面本身拿不到 Node
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The floating card is trusted local UI, but receives only its three read/focus
// capabilities. It never loads the main application scripts or boots another app.
const organizerFloatingPage = globalThis.location?.protocol === 'file:' && globalThis.location.pathname.endsWith('/renderer/floating.html');
if (organizerFloatingPage) {
  contextBridge.exposeInMainWorld('bridge', {
    floatingState: () => ipcRenderer.invoke('organizer:floating-state'),
    returnToWorkspace: () => ipcRenderer.invoke('organizer:floating-home'),
    closeFloating: () => ipcRenderer.invoke('organizer:floating-dismiss'),
    onFloatingState: fn => {
      const listener = (_event, value) => fn(value);
      ipcRenderer.on('organizer:floating-state', listener);
      return () => ipcRenderer.removeListener('organizer:floating-state', listener);
    },
  });
} else {
// Permission prompts are confined to the explicit reminder button. On relaunch
// we only read Notification.permission; no prompt or notification is created.
const OrganizerNotification = globalThis.Notification;
const organizerNotices = new Set();
let organizerPermissionBusy = false;
let organizerActivatedThisSession = false;
const organizerPermission = () => OrganizerNotification?.permission || 'denied';
const reportOrganizerNotice = payload => ipcRenderer.invoke('organizer:notification-result',payload).catch(()=>{});
function retainOrganizerNotice(notice) {
  organizerNotices.add(notice);
  while(organizerNotices.size>8){const oldest=organizerNotices.values().next().value;organizerNotices.delete(oldest);oldest.close();}
  notice.onclose=()=>organizerNotices.delete(notice);
}
async function scheduleOrganizerNotifications(value) {
  if(!globalThis.navigator?.userActivation?.isActive)throw new Error('请点击项目页的启用 / 更新驻留提醒按钮');
  if(!Array.isArray(value?.projects)||value.projects.length>1000)throw new Error('提醒项目列表无效');
  if(!value.projects.length)return ipcRenderer.invoke('organizer:notifications-schedule',{projects:[],permission:organizerPermission()});
  if(organizerPermissionBusy)throw new Error('正在等待通知授权');
  if(!OrganizerNotification)throw new Error('当前系统不支持通知');
  organizerPermissionBusy=true;
  try {
    let permission=organizerPermission();
    if(permission==='default')permission=await OrganizerNotification.requestPermission();
    if(permission!=='granted')throw new Error('通知尚未允许，请在系统通知设置中允许本应用后重试');
    // Initialize native notification delivery during this user action, never on
    // startup or at a future deadline. A show event confirms the OS accepted it.
    if(!organizerActivatedThisSession)await new Promise((resolve,reject)=>{
      let notice,settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error){notice?.close();reject(error);}else{organizerActivatedThisSession=true;resolve();}};
      const timer=setTimeout(()=>finish(new Error('系统未确认通知已启用；请检查通知权限后重试')),30000);
      try{notice=new OrganizerNotification('项目提醒已启用',{body:'到期日当地时间 09:00 提醒；应用关闭期间错过的提醒将在下次运行时补发。',tag:'psai-organizer-enable',silent:true});retainOrganizerNotice(notice);notice.onshow=()=>finish();notice.onerror=()=>finish(new Error('系统未接受通知；请检查权限及应用签名后重试'));}catch(e){finish(e);}
    });
    return await ipcRenderer.invoke('organizer:notifications-schedule',{projects:value.projects,permission});
  }finally{organizerPermissionBusy=false;}
}
ipcRenderer.on('organizer:notification',(_event,message)=>{
  if(!message||typeof message.token!=='string'||typeof message.title!=='string')return;
  if(organizerPermission()!=='granted'){reportOrganizerNotice({token:message.token,status:'permission-blocked'});return;}
  try{
    const notice=new OrganizerNotification('项目到期提醒',{body:`${message.title} · ${message.due}`,tag:`psai-project-${message.id}-${message.due}`});
    retainOrganizerNotice(notice);
    notice.onshow=()=>reportOrganizerNotice({token:message.token,status:'shown'});
    notice.onerror=()=>reportOrganizerNotice({token:message.token,status:'failed'});
    notice.onclick=()=>{ipcRenderer.invoke('organizer:notification-open',{id:message.id,due:message.due}).catch(()=>{});notice.close();};
  }catch{reportOrganizerNotice({token:message.token,status:'failed'});}
});
globalThis.addEventListener('DOMContentLoaded',()=>{
  ipcRenderer.invoke('organizer:notifications-ready',{permission:organizerPermission()}).catch(()=>{});
},{once:true});

contextBridge.exposeInMainWorld('bridge', {
  openPack: () => ipcRenderer.invoke('pack:open'),
  savePack: (name, data) => ipcRenderer.invoke('pack:save', name, data),
  state: () => ipcRenderer.invoke('state'),
  logs: () => ipcRenderer.invoke('logs'),
  restartHelper: () => ipcRenderer.invoke('helper:restart'),
  open: (what) => ipcRenderer.invoke('open', what),
  openOrganizerFloating: () => ipcRenderer.invoke('organizer:floating-open'),
  closeOrganizerFloating: () => ipcRenderer.invoke('organizer:floating-close'),
  openExternalHTTPS: (url) => ipcRenderer.invoke('organizer:open-https', url),
  applyOrganizerLayout: (value) => ipcRenderer.invoke('organizer:layout', value),
  scheduleOrganizerNotifications,
  openOrganizerReference: (value) => ipcRenderer.invoke('organizer:reference-open', value),
  closeOrganizerReference: () => ipcRenderer.invoke('organizer:reference-close'),
  setOrganizerReferenceWidth: (width) => ipcRenderer.invoke('organizer:reference-size', { width }),
  organizerReferenceState: () => ipcRenderer.invoke('organizer:reference-state'),
  onOrganizerReferenceState: (fn) => {
    const listener = (_event, state) => fn(state);
    ipcRenderer.on('organizer:reference-state', listener);
    return () => ipcRenderer.removeListener('organizer:reference-state', listener);
  },
  installPlugin: (dirs) => ipcRenderer.invoke('plugin:install', dirs),
  uninstallPlugin: (dirs) => ipcRenderer.invoke('plugin:uninstall', dirs),
  installViaCC: () => ipcRenderer.invoke('plugin:installViaCC'),
  checkPluginUpdate: () => ipcRenderer.invoke('plugin:checkUpdate'),
  addPhotoshop: () => ipcRenderer.invoke('plugin:addPhotoshop'),
  removePhotoshop: (root) => ipcRenderer.invoke('plugin:removePhotoshop', root),
  setOpenAtLogin: (on) => ipcRenderer.invoke('settings:openAtLogin', on),
  setOnboarded: () => ipcRenderer.invoke('settings:onboarded'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateInstaller: () => ipcRenderer.invoke('update:open-installer'),
  skipUpdate: () => ipcRenderer.invoke('update:skip'),
  dismissUpdate: () => ipcRenderer.invoke('update:dismiss'),
  quitForUpdate: () => ipcRenderer.invoke('update:quit'),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, s) => fn(s)),
  // 工作台
  api: (method, path, body) => ipcRenderer.invoke('api', method, path, body),
  uploadFiles: (files, maxSide) => ipcRenderer.invoke('upload:files', files, maxSide),
  pickImages: (maxSide, multiple) => ipcRenderer.invoke('upload:pick', maxSide, multiple),
  uploadClipboard: () => ipcRenderer.invoke('upload:clipboard'),
  revealJob: (jobId) => ipcRenderer.invoke('job:reveal', jobId),
  copyImage: (path) => ipcRenderer.invoke('job:copyImage', path),
  copyText: (text) => ipcRenderer.invoke('clipboard:text', text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onHelper: (fn) => ipcRenderer.on('helper', (_e, s) => fn(s)),
  onLog: (fn) => ipcRenderer.on('log', (_e, line) => fn(line)),
});

}
