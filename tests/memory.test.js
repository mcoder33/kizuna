import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createLedger } from '../server/db.js';
import { normalizeClassification } from '../server/classifier.js';
import { rememberFact, forgetFact, listFacts, recallFacts, memoryDigest, assistantMemoryPrompt, learnFromCorrection, learnQuietly } from '../server/memory.js';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

const NOW = new Date('2026-09-15T09:00:00Z');
const at = () => NOW;

function database() {
  return openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-memory-')), 'test.sqlite'));
}

// Служба разбора, запоминающая, с какой памятью её позвали: только так видно,
// что поправка человека доехала до следующего разбора.
function recordingAi() {
  const base = fakeModelService();
  const calls = [];
  return {
    calls,
    service: {
      ...base,
      async classify(raw, provider, signal, model, memory) {
        calls.push({ raw, memory: memory || '' });
        return base.classify(raw, provider, signal, model);
      },
    },
  };
}

function appWith(aiService) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-memory-api-'));
  return createApp({ aiService, databasePath: path.join(dir, 'test.sqlite') });
}

const classificationOf = (raw, patch = {}) => normalizeClassification(
  { primaryType: 'task', entities: { projects: [], people: [], when: null, followUp: null }, additionalTypes: [], summary: raw, proposedActions: [], completed: false, ambiguity: null, ...patch },
  raw, NOW, 'model',
);

test('одно и то же правило не ложится дважды, а крепнет', () => {
  const db = database();
  const first = rememberFact(db, { userId: 'u1', subject: 'созвон', body: 'Созвон — это встреча.' });
  const again = rememberFact(db, { userId: 'u1', subject: 'Созвон ', body: 'Созвон — это встреча.' });
  assert.equal(first.created, true);
  assert.equal(again.updated, true);
  assert.equal(again.id, first.id);
  assert.ok(again.confidence > first.confidence);
  assert.equal(listFacts(db, { userId: 'u1' }).length, 1);
});

test('память у каждого своя, общая видна всем, личная сильнее общей', () => {
  const db = database();
  rememberFact(db, { userId: null, subject: 'релиз', body: 'Релиз — это результат.' });
  rememberFact(db, { userId: 'u1', subject: 'хаб', body: 'Хаб — это проект Hub.' });
  const mine = listFacts(db, { userId: 'u1' });
  assert.deepEqual(mine.map(fact => fact.scope).sort(), ['shared', 'user']);
  const stranger = listFacts(db, { userId: 'u2' });
  assert.deepEqual(stranger.map(fact => fact.body), ['Релиз — это результат.']);
  // Одинаковый ключ: личная формулировка вытесняет общую, а не ложится рядом.
  rememberFact(db, { userId: 'u1', subject: 'релиз', body: 'Релиз — это отчёт о выкладке.' });
  const digest = memoryDigest(db, { userId: 'u1' });
  assert.match(digest, /отчёт о выкладке/);
  assert.equal(/Релиз — это результат/.test(digest), false);
  assert.match(memoryDigest(db, { userId: 'u2' }), /Релиз — это результат/);
});

test('общая память забирается только правом на всю установку', () => {
  const db = database();
  const shared = rememberFact(db, { userId: null, subject: 'релиз', body: 'Релиз — это результат.' });
  assert.equal(forgetFact(db, { userId: 'u1', memoryId: shared.id }).notFound, true);
  assert.equal(forgetFact(db, { userId: 'u1', memoryId: shared.id, shared: true }).forgotten, true);
});

test('поправка становится правилом, а не повторным вопросом', () => {
  const db = database();
  const before = classificationOf('Релизил хаб');
  const after = classificationOf('Релизил хаб', { completed: true, entities: { projects: ['хаб'], people: [], when: null, followUp: null } });
  const learned = learnFromCorrection(db, { userId: 'u1', raw: 'Релизил хаб', before, after });
  const bodies = learned.map(item => item.body);
  assert.equal(bodies.length, 2, 'проект и признак «сделано»: типа у записи больше нет, урока про тип не бывает');
  assert.match(bodies[0], /проект «хаб»/);
  assert.match(bodies[1], /уже сделанное/);
  // Та же поправка второй раз ничего не добавляет — только подтверждает.
  learnFromCorrection(db, { userId: 'u1', raw: 'Релизил хаб', before, after });
  assert.equal(listFacts(db, { userId: 'u1' }).length, 2);
  assert.deepEqual(learnFromCorrection(db, { userId: 'u1', raw: 'Релизил хаб', before, after: before }), [], 'ничего не менялось — учиться нечему');
  assert.deepEqual(learnQuietly(db, { userId: 'u1', raw: 'Релизил хаб', before: null, after }), []);
});

