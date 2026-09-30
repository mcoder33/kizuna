import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { fakeModelService, fakeModelClassification } from './helpers/fake-model.js';
import { createLedger } from '../server/db.js';
import { authed } from './helpers/auth.js';
import { dateInZone, shiftDate } from '../server/reports.js';

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-done-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), calendarKey: Buffer.alloc(32, 7) });
}
const today = () => dateInZone(new Date(), 'Europe/Samara');
const post = (api, raw) => api.post('/api/captures').send({ raw }).expect(201).then(response => response.body.entry);
const taskOf = entry => entry.projections.find(item => item.type === 'task');

// Внешнее событие в кэше календаря: как после синхронизации, только руками.
function externalEvent(app, userId, { id, title, start, end, allDay = 0 }) {
  const db = app.database;
  if (!db.prepare('SELECT 1 FROM calendar_accounts WHERE id=?').get('acc')) db.prepare("INSERT INTO calendar_accounts(id,user_id,provider,label,credentials_enc,calendars_json,created_at) VALUES('acc',?,'caldav','Яндекс','x','[]',?)").run(userId, new Date().toISOString());
  db.prepare("INSERT INTO calendar_events(id,account_id,calendar_id,uid,title,start_at,end_at,all_day,busy,updated_at) VALUES(?,'acc','cal',?,?,?,?,?,1,?)").run(id, `uid-${id}`, title, start, end, allDay, new Date().toISOString());
}

test('done: todos closed by the circle and at birth, by column, newest first; open ones and reopened ones are not there', async () => {
  const app = freshApp(), api = authed(app);
  const column = (await api.post('/api/board/columns').send({ name: 'В работе' }).expect(201)).body;
  const first = await post(api, 'Нужно проверить Hub');
  const second = await post(api, 'Нужно позвонить в салон');
  const open = await post(api, 'Нужно подготовить отчёт');
  const reopened = await post(api, 'Нужно вернуть обратно');
  await api.post('/api/board/move').send({ captureId: first.id, columnId: column.id, index: 0 }).expect(200);
  await api.post(`/api/projections/${taskOf(first).id}/complete`).send({}).expect(200);
  await api.post(`/api/projections/${taskOf(second).id}/complete`).send({}).expect(200);
  await api.post(`/api/projections/${taskOf(reopened).id}/complete`).send({}).expect(200);
  await api.post(`/api/projections/${taskOf(reopened).id}/undo-complete`).send({}).expect(200);
  const born = await post(api, 'Сделал ревью по TCAM');
  assert.equal(born.interpretation.classification.completed, true);

  const done = (await api.get(`/api/done?from=${shiftDate(today(), -6)}&to=${today()}`).expect(200)).body;
  assert.equal(done.today, today());
  assert.equal(done.from, shiftDate(today(), -6));
  assert.equal(done.days.length, 1);
  assert.equal(done.days[0].date, today());
  const titles = done.days[0].items.map(item => item.title);
  assert.equal(titles.length, 3);
  assert.ok(!titles.includes(open.interpretation.classification.summary));
  assert.ok(!titles.includes(reopened.interpretation.classification.summary), 'возвращённое в работу из «Сделано» уходит');
  assert.deepEqual([...done.days[0].items.map(item => item.time)].sort().reverse(), done.days[0].items.map(item => item.time), 'внутри дня — по времени, свежее выше');
  for (const item of done.days[0].items) {
    assert.equal(item.kind, 'todo');
    assert.equal(item.auto, false);
    assert.match(item.time, /^\d\d:\d\d$/);
  }
  const byTitle = Object.fromEntries(done.days[0].items.map(item => [item.title, item]));
  assert.equal(byTitle[first.interpretation.classification.summary].column, 'В работе');
  assert.equal(byTitle[second.interpretation.classification.summary].column, 'Дела', 'без размещения — первая колонка');
  assert.equal(byTitle[born.interpretation.classification.summary].column, 'Дела');
  assert.deepEqual(done.counts, { today: 3, period: 3, meetings: 0 });
  assert.deepEqual(done.byColumn, [{ name: 'Дела', n: 2 }, { name: 'В работе', n: 1 }]);
  assert.equal(done.byDay.length, 7);
  assert.deepEqual(done.byDay.at(-1), { date: today(), n: 3 });
  assert.ok(done.byDay.slice(0, -1).every(day => day.n === 0));
});

