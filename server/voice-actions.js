// Голосу — всё, что умеет приложение: закрыть дело, ответить на просьбу,
// отдать дело человеку, прочитать и написать в обсуждении или разговоре круга,
// разобрать колокольчик, разложить страницы заметок и «Доску», услышать отчёт,
// напоминания и отправить дело во внешний календарь.
//
// Каждое действие зовёт те же функции, что и маршрут приложения, и с теми же
// проверками прав: голос не получает ни больше, ни меньше, чем человек в
// интерфейсе. То, что маршрут делает вокруг, — живое обновление открытых
// вкладок, переразбор моделью, запись настроек — приходит крючками (hooks) из
// server/index.js. В модульных тестах крючков нет, и действия работают без них.
import { randomUUID } from 'node:crypto';
import { getAggregate, fullEntry, captureOwner, completeProjection, undoProjectionCompletion, activeNote } from './db.js';
import * as circles from './circles.js';
import * as chat from './chat.js';
import { NOTIFICATION_KINDS, listNotifications, notificationCounts, readNotifications, snoozeNotification, resolveNotifications, findNotification, serializeNotification, dismissNotifications } from './notifications.js';
import { pagesOverview, pageDetail, createPage, placePage, syncDeedLine } from './notes-tree.js';
import { boardView, moveCard, createColumn, renameColumn, deleteColumn } from './board.js';
import { periodReport, dayReport, dateInZone, dayStartInZone, shiftDate, loadEntries } from './reports.js';
import { correctCapture } from './corrections.js';
import { normalizeSkip, occursOn, nextOccurrence, describeRepeat, dayDiff } from './repeat.js';

const TYPE_WORDS = { task: 'задача', meeting_event: 'встреча', outcome_decision: 'результат', note: 'заметка', idea_question: 'идея' };
const ASSIGNMENT_WORDS = { pending: 'ждёт ответа', accepted: 'взято', done: 'сделано', declined: 'вернули' };
const CIRCLE_WORDS = {
  invalid_name: 'Имя круга — от 1 до 40 символов.', circles_limit: 'Кругов может быть не больше 12.', not_found: 'Круг не найден.',
  not_owner: 'Это меняет хозяин круга.', last_owner: 'Круг не должен остаться без хозяина: сначала назначьте другого.',
  person_not_found: 'Такого человека в приложении нет.', already_member: 'Этот человек уже в круге.',
  self_assign: 'Себе дело ставят обычной записью.', not_in_circle: 'Этого человека нет ни в одном общем с вами круге.',
  already_answered: 'На эту просьбу уже ответили.', invalid_comment: 'Сообщение — от 1 до 4000 символов.', invalid_reaction: 'Такой реакции нет.',
};
const CHAT_WORDS = {
  not_found: 'Разговор не найден.', invalid_room_name: 'Название комнаты — от 1 до 40 символов.', rooms_limit: 'Комнат в круге может быть не больше 20.',
  room_needs_people: 'Комната — это разговор с кем-то: позовите хотя бы одного человека.', invalid_message: 'Сообщение — от 1 до 4000 символов.',
  invalid_reply: 'Ответить можно на сообщение из этого же разговора.', invalid_reaction: 'Такой реакции нет.',
  general_room: 'Общий разговор круга не переименовать и не покинуть — он и есть круг.', everyone_room: 'Разговор для всего круга не покинуть, и позвать в него отдельно нельзя: в нём все, кто в круге.',
  not_in_circle: 'Этого человека нет в круге.',
};
export const REACTIONS = ['👍', '❤️', '🔥', '🙏', '👀', '✅'];

const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const text = (value, limit = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null);
const cut = (value, limit = 160) => { const clean = String(value ?? '').replace(/\s+/g, ' ').trim(); return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean; };
const lower = value => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const nameOf = person => person?.name || null;
const dueWords = due => (due?.date ? `${due.date}${due.time ? ` ${due.time}` : ''}` : null);
const NO_HOOKS = { notifyJournal() {}, notifyCircle() {}, notifyCircleMembers() {}, notifyRoom() {}, countsChanged() {}, stillWaits: null, reminders: null, reclassify: null, saveSettings: null, dismissReminders: null };
const hooksOf = context => ({ ...NO_HOOKS, ...(context.hooks || {}) });
// Приходится ли срок на день. У повтора — только его экземпляры: закрытый
// сегодняшний повтор серии, начатой сегодня же, в день больше не встаёт.
const onDay = (schedule, date) => Boolean(schedule?.date) && (schedule.repeat ? occursOn(schedule, date) : schedule.date === date);

// Что-то по названию: сначала точное совпадение, потом единственное начало.
// Двух похожих не выбираем — угадывать, о каком круге или странице речь, нельзя.
function pickByName(items, wanted, nameField = 'name') {
  const key = lower(wanted);
  if (!key) return null;
  const exact = items.filter(item => lower(item[nameField]) === key);
  if (exact.length === 1) return exact[0];
  const starts = items.filter(item => lower(item[nameField]).startsWith(key));
  return starts.length === 1 ? starts[0] : null;
}
// Человек по имени — с падежами, как в кругах: «Ане» и «Аня» один человек.
function pickPerson(people, wanted) {
  const key = lower(wanted);
  if (!key) return null;
  const exact = people.filter(person => lower(person.name) === key || lower(person.email) === key);
  if (exact.length === 1) return exact[0];
  const similar = people.filter(person => circles.sameName(wanted, person.name) || lower(String(person.email || '').split('@')[0]) === key);
  return similar.length === 1 ? similar[0] : null;
}
function findCircle(db, userId, reference) {
  const mine = circles.circlesOf(db, userId);
  return mine.find(circle => circle.id === reference) || pickByName(mine, reference);
}

// ── дела ─────────────────────────────────────────────────────────────────────

