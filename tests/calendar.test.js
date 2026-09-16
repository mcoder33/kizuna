import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { dateInZone, shiftDate } from '../server/reports.js';
import { fakeYandex, INVITATION } from './caldav.test.js';

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
  assert.ok(created.events >= 2, 'событие и экземпляры еженедельного приглашения');
  assert.ok(created.account.syncedAt);
  // Пароль в базе — только шифртекстом.
  const row = app.database.prepare('SELECT credentials_enc, username FROM calendar_accounts').get();
  assert.ok(!row.credentials_enc.includes('app-pass'));
  assert.equal(row.username, 'user@yandex.ru');
  // Событие Яндекса в окне: московские 11:00 — самарские 12:00.
  let view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  assert.equal(view.external.length, 1);
  // Пишущий календарь не в режиме «занято» — событие можно править из сетки.
  assert.deepEqual([view.external[0].title, view.external[0].date, view.external[0].time, view.external[0].end, view.external[0].readOnly, view.external[0].editable], ['Созвон <важный>', '2026-09-07', '12:00', '13:00', false, true]);
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
    if (url.includes('/calendars/me%40gmail.com/events/ev1-series')) return Response.json({ id: 'ev1-series', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    if (url.includes('/calendars/me%40gmail.com/events/ev1_20260907') && options.method === 'GET') return Response.json({ id: 'ev1_20260907', attendees: [{ email: 'boss@corp.example', displayName: 'Босс', organizer: true, responseStatus: 'accepted' }, { email: 'me@gmail.com', self: true, responseStatus: 'needsAction' }] });
    if (url.includes('/calendars/me%40gmail.com/events/ev1_20260907') && options.method === 'PATCH') return Response.json({ id: 'ev1_20260907', etag: '"r2"', attendees: JSON.parse(options.body).attendees });
    if (url.includes('/calendars/me%40gmail.com/events/ev1_20260907/move')) return Response.json({ id: 'ev1_20260907', htmlLink: 'https://calendar.google.com/moved', etag: '"m1"' });
    if (url.includes('/calendars/me%40gmail.com/events')) return Response.json({ items: [{ id: 'ev1_20260907', recurringEventId: 'ev1-series', sequence: 3, summary: '1:1', status: 'confirmed', start: { dateTime: '2026-09-07T12:00:00+04:00' }, end: { dateTime: '2026-09-07T13:00:00+04:00' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://calendar.google.com/ev1', attendees: [{ email: 'boss@corp.example', displayName: 'Босс', organizer: true, responseStatus: 'accepted' }, { email: 'me@gmail.com', self: true, responseStatus: 'needsAction' }] }, { id: 'ev2', summary: 'Отпуск', status: 'confirmed', transparency: 'transparent', start: { date: '2026-09-08' }, end: { date: '2026-09-10' } }] });
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
  // Плашка: правило серии, участники, мой ответ, ссылка на событие.
  assert.equal(meeting.repeat, 'Повторяется каждую неделю по пн');
  assert.deepEqual(meeting.attendees.map(a => [a.name || a.email, a.status, a.organizer, a.self]), [['Босс', 'accepted', true, false], ['me@gmail.com', 'needs-action', false, true]]);
  assert.deepEqual([meeting.me.status, meeting.url, meeting.editable], ['needs-action', 'https://calendar.google.com/ev1', true]);
  calls.length = 0;
  const responded = (await api.post(`/api/calendar/external/${encodeURIComponent(meeting.id)}/respond`).send({ status: 'accepted', comment: 'буду' }).expect(200)).body.event;
  assert.equal(responded.me.status, 'accepted');
  const patch = calls.find(call => call.method === 'PATCH');
  assert.ok(patch.url.includes('sendUpdates=all'));
  assert.deepEqual(JSON.parse(patch.body).attendees.find(a => a.self), { email: 'me@gmail.com', self: true, responseStatus: 'accepted', comment: 'буду' });
  await api.post(`/api/calendar/external/${encodeURIComponent(meeting.id)}/respond`).send({ status: 'maybe' }).expect(400);
  // Перенос в другой календарь учётной записи — events.move; чужой календарь без прав — отказ.
  await api.post(`/api/calendar/external/${encodeURIComponent(meeting.id)}/move`).send({ calendarId: 'holidays' }).expect(404);
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

// Синхронизация Яндекса, где наше же событие можно «подвинуть снаружи»:
// REPORT отдаёт то, что лежит в outside, поверх обычного события abc.
function yandexWithOutside({ calls = [], outside = { list: [] } } = {}) {
  const base = fakeYandex({ calls });
  return async (url, options) => {
    if (options.method === 'REPORT' && url === 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/' && outside.list.length) {
      const responses = outside.list.map(event => `<D:response><D:href>/calendars/user@yandex.ru/events-123/${encodeURIComponent(event.uid)}.ics</D:href><D:propstat><D:prop><D:getetag>"${event.etag}"</D:getetag><C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${event.uid}
DTSTART:${event.start}
DTEND:${event.end}
SUMMARY:${event.title}
END:VEVENT
END:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
      calls.push({ url, method: 'REPORT', body: options.body, headers: options.headers });
      return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`, { status: 207 });
    }
    return base(url, options);
  };
}
const stampUtc = iso => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

test('автосинк с Яндексом: дела и встречи уходят сами, следуют за записью и уходят вместе с ней', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body.account;
  assert.equal(account.autoExport, 'off');
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'weird' }).expect(400);
  // Включили «встречи и дела» — календарь-приёмник подставился сам.
  const enabled = (await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'all' }).expect(200)).body.account;
  assert.equal(enabled.autoExport, 'all');
  assert.equal(enabled.autoCalendarId, account.calendars[0].id);
  const day = shiftDate(today(), 3);
  const todo = (await api.post('/api/captures').send({ raw: 'отправить смету', primaryType: 'todo', due: { date: day, time: '10:00' } }).expect(201)).body.entry;
  const past = (await api.post('/api/captures').send({ raw: 'давно просроченное', primaryType: 'todo', due: { date: shiftDate(today(), -5) } }).expect(201)).body.entry;
  await api.post('/api/captures').send({ raw: 'Просто заметка' }).expect(201);
  calls.length = 0;
  const pushed = await app.calendar.autoExport();
  assert.deepEqual(pushed.map(result => [result.created, result.updated, result.removed]), [[1, 0, 0]]);
  let puts = calls.filter(call => call.method === 'PUT');
  assert.equal(puts.length, 1, 'просроченное задним числом не отправляется, заметка тем более');
  assert.ok(puts[0].url.endsWith(`kizuna-${todo.id}%40kizuna.ics`));
  assert.equal(puts[0].headers['If-None-Match'], '*');
  assert.ok(puts[0].body.includes('SUMMARY:отправить смету'));
  let view = (await api.get(`/api/calendar?from=${day}&to=${day}`).expect(200)).body;
  assert.deepEqual(view.items.find(item => item.id === todo.id).exports, [{ accountId: account.id, calendarId: account.calendars[0].id, href: puts[0].url, auto: true }]);
  assert.ok(!view.external.some(item => item.title === 'отправить смету'), 'своё событие в чужом кэше не показывается второй раз');
  // Повторный проход без изменений ничего не пишет.
  calls.length = 0;
  await app.calendar.autoExport();
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  // Перенос — переписывается тем же uid, уже без If-None-Match.
  await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { schedule: { date: day, time: '15:00', end: '16:00' } } }).expect(200);
  calls.length = 0;
  await app.calendar.autoExport();
  puts = calls.filter(call => call.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].headers['If-None-Match'], undefined);
  assert.ok(puts[0].url.endsWith(`kizuna-${todo.id}%40kizuna.ics`));
  // «Сделано» оставляет событие в календаре, удаление записи убирает его.
  const projectionId = app.database.prepare(`SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type='task'`).get(todo.id).id;
  await api.post(`/api/projections/${projectionId}/complete`).send({}).expect(200);
  calls.length = 0;
  await app.calendar.autoExport();
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  // «Сделано» в карточке делает запись результатом — а состоявшееся из
  // календаря от этого не пропадает и больше не переписывается.
  const settled = (await api.post(`/api/captures/${todo.id}/corrections`).send({ patch: { completed: true } }).expect(200)).body.entry;
  assert.equal(settled.interpretation.classification.primaryType, 'outcome_decision');
  calls.length = 0;
  await app.calendar.autoExport();
  assert.deepEqual(calls.filter(call => ['PUT', 'DELETE'].includes(call.method)), []);
  await api.delete(`/api/captures/${todo.id}`).expect(200);
  calls.length = 0;
  const removed = await app.calendar.autoExport();
  assert.equal(removed[0].removed, 1);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(app.database.prepare('SELECT COUNT(*) n FROM calendar_links').get().n, 0);
  // Режим «встречи» дела не трогает; выключение не забирает уже отправленное.
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'meetings' }).expect(200);
  const another = (await api.post('/api/captures').send({ raw: 'ещё одно дело', primaryType: 'todo', due: { date: day } }).expect(201)).body.entry;
  calls.length = 0;
  await app.calendar.autoExport();
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'all' }).expect(200);
  await app.calendar.autoExport();
  assert.equal(app.database.prepare('SELECT auto FROM calendar_links WHERE capture_id=?').get(another.id).auto, 1);
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'off' }).expect(200);
  calls.length = 0;
  await app.calendar.autoExport();
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(app.database.prepare('SELECT COUNT(*) n FROM calendar_links').get().n, 1);
  // Автоматически отправленное «убрать» руками нельзя, пока режим включён — но
  // при выключенном оно ведёт себя как ручное.
  await api.post('/api/calendar/export/remove').send({ captureId: another.id, accountId: account.id }).expect(200);
  assert.equal(past.id.length > 0, true);
});

