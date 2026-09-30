import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseOf, coverFor, plural, longDate, shortDate, isWeekend, MEETINGS } from '../public/today-cover.js';

const text = parts => parts.map(part => (typeof part === 'string' ? part : part.b ?? part.a?.text ?? '')).join('');
const meetings = [
  { title: 'Стендап Hub', start: 570, end: 585, joinUrl: 'https://meet.example/1', hasOutcome: true },
  { title: 'Монетизация', start: 660, end: 720, hasOutcome: true },
  { title: '1:1 с Лёшей', start: 810, end: 840, joinUrl: 'https://meet.example/2' },
  { title: 'Демо ZB', start: 900, end: 960 },
  { title: 'Ретро TCAM', start: 990, end: 1020 },
];
const tasks = { late: 3, today: 1, todayTitle: 'Ответить Кате по доступу к Метрике' };

test('фаза считается по порогам, выходной — весь день', () => {
  assert.equal(phaseOf({ minutes: 7 * 60 }), 'night');
  assert.equal(phaseOf({ minutes: 9 * 60 }), 'morning');
  assert.equal(phaseOf({ minutes: 13 * 60 }), 'day');
  assert.equal(phaseOf({ minutes: 18 * 60 }), 'evening');
  assert.equal(phaseOf({ minutes: 23 * 60 }), 'night');
  assert.equal(phaseOf({ minutes: 13 * 60, weekend: true }), 'weekend');
});

test('склонения числительных', () => {
  assert.equal(plural(1, MEETINGS), '1 встреча');
  assert.equal(plural(3, MEETINGS), '3 встречи');
  assert.equal(plural(6, MEETINGS), '6 встреч');
  assert.equal(plural(11, MEETINGS), '11 встреч');
  assert.equal(plural(22, MEETINGS), '22 встречи');
});

test('днём бриф говорит, что идёт, что дальше и что с делами', () => {
  const cover = coverFor({ phase: 'day', minutes: 822, meetings, tasks, doneCount: 4, calendar: true });
  assert.equal(text(cover.brief), 'Идёт 1:1 с Лёшей, до 14:00 — присоединиться. Потом свободно 1 ч, в 15:00 Демо ZB, потом ещё 1 встреча. 3 дела просрочены, на сегодня — ответить Кате по доступу к Метрике.');
  // Ссылка «присоединиться» ведёт на встречу, а не подставляется текстом.
  assert.equal(cover.brief.find(part => part.a).a.href, 'https://meet.example/2');
  assert.equal(cover.placeholder, 'Что нужно сделать?');
  assert.equal(cover.tab, 'day');
});

test('утро здоровается, спрашивает, с чего начать, и открывает день', () => {
  const cover = coverFor({ phase: 'morning', minutes: 540, meetings, tasks, calendar: true });
  assert.equal(text(cover.brief), 'Доброе утро. Первая встреча в 09:30 — Стендап Hub, всего 5 встреч. 3 дела просрочены, на сегодня — ответить Кате по доступу к Метрике.');
  assert.equal(cover.placeholder, 'С чего начнёте день?');
  assert.equal(cover.tab, 'day');
});

test('вечер подводит итог и спрашивает, чем закончился день', () => {
  const cover = coverFor({ phase: 'evening', minutes: 1110, meetings, tasks, doneCount: 4, calendar: true, tomorrow: { count: 3, first: { start: 600, title: 'Стендап Hub' } } });
  assert.equal(text(cover.brief), 'Сделано 4, встреч прошло 5. Не закрыто 3 дела со сроком — перенести на завтра? Завтра первая встреча в 10:00.');
  // Без просроченного, но с открытым делом без срока вечер не говорит «всё закрыто».
  const open = coverFor({ phase: 'evening', minutes: 1110, meetings: [], tasks: { late: 0, open: 1 }, doneCount: 1, calendar: false });
  assert.equal(text(open.brief), 'Сделано 1. Открыто 1 дело без срока.');
  const clear = coverFor({ phase: 'evening', minutes: 1110, meetings: [], tasks: { late: 0, open: 0 }, doneCount: 2, calendar: false });
  assert.equal(text(clear.brief), 'Сделано 2. Все дела закрыты.');
  assert.equal(cover.placeholder, 'Чем закончился день?');
  assert.equal(cover.tab, 'journal');
});

test('ночью страница говорит про завтра и просит записать и отпустить', () => {
  const cover = coverFor({ phase: 'night', minutes: 1380, meetings, tasks, doneCount: 4, calendar: true, tomorrow: { count: 3, first: { start: 600, title: 'Стендап Hub' } } });
  assert.equal(text(cover.brief), 'День закончился: сделано 4. Завтра 3 встречи, первая в 10:00 — Стендап Hub.');
  assert.equal(cover.placeholder, 'Запишите и отпустите');
  assert.equal(cover.tab, 'journal');
  const early = coverFor({ phase: 'night', minutes: 420, meetings, tasks, calendar: true });
  assert.match(text(early.brief), /^Рано\. Сегодня 5 встреч, первая в 09:30 — Стендап Hub\./);
});

test('выходной и день без календаря говорят меньше', () => {
  const weekend = coverFor({ phase: 'weekend', minutes: 822, meetings: [], tasks, calendar: true });
  assert.equal(text(weekend.brief), 'Выходной, встреч нет. 3 дела просрочено — подождут понедельника.');
  assert.equal(weekend.placeholder, 'О чём думаете?');
  const noCalendar = coverFor({ phase: 'day', minutes: 822, meetings: [], tasks, calendar: false });
  assert.equal(text(noCalendar.brief), 'Календарь не подключён — встреч не вижу. 3 дела просрочены, на сегодня — ответить Кате по доступу к Метрике.');
  const quiet = coverFor({ phase: 'day', minutes: 1300, meetings, tasks: { late: 0 }, calendar: true });
  assert.equal(text(quiet.brief), 'Встреч больше нет, прошло 5. Просроченных дел нет.');
});

test('даты подписываются по-русски и не зависят от пояса', () => {
  assert.equal(longDate('2026-09-14'), 'Понедельник, 14 сентября');
  assert.equal(shortDate('2026-09-19'), 'сб 19');
  assert.equal(isWeekend('2026-09-19'), true);
  assert.equal(isWeekend('2026-09-14'), false);
});
