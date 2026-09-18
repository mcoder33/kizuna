import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { recordUsage } from '../server/db.js';
import { notify, isQuiet } from '../server/notifications.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { fakeYandex } from './caldav.test.js';

// Полдень по Самаре: тихие часы не мешают доставке, пока тест сам их не включит.
const NOON = new Date('2026-09-16T08:00:00.000Z');
function freshApp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-notify-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), calendarKey: Buffer.alloc(32, 7), timeZone: 'Europe/Samara', ...options });
}
function fakePush() {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'private' }),
    async sendNotification(subscription, body) { sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; },
  };
}
const subscription = endpoint => ({ endpoint, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
const feed = async api => (await api.get('/api/notifications').expect(200)).body;
async function eventually(assertion, timeout = 2000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { return await assertion(); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 15)); } }
  throw last;
}
// Двое в одном круге: Саша зовёт Аню, у каждой стороны своя кука.
async function pair(app) {
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  await sasha.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  return { sasha, anya, circle };
}

test('просьба ждёт ответа: число на колокольчике, push тому, кого нет у экрана, ответ гасит строку и приходит автору', async () => {
  const push = fakePush();
  const app = freshApp({ pushTransport: push, now: () => NOON });
  const { sasha, anya } = await pair(app);
  await anya.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/anya') }).expect(201);
  const entry = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  await app.notificationsDelivered();

  let box = await feed(anya);
  assert.deepEqual(box.counts, { waits: 1, unread: 1 });
  const [ask] = box.notifications;
  assert.equal(ask.kind, 'request');
  assert.equal(ask.waits, true);
  assert.equal(ask.actors[0].name, 'Саша');
  assert.match(ask.text, /^просит: «/);
  assert.equal(ask.data.circle.name, 'Хаб');
  assert.deepEqual(push.sent.map(item => [item.endpoint, item.payload.kind, item.payload.url]), [['https://push.example/anya', 'request', `/#today?open=${entry.id}`]]);
  assert.ok(box.kinds.every(kind => kind.key !== 'signup'), 'заявки на вход — только администратору');

  // Ответ в полосе «к вам» гасит и строку за колокольчиком.
  const row = (await anya.get('/api/inbox').expect(200)).body.rows.find(item => item.kind === 'request');
  await anya.post(`/api/assignments/${row.id}/respond`).send({ take: true }).expect(200);
  box = await feed(anya);
  assert.equal(box.counts.waits, 0);
  assert.equal(box.notifications[0].resolved, true);
  const answer = (await feed(sasha)).notifications.find(item => item.kind === 'answer');
  assert.match(answer.text, /^берёт «/);
  assert.equal(answer.actors[0].name, 'Аня');

  // Взятое сделано — автор узнаёт и об этом.
  const task = entry.projections.find(projection => projection.type === 'task');
  await anya.post(`/api/projections/${task.id}/complete`).send({}).expect(200);
  assert.ok((await feed(sasha)).notifications.some(item => item.kind === 'answer' && /^отмечает сделанным «/.test(item.text)));
});

test('снятая просьба перестаёт ждать, даже если её сняли мимо ленты', async () => {
  const app = freshApp({ now: () => NOON });
  const { sasha, anya } = await pair(app);
  const entry = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  assert.equal((await feed(anya)).counts.waits, 1);
  await sasha.post(`/api/captures/${entry.id}/assign`).send({ assigneeId: null }).expect(200);
  assert.equal((await feed(anya)).counts.waits, 0);
});

