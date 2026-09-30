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
