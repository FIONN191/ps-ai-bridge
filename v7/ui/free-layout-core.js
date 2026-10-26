(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7FreeLayoutCore = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const SCHEMA = 'wheelchair-free-layout';
  const VERSION = 2;
  const META_KEY = 'free-mode.v1';
  // ⚠ 2026-10-14：'tutorial' 从这份名单里删掉了 ——「使用教程」卡整张已删（用户定：教程要重做）。
  //   留着会怎样：自由模式的布局存档里可能还记着 tutorial 那张卡，
  //   而界面上已经没有它了 ⇒ 校验/摆放会按一个不存在的卡算。
  //   重做教程卡时把 'tutorial' 加回这一行末尾（清单见 docs/217）。
  const CARD_IDS = Object.freeze([
    'generation', 'presets', 'settings', 'engines', 'history',
    'projects', 'assistant', 'debug',
    // ⭐ 2026-10-18 深夜：问题反馈卡。老存档里没有它 → free-mode-ui.js 的 load() 按默认布局补上
    'feedback',
    // ⭐ 2026-10-20：社区卡（第 10 张）。老存档里没有它 → 同上按默认布局补上
    'community'
  ]);
  const SPECIAL_UNIT_IDS = Object.freeze({ tasks: 'tasks', errors: 'errors' });
  // This limits the visible staircase only; every member remains in the group.
  const MAX_VISIBLE_PILE_CARDS = 4;
  const MAX_COORDINATE = 100000;
  const MAX_DIMENSION = 10000;
  const fail = message => { throw new Error(message); };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const validCardId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
  const cardUnitId = cardId => {
    if (!validCardId(cardId)) fail('无法识别的主卡编号');
    return 'card:' + cardId;
  };

  function unitIds(cardIds) {
    const cards = Array.isArray(cardIds) ? cardIds : CARD_IDS;
    return [
      ...cards.map(cardUnitId),
      SPECIAL_UNIT_IDS.tasks,
      SPECIAL_UNIT_IDS.errors
    ];
  }

  function assertRect(row) {
    for (const key of ['x', 'y', 'width', 'height', 'z']) {
      if (!finite(row[key])) fail('自由布局坐标、尺寸或层级无效');
    }
    if (Math.abs(row.x) > MAX_COORDINATE || Math.abs(row.y) > MAX_COORDINATE ||
        row.width <= 0 || row.width > MAX_DIMENSION || row.height <= 0 || row.height > MAX_DIMENSION ||
        !Number.isInteger(row.z) || row.z < 0 || row.z > 1000000) {
      fail('自由布局位置或尺寸超出范围');
    }
  }

  function normalize(input) {
    if (!input || input.schema !== SCHEMA || ![1, VERSION].includes(input.version) || !Array.isArray(input.units)) {
      fail('自由布局数据格式或版本无效');
    }
    const expected = new Set();
    const seen = new Set();
    const rows = input.units.map(row => {
      if (!row || typeof row.id !== 'string' || seen.has(row.id)) {
        fail('自由布局单元编号无效或重复');
      }
      seen.add(row.id);
      const cardId = row.id.startsWith('card:') ? row.id.slice(5) : null;
      if (cardId && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(cardId)) fail('自由布局单元编号无效或重复');
      if (cardId && expected.has(row.id)) fail('自由布局单元编号无效或重复');
      const expectedKind = cardId ? 'card' : row.id;
      if (row.kind !== expectedKind || (cardId && row.cardId !== cardId)) fail('自由布局单元类型与编号不匹配');
      if (cardId) expected.add(row.id);
      else if (row.id === SPECIAL_UNIT_IDS.tasks || row.id === SPECIAL_UNIT_IDS.errors) expected.add(row.id);
      else fail('自由布局单元编号无效或重复');
      assertRect(row);
      if (cardId && row.groupId != null && (typeof row.groupId !== 'string' || !/^[a-z0-9][a-z0-9:._-]{0,159}$/i.test(row.groupId))) fail('自由布局卡组编号无效');
      return {
        id: row.id,
        kind: row.kind,
        ...(cardId ? { cardId, groupId: row.groupId || row.id } : {}),
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        z: row.z
      };
    });
    if (!rows.some(row => row.kind === 'card') ||
        !seen.has(SPECIAL_UNIT_IDS.tasks) || !seen.has(SPECIAL_UNIT_IDS.errors)) {
      fail('自由布局缺少卡片或堆的位置单元');
    }
    // Sort ties by identifier so restores are deterministic even when cards are added later.
    rows.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
    rows.forEach((row, z) => { row.z = z; });
    if (input.version === 1) {
      // Geometry is used only for old saves. Version 2 membership survives overlap and folding.
      const remaining = new Set(rows.filter(row => row.kind === 'card').map(row => row.id));
      for (const first of rows.filter(row => row.kind === 'card')) {
        if (!remaining.has(first.id)) continue;
        const members = [first];remaining.delete(first.id);
        for (let index = 0; index < members.length; index++) {
          for (const row of rows) if (remaining.has(row.id) && Math.abs(row.x - first.x) <= 12 && row.y < members[index].y + members[index].height && members[index].y < row.y + row.height) {
            members.push(row);remaining.delete(row.id);
          }
        }
        const groupId = members.length > 1 ? 'pile:' + members.map(row => row.id).sort()[0] : first.id;
        members.forEach(row => { row.groupId = groupId; });
      }
    }
    return { schema: SCHEMA, version: VERSION, units: rows };
  }

  function createDefault(options) {
    const opts = options || {};
    const card = opts.card || {};
    const stack = opts.stack || {};
    const tasks = opts.tasks || {};
    const errors = opts.errors || {};
    const width = card.width == null ? 420 : card.width;
    const height = card.height == null ? 520 : card.height;
    const stackWidth = stack.width == null ? 360 : stack.width;
    const stackHeight = stack.height == null ? 420 : stack.height;
    const offset = opts.stackOffset == null ? 30 : opts.stackOffset;
    const startX = opts.startX == null ? 24 : opts.startX;
    const startY = opts.startY == null ? 24 : opts.startY;
    const cardIds = Array.isArray(opts.cardIds) ? opts.cardIds : CARD_IDS;
    const units = cardIds.map((cardId, index) => ({
      id: cardUnitId(cardId), kind: 'card', cardId,
      x: startX + index * offset, y: startY + index * offset,
      width, height, z: index
    }));
    units.push(
      { id: SPECIAL_UNIT_IDS.tasks, kind: 'tasks', x: startX + 9 * offset, y: startY, width: tasks.width == null ? stack.width == null ? 300 : stackWidth : tasks.width, height: tasks.height == null ? stack.height == null ? 150 : stackHeight : tasks.height, z: 9 },
      { id: SPECIAL_UNIT_IDS.errors, kind: 'errors', x: startX + 9 * offset, y: startY + offset, width: errors.width == null ? stack.width == null ? 300 : stackWidth : errors.width, height: errors.height == null ? stack.height == null ? 100 : stackHeight : errors.height, z: 10 }
    );
    return normalize({ schema: SCHEMA, version: VERSION, units });
  }

  function clampRect(rect, viewport) {
    if (!rect || !viewport) fail('位置夹取需要单元与可视区');
    const { x: vx = 0, y: vy = 0, width: vw, height: vh } = viewport;
    if (![vx, vy, vw, vh].every(finite) || vw <= 0 || vh <= 0) fail('可视区尺寸无效');
    const width = rect.width, height = rect.height;
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0) fail('卡片尺寸无效');
    // When a unit is larger than the viewport, pin its top-left so its origin and title area remain reachable.
    const maxX = Math.max(vx, vx + vw - width);
    const maxY = Math.max(vy, vy + vh - height);
    return {
      ...rect,
      x: Math.min(maxX, Math.max(vx, finite(rect.x) ? rect.x : vx)),
      y: Math.min(maxY, Math.max(vy, finite(rect.y) ? rect.y : vy))
    };
  }

  // ⭐ 2026-10-20 多屏：给了 viewports（每块屏一个可放区域）就按「这一块跟哪块屏重叠最多」夹到那块屏里，
  //   整块掉在屏和屏之间的空当（外包矩形里没有显示器的地方）⇒ 去离它中心最近的那块屏。没给 viewports 就照旧用 fallback。
  function pickViewport(rect, viewports, fallback) {
    if (!Array.isArray(viewports) || !viewports.length) return fallback;
    let best = null, bestArea = 0;
    for (const vp of viewports) {
      const w = Math.min(rect.x + rect.width, vp.x + vp.width) - Math.max(rect.x, vp.x);
      const h = Math.min(rect.y + rect.height, vp.y + vp.height) - Math.max(rect.y, vp.y);
      const area = w > 0 && h > 0 ? w * h : 0;
      if (area > bestArea) { bestArea = area; best = vp; }
    }
    if (best) return best;
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    let nearest = Infinity;
    for (const vp of viewports) {
      const dx = Math.max(vp.x - cx, 0, cx - (vp.x + vp.width)), dy = Math.max(vp.y - cy, 0, cy - (vp.y + vp.height));
      if (dx * dx + dy * dy < nearest) { nearest = dx * dx + dy * dy; best = vp; }
    }
    return best || fallback;
  }

  function clampLayout(layout, viewport, foldedHeights = {}, viewports = null) {
    const normalized = normalize(layout);
    const seen = new Set();
    for (const row of normalized.units) {
      if (row.kind !== 'card') { Object.assign(row, clampRect(row, pickViewport(row, viewports, viewport))); continue; }
      if (seen.has(row.groupId)) continue;
      seen.add(row.groupId);
      const members = normalized.units.filter(item => item.groupId === row.groupId).sort((a,b) => b.z-a.z);
      const height = Math.max(...members.map(item => item.height)), width = Math.max(...members.map(item => item.width));
      const x0 = Math.min(...members.map(item=>item.x)), y0 = Math.min(...members.map(item=>item.y));
      const vp = pickViewport({ x: x0, y: y0, width, height: foldedHeights[row.groupId] || height }, viewports, viewport);
      const visibleSteps = Math.min(members.length, MAX_VISIBLE_PILE_CARDS) - 1;
      const step = visibleSteps > 0 ? Math.max(0, Math.min(34, (vp.height-height)/visibleSteps)) : 0;
      const visualHeight = foldedHeights[row.groupId] || height+step*visibleSteps;
      const origin = clampRect({x:x0, y:y0, width, height:visualHeight},vp);
      // ⭐ 2026-10-22 修（用户：「折叠卡片会让别的位置锚定的卡片被动一下」）：这里原来是
      //     members.forEach((item,index)=>{ item.x=origin.x; item.y=origin.y+step*Math.min(index,3); });
      //   它对【每一个组】无条件重发坐标，而且成员的先后看【z 序】。两个后果：
      //     ① z 序会因点了某张卡而变（selectCard → raise → reorder），组内每个成员就被换到另一个 y 上
      //        ⇒ 表现为「我没碰它，它却跳了一格 34px」。而 clampLayout 被折叠 / resize / 拖拽合并 /
      //        从卡组释放 / moveUnit 等 8 处调用 ⇒ 任何一次交互都可能让它发作。
      //     ② 就算这一组本来就在可视区内、跨度也合法（完全不用夹），也照样把坐标重写一遍。
      //   现在两条门槛：
      //     · 只有【真的要动】才动 —— 这一组被夹进了（dx/dy 非 0），或者摞比允许的跨度更高、必须压缩；
      //       否则一个坐标都不碰（这才是「夹取」，不是「重新排版」）。
      //     · 真要重排时按【成员自己的 y】排，不再看 z —— 点卡改 z 也不会让整摞轮转。
      //     · 压缩阶梯照旧（工作区太矮时压缩到放得下，超出 4 层的埋在第 4 层）——
      //       tests/free-layout-core.test.js:145「compresses only the visible steps」靠的就是这个。
      const dx = origin.x - x0, dy = origin.y - y0;
      const spanY = Math.max(...members.map(item => item.y)) - y0;
      const allowedSpan = step * visibleSteps;
      if (dx || dy || spanY > allowedSpan) {
        members.slice().sort((a, b) => a.y - b.y).forEach((item, index) => {
          item.x = origin.x;
          item.y = origin.y + step * Math.min(index, MAX_VISIBLE_PILE_CARDS - 1);
        });
      }
    }
    return normalized;
  }

  function reorder(layout, orderedIds) {
    const normalized = normalize(layout);
    const expected = new Set(normalized.units.map(row => row.id));
    if (!Array.isArray(orderedIds) || orderedIds.length !== expected.size ||
        new Set(orderedIds).size !== expected.size || orderedIds.some(id => !expected.has(id))) {
      fail('自由布局层级顺序必须包含全部单元且不能重复');
    }
    const byId = new Map(normalized.units.map(row => [row.id, row]));
    return normalize({ ...normalized, units: orderedIds.map((id, z) => ({ ...byId.get(id), z })) });
  }

  function raise(layout, id) {
    const normalized = normalize(layout);
    if (!normalized.units.some(row => row.id === id)) fail('无法提升不存在的自由布局单元');
    return reorder(normalized, [...normalized.units.filter(row => row.id !== id).map(row => row.id), id]);
  }

  function pileIds(layout, id) {
    const first = layout.units.find(row => row.id === id);
    if (!first || first.kind !== 'card') return [];
    return layout.units.filter(row => row.kind === 'card' && (row.groupId || row.id) === (first.groupId || first.id)).sort((a, b) => b.z - a.z).map(row => row.id);
  }

  function arrangePile(layout, orderedIds, anchor, viewport) {
    const next = normalize(layout), members = new Set(orderedIds);
    if (!orderedIds.length || members.size !== orderedIds.length || orderedIds.some(id => !next.units.some(row => row.id === id && row.kind === 'card'))) fail('主卡堆成员无效');
    const height = Math.max(...next.units.filter(row => members.has(row.id)).map(row => row.height));
    const groupId = orderedIds.length > 1 ? 'pile:' + orderedIds.slice().sort()[0] : orderedIds[0];
    const visibleSteps = Math.min(orderedIds.length, MAX_VISIBLE_PILE_CARDS) - 1;
    const step = viewport && visibleSteps > 0 ? Math.max(0, Math.min(34, (viewport.height - height) / visibleSteps)) : 34;
    const origin = viewport ? clampRect({ ...anchor, width: 300, height: height + step * visibleSteps }, viewport) : anchor;
    for (const row of next.units) {
      const index = orderedIds.indexOf(row.id);
      if (index >= 0) { row.x = origin.x; row.y = origin.y + step * Math.min(index, MAX_VISIBLE_PILE_CARDS - 1); row.groupId = groupId; }
    }
    return reorder(next, [...next.units.filter(row => !members.has(row.id)).map(row => row.id), ...orderedIds.slice().reverse()]);
  }

  function snapCandidate(layout, movingId, point, excludedIds = []) {
    const excluded = new Set([movingId, ...excludedIds]);
    let best = null;
    for (const row of layout.units) {
      if (row.kind !== 'card' || excluded.has(row.id)) continue;
      const dx = Math.abs(point.x - row.x), dy = Math.abs(point.y - row.y);
      if (dx > 36 || dy > 80) continue;
      const distance = dx * 2 + dy;
      if (!best || distance < best.distance || (distance === best.distance && row.z > best.z)) best = { id: row.id, x: row.x, y: row.y, distance, z: row.z };
    }
    return best;
  }

  // ⭐ 2026-10-22（用户：「上下放置会吸到一起去，竖向对齐或者横向对齐」）：对齐吸附。
  //   拖着的那块（rect）跟别的卡（others：{x,y,width,height}）比边：
  //   竖向 = 左边对左边 / 右边对右边 / 隔 gap 贴在左右；横向 = 顶对顶 / 底对底 / 隔 gap 贴在上下。
  //   每个方向只吸最近的一条，在 threshold 像素内才吸；返回吸完的 x/y 和要画的辅助线。
  //   ⚠ 跟「拖到另一张卡上合成一叠」(snapCandidate) 不抢：那个命中时调用方不调这里。
  function alignSnap(rect, others, opts = {}) {
    const gap = opts.gap == null ? 16 : opts.gap, threshold = opts.threshold == null ? 10 : opts.threshold;
    let bx = null, by = null;
    for (const o of others || []) {
      if (![o.x, o.y, o.width, o.height].every(finite)) continue;
      // 只在另一个方向上【挨得够近】时才吸（隔半屏远的卡不该把你拽过去）
      const nearY = rect.y < o.y + o.height + gap * 4 && o.y < rect.y + rect.height + gap * 4;
      const nearX = rect.x < o.x + o.width + gap * 4 && o.x < rect.x + rect.width + gap * 4;
      if (nearY || nearX) {
        for (const [want, line] of [[o.x, o.x], [o.x + o.width - rect.width, o.x + o.width], [o.x + o.width + gap, null], [o.x - gap - rect.width, null]]) {
          const d = Math.abs(rect.x - want);
          if (d <= threshold && (!bx || d < bx.d)) bx = { d, x: want, line: line == null ? null : { x: line, y1: Math.min(o.y, rect.y), y2: Math.max(o.y + o.height, rect.y + rect.height) } };
        }
        for (const [want, line] of [[o.y, o.y], [o.y + o.height - rect.height, o.y + o.height], [o.y + o.height + gap, null], [o.y - gap - rect.height, null]]) {
          const d = Math.abs(rect.y - want);
          if (d <= threshold && (!by || d < by.d)) by = { d, y: want, line: line == null ? null : { y: line, x1: Math.min(o.x, rect.x), x2: Math.max(o.x + o.width, rect.x + rect.width) } };
        }
      }
    }
    return { x: bx ? bx.x : rect.x, y: by ? by.y : rect.y, snappedX: !!bx, snappedY: !!by, guides: [bx && bx.line, by && by.line].filter(Boolean) };
  }

  function storageDescriptor(storage) {
    if (!storage || typeof storage.namespaceId !== 'function' || typeof storage.dbName !== 'function') {
      fail('缺少账号隔离存储接口');
    }
    const namespaceId = String(storage.namespaceId());
    const databaseName = String(storage.dbName('presets'));
    if (!namespaceId || !databaseName) fail('账号隔离存储上下文无效');
    return { namespaceId, databaseName, recordKey: META_KEY };
  }

  return Object.freeze({
    SCHEMA, VERSION, META_KEY, CARD_IDS, SPECIAL_UNIT_IDS, MAX_VISIBLE_PILE_CARDS,
    cardUnitId, unitIds, createDefault, normalize, clampRect, clampLayout, pickViewport, alignSnap,
    reorder, raise, pileIds, arrangePile, snapCandidate, storageDescriptor
  });
});
