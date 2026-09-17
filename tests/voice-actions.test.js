import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';

// Голос — тот же человек, что и в интерфейсе: всё, что можно сделать руками,
// можно сказать. Тесты ходят через /api/voice/tool, как браузер во время
// разговора, и сверяют результат с тем, что показывают обычные маршруты.
const NOW = new Date('2026-09-17T09:00:00Z'); // четверг, 12:00 в Самаре
function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-voice-actions-'));
  const now = () => NOW;
  return createApp({ aiService: fakeModelService({ now }), databasePath: path.join(dir, 'test.sqlite'), now });
}
async function pair() {
  const app = freshApp();
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  await sasha.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  return { app, sasha, anya, circle };
}
const tool = async (api, name, args = {}) => (await api.post('/api/voice/tool').send({ name, arguments: args }).expect(200)).body.result;
const failure = async (api, name, args = {}) => (await api.post('/api/voice/tool').send({ name, arguments: args }).expect(400)).body.error.message;
const capture = async (api, raw, extra = {}) => (await api.post('/api/captures').send({ raw, ...extra }).expect(201)).body.entry;
const scheduleOf = async (api, id) => (await api.get(`/api/captures/${id}`).expect(200)).body.entry.interpretation.classification.entities.schedule;
const zoneDate = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Samara', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

test('«готово» голосом закрывает дело, как кружок, а «верни» открывает', async () => {
  const me = authed(freshApp());
  const entry = await capture(me, 'Проверить доступ голосового агента сегодня в 11:00', { primaryType: 'todo' });
  const closed = await tool(me, 'complete_capture', { captureId: entry.id });
  assert.equal(closed.done, true);
  // Дело осталось делом: ушло из открытых, а не превратилось в результат.
  const day = await tool(me, 'list_today');
  assert.equal(day.hours.find(item => item.captureId === entry.id).done, true);
  const read = await tool(me, 'read_capture', { captureId: entry.id });
  assert.equal(read.type, 'задача');
  assert.equal(read.closed, true);
  const board = (await me.get('/api/board').expect(200)).body;
  assert.ok(board.closed.some(card => card.captureId === entry.id), 'на «Доске» — среди закрытых');
  assert.equal((await tool(me, 'complete_capture', { captureId: entry.id, undo: true })).done, false);
  assert.equal((await tool(me, 'read_capture', { captureId: entry.id })).closed, false);
  // Заметку закрыть нечем: сделанной она не бывает.
  const note = await capture(me, 'Доступы к ГитЛабу — ссылки', { primaryType: 'note' });
  assert.match(await failure(me, 'complete_capture', { captureId: note.id }), /Закрываются только дела и встречи/);
});

test('повтор закрывается на один день, серия живёт; «верни» и «закрой снова» оба доходят', async () => {
  const me = authed(freshApp());
  const entry = await capture(me, 'Разобрать входящие', { primaryType: 'todo', due: { date: '2026-09-17', time: '10:00', repeat: { freq: 'daily', interval: 1 } } });
  assert.equal(entry.interpretation.classification.entities.schedule.repeat.freq, 'daily');
  const closed = await tool(me, 'complete_capture', { captureId: entry.id });
  assert.equal(closed.occurrence, '2026-09-17');
  assert.equal(closed.next, '2026-09-18');
  let schedule = await scheduleOf(me, entry.id);
  assert.deepEqual(schedule.skip, ['2026-09-17']);
  assert.equal(schedule.repeat.freq, 'daily', 'серия осталась');
  assert.equal(schedule.time, '10:00');
  assert.ok(!(await tool(me, 'list_today')).hours.some(item => item.captureId === entry.id), 'закрытого дня в «Дне» нет');
  // Вернуть и закрыть снова — две разные поправки, а не повтор первой.
  await tool(me, 'complete_capture', { captureId: entry.id, undo: true });
  assert.deepEqual((await scheduleOf(me, entry.id)).skip ?? [], []);
  await tool(me, 'complete_capture', { captureId: entry.id });
  assert.deepEqual((await scheduleOf(me, entry.id)).skip, ['2026-09-17']);
  assert.match(await failure(me, 'complete_capture', { captureId: entry.id, date: '2026-09-17' }), /уже закрыт/);
  assert.equal((await tool(me, 'complete_capture', { captureId: entry.id, series: true })).series, 'закрыта целиком');
});

