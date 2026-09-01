// Google как модель разбора, а не только голоса. Сеть не трогаем: важно, что
// уходит в запрос и что мы понимаем в ответе, а не то, что сегодня отвечает
// Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliConfig, CLI_PROVIDER_IDS, publicProviderAvailability } from '../server/cli-config.js';
import { createGeminiProvider, geminiSchema } from '../server/gemini.js';
import { createAiService, classificationSchemaJson } from '../server/ai.js';
import { openDatabase } from '../server/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const catalogue = {
  models: [
    { name: 'models/gemini-flash-latest', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.7-flash', displayName: '3.7 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', displayName: '3.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-pro-latest', displayName: 'Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', displayName: 'Embeddings', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/lyria-3-pro-preview', displayName: 'Музыка', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-transcribe', displayName: 'Расшифровка', supportedGenerationMethods: ['generateContent'] },
  ],
};
const classification = {
  primaryType: 'task', entities: { projects: ['Hub'], people: [], when: { date: '2026-08-22', time: '11:00' }, followUp: null },
  additionalTypes: [], summary: 'Созвон по Hub', proposedActions: [], completed: false, ambiguity: null,
};

function stubFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
      for (const [needle, respond] of Object.entries(handlers)) if (String(url).includes(needle)) return respond(options);
      throw new Error(`неожиданный адрес ${url}`);
    },
  };
}
const ok = (payload) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
const fail = (status) => async () => ({ ok: false, status, text: async () => '{}' });
const answered = (candidate, usage) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(candidate) }] } }],
  ...(usage ? { usageMetadata: usage } : {}),
});
const config = (env = {}) => createCliConfig({ GEMINI_API_KEY: 'ключ', ...env });

// ── схема ────────────────────────────────────────────────────────────────────
test('схема приводится к тому, что принимает Google', () => {
  const source = {
    type: 'object',
    additionalProperties: false,
    required: ['when'],
    properties: {
      when: { type: ['object', 'null'], additionalProperties: false, properties: { date: { type: ['string', 'null'] } } },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 6 },
      kind: { type: 'string', enum: ['a', 'b'] },
    },
  };
  const result = geminiSchema(source);
  assert.equal(JSON.stringify(result).includes('additionalProperties'), false, 'Google спотыкается об это поле');
  assert.deepEqual(result.properties.when, { type: 'object', nullable: true, properties: { date: { type: 'string', nullable: true } } });
  assert.deepEqual(result.properties.tags, { type: 'array', items: { type: 'string' }, maxItems: 6 }, 'остальное не трогаем');
  assert.deepEqual(result.properties.kind.enum, ['a', 'b']);
  assert.deepEqual(result.required, ['when']);
});

test('настоящая схема разбора переживает приведение', () => {
  const converted = geminiSchema(JSON.parse(classificationSchemaJson()));
  const text = JSON.stringify(converted);
  assert.equal(text.includes('additionalProperties'), false);
  assert.equal(/"type":\s*\[/.test(text), false, 'составных типов не остаётся');
  assert.equal(converted.properties.entities.properties.when.nullable, true);
});

// ── каталог моделей ──────────────────────────────────────────────────────────
test('из каталога остаются текстовые модели, быстрая — первой', async () => {
  const stub = stubFetch({ '/models?': ok(catalogue) });
  const models = await createGeminiProvider({ config: config(), fetch: stub.fetch }).models();
  const ids = models.map(model => model.id);
  assert.deepEqual(ids, ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-3.7-flash', 'gemini-3.5-flash']);
  assert.equal(ids.includes('text-embedding-004'), false, 'эмбеддинги не разбирают записи');
  assert.equal(ids.includes('lyria-3-pro-preview'), false, 'музыкальная модель тоже');
  assert.equal(ids.includes('gemini-3.5-transcribe'), false, 'расшифровка — это не разбор');
  // Ключ уходит заголовком, а не в адресе: в адресе он попал бы в журналы.
  assert.equal(stub.calls[0].url.includes('ключ'), false);
  assert.equal(stub.calls[0].options.headers['x-goog-api-key'], 'ключ');
});

test('без ключа каталог пуст, а осечка сети не запоминается', async () => {
  assert.deepEqual(await createGeminiProvider({ config: createCliConfig({}), fetch: async () => { throw new Error('не должно вызываться'); } }).models(), []);
  let attempt = 0;
  const provider = createGeminiProvider({
    config: config(),
    fetch: async () => { attempt += 1; return attempt === 1 ? { ok: false, status: 500, text: async () => '{}' } : { ok: true, status: 200, text: async () => JSON.stringify(catalogue) }; },
  });
  assert.deepEqual(await provider.models(), [], 'первый запрос не удался');
  assert.equal((await provider.models()).length, 4, 'второй прошёл — выбор моделей вернулся');
});

test('свой список моделей из настроек отменяет каталог', async () => {
  const provider = createGeminiProvider({
    config: config({ PAGENT_GEMINI_MODELS: 'gemini-3.7-flash,gemini-pro-latest' }),
    fetch: async () => { throw new Error('каталог спрашивать незачем'); },
  });
  assert.deepEqual((await provider.models()).map(model => model.id), ['gemini-3.7-flash', 'gemini-pro-latest']);
  assert.equal(await provider.defaultModel(), 'gemini-3.7-flash');
});

// ── вызов ────────────────────────────────────────────────────────────────────
test('запрос собран по правилам Google, ответ и токены разобраны', async () => {
  const stub = stubFetch({
    '/models?': ok(catalogue),
    ':generateContent': ok(answered(classification, { promptTokenCount: 120, candidatesTokenCount: 45 })),
  });
  const provider = createGeminiProvider({ config: config(), fetch: stub.fetch });
  const result = await provider.invoke({ schema: classificationSchemaJson(), schemaName: 'pagent_capture', system: 'система', user: 'запись' });

  assert.deepEqual(result.candidate, classification);
  assert.equal(result.model, 'gemini-flash-latest');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 45, costUsd: null }, 'цену Google не сообщает — выдумывать её нельзя');

  const call = stub.calls.at(-1);
  assert.match(call.url, /models\/gemini-flash-latest:generateContent$/);
  assert.equal(call.body.systemInstruction.parts[0].text, 'система');
  assert.equal(call.body.contents[0].parts[0].text, 'запись');
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(JSON.stringify(call.body.generationConfig.responseSchema).includes('additionalProperties'), false);
});

