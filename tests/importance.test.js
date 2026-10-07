import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { parseCaptureOverrides } from '../server/classifier.js';
import { journalOverview } from '../server/journal.js';
import { IMPORTANCE } from '../public/importance.js';
import { translate, SUPPORTED_LOCALES } from '../public/i18n.js';

test('all explicit flags can be captured, and unknown values are rejected', () => {
  for (const priority of ['highest', 'high', 'low'])
    assert.equal(parseCaptureOverrides({ priority }).overrides.priority, priority);
  for (const priority of ['urgent', 1, 'Highest'])
    assert.equal(parseCaptureOverrides({ priority }).error, 'invalid_priority');
});

test('priority changes survive reopening SQLite, preserve due/completion and remain owner-only', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-importance-'));
  const databasePath = path.join(directory, 'ledger.sqlite');
  const application = createApp({ aiService: fakeModelService(), databasePath });
  const api = authed(application);
  const date = (await api.get('/api/day')).body.date;
  const created = (await api.post('/api/captures').send({ raw: 'Проверить важность', priority: 'highest', due: { date, time: '15:00' } }).expect(201)).body.entry;
  const captureId = created.id;
  const projectionId = created.projections.find(p => p.type === 'task').id;
  await api.post(`/api/projections/${projectionId}/complete`).send({}).expect(200);
  for (const priority of ['low', 'high', 'highest', 'normal', 'highest']) {
    const result = (await api.post(`/api/captures/${captureId}/corrections`).set('Idempotency-Key', crypto.randomUUID()).send({ patch: { priority } }).expect(200)).body.entry;
    const classification = result.interpretation.classification;
    assert.equal(classification.priority || 'normal', priority);
    assert.equal(classification.entities.schedule.date, date);
    assert.equal(classification.entities.schedule.time, '15:00');
    assert.ok(result.projections.some(p => p.type === 'task' && p.completion.completed));
  }
  const stranger = authed(application, { email: 'stranger@kizuna.test' });
  await stranger.post(`/api/captures/${captureId}/corrections`).send({ patch: { priority: 'low' } }).expect(404);
  await api.post(`/api/captures/${captureId}/corrections`).send({ patch: { priority: 'urgent' } }).expect(400);
  const reopened = createApp({ aiService: fakeModelService(), databasePath });
  const reread = (await authed(reopened).get(`/api/captures/${captureId}`).expect(200)).body.entry;
  assert.equal(reread.interpretation.classification.priority, 'highest');
  assert.equal(reread.interpretation.classification.entities.schedule.time, '15:00');
  assert.ok(reread.projections.some(p => p.type === 'task' && p.completion.completed));
  application.database.close(); reopened.database.close(); fs.rmSync(directory, { recursive: true });
});

test('highest appears in journal filters, board, calendar and important-open count', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-importance-views-'));
  const application = createApp({ aiService: fakeModelService(), databasePath: path.join(directory, 'ledger.sqlite') });
  const api = authed(application);
  const date = (await api.get('/api/day')).body.date;
  const entry = (await api.post('/api/captures').send({ raw: 'Самое важное дело', priority: 'highest', due: { date, time: '14:00' } }).expect(201)).body.entry;
  await api.post('/api/captures').send({ raw: 'Обычное дело', due: { date } }).expect(201);
  const overview = journalOverview(application.database, { userId: api.user.id });
  assert.equal(overview.flags.high, 1);
  const journal = (await api.get('/api/journal/entries?priority=highest').expect(200)).body;
  assert.deepEqual(journal.items.map(e => e.captureId), [entry.id]);
  const calendar = (await api.get(`/api/calendar?from=${date}&to=${date}`).expect(200)).body;
  assert.equal(calendar.items.find(item => item.id === entry.id)?.priority, 'highest');
  const board = (await api.get('/api/board').expect(200)).body;
  assert.ok(JSON.stringify(board).includes('"priority":"highest"'));
  application.database.close(); fs.rmSync(directory, { recursive: true });
});

test('each importance name and hint is translated for every supported language', () => {
  for (const locale of SUPPORTED_LOCALES) for (const option of IMPORTANCE) {
    assert.ok(translate(locale, option.label));
    assert.ok(translate(locale, option.hint));
    if (locale !== 'ru') {
      assert.notEqual(translate(locale, option.label), option.label);
      assert.notEqual(translate(locale, option.hint), option.hint);
    }
  }
});