test('автосинк обратно: событие подвинули в Яндексе — срок записи подвинулся, наружу ничего не ушло', async () => {
  const calls = [];
  const outside = { list: [] };
  const app = freshApp({ calendarFetch: yandexWithOutside({ calls, outside }) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body.account;
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'all' }).expect(200);
  const day = shiftDate(today(), 2);
  const todo = (await api.post('/api/captures').send({ raw: 'сходить к врачу', primaryType: 'todo', due: { date: day, time: '09:00' } }).expect(201)).body.entry;
  await app.calendar.autoExport();
  const link = app.database.prepare('SELECT * FROM calendar_links WHERE capture_id=?').get(todo.id);
  assert.equal(link.etag, '"new-etag"');
  // Снаружи событие перенесли на 14:00–15:00 самарского (10:00Z–11:00Z) и etag сменился.
  outside.list = [{ uid: `kizuna-${todo.id}@kizuna`, etag: 'moved-etag', title: 'сходить к врачу', start: stampUtc(`${day}T10:00:00.000Z`), end: stampUtc(`${day}T11:00:00.000Z`) }];
  await app.calendar.syncAccount(account.id);
  calls.length = 0;
  const result = await app.calendar.autoExport();
  assert.equal(result[0].pulled, 1);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  const schedule = JSON.parse(app.database.prepare(`SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'`).get(todo.id).classification_json).entities.schedule;
  assert.deepEqual([schedule.date, schedule.time, schedule.end], [day, '14:00', '15:00']);
  // Отпечаток и etag обновлены: следующий проход тих.
  calls.length = 0;
  await app.calendar.autoExport();
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
});

