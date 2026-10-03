import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { notify } from '../server/notifications.js';
import { authed, seedUser, TEST_PASSWORD } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';
import { createFakeTelegram } from './helpers/fake-telegram.js';

// Каждый файл node:test работает в своём процессе. Даже локальный .env не
// должен направить проверку уведомлений к настоящему боту.
for (const name of ['PAGENT_TELEGRAM_BOT_TOKEN', 'PAGENT_TELEGRAM_API_BASE', 'PAGENT_PUBLIC_URL']) delete process.env[name];
const NOW = new Date('2031-09-24T09:00:00Z');
const requestKey = index => `feedback-request-${index}`;
const preferences = ({ signupApp = true, signupTelegram = true, feedbackApp = true, feedbackTelegram = true } = {}) => ({
  signup: { app: signupApp, telegram: signupTelegram },
  feedback: { app: feedbackApp, telegram: feedbackTelegram },
});

function fixture(t, { now = () => NOW, databasePath, fake = createFakeTelegram(), telegramFetch = fake.fetch } = {}) {
  const directory = databasePath ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-administration-'));
  const file = databasePath || path.join(directory, 'test.sqlite');
  const app = createApp({ databasePath: file, aiService: fakeModelService({ now }), now, telegramFetch,
    securityOptions: { publicUrl: 'https://kizuna.example' } });
  let closed = false;
  async function close() {
    if (closed) return;
    await app.notificationsDelivered();
    app.accounts.stop();
    await app.telegram.stop();
    app.database.close();
    closed = true;
  }
  t.after(async () => { await close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, db: app.database, fake, databasePath: file, close };
}

function linkTelegram(ctx, user, telegramId = 777001, appUrl = 'https://kizuna.example/') {
  ctx.db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,username,name,app_url,linked_at) VALUES(?,?,?,?,?,?,?)')
    .run(user.id, telegramId, telegramId, `user${telegramId}`, 'Администратор', appUrl, NOW.toISOString());
}
const submit = (api, index, body = {}) => api.post('/api/feedback').set('Idempotency-Key', requestKey(index))
  .send({ text: `Пожелание ${index}`, ...body });
const inbox = async api => (await api.get('/api/admin/inbox').expect(200)).body;
const ownFeedback = async api => (await api.get('/api/feedback').expect(200)).body.feedback;
const deliveries = ctx => ctx.db.prepare('SELECT * FROM admin_telegram_deliveries ORDER BY event_key,user_id').all();
const notifications = (ctx, kind) => ctx.db.prepare('SELECT * FROM notifications WHERE kind=? ORDER BY user_id').all(kind);
async function enableTelegram(ctx, admin) {
  await admin.put('/api/settings').send({ telegramBotToken: ctx.fake.token }).expect(200);
}
async function signup(ctx, email = 'new-user@kizuna.test') {
  return (await request(ctx.app).post('/api/auth/register').send({ email, password: TEST_PASSWORD }).expect(201)).body.user;
}

test('feedback lists expose only the author’s threads; administrators get the author identity', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const alice = authed(ctx.app, { email: 'alice@kizuna.test', role: 'user' });
  const bob = authed(ctx.app, { email: 'bob@kizuna.test', role: 'user' });
  const aliceThread = (await submit(alice, 'alice', { text: 'Нужен быстрый поиск', allowContact: true }).expect(201)).body.feedback;
  const bobThread = (await submit(bob, 'bob', { text: 'Нужен другой календарь' }).expect(201)).body.feedback;

  assert.deepEqual((await ownFeedback(alice)).map(item => item.id), [aliceThread.id]);
  assert.deepEqual((await ownFeedback(bob)).map(item => item.id), [bobThread.id]);
  assert.deepEqual(await ownFeedback(admin), []);
  assert.equal(aliceThread.allowContact, true);
  assert.equal('userId' in aliceThread, false);
  assert.equal('email' in aliceThread, false);
  const all = (await admin.get('/api/admin/feedback').expect(200)).body.feedback;
  assert.equal(all.length, 2);
  assert.equal(all.find(item => item.id === aliceThread.id).email, alice.user.email);
  assert.equal(all.find(item => item.id === bobThread.id).userId, bob.user.id);
  assert.equal((await alice.get(`/api/feedback/${aliceThread.id}`).expect(200)).body.feedback.id, aliceThread.id);
  await bob.get(`/api/feedback/${aliceThread.id}`).expect(404);
  await admin.get(`/api/feedback/${aliceThread.id}`).expect(404);
  assert.equal((await admin.get(`/api/admin/feedback/${aliceThread.id}`).expect(200)).body.feedback.userId, alice.user.id);
});