// «Готово» голосом — тот же кружок, что в «Дне», на «Доске» и в календаре.
// У повтора кружок закрывает один день: серия живёт дальше. Сделанное
// результатом (в «Что делал») — это другой жест, тип outcome в update_capture.
export function completeCapture(db, args, context) {
  const { now, timeZone, userId } = context;
  const hooks = hooksOf(context);
  const aggregate = getAggregate(db, args.captureId);
  if (!aggregate) return { error: db.prepare('SELECT 1 FROM captures WHERE id=? AND deleted_at IS NULL').get(args.captureId) ? 'Запись ещё разбирается — закрыть её можно чуть позже.' : 'Запись не найдена.' };
  const classification = JSON.parse(aggregate.classification_json);
  const title = classification.summary || cut(aggregate.raw, 120);
  const undo = args.undo === true;
  const schedule = classification.entities?.schedule || null;
  if (schedule?.repeat && schedule.date && args.series !== true) {
    // Повтор правится уточнением записи, а его делает только автор — как и в
    // календаре: чужую серию двигает тот, кто её завёл.
    if (captureOwner(db, args.captureId) !== userId) return { error: 'Повтор чужого дела закрывает его автор.' };
    const today = dateInZone(now(), timeZone);
    const skip = normalizeSkip(schedule.skip);
    let date = isoDate(args.date) ? args.date : null;
    if (!date) date = undo ? [...skip].reverse().find(day => day <= today) || skip.at(-1) || null : occursOn(schedule, today) ? today : nextOccurrence(schedule, today);
    if (!date) return { error: undo ? 'Закрытых повторов нет — возвращать нечего.' : 'У серии больше нет повторов.' };
    if (undo && !skip.includes(date)) return { error: 'Этот повтор не закрывали.' };
    if (!undo && !occursOn(schedule, date)) return { error: skip.includes(date) ? 'Этот повтор уже закрыт.' : 'В этот день повтора нет.' };
    const patch = { schedule: { date: schedule.date, time: schedule.time || null, ...(schedule.time && schedule.end ? { end: schedule.end } : {}), skip: undo ? skip.filter(day => day !== date) : [...skip, date] } };
    const result = correctCapture(db, { captureId: args.captureId, userId, patch, operationKey: `voice-${randomUUID()}`, source: 'voice' });
    if (result.error) return { error: result.error.message };
    hooks.notifyJournal('correction');
    const after = result.entry.interpretation.classification.entities.schedule;
    return { captureId: args.captureId, title, done: !undo, occurrence: date, series: 'остаётся', next: undo ? date : nextOccurrence(after, shiftDate(date, 1)) };
  }
  const projections = db.prepare("SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event')").all(args.captureId);
  if (!projections.length) return { error: classification.completed ? 'Это уже сделанное — результат в «Что делал», закрывать нечего.' : 'Закрываются только дела и встречи.' };
  let changed = false;
  for (const projection of projections) {
    const result = undo ? undoProjectionCompletion(db, projection.id) : completeProjection(db, projection.id);
    if (result.error) return { error: 'Запись только что изменилась — попробуйте ещё раз.' };
    changed = changed || result.changed;
  }
  // Как у маршрута: просьба закрывается вместе с делом, строка «- [ ]» в
  // заметке отмечается, а те, кому дело видно, получают свежий день.
  circles.noteCompletion(db, args.captureId, !undo);
  syncDeedLine(db, args.captureId);
  // Закрытое дело забирает свои напоминания из колокольчика — как кружок.
  if (!undo) {
    if (hooks.dismissReminders) hooks.dismissReminders(args.captureId);
    else dismissNotifications(db, null, { captureId: args.captureId, kinds: ['reminder'] });
  }
  hooks.notifyCircle(args.captureId);
  hooks.notifyJournal('completion');
  const assignment = circles.assignmentFor(db, args.captureId);
  const author = assignment?.assignee?.id === userId && assignment.assigner ? assignment.assigner.name : null;
  return { captureId: args.captureId, title, done: !undo, changed, ...(schedule?.repeat ? { series: 'закрыта целиком' } : {}), ...(author && !undo ? { authorSees: `${author} увидит «сделано»` } : {}) };
}

// День словами: часы, дела на сегодня, просроченное, запас без срока, взятое
// у людей, чужие события и то, что ещё разбирается. Один вызов на вопрос «что
// у меня сегодня» — без него голос собирал бы день тремя поисками.
export function listDay(db, args, context) {
  const { now, timeZone, userId, calendar } = context;
  const today = dateInZone(now(), timeZone);
  const date = isoDate(args.date) ? args.date : today;
  const isToday = date === today;
  const hours = [], dueToday = [], overdue = [], undated = [];
  const itemOf = (id, classification, closed, extra = {}) => {
    const schedule = classification.entities?.schedule || null;
    return {
      captureId: id, title: classification.summary || '', kind: classification.primaryType === 'meeting_event' ? 'встреча' : 'дело',
      ...(schedule?.time ? { time: schedule.time, end: schedule.end || null } : {}),
      done: closed,
      ...(schedule?.repeat ? { repeat: describeRepeat(schedule.repeat, { until: false }) } : {}),
      ...(classification.priority === 'high' ? { important: true } : {}),
      ...(classification.entities?.projects?.[0] ? { project: classification.entities.projects[0] } : {}),
      ...extra,
    };
  };
  const place = (id, classification, closed, extra) => {
    const schedule = classification.entities?.schedule || null;
    if (!['task', 'meeting_event'].includes(classification.primaryType) || classification.completed) return;
    if (onDay(schedule, date)) {
      (schedule.time ? hours : dueToday).push(itemOf(id, classification, closed, extra));
      return;
    }
    if (!isToday || closed) return;
    if (schedule?.date && !schedule.repeat && schedule.date < today && classification.primaryType === 'task') overdue.push({ ...itemOf(id, classification, false, extra), dueDate: schedule.date, daysLate: dayDiff(schedule.date, today) });
    else if (!schedule?.date && classification.primaryType === 'task') undated.push(itemOf(id, classification, false, extra));
  };
  const entries = loadEntries(db, userId);
  for (const entry of entries) place(entry.id, entry.classification, entry.closed);
  // Взятые у людей дела живут в чужом журнале, но в этом дне стоят рядом со
  // своими — так же, как в «Дне» на главной.
  const borrowed = [];
  for (const row of circles.acceptedFor(db, userId)) {
    const aggregate = getAggregate(db, row.capture_id);
    if (!aggregate) continue;
    const entry = fullEntry(db, aggregate);
    const completable = entry.projections.filter(projection => ['task', 'meeting_event'].includes(projection.type));
    const closed = completable.length > 0 && completable.every(projection => projection.completion.completed);
    const classification = entry.interpretation.classification;
    const schedule = classification.entities?.schedule || null;
    const from = { from: nameOf(circles.assignmentFor(db, row.capture_id)?.assigner) };
    // Срок на этот день — в часы или в дела дня; остальное взятое (без срока,
    // просроченное) — своей строкой, а не в хвосте запаса.
    if (onDay(schedule, date)) place(entry.id, classification, closed, from);
    else if (isToday && !closed && ['task', 'meeting_event'].includes(classification.primaryType) && !classification.completed) borrowed.push(itemOf(entry.id, classification, false, { ...from, ...(schedule?.date ? { dueDate: schedule.date } : {}) }));
  }
  const allDay = [];
  if (calendar) {
    try {
      const view = calendar.view({ userId, from: date, to: date });
      for (const event of view.external || []) {
        if (event.me?.status === 'declined') continue;
        const item = { eventId: event.id, title: event.title, kind: 'событие', source: event.source, ...(event.joinUrl ? { joinUrl: event.joinUrl } : {}), ...(event.me?.status === 'needs-action' ? { answer: 'ждёт ответа' } : {}) };
        if (event.allDay || !event.time) allDay.push(item);
        else hours.push({ ...item, time: event.time, end: event.end || null });
      }
    } catch {}
  }
  hours.sort((left, right) => left.time.localeCompare(right.time));
  overdue.sort((left, right) => left.dueDate.localeCompare(right.dueDate));
  const parsing = isToday
    ? db.prepare(`SELECT c.id, c.raw FROM captures c LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
        WHERE c.deleted_at IS NULL AND c.user_id IS ? AND i.id IS NULL ORDER BY c.created_at DESC LIMIT 5`).all(userId).map(row => ({ captureId: row.id, text: cut(row.raw, 140) }))
    : [];
  const box = circles.inbox(db, userId, [...chat.unseenCalls(db, userId), ...circles.newCircles(db, userId)]);
  const undatedTop = undated.slice(-5).reverse();
  const summary = item => ({ captureId: item.captureId, eventId: item.eventId, summary: item.title, ...(item.time ? { time: item.time } : {}) });
  const open = [
    ...parsing.map(item => ({ captureId: item.captureId, summary: item.text, parsing: true })),
    ...overdue.map(summary),
    ...hours.filter(item => !item.done).map(summary),
    ...dueToday.filter(item => !item.done).map(summary),
    ...borrowed.map(summary),
    ...undatedTop.map(summary),
  ];
  return {
    date, isToday,
    hours, allDay, today: dueToday,
    ...(isToday ? { overdue, undated: { count: undated.length, newest: undatedTop }, borrowed, parsing } : {}),
    inbox: { requests: box.rows.filter(row => row.kind === 'request').length, calls: box.rows.filter(row => row.kind === 'call' || row.kind === 'chat').length },
    unreadNotifications: notificationCounts(db, userId).unread,
    total: hours.length + allDay.length + dueToday.length + overdue.length + undated.length + borrowed.length + parsing.length,
    open: open.slice(0, 10),
  };
}

