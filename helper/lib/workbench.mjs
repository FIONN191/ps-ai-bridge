import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { assertStorageQuota } from './storage.mjs';
import { DATA_DIR } from './paths.mjs';
import { atomicJson, readJson, recordId } from './store.mjs';
import { useUpload, saveUpload, createJob, getJob, listJobs, cancelJob, appliedVariant, variantPath, createLocalResult } from './jobs.mjs';

const root = path.join(DATA_DIR, 'workbench');
const file = (kind, id) => path.join(root, kind, `${recordId(id)}.json`);
function records(kind) {
  const dir = path.join(root, kind);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')).map(x => readJson(path.join(dir, x))).sort((a,b) => b.updatedAt - a.updatedAt) : [];
}
function save(kind, data) { data.schemaVersion = 1; data.updatedAt = Date.now(); atomicJson(file(kind, data.id), data); return data; }
const resolveImage = async body => {
  if (body.jobId) { const j = getJob(body.jobId); if (!j?.result) throw new Error('任务没有结果'); return variantPath(j, appliedVariant(j)); }
  const src = useUpload(body.uploadId); if (!src) throw new Error('原图已失效，请重新选择'); return src;
};

export function createWorkbench({ providers, capabilities }) {
  let busy = false;
  // A restart never automatically resubmits uncertain external work.
  for (const b of records('batches')) if (b.status === 'running') { b.status = 'paused'; b.note = '服务重启，队列已暂停。请核对正在执行的任务后继续。'; save('batches', b); }
  async function tick() {
    if (busy) return; busy = true;
    try {
      for (const b of records('batches').filter(b => b.status === 'running')) {
        const active = b.items.find(x => x.status === 'running');
        if (active) {
          const j = getJob(active.jobId);
          if (j && ['queued','running','awaiting-selection'].includes(j.status)) continue;
          active.status = j?.status === 'done' ? 'done' : 'error'; active.error = j?.error || (!j ? '任务记录不存在，未自动重新提交' : null);
          save('batches', b);
        }
        const next = b.items.find(x => x.status === 'pending');
        if (!next) { b.status = b.items.some(x => x.status === 'error') ? 'needs-attention' : 'done'; save('batches', b); continue; }
        // Resolve a prior submission by durable item identity after a crash between two writes.
        let j = listJobs(100000).find(j => j.meta?.batchId === b.id && j.meta?.batchItemId === next.id && j.meta?.attempt === next.attempt);
        try {
          if (!j) {
            const uploadId = saveUpload(fs.readFileSync(next.inputPath), 'image/png');
            const refUploadIds = (b.refPaths || []).map(p => saveUpload(fs.readFileSync(p), 'image/png'));
            j = createJob({ ...b.options, ...next.options, aspect: next.aspect, refUploadIds, uploadId, groupId: b.id, meta: { ...b.options.meta, title: next.name, origin: 'batch', batchId: b.id, batchItemId: next.id, attempt: next.attempt, projectId: b.projectId || null, captureId:next.captureId||null } }, providers, capabilities);
          }
          next.jobId = j.id; next.status = 'running';
        } catch(e) { next.status = 'error'; next.error = e.message; }
        save('batches', b);
      }
    } finally { busy = false; }
  }
  const timer = setInterval(() => tick().catch(e => console.error('[batch]', e.message)), 1200); timer.unref();
  return {
    close: () => clearInterval(timer),
    tick,
    async route(method, parts, body) {
      if (!['GET', 'POST'].includes(method)) throw new Error('不支持的请求方式');
      if (parts[0] === 'batches') {
        if (method === 'GET') return { batches: records('batches') };
        if (parts.length === 1) {
          if (!Array.isArray(body.inputs) || !body.inputs.length || body.inputs.length > 200) throw new Error('请选择 1–200 张照片');
          if (!body.options?.prompt?.trim() || !providers[body.options.provider]) throw new Error('请选择平台并填写提示词');
          const id = crypto.randomUUID();
          const inputs = body.inputs.map(x => ({ ...x, src: useUpload(x.uploadId) }));
          if (inputs.some(x => !x.src)) throw new Error('有原图已失效，请重新选择');
          const dir = path.join(root, 'batch-assets', id); fs.mkdirSync(dir, { recursive: true });
          const items = [];
          for (const x of inputs) {
            const itemId = crypto.randomUUID(), inputPath = path.join(dir, `${itemId}.png`);
            const size = await sharp(x.src).rotate().png().toFile(inputPath);
            const choices = capabilities[body.options.provider]?.aspects || ['1:1'];
            const ratio = a => { const [w,h] = a.split(':').map(Number); return w/h; };
            const aspect = body.options.aspect === 'auto' ? choices.reduce((a,b) => Math.abs(Math.log(ratio(a)/(size.width/size.height))) < Math.abs(Math.log(ratio(b)/(size.width/size.height))) ? a : b) : body.options.aspect || '1:1';
            if(x.options&&(!providers[x.options.provider||body.options.provider]||!String(x.options.prompt||body.options.prompt).trim()))throw new Error('队列项的平台或提示词无效');
            const itemOptions=x.options?{provider:x.options.provider||body.options.provider,model:String(x.options.model||body.options.model||''),prompt:String(x.options.prompt||body.options.prompt)}:null;
            items.push({ captureId:typeof x.captureId==='string'?x.captureId:null,options:itemOptions,id: itemId, name: String(x.name || '图片').slice(0, 200), inputPath, aspect, status: 'pending', attempt: 1 });
          }
          // Pin references as well so a paused batch survives upload expiry.
          const refPaths = [];
          for (const rid of body.options.refUploadIds || []) { const src = useUpload(rid); if (!src) throw new Error('参考图已失效'); const refPath = path.join(dir, `ref-${refPaths.length}.png`); await sharp(src).png().toFile(refPath); refPaths.push(refPath); }
          return save('batches', { id, title: String(body.title || '照片批处理').slice(0, 200), status: 'paused', items, refPaths, options: { ...body.options, refUploadIds: [] }, createdAt: Date.now(), projectId: body.projectId || null });
        }
        const b = readJson(file('batches', parts[1]), null); if (!b) throw new Error('队列不存在');
        if(parts[2]==='item'){
          const item=b.items.find(i=>i.id===body.itemId);if(!item||item.status!=='pending'||b.status==='running')throw new Error('只能编辑暂停队列中未提交的项目');
          const next={...(item.options||{}),...(body.options||{}),...(body.prompt!==undefined?{prompt:body.prompt}:{})};
          const provider=next.provider||b.options.provider;if(!providers[provider])throw new Error('平台不存在');
          if(!String(next.prompt||b.options.prompt||'').trim())throw new Error('提示词不能为空');
          if(body.options){const aspect=body.options.aspect;if(aspect==='auto')throw new Error('逐项参数请选择明确比例');if(!(capabilities[provider]?.aspects||['1:1']).includes(aspect))throw new Error('此平台不支持所选比例');item.aspect=aspect;}
          item.options={provider,prompt:String(next.prompt||b.options.prompt).slice(0,100000),model:String(next.model||b.options.model||'').slice(0,200),resolution:String(next.resolution||b.options.resolution||'2K'),thinking:String(next.thinking||b.options.thinking||'High')};
          return save('batches',b);
        }
        if (parts[2] === 'start') { if (b.status === 'cancelled') throw new Error('队列已取消，请创建新队列'); b.status = 'running'; b.note = ''; }
        else if (parts[2] === 'pause') b.status = 'paused';
        else if (parts[2] === 'cancel') { b.status = 'cancelled'; for (const i of b.items) { if (i.status === 'running') cancelJob(i.jobId); if (['pending','running'].includes(i.status)) i.status = 'cancelled'; } }
        else if (parts[2] === 'retry') {
          const unresolved=b.items.filter(i=>i.status==='error'&&getJob(i.jobId)?.upstream&&getJob(i.jobId)?.status!=='done');
          if(unresolved.length)throw new Error('队列含已有上游任务，请先到「候选与恢复」核对和恢复；不会重新提交这些项目');
          for(const i of b.items)if(i.status==='error'){const j=getJob(i.jobId);if(j?.status==='done'){i.status='done';i.error=null;}else{i.status='pending';i.attempt++;i.jobId=null;i.error=null;}}
          b.status='paused';
        }
        else throw new Error('未知队列操作');
        return save('batches', b);
      }
      if (parts[0] === 'projects') {
        if (method === 'GET') return { projects: records('projects') };
        const id = body.id || crypto.randomUUID();
        const old = readJson(file('projects', id), null);
        if (!body.title?.trim()) throw new Error('请输入项目名称');
        const states = ['todo','working','done','rework','archived'];
        return save('projects', { ...(old||{}), id, title: body.title.trim().slice(0,200), notes: String(body.notes || '').slice(0,100000), state: states.includes(body.state) ? body.state : 'todo', due: String(body.due || '').slice(0,20), jobIds: (body.jobIds || old?.jobIds || []).filter(id => typeof id === 'string').slice(0,10000), createdAt: old?.createdAt || Date.now() });
      }
      if (parts[0] === 'tools') {
        if (parts[1] === 'save-preview') {
          const preview = readJson(file('previews', body.previewId), null);
          if (!preview) throw new Error('预览已失效，请重新预览');
          if (preview.jobId && getJob(preview.jobId)) return { ...getJob(preview.jobId), abort: undefined };
          const j = await createLocalResult({ sourcePath: preview.sourcePath, buffer: fs.readFileSync(preview.outputPath), title: '本地调色与辉光', parameters: preview.parameters });
          preview.jobId = j.id; save('previews', preview); return j;
        }
        const src = await resolveImage(body);
        if (parts[1] === 'scopes') {
          const { data, info } = await sharp(src).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
          const histogram = Array.from({ length: 3 }, () => Array(256).fill(0));
          const waveform = Array.from({ length: 128 }, () => Array(256).fill(0));
          const parade = Array.from({ length: 3 }, () => Array.from({length:128},()=>Array(256).fill(0)));
          const vectorscope = Array.from({length:128},()=>Array(128).fill(0));
          for (let y=0;y<info.height;y++) for (let x=0;x<info.width;x++) {
            const i=(y*info.width+x)*3; for(let c=0;c<3;c++) histogram[c][data[i+c]]++;
            const l = Math.round(.2126*data[i]+.7152*data[i+1]+.0722*data[i+2]); waveform[Math.min(127,Math.floor(x/info.width*128))][l]++;
            const column=Math.min(127,Math.floor(x/info.width*128));for(let c=0;c<3;c++)parade[c][column][data[i+c]]++;
            const Y=.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
            const cb=(data[i+2]-Y)/1.8556,cr=(data[i]-Y)/1.5748;
            const bin=v=>Math.max(0,Math.min(127,Math.round((v+127.5)/255*127)));
            vectorscope[bin(cr)][bin(cb)]++;
          }
          return { histogram, waveform, parade, vectorscope, width: info.width, height: info.height, colourspace: 'sRGB encoded, Rec.709 luma coefficients; vectorscope Cb horizontal / Cr vertical' };
        }
        if (parts[1] === 'preview') {
          const number = (v, d, lo, hi) => { const n = v == null ? d : Number(v); if(!Number.isFinite(n) || n<lo || n>hi) throw new Error('调整参数超出范围'); return n; };
          const exposure = number(body.exposure, 0, -4, 4), saturation = number(body.saturation, 1, 0, 3), sharpen = number(body.sharpen, 0, 0, 5), glow = number(body.glow, 0, 0, 1);
          let image = sharp(src).rotate().toColourspace('srgb').modulate({ brightness: 2 ** exposure, saturation });
          if (sharpen) image = image.sharpen({ sigma: Math.max(.3, sharpen) });
          let buffer = await image.png().toBuffer();
          if (glow) {
            const blur = await sharp(buffer).blur(12).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            for(let i=3;i<blur.data.length;i+=4) blur.data[i] = Math.round(blur.data[i]*glow);
            buffer = await sharp(buffer).composite([{ input: blur.data, raw: blur.info, blend: 'screen' }]).png().toBuffer();
          }
          assertStorageQuota('preview',buffer.length+fs.statSync(src).size);
          const previewId = crypto.randomUUID(), dir = path.join(root, 'preview-assets', previewId);
          fs.mkdirSync(dir, { recursive: true });
          const sourcePath = path.join(dir, `input${path.extname(src)}`), outputPath = path.join(dir, 'output.png');
          fs.copyFileSync(src, sourcePath); fs.writeFileSync(outputPath, buffer);
          const parameters = { exposure, saturation, sharpen, glow };
          save('previews', { id: previewId, sourcePath, outputPath, parameters });
          return { previewId, uploadId: saveUpload(buffer, 'image/png'), parameters };
        }
        throw new Error('未知图像工具');
      }
      return undefined;
    },
  };
}
