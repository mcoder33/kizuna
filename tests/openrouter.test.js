import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliConfig, validateRemoteModel } from '../server/cli-config.js';
import { createOpenRouterProvider } from '../server/openrouter.js';
import { createAiService } from '../server/ai.js';

const catalogue = {
  data: [
    { id: 'cheap/model', name: 'Cheap', supported_parameters: ['structured_outputs'], pricing: { prompt: '0.0000002', completion: '0.0000008' } },
    { id: 'pricey/model', name: 'Pricey', supported_parameters: ['structured_outputs'], pricing: { prompt: '0.00001', completion: '0.00004' } },
    { id: 'no-schema/model', name: 'No schema', supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000001' } },
    { id: 'no-price/model', name: 'No price', supported_parameters: ['structured_outputs'], pricing: {} },
  ],
};

const classification = {
  primaryType: 'task', entities: { projects: [], people: [], when: { date: '2026-08-22', time: '11:00' }, followUp: null },
  additionalTypes: [], summary: 'Созвон по Hub', proposedActions: [], completed: false, ambiguity: null,
};

function stubFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      for (const [suffix, respond] of Object.entries(handlers)) {
        if (String(url).endsWith(suffix)) return respond(options);
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

const ok = payload => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
const chatOk = content => ok({ model: 'cheap/model', choices: [{ message: { content: JSON.stringify(content) } }] });

test('remote model ids allow the slash used by OpenRouter but reject shell characters', () => {
  assert.equal(validateRemoteModel('anthropic/claude-haiku-4.5'), 'anthropic/claude-haiku-4.5');
  assert.throws(() => validateRemoteModel('a model'));
  assert.throws(() => validateRemoteModel('model;rm -rf /'));
  assert.throws(() => validateRemoteModel('/leading-slash'));
  assert.equal(validateRemoteModel(''), null);
});

test('the catalogue keeps only schema-capable priced models, cheapest first', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  const models = await provider.models();
  assert.deepEqual(models.map(entry => entry.id), ['cheap/model', 'pricey/model']);
  assert.equal(await provider.defaultModel(), 'cheap/model');
});

test('the model list request carries no credentials while chat completions do', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => chatOk(classification) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'secret-key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  await provider.models();
  await provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'cheap/model' });
  const catalogueCall = stub.calls.find(call => String(call.url).endsWith('/models'));
  const chatCall = stub.calls.find(call => String(call.url).endsWith('/chat/completions'));
  assert.equal(catalogueCall.options.headers.Authorization, undefined);
  assert.equal(chatCall.options.headers.Authorization, 'Bearer secret-key');
});

test('a requested model outside the catalogue is refused instead of silently substituted', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => chatOk(classification) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  await assert.rejects(() => provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'ghost/model' }), /invalid_provider/);
  assert.equal(stub.calls.some(call => String(call.url).endsWith('/chat/completions')), false);
});

test('a default model does not collapse the choice list', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => chatOk(classification) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key', PAGENT_OPENROUTER_MODEL: 'pricey/model' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  assert.deepEqual((await provider.models()).map(entry => entry.id), ['cheap/model', 'pricey/model'], 'каталог остаётся полным');
  assert.equal(await provider.defaultModel(), 'pricey/model');
  const result = await provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'cheap/model' });
  assert.ok(result.candidate, 'другая модель из каталога остаётся доступной');
});

test('an unreachable catalogue does not block requests', async () => {
  const stub = stubFetch({ '/models': () => ({ ok: false, status: 500 }), '/chat/completions': () => chatOk(classification) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key', PAGENT_OPENROUTER_MODEL: 'google/gemini-3.7-flash' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  assert.deepEqual(await provider.models(), []);
  const result = await provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'google/gemini-3.7-flash' });
  assert.ok(result.candidate, 'слаг проверяет сам OpenRouter, а не пустой кэш');
});

test('an explicit allowlist replaces the catalogue and pins the default', async () => {
  const stub = stubFetch({ '/chat/completions': () => chatOk(classification) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key', PAGENT_OPENROUTER_MODELS: 'a/one, b/two', PAGENT_OPENROUTER_MODEL: 'b/two' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  assert.deepEqual((await provider.models()).map(entry => entry.id), ['a/one', 'b/two'], 'порядок списка задаёт конфиг');
  assert.equal(await provider.defaultModel(), 'b/two');
  await assert.rejects(() => provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'cheap/model' }), /invalid_provider/);
});

test('keep-alive padding before the body is tolerated', async () => {
  const padded = { ok:true, status:200, text: async () => `: OPENROUTER PROCESSING\n: OPENROUTER PROCESSING\n${JSON.stringify({ model:'cheap/model', choices:[{ message:{ content: JSON.stringify(classification) } }] })}` };
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => padded });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  const result = await provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'cheap/model' });
  assert.equal(result.candidate.primaryType, 'task');
});

test('a reasoning model that spends the budget on thinking degrades with a clear reason', async () => {
  const empty = { ok:true, status:200, text: async () => JSON.stringify({ model:'cheap/model', choices:[{ finish_reason:'length', message:{ content:null } }] }) };
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => empty });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  await assert.rejects(() => provider.invoke({ schema: '{"type":"object"}', schemaName: 'n', system: 's', user: 'u', model: 'cheap/model' }), /absent_output/);
});

test('the request pins the schema, zero temperature and the selected model', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => chatOk(classification) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  await provider.invoke({ schema: '{"type":"object"}', schemaName: 'pagent_capture', system: 'sys', user: 'usr', model: 'pricey/model' });
  const body = stub.calls.find(call => String(call.url).endsWith('/chat/completions')).body;
  assert.equal(body.model, 'pricey/model');
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'usr');
});

