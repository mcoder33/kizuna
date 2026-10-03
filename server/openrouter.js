import { CliRunnerError } from './cli-runner.js';
import { OPENROUTER_MODEL_LIMIT, validateRemoteModel } from './cli-config.js';

// Ответ модели должен быть коротким — там JSON по схеме. А вот каталог моделей
// у OpenRouter весит под мегабайт, и общий лимит его резал: без каталога не
// работали ни выбор модели, ни подсчёт денег.
const maximumResponseBytes = 200_000;
const maximumCatalogueBytes = 8_000_000;

// OpenRouter досылает keep-alive строки вида «: OPENROUTER PROCESSING» перед
// телом ответа — они не JSON, поэтому снимаются до разбора.
function parseJson(value) {
  const text = String(value).replace(/^(?:\s*:[^\n]*\n)+/, '').trim();
  try { const parsed = JSON.parse(text); return typeof parsed === 'string' ? JSON.parse(parsed) : parsed; }
  catch { throw new CliRunnerError('malformed_output'); }
}

// CliRunnerError знает только коды локальных CLI и схлопывает остальные в
// «nonzero», поэтому конфигурационные причины передаются обычной ошибкой:
// ai.js читает их из safeFallbackReasons и показывает человеку точную причину.
function configError(code) { return Object.assign(new Error(code), { code }); }

function statusError(status) {
  // Отказ по ключу — не случайность: повторять такой запрос незачем.
  if (status === 401 || status === 403) return Object.assign(new CliRunnerError('unavailable'), { permanent: true });
  if (status === 429) return new CliRunnerError('rate_limited');
  return new CliRunnerError('nonzero');
}

// Каталог берётся из OpenRouter, а не из зашитого списка: слаги и цены меняются,
// а выдуманный слаг выглядел бы как рабочий выбор и падал бы только при запросе.
function rankedCatalogue(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const usable = [];
  for (const row of rows) {
    let id = null;
    try { id = validateRemoteModel(row?.id); } catch { continue; }
    if (!id) continue;
    const parameters = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];
    if (!parameters.includes('structured_outputs') && !parameters.includes('response_format')) continue;
    const prompt = Number(row?.pricing?.prompt);
    const completion = Number(row?.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    usable.push({ id, name: typeof row?.name === 'string' ? row.name.slice(0, 120) : id, cost: prompt + completion, promptPrice: prompt, completionPrice: completion });
  }
  return usable.sort((left, right) => left.cost - right.cost || left.id.localeCompare(right.id));
}