// Что ещё о записи знает приложение, кроме разбора: закрыта ли она, откуда
// взялась и что из неё вышло, кому отдана, что в обсуждении, где лежит
// страницей.
export function captureDetails(db, captureId, userId, { full = false } = {}) {
  const aggregate = getAggregate(db, captureId);
  if (!aggregate) return {};
  const entry = fullEntry(db, aggregate);
  const classification = entry.interpretation.classification;
  const schedule = classification.entities?.schedule || null;
  const completable = entry.projections.filter(projection => ['task', 'meeting_event'].includes(projection.type));
  const closed = completable.length > 0 && completable.every(projection => projection.completion.completed);
  const owner = captureOwner(db, captureId);
  const assignment = circles.assignmentFor(db, captureId);
  const comments = circles.commentCounts(db, [captureId]).get(captureId) || 0;
  const details = {
    done: closed || Boolean(classification.completed),
    closed,
    priority: classification.priority || 'normal',
    followUp: classification.entities?.followUp || null,
    schedule: schedule?.date ? { date: schedule.date, time: schedule.time || null, end: schedule.end || null, repeat: schedule.repeat ? describeRepeat(schedule.repeat) : null, closedDays: normalizeSkip(schedule.skip).slice(-5), remind: schedule.remind ?? 'как в настройках' } : null,
    mine: owner === userId,
    ...(owner !== userId ? { author: (() => { const row = owner ? db.prepare('SELECT * FROM users WHERE id=?').get(owner) : null; return row ? circles.publicUser(row).name : null; })() } : {}),
    circles: circles.circlesForCapture(db, captureId).map(circle => circle.name),
    assignment: assignment && assignment.state !== 'declined' ? { assignmentId: assignment.id, to: nameOf(assignment.assignee), from: nameOf(assignment.assigner), state: ASSIGNMENT_WORDS[assignment.state] || assignment.state } : null,
    discussion: { messages: comments, unread: userId ? circles.unreadComments(db, captureId, userId) : 0, people: circles.captureParticipants(db, captureId).map(nameOf) },
    parts: entry.parts.map(part => ({ captureId: part.id, title: part.title })),
    parent: entry.parent ? { captureId: entry.parent.id, title: entry.parent.title } : null,
    attachments: (entry.attachments || []).map(file => file.filename).filter(Boolean),
  };
  if (['note', 'idea_question'].includes(classification.primaryType) && owner === userId) {
    const page = pageDetail(db, userId, captureId);
    if (page) details.page = { place: page.trail.map(step => step.title).filter(Boolean).join(' › ') || 'корень', children: page.children.map(child => child.title), linkedFrom: page.backlinks.map(link => link.title).filter(Boolean) };
  }
  if (full) {
    details.raw = cut(aggregate.raw, 4000);
    const note = activeNote(db, captureId)?.body;
    details.note = note ? note.slice(0, 4000) : null;
  }
  return details;
}

// ── круги и просьбы ─────────────────────────────────────────────────────────

export function listInbox(db, args, { userId }) {
  const box = circles.inbox(db, userId, [...chat.unseenCalls(db, userId), ...circles.newCircles(db, userId)]);
  return {
    requests: box.rows.filter(row => row.kind === 'request').map(row => ({ assignmentId: row.id, captureId: row.captureId, title: row.title, from: nameOf(row.from), circle: row.circle?.name || null, due: dueWords(row.due) })),
    calls: box.rows.filter(row => row.kind === 'call' || row.kind === 'chat').map(row => (row.kind === 'call'
      ? { where: 'обсуждение записи', captureId: row.captureId, title: row.title, text: cut(row.body, 240), from: nameOf(row.from), circle: row.circle?.name || null }
      : { where: 'разговор круга', roomId: row.roomId, room: row.roomName, text: cut(row.title, 240), from: nameOf(row.from), circle: row.circle?.name || null })),
    newCircles: box.rows.filter(row => row.kind === 'circle').map(row => ({ circleId: row.id, circle: row.circle?.name || null, addedBy: nameOf(row.from) })),
    mutedCircles: box.folded.map(item => ({ circle: item.circle?.name || null, waiting: item.count })),
    waiting: circles.waiting(db, userId).map(item => ({ assignmentId: item.id, captureId: item.captureId, title: item.title, to: nameOf(item.assignee), state: ASSIGNMENT_WORDS[item.state] || item.state, reason: item.reason || null, due: dueWords(item.due) })),
  };
}

export function respondRequest(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  if (typeof args.assignmentId !== 'string' || !args.assignmentId) return { error: 'Нужен assignmentId просьбы из list_inbox.' };
  if (typeof args.take !== 'boolean') return { error: 'Ответ — take: true («беру») или false («не я»).' };
  const result = circles.respond(db, args.assignmentId, userId, args.take, text(args.reason, 300));
  if (result.error) return { error: result.error === 'already_answered' ? CIRCLE_WORDS.already_answered : 'Просьба не найдена.' };
  hooks.notifyCircle(result.assignment.captureId);
  hooks.notifyJournal('circle');
  hooks.countsChanged(userId);
  return { assignmentId: args.assignmentId, captureId: result.assignment.captureId, title: result.assignment.title, from: nameOf(result.assignment.assigner), answer: args.take ? 'взято — дело в вашем дне' : 'возвращено автору' };
}

