/* Small offline knowledge base for the in-app assistant.
 * It is deliberately curated and read-only. User chat history, PSD data,
 * cache files, images and API keys never enter this store.
 */
'use strict';

const ENTRIES = Object.freeze([
  { id: 'portrait.tone', topic: '人像评判', title: '影调', body: '检查高光是否有层次、阴影是否堵死、主体与背景是否分离；先描述证据，再给出可执行调整建议。', tags: ['影调', '曝光', '层次'] },
  { id: 'portrait.color', topic: '人像评判', title: '颜色', body: '检查肤色是否偏色、主体和背景色是否冲突、局部色彩是否跳出整体；建议说明色相、饱和度和明度方向。', tags: ['颜色', '肤色', '色差'] },
  { id: 'portrait.shadow', topic: '人像评判', title: '投影', body: '检查投影方向、软硬度、密度和接触关系是否符合光源；不确定时说明需要用户确认的光源信息。', tags: ['投影', '光线'] },
  { id: 'portrait.texture', topic: '人像评判', title: '质感', body: '检查皮肤、衣物和头发的纹理是否自然，避免过度磨皮、塑料感和锐化边缘。', tags: ['质感', '皮肤', '纹理'] },
  { id: 'portrait.expression', topic: '人像评判', title: '表情与眼神', body: '检查表情是否统一、眼神是否有焦点、左右眼高光与方向是否合理；建议优先保留身份特征。', tags: ['表情', '眼神'] },
  { id: 'portrait.hair', topic: '人像评判', title: '毛发', body: '检查发丝边缘、飞丝和遮挡关系，修复时避免把背景或衣物误判为头发。', tags: ['毛发', '边缘'] },
  { id: 'portrait.motion', topic: '人像评判', title: '动态', body: '检查姿态、衣物褶皱和运动方向是否一致；生成修改应保持原构图和主体结构。', tags: ['动态', '姿态', '构图'] },
  { id: 'workflow.billing', topic: '任务与费用', title: '平台算力', body: '平台算力需要登录并先扣积分；任务提交前显示预估费用、预计时间、预设、部位和次数。第三方自有 API 独立配置。', tags: ['积分', '费用', '登录'] },
  { id: 'workflow.agent', topic: 'Agent 安全', title: '修改边界', body: 'Agent 修改软件前必须备份，完成后展示差异和恢复入口；默认拒绝缓存、PSD、用户图片、API Key 和其他应用目录。', tags: ['Agent', '备份', '回滚'] },
  { id: 'workflow.checkpoint', topic: '检查点', title: '五分钟检查点', body: '用户开启后，满足五分钟间隔的下一次生成前保存当前画布无压缩单图 PNG；不保存图层，也不把检查点混入生成链路。', tags: ['检查点', 'PNG', '画布'] }
]);

function normalize(value) { return String(value || '').trim().toLowerCase(); }
// Portrait entries are development examples, not the owner's unpublished curriculum.
// Production readers must not silently use them as the owner's scoring standard.
function permitted(entry, options = {}) {
  if (!entry.id.startsWith('portrait.')) return true;
  return options.includeDrafts === true && Array.isArray(options.entitlements) && options.entitlements.includes('knowledge.student');
}
function copy(entry) {
  return { ...entry, tags: entry.tags.slice(), audience: entry.id.startsWith('portrait.') ? 'student' : 'public',
    status: entry.id.startsWith('portrait.') ? 'draft' : 'published',
    source: entry.id.startsWith('portrait.') ? 'development-example' : 'software-manual' };
}
function search(query, options = {}) {
  const q = normalize(query);
  const topic = normalize(options.topic);
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  return ENTRIES.filter(entry => {
    if (!permitted(entry, options)) return false;
    if (topic && normalize(entry.topic) !== topic) return false;
    if (!q) return true;
    return [entry.title, entry.topic, entry.body].concat(entry.tags).some(value => normalize(value).includes(q));
  }).slice(0, limit).map(copy);
}
function get(id, options = {}) { const entry = ENTRIES.find(item => item.id === String(id)); return entry && permitted(entry, options) ? copy(entry) : null; }
function listTopics(options = {}) { return [...new Set(ENTRIES.filter(entry => permitted(entry, options)).map(entry => entry.topic))]; }

const api = Object.freeze({ version: 2, entries: (options = {}) => ENTRIES.filter(entry => permitted(entry, options)).map(copy), search, get, listTopics });
if (typeof window !== 'undefined') window.V7KnowledgeBase = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
