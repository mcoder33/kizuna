// Агент пожеланий отвечает людям сам: входит токеном, а не кукой, и только в
// пожелания. Остальная админка и журналы токеном не открываются.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { authed, seedUser } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

for (const name of ['PAGENT_TELEGRAM_BOT_TOKEN', 'PAGENT_TELEGRAM_API_BASE', 'PAGENT_PUBLIC_URL']) delete process.env[name];
const TOKEN = 'agent-token-for-tests-0123456789abcdef';
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-feedback-agent-'));
  const app = createApp({ databasePath: path.join(directory, 'test.sqlite'), aiService: fakeModelService(), feedbackAgentTokenHash: HASH, ...options });
  t.after(async () => { await app.notificationsDelivered?.(); app.accounts.stop(); await app.telegram?.stop?.(); app.database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const admin = seedUser(app, { email: 'admin@kizuna.test' });
  const person = authed(app, { email: 'person@kizuna.test', role: 'user' });
  return { app, admin, person };
}
const bearer = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });

test('токен агента читает пожелания, отвечает и меняет статус от имени админа', async t => {
  const { app, admin, person } = fixture(t);
  const sent = (await person.post('/api/feedback').set('Idempotency-Key', 'feedback-request-1').send({ text: 'Пропала задача', allowContact: true }).expect(201)).body.feedback;
  const list = (await request(app).get('/api/admin/feedback?status=new').set(bearer()).expect(200)).body.feedback;
  assert.deepEqual(list.map(item => item.id), [sent.id]);
  const one = (await request(app).get(`/api/admin/feedback/${sent.id}`).set(bearer()).expect(200)).body.feedback;
  const patched = (await request(app).patch(`/api/admin/feedback/${sent.id}`).set(bearer()).send({ status: 'done', reply: 'Исправили', revision: one.revision }).expect(200)).body.feedback;
  assert.equal(patched.status, 'done');
  const reply = app.database.prepare('SELECT author_id, text FROM feedback_replies WHERE feedback_id=?').get(sent.id);
  assert.deepEqual({ ...reply }, { author_id: admin.id, text: 'Исправили' });
  const mine = (await person.get(`/api/feedback/${sent.id}`).expect(200)).body.feedback;
  assert.equal(mine.status, 'done');
  assert.equal(mine.replies.at(-1).text, 'Исправили', 'человек видит ответ');
  const logged = app.database.prepare("SELECT detail FROM auth_events WHERE event='admin_feedback'").get();
  assert.match(logged.detail, /feedback-agent$/, 'в журнале видно, что ответил агент');
});

test('токен не открывает остальную админку и обычные маршруты', async t => {
  const { app } = fixture(t);
  await request(app).get('/api/admin/inbox').set(bearer()).expect(401);
  await request(app).get('/api/entries').set(bearer()).expect(401);
  await request(app).post('/api/feedback').set(bearer()).send({ text: 'x', allowContact: false }).expect(401);
});

test('неверный токен и сервер без токена не пускают', async t => {
  const { app } = fixture(t);
  await request(app).get('/api/admin/feedback').set(bearer('wrong')).expect(401);
  await request(app).get('/api/admin/feedback').expect(401);
  const plain = fixture(t, { feedbackAgentTokenHash: '' }).app;
  await request(plain).get('/api/admin/feedback').set(bearer()).expect(401);
});

test('без активного админа токен не действует', async t => {
  const { app, admin } = fixture(t);
  app.database.prepare("UPDATE users SET status='blocked' WHERE id=?").run(admin.id);
  await request(app).get('/api/admin/feedback').set(bearer()).expect(401);
});
