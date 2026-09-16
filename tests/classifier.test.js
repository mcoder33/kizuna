import test from 'node:test';
import assert from 'node:assert/strict';
import { unclassifiedCapture, normalizeClassification, gateClassification, scheduleFromModel, shouldMaterializeProjections, validateCitations, settleCompleted, makeProjections } from '../server/classifier.js';

const now = new Date('2026-08-21T10:00:00Z');
const zone = 'Europe/Samara';
const candidate = (overrides = {}) => ({
  primaryType: 'note',
  entities: { projects: [], people: [], when: null, followUp: null },
  additionalTypes: [], summary: 'Заметка', proposedActions: [],
  completed: false, ambiguity: null,
  ...overrides,
});
const normalize = (raw, overrides) => normalizeClassification(candidate(overrides), raw, now, 'model', zone);

test('type, summary and completion come from the model without text rules', () => {
  const result = normalize('дорабатывал работу context mcp - прогонял луп', {
    primaryType: 'note', summary: 'Доработка context mcp', completed: true, additionalTypes: ['task'],
  });
  assert.equal(result.primaryType, 'note');
  assert.equal(result.completed, true);
  assert.equal(result.summary, 'Доработка context mcp');
  assert.deepEqual(result.additionalTypes, [], 'отчёт о сделанном не открывает задачу');
});

test('a model task additionalType survives only with a grounded follow-up', () => {
  const without = normalize('Решили по TCAM', { primaryType: 'outcome_decision', additionalTypes: ['task'] });
  assert.deepEqual(without.additionalTypes, []);
  const with_ = normalize('Решили по TCAM, нужно отправить протокол', {
    primaryType: 'outcome_decision', additionalTypes: ['task'],
    entities: { projects: [], people: [], when: null, followUp: 'отправить протокол' },
  });
  assert.deepEqual(with_.additionalTypes, ['task']);
  assert.equal(with_.entities.followUp, 'отправить протокол');
});

test('the model resolves relative dates itself and the result is kept', () => {
  const result = normalize('созвониться с Даниилом сегодня', {
    primaryType: 'task',
    entities: { projects: [], people: ['Даниил'], when: { date: '2026-08-21', time: null }, followUp: null },
  });
  assert.equal(result.entities.schedule.date, '2026-08-21');
  assert.deepEqual(result.entities.people, ['Даниил'], 'падеж нормализует модель');
});

test('a schedule is ignored for types that cannot be scheduled and for finished work', () => {
  const note = normalize('заметка про 22.08', { primaryType: 'note', entities: { projects: [], people: [], when: { date: '2026-08-22', time: null }, followUp: null } });
  assert.equal(note.entities.schedule, null);
  const done = normalize('созвон прошёл', { primaryType: 'meeting_event', completed: true, entities: { projects: [], people: [], when: { date: '2026-08-21', time: '11:00' }, followUp: null } });
  assert.equal(done.entities.schedule, null);
});

// «Обсудили орг вопросы с Даниилом» модель отметила состоявшимся, но назвала
// встречей — и в «Что делал» у записи висел кружок «Готово» с «без срока».
test('finished work is an outcome, never an open meeting or task', () => {
  for (const primaryType of ['meeting_event', 'task']) {
    const result = normalize('Обсудили орг вопросы с Даниилом', {
      primaryType, completed: true, entities: { projects: [], people: ['Даниил'], when: null, followUp: null },
    });
    assert.equal(result.primaryType, 'outcome_decision', primaryType);
    assert.equal(result.claims.find(item => item.field === 'type').value, 'outcome_decision');
    assert.deepEqual(makeProjections('capture', result, 'undo').map(item => item.projectionType), ['outcome_decision']);
  }
  const upcoming = normalize('Обсудить орг вопросы с Даниилом', { primaryType: 'meeting_event' });
  assert.equal(upcoming.primaryType, 'meeting_event', 'предстоящая встреча остаётся встречей');
  assert.equal(settleCompleted(upcoming), upcoming, 'незавершённое не трогается');
  // Уточнение и голос приходят с готовой классификацией — правило то же.
  const corrected = settleCompleted({ ...upcoming, completed: true, additionalTypes: ['task', 'note'] });
  assert.equal(corrected.primaryType, 'outcome_decision');
  assert.deepEqual(corrected.additionalTypes, ['note']);
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

test('model ambiguity gates the capture and blocks projections', () => {
  const conflict = normalize('Завтра и послезавтра созвон по Hub', {
    primaryType: 'meeting_event',
    ambiguity: { field: 'schedule', question: 'Какая из двух дат верна?' },
  });
  assert.equal(conflict.conflicts.schedule, true);
  const review = gateClassification(conflict);
  assert.equal(review.level, 'conflict');
  assert.equal(review.question, 'Какая из двух дат верна?');
  assert.equal(shouldMaterializeProjections(conflict), false);
});

test('a non-scheduling ambiguity asks without declaring a conflict', () => {
  const result = normalize('позвонить', { primaryType: 'task', ambiguity: { field: 'type', question: null } });
  assert.equal(result.conflicts.schedule, false);
  const review = gateClassification(result);
  assert.equal(review.level, 'low');
  assert.equal(review.safeNote, true);
  assert.equal(shouldMaterializeProjections(result), true);
});

test('an unambiguous capture is accepted without questions', () => {
  const review = gateClassification(normalize('обсудили перспективы ИИ', { completed: true }));
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
  assert.equal(legacy.entities.schedule, null, 'строковое when игнорируется как неструктурированное');
});

test('an unclassified capture is stored, gated and never projected', () => {
  const result = unclassifiedCapture('туду - позвонить в салон');
  assert.equal(result.unclassified, true);
  assert.equal(result.summary, 'туду - позвонить в салон');
  assert.equal(result.entities.schedule, null);
  assert.equal(shouldMaterializeProjections(result), false);
  const review = gateClassification(result);
  assert.equal(review.level, 'low');
  assert.equal(review.field, 'type');
});

test('citation validation is unchanged', () => {
  assert.equal(validateCitations(['a'], new Set(['a'])), true);
  assert.equal(validateCitations(['outside'], new Set(['a'])), false);
  assert.equal(validateCitations([], new Set(['a'])), false);
  assert.equal(validateCitations(['a', 'a'], new Set(['a'])), false);
});