export function assignCapture(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  const person = text(args.person, 120);
  if (args.cancel === true || !person) {
    const result = circles.unassign(db, args.captureId, userId);
    if (result.error) return { error: 'Запись не найдена.' };
    hooks.notifyCircle(args.captureId);
    hooks.notifyJournal('circle');
    return { captureId: args.captureId, cancelled: true };
  }
  const circle = args.circle ? findCircle(db, userId, args.circle) : null;
  if (args.circle && !circle) return { error: `Круга «${cut(args.circle, 40)}» среди ваших нет.` };
  const scope = circle ? [circle] : circles.circlesOf(db, userId);
  const people = [...new Map(scope.flatMap(item => circles.membersOf(db, item.id)).filter(member => member.id !== userId).map(member => [member.id, member])).values()];
  const matched = pickPerson(people, person);
  if (!matched) return { error: people.length ? `Не нашёл одного человека «${cut(person, 40)}». В ${circle ? `круге «${circle.name}»` : 'ваших кругах'}: ${people.map(nameOf).join(', ')}.` : 'В ваших кругах пока никого нет — дело отдают человеку из круга.' };
  const result = circles.assign(db, { captureId: args.captureId, assigneeId: matched.id, assignerId: userId, circleId: circle?.id || null });
  if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Не получилось отдать дело.' };
  hooks.notifyCircle(args.captureId, [matched.id]);
  hooks.notifyJournal('circle');
  return { captureId: args.captureId, to: nameOf(result.assignment.assignee), circle: result.assignment.circle?.name || null, state: ASSIGNMENT_WORDS[result.assignment.state] };
}

export function listCircles(db, args, { userId }) {
  return {
    circles: circles.circlesOf(db, userId).map(circle => {
      const detail = circles.circleDetail(db, circle.id, userId);
      return {
        circleId: circle.id, name: circle.name, role: circle.role === 'owner' ? 'хозяин' : 'участник', muted: circle.muted,
        members: (detail?.members || []).map(member => ({ name: member.name, you: member.id === userId, role: member.role === 'owner' ? 'хозяин' : 'участник', openDeeds: member.openDeeds, deeds: member.deeds.map(deed => deed.title) })),
        rooms: chat.roomsOf(db, userId, circle.id).map(room => ({ roomId: room.id, name: room.kind === 'general' ? chat.GENERAL_NAME : room.name, everyone: room.everyone, unread: room.unread, calledYou: room.called, last: room.last ? cut(`${room.last.author ? `${room.last.author}: ` : ''}${room.last.body}`, 140) : null })),
      };
    }),
  };
}

export function manageCircle(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  const action = args.action;
  if (action === 'create') {
    const result = circles.createCircle(db, userId, args.name, 'violet');
    if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Круг не создан.' };
    chat.ensureGeneral(db, result.circle.id, userId);
    hooks.notifyJournal('circle');
    return { circleId: result.circle.id, name: result.circle.name, created: true };
  }
  if (!['rename', 'mute', 'unmute', 'leave', 'dissolve', 'add_person', 'create_room', 'rename_room', 'add_to_room', 'leave_room'].includes(action)) return { error: 'Действие с кругом: create, rename, mute, unmute, leave, dissolve, add_person, create_room, rename_room, add_to_room или leave_room.' };
  const circle = findCircle(db, userId, args.circle);
  if (!circle) return { error: args.circle ? `Круга «${cut(args.circle, 40)}» среди ваших нет.` : 'Назовите круг.' };
  if (action === 'rename') {
    const result = circles.updateCircle(db, circle.id, userId, { name: args.name });
    if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Круг не переименован.' };
    hooks.notifyCircleMembers(circle.id);
    return { circleId: circle.id, name: result.circle.name, renamed: true };
  }
  if (action === 'mute' || action === 'unmute') {
    const result = circles.setMuted(db, circle.id, userId, action === 'mute');
    if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Не получилось.' };
    hooks.notifyJournal('circle');
    return { circleId: circle.id, name: circle.name, muted: action === 'mute' };
  }
  if (action === 'leave') {
    const result = circles.leaveCircle(db, circle.id, userId);
    if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Не получилось выйти из круга.' };
    hooks.notifyCircleMembers(circle.id);
    return { circleId: circle.id, name: circle.name, left: true };
  }
  if (action === 'dissolve') {
    const members = circles.membersOf(db, circle.id);
    const result = circles.dissolveCircle(db, circle.id, userId);
    if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Круг не распущен.' };
    hooks.notifyJournal('circle');
    return { circleId: circle.id, name: circle.name, dissolved: true, people: members.filter(member => member.id !== userId).map(nameOf) };
  }
  if (action === 'rename_room' || action === 'add_to_room' || action === 'leave_room') {
    const rooms = chat.roomsOf(db, userId, circle.id).map(room => ({ ...room, name: room.kind === 'general' ? chat.GENERAL_NAME : room.name }));
    const room = rooms.find(item => item.id === args.room) || pickByName(rooms, args.room);
    if (!room) return { error: `В круге «${circle.name}» нет разговора «${cut(args.room, 40)}». Есть: ${rooms.map(item => item.name).join(', ')}.` };
    let result;
    if (action === 'rename_room') result = chat.renameRoom(db, room.id, userId, args.name);
    else if (action === 'leave_room') result = chat.leaveRoom(db, room.id, userId);
    else {
      const person = pickPerson(circles.membersOf(db, circle.id).filter(member => member.id !== userId), args.person);
      if (!person) return { error: `В круге «${circle.name}» нет «${cut(args.person, 40)}».` };
      result = chat.addToRoom(db, room.id, userId, person.id);
    }
    if (result.error) return { error: CHAT_WORDS[result.error] || 'Не получилось.' };
    hooks.notifyRoom(room.id);
    return { roomId: room.id, room: result.room?.name || room.name, circle: circle.name, ...(action === 'leave_room' ? { left: true } : action === 'rename_room' ? { renamed: true } : { people: result.room.members.map(nameOf) }) };
  }
  if (action === 'add_person') {
    const wanted = text(args.person, 120);
    if (!wanted) return { error: 'Кого добавить в круг?' };
    const found = circles.candidates(db, circle.id, userId, wanted);
    if (found.error) return { error: CIRCLE_WORDS[found.error] || 'Круг не найден.' };
    const person = pickPerson(found.people, wanted) || (found.people.length === 1 ? found.people[0] : null);
    if (!person) return { error: found.people.length ? `Под «${cut(wanted, 40)}» подходят: ${found.people.map(nameOf).join(', ')}. Кого именно?` : `В Кизуне нет человека «${cut(wanted, 40)}» вне этого круга.` };
    const result = circles.addMember(db, circle.id, userId, person.id);
    if (result.error) return { error: CIRCLE_WORDS[result.error] || 'Не получилось добавить.' };
    chat.ensureGeneral(db, circle.id, userId);
    hooks.notifyCircleMembers(circle.id);
    return { circleId: circle.id, name: circle.name, added: person.name };
  }
  const members = circles.membersOf(db, circle.id);
  const invited = [];
  for (const name of Array.isArray(args.people) ? args.people.slice(0, 20) : []) {
    const member = pickPerson(members.filter(item => item.id !== userId), name);
    if (!member) return { error: `В круге «${circle.name}» нет «${cut(name, 40)}». В круге: ${members.filter(item => item.id !== userId).map(nameOf).join(', ') || 'только вы'}.` };
    invited.push(member.id);
  }
  const result = chat.createRoom(db, circle.id, userId, args.name, invited, { everyone: args.everyone === true });
  if (result.error) return { error: CHAT_WORDS[result.error] || 'Разговор не заведён.' };
  hooks.notifyRoom(result.room.id);
  return { roomId: result.room.id, name: result.room.name, circle: circle.name, everyone: result.room.everyone, people: result.room.members.map(nameOf) };
}

