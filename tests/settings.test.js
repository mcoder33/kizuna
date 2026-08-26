import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';

// Настройки — это конфигурация, а не журнал: они живут своей таблицей, не
// попадают в экспорт и переживают очистку данных. Ключи наружу не отдаются.
function app(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-settings-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), ...overrides });
}

test('settings come back without secrets and with sensible defaults', async () => {
  const api = request(app());
  const body = (await api.get('/api/settings').expect(200)).body;
  assert.equal(body.settings.sleepAfterSeconds, '25');
  assert.equal(body.settings.wakeWord, 'кизуна');
  assert.equal(body.settings.previewLimit, '3');
  // Ключ описывается признаком, а не значением.
  assert.deepEqual(Object.keys(body.settings.openaiKey).sort(), ['configured', 'fromEnvironment', 'hint']);
  assert.equal(typeof body.settings.openaiKey.configured, 'boolean');
  assert.ok(body.timeZone, 'пояс назван');
});

test('a key set in the app never leaves the server and beats the environment', async () => {
  const api = request(app());
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
  const api = request(
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
  const api = request(app());
  const unknown = await api.put('/api/settings').send({ чтоТоЕщё: '1' }).expect(400);
  assert.equal(unknown.body.error.code, 'unknown_setting');

  for (const patch of [
    { timeZone: 'Не/Зона' },
    { sleepAfterSeconds: '5000' },
    { sleepAfterSeconds: 'скоро' },
    { previewLimit: '0' },
    { wakeWord: 'к' },
    { voiceProvider: 'кто-нибудь' },
    { aiProvider: 'выдуманный' },
    { voiceName: 'голос с пробелом и (скобками)' },
  ]) {
    const refused = await api.put('/api/settings').send(patch).expect(400);
    assert.equal(refused.body.error.code, 'invalid_setting', JSON.stringify(patch));
  }
  // Отказ ничего не сохранил.
  assert.equal((await api.get('/api/settings').expect(200)).body.settings.sleepAfterSeconds, '25');
});

test('settings survive a data reset and stay out of the export', async () => {
  const api = request(app());
  await api.put('/api/settings').send({ wakeWord: 'журнал', previewLimit: '7' }).expect(200);
  await api.post('/api/captures').send({ raw: 'Нужно проверить настройки' }).expect(201);

  const exported = (await api.get('/api/export').expect(200)).body;
  assert.equal(JSON.stringify(exported).includes('журнал'), false, 'настройки не уходят в экспорт');

  // «Очистить данные» — про записи, а не про конфигурацию: иначе сброс отбирал
  // бы у человека ключи и он остался бы без модели.
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  const after = (await api.get('/api/settings').expect(200)).body.settings;
  assert.equal(after.wakeWord, 'журнал');
  assert.equal(after.previewLimit, '7');
  assert.equal((await api.get('/api/entries').expect(200)).body.entries.length, 0);
});
