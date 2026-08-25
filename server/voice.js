// Голосовой диалог: разговор с журналом вместо набора текста.
//
// Два режима одного и того же разговора:
//   live — речь в речь через Realtime API OpenAI. Ключ остаётся на сервере,
//          браузер получает короткоживущий client secret и говорит с моделью
//          напрямую, а вызовы инструментов возвращает сюда.
//   mock — тот же набор инструментов и те же ответы, но без сети и без ключа:
//          намерение разбирается здесь по правилам. Нужен, чтобы диалог можно
//          было пройти и проверить до того, как ключ появится.
//
// Инструменты — единственный способ менять журнал: и модель, и заглушка ходят
// через них, поэтому поведение совпадает, а контракт памяти не обходится.
import { enqueueCaptureJob, getAggregate, fullEntry, activeNote, saveNote, search, day, replaceInterpretation } from './db.js';
import { parseCaptureOverrides, applyUserOverrides, gateClassification, shouldMaterializeProjections } from './classifier.js';

export const VOICE_MODEL = 'gpt-realtime';
export const GEMINI_VOICE_MODEL = 'models/gemini-3.1-flash-live-preview';
const CLIENT_SECRET_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const GEMINI_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
// Живой разговор у Gemini идёт по вебсокету: браузер подключается сам, токен
// уходит в адресе — это единственный способ, который принимает их сервер.
export const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// Голос ведёт себя как собеседник, а не как командная строка: коротко
// проговаривает, что записал, и не выдумывает того, чего в журнале нет.
export const VOICE_INSTRUCTIONS = [
  'Ты — Кизуна, тихий помощник личного журнала. Говори по-русски, коротко и по делу.',
  'Записывать, искать и править записи можно только инструментами — не выдумывай содержимое журнала.',
  'Записал — назови одной фразой, что сохранил и каким типом.',
  'Если человек размышляет вслух, помоги подумать: задай уточняющий вопрос или предложи следующий шаг.',
  'Не читай длинные списки целиком: назови сколько нашлось и самое важное.',
].join(' ');

// Контракт инструментов. Один и тот же список уходит в Realtime-сессию и
// используется заглушкой, поэтому режимы не расходятся.
export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'create_capture',
    description: 'Сохранить новую запись в журнал. Текст записи — дословно то, что сказал человек.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст записи' },
        type: { type: 'string', enum: ['todo', 'outcome', 'note'], description: 'Тип записи, если человек назвал его явно' },
        due: {
          type: 'object',
          properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'ЧЧ:ММ' } },
          required: ['date'],
        },
        priority: { type: 'string', enum: ['low', 'high'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Теги без решётки' },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'search_memory',
    description: 'Найти записи по смыслу или словам. Возвращает короткие фрагменты и их идентификаторы.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'list_today',
    description: 'Что сегодня в работе: ближайшие дела и то, что требует внимания.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'append_note',
    description: 'Дописать заметку к записи. Заметка версионируется, исходный текст записи не меняется.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' }, text: { type: 'string' } },
      required: ['captureId', 'text'],
    },
  },
  {
    type: 'function',
    name: 'update_capture',
    description: 'Поправить разбор записи: тип, срок, важность, проект или отметку «сделано».',
    parameters: {
      type: 'object',
      properties: {
        captureId: { type: 'string' },
        type: { type: 'string', enum: ['todo', 'outcome', 'note'] },
        due: {
          type: 'object',
          properties: { date: { type: 'string' }, time: { type: 'string' } },
          required: ['date'],
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        project: { type: 'string' },
        done: { type: 'boolean' },
      },
      required: ['captureId'],
    },
  },
];

// Последняя запись журнала — та, к которой относится «допиши». Смотрим сами
// записи, а не разобранные: разбор может ещё идти.
function latestParsedCapture(db) {
  return (
    db
      .prepare(`SELECT c.id FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
        WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 1`)
      .get() || null
  );
}

