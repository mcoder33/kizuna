// «Сделано»: одна лента закрытого — туду, закрытые кружком (и «сделал X»,
// закрытое при записи), встречи из календаря, которые уже закончились, и
// старые отчёты о сделанном, чтобы история не пропала. Ничего не хранится
// отдельно: закрытые туду читаются из леджера, встречи — из календаря.
import { dateInZone, loadEntries, shiftDate } from './reports.js';
import { DEFAULT_COLUMN } from './board.js';
import { withSubtaskCounts } from './subtasks.js';

const OTHER_COLUMN = 'Без колонки';
export const MEETINGS_COLUMN = 'Встречи';

function timeInZone(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('hour')}:${value('minute')}`;
}

// Название колонки, в которой туду лежит на доске: размещение, иначе — первая
// колонка (так же, как boardView раскладывает карточки без места).
function columnNames(db, userId) {
  const columns = db.prepare('SELECT id, name FROM board_columns WHERE user_id IS ? ORDER BY position, created_at').all(userId);
  const known = new Map(columns.map(column => [column.id, column.name]));
  const first = columns[0]?.name || DEFAULT_COLUMN;
  const placements = new Map(db.prepare('SELECT capture_id, column_id FROM board_placements WHERE user_id IS ?').all(userId).map(row => [row.capture_id, row.column_id]));
  return captureId => known.get(placements.get(captureId)) || first;
}

// Встреча закончилась, если её конец уже позади: по дате конца и, в тот же
// день, по времени. События на весь день встречами не считаются.
function meetingsOf(calendar, { userId, from, to, today, nowTime }) {
  if (!calendar || typeof calendar.view !== 'function') return [];
  let view;
  try { view = calendar.view({ userId, from, to }); } catch { return []; }
  const out = [];
  for (const item of view?.external || []) {
    if (item.allDay || item.me?.status === 'declined' || item.title === 'Занято' || !item.date) continue;
    const endDate = item.endDate || item.date;
    const endTime = (endDate !== item.date && item.endTime) || item.end || item.time || '23:59';
    if (endDate > today || (endDate === today && endTime > nowTime)) continue;
    // Встреча через полночь закрывается в день и час конца, а не начала.
    out.push({ id: item.id, title: item.title || 'Встреча', date: endDate, time: endTime });
  }
  return out;
}

// only: 'byDay' — клиенту нужен один счёт по дням (пилюля метрики дня смотрит на
// тридцать дней назад), а строки дел за месяц ему ни к чему: ответ идёт без days
// и byColumn, числа считаются тем же кодом и потому совпадают с обычным ответом.
export function doneView(db, { userId, from, to, now = new Date(), timeZone = 'Europe/Samara', calendar = null, only = null } = {}) {
  const today = dateInZone(now, timeZone);
  const inRange = date => date >= from && date <= to;
  const columnOf = columnNames(db, userId);
  const items = [];
  // Закрытая подзадача отдельной строкой не стоит: она входит в счёт родителя («1/2»).
  for (const entry of loadEntries(db, userId, { subtasks: false })) {
    const title = entry.classification.summary || '';
    const meeting = entry.classification.primaryType === 'meeting_event';
    if (entry.closed && entry.closedAt) {
      const at = new Date(entry.closedAt);
      const date = dateInZone(at, timeZone);
      if (inRange(date)) items.push({ id: entry.id, title, date, time: timeInZone(at, timeZone), kind: meeting ? 'meeting' : 'todo', column: meeting ? MEETINGS_COLUMN : columnOf(entry.id), auto: false, projectionId: entry.projectionId });
    } else if (entry.classification.completed === true && !entry.hasCompletable) {
      // Старый отчёт о сделанном: без проекции-дела, его день — occurred_at.
      const at = new Date(entry.occurredAt || entry.createdAt);
      const date = dateInZone(at, timeZone);
      if (inRange(date)) items.push({ id: entry.id, title, date, time: timeInZone(at, timeZone), kind: 'todo', column: OTHER_COLUMN, auto: false, legacy: true });
    }
    // Экземпляр повтора, закрытый кружком, — сделанное в тот день; сама запись открыта.
    for (const item of entry.occurrences) {
      const at = new Date(item.completedAt), date = dateInZone(at, timeZone);
      if (inRange(date)) items.push({ id: entry.id, title, date, time: timeInZone(at, timeZone), kind: 'todo', column: columnOf(entry.id), auto: false, projectionId: entry.projectionId, occurrence: item.date });
    }
  }
  // У закрытого дела с подзадачами — их счёт; у встреч из календаря и старых отчётов их нет.
  withSubtaskCounts(db, items.filter(item => !item.legacy), userId, { today });
  for (const meeting of meetingsOf(calendar, { userId, from, to, today, nowTime: timeInZone(now, timeZone) }))
    if (inRange(meeting.date)) items.push({ id: meeting.id, title: meeting.title, date: meeting.date, time: meeting.time, kind: 'meeting', column: MEETINGS_COLUMN, auto: true });

  const byDate = new Map();
  for (const item of items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    const { date, ...rest } = item;
    byDate.get(item.date).push(rest);
  }
  const byDay = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) byDay.push({ date, n: byDate.get(date)?.length || 0 });
  const counts = { today: byDate.get(today)?.length || 0, period: items.length, meetings: items.filter(item => item.kind === 'meeting').length };
  if (only === 'byDay') return { from, to, today, counts, byDay };
  const days = [...byDate.keys()].sort().reverse().map(date => ({ date, items: byDate.get(date).sort((left, right) => right.time.localeCompare(left.time)) }));

  const columns = new Map();
  for (const item of items) columns.set(item.column, (columns.get(item.column) || 0) + 1);
  const byColumn = [...columns].map(([name, n]) => ({ name, n })).sort((left, right) => right.n - left.n || left.name.localeCompare(right.name, 'ru'));
  return { from, to, today, days, counts, byColumn, byDay };
}
