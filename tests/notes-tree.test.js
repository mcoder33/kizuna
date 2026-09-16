import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

function app() {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-pages-')), 'test.sqlite');
  return createApp({ aiService: fakeModelService(), databasePath });
}
async function capture(api, raw) {
  return (await api.post('/api/captures').send({ raw }).expect(201)).body.entry;
}
async function page(api, title, parent) {
  return (await api.post('/api/pages').send(parent === undefined ? { title } : { title, parent }).expect(201)).body.page;
}
async function overview(api) {
  return (await api.get('/api/pages').expect(200)).body;
}
const listed = (data, id) => data.pages.find(item => item.id === id);
async function waitFor(check, { timeout = 4000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('не дождались');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

test('a note finds its place: inbox without a project, under the project with one, root when made in the section', async () => {
  const api = authed(app());
  const loose = await capture(api, 'Мысли про интерфейс заметок');
  const hub = await capture(api, 'Архитектура Hub на листке');
  const made = await page(api, 'Кизуна');
  const data = await overview(api);
  assert.equal(listed(data, loose.id).parentKey, 'inbox');
  assert.equal(listed(data, hub.id).parentKey, 'project:Hub');
  assert.equal(made.parentKey, null, 'страница из раздела лежит в корне, а не во «Входящих»');
  assert.deepEqual(data.projects, [{ name: 'Hub', count: 1 }]);
  // Дела в дерево не попадают: страницы — только заметки и идеи.
  const deed = await capture(api, 'Нужно проверить Hub');
  assert.equal(listed(await overview(api), deed.id), undefined);
});

test('pages nest, move and refuse to go inside themselves', async () => {
  const api = authed(app());
  const parent = await page(api, 'Релиз 1.4');
  const child = await page(api, 'Голос: геолокация', parent.id);
  assert.equal(child.parentKey, parent.id);
  const detail = (await api.get(`/api/pages/${parent.id}`).expect(200)).body;
  assert.deepEqual(detail.children.map(item => item.id), [child.id]);
  const childDetail = (await api.get(`/api/pages/${child.id}`).expect(200)).body;
  assert.deepEqual(childDetail.trail, [{ key: parent.id, title: 'Релиз 1.4', type: 'note' }]);

  const cycle = await api.put(`/api/pages/${parent.id}/place`).send({ parent: child.id }).expect(409);
  assert.equal(cycle.body.error.code, 'cycle');
  await api.put(`/api/pages/${parent.id}/place`).send({ parent: parent.id }).expect(409);
  const moved = (await api.put(`/api/pages/${child.id}/place`).send({ parent: 'root' }).expect(200)).body;
  assert.equal(moved.page.parentKey, null);

  // Страница внутри проекта получает проект, дочерняя — проект родителя.
  const scheme = await page(api, 'Схема', 'project:Hub');
  assert.equal(scheme.project, 'Hub');
  assert.equal(scheme.parentKey, 'project:Hub');
  const inner = await page(api, 'Детали схемы', scheme.id);
  assert.equal(inner.project, 'Hub');

  // Без места по правилу: заметка из «Входящих» кладётся руками и возвращается.
  const loose = await capture(api, 'Просто мысль вслух');
  await api.put(`/api/pages/${loose.id}/place`).send({ parent: parent.id }).expect(200);
  assert.equal(listed(await overview(api), loose.id).parentKey, parent.id);
  await api.put(`/api/pages/${loose.id}/place`).send({ parent: 'auto' }).expect(200);
  assert.equal(listed(await overview(api), loose.id).parentKey, 'inbox');
  await api.put(`/api/pages/${loose.id}/place`).send({ parent: 'нет-такой' }).expect(404);
  await api.post('/api/pages').send({ title: '   ' }).expect(400);
});

test('links show who points at a page, survive a rename and mentions become links', async () => {
  const api = authed(app());
  const release = await page(api, 'Релиз 1.4');
  const pointing = await capture(api, 'Думаю про [[Релиз 1.4]] и сроки');
  let detail = (await api.get(`/api/pages/${release.id}`).expect(200)).body;
  assert.deepEqual(detail.backlinks.map(item => item.id), [pointing.id]);
  assert.match(detail.backlinks[0].context, /Думаю про Релиз 1\.4 и сроки/);

  const mention = await capture(api, 'Черновик: релиз 1.4 без ссылки');
  detail = (await api.get(`/api/pages/${release.id}`).expect(200)).body;
  assert.deepEqual(detail.mentions.map(item => item.id), [mention.id]);
  detail = (await api.post(`/api/pages/${release.id}/mentions`).send({ fromId: mention.id }).expect(200)).body;
  assert.deepEqual(detail.backlinks.map(item => item.id).sort(), [pointing.id, mention.id].sort());
  assert.equal(detail.mentions.length, 0);
  const linked = (await api.get(`/api/captures/${mention.id}`).expect(200)).body.entry;
  assert.equal(linked.note.body, 'Черновик: [[Релиз 1.4|релиз 1.4]] без ссылки', 'исходный текст записи не трогается — меняется заметка');
  assert.equal(linked.raw, 'Черновик: релиз 1.4 без ссылки');

  // Переименование не рвёт ссылок: связь помнит страницу, а не её название.
  await api.post(`/api/captures/${release.id}/corrections`).send({ summary: 'Релиз 1.5' }).expect(200);
  detail = (await api.get(`/api/pages/${release.id}`).expect(200)).body;
  assert.equal(detail.page.title, 'Релиз 1.5');
  assert.ok(detail.backlinks.some(item => item.id === pointing.id));
  assert.equal((await api.get(`/api/pages/resolve?title=${encodeURIComponent('Релиз 1.4')}&from=${pointing.id}`).expect(200)).body.id, release.id);
  assert.equal((await api.get(`/api/pages/resolve?title=${encodeURIComponent('релиз 1.5')}`).expect(200)).body.id, release.id);
  assert.equal((await api.get(`/api/pages/resolve?title=${encodeURIComponent('Нет такой')}`).expect(200)).body.id, null);

  // Ссылка на страницу, которой ещё нет, находит её, когда страницу заведут.
  const early = await capture(api, 'Потом разобрать [[Планы на осень]]');
  const plans = await page(api, 'Планы на осень');
  detail = (await api.get(`/api/pages/${plans.id}`).expect(200)).body;
  assert.deepEqual(detail.backlinks.map(item => item.id), [early.id]);
  assert.equal(listed(await overview(api), plans.id).links, 1);
});

test('a capture names its own place: [[page]] or «в странице: …»', async () => {
  const api = authed(app());
  const ideas = await page(api, 'Идеи по голосу');
  const byPhrase = await capture(api, 'в идеи по голосу: диктовать сразу в страницу');
  const byLink = await capture(api, '[[Идеи по голосу]] шёпот вместо кнопки');
  const unrelated = await capture(api, 'в пятницу: погода будет хорошей');
  const data = await overview(api);
  assert.equal(listed(data, byPhrase.id).parentKey, ideas.id);
  assert.equal(listed(data, byLink.id).parentKey, ideas.id);
  assert.equal(listed(data, unrelated.id).parentKey, 'inbox');
  // Во «Входящих» — подсказка места по названию страницы в тексте.
  const hint = await capture(api, 'Ещё про идеи по голосу и шум');
  await api.put(`/api/pages/${hint.id}/place`).send({ parent: 'auto' }).expect(200);
  const hinted = listed(await overview(api), hint.id);
  assert.equal(hinted.parentKey, 'inbox');
  assert.deepEqual(hinted.suggest, { key: ideas.id, title: 'Идеи по голосу' });
});

test('a note line becomes a deed on the board and the line follows its state', async () => {
  const application = app();
  const api = authed(application);
  application.captureJobWorker.start();
  try {
    const note = await page(api, 'Заметки как в Notion');
    const body = 'План:\n- [ ] Проверить Hub до пятницы\n- [ ] Просто пункт';
    await api.post(`/api/captures/${note.id}/notes`).send({ body }).expect(200);

    const refused = await api.post(`/api/pages/${note.id}/deeds`).send({ line: 1, text: '- [ ] другое' }).expect(409);
    assert.equal(refused.body.error.code, 'line_changed');
    await api.post(`/api/pages/${note.id}/deeds`).send({ line: 0, text: 'План:' }).expect(400);

    const made = (await api.post(`/api/pages/${note.id}/deeds`).send({ line: 1, text: '- [ ] Проверить Hub до пятницы' }).expect(201)).body;
    const { captureId, anchor } = made.deed;
    assert.equal(anchor, `task-${captureId.slice(0, 8)}`);
    assert.equal(made.page.body.split('\n')[1], `- [ ] Проверить Hub до пятницы ^${anchor}`);
    await api.post(`/api/pages/${note.id}/deeds`).send({ line: 1, text: made.page.body.split('\n')[1] }).expect(409);

    const open = await waitFor(async () => {
      const detail = (await api.get(`/api/pages/${note.id}`).expect(200)).body;
      return detail.deeds[0]?.state === 'open' ? detail.deeds[0] : null;
    });
    assert.equal(open.column, 'Входящие');
    assert.ok(open.due, 'срок разобран из строки');
    const entry = (await api.get(`/api/captures/${captureId}`).expect(200)).body.entry;
    assert.equal(entry.parentId, note.id);
    assert.equal(entry.raw, 'Проверить Hub до пятницы');
    assert.equal(entry.interpretation.classification.primaryType, 'task');
    const board = (await api.get('/api/board').expect(200)).body;
    assert.ok(JSON.stringify(board).includes(captureId), 'дело на доске');
    assert.equal(listed(await overview(api), captureId), undefined, 'дело не страница');

    await api.post(`/api/projections/${open.projectionIds[0]}/complete`).expect(200);
    let detail = (await api.get(`/api/pages/${note.id}`).expect(200)).body;
    assert.equal(detail.page.body.split('\n')[1], `- [x] Проверить Hub до пятницы ^${anchor}`);
    assert.equal(detail.deeds[0].state, 'done');
    await api.post(`/api/projections/${open.projectionIds[0]}/undo-complete`).expect(200);
    detail = (await api.get(`/api/pages/${note.id}`).expect(200)).body;
    assert.equal(detail.page.body.split('\n')[1], `- [ ] Проверить Hub до пятницы ^${anchor}`);
    assert.equal(detail.deeds[0].state, 'open');
  } finally {
    await application.captureJobWorker.stop();
  }
});

test('bases are personal, validated and removable', async () => {
  const application = app();
  const api = authed(application);
  const other = authed(application, { email: 'other@kizuna.test', role: 'user' });
  const created = (await api.post('/api/pages/bases').send({ name: 'Книги', view: { layout: 'gallery', sort: 'title', filter: { tag: 'книги', type: 'nonsense' } } }).expect(201)).body.base;
  assert.equal(created.view.layout, 'gallery');
  assert.equal(created.view.filter.type, 'all', 'неизвестный тип фильтра сбрасывается');
  await api.post('/api/pages/bases').send({ name: '' }).expect(400);
  const renamed = (await api.patch(`/api/pages/bases/${created.id}`).send({ name: 'Чтение' }).expect(200)).body.base;
  assert.equal(renamed.name, 'Чтение');
  assert.equal(renamed.view.layout, 'gallery');
  assert.deepEqual((await overview(api)).bases.map(base => base.name), ['Чтение']);

  assert.deepEqual((await overview(other)).bases, []);
  await other.patch(`/api/pages/bases/${created.id}`).send({ name: 'Чужое' }).expect(404);
  await other.delete(`/api/pages/bases/${created.id}`).expect(404);
  await api.delete(`/api/pages/bases/${created.id}`).expect(200);
  assert.deepEqual((await overview(api)).bases, []);
});

test('someone else’s page is not found and reset clears places, links and bases', async () => {
  const application = app();
  const api = authed(application);
  const other = authed(application, { email: 'other@kizuna.test', role: 'user' });
  const mine = await page(api, 'Личное');
  await capture(api, 'Ссылка на [[Личное]]');
  await api.post('/api/pages/bases').send({ name: 'Все', view: {} }).expect(201);
  await other.get(`/api/pages/${mine.id}`).expect(404);
  await other.put(`/api/pages/${mine.id}/place`).send({ parent: 'root' }).expect(404);
  await other.post(`/api/pages/${mine.id}/deeds`).send({ line: 0, text: '' }).expect(404);
  assert.equal((await overview(other)).pages.length, 0);

  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  const db = application.database;
  for (const table of ['note_places', 'note_links', 'note_bases']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('dragging sets the order next to each other and moves a page into a new place', async () => {
  const api = authed(app());
  const first = await page(api, 'Первая');
  const second = await page(api, 'Вторая');
  const third = await page(api, 'Третья');
  const roots = data => data.pages.filter(item => item.parentKey === null)
    .sort((left, right) => (left.position === null) - (right.position === null) || (left.position ?? 0) - (right.position ?? 0) || left.createdAt.localeCompare(right.createdAt))
    .map(item => item.title);
  assert.deepEqual(roots(await overview(api)), ['Первая', 'Вторая', 'Третья'], 'без порядка — по времени записи');

  await api.put(`/api/pages/${third.id}/place`).send({ parent: 'root', order: [third.id, first.id, second.id] }).expect(200);
  assert.deepEqual(roots(await overview(api)), ['Третья', 'Первая', 'Вторая']);

  // Внутрь страницы — рядом с тем, что уже там лежит, и в заданном месте.
  const inner = await page(api, 'Внутри', first.id);
  const moved = (await api.put(`/api/pages/${second.id}/place`).send({ parent: first.id, order: [second.id, inner.id] }).expect(200)).body;
  assert.equal(moved.page.parentKey, first.id);
  const detail = (await api.get(`/api/pages/${first.id}`).expect(200)).body;
  assert.deepEqual(detail.children.map(item => item.title), ['Вторая', 'Внутри']);
  assert.deepEqual(roots(await overview(api)), ['Третья', 'Первая']);

  // Чужие и лежащие в другом месте id в порядке не участвуют.
  await api.put(`/api/pages/${inner.id}/place`).send({ parent: first.id, order: ['нет-такой', third.id, inner.id, second.id] }).expect(200);
  assert.deepEqual((await api.get(`/api/pages/${first.id}`).expect(200)).body.children.map(item => item.title), ['Внутри', 'Вторая']);
  await api.put(`/api/pages/${inner.id}/place`).send({ parent: first.id, order: 'не список' }).expect(400);
  await api.put(`/api/pages/${first.id}/place`).send({ parent: second.id, order: [first.id] }).expect(409);
});
