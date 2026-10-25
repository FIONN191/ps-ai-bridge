// AI 生图贴回：选区/图层 → 导出 → 交给本机 helper 生图 → 结果放进「生成组」贴回原位置。
// 预设格式、@param 滑杆、【填空】、剪影分区、贴回羽化的思路来自夏三七「修图轮椅 V6」（GPLv3），见 README。
const { app, core, action, constants } = require('photoshop');
const uxp = require('uxp');

const lfs = uxp.storage.localFileSystem;
const formats = uxp.storage.formats;
const HELPER = 'http://127.0.0.1:47811';
const HEADERS = { 'x-ps-ai-bridge': '1' };
const MAX_REFS = 4;
const PREF_KEY = 'ps-ai-bridge-prefs';
const GROUPS_KEY = 'ps-ai-bridge-groups';

const MODEL_LABELS = { 'nano-banana-2.1': 'Nano Banana 2.1', 'nano-banana-2': 'Nano Banana 2', 'nano-banana-pro': 'Nano Banana Pro', 'nano-banana-2-lite': 'Nano Banana 2 Lite' };
const THINKING_LABELS = { Minimal: '最快', Medium: '中等', High: '最高' };
const CC_LABELS = { none: '不校色', global: '全局校色', precise: '精准校色', mixed: '混合校色' };
const KEEP_COMPOSITION = '\n\n要求：输出图片的构图、取景、比例和透视与图1完全一致，不要裁切、缩放或平移画面；提示里没提到的人物、服装、五官和光线都保持原样。';

// 剪影上各分区标签的位置（归一化），取自 V6 tile-bodypreset.js
const LABEL_POS = {
  head: [0.62, 0.16], hair: [0.36, 0.11], neck: [0.62, 0.22], torso: [0.62, 0.29], arms: [0.68, 0.36],
  hands: [0.55, 0.52], legs: [0.65, 0.76], feet: [0.65, 0.93], clothing: [0.65, 0.56], accessory: [0.30, 0.47],
  fullbody: [0.20, 0.06], lighting: [0.85, 0.06], background: [0.72, 0.66], weapon: [0.88, 0.62],
  cleanup: [0.20, 0.97], effects: [0.88, 0.97], other: [0.20, 0.55],
};

let health = null;
let categories = [];
let presets = [];
let currentCat = '';
let currentPreset = null;
let refs = []; // [{ uploadId }]
let groups = []; // 生成组
let historyOpen = false;

const $ = (id) => document.getElementById(id);

const bp = (descs) => action.batchPlay(Array.isArray(descs) ? descs : [descs], {});
const post = (path, body) => fetch(`${HELPER}${path}`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function hint(msg, isErr) {
  // 提示同时写在按钮下面和面板顶部：面板滚动时也能看到
  for (const id of ['hint', 'topHint']) {
    $(id).textContent = msg || '';
    $(id).className = `small hint${id === 'topHint' ? ' top-hint' : ''}${isErr ? ' err' : ''}`;
  }
  if (msg) remoteLog(msg, isErr ? 'error' : 'info');
}
// PS 的 batchPlay / DOM 有时抛出的不是 Error（没有 message），这里统一转成能看懂的文字
function errText(e) {
  if (!e) return '未知错误';
  if (e.message) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
function remoteLog(msg, level) {
  fetch(`${HELPER}/log`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ level, msg: String(msg) }) }).catch(() => {});
}
window.addEventListener('unhandledrejection', (e) => remoteLog(`未处理的错误：${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`, 'error'));
window.addEventListener('error', (e) => remoteLog(`脚本错误：${e.message} @${e.filename}:${e.lineno}`, 'error'));

// ---------- 偏好 ----------
const PREF_IDS = ['provider', 'model', 'aspect', 'resolution', 'thinking', 'padding', 'source', 'count', 'cc', 'shrink', 'blur', 'returnAs', 'groupColor', 'checkpointMin'];
const PREF_CHECKS = ['keepComposition', 'maskWithSelection', 'fallback', 'align', 'sound', 'tex', 'autoReturn'];
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; }
}
function savePrefs() {
  const p = { prompt: $('prompt').value, presetId: currentPreset && currentPreset.id };
  for (const id of PREF_IDS) p[id] = $(id).value;
  for (const id of PREF_CHECKS) p[id] = $(id).checked;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {}
}
function saveGroups() {
  const slim = groups.slice(0, 30).map((g) => ({ ...g, jobs: g.jobs.map((j) => ({ id: j.id, status: j.status, error: j.error, layerId: j.layerId, placed: j.placed, appliedKey: j.appliedKey, providerLabel: j.providerLabel, placeError: j.placeError })) }));
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(slim)); } catch {}
}

// 下拉框：菜单画在面板里面。
// 不用 sp-picker：它的菜单是单独弹出的窗口，面板收在 PS 右侧图标栏里展开时，点菜单项会被当成点到面板外面，面板直接收起、选不上。
// 也不用原生 <select>：滚轮划过就改值。滑杆用 sp-slider（不响应滚轮）。
// 用法和 <select> 一样：el.value 读写、监听 change；静态选项写成 <div data-v="值" data-sel>文字</div>。
let groupsRenderPending = false;
function initDropdown(el) {
  if (el._dd) return el;
  const opts = [...el.querySelectorAll('[data-v]')];
  const items = opts.map((o) => [o.getAttribute('data-v'), o.textContent.trim(), o.hasAttribute('data-disabled')]);
  const sel = opts.find((o) => o.hasAttribute('data-sel'));
  el._dd = { items: [], value: undefined };
  el.innerHTML = '<div class="dd-btn"><span class="dd-label"></span><span class="dd-arrow">▾</span></div><div class="dd-menu hidden"></div>';
  Object.defineProperty(el, 'value', { configurable: true, get: () => el._dd.value, set: (v) => setSelect(el, v) });
  el.querySelector('.dd-btn').addEventListener('click', () => toggleDropdown(el));
  el.querySelector('.dd-menu').addEventListener('click', (e) => {
    const it = e.target.closest ? e.target.closest('.dd-item') : null;
    if (!it || it.classList.contains('disabled')) return;
    const v = it.getAttribute('data-v');
    const changed = v !== el._dd.value;
    if (changed) setSelect(el, v);
    closeDropdowns();
    if (changed) el.dispatchEvent(new Event('change'));
  });
  if (items.length) fillSelect(el, items, sel ? sel.getAttribute('data-v') : items[0][0]);
  return el;
}
function fillSelect(sel, items, value) {
  initDropdown(sel);
  sel._dd.items = items.map(([v, label, d]) => [String(v), label, Boolean(d)]);
  sel.querySelector('.dd-menu').innerHTML = sel._dd.items.map(([v, label, d]) => `<div class="dd-item${d ? ' disabled' : ''}" data-v="${esc(v)}">${esc(label)}</div>`).join('');
  const ok = sel._dd.items.find(([v, , d]) => v === String(value) && !d) || sel._dd.items.find(([, , d]) => !d);
  sel._dd.value = undefined;
  setSelect(sel, ok ? ok[0] : null);
}
function setSelect(sel, value) {
  initDropdown(sel);
  const it = sel._dd.items.find(([v]) => v === String(value));
  if (!it && value !== null) return; // 不认识的值（比如换平台后没有这个比例）：保持原样
  sel._dd.value = it ? it[0] : undefined;
  sel.querySelector('.dd-label').textContent = it ? it[1] : '';
  for (const o of sel.querySelectorAll('.dd-item')) {
    if (o.getAttribute('data-v') === sel._dd.value) o.classList.add('selected'); else o.classList.remove('selected');
  }
}
function toggleDropdown(el) {
  const wasOpen = el.classList.contains('open');
  closeDropdowns();
  if (wasOpen) return;
  el.classList.add('open');
  const menu = el.querySelector('.dd-menu');
  menu.classList.remove('hidden');
  // 下面放不下、上面地方更大时往上弹
  try {
    const r = el.getBoundingClientRect();
    const vh = document.body.clientHeight || 600;
    const need = Math.min(el._dd.items.length * 22 + 6, 220); // 刚显示时量不到高度，按项数估
    if (vh - r.bottom < need && r.top > vh - r.bottom) el.classList.add('up'); else el.classList.remove('up');
    const cur = menu.querySelector('.dd-item.selected');
    if (cur) menu.scrollTop = Math.max(0, cur.offsetTop - 60);
  } catch {}
}
function closeDropdowns() {
  for (const el of document.querySelectorAll('.dd.open')) {
    el.classList.remove('open');
    el.querySelector('.dd-menu').classList.add('hidden');
  }
  // 菜单开着的时候生成组卡片不重画（重画会把菜单关掉），关了再补上
  if (groupsRenderPending) { groupsRenderPending = false; renderGroups(); }
}

