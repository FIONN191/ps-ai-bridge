'use strict';

// Shared, dependency-free rules for Photoshop checkpoint exports.  It is kept
// inside the UXP package because Photoshop cannot require files outside the
// installed plugin directory.
function fileUrl(rawPath) {
  const raw = String(rawPath == null ? '' : rawPath).trim();
  if (!raw) throw new Error('NO_EXPORT_PATH');
  if (/^data:/i.test(raw) || /[\u0000\r\n]/.test(raw)) throw new Error('CHECKPOINT_PATH_INVALID');
  if (/^file:/i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, '/');
  return 'file:///' + normalized.replace(/^\/+/, '');
}

function validateCheckpointPath(rawPath) {
  const raw = String(rawPath == null ? '' : rawPath).trim();
  if (!raw) throw new Error('NO_EXPORT_PATH');
  if (!/\.png$/i.test(raw.replace(/[?#].*$/, ''))) throw new Error('CHECKPOINT_PATH_MUST_BE_PNG');
  return fileUrl(raw);
}

function exportFormat(rawPath) {
  const clean = String(rawPath || '').replace(/[?#].*$/, '');
  const match = /\.([a-z0-9]+)$/i.exec(clean);
  const extension = match ? match[1].toLowerCase() : '';
  const aliases = { jpeg: 'jpg' };
  const format = aliases[extension] || extension;
  if (['png', 'jpg', 'psd', 'psb', 'bmp', 'gif'].indexOf(format) < 0) throw new Error('EXPORT_FORMAT_UNSUPPORTED');
  return format;
}

function createPngSaveOptions(quickMethod) {
  // Adobe's PNGSaveOptions contract says compression/interlaced apply only
  // when method = PNGMethod.QUICK.  Do not report an uncompressed checkpoint
  // after silently falling back to another encoder mode.
  if (!quickMethod) throw new Error('CHECKPOINT_PNG_UNSUPPORTED');
  return { method: quickMethod, compression: 0, interlaced: false };
}

module.exports = { fileUrl, validateCheckpointPath, exportFormat, createPngSaveOptions };