function latestCapture(db) {
  return db.prepare('SELECT id, raw FROM captures WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get() || null;
}

const typeNames = { task: 'задача', meeting_event: 'встреча', outcome_decision: 'результат', note: 'заметка', idea_question: 'идея' };
const shortText = (value, limit = 140) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

function entrySummary(entry) {
  const classification = entry.interpretation.classification;
  return {
    captureId: entry.id,
    type: typeNames[classification.primaryType] || classification.primaryType,
    summary: shortText(classification.summary || entry.raw),
    due: classification.entities.schedule?.display || null,
    tags: classification.tags || [],
  };
}

/** Исполнение одного инструмента. Общее для живого разговора и для заглушки. */
export function runVoiceTool(db, name, args = {}, { now = () => new Date(), timeZone = 'Europe/Samara' } = {}) {
  if (name === 'create_capture') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text || text.length > 10000) return { error: 'Нужен текст записи от 1 до 10 000 символов.' };
    // У инструмента поле называется `type` — оно понятнее в разговоре; разбор
    // ждёт `primaryType`, поэтому имена сводим здесь, а не в двух местах.
    const parsed = parseCaptureOverrides(
      { primaryType: args.type, due: args.due, priority: args.priority, tags: args.tags },
      now(),
      timeZone,
    );
    if (parsed.error) return { error: 'Некорректные параметры записи.' };
    // Запись сохраняется тем же путём, что и из карточки ввода: задание в
    // очередь, разбор моделью, ручные параметры поверх разбора.
    const queued = enqueueCaptureJob(db, {
      raw: text,
      occurredAt: undefined,
      selectedProvider: 'fallback',
      overrides: parsed.overrides,
    });
    return { captureId: queued.captureId, jobId: queued.jobId, saved: true };
  }

  if (name === 'search_memory') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'Нужен запрос.' };
    const results = search(db, query).slice(0, 6).map((result) => ({
      captureId: result.captureId,
      snippet: shortText(result.snippet),
      createdAt: result.createdAt,
    }));
    return { found: results.length, results };
  }

  if (name === 'list_today') {
    // Записи берём из журнала целиком, включая те, что ещё разбираются: человек
    // только что их продиктовал и ждёт услышать их в списке, а не тишину.
    const rows = db
      .prepare(`SELECT c.id, c.raw, c.created_at, i.classification_json
        FROM captures c
        LEFT JOIN interpretations i ON i.capture_id = c.id AND i.status='active'
        WHERE c.deleted_at IS NULL
        ORDER BY c.created_at DESC LIMIT 20`)
      .all();
    const entries = rows.map((row) => {
      if (!row.classification_json) return { captureId: row.id, type: 'на разборе', summary: shortText(row.raw), due: null, tags: [] };
      const classification = JSON.parse(row.classification_json);
      return {
        captureId: row.id,
        type: typeNames[classification.primaryType] || classification.primaryType,
        summary: shortText(classification.summary || row.raw),
        due: classification.entities?.schedule?.display || null,
        tags: classification.tags || [],
      };
    });
    const open = entries.filter((entry) => ['задача', 'встреча', 'на разборе'].includes(entry.type));
    return { total: entries.length, open: open.slice(0, 6), recent: entries.slice(0, 6) };
  }

  if (name === 'append_note') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return { error: 'Нужен текст заметки.' };
    // Заметке хватает самой записи: разбор моделью может ещё идти, а дописать
    // мысль человек хочет сразу — ждать разбора незачем.
    const current = activeNote(db, args.captureId)?.body || '';
    const saved = saveNote(db, args.captureId, current ? `${current}\n\n${text}` : text);
    if (saved.notFound) return { error: 'Запись не найдена.' };
    return { captureId: args.captureId, version: saved.note?.version ?? null, appended: true };
  }

  if (name === 'update_capture') {
    const active = getAggregate(db, args.captureId);
    if (!active) {
      const exists = db.prepare('SELECT id FROM captures WHERE id=? AND deleted_at IS NULL').get(args.captureId);
      return { error: exists ? 'Запись ещё разбирается, поправить можно чуть позже.' : 'Запись не найдена.' };
    }
    const original = JSON.parse(active.classification_json);
    const overrides = {};
    if (args.type) {
      const parsed = parseCaptureOverrides({ primaryType: args.type }, now(), timeZone);
      if (parsed.error) return { error: 'Некорректный тип записи.' };
      Object.assign(overrides, parsed.overrides);
    }
    if (args.due) {
      const parsed = parseCaptureOverrides({ primaryType: 'todo', due: args.due }, now(), timeZone);
      if (parsed.error) return { error: 'Некорректный срок.' };
      overrides.due = parsed.overrides.due;
      overrides.primaryType = overrides.primaryType || 'task';
    }
    if (args.priority && args.priority !== 'normal') {
      if (!['low', 'high'].includes(args.priority)) return { error: 'Некорректная важность.' };
      overrides.priority = args.priority;
      overrides.primaryType = overrides.primaryType || 'task';
    }
    let classification = applyUserOverrides(original, Object.keys(overrides).length ? overrides : null, now(), timeZone);
    if (typeof args.project === 'string' && args.project.trim())
      classification = { ...classification, entities: { ...classification.entities, projects: [args.project.trim().slice(0, 120)] } };
    if (typeof args.done === 'boolean') classification = { ...classification, completed: args.done };
    replaceInterpretation(db, args.captureId, classification, 'manual', null, shouldMaterializeProjections(classification));
    const entry = fullEntry(db, getAggregate(db, args.captureId));
    return { captureId: args.captureId, ...entrySummary(entry), review: gateClassification(classification).level };
  }

  return { error: `Неизвестный инструмент: ${name}` };
}