function providerCaps(key) {
  return (health && health.providers[key || $('provider').value]) || {};
}

function refreshOptions() {
  const prefs = loadPrefs();
  const caps = providerCaps();
  $('modelField').style.display = caps.models ? 'block' : 'none';
  if (caps.models) fillSelect($('model'), caps.models.map((m) => [m, MODEL_LABELS[m] || m]), $('model').value || prefs.model);
  fillSelect($('aspect'), [['auto', '自动（贴合选区）'], ...(caps.aspects || ['1:1']).map((a) => [a, a])], $('aspect').value || prefs.aspect || 'auto');
  $('resolutionField').style.display = caps.resolutions ? 'block' : 'none';
  if (caps.resolutions) fillSelect($('resolution'), caps.resolutions.map((r) => [r, r]), $('resolution').value || prefs.resolution || '2K');
  $('thinkingField').style.display = caps.thinking ? 'block' : 'none';
  if (caps.thinking) fillSelect($('thinking'), caps.thinking.map((t) => [t, THINKING_LABELS[t] || t]), $('thinking').value || prefs.thinking || 'High');
}

async function checkHelper() {
  try {
    const r = await fetch(`${HELPER}/health`);
    const h = await r.json();
    const first = !health;
    health = h;
    $('helperDot').className = 'dot ok';
    $('helperText').textContent = `helper 已连接 · v${h.version}`;
    if (first) {
      const prefs = loadPrefs();
      const items = Object.entries(h.providers).map(([k, p]) => [k, p.available ? p.label : `${p.label}（${p.note || '不可用'}）`, !p.available]);
      fillSelect($('provider'), items, $('provider').value || prefs.provider || 'aistudio');
      refreshOptions();
      await loadPresets();
      if (prefs.presetId && !currentPreset) await restorePreset(prefs.presetId).catch(() => {});
    }
  } catch (e) {
    health = null;
    $('helperDot').className = 'dot bad';
    $('helperText').textContent = `helper 没有运行：打开「PS AI Bridge」桌面程序（源码版双击「启动 helper.command」）（${e.message || e}）`;
  }
}

// ---------- 预设 ----------
async function loadPresets() {
  const r = await fetch(`${HELPER}/presets`);
  const d = await r.json();
  categories = d.categories;
  presets = d.presets;
  fillSelect($('saveCat'), categories.map((c) => [c.id, c.name]), $('saveCat').value || 'other');
  renderSilhouette();
  renderPresetList();
}

function renderSilhouette() {
  const counts = {};
  for (const p of presets) counts[p.category] = (counts[p.category] || 0) + 1;
  $('silhouetteLabels').innerHTML = categories.map((c) => {
    const pos = LABEL_POS[c.id] || [0.5, 0.5];
    const active = currentCat === c.id ? ' active' : '';
    const empty = counts[c.id] ? '' : ' empty';
    return `<span class="sil-label${active}${empty}" data-cat="${c.id}" style="left:${Math.round(pos[0] * 100)}%;top:${Math.round(pos[1] * 100)}%">${esc(c.name)} ${counts[c.id] || 0}</span>`;
  }).join('');
  for (const chip of document.querySelectorAll('.chip')) chip.className = `chip${chip.getAttribute('data-cat') === currentCat ? ' active' : ''}`;
  const name = currentCat === '*' ? '★ 收藏' : (categories.find((c) => c.id === currentCat) || {}).name;
  $('catNow').textContent = name ? `分类：${name}` : '分类：全部';
}

function renderPresetList() {
  const q = $('presetSearch').value.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const list = presets.filter((p) => {
    if (currentCat === '*' && !p.starred) return false;
    if (currentCat && currentCat !== '*' && p.category !== currentCat) return false;
    return words.every((w) => p.keys.includes(w));
  }).slice(0, 300);
  $('presetCount').textContent = `${presets.length} 个`;
  $('presetList').innerHTML = list.length ? list.map((p) => {
    const tags = [p.factory ? '出厂' : '', p.paramCount ? `${p.paramCount} 参数` : '', p.fillCount ? '填空' : '', p.refCount ? '带参考图' : ''].filter(Boolean).join(' · ');
    const active = currentPreset && currentPreset.id === p.id ? ' active' : '';
    return `<div class="preset-item${active}" data-id="${esc(p.id)}"><span class="star">${p.starred ? '★' : ''}</span>${esc(p.title)}<span class="tags">${esc(tags)}</span></div>`;
  }).join('') : '<div class="small empty-note">没有匹配的预设</div>';
}

async function selectPreset(id) {
  const r = await fetch(`${HELPER}/presets/${encodeURIComponent(id)}`);
  if (!r.ok) return hint('读取预设失败', true);
  currentPreset = await r.json();
  $('prompt').value = currentPreset.content;
  renderPresetDetail();
  renderPresetList();
  if (currentPreset.refCount) {
    const rr = await post(`/presets/${encodeURIComponent(id)}/refs`);
    const d = await rr.json();
    for (const uploadId of d.uploadIds || []) if (refs.length < MAX_REFS) refs.push({ uploadId });
    renderRefs();
  }
  savePrefs();
}

// 面板重载 / PS 重启后把上次选的预设找回来：提示词用存下来的（里面是调过的参数），滑杆和填空按它对齐
async function restorePreset(id) {
  const r = await fetch(`${HELPER}/presets/${encodeURIComponent(id)}`);
  if (!r.ok) return;
  currentPreset = await r.json();
  const text = $('prompt').value;
  for (const pa of currentPreset.params) {
    const m = text.match(new RegExp(`"@param:${reEsc(pa.name)}"\\s*:\\s*(-?[\\d.]+)`));
    if (m) pa.value = Number(m[1]);
  }
  for (const f of currentPreset.fills) {
    const m = text.match(new RegExp(`【填空:${reEsc(f.name)}=([^】]*)】`));
    if (m) f.value = m[1];
  }
  renderPresetDetail();
  renderPresetList();
}

function renderPresetDetail() {
  const p = currentPreset;
  $('presetDetail').className = p ? 'preset-detail' : 'preset-detail hidden';
  if (!p) return;
  $('presetTitle').textContent = p.title;
  $('presetStar').textContent = p.starred ? '★ 已收藏' : '☆ 收藏';
  $('presetDelete').style.display = p.factory ? 'none' : 'inline';
  $('paramList').innerHTML = p.params.map((pa, i) => `
    <div class="param">
      <div class="slider-row">
        <span class="small slider-label" title="${esc(pa.desc)}">${esc(pa.name)}</span>
        <sp-slider min="0" max="1" step="0.05" value="${pa.value}" data-param="${i}"></sp-slider>
        <span class="small slider-val" id="pv${i}">${pa.value}</span>
      </div>
      ${pa.desc ? `<div class="param-desc">${esc(pa.desc)}</div>` : ''}
    </div>`).join('');
  for (const el of $('paramList').querySelectorAll('[data-param]')) {
    const i = Number(el.getAttribute('data-param'));
    el.addEventListener('input', () => setParam(i, el.value));
    el.addEventListener('change', () => { setParam(i, el.value); savePrefs(); });
  }
  $('fillList').innerHTML = p.fills.map((f, i) => `
    <div class="fill"><label class="lbl">${esc(f.name)}</label><input type="text" data-fill="${i}" value="${esc(f.value)}"></div>`).join('');
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 滑杆和填空直接改提示词框里的文字，用户看到的就是要发出去的
function setParam(i, value) {
  const pa = currentPreset.params[i];
  pa.value = Math.round(Number(value) * 100) / 100;
  $(`pv${i}`).textContent = String(pa.value);
  const re = new RegExp(`("@param:${reEsc(pa.name)}"\\s*:\\s*)(-?[\\d.]+)`, 'g');
  $('prompt').value = $('prompt').value.replace(re, `$1${pa.value}`);
}
function setFill(i, value) {
  const f = currentPreset.fills[i];
  f.value = value;
  const re = new RegExp(`【填空:${reEsc(f.name)}(?:=[^】]*)?】`, 'g');
  $('prompt').value = $('prompt').value.replace(re, `【填空:${f.name}=${value.replace(/】/g, '')}】`);
}

// 发送前整理提示词（同 V6 sanitizePrompt）：【填空:名=值】换成值；某个 MODULE 块里有数值参数为 0 就整块删掉
function sanitizePrompt(raw) {
  let text = raw || '';
  const first = {};
  text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, (m, name, val) => { if (!(name in first)) first[name] = val != null ? val : ''; return m; });
  text = text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, (m, name, val) => (name in first ? first[name] : (val != null ? val : '')));
  if (text.indexOf('// MODULE_START:') === -1) return text;
  return text.replace(/\/\/ MODULE_START:(\w+)[\s\S]*?\/\/ MODULE_END:\1/g, (block) => {
    const re = /@param:([^"]+)"\s*:\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      if (/_(?:desc|label|note|range)$/.test(m[1])) continue;
      if (parseFloat(m[2]) === 0) return '';
    }
    return block;
  });
}

