// Учётные записи и то, ради чего они заведены: чужой журнал не должен быть
// виден, чужие настройки — доступны, а заблокированный — впущен. Проверяется
// поведение снаружи, через API, потому что именно им и пользуются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed, seedUser, TEST_PASSWORD } from './helpers/auth.js';
import { recordUsage, monthBounds, monthlySpend, openVoiceSession, closeVoiceSession } from '../server/db.js';
import { totpCode, verifyTotp, base32Encode, base32Decode, hashPassword, verifyPassword, generateRecoveryCodes, normalizeRecoveryCode, validEmail, passwordProblem } from '../server/auth.js';

function app(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-auth-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), ...options });
}

// ── криптография сама по себе ────────────────────────────────────────────────
test('TOTP сходится с контрольными значениями RFC 6238', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpCode(secret, { at: 59_000 }), '287082');
  assert.equal(totpCode(secret, { at: 1_111_111_109_000 }), '081804');
  assert.equal(totpCode(secret, { at: 1_234_567_890_000 }), '005924');
});

test('код принимается в соседнем шаге и не принимается дальше', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const at = 1_234_567_890_000;
  assert.equal(verifyTotp(secret, '005924', { at }), true);
  assert.equal(verifyTotp(secret, totpCode(secret, { at: at - 30_000 }), { at }), true, 'шаг назад — часы телефона отстают');
  assert.equal(verifyTotp(secret, totpCode(secret, { at: at + 30_000 }), { at }), true, 'шаг вперёд — часы спешат');
  assert.equal(verifyTotp(secret, totpCode(secret, { at: at + 120_000 }), { at }), false, 'четыре шага — это уже не расхождение часов');
  assert.equal(verifyTotp(secret, '12345', { at }), false, 'пять цифр — не код');
  assert.equal(verifyTotp(secret, '', { at }), false);
});

test('base32 переживает пробелы, дефисы и нижний регистр', () => {
  const secret = base32Encode(Buffer.from('kizuna secret'));
  const mangled = secret.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
  assert.equal(base32Decode(mangled).toString(), 'kizuna secret');
});

test('пароль хранится хешем, а не строкой', () => {
  const hash = hashPassword('очень-длинный-пароль');
  assert.equal(hash.includes('очень-длинный-пароль'), false);
  assert.equal(verifyPassword('очень-длинный-пароль', hash), true);
  assert.equal(verifyPassword('другой-длинный-пароль', hash), false);
  assert.notEqual(hash, hashPassword('очень-длинный-пароль'), 'соль у каждого своя');
});

test('короткий пароль и кривая почта отклоняются до базы', () => {
  assert.ok(passwordProblem('коротко'));
  assert.equal(passwordProblem('достаточно-длинный'), null);
  assert.equal(validEmail('a@b.ru'), true);
  assert.equal(validEmail('без-собаки'), false);
  assert.equal(validEmail('два@@собаки.ru'), false);
});

test('резервные коды не повторяются и сравниваются без разделителей', () => {
  const codes = generateRecoveryCodes();
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(normalizeRecoveryCode('AB-cd 12'), 'abcd12');
});

// ── регистрация и первый администратор ───────────────────────────────────────
test('первый зарегистрировавшийся становится администратором, остальные ждут', async () => {
  const api = request(app());
  const state = (await api.get('/api/auth/state').expect(200)).body;
  assert.equal(state.needsBootstrap, true);

  const first = (await api.post('/api/auth/register').send({ email: 'First@Example.COM', password: 'very-long-password' }).expect(201)).body;
  assert.equal(first.first, true);
  assert.equal(first.user.role, 'admin');
  assert.equal(first.user.status, 'active');
  assert.equal(first.user.email, 'first@example.com', 'адрес приводится к нижнему регистру');

  const second = (await api.post('/api/auth/register').send({ email: 'second@example.com', password: 'another-long-password' }).expect(201)).body;
  assert.equal(second.first, false);
  assert.equal(second.user.role, 'user');
  assert.equal(second.user.status, 'pending');

  await api.post('/api/auth/register').send({ email: 'FIRST@example.com', password: 'yet-another-password' }).expect(409);
  await api.post('/api/auth/register').send({ email: 'third@example.com', password: 'короткий' }).expect(400);
  await api.post('/api/auth/register').send({ email: 'не-почта', password: 'very-long-password' }).expect(400);
});

