import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.mjs';

const codes = { A:0,S:1,D:2,F:3,H:4,G:5,Z:6,X:7,C:8,V:9,B:11,Q:12,W:13,E:14,R:15,Y:16,T:17,'1':18,'2':19,'3':20,'4':21,'6':22,'5':23,'9':25,'7':26,'8':28,'0':29,O:31,U:32,I:34,P:35,L:37,J:38,K:40,N:45,M:46,F1:122,F2:120,F3:99,F4:118,F5:96,F6:97,F7:98,F8:100,F9:101,F10:109,F11:103,F12:111 };
export function parseShortcut(text) {
  const parts = String(text).trim().toUpperCase().replace(/COMMAND|META/g,'CMD').replace(/CONTROL/g,'CTRL').replace(/OPTION/g,'ALT').split('+').map(x=>x.trim());
  const key = parts.pop();
  if (!(key in codes) || !parts.length || new Set(parts).size !== parts.length || parts.some(x=>!['CMD','CTRL','ALT','SHIFT'].includes(x)) || !parts.some(x=>['CMD','CTRL','ALT'].includes(x))) throw new Error('格式如 Cmd+G、Cmd+Shift+G、Ctrl+Alt+G；支持字母、数字、F1–F12，至少包含 Cmd / Ctrl / Alt。');
  const ordered = ['CMD','CTRL','ALT','SHIFT'].filter(x=>parts.includes(x));
  return { text: [...ordered.map(x=>({CMD:'Cmd',CTRL:'Ctrl',ALT:'Alt',SHIFT:'Shift'}[x])),key].join('+'), code:codes[key], mods:ordered.reduce((n,x)=>n|({CMD:256,SHIFT:512,ALT:2048,CTRL:4096}[x]),0) };
}
export function createShortcuts({ settingsFile = path.join(DATA_DIR,'shortcuts.json') } = {}) {
  let config = { enabled:true, shortcut:'Cmd+G' };
  try { const stored=JSON.parse(fs.readFileSync(settingsFile,'utf8')); config={enabled:stored.enabled!==false,shortcut:parseShortcut(stored.shortcut).text}; } catch {}
  let registered=false;
  let child=null, error='', pending=0, seq=0, owner='', lastPoll=0, fired=0;
  function status() { return {...config,supported:process.platform==='darwin', running:!!child, registered, error, sequence:seq}; }
  function start() {
    if (child || process.platform!=='darwin') return;
    const binary = fileURLToPath(new URL(`../native/hotkey-macos-${process.arch}`,import.meta.url));
    if (!fs.existsSync(binary)) { error='缺少本机快捷键组件，请重新安装完整 helper 包'; return; }
    child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
    const worker=child; let buffer='';
    worker.stdout.on('data',chunk=>{ buffer+=chunk; const lines=buffer.split('\n'); buffer=lines.pop(); for (const line of lines) {
      if (line==='fire' && Date.now()-lastPoll<1500 && Date.now()-fired>700) { pending=Date.now(); fired=pending; seq++; console.log(`[快捷键] ${config.shortcut} 触发 #${seq}`); }
      else if (line==='ready') { error=''; registered=true; }
      else if (line==='idle') registered=false;
      else if (line.startsWith('error:')) error=`快捷键被占用或无法注册（${line.slice(6)}），请换一个组合键`;
    }});
    worker.stdin.on('error',()=>{});
    worker.on('error',e=>{error=e.message; if(child===worker) child=null;});
    worker.on('exit',()=>{if(child===worker) child=null;});
  }
  function update(body) {
    const parsed=parseShortcut(body.shortcut);
    if(typeof body.enabled!=='boolean') throw new Error('enabled 必须为布尔值');
    config={enabled:body.enabled,shortcut:parsed.text}; pending=0; error='';
    fs.mkdirSync(path.dirname(settingsFile),{recursive:true});
    const tmp=settingsFile+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(config,null,2),{mode:0o600}); fs.renameSync(tmp,settingsFile);
    return status();
  }
  function poll(session) {
    if(typeof session!=='string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(session)) throw new Error('无效的插件会话');
    const now=Date.now();
    if(owner && owner!==session && now-lastPoll<2000) return {...status(),fire:false,error:'另一个插件实例正在使用快捷键'};
    if(owner!==session || now-lastPoll>2000) pending=0;
    owner=session; lastPoll=now; start();
    const key=parseShortcut(config.shortcut);
    if(child?.stdin.writable) child.stdin.write(JSON.stringify({code:key.code,mods:key.mods,enabled:config.enabled})+'\n');
    const fire=config.enabled && pending>0 && now-pending<1500;
    pending=0;
    return {...status(),fire};
  }
  function stop(){ child?.kill(); child=null; }
  return {status,update,poll,stop};
}