test('чужое событие из сетки: перенос и переименование уходят PUT с If-Match, удаление — DELETE; «занято» не правится, повтор — только этот экземпляр', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body.account;
  let view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  const event = view.external[0];
  assert.equal(event.editable, true);
  calls.length = 0;
  const moved = (await api.patch(`/api/calendar/external/${encodeURIComponent(event.id)}`).send({ date: '2026-09-08', time: '15:00', end: '15:45', title: 'Созвон перенесён' }).expect(200)).body.event;
  assert.deepEqual([moved.date, moved.time, moved.end, moved.title], ['2026-09-08', '15:00', '15:45', 'Созвон перенесён']);
  const get = calls.find(call => call.method === 'GET');
  assert.ok(get.url.endsWith('/events-123/abc.ics'));
  const put = calls.find(call => call.method === 'PUT');
  assert.equal(put.url, 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/abc.ics');
  assert.equal(put.headers['If-Match'], '"etag-1"');
  assert.ok(put.body.includes('DTSTART:20260908T110000Z'), 'самарские 15:00 — 11:00Z');
  assert.ok(put.body.includes('DTEND:20260908T114500Z'));
  assert.ok(put.body.includes('SUMMARY:Созвон перенесён'));
  assert.ok(put.body.includes('X-YANDEX-FOO:bar'), 'чужие свойства сохранены');
  assert.ok(!put.body.includes('TZID=Europe/Moscow'));
  view = (await api.get('/api/calendar?from=2026-09-08&to=2026-09-08').expect(200)).body;
  assert.deepEqual([view.external[0].time, view.external[0].end, view.external[0].title], ['15:00', '15:45', 'Созвон перенесён']);
  await api.patch(`/api/calendar/external/${encodeURIComponent(event.id)}`).send({ time: '15:00', end: '14:00' }).expect(400);
  await api.patch(`/api/calendar/external/${encodeURIComponent(event.id)}`).send({ title: '' }).expect(400);
  await api.patch('/api/calendar/external/ext:nope').send({ title: 'x' }).expect(404);
  // Режим «занято» закрывает правку; чужой пользователь события не видит.
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ mode: 'busy' }).expect(200);
  await api.patch(`/api/calendar/external/${encodeURIComponent(event.id)}`).send({ title: 'x' }).expect(409);
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ mode: 'full' }).expect(200);
  const stranger = authed(app, { email: 'other@kizuna.test', role: 'user' });
  await stranger.delete(`/api/calendar/external/${encodeURIComponent(event.id)}`).expect(404);
  calls.length = 0;
  await api.delete(`/api/calendar/external/${encodeURIComponent(event.id)}`).expect(200);
  assert.equal(calls.filter(call => call.method === 'DELETE')[0].url, 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/abc.ics');
  view = (await api.get('/api/calendar?from=2026-09-08&to=2026-09-08').expect(200)).body;
  assert.equal(view.external.length, 0);
  // Экземпляр повтора по CalDAV (строка кэша с instance_key) правится как «только
  // это событие»: в файл серии дописывается VEVENT с RECURRENCE-ID.
  app.database.prepare(`INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,description,location,start_at,end_at,all_day,busy,join_url,etag,href,updated_at) VALUES('rec1',?,?,'rr','2026-09-09T07:00:00.000Z','Стендап',NULL,NULL,'2026-09-09T07:00:00.000Z','2026-09-09T07:15:00.000Z',0,1,NULL,'"e"','https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/rr.ics',?)`).run(account.id, account.calendars[0].id, new Date().toISOString());
  view = (await api.get('/api/calendar?from=2026-09-09&to=2026-09-09').expect(200)).body;
  assert.deepEqual([view.external[0].editable, view.external[0].movable, view.external[0].recurring], [true, false, true]);
  calls.length = 0;
  // 12:00 самарского — 08:00Z; длительность четверть часа сохраняется.
  const shifted = (await api.patch('/api/calendar/external/ext:rec1').send({ time: '12:00', title: 'Стендап (позже)' }).expect(200)).body.event;
  assert.deepEqual([shifted.time, shifted.end, shifted.title], ['12:00', '12:15', 'Стендап (позже)']);
  const seriesPut = calls.find(call => call.method === 'PUT');
  assert.equal(seriesPut.url, 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/rr.ics');
  assert.equal(seriesPut.headers['If-Match'], '"rr-1"');
  assert.ok(seriesPut.body.includes('RECURRENCE-ID:20260909T070000Z'));
  assert.ok(seriesPut.body.includes('DTSTART:20260909T080000Z') && seriesPut.body.includes('DTEND:20260909T081500Z'));
  assert.ok(seriesPut.body.includes('DTSTART:20260902T070000Z') && seriesPut.body.includes('RRULE:FREQ=WEEKLY;BYDAY=WE'), 'серия не тронута');
  view = (await api.get('/api/calendar?from=2026-09-09&to=2026-09-09').expect(200)).body;
  assert.deepEqual([view.external[0].time, view.external[0].title], ['12:00', 'Стендап (позже)']);
  // В другой календарь экземпляр не переезжает — только серия целиком.
  await api.post('/api/calendar/external/ext:rec1/move').send({ calendarId: 'whatever' }).expect(409);
  // Удаление экземпляра — EXDATE в серии тем же PUT, а не DELETE файла.
  calls.length = 0;
  await api.delete('/api/calendar/external/ext:rec1').expect(200);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  const exdatePut = calls.find(call => call.method === 'PUT');
  assert.ok(exdatePut.body.includes('EXDATE:20260909T070000Z') && exdatePut.body.includes('RRULE:FREQ=WEEKLY;BYDAY=WE'));
  view = (await api.get('/api/calendar?from=2026-09-09&to=2026-09-09').expect(200)).body;
  assert.equal(view.external.length, 0);
});

