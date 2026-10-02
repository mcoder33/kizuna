// Клиент CalDAV для Яндекс Календаря и iCloud: у Яндекса другого входа нет,
// а у Apple CalDAV — единственный открытый. Оба берут логин и пароль
// приложения; дальше — PROPFIND для списка календарей, REPORT calendar-query
// за событиями окна и PUT файла .ics, когда встреча уходит наружу. XML
// разбирается регулярными выражениями по снятым префиксам пространств имён:
// ответ multistatus плоский, и тащить парсер XML ради него незачем.
import { parseCalendar } from './ics.js';
import { createSafeHttpFetch, validateRemoteUrl, readBoundedBody, withDeadline, externalRequestError } from './safe-http.js';

export const CALDAV_PRESETS = {
  // Яндекс: единая точка, принципал и дом по логину.
  yandex: { label: 'Яндекс', serverUrl: 'https://caldav.yandex.ru', principal: username => `/principals/users/${username}/`, home: username => `/calendars/${username}/` },
  // iCloud: дом календарей живёт на другом хосте (pNN-caldav.icloud.com) — его
  // отдаёт discovery, руками не угадать.
  icloud: { label: 'Apple iCloud', serverUrl: 'https://caldav.icloud.com', principal: null, home: null },
  custom: { label: 'CalDAV', serverUrl: null, principal: null, home: null },
};

