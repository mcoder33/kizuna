import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const context = new AsyncLocalStorage();
const databaseAudits = new WeakMap();
export const registerDatabaseAudit = (db, audit) => databaseAudits.set(db, audit);
export const reportDatabaseEvent = (db, event) => { try { databaseAudits.get(db)?.(event); } catch {} };
export const validTraceId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const traceContext = () => context.getStore() || {};
export const withTrace = (fields, run) => context.run({ ...traceContext(), ...fields }, run);
export const newTrace = (fields = {}) => ({ flowId: crypto.randomUUID(), ...fields });
export function jobTrace(userId, source) {
  const current = traceContext();
  const trace = newTrace({ userId, source });
  for (const key of ['flowId','requestId','browserSessionId','pageId','surface']) if (current[key]) trace[key] = current[key];
  return trace;
}
const safeTag = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/@ -]{1,120}$/.test(value) ? value : undefined;
const ids = new Set(['requestId','flowId','browserSessionId','pageId','userId','captureId','jobId','retryOfId','projectionId','accountId','attachmentId','parentId','columnId']);
const tags = new Set(['event','level','result','source','surface','provider','usedProvider','requestedProvider','model','operation','stage','state','reason','fallbackReason','errorCode','errorName','method','route','action','field','view','kind','phase','scope','status','preset','role','queryId']);
const numbers = new Set(['durationMs','queueWaitMs','totalMs','statusCode','attempt','attemptCount','inputChars','outputChars','bytes','count','changed','events','files','messages','rowCount','seq','line','column','inputCount','pasteCount','editCount','ageMs','inputTokens','outputTokens','costUsd','rssBytes','heapBytes','cpuPercent','eventLoopP95Ms','eventLoopMaxMs','eventLoopUtilization','pendingJobs','runningJobs','expiredLeases','failedJobs','oldestPendingMs','freeBytes','logBytes','queuedBytes','droppedEvents','writeFailures','accepted','rejected','longTaskMs','lcpMs','navigationMs','interactionMs','partCount']);
const booleans = new Set(['slow','replayed','existing','retry','completed','unclassified','hasSchedule','hasRepeat','hasProjects','hasAssignee','aborted','reclaimed','partial','lowDisk']);
const arrays = new Set(['fields','stackFrames']);

// An allowlist is intentional: provider errors, URLs, headers, text and settings
// values can contain credentials or personal content. They never reach the sink.
export function safeEvent(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (ids.has(key) && validTraceId(value)) output[key] = value;
    else if (tags.has(key)) { const safe = safeTag(value); if (safe) output[key] = safe; else if (key === 'errorCode' && Number.isInteger(value)) output[key] = String(value); }
    else if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) output[key] = Math.round(value * 1000) / 1000;
    else if (booleans.has(key) && typeof value === 'boolean') output[key] = value;
    else if (arrays.has(key) && Array.isArray(value)) output[key] = value.filter(v => typeof v === 'string' && /^[a-zA-Z0-9_.:/@ -]{1,120}$/.test(v)).slice(0, 24);
    else if (key === 'clientAt' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value))) output.clientAt = value;
  }
  output.event ||= 'unknown_event';
  output.level ||= output.result === 'aborted' || output.reason === 'aborted' ? 'info' : /failed|error|fatal/.test(output.event) || output.result === 'failed' ? 'error' : output.slow || output.fallbackReason || /fallback|missed|lost|dropped|abandoned/.test(output.event) ? 'warn' : 'info';
  return output;
}

export function errorFields(error) {
  return {
    errorCode: safeTag(error?.code) || (Number.isInteger(error?.status) ? String(error.status) : 'unavailable'),
    errorName: safeTag(error?.name) || 'Error',
    stackFrames: String(error?.stack || '').split('\n').slice(1, 9).map(line => line.match(/([A-Za-z0-9_.-]+\.(?:js|mjs|cjs)):(\d+):(\d+)/)?.[0]).filter(Boolean),
  };
}

export function contextualAudit(sink = () => {}) {
  return event => { try { sink(safeEvent({ ...traceContext(), ...event })); } catch {} };
}

export async function span(audit, operation, run, fields = {}, { slowMs = 1000 } = {}) {
  if (!traceContext().flowId) return withTrace(newTrace({ source: operation.split('.')[0] }), () => span(audit, operation, run, fields, { slowMs }));
  const started = performance.now();
  audit({ event: 'operation_started', operation, ...fields });
  try {
    const result = await run();
    const durationMs = performance.now() - started;
    const fallbackReason = result?.fallbackReason || null;
    const failed = Boolean(result?.error) || result?.failed > 0;
    audit({ event: 'operation_finished', operation, ...fields, durationMs, slow: durationMs >= slowMs, result: failed ? 'failed' : fallbackReason ? 'degraded' : 'succeeded',
      ...(typeof result?.error === 'string' ? {errorCode: result.error} : {}), fallbackReason, usedProvider: result?.usedProvider, model: result?.model });
    return result;
  } catch (error) {
    audit({ event: 'operation_failed', operation, ...fields, result: error?.name === 'AbortError' || error?.code === 'aborted' ? 'aborted' : 'failed', durationMs: performance.now() - started, ...errorFields(error) });
    throw error;
  }
}