test('anonymous, ordinary and blocked accounts cannot use administration endpoints', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'user@kizuna.test', role: 'user' });
  const blocked = authed(ctx.app, { email: 'blocked@kizuna.test', role: 'admin', status: 'blocked' });
  const thread = (await submit(user, 'guards').expect(201)).body.feedback;
  const routes = [
    ['get', '/api/admin/inbox'], ['get', '/api/admin/feedback'], ['get', `/api/admin/feedback/${thread.id}`], ['patch', `/api/admin/feedback/${thread.id}`],
    ['get', '/api/admin/notification-settings'], ['put', '/api/admin/notification-settings'],
    ['get', '/api/admin/memory'], ['post', '/api/admin/memory'], ['delete', '/api/admin/memory/unknown'],
  ];
  for (const [method, url] of routes) {
    await request(ctx.app)[method](url).send({}).expect(401);
    await user[method](url).send({}).expect(403);
    const denied = await blocked[method](url).send({});
    assert.ok([401, 403].includes(denied.status), `${method} ${url} rejects a blocked admin`);
  }
  await request(ctx.app).get('/api/feedback').expect(401);
  await request(ctx.app).post('/api/feedback').send({ text: 'Нужно войти' }).expect(401);
  assert.equal((await admin.get('/api/admin/feedback').expect(200)).body.feedback[0].revision, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM feedback_replies').get().n, 0);
});

test('feedback replay is idempotent for the same author and conflicts cannot replace the first text', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'user@kizuna.test', role: 'user' });
  const other = authed(ctx.app, { email: 'other@kizuna.test', role: 'user' });
  const first = (await submit(user, 'idempotency', { text: '  Добавить виджет  ', allowContact: true }).expect(201)).body.feedback;
  const replay = (await submit(user, 'idempotency', { text: 'Добавить виджет', allowContact: true }).expect(200)).body;
  assert.equal(first.text, 'Добавить виджет');
  assert.equal(replay.replayed, true);
  assert.equal(replay.feedback.id, first.id);
  assert.equal((await submit(user, 'idempotency', { text: 'Заменить текст', allowContact: true }).expect(409)).body.error.code, 'idempotency_conflict');
  await submit(user, 'idempotency', { text: 'Добавить виджет', allowContact: false }).expect(409);
  const second = (await submit(other, 'idempotency', { text: 'Добавить виджет', allowContact: true }).expect(201)).body.feedback;
  assert.notEqual(second.id, first.id, 'request keys belong to each account');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 2);
  assert.equal((await inbox(admin)).notifications.length, 2);
});

test('feedback validates content and request keys before writing, and the hourly limit permits replays', async t => {
  let current = NOW;
  const ctx = fixture(t, { now: () => current });
  const user = authed(ctx.app, { role: 'user' });
  for (const body of [{ text: '' }, { text: '   ' }, { text: 42 }, { text: 'x'.repeat(3001) }, { text: 'Идея', allowContact: 'yes' }]) {
    await submit(user, 'invalid', body).expect(400);
  }
  for (const key of ['', 'short', 'space is not valid', 'x'.repeat(81)]) {
    await user.post('/api/feedback').set('Idempotency-Key', key).send({ text: 'Идея' }).expect(400);
  }
  await user.post('/api/feedback').send({ text: 'Без ключа' }).expect(400);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 0);
  for (let index = 0; index < 5; index++) await submit(user, `limit-${index}`).expect(201);
  const exceeded = await submit(user, 'limit-six').expect(429);
  assert.equal(exceeded.body.error.code, 'feedback_limit');
  assert.ok(Number(exceeded.headers['retry-after']) > 0);
  await submit(user, 'limit-0').expect(200);
  current = new Date(NOW.getTime() + 3600001);
  await submit(user, 'limit-six').expect(201);
});

