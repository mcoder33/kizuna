import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { remindMoment, validRemind } from '../server/reminders.js';
import { dateInZone, shiftDate } from '../server/reports.js';

// Напоминание — свойство срока, считает его сервер. Дело со временем
// напоминает за N минут до начала, дело без времени — в час напоминаний;
// одно напоминание уходит один раз, пропущенное дольше часа не догоняет.
function fakePush() {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'private' }),
    async sendNotification(subscription, body, options) {
      if (subscription.endpoint.endsWith('/gone')) { const error = new Error('Gone'); error.statusCode = 410; throw error; }
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body), subject: options.vapidDetails.subject });
      return { statusCode: 201 };
    },
  };
}
function freshApp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-reminders-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), pushTransport: fakePush(), ...options });
}
const TZ = 'Europe/Samara';
const subscription = (endpoint) => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } });

test('момент напоминания: за N минут до дела со временем, в час напоминаний — без времени, «off» молчит', () => {
  const timed = { date: '2026-09-15', time: '11:00' };
  // 11:00 самарского — 07:00Z; по умолчанию за 15 минут.
  assert.equal(remindMoment(timed, { timeZone: TZ, defaults: { minutes: '15', hour: '09:00' } }).toISOString(), '2026-09-15T06:45:00.000Z');
  assert.equal(remindMoment({ ...timed, remind: 60 }, { timeZone: TZ, defaults: { minutes: '15' } }).toISOString(), '2026-09-15T06:00:00.000Z');
  assert.equal(remindMoment({ ...timed, remind: 'off' }, { timeZone: TZ, defaults: { minutes: '15' } }), null);
  assert.equal(remindMoment(timed, { timeZone: TZ, defaults: { minutes: 'off' } }), null);
  // Без времени: не «за 15 минут до 23:59», а утром в час напоминаний.
  const undated = { date: '2026-09-15', time: null };
  assert.equal(remindMoment(undated, { timeZone: TZ, defaults: { hour: '09:00' } }).toISOString(), '2026-09-15T05:00:00.000Z');
  assert.equal(remindMoment(undated, { timeZone: TZ, defaults: { hour: 'off' } }), null);
  assert.equal(remindMoment({ ...undated, remind: 0 }, { timeZone: TZ, defaults: { hour: 'off' } }).toISOString(), '2026-09-15T05:00:00.000Z');
  assert.equal(remindMoment({ date: null }, { timeZone: TZ }), null);
  assert.deepEqual([validRemind(0), validRemind(1440), validRemind('off'), validRemind(-1), validRemind(1.5), validRemind('15')], [true, true, true, false, false, false]);
});

test('напоминание уходит в поток и push один раз, пропущенное за простоем помечается и молчит', async () => {
  let clock = new Date('2026-09-15T06:00:00.000Z');
  const push = fakePush();
  const app = freshApp({ now: () => clock, pushTransport: push, timeZone: TZ });
  const api = authed(app);
  const other = authed(app, { email: 'other@kizuna.test', role: 'user' });
  await api.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/one') }).expect(201);
  const todo = (await api.post('/api/captures').send({ raw: 'позвонить Антону', primaryType: 'todo', due: { date: '2026-09-15', time: '11:00' } }).expect(201)).body.entry;
  await other.post('/api/captures').send({ raw: 'чужое дело', primaryType: 'todo', due: { date: '2026-09-15', time: '11:00' } }).expect(201);
  const upcoming = (await api.get('/api/reminders/upcoming').expect(200)).body.reminders;
  assert.deepEqual(upcoming.map(item => [item.captureId, item.remindAt, item.lead]), [[todo.id, '2026-09-15T06:45:00.000Z', 'через 15 мин']]);
  // Рано: ничего не уходит.
  assert.deepEqual(await app.reminders.tick(), []);
  clock = new Date('2026-09-15T06:45:30.000Z');
  const sent = await app.reminders.tick();
  // Проход общий на всех: чужое дело тоже ушло — но своему хозяину, у которого подписки нет.
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.filter(item => item.captureId === todo.id).map(item => [item.title, item.body]), [['позвонить Антону', 'Дело · сегодня, 11:00 · через 15 мин']]);
  assert.deepEqual(push.sent.map(item => [item.endpoint, item.payload.kind, item.payload.title, item.payload.url]), [['https://push.example/one', 'reminder', 'позвонить Антону', `/#today?open=${todo.id}`]]);
  // Второй проход в ту же минуту — тишина: отправка записана.
  assert.deepEqual(await app.reminders.tick(), []);
  assert.equal(push.sent.length, 1);
  // Перенос дела двигает и напоминание — новое уйдёт в своё время; старое
  // не повторяется.
  await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { schedule: { date: '2026-09-15', time: '12:00' } } }).expect(200);
  clock = new Date('2026-09-15T07:46:00.000Z');
  assert.equal((await app.reminders.tick()).length, 1);
  assert.equal(push.sent.length, 2);
  // Сделанное дело не напоминает; чужое дело чужому — своим push-ем, а у него подписки нет.
  const done = (await api.post('/api/captures').send({ raw: 'сделанное', primaryType: 'todo', due: { date: '2026-09-15', time: '12:00' } }).expect(201)).body.entry;
  await api.post(`/api/projections/${done.projections.find(p => p.type === 'task').id}/complete`).send({}).expect(200);
  assert.deepEqual(await app.reminders.tick(), []);
  // Простой сервера: напоминание старше часа не догоняет.
  const late = (await api.post('/api/captures').send({ raw: 'опоздавшее', primaryType: 'todo', due: { date: '2026-09-15', time: '09:00' } }).expect(201)).body.entry;
  clock = new Date('2026-09-15T09:00:00.000Z');
  assert.deepEqual(await app.reminders.tick(), []);
  assert.equal(app.database.prepare('SELECT status FROM reminder_sends WHERE capture_id=?').get(late.id).status, 'missed');
  // Очистка данных стирает и журнал отправок: он ссылается на записи и без
  // этого ломал бы сброс внешним ключом.
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  // Сброс — только свой: чужая отправка остаётся.
  assert.deepEqual(app.database.prepare('SELECT user_id FROM reminder_sends').all().map(row => row.user_id), [other.user.id]);
});