// raw / keep 不传时用面板上的提示词和「保持构图」；桌面端发来的生成用它自己的
function buildPrompt(hasImage, refCount, raw = $('prompt').value, keep = $('keepComposition').checked) {
  let text = sanitizePrompt(raw.trim());
  if (refCount) {
    const range = refCount > 1 ? `图2到图${refCount + 1}` : '图2';
    text = hasImage
      ? `【图片说明】图1是需要修改的原图，构图、取景和人物位置以图1为准；${range}是参考图，只按下面提示词里说的内容参考。\n\n${text}`
      : `【图片说明】附带的 ${refCount} 张图都是参考图。\n\n${text}`;
  }
  if (hasImage && keep) text += KEEP_COMPOSITION;
  return text;
}

async function savePresetNow() {
  const title = $('saveName').value.trim();
  if (!title) return hint('先给预设起个名字', true);
  const body = { title, category: $('saveCat').value, content: $('prompt').value };
  if (currentPreset && !currentPreset.factory && currentPreset.title === title) body.id = currentPreset.id;
  const r = await post('/presets', body);
  const d = await r.json();
  if (!r.ok) return hint(d.error || '保存失败', true);
  $('saveRow').className = 'save-row hidden';
  hint(`已存为预设「${title}」`);
  await loadPresets();
  await selectPreset(d.id);
}

// ---------- 几何 ----------
const ratioOf = (a) => { const [w, h] = a.split(':').map(Number); return w / h; };
function nearestAspect(ratio, list) {
  let best = list[0];
  for (const a of list) if (Math.abs(Math.log(ratioOf(a) / ratio)) < Math.abs(Math.log(ratioOf(best) / ratio))) best = a;
  return best;
}
function padRect(r, pct, docW, docH) {
  if (!pct) return r;
  const dx = ((r.right - r.left) * pct) / 200;
  const dy = ((r.bottom - r.top) * pct) / 200;
  return { left: Math.max(0, r.left - dx), top: Math.max(0, r.top - dy), right: Math.min(docW, r.right + dx), bottom: Math.min(docH, r.bottom + dy) };
}
// 把区域补成目标比例：以原区域为中心向外扩，尽量留在画布内；模型按这个比例出图，贴回时就能一一对应
function fitRect(r, ratio, docW, docH) {
  let w = r.right - r.left;
  let h = r.bottom - r.top;
  if (w / h < ratio) w = h * ratio; else h = w / ratio;
  w = Math.round(w);
  h = Math.round(h);
  let left = Math.round((r.left + r.right) / 2 - w / 2);
  let top = Math.round((r.top + r.bottom) / 2 - h / 2);
  if (w <= docW) left = Math.min(Math.max(left, 0), docW - w);
  if (h <= docH) top = Math.min(Math.max(top, 0), docH - h);
  return { left, top, right: left + w, bottom: top + h };
}
async function selectionBounds(docId) {
  const r = await bp({ _obj: 'get', _target: [{ _property: 'selection' }, { _ref: 'document', _id: docId }] });
  const s = r[0] && r[0].selection;
  if (!s || s.top === undefined) return null;
  const v = (x) => (typeof x === 'object' ? x._value : x);
  const b = { left: v(s.left), top: v(s.top), right: v(s.right), bottom: v(s.bottom) };
  return b.right > b.left && b.bottom > b.top ? b : null;
}

// ---------- 导出 ----------
async function exportRegion(doc, rect, mode, maxSide, file) {
  let tmp = null;
  try {
    if (mode === 'visible') {
      tmp = await doc.duplicate('ai-export', true); // 只含合并后的可见内容
    } else {
      // 图层 → 复制图层 → 新建文档（画布和原图一样大，位置不变）
      await bp({ _obj: 'make', _target: [{ _ref: 'document' }], name: 'ai-export', using: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }, version: 5 });
      tmp = app.activeDocument;
    }
    await tmp.crop({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    await tmp.flatten();
    if (tmp.mode !== constants.DocumentMode.RGB) await tmp.changeMode(constants.ChangeMode.RGB);
    if (tmp.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) await bp({ _obj: 'convertMode', depth: 8, merge: false });
    try { await tmp.convertProfile('sRGB IEC61966-2.1', constants.Intent.RELATIVECOLORIMETRIC, true, false); } catch {}
    const w = tmp.width;
    const h = tmp.height;
    if (Math.max(w, h) > maxSide) {
      const k = maxSide / Math.max(w, h);
      await tmp.resizeImage(Math.round(w * k), Math.round(h * k));
    }
    await tmp.saveAs.jpg(file, { quality: 12 }, true);
  } finally {
    if (tmp) { try { await tmp.closeWithoutSaving(); } catch {} }
    if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
  }
}

async function uploadBytes(bytes, type) {
  const up = await fetch(`${HELPER}/uploads`, { method: 'POST', headers: { ...HEADERS, 'content-type': type || 'image/jpeg' }, body: bytes });
  const u = await up.json();
  if (!up.ok) throw new Error(u.error || '上传失败');
  return u.uploadId;
}

async function tempFile(name) {
  const folder = await lfs.getTemporaryFolder();
  return folder.createFile(name, { overwrite: true });
}

// 记下当前文档、区域、选区（存成临时 Alpha 通道），并导出要发送的画面
async function capture(opts) {
  return core.executeAsModal(async (ctl) => {
    const doc = app.activeDocument;
    if (!doc) throw new Error('先打开一张图');
    const docW = doc.width;
    const docH = doc.height;
    const sel = await selectionBounds(doc.id);
    const layer = doc.activeLayers[0];
    let mode = opts.source;
    if (mode === 'auto') mode = sel ? 'visible' : 'layer';
    if (mode === 'layer' && !layer) throw new Error('没有选中的图层');

    let base = sel;
    if (!base && mode === 'layer') {
      const b = layer.boundsNoEffects;
      if (b.right > b.left && b.bottom > b.top) base = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    if (!base) base = { left: 0, top: 0, right: docW, bottom: docH };
    base = padRect(base, opts.padding, docW, docH);

    const aspect = opts.aspect === 'auto' ? nearestAspect((base.right - base.left) / (base.bottom - base.top), opts.aspects) : opts.aspect;
    const rect = fitRect(base, ratioOf(aspect), docW, docH);
    const W = rect.right - rect.left;
    const H = rect.bottom - rect.top;
    const focus = sel ? {
      x0: Math.max(0, (sel.left - rect.left) / W), y0: Math.max(0, (sel.top - rect.top) / H),
      x1: Math.min(1, (sel.right - rect.left) / W), y1: Math.min(1, (sel.bottom - rect.top) / H),
    } : null;

    let chanName = null;
    if (sel && opts.maskWithSelection) {
      chanName = `AI选区 ${Date.now().toString(36)}（贴回后自动删除）`;
      const hid = await ctl.hostControl.suspendHistory({ documentID: doc.id, name: 'AI 生图：记录选区' });
      await bp({ _obj: 'duplicate', _target: [{ _ref: 'channel', _property: 'selection' }], name: chanName });
      await ctl.hostControl.resumeHistory(hid);
    }

    let bytes = null;
    if (mode !== 'none') {
      const file = await tempFile(`ai-export-${Date.now()}.jpg`);
      await exportRegion(doc, rect, mode, opts.maxSide, file);
      bytes = await file.read({ format: formats.binary });
      try { await file.delete(); } catch {}
    }
    return { docId: doc.id, docName: doc.title, layerId: layer ? layer.id : null, rect, focus, aspect, chanName, bytes, selShort: sel ? Math.min(sel.right - sel.left, sel.bottom - sel.top) : Math.min(W, H) };
  }, { commandName: 'AI 生图：导出区域' });
}

// ---------- 参考图 ----------
function renderRefs() {
  $('refCount').textContent = `${refs.length}/${MAX_REFS}`;
  $('refEmpty').style.display = refs.length ? 'none' : 'block';
  $('refList').innerHTML = refs.map((r, i) => `
    <div class="ref"><img src="${HELPER}/uploads/${r.uploadId}"><a class="ref-x" data-ref="${i}">×</a><span class="ref-n">图${i + 2}</span></div>`).join('');
}

async function addRefFromSelection() {
  if (refs.length >= MAX_REFS) return hint(`参考图最多 ${MAX_REFS} 张`, true);
  try {
    const bytes = await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) throw new Error('先打开一张图');
      const sel = await selectionBounds(doc.id);
      if (!sel) throw new Error('先在 PS 里框出要当参考的地方');
      const file = await tempFile(`ai-ref-${Date.now()}.jpg`);
      await exportRegion(doc, sel, 'visible', 1536, file);
      const b = await file.read({ format: formats.binary });
      try { await file.delete(); } catch {}
      return b;
    }, { commandName: 'AI 生图：抓参考图' });
    refs.push({ uploadId: await uploadBytes(bytes) });
    renderRefs();
    hint('已加参考图（图2 起是参考图）');
  } catch (e) {
    hint(errText(e), true);
    remoteLog(e.stack || '', 'error');
  }
}

