import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import express from 'express';
import { createApp } from '../server/index.js';
import { createAdmission } from '../server/auth-admission.js';
import { createHttpSecurity, loopbackProxy, validOccurredAt } from '../server/security.js';
import { hashPasswordAsync, verifyPasswordAsync, totpCode } from '../server/auth.js';
import { authed, seedUser, TEST_PASSWORD } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';
import { claimCaptureJob, recordUsage, updateUser } from '../server/db.js';

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-security-'));
  return createApp({ databasePath: path.join(dir, 'test.sqlite'), aiService: fakeModelService(), ...options });
}

 test('admission has bounded memory/concurrency and denied pairs cannot drain global capacity', () => {
  let at = 0;
  const gate = createAdmission({ now: () => at, pairLimit: 1, ipLimit: 100, globalLimit: 2, maxConcurrent: 1, maxKeys: 10 });
  const release = gate.enter({ ip: 'a', email: 'a' }); assert.ok(release);
  assert.equal(gate.enter({ ip: 'b', email: 'b' }), null); release(); release(); assert.equal(gate.active, 0);
  for (let i = 0; i < 100; i++) assert.equal(gate.enter({ ip: 'a', email: 'a' }), null);
  const other = gate.enter({ ip: 'b', email: 'b' }); assert.ok(other); other();
  assert.equal(gate.enter({ ip: 'c', email: 'c' }), null);
  at = 60_001; const renewed = gate.enter({ ip: 'a', email: 'a' }); assert.ok(renewed); renewed();
  const bounded = createAdmission({ now: () => at, maxKeys: 4 });
  for (let i = 0; i < 100; i++) bounded.enter({ ip: String(i), email: String(i) })?.();
  assert.ok(bounded.size <= 4);
 });

 test('async password hashing preserves legacy format and lets the event loop progress', async () => {
  let timerRan = false; const timer = new Promise(resolve => setTimeout(() => { timerRan = true; resolve(); }, 0));
  const hashed = await hashPasswordAsync(TEST_PASSWORD); await timer;
  assert.equal(timerRan, true); assert.match(hashed, /^scrypt\$/);
  assert.equal(await verifyPasswordAsync(TEST_PASSWORD, hashed), true);
  assert.equal(await verifyPasswordAsync('wrong-password', hashed), false);
  assert.equal(await verifyPasswordAsync('x'.repeat(201), hashed), false);
 });

 test('HTTP admission precedes hashing, has Retry-After and isolates victims; audit records effective IP', async () => {
  const app = fixture({ authAdmissionOptions: { pairLimit: 1 } });
  seedUser(app, { email: 'victim@example.com' }); const api = request(app);
  await api.post('/api/auth/login').set('X-Forwarded-For', '192.0.2.1').send({ email: 'victim@example.com', password: 'wrong-password' }).expect(401);
  const denied = await api.post('/api/auth/login').set('X-Forwarded-For', '192.0.2.1').send({ email: 'victim@example.com', password: TEST_PASSWORD }).expect(429);
  assert.equal(denied.headers['retry-after'], '60');
  await api.post('/api/auth/login').set('X-Forwarded-For', '192.0.2.2').send({ email: 'victim@example.com', password: TEST_PASSWORD }).expect(200);
  assert.equal(app.database.prepare('SELECT locked_until FROM users').get().locked_until, null);
  assert.equal(app.database.prepare("SELECT ip FROM auth_events WHERE result='succeeded' AND event='login'").get().ip, '192.0.2.2');
  assert.equal(loopbackProxy('198.51.100.1'), false);
  assert.equal(loopbackProxy('::ffff:127.0.0.1'), true);
 });

 test('global headers cover guest/static/errors; canonical HTTPS cookies and aliases do not trust forwarded host', async () => {
  const app = fixture({ securityOptions: { publicUrl: 'https://yourkizuna.com' } }); const api = request(app);
  for (const route of ['/login', '/sw.js', '/manifest.webmanifest', '/missing']) {
    const response = await api.get(route);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  }
  const malformed = await api.post('/api/auth/login').set('Content-Type', 'application/json').send('{').expect(400);
  assert.ok(malformed.headers['content-security-policy']);
  const registered = await api.post('/api/auth/register').set('Origin', 'https://kizuna.agent-hub.space').send({ email: 'first@example.com', password: TEST_PASSWORD }).expect(201);
  assert.match(registered.headers['set-cookie'][0], /; Secure/);
  const security = createHttpSecurity({ publicUrl: 'https://yourkizuna.com' });
  assert.equal(security.baseUrl({ get: () => 'evil.example', protocol: 'http' }), 'https://yourkizuna.com');
  assert.throws(() => createHttpSecurity({ publicUrl: 'https://user:password@yourkizuna.com' }));
  assert.throws(() => createHttpSecurity({ publicUrl: 'http://example.com' }));
 });

 test('CSRF blocks foreign/null origins and cross-site browser posts before parsing or account mutation', async () => {
  const app = fixture(); const api = request(app);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await api.post('/api/auth/register').set(headers).send({ email: 'attacker@example.com', password: TEST_PASSWORD }).expect(403);
    assert.equal(response.body.error.code, 'invalid_origin');
  }
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  await api.post('/api/auth/register').set('Origin', 'https://yourkizuna.com').send({ email: 'allowed@example.com', password: TEST_PASSWORD }).expect(201);
 });

 test('sensitive operations need second factor and recovery is consumed once without failed side effects', async () => {
  const app = fixture(); const api = authed(app); const db = app.database;
  const setup = (await api.post('/api/auth/totp/setup').expect(200)).body;
  const enabled = (await api.post('/api/auth/totp/enable').send({ code: totpCode(setup.secret) }).expect(200)).body;
  const before = db.prepare('SELECT * FROM users WHERE id=?').get(api.user.id);
  await api.post('/api/auth/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'new-password-123' }).expect(401);
  await api.post('/api/auth/totp/recovery-codes').send({ password: TEST_PASSWORD, code: 'bad-code' }).expect(401);
  await api.post('/api/auth/totp/disable').send({ password: TEST_PASSWORD }).expect(401);
  const after = db.prepare('SELECT * FROM users WHERE id=?').get(api.user.id);
  assert.equal(after.password_hash, before.password_hash); assert.equal(after.recovery_codes_json, before.recovery_codes_json); assert.equal(after.totp_enabled, 1);
  // A recovery code with an invalid new password is not consumed.
  await api.post('/api/auth/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'short', code: enabled.recoveryCodes[0] }).expect(400);
  assert.equal(db.prepare('SELECT recovery_codes_json FROM users WHERE id=?').get(api.user.id).recovery_codes_json, before.recovery_codes_json);
  await api.post('/api/auth/totp/recovery-codes').set('X-Forwarded-For', '192.0.2.30').send({ password: TEST_PASSWORD, code: enabled.recoveryCodes[0] }).expect(200);
  await api.post('/api/auth/totp/disable').set('X-Forwarded-For', '192.0.2.31').send({ password: TEST_PASSWORD, code: enabled.recoveryCodes[0] }).expect(401);
  assert.equal(db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(api.user.id).totp_enabled, 1);
  await api.post('/api/auth/totp/disable').set('X-Forwarded-For', '192.0.2.32').send({ password: TEST_PASSWORD, code: totpCode(setup.secret) }).expect(200);
 });

 test('occurredAt rejects impossible dates/types for both sync and queue before AI or persistence', async () => {
  let calls = 0; const fake = fakeModelService(); const app = fixture({ aiService: { ...fake, classify: (...args) => { calls++; return fake.classify(...args); } } }); const api = authed(app);
  for (const value of ['2026-02-30', '2026-10-02T24:00:00Z', '2026-10-02T10:70:00Z', '2026-10-02T10:00:00+99:00', {}, 1, '']) {
    assert.equal(validOccurredAt(value), false);
    for (const preference of ['', 'respond-async']) await api.post('/api/captures').set('Prefer', preference).send({ raw: 'untouched raw', occurredAt: value }).expect(400);
  }
  assert.equal(calls, 0); assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM captures').get().n, 0);
  for (const value of ['2026-10-02', '2026-10-02T09:00:00.123+04:00', undefined, null]) assert.equal(validOccurredAt(value), true);
 });

 async function runNext(app) {
  const claim = claimCaptureJob(app.database, { owner: app.captureJobWorker.owner, leaseToken: crypto.randomUUID(), leaseMs: 30_000, currentTime: new Date().toISOString() });
  assert.ok(claim); await app.captureJobWorker.run(claim, new AbortController()); return claim;
 }

 test('one execution rate applies to web/queue/answer, never enqueue, with separate users and raw preservation', async () => {
  const providers = []; const fake = fakeModelService();
  const aiService = { ...fake, classify: async (...args) => { providers.push(args[1]); return fake.classify(...args); }, answer: async (q, sources, provider) => ({ answer: 'safe answer', citationIds: [], usedProvider: provider, provider }) };
  const app = fixture({ aiService, aiAdmissionOptions: { perUserLimit: 1 } }); const api = authed(app); const other = authed(app, { email: 'other@example.com' });
  const queued = (await api.post('/api/captures').set('Prefer', 'respond-async').send({ raw: 'queued raw', provider: 'openrouter' }).expect(202)).body;
  assert.equal(providers.length, 0); await runNext(app); assert.deepEqual(providers, ['openrouter']);
  const sync = await api.post('/api/captures').send({ raw: 'preserved raw', provider: 'openrouter' }).expect(201);
  assert.equal(sync.body.entry.raw, 'preserved raw'); assert.equal(providers.at(-1), 'fallback');
  const answer = await api.post('/api/memory/answer').send({ query: 'test', provider: 'openrouter' }).expect(200); assert.equal(answer.body.usedProvider, 'fallback');
  await other.post('/api/captures').send({ raw: 'other user', provider: 'openrouter' }).expect(201); assert.equal(providers.at(-1), 'openrouter');
  assert.equal((await api.get(queued.statusUrl).expect(200)).body.state, 'succeeded');
 });

 test('queue retry rechecks owner status/budget and preserves original frozen context and raw', async () => {
  const fake = fakeModelService(); const calls = []; let first = true;
  const app = fixture({ aiService: { ...fake, classify: async (...args) => { calls.push(args[1]); if (first) { first = false; throw Object.assign(new Error('down'), { code: 'unavailable' }); } return fake.classify(...args); } } });
  const api = authed(app); const queued = (await api.post('/api/captures').set('Prefer', 'respond-async').send({ raw: 'historic raw', provider: 'openrouter' }).expect(202)).body;
  await runNext(app); assert.equal((await api.get(queued.statusUrl)).body.state, 'failed');
  const original = app.database.prepare('SELECT * FROM capture_jobs WHERE id=?').get(queued.jobId);
  updateUser(app.database, api.user.id, { monthly_limit_usd: 1 });
  recordUsage(app.database, { userId: api.user.id, provider: 'openrouter', kind: 'classify', costUsd: 1, inputTokens: 1, outputTokens: 1 });
  const retry = (await api.post(`/api/jobs/${queued.jobId}/retry`).send({}).expect(202)).body;
  await runNext(app); assert.deepEqual(calls, ['openrouter', 'fallback']);
  const latest = app.database.prepare('SELECT * FROM capture_jobs WHERE id=?').get(retry.jobId);
  assert.equal(latest.overrides_json, original.overrides_json); assert.equal(latest.selected_provider, original.selected_provider);
  assert.equal(app.database.prepare('SELECT raw FROM captures WHERE id=?').get(queued.captureId).raw, 'historic raw');
  assert.equal((await api.get(retry.statusUrl)).body.state, 'succeeded');
  // Already queued work for a subsequently blocked account cannot spend either.
  updateUser(app.database, api.user.id, { monthly_limit_usd: null });
  const next = (await api.post('/api/captures').set('Prefer', 'respond-async').send({ raw: 'blocked raw', provider: 'openrouter' }).expect(202)).body;
  updateUser(app.database, api.user.id, { status: 'blocked' }); await runNext(app); assert.equal(calls.at(-1), 'fallback');
  assert.equal(app.database.prepare('SELECT state FROM capture_jobs WHERE id=?').get(next.jobId).state, 'succeeded');
 });

test('disconnected HTTP clients cannot release unfinished scrypt slots', async () => {
  const app = fixture(); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const original = crypto.scrypt; const pending = [];
  crypto.scrypt = (...args) => { pending.push(args.at(-1)); };
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('request did not reach crypto'); };
  try {
    for (let i = 0; i < 4; i++) {
      const body = JSON.stringify({ email: `missing-${i}@example.com`, password: TEST_PASSWORD });
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Forwarded-For': `192.0.2.${i + 1}` } });
      outgoing.on('error', () => {}); outgoing.end(body);
      await until(() => pending.length === i + 1); outgoing.destroy();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await request(server).post('/api/auth/login').set('X-Forwarded-For', '192.0.2.100').send({ email: 'fifth@example.com', password: TEST_PASSWORD }).expect(429);
    assert.equal(pending.length, 4, 'disconnects do not admit a fifth crypto operation');
  } finally {
    crypto.scrypt = original;
    for (const callback of pending) callback(null, Buffer.alloc(32));
    await new Promise(resolve => setImmediate(resolve));
    app.accounts.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('a block during async password verification prevents sensitive mutation', async () => {
  const app = fixture(); const api = authed(app); const before = app.database.prepare('SELECT password_hash FROM users WHERE id=?').get(api.user.id).password_hash;
  const original = crypto.scrypt; let started; const waiting = new Promise(resolve => { started = resolve; }); let continueHash;
  crypto.scrypt = (...args) => { const callback = args.pop(); original(...args, (error, key) => { continueHash = () => callback(error, key); started(); }); };
  try {
    // Disable uses one verification hash, making the in-flight window precise.
    updateUser(app.database, api.user.id, { totp_enabled: 1, totp_secret: 'JBSWY3DPEHPK3PXP' });
    const response = api.post('/api/auth/totp/disable').send({ password: TEST_PASSWORD, code: totpCode('JBSWY3DPEHPK3PXP') }).then(value => value);
    await waiting; updateUser(app.database, api.user.id, { status: 'blocked' }); continueHash();
    assert.equal((await response).status, 403);
    const row = app.database.prepare('SELECT password_hash,totp_enabled FROM users WHERE id=?').get(api.user.id);
    assert.equal(row.password_hash, before); assert.equal(row.totp_enabled, 1);
  } finally { crypto.scrypt = original; }
});

test('HTTPS derived only through trusted loopback proxy also makes session cookies Secure', async () => {
  const app = fixture(); const response = await request(app).post('/api/auth/register').set('X-Forwarded-Proto', 'https').send({ email: 'proxy@example.com', password: TEST_PASSWORD }).expect(201);
  assert.match(response.headers['set-cookie'][0], /; Secure/);
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
});

test('remote clients cannot spoof effective IP or HTTPS with forwarded headers', async () => {
  const app = express(); app.set('trust proxy', loopbackProxy);
  app.use((req, res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '198.51.100.10', configurable: true }); next(); });
  app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const response = await request(app).get('/').set('X-Forwarded-For', '192.0.2.5').set('X-Forwarded-Proto', 'https').expect(200);
  assert.deepEqual(response.body, { ip: '198.51.100.10', secure: false });
});

test('paid concurrency is shared across HTTP and worker; release follows accounting and failures', async () => {
  const fake = fakeModelService(); let resume; let started; const ready = new Promise(resolve => { started = resolve; }); const pending = new Promise(resolve => { resume = resolve; });
  const providers = []; let blockOnce = true;
  const aiService = { ...fake, classify: async (...args) => { providers.push(args[1]); if (args[1] !== 'fallback' && blockOnce) { blockOnce = false; started(); await pending; } return fake.classify(...args); } };
  const app = fixture({ aiService }); const api = authed(app); const other = authed(app, { email: 'second@example.com' });
  const first = api.post('/api/captures').send({ raw: 'first', provider: 'openrouter' }).then(response => response);
  await ready;
  const queued = (await api.post('/api/captures').set('Prefer', 'respond-async').send({ raw: 'same owner queued', provider: 'openrouter' }).expect(202)).body;
  await runNext(app); assert.equal(providers.at(-1), 'fallback');
  await other.post('/api/captures').send({ raw: 'different owner', provider: 'openrouter' }).expect(201); assert.equal(providers.at(-1), 'openrouter');
  resume(); assert.equal((await first).status, 201);
  await api.post('/api/captures').send({ raw: 'after release', provider: 'openrouter' }).expect(201); assert.equal(providers.at(-1), 'openrouter');
  assert.equal((await api.get(queued.statusUrl)).body.state, 'succeeded');
});

test('auth audit IP migration preserves old rows and sessions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-auth-ip-migration-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const first = createApp({ databasePath, aiService: fakeModelService() });
  const user = seedUser(first); const token = first.accounts.issueSession(user);
  first.database.prepare('INSERT INTO auth_events(id,user_id,email,event,result,created_at) VALUES(?,?,?,?,?,?)').run('historic-audit', user.id, user.email, 'login', 'succeeded', new Date().toISOString());
  first.database.exec('ALTER TABLE auth_events DROP COLUMN ip'); first.accounts.stop(); first.database.close();
  const restored = createApp({ databasePath, aiService: fakeModelService() });
  const audit = restored.database.prepare('SELECT * FROM auth_events WHERE id=?').get('historic-audit');
  assert.equal(audit.user_id, user.id); assert.equal(audit.ip, null);
  assert.equal(restored.accounts.userFromCookieHeader(`pagent_session=${token}`).id, user.id);
  restored.accounts.stop(); restored.database.close();
});
