import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRrule, setPartstat, parseCalendar, buildEvent, findJoinUrl, zonedToUtc, localDateTime, expandRrule, overrideInstance, excludeInstance } from '../server/ics.js';

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


test('повтор словами и ответ на приглашение прямо в файле события', () => {
  assert.equal(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'), 'Повторяется каждые 2 недели по пн, ср');
  assert.equal(describeRrule('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6'), 'Повторяется каждый месяц 15-го, 6 раз');
  assert.equal(describeRrule('FREQ=YEARLY;UNTIL=20301231T000000Z'), 'Повторяется каждый год до 31 дек 2030');
  assert.equal(describeRrule('FREQ=HOURLY'), null);
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nATTENDEE;CN=Я;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Me@Example.com\r\nATTENDEE;CN=Он:mailto:him@example.com\r\nCOMMENT:старый\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const replied = setPartstat(ics, { email: 'me@example.com', status: 'declined', comment: 'не смогу' });
  assert.ok(replied.includes('ATTENDEE;CN=Я;PARTSTAT=DECLINED:mailto:Me@Example.com'));
  assert.ok(replied.includes('ATTENDEE;CN=Он:mailto:him@example.com'), 'чужие строки не тронуты');
  assert.equal((replied.match(/COMMENT:/g) || []).length, 1);
  assert.ok(replied.includes('COMMENT:не смогу'));
  assert.equal(setPartstat(ics, { email: 'nobody@example.com', status: 'accepted' }), null);
});

test('экземпляр повтора: «только это событие» — RECURRENCE-ID в файле серии, повторное — переписывает, удаление — EXDATE', () => {
  const series = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rr', 'DTSTART;TZID=Europe/Moscow:20260902T100000', 'DTEND;TZID=Europe/Moscow:20260902T101500', 'RRULE:FREQ=WEEKLY;BYDAY=WE', 'SEQUENCE:2', 'SUMMARY:Стендап', 'X-YANDEX-FOO:bar', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
  const now = new Date('2026-09-08T10:00:00Z');
  const window = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z', timeZone: 'Europe/Moscow' };
  // 9 сентября 10:00 Москвы — 07:00Z; переносим на 12:00 Москвы (09:00Z) с новым названием.
  const moved = overrideInstance(series, { instanceKey: '2026-09-09T07:00:00.000Z', title: 'Стендап (позже)', start: new Date('2026-09-09T09:00:00Z'), end: new Date('2026-09-09T09:15:00Z'), now });
  assert.equal((moved.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(moved.includes('RECURRENCE-ID:20260909T070000Z'));
  assert.ok(moved.includes('RRULE:FREQ=WEEKLY;BYDAY=WE'), 'серия осталась');
  assert.equal((moved.match(/RRULE:/g) || []).length, 1, 'у переопределения правила нет');
  assert.equal((moved.match(/X-YANDEX-FOO:bar/g) || []).length, 2, 'чужие свойства скопированы в экземпляр');
  const read = parseCalendar(moved, window).events;
  assert.deepEqual(read.map(event => [event.title, event.start.toISOString(), event.instanceKey]), [
    ['Стендап', '2026-09-02T07:00:00.000Z', '2026-09-02T07:00:00.000Z'],
    ['Стендап (позже)', '2026-09-09T09:00:00.000Z', '2026-09-09T07:00:00.000Z'],
    ['Стендап', '2026-09-16T07:00:00.000Z', '2026-09-16T07:00:00.000Z'],
    ['Стендап', '2026-09-23T07:00:00.000Z', '2026-09-23T07:00:00.000Z'],
  ]);
  // Второй перенос того же экземпляра переписывает его блок, а не плодит третий.
  const again = overrideInstance(moved, { instanceKey: '2026-09-09T07:00:00.000Z', start: new Date('2026-09-09T11:00:00Z'), end: new Date('2026-09-09T11:15:00Z'), now });
  assert.equal((again.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((again.match(/RECURRENCE-ID:20260909T070000Z/g) || []).length, 1);
  const reread = parseCalendar(again, window).events.find(event => event.instanceKey === '2026-09-09T07:00:00.000Z');
  assert.deepEqual([reread.title, reread.start.toISOString()], ['Стендап (позже)', '2026-09-09T11:00:00.000Z']);
  // Удаление экземпляра: EXDATE у серии, переопределение убрано.
  const gone = excludeInstance(again, { instanceKey: '2026-09-09T07:00:00.000Z', now });
  assert.equal((gone.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(gone.includes('EXDATE:20260909T070000Z'));
  assert.ok(gone.includes('SEQUENCE:3'));
  assert.deepEqual(parseCalendar(gone, window).events.map(event => event.start.toISOString()), ['2026-09-02T07:00:00.000Z', '2026-09-16T07:00:00.000Z', '2026-09-23T07:00:00.000Z']);
  // Событие на весь день — RECURRENCE-ID и EXDATE датами.
  const allDay = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260902', 'RRULE:FREQ=DAILY', 'SUMMARY:Зарядка', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
  const dayMoved = overrideInstance(allDay, { instanceKey: '2026-09-03T00:00:00.000Z', allDay: true, start: { year: 2026, month: 9, day: 4 }, end: { year: 2026, month: 9, day: 5 }, now });
  assert.ok(dayMoved.includes('RECURRENCE-ID;VALUE=DATE:20260903'));
  assert.ok(dayMoved.includes('DTSTART;VALUE=DATE:20260904'));
  assert.ok(excludeInstance(allDay, { instanceKey: '2026-09-03T00:00:00.000Z', now }).includes('EXDATE;VALUE=DATE:20260903'));
  // Без серии в файле — null: правка невозможна, а не тихо сломана.
  assert.equal(overrideInstance('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { instanceKey: '2026-09-09T07:00:00.000Z', start: now, end: now }), null);
  assert.equal(excludeInstance(series, { instanceKey: 'мусор' }), null);
});

// Своя серия наружу: RRULE и EXDATE в VEVENT читаются обратно тем же
// разбором — экземпляры разворачиваются, убранный пропадает.
test('buildEvent: повтор уходит RRULE и EXDATE и разворачивается при чтении', () => {
  const start = new Date('2026-09-07T06:00:00Z'), end = new Date('2026-09-07T06:30:00Z');
  const ics = buildEvent({ uid: 'series@kizuna', title: 'Стендап', start, end, rrule: 'FREQ=WEEKLY;INTERVAL=1;UNTIL=20261005T060000Z', exdates: [new Date('2026-09-21T06:00:00Z')] });
  assert.ok(ics.includes('RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20261005T060000Z'));
  assert.ok(ics.includes('EXDATE:20260921T060000Z'));
  const { events } = parseCalendar(ics, { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z'), timeZone: 'Europe/Samara' });
  assert.deepEqual(events.map(event => event.start.toISOString()), ['2026-09-07T06:00:00.000Z', '2026-09-14T06:00:00.000Z', '2026-09-28T06:00:00.000Z', '2026-10-05T06:00:00.000Z']);
  assert.equal(events[0].repeat, 'Повторяется каждую неделю до 5 окт 2026');
  assert.ok(events.every(event => event.uid === 'series@kizuna' && event.instanceKey));
  // На весь день — датами.
  const allDay = buildEvent({ uid: 'd@kizuna', title: 'Отчёт', allDay: true, start: { year: 2026, month: 9, day: 7 }, end: { year: 2026, month: 9, day: 8 }, rrule: 'FREQ=MONTHLY', exdates: [{ year: 2026, month: 10, day: 7 }] });
  assert.ok(allDay.includes('RRULE:FREQ=MONTHLY') && allDay.includes('EXDATE;VALUE=DATE:20261007'));
});
