// Напоминания по делам и встречам. Напоминание — свойство срока
// (`entities.schedule.remind`), а не отдельная сущность: перенос дела двигает
// и напоминание, снятие срока снимает его. Что и когда слать, решает сервер:
// раз в полминуты воркер собирает открытые дела со сроком, считает момент
// напоминания и отдаёт в доставку то, чей момент наступил. Журнал отправок
// (`reminder_sends`) не даёт уйти дважды и не догоняет человека через сутки
// после простоя: пропущенное дольше часа помечается «missed» и молчит.
import { dateInZone, shiftDate } from './reports.js';
import { zonedToUtc } from './ics.js';
import { completionEvents } from './board.js';
import { occurrenceDates } from './repeat.js';

export const REMIND_MAX_MINUTES = 7 * 24 * 60;
export const REMIND_DEFAULT_HOUR = '09:00';

// Явное напоминание у срока: число минут до начала или «off».
export function validRemind(value) {
  return value === 'off' || (Number.isInteger(value) && value >= 0 && value <= REMIND_MAX_MINUTES);
}
// Настройка по умолчанию для дел со временем: минуты или «off».
export function parseRemindMinutes(value) {
  if (value === 'off' || value === null || value === undefined || value === '') return 'off';
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= REMIND_MAX_MINUTES ? minutes : 'off';
}
export function validRemindHour(value) { return value === 'off' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)); }

function wallOf(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return { year, month, day, hour, minute };
}

// Момент напоминания. У дела со временем — за N минут до начала (N — из
// срока или из настройки). У дела без времени срок — конец дня, и «за 15
// минут до 23:59» бессмысленно: такое дело напоминает о себе в час
// напоминаний из настроек; явное число минут у него значит «напомнить в этот
// час», а не «за столько-то».
export function remindMoment(schedule, { timeZone, defaults = {} }) {
  if (!schedule?.date) return null;
  const explicit = validRemind(schedule.remind) ? schedule.remind : undefined;
  if (explicit === 'off') return null;
  if (schedule.time) {
    const minutes = explicit !== undefined ? explicit : parseRemindMinutes(defaults.minutes);
    if (minutes === 'off') return null;
    return new Date(zonedToUtc(wallOf(schedule.date, schedule.time), timeZone).getTime() - minutes * 60000);
  }
  const hour = validRemindHour(defaults.hour) ? defaults.hour : REMIND_DEFAULT_HOUR;
  if (hour === 'off' && explicit === undefined) return null;
  return zonedToUtc(wallOf(schedule.date, hour === 'off' ? REMIND_DEFAULT_HOUR : hour), timeZone);
}