// ── обсуждения записей и разговоры кругов ───────────────────────────────────

const reactionWords = list => (list || []).map(item => `${item.emoji}${item.count > 1 ? ` ${item.count}` : ''}`);

export function readConversation(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  if (typeof args.captureId === 'string' && args.captureId) {
    // Прочитал обсуждение — погасли и призывы в нём, и строки колокольчика о
    // нём: как у открытой карточки.
    circles.markMentionsSeen(db, args.captureId, userId);
    const unread = circles.unreadComments(db, args.captureId, userId);
    circles.markCommentsRead(db, args.captureId, userId);
    if (readNotifications(db, userId, { captureId: args.captureId })) hooks.countsChanged(userId);
    const comments = circles.comments(db, args.captureId, userId);
    return {
      captureId: args.captureId, title: circles.captureTitle(db, args.captureId), unread, total: comments.length,
      messages: comments.slice(-30).map(comment => ({ commentId: comment.id, from: nameOf(comment.author), you: comment.author?.id === userId, text: cut(comment.body, 600), at: comment.createdAt, ...(comment.replyTo ? { replyTo: cut(comment.replyTo.body, 80) } : {}), ...(comment.reactions.length ? { reactions: reactionWords(comment.reactions) } : {}) })),
      people: circles.captureParticipants(db, args.captureId).map(nameOf),
      canCall: circles.callableFor(db, args.captureId, userId).filter(person => person.group !== 'everyone').map(nameOf).slice(0, 20),
    };
  }
  if (typeof args.roomId === 'string' && args.roomId) {
    const room = chat.findRoom(db, args.roomId);
    if (!room || !chat.inRoom(db, room, userId)) return { error: CHAT_WORDS.not_found };
    const result = chat.messages(db, args.roomId, userId, { limit: 30 });
    if (result.error) return { error: CHAT_WORDS.not_found };
    chat.markRead(db, args.roomId, userId);
    if (readNotifications(db, userId, { roomId: args.roomId })) hooks.countsChanged(userId);
    const circle = circles.circlesOf(db, userId).find(item => item.id === room.circle_id);
    return {
      roomId: args.roomId, room: room.kind === 'general' ? chat.GENERAL_NAME : room.name, circle: circle?.name || null, unread: result.room.unread,
      ...(result.room.pinned ? { pinned: cut(result.room.pinned.body, 200) } : {}),
      messages: result.messages.map(message => (message.kind === 'deed'
        ? { deed: `${nameOf(message.deed.assigner) || 'кто-то'} → ${nameOf(message.deed.assignee) || 'кто-то'}: ${message.deed.title}`, state: ASSIGNMENT_WORDS[message.deed.state] || message.deed.state, captureId: message.deed.captureId, assignmentId: message.deed.assignmentId, at: message.createdAt }
        : { messageId: message.id, from: nameOf(message.author), you: message.mine, text: cut(message.body, 600), at: message.createdAt, ...(message.kind !== 'said' ? { system: true } : {}), ...(message.replyTo ? { replyTo: cut(message.replyTo.body, 80) } : {}), ...(message.reactions.length ? { reactions: reactionWords(message.reactions) } : {}) })),
    };
  }
  // Без адреса — где идёт разговор: обсуждения записей и комнаты кругов,
  // непрочитанные сверху.
  const discussions = circles.discussions(db, userId).slice(0, 15).map(item => ({ captureId: item.captureId, title: item.title, circle: item.circle?.name || null, unread: item.unreadCount, calledYou: item.unread, last: item.last ? cut(`${nameOf(item.last.author)}: ${item.last.body}`, 140) : null }));
  const rooms = chat.roomsOf(db, userId).map(room => ({ roomId: room.id, name: room.kind === 'general' ? chat.GENERAL_NAME : room.name, circle: circles.circlesOf(db, userId).find(item => item.id === room.circleId)?.name || null, unread: room.unread, calledYou: room.called, last: room.last ? cut(`${room.last.author ? `${room.last.author}: ` : ''}${room.last.body}`, 140) : null }))
    .sort((left, right) => Number(right.calledYou) - Number(left.calledYou) || right.unread - left.unread).slice(0, 15);
  return { discussions, rooms };
}

export function writeMessage(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  const body = typeof args.text === 'string' ? args.text.trim() : '';
  if (typeof args.captureId === 'string' && args.captureId) {
    const share = ['yes', 'no'].includes(args.share) ? args.share : null;
    const result = circles.addComment(db, { captureId: args.captureId, authorId: userId, body, parentId: text(args.replyTo, 64), share });
    // Позвать того, кто запись не видит, — значит поделиться ею. Молча это не
    // происходит: как и карточка, голос спрашивает.
    if (result.error === 'share_needed') return { needsShare: true, people: result.people.map(nameOf), ask: 'Эти люди ещё не видят запись. Спросите, открыть ли её им, и повторите write_message с share: "yes" или "no".' };
    if (result.error) return { error: result.error === 'not_found' ? 'Сообщение, на которое отвечаете, не найдено.' : CIRCLE_WORDS[result.error] || 'Сообщение не отправлено.' };
    hooks.notifyCircle(args.captureId, [...result.comment.mentions.map(person => person.id), ...result.participants.map(person => person.id)]);
    hooks.notifyJournal('comment');
    return { captureId: args.captureId, commentId: result.comment.id, sent: true, called: result.comment.mentions.map(nameOf), opened: result.added.length ? result.participants.filter(person => result.added.includes(person.id)).map(nameOf) : [] };
  }
  if (typeof args.roomId === 'string' && args.roomId) {
    const result = chat.say(db, args.roomId, userId, body, { replyTo: text(args.replyTo, 64) });
    if (result.error) return { error: CHAT_WORDS[result.error] || 'Сообщение не отправлено.' };
    hooks.notifyRoom(args.roomId, { except: userId });
    return { roomId: args.roomId, messageId: result.message?.id || null, sent: true, called: result.called.map(nameOf) };
  }
  return { error: 'Куда писать: captureId — в обсуждение записи, roomId — в разговор круга.' };
}

