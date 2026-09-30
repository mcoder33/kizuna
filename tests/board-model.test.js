// Модель доски без браузера: наборный фильтр по полям дела, порядок колонок и
// колонки-группы, которые человек завёл сам.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilter, readFilter, mergeConditions, activeConditions, toggleValue, sameFilter, matchesFilter, statusAllowsDone, readOrder, orderKeys, moveKey, placeLast, readShown, FILTER_NONE, DONE_LANE } from '../public/board-model.js';

const facts = (patch = {}) => ({ col: 'c1', day: 'today', who: [], proj: [], src: 'field', status: 'open', ...patch });
// Условие из нескольких значений: «=» — любое из них, «≠» — ни одно.
const eq = (field, ...values) => ({ field, op: '=', values });
const ne = (field, ...values) => ({ field, op: '!=', values });

test('первый заход — фильтр «сегодня» одной плашкой «День = сегодня или просрочено», а не пустой', () => {
  assert.deepEqual(readFilter(null), [eq('day', 'today', 'late')]);
  assert.deepEqual(readFilter(undefined), defaultFilter());
  // Копии, а не общий массив: правка одного фильтра не портит умолчание.
  readFilter(null)[0].values.push('tomorrow');
  readFilter(null)[0].op = '!=';
  assert.deepEqual(defaultFilter(), [eq('day', 'today', 'late')]);
});

test('пустой список в браузере — человек всё сбросил: фильтра нет, «сегодня» не возвращается', () => {
  assert.deepEqual(readFilter('[]'), []);
});

test('испорченное значение не ломает доску: фильтр по умолчанию', () => {
  for (const text of ['{oops', '{}', '"day"', '42', 'null']) assert.deepEqual(readFilter(text), defaultFilter(), text);
});

test('новый формат {field, op, values} читается как есть, значения — в том порядке, как выбраны', () => {
  const stored = JSON.stringify([eq('day', 'tomorrow', 'today'), ne('who', 'Аня', 'Лёша')]);
  assert.deepEqual(readFilter(stored), [eq('day', 'tomorrow', 'today'), ne('who', 'Аня', 'Лёша')]);
  // Повтор в значениях не удваивается; пустые и чужие по типу значения выпадают.
  assert.deepEqual(readFilter(JSON.stringify([{ field: 'who', op: '=', values: ['Аня', 'Аня', '', 7, null, 'Борис'] }])), [eq('who', 'Аня', 'Борис')]);
});

test('старый формат {field, op, value} читается как условие из одного значения', () => {
  assert.deepEqual(readFilter(JSON.stringify([{ field: 'who', op: '=', value: 'Аня' }])), [eq('who', 'Аня')]);
  assert.deepEqual(readFilter(JSON.stringify([{ field: 'src', op: '!=', value: 'telegram' }])), [ne('src', 'telegram')]);
  // values важнее value, если лежат оба.
  assert.deepEqual(readFilter(JSON.stringify([{ field: 'who', op: '=', value: 'Аня', values: ['Борис'] }])), [eq('who', 'Борис')]);
});

test('старые «=» на одном поле — «или»: читаются одной плашкой, «≠» — «ни одно из»: тоже одной', () => {
  // Так выглядело прежнее умолчание: два условия на одном поле.
  const old = JSON.stringify([{ field: 'day', op: '=', value: 'today' }, { field: 'day', op: '=', value: 'late' }]);
  assert.deepEqual(readFilter(old), defaultFilter());
  const mixed = JSON.stringify([
    { field: 'who', op: '=', value: 'Аня' },
    { field: 'day', op: '!=', value: 'late' },
    { field: 'who', op: '=', value: 'Лёша' },
    { field: 'day', op: '!=', value: 'none' },
    { field: 'who', op: '!=', value: 'Борис' },
  ]);
  // Поля — по первому появлению; «=» и «≠» одного поля остаются разными условиями.
  assert.deepEqual(readFilter(mixed), [eq('who', 'Аня', 'Лёша'), ne('day', 'late', 'none'), ne('who', 'Борис')]);
  // Смысл не меняется: Аня или Лёша, не просрочено и не без срока, и не с Борисом.
  const list = readFilter(mixed);
  assert.equal(matchesFilter(list, facts({ who: ['Лёша'], day: 'today' })), true);
  assert.equal(matchesFilter(list, facts({ who: ['Лёша', 'Борис'], day: 'today' })), false);
  assert.equal(matchesFilter(list, facts({ who: ['Аня'], day: 'late' })), false);
  assert.equal(matchesFilter(list, facts({ who: ['Игорь'], day: 'today' })), false);
});

