// Модель доски без браузера: наборный фильтр по полям дела и порядок колонок.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilter, readFilter, tidyFilter, activeConditions, sameFilter, matchesFilter, statusAllowsDone, readOrder, orderKeys, moveKey, FILTER_NONE, DONE_LANE } from '../public/board-model.js';

const facts = (patch = {}) => ({ col: 'c1', day: 'today', who: [], proj: [], src: 'field', status: 'open', ...patch });
const eq = (field, value) => ({ field, op: '=', value });
const ne = (field, value) => ({ field, op: '!=', value });

test('первый заход — фильтр «сегодня» из двух условий на одном поле, а не пустой', () => {
  assert.deepEqual(readFilter(null), [eq('day', 'today'), eq('day', 'late')]);
  assert.deepEqual(readFilter(undefined), defaultFilter());
  // Копии, а не общий массив: правка одного фильтра не портит умолчание.
  readFilter(null)[0].value = 'tomorrow';
  assert.equal(defaultFilter()[0].value, 'today');
});

test('пустой список в браузере — человек всё сбросил: фильтра нет, «сегодня» не возвращается', () => {
  assert.deepEqual(readFilter('[]'), []);
});

test('испорченное значение не ломает доску: фильтр по умолчанию', () => {
  for (const text of ['{oops', '{}', '"day"', '42', 'null']) assert.deepEqual(readFilter(text), defaultFilter(), text);
});

test('из сохранённого остаётся только годное: чужие поля, операторы и черновики выпадают', () => {
  const stored = JSON.stringify([
    eq('who', 'Аня'),
    { field: 'zzz', op: '=', value: 'x' },
    { field: 'day', op: '~', value: 'today' },
    { field: 'day', op: '=', value: '' },
    { field: 'proj', op: '!=' },
    'мусор',
    null,
    ne('src', 'telegram'),
  ]);
  assert.deepEqual(readFilter(stored), [eq('who', 'Аня'), ne('src', 'telegram')]);
});

test('условия одного поля стоят рядом, поля — по первому появлению; объекты те же', () => {
  const a = eq('day', 'today'), b = eq('who', 'Аня'), c = eq('day', 'late'), d = ne('who', 'Борис');
  const tidy = tidyFilter([a, b, c, d]);
  assert.deepEqual(tidy, [a, c, b, d]);
  assert.ok(tidy[0] === a && tidy[1] === c, 'условия не копируются: по ним ищут то, что двигали');
  assert.deepEqual(readFilter(JSON.stringify([a, b, c])), [a, c, b]);
});

test('черновик без значения не считается и не фильтрует', () => {
  const draft = { field: 'who', op: '=', value: '' };
  assert.deepEqual(activeConditions([eq('day', 'today'), draft]), [eq('day', 'today')]);
  assert.equal(matchesFilter([draft], facts({ who: ['Аня'] })), true);
  assert.equal(matchesFilter([draft], facts()), true);
});

test('«=» на одном поле — «или», разные поля — «и»', () => {
  const today = facts({ day: 'today' }), late = facts({ day: 'late' }), tomorrow = facts({ day: 'tomorrow' });
  const day = [eq('day', 'today'), eq('day', 'late')];
  assert.equal(matchesFilter(day, today), true);
  assert.equal(matchesFilter(day, late), true);
  assert.equal(matchesFilter(day, tomorrow), false);
  // Плюс другое поле: оба условия должны выполняться.
  const both = [...day, eq('who', 'Аня')];
  assert.equal(matchesFilter(both, facts({ day: 'late', who: ['Аня'] })), true);
  assert.equal(matchesFilter(both, facts({ day: 'late', who: ['Борис'] })), false);
  assert.equal(matchesFilter(both, facts({ day: 'tomorrow', who: ['Аня'] })), false);
});

test('«≠» — всегда «и»: каждое исключение действует само по себе', () => {
  const list = [ne('day', 'late'), ne('day', 'none')];
  assert.equal(matchesFilter(list, facts({ day: 'today' })), true);
  assert.equal(matchesFilter(list, facts({ day: 'late' })), false);
  assert.equal(matchesFilter(list, facts({ day: 'none' })), false);
  // «=» и «≠» на одном поле: подходит сегодняшнее, но не с человеком Борис.
  const mixed = [eq('day', 'today'), ne('who', 'Борис')];
  assert.equal(matchesFilter(mixed, facts({ who: ['Борис', 'Аня'] })), false, 'Борис среди людей дела — «≠ Борис» исключает');
  assert.equal(matchesFilter(mixed, facts({ who: ['Аня'] })), true);
});

test('у дела несколько людей и проектов: «=» подходит любой из них, «пусто» — когда никого', () => {
  const two = facts({ who: ['Аня', 'Борис'], proj: ['Hub'] });
  assert.equal(matchesFilter([eq('who', 'Борис')], two), true);
  assert.equal(matchesFilter([eq('who', 'Игорь')], two), false);
  assert.equal(matchesFilter([eq('who', FILTER_NONE)], two), false);
  assert.equal(matchesFilter([eq('who', FILTER_NONE)], facts()), true);
  assert.equal(matchesFilter([ne('proj', FILTER_NONE)], two), true, '«проект ≠ пусто» — у дела проект есть');
  assert.equal(matchesFilter([ne('proj', FILTER_NONE)], facts()), false);
  assert.equal(matchesFilter([eq('who', 'Аня'), eq('who', FILTER_NONE)], facts()), true, 'Аня или никого');
});

