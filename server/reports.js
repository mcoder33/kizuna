// Отчёты по записям для страницы «Обзор»: агрегаты периода, сводка одного дня
// и служебная сторона (расходы, качество разбора). Всё считается по своим
// таблицам без обращений к модели. Правила зафиксированы концептом
// reports-concept.html: считаем по записям, а не по проекциям (переразбор не
// должен задваивать цифры), хвосты важнее графиков, пороги названы явно.

import { occursOn } from './repeat.js';
import { occurrencesByCapture } from './occurrences.js';
import { withSubtaskCounts } from './subtasks.js';

const COMPLETABLE = new Set(['task', 'meeting_event']);
const DAY_MS = 86400000;
// Проект считается заглохшим после двух недель тишины — порог из концепта.
export const STALLED_AFTER_DAYS = 14;
// Колонок пульса не больше полугода по неделям: дальше график перестаёт быть
// «быстрым взглядом», а итоги периода всё равно считаются по всем записям.
const PULSE_WEEKS_LIMIT = 26;

function zoneOffsetMinutes(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const value = type => Number(parts.find(part => part.type === type)?.value);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'));
  return (asUtc - at.getTime()) / 60000;
}
export function dateInZone(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
// Начало календарного дня в поясе как момент времени. Догадка от UTC-полуночи
// уточняется вторым замером — этого достаточно и при переводе часов.
export function dayStartInZone(date, timeZone) {
  const guess = new Date(`${date}T00:00:00Z`);
  const offset = zoneOffsetMinutes(timeZone, guess);
  const start = new Date(guess.getTime() - offset * 60000);
  const settled = zoneOffsetMinutes(timeZone, start);
  return settled === offset ? start : new Date(guess.getTime() - settled * 60000);
}
export function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function diffDays(later, earlier) {
  return Math.round((new Date(`${later}T12:00:00Z`) - new Date(`${earlier}T12:00:00Z`)) / DAY_MS);
}

// Последнее фактическое событие завершения по каждой проекции: как и в
// интерфейсе, побеждает последняя запись леджера.
function completionEvents(db) {
  const map = new Map();
  for (const row of db.prepare("SELECT projection_id, event_type, occurred_at FROM ledger_events WHERE projection_id IS NOT NULL AND event_type IN ('completed','completion_undone') ORDER BY rowid").iterate())
    map.set(row.projection_id, row);
  return map;
}

// Записи пользователя одной выборкой: активная классификация плюс состояние
// завершения. Закрыто — когда закрыты все завершаемые проекции записи
// (правило то же, что у карточек и TODO-буфера).
// subtasks: false — без подзадач: отчёты и «Сделано» считают дела, а подзадача
// стоит у родителя счётчиком «0/2». Помощнику журнала (journal.js) они видны.
export function loadEntries(db, userId, { subtasks = true } = {}) {
  const occurrences = occurrencesByCapture(db, userId);
  const rows = db.prepare(`SELECT c.id, c.created_at, c.occurred_at, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.deleted_at IS NULL${subtasks ? '' : ' AND c.subtask=0'} AND c.user_id IS ? ORDER BY c.created_at`).all(userId);
  const projections = db.prepare(`SELECT p.id, p.capture_id, p.projection_type FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.status='active' AND c.deleted_at IS NULL AND c.user_id IS ?`).all(userId);
  const completion = completionEvents(db);
  const byCapture = new Map();
  for (const projection of projections) {
    if (!COMPLETABLE.has(projection.projection_type)) continue;
    if (!byCapture.has(projection.capture_id)) byCapture.set(projection.capture_id, []);
    byCapture.get(projection.capture_id).push(projection);
  }
  return rows.map(row => {
    const classification = JSON.parse(row.classification_json);
    const completable = byCapture.get(row.id) || [];
    const closed = completable.length > 0 && completable.every(projection => completion.get(projection.id)?.event_type === 'completed');
    const closedAt = closed ? completable.map(projection => completion.get(projection.id).occurred_at).sort().at(-1) : null;
    const closedDays = [...(occurrences.get(row.id) || [])].map(([date, completedAt]) => ({ date, completedAt }));
    return { id: row.id, createdAt: row.created_at, occurredAt: row.occurred_at, classification, closed, closedAt, hasCompletable: completable.length > 0, projectionId: completable[0]?.id || null, occurrences: closedDays };
  });
}

function inRange(at, fromAt, toAt) { const time = new Date(at).getTime(); return time >= fromAt.getTime() && time < toAt.getTime(); }
function summaryOf(entry) { return entry.classification.summary || ''; }
function stampOf(entry) { return entry.occurredAt || entry.createdAt; }
function scheduleOf(entry) { return entry.classification.entities?.schedule || null; }
// Срок выпадает на день: сама дата или экземпляр повтора.
function onDate(schedule, date) { return Boolean(schedule?.date) && (schedule.date === date || occursOn(schedule, date)); }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function topCounts(map, limit) { return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit); }
function countInto(map, name, key = name.toLowerCase()) { const existing = map.get(key); if (existing) existing.count += 1; else map.set(key, { name, count: 1 }); }