test('первая учётная запись забирает себе журнал, который вёлся до неё', async () => {
  const application = app();
  const db = application.database;
  db.prepare('INSERT INTO captures(id,raw,modality,occurred_at,created_at,privacy_scope,deleted_at,user_id) VALUES(?,?,?,?,?,?,NULL,NULL)')
    .run('старая', 'запись до появления людей', 'text', '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z', 'private');
  const api = request(application);
  const registered = (await api.post('/api/auth/register').send({ email: 'owner@example.com', password: 'very-long-password' }).expect(201)).body;
  assert.equal(db.prepare('SELECT user_id FROM captures WHERE id=?').get('старая').user_id, registered.user.id);
});

// ── вход ─────────────────────────────────────────────────────────────────────
test('вход требует пароль, а «нет такого адреса» неотличимо от «неверный пароль»', async () => {
  const application = app();
  seedUser(application, { email: 'user@example.com', role: 'user' });
  const api = request(application);
  const missing = await api.post('/api/auth/login').send({ email: 'никого@example.com', password: 'что-нибудь-длинное' }).expect(401);
  const wrong = await api.post('/api/auth/login').send({ email: 'user@example.com', password: 'неверный-длинный' }).expect(401);
  assert.deepEqual(missing.body, wrong.body, 'по ответу нельзя перебрать адреса');

  const login = await api.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD }).expect(200);
  const cookie = login.headers['set-cookie'].find((value) => value.startsWith('pagent_session='));
  assert.ok(cookie.includes('HttpOnly'), 'кука недоступна скриптам');
  assert.ok(cookie.includes('SameSite=Lax'), 'кука не уходит на чужой сайт');
});

test('заявка и блокировка закрывают вход, одобрение открывает', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const api = request(application);
  await api.post('/api/auth/register').send({ email: 'gost@example.com', password: 'gost-long-password' }).expect(201);
  await api.post('/api/auth/login').send({ email: 'gost@example.com', password: 'gost-long-password' }).expect(403);

  const users = (await admin.get('/api/admin/users').expect(200)).body.users;
  const gost = users.find((user) => user.email === 'gost@example.com');
  await admin.post(`/api/admin/users/${gost.id}/approve`).expect(200);
  await api.post('/api/auth/login').send({ email: 'gost@example.com', password: 'gost-long-password' }).expect(200);

  const blocked = (await admin.post(`/api/admin/users/${gost.id}/block`).send({ reason: 'ушёл' }).expect(200)).body;
  assert.equal(blocked.user.status, 'blocked');
  const refused = await api.post('/api/auth/login').send({ email: 'gost@example.com', password: 'gost-long-password' }).expect(403);
  assert.match(refused.body.error.message, /ушёл/);
});

