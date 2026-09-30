import test from 'node:test';
import assert from 'node:assert/strict';
import { dayMetric, metricLabels, metricTitle, metricAnnouncement, metricFraction, sparkShape, addDays, METRIC_KINDS } from '../public/day-metric.js';

const TODAY = '2026-10-01';
// Тридцать дней истории, как отдаёт /api/done?only=byDay: по возрастанию дат,
// последний — сегодня. counts — числа с конца: [.., позавчера, вчера, сегодня].
const history = (counts, length = 30) => Array.from({ length }, (_, index) => ({ date: addDays(TODAY, index - (length - 1)), n: counts[counts.length - (length - index)] ?? 0 }));

test('дата сдвигается по календарю, а не по часам', () => {
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('запланировано, осталось и просрочено складываются из трёх чисел страницы', () => {
  const metric = dayMetric({ open: 2, late: 1, done: 3, byDay: history([]), today: TODAY });
  assert.equal(metric.planned, 6, 'открытые на сегодня + просроченные + закрытые сегодня');
  assert.equal(metric.done, 3);
  assert.equal(metric.left, 3, 'осталось — открытые на сегодня и просроченные');
  assert.equal(metric.late, 1);
  const empty = dayMetric({ today: TODAY });
  assert.deepEqual([empty.planned, empty.done, empty.left, empty.late, empty.week, empty.streak, empty.capped], [0, 0, 0, 0, 0, 0, false]);
});

test('за неделю — семь дней по сегодня, а сегодняшняя точка — живое число, не ответ сервера', () => {
  // сервер считает, что сегодня закрыто 5, но страница уже знает: кружок вернули, осталось 2
  const metric = dayMetric({ open: 1, late: 0, done: 2, byDay: history([9, 9, 9, 4, 0, 3, 1, 2, 5]), today: TODAY });
  assert.deepEqual(metric.spark, [9, 4, 0, 3, 1, 2, 2], 'семь точек: от шестого дня назад до сегодня');
  assert.equal(metric.spark.length, 7);
  assert.equal(metric.spark.at(-1), 2, 'последняя точка — done с клиента');
  assert.equal(metric.week, 21, 'семь дней по сегодня; седьмой день назад (там тоже 9) в неделю не входит');
  // дни без записей в истории — нули
  const sparse = dayMetric({ done: 1, byDay: [{ date: addDays(TODAY, -1), n: 2 }, { date: TODAY, n: 7 }], today: TODAY });
  assert.deepEqual(sparse.spark, [0, 0, 0, 0, 0, 2, 1]);
});

test('серия: назад от сегодня, пока в каждом дне есть закрытое', () => {
  const metric = dayMetric({ done: 1, byDay: history([0, 2, 1, 3, 1]), today: TODAY });
  assert.equal(metric.streak, 4, 'сегодня и три дня до него; день с нулём обрывает серию');
  assert.equal(metric.capped, false);
  const broken = dayMetric({ done: 1, byDay: history([5, 0, 1, 1, 1]), today: TODAY });
  assert.equal(broken.streak, 3, 'ноль три дня назад обрывает серию, что бы ни было раньше');
  const alone = dayMetric({ done: 4, byDay: history([3, 0, 4]), today: TODAY });
  assert.equal(alone.streak, 1, 'вчера пусто: серия из одного сегодняшнего дня');
});

test('серия: если сегодня ещё ничего не закрыто, она считается от вчера и не обрывается', () => {
  const metric = dayMetric({ done: 0, byDay: history([0, 2, 1, 3, 0]), today: TODAY });
  assert.equal(metric.streak, 3, 'вчера, позавчера, день до него; сегодняшний ноль серию не рвёт');
  const lost = dayMetric({ done: 0, byDay: history([4, 4, 0, 0]), today: TODAY });
  assert.equal(lost.streak, 0, 'ни сегодня, ни вчера — серии нет');
  const fresh = dayMetric({ done: 0, byDay: history([]), today: TODAY });
  assert.equal(fresh.streak, 0);
  // закрыли первое дело дня — серия растёт на единицу, сервера ждать не нужно
  const before = dayMetric({ done: 0, byDay: history([0, 2, 1]), today: TODAY }).streak;
  const after = dayMetric({ done: 1, byDay: history([0, 2, 1]), today: TODAY }).streak;
  assert.equal(after, before + 1);
});

test('серия, упёршаяся в начало окна, помечена capped: настоящая длина неизвестна', () => {
  const all = dayMetric({ done: 1, byDay: history(Array(30).fill(1)), today: TODAY });
  assert.equal(all.streak, 30);
  assert.equal(all.capped, true);
  assert.equal(metricLabels(all).streak.text, '30+');
  // сегодня ноль: считается от вчера, окно для серии — двадцать девять дней
  const fromYesterday = dayMetric({ done: 0, byDay: history([...Array(29).fill(2), 0]), today: TODAY });
  assert.equal(fromYesterday.streak, 29);
  assert.equal(fromYesterday.capped, true);
  assert.equal(metricLabels(fromYesterday).streak.text, '29+');
  // серия ровно до второго дня окна — не capped: до начала ещё день, и в нём пусто
  const short = dayMetric({ done: 1, byDay: history([0, ...Array(29).fill(1)]), today: TODAY });
  assert.equal(short.streak, 29);
  assert.equal(short.capped, false);
});

test('без истории страница не выдумывает прошлое: неделя и серия — только сегодня', () => {
  const metric = dayMetric({ open: 1, done: 2, byDay: null, today: TODAY });
  assert.deepEqual(metric.spark, [0, 0, 0, 0, 0, 0, 2]);
  assert.equal(metric.week, 2);
  assert.equal(metric.streak, 1);
  assert.equal(metric.capped, false);
});

test('подписи: фразы для читалки экрана склоняются, подсказка говорит, что сделает нажатие', () => {
  const labels = metricLabels(dayMetric({ open: 4, late: 2, done: 2, byDay: history([1, 1, 1, 1, 1, 1, 2]), today: TODAY }));
  assert.deepEqual(METRIC_KINDS, ['planned', 'done', 'left', 'late', 'streak', 'week']);
  assert.deepEqual(METRIC_KINDS.map(kind => labels[kind].caption), ['запланировано', 'сделано', 'осталось', 'просрочено', 'серия', 'за неделю']);
  assert.equal(labels.planned.aria, 'запланировано 8');
  assert.equal(labels.done.aria, 'сделано 2 из 8');
  assert.equal(labels.left.aria, 'осталось 6');
  assert.equal(labels.late.aria, 'просрочено 2');
  assert.equal(labels.streak.aria, 'серия 7 дней');
  assert.equal(labels.week.aria, 'за неделю 8 дел');
  assert.equal(labels.done.tip, 'Сделано 2 из 8');
  const one = metricLabels(dayMetric({ open: 0, late: 1, done: 1, byDay: history([1, 1]), today: TODAY }));
  assert.equal(one.streak.aria, 'серия 2 дня');
  assert.equal(one.week.aria, 'за неделю 2 дела');
  assert.equal(metricLabels(dayMetric({ done: 1, byDay: history([]), today: TODAY })).streak.aria, 'серия 1 день');
  assert.equal(metricLabels(dayMetric({ done: 1, byDay: history([]), today: TODAY })).week.aria, 'за неделю 1 дело');
  assert.equal(metricTitle(labels.late), 'Просрочено: 2 · нажмите — только просроченные');
  assert.equal(metricTitle(labels.late, { pressed: true }), 'Просрочено: 2 · нажмите ещё раз — снять фильтр');
  assert.equal(metricTitle(labels.streak, { pressed: true }), 'Серия: 7 дней подряд · нажмите ещё раз — искра нарисуется заново');
  const capped = metricLabels(dayMetric({ done: 1, byDay: history(Array(30).fill(1)), today: TODAY }));
  assert.equal(capped.streak.aria, 'серия 30 дней и больше');
  assert.equal(capped.streak.tip, 'Серия: 30+ дней подряд');
});

test('на «Доске» нажатие говорит про колонки, а не про список дня', () => {
  const metric = dayMetric({ open: 2, late: 1, done: 1, byDay: history([]), today: TODAY });
  const today = metricLabels(metric);
  const board = metricLabels(metric, { place: 'board' });
  assert.equal(metricTitle(board.late), 'Просрочено: 1 · нажмите — только просроченные');
  assert.equal(metricTitle(board.done), 'Сделано 1 из 4 · нажмите — подсветить колонку «Закрыто»');
  assert.equal(metricTitle(board.done, { pressed: true }), 'Сделано 1 из 4 · нажмите ещё раз — снять подсветку');
  assert.equal(metricTitle(board.left), 'Осталось дел: 3 · нажмите — приглушить «Закрыто»');
  assert.equal(metricTitle(board.planned), 'Запланировано на сегодня: 4 · нажмите — показать всё');
  assert.equal(metricTitle(today.done), 'Сделано 1 из 4 · нажмите — вкладка «Закрыто»', 'на «Сегодня» — как было');
  // числа и фразы для читалки экрана у мест одни
  for (const kind of METRIC_KINDS) { assert.equal(board[kind].text, today[kind].text); assert.equal(board[kind].aria, today[kind].aria); }
});

test('объявление для читалки экрана и доля для полоски', () => {
  const metric = dayMetric({ open: 2, late: 1, done: 1, today: TODAY });
  assert.equal(metricAnnouncement(metric), 'Сделано 1 из 4, осталось 3, просрочено 1');
  assert.equal(metricFraction(metric), 0.25);
  assert.equal(metricFraction(dayMetric({ today: TODAY })), 0, 'пустой день — полоска пуста, а не NaN');
  assert.equal(metricFraction({ planned: 2, done: 3 }), 1, 'доля не выше единицы');
});

test('искра: семь точек в рамке, нули на дне, последняя точка — сегодняшняя', () => {
  const shape = sparkShape([0, 2, 4, 2, 0, 1, 4], 44, 18);
  assert.match(shape.line, /^M2\.5,15\.5 L/);
  assert.equal(shape.line.split(' ').length, 7);
  assert.deepEqual(shape.dot, { x: 41.5, y: 2.5, r: 2.4 }, 'максимум — у верхнего поля, последняя точка сидит на конце линии');
  assert.ok(shape.area.endsWith('L41.5,18 L2.5,18 Z'), 'площадь замкнута по нижнему краю');
  const flat = sparkShape([0, 0, 0, 0, 0, 0, 0], 44, 18);
  assert.ok(flat.line.split(' ').every(part => part.endsWith(',15.5')), 'все нули — ровная линия внизу, а не деление на ноль');
});