test('an admin reply updates one revision, reaches only the author, and resolves every admin notification', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const secondAdmin = authed(ctx.app, { email: 'second-admin@kizuna.test' });
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  const outsider = authed(ctx.app, { email: 'outsider@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user);
  const thread = (await submit(user, 'reply').expect(201)).body.feedback;
  assert.equal((await inbox(admin)).notifications.length, 1);
  assert.equal((await inbox(secondAdmin)).notifications.length, 1);
  const updated = (await admin.patch(`/api/admin/feedback/${thread.id}`).send({ revision: 0, status: 'considering', reply: '  Спасибо, проверим.  ' }).expect(200)).body.feedback;
  assert.equal(updated.revision, 1);
  assert.equal(updated.status, 'considering');
  assert.equal(updated.replies[0].text, 'Спасибо, проверим.');
  await secondAdmin.patch(`/api/admin/feedback/${thread.id}`).send({ revision: 0, status: 'done', reply: 'Устаревший ответ' }).expect(409);
  assert.equal((await ownFeedback(user))[0].replies.length, 1);
  assert.deepEqual((await inbox(admin)).notifications, []);
  assert.deepEqual((await inbox(secondAdmin)).notifications, []);
  assert.deepEqual((await inbox(admin)).feedback, []);
  assert.ok(notifications(ctx, 'feedback').every(item => item.resolved_at && item.read_at));
  assert.equal(deliveries(ctx)[0].state, 'cancelled', 'unconfigured Telegram delivery is cancelled once handled');
  const authorFeed = (await user.get('/api/notifications').expect(200)).body.notifications;
  const reply = authorFeed.find(item => item.kind === 'feedback_reply');
  assert.equal(reply.text, 'Спасибо, проверим.');
  assert.equal(reply.data.url, `/#feedback?id=${thread.id}`);
  assert.equal((await outsider.get('/api/notifications').expect(200)).body.notifications.length, 0);
  assert.equal(notifications(ctx, 'feedback_reply').length, 1, 'stale revisions cannot create a second reply');
});

test('status-only changes resolve an incoming wish and invalid or missing updates do not mutate it', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  const thread = (await submit(user, 'status').expect(201)).body.feedback;
  for (const body of [{ revision: 0, status: 'unknown' }, { revision: '0' }, { revision: 0, reply: 10 }, { revision: 0, reply: 'x'.repeat(3001) }, {}]) {
    await admin.patch(`/api/admin/feedback/${thread.id}`).send(body).expect(400);
  }
  await admin.patch('/api/admin/feedback/missing').send({ revision: 0, status: 'done' }).expect(404);
  assert.equal((await ownFeedback(user))[0].revision, 0);
  assert.equal((await inbox(admin)).notifications.length, 1);
  for (const [revision, status] of ['later', 'considering', 'done'].entries()) {
    const result = (await admin.patch(`/api/admin/feedback/${thread.id}`).send({ revision, status }).expect(200)).body.feedback;
    assert.equal(result.status, status);
    assert.equal(result.revision, revision + 1);
  }
  assert.equal((await inbox(admin)).notifications.length, 0);
  assert.deepEqual((await ownFeedback(user))[0].replies, []);
  assert.equal(notifications(ctx, 'feedback_reply').length, 0);
});

