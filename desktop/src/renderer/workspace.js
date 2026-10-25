// 工作台：在桌面端选原图、写提示词、生成，看所有结果的大图，对比「网页原图」和「贴回 PS 的版本」。
// 生成照样交给 helper（网页平台在后台的专用 Chrome 里跑）。原图选「Photoshop 选区」时由 PS 面板导出选区，出图后自动贴回。
// 预设、@param 滑杆、【填空】、提示词整理沿用插件里的做法（来自夏三七「修图轮椅 V6」，GPLv3）。

const MODEL_LABELS = { 'nano-banana-2.1': 'Nano Banana 2.1', 'nano-banana-pro': 'Nano Banana Pro（可能收费或扣点数）', 'nano-banana-2-lite': 'Nano Banana 2 Lite' };
const THINKING_LABELS = { Minimal: '最快', Medium: '中等', High: '最高' };
const KEEP_COMPOSITION = '\n\n要求：输出图片的构图、取景、比例和透视与图1完全一致，不要裁切、缩放或平移画面；提示里没提到的人物、服装、五官和光线都保持原样。';
const MAX_REFS = 4;
const PREFS_KEY = 'ps-ai-bridge-work';
const TAB_KEY = 'ps-ai-bridge-tab';

const work = {
  base: 'http://127.0.0.1:47811',
  health: null,
  ps: { psOnline: false, doc: null },
  source: 'file',
  input: null, // { uploadId, width, height, name }
  refs: [], // [{ uploadId, name }]
  categories: [],
  presets: [],
  preset: null,
  jobs: [],
  renderedKey: '',
  viewer: null, // { groupId, jobId, mode, compare, s, x, y, split }
  tabChosen: false,
};

