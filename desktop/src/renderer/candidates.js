// Loaded after workspace.js; owns its tab, controls and polling without patching other renderers.
(() => {
  if (document.getElementById('tab-candidates')) return;
  const tab = document.createElement('button');
  tab.className = 'tab-btn'; tab.dataset.tab = 'candidates'; tab.textContent = '候选与恢复';
  tab.setAttribute('role', 'tab'); tab.addEventListener('click', () => showTab('candidates'));
  document.querySelector('.tabs').append(tab);
  const panel = document.createElement('section');
  panel.id = 'tab-candidates'; panel.className = 'tab manager'; panel.hidden = true;
  panel.innerHTML = `<header class="manager-toolbar"><h2>候选与恢复</h2><button data-candidate-refresh>刷新</button><span data-candidate-message role="status" aria-live="polite"></span></header><p class="mute">多图结果需要明确选择后才会处理、自动贴回或进入下一步。恢复已有任务只查询和下载，使用原任务 ID。</p><div data-candidate-list></div>`;
  document.body.append(panel);
  const list = panel.querySelector('[data-candidate-list]');
  const message = panel.querySelector('[data-candidate-message]');
  let refreshing = false, actionPending = false, rendered = '';
  const id = value => encodeURIComponent(value);
  async function refresh() {
    if (refreshing || actionPending) return;
    refreshing = true;
    try {
      const { jobs } = await api('GET', '/candidates');
      const count = jobs.filter(j => j.status === 'awaiting-selection').length;
      tab.textContent = `候选与恢复${count ? ` (${count})` : ''}`;
      const key = JSON.stringify(jobs);
      if (key === rendered) return;
      rendered = key;
      list.innerHTML = jobs.map(j => {
        const choosing = j.status === 'awaiting-selection';
        return `<article class="studio-card"><h3>${esc(j.meta?.title || j.prompt?.slice(0, 100) || j.id)}</h3><p>${esc(j.provider)} · ${esc(j.stage || j.status)}</p>${j.error ? `<p>${esc(j.error)}</p>` : ''}${j.upstream?.taskId ? `<p class="mute">已有任务：${esc(j.upstream.taskId)}</p>` : ''}${j.candidatesTruncated ? `<p>服务返回 ${Number(j.candidateCount)} 张，本地最多保存 ${Number(j.candidateLimit)} 张。其余结果请在服务端查看。</p>` : ''}<div class="candidate-grid">${(j.candidates || []).map(c => `<figure class="candidate-card"><a href="${esc(url(`/candidates/${id(j.id)}/${id(c.id)}/image`))}" target="_blank" rel="noopener"><img src="${esc(url(`/candidates/${id(j.id)}/${id(c.id)}/thumb`))}" alt="候选 ${Number(c.index) + 1}" loading="lazy" class="candidate-image"></a><figcaption>候选 ${Number(c.index) + 1} · ${Number(c.width)}×${Number(c.height)}</figcaption>${choosing ? `<button data-candidate-select="${esc(c.id)}" data-job="${esc(j.id)}" ${j.selectedCandidateId && j.selectedCandidateId !== c.id ? 'disabled' : ''}>${j.selectedCandidateId === c.id ? '继续处理已选图片' : '选择此图并继续'}</button>` : ''}</figure>`).join('')}</div><div class="row">${j.canRecover ? `<button data-candidate-recover="${esc(j.id)}">恢复已有任务</button>` : ''}${j.status === 'error' && !j.canRecover ? '<span class="mute">没有可恢复的任务 ID 或服务不支持恢复，请在服务端人工核对。</span>' : ''}${['running', 'awaiting-selection'].includes(j.status) ? `<button data-candidate-cancel="${esc(j.id)}">停止此任务</button>` : ''}</div></article>`;
      }).join('') || '<p class="mute">没有待选择或需要恢复的任务</p>';
    } catch (e) { message.textContent = reason(e); }
    finally { refreshing = false; }
  }
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || actionPending) return;
    if (button.hasAttribute('data-candidate-refresh')) { await refresh(); return; }
    const d = button.dataset;
    if (!d.candidateSelect && !d.candidateRecover && !d.candidateCancel) return;
    actionPending = true; button.disabled = true; message.textContent = '处理中…';
    try {
      if (d.candidateSelect) await api('POST', `/candidates/${id(d.job)}/select`, { candidateId: d.candidateSelect });
      if (d.candidateRecover) await api('POST', `/candidates/${id(d.candidateRecover)}/recover`, {});
      if (d.candidateCancel) await api('POST', `/jobs/${id(d.candidateCancel)}/cancel`, {});
      message.textContent = d.candidateRecover ? '正在查询已有任务；未重新提交。' : d.candidateCancel ? '已停止。' : '已保存选择并处理完成。';
      rendered = '';
      if (typeof refreshJobs === 'function') await refreshJobs();
    } catch (e) { message.textContent = reason(e); }
    finally { actionPending = false; button.disabled = false; await refresh(); }
  });
  document.addEventListener('workspace-tab', event => { if (event.detail === 'candidates') refresh(); });
  const timer = setInterval(refresh, 4000);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  refresh();
})();