test('feedback pagination preserves same-time rows, author isolation and status filtering beyond the first page', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  const other = authed(ctx.app, { email: 'other@kizuna.test', role: 'user' });
  const insert = ctx.db.prepare('INSERT INTO feedback(id,user_id,text,status,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  ctx.db.transaction(() => {
    for (let index = 0; index < 320; index++) {
      insert.run(`closed-${String(index).padStart(3, '0')}`, user.user.id, `Закрытое ${index}`, 'done', requestKey(index), NOW.toISOString(), NOW.toISOString());
    }
    for (let index = 0; index < 9; index++) {
      const stamp = new Date(NOW.getTime() - 86400000).toISOString();
      insert.run(`open-${index}`, index % 2 ? other.user.id : user.user.id, `Нужен 100%_поиск ${index}`, 'new', requestKey(`open-${index}`), stamp, stamp);
    }
  })();
  const expected = Array.from({ length: 9 }, (_, index) => `open-${8 - index}`);
  const seen = [];
  let cursor = '';
  do {
    const page = (await admin.get('/api/admin/feedback').query({ status: 'new', limit: 2, ...(cursor ? { before: cursor } : {}) }).expect(200)).body;
    seen.push(...page.feedback.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected, 'stable cursor includes each equal-timestamp row once');
  const firstAdminPage = (await admin.get('/api/admin/feedback').query({ status: 'new', limit: 2 }).expect(200)).body;
  const own = (await user.get('/api/feedback').query({ status: 'new', before: firstAdminPage.nextCursor, limit: 100 }).expect(200)).body;
  assert.deepEqual(own.feedback.map(item => item.id), ['open-6', 'open-4', 'open-2', 'open-0']);
  assert.ok(own.feedback.every(item => !('email' in item) && !('userId' in item)));
  const box = await inbox(admin);
  assert.equal(box.feedbackCount, 9);
  assert.deepEqual(box.feedback.map(item => item.id), expected, 'older new wishes survive hundreds of newer resolved ones');
  const literalSearch = (await admin.get('/api/admin/feedback').query({ q: '100%_поиск', status: 'new' }).expect(200)).body;
  assert.equal(literalSearch.feedback.length, 9);
  assert.equal((await admin.get('/api/admin/feedback').query({ q: '100__поиск' }).expect(200)).body.feedback.length, 0, 'LIKE metacharacters are searched literally');
  for (const query of [{ before: 'malformed' }, { status: 'invalid' }, { q: 'x'.repeat(201) }]) {
    await admin.get('/api/admin/feedback').query(query).expect(400);
    await user.get('/api/feedback').query(query).expect(400);
  }
  for (const query of ['limit=1.5', 'limit=NaN', 'limit=1&limit=2', 'limit=10000', 'limit=0']) {
    await admin.get(`/api/admin/feedback?${query}`).expect(400);
    await user.get(`/api/feedback?${query}`).expect(400);
  }
  assert.equal((await admin.get('/api/admin/feedback').query({ limit: 100 }).expect(200)).body.feedback.length, 100);
});

test('signup notifies active admins in the app and only their linked Telegram chats', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const unlinked = authed(ctx.app, { email: 'unlinked@kizuna.test' });
  const ordinary = seedUser(ctx.app, { email: 'ordinary@kizuna.test', role: 'user' });
  const blocked = seedUser(ctx.app, { email: 'blocked@kizuna.test', role: 'admin', status: 'blocked' });
  const pending = seedUser(ctx.app, { email: 'pending@kizuna.test', role: 'admin', status: 'pending' });
  linkTelegram(ctx, admin.user, 777001);
  linkTelegram(ctx, ordinary, 777002);
  linkTelegram(ctx, blocked, 777003);
  linkTelegram(ctx, pending, 777004);
  await enableTelegram(ctx, admin);
  const newUser = await signup(ctx);
  assert.equal(newUser.status, 'pending');
  await ctx.app.notificationsDelivered();
  assert.deepEqual(notifications(ctx, 'signup').map(row => row.user_id).sort(), [admin.user.id, unlinked.user.id].sort());
  assert.deepEqual(deliveries(ctx).map(row => [row.user_id, row.state]), [[admin.user.id, 'sent']]);
  assert.equal(ctx.fake.said().length, 1);
  assert.equal(ctx.fake.said()[0].chatId, 777001);
  assert.match(ctx.fake.said()[0].text, /new-user@kizuna\.test/);
  assert.equal(ctx.fake.said()[0].markup.inline_keyboard[0][0].url, `https://kizuna.example/#admin/inbox?user=${newUser.id}`);
  assert.equal((await inbox(admin)).notifications[0].data.url, `/#admin/inbox?user=${newUser.id}`);
  assert.ok((await inbox(admin)).pending.some(user => user.id === newUser.id));
});

test('approving or rejecting a signup resolves all app notices and cancels an undelivered Telegram notice', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const secondAdmin = authed(ctx.app, { email: 'second@kizuna.test' });
  linkTelegram(ctx, admin.user);
  for (const action of ['approve', 'reject']) {
    const user = await signup(ctx, `${action}@kizuna.test`);
    await admin.post(`/api/admin/users/${user.id}/${action}`).send({}).expect(200);
    assert.equal((await inbox(admin)).notifications.length, 0);
    assert.equal((await inbox(secondAdmin)).notifications.length, 0);
    assert.equal(deliveries(ctx).find(row => row.event_key === `signup:${user.id}`).state, 'cancelled');
    assert.ok(!(await inbox(admin)).pending.some(item => item.id === user.id));
  }
  assert.ok(notifications(ctx, 'signup').every(row => row.resolved_at && row.read_at));
  assert.deepEqual(ctx.fake.said(), []);
});