const api = (method, path, body) => window.bridge.api(method, path, body);
const url = (path) => `${work.base}${path}`;
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } };
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      source: work.source, provider: $('provider').value, model: $('model').value, aspect: $('aspect').value,
      resolution: $('resolution').value, thinking: $('thinking').value, count: $('count').value,
      keep: $('keepComposition').checked, fallback: $('fallback').checked,
    }));
  } catch {}
}
const maxSide = () => ($('resolution').value === '4K' ? 3072 : 2048);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 顶栏标签 ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === name);
  $('tab-work').hidden = name !== 'work';
  $('tab-settings').hidden = name !== 'settings';
  try { localStorage.setItem(TAB_KEY, name); } catch {}
  if (name === 'work') refreshJobs();
}
for (const b of document.querySelectorAll('.tab-btn')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- 平台和选项 ----------
function fillSelect(sel, items, value) {
  sel.innerHTML = items.map(([v, label, disabled]) => `<option value="${esc(v)}"${disabled ? ' disabled' : ''}>${esc(label)}</option>`).join('');
  const ok = items.find(([v, , d]) => v === value && !d) || items.find(([, , d]) => !d);
  if (ok) sel.value = ok[0];
}

function fillProviders() {
  const prefs = readPrefs();
  const items = Object.entries(work.health.providers).map(([k, p]) => [k, p.available ? p.label : `${p.label}（${p.note || '不可用'}）`, !p.available]);
  fillSelect($('provider'), items, $('provider').value || prefs.provider || 'aistudio');
  refreshOptions();
}

function refreshOptions() {
  const prefs = readPrefs();
  const caps = (work.health && work.health.providers[$('provider').value]) || {};
  $('modelField').hidden = !caps.models;
  if (caps.models) fillSelect($('model'), caps.models.map((m) => [m, MODEL_LABELS[m] || m]), $('model').value || prefs.model);
  fillSelect($('aspect'), [['auto', '自动（按原图）'], ...(caps.aspects || ['1:1']).map((a) => [a, a])], $('aspect').value || prefs.aspect || 'auto');
  $('resolutionField').hidden = !caps.resolutions;
  if (caps.resolutions) fillSelect($('resolution'), caps.resolutions.map((r) => [r, r]), $('resolution').value || prefs.resolution || '2K');
  $('thinkingField').hidden = !caps.thinking;
  if (caps.thinking) fillSelect($('thinking'), caps.thinking.map((t) => [t, THINKING_LABELS[t] || t]), $('thinking').value || prefs.thinking || 'High');
}

document.addEventListener('app-state', (e) => {
  const s = e.detail;
  work.base = `http://127.0.0.1:${s.helper.port}`;
  const h = s.helper.health;
  const first = h && !work.health;
  const changed = h && work.health && JSON.stringify(Object.values(h.providers).map((p) => p.available)) !== JSON.stringify(Object.values(work.health.providers).map((p) => p.available));
  work.health = h || work.health;
  if (first || changed) fillProviders();
  if (first) loadPresets();
  if (!work.tabChosen) {
    work.tabChosen = true;
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch {}
    // 第一次用、还没装插件：先停在设置页
    showTab(saved || (s.plugin.photoshops.some((ps) => ps.installed) ? 'work' : 'settings'));
  }
});

// ---------- 原图来源 ----------
function setSource(src) {
  work.source = src;
  for (const b of $('sourceSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.source === src);
  $('inputDrop').hidden = src !== 'file';
  renderPsNote();
}

function renderPsNote() {
  const note = $('psNote');
  if (work.source === 'ps') {
    note.textContent = !work.ps.psOnline
      ? '没连上 Photoshop：打开 PS，在菜单「增效工具 → AI 生图贴回」里打开面板。'
      : !work.ps.commands
        ? 'Photoshop 里的插件是旧版本，接不了桌面端的指令：到「设置」页点「更新插件」，然后重启 Photoshop。'
        : `用 Photoshop 当前文档（${work.ps.doc || '未命名'}）的选区，没有选区时用当前图层。出图后自动贴回，羽化、校色、贴回方式用 PS 面板里的设置。`;
    note.style.color = work.ps.commands ? '' : 'var(--err)';
  } else {
    note.textContent = work.source === 'none' ? '只按提示词（和参考图）生成。' : '';
    note.style.color = '';
  }
}

function setPs(status) {
  work.ps = status;
  const el = $('psStatus');
  el.querySelector('.dot').className = `dot ${status.commands ? 'ok' : status.psOnline ? 'run' : ''}`;
  el.querySelector('span').textContent = !status.psOnline ? 'Photoshop 未连接' : status.commands ? `Photoshop · ${status.doc || '已连接'}` : 'Photoshop · 插件需要更新';
  renderPsNote();
  if (work.viewer) $('vPaste').disabled = !status.commands;
}

function setInput(r) {
  work.input = r;
  $('inputEmpty').hidden = Boolean(r);
  $('inputPreview').hidden = !r;
  if (r) {
    $('inputImg').src = url(`/uploads/${r.uploadId}`);
    $('inputMeta').textContent = `${r.name || '图片'} · ${r.width}×${r.height}`;
  }
}

const filesOf = (e) => [...(e.dataTransfer?.files || [])].map((f) => window.bridge.pathForFile(f)).filter(Boolean);

function dropTarget(el, onFiles) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const files = filesOf(e);
    if (files.length) action(() => onFiles(files));
  });
}

dropTarget($('inputDrop'), async (files) => setInput((await window.bridge.uploadFiles(files.slice(0, 1), maxSide()))[0]));
$('pickInput').addEventListener('click', () => action(async () => { const [r] = await window.bridge.pickImages(maxSide(), false); if (r) setInput(r); }));
$('pasteInput').addEventListener('click', () => action(async () => setInput(await window.bridge.uploadClipboard())));
$('clearInput').addEventListener('click', () => setInput(null));
for (const b of $('sourceSeg').querySelectorAll('button')) b.addEventListener('click', () => { setSource(b.dataset.source); savePrefs(); });
// 窗口外拖进来的图默认当原图，别让 Electron 直接打开文件
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ---------- 参考图 ----------
function renderRefs() {
  $('refs').innerHTML = work.refs.map((r, i) => `<div class="ref" title="${esc(r.name || '')}"><img src="${url(`/uploads/${r.uploadId}`)}"><span class="n">图${i + 2}</span><button class="x" data-ref="${i}">✕</button></div>`).join('')
    + (work.refs.length < MAX_REFS ? '<button class="ref-add" id="addRef">+ 添加<br>或拖进来</button>' : '');
}
async function addRefs(list) {
  for (const r of list) if (work.refs.length < MAX_REFS) work.refs.push(r);
  renderRefs();
}
$('refs').addEventListener('click', (e) => {
  const i = e.target.dataset?.ref;
  if (i != null) { work.refs.splice(Number(i), 1); renderRefs(); return; }
  if (e.target.id === 'addRef') action(async () => addRefs(await window.bridge.pickImages(maxSide(), true)));
});
dropTarget($('refs'), async (files) => addRefs(await window.bridge.uploadFiles(files.slice(0, MAX_REFS - work.refs.length), maxSide())));

