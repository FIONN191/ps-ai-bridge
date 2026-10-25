/** Managed output migration. Mount storageRoutes at /storage and call storageRequestGuard
 * for EVERY request before dispatch: const release=storageRequestGuard(method,parts);
 * res.once('finish',release); res.once('close',release). No main/preload changes needed.
 * A migration is deliberately unavailable until that request barrier has been mounted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, USER_CONFIG } from './paths.mjs';
import { config, ROOT } from './config.mjs';
import { atomicJson, recordId } from './store.mjs';
import { listJobs } from './jobs.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const within = (root, value) => value === root || value.startsWith(root + path.sep);
const ACTIVE = new Set(['queued','submitting','running','processing','recovering','awaiting-selection','responding','saving','restoring','analyzing']);
const EXCLUDED = new Set(['storage','chrome-profile','chrome','browser-profiles','engines','logs','node_modules','.git']);
const immutable = rel => EXCLUDED.has(rel.split(path.sep)[0]) || /^(organizer[/\\](rollbacks|trash|backups)|backups)([/\\]|$)/.test(rel);
const error = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const json = file => { checked(file); try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw error(`JSON 无法读取，请先修复：${path.basename(file)}`); } };
const digest = file => {checked(file,{missing:true});return fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;};
const writeJson = (file,value) => {checked(file,{missing:true});atomicJson(file,value);};
function trustedRoot(value){let current=path.resolve(value),tail=[];while(!fs.existsSync(current)){tail.unshift(path.basename(current));const parent=path.dirname(current);if(parent===current)throw error('存储根目录不可用');current=parent;}return path.join(fs.realpathSync(current),...tail);}

// Reject symlinks at every existing path component, including a destination's parents.
function checked(value, { missing = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw error('请输入绝对目录路径');
  const absolute = path.resolve(value), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let i=0;i<parts.length;i++) {
    current = path.join(current,parts[i]);
    let stat; try { stat=fs.lstatSync(current); } catch(e) { if(e.code==='ENOENT'&&missing) return absolute; throw error('目录不存在或无法访问'); }
    if(stat.isSymbolicLink())throw error('存储路径包含符号链接，请使用真实目录');
    if(i<parts.length-1&&!stat.isDirectory())throw error('路径的父级不是目录');
  }
  return absolute;
}
function inventory(root, { skip = () => false } = {}) {
  if(!fs.existsSync(root))return [];
  checked(root); const records=[];
  const visit = (dir,relative='') => {
    for(const name of fs.readdirSync(dir).sort()) {
      const rel=path.join(relative,name); if(skip(rel))continue;
      const file=path.join(root,rel),s=fs.lstatSync(file);
      if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw error(`不支持符号链接或特殊文件：${rel}`);
      if(s.isDirectory())visit(file,rel);
      else records.push({relative:rel,bytes:s.size,modified:s.mtimeMs,ino:s.ino,dev:s.dev});
      if(records.length>100000)throw error('存储文件超过 100000 个，请分批整理后迁移');
    }
  };
  visit(root);return records;
}
function directoryPaths(root){const dirs=[];if(!fs.existsSync(root))return dirs;const visit=(rel='')=>{for(const name of fs.readdirSync(path.join(root,rel)).sort()){const next=path.join(rel,name),s=fs.lstatSync(path.join(root,next));if(s.isSymbolicLink())throw error('输出目录包含符号链接');if(s.isDirectory()){dirs.push(next);visit(next);}}};visit();return dirs;}
const fingerprint = rows => hash(JSON.stringify(rows));
function atomicBytes(file, bytes) {
  checked(file,{missing:true});
  const tmp=`${file}.${crypto.randomUUID()}.tmp`;let fd;
  try { fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file); }
  finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
}
async function fileHash(file) {
  checked(file);const h=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file,{flags:fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)}))h.update(chunk);
  return h.digest('hex');
}
async function copyHashed(source,destination,expected) {
  checked(source);checked(path.dirname(destination));
  const input=await fs.promises.open(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let output;
  try {
    const before=await input.stat();
    if(!before.isFile()||before.size!==expected.bytes||before.ino!==expected.ino||before.mtimeMs!==expected.modified)throw error('源文件在预检后改变，请重新预检');
    output=await fs.promises.open(destination,'wx',0o600);
    const h=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
    for(;;){const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;h.update(buffer.subarray(0,bytesRead));let offset=0;while(offset<bytesRead){const r=await output.write(buffer,offset,bytesRead-offset,null);offset+=r.bytesWritten;}}
    await output.sync();const after=await input.stat();
    if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw error('复制期间源文件改变，迁移未提交');
    return h.digest('hex');
  }finally{await input.close();await output?.close();}
}
function rewrite(value, source, destination, aliases=[]) {
  if(typeof value==='string') {
    if(!path.isAbsolute(value))return value;
    const match=[source,...aliases].find(root=>within(root,path.resolve(value)));if(!match)return value;
    const relative=path.relative(match,path.resolve(value));
    checked(path.join(source,relative)); // Trusted root aliases are normalized; nested links still fail.
    return path.join(destination,relative);
  }
  if(Array.isArray(value))return value.map(v=>rewrite(v,source,destination,aliases));
  if(value&&typeof value==='object') {
    const result=Object.create(null);
    for(const [key,v] of Object.entries(value)) {const next=rewrite(key,source,destination,aliases);if(Object.hasOwn(result,next))throw error('迁移会产生重复路径键');result[next]=rewrite(v,source,destination,aliases);}
    return result;
  }
  return value;
}
const freeBytes = folder => {const s=fs.statfsSync(folder,{bigint:true});return Number(s.bavail*s.bsize);};

export function createStorage({dataDir=DATA_DIR,outputDir=config.outputDir,userConfig=dataDir===DATA_DIR?USER_CONFIG:path.join(dataDir,'config.json'),overrideFile=path.join(ROOT,'config.json'),getJobs=()=>listJobs(100000),extraActivity=()=>[],availableBytes=freeBytes,writeBytes=atomicBytes}={}) {
  const configuredData=path.resolve(dataDir),configuredOutput=path.resolve(outputDir);
  dataDir=trustedRoot(dataDir);outputDir=trustedRoot(outputDir);userConfig=within(configuredData,path.resolve(userConfig))?path.join(dataDir,path.relative(configuredData,path.resolve(userConfig))):trustedRoot(userConfig);
  const root=path.join(dataDir,'storage'),settingsFile=path.join(root,'settings.json'),pointer=path.join(root,'state.json');
  const tickets=new Map(),requests=new Map(),reservations=new Map();let mounted=false,busy=false,progress=null;
  const at=id=>path.join(root,'migrations',recordId(id));
  const readJournal=()=>{checked(root,{missing:true});checked(pointer,{missing:true});if(!fs.existsSync(pointer))return null;const p=json(pointer);return json(path.join(at(p.current),'journal.json'));};
  const saveJournal=j=>writeJson(path.join(at(j.id),'journal.json'),j);
  const policy=()=>({previewLimitBytes:0,checkpointLimitBytes:(Number(config.checkpointMaxGB)||20)*1024**3,...(fs.existsSync(settingsFile)?json(settingsFile):{})});
  function pending() {
    const j=readJournal();if(!j)return null;
    if(!['committed','rolled-back','failed-rolled-back'].includes(j.status))return '存储事务尚未完成，请先回滚';
    const desired=j.status==='committed'?j.destination:j.source;
    if(outputDir!==desired)return '存储路径已变更，请在空闲时重启 helper 后继续';
    return null;
  }
  function requestGuard(method,parts) {
    mounted=true;
    if(parts[0]==='storage'||(method==='GET'&&['health'].includes(parts[0])))return ()=>{};
    if(busy||pending())throw error(busy?'正在迁移存储，请等待完成':pending(),423);
    const id=crypto.randomUUID();requests.set(id,`${method} /${parts[0]||''}`);
    let released=false;return ()=>{if(!released){requests.delete(id);released=true;}};
  }
  function metadata() {
    checked(dataDir);
    return inventory(dataDir,{skip:immutable}).filter(r=>r.relative.endsWith('.json')&&path.join(dataDir,r.relative)!==userConfig).map(r=>{
      if(r.bytes>16*1024*1024)throw error(`JSON 超过 16 MiB，请先整理：${r.relative}`);
      const file=path.join(dataDir,r.relative);return {...r,file,value:json(file),sha256:digest(file)};
    });
  }
  function blockers(meta=metadata(),output=inventory(outputDir)) {
    const found=[];
    for(const j of getJobs())if(ACTIVE.has(j.status))found.push({kind:'job',id:j.id,status:j.status});
    for(const r of output.filter(r=>path.basename(r.relative)==='job.json')){const j=json(path.join(outputDir,r.relative));if(ACTIVE.has(j.status))found.push({kind:'job',id:j.id,status:j.status});}
    for(const r of meta) {
      if(!/^(workbench[/\\](runs|batches)|workbench[/\\]creative[/\\](executions|proposals)|assistant-workbench[/\\](plans|sessions|proposals))[/\\]/.test(r.relative))continue;
      const active=v=>v&&typeof v==='object'&&(ACTIVE.has(v.status)||Object.values(v).some(x=>x&&typeof x==='object'&&active(x)));
      if(active(r.value))found.push({kind:r.relative.split(path.sep)[1],id:r.value.id,status:r.value.status});
    }
    for(const item of extraActivity()||[])found.push({kind:'external',...item});
    for(const r of reservations.values())found.push({kind:'quota-reservation',status:r.kind});
    for(const kind of requests.values())found.push({kind:'request',status:kind});
    return found;
  }
  function idle(meta,output) {const active=blockers(meta,output);if(active.length)throw error('请先停止活动任务、流程、助手回复及其他操作，再迁移存储');}
  function baseCheck() {
    if(!mounted)throw error('服务器尚未接入 storageRequestGuard，迁移暂不可用');
    if(busy||pending())throw error(busy?'存储操作进行中':pending());
    checked(dataDir);checked(outputDir);checked(root,{missing:true});checked(userConfig,{missing:true});
    if(within(dataDir,outputDir)||within(outputDir,dataDir))throw error('输出目录与应用数据目录不能重叠');
    if(overrideFile&&fs.existsSync(overrideFile)&&Object.hasOwn(json(overrideFile),'outputDir'))throw error('开发配置覆盖了 outputDir；请先移除覆盖项再迁移');
  }
  function validateDestination(value) {
    const dest=checked(value,{missing:true});const parent=checked(path.dirname(dest));
    if(!fs.statSync(parent).isDirectory())throw error('目标父目录不存在');
    if(within(outputDir,dest)||within(dest,outputDir)||within(dataDir,dest)||within(dest,dataDir))throw error('目标必须位于当前输出和应用数据目录之外，且不能包含它们');
    if(fs.existsSync(dest))throw error('目标目录已存在；请选择尚不存在的新目录，不覆盖现有文件');
    return dest;
  }
  function quotaState(meta=metadata(),output=inventory(outputDir)) {
    const preview=inventory(path.join(dataDir,'workbench','preview-assets')).filter(r=>!r.relative.endsWith('.json'));
    // Retouch reserves only final derived PNGs; source/reference/intermediate/metadata files are protected and excluded.
    preview.push(...inventory(path.join(dataDir,'workbench','retouch')).filter(r=>['output.png','layer.png'].includes(path.basename(r.relative))));
    const checkpoint=output.filter(r=>r.relative.split(path.sep)[0]==='_checkpoints');
    const p=policy();
    return {...p,previewBytes:preview.reduce((n,r)=>n+r.bytes,0),checkpointBytes:checkpoint.reduce((n,r)=>n+r.bytes,0),outputBytes:output.reduce((n,r)=>n+r.bytes,0),previewFiles:preview.length,checkpointFiles:checkpoint.length,scope:'工具预览计输入和输出；修图预览仅计 output.png/layer.png，不计输入、参考图、中间文件和元数据。检查点全部保留，写入前检查配额，不自动删除'};
  }
  function quotaPreflight(kind,bytes) {
    if(!['preview','checkpoint'].includes(kind)||!Number.isSafeInteger(bytes)||bytes<0)throw error('估算类型或字节数无效',400);
    const q=quotaState(),used=q[`${kind}Bytes`],limit=q[`${kind}LimitBytes`],reserved=[...reservations.values()].filter(r=>r.kind===kind).reduce((n,r)=>n+r.bytes,0);
    return {kind,estimatedBytes:bytes,usedBytes:used,reservedBytes:reserved,limitBytes:limit,allowed:!limit||used+reserved+bytes<=limit,excessBytes:limit?Math.max(0,used+reserved+bytes-limit):0};
  }
  function cleanupProposal() {
    const meta=metadata(),output=inventory(outputDir),q=quotaState(meta,output),candidates=[],protectedFiles=[];
    const references=[];
    const collect=v=>{if(typeof v==='string')references.push(v);else if(v&&typeof v==='object')for(const x of Object.values(v))collect(x);};
    // Ignore only each preview's own derived-output pointers; cross-preview inputs still pin files.
    for(const r of meta){
      if(/^workbench[/\\]previews[/\\]/.test(r.relative)){const {id,outputPath,...rest}=r.value;collect(rest);}
      else if(/^workbench[/\\]retouch[/\\].+[/\\]preview\.json$/.test(r.relative)){const {id,output,layer,...rest}=r.value;collect(rest);}
      else collect(r.value);
    }
    for(const r of output.filter(r=>r.relative.endsWith('.json')))collect(json(path.join(outputDir,r.relative)));
    for(const r of ['preview-assets','retouch'].flatMap(kind=>inventory(path.join(dataDir,'workbench',kind)).map(r=>({...r,kind})))) {
      const rel=path.join('workbench',r.kind,r.relative),file=path.join(dataDir,rel),previewId=r.relative.split(path.sep)[0];
      const normalized=v=>within(configuredData,path.resolve(v))?path.join(dataDir,path.relative(configuredData,path.resolve(v))):within(configuredOutput,path.resolve(v))?path.join(outputDir,path.relative(configuredOutput,path.resolve(v))):path.resolve(v);
      const pinned=references.some(v=>v===previewId||(path.isAbsolute(v)&&(within(normalized(v),file)||within(file,normalized(v)))));
      const entry={path:rel,bytes:r.bytes};
      if(!['output.png','layer.png'].includes(path.basename(file))||pinned)protectedFiles.push({...entry,reason:pinned?'被其他记录引用':'保留原图 / 输入 / 参考图'});
      else candidates.push({...entry,sha256:digest(file),reason:'派生预览输出，可在核对后重新生成'});
    }
    return {createdAt:Date.now(),quota:q,candidates,protectedFiles,protectedCheckpointBytes:q.checkpointBytes,reclaimableBytes:candidates.reduce((n,x)=>n+x.bytes,0),automaticDeletion:false,note:'这里只提供清理建议，不删除或移动文件。所有检查点和源图片受保护。'};
  }
  function status() {
    const j=readJournal();const meta=metadata(),out=inventory(outputDir);
    return {outputDir,configuredOutputDir:fs.existsSync(userConfig)?json(userConfig).outputDir||outputDir:outputDir,guardMounted:mounted,busy,progress,blockedReason:pending(),requiresRestart:Boolean(j&&['committed','rolled-back','failed-rolled-back'].includes(j.status)&&outputDir!==(j.status==='committed'?j.destination:j.source)),active:blockers(meta,out),quota:quotaState(meta,out),migration:j?{id:j.id,status:j.status,source:j.source,destination:j.destination,fileCount:j.files.length,manifestPath:path.join(at(j.id),'manifest.json'),canRollback:!['rolled-back','failed-rolled-back'].includes(j.status)}:null};
  }
  function preflight(destination) {
    baseCheck();const dest=validateDestination(destination),meta=metadata(),files=inventory(outputDir);idle(meta,files);
    const changes=[];
    for(const r of meta){const next=rewrite(r.value,outputDir,dest,[configuredOutput]);if(JSON.stringify(next)!==JSON.stringify(r.value))changes.push({relative:r.relative,before:r.sha256,bytes:Buffer.byteLength(JSON.stringify(next,null,2))});}
    for(const r of files.filter(r=>r.relative.endsWith('.json')))rewrite(json(path.join(outputDir,r.relative)),outputDir,dest,[configuredOutput]);
    const bytes=files.reduce((n,r)=>n+r.bytes,0),backupBytes=changes.reduce((n,c)=>n+c.bytes+(meta.find(r=>r.relative===c.relative)?.bytes||0),0)+(fs.existsSync(userConfig)?fs.statSync(userConfig).size*2:1024);
    const reserve=Math.max(64*1024*1024,Math.ceil(bytes*.05)),sameDevice=fs.statSync(dataDir).dev===fs.statSync(path.dirname(dest)).dev;
    const requiredDestinationBytes=bytes+reserve+(sameDevice?backupBytes:0),requiredDataBytes=backupBytes+64*1024*1024;
    if(availableBytes(path.dirname(dest))<requiredDestinationBytes||(!sameDevice&&availableBytes(dataDir)<requiredDataBytes))throw error('可用空间不足，迁移需要完整副本、元数据备份和预留空间');
    const token=crypto.randomUUID(),plan={token,destination:dest,createdAt:Date.now(),files,metadata:meta.map(r=>({relative:r.relative,sha256:r.sha256})),directories:directoryPaths(outputDir),outputFingerprint:fingerprint({files,directories:directoryPaths(outputDir)}),configHash:digest(userConfig),bytes,changes,requiredDestinationBytes,requiredDataBytes};
    for(const [key,value] of tickets)if(Date.now()-value.createdAt>15*60*1000)tickets.delete(key);
    if(tickets.size>=20)tickets.delete(tickets.keys().next().value);tickets.set(token,plan);
    return {token,source:outputDir,destination:dest,fileCount:files.length,bytes,metadataFiles:changes.length,requiredDestinationBytes,requiredDataBytes,originalsPreserved:true,requiresRestart:true,expiresAt:plan.createdAt+15*60*1000,excludedDataAreas:[...EXCLUDED,'organizer/rollbacks','organizer/trash','organizer/backups','backups']};
  }
  const verifyInputs = plan => {
    if(fingerprint({files:inventory(outputDir),directories:directoryPaths(outputDir)})!==plan.outputFingerprint||digest(userConfig)!==plan.configHash||JSON.stringify(metadata().map(r=>({relative:r.relative,sha256:r.sha256})))!==JSON.stringify(plan.metadata))throw error('预检后文件或配置发生变化，请重新预检');
  };
  async function rollbackJournal(j,automatic=false) {
    // Check every target before restoring any one; never overwrite unrelated changes.
    for(const c of j.changes) {
      const current=digest(path.join(dataDir,c.relative));
      if(current!==c.before&&current!==c.after)throw error('回滚冲突：元数据被其他操作修改，保留备份供人工恢复');
      if(c.before!==null&&digest(path.join(at(j.id),c.backup))!==c.before)throw error('回滚备份校验失败');
    }
    for(const c of [...j.changes].reverse()) {
      const file=path.join(dataDir,c.relative);checked(file,{missing:true});
      if(digest(file)===c.before)continue;
      if(c.before===null)fs.unlinkSync(file);else atomicBytes(file,fs.readFileSync(path.join(at(j.id),c.backup)));
    }
    j.status=automatic?'failed-rolled-back':'rolled-back';j.finishedAt=Date.now();saveJournal(j);
    return {id:j.id,status:j.status,requiresRestart:outputDir!==j.source,originalsPreserved:true,copiedFilesPreserved:true};
  }
  async function migrate(token,confirmed) {
    const plan=tickets.get(token);
    if(plan?.transactionId)return {id:plan.transactionId,status:json(path.join(at(plan.transactionId),'journal.json')).status,requiresRestart:true};
    if(confirmed!==true||!plan||Date.now()-plan.createdAt>15*60*1000)throw error('请重新预检并明确确认迁移');
    baseCheck();validateDestination(plan.destination);verifyInputs(plan);idle();
    if(availableBytes(path.dirname(plan.destination))<plan.requiredDestinationBytes||(fs.statSync(dataDir).dev!==fs.statSync(path.dirname(plan.destination)).dev&&availableBytes(dataDir)<plan.requiredDataBytes))throw error('预检后可用空间不足');
    busy=true;const id=crypto.randomUUID(),stage=path.join(path.dirname(plan.destination),`.psai-storage-${id}`);
    const journal={schemaVersion:1,id,createdAt:Date.now(),status:'copying',source:outputDir,destination:plan.destination,stage,directories:plan.directories,files:[],changes:[]};
    try {
      checked(root,{missing:true});fs.mkdirSync(at(id),{recursive:true,mode:0o700});saveJournal(journal);writeJson(pointer,{current:id});plan.transactionId=id;
      fs.mkdirSync(stage,{mode:0o700});for(const rel of plan.directories)fs.mkdirSync(path.join(stage,rel),{recursive:true,mode:0o700});
      for(const r of plan.files) {
        progress={stage:'copying',completed:journal.files.length,total:plan.files.length};
        const src=path.join(outputDir,r.relative),dest=path.join(stage,r.relative);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
        const sourceSha256=await copyHashed(src,dest,r);
        if(await fileHash(dest)!==sourceSha256)throw error('复制校验失败');
        if(r.relative.endsWith('.json')){const value=json(dest),next=rewrite(value,outputDir,plan.destination,[configuredOutput]);if(JSON.stringify(value)!==JSON.stringify(next))writeJson(dest,next);}
        journal.files.push({path:r.relative,sourceBytes:r.bytes,bytes:fs.statSync(dest).size,sourceSha256,sha256:await fileHash(dest)});saveJournal(journal);
      }
      progress={stage:'validating',completed:journal.files.length,total:plan.files.length};verifyInputs(plan);idle();
      for(const f of journal.files)if(await fileHash(path.join(outputDir,f.path))!==f.sourceSha256||await fileHash(path.join(stage,f.path))!==f.sha256)throw error('复制期间内容发生变化，迁移未提交');
      const meta=metadata();
      const planned=meta.map(r=>({file:r.file,value:rewrite(r.value,outputDir,plan.destination,[configuredOutput])})).filter((r,i)=>JSON.stringify(r.value)!==JSON.stringify(meta[i].value));
      planned.push({file:userConfig,value:{...(fs.existsSync(userConfig)?json(userConfig):{}),outputDir:plan.destination}}); // Configuration commits LAST.
      for(const [i,c] of planned.entries()) {
        const relative=path.relative(dataDir,c.file);if(relative.startsWith('..')||path.isAbsolute(relative))throw error('配置必须位于应用数据目录内');
        const bytes=Buffer.from(JSON.stringify(c.value,null,2)),before=digest(c.file),backup=`backups/${i}.bin`,after=`staged/${i}.json`;
        if(before!==null)atomicBytes(path.join(at(id),backup),fs.readFileSync(c.file));atomicBytes(path.join(at(id),after),bytes);
        journal.changes.push({relative,before,after:hash(bytes),backup,staged:after});
      }
      writeJson(path.join(at(id),'manifest.json'),{schemaVersion:1,id,source:outputDir,destination:plan.destination,directories:journal.directories,files:journal.files,createdAt:Date.now()});
      journal.status='prepared';saveJournal(journal);verifyInputs(plan);validateDestination(plan.destination);
      fs.renameSync(stage,plan.destination);journal.status='applying';saveJournal(journal);
      for(const c of journal.changes) {
        const file=path.join(dataDir,c.relative);checked(file,{missing:true});if(digest(file)!==c.before)throw error('提交期间元数据改变，停止迁移');
        writeBytes(file,fs.readFileSync(path.join(at(id),c.staged)));
        if(digest(file)!==c.after)throw error('元数据写入校验失败');
      }
      journal.status='committed';journal.finishedAt=Date.now();saveJournal(journal);
      return {id,status:'committed',destination:plan.destination,fileCount:journal.files.length,manifestPath:path.join(at(id),'manifest.json'),requiresRestart:true,originalsPreserved:true};
    }catch(e){
      try{await rollbackJournal(journal,true);}catch{journal.status='rollback-required';saveJournal(journal);throw error(`迁移失败，需要手动回滚；事务 ${id} 的备份已保留`);}
      throw error(`迁移未提交，原目录保留；${e.message}`);
    }finally{busy=false;progress=null;}
  }
  async function rollback(id) {
    if(busy)throw error('存储操作进行中');const j=readJournal();if(!j||j.id!==id)throw error('只能回滚当前存储事务');
    if(['rolled-back','failed-rolled-back'].includes(j.status))return {id,status:j.status,requiresRestart:outputDir!==j.source};
    idle();busy=true;
    try {
      // A post-restart rollback is safe only if no new destination work would be hidden.
      if(outputDir===j.destination) {
        const rows=inventory(j.destination);if(rows.length!==j.files.length||JSON.stringify(directoryPaths(j.destination))!==JSON.stringify(j.directories||[]))throw error('新目录已有新增或删除的文件，不能直接回滚');
        for(const f of j.files)if(!fs.existsSync(path.join(j.source,f.path))||await fileHash(path.join(j.source,f.path))!==f.sourceSha256||await fileHash(path.join(j.destination,f.path))!==f.sha256)throw error('迁移后内容已经改变，保留两个目录并人工核对');
      }
      return await rollbackJournal(j);
    }finally{busy=false;}
  }
  async function route(method,parts,body={}) {
    if(parts[0]!=='storage')return undefined;
    const action=parts.slice(1).join('/');
    if(method==='GET'&&!action)return status();
    if(method==='GET'&&action==='cleanup-proposal')return cleanupProposal();
    if(method==='GET'&&action==='manifest'){const j=readJournal();if(!j||!fs.existsSync(path.join(at(j.id),'manifest.json')))throw error('尚无完整迁移清单');return json(path.join(at(j.id),'manifest.json'));}
    if(method!=='POST')throw error('不支持的存储操作',400);
    if(action==='preflight')return preflight(body.destination);
    if(action==='migrate')return migrate(body.token,body.confirmed);
    if(action==='rollback'&&body.confirmed===true)return rollback(body.id);
    if(action==='quota/preflight')return quotaPreflight(body.kind,body.estimatedBytes);
    if(action==='quota') {
      if(busy||pending())throw error('请先完成存储事务或重启 helper');
      const p={};for(const k of ['previewLimitBytes','checkpointLimitBytes']){if(!Number.isSafeInteger(body[k])||body[k]<0||body[k]>1024**5)throw error('配额必须是 0–1 PiB 的整数，0 表示不限额',400);p[k]=body[k];}
      writeJson(settingsFile,p);return policy();
    }
    throw error('未知存储操作',400);
  }
  function assertQuota(kind,estimatedBytes){if(busy||pending())throw error('请先完成存储迁移并重启 helper');const r=quotaPreflight(kind,estimatedBytes);if(!r.allowed)throw error('本次预计写入超过存储配额；请先检查空间或调整配额');return r;}
  function reserveQuota(kind,estimatedBytes) {
    assertQuota(kind,estimatedBytes);
    const id=crypto.randomUUID();reservations.set(id,{kind,bytes:estimatedBytes});
    return ()=>reservations.delete(id);
  }
  return {route,requestGuard,quotaPreflight,reserveQuota,assertQuota};
}
let instance;
const service=()=>instance||=createStorage();
export const storageRoutes=(...args)=>service().route(...args);
export const storageRequestGuard=(...args)=>service().requestGuard(...args);
export const assertStorageQuota=(kind,estimatedBytes)=>service().assertQuota(kind,estimatedBytes);

export const reserveStorageQuota=(kind,estimatedBytes)=>service().reserveQuota(kind,estimatedBytes);