export function observeService(service, audit, methods, component) {
  return new Proxy(service, { get(target, key) {
    const member = Reflect.get(target, key);
    if (typeof member !== 'function') return member;
    if (!methods.includes(key)) return member.bind(target);
    return (...args) => span(audit, `${component}.${key}`, () => member.apply(target, args));
  } });
}

export function observeFetch(fetch, audit, dependency) {
  return async (...args) => {
    const started = performance.now();
    // Only a fixed dependency name and HTTP method are recorded; never the URL.
    const method = args[1]?.method || args[0]?.method || 'GET';
    try {
      const response = await fetch(...args);
      const durationMs = performance.now() - started;
      audit({ event: 'dependency_response', operation: dependency, method, statusCode: response.status, durationMs,
        slow: durationMs > (dependency === 'telegram' ? 65000 : 2000), result: response.ok ? 'succeeded' : 'failed' });
      return response;
    } catch (error) {
      audit({ event: 'dependency_failed', operation: dependency, method, durationMs: performance.now() - started, ...errorFields(error) });
      throw error;
    }
  };
}

const editableFields = new Set(['raw','title','body','summary','type','primaryType','completed','schedule','date','time','end','repeat','project','projects','people','tags','flags','priority','followUp','assigneeId','circleId','columnId','index','parentId','provider','model','occurrence','patch','theme','locale','requestedTimeZone','remindDefault','remindHour','quietHours','notifyPrefs']);
function requestMetadata(req, payload) {
  const body = req.body && !Buffer.isBuffer(req.body) ? req.body : {};
  const patch = body.patch && typeof body.patch === 'object' ? body.patch : body;
  const fields = Object.keys(patch).filter(key => editableFields.has(key));
  if (patch.schedule && typeof patch.schedule === 'object') fields.push(...Object.keys(patch.schedule).filter(key => editableFields.has(key)).map(key => `schedule.${key}`));
  const data = { fields, inputChars: typeof body.raw === 'string' ? body.raw.length : undefined,
    replayed: payload?.replayed, changed: payload?.changed, state: payload?.state, stage: payload?.stage,
    usedProvider: payload?.provenance?.usedProvider, model: payload?.provenance?.model,
    fallbackReason: payload?.provenance?.fallbackReason || (payload?.spend?.allowed === false ? 'spend_limit' : undefined) };
  for (const key of ['captureId','jobId','projectionId','parentId','columnId']) if (validTraceId(payload?.[key] || body[key])) data[key] = payload?.[key] || body[key];
  if (validTraceId(payload?.entry?.id)) data.captureId = payload.entry.id;
  const route = req.route?.path || '';
  if (validTraceId(req.params?.id)) {
    if (route.startsWith('/api/captures')) data.captureId ||= req.params.id;
    if (route.startsWith('/api/jobs')) data.jobId ||= req.params.id;
    if (route.startsWith('/api/projections')) data.projectionId ||= req.params.id;
  }
  const classification = payload?.entry?.interpretation?.classification;
  if (classification) Object.assign(data, classificationFields(classification));
  return data;
}
export function classificationFields(classification = {}) {
  return { completed: Boolean(classification.completed), unclassified: Boolean(classification.unclassified),
    hasSchedule: Boolean(classification.entities?.schedule?.date), hasRepeat: Boolean(classification.entities?.schedule?.repeat),
    hasProjects: Boolean(classification.entities?.projects?.length), partCount: classification.actions?.length || 0 };
}

