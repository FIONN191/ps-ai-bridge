import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { handoffWindowsUpdate, previousInstallOutcome, WINDOWS_UPDATE_SCRIPT } from '../src/update-handoff.mjs';

// Only the process boundary is mocked: the handoff writes and polls real files.
// These tests do not execute PowerShell, NSIS, or quit the running desktop app.
function fixture(t,behavior=()=>{}) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"更新 空格 O'Brien-"));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const child=new EventEmitter();child.kills=0;child.unrefs=0;
 child.kill=()=>{child.kills++;return true;};child.unref=()=>{child.unrefs++;};
 const calls=[];
 const launch=(program,args,options)=>{
  const encoded=args[args.indexOf('-EncodedCommand')+1];
  assert.ok(encoded,'PowerShell receives an encoded command');
  const command=Buffer.from(encoded,'base64').toString('utf16le');
  const encodedPath=command.split('\n')[0].match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.ok(encodedPath,'The config path is UTF-8 data, not PowerShell source');
  const configPath=Buffer.from(encodedPath,'base64').toString('utf8');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const call={program,args,options,command,configPath,config};calls.push(call);
  queueMicrotask(()=>behavior({child,...call}));
  return child;
 };
 const input={installer:String.raw`C:\Users\中文 用户\O'Brien\下载\PS AI Bridge setup.exe`,executable:String.raw`C:\Users\中文 用户\AppData\Local\Programs\PS AI Bridge\PS AI Bridge.exe`,version:'0.7.0',parentProcess:12345,directory,timeoutMs:1000,launch};
 return {directory,child,calls,input,run:fields=>handoffWindowsUpdate({...input,...fields})};
}
function noListeners(child){assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('exit'),0);}

test('handoff waits for this helper ready file before detaching, and preserves the config contract',async t=>{
 const f=fixture(t);let settled=false;
 const pending=f.run().then(value=>{settled=true;return value;});
 await delay(130);assert.equal(settled,false);assert.equal(f.child.unrefs,0);
 const {config,configPath}=f.calls[0];
 assert.equal(config.parentProcess,12345);assert.equal(config.version,'0.7.0');
 assert.equal(config.installer,f.input.installer);assert.equal(config.executable,f.input.executable);
 assert.equal(config.installDirectory,path.win32.dirname(f.input.executable));
 assert.equal(path.dirname(configPath),f.directory);assert.equal(path.dirname(config.ready),f.directory);
 assert.equal(config.status,path.join(f.directory,'last-install.json'));assert.equal(path.dirname(config.log),f.directory);
 fs.writeFileSync(config.ready,'ready');assert.deepEqual(await pending,config);
 assert.equal(f.child.unrefs,1);assert.equal(f.child.kills,0);noListeners(f.child);
});

