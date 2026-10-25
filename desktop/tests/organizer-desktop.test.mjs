import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'organizer-desktop-test-'));
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const electronStub='data:text/javascript,'+encodeURIComponent(`export const app={getPath:()=>${JSON.stringify(root)}};export const BrowserWindow=null,WebContentsView=null,session=null,ipcMain=null,shell=null,screen=null;`);
const hook=registerHooks({resolve(specifier,context,next){return specifier==='electron'?{url:electronStub,shortCircuit:true}:next(specifier,context);}});
const {createOrganizerDesktop,validateOrganizerHTTPS,validateOrganizerLayout}=await import('../src/organizer-desktop.mjs');hook.deregister();
class Contents extends EventEmitter {
 constructor(url){super();this.mainFrame={url};this.messages=[];this.dead=false;}
 send(channel,payload){this.messages.push({channel,payload});}
 setWindowOpenHandler(handler){this.popup=handler;}
 isDestroyed(){return this.dead;}
 close(){this.dead=true;}
 async loadURL(url){this.url=url;this.emit('did-navigate',{},url);}
}
class Window extends EventEmitter {
 constructor(options={},name='index.html'){super();this.options=options;this.webContents=new Contents(pathToFileURL(path.join(desktop,'src/renderer',name)).href);this.dead=false;this.opacity=1;this.size=[1280,840];this.bounds={x:10,y:20,width:340,height:390};this.children=[];this.contentView={addChildView:view=>this.children.push(view),removeChildView:view=>{this.children=this.children.filter(x=>x!==view);}};}
 isDestroyed(){return this.dead;}
 setOpacity(value){this.opacity=value;}
 getOpacity(){return this.opacity;}
 getContentSize(){return this.size;}
 getBounds(){return this.bounds;}
 show(){this.shown=true;}
 focus(){this.focused=true;}
 async loadFile(file){this.loaded=file;this.emit('ready-to-show');}
 close(){this.emit('close');this.dead=true;this.emit('closed');}
}
function harness({file=path.join(root,`notifications-${Math.random()}.json`),fetchJobs=async()=>({jobs:[]}),writeState}={}){
 const window=new Window(),handlers=new Map(),timers=new Map(),opened=[],views=[],floats=[],logs=[];let time=new Date(2026,9,26,10).getTime(),focused=0;
 const partition={setPermissionRequestHandler(fn){this.request=fn;},setPermissionCheckHandler(fn){this.check=fn;},setDevicePermissionHandler(fn){this.device=fn;},setDisplayMediaRequestHandler(fn){this.display=fn;},removeAllListeners(){},on(name,fn){this[name]=fn;},webRequest:{onBeforeRequest(fn){partition.before=fn;}}};
 const service=createOrganizerDesktop({getWindow:()=>window,ipc:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},notificationFile:file,floatingFile:file+'.floating',now:()=>time,setTimer:(fn,ms)=>{assert.ok(ms>0&&ms<=60000);const id={unref(){}};timers.set(id,{fn,at:time+ms,ms});return id;},clearTimer:id=>timers.delete(id),openHTTPS:async url=>opened.push(url),log:msg=>logs.push(msg),onNotificationClick:()=>focused++,getReferenceSession:()=>partition,makeReferenceView:options=>{const view={options,webContents:new Contents('about:blank'),setBounds(b){this.bounds=b;},getBounds(){return this.bounds||{width:0};}};views.push(view);return view;},makeFloatingWindow:options=>{const f=new Window(options,'floating.html');floats.push(f);return f;},displayArea:()=>({x:0,y:0,width:1280,height:800}),fetchJobs,...(writeState?{writeState}:{})});
 service.restore();service.registerIpc();service.attachWindow(window);
 const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
 return {service,window,handlers,event,timers,opened,views,partition,floats,logs,file,focused:()=>focused,
 invoke:(c,b,e=event)=>Promise.resolve().then(()=>handlers.get(c)(e,...(b===undefined?[]:[b]))),
 advance:async ms=>{time+=ms;for(const[id,t]of [...timers])if(t.at<=time){timers.delete(id);t.fn();}await new Promise(r=>setImmediate(r));},
 notices:()=>window.webContents.messages.filter(x=>x.channel==='organizer:notification').map(x=>x.payload),
 ledger:()=>JSON.parse(fs.readFileSync(file,'utf8'))};
}
const project={id:'portrait-1',title:'Portrait',due:'2026-10-26'};
test('HTTPS and opacity validation reject unsafe payloads; zoom remains renderer-owned',async()=>{
 assert.equal(validateOrganizerHTTPS('https://example.com/a?q=b'),'https://example.com/a?q=b');
 for(const value of ['http://example.com','file:///etc/passwd','javascript:alert(1)','https://user:pass@example.com',' https://example.com','https://example.com\n','https:\\example.com',null])assert.throws(()=>validateOrganizerHTTPS(value));
 const h=harness();const layout={mode:'compact',theme:'dark',zoom:1.2,opacity:.6};assert.deepEqual(await h.invoke('organizer:layout',layout),{applied:true,opacity:.6});
 for(const opacity of [NaN,Infinity,.49,1.01,'0.8'])await assert.rejects(()=>h.invoke('organizer:layout',{...layout,opacity}));
 for(const value of [{...layout,zoom:2},{...layout,theme:'bad'},null])assert.throws(()=>validateOrganizerLayout(value));
 assert.equal(h.window.webContents.setZoomFactor,undefined);
 await h.invoke('organizer:open-https','https://example.com');assert.deepEqual(h.opened,['https://example.com/']);
 h.service.dispose();
});
test('organizer IPC accepts only the local main frame, not reference/floating/remote frames',async()=>{
 const h=harness();const channel='organizer:open-https';
 await assert.rejects(()=>h.invoke(channel,'https://example.com',{sender:h.window.webContents,senderFrame:{url:h.event.senderFrame.url}}));
 const remote=new Contents('https://example.com');await assert.rejects(()=>h.invoke(channel,'https://example.com',{sender:remote,senderFrame:remote.mainFrame}));
 const old=h.event.senderFrame.url;h.event.senderFrame.url='https://example.com';await assert.rejects(()=>h.invoke(channel,'https://example.com'));h.event.senderFrame.url=old;
 assert.equal(h.opened.length,0);h.service.dispose();
});
test('reminders opt in, persist, resume after relaunch and never repeat confirmed delivery',async()=>{
 const h=harness();assert.equal(h.timers.size,0);await h.invoke('organizer:notifications-ready',{permission:'default'});assert.equal(h.timers.size,0);
 await assert.rejects(()=>h.invoke('organizer:notifications-schedule',{projects:[project],permission:'default'}));
 const r=await h.invoke('organizer:notifications-schedule',{projects:[project],permission:'granted'});assert.equal(r.scheduled,1);assert.equal(h.timers.size,1);assert.equal(h.notices().length,0);h.service.dispose();
 const relaunched=harness({file:h.file});assert.equal(relaunched.timers.size,0);await relaunched.invoke('organizer:notifications-ready',{permission:'denied'});assert.equal(relaunched.timers.size,0);
 await relaunched.invoke('organizer:notifications-ready',{permission:'granted'});await relaunched.advance(1000);const notice=relaunched.notices()[0];assert.equal(notice.id,project.id);
 await relaunched.invoke('organizer:notification-result',{token:notice.token,status:'shown'});assert.ok(relaunched.ledger().projects[0].notifiedAt);assert.equal(relaunched.timers.size,0);
 assert.equal((await relaunched.invoke('organizer:notifications-schedule',{projects:[project],permission:'granted'})).scheduled,0);
 await relaunched.invoke('organizer:notification-open',{id:project.id,due:project.due});assert.equal(relaunched.focused(),1);relaunched.service.dispose();
 const again=harness({file:h.file});await again.invoke('organizer:notifications-ready',{permission:'granted'});await again.advance(60000);assert.equal(again.notices().length,0);again.service.dispose();
});
test('one bounded timer handles far-future deadlines, retries, stale acks, delay and cancellation',async()=>{
 const h=harness();await h.invoke('organizer:notifications-schedule',{projects:[{...project,due:'2099-12-31'}],permission:'granted'});assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].ms,60000);
 await h.invoke('organizer:notifications-schedule',{projects:[project],permission:'granted'});await h.advance(1000);const first=h.notices()[0];
 await h.advance(30000);await h.advance(30000);await h.advance(30000);await h.advance(30000);await h.advance(30000);await h.advance(60000);
 assert.equal(h.notices().length,3);assert.equal(h.timers.size,0);
 assert.equal((await h.invoke('organizer:notification-result',{token:first.token,status:'shown'})).accepted,false);
 await h.invoke('organizer:notifications-schedule',{projects:[{...project,due:'2026-10-27'}],permission:'granted'});assert.equal(h.ledger().projects[0].attempts,0);
 await h.invoke('organizer:notifications-schedule',{projects:[],permission:'denied'});assert.equal(h.timers.size,0);assert.equal(h.ledger().enabled,false);h.service.dispose();
});
test('invalid schedules and corrupt storage fail without losing reminders; failed persistence never sends',async()=>{
 const h=harness();await h.invoke('organizer:notifications-schedule',{projects:[project],permission:'granted'});const before=fs.readFileSync(h.file,'utf8');
 for(const projects of [[{...project,due:'2026-02-30'}],[project,project],[{...project,id:'../escape'}],Array(1001).fill(project)])await assert.rejects(()=>h.invoke('organizer:notifications-schedule',{projects,permission:'granted'}));
 assert.equal(fs.readFileSync(h.file,'utf8'),before);h.service.dispose();
 fs.writeFileSync(h.file,'{broken');const broken=harness({file:h.file});await broken.invoke('organizer:notifications-ready',{permission:'granted'});assert.equal(broken.timers.size,0);await assert.rejects(()=>broken.invoke('organizer:notifications-schedule',{projects:[project],permission:'granted'}));assert.equal(fs.readFileSync(h.file,'utf8'),'{broken');broken.service.dispose();
 const fail=harness({writeState:()=>{throw new Error('disk full');}});await assert.rejects(()=>fail.invoke('organizer:notifications-schedule',{projects:[project],permission:'granted'}));assert.equal(fail.notices().length,0);fail.service.dispose();
});
test('reference pane has an isolated session, no preload, denied permissions, bounded resize and HTTPS popups',async()=>{
 const h=harness();await h.invoke('organizer:reference-open',{url:'https://example.com/reference',width:700});const view=h.views[0],prefs=view.options.webPreferences;
 assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.equal(prefs.preload,undefined);assert.equal(prefs.session,h.partition);
 assert.deepEqual(view.bounds,{x:640,y:0,width:640,height:840});h.window.size=[960,620];h.window.emit('resize');assert.deepEqual(view.bounds,{x:560,y:0,width:400,height:620});
 assert.equal(h.partition.check(),false);assert.equal(h.partition.device(),false);let granted=true;h.partition.request(null,'camera',v=>granted=v);assert.equal(granted,false);let streams;h.partition.display({},v=>streams=v);assert.deepEqual(streams,{});
 for(const url of ['file:///etc/passwd','http://127.0.0.1:47811/health']){let cancel;h.partition.before({url},v=>cancel=v.cancel);assert.equal(cancel,true);}
 let prevented=0;view.webContents.emit('will-frame-navigate',{url:'file:///etc/passwd',preventDefault(){prevented++;}});view.webContents.emit('will-redirect',{url:'https://accounts.google.com/login',preventDefault(){prevented++;}});assert.equal(prevented,2);
 assert.deepEqual(view.webContents.popup({url:'https://example.org'}),{action:'deny'});assert.deepEqual(view.webContents.popup({url:'javascript:alert(1)'}),{action:'deny'});assert.deepEqual(h.opened,['https://example.org/']);
 await assert.rejects(()=>h.invoke('organizer:reference-size',{width:900}));await assert.rejects(()=>h.invoke('organizer:reference-open',{url:'http://example.com'}));
 await h.invoke('organizer:reference-close');assert.ok(view.webContents.isDestroyed());assert.equal(h.window.children.length,0);assert.equal((await h.invoke('organizer:reference-state')).width,0);h.service.dispose();
});
test('floating window is explicit, single-instance, bounded, durable and shows real helper snapshots',async()=>{
 let jobs=[{id:'j1',status:'running',stage:'Downloading',meta:{title:'First'},createdAt:1}],calls=0;
 const h=harness({fetchJobs:async()=>{calls++;return {jobs};}});assert.equal(h.floats.length,0);
 await h.invoke('organizer:floating-open');await new Promise(r=>setImmediate(r));assert.equal(h.floats.length,1);assert.equal(calls,1);const floating=h.floats[0];assert.equal(floating.options.alwaysOnTop,true);assert.equal(floating.options.webPreferences.sandbox,true);
 await h.invoke('organizer:floating-open');assert.equal(h.floats.length,1);
 const event={sender:floating.webContents,senderFrame:floating.webContents.mainFrame};let snap=await h.invoke('organizer:floating-state',undefined,event);assert.equal(snap.jobs[0].status,'running');assert.equal(snap.jobs[0].stage,'Downloading');
 await assert.rejects(()=>h.invoke('organizer:open-https','https://example.com',event));
 jobs=[{id:'j1',status:'done',createdAt:1}];await h.advance(2500);snap=await h.invoke('organizer:floating-state',undefined,event);assert.equal(snap.jobs[0].status,'done');
 await h.invoke('organizer:floating-home',undefined,event);assert.equal(h.focused(),1);floating.bounds={x:120,y:140,width:360,height:400};floating.close();assert.deepEqual(JSON.parse(fs.readFileSync(h.file+'.floating')).bounds,floating.bounds);assert.equal(h.timers.size,0);h.service.dispose();
 const again=harness({file:h.file});assert.equal(again.floats.length,0);await again.invoke('organizer:floating-open');assert.equal(again.floats[0].options.x,120);assert.equal(again.floats[0].options.width,360);again.service.dispose();
});
function preload({floating=false,permission='default',active=false}={}){
 const handlers=new Map(),events=new Map(),calls=[],timers=new Map(),notices=[];let bridge,requests=0;
 class Notice{static permission=permission;static async requestPermission(){requests++;Notice.permission='granted';return 'granted';}constructor(title,options){this.title=title;this.options=options;notices.push(this);queueMicrotask(()=>this.onshow?.());}close(){this.onclose?.();}}
 const ipcRenderer={invoke:async(channel,...args)=>{calls.push({channel,args});return {scheduled:1};},on:(c,fn)=>handlers.set(c,fn),removeListener:c=>handlers.delete(c)};
 const sandbox={require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_name,value)=>bridge=value},webUtils:{}}),Notification:Notice,navigator:{userActivation:{isActive:active}},location:{protocol:'file:',pathname:`/desktop/src/renderer/${floating?'floating':'index'}.html`},addEventListener:(name,fn)=>events.set(name,fn),setTimeout:(fn,ms)=>{const id={};timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),queueMicrotask,console};
 vm.runInNewContext(fs.readFileSync(path.join(desktop,'src/preload.cjs'),'utf8'),sandbox);
 return {bridge,calls,events,handlers,notices,timers,requests:()=>requests,sandbox,Notice};
}
test('preload requests permission only from explicit action, restores quietly and preserves existing bridge',async()=>{
 const p=preload();p.events.get('DOMContentLoaded')();await new Promise(r=>setImmediate(r));assert.equal(p.requests(),0);assert.equal(p.notices.length,0);assert.equal(p.calls[0].channel,'organizer:notifications-ready');
 await assert.rejects(()=>p.bridge.scheduleOrganizerNotifications({projects:[project]}));assert.equal(p.requests(),0);
 p.sandbox.navigator.userActivation.isActive=true;await p.bridge.scheduleOrganizerNotifications({projects:[project]});assert.equal(p.requests(),1);assert.equal(p.notices.length,1);assert.equal(p.timers.size,0);assert.equal(p.calls.at(-1).channel,'organizer:notifications-schedule');
 for(const method of ['api','open','openPack','savePack','installPlugin','restartHelper','updateState','copyText','pickImages'])assert.equal(typeof p.bridge[method],'function');
 await p.bridge.applyOrganizerLayout({opacity:.8});assert.equal(p.calls.at(-1).channel,'organizer:layout');
 const restored=preload({permission:'granted'});restored.events.get('DOMContentLoaded')();assert.equal(restored.requests(),0);assert.equal(restored.notices.length,0);
 restored.handlers.get('organizer:notification')({}, {token:'token',id:'p',title:'Task',due:'2026-10-26'});await new Promise(r=>setImmediate(r));assert.equal(restored.requests(),0);assert.equal(restored.calls.at(-1).args[0].status,'shown');
 const denied=preload({permission:'denied'});denied.handlers.get('organizer:notification')({},{token:'t',title:'Task'});assert.equal(denied.notices.length,0);assert.equal(denied.calls.at(-1).args[0].status,'permission-blocked');
});
test('floating preload exposes only local card capabilities and never initializes reminder permission',()=>{
 const p=preload({floating:true});assert.deepEqual(Object.keys(p.bridge).sort(),['closeFloating','floatingState','onFloatingState','returnToWorkspace']);assert.equal(p.events.size,0);assert.equal(p.requests(),0);assert.equal(p.bridge.api,undefined);
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