test('из сохранённого остаётся только годное: чужие поля, операторы и черновики выпадают', () => {
  const stored = JSON.stringify([
    eq('who', 'Аня'),
    { field: 'zzz', op: '=', values: ['x'] },
    { field: 'day', op: '~', values: ['today'] },
    { field: 'day', op: '=', values: [] },
    { field: 'day', op: '=', value: '' },
    { field: 'proj', op: '!=' },
    { field: 'proj', op: '=', values: 'Hub' },
    'мусор',
    null,
    ne('src', 'telegram'),
  ]);
  assert.deepEqual(readFilter(stored), [eq('who', 'Аня'), ne('src', 'telegram')]);
});

test('условия одного поля и оператора сливаются в одно: значения по «или», порядок — по первому появлению', () => {
  const a = eq('day', 'today'), b = eq('who', 'Аня'), c = eq('day', 'late', 'today'), d = ne('who', 'Борис'), e = eq('who', 'Лёша');
  assert.deepEqual(mergeConditions([a, b, c, d, e]), [eq('day', 'today', 'late'), eq('who', 'Аня', 'Лёша'), ne('who', 'Борис')]);
  // Исходные условия не портятся, объекты — новые.
  assert.deepEqual(a, eq('day', 'today'));
  assert.notEqual(mergeConditions([a])[0], a);
  // Черновик сливается с условием того же поля и оператора и ничего не приносит.
  assert.deepEqual(mergeConditions([eq('day', 'today'), eq('day')]), [eq('day', 'today')]);
  // Два черновика — один черновик.
  assert.deepEqual(mergeConditions([eq('who'), eq('who')]), [eq('who')]);
});

test('черновик без значений не считается и не фильтрует', () => {
  const draft = eq('who');
  assert.deepEqual(activeConditions([eq('day', 'today'), draft]), [eq('day', 'today')]);
  assert.equal(matchesFilter([draft], facts({ who: ['Аня'] })), true);
  assert.equal(matchesFilter([draft], facts()), true);
  assert.equal(matchesFilter([ne('who')], facts({ who: ['Аня'] })), true);
});

test('значение в списке выбранных: есть — убирается, нет — встаёт в конец', () => {
  assert.deepEqual(toggleValue(['today'], 'tomorrow'), ['today', 'tomorrow']);
  assert.deepEqual(toggleValue(['today', 'tomorrow'], 'today'), ['tomorrow']);
  assert.deepEqual(toggleValue(['today'], 'today'), []);
  const values = ['a'];
  toggleValue(values, 'b');
  assert.deepEqual(values, ['a'], 'исходный список цел');
});

test('внутри условия «=» — «или», между условиями — «и»', () => {
  const today = facts({ day: 'today' }), late = facts({ day: 'late' }), tomorrow = facts({ day: 'tomorrow' });
  const day = [eq('day', 'today', 'late')];
  assert.equal(matchesFilter(day, today), true);
  assert.equal(matchesFilter(day, late), true);
  assert.equal(matchesFilter(day, tomorrow), false);
  // Плюс другое поле: оба условия должны выполняться.
  const both = [...day, eq('who', 'Аня')];
  assert.equal(matchesFilter(both, facts({ day: 'late', who: ['Аня'] })), true);
  assert.equal(matchesFilter(both, facts({ day: 'late', who: ['Борис'] })), false);
  assert.equal(matchesFilter(both, facts({ day: 'tomorrow', who: ['Аня'] })), false);
  // Два отдельных условия — «и»: у дела должны быть оба человека (на доске такие сливаются в одно).
  const each = [eq('who', 'Аня'), eq('who', 'Борис')];
  assert.equal(matchesFilter(each, facts({ who: ['Аня'] })), false);
  assert.equal(matchesFilter(each, facts({ who: ['Аня', 'Борис'] })), true);
});

