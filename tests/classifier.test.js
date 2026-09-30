import test from 'node:test';
import assert from 'node:assert/strict';
import { unclassifiedCapture, normalizeClassification, gateClassification, scheduleFromModel, shouldMaterializeProjections, validateCitations, makeProjections, explicitType, applyExplicitType, applyUserOverrides, parseCaptureOverrides, toTodo, actionClassification, doneOnFromModel, doneOccurredAt } from '../server/classifier.js';

const now = new Date('2026-08-21T10:00:00Z');
const zone = 'Europe/Samara';
const candidate = (overrides = {}) => ({
  entities: { projects: [], people: [], when: null, followUp: null },
  summary: 'Заметка', details: '', proposedActions: [],
  completed: false, ambiguity: null,
  ...overrides,
});
const normalize = (raw, overrides) => normalizeClassification(candidate(overrides), raw, now, 'model', zone);
const todo = (raw, overrides) => toTodo(normalize(raw, overrides), now, zone);

test('every record is a todo: the type from the model is ignored, the title and the description come from it', () => {
  for (const primaryType of ['note', 'idea_question', 'meeting_event', 'outcome_decision', 'task']) {
    const result = normalize('Разобраться с доступами Андрея', { primaryType, additionalTypes: ['task', 'note'], summary: 'Разобраться с доступами Андрея', details: '  Нужны доступы к ГитЛабу и Хабу.  ' });
    assert.equal(result.primaryType, 'task', primaryType);
    assert.deepEqual(result.additionalTypes, [], primaryType);
    assert.equal(result.details, 'Нужны доступы к ГитЛабу и Хабу.');
    assert.equal(result.claims.find(item => item.field === 'type').value, 'task');
    assert.deepEqual(makeProjections('capture', result, 'undo').map(item => item.projectionType), ['task']);
  }
});

test('finished work stays a todo with the completed flag and the day it happened, no deadline', () => {
  const result = normalize('дорабатывал работу context mcp - прогонял луп', { summary: 'Доработка context mcp', completed: true, entities: { projects: [], people: [], when: { date: '2026-08-20', time: null }, followUp: null } });
  assert.equal(result.primaryType, 'task');
  assert.equal(result.completed, true);
  assert.equal(result.summary, 'Доработка context mcp');
  assert.equal(result.entities.schedule, null);
  assert.deepEqual(result.entities.doneOn, { date: '2026-08-20', time: null });
  const settled = toTodo(result, now, zone);
  assert.equal(settled.entities.schedule, null, 'у сделанного срок по умолчанию не ставится');
  assert.equal(settled.completed, true);
});

test('without a named date the todo lands on today, a named date wins, a bare time lands on today', () => {
  const none = todo('позвонить в банк');
  assert.equal(none.entities.schedule.date, '2026-08-21');
  assert.equal(none.entities.schedule.time, null);
  assert.equal(none.claims.find(item => item.field === 'schedule').value.date, '2026-08-21');
  const named = todo('позвонить в банк в пятницу', { entities: { projects: [], people: [], when: { date: '2026-08-28', time: '10:00' }, followUp: null } });
  assert.equal(named.entities.schedule.date, '2026-08-28');
  assert.equal(named.entities.schedule.time, '10:00');
  const timeOnly = todo('позвонить в банк в 15:00', { entities: { projects: [], people: [], when: { date: null, time: '15:00' }, followUp: null } });
  assert.equal(timeOnly.entities.schedule.date, '2026-08-21');
  assert.equal(timeOnly.entities.schedule.time, '15:00');
  // Сегодня считается по поясу журнала, а не по UTC.
  const lateUtc = toTodo(normalize('позвонить'), new Date('2026-08-21T22:30:00Z'), zone);
  assert.equal(lateUtc.entities.schedule.date, '2026-08-22');
});

test('the old question «is it a task or a note?» is never asked, other questions stay', () => {
  const typeQuestion = todo('позвонить', { ambiguity: { field: 'type', question: 'Это дело или заметка?' } });
  assert.equal(typeQuestion.ambiguity, null);
  assert.equal(gateClassification(typeQuestion).level, 'high');
  const schedule = todo('Завтра и послезавтра созвон по Hub', { ambiguity: { field: 'schedule', question: 'Какая из двух дат верна?' } });
  assert.equal(schedule.conflicts.schedule, true);
  const review = gateClassification(schedule);
  assert.equal(review.level, 'conflict');
  assert.equal(review.question, 'Какая из двух дат верна?');
  assert.equal(shouldMaterializeProjections(schedule), false);
});