test('напоминание в срок: явное «за час» и «off» в карточке, перенос из календаря его не теряет, настройки личные', async () => {
  const app = freshApp({ timeZone: TZ });
  const api = authed(app);
  const day = shiftDate(dateInZone(new Date(), TZ), 3);
  const todo = (await api.post('/api/captures').send({ raw: 'встретить курьера', primaryType: 'todo', due: { date: day, time: '14:00', remind: 60 } }).expect(201)).body.entry;
  assert.equal(todo.interpretation.classification.entities.schedule.remind, 60);
  await api.post('/api/captures').send({ raw: 'x', primaryType: 'todo', due: { date: day, time: '14:00', remind: 'soon' } }).expect(400);
  // Перенос из сетки (только дата и время) — напоминание остаётся.
  const moved = (await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { schedule: { date: day, time: '15:00' } } }).expect(200)).body.entry;
  assert.equal(moved.interpretation.classification.entities.schedule.remind, 60);
  const viaCalendar = app.calendar.applySchedule(todo.id, { date: day, time: '16:00', end: '16:30' }, 'тест');
  assert.ok(viaCalendar);
  assert.equal(JSON.parse(app.database.prepare(`SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'`).get(todo.id).classification_json).entities.schedule.remind, 60);
  // «off» выключает, null возвращает к настройке по умолчанию.
  const off = (await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { schedule: { date: day, time: '16:00', remind: 'off' } } }).expect(200)).body.entry;
  assert.equal(off.interpretation.classification.entities.schedule.remind, 'off');
  assert.deepEqual((await api.get('/api/reminders/upcoming').expect(200)).body.reminders.map(item => item.captureId), []);
  const reset = (await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { schedule: { date: day, time: '16:00', remind: null } } }).expect(200)).body.entry;
  assert.equal(reset.interpretation.classification.entities.schedule.remind, undefined);
  await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { schedule: { date: day, time: '16:00', remind: 99999 } } }).expect(400);
  // Настройки: по умолчанию за 15 минут и в 09:00, значения проверяются, и они личные.
  let settings = (await api.get('/api/settings').expect(200)).body.settings;
  assert.deepEqual([settings.remindDefault, settings.remindHour], ['15', '09:00']);
  await api.put('/api/settings').send({ remindDefault: '30', remindHour: '08:00' }).expect(200);
  await api.put('/api/settings').send({ remindDefault: 'tomorrow' }).expect(400);
  await api.put('/api/settings').send({ remindHour: '25:00' }).expect(400);
  settings = (await api.get('/api/settings').expect(200)).body.settings;
  assert.deepEqual([settings.remindDefault, settings.remindHour], ['30', '08:00']);
  const [item] = (await api.get('/api/reminders/upcoming').expect(200)).body.reminders;
  assert.equal(item.lead, 'через 30 мин');
  const other = authed(app, { email: 'other@kizuna.test', role: 'user' });
  assert.equal((await other.get('/api/settings').expect(200)).body.settings.remindDefault, '15');
});