// ---------- 预设 ----------
async function loadPresets() {
  try {
    const d = await api('GET', '/presets');
    work.categories = d.categories;
    work.presets = d.presets;
  } catch { return; }
  const counts = {};
  for (const p of work.presets) counts[p.category] = (counts[p.category] || 0) + 1;
  $('presetCat').innerHTML = ['<option value="">全部分类</option>', '<option value="*">★ 收藏</option>']
    .concat(work.categories.filter((c) => counts[c.id]).map((c) => `<option value="${c.id}">${esc(c.name)} ${counts[c.id]}</option>`)).join('');
  $('presetCount').textContent = `${work.presets.length} 个`;
  renderPresetList();
}

function renderPresetList() {
  const words = $('presetSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cat = $('presetCat').value;
  const list = work.presets.filter((p) => {
    if (cat === '*' && !p.starred) return false;
    if (cat && cat !== '*' && p.category !== cat) return false;
    return words.every((w) => p.keys.includes(w));
  }).slice(0, 300);
  $('presetList').innerHTML = list.length ? list.map((p) => {
    const tags = [p.paramCount ? `${p.paramCount} 参数` : '', p.fillCount ? '填空' : '', p.refCount ? '参考图' : ''].filter(Boolean).join(' · ');
    return `<div class="preset-item${work.preset?.id === p.id ? ' active' : ''}" data-id="${esc(p.id)}"><span class="star">${p.starred ? '★' : ''}</span>${esc(p.title)}<span class="tags">${esc(tags)}</span></div>`;
  }).join('') : '<div class="mute small-note" style="padding:8px">没有匹配的预设</div>';
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function selectPreset(id) {
  work.preset = await api('GET', `/presets/${encodeURIComponent(id)}`);
  $('genPrompt').value = work.preset.content;
  renderPresetDetail();
  renderPresetList();
  if (work.preset.refCount) {
    const d = await api('POST', `/presets/${encodeURIComponent(id)}/refs`);
    await addRefs((d.uploadIds || []).map((uploadId) => ({ uploadId, name: `预设「${work.preset.title}」的参考图` })));
  }
}

function renderPresetDetail() {
  const p = work.preset;
  $('presetDetail').hidden = !p;
  if (!p) return;
  $('presetTitle').textContent = p.title;
  $('paramList').innerHTML = p.params.map((pa, i) => `
    <div class="param">
      <div class="param-row"><span title="${esc(pa.desc)}">${esc(pa.name)}</span><input type="range" min="0" max="1" step="0.05" value="${pa.value}" data-param="${i}"><span id="wpv${i}">${pa.value}</span></div>
      ${pa.desc ? `<div class="param-desc">${esc(pa.desc)}</div>` : ''}
    </div>`).join('');
  $('fillList').innerHTML = p.fills.map((f, i) => `<div class="fill"><label>${esc(f.name)}</label><input type="text" data-fill="${i}" value="${esc(f.value)}"></div>`).join('');
}

// 滑杆和填空直接改提示词框里的文字，看到的就是要发出去的
function setParam(i, value) {
  const pa = work.preset.params[i];
  pa.value = Math.round(Number(value) * 100) / 100;
  $(`wpv${i}`).textContent = String(pa.value);
  const re = new RegExp(`("@param:${reEsc(pa.name)}"\\s*:\\s*)(-?[\\d.]+)`, 'g');
  $('genPrompt').value = $('genPrompt').value.replace(re, `$1${pa.value}`);
}
function setFill(i, value) {
  const f = work.preset.fills[i];
  f.value = value;
  const re = new RegExp(`【填空:${reEsc(f.name)}(?:=[^】]*)?】`, 'g');
  $('genPrompt').value = $('genPrompt').value.replace(re, `【填空:${f.name}=${value.replace(/】/g, '')}】`);
}

$('presetSearch').addEventListener('input', renderPresetList);
$('presetCat').addEventListener('change', renderPresetList);
$('presetList').addEventListener('click', (e) => {
  const item = e.target.closest('.preset-item');
  if (item) action(() => selectPreset(item.dataset.id));
});
$('presetClear').addEventListener('click', () => { work.preset = null; renderPresetDetail(); renderPresetList(); });
$('paramList').addEventListener('input', (e) => { if (e.target.dataset.param != null) setParam(Number(e.target.dataset.param), e.target.value); });
$('fillList').addEventListener('input', (e) => { if (e.target.dataset.fill != null) setFill(Number(e.target.dataset.fill), e.target.value); });

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

function buildPrompt(raw, hasImage, refCount, keep) {
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

const ratioOf = (a) => { const [w, h] = a.split(':').map(Number); return w / h; };
function nearestAspect(ratio, list) {
  let best = list[0];
  for (const a of list) if (Math.abs(Math.log(ratioOf(a) / ratio)) < Math.abs(Math.log(ratioOf(best) / ratio))) best = a;
  return best;
}

// ---------- 生成 ----------
function genHint(msg, isErr = false) {
  $('genHint').textContent = msg;
  $('genHint').className = `mute small-note${isErr ? ' err' : ''}`;
}

async function generate() {
  const h = work.health;
  if (!h) return genHint('本机服务没有运行', true);
  const raw = $('genPrompt').value;
  if (!raw.trim()) return genHint('先选预设或写提示词', true);
  const provider = $('provider').value;
  const caps = h.providers[provider] || {};
  if (!caps.available) return genHint(`${caps.label || provider} 现在不可用（${caps.note || '没有配置'}）`, true);
  const count = Number($('count').value) || 1;
  const refUploadIds = work.refs.map((r) => r.uploadId);
  const keep = $('keepComposition').checked;
  const title = (work.preset ? work.preset.title : raw.replace(/\s+/g, ' ')).slice(0, 40);
  const opts = {
    provider,
    model: caps.models ? $('model').value : '',
    resolution: caps.resolutions ? $('resolution').value : '',
    thinking: caps.thinking ? $('thinking').value : '',
    count, refUploadIds, keepComposition: keep, fallback: $('fallback').checked, title,
  };
  savePrefs();
  $('generate').disabled = true;
  try {
    if (work.source === 'ps') {
      genHint('正在让 Photoshop 导出选区…');
      const r = await api('POST', '/bridge/ps', { type: 'generate', options: { ...opts, prompt: raw, aspect: $('aspect').value } });
      genHint(`已提交 ${r.jobIds.length} 张（${r.docName}，区域 ${r.width}×${r.height}，比例 ${r.aspect}），出图后自动贴回 PS`);
    } else {
      const input = work.source === 'file' ? work.input : null;
      if (work.source === 'file' && !input) throw new Error('先拖一张图进来，或者选「不用原图」');
      const ratio = input ? input.width / input.height : 1;
      const aspect = $('aspect').value === 'auto' ? nearestAspect(ratio, caps.aspects || ['1:1']) : $('aspect').value;
      // 原图比例和出图比例基本一致时才做快速对齐，否则两张图对不上
      const align = Boolean(input) && Math.abs(Math.log(ratioOf(aspect) / ratio)) < 0.03;
      const fallbacks = opts.fallback
        ? Object.entries(h.providers).filter(([k, p]) => k !== provider && p.available && !/api$/.test(k)).map(([k]) => k)
        : [];
      const body = {
        provider, model: opts.model, prompt: buildPrompt(raw, Boolean(input), refUploadIds.length, keep), aspect,
        resolution: opts.resolution || '2K', thinking: opts.thinking || 'High', uploadId: input?.uploadId, refUploadIds, fallbacks,
        post: { align, cc: 'none' }, groupId: `d${Date.now()}`, meta: { origin: 'desktop', title, fileName: input?.name || null },
      };
      for (let i = 0; i < count; i++) await api('POST', '/jobs', body);
      genHint(`已提交 ${count} 张，比例 ${aspect}`);
    }
    refreshJobs();
  } catch (e) {
    genHint(reason(e), true);
  } finally {
    $('generate').disabled = false;
  }
}
$('generate').addEventListener('click', generate);
$('provider').addEventListener('change', () => { refreshOptions(); savePrefs(); });
for (const id of ['model', 'aspect', 'resolution', 'thinking', 'count', 'keepComposition', 'fallback']) $(id).addEventListener('change', savePrefs);

// ---------- 生成记录 ----------
const providerLabel = (k) => work.health?.providers[k]?.label || k;
const originOf = (j) => (j.meta?.origin === 'desktop' ? 'desktop' : 'ps');
const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 结构化提示词里第一个「做什么」：task / action 之类的字段，深度优先
function firstAction(o) {
  if (!o || typeof o !== 'object') return '';
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /task|action|goal|目标|任务/i.test(k)) return v;
  }
  for (const v of Object.values(o)) {
    const t = firstAction(v);
    if (t) return t;
  }
  return '';
}

// 组名：有 meta.title（预设名）用它；以前的结构化（JSON）提示词取「角色：第一个动作」；否则取提示词开头（去掉自动加的说明）
function titleOf(j) {
  if (j.meta?.title) return j.meta.title;
  const text = j.prompt.replace(/^【图片说明】[^\n]*\n\n/, '').replace(KEEP_COMPOSITION, '').trim();
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      const t = [typeof o.role === 'string' ? o.role : '', typeof o.task === 'string' ? o.task : firstAction(o)].filter(Boolean).join('：');
      if (t) return t.slice(0, 60);
    } catch {}
  }
  return text.replace(/\s+/g, ' ').slice(0, 60);
}

