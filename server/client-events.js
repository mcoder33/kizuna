import { safeEvent, validTraceId } from './observability.js';

export const CLIENT_EVENTS = new Set(['page_opened','navigation','ui_action','capture_focused','capture_input','capture_pasted','capture_abandoned',
  'capture_submit','capture_accepted','capture_submit_failed','capture_job_observed','capture_result_visible','capture_result_failed','capture_poll_failed',
  'card_opened','bootstrap_finished','bootstrap_failed','stream_connected','stream_disconnected','client_error','client_rejection',
  'client_request','client_request_failed','web_performance','telemetry_dropped','native_opened','native_input','native_submit','native_accepted','native_failed','native_abandoned']);
const allowedTags = {
  surface: new Set(['web','mac_webview','mac_native']),
  view: new Set(['today','board','calendar','notes','done','settings','guide','admin','feedback','login','other']),
  action: new Set(['submit','cancel','retry','open','close','complete','undo','delete','restore','move','expand','format','mention','link','parameter','navigate']),
  field: new Set(['summary','schedule','date','time','repeat','project','people','priority','completed','body','raw']),
  state: new Set(['pending','running','succeeded','failed','cancelled']),
  method: new Set(['GET','POST','PUT','PATCH','DELETE']),
  errorName: new Set(['Error','TypeError','ReferenceError','SyntaxError','RangeError','AbortError','NetworkError','UnknownError']),
  reason: new Set(['network','http','aborted','invalid_response','login','account_changed','unconfirmed','other']),
};
const allowedNumbers = new Set(['seq','durationMs','totalMs','inputChars','inputCount','pasteCount','editCount','statusCode','line','column','count','longTaskMs','lcpMs','navigationMs','interactionMs']);
const allowedIds = new Set(['flowId','browserSessionId','pageId','requestId','captureId','jobId']);
const clientRoutes = new Set(['auth','account','captures','jobs','projections','settings','entries','board','calendar','notes','notifications','reminders','push','circles','projects','people','discussions','chat','agent','journal','memory','admin','administration','feedback','telegram','done','day','reports','ui-preferences','undo','export','reset','attachments']);

export function validateClientEvent(input) {
  if (!input || typeof input !== 'object' || !CLIENT_EVENTS.has(input.event)) return null;
  const result = { event: input.event, source: 'client' };
  for (const [key, values] of Object.entries(allowedTags)) if (values.has(input[key])) result[key] = input[key];
  for (const key of allowedIds) if (validTraceId(input[key])) result[key] = input[key];
  if (typeof input.route === 'string' && clientRoutes.has(input.route.split('/')[2]) && input.route === `/api/${input.route.split('/')[2]}`) result.route = input.route;
  for (const key of allowedNumbers) if (Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 1e9) result[key] = input[key];
  if (typeof input.clientAt === 'string' && Math.abs(Date.now() - Date.parse(input.clientAt)) < 86400000) result.clientAt = input.clientAt;
  return safeEvent(result);
}

export function mountClientEvents(app, { audit, now = () => Date.now(), maxUsers = 2000, capacity = 300, perMinute = 120 } = {}) {
  const buckets = new Map();
  app.post('/api/telemetry', (req, res) => {
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length < 1 || events.length > 40) return res.status(400).json({ error: { code: 'invalid_events', message: 'Некорректная пачка событий.' } });
    const at = now(); const userId = req.user.id;
    let bucket = buckets.get(userId);
    if (!bucket) {
      if (buckets.size >= maxUsers) buckets.delete(buckets.keys().next().value);
      bucket = { at, tokens: capacity }; buckets.set(userId, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, at - bucket.at) * perMinute / 60000); bucket.at = at;
    if (bucket.tokens < events.length) { res.set('Retry-After', '30'); return res.status(429).json({ error: { code: 'telemetry_rate_limited', message: 'Лимит событий.' } }); }
    bucket.tokens -= events.length;
    let accepted = 0;
    for (const input of events) {
      const event = validateClientEvent(input);
      if (!event) continue;
      // Actor comes from the authenticated account; client user IDs are ignored.
      audit({ ...event, userId }); accepted++;
    }
    res.status(202).json({ accepted, rejected: events.length - accepted });
  });
  return { stop: () => buckets.clear() };
}