test('admin channel preferences independently control signup and feedback app/Telegram delivery', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user);
  await enableTelegram(ctx, admin);
  await admin.put('/api/admin/notification-settings').send({ preferences: preferences({ signupApp: false, feedbackTelegram: false }) }).expect(200);
  const registered = await signup(ctx);
  const thread = (await submit(user, 'channels').expect(201)).body.feedback;
  await ctx.app.notificationsDelivered();
  assert.equal(notifications(ctx, 'signup').length, 0);
  assert.equal(notifications(ctx, 'feedback').length, 1);
  assert.equal(deliveries(ctx).length, 1);
  assert.equal(deliveries(ctx)[0].event_key, `signup:${registered.id}`);
  assert.equal(ctx.fake.said().length, 1);
  const box = await inbox(admin);
  assert.ok(box.pending.some(item => item.id === registered.id), 'turning off alerts does not discard the request');
  assert.ok(box.feedback.some(item => item.id === thread.id));

  await admin.put('/api/admin/notification-settings').send({ preferences: preferences({ signupTelegram: false, feedbackApp: false }) }).expect(200);
  const secondSignup = await signup(ctx, 'app-only@kizuna.test');
  const secondFeedback = (await submit(user, 'channels-second').expect(201)).body.feedback;
  await ctx.app.notificationsDelivered();
  assert.equal(notifications(ctx, 'signup')[0].group_key, `signup:${secondSignup.id}`);
  assert.equal(notifications(ctx, 'feedback').length, 1);
  assert.equal(deliveries(ctx).find(row => row.event_key === `feedback:${secondFeedback.id}`).state, 'sent');
  assert.equal(ctx.fake.said().length, 2);
});

test('notification settings validate the complete channel matrix and list no inactive recipient', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const unlinked = seedUser(ctx.app, { email: 'unlinked@kizuna.test' });
  seedUser(ctx.app, { email: 'blocked@kizuna.test', status: 'blocked' });
  seedUser(ctx.app, { email: 'user@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user);
  const before = (await admin.get('/api/admin/notification-settings').expect(200)).body;
  assert.deepEqual(before.preferences, preferences());
  assert.equal(before.botConfigured, false);
  assert.deepEqual(before.recipients.map(row => [row.id, row.telegramLinked]).sort(), [[admin.user.id, true], [unlinked.id, false]].sort());
  for (const invalid of [null, {}, { signup: { app: true, telegram: true } }, { ...preferences(), other: {} },
    { ...preferences(), feedback: { app: true, telegram: 'yes' } }, { ...preferences(), feedback: { app: true, telegram: true, extra: false } }]) {
    await admin.put('/api/admin/notification-settings').send({ preferences: invalid }).expect(400);
  }
  assert.deepEqual((await admin.get('/api/admin/notification-settings').expect(200)).body.preferences, preferences());
  const off = preferences({ signupApp: false, signupTelegram: false, feedbackApp: false, feedbackTelegram: false });
  await admin.put('/api/admin/notification-settings').send({ preferences: off }).expect(200);
  await signup(ctx);
  await ctx.app.notificationsDelivered();
  assert.equal(notifications(ctx, 'signup').length, 0);
  assert.equal(deliveries(ctx).length, 0);
});

test('reading and clearing the personal bell leaves administration notices untouched, while explicit IDs can be read', async t => {
  const ctx = fixture(t);
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  await submit(user, 'personal-scope').expect(201);
  await signup(ctx);
  notify(ctx.db, { userId: admin.user.id, kind: 'feedback_reply', text: 'Личный ответ', at: NOW.toISOString() });
  const administrationRows = () => [...notifications(ctx, 'signup'), ...notifications(ctx, 'feedback')];
  const personal = (await admin.get('/api/notifications?scope=personal').expect(200)).body;
  assert.deepEqual(personal.notifications.map(row => row.kind), ['feedback_reply']);
  assert.equal(personal.counts.unread, 1);
  assert.ok(administrationRows().every(row => row.read_at === null && row.dismissed_at === null));

  const read = (await admin.post('/api/notifications/read?scope=personal').send({ all: true }).expect(200)).body;
  assert.equal(read.changed, 1);
  assert.equal(read.counts.unread, 0);
  assert.ok(administrationRows().every(row => row.read_at === null && row.dismissed_at === null));
  const dismissed = (await admin.post('/api/notifications/dismiss?scope=personal').send({ all: true }).expect(200)).body;
  assert.equal(dismissed.dismissed.length, 1);
  assert.ok(administrationRows().every(row => row.read_at === null && row.dismissed_at === null));
  const ids = administrationRows().map(row => row.id);
  assert.equal((await admin.post('/api/notifications/read?scope=personal').send({ ids }).expect(200)).body.changed, 2);
  assert.ok(administrationRows().every(row => row.read_at !== null && row.dismissed_at === null));
  assert.equal((await inbox(admin)).notifications.length, 2, 'reading a notice does not handle the request');
});

test('Telegram failure does not fail feedback; the persisted queue retries after a restart without a duplicate', async t => {
  let current = NOW, unavailable = true;
  const fake = createFakeTelegram();
  const attempts = [];
  const fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/sendMessage')) {
      attempts.push(JSON.parse(init.body));
      if (unavailable) throw new Error('fake network outage');
    }
    return fake.fetch(url, init);
  };
  const ctx = fixture(t, { now: () => current, fake, telegramFetch: fetch });
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user);
  await enableTelegram(ctx, admin);
  const thread = (await submit(user, 'restart').expect(201)).body.feedback;
  await ctx.app.notificationsDelivered();
  assert.equal(deliveries(ctx)[0].state, 'pending');
  assert.equal(deliveries(ctx)[0].attempts, 1);
  assert.equal(attempts.length, 1);
  assert.equal((await inbox(admin)).feedback[0].id, thread.id);
  await ctx.app.administration.flush();
  assert.equal(attempts.length, 1, 'backoff prevents immediate resend');
  await ctx.close();

  current = new Date(NOW.getTime() + 31000);
  unavailable = false;
  const restarted = fixture(t, { databasePath: ctx.databasePath, now: () => current, fake, telegramFetch: fetch });
  await restarted.app.notificationTick();
  assert.equal(deliveries(restarted)[0].state, 'sent');
  assert.equal(deliveries(restarted)[0].attempts, 2);
  assert.ok(deliveries(restarted)[0].message_id);
  assert.equal(fake.said().length, 1);
  await restarted.app.administration.flush();
  await restarted.app.notificationTick();
  assert.equal(attempts.length, 2);
  assert.equal(notifications(restarted, 'feedback').length, 1);
  await restarted.close();
});

