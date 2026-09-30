import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

// Настройки — это конфигурация, а не журнал: они живут своей таблицей, не
// попадают в экспорт и переживают очистку данных. Ключи наружу не отдаются.
function app(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-settings-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), ...overrides });
}

test('settings come back without secrets and with sensible defaults', async () => {
  const api = authed(app());
  const body = (await api.get('/api/settings').expect(200)).body;
  assert.equal(body.settings.remindDefault, '15');
  assert.equal(body.settings.remindHour, '09:00');
  assert.equal(body.settings.theme, 'system');
  // Голоса в приложении нет: и его настроек нет.
  for (const gone of ['wakeWord', 'sleepAfterSeconds', 'voiceProvider', 'voiceName', 'systemPrompt', 'voiceInterrupt', 'voicePause', 'voiceEnabled'])
    assert.equal(Object.hasOwn(body.settings, gone), false, gone);
  assert.equal(Object.hasOwn(body, 'voice'), false);
  assert.equal(Object.hasOwn(body, 'quota'), false);
  // Ключ описывается признаком, а не значением.
  assert.deepEqual(Object.keys(body.settings.openaiKey).sort(), ['configured', 'fromEnvironment', 'hint']);
  assert.equal(typeof body.settings.openaiKey.configured, 'boolean');
  assert.ok(body.timeZone, 'пояс назван');
});

test('a key set in the app never leaves the server and beats the environment', async () => {
  const api = authed(app());
  const secret = 'очень-секретный-ключ-4321';
  const saved = (await api.put('/api/settings').send({ geminiKey: secret }).expect(200)).body;
  assert.equal(saved.settings.geminiKey.configured, true);
  assert.equal(saved.settings.geminiKey.hint, '••••4321');
  assert.equal(saved.settings.geminiKey.fromEnvironment, false, 'ключ из приложения, а не из .env');

  // Ни в одном ответе целого ключа нет — только последние знаки.
  const listed = JSON.stringify((await api.get('/api/settings').expect(200)).body);
  assert.equal(listed.includes(secret), false);
  assert.equal(listed.includes('очень-секретный'), false);

  // Пустое значение возвращает всё как было: снова берём из окружения. В этом
  // прогоне ключ в окружении может и быть — важно, что введённый забыт.
  const cleared = (await api.put('/api/settings').send({ geminiKey: '' }).expect(200)).body;
  assert.notEqual(cleared.settings.geminiKey.hint, '••••4321', 'введённый ключ забыт');
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY)
    assert.equal(cleared.settings.geminiKey.configured, false);
});

test('a changed timezone applies at once, without restarting the server', async () => {
  const fixedNow = () => new Date('2026-08-20T20:30:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-settings-zone-'));
  const api = authed(
    createApp({
      aiService: fakeModelService({ now: fixedNow }),
      databasePath: path.join(dir, 'test.sqlite'),
      timeZone: 'Europe/London',
      now: fixedNow,
    }),
  );
  assert.equal((await api.get('/api/day').expect(200)).body.date, '2026-08-20');

  await api.put('/api/settings').send({ timeZone: 'Asia/Vladivostok' }).expect(200);
  // Во Владивостоке уже следующий день — и день журнала считается по нему.
  assert.equal((await api.get('/api/day').expect(200)).body.date, '2026-08-21');
  assert.equal((await api.get('/api/settings').expect(200)).body.timeZone, 'Asia/Vladivostok');
});

test('nonsense settings are refused by name and by value', async () => {
  const api = authed(app());
  const unknown = await api.put('/api/settings').send({ чтоТоЕщё: '1' }).expect(400);
  assert.equal(unknown.body.error.code, 'unknown_setting');

  for (const patch of [
    { timeZone: 'Не/Зона' },
    { remindDefault: '99999999' },
    { remindDefault: 'скоро' },
    { remindHour: '25:00' },
    { theme: 'ярко' },
    { aiProvider: 'выдуманный' },
  ]) {
    const refused = await api.put('/api/settings').send(patch).expect(400);
    assert.equal(refused.body.error.code, 'invalid_setting', JSON.stringify(patch));
  }
  // Отказ ничего не сохранил.
  assert.equal((await api.get('/api/settings').expect(200)).body.settings.remindDefault, '15');
  // Настройки голоса убраны вместе с голосом: имя больше не известно.
  for (const gone of ['wakeWord', 'voiceProvider', 'systemPrompt', 'voiceInterrupt'])
    assert.equal((await api.put('/api/settings').send({ [gone]: 'x' }).expect(400)).body.error.code, 'unknown_setting', gone);
});

