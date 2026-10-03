import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

const makeApp = () => createApp({ databasePath: ':memory:', aiService: fakeModelService() });
const patch = (api, changes) => api.patch('/api/ui-preferences').send({ userId: api.user.id, changes });

test('UI preferences merge per key, persist resets, bootstrap and isolate accounts', async () => {
  const app = makeApp();
  const alice = authed(app);
  const bob = authed(app, { email: 'bob@test.local', role: 'user' });
  await request(app).get('/api/ui-preferences').expect(401);
  await patch(alice, { 'kizuna-capture-width': '900', 'kizuna-card-mode': 'side' }).expect(200);
  await Promise.all([
    patch(alice, { 'kizuna-board-view': 'list' }).expect(200),
    patch(alice, { 'kizuna-calendar-mode': 'month' }).expect(200),
  ]);
  const mine = (await alice.get('/api/ui-preferences').expect(200)).body;
  assert.equal(mine.revision, 3);
  assert.deepEqual(mine.values, { 'kizuna-capture-width': '900', 'kizuna-card-mode': 'side', 'kizuna-board-view': 'list', 'kizuna-calendar-mode': 'month' });
  assert.deepEqual((await bob.get('/api/ui-preferences').expect(200)).body.values, {});
  const html = (await alice.get('/').expect(200)).text;
  assert.deepEqual(JSON.parse(decodeURIComponent(html.match(/data-ui-preferences="([^"]+)"/)[1])), mine);
  await alice.patch('/api/ui-preferences').send({ userId: alice.user.id, changes: { 'kizuna-capture-width': '700' }, onlyIfMissing: ['kizuna-capture-width'] }).expect(200);
  assert.equal((await alice.get('/api/ui-preferences')).body.values['kizuna-capture-width'], '900');
  await patch(alice, { 'kizuna-capture-width': null }).expect(200);
  const reset = (await alice.get('/api/ui-preferences')).body;
  assert.equal(reset.values['kizuna-capture-width'], null);
  assert.equal(reset.values['kizuna-board-view'], 'list');
  await bob.patch('/api/ui-preferences').send({ userId: alice.user.id, changes: { 'kizuna-card-mode': 'full' } }).expect(409);
  assert.deepEqual((await bob.get('/api/ui-preferences')).body.values, {});
  app.database.close();
});

test('UI preference whitelist validates the entire patch before writing', async () => {
  const app = makeApp();
  const api = authed(app);
  for (const changes of [
    { 'openaiKey': 'secret' }, { 'pagent.active-captures': '[]' },
    { 'kizuna-card-mode': 'invalid' }, { 'kizuna-capture-width': '-1' },
    { 'kizuna-board-filter': '{broken' }, { 'kizuna-notes-expanded': '{}' },
    { 'kizuna-capture-width': '900', 'kizuna-calendar-height': 'Infinity' },
    { 'kizuna-card-size': '{"w":99999999}' },
  ]) await patch(api, changes).expect(400);
  assert.deepEqual((await api.get('/api/ui-preferences')).body.values, {});
  app.database.close();
});

test('theme stays consistent through the existing settings API and UI preference API', async () => {
  const app = makeApp(), api = authed(app);
  await api.put('/api/settings').send({ theme: 'dark' }).expect(200);
  // An upgraded account can initially have only the legacy personal setting.
  app.database.prepare('DELETE FROM app_settings WHERE key=?').run(`uiPreferences:${api.user.id}`);
  let record = (await api.get('/api/ui-preferences')).body;
  assert.equal(record.values['pagent.theme'], 'dark');
  const revision = record.revision;
  await patch(api, { 'pagent.theme': 'light' }).expect(200);
  assert.equal((await api.get('/api/settings')).body.settings.theme, 'light');
  await api.put('/api/settings').send({ theme: 'dark' }).expect(200);
  record = (await api.get('/api/ui-preferences')).body;
  assert.equal(record.values['pagent.theme'], 'dark');
  assert.equal(record.revision, revision + 2);
  app.database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('theme', 'dark', new Date().toISOString());
  let settings = await api.put('/api/settings').send({ theme: 'system' }).expect(200);
  assert.equal(settings.body.settings.theme, 'system');
  assert.equal(app.database.prepare('SELECT value FROM app_settings WHERE key=?').get(`user:${api.user.id}:theme`).value, 'system');
  assert.equal((await api.get('/api/ui-preferences')).body.values['pagent.theme'], null);
  settings = await api.put('/api/settings').send({ theme: null }).expect(200);
  assert.equal(settings.body.settings.theme, 'dark');
  assert.equal((await api.get('/api/ui-preferences')).body.values['pagent.theme'], 'dark');
  await patch(api, { 'pagent.theme': 'light' }).expect(200);
  const reset = await patch(api, { 'pagent.theme': null }).expect(200);
  assert.equal(reset.body.values['pagent.theme'], 'dark');
  assert.equal((await api.get('/api/settings')).body.settings.theme, 'dark');
  app.database.close();
});