// Список людей отвечает не только «сколько потратил», но и «живёт ли он тут»:
// записи за месяц и за неделю, последняя запись, полоса по дням, календарь и
// уведомления. Всё считается по уже записанному, отдельного журнала нет.
test('список людей показывает активность: записи за период, полоса дней и подключения', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  await gost.post('/api/captures').send({ raw: 'Проверить активность' }).expect(201);
  await gost.post('/api/captures').send({ raw: 'И ещё одна запись' }).expect(201);

  const body = (await admin.get('/api/admin/users').expect(200)).body;
  assert.equal(body.activityDays.length, 30, 'полоса — тридцать местных дат');
  const row = body.users.find((user) => user.email === 'gost@example.com');
  assert.equal(row.activity.capturesPeriod, 2);
  assert.equal(row.activity.capturesWeek, 2);
  assert.equal(row.activity.days.at(-1), 2, 'обе записи попали в сегодняшний столбик');
  assert.equal(row.activity.days.length, 30);
  assert.ok(row.activity.lastCaptureAt, 'последняя запись известна');
  assert.equal(row.activity.calendars, 0);
  assert.equal(row.activity.pushDevices, 0);

  // Тот, кто ничего не писал, виден нулями, а не пропущенной строкой: «не
  // пользуется» — это тоже ответ.
  const quiet = body.users.find((user) => user.email === 'admin@example.com');
  assert.equal(quiet.activity.capturesPeriod, 0);
  assert.equal(quiet.activity.lastCaptureAt, null);
  assert.deepEqual(new Set(quiet.activity.days), new Set([0]));
});

test('блокировка обрывает уже открытые сессии, а не ждёт, пока протухнет кука', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  await gost.get('/api/entries').expect(200);
  await admin.post(`/api/admin/users/${gost.user.id}/block`).expect(200);
  await gost.get('/api/entries').expect(401);
});

test('перебор пароля запирает учётную запись на время', async () => {
  const application = app();
  seedUser(application, { email: 'user@example.com', role: 'user' });
  const api = request(application);
  for (let attempt = 0; attempt < 8; attempt += 1)
    await api.post('/api/auth/login').send({ email: 'user@example.com', password: 'неверный-длинный' }).expect(401);
  // Дальше не пускают даже с правильным паролем: счётчик неудач важнее.
  await api.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD }).expect(429);
});

test('выход закрывает сессию, а смена пароля — все остальные', async () => {
  const application = app();
  const api = authed(application, { email: 'user@example.com', role: 'user' });
  const other = authed(application, { email: 'user@example.com', role: 'user' });
  await api.post('/api/auth/logout').expect(200);
  await api.get('/api/entries').expect(401);
  await other.get('/api/entries').expect(200);

  const third = authed(application, { email: 'user@example.com', role: 'user' });
  await third.post('/api/auth/password').send({ currentPassword: 'не-тот-пароль', newPassword: 'новый-длинный-пароль' }).expect(403);
  await third.post('/api/auth/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'короткий' }).expect(400);
  await third.post('/api/auth/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'новый-длинный-пароль' }).expect(200);
  await other.get('/api/entries').expect(401);
});

// ── второй фактор ────────────────────────────────────────────────────────────
test('второй фактор включается только подтверждённым кодом и спрашивается при входе', async () => {
  const application = app();
  const api = authed(application, { email: 'user@example.com', role: 'user' });
  await api.post('/api/auth/totp/enable').send({ code: '000000' }).expect(409);

  const setup = (await api.post('/api/auth/totp/setup').expect(200)).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.ok(setup.qr.startsWith('data:image/svg+xml;base64,'));
  await api.post('/api/auth/totp/enable').send({ code: '000000' }).expect(400);

  const enabled = (await api.post('/api/auth/totp/enable').send({ code: totpCode(setup.secret) }).expect(200)).body;
  assert.equal(enabled.recoveryCodes.length, 8);
  assert.equal((await api.get('/api/auth/me').expect(200)).body.user.twoFactorEnabled, true);

  const plain = request(application);
  const withoutCode = await plain.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD }).expect(401);
  assert.equal(withoutCode.body.error.code, 'totp_required');
  await plain.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD, code: '000000' }).expect(401);
  await plain.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD, code: totpCode(setup.secret) }).expect(200);

  // Резервный код одноразовый.
  const recovery = enabled.recoveryCodes[0];
  await plain.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD, code: recovery }).expect(200);
  await plain.post('/api/auth/login').send({ email: 'user@example.com', password: TEST_PASSWORD, code: recovery }).expect(401);
});

