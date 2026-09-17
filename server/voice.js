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
import { randomUUID } from 'node:crypto';
import { enqueueCaptureJob, getAggregate, fullEntry, activeNote, saveNote, search, deleteCapture, restoreCapture, captureOwner } from './db.js';
import { parseCaptureOverrides, gateClassification } from './classifier.js';
import { correctCapture } from './corrections.js';
import { afterCapture, indexLinks } from './notes-tree.js';
import { notificationCounts } from './notifications.js';
import * as circles from './circles.js';
import * as chat from './chat.js';
import { completeCapture, listDay, captureDetails, listInbox, respondRequest, assignCapture, listCircles, manageCircle, readConversation, writeMessage, messageAction, listNotificationsForVoice, notificationAction, listPages, placePageForVoice, listBoard, boardAction, getReport, listReminders, exportToCalendar, reclassifyCapture, updateSettings } from './voice-actions.js';
import { journalOverview, listJournal } from './journal.js';
import { rememberFact, forgetFact, recallFacts, memoryDigest } from './memory.js';
import { dateInZone, shiftDate } from './reports.js';
import { openaiAudioInput, geminiRealtimeInput } from './voice-turn.js';

export const VOICE_MODEL = 'gpt-realtime';
export const GEMINI_VOICE_MODEL = 'models/gemini-3.1-flash-live-preview';
const CLIENT_SECRET_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const GEMINI_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
// Живой разговор у Gemini идёт по вебсокету: браузер подключается сам, токен
// уходит в адресе — это единственный способ, который принимает их сервер.
// Путь, по которому браузер соединяется со своим же сервером вместо Google.
export const RELAY_PATH = '/api/voice/relay';
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
  'Карта журнала уже у тебя перед глазами — проекты, типы, метки, что горит. Не спрашивай человека о том, что в ней есть. Нужны подробности — list_entries с нужным признаком, нужна свежая карта — journal_overview.',
  'Что человек однажды решил, ты помнишь. Поправил тебя или попросил учитывать всегда — вызови remember одной короткой фразой и скажи, что запомнил. Второй раз об этом не спрашивай. Вспомнить — recall, забыть по просьбе — forget.',
  'Время в снимке — на начало разговора, и оно стареет: разговор может идти час. Когда нужно точное «сейчас» — который час, сколько осталось до встречи, какое сегодня число, — вызови current_time и считай от него, а не в уме.',
  'Календарь — тоже твоя часть: list_calendar показывает свои дела и встречи вместе с событиями внешних календарей (Яндекс, Apple, Google). Своё дело или встречу двигай update_capture, чужое событие — update_event, удаление чужого события подтверждай вслух и вызывай delete_event только после согласия. Чтобы чужое событие стало записью в памяти — take_event. На приглашение отвечай respond_event, когда человек сказал, принимает он встречу или нет. Удаляя повторяющееся событие (recurring), сначала спроси: только этот повтор или всю серию — и передай scope в delete_event.',
  'Закрыть дело или встречу — complete_capture, как кружок «Готово»; вернуть в работу — undo. У повторяющегося дела закрывается один день, серия живёт. Рассказ о сделанном («починил ретрай») — это новая запись-результат, а не закрытие дела.',
  'День целиком — list_today: там же просроченное, взятое у людей и сколько ждёт в «к вам». Люди и круги: list_inbox — кто что просит и кто позвал, respond_request — «беру» или «не я», assign_capture — отдать дело человеку, read_conversation и write_message — обсуждения записей и разговоры кругов, list_circles и manage_circle — сами круги.',
  'Колокольчик — list_notifications и notification_action; страницы заметок — list_pages, place_page и read_capture с full; «Доска» — list_board и board_action; «что я сделал за день или за неделю» — get_report; напоминания — list_reminders, личные настройки — update_settings.',
  'Жалоба на сам разговор — тоже настройка, а не повод извиниться. «Ты меня перебиваешь», «дай договорить», «дай подумать» — update_settings с voicePause longer; «отвечай быстрее» — voicePause shorter; «сбиваешься от шума», «замолкаешь от телевизора» — voiceInterrupt harder; «тебя не перебить» — voiceInterrupt easier. Скажи, что поменял и когда заработает — это в ответе, в applies.',
  'Сообщение другим людям, выход из круга, удаление колонки и отправку во внешний календарь проговаривай вслух и дожидайся согласия, прежде чем вызвать инструмент.',
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
// Модели разговора выбираются, а не вписываются от руки. Список берётся у
// провайдера, а не зашивается сюда: имена растут числом — 3.1, 3.5, 3.8, — и
// вписанное наугад выглядит рабочим выбором, а падает только на первой фразе.
// Зашит здесь лишь запасной список: без него выпадающий открылся бы пустым там,
// где каталог не дозвонился, хотя разговор всё это время шёл какой-то моделью.
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
// У Google имя модели идёт с приставкой models/ и с ней же уходит в запрос —
// прячем её только в подписи, чтобы список читался.
function modelChoice(id) { return { id, label: String(id).replace(/^models\//, '') }; }
export const VOICE_MODEL_FALLBACK = {
  openai: [modelChoice(VOICE_MODEL), modelChoice('gpt-realtime-mini')],
  gemini: [modelChoice(GEMINI_VOICE_MODEL)],
};
// У OpenAI живой разговор держат только realtime-модели: gpt-audio-* выдают
// эфемерный токен, но на обмене SDP отвечают «not supported in realtime mode»,
// и человек узнаёт об этом уже с включённым микрофоном. Перевод и расшифровка
// (translate, whisper) — не собеседники: инструментов у них нет.
const OPENAI_LIVE = /^gpt-realtime/;
const OPENAI_NOT_LIVE = /translate|whisper|transcribe/;
// Порядок — это ответ на «что взять»: сначала имена без версии, они всегда
// указывают на свежее, потом версии числом, потом снимки датой; внутри группы
// свежее вперёд.
function openaiRank(id) {
  if (id === VOICE_MODEL) return 0;
  if (id === 'gpt-realtime-mini') return 1;
  return /\d{4}-\d{2}-\d{2}$/.test(id) ? 3 : 2;
}
export function openaiVoiceModels(ids) {
  const usable = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && OPENAI_LIVE.test(id) && !OPENAI_NOT_LIVE.test(id));
  return [...new Set(usable)]
    .sort((left, right) => openaiRank(left) - openaiRank(right) || right.localeCompare(left, 'en', { numeric: true }))
    .map(modelChoice);
}
// У Google живой разговор — отдельный метод каталога: bidiGenerateContent.
// Спрашиваем про метод, а не про слово «live» в имени: имя сменится, метод нет.
// Имя смотрим вторым признаком — если каталог назовёт живую модель, не перечислив
// метода, потерять её хуже, чем показать лишнюю.
// Но метод сам по себе не значит «собеседник»: тем же сокетом ходят расшифровка
// (transcribe), синхронный перевод (translate) и поток для робототехники. Они
// не умеют наших инструментов, и разговор с ними обрывался бы на первой записи.
const GEMINI_NOT_LIVE = /transcribe|translate|robotics/i;
// Версия — то, по чему список читают: 3.8 выше 3.1. Внутри одной версии первым
// идёт имя без добавки: «extended-thinking» — особый случай, а не свежесть.
function geminiVersion(label) {
  const found = /(\d+(?:\.\d+)*)/.exec(label);
  return found ? found[1] : '0';
}
export function geminiVoiceModels(payload) {
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  const usable = [];
  for (const row of rows) {
    const id = typeof row?.name === 'string' ? row.name : '';
    if (!id || GEMINI_NOT_LIVE.test(id)) continue;
    const methods = Array.isArray(row?.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
    if (!methods.includes('bidiGenerateContent') && !/live/i.test(id)) continue;
    usable.push(modelChoice(id));
  }
  return usable.sort((left, right) =>
    geminiVersion(right.label).localeCompare(geminiVersion(left.label), 'en', { numeric: true })
    || left.label.length - right.label.length
    || right.label.localeCompare(left.label, 'en', { numeric: true }));
}
export function voiceGender(provider, name) {
  const list = VOICE_CHOICES[provider === 'gemini' ? 'gemini' : 'openai'];
  const found = list.find(item => item.id.toLowerCase() === String(name || '').toLowerCase());
  return found?.gender || 'neutral';
}
// Что уходит модели как системный промпт: общие правила разговора, род голоса и
// добавка из настроек. Добавка именно добавляется — правила инструментов и
// памяти ею не отменяются.
export function buildVoiceInstructions({ provider, voice, extra, briefing, memory } = {}) {
  const gender = voiceGender(provider, voice);
  const genderLine =
    gender === 'male'
      ? 'Ты говоришь мужским голосом: о себе говори в мужском роде — «записал», «нашёл», «понял».'
      : gender === 'female'
        ? 'Ты говоришь женским голосом: о себе говори в женском роде — «записала», «нашла», «поняла».'
        : 'Голос нейтральный: старайся обходиться без указания рода — «готово», «сохранено», «нашлось».';
  const addition = typeof extra === 'string' && extra.trim() ? `\nОт человека: ${extra.trim()}` : '';
  // Карта и память уходят в системный промпт, а не первым вызовом инструмента:
  // первая же реплика человека обычно про его дела, и к ней нужно быть готовым
  // заранее. Снимок стареет за разговор — потому и назван снимком.
  const map = typeof briefing === 'string' && briefing.trim() ? `\n\n${briefing.trim()}` : '';
  const known = typeof memory === 'string' && memory.trim() ? `\n\nЧто ты уже знаешь о человеке (он это поправил или попросил запомнить — следуй и не переспрашивай):\n${memory.trim()}` : '';
  return `${VOICE_INSTRUCTIONS} ${genderLine}${addition}${map}${known}`;
}

// Снимок журнала словами: то, что модель должна знать до первой реплики.
// Голосу нельзя зачитать журнал целиком, да и незачем — нужна карта: сколько
// чего, как называются проекты и люди, что горит сегодня. Без неё разговор
// начинается с трёх поисков подряд и вопроса «а какой проект?».
export function voiceBriefing(overview, now = new Date(), people = null) {
  if (!overview) return '';
  const lines = [];
  const totals = overview.totals;
  lines.push(`${clockLine(now, overview.timeZone)} Записей ${totals.entries}, открыто ${totals.open}, просрочено ${totals.overdue}${totals.unparsed ? `, на разборе ${totals.unparsed}` : ''}.`);
  if (overview.projects.length)
    lines.push(`Проекты: ${overview.projects.map(project => {
      const marks = [project.open ? `${project.open} открытых` : null, project.overdue ? `${project.overdue} просрочено` : null, project.stalled ? `тихо ${project.quietDays} дн.` : null].filter(Boolean);
      return `${project.name}${marks.length ? ` — ${marks.join(', ')}` : ''}`;
    }).join('; ')}.`);
  if (overview.types.length) lines.push(`Типы: ${overview.types.map(type => `${type.type} ${type.count}`).join(', ')}.`);
  if (overview.people.length) lines.push(`Люди: ${overview.people.map(person => person.name).join(', ')}.`);
  if (overview.tags.length) lines.push(`Метки: ${overview.tags.map(tag => tag.name).join(', ')}.`);
  if (overview.horizon.today.length) lines.push(`Сегодня: ${overview.horizon.today.map(item => `${item.time ? `${item.time} ` : ''}${item.title}`).join('; ')}.`);
  if (overview.horizon.tomorrow || overview.horizon.week) lines.push(`Завтра ${overview.horizon.tomorrow}, на неделе ${overview.horizon.week}.`);
  if (overview.overdue.length) lines.push(`Просрочено: ${overview.overdue.slice(0, 5).map(item => `«${item.title}» — ${item.daysLate} дн.`).join('; ')}`);
  const flags = overview.flags;
  const marks = [flags.high ? `важных ${flags.high}` : null, flags.questions ? `вопросов ${flags.questions}` : null, flags.followUps ? `с хвостом ${flags.followUps}` : null, flags.unclear ? `неясных ${flags.unclear}` : null, flags.repeating ? `повторяющихся ${flags.repeating}` : null].filter(Boolean);
  if (marks.length) lines.push(`Пометки: ${marks.join(', ')}.`);
  // Люди ждут ответа — это тоже часть карты: «что у меня» начинается с них.
  if (people && (people.requests || people.calls || people.unread)) lines.push(`К вам: просьб ${people.requests}, призывов ${people.calls}; непрочитанных уведомлений ${people.unread}.`);
  return `Снимок журнала на начало разговора (за свежим — journal_overview, за подробностями — list_entries):\n${lines.join('\n')}`;
}

/** Карта журнала и память одним вызовом — всё, что уходит в голову разговора. */
export function voiceContext(db, { userId = null, now = new Date(), timeZone = 'Europe/Samara' } = {}) {
  const box = circles.inbox(db, userId, [...chat.unseenCalls(db, userId), ...circles.newCircles(db, userId)]);
  const people = { requests: box.rows.filter(row => row.kind === 'request').length, calls: box.rows.filter(row => row.kind === 'call' || row.kind === 'chat').length, unread: notificationCounts(db, userId).unread };
  return { briefing: voiceBriefing(journalOverview(db, { userId, now, timeZone }), now, people), memory: memoryDigest(db, { userId }) };
}
// Который час у человека — словами, как он сам бы сказал: день недели, дата,
// время. Пояс приложения, а не гринвич: «к трём» — это к трём здесь.
export function clockNow(now = new Date(), timeZone = 'Europe/Samara') {
  const parts = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const take = type => parts.find(part => part.type === type)?.value || '';
  return {
    date: dateInZone(now, timeZone),
    time: `${take('hour')}:${take('minute')}`,
    weekday: take('weekday'),
    words: `${take('weekday')}, ${take('day')} ${take('month')} ${take('year')}, ${take('hour')}:${take('minute')}`,
    timeZone,
  };
}
const clockLine = (now, timeZone) => `Сейчас ${clockNow(now, timeZone).words} (${timeZone}).`;

// Контракт инструментов. Один и тот же список уходит в Realtime-сессию и
// используется заглушкой, поэтому режимы не расходятся.
export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'create_capture',
    description: 'Сохранить новую запись в журнал. Текст записи — дословно то, что сказал человек. Тип передавай, только если человек его назвал; со сроком или важностью тип нужен: todo — дело, meeting — встреча.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст записи' },
        type: { type: 'string', enum: ['todo', 'meeting', 'outcome', 'note', 'idea'], description: 'todo — дело, meeting — встреча, outcome — результат (сделанное), note — заметка, idea — идея или вопрос' },
        due: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'ЧЧ:ММ' },
            repeat: { type: 'object', description: 'Повтор, если человек его назвал: freq daily|weekly|monthly|yearly, interval — раз в сколько периодов, until — последний день YYYY-MM-DD. Дата срока — первый экземпляр.', properties: { freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] }, interval: { type: 'integer' }, until: { type: 'string' } }, required: ['freq'] },
            remind: { type: 'string', description: 'Напоминание: за сколько минут числом, off — не напоминать. Не названо — как в настройках.' },
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
    // Часы разговора: модель не знает, сколько сейчас времени, а снимок
    // журнала уходит в голову один раз на весь разговор и стареет вместе с ним.
    name: 'current_time',
    description: 'Который сейчас час у человека: дата, время, день недели и часовой пояс приложения. Вызывай, когда время важно — «во сколько», «сколько осталось», «какое сегодня число», «через час».',
    parameters: { type: 'object', properties: {} },
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
    description: 'День целиком, как ящик «День»: встречи, дела и события календарей по часам, дела на сегодня, просроченное, запас без срока, дела, взятые у людей, и что ещё разбирается; сколько ждёт в «к вам» и в колокольчике. Каждое дело — с captureId и признаком done. date — другой день (YYYY-MM-DD).',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD; без неё — сегодня' } } },
  },
  {
    type: 'function',
    name: 'journal_overview',
    description: 'Карта журнала целиком: сколько записей, сколько открыто и просрочено, все проекты со счётчиками и днями тишины, типы, люди, метки, пометки (важное, вопросы, хвосты, неясное, повторы), что сегодня и сколько ближайших. С неё начинай, когда нужно сориентироваться, — она заменяет десяток поисков.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'list_entries',
    description: 'Записи по признакам: проект, тип, состояние, важность, метка, участник, окно сроков, слово в тексте. Признаки складываются. Названия проектов, людей и меток бери из journal_overview. Без признаков — просто последние записи.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Название проекта из карты' },
        type: { type: 'string', enum: ['todo', 'meeting', 'note', 'outcome', 'idea'], description: 'todo — дело, meeting — встреча, outcome — результат или отчёт, idea — идея или вопрос' },
        status: { type: 'string', enum: ['open', 'done', 'overdue', 'any'], description: 'open — не закрытые дела и встречи, done — закрытые и сделанное, overdue — просроченные, any — все' },
        priority: { type: 'string', enum: ['low', 'high'] },
        tag: { type: 'string', description: 'Метка без решётки' },
        person: { type: 'string', description: 'Участник' },
        from: { type: 'string', description: 'Срок не раньше, YYYY-MM-DD' },
        to: { type: 'string', description: 'Срок не позже, YYYY-MM-DD' },
        query: { type: 'string', description: 'Слово в заголовке или тексте' },
        limit: { type: 'integer', description: 'Сколько вернуть, по умолчанию 30, не больше 100' },
        offset: { type: 'integer', description: 'Сколько пропустить — чтобы дочитать длинный список следующим вызовом' },
      },
    },
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
    description: 'Прочитать запись целиком: текст, заметку, разбор и то, чего в разборе не хватает; закрыта ли, срок и повтор, кому отдана, что в обсуждении, откуда отделилась и что из неё вышло, где лежит страницей. Можно и чужую запись, которую человеку показали в круге. После сохранения новой записи — способ узнать, о чём переспросить.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' }, full: { type: 'boolean', description: 'Весь текст и заметку, а не начало — чтобы прочитать страницу' } },
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
    description: 'Поправить запись, как в карточке: тип, заголовок, срок (дата, время, конец, повтор, напоминание), важность, проект, участники, следующее действие. Не названное остаётся как было: перенос на другой день без времени сохраняет прежнее время и повтор. clearDue — снять срок. Закрыть дело — не здесь, а complete_capture.',
    parameters: {
      type: 'object',
      properties: {
        captureId: { type: 'string' },
        type: { type: 'string', enum: ['todo', 'meeting', 'outcome', 'note', 'idea'], description: 'todo — дело, meeting — встреча, outcome — результат: сделанное, ляжет в «Что делал», note — заметка, idea — идея или вопрос' },
        title: { type: 'string', description: 'Новый заголовок' },
        due: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            time: { type: 'string', description: 'ЧЧ:ММ; пустая строка — без времени; не передано — прежнее' },
            end: { type: 'string', description: 'ЧЧ:ММ, конец встречи или дела' },
            repeat: { type: 'object', description: 'Повтор: freq daily|weekly|monthly|yearly, interval — раз в сколько периодов, until — последний день YYYY-MM-DD; freq none снимает повтор; не передан — остаётся как был.', properties: { freq: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] }, interval: { type: 'integer' }, until: { type: 'string' } }, required: ['freq'] },
            remind: { type: 'string', description: 'За сколько минут напомнить числом, off — не напоминать, default — как в настройках' },
          },
          required: ['date'],
        },
        clearDue: { type: 'boolean', description: 'Снять срок совсем' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        project: { type: 'string', description: 'Проект; пустая строка — убрать' },
        people: { type: 'array', items: { type: 'string' }, description: 'Участники целиком, новым списком' },
        followUp: { type: 'string', description: 'Следующее действие; пустая строка — убрать' },
      },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'complete_capture',
    description: 'Закрыть дело или встречу — то же, что кружок «Готово» в «Дне», на «Доске» и в календаре; undo: true — вернуть в работу. У повторяющегося дела закрывается один день (date; без неё — сегодняшний или ближайший), серия живёт дальше; series: true — закрыть всю серию. Взятое у человека из круга дело тоже закрывается — автор увидит «сделано». Рассказ о сделанном записывай не так, а update_capture с type outcome.',
    parameters: {
      type: 'object',
      properties: {
        captureId: { type: 'string' },
        undo: { type: 'boolean', description: 'Вернуть в работу' },
        date: { type: 'string', description: 'YYYY-MM-DD — какой день повтора' },
        series: { type: 'boolean', description: 'Закрыть повторяющееся дело целиком' },
      },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'list_calendar',
    description: 'Календарь за период: свои дела и встречи со сроком и взятые у людей (captureId, done, recurring — у повтора date это день экземпляра) и события внешних календарей (eventId вида ext:…). Без дат — неделя с сегодняшнего дня.',
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
  {
    type: 'function',
    name: 'export_to_calendar',
    description: 'Отправить своё дело или встречу со сроком во внешний календарь (Яндекс, Apple, Google) или убрать оттуда (remove: true). calendar — название календаря или учётной записи; не знаешь куда — вызови без него, в ответе будет список. Это действие наружу: назови вслух, куда отправляешь.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' }, calendar: { type: 'string' }, remove: { type: 'boolean' } },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'list_inbox',
    description: '«К вам» и «Я жду»: просьбы людей из кругов (ответ — respond_request), призывы @имя в обсуждениях записей и разговорах кругов, новые круги; и дела, которые человек отдал другим, с состоянием — ждёт ответа, взято, сделано, вернули.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'respond_request',
    description: 'Ответить на просьбу из круга (assignmentId из list_inbox): take true — «беру», дело встаёт в день человека; false — «не я», дело возвращается автору, reason — почему, если человек сказал.',
    parameters: {
      type: 'object',
      properties: { assignmentId: { type: 'string' }, take: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['assignmentId', 'take'],
    },
  },
  {
    type: 'function',
    name: 'assign_capture',
    description: 'Отдать своё дело человеку из круга — у него появится просьба «беру / не я». person — имя, как его называют («Ане» тоже подходит); circle — круг, если человек в нескольких. cancel: true — снять просьбу.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' }, person: { type: 'string' }, circle: { type: 'string' }, cancel: { type: 'boolean' } },
      required: ['captureId'],
    },
  },
  {
    type: 'function',
    name: 'list_circles',
    description: 'Круги человека: участники с их открытыми делами и разговоры круга (roomId, сколько непрочитанного, где позвали).',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'manage_circle',
    description: 'Круги: create — завести (name); rename — переименовать (circle, name); mute — не показывать круг в дне, unmute — вернуть; leave — выйти из круга, dissolve — распустить круг (только хозяин; оба — сначала переспроси); add_person — добавить человека из Кизуны (circle, person); create_room — завести разговор (circle, name и people — с кем, или everyone: true — на весь круг); rename_room, add_to_room (person), leave_room — разговор круга по названию (room).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'rename', 'mute', 'unmute', 'leave', 'dissolve', 'add_person', 'create_room', 'rename_room', 'add_to_room', 'leave_room'] },
        circle: { type: 'string', description: 'Название круга' },
        room: { type: 'string', description: 'Название разговора в круге' },
        name: { type: 'string' },
        person: { type: 'string' },
        people: { type: 'array', items: { type: 'string' } },
        everyone: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'read_conversation',
    description: 'Прочитать разговор: captureId — обсуждение записи, roomId — разговор круга; без них — где сейчас говорят, непрочитанное и призывы сверху. Прочитанное гаснет в колокольчике, как при открытии карточки.',
    parameters: { type: 'object', properties: { captureId: { type: 'string' }, roomId: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'write_message',
    description: 'Написать в обсуждение записи (captureId) или в разговор круга (roomId). Позвать человека — «@Имя» в тексте. replyTo — commentId или messageId, на которое отвечаешь. Позвать можно любого из кругов человека. Если позванные ещё не видят запись или их нет в этом разговоре, ответ попросит спросить человека и повторить с share: yes (позвать) или no (отправить молча). Текст для других людей проговори перед отправкой.',
    parameters: {
      type: 'object',
      properties: { captureId: { type: 'string' }, roomId: { type: 'string' }, text: { type: 'string' }, replyTo: { type: 'string' }, share: { type: 'string', enum: ['yes', 'no'] } },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'message_action',
    description: 'Действие с сообщением или обсуждением: react — реакция на сообщение записи (captureId и commentId) или разговора (roomId и messageId); pin и unpin — закрепить сообщение разговора или снять закреп; remove — убрать своё сообщение разговора; unfollow — перестать следить за обсуждением записи; remove_person — убрать человека из записи (может только автор).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['react', 'pin', 'unpin', 'remove', 'unfollow', 'remove_person'] },
        captureId: { type: 'string' }, commentId: { type: 'string' }, roomId: { type: 'string' }, messageId: { type: 'string' },
        emoji: { type: 'string', enum: ['👍', '❤️', '🔥', '🙏', '👀', '✅'] },
        person: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'list_notifications',
    description: 'Колокольчик: просьбы, призывы, ответы, реакции, напоминания, встречи из календарей, утренняя сводка. filter: waits — ждут ответа, people — люди, time — сроки и встречи, other — остальное; unreadOnly — только непрочитанное.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', enum: ['all', 'waits', 'people', 'time', 'other'] }, unreadOnly: { type: 'boolean' }, limit: { type: 'integer' } },
    },
  },
  {
    type: 'function',
    name: 'notification_action',
    description: 'С уведомлением: read — отметить прочитанным, read_all — прочитать всё, dismiss — убрать из ленты, clear — очистить ленту (ждущее ответа остаётся), snooze — напомнить позже (minutes, по умолчанию 10), respond — ответить на приглашение (status accepted, declined или tentative). Выключить повод целиком — update_settings.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['read', 'read_all', 'dismiss', 'clear', 'snooze', 'respond'] }, notificationId: { type: 'string' }, minutes: { type: 'integer' }, status: { type: 'string', enum: ['accepted', 'declined', 'tentative'] } },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'list_pages',
    description: 'Страницы раздела «Заметки»: название, где лежит (внутри какой страницы, в проекте, во «Входящих»), начало текста. query — найти по слову. Прочитать страницу целиком — read_capture с full: true.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'place_page',
    description: 'Завести страницу (title, без pageId) или переложить существующую (pageId): parent — название страницы, внутрь которой положить, root — в корень, auto — на место по правилу (в проект или во «Входящие»); project — завести новую страницу в проекте.',
    parameters: {
      type: 'object',
      properties: { pageId: { type: 'string' }, title: { type: 'string' }, parent: { type: 'string' }, project: { type: 'string' } },
    },
  },
  {
    type: 'function',
    name: 'list_board',
    description: '«Доска»: колонки с делами (captureId, срок, важность) и недавно закрытое.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'board_action',
    description: '«Доска»: move — переложить дело (captureId) в колонку (column, position top или bottom); create_column — завести колонку (name); rename_column — переименовать (column, name); delete_column — удалить (column; сначала переспроси — дела уйдут во «Входящие»).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'create_column', 'rename_column', 'delete_column'] },
        captureId: { type: 'string' }, column: { type: 'string' }, name: { type: 'string' },
        position: { type: 'string', enum: ['top', 'bottom'] },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'get_report',
    description: 'Что сделано и что висит. period day — за день (date, по умолчанию сегодня): записанная работа, закрытые дела, несделанное, встречи; week, month, all — счётчики, просроченное, вопросы без ответа, проекты и люди, заглохшее.',
    parameters: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['day', 'week', 'month', 'all'] }, date: { type: 'string', description: 'YYYY-MM-DD для period day' } },
    },
  },
  {
    type: 'function',
    name: 'list_reminders',
    description: 'Ближайшие напоминания: о каком деле и когда напомнит. Поменять напоминание у дела — update_capture с due.remind.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'reclassify_capture',
    description: 'Переразобрать запись моделью заново — когда разбор вышел совсем не тем и проще начать с нуля, чем править поля.',
    parameters: { type: 'object', properties: { captureId: { type: 'string' } }, required: ['captureId'] },
  },
  {
    type: 'function',
    name: 'update_settings',
    description: 'Личные настройки: remindDefault — за сколько минут напоминать о делах со временем (или off); remindHour — в котором часу напоминать о делах без времени (ЧЧ:ММ или off); quietHours — тихие часы (ЧЧ:ММ-ЧЧ:ММ или off); notify — куда слать повод: kind из list_notifications, mode off, bell или phone; wakeWord — слово, которым будят разговор; sleepAfterSeconds — через сколько секунд тишины разговор засыпает; displayName — как человека зовут в кругах; voiceInterrupt — насколько легко перебить тебя: easy — с полуслова, normal, loud — только громко (шум и чужие голоса не сбивают), или шаг easier/harder от того, что стоит; voicePause — сколько тишины ждать, прежде чем отвечать: quick — 0,3 с, normal — 0,5 с, wait — 1 с, think — 2 с, или шаг shorter/longer.',
    parameters: {
      type: 'object',
      properties: {
        remindDefault: { type: 'string' }, remindHour: { type: 'string' }, quietHours: { type: 'string' },
        notify: { type: 'object', properties: { kind: { type: 'string' }, mode: { type: 'string', enum: ['off', 'bell', 'phone'] } }, required: ['kind', 'mode'] },
        wakeWord: { type: 'string' }, sleepAfterSeconds: { type: 'integer' }, displayName: { type: 'string' },
        voiceInterrupt: { type: 'string', enum: ['easy', 'normal', 'loud', 'easier', 'harder'] },
        voicePause: { type: 'string', enum: ['quick', 'normal', 'wait', 'think', 'shorter', 'longer'] },
      },
    },
  },
  {
    type: 'function',
    name: 'remember',
    description: 'Запомнить решённое навсегда: как человек называет вещи, что считать делом, а что отчётом, любое его правило. Вызывай, когда человек тебя поправил или сказал «запомни», «всегда так», «больше не спрашивай». Одна короткая фраза от первого лица о человеке, не пересказ записи — журнал для записей.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Правило одной фразой: «созвоны с подрядчиком — это встречи»' },
        subject: { type: 'string', description: 'К чему правило относится: слово, проект, человек. По нему правило потом и обновляется' },
        kind: { type: 'string', enum: ['rule', 'preference', 'fact', 'term'], description: 'rule — как разбирать, preference — как вести себя с человеком, fact — факт о человеке, term — что означает слово' },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'recall',
    description: 'Вспомнить, что уже решено по теме. Спрашивай до того, как переспросить человека: возможно, ответ уже дан однажды.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Тема; пусто — всё, что помнишь' } },
    },
  },
  {
    type: 'function',
    name: 'forget',
    description: 'Забыть правило — только по просьбе человека. memoryId берётся из recall.',
    parameters: {
      type: 'object',
      properties: { memoryId: { type: 'string' } },
      required: ['memoryId'],
    },
  },
];

