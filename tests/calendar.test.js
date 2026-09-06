import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { dateInZone, shiftDate } from '../server/reports.js';
import { fakeYandex } from './caldav.test.js';

function freshApp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-calendar-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), calendarKey: Buffer.alloc(32, 7), ...options });
}
const today = () => dateInZone(new Date(), 'Europe/Samara');
const yandexBody = { preset: 'yandex', username: 'user@yandex.ru', password: 'app-pass' };

test('календарь: свои дела и встречи в окне, просроченные отдельно, конец времени и перенос уточнением', async () => {
  const api = authed(freshApp());
  const day = shiftDate(today(), 2), yesterday = shiftDate(today(), -1);
  const timed = (await api.post('/api/captures').send({ raw: 'спланировать отпуск', primaryType: 'todo', due: { date: day, time: '11:00' } }).expect(201)).body.entry;
  const undated = (await api.post('/api/captures').send({ raw: 'позвонить в салон', primaryType: 'todo', due: { date: day } }).expect(201)).body.entry;
  const overdue = (await api.post('/api/captures').send({ raw: 'написать Антону', primaryType: 'todo', due: { date: yesterday } }).expect(201)).body.entry;
  await api.post('/api/captures').send({ raw: 'Просто заметка без срока' }).expect(201);
  let view = (await api.get(`/api/calendar?from=${today()}&to=${shiftDate(today(), 6)}`).expect(200)).body;
  assert.equal(view.today, today());
  assert.deepEqual(view.items.map(item => [item.id, item.time, item.allDay, item.done]), [[timed.id, '11:00', false, false], [undated.id, null, true, false]]);
  assert.deepEqual(view.overdue.map(item => item.id), [overdue.id]);
  assert.equal(view.defaults.meetingMinutes, 60);
  // Перенос — уточнение записи: дата, время и конец в patch.schedule.
  const moved = (await api.post(`/api/captures/${timed.id}/corrections`).send({ patch: { schedule: { date: shiftDate(day, 1), time: '15:30', end: '16:00' } } }).expect(200)).body;
  assert.equal(moved.entry.interpretation.classification.entities.schedule.end, '16:00');
  assert.equal(moved.entry.interpretation.classification.entities.schedule.display, `${shiftDate(day, 1)}, 15:30–16:00`);
  await api.post(`/api/captures/${timed.id}/corrections`).send({ patch: { schedule: { date: day, time: '15:30', end: '15:00' } } }).expect(400);
  view = (await api.get(`/api/calendar?from=${today()}&to=${shiftDate(today(), 6)}`).expect(200)).body;
  const movedItem = view.items.find(item => item.id === timed.id);
  assert.deepEqual([movedItem.date, movedItem.time, movedItem.end], [shiftDate(day, 1), '15:30', '16:00']);
  // Закрытое дело остаётся в сетке с признаком done; окно шире двух месяцев — отказ.
  await api.post(`/api/projections/${undated.projections.find(p => p.type === 'task').id}/complete`).send({}).expect(200);
  view = (await api.get(`/api/calendar?from=${today()}&to=${shiftDate(today(), 6)}`).expect(200)).body;
  assert.equal(view.items.find(item => item.id === undated.id).done, true);
  await api.get(`/api/calendar?from=${today()}&to=${shiftDate(today(), 90)}`).expect(400);
  await api.get('/api/calendar?from=2026-13-01&to=2026-13-02').expect(400);
});

test('календарь Яндекса: подключение по паролю приложения, синхронизация, наложение, режим «занято», отключение и удаление', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  await api.post('/api/calendar/accounts').send({ ...yandexBody, password: 'wrong' }).expect(401);
  await api.post('/api/calendar/accounts').send({ preset: 'custom', serverUrl: 'http://plain', username: 'u', password: 'p' }).expect(400);
  const created = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body;
  assert.equal(created.account.provider, 'caldav');
  assert.equal(created.account.label, 'Яндекс · user@yandex.ru');
  assert.deepEqual(created.account.calendars.map(calendar => calendar.name), ['Личное']);
  assert.equal(created.events, 1);
  assert.ok(created.account.syncedAt);
  // Пароль в базе — только шифртекстом.
  const row = app.database.prepare('SELECT credentials_enc, username FROM calendar_accounts').get();
  assert.ok(!row.credentials_enc.includes('app-pass'));
  assert.equal(row.username, 'user@yandex.ru');
  // Событие Яндекса в окне: московские 11:00 — самарские 12:00.
  let view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  assert.equal(view.external.length, 1);
  assert.deepEqual([view.external[0].title, view.external[0].date, view.external[0].time, view.external[0].end, view.external[0].readOnly], ['Созвон <важный>', '2026-09-07', '12:00', '13:00', true]);
  assert.equal(view.accounts[0].calendars[0].name, 'Личное');
  // Режим «занято» прячет названия; отключённый календарь пропадает из сетки.
  await api.patch(`/api/calendar/accounts/${created.account.id}`).send({ mode: 'busy', label: 'Яндекс' }).expect(200);
  view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  assert.equal(view.external[0].title, 'Занято');
  await api.patch(`/api/calendar/accounts/${created.account.id}`).send({ disabled: true }).expect(200);
  view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  assert.equal(view.external.length, 0);
  await api.patch(`/api/calendar/accounts/${created.account.id}`).send({ disabled: false, calendars: [] }).expect(200);
  view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  assert.equal(view.external.length, 0, 'снятый календарь пропадает сразу');
  await api.patch(`/api/calendar/accounts/${created.account.id}`).send({ mode: 'weird' }).expect(400);
  // Чужой не видит и не правит.
  const stranger = authed(app, { email: 'other@kizuna.test', role: 'user' });
  assert.deepEqual((await stranger.get('/api/calendar/accounts').expect(200)).body.accounts, []);
  await stranger.delete(`/api/calendar/accounts/${created.account.id}`).expect(404);
  await api.delete(`/api/calendar/accounts/${created.account.id}`).expect(200);
  assert.equal(app.database.prepare('SELECT COUNT(*) n FROM calendar_events').get().n, 0);
});

