(() => {
  'use strict';
  if (window.KizunaTelemetry) return;
  const originalFetch = window.fetch.bind(window);
  const uuid = () => crypto.randomUUID();
  let browserSessionId;
  try { browserSessionId = sessionStorage.getItem('kizuna.telemetry.session') || uuid(); sessionStorage.setItem('kizuna.telemetry.session', browserSessionId); } catch { browserSessionId = uuid(); }
  const pageId = uuid();
  const surface = window.webkit?.messageHandlers ? 'mac_webview' : 'web';
  const views = new Set(['today','board','calendar','notes','done','settings','guide','admin','feedback','login']);
  const view = () => location.pathname === '/login' ? 'login' : views.has(location.hash.slice(1).split(/[/?]/)[0]) ? location.hash.slice(1).split(/[/?]/)[0] : 'today';
  let enabled = Boolean(document.documentElement.dataset.accountId), sending = null, queue = [], seq = 0, dropped = 0;
  let draft = null, inputTimer = null;
  function emit(event, fields = {}) {
    const item = { event, browserSessionId, pageId, surface, view: view(), seq: ++seq, clientAt: new Date().toISOString(), ...fields };
    if (queue.length >= 80) { queue.shift(); dropped++; }
    queue.push(item);
  }
  async function flush() {
    if (!enabled || sending || !queue.length || !navigator.onLine) return sending;
    if (dropped) { emit('telemetry_dropped', { count: dropped }); dropped = 0; }
    const batch = queue.splice(0, 40);
    sending = originalFetch('/api/telemetry', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) })
      .then(response => {
        if (response.status === 401 || response.status === 403) { enabled = false; queue = []; return; }
        if (!response.ok) throw new Error('telemetry_unavailable');
      }).catch(() => {
        queue.unshift(...batch);
        if (queue.length > 80) { dropped += queue.length - 80; queue.splice(0, queue.length - 80); }
      }).finally(() => { sending = null; });
    return sending;
  }
  function ensureDraft() {
    return draft ||= { flowId: uuid(), startedAt: performance.now(), inputCount: 0, pasteCount: 0, editCount: 0, inputChars: 0 };
  }
  function draftSnapshot() {
    const current = ensureDraft();
    return { flowId: current.flowId, inputCount: current.inputCount, pasteCount: current.pasteCount, editCount: current.editCount, inputChars: current.inputChars, durationMs: performance.now() - current.startedAt };
  }
  function recordInput() { if (draft) emit('capture_input', draftSnapshot()); }
  function submit(inputChars) {
    clearTimeout(inputTimer); const current = ensureDraft(); current.inputChars = inputChars;
    recordInput(); emit('capture_submit', draftSnapshot());
    return { flowId: current.flowId, submittedAt: Date.now() };
  }
  function accepted(record) { emit('capture_accepted', record); draft = null; }
  function failed(record) { emit('capture_submit_failed', { ...record, reason: 'other' }); }
  function abandon() {
    clearTimeout(inputTimer);
    if (draft?.inputCount || draft?.inputChars) emit('capture_abandoned', draftSnapshot());
    draft = null;
  }
  function mark(event, fields = {}) { emit(event, fields); }
  function routeOf(url) { return '/api/' + (url.pathname.split('/')[2] || 'other'); }
  window.fetch = async (input, options = {}) => {
    let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); } catch { return originalFetch(input, options); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname === '/api/telemetry') return originalFetch(input, options);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    headers.set('X-Kizuna-Session-Id', browserSessionId); headers.set('X-Kizuna-Page-Id', pageId); headers.set('X-Kizuna-Surface', surface);
    const flowId = headers.get('X-Kizuna-Flow-Id') || uuid(); headers.set('X-Kizuna-Flow-Id', flowId);
    const started = performance.now(); const method = (options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      const response = await originalFetch(input, { ...options, headers });
      if (url.pathname === '/api/auth/login' && response.ok) { enabled = true; flush(); }
      if (response.status === 401 && !url.pathname.startsWith('/api/auth/')) enabled = false;
      emit('client_request', { route: routeOf(url), flowId, requestId: response.headers.get('X-Request-Id'), method, statusCode: response.status, durationMs: performance.now() - started });
      return response;
    } catch (error) {
      emit('client_request_failed', { route: routeOf(url), flowId, method, durationMs: performance.now() - started, reason: error?.name === 'AbortError' ? 'aborted' : 'network' });
      throw error;
    }
  };
  function isCapture(target) { return target instanceof Element && Boolean(target.closest('#capture-input')); }
  document.addEventListener('focusin', event => { if (isCapture(event.target)) emit('capture_focused', { flowId: ensureDraft().flowId }); });
  document.addEventListener('input', event => {
    if (!isCapture(event.target)) return;
    const current = ensureDraft(); current.inputCount++;
    if (/delete|history/.test(event.inputType || '')) current.editCount++;
    current.inputChars = Math.min(10000, String(event.target.value ?? event.target.textContent ?? '').length);
    clearTimeout(inputTimer); inputTimer = setTimeout(recordInput, 1200);
  });
  document.addEventListener('paste', event => { if (isCapture(event.target)) { const current = ensureDraft(); current.pasteCount++; emit('capture_pasted', { flowId: current.flowId, pasteCount: current.pasteCount }); } });
  const actions = [
    ['#capture-submit', 'submit'], ['#capture-expand', 'expand'], ['.completion-button, .board-done', 'complete'],
    ['.fmt-bar', 'format'], ['.mention-menu', 'mention'], ['.link-menu', 'link'],
    ['.card-properties, .kc-params', 'parameter'], ['[data-capture-id]', 'open'],
  ];
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    for (const [selector, action] of actions) if (event.target.closest(selector)) {
      const captureId = event.target.closest('[data-capture-id]')?.dataset.captureId;
      emit('ui_action', { action, ...(draft && isCapture(event.target) ? {flowId:draft.flowId} : {}), ...(captureId ? {captureId} : {}) }); break;
    }
  });
  window.addEventListener('hashchange', () => { emit('navigation'); flush(); });
  window.addEventListener('online', flush);
  window.addEventListener('error', event => {
    emit('client_error', { errorName: event.error?.name || 'UnknownError', line: event.lineno || 0, column: event.colno || 0, reason: 'other' }); flush();
  }, true);
  window.addEventListener('unhandledrejection', event => { emit('client_rejection', { errorName: event.reason?.name || 'UnknownError' }); flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', () => {
    abandon();
    if (enabled && queue.length) {
      const batch = queue.slice(0, 40);
      if (navigator.sendBeacon?.('/api/telemetry', new Blob([JSON.stringify({ events: batch })], { type: 'application/json' }))) queue.splice(0, batch.length);
    }
  });
  if ('PerformanceObserver' in window) {
    for (const type of ['longtask','largest-contentful-paint','event']) {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (type === 'longtask' && entry.duration >= 200) emit('web_performance', { longTaskMs: entry.duration });
            if (type === 'largest-contentful-paint') emit('web_performance', { lcpMs: entry.startTime });
            if (type === 'event' && entry.duration >= 200) emit('web_performance', { interactionMs: entry.duration });
          }
        }).observe({ type, buffered: true, ...(type === 'event' ? {durationThreshold:200} : {}) });
      } catch {}
    }
  }
  window.addEventListener('load', () => {
    enabled ||= Boolean(document.documentElement.dataset.accountId);
    const entry = performance.getEntriesByType('navigation')[0];
    if (entry) emit('web_performance', { navigationMs: entry.domContentLoadedEventEnd });
    flush();
  });
  window.KizunaTelemetry = { emit: mark, flush, submit, accepted, failed, abandon, surface, browserSessionId, pageId,
    status: () => ({ queuedEvents: queue.length, droppedEvents: dropped, enabled, sending: Boolean(sending), online: navigator.onLine }) };
  emit('page_opened'); setInterval(flush, 6000);
})();
