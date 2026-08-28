import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { createVoiceService, runVoiceTool, mockVoiceTurn, pickVoiceProvider, geminiTools, VOICE_TOOLS, VOICE_INSTRUCTIONS, GEMINI_LIVE_URL } from '../server/voice.js';
import { openDatabase, createLedger } from '../server/db.js';
import { normalizeClassification } from '../server/classifier.js';
import { fakeModelService } from './helpers/fake-model.js';

function app(voiceService) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-voice-'));
  return createApp({ aiService: fakeModelService(), voiceService, databasePath: path.join(dir, 'test.sqlite') });
}
// Разобранная запись: инструменты правки работают только с ней, поэтому
// готовим её сразу с интерпретацией, а не через очередь.
function parsedCapture(db, raw, overrides = {}) {
  const classification = normalizeClassification(
    {
      primaryType: 'task',
      entities: { projects: [], people: [], when: null, followUp: null },
      additionalTypes: [],
      summary: raw,
      proposedActions: [],
      completed: false,
      ambiguity: null,
      ...overrides,
    },
    raw,
  );
  return createLedger(db, { raw, classification, provider: 'manual' }).captureId;
}
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-voice-db-'));
  return openDatabase(path.join(dir, 'test.sqlite'));
}
test('voice tools are declared once and shared by both modes', () => {
  const names = VOICE_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    'create_capture',
    'search_memory',
    'list_today',
    'append_note',
    'read_capture',
    'delete_capture',
    'restore_capture',
    'update_capture',
  ]);
  for (const tool of VOICE_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
  }
});

test('create_capture saves through the normal pipeline and honours spoken parameters', () => {
  const db = database();
  const result = runVoiceTool(db, 'create_capture', {
    text: 'позвонить Даниилу по релизу',
    type: 'todo',
    due: { date: '2026-08-26', time: '15:00' },
    priority: 'high',
    tags: ['Hub'],
  }, { now: () => new Date('2026-08-25T10:00:00Z') });
  assert.equal(result.saved, true);
  assert.match(result.captureId, /^[0-9a-f-]{36}$/);
  const stored = db.prepare('SELECT raw FROM captures WHERE id=?').get(result.captureId);
  assert.equal(stored.raw, 'позвонить Даниилу по релизу');
  // Параметры едут с заданием и накладываются после разбора моделью.
  const job = db.prepare('SELECT overrides_json FROM capture_jobs WHERE capture_id=?').get(result.captureId);
  const overrides = JSON.parse(job.overrides_json);
  assert.equal(overrides.primaryType, 'task');
  assert.deepEqual(overrides.due, { date: '2026-08-26', time: '15:00' });
  assert.equal(overrides.priority, 'high');
  assert.deepEqual(overrides.tags, ['hub']);
});

test('create_capture refuses empty and oversized text', () => {
  const db = database();
  assert.match(runVoiceTool(db, 'create_capture', { text: '   ' }).error, /текст/i);
  assert.match(runVoiceTool(db, 'create_capture', { text: 'x'.repeat(10001) }).error, /текст/i);
});

test('search_memory and list_today read the journal without changing it', () => {
  const db = database();
  runVoiceTool(db, 'create_capture', { text: 'разобрал отчёт по Hub' });
  runVoiceTool(db, 'create_capture', { text: 'созвон с Даниилом' });
  const before = db.prepare('SELECT COUNT(*) AS count FROM captures').get().count;
  const found = runVoiceTool(db, 'search_memory', { query: 'отчёт' });
  assert.equal(found.found, 1);
  assert.match(found.results[0].snippet, /отчёт/);
  assert.equal(runVoiceTool(db, 'search_memory', { query: 'ничего похожего' }).found, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count, before);
  assert.match(runVoiceTool(db, 'search_memory', { query: '' }).error, /запрос/i);
});