function groupsOf(jobs) {
  const map = new Map();
  for (const j of jobs) {
    if (!map.has(j.groupId)) map.set(j.groupId, { id: j.groupId, jobs: [] });
    map.get(j.groupId).jobs.push(j);
  }
  const groups = [...map.values()];
  for (const g of groups) g.jobs.sort((a, b) => a.createdAt - b.createdAt);
  return groups;
}

function visibleGroups() {
  const q = $('jobSearch').value.trim().toLowerCase();
  const origin = $('jobFilter').value;
  return groupsOf(work.jobs).filter((g) => {
    const j = g.jobs[0];
    if (origin && originOf(j) !== origin) return false;
    return !q || titleOf(j).toLowerCase().includes(q) || j.prompt.toLowerCase().includes(q);
  });
}

function sourceText(j) {
  const m = j.meta || {};
  if (originOf(j) === 'desktop') return m.docName ? `桌面端 · PS「${m.docName}」` : `桌面端${m.fileName ? ` · ${m.fileName}` : ''}`;
  return `PS 面板${m.docName ? ` · ${m.docName}` : ''}`;
}

function renderGroups() {
  const groups = visibleGroups();
  const key = JSON.stringify([$('jobSearch').value, $('jobFilter').value, groups.map((g) => [g.id, g.jobs.map((j) => [j.id, j.status, j.stage])])]);
  if (key === work.renderedKey) return;
  work.renderedKey = key;
  if (!groups.length) {
    $('groups').innerHTML = `<p class="mute empty">${work.jobs.length ? '没有符合条件的记录' : '还没有生成记录。左边选好原图和提示词，点「生成」。'}</p>`;
    return;
  }
  $('groups').innerHTML = groups.map((g) => {
    const j0 = g.jobs[0];
    const busy = g.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    const thumbs = g.jobs.map((j, i) => {
      if (j.status === 'done') return `<button class="thumb" data-g="${esc(g.id)}" data-j="${esc(j.id)}" title="${esc(providerLabel(j.provider))}"><img src="${url(`/jobs/${j.id}/thumb`)}" alt=""><span class="n">${i + 1}</span></button>`;
      if (j.status === 'error') return `<div class="thumb failed" title="${esc(j.error)}"><span>失败</span><small>${esc(j.error)}</small></div>`;
      return `<div class="thumb pending"><div class="spin"></div><span>${esc(j.stage || '排队中')}</span></div>`;
    }).join('');
    return `<div class="group">
      <div class="g-head"><div class="g-title" title="${esc(titleOf(j0))}">${esc(titleOf(j0))}</div>
      <div class="g-meta mute">${esc([fmtTime(j0.createdAt), providerLabel(j0.provider), sourceText(j0), j0.aspect, j0.resolution].filter(Boolean).join(' · '))}</div></div>
      <div class="g-thumbs">${thumbs}</div>
      <div class="g-actions">
        ${busy ? `<button data-cancel="${esc(g.id)}">取消</button>` : ''}
        <button data-rerun="${esc(g.id)}">重新生成</button>
      </div>
    </div>`;
  }).join('');
}