test('concurrent flushes and event replay send the same admin Telegram notification once', async t => {
  const fake = createFakeTelegram();
  let releaseSend, started;
  const sending = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { releaseSend = resolve; });
  t.after(() => releaseSend());
  const fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/sendMessage')) { started(); await gate; }
    return fake.fetch(url, init);
  };
  const ctx = fixture(t, { fake, telegramFetch: fetch });
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user);
  await enableTelegram(ctx, admin);
  const thread = (await submit(user, 'concurrent').expect(201)).body.feedback;
  await sending;
  const concurrent = Array.from({ length: 8 }, () => ctx.app.administration.flush());
  ctx.app.administration.publish({ kind: 'feedback', eventId: thread.id, text: 'Повтор того же события', url: `/#admin/feedback?id=${thread.id}` });
  releaseSend();
  await Promise.all(concurrent);
  await ctx.app.notificationsDelivered();
  await submit(user, 'concurrent').expect(200);
  await ctx.app.administration.flush();
  assert.equal(fake.said().length, 1);
  assert.equal(deliveries(ctx).length, 1);
  assert.equal(deliveries(ctx)[0].attempts, 1);
  assert.equal(notifications(ctx, 'feedback').length, 1);
});

test('handling feedback during a Telegram send fences the completion and cannot revive a resolved event', async t => {
  for (const outcome of ['failure', 'success']) await t.test(outcome, async child => {
    let current = NOW, releaseSend, started;
    const sending = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { releaseSend = resolve; });
    child.after(() => releaseSend());
    const fake = createFakeTelegram();
    let attempts = 0;
    const fetch = async (url, init) => {
      if (new URL(url).pathname.endsWith('/sendMessage')) {
        attempts++;
        started();
        await gate;
        if (outcome === 'failure') throw new Error('fake acknowledgement failure');
      }
      return fake.fetch(url, init);
    };
    const ctx = fixture(child, { now: () => current, fake, telegramFetch: fetch });
    const admin = authed(ctx.app);
    const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
    linkTelegram(ctx, admin.user);
    await enableTelegram(ctx, admin);
    const thread = (await submit(user, `sending-${outcome}`).expect(201)).body.feedback;
    await sending;
    assert.equal(deliveries(ctx)[0].state, 'sending');
    await admin.patch(`/api/admin/feedback/${thread.id}`).send({ revision: 0, status: 'considering' }).expect(200);
    assert.equal(deliveries(ctx)[0].state, 'cancelled');
    releaseSend();
    await ctx.app.notificationsDelivered();
    current = new Date(NOW.getTime() + 121000);
    await ctx.app.administration.flush();
    assert.equal(deliveries(ctx)[0].state, 'cancelled');
    assert.equal(attempts, 1, 'completion of an already-handled send cannot schedule another attempt');
    assert.equal((await inbox(admin)).notifications.length, 0);
  });
});