// ── Заглушка разговора ──────────────────────────────────────────────────────
// Разбирает реплику по правилам и ходит теми же инструментами. Это не попытка
// изобразить модель: заглушка нужна, чтобы весь путь — интерфейс, инструменты,
// журнал — работал и проверялся до появления ключа.
const RULES = [
  { intent: 'list_today', re: /(что\s+(у\s+меня\s+)?(сегодня|на\s+сегодня)|какие\s+(дела|задачи)|план\s+на\s+день)/i },
  { intent: 'complete', re: /(отметь|пометь)\s+(как\s+)?(сделан|готов|выполнен)/i },
  { intent: 'reschedule', re: /(перенеси|сдвинь|отложи)\s*(?<when>.+)?/i },
  { intent: 'retype', re: /(это|сделай\s+это|поменяй\s+тип\s+на)\s+(?<kind>заметк\w*|задач\w*|туду|результат\w*|итог)/i },
  { intent: 'search_memory', re: /(найди|поищи|что\s+(я\s+)?(писал|говорил|решил)|напомни)\s*(про|о|об)?\s*(?<query>.+)?/i },
  { intent: 'append_note', re: /(допиши|добавь\s+к\s+записи|припиши)\s*(?<text>.+)?/i },
  { intent: 'create_capture', re: /^(запиши|заметь|сохрани|добавь)\s*(?<text>.+)?/i },
];

function detectIntent(text) {
  for (const rule of RULES) {
    const match = String(text).match(rule.re);
    if (match) return { intent: rule.intent, groups: match.groups || {} };
  }
  // Вопрос без команды — это размышление вслух, а не запись: молча положить
  // его в журнал значило бы подменить разговор.
  if (/\?\s*$/.test(String(text).trim())) return { intent: 'think', groups: { text } };
  return { intent: 'create_capture', groups: { text } };
}

// Тип и параметры из самой реплики: «запиши задачу … завтра … важно … #тег».
// Границы слов пишутся через \p{L}, а не через \b: \b в JS считает буквами
// только латиницу, и на русском тексте разбор молча промахивался.
const word = (body) => new RegExp(`(?:^|[^\\p{L}])(?:${body})(?![\\p{L}])`, 'iu');
const TODO_WORDS = word('задач[ауи]|туду|дело|дела');
const OUTCOME_WORDS = word('итог|результат|решили|сделал|сделали');
const NOTE_WORDS = word('заметк[ауи]|мысль|идея|идею');
const URGENT_WORDS = word('важно|срочно|горит');