// Последняя запись журнала — та, к которой относится «допиши». Смотрим сами
// записи, а не разобранные: разбор может ещё идти.
function latestParsedCapture(db, userId = null) {
  return (
    db
      .prepare(`SELECT c.id FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
        WHERE c.deleted_at IS NULL AND c.user_id IS ? ORDER BY c.created_at DESC LIMIT 1`)
      .get(userId) || null
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
  const completable = entry.projections.filter(projection => ['task', 'meeting_event'].includes(projection.type));
  return {
    captureId: entry.id,
    type: typeNames[classification.primaryType] || classification.primaryType,
    summary: shortText(classification.summary || entry.raw),
    due: classification.entities.schedule?.display || null,
    tags: classification.tags || [],
    // Признак «сделано» решает, в какую колонку журнала ляжет запись, поэтому
    // он нужен и в ответе инструмента: разговор говорит человеку, куда записал.
    completed: Boolean(classification.completed),
    // Закрыто ли дело кружком — отдельно от «сделано»: результат и закрытое
    // дело живут в разных местах дня, и голос должен говорить о них правильно.
    done: Boolean(classification.completed) || (completable.length > 0 && completable.every(projection => projection.completion.completed)),
  };
}
// Тип записи словом из разговора — в тип разбора.
const VOICE_TYPES = { todo: 'task', meeting: 'meeting_event', outcome: 'outcome_decision', note: 'note', idea: 'idea_question' };
// Напоминание словом из разговора: число минут, off или «как в настройках».
function remindOf(value) {
  if (value === undefined) return undefined;
  if (value === null || value === 'default' || value === '') return null;
  if (value === 'off') return 'off';
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 ? minutes : 'invalid';
}
// Прочитать, обсудить и закрыть можно не только своё: запись, которую показали
// в круге или куда позвали, — прочитать и написать в обсуждение; дело, взятое
// у человека, — закрыть. Править и удалять — только своё, как в карточке.
const SHARED_READS = new Set(['read_capture', 'read_conversation', 'write_message', 'message_action']);
const ACTIONS = {
  complete_capture: completeCapture, list_inbox: listInbox, respond_request: respondRequest, assign_capture: assignCapture,
  list_circles: listCircles, manage_circle: manageCircle, read_conversation: readConversation, write_message: writeMessage, message_action: messageAction,
  list_notifications: listNotificationsForVoice, notification_action: notificationAction, list_pages: listPages, place_page: placePageForVoice,
  list_board: listBoard, board_action: boardAction, get_report: getReport, list_reminders: listReminders, export_to_calendar: exportToCalendar,
  reclassify_capture: reclassifyCapture, update_settings: updateSettings,
};

/** Исполнение одного инструмента. Общее для живого разговора и для заглушки. */
// provider — тот же разбор, что и у записи из карточки ввода. Раньше здесь
// стояло жёсткое 'fallback': сказанное вслух разбирали правила, а не модель, и
// отчёт о сделанном («поговорил с парнями») уходил в заметки вместо «Что делал».
// hooks — то, что маршрут делает вокруг действия: живое обновление вкладок,
// переразбор моделью, запись настроек (см. server/voice-actions.js).
export function runVoiceTool(db, name, args = {}, { now = () => new Date(), timeZone = 'Europe/Samara', provider = 'fallback', userId = null, calendar = null, hooks = null } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  // Идентификатор записи модель называет сама, а значит может назвать чужой.
  // Одна проверка на входе закрывает это для всех инструментов сразу: чужой
  // записи для разговора не существует, если человек не видит её и в
  // интерфейсе.
  if (args.captureId !== undefined) {
    const own = captureOwner(db, args.captureId) === userId;
    const shared = !own && ((SHARED_READS.has(name) && circles.canSeeCapture(db, args.captureId, userId)) || (name === 'complete_capture' && circles.canCompleteCapture(db, args.captureId, userId)));
    if (!own && !shared) return { error: 'Запись не найдена.' };
  }
  const context = { now, timeZone, provider, userId, calendar, hooks };
  if (Object.hasOwn(ACTIONS, name)) return ACTIONS[name](db, args, context);
  if (CALENDAR_TOOLS.has(name)) return runCalendarTool(db, name, args, context);
  if (name === 'create_capture') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text || text.length > 10000) return { error: 'Нужен текст записи от 1 до 10 000 символов.' };
    if (args.type !== undefined && args.type !== null && !Object.hasOwn(VOICE_TYPES, args.type)) return { error: 'Тип — todo, meeting, outcome, note или idea.' };
    // Срок и важность без типа разбор не принимает: сказать «дело» или
    // «встреча» — решение человека, а не догадка разговора.
    if ((args.due || args.priority) && !args.type) return { error: 'Со сроком или важностью нужен тип: todo — дело, meeting — встреча.' };
    const remind = args.due && typeof args.due === 'object' ? remindOf(args.due.remind) : undefined;
    if (remind === 'invalid') return { error: 'Напоминание — число минут или off.' };
    const due = args.due && typeof args.due === 'object' ? { ...args.due, remind: remind ?? undefined } : args.due;
    // У инструмента поле называется `type` — оно понятнее в разговоре; разбор
    // ждёт `primaryType`, поэтому имена сводим здесь, а не в двух местах.
    const parsed = parseCaptureOverrides(
      { primaryType: args.type, due, priority: args.priority, tags: args.tags },
      now(),
      timeZone,
    );
    if (parsed.error) return { error: parsed.error === 'overrides_require_todo' ? 'Важность бывает только у дела, срок — у дела или встречи.' : 'Некорректные параметры записи.' };
    // Запись сохраняется тем же путём, что и из карточки ввода: задание в
    // очередь, разбор моделью, ручные параметры поверх разбора.
    const queued = enqueueCaptureJob(db, {
      userId,
      raw: text,
      occurredAt: undefined,
      selectedProvider: provider,
      overrides: parsed.overrides,
    });
    // Как у записи с «Сегодня»: «в Страница: …» и [[ссылки]] в тексте
    // раскладываются сразу, не дожидаясь разбора.
    try { afterCapture(db, { captureId: queued.captureId, userId }); } catch {}
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

  if (name === 'list_today') return listDay(db, args, context);

  // Карта журнала: с неё начинается ориентировка. В голове разговора лежит
  // снимок на его начало, а журнал за разговор меняется — здесь он свежий.
  if (name === 'current_time') return clockNow(now(), timeZone);
  if (name === 'journal_overview') return journalOverview(db, { userId, now: now(), timeZone });

  if (name === 'list_entries') {
    const text = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined);
    const result = listJournal(db, {
      userId, now: now(), timeZone,
      project: text(args.project), type: text(args.type), status: ['open', 'done', 'overdue', 'any'].includes(args.status) ? args.status : 'any',
      priority: ['low', 'high'].includes(args.priority) ? args.priority : undefined,
      tag: text(args.tag), person: text(args.person), from: isoDate(args.from) ? args.from : undefined, to: isoDate(args.to) ? args.to : undefined,
      query: text(args.query), limit: args.limit, offset: args.offset,
    });
    if (result.error === 'unknown_type') return { error: 'Неизвестный тип: бывают todo, meeting, note, outcome, idea.' };
    return result;
  }

  // Память помощника. Голос пишет только личную память человека: общая — дело
  // администратора, разговор её не трогает.
  if (name === 'remember') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return { error: 'Нужно, что запомнить.' };
    // Сказанное вслух — не догадка: такому правилу веры больше, чем выведенному
    // нами из поправки.
    const saved = rememberFact(db, { userId, kind: ['rule', 'preference', 'fact', 'term'].includes(args.kind) ? args.kind : 'rule', subject: typeof args.subject === 'string' && args.subject.trim() ? args.subject : text, body: text, source: 'voice', confidence: 0.9 });
    if (saved.error) return { error: 'Не получилось запомнить.' };
    return { memoryId: saved.id, remembered: true, updated: Boolean(saved.updated), text };
  }

  if (name === 'recall') {
    const found = recallFacts(db, { userId, query: typeof args.query === 'string' ? args.query : '', limit: 8 });
    return { found: found.length, memories: found.map(item => ({ memoryId: item.id, text: item.body, subject: item.subject, scope: item.scope === 'shared' ? 'общее' : 'личное' })) };
  }

  if (name === 'forget') {
    const result = forgetFact(db, { userId, memoryId: typeof args.memoryId === 'string' ? args.memoryId : '' });
    if (result.notFound) return { error: 'Такого правила не помню.' };
    return { forgotten: true, text: result.body };
  }

  if (name === 'append_note') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return { error: 'Нужен текст заметки.' };
    // Заметке хватает самой записи: разбор моделью может ещё идти, а дописать
    // мысль человек хочет сразу — ждать разбора незачем.
    // Пока своей заметки нет, тело записи начинается с её текста — так его
    // показывают карточка и страница. Дописывать к пустому значило бы стереть
    // исходный текст из заметки.
    const note = activeNote(db, args.captureId);
    const base = note ? note.body : db.prepare('SELECT raw FROM captures WHERE id=?').get(args.captureId)?.raw || '';
    const saved = saveNote(db, args.captureId, base ? `${base}\n\n${text}` : text);
    if (saved.notFound) return { error: 'Запись не найдена.' };
    try { indexLinks(db, args.captureId); } catch {}
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
      ...captureDetails(db, args.captureId, userId, { full: args.full === true }),
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
    if (args.done !== undefined) return { error: 'Закрыть дело — complete_capture; записать сделанное результатом — type outcome.' };
    // Поправка голосом — та же поправка, что из карточки (server/corrections.js):
    // напоминание, повтор и убранные экземпляры при переносе не теряются.
    const before = JSON.parse(active.classification_json).entities?.schedule || null;
    const patch = {};
    if (args.type !== undefined) {
      if (!Object.hasOwn(VOICE_TYPES, args.type)) return { error: 'Тип — todo, meeting, outcome, note или idea.' };
      patch.primaryType = VOICE_TYPES[args.type];
    }
    if (typeof args.title === 'string') patch.summary = args.title;
    if (args.clearDue === true) patch.schedule = { date: null, time: null };
    else if (args.due && typeof args.due === 'object') {
      const due = args.due;
      // Перенос без времени оставляет прежнее время: «на завтра» не значит
      // «на завтра без часа». Пустая строка время снимает.
      const time = due.time === undefined ? before?.time || null : due.time || null;
      const end = due.end === undefined ? (time && time === before?.time ? before?.end || null : null) : due.end || null;
      const repeat = due.repeat === undefined ? undefined : due.repeat?.freq === 'none' ? null : due.repeat;
      const remind = remindOf(due.remind);
      if (remind === 'invalid') return { error: 'Напоминание — число минут, off или default.' };
      patch.schedule = { date: typeof due.date === 'string' ? due.date : null, time, ...(end ? { end } : {}), ...(repeat !== undefined ? { repeat } : {}), ...(remind !== undefined ? { remind } : {}) };
    }
    if (args.priority !== undefined) patch.priority = args.priority;
    if (typeof args.project === 'string') patch.project = args.project.trim() ? args.project.trim().slice(0, 120) : null;
    if (Array.isArray(args.people)) patch.people = args.people.filter(person => typeof person === 'string' && person.trim()).map(person => person.trim().slice(0, 120)).slice(0, 8);
    if (typeof args.followUp === 'string') patch.followUp = args.followUp.trim() ? args.followUp.trim().slice(0, 500) : null;
    if (!Object.keys(patch).length) return { error: 'Нечего менять: назовите тип, заголовок, срок, важность, проект, участников или следующее действие.' };
    // Ключ операции свой на каждый вызов: «убери повтор», «верни», «убери снова»
    // — три разных поправки, а не повтор одной.
    const result = correctCapture(db, { captureId: args.captureId, userId, patch, operationKey: `voice-${randomUUID()}`, source: 'voice' });
    if (result.error) return { error: result.error.message };
    return { captureId: args.captureId, ...entrySummary(result.entry), review: result.review.level, undoGroupId: result.undoGroupId };
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
    : { captureId: item.id, kind: item.kind === 'meeting' ? 'встреча' : 'задача', title: item.title, date: item.date, time: item.time, end: item.end, done: item.done, overdue: Boolean(item.overdue), project: item.project || null, repeat: item.repeat || null, recurring: Boolean(item.recurring) };
}
function runCalendarTool(db, name, args, { now, timeZone, provider, userId, calendar }) {
  if (!calendar) return { error: 'Календарь недоступен.' };
  if (name === 'list_calendar') {
    const today = dateInZone(now(), timeZone);
    const from = isoDate(args.from) ? args.from : today, to = isoDate(args.to) ? args.to : shiftDate(from, 6);
    // Взятые у людей дела стоят в календаре рядом со своими, как в сетке.
    const view = calendar.view({ userId, from, to, borrowed: circles.acceptedFor(db, userId).map(row => row.capture_id) });
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
  { intent: 'journal_overview', re: /^\s*(какие\s+(у\s+меня\s+)?проект|что\s+(у\s+меня\s+)?(вообще|всего)\s+есть|карта\s+журнала|обзор\s+журнала|как\s+дела\s+по\s+проектам)/i },
  { intent: 'list_entries', re: /^\s*(что|покажи|какие\s+дела)\s+по\s+(проекту\s+)?(?<project>[^?.!]{2,40})\s*[?.!]?\s*$/i },
  { intent: 'remember', re: /^(запомни|запомните|учти|имей\s+в\s+виду)\s*[,:—-]?\s*(?<text>.+)/i },
  { intent: 'forget', re: /^(забудь|не\s+помни)\s*(про|о|об)?\s*(?<query>.+)/i },
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
export function mockVoiceTurn(db, text, { now = () => new Date(), timeZone = 'Europe/Samara', provider = 'fallback', userId = null, calendar = null, hooks = null } = {}) {
  const said = String(text || '').trim();
  if (!said) return { reply: 'Я слушаю.', calls: [] };
  const { intent, groups } = detectIntent(said);
  const calls = [];
  const call = (name, args) => {
    const result = runVoiceTool(db, name, args, { now, timeZone, provider, userId, calendar, hooks });
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

  // Карта журнала словами: заглушка отвечает тем же, чем живая модель начинает
  // разговор, — счётчиками и проектами, а не пересказом записей.
  if (intent === 'journal_overview') {
    const result = call('journal_overview', {});
    const projects = result.projects.slice(0, 4).map(project => `${project.name}${project.open ? ` — ${project.open} открытых` : ''}`);
    return {
      reply: `Записей ${result.totals.entries}, открыто ${result.totals.open}, просрочено ${result.totals.overdue}.${projects.length ? ` Проекты: ${projects.join('; ')}.` : ' Проектов пока нет.'}`,
      calls,
    };
  }

  if (intent === 'list_entries') {
    const project = String(groups.project || '').trim();
    const result = call('list_entries', { project, status: 'open' });
    if (result.error) return { reply: result.error, calls };
    if (!result.total) return { reply: `По «${project}» открытых записей нет.`, calls };
    return { reply: `По «${project}» ${result.total}: ${result.items.slice(0, 3).map(item => item.title).join('; ')}.`, calls };
  }

  if (intent === 'remember') {
    const remembered = String(groups.text || '').trim();
    if (!remembered) return { reply: 'Что запомнить?', calls };
    const result = call('remember', { text: remembered });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Запомнил: ${result.text}. Больше не спрошу.`, calls };
  }

  if (intent === 'forget') {
    const query = String(groups.query || '').trim();
    const found = call('recall', { query });
    if (!found.found) return { reply: 'Такого не помню.', calls };
    const result = call('forget', { memoryId: found.memories[0].memoryId });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Забыл: ${result.text}`, calls };
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
    const recent = latestParsedCapture(db, userId);
    if (!recent) return { reply: 'Нечего отмечать: разобранных записей пока нет.', calls };
    // «Отметь сделанным» — кружок «Готово», а не превращение дела в результат.
    const result = call('complete_capture', { captureId: recent.id });
    if (result.error) return { reply: result.error, calls };
    return { reply: `Отметил сделанным: ${result.title}`, calls };
  }

  if (intent === 'reschedule') {
    const recent = latestParsedCapture(db, userId);
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
    const recent = latestParsedCapture(db, userId);
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
  liveUrl = GEMINI_LIVE_URL,
} = {}) {
  const provider = pickVoiceProvider({ requested: requestedProvider, openaiKey: apiKey, geminiKey: geminiApiKey });
  const configured = Boolean(provider);
  const activeModel = provider === 'gemini' ? geminiModel : model;
  const activeVoice = provider === 'gemini' ? geminiVoice : voice;

  // Билеты на релей: короткоживущие разовые пропуска, по которым сервер
  // достаёт настоящий токен Google и открывает сокет за человека. Живут в
  // памяти процесса — переживать перезапуск им незачем, разговор всё равно
  // оборвётся.
  const tickets = new Map();
  function issueRelayTicket(payload) {
    const ticket = randomUUID();
    tickets.set(ticket, { ...payload, expiresAt: now().getTime() + 5 * 60 * 1000 });
    for (const [key, value] of tickets) if (value.expiresAt <= now().getTime()) tickets.delete(key);
    return ticket;
  }
  // Билет одноразовый: подключились — и он больше ничего не открывает.
  function claimRelayTicket(ticket) {
    const found = tickets.get(ticket);
    if (!found) return null;
    tickets.delete(ticket);
    return found.expiresAt > now().getTime() ? found : null;
  }

  // Каталог моделей разговора: чем можно говорить прямо сейчас. Осечку не
  // запоминаем — один неудачный запрос не должен гасить выбор до перезапуска;
  // удачный держим, потому что служба и так пересобирается от любой правки
  // настроек, и каталог вместе с ней.
  const catalogue = { openai: null, gemini: null };
  async function askCatalogue(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(url, { headers, signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function listModels(name) {
    if (catalogue[name]?.length) return catalogue[name];
    let found = [];
    if (name === 'gemini' && geminiApiKey) found = geminiVoiceModels(await askCatalogue(GEMINI_MODELS_URL, { 'x-goog-api-key': geminiApiKey }));
    if (name === 'openai' && apiKey) {
      const payload = await askCatalogue(OPENAI_MODELS_URL, { Authorization: `Bearer ${apiKey}` });
      found = openaiVoiceModels((Array.isArray(payload?.data) ? payload.data : []).map(entry => entry?.id));
    }
    if (found.length) catalogue[name] = found;
    return found;
  }
  // Выбранное не выпадает из списка, даже когда каталог его не назвал: иначе
  // настройка молча сменилась бы на первую строку списка.
  function withChosen(list, name, chosen) {
    const found = list.length ? list : VOICE_MODEL_FALLBACK[name];
    return !chosen || found.some(entry => entry.id === chosen) ? found : [modelChoice(chosen), ...found];
  }

  // Токен Gemini живёт до получаса и годен на одно подключение: браузеру
  // достаточно, а утёкший ничего не откроет.
  async function createGeminiSession(instructions, tools, turn) {
    const realtimeInputConfig = geminiRealtimeInput(turn);
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
            // Чуткость и паузы идут сюда же: поменять их в открытом сокете
            // Gemini не даёт.
            ...(realtimeInputConfig ? { realtimeInputConfig } : {}),
          },
        }),
      });
      if (!response.ok) return { mode: 'live', provider: 'gemini', error: 'unavailable', status: response.status };
      const payload = await response.json();
      const token = payload?.name || payload?.token?.name;
      if (!token) return { mode: 'live', provider: 'gemini', error: 'malformed_output' };
      // Наружу уходит билет, а не токен Google: сокет к Google держит сервер.
      // Браузер соединяется со своим же сайтом — поэтому голос работает там,
      // где Google не принимает соединения (закрывает 1007 «User location is
      // not supported»), и ключ не покидает сервер.
      return {
        mode: 'live',
        provider: 'gemini',
        clientSecret: issueRelayTicket({ token, model: geminiModel }),
        expiresAt: expireTime,
        model: geminiModel,
        voice: geminiVoice,
        url: RELAY_PATH,
        relay: true,
      };
    } catch (error) {
      return { mode: 'live', provider: 'gemini', error: error?.name === 'AbortError' ? 'timeout' : 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    claimRelayTicket,
    liveUrl,
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
    // Чем можно говорить: каталог провайдера, а не список в коде. Спрашивается
    // отдельно от status() — за ним ходят в сеть, а status отвечает на каждой
    // загрузке страницы.
    async models() {
      const [openai, gemini] = await Promise.all([listModels('openai'), listModels('gemini')]);
      return { openai: withChosen(openai, 'openai', model), gemini: withChosen(gemini, 'gemini', geminiModel) };
    },
    // Короткоживущий токен для браузера: сам ключ наружу не уходит.
    // Провайдера можно выбрать на один разговор; названный без ключа не
    // подменяется молча — приложение честно говорит, что его нет.
    // turn — очерёдность человека: как легко его перебить и сколько ждать тишины.
    async createSession({ instructions = VOICE_INSTRUCTIONS, tools = VOICE_TOOLS, provider: chosen = null, turn = {} } = {}) {
      if (chosen === 'openai' && !apiKey) return { mode: 'live', provider: 'openai', error: 'not_configured' };
      if (chosen === 'gemini' && !geminiApiKey) return { mode: 'live', provider: 'gemini', error: 'not_configured' };
      const wanted = chosen === 'openai' || chosen === 'gemini' ? chosen : provider;
      if (!wanted) return { mode: 'mock' };
      if (wanted === 'gemini') return createGeminiSession(instructions, tools, turn);
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
                input: openaiAudioInput(turn),
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
