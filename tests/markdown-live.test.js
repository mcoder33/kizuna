import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateLine } from '../public/markdown-live.js';

// Главный инвариант поля: оформление ничего не удаляет из текста. Иначе
// каретку невозможно восстановить по смещению, а разметку — отредактировать.
const textOf = (html) => html
  .replace(/<br>/g, '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

test('decorating a line never loses or adds a character', () => {
  const lines = [
    '--зачёркнуто-- и **жирный** с `кодом`',
    '# Заголовок',
    '#### Мелкий заголовок',
    '- пункт со __вставкой__',
    '3) нумерованный ~~пункт~~',
    '> цитата с *акцентом*',
    '  отступ и текст',
    'ссылка [док](https://example.com/a) в строке',
    'просто текст без разметки',
    '---',
    '```js',
    '',
  ];
  for (const line of lines) assert.equal(textOf(decorateLine(line)), line, line);
});

test('markers stay in the text but are marked as syntax', () => {
  const html = decorateLine('**жирный**');
  assert.match(html, /<span class="md-mark">\*\*<\/span><strong>жирный<\/strong><span class="md-mark">\*\*<\/span>/);
  assert.match(decorateLine('# Заголовок'), /<span class="md-mark"># <\/span>/);
  assert.match(decorateLine('- пункт'), /md-bullet/);
});

test('both strikethrough spellings are decorated', () => {
  assert.match(decorateLine('~~канон~~'), /<del>канон<\/del>/);
  assert.match(decorateLine('--так тоже--'), /<del>так тоже<\/del>/);
  // Тире и горизонтальная линия зачёркиванием не становятся.
  assert.doesNotMatch(decorateLine('что-то — тире'), /<del>/);
  assert.doesNotMatch(decorateLine('---'), /<del>/);
});

test('html in a typed line is escaped, never rendered', () => {
  const html = decorateLine('<img src=x onerror=alert(1)> и **жирный**');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>жирный<\/strong>/);
});

test('only http and https links are decorated as links', () => {
  assert.match(decorateLine('[док](https://example.com/a)'), /<span class="md-link">док<\/span>/);
  const unsafe = decorateLine('[док](javascript:alert(1))');
  assert.doesNotMatch(unsafe, /md-link/);
  assert.equal(textOf(unsafe), '[док](javascript:alert(1))');
});

test('an empty line keeps its height with a break', () => {
  assert.equal(decorateLine(''), '<br>');
});

test('obsidian syntax is decorated in the field without losing a character', () => {
  const lines = [
    '- [ ] задача не сделана',
    '- [x] задача сделана',
    '###### шестой уровень',
    '> [!warning] Осторожно',
    '| Что | Когда |',
    'выделено ==важное== в строке',
    'ссылка [[Заметка|алиас]] и встраивание ![[Файл]]',
    'картинка ![схема](https://example.com/a.png)',
    'сноска[^1] в тексте',
    '[^1]: пояснение сноски',
    'формула $E = mc^2$ и блок $$a+b$$',
    'тег #проект/подпроект и якорь ^block-1',
    'комментарий %%скрытый%% дальше',
    '***жирный курсив***',
    '~~~',
  ];
  for (const line of lines) assert.equal(textOf(decorateLine(line)), line, line);
});

test('obsidian constructs get their own decoration', () => {
  assert.match(decorateLine('- [x] сделано'), /md-checkbox md-checkbox-done/);
  assert.match(decorateLine('- [ ] не сделано'), /md-checkbox(?! md-checkbox-done)/);
  assert.match(decorateLine('> [!warning] Осторожно'), /md-callout-warning/);
  assert.match(decorateLine('> [!warning] Осторожно'), /md-callout-title/);
  assert.match(decorateLine('==важное=='), /<mark>важное<\/mark>/);
  assert.match(decorateLine('[[Заметка]]'), /md-wikilink/);
  assert.match(decorateLine('![[Файл]]'), /md-wikilink/);
  assert.match(decorateLine('#тег'), /<span class="md-tag">#тег<\/span>/);
  assert.match(decorateLine('$E=mc^2$'), /md-math/);
  assert.match(decorateLine('%%скрытое%%'), /md-comment/);
  assert.match(decorateLine('| a | b |'), /md-table-line/);
  assert.match(decorateLine('***оба***'), /<strong><em>оба<\/em><\/strong>/);
  assert.match(decorateLine('###### шестой'), /md-h6/);
});

test('dangerous urls stay plain text in the field', () => {
  const html = decorateLine('[клик](javascript:alert(1))');
  assert.doesNotMatch(html, /md-link/);
  assert.equal(textOf(html), '[клик](javascript:alert(1))');
});
