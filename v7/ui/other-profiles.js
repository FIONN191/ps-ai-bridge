// ════════════════════════════════════════════════════════════════
//  other-profiles.js —— 自定义渠道（Others）存多套「配置方案」（2026-10-21，用户要求，V6 有这个）
//
//  用户场景：同时有好几个中转站（OpenRouter、硅基流动、各家小中转…），来回切不用每次重填地址和 Key。
//
//  ⭐ 定海神针（照 V6 算力槽位的做法）：【当前在用的那一套】仍然放在原来的
//     otherUrl / otherKey / otherProtocol / otherAuthMode 四个设置项里 ——
//     发请求、查余额、拉模型、云备份读的都是这四个，一行不用改。
//     这里只多存「其他几套」：名字 / 地址 / 协议 / 鉴权 / 模型名单存在设置里（otherProfiles），
//     Key 统一打包成一份存进本机安全存储（otherProfileKeys，跟别的 Key 一样不落明文）。
//  ⚠ 切换 = 先把当前这四项写回当前方案，再把目标方案的值放进这四项。
//  ⚠ 纯函数：不碰界面、不碰存储，进来一个状态、出去一个新状态（方便测试，也不会半路改坏）。
//
//  状态形状：
//    { profiles:[{id,name,url,protocol,authMode,models:[]}], active:'id',
//      live:{url,key,protocol,authMode,models:[]}, keys:{id:'key'} }
// ════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7OtherProfiles = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const MAX_PROFILES = 20;
  const fail = message => Object.assign(new Error(message), { code: 'OTHER_PROFILE_INVALID' });
  const clone = value => JSON.parse(JSON.stringify(value));

  function parseKeys(text) {
    try { const v = JSON.parse(String(text || '') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch (_) { return {}; }
  }
  // 空的 Key 不存（存进安全存储的值不能是空串）；一个都没有就是空串 = 安全存储里删掉这一格
  function stringifyKeys(keys) {
    const out = {};
    for (const [id, key] of Object.entries(keys || {})) if (typeof key === 'string' && key.trim()) out[id] = key;
    return Object.keys(out).length ? JSON.stringify(out) : '';
  }
  function cleanName(name) {
    const value = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim();
    if (!value) throw fail('方案名称不能为空');
    if (value.length > 40) throw fail('方案名称最多 40 个字');
    return value;
  }
  // 默认名字：用地址的域名（看得出是哪家），没有地址就叫「方案 N」
  function defaultName(url, profiles) {
    let host = '';
    try { host = new URL(String(url || '')).host; } catch (_) {}
    let name = host || '方案 1', n = 1;
    while (profiles.some(p => p.name === name)) name = (host || '方案') + ' ' + (++n);
    return name;
  }
  let seq = 0;
  function newId() { return 'p' + Date.now().toString(36) + (++seq).toString(36) + Math.random().toString(36).slice(2, 6); }

  // 第一次用：把现在填着的那一套变成「方案 1」；当前方案编号不对时指回第一套
  //   ⚠ 第一套的编号固定是 'p1'：界面只是显示的时候也会调 ensure（不存盘），编号每次一样，
  //     下拉框里选到的编号才对得上；真存盘只发生在用户点了切换 / 另存 / 改名 / 删除之后。
  function ensure(input) {
    const state = clone(input);
    state.profiles = Array.isArray(state.profiles) ? state.profiles.filter(p => p && typeof p.id === 'string' && p.id) : [];
    state.keys = state.keys && typeof state.keys === 'object' ? state.keys : {};
    state.live = Object.assign({ url: '', key: '', protocol: 'gemini', authMode: 'bearer', models: [] }, state.live || {});
    if (!state.profiles.length) {
      const id = 'p1';
      state.profiles.push({ id, name: defaultName(state.live.url, []), url: state.live.url, protocol: state.live.protocol, authMode: state.live.authMode, models: state.live.models || [] });
      state.active = id;
    }
    if (!state.profiles.some(p => p.id === state.active)) state.active = state.profiles[0].id;
    return state;
  }
  // 把当前这四项（+ 模型名单）写回当前方案
  function capture(input) {
    const state = ensure(input), cur = state.profiles.find(p => p.id === state.active);
    Object.assign(cur, { url: state.live.url, protocol: state.live.protocol, authMode: state.live.authMode, models: (state.live.models || []).slice() });
    state.keys[cur.id] = state.live.key || '';
    return state;
  }
  function load(state, id) {
    const target = state.profiles.find(p => p.id === id);
    if (!target) throw fail('找不到这个方案，可能已经删掉了');
    state.active = id;
    state.live = { url: target.url || '', key: state.keys[id] || '', protocol: target.protocol || 'gemini', authMode: target.authMode || 'bearer', models: (target.models || []).slice() };
    return state;
  }
  function switchTo(input, id) { return load(capture(input), id); }
  // 另存为新方案：用当前填着的值复制一份，切到新方案（用户接着改地址 / Key 就是改新的）
  function saveAs(input, name) {
    const state = capture(input);
    if (state.profiles.length >= MAX_PROFILES) throw fail('最多存 ' + MAX_PROFILES + ' 套方案，先删掉不用的');
    const finalName = name == null || name === '' ? defaultName(state.live.url, state.profiles) : cleanName(name);
    if (state.profiles.some(p => p.name === finalName)) throw fail('已经有叫「' + finalName + '」的方案了');
    const id = newId();
    state.profiles.push({ id, name: finalName, url: state.live.url, protocol: state.live.protocol, authMode: state.live.authMode, models: (state.live.models || []).slice() });
    state.keys[id] = state.live.key || '';
    state.active = id;
    return state;
  }
  function rename(input, id, name) {
    const state = capture(input), finalName = cleanName(name), row = state.profiles.find(p => p.id === id);
    if (!row) throw fail('找不到这个方案，可能已经删掉了');
    if (state.profiles.some(p => p.id !== id && p.name === finalName)) throw fail('已经有叫「' + finalName + '」的方案了');
    row.name = finalName;
    return state;
  }
  // 删方案：至少留一套；删的是当前这套 ⇒ 切到剩下的第一套
  function remove(input, id) {
    const state = capture(input);
    if (state.profiles.length <= 1) throw fail('至少要留一套方案');
    if (!state.profiles.some(p => p.id === id)) throw fail('找不到这个方案，可能已经删掉了');
    state.profiles = state.profiles.filter(p => p.id !== id);
    delete state.keys[id];
    if (state.active === id) return load(state, state.profiles[0].id);
    return state;
  }
  return { ensure, capture, switchTo, saveAs, rename, remove, parseKeys, stringifyKeys, MAX_PROFILES };
});