test('proposed actions are kept and grounded; a child action is a todo for today too', () => {
  const result = normalize('созвонились с Аней. Решили допинать бот детектор и карусель', { proposedActions: [{ type: 'task', title: 'допинать бот детектор' }, { type: 'task', title: 'выдуманное дело' }] });
  assert.deepEqual(result.proposedActions, [{ type: 'task', title: 'допинать бот детектор' }]);
  const child = actionClassification('допинать бот детектор', result, now, zone);
  assert.equal(child.primaryType, 'task');
  assert.equal(child.entities.schedule.date, '2026-08-21');
  assert.equal(child.completed, false);
});

test('ungrounded people and projects are rejected, grounded ones pass', () => {
  const result = normalize('обсудили перспективы ИИ с Худояровым по Hub', {
    entities: { projects: ['Hub', 'Секретный'], people: ['Худояров', 'Владимир'], when: null, followUp: null },
  });
  assert.deepEqual(result.entities.projects, ['Hub']);
  assert.deepEqual(result.entities.people, ['Худояров']);
});

test('an ungrounded follow-up is dropped', () => {
  const result = normalize('заметка без действий', {
    entities: { projects: [], people: [], when: null, followUp: 'позвонить в банк' },
  });
  assert.equal(result.entities.followUp, null);
});

test('an unambiguous capture is accepted without questions', () => {
  const review = gateClassification(todo('обсудили перспективы ИИ', { completed: true }));
  assert.equal(review.level, 'high');
  assert.equal(review.question, null);
});

test('scheduleFromModel validates format and the plausibility window', () => {
  assert.equal(scheduleFromModel({ date: '2026-08-22', time: '11:00' }, now, zone).sortAt, '2026-08-22T11:00:00');
  assert.equal(scheduleFromModel({ date: '2026-08-22', time: null }, now, zone).sortAt, '2026-08-22T23:59:00');
  assert.equal(scheduleFromModel({ date: null, time: '9:30' }, now, zone).time, '09:30');
  assert.equal(scheduleFromModel({ date: '2031-01-01', time: null }, now, zone), null);
  assert.equal(scheduleFromModel({ date: 'завтра', time: null }, now, zone), null);
  assert.equal(scheduleFromModel({ date: null, time: '25:00' }, now, zone), null);
  assert.equal(scheduleFromModel(null, now, zone), null);
  assert.equal(scheduleFromModel('завтра', now, zone), null);
});

test('providers that omit the new fields still normalize safely', () => {
  const legacy = normalizeClassification({
    primaryType: 'task',
    entities: { projects: [], people: [], when: 'завтра в 11', followUp: null },
    additionalTypes: [], summary: 'Созвон', proposedActions: [],
  }, 'Завтра в 11 созвон', now, 'model', zone);
  assert.equal(legacy.completed, false);
  assert.equal(legacy.ambiguity, null);
  assert.equal(legacy.details, '');
  assert.equal(legacy.entities.schedule, null, 'строковое when игнорируется как неструктурированное');
  // Ответ без primaryType и additionalTypes — уже норма: модель типов не называет.
  const modern = normalizeClassification({ entities: { projects: [], people: [], when: null, followUp: null }, summary: 'Позвонить', proposedActions: [] }, 'Позвонить', now, 'model', zone);
  assert.equal(modern.primaryType, 'task');
});

test('a record without a parse is stored as a todo for today with its own text as the title', () => {
  const result = unclassifiedCapture('туду - позвонить в салон');
  assert.equal(result.unclassified, true);
  assert.equal(result.summary, 'туду - позвонить в салон');
  const settled = toTodo(result, now, zone);
  assert.equal(settled.unclassified, undefined, 'запись — уже дело, вопроса про тип нет');
  assert.equal(settled.primaryType, 'task');
  assert.equal(settled.entities.schedule.date, '2026-08-21');
  assert.equal(shouldMaterializeProjections(settled), true);
  assert.equal(gateClassification(settled).level, 'high');
});

