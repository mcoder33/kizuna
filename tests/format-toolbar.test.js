import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleWrap, applyColor, turnInto, blockKindOf } from '../public/format-toolbar.js';
import { decorateLine } from '../public/markdown-live.js';
import { renderInlineMarkdown } from '../public/markdown.js';

test('парный маркер ставится вокруг выделения и снимается повторным нажатием', () => {
  const wrapped = toggleWrap('купить молоко', 7, 13, '**');
  assert.equal(wrapped.line, 'купить **молоко**');
  assert.deepEqual([wrapped.from, wrapped.to], [9, 15]);
  // Выделение осталось на тексте — второе нажатие снимает маркеры.
  const back = toggleWrap(wrapped.line, wrapped.from, wrapped.to, '**');
  assert.equal(back.line, 'купить молоко');
  assert.deepEqual([back.from, back.to], [7, 13]);
  // Захватили маркеры вместе с текстом — тоже снимается.
  const whole = toggleWrap('купить **молоко**', 7, 17, '**');
  assert.equal(whole.line, 'купить молоко');
});

test('пробелы по краям выделения остаются снаружи маркеров', () => {
  const result = toggleWrap('a  слово  b', 1, 10, '*');
  assert.equal(result.line, 'a  *слово*  b');
  assert.equal(toggleWrap('пусто', 2, 2, '**').line, 'пусто');
});

test('цвет ставится span-ом pandoc, меняется и снимается', () => {
  const red = applyColor('важно: срок', 0, 5, 'red');
  assert.equal(red.line, '[важно]{.red}: срок');
  assert.deepEqual([red.from, red.to], [1, 6]);
  const blue = applyColor(red.line, red.from, red.to, 'blue');
  assert.equal(blue.line, '[важно]{.blue}: срок');
  const none = applyColor(blue.line, blue.from, blue.to, null);
  assert.equal(none.line, 'важно: срок');
  // Тот же цвет второй раз — снимает, как кнопка-переключатель.
  assert.equal(applyColor(red.line, red.from, red.to, 'red').line, 'важно: срок');
  // Фон — тот же механизм с префиксом bg-.
  assert.equal(applyColor('текст', 0, 5, 'bg-yellow').line, '[текст]{.bg-yellow}');
  // Захватили span целиком — цвет заменяется по нему.
  assert.equal(applyColor('[текст]{.red} и', 0, 13, 'green').line, '[текст]{.green} и');
});

test('превращение строки меняет блок, сохраняя отступ и текст', () => {
  assert.equal(turnInto('  - пункт', 'h2'), '  ## пункт');
  assert.equal(turnInto('# Заголовок', 'task'), '- [ ] Заголовок');
  assert.equal(turnInto('1. первый', 'quote'), '> первый');
  assert.equal(turnInto('> цитата', 'text'), 'цитата');
  assert.equal(turnInto('просто текст', 'bullet'), '- просто текст');
  assert.equal(blockKindOf('### три'), 'h3');
  assert.equal(blockKindOf('- [x] сделано'), 'task');
  assert.equal(blockKindOf('2) второй'), 'ordered');
  assert.equal(blockKindOf('слова'), 'text');
});

test('подчёркивание и цвет оформляются в живом поле и в готовом тексте', () => {
  const live = decorateLine('++важно++ и [красным]{.red} и [фон]{.bg-yellow}');
  assert.match(live, /<u>важно<\/u>/);
  assert.match(live, /<span class="md-color md-color-red">красным<\/span>/);
  assert.match(live, /<span class="md-color md-color-bg-yellow">фон<\/span>/);
  // Маркеры остаются в тексте строки — инвариант живого поля.
  assert.equal(live.replace(/<[^>]+>/g, ''), '++важно++ и [красным]{.red} и [фон]{.bg-yellow}');
  const rendered = renderInlineMarkdown('++важно++ и [красным]{.red}');
  assert.equal(rendered, '<u>важно</u> и <span class="md-color md-color-red">красным</span>');
  // Неизвестный цвет — обычный текст, а не пустой span.
  assert.equal(renderInlineMarkdown('[текст]{.neon}'), '[текст]{.neon}');
});