export function createOpenRouterProvider({ config, fetch: fetchImplementation = globalThis.fetch, timeoutMs, now = () => new Date() } = {}) {
  const settings = config.providers.openrouter;
  const tuning = () => config.tuning || { temperature: 0, maxTokens: 6000, reasoning: 'low' };
  const requestTimeout = timeoutMs || config.remoteTimeoutMs || 30000;
  let catalogue = null;

  async function request(path, { method = 'GET', body = null, signal, authenticated = true, maxBytes = maximumResponseBytes } = {}) {
    if (signal?.aborted) throw new CliRunnerError('aborted');
    if (authenticated && !settings.apiKey) throw configError('not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImplementation(`${settings.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
          'HTTP-Referer': 'http://127.0.0.1',
          'X-Title': 'Pagent',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw statusError(response.status);
      const text = await response.text();
      if (text.length > maxBytes) throw new CliRunnerError('oversize_output');
      return parseJson(text);
    } catch (error) {
      if (error instanceof CliRunnerError) throw error;
      if (signal?.aborted) throw new CliRunnerError('aborted');
      throw new CliRunnerError(controller.signal.aborted ? 'timeout' : 'unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function models() {
    if (!settings.apiKey) return [];
    if (catalogue) return catalogue;
    if (settings.allowedModels.length) {
      catalogue = settings.allowedModels.map(id => ({ id, name: id }));
      return catalogue;
    }
    try {
      const payload = await request('/models', { authenticated: false, maxBytes: maximumCatalogueBytes });
      catalogue = rankedCatalogue(payload).slice(0, OPENROUTER_MODEL_LIMIT);
    } catch {
      // Осечку сети не запоминаем: пустой кэш живёт до перезапуска, и один
      // неудачный запрос погасил бы выбор моделей, а провайдер остался бы
      // помеченным недоступным даже после того, как сеть вернулась.
      return [];
    }
    return catalogue;
  }

  // Цены нужны и тогда, когда список моделей задан руками: иначе расход был бы
  // виден в токенах, но не в деньгах. Поэтому прайс живёт отдельно от каталога
  // выбора и берётся у OpenRouter один раз.
  let priceList = null;
  async function prices() {
    if (priceList) return priceList;
    try {
      const payload = await request('/models', { authenticated: false, maxBytes: maximumCatalogueBytes });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const map = new Map();
      for (const row of rows) {
        const prompt = Number(row?.pricing?.prompt);
        const completion = Number(row?.pricing?.completion);
        if (typeof row?.id === 'string' && Number.isFinite(prompt) && Number.isFinite(completion))
          map.set(row.id, { prompt, completion });
      }
      // Осечку не запоминаем: без цены расход просто останется в токенах.
      if (!map.size) return null;
      priceList = map;
    } catch {
      return null;
    }
    return priceList;
  }
  // Расход считаем по цене за токен от самого провайдера. Нет цены — нет и
  // суммы: выдумывать её нельзя.
  function usageOf(payload, usedModel, price) {
    const usage = payload?.usage;
    if (!usage) return null;
    const inputTokens = Number(usage.prompt_tokens) || 0;
    const outputTokens = Number(usage.completion_tokens) || 0;
    const costUsd = price ? inputTokens * price.prompt + outputTokens * price.completion : null;
    return { inputTokens, outputTokens, costUsd };
  }
  function allows(model) {
    if (settings.allowedModels.length) return settings.allowedModels.includes(model);
    // Каталог неизвестен (запрос не удался) — решать не нам: слаг проверит сам
    // OpenRouter. Иначе сетевая осечка заблокировала бы все модели.
    if (!catalogue?.length) return true;
    return catalogue.some(entry => entry.id === model) || model === settings.model;
  }

  async function defaultModel() {
    if (settings.model) return settings.model;
    const available = await models();
    return available[0]?.id || null;
  }

  async function invoke({ schema, schemaName, system, user, model, signal, maximumContentBytes = Infinity, cachedPricesOnly = false }) {
    let requested = null;
    try { requested = validateRemoteModel(model); } catch { throw configError('invalid_provider'); }
    const selected = requested || (await defaultModel());
    if (!selected) throw configError('not_configured');
    if (requested) { await models(); if (!allows(requested)) throw configError('invalid_provider'); }
    const payload = await request('/chat/completions', {
      method: 'POST',
      signal,
      body: {
        model: selected,
        temperature: tuning().temperature,
        // «Думающие» модели (например Gemini Flash) тратят часть бюджета на
        // reasoning; при тесном лимите ответ приходит с content: null. Поэтому
        // бюджет шире, а рассуждение по умолчанию короткое: извлечение полей по
        // схеме — не та задача, где долгие раздумья что-то добавляют. Значения
        // правятся в настройках, если модель просит другого.
        max_tokens: tuning().maxTokens,
        ...(tuning().reasoning === 'off' ? {} : { reasoning: { effort: tuning().reasoning, exclude: true } }),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: JSON.parse(schema) } },
      },
    });
    const usedModel = typeof payload?.model === 'string' ? payload.model.slice(0, 120) : selected;
    const knownUsage = usageOf(payload, usedModel, priceList?.get(usedModel) || priceList?.get(selected) || null);
    try {
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && Buffer.byteLength(content) > maximumContentBytes) throw new CliRunnerError('oversize_output');
      if (typeof content !== 'string' || !content.trim()) throw new CliRunnerError('absent_output');
      const candidate = parseJson(content);
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new CliRunnerError('malformed_output');
      const availablePrices = cachedPricesOnly ? priceList : await prices();
      const price = availablePrices?.get(usedModel) || availablePrices?.get(selected) || null;
      return { candidate, model: usedModel, usage: usageOf(payload, usedModel, price) };
    } catch (error) { if (knownUsage) error.usage = knownUsage; throw error; }
  }

  return { invoke, models, defaultModel, configured: () => Boolean(settings.apiKey) };
}
