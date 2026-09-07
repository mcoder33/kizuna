// iCalendar без библиотек: разбор VEVENT из CalDAV и ICS-подписок, сборка
// VEVENT для отправки встречи наружу и разворачивание повторов. У сервера нет
// зависимостей на разбор дат, поэтому пояса считаются через Intl — того же
// движка, что уже переводит «сегодня» в дату журнала.

const CRLF = /\r?\n/;

// Свёрнутые строки (RFC 5545 §3.1): продолжение начинается с пробела или
// табуляции и приклеивается к предыдущей строке.
function unfold(text) {
  const lines = [];
  for (const raw of String(text).split(CRLF)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (match, char) => (char === 'n' || char === 'N' ? '\n' : char));
}
export function escapeText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Строка свойства: NAME;PARAM=VALUE;PARAM2="a,b":VALUE. Двоеточие внутри
// кавычек параметра не разделитель.
function parseLine(line) {
  let index = 0, inQuotes = false;
  for (; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ':' && !inQuotes) break;
  }
  if (index >= line.length) return null;
  const head = line.slice(0, index), value = line.slice(index + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// Компоненты складываются в дерево: VCALENDAR → VEVENT / VTIMEZONE …
function parseComponents(text) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') { const child = { name: prop.value.trim().toUpperCase(), props: [], children: [] }; stack[stack.length - 1].children.push(child); stack.push(child); continue; }
    if (prop.name === 'END') { if (stack.length > 1) stack.pop(); continue; }
    stack[stack.length - 1].props.push(prop);
  }
  return root;
}
function firstProp(component, name) { return component.props.find(prop => prop.name === name) || null; }
function allProps(component, name) { return component.props.filter(prop => prop.name === name); }