test('«≠» — «ни одно из»: одно из значений у дела исключает его; разные условия — по «и»', () => {
  const list = [ne('day', 'late', 'none')];
  assert.equal(matchesFilter(list, facts({ day: 'today' })), true);
  assert.equal(matchesFilter(list, facts({ day: 'late' })), false);
  assert.equal(matchesFilter(list, facts({ day: 'none' })), false);
  // «=» и «≠» на разных полях: подходит сегодняшнее, но не с человеком Борис.
  const mixed = [eq('day', 'today'), ne('who', 'Борис')];
  assert.equal(matchesFilter(mixed, facts({ who: ['Борис', 'Аня'] })), false, 'Борис среди людей дела — «≠ Борис» исключает');
  assert.equal(matchesFilter(mixed, facts({ who: ['Аня'] })), true);
  // «Человек ≠ Аня или Лёша»: нет ни Ани, ни Лёши.
  const nobody = [ne('who', 'Аня', 'Лёша')];
  assert.equal(matchesFilter(nobody, facts({ who: ['Борис'] })), true);
  assert.equal(matchesFilter(nobody, facts({ who: ['Борис', 'Лёша'] })), false);
  assert.equal(matchesFilter(nobody, facts({ who: ['Аня'] })), false);
});

test('у дела несколько людей и проектов: «=» подходит любой из них, «пусто» — когда никого', () => {
  const two = facts({ who: ['Аня', 'Борис'], proj: ['Hub'] });
  assert.equal(matchesFilter([eq('who', 'Борис')], two), true);
  assert.equal(matchesFilter([eq('who', 'Игорь')], two), false);
  assert.equal(matchesFilter([eq('who', FILTER_NONE)], two), false);
  assert.equal(matchesFilter([eq('who', FILTER_NONE)], facts()), true);
  assert.equal(matchesFilter([ne('proj', FILTER_NONE)], two), true, '«проект ≠ пусто» — у дела проект есть');
  assert.equal(matchesFilter([ne('proj', FILTER_NONE)], facts()), false);
  assert.equal(matchesFilter([eq('who', 'Аня', FILTER_NONE)], facts()), true, 'Аня или никого');
  assert.equal(matchesFilter([eq('who', 'Аня', FILTER_NONE)], facts({ who: ['Борис'] })), false);
});

test('колонка, откуда и статус сравниваются как есть', () => {
  assert.equal(matchesFilter([eq('col', 'c1')], facts()), true);
  assert.equal(matchesFilter([eq('col', 'c2')], facts()), false);
  assert.equal(matchesFilter([eq('col', 'c2', 'c1')], facts()), true);
  assert.equal(matchesFilter([eq('src', 'telegram')], facts({ src: 'telegram' })), true);
  assert.equal(matchesFilter([ne('src', 'telegram')], facts({ src: 'telegram' })), false);
  assert.equal(matchesFilter([eq('status', 'open')], facts()), true);
  assert.equal(matchesFilter([eq('status', 'open')], facts({ status: 'done' })), false);
  assert.equal(matchesFilter([eq('status', 'open', 'done')], facts({ status: 'done' })), true, 'значения одного условия — «или»');
});

test('пустой фильтр пропускает всё', () => {
  assert.equal(matchesFilter([], facts({ day: 'later', status: 'done' })), true);
});

test('«Закрыто» нужна, пока статус не исключает закрытое', () => {
  assert.equal(statusAllowsDone([]), true);
  assert.equal(statusAllowsDone(defaultFilter()), true, 'умолчание про день, статуса не трогает');
  assert.equal(statusAllowsDone([eq('status', 'open')]), false);
  assert.equal(statusAllowsDone([ne('status', 'done')]), false);
  assert.equal(statusAllowsDone([eq('status', 'done')]), true);
  assert.equal(statusAllowsDone([eq('status', 'open', 'done')]), true);
  assert.equal(statusAllowsDone([eq('who', 'Аня'), eq('status', 'open')]), false);
});

