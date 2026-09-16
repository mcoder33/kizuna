import { CliRunnerError } from './cli-runner.js';
import { OPENROUTER_MODEL_LIMIT, validateRemoteModel } from './cli-config.js';

// Google как модель разбора, а не только голоса. Ключ тот же самый, что у
// живого разговора, — но у текста свой протокол, поэтому здесь отдельный
// модуль, а не ветка в голосовом.
const maximumResponseBytes = 200_000;
const maximumCatalogueBytes = 4_000_000;

function parseJson(value) {
  try { const parsed = JSON.parse(String(value).trim()); return typeof parsed === 'string' ? JSON.parse(parsed) : parsed; }
  catch { throw new CliRunnerError('malformed_output'); }
}
function configError(code) { return Object.assign(new Error(code), { code }); }
function statusError(status) {
  if (status === 401 || status === 403) return new CliRunnerError('unavailable');
  if (status === 429) return new CliRunnerError('rate_limited');
  return new CliRunnerError('nonzero');
}

// Схема у нас одна на всех провайдеров, а Google принимает не всякую: он ждёт
// подмножество OpenAPI и спотыкается о `additionalProperties`, а необязательное
// поле помечает не составным типом, а флагом `nullable`. Поэтому схема не
// переписывается вручную под каждого — она приводится к его правилам здесь, и
// расхождение живёт в одном месте, а не в двух копиях схемы.
export function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && Array.isArray(value)) {
      const real = value.filter(item => item !== 'null');
      out.type = real[0] || 'string';
      if (real.length !== value.length) out.nullable = true;
      continue;
    }
    out[key] = geminiSchema(value);
  }
  return out;
}

// Каталог берётся у Google, а не зашивается списком: имена моделей меняются, а
// выдуманное выглядело бы рабочим выбором и падало бы только при запросе. Но в
// каталоге лежит всё подряд — музыка, картинки, робототехника, исследовательские
// превью, — поэтому здесь же отбираются те, что умеют текстовый ответ по схеме.
// Первой в списке стоит быстрая: разбор — работа частая, и ставить по умолчанию
// тяжёлую модель значило бы тратить деньги на ровном месте.
const UNSUITABLE = /embedding|aqa|imagen|veo|image|tts|live|realtime|lyria|banana|robotics|computer-use|deep-research|antigravity|transcribe|omni|gemma/i;
function rank(id) {
  if (id === 'gemini-flash-latest') return 0;
  if (id.endsWith('-latest')) return 1;
  if (id.includes('flash')) return 2;
  if (id.includes('pro')) return 3;
  return 4;
}
function textModels(payload) {
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  const usable = [];
  for (const row of rows) {
    const raw = typeof row?.name === 'string' ? row.name.replace(/^models\//, '') : '';
    if (!raw) continue;
    let id = null;
    try { id = validateRemoteModel(raw); } catch { continue; }
    const methods = Array.isArray(row?.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
    if (!methods.includes('generateContent')) continue;
    if (UNSUITABLE.test(id)) continue;
    usable.push({ id, name: typeof row?.displayName === 'string' ? row.displayName.slice(0, 120) : id });
  }
  // Внутри группы — свежие вперёд: у Google версия растёт числом в имени, и
  // обратный порядок ставит 3.7 раньше 3.5.
  return usable.sort((left, right) => rank(left.id) - rank(right.id) || right.id.localeCompare(left.id, 'en', { numeric: true }));
}

export function createGeminiProvider({ config, fetch: fetchImplementation = globalThis.fetch, timeoutMs, now = () => new Date() } = {}) {
  const settings = config.providers.gemini || { apiKey: null, model: null, allowedModels: [], baseUrl: 'https://generativelanguage.googleapis.com/v1beta' };
  const requestTimeout = timeoutMs || config.remoteTimeoutMs || 30000;
  let catalogue = null;

  async function request(path, { method = 'GET', body = null, signal, maxBytes = maximumResponseBytes } = {}) {
    if (!settings.apiKey) throw configError('not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Ключ Google передаётся заголовком, а не в адресе: в адресе он попал бы
      // в журналы прокси и в историю запросов.
      const response = await fetchImplementation(`${settings.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
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
      const payload = await request('/models?pageSize=200', { maxBytes: maximumCatalogueBytes });
      catalogue = textModels(payload).slice(0, OPENROUTER_MODEL_LIMIT);
    } catch {
      // Осечку сети не запоминаем: один неудачный запрос не должен гасить
      // выбор моделей до перезапуска.
      return [];
    }
    return catalogue;
  }

  function allows(model) {
    if (settings.allowedModels.length) return settings.allowedModels.includes(model);
    // Каталог неизвестен — решать не нам: имя проверит сам Google. Иначе
    // сетевая осечка заблокировала бы все модели.
    if (!catalogue?.length) return true;
    return catalogue.some(entry => entry.id === model) || model === settings.model;
  }

  async function defaultModel() {
    if (settings.model) return settings.model;
    const available = await models();
    return available[0]?.id || null;
  }

  // Цену за токен Google в API не сообщает, поэтому расход остаётся в токенах:
  // выдумывать сумму нельзя, и вызов честно попадёт в «без цены».
  function usageOf(payload) {
    const usage = payload?.usageMetadata;
    if (!usage) return null;
    return {
      inputTokens: Number(usage.promptTokenCount) || 0,
      outputTokens: Number(usage.candidatesTokenCount) || 0,
      costUsd: null,
    };
  }

  async function invoke({ schema, schemaName, system, user, model, signal }) {
    let requested = null;
    try { requested = validateRemoteModel(model); } catch { throw configError('invalid_provider'); }
    const selected = requested || (await defaultModel());
    if (!selected) throw configError('not_configured');
    if (requested) { await models(); if (!allows(requested)) throw configError('invalid_provider'); }
    const payload = await request(`/models/${encodeURIComponent(selected)}:generateContent`, {
      method: 'POST',
      signal,
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: config.tuning?.temperature ?? 0,
          maxOutputTokens: 3000,
          responseMimeType: 'application/json',
          responseSchema: geminiSchema(JSON.parse(schema)),
        },
      },
    });
    // Отказ по правилам безопасности — это не «пустой ответ»: причина есть, и
    // она должна дойти до человека отдельной строкой, а не общей ошибкой.
    if (payload?.promptFeedback?.blockReason) throw new CliRunnerError('schema_invalid');
    const text = payload?.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join('') || '';
    if (!text.trim()) throw new CliRunnerError('absent_output');
    const candidate = parseJson(text);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new CliRunnerError('malformed_output');
    return { candidate, model: selected, usage: usageOf(payload) };
  }

  return { invoke, models, defaultModel, configured: () => Boolean(settings.apiKey) };
}
