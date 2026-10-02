// Google Calendar через его API, а не через CalDAV: у Google нет паролей
// приложений, только OAuth, зато API отдаёт развёрнутые повторы, ссылку Meet и
// цвет календаря. Токен обновления хранится шифрованно вместе с учётной
// записью; access-токен живёт час и перевыпускается по мере надобности.
import { describeRrule } from './ics.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://www.googleapis.com/calendar/v3';
// Чтение всех календарей и правка событий: писать наружу Кизуна умеет только
// то, что создала сама, но право на это нужно запросить сразу — второй раз
// человека через согласие Google гонять не хочется.
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

export function createGoogleCalendarClient({ fetch = globalThis.fetch, timeoutMs = 20000 } = {}) {
  async function call(url, { method = 'GET', body = null, accessToken = null, form = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method, signal: controller.signal,
        headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
        body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined,
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        const suppliedMessage = data?.error?.message || data?.error_description || data?.error;
        const fallback = `Google ответил ${response.status}.`;
        const error = new Error(typeof suppliedMessage === 'string' ? suppliedMessage : fallback);
        if (typeof suppliedMessage !== 'string') error.presentation = {source:'Google ответил {status}.',params:{status:response.status}};
        error.status = response.status;
        error.code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'google_error';
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  function authorizeUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `${AUTH_URL}?${params}`;
  }
  async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
    const data = await call(TOKEN_URL, { method: 'POST', form: true, body: { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' } });
    if (!data?.refresh_token) throw Object.assign(new Error('Google не выдал токен обновления: отзовите доступ Кизуны в аккаунте Google и подключите заново.'), { code: 'no_refresh_token' });
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  }
  async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
    const data = await call(TOKEN_URL, { method: 'POST', form: true, body: { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' } });
    return { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  }

  async function listCalendars({ accessToken }) {
    const out = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ minAccessRole: 'reader', showHidden: 'false', ...(pageToken ? { pageToken } : {}) });
      const data = await call(`${API_URL}/users/me/calendarList?${params}`, { accessToken });
      for (const item of data?.items || []) out.push({ id: item.id, name: item.summaryOverride || item.summary || item.id, color: item.backgroundColor || null, primary: Boolean(item.primary), writable: ['owner', 'writer'].includes(item.accessRole), selected: item.selected !== false });
      pageToken = data?.nextPageToken || null;
    } while (pageToken);
    return out;
  }

  // Момент события: dateTime — со временем (с пояском в строке), date — весь
  // день (конец у Google — следующий день, как и в iCalendar).
  function moment(value) {
    if (!value) return null;
    if (value.dateTime) return { at: new Date(value.dateTime), allDay: false };
    if (value.date) { const [y, m, d] = value.date.split('-').map(Number); return { at: new Date(Date.UTC(y, m - 1, d)), allDay: true }; }
    return null;
  }
  function joinUrlOf(item) {
    if (item.hangoutLink) return item.hangoutLink;
    const video = (item.conferenceData?.entryPoints || []).find(point => point.entryPointType === 'video');
    return video?.uri || null;
  }

  const STATUS = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needs-action' };
  function attendeesOf(item) {
    return (item.attendees || []).slice(0, 60).map(attendee => ({
      email: String(attendee.email || '').toLowerCase(), name: attendee.displayName || null,
      status: STATUS[attendee.responseStatus] || 'needs-action', optional: Boolean(attendee.optional), organizer: Boolean(attendee.organizer), self: Boolean(attendee.self),
      comment: attendee.comment || null,
    })).filter(attendee => attendee.email);
  }
  // Экземпляры повторов приходят без правила: оно у серии. Серия читается
  // один раз на синхронизацию, не больше сорока штук — больше в окне не бывает.
  async function repeatOf(accessToken, calendarId, item, cache) {
    if (!item.recurringEventId) return null;
    if (!cache.has(item.recurringEventId)) {
      let text = 'Повторяется';
      if (cache.size < 40) {
        try {
          const master = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(item.recurringEventId)}`, { accessToken });
          const rrule = (master?.recurrence || []).find(line => /^RRULE:/i.test(line));
          text = rrule ? describeRrule(rrule.slice(6)) || text : text;
        } catch {}
      }
      cache.set(item.recurringEventId, text);
    }
    return cache.get(item.recurringEventId);
  }

  async function listEvents({ accessToken, calendarId, from, to }) {
    const out = [];
    const series = new Map();
    let pageToken = null;
    do {
      const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin: from.toISOString(), timeMax: to.toISOString(), ...(pageToken ? { pageToken } : {}) });
      const data = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { accessToken });
      for (const item of data?.items || []) {
        const start = moment(item.start), end = moment(item.end);
        if (!start || !end) continue;
        // Экземпляр повтора: свой id (по нему PATCH и DELETE правят один
        // экземпляр), ключ — исходное начало, серия — recurringEventId.
        out.push({
          uid: item.id,
          instanceKey: item.recurringEventId ? item.originalStartTime?.dateTime || item.originalStartTime?.date || item.start?.dateTime || item.start?.date || null : null,
          seriesUid: item.recurringEventId || null,
          title: (item.summary || '').trim() || '(без названия)',
          description: (item.description || '').slice(0, 2000),
          location: (item.location || '').slice(0, 300),
          start: start.at, end: end.at, allDay: start.allDay,
          busy: item.transparency !== 'transparent' && item.status !== 'cancelled',
          cancelled: item.status === 'cancelled',
          joinUrl: joinUrlOf(item),
          url: item.htmlLink || null,
          attendees: attendeesOf(item),
          organizer: item.organizer ? { email: String(item.organizer.email || '').toLowerCase(), name: item.organizer.displayName || null } : null,
          repeat: await repeatOf(accessToken, calendarId, item, series),
          sequence: Number(item.sequence) || 0,
          lastModified: item.updated || null,
          etag: item.etag || null, href: item.htmlLink || null,
        });
      }
      pageToken = data?.nextPageToken || null;
    } while (pageToken);
    return out;
  }

  // Повтор — строками RRULE и EXDATE, как в iCalendar. У повторяющегося
  // события Google требует пояс начала и конца: в нём и разворачивает серию.
  const icsStamp = at => at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = ({ year, month, day }) => `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  function eventBody(event) {
    const zone = event.rrule && event.timeZone ? { timeZone: event.timeZone } : {};
    const exdates = (event.exdates || []).map(exdate => (event.allDay ? `EXDATE;VALUE=DATE:${dateStamp(exdate)}` : `EXDATE:${icsStamp(exdate)}`));
    return {
      summary: event.title, description: event.description || undefined, location: event.location || undefined,
      start: event.allDay ? { date: event.startDate } : { dateTime: event.start.toISOString(), ...zone },
      end: event.allDay ? { date: event.endDate } : { dateTime: event.end.toISOString(), ...zone },
      ...(event.rrule ? { recurrence: [`RRULE:${event.rrule}`, ...exdates] } : {}),
      extendedProperties: { private: { kizunaCaptureId: event.captureId || '' } },
    };
  }
  async function insertEvent({ accessToken, calendarId, event }) {
    const data = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', accessToken, body: eventBody(event) });
    return { id: data.id, href: data.htmlLink || null, etag: data.etag || null };
  }
  // Обновление своего события целиком (PUT): стёртое снаружи — 404/410 —
  // возвращается как missing, чтобы вызывающий создал его заново.
  async function updateEvent({ accessToken, calendarId, eventId, event }) {
    try {
      const data = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PUT', accessToken, body: eventBody(event) });
      return { id: data.id, href: data.htmlLink || null, etag: data.etag || null };
    } catch (error) {
      if (error.status === 404 || error.status === 410) return { missing: true };
      throw error;
    }
  }
  // Частичная правка чужого события: только то, что человек менял. Экземпляр
  // повтора у Google — свой id, PATCH по нему правит один экземпляр.
  async function patchEvent({ accessToken, calendarId, eventId, patch }) {
    const body = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.start !== undefined) {
      body.start = patch.allDay ? { date: patch.startDate } : { dateTime: patch.start.toISOString() };
      body.end = patch.allDay ? { date: patch.endDate } : { dateTime: patch.end.toISOString() };
    }
    const data = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', accessToken, body });
    return { id: data.id, href: data.htmlLink || null, etag: data.etag || null };
  }
  // Ответ на приглашение: свой участник получает responseStatus и комментарий.
  async function respond({ accessToken, calendarId, eventId, status, comment }) {
    const event = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { accessToken });
    const attendees = event?.attendees || [];
    const mine = attendees.find(attendee => attendee.self);
    if (!mine) return { missing: true };
    const responseStatus = Object.entries(STATUS).find(([, value]) => value === status)?.[0];
    const next = attendees.map(attendee => (attendee === mine ? { ...attendee, responseStatus, ...(comment !== undefined ? { comment: comment || undefined } : {}) } : attendee));
    const data = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'PATCH', accessToken, body: { attendees: next } });
    return { etag: data?.etag || null, attendees: attendeesOf(data || { attendees: next }) };
  }
  async function moveEvent({ accessToken, calendarId, eventId, destination }) {
    const data = await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/move?destination=${encodeURIComponent(destination)}`, { method: 'POST', accessToken });
    return { id: data?.id || eventId, href: data?.htmlLink || null, etag: data?.etag || null };
  }
  async function deleteEvent({ accessToken, calendarId, eventId }) {
    try { await call(`${API_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', accessToken }); }
    catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
    return true;
  }

  return { authorizeUrl, exchangeCode, refreshAccessToken, listCalendars, listEvents, insertEvent, updateEvent, patchEvent, respond, moveEvent, deleteEvent };
}