test('citation validation is unchanged', () => {
  assert.equal(validateCitations(['a'], new Set(['a'])), true);
  assert.equal(validateCitations(['outside'], new Set(['a'])), false);
  assert.equal(validateCitations([], new Set(['a'])), false);
  assert.equal(validateCitations(['a', 'a'], new Set(['a'])), false);
});

// Слова о типе («закинь заметку», «запиши идею») больше ничего не значат: всё
// равно туду. Остаётся только «как результат / итог» — это «уже сделано».
test('words about a type do not change anything, only «as a result» means done', () => {
  const forwarded = 'закинь заметку - доработака ботдетектора войс опс - ❯ https://ai-pomogi.ru/#/call/13008 Боту смс отправили';
  for (const raw of [forwarded, 'Задача: купить молоко', 'запиши идею про кэш', 'сделай мне задачу на завтра', 'Созвон: с Ваней в 11', 'запиши как заметку', 'Дело в том, что всё сломалось', 'Итоги квартала выложены', 'обсудили и решили добавь задачу', 'закинул ссылку в заметку', 'получили 20 процентов в результате', 'как результат сработало не сразу, но потом ок'])
    assert.equal(explicitType(raw), null, raw);
  assert.equal(explicitType('Итог — договорились о релизе'), 'outcome_decision');
  assert.equal(explicitType('Результат: релиз ушёл'), 'outcome_decision');
  assert.equal(explicitType('Доработал ТСАМ нов правила + авторелиз - только поставь это на пятницу как результат'), 'outcome_decision');
  assert.equal(explicitType('оформи это как итог'), 'outcome_decision');

  const open = normalize(forwarded, { summary: 'Доработка ботдетектора' });
  assert.equal(applyExplicitType(open, forwarded, now, zone), open, 'без слов о результате разбор не переписывается');
  const marked = normalize('Итог — договорились о релизе', { summary: 'Договорились о релизе' });
  const settled = applyExplicitType(marked, 'Итог — договорились о релизе', now, zone);
  assert.equal(settled.completed, true);
  assert.equal(settled.primaryType, 'task');
  const already = normalize('Итог — релиз ушёл', { completed: true });
  assert.equal(applyExplicitType(already, 'Итог — релиз ушёл', now, zone), already);
  const unclassified = applyExplicitType(unclassifiedCapture('запиши как результат: проверил бэкапы'), 'запиши как результат: проверил бэкапы', now, zone);
  assert.equal(unclassified.completed, true);
});

// «Доработал TCAM нов правила + авторелиз — только поставь это на пятницу как
// результат»: у сделанного нет срока, но есть день, когда это было. Раньше
// дата отбрасывалась вместе со сроком, и запись, набранная в субботу ночью,
// ложилась в субботнее «Что делал».
test('a done record keeps the day it happened instead of a deadline', () => {
  const saturdayNight = new Date('2026-09-25T22:32:00Z'); // 26.09 02:32 по Самаре
  const raw = 'Доработал TCAM нов правила + авторелиз - только поставь это на пятницу как результат';
  const done = normalizeClassification(candidate({ summary: 'Доработал TCAM: новые правила и авторелиз', completed: true, entities: { projects: ['TCAM'], people: [], when: { date: '2026-09-25', time: null }, followUp: null } }), raw, saturdayNight, 'model', zone);
  assert.equal(done.primaryType, 'task');
  assert.equal(done.completed, true);
  assert.equal(done.entities.schedule, null, 'срока у сделанного нет');
  assert.deepEqual(done.entities.doneOn, { date: '2026-09-25', time: null });
  // Будущая дата у сделанного — ошибка разбора («в пятницу» разрешили вперёд).
  assert.equal(doneOnFromModel({ date: '2026-10-02', time: null }, saturdayNight, zone), null);
  assert.deepEqual(doneOnFromModel({ date: '2026-09-25', time: '18:00', end: '19:00', repeat: { freq: 'weekly', interval: 1 } }, saturdayNight, zone), { date: '2026-09-25', time: '18:00' });
  // У недоделанного when остаётся сроком, дня сделанного нет.
  const open = normalize('доработать TCAM в пятницу', { entities: { projects: [], people: [], when: { date: '2026-08-28', time: null }, followUp: null } });
  assert.equal(open.entities.doneOn, undefined);
  assert.equal(open.entities.schedule.date, '2026-08-28');
});

