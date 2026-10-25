// 官方 API 备选通道：填了 Key 才启用（config.json 或环境变量 GEMINI_API_KEY / OPENAI_API_KEY）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.mjs';
import { imageSize, extFromMime } from '../lib/image.mjs';

export const geminiApi = {
  label: 'Nano Banana · Gemini API',
  async status() {
    return { available: Boolean(config.geminiApiKey), note: config.geminiApiKey ? '' : '未填 geminiApiKey' };
  },
  async run(job, { log, signal }) {
    if (!config.geminiApiKey) throw new Error('没有配置 Gemini API Key');
    const parts = [{ text: job.prompt }];
    for (const f of [job.inputPath, ...(job.refPaths || [])].filter(Boolean)) {
      parts.push({ inline_data: { mime_type: f.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
    }
    log(`请求 Gemini API（${config.geminiModel}，${job.aspect}，${job.resolution}）`);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: job.aspect, imageSize: job.resolution } },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Gemini API ${r.status}：${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
    const img = data.candidates?.[0]?.content?.parts?.findLast?.((p) => p.inlineData || p.inline_data);
    const inline = img?.inlineData || img?.inline_data;
    if (!inline) throw new Error(`Gemini API 没有返回图片：${JSON.stringify(data).slice(0, 300)}`);
    const out = path.join(job.dir, `result-gemini-api.${extFromMime(inline.mimeType || inline.mime_type)}`);
    fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
    return { path: out, ...(await imageSize(out)) };
  },
};

// gpt-image-1 只支持 1:1、2:3、3:2 三种尺寸；其他比例交给 auto
const OPENAI_SIZES = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024' };

export const openaiApi = {
  label: 'GPT Image · OpenAI API',
  async status() {
    return { available: Boolean(config.openaiApiKey), note: config.openaiApiKey ? '' : '未填 openaiApiKey' };
  },
  async run(job, { log, signal }) {
    if (!config.openaiApiKey) throw new Error('没有配置 OpenAI API Key');
    const size = OPENAI_SIZES[job.aspect] || 'auto';
    log(`请求 OpenAI Images API（${config.openaiModel}，${size}）`);
    let r;
    if (job.inputPath || job.refPaths?.length) {
      const form = new FormData();
      form.append('model', config.openaiModel);
      form.append('prompt', job.prompt);
      form.append('size', size);
      form.append('quality', 'high');
      for (const f of [job.inputPath, ...(job.refPaths || [])].filter(Boolean)) {
        form.append('image[]', new Blob([fs.readFileSync(f)], { type: f.endsWith('.png') ? 'image/png' : 'image/jpeg' }), path.basename(f));
      }
      r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', signal, headers: { authorization: `Bearer ${config.openaiApiKey}` }, body: form });
    } else {
      r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        signal,
        headers: { authorization: `Bearer ${config.openaiApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.openaiModel, prompt: job.prompt, size, quality: 'high' }),
      });
    }
    const data = await r.json();
    if (!r.ok) throw new Error(`OpenAI API ${r.status}：${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI API 没有返回图片');
    const out = path.join(job.dir, 'result-openai-api.png');
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    return { path: out, ...(await imageSize(out)) };
  },
};
