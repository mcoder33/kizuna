// Подсказка людей после «@» в поле записи. Здесь то, что не требует браузера:
// когда подбор идёт и в каком порядке встают люди.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMentionQuery, rankPeople } from '../public/mention-menu.js';

test('подбор идёт после «@» в начале слова, а не внутри адреса', () => {
  assert.deepEqual(readMentionQuery('@', 1), { from: 0, to: 1, query: '' });
  assert.deepEqual(readMentionQuery('спросить @Ан', 12), { from: 9, to: 12, query: 'Ан' });
  assert.deepEqual(readMentionQuery('(@Ан', 4), { from: 1, to: 4, query: 'Ан' });
  assert.equal(readMentionQuery('почта@дом', 9), null, 'внутри слова это адрес, а не имя');
  assert.equal(readMentionQuery('@Аня прислала смету', 19), null, 'имя уже названо — подбирать нечего');
  assert.equal(readMentionQuery('без призыва', 11), null);
  assert.equal(readMentionQuery(`@${'и'.repeat(41)}`, 42), null, 'слишком длинное — это не имя');
});

test('люди: сначала совпадение с начала имени, потом почта, потом середина имени', () => {
  const people = [
    { id: '1', name: 'Аня', email: 'anya@kizuna.test', circles: ['Хаб'] },
    { id: '2', name: 'Даниил', email: 'dan@kizuna.test', circles: ['Хаб', 'Дом'] },
    { id: '3', name: 'Ян Ананьев', email: 'yan@kizuna.test', circles: ['Дом'] },
  ];
  // «Аня» совпала с начала имени и идёт первой; остальные — по алфавиту.
  assert.deepEqual(rankPeople(people, 'ан').map(person => person.name), ['Аня', 'Даниил', 'Ян Ананьев']);
  assert.deepEqual(rankPeople(people, 'dan').map(person => person.name), ['Даниил'], 'почта тоже ищется');
  assert.deepEqual(rankPeople(people, 'аня').map(person => person.name), ['Аня']);
  assert.deepEqual(rankPeople(people, '').map(person => person.name), ['Аня', 'Даниил', 'Ян Ананьев'], 'пусто — все по алфавиту');
  assert.deepEqual(rankPeople(people, 'кто-то'), []);
  assert.equal(rankPeople(people, '', 2).length, 2, 'список не длиннее предела');
});