test('append_note versions the note and never touches the raw capture', () => {
  const db = database();
  const created = runVoiceTool(db, 'create_capture', { text: 'исходная запись' });
  const first = runVoiceTool(db, 'append_note', { captureId: created.captureId, text: 'первая мысль' });
  assert.equal(first.appended, true);
  assert.equal(first.version, 1);
  const second = runVoiceTool(db, 'append_note', { captureId: created.captureId, text: 'вторая мысль' });
  assert.equal(second.version, 2);
  const note = db.prepare("SELECT body FROM capture_notes WHERE capture_id=? AND status='active'").get(created.captureId);
  assert.match(note.body, /первая мысль/);
  assert.match(note.body, /вторая мысль/);
  assert.equal(db.prepare('SELECT raw FROM captures WHERE id=?').get(created.captureId).raw, 'исходная запись');
  assert.match(runVoiceTool(db, 'append_note', { captureId: 'нет-такой', text: 'что-то' }).error, /не найдена/i);
});

test('unknown tools are refused', () => {
  const db = database();
  assert.match(runVoiceTool(db, 'delete_everything', {}).error, /Неизвестный инструмент/);
});

test('a mock turn walks the same tools: saving, listing, searching, appending', () => {
  const db = database();
  const now = () => new Date('2026-08-25T09:00:00Z');

  const saved = mockVoiceTurn(db, 'запиши задачу позвонить Даниилу завтра в 15:00 важно #hub', { now });
  assert.equal(saved.calls[0].name, 'create_capture');
  assert.equal(saved.calls[0].arguments.type, 'todo');
  assert.deepEqual(saved.calls[0].arguments.due, { date: '2026-08-26', time: '15:00' });
  assert.equal(saved.calls[0].arguments.priority, 'high');
  assert.deepEqual(saved.calls[0].arguments.tags, ['hub']);
  assert.match(saved.reply, /Записал как дело/);

  const listed = mockVoiceTurn(db, 'что у меня сегодня', { now });
  assert.equal(listed.calls[0].name, 'list_today');
  assert.match(listed.reply, /\d/);

  const searched = mockVoiceTurn(db, 'найди про Даниила', { now });
  assert.equal(searched.calls[0].name, 'search_memory');
  assert.match(searched.reply, /Нашёл|ничего не нашёл/);

  const appended = mockVoiceTurn(db, 'допиши обсудили сроки', { now });
  assert.equal(appended.calls[0].name, 'append_note');
  assert.match(appended.reply, /Дописал/);
});

test('a mock turn keeps plain speech as a capture and stays quiet on silence', () => {
  const db = database();
  const plain = mockVoiceTurn(db, 'кажется, стоит пересмотреть план недели');
  assert.equal(plain.calls[0].name, 'create_capture');
  assert.equal(plain.calls[0].arguments.text, 'кажется, стоит пересмотреть план недели');
  const silent = mockVoiceTurn(db, '   ');
  assert.deepEqual(silent.calls, []);
  assert.match(silent.reply, /слушаю/i);
});

test('without any key the service reports the mock mode and asks for no session', async () => {
  const service = createVoiceService({ apiKey: '', geminiApiKey: '' });
  const status = service.status();
  assert.deepEqual(
    { ...status, providers: undefined },
    { configured: false, provider: null, mode: 'mock', model: null, voice: null, providers: undefined },
  );
  assert.equal(status.providers.openai.configured, false);
  assert.equal(status.providers.gemini.configured, false);
  assert.deepEqual(await service.createSession(), { mode: 'mock' });
});