test('голос и календарь: list_calendar видит своё и чужое, update_event двигает чужое, take_event кладёт в память', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  await api.post('/api/calendar/accounts').send(yandexBody).expect(201);
  const todo = (await api.post('/api/captures').send({ raw: 'отдать ключи', primaryType: 'todo', due: { date: '2026-09-07', time: '09:30' } }).expect(201)).body.entry;
  const listed = (await api.post('/api/voice/tool').send({ name: 'list_calendar', arguments: { from: '2026-09-07', to: '2026-09-07' } }).expect(200)).body.result;
  assert.deepEqual(listed.items.map(item => [item.kind, item.title, item.time, item.captureId || item.eventId?.startsWith('ext:')]), [['задача', 'отдать ключи', '09:30', todo.id], ['событие', 'Созвон <важный>', '12:00', true]]);
  assert.deepEqual(listed.calendars, ['Яндекс · user@yandex.ru']);
  const eventId = listed.items[1].eventId;
  await api.post('/api/voice/tool').send({ name: 'update_event', arguments: { eventId: todo.id, time: '10:00' } }).expect(400);
  const moved = (await api.post('/api/voice/tool').send({ name: 'update_event', arguments: { eventId, time: '16:00' } }).expect(200)).body.result;
  assert.deepEqual([moved.updated, moved.event.time, moved.event.end], [true, '16:00', '17:00']);
  assert.ok(calls.some(call => call.method === 'PUT' && call.body.includes('DTSTART:20260907T120000Z')));
  // Своё дело двигается update_capture, теперь и с концом.
  const own = (await api.post('/api/voice/tool').send({ name: 'update_capture', arguments: { captureId: todo.id, due: { date: '2026-09-07', time: '11:00', end: '11:30' } } }).expect(200)).body.result;
  assert.equal(own.due, '2026-09-07, 11:00–11:30');
  const taken = (await api.post('/api/voice/tool').send({ name: 'take_event', arguments: { eventId } }).expect(200)).body.result;
  assert.equal(taken.saved, true);
  assert.match(app.database.prepare('SELECT raw FROM captures WHERE id=?').get(taken.captureId).raw, /Созвон <важный> — 07\.09\.2026 в 16:00–17:00 \(из календаря Яндекс/);
  const gone = (await api.post('/api/voice/tool').send({ name: 'delete_event', arguments: { eventId } }).expect(200)).body.result;
  assert.equal(gone.removed, true);
  await api.post('/api/voice/tool').send({ name: 'delete_event', arguments: { eventId } }).expect(400);
  // Заглушка разговора отвечает по календарю той же дорогой.
  const turn = (await api.post('/api/voice/turn').send({ text: 'что у меня в календаре' }).expect(200)).body;
  assert.equal(turn.calls[0].name, 'list_calendar');
  assert.match(turn.reply, /В календаре \d|пусто/);
});