test('второй фактор выключается только с паролем', async () => {
  const application = app();
  const api = authed(application, { email: 'user@example.com', role: 'user' });
  const setup = (await api.post('/api/auth/totp/setup').expect(200)).body;
  await api.post('/api/auth/totp/enable').send({ code: totpCode(setup.secret) }).expect(200);
  await api.post('/api/auth/totp/disable').send({ password: 'не-тот-пароль' }).expect(403);
  await api.post('/api/auth/totp/disable').send({ password: TEST_PASSWORD }).expect(200);
  assert.equal((await api.get('/api/auth/me').expect(200)).body.user.twoFactorEnabled, false);
});

// ── роли ─────────────────────────────────────────────────────────────────────
test('обычный пользователь не управляет людьми и не трогает общие настройки', async () => {
  const application = app();
  authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  await gost.get('/api/admin/users').expect(403);
  await gost.get('/api/admin/auth-events').expect(403);
  await gost.post(`/api/admin/users/${gost.user.id}/role`).send({ role: 'admin' }).expect(403);

  const refused = await gost.put('/api/settings').send({ openaiKey: 'sk-подмена' }).expect(403);
  assert.equal(refused.body.error.code, 'forbidden');
  // Своё — пожалуйста: тема и привычки разговора у каждого свои.
  await gost.put('/api/settings').send({ theme: 'dark', wakeWord: 'алиса' }).expect(200);
  const settings = (await gost.get('/api/settings').expect(200)).body;
  assert.equal(settings.settings.theme, 'dark');
  assert.equal(settings.editable.includes('openaiKey'), false, 'интерфейс не показывает того, что вернёт отказ');
});

test('личные настройки не пересекаются между людьми', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  await admin.put('/api/settings').send({ wakeWord: 'кизуна' }).expect(200);
  await gost.put('/api/settings').send({ wakeWord: 'подруга' }).expect(200);
  assert.equal((await admin.get('/api/settings')).body.settings.wakeWord, 'кизуна');
  assert.equal((await gost.get('/api/settings')).body.settings.wakeWord, 'подруга');
});

test('последнего администратора не разжаловать и не заблокировать', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const solo = await admin.post(`/api/admin/users/${admin.user.id}/block`).expect(409);
  assert.equal(solo.body.error.code, 'last_admin');
  await admin.post(`/api/admin/users/${admin.user.id}/role`).send({ role: 'user' }).expect(409);

  // Со вторым администратором запрет снимается.
  const second = authed(application, { email: 'second@example.com', role: 'admin' });
  await admin.post(`/api/admin/users/${second.user.id}/role`).send({ role: 'user' }).expect(200);
});

test('удалить можно только того, у кого нет записей', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  const self = await admin.delete(`/api/admin/users/${admin.user.id}`).expect(409);
  assert.equal(self.body.error.code, 'self_delete');
  await gost.post('/api/captures').send({ raw: 'запись гостя' }).expect(201);
  await admin.delete(`/api/admin/users/${gost.user.id}`).expect(409);

  const empty = authed(application, { email: 'empty@example.com', role: 'user' });
  await admin.delete(`/api/admin/users/${empty.user.id}`).expect(200);
});

