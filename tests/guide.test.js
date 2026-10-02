// «Как пользоваться»: данные прогонов проверяются без браузера. Шаг без
// текста, без цели подсветки или с неизвестным действием сломает прогон уже у
// человека, а не у разработчика, поэтому форма каждого шага фиксируется здесь.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GUIDE_GROUPS, GUIDES, guideLength, demoPause } from '../public/guide-data.js';

const ACTS = new Set(['click', 'next', 'finish']);
const VIEWS = new Set(['today', 'card', 'circles', 'anna']);

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

test('у вопроса есть заголовок, подпись и либо шаги, либо список', () => {
  for (const [id, guide] of Object.entries(GUIDES)) {
    assert.ok(guide.q && guide.sum, id);
    assert.ok(Boolean(guide.steps) !== Boolean(guide.plain), `${id}: шаги или список, не оба`);
    assert.ok(guideLength(guide) >= 3, `${id}: слишком коротко`);
    if (guide.plain) assert.match(guide.go, /^#[a-z]+$/, `${id}: у списка есть раздел, куда вести`);
  }
});

test('живой прогон: каждый шаг с текстом, целью и действием, последний — «попробовать»', () => {
  for (const [id, guide] of Object.entries(GUIDES)) {
    if (!guide.steps) continue;
    guide.steps.forEach((step, i) => {
      assert.ok(step.say?.length > 20, `${id}[${i}]: текст`);
      assert.match(step.target, /^\.gd-[a-z-]+(\.[a-z-]+)?( \.gd-[a-z-]+)?$/, `${id}[${i}]: цель — класс копии интерфейса`);
      assert.ok(ACTS.has(step.act), `${id}[${i}]: действие ${step.act}`);
      assert.ok(VIEWS.has(step.state?.view), `${id}[${i}]: сцена ${step.state?.view}`);
      if (step.state.view === 'today') assert.ok(Array.isArray(step.state.entries) && Array.isArray(step.state.doneEntries), `${id}[${i}]: списки дня`);
      // Печатающаяся фраза подсвечивает стрелку только после набора: цель у
      // такого шага — стрелка, иначе подсветка уйдёт на пустое место.
      if (step.state.typing) assert.equal(step.target, '.gd-cap-send', `${id}[${i}]: печать ведёт к стрелке`);
    });
    const last = guide.steps.at(-1);
    assert.equal(last.act, 'finish', `${id}: последний шаг — выход`);
    assert.ok(last.tryText, `${id}: фраза для «попробовать по-настоящему»`);
    assert.equal(guide.steps.filter((step) => step.act === 'finish').length, 1, `${id}: выход один`);
  }
});

test('поручение требует явного обращения в начале, упоминание внутри фразы только зовёт', () => {
  const text = GUIDES.assign.steps.map((step) => step.say).join(' ');
  assert.match(text, /общего круга/);
  assert.match(text, /в самой фразе/);
  assert.match(text, /«@Аня — …» в начале открытого дела — явное поручение/);
  assert.match(text, /тире или двоеточие/);
  assert.equal(GUIDES.assign.steps.at(-1).tryText, 'Ане — прислать смету по Хабу сегодня');
});

// Цель подсветки ищется в копии интерфейса по классам. Опечатка в классе не
// ломает прогон громко: подсветки просто нет, а шаг «нажмите подсвеченное»
// нажать нечем. Поэтому каждый класс из целей должен рисоваться сценой.
test('каждая цель шага — класс, который рисует копия интерфейса в guide.js', () => {
  const source = readFileSync(new URL('../public/guide.js', import.meta.url), 'utf8');
  for (const [id, guide] of Object.entries(GUIDES)) {
    if (!guide.steps) continue;
    guide.steps.forEach((step, i) => {
      for (const token of step.target.match(/[.][a-z-]+/g)) {
        const name = token.slice(1);
        // «gd-choice-task» собирается шаблоном: `gd-choice-${id}`.
        const literal = new RegExp(`["\\s]${name}["\\s]`).test(source);
        const templated = source.includes(name.replace(/-[a-z]+$/, '-${'));
        assert.ok(literal || templated, `${id}[${i}]: класс ${name} не рисуется`);
      }
    });
  }
});

test('у вопроса свой адрес: id годится для «#guide?q=…»', () => {
  for (const id of Object.keys(GUIDES)) assert.match(id, /^[a-z]+$/);
});

// Демо идёт само, как видео: на шаге оно стоит, пока текст читают. Слишком
// коротко — не успеть прочитать, слишком долго — ролик тянется; весь прогон
// на обычной скорости укладывается примерно в минуту.
test('демо держит шаг, пока текст читают, и весь ролик укладывается примерно в минуту', () => {
  assert.equal(demoPause('коротко'), 2600);
  assert.equal(demoPause('x'.repeat(1000)), 9000);
  assert.ok(demoPause('x'.repeat(120)) < demoPause('x'.repeat(160)));
  for (const [id, guide] of Object.entries(GUIDES)) {
    if (!guide.steps) continue;
    // Сверх чтения на шаге — около полутора секунд: курсор едет и нажимает.
    const seconds = guide.steps.reduce((sum, step) => sum + demoPause(step.say) + 1500, 0) / 1000;
    assert.ok(seconds <= 75, `${id}: демо ${Math.round(seconds)} с`);
  }
});

 test('инструкция покрывает актуальные возможности и не предлагает выбор типа или голос', () => {
  for (const id of ['subtasks', 'focus', 'filters', 'report', 'ask', 'lessons']) assert.ok(GUIDES[id]);
  assert.equal(GUIDES.voice, undefined);
  assert.equal(GUIDES.outcome, undefined);
  const scene = readFileSync(new URL('../public/guide.js', import.meta.url), 'utf8');
  assert.doesNotMatch(scene, /gd-type-dots|gd-cap-voice|gd-choice/);
  assert.equal(GUIDES.report.go, '#done');
  assert.equal(GUIDES.ask.go, '#memory');
 });