export function messageAction(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  const action = args.action;
  if (action === 'react') {
    if (!REACTIONS.includes(args.emoji)) return { error: `Реакция — одна из: ${REACTIONS.join(' ')}.` };
    if (args.captureId && args.commentId) {
      const result = circles.reactComment(db, args.captureId, args.commentId, userId, args.emoji);
      if (result.error) return { error: result.error === 'not_found' ? 'Сообщение не найдено.' : CIRCLE_WORDS[result.error] };
      hooks.notifyCircle(args.captureId, circles.captureParticipants(db, args.captureId).map(person => person.id));
      return { reacted: args.emoji, added: result.added };
    }
    if (args.roomId && args.messageId) {
      const result = chat.react(db, args.roomId, args.messageId, userId, args.emoji);
      if (result.error) return { error: CHAT_WORDS[result.error] || 'Сообщение не найдено.' };
      hooks.notifyRoom(args.roomId, { except: userId });
      return { reacted: args.emoji, added: result.added };
    }
    return { error: 'Реакция ставится на сообщение: captureId с commentId или roomId с messageId.' };
  }
  if (action === 'pin' || action === 'unpin') {
    if (!args.roomId || (action === 'pin' && !args.messageId)) return { error: 'Закрепляют сообщение разговора: нужны roomId и messageId.' };
    const result = chat.pin(db, args.roomId, userId, action === 'pin' ? args.messageId : null);
    if (result.error) return { error: CHAT_WORDS[result.error] || 'Сообщение не найдено.' };
    hooks.notifyRoom(args.roomId, { except: userId });
    return { roomId: args.roomId, pinned: action === 'pin' };
  }
  if (action === 'remove') {
    if (!args.roomId || !args.messageId) return { error: 'Убрать можно своё сообщение разговора: нужны roomId и messageId.' };
    const result = chat.removeMessage(db, args.messageId, userId);
    if (result.error) return { error: 'Убрать можно только своё сообщение.' };
    hooks.notifyRoom(args.roomId, { except: userId });
    return { roomId: args.roomId, removed: true };
  }
  if (action === 'unfollow' || action === 'remove_person') {
    if (!args.captureId) return { error: 'Нужна запись: captureId.' };
    let personId = userId;
    if (action === 'remove_person') {
      const person = pickPerson(circles.captureParticipants(db, args.captureId), args.person);
      if (!person) return { error: `В обсуждении нет «${cut(args.person, 40)}».` };
      personId = person.id;
    }
    const result = circles.removeParticipant(db, args.captureId, userId, personId);
    if (result.error) return { error: result.error === 'not_owner' ? 'Убрать другого из записи может только её автор.' : 'Вы и так не в обсуждении этой записи.' };
    hooks.notifyCircle(args.captureId, [personId]);
    return { captureId: args.captureId, removed: action === 'unfollow' ? 'вы больше не следите за записью' : 'человек убран из записи' };
  }
  return { error: 'Действие: react, pin, unpin, remove, unfollow или remove_person.' };
}

// ── уведомления ──────────────────────────────────────────────────────────────

export function listNotificationsForVoice(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  const page = listNotifications(db, userId, { stillWaits: hooks.stillWaits || (() => true) });
  const users = db.prepare('SELECT * FROM users WHERE id=?');
  const filter = ['waits', 'people', 'time', 'other'].includes(args.filter) ? args.filter : 'all';
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 60);
  const items = page.notifications
    .map(serializeNotification)
    .filter(item => filter === 'all' || (filter === 'waits' ? item.waits : item.group === filter))
    .filter(item => args.unreadOnly !== true || !item.read)
    .slice(0, limit)
    .map(item => {
      const actors = item.actorIds.map(id => users.get(id)).filter(Boolean).map(user => circles.publicUser(user).name);
      return {
        notificationId: item.id, kind: item.kind, about: NOTIFICATION_KINDS[item.kind]?.label || item.kind,
        text: cut([actors.length ? actors.join(' и ') : item.lead, item.text].filter(Boolean).join(' '), 300),
        ...(item.meta.length ? { details: item.meta.filter(Boolean).join(' · ') } : {}),
        at: item.updatedAt, read: item.read, waits: item.waits,
        ...(item.captureId ? { captureId: item.captureId } : {}), ...(item.roomId ? { roomId: item.roomId } : {}), ...(item.assignmentId ? { assignmentId: item.assignmentId } : {}),
        ...(item.data?.circle?.name ? { circle: item.data.circle.name } : {}),
      };
    });
  return { counts: notificationCounts(db, userId), shown: items.length, items };
}

export function notificationAction(db, args, context) {
  const { now, userId, calendar } = context;
  const hooks = hooksOf(context);
  const action = args.action;
  if (action === 'read_all') {
    const changed = readNotifications(db, userId, {});
    if (changed) hooks.countsChanged(userId);
    return { read: changed, counts: notificationCounts(db, userId) };
  }
  // «Очистить» — как в колокольчике: уходит всё, кроме ждущего ответа.
  if (action === 'clear') {
    const dismissed = dismissNotifications(db, userId, { all: true });
    if (dismissed.length) hooks.countsChanged(userId);
    return { dismissed: dismissed.length, counts: notificationCounts(db, userId) };
  }
  const row = typeof args.notificationId === 'string' ? findNotification(db, args.notificationId) : null;
  if (!row || row.user_id !== userId) return { error: 'Уведомление не найдено.' };
  if (action === 'dismiss') {
    if (row.waits && !row.resolved_at) return { error: 'Это ждёт ответа — уйдёт из ленты, когда ответите.' };
    dismissNotifications(db, userId, { ids: [row.id] });
    hooks.countsChanged(userId);
    return { notificationId: row.id, dismissed: true, counts: notificationCounts(db, userId) };
  }
  if (action === 'read') {
    const changed = readNotifications(db, userId, { ids: [row.id] });
    if (changed) hooks.countsChanged(userId);
    return { notificationId: row.id, read: true, counts: notificationCounts(db, userId) };
  }
  if (action === 'snooze') {
    const minutes = args.minutes === undefined ? 10 : Number(args.minutes);
    const result = snoozeNotification(db, userId, row.id, minutes, now());
    if (result.error) return { error: 'Отложить можно на срок от минуты до суток.' };
    hooks.countsChanged(userId);
    return { notificationId: row.id, snoozedUntil: result.snoozedUntil, counts: notificationCounts(db, userId) };
  }
  if (action === 'respond') {
    if (row.kind !== 'invite') return { error: 'Ответить можно на приглашение на встречу.' };
    if (!['accepted', 'declined', 'tentative'].includes(args.status)) return { error: 'Ответ — accepted, declined или tentative.' };
    if (!calendar) return { error: 'Календарь недоступен.' };
    // Событие в кэше календаря переписывается при каждой синхронизации — ищем
    // его заново по учётной записи и UID, как и маршрут ленты.
    const event = db.prepare('SELECT id FROM calendar_events WHERE account_id=? AND uid=? ORDER BY start_at LIMIT 1').get(row.account_id, row.event_uid);
    if (!event) {
      resolveNotifications(db, { userId, kind: 'invite', accountId: row.account_id, eventUid: row.event_uid });
      hooks.countsChanged(userId);
      return { error: 'Встречи больше нет в календаре.' };
    }
    return Promise.resolve(calendar.respondExternalEvent({ userId, id: `ext:${event.id}`, status: args.status })).then(result => {
      if (result.error) return { error: `Календарь не принял ответ.${result.message ? ` ${result.message}` : ''}` };
      resolveNotifications(db, { userId, kind: 'invite', accountId: row.account_id, eventUid: row.event_uid });
      hooks.countsChanged(userId);
      return { notificationId: row.id, responded: args.status };
    });
  }
  return { error: 'Действие: read, read_all, dismiss, clear, snooze или respond.' };
}