// ── время ────────────────────────────────────────────────────────────────
function validZone(timeZone) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); return true; } catch { return false; }
}
const zoneFormatters = new Map();
function zoneFormatter(timeZone) {
  if (!zoneFormatters.has(timeZone)) zoneFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return zoneFormatters.get(timeZone);
}
// Стеновое время в поясе для момента UTC.
export function wallClock(at, timeZone) {
  const parts = zoneFormatter(timeZone).formatToParts(at instanceof Date ? at : new Date(at));
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}
function zoneOffsetMs(at, timeZone) {
  const wall = wallClock(at, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - at.getTime();
}
// Стеновое время пояса → UTC. Смещение угадывается по UTC-догадке и
// уточняется один раз: этого хватает, кроме часа перевода стрелок.
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  const second_ = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second_);
}
export function localDateTime(at, timeZone) {
  const wall = wallClock(at, timeZone);
  const pad = value => String(value).padStart(2, '0');
  return { date: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`, time: `${pad(wall.hour)}:${pad(wall.minute)}` };
}

// DTSTART/DTEND: дата (VALUE=DATE), UTC (…Z), с поясом (TZID=…) или «плавающее»
// — последнее считаем временем пояса приложения.
export function parseDateValue(prop, { timeZone = 'UTC', fallbackZone = timeZone } = {}) {
  if (!prop) return null;
  const value = prop.value.trim();
  const dateOnly = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(value);
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  const [, y, m, d, hh = '0', mm = '0', ss = '0', utc] = match;
  const wall = { year: Number(y), month: Number(m), day: Number(d), hour: Number(hh), minute: Number(mm), second: Number(ss) };
  if (dateOnly) return { allDay: true, wall, at: new Date(Date.UTC(wall.year, wall.month - 1, wall.day)) };
  if (utc) return { allDay: false, wall, at: new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)) };
  const zone = prop.params.TZID && validZone(prop.params.TZID) ? prop.params.TZID : fallbackZone;
  return { allDay: false, wall, at: zonedToUtc(wall, zone), zone };
}

function parseDuration(value) {
  const match = String(value || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;
  const [, sign, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  const ms = ((Number(weeks) * 7 + Number(days)) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
  return sign === '-' ? -ms : ms;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function parseRrule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const [key, raw] = part.split('=');
    if (!key || raw === undefined) continue;
    rule[key.toUpperCase()] = raw;
  }
  const freq = rule.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  return {
    freq,
    interval: Math.max(1, Number(rule.INTERVAL) || 1),
    count: rule.COUNT ? Number(rule.COUNT) : null,
    until: rule.UNTIL ? parseDateValue({ value: rule.UNTIL, params: {} }, { timeZone: 'UTC' })?.at || null : null,
    byDay: rule.BYDAY ? rule.BYDAY.split(',').map(item => { const m = item.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { ordinal: m[1] ? Number(m[1]) : null, day: WEEKDAYS.indexOf(m[2]) } : null; }).filter(Boolean) : null,
    byMonthDay: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : null,
    byMonth: rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : null,
    weekStart: rule.WKST ? WEEKDAYS.indexOf(rule.WKST) : 1,
  };
}

// Повторы разворачиваются в стеновом времени пояса события — так летом и
// зимой встреча остаётся в «11:00», как и в самом календаре.
function addWall(wall, { days = 0, months = 0, years = 0 }) {
  const date = new Date(Date.UTC(wall.year + years, wall.month - 1 + months, wall.day + days, wall.hour, wall.minute, wall.second));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: wall.hour, minute: wall.minute, second: wall.second };
}
function wallWeekday(wall) { return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay(); }
function wallKey(wall) { return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second); }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

// Кандидаты одного периода: для недели — дни BYDAY, для месяца — BYMONTHDAY
// или «второй вторник», для года — BYMONTH; иначе тот же день, что у DTSTART.
function periodCandidates(rule, base, cursor) {
  if (rule.freq === 'DAILY') return [cursor];
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay?.length ? rule.byDay.map(item => item.day) : [wallWeekday(base)];
    const weekStartOffset = (wallWeekday(cursor) - rule.weekStart + 7) % 7;
    const weekStart = addWall(cursor, { days: -weekStartOffset });
    return days.map(day => addWall(weekStart, { days: (day - rule.weekStart + 7) % 7 })).sort((a, b) => wallKey(a) - wallKey(b));
  }
  if (rule.freq === 'MONTHLY') {
    const out = [];
    if (rule.byMonthDay?.length) {
      for (const monthDay of rule.byMonthDay) {
        const total = daysInMonth(cursor.year, cursor.month);
        const day = monthDay > 0 ? monthDay : total + monthDay + 1;
        if (day >= 1 && day <= total) out.push({ ...cursor, day });
      }
    } else if (rule.byDay?.length) {
      const total = daysInMonth(cursor.year, cursor.month);
      for (const item of rule.byDay) {
        const matches = [];
        for (let day = 1; day <= total; day += 1) if (wallWeekday({ ...cursor, day }) === item.day) matches.push(day);
        if (item.ordinal === null) for (const day of matches) out.push({ ...cursor, day });
        else { const picked = item.ordinal > 0 ? matches[item.ordinal - 1] : matches[matches.length + item.ordinal]; if (picked) out.push({ ...cursor, day: picked }); }
      }
    } else if (base.day <= daysInMonth(cursor.year, cursor.month)) out.push({ ...cursor, day: base.day });
    return out.sort((a, b) => wallKey(a) - wallKey(b));
  }
  // YEARLY
  const months = rule.byMonth?.length ? rule.byMonth : [base.month];
  return months.filter(month => base.day <= daysInMonth(cursor.year, month)).map(month => ({ ...cursor, month, day: base.day }));
}

export function expandRrule(rule, start, { rangeStart, rangeEnd, limit = 1000, exdates = new Set() } = {}) {
  const base = start.wall;
  const zone = start.zone || 'UTC';
  const toUtc = wall => (start.allDay ? new Date(Date.UTC(wall.year, wall.month - 1, wall.day)) : zonedToUtc(wall, zone));
  const out = [];
  let produced = 0;
  let cursor = { ...base };
  if (rule.freq === 'MONTHLY') cursor = { ...cursor, day: 1 };
  if (rule.freq === 'YEARLY') cursor = { ...cursor, month: 1, day: 1 };
  for (let period = 0; period < limit; period += 1) {
    const candidates = periodCandidates(rule, base, cursor).filter(wall => wallKey(wall) >= wallKey(base));
    for (const wall of candidates) {
      const at = toUtc(wall);
      if (rule.until && at > rule.until) return out;
      produced += 1;
      if (rule.count && produced > rule.count) return out;
      if (at >= rangeEnd) return out;
      if (!exdates.has(at.getTime()) && at >= rangeStart) out.push({ wall, at });
    }
    if (rule.freq === 'DAILY') cursor = addWall(cursor, { days: rule.interval });
    else if (rule.freq === 'WEEKLY') cursor = addWall(cursor, { days: 7 * rule.interval });
    else if (rule.freq === 'MONTHLY') cursor = addWall({ ...cursor, day: 1 }, { months: rule.interval });
    else cursor = addWall({ ...cursor, month: 1, day: 1 }, { years: rule.interval });
    if (rule.freq !== 'DAILY' && rule.freq !== 'WEEKLY' && wallKey(cursor) > wallKey({ ...base, year: base.year + 100 })) return out;
  }
  return out;
}

// Ссылка на звонок — первая ссылка на известный сервис в описании, месте или
// свойстве URL: кнопка «Присоединиться» ведёт прямо туда.
const JOIN_PATTERN = /https?:\/\/(?:[\w.-]*\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|telemost\.yandex\.ru|telemost\.yandex\.\w+|meet\.jit\.si|whereby\.com|webex\.com|yandex\.ru\/telemost|salutejazz\.ru|jazz\.sber\.ru|kontur\.ru\/talk|talk\.kontur\.ru)[^\s<>"']*/i;
export function findJoinUrl(...texts) {
  for (const text of texts) { const match = String(text || '').match(JOIN_PATTERN); if (match) return match[0]; }
  return null;
}

// Разбор одного файла календаря. Вернёт экземпляры событий в окне [from, to):
// одиночные — как есть, повторяющиеся — развёрнутыми, с учётом EXDATE и
// переопределённых экземпляров (RECURRENCE-ID).
export function parseCalendar(text, { from, to, timeZone = 'UTC' } = {}) {
  const rangeStart = from instanceof Date ? from : new Date(from || 0);
  const rangeEnd = to instanceof Date ? to : new Date(to || 8640000000000000);
  const root = parseComponents(text);
  const calendars = root.children.filter(child => child.name === 'VCALENDAR');
  const events = calendars.flatMap(calendar => calendar.children.filter(child => child.name === 'VEVENT'));
  const name = calendars.map(calendar => firstProp(calendar, 'X-WR-CALNAME')?.value).find(Boolean) || null;
  const overrides = new Map();
  const masters = [];
  for (const event of events) {
    const uid = firstProp(event, 'UID')?.value?.trim();
    if (!uid) continue;
    const recurrenceId = firstProp(event, 'RECURRENCE-ID');
    if (recurrenceId) {
      const at = parseDateValue(recurrenceId, { timeZone })?.at;
      if (at) { if (!overrides.has(uid)) overrides.set(uid, new Map()); overrides.get(uid).set(at.getTime(), event); }
    } else masters.push(event);
  }
  const out = [];
  const describe = (event, start, end, allDay, instanceKey) => {
    const summary = unescapeText(firstProp(event, 'SUMMARY')?.value || '').trim();
    const description = unescapeText(firstProp(event, 'DESCRIPTION')?.value || '').trim();
    const location = unescapeText(firstProp(event, 'LOCATION')?.value || '').trim();
    const url = firstProp(event, 'URL')?.value?.trim() || '';
    const status = (firstProp(event, 'STATUS')?.value || '').trim().toUpperCase();
    const transparency = (firstProp(event, 'TRANSP')?.value || '').trim().toUpperCase();
    return {
      uid: firstProp(event, 'UID').value.trim(),
      instanceKey,
      title: summary || '(без названия)',
      description: description.slice(0, 2000),
      location: location.slice(0, 300),
      start, end, allDay,
      busy: transparency !== 'TRANSPARENT' && status !== 'CANCELLED',
      cancelled: status === 'CANCELLED',
      joinUrl: findJoinUrl(url, location, description),
      lastModified: parseDateValue(firstProp(event, 'LAST-MODIFIED') || firstProp(event, 'DTSTAMP'), { timeZone: 'UTC' })?.at?.toISOString() || null,
    };
  };
  for (const event of masters) {
    const uid = firstProp(event, 'UID').value.trim();
    const start = parseDateValue(firstProp(event, 'DTSTART'), { timeZone });
    if (!start) continue;
    const endProp = firstProp(event, 'DTEND');
    const durationMs = endProp ? null : parseDuration(firstProp(event, 'DURATION')?.value);
    const endValue = endProp ? parseDateValue(endProp, { timeZone }) : null;
    // Длительность: DTEND, иначе DURATION, иначе сутки у события на весь день
    // и ноль у события со временем (RFC 5545 §3.6.1).
    const spanMs = endValue ? Math.max(0, endValue.at - start.at) : durationMs ?? (start.allDay ? 86400000 : 0);
    const rruleProp = firstProp(event, 'RRULE');
    const rule = rruleProp ? parseRrule(rruleProp.value) : null;
    const exdates = new Set(allProps(event, 'EXDATE').flatMap(prop => prop.value.split(',').map(value => parseDateValue({ value, params: prop.params }, { timeZone })?.at?.getTime()).filter(Boolean)));
    const overridden = overrides.get(uid) || new Map();
    const emit = (instanceStart, key) => {
      const override = overridden.get(instanceStart.getTime());
      if (override) {
        const oStart = parseDateValue(firstProp(override, 'DTSTART'), { timeZone }) || { at: instanceStart, allDay: start.allDay };
        const oEndProp = firstProp(override, 'DTEND');
        const oEnd = oEndProp ? parseDateValue(oEndProp, { timeZone })?.at : new Date(oStart.at.getTime() + (parseDuration(firstProp(override, 'DURATION')?.value) ?? spanMs));
        if (oStart.at < rangeEnd && oEnd > rangeStart) out.push(describe(override, oStart.at, oEnd, oStart.allDay, key));
        return;
      }
      const instanceEnd = new Date(instanceStart.getTime() + spanMs);
      if (instanceStart < rangeEnd && instanceEnd > rangeStart) out.push(describe(event, instanceStart, instanceEnd, start.allDay, key));
    };
    if (!rule) { emit(start.at, null); continue; }
    // Окно разворота расширяется на длину события: встреча, начавшаяся до
    // границы и длящаяся через неё, тоже нужна.
    const occurrences = expandRrule(rule, start, { rangeStart: new Date(rangeStart.getTime() - spanMs), rangeEnd, exdates });
    for (const occurrence of occurrences) emit(occurrence.at, occurrence.at.toISOString());
    // Переопределённый экземпляр мог уехать в окно из-за его пределов.
    for (const [key, override] of overridden) {
      if (occurrences.some(occurrence => occurrence.at.getTime() === key)) continue;
      const oStart = parseDateValue(firstProp(override, 'DTSTART'), { timeZone });
      if (!oStart) continue;
      const oEndProp = firstProp(override, 'DTEND');
      const oEnd = oEndProp ? parseDateValue(oEndProp, { timeZone })?.at : new Date(oStart.at.getTime() + spanMs);
      if (oStart.at < rangeEnd && oEnd > rangeStart && !exdates.has(key)) out.push(describe(override, oStart.at, oEnd, oStart.allDay, new Date(key).toISOString()));
    }
  }
  out.sort((left, right) => left.start - right.start);
  return { name, events: out };
}

// ── сборка VEVENT для отправки наружу ────────────────────────────────────
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 72) {
    let cut = 72;
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut), 'utf8') > 72) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}
function stamp(at) { return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function wallStamp({ year, month, day, hour = 0, minute = 0 }) {
  const pad = value => String(value).padStart(2, '0');
  return `${year}${pad(month)}${pad(day)}T${pad(hour)}${pad(minute)}00`;
}

// Событие со временем уходит в UTC (…Z): так его одинаково понимают Яндекс,
// Apple и Google, и не нужен VTIMEZONE. Событие на весь день — датой.
export function buildEvent({ uid, title, description = '', start, end, allDay = false, location = '', url = null, now = new Date() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kizuna//Calendar//RU', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(now)}`];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${wallStamp(start).slice(0, 8)}`, `DTEND;VALUE=DATE:${wallStamp(end).slice(0, 8)}`);
  } else {
    lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
  }
  lines.push(`SUMMARY:${escapeText(title)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// Правка чужого события по месту: меняются только начало, конец и, если
// просили, название; всё остальное — участники, напоминания, описание, чужие
// X-свойства — остаётся как было. Правится главный VEVENT (без RECURRENCE-ID):
// повторяющиеся события снаружи не правим вовсе, это решает вызывающий.
export function rewriteEvent(text, { title, start, end, allDay = false, now = new Date() }) {
  const lines = unfold(text);
  const out = [];
  let inEvent = false, isMaster = false, block = [];
  const flush = () => {
    if (!isMaster) { out.push(...block); block = []; return; }
    const keep = block.filter(line => !/^(DTSTART|DTEND|DURATION|DTSTAMP|LAST-MODIFIED|SEQUENCE)(;|:)/i.test(line) && !(title !== undefined && /^SUMMARY(;|:)/i.test(line)));
    const sequence = block.map(line => line.match(/^SEQUENCE:(\d+)/i)).find(Boolean);
    const summaryLine = title !== undefined ? `SUMMARY:${escapeText(title)}` : null;
    const timing = allDay
      ? [`DTSTART;VALUE=DATE:${wallStamp(start).slice(0, 8)}`, `DTEND;VALUE=DATE:${wallStamp(end).slice(0, 8)}`]
      : [`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`];
    const extra = [`DTSTAMP:${stamp(now)}`, `LAST-MODIFIED:${stamp(now)}`, `SEQUENCE:${(sequence ? Number(sequence[1]) : 0) + 1}`, ...timing, ...(summaryLine ? [summaryLine] : [])];
    const endIndex = keep.findIndex(line => /^END:VEVENT/i.test(line));
    out.push(...keep.slice(0, endIndex), ...extra, ...keep.slice(endIndex));
    block = [];
  };
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { inEvent = true; isMaster = true; block = [line]; continue; }
    if (inEvent) {
      block.push(line);
      if (/^RECURRENCE-ID(;|:)/i.test(line)) isMaster = false;
      if (/^END:VEVENT/i.test(line)) { inEvent = false; flush(); }
      continue;
    }
    out.push(line);
  }
  return out.filter(line => line !== '').map(fold).join('\r\n') + '\r\n';
}