test('push: ключ VAPID один на приложение, подписка — на устройство, пробное уведомление, исчезнувшая подписка удаляется', async () => {
  const push = fakePush();
  const app = freshApp({ pushTransport: push });
  const api = authed(app);
  const key = (await api.get('/api/push/key').expect(200)).body;
  assert.deepEqual([key.publicKey, key.subscriptions], ['BPUBLIC', []]);
  assert.equal((await api.get('/api/push/key').expect(200)).body.publicKey, 'BPUBLIC', 'ключ не перегенерируется');
  await api.post('/api/push/test').send({}).expect(409);
  await api.post('/api/push/subscriptions').send({ subscription: { endpoint: 'http://insecure', keys: {} } }).expect(400);
  await api.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/phone') }).expect(201);
  await api.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/phone') }).expect(200);
  await api.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/gone') }).expect(201);
  assert.equal((await api.get('/api/push/key').expect(200)).body.subscriptions.length, 2);
  const summary = (await api.post('/api/push/test').send({}).expect(200)).body;
  assert.deepEqual(summary, { sent: 1, failed: 0, dropped: 1 });
  assert.deepEqual(push.sent.map(item => [item.endpoint, item.payload.kind]), [['https://push.example/phone', 'test']]);
  assert.deepEqual((await api.get('/api/push/key').expect(200)).body.subscriptions.map(item => item.host), ['push.example']);
  // Чужой не видит и не снимает мою подписку.
  const other = authed(app, { email: 'other@kizuna.test', role: 'user' });
  assert.deepEqual((await other.get('/api/push/key').expect(200)).body.subscriptions, []);
  assert.equal((await other.delete('/api/push/subscriptions').send({ endpoint: 'https://push.example/phone' }).expect(200)).body.removed, false);
  assert.equal((await api.delete('/api/push/subscriptions').send({ endpoint: 'https://push.example/phone' }).expect(200)).body.removed, true);
  // Одна запись по ссылке из уведомления — только своя.
  const todo = (await api.post('/api/captures').send({ raw: 'дело' }).expect(201)).body.entry;
  assert.equal((await api.get(`/api/captures/${todo.id}`).expect(200)).body.entry.id, todo.id);
  await other.get(`/api/captures/${todo.id}`).expect(404);
  // Сервис-воркер и манифест отдаются с корня и без входа.
  const sw = await api.get('/sw.js').expect(200);
  assert.match(sw.headers['content-type'], /javascript/);
  assert.match((await api.get('/manifest.webmanifest').expect(200)).text, /Кизуна/);
});

// Повтор напоминает по экземплярам: у каждого свой момент и своя запись в
// журнале отправок; убранный экземпляр молчит.
test('повтор напоминает по экземплярам, убранный экземпляр молчит', async () => {
  let clock = new Date('2026-09-15T06:00:00.000Z');
  const app = freshApp({ now: () => clock, timeZone: TZ });
  const api = authed(app);
  const daily = (await api.post('/api/captures').send({ raw: 'проверить почту', primaryType: 'todo', due: { date: '2026-09-14', time: '11:00', remind: 15, repeat: { freq: 'daily' } } }).expect(201)).body.entry;
  const upcoming = (await api.get('/api/reminders/upcoming').expect(200)).body.reminders.filter(item => item.captureId === daily.id);
  assert.deepEqual(upcoming.map(item => [item.date, item.remindAt]), [['2026-09-15', '2026-09-15T06:45:00.000Z'], ['2026-09-16', '2026-09-16T06:45:00.000Z']]);
  clock = new Date('2026-09-15T06:45:30.000Z');
  assert.deepEqual((await app.reminders.tick()).map(item => [item.captureId, item.body]), [[daily.id, 'Дело · сегодня, 11:00 · через 15 мин']]);
  assert.deepEqual(await app.reminders.tick(), []);
  // Завтрашний экземпляр убран — тишина; послезавтрашний напомнит.
  await api.post(`/api/captures/${daily.id}/corrections`).send({ patch: { schedule: { date: '2026-09-14', time: '11:00', skip: ['2026-09-16'] } } }).expect(200);
  clock = new Date('2026-09-16T06:45:30.000Z');
  assert.deepEqual(await app.reminders.tick(), []);
  clock = new Date('2026-09-17T06:45:30.000Z');
  assert.equal((await app.reminders.tick()).length, 1);
});

test('срок «сегодня», поставленный самим приложением, не напоминает; названный человеком — напоминает', async () => {
  let clock = new Date('2026-09-15T05:30:00.000Z');
  const push = fakePush();
  const app = freshApp({ now: () => clock, pushTransport: push, timeZone: TZ });
  const api = authed(app);
  await api.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/one') }).expect(201);
  const plain = (await api.post('/api/captures').send({ raw: 'Разобрать письма по смете' }).expect(201)).body.entry;
  const named = (await api.post('/api/captures').send({ raw: 'Отправить смету в пятницу в 15:00' }).expect(201)).body.entry;
  assert.equal(plain.interpretation.classification.entities.schedule.defaulted, true);
  assert.deepEqual((await api.get('/api/reminders/upcoming').expect(200)).body.reminders.map(item => item.captureId), [named.id]);
  clock = new Date('2026-09-15T08:00:00.000Z');
  assert.deepEqual(await app.reminders.tick(), []);
  // Человек назвал день в карточке — флаг пропадает, срок настоящий.
  await api.post(`/api/captures/${plain.id}/corrections`).send({ patch: { schedule: { date: '2026-09-16', time: '12:00' } } }).expect(200);
  const fixed = (await api.get(`/api/captures/${plain.id}`).expect(200)).body.entry.interpretation.classification.entities.schedule;
  assert.equal(fixed.defaulted, undefined);
  assert.equal((await api.get('/api/reminders/upcoming').expect(200)).body.reminders.length, 2);
});
