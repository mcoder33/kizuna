// «Как пользоваться»: данные прогонов проверяются без браузера. Шаг без
// текста, с неизвестным действием или с целью не той формы сломает прогон уже
// у человека, а не у разработчика, поэтому форма каждого шага фиксируется здесь.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_GROUPS, GUIDES, isHandsOn } from '../public/guide-data.js';

const ACTS = new Set(['click', 'next', 'capture', 'finish']);
const PAGES = new Set(['#today', '#board', '#circles', '#calendar', '#notes', '#reports', '#memory', '#settings']);

function targetOk(spec) {
  if (spec === null) return true;
  if (Array.isArray(spec)) return spec.length > 0 && spec.every((item) => typeof item === 'string' && targetOk(item));
  if (typeof spec === 'string') return /^[#.@\[][^\s]/.test(spec);
  return typeof spec === 'object' && (typeof spec.legend === 'string' || typeof spec.prop === 'string');
}

test('каждый вопрос из групп существует, и каждый вопрос стоит ровно в одной группе', () => {
  const seen = new Map();
  for (const group of GUIDE_GROUPS) for (const id of group.items) {
    assert.ok(GUIDES[id], `нет вопроса ${id}`);
    assert.equal(seen.get(id), undefined, `вопрос ${id} в двух группах`);
    seen.set(id, group.id);
    assert.equal(GUIDES[id].group, group.id);
  }
  for (const id of Object.keys(GUIDES)) assert.ok(seen.has(id), `вопрос ${id} не в группе`);
});

test('у каждого шага есть текст, действие и цель нужной формы; первый шаг знает раздел, последний — выход', () => {
  for (const [id, guide] of Object.entries(GUIDES)) {
    assert.ok(guide.q && guide.sum, id);
    assert.ok(guide.steps.length >= 2, `${id}: слишком коротко`);
    assert.ok(PAGES.has(guide.steps[0].page), `${id}: первый шаг без раздела`);
    guide.steps.forEach((step, i) => {
      const says = [step.say].flat();
      assert.ok(says.every((text) => typeof text === 'string' && text.length > 20), `${id}[${i}]: текст`);
      assert.ok(ACTS.has(step.act), `${id}[${i}]: действие ${step.act}`);
      assert.ok('target' in step && targetOk(step.target), `${id}[${i}]: цель ${JSON.stringify(step.target)}`);
      if (Array.isArray(step.say)) assert.equal(step.say.length, step.target.length, `${id}[${i}]: текстов столько же, сколько целей`);
      if (step.page) assert.ok(PAGES.has(step.page), `${id}[${i}]: раздел ${step.page}`);
      if (step.tab) assert.ok([step.tab].flat().every((tab) => /^#tab-/.test(tab)), `${id}[${i}]: вкладка`);
      // Пример подставляется только там, где ждут отправку: иначе фраза
      // останется в поле без объяснения.
      if (step.prefill) assert.equal(step.act, 'capture', `${id}[${i}]: пример без отправки`);
      if (step.act === 'capture') assert.ok(step.prefill && step.page === '#today', `${id}[${i}]: отправка — с примером и на «Сегодня»`);
      // «@new» появляется только после шага с отправкой.
      if (String(step.target).includes('@new')) assert.ok(guide.steps.slice(0, i).some((prev) => prev.act === 'capture'), `${id}[${i}]: «@new» раньше отправки`);
      // Цель, которой может не быть, приходит с запасным текстом.
      if (typeof step.target === 'string' && step.target.startsWith('@new')) assert.ok(step.missing, `${id}[${i}]: нужен текст на случай, если запись не видна`);
      if (step.target && typeof step.target === 'object' && !Array.isArray(step.target) && step.target.prop) assert.ok(step.missing, `${id}[${i}]: строка карточки может отсутствовать`);
    });
    assert.equal(guide.steps.at(-1).act, 'finish', `${id}: последний шаг — выход`);
    assert.equal(guide.steps.filter((step) => step.act === 'finish').length, 1, `${id}: выход один`);
  }
});

test('четыре вопроса проходятся руками, и среди них поручение', () => {
  const hands = Object.keys(GUIDES).filter((id) => isHandsOn(GUIDES[id]));
  assert.deepEqual(hands.sort(), ['assign', 'fix', 'outcome', 'todo']);
});

test('вопрос про поручение говорит правду: общий круг, имя в фразе, «@» не поручает', () => {
  const text = GUIDES.assign.steps.flatMap((step) => [step.say].flat()).join(' ');
  assert.match(text, /общего круга/);
  assert.match(text, /в самой фразе/);
  assert.match(text, /«@Имя»[^.]*призыв/);
  assert.equal(GUIDES.assign.steps[1].prefill, 'Ане — прислать смету по Хабу до пятницы');
});
