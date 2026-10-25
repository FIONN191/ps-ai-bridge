// 打开专用 Chrome 窗口，用来第一次登录 Google（AI Studio / Flow）和 ChatGPT。
import { launchChrome } from '../lib/chrome.mjs';
import { config } from '../lib/config.mjs';

await launchChrome('https://aistudio.google.com/prompts/new_chat');
console.log(`专用 Chrome 已打开（配置目录：${config.chrome.profileDir}）。`);
console.log('请在这个窗口里登录 Google 账号；用 ChatGPT 的话也在这里登录 chatgpt.com。登录一次即可，之后不要关掉这个窗口也行，关掉也会被 helper 自动重新打开。');
