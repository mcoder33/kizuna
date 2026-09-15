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
import { enqueueCaptureJob, getAggregate, fullEntry, activeNote, saveNote, search, day, replaceInterpretation, deleteCapture, restoreCapture, captureOwner } from './db.js';
import { parseCaptureOverrides, applyUserOverrides, gateClassification, shouldMaterializeProjections } from './classifier.js';
import { dateInZone, shiftDate } from './reports.js';
import { scheduleDisplay } from './repeat.js';

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
  'Ты — Кизуна, тихий помощник личного журнала. Говори по-русски, коротко и живо, как человек в разговоре, а не как справка.',
  'Обращаются не всегда к тебе. Если реплика — фоновая речь, чужой разговор или мысль вслух не для тебя, молчи: ничего не отвечай и не вызывай инструменты.',
  'Журнал меняется только инструментами — не выдумывай ни записи, ни их содержимое.',
  'Записал — назови одной фразой, что сохранил и каким типом.',
  'После create_capture загляни в read_capture. Если разбор неясен — нет типа, срока или пришёл вопрос, — спроси коротко одним вопросом и применённый ответ положи через update_capture. Не выдумывай тип и срок за человека.',
  'Удаление подтверждай вслух до вызова: назови, что удаляешь, и дождись согласия. После delete_capture скажи, что запись можно вернуть.',
  'Не уверен, о какой записи речь, — найди search_memory или list_today и переспроси, а не угадывай.',
  'Не читай длинные списки целиком: назови сколько нашлось и самое важное.',
  'Если человек размышляет вслух и обращается к тебе, помоги подумать: уточняющий вопрос или следующий шаг.',
  'Календарь — тоже твоя часть: list_calendar показывает свои дела и встречи вместе с событиями внешних календарей (Яндекс, Apple, Google). Своё дело или встречу двигай update_capture, чужое событие — update_event, удаление чужого события подтверждай вслух и вызывай delete_event только после согласия. Чтобы чужое событие стало записью в памяти — take_event. На приглашение отвечай respond_event, когда человек сказал, принимает он встречу или нет. Удаляя повторяющееся событие (recurring), сначала спроси: только этот повтор или всю серию — и передай scope в delete_event.',
].join(' ');

// Характер Кизуны по умолчанию — значение настройки «Системный промпт», пока
// человек не написал свой. Лёгкий японский акцент — часть образа (絆). Текст
// нарочно сдержанный: сильный акцент модель играет как спектакль, и страдает
// разборчивость.
export const DEFAULT_VOICE_CHARACTER = [
  'Говори с лёгким японским акцентом: мягкая ровная мелодика, чуть растянутые гласные, спокойный темп.',
  'Можно изредка вставлять короткие японские слова — «хай», «со дэс нэ», «аригато» — но русская речь должна оставаться полностью понятной.',
  'Акцент лёгкий, не карикатурный.',
].join(' ');

