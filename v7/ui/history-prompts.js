(function (root) {
  'use strict';
  let host = {}, contextEpoch=0,applySequence=0;
  root.addEventListener('wheelchair:storage-context',()=>{contextEpoch++;});
  const views = new Map();
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const scope = () => root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.namespaceId() : 'anonymous';
  async function apply(value,options={}){
    const initialScope=scope(),initialEpoch=contextEpoch,sequence=++applySequence;
    const check=()=>{options.check?.();if(scope()!==initialScope||contextEpoch!==initialEpoch||sequence!==applySequence)throw Object.assign(new Error('历史复用上下文已变化，请重新选择'),{code:'HISTORY_CONTEXT_CHANGED'});};
    check();
    if(!value||!Object.keys(value).length)throw new Error('请至少选择一项');
    if(!host.apply)throw new Error('当前版本未连接历史复用');
    await host.apply(value,{check});check();
    // ⭐ 2026-10-19（docs/250 第 8 条）：预设二级的「最近用过的提示词」点一下就用 —— 那边自己给一句轻提示，这里不再弹要点「知道了」的卡
    if(options.quiet)return;
    root.UI.notice({title:'已应用到当前输入',body:'已应用选择的内容。请确认当前照片与选区，再点击生成。'});
  }
  function mount(container) {
    const initialScope = scope(),initialEpoch=contextEpoch;
    let operation=0;
    const current=()=>scope()===initialScope&&contextEpoch===initialEpoch;
    if(!views.has(initialScope))views.set(initialScope,{query:'',mode:'recent',page:0});
    const view=views.get(initialScope);
    let query = view.query, mode = view.mode;
    container.innerHTML = '<div class="settings-section"><div class="settings-section-title">查找与复用</div><div class="settings-note">跨照片查找以前用过的提示词。可分别选择提示词、预设、模型或参数；下一次生成会重新读取当前 Photoshop 选区。</div><label class="settings-field"><span>搜索关键词</span><input data-history-search placeholder="例如：毛发、眼神、修脸"></label><div class="settings-actions"><button class="settings-btn" data-history-mode="recent">最近提示词</button><button class="settings-btn" data-history-mode="records">每次使用记录</button></div><div data-history-count class="settings-note"></div><div class="history-list" data-prompt-records></div></div>';
    const list = container.querySelector('[data-prompt-records]');
    const pager=document.createElement('div');pager.className='settings-actions';
    pager.innerHTML='<button class="settings-btn" data-prompt-prev title="上一页" aria-label="上一页">'+root.ICON.render('arrowLeft',16)+'</button><span data-prompt-page></span><button class="settings-btn" data-prompt-next title="下一页" aria-label="下一页">'+root.ICON.render('arrowRight',16)+'</button>';
    list.after(pager);
    function render() {
      try {
      if (!current()) { list.replaceChildren(); return; }
      const api = root.V7ProductData;
      let found = mode === 'recent' ? api.recentPrompts(21, query,view.page*20) : api.searchHistory(query, { limit: 21,offset:view.page*20 });
      if(!found.length&&view.page>0){view.page--;render();return;}
      const rows=found.slice(0,20);
      pager.querySelector('[data-prompt-prev]').disabled=!view.page;
      pager.querySelector('[data-prompt-next]').disabled=found.length<=20;
      pager.querySelector('[data-prompt-page]').textContent='第 '+(view.page+1)+' 页';
      container.querySelector('[data-history-count]').textContent = rows.length ? '最近匹配的 ' + rows.length + ' 项' : '还没有匹配的提示词';
      const paint = () => { list.innerHTML = rows.map(row => '<div class="history-item" data-record-id="' + esc(row.id) + '">' +
        '<div class="history-item-title">' + esc(row.presetTitle || '自定义提示词') + '</div><div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px">' + esc(row.prompt) + '</div>' +
        '<div class="history-item-info">' + esc(row.documentName || '未登记照片') + ' · ' + esc(row.model || row.parameters && row.parameters.model || '') + ' · ' + (window.V7Format ? window.V7Format.agoHtml(row.lastUsedAt) : esc(new Date(row.lastUsedAt).toLocaleString())) + (mode === 'recent' ? ' · 使用 ' + row.useCount + ' 次' : '') + '</div>' +
        '<div class="settings-actions"><button class="settings-btn" data-reuse-prompt>仅用提示词</button><button class="settings-btn" data-reuse-parts>选择复用内容</button>' + (mode === 'records' ? '<button class="settings-btn danger" data-delete-record>删除这条记录</button>' : '') + '</div><div data-history-choice></div></div>').join(''); };
      // 2026-10-22（docs/263 第三批）：删一条时下面的补上去、新出现的淡入
      if (root.V7Motion) root.V7Motion.listFlip(list, n => n.dataset.recordId, paint); else paint();
      } catch(error) { report(error); }
    }
    pager.querySelector('[data-prompt-prev]').onclick=()=>{view.page=Math.max(0,view.page-1);render();};
    pager.querySelector('[data-prompt-next]').onclick=()=>{view.page++;render();};
    async function reuse(rowId, choices) {
      if (!current()) return;
      const sequence=++operation;
      const check=()=>{if(!current()||operation!==sequence)throw Object.assign(new Error('历史复用上下文已变化，请重新选择'),{code:'HISTORY_CONTEXT_CHANGED'});};
      const value = root.V7ProductData.reuseHistory(rowId, choices);
      await apply(value,{check});
    }
    container.querySelector('[data-history-search]').value=query;
    container.querySelector('[data-history-search]').addEventListener('input', e => { query = view.query = e.target.value; view.page=0;render(); });
    container.querySelectorAll('[data-history-mode]').forEach(button => button.addEventListener('click', () => { mode = view.mode = button.dataset.historyMode;view.page=0;render(); }));
    list.addEventListener('click', async e => {
      const row = e.target.closest('[data-record-id]'); if (!row || !current()) return;
      e.preventDefault(); e.stopPropagation(); const id = row.dataset.recordId;
      try {
        if (e.target.closest('[data-reuse-prompt]')) await reuse(id, { prompt: true });
        if (e.target.closest('[data-reuse-parts]')) {
          row.querySelector('[data-history-choice]').innerHTML = '<div class="settings-note">只应用勾选项；不会覆盖预设库中的原始预设。</div>' +
            [['prompt', '提示词', true], ['preset', '原预设', false], ['model', '模型与渠道', false], ['parameters', '尺寸、张数等参数', false]].map(([key, label, checked]) => '<label style="display:block"><input type="checkbox" data-part="' + key + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>').join('') + '<button class="settings-btn" data-apply-parts>应用勾选项</button>';
        }
        if (e.target.closest('[data-apply-parts]')) await reuse(id, Object.fromEntries(Array.from(row.querySelectorAll('[data-part]')).map(input => [input.dataset.part, input.checked])));
        if (e.target.closest('[data-delete-record]')) {
          // ⭐ 2026-10-22（docs/263 第 6 条，用户拍板）：不再弹确认框 —— 先删，底部给「撤销」，点了放回原位。
          //   删的只是这一条使用记录（生成的图、PS 文件、预设库都不动），放得回去，所以用撤销而不是确认框。
          const result=root.V7ProductData.removeHistory(id,{confirm:true});render();
          if(result&&result.removed&&root.V7Undo&&root.V7ProductData.restoreHistory){
            root.V7Undo.offer('已删除 1 条提示词记录',()=>{try{root.V7ProductData.restoreHistory(result.removed,result.index);if(current())render();}catch(error){report(error);}});
          }
        }
      } catch (error) { if(current()&&error.code!=='HISTORY_CONTEXT_CHANGED')report(error); }
    });
    function report(error) { if (root.ERR) root.ERR.report('HISTORY_OPERATION_FAILED', { message: String(error.message || error) }); }
    render();
  }
  root.V7HistoryPrompts = { mount, apply, configure: options => { host = options || {}; } };
})(window);
