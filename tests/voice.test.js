import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { createVoiceService, runVoiceTool, mockVoiceTurn, VOICE_TOOLS } from '../server/voice.js';
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
  assert.deepEqual(names, ['create_capture', 'search_memory', 'list_today', 'append_note', 'update_capture']);
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

test('without a key the service reports the mock mode and asks for no session', async () => {
  const service = createVoiceService({ apiKey: '' });
  assert.deepEqual(service.status(), { configured: false, mode: 'mock', model: null, voice: null });
  assert.deepEqual(await service.createSession(), { mode: 'mock' });
});

test('with a key the service asks OpenAI for an ephemeral secret and never leaks the key', async () => {
  const requests = [];
  const service = createVoiceService({
    apiKey: 'sk-test-key',
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
  const failing = createVoiceService({ apiKey: 'sk-test', fetch: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(await failing.createSession(), { mode: 'live', error: 'unavailable', status: 500 });

  const malformed = createVoiceService({ apiKey: 'sk-test', fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal((await malformed.createSession()).error, 'malformed_output');

  const aborted = createVoiceService({
    apiKey: 'sk-test',
    fetch: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  assert.equal((await aborted.createSession()).error, 'timeout');
});

test('the api exposes status, session, tools and turns', async () => {
  const api = request(app(createVoiceService({ apiKey: '' })));

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
  const api = request(app(createVoiceService({
    apiKey: 'sk-secret-key',
    fetch: async () => ({ ok: true, json: async () => ({ value: 'ek_browser', expires_at: 42 }) }),
  })));
  const status = (await api.get('/api/voice/status').expect(200)).body;
  assert.equal(status.mode, 'live');
  const session = (await api.post('/api/voice/session').expect(200)).body;
  assert.equal(session.clientSecret, 'ek_browser');
  assert.equal(JSON.stringify(session).includes('sk-secret-key'), false, 'ключ не должен уходить в браузер');
});

test('an unavailable realtime API answers 503 instead of pretending', async () => {
  const api = request(app(createVoiceService({ apiKey: 'sk-test', fetch: async () => ({ ok: false, status: 429 }) })));
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