// Провайдера голоса выбирают на один разговор: с двумя ключами выбор работает,
// а названный без ключа не подменяется молча — иначе человек считал бы, что
// говорит с одной моделью, а говорил бы с другой.
test('a chosen voice provider wins, and one without a key is refused instead of swapped', async () => {
  const asked = [];
  const service = createVoiceService({
    apiKey: 'openai-key',
    geminiApiKey: 'gemini-key',
    provider: 'openai',
    fetch: async (url) => {
      asked.push(String(url));
      return String(url).includes('auth_tokens')
        ? { ok: true, json: async () => ({ name: 'auth_tokens/short' }) }
        : { ok: true, json: async () => ({ value: 'ek_secret', expires_at: 1 }) };
    },
  });
  const status = service.status();
  assert.equal(status.provider, 'openai', 'по умолчанию — тот, что выбран настройкой');
  assert.equal(status.providers.openai.configured, true);
  assert.equal(status.providers.gemini.configured, true);

  assert.equal((await service.createSession()).provider, 'openai');
  assert.equal((await service.createSession({ provider: 'gemini' })).provider, 'gemini');
  assert.equal((await service.createSession({ provider: 'openai' })).provider, 'openai');
  assert.ok(asked.some((url) => url.includes('auth_tokens')), 'выбор дошёл до Google');

  const single = createVoiceService({ apiKey: '', geminiApiKey: 'gemini-key', fetch: async () => ({ ok: true, json: async () => ({ name: 'n' }) }) });
  assert.deepEqual(await single.createSession({ provider: 'openai' }), {
    mode: 'live',
    provider: 'openai',
    error: 'not_configured',
  });
});

test('with a key the service asks OpenAI for an ephemeral secret and never leaks the key', async () => {
  const requests = [];
  const service = createVoiceService({
    apiKey: 'sk-test-key',
    geminiApiKey: '',
    model: 'gpt-realtime',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ value: 'ek_short_lived', expires_at: 1756310470 }) };
    },
  });
  assert.equal(service.status().mode, 'live');
  const session = await service.createSession();
  assert.equal(session.mode, 'live');
  assert.equal(session.clientSecret, 'ek_short_lived');
  assert.equal(session.expiresAt, 1756310470);

  const [call] = requests;
  assert.equal(call.url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(call.options.headers.Authorization, 'Bearer sk-test-key');
  const body = JSON.parse(call.options.body);
  assert.equal(body.session.type, 'realtime');
  assert.equal(body.session.model, 'gpt-realtime');
  assert.equal(body.session.tool_choice, 'auto');
  assert.deepEqual(body.session.tools.map((tool) => tool.name), VOICE_TOOLS.map((tool) => tool.name));
  assert.ok(body.expires_after.seconds <= 600, 'токен должен быть коротким');
});