test('поправка голосом — как в карточке: перенос хранит время, повтор и напоминание', async () => {
  const me = authed(freshApp());
  const entry = await capture(me, 'Созвон с Ильёй каждую неделю в 11:00', { primaryType: 'todo' });
  await tool(me, 'update_capture', { captureId: entry.id, due: { date: '2026-09-18', remind: '30' } });
  let read = await tool(me, 'read_capture', { captureId: entry.id });
  assert.equal(read.schedule.time, '11:00', 'перенос без времени хранит время');
  assert.equal(read.schedule.remind, 30);
  assert.match(read.schedule.repeat, /неделю/);
  await tool(me, 'update_capture', { captureId: entry.id, due: { date: '2026-09-19' } });
  read = await tool(me, 'read_capture', { captureId: entry.id });
  assert.equal(read.schedule.remind, 30, 'напоминание при переносе не теряется');
  assert.equal(read.schedule.date, '2026-09-19');
  const renamed = await tool(me, 'update_capture', { captureId: entry.id, title: 'Созвон с Ильёй и Аней', type: 'meeting', people: ['Илья', 'Аня'], followUp: 'Прислать повестку', priority: 'high' });
  assert.equal(renamed.summary, 'Созвон с Ильёй и Аней');
  assert.equal(renamed.type, 'встреча');
  read = await tool(me, 'read_capture', { captureId: entry.id });
  assert.deepEqual(read.people, ['Илья', 'Аня']);
  assert.equal(read.followUp, 'Прислать повестку');
  assert.equal(read.priority, 'high');
  await tool(me, 'update_capture', { captureId: entry.id, clearDue: true });
  assert.equal((await tool(me, 'read_capture', { captureId: entry.id })).schedule, null);
  assert.match(await failure(me, 'update_capture', { captureId: entry.id, done: true }), /complete_capture/);
  assert.match(await failure(me, 'update_capture', { captureId: entry.id }), /Нечего менять/);
});

test('запись голосом: встреча со сроком, срок без типа переспрашивается, «в страницу:» раскладывается сразу', async () => {
  const app = freshApp();
  const me = authed(app);
  assert.match(await failure(me, 'create_capture', { text: 'созвон с ltfinance', due: { date: '2026-09-18', time: '12:00' } }), /нужен тип/);
  const meeting = await tool(me, 'create_capture', { text: 'созвон с ltfinance', type: 'meeting', due: { date: '2026-09-18', time: '12:00', remind: '10' } });
  const job = app.database.prepare('SELECT overrides_json FROM capture_jobs WHERE capture_id=?').get(meeting.captureId);
  assert.deepEqual(JSON.parse(job.overrides_json), { primaryType: 'meeting_event', due: { date: '2026-09-18', time: '12:00', remind: 10 } });
  const page = await tool(me, 'place_page', { title: 'Интеграция' });
  const note = await tool(me, 'create_capture', { text: 'в Интеграция: логин от стенда', type: 'note' });
  assert.equal(app.database.prepare('SELECT parent_id FROM note_places WHERE capture_id=?').get(note.captureId)?.parent_id, page.pageId);
  // Дописать к записи без своей заметки — значит продолжить её текст, а не стереть.
  const plain = await capture(me, 'Исходный текст записи', { primaryType: 'note' });
  await tool(me, 'append_note', { captureId: plain.id, text: 'дописано голосом' });
  assert.equal((await tool(me, 'read_capture', { captureId: plain.id, full: true })).note, 'Исходный текст записи\n\nдописано голосом');
});

test('день голосом: часы, дела на сегодня, просроченное, запас и то, что ещё разбирается', async () => {
  const me = authed(freshApp());
  const timed = await capture(me, 'Проверить доступ голосового агента сегодня в 11:00', { primaryType: 'todo' });
  const today = await capture(me, 'Проработать тему с путешествиями', { primaryType: 'todo', due: { date: '2026-09-17' } });
  const late = await capture(me, 'Отправить смету', { primaryType: 'todo', due: { date: '2026-09-15' } });
  await capture(me, 'Попробовать Silero TTS', { primaryType: 'todo' });
  const queued = await tool(me, 'create_capture', { text: 'ещё не разобрано' });
  const day = await tool(me, 'list_today');
  assert.deepEqual(day.hours.map(item => item.captureId), [timed.id]);
  assert.deepEqual(day.today.map(item => item.captureId), [today.id]);
  assert.deepEqual(day.overdue.map(item => [item.captureId, item.daysLate]), [[late.id, 2]]);
  assert.equal(day.undated.count, 1);
  assert.deepEqual(day.parsing.map(item => item.captureId), [queued.captureId]);
  assert.equal(day.total, 5);
  assert.equal(day.open[0].parsing, true, 'только что сказанное — первым');
  const tomorrow = await tool(me, 'list_today', { date: '2026-09-18' });
  assert.equal(tomorrow.isToday, false);
  assert.equal(tomorrow.overdue, undefined, 'просроченное — про сегодня');
});