// 本地图片当参考图：UXP 只把路径交给 helper，由它读图、按 EXIF 摆正、缩到 2048
async function addRefPaths(paths) {
  const room = MAX_REFS - refs.length;
  if (room <= 0) return hint(`参考图最多 ${MAX_REFS} 张`, true);
  for (const p of paths.slice(0, room)) {
    const r = await post('/uploads/from-file', { path: p, maxSide: 2048 });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '读不了这张图');
    refs.push({ uploadId: d.uploadId });
  }
  renderRefs();
  hint(paths.length > room ? `参考图最多 ${MAX_REFS} 张，只加了前 ${room} 张` : `已加 ${paths.length} 张参考图`);
}

async function addRefFromFile() {
  if (refs.length >= MAX_REFS) return hint(`参考图最多 ${MAX_REFS} 张`, true);
  try {
    const picked = await lfs.getFileForOpening({ allowMultiple: true, types: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'] });
    const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
    const paths = files.map((f) => f.nativePath).filter(Boolean);
    if (paths.length) await addRefPaths(paths);
  } catch (e) {
    hint(errText(e), true);
  }
}

// 从访达 / 资源管理器拖进来：Photoshop 2026 起 drop 事件里有 dataTransfer.uxpEntries（带 nativePath），旧版本没有
function bindRefDrop() {
  const box = $('refDrop');
  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    box.classList.add('over');
  });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const entries = [...((e.dataTransfer && e.dataTransfer.uxpEntries) || [])];
    const paths = entries.filter((x) => x.isFile !== false).map((x) => x.nativePath).filter(Boolean);
    if (!paths.length) return hint('这版 Photoshop 不支持把文件拖进面板，点「上传图片」选文件', true);
    addRefPaths(paths).catch((err) => hint(errText(err), true));
  });
}

async function addRefFromScreenshot() {
  if (refs.length >= MAX_REFS) return hint(`参考图最多 ${MAX_REFS} 张`, true);
  hint('拖一个框截图，按 Esc 取消');
  try {
    const r = await post('/screenshot');
    const d = await r.json();
    if (d.cancelled) return hint('已取消截图');
    if (!r.ok) throw new Error(d.error || '截图失败');
    refs.push({ uploadId: d.uploadId });
    renderRefs();
    hint('已加截图参考图');
  } catch (e) {
    hint(errText(e), true);
  }
}

// ---------- 贴回：生成组 ----------
const findLayer = (doc, id) => {
  const walk = (layers) => {
    for (const l of layers) {
      if (l.id === id) return l;
      if (l.layers) { const f = walk(l.layers); if (f) return f; }
    }
    return null;
  };
  return id ? walk(doc.layers) : null;
};

// 取某个版本的结果：校色 × 替换纹理 × 强度（插帧），helper 按需算好缓存
// 卡片上改的强度/校色/纹理只是「预选」（g.cc / g.tex / g.strength），点「应用」后才写进 g.applied 并贴到 PS
const appliedOf = (g) => g.applied || { cc: g.cc || 'none', tex: false, strength: 100 };
const variantKey = (v) => `${v.cc}|${v.tex ? 1 : 0}|${v.strength == null ? 100 : v.strength}`;
async function writeResult(job, v) {
  const t = (v.strength == null ? 100 : v.strength) / 100;
  const r = await fetch(`${HELPER}/jobs/${job.id}/result?cc=${v.cc}&tex=${v.tex ? 1 : 0}&t=${t}`);
  if (!r.ok) throw new Error(`取结果失败：${r.status}`);
  const ext = r.headers.get('x-result-ext') || 'jpg';
  const file = await tempFile(`ai-result-${job.id}-${Date.now()}.${ext}`);
  await file.write(await r.arrayBuffer(), { format: formats.binary });
  return file;
}

async function restoreSelectionAfter(fn) {
  const TMP = '__ai_bridge_tmp_sel';
  const doc = app.activeDocument;
  const hadSel = Boolean(await selectionBounds(doc.id));
  if (hadSel) await bp({ _obj: 'duplicate', _target: [{ _ref: 'channel', _property: 'selection' }], name: TMP });
  try {
    await fn();
  } finally {
    if (hadSel) {
      await bp({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _ref: 'channel', _name: TMP } }).catch(() => {});
      await bp({ _obj: 'delete', _target: [{ _ref: 'channel', _name: TMP }] }).catch(() => {});
    } else {
      await bp({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }).catch(() => {});
    }
  }
}

// 组：所有备选结果放在一个图层组里，蒙版（收缩 + 羽化）加在组上，切换哪张只是改显示
async function ensureGroup(g, doc) {
  const existing = findLayer(doc, g.psGroupId);
  if (existing) return existing;
  if (g.layerId) await bp({ _obj: 'select', _target: [{ _ref: 'layer', _id: g.layerId }], makeVisible: false }).catch(() => {});
  const grp = await doc.createLayerGroup({ name: `AI 生成组 · ${g.title}` });
  g.psGroupId = grp.id;
  // 选中的是图层组时，新组会被建到那个组里面；统一挪到原图层上方、同一层级。
  // 原图层上方已经有之前的 AI 生成组时，放到它们最上面，新结果不会被旧的盖住
  let source = findLayer(doc, g.layerId);
  // 当前选中的是上一次贴回的结果（在某个 AI 生成组里）：以那个组为准，不要套进去
  while (source && source.parent && /^AI 生成组 · /.test(source.parent.name)) source = source.parent;
  if (source && source.id !== grp.id) {
    const siblings = [...(source.parent ? source.parent.layers : doc.layers)].filter((l) => l.id !== grp.id);
    let i = siblings.findIndex((l) => l.id === source.id);
    let target = source;
    while (i > 0 && /^AI 生成组 · /.test(siblings[i - 1].name)) target = siblings[--i];
    // layer.move 是同步的、不返回 Promise，不能接 .catch
    try { await grp.move(target, constants.ElementPlacement.PLACEBEFORE); } catch {}
  }
  if (g.color && g.color !== 'none') {
    await bp({ _obj: 'set', _target: [{ _ref: 'layer', _id: grp.id }], to: { _obj: 'layer', color: { _enum: 'color', _value: g.color } } }).catch(() => {});
  }
  if (g.chanName) {
    await bp({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _ref: 'channel', _name: g.chanName } });
    const contractPx = Math.round((g.selShort * g.shrink) / 100);
    if (contractPx > 0) await bp({ _obj: 'contract', by: { _unit: 'pixelsUnit', _value: contractPx } }).catch(() => {});
    await bp({ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealSelection' } });
    const blurPx = (g.selShort * g.blur) / 100;
    if (blurPx > 0.5) {
      await bp({ _obj: 'select', _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }], makeVisible: false });
      await bp({ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: blurPx } });
      await bp({ _obj: 'select', _target: [{ _ref: 'channel', _enum: 'channel', _value: 'RGB' }], makeVisible: false }).catch(() => {});
    }
  }
  return grp;
}

