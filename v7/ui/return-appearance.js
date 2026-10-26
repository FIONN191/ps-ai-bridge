/* ============================================================
 *  return-appearance.js — 传回的"样子"：组的标注色 + 完成音效
 *
 *  用户 2026-10-11 要求（原话）：
 *    · "V6 在计算完成之后会有完成音效"
 *    · "V6 传回的图层有那个边缘颜色，就是把组变成在 Photoshop 里面对应的
 *       就是给组打标注的那个颜色"
 *    · "V7 也可以自定义传回的音效，然后也可以自定义传回的组的颜色"
 *    · "用 V6 的音效，直接搬过"
 *    · "不设置颜色，默认就是没有颜色，然后完成音效默认不启用，用户需要自己去开"
 *
 *  ⚠ 分工：这份文件只管【规则和播放】；"什么时候算完成"这种业务判断留在
 *    ui.html 里。这样它能在测试里单独跑，不用把整个界面拖进来。
 * ============================================================ */
(function (root) {
  'use strict';

  // ══════════════════════════════════════════════════════════════
  //  一、组的标注色
  // ══════════════════════════════════════════════════════════════
  //
  //  ⚠⚠ 为什么只有 9 个、不能自定义任意颜色：
  //    Photoshop 的图层/组标注色是【它自己写死的一组枚举】。
  //    UXP 的 DOM API 里【没有】这个属性（Adobe 论坛 2023-05 确认过），
  //    只能走 batchPlay 的 { color: { _enum:'color', _value:… } }；
  //    能取的值就是下面这 9 个。社区从 2020 年就在申请自定义色，Adobe 没做。
  //  ⚠ 两个反直觉的坑（Adobe 自己的类型定义里注明是历史 bug）：
  //    · 黄色叫 'yellowColor'，不是 'yellow'
  //    · RGB 色空间里 'green' 反而叫 'grain' —— 但【标注色这里就是 green】，
  //      别把两处的坑搞混
  //  ⚠ V6 的取值：轮椅 4.0 → 6.4.6 八个版本的 host/ps-io.js 都写死 'yellowColor'。
  var GROUP_COLORS = [
    ['none', '不给颜色'],
    ['red', '红'],
    ['orange', '橙'],
    ['yellowColor', '黄'],
    ['green', '绿'],
    ['blue', '蓝'],
    ['violet', '紫'],
    ['gray', '灰'],
    ['black', '黑']
  ];
  var GROUP_COLOR_VALUES = GROUP_COLORS.map(function (x) { return x[0]; });
  var DEFAULT_GROUP_COLOR = 'none';   // 用户定：不设置就是没有颜色

  function groupColorChoices() { return GROUP_COLORS.slice(); }

  function normalizeGroupColor(value) {
    var v = String(value == null ? '' : value);
    return GROUP_COLOR_VALUES.indexOf(v) >= 0 ? v : DEFAULT_GROUP_COLOR;
  }

  // ══════════════════════════════════════════════════════════════
  //  二、音效
  // ══════════════════════════════════════════════════════════════
  //
  //  照 V6 的 host/sound.js 搬：三个音效位，默认值也照抄。
  //  ⚠ 与 V6 的两处【有意】不同：
  //    1. V6 总开关默认【开】；这里默认【关】—— 用户 2026-10-11 明确要求
  //       "完成音效默认不启用，用户需要自己去开"
  //    2. V6 只有"全部失败/单个失败"能选"无"，成功那个没有 ⇒ 成功音设不掉。
  //       这里三个位都能选"无"。
  var SOUND_SLOTS = [
    ['success', '任务成功'],
    ['allFail', '全部失败'],
    ['singleFail', '单个失败']
  ];
  var SOUND_NONE = 'none';               // 与 V6 同一个字面量，方便以后迁移
  var DEFAULT_SOUNDS = { success: '三七唐笑', allFail: SOUND_NONE, singleFail: SOUND_NONE };

  // V6 的 host/sound.js:112-120 —— 单个失败音 2 秒节流，
  // 防止同一波超时里好几个失败同时响、声音叠成一团。
  var SINGLE_FAIL_THROTTLE_MS = 2000;
  var lastSingleFailAt = 0;

  // ⚠ V6 内置音效的目录。V6 放在插件的 audios/ 下、只收 .mp3；
  //   V7 放在 ui-pure/assets/sfx-v6/（2026-10-11 从 V6 原样搬过来的 12 个）。
  var BUILTIN_SOUND_DIR = 'assets/sfx-v6/';
  var BUILTIN_SOUNDS = [
    '三七唐笑', '卧槽的', '嘻嘻嘻', '曼波', '曼波duang', '曼波wow',
    '曼波傻笑', '曼波哈基米', '曼波啊米诺斯', '曼波我嘞个豆', '曼波普通人', '曼波欧耶'
  ];

  function builtinSounds() { return BUILTIN_SOUNDS.slice(); }

  function normalizeSoundName(value) {
    return String(value == null ? '' : value).trim();
  }

  // 取某个位的最终音效名。
  //   ⚠⚠ 这里的判定必须跟界面上那个下拉【显示的值】完全一致，否则就是假开关
  //     （铁律 16：能存不生效的开关比没有这个开关更坏）。
  //   界面的取法（ui.html 的 soundChoices）：
  //     空值      → 显示 V6 的默认（成功=三七唐笑，另两位=none）
  //     有值      → 显示那个值（包括用户主动选的 'none'）
  //   ⇒ 这里照同一套判：空才回落，写着 'none' 就是"用户要它不响"，不回落。
  function soundFor(prefs, slot) {
    var p = prefs || {};
    var key = 'sound' + slot.charAt(0).toUpperCase() + slot.slice(1);
    var raw = normalizeSoundName(p[key]);
    // ⚠ 判"用户有没有设过"要用【原始值】，不能先过一遍 isSilent ——
    //   否则用户主动选的 'none' 会被当成"没设过"而回落到三七唐笑（正好反过来）。
    if (raw !== '') return raw;
    return DEFAULT_SOUNDS[slot] || SOUND_NONE;
  }

  // 「无」的判定要跟 V6 一致：V6 存的是字符串 'none'，而且它是 JSON 化过的
  // （可能带引号），所以两边都要认。
  function isSilent(name) {
    var v = normalizeSoundName(name);
    return !v || v === SOUND_NONE || v === '"none"';
  }

  // ══════════════════════════════════════════════════════════════
  //  三、播放
  // ══════════════════════════════════════════════════════════════
  //
  //  ⚠ 跟 V6 的差别：V6 的插件进程没法自己出声，要把音频读成 base64
  //    发给面板去播（host/sound.js 最后一句 sendToPanel('playSound',…)）。
  //    V7 的界面本身就是个网页 ⇒ 直接 new Audio() 播就行，少一层搬运。
  var audioCache = Object.create(null);

  function audioUrl(name) {
    if (audioCache[name]) return audioCache[name];
    var url = BUILTIN_SOUND_DIR + encodeURIComponent(name) + '.mp3';
    audioCache[name] = url;
    return url;
  }

  // ⭐ 2026-10-15（用户要求）：音量。设置里【一个滑条管三个位】，不分开做三个。
  //   存的是 0~100 的字符串（滑条读出来就是字符串）；没设过/乱值 = 100（跟以前一样响）。
  //   0 = 不响（连 Audio 都不建）。
  function volumeOf(value) {
    if (value === '' || value == null) return 1;
    var n = Number(value);
    if (!isFinite(n)) return 1;
    return Math.max(0, Math.min(100, n)) / 100;
  }

  function playByName(name, host, volume) {
    if (isSilent(name) || volumeOf(volume) <= 0) return false;
    return !!startAudio(name, host, '播放', volume);
  }

  // ⭐ 2026-10-15（用户要求）：设置里选了一个音效，马上播一遍给他听听是什么。
  //   跟 playByName 的区别：
  //   ① 不看「完成音效」总开关 —— 这是用户自己在下拉框里点的，就是要听；
  //   ② 连着换几个时先停掉上一个，不叠成一团；选「无」也会把正在试听的停掉。
  var previewAudio = null;
  function previewByName(name, host, volume) {
    if (previewAudio) { try { previewAudio.pause(); } catch (_) { } previewAudio = null; }
    if (isSilent(name) || volumeOf(volume) <= 0) return false;
    previewAudio = startAudio(name, host, '试听', volume);
    return !!previewAudio;
  }

  function startAudio(name, host, what, volume) {
    var url = audioUrl(name);
    try {
      var audio = new Audio(url);
      audio.volume = volumeOf(volume);
      var p = audio.play();
      // ⚠ 自动播放可能被浏览器策略拦（要用户先有过交互）。这里【不能】静默吞掉：
      //   用户开了音效却听不到，只会以为坏了。
      if (p && typeof p.catch === 'function') {
        p.catch(function (error) {
          if (host && typeof host.warn === 'function') host.warn('音效' + what + '被拦：' + name, error);
        });
      }
      return audio;
    } catch (error) {
      if (host && typeof host.warn === 'function') host.warn('音效' + what + '失败：' + name, error);
      return null;
    }
  }

  // 按"这一轮情况"决定放哪个音。
  //   result: { total, ok, failed }  —— total 是这一轮共几张
  //   ⚠ 跟 V6 的三位对应关系（照 V6 的调用点推的）：
  //     ok === total        → success（全成功）
  //     ok === 0            → allFail（全失败）
  //     0 < ok < total      → 单个失败（有成功的也有失败的）
  function playForResult(result, prefs, host) {
    var p = prefs || {};
    if (p.soundEnabled !== true) return null;      // 总开关默认关，用户自己开
    var total = Number(result && result.total) || 0;
    var ok = Number(result && result.ok) || 0;
    if (total <= 0) return null;
    var slot;
    if (ok >= total) slot = 'success';
    else if (ok <= 0) slot = 'allFail';
    else slot = 'singleFail';
    // 单个失败 2 秒节流（V6 同款）—— 同一波里好几个失败不能叠着响
    if (slot === 'singleFail') {
      var now = Date.now();
      if (now - lastSingleFailAt < SINGLE_FAIL_THROTTLE_MS) return slot;
      lastSingleFailAt = now;
    }
    playByName(soundFor(p, slot), host, p.soundVolume);
    return slot;
  }

  root.V7ReturnAppearance = {
    // 组颜色
    groupColorChoices: groupColorChoices,
    normalizeGroupColor: normalizeGroupColor,
    GROUP_COLOR_VALUES: GROUP_COLOR_VALUES,
    DEFAULT_GROUP_COLOR: DEFAULT_GROUP_COLOR,
    // 音效
    SOUND_SLOTS: SOUND_SLOTS,
    SOUND_NONE: SOUND_NONE,
    DEFAULT_SOUNDS: DEFAULT_SOUNDS,
    SINGLE_FAIL_THROTTLE_MS: SINGLE_FAIL_THROTTLE_MS,
    builtinSounds: builtinSounds,
    normalizeSoundName: normalizeSoundName,
    soundFor: soundFor,
    isSilent: isSilent,
    playByName: playByName,
    previewByName: previewByName,
    volumeOf: volumeOf,
    playForResult: playForResult,
    audioUrl: audioUrl
  };
})(window);