test('an expired delivery lease is recovered, while an active lease cannot be sent twice', async t => {
  let current = NOW;
  const ctx = fixture(t, { now: () => current });
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user);
  await submit(user, 'lease').expect(201);
  await ctx.app.administration.flush();
  ctx.db.prepare("UPDATE admin_telegram_deliveries SET state='sending',attempts=1,lease_until=?")
    .run(new Date(NOW.getTime() + 120000).toISOString());
  await enableTelegram(ctx, admin);
  await ctx.app.administration.flush();
  assert.equal(ctx.fake.said().length, 0);
  current = new Date(NOW.getTime() + 120001);
  await ctx.app.administration.flush();
  assert.equal(ctx.fake.said().length, 1);
  assert.equal(deliveries(ctx)[0].state, 'sent');
  assert.equal(deliveries(ctx)[0].attempts, 2);
});

test('demotion, unlink and disabling Telegram cancel delayed admin deliveries before retry', async t => {
  for (const change of ['demote', 'unlink', 'disable']) await t.test(change, async child => {
    let current = NOW, unavailable = true;
    const fake = createFakeTelegram();
    const fetch = async (url, init) => {
      if (unavailable && new URL(url).pathname.endsWith('/sendMessage')) throw new Error('fake network outage');
      return fake.fetch(url, init);
    };
    const ctx = fixture(child, { now: () => current, fake, telegramFetch: fetch });
    const admin = authed(ctx.app);
    const recipient = authed(ctx.app, { email: 'recipient@kizuna.test' });
    const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
    linkTelegram(ctx, recipient.user);
    await enableTelegram(ctx, admin);
    await submit(user, `cancel-${change}`).expect(201);
    await ctx.app.notificationsDelivered();
    assert.equal(deliveries(ctx)[0].state, 'pending');
    if (change === 'demote') await admin.post(`/api/admin/users/${recipient.user.id}/role`).send({ role: 'user' }).expect(200);
    if (change === 'unlink') await recipient.delete('/api/telegram/link').expect(200);
    if (change === 'disable') await admin.put('/api/admin/notification-settings').send({ preferences: preferences({ feedbackTelegram: false }) }).expect(200);
    unavailable = false;
    current = new Date(NOW.getTime() + 31000);
    await ctx.app.administration.flush();
    assert.equal(deliveries(ctx)[0].state, 'cancelled');
    assert.equal(fake.said().length, 0);
  });
});

test('Telegram permanent failures stop retries and local app URLs never create an unsafe button', async t => {
  let current = NOW;
  const fake = createFakeTelegram();
  let attempts = 0, forbidden = true;
  const fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/sendMessage')) {
      attempts++;
      if (forbidden) return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Fake bot blocked' }), { status: 403 });
    }
    return fake.fetch(url, init);
  };
  const ctx = fixture(t, { now: () => current, fake, telegramFetch: fetch });
  const admin = authed(ctx.app);
  const user = authed(ctx.app, { email: 'author@kizuna.test', role: 'user' });
  linkTelegram(ctx, admin.user, 777001, 'http://127.0.0.1:3000/');
  await enableTelegram(ctx, admin);
  await submit(user, 'permanent').expect(201);
  await ctx.app.notificationsDelivered();
  assert.equal(deliveries(ctx)[0].state, 'failed');
  current = new Date(NOW.getTime() + 3600001);
  forbidden = false;
  await ctx.app.administration.flush();
  assert.equal(attempts, 1);
  await submit(user, 'local-button').expect(201);
  await ctx.app.notificationsDelivered();
  assert.equal(fake.said().length, 1);
  assert.equal(fake.said()[0].markup, null);
});