test('done: a meeting from the calendar counts once it has ended, on its own day, marked as automatic', async () => {
  const app = freshApp(), api = authed(app);
  const yesterday = shiftDate(today(), -1), tomorrow = shiftDate(today(), 1);
  // Самара — UTC+4: 10:00–11:00 по местному это 06:00–07:00Z.
  externalEvent(app, api.user.id, { id: 'past', title: 'Планёрка', start: `${yesterday}T06:00:00.000Z`, end: `${yesterday}T07:00:00.000Z` });
  externalEvent(app, api.user.id, { id: 'later', title: 'Завтрашняя встреча', start: `${tomorrow}T06:00:00.000Z`, end: `${tomorrow}T07:00:00.000Z` });
  externalEvent(app, api.user.id, { id: 'holiday', title: 'Выходной', start: `${yesterday}T00:00:00.000Z`, end: `${shiftDate(yesterday, 1)}T00:00:00.000Z`, allDay: 1 });
  const todo = await post(api, 'Нужно отправить смету');
  await api.post(`/api/projections/${taskOf(todo).id}/complete`).send({}).expect(200);

  const done = (await api.get(`/api/done?from=${yesterday}&to=${tomorrow}`).expect(200)).body;
  assert.deepEqual(done.days.map(day => day.date), [today(), yesterday], 'дни от свежего к старому');
  assert.deepEqual(done.days[1].items, [{ id: 'ext:past', title: 'Планёрка', time: '11:00', kind: 'meeting', column: 'Встречи', auto: true }], 'время встречи — её конец; будущая и «весь день» не считаются');
  assert.deepEqual(done.counts, { today: 1, period: 2, meetings: 1 });
  assert.deepEqual(done.byColumn.map(row => row.name).sort(), ['Дела', 'Встречи'].sort());
  assert.deepEqual(done.byDay, [{ date: yesterday, n: 1 }, { date: today(), n: 1 }, { date: tomorrow, n: 0 }]);
});

test('done: old finished reports stay in history, other people do not see them, bad ranges are refused', async () => {
  const app = freshApp(), api = authed(app);
  // Старый отчёт о сделанном: запись-результат с признаком, но без проекции-дела.
  createLedger(app.database, { raw: 'Сделал релиз хаба', classification: { ...fakeModelClassification('Сделал релиз хаба'), primaryType: 'outcome_decision', completed: true }, provider: 'manual', userId: api.user.id });
  const done = (await api.get(`/api/done?from=${today()}&to=${today()}`).expect(200)).body;
  assert.deepEqual(done.days[0].items.map(item => [item.title, item.column]), [['Сделал релиз хаба', 'Без колонки']]);
  assert.equal(done.days[0].items[0].legacy, true, 'старая запись — по флагу, а не по имени колонки');

  const stranger = authed(app, { email: 'other@kizuna.test', role: 'user' });
  assert.deepEqual((await stranger.get(`/api/done?from=${today()}&to=${today()}`).expect(200)).body.days, []);
  const byDefault = (await api.get('/api/done').expect(200)).body;
  assert.equal(byDefault.to, today());
  assert.equal(byDefault.from, shiftDate(today(), -6));
  await api.get('/api/done?from=2026-02-31&to=2026-03-01').expect(400);
  await api.get(`/api/done?from=${today()}&to=${shiftDate(today(), -1)}`).expect(400);
  await api.get(`/api/done?from=${shiftDate(today(), -400)}&to=${today()}`).expect(400);
  await request(app).get('/api/done').expect(401);
});

