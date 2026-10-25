// 生成桌面端图标：App 图标（macOS 留边的圆角方块 / Windows 满版）和托盘图标。改了图形重新跑 npm run icons。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
fs.mkdirSync(out, { recursive: true });

// 虚线选区 + 右上角一颗星：「框一块，AI 生成」
// 托盘图标只有 18px，虚线会糊成一片，用粗实线
const glyph = (color, small = false) => `
  <rect x="270" y="330" width="420" height="420" rx="20" fill="none" stroke="${color}" stroke-opacity=".92" stroke-width="${small ? 64 : 36}" ${small ? '' : 'stroke-dasharray="70 46"'} stroke-linecap="round"/>
  <path d="M700 230 C713 318 748 353 836 366 C748 379 713 414 700 502 C687 414 652 379 564 366 C652 353 687 318 700 230 Z" fill="${color}"/>`;
const gradient = '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f3480"/><stop offset="1" stop-color="#8243e6"/></linearGradient></defs>';
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`);

const mac = svg(`${gradient}<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>${glyph('#fff')}`);
const win = svg(`${gradient}<rect x="0" y="0" width="1024" height="1024" rx="200" fill="url(#bg)"/><g transform="translate(-60 -40) scale(1.12)">${glyph('#fff')}</g>`);
// macOS 菜单栏模板图：只用黑色和透明度，系统按深浅色自动反色
const tray = svg(`<g transform="translate(-140 -110) scale(1.27)">${glyph('#000', true)}</g>`);

await sharp(mac).png().toFile(path.join(out, 'icon.png'));
await sharp(win).png().toFile(path.join(out, 'icon-win.png'));
await sharp(tray).resize(18, 18).png().toFile(path.join(out, 'trayTemplate.png'));
await sharp(tray).resize(36, 36).png().toFile(path.join(out, 'trayTemplate@2x.png'));
const winSmall = svg(`${gradient}<rect x="0" y="0" width="1024" height="1024" rx="200" fill="url(#bg)"/><g transform="translate(-60 -40) scale(1.12)">${glyph('#fff', true)}</g>`);
await sharp(winSmall).resize(32, 32).png().toFile(path.join(out, 'tray.png'));
console.log('图标已生成：', fs.readdirSync(out).join(', '));
