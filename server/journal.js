// Карта журнала: что у человека вообще есть — проекты, типы, признаки, люди,
// теги — и выборка записей по любому из этих признаков.
//
// Зачитать голосу весь журнал нельзя, и незачем: чтобы сориентироваться, нужна
// не тысяча строк, а карта — сколько чего, какие проекты живые, что горит и как
// называются вещи. Карта уходит в голову разговора один раз при открытии;
// дальше модель берёт списком ровно то, что спросили, а не гадает по одной
// записи за раз.
import { dateInZone, shiftDate, loadEntries, STALLED_AFTER_DAYS } from './reports.js';
import { normalizeMemoryText } from './db.js';
import { occursOn, nextOccurrence } from './repeat.js';

export const TYPE_NAMES = { meeting_event:'встреча', task:'задача', note:'заметка', outcome_decision:'результат', idea_question:'идея' };
// Имена типов в инструментах: человек говорит «дела», «встречи», «идеи», а в
// журнале они зовутся иначе. Принимаем оба написания — модель не должна
// запоминать нашу внутреннюю разметку.
export const FILTER_TYPES = {
  todo:'task', task:'task', задача:'task', дело:'task',
  meeting:'meeting_event', meeting_event:'meeting_event', встреча:'meeting_event',
  note:'note', заметка:'note',
  outcome:'outcome_decision', outcome_decision:'outcome_decision', результат:'outcome_decision',
  idea:'idea_question', idea_question:'idea_question', идея:'idea_question', вопрос:'idea_question',
};
const OPEN_TYPES = new Set(['task','meeting_event']);
const DAY_MS = 86400000;

const scheduleOf = entry => entry.classification.entities?.schedule || null;
const titleOf = entry => entry.classification.summary || '';
const diffDays = (later, earlier) => Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS);
// Открыто — то, что ещё предстоит: дело или встреча, не закрытая ни чекбоксом,
// ни признаком «сделано».
const isOpen = entry => OPEN_TYPES.has(entry.classification.primaryType) && !entry.closed && !entry.classification.completed;
// Просрочено — по тому же правилу, что и в отчётах: разовое дело со сроком в
// прошлом. У повтора срок переезжает сам, просрочки у него не бывает.
function isOverdue(entry, today) {
  const schedule = scheduleOf(entry);
  return entry.classification.primaryType === 'task' && isOpen(entry) && Boolean(schedule?.date) && !schedule.repeat && schedule.date < today;
}
// Приходится ли срок на этот день — с учётом повтора.
const onDate = (schedule, date) => Boolean(schedule?.date) && (schedule.repeat ? occursOn(schedule, date) : schedule.date === date);
// Ближайший день, когда запись всплывёт: у повтора — следующий экземпляр.
function dueDate(entry, today) {
  const schedule = scheduleOf(entry);
  if (!schedule?.date) return null;
  if (!schedule.repeat) return schedule.date;
  return nextOccurrence(schedule, today) || schedule.date;
}

function countInto(map, name) {
  const key = normalizeMemoryText(name);
  if (!key) return;
  const existing = map.get(key);
  if (existing) existing.count += 1;
  else map.set(key, { name, count: 1 });
}
const top = (map, limit) => [...map.values()].sort((left, right) => right.count - left.count).slice(0, limit);

/**
 * Карта журнала одним ответом: сколько чего, какие проекты, кто, чем помечено.
 * Списки подрезаны — это карта, а не выгрузка: за подробностями идут в
 * listJournal.
 */