test('автосинк с Google: встреча создаётся events.insert, перенос — events.update, чужое событие правится PATCH', async () => {
  const calls = [];
  const googleFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    if (url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: 'me@gmail.com', summary: 'me@gmail.com', primary: true, accessRole: 'owner' }] });
    if (url.includes('/calendars/me%40gmail.com/events/g-1') && options.method === 'PUT') return Response.json({ id: 'g-1', htmlLink: 'https://calendar.google.com/g-1', etag: '"g-etag-2"' });
    if (url.includes('/calendars/me%40gmail.com/events/ev1') && options.method === 'PATCH') return Response.json({ id: 'ev1', etag: '"ev1-2"' });
    if (url.includes('/calendars/me%40gmail.com/events?')) return Response.json({ items: [{ id: 'ev1', summary: '1:1', status: 'confirmed', start: { dateTime: '2026-09-07T12:00:00+04:00' }, end: { dateTime: '2026-09-07T13:00:00+04:00' } }] });
    if (url.includes('/calendars/me%40gmail.com/events') && options.method === 'POST') return Response.json({ id: 'g-1', htmlLink: 'https://calendar.google.com/g-1', etag: '"g-etag-1"' });
    return new Response('not found', { status: 404 });
  };
  const app = freshApp({ calendarFetch: googleFetch });
  const api = authed(app);
  await api.put('/api/settings').send({ googleClientId: 'client-id', googleClientSecret: 'client-secret' }).expect(200);
  const start = await api.get('/api/calendar/google/start').set('Host', 'kizuna.example').expect(302);
  const state = new URL(start.headers.location).searchParams.get('state');
  await api.get(`/api/calendar/google/callback?state=${state}&code=the-code`).expect(302);
  const account = (await api.get('/api/calendar/accounts').expect(200)).body.accounts[0];
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'meetings' }).expect(200);
  const meeting = (await api.post('/api/captures').send({ raw: 'Завтра в 11 созвон с BE по секретам сессий в Hub' }).expect(201)).body.entry;
  assert.equal(meeting.interpretation.classification.primaryType, 'meeting_event');
  await api.post('/api/captures').send({ raw: 'купить молоко', primaryType: 'todo', due: { date: shiftDate(today(), 1) } }).expect(201);
  calls.length = 0;
  await app.calendar.autoExport();
  const posts = calls.filter(call => call.method === 'POST' && call.url.includes('/events'));
  assert.equal(posts.length, 1, 'в режиме «встречи» дело не уходит');
  const body = JSON.parse(posts[0].body);
  assert.equal(body.extendedProperties.private.kizunaCaptureId, meeting.id);
  assert.ok(body.start.dateTime);
  const date = meeting.interpretation.classification.entities.schedule.date;
  await api.post(`/api/captures/${meeting.id}/corrections`).send({ patch: { schedule: { date, time: '12:00', end: '12:30' } } }).expect(200);
  calls.length = 0;
  await app.calendar.autoExport();
  const put = calls.find(call => call.method === 'PUT');
  assert.ok(put.url.endsWith('/events/g-1'));
  assert.equal(JSON.parse(put.body).summary, body.summary);
  // Чужое событие Google переносится PATCH по его id.
  const view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  const external = view.external.find(item => item.title === '1:1');
  assert.equal(external.editable, true);
  calls.length = 0;
  await api.patch(`/api/calendar/external/${encodeURIComponent(external.id)}`).send({ time: '14:00' }).expect(200);
  const patch = calls.find(call => call.method === 'PATCH');
  assert.ok(patch.url.endsWith('/events/ev1'));
  assert.deepEqual(JSON.parse(patch.body).start, { dateTime: '2026-09-07T10:00:00.000Z' });
  assert.deepEqual(JSON.parse(patch.body).end, { dateTime: '2026-09-07T11:00:00.000Z' });
});