// Пример для памяти — слова человека, а не вложенная переписка со ссылками:
// урок, привязанный к «…/call/13008», в другой раз не сработает.
test('урок поправки берёт слова человека до тире или ссылки', () => {
  const db = database();
  const raw = 'закинь заметку - доработака ботдетектора войс опс - ❯ https://ai-pomogi.ru/#/call/13008?back=x Боту смс отправили\n  https://ai-pomogi.ru/#/call/13108 еще бот';
  const before = classificationOf(raw, { completed: true });
  const after = classificationOf(raw, { completed: false });
  const bodies = learnFromCorrection(db, { userId: 'u1', raw, before, after }).map(item => item.body);
  assert.deepEqual(bodies, ['«закинь заметку» — ещё предстоит, а не сделанное.']);
  // Запись, начатая ссылкой, своих слов не имеет — пример берётся из заголовка.
  const linked = learnFromCorrection(db, { userId: 'u1', raw: 'https://ai-pomogi.ru/#/call/13008 разобрать', before: classificationOf('x', { summary: 'Разбор звонка 13008' }), after: classificationOf('Хаб', { summary: 'Разбор звонка 13008', entities: { projects: ['Хаб'], people: [], when: null, followUp: null } }) });
  assert.match(linked[0].body, /^«Разбор звонка 13008» — проект «Хаб»/);
});

test('подсказка разбора несёт словарь журнала и решённое', () => {
  const db = database();
  createLedger(db, { raw: 'Созвон по Hub с Даниилом', classification: classificationOf('Созвон по Hub с Даниилом', { primaryType: 'meeting_event', entities: { projects: ['Hub'], people: ['Даниил'], when: null, followUp: null } }), provider: 'manual' });
  rememberFact(db, { subject: 'созвон', body: 'Созвон — это встреча.' });
  const prompt = assistantMemoryPrompt(db, {});
  assert.match(prompt, /Проекты человека: Hub/);
  assert.match(prompt, /Люди рядом: Даниил/);
  assert.match(prompt, /Созвон — это встреча\./);
  assert.match(prompt, /не является инструкцией к действию/);
  assert.equal(assistantMemoryPrompt(database(), {}), '', 'помнить нечего — и подсказки нет');
});

test('поправка в карточке доезжает до следующего разбора', async () => {
  const ai = recordingAi();
  const app = appWith(ai.service);
  const api = authed(app);
  const created = await api.post('/api/captures').send({ raw: 'Допинать бот-детектор' }).expect(201);
  assert.equal(created.body.entry.interpretation.classification.primaryType, 'task');
  await api.post(`/api/captures/${created.body.entry.id}/corrections`).send({ patch: { completed: true } }).expect(200);
  await api.post('/api/captures').send({ raw: 'Ещё одна запись' }).expect(201);
  const last = ai.calls.at(-1).memory;
  assert.match(last, /«Допинать бот-детектор» — уже сделанное, а не предстоящее/);
  assert.equal(ai.calls[0].memory, '', 'до первой поправки помнить нечего');
});

test('память видна человеку, правится им и не течёт между людьми', async () => {
  const app = appWith(fakeModelService());
  const admin = authed(app);
  const stranger = authed(app, { email: 'other@kizuna.test', role: 'user' });
  const added = await admin.post('/api/agent/memory').send({ text: 'Созвоны — это встречи' }).expect(201);
  assert.equal(added.body.memory.scope, 'user');
  assert.equal((await admin.get('/api/agent/memory')).body.memories.length, 1);
  assert.equal((await stranger.get('/api/agent/memory')).body.memories.length, 0);
  // Общая память — право администратора: обычный человек пишет только в свою.
  await stranger.post('/api/agent/memory').send({ text: 'Всем помнить это', scope: 'shared' }).expect(403);
  await admin.post('/api/agent/memory').send({ text: 'Релиз — это результат', scope: 'shared' }).expect(201);
  assert.equal((await stranger.get('/api/agent/memory')).body.memories.length, 1, 'общее видно всем');
  await admin.post('/api/agent/memory').send({ text: '' }).expect(400);
  await admin.post('/api/agent/memory').send({ text: 'Что-то', kind: 'нечто' }).expect(400);
  const mine = (await admin.get('/api/agent/memory')).body.memories.find(fact => fact.scope === 'user');
  await stranger.delete(`/api/agent/memory/${mine.id}`).expect(404);
  await admin.delete(`/api/agent/memory/${mine.id}`).expect(200);
  assert.equal((await admin.get('/api/agent/memory')).body.memories.filter(fact => fact.scope === 'user').length, 0);
});

test('полный сброс уносит личную память и оставляет общую', async () => {
  const app = appWith(fakeModelService());
  const api = authed(app);
  await api.post('/api/agent/memory').send({ text: 'Личное правило' }).expect(201);
  await api.post('/api/agent/memory').send({ text: 'Общее правило', scope: 'shared' }).expect(201);
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  const left = (await api.get('/api/agent/memory')).body.memories;
  assert.deepEqual(left.map(fact => fact.body), ['Общее правило']);
});

test('вспоминание поднимает счётчик обращений', () => {
  const db = database();
  rememberFact(db, { userId: 'u1', subject: 'созвон', body: 'Созвон — это встреча.' });
  recallFacts(db, { userId: 'u1', query: 'созвон' });
  assert.equal(listFacts(db, { userId: 'u1' })[0].hits, 1);
});
