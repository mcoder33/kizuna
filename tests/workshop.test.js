import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import request from './helpers/http.js';
import { createApp } from '../server/index.js';
import { createWorkshopAccess } from '../server/workshop-access.js';
import { chooseRoom, roomAsset } from '../public/workshop-scenes.js';
import { validUiPreference } from '../public/ui-preference-schema.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';
import { workshopCatalogs } from '../public/workshop-i18n.js';

test('the delivered artwork covers every room with bounded WebP payloads', () => {
  const directory = new URL('../public/workshop/', import.meta.url);
  const { assets } = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
  const expected = ['torii-guide.webp'];
  for (const season of ['winter', 'spring', 'summer', 'autumn']) for (const light of ['day', 'night']) for (const size of ['desktop', 'mobile']) expected.push(`${season}-${light}-${size}.webp`);
  assert.deepEqual(assets.map(asset => asset.file).sort(), expected.sort());
  assert.deepEqual(readdirSync(directory).filter(file => file.endsWith('.webp')).sort(), expected.sort());
  for (const asset of assets) {
    const bytes = readFileSync(new URL(asset.file, directory));
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    assert.equal(bytes.length, asset.bytes);
    assert.ok(bytes.length < 256 * 1024, `${asset.file} exceeds its delivery budget`);
  }
});

test('workshop settings and guide phrases are complete in all seven supported locales', () => {
  assert.deepEqual(Object.keys(workshopCatalogs).sort(), ['ru', 'en', 'es', 'pt-BR', 'de', 'fr', 'ja'].sort());
  const keys = Object.keys(workshopCatalogs.ru).sort();
  for (const [locale, phrases] of Object.entries(workshopCatalogs)) {
    assert.deepEqual(Object.keys(phrases).sort(), keys, locale);
    assert.ok(Object.values(phrases).every(value => typeof value === 'string' && value.trim()), locale);
    if (locale !== 'ru') assert.notEqual(phrases['Тории рядом'], 'Тории рядом');
  }
});

