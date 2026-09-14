import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaldavClient, parseMultistatus, normalizeColor } from '../server/caldav.js';
import { createSecretBox } from '../server/secrets.js';

// Приглашение с участниками и повтором: пользователь — необязательный
// участник без ответа, организатор — Стас.
export const INVITATION = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:inv', 'DTSTART:20260910T083000Z', 'DTEND:20260910T093000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TH', 'SUMMARY:Монетизация ZB', 'ORGANIZER;CN=Стас Косухин:mailto:stas@itfinance.tech', 'ATTENDEE;CN=Клим Андреев;PARTSTAT=ACCEPTED:mailto:klim@itfinance.tech', 'ATTENDEE;CN=Александр;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:user@yandex.ru', 'URL:https://calendar.yandex.ru/event?event_id=2916085540', 'DESCRIPTION:Ссылка на видеовстречу: https://telemost.360.yandex.ru/j/0319350436', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
// Заглушка Яндекса: principal и дом по логину, два календаря, одно событие и
// еженедельное приглашение.
export const SERIES = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rr', 'DTSTART:20260902T070000Z', 'DTEND:20260902T071500Z', 'RRULE:FREQ=WEEKLY;BYDAY=WE', 'SUMMARY:Стендап', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
export function fakeYandex({ calls = [] } = {}) {
  return async (url, options) => {
    const method = options.method;
    calls.push({ url, method, body: options.body, headers: options.headers });
    const auth = options.headers.Authorization;
    if (auth !== `Basic ${Buffer.from('user@yandex.ru:app-pass').toString('base64')}`) return new Response('', { status: 401 });
    if (method === 'PROPFIND' && url === 'https://caldav.yandex.ru/') return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/principals/users/user@yandex.ru/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`, { status: 207 });
    if (method === 'PROPFIND' && url === 'https://caldav.yandex.ru/principals/users/user@yandex.ru/') return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/principals/users/user@yandex.ru/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/calendars/user@yandex.ru/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`, { status: 207 });
    if (method === 'PROPFIND' && url === 'https://caldav.yandex.ru/calendars/user@yandex.ru/') return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
      <D:response><D:href>/calendars/user@yandex.ru/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/calendars/user@yandex.ru/events-123/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Личное</D:displayname><A:calendar-color>#FF8A00FF</A:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/calendars/user@yandex.ru/todos-1/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Дела</D:displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      </D:multistatus>`, { status: 207 });
    if (method === 'REPORT' && url === 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/') return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/calendars/user@yandex.ru/events-123/abc.ics</D:href><D:propstat><D:prop><D:getetag>"etag-1"</D:getetag><C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc
DTSTART;TZID=Europe/Moscow:20260907T110000
DTEND;TZID=Europe/Moscow:20260907T120000
SUMMARY:Созвон &lt;важный&gt;
END:VEVENT
END:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/calendars/user@yandex.ru/events-123/inv.ics</D:href><D:propstat><D:prop><D:getetag>"inv-1"</D:getetag><C:calendar-data>${INVITATION.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`, { status: 207 });
    if (method === 'GET' && url.endsWith('/events-123/inv.ics')) return new Response(INVITATION, { status: 200, headers: { ETag: '"inv-1"' } });
    if (method === 'GET' && url.endsWith('/events-123/rr.ics')) return new Response(SERIES, { status: 200, headers: { ETag: '"rr-1"' } });
    if (method === 'GET' && url.endsWith('/events-123/abc.ics')) return new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:abc\r\nDTSTART;TZID=Europe/Moscow:20260907T110000\r\nDTEND;TZID=Europe/Moscow:20260907T120000\r\nSUMMARY:Созвон <важный>\r\nX-YANDEX-FOO:bar\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, { status: 200, headers: { ETag: '"etag-1"' } });
    if (method === 'PUT') return new Response('', { status: 201, headers: { ETag: '"new-etag"' } });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('nope', { status: 404 });
  };
}

test('CalDAV: discovery находит дом и календари с событиями, пропуская календарь дел', async () => {
  const calls = [];
  const client = createCaldavClient({ fetch: fakeYandex({ calls }) });
  const found = await client.discover({ serverUrl: 'https://caldav.yandex.ru', username: 'user@yandex.ru', password: 'app-pass', preset: 'yandex' });
  assert.equal(found.homeUrl, 'https://caldav.yandex.ru/calendars/user@yandex.ru/');
  assert.deepEqual(found.calendars.map(calendar => [calendar.name, calendar.color]), [['Личное', '#ff8a00']]);
  assert.equal(calls[0].headers.Depth, '0');
  await assert.rejects(client.discover({ serverUrl: 'https://caldav.yandex.ru', username: 'user@yandex.ru', password: 'wrong', preset: 'yandex' }), /логин или пароль/);
});

test('CalDAV: события окна приходят с etag и разобранным временем, PUT кладёт .ics по uid', async () => {
  const calls = [];
  const client = createCaldavClient({ fetch: fakeYandex({ calls }) });
  const events = await client.listEvents({ calendarUrl: 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/', username: 'user@yandex.ru', password: 'app-pass', from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-09-08T00:00:00Z'), timeZone: 'Europe/Samara' });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Созвон <важный>');
  assert.equal(events[0].etag, '"etag-1"');
  assert.equal(events[0].href, 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/abc.ics');
  assert.ok(calls.at(-1).body.includes('time-range start="20260907T000000Z"'));
  const put = await client.putEvent({ calendarUrl: 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/', username: 'user@yandex.ru', password: 'app-pass', uid: 'kizuna-1@kizuna', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
  assert.equal(put.href, 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-123/kizuna-1%40kizuna.ics');
  assert.equal(put.etag, '"new-etag"');
  assert.equal(calls.at(-1).headers['If-None-Match'], '*');
});

test('multistatus: префиксы пространств имён не мешают, цвет нормализуется', () => {
  const responses = parseMultistatus('<a:multistatus xmlns:a="DAV:"><a:response><a:href>/x/</a:href><a:propstat><a:prop><a:displayname>X</a:displayname></a:prop><a:status>HTTP/1.1 200 OK</a:status></a:propstat></a:response></a:multistatus>');
  assert.equal(responses[0].href, '/x/');
  assert.ok(responses[0].props.includes('<displayname>X</displayname>'));
  assert.equal(normalizeColor('#AABBCC'), '#aabbcc');
  assert.equal(normalizeColor('красный'), null);
});

test('secrets: шифрование обратимо, чужой ключ не открывает', () => {
  const box = createSecretBox({ key: Buffer.alloc(32, 1) });
  const sealed = box.seal({ password: 'app-pass' });
  assert.ok(sealed.startsWith('v1.'));
  assert.ok(!sealed.includes('app-pass'));
  assert.deepEqual(box.open(sealed), { password: 'app-pass' });
  assert.equal(createSecretBox({ key: Buffer.alloc(32, 2) }).open(sealed), null);
});
