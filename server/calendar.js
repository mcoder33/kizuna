// Календарь: ещё один вид на ту же память плюс наложение чужих календарей.
// Свои дела и встречи — проекции записей со сроком, они не копируются никуда.
// Внешние события (Яндекс, Apple, Google) живут в отдельном кэше и не
// становятся записями: их нет в поиске, отчётах и брифе, пока человек не
// возьмёт событие в память сам. Перенос дела в сетке — это уточнение записи
// (patch.schedule), а не правка календаря. Наружу события уходят либо по
// явной кнопке, либо автоматически — когда человек один раз разрешил это в
// настройках учётной записи (режим «встречи» или «встречи и дела»): такое
// разрешение и есть подтверждение действия во внешний мир по контракту
// памяти. Чужие события можно двигать, переименовывать и удалять из сетки,
// если календарь пишущий и не в режиме «занято».
import crypto from 'node:crypto';
import { dateInZone, shiftDate } from './reports.js';
import { CALDAV_PRESETS, createCaldavClient } from './caldav.js';
import { createGoogleCalendarClient } from './google-calendar.js';
import { buildEvent, excludeInstance, findJoinUrl, localDateTime, overrideInstance, rewriteEvent, setPartstat, zonedToUtc } from './ics.js';
import { replaceInterpretation } from './db.js';
import { shouldMaterializeProjections } from './classifier.js';
import { describeRepeat, occurrenceDates, repeatRrule, normalizeSkip, scheduleDisplay } from './repeat.js';

