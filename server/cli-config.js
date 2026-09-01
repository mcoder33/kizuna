import fs from 'node:fs';
import path from 'node:path';

export const CLI_PROVIDER_IDS = ['fallback', 'openai', 'openrouter', 'gemini', 'codex-cli', 'claude-cli'];
const executableNames = { 'codex-cli':'codex', 'claude-cli':'claude' };
const executableSettings = { 'codex-cli':'PAGENT_CODEX_PATH', 'claude-cli':'PAGENT_CLAUDE_PATH' };
const modelSettings = { 'codex-cli':'PAGENT_CODEX_MODEL', 'claude-cli':'PAGENT_CLAUDE_MODEL' };
const safeModel = /^[A-Za-z0-9._:-]{1,120}$/;
// Слаги OpenRouter содержат «/» («anthropic/claude-haiku-4.5»), поэтому у них
// отдельный валидатор — расширять safeModel нельзя, он защищает argv локальных CLI.
const safeRemoteModel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
export const OPENROUTER_MODEL_LIMIT = 40;

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid CLI configuration');
  const number = Number(value);
  if (number < min || number > max) throw new Error('Invalid CLI configuration');
  return number;
}

function safelyBoundedInteger(value, fallback, min, max) {
  try { return boundedInteger(value, fallback, min, max); } catch { return fallback; }
}

export function validateProviderId(value, fallback = 'fallback') {
  const provider = value || fallback;
  if (!CLI_PROVIDER_IDS.includes(provider)) throw new Error('Invalid AI provider');
  return provider;
}

export function validateExecutablePath(value, expectedBasename) {
  const candidate = value || expectedBasename;
  if (candidate === expectedBasename) return candidate;
  if (!path.isAbsolute(candidate) || /\s|[;&|`$<>]/.test(candidate) || path.basename(candidate) !== expectedBasename) throw new Error('Invalid CLI executable path');
  return candidate;
}

export function validateModel(value) {
  if (!value) return null;
  if (!safeModel.test(value)) throw new Error('Invalid CLI model');
  return value;
}

export function validateRemoteModel(value) {
  if (!value) return null;
  if (typeof value !== 'string' || !safeRemoteModel.test(value)) throw new Error('Invalid remote model');
  return value;
}

// Базовый адрес переопределяется только явно и только на http(s) — это нужно,
// чтобы тесты подставляли локальную заглушку вместо сети.
function geminiBaseUrl(value) {
  const fallback = 'https://generativelanguage.googleapis.com/v1beta';
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { const url = new URL(value.trim()); return url.protocol === 'https:' || url.hostname === '127.0.0.1' ? url.toString().replace(/\/$/, '') : fallback; }
  catch { return fallback; }
}
function openrouterBaseUrl(value) {
  const fallback = 'https://openrouter.ai/api/v1';
  if (!value) return fallback;
  try { const parsed = new URL(String(value)); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback; return parsed.href.replace(/\/$/, ''); }
  catch { return fallback; }
}

function remoteModelList(value) {
  if (!value) return [];
  const models = [];
  for (const part of String(value).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try { const model = validateRemoteModel(trimmed); if (model && !models.includes(model)) models.push(model); } catch {}
  }
  return models.slice(0, OPENROUTER_MODEL_LIMIT);
}

export function resolveExecutable(value, expectedBasename, env = process.env, exists = fs.existsSync) {
  const candidate = validateExecutablePath(value, expectedBasename);
  if (path.isAbsolute(candidate)) return exists(candidate) ? candidate : null;
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const resolved = path.join(directory, candidate);
    if (exists(resolved)) return resolved;
  }
  return null;
}

export function createCliConfig(env = process.env, { exists = fs.existsSync } = {}) {
  let provider = 'fallback';
  try { provider = validateProviderId(env.PAGENT_AI_PROVIDER, 'fallback'); } catch {}
  const providers = {};
  for (const id of ['codex-cli', 'claude-cli']) {
    const basename = executableNames[id];
    let configuredPath = null; let model = null;
    try { configuredPath = validateExecutablePath(env[executableSettings[id]], basename); } catch {}
    try { model = validateModel(env[modelSettings[id]]); } catch {}
    providers[id] = {
      id,
      executable: configuredPath ? resolveExecutable(configuredPath, basename, env, exists) : null,
      model,
    };
  }
  let openrouterModel = null;
  try { openrouterModel = validateRemoteModel(env.PAGENT_OPENROUTER_MODEL); } catch {}
  // Список выбора задаёт только PAGENT_OPENROUTER_MODELS. Модель по умолчанию
  // сюда не добавляется: иначе указание одной модели схлопывало бы весь выбор
  // до неё одной.
  const allowedModels = remoteModelList(env.PAGENT_OPENROUTER_MODELS);
  providers.openrouter = {
    id: 'openrouter',
    apiKey: typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim() ? env.OPENROUTER_API_KEY.trim() : null,
    model: openrouterModel,
    allowedModels: allowedModels.slice(0, OPENROUTER_MODEL_LIMIT),
    baseUrl: openrouterBaseUrl(env.PAGENT_OPENROUTER_BASE_URL),
  };
  // Ключ Google один и на голос, и на разбор: это один и тот же доступ к
  // Generative Language API, и заводить под него вторую переменную значило бы
  // просить человека вписать одно и то же дважды.
  let geminiModel = null;
  try { geminiModel = validateRemoteModel(env.PAGENT_GEMINI_MODEL); } catch {}
  const geminiKey = [env.GEMINI_API_KEY, env.GOOGLE_API_KEY].find(value => typeof value === 'string' && value.trim());
  providers.gemini = {
    id: 'gemini',
    apiKey: geminiKey ? geminiKey.trim() : null,
    model: geminiModel,
    allowedModels: remoteModelList(env.PAGENT_GEMINI_MODELS).slice(0, OPENROUTER_MODEL_LIMIT),
    baseUrl: geminiBaseUrl(env.PAGENT_GEMINI_BASE_URL),
  };
  return {
    provider,
    timeoutMs: safelyBoundedInteger(env.PAGENT_CLI_TIMEOUT_MS, 60000, 5000, 120000),
    maxConcurrency: safelyBoundedInteger(env.PAGENT_CLI_MAX_CONCURRENCY, 1, 1, 2),
    maxQueue: safelyBoundedInteger(env.PAGENT_CLI_MAX_QUEUE, 3, 0, 20),
    remoteTimeoutMs: safelyBoundedInteger(env.PAGENT_OPENROUTER_TIMEOUT_MS, 30000, 5000, 120000),
    providers,
  };
}

export function publicProviderAvailability(config, openaiEnabled) {
  const openrouter = config.providers.openrouter || { apiKey:null, model:null, allowedModels:[] };
  return {
    fallback: { configured:true, available:true },
    openai: { configured:Boolean(openaiEnabled), available:Boolean(openaiEnabled) },
    openrouter: { configured:Boolean(openrouter.apiKey), available:Boolean(openrouter.apiKey), model:openrouter.model, models:[...openrouter.allowedModels] },
    gemini: (() => { const g = config.providers.gemini || { apiKey:null, model:null, allowedModels:[] }; return { configured:Boolean(g.apiKey), available:Boolean(g.apiKey), model:g.model, models:[...g.allowedModels] }; })(),
    'codex-cli': { configured:Boolean(config.providers['codex-cli'].executable), available:Boolean(config.providers['codex-cli'].executable) },
    'claude-cli': { configured:Boolean(config.providers['claude-cli'].executable), available:Boolean(config.providers['claude-cli'].executable) },
  };
}