test('просьбы голосом: отдать Ане, «беру», закрыть взятое — Саша видит «сделано»', async () => {
  const { sasha, anya } = await pair();
  const entry = await capture(sasha, 'Прислать смету по Хабу', { primaryType: 'todo', due: { date: '2026-09-18' } });
  assert.match(await failure(sasha, 'assign_capture', { captureId: entry.id, person: 'Петя' }), /Аня/, 'не нашёл — называет, кто есть');
  const given = await tool(sasha, 'assign_capture', { captureId: entry.id, person: 'Ане' });
  assert.deepEqual([given.to, given.state], ['Аня', 'ждёт ответа']);
  const inbox = await tool(anya, 'list_inbox');
  assert.equal(inbox.requests.length, 1);
  assert.equal(inbox.requests[0].from, 'Саша');
  // Чужую запись голос прочитает, но не поправит — как карточка.
  assert.equal((await tool(anya, 'read_capture', { captureId: entry.id })).mine, false);
  assert.match(await failure(anya, 'update_capture', { captureId: entry.id, title: 'моё' }), /не найдена/);
  assert.match(await failure(anya, 'complete_capture', { captureId: entry.id }), /не найдена/, 'закрыть можно только взятое');
  const taken = await tool(anya, 'respond_request', { assignmentId: inbox.requests[0].assignmentId, take: true });
  assert.match(taken.answer, /взято/);
  const tomorrow = await tool(anya, 'list_today', { date: '2026-09-18' });
  assert.ok(tomorrow.today.some(item => item.captureId === entry.id && item.from === 'Саша'), 'взятое — в её дне на свой срок');
  const done = await tool(anya, 'complete_capture', { captureId: entry.id });
  assert.equal(done.authorSees, 'Саша увидит «сделано»');
  assert.equal((await tool(sasha, 'list_inbox')).waiting[0].state, 'сделано');
  const bell = await tool(sasha, 'list_notifications', { filter: 'people' });
  assert.ok(bell.items.some(item => item.text === 'Аня отмечает сделанным «Прислать смету по Хабу»'), JSON.stringify(bell.items));
  assert.match(await failure(anya, 'assign_capture', { captureId: entry.id, cancel: true }), /не найдена/, 'снять просьбу может только автор');
});

test('обсуждение и разговор круга голосом: призыв с вопросом «открыть?», ответ, реакция, закреп', async () => {
  const { app, sasha, anya } = await pair();
  const entry = await capture(sasha, 'Смета по интеграции', { primaryType: 'note' });
  // Аня эту запись не видит: позвать её — значит поделиться, и голос спрашивает.
  const asked = await tool(sasha, 'write_message', { captureId: entry.id, text: '@Аня глянь смету' });
  assert.equal(asked.needsShare, true);
  assert.deepEqual(asked.people, ['Аня']);
  const sent = await tool(sasha, 'write_message', { captureId: entry.id, text: '@Аня глянь смету', share: 'yes' });
  assert.deepEqual(sent.called, ['Аня']);
  assert.deepEqual(sent.opened, ['Аня']);
  assert.equal((await tool(anya, 'list_inbox')).calls[0].from, 'Саша');
  const thread = await tool(anya, 'read_conversation', { captureId: entry.id });
  assert.equal(thread.unread, 1);
  assert.equal(thread.messages[0].text, '@Аня глянь смету');
  assert.equal((await tool(anya, 'list_inbox')).calls.length, 0, 'прочитанный призыв гаснет');
  await tool(anya, 'write_message', { captureId: entry.id, text: 'Посмотрела, всё ок', replyTo: thread.messages[0].commentId });
  const answer = (await tool(sasha, 'read_conversation', { captureId: entry.id })).messages.at(-1);
  assert.equal(answer.from, 'Аня');
  assert.equal((await tool(sasha, 'message_action', { action: 'react', captureId: entry.id, commentId: answer.commentId, emoji: '👍' })).added, true);

  const general = (await tool(anya, 'list_circles')).circles[0].rooms.find(room => room.name === 'Общий');
  assert.equal((await tool(sasha, 'write_message', { roomId: general.roomId, text: 'Демо в четверг в 11' })).sent, true);
  const everywhere = await tool(anya, 'read_conversation');
  assert.ok(everywhere.rooms.some(room => room.roomId === general.roomId && room.unread === 1));
  const room = await tool(anya, 'read_conversation', { roomId: general.roomId });
  assert.equal(room.unread, 1);
  const last = room.messages.at(-1);
  assert.equal(last.text, 'Демо в четверг в 11');
  await tool(anya, 'message_action', { action: 'pin', roomId: general.roomId, messageId: last.messageId });
  assert.equal((await tool(sasha, 'read_conversation', { roomId: general.roomId })).pinned, 'Демо в четверг в 11');
  // Кто не в круге, в его разговор не напишет.
  const stranger = authed(app, { email: 'petya@kizuna.test', role: 'user' });
  assert.match(await failure(stranger, 'write_message', { roomId: general.roomId, text: 'привет' }), /не найден/);
  assert.match(await failure(stranger, 'read_conversation', { captureId: entry.id }), /не найдена/);
});