export const PROVIDERS = ['caldav', 'google'];
export const ACCOUNT_MODES = ['full', 'busy'];
// Автоматическая отправка: выключена, только встречи, встречи и дела со сроком.
export const AUTO_EXPORT_MODES = ['off', 'meetings', 'all'];
// За один проход в одну учётную запись уходит не больше стольких правок: при
// первом включении на длинном журнале лучше догнать за несколько минут, чем
// упереться в лимиты сервера.
export const AUTO_EXPORT_BATCH = 40;
export const TITLE_LIMIT = 300;
export const RESPONSE_STATUSES = ['accepted', 'declined', 'tentative'];
export const COMMENT_LIMIT = 500;
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
const validTime = value => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) && Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;
const plainEtag = value => String(value || '').replace(/^W\//, '').replace(/"/g, '');
function minutesOf(time) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); }
function timeOf(minutes) { const m = ((minutes % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

export function createCalendarService({ db, secrets, now = () => new Date(), timeZone = () => 'Europe/Samara', googleConfig = () => ({ clientId: null, clientSecret: null }), fetch = globalThis.fetch, caldav = null, google = null, audit = () => {}, onChange = () => {}, autoExportDelayMs = 1500 } = {}) {
  const caldavClient = caldav || createCaldavClient({ fetch });
  const googleClient = google || createGoogleCalendarClient({ fetch });
  const oauthStates = new Map();
  const report = event => { try { audit(event); } catch {} };
  const changed = () => { try { onChange(); } catch {} };

  // ── учётные записи ──
  function rowToAccount(row, { withCalendars = true } = {}) {
    const calendars = JSON.parse(row.calendars_json || '[]');
    return {
      id: row.id, provider: row.provider, preset: row.preset, label: row.label, color: row.color || null, mode: row.mode,
      serverUrl: row.server_url || null, username: row.username || null,
      calendars: withCalendars ? calendars.map(calendar => ({ id: calendar.id, name: calendar.name, color: calendar.color || null, selected: calendar.selected !== false, writable: calendar.writable !== false, primary: Boolean(calendar.primary) })) : undefined,
      syncedAt: row.synced_at || null, syncError: row.sync_error || null, createdAt: row.created_at, disabled: Boolean(row.disabled_at),
      autoExport: row.auto_export || 'off', autoCalendarId: row.auto_calendar_id || null, exportError: row.export_error || null,
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
  // Календарь-приёмник для автоотправки: выбранный, иначе основной, иначе
  // первый, куда можно писать.
  function defaultTarget(calendars) { return calendars.find(calendar => calendar.primary && calendar.writable !== false) || calendars.find(calendar => calendar.writable !== false) || null; }
  function updateAccount({ userId, id, label, color, mode, calendars, disabled, autoExport, autoCalendarId }) {
    const row = accountRow(userId, id);
    if (!row) return { error: 'not_found' };
    const next = {};
    const knownCalendars = JSON.parse(row.calendars_json || '[]');
    if (autoExport !== undefined) { if (!AUTO_EXPORT_MODES.includes(autoExport)) return { error: 'invalid_auto_export' }; next.auto_export = autoExport; next.export_error = null; }
    if (autoCalendarId !== undefined) {
      if (autoCalendarId !== null && !knownCalendars.some(calendar => calendar.id === autoCalendarId && calendar.writable !== false)) return { error: 'calendar_not_found' };
      next.auto_calendar_id = autoCalendarId; next.export_error = null;
    }
    const autoMode = next.auto_export ?? row.auto_export ?? 'off';
    if (autoMode !== 'off' && !(next.auto_calendar_id ?? row.auto_calendar_id)) { const target = defaultTarget(knownCalendars); if (!target) return { error: 'calendar_not_found' }; next.auto_calendar_id = target.id; }
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
    if (autoMode !== 'off' && (next.auto_export || next.auto_calendar_id) && !(next.disabled_at ?? row.disabled_at)) wakeAutoExport();
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
    const insert = db.prepare('INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,description,location,start_at,end_at,all_day,busy,join_url,etag,href,updated_at,attendees_json,organizer_json,repeat,url,sequence,series_uid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const at = nowIso();
    const apply = db.transaction(() => {
      db.prepare('DELETE FROM calendar_events WHERE account_id=? AND end_at>? AND start_at<?').run(row.id, window.from.toISOString(), window.to.toISOString());
      db.prepare('DELETE FROM calendar_events WHERE account_id=? AND end_at<=?').run(row.id, window.from.toISOString());
      for (const event of events) {
        insert.run(crypto.randomUUID(), row.id, event.calendarId, event.uid, event.instanceKey || null, event.title, event.description || null, event.location || null, event.start.toISOString(), event.end.toISOString(), event.allDay ? 1 : 0, event.busy ? 1 : 0, event.joinUrl || null, event.etag || null, event.href || null, at,
          event.attendees?.length ? JSON.stringify(event.attendees) : null, event.organizer ? JSON.stringify(event.organizer) : null, event.repeat || null, event.url || null, event.sequence || 0, event.seriesUid || (event.instanceKey ? event.uid : null));
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
  // Взятое чужое дело стоит в сетке рядом со своими: у человека один день, а
  // не два. Запись при этом живёт у автора — сюда приходит её идентификатор.
  function ownItems({ userId, from, to, today, borrowed = [] }) {
    const mine = borrowed.length ? `(c.user_id IS ? OR c.id IN (${borrowed.map(() => '?').join(',')}))` : 'c.user_id IS ?';
    const who = [userId, ...borrowed];
    const rows = db.prepare(`SELECT c.id, c.raw, c.created_at, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
      WHERE c.deleted_at IS NULL AND ${mine} AND json_extract(i.classification_json,'$.primaryType') IN ('task','meeting_event')
        AND json_extract(i.classification_json,'$.completed') IS NOT 1
        AND json_extract(i.classification_json,'$.entities.schedule.date') IS NOT NULL
        AND (json_extract(i.classification_json,'$.entities.schedule.date') BETWEEN ? AND ? OR json_extract(i.classification_json,'$.entities.schedule.date') < ? OR json_extract(i.classification_json,'$.entities.schedule.repeat') IS NOT NULL)
      ORDER BY json_extract(i.classification_json,'$.entities.schedule.date'), json_extract(i.classification_json,'$.entities.schedule.time') IS NULL, json_extract(i.classification_json,'$.entities.schedule.time'), c.created_at LIMIT 800`).all(...who, from, to, today);
    const projections = new Map();
    for (const row of db.prepare(`SELECT p.id, p.capture_id FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.status='active' AND c.deleted_at IS NULL AND ${mine} AND p.projection_type IN ('task','meeting_event')`).all(...who)) {
      if (!projections.has(row.capture_id)) projections.set(row.capture_id, []);
      projections.get(row.capture_id).push(row.id);
    }
    const completion = completionMap();
    const links = new Map();
    for (const row of db.prepare('SELECT l.capture_id, l.account_id, l.calendar_id, l.href, l.auto FROM calendar_links l JOIN calendar_accounts a ON a.id=l.account_id WHERE a.user_id IS ?').all(userId)) {
      if (!links.has(row.capture_id)) links.set(row.capture_id, []);
      links.get(row.capture_id).push({ accountId: row.account_id, calendarId: row.calendar_id, href: row.href, auto: Boolean(row.auto) });
    }
    const items = [], overdue = [];
    for (const row of rows) {
      const ids = projections.get(row.id) || [];
      if (!ids.length) continue;
      const c = JSON.parse(row.classification_json);
      const schedule = c.entities?.schedule || {};
      const done = ids.every(id => completion.get(id) === true);
      const base = {
        id: row.id, kind: c.primaryType === 'meeting_event' ? 'meeting' : 'task',
        title: (c.summary || '').split('\n')[0] || row.raw.split('\n')[0],
        time: schedule.time || null, end: schedule.end || null, allDay: !schedule.time,
        done, project: c.entities?.projects?.[0] || null, projects: c.entities?.projects || [], people: c.entities?.people || [],
        tags: c.tags || [], priority: c.priority || null, joinUrl: findJoinUrl(row.raw), projectionIds: ids,
        exports: links.get(row.id) || [],
      };
      // Повтор — экземпляр на каждую дату окна; прошедшие экземпляры не
      // просрочка, а просто прошедшие. Закрытая серия в сетке не живёт.
      if (schedule.repeat) {
        if (done) continue;
        for (const date of occurrenceDates(schedule, from, to)) items.push({ ...base, date, overdue: false, recurring: true, repeat: describeRepeat(schedule.repeat), baseDate: schedule.date, skip: normalizeSkip(schedule.skip) });
        continue;
      }
      const inRange = schedule.date >= from && schedule.date <= to;
      if (!inRange && (done || schedule.date >= today)) continue;
      const item = { ...base, date: schedule.date, overdue: !done && schedule.date < today };
      if (inRange) items.push(item);
      else overdue.push(item);
    }
    items.sort((left, right) => left.date.localeCompare(right.date) || (left.time === null) - (right.time === null) || (left.time || '').localeCompare(right.time || ''));
    return { items, overdue };
  }
  function externalItems({ userId, from, to }) {
    const zone = timeZone();
    const fromUtc = zonedToUtc({ year: Number(from.slice(0, 4)), month: Number(from.slice(5, 7)), day: Number(from.slice(8, 10)) }, zone);
    const toUtc = zonedToUtc({ year: Number(to.slice(0, 4)), month: Number(to.slice(5, 7)), day: Number(to.slice(8, 10)) + 1 }, zone);
    // Свои же отправленные события в чужом календаре не показываются второй
    // раз: они и так на сетке как дела и встречи.
    const rows = db.prepare(`SELECT e.*, a.mode, a.provider, a.username, a.label account_label, a.color account_color, a.calendars_json FROM calendar_events e JOIN calendar_accounts a ON a.id=e.account_id
      WHERE a.user_id IS ? AND a.disabled_at IS NULL AND e.start_at<? AND e.end_at>?
        AND NOT EXISTS (SELECT 1 FROM calendar_links l WHERE l.account_id=e.account_id AND (l.uid=e.uid OR l.uid=e.series_uid))
      ORDER BY e.start_at LIMIT 2000`).all(userId, toUtc.toISOString(), fromUtc.toISOString());
    const out = [];
    for (const row of rows) {
      const calendar = JSON.parse(row.calendars_json || '[]').find(item => item.id === row.calendar_id) || null;
      const busyOnly = row.mode === 'busy';
      const editable = !busyOnly && calendar?.writable !== false;
      // В другой календарь по CalDAV переезжает только серия целиком: один
      // экземпляр отдельным файлом не живёт.
      const movable = editable && !(row.provider === 'caldav' && row.instance_key);
      const base = {
        id: `ext:${row.id}`, kind: 'external', accountId: row.account_id, calendarId: row.calendar_id, calendarName: calendar?.name || row.account_label,
        color: calendar?.color || row.account_color || null, source: row.account_label,
        title: busyOnly ? 'Занято' : row.title, description: busyOnly ? null : row.description, location: busyOnly ? null : row.location,
        busy: Boolean(row.busy), joinUrl: busyOnly ? null : row.join_url, href: busyOnly ? null : row.href, readOnly: !editable, editable, movable,
        // Ключ серии — чтобы страница знала, какие события уходят вместе с
        // ней: у CalDAV серия это один файл (uid), у Google — recurringEventId.
        recurring: Boolean(row.instance_key), seriesId: busyOnly ? null : row.series_uid || row.uid,
        ...(busyOnly ? { attendees: [], organizer: null, repeat: null, url: null, me: null } : eventPeople(row)),
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
  function view({ userId, from, to, borrowed = [] }) {
    if (!validDate(from) || !validDate(to) || from > to) return { error: 'invalid_range' };
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
    if (spanDays > RANGE_LIMIT_DAYS) return { error: 'range_too_wide' };
    const today = dateInZone(now(), timeZone());
    const own = ownItems({ userId, from, to, today, borrowed });
    return {
      from, to, today, timeZone: timeZone(),
      defaults: { meetingMinutes: DEFAULT_MEETING_MINUTES, taskMinutes: DEFAULT_TASK_MINUTES },
      items: own.items, overdue: own.overdue, external: externalItems({ userId, from, to }),
      accounts: listAccounts(userId).map(account => ({ id: account.id, label: account.label, provider: account.provider, color: account.color, mode: account.mode, disabled: account.disabled, syncedAt: account.syncedAt, syncError: account.syncError, calendars: account.calendars.filter(calendar => calendar.selected).map(calendar => ({ id: calendar.id, name: calendar.name, color: calendar.color, writable: calendar.writable })) })),
      googleReady: googleReady(),
    };
  }

  // ── наружу: дело или встреча из записи во внешний календарь ──
  function eventFromCapture(captureRow, tz) {
    const c = JSON.parse(captureRow.classification_json);
    const schedule = c.entities?.schedule;
    if (!schedule?.date) return null;
    const title = (c.summary || '').split('\n')[0] || captureRow.raw.split('\n')[0];
    const description = `${captureRow.raw.trim().slice(0, 1500)}\n\n— из Кизуны`;
    const [year, month, day] = schedule.date.split('-').map(Number);
    const wallOf = date => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
    const skip = normalizeSkip(schedule.skip);
    if (!schedule.time) {
      const next = shiftDate(schedule.date, 1);
      // Повтор на весь день: правило и убранные экземпляры — датами.
      const rrule = repeatRrule(schedule.repeat, { allDay: true });
      return { title, description, allDay: true, startDate: schedule.date, endDate: next, start: { year, month, day }, end: wallOf(next), rrule, exdates: rrule ? skip.map(wallOf) : [], timeZone: tz };
    }
    const startMinutes = minutesOf(schedule.time);
    const endMinutes = schedule.end && minutesOf(schedule.end) > startMinutes ? minutesOf(schedule.end) : startMinutes + (c.primaryType === 'meeting_event' ? DEFAULT_MEETING_MINUTES : DEFAULT_TASK_MINUTES);
    const startOf = date => zonedToUtc({ ...wallOf(date), hour: Math.floor(startMinutes / 60), minute: startMinutes % 60 }, tz);
    const start = startOf(schedule.date);
    const end = new Date(start.getTime() + (endMinutes - startMinutes) * 60000);
    // Повтор со временем: UNTIL — момент последнего возможного начала в поясе
    // журнала, убранные экземпляры — моментами их начала.
    const rrule = repeatRrule(schedule.repeat, { allDay: false, untilAt: schedule.repeat?.until ? startOf(schedule.repeat.until) : null });
    return { title, description, allDay: false, start, end, rrule, exdates: rrule ? skip.map(startOf) : [], timeZone: tz };
  }
  // Отпечаток того, что ушло наружу: пока он не меняется, писать заново нечего.
  // Повтор входит в отпечаток только у серии: у разовых событий он тот же,
  // что и раньше, и после обновления их не переписывает.
  function fingerprintOf(event) {
    const moment = value => (value instanceof Date ? value.toISOString() : JSON.stringify(value));
    return crypto.createHash('sha1').update(JSON.stringify([event.title, event.description, event.allDay, moment(event.start), moment(event.end), ...(event.rrule ? [event.rrule, (event.exdates || []).map(moment)] : [])])).digest('hex');
  }
  const captureQuery = `SELECT c.id, c.raw, c.deleted_at, i.classification_json FROM captures c LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.id=?`;
  function hasActiveProjection(captureId) { return Boolean(db.prepare(`SELECT 1 FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event') LIMIT 1`).get(captureId)); }
  async function writeEvent(row, calendar, capture, event, link = null) {
    const uid = link?.uid || `kizuna-${capture.id}@kizuna`;
    if (row.provider === 'caldav') {
      const creds = credentialsOf(row);
      const ics = buildEvent({ uid, title: event.title, description: event.description, start: event.start, end: event.end, allDay: event.allDay, rrule: event.rrule || null, exdates: event.exdates || [], now: now() });
      const put = await caldavClient.putEvent({ calendarUrl: calendar.url || calendar.id, username: row.username, password: creds?.password || '', uid, ics, replace: Boolean(link) });
      return { uid, href: put.href, etag: put.etag };
    }
    const accessToken = await googleAccessToken(row);
    if (link) {
      const updated = await googleClient.updateEvent({ accessToken, calendarId: calendar.id, eventId: link.uid, event: { ...event, captureId: capture.id } });
      if (!updated.missing) return { uid: updated.id, href: updated.href, etag: updated.etag };
    }
    const inserted = await googleClient.insertEvent({ accessToken, calendarId: calendar.id, event: { ...event, captureId: capture.id } });
    return { uid: inserted.id, href: inserted.href, etag: inserted.etag };
  }
  function saveLink({ captureId, accountId, calendarId, stored, fingerprint, auto, existing }) {
    if (existing) db.prepare('UPDATE calendar_links SET calendar_id=?, uid=?, href=?, etag=?, fingerprint=?, updated_at=? WHERE capture_id=? AND account_id=?').run(calendarId, stored.uid, stored.href, stored.etag, fingerprint, nowIso(), captureId, accountId);
    else db.prepare('INSERT INTO calendar_links(capture_id,account_id,calendar_id,uid,href,etag,created_at,fingerprint,auto,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(captureId, accountId, calendarId, stored.uid, stored.href, stored.etag, nowIso(), fingerprint, auto ? 1 : 0, nowIso());
  }
  async function deleteLinked(row, link) {
    if (row.provider === 'caldav') await caldavClient.deleteEvent({ href: link.href, username: row.username, password: credentialsOf(row)?.password || '' });
    else await googleClient.deleteEvent({ accessToken: await googleAccessToken(row), calendarId: link.calendar_id, eventId: link.uid });
    db.prepare('DELETE FROM calendar_links WHERE capture_id=? AND account_id=?').run(link.capture_id, row.id);
    db.prepare('DELETE FROM calendar_events WHERE account_id=? AND uid=?').run(row.id, link.uid);
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
    let stored;
    try { stored = await writeEvent(row, calendar, capture, event); }
    catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : 'export_failed', message: error.message }; }
    saveLink({ captureId, accountId, calendarId, stored, fingerprint: fingerprintOf(event), auto: false });
    report({ event: 'calendar_event_exported', provider: row.provider });
    return { link: { accountId, calendarId, href: stored.href, auto: false } };
  }
  async function removeExport({ userId, captureId, accountId }) {
    const link = db.prepare('SELECT l.* FROM calendar_links l JOIN calendar_accounts a ON a.id=l.account_id WHERE l.capture_id=? AND l.account_id=? AND a.user_id IS ?').get(captureId, accountId, userId);
    if (!link) return { error: 'not_found' };
    const row = accountRow(userId, accountId);
    try { await deleteLinked(row, link); }
    catch (error) { return { error: 'remove_failed', message: error.message }; }
    return { removed: true };
  }

  // ── автоматическая синхронизация своих дел и встреч с внешним календарём ──
  // Один проход по учётной записи: (1) что человек поменял снаружи в наших же
  // событиях — возвращается в запись уточнением; (2) чего больше нет в памяти
  // — удаляется снаружи; (3) что изменилось в памяти — переписывается; (4)
  // новые дела и встречи со сроком — создаются. Ручные отправки тоже держатся
  // в актуальном виде: отправленное один раз не должно устаревать.
  function scheduleFromCached(cached, tz) {
    if (cached.all_day) return { date: cached.start_at.slice(0, 10), time: null };
    const start = localDateTime(new Date(cached.start_at), tz), end = localDateTime(new Date(cached.end_at), tz);
    return { date: start.date, time: start.time, ...(end.date === start.date && minutesOf(end.time) > minutesOf(start.time) ? { end: end.time } : {}) };
  }
  // Уточнение срока записи из кода, тем же путём, что и из карточки: новая
  // интерпретация, проекции пересобираются, история append-only.
  function applySchedule(captureId, schedule, note) {
    const active = db.prepare(`SELECT i.classification_json FROM interpretations i WHERE i.capture_id=? AND i.status='active'`).get(captureId);
    if (!active) return null;
    const original = JSON.parse(active.classification_json);
    const end = schedule.time && schedule.end && minutesOf(schedule.end) > minutesOf(schedule.time) ? schedule.end : null;
    // Напоминание — свойство срока, и перенос его не сбрасывает.
    const remind = original.entities?.schedule?.remind;
    // Повтор и убранные экземпляры — тоже свойства срока: перенос их не трогает.
    const repeat = schedule.date ? original.entities?.schedule?.repeat || null : null;
    const skip = repeat ? normalizeSkip(original.entities?.schedule?.skip) : [];
    const next = { state: schedule.date && schedule.time ? 'ok' : 'ambiguous', date: schedule.date || null, time: schedule.time || null, ...(end ? { end } : {}), ...(remind !== undefined && remind !== null ? { remind } : {}), ...(repeat ? { repeat } : {}), ...(skip.length ? { skip } : {}), sortAt: schedule.date ? `${schedule.date}T${schedule.time || '23:59'}:00` : null, display: scheduleDisplay({ date: schedule.date || null, time: schedule.time || null, end, repeat }) };
    const classification = { ...original, entities: { ...original.entities, schedule: next } };
    return replaceInterpretation(db, captureId, classification, 'manual', { patch: { schedule: { date: next.date, time: next.time, ...(end ? { end } : {}) } }, note }, shouldMaterializeProjections(classification));
  }
  async function autoExportAccount(row) {
    const tz = timeZone(), today = dateInZone(now(), tz);
    const calendars = JSON.parse(row.calendars_json || '[]');
    const target = row.auto_export !== 'off' ? calendars.find(calendar => calendar.id === row.auto_calendar_id && calendar.writable !== false) || null : null;
    const types = row.auto_export === 'all' ? ['task', 'meeting_event'] : ['meeting_event'];
    const completion = completionMap();
    const isDone = (captureId, c) => Boolean(c.completed) || (() => { const ids = db.prepare(`SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event')`).all(captureId).map(r => r.id); return ids.length > 0 && ids.every(id => completion.get(id) === true); })();
    let writes = 0, pulled = 0, created = 0, updated = 0, removed = 0;
    const budget = () => writes < AUTO_EXPORT_BATCH;
    const links = db.prepare('SELECT * FROM calendar_links WHERE account_id=?').all(row.id);
    for (const link of links) {
      if (!budget()) break;
      const capture = db.prepare(captureQuery).get(link.capture_id);
      const c = capture && !capture.deleted_at && capture.classification_json ? JSON.parse(capture.classification_json) : null;
      // Сделанное — результат, а не встреча (settleCompleted): событие о нём
      // уже было и из календаря не пропадает, но и переписывать его незачем.
      if (c?.completed) continue;
      let event = c && ['task', 'meeting_event'].includes(c.primaryType) && hasActiveProjection(capture.id) ? eventFromCapture(capture, tz) : null;
      // Выключенная автоотправка не забирает уже отправленное: события живут
      // дальше как ручные. А суженный режим («только встречи») дела убирает.
      const following = link.auto && row.auto_export !== 'off';
      const wanted = event && (!following || (types.includes(c.primaryType) && target));
      if (!wanted) { await deleteLinked(row, link); writes += 1; removed += 1; continue; }
      if (following && link.calendar_id !== target.id) { await deleteLinked(row, link); writes += 1; removed += 1; continue; }
      // Снаружи подвинули наше событие — правим запись, а не событие.
      const cached = db.prepare('SELECT * FROM calendar_events WHERE account_id=? AND uid=? ORDER BY start_at LIMIT 1').get(row.id, link.uid);
      if (cached && link.etag && cached.etag && plainEtag(cached.etag) !== plainEtag(link.etag)) {
        const outside = scheduleFromCached(cached, tz);
        const own = c.entities?.schedule || {};
        // У серии правку снаружи не забираем: по одному экземпляру не понять,
        // подвинули серию или только его. Серия правится в записи.
        if (!own.repeat && (outside.date !== own.date || (outside.time || null) !== (own.time || null) || (outside.end || null) !== (own.end || null))) {
          applySchedule(capture.id, outside, `Перенесено в календаре «${row.label}»`);
          pulled += 1;
          const refreshed = db.prepare(captureQuery).get(capture.id);
          event = eventFromCapture(refreshed, tz) || event;
        }
        db.prepare('UPDATE calendar_links SET etag=?, fingerprint=?, updated_at=? WHERE capture_id=? AND account_id=?').run(cached.etag, fingerprintOf(event), nowIso(), capture.id, row.id);
        continue;
      }
      const fingerprint = fingerprintOf(event);
      if (fingerprint === link.fingerprint) continue;
      const calendar = calendars.find(item => item.id === link.calendar_id);
      if (!calendar) continue;
      const stored = await writeEvent(row, calendar, capture, event, link);
      saveLink({ captureId: capture.id, accountId: row.id, calendarId: calendar.id, stored, fingerprint, auto: link.auto, existing: true });
      writes += 1; updated += 1;
    }
    if (target) {
      const candidates = db.prepare(`SELECT c.id, c.raw, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
        WHERE c.deleted_at IS NULL AND c.user_id IS ? AND json_extract(i.classification_json,'$.primaryType') IN (${types.map(() => '?').join(',')})
          AND json_extract(i.classification_json,'$.completed') IS NOT 1 AND json_extract(i.classification_json,'$.entities.schedule.date') >= ?
          AND NOT EXISTS (SELECT 1 FROM calendar_links l WHERE l.capture_id=c.id AND l.account_id=?)
        ORDER BY json_extract(i.classification_json,'$.entities.schedule.date') LIMIT 400`).all(row.user_id, ...types, today, row.id);
      for (const capture of candidates) {
        if (!budget()) break;
        const c = JSON.parse(capture.classification_json);
        if (!hasActiveProjection(capture.id) || isDone(capture.id, c)) continue;
        const event = eventFromCapture(capture, tz);
        if (!event) continue;
        const stored = await writeEvent(row, target, capture, event);
        saveLink({ captureId: capture.id, accountId: row.id, calendarId: target.id, stored, fingerprint: fingerprintOf(event), auto: true });
        writes += 1; created += 1;
      }
    }
    return { writes, created, updated, removed, pulled };
  }
  const autoBusy = new Set();
  async function autoExport({ accountId = null } = {}) {
    const rows = db.prepare(`SELECT * FROM calendar_accounts WHERE disabled_at IS NULL${accountId ? ' AND id=?' : ''} ORDER BY created_at`).all(...(accountId ? [accountId] : []));
    const results = [];
    let anything = false;
    for (const row of rows) {
      if (row.auto_export === 'off' && !db.prepare('SELECT 1 FROM calendar_links WHERE account_id=? LIMIT 1').get(row.id)) continue;
      if (autoBusy.has(row.id)) continue;
      autoBusy.add(row.id);
      try {
        const result = await autoExportAccount(row);
        if (result.writes || result.pulled) { anything = true; report({ event: 'calendar_auto_synced', provider: row.provider, ...result }); }
        if (row.export_error) db.prepare('UPDATE calendar_accounts SET export_error=NULL WHERE id=?').run(row.id);
        results.push({ accountId: row.id, ...result });
      } catch (error) {
        const message = String(error?.message || 'Отправка не удалась.').slice(0, 300);
        db.prepare('UPDATE calendar_accounts SET export_error=? WHERE id=?').run(message, row.id);
        report({ event: 'calendar_auto_sync_failed', provider: row.provider, errorCode: error?.code || 'export_error' });
        results.push({ accountId: row.id, error: error?.code === 'unauthorized' ? 'unauthorized' : 'export_error', message });
        anything = true;
      } finally { autoBusy.delete(row.id); }
    }
    if (anything) changed();
    return results;
  }
  // Журнал меняется часто и пачками; наружу идём один раз после паузы.
  let autoTimer = null;
  function wakeAutoExport() {
    if (autoTimer) return;
    autoTimer = setTimeout(() => { autoTimer = null; autoExport().catch(() => {}); }, autoExportDelayMs);
    autoTimer.unref?.();
  }

  // Участники, организатор, повтор и «мой ответ». Свой участник узнаётся по
  // логину учётной записи: у Яндекса и iCloud это почта, у Google — адрес
  // основного календаря; Google ещё и помечает self сам.
  function eventPeople(row) {
    const attendees = JSON.parse(row.attendees_json || '[]');
    const organizer = row.organizer_json ? JSON.parse(row.organizer_json) : null;
    const login = String(row.username || '').toLowerCase();
    const mine = attendees.find(attendee => attendee.self || (login && attendee.email === login)) || null;
    return {
      attendees: attendees.map(attendee => ({ email: attendee.email, name: attendee.name, status: attendee.status, optional: attendee.optional, organizer: attendee.organizer, self: attendee === mine })),
      organizer, repeat: row.repeat || null, url: row.url || null,
      me: mine ? { email: mine.email, status: mine.status, optional: mine.optional, comment: mine.comment || null } : null,
    };
  }
  // Ответ организатору — по CalDAV меняется PARTSTAT своей строки в файле
  // события (Яндекс и iCloud шлют iTIP сами, как для любого клиента), у Google
  // — responseStatus своего участника. Отвечать можно и на экземпляр повтора:
  // ответ уходит серии, как в Календаре macOS.
  async function respondExternalEvent({ userId, id, status, comment }) {
    const row = externalRow(userId, id);
    if (!row) return { error: 'not_found' };
    if (row.disabled_at) return { error: 'account_not_found' };
    if (row.mode === 'busy') return { error: 'busy_mode' };
    if (!RESPONSE_STATUSES.includes(status)) return { error: 'invalid_status' };
    if (comment !== undefined && comment !== null && (typeof comment !== 'string' || comment.length > COMMENT_LIMIT)) return { error: 'invalid_comment' };
    const people = eventPeople(row);
    if (!people.me) return { error: 'not_invited' };
    const note = comment === undefined ? undefined : String(comment || '').trim();
    let attendees = people.attendees.map(({ self, ...attendee }) => (self ? { ...attendee, status, self, ...(note !== undefined ? { comment: note || null } : {}) } : { ...attendee, self }));
    let etag = row.etag;
    try {
      if (row.provider === 'caldav') {
        const password = credentialsOf(row)?.password || '';
        const got = await caldavClient.getEvent({ href: row.href, username: row.username, password });
        const ics = setPartstat(got.ics, { email: people.me.email, status, comment: note === '' ? undefined : note });
        if (!ics) return { error: 'not_invited' };
        const put = await caldavClient.putEvent({ href: row.href, username: row.username, password, uid: row.uid, ics, etag: got.etag || null });
        etag = put.etag || null;
      } else {
        const result = await googleClient.respond({ accessToken: await googleAccessToken(row), calendarId: row.calendar_id, eventId: row.uid, status, comment: note });
        if (result.missing) return { error: 'not_invited' };
        etag = result.etag || etag;
        if (result.attendees?.length) attendees = result.attendees;
      }
    } catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : error.code === 'conflict' ? 'conflict' : 'update_failed', message: error.message }; }
    // Кэш — для всех экземпляров серии сразу: ответ один на всю серию.
    db.prepare('UPDATE calendar_events SET attendees_json=?, etag=CASE WHEN id=? THEN ? ELSE etag END, updated_at=? WHERE account_id=? AND uid=?').run(JSON.stringify(attendees.map(({ self, ...attendee }) => attendee)), row.id, etag, nowIso(), row.account_id, row.uid);
    report({ event: 'calendar_external_responded', provider: row.provider, status });
    changed();
    return { event: externalInfo(externalRow(userId, id)) };
  }
  // Перенос в другой календарь той же учётной записи: у Google — events.move,
  // по CalDAV — тот же файл кладётся в новую коллекцию и убирается из старой.
  async function moveExternalEvent({ userId, id, calendarId }) {
    const row = externalRow(userId, id);
    const refused = externalWritable(row);
    if (refused) return { error: refused };
    if (row.provider === 'caldav' && row.instance_key) return { error: 'recurring' };
    const calendars = JSON.parse(row.calendars_json || '[]');
    const target = calendars.find(calendar => calendar.id === calendarId && calendar.writable !== false);
    if (!target) return { error: 'calendar_not_found' };
    if (target.id === row.calendar_id) return { event: externalInfo(row) };
    let stored = { href: row.href, etag: row.etag, uid: row.uid };
    try {
      if (row.provider === 'caldav') {
        const password = credentialsOf(row)?.password || '';
        const got = await caldavClient.getEvent({ href: row.href, username: row.username, password });
        const put = await caldavClient.putEvent({ calendarUrl: target.url || target.id, username: row.username, password, uid: row.uid, ics: got.ics });
        await caldavClient.deleteEvent({ href: row.href, username: row.username, password });
        stored = { href: put.href, etag: put.etag, uid: row.uid };
      } else {
        const moved = await googleClient.moveEvent({ accessToken: await googleAccessToken(row), calendarId: row.calendar_id, eventId: row.uid, destination: target.id });
        stored = { href: moved.href || row.href, etag: moved.etag, uid: moved.id };
      }
    } catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : 'update_failed', message: error.message }; }
    db.prepare('UPDATE calendar_events SET calendar_id=?, href=?, etag=?, uid=?, updated_at=? WHERE account_id=? AND uid=?').run(target.id, stored.href, stored.etag, stored.uid, nowIso(), row.account_id, row.uid);
    report({ event: 'calendar_external_moved', provider: row.provider });
    changed();
    return { event: externalInfo(externalRow(userId, id)) };
  }

  // ── чужие события: перенос, переименование, удаление из сетки ──
  function externalRow(userId, id) {
    const key = String(id || '').replace(/^ext:/, '').split(':')[0];
    if (!key) return null;
    return db.prepare(`SELECT e.*, a.user_id, a.mode, a.provider, a.username, a.credentials_enc, a.calendars_json, a.label account_label, a.color account_color, a.disabled_at FROM calendar_events e JOIN calendar_accounts a ON a.id=e.account_id WHERE e.id=? AND a.user_id IS ?`).get(key, userId) || null;
  }
  function externalInfo(row) {
    const tz = timeZone();
    const calendar = JSON.parse(row.calendars_json || '[]').find(item => item.id === row.calendar_id) || null;
    const base = { id: `ext:${row.id}`, title: row.mode === 'busy' ? 'Занято' : row.title, source: row.account_label, calendarId: row.calendar_id, calendarName: calendar?.name || row.account_label, color: calendar?.color || null, location: row.mode === 'busy' ? null : row.location, joinUrl: row.mode === 'busy' ? null : row.join_url, href: row.href, recurring: Boolean(row.instance_key), seriesId: row.mode === 'busy' ? null : row.series_uid || row.uid, editable: !externalWritable(row), movable: !externalWritable(row) && !(row.provider === 'caldav' && row.instance_key), ...(row.mode === 'busy' ? { attendees: [], organizer: null, repeat: null, url: null, me: null } : eventPeople(row)) };
    if (row.all_day) return { ...base, allDay: true, date: row.start_at.slice(0, 10), time: null, end: null };
    const start = localDateTime(new Date(row.start_at), tz), end = localDateTime(new Date(row.end_at), tz);
    return { ...base, allDay: false, date: start.date, time: start.time, end: end.date === start.date ? end.time : '23:59' };
  }
  function externalWritable(row) {
    if (!row) return 'not_found';
    if (row.disabled_at) return 'account_not_found';
    if (row.mode === 'busy') return 'busy_mode';
    const calendar = JSON.parse(row.calendars_json || '[]').find(item => item.id === row.calendar_id);
    if (!calendar || calendar.writable === false) return 'calendar_not_found';
    return null;
  }
  async function updateExternalEvent({ userId, id, title, date, time, end }) {
    const row = externalRow(userId, id);
    const refused = externalWritable(row);
    if (refused) return { error: refused };
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > TITLE_LIMIT)) return { error: 'invalid_title' };
    if (date !== undefined && !validDate(date)) return { error: 'invalid_schedule' };
    if (time !== undefined && time !== null && !validTime(time)) return { error: 'invalid_schedule' };
    if (end !== undefined && end !== null && (!validTime(end) || (time === null))) return { error: 'invalid_schedule' };
    const tz = timeZone();
    const current = externalInfo(row);
    const nextDate = date ?? current.date;
    const nextTime = time === undefined ? current.time : time;
    // Перенос по времени сохраняет длительность; конец меняется только явно.
    let nextEnd = end;
    if (end === undefined) {
      if (!nextTime) nextEnd = null;
      else if (time === undefined) nextEnd = current.end;
      else if (current.time && current.end) { const total = minutesOf(nextTime) + (minutesOf(current.end) - minutesOf(current.time)); nextEnd = total >= 24 * 60 ? '23:59' : timeOf(total); }
      else nextEnd = null;
    }
    if (nextTime && nextEnd && minutesOf(nextEnd) <= minutesOf(nextTime)) return { error: 'invalid_schedule' };
    const [year, month, day] = nextDate.split('-').map(Number);
    let event;
    if (!nextTime) {
      const days = row.all_day ? Math.max(1, Math.round((Date.parse(row.end_at.slice(0, 10)) - Date.parse(row.start_at.slice(0, 10))) / 86400000)) : 1;
      const last = shiftDate(nextDate, days);
      event = { allDay: true, startDate: nextDate, endDate: last, start: { year, month, day }, end: { year: Number(last.slice(0, 4)), month: Number(last.slice(5, 7)), day: Number(last.slice(8, 10)) } };
    } else {
      const startMinutes = minutesOf(nextTime);
      const duration = nextEnd ? minutesOf(nextEnd) - startMinutes : row.all_day ? DEFAULT_MEETING_MINUTES : Math.max(15, Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000));
      const start = zonedToUtc({ year, month, day, hour: Math.floor(startMinutes / 60), minute: startMinutes % 60 }, tz);
      event = { allDay: false, start, end: new Date(start.getTime() + duration * 60000) };
    }
    const nextTitle = title !== undefined ? title.trim() : undefined;
    let etag = row.etag;
    try {
      if (row.provider === 'caldav') {
        const password = credentialsOf(row)?.password || '';
        const got = await caldavClient.getEvent({ href: row.href, username: row.username, password });
        // Экземпляр повтора — «только это событие»: серия остаётся, экземпляр
        // получает свой VEVENT с RECURRENCE-ID; одиночное событие правится по месту.
        const ics = row.instance_key
          ? overrideInstance(got.ics, { instanceKey: row.instance_key, title: nextTitle, start: event.start, end: event.end, allDay: event.allDay, now: now(), timeZone: tz })
          : rewriteEvent(got.ics, { title: nextTitle, start: event.start, end: event.end, allDay: event.allDay, now: now() });
        if (!ics) return { error: 'update_failed', message: 'В файле события не нашлось серии.' };
        const put = await caldavClient.putEvent({ href: row.href, username: row.username, password, uid: row.uid, ics, etag: got.etag || null });
        etag = put.etag || null;
      } else {
        const patched = await googleClient.patchEvent({ accessToken: await googleAccessToken(row), calendarId: row.calendar_id, eventId: row.uid, patch: { title: nextTitle, ...event } });
        etag = patched.etag || etag;
      }
    } catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : error.code === 'conflict' ? 'conflict' : 'update_failed', message: error.message }; }
    const startAt = event.allDay ? new Date(Date.UTC(event.start.year, event.start.month - 1, event.start.day)) : event.start;
    const endAt = event.allDay ? new Date(Date.UTC(event.end.year, event.end.month - 1, event.end.day)) : event.end;
    db.prepare('UPDATE calendar_events SET title=?, start_at=?, end_at=?, all_day=?, etag=?, updated_at=? WHERE id=?').run(nextTitle ?? row.title, startAt.toISOString(), endAt.toISOString(), event.allDay ? 1 : 0, etag, nowIso(), row.id);
    report({ event: 'calendar_external_updated', provider: row.provider });
    changed();
    return { event: externalInfo(externalRow(userId, id)) };
  }
  // Удаление: у одиночного события — само событие; у экземпляра повтора — по
  // выбору человека либо только этот экземпляр (scope 'instance'), либо вся
  // серия (scope 'series'), как в Календаре macOS.
  async function deleteExternalEvent({ userId, id, scope = 'instance' }) {
    const row = externalRow(userId, id);
    const refused = externalWritable(row);
    if (refused) return { error: refused };
    if (!['instance', 'series'].includes(scope)) return { error: 'invalid_scope' };
    const recurring = Boolean(row.instance_key);
    const seriesUid = row.series_uid || row.uid;
    const wholeSeries = recurring && scope === 'series';
    const instance = recurring && !wholeSeries;
    try {
      if (instance && row.provider === 'caldav') {
        // Один экземпляр серии: серии дописывается EXDATE, файл кладётся обратно
        // с If-Match — остальные повторы остаются.
        const password = credentialsOf(row)?.password || '';
        const got = await caldavClient.getEvent({ href: row.href, username: row.username, password });
        const ics = excludeInstance(got.ics, { instanceKey: row.instance_key, now: now(), timeZone: timeZone() });
        if (!ics) return { error: 'remove_failed', message: 'В файле события не нашлось серии.' };
        await caldavClient.putEvent({ href: row.href, username: row.username, password, uid: row.uid, ics, etag: got.etag || null });
      } else if (row.provider === 'caldav') await caldavClient.deleteEvent({ href: row.href, username: row.username, password: credentialsOf(row)?.password || '' });
      // У Google экземпляр — своё событие, серия — событие recurringEventId.
      else await googleClient.deleteEvent({ accessToken: await googleAccessToken(row), calendarId: row.calendar_id, eventId: wholeSeries ? seriesUid : row.uid });
    } catch (error) { return { error: error.code === 'unauthorized' ? 'unauthorized' : error.code === 'conflict' ? 'conflict' : 'remove_failed', message: error.message }; }
    const removedScope = wholeSeries ? 'series' : instance ? 'instance' : 'event';
    if (wholeSeries) db.prepare('DELETE FROM calendar_events WHERE account_id=? AND (uid=? OR series_uid=?)').run(row.account_id, seriesUid, seriesUid);
    else if (row.provider === 'caldav' && !instance) db.prepare('DELETE FROM calendar_events WHERE account_id=? AND uid=?').run(row.account_id, row.uid);
    else db.prepare('DELETE FROM calendar_events WHERE id=?').run(row.id);
    report({ event: 'calendar_external_removed', provider: row.provider, scope: removedScope });
    changed();
    return { removed: true, title: row.title, scope: removedScope };
  }
  function externalEvent({ userId, id }) { const row = externalRow(userId, id); return row && !row.disabled_at ? externalInfo(row) : null; }

  return { listAccounts, addCaldavAccount, updateAccount, removeAccount, googleReady, googleStart, googleFinish, syncAccount, syncDue, view, exportCapture, removeExport, autoExport, wakeAutoExport, updateExternalEvent, deleteExternalEvent, respondExternalEvent, moveExternalEvent, externalEvent, applySchedule, presets: Object.fromEntries(Object.entries(CALDAV_PRESETS).map(([key, preset]) => [key, { label: preset.label, serverUrl: preset.serverUrl }])) };
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
    const tick = () => {
      this.inFlight = this.service.syncDue({ intervalMs: this.intervalMs })
        .catch(error => { try { this.audit({ event: 'calendar_sync_failed', errorCode: error?.code || 'sync_error' }); } catch {} })
        // Отправка наружу — тем же потоком после чтения: сначала узнаём, что
        // поменяли снаружи, потом дописываем своё.
        .then(() => this.service.autoExport?.())
        .catch(error => { try { this.audit({ event: 'calendar_auto_sync_failed', errorCode: error?.code || 'export_error' }); } catch {} })
        .finally(() => { this.inFlight = null; });
    };
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
