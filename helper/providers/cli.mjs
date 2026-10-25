// 复用 agent-imagen-skill 的 scripts/gen.sh：Codex CLI（GPT Image）和 Antigravity agy（Nano Banana 2）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../lib/config.mjs';
import { imageSize } from '../lib/image.mjs';

const genSh = () => path.join(config.imagenSkillDir, 'scripts', 'gen.sh');

function makeProvider(engine, label) {
  return {
    label,
    async status() {
      // gen.sh 是 bash 脚本，调用的 Codex / agy 也只配过 macOS
      if (process.platform === 'win32') return { available: false, note: '仅支持 macOS' };
      return { available: fs.existsSync(genSh()) };
    },
    async run(job, { log, signal }) {
      if (!fs.existsSync(genSh())) throw new Error(`找不到 agent-imagen-skill 的 gen.sh：${genSh()}`);
      const args = [genSh(), '-e', engine, '-a', job.aspect, '-p', job.prompt, '-o', job.dir, '-t', 'result'];
      for (const f of [job.inputPath, ...(job.refPaths || [])].filter(Boolean)) args.push('-i', f);
      log(`调用 gen.sh -e ${engine}（${label}），通常 1–3 分钟`);
      const out = await new Promise((resolve, reject) => {
        const child = spawn('/bin/bash', args, { env: { ...process.env, PATH: `${process.env.PATH}:${process.env.HOME}/.local/bin` }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
        child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`gen.sh 失败（${code}）：${stderr.trim().split('\n').slice(-3).join(' / ')}`))));
      });
      const saved = /SAVED: (.+?) \(\d+x\d+\)/.exec(out)?.[1];
      if (!saved || !fs.existsSync(saved)) throw new Error('gen.sh 没有输出图片');
      return { path: saved, ...(await imageSize(saved)) };
    },
  };
}

export const codex = makeProvider('gpt', 'GPT Image · Codex CLI');
export const agy = makeProvider('nb', 'Nano Banana 2 · agy');
