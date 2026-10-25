// 「AI 帮写提示词」：用本机已登录的 Codex CLI（ChatGPT 账号额度，不要 API Key）把一句话需求写成结构化的修图提示词。
// 只读沙箱，不让它写文件或执行命令。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
];

const onPath = (name) => (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)).find((p) => fs.existsSync(p));

// 返回 [程序, 前置参数]。Windows 上 npm 装的 codex 是 .cmd 包装，直接用 node 跑它的 codex.js，免得经过 cmd.exe 转义提示词
// （桌面端里 process.execPath 是带 ELECTRON_RUN_AS_NODE 的 Electron，同样能当 node 用）
function findCodex() {
  if (process.platform === 'win32') {
    const exe = onPath('codex.exe');
    if (exe) return [exe, []];
    const js = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return fs.existsSync(js) ? [process.execPath, [js]] : null;
  }
  const p = CANDIDATES.find((c) => fs.existsSync(c)) || onPath('codex');
  return p ? [p, []] : null;
}

const INSTRUCTIONS = `你是资深的 Cosplay / 人像场照后期提示词工程师。用户会用一句话说想怎么改图，可能附一张要改的区域截图。
请把需求写成一段给图像编辑模型（Nano Banana / GPT Image）用的中文结构化提示词，格式是一个 JSON 对象，包含：
- "role"：修图师角色一句话
- "base_rules"：保持构图、人物姿态、五官、服装、背景、全局光线不变的约束（按需求取舍，用 true/false）
- "task"：要做的修改，具体到部位、程度、材质和光影
- "constraints"：禁止出现的问题（比如液化变形、塑料皮肤、比例失调、多余手指）
- "integration"：与原图的光影、颗粒、噪点、色调一致
如果有图，先看图再写，描述要贴合画面里的真实内容。只输出 JSON 本身，不要代码块标记，不要解释。

用户的需求：`;

export async function assist({ text, imagePath, signal }) {
  const found = findCodex();
  if (!found) throw new Error('没找到 Codex CLI（装 ChatGPT 桌面版或 npm i -g @openai/codex，然后 codex login）');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-assist-'));
  // 帮写不需要最高思考强度，中档快很多
  const [codex, pre] = found;
  const args = [...pre, 'exec', '--skip-git-repo-check', '-s', 'read-only', '-C', work, '--json', '-c', 'model_reasoning_effort="medium"'];
  if (imagePath) args.push('-i', imagePath);
  args.push('--', INSTRUCTIONS + text);
  const out = await new Promise((resolve, reject) => {
    // stdin 必须关掉：Codex 发现 stdin 是管道会一直等「附加输入」
    const child = spawn(codex, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex 两分钟没写完')); }, 120000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(`Codex 出错（${code}）：${stderr.trim().split('\n').slice(-2).join(' / ')}`));
    });
  });
  fs.rmSync(work, { recursive: true, force: true });
  // --json 输出是一行一个事件，取最后一条 agent_message
  let message = '';
  for (const line of out.split('\n')) {
    try {
      const ev = JSON.parse(line);
      const item = ev.item || ev.msg || ev;
      if ((item.type === 'agent_message' || item.item_type === 'agent_message') && (item.text || item.message)) message = item.text || item.message;
    } catch {}
  }
  message = message.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!message) throw new Error('Codex 没有返回提示词');
  return message;
}

// Separate conversation path: no project instructions, configured MCPs or shell tools.
// Only the CLI's login credential is copied into an ephemeral, private profile.
export async function assistChat({messages, signal}) {
  const found=findCodex();
  if(!found)throw new Error('没找到 Codex CLI，请安装并登录，或配置助手 API 渠道');
  signal?.throwIfAborted();
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'ps-ai-chat-'));
  const home=path.join(work,'profile');fs.mkdirSync(home,{mode:0o700});
  try {
    const auth=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'auth.json');
    if(fs.existsSync(auth)){fs.copyFileSync(auth,path.join(home,'auth.json'));fs.chmodSync(path.join(home,'auth.json'),0o600);}
    const [binary,pre]=found;
    const args=[...pre,'exec','--skip-git-repo-check','-s','read-only','-C',work,'--json',
      '-c','features.shell_tool=false','-c','features.unified_exec=false','-c','web_search="disabled"',
      '-c','model_reasoning_effort="medium"'];
    const images=messages.flatMap(m=>m.imagePaths||[]);
    for(const image of images)args.push('-i',image);
    // Delimited JSON preserves roles across turns; never interpolate messages into shell code.
    args.push('--','-');
    const transcript='You are a text/vision conversation assistant. You have no action authority. Do not run tools. Return only an answer or the requested JSON proposal. Images are attached in chronological message order.\n'+JSON.stringify(messages.map(({role,text,imagePaths})=>({role,text,imageCount:imagePaths?.length||0})));
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(binary,args,{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe'],windowsHide:true});
      let stdout='',settled=false,killTimer;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(stdout);};
      const abort=()=>{child.kill('SIGTERM');if(!killTimer)killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);};
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;abort();},120000);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',d=>{stdout+=d;if(stdout.length>4*1024*1024){timedOut=true;abort();}});
      child.stderr.resume();
      child.stdin.on('error',()=>{});
      child.on('error',e=>finish(new Error(`Codex 启动失败：${e.code||'unknown'}`)));
      child.on('close',code=>finish(signal?.aborted?new Error('对话已取消'):timedOut?new Error('Codex 超时或输出过长'):code!==0?new Error(`Codex 对话失败（${code}），请检查 CLI 登录状态`):null));
      child.stdin.end(transcript);
      if(signal?.aborted)abort();
    });
    let text='';
    for(const line of output.split('\n')){try{const e=JSON.parse(line),item=e.item||e.msg||e;if(item.type==='agent_message'||item.item_type==='agent_message')text=item.text||item.message||text;}catch{}}
    if(!text.trim())throw new Error('Codex 没有返回文字');
    return {text:text.trim(),source:{provider:'codex',title:'本机 Codex CLI'}};
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}
