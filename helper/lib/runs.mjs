import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {DATA_DIR} from './paths.mjs';
import {atomicJson,readJson,recordId} from './store.mjs';
import {useUpload,saveUpload,createJob,getJob,listJobs,cancelJob,variantPath,appliedVariant,createLocalResult} from './jobs.mjs';
import {planTiles,mergeTiles} from './tiles.mjs';

export function createRuns({providers,capabilities}) {
  const root=path.join(DATA_DIR,'workbench','runs');
  const folder=id=>path.join(root,recordId(id));
  const save=r=>{r.updatedAt=Date.now();atomicJson(path.join(folder(r.id),'run.json'),r);return r;};
  const list=()=>fs.existsSync(root)?fs.readdirSync(root).map(id=>readJson(path.join(folder(id),'run.json'),null)).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt):[];
  for(const r of list())if(r.status==='running'){r.status='paused';r.note='服务重启，请核对任务后继续；已完成步骤不会重新提交';save(r);}
  let busy=false;
  async function tick(){
    if(busy)return;busy=true;
    try {for(const r of list().filter(r=>r.status==='running')){
      try {
        const active=r.steps.find(s=>s.status==='running');
        if(active){
          const job=getJob(active.jobId);
          if(job&&['running','queued'].includes(job.status))continue;
          if(!job||job.status!=='done'){
            active.status='error';active.error=job?.error||'任务不存在，需要人工核对';r.status='needs-attention';save(r);continue;
          }
          // Pin the exact completed version. Later manual edits cannot silently change downstream inputs.
          active.outputPath=path.join(folder(r.id),`${active.id}-output.png`);
          await sharp(await variantPath(job,appliedVariant(job))).png().toFile(active.outputPath);
          active.status='done';active.finishedAt=Date.now();save(r);
          if(r.reviewEach && r.steps.some(s=>s.status==='pending')){r.status='paused';r.note='此步完成，查看结果后点击继续';save(r);continue;}
        }
        const next=r.steps.find(s=>s.status==='pending');
        if(!next){
          if(r.steps.some(s=>s.status!=='done')){r.status='needs-attention';save(r);continue;}
          if(r.mode==='tiles'&&!r.resultJobId){
            // The result carries the run identity, closing the crash window before saving resultJobId.
            const previous=listJobs(100000).find(j=>j.meta?.parameters?.runId===r.id);
            if(previous)r.resultJobId=previous.id;
            else{
              const merged=await mergeTiles(r.width,r.height,r.steps.map(s=>({region:s.region,path:s.outputPath})),r.overlap,path.join(folder(r.id),'merged.png'));
              const job=await createLocalResult({sourcePath:r.inputPath,buffer:fs.readFileSync(merged),title:`分块合成 · ${r.title}`,parameters:{runId:r.id,mode:'tiles',size:r.size,overlap:r.overlap}});
              r.resultJobId=job.id;
            }
          }else if(r.mode==='chain')r.resultJobId=r.steps.at(-1).jobId;
          r.status='done';save(r);continue;
        }
        const prior=r.steps[r.steps.indexOf(next)-1];
        if(r.mode==='chain'&&prior&&prior.status!=='done'){r.status='needs-attention';save(r);continue;}
        let job=listJobs(100000).find(j=>j.meta?.runId===r.id&&j.meta?.stepId===next.id&&j.meta?.attempt===next.attempt);
        if(!job){
          const src=r.mode==='chain'?(prior?.outputPath||r.inputPath):next.inputPath;
          const uploadId=saveUpload(fs.readFileSync(src),'image/png');
          const refUploadIds=next.refs.map(p=>saveUpload(fs.readFileSync(p),'image/png'));
          job=createJob({...next.options,uploadId,refUploadIds,groupId:r.id,fallbacks:[],meta:{origin:'workflow',title:next.title,runId:r.id,stepId:next.id,attempt:next.attempt,region:next.region||null}},providers,capabilities);
        }
        next.status='running';next.jobId=job.id;r.note='';save(r);
      }catch(e){r.status='needs-attention';r.note=e.message;save(r);}
    }}finally{busy=false;}
  }
  const timer=setInterval(()=>tick().catch(e=>console.error('[runs]',e.message)),1200);timer.unref();
  async function route(method,parts,body={}){
    if(parts[0]!=='runs')return undefined;
    if(method==='GET')return {runs:list()};
    if(method!=='POST')throw new Error('不支持的请求方式');
    if(parts.length===1){
      if(!['chain','tiles'].includes(body.mode))throw new Error('任务类型无效');
      const src=body.jobId?await variantPath(getJob(body.jobId)||{},appliedVariant(getJob(body.jobId)||{})):useUpload(body.uploadId);
      if(!src)throw new Error('请选择原图');
      const options=body.mode==='chain'?body.steps:[body.options];
      if(!Array.isArray(options)||options.length<1||options.length>30)throw new Error('连续步骤需为 1–30 步');
      for(const o of options){if(!providers[o.provider]||!o.prompt?.trim())throw new Error('每一步都要选择平台并填写提示词');if((o.refUploadIds||[]).some(id=>!useUpload(id)))throw new Error('参考图失效，请重新选择');}
      const id=crypto.randomUUID(),dir=folder(id);fs.mkdirSync(dir,{recursive:true});
      const inputPath=path.join(dir,'input.png'),meta=await sharp(src).rotate().toColourspace('srgb').png().toFile(inputPath);
      const r={id,title:String(body.title||'未命名流程').slice(0,200),schemaVersion:1,mode:body.mode,status:'paused',reviewEach:body.reviewEach!==false,createdAt:Date.now(),inputPath,width:meta.width,height:meta.height,size:Number(body.size||1024),overlap:Number(body.overlap??128),steps:[]};
      const regions=r.mode==='tiles'?planTiles(r.width,r.height,r.size,r.overlap):options.map(()=>null);
      for(const [i,region] of regions.entries()){
        const original=options[r.mode==='tiles'?0:i],sid=crypto.randomUUID(),refs=[];
        for(const [ri,rid] of (original.refUploadIds||[]).entries()){const dest=path.join(dir,`${sid}-ref${ri}.png`);await sharp(useUpload(rid)).png().toFile(dest);refs.push(dest);}
        const opt={provider:original.provider,model:original.model||'',prompt:original.prompt,aspect:original.aspect||'1:1',resolution:original.resolution||'2K',thinking:original.thinking||'High',post:{align:false,cc:'none'}};
        if(opt.aspect==='auto'){
          const choices=capabilities[opt.provider]?.aspects||['1:1'];
          const distance=a=>{const [w,h]=a.split(':').map(Number);return Math.abs(Math.log((w/h)/(meta.width/meta.height)));};
          opt.aspect=choices.reduce((a,b)=>distance(a)<distance(b)?a:b);
        }
        const step={id:sid,title:String(original.title||`第 ${i+1} ${r.mode==='tiles'?'块':'步'}`).slice(0,200),status:'pending',attempt:1,options:opt,refs};
        if(region){step.region=region;step.inputPath=path.join(dir,`${sid}-input.png`);await sharp(inputPath).extract(region).png().toFile(step.inputPath);
          const choices=capabilities[opt.provider]?.aspects||['1:1'],ratio=a=>{const [w,h]=a.split(':').map(Number);return w/h;};
          opt.aspect=choices.reduce((a,b)=>Math.abs(Math.log(ratio(a)/(region.width/region.height)))<Math.abs(Math.log(ratio(b)/(region.width/region.height)))?a:b);
        }
        r.steps.push(step);
      }
      return save(r);
    }
    // Serialize controls with the tick's asynchronous file writes, so pause/cancel cannot be overwritten.
    while(busy)await new Promise(resolve=>setTimeout(resolve,20));
    const r=readJson(path.join(folder(parts[1]),'run.json'),null);if(!r)throw new Error('流程不存在');
    if(parts[2]==='start'){if(['cancelled','done'].includes(r.status))throw new Error('流程已结束');if(r.steps.some(s=>s.status==='error'))throw new Error('请先核对失败步骤，再重试');r.status='running';r.note='';}
    else if(parts[2]==='pause')r.status='paused';
    else if(parts[2]==='cancel'){r.status='cancelled';for(const s of r.steps){if(s.status==='running')cancelJob(s.jobId);if(['running','pending'].includes(s.status))s.status='cancelled';}}
    else if(parts[2]==='retry'){
      if(body.verified!==true)throw new Error('请先核对外部服务中失败任务的实际状态，避免重复执行');
      if(r.status==='cancelled')throw new Error('已取消的流程不能重新提交');
      for(const s of r.steps)if(s.status==='error'){s.status='pending';s.jobId=null;s.error=null;s.attempt++;}r.status='paused';r.note='失败步骤已重置，点击继续';
    }else throw new Error('未知流程操作');
    return save(r);
  }
  return {route,tick,close:()=>clearInterval(timer)};
}
