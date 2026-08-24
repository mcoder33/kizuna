import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInlineMarkdown } from '../public/markdown.js';

test('html in user text is escaped, never rendered', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(renderMarkdown('**<b>жирный</b>**'), '<p><strong>&lt;b&gt;жирный&lt;/b&gt;</strong></p>');
});

test('only http and https links become anchors', () => {
  assert.match(renderMarkdown('[док](https://example.com/a)'), /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">док<\/a>/);
  const dangerous = renderMarkdown('[клик](javascript:alert(1))');
  assert.equal(dangerous.includes('<a'), false);
  assert.equal(renderMarkdown('[файл](data:text/html;base64,AA)').includes('<a'), false);
});

test('headings, emphasis, strikethrough and rules render', () => {
  // Уровень заголовка несёт класс: в Obsidian их шесть, а тегов ниже h6 нет.
  assert.equal(renderMarkdown('# Заголовок'), '<h3 class="md-h1">Заголовок</h3>');
  assert.equal(renderMarkdown('### Третий'), '<h5 class="md-h3">Третий</h5>');
  assert.equal(renderMarkdown('###### Шестой'), '<h6 class="md-h6">Шестой</h6>');
  assert.equal(renderMarkdown('*курсив* и _тоже_'), '<p><em>курсив</em> и <em>тоже</em></p>');
  assert.equal(renderMarkdown('~~зачёркнуто~~'), '<p><del>зачёркнуто</del></p>');
  assert.equal(renderMarkdown('---'), '<hr>');
});

test('bullet and ordered lists group into one list each', () => {
  assert.equal(renderMarkdown('- один\n- два'), '<ul><li>один</li><li>два</li></ul>');
  assert.equal(renderMarkdown('1. один\n2) два'), '<ol><li>один</li><li>два</li></ol>');
  assert.equal(renderMarkdown('- один\n\n- два'), '<ul><li>один</li></ul><ul><li>два</li></ul>');
});

test('inline code is not parsed as markup and plain numbers survive', () => {
  assert.equal(renderMarkdown('`**не жирный**`'), '<p><code>**не жирный**</code></p>');
  assert.equal(renderMarkdown('цена 5 рублей'), '<p>цена 5 рублей</p>', 'заглушка кода не должна съедать числа');
  assert.equal(renderMarkdown('было 1 стало 2 и `код` потом 3'), '<p>было 1 стало 2 и <code>код</code> потом 3</p>');
});

test('fenced code keeps content verbatim and escaped', () => {
  assert.equal(renderMarkdown('```\n<b>x</b>\n```'), '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  assert.equal(renderMarkdown('```\nне закрыт'), '<pre><code>не закрыт</code></pre>', 'незакрытый блок не теряет текст');
});

test('blockquotes collect consecutive lines and keep markup inside', () => {
  // Внутри цитаты работает вся разметка — как в Obsidian, а не голый текст.
  assert.equal(renderMarkdown('> первая\n> вторая'), '<blockquote><p>первая</p><p>вторая</p></blockquote>');
  assert.match(renderMarkdown('> - пункт'), /<blockquote><ul><li>пункт<\/li><\/ul><\/blockquote>/);
  assert.match(renderMarkdown('> > вложенная'), /<blockquote><blockquote><p>вложенная<\/p><\/blockquote><\/blockquote>/);
});

test('empty and missing input render nothing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('a real capture with a numbered list renders as a list', () => {
  const source = 'Отзывы как работает Хаб\n1 помощь как вникать в задачу\n2 доработки по интерфейсу';
  const html = renderMarkdown(source);
  assert.match(html, /<p>Отзывы как работает Хаб<\/p>/);
  assert.equal(html.includes('<li>'), false, 'без точки после цифры это не список');
});

test('inline rendering keeps a line a line: blocks are stripped, formatting survives', () => {
  assert.equal(renderInlineMarkdown('# Заголовок'), 'Заголовок');
  assert.equal(renderInlineMarkdown('- **срочно** позвонить'), '<strong>срочно</strong> позвонить');
  assert.equal(renderInlineMarkdown('1. первый\n2. второй'), 'первый второй');
  assert.equal(renderInlineMarkdown('> цитата'), 'цитата');
  assert.equal(renderInlineMarkdown('`код` и ~~вычеркнутое~~'), '<code>код</code> и <del>вычеркнутое</del>');
});

test('inline rendering escapes html and can render links without anchors', () => {
  assert.equal(renderInlineMarkdown('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.match(renderInlineMarkdown('[док](https://example.com/a)'), /<a href="https:\/\/example\.com\/a"/);
  const noLinks = renderInlineMarkdown('[док](https://example.com/a)', { links: false });
  assert.equal(noLinks, '<span class="md-link" title="https://example.com/a">док</span>');
  assert.doesNotMatch(noLinks, /<a /);
  assert.equal(renderInlineMarkdown('[док](javascript:alert(1))', { links: false }), '[док](javascript:alert(1))');
});

test('inline rendering tolerates empty and non-string sources', () => {
  assert.equal(renderInlineMarkdown(''), '');
  assert.equal(renderInlineMarkdown(null), '');
  assert.equal(renderInlineMarkdown(undefined), '');
});

test('obsidian: highlight, wikilinks, embeds, tags, comments and anchors', () => {
  assert.equal(renderMarkdown('==важное=='), '<p><mark>важное</mark></p>');
  assert.match(renderMarkdown('[[Заметка]]'), /<a class="md-wikilink" href="#memory\?query=%D0%97[^"]*">Заметка<\/a>/);
  assert.match(renderMarkdown('[[Заметка|как назвали]]'), />как назвали</);
  assert.match(renderMarkdown('[[Заметка#Раздел]]'), /md-wikilink/);
  assert.match(renderMarkdown('![[Встроенное]]'), /md-embed/);
  assert.match(renderMarkdown('запись про #hub сегодня'), /<span class="md-tag">#hub<\/span>/);
  assert.equal(renderMarkdown('видно %%а это нет%% дальше'), '<p>видно  дальше</p>');
  assert.match(renderMarkdown('якорь ^block-42'), /<span class="md-anchor">\^block-42<\/span>/);
});

test('obsidian: tasks render as checkboxes and keep their state', () => {
  const html = renderMarkdown('- [ ] не сделано\n- [x] сделано');
  assert.match(html, /<li class="md-task"><span class="md-checkbox"[^>]*>☐<\/span>не сделано<\/li>/);
  assert.match(html, /<li class="md-task md-task-done"><span class="md-checkbox"[^>]*>☑<\/span>сделано<\/li>/);
  assert.match(html, /^<ul>/);
});

test('obsidian: nested lists nest instead of flattening', () => {
  const html = renderMarkdown('- верх\n  - вложенный\n- снова верх');
  assert.equal(html, '<ul><li>верх</li><ul><li>вложенный</li></ul><li>снова верх</li></ul>');
});

test('obsidian: tables render with alignment', () => {
  const html = renderMarkdown('| Что | Когда |\n| --- | ---: |\n| созвон | завтра |');
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>Что<\/th>/);
  assert.match(html, /<th style="text-align:right">Когда<\/th>/);
  assert.match(html, /<td>созвон<\/td><td style="text-align:right">завтра<\/td>/);
  // Одинокая строка с трубами таблицей не становится.
  assert.doesNotMatch(renderMarkdown('| просто | текст |'), /<table/);
});

test('obsidian: callouts become titled blocks, unknown kinds fall back to a note', () => {
  const html = renderMarkdown('> [!warning] Осторожно\n> тело предупреждения');
  assert.match(html, /<div class="md-callout md-callout-warning">/);
  assert.match(html, /<p class="md-callout-title">Осторожно<\/p>/);
  assert.match(html, /<p>тело предупреждения<\/p>/);
  assert.match(renderMarkdown('> [!tip]\n> совет'), /md-callout-tip/);
  assert.match(renderMarkdown('> [!tip]\n> совет'), /<p class="md-callout-title">Совет<\/p>/);
  assert.match(renderMarkdown('> [!выдумка] Что-то\n> текст'), /md-callout-note/);
});

test('obsidian: footnotes collect into a numbered list at the end', () => {
  const html = renderMarkdown('текст со сноской[^1]\n\n[^1]: пояснение');
  assert.match(html, /<sup class="md-footnote-ref"><a href="#fn-1">1<\/a><\/sup>/);
  assert.match(html, /<div class="md-footnotes"><ol><li id="fn-1">/);
  assert.match(html, /пояснение/);
});

test('obsidian: math and code fences keep their content verbatim', () => {
  assert.match(renderMarkdown('формула $E = mc^2$ в строке'), /<code class="md-math">E = mc\^2<\/code>/);
  assert.match(renderMarkdown('$$a + b$$'), /md-math-block/);
  assert.match(renderMarkdown('```js\nconst a = 1;\n```'), /<pre class="md-code" data-language="js"><code>const a = 1;<\/code><\/pre>/);
  assert.match(renderMarkdown('~~~\nтильды тоже\n~~~'), /<pre><code>тильды тоже<\/code><\/pre>/);
});

test('obsidian: escaping and bold-italic', () => {
  assert.equal(renderMarkdown('\\*не курсив\\*'), '<p>*не курсив*</p>');
  assert.equal(renderMarkdown('\\#не тег'), '<p>#не тег</p>');
  assert.equal(renderMarkdown('***и жирный и курсив***'), '<p><strong><em>и жирный и курсив</em></strong></p>');
});

test('obsidian: bare and angled urls become links, dangerous schemes do not', () => {
  assert.match(renderMarkdown('смотри https://example.com/a дальше'), /<a href="https:\/\/example\.com\/a"/);
  assert.match(renderMarkdown('<https://example.com/b>'), /<a href="https:\/\/example\.com\/b"/);
  assert.doesNotMatch(renderMarkdown('javascript:alert(1)'), /<a /);
  // Точка в конце предложения не должна попадать в адрес.
  assert.match(renderMarkdown('открой https://example.com/c.'), /href="https:\/\/example\.com\/c"/);
});

test('obsidian: images are shown as labelled links because CSP blocks remote images', () => {
  const html = renderMarkdown('![схема](https://example.com/a.png)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a class="md-image" href="https:\/\/example\.com\/a\.png"[^>]*>🖼 схема<\/a>/);
  assert.match(renderMarkdown('![](https://example.com/a.png)'), /🖼 изображение/);
});

test('obsidian markup survives inline rendering of a single line', () => {
  assert.equal(renderInlineMarkdown('- [x] сделал ==важное=='), 'сделал <mark>важное</mark>');
  assert.equal(renderInlineMarkdown('> [!note] Заголовок callout'), 'Заголовок callout');
  assert.match(renderInlineMarkdown('про [[Проект]]', { links: false }), /<span class="md-wikilink">Проект<\/span>/);
});

test('a title takes the first meaningful line, not everything glued together', () => {
  const raw = '# Разбор недели\n- [x] созвон ==сделан==\n| Что | Когда |\n| --- | ---: |\n| созвон | завтра |\nсноска[^1]\n\n[^1]: пояснение';
  const title = renderInlineMarkdown(raw, { firstLine: true });
  assert.equal(title, 'Разбор недели …');
  // Служебные строки в заголовок не попадают даже при обычной склейке.
  const joined = renderInlineMarkdown(raw);
  assert.doesNotMatch(joined, /---/);
  assert.doesNotMatch(joined, /\[\^1\]:/);
});

test('a single-line title keeps its formatting and gains no ellipsis', () => {
  assert.equal(renderInlineMarkdown('обычная **запись**', { firstLine: true }), 'обычная <strong>запись</strong>');
  assert.equal(renderInlineMarkdown('- [ ] купить хлеб', { firstLine: true }), 'купить хлеб');
  assert.equal(renderInlineMarkdown('', { firstLine: true }), '');
});
