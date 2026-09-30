// Одна запись — два разных действия. «Созванивались по ВойсОпс… решили
// допинать бот-детектор и карусель» — это отчёт о сделанном и два намерения на
// будущее. Раньше намерения оставались текстом внутри заметки: тип у записи
// один, а вторая проекция получила бы тот же заголовок, что и первая. Теперь
// модель называет их отдельно, и каждое уходит своей записью-делом со ссылкой
// на исходную.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { fakeModelService, fakeModelClassification } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { normalizeClassification } from '../server/classifier.js';

const RAW = [
  'Созванивались по ВойсОпс',
  '',
  'Что решили, 2 вектора',
  '1. Допинываем бот детектор',
  '2. Допинываем карусель с генератором фраз',
].join('\n');

function app() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-split-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(directory, 'test.sqlite') });
}
async function eventually(assertion, timeout = 2000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { return await assertion(); } catch (error) { lastError = error; await new Promise(done => setTimeout(done, 25)); }
  }
  throw lastError;
}

test('запись с двумя намерениями рождает два дела со ссылкой на исходную', async () => {
  const api = authed(app());
  const created = await api.post('/api/captures').send({ raw: RAW }).expect(201);

  assert.equal(created.body.parts.length, 2, 'оба намерения отделены');
  assert.deepEqual(created.body.parts.map(part => part.title), ['Допинываем бот детектор', 'Допинываем карусель с генератором фраз']);
  // Исходная запись осталась одной записью: raw неизменяем, из него ничего не
  // вырезано, а отчёт о встрече остался отчётом.
  assert.equal(created.body.entry.raw, RAW);
  assert.equal(created.body.entry.parentId, null);
  assert.deepEqual(created.body.entry.parts.map(part => part.title), ['Допинываем бот детектор', 'Допинываем карусель с генератором фраз']);

  const entries = (await api.get('/api/entries?limit=20').expect(200)).body.entries;
  assert.equal(entries.length, 3, 'исходная запись и два дела');
  const child = entries.find(entry => entry.raw === 'Допинываем бот детектор');
  assert.equal(child.interpretation.classification.primaryType, 'task', 'намерение стало делом');
  assert.equal(child.interpretation.classification.completed, false);
  assert.equal(child.parentId, created.body.entry.id);
  assert.equal(child.projections.length, 1);
  assert.equal(child.projections[0].type, 'task');
  // Срок намерения не назван — оно ложится на сегодня, как любое туду.
  assert.equal(child.interpretation.classification.entities.schedule.date, new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Samara' }).format(new Date()));

  const full = (await api.get(`/api/captures/${child.id}`).expect(200)).body.entry;
  assert.equal(full.parent.id, created.body.entry.id);
  assert.equal(full.parent.title, created.body.entry.interpretation.classification.summary);
});

test('дело, отделённое от записи, видно в дне как обычное дело', async () => {
  const api = authed(app());
  await api.post('/api/captures').send({ raw: RAW }).expect(201);
  const day = (await api.get('/api/day').expect(200)).body;
  const titles = day.attention.concat(day.day, day.upcoming).map(entry => entry.interpretation.classification.summary);
  assert.ok(titles.includes('Допинываем бот детектор'), 'дело попало в дневную сводку');
});

test('удаление отделённого дела не трогает исходную запись', async () => {
  const api = authed(app());
  const created = await api.post('/api/captures').send({ raw: RAW }).expect(201);
  const [first] = created.body.parts;
  await api.delete(`/api/captures/${first.id}`).expect(200);
  const parent = (await api.get(`/api/captures/${created.body.entry.id}`).expect(200)).body.entry;
  assert.deepEqual(parent.parts.map(part => part.title), ['Допинываем карусель с генератором фраз'], 'удалённое дело ушло из списка');
  assert.equal(parent.raw, RAW);
  // Вернуть можно так же, как любую запись.
  await api.post(`/api/captures/${first.id}/restore`).expect(200);
  assert.equal((await api.get(`/api/captures/${created.body.entry.id}`)).body.entry.parts.length, 2);
});

test('асинхронный разбор отделяет дела так же, и они видны в статусе задачи', async () => {
  const application = app();
  const api = authed(application);
  application.captureJobWorker.start();
  try {
    const queued = await api.post('/api/captures').set('Prefer', 'respond-async').send({ raw: RAW }).expect(202);
    const done = await eventually(async () => {
      const status = (await api.get(queued.body.statusUrl)).body;
      assert.equal(status.state, 'succeeded');
      return status;
    });
    assert.deepEqual(done.parts.map(part => part.title), ['Допинываем бот детектор', 'Допинываем карусель с генератором фраз']);
  } finally {
    await application.captureJobWorker.stop();
  }
});

test('выдуманное действие отбрасывается: в журнал уходит только сказанное', () => {
  const raw = 'Созванивались по ВойсОпс, решили допинать бот детектор';
  const candidate = {
    primaryType: 'outcome_decision',
    entities: { projects: [], people: [], when: null, followUp: null },
    additionalTypes: [],
    summary: 'Итоги созвона по ВойсОпс',
    proposedActions: [
      { type: 'task', title: 'допинать бот детектор' },
      { type: 'task', title: 'Заодно переписать биллинг и уволить всех' },
      { type: 'task', title: 'мало' },
    ],
    completed: true,
    ambiguity: null,
  };
  const classification = normalizeClassification(candidate, raw);
  assert.deepEqual(classification.proposedActions, [{ type: 'task', title: 'допинать бот детектор' }]);
});

test('пересказ записи делом не становится: действие, повторяющее заголовок, отбрасывается', () => {
  const raw = 'Нужно допинать бот детектор';
  const classification = fakeModelClassification(raw);
  assert.deepEqual(classification.proposedActions, []);
  const api = authed(app());
  return api.post('/api/captures').send({ raw }).expect(201).then(created => {
    assert.equal(created.body.parts.length, 0, 'обычное дело не дробится само на себя');
  });
});