test('тот же набор условий — тот же фильтр, каким бы порядком его ни набрали', () => {
  assert.equal(sameFilter([eq('day', 'late', 'today')], defaultFilter()), true);
  assert.equal(sameFilter([eq('day', 'today', 'late')], defaultFilter()), true);
  assert.equal(sameFilter([eq('day', 'today'), eq('day', 'late')], defaultFilter()), true, 'два условия одного поля — то же, что одно с двумя значениями');
  assert.equal(sameFilter([eq('day', 'today')], defaultFilter()), false);
  assert.equal(sameFilter([ne('day', 'today', 'late')], defaultFilter()), false, 'оператор другой');
  assert.equal(sameFilter([], defaultFilter()), false);
  assert.equal(sameFilter([...defaultFilter(), eq('who')], defaultFilter()), true, 'черновик не в счёт');
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
  // Ничего не сохранено — естественный порядок, «Закрыто» первая.
  assert.deepEqual(orderKeys(undefined, natural), natural);
  assert.deepEqual(orderKeys([], natural), natural);
  // «завтра» перед «сегодня», «Закрыто» на втором месте; остальное — после известных.
  assert.deepEqual(orderKeys(['late', DONE_LANE, 'tomorrow', 'today'], natural), ['late', DONE_LANE, 'tomorrow', 'today', 'week', 'later', 'none']);
  // Ушедшего ключа в показе нет, новый (человек, колонка) встаёт после известных.
  assert.deepEqual(orderKeys(['Борис', 'Аня', DONE_LANE], [DONE_LANE, 'Аня', 'Борис', 'Вера', FILTER_NONE]), ['Борис', 'Аня', DONE_LANE, 'Вера', FILTER_NONE]);
  // Повторный ключ в сохранённом не удваивает колонку.
  assert.deepEqual(orderKeys(['today', 'today', DONE_LANE], [DONE_LANE, 'today']), ['today', DONE_LANE]);
  // Пропала «Закрыто» из сохранённого: она встаёт после известных, перед прочими новыми.
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

test('новая колонка встаёт в конец ряда: сразу за последней показанной, скрытые не сдвигаются', () => {
  const order = [DONE_LANE, 'late', 'today', 'tomorrow', 'week', 'later', 'none'];
  // Показаны «Закрыто», «сегодня», «завтра»; добавили «просрочено» — она последняя из показанных.
  assert.deepEqual(placeLast(order, 'late', [DONE_LANE, 'today', 'tomorrow']), [DONE_LANE, 'today', 'tomorrow', 'late', 'week', 'later', 'none']);
  // «На неделе» и так за «завтра» — остаётся на месте.
  assert.deepEqual(placeLast(order, 'week', [DONE_LANE, 'today', 'tomorrow']), order);
  // «Позже» при скрытой «на неделе» встаёт за «завтра», а «на неделе» остаётся скрытой за ней.
  assert.deepEqual(placeLast(order, 'later', [DONE_LANE, 'today', 'tomorrow']), [DONE_LANE, 'late', 'today', 'tomorrow', 'later', 'week', 'none']);
  // Ключа в порядке не было (человек, которого нет среди открытых дел): встаёт за последней показанной.
  assert.deepEqual(placeLast(['a', 'b', 'c'], 'new', ['a', 'b']), ['a', 'b', 'new', 'c']);
  // Показанных нет — в самый конец.
  assert.deepEqual(placeLast(['a', 'b'], 'new', []), ['a', 'b', 'new']);
  // Сама колонка среди показанных не в счёт; повторов в порядке нет.
  assert.deepEqual(placeLast(['a', 'b', 'c'], 'a', ['a', 'b']), ['b', 'a', 'c']);
  assert.deepEqual(placeLast(['a', 'b', 'b'], 'b', ['a']), ['a', 'b']);
  // Исходный порядок цел.
  assert.deepEqual(order, [DONE_LANE, 'late', 'today', 'tomorrow', 'week', 'later', 'none']);
});

test('колонки, заведённые человеком: что-то не так в браузере — заведённых нет, а не ошибка', () => {
  assert.deepEqual(readShown(null), {});
  assert.deepEqual(readShown(undefined), {});
  assert.deepEqual(readShown('{oops'), {});
  assert.deepEqual(readShown('[1,2]'), {});
  assert.deepEqual(readShown('"day"'), {});
  assert.deepEqual(readShown('{}'), {});
  assert.deepEqual(readShown(JSON.stringify({ day: ['week', 'week', 7, null, ''], who: 'Аня', proj: [], src: ['telegram'], col: ['c1'], zzz: ['x'] })), { day: ['week'], src: ['telegram'] });
  assert.deepEqual(readShown(JSON.stringify({ who: ['Аня', FILTER_NONE], proj: ['Hub'] })), { who: ['Аня', FILTER_NONE], proj: ['Hub'] });
});

test('порядок колонок лежит в своём ключе и прежнего формата: заведённые колонки его не меняют', () => {
  // Так порядок лежал до «+ Колонки» у групп — и так лежит теперь.
  const stored = JSON.stringify({ day: [DONE_LANE, 'late', 'tomorrow', 'today', 'week', 'later', 'none'], who: ['Борис', DONE_LANE] });
  assert.deepEqual(readOrder(stored), { day: [DONE_LANE, 'late', 'tomorrow', 'today', 'week', 'later', 'none'], who: ['Борис', DONE_LANE] });
});