test('призыв в разговоре — строка и телефон; обычные сообщения молчат, а включённые склеиваются в одну строку', async () => {
  const push = fakePush();
  const app = freshApp({ pushTransport: push, now: () => NOON });
  const { sasha, anya } = await pair(app);
  await anya.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/anya') }).expect(201);
  const general = (await sasha.get('/api/rooms').expect(200)).body.rooms.find(room => room.kind === 'general');
  await sasha.post(`/api/rooms/${general.id}/messages`).send({ body: 'Всем привет' }).expect(201);
  assert.equal((await feed(anya)).notifications.length, 0, 'обычное сообщение по умолчанию никуда не ложится');

  await sasha.post(`/api/rooms/${general.id}/messages`).send({ body: '@Аня, посмотри смету' }).expect(201);
  await app.notificationsDelivered();
  let box = await feed(anya);
  assert.deepEqual(box.notifications.map(item => item.kind), ['call']);
  assert.deepEqual(box.counts, { waits: 0, unread: 1 }, 'призыв не ждёт ответа в строке — число на колокольчике его не считает');
  assert.match(box.notifications[0].text, /^зовёт вас в разговоре «Хаб»: «@Аня, посмотри смету»$/);
  assert.equal(push.sent.at(-1).payload.url, `/#circles?room=${general.id}`);

  // Включили «пишут без призыва» — три сообщения стали одной строкой, и телефон молчит.
  await anya.put('/api/settings').send({ notifyPrefs: JSON.stringify({ chatter: 'bell' }) }).expect(200);
  const pushed = push.sent.length;
  for (const body of ['раз', 'два', 'три']) await sasha.post(`/api/rooms/${general.id}/messages`).send({ body }).expect(201);
  await app.notificationsDelivered();
  box = await feed(anya);
  const chatter = box.notifications.filter(item => item.kind === 'chatter');
  assert.equal(chatter.length, 1);
  assert.equal(chatter[0].count, 3);
  assert.match(chatter[0].text, /«три»$/);
  assert.equal(push.sent.length, pushed);

  // Открыла разговор — прочитала всё, что из него пришло.
  await anya.post('/api/notifications/read').send({ roomId: general.id }).expect(200);
  assert.equal((await feed(anya)).counts.unread, 0);
  await anya.put('/api/settings').send({ notifyPrefs: '{"chatter":"loud"}' }).expect(400);
});

test('призыв в обсуждении записи — строка тому, кого позвали; открытая карточка её гасит', async () => {
  const app = freshApp({ now: () => NOON });
  const { sasha, anya } = await pair(app);
  const entry = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  await anya.post(`/api/captures/${entry.id}/comments`).send({ body: 'Половина готова. @Саша, цены от подрядчика были?' }).expect(201);
  const call = (await feed(sasha)).notifications.find(item => item.kind === 'call');
  assert.equal(call.captureId, entry.id);
  assert.match(call.text, /^зовёт вас в обсуждении «.+»: «Половина готова\. @Саша, цены от подрядчика были\?»$/);
  assert.equal(call.data.circle.name, 'Хаб');
  // Без призыва — тишина, пока человек сам не включил такой повод.
  await anya.post(`/api/captures/${entry.id}/comments`).send({ body: 'Напишу подрядчику ещё раз' }).expect(201);
  assert.equal((await feed(sasha)).notifications.filter(item => item.kind === 'chatter').length, 0);
  await sasha.post('/api/notifications/read').send({ captureId: entry.id }).expect(200);
  assert.equal((await feed(sasha)).notifications.find(item => item.kind === 'call').read, true);
});

test('телефон молчит ночью и там, где человек его выключил; лента копится как обычно', async () => {
  const push = fakePush();
  let clock = new Date('2026-09-16T19:30:00.000Z'); // 23:30 по Самаре
  const app = freshApp({ pushTransport: push, now: () => clock });
  const { sasha, anya } = await pair(app);
  await anya.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/anya') }).expect(201);
  await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201);
  await app.notificationsDelivered();
  assert.equal(push.sent.length, 0, 'тихие часы');
  assert.equal((await feed(anya)).counts.waits, 1);

  await anya.put('/api/settings').send({ quietHours: 'off' }).expect(200);
  await sasha.post('/api/captures').send({ raw: 'Ане — проверить договор по Хабу' }).expect(201);
  await app.notificationsDelivered();
  assert.equal(push.sent.length, 1);

  await anya.put('/api/settings').send({ notifyPrefs: JSON.stringify({ request: 'bell' }) }).expect(200);
  await sasha.post('/api/captures').send({ raw: 'Ане — позвонить подрядчику по Хабу' }).expect(201);
  await app.notificationsDelivered();
  assert.equal(push.sent.length, 1, 'только за колокольчик');
  await anya.put('/api/settings').send({ notifyPrefs: JSON.stringify({ request: 'off' }) }).expect(200);
  await sasha.post('/api/captures').send({ raw: 'Ане — отправить акт по Хабу' }).expect(201);
  assert.equal((await feed(anya)).notifications.length, 3, 'выключенный повод не ложится даже в ленту');

  assert.equal(isQuiet('22:00-08:00', new Date('2026-09-16T03:59:00.000Z'), 'Europe/Samara'), true);
  assert.equal(isQuiet('22:00-08:00', new Date('2026-09-16T04:00:00.000Z'), 'Europe/Samara'), false);
  assert.equal(isQuiet('13:00-15:00', new Date('2026-09-16T09:30:00.000Z'), 'Europe/Samara'), true);
  clock = NOON;
});