// Голоса провайдеров. Род — наша разметка, а не поле их API: официально он
// нигде не объявлен, но от него зависит, как модель говорит о себе по-русски,
// поэтому выбор голоса и род должны совпадать.
export const VOICE_CHOICES = {
  openai: [
    { id: 'marin', label: 'Marin — женский, ровный', gender: 'female' },
    { id: 'cedar', label: 'Cedar — мужской, спокойный', gender: 'male' },
    { id: 'alloy', label: 'Alloy — нейтральный', gender: 'neutral' },
    { id: 'ash', label: 'Ash — мужской', gender: 'male' },
    { id: 'ballad', label: 'Ballad — мужской, мягкий', gender: 'male' },
    { id: 'echo', label: 'Echo — мужской, тёплый', gender: 'male' },
    { id: 'verse', label: 'Verse — мужской, живой', gender: 'male' },
    { id: 'coral', label: 'Coral — женский, тёплый', gender: 'female' },
    { id: 'sage', label: 'Sage — женский, спокойный', gender: 'female' },
    { id: 'shimmer', label: 'Shimmer — женский, звонкий', gender: 'female' },
  ],
  gemini: [
    { id: 'Puck', label: 'Puck — мужской, бодрый', gender: 'male' },
    { id: 'Charon', label: 'Charon — мужской, обстоятельный', gender: 'male' },
    { id: 'Fenrir', label: 'Fenrir — мужской, напористый', gender: 'male' },
    { id: 'Orus', label: 'Orus — мужской, твёрдый', gender: 'male' },
    { id: 'Kore', label: 'Kore — женский, твёрдый', gender: 'female' },
    { id: 'Aoede', label: 'Aoede — женский, лёгкий', gender: 'female' },
    { id: 'Leda', label: 'Leda — женский, молодой', gender: 'female' },
    { id: 'Zephyr', label: 'Zephyr — женский, светлый', gender: 'female' },
  ],
};
export function voiceGender(provider, name) {
  const list = VOICE_CHOICES[provider === 'gemini' ? 'gemini' : 'openai'];
  const found = list.find(item => item.id.toLowerCase() === String(name || '').toLowerCase());
  return found?.gender || 'neutral';
}
// Что уходит модели как системный промпт: общие правила разговора, род голоса и
// добавка из настроек. Добавка именно добавляется — правила инструментов и
// памяти ею не отменяются.
export function buildVoiceInstructions({ provider, voice, extra } = {}) {
  const gender = voiceGender(provider, voice);
  const genderLine =
    gender === 'male'
      ? 'Ты говоришь мужским голосом: о себе говори в мужском роде — «записал», «нашёл», «понял».'
      : gender === 'female'
        ? 'Ты говоришь женским голосом: о себе говори в женском роде — «записала», «нашла», «поняла».'
        : 'Голос нейтральный: старайся обходиться без указания рода — «готово», «сохранено», «нашлось».';
  const addition = typeof extra === 'string' && extra.trim() ? `\nОт человека: ${extra.trim()}` : '';
  return `${VOICE_INSTRUCTIONS} ${genderLine}${addition}`;
}

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
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'ЧЧ:ММ' },
            repeat: { type: 'object', description: 'Повтор, если человек его назвал: freq daily|weekly|monthly|yearly, interval — раз в сколько периодов, until — последний день YYYY-MM-DD. Дата срока — первый экземпляр.', properties: { freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] }, interval: { type: 'integer' }, until: { type: 'string' } }, required: ['freq'] },
          },
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
    name: 'read_capture',
    description: 'Прочитать запись целиком: текст, заметку, разбор и то, чего в разборе не хватает. После сохранения новой записи — способ узнать, о чём переспросить.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' } },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'delete_capture',
    description: 'Убрать запись из журнала. Удаление мягкое: запись можно вернуть restore_capture. Вызывать только после подтверждения человеком.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' } },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'restore_capture',
    description: 'Вернуть удалённую запись обратно в журнал.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' } },
      required: ['captureId'],
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
          properties: {
            date: { type: 'string' }, time: { type: 'string' }, end: { type: 'string', description: 'ЧЧ:ММ, конец встречи или дела' },
            repeat: { type: 'object', description: 'Повтор: freq daily|weekly|monthly|yearly, interval — раз в сколько периодов, until — последний день YYYY-MM-DD; freq none снимает повтор; не передан — остаётся как был.', properties: { freq: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] }, interval: { type: 'integer' }, until: { type: 'string' } }, required: ['freq'] },
          },
          required: ['date'],
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        project: { type: 'string' },
        done: { type: 'boolean' },
      },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'list_calendar',
    description: 'Календарь за период: свои дела и встречи со сроком (captureId) и события внешних календарей (eventId вида ext:…). Без дат — неделя с сегодняшнего дня.',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } },
    },
  },
  {
    type: 'function',
    name: 'update_event',
    description: 'Перенести или переименовать событие внешнего календаря (eventId из list_calendar). Своё дело или встречу правь update_capture. Изменение уходит в Яндекс, Apple или Google сразу.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'ЧЧ:ММ; пусто — на весь день' },
        end: { type: 'string', description: 'ЧЧ:ММ' },
      },
      required: ['eventId'],
    },
  },
  {
    type: 'function',
    name: 'delete_event',
    description: 'Удалить событие из внешнего календаря. Необратимо — вызывать только после подтверждения человеком. У повторяющегося события (recurring в list_calendar) сначала спроси, удалить только этот повтор или всю серию, и передай scope.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string' }, scope: { type: 'string', enum: ['instance', 'series'], description: 'У повтора: instance — только этот экземпляр (по умолчанию), series — вся серия.' } },
      required: ['eventId'],
    },
  },
  {
    type: 'function',
    name: 'respond_event',
    description: 'Ответить на приглашение из внешнего календаря: принять, отклонить или «под вопросом», при желании с комментарием организатору. Ответ уходит организатору сразу.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string' }, status: { type: 'string', enum: ['accepted', 'declined', 'tentative'] }, comment: { type: 'string' } },
      required: ['eventId', 'status'],
    },
  },
  {
    type: 'function',
    name: 'take_event',
    description: 'Взять событие внешнего календаря в память: создать по нему запись в журнале. Само событие в календаре не меняется.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
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

function latestCapture(db, userId = null) {
  return db.prepare('SELECT id, raw FROM captures WHERE deleted_at IS NULL AND user_id IS ? ORDER BY created_at DESC LIMIT 1').get(userId) || null;
}

// «Верни» относится к тому, что убрали последним, а не к первому попавшемуся
// удалённому: человек отменяет своё же только что сказанное.
function latestDeletedCapture(db, userId = null) {
  return db.prepare('SELECT id, raw FROM captures WHERE deleted_at IS NOT NULL AND user_id IS ? ORDER BY deleted_at DESC LIMIT 1').get(userId) || null;
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
    // Признак «сделано» решает, в какую колонку журнала ляжет запись, поэтому
    // он нужен и в ответе инструмента: разговор говорит человеку, куда записал.
    completed: Boolean(classification.completed),
  };
}