// Напоминания — про человека, а не про установку: каждый правит свои и не
// трогает соседские.
test('reminder settings are personal: defaults for everyone, changed by anyone for themselves', async () => {
  const instance = app();
  const admin = authed(instance);
  const user = authed(instance, { email: 'user@kizuna.test', role: 'user' });
  const before = (await user.get('/api/settings').expect(200)).body;
  assert.equal(before.settings.remindDefault, '15');
  assert.equal(before.settings.remindHour, '09:00');
  assert.ok(before.editable.includes('remindDefault') && before.editable.includes('remindHour'), 'не только администратору');

  await user.put('/api/settings').send({ remindDefault: 'off', remindHour: '18:00' }).expect(200);
  const mine = (await user.get('/api/settings').expect(200)).body.settings;
  assert.equal(mine.remindDefault, 'off');
  assert.equal(mine.remindHour, '18:00');
  const theirs = (await admin.get('/api/settings').expect(200)).body.settings;
  assert.equal(theirs.remindDefault, '15');
  assert.equal(theirs.remindHour, '09:00');
});

test('settings survive a data reset and stay out of the export', async () => {
  const api = authed(app());
  await api.put('/api/settings').send({ remindHour: '07:45', remindDefault: '60' }).expect(200);
  await api.post('/api/captures').send({ raw: 'Нужно проверить настройки' }).expect(201);

  const exported = (await api.get('/api/export').expect(200)).body;
  assert.equal(JSON.stringify(exported).includes('07:45'), false, 'настройки не уходят в экспорт');

  // «Очистить данные» — про записи, а не про конфигурацию: иначе сброс отбирал
  // бы у человека ключи и он остался бы без модели.
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  const after = (await api.get('/api/settings').expect(200)).body.settings;
  assert.equal(after.remindHour, '07:45');
  assert.equal(after.remindDefault, '60');
  assert.equal((await api.get('/api/entries').expect(200)).body.entries.length, 0);
});

// Расходы: сколько ушло токенов и денег. Токены берём у провайдера, деньги — по
// его же цене; где цены нет, вызов честно считается «без цены».
test('usage is counted per provider and priced only where the price is known', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-usage-'));
  const databasePath = path.join(dir, 'test.sqlite');
  const application = createApp({
    databasePath,
    aiService: {
      status: async () => ({ mode: 'openrouter', providers: {}, defaultProvider: 'openrouter', selectedProvider: 'openrouter' }),
      classify: async (raw) => ({
        classification: {
          primaryType: 'note',
          entities: { projects: [], people: [], schedule: null, followUp: null },
          additionalTypes: [], summary: raw, proposedActions: [], claims: [], confidence: {}, conflicts: {},
        },
        provider: 'openrouter', requestedProvider: 'openrouter', usedProvider: 'openrouter',
        model: 'google/gemini-3.7-flash', fallbackReason: null,
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.00075 },
      }),
      answer: async () => ({
        answer: 'ответ', citationIds: [], provider: 'openai', requestedProvider: 'openai', usedProvider: 'openai',
        model: 'gpt-5.6-luna', usage: { inputTokens: 500, outputTokens: 100, costUsd: null },
      }),
    },
  });
  const api = authed(application);
  const empty = (await api.get('/api/usage').expect(200)).body;
  assert.equal(empty.total.calls, 0);

  await api.post('/api/captures').send({ raw: 'Нужно посчитать расход' }).expect(201);
  await api.post('/api/memory/answer').send({ query: 'что было?' }).expect(200);

  const usage = (await api.get('/api/usage').expect(200)).body;
  assert.equal(usage.total.calls, 2);
  assert.equal(usage.total.inputTokens, 1500);
  assert.equal(usage.total.outputTokens, 300);
  // Деньги только там, где провайдер назвал цену.
  assert.ok(Math.abs(usage.total.costUsd - 0.00075) < 1e-9);
  assert.equal(usage.total.unpriced, 1, 'вызов без цены посчитан отдельно');
  // Разбивка по моделям — видно, что именно тратит.
  const byModel = Object.fromEntries(usage.total.rows.map((row) => [row.model, row]));
  assert.equal(byModel['google/gemini-3.7-flash'].calls, 1);
  assert.equal(byModel['gpt-5.6-luna'].unpriced, 1);
  // Сутки и неделя видят те же вызовы: они только что случились.
  assert.equal(usage.day.calls, 2);
  assert.equal(usage.week.calls, 2);

  // Расход — операционные данные: в экспорт он не попадает, а «очистить
  // данные» его уносит вместе с записями.
  const exported = (await api.get('/api/export').expect(200)).body;
  assert.equal(JSON.stringify(exported).includes('gemini-3.7-flash'), false);
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  assert.equal((await api.get('/api/usage').expect(200)).body.total.calls, 0);
});