test('колокольчик голосом: список, прочитано, отложить, прочитать всё', async () => {
  const { sasha, anya } = await pair();
  const entry = await capture(sasha, 'Прислать смету', { primaryType: 'todo' });
  await tool(sasha, 'assign_capture', { captureId: entry.id, person: 'Аня' });
  const bell = await tool(anya, 'list_notifications');
  const request = bell.items.find(item => item.kind === 'request');
  assert.equal(request.waits, true);
  assert.equal(bell.counts.waits, 1);
  const read = await tool(anya, 'notification_action', { action: 'read', notificationId: request.notificationId });
  assert.equal(read.counts.unread, bell.counts.unread - 1);
  const snoozed = await tool(anya, 'notification_action', { action: 'snooze', notificationId: request.notificationId, minutes: 30 });
  assert.equal(snoozed.snoozedUntil, '2026-09-17T09:30:00.000Z');
  assert.ok(!(await tool(anya, 'list_notifications')).items.some(item => item.notificationId === request.notificationId), 'отложенное уходит до срока');
  assert.equal((await tool(anya, 'notification_action', { action: 'read_all' })).counts.unread, 0);
  // «Убери» и «очисти» — как в колокольчике: ждущее ответа не уходит.
  assert.match(await failure(anya, 'notification_action', { action: 'dismiss', notificationId: request.notificationId }), /ждёт ответа/);
  await tool(sasha, 'write_message', { roomId: (await tool(sasha, 'list_circles')).circles[0].rooms[0].roomId, text: '@Аня глянь' });
  const call = (await tool(anya, 'list_notifications')).items.find(item => item.kind === 'call');
  assert.equal((await tool(anya, 'notification_action', { action: 'dismiss', notificationId: call.notificationId })).dismissed, true);
  assert.ok(!(await tool(anya, 'list_notifications')).items.some(item => item.notificationId === call.notificationId));
  assert.equal(typeof (await tool(anya, 'notification_action', { action: 'clear' })).dismissed, 'number');
  assert.match(await failure(sasha, 'notification_action', { action: 'read', notificationId: request.notificationId }), /не найдено/, 'чужое не трогается');
});

test('страницы голосом: завести внутри другой, прочитать целиком, переложить', async () => {
  const me = authed(freshApp());
  const parent = await tool(me, 'place_page', { title: 'Интеграция ltfinance' });
  const child = await tool(me, 'place_page', { title: 'Доступы', parent: 'интеграция' });
  assert.equal(child.place, 'внутри «Интеграция ltfinance»');
  assert.equal((await tool(me, 'list_pages', { query: 'доступ' })).pages[0].place, 'внутри «Интеграция ltfinance»');
  await tool(me, 'append_note', { captureId: child.pageId, text: 'Логин в [[Интеграция ltfinance]]' });
  const read = await tool(me, 'read_capture', { captureId: parent.pageId, full: true });
  assert.deepEqual(read.page.children, ['Доступы']);
  assert.deepEqual(read.page.linkedFrom, ['Доступы']);
  assert.match(await failure(me, 'place_page', { pageId: parent.pageId, parent: 'Доступы' }), /внутрь неё самой/);
  assert.equal((await tool(me, 'place_page', { pageId: child.pageId, parent: 'root' })).place, 'корень');
});