test('наружу: встреча уходит в Яндекс одним PUT, ссылка видна в сетке, снятие удаляет событие', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body.account;
  const calendarId = account.calendars[0].id;
  const meeting = (await api.post('/api/captures').send({ raw: 'Завтра в 11 созвон с BE по секретам сессий в Hub' }).expect(201)).body.entry;
  assert.equal(meeting.interpretation.classification.primaryType, 'meeting_event');
  const note = (await api.post('/api/captures').send({ raw: 'Просто заметка' }).expect(201)).body.entry;
  await api.post('/api/calendar/export').send({ captureId: note.id, accountId: account.id, calendarId }).expect(409);
  const exported = (await api.post('/api/calendar/export').send({ captureId: meeting.id, accountId: account.id, calendarId }).expect(201)).body;
  assert.equal(exported.link.accountId, account.id);
  const put = calls.find(call => call.method === 'PUT');
  assert.ok(put.url.endsWith(`kizuna-${meeting.id}%40kizuna.ics`));
  assert.ok(put.body.includes('SUMMARY:'));
  assert.ok(put.body.includes('из Кизуны'));
  await api.post('/api/calendar/export').send({ captureId: meeting.id, accountId: account.id, calendarId }).expect(409);
  const date = meeting.interpretation.classification.entities.schedule.date;
  const view = (await api.get(`/api/calendar?from=${date}&to=${date}`).expect(200)).body;
  assert.deepEqual(view.items.find(item => item.id === meeting.id).exports.map(link => link.accountId), [account.id]);
  await api.post('/api/calendar/export/remove').send({ captureId: meeting.id, accountId: account.id }).expect(200);
  assert.ok(calls.some(call => call.method === 'DELETE'));
  await api.post('/api/calendar/export/remove').send({ captureId: meeting.id, accountId: account.id }).expect(404);
});

test('Google: без ключей подключение отказывает, а OAuth-обмен и синхронизация идут через API', async () => {
  const calls = [];
  const googleFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    if (url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: 'me@gmail.com', summary: 'me@gmail.com', primary: true, accessRole: 'owner', backgroundColor: '#4285f4' }, { id: 'holidays', summary: 'Праздники', accessRole: 'reader', selected: false }] });
    if (url.includes('/calendars/me%40gmail.com/events')) return Response.json({ items: [{ id: 'ev1', summary: '1:1', status: 'confirmed', start: { dateTime: '2026-09-07T12:00:00+04:00' }, end: { dateTime: '2026-09-07T13:00:00+04:00' }, hangoutLink: 'https://meet.google.com/abc-defg-hij' }, { id: 'ev2', summary: 'Отпуск', status: 'confirmed', transparency: 'transparent', start: { date: '2026-09-08' }, end: { date: '2026-09-10' } }] });
    return new Response('not found', { status: 404 });
  };
  const app = freshApp({ calendarFetch: googleFetch });
  const api = authed(app);
  await api.get('/api/calendar/google/start').expect(409);
  await api.put('/api/settings').send({ googleClientId: 'client-id', googleClientSecret: 'client-secret' }).expect(200);
  const start = await api.get('/api/calendar/google/start').set('X-Forwarded-Proto', 'https').set('Host', 'kizuna.example').expect(302);
  const url = new URL(start.headers.location);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://kizuna.example/api/calendar/google/callback');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  const state = url.searchParams.get('state');
  await api.get('/api/calendar/google/callback?state=bogus&code=x').expect(302).expect('Location', '/#settings?calendar=invalid_state');
  await api.get(`/api/calendar/google/callback?state=${state}&code=the-code`).expect(302).expect('Location', '/#settings?calendar=connected');
  const accounts = (await api.get('/api/calendar/accounts').expect(200)).body.accounts;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, 'google');
  assert.deepEqual(accounts[0].calendars.map(calendar => [calendar.name, calendar.selected]), [['me@gmail.com', true], ['Праздники', false]]);
  const token = calls.find(call => call.url.startsWith('https://oauth2.googleapis.com/token'));
  assert.ok(String(token.body).includes('code=the-code'));
  const view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-09').expect(200)).body;
  const meeting = view.external.find(item => item.title === '1:1');
  assert.deepEqual([meeting.date, meeting.time, meeting.end, meeting.joinUrl], ['2026-09-07', '12:00', '13:00', 'https://meet.google.com/abc-defg-hij']);
  // Отпуск на два дня — по плашке на каждый день, «свободно», а не «занято».
  const vacation = view.external.filter(item => item.title === 'Отпуск');
  assert.deepEqual(vacation.map(item => [item.date, item.allDay, item.busy]), [['2026-09-08', true, false], ['2026-09-09', true, false]]);
  // Секрет клиента наружу не отдаётся.
  const settings = (await api.get('/api/settings').expect(200)).body.settings;
  assert.equal(settings.googleClientSecret.configured, true);
  assert.equal(settings.googleClientSecret.hint, '••••cret');
  assert.equal(settings.googleClientId, 'client-id');
});

test('очистка данных стирает и внешние календари', async () => {
  const app = freshApp({ calendarFetch: fakeYandex() });
  const api = authed(app);
  await api.post('/api/calendar/accounts').send(yandexBody).expect(201);
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  assert.equal(app.database.prepare('SELECT COUNT(*) n FROM calendar_accounts').get().n, 0);
  assert.equal(app.database.prepare('SELECT COUNT(*) n FROM calendar_events').get().n, 0);
});