test('напоминание — строка за колокольчиком с прежним push; отложенное возвращается с честным «через сколько»', async () => {
  const push = fakePush();
  let clock = new Date('2026-09-16T06:45:30.000Z'); // 10:45:30 по Самаре
  const app = freshApp({ pushTransport: push, now: () => clock });
  const api = authed(app);
  // Утро того же обхода сложило бы и сводку — здесь она не нужна.
  await api.put('/api/settings').send({ notifyPrefs: JSON.stringify({ digest: 'off' }) }).expect(200);
  await api.post('/api/push/subscriptions').send({ subscription: subscription('https://push.example/me') }).expect(201);
  const meeting = (await api.post('/api/captures').send({ raw: 'созвон по ВойсОпс https://telemost.yandex.ru/j/42', primaryType: 'todo', due: { date: '2026-09-16', time: '11:00' } }).expect(201)).body.entry;
  await api.post(`/api/captures/${meeting.id}/corrections`).send({ patch: { primaryType: 'meeting_event', completed: false } }).expect(200);
  await app.reminders.tick();
  assert.deepEqual(push.sent.map(item => [item.payload.kind, item.payload.title, item.payload.url]), [['reminder', meeting.interpretation.classification.summary, `/#today?open=${meeting.id}`]]);
  let [note] = (await feed(api)).notifications;
  assert.equal(note.kind, 'reminder');
  assert.equal(note.lead, 'Через 15 мин');
  assert.equal(note.data.joinUrl, 'https://telemost.yandex.ru/j/42');

  await api.post(`/api/notifications/${note.id}/snooze`).send({ minutes: 10 }).expect(200);
  assert.equal((await feed(api)).notifications.length, 0, 'отложенное не мешает в ленте');
  clock = new Date('2026-09-16T06:55:30.000Z');
  await app.notificationTick();
  [note] = (await feed(api)).notifications;
  assert.equal(note.read, false);
  assert.equal(note.lead, 'Через 5 мин');
  assert.equal(push.sent.length, 2);
  await api.post(`/api/notifications/${note.id}/snooze`).send({ minutes: 0 }).expect(400);
  await api.post('/api/notifications/нет-такого/snooze').send({ minutes: 5 }).expect(404);
});