export function requestTracing(audit, { slowMs = 1000 } = {}) {
  return (req, res, next) => {
    const started = performance.now();
    const surface = ['web','mac_webview','mac_native'].includes(req.get('X-Kizuna-Surface')) ? req.get('X-Kizuna-Surface') : 'api';
    const trace = newTrace({ requestId: crypto.randomUUID(), surface });
    for (const [key, header] of [['flowId','X-Kizuna-Flow-Id'],['browserSessionId','X-Kizuna-Session-Id'],['pageId','X-Kizuna-Page-Id']]) if (validTraceId(req.get(header))) trace[key] = req.get(header);
    res.set('X-Request-Id', trace.requestId);
    res.set('X-Kizuna-Flow-Id', trace.flowId);
    let payload; let finished = false;
    const json = res.json.bind(res);
    res.json = value => { payload = value; return json(value); };
    const report = aborted => {
      if (finished) return; finished = true;
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      // Static hits, SSE heartbeats and telemetry ingestion do not need access logs.
      if (route === '/api/telemetry' || (!req.path.startsWith('/api/') && res.statusCode < 400) || req.path.startsWith('/public/')) return;
      const durationMs = performance.now() - started;
      withTrace({ ...trace, userId: req.user?.id }, () => audit({ event: route === '/api/events' ? 'stream_closed' : 'http_request', route, method: req.method,
        statusCode: res.statusCode, result: aborted ? 'aborted' : res.statusCode >= 400 || payload?.error ? 'failed' : 'succeeded', aborted,
        durationMs, slow: route !== '/api/events' && durationMs >= slowMs,
        ...(res.statusCode >= 400 && res.statusCode < 500 ? {level:'warn'} : {}), errorCode: typeof payload?.error === 'string' ? payload.error : payload?.error?.code,
        ...requestMetadata(req, payload) }));
    };
    res.once('finish', () => report(false));
    res.once('close', () => report(!res.writableFinished));
    withTrace(trace, () => {
      if (req.path.startsWith('/api/') && !['/api/telemetry','/api/events'].includes(req.path)) audit({ event: 'http_started', route: 'api', method: req.method });
      next();
    });
  };
}

export function attachActor(req, res, next) { const current = context.getStore(); if (current) current.userId = req.user?.id; next(); }

export function observeDatabase(db, audit, { slowMs = 50 } = {}) {
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    const queryId = crypto.createHash('sha256').update(String(sql)).digest('hex').slice(0, 16);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (!['get','all','run'].includes(key)) return value.bind(target);
      return (...args) => {
        const started = performance.now();
        try {
          const result = value.apply(target, args); const durationMs = performance.now() - started;
          if (durationMs >= slowMs) audit({ event: 'database_slow', operation: `sqlite.${key}`, queryId, durationMs, slow: true });
          return result;
        } catch (error) { audit({ event: 'database_failed', operation: `sqlite.${key}`, queryId, durationMs: performance.now() - started, ...errorFields(error) }); throw error; }
      };
    } });
  };
}

export function startRuntimeMonitor({ audit, db, store, intervalMs = 30000 }) {
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let lastCpu = process.cpuUsage(); let lastAt = performance.now(); let lastElu = performance.eventLoopUtilization();
  let lastDropped = 0, lastWriteFailures = 0;
  const sample = () => withTrace(newTrace({ source: 'runtime' }), () => {
    try {
      const current = performance.now(); const cpu = process.cpuUsage(); const elu = performance.eventLoopUtilization();
      const cpuPercent = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / ((current - lastAt) * 1000) * 100;
      const eventLoopUtilization = performance.eventLoopUtilization(elu, lastElu).utilization;
      lastCpu = cpu; lastAt = current; lastElu = elu;
      const queue = db.prepare(`SELECT SUM(state='pending') pendingJobs, SUM(state='running') runningJobs,
        SUM(state='running' AND lease_expires_at <= ?) expiredLeases, MIN(CASE WHEN state='pending' THEN created_at END) oldest FROM capture_jobs WHERE state IN ('pending','running')`).get(new Date().toISOString());
      const memory = process.memoryUsage(); const eventLoopP95Ms = delay.percentile(95) / 1e6; const eventLoopMaxMs = delay.max / 1e6;
      const oldestPendingMs = queue.oldest ? Math.max(0, Date.now() - Date.parse(queue.oldest)) : 0;
      const stats = store?.status?.() || {};
      const newLosses = stats.droppedEvents > lastDropped || stats.writeFailures > lastWriteFailures;
      lastDropped = stats.droppedEvents || 0; lastWriteFailures = stats.writeFailures || 0;
      audit({ event: 'runtime_health', rssBytes: memory.rss, heapBytes: memory.heapUsed, cpuPercent, eventLoopUtilization,
        eventLoopP95Ms, eventLoopMaxMs, pendingJobs: queue.pendingJobs || 0, runningJobs: queue.runningJobs || 0, expiredLeases: queue.expiredLeases || 0, oldestPendingMs,
        ...stats, slow: Boolean(eventLoopMaxMs > 200 || oldestPendingMs > 60000 || queue.expiredLeases || stats.lowDisk || newLosses) });
      delay.reset();
    } catch (error) { audit({ event: 'runtime_monitor_failed', ...errorFields(error) }); }
  });
  const timer = setInterval(sample, intervalMs); timer.unref();
  return { sample, stop: () => { clearInterval(timer); delay.disable(); } };
}
