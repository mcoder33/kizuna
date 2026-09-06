import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, buildEvent, findJoinUrl, zonedToUtc, localDateTime, expandRrule } from '../server/ics.js';

const sample = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Yandex LLC//Yandex Calendar//EN
X-WR-CALNAME:Работа
BEGIN:VEVENT
UID:one@yandex
DTSTAMP:20260901T100000Z
DTSTART;TZID=Europe/Moscow:20260907T110000
DTEND;TZID=Europe/Moscow:20260907T120000
SUMMARY:Созвон с BE\\, секреты сессий
DESCRIPTION:Ссылка: https://telemost.yandex.ru/j/1234567890
END:VEVENT
BEGIN:VEVENT
UID:allday@yandex
DTSTART;VALUE=DATE:20260908
DTEND;VALUE=DATE:20260910
SUMMARY:Командировка
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:standup@yandex
DTSTART;TZID=Europe/Moscow:20260901T093000
DURATION:PT30M
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR
EXDATE;TZID=Europe/Moscow:20260909T093000
SUMMARY:Стендап
END:VEVENT
BEGIN:VEVENT
UID:standup@yandex
RECURRENCE-ID;TZID=Europe/Moscow:20260911T093000
DTSTART;TZID=Europe/Moscow:20260911T100000
DTEND;TZID=Europe/Moscow:20260911T101500
SUMMARY:Стендап (сдвинут)
END:VEVENT
BEGIN:VEVENT
UID:cancelled@yandex
DTSTART:20260907T150000Z
DTEND:20260907T160000Z
STATUS:CANCELLED
SUMMARY:Отменено
END:VEVENT
END:VCALENDAR
`;

test('parseCalendar: события окна с поясом, весь день, повтор с исключением и сдвинутым экземпляром', () => {
  const { name, events } = parseCalendar(sample, { from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-09-13T00:00:00Z'), timeZone: 'Europe/Samara' });
  assert.equal(name, 'Работа');
  const titles = events.map(event => `${event.title}@${event.start.toISOString()}`);
  // Московские 11:00 — это 08:00 UTC.
  assert.ok(titles.includes('Созвон с BE, секреты сессий@2026-09-07T08:00:00.000Z'));
  const meeting = events.find(event => event.uid === 'one@yandex');
  assert.equal(meeting.joinUrl, 'https://telemost.yandex.ru/j/1234567890');
  assert.equal(meeting.allDay, false);
  const trip = events.find(event => event.uid === 'allday@yandex');
  assert.equal(trip.allDay, true);
  assert.equal(trip.busy, false);
  assert.equal(trip.end.toISOString(), '2026-09-10T00:00:00.000Z');
  // Стендап по понедельникам, средам и пятницам: 7-го и 11-го есть, 9-го — исключён, 11-го — сдвинут на 10:00.
  const standups = events.filter(event => event.uid === 'standup@yandex').map(event => `${event.title}@${event.start.toISOString()}`);
  assert.deepEqual(standups, ['Стендап@2026-09-07T06:30:00.000Z', 'Стендап (сдвинут)@2026-09-11T07:00:00.000Z']);
  const cancelled = events.find(event => event.uid === 'cancelled@yandex');
  assert.equal(cancelled.cancelled, true);
});

test('parseCalendar: плавающее время считается временем пояса приложения, а окно режет лишнее', () => {
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:float\r\nDTSTART:20260907T090000\r\nDTEND:20260907T093000\r\nSUMMARY:Плавающее\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:late\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T093000Z\r\nSUMMARY:За окном\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const { events } = parseCalendar(text, { from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-09-08T00:00:00Z'), timeZone: 'Europe/Samara' });
  assert.equal(events.length, 1);
  // Самара — UTC+4: 09:00 местного — 05:00 UTC.
  assert.equal(events[0].start.toISOString(), '2026-09-07T05:00:00.000Z');
});

test('expandRrule: месяц по «второму вторнику» и годовой с COUNT', () => {
  const start = { wall: { year: 2026, month: 1, day: 13, hour: 10, minute: 0, second: 0 }, zone: 'UTC', allDay: false };
  const monthly = expandRrule({ freq: 'MONTHLY', interval: 1, count: null, until: null, byDay: [{ ordinal: 2, day: 2 }], byMonthDay: null, byMonth: null, weekStart: 1 }, start, { rangeStart: new Date('2026-01-01T00:00:00Z'), rangeEnd: new Date('2026-04-01T00:00:00Z') });
  assert.deepEqual(monthly.map(item => item.at.toISOString().slice(0, 10)), ['2026-01-13', '2026-02-10', '2026-03-10']);
  const yearly = expandRrule({ freq: 'YEARLY', interval: 1, count: 2, until: null, byDay: null, byMonthDay: null, byMonth: null, weekStart: 1 }, start, { rangeStart: new Date('2026-01-01T00:00:00Z'), rangeEnd: new Date('2030-01-01T00:00:00Z') });
  assert.deepEqual(yearly.map(item => item.at.toISOString().slice(0, 10)), ['2026-01-13', '2027-01-13']);
});

test('buildEvent: VEVENT в UTC читается обратно тем же разбором', () => {
  const ics = buildEvent({ uid: 'kizuna-1@kizuna', title: 'Обед; с Мариной, вкусно', description: 'строка 1\nстрока 2', start: new Date('2026-09-15T08:00:00Z'), end: new Date('2026-09-15T09:00:00Z'), now: new Date('2026-09-06T00:00:00Z') });
  assert.ok(ics.includes('SUMMARY:Обед\\; с Мариной\\, вкусно'));
  assert.ok(ics.includes('DESCRIPTION:строка 1\\nстрока 2'));
  const { events } = parseCalendar(ics, { from: new Date('2026-09-15T00:00:00Z'), to: new Date('2026-09-16T00:00:00Z') });
  assert.equal(events[0].title, 'Обед; с Мариной, вкусно');
  assert.equal(events[0].description, 'строка 1\nстрока 2');
  assert.equal(events[0].end.toISOString(), '2026-09-15T09:00:00.000Z');
  const allDay = buildEvent({ uid: 'kizuna-2@kizuna', title: 'День', start: { year: 2026, month: 9, day: 15 }, end: { year: 2026, month: 9, day: 16 }, allDay: true });
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20260915'));
});

test('пояса: стеновое время в UTC и обратно, ссылка на звонок', () => {
  const at = zonedToUtc({ year: 2026, month: 9, day: 7, hour: 11, minute: 0 }, 'Europe/Samara');
  assert.equal(at.toISOString(), '2026-09-07T07:00:00.000Z');
  assert.deepEqual(localDateTime(at, 'Europe/Samara'), { date: '2026-09-07', time: '11:00' });
  assert.equal(findJoinUrl('созвон https://meet.google.com/abc-defg-hij в 11'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(findJoinUrl('без ссылки', null), null);
});
