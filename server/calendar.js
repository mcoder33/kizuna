// Календарь: ещё один вид на ту же память плюс наложение чужих календарей.
// Свои дела и встречи — проекции записей со сроком, они не копируются никуда.
// Внешние события (Яндекс, Apple, Google) живут в отдельном кэше и не
// становятся записями: их нет в поиске, отчётах и брифе, пока человек не
// возьмёт событие в память сам. Перенос дела в сетке — это уточнение записи
// (patch.schedule), а не правка календаря; наружу события уходят только по
// явной кнопке — ActionProposal с подтверждением, как велит контракт памяти.
import crypto from 'node:crypto';
import { dateInZone, shiftDate } from './reports.js';
import { CALDAV_PRESETS, createCaldavClient } from './caldav.js';
import { createGoogleCalendarClient } from './google-calendar.js';
import { buildEvent, findJoinUrl, localDateTime, zonedToUtc } from './ics.js';

export const PROVIDERS = ['caldav', 'google'];
export const ACCOUNT_MODES = ['full', 'busy'];
export const LABEL_LIMIT = 60;
// Окно синхронизации: полтора месяца назад — чтобы «Обзор» и день видели
// прошедшие встречи, четыре месяца вперёд — чтобы месяц листался без дыр.
export const SYNC_PAST_DAYS = 45;
export const SYNC_FUTURE_DAYS = 120;
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
// Длительность по умолчанию, когда в записи нет конца: встреча — час, дело со
// временем — полчаса. В карточке это видно как «по умолчанию».
export const DEFAULT_MEETING_MINUTES = 60;
export const DEFAULT_TASK_MINUTES = 30;
const RANGE_LIMIT_DAYS = 62;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
function minutesOf(time) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); }
function timeOf(minutes) { const m = ((minutes % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

export function createCalendarService({ db, secrets, now = () => new Date(), timeZone = () => 'Europe/Samara', googleConfig = () => ({ clientId: null, clientSecret: null }), fetch = globalThis.fetch, caldav = null, google = null, audit = () => {} } = {}) {
  const caldavClient = caldav || createCaldavClient({ fetch });
  const googleClient = google || createGoogleCalendarClient({ fetch });
  const oauthStates = new Map();
  const report = event => { try { audit(event); } catch {} };

  // ── учётные записи ──
  function rowToAccount(row, { withCalendars = true } = {}) {
    const calendars = JSON.parse(row.calendars_json || '[]');
    return {
      id: row.id, provider: row.provider, preset: row.preset, label: row.label, color: row.color || null, mode: row.mode,
      serverUrl: row.server_url || null, username: row.username || null,
      calendars: withCalendars ? calendars.map(calendar => ({ id: calendar.id, name: calendar.name, color: calendar.color || null, selected: calendar.selected !== false, writable: calendar.writable !== false, primary: Boolean(calendar.primary) })) : undefined,
      syncedAt: row.synced_at || null, syncError: row.sync_error || null, createdAt: row.created_at, disabled: Boolean(row.disabled_at),
    };
  }
  function accountRow(userId, id) { return db.prepare('SELECT * FROM calendar_accounts WHERE id=? AND user_id IS ?').get(id, userId) || null; }
  function listAccounts(userId) { return db.prepare('SELECT * FROM calendar_accounts WHERE user_id IS ? ORDER BY created_at').all(userId).map(row => rowToAccount(row)); }
  function credentialsOf(row) { return secrets.open(row.credentials_enc); }
  function selectedCalendars(row) { return JSON.parse(row.calendars_json || '[]').filter(calendar => calendar.selected !== false); }

  async function addCaldavAccount({ userId, preset = 'custom', serverUrl = null, username, password, label = null }) {
    if (!CALDAV_PRESETS[preset]) return { error: 'invalid_preset' };
    const base = preset === 'custom' ? String(serverUrl || '').trim() : CALDAV_PRESETS[preset].serverUrl;
    // Только https: пароль приложения по открытому каналу — подарок соседу по
    // сети. Исключение — свой же компьютер, чтобы проверять с локальным сервером.
    if (!/^https:\/\/[^\s/]+/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base)) return { error: 'invalid_server' };
    if (typeof username !== 'string' || !username.trim() || username.length > 200) return { error: 'invalid_username' };
    if (typeof password !== 'string' || !password || password.length > 500) return { error: 'invalid_password' };
    const login = username.trim();
    let discovered;
    try { discovered = await caldavClient.discover({ serverUrl: base, username: login, password, preset }); }
    catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : 'unreachable', message: error.message }; }
    const id = crypto.randomUUID();
    const calendars = discovered.calendars.map(calendar => ({ id: calendar.id, url: calendar.url, name: calendar.name, color: calendar.color, selected: true, writable: true }));
    const title = validLabel(label) || `${CALDAV_PRESETS[preset].label}${preset === 'custom' ? '' : ` · ${login}`}`;
    db.prepare('INSERT INTO calendar_accounts(id,user_id,provider,preset,label,color,mode,server_url,username,credentials_enc,calendars_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, 'caldav', preset, title, null, 'full', base, login, secrets.seal({ password }), JSON.stringify(calendars), nowIso());
    report({ event: 'calendar_account_added', provider: 'caldav', preset });
    return { account: rowToAccount(accountRow(userId, id)) };
  }

  function validLabel(value) { const label = typeof value === 'string' ? value.trim() : ''; return label && label.length <= LABEL_LIMIT ? label : null; }
  function updateAccount({ userId, id, label, color, mode, calendars, disabled }) {
    const row = accountRow(userId, id);
    if (!row) return { error: 'not_found' };
    const next = {};
    if (label !== undefined) { const value = validLabel(label); if (!value) return { error: 'invalid_label' }; next.label = value; }
    if (color !== undefined) { if (color !== null && !/^#[0-9a-f]{6}$/i.test(String(color))) return { error: 'invalid_color' }; next.color = color ? String(color).toLowerCase() : null; }
    if (mode !== undefined) { if (!ACCOUNT_MODES.includes(mode)) return { error: 'invalid_mode' }; next.mode = mode; }
    if (disabled !== undefined) { if (typeof disabled !== 'boolean') return { error: 'invalid_disabled' }; next.disabled_at = disabled ? nowIso() : null; }
    if (calendars !== undefined) {
      if (!Array.isArray(calendars) || calendars.some(item => typeof item !== 'string')) return { error: 'invalid_calendars' };
      const known = JSON.parse(row.calendars_json || '[]');
      const chosen = new Set(calendars);
      next.calendars_json = JSON.stringify(known.map(calendar => ({ ...calendar, selected: chosen.has(calendar.id) })));
    }
    const keys = Object.keys(next);
    if (keys.length) db.prepare(`UPDATE calendar_accounts SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...keys.map(key => next[key]), id);
    // Снятый календарь пропадает с сетки сразу, не дожидаясь синхронизации.
    if (next.calendars_json) {
      const keep = JSON.parse(next.calendars_json).filter(calendar => calendar.selected).map(calendar => calendar.id);
      const stale = db.prepare('SELECT DISTINCT calendar_id FROM calendar_events WHERE account_id=?').all(id).map(r => r.calendar_id).filter(calendarId => !keep.includes(calendarId));
      for (const calendarId of stale) db.prepare('DELETE FROM calendar_events WHERE account_id=? AND calendar_id=?').run(id, calendarId);
    }
    return { account: rowToAccount(accountRow(userId, id)) };
  }
  function removeAccount({ userId, id }) {
    const row = accountRow(userId, id);
    if (!row) return { error: 'not_found' };
    const wipe = db.transaction(() => {
      db.prepare('DELETE FROM calendar_events WHERE account_id=?').run(id);
      db.prepare('DELETE FROM calendar_links WHERE account_id=?').run(id);
      db.prepare('DELETE FROM calendar_accounts WHERE id=?').run(id);
    });
    wipe();
    report({ event: 'calendar_account_removed', provider: row.provider });
    return { removed: true };
  }

  // ── Google: OAuth ──
  function googleReady() { const config = googleConfig(); return Boolean(config.clientId && config.clientSecret); }
  function googleStart({ userId, redirectUri }) {
    if (!googleReady()) return { error: 'google_not_configured' };
    const state = crypto.randomBytes(24).toString('base64url');
    for (const [key, value] of oauthStates) if (value.createdAt + OAUTH_STATE_TTL_MS < Date.now()) oauthStates.delete(key);
    oauthStates.set(state, { userId, redirectUri, createdAt: Date.now() });
    return { url: googleClient.authorizeUrl({ clientId: googleConfig().clientId, redirectUri, state }) };
  }
  async function googleFinish({ state, code, userId }) {
    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || pending.userId !== userId || pending.createdAt + OAUTH_STATE_TTL_MS < Date.now()) return { error: 'invalid_state' };
    if (typeof code !== 'string' || !code) return { error: 'invalid_code' };
    const { clientId, clientSecret } = googleConfig();
    let tokens, calendars;
    try {
      tokens = await googleClient.exchangeCode({ clientId, clientSecret, redirectUri: pending.redirectUri, code });
      calendars = await googleClient.listCalendars({ accessToken: tokens.accessToken });
    } catch (error) { return { error: 'google_error', message: error.message }; }
    const primary = calendars.find(calendar => calendar.primary);
    const id = crypto.randomUUID();
    const stored = calendars.map(calendar => ({ id: calendar.id, name: calendar.name, color: calendar.color, selected: calendar.selected, writable: calendar.writable, primary: calendar.primary }));
    db.prepare('INSERT INTO calendar_accounts(id,user_id,provider,preset,label,color,mode,server_url,username,credentials_enc,calendars_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, 'google', 'google', `Google${primary ? ` · ${primary.id}` : ''}`, null, 'full', null, primary?.id || null, secrets.seal(tokens), JSON.stringify(stored), nowIso());
    report({ event: 'calendar_account_added', provider: 'google' });
    return { account: rowToAccount(accountRow(userId, id)) };
  }
  async function googleAccessToken(row) {
    const creds = credentialsOf(row);
    if (!creds?.refreshToken) throw Object.assign(new Error('Google: нет токена обновления, подключите календарь заново.'), { code: 'unauthorized' });
    if (creds.accessToken && creds.expiresAt && creds.expiresAt > Date.now() + 60000) return creds.accessToken;
    const { clientId, clientSecret } = googleConfig();
    const refreshed = await googleClient.refreshAccessToken({ clientId, clientSecret, refreshToken: creds.refreshToken });
    db.prepare('UPDATE calendar_accounts SET credentials_enc=? WHERE id=?').run(secrets.seal({ ...creds, ...refreshed }), row.id);
    return refreshed.accessToken;
  }

  // ── синхронизация ──
  function syncWindow(at = now()) {
    return { from: new Date(at.getTime() - SYNC_PAST_DAYS * 86400000), to: new Date(at.getTime() + SYNC_FUTURE_DAYS * 86400000) };
  }
  async function fetchAccountEvents(row, window) {
    const calendars = selectedCalendars(row);
    const out = [];
    if (row.provider === 'caldav') {
      const creds = credentialsOf(row);
      if (!creds?.password) throw Object.assign(new Error('Пароль не расшифровался: подключите календарь заново.'), { code: 'unauthorized' });
      for (const calendar of calendars) {
        const events = await caldavClient.listEvents({ calendarUrl: calendar.url || calendar.id, username: row.username, password: creds.password, from: window.from, to: window.to, timeZone: timeZone() });
        for (const event of events) out.push({ calendarId: calendar.id, ...event });
      }
    } else if (row.provider === 'google') {
      const accessToken = await googleAccessToken(row);
      for (const calendar of calendars) {
        const events = await googleClient.listEvents({ accessToken, calendarId: calendar.id, from: window.from, to: window.to });
        for (const event of events) out.push({ calendarId: calendar.id, ...event });
      }
    }
    return out.filter(event => !event.cancelled);
  }
  // Кэш окна переписывается целиком: одна учётная запись, сотни событий — диф
  // не окупается, а «пропало у них — пропало у нас» получается само.
  function storeEvents(row, window, events) {
    const insert = db.prepare('INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,description,location,start_at,end_at,all_day,busy,join_url,etag,href,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const at = nowIso();
    const apply = db.transaction(() => {
      db.prepare('DELETE FROM calendar_events WHERE account_id=? AND end_at>? AND start_at<?').run(row.id, window.from.toISOString(), window.to.toISOString());
      db.prepare('DELETE FROM calendar_events WHERE account_id=? AND end_at<=?').run(row.id, window.from.toISOString());
      for (const event of events) {
        insert.run(crypto.randomUUID(), row.id, event.calendarId, event.uid, event.instanceKey || null, event.title, event.description || null, event.location || null, event.start.toISOString(), event.end.toISOString(), event.allDay ? 1 : 0, event.busy ? 1 : 0, event.joinUrl || null, event.etag || null, event.href || null, at);
      }
      db.prepare('UPDATE calendar_accounts SET synced_at=?, sync_error=NULL WHERE id=?').run(at, row.id);
    });
    apply();
  }
  const syncing = new Set();
  async function syncAccount(id, { userId = undefined } = {}) {
    const row = userId === undefined ? db.prepare('SELECT * FROM calendar_accounts WHERE id=?').get(id) : accountRow(userId, id);
    if (!row) return { error: 'not_found' };
    if (row.disabled_at) return { account: rowToAccount(row), skipped: 'disabled' };
    if (syncing.has(id)) return { account: rowToAccount(row), skipped: 'busy' };
    syncing.add(id);
    try {
      const window = syncWindow();
      const events = await fetchAccountEvents(row, window);
      storeEvents(row, window, events);
      report({ event: 'calendar_synced', provider: row.provider, events: events.length });
      return { account: rowToAccount(db.prepare('SELECT * FROM calendar_accounts WHERE id=?').get(id)), events: events.length };
    } catch (error) {
      const message = String(error?.message || 'Синхронизация не удалась.').slice(0, 300);
      db.prepare('UPDATE calendar_accounts SET sync_error=?, synced_at=? WHERE id=?').run(message, nowIso(), id);
      report({ event: 'calendar_sync_failed', provider: row.provider, errorCode: error?.code || 'sync_error' });
      return { account: rowToAccount(db.prepare('SELECT * FROM calendar_accounts WHERE id=?').get(id)), error: error?.code === 'unauthorized' ? 'unauthorized' : 'sync_error', message };
    } finally { syncing.delete(id); }
  }
  async function syncDue({ intervalMs = SYNC_INTERVAL_MS } = {}) {
    const threshold = new Date(now().getTime() - intervalMs).toISOString();
    const due = db.prepare('SELECT id FROM calendar_accounts WHERE disabled_at IS NULL AND (synced_at IS NULL OR synced_at<?) ORDER BY synced_at').all(threshold);
    const results = [];
    for (const row of due) results.push(await syncAccount(row.id));
    return results;
  }

  // ── вид: свои дела и встречи + чужие события ──
  function completionMap() {
    const map = new Map();
    for (const row of db.prepare("SELECT projection_id, event_type FROM ledger_events WHERE projection_id IS NOT NULL AND event_type IN ('completed','completion_undone') ORDER BY rowid").iterate()) map.set(row.projection_id, row.event_type === 'completed');
    return map;
  }
  function ownItems({ userId, from, to, today }) {
    const rows = db.prepare(`SELECT c.id, c.raw, c.created_at, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
      WHERE c.deleted_at IS NULL AND c.user_id IS ? AND json_extract(i.classification_json,'$.primaryType') IN ('task','meeting_event')
        AND json_extract(i.classification_json,'$.completed') IS NOT 1
        AND json_extract(i.classification_json,'$.entities.schedule.date') IS NOT NULL
        AND (json_extract(i.classification_json,'$.entities.schedule.date') BETWEEN ? AND ? OR json_extract(i.classification_json,'$.entities.schedule.date') < ?)
      ORDER BY json_extract(i.classification_json,'$.entities.schedule.date'), json_extract(i.classification_json,'$.entities.schedule.time') IS NULL, json_extract(i.classification_json,'$.entities.schedule.time'), c.created_at LIMIT 800`).all(userId, from, to, today);
    const projections = new Map();
    for (const row of db.prepare(`SELECT p.id, p.capture_id FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.status='active' AND c.deleted_at IS NULL AND c.user_id IS ? AND p.projection_type IN ('task','meeting_event')`).all(userId)) {
      if (!projections.has(row.capture_id)) projections.set(row.capture_id, []);
      projections.get(row.capture_id).push(row.id);
    }
    const completion = completionMap();
    const links = new Map();
    for (const row of db.prepare('SELECT l.capture_id, l.account_id, l.calendar_id, l.href FROM calendar_links l JOIN calendar_accounts a ON a.id=l.account_id WHERE a.user_id IS ?').all(userId)) {
      if (!links.has(row.capture_id)) links.set(row.capture_id, []);
      links.get(row.capture_id).push({ accountId: row.account_id, calendarId: row.calendar_id, href: row.href });
    }
    const items = [], overdue = [];
    for (const row of rows) {
      const ids = projections.get(row.id) || [];
      if (!ids.length) continue;
      const c = JSON.parse(row.classification_json);
      const schedule = c.entities?.schedule || {};
      const done = ids.every(id => completion.get(id) === true);
      const inRange = schedule.date >= from && schedule.date <= to;
      if (!inRange && (done || schedule.date >= today)) continue;
      const item = {
        id: row.id, kind: c.primaryType === 'meeting_event' ? 'meeting' : 'task',
        title: (c.summary || '').split('\n')[0] || row.raw.split('\n')[0],
        date: schedule.date, time: schedule.time || null, end: schedule.end || null, allDay: !schedule.time,
        done, project: c.entities?.projects?.[0] || null, projects: c.entities?.projects || [], people: c.entities?.people || [],
        tags: c.tags || [], priority: c.priority || null, joinUrl: findJoinUrl(row.raw), projectionIds: ids,
        exports: links.get(row.id) || [], overdue: !done && schedule.date < today,
      };
      if (inRange) items.push(item);
      else overdue.push(item);
    }
    return { items, overdue };
  }
  function externalItems({ userId, from, to }) {
    const zone = timeZone();
    const fromUtc = zonedToUtc({ year: Number(from.slice(0, 4)), month: Number(from.slice(5, 7)), day: Number(from.slice(8, 10)) }, zone);
    const toUtc = zonedToUtc({ year: Number(to.slice(0, 4)), month: Number(to.slice(5, 7)), day: Number(to.slice(8, 10)) + 1 }, zone);
    const rows = db.prepare(`SELECT e.*, a.mode, a.label account_label, a.color account_color, a.calendars_json FROM calendar_events e JOIN calendar_accounts a ON a.id=e.account_id
      WHERE a.user_id IS ? AND a.disabled_at IS NULL AND e.start_at<? AND e.end_at>? ORDER BY e.start_at LIMIT 2000`).all(userId, toUtc.toISOString(), fromUtc.toISOString());
    const out = [];
    for (const row of rows) {
      const calendar = JSON.parse(row.calendars_json || '[]').find(item => item.id === row.calendar_id) || null;
      const busyOnly = row.mode === 'busy';
      const base = {
        id: `ext:${row.id}`, kind: 'external', accountId: row.account_id, calendarId: row.calendar_id, calendarName: calendar?.name || row.account_label,
        color: row.account_color || calendar?.color || null, source: row.account_label,
        title: busyOnly ? 'Занято' : row.title, description: busyOnly ? null : row.description, location: busyOnly ? null : row.location,
        busy: Boolean(row.busy), joinUrl: busyOnly ? null : row.join_url, href: busyOnly ? null : row.href, readOnly: true,
      };
      if (row.all_day) {
        // Событие на весь день хранится датами UTC-полуночи; конец —
        // следующий день, поэтому пробегаем [start, end).
        let day = row.start_at.slice(0, 10);
        const last = row.end_at.slice(0, 10);
        let guard = 0;
        while (day < last && guard < 62) {
          if (day >= from && day <= to) out.push({ ...base, id: `${base.id}:${day}`, date: day, time: null, end: null, allDay: true, days: Math.max(1, Math.round((Date.parse(last) - Date.parse(row.start_at.slice(0, 10))) / 86400000)) });
          day = shiftDate(day, 1); guard += 1;
        }
        continue;
      }
      const start = localDateTime(new Date(row.start_at), zone), end = localDateTime(new Date(row.end_at), zone);
      out.push({ ...base, date: start.date, time: start.time, end: end.date === start.date ? end.time : '23:59', endDate: end.date, allDay: false });
    }
    return out;
  }
  function view({ userId, from, to }) {
    if (!validDate(from) || !validDate(to) || from > to) return { error: 'invalid_range' };
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
    if (spanDays > RANGE_LIMIT_DAYS) return { error: 'range_too_wide' };
    const today = dateInZone(now(), timeZone());
    const own = ownItems({ userId, from, to, today });
    return {
      from, to, today, timeZone: timeZone(),
      defaults: { meetingMinutes: DEFAULT_MEETING_MINUTES, taskMinutes: DEFAULT_TASK_MINUTES },
      items: own.items, overdue: own.overdue, external: externalItems({ userId, from, to }),
      accounts: listAccounts(userId).map(account => ({ id: account.id, label: account.label, provider: account.provider, color: account.color, mode: account.mode, disabled: account.disabled, syncedAt: account.syncedAt, syncError: account.syncError, calendars: account.calendars.filter(calendar => calendar.selected).map(calendar => ({ id: calendar.id, name: calendar.name, color: calendar.color, writable: calendar.writable })) })),
      googleReady: googleReady(),
    };
  }

  // ── наружу: встреча из записи во внешний календарь ──
  function eventFromCapture(captureRow, tz) {
    const c = JSON.parse(captureRow.classification_json);
    const schedule = c.entities?.schedule;
    if (!schedule?.date) return null;
    const title = (c.summary || '').split('\n')[0] || captureRow.raw.split('\n')[0];
    const description = `${captureRow.raw.trim().slice(0, 1500)}\n\n— из Кизуны`;
    const [year, month, day] = schedule.date.split('-').map(Number);
    if (!schedule.time) {
      const next = shiftDate(schedule.date, 1);
      return { title, description, allDay: true, startDate: schedule.date, endDate: next, start: { year, month, day }, end: { year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)), day: Number(next.slice(8, 10)) } };
    }
    const startMinutes = minutesOf(schedule.time);
    const endMinutes = schedule.end && minutesOf(schedule.end) > startMinutes ? minutesOf(schedule.end) : startMinutes + (c.primaryType === 'meeting_event' ? DEFAULT_MEETING_MINUTES : DEFAULT_TASK_MINUTES);
    const start = zonedToUtc({ year, month, day, hour: Math.floor(startMinutes / 60), minute: startMinutes % 60 }, tz);
    const end = new Date(start.getTime() + (endMinutes - startMinutes) * 60000);
    return { title, description, allDay: false, start, end };
  }
  async function exportCapture({ userId, captureId, accountId, calendarId }) {
    const capture = db.prepare(`SELECT c.id, c.raw, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.id=? AND c.deleted_at IS NULL AND c.user_id IS ?`).get(captureId, userId);
    if (!capture) return { error: 'capture_not_found' };
    const row = accountRow(userId, accountId);
    if (!row || row.disabled_at) return { error: 'account_not_found' };
    const calendar = JSON.parse(row.calendars_json || '[]').find(item => item.id === calendarId);
    if (!calendar || calendar.writable === false) return { error: 'calendar_not_found' };
    if (db.prepare('SELECT 1 FROM calendar_links WHERE capture_id=? AND account_id=?').get(captureId, accountId)) return { error: 'already_exported' };
    const event = eventFromCapture(capture, timeZone());
    if (!event) return { error: 'no_schedule' };
    const uid = `kizuna-${captureId}@kizuna`;
    let stored;
    try {
      if (row.provider === 'caldav') {
        const creds = credentialsOf(row);
        const ics = buildEvent({ uid, title: event.title, description: event.description, start: event.start, end: event.end, allDay: event.allDay, now: now() });
        const put = await caldavClient.putEvent({ calendarUrl: calendar.url || calendar.id, username: row.username, password: creds?.password || '', uid, ics });
        stored = { uid, href: put.href, etag: put.etag };
      } else {
        const accessToken = await googleAccessToken(row);
        const inserted = await googleClient.insertEvent({ accessToken, calendarId, event: { ...event, captureId } });
        stored = { uid: inserted.id, href: inserted.href, etag: inserted.etag };
      }
    } catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : 'export_failed', message: error.message }; }
    db.prepare('INSERT INTO calendar_links(capture_id,account_id,calendar_id,uid,href,etag,created_at) VALUES(?,?,?,?,?,?,?)').run(captureId, accountId, calendarId, stored.uid, stored.href, stored.etag, nowIso());
    report({ event: 'calendar_event_exported', provider: row.provider });
    // Своё событие тут же попадает в кэш: иначе до следующей синхронизации в
    // сетке его не видно, и кажется, что ничего не произошло.
    syncAccount(accountId).catch(() => {});
    return { link: { accountId, calendarId, href: stored.href } };
  }
  async function removeExport({ userId, captureId, accountId }) {
    const link = db.prepare('SELECT l.* FROM calendar_links l JOIN calendar_accounts a ON a.id=l.account_id WHERE l.capture_id=? AND l.account_id=? AND a.user_id IS ?').get(captureId, accountId, userId);
    if (!link) return { error: 'not_found' };
    const row = accountRow(userId, accountId);
    try {
      if (row.provider === 'caldav') await caldavClient.deleteEvent({ href: link.href, username: row.username, password: credentialsOf(row)?.password || '' });
      else await googleClient.deleteEvent({ accessToken: await googleAccessToken(row), calendarId: link.calendar_id, eventId: link.uid });
    } catch (error) { return { error: 'remove_failed', message: error.message }; }
    db.prepare('DELETE FROM calendar_links WHERE capture_id=? AND account_id=?').run(captureId, accountId);
    db.prepare('DELETE FROM calendar_events WHERE account_id=? AND uid=?').run(accountId, link.uid);
    return { removed: true };
  }

  return { listAccounts, addCaldavAccount, updateAccount, removeAccount, googleReady, googleStart, googleFinish, syncAccount, syncDue, view, exportCapture, removeExport, presets: Object.fromEntries(Object.entries(CALDAV_PRESETS).map(([key, preset]) => [key, { label: preset.label, serverUrl: preset.serverUrl }])) };
}

// Фоновая синхронизация: раз в минуту смотрит, у кого прошло пять минут с
// последнего обхода. Один поток, без гонок — учётных записей у одного
// человека две-три, календарей — десяток.
export class CalendarSyncWorker {
  constructor({ service, pollMs = 60_000, intervalMs = SYNC_INTERVAL_MS, audit = () => {} }) {
    this.service = service; this.pollMs = pollMs; this.intervalMs = intervalMs; this.audit = audit;
    this.timer = null; this.running = false; this.inFlight = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => { this.inFlight = this.service.syncDue({ intervalMs: this.intervalMs }).catch(error => { try { this.audit({ event: 'calendar_sync_failed', errorCode: error?.code || 'sync_error' }); } catch {} }).finally(() => { this.inFlight = null; }); };
    this.timer = setInterval(tick, this.pollMs);
    this.timer.unref?.();
    setTimeout(tick, 1500).unref?.();
  }
  async stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.inFlight) await Promise.race([this.inFlight, new Promise(resolve => setTimeout(resolve, 3000).unref?.())]);
  }
}

// Ручной перенос из сетки: дата, время и конец собираются в patch.schedule.
// Конец без начала не имеет смысла, конец раньше начала — тоже.
export function scheduleFromDrop({ date, time = null, end = null }) {
  if (!validDate(date)) return null;
  if (time !== null && !/^\d{2}:\d{2}$/.test(time)) return null;
  if (end !== null && (!time || !/^\d{2}:\d{2}$/.test(end) || minutesOf(end) <= minutesOf(time))) return null;
  return { date, time, ...(end ? { end } : {}) };
}
export { timeOf };