test('приглашение из Яндекса: участники с ответами, повтор словами, ответ организатору уходит PUT с PARTSTAT и COMMENT', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  await api.post('/api/calendar/accounts').send(yandexBody).expect(201);
  let view = (await api.get('/api/calendar?from=2026-09-10&to=2026-09-10').expect(200)).body;
  const invite = view.external.find(item => item.title === 'Монетизация ZB');
  assert.ok(invite);
  assert.equal(invite.repeat, 'Повторяется каждую неделю по чт');
  assert.deepEqual([invite.editable, invite.movable, invite.recurring], [true, false, true], 'экземпляр повтора по CalDAV правится, но в другой календарь не переезжает');
  assert.deepEqual(invite.attendees.map(a => [a.name, a.status, a.organizer, a.optional, a.self]), [['Стас Косухин', 'accepted', true, false, false], ['Клим Андреев', 'accepted', false, false, false], ['Александр', 'needs-action', false, true, true]]);
  assert.deepEqual([invite.organizer.name, invite.me.status, invite.url, invite.joinUrl], ['Стас Косухин', 'needs-action', 'https://calendar.yandex.ru/event?event_id=2916085540', 'https://telemost.360.yandex.ru/j/0319350436']);
  calls.length = 0;
  const responded = (await api.post(`/api/calendar/external/${encodeURIComponent(invite.id)}/respond`).send({ status: 'tentative', comment: 'буду с опозданием' }).expect(200)).body.event;
  assert.equal(responded.me.status, 'tentative');
  const put = calls.find(call => call.method === 'PUT');
  assert.ok(put.url.endsWith('/events-123/inv.ics'));
  assert.equal(put.headers['If-Match'], '"inv-1"');
  const body = put.body.replace(/\r\n[ \t]/g, '');
  assert.ok(body.includes('PARTSTAT=TENTATIVE:mailto:user@yandex.ru'));
  assert.ok(!body.includes('RSVP=TRUE'));
  assert.ok(body.includes('COMMENT:буду с опозданием'));
  assert.ok(body.includes('RRULE:FREQ=WEEKLY;BYDAY=TH'), 'серия не тронута');
  // Кэш отвечает сразу, у всех экземпляров серии.
  view = (await api.get('/api/calendar?from=2026-09-17&to=2026-09-17').expect(200)).body;
  assert.equal(view.external.find(item => item.title === 'Монетизация ZB').me.status, 'tentative');
  // Там, где нас нет среди участников, отвечать некому.
  view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  await api.post(`/api/calendar/external/${encodeURIComponent(view.external[0].id)}/respond`).send({ status: 'accepted' }).expect(409);
  // Голос: respond_event — та же дорога.
  const spoken = (await api.post('/api/voice/tool').send({ name: 'respond_event', arguments: { eventId: invite.id, status: 'accepted' } }).expect(200)).body.result;
  assert.deepEqual([spoken.responded, spoken.title], ['accepted', 'Монетизация ZB']);
  const listed = (await api.post('/api/voice/tool').send({ name: 'list_calendar', arguments: { from: '2026-09-10', to: '2026-09-10' } }).expect(200)).body.result;
  const item = listed.items.find(entry => entry.title === 'Монетизация ZB');
  assert.deepEqual([item.myStatus, item.organizer, item.repeat], ['accepted', 'Стас Косухин', 'Повторяется каждую неделю по чт']);
});

// Экземпляр повтора по CalDAV: «только это событие» — EXDATE в серии, «вся
// серия» — DELETE файла и кэш всех экземпляров разом.
test('серия по CalDAV: удалить можно один экземпляр или всю серию', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  const account = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body.account;
  const insert = app.database.prepare(`INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,description,location,start_at,end_at,all_day,busy,join_url,etag,href,updated_at) VALUES(?,?,?,'rr',?,'Стендап',NULL,NULL,?,?,0,1,NULL,'"e"','https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/rr.ics',?)`);
  for (const [id, day] of [['rec1', '2026-09-09'], ['rec2', '2026-09-16']]) insert.run(id, account.id, account.calendars[0].id, `${day}T07:00:00.000Z`, `${day}T07:00:00.000Z`, `${day}T07:15:00.000Z`, new Date().toISOString());
  let view = (await api.get('/api/calendar?from=2026-09-09&to=2026-09-16').expect(200)).body;
  const standups = () => view.external.filter(item => item.title === 'Стендап');
  assert.deepEqual(standups().map(item => [item.id, item.recurring]), [['ext:rec1', true], ['ext:rec2', true]]);
  await api.delete('/api/calendar/external/ext:rec1?scope=bogus').expect(400);
  // Только этот экземпляр — EXDATE тем же PUT, второй экземпляр остаётся.
  calls.length = 0;
  assert.equal((await api.delete('/api/calendar/external/ext:rec1?scope=instance').expect(200)).body.scope, 'instance');
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  assert.ok(calls.find(call => call.method === 'PUT').body.includes('EXDATE:20260909T070000Z'));
  view = (await api.get('/api/calendar?from=2026-09-09&to=2026-09-16').expect(200)).body;
  assert.deepEqual(standups().map(item => item.id), ['ext:rec2']);
  // Вся серия — DELETE файла, в кэше не остаётся ни одного экземпляра.
  calls.length = 0;
  assert.equal((await api.delete('/api/calendar/external/ext:rec2?scope=series').expect(200)).body.scope, 'series');
  assert.equal(calls.filter(call => call.method === 'DELETE')[0].url, 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/rr.ics');
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  view = (await api.get('/api/calendar?from=2026-09-09&to=2026-09-16').expect(200)).body;
  assert.equal(standups().length, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) n FROM calendar_events WHERE uid='rr'").get().n, 0);
});