test('утренняя сводка: одна на день, в час напоминаний и только когда есть что сказать', async () => {
  let clock = new Date('2026-09-16T05:00:30.000Z'); // 09:00 по Самаре
  const app = freshApp({ now: () => clock });
  const { sasha, anya } = await pair(app);
  await app.notificationTick();
  assert.equal((await feed(anya)).notifications.length, 0, 'пустой день — без сводки');

  await anya.post('/api/captures').send({ raw: 'сдать отчёт', primaryType: 'todo', due: { date: '2026-09-16' } }).expect(201);
  await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201);
  // Пустое утро проверяется не на каждом обходе, а раз в десять минут.
  clock = new Date('2026-09-16T05:02:00.000Z');
  await app.notificationTick();
  assert.equal((await feed(anya)).notifications.filter(item => item.kind === 'digest').length, 0);
  clock = new Date('2026-09-16T05:11:00.000Z');
  await app.notificationTick();
  await app.notificationTick();
  const digests = (await feed(anya)).notifications.filter(item => item.kind === 'digest');
  assert.equal(digests.length, 1);
  assert.equal(digests[0].lead, 'Доброе утро:');
  assert.match(digests[0].text, /1 дело на сегодня/);
  assert.ok(digests[0].meta.some(line => /Саша ждёт ответа: «/.test(line)));

  // Вечером сводка уже не утренняя — следующий день её не догоняет. А вчерашняя
  // уходит из ленты сама: «3 дела на сегодня» про вчера только мешает.
  clock = new Date('2026-09-17T15:00:00.000Z');
  await app.notificationTick();
  assert.equal((await feed(anya)).notifications.filter(item => item.kind === 'digest').length, 0, 'вчерашняя сводка ушла');
  assert.equal(app.database.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind='digest' AND user_id=?").get(anya.user.id).n, 1, 'новой не завелось');
});

test('потолок расходов: по одному уведомлению на 80% и на 100% в месяц', async () => {
  const app = freshApp({ now: () => NOON });
  const api = authed(app);
  await api.put('/api/settings').send({ monthlyLimitUsd: '1' }).expect(200);
  recordUsage(app.database, { provider: 'openrouter', model: 'fake/fast', kind: 'classify', inputTokens: 10, outputTokens: 10, costUsd: 0.85, userId: api.user.id, at: NOON.toISOString() });
  await app.notificationTick();
  await app.notificationTick();
  let spend = (await feed(api)).notifications.filter(item => item.kind === 'spend');
  assert.deepEqual(spend.map(item => item.lead), ['Потрачено 80%']);
  recordUsage(app.database, { provider: 'openrouter', model: 'fake/fast', kind: 'classify', inputTokens: 10, outputTokens: 10, costUsd: 0.3, userId: api.user.id, at: NOON.toISOString() });
  await app.notificationTick();
  spend = (await feed(api)).notifications.filter(item => item.kind === 'spend');
  assert.deepEqual(spend.map(item => item.lead), ['Потрачено 100%', 'Потрачено 80%']);
});

test('заявка на вход приходит администратору, а неясная запись из фона ждёт уточнения и гаснет после него', async () => {
  // Часы настоящие: аренда задания разбора живёт по ним.
  const app = freshApp();
  const admin = authed(app);
  await authed(app).post('/api/auth/register').send({ email: 'newbie@kizuna.test', password: 'long-password-123' }).expect(201);
  const signup = (await feed(admin)).notifications.find(item => item.kind === 'signup');
  assert.equal(signup.text, 'newbie@kizuna.test');

  app.captureJobWorker.start();
  try {
    const queued = (await admin.post('/api/captures').set('Prefer', 'respond-async').send({ raw: 'Завтра и послезавтра созвон по Hub' }).expect(202)).body;
    const clarify = await eventually(async () => {
      const found = (await feed(admin)).notifications.find(item => item.kind === 'clarify');
      assert.ok(found);
      return found;
    });
    assert.equal(clarify.captureId, queued.captureId);
    await admin.post(`/api/captures/${queued.captureId}/corrections`).send({ patch: { schedule: { date: '2026-09-17', time: '11:00' }, project: 'Hub' } }).expect(200);
    assert.equal((await feed(admin)).notifications.find(item => item.kind === 'clarify').resolved, true);
  } finally { await app.captureJobWorker.stop(); }
});

