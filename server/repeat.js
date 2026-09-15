// Повтор дела или встречи — свойство срока (`entities.schedule.repeat`), как
// напоминание: {freq, interval, until}. Повторы разворачиваются по датам, а
// время у всех экземпляров одно — из срока. Убранные экземпляры («удалить
// только этот повтор») лежат в `schedule.skip` датами. Наружу — в Яндекс,
// Apple и Google — правило уходит как RRULE, убранные экземпляры — как EXDATE.
import { expandRrule } from './ics.js';

// Своя копия сдвига даты: reports.js сам импортирует этот модуль, а кольцо
// импортов ни к чему.
function shiftDate(date, days) { const at = new Date(`${date}T12:00:00Z`); at.setUTCDate(at.getUTCDate() + days); return at.toISOString().slice(0, 10); }

export const REPEAT_FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
export const REPEAT_INTERVAL_MAX = 99;
export const SKIP_LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const FREQ_RRULE = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

export function validIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}
const utcOf = date => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
export function dayDiff(from, to) { return Math.round((utcOf(to) - utcOf(from)) / DAY_MS); }

// Правило в нормальном виде: {freq, interval, until|null}. null — повтора нет,
// undefined — правило испорчено (не тот freq, интервал вне 1…99, кривая дата).
export function normalizeRepeat(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const freq = typeof value.freq === 'string' ? value.freq.toLowerCase() : '';
  if (!REPEAT_FREQS.includes(freq)) return undefined;
  const interval = value.interval === undefined || value.interval === null || value.interval === '' ? 1 : Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > REPEAT_INTERVAL_MAX) return undefined;
  const until = value.until === undefined || value.until === null || value.until === '' ? null : value.until;
  if (until !== null && !validIsoDate(until)) return undefined;
  return { freq, interval, until };
}
export function validRepeat(value) { return value === null || value === undefined || normalizeRepeat(value) !== undefined; }
export function validSkip(value) { return value === undefined || value === null || (Array.isArray(value) && value.length <= SKIP_LIMIT && value.every(validIsoDate)); }
export function normalizeSkip(value) { return [...new Set((Array.isArray(value) ? value : []).filter(validIsoDate))].sort(); }

function ruleOf(repeat) {
  return { freq: FREQ_RRULE[repeat.freq], interval: repeat.interval, count: null, until: repeat.until ? new Date(utcOf(repeat.until)) : null, byDay: null, byMonthDay: null, byMonth: null, weekStart: 1 };
}
// Ежедневный и еженедельный повтор считается от ближайшего к окну периода, а
// не от первого дня: дело, заведённое три года назад, иначе упёрлось бы в
// предел разворота, не дойдя до сегодняшних дат. Для месяца и года периодов
// мало, там разворот идёт от начала.
function nearBase(schedule, repeat, from) {
  const period = repeat.freq === 'daily' ? repeat.interval : repeat.freq === 'weekly' ? 7 * repeat.interval : 0;
  if (!period) return schedule.date;
  const behind = dayDiff(schedule.date, from);
  if (behind <= period) return schedule.date;
  return shiftDate(schedule.date, Math.floor(behind / period) * period);
}
// Даты экземпляров в окне [from, to] включительно, без убранных.
export function occurrenceDates(schedule, from, to, { limit = 400 } = {}) {
  const repeat = normalizeRepeat(schedule?.repeat);
  if (!repeat || !validIsoDate(schedule.date) || !validIsoDate(from) || !validIsoDate(to) || from > to) return [];
  if (repeat.until && repeat.until < from) return [];
  if (to < schedule.date) return [];
  const start = from > schedule.date ? nearBase(schedule, repeat, from) : schedule.date;
  const [year, month, day] = start.split('-').map(Number);
  const exdates = new Set(normalizeSkip(schedule.skip).map(utcOf));
  const found = expandRrule(ruleOf(repeat), { wall: { year, month, day, hour: 0, minute: 0, second: 0 }, allDay: true }, { rangeStart: new Date(utcOf(from)), rangeEnd: new Date(utcOf(to) + DAY_MS), exdates });
  return found.slice(0, limit).map(({ wall }) => `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`);
}
export function occursOn(schedule, date) { return occurrenceDates(schedule, date, date, { limit: 1 }).length > 0; }
// Ближайший экземпляр не раньше даты: для доски, отчётов и напоминаний.
export function nextOccurrence(schedule, from) {
  if (!schedule?.repeat) return null;
  return occurrenceDates(schedule, from, shiftDate(from, 366 * 100), { limit: 1 })[0] || null;
}
// Дата, по которой дело живёт в списках: у повтора — ближайший экземпляр,
// у обычного срока — сама дата.
export function effectiveDate(schedule, today) {
  if (!schedule?.date) return null;
  return schedule.repeat ? nextOccurrence(schedule, today) : schedule.date;
}

// Правило словами — для плашки, карточки и тоста.
const WORDS = { daily: ['каждый день', 'дня', 'дней'], weekly: ['каждую неделю', 'недели', 'недель'], monthly: ['каждый месяц', 'месяца', 'месяцев'], yearly: ['каждый год', 'года', 'лет'] };
export function describeRepeat(value, { until = true } = {}) {
  const repeat = normalizeRepeat(value);
  if (!repeat) return null;
  const [one, few, many] = WORDS[repeat.freq];
  let text = repeat.interval === 1 ? one : `каждые ${repeat.interval} ${repeat.interval < 5 ? few : many}`;
  if (until && repeat.until) text += ` до ${repeat.until.slice(8, 10)}.${repeat.until.slice(5, 7)}.${repeat.until.slice(0, 4)}`;
  return text;
}
// Строка срока: дата, время, конец и повтор словами — одна на все места,
// где срок пишется текстом.
export function scheduleDisplay({ date = null, time = null, end = null, repeat = null } = {}) {
  const text = [date, time].filter(Boolean).join(', ') + (time && end ? `–${end}` : '');
  const words = describeRepeat(repeat);
  return words ? `${text}, ${words}` : text;
}

// RRULE для VEVENT и Google. У события со временем UNTIL — момент UTC
// последнего возможного начала (untilAt), у события на весь день — дата.
export function repeatRrule(value, { allDay = false, untilAt = null } = {}) {
  const repeat = normalizeRepeat(value);
  if (!repeat) return null;
  const parts = [`FREQ=${FREQ_RRULE[repeat.freq]}`];
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
  if (repeat.until) {
    const plain = repeat.until.replace(/-/g, '');
    parts.push(`UNTIL=${allDay ? plain : untilAt instanceof Date ? untilAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') : `${plain}T235959Z`}`);
  }
  return parts.join(';');
}