test('колонка, откуда и статус сравниваются как есть', () => {
  assert.equal(matchesFilter([eq('col', 'c1')], facts()), true);
  assert.equal(matchesFilter([eq('col', 'c2')], facts()), false);
  assert.equal(matchesFilter([eq('src', 'telegram')], facts({ src: 'telegram' })), true);
  assert.equal(matchesFilter([ne('src', 'telegram')], facts({ src: 'telegram' })), false);
  assert.equal(matchesFilter([eq('status', 'open')], facts()), true);
  assert.equal(matchesFilter([eq('status', 'open')], facts({ status: 'done' })), false);
  assert.equal(matchesFilter([eq('status', 'open'), eq('status', 'done')], facts({ status: 'done' })), true, '«=» на одном поле — «или»');
});

test('пустой фильтр пропускает всё', () => {
  assert.equal(matchesFilter([], facts({ day: 'later', status: 'done' })), true);
});

test('«Сделано» нужна, пока статус не исключает закрытое', () => {
  assert.equal(statusAllowsDone([]), true);
  assert.equal(statusAllowsDone(defaultFilter()), true, 'умолчание про день, статуса не трогает');
  assert.equal(statusAllowsDone([eq('status', 'open')]), false);
  assert.equal(statusAllowsDone([ne('status', 'done')]), false);
  assert.equal(statusAllowsDone([eq('status', 'done')]), true);
  assert.equal(statusAllowsDone([eq('status', 'open'), eq('status', 'done')]), true);
  assert.equal(statusAllowsDone([eq('who', 'Аня'), eq('status', 'open')]), false);
});

test('тот же набор условий — тот же фильтр, каким бы порядком его ни набрали', () => {
  assert.equal(sameFilter([eq('day', 'late'), eq('day', 'today')], defaultFilter()), true);
  assert.equal(sameFilter([eq('day', 'today')], defaultFilter()), false);
  assert.equal(sameFilter([], defaultFilter()), false);
  assert.equal(sameFilter([...defaultFilter(), { field: 'who', op: '=', value: '' }], defaultFilter()), true, 'черновик не в счёт');
});

test('порядок колонок: что-то не так в браузере — порядка нет, а не ошибка', () => {
  assert.deepEqual(readOrder(null), {});
  assert.deepEqual(readOrder('{oops'), {});
  assert.deepEqual(readOrder('[1,2]'), {});
  assert.deepEqual(readOrder('"day"'), {});
  assert.deepEqual(readOrder(JSON.stringify({ day: ['__done', 'today', 7, null], who: 'Аня', src: ['telegram'] })), { day: ['__done', 'today'], src: ['telegram'] });
});

test('порядок показа: сохранённые ключи как сохранено, новые — в естественном порядке после них', () => {
  const natural = [DONE_LANE, 'late', 'today', 'tomorrow', 'week', 'later', 'none'];
  // Ничего не сохранено — естественный порядок, «Сделано» первая.
  assert.deepEqual(orderKeys(undefined, natural), natural);
  assert.deepEqual(orderKeys([], natural), natural);
  // «завтра» перед «сегодня», «Сделано» на втором месте; остальное — после известных.
  assert.deepEqual(orderKeys(['late', DONE_LANE, 'tomorrow', 'today'], natural), ['late', DONE_LANE, 'tomorrow', 'today', 'week', 'later', 'none']);
  // Ушедшего ключа в показе нет, новый (человек, колонка) встаёт после известных.
  assert.deepEqual(orderKeys(['Борис', 'Аня', DONE_LANE], [DONE_LANE, 'Аня', 'Борис', 'Вера', FILTER_NONE]), ['Борис', 'Аня', DONE_LANE, 'Вера', FILTER_NONE]);
  // Повторный ключ в сохранённом не удваивает колонку.
  assert.deepEqual(orderKeys(['today', 'today', DONE_LANE], [DONE_LANE, 'today']), ['today', DONE_LANE]);
  // Пропала «Сделано» из сохранённого: она встаёт после известных, перед прочими новыми.
  assert.deepEqual(orderKeys(['b', 'a'], [DONE_LANE, 'a', 'b', 'c']), ['b', 'a', DONE_LANE, 'c']);
});

test('бросок колонки: перед целью или после неё, остальные не сдвигаются', () => {
  const order = [DONE_LANE, 'late', 'today', 'tomorrow'];
  assert.deepEqual(moveKey(order, 'tomorrow', 'today', false), [DONE_LANE, 'late', 'tomorrow', 'today']);
  assert.deepEqual(moveKey(order, DONE_LANE, 'late', true), ['late', DONE_LANE, 'today', 'tomorrow']);
  assert.deepEqual(moveKey(order, DONE_LANE, 'tomorrow', true), ['late', 'today', 'tomorrow', DONE_LANE]);
  assert.deepEqual(moveKey(order, 'late', DONE_LANE, false), ['late', DONE_LANE, 'today', 'tomorrow']);
  // На себя или на чужую колонку — без перемен; исходный список цел.
  assert.deepEqual(moveKey(order, 'late', 'late', true), order);
  assert.deepEqual(moveKey(order, 'late', 'нет-такой', true), order);
  assert.deepEqual(order, [DONE_LANE, 'late', 'today', 'tomorrow']);
});