test('done: an occurrence of a repeat closed by the circle counts on its day, the record itself stays open; undo takes it back', async () => {
  const app = freshApp(), api = authed(app);
  const entry = await post(api, 'Нужно проверить бэкапы каждый день');
  const task = taskOf(entry);
  await api.post(`/api/projections/${task.id}/complete`).send({ occurrence: today() }).expect(200);
  const range = `from=${shiftDate(today(), -6)}&to=${today()}`;
  let done = (await api.get(`/api/done?${range}`).expect(200)).body;
  assert.equal(done.counts.today, 1);
  assert.deepEqual(done.days[0].items.map(item => [item.title, item.kind, item.occurrence]), [[entry.interpretation.classification.summary, 'todo', today()]]);
  assert.ok(done.days[0].items[0].projectionId, 'по строке можно вернуть');
  const report = (await api.get(`/api/reports/day?date=${today()}`)).body;
  if (report.done) assert.equal(report.done.filter(item => item.captureId === entry.id).length, 1);
  await api.post(`/api/projections/${done.days[0].items[0].projectionId}/undo-complete`).send({ occurrence: today() }).expect(200);
  done = (await api.get(`/api/done?${range}`).expect(200)).body;
  assert.equal(done.counts.today, 0);
});

test('done: the range is capped at 62 days and old reports carry the legacy flag', async () => {
  const app = freshApp(), api = authed(app);
  await api.get(`/api/done?from=${shiftDate(today(), -62)}&to=${today()}`).expect(200);
  await api.get(`/api/done?from=${shiftDate(today(), -63)}&to=${today()}`).expect(400);
});

test('done: a meeting across midnight closes on the day and hour of its end, not of its start', async () => {
  const app = freshApp(), api = authed(app);
  const dayBefore = shiftDate(today(), -2), yesterday = shiftDate(today(), -1);
  // 23:00 позавчера – 00:30 вчера по Самаре (UTC+4).
  externalEvent(app, api.user.id, { id: 'night', title: 'Ночной релиз', start: `${dayBefore}T19:00:00.000Z`, end: `${dayBefore}T20:30:00.000Z` });
  const done = (await api.get(`/api/done?from=${dayBefore}&to=${yesterday}`).expect(200)).body;
  assert.deepEqual(done.days.map(day => [day.date, day.items.map(item => [item.title, item.time])]), [[yesterday, [['Ночной релиз', '00:30']]]]);
});

// Закрытая подзадача не стоит в «Сделано» отдельной строкой: она входит в счёт
// закрытого родителя («1/2»), как и на доске.
const stepOf = async (api, parentId, title) => (await api.post(`/api/captures/${parentId}/subtasks`).send({ title }).expect(201)).body.entry;
const closeTask = async (api, entry) => { for (const projection of entry.projections.filter(item => item.type === 'task')) await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200); };

test('done: only=byDay answers with the per-day counts alone, the same numbers as the full answer', async () => {
  const app = freshApp(), api = authed(app);
  const yesterday = shiftDate(today(), -1);
  externalEvent(app, api.user.id, { id: 'past', title: 'Планёрка', start: `${yesterday}T06:00:00.000Z`, end: `${yesterday}T07:00:00.000Z` });
  const first = await post(api, 'Нужно проверить Hub');
  const second = await post(api, 'Нужно позвонить в салон');
  await post(api, 'Нужно остаться открытым');
  await api.post(`/api/projections/${taskOf(first).id}/complete`).send({}).expect(200);
  await api.post(`/api/projections/${taskOf(second).id}/complete`).send({}).expect(200);
  const range = `from=${shiftDate(today(), -6)}&to=${today()}`;
  const full = (await api.get(`/api/done?${range}`).expect(200)).body;
  const slim = (await api.get(`/api/done?${range}&only=byDay`).expect(200)).body;
  assert.equal(slim.byDay.length, 7, 'семь дней диапазона, по записи на день');
  assert.deepEqual(slim.byDay, full.byDay, 'числа те же, что в обычном ответе');
  assert.deepEqual(slim.byDay.slice(-2), [{ date: yesterday, n: 1 }, { date: today(), n: 2 }], 'встреча календаря входит в счёт своего дня, как и в обычном ответе');
  assert.deepEqual(slim.counts, full.counts);
  assert.deepEqual([slim.from, slim.to, slim.today], [full.from, full.to, full.today]);
  assert.equal('days' in slim, false, 'строки дел клиенту не нужны');
  assert.equal('byColumn' in slim, false);
  assert.ok(full.days.length > 0 && full.byColumn.length > 0, 'обычный ответ по-прежнему с днями и колонками');
  // окно в тридцать дней — как его зовёт страница
  const month = (await api.get(`/api/done?from=${shiftDate(today(), -29)}&to=${today()}&only=byDay`).expect(200)).body;
  assert.equal(month.byDay.length, 30);
  assert.equal(month.byDay.at(-1).n, 2);
  // чужое значение — ошибка, а не молчаливый полный ответ
  await api.get(`/api/done?${range}&only=days`).expect(400);
  await api.get(`/api/done?${range}&only=byDay&only=days`).expect(400);
  await request(app).get(`/api/done?${range}&only=byDay`).expect(401);
});