// ── страницы заметок ────────────────────────────────────────────────────────

function placeWords(page) {
  if (page.parentTitle) return `внутри «${page.parentTitle}»`;
  if (page.parentKey === 'inbox') return 'Входящие';
  if (page.parentKey?.startsWith('project:')) return `проект ${page.project || page.parentKey.slice(8)}`;
  return 'корень';
}
function findPage(pages, reference) {
  return pages.find(page => page.id === reference) || pickByName(pages, reference, 'title');
}

export function listPages(db, args, { userId }) {
  const overview = pagesOverview(db, userId);
  const query = lower(args.query);
  const pages = query ? overview.pages.filter(page => lower(page.title).includes(query) || lower(page.excerpt).includes(query)) : overview.pages;
  return {
    total: pages.length,
    pages: pages.slice(0, 40).map(page => ({ pageId: page.id, title: page.title, type: TYPE_WORDS[page.type] || page.type, place: placeWords(page), ...(page.excerpt ? { excerpt: cut(page.excerpt, 100) } : {}), ...(page.links ? { linkedFrom: page.links } : {}) })),
    projects: overview.allProjects,
  };
}

export function placePageForVoice(db, args, context) {
  const { userId } = context;
  const hooks = hooksOf(context);
  const overview = pagesOverview(db, userId);
  const parentRef = text(args.parent, 200);
  const parentPage = parentRef && !['root', 'auto'].includes(parentRef) ? findPage(overview.pages, parentRef) : null;
  if (parentRef && !['root', 'auto'].includes(parentRef) && !parentPage) return { error: `Страницы «${cut(parentRef, 60)}» нет — назовите её точнее.` };
  if (!args.pageId) {
    const title = text(args.title, 200);
    if (!title) return { error: 'Нужно название новой страницы.' };
    const project = text(args.project, 120);
    const parent = parentPage ? parentPage.id : project ? `project:${project}` : 'root';
    const result = createPage(db, { userId, title, parent });
    if (result.error) return { error: result.error === 'invalid_title' ? 'Название страницы — от 1 до 200 символов.' : 'Такого места нет.' };
    hooks.notifyJournal('page');
    return { pageId: result.id, title, created: true, place: parentPage ? `внутри «${parentPage.title}»` : project ? `проект ${project}` : 'корень' };
  }
  const page = findPage(overview.pages, args.pageId);
  if (!page) return { error: 'Страница не найдена.' };
  const parent = parentPage ? parentPage.id : parentRef === 'auto' ? 'auto' : 'root';
  const result = placePage(db, { userId, pageId: page.id, parent });
  if (result.error) return { error: result.error === 'cycle' ? 'Страницу нельзя положить внутрь неё самой.' : 'Такого места нет.' };
  hooks.notifyJournal('page');
  const moved = pagesOverview(db, userId).pages.find(item => item.id === page.id);
  return { pageId: page.id, title: page.title, moved: true, place: moved ? placeWords(moved) : null };
}

// ── «Доска» ──────────────────────────────────────────────────────────────────

const INBOX_COLUMN = 'Входящие';
function boardOf(db, { userId, now, timeZone }) {
  return boardView(db, { userId, timeZone, now: now(), borrowed: circles.acceptedFor(db, userId).map(row => row.capture_id) });
}

export function listBoard(db, args, context) {
  const view = boardOf(db, context);
  return {
    columns: view.columns.map(column => ({ columnId: column.id, name: column.name, total: column.cards.length, cards: column.cards.slice(0, 12).map(card => ({ captureId: card.captureId, title: card.title, kind: card.type === 'meeting_event' ? 'встреча' : 'задача', ...(card.due ? { due: [card.due.date, card.due.time, card.due.repeat].filter(Boolean).join(' ') } : {}), ...(card.priority ? { priority: card.priority } : {}) })) })),
    closedRecently: view.closed.slice(0, 5).map(card => ({ captureId: card.captureId, title: card.title, closed: card.closedDate })),
  };
}

export function boardAction(db, args, context) {
  const { userId } = context;
  const action = args.action;
  const view = boardOf(db, context);
  const columns = view.columns.map(column => ({ ...column, name: column.id === null ? INBOX_COLUMN : column.name }));
  const column = args.column ? columns.find(item => item.id === args.column) || pickByName(columns, args.column) : null;
  const words = { invalid_name: 'Имя колонки — от 1 до 40 символов.', columns_limit: 'Колонок может быть не больше 12.', column_not_found: 'Колонка не найдена.', card_not_found: 'Этого дела нет на доске.', invalid_index: 'Некорректное место.' };
  if (action === 'move') {
    if (!column) return { error: `Колонки «${cut(args.column, 40)}» нет. Есть: ${columns.map(item => item.name).join(', ')}.` };
    const index = args.position === 'top' ? 0 : column.cards.filter(card => card.captureId !== args.captureId).length;
    const result = moveCard(db, { userId, captureId: args.captureId, columnId: column.id, index });
    if (result.error) return { error: words[result.error] || 'Дело не перенесено.' };
    return { captureId: args.captureId, column: column.name, position: args.position === 'top' ? 'сверху' : 'внизу' };
  }
  if (action === 'create_column') {
    const result = createColumn(db, { userId, name: args.name });
    if (result.error) return { error: words[result.error] || 'Колонка не создана.' };
    return { columnId: result.column.id, name: result.column.name, created: true };
  }
  if (action === 'rename_column' || action === 'delete_column') {
    if (!column || column.id === null) return { error: column ? '«Входящие» не переименовать и не удалить.' : `Колонки «${cut(args.column, 40)}» нет.` };
    const result = action === 'rename_column' ? renameColumn(db, { userId, id: column.id, name: args.name }) : deleteColumn(db, { userId, id: column.id });
    if (result.error) return { error: words[result.error] || 'Не получилось.' };
    return action === 'rename_column' ? { columnId: column.id, name: result.column.name, renamed: true } : { columnId: column.id, name: column.name, deleted: true, cardsGoTo: INBOX_COLUMN };
  }
  return { error: 'Действие: move, create_column, rename_column или delete_column.' };
}

// ── отчёты и напоминания ─────────────────────────────────────────────────────