// ── журнал у каждого свой ────────────────────────────────────────────────────
test('записи, память, отчёт и экспорт видит только их автор', async () => {
  const application = app();
  const first = authed(application, { email: 'first@example.com', role: 'user' });
  const second = authed(application, { email: 'second@example.com', role: 'user' });

  const mine = (await first.post('/api/captures').send({ raw: 'секрет первого про Hub' }).expect(201)).body.entry;
  await second.post('/api/captures').send({ raw: 'дело второго' }).expect(201);

  assert.deepEqual((await first.get('/api/entries')).body.entries.map((entry) => entry.raw), ['секрет первого про Hub']);
  assert.deepEqual((await second.get('/api/entries')).body.entries.map((entry) => entry.raw), ['дело второго']);
  assert.deepEqual((await second.post('/api/memory/search').send({ query: 'Hub' })).body.results, [], 'чужое не ищется');
  assert.deepEqual((await second.get('/api/export')).body.captures.map((row) => row.raw), ['дело второго']);
  const day = (await second.get('/api/day')).body;
  assert.equal([...day.day, ...day.upcoming, ...day.attention].some((entry) => entry.raw.includes('секрет')), false);

  // Чужой идентификатор не открывает чужую запись ни на чтение, ни на правку.
  await second.post(`/api/captures/${mine.id}/notes`).send({ body: 'подмена' }).expect(404);
  await second.post(`/api/captures/${mine.id}/corrections`).send({ primaryType: 'note' }).expect(404);
  await second.delete(`/api/captures/${mine.id}`).expect(404);
  await second.post(`/api/captures/${mine.id}/classify`).expect(404);
  const projection = mine.projections[0];
  if (projection) {
    await second.post(`/api/projections/${projection.id}/complete`).expect(404);
    await second.post('/api/undo').send({ undoGroupId: projection.undoGroupId }).expect(404);
  }
});

test('очистка данных стирает только свой журнал', async () => {
  const application = app();
  const first = authed(application, { email: 'first@example.com', role: 'user' });
  const second = authed(application, { email: 'second@example.com', role: 'user' });
  await first.post('/api/captures').send({ raw: 'запись первого' }).expect(201);
  await second.post('/api/captures').send({ raw: 'запись второго' }).expect(201);
  await first.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  assert.equal((await first.get('/api/entries')).body.entries.length, 0);
  assert.equal((await second.get('/api/entries')).body.entries.length, 1, 'соседа очистка не касается');
});

test('расход считается на каждого отдельно', async () => {
  const application = app();
  const first = authed(application, { email: 'first@example.com', role: 'user' });
  const second = authed(application, { email: 'second@example.com', role: 'user' });
  recordUsage(application.database, { provider: 'openai', model: 'gpt-5.6-luna', kind: 'classify', inputTokens: 100, outputTokens: 20, costUsd: 0.01, userId: first.user.id });
  assert.equal((await first.get('/api/usage')).body.total.calls, 1);
  assert.equal((await second.get('/api/usage')).body.total.calls, 0, 'чужой расход в свою сумму не входит');
});

test('без входа не открывается ничего, кроме страницы входа', async () => {
  const api = request(app());
  for (const path of ['/api/entries', '/api/day', '/api/settings', '/api/usage', '/api/export', '/api/tags', '/api/voice/status', '/api/events'])
    assert.equal((await api.get(path)).status, 401, `${path} должен быть закрыт`);
  await api.post('/api/captures').send({ raw: 'без спроса' }).expect(401);
  // Корень гостю показывает, что это за приложение; журнала в нём нет.
  const hello = await api.get('/').expect(200);
  assert.match(hello.text, /Кизуна/);
  assert.doesNotMatch(hello.text, /id="today"/);
  await api.get('/login').expect(200);
  await api.get('/api/auth/state').expect(200);
});

// Пробовать надо на всём приложении: новому человеку открыт и разбор моделью,
// и разговор, но с потолком в доллар на месяц.
test('новому человеку открыто всё, но с потолком в доллар', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const api = request(application);
  await api.post('/api/auth/register').send({ email: 'gost@example.com', password: 'gost-long-password' }).expect(201);
  const gost = (await admin.get('/api/admin/users')).body.users.find(user => user.email === 'gost@example.com');
  await admin.post(`/api/admin/users/${gost.id}/approve`).expect(200);
  const login = await api.post('/api/auth/login').send({ email: 'gost@example.com', password: 'gost-long-password' }).expect(200);
  const cookie = login.headers['set-cookie'].find(value => value.startsWith('pagent_session='));
  // Потолок виден администратору рядом с расходом — доллар, а не «общий».
  const listed = (await admin.get('/api/admin/users')).body.users.find(user => user.email === 'gost@example.com');
  assert.equal(listed.monthlyLimitUsd, 1);
  // Разговор не закрыт: отказ, если и будет, то по расходу, а не по запрету.
  const status = (await api.get('/api/voice/status').set('Cookie', cookie).expect(200)).body;
  assert.notEqual(status.quota?.reason, 'voice_blocked_for_user');
  // Хозяину дома потолок не ставится: платит он.
  assert.equal(admin.user.monthly_limit_usd, null);
});