test('classification through OpenRouter reaches the ledger shape with provenance', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue), '/chat/completions': () => chatOk(classification) });
  const service = createAiService({ env: { OPENROUTER_API_KEY: 'key' }, fetch: stub.fetch, now: () => new Date('2026-08-21T10:00:00Z') });
  const result = await service.classify('Завтра в 11 созвон по Hub', 'openrouter');
  assert.equal(result.usedProvider, 'openrouter');
  assert.equal(result.fallbackReason, null);
  assert.equal(result.classification.entities.schedule.date, '2026-08-22');
  assert.equal(result.classification.unclassified, undefined);
});

test('transport and schema failures degrade to an unclassified capture with a safe reason', async () => {
  const cases = [
    [{ '/models': () => ok(catalogue), '/chat/completions': () => ({ ok: false, status: 429 }) }, 'rate_limited'],
    [{ '/models': () => ok(catalogue), '/chat/completions': () => ({ ok: false, status: 401 }) }, 'unavailable'],
    [{ '/models': () => ok(catalogue), '/chat/completions': () => ok({ choices: [{ message: { content: 'not json' } }] }) }, 'malformed_output'],
    [{ '/models': () => ok(catalogue), '/chat/completions': () => chatOk({ primaryType: 'nope' }) }, 'schema_invalid'],
  ];
  for (const [handlers, reason] of cases) {
    const service = createAiService({ env: { OPENROUTER_API_KEY: 'key' }, fetch: stubFetch(handlers).fetch, retryDelayMs: 0, log: () => {} });
    const result = await service.classify('Завтра в 11 созвон', 'openrouter');
    assert.equal(result.usedProvider, 'fallback', reason);
    assert.equal(result.fallbackReason, reason);
    assert.equal(result.classification.unclassified, true);
  }
});

test('a transient model failure is retried once before the capture degrades', async () => {
  // Первый ответ — пустой content (модель истратила бюджет на рассуждение),
  // второй — нормальный: запись разобрана, а не сохранена «без разбора».
  let calls = 0;
  const flaky = { '/models': () => ok(catalogue), '/chat/completions': () => (++calls === 1 ? ok({ choices: [{ message: { content: null } }] }) : chatOk(classification)) };
  const events = [];
  const service = createAiService({ env: { OPENROUTER_API_KEY: 'key' }, fetch: stubFetch(flaky).fetch, retryDelayMs: 0, log: (event) => events.push(event), now: () => new Date('2026-08-21T10:00:00Z') });
  const result = await service.classify('Завтра в 11 созвон по Hub', 'openrouter');
  assert.equal(calls, 2);
  assert.equal(result.usedProvider, 'openrouter');
  assert.equal(result.fallbackReason, null);
  assert.deepEqual(events.map(event => [event.event, event.reason, event.attempt]), [['classify_attempt_failed', 'absent_output', 1]]);

  // Отказ по ключу постоянен: второго запроса нет, причина — в журнале.
  let authCalls = 0;
  const denied = { '/models': () => ok(catalogue), '/chat/completions': () => { authCalls += 1; return { ok: false, status: 401 }; } };
  const deniedEvents = [];
  const deniedService = createAiService({ env: { OPENROUTER_API_KEY: 'key' }, fetch: stubFetch(denied).fetch, retryDelayMs: 0, log: (event) => deniedEvents.push(event) });
  const deniedResult = await deniedService.classify('Завтра в 11 созвон', 'openrouter');
  assert.equal(authCalls, 1);
  assert.equal(deniedResult.fallbackReason, 'unavailable');
  assert.equal(deniedEvents.at(-1).event, 'classify_fallback');
});

test('without a key OpenRouter is unavailable and reports not_configured', async () => {
  const service = createAiService({ env: {}, fetch: async () => { throw new Error('must not be called'); } });
  const status = await service.status('openrouter');
  assert.equal(status.providers.openrouter.available, false);
  assert.equal(status.mode, 'fallback');
  const result = await service.classify('Завтра в 11 созвон', 'openrouter');
  assert.equal(result.fallbackReason, 'not_configured');
});

test('status exposes the catalogue so the interface can offer a choice', async () => {
  const stub = stubFetch({ '/models': () => ok(catalogue) });
  const service = createAiService({ env: { OPENROUTER_API_KEY: 'key' }, fetch: stub.fetch });
  const status = await service.status('openrouter');
  assert.equal(status.mode, 'openrouter');
  assert.deepEqual(status.providers.openrouter.models.map(entry => entry.id), ['cheap/model', 'pricey/model']);
  assert.equal(status.model, 'cheap/model');
});

// Пустой каталог после сетевой осечки не должен становиться приговором: он жил
// до перезапуска сервера, из-за чего один неудачный запрос гасил выбор моделей
// и помечал провайдера недоступным даже после того, как сеть возвращалась.
test('a failed catalogue request is not cached and recovers on the next call', async () => {
  let failing = true;
  const stub = stubFetch({ '/models': () => (failing ? { ok: false, status: 500 } : ok(catalogue)) });
  const config = createCliConfig({ OPENROUTER_API_KEY: 'key' });
  const provider = createOpenRouterProvider({ config, fetch: stub.fetch });
  assert.deepEqual(await provider.models(), [], 'осечка отдаёт пустой список');
  failing = false;
  assert.deepEqual((await provider.models()).map(entry => entry.id), ['cheap/model', 'pricey/model'], 'каталог возвращается сам');
  assert.equal(stub.calls.filter(call => String(call.url).endsWith('/models')).length, 2, 'второй запрос действительно уходит');
  assert.deepEqual((await provider.models()).map(entry => entry.id), ['cheap/model', 'pricey/model'], 'удачный каталог кэшируется');
  assert.equal(stub.calls.filter(call => String(call.url).endsWith('/models')).length, 2, 'третьего запроса уже нет');
});
