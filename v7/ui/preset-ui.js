// ============================================================
//  preset-ui.js — 预设系统 · 界面层
//  window.PRESETUI
//
//  一级 = 剪影画布(点部位)  二级 = 预设列表(点预设)  三级 = 提示词框
//  数据全部走 window.PRESETS(preset-store.js), 这里只管画和交互。
//
//  ⚠ 样式一律用 JS 设(el.style.xxx = ...), 不往 HTML 字符串里塞 style="" ——
//    CSP 的 style-src-attr 曾经把内联 style 整个拦掉, 表现是"数据对、DOM 对、就是不显示"
//    (docs/12 坑25 / CLAUDE.md 铁律 17)。CSSOM 赋值不受这条限制, 更稳。
//
//  设计文档: docs/28_预设系统设计.md
// ============================================================
(function () {
  'use strict';

  // ⭐ 退役工具：不进工具列表、不钉到剪影上、不能打开。
  //   poster —— 2026-09-28 用户定案删除（已被 AI Agent 取代，且原本就不稳）
  //   ⚠ partition（全局分区）2026-10-03 从这份名单里【移出去了】——
  //     用户当天明确纠正"做回来，别删名字"。当初删它的理由是"点开始会跳一个莫名其妙的窗口"，
  //     但那其实是接线没做（tool-workbench 的兜底分支直接把点击吞了）。
  //     现在大卡（tool-workbench 的 partition 面板）+ 总线（V7RegionWorkbench.attach('partition')）
  //     都接上了，所以它回到正常工具名单里。
  //   ⚠ 放在文件最上面：剪影画布(pinnedToolRow)和工具列表都要用。const 放在后面的话，
  //     早于它执行的代码一碰就是"暂时性死区"，整个脚本当场死掉（CLAUDE.md 铁律 17 那张表）。
  const RETIRED_TOOLS = new Set(['poster']);

  const S = {
    host: null,          // 外部注入的接线(见 init)
    cardEl: null,
    canvasEl: null,
    crumbEl: null,
    zoneEl: null,
    selAsset: null,      // 当前选中的素材 id, null = 全部
    hoverAsset: null,
    selPreset: null,     // 当前选中的预设 id
    filter: '',
    searchOpen: false,
    // ⭐ 2026-10-19（docs/250 第 8 条）：二级显示「最近用过的提示词」而不是预设列表（右上角时钟按钮切换）
    // 提示词框右上角的时钟开着没有（二级 / 三级各一个），开的时候绑着哪个预设（换了预设就自动关）
    promptHist: { zone: false, detail: false },
    promptHistPreset: { zone: '', detail: '' },
    recentQuery: '',
    toolGroupOpen: false,
    toolGroup: null,
    forceText: false,    // 用户点了"切到原文"
    lastHadParams: false,
    zoom: { x: 0, y: 0, k: 1 },
    nodes: new Map(),    // assetId -> {wrap, img, hl}
    previewLayout: new Map()
  };

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, level) { if (S.host && S.host.toast) S.host.toast(msg, level || 'info'); }
  function P() { return window.PRESETS; }
  let dragStorageEpoch = 0;
  // The silhouette editor is a separate OS window.  Its result can arrive
  // after the user has switched accounts, so every editor session carries a
  // small capability token tied to the current storage namespace and asset
  // revision.  A storage switch invalidates that token immediately.
  let editorSessionSerial = 0;
  let activeEditorContext = null;
  window.addEventListener('wheelchair:storage-context', () => {
    dragStorageEpoch++;
    activeEditorContext = null;
    S.selAsset = null; S.selPreset = null; S.toolGroupOpen = false; S.toolGroup = null;
    S.hoverAsset = null; S.filter = ''; S.searchOpen = false; S.promptHist = { zone: false, detail: false }; S.recentQuery = '';
  });

  // ⭐ 千问模式（2026-10-15 用户定：两套预设分开）：切换后剪影预设换成另一套。
  //   提示词框里正开着的预设如果属于另一套，就脱钩（正文留着），免得"看不见的预设"还挂在框上。
  //   只有点开关（wheelchair:qwen-mode）才弹提示；换账号带来的设置变化静默刷新。
  //   lastQwenMode = 界面【现在画着】的是哪一套（qwenToggle 画底栏时记），跟它不一样才刷新。
  let lastQwenMode = null;
  function qwenModeChanged(event) {
    const now = !!(window.V7QwenMode && window.V7QwenMode.enabled());
    if (now === lastQwenMode || lastQwenMode === null) { lastQwenMode = now; return; }
    lastQwenMode = now;
    const P0 = window.PRESETS;
    if (!P0) return;
    const loaded = St.presetId ? P0.presetById(St.presetId) : null;
    if (loaded && P0.visible && !P0.visible(loaded)) { St.presetId = ''; St.presetTitle = ''; savePromptState(); }
    const picked = S.selPreset ? P0.presetById(S.selPreset) : null;
    if (picked && P0.visible && !P0.visible(picked)) S.selPreset = null;
    S.filter = '';
    try { renderAssets(); renderCrumb(); fillZone(); } catch (_) { }
    if (event?.type === 'wheelchair:qwen-mode') {
      toast(now ? '已切到开源模型模式：剪影预设换成开源模型那一套，出图改走 ComfyUI 工作流' : '已切回普通模式：原来的预设回来了，出图走原来的通道', 'ok');
    }
  }
  window.addEventListener('wheelchair:qwen-mode', qwenModeChanged);
  window.addEventListener('wheelchair:settings-changed', qwenModeChanged);

  function editorStorageContext() {
    const storage = window.WHEELCHAIR_STORAGE;
    const backend = window.V7Backend && typeof window.V7Backend.state === 'function'
      ? window.V7Backend.state() : null;
    let context = {};
    try { context = storage && storage.getContext ? storage.getContext() : {}; } catch (_) { context = {}; }
    return {
      accountId: String(context.accountId || ''),
      namespaceId: String(context.namespaceId || (storage && storage.namespaceId ? storage.namespaceId() : '')),
      sessionVersion: backend && Number.isFinite(Number(backend.sessionVersion)) ? Number(backend.sessionVersion) : null
    };
  }

  function editorAssetVersion() {
    // This deliberately excludes Blob contents: the editor only receives
    // previews, while pixel data remains in the main window.  It still detects
    // every metadata/asset add/remove/update that could make a returned list
    // stale.  JSON is stable because the asset list is sorted by the store.
    return JSON.stringify({ revision: typeof P().assetVersion === 'function' ? P().assetVersion() : null,
      assets: P().assets().map(a => ({
      id: a.id, name: a.name, icon: a.icon, x: a.x, y: a.y,
      w: a.w, h: a.h, z: a.z, hidden: a.hidden === true
      })) });
  }

  function editorContextCurrent(expected) {
    if (!expected || activeEditorContext !== expected) return false;
    const now = editorStorageContext();
    return now.namespaceId === expected.namespaceId &&
      now.accountId === expected.accountId &&
      now.sessionVersion === expected.sessionVersion &&
      expected.accountEpoch === expected.storageEpoch &&
      dragStorageEpoch === expected.storageEpoch;
  }
  function editorAssetsCurrent(expected) {
    return editorContextCurrent(expected) && editorAssetVersion() ===
      (expected.currentAssetVersion || expected.assetVersion);
  }
  function assertEditorCurrent(expected) {
    if (!editorAssetsCurrent(expected)) {
      throw Object.assign(new Error('账号或素材已切换，已停止剪影写回'), { code: 'SILHOUETTE_EDITOR_STALE' });
    }
  }
  async function editorAssetWrite(expected, write) {
    assertEditorCurrent(expected);
    const revision = typeof P().assetVersion === 'function' ? P().assetVersion() : null;
    const result = await write();
    if (!editorContextCurrent(expected) || (revision !== null && P().assetVersion() !== revision + 1)) {
      throw Object.assign(new Error('账号或素材已切换，已停止剪影写回'), { code: 'SILHOUETTE_EDITOR_STALE' });
    }
    // Accept only this editor's own write. Later saves still carry the original
    // window token, but must match the latest revision accepted by this session.
    expected.currentAssetVersion = editorAssetVersion();
    return result;
  }
  function selectedAsset() {
    return S.selAsset === '__agent_inbox__' ? { id: '__agent_inbox__', name: 'Agent 预设', icon: '✧' } : (S.selAsset ? P().assetById(S.selAsset) : null);
  }
  function isGroupedToolAsset(asset) {
    return asset?.id === '__tool__' || !!window.V7ToolSilhouettes?.get?.(asset?.id);
  }
  // ⭐ 工具钉到剪影上（2026-09-29 用户定案）：
  //   工具剪影在编辑页（齿轮那页）里默认隐藏；用户把某个工具设成「显示」，它就出现在剪影上，
  //   点它直接展开这个工具的大卡。没挪过位置的出厂工具走 previewLayout 排到画布旁边的空白处（不挡人像），
  //   在编辑页里拖过位置的按用户摆的位置画。
  //   ⚠ 9-28 改「工具箱统一入口」时把所有工具剪影一刀切过滤掉了（isGroupedToolAsset），
  //     编辑页里点「显示」毫无反应 —— 这就是用户说的"显示不出来、也跳不过去"。
  //   ⚠ __tool__（旧的扳手剪影 = 基础工具分类）不钉：它下面的抠像/人体解析等会各自拆成独立工具，各自可钉。
  function pinnedToolRow(asset) {
    if (!asset || asset.hidden) return null;
    const row = window.V7ToolSilhouettes?.get?.(asset.id);
    if (!row || RETIRED_TOOLS.has(row.key)) return null;
    return row;
  }
  // 剪影画布上【能画、能点】的素材：普通部位 + 钉出来的工具。
  function canvasAssets() {
    return P().assets().filter(asset => !asset.hidden && (!isGroupedToolAsset(asset) || pinnedToolRow(asset)));
  }
  function presetCategoryAssets() {
    // The hub edits like any silhouette, but navigates to existing categories;
    // it must not become a dead-end destination for newly saved prompts.
    return P().assets().filter(asset => asset.id !== window.V7ToolSilhouettes?.hub?.assetId);
  }

  // 画一个图标（2026-09-14 图标改造）。
  // ⚠ 图标库没加载时返回空串，**不要回退成 emoji 或图标名** ——
  //   回退成名字的话界面会显示出 "search" 这种英文（这轮栽过一次）。
  //   按钮本身有 title 属性，空着也还能用。
  function ico(name, size) {
    return window.ICON ? window.ICON.render(name, size || 16) : '';
  }
  // 按剪影部位取图标。
  // ⚠ V6 那 17 个【内置】部位：按 id 查表出 SVG。
  //   （它们的 icon 字段是 emoji 且【已存进 IndexedDB】，改源码默认值对老用户无效，
  //     所以必须按 id 查表，不能读 a.icon。）
  // ⚠⚠ 用户【自建】的素材：图标是他自己在编辑器里填的 emoji，属于用户数据，
  //   原样显示，不许拿我们的 SVG 盖掉。
  function partIco(id, size, fallbackEmoji) {
    if(id === window.V7ToolSilhouettes?.hub?.assetId)return window.V7ToolSilhouettes.hubIcon(size || 16);
    const tool=window.V7ToolSilhouettes?.get(id);
    if(tool)return window.V7ToolSilhouettes.icon(tool.key,size||16);
    if (!window.ICON) return esc(fallbackEmoji || '');
    const name = window.ICON.iconForPart(id);
    if (name) return window.ICON.render(name, size || 16);
    return esc(fallbackEmoji || '');
  }

  // ═══════════════════════════════════════════════════════════
  //  一级: 剪影画布
  // ═══════════════════════════════════════════════════════════
  function buildCard() {
    const card = S.cardEl;
    if (!card) return;
    // 已有的装饰(dragbar / collapse-toggle)保留, 只补我们自己的层
    if (!card.querySelector('.ps-canvas')) {
      const wrap = document.createElement('div');
      wrap.className = 'ps-canvas';
      const inner = document.createElement('div');
      inner.className = 'ps-canvas-inner';
      wrap.appendChild(inner);
      card.appendChild(wrap);

      // ⭐⭐ 卡名（2026-09-13 用户要求）。剪影卡以前【整张卡没有标题】——
      //   主卡叠压时只露出最下面 34px，没标题就完全分不出下面压着的是哪张卡。
      //   放左下角，和右边已有的「全部预设 · N 条」凑成一行（用户定的排版）。
      //   ⚠ pointer-events:none —— 它只是块标签，绝不能挡住剪影画布的点击判定。
      const title = document.createElement('div');
      title.className = 'ps-cardname';
      title.textContent = '剪影预设';
      card.appendChild(title);

      const crumb = document.createElement('div');
      crumb.className = 'ps-crumb';
      card.appendChild(crumb);

      const search = document.createElement('div');
      search.className = 'ps-card-search';
      search.innerHTML = ico('search', 13) +
        '<input class="ps-card-search-input" type="text" spellcheck="false" autocomplete="off" placeholder="搜预设（中文 / 拼音首字母）" aria-label="搜索预设（所有部位一起搜，中文 / 拼音首字母都行）">' +
        '<button type="button" class="ps-card-search-x" title="清空搜索（Esc）" aria-label="清空搜索">×</button>';
      card.appendChild(search);
      bindCardSearch(card, search);

      const gear = document.createElement('button');
      gear.className = 'ps-gear';
      gear.title = '编辑剪影素材';
      gear.innerHTML = ico('gear', 14) || '⚙';
      // ⚠ 这里【必须】自己补 dataset.icon：上面走的是 innerHTML 直接塞，
      //   不是 ICON.set()（只有它会顺手写 dataset.icon）。不补的话
      //   MOTION.bind 读不到名字就静默 return false —— 动画代码明明在
      //   (motion.js 的 TRIGGERS.gear)，却永远没人调得到它。
      //   docs/49 2.3 记的"gear 动画接了一半"就是这条。
      gear.dataset.icon = 'gear';
      if (window.MOTION) MOTION.bind(gear);
      card.appendChild(gear);
      gear.addEventListener('click', e => {
        e.stopPropagation();
        // ⚠ 只 trigger 不 select：齿轮是小图标，按两级模型只该"按一下动一下"，
        //   不进循环动画（循环是二级分区那四个大图标才有的）。
        if (window.MOTION) MOTION.trigger(gear);
        openEditor();
      });

      S.canvasEl = wrap;
      S.crumbEl = crumb;

      wrap.addEventListener('mousemove', onCanvasMove);
      wrap.addEventListener('mouseleave', () => { setHover(null); });
      wrap.addEventListener('click', onCanvasClick);
    } else {
      S.canvasEl = card.querySelector('.ps-canvas');
      S.crumbEl = card.querySelector('.ps-crumb');
    }
    S.cardSearchEl = card.querySelector('.ps-card-search');
    // ⭐ 千问模式开关（2026-10-15）：放卡片左上角。
    //   ⚠ 别放底栏：卡只有 300 宽，底栏塞不下「千问模式 · 开」+「全部预设 · N 条」，开关会被挤到卡名后面裁掉一半（界面截图抓到）。
    S.qwenEl = card.querySelector('.ps-qwen');
    if (!S.qwenEl) { S.qwenEl = document.createElement('div'); S.qwenEl.className = 'ps-qwen'; card.appendChild(S.qwenEl); }
    // “工具与功能”现在是真实剪影素材，和人体部位共用位置、mask 命中、
    // 选中联动与素材编辑。只清理旧卡边按钮，旧动作和预设保持原样。
    card.querySelectorAll('[data-agent-inbox],[data-canvas-open],[data-camera-light-open],[data-tools-open]').forEach(node => node.remove());
    renderAssets();
    renderCrumb();
  }

  function innerEl() { return S.canvasEl && S.canvasEl.querySelector('.ps-canvas-inner'); }

  function previewAsset(a) {
    return window.V7ToolSilhouettes?.previewAsset?.(a, S.previewLayout) || a;
  }

  function styleAssetNode(node, a) {
    if (!node || !a) return;
    const rail = S.previewLayout.has(a.id), wrap = S.canvasEl, inner = innerEl();
    if (rail && wrap && inner) {
      const width = wrap.clientWidth || 1, height = wrap.clientHeight || 1;
      const canvasWidth = parseFloat(inner.style.width) || width;
      const canvasHeight = parseFloat(inner.style.height) || height;
      const canvasLeft = parseFloat(inner.style.left) || 0;
      const canvasTop = parseFloat(inner.style.top) || 0;
      node.wrap.style.left = ((canvasLeft + a.x * canvasWidth) / width * 100) + '%';
      node.wrap.style.top = ((canvasTop + a.y * canvasHeight) / height * 100) + '%';
      node.wrap.style.width = (a.w * canvasWidth / width * 100) + '%';
      node.wrap.style.height = (a.h * canvasHeight / height * 100) + '%';
    } else {
      node.wrap.style.left = (a.x * 100) + '%';
      node.wrap.style.top = (a.y * 100) + '%';
      node.wrap.style.width = (a.w * 100) + '%';
      node.wrap.style.height = (a.h * 100) + '%';
    }
  }

  function updatePreviewLayout() {
    const inner = innerEl(), wrap = S.canvasEl, api = window.V7ToolSilhouettes;
    if (!inner || !wrap || !api?.previewLayout) { S.previewLayout = new Map(); return; }
    const bounds = wrap.getBoundingClientRect();
    const scaleX = wrap.clientWidth ? bounds.width / wrap.clientWidth : 1;
    const scaleY = wrap.clientHeight ? bounds.height / wrap.clientHeight : 1;
    const obstacles = [...S.cardEl.querySelectorAll('.ps-gear')].map(node => {
      const rect = node.getBoundingClientRect();
      return {x:(rect.left-bounds.left)/scaleX,y:(rect.top-bounds.top)/scaleY,w:rect.width/scaleX,h:rect.height/scaleY};
    });
    // 钉出来的工具也要参与排位：没挪过的出厂工具由 previewLayout 排到画布旁边的空位
    const visibleAssets = P().assets().filter(asset => !isGroupedToolAsset(asset) || pinnedToolRow(asset));
    S.previewLayout = api.previewLayout(visibleAssets, {
      width: wrap.clientWidth, height: wrap.clientHeight,
      canvasWidth: parseFloat(inner.style.width), canvasHeight: parseFloat(inner.style.height),
      canvasLeft: parseFloat(inner.style.left), canvasTop: parseFloat(inner.style.top)
    }, obstacles);
    S.nodes.forEach((node, id) => {
      const source = P().assetById(id); if (!source) return;
      const a = previewAsset(source);
      styleAssetNode(node, a);
      node.wrap.toggleAttribute('data-preview-position', S.previewLayout.has(id));
    });
  }

  function hitPreview(ux, uy) {
    const api = window.V7ToolSilhouettes;
    const assets = P().assets().filter(asset => !isGroupedToolAsset(asset) || pinnedToolRow(asset));
    return api?.previewHitTest ? api.previewHitTest(assets, S.previewLayout, ux, uy) : P().hitTest(ux, uy);
  }

  // ── 把画布按【素材自己的长宽比】等比放进卡片，居中，两边留边 ──
  // ⚠ 别让画布铺满卡片。素材的 x/y/w/h 是相对画布的百分比，画布一旦被拉成卡片的形状
  //   (可用区 276×328 = 0.84)，跟原图(2000×3000 = 0.667)对不上，整个人就横向拉胖 26%。
  //   2026-09-10 用户一眼看出来的就是这个。
  function layoutCanvas() {
    const wrap = S.canvasEl, inner = innerEl();
    if (!wrap || !inner) return false;
    const r = {width: wrap.clientWidth, height: wrap.clientHeight};
    if (!r.width || !r.height) return false;      // 还没布局(卡片没显示) → 让调用方稍后重试
    const A = (P() && P().canvasAspect && P().canvasAspect()) || (2 / 3);
    let w = r.width, h = w / A;
    if (h > r.height) { h = r.height; w = h * A; }
    inner.style.width = w + 'px';
    inner.style.height = h + 'px';
    inner.style.left = ((r.width - w) / 2) + 'px';
    inner.style.top = ((r.height - h) / 2) + 'px';
    return true;
  }

  function renderAssets() {
    const inner = innerEl();
    if (!inner) return;
    if(S.selAsset === window.V7ToolSilhouettes?.hub?.assetId){
      const hub = P().assetById(S.selAsset);
      if(!hub || hub.hidden){S.selAsset = null;S.toolGroupOpen = false;S.toolGroup = null;S.host?.closeZone?.();}
    }
    S.canvasEl.querySelectorAll(':scope > .ps-asset').forEach(node => node.remove());
    inner.innerHTML = '';
    S.nodes.clear();
    // ⚠ 隐藏的素材不上画布（2026-09-14）。数据还在、预设还在，只是不显示。
    // 工具默认隐藏、从「工具与功能」列表进；用户在编辑页把某个工具设成显示，它就钉到剪影上（2026-09-29）。
    const list = canvasAssets();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'ps-canvas-empty';
      // ⚠ 分清"一个都没有"和"全被隐藏了"——后者说"去管理器打开"才有用，
      //   只说"剪影是空的"会让用户以为素材丢了。
      const total = P().assets().filter(asset => !isGroupedToolAsset(asset)).length;
      empty.textContent = total
        ? '所有部位都被隐藏了，点右下角齿轮打开'
        : (P().assets().length ? '工具已收进剪影图标内；点工具图标按分组查看' : '剪影是空的，点右下角齿轮加素材');
      inner.appendChild(empty);
      return;
    }
    layoutCanvas();
    updatePreviewLayout();
    list.forEach(a => {
      const wrap = document.createElement('div');
      wrap.className = 'ps-asset';
      wrap.dataset.assetId = a.id;
      if(a.id === window.V7ToolSilhouettes?.hub?.assetId){
        wrap.dataset.toolHub = '';
        wrap.tabIndex = 0;
        wrap.setAttribute('role','button');
        wrap.setAttribute('aria-label',a.name + '，打开工具分类');
        wrap.setAttribute('aria-pressed',String(a.id === S.selAsset));
        // Keyboard support does not change pointer hit testing: the normal
        // canvas alpha mask still decides whether a mouse click hits artwork.
        wrap.addEventListener('keydown',event=>{
          if(event.key !== 'Enter' && event.key !== ' ')return;
          event.preventDefault();event.stopPropagation();selectAsset(a.id);
        });
      }
      // Mark only untouched factory seeds for presentation styling. Renamed,
      // moved, resized, reordered, or otherwise edited user entries keep their
      // stored geometry and render through the normal path.
      const tool = window.V7ToolSilhouettes?.get(a.id);
      if (tool) {
        const seed = window.V7ToolSilhouettes.isFactoryAsset
          ? window.V7ToolSilhouettes.isFactoryAsset(a) : false;
        if (seed) wrap.dataset.factoryDefault = 'true';
        wrap.dataset.toolKey = tool.key;
        // 钉出来的工具：键盘也能直接开（鼠标命中仍由画布的 alpha / 小图标命中决定）
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('aria-label', a.name + '，打开工具');
        wrap.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation(); launchTool(tool);
        });
      }
      const display = previewAsset(a);
      styleAssetNode({wrap}, display);
      wrap.style.zIndex = String(1 + (a.z || 0));

      // ⚠⚠ 2026-10-11 审计补（docs/210 第五节报的 a11y 真问题）：
      //   a11y 首轮扫描实测：19 个 .ps-asset 里【只有 1 个】有可读名字 ——
      //   因为 role/aria-label/键盘支持原来只加在【工厂工具】和【钉出来的工具】上，
      //   普通素材（分类条目、用户自己的剪影）什么都没有：
      //     无 role、无 aria-label、tabindex=-1、里面的 img 也没有 alt
      //   ⇒ 键盘用户 Tab 不到它们、屏幕阅读器读出来是一片空白。
      //     而这恰恰是用户最常点的东西（选一个部位/预设）。
      //   ⇒ 补齐：每个素材都可聚焦、有名字、能用 Enter/空格选。
      //   ⚠ 上面工具那两段【不要删】—— 它们的 aria-label 语义不同
      //     （"打开工具分类" / "打开工具"），而且要先设 role 再被这里判重。
      //   ⚠ 只在还没设过的时候补，避免把工具那两段的专用文案覆盖掉。
      if (!wrap.hasAttribute('role')) {
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'button');
        // 名字用素材名；空名字（极少数）退成 id，至少别让读屏念"按钮"
        wrap.setAttribute('aria-label', String(a.name || a.id || '素材'));
        // ⚠ 只有"分类条目/可选中素材"才报选中态；工具入口是打开菜单、不是选中
        wrap.setAttribute('aria-pressed', String(a.id === S.selAsset));
        // ⚠ 键盘走和鼠标同一个入口 selectAsset()，不另造一条路径
        //   （另造路径就是这个项目反复栽的"两套做法会漂"）
        wrap.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation(); selectAsset(a.id);
        });
      }

      const img = document.createElement('img');
      img.className = 'ps-asset-img';
      img.draggable = false;
      img.src = a._dispUrl || '';
      // ⚠ alt 故意留空：这张图是【装饰性的】—— 名字已经写在容器的 aria-label 上，
      //   再给 img 一个 alt 会让读屏把同一个名字念两遍。
      //   a11y 扫描报"25 个图片没有 alt"指的是【没有 alt 属性】，
      //   空 alt（alt=""）是"明确告诉读屏跳过它"的正确写法，两者不一样。
      img.alt = '';
      wrap.appendChild(img);

      // 高亮层: 纯色块 + 用选区图当遮罩。颜色跟主题走, 不写死。
      const hl = document.createElement('div');
      hl.className = 'ps-asset-hl';
      if (a._maskUrl) {
        hl.style.webkitMaskImage = 'url("' + a._maskUrl + '")';
        hl.style.maskImage = 'url("' + a._maskUrl + '")';
        hl.style.webkitMaskSize = '100% 100%';
        hl.style.maskSize = '100% 100%';
        hl.style.webkitMaskRepeat = 'no-repeat';
        hl.style.maskRepeat = 'no-repeat';
      }
      wrap.appendChild(hl);

      (S.previewLayout.has(a.id) ? S.canvasEl : inner).appendChild(wrap);
      S.nodes.set(a.id, { wrap, img, hl });
    });
    applyZoom(false);
  }

  function canvasPoint(e) {
    const inner = innerEl();
    if (!inner) return null;
    const r = inner.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    // r 已经是被 transform 之后的矩形, 所以直接归一化就是画布坐标
    return { ux: (e.clientX - r.left) / r.width, uy: (e.clientY - r.top) / r.height };
  }

  function onCanvasMove(e) {
    const pt = canvasPoint(e);
    if (!pt) return;
    const hit = hitPreview(pt.ux, pt.uy);
    setHover(hit ? hit.id : null);
    S.canvasEl.style.cursor = hit && hit.id !== S.selAsset ? 'pointer' : 'default';
  }

  function setHover(id) {
    if (S.hoverAsset === id) return;
    S.hoverAsset = id;
    S.nodes.forEach((n, aid) => {
      const on = (aid === id && aid !== S.selAsset);
      n.hl.style.opacity = on ? '1' : '0';
    });
    renderHoverLabel();
  }

  function renderHoverLabel() {
    const inner = innerEl();
    if (!inner) return;
    let lbl = inner.querySelector('.ps-hover-label');
    // ⚠ 选中的那个部位【也要】显示名称和条数(2026-09-11 用户要求)。
    //   以前这里排除了 selAsset，结果是：点中一个部位之后，再把鼠标指回它身上
    //   反而什么都不显示 —— 而"我现在指的是哪个区域、里面有几条"恰恰是选中后最需要看的。
    //   (高亮层仍然排除选中项，那是另一回事：选中态有自己的样式，不需要再叠 hover 高亮。)
    const source = S.hoverAsset ? P().assetById(S.hoverAsset) : null;
    const a = source ? previewAsset(source) : null;
    if (!a) { if (lbl) lbl.remove(); return; }
    if (!lbl) { lbl = document.createElement('div'); lbl.className = 'ps-hover-label'; inner.appendChild(lbl); }
    // 钉出来的工具只显示名字：它分类下只有一条出厂启动项，显示「· 1」会让人以为里面有一条预设
    const n = pinnedToolRow(source) ? 0 : (P().countByCategory()[a.id] || 0);
    lbl.textContent = a.name + (n ? ' · ' + n : '');
    // 标签贴在素材右侧中间; 太靠右就翻到左边
    const cx = a.x + a.w, cy = a.y + a.h / 2;
    const flip = cx > 0.62;
    lbl.style.top = (cy * 100) + '%';
    // ⚠ 反缩放整个标签, 不能只改字号 —— 标签在被 scale 的 inner 里,
    //   只改字号的话内边距/圆角/边框仍然跟着放大, 推近后会变成一个巨大的气泡。
    const inv = 1 / Math.max(1, S.zoom.k);
    const place = side => {
      lbl.style.left = ((side ? a.x : cx) * 100) + '%';
      lbl.style.transformOrigin = side ? 'right center' : 'left center';
      lbl.style.transform = (side ? 'translate(-100%, -50%)' : 'translate(6px, -50%)') + ' scale(' + inv + ')';
    };
    lbl.style.marginLeft = lbl.style.marginTop = '';
    place(flip);
    // ⭐ 2026-10-20（用户截图：左边那个「…物 · 2」被框切掉一半）：素材很宽时右边缘 > 0.62 就翻到左边，
    //   可素材本身靠左 ⇒ 翻过去也放不下，被 .ps-canvas 的 overflow:hidden 切掉。
    //   放好以后量一下：哪边露得多用哪边，还露出去就整体推回框里（推近 / 平移后也一样）。
    const clip = S.canvasEl && S.canvasEl.getBoundingClientRect ? S.canvasEl.getBoundingClientRect() : null;
    if (clip && clip.width && lbl.getBoundingClientRect) {
      const pad = 6;
      const over = r => Math.max(0, clip.left + pad - r.left) + Math.max(0, r.right - (clip.right - pad));
      let r = lbl.getBoundingClientRect();
      if (over(r) > 0) {
        place(!flip);
        const r2 = lbl.getBoundingClientRect();
        if (over(r2) < over(r)) r = r2; else place(flip);
      }
      // margin 写在 inner 的坐标里，inner 被推近缩放了 ⇒ 屏幕上的像素要除以 inner 的实际倍数
      const ir = inner.getBoundingClientRect(), k = inner.offsetWidth ? ir.width / inner.offsetWidth : 1;
      const dx = Math.max(0, clip.left + pad - r.left) - Math.max(0, r.right - (clip.right - pad));
      const dy = Math.max(0, clip.top + pad - r.top) - Math.max(0, r.bottom - (clip.bottom - pad));
      if (dx && k) lbl.style.marginLeft = (dx / k) + 'px';
      if (dy && k) lbl.style.marginTop = (dy / k) + 'px';
    }
  }

  function onCanvasClick(e) {
    const pt = canvasPoint(e);
    if (!pt) return;
    const hit = hitPreview(pt.ux, pt.uy);
    // ⭐ 钉出来的工具：点一下直接展开这个工具的大卡（不选中、不推近，和工具列表里点那一行同一段代码）
    const pinned = hit && pinnedToolRow(hit);
    if (pinned) { launchTool(pinned); return; }
    if (hit) {
      // ⚠⚠ 点【已经选中】的那个部位：不重新渲染列表，但【必须把二级重新打开】。
      //   2026-09-14 用户实测的 bug：选了个部位 → 点别处让焦点跑掉 → 二级收起了，
      //   但 selAsset 还留着那个部位 —— 再点它就走到这里 return，
      //   于是"这个部位再也打不开了"，只能先点空白清掉选中再点一次。
      //   规矩：**入口要能重复触发**，不能因为"状态没变"就把入口堵死
      //   （同 feedback_one_shot_prompt_needs_entry 那类坑）。
      if (hit.id === S.selAsset) {
        if (S.host && S.host.openZone) S.host.openZone();   // 只重开，不重建列表
        return;
      }
      selectAsset(hit.id);
    } else {
      // 点剪影空白 → 收二级(用户 2026-09-11 定案)。同时把推近退回全景。
      S.selAsset = null; S.toolGroupOpen = false; S.toolGroup = null; S.hoverAsset = null; setHover(null); applyZoom(true); renderCrumb();
      if (S.host && S.host.closeZone) S.host.closeZone();
    }
  }

  function openToolGroups(groupKey) {
    S.selAsset = window.V7ToolSilhouettes?.hub?.assetId || null;
    S.toolGroupOpen = true;
    S.toolGroup = groupKey || null;
    S.filter = '';
    S.searchOpen = false;
    applyZoom(true);
    renderCrumb();
    fillZone();
    if (S.host && S.host.openZone) S.host.openZone();
  }

  function selectAsset(id) {
    if(id === window.V7ToolSilhouettes?.hub?.assetId){
      // Reopening the selected silhouette keeps the current group visible.
      if(S.selAsset === id && S.toolGroupOpen){S.host?.openZone?.();return;}
      return openToolGroups();
    }
    S.selAsset = id;
    S.toolGroupOpen = false;
    S.toolGroup = null;
    // ⚠ 选中的就是鼠标正指着的那个 —— hover 保持指向它，标签才会【立刻】出现。
    //   以前这里清成 null，鼠标不动就不会再触发 mousemove，
    //   表现是"点完一片空白、得晃一下鼠标名字才冒出来"(陈旧命中测试，记忆里栽过同类)。
    S.hoverAsset = id;
    S.filter = '';
    S.searchOpen = false;
    setHover(id);
    applyZoom(true);
    renderCrumb();
    fillZone();
    if (S.host && S.host.openZone) S.host.openZone();
  }

  // 推近到选中的素材; 其余变暗。整个 inner 一起 transform, 高亮层自动跟着。
  function applyZoom(animate) {
    const inner = innerEl();
    if (!inner) return;
    // ⚠ 每次都重算一遍画布尺寸: 卡片刚建出来时 rect 还是 0(拿不到布局),
    //   只在 renderAssets 里算一次的话, 首屏会留着 0 尺寸 → 剪影整个不显示。
    //   算不出来就下一帧再试, 试几次就放弃(别无限刷)。
    const laidOut = layoutCanvas();
    if (laidOut) updatePreviewLayout();
    if (!laidOut && !S._layoutRetry) {
      S._layoutRetry = 0;
      const retry = () => {
        if (layoutCanvas()) { S._layoutRetry = null; applyZoom(false); return; }
        if (++S._layoutRetry < 30) requestAnimationFrame(retry);
        else { S._layoutRetry = null; console.warn('[预设] 画布一直拿不到尺寸，剪影可能不显示'); if(window.ERR) ERR.report('PRESET_LAYOUT_FAILED',{message:'量了多次都拿不到画布尺寸'}); }
      };
      requestAnimationFrame(retry);
    }
    const source = S.selAsset ? P().assetById(S.selAsset) : null;
    const a = source ? previewAsset(source) : null;
    if (!a) {
      S.zoom = { x: 0, y: 0, k: 1 };
    } else {
      // 让这块占到画布约 62%, 但不超过 3.2 倍
      const k = Math.max(1, Math.min(3.2, 0.62 / Math.max(a.w, a.h)));
      const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      // 缩放原点设在 0 0, 所以偏移 = (0.5 - 中心) * k, 单位是画布百分比
      S.zoom = { x: (0.5 - cx * k) * 100, y: (0.5 - cy * k) * 100, k };
    }
    inner.style.transition = animate ? 'transform .5s cubic-bezier(.16,1,.3,1)' : 'none';
    inner.style.transformOrigin = '0 0';
    inner.style.transform = 'translate(' + S.zoom.x + '%,' + S.zoom.y + '%) scale(' + S.zoom.k + ')';
    S.nodes.forEach((n, aid) => {
      const dim = !!S.selAsset && aid !== S.selAsset;
      if(n.wrap.hasAttribute('aria-pressed'))n.wrap.setAttribute('aria-pressed',String(aid === S.selAsset));
      n.wrap.style.transition = animate ? 'opacity .35s ease' : 'none';
      n.wrap.style.opacity = dim ? '0.16' : '1';
    });
  }

  // ⭐ 千问模式开关（2026-10-15 用户定：放在剪影预设里）。画在卡片左上角的 .ps-qwen 里（renderCrumb 顺手重画）。
  function qwenToggle() {
    const on = !!(window.V7QwenMode && window.V7QwenMode.enabled());
    lastQwenMode = on;   // 界面现在画的是这一套（qwenModeChanged 拿它比）
    const b = document.createElement('button');
    b.className = 'ps-crumb-qwen' + (on ? ' on' : '');
    b.dataset.qwenMode = on ? 'on' : 'off';
    b.textContent = on ? '开源 · 开' : '开源模型';   // 开着时短一点：左上角再宽就压到顶部拖动条
    b.title = on ? '现在：剪影预设是开源模型那一套，所有出图走 ComfyUI 工作流（最高 2K）。点一下切回普通模式'
      : '切到开源模型模式：剪影预设换成开源模型那一套，原本走 Banana / GPT 的出图全部改走 ComfyUI 工作流（默认云端、现在免费）';
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!window.V7QwenMode || !window.V7QwenMode.setEnabled(!on)) toast('开源模型模式还没准备好（设置没读出来），请重启软件', 'warn');
    });
    return b;
  }

  function renderCrumb() {
    if (!S.crumbEl) return;
    syncCardSearch();
    const a = selectedAsset();
    S.crumbEl.innerHTML = '';
    if (S.qwenEl) {
      S.qwenEl.innerHTML = '';
      // 工具分组里不显示（工具不受千问模式影响）
      if (!S.toolGroupOpen && window.V7QwenMode) S.qwenEl.appendChild(qwenToggle());
    }
    if (S.toolGroupOpen) {
      const back = document.createElement('button');
      back.className = 'ps-crumb-back';
      back.textContent = '×';
      back.title = '返回剪影';
      back.addEventListener('click', ev => { ev.stopPropagation(); S.selAsset = null; S.toolGroupOpen = false; S.toolGroup = null; applyZoom(true); renderCrumb(); fillZone(); if (S.host?.closeZone) S.host.closeZone(); });
      const t = document.createElement('span');
      t.className = 'ps-crumb-cur';
      const group = window.V7ToolSilhouettes?.group?.(S.toolGroup);
      t.innerHTML = partIco(S.selAsset, 14) + '<span>' + esc(group ? group.title : (a?.name || '工具与功能')) + '</span>';
      S.crumbEl.append(back, t);
      return;
    }
    if (!a) {
      const b = document.createElement('button');
      b.className = 'ps-crumb-all';
      b.innerHTML = ico('person', 14) + '<span>全部预设 · ' + P().presets().filter(P().visible || (() => true)).length + ' 条</span>';
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        S.selAsset = null; S.toolGroupOpen = false; S.toolGroup = null; S.filter = ''; applyZoom(true); renderCrumb(); fillZone();
        if (S.host && S.host.openZone) S.host.openZone();
      });
      S.crumbEl.appendChild(b);
    } else {
      const back = document.createElement('button');
      back.className = 'ps-crumb-back';
      back.textContent = '×';
      back.title = '回到全部';
      back.addEventListener('click', ev => { ev.stopPropagation(); selectAsset(null); });
      const t = document.createElement('span');
      t.className = 'ps-crumb-cur';
      // 条数跟剪影上那个悬停标签保持一致 —— 两处显示同一件事，别一个有一个没有。
      const cn = (P().countByCategory()[a.id] || 0);
      // ⚠ 间距交给 .ps-crumb-cur 的 flex gap，别在这写内联 style —— 会和 CSS 打架
      t.innerHTML = partIco(a.id, 14, a.icon) + '<span>' + esc(a.name + (cn ? ' · ' + cn + ' 条' : '')) + '</span>';
      S.crumbEl.appendChild(back);
      S.crumbEl.appendChild(t);
    }
  }
  // ⭐ 2026-10-20 卡面「打字就搜」（用户定，代替 10-19 放在底栏最左边的放大镜 —— 那个放大镜在「全部预设 · 300 条」时
  //   被挤到左边、跟卡名打架、被框切掉）：
  //   · 鼠标在剪影卡上、而且软件窗口本来就是当前窗口 ⇒ 光标悄悄放进卡底的搜索框（看不见）；直接打字（中文输入法也行）就开搜。
  //     ⚠ 只在本来就是当前窗口时才放：不去抢 Photoshop 的键盘（用户刚在 PS 里，得先点一下轮椅）。
  //     ⚠ 别的输入框正拿着光标（在写提示词）时不抢；有对话框开着不抢。
  //   · 打了字搜索框才显出来，画布往上让一截；二级直接列搜到的预设（所有部位一起搜，中文 / 拼音首字母）。
  //   · Esc / 删光字 / 点 × ⇒ 收起，回到开搜前的样子（原来选着哪个部位就回哪个）。鼠标移出卡片不清空（回来接着挑）。
  //   · 搜的时候点了别的部位 / 工具 ⇒ 搜索自动收起（renderCrumb 里 syncCardSearch）。
  function cardSearchInput() { return S.cardSearchEl && S.cardSearchEl.querySelector('.ps-card-search-input'); }
  function editableFocused(el) {
    return !!(el && el !== document.body && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')));
  }
  function setCardSearchOpen(on) {
    if (!S.cardSearchEl || !S.cardEl || S.cardEl.classList.contains('ps-searching') === !!on) return;
    S.cardSearchEl.classList.toggle('on', !!on);
    S.cardEl.classList.toggle('ps-searching', !!on);
    // 画布底边挪了 —— 剪影按新尺寸重新摆（只重算尺寸，不动推近的 transform，免得打断正在播的推近动画）
    if (layoutCanvas()) updatePreviewLayout();
  }
  function syncCardSearch() {
    if (!S.cardEl || !S.cardEl.classList.contains('ps-searching')) return;
    if (S.filter && !S.searchOpen && !S.selAsset && !S.toolGroupOpen) return;
    const input = cardSearchInput();
    if (input) input.value = '';
    S.cardSearchPrev = null;
    setCardSearchOpen(false);
  }
  function closeCardSearch() {
    const input = cardSearchInput();
    if (input) input.value = '';
    const prev = S.cardSearchPrev;
    S.cardSearchPrev = null;
    setCardSearchOpen(false);
    if (!S.filter || S.searchOpen) return;
    S.filter = '';
    if (prev && prev.selAsset && P().assetById(prev.selAsset)) {
      if (prev.toolGroupOpen) openToolGroups(prev.toolGroup); else selectAsset(prev.selAsset);
      return;
    }
    renderCrumb(); fillZone();
  }
  function bindCardSearch(card, box) {
    const input = box.querySelector('.ps-card-search-input');
    let timer = null, composing = false;
    const grab = () => {
      if (!document.hasFocus || !document.hasFocus()) return;
      const active = document.activeElement;
      if (active === input || editableFocused(active)) return;
      if (document.querySelector('dialog[open]')) return;
      try { input.focus({ preventScroll: true }); } catch (_) { }
    };
    card.addEventListener('pointerenter', grab);
    card.addEventListener('pointermove', grab);   // 点了剪影（光标掉回页面上）以后接着打字也能搜
    card.addEventListener('pointerleave', () => { if (!input.value && !composing && document.activeElement === input) input.blur(); });
    const apply = () => {
      const q = input.value.trim();
      if (!q) { if (!composing) closeCardSearch(); return; }
      if (!S.cardSearchPrev) S.cardSearchPrev = { selAsset: S.selAsset, toolGroupOpen: S.toolGroupOpen, toolGroup: S.toolGroup };
      S.selAsset = null; S.toolGroupOpen = false; S.toolGroup = null; S.searchOpen = false;
      S.filter = q;
      applyZoom(true); renderCrumb(); fillZone();
      if (S.host && S.host.openZone) S.host.openZone();
    };
    const run = () => { if (composing) return; clearTimeout(timer); timer = setTimeout(apply, 180); };
    input.addEventListener('compositionstart', () => { composing = true; setCardSearchOpen(true); });
    input.addEventListener('compositionend', () => { composing = false; run(); });
    input.addEventListener('input', () => { if (input.value) setCardSearchOpen(true); run(); });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || composing || e.isComposing) return;
      e.preventDefault(); e.stopPropagation();
      clearTimeout(timer);
      closeCardSearch();
      input.blur();
    });
    box.querySelector('.ps-card-search-x').addEventListener('click', e => { e.stopPropagation(); clearTimeout(timer); closeCardSearch(); });
  }

  // ═══════════════════════════════════════════════════════════
  //  二级: 预设列表(单张长卡)
  // ═══════════════════════════════════════════════════════════
  function currentList() {
    const category = S.toolGroupOpen ? null : S.selAsset;
    return S.filter ? P().search(S.filter, category) : P().listByCategory(category);
  }

  // ── 列表几何自检 ──
  // ⚠ "滚不动 / 滚太快"这类问题必须【量出来】不能猜(CLAUDE.md 铁律 17)。
  //   可视高度 vs 内容高度一比，就知道该不该能滚。
  // ⚠ 只在【可见】的时候量 —— 隐藏元素(display:none)量出来全是 0，
  //   那种 0 是假的，报出去只会把人带沟里。量不到就明说"隐藏中"。
  let lastGeom = '';
  function measureList() {
    const z = S.zoneEl;
    const l = z && z.querySelector('.pz-list');
    if (!l) return;
    const n = (z.querySelectorAll('.pz-row') || []).length;
    let msg;
    if (!l.clientHeight) {
      msg = '[预设] 列表 ' + n + ' 条 · 当前隐藏，量不了高度';
    } else {
      msg = '[预设] 列表 ' + n + ' 条 · 可视 ' + l.clientHeight + 'px · 内容 ' + l.scrollHeight
        + 'px · ' + (l.scrollHeight > l.clientHeight + 1 ? '可滚' : '⚠ 不用滚(一屏放得下)');
    }
    if (msg === lastGeom) return;          // 同样的话不重复刷
    lastGeom = msg;
    console.log(msg);
    if (window.__TAURI__ && window.__TAURI__.core) {
      window.__TAURI__.core.invoke('debug_log', { message: msg }).catch(() => { });
    }
  }

  // 剪影卡的功能入口统一在这里展示。每个分组仍然复用原来的预设、
  // 工作面和迁移动作，因而只是换了入口层级，不会丢掉旧数据或 API。
  // ⚠ 2026-09-29：「相机与灯光」拆成「3D 镜头」「灯光」两个独立工具（tool-silhouettes 定义，能钉到剪影上），
  //   这里原来那条合并入口删掉，不然列表里同一个工作区出现三次。action 'camera-light' 的处理留着（兼容旧调用）。
  //   「基础工具」这条留着：它打开的是 __tool__ 素材下的预设列表 —— 用户自己另存的抠像/解析/指哪抠哪/辉光
  //   变体只在那里；出厂那 4 个已经是上面的独立工具了，所以改名「基础工具预设」免得看着像重复。
  const TOOL_GROUP_EXTRAS = {
    creative: [
      {key:'canvas', title:'幕布创作', icon:'puzzle', help:'打开幕布创作工作面', action:'canvas'}
    ],
    manage: [
      {key:'agent-inbox', title:'Agent 收件箱', icon:'sparkles', help:'管理 Agent 生成的预设和导入文件', action:'agent-inbox'},
      {key:'legacy-tools', title:'基础工具预设', icon:'wrench', help:'查看你另存的抠像、人体解析、指哪抠哪和辉光预设', action:'legacy-tools'},
      {key:'migrate', title:'V6 搬家', icon:'truck', help:'从 V6 搬入预设，已有项目会自动跳过', action:'migrate'},
      {key:'migration-report', title:'搬家报告', icon:'note', help:'查看搬家结果或恢复搬家前的预设', action:'migration-report'}
    ]
  };
  // ── 工具平铺列表（2026-09-28）──────────────────────────────
  //  用户定案：不再"分类 → 工具 → 再点一次工具"。所有功能平铺成一份列表，
  //  行上保留收藏星和拖拽排序，点一行直接进三级（能就地就就地，塞不下才弹窗）。
  //  分类改为"不替用户分" —— 二级本来就有星标置顶，用户自己排更顺手。
  //
  //  ⚠ 工具列表按 tool-silhouettes 的 definitions 拼（出厂工具预设由 preset-store 启动时 ensure 进库，
  //    查不到时 toolPresetFrom 现造一条）；点行不走 loadPresetById。
  //  ⚠ 退役工具名单 RETIRED_TOOLS 定义在本文件最上面（剪影画布也要用，放这里会撞暂时性死区）。

  function toolListEntries() {
    const api = window.V7ToolSilhouettes;
    const rows = (api?.definitions || [])
      .filter(row => !RETIRED_TOOLS.has(row.key))
      .map(row => ({
        row, key: row.key, title: row.title, help: row.description,
        // preset 用来挂收藏星。工具预设是启动时由 store 的 ensure() 建进库的，
        // 所以这里按 presetId 查得到（查不到时星标就不显示，不影响其它功能）。
        preset: P().presetById(row.presetId)
      }));
    // 五个别处接的入口没有独立 definition，平铺到末尾（2026-09-29 相机与灯光拆成两个正式工具后少了一个）。
    // 保留原 action 语义，不改变它们各自打开的东西。
    const extras = Object.values(TOOL_GROUP_EXTRAS).flat().map(entry => ({
      key: entry.key, title: entry.title, help: entry.help, action: entry.action
    }));
    return rows.concat(extras);
  }

  // 工具展示顺序缓存。null = 还没从库里读过。
  // ⚠ 顺序存在 meta 的 toolOrder.v1，是【异步】读的；列表本身同步渲染。
  //   所以先按缓存画一帧，读完再重画一次 —— 差一帧，用户无感。
  let toolOrderCache = null;
  let toolOrderLoading = false;
  function orderedToolEntries() {
    const saved = Array.isArray(toolOrderCache) ? toolOrderCache : [];
    const index = new Map();
    saved.forEach((key, i) => index.set(key, i));
    // sort 在现代 JS 里是稳定的：都没排过的项会保持 definitions 的出厂顺序。
    return toolListEntries().slice().sort((a, b) => {
      const as = !!(a.preset && a.preset.starred), bs = !!(b.preset && b.preset.starred);
      if (as !== bs) return as ? -1 : 1;      // 收藏置顶，与预设列表同一套语义
      const ao = index.has(a.key) ? index.get(a.key) : 1e9;
      const bo = index.has(b.key) ? index.get(b.key) : 1e9;
      return ao - bo;
    });
  }
  function toolPresetFrom(row, presetId) {
    // 造一条与库外工具对应的一级预设对象。形状对齐 preset-store 的 normalizePreset：
    // 缺 content 会被当提示词处理，所以 content 给合法 JSON 字符串。
    const existing = P().presetById(presetId);
    if (existing) return existing;
    return {
      id: presetId,
      title: row.title,
      kind: row.kind,
      category: row.assetId,
      content: '{}',
      _isFactory: true,
      toolLauncher: row.key,
      source: 'builtin-tool',
      starred: false
    };
  }
  // 打开一个工具：工具列表点一行、剪影上点钉出来的工具，都走这一个函数（入口多一个就多一份跑偏的逻辑）。
  // 有大卡面板就原地展开大卡；没有的退回三级卡路径，不静默失败。
  function launchTool(row) {
    if (!row || RETIRED_TOOLS.has(row.key)) return;
    const preset = toolPresetFrom(row, row.presetId);
    const TW = window.V7ToolWorkbench;
    if (TW && TW.has(row.key) && TW.canOpen()) {
      return TW.open(row.key, preset);
    }
    // ⭐ 2026-09-29：本来就没有大卡的工具（抠像/人体解析/指哪抠哪/辉光、3D 镜头、灯光）直接打开它自己的界面，
    //   不先绕一张「工具工作面」启动卡再让用户点一次「打开」。
    //   ⚠ 有大卡的工具（只是大卡此刻开不了）绝不走这条 —— 那会打开已经收掉的老弹窗；它们照旧退回三级卡。
    if (!(TW && TW.has(row.key)) && window.V7ToolSilhouettes && window.V7ToolSilhouettes.available(window, preset)) {
      return Promise.resolve()
        .then(() => window.V7ToolSilhouettes.open(window, preset))
        .catch(error => window.ERR?.report(error.code || 'TOOL_OPEN_FAILED', { message: String(error.message || error) }));
    }
    return loadPreset(preset);
  }
  // ⭐ 2026-09-29 用户定案：抠像 / 人体解析 / 指哪抠哪 / 辉光 拆成 4 个独立工具（能钉到剪影上）。
  //   它们的参数面板（本文件 fillToolDetail 的 matting/segment/sam2/glow 分支）和执行链
  //   （ui.html 的 startMatting/startSegment/startSAM2、glow-integration.js 的 startGlow）早就写全并实测过，
  //   这里只做入口：点工具 = 选中那条出厂预设 → 三级卡直接出真参数面板 → ▶ 跑原来那条链。
  //   出厂预设由 preset-store 启动时 ensure 进库（被删了下次启动会补回来）；真找不到就明说，不静默。
  const BASE_TOOL_PRESETS = { matting: '__matting_default__', segment: '__segment_default__', sam2: '__sam2_default__', glow: '__glow_default__' };
  window.V7BaseTools = {
    open(mode) {
      const id = BASE_TOOL_PRESETS[mode];
      const p = id ? P().presetById(id) : null;
      if (!p) {
        const label = TOOL_KIND_LABEL[mode] || String(mode || '');
        return Promise.reject(Object.assign(new Error('没有找到「' + label + '」的出厂预设，请重新打开软件（启动时会自动补回）'), { code: 'TOOL_OPEN_FAILED' }));
      }
      loadPreset(p);
      return Promise.resolve();
    }
  };
  function fillToolList(body) {
    const list = body.querySelector('.pz-list');
    const foot = body.querySelector('.pz-foot');
    if (!list) return;
    const q = (S.filter || '').trim().toLowerCase();
    const entries = orderedToolEntries().filter(entry => {
      if (!q) return true;
      return entry.title.toLowerCase().includes(q) || (entry.help || '').toLowerCase().includes(q);
    });
    const paint = () => {
      list.innerHTML = '';
      if (!entries.length) list.appendChild(emptyStateEl());
      else entries.forEach(entry => list.appendChild(toolListRow(entry)));
    };
    if (window.V7Motion) window.V7Motion.listFlip(list, row => row.dataset.toolKey, paint); else paint();
    if (foot) foot.textContent = entries.length + ' 个功能' + (q ? '（搜索）' : '');
    bindToolDragSort(list, body);
    // 顺序是异步读的：读完再画一次。用 inFlight 防止重画触发重读形成循环。
    if (toolOrderCache === null && !toolOrderLoading && typeof P().toolOrder === 'function') {
      toolOrderLoading = true;
      P().toolOrder().then(keys => {
        toolOrderCache = keys;
        toolOrderLoading = false;
        const cur = S.zoneEl?.querySelector('.pz-body') || S.zoneEl;
        if (S.toolGroupOpen && cur && cur.isConnected) fillToolList(cur);
      }).catch(() => { toolOrderLoading = false; toolOrderCache = []; });
    }
  }
  function toolListRow(entry) {
    const row = document.createElement('div');
    row.className = 'pz-row';
    row.dataset.toolKey = entry.key;
    row.title = entry.help || entry.title;

    // ⚠ 2026-09-28 用户定案：工具行【不放图标】。
    //   文字已经说清是什么功能，图标是噪音，而且一排图标+一串文字之后
    //   收藏星就没地方站了 —— 星标是这一行最该看的东西。
    //   （工具剪影那套大图标仍然用在剪影画布上，那边需要图形识别。）

    // 收藏星：与预设行同一套语义（实心=已收藏，置顶排序）。★ 是真正的选中态。
    // ⚠ 工具预设【在库里】（preset-store 启动时会调 V7ToolSilhouettes.ensure() 建进去），
    //   所以 starred 能正常持久化，和普通预设共用同一条保存链路。
    const preset = entry.row ? P().presetById(entry.row.presetId) : null;
    if (preset) {
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'pz-star' + (preset.starred ? ' on' : '');
      star.innerHTML = ico(preset.starred ? 'starFilled' : 'starOutline', 14) || (preset.starred ? '★' : '☆');
      star.title = preset.starred ? '取消收藏' : '收藏（置顶）';
      star.setAttribute('aria-label', (preset.starred ? '取消收藏：' : '收藏：') + preset.title);
      star.setAttribute('aria-pressed', String(!!preset.starred));
      star.addEventListener('click', async ev => {
        ev.stopPropagation();
        preset.starred = !preset.starred;
        await P().savePreset(preset);
        const body = S.zoneEl?.querySelector('.pz-body') || S.zoneEl;
        if (body) fillToolList(body);
      });
      row.appendChild(star);
    }

    const t = document.createElement('span');
    t.className = 'pz-row-title';
    t.textContent = entry.title;
    row.appendChild(t);

    row.addEventListener('click', ev => {
      ev.stopPropagation();
      if (entry.row) {
        // ⭐ 2026-09-28：工具改成【原地展开】成 880×400 的工作面，不再走三级卡那套
        //   （点行 → 三级卡 → 再点「打开工作面」→ 弹窗，三跳）。剪影上钉出来的工具也走同一个 launchTool。
        return launchTool(entry.row);
      }
      const action = entry.action;
      if (action === 'canvas') return Promise.resolve(window.V7CanvasWorkbench?.open?.()).catch(error => window.ERR?.report(error.code || 'CANVAS_FAILED', {message:String(error.message || error)}));
      if (action === 'camera-light') return Promise.resolve(window.V7CameraLight?.open?.()).catch(error => window.ERR?.report(error.code || 'LIGHTING_FAILED', {message:String(error.message || error)}));
      if (action === 'agent-inbox' || action === 'legacy-tools') return selectAsset(action === 'agent-inbox' ? '__agent_inbox__' : '__tool__');
      if (action === 'migrate' || action === 'migration-report') return zoneAction(action);
    });
    return row;
  }

  // ── 工具列表拖拽排序 ────────────────────────────────────────
  //  对照预设列表的 bindDragSort：指针事件那套实现照搬（透明置顶壳上不能用
  //  原生 HTML5 拖放的 ghost image），只有【存顺序那一步】换掉 ——
  //  预设是按分类整体重写，工具是写一份独立的 key 顺序到 meta。
  function bindToolDragSort(list, body) {
    if (!list || list._toolDragBound) return;
    list._toolDragBound = true;
    let dragging = null, startY = 0, rows = [], moved = false, pending = false;

    list.addEventListener('pointerdown', e => {
      if (e.button !== 0 || pending) return;
      const row = e.target.closest && e.target.closest('.pz-row');
      if (!row || e.target.closest('.pz-star')) return;
      if (S.filter) return;                     // 搜索结果不排序（顺序是分数序）
      dragging = row; startY = e.clientY; moved = false;
      rows = [...list.querySelectorAll('.pz-row')];
      row.setPointerCapture && row.setPointerCapture(e.pointerId);
    });

    list.addEventListener('pointermove', e => {
      if (!dragging || !dragging.isConnected) return;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      moved = true;
      dragging._dragged = true;
      dragging.classList.add('dragging');
      dragging.style.transform = 'translateY(' + dy + 'px)';
      const h = dragging.offsetHeight || 26;
      const from = rows.indexOf(dragging);
      const to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
      rows.forEach((r, i) => {
        if (r === dragging) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -h;
        else if (from > to && i < from && i >= to) shift = h;
        r.style.transition = 'transform .12s ease';
        r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    });

    const finish = async e => {
      if (!dragging) return;
      const row = dragging; dragging = null;
      const reset = () => {
        row.classList.remove('dragging');
        rows.forEach(item => { item.style.transform = ''; item.style.transition = ''; });
      };
      const current = () => !S.filter && list.isConnected && S.zoneEl?.querySelector('.pz-list') === list && row.isConnected;
      if (e.type === 'pointercancel' || !current()) { reset(); row._dragged = false; return; }
      if (!moved) {
        row.classList.remove('dragging');
        rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
        return;
      }
      const dy = e.clientY - startY;
      const h = row.offsetHeight || 26;
      const from = rows.indexOf(row);
      const to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
      if (to !== from) {
        // 与预设列表同一条原则：写盘期间【不要先清 transform】，否则会看到"先跳回原位、
        // 再跳到新位置"的两跳闪烁。让各行保持拖后的视觉位置，等新列表渲染好一起替换。
        const keys = rows.map(r => r.dataset.toolKey).filter(Boolean);
        keys.splice(to, 0, keys.splice(from, 1)[0]);
        pending = true;
        list.setAttribute('aria-busy', 'true');
        try {
          if (typeof P().saveToolOrder === 'function') await P().saveToolOrder(keys);
          toolOrderCache = keys;
          const cur = S.zoneEl?.querySelector('.pz-body') || S.zoneEl;
          if (current() && S.toolGroupOpen && cur) fillToolList(cur);
        } catch (error) {
          if (window.ERR) ERR.report('PRESET_SAVE_FAILED', { message: String(error.message || error), context: { operation: '工具排序' } });
          reset();
          const cur = S.zoneEl?.querySelector('.pz-body') || S.zoneEl;
          if (current() && S.toolGroupOpen && cur) fillToolList(cur);
        } finally {
          pending = false;
          list.removeAttribute('aria-busy');
        }
      } else {
        rows.forEach(r => { r.style.transition = 'transform .14s var(--ease-out)'; r.style.transform = ''; });
        setTimeout(() => {
          rows.forEach(r => { r.style.transition = ''; });
          row.classList.remove('dragging');
        }, 160);
      }
      setTimeout(() => { row._dragged = false; }, 0);
    };
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
  }

  // ═══════════════════════════════════════════════════════════
  //  ⭐ 历史提示词：提示词框右上角的小时钟（2026-10-20 用户定）。
  //   来历：10-19（docs/250 第 8 条，测试用户 A：「以前调用用过的提示词很方便，现在在预设这一块很难调动使用过的提示词」）
  //   先放在剪影预设二级右上角；10-20 用户要挪进【二级、三级两个提示词框】的右上角，预设列表那个去掉。
  //   · 点时钟 = 这个框原地变成「最近用过的提示词」；点一条 = 填回框里（替换）并回到提示词框。⚠ 不再自动切到原预设。
  //   · 没选、再点一下时钟 = 原样回到提示词框（框里的字没动过）。二级、三级两个框各开各的（S.promptHist）。
  //   · 开着的时候换了预设 ⇒ 自动回到提示词框（不然选了预设看到的还是历史列表）。
  //   数据 = V7ProductData.recentPrompts（同一段提示词合并成一条）；填回走 V7HistoryPrompts.apply（上下文校验、工具预设拦截都在里面）。
  //   ⚠ 千问模式下也显示全部（提示词本身不分两套，用户 10-19 定）。
  // ═══════════════════════════════════════════════════════════
  const RECENT_PAGE = 20;
  function histButtonHtml(on) {
    const tip = on ? '回到提示词' : '最近用过的提示词';
    return '<button type="button" class="pz-recent-btn pd-hist-btn' + (on ? ' on' : '') + '" data-hist-toggle title="' + tip + '" aria-label="' + tip + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + ico('clock', 14) + '</button>';
  }
  function timeAgo(iso) {
    // ⭐ 2026-10-22：全软件统一走 V7Format（ui-format.js）；下面是它没加载时的兜底
    if (window.V7Format) return window.V7Format.ago(iso);
    const t = Date.parse(iso || '');
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    const d = new Date(t);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  // 只重画某一个框（二级 'zone' / 三级 'detail'），画完把 promptTarget 还回去
  function redrawPromptTarget(target) {
    const saved = promptTarget;
    promptTarget = target;
    try { fillDetail(false); } finally { promptTarget = saved; }
  }
  function bindHistButton(body, target) {
    const btn = body.querySelector('[data-hist-toggle]');
    if (!btn) return;
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const open = !S.promptHist[target];
      S.promptHist[target] = open;
      S.promptHistPreset[target] = St.presetId;
      redrawPromptTarget(target);
    });
  }
  function renderPromptHistory(area, target) {
    area.innerHTML =
      '<div class="pd-hist-title">' + ico('clock', 13) + '<span>最近用过的提示词</span></div>' +
      '<input class="pz-input pd-hist-q" type="text" placeholder="搜索用过的提示词" value="' + esc(S.recentQuery) + '">' +
      '<div class="pd-hist-list"></div>' +
      '<button type="button" class="pd-hist-more" hidden>再看 ' + RECENT_PAGE + ' 条</button>';
    const list = area.querySelector('.pd-hist-list'), more = area.querySelector('.pd-hist-more');
    let page = 0, hasMore = true, shown = [];
    const appendPage = () => {
      const api = window.V7ProductData;
      if (!hasMore || !api || typeof api.recentPrompts !== 'function') return;
      let rows = [];
      try { rows = api.recentPrompts(RECENT_PAGE + 1, S.recentQuery, page * RECENT_PAGE) || []; } catch (e) { if (window.ERR) ERR.report('HISTORY_OPERATION_FAILED', { message: String(e && e.message || e) }); }
      hasMore = rows.length > RECENT_PAGE;
      rows.slice(0, RECENT_PAGE).forEach(item => {
        const i = shown.push(item) - 1;
        const row = document.createElement('button');
        row.type = 'button'; row.className = 'pz-recent-row'; row.dataset.recentI = String(i);
        const meta = (item.presetTitle || '自定义提示词') + (timeAgo(item.lastUsedAt) ? ' · ' + timeAgo(item.lastUsedAt) : '') + (item.useCount > 1 ? ' · 用过 ' + item.useCount + ' 次' : '');
        row.title = '点一下填回提示词框';
        row.innerHTML = '<div class="pz-recent-text">' + esc(item.prompt) + '</div><div class="pz-recent-meta">' + esc(meta) + '</div>';
        list.appendChild(row);
      });
      page++;
      if (!shown.length) list.innerHTML = '<div class="pz-recent-empty">' + (S.recentQuery ? '没有找到包含「' + esc(S.recentQuery) + '」的提示词' : '还没有用过的提示词。<br>生成过一次，这里就会记下来。') + '</div>';
      more.hidden = !hasMore;
    };
    appendPage();
    more.addEventListener('click', ev => { ev.stopPropagation(); appendPage(); });
    list.addEventListener('click', ev => {
      const row = ev.target.closest && ev.target.closest('[data-recent-i]');
      if (!row) return;
      ev.stopPropagation();
      applyPromptHistory(shown[Number(row.dataset.recentI)], target);
    });
    const input = area.querySelector('.pd-hist-q');
    let t = null;
    const run = () => {
      if (input._composing) return;
      clearTimeout(t);
      t = setTimeout(() => { S.recentQuery = input.value; list.innerHTML = ''; page = 0; hasMore = true; shown = []; appendPage(); }, 180);
    };
    input.addEventListener('compositionstart', () => { input._composing = true; });
    input.addEventListener('compositionend', () => { input._composing = false; run(); });
    input.addEventListener('input', run);
  }
  async function applyPromptHistory(item, target) {
    if (!item || !window.V7HistoryPrompts) return;
    S.promptHist[target] = false;
    try {
      // → setPromptText → refreshAllPromptViews：两个框都按新词重画（这个框已经回到提示词）
      await window.V7HistoryPrompts.apply({ prompt: String(item.prompt || '') }, { quiet: true });
      redrawPromptTarget(target);
      toast('已填好这条提示词', 'info');
    } catch (e) {
      S.promptHist[target] = true;
      if (e && e.code === 'HISTORY_CONTEXT_CHANGED') return;
      toast(String(e && e.message || e), 'warn');
    }
  }

  function fillZone() {
    const z = S.zoneEl;
    if (!z) return;
    const body = z.querySelector('.pz-body') || z;
    const a = selectedAsset();
    if (S.toolGroupOpen) {
      // ⚠ 这里必须复用 .pz-list / .pz-foot 两个 class。
      //   攒格滚轮那条 window 捕获监听认的就是预设二级上的 .pz-list ——
      //   换成别的容器名，滚轮会整个漏到全局监听、变成"滚一下就切主卡"。
      //   （2026-09-28 用户要求：所有菜单都不许翻页，改成攒够了才翻卡。）
      body.innerHTML = '<div class="pz-head"><div class="pz-title">' + ico('puzzle', 15) + '<span>工具与功能</span></div><div class="pz-tools">' +
        '<button type="button" class="pz-tb" data-act="search" aria-label="搜索工具" title="搜索工具">' + ico('search') + '<span>搜索</span></button>' +
        '</div></div>' +
        '<div class="pz-search' + (S.searchOpen ? '' : ' hidden') + '">' +
        '<input class="pz-input" type="text" placeholder="搜索工具" value="' + esc(S.filter) + '">' +
        '</div>' +
        '<div class="pz-list"></div>' +
        '<div class="pz-foot"></div>';
      fillToolList(body);
      body.querySelectorAll('.pz-tb').forEach(b => b.addEventListener('click', ev => { ev.stopPropagation(); zoneAction(b.dataset.act); }));
      const toolInput = body.querySelector('.pz-input');
      if (toolInput) {
        let tt = null;
        const runTool = () => {
          if (toolInput._composing) return;
          clearTimeout(tt);
          tt = setTimeout(() => { S.filter = toolInput.value; fillToolList(body); }, 180);
        };
        toolInput.addEventListener('compositionstart', () => { toolInput._composing = true; });
        toolInput.addEventListener('compositionend', () => { toolInput._composing = false; runTool(); });
        toolInput.addEventListener('input', runTool);
        if (S.searchOpen) setTimeout(() => { try { toolInput.focus(); } catch (_) { } }, 30);
      }
      return;
    }
    // ⚠⚠ 图标和文字必须【分开】存：
    //   下面那行 title 属性要走 esc()，而 SVG 一旦被 esc 就会变成一串可见的 &lt;svg...
    //   （2026-09-14 差点栽这儿）。所以 titleText 给 esc，titleIco 直接拼。
    // ⭐ 2026-10-20：卡面打字搜索时（S.filter 有、二级自己的搜索框没开）标题写「搜索：xx」，一眼知道这是搜索结果
    const cardSearching = !a && !!S.filter && !S.searchOpen;
    const titleText = a ? a.name : (cardSearching ? '搜索：' + S.filter : '全部预设');
    const titleIco  = a ? partIco(a.id, 15, a.icon) : ico(cardSearching ? 'search' : 'person', 15);

    body.innerHTML =
      '<div class="pz-head">' +
      // ⭐⭐ 2026-10-14（用户定）：张数/抗截断放【右上角】那一行。
      //   标题+快捷条同一行：标题弹性收缩、快捷条靠右固定（.pd-quick{margin-left:auto}）。
      //   ⚠ 200px 宽的头行很挤 —— 标题已经 overflow:hidden + ellipsis，
      //     快捷条 flex:none 不会把标题挤出去，只会让标题让位。
      '<div class="pz-quickrow">' +
      '<div class="pz-title" title="' + esc(titleText) + '">' + titleIco + '<span>' + esc(titleText) + '</span></div>' +
      ((window.V7QuickParams && typeof V7QuickParams.html === 'function') ? V7QuickParams.html() : '') +
      '</div>' +
      '<div class="pz-tools">' +
      '<button type="button" class="pz-tb" data-act="search" aria-label="搜索预设" title="搜索">' + ico('search') + '<span>搜索</span></button>' +
      '<button type="button" class="pz-tb" data-act="new" aria-label="把当前提示词存成新预设" title="把当前提示词存成预设">' + ico('plus') + '<span>新建</span></button>' +
      '<button type="button" class="pz-tb" data-act="import" aria-label="导入预设文件" title="导入预设文件">' + ico('arrowDown') + '<span>导入</span></button>' +
      '<button type="button" class="pz-tb" data-act="export" aria-label="导出这一组预设" title="导出这一组预设">' + ico('arrowUp') + '<span>导出</span></button>' +
      '</div>' +
      '</div>' +
      '<div class="pz-search' + (S.searchOpen ? '' : ' hidden') + '">' +
      '<input class="pz-input" type="text" placeholder="搜索(中文/拼音首字母)" value="' + esc(S.filter) + '">' +
      '</div>' +
      '<div class="pz-list"></div>' +
      '<div class="pz-foot"></div>';

    const list = body.querySelector('.pz-list');
    const items = currentList();
    if (!items.length) list.appendChild(emptyStateEl());
    else items.forEach(p => list.appendChild(presetRow(p)));

    const foot = body.querySelector('.pz-foot');
    foot.textContent = items.length + ' 条' + (S.filter ? '（搜索）' : (S.selAsset ? '' : '（全部）'));

    requestAnimationFrame(measureList);

    body.querySelectorAll('.pz-tb').forEach(b => {
      b.addEventListener('click', ev => { ev.stopPropagation(); zoneAction(b.dataset.act); });
    });
    // ⭐⭐ 2026-10-14：预设列表卡右上角那两个快捷参数，把点按接上。
    if (window.V7QuickParams && typeof V7QuickParams.bind === 'function') V7QuickParams.bind(body);
    const input = body.querySelector('.pz-input');
    if (input) {
      let t = null;
      const run = () => {
        if (input._composing) return;
        clearTimeout(t);
        t = setTimeout(() => { S.filter = input.value; refreshListOnly(); }, 180);
      };
      input.addEventListener('compositionstart', () => { input._composing = true; });
      input.addEventListener('compositionend', () => { input._composing = false; run(); });
      input.addEventListener('input', run);
      if (S.searchOpen) setTimeout(() => { try { input.focus(); } catch (_) { } }, 30);
    }
    bindDragSort(list);
  }

  // 只重画列表, 不动搜索框(否则每打一个字光标就跳回开头)
  function refreshListOnly() {
    const z = S.zoneEl; if (!z) return;
    const body = z.querySelector('.pz-body') || z;
    // ⚠ 工具视图开着时不能走下面的预设重画 —— currentList() 读的是预设库，
    //   会把工具列表整个覆盖成预设列表（"新建预设/收藏星"等回调都会走到这里）。
    //   2026-09-28 加的工具平铺列表，这是它唯一的越界入口。
    if (S.toolGroupOpen) { fillToolList(body); return; }
    const list = z.querySelector('.pz-list'); if (!list) { fillZone(); return; }
    const items = currentList();
    // 2026-10-22（docs/263 第三批）：增删、收藏、拖完排序时行滑到新位置，新加的淡入（原来直接跳变）
    const paint = () => {
      list.innerHTML = '';
      if (!items.length) list.appendChild(emptyStateEl());
      else items.forEach(p => list.appendChild(presetRow(p)));
    };
    if (window.V7Motion) window.V7Motion.listFlip(list, row => row.dataset.presetId, paint); else paint();
    const foot = z.querySelector('.pz-foot');
    if (foot) foot.textContent = items.length + ' 条' + (S.filter ? '（搜索）' : (S.selAsset ? '' : '（全部）'));
    bindDragSort(list);
  }

  function presetRow(p) {
    const row = document.createElement('div');
    row.className = 'pz-row' + (p.id === S.selPreset ? ' sel' : '');
    row.dataset.presetId = p.id;

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'pz-star' + (p.starred ? ' on' : '');
    // ⭐ 收藏星是真正的"选中态"：实心=已收藏，空心=没收藏。
    //   ⚠ 两个图形的外轮廓必须完全一致，只差填充 —— 否则切换时形状会跳。
    star.innerHTML = ico(p.starred ? 'starFilled' : 'starOutline', 14) || (p.starred ? '★' : '☆');
    star.title = p.starred ? '取消收藏' : '收藏（置顶）';
    star.setAttribute('aria-label', (p.starred ? '取消收藏：' : '收藏：') + p.title);
    star.setAttribute('aria-pressed', String(!!p.starred));
    star.addEventListener('click', async ev => {
      ev.stopPropagation();
      p.starred = !p.starred;
      await P().savePreset(p);
      refreshListOnly();
    });

    const t = document.createElement('span');
    t.className = 'pz-row-title';
    t.textContent = p.title;
    t.title = p.title;

    row.appendChild(star);
    const toolIcon=window.V7ToolSilhouettes?.getPreset(p);
    if(toolIcon&&p.id===toolIcon.presetId&&p.toolLauncher===toolIcon.key)row.dataset.factoryTool='true';
    if(toolIcon){const icon=document.createElement('span');icon.className='pz-row-tag';icon.innerHTML=window.V7ToolSilhouettes.icon(toolIcon.key,16);icon.title=toolIcon.title;row.appendChild(icon);}
    row.appendChild(t);
    if (p.category === '__agent_inbox__') {
      t.title = p.title + '\n作者：' + (p.author || '') + '\n创建：' + (p.createdAt || '');
      const move = document.createElement('button'); move.className = 'pz-tb'; move.dataset.agentMove = p.id;
      move.style.width = '26px'; move.style.minWidth = '26px'; move.style.flex = '0 0 26px';
      move.title = '存到普通部位，并从 Agent 收件箱移除'; move.innerHTML = ico('arrowUp', 14);
      move.addEventListener('click', e => { e.stopPropagation(); agentPresetMove(p); }); row.appendChild(move);
    }

    if (p.needsReview || p.migrationState === 'forge-comfyui-review') {
      const review = document.createElement('span');
      review.className = 'pz-row-tag';
      review.textContent = '待验证';
      // 翻译器给出的具体原因（如「云端没有这个模型：xxx」），云端补装后下次启动会自动再试。
      const reasons = Array.isArray(p.reviewReasons) && p.reviewReasons.length ? p.reviewReasons : null;
      review.title = reasons ? '暂时不能在云端跑：\n· ' + reasons.join('\n· ') : 'Forge 参数已保留，ComfyUI 工作流验证通过后才能生成';
      row.appendChild(review);
    } else if (p.sourceKind === 'forge' && p.provider === 'comfyui' && p.migrationState === 'comfyui-converted') {
      const converted = document.createElement('span');
      converted.className = 'pz-row-tag';
      converted.textContent = 'ComfyUI';
      converted.title = '已转换为普通 ComfyUI 工作流；原 Forge 模型/LoRA 的效果等价性仍需逐项比对';
      row.appendChild(converted);
    }

    // 全部视图里标一下它属于哪个部位
    if (!S.selAsset && !(toolIcon && p.category === toolIcon.assetId)) {
      const a = P().assetById(p.category);
      const tag = document.createElement('span');
      tag.className = 'pz-row-tag';
      if (a) {
        const svg = partIco(a.id, 13, a.icon);
        if (svg) tag.innerHTML = svg; else tag.textContent = a.name.slice(0, 1);
        tag.title = a.name;
      } else {
        tag.textContent = '·';
        tag.title = '未分类';
      }
      row.appendChild(tag);
    }

    row.addEventListener('click', ev => {
      if (row._dragged) { row._dragged = false; return; }
      ev.stopPropagation();
      loadPreset(p);
    });
    return row;
  }

  // ── 拖拽排序 ──
  // 用指针事件自己做, 不用 HTML5 拖放 —— 这个窗口是透明置顶壳,
  // 原生拖放的 ghost image 在透明窗口上表现不可控。
  // ⚠ 已知限制: 拖到列表边缘不会自动滚动(列表一屏放得下时无影响)。
  function bindDragSort(list) {
    if (!list) return;
    // ⚠ refreshListOnly 只清空 .pz-list 的内容, 元素本身是留着的 ——
    //   不加这个标记的话每刷新一次就多挂一套监听, 拖一下会被处理 N 遍(越用越乱)。
    if (list._dragBound) return;
    list._dragBound = true;
    let dragging = null, startY = 0, rows = [], moved = false, pending = false, context = null;

    list.addEventListener('pointerdown', e => {
      if (e.button !== 0 || pending) return;
      const row = e.target.closest && e.target.closest('.pz-row');
      if (!row || e.target.closest('.pz-star')) return;
      if (S.filter) return;                      // 搜索结果里不排序(顺序是分数序, 拖了没意义)
      context = { epoch: dragStorageEpoch, category: S.selAsset };
      dragging = row; startY = e.clientY; moved = false;
      rows = [...list.querySelectorAll('.pz-row')];
      row.setPointerCapture && row.setPointerCapture(e.pointerId);
    });

    list.addEventListener('pointermove', e => {
      if (!dragging || context.epoch !== dragStorageEpoch || context.category !== S.selAsset || !dragging.isConnected) return;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      moved = true;
      dragging._dragged = true;
      dragging.classList.add('dragging');
      dragging.style.transform = 'translateY(' + dy + 'px)';
      const h = dragging.offsetHeight || 26;
      const from = rows.indexOf(dragging);
      const to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
      rows.forEach((r, i) => {
        if (r === dragging) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -h;
        else if (from > to && i < from && i >= to) shift = h;
        r.style.transition = 'transform .12s ease';
        r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    });

    const finish = async e => {
      if (!dragging) return;
      const row = dragging; dragging = null;
      const captured = context;
      const current = () => captured.epoch === dragStorageEpoch && captured.category === S.selAsset && !S.filter &&
        list.isConnected && S.zoneEl?.querySelector('.pz-list') === list && row.isConnected;
      const reset = () => {
        row.classList.remove('dragging');
        rows.forEach(item => { item.style.transform = ''; item.style.transition = ''; });
      };
      if (e.type === 'pointercancel' || !current()) { reset(); row._dragged = false; return; }
      // ⚠ 'dragging' 这个 class 带着高亮和阴影。位置真的变了时【先别摘】——
      //   摘早了，写盘那段时间里这一行会先掉高亮、再跳位置，又是两段动静。
      //   留到下面重建列表时跟旧元素一起消失，只剩一次干净的切换。
      if (!moved) {
        row.classList.remove('dragging');
        rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
        return;
      }
      const dy = e.clientY - startY;
      const h = row.offsetHeight || 26;
      const from = rows.indexOf(row);
      const to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
      if (to !== from) {
        // ⚠ 【不要在这里清 transform】(2026-09-11 修)。
        //   原来是"先清位移 → await 写盘 → 重建列表"，于是松手瞬间所有行跳回原位、
        //   在写盘那段时间里一直停在原位、写完才跳到新位置 —— 用户看到的两跳闪烁。
        //   写盘是逐条 await IndexedDB 的，几十条就是几十次往返，那段停顿相当明显。
        //   现在让各行【保持拖拽后的视觉位置】，一直等到新列表渲染好，
        //   旧元素连同它们的 transform 一起被替换掉，中间没有任何一帧是"回原位"。
        //   ⭐ 手指在哪、松手后就停在哪，新布局也正好在那个位置，所以几乎看不出切换。
        const ids = rows.map(r => r.dataset.presetId);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        // ⚠ 收藏的永远置顶, 所以顺序号按【当前可见顺序】整体重写,
        //   否则拖一个非收藏项到最前, 排序函数还是会把收藏项拎上去 —— 看着像"没拖动"。
        pending = true;
        list.setAttribute('aria-busy', 'true');
        try {
          await P().reorder(captured.category, ids);
          if (current()) refreshListOnly();
        } catch (error) {
          if (window.ERR) ERR.report('PRESET_SAVE_FAILED', { message: String(error.message || error), context: { operation: '预设排序' } });
          reset();
          if (current()) refreshListOnly();
        } finally {
          pending = false;
          list.removeAttribute('aria-busy');
        }
      } else {
        // 没换位置 → 让它带动画滑回原位(这条路上"回原位"才是对的)。
        // 高亮等滑回去了再摘，不然位置还没动、颜色先掉了。
        rows.forEach(r => { r.style.transition = 'transform .14s var(--ease-out)'; r.style.transform = ''; });
        setTimeout(() => {
          rows.forEach(r => { r.style.transition = ''; });
          row.classList.remove('dragging');
        }, 160);
      }
      setTimeout(() => { row._dragged = false; }, 0);
    };
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
  }

  async function zoneAction(act) {
    if (act === 'agent-inbox') return agentInboxDialog();
    if (act === 'search') {
      if(S.toolGroupOpen){S.toolGroupOpen = false;S.toolGroup = null;S.selAsset = null;applyZoom(true);renderCrumb();}
      S.searchOpen = !S.searchOpen;
      if (!S.searchOpen) S.filter = '';
      fillZone();
      return;
    }
    if (act === 'new') return saveCurrentAsPreset();
    if (act === 'import') return doImport();
    if (act === 'export') return doExport();
    if (act === 'migrate') return migrateFromV6();
    if (act === 'migration-report') return showMigrationReport();
  }

  // 一条预设都没有时，把"从 V6 搬家"做成显眼的大按钮 —— 这时候用户最需要它
  function emptyStateEl() {
    const box = document.createElement('div');
    box.className = 'pz-empty';
    if (S.filter) { box.textContent = '没搜到'; return box; }
    if (P().presets().filter(P().visible || (() => true)).length) { box.textContent = '这个部位下还没有预设'; return box; }
    box.innerHTML = '<div style="margin-bottom:10px;">一条预设都还没有</div>';
    const b = document.createElement('button');
    b.className = 'pz-empty-btn';
    b.innerHTML = ico('truck', 14) + '<span>从 V6 搬过来</span>';
    b.addEventListener('click', ev => { ev.stopPropagation(); migrateFromV6(); });
    const b2 = document.createElement('button');
    b2.className = 'pz-empty-btn sub';
    b2.innerHTML = ico('arrowDown', 14) + '<span>选文件导入</span>';
    b2.addEventListener('click', ev => { ev.stopPropagation(); doImport(); });
    box.appendChild(b); box.appendChild(b2);
    return box;
  }

  // ═══════════════════════════════════════════════════════════
  //  三级: 提示词框
  // ═══════════════════════════════════════════════════════════
  const PROMPT_KEY = 'v8.preset.prompt';        // 当前提示词(重启后还在)
  const MEM_KEY = 'v8.preset.paramMemory';      // 参数记忆
  const MEM_MAX = 100;
  function promptStorageKey(){
    return window.WHEELCHAIR_STORAGE
      ? window.WHEELCHAIR_STORAGE.key(PROMPT_KEY) : PROMPT_KEY;
  }

  function agentPresetError(result) {
    if (window.ERR) ERR.report(/HAS_NEW_CHANGES/.test(result.error || '') ? 'AGENT_PRESET_ROLLBACK_BLOCKED' : 'AGENT_PRESET_IMPORT_FAILED', { message: result.error || 'AGENT_PRESET_FAILED' });
  }
  async function agentPresetGrant() {
    const agent = window.uiwin && window.uiwin.agent;
    if (!agent) return false;
    const current = await agent.tierInfo();
    if (current.ok && ['preset_editor', 'software_developer', 'administrator'].includes(current.name || current.tier)) return true;
    const result = await agent.requestAccess('preset_editor');
    return result.ok && result.tier === 'preset_editor';
  }
  function agentPresetMove(p) {
    const options = presetCategoryAssets().map(a => [a.id, a.name]);
    if (!options.length) return agentPresetError({ error: 'AGENT_PRESET_CATEGORY_INVALID' });
    promptDialog({ title: '把 Agent 预设存到普通部位', hint: p.title + '\n作者：' + p.author + '\n移动前保存恢复节点；成功后从 Agent 列表消失。',
      fields: [{ key: 'category', type: 'select', label: '存放部位', value: options[0][0], options }],
      onOk: async values => { if (!(await agentPresetGrant())) return false; const result = await window.V7AgentPresets.move(p.id, values.category); if (!result.ok) { agentPresetError(result); return false; } toast('预设已移入所选部位，可从恢复节点撤销', 'ok'); return true; } });
  }
  async function agentInboxDialog() {
    const api = window.V7AgentPresets; if (!api) return;
    const info = await api.inboxInfo();
    promptDialog({ title: 'Agent 预设收件箱', hint: 'Codex / Claude 等 Agent 输出名称、时间、作者与预设内容。文件不允许附带密钥或原图。\n' + (info.enabled ? '已启用：' + info.path : '热读取尚未启用，启用时软件会请求确认。'),
      fields: [{ key: 'action', type: 'select', label: '操作', value: info.enabled ? 'open' : 'enable', options: [['enable', '启用固定目录热读取'], ['open', '打开当前收件箱文件夹'], ['file', '手动导入标准 JSON 文件'], ['backups', '查看预设备份与恢复'], ['disable', '停止热读取']] }],
      onOk: async values => {
        if (values.action === 'backups') { setTimeout(agentPresetBackups, 0); return true; }
        if (values.action === 'file') {
          if (!(await agentPresetGrant())) return false;
          pickFiles('.json', async files => {
            for (const file of files) {
              if (file.size > window.V7AgentPresetContract.MAX_BYTES) { agentPresetError({ error: 'AGENT_PRESET_TOO_LARGE' }); continue; }
              let value; try { value = JSON.parse(await file.text()); } catch (_) { agentPresetError({ error: 'AGENT_PRESET_JSON_INVALID' }); continue; }
              const r = await api.import(value); if (!r.ok) agentPresetError(r); else toast(r.skipped ? '这份 Agent 预设已经处理过' : '已放入 Agent 预设，修改前备份已保存', 'ok');
            }
          }); return true;
        }
        const r = await (values.action === 'enable' ? api.enableInbox() : values.action === 'open' ? api.openInbox() : api.disableInbox());
        if (!r.ok) { if (r.error !== 'AGENT_PRESET_CONFIRM_DECLINED') agentPresetError(r); return false; }
        toast(values.action === 'disable' ? '已停止热读取' : values.action === 'enable' ? '已启用，目录可从收件箱管理中打开' : '已打开收件箱', 'ok'); return true;
      } });
  }
  async function agentPresetBackups() {
    const api = window.V7AgentPresets, result = await api.listBackups();
    if (!result.ok) return agentPresetError(result);
    const list = result.backups.filter(b => b.status === 'available');
    if (!list.length) { toast('暂时没有 Agent 预设恢复节点', 'info'); return; }
    promptDialog({ title: '恢复 Agent 操作前的预设', hint: '恢复所选操作之前的预设数据库。如果之后有其它预设修改，会阻止恢复以免覆盖。文件系统备份与这里独立，最近保留 20 个节点。',
      fields: [{ key: 'backupId', type: 'select', label: '恢复节点', value: list[0].backupId, options: list.map(b => [b.backupId, b.createdAt + ' · ' + ({ import: '导入', move: '移动', rollback: '恢复' }[b.action] || b.action) + ' · ' + (b.details.name || b.details.presetId || '')]) }],
      onOk: async values => { if (!(await agentPresetGrant())) return false; const r = await api.rollback({ backupId: values.backupId, confirm: true }); if (!r.ok) { agentPresetError(r); return false; } toast('预设已恢复；恢复前状态也已备份', 'ok'); return true; } });
  }
  function memoryStorageKey(){
    return window.WHEELCHAIR_STORAGE
      ? window.WHEELCHAIR_STORAGE.key(MEM_KEY) : MEM_KEY;
  }

  const St = {
    text: '', presetId: '', presetTitle: '',
    // ⭐⭐ 「这段词是从哪条预设来的」(2026-09-13 用户定案)。
    //
    // ⚠⚠ 和上面的 presetId/presetTitle 【不是一回事】，别合并：
    //   · presetId / presetTitle = **绑定关系**。手改一个字就解绑（V6 的规矩）。
    //     它管的是：列表高亮、参数记忆的键、另存为预设 —— 这些改了词就确实不该再跟着。
    //   · originTitle / originEdited = **来源出处**。手改了也还算那条预设来的，只标成"已改"。
    //     它只管一件事：任务卡/生成记录上显示"这批图是拿哪条预设跑的"。
    //
    // 为什么要分开：任务栏里叠着七八个任务时，「甜美偶像风 · 已改」比「自定义提示词」
    // 有用得多；但参数记忆要是也跟着不解绑，就会把上次调的滑块值套到已经改过的词上。
    // 两件事的正确答案不一样，所以是两组字段。
    originTitle: '', originEdited: false,
    // ⭐⭐ 当前选中的【工具类预设】的 id（抠像 / 以后的分割、超分…）。2026-09-14 下半场。
    //
    // ⚠⚠ 存 id 不存对象。savePreset() 内部是 `mem.presets[i] = 新对象`，
    //   存对象的话调一次参数就和库里那份脱钩了，后面读到的全是旧值
    //   —— 本项目栽过同一种（"值传递快照失效"）。一律现查 presetById()。
    // ⚠ 它和 presetId/presetTitle 是【互斥】的：选中工具 → 那两个清空；
    //   选回提示词预设 → toolId 清空。"当前选中的预设"永远只有一个，
    //   否则快捷键不知道该跑哪条（用户报的"抠像和 banana 打架"就是这个）。
    toolId: '',
    // Workflow controls are scoped to the selected preset. Keeping the id
    // beside the values prevents a previous preset's denoise/resolution from
    // leaking into the next request.
    workflowParameters: {}, workflowPresetId: ''
  };
  function loadPromptState() {
    try {
      const raw = localStorage.getItem(promptStorageKey());
      if (raw) {
        const o = JSON.parse(raw);
        St.text = String(o.text || '');
        St.presetId = String(o.presetId || '');
        St.presetTitle = String(o.presetTitle || '');
        // ⚠ 来源也要落盘并读回来。V6 v6.5.0 修过一模一样的 bug，原注释写着：
        //   "预设名跟着落盘 — 修复重启后生成的缓存文件夹/生成记录只显示提示词内容不显示预设名"
        //   兼容老数据：没有 origin 字段的，用当时的 presetTitle 兜底。
        St.originTitle = String(o.originTitle || o.presetTitle || '');
        St.originEdited = !!o.originEdited;
        // ⭐ 工具类预设的选中状态也要活过重启 —— 用户要的是"和文字预设一样"，
        //   文字预设重启后还选着，抠像重启就没了的话就是两套行为。
        St.toolId = String(o.toolId || '');
        St.workflowPresetId = String(o.workflowPresetId || '');
        St.workflowParameters = persistentWorkflowState(o.workflowParameters);
        S.selPreset = St.toolId || St.presetId || null;
      }
    } catch (_) { }
  }
  // ⚠ 所有改提示词的路径都汇到这里(载入预设 / 打字 / 拖滑块 / 填空), 所以
  //   "同步给生成运行时"也放这一处 —— 分散到各个调用点必定会漏一个,
  //   而漏了的表现是"我明明选了预设, 生成出来的却是上一次的提示词"(静默失效)。
  function savePromptState() {
    try { localStorage.setItem(promptStorageKey(), JSON.stringify({ text: St.text, presetId: St.presetId, presetTitle: St.presetTitle, originTitle: St.originTitle, originEdited: St.originEdited, toolId: St.toolId, workflowParameters: persistentWorkflowState(St.workflowParameters), workflowPresetId: St.workflowPresetId })); } catch (error) { if(window.ERR) ERR.report('WORKFLOW_STATE_SAVE_FAILED',{message:String(error.message||error)}); }
    if (S.host && S.host.onPromptChange) {
      try { S.host.onPromptChange(St.text, St.presetTitle); } catch (e) { console.warn('[预设] 同步提示词给生成侧失败', e); if(window.ERR) ERR.report('PRESET_PROMPT_SYNC_FAILED',{message:String(e&&e.message||e)}); }
    }
    // 二级和三级的提示词框连通: 改了内容就让另一个也跟上(2026-09-11)。
    // 挂这里的理由和上面那句一样 —— 所有改动都流经本函数, 挂别处必漏。
    syncPromptViews();
    // 工具预设可能使用独立的主题槽位。由宿主刷新背景，预设模块只发出
    // 轻量通知，避免把主卡布局实现反向耦合进这里。
    S.host?.refreshDetailBackground?.();
  }

  function hasParams(t) {
    if (!t) return false;
    const r = /"?@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g;
    let m;
    while ((m = r.exec(t)) !== null) {
      if (m[1].slice(-5) !== '_desc' && m[1].slice(-6) !== '_label') return true;
    }
    return false;
  }
  function hasFields(t) { return !!t && /【填空:[^=】]+?(?:=[^】]*)?】/.test(t); }

  // withGlow: 行上【右滑】推进触发 → 三级播弹出光(跟普通二级卡一样); 点行 → 不播。
  function selectReferences(preset) {
    return window.V7PresetReferences ? V7PresetReferences.select(preset).catch(()=>null) : Promise.resolve();
  }
  function loadPreset(p, withGlow) {
    if (p.needsReview || p.migrationState === 'forge-comfyui-review') {
      if (window.ERR) window.ERR.report('PRESET_FORGE_REVIEW_REQUIRED', { presetId: p.id, title: p.title });
      return;
    }
    // ⭐ 多 kind 预设（2026-09-14）：不是提示词的走各自的面板。
    //   ⚠ 必须在最前面分流 —— 下面那堆全是提示词专用的状态
    //   （St.text / originTitle / applyMemory 记忆…），
    //   抠像预设的 content 是 JSON，走进去会被当提示词处理，一路错到底。
    const kind = p.kind || (P().KIND_PROMPT || 'prompt');
    if (kind !== (P().KIND_PROMPT || 'prompt')) {
      // ⚠⚠ 这里【只改状态，不自己画】（2026-09-14 下半场修）。
      //   原来是 openDetail() 之后再补一句 fillToolDetail() —— 那是两个人往同一个
      //   容器里写：openDetail 先画提示词界面，抠像面板再盖上去；三级本来就开着时
      //   openDetail 走的是【带动画的延迟写】，于是抠像面板先出来、过几十毫秒又被
      //   提示词面板盖回去。用户报的"点按之间有竞态、UI 打架"就是这个。
      //   现在改成：谁来画都走 fillDetailNow 那一个出口，出口自己按 kind 分流。
      if (St.toolId === p.id && S.selPreset === p.id) {
        // 已经选着它了(鼠标在同一行上反复推进会连着触发) → 只把卡打开，不重画。
        // 重画会掐断用户正在拖的滑块。
        if (S.host && S.host.openDetail) S.host.openDetail(!!withGlow);
        return;
      }
      St.toolId = p.id;
      selectReferences(null);
      St.workflowParameters = {};
      St.workflowPresetId = '';
      S.selPreset = p.id;
      notifyWorkflowParameters(null);
      savePromptState();              // 落盘 toolId + 让两个框都跟着重画
      if (window.V7PresetPreActions && typeof window.V7PresetPreActions.select === 'function') {
        window.V7PresetPreActions.select(p).catch(function () {});
      }
      refreshListOnly();
      if (S.host && S.host.openDetail) S.host.openDetail(!!withGlow);
      return;
    }
    St.toolId = '';                   // 选了提示词预设 = 工具那条不再是"当前选中"
    const referencesReady=selectReferences(p);
    S.selPreset = p.id;
    St.text = p.content || '';
    St.presetId = p.id;
    St.presetTitle = p.title || '';
    // A workflow preset owns its parameter snapshot. Start from its declared
    // defaults every time it is selected; edits are then kept only for this
    // preset and reported to the generation card through the host bridge.
    St.workflowParameters = (p.workflow || p.forgeWorkflow)
      ? JSON.parse(JSON.stringify(workflowDefaultsOf(p))) : {};
    St.workflowPresetId = (p.workflow || p.forgeWorkflow) ? String(p.id || '') : '';
    notifyWorkflowParameters(p);
    // 载入 = 重新认一次来源，"已改"的标记清零
    St.originTitle = p.title || '';
    St.originEdited = false;
    S.forceText = false;
    applyMemory();                 // 套回上次调过的值(预设文件不动)
    savePromptState();
    if (window.V7PresetPreActions && typeof window.V7PresetPreActions.select === 'function') {
      window.V7PresetPreActions.select(p).catch(function () {});
    }
    refreshListOnly();
    if (S.host && S.host.openDetail) S.host.openDetail(!!withGlow);
    // The host opens the detail shell; fill once more synchronously so legacy
    // callers that invoke loadPresetById outside a card route still receive
    // the real field controls. specialDetailFill's route sequence cancels any
    // stale animated write, so this cannot let an older prompt win the race.
    fillDetailCard(false);
    return referencesReady;
  }
  // ═══════════════════════════════════════════════════════════
  //  工具类预设的参数面板（抠像 / 以后的分割、超分…）
  //
  //  ⚠ 每一项都写了「治什么」——这些参数用户光看名字【不知道该调哪个】。
  //    只给滑块不给说明，等于没给（docs/12 坑11 同理：看不懂的功能等于不存在）。
  //  ⚠ 参数改了【立刻存回预设】，不用点保存 —— 它就是一条预设，
  //    和提示词预设的"改了就记住"行为保持一致。
  // ═══════════════════════════════════════════════════════════
  const MATTING_FIELDS = [
    { key: 'refine', type: 'switch', name: '边缘精修',
      desc: '用原图把糊掉的边缘吸附回真实轮廓。⭐ 大图效果最明显 —— 模型只在 1024 上算，贴回 4K 时边缘本来是糊的' },
    { key: 'threshold', type: 'range', min: 0, max: 100, step: 1, unit: '', name: '边缘阈值',
      desc: '把很淡的半透明区域直接判成背景。0=保留模型原始过渡。背景里有雾/光晕时调它' },
    { key: 'contrast', type: 'range', min: 0, max: 100, step: 1, unit: '', name: '边缘对比',
      desc: '把"半透明的一圈"收紧，边缘更干脆。0=不动。发丝多的图别调太高，会把发丝削掉' },
    { key: 'shrink', type: 'range', min: -5, max: 5, step: 1, unit: 'px', name: '收缩 / 扩张',
      desc: '负数往里收（边上带背景色时用），正数往外扩（主体被吃掉一圈时用）。0=不动' },
    { key: 'despeckle', type: 'range', min: 0, max: 50, step: 1, unit: '‰', name: '去碎片',
      desc: '丢掉面积小于这个比例的独立小块。治"背景里误判出几个小点"。0=不处理' },
    { key: 'feather', type: 'range', min: 0, max: 20, step: 1, unit: 'px', name: '羽化',
      desc: '让边缘过渡更柔。⚠ 默认 0 —— 边缘质量是模型决定的，加羽化会把算准的发丝糊掉' }
  ];

  // 抓图分辨率。⚠ 0 = 原始尺寸不缩（用户 2026-09-14 定的默认值）。
  // ⚠ "原始尺寸"有个隐含上限：桥那边 ps-io.js 有 2000 万像素的预算（≈5000×4000），
  //   超过的由 Photoshop 内部等比缩到预算内 —— 不然 UXP 内存给不起，直接 RangeError（2026-09-14 实测）。
  const MATTING_RES_OPTS = [
    ['0', '原始尺寸（超过约 2000 万像素时由 PS 自动缩）'],
    ['4096', '上限 4096'],
    ['3072', '上限 3072'],
    ['2048', '上限 2048（省内存）']
  ];

  // ═══════════════════════════════════════════════════════════
  //  人体解析（分割）的部位名单
  //
  //  ⚠ 首选从引擎报上来的 models[key].labels 里取（引擎那张 MODELS 表才是真身）。
  //    这里这份是【引擎没报 labels 时的兜底】，免得面板变成一片空白 ——
  //    空白面板会让用户以为功能坏了，而真相只是"引擎版本旧了一点"。
  //  ⚠ 两边不一致时以引擎为准。改模型时记得回来对一遍（docs/40 第三节：改一边要改两边）。
  const SEGMENT_LABELS_FALLBACK = {
    'segment-schp-atr':   ['背景','帽子','头发','太阳镜','上衣','裙子','裤子','连衣裙','腰带','左鞋','右鞋','脸','左腿','右腿','左臂','右臂','包','围巾'],
    'segment-segformer':  ['背景','帽子','头发','太阳镜','上衣','裙子','裤子','连衣裙','腰带','左鞋','右鞋','脸','左腿','右腿','左臂','右臂','包','围巾'],
    'segment-schp-lip':   ['背景','帽子','头发','手套','太阳镜','上衣','连衣裙','外套','袜子','裤子','连体衣','围巾','裙子','脸','左臂','右臂','左腿','右腿','左鞋','右鞋']
  };

  function openToolPreset(preset){return window.V7ToolSilhouettes.open(window,preset||toolPresetNow());}
  // Registered workflow tools retain their own kind; legacy engine presets keep
  // the existing parameter panels and execution route.
  function toolKindOf(p) {
    const k = p && p.kind;
    if(window.V7ToolSilhouettes?.getPreset(p))return k;
    if(['camera-light','scene-pack','poster','hemisynth','kao'].includes(k))return k;
    if (k === (P().KIND_SEGMENT || 'segment')) return 'segment';
    if (k === (P().KIND_SAM2 || 'sam2')) return 'sam2';
    if (k === (P().KIND_GLOW || 'glow')) return 'glow';
    return 'matting';
  }
  function toolDefaultsOf(kind) {
    if(window.V7ToolSilhouettes?.getPreset({kind}))return {};
    if(['scene-pack','poster','hemisynth','kao'].includes(kind))return window.V7CreativeCore.initial();
    if (kind === 'camera-light') return window.V7CameraLightCore.config();
    if (kind === 'segment') return P().segmentDefaults ? P().segmentDefaults() : {};
    if (kind === 'sam2') return P().sam2Defaults ? P().sam2Defaults() : {};
    if (kind === 'glow') return P().glowDefaults ? P().glowDefaults() : {};
    return P().mattingDefaults();
  }
  const TOOL_KIND_LABEL = { matting: '抠像', segment: '人体解析', sam2: '指哪抠哪', glow:'辉光', 'camera-light':'相机与灯光', 'scene-pack':'场景', poster:'海报', hemisynth:'半合成', kao:'尻特效' };

  // ── 通用的"一排滑块/开关"渲染器 ─────────────────────────
  // ⚠ 从原来抠像那段原样抽出来的，行为一个字节没改。抽出来是为了让
  //   三种能力共用同一套控件外观 —— 各写各的必然慢慢长歪。
  function renderFieldRows(area, fields, vals, save) {
    const grid = document.createElement('div');
    grid.className = 'pd-sliders tight';
    fields.forEach(f => {
      const row = document.createElement('div');
      row.className = 'pd-slider';
      const hd = document.createElement('div');
      hd.className = 'pd-slider-head';
      hd.title = f.desc;                       // 悬停看完整说明
      const nm = document.createElement('span');
      nm.className = 'pd-slider-name'; nm.textContent = f.name;
      hd.appendChild(nm);

      if (f.type === 'switch') {
        const sw = document.createElement('input');
        sw.type = 'checkbox'; sw.checked = vals[f.key] !== false;
        sw.style.cssText = 'width:15px;height:15px;cursor:pointer;';
        hd.appendChild(sw);
        row.appendChild(hd);
        sw.addEventListener('change', () => { vals[f.key] = sw.checked; save(); });
      } else {
        const vv = document.createElement('span');
        vv.className = 'pd-slider-val';
        const fmt = v => String(v) + (f.unit || '');
        vv.textContent = fmt(vals[f.key]);
        hd.appendChild(vv);
        const rg = document.createElement('input');
        rg.type = 'range'; rg.min = String(f.min); rg.max = String(f.max); rg.step = String(f.step);
        rg.value = String(vals[f.key]);
        rg.className = 'pd-range';
        const pct = v => ((v - f.min) / (f.max - f.min) * 100).toFixed(1) + '%';
        rg.style.setProperty('--fill', pct(vals[f.key]));
        rg.addEventListener('input', () => {
          const nv = Number(rg.value);
          vv.textContent = fmt(nv);
          rg.style.setProperty('--fill', pct(nv));
          vals[f.key] = nv; save();
        });
        row.appendChild(hd); row.appendChild(rg);
      }
      // 说明文字直接显示，不只放 title —— 用户不会去悬停每一项
      const d = document.createElement('div');
      d.className = 'pd-field-desc';
      d.textContent = f.desc;
      row.appendChild(d);
      grid.appendChild(row);
    });
    area.appendChild(grid);
    return grid;
  }

  // ── 抠像的参数区 ────────────────────────────────────────
  function renderMattingFields(area, vals, save) {
    // 结果怎么进 Photoshop
    const aRow = document.createElement('div');
    aRow.className = 'pd-field';
    const am = String(vals.applyMode || 'mask');
    aRow.innerHTML = '<div class="pd-field-label">结果怎么进 Photoshop</div>'
      + '<select class="pd-field-input" data-mt="applyMode">'
      + '<option value="mask"' + (am === 'mask' ? ' selected' : '') + '>盖印一层 + 加蒙版（推荐，能拿画笔改）</option>'
      + '<option value="layer"' + (am === 'layer' ? ' selected' : '') + '>贴一张透明图层（老做法）</option>'
      + '</select>'
      + '<div class="pd-field-desc">'
      + '「盖印 + 蒙版」= 把你现在看到的画面合并成一层，抠出来的形状做成蒙版盖上去。'
      + '哪里抠多了抠少了，直接拿白/黑画笔在蒙版上涂两笔就改好了，不用重抠。<br>'
      + '「贴一张透明图层」是以前的做法，出来是个智能对象，想改边缘只能重抠。'
      + '</div>';
    area.appendChild(aRow);
    aRow.querySelector('select').addEventListener('change', e => {
      vals.applyMode = String(e.target.value || 'mask'); save();
    });

    renderFieldRows(area, MATTING_FIELDS, vals, save);
  }

  // ── 人体解析的参数区 ─────────────────────────────────────
  //   产物：一个组，组里每个部位一个图层（共享源的智能对象）+ 该部位的蒙版，
  //   图层名 = 部位名。用户 2026-09-14 深夜定的。
  function renderSegmentFields(area, vals, save, kindModels) {
    // 这次会用哪个模型 → 决定部位名单（ATR 18 类 / LIP 20 类不一样）
    let modelKey = '';
    if (window.MATTINGENGINE) {
      const t = String(vals.tier) === 'auto'
        ? (window.MATTINGENGINE.tierOf ? window.MATTINGENGINE.tierOf('segment') : 0)
        : Number(vals.tier);
      if (t) modelKey = window.MATTINGENGINE.keyForTier(t, 'segment') || '';
    }
    const m = modelKey ? kindModels[modelKey] : null;
    // ⚠ 优先用引擎报的 labels；引擎没报才用界面里那份兜底表
    const labels = (m && Array.isArray(m.labels) && m.labels.length)
      ? m.labels
      : (SEGMENT_LABELS_FALLBACK[modelKey] || SEGMENT_LABELS_FALLBACK['segment-schp-atr']);

    const sel = new Set((Array.isArray(vals.parts) ? vals.parts : []).map(Number));

    const wrap = document.createElement('div');
    wrap.className = 'pd-field';
    const lab = document.createElement('div');
    lab.className = 'pd-field-label';
    lab.textContent = '要哪些部位';
    wrap.appendChild(lab);

    const tip = document.createElement('div');
    tip.className = 'pd-field-desc';
    // ⚠ "一个都不勾 = 全要" 必须写出来。不写的话用户看到一片没勾的框，
    //   会以为"什么都不会做"，于是永远不敢按开始（docs/12 坑11：看不懂 = 不存在）。
    tip.textContent = '一个都不勾 = 全要（模型认出什么给什么）。勾上之后只做勾中的那几个。'
                    + '每个部位在 Photoshop 里是一个图层 + 一个蒙版，图层名就是部位名。';
    wrap.appendChild(tip);

    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px;';
    // ⚠ 跳过"背景"：用户要的是主体的部位，把背景做成图层没有意义
    labels.forEach((name, id) => {
      if (id === 0) return;
      const l = document.createElement('label');
      l.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(id);
      cb.style.cssText = 'width:13px;height:13px;cursor:pointer;';
      cb.addEventListener('change', () => {
        if (cb.checked) sel.add(id); else sel.delete(id);
        vals.parts = Array.from(sel).sort((a, b) => a - b);
        save();
      });
      l.appendChild(cb);
      l.appendChild(document.createTextNode(name));
      box.appendChild(l);
    });
    wrap.appendChild(box);

    // 全选 / 全不选
    const btns = document.createElement('div');
    btns.style.cssText = 'margin-top:6px;display:flex;gap:6px;';
    [['全选', true], ['全不选（= 全要）', false]].forEach(([txt, on]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pd-hb';
      b.style.cssText = 'padding:2px 8px;font-size:11px;';
      b.textContent = txt;
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        b.blur();                       // ⚠ 不 blur 的话焦点留在面板里，重画护栏会把更新拦掉
        sel.clear();
        if (on) labels.forEach((_n, id) => { if (id !== 0) sel.add(id); });
        vals.parts = Array.from(sel).sort((a, b2) => a - b2);
        save();
        box.querySelectorAll('input[type=checkbox]').forEach((cb, i) => { cb.checked = on; });
      });
      btns.appendChild(b);
    });
    wrap.appendChild(btns);
    area.appendChild(wrap);

    // 组名
    const gRow = document.createElement('div');
    gRow.className = 'pd-field';
    gRow.innerHTML = '<div class="pd-field-label">组的名字</div>'
      + '<input class="pd-field-input" type="text" placeholder="留空就用这条预设的名字" value="' + esc(String(vals.groupName || '')) + '">'
      + '<div class="pd-field-desc">Photoshop 图层面板里那个组叫什么。</div>';
    area.appendChild(gRow);
    gRow.querySelector('input').addEventListener('input', e => {
      vals.groupName = String(e.target.value || ''); save();
    });

    // 占比门槛
    renderFieldRows(area, [
      { key: 'minPercent', type: 'range', min: 0, max: 5, step: 0.1, unit: '%', name: '最小占比',
        desc: '占画面比例低于这个数的部位直接不报。调大 = 只要大块（省事），调小 = 连小配饰也给（图层会多）。' }
    ], vals, save);
  }

  // ── 指哪抠哪（SAM2）的参数区 ─────────────────────────────
  function renderSAM2Fields(area, vals, save) {
    const how = document.createElement('div');
    how.className = 'ai-help';
    // ⚠ 这段话是给【不懂技术的用户】看的。SAM2 和抠像的区别不说清楚，
    //   他会以为这俩是一个东西、然后觉得"多了个没用的功能"。
    how.innerHTML = '<b>它和抠像不一样</b><br>'
      + '抠像是「它自己找主角」，画面里三个人它可能三个都抠。<br>'
      + '这个是「你指哪它抠哪」—— <b>你在 Photoshop 里框一个框，它就抠框里那个东西</b>。<br>'
      + '它每次会同时给<b>三个答案</b>（比如框住领口 → 整个人 / 上衣 / 领子），下面这项决定要不要让你挑。';
    area.appendChild(how);

    // 怎么指（第一版只做了"用 PS 选区当框"）
    const mRow = document.createElement('div');
    mRow.className = 'pd-field';
    mRow.innerHTML = '<div class="pd-field-label">怎么指目标</div>'
      + '<select class="pd-field-input" data-mt="mode">'
      + '<option value="box"' + (String(vals.mode || 'box') === 'box' ? ' selected' : '') + '>用你在 Photoshop 里拉的选区当框</option>'
      + '</select>'
      + '<div class="pd-field-desc">先在 Photoshop 里框住大概范围，再按开始计算。'
      + '框得贴近目标一点，它认得更准。</div>';
    area.appendChild(mRow);
    mRow.querySelector('select').addEventListener('change', e => {
      vals.mode = String(e.target.value || 'box'); save();
    });

    // 三个候选：挑 or 自动
    const pRow = document.createElement('div');
    pRow.className = 'pd-field';
    pRow.innerHTML = '<div class="pd-field-label">三个答案怎么办</div>'
      + '<select class="pd-field-input" data-mt="pick">'
      + '<option value="ask"' + (String(vals.pick || 'ask') === 'ask' ? ' selected' : '') + '>都摆出来，我自己挑（推荐）</option>'
      + '<option value="auto"' + (String(vals.pick || 'ask') === 'auto' ? ' selected' : '') + '>别问了，直接用它最有把握的那个</option>'
      + '</select>'
      + '<div class="pd-field-desc">选「我自己挑」时，算完会在任务卡上出现三个小图，'
      + '点哪个就把哪个盖印成图层蒙版。</div>';
    area.appendChild(pRow);
    pRow.querySelector('select').addEventListener('change', e => {
      vals.pick = String(e.target.value || 'ask'); save();
    });
  }

  // ⚠ body 由调用方给（二级提示词卡 / 三级卡都可能是它），不再自己去抓 #dcBody ——
  //   写死 #dcBody 的话，二级那张卡永远画的是提示词，和三级各说各话。
  //
  // ⚠⚠ 2026-09-14 深夜：这个函数现在管【三种】工具预设（抠像/人体解析/指哪抠哪）。
  //   没有拆成三个 fillXxxDetail，是【有意的】——三份九成相同的 200 行代码，
  //   必然出现"改了抠像忘了改分割"，而且漏改【不报错】。
  //   现在的结构是：外壳（引擎状态 / 档位 / 抓图分辨率 / 底栏）三种共用，
  //   只有中间那段"参数区"按 kind 分流到 renderMattingFields / renderSegmentFields /
  //   renderSAM2Fields。docs/46 第三节那条"同一块 DOM 只能有一个写手"仍然成立。
  function fillToolDetail(body, p) {
    if (!body) return;
    // ⚠⚠ 正在这个面板里操作（拖滑块、点开下拉）时【绝不重画】。
    //   剪影上的"鼠标右滑推进"是逐帧触发的，一路会反复叫到这儿；
    //   重画会把用户正拖着的滑块从 DOM 里换掉，表现就是"拖不动/一松手就跳回去"。
    //   判据用焦点：range/select/checkbox 按下去就拿到焦点，和两个提示词框同一条规矩。
    if (body.dataset.toolPreset === p.id && body.contains(document.activeElement)) return;
    body.dataset.toolPreset = p.id;
    if (promptTarget === 'detail') {
      const nameEl = S.host && S.host.detailName && S.host.detailName();
      if (nameEl) nameEl.textContent = p.title || '工具';
    }

    // ⭐ 这条预设是哪一类能力 —— 下面所有"按能力"的判断都从这一个变量来，
    //   不要在各处再写 `p.kind === 'segment'`（散落的判断必然漏，而且漏了不报错）。
    const kind = toolKindOf(p);
    const toolEntry=window.V7ToolSilhouettes?.getPreset(p);
    const kindLabel = toolEntry?.title || TOOL_KIND_LABEL[kind] || '工具';
    const vals = Object.assign(toolDefaultsOf(kind), P().presetParams(p));

    // 参数改了就存回这条预设。
    // ⚠ 每次都【现查一遍库】再合并：savePreset 内部是"整条替换"，
    //   拿着面板打开那一刻的旧对象去存，会把期间别处的改动覆盖掉。
    const save = () => {
      const live = P().presetById(p.id) || p;
      const np = Object.assign({}, live, { content: JSON.stringify(vals) });
      P().savePreset(np).catch(e => {
        if (window.ERR) ERR.report('PRESET_SAVE_FAILED', { message: String(e && e.message || e) });
      });
    };

    // 二级是紧凑版(可滚内容 + 常驻底栏)，三级是整块。两边的骨架和提示词面板保持一致。
    if (promptTarget === 'zone') {
      body.innerHTML = '<div class="qz-scroll"><div class="pd-body"></div></div><div class="qz-foot"></div>';
    } else {
      body.innerHTML = '<div class="pd-body"></div><div class="pd-foot"></div>';
    }
    const area = body.querySelector('.pd-body');
    const footEl = body.querySelector('.qz-foot, .pd-foot');

    if(toolEntry){
      const launch=document.createElement('section');launch.className='v7-tool-launch';launch.setAttribute('aria-label',kindLabel+'工具入口');
      const context=document.createElement('div');context.className='v7-tool-context';context.innerHTML=window.V7ToolSilhouettes.icon(toolEntry.key,24);
      const contextText=document.createElement('span');contextText.textContent='工具工作面';context.append(contextText);
      const help=document.createElement('button');help.type='button';help.className='v7-help';help.textContent='?';help.dataset.helpText=toolEntry.description;help.setAttribute('aria-label','说明：'+toolEntry.description);
      const available=window.V7ToolSilhouettes.available(window,p);
      const note=document.createElement('p');note.className='v7-tool-state';note.setAttribute('role','status');note.textContent=available?(p.id===toolEntry.presetId?'配置来源：当前工具':'配置来源：本条预设'):'工具模块未加载，请重新打开软件。';
      if(!available)note.setAttribute('role','status');
      if(toolEntry.key==='seam-review'){
        const seamNote=document.createElement('p');seamNote.className='v7-tool-state';seamNote.textContent='只读取当前 Photoshop 文档整张画布；扫描在本机完成，传回层背景透明。候选位置需要人工确认。';
        const seamHelp=document.createElement('p');seamHelp.className='v7-tool-state';seamHelp.textContent='检查整张画布，不受选区限制。红框：边界与局部精度线索吻合；橙框：强边界或局部细节突降；紫框：长边界；青框：局部色差。所有颜色都是候选线索，需要人工复查，不代表已经确认是 AI。再次检测前请先隐藏旧标注层。';
        const seamRun=document.createElement('button');seamRun.type='button';seamRun.className='settings-btn';seamRun.textContent='抓取当前 PS 画布并检测修图痕迹';seamRun.disabled=!available;seamRun.setAttribute('aria-label','抓取当前 Photoshop 文档整张画布并检测修图痕迹');
        seamRun.dataset.seamRun='1';seamRun.dataset.toolOpen='seam-review';seamNote.setAttribute('role','status');seamNote.setAttribute('aria-live','polite');
        const seamResults=document.createElement('section');seamResults.className='v7-seam-results';seamResults.hidden=true;seamResults.setAttribute('aria-label','AI 修图痕迹检测候选列表');
        const seamResultsHead=document.createElement('div');seamResultsHead.className='v7-seam-results-head';
        const seamResultsTitle=document.createElement('strong');seamResultsTitle.textContent='候选位置';
        const seamResultsCount=document.createElement('span');seamResultsCount.className='v7-seam-results-count';
        seamResultsHead.append(seamResultsTitle,seamResultsCount);
        const seamResultsHelp=document.createElement('p');seamResultsHelp.className='v7-seam-results-help';seamResultsHelp.textContent='点击一项可把 Photoshop 画布定位到对应区域；按住 Alt 点击会放大查看。定位不会修改像素、选区或图层显隐。';
        const seamResultsList=document.createElement('div');seamResultsList.className='v7-seam-results-list';seamResultsList.setAttribute('role','list');
        seamResults.append(seamResultsHead,seamResultsHelp,seamResultsList);
        const candidateTypeLabel=type=>({joint:'重点复核', 'precision-only':'局部细节','seam-only':'边界线索'})[type]||'复核线索';
        const candidateTypeClass=type=>({joint:'joint','precision-only':'precision','seam-only':'seam'})[type]||'review';
        const renderCandidates=status=>{
          const candidates=Array.isArray(status?.candidates)?status.candidates:[];
          seamResults.hidden=!candidates.length;
          seamResultsCount.textContent=candidates.length?'共 '+candidates.length+' 项':'';
          seamResultsList.replaceChildren();
          for(const candidate of candidates){
            const row=document.createElement('button');row.type='button';row.className='v7-seam-result';row.dataset.candidateId=candidate.id;row.setAttribute('aria-label','定位到候选 '+String(candidate.index).padStart(2,'0')+'：'+String(candidate.label||candidateTypeLabel(candidate.type)));row.disabled=!!status.focusBusy||!!status.busy;
            if(status.selectedCandidateId===candidate.id)row.classList.add('is-selected');
            const dot=document.createElement('i');dot.className='v7-seam-result-dot '+candidateTypeClass(candidate.type);dot.setAttribute('aria-hidden','true');
            const main=document.createElement('span');main.className='v7-seam-result-main';
            const title=document.createElement('span');title.className='v7-seam-result-title';title.textContent=String(candidate.label||candidateTypeLabel(candidate.type));
            const meta=document.createElement('span');meta.className='v7-seam-result-meta';const r=candidate.region||{};meta.textContent=candidateTypeLabel(candidate.type)+' · 左 '+Math.round(Number(r.left)||0)+' / 上 '+Math.round(Number(r.top)||0)+' · '+Math.round(Number(r.width)||0)+'×'+Math.round(Number(r.height)||0);
            main.append(title,meta);const action=document.createElement('span');action.className='v7-seam-result-action';action.textContent=status.focusBusy&&status.selectedCandidateId===candidate.id?'定位中…':'定位';row.append(dot,main,action);
            row.addEventListener('click',async event=>{event.stopPropagation();if(row.disabled||!window.V7SeamReview?.focus)return;row.disabled=true;try{const result=await window.V7SeamReview.focus(candidate.id,{mode:event.altKey?'zoom-in':'fit'});if(result?.busy)seamNote.textContent='正在处理上一个定位，请稍候。';}catch(error){seamNote.textContent=String(error.message||error);}finally{if(row.isConnected)row.disabled=!!window.V7SeamReview?.snapshot?.().focusBusy||!!window.V7SeamReview?.snapshot?.().busy;}});
            seamResultsList.append(row);
          }
        };
        const paint=status=>{seamRun.disabled=!available||status.busy;seamRun.setAttribute('aria-busy',String(status.busy));seamNote.textContent=status.message;renderCandidates(status);};
        const unsubscribe=window.V7SeamReview?.subscribe?.(paint);
        const observer=new MutationObserver(()=>{if(!seamRun.isConnected){unsubscribe?.();observer.disconnect();}});
        seamRun.addEventListener('click',async event=>{event.stopPropagation();if(seamRun.disabled)return;try{await window.V7SeamReview.open();}catch(_){/* The controller reports once and preserves inline status. */}});
        context.append(help);launch.append(context,note,seamHelp,seamNote,seamRun,seamResults);area.append(launch);observer.observe(document.body,{childList:true,subtree:true});
        footEl.innerHTML='<button type="button" class="pd-hb pd-tool-return" data-act="clear" title="取消选中工具，返回提示词">'+ico('arrowLeft',16)+'<span>返回提示词</span></button>';bindHead(footEl);return;
      }
      const stages=toolEntry.key==='image-scopes'?['读取画布','查看亮度颜色','返回预设']:toolEntry.key==='batch-queue'?['检查照片队列','调整单项配置','按序执行']:['准备图片','调整参数','预览并传回'];
      const steps=document.createElement('ol');steps.className='v7-tool-steps';stages.forEach((label,index)=>{const li=document.createElement('li');li.innerHTML=(window.ICON?.render(['image','sliders','check'][index],16)||'')+'<span>'+label+'</span>';steps.append(li);});
      const open=document.createElement('button');open.type='button';open.className='settings-btn';open.dataset.toolOpen=toolEntry.key;open.disabled=!available;open.textContent='打开'+kindLabel;open.setAttribute('aria-label','打开'+kindLabel+'工作面');
      open.title='打开'+kindLabel;
      let opening=false;
      open.addEventListener('click',async event=>{event.stopPropagation();if(opening)return;opening=true;open.setAttribute('aria-busy','true');open.focus({preventScroll:true});try{await openToolPreset(p);}catch(error){window.ERR?.report(error.code||'TOOL_OPEN_FAILED',{message:String(error.message||error)});}finally{opening=false;if(open.isConnected){open.removeAttribute('aria-busy');open.disabled=!window.V7ToolSilhouettes.available(window,p);}}});
      context.append(help);launch.append(context,steps,note,open);area.append(launch);
      footEl.innerHTML='<button type="button" class="pd-hb pd-tool-return" data-act="clear" title="取消选中工具，返回提示词">'+ico('arrowLeft',16)+'<span>返回提示词</span></button>';bindHead(footEl);return;
    }

    if(['scene-pack','poster','hemisynth','kao'].includes(kind)){
      const open=document.createElement('button');open.className='pd-hb';open.title='打开'+kindLabel;open.innerHTML=ico('image',18);open.onclick=()=>window.V7CreativeTools.open(kind==='scene-pack'?'scene':kind,p).catch(error=>window.ERR?.report(error.code||'CREATIVE_TOOL_FAILED',{message:error.message}));area.appendChild(open);return;
    }
    if(kind==='camera-light'){
      const open=document.createElement('button');open.className='pd-hb';open.title='打开相机与灯光';open.innerHTML=ico('camera',18);open.onclick=()=>window.V7CameraLight.open(p).catch(error=>window.ERR?.report(error.code||'LIGHTING_FAILED',{message:error.message}));area.appendChild(open);return;
    }

    // Glow runs in the desktop worker; it does not need the segmentation engine or model tiers.
    if(kind==='glow'){
      const help=document.createElement('div');help.className='ai-help';
      help.textContent='从 Photoshop 抓取当前区域，在外置预览中调整辉光。全程本地计算，不收取生图费用。工具素材默认隐藏时，可在剪影管理器中显示它。';
      area.appendChild(help);
      if(window.GLOW_TOOL) window.GLOW_TOOL.controls(area,vals,next=>{Object.assign(vals,next);save();});
      else help.textContent='辉光工具未加载，请重新打开软件。';
      if(footEl){
        footEl.innerHTML='<button class="pd-hb pd-hb-run" data-act="run" title="抓取 Photoshop 图片并打开辉光预览">'+ico('play')+'</button><button class="pd-hb" data-act="clear" title="取消选中（回到提示词）">×</button>';
        bindHead(footEl);
      }
      return;
    }

    // ── 引擎状态：用不了的话先说清楚，别让用户白调一通参数 ──
    // ⚠⚠ 面板打开就自动探活（2026-09-14）。以前只读 snapshot()、从不主动 probe()，
    //   第一次打开永远是"还没探测过"，用户得跑去外挂能力卡刷一下才能用。
    // ⚠⚠ probe 是异步的，【回来之后必须重画】—— 不重画的话面板停在探活前的那句话上，
    //   用户截图抓到过（显示"引擎没启动"，其实只是结果还没回来）。
    //   重画的护栏：容器还在页面上、还是这条预设、用户没在里面拖滑块。
    //   ⚠ promptTarget 是全局的，回调时可能已经被别的渲染改过，所以要记住当时的值再临时切回去。
    // ⚠ 只有【真发出了请求】才挂重画。缓存命中时 probe() 立刻返回，
    //   这时再挂重画 = 重画→probe→重画→… 死循环（写第一版时差点栽进去）。
    //   判据：probe() 调完立刻看 snapshot().probing —— 真发出去了它才是 true。
    // ⚠⚠⚠ 2026-10-17：上面这个判据【有洞】，真的死循环过（用户 10-16 点抠像、10-17 点人体解析，面板假死、内存涨到 4 GB）：
    //   别人的探活在路上时，probe() 拿缓存立刻返回，probing 却是别人设的 true ⇒ 照样挂重画 ⇒ 微任务里无限重画。
    //   根子在 matting-engine.js 的 probe() 已修（在途的先返回）；这里再加最后一道闸：
    //   探活回来以后，引擎状态跟画面板时【一模一样】就不重画 —— 重画只为显示新结果，结果没变就没理由重画，
    //   不管 probe 内部以后怎么改，这里都不可能再无限重画。
    const engineStamp = () => {
      const s = window.MATTINGENGINE.snapshot();
      return [s.available, s.probed, s.probing, s.probedAt, s.lastError, JSON.stringify(s.tiers || {})].join('|');
    };
    const probeAndRedraw = (force) => {
      if (!window.MATTINGENGINE || !window.MATTINGENGINE.probe) return;
      const target = promptTarget;
      const pr = window.MATTINGENGINE.probe(!!force);
      if (!window.MATTINGENGINE.snapshot().probing) return;     // 缓存命中，状态已经是新的
      const drawnWith = engineStamp();                          // 这次面板画的就是这个状态
      pr.catch(e => { console.warn('[预设] 抠像引擎探活失败:', e); })
        .then(() => {
          if (!body.isConnected) return;
          if (body.dataset.toolPreset !== p.id) return;         // 用户已经换了预设
          if (body.contains(document.activeElement)) return;    // 正在拖滑块，别打断
          if (engineStamp() === drawnWith) return;              // 结果跟画的时候一样 ⇒ 不重画（防死循环的最后一道闸）
          const saved = promptTarget;
          promptTarget = target;
          try { fillToolDetail(body, P().presetById(p.id) || p); }
          finally { promptTarget = saved; }
        });
    };
    probeAndRedraw(false);

    const st = window.MATTINGENGINE ? window.MATTINGENGINE.snapshot() : null;
    // ⚠ 按 kind 问 —— 抠像能用不代表人体解析也能用（那是两套模型、各算各的档位）
    const why = window.MATTINGENGINE ? window.MATTINGENGINE.unusableReason(kind) : '调度层没加载';
    const head = document.createElement('div');
    head.className = 'ai-help';
    const checking = !!(st && st.probing && !st.probed);
    head.innerHTML = why
      ? (checking
          ? '<b>正在检查' + esc(kindLabel) + '引擎…</b>'
          : '<b style="color:hsl(var(--sem-warn))">⚠ 现在还用不了</b><br>' + esc(why))
      : esc(kindLabel) + '引擎在线 · ' + esc((st && st.device) || '')
        + '<br>参数改完立刻生效，不用保存。先在 Photoshop 里框好选区，再按开始计算的快捷键。';
    // ⭐ 「重新检查」：用户刚在外挂能力卡里点了"立刻启动"，回到这儿不该还要等 60 秒缓存过期。
    //   在途时不给按钮（点了也是同一个请求）。
    if (!checking) {
      const re = document.createElement('button');
      re.className = 'pd-hb';
      re.type = 'button';
      re.textContent = '重新检查';
      re.title = '再探一次引擎（刚启动了引擎的话点这个）';
      // ⚠ .pd-hb 是 24×24 的图标按钮样式，文字按钮必须把宽高放开，否则「重新检查」被挤成一字宽竖排压在说明上
      //   （2026-09-29 截图抓到；抠像等 4 件拆成独立工具后，引擎没启动时人人都会看到这里）。
      re.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;vertical-align:middle;width:auto;height:auto;min-height:22px;display:inline-flex;white-space:nowrap;';
      re.addEventListener('click', ev => {
        ev.stopPropagation();
        // ⚠ 先把焦点从按钮上拿掉：重画的护栏是"焦点在面板里就不动"，
        //   不 blur 的话点了按钮反而永远不重画（焦点正好在面板里）。
        re.blur();
        re.textContent = '检查中…'; re.disabled = true;
        probeAndRedraw(true);
      });
      head.appendChild(re);
    }
    area.appendChild(head);

    // ── 模型档位 ──
    const tierRow = document.createElement('div');
    tierRow.className = 'pd-field';
    const opts = [['auto', '自动（用能跑的最高档）']];
    // ⚠⚠ 必须【只列这一类能力的模型】。引擎现在一张表里同时管抠像/人体解析/SAM2，
    //   不过滤的话抠像面板的档位下拉里会冒出 SegFormer、SAM2 这些根本不相干的东西，
    //   用户选了之后引擎会去加载一个完全不对的模型 —— 而且不报错（铁律 17）。
    const kindModels = (window.MATTINGENGINE && window.MATTINGENGINE.modelsOfKind)
      ? window.MATTINGENGINE.modelsOfKind(kind)
      : ((st && st.models) || {});
    Object.keys(kindModels).forEach(k => {
      const m = kindModels[k];
      // ⚠ 三种状态要分清楚，别都写成"未安装"：
      //   missing = 文件真没下  /  broken = 文件在但用不了（下了一半、缺配套解码器、
      //   或者这台机器没装 PyTorch）。
      //   都写"未安装"的话，用户会跑去重下一个【已经下好的】模型，怎么下都没用。
      //   引擎在 reason 里写了人话的原因，挂到 title 上，鼠标一停就能看见。
      const tag = m.state === 'ok' ? '' : (m.state === 'broken' ? '（用不了）' : '（未安装）');
      opts.push([String(m.tier), m.name + tag, m.reason || '']);
    });
    tierRow.innerHTML = '<div class="pd-field-label">模型档位</div>'
      + '<select class="pd-field-input" data-mt="tier">'
      + opts.map(o => '<option value="' + esc(o[0]) + '"'
          + (o[2] ? ' title="' + esc(o[2]) + '"' : '')
          + (String(vals.tier) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('')
      + '</select>';
    // ⭐ 把【引擎自己写的】那档模型的说明显示出来（docs/40 规矩5 / docs/48 坑64）。
    //   高精抠像那档热身后还要 8-9 秒，不在界面上明说，用户会以为卡死了。
    //   ⚠ 文案从引擎的 desc 里取，不在界面写死 —— 写死的话换个模型就对不上，
    //     而且对不上【不报错】，只是骗人。
    const tierDesc = document.createElement('div');
    tierDesc.className = 'pd-field-desc';
    const paintTierDesc = () => {
      let m = null;
      if (String(vals.tier) === 'auto') {
        const t = window.MATTINGENGINE && window.MATTINGENGINE.tierOf ? window.MATTINGENGINE.tierOf(kind) : 0;
        const k2 = (window.MATTINGENGINE && t) ? window.MATTINGENGINE.keyForTier(t, kind) : '';
        m = k2 ? kindModels[k2] : null;
      } else {
        const k2 = window.MATTINGENGINE ? window.MATTINGENGINE.keyForTier(Number(vals.tier), kind) : '';
        m = k2 ? kindModels[k2] : null;
      }
      tierDesc.textContent = m && m.desc ? m.desc : '';
      tierDesc.style.display = tierDesc.textContent ? '' : 'none';
    };
    paintTierDesc();
    tierRow.appendChild(tierDesc);
    area.appendChild(tierRow);
    tierRow.querySelector('select').addEventListener('change', e => {
      vals.tier = e.target.value; save(); paintTierDesc();
    });

    // ── 抓图分辨率 ──
    // ⚠ 这一项【不是】设置里那个"发给 AI 的图"的上限。抠像是给原图加透明通道，
    //   缩了就是把用户的原图降质，贴回去还要拉大回选区尺寸 —— 糊上加糊。
    const resRow = document.createElement('div');
    resRow.className = 'pd-field';
    resRow.innerHTML = '<div class="pd-field-label">抓图分辨率</div>'
      + '<select class="pd-field-input" data-mt="res">'
      + MATTING_RES_OPTS.map(o => '<option value="' + esc(o[0]) + '"'
          + (String(Number(vals.res) || 0) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('')
      + '</select>'
      + '<div class="pd-field-desc">默认原始尺寸，抠出来多大就贴回多大。'
      + '选区特别大（几千像素以上）时如果觉得卡，往下调一档。</div>';
    area.appendChild(resRow);
    resRow.querySelector('select').addEventListener('change', e => {
      vals.res = Number(e.target.value) || 0; save();
    });

    // ── 参数区：三种能力各画各的（外壳上面那些三种共用）──
    if (kind === 'segment')   renderSegmentFields(area, vals, save, kindModels);
    else if (kind === 'sam2') renderSAM2Fields(area, vals, save);
    else                      renderMattingFields(area, vals, save);

    // ── 底栏 ──
    // ⚠⚠ 这个 ▶ 和提示词面板那个 ▶ 走的是【同一个入口】(S.host.onRun)，
    //   不再有"抠像专用的开始按钮"。宿主那边按当前选中的预设是什么来分流，
    //   所以按钮、快捷键、以后再加的任何入口，行为永远一致
    //   —— 项目里那条"按钮和快捷键都走这里，不存在两套逻辑"的老规矩。
    if (footEl) {
      footEl.innerHTML =
        '<button class="pd-hb pd-hb-run" data-act="run" title="抓 Photoshop 选区，抠完贴回去">'
          + ico('play') + '</button>' +
        '<button class="pd-hb" data-act="clear" title="取消选中（回到提示词）">×</button>';
      bindHead(footEl);
    }
    window.V7CardArchitecture?.helpify(area);
  }

  // 给 ui.html 的推进逻辑用: 它只有行元素的 data-preset-id
  function loadPresetById(id, withGlow) {
    const p = P().presetById(id);
    if (p) return loadPreset(p, withGlow);
  }

  function unloadPreset() {
    // ⭐ 取消选中【工具类预设】只松开这一条，不动提示词。
    //   用户点抠像面板上那个 × 想的是"我不抠了，回去用提示词"，
    //   顺手把他写了半天的词清空会挨骂。
    if (St.toolId) {
      St.toolId = '';
      selectReferences(P().presetById(St.presetId));
      S.selPreset = St.presetId || null;
      restoreWorkflowState();
      savePromptState();
      refreshListOnly();
      refreshAllPromptViews();          // 面板要从抠像变回提示词 = 模式变了，两个框都重画
      return;
    }
    S.selPreset = null;
    St.text = ''; St.presetId = ''; St.presetTitle = '';
    selectReferences(null);
    // ⚠ 主动解绑/清空 = 连来源一起断干净。
    //   这是唯一该清 origin 的地方：用户明确说了"不要这条预设了"。
    //   （手改提示词【不清】，只标已改 —— 那是"改一改"，不是"不要了"）
    St.originTitle = ''; St.originEdited = false;
    St.workflowParameters = {}; St.workflowPresetId = '';
    S.forceText = false;
    savePromptState();
    notifyWorkflowParameters(null);
    refreshListOnly();
    // ⚠ 清空会让视图从参数滑块变回空文本框 —— 属于"模式变了"，
    //   两个框都得重画(轻量同步只改 value，接不住模式切换)。
    refreshAllPromptViews();
  }

  // ── 三级渲染入口(ui.html 的 fillDetailBody 会调这个) ──
  // 当前提示词框画在哪: 'detail'(三级 dcBody) 或 'zone'(路线 A 的二级卡)。
  // 两处用同一套渲染, 只是容器和排版不同(.qz-body 下 CSS 走紧凑版)。
  let promptTarget = 'detail';
  function promptBodyEl() {
    if (promptTarget === 'zone') return S.host && S.host.promptZoneBody && S.host.promptZoneBody();
    return S.host && S.host.detailBody && S.host.detailBody();
  }
  function fillDetail(animate, dir) {
    const body = promptBodyEl();
    if (!body) return;
    // ⚠ 三级切换时要跟别的主卡一样【整体上下滚动】(2026-09-11)。
    //   以前这两个参数收了但从没用过 —— 不管怎么切都是直接重画，
    //   表现就是"别的卡切换有滚动动画、预设卡的三级是硬切"。
    //   ⚠ 只在画三级(detail)时走动画: 二级那张提示词卡跟着别的二级一起联动，
    //     它有自己的滑入，再叠一层会打架。
    //   动画本体复用宿主的 specialDetailFill —— 参数、时长、方向全项目一套，
    //   自己另写一份迟早跟别人不同步。
    if (promptTarget === 'detail' && S.host && S.host.slideDetail) {
      S.host.slideDetail(() => fillDetailNow(body), dir, !!animate);
      return;
    }
    fillDetailNow(body);
  }
  // ⭐⭐ 当前选中的工具类预设（抠像…），没有就是 null。【现查库，不存对象】。
  //   生成侧的"按快捷键该跑什么"也读这个 —— 一个来源，不推送、不镜像
  //   （同 getPresetOrigin 那条教训：推的路径漏一条就静默失效）。
  function toolPresetNow() {
    if (!St.toolId) return null;
    const p = P().presetById(St.toolId);
    if (!p) { St.toolId = ''; return null; }          // 预设被删了 → 自动松绑
    if ((p.kind || P().KIND_PROMPT) === P().KIND_PROMPT) { St.toolId = ''; return null; }
    return p;
  }

  function workflowPresetNow() {
    if (!St.presetId || St.toolId) return null;
    const p = P().presetById(St.presetId);
    return p && (p.workflow || p.forgeWorkflow) ? p : null;
  }
  function persistentWorkflowState(values) {
    const p = P().presetById(St.workflowPresetId || St.presetId);
    return window.V7Workflows ? V7Workflows.persistentParameters(values, p && (p.workflow || p.forgeWorkflow), p) : {};
  }
  function workflowBindingsOf(p) {
    if (!p || !window.V7Workflows) return [];
    const config = window.V7Workflows.normalizeConfig(p.workflow || p.forgeWorkflow, p);
    return config.parameterBindings.filter(b => b && b.key && b.nodeId != null && b.input);
  }
  function workflowDefaultsOf(p) {
    const out = {};
    const config = p && window.V7Workflows && V7Workflows.normalizeConfig(p.workflow || p.forgeWorkflow, p);
    workflowBindingsOf(p).forEach(binding => {
      const node = config && config.prompt && config.prompt[String(binding.nodeId)];
      const value = binding.default !== undefined ? binding.default : node && node.inputs && node.inputs[binding.input];
      if (value !== undefined && !Array.isArray(value)) out[binding.key] = value;
    });
    return Object.assign(out, p && p.parameters || {});
  }
  function notifyWorkflowParameters(p) {
    const id = p && (p.workflow || p.forgeWorkflow) ? String(p.id || '') : '';
    if (S.host && S.host.onWorkflowParametersChange) {
      try { S.host.onWorkflowParametersChange(JSON.parse(JSON.stringify(St.workflowParameters || {})), id); } catch (e) { console.warn('[预设] 工作流参数同步失败', e); }
    }
  }
  function restoreWorkflowState() {
    const p = workflowPresetNow();
    St.workflowParameters = p ? Object.assign(workflowDefaultsOf(p), St.workflowPresetId === St.presetId ? St.workflowParameters : {}) : {};
    St.workflowPresetId = p ? String(p.id) : '';
    notifyWorkflowParameters(p);
  }
  function workflowParameterValue(binding) {
    const value = St.workflowParameters && St.workflowParameters[binding.key];
    return value === undefined || value === null ? binding.default : value;
  }
  function renderWorkflowParams(area, p) {
    const bindings = workflowBindingsOf(p);
    if (!area || !p || !bindings.length) return;
    const platform = !/^(rh|runninghub)$/.test(p.provider || '') && S.host && S.host.getWorkflowSource && S.host.getWorkflowSource() === 'platform';
    const section = document.createElement('div');
    section.className = 'pd-workflow-params';
    const title = document.createElement('div');
    title.className = 'pd-field-label'; title.textContent = '工作流参数';
    section.appendChild(title);
    const extra = document.createElement('details'); extra.className = 'pd-workflow-extra';
    const summary = document.createElement('summary'); summary.textContent = '更多参数'; extra.appendChild(summary);
    bindings.forEach(binding => {
      // Positive prompt already uses the main editable prompt box. Rendering
      // it a second time would create two sources of truth.
      if (binding.key === 'positivePrompt') return;
      const row = document.createElement('div'); row.className = 'pd-field';
      const label = document.createElement('div'); label.className = 'pd-field-label'; label.textContent = binding.label || binding.key;
      const current = workflowParameterValue(binding);
      // 平台上文字参数默认锁死；部署方标了 selectable 的（云端装了的模型 / LoRA / 采样器白名单）可以选。
      const selectable = binding.selectable === true && Array.isArray(binding.options) && binding.options.length > 0;
      const locked = platform && binding.type === 'string' && !V7Workflows.transientBinding(binding) && !selectable;
      if (locked || Array.isArray(binding.options) && binding.options.length) {
        row.appendChild(label);
        const input = document.createElement('select'); input.className = 'pd-field-input';
        input.dataset.workflowParam = binding.key; input.setAttribute('aria-label', binding.label || binding.key);
        const options = (locked ? [binding.default] : binding.options).map(value => Array.isArray(value) ? {value:String(value[0]),label:String(value[1])} : {value:String(value),label:String(value)});
        if (!options.some(option => option.value === String(current))) options.unshift({value:String(current == null ? '' : current),label:String(current == null ? '' : current) + '（当前服务中不存在）'});
        options.forEach(option => { const el = document.createElement('option'); el.value = option.value; el.textContent = option.label; el.disabled = locked && option.value !== String(binding.default); input.appendChild(el); });
        input.value = String(current == null ? '' : current);
        if (locked) { input.title = '平台使用该预设已审核的模型与采样配置；本地和自有服务可修改。'; label.textContent += ' · 平台固定'; }
        input.addEventListener('change', () => { St.workflowParameters[binding.key] = binding.type === 'number' ? Number(input.value) : input.value; savePromptState(); notifyWorkflowParameters(p); });
        row.appendChild(input);
      } else if (binding.type === 'number' || typeof current === 'number') {
        const min = Number.isFinite(Number(binding.min)) ? Number(binding.min) : 0;
        const max = /^(imageCount|batch|count)$/.test(binding.key) ? Math.min(18, Number(binding.max) || 18) : Number.isFinite(Number(binding.max)) ? Number(binding.max) : 1;
        const step = Number.isFinite(Number(binding.step)) ? Number(binding.step) : 0.01;
        const head = document.createElement('div'); head.className = 'pd-slider-head';
        const value = document.createElement('span'); value.className = 'pd-slider-val'; value.textContent = String(current == null ? '' : current) + (binding.unit || '');
        head.appendChild(label); head.appendChild(value); row.appendChild(head);
        const range = document.createElement('input'); range.type = binding.key === 'resolution' || max > 100 ? 'number' : 'range'; range.className = range.type === 'range' ? 'pd-range' : 'pd-field-input'; range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(Number.isFinite(Number(current)) ? Number(current) : min);
        range.dataset.workflowParam = binding.key; range.setAttribute('aria-label', binding.label || binding.key);
        range.style.setProperty('--fill', ((Number(range.value) - min) / Math.max(0.000001, max - min) * 100).toFixed(1) + '%');
        range.addEventListener('input', () => {
          if (range.value === '' || !Number.isFinite(Number(range.value))) return;
          const n = Math.max(min, Math.min(max, Number(range.value))); St.workflowParameters[binding.key] = n; value.textContent = String(n) + (binding.unit || '');
          range.style.setProperty('--fill', ((n - min) / Math.max(0.000001, max - min) * 100).toFixed(1) + '%');
          if (binding.key === 'imageCount' || binding.key === 'batch') St.workflowParameters[binding.key] = Math.max(1, Math.round(n));
          savePromptState(); notifyWorkflowParameters(p);
        });
        row.appendChild(range);
        range.addEventListener('change', () => { range.value = String(St.workflowParameters[binding.key] ?? current); });
      } else if (binding.type === 'boolean') {
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = current === true;
        input.dataset.workflowParam = binding.key; input.setAttribute('aria-label', binding.label || binding.key);
        input.addEventListener('change', () => { St.workflowParameters[binding.key] = input.checked; savePromptState(); notifyWorkflowParameters(p); });
        row.appendChild(label); row.appendChild(input);
      } else {
        row.appendChild(label);
        const input = document.createElement(binding.editor === 'textarea' || binding.key === 'negativePrompt' ? 'textarea' : 'input');
        input.className = 'pd-field-input'; input.value = String(current == null ? '' : current); input.title = binding.description || '';
        input.dataset.workflowParam = binding.key; input.setAttribute('aria-label', binding.label || binding.key);
        input.addEventListener('input', () => { St.workflowParameters[binding.key] = input.value; savePromptState(); notifyWorkflowParameters(p); });
        row.appendChild(input);
        if (!binding.sensitive) attachFieldHistory(row, label, input, 'workflow:' + binding.key, value => { St.workflowParameters[binding.key] = value; savePromptState(); notifyWorkflowParameters(p); });
      }
      if (['redrawAmount','denoise','resolution','imageCount','batch','count'].includes(binding.key)) section.appendChild(row);
      else extra.appendChild(row);
    });
    if (extra.children.length > 1) section.appendChild(extra);
    if (section.children.length > 1) area.appendChild(section);
  }

  function fillDetailNow(body) {
    // ⭐⭐ 按 kind 分流的【唯一出口】（2026-09-14 下半场）。
    //   二级提示词卡、三级卡、两框同步、切主卡重填 —— 所有画提示词的路最后都走这儿，
    //   所以分流只写这一处就够，不会有哪条路漏掉（漏掉的表现就是"面板被盖回提示词"）。
    const tool = toolPresetNow();
    if (tool) { fillToolDetail(body, tool); return; }
    body.dataset.workflowPreset = workflowPresetNow() ? String(St.presetId) : '';
    // ⚠ 摘掉工具面板留下的记号。不摘的话"工具→提示词→工具"来回切时，
    //   那个"已经画过就别重画"的判断会拿旧记号命中，把提示词界面留在原地。
    delete body.dataset.toolPreset;
    if (promptTarget === 'detail') {
      const nameEl = S.host && S.host.detailName && S.host.detailName();
      if (nameEl) nameEl.textContent = headTitleText();
    }
    const asParams = (hasParams(St.text) || hasFields(St.text)) && !S.forceText;
    // ⭐ 2026-10-20 历史提示词的时钟（见 histButtonHtml 那段）。开着时换了预设 ⇒ 自动回到提示词框
    //   ⚠ 要在 headHtml 之前判：时钟画在头上，开没开决定它亮不亮
    const target = promptTarget;
    if (S.promptHist[target] && S.promptHistPreset[target] !== St.presetId) S.promptHist[target] = false;
    if (promptTarget === 'zone') {
      // 紧凑版: 头部(无按钮) + 可滚内容 + 常驻底栏(按钮一排)
      body.innerHTML = '<div class="qz-scroll">' + headHtml(asParams) + '<div class="pd-body"></div></div>' +
        '<div class="qz-foot">' + headBtnsHtml(asParams) + '</div>';
    } else {
      // ⚠ 三级跟二级同一套排布(2026-09-11): 标题在头、按钮在底栏。
      //   以前三级是"头部标题 + 头部右侧按钮"，而卡片本身的 .dc-name 已经写了一遍标题，
      //   结果一张卡上两个"提示词"标题(用户截图)。现在 .dc-name 当唯一标题，
      //   pd-head 只留字数，按钮统一挪到底栏 —— 除了宽度，和二级完全一致。
      body.innerHTML = headHtml(asParams) + '<div class="pd-body"></div>' +
        '<div class="pd-foot">' + headBtnsHtml(asParams) + '</div>';
    }
    bindHead(body);
    const area = body.querySelector('.pd-body');
    if (S.promptHist[target]) {
      renderPromptHistory(area, target);
      area.dataset.promptView = 'history';
    } else {
      if (asParams) renderParams(area);
      else renderTextarea(area);
      renderWorkflowParams(area, workflowPresetNow());
    }
    bindHistButton(body, target);
    if (S.promptHist[target]) return;
    // ⭐ 标出当前是哪一态，样式据此分流（2026-09-28 用户定案）：
    //   text   = 单纯输入提示词 / JSON 映射【转到原文】→ 取消外框、正好铺满可写区
    //   params = 还有可填内容（滑块 / 填空 / 工作流参数）→ 保留外框、自适应缩放
    // ⚠ 判据必须在【渲染完之后】看，不能只看 asParams：
    //   工作流预设的正文里没有 @param:/【填空:】，asParams 是 false，
    //   但它渲染完会多出一个「工作流参数」块（实测 15/15 全带）——
    //   那时它属于"可以填写内容的提示词"，要按 params 处理（先前就是这里判错）。
    // ⚠ 但用户点了「切到原文」(forceText)时是【明确要编辑原文】，这时候按 text 处理：
    //   这是用户原话里点名的第二种情形("把 JSON 格式的映射转为输入提示词的状态")。
    if (area) {
      area.dataset.promptView = (!S.forceText && (asParams || area.querySelector('.pd-workflow-params'))) ? 'params' : 'text';
    }
  }
  // 路线 A 入口: ui.html 弹出提示词二级卡时调
  function fillPromptZone() { promptTarget = 'zone'; fillDetail(false); }
  // 路线 B / 三级入口
  function fillDetailCard(animate, dir) { promptTarget = 'detail'; fillDetail(animate, dir); }

  // ═══ 二级/三级两个提示词框的连通同步(2026-09-11) ═══════════
  //  背景: 二级(路线A的提示词卡)和三级(detail)显示的是【同一份 St.text】，
  //    但 fillDetail 每次只画 promptTarget 指向的那一个容器，另一个就停在旧快照。
  //    两个框同时开着时(见 docs/30 那条待解的交互问题)，就会一个新一个旧、各说各话。
  //    在那条交互规则定下来之前，先让两边【内容始终一致】，至少不会自相矛盾。
  //
  //  ⚠ 不能靠 promptTarget 判断"用户在哪个框里打字" —— 它只记得最后一次渲染的是谁，
  //    两个框都渲染过时它是错的。必须看【焦点】在哪个容器里。
  //  ⚠ 正在操作的那个容器绝不能重画: 重画会掐掉光标位置、打断滑块拖拽。
  let syncingViews = false, syncQueued = false;
  function syncPromptViewsNow() {
    if (syncingViews) return;
    syncingViews = true;
    const saved = promptTarget;
    const active = document.activeElement;
    try {
      ['zone', 'detail'].forEach(t => {
        promptTarget = t;
        const body = promptBodyEl();
        if (!body || !body.querySelector('.pd-body')) return; // Shared detail may currently display history/settings.
        // 这个框正开着「最近用过的提示词」而且预设没换 ⇒ 不重画（不然另一个框每打一个字，这边的搜索和列表就被冲掉）
        if (body.querySelector('.pd-body[data-prompt-view="history"]') && S.promptHistPreset[t] === St.presetId) return;
        if (active && body.contains(active)) {       // 用户正在这里面操作 → 只更新标题/字数
          // ⚠ 工具面板里没有"标题/字数"这一行，而且正在拖的滑块绝不能重画 → 直接跳过。
          if (!toolPresetNow()) updateHeadTitle();
          return;
        }
        // ⚠ 工具类预设(抠像…)走整块重画 —— 下面那套 textarea/滑块的判断是提示词专用的，
        //   套到工具面板上会把它当"文本模式"留在原地不更新。
        if (toolPresetNow()) { fillDetail(false); return; }
        // ⚠ 先看"该显示哪种视图"，再看"现在显示的是哪种"。
        //   两者不一致 = 模式变了(比如载入了带参数的预设、或者清空了)，
        //   这时【必须重画】，只改 value 的话会卡在旧视图上 ——
        //   表现就是"一个框已经是滑块了，另一个还是文本框"。
        const wantParams = (hasParams(St.text) || hasFields(St.text)) && !S.forceText;
        const ta = body.querySelector('.pd-ta');
        const activeWorkflowId = workflowPresetNow() ? String(St.presetId) : '';
        if (body.dataset.workflowPreset !== activeWorkflowId) { fillDetail(false); return; }
        if (!wantParams && ta) {
          // 文本模式，而且对面本来就是文本框 → 只改 value，保住它的滚动位置
          if (ta.value !== St.text) ta.value = St.text;
          updateHeadTitle();
          body.querySelectorAll('[data-workflow-param]').forEach(input => {
            const value = St.workflowParameters[input.dataset.workflowParam];
            if (input.type === 'checkbox') input.checked = value === true;
            else if (value !== undefined) input.value = String(value);
            const label = input.closest('.pd-field') && input.closest('.pd-field').querySelector('.pd-slider-val');
            if (label) label.textContent = String(value == null ? '' : value);
            if (input.type === 'range') input.style.setProperty('--fill', ((Number(input.value) - Number(input.min)) / Math.max(0.000001, Number(input.max) - Number(input.min)) * 100) + '%');
          });
        } else {
          // 其余全部重画: 模式要变、或者参数视图的数值变了(滑块值在 DOM 里，只能重画)
          fillDetail(false);
        }
      });
    } catch (e) {
      console.warn('[预设] 两个提示词框同步失败', e);
    } finally {
      promptTarget = saved;
      syncingViews = false;
    }
  }
  // ⚠ 必须节流: 拖滑块是高频事件(每帧都可能触发 savePromptState)，
  //   不合并的话对面那个参数视图会被一秒重画几十次，直接卡住。
  function syncPromptViews() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; syncPromptViewsNow(); });
  }

  // 两个框【都】强制重画。用于"视图模式变了"的场合(查看原文 ↔ 参数滑块、清空)。
  // ⚠ 不能用 syncPromptViews 代替: 那个为了保住光标/拖拽，会跳过有焦点的容器，
  //   而点"查看原文"时焦点恰恰就在那个按钮上 —— 用它的话按的那一下反而不生效。
  function refreshAllPromptViews() {
    if (syncingViews) return;
    syncingViews = true;
    const saved = promptTarget;
    try {
      ['zone', 'detail'].forEach(t => {
        promptTarget = t;
        const body = promptBodyEl();
        if (body && body.querySelector('.pd-body')) fillDetail(false);
      });
    } catch (e) {
      console.warn('[预设] 两个提示词框重画失败', e);
    } finally {
      promptTarget = saved;
      syncingViews = false;
    }
  }

  function headHtml(inParams) {
    // ⭐ 2026-10-22（用户：「提示词字数统计我不要」「参数统计不必要」，docs/263 三级卡瘦身）：
    //   标题下面那行「34 字 / 6 个参数」整个删了；历史提示词的时钟从提示词框右上角挪到这里，
    //   跟张数 / 抗截断 / 尺寸同一行（以前在三级里会单独挤占一行）。
    // ⭐⭐ 2026-10-14（用户定）：张数/抗截断放到【右上角】。
    //   ⚠ 二级和三级共用这一个 headHtml()，所以一处接线两处生效。
    //   ⚠ 实现在 ui.html（window.V7QuickParams）—— aiRuntime 不在本文件作用域。
    //   ⚠ 拿不到就不画：宁可不显示，也不要画一个点了没反应的死控件。
    const quick = (window.V7QuickParams && typeof V7QuickParams.html === 'function') ? V7QuickParams.html() : '';
    return '<div class="pd-head">' +
      '<div class="pd-head-info">' +
      '<div class="pd-head-title">' + esc(headTitleText()) + '</div>' +
      '</div>' +
      '<div class="pd-head-tools">' + quick + histButtonHtml(!!S.promptHist[promptTarget]) + '</div>' +
      '<div class="pd-head-btns">' + headBtnsHtml(inParams) + '</div>' +
      '</div>';
  }
  function headBtnsHtml(inParams) {
    const canToggle = hasParams(St.text) || hasFields(St.text);
    return (canToggle ? '<button class="pd-hb" data-act="toggle" title="' + (inParams ? '看原文（可编辑/复制）' : '切回参数滑块') + '">' + ico(inParams ? 'note' : 'sliders') + '</button>' : '') +
      '<button class="pd-hb pd-hb-run" data-act="run" title="用当前参数开始计算">' + ico('play') + '<span>开始计算</span></button>' +
      '<button class="pd-hb" data-act="save" title="另存为新预设">' + ico('save') + '</button>' +
      '<button class="pd-hb" data-act="preactions" title="编辑预设前置动作">' + ico('wrench') + '</button>' +
      '<button class="pd-hb" data-act="clear" title="清空并卸载预设">×</button>';
  }

  function bindHead(root) {
    // ⭐⭐ 2026-10-14：提示词卡头部也带快捷调参条，顺手把它的点按接上。
    if (window.V7QuickParams && typeof V7QuickParams.bind === 'function') V7QuickParams.bind(root);
    root.querySelectorAll('.pd-hb').forEach(b => {
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = b.dataset.act;
        // ⚠ forceText 是【全局】开关，两个框必须一起翻 —— 只重画一个的话，
        //   会出现"二级在看原文、三级还是滑块"这种自相矛盾的状态(2026-09-11)。
        if (act === 'toggle') { S.forceText = !S.forceText; refreshAllPromptViews(); }
        else if (act === 'run') {
          b.classList.remove('firing'); void b.offsetWidth; b.classList.add('firing');
          setTimeout(() => b.classList.remove('firing'), 280);
          if (S.host && S.host.onRun) S.host.onRun(St.text);
        }
        else if (act === 'save') saveCurrentAsPreset();
        else if (act === 'preactions') {
          const p = workflowPresetNow() || toolPresetNow() || (St.presetId && P().presetById(St.presetId));
          if (p && window.V7PresetPreActions) window.V7PresetPreActions.openEditor(p);
        }
        else if (act === 'clear') unloadPreset();
      });
    });
  }

  function renderTextarea(area) {
    const ta = document.createElement('textarea');
    ta.className = 'pd-ta';
    ta.placeholder = '在这里写修图提示词，或者从左边挑一个预设';
    ta.value = St.text;
    area.appendChild(ta);
    S.lastHadParams = hasParams(St.text) || hasFields(St.text);
    ta.addEventListener('input', () => {
      const v = ta.value;
      const now = hasParams(v) || hasFields(v);
      // 参数从无到有 = 贴进来一段新的参数提示词 → 解除"强制原文", 让它变回滑块
      if (now && !S.lastHadParams) S.forceText = false;
      S.lastHadParams = now;
      St.text = v;
      // 手打就等于不再绑着那个预设了(V6 同样的规矩)
      if (St.presetId && !workflowPresetNow()) { St.presetId = ''; St.presetTitle = ''; S.selPreset = null; refreshListOnly(); }
      // ⭐ 但【来源】留着，只标成"已改"（2026-09-13 用户定案）。
      //   V6 是连来源一起断，于是改一个字，任务卡就只剩"自定义提示词"，
      //   叠着七八个任务时完全认不出是哪条预设跑的 —— 用户要的是「预设名 · 已改」。
      //   ⚠ 词被清空了就不算"改"了，是"没了" —— 来源一并清掉，
      //     否则空词也会顶着上一条预设的名字（V6 叫"幽灵预设名"）。
      if (!v.trim()) { St.originTitle = ''; St.originEdited = false; }
      else if (St.originTitle) St.originEdited = true;
      savePromptState();
      if (now && !S.forceText) fillDetail(false);
      else updateHeadTitle();
    });
  }

  // 提示词框顶上那行标题的【唯一来源】(2026-09-13)。三处都读它，别各写各的。
  //   绑着预设      → 预设名
  //   改过词        → 预设名 · 已改   （和任务卡上写的一模一样，两边对得上）
  //   啥都没有      → 提示词
  function headTitleText() {
    if (St.presetTitle) return St.presetTitle;
    if (St.originTitle) return St.originTitle + ' · 已改';
    return '提示词';
  }
  function updateHeadTitle() {
    const root = promptBodyEl() || document;
    const t = root.querySelector('.pd-head-title');
    if (t) t.textContent = headTitleText();
  }

  // ── 参数 / 填空 解析(移植自 V6 tile-prompt.js) ──
  function parseParams(text) {
    const params = [], labelMap = {}, descMap = {}, seen = {};
    const r = /"?@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g;
    let m;
    while ((m = r.exec(text)) !== null) {
      const raw = m[1], val = m[2];
      const str = val.charAt(0) === '"' ? val.slice(1, -1) : val;
      if (raw.slice(-5) === '_desc') { descMap[raw.slice(0, -5)] = str; continue; }
      if (raw.slice(-6) === '_label') { labelMap[raw.slice(0, -6)] = str; continue; }
      const v = parseFloat(val);
      if (isNaN(v) || seen[raw]) continue;
      seen[raw] = true;
      params.push({ name: raw, value: v, fmt: 'new' });
    }
    // 老简化格式 @NAME:0.5
    const rOld = /@([A-Za-z_][\w]*)(?:\s*["“]([^"“”]*)["”])?\s*[:：]\s*([\d.]+)/g;
    while ((m = rOld.exec(text)) !== null) {
      const n = m[1];
      if (seen[n]) continue;
      const before = text.charAt(m.index - 1);
      if (before === ':' || before === '"') continue;
      seen[n] = true;
      params.push({ name: n, label: m[2] || n, value: parseFloat(m[3]), fmt: 'old' });
    }
    return { params, labelMap, descMap };
  }
  function parseFields(text) {
    const out = [], seen = {};
    const r = /【填空:([^=】]+?)(?:=([^】]*))?】/g;
    let m;
    while ((m = r.exec(text)) !== null) {
      if (seen[m[1]]) continue;
      seen[m[1]] = true;
      out.push({ name: m[1], value: m[2] != null ? m[2] : '' });
    }
    return out;
  }
  function rxEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function captureFieldHistory(options) {
    const input = options || { presetId: St.presetId, text: St.text, workflowParameters: St.workflowParameters };
    const fields = parseFields(String(input.text || '')).map(f => ({ name: 'fill:' + f.name, value: f.value }));
    const p = P().presetById(input.presetId);
    if (p && (p.workflow || p.forgeWorkflow)) workflowBindingsOf(p).forEach(binding => {
      if (binding.type === 'string' && binding.key !== 'positivePrompt' && !binding.options && !binding.sensitive) {
        const value = input.workflowParameters && input.workflowParameters[binding.key];
        if (value !== undefined) fields.push({ name: 'workflow:' + binding.key, value });
      }
    });
    return window.V7PresetFieldHistory?.capture(input.presetId, fields) || null;
  }

  function recordFieldHistory(snapshot) {
    try { return window.V7PresetFieldHistory?.record(snapshot) || { saved: 0 }; }
    catch (e) { window.ERR?.report('PRESET_FIELD_HISTORY_FAILED', { message: String(e.message || e) }); return { saved: 0 }; }
  }
  function attachFieldHistory(row, label, input, field, apply) {
    const api = window.V7PresetFieldHistory, presetId = St.presetId;
    if (!api || !presetId || !api.allowed(field)) return;
    const heading = document.createElement('div'); heading.className = 'pd-field-heading';
    row.insertBefore(heading, label); heading.append(label);
    const saved = document.createElement('div'); saved.className = 'pd-field-history'; saved.hidden = true;
    const select = document.createElement('select'); select.className = 'pd-field-input'; select.setAttribute('aria-label', label.textContent + '已存内容');
    const refresh = () => {
      select.replaceChildren(new Option('选择已存内容', ''));
      api.list(presetId, field).forEach((item, i) => { const option = new Option(item.value.replace(/\s+/g, ' ').slice(0, 100), String(i)); option.title = item.value; select.append(option); });
    };
    const button = (icon, title, action) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pd-hb'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = ico(icon, 13); b.addEventListener('click', e => { e.stopPropagation(); action(); }); return b; };
    heading.append(button('save', '保存当前输入', () => { const result = recordFieldHistory(api.capture(presetId, [{name:field,value:input.value}])); if (result.saved) { refresh(); toast('已保存当前输入', 'ok'); } }));
    // ⚠ 2026-10-15：select 已被 ui-select 藏起来，焦点要给它旁边看得见的 trigger，且不许滚（藏着的 select 一拿焦点会推走外层框）
    heading.append(button('chevronDown', '选择已存输入', () => { refresh(); saved.hidden = !saved.hidden; if (!saved.hidden) { const t = select.nextElementSibling; try { ((t && t.classList.contains('uisel-trigger')) ? t : select).focus({ preventScroll: true }); } catch (_) { } } }));
    select.addEventListener('change', () => { const value = select.value === '' ? null : api.list(presetId, field)[Number(select.value)]; if (value) { input.value = value.value; apply(value.value); saved.hidden = true; input.focus(); } });
    saved.append(select, button('broom', '清空这个字段的已存内容', () => { try { api.remove(presetId, field); refresh(); } catch(e) { window.ERR?.report('PRESET_FIELD_HISTORY_FAILED', {message:String(e.message||e)}); } }));
    row.append(saved);
  }

  function renderParams(area) {
    const { params, labelMap, descMap } = parseParams(St.text);
    const fields = parseFields(St.text);

    // 同名填空归一: 一律以第一个出现的值为准, 把原文里所有同名标记拉平
    if (fields.length) {
      const canon = {};
      fields.forEach(f => { canon[f.name] = f.value; });
      const norm = St.text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, (mm, nm) =>
        (nm in canon) ? ('【填空:' + nm + '=' + canon[nm] + '】') : mm);
      if (norm !== St.text) { St.text = norm; savePromptState(); }
    }

    if (fields.length) {
      const fa = document.createElement('div');
      fa.className = 'pd-fields';
      fields.forEach(f => {
        const row = document.createElement('div');
        row.className = 'pd-field';
        const lb = document.createElement('div');
        lb.className = 'pd-field-label'; lb.textContent = f.name;
        const inp = document.createElement('textarea');
        inp.className = 'pd-field-input'; inp.rows = 1;
        inp.placeholder = '在此输入' + f.name;
        inp.value = f.value;
        inp.addEventListener('input', () => {
          setField(f.name, inp.value);
          if (inp.scrollHeight > inp.clientHeight + 2) inp.style.height = Math.min(inp.scrollHeight + 2, 240) + 'px';
        });
        row.appendChild(lb); row.appendChild(inp);
        attachFieldHistory(row, lb, inp, 'fill:' + f.name, value => setField(f.name, value));
        fa.appendChild(row);
        if (inp.scrollHeight > inp.clientHeight + 2) inp.style.height = Math.min(inp.scrollHeight + 2, 240) + 'px';
      });
      area.appendChild(fa);
    }

    if (params.length) {
      const grid = document.createElement('div');
      grid.className = 'pd-sliders' + (params.length > 6 ? ' tight' : '');
      params.forEach(p => {
        const label = labelMap[p.name] || p.label ||
          (/^[A-Za-z_][\w]*$/.test(p.name) ? p.name.replace(/_/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase()) : p.name);
        const desc = descMap[p.name] || '';
        const row = document.createElement('div');
        row.className = 'pd-slider';
        const head = document.createElement('div');
        head.className = 'pd-slider-head';
        if (desc) head.title = desc;
        const nm = document.createElement('span');
        nm.className = 'pd-slider-name'; nm.textContent = label;
        const vv = document.createElement('span');
        vv.className = 'pd-slider-val'; vv.textContent = p.value.toFixed(2);
        head.appendChild(nm); head.appendChild(vv);
        const rg = document.createElement('input');
        rg.type = 'range'; rg.min = '0'; rg.max = '1'; rg.step = '0.01';
        rg.value = String(p.value);
        rg.className = 'pd-range';
        rg.style.setProperty('--fill', (p.value * 100).toFixed(1) + '%');
        rg.addEventListener('input', () => {
          const nv = Math.max(0, Math.min(1, parseFloat(rg.value)));
          // 数字上下滚动切换(和生成卡的条共用同一个实现，别各写各的)。
          // 方向跟着增减走：变大从下滚上来、变小从上滚下去。
          const prev = parseFloat(rg.dataset.prevVal);
          if (window.rollNumber) window.rollNumber(vv, nv.toFixed(2), isNaN(prev) ? 1 : (nv - prev));
          else vv.textContent = nv.toFixed(2);
          rg.dataset.prevVal = String(nv);
          rg.style.setProperty('--fill', (nv * 100).toFixed(1) + '%');
          setParam(p.name, nv, p.fmt);
        });
        row.appendChild(head); row.appendChild(rg);
        grid.appendChild(row);
      });
      area.appendChild(grid);
    }

    if (hasMemory()) {
      const bar = document.createElement('div');
      bar.className = 'pd-memory';
      const b = document.createElement('button');
      b.className = 'pd-memory-btn';
      // ⚠ 图标+文字混排：用 innerHTML 拼，间距靠 .pd-memory-btn 的 flex gap，
      //   不要在这里写 &nbsp; 或 margin —— 那样两种排版方式会打架。
      b.innerHTML = ico('revert', 13) + '<span>还原预设默认值</span>';
      b.title = '放弃已记住的调整，回到预设自带的值（预设文件从头到尾没被改过）';
      b.addEventListener('click', ev => { ev.stopPropagation(); restoreDefaults(); });
      bar.appendChild(b);
      area.appendChild(bar);
    }
  }

  function setParam(name, v, fmt) {
    const orig = extractParam(St.text, name, fmt);
    if (fmt === 'new') {
      St.text = St.text.replace(new RegExp('("?@param:' + rxEsc(name) + '"\\s*:\\s*)[-\\d.]+', 'g'), '$1' + v);
    } else {
      St.text = St.text.replace(new RegExp('(@' + rxEsc(name) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*)[\\d.]+'), '$1' + v);
    }
    remember('p', name, v, fmt, orig);
    savePromptState();
  }
  function setField(name, val) {
    const orig = extractField(St.text, name);
    const safe = String(val).replace(/[【】]/g, '');   // 防止把标记外壳打破
    St.text = St.text.replace(new RegExp('【填空:' + rxEsc(name) + '(?:=[^】]*)?】', 'g'),
      () => '【填空:' + name + '=' + safe + '】');
    remember('f', name, safe, null, orig);
    savePromptState();
  }
  function extractField(t, n) {
    const m = new RegExp('【填空:' + rxEsc(n) + '(?:=([^】]*))?】').exec(t);
    return m ? (m[1] || '') : null;
  }
  function extractParam(t, n, fmt) {
    const m = fmt === 'new'
      ? new RegExp('"?@param:' + rxEsc(n) + '"?\\s*:\\s*([-\\d.]+)').exec(t)
      : new RegExp('@' + rxEsc(n) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*([\\d.]+)').exec(t);
    return m ? m[1] : null;
  }

  // ── 参数记忆: 按预设记住调过的值; 预设文件永不改写 ──
  function memKey() { return St.presetId ? ('id:' + St.presetId) : (St.presetTitle ? 't:' + St.presetTitle : ''); }
  function memAll() { try { return JSON.parse(localStorage.getItem(memoryStorageKey()) || '{}'); } catch (_) { return {}; } }
  function memSave(all) { try { localStorage.setItem(memoryStorageKey(), JSON.stringify(all)); } catch (_) { } }
  function remember(type, name, value, fmt, origValue) {
    const k = memKey(); if (!k) return;
    const all = memAll();
    const rec = all[k] || (all[k] = {});
    rec.f = rec.f || {}; rec.p = rec.p || {};
    rec.orig = rec.orig || { f: {}, p: {} };
    const bucket = type === 'f' ? 'f' : 'p';
    if (origValue != null && !(name in rec.orig[bucket])) rec.orig[bucket][name] = origValue;
    if (type === 'f') rec.f[name] = value; else rec.p[name] = { v: value, fmt: fmt || 'old' };
    rec.ts = Date.now();
    const keys = Object.keys(all);
    if (keys.length > MEM_MAX) {
      keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
      for (let i = 0; i < keys.length - MEM_MAX; i++) delete all[keys[i]];
    }
    memSave(all);
  }
  function hasMemory() {
    const k = memKey(); if (!k) return false;
    const r = memAll()[k];
    return !!(r && ((r.f && Object.keys(r.f).length) || (r.p && Object.keys(r.p).length)));
  }
  function applyMemory() {
    const k = memKey(); if (!k) return;
    const all = memAll(); const rec = all[k];
    if (!rec) return;
    let changed = false;
    rec.orig = { f: {}, p: {} };
    Object.keys(rec.f || {}).forEach(name => {
      const cur = extractField(St.text, name);
      if (cur === null) { delete rec.f[name]; return; }       // 预设改版后没这个填空了 → 剪掉记忆
      rec.orig.f[name] = cur;
      const safe = String(rec.f[name]).replace(/[【】]/g, '');
      if (safe === cur) return;
      St.text = St.text.replace(new RegExp('【填空:' + rxEsc(name) + '(?:=[^】]*)?】', 'g'),
        () => '【填空:' + name + '=' + safe + '】');
      changed = true;
    });
    Object.keys(rec.p || {}).forEach(name => {
      const o = rec.p[name] || {};
      let v = parseFloat(o.v);
      const cur = extractParam(St.text, name, o.fmt);
      if (cur === null || isNaN(v)) { delete rec.p[name]; return; }
      v = Math.max(0, Math.min(1, v));
      rec.orig.p[name] = cur;
      if (String(v) === cur) return;
      if (o.fmt === 'new') St.text = St.text.replace(new RegExp('("?@param:' + rxEsc(name) + '"\\s*:\\s*)[-\\d.]+', 'g'), '$1' + v);
      else St.text = St.text.replace(new RegExp('(@' + rxEsc(name) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*)[\\d.]+'), '$1' + v);
      changed = true;
    });
    if (!Object.keys(rec.f).length && !Object.keys(rec.p).length) delete all[k];
    memSave(all);
    if (changed) toast('已恢复上次的参数调整（预设本身没动过）', 'info');
  }
  function restoreDefaults() {
    const k = memKey(); if (!k) return;
    const all = memAll(); const rec = all[k]; if (!rec) return;
    const orig = rec.orig || { f: {}, p: {} };
    Object.keys(orig.f || {}).forEach(name => {
      St.text = St.text.replace(new RegExp('【填空:' + rxEsc(name) + '(?:=[^】]*)?】', 'g'),
        () => '【填空:' + name + '=' + orig.f[name] + '】');
    });
    Object.keys(orig.p || {}).forEach(name => {
      const fmt = (rec.p && rec.p[name] && rec.p[name].fmt) || 'old';
      if (fmt === 'new') St.text = St.text.replace(new RegExp('("?@param:' + rxEsc(name) + '"\\s*:\\s*)[-\\d.]+', 'g'), '$1' + orig.p[name]);
      else St.text = St.text.replace(new RegExp('(@' + rxEsc(name) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*)[\\d.]+'), '$1' + orig.p[name]);
    });
    delete all[k]; memSave(all);
    savePromptState();
    fillDetail(false);
    toast('已还原预设默认值', 'ok');
  }

  // ═══════════════════════════════════════════════════════════
  //  保存 / 导入 / 导出
  // ═══════════════════════════════════════════════════════════
  function saveCurrentAsPreset() {
    if (!St.text.trim()) { toast('提示词是空的，没东西可存', 'warn'); return; }
    const saveGuard=window.V7PresetReferences?.context();
    const assets = presetCategoryAssets();
    const defCat = S.toolGroupOpen ? P().UNSORTED_ID : (S.selAsset || (assets[0] && assets[0].id) || P().UNSORTED_ID);
    promptDialog({
      title: '保存为预设',
      fields: [
        { key: 'title', label: '名字', value: St.presetTitle || '' , placeholder: '给它起个名'},
        { key: 'cat', label: '放到哪个部位', type: 'select', value: defCat,
          options: assets.map(a => [a.id, a.name]).concat([[P().UNSORTED_ID, '未分类']]) }
      ],
      onOk: async vals => {
        const name = String(vals.title || '').trim();
        if (!name) { toast('得先起个名字', 'warn'); return false; }
        const workflow = workflowPresetNow();
        const copy = workflow ? JSON.parse(JSON.stringify(workflow)) : {};
        delete copy.id; delete copy._isFactory;
        const p = P().normalizePreset(Object.assign(copy, {
          title: name, content: St.text, category: vals.cat, _isFactory: false,
          // 千问模式下存的进千问那一套（两套分开）；普通模式下存的进普通那套
          presetSet: window.V7QwenMode && window.V7QwenMode.enabled() ? 'qwen' : undefined,
          refImages:window.V7PresetReferences ? await V7PresetReferences.capture() : [],
          parameters: workflow ? Object.assign({}, persistentWorkflowState(St.workflowParameters), {positivePrompt:St.text}) : undefined
        }));
        saveGuard?.check(true);
        const saved=await P().savePreset(p);
        saveGuard?.check(true);
        const referencesReady=selectReferences(saved),selectedGuard=window.V7PresetReferences?.context();
        await referencesReady;selectedGuard?.check(true);
        S.selAsset = vals.cat === P().UNSORTED_ID ? S.selAsset : vals.cat;
        if(S.toolGroupOpen){S.selAsset = vals.cat;S.toolGroupOpen = false;S.toolGroup = null;applyZoom(true);}
        St.presetId = p.id; St.presetTitle = p.title; S.selPreset = p.id;
        if (workflow) { St.workflowPresetId = String(p.id); notifyWorkflowParameters(p); }
        savePromptState();
        renderCrumb(); fillZone(); updateHeadTitle();
        toast('已保存：' + name, 'ok');
        return true;
      }
    });
  }

  // 导入用页面自己的文件选择框, 不需要壳接口
  // 一批预设条目进预设库 —— 「导入」按钮和社区卡「加到我的预设」共用这一条路（2026-10-20 抽出来，别再各写一份）。
  //   没有能用的条目返回 null。
  async function importItemList(items, pkg) {
    // 千问模式两套分开：在千问模式下导入的进千问那一套（跟「另存为新预设」同一条规矩），不然导完看不见、像没导进去
    const qwenSet = window.V7QwenMode && window.V7QwenMode.enabled();
    const valid = (Array.isArray(items) ? items : []).filter(x => x && typeof x === 'object' && x.title)
      .map(x => qwenSet && !x.presetSet ? Object.assign({}, x, { presetSet: 'qwen' }) : x);
    if (!valid.length) return null;
    const creative = valid.some(p => ['scene-pack', 'hemisynth', 'kao'].includes(p.kind));
    return creative && window.V7CreativePresets
      ? await V7CreativePresets.importPackage({ ...(pkg || {}), format: 'wheelchair-presets', items: valid })
      : await P().importPresets(valid);
  }
  // ⭐ 2026-10-20 社区卡「一键加到我的预设」（community-card.js）：加完把列表 / 底栏条数刷新
  async function importItems(items) {
    const r = await importItemList(items, null);
    if (!r) return { added: 0, skipped: 0, message: '没有能用的预设内容' };
    try { renderCrumb(); fillZone(); } catch (_) { }
    return r;
  }

  function doImport() {
    const importGuard=window.V7PresetReferences?.context();
    pickFiles('.json', async files => {
      importGuard?.check();
      let added = 0, skipped = 0, sil = 0, bad = 0;
      const migrations = [];
      for (const f of files) {
        const text = await f.text();
        importGuard?.check();
        let obj = null;
        try { obj = JSON.parse(text); } catch (_) { bad++; continue; }
        if (obj && obj.schema === 'wheelchair-v7-v6-migration-manifest') {
          migrations.push(obj);
          continue;
        }
        if (obj && obj.schema === 'wheelchair-v7-v6-import-plan') {
          migrations.push(window.V6Migration.manifestFromPlan(obj));
          continue;
        }
        // 剪影素材包
        if (obj && obj.format === 'wheelchair-silhouette') {
          try { const r = await P().importSilhouette(text); sil += r.count; }
          catch (e) { toast('剪影包导入失败：' + e.message, 'err'); }
          continue;
        }
        const items = obj && obj.format === 'wheelchair-presets' && Array.isArray(obj.items)
          ? obj.items : (Array.isArray(obj) ? obj : [obj]);
        importGuard?.check();
        const r = await importItemList(items, obj);
        if (!r) { bad++; continue; }
        added += r.added; skipped += r.skipped;
        importGuard?.check();
      }
      importGuard?.check();
      if (sil) { renderAssets(); renderCrumb(); }
      fillZone();
      const bits = [];
      if (migrations.length) {
        reviewV6Migration({ sourceRoot: migrations.map(item => item.sourceRoot).join('; '), entries: migrations.flatMap(item => item.entries) }, '已选择的 V6 搬家文件');
        bits.push('已打开搬家确认，请选择搬入范围');
      }
      if (added) bits.push('新增 ' + added + ' 条预设');
      if (skipped) bits.push('跳过 ' + skipped + ' 条重复');
      if (sil) bits.push('导入 ' + sil + ' 个剪影素材');
      if (bad) bits.push(bad + ' 个文件读不了');
      toast(bits.length ? bits.join('，') : '文件里没有能用的东西', bad && !added && !sil ? 'err' : 'ok');
    });
  }

  async function doExport() {
    try {
    const list = currentList();
    if (!list.length) { toast('这一组是空的，没东西可导', 'warn'); return; }
    const a = !S.toolGroupOpen && S.selAsset ? P().assetById(S.selAsset) : null;
    const name = (a ? a.name : '全部预设') + '_' + list.length + '条.json';
    const raw=await P().exportPresetsPortable(list);
    await saveText(name,window.V7CreativePresets?await V7CreativePresets.exportPackage(raw):raw);
    } catch(error) { if(window.ERR) ERR.report(error.code||'PRESET_REFERENCE_FAILED',{message:String(error.message||error)});toast('导出失败：'+String(error.message||error),'err'); }
  }

  function editReferenceMapping() {
    const preset=workflowPresetNow();
    if(!preset)throw Object.assign(new Error('请先选择工作流预设'),{code:'WORKFLOW_REFERENCE_MAPPING_REQUIRED'});
    const guard=window.V7PresetReferences?.context(),config=V7Workflows.normalizeConfig(preset.workflow||preset.forgeWorkflow,preset);
    const nodes=Object.entries(config.prompt||{}).filter(([,node])=>node?.inputs&&typeof node.inputs.image==='string');
    if(!nodes.length)throw Object.assign(new Error('工作流没有可配置的图片节点，请先导入 API 格式工作流'),{code:'WORKFLOW_REFERENCE_MAPPING_REQUIRED'});
    const state=V7PresetReferences.state(),refs=state.fixed.concat(state.temporary);
    const options=[['keep','保留工作流原值'],['input','Photoshop 主图'],...refs.map((row,index)=>['ref:'+index,'参考图 '+(index+1)+' · '+row.name])];
    promptDialog({title:'工作流图片节点',fields:nodes.map(([id,node])=>({key:id,label:id+' · '+(node._meta?.title||node.class_type),type:'select',options,
      value:config.inputNodeIds.includes(id)?'input':config.referenceNodeIds.includes(id)?'ref:'+config.referenceNodeIds.indexOf(id):'keep'})),onOk:async values=>{
      guard?.check(true);
      const inputNodeIds=[],referenceNodeIds=Array(refs.length).fill('');
      for(const [id,value]of Object.entries(values)){
        if(value==='input')inputNodeIds.push(id);
        else if(value.startsWith('ref:')){const index=Number(value.slice(4));if(referenceNodeIds[index])throw Object.assign(new Error('同一张参考图只能指定一个图片节点'),{code:'WORKFLOW_REFERENCE_MAPPING_REQUIRED'});referenceNodeIds[index]=id;}
      }
      if(referenceNodeIds.some(id=>!id))throw Object.assign(new Error('请为每张参考图指定图片节点'),{code:'WORKFLOW_REFERENCE_MAPPING_REQUIRED'});
      if(config.inputMode!=='none'&&!inputNodeIds.length)throw Object.assign(new Error('请指定 Photoshop 主图节点'),{code:'WORKFLOW_REFERENCE_MAPPING_REQUIRED'});
      await P().savePreset({...P().presetById(preset.id),inputNodeIds,referenceNodeIds});guard?.check(true);
      toast('图片节点已保存','ok');return true;
    }});
  }

  async function saveText(name, text) {
    const fs = window.uiwin && window.uiwin.presetfs;
    if (fs && fs.saveText) {
      try {
        const r = await fs.saveText(name, text);
        if (r && r.ok) { toast('已导出到：' + (r.path || name), 'ok'); return true; }
        if (r && r.canceled) return false;
        toast('导出失败：' + ((r && r.error) || '未知原因'), 'err');
        return false;
      } catch (e) { toast('导出失败：' + (e && e.message || e), 'err'); return false; }
    }
    toast('当前程序壳没有提供保存文件的能力', 'err');
    return false;
  }

  function pickFiles(accept, cb) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = true;
    inp.style.position = 'fixed';
    inp.style.left = '-9999px';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])];
      inp.remove();
      if (files.length) { try { await cb(files); } catch (e) { toast('处理文件出错：' + (e && e.message || e), 'err'); } }
    });
    inp.click();
  }

  // ═══════════════════════════════════════════════════════════
  //  V6 搬家
  // ═══════════════════════════════════════════════════════════
  function migrationError(error) {
    const code = /ROLLBACK_HAS_NEW_CHANGES/.test(String(error && error.message))
      ? 'PRESET_MIGRATION_ROLLBACK_BLOCKED' : 'PRESET_MIGRATION_FAILED';
    if (window.ERR) window.ERR.report(code, { message: String(error && error.message || error), raw: error && error.stack });
    console.error('[V6 迁移]', error);
  }

  // opts.silent：开软件自动问的那一次 —— 不管点了什么（确定 / 取消 / 失败 / 一条都没新的）都记「问过了」，不再自动弹（反馈 #63）
  function reviewV6Migration(manifest, sourceDescription, opts) {
    opts = opts || {};
    const asked = why => { if (opts.silent && P().markV6Asked) P().markV6Asked(why).catch(() => {}); };
    const migrationGuard=window.V7PresetReferences?.context();
    let preview;
    try { preview = P().planV6Manifest(manifest); }
    catch (error) { asked('plan-failed'); migrationError(error); return; }
    if (opts.silent && !preview.counts.add && !preview.counts.forgeReview) {
      asked('nothing-new');
      toast('V6 的预设都已经在这里了（' + preview.counts.skipped + ' 条已有或读不出来），不用再搬', 'ok');
      return;
    }
    promptDialog({
      onCancel: () => asked('cancel'),
      title: '确认搬入 V6 预设',
      hint: (sourceDescription ? sourceDescription + '\n' : '') +
        '预计新增 ' + preview.counts.add + ' 条，跳过重复或无法读取 ' + preview.counts.skipped + ' 条。' +
        (preview.counts.forgeReview ? '\n其中 Forge ' + preview.counts.forgeReview + ' 条会保留参数并标为“待验证”，验证前不能生成。' : '') +
        '\n点击确定后保存搬家前快照，再导入；V6 原文件不会改变。之后可在列表上方的“搬家报告”查看明细或恢复。',
      fields: [{ key: 'kinds', type: 'select', label: '搬入范围', value: 'all',
        options: [['all', '普通预设和 Forge 待验证预设'], ['prompt', '仅普通预设'], ['forge', '仅 Forge 待验证预设']] }],
      onOk: async values => {
        try {
          migrationGuard?.check();
          const report = await P().importV6Manifest(manifest, {
            confirm: true, includeKinds: values.kinds === 'all' ? ['prompt', 'forge'] : [values.kinds]
          });
          migrationGuard?.check();
          fillZone(); renderCrumb();
          toast('搬完了：新增 ' + report.counts.added + ' 条，跳过 ' + report.counts.skipped + ' 条' +
            (report.counts.forgeReview ? '，待验证 ' + report.counts.forgeReview + ' 条' : ''), 'ok');
          // ⭐ 2026-10-21（docs/261 B1）：读不出来的参考图跳过了，要说出来是哪几条，不能悄悄少图
          const refSkipped = Array.isArray(report.refSkipped) ? report.refSkipped : [];
          if (refSkipped.length && window.UI && UI.notice) {
            UI.notice({ title: '有 ' + report.counts.refSkipped + ' 张参考图没搬过来', level: 'warn',
              body: '这些参考图在 V6 里就是坏的（空的 / 格式不对 / 解不开），已经跳过；预设本身都搬进来了，缺的图可以在预设里重新加。',
              detail: refSkipped.slice(0, 30).map(row => '「' + row.title + '」：' + row.skipped.map(s => s.name + '（' + s.reason + '）').join('、')).join('\n') +
                (refSkipped.length > 30 ? '\n……还有 ' + (refSkipped.length - 30) + ' 条' : ''),
              confirm: '知道了' });
          }
          return true;
          // ⚠ 失败也关框（docs/261 B1）：以前返回 false 让框开着，用户以为没点上，反复点「确定」反复失败（线上 96 次）。
          //   原因进报错卡，想再试从预设卡「从 V6 搬家」重新开。
        } catch (error) { asked('import-failed'); migrationError(error); return true; }
        finally { asked('done'); }
      }
    });
  }

  // ⭐ 2026-10-20（docs/256 F1，学员报「开头四步里装好桥接打开 PS 后卡着不给操作 PS 打开增效工具」）：
  //   第一次用时自动弹「确认搬入 V6 预设」原来不管首次启动四步引导走没走完 —— 框一弹整个软件窗口接管鼠标，
  //   用户正要去 PS 里打开插件面板，点不到。改成：引导开着 / 还没走完就先不弹，等引导关掉（且走完）再问一次。
  //   ⚠ 没走完就一直不自动弹 —— 预设卡上「从 V6 搬家」随时能手动点。
  function scheduleV6MigrationPrompt() {
    const setup = window.V7Setup;
    const busy = () => !!(setup && ((typeof setup.isOpen === 'function' && setup.isOpen()) || (typeof setup.isRequired === 'function' && setup.isRequired())));
    if (!busy()) { setTimeout(() => { migrateFromV6({ silent: true }); }, 1200); return; }
    const onClosed = () => {
      if (busy()) return;
      window.removeEventListener('wheelchair:setup-window-closed', onClosed);
      setTimeout(async () => { try { if (await P().shouldAskV6()) migrateFromV6({ silent: true }); } catch (_) {} }, 1200);
    };
    window.addEventListener('wheelchair:setup-window-closed', onClosed);
  }

  async function migrateFromV6(opts) {
    opts = opts || {};
    try {
      const scan = await P().scanV6();
      if (!scan.ok) { if (!opts.silent) migrationError(new Error(scan.error)); return scan; }
      if (!scan.dirs.length) { if (!opts.silent) askManualPath(); return scan; }
      const description = '扫描 ' + scan.dirs.length + ' 个目录、' + scan.raw + ' 个文件。' +
        (scan.directoryErrors.length ? '\n有 ' + scan.directoryErrors.length + ' 个目录无法读取，请核对后再导入：\n' +
          scan.directoryErrors.map(item => item.path + '：' + item.error).join('\n') : '');
      reviewV6Migration(scan.manifest, description, { silent: !!opts.silent });
      return scan;
    } catch (error) { migrationError(error); }
  }

  function askManualPath() {
    promptDialog({
      title: '选择 V6 预设文件夹',
      hint: '可填写 V6 的 presets 或 forge_presets 文件夹。读取后会先显示搬入范围和数量。',
      fields: [{ key: 'path', label: '文件夹路径', value: '', placeholder: '粘贴文件夹完整路径' }],
      onOk: async vals => {
        const sourcePath = String(vals.path || '').trim().replace(/^["']|["']$/g, '');
        if (!sourcePath) return false;
        try {
          const fs = window.uiwin && window.uiwin.presetfs;
          if (!fs || !fs.scanDir) throw new Error('PRESET_FILE_INTERFACE_UNAVAILABLE');
          const files = (await fs.scanDir(sourcePath)) || [];
          if (!files.length) { toast('这个文件夹里没有 .json 预设文件', 'warn'); return false; }
          reviewV6Migration(window.V6Migration.manifestFromFiles(files, sourcePath), sourcePath);
          return true;
        } catch (error) { migrationError(error); return false; }
      }
    });
  }

  async function showMigrationReport() {
    try {
      const report = await P().v6MigrationReport();
      const rollback = await P().latestV6Migration();
      if (!report) { toast('还没有 V6 搬家记录', 'info'); return; }
      const reasons = { SAME_SOURCE_HASH: '相同来源', SAME_SOURCE_ID: '已经搬过', SAME_CONTENT: '相同内容', NOT_SELECTED: '未选择搬入',
        JSON_PARSE_FAILED: '文件无法读取', UNSUPPORTED_KIND: '不支持的类型', SOURCE_PLAN_SKIPPED: '原计划已跳过' };
      const details = report.records.slice(0, 12).map(item =>
        (item.action === 'add' ? '新增：' + item.title : '跳过：' + item.sourceFile + '（' + (reasons[item.reason] || item.reason) + '）')).join('\n');
      const options = [['export', '保存完整搬家报告']];
      if (rollback && rollback.status === 'applied') options.push(['rollback', '恢复最近一次搬家前的预设']);
      promptDialog({
        title: 'V6 搬家报告',
        hint: '记录时间：' + report.finishedAt + '\n新增 ' + report.counts.added + ' 条，跳过 ' + report.counts.skipped +
          ' 条，Forge 待验证 ' + report.counts.forgeReview + ' 条。\n' +
          (report.status === 'rolled_back' ? '这次搬家已经恢复。\n' : '') + details +
          (report.records.length > 12 ? '\n更多条目可导出完整报告查看。' : ''),
        fields: [{ key: 'action', type: 'select', label: '操作', value: 'export', options }],
        onOk: async values => {
          if (values.action === 'export') return saveText('V6搬家报告_' + report.id + '.json', JSON.stringify(report, null, 2));
          dialog({
            title: '恢复搬家前的预设',
            body: '将恢复到 ' + rollback.startedAt + ' 搬家前的 ' + rollback.snapshotCount +
              ' 条预设，移除该次搬入的 ' + rollback.counts.added + ' 条。若搬家后有任何新增、编辑或删除，会阻止恢复，保护后续修改。',
            confirm: '恢复快照', cancel: '保留当前',
            onConfirm: async () => {
              try {
                await P().rollbackV6Migration(rollback.id, { confirm: true });
                if (S.selPreset && !P().presetById(S.selPreset)) unloadPreset();
                fillZone(); renderCrumb(); toast('已经恢复到搬家前的预设', 'ok');
              } catch (error) { migrationError(error); }
            }
          });
          return true;
        }
      });
    } catch (error) { migrationError(error); }
  }

  // ═══════════════════════════════════════════════════════════
  //  素材编辑器(全屏窗口)
  // ═══════════════════════════════════════════════════════════
  let editorBound = false;      // onSave 只注册一次(理由见 openEditor 里的注释)

  // 把一张图缩到最长边 max，转成 dataURL。只用于【送给编辑器看】，不回写。
  // 缩不动就退回原图 —— 宁可慢一点，也不能因为缩图失败让编辑器空着。
  async function shrinkToDataUrl(blob, max) {
    if (!blob) return '';
    try {
      const url = URL.createObjectURL(blob);
      try {
        const img = await P().loadImage(url);
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        if (!iw || !ih) return await P().blobToDataUrl(blob);
        const k = Math.min(1, max / Math.max(iw, ih));
        if (k >= 1) return await P().blobToDataUrl(blob);      // 本来就小，原样送
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(iw * k));
        cv.height = Math.max(1, Math.round(ih * k));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        return await P().blobToDataUrl(await P().canvasToBlob(cv, 'image/png'));
      } finally { try { URL.revokeObjectURL(url); } catch (_) { } }
    } catch (e) {
      console.warn('[预设] 缩图失败，改送原图', e); if(window.ERR) ERR.report('PRESET_THUMB_FAILED',{message:String(e&&e.message||e)});
      return await P().blobToDataUrl(blob);
    }
  }

  async function openEditor() {
    const ed = window.uiwin && window.uiwin.editor;
    if (!ed || !ed.open) { toast('当前程序壳还没接编辑器窗口', 'err'); return; }
    if (activeEditorContext) {
      const focused = await ed.open({ focusOnly: true });
      if (focused?.existing) return;
    }
    const context = editorStorageContext();
    const editorContext = {
      editorSession: 'silhouette-' + Date.now().toString(36) + '-' + (++editorSessionSerial),
      accountId: context.accountId,
      namespaceId: context.namespaceId,
      sessionVersion: context.sessionVersion,
      accountEpoch: dragStorageEpoch,
      storageEpoch: dragStorageEpoch,
      assetVersion: editorAssetVersion()
    };
    activeEditorContext = editorContext;
    // ⚠ blob 地址跨窗口无效(docs/24 L4 背景图栽过) → 一律转 dataURL 再送。
    // ⚠⚠ 但【必须先降采样】。原尺寸送过去有两个要命的代价:
    //   ① 17 块里最大的 background 是 2000×1773，解码成位图就是 14MB，
    //      编辑器里画布和素材库各挂一份 = 三十多张大图同时解码，几百 MB;
    //   ② dataURL 走 IPC 是 JSON 字符串，几 MB 的串序列化+传输都慢。
    //   编辑器只改【位置/大小/层级/名字/图标】，从来不动像素，所以预览尺寸完全够。
    //   传回时 displayChanged/maskChanged 都是 false，原图一个字节都不会被覆盖。
    const PREVIEW_MAX = 384;
    const hubId = window.V7ToolSilhouettes?.hub?.assetId;
    const assets = [];
    for (const a of P().assets()) {
      if (!editorAssetsCurrent(editorContext)) {
        toast('账号或素材已切换，已取消打开旧的剪影编辑器', 'warn');
        return;
      }
      assets.push({
        id: a.id, name: a.name, icon: a.icon, x: a.x, y: a.y, w: a.w, h: a.h, z: a.z,
        hidden: !!a.hidden,        // ⚠ 漏了这个，编辑器里的隐藏开关就永远是关着的
        display: await shrinkToDataUrl(a.display, PREVIEW_MAX),
        mask: await shrinkToDataUrl(a.mask, PREVIEW_MAX),
        count: (P().countByCategory()[a.id] || 0),
        // 能不能当"把预设挪进来"的目标：工具总入口和工具剪影点开是工具大卡，预设放进去就找不到了
        presetTarget: !(a.id === hubId || isGroupedToolAsset(a))
      });
    }
    // ⭐ 预设管理（2026-10-15）：编辑器那边按组看预设、挪组、改名、复制、删除。
    //   只送"认得出是哪条"的轻量信息（正文只送开头一截给悬停看，不送参考图），
    //   保存时编辑器回一份改动清单，这边 applyPresetEdits 一个事务写完。
    //   updatedAt 原样送过去再带回来：编辑器开着期间这边又改过的那条，保存时认得出来、不覆盖。
    const groupIds = new Set(assets.map(a => a.id));
    // 千问模式两套分开：编辑器里也只管当前这一套
    const presets = P().presets().filter(p => p.category !== '__agent_inbox__' && (!P().visible || P().visible(p))).map(p => ({
      id: p.id, title: p.title, category: groupIds.has(p.category) ? p.category : P().UNSORTED_ID,
      kind: p.kind || 'prompt', starred: !!p.starred, locked: P().presetLocked(p), order: typeof p.order === 'number' ? p.order : null,
      builtin: p.source === 'comfyui-migration', needsReview: !!p.needsReview, updatedAt: p.updatedAt || '',
      preview: (p.kind || 'prompt') === 'prompt' ? String(p.content || '').slice(0, 200) : ''
    }));
    let trash = [];
    try {
      trash = (await P().loadTrash()).map(row => ({ id: row.preset.id, title: row.preset.title,
        fromCategory: row.fromCategory, deletedAt: row.deletedAt,
        preview: (row.preset.kind || 'prompt') === 'prompt' ? String(row.preset.content || '').slice(0, 200) : '' }));
    } catch (e) {
      // 最近删除读不出来不该挡住编辑器：照样打开，那一栏是空的，并上报
      if (e?.code === 'BACKUP_ACCOUNT_CHANGED') { toast('账号或素材已切换，已取消打开旧的剪影编辑器', 'warn'); return; }
      if (window.ERR) ERR.report('PRESET_TRASH_READ_FAILED', { message: String(e && e.message || e) });
    }
    // ⚠ 回调只能注册一次。标记必须放在【我们自己的模块变量】上, 不能写到 ed 上 ——
    //   Electron 的 contextBridge 对象是只读代理, 往上面挂属性会被静默丢弃,
    //   结果就是每开一次编辑器多注册一个监听, 保存一次触发 N 遍。
    if (!editorBound) {
      editorBound = true;
      if (ed.onSave) ed.onSave(payload => applyEditorResult(payload).catch(e => {
        toast('保存素材失败：' + (e && e.message || e), 'err');
        if (e?.code === 'SILHOUETTE_EDITOR_STALE' && window.ERR) ERR.report(e.code, { message: e.message });
        return { ok: false, error: String(e && e.message || e), code: e?.code };
      }));
    }
    // ⚠ aspect 必须一起送: 编辑器那边画布比例跟这边对不上的话,
    //   你在编辑器里摆好的位置回到剪影上就是歪的。
    if (!editorAssetsCurrent(editorContext)) {
      toast('账号或素材已切换，已取消打开旧的剪影编辑器', 'warn');
      return;
    }
    ed.open({ ...editorContext, assets, aspect: P().canvasAspect(), presets, trash, unsortedId: P().UNSORTED_ID });
  }

  // 把编辑器传回的素材写回库。
  // ⚠ 只有【明确标了改过图】的才动像素 —— 编辑器手上是缩过的预览图,
  //   无脑回写会把原图替换成 384px 的小图(而且不可逆)。
  async function writeBackAssets(list, expected) {
    for (const a of list) {
      assertEditorCurrent(expected);
      const old = P().assetById(a.id);
      if (old) {
        // Keep the live asset unchanged until decoding and session checks pass.
        const next = { ...old, name: a.name, icon: a.icon, x: a.x, y: a.y,
          w: a.w, h: a.h, z: a.z, hidden: !!a.hidden };
        const imgChanged = !!(a.displayChanged || a.maskChanged);
        if (a.displayChanged && a.display) { next.display = await P().dataUrlToBlob(a.display); assertEditorCurrent(expected); }
        if (a.maskChanged && a.mask) { next.mask = await P().dataUrlToBlob(a.mask); assertEditorCurrent(expected); }
        await editorAssetWrite(expected, () => { Object.assign(old, next); return P().saveAsset(old); });
        // 换过图 → blob 地址和命中数据全部作废, 必须重建
        if (imgChanged) { await rehydrate(old); assertEditorCurrent(expected); }
      } else {
        await editorAssetWrite(expected, () => P().createAsset(a)); // 新导入素材保持原尺寸
      }
    }
  }

  // 编辑器传回的预设改动（挪组 / 改名 / 复制 / 删除 / 恢复）。
  // ⚠ 必须在素材写完之后做：挪进"刚在编辑器里新建的组"时，那个组要先存在；
  //   被删掉的组下的预设已经被 deleteAsset 转进未分类，挪向它的改动在 store 里也会落到未分类。
  // ⚠ 不能走 editorAssetWrite：那个要求素材版本正好 +1，而改预设根本不动素材。
  async function applyEditorPresetEdits(edits, expected) {
    if (!edits || typeof edits !== 'object') return null;
    const total = ['updates', 'copies', 'deletes', 'restores', 'purges']
      .reduce((n, key) => n + (Array.isArray(edits[key]) ? edits[key].length : 0), 0);
    if (!total) return null;
    assertEditorCurrent(expected);
    const result = await P().applyPresetEdits(edits);
    if (!editorContextCurrent(expected)) {
      throw Object.assign(new Error('账号或素材已切换，已停止剪影写回'), { code: 'SILHOUETTE_EDITOR_STALE' });
    }
    // 提示词框里正开着的那条：被删了就脱钩（正文留着，免得用户打的字跟着没了）；改了名就跟着改
    if (St.presetId && !St.toolId) {
      const live = P().presetById(St.presetId);
      if (!live) { St.presetId = ''; St.presetTitle = ''; if (S.selPreset && !P().presetById(S.selPreset)) S.selPreset = null; savePromptState(); }
      else if (live.title !== St.presetTitle) { St.presetTitle = live.title; savePromptState(); }
    }
    return result;
  }
  function presetEditSummary(r) {
    if (!r) return '';
    const parts = [];
    if (r.moved) parts.push('挪组 ' + r.moved + ' 条');
    if (r.renamed) parts.push('改名 ' + r.renamed + ' 条');
    if (r.copied) parts.push('复制 ' + r.copied + ' 条');
    if (r.deleted) parts.push('删除 ' + r.deleted + ' 条（在「最近删除」里能恢复）');
    if (r.restored) parts.push('恢复 ' + r.restored + ' 条');
    if (r.purged) parts.push('彻底删除 ' + r.purged + ' 条');
    return parts.join('，');
  }
  function warnPresetConflicts(r) {
    if (!r || !r.conflicts || !r.conflicts.length) return;
    const names = r.conflicts.slice(0, 3).map(t => '「' + t + '」').join('、') + (r.conflicts.length > 3 ? ' 等' : '');
    toast(r.conflicts.length + ' 条预设在编辑器开着时被改过，这次没动它们：' + names + '。重新打开编辑器再改一次。', 'warn');
    if (window.ERR) ERR.report('PRESET_EDIT_CONFLICT', { count: r.conflicts.length });
  }

  async function applyEditorResult(payload) {
    if (!payload) return { ok: false, error: '没有收到编辑内容' };

    const expected = activeEditorContext;
    const matches = expected && payload.editorSession === expected.editorSession &&
      String(payload.accountId || '') === expected.accountId &&
      String(payload.namespaceId || '') === expected.namespaceId &&
      (payload.sessionVersion == null ? expected.sessionVersion == null : Number(payload.sessionVersion) === expected.sessionVersion) &&
      Number(payload.accountEpoch) === expected.accountEpoch &&
      payload.assetVersion === expected.assetVersion &&
      editorAssetsCurrent(expected);
    if (!matches) {
      const error = Object.assign(new Error('剪影编辑结果已过期，未写入当前账号'), { code: 'SILHOUETTE_EDITOR_STALE' });
      toast(error.message, 'warn');
      if (window.ERR) ERR.report(error.code, { message: error.message });
      return { ok: false, error: error.message, code: error.code };
    }
    // Two save messages from one window must not interleave asset lists.
    if (expected.saving) return { ok: false, error: '正在保存，请等待完成' };
    expected.saving = true;
    try {

    // ── 恢复内置人体摆位 ──
    // 重新切一次 V6 原图, 把那 17 块按 id 覆盖回去。
    // ⚠ 只覆盖内置的 17 个 id, 用户自己导入的素材(a_xxx)一个不碰; 预设也一条不动
    //   (预设是按 category 认素材 id 的, id 没变就还挂在原处)。
    if (payload.resetBuiltin) {
      let split;
      try { split = await P().splitV6Body(); }
      catch (e) { throw new Error('恢复失败，读不了内置人体图：' + (e && e.message || e)); }
      assertEditorCurrent(expected);
      await P().setCanvasAspect(split.aspect);
      assertEditorCurrent(expected);
      for (const part of split.parts) {
        assertEditorCurrent(expected);
        const old = P().assetById(part.id);
        if (old) {
          // 名字和图标保留用户改过的，只把位置和图恢复
          part.name = old.name; part.icon = old.icon;
        }
        await editorAssetWrite(expected, () => P().createAsset(part));
      }
      assertEditorCurrent(expected);
      renderAssets(); renderCrumb(); fillZone();
      toast('已恢复内置人体的出厂摆位（' + split.parts.length + ' 块）', 'ok');
      return { ok: true };
    }

    if (!Array.isArray(payload.assets)) return { ok: false, error: '编辑内容格式不正确' };

    // ── 整套导出 ──
    // 编辑器手上只有缩过的预览图，导出必须在这边做（原图在 IndexedDB 里）。
    // 先把摆位落库再导，保证导出的位置就是你刚摆的那个。
    if (payload.exportAll) {
      await writeBackAssets(payload.assets, expected);
      assertEditorCurrent(expected);
      const presetResult = await applyEditorPresetEdits(payload.presetEdits, expected);
      renderAssets(); renderCrumb(); fillZone();
      warnPresetConflicts(presetResult);
      const text = await P().exportSilhouette();
      assertEditorCurrent(expected);
      await saveText('剪影素材_' + P().assets().length + '个.json', text);
      return { ok: true };
    }

    const keep = new Set(payload.assets.map(a => a.id));
    // 删掉编辑器里被移除的(预设不删, 转未分类 —— deleteAsset 内部做了)
    let movedTotal = 0;
    for (const a of P().assets().slice()) {
      assertEditorCurrent(expected);
      if (!keep.has(a.id)) { const r = await editorAssetWrite(expected, () => P().deleteAsset(a.id)); movedTotal += r.moved; }
    }
    await writeBackAssets(payload.assets, expected);
    assertEditorCurrent(expected);
    const presetResult = await applyEditorPresetEdits(payload.presetEdits, expected);
    if (S.selAsset && !P().assetById(S.selAsset)) S.selAsset = null;
    renderAssets(); renderCrumb(); fillZone();
    const summary = presetEditSummary(presetResult);
    toast('剪影已更新' + (movedTotal ? '（' + movedTotal + ' 条预设转到未分类）' : '') + (summary ? '；预设：' + summary : ''), 'ok');
    warnPresetConflicts(presetResult);
    return { ok: true };
    } finally { expected.saving = false; }
  }

  async function rehydrate(a) {
    if (a._dispUrl) { try { URL.revokeObjectURL(a._dispUrl); } catch (_) { } }
    if (a._maskUrl) { try { URL.revokeObjectURL(a._maskUrl); } catch (_) { } }
    a._dispUrl = a.display ? URL.createObjectURL(a.display) : '';
    a._maskUrl = a.mask ? URL.createObjectURL(a.mask) : '';
    if (a._maskUrl) {
      try { a._hit = P().buildHitData(await P().loadImage(a._maskUrl)); } catch (_) { a._hit = null; }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  小对话框(自己画一个, 不占用报错堆)
  // ═══════════════════════════════════════════════════════════
  function dialog(o) {
    if (S.host && S.host.dialog) { S.host.dialog(o); return; }
    if (confirm(o.title + '\n' + (o.body || ''))) { o.onConfirm && o.onConfirm(); }
    else o.onCancel && o.onCancel();
  }

  function promptDialog(o) {
    const ov = document.createElement('div');
    ov.className = 'ps-dlg-ov';
    const box = document.createElement('div');
    box.className = 'ps-dlg';
    let html = '<div class="ps-dlg-title">' + esc(o.title) + '</div>';
    if (o.hint) html += '<div class="ps-dlg-hint">' + esc(o.hint) + '</div>';
    o.fields.forEach(f => {
      html += '<div class="ps-dlg-row"><div class="ps-dlg-label">' + esc(f.label) + '</div>';
      if (f.type === 'select') {
        html += '<select class="ps-dlg-input" data-k="' + esc(f.key) + '">' +
          f.options.map(op => '<option value="' + esc(op[0]) + '"' + (op[0] === f.value ? ' selected' : '') + '>' + esc(op[1]) + '</option>').join('') +
          '</select>';
      } else {
        html += '<input class="ps-dlg-input" type="text" data-k="' + esc(f.key) + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '">';
      }
      html += '</div>';
    });
    html += '<div class="ps-dlg-btns"><button class="ps-dlg-btn" data-x="c">取消</button>' +
      '<button class="ps-dlg-btn ps-dlg-ok" data-x="o">确定</button></div>';
    box.innerHTML = html;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const first = box.querySelector('.ps-dlg-input');
    if (first) setTimeout(() => { try { first.focus(); first.select && first.select(); } catch (_) { } }, 30);
    const close = () => ov.remove();
    // 取消（点取消 / 点外面 / Esc）时通知调用方（10-25：V6 搬家要记「问过了」）
    const cancel = () => { close(); if (typeof o.onCancel === 'function') { try { o.onCancel(); } catch (_) { } } };
    ov.addEventListener('click', e => { if (e.target === ov) cancel(); });
    box.addEventListener('keydown', e => { if (e.key === 'Escape') { if (window.UISelect && UISelect.isOpen()) return; e.stopPropagation(); cancel(); } });
    box.querySelector('[data-x="c"]').addEventListener('click', cancel);
    box.querySelector('[data-x="o"]').addEventListener('click', async event => {
      const button=event.currentTarget;if(button.disabled)return;button.disabled=true;
      const vals = {};
      box.querySelectorAll('[data-k]').forEach(el => { vals[el.dataset.k] = el.value; });
      try{const r=await o.onOk(vals);if(r!==false)close();}
      catch(error){if(window.ERR)ERR.report(error.code||'PRESET_SAVE_FAILED',{message:String(error.message||error)});toast(String(error.message||error),'err');}
      finally{button.disabled=false;}
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  对外
  // ═══════════════════════════════════════════════════════════
  // ⭐ 2026-10-17 夜（用户：「正常返回的图明显感觉我提示词没有生效」）：
  //   提示词框从存档恢复（启动 / 换账号 / 登录恢复）以后，必须把【框里显示的】同步给生成那边。
  //   以前只有「编辑 / 选预设」才同步（savePromptState），恢复时不同步 ⇒ 框里显示面部血统，
  //   生成那边还是启动时从「未登录占位」存档读出来的去杂物提示词，发出去的就是它（缓存 prompt.txt 实测抓到）。
  //   ⚠ 看到什么就发什么：框是空的就同步成空（生成会提示先填提示词），不拿别处藏着的旧词顶上。
  function syncPromptToHost() {
    if (S.host && S.host.onPromptChange) {
      try { S.host.onPromptChange(St.text, St.presetTitle); } catch (e) { console.warn('[预设] 同步提示词给生成侧失败', e); if (window.ERR) ERR.report('PRESET_PROMPT_SYNC_FAILED', { message: String(e && e.message || e) }); }
    }
  }
  async function init(host) {
    S.host = host || {};
    S.cardEl = host.cardEl;
    S.zoneEl = host.zoneEl;
    loadPromptState();
    syncPromptToHost();
    let info = null;
    try { info = await P().init(); }
    catch (e) {
      // ⭐ 2026-10-20（docs/256 F2b，学员报开机弹「预设数据没加载起来：账号已切换，预设操作已停止」）：
      //   开软件自动登录会换一次账号，预设库就把这次启动叫停（抛 BACKUP_ACCOUNT_CHANGED）—— 这是正常的：
      //   换账号时 rebindStorage() 会给新账号重新加载一遍。原来照样报「预设系统启动失败」+ 弹红条，是假报错。
      if (e && e.code === 'BACKUP_ACCOUNT_CHANGED') { console.info('[预设] 这次启动被换账号打断，新账号会重新加载：' + (e.message || '')); return null; }
      console.error('[预设] 数据层启动失败', e); if(window.ERR) ERR.report('PRESET_BOOT_FAILED',{message:String(e&&e.message||e),raw:e&&e.stack});
      toast('预设系统启动失败：' + (e && e.message || e), 'err');
      return null;
    }
    if (P().mem.lastError) console.warn('[预设] ' + P().mem.lastError);
    restoreWorkflowState();
    const referencesReady=selectReferences(St.toolId ? null : P().presetById(St.presetId)),selectedGuard=window.V7PresetReferences?.context();
    try{await referencesReady;selectedGuard?.check(true);}catch(_){return null;}
    buildCard();
    fillZone();
    // 第一次用 → 问要不要把 V6 的预设搬过来
    if (await P().shouldAskV6()) scheduleV6MigrationPrompt();
    console.log('[预设] 就绪：' + info.assets + ' 个素材 / ' + info.presets + ' 条预设');
    return info;
  }

  async function rebindStorage() {
    dragStorageEpoch++;
    S.selAsset = null; S.selPreset = null; S.toolGroupOpen = false; S.toolGroup = null;
    S.hoverAsset = null; S.filter = ''; S.searchOpen = false; S.promptHist = { zone: false, detail: false }; S.recentQuery = '';
    selectReferences(null);
    const referenceGuard=window.V7PresetReferences?.context();
    // A login/logout changes the persistence scope while the window stays open.
    // Drop the old prompt state before loading the new account's copy.
    St.text = ''; St.presetId = ''; St.presetTitle = '';
    St.originTitle = ''; St.originEdited = false; St.toolId = '';
    St.workflowParameters = {}; St.workflowPresetId = '';
    S.selPreset = null;
    S.host?.refreshDetailBackground?.();
    if (P().rebindStorage) P().rebindStorage();
    loadPromptState();
    syncPromptToHost();   // 新账号的提示词框内容同步给生成（同步做，赶在任何生成之前）
    try { await P().init(); referenceGuard?.check(true); } catch (_) { return; }
    const referencesReady=selectReferences(St.toolId ? null : P().presetById(St.presetId)),selectedGuard=window.V7PresetReferences?.context();
    try{await referencesReady;selectedGuard?.check(true);}catch(_){return;}
    buildCard();
    fillZone();
    restoreWorkflowState();
    S.host?.refreshDetailBackground?.();
  }

  window.PRESETUI = {
    init, rebindStorage,
    captureFieldHistory, recordFieldHistory,
    refreshToolParams(id) {
      if(St.toolId!==id) return;
      const p=P().presetById(id),saved=promptTarget;
      if(!p) return;
      try {
        ['zone','detail'].forEach(target=>{
          promptTarget=target;
          const body=promptBodyEl();
          if(body&&body.isConnected&&body.dataset.toolPreset===id)fillToolDetail(body,p);
        });
      } finally { promptTarget=saved; }
    },
    buildCard, renderAssets, renderCrumb,
    fillZone, refreshListOnly, fillDetail: fillDetailCard, fillPromptZone, measureList,
    selectAsset, loadPresetById,
    // 打开工具（工具列表点一行 / 剪影上点钉出来的工具 都走它）。参数：tool-silhouettes 的 definition 行或 key
    launchTool: row => launchTool(typeof row === 'string' ? window.V7ToolSilhouettes?.get?.(row) : row),
    migrateFromV6, askManualPath, openEditor,
    saveCurrentAsPreset, doImport, doExport, editReferenceMapping,
    state: S, prompt: St,
    getText: () => St.text,
    importItems,
    setPromptText(text) {
      if (St.toolId) throw new Error('当前选中了工具预设，请先选择一个生图预设再复用提示词');
      St.text = String(text || '');
      St.originEdited = !!St.originTitle;
      savePromptState(); refreshAllPromptViews();
    },
    getPresetTitle: () => St.presetTitle,
    // ⭐⭐ 生成侧【提交时现取】用的就是这个（2026-09-13 用户定案·照 V6 的做法）。
    //
    // ⚠ 为什么不是"预设一变就推给生成侧"：推的路径只要漏掉一条就静默失效，
    //   而且已经栽过两次 —— ① onPromptChange 的第二个参数被丢了（任务卡从不知道预设名）
    //   ② 重启后 loadPromptState 恢复了状态却没推，于是"提示词还在、预设名没了"。
    //   V6 的架构是各处提交时 state.get('prompt.lastPresetTitle') 现取，
    //   现取没有"漏推"这种失败模式 —— 这一条是本项目的通用教训，见 docs/12 坑35。
    //
    // 返回 {title, edited}：title 是来源预设名（没有就是空串），edited 表示手改过。
    getPresetOrigin: () => ({ title: String(St.originTitle || ''), edited: !!St.originEdited }),
    // ⭐⭐ 当前选中的是不是【工具类预设】（抠像…）。生成侧的"开始计算"读它来分流：
    //   返回非 null → 跑这条工具；返回 null → 照旧跑生成。
    //   ⚠ 同样是【现取】：返回的是库里那条活的预设，参数一定是最新的。
    getToolPreset: () => toolPresetNow(),
    canOpenToolPreset: preset => !!window.V7ToolSilhouettes?.getPreset(preset),
    openToolPreset,
    // 工具类预设的参数（已经补好默认值）。⚠ 返回副本，调用方随便改不会污染库里那条。
    getToolParams: () => {
      const p = toolPresetNow();
      if (!p) return null;
      return Object.assign(toolDefaultsOf(toolKindOf(p)), P().presetParams(p));
    },
    // 提示词正文。生成侧用它比对"是不是被别处改过"（防幽灵预设名，见 ui.html presetTitleNow）
    getPromptText: () => String(St.text || ''),
    setWorkflowParameters(values, options) {
      const p = workflowPresetNow();
      if (!p) return false;
      const targetId = String(options && options.presetId || (p && p.id) || '');
      if (targetId && p && targetId !== String(p.id)) return false;
      const allowed = new Set(workflowBindingsOf(p).map(binding => String(binding.key)));
      const next = {};
      Object.keys(values || {}).forEach(key => { if (!allowed || allowed.has(String(key))) next[key] = values[key]; });
      St.workflowParameters = Object.assign({}, St.workflowParameters || {}, next);
      St.workflowPresetId = targetId || St.workflowPresetId;
      savePromptState();
      notifyWorkflowParameters(p);
      if (!options || options.refresh !== false) refreshAllPromptViews();
      return true;
    },
    getWorkflowParameters: () => JSON.parse(JSON.stringify(St.workflowParameters || {}))
  };
})();

