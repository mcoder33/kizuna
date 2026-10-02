import { resolveLocale, SUPPORTED_LOCALES, translate, formatDate } from '../public/i18n.js';

export function userLocale(db, userId, preferred = []) {
  const read = name => userId ? db.prepare('SELECT value FROM app_settings WHERE key=?').get(`user:${userId}:${name}`)?.value : null;
  return resolveLocale(read('locale') || 'system', [...preferred, read('detectedLocale')]);
}
export function requestLanguages(header = '') {
  return String(header).split(',').map((part, index) => {
    const [language, quality] = part.trim().split(';');
    return { language, quality: quality?.startsWith('q=') ? Number(quality.slice(2)) : 1, index };
  }).filter(item => item.quality > 0 && item.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index).map(item => item.language);
}
export const validLocaleSetting = value => value === 'system' || SUPPORTED_LOCALES.includes(value);
export const validDetectedLocale = value => SUPPORTED_LOCALES.includes(value);

// Presentation only: dates/frequencies remain the original structured values.
export function localizedDay(locale, date, today = null) {
  if (date === today) return translate(locale,'сегодня');
  if (today) {
    const delta = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000;
    if (delta === 1) return translate(locale,'завтра');
    if (delta === -1) return translate(locale,'вчера');
  }
  return formatDate(locale,new Date(`${date}T12:00:00Z`),{day:'numeric',month:'long',timeZone:'UTC'});
}
export function localizedRepeat(locale, repeat) {
  if (!repeat) return null;
  const sources = {daily:'каждые {count} дня',weekly:'каждые {count} недели',monthly:'каждые {count} месяца',yearly:'каждые {count} года'};
  if (!sources[repeat.freq]) return null;
  const t = (source,params) => translate(locale,source,params);
  const text = t(sources[repeat.freq],{count:repeat.interval || 1});
  return repeat.until ? t('{repeat} до {date}',{repeat:text,date:localizedDay(locale,repeat.until)}) : text;
}
export function localizedCalendarWhen(locale, schedule) {
  const day = formatDate(locale,new Date(schedule.startAt),{day:locale === 'ru' ? '2-digit' : 'numeric',month:locale === 'ru' ? '2-digit' : 'long',timeZone:schedule.allDay ? 'UTC' : schedule.timeZone});
  if (schedule.allDay) return translate(locale,'{day}, весь день',{day});
  const clock = value => formatDate(locale,new Date(value),{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:schedule.timeZone});
  const dayOf = value => formatDate('en',new Date(value),{year:'numeric',month:'2-digit',day:'2-digit',timeZone:schedule.timeZone});
  return `${day}, ${clock(schedule.startAt)}${dayOf(schedule.startAt) === dayOf(schedule.endAt) ? `–${clock(schedule.endAt)}` : ''}`;
}