const ALICE = 'abcdef01-2345-4678-9abc-def012345678';
const BOB = '10203040-5060-4780-90ab-cdef12345678';
const sceneAt = (instant, options = {}) => chooseRoom({ date: new Date(instant), timeZone: 'UTC', ...options });
const patch = (api, changes) => api.patch('/api/ui-preferences').send({ userId: api.user.id, changes });
const bootstrap = html => JSON.parse(decodeURIComponent(html.match(/data-ui-preferences="([^"]+)"/)[1]));

function workshopEnv(t, mode, ids) {
  const before = new Map(['PAGENT_WORKSHOP_MODE', 'PAGENT_WORKSHOP_USER_IDS'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  if (mode === undefined) delete process.env.PAGENT_WORKSHOP_MODE;
  else process.env.PAGENT_WORKSHOP_MODE = mode;
  if (ids === undefined) delete process.env.PAGENT_WORKSHOP_USER_IDS;
  else process.env.PAGENT_WORKSHOP_USER_IDS = ids;
}

function appFor(t) {
  const app = createApp({ databasePath: ':memory:', aiService: fakeModelService() });
  t.after(() => app.database.close());
  return app;
}

test('workshop access defaults off and unrecognized modes fail closed', () => {
  for (const mode of [undefined, '', 'ALLOWLIST', 'enabled', 'all ']) {
    const gate = createWorkshopAccess({ env: () => ({ PAGENT_WORKSHOP_MODE: mode, PAGENT_WORKSHOP_USER_IDS: ALICE }) });
    assert.equal(gate.allows(ALICE), false, String(mode));
    assert.equal(gate.publicEnabled(), false);
    assert.deepEqual(gate.capabilities(ALICE), { workshopAppearance: false });
  }
});

test('workshop allowlist validates every UUID, is case insensitive and never opens public pages', () => {
  let env = { PAGENT_WORKSHOP_MODE: 'allowlist', PAGENT_WORKSHOP_USER_IDS: ` ${ALICE.toUpperCase()},\n${BOB} ` };
  const gate = createWorkshopAccess({ env: () => env });
  assert.equal(gate.allows(ALICE), true);
  assert.equal(gate.allows(BOB.toUpperCase()), true);
  assert.equal(gate.allows('12345678-1234-4234-8234-123456789abc'), false);
  assert.equal(gate.publicEnabled(), false);
  assert.deepEqual(gate.capabilities(ALICE), { workshopAppearance: true });
  for (const invalidList of ['', ' ', `${ALICE},not-a-uuid`, `${ALICE},${BOB.slice(1)}`, `${ALICE},`]) {
    env = { ...env, PAGENT_WORKSHOP_USER_IDS: invalidList };
    assert.equal(gate.allows(ALICE), false, invalidList);
    assert.deepEqual(gate.capabilities(ALICE), { workshopAppearance: false });
  }
});

test('all mode permits valid account IDs but rejects anonymous/malformed IDs; revocation is live', () => {
  let env = { PAGENT_WORKSHOP_MODE: 'all' };
  const gate = createWorkshopAccess({ env: () => env });
  assert.equal(gate.publicEnabled(), true);
  assert.equal(gate.allows(ALICE), true);
  assert.equal(gate.allows(BOB), true);
  for (const invalidId of [null, undefined, 12, '', 'guest', ` ${ALICE}`, `${ALICE}x`, ALICE.replace('-', ''), ALICE.replace('a', 'g')]) {
    assert.equal(gate.allows(invalidId), false, String(invalidId));
  }
  env = { PAGENT_WORKSHOP_MODE: 'off', PAGENT_WORKSHOP_USER_IDS: ALICE };
  assert.equal(gate.publicEnabled(), false);
  assert.deepEqual(gate.capabilities(ALICE), { workshopAppearance: false });
});

test('automatic room season covers all months and follows the local month boundary', () => {
  const seasons = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
  seasons.forEach((season, index) => {
    const month = String(index + 1).padStart(2, '0');
    assert.equal(sceneAt(`2026-${month}-15T12:00:00Z`).season, season, month);
  });
  assert.equal(sceneAt('2026-02-28T19:59:59Z', { timeZone: 'Europe/Samara' }).season, 'winter');
  assert.equal(sceneAt('2026-02-28T20:00:00Z', { timeZone: 'Europe/Samara' }).season, 'spring');
  assert.equal(sceneAt('2026-05-31T19:59:59Z', { timeZone: 'Europe/Samara' }).season, 'spring');
  assert.equal(sceneAt('2026-05-31T20:00:00Z', { timeZone: 'Europe/Samara' }).season, 'summer');
  assert.equal(sceneAt('2026-08-31T20:00:00Z', { timeZone: 'Europe/Samara' }).season, 'autumn');
  assert.equal(sceneAt('2026-11-30T20:00:00Z', { timeZone: 'Europe/Samara' }).season, 'winter');
});

test('daylight includes 07:00, excludes 19:00, and uses the selected timezone including DST', () => {
  for (const [time, light] of [['06:59:59', 'night'], ['07:00:00', 'day'], ['18:59:59', 'day'], ['19:00:00', 'night'], ['00:00:00', 'night']]) {
    assert.equal(sceneAt(`2026-06-15T${time}Z`).light, light, time);
  }
  for (const [instant, light] of [['2026-06-15T02:59:59Z', 'night'], ['2026-06-15T03:00:00Z', 'day'], ['2026-06-15T14:59:59Z', 'day'], ['2026-06-15T15:00:00Z', 'night']]) {
    assert.equal(sceneAt(instant, { timeZone: 'Europe/Samara' }).light, light, instant);
  }
  // New York's 07:00 is 12:00 UTC before DST and 11:00 UTC after it.
  assert.equal(sceneAt('2026-03-07T11:59:59Z', { timeZone: 'America/New_York' }).light, 'night');
  assert.equal(sceneAt('2026-03-07T12:00:00Z', { timeZone: 'America/New_York' }).light, 'day');
  assert.equal(sceneAt('2026-03-08T10:59:59Z', { timeZone: 'America/New_York' }).light, 'night');
  assert.equal(sceneAt('2026-03-08T11:00:00Z', { timeZone: 'America/New_York' }).light, 'day');
});

test('invalid timezone falls back to UTC; explicit room choices survive automatic boundaries', () => {
  assert.deepEqual(sceneAt('2026-06-01T06:59:59Z', { timeZone: 'invalid/zone' }), { season: 'summer', light: 'night' });
  assert.deepEqual(sceneAt('2026-06-01T07:00:00Z', { timeZone: 'invalid/zone' }), { season: 'summer', light: 'day' });
  assert.deepEqual(sceneAt('2026-06-01T07:00:00Z', { season: 'winter', light: 'night' }), { season: 'winter', light: 'night' });
  assert.deepEqual(sceneAt('2026-12-01T19:00:00Z', { season: 'summer', light: 'day' }), { season: 'summer', light: 'day' });
  assert.deepEqual(sceneAt('2026-06-01T12:00:00Z', { season: '../../escape', light: 'invalid' }), { season: 'summer', light: 'day' });
});

test('room assets only resolve bounded seasonal variants and distinguish compact images', () => {
  for (const season of ['winter', 'spring', 'summer', 'autumn']) {
    for (const light of ['day', 'night']) {
      assert.equal(roomAsset({ season, light }), `/public/workshop/${season}-${light}-desktop.webp`);
      assert.equal(roomAsset({ season, light }, true), `/public/workshop/${season}-${light}-mobile.webp`);
    }
  }
  assert.equal(roomAsset({ season: '../secret', light: 'day' }), null);
  assert.equal(roomAsset({ season: 'summer', light: 'invalid' }), null);
});

test('schema permits only bounded workshop appearance, room and Torii view preferences', () => {
  const choices = {
    'kizuna-appearance': ['classic', 'workshop'],
    'kizuna-room-season': ['auto', 'winter', 'spring', 'summer', 'autumn'],
    'kizuna-room-light': ['auto', 'day', 'night'],
    'kizuna-torii-hints': ['enabled', 'disabled'],
  };
  for (const [key, values] of Object.entries(choices)) {
    for (const value of [...values, null]) assert.equal(validUiPreference(key, value), true, `${key}:${value}`);
    for (const value of ['', 'unknown', 'WORKSHOP', 1, {}, true]) assert.equal(validUiPreference(key, value), false, `${key}:${value}`);
  }
  const key = 'kizuna-torii-dismissed';
  for (const value of [null, '[]', '["first-step","empty-day"]', JSON.stringify(Array.from({ length: 32 }, (_, i) => `tip-${i}`))]) assert.equal(validUiPreference(key, value), true);
  for (const value of ['{broken', '{}', '[1]', '["same","same"]', '["Bad"]', '["../escape"]', JSON.stringify(['a'.repeat(65)]), JSON.stringify(Array.from({ length: 33 }, (_, i) => `tip-${i}`))]) assert.equal(validUiPreference(key, value), false, value);
  assert.equal(validUiPreference('kizuna-room-image', '/external.webp'), false);
});

test('off mode exposes no capability and rejects workshop changes atomically without losing unrelated preferences', async t => {
  workshopEnv(t, undefined);
  const app = appFor(t), api = authed(app);
  await patch(api, { 'kizuna-card-mode': 'side' }).expect(200);
  const before = (await api.get('/api/ui-preferences').expect(200)).body;
  assert.deepEqual(before.capabilities, { workshopAppearance: false });
  const response = await patch(api, { 'kizuna-appearance': 'workshop', 'kizuna-card-mode': 'full' }).expect(403);
  assert.equal(response.body.error.code, 'workshop_unavailable');
  assert.deepEqual((await api.get('/api/ui-preferences')).body, before);
  assert.deepEqual((await api.get('/api/settings')).body.capabilities, { workshopAppearance: false });
  await patch(api, { 'kizuna-appearance': 'classic' }).expect(200);
  const html = (await api.get('/').expect(200)).text;
  assert.match(html, /data-workshop-enabled="false"/);
  assert.equal(bootstrap(html).capabilities.workshopAppearance, false);
});

test('allowlist isolates account choices, rejects stale account patches, and revokes access without deleting saved choices', async t => {
  workshopEnv(t, 'allowlist');
  const app = appFor(t), alice = authed(app), bob = authed(app, { email: 'workshop-bob@test.local', role: 'user' });
  process.env.PAGENT_WORKSHOP_USER_IDS = alice.user.id;
  const values = { 'kizuna-appearance': 'workshop', 'kizuna-room-season': 'winter', 'kizuna-room-light': 'night', 'kizuna-torii-hints': 'disabled', 'kizuna-torii-dismissed': '["empty-day"]' };
  await patch(alice, values).expect(200);
  const saved = (await alice.get('/api/ui-preferences')).body;
  assert.deepEqual(saved.values, values);
  assert.equal(saved.capabilities.workshopAppearance, true);
  assert.equal((await alice.get('/api/settings')).body.capabilities.workshopAppearance, true);
  const bobBefore = (await bob.get('/api/ui-preferences')).body;
  assert.deepEqual(bobBefore.values, {});
  assert.equal(bobBefore.capabilities.workshopAppearance, false);
  await patch(bob, { 'kizuna-appearance': 'workshop' }).expect(403);
  const stale = await bob.patch('/api/ui-preferences').send({ userId: alice.user.id, changes: { 'kizuna-room-season': 'summer' } }).expect(409);
  assert.equal(stale.body.error.code, 'account_changed');
  assert.deepEqual((await bob.get('/api/ui-preferences')).body, bobBefore);
  assert.deepEqual((await alice.get('/api/ui-preferences')).body, saved);
  const aliceHtml = (await alice.get('/')).text, bobHtml = (await bob.get('/')).text;
  assert.match(aliceHtml, /data-workshop-enabled="true"/);
  assert.deepEqual(bootstrap(aliceHtml), saved);
  assert.match(bobHtml, /data-workshop-enabled="false"/);
  assert.deepEqual(bootstrap(bobHtml), bobBefore);

  // The same running application re-evaluates a changed allowlist.
  process.env.PAGENT_WORKSHOP_USER_IDS = bob.user.id;
  const revoked = (await alice.get('/api/ui-preferences')).body;
  assert.equal(revoked.capabilities.workshopAppearance, false);
  assert.equal(revoked.revision, saved.revision);
  assert.deepEqual(revoked.values, values);
  await patch(alice, { 'kizuna-appearance': 'workshop' }).expect(403);
  await patch(alice, { 'kizuna-card-mode': 'full' }).expect(200);
  assert.equal((await alice.get('/api/ui-preferences')).body.values['kizuna-appearance'], 'workshop');
  const revokedHtml = (await alice.get('/')).text;
  assert.match(revokedHtml, /data-workshop-enabled="false"/);
  assert.equal(bootstrap(revokedHtml).values['kizuna-appearance'], 'workshop');
  assert.equal(bootstrap(revokedHtml).capabilities.workshopAppearance, false);
  await patch(bob, { 'kizuna-appearance': 'workshop', 'kizuna-room-season': 'summer' }).expect(200);
  assert.equal((await alice.get('/api/ui-preferences')).body.values['kizuna-room-season'], 'winter');
  assert.equal((await bob.get('/api/ui-preferences')).body.values['kizuna-room-season'], 'summer');
  await patch(alice, { 'kizuna-appearance': null }).expect(200);
});

test('invalid workshop preferences reject the entire API patch and leave its revision unchanged', async t => {
  workshopEnv(t, 'all');
  const app = appFor(t), api = authed(app);
  await patch(api, { 'kizuna-appearance': 'workshop', 'kizuna-room-season': 'winter' }).expect(200);
  const before = (await api.get('/api/ui-preferences')).body;
  for (const changes of [
    { 'kizuna-appearance': 'invalid' },
    { 'kizuna-room-season': 'monsoon', 'kizuna-card-mode': 'full' },
    { 'kizuna-room-light': true },
    { 'kizuna-torii-hints': 'always' },
    { 'kizuna-torii-dismissed': '["same","same"]' },
  ]) await patch(api, changes).expect(400);
  assert.deepEqual((await api.get('/api/ui-preferences')).body, before);
});

test('public entry and direct HTML routes stay classic for off/allowlist and opt in only for all', async t => {
  workshopEnv(t, 'off', ALICE);
  const app = appFor(t);
  for (const mode of ['off', 'allowlist', 'all', 'invalid']) {
    process.env.PAGENT_WORKSHOP_MODE = mode;
    const appearance = mode === 'all' ? 'workshop' : 'classic';
    for (const path of ['/', '/login', '/login?join', '/public/auth.html', '/public/hello.html', '/public/mac-download.html']) {
      const response = await request(app).get(path).expect(200);
      assert.match(response.text, new RegExp(`data-public-appearance="${appearance}"`), `${mode}:${path}`);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.doesNotMatch(response.text, /data-account-id=/);
    }
  }
});