async function refreshJobs() {
  if (!work.health) return; // 本机服务还没就绪
  try {
    const [d, ps] = await Promise.all([api('GET', '/jobs'), api('GET', '/bridge/status')]);
    work.jobs = d.jobs;
    setPs(ps);
  } catch {
    setPs({ psOnline: false, doc: null });
    return;
  }
  if (!$('tab-work').hidden) renderGroups();
  if (work.viewer) renderViewer(false);
}

// 重新生成：沿用原任务的提示词、原图和参考图，新开一组（来自 PS 的任务不会自动贴回，需要的话在大图里点「贴到 PS」）
async function rerun(jobs) {
  const groupId = `d${Date.now()}`;
  for (const j of jobs) {
    await api('POST', '/jobs', {
      provider: j.provider, model: j.model, prompt: j.prompt, aspect: j.aspect, resolution: j.resolution, thinking: j.thinking,
      fromJobId: j.id, fallbacks: [], post: j.post, groupId, meta: { ...(j.meta || {}), origin: 'desktop', title: titleOf(j) },
    });
  }
  toast(`已重新提交 ${jobs.length} 张`);
  refreshJobs();
}

$('groups').addEventListener('click', (e) => {
  const thumb = e.target.closest('.thumb[data-j]');
  if (thumb) return openViewer(thumb.dataset.g, thumb.dataset.j);
  const g = groupsOf(work.jobs).find((x) => x.id === (e.target.dataset.cancel || e.target.dataset.rerun));
  if (!g) return;
  if (e.target.dataset.cancel) {
    action(async () => {
      for (const j of g.jobs) if (j.status === 'queued' || j.status === 'running') await api('POST', `/jobs/${j.id}/cancel`);
      refreshJobs();
    });
  } else {
    // 每张图各重做一次，张数和原来一样
    action(() => rerun(g.jobs));
  }
});
$('jobSearch').addEventListener('input', renderGroups);
$('jobFilter').addEventListener('change', renderGroups);

