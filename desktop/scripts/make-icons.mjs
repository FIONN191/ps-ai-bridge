// 生成桌面端图标：从 BXAS 标志（assets/logo.png：蓝色圆底 + 白色衬线「BX」和一颗星）出 App 图标和托盘图标。
// assets/logo-glyph.png 是同一个标志里白色字母的蒙版（白 = 字），菜单栏模板图用它。改了标志重新跑 npm run icons。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const logo = path.join(out, 'logo.png');
const glyph = path.join(out, 'logo-glyph.png');
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

// 圆形图标放在透明画布中央：macOS 按系统图标网格留边（约 82%），Windows 基本占满
async function centered(size, scale, file) {
  const inner = Math.round(size * scale);
  const img = await sharp(logo).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: transparent } })
    .composite([{ input: img, gravity: 'center' }]).png().toFile(path.join(out, file));
}
await centered(1024, 0.82, 'icon.png');
await centered(1024, 0.98, 'icon-win.png');
await sharp(logo).resize(32, 32).png().toFile(path.join(out, 'tray.png'));

// macOS 菜单栏模板图：只用黑色和透明度（系统按深浅色自动反色），所以只画「BX」字形，不要蓝色圆底
const mask = await sharp(glyph).trim({ threshold: 10 }).toColourspace('b-w').toBuffer();
for (const [size, file] of [[18, 'trayTemplate.png'], [36, 'trayTemplate@2x.png']]) {
  const alpha = await sharp(mask).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0 } }).toColourspace('b-w').raw().toBuffer();
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) rgba[i * 4 + 3] = alpha[i];
  await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toFile(path.join(out, file));
}
console.log('图标已生成：', fs.readdirSync(out).join(', '));
