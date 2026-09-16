// Подсказка страниц после «[[». Здесь то, что не требует браузера: когда
// подбор идёт, что он заменит и как упорядочены страницы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readLinkQuery, rankPages, placeHint } from '../public/link-menu.js';

test('подбор идёт после двух скобок и до закрывающих', () => {
  assert.deepEqual(readLinkQuery('[[', 2), { from: 0, to: 2, query: '', embed: false });
  assert.deepEqual(readLinkQuery('см. [[Рел', 9), { from: 4, to: 9, query: 'Рел', embed: false });
  assert.equal(readLinkQuery('см. [[Релиз]] и дальше', 22), null, 'ссылка уже закрыта — подбирать нечего');
  assert.equal(readLinkQuery('одна [скобка', 12), null);
  assert.equal(readLinkQuery('обычный текст', 13), null);
  assert.equal(readLinkQuery('[[Релиз|подпись', 15), null, 'подпись после | пишут сами');
});

test('замена захватывает хвост уже закрытой ссылки и скобки из меню «/»', () => {
  // «/» → «Внутренняя ссылка» вставляет [[]] и ставит каретку между скобками.
  assert.deepEqual(readLinkQuery('[[]]', 2), { from: 0, to: 4, query: '', embed: false });
  // Каретка посреди набранного названия: заменяется всё до закрывающих скобок.
  assert.deepEqual(readLinkQuery('x [[Рел из]] y', 7), { from: 2, to: 12, query: 'Рел', embed: false });
});

test('встраивание «![[…]]» отмечается: там подходят и базы', () => {
  assert.deepEqual(readLinkQuery('![[Кни', 6), { from: 1, to: 6, query: 'Кни', embed: true });
});

test('страницы: сначала совпадение с начала названия, потом с начала слова, потом внутри', () => {
  const pages = [
    { title: 'Планы на осень', updatedAt: '2026-09-10' },
    { title: 'Осенний релиз', updatedAt: '2026-09-01' },
    { title: 'Переосенение', updatedAt: '2026-09-15' },
    { title: 'Кизуна', updatedAt: '2026-09-16' },
  ];
  assert.deepEqual(rankPages(pages, 'осен').map(page => page.title), ['Осенний релиз', 'Планы на осень', 'Переосенение']);
  assert.deepEqual(rankPages(pages, 'ОСЁН').map(page => page.title), ['Осенний релиз', 'Планы на осень', 'Переосенение'], 'регистр не важен, ё и е — одна буква');
  assert.deepEqual(rankPages(pages, '').map(page => page.title), ['Кизуна', 'Переосенение', 'Планы на осень', 'Осенний релиз'], 'пустой запрос — недавние');
  assert.equal(rankPages(pages, '', 2).length, 2);
});

test('подпись места различает одинаковые названия', () => {
  assert.equal(placeHint({ parentTitle: 'Кизуна', parentKey: 'x' }), 'Кизуна');
  assert.equal(placeHint({ parentKey: 'project:Hub' }), 'Hub');
  assert.equal(placeHint({ parentKey: 'inbox' }), 'Входящие');
  assert.equal(placeHint({ parentKey: null }), '');
});