function periodRange(period, today, entries) {
  if (period === 'week') return { from: shiftDate(today, -6), to: shiftDate(today, 1), prevFrom: shiftDate(today, -13), prevTo: shiftDate(today, -6), unit: 'day' };
  if (period === 'month') {
    const from = `${today.slice(0, 7)}-01`;
    const cursor = new Date(`${from}T12:00:00Z`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const to = `${cursor.toISOString().slice(0, 7)}-01`;
    cursor.setUTCMonth(cursor.getUTCMonth() - 2);
    return { from, to, prevFrom: `${cursor.toISOString().slice(0, 7)}-01`, prevTo: from, unit: 'day' };
  }
  const first = entries.length ? dateInZone(new Date(entries[0].createdAt), 'UTC') && null : null;
  return { from: null, to: shiftDate(today, 1), prevFrom: null, prevTo: null, unit: 'week' };
}

// Пульс: колонка на день (неделя, месяц) или на семидневку (всё время),
// внутри — раскладка по типам записей.
function buildPulse(entries, { from, to, unit, timeZone }) {
  const emptyTypes = () => ({ task: 0, meeting_event: 0, note: 0, outcome_decision: 0, idea_question: 0 });
  const columns = [];
  const index = new Map();
  const step = unit === 'week' ? 7 : 1;
  for (let date = from; date < to; date = shiftDate(date, step)) {
    const column = { date, total: 0, types: emptyTypes() };
    columns.push(column);
    for (let inner = 0; inner < step; inner += 1) index.set(shiftDate(date, inner), column);
  }
  for (const entry of entries) {
    const column = index.get(dateInZone(new Date(entry.createdAt), timeZone));
    if (!column) continue;
    column.total += 1;
    const type = entry.classification.primaryType;
    if (type in column.types) column.types[type] += 1;
  }
  return columns;
}

export function periodReport(db, { period, now, timeZone, userId }) {
  const entries = loadEntries(db, userId, { subtasks: false });
  const today = dateInZone(now, timeZone);
  let { from, to, prevFrom, prevTo, unit } = periodRange(period, today, entries);
  if (period === 'all') {
    from = entries.length ? dateInZone(new Date(entries[0].createdAt), timeZone) : today;
    if (unit === 'week' && diffDays(to, from) <= 45) unit = 'day';
  }
  // Колонки пульса ограничены; счётчики всё равно считаются по полному периоду.
  let pulseFrom = from;
  if (unit === 'week' && diffDays(to, from) > PULSE_WEEKS_LIMIT * 7) pulseFrom = shiftDate(to, -PULSE_WEEKS_LIMIT * 7);
  const fromAt = dayStartInZone(from, timeZone), toAt = dayStartInZone(to, timeZone);
  const inPeriod = entries.filter(entry => inRange(entry.createdAt, fromAt, toAt));
  const closedInPeriod = entries.filter(entry => entry.closed && entry.closedAt && inRange(entry.closedAt, fromAt, toAt));

  // Просрочено — снимок на сейчас, а не за период: хвост актуален всегда.
  const overdue = entries
    .filter(entry => entry.classification.primaryType === 'task' && !entry.closed && !entry.classification.completed && scheduleOf(entry)?.date && !scheduleOf(entry).repeat && scheduleOf(entry).date < today)
    .map(entry => ({ captureId: entry.id, title: summaryOf(entry), dueDate: scheduleOf(entry).date, daysLate: diffDays(today, scheduleOf(entry).date) }))
    .sort((a, b) => b.daysLate - a.daysLate);
  const questions = entries
    .filter(entry => entry.classification.primaryType === 'idea_question')
    .map(entry => ({ captureId: entry.id, title: summaryOf(entry), createdAt: entry.createdAt, daysOpen: diffDays(today, dateInZone(new Date(entry.createdAt), timeZone)) }))
    .sort((a, b) => b.daysOpen - a.daysOpen);

  // Встреча без следа: прошла, не закрыта чекбоксом, и после её даты нет ни
  // одной записи с теми же проектами или людьми. Встречи без проектов и людей
  // пропускаются — по ним следа не измерить.
  const silentMeetings = [];
  for (const entry of entries) {
    if (entry.classification.primaryType !== 'meeting_event' || entry.closed) continue;
    const date = scheduleOf(entry)?.date;
    if (!date || scheduleOf(entry).repeat || date >= today || date < from) continue;
    const marks = new Set([...(entry.classification.entities?.projects || []), ...(entry.classification.entities?.people || [])].map(value => value.toLowerCase()));
    if (!marks.size) continue;
    const trace = entries.some(later => later.id !== entry.id && later.createdAt > entry.createdAt && dateInZone(new Date(later.createdAt), timeZone) >= date &&
      [...(later.classification.entities?.projects || []), ...(later.classification.entities?.people || [])].some(value => marks.has(value.toLowerCase())));
    if (!trace) silentMeetings.push({ captureId: entry.id, title: summaryOf(entry), date });
  }
  silentMeetings.sort((a, b) => (a.date < b.date ? 1 : -1));

  const projects = new Map(), people = new Map(), tags = new Map();
  for (const entry of inPeriod) {
    for (const project of entry.classification.entities?.projects || []) countInto(projects, project);
    for (const person of entry.classification.entities?.people || []) countInto(people, person);
    for (const tag of entry.classification.tags || []) countInto(tags, tag);
  }
  // Заглохшие проекты — по всей истории: тишина не зависит от выбранного периода.
  const lastSeen = new Map();
  for (const entry of entries)
    for (const project of entry.classification.entities?.projects || []) {
      const key = project.toLowerCase(), date = dateInZone(new Date(entry.createdAt), timeZone);
      const known = lastSeen.get(key);
      if (known) { known.count += 1; if (date > known.date) known.date = date; }
      else lastSeen.set(key, { name: project, date, count: 1 });
    }
  const stalled = [...lastSeen.values()]
    .filter(project => project.count >= 2 && diffDays(today, project.date) >= STALLED_AFTER_DAYS)
    .map(project => ({ name: project.name, daysQuiet: diffDays(today, project.date) }))
    .sort((a, b) => a.daysQuiet - b.daysQuiet)
    .slice(0, 5);

  const closedTasks = closedInPeriod.filter(entry => entry.classification.primaryType === 'task');
  const lifeDays = closedInPeriod.map(entry => (new Date(entry.closedAt) - new Date(entry.createdAt)) / DAY_MS).filter(days => days >= 0);
  const withDue = closedInPeriod.filter(entry => scheduleOf(entry)?.date);
  const onTime = withDue.filter(entry => dateInZone(new Date(entry.closedAt), timeZone) <= scheduleOf(entry).date);
  const medianLife = median(lifeDays);

  const prevCaptures = prevFrom === null ? null : entries.filter(entry => inRange(entry.createdAt, dayStartInZone(prevFrom, timeZone), dayStartInZone(prevTo, timeZone))).length;

  return {
    period, timeZone, today, from, to,
    counters: {
      done: closedTasks.length,
      captures: inPeriod.length,
      capturesPrev: prevCaptures,
      overdue: overdue.length,
      overdueOldestDays: overdue[0]?.daysLate ?? null,
      questions: questions.length,
      questionsOldestDays: questions[0]?.daysOpen ?? null,
    },
    pulse: { unit, from: pulseFrom, columns: buildPulse(inPeriod, { from: pulseFrom, to, unit, timeZone }) },
    overdue: overdue.slice(0, 8),
    questions: questions.slice(0, 8),
    silentMeetings: silentMeetings.slice(0, 8),
    projects: topCounts(projects, 6),
    people: topCounts(people, 8),
    tags: topCounts(tags, 10),
    stalled,
    discipline: {
      closed: closedInPeriod.length,
      medianDays: medianLife === null ? null : Math.round(medianLife * 10) / 10,
      withDue: withDue.length,
      onTime: onTime.length,
    },
    service: serviceReport(db, { fromAt, toAt, userId }),
  };
}

// Служебная сторона: расходы и качество разбора за тот же период.
function serviceReport(db, { fromAt, toAt, userId }) {
  const scope = userId === undefined ? [] : [userId];
  const from = fromAt.toISOString(), to = toAt.toISOString();
  const usageRows = db.prepare(`SELECT provider, model, COUNT(*) calls, SUM(COALESCE(cost_usd,0)) cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) unpriced FROM usage_events WHERE created_at >= ? AND created_at < ? ${userId === undefined ? '' : 'AND user_id IS ?'} GROUP BY provider, model ORDER BY cost DESC, calls DESC`).all(from, to, ...scope);
  const corrections = db.prepare(`SELECT co.correction_json FROM corrections co JOIN captures c ON c.id = co.capture_id WHERE co.created_at >= ? AND co.created_at < ? ${userId === undefined ? '' : 'AND c.user_id IS ?'}`).all(from, to, ...scope);
  const fields = new Map();
  for (const row of corrections)
    try { for (const field of Object.keys(JSON.parse(row.correction_json) || {})) fields.set(field, (fields.get(field) || 0) + 1); } catch {}
  const topField = [...fields.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  // Переразбор — новая версия от настоящего провайдера; правки руками приходят
  // как provider='manual' и посчитаны отдельной строкой выше.
  const reclassified = db.prepare(`SELECT COUNT(*) n FROM interpretations i JOIN captures c ON c.id = i.capture_id WHERE i.version > 1 AND i.provider != 'manual' AND i.created_at >= ? AND i.created_at < ? ${userId === undefined ? '' : 'AND c.user_id IS ?'}`).get(from, to, ...scope).n;
  const pendingNow = db.prepare(`SELECT COUNT(*) n FROM capture_jobs WHERE state IN ('pending','running') ${userId === undefined ? '' : 'AND user_id IS ?'}`).get(...scope).n;
  const failed = db.prepare(`SELECT COUNT(*) n FROM capture_jobs WHERE state = 'failed' AND created_at >= ? AND created_at < ? ${userId === undefined ? '' : 'AND user_id IS ?'}`).get(from, to, ...scope).n;
  // Точность по провайдерам: сколько разборов сделал и сколько из них пришлось
  // править. Правка привязана к интерпретации; провайдер ошибки — у той версии,
  // которую правка заменила.
  const parses = db.prepare(`SELECT i.provider, COUNT(*) n FROM interpretations i JOIN captures c ON c.id = i.capture_id WHERE i.provider NOT IN ('manual') AND i.created_at >= ? AND i.created_at < ? ${userId === undefined ? '' : 'AND c.user_id IS ?'} GROUP BY i.provider`).all(from, to, ...scope);
  const corrected = db.prepare(`SELECT COALESCE(prev.provider, ni.provider) provider, COUNT(*) n FROM corrections co JOIN captures c ON c.id = co.capture_id JOIN interpretations ni ON ni.id = co.interpretation_id LEFT JOIN interpretations prev ON prev.id = ni.supersedes_id WHERE co.created_at >= ? AND co.created_at < ? ${userId === undefined ? '' : 'AND c.user_id IS ?'} GROUP BY 1`).all(from, to, ...scope);
  const correctedBy = new Map(corrected.map(row => [row.provider, row.n]));
  return {
    usage: {
      calls: usageRows.reduce((total, row) => total + row.calls, 0),
      costUsd: usageRows.reduce((total, row) => total + row.cost, 0),
      unpriced: usageRows.reduce((total, row) => total + row.unpriced, 0),
      rows: usageRows.map(row => ({ provider: row.provider, model: row.model, calls: row.calls, costUsd: row.cost })).slice(0, 6),
    },
    quality: {
      corrections: corrections.length,
      topField: topField ? { field: topField[0], count: topField[1] } : null,
      reclassified, pendingNow, failed,
      providers: parses.map(row => ({ provider: row.provider, parses: row.n, corrections: correctedBy.get(row.provider) || 0 })),
    },
  };
}

export function dayReport(db, { date, now, timeZone, userId }) {
  const entries = loadEntries(db, userId, { subtasks: false });
  const today = dateInZone(now, timeZone);
  const startAt = dayStartInZone(date, timeZone), endAt = dayStartInZone(shiftDate(date, 1), timeZone);
  const feed = entries
    .filter(entry => inRange(stampOf(entry), startAt, endAt))
    .map(entry => ({ captureId: entry.id, title: summaryOf(entry), type: entry.classification.primaryType, at: stampOf(entry) }));
  // «Сделано» — зафиксированная работа этого дня, тот же источник, что и «Что
  // делал»: classification.completed === true. Снятая галочкой задача — это уход
  // из TODO, а не запись в дневник, поэтому сюда не попадает (живёт в журнале TODO).
  const done = entries
    // Новая «сделал X» — туду, закрытая при записи: раскрытая заново кружком она
    // из дневника уходит, как и любая снятая галочкой задача.
    .filter(entry => entry.classification.completed === true && (entry.closed || !entry.hasCompletable) && inRange(stampOf(entry), startAt, endAt))
    .map(entry => ({ captureId: entry.id, title: summaryOf(entry), type: entry.classification.primaryType, at: stampOf(entry) }));
  // Экземпляр повтора, закрытый кружком в этот день, — тоже сделанное.
  for (const entry of entries) for (const item of entry.occurrences) if (inRange(item.completedAt, startAt, endAt)) done.push({ captureId: entry.id, title: summaryOf(entry), type: entry.classification.primaryType, at: item.completedAt, occurrence: item.date });
  done.sort((a, b) => (a.at < b.at ? -1 : 1));
  // У закрытого дела с подзадачами — их счёт, как в «Закрыто» на «Сегодня».
  withSubtaskCounts(db, done, userId, { today, key: 'captureId' });
  // Не успел: срок был в этот день, к концу дня не закрыто. Если закрыли позже —
  // так и говорим, это честнее, чем молча убрать строку из прошлого дня.
  const missed = entries
    .filter(entry => entry.classification.primaryType === 'task' && !entry.classification.completed && onDate(scheduleOf(entry), date) && date < today && !(entry.closed && entry.closedAt && new Date(entry.closedAt) < endAt))
    .map(entry => ({ captureId: entry.id, title: summaryOf(entry), closedLater: entry.closed }));
  const meetings = entries.filter(entry => entry.classification.primaryType === 'meeting_event' && onDate(scheduleOf(entry), date)).length;
  // Назад можно, пока за показанным днём есть записи; с сегодняшнего дня —
  // всегда хотя бы на вчера, иначе у свежего журнала стрелка мертва.
  const hasOlder = entries.some(entry => new Date(entry.createdAt) < startAt) || date === today;
  // Крайний день — сегодняшний: он ещё идёт, но «что сделано к этому часу»
  // спрашивают именно днём. По умолчанию открывается вчера — законченный день.
  return { date, timeZone, latest: today, hasOlder, meetings, done, missed, feed };
}

export function servicePeriodReport(db, { period, now, timeZone }) {
  const today = dateInZone(now, timeZone);
  const { from, to } = periodRange(period, today, []);
  return serviceReport(db, { fromAt: from ? dayStartInZone(from, timeZone) : new Date(0), toAt: dayStartInZone(to, timeZone) });
}