// 把一张结果放进组里、摆到原区域（helper 已经把回图对齐到原图画框，这里直接铺满区域）
async function placeFileInGroup(g, doc, file, name, below) {
  const grp = await ensureGroup(g, doc);
  await bp({ _obj: 'select', _target: [{ _ref: 'layer', _id: below || grp.id }], makeVisible: false });
  await bp({
    _obj: 'placeEvent',
    null: { _path: lfs.createSessionToken(file), _kind: 'local' },
    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
    offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 0 }, vertical: { _unit: 'pixelsUnit', _value: 0 } },
  });
  const layer = doc.activeLayers[0];
  if (!layer.parent || layer.parent.id !== grp.id) await layer.move(grp, constants.ElementPlacement.PLACEINSIDE);
  const R = g.rect;
  let b = layer.boundsNoEffects;
  await layer.scale(((R.right - R.left) / (b.right - b.left)) * 100, ((R.bottom - R.top) / (b.bottom - b.top)) * 100, constants.AnchorPosition.TOPLEFT);
  b = layer.boundsNoEffects;
  await layer.translate(R.left - b.left, R.top - b.top);
  layer.name = name;
  if (g.raster) { try { await layer.rasterize(); } catch {} }
  return layer;
}

async function placeJob(g, job) {
  const v = appliedOf(g);
  const file = await writeResult(job, v);
  await core.executeAsModal(async (ctl) => {
    const doc = app.documents.find((d) => d.id === g.docId);
    if (!doc) throw new Error('原文档已经关闭，结果在 helper 控制台里');
    if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
    const hid = await ctl.hostControl.suspendHistory({ documentID: doc.id, name: 'AI 生图贴回' });
    try {
      await restoreSelectionAfter(async () => {
        const idx = g.jobs.indexOf(job) + 1;
        const layer = await placeFileInGroup(g, doc, file, `#${idx} · ${job.providerLabel || g.providerLabel}`);
        job.layerId = layer.id;
        if (!g.selected) g.selected = job.id;
        layer.visible = g.selected === job.id;
      });
    } finally {
      await ctl.hostControl.resumeHistory(hid);
    }
  }, { commandName: 'AI 生图贴回' });
  try { await file.delete(); } catch {}
  job.placed = true;
  job.appliedKey = variantKey(v);
}

// 校色 / 替换纹理 / 强度变了：智能对象就替换内容（位置、蒙版不动），普通图层就重新贴一张替换掉
async function applyVariant(g, job, v = appliedOf(g)) {
  if (!job || !job.placed || !job.layerId || job.appliedKey === variantKey(v)) return;
  const key = variantKey(v);
  hint('正在应用…');
  const file = await writeResult(job, v);
  await core.executeAsModal(async (ctl) => {
    const doc = app.documents.find((d) => d.id === g.docId);
    const old = doc && findLayer(doc, job.layerId);
    if (!old) return;
    if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
    const hid = await ctl.hostControl.suspendHistory({ documentID: doc.id, name: 'AI 生图：调整结果' });
    try {
      if (old.kind === constants.LayerKind.SMARTOBJECT) {
        await bp({ _obj: 'select', _target: [{ _ref: 'layer', _id: job.layerId }], makeVisible: false });
        await bp({ _obj: 'placedLayerReplaceContents', null: { _path: lfs.createSessionToken(file), _kind: 'local' } });
      } else {
        await restoreSelectionAfter(async () => {
          const layer = await placeFileInGroup(g, doc, file, old.name, job.layerId);
          layer.visible = old.visible;
          await old.delete();
          job.layerId = layer.id;
        });
      }
    } finally {
      await ctl.hostControl.resumeHistory(hid);
    }
  }, { commandName: 'AI 生图：调整结果' });
  try { await file.delete(); } catch {}
  job.appliedKey = key;
  const parts = [CC_LABELS[v.cc], v.tex ? '替换纹理' : '', `强度 ${v.strength == null ? 100 : v.strength}%`].filter(Boolean);
  hint(`已应用：${parts.join(' · ')}`);
}

// 「应用」：把预选的设置贴到当前选中的那张
async function commitGroup(g) {
  const v = { cc: g.cc, tex: Boolean(g.tex), strength: g.strength == null ? 100 : g.strength };
  try {
    await applyVariant(g, selectedJob(g), v);
    g.applied = v;
  } catch (e) {
    hint(errText(e), true);
  }
  renderGroups();
  saveGroups();
}

async function dropChannelIfDone(g) {
  if (!g.chanName || g.jobs.some((j) => j.status !== 'error' && !j.placed)) return;
  const name = g.chanName;
  g.chanName = null;
  await core.executeAsModal(async () => {
    const doc = app.documents.find((d) => d.id === g.docId);
    if (!doc) return;
    if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
    await bp({ _obj: 'delete', _target: [{ _ref: 'channel', _name: name }] }).catch(() => {});
  }, { commandName: 'AI 生图：清理选区通道' }).catch(() => {});
}

// 点缩略图：选这一张（没传回的先传回），只显示它，并按当前校色/强度更新
async function selectVariant(g, jobId) {
  const job = g.jobs.find((j) => j.id === jobId);
  if (!job || job.status !== 'done') return;
  g.selected = jobId;
  try {
    if (!job.placed) {
      job.placeError = null;
      try { await placeJob(g, job); } catch (e) { job.placeError = `贴回失败：${errText(e)}（点缩略图重试）`; throw e; }
    }
    await core.executeAsModal(async () => {
      const doc = app.documents.find((d) => d.id === g.docId);
      if (!doc) return;
      for (const j of g.jobs) {
        const l = findLayer(doc, j.layerId);
        if (l) l.visible = j.id === jobId;
      }
    }, { commandName: 'AI 生图：换一张' });
    await applyVariant(g, job);
  } catch (e) {
    hint(errText(e), true);
  }
  renderGroups();
  saveGroups();
}

// 双击缩略图：切到这一组所在的文档并选中这张的图层
async function revealVariant(g, jobId) {
  const job = g.jobs.find((j) => j.id === jobId);
  await core.executeAsModal(async () => {
    const doc = app.documents.find((d) => d.id === g.docId);
    if (!doc) throw new Error('原文档已经关闭');
    app.activeDocument = doc;
    if (job && job.layerId) await bp({ _obj: 'select', _target: [{ _ref: 'layer', _id: job.layerId }], makeVisible: false }).catch(() => {});
  }, { commandName: 'AI 生图：跳到文档' }).catch((e) => hint(errText(e), true));
}

const selectedJob = (g) => g.jobs.find((j) => j.id === g.selected);

// 组标题显示实际出图的平台：失败自动换平台后，和提交时选的不一样
function groupProviderText(g) {
  const used = [...new Set(g.jobs.map((j) => j.providerLabel).filter(Boolean))];
  if (!used.length || (used.length === 1 && used[0] === g.providerLabel)) return g.providerLabel;
  if (!used.includes(g.providerLabel)) return `${used.join(' / ')}（${g.providerLabel} 失败后换的）`;
  return `${used.join(' / ')}（部分换了平台）`;
}

