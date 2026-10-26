/* Logged-in community and support surface for the desktop app.
 * It deliberately uses V7Backend so auth, session ownership and server rules
 * stay in one place; no anonymous fallback reads online community data.
 */
(function (root) {
  'use strict';
  var mounted = null;
  var period = 'day';
  var search = '';
  var promptRows = [];
  var rankRows = [];
  var summary = null;
  var loadVersion = 0;
  var verification = { channel: 'email', target: '', requested: false };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function backend() { return root.V7Backend; }
  function back() { if(root.V7Workspaces){root.V7Workspaces.close('community');root.openServiceWorkspace?.();}else root.fillSettingsDetail?.(true,1); }
  function signed() { return !!(backend() && backend().state && backend().state().signedIn); }
  function account() { return signed() ? backend().state().account || {} : {}; }
  function verified() { return !!(account().email_verified_at || account().phone_verified_at); }
  function message(text, kind) {
    var node = mounted && mounted.querySelector('[data-community-status]');
    if (node) { node.textContent = String(text || ''); node.dataset.kind = kind || 'info'; }
  }
  function gate() {
    mounted.innerHTML = '<div class="settings-panel community-center"><div class="settings-intro"><strong>社区与客服</strong>社区排行榜、提示词投稿和在线状态仅对已登录账号开放。</div><div class="settings-section"><div class="settings-note">当前未登录：不能查看在线社区内容、排行榜或提交工单。</div><div class="settings-actions"><button class="settings-btn" data-community-settings>去连接与账号</button></div></div></div>';
    var button = mounted.querySelector('[data-community-settings]');
    if (button) button.onclick = back;
  }
  function verificationHtml() {
    var email = esc(account().email || '');
    return '<div class="settings-section" data-community-verification><div class="settings-section-title">投稿前验证账号</div>' +
      '<div class="settings-note">社区投稿需要验证邮箱或手机号。验证成功后才可以投稿；验证信息不会公开显示。</div>' +
      '<div class="settings-grid"><label class="settings-field"><span>验证方式</span><select data-community-channel><option value="email">邮箱</option><option value="phone">手机号</option></select></label>' +
      '<label class="settings-field"><span>验证目标</span><input data-community-target type="text" value="' + email + '" placeholder="邮箱或手机号"></label>' +
      '<label class="settings-field"><span>验证码</span><input data-community-code type="text" inputmode="numeric" maxlength="12" placeholder="收到验证码后填写"></label></div>' +
      '<div class="settings-actions"><button class="settings-btn" data-community-request>发送验证</button><button class="settings-btn" data-community-confirm>确认验证</button></div></div>';
  }
  function rankHtml() {
    var tabs = ['day', 'week', 'month'].map(function (value) {
      var label = value === 'day' ? '今日' : value === 'week' ? '本周' : '本月';
      return '<button class="settings-btn' + (period === value ? ' active' : '') + '" data-community-period="' + value + '">' + label + '</button>';
    }).join('');
    var rows = rankRows.length ? rankRows.map(function (row, index) {
      return '<div class="settings-note">' + (index + 1) + '. ' + esc(row.displayName || '用户***' + String(row.accountId || '').slice(-4)) + ' · 成功返回 ' + Number(row.imageCount || 0) + ' 张</div>';
    }).join('') : '<div class="settings-note">这个周期还没有可展示的生成结果。</div>';
    return '<div class="settings-section"><div class="settings-section-title">修图张数排行榜</div><div class="settings-actions">' + tabs + '</div>' + rows + '</div>';
  }
  function privacyHtml() {
    return '<div class="settings-section"><div class="settings-section-title">社区隐私</div>' +
      '<label class="settings-switch"><span>在排行榜显示已审核昵称（默认匿名）</span><input type="checkbox" data-community-rank-name ' + (account().show_rank_name ? 'checked' : '') + '></label>' +
      '<label class="settings-switch"><span>参与陪伴人数统计（默认关闭）</span><input type="checkbox" data-community-share-activity ' + (account().share_activity ? 'checked' : '') + '></label>' +
      '<div class="settings-note">开启后仅上报操作中或等待生成的短时状态，不发送图片、提示词或项目名称。关闭不影响查看社区和服务状态。</div></div>';
  }
  function promptHtml() {
    var cards = promptRows.length ? promptRows.map(function (row) {
      var mine = row.liked ? '已点赞' : '点赞';
      return '<div class="settings-section" data-community-prompt="' + esc(row.id) + '"><div class="settings-section-title">' + esc(row.title) + '<small>' + esc(row.display_name || '用户***' + String(row.account_id || '').slice(-4)) + '</small></div><div class="settings-note">' + esc(row.prompt) + '</div><div class="settings-actions"><button class="settings-btn" data-community-like>' + mine + ' · ' + Number(row.likes || 0) + '</button><button class="settings-btn" data-community-save>收藏 · ' + Number(row.saves || 0) + '</button></div></div>';
    }).join('') : '<div class="settings-note">没有找到已审核提示词。</div>';
    return '<div class="settings-section"><div class="settings-section-title">审核制提示词</div><div class="settings-grid"><label class="settings-field full"><span>搜索提示词</span><input data-community-search value="' + esc(search) + '" placeholder="输入标题或提示词关键词"></label></div><div class="settings-actions"><button class="settings-btn" data-community-refresh>搜索</button></div></div>' + cards;
  }
  function submitHtml() {
    var body = '<div class="settings-section"><div class="settings-section-title">投稿提示词</div>';
    if (!verified()) body += verificationHtml();
    body += '<div class="settings-grid"><label class="settings-field"><span>标题</span><input data-community-title placeholder="例如：人像修脸"></label><label class="settings-field full"><span>提示词</span><textarea data-community-prompt rows="4" placeholder="填写准备提交的提示词"></textarea></label></div><div class="settings-actions"><button class="settings-btn" data-community-submit ' + (!verified() ? 'disabled' : '') + '>提交人工审核</button></div><div class="settings-note">投稿通常在 1–3 个工作日内人工审核；审核记录会保留。</div></div>';
    return body + '</div>';
  }
  function supportHtml() {
    return '<div class="settings-section"><div class="settings-section-title">客服工单</div><div class="settings-note">客服 Agent 只查询当前账号状态和登记工单，不操作积分、权限或其他账号。</div><div class="settings-grid"><label class="settings-field"><span>主题</span><input data-support-subject placeholder="遇到什么问题"></label><label class="settings-field full"><span>说明</span><textarea data-support-body rows="3" placeholder="请描述问题"></textarea></label></div><div class="settings-actions"><button class="settings-btn" data-support-submit>登记工单</button></div></div>';
  }
  function render() {
    if (!mounted) return;
    if (!signed()) return gate();
    var rank = rankHtml();
    mounted.innerHTML = '<div class="settings-panel community-center"><div class="settings-intro"><strong>社区与客服</strong>近 5 分钟共同修图：' + Number(summary && summary.activeUsers || 0) + ' 人（仅统计主动参与者） · ' + (summary && summary.awards && summary.awards.configured ? '本月奖品已公布' : '本月奖品尚未公布，不承诺金额') + '</div><div data-community-status class="settings-status"></div>' + privacyHtml() + rank + promptHtml() + submitHtml() + supportHtml() + '<div class="settings-actions"><button class="settings-btn" data-community-back>返回连接与账号</button></div></div>';
    bind();
  }
  async function load() {
    var version = ++loadVersion;
    if (!signed()) return render();
    try {
      var result = await Promise.all([backend().leaderboard(period), backend().communityPrompts(search), backend().communitySummary()]);
      if (version !== loadVersion || !signed()) return;
      rankRows = result[0].entries || [];
      promptRows = result[1].prompts || [];
      summary = result[2] || null;
      render();
    } catch (error) { if (version !== loadVersion) return; render(); message(error.message || '社区暂时无法加载', 'error'); }
  }
  function bind() {
    var backButton = mounted.querySelector('[data-community-back]');
    if (backButton) backButton.onclick = back;
    var rankName = mounted.querySelector('[data-community-rank-name]');
    if (rankName) rankName.onchange = async function () { var value = rankName.checked; rankName.disabled = true; try { await backend().communityPrivacy({ showRankName: value }); message(value ? '排行榜昵称显示已开启。' : '排行榜已恢复匿名。', 'ok'); } catch (error) { rankName.checked = !value; message(error.message || '隐私设置未保存', 'error'); } finally { rankName.disabled = false; } };
    var shareActivity = mounted.querySelector('[data-community-share-activity]');
    if (shareActivity) shareActivity.onchange = async function () { var value = shareActivity.checked; shareActivity.disabled = true; try { await backend().communityPrivacy({ shareActivity: value }); message(value ? '陪伴人数统计已开启。' : '已停止分享在线状态。', 'ok'); } catch (error) { shareActivity.checked = !value; message(error.message || '隐私设置未保存', 'error'); } finally { shareActivity.disabled = false; } };
    mounted.querySelectorAll('[data-community-period]').forEach(function (node) { node.onclick = function () { period = node.dataset.communityPeriod; load(); }; });
    var refresh = mounted.querySelector('[data-community-refresh]');
    if (refresh) refresh.onclick = function () { var input = mounted.querySelector('[data-community-search]'); search = input ? input.value.trim() : ''; load(); };
    mounted.querySelectorAll('[data-community-like],[data-community-save]').forEach(function (node) { node.onclick = async function () { var card = node.closest('[data-community-prompt]'); var action = node.hasAttribute('data-community-like') ? 'like' : 'save'; try { await backend().reactCommunityPrompt(card.dataset.communityPrompt, action); await load(); } catch (error) { message(error.message || '操作未完成', 'error'); } }; });
    var request = mounted.querySelector('[data-community-request]');
    if (request) request.onclick = async function () { request.disabled = true; try { verification.channel = mounted.querySelector('[data-community-channel]').value; verification.target = mounted.querySelector('[data-community-target]').value.trim(); var result = await backend().requestVerification(verification.channel, verification.target); verification.requested = true; message(result.delivery === 'development' ? '开发测试验证码：' + result.devCode + '（未发送真实消息）' : '验证服务已受理，请查收验证码。', 'ok'); } catch (error) { message(error.message || '验证发送失败', 'error'); } finally { request.disabled = false; } };
    var confirm = mounted.querySelector('[data-community-confirm]');
    if (confirm) confirm.onclick = async function () { try { var channel = mounted.querySelector('[data-community-channel]').value; var code = mounted.querySelector('[data-community-code]').value.trim(); await backend().confirmVerification(channel, code); await backend().me(); await load(); } catch (error) { message(error.message || '验证失败', 'error'); } };
    var submit = mounted.querySelector('[data-community-submit]');
    if (submit) submit.onclick = async function () { try { await backend().submitCommunityPrompt(mounted.querySelector('[data-community-title]').value.trim(), mounted.querySelector('[data-community-prompt]').value.trim(), {}); await load(); message('已提交人工审核，通常 1–3 个工作日内处理。', 'ok'); } catch (error) { message(error.message || '投稿未提交', 'error'); } };
    var support = mounted.querySelector('[data-support-submit]');
    if (support) support.onclick = async function () { try { await backend().submitSupportTicket(mounted.querySelector('[data-support-subject]').value.trim(), mounted.querySelector('[data-support-body]').value.trim()); message('工单已登记，客服会在工作时间处理。', 'ok'); } catch (error) { message(error.message || '工单未登记', 'error'); } };
  }
  function open(host) { mounted = host; period = 'day'; search = ''; load(); }
  root.V7CommunityCenter = { open: open, close: function () { loadVersion++; mounted = null; }, refresh: load };
  if (backend() && backend().onChange) {
    var priorSession = '';
    backend().onChange(function (state) {
      var session = state.signedIn ? [state.baseUrl, state.account && state.account.id, state.sessionVersion].join('|') : '';
      if (session === priorSession) return;
      priorSession = session; loadVersion++;
      promptRows = []; rankRows = []; summary = null;
      verification = { channel: 'email', target: '', requested: false };
      if (mounted) { render(); if (signed()) load(); }
    });
  }
})(window);
