import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The destination is replaced only after a complete, synced write.
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  // Corruption must not silently become an empty database that the next save overwrites.
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function recordId(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,180}$/.test(value)) throw new Error('记录 ID 无效');
  return value;
}
