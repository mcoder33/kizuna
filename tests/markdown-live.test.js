import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateLine, listContinuation, toggleTask, indentLine, renumberOrdered } from '../public/markdown-live.js';

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

test('enter continues the list the line started', () => {
  assert.deepEqual(listContinuation('- пункт'), { prefix: '- ' });
  assert.deepEqual(listContinuation('* звёздочкой'), { prefix: '* ' });
  assert.deepEqual(listContinuation('- [ ] задача'), { prefix: '- [ ] ' });
  // Продолжение сделанной задачи начинается пустым, а не унаследованным [x].
  assert.deepEqual(listContinuation('- [x] сделано'), { prefix: '- [ ] ' });
  assert.deepEqual(listContinuation('3. третий'), { prefix: '4. ' });
  assert.deepEqual(listContinuation('1) первый'), { prefix: '2) ' });
  // Отступ вложенного пункта сохраняется.
  assert.deepEqual(listContinuation('  - вложенный'), { prefix: '  - ' });
  assert.equal(listContinuation('обычная строка'), null);
  assert.equal(listContinuation(''), null);
});

test('enter on an empty item ends the list instead of adding a marker', () => {
  assert.deepEqual(listContinuation('- '), { clear: true, keep: '' });
  assert.deepEqual(listContinuation('1. '), { clear: true, keep: '' });
  assert.deepEqual(listContinuation('- [ ] '), { clear: true, keep: '' });
  assert.deepEqual(listContinuation('  - '), { clear: true, keep: '  ' });
});

test('clicking a checkbox flips the task state in the text', () => {
  assert.equal(toggleTask('- [ ] задача'), '- [x] задача');
  assert.equal(toggleTask('- [x] задача'), '- [ ] задача');
  assert.equal(toggleTask('- [X] задача'), '- [ ] задача');
  assert.equal(toggleTask('  * [ ] вложенная'), '  * [x] вложенная');
  assert.equal(toggleTask('- обычный пункт'), null);
  assert.equal(toggleTask('просто строка'), null);
});

test('a task line shows a checkbox instead of a bullet', () => {
  assert.match(decorateLine('- [ ] задача'), /md-bullet md-bullet-task/);
  assert.doesNotMatch(decorateLine('- обычный'), /md-bullet-task/);
  assert.match(decorateLine('1. пункт'), /md-bullet md-ordered/);
});

test('tab indents a list item, shift+tab pulls it back', () => {
  assert.deepEqual(indentLine('- пункт', 1), { line: '  - пункт', shift: 2 });
  assert.deepEqual(indentLine('  - вложенный', 1), { line: '    - вложенный', shift: 2 });
  assert.deepEqual(indentLine('  - вложенный', -1), { line: '- вложенный', shift: -2 });
  assert.deepEqual(indentLine('1. первый', 1), { line: '  1. первый', shift: 2 });
  assert.deepEqual(indentLine('- [ ] задача', 1), { line: '  - [ ] задача', shift: 2 });
  // Табуляция считается за один уровень.
  assert.deepEqual(indentLine('\t- пункт', -1), { line: '- пункт', shift: -1 });
});

test('shift+tab on a top-level item changes nothing', () => {
  assert.deepEqual(indentLine('- пункт', -1), { line: '- пункт', shift: 0 });
  assert.deepEqual(indentLine('обычная строка', -1), { line: 'обычная строка', shift: 0 });
});

test('an indented item is a nested list for the block renderer', async () => {
  const { renderMarkdown } = await import('../public/markdown.js');
  const indented = indentLine('- подпункт', 1).line;
  assert.equal(renderMarkdown(`- верх\n${indented}`), '<ul><li>верх</li><ul><li>подпункт</li></ul></ul>');
});

test('enter continues a quote and a callout body', () => {
  assert.deepEqual(listContinuation('> цитата'), { prefix: '> ' });
  // После строки с типом всегда идёт тело, даже если заголовок пуст.
  assert.deepEqual(listContinuation('> [!info] Заголовок'), { prefix: '> ' });
  assert.deepEqual(listContinuation('> [!info]'), { prefix: '> ' });
  assert.deepEqual(listContinuation('> > вложенная'), { prefix: '> > ' });
  assert.deepEqual(listContinuation('  > с отступом'), { prefix: '  > ' });
  // Список внутри цитаты продолжается вместе с ней.
  assert.deepEqual(listContinuation('> - пункт в цитате'), { prefix: '> - ' });
  assert.deepEqual(listContinuation('> 2. второй'), { prefix: '> 3. ' });
  // Пустой пункт внутри цитаты снимает маркер списка, но цитату оставляет.
  assert.deepEqual(listContinuation('> - '), { prefix: '> ' });
  // Пустая цитата заканчивается.
  assert.deepEqual(listContinuation('> '), { clear: true, keep: '' });
});

test('inline footnotes are decorated in the field', () => {
  const html = decorateLine('пояснение^[прямо здесь] дальше');
  assert.match(html, /md-footnote-ref/);
  assert.equal(textOf(html), 'пояснение^[прямо здесь] дальше');
});

test('renumberOrdered: подпункт начинает с 1, возврат продолжает родителя, соседи подтягиваются', () => {
  // Сдвинутый вправо четвёртый пункт — первый подпункт третьего.
  const nested = ['1. один', '2. два', '3. три', '  4. четыре'];
  assert.equal(renumberOrdered(nested, 3), true);
  assert.deepEqual(nested, ['1. один', '2. два', '3. три', '  1. четыре']);
  // Второй подпункт продолжает счёт подсписка, а следующий за ним пункт
  // верхнего уровня — счёт родителя.
  const deeper = ['1. один', '  1. под', '  2. ещё', '5. верх'];
  renumberOrdered(deeper, 3);
  assert.deepEqual(deeper, ['1. один', '  1. под', '  2. ещё', '2. верх']);
  // Сдвинутый влево подпункт становится следующим пунктом родителя.
  const back = ['1. один', '  1. под', '2. вернулся'];
  assert.equal(renumberOrdered(back, 2), false);
  // Пункт из середины ушёл вглубь — соседи ниже подтянулись.
  const middle = ['1. один', '  2. два', '3. три', '4. четыре'];
  renumberOrdered(middle, 1);
  assert.deepEqual(middle, ['1. один', '  1. два', '2. три', '3. четыре']);
  // Маркер другого вида обрывает счёт, строка не из списка — границу блока.
  const mixed = ['1. один', '- точка', '3. снова', '', '7. отдельный список'];
  renumberOrdered(mixed, 2);
  assert.deepEqual(mixed, ['1. один', '- точка', '1. снова', '', '7. отдельный список']);
  // Скобка как разделитель тоже нумеруется.
  const paren = ['1) а', '  3) б'];
  renumberOrdered(paren, 1);
  assert.deepEqual(paren, ['1) а', '  1) б']);
});
