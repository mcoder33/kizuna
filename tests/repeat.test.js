import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepeat, validRepeat, validSkip, occurrenceDates, occursOn, nextOccurrence, effectiveDate, describeRepeat, scheduleDisplay, repeatRrule, dayDiff } from '../server/repeat.js';

// Повтор — свойство срока: правило {freq, interval, until}, убранные
// экземпляры — датами в skip. Разворот идёт по датам, время у всех одно.
test('правило повтора: нормальный вид, отказ на мусор, «до» и интервал', () => {
  assert.deepEqual(normalizeRepeat({ freq: 'weekly' }), { freq: 'weekly', interval: 1, until: null });
  assert.deepEqual(normalizeRepeat({ freq: 'WEEKLY', interval: 2, until: '2026-12-31' }), { freq: 'weekly', interval: 2, until: '2026-12-31' });
  assert.equal(normalizeRepeat(null), null);
  assert.equal(normalizeRepeat({ freq: 'hourly' }), undefined);
  assert.equal(normalizeRepeat({ freq: 'daily', interval: 0 }), undefined);
  assert.equal(normalizeRepeat({ freq: 'daily', interval: 100 }), undefined);
  assert.equal(normalizeRepeat({ freq: 'daily', until: '2026-02-30' }), undefined);
  assert.equal(validRepeat(undefined), true);
  assert.equal(validRepeat({ freq: 'monthly', interval: 3 }), true);
  assert.equal(validRepeat('weekly'), false);
  assert.equal(validSkip(['2026-09-14']), true);
  assert.equal(validSkip(['вчера']), false);
  assert.equal(dayDiff('2026-09-07', '2026-09-21'), 14);
});

test('разворот: неделя с убранным экземпляром, 31-е число, шаг в три дня от давней даты, год через два', () => {
  const weekly = { date: '2026-09-07', repeat: { freq: 'weekly', interval: 1 }, skip: ['2026-09-21'] };
  assert.deepEqual(occurrenceDates(weekly, '2026-09-01', '2026-10-05'), ['2026-09-07', '2026-09-14', '2026-09-28', '2026-10-05']);
  assert.equal(occursOn(weekly, '2026-09-21'), false);
  assert.equal(occursOn(weekly, '2026-09-28'), true);
  assert.equal(occursOn(weekly, '2026-09-08'), false);
  // Первый экземпляр раньше окна не даёт ничего до своей даты.
  assert.deepEqual(occurrenceDates(weekly, '2026-08-01', '2026-09-06'), []);
  // Месяц по числу: в коротких месяцах 31-го нет — экземпляр пропускается.
  assert.deepEqual(occurrenceDates({ date: '2024-01-31', repeat: { freq: 'monthly' } }, '2026-01-01', '2026-06-30'), ['2026-01-31', '2026-03-31', '2026-05-31']);
  // Ежедневный шаг в три дня, заведённый годы назад, доходит до окна.
  assert.deepEqual(occurrenceDates({ date: '2020-01-01', repeat: { freq: 'daily', interval: 3 } }, '2026-09-14', '2026-09-20'), ['2026-09-14', '2026-09-17', '2026-09-20']);
  assert.equal(nextOccurrence({ date: '2026-09-07', repeat: { freq: 'yearly', interval: 2 } }, '2026-10-01'), '2028-09-07');
  // «До» режет хвост; после «до» ближайшего экземпляра нет.
  const until = { date: '2026-09-07', repeat: { freq: 'daily', until: '2026-09-09' } };
  assert.deepEqual(occurrenceDates(until, '2026-09-01', '2026-09-30'), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.equal(nextOccurrence(until, '2026-09-10'), null);
  assert.equal(effectiveDate(until, '2026-09-08'), '2026-09-08');
  assert.equal(effectiveDate({ date: '2026-09-07' }, '2026-09-08'), '2026-09-07');
  assert.deepEqual(occurrenceDates({ date: '2026-09-07' }, '2026-09-01', '2026-09-30'), [], 'без правила разворота нет');
});

test('повтор словами, строка срока и RRULE наружу', () => {
  assert.equal(describeRepeat({ freq: 'daily' }), 'каждый день');
  assert.equal(describeRepeat({ freq: 'weekly', interval: 2, until: '2026-12-31' }), 'каждые 2 недели до 31.12.2026');
  assert.equal(describeRepeat({ freq: 'monthly', interval: 6 }), 'каждые 6 месяцев');
  assert.equal(describeRepeat(null), null);
  assert.equal(scheduleDisplay({ date: '2026-09-14', time: '10:00', end: '10:30', repeat: { freq: 'weekly' } }), '2026-09-14, 10:00–10:30, каждую неделю');
  assert.equal(scheduleDisplay({ date: '2026-09-14' }), '2026-09-14');
  assert.equal(repeatRrule({ freq: 'weekly', interval: 2 }), 'FREQ=WEEKLY;INTERVAL=2');
  assert.equal(repeatRrule({ freq: 'daily', until: '2026-12-31' }, { allDay: true }), 'FREQ=DAILY;UNTIL=20261231');
  assert.equal(repeatRrule({ freq: 'daily', until: '2026-12-31' }, { untilAt: new Date('2026-12-31T06:00:00Z') }), 'FREQ=DAILY;UNTIL=20261231T060000Z');
  assert.equal(repeatRrule(null), null);
});
