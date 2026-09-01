// Меню разметки по «/». Здесь проверяется то, что не требует браузера: когда
// меню вообще должно появиться, как отбираются пункты и — главное — что каждый
// пункт даёт разметку, которую поле правда рисует. Предложить блок, остающийся
// серым текстом, хуже, чем не предлагать ничего.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_ITEMS, filterItems, readQuery } from '../public/slash-menu.js';
import { decorateLine, listContinuation } from '../public/markdown-live.js';

// ── когда меню открывается ───────────────────────────────────────────────────
test('косая черта в начале строки и после пробела открывает меню', () => {
  assert.deepEqual(readQuery('/', 1), { from: 0, to: 1, query: '' });
  assert.deepEqual(readQuery('/заг', 4), { from: 0, to: 4, query: 'заг' });
  assert.deepEqual(readQuery('заметка /h1', 11), { from: 8, to: 11, query: 'h1' });
});

test('косая черта внутри слова меню не открывает', () => {
  assert.equal(readQuery('https://example.com/', 20), null, 'адрес — не команда');
  assert.equal(readQuery('12/34', 5), null, 'дата и дробь тоже');
  assert.equal(readQuery('и/или', 5), null);
});

test('пробел после косой черты заканчивает подбор', () => {
  assert.equal(readQuery('/заг олов', 9), null, 'человек уже пишет обычный текст');
  assert.equal(readQuery('/ ', 2), null);
});

test('без косой черты меню не при чём', () => {
  assert.equal(readQuery('обычная строка', 14), null);
  assert.equal(readQuery('', 0), null);
});

test('каретка левее косой черты меню не открывает', () => {
  // Курсор ушёл в начало строки: подсказка была бы не о том месте.
  assert.equal(readQuery('текст /h1', 3), null);
});

// ── отбор пунктов ────────────────────────────────────────────────────────────
test('пустой запрос показывает всё, а совпадение в начале слова — выше', () => {
  assert.equal(filterItems('').length, SLASH_ITEMS.length);
  const ids = filterItems('за').map((item) => item.id);
  assert.equal(ids[0], 'h1', '«Заголовок» начинается с «за», а «Зачёркнутый» — тоже, но реже нужен');
  assert.ok(ids.includes('task'), 'и «Задача» здесь же');
});

test('пункты находятся и по-русски, и латиницей', () => {
  for (const [query, expected] of [['h1', 'h1'], ['заголовок', 'h1'], ['todo', 'task'], ['задача', 'task'], ['quote', 'quote'], ['цитат', 'quote'], ['table', 'table'], ['таблиц', 'table'], ['bold', 'bold'], ['жирн', 'bold']])
    assert.equal(filterItems(query)[0].id, expected, `«${query}» должно находить ${expected}`);
});

test('регистр и «ё» не мешают', () => {
  assert.equal(filterItems('ЗАЧЁРКНУТЫЙ')[0].id, 'strike');
  assert.equal(filterItems('зачеркнутый')[0].id, 'strike');
});

test('ничего не подошло — пустой список, а не весь набор', () => {
  assert.deepEqual(filterItems('щщщ'), []);
});

// ── честность списка ─────────────────────────────────────────────────────────
test('каждый пункт даёт разметку, которую поле правда рисует', () => {
  for (const item of SLASH_ITEMS) {
    const line = item.kind === 'prefix' ? `${item.value}текст`
      : item.kind === 'wrap' ? `${item.before}текст${item.after}`
      : item.value.split('\n')[0];
    const html = decorateLine(line);
    assert.notEqual(html, `${line}`, `«${item.title}» осталось обычным текстом`);
    assert.match(html, /<span|<strong|<em|<del|<mark|<code|<a /, `«${item.title}» ничем не оформилось`);
  }
});

test('списки из меню продолжаются по Enter', () => {
  for (const id of ['bullet', 'ordered', 'task']) {
    const item = SLASH_ITEMS.find((entry) => entry.id === id);
    const continuation = listContinuation(`${item.value}первый пункт`);
    assert.notEqual(continuation, null, `«${item.title}» должен продолжаться сам`);
    assert.equal(typeof continuation.prefix, 'string');
  }
});

test('у пунктов нет повторов и все поля на месте', () => {
  const ids = SLASH_ITEMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'повторяющийся id сломал бы aria-activedescendant');
  const titles = SLASH_ITEMS.map((item) => item.title);
  assert.equal(new Set(titles).size, titles.length, 'два одинаковых названия человек не различит');
  for (const item of SLASH_ITEMS) {
    assert.ok(item.title && item.hint && item.keys, `«${item.id}»: неполный пункт`);
    if (item.kind === 'prefix') assert.ok(item.value.endsWith(' '), `«${item.title}»: без пробела текст слипнется с разметкой`);
    if (item.kind === 'wrap') assert.ok(item.before && item.after, `«${item.title}»: обёртка без второй половины`);
  }
});

test('подсказка рядом с названием не расходится с тем, что вставляется', () => {
  for (const item of SLASH_ITEMS) {
    const shown = item.hint.trim();
    const inserted = item.kind === 'wrap' ? `${item.before}текст${item.after}` : item.value.trim().split('\n')[0];
    // У блока в несколько строк подсказка схематична («| … | … |»), и требовать
    // от неё дословности бессмысленно. Но начинаться она обязана тем же знаком:
    // решётка вместо трубы — уже обман.
    assert.equal(shown[0], inserted[0], `«${item.title}»: подсказка «${shown}» начинается не так, как вставка («${inserted}»)`);
    if (item.kind === 'prefix') assert.equal(shown, item.value.trim(), `«${item.title}»: у строчного блока подсказка должна быть дословной`);
  }
});
