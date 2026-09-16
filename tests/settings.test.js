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
  assert.equal(body.settings.sleepAfterSeconds, '25');
  assert.equal(body.settings.wakeWord, 'кизуна');
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
    { sleepAfterSeconds: '5000' },
    { sleepAfterSeconds: 'скоро' },
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
  const api = authed(app());
  await api.put('/api/settings').send({ wakeWord: 'журнал', sleepAfterSeconds: '60' }).expect(200);
  await api.post('/api/captures').send({ raw: 'Нужно проверить настройки' }).expect(201);

  const exported = (await api.get('/api/export').expect(200)).body;
  assert.equal(JSON.stringify(exported).includes('журнал'), false, 'настройки не уходят в экспорт');

  // «Очистить данные» — про записи, а не про конфигурацию: иначе сброс отбирал
  // бы у человека ключи и он остался бы без модели.
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  const after = (await api.get('/api/settings').expect(200)).body.settings;
  assert.equal(after.wakeWord, 'журнал');
  assert.equal(after.sleepAfterSeconds, '60');
  assert.equal((await api.get('/api/entries').expect(200)).body.entries.length, 0);
});

// Род голоса и добавка к промпту: модель должна говорить о себе так же, каким
// голосом звучит, а человек — уметь дописать своё правило, не отменяя базовых.
test('the chosen voice sets the gender the model speaks in, and the addition is appended', async () => {
  const api = authed(app());
  const base = (await api.get('/api/voice/status').expect(200)).body;
  assert.ok(base.instructions.includes('Кизуна'), 'основной промпт на месте');
  assert.ok(base.voices.gemini.some((voice) => voice.id === 'Puck'), 'каталог голосов отдаётся');
  assert.ok(base.voices.openai.some((voice) => voice.id === 'cedar'));

  // Пока человек не написал своего промпта, действует характер Кизуны по
  // умолчанию — мягкий японский акцент.
  assert.match(base.instructions, /От человека: Говори с лёгким японским акцентом/);

  // Ключ кладём через сами настройки: без ключа выбор Gemini-провайдера не
  // вступает в силу, а тест не должен зависеть от .env машины, на которой идёт.
  await api.put('/api/settings').send({ geminiKey: 'тестовый-ключ-для-рода' }).expect(200);

  // Мужской голос — мужской род.
  await api.put('/api/settings').send({ voiceProvider: 'gemini', geminiVoiceName: 'Charon' }).expect(200);
  const male = (await api.get('/api/voice/status').expect(200)).body;
  assert.match(male.instructions, /мужским голосом/);
  assert.match(male.instructions, /«записал»/);

  // Женский — женский, и это именно смена, а не дописывание второй строки.
  await api.put('/api/settings').send({ geminiVoiceName: 'Kore' }).expect(200);
  const female = (await api.get('/api/voice/status').expect(200)).body;
  assert.match(female.instructions, /женским голосом/);
  assert.equal(female.instructions.includes('мужским голосом'), false);

  // Добавка дописывается к основному промпту, а не заменяет его.
  await api.put('/api/settings').send({ systemPrompt: 'Обращайся ко мне на «ты».' }).expect(200);
  const custom = (await api.get('/api/voice/status').expect(200)).body;
  assert.ok(custom.instructions.includes('Кизуна'), 'основные правила остались');
  assert.ok(custom.instructions.includes('женским голосом'), 'род остался');
  assert.match(custom.instructions, /От человека: Обращайся ко мне на «ты»\./);
  assert.equal(custom.instructions.includes('японским акцентом'), false, 'свой промпт заменяет характер по умолчанию');
  // И то же самое уходит в сессию, а не только в статус.
  const session = await api.post('/api/voice/session').send({});
  if (session.status === 200) assert.match(session.body.instructions, /От человека:/);

  // Пустая строка — «вернуть как было»: характер по умолчанию, а не тишина.
  await api.put('/api/settings').send({ systemPrompt: '' }).expect(200);
  const restored = (await api.get('/api/voice/status').expect(200)).body;
  assert.match(restored.instructions, /От человека: Говори с лёгким японским акцентом/);
});

test('a voice outside the catalogue is refused, because gender rides on it', async () => {
  const api = authed(app());
  await api.put('/api/settings').send({ geminiVoiceName: 'Выдуманный' }).expect(400);
  await api.put('/api/settings').send({ voiceName: 'nova' }).expect(400);
  await api.put('/api/settings').send({ voiceName: 'cedar' }).expect(200);
  assert.equal((await api.get('/api/settings').expect(200)).body.settings.voiceName, 'cedar');
  // Слишком длинная добавка тоже отвергается.
  await api.put('/api/settings').send({ systemPrompt: 'а'.repeat(2001) }).expect(400);
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