export function journalOverview(db, { userId = null, now = new Date(), timeZone = 'Europe/Samara', limit = 12 } = {}) {
  const entries = loadEntries(db, userId);
  const today = dateInZone(now, timeZone);
  const tomorrow = shiftDate(today, 1), weekEnd = shiftDate(today, 7);
  // Записи, разбор которых ещё идёт, в loadEntries не попадают: там JOIN на
  // активную интерпретацию. Для карты они важны — человек их только что
  // продиктовал, — поэтому считаем их отдельным запросом.
  const unparsed = db
    .prepare(`SELECT COUNT(*) AS count FROM captures c LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
      WHERE c.deleted_at IS NULL AND c.user_id IS ? AND i.id IS NULL`)
    .get(userId).count;

  const projects = new Map(), people = new Map(), tags = new Map(), types = new Map();
  const lastSeen = new Map();
  let open = 0, done = 0, high = 0, questions = 0, followUps = 0, unclear = 0, repeating = 0;
  const overdue = [], todayItems = [];
  let tomorrowCount = 0, weekCount = 0;

  for (const entry of entries) {
    const classification = entry.classification;
    const primaryType = classification.primaryType;
    types.set(primaryType, (types.get(primaryType) || 0) + 1);
    if (isOpen(entry)) open += 1;
    if (entry.closed || classification.completed) done += 1;
    if (classification.priority === 'high' && isOpen(entry)) high += 1;
    if (primaryType === 'idea_question') questions += 1;
    if (classification.entities?.followUp) followUps += 1;
    if (classification.unclassified || classification.ambiguity) unclear += 1;
    if (scheduleOf(entry)?.repeat) repeating += 1;
    for (const person of classification.entities?.people || []) countInto(people, person);
    for (const tag of classification.tags || []) countInto(tags, tag);
    for (const project of classification.entities?.projects || []) {
      countInto(projects, project);
      const key = normalizeMemoryText(project);
      const date = dateInZone(new Date(entry.createdAt), timeZone);
      const known = lastSeen.get(key) || { name: project, date, open: 0, overdue: 0 };
      if (date > known.date) known.date = date;
      if (isOpen(entry)) known.open += 1;
      if (isOverdue(entry, today)) known.overdue += 1;
      lastSeen.set(key, known);
    }
    if (isOverdue(entry, today))
      overdue.push({ captureId: entry.id, title: titleOf(entry), dueDate: scheduleOf(entry).date, daysLate: diffDays(today, scheduleOf(entry).date) });
    const schedule = scheduleOf(entry);
    if (isOpen(entry) && schedule?.date) {
      if (onDate(schedule, today)) todayItems.push({ captureId: entry.id, title: titleOf(entry), time: schedule.time || null, type: TYPE_NAMES[entry.classification.primaryType] });
      if (onDate(schedule, tomorrow)) tomorrowCount += 1;
      const next = dueDate(entry, today);
      if (next && next >= today && next < weekEnd) weekCount += 1;
    }
  }

  overdue.sort((left, right) => right.daysLate - left.daysLate);
  todayItems.sort((left, right) => (left.time || '99:99').localeCompare(right.time || '99:99'));
  const projectList = top(projects, limit).map(project => {
    const state = lastSeen.get(normalizeMemoryText(project.name));
    const quietDays = state ? diffDays(today, state.date) : null;
    return { name: project.name, count: project.count, open: state?.open || 0, overdue: state?.overdue || 0, lastSeen: state?.date || null, quietDays, stalled: quietDays !== null && project.count >= 2 && quietDays >= STALLED_AFTER_DAYS };
  });

  return {
    today, timeZone,
    totals: { entries: entries.length + unparsed, open, done, overdue: overdue.length, unparsed },
    types: [...types.entries()].map(([type, count]) => ({ type: TYPE_NAMES[type] || type, key: type, count })).sort((left, right) => right.count - left.count),
    projects: projectList,
    people: top(people, limit).map(person => ({ name: person.name, count: person.count })),
    tags: top(tags, limit).map(tag => ({ name: tag.name, count: tag.count })),
    flags: { high, questions, followUps, unclear, repeating },
    horizon: { today: todayItems.slice(0, 8), tomorrow: tomorrowCount, week: weekCount },
    overdue: overdue.slice(0, 8),
  };
}