test('the moment of a done record shifts the date and keeps the clock unless a time was named', () => {
  const typedAt = '2026-09-25T22:32:10.000Z'; // суббота 02:32:10 по Самаре
  assert.equal(doneOccurredAt({ date: '2026-09-25', time: null }, typedAt, zone), '2026-09-24T22:32:10.000Z', 'пятница 02:32:10 по Самаре');
  assert.equal(doneOccurredAt({ date: '2026-09-25', time: '18:00' }, typedAt, zone), '2026-09-25T14:00:00.000Z', 'пятница 18:00 по Самаре');
  assert.equal(doneOccurredAt({ date: '2026-09-25', time: null }, '2026-09-25T20:15:00.000Z', 'Pacific/Honolulu'), '2026-09-25T20:15:00.000Z', 'тот же день — момент не меняется');
  assert.equal(doneOccurredAt(null, typedAt, zone), null);
  assert.equal(doneOccurredAt({ date: 'вчера' }, typedAt, zone), null);
});

test('naming the result turns a model deadline into the day it happened', () => {
  const saturdayNight = new Date('2026-09-25T22:32:00Z');
  const raw = 'в пятницу доработал TCAM — поставь как результат';
  const asTodo = normalizeClassification(candidate({ summary: 'Доработать TCAM', entities: { projects: ['TCAM'], people: [], when: { date: '2026-09-25', time: null }, followUp: null } }), raw, saturdayNight, 'model', zone);
  assert.equal(asTodo.entities.schedule.date, '2026-09-25');
  const settled = applyExplicitType(asTodo, raw, saturdayNight, zone);
  assert.equal(settled.primaryType, 'task');
  assert.equal(settled.completed, true);
  assert.equal(settled.entities.schedule, null);
  assert.deepEqual(settled.entities.doneOn, { date: '2026-09-25', time: null });
  assert.equal(settled.claims.find(item => item.field === 'schedule').confidence, 0);
  // Срок в будущем у «результата» отбрасывается целиком: дня сделанного нет.
  const futureRaw = 'доработать TCAM 2 октября как результат';
  const future = applyExplicitType(normalizeClassification(candidate({ entities: { projects: [], people: [], when: { date: '2026-10-02', time: null }, followUp: null } }), futureRaw, saturdayNight, 'model', zone), futureRaw, saturdayNight, zone);
  assert.equal(future.entities.schedule, null);
  assert.equal(future.entities.doneOn, undefined);
});

test('request overrides: type is ignored, due, priority and tags work for any record', () => {
  const parsed = parseCaptureOverrides({ primaryType: 'note', due: { date: '2026-08-25', time: '10:00' }, priority: 'high', tags: ['Работа', '#дом'] }, now, zone);
  assert.deepEqual(parsed.overrides, { due: { date: '2026-08-25', time: '10:00' }, priority: 'high', tags: ['работа', 'дом'] });
  assert.deepEqual(parseCaptureOverrides({ primaryType: 'whatever' }, now, zone), { overrides: null });
  assert.equal(parseCaptureOverrides({ due: { date: 'вчера' } }, now, zone).error, 'invalid_due');
  assert.equal(parseCaptureOverrides({ priority: 'urgent' }, now, zone).error, 'invalid_priority');
  const applied = applyUserOverrides(todo('позвонить в банк'), parsed.overrides, now, zone);
  assert.equal(applied.entities.schedule.date, '2026-08-25');
  assert.equal(applied.priority, 'high');
  assert.deepEqual(applied.tags, ['работа', 'дом']);
  // Внутренний путь «итог к делу»: запись уже сделана, срок превращается в день сделанного.
  const outcome = applyUserOverrides(todo('доработал TCAM'), { completed: true }, now, zone);
  assert.equal(outcome.completed, true);
  assert.equal(outcome.entities.schedule, null);
  assert.deepEqual(outcome.entities.doneOn, { date: '2026-08-21', time: null });
});