function humanMinutes(minutes) {
  if (minutes % 1440 === 0) { const days = minutes / 1440; return days === 1 ? 'день' : `${days} дн.`; }
  if (minutes % 60 === 0) { const hours = minutes / 60; return hours === 1 ? 'час' : `${hours} ч`; }
  return `${minutes} мин`;
}
function dayWord(date, today) {
  if (date === today) return 'сегодня';
  if (date === shiftDate(today, 1)) return 'завтра';
  if (date === shiftDate(today, -1)) return 'вчера';
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

export function createReminderService({ db, now = () => new Date(), timeZone = () => 'UTC', settingsFor = () => ({}), deliver = async () => {}, audit = () => {}, graceMs = 60 * 60 * 1000, lookbackMs = 7 * 24 * 60 * 60 * 1000 }) {
  // Открытые дела и встречи со сроком у всех людей сразу: журнал личный и
  // небольшой, обход раз в полминуты дешевле, чем следить за каждой правкой.
  function candidates() {
    const rows = db.prepare(`SELECT c.id, c.user_id, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
      WHERE c.deleted_at IS NULL AND c.user_id IS NOT NULL AND i.classification_json LIKE '%"schedule":{%'`).all();
    const byCapture = new Map();
    for (const projection of db.prepare(`SELECT id, capture_id FROM projections WHERE status='active' AND projection_type IN ('task','meeting_event')`).all()) {
      if (!byCapture.has(projection.capture_id)) byCapture.set(projection.capture_id, []);
      byCapture.get(projection.capture_id).push(projection.id);
    }
    const completion = completionEvents(db);
    const tz = timeZone();
    const today = dateInZone(now(), tz);
    const out = [];
    for (const row of rows) {
      const ids = byCapture.get(row.id);
      if (!ids?.length) continue;
      let classification;
      try { classification = JSON.parse(row.classification_json); } catch { continue; }
      if (classification.completed === true || !['task', 'meeting_event'].includes(classification.primaryType)) continue;
      if (ids.every(id => completion.get(id)?.type === 'completed')) continue;
      const schedule = classification.entities?.schedule;
      // У повтора напоминание считается по экземплярам: ближайшие несколько
      // от вчерашнего дня (пропущенное за простоем ещё может догнать) —
      // каждому свой момент, а значит и своя запись в журнале отправок.
      const schedules = schedule?.repeat ? occurrenceDates(schedule, shiftDate(today, -1), shiftDate(today, 8), { limit: 3 }).map(date => ({ ...schedule, date })) : [schedule];
      for (const each of schedules) {
        const remindAt = remindMoment(each, { timeZone: tz, defaults: settingsFor(row.user_id) });
        if (!remindAt) continue;
        out.push({ userId: row.user_id, captureId: row.id, title: classification.summary || '(без названия)', type: classification.primaryType, schedule: each, remindAt });
      }
    }
    return out;
  }
  function describe(item, at) {
    const tz = timeZone();
    const today = dateInZone(at, tz);
    const { schedule } = item;
    const when = schedule.time ? `${dayWord(schedule.date, today)}, ${schedule.time}${schedule.end ? `–${schedule.end}` : ''}` : dayWord(schedule.date, today);
    const start = schedule.time ? zonedToUtc(wallOf(schedule.date, schedule.time), tz) : null;
    const leadMinutes = start ? Math.max(0, Math.round((start.getTime() - item.remindAt.getTime()) / 60000)) : null;
    const lead = leadMinutes === null ? null : leadMinutes === 0 ? 'сейчас' : `через ${humanMinutes(leadMinutes)}`;
    const kind = item.type === 'meeting_event' ? 'Встреча' : 'Дело';
    return { captureId: item.captureId, title: item.title, type: item.type, date: schedule.date, time: schedule.time || null, end: schedule.end || null, remindAt: item.remindAt.toISOString(), when, lead, body: `${kind} · ${when}${lead ? ` · ${lead}` : ''}` };
  }
  // Что впереди у человека: для карточки и настроек, чтобы видеть, когда
  // именно напомнит.
  function upcoming(userId, { limit = 20 } = {}) {
    const at = now();
    return candidates().filter(item => item.userId === userId && item.remindAt >= at).sort((left, right) => left.remindAt - right.remindAt).slice(0, limit).map(item => describe(item, at));
  }
  function momentFor(userId, schedule) { return remindMoment(schedule, { timeZone: timeZone(), defaults: settingsFor(userId) }); }
  const seen = db.prepare('SELECT status FROM reminder_sends WHERE capture_id=? AND remind_at=?');
  const record = db.prepare('INSERT OR IGNORE INTO reminder_sends(capture_id, remind_at, user_id, status, title, created_at) VALUES(?,?,?,?,?,?)');
  async function tick() {
    const at = now();
    const sent = [];
    for (const item of candidates()) {
      if (item.remindAt > at) continue;
      const age = at.getTime() - item.remindAt.getTime();
      if (age > lookbackMs) continue;
      const key = item.remindAt.toISOString();
      if (seen.get(item.captureId, key)) continue;
      const status = age > graceMs ? 'missed' : 'sent';
      record.run(item.captureId, key, item.userId, status, item.title, at.toISOString());
      if (status === 'missed') { audit({ event: 'reminder_missed', captureId: item.captureId }); continue; }
      const reminder = describe(item, at);
      try { await deliver({ userId: item.userId, reminder }); audit({ event: 'reminder_sent', captureId: item.captureId }); }
      catch (error) { audit({ event: 'reminder_delivery_failed', captureId: item.captureId, errorCode: error?.code || 'delivery_error' }); }
      sent.push(reminder);
    }
    return sent;
  }
  return { candidates, upcoming, momentFor, tick };
}

// Фоновый обход, как у календаря: один поток, без гонок; остановка ждёт
// начатый проход, но недолго.
export class ReminderWorker {
  constructor({ service, pollMs = 30_000, audit = () => {} }) {
    this.service = service; this.pollMs = pollMs; this.audit = audit;
    this.timer = null; this.running = false; this.inFlight = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (this.inFlight) return;
      this.inFlight = this.service.tick()
        .catch(error => { try { this.audit({ event: 'reminder_tick_failed', errorCode: error?.code || 'tick_error' }); } catch {} })
        .finally(() => { this.inFlight = null; });
    };
    this.timer = setInterval(tick, this.pollMs);
    this.timer.unref?.();
    setTimeout(tick, 2000).unref?.();
  }
  async stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.inFlight) await Promise.race([this.inFlight, new Promise(resolve => setTimeout(resolve, 3000).unref?.())]);
  }
}