test('a failing or slow realtime API degrades with a safe reason', async () => {
  const failing = createVoiceService({ apiKey: 'sk-test', geminiApiKey: '', fetch: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(await failing.createSession(), { mode: 'live', provider: 'openai', error: 'unavailable', status: 500 });

  const malformed = createVoiceService({ apiKey: 'sk-test', geminiApiKey: '', fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal((await malformed.createSession()).error, 'malformed_output');

  const aborted = createVoiceService({
    apiKey: 'sk-test',
    geminiApiKey: '',
    fetch: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  assert.equal((await aborted.createSession()).error, 'timeout');
});

test('the api exposes status, session, tools and turns', async () => {
  const api = authed(app(createVoiceService({ apiKey: '', geminiApiKey: '' })));

  const status = (await api.get('/api/voice/status').expect(200)).body;
  assert.equal(status.mode, 'mock');
  assert.equal(status.configured, false);
  assert.ok(status.instructions.length > 10);
  assert.deepEqual(status.tools.map((tool) => tool.name), VOICE_TOOLS.map((tool) => tool.name));

  // Без ключа сессия честно отвечает режимом заглушки, а не выдумывает токен.
  assert.deepEqual((await api.post('/api/voice/session').expect(200)).body.mode, 'mock');

  const saved = (await api.post('/api/voice/turn').send({ text: 'запиши задачу проверить экспорт' }).expect(200)).body;
  assert.equal(saved.calls[0].name, 'create_capture');
  assert.match(saved.reply, /Записал/);

  const listed = (await api.post('/api/voice/tool').send({ name: 'list_today' }).expect(200)).body;
  assert.equal(listed.name, 'list_today');
  assert.ok(listed.result.total >= 1);

  await api.post('/api/voice/tool').send({ name: 'нет-такого' }).expect(400);
  await api.post('/api/voice/tool').send({ name: 'create_capture', arguments: { text: '' } }).expect(400);
  await api.post('/api/voice/turn').send({ text: 'x'.repeat(2001) }).expect(400);
});

test('with a key the session endpoint hands the browser a short-lived secret only', async () => {
  const api = authed(app(createVoiceService({
    apiKey: 'sk-secret-key',
    geminiApiKey: '',
    fetch: async () => ({ ok: true, json: async () => ({ value: 'ek_browser', expires_at: 42 }) }),
  })));
  const status = (await api.get('/api/voice/status').expect(200)).body;
  assert.equal(status.mode, 'live');
  const session = (await api.post('/api/voice/session').expect(200)).body;
  assert.equal(session.clientSecret, 'ek_browser');
  assert.equal(JSON.stringify(session).includes('sk-secret-key'), false, 'ключ не должен уходить в браузер');
});

test('an unavailable realtime API answers 503 instead of pretending', async () => {
  const api = authed(app(createVoiceService({ apiKey: 'sk-test', geminiApiKey: '', fetch: async () => ({ ok: false, status: 429 }) })));
  const failed = await api.post('/api/voice/session').expect(503);
  assert.equal(failed.body.error.code, 'unavailable');
});

test('update_capture changes the parse and refuses what is still being parsed', () => {
  const db = database();
  const queued = runVoiceTool(db, 'create_capture', { text: 'ещё не разобрано' });
  // Пока разбор идёт, поправить нечего — и об этом говорится прямо.
  assert.match(runVoiceTool(db, 'update_capture', { captureId: queued.captureId, done: true }).error, /разбирается/);
  assert.match(runVoiceTool(db, 'update_capture', { captureId: 'нет-такой' }).error, /не найдена/i);

  const captureId = parsedCapture(db, 'подготовить отчёт');
  const created = { captureId };
  const retyped = runVoiceTool(db, 'update_capture', { captureId, type: 'note' });
  assert.equal(retyped.type, 'заметка');
  const dated = runVoiceTool(db, 'update_capture', { captureId: created.captureId, type: 'todo', due: { date: '2026-08-27' } });
  assert.match(dated.due, /2026-08-27/);
  const done = runVoiceTool(db, 'update_capture', { captureId: created.captureId, done: true });
  assert.equal(done.captureId, created.captureId);
  const stored = JSON.parse(db.prepare("SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(created.captureId).classification_json);
  assert.equal(stored.completed, true);
  // Исходный текст записи правки не трогают.
  assert.equal(db.prepare('SELECT raw FROM captures WHERE id=?').get(created.captureId).raw, 'подготовить отчёт');
});

test('a spoken change reaches the journal: mark done, move, retype', () => {
  const db = database();
  const now = () => new Date('2026-08-25T09:00:00Z');
  parsedCapture(db, 'позвонить в банк');

  const moved = mockVoiceTurn(db, 'перенеси на завтра', { now });
  assert.equal(moved.calls[0].name, 'update_capture');
  assert.deepEqual(moved.calls[0].arguments.due, { date: '2026-08-26' });
  assert.match(moved.reply, /Перенёс/);

  const retyped = mockVoiceTurn(db, 'это заметка', { now });
  assert.equal(retyped.calls[0].arguments.type, 'note');
  assert.match(retyped.reply, /Теперь это заметка/);

  const completed = mockVoiceTurn(db, 'отметь как сделанное', { now });
  assert.equal(completed.calls[0].arguments.done, true);
  assert.match(completed.reply, /Отметил сделанным/);
});

test('a question is a conversation, not a silent capture', () => {
  const db = database();
  runVoiceTool(db, 'create_capture', { text: 'решили переносить релиз на пятницу' });
  const asked = mockVoiceTurn(db, 'стоит ли переносить релиз?');
  // Вопрос не превращается в запись: заглушка ищет в журнале и честно
  // говорит, что рассуждать без модели не берётся.
  assert.equal(asked.calls[0].name, 'search_memory');
  assert.ok(!asked.calls.some((call) => call.name === 'create_capture'));
  assert.match(asked.reply, /Не берусь рассуждать|Без модели я не рассуждаю/);
});

test('the provider is chosen by the key, and an explicit choice wins', () => {
  // Явный выбор сильнее: с двумя ключами берётся названный.
  assert.equal(pickVoiceProvider({ requested: 'gemini', openaiKey: 'sk', geminiKey: 'g' }), 'gemini');
  assert.equal(pickVoiceProvider({ requested: 'openai', openaiKey: 'sk', geminiKey: 'g' }), 'openai');
  // Названный без ключа не выбирается: молча подменять провайдера нельзя.
  assert.equal(pickVoiceProvider({ requested: 'gemini', openaiKey: 'sk' }), null);
  // Без явного выбора берётся тот, чей ключ есть.
  assert.equal(pickVoiceProvider({ openaiKey: 'sk' }), 'openai');
  assert.equal(pickVoiceProvider({ geminiKey: 'g' }), 'gemini');
  assert.equal(pickVoiceProvider({}), null);
});

test('gemini tools carry the same contract in google shape', () => {
  const [group] = geminiTools();
  assert.deepEqual(group.functionDeclarations.map((tool) => tool.name), VOICE_TOOLS.map((tool) => tool.name));
  for (const tool of group.functionDeclarations) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    // У Google в объявлении функции нет поля type — иначе setup отвергается.
    assert.equal(tool.type, undefined);
  }
});

test('with a gemini key the service mints an ephemeral token and never leaks the key', async () => {
  const requests = [];
  const service = createVoiceService({
    apiKey: '',
    geminiApiKey: 'gemini-secret-key',
    geminiModel: 'models/gemini-3.1-flash-live-preview',
    geminiVoice: 'Puck',
    now: () => new Date('2026-08-25T10:00:00Z'),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ name: 'auth_tokens/short-lived' }) };
    },
  });
  const status = service.status();
  assert.equal(status.configured, true);
  assert.equal(status.provider, 'gemini');
  assert.equal(status.mode, 'live');
  assert.equal(status.model, 'models/gemini-3.1-flash-live-preview');
  assert.equal(status.voice, 'Puck');
  // Выбор провайдера показывается только там, где он есть: ключ один — выбора нет.
  assert.equal(status.providers.gemini.configured, true);
  assert.equal(status.providers.openai.configured, false);

  const session = await service.createSession();
  assert.equal(session.provider, 'gemini');
  assert.equal(session.clientSecret, 'auth_tokens/short-lived');
  assert.equal(session.url, GEMINI_LIVE_URL);
  assert.match(GEMINI_LIVE_URL, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\//);

  const [call] = requests;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/auth_tokens');
  assert.equal(call.options.headers['x-goog-api-key'], 'gemini-secret-key');
  const body = JSON.parse(call.options.body);
  // Токен одноразовый и короткий: утёкший ничего не откроет.
  assert.equal(body.uses, 1);
  assert.equal(body.expireTime, '2026-08-25T10:30:00.000Z');
  assert.equal(body.newSessionExpireTime, '2026-08-25T10:02:00.000Z');
  // Токен привязан к модели и набору инструментов, а не выдан «на всё».
  // Поле именно bidiGenerateContentSetup: имя из документации API не знает.
  assert.equal(body.liveConnectConstraints, undefined);
  const setup = body.bidiGenerateContentSetup;
  assert.equal(setup.model, 'models/gemini-3.1-flash-live-preview');
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.deepEqual(
    setup.tools[0].functionDeclarations.map((tool) => tool.name),
    VOICE_TOOLS.map((tool) => tool.name),
  );
  assert.match(setup.systemInstruction.parts[0].text, /Кизуна/);
});

test('a failing gemini token request degrades with a safe reason', async () => {
  const failing = createVoiceService({ apiKey: '', geminiApiKey: 'g', fetch: async () => ({ ok: false, status: 403 }) });
  assert.deepEqual(await failing.createSession(), { mode: 'live', provider: 'gemini', error: 'unavailable', status: 403 });

  const malformed = createVoiceService({ apiKey: '', geminiApiKey: 'g', fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal((await malformed.createSession()).error, 'malformed_output');
});

test('the session endpoint hands the browser a gemini token and the socket url only', async () => {
  const api = authed(app(createVoiceService({
    apiKey: '',
    geminiApiKey: 'gemini-secret-key',
    fetch: async () => ({ ok: true, json: async () => ({ name: 'auth_tokens/browser' }) }),
  })));
  const status = (await api.get('/api/voice/status').expect(200)).body;
  assert.equal(status.provider, 'gemini');
  const session = (await api.post('/api/voice/session').expect(200)).body;
  assert.equal(session.provider, 'gemini');
  assert.equal(session.clientSecret, 'auth_tokens/browser');
  assert.equal(session.url, GEMINI_LIVE_URL);
  assert.equal(JSON.stringify(session).includes('gemini-secret-key'), false, 'ключ не должен уходить в браузер');
});

// Разговор идёт обо всех записях, а не только о новых: прочитать, удалить и
// вернуть — такие же инструменты, как «записать».
test('read_capture tells what the parse knows and what it is missing', () => {
  const db = database();
  const clear = parsedCapture(db, 'позвонить Даниилу по релизу');
  const readable = runVoiceTool(db, 'read_capture', { captureId: clear });
  assert.equal(readable.parsed, true);
  assert.equal(readable.deleted, false);
  assert.equal(readable.type, 'задача');
  assert.match(readable.raw, /Даниилу/);
  assert.equal(readable.clarity.clear, true);
  assert.equal(readable.clarity.question, null);

  // Спорный разбор несёт готовый вопрос: его и задаёт голос.
  const unclear = parsedCapture(db, 'созвон то ли завтра, то ли в пятницу', {
    ambiguity: { field: 'schedule', question: 'Какой день верный?' },
  });
  const asked = runVoiceTool(db, 'read_capture', { captureId: unclear });
  assert.equal(asked.clarity.clear, false);
  assert.equal(asked.clarity.field, 'schedule');
  assert.equal(asked.clarity.question, 'Какой день верный?');

  assert.equal(runVoiceTool(db, 'read_capture', { captureId: 'нет такой' }).error, 'Запись не найдена.');
});

test('delete_capture is soft and restore_capture brings the entry back', () => {
  const db = database();
  const captureId = parsedCapture(db, 'зайти к стоматологу');
  assert.equal(runVoiceTool(db, 'list_today', {}).total, 1);

  const deleted = runVoiceTool(db, 'delete_capture', { captureId });
  assert.deepEqual(deleted, { captureId, deleted: true, restorable: true });
  assert.equal(runVoiceTool(db, 'list_today', {}).total, 0);
  assert.equal(runVoiceTool(db, 'read_capture', { captureId }).deleted, true, 'удалённая запись всё ещё читается');
  assert.equal(runVoiceTool(db, 'delete_capture', { captureId }).error, 'Запись не найдена или уже удалена.');

  const restored = runVoiceTool(db, 'restore_capture', { captureId });
  assert.equal(restored.restored, true);
  assert.equal(runVoiceTool(db, 'list_today', {}).total, 1);
  assert.equal(runVoiceTool(db, 'restore_capture', { captureId }).restored, false, 'вернуть уже вернувшееся нечего');
  assert.equal(runVoiceTool(db, 'restore_capture', { captureId: 'нет такой' }).error, 'Запись не найдена.');
});

test('a mock turn removes the last entry and puts it back on request', () => {
  const db = database();
  parsedCapture(db, 'зайти к стоматологу');
  const removed = mockVoiceTurn(db, 'удали последнюю запись');
  assert.equal(removed.calls[0].name, 'delete_capture');
  assert.match(removed.reply, /верни/i, 'в ответе есть выход из ошибки');
  assert.equal(runVoiceTool(db, 'list_today', {}).total, 0);

  const back = mockVoiceTurn(db, 'верни');
  assert.equal(back.calls[0].name, 'restore_capture');
  assert.equal(runVoiceTool(db, 'list_today', {}).total, 1);

  assert.deepEqual(mockVoiceTurn(database(), 'верни').calls, [], 'возвращать нечего — молчим об инструментах');
});

// «Если классификация не ясна — спроси»: тип, которого не было в реплике, не
// выдумывается, а уточняется, и ответ одним словом ложится на ту же запись.
test('an unclear type is asked about, and a one-word answer settles it', () => {
  const db = database();
  const saved = mockVoiceTurn(db, 'пересмотреть план недели');
  assert.equal(saved.calls[0].name, 'create_capture');
  assert.equal(saved.calls[0].arguments.type, undefined, 'тип не выдуман');
  assert.match(saved.reply, /дело, заметка или результат\?/i);

  // Ответ приходит к разобранной записи, поэтому разбор готовим отдельно.
  const captureId = parsedCapture(db, 'пересмотреть план недели');
  const answered = mockVoiceTurn(db, 'заметка');
  assert.equal(answered.calls[0].name, 'update_capture');
  assert.equal(answered.calls[0].arguments.captureId, captureId);
  assert.equal(runVoiceTool(db, 'read_capture', { captureId }).type, 'заметка');

  // А явный тип в реплике вопросом не переспрашивается.
  const explicit = mockVoiceTurn(db, 'запиши задачу починить ретрай');
  assert.equal(explicit.calls[0].arguments.type, 'todo');
  assert.doesNotMatch(explicit.reply, /\?/);
});

test('voice instructions carry the rules of a real conversation', () => {
  assert.match(VOICE_INSTRUCTIONS, /молчи/i, 'чужая речь остаётся без ответа');
  assert.match(VOICE_INSTRUCTIONS, /read_capture/, 'после записи разбор проверяется');
  assert.match(VOICE_INSTRUCTIONS, /удал/i, 'удаление подтверждается вслух');
});

// Сказанное вслух разбирает та же модель, что и напечатанное. С жёстким
// 'fallback' отчёт о сделанном («поговорил с парнями») уходил в заметки: правила
// без модели не понимают, что это отчёт, а не наблюдение.
test('a spoken capture is parsed by the chosen provider, not always by the rules', () => {
  const db = database();
  const queued = runVoiceTool(db, 'create_capture', { text: 'поговорил с парнями про релиз' }, { provider: 'openrouter' });
  const job = db.prepare('SELECT selected_provider FROM capture_jobs WHERE id=?').get(queued.jobId);
  assert.equal(job.selected_provider, 'openrouter');

  // Без указания провайдера поведение прежнее — правила.
  const plain = runVoiceTool(db, 'create_capture', { text: 'ещё одна мысль' });
  assert.equal(db.prepare('SELECT selected_provider FROM capture_jobs WHERE id=?').get(plain.jobId).selected_provider, 'fallback');
});

test('the api hands the voice tools the provider it was asked for', async () => {
  const api = authed(app());
  const spoken = await api
    .post('/api/voice/tool')
    .send({ name: 'create_capture', arguments: { text: 'созвонились по Hub' }, provider: 'openrouter' })
    .expect(200);
  assert.equal(spoken.body.result.saved, true);
  await api
    .post('/api/voice/tool')
    .send({ name: 'create_capture', arguments: { text: 'x' }, provider: 'выдуманный' })
    .expect(400);
});

// Без ключа правила тоже должны узнавать отчёт: «поговорил», «созвонились»,
// «доделал» — это сделанное, а не заметка.
test('the keyless rules read a report about finished work as an outcome', () => {
  for (const said of ['поговорил с парнями про релиз', 'созвонились с Даниилом', 'доделал ретрай в Hub']) {
    const db = database();
    const turn = mockVoiceTurn(db, said);
    assert.equal(turn.calls[0].name, 'create_capture', said);
    assert.equal(turn.calls[0].arguments.type, 'outcome', said);
    assert.match(turn.reply, /как результат/i, said);
  }
});