// ---------- 生成组卡片 ----------
function renderGroups() {
  if ($('groups').querySelector('.dd.open')) { groupsRenderPending = true; return; }
  $('groups').innerHTML = groups.map((g) => {
    const thumbs = g.jobs.map((j, i) => {
      const sel = g.selected === j.id ? ' selected' : '';
      if (j.status === 'done') return `<div class="thumb${sel}${j.placed ? '' : ' unplaced'}" data-g="${g.id}" data-j="${j.id}" title="${esc(j.providerLabel || g.providerLabel)} · 单击用这张，双击跳到文档"><img src="${HELPER}/jobs/${j.id}/thumb"><span class="tn">${i + 1}</span>${j.placed ? '' : `<span class="tstat">${j.placeError ? '点击重试' : '点击传回'}</span>`}</div>`;
      const text = j.status === 'error' ? '失败' : (j.stage || '排队中').replace(/^生成中…\s*/, '');
      return `<div class="thumb pending${j.status === 'error' ? ' err' : ''}" title="${esc(j.error || j.stage || '')}"><span class="tn">${i + 1}</span><span class="tstat">${esc(text.slice(0, 14))}</span></div>`;
    }).join('');
    const doneN = g.jobs.filter((j) => j.status === 'done').length;
    const errs = g.jobs.map((j) => (j.status === 'error' ? j.error : j.placeError)).filter(Boolean);
    const cc = Object.entries(CC_LABELS).map(([k, v]) => `<div data-v="${k}"${k === g.cc ? ' data-sel' : ''}>${v}</div>`).join('');
    const st = g.strength == null ? 100 : g.strength;
    const dirty = variantKey({ cc: g.cc, tex: g.tex, strength: st }) !== variantKey(appliedOf(g));
    return `<div class="group">
      <div class="job-top"><span class="small">${esc(groupProviderText(g))} · ${g.aspect}${g.resolution ? ' · ' + g.resolution : ''} · ${doneN}/${g.jobs.length}</span><span class="small">${esc(g.docName)}</span></div>
      <div class="job-prompt">${esc(g.title)}</div>
      <div class="thumbs">${thumbs}</div>
      ${errs.length ? `<div class="job-stage error">${esc(errs[0])}</div>` : ''}
      <div class="slider-row"><span class="small slider-label">强度</span><sp-slider min="0" max="100" step="5" value="${st}" data-strength="${g.id}"></sp-slider><span class="small slider-val">${st}%</span></div>
      <div class="job-actions">
        <div class="dd cc-select" data-cc="${g.id}">${cc}</div>
        <input type="checkbox" data-tex="${g.id}"${g.tex ? ' checked' : ''}><span class="small tex-label">替换纹理</span>
      </div>
      <div class="job-actions">
        <button class="apply-btn" data-act="apply" data-g="${g.id}"${dirty ? '' : ' disabled'}>${dirty ? '应用' : '已应用'}</button>
        <a data-act="cancel" data-g="${g.id}">取消</a>
        <a data-act="remove" data-g="${g.id}">移除卡片</a>
      </div>
    </div>`;
  }).join('');
  bindGroupControls();
}

function bindGroupControls() {
  for (const el of $('groups').querySelectorAll('.dd')) initDropdown(el);
  for (const el of $('groups').querySelectorAll('[data-strength], [data-cc], [data-tex]')) {
    const g = groups.find((x) => x.id === (el.getAttribute('data-strength') || el.getAttribute('data-cc') || el.getAttribute('data-tex')));
    if (!g) continue;
    if (el.getAttribute('data-strength')) {
      el.addEventListener('input', () => { el.nextElementSibling.textContent = `${Math.round(el.value)}%`; });
    }
    el.addEventListener('change', () => {
      if (el.getAttribute('data-strength')) g.strength = Math.round(Number(el.value));
      if (el.getAttribute('data-cc')) g.cc = el.value;
      if (el.getAttribute('data-tex')) g.tex = el.checked;
      renderGroups();
      saveGroups();
    });
  }
}

async function pollGroups() {
  for (const g of groups) {
    for (const job of g.jobs) {
      if (job.placed || job.status === 'error' || job.polling) continue;
      if (job.status === 'done' && !g.autoReturn) continue; // 不自动传回：等用户点缩略图
      job.polling = true;
      try {
        if (job.status !== 'done') {
          const s = await (await fetch(`${HELPER}/jobs/${job.id}`)).json();
          job.stage = s.stage;
          job.status = s.status;
          job.error = s.error;
          job.providerLabel = (health && health.providers[s.provider] || {}).label || s.provider;
        }
        if (job.status === 'done' && !job.placed && g.autoReturn && !job.placeError) {
          try {
            await placeJob(g, job);
          } catch (err) {
            // 图已经生成好了，只是贴回没成功：保留结果，点缩略图可以再贴一次
            job.placeError = `贴回失败：${errText(err)}（点缩略图重试）`;
            remoteLog(`贴回失败 ${job.id}：${errText(err)}\n${(err && err.stack) || ''}`, 'error');
          }
        }
        if (job.status === 'done' || job.status === 'error') await dropChannelIfDone(g);
      } catch {
        job.stage = 'helper 连接中断，重试中…';
      } finally {
        job.polling = false;
      }
      renderGroups();
      saveGroups();
    }
  }
}

async function onGroupsClick(e) {
  const t = e.target;
  const thumb = t.closest ? t.closest('.thumb') : null;
  const gid = (thumb || t).getAttribute && (thumb || t).getAttribute('data-g');
  const g = groups.find((x) => x.id === gid);
  if (!g) return;
  if (thumb && thumb.getAttribute('data-j')) return selectVariant(g, thumb.getAttribute('data-j'));
  const act = t.getAttribute('data-act');
  if (act === 'apply') return commitGroup(g);
  if (act === 'cancel') {
    for (const j of g.jobs) if (j.status === 'queued' || j.status === 'running') await post(`/jobs/${j.id}/cancel`).catch(() => {});
  } else if (act === 'remove') {
    groups.splice(groups.indexOf(g), 1);
    renderGroups();
    saveGroups();
  }
}

// ---------- 历史（检查点） ----------
async function renderHistory() {
  if (!historyOpen) { $('history').className = 'hidden'; return; }
  $('history').className = 'history';
  const d = await (await fetch(`${HELPER}/jobs`)).json();
  const inPanel = new Set(groups.flatMap((g) => g.jobs.map((j) => j.id)));
  const list = d.jobs.filter((j) => j.status === 'done' && !inPanel.has(j.id)).slice(0, 40);
  $('history').innerHTML = `<div class="lbl">历史结果（helper 存的检查点，点「贴到当前选区」）</div>` + (list.length ? list.map((j) => `
    <div class="hist-item">
      <img src="${HELPER}/jobs/${j.id}/thumb">
      <div class="hist-info"><div class="small">${esc(new Date(j.createdAt).toLocaleString('zh-CN'))} · ${esc(j.provider)}</div><div class="job-prompt">${esc(j.prompt.slice(0, 60))}</div>
      <a class="small link" data-hist="${j.id}">贴到当前选区</a></div>
    </div>`).join('') : '<div class="small empty-note">没有更多历史结果</div>');
}

// 历史结果贴到当前选区（没有选区就贴到原来记下的位置/整张画布）
async function pasteHistory(jobId) {
  const s = await (await fetch(`${HELPER}/jobs/${jobId}`)).json();
  const ctx = await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error('先打开一张图');
    const sel = await selectionBounds(doc.id);
    const ratio = s.result.width / s.result.height;
    const base = sel || (s.meta && s.meta.rect && s.meta.docName === doc.title ? s.meta.rect : { left: 0, top: 0, right: doc.width, bottom: doc.height });
    return { docId: doc.id, docName: doc.title, layerId: doc.activeLayers[0] ? doc.activeLayers[0].id : null, rect: sel ? fitRect(base, ratio, doc.width, doc.height) : base };
  }, { commandName: 'AI 生图：读取位置' });
  const g = {
    id: `h${Date.now()}`, ...ctx, title: s.prompt.slice(0, 40), providerLabel: (health && health.providers[s.provider] || {}).label || s.provider, aspect: s.aspect, resolution: s.resolution,
    jobs: [{ id: s.id, status: 'done', providerLabel: (health && health.providers[s.provider] || {}).label || s.provider }], cc: s.post ? s.post.cc : 'none', tex: false, strength: 100, autoReturn: true, raster: $('returnAs').value === 'raster', color: $('groupColor').value, shrink: 0, blur: 0, selShort: 0, chanName: null,
  };
  groups.unshift(g);
  renderGroups();
  await pollGroups();
  if (g.jobs[0].placeError) throw new Error(g.jobs[0].placeError);
}