export function getReport(db, args, { now, timeZone, userId }) {
  const today = dateInZone(now(), timeZone);
  if (args.period === 'day' || !args.period) {
    const date = isoDate(args.date) ? args.date : today;
    const report = dayReport(db, { date, now: now(), timeZone, userId });
    const startAt = dayStartInZone(date, timeZone).getTime(), endAt = dayStartInZone(shiftDate(date, 1), timeZone).getTime();
    // «Сделано» в отчёте дня — записанная работа; закрытые кружком дела живут
    // отдельной строкой, как в «Дне»: и то и другое — ответ на «что я сделал».
    const closed = loadEntries(db, userId).filter(entry => entry.closed && entry.closedAt && Date.parse(entry.closedAt) >= startAt && Date.parse(entry.closedAt) < endAt);
    return {
      period: 'day', date,
      done: report.done.map(item => ({ captureId: item.captureId, title: item.title })),
      closed: closed.map(entry => ({ captureId: entry.id, title: entry.classification.summary || '' })),
      missed: report.missed.map(item => ({ captureId: item.captureId, title: item.title, closedLater: item.closedLater })),
      meetings: report.meetings,
      written: report.feed.length,
    };
  }
  if (!['week', 'month', 'all'].includes(args.period)) return { error: 'Период — day, week, month или all.' };
  const report = periodReport(db, { period: args.period, now: now(), timeZone, userId });
  return {
    period: report.period, from: report.from, to: report.to,
    counters: report.counters,
    overdue: report.overdue.map(item => ({ captureId: item.captureId, title: item.title, daysLate: item.daysLate })),
    questions: report.questions.map(item => ({ captureId: item.captureId, title: item.title, daysOpen: item.daysOpen })),
    projects: report.projects, people: report.people, tags: report.tags,
    stalled: report.stalled,
    discipline: report.discipline,
  };
}

export function listReminders(db, args, context) {
  const hooks = hooksOf(context);
  if (!hooks.reminders) return { error: 'Напоминания недоступны.' };
  return { reminders: hooks.reminders.upcoming(context.userId, { limit: 20 }).map(item => ({ captureId: item.captureId, title: item.title, when: item.when, remindAt: item.remindAt, lead: item.lead })) };
}

// ── внешний календарь, переразбор, настройки ────────────────────────────────

export function exportToCalendar(db, args, context) {
  const { userId, calendar } = context;
  const hooks = hooksOf(context);
  if (!calendar) return { error: 'Календарь недоступен.' };
  const accounts = calendar.listAccounts(userId).filter(account => !account.disabled);
  if (!accounts.length) return { error: 'Внешних календарей нет — подключают их в настройках.' };
  const wanted = lower(args.calendar);
  const options = accounts.flatMap(account => account.calendars.filter(item => item.writable).map(item => ({ account, calendar: item, label: `${account.label} · ${item.name}` })));
  const words = { capture_not_found: 'Запись не найдена.', account_not_found: 'Календарь отключён.', calendar_not_found: 'В этот календарь писать нельзя.', already_exported: 'Эта запись уже в этом календаре.', no_schedule: 'У записи нет срока — отправлять в календарь нечего.', unauthorized: 'Календарь не принял учётные данные, подключите его заново.', not_found: 'Запись в этот календарь не отправляли.' };
  const failed = result => ({ error: `${words[result.error] || 'Календарь не принял запись.'}${result.message ? ` ${result.message}` : ''}` });
  if (args.remove === true) {
    const links = db.prepare('SELECT account_id FROM calendar_links WHERE capture_id=?').all(args.captureId).map(row => row.account_id);
    const account = wanted ? accounts.find(item => links.includes(item.id) && (lower(item.label).includes(wanted) || item.calendars.some(entry => lower(entry.name).includes(wanted)))) : accounts.find(item => links.includes(item.id));
    if (!account) return { error: words.not_found };
    return Promise.resolve(calendar.removeExport({ userId, captureId: args.captureId, accountId: account.id })).then(result => {
      if (result.error) return failed(result);
      hooks.notifyJournal('calendar');
      return { captureId: args.captureId, removedFrom: account.label };
    });
  }
  let target = null;
  if (wanted) {
    const matches = options.filter(option => lower(option.label).includes(wanted));
    if (matches.length !== 1) return { error: matches.length ? `Подходят: ${matches.map(option => option.label).join('; ')}. Какой именно?` : `Календаря «${cut(args.calendar, 40)}» нет. Есть: ${options.map(option => option.label).join('; ')}.` };
    target = matches[0];
  } else {
    const auto = options.find(option => option.account.autoCalendarId === option.calendar.id);
    const primary = options.filter(option => option.calendar.primary);
    target = auto || (options.length === 1 ? options[0] : primary.length === 1 ? primary[0] : null);
    if (!target) return { error: `В какой календарь отправить? Есть: ${options.map(option => option.label).join('; ')}.` };
  }
  return Promise.resolve(calendar.exportCapture({ userId, captureId: args.captureId, accountId: target.account.id, calendarId: target.calendar.id })).then(result => {
    if (result.error) return failed(result);
    hooks.notifyJournal('calendar');
    return { captureId: args.captureId, exportedTo: target.label };
  });
}

export function reclassifyCapture(db, args, context) {
  const hooks = hooksOf(context);
  if (!hooks.reclassify) return { error: 'Переразбор сейчас недоступен.' };
  return Promise.resolve(hooks.reclassify(args.captureId)).then(result => (result?.error ? { error: result.error } : { captureId: args.captureId, reclassified: true, ...result }));
}

// Личные настройки голосом: напоминания, тихие часы, уведомления по поводам,
// слово пробуждения и сон разговора. Ключи и провайдеры — дело администратора,
// голос их не трогает.
export function updateSettings(db, args, context) {
  const hooks = hooksOf(context);
  // Имя — не настройка, а то, как человека зовут в кругах и в «@»: оно живёт в
  // учётной записи и меняется сразу.
  const named = args.displayName !== undefined ? circles.setDisplayName(db, context.userId, String(args.displayName)) : undefined;
  const changes = {};
  if (args.remindDefault !== undefined) changes.remindDefault = args.remindDefault === 'off' ? 'off' : String(args.remindDefault);
  if (args.remindHour !== undefined) changes.remindHour = String(args.remindHour);
  if (args.quietHours !== undefined) changes.quietHours = String(args.quietHours);
  if (args.wakeWord !== undefined) changes.wakeWord = String(args.wakeWord);
  if (args.sleepAfterSeconds !== undefined) changes.sleepAfterSeconds = String(args.sleepAfterSeconds);
  if (args.notify !== undefined) {
    if (!args.notify || !Object.hasOwn(NOTIFICATION_KINDS, args.notify.kind) || NOTIFICATION_KINDS[args.notify.kind].admin || !['off', 'bell', 'phone'].includes(args.notify.mode)) return { error: 'Уведомления: kind — повод из list_notifications, mode — off, bell или phone.' };
    changes.notify = { kind: args.notify.kind, mode: args.notify.mode };
  }
  if (!Object.keys(changes).length) return named !== undefined ? { saved: ['displayName'], displayName: named } : { error: 'Что поменять: remindDefault, remindHour, quietHours, notify, wakeWord, sleepAfterSeconds или displayName.' };
  if (!hooks.saveSettings) return { error: 'Настройки сейчас недоступны.' };
  const saved = hooks.saveSettings(changes);
  return saved.error || named === undefined ? saved : { ...saved, saved: ['displayName', ...saved.saved], displayName: named };
}