test('лента: прочитать по записи и всё сразу, очистка данных уносит её, чужую строку не прочитать', async () => {
  const app = freshApp({ now: () => NOON });
  const { sasha, anya } = await pair(app);
  const entry = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  notify(app.database, { userId: anya.user.id, kind: 'clarify', captureId: entry.id, lead: 'Запись ждёт уточнения:', text: '«тест»' });
  let box = await feed(anya);
  assert.equal(box.counts.unread, 2);
  await sasha.post('/api/notifications/read').send({ all: true }).expect(200);
  assert.equal((await feed(anya)).counts.unread, 2, 'чужое «прочитать всё» не трогает мою ленту');
  await anya.post('/api/notifications/read').send({ captureId: entry.id }).expect(200);
  box = await feed(anya);
  assert.deepEqual(box.counts, { waits: 1, unread: 1 }, 'просьба остаётся непрочитанной и ждущей, пока на неё не ответили');
  await anya.post('/api/notifications/read').send({}).expect(400);
  await anya.post('/api/notifications/read').send({ all: true }).expect(200);
  assert.equal((await feed(anya)).counts.unread, 0);
  await anya.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  assert.equal((await feed(anya)).notifications.length, 0);
});

// Календарь, события которого меняются между синхронизациями.
const HOUR = 3600 * 1000;
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function ics(event) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${event.uid}`, `DTSTART:${stamp(event.start)}`, `DTEND:${stamp(event.end)}`, `SUMMARY:${event.title}`,
    ...(event.invite ? ['ORGANIZER;CN=Даниил:mailto:daniil@example.com', 'ATTENDEE;CN=Даниил;PARTSTAT=ACCEPTED:mailto:daniil@example.com', `ATTENDEE;CN=Я;PARTSTAT=${event.partstat || 'NEEDS-ACTION'};RSVP=TRUE:mailto:user@yandex.ru`] : []),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
function changingYandex(state) {
  const base = fakeYandex();
  return async (url, options) => {
    if (options.method === 'REPORT' && url === 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/') {
      const items = state.events.map(event => `<D:response><D:href>/calendars/user@yandex.ru/events-123/${event.uid}.ics</D:href><D:propstat><D:prop><D:getetag>"${event.uid}-1"</D:getetag><C:calendar-data>${ics(event).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
      return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${items}</D:multistatus>`, { status: 207 });
    }
    const own = options.method === 'GET' && url.match(/\/events-123\/([^/]+)\.ics$/);
    const event = own && state.events.find(item => item.uid === own[1]);
    if (event) return new Response(ics(event), { status: 200, headers: { ETag: `"${event.uid}-1"` } });
    return base(url, options);
  };
}

test('календарь: новая встреча, перенос и отмена на ближайшие двое суток, приглашение ждёт ответа в строке', async () => {
  const at = Date.now();
  const state = { events: [{ uid: 'standup', title: 'Стендап', start: new Date(at + 3 * HOUR), end: new Date(at + 4 * HOUR) }] };
  const app = freshApp({ calendarFetch: changingYandex(state) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send({ preset: 'yandex', username: 'user@yandex.ru', password: 'app-pass' }).expect(201)).body.account;
  assert.equal((await feed(api)).notifications.length, 0, 'первая синхронизация молчит');

  state.events.push({ uid: 'plan', title: 'Планёрка Хаба', start: new Date(at + 5 * HOUR), end: new Date(at + 5.5 * HOUR) });
  state.events.push({ uid: 'far', title: 'Далёкая встреча', start: new Date(at + 10 * 24 * HOUR), end: new Date(at + 10 * 24 * HOUR + HOUR) });
  state.events.push({ uid: 'demo', title: 'Демо монетизации', start: new Date(at + 30 * HOUR), end: new Date(at + 31 * HOUR), invite: true });
  await api.post(`/api/calendar/accounts/${account.id}/sync`).send({}).expect(200);
  let box = await feed(api);
  assert.deepEqual(box.notifications.map(item => item.kind).sort(), ['event_added', 'invite']);
  const invite = box.notifications.find(item => item.kind === 'invite');
  assert.equal(invite.lead, 'Даниил');
  assert.equal(invite.text, 'зовёт на встречу «Демо монетизации»');
  assert.equal(invite.waits, true);
  assert.equal(box.counts.waits, 1);

  state.events.find(event => event.uid === 'standup').start = new Date(at + 6 * HOUR);
  state.events.find(event => event.uid === 'standup').end = new Date(at + 7 * HOUR);
  state.events = state.events.filter(event => event.uid !== 'plan');
  await api.post(`/api/calendar/accounts/${account.id}/sync`).send({}).expect(200);
  box = await feed(api);
  assert.deepEqual(box.notifications.filter(item => item.kind === 'event_changed').map(item => item.lead).sort(), ['Встречу отменили:', 'Встречу перенесли:']);
  assert.equal(box.notifications.filter(item => item.kind === 'invite').length, 1, 'приглашение не повторяется на каждой синхронизации');

  // Ответ из строки уходит в календарь, строка перестаёт ждать.
  await api.post(`/api/notifications/${invite.id}/respond`).send({ status: 'maybe' }).expect(400);
  await api.post(`/api/notifications/${invite.id}/respond`).send({ status: 'accepted' }).expect(200);
  assert.equal((await feed(api)).counts.waits, 0);
});

test('календарь перестал обновляться — одна строка до починки', async () => {
  const state = { events: [], broken: false };
  const healthy = changingYandex(state);
  const app = freshApp({ calendarFetch: (url, options) => (state.broken ? Promise.resolve(new Response('', { status: 401 })) : healthy(url, options)) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send({ preset: 'yandex', username: 'user@yandex.ru', password: 'app-pass' }).expect(201)).body.account;
  state.broken = true;
  await api.post(`/api/calendar/accounts/${account.id}/sync`).send({});
  await api.post(`/api/calendar/accounts/${account.id}/sync`).send({});
  let errors = (await feed(api)).notifications.filter(item => item.kind === 'calendar_error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].lead, /не обновляется:$/);
  state.broken = false;
  await api.post(`/api/calendar/accounts/${account.id}/sync`).send({}).expect(200);
  errors = (await feed(api)).notifications.filter(item => item.kind === 'calendar_error');
  assert.equal(errors[0].resolved, true);
});

test('открытое убирается из ленты: «Очистить» не трогает ждущее ответа, «Вернуть» кладёт строки обратно', async () => {
  const app = freshApp({ now: () => NOON });
  const { sasha, anya } = await pair(app);
  await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201);
  const rooms = (await sasha.get('/api/rooms').expect(200)).body.rooms;
  await sasha.post(`/api/rooms/${rooms.find(room => room.kind === 'general').id}/messages`).send({ body: '@Аня глянь смету' }).expect(201);
  let box = await feed(anya);
  const call = box.notifications.find(item => item.kind === 'call');
  const ask = box.notifications.find(item => item.kind === 'request');
  assert.deepEqual(box.counts, { waits: 1, unread: 2 });

  // Ждущее ответа не уходит даже по прямой просьбе.
  assert.deepEqual((await anya.post('/api/notifications/dismiss').send({ ids: [ask.id] }).expect(200)).body.dismissed, []);
  const dismissed = (await anya.post('/api/notifications/dismiss').send({ ids: [call.id] }).expect(200)).body;
  assert.deepEqual(dismissed.dismissed, [call.id]);
  assert.deepEqual(dismissed.counts, { waits: 1, unread: 1 }, 'убранное не считается непрочитанным');
  box = await feed(anya);
  assert.deepEqual(box.notifications.map(item => item.kind), ['request']);

  await anya.post('/api/notifications/restore').send({ ids: [call.id] }).expect(200);
  assert.ok((await feed(anya)).notifications.some(item => item.id === call.id && item.read), 'вернулось прочитанным');
  const cleared = (await anya.post('/api/notifications/dismiss').send({ all: true }).expect(200)).body;
  assert.deepEqual(cleared.dismissed, [call.id]);
  assert.deepEqual((await feed(anya)).notifications.map(item => item.kind), ['request']);
  // Чужое не убирается и не возвращается.
  assert.deepEqual((await sasha.post('/api/notifications/restore').send({ ids: [call.id] }).expect(200)).body.restored, 0);
  await anya.post('/api/notifications/dismiss').send({}).expect(400);
});

test('закрытое дело забирает свои напоминания, а поправка не открывает его заново', async () => {
  let clock = new Date('2026-09-16T06:45:30.000Z');
  const app = freshApp({ now: () => clock });
  const api = authed(app);
  await api.put('/api/settings').send({ notifyPrefs: JSON.stringify({ digest: 'off' }) }).expect(200);
  const entry = (await api.post('/api/captures').send({ raw: 'Проверить доступ голосового агента', primaryType: 'todo', due: { date: '2026-09-16', time: '11:00' } }).expect(201)).body.entry;
  await app.reminders.tick();
  assert.equal((await feed(api)).notifications.filter(item => item.kind === 'reminder').length, 1);
  const task = entry.projections.find(projection => projection.type === 'task');
  const closed = (await api.post(`/api/projections/${task.id}/complete`).send({}).expect(200)).body;
  assert.equal((await feed(api)).notifications.length, 0, 'напоминание ушло вместе с делом');

  // Перенос срока пересобирает проекции — дело всё равно остаётся закрытым,
  // и время закрытия то же.
  clock = new Date('2026-09-16T07:30:00.000Z');
  const moved = (await api.post(`/api/captures/${entry.id}/corrections`).send({ patch: { schedule: { date: '2026-09-17', time: '12:00' }, summary: 'Проверить доступ голосового агента ко всем функциям' } }).expect(200)).body.entry;
  const again = moved.projections.find(projection => projection.type === 'task');
  assert.notEqual(again.id, task.id);
  assert.equal(again.completion.completed, true);
  assert.equal(again.completion.completedAt, closed.completion.completedAt);
  // Сделанное результатом — другое: тип сменился, закрывать больше нечего.
  const outcome = (await api.post(`/api/captures/${entry.id}/corrections`).send({ patch: { primaryType: 'outcome_decision' } }).expect(200)).body.entry;
  assert.deepEqual(outcome.projections.map(projection => projection.type), ['outcome_decision']);
});

test('итог к делу — запись-результат, привязанная к делу; чужому делу итог не пишется', async () => {
  const app = freshApp({ now: () => NOON });
  const { sasha, anya } = await pair(app);
  const entry = (await sasha.post('/api/captures').send({ raw: 'Проверить доступ голосового агента', primaryType: 'todo' }).expect(201)).body.entry;
  const created = (await sasha.post(`/api/captures/${entry.id}/outcome`).send({ text: 'Доступ есть у всех, кроме календаря' }).expect(201)).body;
  await sasha.post(`/api/captures/${entry.id}/outcome`).send({ text: '   ' }).expect(400);
  await anya.post(`/api/captures/${entry.id}/outcome`).send({ text: 'моё' }).expect(404);
  const child = app.database.prepare('SELECT parent_capture_id, raw FROM captures WHERE id=?').get(created.captureId);
  assert.deepEqual(child, { parent_capture_id: entry.id, raw: 'Доступ есть у всех, кроме календаря' });
  const job = app.database.prepare('SELECT overrides_json FROM capture_jobs WHERE capture_id=?').get(created.captureId);
  assert.deepEqual(JSON.parse(job.overrides_json), { primaryType: 'outcome_decision' });
});

test('об изменениях в выбранном календаре лента молчит, а приглашения из него приходят', async () => {
  const app = freshApp({ now: () => NOON });
  const api = authed(app);
  await api.put('/api/settings').send({ notifyMutedCalendars: JSON.stringify(['acc-1']) }).expect(200);
  await api.put('/api/settings').send({ notifyMutedCalendars: 'не список' }).expect(400);
  const userId = api.user.id;
  assert.equal(notify(app.database, { userId, kind: 'event_added', accountId: 'acc-1', eventUid: 'a', lead: 'Появилась встреча', text: 'в «Работа»: «Стендап»' }), null);
  assert.ok(notify(app.database, { userId, kind: 'event_added', accountId: 'acc-2', eventUid: 'b', lead: 'Появилась встреча', text: 'в «Дом»: «Ужин»' }));
  assert.ok(notify(app.database, { userId, kind: 'invite', accountId: 'acc-1', eventUid: 'c', lead: 'Даниил', text: 'зовёт на встречу «Демо»' }));
  assert.deepEqual((await feed(api)).notifications.map(item => item.kind).sort(), ['event_added', 'invite']);
});
