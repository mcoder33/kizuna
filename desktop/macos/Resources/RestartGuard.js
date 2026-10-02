// Installed only in the app's main WKWebView, before page scripts execute.
// Never submit a form on the user's behalf or restart over an active edit.
(() => {
  const baseline = new WeakMap(), changed = new Map();
  let pending = 0, locked = false;
  const field = target => {
    const el = target?.closest?.('input, textarea, [contenteditable="true"]');
    // Filters, toggles and sliders are not unfinished text drafts.
    return el?.tagName === 'INPUT' && !['text', 'email', 'password', 'url', 'tel'].includes(el.type) ? null : el;
  };
  const value = el => el.isContentEditable ? el.innerHTML
    : ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value;
  const empty = el => el.isContentEditable ? !el.textContent.trim() : !String(el.value ?? '').trim();
  const isDraft = el => el.matches('#capture-input, textarea');
  document.addEventListener('focusin', event => {
    const el = field(event.target);
    if (el && !changed.has(el)) baseline.set(el, value(el));
  }, true);
  const observe = event => {
    const el = field(event.target);
    if (!el) return;
    for (const previous of changed.keys()) if (!previous.isConnected) changed.delete(previous);
    if (!baseline.has(el)) baseline.set(el, el.defaultValue ?? '');
    changed.set(el, baseline.get(el));
  };
  document.addEventListener('input', observe, true);
  document.addEventListener('change', observe, true);
  const mutates = method => !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const writing = mutates(init?.method ?? input?.method);
    if (writing) pending++;
    try {
      const response = await originalFetch.apply(this, arguments);
      // fetch resolves at headers; keep waiting until the save response body
      // arrives as well, without consuming the application's own response.
      if (writing) response.clone().arrayBuffer().catch(() => {}).finally(() => { pending--; });
      return response;
    } catch (error) { if (writing) pending--; throw error; }
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  const writingXHR = new WeakMap();
  XMLHttpRequest.prototype.open = function(method) {
    writingXHR.set(this, mutates(method));
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (!writingXHR.get(this)) return send.apply(this, arguments);
    pending++;
    let completed = false;
    const done = () => { if (!completed) { completed = true; pending--; } };
    this.addEventListener('loadend', done, { once: true });
    try { return send.apply(this, arguments); } catch (error) { done(); throw error; }
  };
  for (const type of ['keydown', 'beforeinput', 'paste', 'cut', 'drop', 'click', 'pointerdown', 'submit']) {
    document.addEventListener(type, event => {
      if (locked) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  }
  window.KizunaUpdateGuard = {
    prepare() {
      if (pending) return 'Дождитесь сохранения записи и нажмите «Продолжить обновление».';
      const state = { reason: null, savedEditors: [], block(reason) { this.reason ||= reason; } };
      window.dispatchEvent(new CustomEvent('kizuna:before-update', { detail: state }));
      if (state.reason) return state.reason;
      for (const [el, before] of changed) {
        if (state.savedEditors.some(saved => saved === el || saved.contains(el))) {
          changed.delete(el); baseline.set(el, value(el)); continue;
        }
        if (!el.isConnected || value(el) === before || (isDraft(el) && empty(el))) { changed.delete(el); continue; }
        return 'Сохраните запись или завершите редактирование, затем продолжите обновление.';
      }
      // Also protect a draft restored by the website without an input event.
      const capture = document.querySelector('#capture-input');
      if (capture && !empty(capture)) return 'Сохраните или очистите новую запись, затем продолжите обновление.';
      locked = true;
      return null;
    },
    resume() { locked = false; }
  };
})();