// ---------- 生成 ----------
// 面板按钮、快捷键、桌面端都走这里。o 里给了的项（桌面端发来的提示词、平台、比例、张数、参考图等）优先，
// 没给的用面板上的设置；选区、羽化、对齐、校色、贴回方式这些 PS 侧的设置总是用面板上的
async function startGeneration(o = {}) {
  if (!health) throw new Error('helper 没有运行');
  const rawPrompt = o.prompt != null ? o.prompt : $('prompt').value;
  if (!rawPrompt.trim()) throw new Error('先选预设或写提示词');
  const providerKey = o.provider || $('provider').value;
  const caps = providerCaps(providerKey);
  const resolution = caps.resolutions ? (o.resolution || $('resolution').value) : '';
  const count = Number(o.count || $('count').value) || 1;
  const refIds = o.refUploadIds || refs.map((r) => r.uploadId);
  hint('正在导出区域…');
  const ctx = await capture({
    source: $('source').value,
    aspect: o.aspect || $('aspect').value,
    aspects: caps.aspects || ['1:1'],
    padding: Number($('padding').value) || 0,
    maskWithSelection: $('maskWithSelection').checked,
    maxSide: resolution === '4K' ? 3072 : 2048,
  });
  const uploadId = ctx.bytes ? await uploadBytes(ctx.bytes) : undefined;
  const useFallback = o.fallback != null ? o.fallback : $('fallback').checked;
  const fallbacks = useFallback
    ? Object.entries(health.providers).filter(([k, p]) => k !== providerKey && p.available && !/api$/.test(k)).map(([k]) => k)
    : [];
  // 组名用预设名（调过参数也算这个预设），没有预设就用提示词开头
  const title = (o.title || (o.prompt == null && currentPreset ? currentPreset.title : rawPrompt.replace(/\s+/g, ' '))).slice(0, 40);
  const g = {
    id: `g${Date.now()}`, docId: ctx.docId, docName: ctx.docName, layerId: ctx.layerId, rect: ctx.rect, chanName: ctx.chanName,
    selShort: ctx.selShort, shrink: Number($('shrink').value), blur: Number($('blur').value), cc: $('cc').value,
    tex: $('tex').checked, strength: 100, autoReturn: $('autoReturn').checked, raster: $('returnAs').value === 'raster', color: $('groupColor').value,
    title, providerLabel: (health.providers[providerKey] || {}).label || providerKey, aspect: ctx.aspect, resolution, jobs: [],
  };
  const body = {
    provider: providerKey,
    model: caps.models ? (o.model || $('model').value) : '',
    prompt: buildPrompt(Boolean(ctx.bytes), refIds.length, rawPrompt, o.keepComposition != null ? o.keepComposition : $('keepComposition').checked),
    aspect: ctx.aspect,
    resolution: resolution || '2K',
    thinking: caps.thinking ? (o.thinking || $('thinking').value) : 'High',
    uploadId,
    refUploadIds: refIds,
    fallbacks,
    post: { align: $('align').checked, cc: $('cc').value },
    groupId: g.id,
    meta: { docName: ctx.docName, rect: ctx.rect, focus: ctx.focus, title, origin: o.origin || 'ps' },
  };
  for (let i = 0; i < count; i++) {
    const r = await post('/jobs', { ...body, sound: $('sound').checked && i === count - 1 });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '创建任务失败');
    g.jobs.push({ id: j.id, status: j.status, stage: j.stage });
  }
  groups.unshift(g);
  maybeCheckpoint(ctx.docId).catch((e) => remoteLog(`检查点失败：${errText(e)}`, 'error'));
  renderGroups();
  saveGroups();
  return { groupId: g.id, jobIds: g.jobs.map((j) => j.id), aspect: ctx.aspect, width: ctx.rect.right - ctx.rect.left, height: ctx.rect.bottom - ctx.rect.top, docName: ctx.docName };
}

async function onGenerate() {
  savePrefs();
  hint('');
  $('generate').disabled = true;
  try {
    const r = await startGeneration();
    hint(`已提交 ${r.jobIds.length} 张：区域 ${r.width}×${r.height}，比例 ${r.aspect}。可以继续修图，出图后自动贴回。`);
  } catch (err) {
    hint(errText(err), true);
  } finally {
    $('generate').disabled = false;
  }
}

// 桌面端发来的指令（helper 转交）：用 PS 选区当原图在桌面端生成，或把桌面端里的一张结果贴到当前选区
async function runCommand(cmd) {
  let reply;
  try {
    if (cmd.type === 'generate') {
      const r = await startGeneration({ ...(cmd.options || {}), origin: 'desktop' });
      hint(`桌面端提交了 ${r.jobIds.length} 张：区域 ${r.width}×${r.height}，比例 ${r.aspect}。出图后自动贴回。`);
      reply = { ok: true, result: r };
    } else if (cmd.type === 'paste') {
      await pasteHistory(cmd.jobId);
      hint('已把桌面端选的结果贴到当前选区');
      reply = { ok: true };
    } else {
      reply = { ok: false, error: `未知指令：${cmd.type}` };
    }
  } catch (err) {
    hint(errText(err), true);
    reply = { ok: false, error: errText(err) };
  }
  await post('/bridge/result', { id: cmd.id, ...reply }).catch(() => {});
}

