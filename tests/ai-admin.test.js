import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { recordUsage } from '../server/db.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

function fresh() {
  return createApp({ databasePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-admin-')), 'test.sqlite'), aiService: fakeModelService() });
}

test('users receive only personal settings and cannot read or override service AI or costs', async () => {
  const app = fresh(), admin = authed(app), user = authed(app, { email: 'person@kizuna.test', role: 'user' });
  await admin.put('/api/settings').send({ aiProvider: 'openrouter', openrouterModel: 'fake/deep', openrouterKey: 'private-key-1234', monthlyLimitUsd: '10' }).expect(200);
  const payload = (await user.get('/api/settings').expect(200)).body;
  for (const field of ['aiProvider', 'aiModel', 'openrouterModel', 'geminiModel', 'openrouterKey', 'monthlyLimitUsd', 'modelReasoning', 'googleClientId', 'timeZone']) {
    assert.equal(Object.hasOwn(payload.settings, field), false, field);
    assert.equal(payload.editable.includes(field), false, field);
  }
  assert.equal(payload.spend, undefined);
  await user.put('/api/settings').send({ remindDefault: '30', requestedTimeZone: 'Asia/Tokyo' }).expect(200);
  for (const route of ['/api/usage', '/api/status', '/api/admin/usage', '/api/admin/ai/status', '/api/admin/reports']) await user.get(route).expect(403);
  for (const patch of [{ aiProvider: 'fallback' }, { aiModel: 'fake/fast' }, { openrouterModel: 'fake/fast' }]) await user.put('/api/settings').send(patch).expect(403);
  for (const body of [{ provider: 'fallback' }, { model: 'fake/fast' }]) {
    await user.post('/api/captures').send({ raw: 'Моя запись', ...body }).expect(403);
    await user.post('/api/memory/answer').send({ query: 'Мои записи', ...body }).expect(403);
  }
  const capture = (await user.post('/api/captures').send({ raw: 'Моя запись' }).expect(201)).body.entry;
  await user.post(`/api/captures/${capture.id}/classify`).send({ provider: 'fallback' }).expect(403);
  const report = (await user.get('/api/reports?period=week').expect(200)).body;
  assert.equal(report.counters.captures, 1);
  assert.equal(report.service, undefined);
  assert.equal((await admin.get('/api/reports?period=week').expect(200)).body.service, undefined);
  assert.equal((await admin.get('/api/settings').expect(200)).body.settings.openrouterModel, 'fake/deep');
});

test('administration aggregates expenses from every account and retains per-user accounting', async () => {
  const app = fresh(), admin = authed(app), first = authed(app, { email: 'first@kizuna.test', role: 'user' }), second = authed(app, { email: 'second@kizuna.test', role: 'user' });
  recordUsage(app.database, { provider: 'openrouter', model: 'fake/deep', costUsd: 0.25, inputTokens: 100, userId: first.user.id });
  recordUsage(app.database, { provider: 'openai', model: 'fake/text', costUsd: 0.5, inputTokens: 200, userId: second.user.id });
  recordUsage(app.database, { provider: 'openai', model: 'legacy', costUsd: null });
  const total = (await admin.get('/api/admin/usage').expect(200)).body.total;
  assert.equal(total.calls, 3);
  assert.equal(total.costUsd, 0.75);
  assert.equal(total.inputTokens, 300);
  assert.equal(total.unpriced, 1);
  const own = (await admin.get(`/api/admin/usage?userId=${first.user.id}`).expect(200)).body;
  assert.equal(own.total.calls, 1);
  assert.equal(own.total.costUsd, 0.25);
  for (const period of ['week', 'month', 'all']) {
    const report = (await admin.get(`/api/admin/reports?period=${period}`).expect(200)).body;
    assert.equal(report.service.usage.calls, 3);
    assert.equal(report.service.usage.costUsd, 0.75);
  }
  await admin.get('/api/admin/usage?userId=missing').expect(404);
  await admin.get('/api/admin/reports?period=invalid').expect(400);
});

test('expense thresholds notify administrators and stay out of personal notification feeds', async () => {
  const app = fresh(), admin = authed(app), user = authed(app, { email: 'budget@kizuna.test', role: 'user' });
  await admin.post(`/api/admin/users/${user.user.id}/limits`).send({ monthlyLimitUsd: '1' }).expect(200);
  recordUsage(app.database, { provider: 'openrouter', costUsd: 0.85, userId: user.user.id });
  await app.notificationTick();
  await app.notificationTick();
  const notices = (await admin.get('/api/admin/inbox').expect(200)).body.notifications.filter(row => row.kind === 'spend');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.url, `/#admin/users?user=${user.user.id}`);
  for (const api of [admin, user]) {
    const feed = (await api.get('/api/notifications?scope=personal').expect(200)).body;
    assert.equal(feed.notifications.some(row => row.kind === 'spend'), false);
    assert.equal(feed.kinds.some(row => row.key === 'spend'), false);
  }
});