test('очередь заявок не бесконечна', async () => {
  const application = app();
  authed(application, { email: 'admin@example.com' });
  const api = request(application);
  // Пятьдесят нерассмотренных заявок — потолок: дальше очередь закрывается,
  // чтобы в ней не утонули настоящие люди.
  for (let index = 0; index < 50; index += 1)
    seedUser(application, { email: `pending-${index}@example.com`, role: 'user', status: 'pending' });
  const refused = await api.post('/api/auth/register').send({ email: 'last@example.com', password: 'very-long-password' }).expect(429);
  assert.equal(refused.body.error.code, 'too_many_pending');
});

// ── потолок расходов на месяц ────────────────────────────────────────────────
// Он про деньги, а деньги человек считает по календарю: «сколько ушло в
// августе» и «первого числа снова можно». Поэтому границы календарные.
test('границы месяца считаются в поясе приложения, а не в UTC', () => {
  const august = monthBounds(new Date('2026-08-15T12:00:00Z'), 'Europe/Samara');
  assert.equal(august.month, '2026-08');
  assert.equal(august.start, '2026-07-31T20:00:00.000Z', 'полночь первого августа в Самаре');
  assert.equal(august.end, '2026-08-31T20:00:00.000Z');
  // Тридцать первое августа, девять вечера по Гринвичу — в Самаре уже сентябрь.
  assert.equal(monthBounds(new Date('2026-08-31T21:00:00Z'), 'Europe/Samara').month, '2026-09');
  // Перевод часов внутри месяца не сдвигает границу на час.
  const march = monthBounds(new Date('2026-03-20T12:00:00Z'), 'America/New_York');
  assert.equal(march.start, '2026-03-01T05:00:00.000Z');
  assert.equal(march.end, '2026-04-01T04:00:00.000Z');
});

test('в сумму входят и модель, и разговор, и только за этот месяц', () => {
  const application = app();
  const db = application.database;
  const user = seedUser(application, { email: 'user@example.com', role: 'user' });
  // Время расхода задаётся явно, а не берётся у часов: иначе проверка живёт до
  // первого числа следующего месяца и падает не потому, что что-то сломалось.
  const now = new Date('2026-08-15T12:00:00Z');
  const spent = (id, cost, at) => db.prepare('INSERT INTO usage_events(id,provider,model,kind,input_tokens,output_tokens,cost_usd,created_at,user_id) VALUES(?,?,?,?,0,0,?,?,?)')
    .run(id, 'openrouter', 'x', 'classify', cost, at, user.id);
  spent('в месяце', 1.5, '2026-08-15T12:00:00.000Z');
  spent('без цены', null, '2026-08-15T12:01:00.000Z');
  // Расход прошлого месяца в этот не попадает.
  spent('прошлый', 99, '2026-07-15T12:00:00.000Z');
  const voice = openVoiceSession(db, { userId: user.id, provider: 'openai', ratePerMinute: 6, startedAt: now.toISOString() });
  closeVoiceSession(db, voice, { seconds: 60, at: new Date(now.getTime() + 60000).toISOString() });

  const spend = monthlySpend(db, { userId: user.id, at: now, timeZone: 'Europe/Samara' });
  assert.equal(spend.month, '2026-08');
  assert.equal(spend.modelUsd, 1.5);
  assert.ok(Math.abs(spend.voiceUsd - 6) < 1e-9, 'минута по шесть долларов');
  assert.ok(Math.abs(spend.totalUsd - 7.5) < 1e-9);
  assert.equal(spend.unpriced, 1, 'вызов без цены посчитан отдельно и в сумму не вошёл');
  // Чужой расход в свою сумму не входит.
  const other = seedUser(application, { email: 'other@example.com', role: 'user' });
  assert.equal(monthlySpend(db, { userId: other.id, at: now, timeZone: 'Europe/Samara' }).totalUsd, 0);
});

