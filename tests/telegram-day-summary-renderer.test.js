import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDaySummary, renderDaySummaryMessage } from '../server/telegram-day-summary-renderer.js';

const sample = () => ({
  date: '2026-10-03', timeZone: 'Europe/Samara', phase: 'evening',
  done: [{ title: 'Допилить функции в Кизуне' }],
  remaining: [{ title: 'Допинываем карусель с генератором фраз' }],
  overdue: [], meetings: [], added: [],
  counts: { done: 1, remaining: 1, overdue: 0, meetings: 0, added: 0 },
  historyCoverage: { gaps: ['История внешних календарей неполная: изменения сохраняются с 12:13.'] },
});
const boldTexts = message => message.entities.map(entity => message.text.slice(entity.offset, entity.offset + entity.length));

test('evening report highlights verbatim task titles and omits empty sections and history caveats', () => {
  const review = sample(), message = renderDaySummaryMessage(review);
  assert.match(message.text, /^🌙 /);
  assert.ok(message.text.includes('3 октября 2026 · Самара'));
  assert.ok(message.text.includes('\n✅ Допилить функции в Кизуне\n'));
  assert.ok(message.text.includes('\n⬜ Допинываем карусель с генератором фраз\n'));
  assert.ok(boldTexts(message).includes(review.done[0].title));
  assert.ok(boldTexts(message).includes(review.remaining[0].title));
  assert.doesNotMatch(message.text, /Встречи|Добавлено за день|Просрочено: 0|По доступным данным|⚠️|12:13|неполная/);
  assert.equal(renderDaySummary(review), message.text);
});

test('morning report only attributes completion to the review date, and historical views use neutral labels', () => {
  const review = sample();
  const morning = renderDaySummaryMessage({ ...review, phase: 'morning', date: '2026-10-04', done: [], counts: { ...review.counts, done: 0 } });
  assert.match(morning.text, /^☀️ /);
  assert.ok(morning.text.includes('4 октября 2026 · Самара'));
  assert.ok(morning.text.includes('⬜ ' + review.remaining[0].title));
  assert.doesNotMatch(morning.text, /✅|Вчера|Сегодня завершено|Добавлено за день/);
  const historical = renderDaySummary({ ...review, phase: 'manual' });
  assert.ok(historical.includes('Завершено за этот день:'));
  assert.doesNotMatch(historical, /Сегодня завершено|Хорошего вечера/);
});

test('copy changes daily for both phases but repeated renders preserve the same message and task facts', () => {
  for (const phase of ['morning', 'evening']) {
    const messages = [];
    for (let day = 1; day <= 16; day++) {
      const review = { ...sample(), date: `2026-10-${String(day).padStart(2, '0')}`, phase };
      const message = renderDaySummaryMessage(review);
      assert.deepEqual(renderDaySummaryMessage(review), message);
      assert.ok(message.text.includes('✅ ' + review.done[0].title));
      assert.ok(message.text.includes('⬜ ' + review.remaining[0].title));
      if (messages.length) {
        assert.notEqual(message.text.split('\n')[0], messages.at(-1).split('\n')[0]);
        assert.notEqual(message.text.split('\n').at(-1), messages.at(-1).split('\n').at(-1));
      }
      messages.push(message.text);
    }
    assert.equal(new Set(messages).size, 16);
  }
});

test('empty reports stay warm without inventing achievements or exposing technical history', () => {
  for (const phase of ['morning', 'evening', 'manual']) {
    const text = renderDaySummary({ ...sample(), phase, done: [], remaining: [], counts: {} });
    assert.match(text, /пока/);
    assert.doesNotMatch(text, /✅|⬜|завершено|шаг вперёд|галочка|: 0|неполная|12:13|⚠️/);
  }
});

test('meeting times, omission counts and completion markers survive literal markup and Unicode formatting', () => {
  const title = '🧩 Дописать <b>отчёт</b> & [ссылку]  с пробелами';
  const review = { ...sample(),
    meetings: [{ title: 'Созвон', time: '09:30', end: '10:15' }, { title: 'Отпуск', allDay: true, end: '23:59' }],
    remaining: Array.from({ length: 40 }, () => ({ title })),
    overdue: [{ title: 'Отправить смету' }],
    added: [{ title: 'Закрытое новое дело', completed: true }, { title: 'Открытое новое дело', completed: false }],
    counts: { done: 1, remaining: 40, overdue: 1, meetings: 2, added: 2 },
  };
  const message = renderDaySummaryMessage(review);
  assert.ok(message.text.includes('🗓 09:30–10:15 · Созвон'));
  assert.ok(message.text.includes('🗓 весь день · Отпуск'));
  assert.ok(message.text.includes('⬜ ' + title));
  assert.ok(boldTexts(message).includes(title));
  assert.ok(message.text.includes('…ещё 36'));
  assert.ok(message.text.includes('✅ Закрытое новое дело'));
  assert.ok(message.text.includes('⬜ Открытое новое дело'));
  assert.doesNotMatch(message.text, /просроченных дел нет/);
  assert.equal(message.parse_mode, undefined);

  const long = { title: '😀'.repeat(2000) };
  for (const key of ['done', 'remaining', 'overdue', 'meetings', 'added']) review[key] = Array(100).fill(long);
  const bounded = renderDaySummaryMessage(review);
  assert.ok(bounded.text.length <= 3800);
  assert.doesNotMatch(bounded.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  for (const entity of bounded.entities) {
    assert.equal(entity.type, 'bold');
    assert.ok(entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= bounded.text.length);
    assert.doesNotMatch(bounded.text.slice(entity.offset, entity.offset + entity.length), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});