// 检查点：开着的话，生成时离上次超过 N 分钟就把整张画布存一张无损 PNG（helper 按容量上限自动清理旧的）
const lastCheckpoint = {};
async function maybeCheckpoint(docId) {
  const minutes = Number($('checkpointMin').value) || 0;
  if (!minutes || (lastCheckpoint[docId] && Date.now() - lastCheckpoint[docId] < minutes * 60000)) return;
  lastCheckpoint[docId] = Date.now();
  const { bytes, name } = await core.executeAsModal(async () => {
    const doc = app.documents.find((d) => d.id === docId);
    if (!doc) return {};
    const tmp = await doc.duplicate('ai-checkpoint', true);
    try {
      await tmp.flatten();
      if (tmp.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) await bp({ _obj: 'convertMode', depth: 8, merge: false });
      const file = await tempFile(`ai-checkpoint-${Date.now()}.png`);
      await tmp.saveAs.png(file, { compression: 3 }, true);
      const b = await file.read({ format: formats.binary });
      try { await file.delete(); } catch {}
      return { bytes: b, name: doc.title };
    } finally {
      try { await tmp.closeWithoutSaving(); } catch {}
      if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
    }
  }, { commandName: 'AI 生图：检查点' });
  if (!bytes) return;
  const r = await fetch(`${HELPER}/checkpoints?doc=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'image/png' }, body: bytes });
  const d = await r.json();
  if (r.ok) remoteLog(`检查点已存：${d.path}`);
}

function nextProvider() {
  if (!health) return;
  const keys = Object.entries(health.providers).filter(([, p]) => p.available).map(([k]) => k);
  const i = keys.indexOf($('provider').value);
  setSelect($('provider'), keys[(i + 1) % keys.length]);
  refreshOptions();
  savePrefs();
  hint(`平台：${health.providers[$('provider').value].label}`);
}

async function onAssist() {
  const text = $('prompt').value.trim();
  if (!text) return hint('先在提示词框里用一句话说想改什么，再点 AI 帮写', true);
  hint('AI 正在写提示词（用本机 Codex，约半分钟）…');
  $('assist').textContent = 'AI 帮写中…';
  try {
    let uploadId;
    try {
      const ctx = await capture({ source: 'auto', aspect: 'auto', aspects: ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'], padding: 0, maskWithSelection: false, maxSide: 1024 });
      if (ctx.bytes) uploadId = await uploadBytes(ctx.bytes);
    } catch {}
    const r = await post('/assist', { text, uploadId });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '帮写失败');
    $('prompt').value = d.prompt;
    currentPreset = null;
    renderPresetDetail();
    savePrefs();
    hint('提示词已写好，可以再改改');
  } catch (e) {
    hint(errText(e), true);
  } finally {
    $('assist').textContent = 'AI 帮写提示词';
  }
}

// ---------- 初始化 ----------
function bindUI() {
  for (const el of document.querySelectorAll('.dd')) initDropdown(el);
  document.addEventListener('click', (e) => { if (!(e.target.closest && e.target.closest('.dd'))) closeDropdowns(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdowns(); });
  const prefs = loadPrefs();
  if (prefs.prompt) $('prompt').value = prefs.prompt;
  for (const id of ['padding', 'source', 'count', 'cc', 'shrink', 'blur', 'returnAs', 'groupColor', 'checkpointMin']) {
    if (prefs[id] === undefined) continue;
    $(id).value = prefs[id];
  }
  if (prefs.padding === undefined) setSelect($('padding'), '10');
  if (prefs.source === undefined) setSelect($('source'), 'auto');
  if (prefs.count === undefined) setSelect($('count'), '1');
  if (prefs.cc === undefined) setSelect($('cc'), 'mixed');
  for (const id of PREF_CHECKS) if (prefs[id] === false) $(id).checked = false;
  if (prefs.tex === true) $('tex').checked = true;
  $('shrinkVal').textContent = `${Math.round($('shrink').value)}%`;
  $('blurVal').textContent = `${Math.round($('blur').value)}%`;
  try { groups = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); } catch { groups = []; }
  for (const g of groups) {
    const a = appliedOf(g); g.cc = a.cc; g.tex = a.tex; g.strength = a.strength;
    // 旧版本把「贴回失败」记成整个任务失败；结果其实还在，改回可重试
    for (const j of g.jobs) if (j.status === 'error' && /^贴回失败/.test(j.error || '')) { j.status = 'done'; j.placeError = `${j.error}（点缩略图重试）`; j.error = null; }
  }

  $('provider').addEventListener('change', () => { refreshOptions(); savePrefs(); });
  for (const id of PREF_IDS) $(id).addEventListener('change', savePrefs);
  for (const id of PREF_CHECKS) $(id).addEventListener('change', savePrefs);
  $('prompt').addEventListener('change', savePrefs);
  $('shrink').addEventListener('input', () => { $('shrinkVal').textContent = `${Math.round($('shrink').value)}%`; });
  $('blur').addEventListener('input', () => { $('blurVal').textContent = `${Math.round($('blur').value)}%`; });
  $('generate').addEventListener('click', onGenerate);

  // 预设
  $('presetSearch').addEventListener('input', renderPresetList);
  $('silhouetteLabels').addEventListener('click', (e) => {
    const cat = e.target.getAttribute && e.target.getAttribute('data-cat');
    if (cat == null) return;
    currentCat = currentCat === cat ? '' : cat;
    renderSilhouette();
    renderPresetList();
  });
  for (const chip of document.querySelectorAll('.chip')) chip.addEventListener('click', () => { currentCat = chip.getAttribute('data-cat'); renderSilhouette(); renderPresetList(); });
  $('presetList').addEventListener('click', (e) => {
    const item = e.target.closest ? e.target.closest('.preset-item') : null;
    if (item) selectPreset(item.getAttribute('data-id'));
  });

  $('fillList').addEventListener('input', (e) => { const i = e.target.getAttribute('data-fill'); if (i != null) setFill(Number(i), e.target.value); });
  $('presetStar').addEventListener('click', async () => {
    if (!currentPreset) return;
    currentPreset.starred = !currentPreset.starred;
    await post(`/presets/${encodeURIComponent(currentPreset.id)}/star`, { starred: currentPreset.starred });
    renderPresetDetail();
    await loadPresets();
  });
  $('presetDelete').addEventListener('click', async () => {
    if (!currentPreset || currentPreset.factory) return;
    if ($('presetDelete').textContent !== '确认删除？') { $('presetDelete').textContent = '确认删除？'; return; }
    await post(`/presets/${encodeURIComponent(currentPreset.id)}/delete`);
    hint(`已删除「${currentPreset.title}」（在预设文件夹的 .trash 里还能找回）`);
    currentPreset = null;
    $('presetDelete').textContent = '删除';
    renderPresetDetail();
    await loadPresets();
  });
  $('clearPrompt').addEventListener('click', () => { $('prompt').value = ''; currentPreset = null; renderPresetDetail(); renderPresetList(); savePrefs(); });
  $('openSave').addEventListener('click', () => {
    $('saveRow').className = 'save-row';
    $('saveName').value = currentPreset && !currentPreset.factory ? currentPreset.title : '';
    if (currentPreset) setSelect($('saveCat'), currentPreset.category);
  });
  $('saveBtn').addEventListener('click', savePresetNow);
  $('assist').addEventListener('click', onAssist);

  // 参考图
  $('refFile').addEventListener('click', addRefFromFile);
  bindRefDrop();
  $('refSelection').addEventListener('click', addRefFromSelection);
  $('refScreenshot').addEventListener('click', addRefFromScreenshot);
  $('refClear').addEventListener('click', () => { refs = []; renderRefs(); });
  $('refList').addEventListener('click', (e) => { const i = e.target.getAttribute && e.target.getAttribute('data-ref'); if (i != null) { refs.splice(Number(i), 1); renderRefs(); } });

  // 组卡片
  $('groups').addEventListener('click', onGroupsClick);
  $('groups').addEventListener('dblclick', (e) => {
    const thumb = e.target.closest ? e.target.closest('.thumb') : null;
    const g = thumb && groups.find((x) => x.id === thumb.getAttribute('data-g'));
    if (g) revealVariant(g, thumb.getAttribute('data-j'));
  });

  // 折叠
  for (const head of document.querySelectorAll('.section-head[data-toggle]')) {
    head.addEventListener('click', () => {
      const body = $(head.getAttribute('data-toggle'));
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });
  }
  $('toggleHistory').addEventListener('click', () => { historyOpen = !historyOpen; $('toggleHistory').textContent = historyOpen ? '收起历史' : '历史'; renderHistory(); });
  $('history').addEventListener('click', (e) => { const id = e.target.getAttribute && e.target.getAttribute('data-hist'); if (id) pasteHistory(id); });
  $('openConsole').addEventListener('click', () => hint(`在浏览器里打开 ${HELPER} 可以看所有任务、原图和结果`));
  $('openChrome').addEventListener('click', () => post('/chrome/open').catch(() => hint('helper 没有运行', true)));

  renderRefs();
  renderGroups();
}

// 快捷键命令：在「编辑 → 键盘快捷键 → 应用程序菜单 → 增效工具」里给它们设快捷键
uxp.entrypoints.setup({
  panels: { aiBridgePanel: { show() {} } },
  commands: {
    cmdGenerate: () => onGenerate(),
    cmdRefSelection: () => addRefFromSelection(),
    cmdRefScreenshot: () => addRefFromScreenshot(),
    cmdNextProvider: () => nextProvider(),
  },
});

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  initShortcuts();
  checkHelper();
  setInterval(checkHelper, 5000);
  setInterval(pollGroups, 2000);
});

// 本机快捷键：Carbon 注册，仅 PS 前台 + 面板会话在线时有效。
const shortcutSession = 'ps_' + Date.now() + '_' + Math.random().toString(36).slice(2);
let shortcutPolling = false;
let shortcutLoaded = false;
async function shortcutRequest(route, body) {
  const r = await fetch(HELPER + route, { method: body ? 'POST' : 'GET', headers: { ...HEADERS, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || '快捷键设置失败'); return data;
}
function showShortcutState(state) {
  $('shortcutStatus').textContent = !state.supported ? '此快捷键桥接目前支持 macOS' : state.error || (state.enabled ? '仅 Photoshop 前台生效 · ' + state.shortcut : '快捷键已关闭');
}
async function pollShortcut() {
  if (shortcutPolling) return;
  shortcutPolling = true;
  try {
    let doc = '';
    try { doc = app.activeDocument ? app.activeDocument.title : ''; } catch {}
    // bridge: 1 表示这个版本的面板能接收桌面端的指令（旧面板不带，桌面端会提示先更新插件）
    const state = await shortcutRequest('/shortcuts/poll', { session: shortcutSession, doc, bridge: 1 });
    if (!shortcutLoaded) { $('shortcutValue').value = state.shortcut; $('shortcutEnabled').checked = state.enabled; shortcutLoaded = true; }
    showShortcutState(state);
    // 桌面端的指令不等它做完，轮询照常继续（心跳断了快捷键会被释放）
    if (state.command) runCommand(state.command);
    if (state.fire && !$('generate').disabled) { remoteLog('快捷键已收到：' + state.shortcut); await onGenerate(); }
  } catch (e) { $('shortcutStatus').textContent = '快捷键未连接：' + e.message; }
  finally { shortcutPolling = false; }
}
function initShortcuts() {
  $('shortcutSave').addEventListener('click', async () => {
    try { const state = await shortcutRequest('/shortcuts', { shortcut: $('shortcutValue').value, enabled: $('shortcutEnabled').checked }); $('shortcutValue').value = state.shortcut; showShortcutState(state); }
    catch (e) { $('shortcutStatus').textContent = e.message; }
  });
  pollShortcut(); setInterval(pollShortcut, 300);
}