test('потолок ставит администратор, личный сильнее общего', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });

  await admin.put('/api/settings').send({ monthlyLimitUsd: '10' }).expect(200);
  assert.equal((await gost.get('/api/usage').expect(200)).body.spend.limitUsd, 10, 'общий потолок действует на всех');

  await admin.post(`/api/admin/users/${gost.user.id}/limits`).send({ monthlyLimitUsd: '3' }).expect(200);
  const personal = (await gost.get('/api/usage').expect(200)).body.spend;
  assert.equal(personal.limitUsd, 3, 'личный сильнее общего');
  assert.equal(personal.allowed, true);

  // Пустое поле — «своего нет», а не ноль.
  await admin.post(`/api/admin/users/${gost.user.id}/limits`).send({ monthlyLimitUsd: '' }).expect(200);
  assert.equal((await gost.get('/api/usage')).body.spend.limitUsd, 10);
  await admin.post(`/api/admin/users/${gost.user.id}/limits`).send({ monthlyLimitUsd: 'много' }).expect(400);
  // Свой потолок человек себе не ставит.
  await gost.put('/api/settings').send({ monthlyLimitUsd: '1000' }).expect(403);
});

test('за потолком запись сохраняется, но разбирается по правилам', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  await admin.post(`/api/admin/users/${gost.user.id}/limits`).send({ monthlyLimitUsd: '1' }).expect(200);
  recordUsage(application.database, { provider: 'openrouter', model: 'x', kind: 'classify', costUsd: 2, userId: gost.user.id });

  const created = await gost.post('/api/captures').send({ raw: 'мысль за потолком', provider: 'openrouter' }).expect(201);
  assert.equal(created.body.entry.raw, 'мысль за потолком', 'мысль не потеряна');
  assert.equal(created.body.provenance.usedProvider, 'fallback');
  assert.equal(created.body.provenance.fallbackReason, 'spend_limit', 'сказано, почему разобрали правилами');
  assert.equal(created.body.spend.allowed, false);

  // Повторный разбор — действие платное и по своей воле: подменять модель
  // правилами нельзя, хороший разбор затёрся бы худшим.
  const refused = await gost.post(`/api/captures/${created.body.entry.id}/classify`).send({ provider: 'openrouter' }).expect(429);
  assert.equal(refused.body.error.code, 'spend_limit');
  // Разговор тоже закрыт.
  const voice = await gost.post('/api/voice/session').send({}).expect(429);
  assert.equal(voice.body.error.code, 'spend_limit');

  // У соседа потолка нет — у него всё по-прежнему.
  const mine = await admin.post('/api/captures').send({ raw: 'запись администратора', provider: 'openrouter' }).expect(201);
  assert.equal(mine.body.provenance.usedProvider, 'openrouter');
  assert.equal(mine.body.spend, undefined);
});

test('администратор видит расход каждого рядом с его потолком', async () => {
  const application = app();
  const admin = authed(application, { email: 'admin@example.com' });
  const gost = authed(application, { email: 'gost@example.com', role: 'user' });
  recordUsage(application.database, { provider: 'openrouter', model: 'x', kind: 'classify', costUsd: 4.25, userId: gost.user.id });
  await admin.post(`/api/admin/users/${gost.user.id}/limits`).send({ monthlyLimitUsd: '9' }).expect(200);
  const listed = (await admin.get('/api/admin/users').expect(200)).body.users.find((user) => user.email === 'gost@example.com');
  assert.equal(listed.monthSpentUsd, 4.25);
  assert.equal(listed.monthlyLimitUsd, 9);
  await gost.get('/api/admin/users').expect(403);
});