// Словарь журнала: как человек на самом деле называет свои проекты, людей и
// метки. Уходит в разбор, чтобы модель писала «Hub», а не «хаб», и не
// выдумывала третье написание того же проекта.
export function vocabulary(db, { userId = null, limit = 20, window = 500 } = {}) {
  // Словарь собирается на каждый разбор, поэтому смотрит не весь журнал, а
  // последние записи: названия, которыми человек пользуется, — свежие, а
  // перебор всей истории на каждую запись обошёлся бы дороже пользы.
  const entries = loadEntries(db, userId).slice(-window);
  const projects = new Map(), people = new Map(), tags = new Map();
  for (const entry of entries) {
    for (const project of entry.classification.entities?.projects || []) countInto(projects, project);
    for (const person of entry.classification.entities?.people || []) countInto(people, person);
    for (const tag of entry.classification.tags || []) countInto(tags, tag);
  }
  return { projects: top(projects, limit).map(item => item.name), people: top(people, limit).map(item => item.name), tags: top(tags, limit).map(item => item.name) };
}

const matches = (value, needle) => normalizeMemoryText(value).includes(normalizeMemoryText(needle));

/**
 * Выборка записей по признакам: проект, тип, состояние, важность, тег,
 * участник, окно дат, слово в тексте. Всё необязательно — без фильтров это
 * просто последние записи.
 */
export function listJournal(db, { userId = null, now = new Date(), timeZone = 'Europe/Samara', project, type, status = 'any', priority, tag, person, from, to, query, limit = 30, offset = 0 } = {}) {
  const today = dateInZone(now, timeZone);
  const wantedType = type ? FILTER_TYPES[normalizeMemoryText(type)] || null : null;
  if (type && !wantedType) return { error: 'unknown_type' };
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const entries = loadEntries(db, userId);
  // Текст записей нужен только фильтру по слову — тогда и берём его, одной
  // выборкой на весь журнал, а не запросом на запись.
  const raws = query
    ? new Map(db.prepare('SELECT id, raw FROM captures WHERE deleted_at IS NULL AND user_id IS ?').all(userId).map(row => [row.id, row.raw]))
    : null;
  const picked = [];
  for (const entry of entries) {
    const classification = entry.classification;
    if (wantedType && classification.primaryType !== wantedType) continue;
    if (status === 'open' && !isOpen(entry)) continue;
    if (status === 'done' && !(entry.closed || classification.completed)) continue;
    if (status === 'overdue' && !isOverdue(entry, today)) continue;
    if (priority && classification.priority !== priority) continue;
    if (project && !(classification.entities?.projects || []).some(name => matches(name, project))) continue;
    if (person && !(classification.entities?.people || []).some(name => matches(name, person))) continue;
    if (tag && !(classification.tags || []).some(name => matches(name, tag))) continue;
    if (query && !matches(`${classification.summary || ''} ${classification.entities?.followUp || ''}`, query) && !matches(raws.get(entry.id) || '', query)) continue;
    const due = dueDate(entry, today);
    if (from && !(due && due >= from)) continue;
    if (to && !(due && due <= to)) continue;
    picked.push({
      captureId: entry.id,
      type: TYPE_NAMES[classification.primaryType] || classification.primaryType,
      title: titleOf(entry),
      due: scheduleOf(entry)?.display || null,
      dueDate: due,
      project: classification.entities?.projects?.[0] || null,
      people: classification.entities?.people || [],
      tags: classification.tags || [],
      priority: classification.priority || 'normal',
      done: Boolean(entry.closed || classification.completed),
      overdue: isOverdue(entry, today),
      createdAt: entry.createdAt,
    });
  }
  // Сроком вперёд, остальное — свежим сверху: спрашивают обычно «что ближайшее»
  // и «что последнее», а не «что в середине истории».
  picked.sort((left, right) =>
    left.dueDate && right.dueDate ? left.dueDate.localeCompare(right.dueDate) || right.createdAt.localeCompare(left.createdAt)
      : left.dueDate ? -1 : right.dueDate ? 1 : right.createdAt.localeCompare(left.createdAt));
  // Отступ — чтобы длинный список можно было дочитать, а не упереться в сотню:
  // модель просит следующую страницу тем же вызовом.
  const start = Math.max(Number(offset) || 0, 0);
  const items = picked.slice(start, start + size);
  return { total: picked.length, offset: start, shown: items.length, items };
}