function extractOverrides(text) {
  const overrides = {};
  if (TODO_WORDS.test(text)) overrides.type = 'todo';
  else if (OUTCOME_WORDS.test(text)) overrides.type = 'outcome';
  else if (NOTE_WORDS.test(text)) overrides.type = 'note';
  if (URGENT_WORDS.test(text)) {
    overrides.type = overrides.type || 'todo';
    overrides.priority = 'high';
  }
  const tags = [...String(text).matchAll(/#([\p{L}\p{N}_-]{1,40})/gu)].map((match) => match[1]);
  if (tags.length) overrides.tags = tags;
  return overrides;
}

const TODAY_WORD = word('сегодня');
const TOMORROW_WORD = word('завтра');
const AFTER_TOMORROW_WORD = word('послезавтра');

function relativeDate(text, now) {
  const base = new Date(now);
  if (AFTER_TOMORROW_WORD.test(text)) {
    base.setDate(base.getDate() + 2);
    return base;
  }
  if (TOMORROW_WORD.test(text)) {
    base.setDate(base.getDate() + 1);
    return base;
  }
  if (TODAY_WORD.test(text)) return base;
  return null;
}

/** Один ход разговора в режиме заглушки: реплика → инструменты → ответ. */
export function mockVoiceTurn(db, text, { now = () => new Date(), timeZone = 'Europe/Samara' } = {}) {
  const said = String(text || '').trim();
  if (!said) return { reply: 'Я слушаю.', calls: [] };
  const { intent, groups } = detectIntent(said);
  const calls = [];
  const call = (name, args) => {
    const result = runVoiceTool(db, name, args, { now, timeZone });
    calls.push({ name, arguments: args, result });
    return result;
  };

  if (intent === 'list_today') {
    const result = call('list_today', {});
    if (!result.total) return { reply: 'Сегодня записей пока нет.', calls };
    const open = result.open.map((entry) => entry.summary).slice(0, 3);
    return {
      reply: open.length
        ? `В работе ${result.open.length}: ${open.join('; ')}.`
        : `Записей за сегодня ${result.total}, открытых дел нет.`,
      calls,
    };
  }

  if (intent === 'think') {
    // Заглушка не умеет рассуждать — и не притворяется. Она приносит то, что
    // уже есть в журнале, и предлагает записать мысль.
    const result = call('search_memory', { query: said.replace(/[?？]+\s*$/, '') });
    if (result.found)
      return {
        reply: `Не берусь рассуждать без модели, но в журнале про это есть: ${result.results[0].snippet}. Записать мысль?`,
        calls,
      };
    return { reply: 'Без модели я не рассуждаю. В журнале про это ничего нет — сказать «запиши», и сохраню мысль.', calls };
  }

  if (intent === 'complete') {
    const recent = latestParsedCapture(db);
    if (!recent) return { reply: 'Нечего отмечать: разобранных записей пока нет.', calls };
    const result = call('update_capture', { captureId: recent.id, done: true });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Отметил сделанным: ${result.summary}`, calls };
  }

  if (intent === 'reschedule') {
    const recent = latestParsedCapture(db);
    if (!recent) return { reply: 'Нечего переносить: разобранных записей пока нет.', calls };
    const when = relativeDate(said, now());
    if (!when) return { reply: 'На какой день перенести — сегодня, завтра или послезавтра?', calls };
    const time = said.match(/\b(\d{1,2}):(\d{2})\b/);
    const due = { date: when.toISOString().slice(0, 10), ...(time ? { time: `${time[1].padStart(2, '0')}:${time[2]}` } : {}) };
    const result = call('update_capture', { captureId: recent.id, due });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Перенёс на ${result.due || due.date}: ${result.summary}`, calls };
  }

  if (intent === 'retype') {
    const recent = latestParsedCapture(db);
    if (!recent) return { reply: 'Нечего менять: разобранных записей пока нет.', calls };
    const kind = String(groups.kind || '').toLowerCase();
    const type = /заметк/.test(kind) ? 'note' : /задач|туду/.test(kind) ? 'todo' : 'outcome';
    const result = call('update_capture', { captureId: recent.id, type });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Теперь это ${result.type}: ${result.summary}`, calls };
  }

  if (intent === 'search_memory') {
    const query = (groups.query || said).trim();
    const result = call('search_memory', { query });
    if (!result.found) return { reply: `По «${shortText(query, 60)}» ничего не нашёл.`, calls };
    return {
      reply: `Нашёл ${result.found}. Самое близкое: ${result.results[0].snippet}`,
      calls,
    };
  }

  if (intent === 'append_note') {
    const note = (groups.text || '').trim();
    const recent = latestCapture(db);
    if (!recent) return { reply: 'Пока не к чему дописывать: журнал пуст.', calls };
    if (!note) return { reply: 'Что дописать?', calls };
    const result = call('append_note', { captureId: recent.id, text: note });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Дописал к последней записи. Версия заметки ${result.version}.`, calls };
  }

  const body = (groups.text || said).trim();
  const overrides = extractOverrides(said);
  const when = relativeDate(said, now());
  if (when) {
    overrides.type = overrides.type || 'todo';
    overrides.due = { date: when.toISOString().slice(0, 10) };
    const time = said.match(/\b(\d{1,2}):(\d{2})\b/);
    if (time) overrides.due.time = `${time[1].padStart(2, '0')}:${time[2]}`;
  }
  const result = call('create_capture', { text: body, ...overrides });
  if (result.error) return { reply: result.error, calls };
  const typeWord = { todo: 'как дело', outcome: 'как результат', note: 'как заметку' }[overrides.type] || 'на разбор';
  return { reply: `Записал ${typeWord}: ${shortText(body, 80)}`, calls };
}