test('отказ провайдера доходит причиной, а не общей ошибкой', async () => {
  const cases = [[401, 'unavailable'], [429, 'rate_limited'], [500, 'nonzero']];
  for (const [status, code] of cases) {
    const provider = createGeminiProvider({ config: config({ PAGENT_GEMINI_MODELS: 'gemini-3.7-flash' }), fetch: stubFetch({ ':generateContent': fail(status) }).fetch });
    await assert.rejects(() => provider.invoke({ schema: classificationSchemaJson(), schemaName: 'x', system: 's', user: 'u' }), (error) => error.code === code, `${status} → ${code}`);
  }
});

test('пустой ответ и запрет по правилам безопасности различимы', async () => {
  const empty = createGeminiProvider({ config: config({ PAGENT_GEMINI_MODELS: 'gemini-3.7-flash' }), fetch: stubFetch({ ':generateContent': ok({ candidates: [{ content: { parts: [{ text: '  ' }] } }] }) }).fetch });
  await assert.rejects(() => empty.invoke({ schema: classificationSchemaJson(), schemaName: 'x', system: 's', user: 'u' }), (error) => error.code === 'absent_output');

  const blocked = createGeminiProvider({ config: config({ PAGENT_GEMINI_MODELS: 'gemini-3.7-flash' }), fetch: stubFetch({ ':generateContent': ok({ promptFeedback: { blockReason: 'SAFETY' } }) }).fetch });
  await assert.rejects(() => blocked.invoke({ schema: classificationSchemaJson(), schemaName: 'x', system: 's', user: 'u' }), (error) => error.code === 'schema_invalid');
});

// ── место в приложении ───────────────────────────────────────────────────────
test('ключ берётся и из GEMINI_API_KEY, и из GOOGLE_API_KEY', () => {
  assert.equal(createCliConfig({ GEMINI_API_KEY: 'первый' }).providers.gemini.apiKey, 'первый');
  assert.equal(createCliConfig({ GOOGLE_API_KEY: 'второй' }).providers.gemini.apiKey, 'второй');
  assert.equal(createCliConfig({}).providers.gemini.apiKey, null);
  assert.equal(CLI_PROVIDER_IDS.includes('gemini'), true);
  assert.equal(publicProviderAvailability(config(), false).gemini.configured, true);
  assert.equal(publicProviderAvailability(createCliConfig({}), false).gemini.configured, false);
});

test('служба разбора выбирает Google и отдаёт его провенанс', async () => {
  const stub = stubFetch({
    '/models?': ok(catalogue),
    ':generateContent': ok(answered(classification, { promptTokenCount: 10, candidatesTokenCount: 5 })),
  });
  const ai = createAiService({ env: { GEMINI_API_KEY: 'ключ' }, fetch: stub.fetch, apiKey: null, timeZone: 'Europe/Samara' });

  const status = await ai.status('gemini');
  assert.equal(status.mode, 'gemini');
  assert.equal(status.model, 'gemini-flash-latest');
  assert.equal(status.providers.gemini.available, true);

  const parsed = await ai.classify('Завтра в 11 созвон по Hub', 'gemini');
  assert.equal(parsed.usedProvider, 'gemini');
  assert.equal(parsed.fallbackReason, null);
  assert.equal(parsed.classification.primaryType, 'task');
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 5, costUsd: null });
});

test('без ключа Google разбор уходит в правила, а не падает', async () => {
  const ai = createAiService({ env: {}, apiKey: null, fetch: async () => { throw new Error('сети быть не должно'); } });
  const parsed = await ai.classify('Что-нибудь', 'gemini');
  assert.equal(parsed.usedProvider, 'fallback');
  assert.equal(parsed.fallbackReason, 'not_configured');
});

test('база принимает разбор от Google: ограничения таблиц обновлены', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-gemini-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const tableSql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql;
  assert.match(tableSql('interpretations'), /'gemini'/);
  assert.match(tableSql('capture_jobs'), /'gemini'/);
  // Ограничение не просто содержит слово — оно и правда пропускает запись.
  db.prepare("INSERT INTO captures(id,raw,modality,occurred_at,created_at,privacy_scope,deleted_at,user_id) VALUES('c','сырое','text','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z','private',NULL,NULL)").run();
  db.prepare("INSERT INTO interpretations VALUES('i','c',1,'active','gemini','gemini-flash-latest','{}','{}','2026-09-01T10:00:00Z',NULL)").run();
  assert.equal(db.prepare("SELECT provider FROM interpretations WHERE id='i'").get().provider, 'gemini');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});