// ---------- 看大图 ----------
const MODE_NAMES = { final: '贴回版本', raw: '网页原图', input: '送去的原图' };

function viewerJobs() {
  const g = groupsOf(work.jobs).find((x) => x.id === work.viewer.groupId);
  return g ? g.jobs.filter((j) => j.status === 'done') : [];
}

// 哪些版本有：没原图就没有「送去的原图」；没对齐也没校色时贴回版本就是网页原图
function modesOf(j) {
  const changed = Boolean(j.result?.align?.applied) || (j.post?.cc && j.post.cc !== 'none');
  return { final: true, raw: changed, input: Boolean(j.inputPath) };
}
function srcOf(j, mode) {
  if (mode === 'raw') return `/jobs/${j.id}/result?raw=1`;
  if (mode === 'input') return `/jobs/${j.id}/input`;
  return `/jobs/${j.id}/result?cc=${encodeURIComponent(j.post?.cc || 'none')}`;
}

function openViewer(groupId, jobId) {
  work.viewer = { groupId, jobId, mode: 'final', compare: '', split: 50, s: 1, x: 0, y: 0 };
  $('viewer').hidden = false;
  renderViewer(true);
}
function closeViewer() {
  work.viewer = null;
  $('viewer').hidden = true;
  $('imgBottom').removeAttribute('src');
  $('imgTop').removeAttribute('src');
}