/** Исполнение одного инструмента. Общее для живого разговора и для заглушки. */
// provider — тот же разбор, что и у записи из карточки ввода. Раньше здесь
// стояло жёсткое 'fallback': сказанное вслух разбирали правила, а не модель, и
// отчёт о сделанном («поговорил с парнями») уходил в заметки вместо «Что делал».
export function runVoiceTool(db, name, args = {}, { now = () => new Date(), timeZone = 'Europe/Samara', provider = 'fallback', userId = null, calendar = null } = {}) {
  // Идентификатор записи модель называет сама, а значит может назвать чужой.
  // Одна проверка на входе закрывает это для всех инструментов сразу: чужая
  // запись для разговора просто не существует.
  if (args.captureId !== undefined && captureOwner(db, args.captureId) !== userId) return { error: 'Запись не найдена.' };
  if (CALENDAR_TOOLS.has(name)) return runCalendarTool(db, name, args, { now, timeZone, provider, userId, calendar });
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
      userId,
      raw: text,
      occurredAt: undefined,
      selectedProvider: provider,
      overrides: parsed.overrides,
    });
    return { captureId: queued.captureId, jobId: queued.jobId, saved: true };
  }

  if (name === 'search_memory') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'Нужен запрос.' };
    const results = search(db, query, userId).slice(0, 6).map((result) => ({
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
        WHERE c.deleted_at IS NULL AND c.user_id IS ?
        ORDER BY c.created_at DESC LIMIT 20`)
      .all(userId);
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

  // Полное состояние записи: что в ней написано, что понял разбор и чего ему
  // не хватает. Из этого модель узнаёт, о чём переспросить, — гадать про тип и
  // срок она не должна.
  if (name === 'read_capture') {
    const row = db.prepare('SELECT id, raw, created_at, deleted_at FROM captures WHERE id=?').get(args.captureId);
    if (!row) return { error: 'Запись не найдена.' };
    const active = getAggregate(db, args.captureId);
    const note = activeNote(db, args.captureId)?.body || null;
    if (!active)
      return {
        captureId: row.id,
        raw: shortText(row.raw, 600),
        note: note ? shortText(note, 600) : null,
        deleted: Boolean(row.deleted_at),
        parsed: false,
        clarity: { clear: false, question: 'Запись ещё разбирается — тип пока неизвестен.', field: 'type' },
      };
    const classification = JSON.parse(active.classification_json);
    const review = gateClassification(classification);
    const entry = fullEntry(db, active);
    return {
      captureId: row.id,
      raw: shortText(row.raw, 600),
      note: note ? shortText(note, 600) : null,
      deleted: Boolean(row.deleted_at),
      parsed: true,
      ...entrySummary(entry),
      project: classification.entities.projects?.[0] || null,
      people: classification.entities.people || [],
      completed: Boolean(classification.completed),
      // Ясен ли разбор: если нет — здесь же лежит вопрос, который стоит задать.
      clarity: {
        clear: review.level === 'high',
        question: review.question,
        field: review.field,
      },
    };
  }

  if (name === 'delete_capture') {
    const result = deleteCapture(db, args.captureId);
    if (result.notFound) return { error: 'Запись не найдена или уже удалена.' };
    return { captureId: result.captureId, deleted: true, restorable: true };
  }

  if (name === 'restore_capture') {
    const result = restoreCapture(db, args.captureId);
    if (result.notFound) return { error: 'Запись не найдена.' };
    if (!result.restored) return { captureId: result.captureId, restored: false, reason: 'Запись и так в журнале.' };
    return { captureId: result.captureId, restored: true };
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
      const repeat = args.due.repeat && args.due.repeat.freq !== 'none' ? args.due.repeat : undefined;
      const parsed = parseCaptureOverrides({ primaryType: 'todo', due: { date: args.due.date, time: args.due.time, ...(repeat ? { repeat } : {}) } }, now(), timeZone);
      if (parsed.error) return { error: 'Некорректный срок.' };
      overrides.due = parsed.overrides.due;
      // Встреча остаётся встречей: срок у неё тоже есть, тип менять незачем.
      overrides.primaryType = overrides.primaryType || (original.primaryType === 'meeting_event' ? 'meeting_event' : 'task');
    }
    if (args.priority && args.priority !== 'normal') {
      if (!['low', 'high'].includes(args.priority)) return { error: 'Некорректная важность.' };
      overrides.priority = args.priority;
      overrides.primaryType = overrides.primaryType || 'task';
    }
    let classification = applyUserOverrides(original, Object.keys(overrides).length ? overrides : null, now(), timeZone);
    // Конец — только при времени начала и строго после него, как в карточке.
    const end = typeof args.due?.end === 'string' && /^\d{2}:\d{2}$/.test(args.due.end) ? args.due.end : null;
    const schedule = classification.entities?.schedule;
    // Повтор и убранные экземпляры — свойства срока: перенос голосом без слова
    // о повторе их не снимает; freq «none» снимает.
    const before = original.entities?.schedule;
    const clearing = args.due?.repeat?.freq === 'none';
    const kept = args.due && schedule?.date && before?.repeat && !schedule.repeat && !clearing ? { repeat: before.repeat, ...(before.skip?.length ? { skip: before.skip } : {}) } : {};
    const endValid = end && schedule?.time && end > schedule.time ? end : null;
    if (schedule && (endValid || kept.repeat))
      classification = { ...classification, entities: { ...classification.entities, schedule: { ...schedule, ...kept, ...(endValid ? { end: endValid } : {}), display: scheduleDisplay({ date: schedule.date, time: schedule.time, end: endValid || schedule.end || null, repeat: kept.repeat || schedule.repeat || null }) } } };
    if (typeof args.project === 'string' && args.project.trim())
      classification = { ...classification, entities: { ...classification.entities, projects: [args.project.trim().slice(0, 120)] } };
    if (typeof args.done === 'boolean') classification = { ...classification, completed: args.done };
    replaceInterpretation(db, args.captureId, classification, 'manual', null, shouldMaterializeProjections(classification));
    const entry = fullEntry(db, getAggregate(db, args.captureId));
    return { captureId: args.captureId, ...entrySummary(entry), review: gateClassification(classification).level };
  }

  return { error: `Неизвестный инструмент: ${name}` };
}

// ── Календарь в разговоре ───────────────────────────────────────────────────
// Те же операции, что и в сетке: посмотреть окно, подвинуть или переименовать
// чужое событие, удалить его, взять в память. Свои дела и встречи правятся
// update_capture — это запись, а не событие.
const CALENDAR_TOOLS = new Set(['list_calendar', 'update_event', 'delete_event', 'respond_event', 'take_event']);
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
function calendarItem(item) {
  return item.kind === 'external'
    ? { eventId: item.id, kind: 'событие', source: item.source, title: item.title, date: item.date, time: item.time, end: item.end, location: item.location || null, joinUrl: item.joinUrl || null, editable: Boolean(item.editable), repeat: item.repeat || null, recurring: Boolean(item.recurring), organizer: item.organizer?.name || item.organizer?.email || null, attendees: (item.attendees || []).map(attendee => `${attendee.name || attendee.email}${attendee.self ? ' (я)' : ''}: ${attendee.status}`), myStatus: item.me?.status || null }
    : { captureId: item.id, kind: item.kind === 'meeting' ? 'встреча' : 'задача', title: item.title, date: item.date, time: item.time, end: item.end, done: item.done, overdue: Boolean(item.overdue), project: item.project || null, repeat: item.repeat || null };
}
function runCalendarTool(db, name, args, { now, timeZone, provider, userId, calendar }) {
  if (!calendar) return { error: 'Календарь недоступен.' };
  if (name === 'list_calendar') {
    const today = dateInZone(now(), timeZone);
    const from = isoDate(args.from) ? args.from : today, to = isoDate(args.to) ? args.to : shiftDate(from, 6);
    const view = calendar.view({ userId, from, to });
    if (view.error) return { error: view.error === 'range_too_wide' ? 'Окно не больше двух месяцев.' : 'Некорректные даты.' };
    const items = view.items.concat(view.external).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 60).map(calendarItem);
    return { from, to, total: items.length, items, overdue: view.overdue.slice(0, 10).map(calendarItem), calendars: view.accounts.map(account => account.label) };
  }
  const eventId = typeof args.eventId === 'string' ? args.eventId : '';
  if (!eventId.startsWith('ext:')) return { error: 'Нужен eventId события из list_calendar. Своё дело правится update_capture.' };
  const messages = { not_found: 'Событие не найдено.', busy_mode: 'Этот календарь подключён в режиме «только занято»: его события не правятся.', recurring: 'В другой календарь переносится только серия целиком — в самом календаре.', calendar_not_found: 'В этот календарь писать нельзя.', account_not_found: 'Календарь отключён.', invalid_title: 'Название — до 300 символов.', invalid_schedule: 'Некорректная дата или время.', conflict: 'Событие только что изменили снаружи — обновите календарь.', unauthorized: 'Календарь не принял учётные данные, подключите его заново.' };
  const failed = result => ({ error: `${messages[result.error] || 'Календарь не принял правку.'}${result.message ? ` ${result.message}` : ''}` });
  if (name === 'update_event') {
    const patch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.date !== undefined) patch.date = args.date;
    if (args.time !== undefined) patch.time = args.time === '' ? null : args.time;
    if (args.end !== undefined) patch.end = args.end === '' ? null : args.end;
    if (!Object.keys(patch).length) return { error: 'Нечего менять: назовите новое время, дату или название.' };
    return calendar.updateExternalEvent({ userId, id: eventId, ...patch }).then(result => (result.error ? failed(result) : { eventId, updated: true, event: result.event }));
  }
  if (name === 'respond_event') {
    const messages2 = { ...messages, not_invited: 'Вас нет среди участников — отвечать некому.', invalid_status: 'Ответ — accepted, declined или tentative.' };
    return calendar.respondExternalEvent({ userId, id: eventId, status: args.status, comment: typeof args.comment === 'string' ? args.comment : undefined }).then(result => (result.error ? { error: `${messages2[result.error] || 'Календарь не принял ответ.'}${result.message ? ` ${result.message}` : ''}` } : { eventId, responded: args.status, title: result.event.title }));
  }
  if (name === 'delete_event') return calendar.deleteExternalEvent({ userId, id: eventId, scope: args.scope === 'series' ? 'series' : 'instance' }).then(result => (result.error ? failed(result) : { eventId, removed: true, title: result.title }));
  if (name === 'take_event') {
    const event = calendar.externalEvent({ userId, id: eventId });
    if (!event) return { error: messages.not_found };
    const [year, month, day] = event.date.split('-');
    const numeric = `${day}.${month}.${year}`;
    const raw = event.allDay ? `${event.title} — ${numeric}, весь день (из календаря ${event.source})` : `${event.title} — ${numeric} в ${event.time}${event.end ? `–${event.end}` : ''}${event.location ? `, ${event.location}` : ''} (из календаря ${event.source})`;
    const queued = enqueueCaptureJob(db, { userId, raw, occurredAt: undefined, selectedProvider: provider, overrides: null });
    return { captureId: queued.captureId, jobId: queued.jobId, saved: true, title: event.title };
  }
  return { error: `Неизвестный инструмент: ${name}` };
}

// ── Заглушка разговора ──────────────────────────────────────────────────────
// Разбирает реплику по правилам и ходит теми же инструментами. Это не попытка
// изобразить модель: заглушка нужна, чтобы весь путь — интерфейс, инструменты,
// журнал — работал и проверялся до появления ключа.
const RULES = [
  { intent: 'list_calendar', re: /(что\s+(у\s+меня\s+)?(в\s+календаре|завтра|на\s+неделе)|какие\s+(у\s+меня\s+)?(встречи|события)|календарь\s+на\s+(?<when>сегодня|завтра|неделю))/i },
  { intent: 'list_today', re: /(что\s+(у\s+меня\s+)?(сегодня|на\s+сегодня)|какие\s+(дела|задачи)|план\s+на\s+день)/i },
  { intent: 'complete', re: /(отметь|пометь)\s+(как\s+)?(сделан|готов|выполнен)/i },
  { intent: 'reschedule', re: /(перенеси|сдвинь|отложи)\s*(?<when>.+)?/i },
  { intent: 'delete', re: /(удали|убери|сотри)(\s+(эту\s+)?(последнюю\s+)?запись|\s+это)?\s*$/i },
  // \b в JS не считает кириллицу буквой, поэтому граница слова — через \p{L}:
  // с \b правило «верни» молча не срабатывало.
  { intent: 'restore', re: /^(верни|верните|восстанови|отмени\s+удаление)(?![\p{L}])/iu },
  { intent: 'retype', re: /(это|сделай\s+это|поменяй\s+тип\s+на)\s+(?<kind>заметк\w*|задач\w*|туду|результат\w*|итог)/i },
  // Ответ на собственный вопрос «дело или заметка?»: одно слово-тип целой
  // репликой — это уточнение к последней записи, а не новая запись.
  { intent: 'retype', re: /^\s*(?<kind>заметка|задача|дело|туду|результат|итог)\s*[.!]?\s*$/i },
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
// Отчёт о сделанном звучит по-разному, и почти всегда — прошедшим временем:
// «поговорил», «созвонились», «доделал». Без этих слов правила уводили такие
// записи в заметки.
const OUTCOME_WORDS = word(
  // \w в JS не считает кириллицу буквой: с ним «созвонились» не совпадало —
  // хвост слова описывается через \p{L}.
  'итог|результат|решили|сделал\\p{L}*|сделано|готово|поговорил\\p{L}*|обсудил\\p{L}*|созвонил\\p{L}*|встретил\\p{L}*|доделал\\p{L}*|закончил\\p{L}*|завершил\\p{L}*|починил\\p{L}*|выкатил\\p{L}*|релизил\\p{L}*|разобрал\\p{L}*',
);
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
export function mockVoiceTurn(db, text, { now = () => new Date(), timeZone = 'Europe/Samara', provider = 'fallback', userId = null, calendar = null } = {}) {
  const said = String(text || '').trim();
  if (!said) return { reply: 'Я слушаю.', calls: [] };
  const { intent, groups } = detectIntent(said);
  const calls = [];
  const call = (name, args) => {
    const result = runVoiceTool(db, name, args, { now, timeZone, provider, userId, calendar });
    calls.push({ name, arguments: args, result });
    return result;
  };

  if (intent === 'list_calendar') {
    const today = dateInZone(now(), timeZone);
    const tomorrow = /завтра/i.test(said);
    const from = tomorrow ? shiftDate(today, 1) : today, to = tomorrow ? from : /недел/i.test(said) ? shiftDate(today, 6) : /календар/i.test(said) ? shiftDate(today, 6) : today;
    const result = call('list_calendar', { from, to });
    if (result.error) return { reply: result.error, calls };
    if (!result.total) return { reply: tomorrow ? 'На завтра в календаре пусто.' : 'В календаре на этот срок пусто.', calls };
    const named = result.items.slice(0, 4).map(item => `${item.time ? `${item.time} ` : ''}${item.title}`);
    return { reply: `В календаре ${result.total}: ${named.join('; ')}.`, calls };
  }

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

  if (intent === 'delete') {
    const recent = latestCapture(db, userId);
    if (!recent) return { reply: 'Удалять нечего: журнал пуст.', calls };
    const result = call('delete_capture', { captureId: recent.id });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Убрал: ${shortText(recent.raw, 60)}. Скажите «верни», если поспешил.`, calls };
  }

  if (intent === 'restore') {
    const removed = latestDeletedCapture(db, userId);
    if (!removed) return { reply: 'Возвращать нечего: удалённых записей нет.', calls };
    const result = call('restore_capture', { captureId: removed.id });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Вернул: ${shortText(removed.raw, 60)}`, calls };
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
    const recent = latestCapture(db, userId);
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
  // Тип из реплики не следует — не выдумываем его молча, а спрашиваем: ответ
  // одним словом («задача», «заметка») ляжет на эту же запись.
  if (!overrides.type)
    return { reply: `Записал: ${shortText(body, 80)}. Это дело, заметка или результат?`, calls };
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
  // Без явного выбора предпочитается Gemini — голос Кизуны по умолчанию,
  // а OpenAI остаётся запасным, когда ключа Gemini нет.
  if (geminiKey) return 'gemini';
  if (openaiKey) return 'openai';
  return null;
}

export function createVoiceService({
  apiKey = process.env.OPENAI_API_KEY,
  geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  provider: requestedProvider = process.env.PAGENT_VOICE_PROVIDER,
  model = process.env.PAGENT_VOICE_MODEL || VOICE_MODEL,
  geminiModel = process.env.PAGENT_GEMINI_VOICE_MODEL || GEMINI_VOICE_MODEL,
  voice = process.env.PAGENT_VOICE_NAME || 'coral',
  geminiVoice = process.env.PAGENT_GEMINI_VOICE_NAME || 'Leda',
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
        // Ограничения токена лежат в bidiGenerateContentSetup — это тот же
        // setup, что уходит в сокет. В документации поле называется
        // liveConnectConstraints, но API такого имени не знает и отвечает
        // «Unknown name … Cannot find field», поэтому здесь настоящее.
        body: JSON.stringify({
          uses: 1,
          expireTime,
          newSessionExpireTime,
          bidiGenerateContentSetup: {
            model: geminiModel,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoice } } },
            },
            systemInstruction: { parts: [{ text: instructions }] },
            tools: geminiTools(tools),
            inputAudioTranscription: {},
            outputAudioTranscription: {},
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
        // Чем можно говорить прямо сейчас: выбор в интерфейсе показывается
        // только тогда, когда выбирать действительно есть из чего.
        providers: {
          openai: { configured: Boolean(apiKey), model, voice },
          gemini: { configured: Boolean(geminiApiKey), model: geminiModel, voice: geminiVoice },
        },
      };
    },
    // Короткоживущий токен для браузера: сам ключ наружу не уходит.
    // Провайдера можно выбрать на один разговор; названный без ключа не
    // подменяется молча — приложение честно говорит, что его нет.
    async createSession({ instructions = VOICE_INSTRUCTIONS, tools = VOICE_TOOLS, provider: chosen = null } = {}) {
      if (chosen === 'openai' && !apiKey) return { mode: 'live', provider: 'openai', error: 'not_configured' };
      if (chosen === 'gemini' && !geminiApiKey) return { mode: 'live', provider: 'gemini', error: 'not_configured' };
      const wanted = chosen === 'openai' || chosen === 'gemini' ? chosen : provider;
      if (!wanted) return { mode: 'mock' };
      if (wanted === 'gemini') return createGeminiSession(instructions, tools);
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