// У Google экземпляр повтора — своё событие с recurringEventId: удаление
// одного — DELETE по его id, серии — по id серии. Своя серия уходит наружу
// строкой recurrence и с поясом у начала и конца.
test('серия в Google: экземпляр узнаётся по recurringEventId, удаляется один или вся серия, своя серия уходит с recurrence', async () => {
  const calls = [], deleted = [];
  const instance = { id: 'ev1_20260907T080000Z', recurringEventId: 'ev1', originalStartTime: { dateTime: '2026-09-07T12:00:00+04:00' }, summary: 'Стендап', status: 'confirmed', start: { dateTime: '2026-09-07T12:00:00+04:00' }, end: { dateTime: '2026-09-07T12:15:00+04:00' } };
  const googleFetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    if (url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: 'me@gmail.com', summary: 'me@gmail.com', primary: true, accessRole: 'owner' }] });
    if (method === 'DELETE') { deleted.push(url); return new Response(null, { status: 204 }); }
    if (url.endsWith('/calendars/me%40gmail.com/events/ev1')) return Response.json({ id: 'ev1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    if (url.includes('/calendars/me%40gmail.com/events?')) return Response.json({ items: deleted.some(gone => gone.endsWith('/events/ev1')) ? [] : [instance] });
    if (url.includes('/calendars/me%40gmail.com/events') && method === 'POST') return Response.json({ id: 'g-1', htmlLink: 'https://calendar.google.com/g-1', etag: '"g-etag-1"' });
    return new Response('not found', { status: 404 });
  };
  const app = freshApp({ calendarFetch: googleFetch });
  const api = authed(app);
  await api.put('/api/settings').send({ googleClientId: 'client-id', googleClientSecret: 'client-secret' }).expect(200);
  const start = await api.get('/api/calendar/google/start').set('Host', 'kizuna.example').expect(302);
  const state = new URL(start.headers.location).searchParams.get('state');
  await api.get(`/api/calendar/google/callback?state=${state}&code=the-code`).expect(302);
  const account = (await api.get('/api/calendar/accounts').expect(200)).body.accounts[0];
  let view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  const event = view.external.find(item => item.title === 'Стендап');
  assert.deepEqual([event.recurring, event.repeat, event.editable], [true, 'Повторяется каждую неделю по пн', true]);
  assert.equal(app.database.prepare('SELECT series_uid FROM calendar_events WHERE uid=?').get('ev1_20260907T080000Z').series_uid, 'ev1');
  // Только этот экземпляр — DELETE по id экземпляра.
  assert.equal((await api.delete(`/api/calendar/external/${encodeURIComponent(event.id)}`).expect(200)).body.scope, 'instance');
  assert.ok(deleted.at(-1).endsWith('/events/ev1_20260907T080000Z'));
  assert.equal((await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body.external.length, 0);
  // Заглушка экземпляр отдаёт снова — после синхронизации он на месте; вся
  // серия — DELETE по recurringEventId, и кэш серии пуст.
  await api.post(`/api/calendar/accounts/${account.id}/sync`).expect(200);
  view = (await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body;
  const again = view.external.find(item => item.title === 'Стендап');
  assert.ok(again);
  assert.equal((await api.delete(`/api/calendar/external/${encodeURIComponent(again.id)}?scope=series`).expect(200)).body.scope, 'series');
  assert.ok(deleted.at(-1).endsWith('/events/ev1'));
  assert.equal((await api.get('/api/calendar?from=2026-09-07&to=2026-09-07').expect(200)).body.external.length, 0);
  // Своя серия наружу: RRULE в recurrence, пояс у начала и конца.
  await api.patch(`/api/calendar/accounts/${account.id}`).send({ autoExport: 'all' }).expect(200);
  const day = shiftDate(today(), 1);
  await api.post('/api/captures').send({ raw: 'отчёт', primaryType: 'todo', due: { date: day, time: '10:00', repeat: { freq: 'daily', until: shiftDate(day, 3) } } }).expect(201);
  calls.length = 0;
  await app.calendar.autoExport();
  const post = calls.find(call => call.method === 'POST' && call.url.includes('/events'));
  const body = JSON.parse(post.body);
  assert.deepEqual(body.recurrence, [`RRULE:FREQ=DAILY;UNTIL=${shiftDate(day, 3).replace(/-/g, '')}T060000Z`]);
  assert.equal(body.start.timeZone, 'Europe/Samara');
  assert.equal(body.end.timeZone, 'Europe/Samara');
});

// Свой повтор: правило — свойство срока. Экземпляры разворачиваются в окне,
// убранный экземпляр пропадает, перенос серии сдвигает и пропуски, наружу
// уходит RRULE с EXDATE, снятие повтора оставляет одно дело.
test('свой повтор: экземпляры в окне, убранный повтор, перенос серии, RRULE с EXDATE наружу и снятие повтора', async () => {
  const calls = [];
  const app = freshApp({ calendarFetch: fakeYandex({ calls }) });
  const api = authed(app);
  const day = shiftDate(today(), 1);
  const series = (await api.post('/api/captures').send({ raw: 'стендап', primaryType: 'todo', due: { date: day, time: '09:30', repeat: { freq: 'weekly' } } }).expect(201)).body.entry;
  const scheduleOf = entry => entry.interpretation.classification.entities.schedule;
  assert.deepEqual(scheduleOf(series).repeat, { freq: 'weekly', interval: 1, until: null });
  assert.equal(scheduleOf(series).display, `${day}, 09:30, каждую неделю`);
  // Кривое правило, «до» раньше первого экземпляра и повтор без даты — отказ.
  await api.post('/api/captures').send({ raw: 'x', primaryType: 'todo', due: { date: day, repeat: { freq: 'hourly' } } }).expect(400);
  await api.post(`/api/captures/${series.id}/corrections`).send({ patch: { schedule: { date: day, time: '09:30', repeat: { freq: 'weekly', until: shiftDate(day, -1) } } } }).expect(400);
  await api.post(`/api/captures/${series.id}/corrections`).send({ patch: { schedule: { date: null, time: null, repeat: { freq: 'weekly' } } } }).expect(400);
  // Модель тоже отдаёт повтор: «каждый понедельник» — еженедельно с ближайшего понедельника.
  const spoken = (await api.post('/api/captures').send({ raw: 'Созвон с BE каждый понедельник в 10:00' }).expect(201)).body.entry;
  assert.equal(scheduleOf(spoken).repeat.freq, 'weekly');
  assert.equal(new Date(`${scheduleOf(spoken).date}T12:00:00Z`).getUTCDay(), 1);
  const range = `from=${today()}&to=${shiftDate(today(), 20)}`;
  let mine = (await api.get(`/api/calendar?${range}`).expect(200)).body.items.filter(item => item.id === series.id);
  assert.deepEqual(mine.map(item => [item.date, item.time, item.recurring, item.repeat, item.baseDate, item.overdue]), [[day, '09:30', true, 'каждую неделю', day, false], [shiftDate(day, 7), '09:30', true, 'каждую неделю', day, false], [shiftDate(day, 14), '09:30', true, 'каждую неделю', day, false]]);
  // Убрать один экземпляр: пропуск в сроке, правило остаётся.
  const skipped = (await api.post(`/api/captures/${series.id}/corrections`).send({ patch: { schedule: { date: day, time: '09:30', skip: [shiftDate(day, 7)] } } }).expect(200)).body.entry;
  assert.deepEqual([scheduleOf(skipped).skip, scheduleOf(skipped).repeat.freq], [[shiftDate(day, 7)], 'weekly']);
  mine = (await api.get(`/api/calendar?${range}`).expect(200)).body.items.filter(item => item.id === series.id);
  assert.deepEqual(mine.map(item => item.date), [day, shiftDate(day, 14)]);
  // Доска: срок серии — ближайший экземпляр, с правилом словами.
  const card = (await api.get('/api/board').expect(200)).body.columns[0].cards.find(item => item.captureId === series.id);
  assert.deepEqual(card.due, { date: day, time: '09:30', repeat: 'каждую неделю' });
  // Перенос серии на день позже двигает и пропуск: он привязан к месту в серии.
  const moved = (await api.post(`/api/captures/${series.id}/corrections`).send({ patch: { schedule: { date: shiftDate(day, 1), time: '10:00' } } }).expect(200)).body.entry;
  assert.deepEqual([scheduleOf(moved).date, scheduleOf(moved).skip, scheduleOf(moved).repeat.freq], [shiftDate(day, 1), [shiftDate(day, 8)], 'weekly']);
  // Наружу: RRULE и EXDATE (10:00 самарского — 06:00Z).
  const account = (await api.post('/api/calendar/accounts').send(yandexBody).expect(201)).body.account;
  calls.length = 0;
  await api.post('/api/calendar/export').send({ captureId: series.id, accountId: account.id, calendarId: account.calendars[0].id }).expect(201);
  const put = calls.find(call => call.method === 'PUT');
  assert.ok(put.body.includes('RRULE:FREQ=WEEKLY'), put.body);
  assert.ok(put.body.includes(`EXDATE:${shiftDate(day, 8).replace(/-/g, '')}T060000Z`), put.body);
  // Снятие повтора: одно дело, пропусков нет.
  const single = (await api.post(`/api/captures/${series.id}/corrections`).send({ patch: { schedule: { date: shiftDate(day, 1), time: '10:00', repeat: null } } }).expect(200)).body.entry;
  assert.equal(scheduleOf(single).repeat, undefined);
  assert.equal(scheduleOf(single).skip, undefined);
  mine = (await api.get(`/api/calendar?${range}`).expect(200)).body.items.filter(item => item.id === series.id);
  assert.deepEqual(mine.map(item => [item.date, item.recurring]), [[shiftDate(day, 1), undefined]]);
});