function setImg(el, path) {
  const src = url(path);
  if (el.getAttribute('src') === src) return;
  $('stageMsg').hidden = false;
  $('stageMsg').textContent = '加载中…';
  el.onload = () => { $('stageMsg').hidden = true; };
  el.onerror = () => { $('stageMsg').hidden = false; $('stageMsg').textContent = '这张图读不到了'; };
  el.src = src;
}

function renderViewer(reset) {
  const v = work.viewer;
  const list = viewerJobs();
  const idx = Math.max(0, list.findIndex((j) => j.id === v.jobId));
  const j = list[idx];
  if (!j) return closeViewer();
  v.jobId = j.id;
  const modes = modesOf(j);
  if (!modes[v.mode]) v.mode = 'final';
  if (v.compare && !v.compare.split(':').every((m) => modes[m])) v.compare = '';
  if (reset) Object.assign(v, { s: 1, x: 0, y: 0 });
  const r = j.result || {};
  $('vTitle').textContent = titleOf(j);
  $('vMeta').textContent = [providerLabel(j.provider), r.width && `${r.width}×${r.height}`, fmtTime(j.createdAt), sourceText(j), r.source].filter(Boolean).join(' · ');
  for (const b of $('vModes').querySelectorAll('button')) {
    b.disabled = !modes[b.dataset.mode];
    b.classList.toggle('active', !v.compare && b.dataset.mode === v.mode);
  }
  for (const b of $('vCompare').querySelectorAll('button')) {
    b.disabled = Boolean(b.dataset.compare) && !b.dataset.compare.split(':').every((m) => modes[m]);
    b.classList.toggle('active', b.dataset.compare === v.compare);
  }
  if (v.compare) {
    // 左边是第一张（原图 / 网页原图），右边是贴回版本；拖白线比较
    const [a, b] = v.compare.split(':');
    setImg($('imgTop'), srcOf(j, a));
    setImg($('imgBottom'), srcOf(j, b));
    $('handleLeft').textContent = MODE_NAMES[a];
    $('handleRight').textContent = MODE_NAMES[b];
  } else {
    setImg($('imgBottom'), srcOf(j, v.mode));
  }
  $('layerTop').hidden = !v.compare;
  $('handle').hidden = !v.compare;
  applyView();
  $('vPrev').disabled = idx <= 0;
  $('vNext').disabled = idx >= list.length - 1;
  $('vIndex').textContent = list.length > 1 ? `${idx + 1} / ${list.length}` : '';
  $('vPaste').disabled = !work.ps.commands;
  $('vPaste').title = work.ps.commands ? '' : work.ps.psOnline ? 'PS 里的插件需要更新' : 'Photoshop 面板没有连上';
  $('vReuse').disabled = false;
  $('vPrompt').textContent = `${j.prompt}\n\n${(j.log || []).join('\n')}`;
}

function applyView() {
  const v = work.viewer;
  const t = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
  $('imgBottom').style.transform = t;
  $('imgTop').style.transform = t;
  $('layerTop').style.clipPath = `inset(0 ${100 - v.split}% 0 0)`;
  $('handle').style.left = `${v.split}%`;
  $('stage').classList.toggle('zoomed', v.s > 1);
}

function stepViewer(d) {
  const list = viewerJobs();
  const i = list.findIndex((j) => j.id === work.viewer.jobId) + d;
  if (list[i]) { work.viewer.jobId = list[i].id; renderViewer(true); }
}

$('vModes').addEventListener('click', (e) => {
  const m = e.target.dataset.mode;
  if (m && !e.target.disabled) { Object.assign(work.viewer, { mode: m, compare: '' }); renderViewer(false); }
});
$('vCompare').addEventListener('click', (e) => {
  const c = e.target.dataset.compare;
  if (c != null && !e.target.disabled) { work.viewer.compare = c; renderViewer(false); }
});
$('vClose').addEventListener('click', closeViewer);
$('vPrev').addEventListener('click', () => stepViewer(-1));
$('vNext').addEventListener('click', () => stepViewer(1));
document.addEventListener('keydown', (e) => {
  if (!work.viewer) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
});

