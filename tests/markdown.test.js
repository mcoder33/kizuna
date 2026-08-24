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
  assert.equal(renderMarkdown('# Заголовок'), '<h3>Заголовок</h3>');
  assert.equal(renderMarkdown('### Третий'), '<h5>Третий</h5>');
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

test('blockquotes collect consecutive lines', () => {
  assert.equal(renderMarkdown('> первая\n> вторая'), '<blockquote>первая<br>вторая</blockquote>');
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
