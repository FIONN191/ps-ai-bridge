import sharp from 'sharp';

export async function imageSize(file) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error(`读不出图片尺寸：${file}`);
  return { width, height };
}

// 桌面端拖进来的本地图片 / 拿已有结果继续改：按 EXIF 摆正、转 sRGB、长边缩到 maxSide；有透明通道存 PNG，否则 JPEG
export async function normalizeImage(file, maxSide = 2048) {
  const { hasAlpha, width, height } = await sharp(file).metadata();
  if (maxSide === 0 && width * height > 40000000) throw new Error('本地原尺寸工具支持最多 4000 万像素');
  let img = sharp(file).rotate().toColorspace('srgb');
  if (maxSide) img = img.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
  const png = hasAlpha || maxSide === 0;
  const { data, info } = await (png ? img.png() : img.jpeg({ quality: 92 })).toBuffer({ resolveWithObject: true });
  return { buffer: data, mime: png ? 'image/png' : 'image/jpeg', width: info.width, height: info.height };
}

export function extFromMime(mime = '') {
  if (/png/.test(mime)) return 'png';
  if (/webp/.test(mime)) return 'webp';
  return 'jpg';
}