// 滚轮以鼠标位置为中心缩放；放大后拖动平移；对比时拖白线（没放大时在图上任意位置拖都行）；双击复原
const stage = $('stage');
let drag = null;
function showZoom() {
  const tag = $('zoomTag');
  tag.textContent = `${Math.round(work.viewer.s * 100)}%`;
  tag.hidden = false;
  clearTimeout(showZoom.timer);
  showZoom.timer = setTimeout(() => { tag.hidden = true; }, 1000);
}
stage.addEventListener('wheel', (e) => {
  if (!work.viewer) return;
  e.preventDefault();
  const v = work.viewer;
  const rect = stage.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const s = Math.min(8, Math.max(1, v.s * Math.exp(-e.deltaY * 0.0015)));
  if (s === 1) Object.assign(v, { s: 1, x: 0, y: 0 });
  else Object.assign(v, { x: cx - (cx - v.x) * (s / v.s), y: cy - (cy - v.y) * (s / v.s), s });
  applyView();
  showZoom();
}, { passive: false });
stage.addEventListener('pointerdown', (e) => {
  if (!work.viewer || e.target.closest('.nav')) return;
  const v = work.viewer;
  const split = e.target.closest('.handle') || (v.compare && v.s === 1);
  drag = { split, x0: e.clientX, y0: e.clientY, vx: v.x, vy: v.y };
  stage.setPointerCapture(e.pointerId);
  if (split) moveSplit(e);
  else if (v.s > 1) stage.classList.add('panning');
});
function moveSplit(e) {
  const rect = stage.getBoundingClientRect();
  work.viewer.split = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
  applyView();
}
stage.addEventListener('pointermove', (e) => {
  if (!drag || !work.viewer) return;
  if (drag.split) return moveSplit(e);
  if (work.viewer.s > 1) {
    work.viewer.x = drag.vx + e.clientX - drag.x0;
    work.viewer.y = drag.vy + e.clientY - drag.y0;
    applyView();
  }
});
stage.addEventListener('pointerup', () => { drag = null; stage.classList.remove('panning'); });
stage.addEventListener('dblclick', () => { if (work.viewer) { Object.assign(work.viewer, { s: 1, x: 0, y: 0 }); applyView(); } });

const viewerJob = () => viewerJobs().find((j) => j.id === work.viewer?.jobId);
$('vPaste').addEventListener('click', () => action(async () => {
  $('vPaste').disabled = true;
  try {
    await api('POST', '/bridge/ps', { type: 'paste', jobId: viewerJob().id });
    toast('已贴到 Photoshop 当前选区');
  } finally {
    $('vPaste').disabled = !work.ps.commands;
  }
}));
$('vReuse').addEventListener('click', () => action(async () => {
  const j = viewerJob();
  const r = await api('POST', '/uploads/from-file', { jobId: j.id, maxSide: maxSide() });
  setSource('file');
  setInput({ ...r, name: `上一轮结果 · ${titleOf(j).slice(0, 20)}` });
  closeViewer();
  toast('已设为原图，写好提示词再生成');
}));
$('vRerun').addEventListener('click', () => action(() => rerun([viewerJob()])));
$('vCopy').addEventListener('click', () => action(async () => {
  const v = work.viewer;
  const j = viewerJob();
  await window.bridge.copyImage(srcOf(j, v.compare ? v.compare.split(':')[1] : v.mode));
  toast('图片已复制');
}));
$('vReveal').addEventListener('click', () => action(() => window.bridge.revealJob(viewerJob().id)));
$('vCopyPrompt').addEventListener('click', () => action(async () => { await window.bridge.copyText(viewerJob().prompt); toast('提示词已复制'); }));

// ---------- 启动 ----------
(function init() {
  const prefs = readPrefs();
  if (prefs.count) $('count').value = prefs.count;
  if (prefs.keep != null) $('keepComposition').checked = prefs.keep;
  if (prefs.fallback != null) $('fallback').checked = prefs.fallback;
  setSource(prefs.source || 'file');
  setInput(null);
  renderRefs();
  setInterval(() => { if (document.visibilityState === 'visible') refreshJobs(); }, 1500);
})();