const DAV_NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (m, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&amp;/g, '&');
}
// Префиксы пространств имён снимаются: сервера зовут DAV: то d:, то D:, то A:.
function stripPrefixes(xml) { return String(xml).replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1'); }
function tag(xml, name) { const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return match ? match[1] : null; }
function tags(xml, name) { return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map(match => match[1]); }
function hasTag(xml, name) { return new RegExp(`<${name}(?:\\s[^>]*)?/?>`, 'i').test(xml); }

export function parseMultistatus(xml) {
  const plain = stripPrefixes(xml);
  return tags(plain, 'response').map(response => {
    const href = decodeEntities(tag(response, 'href') || '').trim();
    const propstats = tags(response, 'propstat').filter(block => /\b2\d\d\b/.test(tag(block, 'status') || '200'));
    const props = propstats.map(block => tag(block, 'prop') || '').join('');
    return { href, props, status: tag(response, 'status') };
  });
}

export function createCaldavClient({ fetch = null, timeoutMs = 20000, maxResponseBytes = 8 * 1024 * 1024, userAgent = 'Kizuna/1.0' } = {}) {
  const transport = !fetch || fetch === globalThis.fetch ? createSafeHttpFetch() : fetch;
  const absolute = (base, href, auth) => validateRemoteUrl(href, { base, serverUrl: auth.serverUrl, preset: auth.preset }).href;
  async function call(url, { method, body = null, headers = {}, auth, depth = null }) {
    return withDeadline(async signal => {
      let target = absolute(auth.serverUrl, url, auth);
      let remaining = maxResponseBytes;
      for (let redirects = 0; ; redirects += 1) {
        if (remaining <= 0) throw externalRequestError('response_too_large');
        const response = await transport(target, {
          method, body, signal, redirect: 'manual',
          headers: {
            Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`,
            'User-Agent': userAgent,
            ...(depth !== null ? { Depth: String(depth) } : {}),
            ...(body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
            ...headers,
          },
        });
        const bytes = await readBoundedBody(response, { maxBytes: remaining, signal });
        remaining -= bytes.length;
        if ([301, 302, 307, 308].includes(response.status) && response.headers.get('location')) {
          if (redirects >= 3) throw externalRequestError('too_many_redirects');
          target = absolute(target, response.headers.get('location'), auth);
          continue;
        }
        return { status: response.status, text: bytes.toString('utf8'), headers: response.headers };
      }
    }, { timeoutMs, signal: auth.signal });
  }
  function fail(status, where) {
    const error = new Error(status === 401 || status === 403 ? 'Сервер не принял логин или пароль приложения.' : `Календарь ответил ${status} на ${where}.`);
    error.code = status === 401 || status === 403 ? 'unauthorized' : 'caldav_error';
    error.status = status;
    return error;
  }

  async function propfind(url, auth, body, depth) {
    const result = await call(url, { method: 'PROPFIND', body, auth, depth });
    if (result.status < 200 || result.status >= 300) throw fail(result.status, 'PROPFIND');
    return parseMultistatus(result.text);
  }

  // Поиск дома календарей: principal → calendar-home-set. У пресета Яндекса
  // путь известен заранее, но discovery всё равно пробуется первым — так
  // клиент один на всех.
  async function discover({ serverUrl, username, password, preset = 'custom' }) {
    return withDeadline(async signal => {
    const auth = { username, password, serverUrl, preset, signal };
    const base = absolute(serverUrl, serverUrl.replace(/\/?$/, '/'), auth);
    let homeUrl = null;
    try {
      const rootResponses = await propfind(base, auth, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`, 0);
      const principalHref = rootResponses.map(response => tag(response.props, 'current-user-principal')).map(block => block && tag(block, 'href')).find(Boolean);
      const principalUrl = principalHref ? absolute(base, decodeEntities(principalHref).trim(), auth) : (CALDAV_PRESETS[preset]?.principal ? absolute(base, CALDAV_PRESETS[preset].principal(username), auth) : null);
      if (principalUrl) {
        const principalResponses = await propfind(principalUrl, auth, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, 0);
        const homeHref = principalResponses.map(response => tag(response.props, 'calendar-home-set')).map(block => block && tag(block, 'href')).find(Boolean);
        if (homeHref) homeUrl = absolute(principalUrl, decodeEntities(homeHref).trim(), auth);
      }
    } catch (error) {
      if (error.code !== 'caldav_error') throw error;
      // Discovery не обязателен: у пресета дом известен.
    }
    if (!homeUrl && CALDAV_PRESETS[preset]?.home) homeUrl = absolute(base, CALDAV_PRESETS[preset].home(username), auth);
    if (!homeUrl) throw Object.assign(new Error('Не удалось найти календари на сервере.'), { code: 'no_home' });
    const responses = await propfind(homeUrl, auth, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NS}><d:prop><d:resourcetype/><d:displayname/><ic:calendar-color/><c:supported-calendar-component-set/><cs:getctag/></d:prop></d:propfind>`, 1);
    const calendars = responses
      .filter(response => hasTag(response.props, 'calendar') && (tag(response.props, 'resourcetype') || '').includes('calendar'))
      .filter(response => { const set = tag(response.props, 'supported-calendar-component-set'); return !set || /name="VEVENT"/i.test(set); })
      .map(response => ({
        id: absolute(homeUrl, response.href, auth),
        url: absolute(homeUrl, response.href, auth),
        name: decodeEntities(tag(response.props, 'displayname') || '').trim() || 'Календарь',
        color: normalizeColor(decodeEntities(tag(response.props, 'calendar-color') || '')),
        ctag: decodeEntities(tag(response.props, 'getctag') || '').trim() || null,
      }))
      .filter(calendar => calendar.url);
    if (!calendars.length) throw Object.assign(new Error('На сервере нет календарей с событиями.'), { code: 'no_calendars' });
    return { homeUrl, calendars };
    }, { timeoutMs });
  }

  // События окна: REPORT calendar-query с time-range. Повторы сервер не
  // разворачивает — это делает наш разбор, одинаково для всех источников.
  async function listEvents({ calendarUrl, serverUrl = calendarUrl, preset = 'custom', username, password, from, to, timeZone = 'UTC' }) {
    const auth = { username, password, serverUrl, preset };
    const stamp = at => at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV_NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const result = await call(calendarUrl, { method: 'REPORT', body, auth, depth: 1 });
    if (result.status < 200 || result.status >= 300) throw fail(result.status, 'REPORT');
    const events = [];
    for (const response of parseMultistatus(result.text)) {
      const data = tag(response.props, 'calendar-data');
      if (!data) continue;
      const etag = decodeEntities(tag(response.props, 'getetag') || '').trim() || null;
      const href = absolute(calendarUrl, response.href, auth);
      for (const event of parseCalendar(decodeEntities(data), { from, to, timeZone }).events) events.push({ ...event, etag, href });
    }
    return events;
  }

  // Новое событие кладётся с If-None-Match: * — чтобы не затереть чужое с тем
  // же uid. Обновление своего (replace) идёт без предусловий: etag после
  // чужой правки устарел бы, и событие навсегда застряло бы в 412.
  async function putEvent({ calendarUrl = null, serverUrl = calendarUrl, preset = 'custom', href: givenHref = null, username, password, uid, ics, etag = null, replace = false }) {
    if (!serverUrl) throw externalRequestError('unsafe_origin');
    const auth = { username, password, serverUrl, preset };
    const href = absolute(serverUrl, givenHref || new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl.replace(/\/?$/, '/')).href, auth);
    const result = await call(href, { method: 'PUT', body: ics, auth, headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...(etag ? { 'If-Match': etag } : replace ? {} : { 'If-None-Match': '*' }) } });
    if (result.status === 412) throw Object.assign(new Error('Событие изменили снаружи, пока мы его правили. Обновите календарь и попробуйте снова.'), { code: 'conflict', status: 412 });
    if (result.status < 200 || result.status >= 300) throw fail(result.status, 'PUT');
    return { href, etag: result.headers.get('etag') || null };
  }

  // Чужое событие целиком — чтобы поправить в нём время и положить обратно,
  // не потеряв ничего из того, чего мы не разбираем.
  async function getEvent({ href, serverUrl, preset = 'custom', username, password }) {
    if (!serverUrl) throw externalRequestError('unsafe_origin');
    const result = await call(href, { method: 'GET', auth: { username, password, serverUrl, preset } });
    if (result.status < 200 || result.status >= 300) throw fail(result.status, 'GET');
    return { ics: result.text, etag: result.headers.get('etag') || null };
  }

  async function deleteEvent({ href, serverUrl, preset = 'custom', username, password }) {
    if (!serverUrl) throw externalRequestError('unsafe_origin');
    const result = await call(href, { method: 'DELETE', auth: { username, password, serverUrl, preset } });
    if (result.status !== 404 && (result.status < 200 || result.status >= 300)) throw fail(result.status, 'DELETE');
    return true;
  }

  return { discover, listEvents, getEvent, putEvent, deleteEvent };
}

// Цвет календаря приходит как #RRGGBB или #RRGGBBAA; оставляем шесть знаков.
export function normalizeColor(value) {
  const match = String(value || '').trim().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return match ? `#${match[1].toLowerCase()}` : null;
}