test('Chinese, spaces, apostrophes and quote-like payloads remain data through both encoding layers',async t=>{
 const f=fixture(t,({config})=>fs.writeFileSync(config.ready,'ready'));
 // A double quote is not a valid Windows filename character, but remains an
 // intentional transport-adversary fixture. It must never become script text.
 const installer=String.raw`C:\中文 空格\O'Brien\x"; Write-Output 'injected'; #.exe`;
 const result=await f.run({installer});const call=f.calls[0];
 assert.equal(result.installer,installer);assert.equal(call.config.installer,installer);
 assert.ok(!call.command.includes(installer));assert.ok(!call.command.includes(f.directory));
 assert.ok(!call.command.includes('injected'));
 assert.equal(call.command.slice(call.command.indexOf('\n')),WINDOWS_UPDATE_SCRIPT.slice(WINDOWS_UPDATE_SCRIPT.indexOf('\n')));
 assert.equal(call.args.includes('-File'),false);assert.equal(call.args.includes('-ExecutionPolicy'),false);
 assert.deepEqual(call.options,{detached:true,stdio:'ignore',windowsHide:true});
 assert.match(call.program,/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
});

test('spawn error rejects without granting handoff and removes process listeners',async t=>{
 const f=fixture(t,({child})=>child.emit('error',Object.assign(new Error('ENOENT fixture'),{code:'ENOENT'})));
 await assert.rejects(f.run(),/安装助手未启动.*ENOENT/);
 assert.equal(f.child.unrefs,0);assert.equal(f.child.kills,1);noListeners(f.child);
 assert.ok(fs.existsSync(f.calls[0].configPath),'Configuration survives for diagnosis');
});

test('early exit is failure even for exit code zero when no ready handshake occurred',async t=>{
 for(const code of [0,1,null]){
  const f=fixture(t,({child})=>child.emit('exit',code));
  await assert.rejects(f.run(),/安装助手提前退出/);
  assert.equal(f.child.unrefs,0);assert.equal(f.child.kills,1);noListeners(f.child);
 }
});

test('timeout terminates the waiting helper and cannot turn a late ready file into success',async t=>{
 const f=fixture(t);
 await assert.rejects(f.run({timeoutMs:25}),/未确认就绪/);
 assert.equal(f.child.kills,1);assert.equal(f.child.unrefs,0);noListeners(f.child);
 fs.writeFileSync(f.calls[0].config.ready,'ready');await delay(130);
 assert.equal(f.child.unrefs,0);assert.equal(f.child.kills,1);
});

test('a retry requires its own ready marker rather than accepting an earlier attempt',async t=>{
 const f=fixture(t);
 await assert.rejects(f.run({timeoutMs:25}),/未确认就绪/);
 fs.writeFileSync(f.calls[0].config.ready,'ready');
 await assert.rejects(f.run({timeoutMs:25}),/未确认就绪/);
 assert.notEqual(f.calls[0].config.ready,f.calls[1].config.ready);
 assert.notEqual(f.calls[0].configPath,f.calls[1].configPath);
 assert.equal(f.child.unrefs,0);assert.equal(f.child.kills,2);
});

test('invalid versions fail before launching an updater',async t=>{
 const f=fixture(t);
 for(const version of ['v0.7.0','0.7','0.7.0; exit','0.7.0\n',null])await assert.rejects(f.run({version}),/版本号无效/);
 assert.equal(f.calls.length,0);
});

test('old-version recovery preserves installer/log details and never marks incomplete stages successful',t=>{
 const f=fixture(t),file=path.join(f.directory,'last-install.json');
 assert.equal(previousInstallOutcome(f.directory,'0.5.4'),null);
 for(const stage of ['ready','installing','installed','failed']){
  const record={version:'0.7.0',stage,message:'Installer exit code: 2',installer:f.input.installer,executable:f.input.executable,log:path.join(f.directory,'install.log')};
  fs.writeFileSync(file,JSON.stringify(record));const before=fs.readFileSync(file,'utf8');
  const outcome=previousInstallOutcome(f.directory,'0.5.4');
  assert.equal(outcome.stage,stage);assert.equal(outcome.installer,record.installer);assert.equal(outcome.log,record.log);
  assert.match(outcome.error,/当前仍为 0\.5\.4，目标为 0\.7\.0/);assert.match(outcome.error,/Installer exit code: 2/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
 }
});

test('running the target version records completion once; dismissed records stay quiet',t=>{
 const f=fixture(t),file=path.join(f.directory,'last-install.json');
 fs.writeFileSync(file,JSON.stringify({version:'0.7.0',stage:'installed',log:'keep.log'}));
 assert.equal(previousInstallOutcome(f.directory,'0.7.0'),null);
 const completed=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(completed.stage,'complete');assert.equal(completed.log,'keep.log');
 const before=fs.readFileSync(file,'utf8');assert.equal(previousInstallOutcome(f.directory,'0.7.0'),null);assert.equal(fs.readFileSync(file,'utf8'),before);
 fs.writeFileSync(file,JSON.stringify({version:'0.7.0',stage:'failed',dismissed:true}));
 assert.equal(previousInstallOutcome(f.directory,'0.5.4'),null);
});

test('corrupt recovery JSON reports a manual recovery path without overwriting evidence',t=>{
 const f=fixture(t),file=path.join(f.directory,'last-install.json');fs.writeFileSync(file,'{broken');
 assert.match(previousInstallOutcome(f.directory,'0.5.4').error,/记录无法读取.*手动/);
 assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});

test('manual upgrade beyond stale target completes recovery without a false failure',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'update-newer-'));
 try{fs.writeFileSync(path.join(dir,'last-install.json'),JSON.stringify({stage:'failed',version:'0.6.3'}));assert.equal(previousInstallOutcome(dir,'0.7.0'),null);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'last-install.json'))).stage,'complete');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
