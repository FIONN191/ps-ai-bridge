/* Shared keyboard boundary for work surfaces and the stacked main panel.
 * Keep the visual stack and its coordinate-based exposed-edge navigation intact.
 * Only this module owns the inert attributes it adds; pre-existing locks survive.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const overlaySelector = 'dialog[open],[data-ui-overlay],#errors[data-v7-confirmation],.v7-manual-overlay,.canvas-workbench,.region-workbench,.ps-dlg-ov,.rw-preview';
  const focusSelector = 'button,input,select,textarea,summary,a[href],[tabindex],[contenteditable="true"]';
  const closeSelector = '[data-overlay-close],[data-manual-close],[data-close],[data-cw="close"],[data-rw="preview-close"],[data-rw="close"],[data-x="c"]';
  const records = new Map(), ownedLocks = new Map(), openingOrigins = new WeakMap();
  const externalOperations = [];
  // Direct UI.dialog callers do not go through outsideModal(). Keep their
  // active decision card in the same scope registry so buttons, Escape and
  // background inertness follow exactly the same rules as wrapped callers.
  const directConfirmations = [];
  let activeScope = null, lastFocus = doc.activeElement, sequence = 0, syncing = false, pending = false;
  const confirmationStyle=doc.createElement('style');
  confirmationStyle.dataset.v7FocusStyle='';
  confirmationStyle.textContent=`
    #errors .error-card[data-v7-direct-confirmation]{height:auto;min-height:100px;}
    #errors .error-card[data-v7-direct-confirmation] .ec-title{white-space:normal;overflow-wrap:anywhere;}
    #errors .error-card[data-v7-direct-confirmation] .ec-desc{display:block;white-space:pre-wrap;overflow:visible;overflow-wrap:anywhere;}
  @media(max-width:700px){
    #errors[data-v7-confirmation]{position:fixed!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:min(340px,calc(100vw - 24px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;gap:8px;overflow:auto;overscroll-behavior:contain;z-index:calc(var(--z-workbench,9000) + 1);}
    #errors[data-v7-confirmation]>:not([data-v7-current-confirmation]){display:none!important;}
    #errors[data-v7-confirmation]>[data-v7-current-confirmation]{position:relative!important;inset:auto!important;width:100%;height:auto;transform:none!important;box-sizing:border-box;flex:none;background:var(--workbench-bg,var(--bg-solid));}
    #errors[data-v7-confirmation]>.error-card{order:0;min-height:100px;}
    #errors[data-v7-confirmation]>.error-detail{order:1;min-height:72px;flex-direction:column;}
    #errors[data-v7-confirmation]>.error-detail:not(.show){display:none;}
    #errors[data-v7-confirmation] .ec-title{white-space:normal;overflow-wrap:anywhere;}
    #errors[data-v7-confirmation] .ec-desc{display:block;white-space:pre-wrap;overflow:visible;margin-top:8px;line-height:1.6;overflow-wrap:anywhere;}
    #errors[data-v7-confirmation] .ed-btns{flex-direction:row;flex-wrap:wrap;justify-content:flex-end;}
    #errors[data-v7-confirmation] .ed-btn{width:auto;min-height:36px;white-space:normal;}
  }`;
  doc.head.append(confirmationStyle);

  function visible(el) {
    if (!el || !el.isConnected || el.closest('[hidden]')) return false;
    const style = root.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function latestDirectConfirmation() {
    for (let i = directConfirmations.length - 1; i >= 0; i--) {
      const card = directConfirmations[i];
      if (card && card.isConnected && card._detailEl) return card;
      directConfirmations.splice(i, 1);
    }
    return null;
  }
  function currentConfirmation() {
    const operation = externalOperations.at(-1);
    const external = operation && operation.card;
    return external || latestDirectConfirmation();
  }
  function markConfirmation(card) {
    if (!card || !card.isConnected) return null;
    card.parentElement?.setAttribute('data-v7-confirmation', '');
    card.setAttribute('data-v7-current-confirmation', '');
    if (card._detailEl) card._detailEl.setAttribute('data-v7-current-confirmation', '');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', (card.querySelector('.ec-title')?.textContent || '确认操作') + '，按回车展开');
    return card;
  }
  function candidates() {
    const result = [...doc.querySelectorAll(overlaySelector)].filter(el =>
      !el.matches('.dlss-backdrop') && el.dataset.uiOverlay !== 'false' &&
      (!el.matches('dialog') || el.open) && visible(el));
    const operation = externalOperations.at(-1);
    const card = operation
      ? [...doc.querySelectorAll('#errors .ec-l3')].find(el => !operation.previousCards.has(el))
      : latestDirectConfirmation();
    if (card) {
      if (operation) operation.card = card;
      markConfirmation(card);
      if (!result.includes(card.parentElement)) result.push(card.parentElement);
    }
    return result;
  }
  function topScope(list) {
    // Browser modal dialogs occupy the top layer regardless of CSS z-index.
    const modal = list.filter(el => el.matches('dialog:modal')).sort((a, b) => records.get(a).order - records.get(b).order).pop();
    const eligible = modal ? list.filter(el => el === modal || modal.contains(el)) : list;
    return eligible.sort((a, b) => {
      if (a.contains(b)) return -1;
      if (b.contains(a)) return 1;
      return (parseInt(root.getComputedStyle(a).zIndex, 10) || 0) - (parseInt(root.getComputedStyle(b).zIndex, 10) || 0) || records.get(a).order - records.get(b).order;
    }).pop() || null;
  }
  function usable(el) {
    return visible(el) && !el.closest('[inert],.error-detail:not(.show)') && !el.disabled && el.getClientRects().length > 0;
  }
  function focus(el) {
    if (!usable(el)) return false;
    if (!el.matches(focusSelector)) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    return doc.activeElement === el;
  }
  function focusFirst(scope, reverse) {
    if (!scope) return false;
    const targets = [...scope.querySelectorAll(focusSelector)].filter(el => el.tabIndex >= 0 && usable(el));
    return focus(reverse ? targets.at(-1) || scope : targets[0] || scope);
  }
  function mainFallback() {
    const card = doc.querySelector('#stack .block-card.is-current');
    return card && (card.querySelector('[data-collapse-toggle]') || card);
  }
  function locksFor(scope) {
    const desired = new Set();
    const freeMode = doc.body.classList.contains('free-mode');
    doc.querySelectorAll(freeMode ? '#stack .block-card[hidden],#stack .free-group-hidden,#stack .free-pile-buried,#collapsePill' : '#stack .block-card:not(.is-current),#collapsePill').forEach(el => desired.add(el));
    if (freeMode) doc.querySelectorAll('#stack .free-collapsed > :not([data-collapse-toggle]):not([data-free-release])').forEach(el => desired.add(el));
    doc.querySelectorAll('#zones,#detail').forEach(el => {
      if (!el.classList.contains('show') || el.classList.contains('closing') || doc.body.classList.contains('ui-collapsed')) desired.add(el);
    });
    if (doc.body.classList.contains('ui-collapsed')) {
      doc.querySelectorAll('#stack .block-card.is-current > :not([data-collapse-toggle]),#tasks,#errors').forEach(el => desired.add(el));
    }
    if (scope) {
      const card = currentConfirmation();
      if (scope.id === 'errors' && card) {
        [...scope.children].forEach(el => { if (el !== card && el !== card._detailEl) desired.add(el); });
      }
      const menu = root.UISelect?.isOpen() ? root.UISelect.panelEl() : null;
      // Walk the ancestor path as well: a nested dialog must isolate its parent.
      for (let branch = scope; branch && branch !== doc.body; branch = branch.parentElement) {
        desired.delete(branch);
        for (const sibling of branch.parentElement?.children || []) {
          if (sibling !== branch && !sibling.matches('script,style,link') && sibling !== menu && !sibling.contains(menu)) desired.add(sibling);
        }
      }
    }
    return desired;
  }
  function applyLocks(desired) {
    for (const [el, wasInert] of ownedLocks) {
      if (desired.has(el)) continue;
      if (!wasInert) el.removeAttribute('inert');
      ownedLocks.delete(el);
    }
    for (const el of desired) {
      if (!ownedLocks.has(el)) ownedLocks.set(el, el.hasAttribute('inert'));
      if (!el.hasAttribute('inert')) el.setAttribute('inert', '');
    }
  }
  function sync() {
    if (syncing || !doc.body) return;
    syncing = true;
    try {
      const list = candidates(), previous = activeScope, oldRecords = new Map(records);
      for (const el of list) {
        if (!records.has(el)) records.set(el, { origin: openingOrigins.get(el) || (!el.contains(doc.activeElement) ? doc.activeElement : lastFocus), order: ++sequence });
      }
      activeScope = topScope(list);
      for (const el of records.keys()) if (!list.includes(el)) records.delete(el);
      applyLocks(locksFor(activeScope));
      if (previous && !list.includes(previous)) {
        let origin = oldRecords.get(previous)?.origin;
        const visited = new Set();
        while (origin && !origin.isConnected && !visited.has(origin)) {
          visited.add(origin);
          const parent = [...oldRecords].find(([el]) => el !== previous && el.contains(origin));
          origin = parent?.[1].origin;
        }
        if (origin && (!activeScope || activeScope.contains(origin)) && focus(origin)) return;
      }
      if (activeScope && !activeScope.contains(doc.activeElement)) focusFirst(activeScope);
      else if (!activeScope && (previous || doc.activeElement?.closest('[inert]'))) focus(mainFallback());
    } finally { syncing = false; }
  }
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; sync(); });
  }
  function closeScope(scope) {
    if (scope.id === 'errors') {
      currentConfirmation()?._detailEl?.querySelector('[data-a="cancel"]')?.click();
      return;
    }
    // Dispatch the browser's existing cancel contract. Its handler retains save,
    // busy-state and unsaved-work protection; never remove a work surface here.
    if (scope.matches('dialog')) {
      if (scope.dispatchEvent(new Event('cancel', { cancelable: true }))) scope.close();
      return;
    }
    scope.querySelector(closeSelector)?.click();
  }
  function revealConfirmation(card) {
    card._detailEl?.classList.add('show');
    root.__errDetail = card._detailEl;
    sync();
    if (card._detailEl?.classList.contains('show')) focusFirst(card._detailEl);
  }
  function registerConfirmation(card) {
    if (!card || !card.isConnected || !card._detailEl) return false;
    const previous = latestDirectConfirmation();
    if (previous && previous !== card) {
      previous.removeAttribute('data-v7-direct-confirmation');
      previous.removeAttribute('data-v7-current-confirmation');
      previous._detailEl?.removeAttribute('data-v7-current-confirmation');
    }
    if (!directConfirmations.includes(card)) directConfirmations.push(card);
    card.setAttribute('data-v7-direct-confirmation', '');
    card._detailEl.classList.add('show');
    root.__errDetail = card._detailEl;
    markConfirmation(card);
    sync();
    if (card._detailEl.classList.contains('show')) focusFirst(card._detailEl);
    return true;
  }
  function unregisterConfirmation(card) {
    const index = directConfirmations.indexOf(card);
    if (index >= 0) directConfirmations.splice(index, 1);
    card?.removeAttribute('data-v7-direct-confirmation');
    card?.removeAttribute('data-v7-current-confirmation');
    if (card?._detailEl) card._detailEl.removeAttribute('data-v7-current-confirmation');
    const next = latestDirectConfirmation();
    if (next) {
      next.setAttribute('data-v7-direct-confirmation', '');
      next._detailEl.classList.add('show');
      markConfirmation(next);
    } else if (!externalOperations.length) {
      card?.parentElement?.removeAttribute('data-v7-confirmation');
      card?.removeAttribute('data-v7-current-confirmation');
    }
    sync();
  }
  doc.addEventListener('keydown', event => {
    lastFocus = doc.activeElement;
    const confirmationCard = currentConfirmation();
    if (confirmationCard && event.target === confirmationCard && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopImmediatePropagation();
      revealConfirmation(confirmationCard);
      return;
    }
    if (event.key !== 'Tab' && event.key !== 'Escape') return;
    sync();
    if (event.key === 'Escape' && root.UISelect?.isOpen()) {
      event.preventDefault(); event.stopImmediatePropagation(); root.UISelect.close(); return;
    }
    if (!activeScope) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat && !event.isComposing) closeScope(activeScope);
      return;
    }
    // Explicit wrapping also handles div/section overlays, whose focus behavior
    // is not supplied by showModal(). Inert blocks programmatic background focus.
    const targets = [...activeScope.querySelectorAll(focusSelector)].filter(el => el.tabIndex >= 0 && usable(el));
    const at = targets.indexOf(doc.activeElement);
    if (!targets.length || at < 0 || (!event.shiftKey && at === targets.length - 1) || (event.shiftKey && at === 0)) {
      event.preventDefault(); event.stopImmediatePropagation(); focusFirst(activeScope, event.shiftKey);
    }
  }, true);
  doc.addEventListener('click', event => {
    if (!event.target.closest?.('dialog')) lastFocus = doc.activeElement;
    // 2026-10-18 深夜：报错堆的垃圾桶（一键清）永远放行 —— 它就是用来把卡住界面的决定卡清掉的（L3 当作「取消」）
    if (event.target.closest?.('[data-stack-trash]')) return;
    const card = currentConfirmation();
    if (card && card.contains(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); revealConfirmation(card);
    }
  }, true);
  // Legacy L3 cards use the main document's pointer geometry. Let their events
  // reach that code while excluding all underlying controls during confirmation.
  for (const name of ['pointerdown', 'mousedown', 'click', 'wheel']) {
    root.addEventListener(name, event => {
      const card = currentConfirmation();
      if (event.target.closest?.('[data-stack-trash]')) return;   // 垃圾桶永远放行（见上面 click 那条）
      if (card && !card.parentElement.contains(event.target)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, { capture: true, passive: false });
  }
  doc.addEventListener('pointerdown', event => {
    lastFocus = event.target.closest?.(focusSelector) || doc.activeElement;
  }, true);
  doc.addEventListener('beforetoggle', event => {
    if (event.newState === 'open' && event.target.matches('dialog')) openingOrigins.set(event.target, doc.activeElement);
  }, true);
  doc.addEventListener('focusin', event => {
    if (!syncing) sync();
    if (!activeScope || activeScope.contains(event.target)) lastFocus = event.target;
  }, true);
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden', 'data-ui-overlay'] });
  async function outsideModal(operation) {
    const source = doc.activeElement;
    const suspended = candidates().map(el => ({ el, modal: el.matches('dialog:modal'), hidden: el.hidden, record: records.get(el) }))
      .sort((a, b) => (a.record?.order || 0) - (b.record?.order || 0));
    const external = { previousCards: new Set(doc.querySelectorAll('#errors .ec-l3')), card: null };
    try {
      root.UISelect?.close();
      // close fires asynchronously. Consume only our temporary close event before
      // invoking the operation, so ordinary close handlers cannot dispose drafts.
      await Promise.all(suspended.map(async item => {
        item.el.dataset.v7ModalSuspended = '1';
        item.el.hidden = true;
        if (item.modal) await new Promise(resolve => {
          item.el.addEventListener('close', event => { event.stopImmediatePropagation(); resolve(); }, { capture: true, once: true });
          item.el.close();
        });
      }));
      externalOperations.push(external);
      sync();
      return await operation();
    } finally {
      const index = externalOperations.indexOf(external);
      if (index >= 0) externalOperations.splice(index, 1);
      if(external.card){
        delete external.card.dataset.v7CurrentConfirmation;
        if(external.card._detailEl)delete external.card._detailEl.dataset.v7CurrentConfirmation;
        if(!externalOperations.length)delete external.card.parentElement?.dataset.v7Confirmation;
      }
      for (const item of suspended) {
        if (!item.el.isConnected) continue;
        item.el.hidden = item.hidden;
        if (item.modal && !item.el.open) item.el.showModal();
        if (item.record) records.set(item.el, item.record);
        delete item.el.dataset.v7ModalSuspended;
      }
      sync();
      if (source?.isConnected) focus(source);
    }
  }
  root.V7FocusScope = {
    sync,
    outsideModal,
    registerConfirmation,
    unregisterConfirmation,
    isOutsideModalActive: () => externalOperations.length > 0,
    isOpen: () => candidates().length > 0
  };
  sync();
})(window);