// ── Живой разговор ──────────────────────────────────────────────────────────
// Инструменты у Gemini объявляются иначе: список функций внутри одного объекта
// tools, без поля type. Смысл тот же — переписываем форму, а не содержание.
export const geminiTools = (tools = VOICE_TOOLS) => [
  {
    functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  },
];

// Провайдер выбирается по ключам: явный выбор сильнее, иначе берётся тот, чей
// ключ есть. Так «добавил ключ — заработало» остаётся верным для обоих.
export function pickVoiceProvider({ requested, openaiKey, geminiKey } = {}) {
  if (requested === 'openai') return openaiKey ? 'openai' : null;
  if (requested === 'gemini') return geminiKey ? 'gemini' : null;
  if (openaiKey) return 'openai';
  if (geminiKey) return 'gemini';
  return null;
}

export function createVoiceService({
  apiKey = process.env.OPENAI_API_KEY,
  geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  provider: requestedProvider = process.env.PAGENT_VOICE_PROVIDER,
  model = process.env.PAGENT_VOICE_MODEL || VOICE_MODEL,
  geminiModel = process.env.PAGENT_GEMINI_VOICE_MODEL || GEMINI_VOICE_MODEL,
  voice = process.env.PAGENT_VOICE_NAME || 'marin',
  geminiVoice = process.env.PAGENT_GEMINI_VOICE_NAME || 'Puck',
  fetch: fetchImplementation = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 8000,
} = {}) {
  const provider = pickVoiceProvider({ requested: requestedProvider, openaiKey: apiKey, geminiKey: geminiApiKey });
  const configured = Boolean(provider);
  const activeModel = provider === 'gemini' ? geminiModel : model;
  const activeVoice = provider === 'gemini' ? geminiVoice : voice;

  // Токен Gemini живёт до получаса и годен на одно подключение: браузеру
  // достаточно, а утёкший ничего не откроет.
  async function createGeminiSession(instructions, tools) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const expireTime = new Date(now().getTime() + 30 * 60 * 1000).toISOString();
      const newSessionExpireTime = new Date(now().getTime() + 2 * 60 * 1000).toISOString();
      const response = await fetchImplementation(GEMINI_TOKEN_URL, {
        method: 'POST',
        headers: { 'x-goog-api-key': geminiApiKey, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          uses: 1,
          expireTime,
          newSessionExpireTime,
          liveConnectConstraints: {
            model: geminiModel,
            config: {
              responseModalities: ['AUDIO'],
              systemInstruction: { parts: [{ text: instructions }] },
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoice } } },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              tools: geminiTools(tools),
            },
          },
        }),
      });
      if (!response.ok) return { mode: 'live', provider: 'gemini', error: 'unavailable', status: response.status };
      const payload = await response.json();
      const token = payload?.name || payload?.token?.name;
      if (!token) return { mode: 'live', provider: 'gemini', error: 'malformed_output' };
      return {
        mode: 'live',
        provider: 'gemini',
        clientSecret: token,
        expiresAt: expireTime,
        model: geminiModel,
        voice: geminiVoice,
        url: GEMINI_LIVE_URL,
      };
    } catch (error) {
      return { mode: 'live', provider: 'gemini', error: error?.name === 'AbortError' ? 'timeout' : 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status() {
      return {
        configured,
        provider,
        mode: configured ? 'live' : 'mock',
        model: configured ? activeModel : null,
        voice: configured ? activeVoice : null,
      };
    },
    // Короткоживущий токен для браузера: сам ключ наружу не уходит.
    async createSession({ instructions = VOICE_INSTRUCTIONS, tools = VOICE_TOOLS } = {}) {
      if (!configured) return { mode: 'mock' };
      if (provider === 'gemini') return createGeminiSession(instructions, tools);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImplementation(CLIENT_SECRET_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            expires_after: { anchor: 'created_at', seconds: 600 },
            session: {
              type: 'realtime',
              model,
              instructions,
              audio: {
                input: { transcription: { model: 'whisper-1' }, turn_detection: { type: 'server_vad' } },
                output: { voice },
              },
              tools,
              tool_choice: 'auto',
            },
          }),
        });
        if (!response.ok) return { mode: 'live', provider: 'openai', error: 'unavailable', status: response.status };
        const payload = await response.json();
        if (!payload?.value) return { mode: 'live', provider: 'openai', error: 'malformed_output' };
        return { mode: 'live', provider: 'openai', clientSecret: payload.value, expiresAt: payload.expires_at ?? null, model, voice };
      } catch (error) {
        return { mode: 'live', provider: 'openai', error: error?.name === 'AbortError' ? 'timeout' : 'unavailable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
