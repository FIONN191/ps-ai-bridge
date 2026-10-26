// ════════════════════════════════════════════════════════════════
//  compute-slots.js —— 算力槽位：给渠道改名、只露出想用的模型、给模型改显示名（2026-10-21，用户要求，照 V6 算力槽位）
//
//  ⭐ 定海神针（V6 _dev/已完工/算力槽位_施工清单.md 原样继承）：
//    1. 渠道的真实取值（aji / momo / grs / other）永远不变 —— 改名只是显示层。
//    2. 模型的真实 id 永远不变；送 AI、算钱、查余额、拼分辨率后缀全用真实 id。改名只改下拉框里看到的字。
//    3. 隐藏只影响下拉框露不露出来：当前选着的模型（老预设 / 历史重算）就算被隐藏也照样留在下拉框里，不丢、不崩。
//    4. V6 拍板「渠道不能隐藏，只能改名」—— 这里也没有隐藏渠道。
//  ⚠ 纯函数，不碰界面和存储。
//
//  存法（settingsRuntime，跟账号走）：
//    computeSlotNames  = { aji:'香蕉', other:'我的中转' }                    空 = 用默认名
//    computeModelPrefs = { aji:{ hidden:['AJbanana2'], names:{ 'AJbanana3':'Pro' } }, … }
// ════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7ComputeSlots = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const SLOTS = ['aji', 'momo', 'grs', 'other'];
  const DEFAULT_NAMES = Object.freeze({ aji: 'AJI · 阿吉', momo: 'MOMO · 墨墨', grs: 'GRS', other: '免 API 模式' });
  const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

  function customName(names, slot) { return clean(names && names[slot], 20); }
  // 显示用的渠道名：改过名用改的，没改过用默认
  function name(names, slot) { return customName(names, slot) || DEFAULT_NAMES[slot] || String(slot || ''); }
  // 设置里服务商下拉那种「要认得出是哪家」的地方：改过名 ⇒「我起的名（AJI · 阿吉）」
  function labelWithOrigin(names, slot, original) {
    const custom = customName(names, slot), base = original || DEFAULT_NAMES[slot] || String(slot || '');
    return custom ? custom + '（' + base + '）' : base;
  }
  function prefsOf(prefs, slot) {
    const p = prefs && prefs[slot];
    return { hidden: Array.isArray(p && p.hidden) ? p.hidden.map(String) : [], names: p && p.names && typeof p.names === 'object' ? p.names : {} };
  }
  // rows = 生成卡模型下拉的原始名单 [[id, 显示名, 分类], …]（aiModelOptionsRaw 的输出）
  // ⇒ 去掉隐藏的（当前选着的除外）、换成用户起的显示名；其余列原样带着
  function applyModels(rows, slotPrefs, current) {
    const p = slotPrefs && typeof slotPrefs === 'object' ? { hidden: Array.isArray(slotPrefs.hidden) ? slotPrefs.hidden.map(String) : [], names: slotPrefs.names || {} } : { hidden: [], names: {} };
    const hidden = new Set(p.hidden), cur = String(current || '');
    const out = [];
    for (const row of rows || []) {
      const id = String(row[0]);
      if (hidden.has(id) && id !== cur) continue;
      const custom = clean(p.names[id], 40);
      out.push(custom ? [row[0], custom].concat(row.slice(2)) : row);
    }
    // 全被隐藏了（比如名单换了、以前没隐藏过的新模型都没了）⇒ 原样给，下拉框不许空
    return out.length ? out : (rows || []);
  }
  // 设置里勾掉 / 勾上一个模型。⚠ 至少要留一个露出（V6 同一条：下拉框不能空）
  function setHidden(prefs, slot, id, hide, allIds) {
    const next = JSON.parse(JSON.stringify(prefs || {})), p = prefsOf(next, slot), key = String(id);
    const set = new Set(p.hidden);
    if (hide) {
      const visible = (allIds || []).map(String).filter(x => !set.has(x) && x !== key);
      if (allIds && !visible.length) throw Object.assign(new Error('至少要露出一个模型'), { code: 'COMPUTE_SLOT_EMPTY' });
      set.add(key);
    } else set.delete(key);
    next[slot] = { hidden: [...set], names: p.names };
    return next;
  }
  function setModelName(prefs, slot, id, value) {
    const next = JSON.parse(JSON.stringify(prefs || {})), p = prefsOf(next, slot), text = clean(value, 40);
    const names = Object.assign({}, p.names);
    if (text) names[String(id)] = text; else delete names[String(id)];
    next[slot] = { hidden: p.hidden, names };
    return next;
  }
  function setSlotName(names, slot, value) {
    const next = Object.assign({}, names || {}), text = clean(value, 20);
    if (text) next[slot] = text; else delete next[slot];
    return next;
  }
  function reset(prefs, names, slot) {
    const p = Object.assign({}, prefs || {}), n = Object.assign({}, names || {});
    delete p[slot]; delete n[slot];
    return { prefs: p, names: n };
  }
  // ⭐ 2026-10-21（用户要，照 V6 阶段 7「槽位排序」+ 阶段 5「一键轮换」）：
  //   computeSlotOrder = ['other','aji','momo','grs']（跟账号走）。服务商下拉、快捷键轮换都按它排。
  //   ⚠ 去脏 / 补齐：不认识的丢掉、重复的去掉、缺的按默认顺序补在后面 —— 存坏了也不会少一家。
  function order(list) {
    const out = [];
    for (const slot of Array.isArray(list) ? list : []) if (SLOTS.includes(slot) && !out.includes(slot)) out.push(slot);
    for (const slot of SLOTS) if (!out.includes(slot)) out.push(slot);
    return out;
  }
  function move(list, slot, delta) {
    const out = order(list), i = out.indexOf(slot), j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= out.length) return out;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }
  // 快捷键「换下一家」：按顺序的下一家，到头绕回第一家；当前不在名单里 ⇒ 第一家
  function next(list, current) {
    const out = order(list), i = out.indexOf(current);
    return out[(i + 1) % out.length];
  }
  return { SLOTS, DEFAULT_NAMES, name, customName, labelWithOrigin, prefsOf, applyModels, setHidden, setModelName, setSlotName, reset, order, move, next };
});