test('done: a closed subtask is not a row of its own, the closed parent carries {done,total}', async () => {
  const app = freshApp(), api = authed(app);
  const range = `from=${shiftDate(today(), -6)}&to=${today()}`;
  const parent = await post(api, 'Купить кофе для Hub');
  const alone = await post(api, 'Нужно проверить колонки');
  const stock = await stepOf(api, parent.id, 'Проверить запас в шкафу');
  const jar = await stepOf(api, parent.id, 'Взять с собой банку');
  await closeTask(api, stock);
  await closeTask(api, jar);
  // Обе подзадачи закрыты, родитель открыт: «Сделано» пусто — строки подзадач не считаются делами.
  let done = (await api.get(`/api/done?${range}`).expect(200)).body;
  assert.deepEqual(done.days, []);
  assert.equal(done.counts.today, 0);
  assert.equal(done.counts.period, 0);
  assert.deepEqual(done.byColumn, []);
  // Закрыли родителя и дело без подзадач: две строки, у родителя счёт, у второго поля нет.
  await closeTask(api, parent);
  await closeTask(api, alone);
  done = (await api.get(`/api/done?${range}`).expect(200)).body;
  assert.equal(done.counts.today, 2);
  assert.equal(done.counts.period, 2);
  const items = done.days[0].items;
  assert.deepEqual(items.map(item => item.title).sort(), [alone, parent].map(entry => entry.interpretation.classification.summary).sort());
  assert.deepEqual(items.find(item => item.id === parent.id).subtasks, { done: 2, total: 2 });
  assert.equal('subtasks' in items.find(item => item.id === alone.id), false);
  assert.equal(done.byColumn.reduce((total, column) => total + column.n, 0), 2, 'счётчики колонок — только дела');
  // Вернули подзадачу в работу: родитель остаётся строкой «Сделано», счёт откатился.
  await api.post(`/api/projections/${jar.projections.find(item => item.type === 'task').id}/undo-complete`).send({}).expect(200);
  done = (await api.get(`/api/done?${range}`).expect(200)).body;
  assert.deepEqual(done.days[0].items.find(item => item.id === parent.id).subtasks, { done: 1, total: 2 });
});

test('done: the day report does not list a closed subtask either; its closed parent keeps the count', async () => {
  const app = freshApp(), api = authed(app);
  const parent = await post(api, 'Купить кофе для Hub');
  const stock = await stepOf(api, parent.id, 'Проверить запас в шкафу');
  await closeTask(api, stock);
  // «Что делал»: сделал X — туду, закрытая при записи; её подзадача закрыта кружком.
  const born = await post(api, 'Сделал ревью по TCAM');
  const reviewStep = await stepOf(api, born.id, 'Разобрать замечания');
  await closeTask(api, reviewStep);
  const report = (await api.get(`/api/reports/day?date=${today()}`).expect(200)).body;
  assert.deepEqual(report.done.map(item => item.captureId), [born.id], 'подзадача в «Сделано» отдельно не стоит');
  assert.deepEqual(report.done[0].subtasks, { done: 1, total: 1 });
  assert.equal(report.feed.some(item => [stock.id, reviewStep.id].includes(item.captureId)), false, 'ленты дня подзадачи тоже не видят');
  const period = (await api.get('/api/reports?period=week').expect(200)).body;
  assert.equal(period.counters.done, 1, 'в отчёте периода закрытые подзадачи не считаются делами: закрыт только «Сделал ревью»');
});