test('«Доска», круги, отчёт, напоминания и настройки голосом', async () => {
  const { app, sasha, anya } = await pair();
  const deed = await capture(sasha, 'Допилить бот детектор', { primaryType: 'todo' });
  assert.equal((await tool(sasha, 'board_action', { action: 'create_column', name: 'В работе' })).created, true);
  assert.equal((await tool(sasha, 'board_action', { action: 'move', captureId: deed.id, column: 'в работе', position: 'top' })).column, 'В работе');
  assert.deepEqual((await tool(sasha, 'list_board')).columns.find(column => column.name === 'В работе').cards.map(card => card.captureId), [deed.id]);
  assert.match(await failure(sasha, 'board_action', { action: 'move', captureId: deed.id, column: 'Нет такой' }), /Есть: Входящие, В работе/);

  const home = await tool(sasha, 'manage_circle', { action: 'create', name: 'Семья' });
  assert.equal((await tool(sasha, 'manage_circle', { action: 'rename', circle: 'семья', name: 'Дом' })).name, 'Дом');
  assert.equal((await tool(sasha, 'manage_circle', { action: 'add_person', circle: 'Дом', person: 'Аня' })).added, 'Аня');
  assert.equal((await tool(sasha, 'manage_circle', { action: 'create_room', circle: 'Дом', name: 'Отпуск', everyone: true })).everyone, true);
  assert.ok((await tool(anya, 'list_circles')).circles.find(circle => circle.circleId === home.circleId).rooms.some(room => room.name === 'Отпуск'));
  assert.equal((await tool(anya, 'manage_circle', { action: 'mute', circle: 'Дом' })).muted, true);
  assert.match(await failure(anya, 'manage_circle', { action: 'rename', circle: 'Дом', name: 'Моё' }), /хозяин/);

  const call = await capture(sasha, 'Созвониться с юристом сегодня в 15:00', { primaryType: 'todo' });
  const outcome = await capture(sasha, 'Починил ретрай в боте', { primaryType: 'outcome' });
  await tool(sasha, 'complete_capture', { captureId: call.id });
  const report = await tool(sasha, 'get_report', { period: 'day', date: zoneDate(outcome.createdAt) });
  assert.ok(report.closed.some(item => item.captureId === call.id), 'закрытое кружком');
  assert.ok(report.done.some(item => item.captureId === outcome.id), 'записанная работа');
  assert.equal(typeof (await tool(sasha, 'get_report', { period: 'week' })).counters.captures, 'number');

  const later = await capture(sasha, 'Отправить договор сегодня в 18:00', { primaryType: 'todo' });
  assert.ok((await tool(sasha, 'list_reminders')).reminders.some(item => item.captureId === later.id));
  assert.deepEqual((await tool(sasha, 'update_settings', { remindDefault: '30', notify: { kind: 'reaction', mode: 'off' } })).saved, ['remindDefault', 'notify:reaction']);
  const settings = (await sasha.get('/api/settings').expect(200)).body.settings;
  assert.equal(settings.remindDefault, '30');
  assert.equal(JSON.parse(settings.notifyPrefs).reaction, 'off');
  assert.match(await failure(sasha, 'update_settings', { remindHour: '25:00' }), /Некорректное значение/);
  assert.match(await failure(sasha, 'export_to_calendar', { captureId: later.id }), /Внешних календарей нет/);
  const again = await tool(sasha, 'reclassify_capture', { captureId: later.id });
  assert.equal(again.reclassified, true);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS n FROM interpretations WHERE capture_id=?").get(later.id).n, 2, 'новая версия разбора');
});

test('разговоры круга голосом: переименовать комнату, позвать, выйти; назваться и распустить круг', async () => {
  const { app, sasha, anya } = await pair();
  const petya = authed(app, { email: 'petya@kizuna.test', role: 'user' });
  await petya.patch('/api/account').send({ name: 'Петя' }).expect(200);
  await tool(sasha, 'manage_circle', { action: 'create_room', circle: 'Хаб', name: 'Смета', people: ['Аня'] });
  assert.equal((await tool(sasha, 'manage_circle', { action: 'rename_room', circle: 'Хаб', room: 'смета', name: 'Смета и сроки' })).renamed, true);
  assert.equal((await tool(sasha, 'manage_circle', { action: 'add_person', circle: 'Хаб', person: 'Петя' })).added, 'Петя');
  const invited = await tool(sasha, 'manage_circle', { action: 'add_to_room', circle: 'Хаб', room: 'Смета и сроки', person: 'Петю' });
  assert.deepEqual([...invited.people].sort(), ['Аня', 'Петя', 'Саша']);
  assert.equal((await tool(anya, 'manage_circle', { action: 'leave_room', circle: 'Хаб', room: 'Смета и сроки' })).left, true);
  assert.match(await failure(anya, 'manage_circle', { action: 'leave_room', circle: 'Хаб', room: 'Общий' }), /Общий разговор/);
  assert.equal((await tool(anya, 'update_settings', { displayName: 'Анна' })).displayName, 'Анна');
  assert.match(await failure(anya, 'manage_circle', { action: 'dissolve', circle: 'Хаб' }), /хозяин/);
  assert.equal((await tool(sasha, 'manage_circle', { action: 'dissolve', circle: 'Хаб' })).dissolved, true);
  assert.equal((await tool(anya, 'list_circles')).circles.length, 0);
});
