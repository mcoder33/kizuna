import { normalizeTimeZone, userTimeZone, captureTimeContext } from './time-zone.js';
import { userLocale, requestLanguages, validLocaleSetting, validDetectedLocale } from './locale.js';
import { translate } from '../public/i18n.js';
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, createLedger, splitPartsOf, deleteCapture, restoreCapture, saveNote, NOTE_BODY_LIMIT, readSettings, writeSettings, recordUsage, usageSummary, attachmentsFor, addAttachment, findAttachment, removeAttachment, ATTACHMENT_SIZE_LIMIT, ATTACHMENTS_PER_CAPTURE, enqueueCaptureJob, cancelCaptureJob, retryCaptureJob, getCaptureJob, getAggregate, replaceInterpretation, completeProjection, undoProjectionCompletion, dayView, getDailyBrief, findDailyBrief, findDailyBriefSource, listEntries, undo, search, exportLedger, resetLedger, fullEntry } from './db.js';
import { createAiService } from './ai.js';
import { memoryPrompt, listFacts, rememberFact, forgetFact, MEMORY_TEXT_LIMIT, MEMORY_SUBJECT_LIMIT } from './memory.js';
import { journalOverview, listJournal } from './journal.js';
import { CaptureJobWorker } from './capture-job-worker.js';
import { scheduleFromModel, currentDate, normalizeClassification, gateClassification, shouldMaterializeProjections, parseCaptureOverrides, applyUserOverrides } from './classifier.js';
import { validateRemoteModel } from './cli-config.js';
import { createAccounts, publicUser } from './accounts.js';
import { periodReport, dayReport, shiftDate as reportShiftDate } from './reports.js';
import { doneView } from './done.js';
import { boardView, createColumn, renameColumn, colorColumn, moveColumn, deleteColumn, moveCard } from './board.js';
import { createCalendarService, CalendarSyncWorker } from './calendar.js';
import * as circles from './circles.js';
import { subtaskTree, ancestorsOf, todayIn, validDay, withSubtaskCounts, SUBTASK_TITLE_LIMIT } from './subtasks.js';
import { createSubtask } from './db.js';
import { AVATAR_IMAGE_LIMIT } from './avatars.js';
import * as chat from './chat.js';
import { registerNotesRoutes, afterCapture } from './notes-tree.js';
import { createTelegramService, TELEGRAM_API } from './telegram.js';
import QRCode from 'qrcode';
import { createSecretBox } from './secrets.js';
import { createReminderService, ReminderWorker, validRemindHour, REMIND_MAX_MINUTES } from './reminders.js';
import { createPushService } from './push.js';
import { NOTIFICATION_KINDS, DEFAULT_QUIET_HOURS, validNotifyPrefs, validQuietHours, notify, setNotificationSink, notificationPrefs, quietHoursOf, isQuiet, serializeNotification, listNotifications, notificationCounts, readNotifications, resolveNotifications, findNotification, snoozeNotification, wakeSnoozed, purgeNotifications, dismissNotifications, dismissStaleDigests, restoreNotifications, validMutedCalendars } from './notifications.js';
import { zonedToUtc } from './ics.js';
import { correctCapture } from './corrections.js';
import { activeNote, completeOccurrence, undoOccurrence, captureOwner, attachmentOwner, projectionOwner, undoGroupOwner, monthlySpend, findUserById, countUsers } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function validateTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); return timeZone; }
  catch { throw new Error('Invalid PAGENT_TIMEZONE configuration'); }
}
function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function validDate(value) { if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false; const [year,month,day]=value.split('-').map(Number),parsed=new Date(Date.UTC(year,month-1,day)); return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day; }
function memoryQuery(req) { const query=typeof req.body?.query==='string'?req.body.query.trim():''; if(!query||query.length>2000)return null; return query; }
function boundedMemorySources(query, results) { let remaining=Math.max(0,15000-query.length-40); const sources=[]; for(const result of results.slice(0,12)){const overhead=result.captureId.length+5;if(remaining<=overhead)break;const snippet=result.snippet.slice(0,Math.min(1250,remaining-overhead));if(!snippet)continue;sources.push({...result,snippet});remaining-=snippet.length+overhead;} return sources; }
const providerIds = new Set(['fallback','openai','openrouter','gemini','codex-cli','claude-cli']);
function requestedProvider(value) { return value === undefined ? undefined : typeof value === 'string' && providerIds.has(value) ? value : null; }
function requestedModel(value) { if (value === undefined || value === null || value === '') return undefined; try { return validateRemoteModel(value); } catch { return null; } }
function requestAbortSignal(req, res) { const controller = new AbortController(); const abort = () => { if (!res.writableEnded) controller.abort(); }; req.once('aborted', abort); res.once('close', abort); return { signal:controller.signal, dispose:() => { req.removeListener('aborted', abort); res.removeListener('close', abort); } }; }
function wantsAsyncResponse(preferHeader) { return typeof preferHeader === 'string' && preferHeader.split(',').some(value => value.trim().split(';', 1)[0].trim().toLowerCase() === 'respond-async'); }
function validIdempotencyKey(value) { return typeof value === 'string' && /^[A-Za-z0-9._~-]{8,128}$/.test(value); }
function validJobId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validProjectionId(value) { return validJobId(value); }
function completionError(res, error) { const errors={not_found:[404,'not_found','Проекция не найдена.'],invalid_occurrence:[400,'invalid_occurrence','Некорректный день повтора.'],not_repeating:[409,'not_repeating','У дела нет повтора.'],inactive:[409,'projection_inactive','Проекция больше не активна.'],not_completable:[409,'projection_not_completable','Завершать можно только задачи и встречи.']}; const [status,code,message]=errors[error]; return res.status(status).json({error:{code,message}}); }
function jobStatusUrl(jobId) { return `/api/jobs/${jobId}`; }
// Настройки приложения. Раньше всё это жило только в .env и правилось руками с
// перезапуском; здесь описано одним списком: как зовётся, как проверяется и
// секрет ли это. Секреты наружу не отдаются никогда — только признак «настроен»
// и последние четыре знака, чтобы человек узнал свой ключ.
// Область настройки. Ключи и провайдеры общие на всё приложение — платит за
// них один человек, и менять их может только администратор. Всё, что про
// привычки («засыпать через», «обращайся на ты», тема оформления), — своё у
// каждого: общие настройки такого рода означали бы, что сосед переписывает вам
// интерфейс.
const SETTINGS = {
  locale: { personal:true, check:validLocaleSetting },
  detectedLocale: { personal:true, check:validDetectedLocale },
  requestedTimeZone: { personal:true, check:value => value === 'system' || Boolean(normalizeTimeZone(value)) },
  detectedTimeZone: { personal:true, check:value => Boolean(normalizeTimeZone(value)) },
  openaiKey: { env:'OPENAI_API_KEY', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 400 },
  geminiKey: { env:'GEMINI_API_KEY', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 400 },
  openrouterKey: { env:'OPENROUTER_API_KEY', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 400 },
  // Google Calendar подключается через OAuth: нужен свой проект в Google Cloud
  // с клиентом «веб-приложение» и адресом возврата
  // <адрес Кизуны>/api/calendar/google/callback. Идентификатор не секрет, но
  // общий на всех, как и ключи моделей.
  googleClientId: { env:'PAGENT_GOOGLE_CLIENT_ID', admin:true, check:value => typeof value === 'string' && value.length <= 300 },
  googleClientSecret: { env:'PAGENT_GOOGLE_CLIENT_SECRET', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 300 },
  // Бот Telegram — второй вход в журнал (server/telegram.js). Токен выдаёт
  // @BotFather; бот один на всё приложение, а свой Telegram каждый привязывает
  // сам в настройках.
  telegramBotToken: { env:'PAGENT_TELEGRAM_BOT_TOKEN', secret:true, admin:true, check:value => typeof value === 'string' && /^\s*\d{5,20}:[A-Za-z0-9_-]{20,80}\s*$/.test(value) },
  aiProvider: { env:'PAGENT_AI_PROVIDER', admin:true, check:value => providerIds.has(value) },
  timeZone: { env:'PAGENT_TIMEZONE', admin:true, check:value => { try { new Intl.DateTimeFormat('en-CA', { timeZone:value }); return true; } catch { return false; } } },
  // Настройки интерфейса живут здесь же: они про человека, а не про вкладку,
  // поэтому переживают смену браузера.
  // Тема оформления. Хранится у человека, а не во вкладке: со сменой браузера
  // светлая тема не должна возвращаться сама.
  theme: { personal:true, check:value => ['system','light','dark'].includes(value) },
  // Напоминания: за сколько минут напоминать о деле со временем («off» —
  // не напоминать) и в какой час — о деле без времени.
  remindDefault: { personal:true, check:value => value === 'off' || (/^\d+$/.test(String(value)) && Number(value) <= REMIND_MAX_MINUTES) },
  remindHour: { personal:true, check:value => validRemindHour(String(value)) },
  // Уведомления: по какому поводу — за колокольчик, на телефон или никуда
  // (хранится только изменённое), и тихие часы, когда телефон молчит.
  notifyPrefs: { personal:true, check:value => typeof value === 'string' && value.length <= 2000 && validNotifyPrefs(value) },
  quietHours: { personal:true, check:value => typeof value === 'string' && validQuietHours(value) },
  notifyMutedCalendars: { personal:true, check:value => typeof value === 'string' && value.length <= 4000 && validMutedCalendars(value) },
  // Потолок расходов на месяц: считает всё, за что платят деньгами, — вызовы
  // модели, у которых провайдер назвал цену. Здесь — общий для всех; своё значение человеку ставит
  // администратор в разделе «Пользователи».
  monthlyLimitUsd: { admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e6 },
  // Разбор записи — извлечение полей по схеме: по умолчанию температура ноль,
  // бюджет ответа широкий (у «думающих» моделей часть его уходит на
  // рассуждение), рассуждение короткое. Модели разные, поэтому значения
  // вынесены сюда.
  modelTemperature: { env:'PAGENT_MODEL_TEMPERATURE', admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 2 },
  modelMaxTokens: { env:'PAGENT_MODEL_MAX_TOKENS', admin:true, check:value => /^\d+$/.test(String(value)) && Number(value) >= 256 && Number(value) <= 32000 },
  modelReasoning: { env:'PAGENT_MODEL_REASONING', admin:true, check:value => ['off','low','medium','high'].includes(value) },
};
const SETTING_DEFAULTS = { locale:'system', detectedLocale:null, requestedTimeZone:'system', detectedTimeZone:null, notifyPrefs:'{}', notifyMutedCalendars:'[]', quietHours:DEFAULT_QUIET_HOURS, remindDefault:'15', remindHour:'09:00', theme:'system', monthlyLimitUsd:'', modelTemperature:'0', modelMaxTokens:'6000', modelReasoning:'low' };
// Личная настройка лежит под своим ключом: у каждого своя строчка, общая
// таблица одна.
const personalKey = (userId, name) => `user:${userId}:${name}`;
function settingValue(stored, env, name, userId) {
  const rule = SETTINGS[name];
  const own = rule.personal && userId ? stored[personalKey(userId, name)] : undefined;
  return own ?? stored[name] ?? (rule.env ? env[rule.env] : undefined) ?? SETTING_DEFAULTS[name] ?? null;
}
function secretHint(value) { return value ? `••••${String(value).slice(-4)}` : null; }
// То, что уходит в браузер: значения без секретов и «настроен» вместо ключа.
function publicSettings(stored, env, user = null) {
  const out = {};
  for (const [name, rule] of Object.entries(SETTINGS)) {
    const value = settingValue(stored, env, name, user?.id);
    if (rule.secret) out[name] = { configured: Boolean(value), hint: secretHint(value), fromEnvironment: !stored[name] && Boolean(rule.env && env[rule.env]) };
    else out[name] = value;
  }
  return out;
}
// Что из настроек человек вправе менять: общее — только администратор, своё —
// каждый сам. Список отдаётся в браузер, чтобы интерфейс не показывал полей,
// которые всё равно вернут отказ.
function editableSettings(user) { return Object.entries(SETTINGS).filter(([, rule]) => rule.personal || user?.role === 'admin').map(([name]) => name); }
// Окружение для служб: настройки поверх .env. Ключ, введённый в приложении,
// сильнее того, что лежит в файле, — иначе правка в интерфейсе не работала бы.
function environmentWith(stored, env) {
  const merged = { ...env };
  for (const [name, rule] of Object.entries(SETTINGS)) {
    if (!rule.env) continue;
    if (stored[name] !== undefined) merged[rule.env] = stored[name];
  }
  return merged;
}
// Что показываем прямо в браузере, а что отдаём файлом. Всё, чего нет в этом
// списке, уходит как поток байтов с Content-Disposition: attachment — браузер
// такой ответ не выполнит и не покажет как страницу.
const INLINE_TYPES = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/heic','application/pdf','text/plain','text/markdown']);
const ATTACHMENT_TYPES = new Set([...INLINE_TYPES, 'application/zip','application/json','text/csv','audio/mpeg','audio/wav','audio/ogg','video/mp4','application/octet-stream']);
// Имя приходит от человека: оставляем только базовую часть без путей и
// управляющих символов, а на диске файл всё равно называется своим id.
function safeFilename(value) {
  const raw = typeof value === 'string' ? value : '';
  const base = path.basename(raw.replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : 'файл';
}
function validAttachmentId(value) { return validJobId(value); }
function captureRequestFingerprint({ raw, occurredAt, selectedProvider, selectedModel = null, overrides = null }) { return crypto.createHash('sha256').update(JSON.stringify({ raw, occurredAt:typeof occurredAt === 'string' ? occurredAt : null, selectedProvider, selectedModel, overrides })).digest('hex'); }
function reportAudit(audit, event) { try { audit(event); } catch {} }
// Расход записывается рядом с ответом модели и никогда не мешает делу: сбой
// учёта не должен ронять разбор записи.
function noteUsage(db, result, kind, userId = null) {
  try {
    if (!result?.usage || !result.usedProvider || result.usedProvider === 'fallback') return;
    recordUsage(db, { provider:result.usedProvider, model:result.model || null, kind, inputTokens:result.usage.inputTokens, outputTokens:result.usage.outputTokens, costUsd:result.usage.costUsd, userId });
  } catch {}
}
// Уточнение из карточки. Правила — в server/corrections.js.
function applyCorrection(db,req,res,next,notify=()=>{},timeZone='Europe/Samara'){try{const body=req.body||{},patch=body.patch||body,providedKey=req.get('Idempotency-Key');if(providedKey!==undefined&&!validIdempotencyKey(providedKey))return res.status(400).json({error:{code:'invalid_idempotency_key',message:'Некорректный ключ идемпотентности.'}});const result=correctCapture(db,{captureId:req.params.id,userId:req.user?.id??null,patch,operationKey:providedKey||null,timeZone});if(result.error)return res.status(result.error.status).json({error:{code:result.error.code,message:result.error.message}});notify();res.json({entry:result.entry,undoGroupId:result.undoGroupId,review:result.review,replayed:result.replayed});}catch(error){next(error);}}
async function snapshotProvider(ai, requested) { if (requested) return requested; const status = await ai.status(); return providerIds.has(status?.selectedProvider) ? status.selectedProvider : providerIds.has(status?.defaultProvider) ? status.defaultProvider : 'fallback'; }
export function createApp({ databasePath = process.env.PAGENT_DB_PATH || path.join(__dirname, '..', 'data', 'pagent.sqlite'), aiService, timeZone = process.env.PAGENT_TIMEZONE || 'Europe/Samara', now = () => new Date(), workerOptions, audit = () => {}, secureCookies = process.env.PAGENT_SECURE_COOKIES === 'on', calendarService = null, calendarFetch = globalThis.fetch, calendarWorkerOptions = {}, calendarKey = null, pushTransport = null, reminderWorkerOptions = {}, telegramFetch = globalThis.fetch, telegramOptions = {} } = {}) {
  const db = openDatabase(databasePath);
  const requestText = (req, source, params = {}) => translate(userLocale(db, req.user?.id, requestLanguages(req.get('accept-language'))), source, params);
  const accounts = createAccounts({ db, now, secureCookies, audit, timeZone: () => configuredTimeZone });
  // Настройки читаются из базы поверх окружения: то, что человек поменял в
  // приложении, сильнее того, что лежит в .env, и применяется без перезапуска.
  let stored = readSettings(db);
  const environment = () => environmentWith(stored, process.env);
  let configuredTimeZone = validateTimeZone(stored.timeZone || timeZone);
  const timeZoneFor = userId => userTimeZone(db, userId, configuredTimeZone);
  const requestTimeZone = req => timeZoneFor(req.user?.id);
  const timeContextFor = userId => captureTimeContext(timeZoneFor(userId), now());
  // Файлы вложений лежат рядом с базой: те же данные, тот же локальный каталог.
  const attachmentsDirectory = path.join(path.dirname(databasePath), 'attachments');
  fs.mkdirSync(attachmentsDirectory, { recursive: true });
  const attachmentPath = attachmentId => path.join(attachmentsDirectory, attachmentId);
  let ai = aiService || createAiService({ timeZone:configuredTimeZone, now, env:environment() });
  const app = express();
  // Живое обновление журнала: страница подписывается на поток и перерисовывает
  // карточки сама. Без этого запись, сделанную голосом или дочитанную разбором
  // в фоне, приходилось ждать до перезагрузки страницы.
  const journalListeners = new Set();
  const notifyJournal = (reason) => {
    const line = `event: journal\ndata: ${JSON.stringify({ reason, at: now().toISOString() })}\n\n`;
    for (const listener of journalListeners) { try { listener.write(line); } catch {} }
    // Любое изменение журнала — повод свериться с внешним календарём: новое
    // дело со сроком, перенос, «сделано», удаление. Сам календарь себя не будит.
    if (reason !== 'calendar' && reason !== 'queued') { try { calendar.wakeAutoExport?.(); } catch {} }
  };
  // Личное сообщение в открытые вкладки одного человека: напоминание не
  // должно всплыть у соседа по серверу.
  const notifyUser = (userId, event, payload) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const listener of journalListeners) { if (listener.userId === userId) { try { listener.write(line); } catch {} } }
  };
  // Новость об общем деле касается двоих: автора записи и того, кому она
  // ушла. Остальным участникам круга знать о каждом чекбоксе незачем.
  const notifyCircleMembers = (circleId) => {
    for (const member of circles.membersOf(db, circleId)) notifyUser(member.id, 'journal', { reason:'circle', at: now().toISOString() });
  };
  const notifyCircle = (captureId, extra = []) => {
    const owner = captureOwner(db, captureId);
    const assignment = circles.assignmentFor(db, captureId);
    const who = new Set([owner, assignment?.assignee?.id, assignment?.assigner?.id, ...extra].filter(Boolean));
    for (const userId of who) notifyUser(userId, 'journal', { reason:'circle', at: now().toISOString() });
  };
  // Разбор заканчивается в воркере, а не в запросе: там журнал и меняется.
  // Запись из Telegram ждёт итога там же: ответ «ИИ разбирает…» правится.
  let telegram = null;
  const workerAudit = (event) => { try { audit(event); } finally { if (event?.event === 'capture_job_succeeded' || event?.event === 'capture_job_failed') { notifyJournal('job'); telegram?.answer(event.jobId).catch(() => {}); } } };
  const captureJobWorker = new CaptureJobWorker({ db, ai, now, audit: workerAudit, timeZone: () => configuredTimeZone, timeZoneFor, ...workerOptions });
  // Смена ключа или пояса пересобирает службы на месте: перезапускать
  // сервер ради строчки в настройках человек не должен.
  function rebuildServices() {
    stored = readSettings(db);
    const env = environment();
    try { configuredTimeZone = validateTimeZone(stored.timeZone || timeZone); } catch {}
    if (!aiService) ai = createAiService({ timeZone:configuredTimeZone, now, env });
    captureJobWorker.ai = ai;
    telegram?.reconfigure();
  }
  app.captureJobWorker = captureJobWorker;
  // Внешние календари: учётные данные шифруются ключом рядом с базой, а
  // настройки Google читаются на каждый вызов — ключ, введённый в приложении,
  // должен работать без перезапуска, как и ключи моделей.
  const secrets = createSecretBox({ keyPath: path.join(path.dirname(databasePath), 'calendar.key'), key: calendarKey });
  const calendar = calendarService || createCalendarService({ db, secrets, now, timeZone: timeZoneFor, legacyTimeZone: () => configuredTimeZone, audit, fetch: calendarFetch, onChange: () => notifyJournal('calendar'), autoExportDelayMs: calendarWorkerOptions.autoExportDelayMs, googleConfig: () => { const env = environment(); return { clientId: env.PAGENT_GOOGLE_CLIENT_ID || null, clientSecret: env.PAGENT_GOOGLE_CLIENT_SECRET || null }; } });
  const calendarSyncWorker = new CalendarSyncWorker({ service: calendar, audit, ...calendarWorkerOptions });
  app.calendar = calendar;
  app.calendarSyncWorker = calendarSyncWorker;
  // Напоминания: доставка — в открытые вкладки потоком и на устройства
  // push-ем; что и когда — считает служба напоминаний по настройкам человека.
  const push = createPushService({ db, now, audit, ...(pushTransport ? { transport: pushTransport } : {}), subject: process.env.PAGENT_PUSH_SUBJECT || (process.env.PAGENT_PUBLIC_URL && /^https:/.test(process.env.PAGENT_PUBLIC_URL) ? process.env.PAGENT_PUBLIC_URL : 'mailto:kizuna@example.com') });
  const reminders = createReminderService({ db, now, audit, timeZone: timeZoneFor,
    settingsFor: userId => { const env = environment(); return { minutes: settingValue(stored, env, 'remindDefault', userId), hour: settingValue(stored, env, 'remindHour', userId) }; },
    // Напоминание — такой же повод, как остальные: строка за колокольчиком и
    // доставка по общим правилам. Push у него прежний — заголовок записи и
    // ссылка на её карточку.
    deliver: async ({ userId, reminder }) => {
      const row = notify(db, reminderNotification(userId, reminder));
      if (row) await deliveries.get(row.id);
    } });
  // Обход раз в полминуты общий: напоминания, отложенные уведомления, чистка
  // ленты, утренняя сводка и пороги расходов.
  const reminderWorker = new ReminderWorker({ service: { tick: async () => { const sent = await reminders.tick(); await notificationTick(); return sent; } }, audit, ...reminderWorkerOptions });

  // ── уведомления ──
  // Строка ленты уже сохранена; здесь решается, как о ней сказать. В открытые
  // вкладки — событием потока: браузер покажет всплывашку, если повод из тех,
  // что идут на телефон. На телефон — push, только если вкладок нет и сейчас
  // не тихие часы: у экрана человек и так всё увидит.
  const deliveries = new Map();
  const notificationView = (row, locale = userLocale(db, row.user_id)) => {
    const view = serializeNotification(row, locale, {timeZone:timeZoneFor(row.user_id),at:now()});
    return { ...view, actors: view.actorIds.map(id => findUserById(db, id)).filter(Boolean).map(user => circles.publicUser(user)) };
  };
  const notificationUrl = view => view.data.url
    || (view.captureId ? `/#today?open=${view.captureId}` : view.roomId ? `/#circles?room=${view.roomId}` : view.circleId ? '/#circles'
      : ['invite', 'event_added', 'event_changed'].includes(view.kind) ? `/#calendar${view.data.date ? `?date=${view.data.date}${view.eventUid ? `&event=${encodeURIComponent(view.eventUid)}` : ''}` : ''}`
      : view.kind === 'signup' ? '/#admin' : ['spend', 'calendar_error'].includes(view.kind) ? '/#settings' : '/#today');
  const pushOf = view => {
    const who = view.actors.length ? view.actors.map(person => person.name).join(' и ') : view.lead || '';
    return { kind: view.kind, title: view.data.pushTitle || [who, view.text].filter(Boolean).join(' '), body: view.data.pushBody || view.meta.join(' · '), tag: `${view.kind}:${view.id}`, url: notificationUrl(view) };
  };
  setNotificationSink(db, (row, { merged }) => {
    const prefs = notificationPrefs(db, row.user_id)[row.kind];
    const view = notificationView(row);
    notifyUser(row.user_id, 'notification', { notification: view, counts: notificationCounts(db, row.user_id), toast: prefs.phone && !merged });
    const listening = [...journalListeners].some(listener => listener.userId === row.user_id);
    if (!prefs.phone || merged || listening || isQuiet(quietHoursOf(db, row.user_id), now(), timeZoneFor(row.user_id))) return;
    const sending = push.send(row.user_id, pushOf(view)).catch(() => {}).finally(() => deliveries.delete(row.id));
    deliveries.set(row.id, sending);
  });
  app.notificationsDelivered = () => Promise.all([...deliveries.values()]);
  const capitalized = value => (value ? value[0].toUpperCase() + value.slice(1) : value);
  function reminderNotification(userId, reminder) {
    const raw = db.prepare('SELECT raw FROM captures WHERE id=?').get(reminder.captureId)?.raw || '';
    const meeting = reminder.type === 'meeting_event';
    const locale = userLocale(db, userId);
    const leadSource = reminder.leadMinutes === null ? 'Срок сегодня' : reminder.leadMinutes === 0 ? 'Сейчас' : 'Через {count} мин';
    const startAt = reminder.time ? zonedToUtc({ year: Number(reminder.date.slice(0, 4)), month: Number(reminder.date.slice(5, 7)), day: Number(reminder.date.slice(8, 10)), hour: Number(reminder.time.slice(0, 2)), minute: Number(reminder.time.slice(3, 5)) }, timeZoneFor(userId)).toISOString() : null;
    return { userId, kind: 'reminder', captureId: reminder.captureId, lead: capitalized(reminder.lead) || translate(locale, 'Срок сегодня'), template: { lead: { source: leadSource, params: {count:reminder.leadMinutes} } }, text: `— «${reminder.title}»`, meta: [reminder.when, translate(locale, meeting ? 'встреча' : 'дело')],
      data: { reminderSchedule: {date:reminder.date,time:reminder.time,end:reminder.end,daySource:reminder.daySource,meeting,leadMinutes:reminder.leadMinutes}, startAt, date: reminder.date, joinUrl: meeting ? (raw.match(/https:\/\/[^\s)>\]»"]+/) || [null])[0] : null, pushTitle: reminder.title, pushBody: reminder.body, url: `/#today?open=${reminder.captureId}` } };
  }
  // Отложенное напоминание возвращается с честным «через сколько»: за десять
  // минут «через 15 минут» превратилось бы в неправду.
  function refreshSnoozed(row) {
    const data = JSON.parse(row.data_json || '{}');
    if (row.kind !== 'reminder' || !data.startAt) return row;
    const minutes = Math.round((Date.parse(data.startAt) - now().getTime()) / 60000);
    const source = minutes > 0 ? 'Через {count} мин' : minutes === 0 ? 'Сейчас' : 'Уже началось';
    const template = { ...data.template, lead: { source, params: {count:minutes} } };
    return { ...row, lead: translate(userLocale(db,row.user_id), source, {count:minutes}), data_json: JSON.stringify({...data,template}) };
  }
  const plural = (count, one, few, many) => { const mod10 = count % 10, mod100 = count % 100; return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many; };
  const clockIn = (at, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  // Утренняя сводка — в час напоминаний о делах без времени (09:00 по
  // умолчанию), одна на день и только если есть что сказать. Проспал сервер
  // утро — сводка догоняет до обеда, вечером она уже не утренняя.
  const digestTried = new Map();
  function morningDigest(user, at) {
    const date = dateInTimeZone(at, timeZoneFor(user.id));
    const setting = settingValue(stored, process.env, 'remindHour', user.id);
    const hour = setting && setting !== 'off' && validRemindHour(setting) ? setting : '09:00';
    const clock = clockIn(at, timeZoneFor(user.id));
    const until = `${String(Math.min(23, Number(hour.slice(0, 2)) + 4)).padStart(2, '0')}${hour.slice(2)}`;
    if (clock < hour || clock >= until) return;
    if (db.prepare('SELECT 1 FROM notifications WHERE user_id=? AND group_key=?').get(user.id, `digest:${date}`)) return;
    // Сказать было нечего — следующая попытка через десять минут, а не на каждом
    // обходе: за утро в журнале может что-то появиться, но не каждые полминуты.
    if (at.getTime() - (digestTried.get(user.id) || 0) < 10 * 60 * 1000) return;
    digestTried.set(user.id, at.getTime());
    const overview = journalOverview(db, { userId: user.id, now: at, timeZone: timeZoneFor(user.id) });
    const own = overview.horizon.today;
    const meetingsOwn = own.filter(item => item.type === 'встреча').length;
    const deeds = own.length - meetingsOwn;
    let external = 0;
    try { const view = calendar.view({ userId: user.id, from: date, to: date }); external = (view.external || []).filter(item => item.me?.status !== 'declined').length; } catch {}
    const meetings = meetingsOwn + external;
    const waits = db.prepare('SELECT * FROM notifications WHERE user_id=? AND waits=1 AND resolved_at IS NULL ORDER BY created_at').all(user.id);
    const calls = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND kind='call' AND read_at IS NULL").get(user.id).n;
    const overdue = overview.totals.overdue;
    if (!meetings && !deeds && !overdue && !waits.length && !calls) return;
    const today = [meetings ? `${meetings} ${plural(meetings, 'встреча', 'встречи', 'встреч')}` : null, deeds ? `${deeds} ${plural(deeds, 'дело', 'дела', 'дел')} на сегодня` : null].filter(Boolean).join(' и ') || 'на сегодня ничего не назначено';
    const firstWait = waits[0] ? notificationView(waits[0], 'ru') : null;
    const lines = [
      overdue ? (overdue === 1 ? 'Одно дело просрочено.' : `${overdue} ${plural(overdue, 'дело', 'дела', 'дел')} просрочено.`) : null,
      firstWait ? (waits.length === 1
        ? (firstWait.kind === 'invite' ? `${firstWait.lead} ждёт ответа на приглашение ${firstWait.text.replace(/^зовёт на встречу /, '')}.` : `${firstWait.actors[0]?.name || 'Кто-то'} ждёт ответа: ${firstWait.text.replace(/^просит: /, '')}.`)
        : `Ждут вашего ответа: ${waits.length}.`) : null,
      calls ? `${calls} ${plural(calls, 'призыв', 'призыва', 'призывов')} без ответа.` : null,
    ].filter(Boolean);
    notify(db, { userId: user.id, kind: 'digest', lead: 'Доброе утро:', template: { lead: { source: 'Доброе утро:' } }, text: today, meta: lines, data: { date, digest: {meetings,deeds,overdue,waits:waits.length,calls,firstWait:firstWait ? {invite:firstWait.kind === 'invite',person:firstWait.kind === 'invite' ? firstWait.lead : firstWait.actors[0]?.name || null,title:firstWait.text.replace(/^(?:зовёт на встречу |просит: )/, '')} : null}, pushTitle: `Доброе утро: ${today}`, pushBody: lines.join(' ') || 'Хорошего дня.', url: '/#today' }, group: `digest:${date}`, once: true, at: at.toISOString() });
  }
  // Потолок расходов: одно уведомление на порог в месяц — на 80% и на 100%.
  function spendThresholds(user) {
    const state = spendState(user);
    if (!state.limitUsd) return;
    const share = state.totalUsd / state.limitUsd * 100;
    const month = dateInTimeZone(now(), configuredTimeZone).slice(0, 7);
    const money = value => `$${value < 10 ? value.toFixed(2) : Math.round(value)}`;
    for (const threshold of [100, 80]) {
      if (share < threshold) continue;
      notify(db, { userId: user.id, kind: 'spend', lead: `Потрачено ${threshold}%`, template: {lead:{source:'Потрачено {count}%',params:{count:threshold}}}, textTemplate:{source:threshold === 100 ? 'месячного потолка — дальше записи разбираются по правилам' : 'месячного потолка на модели'}, metaTemplates:[{source:'{spent} из {limit}',params:{spent:money(state.totalUsd),limit:money(state.limitUsd)}}], text: threshold === 100 ? 'месячного потолка — дальше записи разбираются по правилам' : 'месячного потолка на модели', meta: [`${money(state.totalUsd)} из ${money(state.limitUsd)}`], group: `spend:${month}:${threshold}`, once: true });
      break;
    }
  }
  async function notificationTick() {
    const at = now();
    try { wakeSnoozed(db, at, refreshSnoozed); } catch {}
    try { purgeNotifications(db, at); } catch {}
    // Сводка живёт свой день: с новым утром вчерашняя уходит из ленты сама.

    for (const user of db.prepare("SELECT * FROM users WHERE status='active'").all()) {
      try { dismissStaleDigests(db, dateInTimeZone(at, timeZoneFor(user.id)), at.toISOString(), user.id); } catch {}
      try { morningDigest(user, at); } catch {}
      try { spendThresholds(user); } catch {}
    }
    await Promise.all([...deliveries.values()]);
  }
  app.notificationTick = notificationTick;
  app.push = push; app.reminders = reminders; app.reminderWorker = reminderWorker;
  // Внутренние ручки для тестов и для запуска: наружу по HTTP они не выходят.
  app.accounts = accounts;
  app.database = db;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = payload => {
      if (payload?.error && typeof payload.error.message === 'string') {
        const locale = userLocale(db, req.user?.id, requestLanguages(req.get('accept-language')));
        payload = { ...payload, error: { ...payload.error, message: translate(locale, payload.error.message) } };
      }
      return sendJson(payload);
    };
    next();
  });
  app.use(express.json({ limit:'32kb' }));
  // Кто перед нами — выясняется до всего остального, но никого не заворачивает:
  // страница входа и заявка на регистрацию должны работать без учётной записи.
  app.use(accounts.attachUser);
  app.use((req,res,next)=>{ if(req.path==='/'||req.path.startsWith('/api/')||req.path.startsWith('/public/')) res.set({'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}); next(); });
  accounts.registerRoutes(app);
  // Отсюда и ниже — только для вошедших. Граница одна и видна глазом: любой
  // маршрут, добавленный после этой строки, закрыт по умолчанию.
  app.use('/api', accounts.requireAuth);
  // Чужой идентификатор в адресе не должен открывать чужую запись: владельца
  // спрашиваем у базы, а не у клиента.
  // Хозяин задания нужен серверу для проверки, но наружу не уходит: ответ о
  // задаче не должен рассказывать ничего сверх её состояния.
  const publicJob = ({ userId, ...rest }) => rest;
  const ownsCapture = (req,res,captureId) => { const owner=captureOwner(db,captureId); if(owner===undefined||owner!==req.user.id){res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});return false;} return true; };
  // Читать запись может и участник круга, куда её отдали: правит её по-прежнему
  // только автор. Ответ на чужое остаётся «не найдено» — существование чужой
  // записи тоже не наше дело.
  const seesCapture = (req,res,captureId) => { if(circles.canSeeCapture(db,captureId,req.user.id))return true; res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}}); return false; };
  // Карточка записи со всем, что появилось вместе с кругами: круг, исполнитель,
  // обсуждение и те, кого в нём можно призвать.
  const sharedEntry = (captureId, userId) => ({
    circles: circles.circlesForCapture(db, captureId),
    assignment: circles.assignmentFor(db, captureId),
    comments: circles.comments(db, captureId, userId),
    callable: circles.callableFor(db, captureId, userId),
    participants: circles.captureParticipants(db, captureId),
    author: (() => { const owner = captureOwner(db, captureId); const user = owner && findUserById(db, owner); return user ? circles.publicUser(user) : null; })(),
    myCircles: circles.circlesOf(db, userId),
    mine: captureOwner(db, captureId) === userId,
  });
  // Заметки как страницы: дерево, ссылки, базы и дела из строк заметки
  // (server/notes-tree.js). Дело из строки ставится в ту же очередь разбора,
  // что и запись с «Сегодня», и под тем же потолком расходов.
  registerNotesRoutes(app, { db, notifyJournal, queueCapture: async (user, raw, overrides) => {
    const gate = await spendGate(user, undefined);
    const selectedProvider = await snapshotProvider(ai, gate.provider);
    const queued = enqueueCaptureJob(db, { userId: user.id, raw, selectedProvider, selectedModel: null, overrides: { ...overrides, timeContext: timeContextFor(user.id) }, origin: 'notes' });
    captureJobWorker.wake();
    return queued;
  } });
  // ── Telegram ──
  // Бот — второй вход в журнал (server/telegram.js). Всё, что касается
  // журнала, служба делает через эти крючки — теми же шагами, что запись с
  // главной: очередь разбора под потолком расходов, место и ссылки заметки,
  // вложения, живое обновление вкладок.
  telegram = createTelegramService({
    db, now, audit,
    token: () => environment().PAGENT_TELEGRAM_BOT_TOKEN || null,
    apiBase: () => process.env.PAGENT_TELEGRAM_API_BASE || TELEGRAM_API,
    fetch: telegramFetch,
    timeZone: timeZoneFor,
    userActive: userId => findUserById(db, userId)?.status === 'active',
    queueCapture: async ({ userId, raw, occurredAt, origin }) => {
      const user = findUserById(db, userId);
      if (!user || user.status !== 'active') return { error: 'inactive' };
      const gate = await spendGate(user, undefined);
      const selectedProvider = await snapshotProvider(ai, gate.provider);
      const queued = enqueueCaptureJob(db, { userId, raw, occurredAt, selectedProvider, selectedModel: null, overrides: {timeContext:timeContextFor(userId)}, origin });
      // Как у записи с главной: «в Страница: …» и [[ссылки]] раскладываются
      // сразу, не дожидаясь разбора.
      try { afterCapture(db, { captureId: queued.captureId, userId }); } catch {}
      captureJobWorker.wake();
      notifyJournal('queued');
      const duplicate = db.prepare('SELECT id FROM captures WHERE deleted_at IS NULL AND user_id IS ? AND raw=? AND id!=? AND created_at>=? ORDER BY created_at DESC LIMIT 1').get(userId, raw, queued.captureId, new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString());
      return { ...queued, duplicate: Boolean(duplicate), spent: !gate.budget.allowed };
    },
    attach: ({ captureId, filename, contentType, bytes }) => {
      const saved = addAttachment(db, captureId, { filename: safeFilename(filename), contentType: ATTACHMENT_TYPES.has(contentType) ? contentType : 'application/octet-stream', bytes });
      if (saved.notFound || saved.tooMany) return false;
      fs.writeFileSync(attachmentPath(saved.id), bytes, { mode: 0o600 });
      reportAudit(audit, { event: 'attachment_added', result: 'succeeded' });
      notifyJournal('attachment');
      return true;
    },
    // Итог разбора для ответа в Telegram — то же, что видно на главной после
    // записи: тип, срок, отделённые дела, вопрос модели.
    describe: ({ captureId, jobId }) => {
      const job = getCaptureJob(db, jobId);
      if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.state)) return null;
      const capture = db.prepare('SELECT deleted_at FROM captures WHERE id=?').get(captureId);
      if (!capture || capture.deleted_at) return { state: job.state, captureGone: true };
      const row = getAggregate(db, captureId);
      return { state: job.state, classification: row ? JSON.parse(row.classification_json) : null, parts: job.state === 'succeeded' ? splitPartsOf(db, captureId) : [] };
    },
    onLink: userId => notifyUser(userId, 'telegram', { at: now().toISOString() }),
    ...telegramOptions,
  });
  app.telegram = telegram;
  const telegramErrors = {
    telegram_off: [409, 'Бот Telegram не подключён: администратор добавляет его токен в «Ключах».'],
    telegram_unavailable: [503, 'Бот Telegram сейчас не на связи — попробуйте чуть позже.'],
  };
  // Что видно в настройках: бот и своя привязка. Причину сбоя бота видит
  // только администратор — остальным она ничего не даст.
  const telegramView = user => {
    const bot = telegram.status();
    return { bot: { ...bot, error: user.role === 'admin' ? bot.error : bot.error ? 'Бот сейчас не на связи.' : null }, link: telegram.linkOf(user.id), canSetup: user.role === 'admin' };
  };
  app.get('/api/telegram', (req, res) => res.json(telegramView(req.user)));
  app.post('/api/telegram/link', async (req, res, next) => {
    try {
      // Адрес Кизуны запоминается вместе с кодом: по нему бот потом ведёт
      // кнопкой «Открыть в Кизуне» к записи.
      const base = (process.env.PAGENT_PUBLIC_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`).replace(/\/+$/, '');
      const result = await telegram.createLink(req.user.id, base);
      if (result.error) { const [status, message] = telegramErrors[result.error]; return res.status(status).json({ error: { code: result.error, message } }); }
      const qr = await QRCode.toString(result.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).catch(() => null);
      res.status(201).json({ ...telegramView(req.user), url: result.url, expiresAt: result.expiresAt, qr: qr ? `data:image/svg+xml;base64,${Buffer.from(qr).toString('base64')}` : null });
    } catch (error) { next(error); }
  });
  app.delete('/api/telegram/link', (req, res) => {
    telegram.unlink(req.user.id);
    res.json(telegramView(req.user));
  });
  app.get('/api/events',(req,res)=>{
    res.set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-store', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
    res.flushHeaders?.();
    // Первое сообщение сразу: клиент понимает, что поток жив, и не ждёт таймаута.
    res.write(`event: ready\ndata: ${JSON.stringify({ at: now().toISOString() })}\n\n`);
    res.userId = req.user?.id || null;
    journalListeners.add(res);
    // Комментарий раз в 25 секунд держит соединение открытым через прокси.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    beat.unref?.();
    const drop = () => { clearInterval(beat); journalListeners.delete(res); };
    req.on('close', drop);
    res.on('close', drop);
  });
  // При выключении потоки закрываются сами: открытый ответ не даёт
  // server.close завершиться, а EventSource в браузере переподключится.
  app.closeEventStreams = () => {
    const count = journalListeners.size;
    for (const listener of [...journalListeners]) { try { listener.write('event: bye\ndata: {}\n\n'); listener.end(); } catch {} }
    journalListeners.clear();
    return count;
  };
  // ── напоминания и push ──
  app.get('/api/reminders/upcoming',(req,res)=>{ res.json({ reminders: reminders.upcoming(req.user.id, { limit: 20, locale:userLocale(db, req.user.id, requestLanguages(req.get('accept-language'))) }) }); });
  // ── лента уведомлений ──
  // Ждущее ответа сверяется с самим делом при каждом чтении: просьбу могли
  // снять, на приглашение — ответить в самом календаре.
  const stillWaits = row => {
    if (row.kind === 'request') return Boolean(db.prepare("SELECT 1 FROM assignments WHERE id=? AND state='pending' AND cancelled_at IS NULL").get(row.assignment_id));
    if (row.kind === 'invite') return calendar.inviteStatus?.({ accountId: row.account_id, uid: row.event_uid }) === 'needs-action';
    return true;
  };
  const countsChanged = userId => notifyUser(userId, 'notifications', { counts: notificationCounts(db, userId) });
  app.get('/api/notifications',(req,res,next)=>{try{
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null;
    const page = listNotifications(db, req.user.id, { before, stillWaits });
    res.json({ notifications: page.notifications.map(row => notificationView(row, userLocale(db, req.user.id, requestLanguages(req.get('accept-language'))))), nextCursor: page.nextCursor, counts: notificationCounts(db, req.user.id),
      kinds: Object.entries(NOTIFICATION_KINDS).filter(([, rule]) => !rule.admin || req.user.role === 'admin').map(([key, rule]) => ({ key, group: rule.group, label: rule.label, hint: rule.hint, default: rule.phone ? 'phone' : rule.bell ? 'bell' : 'off' })) });
  }catch(error){next(error);}});
  // Прочитано: списком, всё сразу или всё, что касается записи или комнаты, —
  // открыл карточку или разговор, значит прочитал.
  app.post('/api/notifications/read',(req,res,next)=>{try{
    const body = req.body || {};
    const options = Array.isArray(body.ids) ? { ids: body.ids } : typeof body.captureId === 'string' ? { captureId: body.captureId } : typeof body.roomId === 'string' ? { roomId: body.roomId } : body.all === true ? {} : null;
    if (!options) return res.status(400).json({ error: { code: 'invalid_read', message: 'Что отметить прочитанным: ids, captureId, roomId или all.' } });
    const changed = readNotifications(db, req.user.id, options);
    if (changed) countsChanged(req.user.id);
    res.json({ changed, counts: notificationCounts(db, req.user.id) });
  }catch(error){next(error);}});
  // Убрать из ленты: открытое, ненужное или всё разом («Очистить»). Ждущее
  // ответа не уходит. «Вернуть» кладёт убранное обратно.
  app.post('/api/notifications/dismiss',(req,res,next)=>{try{
    const body = req.body || {};
    const options = Array.isArray(body.ids) ? { ids: body.ids } : body.all === true ? { all: true } : null;
    if (!options) return res.status(400).json({ error: { code: 'invalid_dismiss', message: 'Что убрать: ids или all.' } });
    const dismissed = dismissNotifications(db, req.user.id, options).map(row => row.id);
    if (dismissed.length) countsChanged(req.user.id);
    res.json({ dismissed, counts: notificationCounts(db, req.user.id) });
  }catch(error){next(error);}});
  app.post('/api/notifications/restore',(req,res,next)=>{try{
    if (!Array.isArray(req.body?.ids)) return res.status(400).json({ error: { code: 'invalid_restore', message: 'Что вернуть: ids.' } });
    const restored = restoreNotifications(db, req.user.id, req.body.ids);
    if (restored) countsChanged(req.user.id);
    res.json({ restored, counts: notificationCounts(db, req.user.id) });
  }catch(error){next(error);}});
  app.post('/api/notifications/:id/snooze',(req,res,next)=>{try{
    // Без minutes срок выбирает сервер: полчаса, потом вдвое дольше.
    const minutes = req.body?.minutes === undefined || req.body?.minutes === null ? undefined : Number(req.body.minutes);
    const result = snoozeNotification(db, req.user.id, req.params.id, minutes, now());
    if (result.error === 'not_found') return res.status(404).json({ error: { code: 'not_found', message: 'Уведомление не найдено.' } });
    if (result.error) return res.status(400).json({ error: { code: result.error, message: 'Отложить можно на срок от минуты до суток.' } });
    countsChanged(req.user.id);
    res.json({ ...result, counts: notificationCounts(db, req.user.id) });
  }catch(error){next(error);}});
  // Ответ на приглашение прямо из строки. Событие в кэше календаря
  // переписывается при каждой синхронизации, поэтому оно ищется заново — по
  // учётной записи и UID, а не по идентификатору, который был при уведомлении.
  app.post('/api/notifications/:id/respond',async(req,res,next)=>{try{
    const row = findNotification(db, req.params.id);
    if (!row || row.user_id !== req.user.id || row.kind !== 'invite') return res.status(404).json({ error: { code: 'not_found', message: 'Приглашение не найдено.' } });
    const status = req.body?.status;
    if (!['accepted', 'declined', 'tentative'].includes(status)) return res.status(400).json({ error: { code: 'invalid_status', message: 'Ответ — accepted, declined или tentative.' } });
    const event = db.prepare('SELECT id FROM calendar_events WHERE account_id=? AND uid=? ORDER BY start_at LIMIT 1').get(row.account_id, row.event_uid);
    if (!event) { resolveNotifications(db, { userId: req.user.id, kind: 'invite', accountId: row.account_id, eventUid: row.event_uid }); countsChanged(req.user.id); return res.status(409).json({ error: { code: 'event_gone', message: 'Встречи больше нет в календаре.' } }); }
    const result = await calendar.respondExternalEvent({ userId: req.user.id, id: `ext:${event.id}`, status });
    if (result.error) return calendarError(res, result);
    resolveNotifications(db, { userId: req.user.id, kind: 'invite', accountId: row.account_id, eventUid: row.event_uid });
    countsChanged(req.user.id);
    res.json({ counts: notificationCounts(db, req.user.id) });
  }catch(error){next(error);}});
  app.get('/api/push/key',(req,res)=>{ res.json({ publicKey: push.publicKey(), subscriptions: push.list(req.user.id) }); });
  app.post('/api/push/subscriptions',(req,res)=>{
    const result = push.subscribe({ userId: req.user.id, subscription: req.body?.subscription, userAgent: req.get('user-agent') });
    if (result.error) return res.status(400).json({ error: { code: result.error, message: 'Некорректная подписка на уведомления.' } });
    res.status(result.created ? 201 : 200).json({ subscription: { id: result.id }, subscriptions: push.list(req.user.id) });
  });
  app.delete('/api/push/subscriptions',(req,res)=>{
    const result = push.unsubscribe({ userId: req.user.id, endpoint: req.body?.endpoint });
    if (result.error) return res.status(400).json({ error: { code: result.error, message: 'Некорректная подписка на уведомления.' } });
    res.json({ removed: result.removed, subscriptions: push.list(req.user.id) });
  });
  // Пробное уведомление: единственный способ убедиться, что телефон получает.
  app.post('/api/push/test',async(req,res,next)=>{
    try {
      const summary = await push.send(req.user.id, { kind: 'test', title: 'Кизуна', body: translate(userLocale(db,req.user.id), 'Уведомления работают: так придёт напоминание о деле.'), tag: 'test', url: '/#settings' });
      if (!summary.sent && !summary.failed && !summary.dropped) return res.status(409).json({ error: { code: 'no_subscriptions', message: 'На этом счёте нет устройств с включёнными уведомлениями.' } });
      res.json(summary);
    } catch (error) { next(error); }
  });
  // Одна запись целиком: карточка открывается по ссылке из уведомления.
  app.get('/api/captures/:id',(req,res)=>{ if(!seesCapture(req,res,req.params.id))return; const row=getAggregate(db,req.params.id); if(!row)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}}); circles.markMentionsSeen(db,req.params.id,req.user.id); const unreadComments=circles.unreadComments(db,req.params.id,req.user.id); circles.markCommentsRead(db,req.params.id,req.user.id); res.json({ entry: { ...fullEntry(db,row), ...sharedEntry(req.params.id,req.user.id), unreadComments, ancestors: ancestorsOf(db,req.params.id,req.user.id) } }); });
  // Подзадачи карточки: всё дерево дочерних дел с прогрессом по конечным
  // шагам. Читает тот, кто видит запись; каждая ветка проверяется отдельно.
  // День для повторов — тот, что открыт у человека («День» листают по датам),
  // иначе сегодняшний в часовом поясе приложения. Удалённый корень — «не найдено».
  const subtaskDay=req=>validDay(req.query?.day)?req.query.day:todayIn(requestTimeZone(req),now());
  app.get('/api/captures/:id/subtasks',(req,res,next)=>{try{ if(!seesCapture(req,res,req.params.id))return; const root=getAggregate(db,req.params.id); if(!root||root.deleted_at)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}}); res.json(subtaskTree(db,req.params.id,req.user.id,{today:subtaskDay(req)})); }catch(error){next(error);}});
  // Новая подзадача — настоящая запись-дело под родителем, заводится сразу,
  // без модели. Родителя правит только автор.
  app.post('/api/captures/:id/subtasks',(req,res,next)=>{try{
    if(!ownsCapture(req,res,req.params.id))return;
    const title=typeof req.body?.title==='string'?req.body.title.trim():'';
    if(!title||title.length>SUBTASK_TITLE_LIMIT)return res.status(400).json({error:{code:'invalid_subtask',message:requestText(req,'Подзадача — от 1 до {limit} символов.',{limit:SUBTASK_TITLE_LIMIT})}});
    const created=createSubtask(db,{parentId:req.params.id,title,userId:req.user.id,timeZone:requestTimeZone(req)});
    if(created.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});
    notifyJournal('subtask');
    res.status(201).json({entry:fullEntry(db,getAggregate(db,created.captureId)),tree:subtaskTree(db,req.params.id,req.user.id,{today:subtaskDay(req)})});
  }catch(error){next(error);}});
  // ── настройки ──
  app.get('/api/settings',(req,res)=>{
    res.json({ settings: publicSettings(stored, process.env, req.user), editable: editableSettings(req.user), timeZone: requestTimeZone(req), spend: spendState(req.user) });
  });
  app.put('/api/settings',(req,res,next)=>{
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const next = {};
      for (const [name, value] of Object.entries(body)) {
        const rule = SETTINGS[name];
        if (!rule) return res.status(400).json({error:{code:'unknown_setting',message:requestText(req,'Неизвестная настройка: {name}.',{name})}});
        // Общая настройка — общая ответственность: ключи, провайдеры и пределы
        // меняет только администратор, остальное каждый правит у себя.
        if (!rule.personal && req.user.role !== 'admin') return res.status(403).json({error:{code:'forbidden',message:requestText(req,'Настройку «{name}» меняет администратор.',{name})}});
        const key = rule.personal ? personalKey(req.user.id, name) : name;
        // Пустая строка и null означают «вернуть значение из окружения».
        if (value === null || value === '') { next[key] = null; continue; }
        if (!rule.check(value)) return res.status(400).json({error:{code:'invalid_setting',message:requestText(req,'Некорректное значение настройки: {name}.',{name})}});
        next[key] = ['requestedTimeZone','detectedTimeZone'].includes(name) && value !== 'system' ? normalizeTimeZone(value) : String(value).trim();
      }
      writeSettings(db, next);
      rebuildServices();
      reportAudit(audit,{event:'settings_changed',result:'succeeded',keys:Object.keys(next)});
      res.json({ settings: publicSettings(stored, process.env, req.user), editable: editableSettings(req.user), timeZone: requestTimeZone(req), spend: spendState(req.user) });
    } catch(error){ next(error); }
  });
  app.get('/api/usage',(req,res,next)=>{try{res.json({...usageSummary(db,{now:now(),userId:req.user.id}),spend:spendState(req.user)});}catch(error){next(error);}});
  app.get('/api/status', async (req,res,next)=>{try{const provider=requestedProvider(req.query.selectedProvider);if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});res.json(await ai.status(provider));}catch(error){next(error);}});
  app.post('/api/captures/:id/corrections',(req,res,next)=>{ if(!ownsCapture(req,res,req.params.id))return; applyCorrection(db,req,res,next,()=>notifyJournal('correction'),requestTimeZone(req)); });
  app.post('/api/captures', async (req,res,next)=> { const lifecycle=requestAbortSignal(req,res);try { const raw = typeof req.body?.raw === 'string' ? req.body.raw.trim() : '',provider=requestedProvider(req.body?.provider),selectedModelValue=requestedModel(req.body?.model); if (selectedModelValue===null) return res.status(400).json({error:{code:'invalid_model',message:'Некорректная модель.'}}); if (!raw || raw.length > 10000) return res.status(400).json({error:{code:'invalid_capture',message:'Запись должна содержать от 1 до 10 000 символов.'}});if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const parsedOverrides=parseCaptureOverrides(req.body,now(),requestTimeZone(req));if(parsedOverrides.error)return res.status(400).json({error:{code:parsedOverrides.error,message:'Некорректные параметры записи.'}});const overrides=parsedOverrides.overrides,timeContext=timeContextFor(req.user.id);if(wantsAsyncResponse(req.get('Prefer'))){const idempotencyKey=req.get('Idempotency-Key');if(idempotencyKey!==undefined&&!validIdempotencyKey(idempotencyKey))return res.status(400).json({error:{code:'invalid_idempotency_key',message:'Некорректный ключ идемпотентности.'}});const gate=await spendGate(req.user,provider);const selectedProvider=await snapshotProvider(ai,gate.provider);const selectedModel=selectedModelValue||null;const queued=enqueueCaptureJob(db,{userId:req.user.id,raw,occurredAt:req.body.occurredAt,selectedProvider,selectedModel,idempotencyKey:idempotencyKey||null,requestFingerprint:idempotencyKey?captureRequestFingerprint({raw,occurredAt:req.body.occurredAt,selectedProvider,selectedModel,overrides}):null,overrides:{...overrides,timeContext}});if(queued.conflict)return res.status(409).json({error:{code:'idempotency_conflict',message:'Ключ уже использован для другого запроса.'}});const duplicate=db.prepare('SELECT id FROM captures WHERE deleted_at IS NULL AND user_id IS ? AND raw=? AND id!=? AND created_at>=? ORDER BY created_at DESC LIMIT 1').get(req.user.id,raw,queued.captureId,new Date(now().getTime()-24*60*60*1000).toISOString());const statusUrl=jobStatusUrl(queued.jobId);captureJobWorker.wake();notifyJournal('queued');res.location(statusUrl).status(202).json({captureId:queued.captureId,jobId:queued.jobId,statusUrl,...(duplicate?{duplicateCaptureId:duplicate.id}:{}),...(gate.budget.allowed?{}:{spend:gate.budget})});return;}const gate=await spendGate(req.user,provider);const result = noteDowngrade(await ai.classify(raw, gate.provider, lifecycle.signal, selectedModelValue||null, memoryPrompt(db,{userId:req.user.id}), userLocale(db, req.user.id, requestLanguages(req.get('accept-language'))),timeContext), gate);noteUsage(db,result,'classify',req.user.id);if(lifecycle.signal.aborted)return; if(overrides)result.classification=applyUserOverrides(result.classification,overrides,new Date(timeContext.referenceAt),timeContext.timeZone); const review=gateClassification(result.classification); const ids = createLedger(db,{userId:req.user.id,raw,occurredAt:req.body.occurredAt, ...result,createProjections:shouldMaterializeProjections(result.classification),timeZone:timeContext.timeZone,referenceAt:timeContext.referenceAt}); const assigned=circles.autoAssign(db,{captureId:ids.captureId,userId:req.user.id,classification:result.classification,raw}); if(assigned)notifyUser(assigned.assignee.id,'journal',{reason:'circle',at:now().toISOString()});
    // «@Аня» прямо в записи — призыв: Аня её видит и знает о ней. Тому, кому
    // запись досталась делом, второй раз не звоним.
    for(const person of circles.callFromText(db,{captureId:ids.captureId,authorId:req.user.id,raw,assigneeId:assigned?.assignee?.id||null}))notifyUser(person.id,'journal',{reason:'circle',at:now().toISOString()}); const row=getAggregate(db,ids.captureId); notifyJournal('capture'); res.status(201).json({entry:fullEntry(db,row),undoGroupId:ids.undoGroupId,parts:ids.parts||[],review,provenance:{requestedProvider:result.requestedProvider,usedProvider:result.usedProvider,provider:result.provider,model:result.model,fallbackReason:result.fallbackReason},...(gate.budget.allowed?{}:{spend:gate.budget})}); } catch(error){if(!lifecycle.signal.aborted)next(error);}finally{lifecycle.dispose();} });
  app.get('/api/jobs/:id',(req,res)=>{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_job_id',message:'Некорректный идентификатор задачи.'}});const job=getCaptureJob(db,req.params.id);if(!job||job.userId!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});res.json({...publicJob(job),parts:job.state==='succeeded'?splitPartsOf(db,job.captureId):[]});});
  app.post('/api/jobs/:id/cancel',(req,res)=>{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_job_id',message:'Некорректный идентификатор задачи.'}});const existing=getCaptureJob(db,req.params.id);if(existing&&existing.userId!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});const cancelled=cancelCaptureJob(db,req.params.id);if(!cancelled)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});if(cancelled.changed)captureJobWorker.abort(req.params.id);res.status(cancelled.changed?202:200).json(publicJob(getCaptureJob(db,req.params.id)));});
  app.post('/api/jobs/:id/retry',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_job_id',message:'Некорректный идентификатор задачи.'}});if(Object.hasOwn(req.body||{},'provider'))return res.status(400).json({error:{code:'retry_provider_not_allowed',message:'Повтор использует исходного провайдера.'}});const existing=getCaptureJob(db,req.params.id);if(existing&&existing.userId!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});const retry=retryCaptureJob(db,req.params.id);if(!retry)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});if(retry.invalidState)return res.status(409).json({error:{code:'retry_not_allowed',message:'Повтор возможен только для отменённой или неудачной задачи.'}});captureJobWorker.wake();const statusUrl=jobStatusUrl(retry.jobId);res.location(statusUrl).status(202).json({...retry,statusUrl});}catch(error){next(error);}});
  app.post('/api/captures/:id/classify', async (req,res,next)=> { const lifecycle=requestAbortSignal(req,res);try { const provider=requestedProvider(req.body?.provider);if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const selectedModelValue=requestedModel(req.body?.model);if(selectedModelValue===null)return res.status(400).json({error:{code:'invalid_model',message:'Некорректная модель.'}});if(!ownsCapture(req,res,req.params.id))return;const budget=spendState(req.user);if(!budget.allowed)return res.status(429).json({error:{code:'spend_limit',message:SPEND_EXHAUSTED},spend:budget});const capture=db.prepare('SELECT raw FROM captures WHERE id=?').get(req.params.id); if(!capture) return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}}); const timeContext=timeContextFor(req.user.id);const result=await ai.classify(capture.raw,provider,lifecycle.signal,selectedModelValue||null,memoryPrompt(db,{userId:req.user.id}), userLocale(db, req.user.id, requestLanguages(req.get('accept-language'))),timeContext);noteUsage(db,result,'classify',req.user.id);if(lifecycle.signal.aborted)return;const before=getAggregate(db,req.params.id);const oldSchedule=before?JSON.parse(before.classification_json).entities?.schedule:null;
  /* Переразбор не делит запись заново, а срок, названный раньше, не теряется: срок «сегодня» по умолчанию его не перекрывает. */
  const fresh={...result.classification,proposedActions:[]};if(fresh.entities?.schedule?.defaulted&&oldSchedule?.date)fresh.entities={...fresh.entities,schedule:oldSchedule};
  const review=gateClassification(fresh); const replacement=replaceInterpretation(db,req.params.id,fresh,result.provider,null,shouldMaterializeProjections(fresh),result.model,{timeZone:timeContext.timeZone});
  if(typeof fresh.details==='string'&&fresh.details.trim()&&!activeNote(db,req.params.id))saveNote(db,req.params.id,fresh.details.trim());
  const row=getAggregate(db,req.params.id); res.json({entry:fullEntry(db,row),undoGroupId:replacement.undoGroupId,review,provenance:{requestedProvider:result.requestedProvider,usedProvider:result.usedProvider,provider:result.provider,model:result.model,fallbackReason:result.fallbackReason}}); }catch(error){if(!lifecycle.signal.aborted)next(error);}finally{lifecycle.dispose();} });
  // Удаление записи — мягкое: она уходит из всех списков, но остаётся в
  // журнале и в экспорте. Поэтому же её можно вернуть.
  app.delete('/api/captures/:id',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const result=deleteCapture(db,req.params.id);if(result.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});reportAudit(audit,{event:'capture_deleted',result:'succeeded'});notifyJournal('delete');res.json(result);}catch(error){next(error);}});
  // Итог к делу: «чем кончилось» — новая запись-результат, привязанная к делу.
  // Она ложится в «Что делал», а в карточке дела видна строкой «Итог».
  app.post('/api/captures/:id/outcome',async(req,res,next)=>{try{
    if(!ownsCapture(req,res,req.params.id))return;
    const text=typeof req.body?.text==='string'?req.body.text.trim():'';
    if(!text||text.length>2000)return res.status(400).json({error:{code:'invalid_outcome',message:'Итог — от 1 до 2 000 символов.'}});
    const requested=requestedProvider(req.body?.provider);
    if(requested===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});
    const provider=await snapshotProvider(ai,(await spendGate(req.user,requested)).provider);
    const queued=enqueueCaptureJob(db,{userId:req.user.id,raw:text,occurredAt:undefined,selectedProvider:provider,overrides:{completed:true,timeContext:timeContextFor(req.user.id)},origin:'outcome'});
    db.prepare('UPDATE captures SET parent_capture_id=? WHERE id=?').run(req.params.id,queued.captureId);
    captureJobWorker.wake();notifyJournal('queued');
    res.status(201).json({captureId:queued.captureId,jobId:queued.jobId,statusUrl:jobStatusUrl(queued.jobId)});
  }catch(error){next(error);}});
  app.post('/api/captures/:id/restore',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const result=restoreCapture(db,req.params.id);if(result.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});reportAudit(audit,{event:'capture_restored',result:'succeeded'});notifyJournal('restore');res.json(result);}catch(error){next(error);}});
  // Закрытое дело забирает с собой свои напоминания: звать к сделанному незачем.
  const dismissReminders=captureId=>{const rows=dismissNotifications(db,null,{captureId,kinds:['reminder']});for(const userId of new Set(rows.map(row=>row.user_id)))countsChanged(userId);};
  const mayComplete=(req,projectionId)=>{const capture=db.prepare('SELECT capture_id FROM projections WHERE id=?').get(projectionId);return Boolean(capture)&&circles.canCompleteCapture(db,capture.capture_id,req.user.id);};
  // Дело, возвращённое в работу, должно оказаться в «Сегодня»: у «сделал X» срока не было,
  // а признак completed в разборе держал бы его в «Что делал».
  const reopenIntoToday=(captureId,userId)=>{const active=getAggregate(db,captureId);if(!active)return;const classification=JSON.parse(active.classification_json);const has=Boolean(classification.entities?.schedule?.date);if(!classification.completed&&has)return;const at=now();const schedule=has?classification.entities.schedule:{...scheduleFromModel({date:currentDate(at,timeZoneFor(userId))},at,timeZoneFor(userId)),defaulted:true};replaceInterpretation(db,captureId,{...classification,completed:false,entities:{...classification.entities,schedule}},'manual',null,shouldMaterializeProjections(classification),null,{timeZone:timeZoneFor(userId)});};
  app.post('/api/projections/:id/complete',(req,res,next)=>{try{if(!validProjectionId(req.params.id))return res.status(400).json({error:{code:'invalid_projection_id',message:'Некорректный идентификатор проекции.'}});if(projectionOwner(db,req.params.id)!==req.user.id&&!mayComplete(req,req.params.id))return res.status(404).json({error:{code:'not_found',message:'Проекция не найдена.'}});if(req.body?.occurrence!==undefined){const done=completeOccurrence(db,req.params.id,req.body.occurrence,{timeZone:requestTimeZone(req)});if(done.error)return completionError(res,done.error);notifyJournal('completion');return res.json({projectionId:req.params.id,occurrence:done.occurrence,changed:done.changed});}const result=completeProjection(db,req.params.id);if(result.error)return completionError(res,result.error);circles.noteCompletion(db,result.projection.capture_id,true);dismissReminders(result.projection.capture_id);notifyCircle(result.projection.capture_id);notifyJournal('completion');res.json({projectionId:result.projection.id,completion:result.completion,changed:result.changed});}catch(error){next(error);}});
  app.post('/api/projections/:id/undo-complete',(req,res,next)=>{try{if(!validProjectionId(req.params.id))return res.status(400).json({error:{code:'invalid_projection_id',message:'Некорректный идентификатор проекции.'}});if(projectionOwner(db,req.params.id)!==req.user.id&&!mayComplete(req,req.params.id))return res.status(404).json({error:{code:'not_found',message:'Проекция не найдена.'}});if(req.body?.occurrence!==undefined){const undone=undoOccurrence(db,req.params.id,req.body.occurrence,{timeZone:requestTimeZone(req)});if(undone.error)return completionError(res,undone.error);notifyJournal('completion');return res.json({projectionId:req.params.id,occurrence:null,changed:undone.changed});}const result=undoProjectionCompletion(db,req.params.id);if(!result.error)circles.noteCompletion(db,result.projection.capture_id,false);if(!result.error&&result.changed)reopenIntoToday(result.projection.capture_id,req.user.id);if(!result.error)notifyCircle(result.projection.capture_id);if(result.error)return completionError(res,result.error);notifyJournal('completion');res.json({projectionId:result.projection.id,completion:result.completion,changed:result.changed});}catch(error){next(error);}});
  // Подзадач в списке нет (они у родителя счётчиком subtasks {done,total}), а у записи с подзадачами он есть.
  app.get('/api/entries',(req,res)=>{ const limit=Math.min(Math.max(Number(req.query.limit)||40,1),100); const page=listEntries(db,{cursor:typeof req.query.cursor==='string'?req.query.cursor:null,limit,userId:req.user.id}); withSubtaskCounts(db,page.entries,req.user.id,{today:todayIn(requestTimeZone(req),now())}); res.json(page); });
  // Доска: колонки и раскладка открытых дел. Ошибки одной картой: имя, лимит,
  // чужая или пропавшая колонка/карточка, кривой индекс. ?subtasks=1 — «Подзадачи:
  // Показывать»: свои подзадачи стоят на доске отдельными карточками (subtask,
  // parentTitle); без него их нет, а у родителя только счётчик subtasks {done,total}.
  const boardError=(res,error)=>{const errors={invalid_name:[400,'Имя колонки — от 1 до 40 символов.'],columns_limit:[409,'Колонок может быть не больше 12.'],column_not_found:[404,'Колонка не найдена.'],card_not_found:[404,'Дело не найдено на доске.'],invalid_index:[400,'Некорректная позиция.'],invalid_column_id:[400,'Нужна колонка: «Входящих» больше нет.'],invalid_color:[400,'Такого цвета нет: серый, коричневый, оранжевый, жёлтый, зелёный, синий, фиолетовый, розовый, красный.']};const [status,message]=errors[error];return res.status(status).json({error:{code:error,message}});};
  app.get('/api/board',(req,res,next)=>{try{const borrowed=circles.acceptedFor(db,req.user.id).map(row=>row.capture_id);res.json({...boardView(db,{userId:req.user.id,timeZone:requestTimeZone(req),now:now(),borrowed,locale:userLocale(db,req.user.id,requestLanguages(req.get('accept-language'))),subtaskCards:req.query.subtasks==='1'}),waiting:circles.waiting(db,req.user.id),circles:circles.circlesOf(db,req.user.id),circleMarks:Object.fromEntries(circles.circleMarksFor(db,req.user.id)),borrowed});}catch(error){next(error);}});
  app.post('/api/board/columns',(req,res,next)=>{try{const result=createColumn(db,{userId:req.user.id,name:req.body?.name});if(result.error)return boardError(res,result.error);res.status(201).json(result.column);}catch(error){next(error);}});
  app.patch('/api/board/columns/:id',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_column_id',message:'Некорректный идентификатор колонки.'}});if(req.body?.name!==undefined){const result=renameColumn(db,{userId:req.user.id,id:req.params.id,name:req.body.name});if(result.error)return boardError(res,result.error);return res.json(result.column);}if(req.body?.index!==undefined){const result=moveColumn(db,{userId:req.user.id,id:req.params.id,index:req.body.index});if(result.error)return boardError(res,result.error);return res.json({order:result.order});}if(req.body?.color!==undefined){const result=colorColumn(db,{userId:req.user.id,id:req.params.id,color:req.body.color});if(result.error)return boardError(res,result.error);return res.json(result.column);}res.status(400).json({error:{code:'nothing_to_change',message:'Передайте name, index или color.'}});}catch(error){next(error);}});
  app.delete('/api/board/columns/:id',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_column_id',message:'Некорректный идентификатор колонки.'}});const result=deleteColumn(db,{userId:req.user.id,id:req.params.id});if(result.error)return boardError(res,result.error);res.json(result);}catch(error){next(error);}});
  app.post('/api/board/move',(req,res,next)=>{try{const {captureId,columnId=null,index,subtasks}=req.body||{};if(!validJobId(captureId))return res.status(400).json({error:{code:'invalid_capture_id',message:'Некорректный идентификатор записи.'}});if(columnId!==null&&!validJobId(columnId))return res.status(400).json({error:{code:'invalid_column_id',message:'Некорректный идентификатор колонки.'}});const result=moveCard(db,{userId:req.user.id,captureId,columnId,index,subtaskCards:subtasks===true});if(result.error)return boardError(res,result.error);res.json(result);}catch(error){next(error);}});
  // ── круги ──
  // Общее дело в личном журнале: круг, просьба, «я жду», обсуждение и призыв.
  // Ошибки — одной картой, как у доски и календаря: модуль отдаёт код, слова
  // для человека живут здесь.
  const CIRCLE_ERRORS = {
    invalid_name:[400,'Имя круга — от 1 до 40 символов.'], invalid_color:[400,'Такого цвета нет.'], circles_limit:[409,'Кругов может быть не больше 12.'],
    not_found:[404,'Круг не найден.'], not_owner:[403,'Это меняет хозяин круга.'], last_owner:[409,'Круг не должен остаться без хозяина: сначала назначьте другого.'],
    invite_not_found:[404,'Приглашение не найдено.'], invite_used:[409,'Приглашение уже использовано.'], invite_expired:[410,'Приглашение просрочено — попросите новое.'],
    person_not_found:[404,'Такого человека в приложении нет.'], already_member:[409,'Этот человек уже в круге.'],
    self_assign:[400,'Себе дело ставят обычной записью.'], not_in_circle:[409,'Этого человека нет ни в одном общем с вами круге.'],
    already_answered:[409,'На эту просьбу уже ответили.'], invalid_comment:[400,'Сообщение — от 1 до 4000 символов.'], invalid_name_value:[400,'Имя — до 60 символов.'],
    invalid_reaction:[400,'Такой реакции нет.'], empty_image:[400,'Картинка пустая.'], not_an_image:[415,'Подходят только PNG, JPEG и WebP.'], image_too_large:[413,'Картинка слишком большая.'],
  };
  const circleError = (res, error) => { const [status, message] = CIRCLE_ERRORS[error] || [500, 'Ошибка круга.']; return res.status(status).json({ error:{ code:error, message } }); };
  const circleReply = (res, result, status = 200) => result.error ? circleError(res, result.error) : res.status(status).json(result);

  // Люди из ваших кругов — для подсказки «@» в поле записи: там круг ещё не
  // выбран, а позвать можно любого своего.
  app.get('/api/projects',(req,res,next)=>{try{
    const rows=db.prepare("SELECT i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.user_id=? AND c.deleted_at IS NULL ORDER BY i.created_at DESC, c.created_at DESC").all(req.user.id);
    const names=new Map();
    for(const row of rows) for(const name of JSON.parse(row.classification_json).entities?.projects || []) {
      const value=name.trim();
      if(value && !names.has(value.toLocaleLowerCase())) names.set(value.toLocaleLowerCase(),value);
    }
    res.json({projects:[...names.values()]});
  }catch(error){next(error);}});
  app.get('/api/people',(req,res,next)=>{try{res.json({people:circles.peopleAround(db,req.user.id)});}catch(error){next(error);}});
  app.get('/api/circles',(req,res,next)=>{try{res.json({circles:circles.circlesOf(db,req.user.id).map(circle=>circles.circleDetail(db,circle.id,req.user.id)),me:circles.publicUser(findUserById(db,req.user.id))});}catch(error){next(error);}});
  app.post('/api/circles',(req,res,next)=>{try{const result=circles.createCircle(db,req.user.id,req.body?.name,req.body?.color||'violet');if(!result.error)chat.ensureGeneral(db,result.circle.id,req.user.id);circleReply(res,result,201);}catch(error){next(error);}});
  // Приглашение — раньше «:id», иначе адрес «invite» ушёл бы в идентификатор.
  app.get('/api/circles/invite/:token',(req,res,next)=>{try{circleReply(res,circles.peekInvite(db,req.params.token));}catch(error){next(error);}});
  app.post('/api/circles/invite/:token/accept',(req,res,next)=>{try{const result=circles.acceptInvite(db,req.params.token,req.user.id);if(!result.error)notifyCircleMembers(result.circle.id);circleReply(res,result);}catch(error){next(error);}});
  app.get('/api/circles/:id',(req,res,next)=>{try{const circle=circles.circleDetail(db,req.params.id,req.user.id);if(!circle)return circleError(res,'not_found');res.json({circle});}catch(error){next(error);}});
  app.patch('/api/circles/:id',(req,res,next)=>{try{circleReply(res,circles.updateCircle(db,req.params.id,req.user.id,{name:req.body?.name,color:req.body?.color}));}catch(error){next(error);}});
  // Фото круга: ставит и убирает хозяин, картинку ужимает браузер. Видят все в
  // круге — им приходит событие, и знак круга у них меняется без перезагрузки.
  const photoReply = (req, res, result) => { if (result.error) return circleError(res, result.error); notifyCircleMembers(req.params.id); res.json(result); };
  app.post('/api/circles/:id/photo', express.raw({ type: () => true, limit: AVATAR_IMAGE_LIMIT }), (req,res,next)=>{try{photoReply(req,res,circles.setCirclePhoto(db,req.params.id,req.user.id,Buffer.isBuffer(req.body)?req.body:null,now()));}catch(error){next(error);}});
  app.delete('/api/circles/:id/photo',(req,res,next)=>{try{photoReply(req,res,circles.removeCirclePhoto(db,req.params.id,req.user.id));}catch(error){next(error);}});
  app.get('/api/circles/:id/photo',(req,res,next)=>{try{
    const image=circles.circlePhoto(db,req.params.id,req.user.id);
    if(!image)return circleError(res,'not_found');
    // Адрес меняется вместе с фото (?v=), поэтому кешировать можно надолго.
    res.set({ 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.send(image.bytes);
  }catch(error){next(error);}});
  // Выключить круг — личное и обратимое: дела уходят из списков, просьбы
  // продолжают приходить свёрнутой строкой.
  app.post('/api/circles/:id/mute',(req,res,next)=>{try{circleReply(res,circles.setMuted(db,req.params.id,req.user.id,req.body?.muted!==false));}catch(error){next(error);}});
  app.delete('/api/circles/:id',(req,res,next)=>{try{circleReply(res,circles.dissolveCircle(db,req.params.id,req.user.id));}catch(error){next(error);}});
  // Человека, который уже есть в приложении, зовут поиском, а не ссылкой:
  // искать ссылку ради соседа по приложению незачем.
  app.get('/api/circles/:id/candidates',(req,res,next)=>{try{circleReply(res,circles.candidates(db,req.params.id,req.user.id,req.query?.q));}catch(error){next(error);}});
  app.post('/api/circles/:id/members',(req,res,next)=>{try{const result=circles.addMember(db,req.params.id,req.user.id,req.body?.userId);if(result.error)return circleError(res,result.error);chat.ensureGeneral(db,req.params.id,req.user.id);notifyCircleMembers(req.params.id);chatReply(res,result);}catch(error){next(error);}});
  app.post('/api/circles/:id/seen',(req,res,next)=>{try{if(!circles.membership(db,req.params.id,req.user.id))return circleError(res,'not_found');res.json(circles.markCircleSeen(db,req.params.id,req.user.id));}catch(error){next(error);}});
  app.post('/api/circles/:id/leave',(req,res,next)=>{try{const result=circles.leaveCircle(db,req.params.id,req.user.id);if(!result.error)notifyCircleMembers(req.params.id);circleReply(res,result);}catch(error){next(error);}});
  app.post('/api/circles/:id/invite',(req,res,next)=>{try{const result=circles.createInvite(db,req.params.id,req.user.id);if(result.error)return circleError(res,result.error);const base=process.env.PAGENT_PUBLIC_URL||`${req.get('x-forwarded-proto')||req.protocol}://${req.get('x-forwarded-host')||req.get('host')}`;res.status(201).json({...result,url:`${base.replace(/\/+$/,'')}/#join/${result.token}`});}catch(error){next(error);}});

  // Полоса «к вам» и «я жду» — две стороны одного: что просят у меня и что я
  // отдал. Приложение никого не подгоняет, оно только честно считает.
  app.get('/api/inbox',(req,res,next)=>{try{const box=circles.inbox(db,req.user.id,[...chat.unseenCalls(db,req.user.id),...circles.newCircles(db,req.user.id)]);res.json({...box,waiting:circles.waiting(db,req.user.id)});}catch(error){next(error);}});
  app.post('/api/captures/:id/assign',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const assigneeId=req.body?.assigneeId??null;const result=assigneeId?circles.assign(db,{captureId:req.params.id,assigneeId,assignerId:req.user.id,circleId:req.body?.circleId||null}):circles.unassign(db,req.params.id,req.user.id);if(result.error)return circleError(res,result.error);notifyCircle(req.params.id,[assigneeId].filter(Boolean));notifyJournal('circle');res.json({...result,...sharedEntry(req.params.id,req.user.id)});}catch(error){next(error);}});
  app.post('/api/assignments/:id/respond',(req,res,next)=>{try{const take=req.body?.take===true;const result=circles.respond(db,req.params.id,req.user.id,take,req.body?.reason);if(result.error)return circleError(res,result.error);notifyCircle(result.assignment.captureId);notifyJournal('circle');res.json(result);}catch(error){next(error);}});

  // Обсуждение живёт в карточке записи, последним блоком после заметки.
  // Призыв @имя — единственное, что порождает у человека строку.
  app.get('/api/captures/:id/comments',(req,res,next)=>{try{if(!seesCapture(req,res,req.params.id))return;circles.markMentionsSeen(db,req.params.id,req.user.id);const unread=circles.unreadComments(db,req.params.id,req.user.id);circles.markCommentsRead(db,req.params.id,req.user.id);res.json({comments:circles.comments(db,req.params.id,req.user.id),callable:circles.callableFor(db,req.params.id,req.user.id),participants:circles.captureParticipants(db,req.params.id),unread});}catch(error){next(error);}});
  app.post('/api/captures/:id/comments',(req,res,next)=>{try{if(!seesCapture(req,res,req.params.id))return;const share=['yes','no'].includes(req.body?.share)?req.body.share:null;const result=circles.addComment(db,{captureId:req.params.id,authorId:req.user.id,body:req.body?.body,parentId:req.body?.parentId||null,share});if(result.error==='share_needed')return res.status(409).json({error:{code:'share_needed',message:'Позванные ещё не видят эту запись.'},people:result.people});if(result.error)return circleError(res,result.error);notifyCircle(req.params.id,[...result.comment.mentions.map(person=>person.id),...result.participants.map(person=>person.id)]);notifyJournal('comment');res.status(201).json(result);}catch(error){next(error);}});
  // Убрать человека из записи может автор; уйти сам («не следить») — любой позванный.
  app.post('/api/captures/:id/comments/:commentId/reactions',(req,res,next)=>{try{if(!seesCapture(req,res,req.params.id))return;const result=circles.reactComment(db,req.params.id,req.params.commentId,req.user.id,req.body?.emoji);if(result.error)return circleError(res,result.error);notifyCircle(req.params.id,circles.captureParticipants(db,req.params.id).map(person=>person.id));res.json(result);}catch(error){next(error);}});
  app.delete('/api/captures/:id/people/:userId',(req,res,next)=>{try{if(!seesCapture(req,res,req.params.id))return;const result=circles.removeParticipant(db,req.params.id,req.user.id,req.params.userId);if(result.error)return circleError(res,result.error);notifyCircle(req.params.id,[req.params.userId]);res.json(result);}catch(error){next(error);}});
  app.get('/api/discussions',(req,res,next)=>{try{res.json({discussions:circles.discussions(db,req.user.id)});}catch(error){next(error);}});

  // Имя человека: до кругов его не спрашивали, потому что некому было
  // показывать. Теперь оно стоит в «просит …» и в подсказке призыва.
  app.patch('/api/account',(req,res,next)=>{try{if(req.body?.name!==undefined&&typeof req.body.name!=='string')return circleError(res,'invalid_name_value');const name=req.body?.name!==undefined?circles.setDisplayName(db,req.user.id,req.body.name):null;res.json({me:circles.publicUser(findUserById(db,req.user.id)),name});}catch(error){next(error);}});

  // ── разговор круга ──
  // Общий разговор и комнаты подмножеством. Счётчик непрочитанного живёт
  // только здесь, на комнате: в день попадает один призыв.
  const CHAT_ERRORS = {
    not_found:[404,'Комната не найдена.'], invalid_room_name:[400,'Название комнаты — от 1 до 40 символов.'],
    rooms_limit:[409,'Комнат в круге может быть не больше 20.'], room_needs_people:[400,'Комната — это разговор с кем-то: позовите хотя бы одного человека.'],
    general_room:[409,'Общий разговор круга не переименовать и не покинуть — он и есть круг.'],
    everyone_room:[409,'Разговор для всего круга не покинуть, и позвать в него отдельно нельзя: в нём все, кто в круге.'],
    not_in_circle:[409,'Этого человека нет в круге.'], invalid_message:[400,'Сообщение — от 1 до 4000 символов.'],
    invalid_reply:[400,'Ответить можно на сообщение из этого же разговора.'], invalid_reaction:[400,'Такой реакции нет.'],
  };
  const chatError = (res, error) => { const [status, message] = CHAT_ERRORS[error] || CIRCLE_ERRORS[error] || [500, 'Ошибка разговора.']; return res.status(status).json({ error:{ code:error, message } }); };
  const chatReply = (res, result, status = 200) => result.error ? chatError(res, result.error) : res.status(status).json(result);
  // Новость о сообщении уходит тем, кто в комнате: остальным в круге знать о
  // чужом разговоре незачем — они его и не видят.
  const notifyRoom = (roomId, { except = null } = {}) => {
    const room = chat.findRoom(db, roomId);
    if (!room) return;
    for (const person of chat.roomMembers(db, room)) if (person.id !== except) notifyUser(person.id, 'journal', { reason:'chat', roomId, at: now().toISOString() });
  };

  app.get('/api/rooms',(req,res,next)=>{try{res.json({rooms:chat.roomsOf(db,req.user.id,typeof req.query.circle==='string'?req.query.circle:null)});}catch(error){next(error);}});
  app.post('/api/circles/:id/rooms',(req,res,next)=>{try{const result=chat.createRoom(db,req.params.id,req.user.id,req.body?.name,Array.isArray(req.body?.members)?req.body.members:[],{everyone:req.body?.everyone===true});if(result.error)return chatError(res,result.error);notifyRoom(result.room.id);chatReply(res,result,201);}catch(error){next(error);}});
  app.get('/api/rooms/:id/messages',(req,res,next)=>{try{const room=chat.findRoom(db,req.params.id);if(!room||!chat.inRoom(db,room,req.user.id))return chatError(res,'not_found');chat.markRead(db,req.params.id,req.user.id);const result=chat.messages(db,req.params.id,req.user.id,{before:typeof req.query.before==='string'?req.query.before:null});if(result.error)return chatError(res,result.error);res.json(result);}catch(error){next(error);}});
  app.post('/api/rooms/:id/messages',(req,res,next)=>{try{const join=['yes','no'].includes(req.body?.join)?req.body.join:null;const result=chat.say(db,req.params.id,req.user.id,req.body?.body,{replyTo:typeof req.body?.replyTo==='string'?req.body.replyTo:null,join});
    // Позвать того, кого в разговоре нет, — значит открыть ему разговор, а
    // человека из другого круга ещё и привести в круг: спрашиваем, как в карточке.
    if(result.error==='join_needed')return res.status(409).json({error:{code:'join_needed',message:'Позванные ещё не в этом разговоре.'},people:result.people});if(result.error)return chatError(res,result.error);notifyRoom(req.params.id,{except:req.user.id});res.status(201).json(result);}catch(error){next(error);}});
  app.delete('/api/rooms/:id/messages/:messageId',(req,res,next)=>{try{const result=chat.removeMessage(db,req.params.messageId,req.user.id);if(result.error)return chatError(res,result.error);notifyRoom(req.params.id,{except:req.user.id});res.json(result);}catch(error){next(error);}});
  app.post('/api/rooms/:id/messages/:messageId/reactions',(req,res,next)=>{try{const result=chat.react(db,req.params.id,req.params.messageId,req.user.id,req.body?.emoji);if(result.error)return chatError(res,result.error);notifyRoom(req.params.id,{except:req.user.id});res.json(result);}catch(error){next(error);}});
  app.post('/api/rooms/:id/pin',(req,res,next)=>{try{const result=chat.pin(db,req.params.id,req.user.id,typeof req.body?.messageId==='string'?req.body.messageId:null);if(result.error)return chatError(res,result.error);notifyRoom(req.params.id,{except:req.user.id});chatReply(res,result);}catch(error){next(error);}});
  app.post('/api/rooms/:id/read',(req,res,next)=>{try{const room=chat.findRoom(db,req.params.id);if(!room||!chat.inRoom(db,room,req.user.id))return chatError(res,'not_found');res.json(chat.markRead(db,req.params.id,req.user.id));}catch(error){next(error);}});
  app.patch('/api/rooms/:id',(req,res,next)=>{try{chatReply(res,chat.renameRoom(db,req.params.id,req.user.id,req.body?.name));}catch(error){next(error);}});
  app.post('/api/rooms/:id/members',(req,res,next)=>{try{const result=chat.addToRoom(db,req.params.id,req.user.id,req.body?.userId);if(result.error)return chatError(res,result.error);notifyRoom(req.params.id);chatReply(res,result);}catch(error){next(error);}});
  app.post('/api/rooms/:id/leave',(req,res,next)=>{try{const result=chat.leaveRoom(db,req.params.id,req.user.id);if(result.error)return chatError(res,result.error);notifyRoom(req.params.id);chatReply(res,result);}catch(error){next(error);}});

  // ── календарь ──
  // Ошибки календаря переводятся в статусы одним словарём: модуль отдаёт код,
  // а слова для человека живут здесь, рядом с остальными ответами API.
  const CALENDAR_ERRORS = {
    invalid_range:[400,'Некорректный диапазон дат.'], range_too_wide:[400,'Диапазон не больше двух месяцев.'], not_found:[404,'Календарь не найден.'],
    invalid_preset:[400,'Неизвестный тип календаря.'], invalid_server:[400,'Адрес сервера должен начинаться с https://.'], invalid_username:[400,'Укажите логин.'], invalid_password:[400,'Укажите пароль приложения.'],
    unauthorized:[401,'Сервер календаря не принял логин или пароль приложения.'], unreachable:[502,'Не удалось связаться с сервером календаря.'],
    invalid_label:[400,'Название — до 60 символов.'], invalid_color:[400,'Цвет — в виде #rrggbb.'], invalid_mode:[400,'Режим — full или busy.'], invalid_disabled:[400,'Признак отключения — да или нет.'], invalid_calendars:[400,'Список календарей — идентификаторы строками.'],
    google_not_configured:[409,'Google не настроен: в настройках нужны идентификатор и секрет клиента OAuth.'], invalid_state:[400,'Подключение Google устарело — начните заново.'], invalid_code:[400,'Google не вернул код подключения.'], google_error:[502,'Google не ответил как ожидалось.'],
    capture_not_found:[404,'Запись не найдена.'], account_not_found:[404,'Календарь не найден.'], calendar_not_found:[404,'В этот календарь писать нельзя.'], already_exported:[409,'Встреча уже есть в этом календаре.'], no_schedule:[409,'У записи нет срока — нечего отправлять.'],
    invalid_auto_export:[400,'Автоотправка — off, meetings или all.'], busy_mode:[409,'Календарь в режиме «только занято»: события в нём не правятся.'], recurring:[409,'В другой календарь переносится только серия целиком — в самом календаре.'], invalid_scope:[400,'Область удаления — instance или series.'], invalid_title:[400,'Название — от 1 до 300 символов.'], invalid_schedule:[400,'Некорректная дата или время.'], conflict:[409,'Событие изменили снаружи. Обновите календарь и попробуйте снова.'], update_failed:[502,'Календарь не принял правку.'], invalid_status:[400,'Ответ — accepted, declined или tentative.'], invalid_comment:[400,'Комментарий — до 500 символов.'], not_invited:[409,'Вас нет среди участников этого события — отвечать некому.'],
    export_failed:[502,'Календарь не принял событие.'], remove_failed:[502,'Календарь не дал убрать событие.'], sync_error:[502,'Синхронизация не удалась.'],
  };
  const calendarError = (res, result) => {
    const [status, source] = CALENDAR_ERRORS[result.error] || [500, 'Ошибка календаря.'];
    const message = requestText(res.req,source);
    const detail = result.messageTemplate ? requestText(res.req,result.messageTemplate.source,result.messageTemplate.params) : result.message || null;
    return res.status(status).json({error:{code:result.error,message:detail ? `${message} ${detail}` : message}});
  };
  // Адрес возврата для Google: за Caddy настоящий протокол и хост приходят в
  // заголовках X-Forwarded-*; PAGENT_PUBLIC_URL перекрывает всё.
  const googleRedirectUri = req => { const base = process.env.PAGENT_PUBLIC_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`; return `${base.replace(/\/+$/, '')}/api/calendar/google/callback`; };
  app.get('/api/calendar',(req,res,next)=>{try{const from=typeof req.query.from==='string'?req.query.from:'',to=typeof req.query.to==='string'?req.query.to:'';const result=calendar.view({userId:req.user.id,from,to,borrowed:circles.acceptedFor(db,req.user.id).map(row=>row.capture_id)});if(!result.error)result.circleMarks=Object.fromEntries(circles.circleMarksFor(db,req.user.id));if(result.error)return calendarError(res,result);res.json(result);}catch(error){next(error);}});
  app.get('/api/calendar/accounts',(req,res,next)=>{try{res.json({accounts:calendar.listAccounts(req.user.id),googleReady:calendar.googleReady(),presets:calendar.presets});}catch(error){next(error);}});
  app.post('/api/calendar/accounts',async(req,res,next)=>{try{const {preset,serverUrl,username,password,label}=req.body||{};const result=await calendar.addCaldavAccount({userId:req.user.id,preset,serverUrl,username,password,label});if(result.error)return calendarError(res,result);const synced=await calendar.syncAccount(result.account.id,{userId:req.user.id});notifyJournal('calendar');res.status(201).json({account:synced.account||result.account,...(synced.error?{syncError:synced.message}:{events:synced.events})});}catch(error){next(error);}});
  app.patch('/api/calendar/accounts/:id',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(404).json({error:{code:'not_found',message:'Календарь не найден.'}});const {label,color,mode,calendars,disabled,autoExport,autoCalendarId}=req.body||{};const result=calendar.updateAccount({userId:req.user.id,id:req.params.id,label,color,mode,calendars,disabled,autoExport,autoCalendarId});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  app.delete('/api/calendar/accounts/:id',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(404).json({error:{code:'not_found',message:'Календарь не найден.'}});const result=calendar.removeAccount({userId:req.user.id,id:req.params.id});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  app.post('/api/calendar/accounts/:id/sync',async(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(404).json({error:{code:'not_found',message:'Календарь не найден.'}});const result=await calendar.syncAccount(req.params.id,{userId:req.user.id});if(result.error&&!result.account)return calendarError(res,result);const pushed=(await calendar.autoExport({accountId:req.params.id}))[0]||null;if(pushed)result.pushed=pushed;notifyJournal('calendar');if(result.error)return res.status(result.error==='unauthorized'?401:502).json({error:{code:result.error,message:result.message},account:result.account});res.json(result);}catch(error){next(error);}});
  app.get('/api/calendar/google/start',(req,res,next)=>{try{const result=calendar.googleStart({userId:req.user.id,redirectUri:googleRedirectUri(req)});if(result.error)return calendarError(res,result);res.redirect(result.url);}catch(error){next(error);}});
  // Google возвращает человека сюда после согласия; страница настроек читает
  // итог из параметра адреса — иначе после редиректа не было бы ни слова.
  app.get('/api/calendar/google/callback',async(req,res,next)=>{try{if(req.query.error)return res.redirect('/#settings?calendar=denied');const result=await calendar.googleFinish({state:String(req.query.state||''),code:typeof req.query.code==='string'?req.query.code:'',userId:req.user.id});if(result.error){reportAudit(audit,{event:'calendar_google_failed',errorCode:result.error});return res.redirect(`/#settings?calendar=${encodeURIComponent(result.error)}`);}await calendar.syncAccount(result.account.id,{userId:req.user.id});notifyJournal('calendar');res.redirect('/#settings?calendar=connected');}catch(error){next(error);}});
  app.post('/api/calendar/export',async(req,res,next)=>{try{const {captureId,accountId,calendarId}=req.body||{};if(!validJobId(captureId)||!validJobId(accountId)||typeof calendarId!=='string'||!calendarId)return res.status(400).json({error:{code:'invalid_export',message:'Нужны запись, календарь-аккаунт и календарь.'}});if(!ownsCapture(req,res,captureId))return;const result=await calendar.exportCapture({userId:req.user.id,captureId,accountId,calendarId});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.status(201).json(result);}catch(error){next(error);}});
  // Чужое событие из сетки: перенос и переименование — PATCH, удаление — DELETE.
  // Пишет только в пишущий календарь не в режиме «занято»; повторы CalDAV не трогает.
  app.patch('/api/calendar/external/:id',async(req,res,next)=>{try{const {title,date,time,end}=req.body||{};const result=await calendar.updateExternalEvent({userId:req.user.id,id:req.params.id,title,date,time,end});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  app.post('/api/calendar/external/:id/respond',async(req,res,next)=>{try{const {status,comment}=req.body||{};const result=await calendar.respondExternalEvent({userId:req.user.id,id:req.params.id,status,comment});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  app.post('/api/calendar/external/:id/move',async(req,res,next)=>{try{const {calendarId}=req.body||{};if(typeof calendarId!=='string'||!calendarId)return res.status(400).json({error:{code:'invalid_calendar',message:'Нужен календарь.'}});const result=await calendar.moveExternalEvent({userId:req.user.id,id:req.params.id,calendarId});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  // Экземпляр повтора удаляется по выбору: ?scope=instance — только он (по
  // умолчанию), ?scope=series — вся серия.
  app.delete('/api/calendar/external/:id',async(req,res,next)=>{try{const scope=req.query.scope===undefined?'instance':req.query.scope;if(!['instance','series'].includes(scope))return res.status(400).json({error:{code:'invalid_scope',message:'Область удаления — instance или series.'}});const result=await calendar.deleteExternalEvent({userId:req.user.id,id:req.params.id,scope});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  app.post('/api/calendar/export/remove',async(req,res,next)=>{try{const {captureId,accountId}=req.body||{};if(!validJobId(captureId)||!validJobId(accountId))return res.status(400).json({error:{code:'invalid_export',message:'Нужны запись и календарь-аккаунт.'}});if(!ownsCapture(req,res,captureId))return;const result=await calendar.removeExport({userId:req.user.id,captureId,accountId});if(result.error)return calendarError(res,result);notifyJournal('calendar');res.json(result);}catch(error){next(error);}});
  app.get('/api/reports',(req,res,next)=>{try{const period=typeof req.query.period==='string'?req.query.period:'week';if(!['week','month','all'].includes(period))return res.status(400).json({error:{code:'invalid_period',message:'Период должен быть week, month или all.'}});res.json(periodReport(db,{period,now:now(),timeZone:requestTimeZone(req),userId:req.user.id}));}catch(error){next(error);}});
  // Сводка одного дня; по умолчанию — вчера: день, который уже закончился.
  // «Сделано»: закрытые туду и закончившиеся встречи за период (по умолчанию — последние 7 дней).
  app.get('/api/done',(req,res,next)=>{try{const today=dateInTimeZone(now(),requestTimeZone(req)),to=typeof req.query.to==='string'?req.query.to:today,from=typeof req.query.from==='string'?req.query.from:reportShiftDate(to,-6);if(!validDate(from)||!validDate(to)||from>to)return res.status(400).json({error:{code:'invalid_range',message:'Период — две даты YYYY-MM-DD, начало не позже конца.'}});if((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000>62)return res.status(400).json({error:{code:'range_too_wide',message:'Период не может быть длиннее 62 дней.'}});res.json(doneView(db,{userId:req.user.id,from,to,now:now(),timeZone:requestTimeZone(req),calendar}));}catch(error){next(error);}});
  app.get('/api/reports/day',(req,res,next)=>{try{const date=req.query.date||reportShiftDate(dateInTimeZone(now(),requestTimeZone(req)),-1);if(!validDate(date))return res.status(400).json({error:{code:'invalid_date',message:'Дата должна быть в формате YYYY-MM-DD.'}});res.json(dayReport(db,{date,now:now(),timeZone:requestTimeZone(req),userId:req.user.id}));}catch(error){next(error);}});
  // Общее приходит в тот же день, где человек и так стоит каждое утро: полоса
  // «к вам» (просьбы и призывы одной лентой), взятые чужие дела ссылками и
  // метки кругов для строк. Переключателя пространств нет — и не будет.
  const circleDay = userId => {
    const box = circles.inbox(db, userId, [...chat.unseenCalls(db, userId), ...circles.newCircles(db, userId)]);
    // Выключенный круг уходит из списков целиком: это и обещает переключатель.
    // Просьбы из него при этом продолжают приходить — свёрнутой строкой.
    const muted = circles.mutedCircleIds(db, userId);
    const borrowed = circles.acceptedFor(db, userId).map(row => {
      const aggregate = getAggregate(db, row.capture_id);
      if (!aggregate) return null;
      const circle = circles.circlesForCapture(db, row.capture_id)[0] || null;
      if (circle && muted.has(circle.id)) return null;
      return { ...fullEntry(db, aggregate), foreign:true, circle, assignment: circles.assignmentFor(db, row.capture_id) };
    }).filter(Boolean);
    const waiting = circles.waiting(db, userId);
    // Отданное дело помечается прямо в своей строке: «Аня · ждёт ответа». Это
    // и есть слежение за реализацией — без доски со статусами.
    return { inbox: box.rows, inboxFolded: box.folded, borrowed, waiting, unreadChat: chat.unreadByCircle(db, userId), assignments: Object.fromEntries(waiting.map(item => [item.captureId, item])), circles: circles.circlesOf(db, userId), mutedCircles: circles.mutedSummary(db, userId), circleMarks: Object.fromEntries(circles.circleMarksFor(db, userId)) };
  };
  app.get('/api/day',(req,res)=>{const date=req.query.date||dateInTimeZone(now(),requestTimeZone(req));if(!validDate(date))return res.status(400).json({error:{code:'invalid_date',message:'Дата должна быть в формате YYYY-MM-DD.'}});const view=dayView(db,date,now(),req.user.id,requestTimeZone(req)),shared=circleDay(req.user.id);withSubtaskCounts(db,[...view.day,...view.upcoming,...view.attention,...shared.borrowed],req.user.id,{today:todayIn(requestTimeZone(req),now())});res.json({date,...view,...shared});});
  app.get('/api/daily-brief',(req,res,next)=>{try{const zone=req.query.timeZone===undefined?requestTimeZone(req):normalizeTimeZone(req.query.timeZone);if(!zone)return res.status(400).json({error:{code:'invalid_daily_brief_request',message:'Некорректная дата или ревизия отчёта.'}});const date=req.query.date||dateInTimeZone(now(),zone), revision=req.query.revision; if(!validDate(date)||revision!==undefined&&(!/^\d+$/.test(revision)||Number(revision)<1))return res.status(400).json({error:{code:'invalid_daily_brief_request',message:'Некорректная дата или ревизия отчёта.'}}); const brief=revision===undefined?getDailyBrief(db,{date,timeZone:zone,userId:req.user.id}):findDailyBrief(db,{date,timeZone:zone,revision:Number(revision),userId:req.user.id}); if(!brief)return res.status(404).json({error:{code:'not_found',message:'Ревизия отчёта не найдена.'}}); res.json(brief);}catch(error){next(error);}});
  app.post('/api/daily-brief/refresh',(req,res,next)=>{try{const date=req.body?.date||dateInTimeZone(now(),requestTimeZone(req));if(!validDate(date))return res.status(400).json({error:{code:'invalid_date',message:'Дата должна быть в формате YYYY-MM-DD.'}});res.json(getDailyBrief(db,{date,timeZone:requestTimeZone(req),force:true,userId:req.user.id}));}catch(error){next(error);}});
  app.get('/api/daily-brief/:date/revisions/:revision/sources/:sourceId',(req,res,next)=>{try{const {date,revision,sourceId}=req.params;const zone=req.query.timeZone===undefined?null:normalizeTimeZone(req.query.timeZone);if((req.query.timeZone!==undefined&&!zone)||!validDate(date)||!/^\d+$/.test(revision)||Number(revision)<1||!validJobId(sourceId))return res.status(400).json({error:{code:'invalid_daily_source',message:'Некорректный источник отчёта.'}});const source=findDailyBriefSource(db,{date,timeZone:zone,revision:Number(revision),sourceId,userId:req.user.id});if(!source)return res.status(404).json({error:{code:'not_found',message:'Источник отчёта не найден.'}});res.json({captureId:source.id,raw:source.raw,occurredAt:source.occurred_at,createdAt:source.created_at});}catch(error){next(error);}});
  app.post('/api/captures/:id/notes',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const body=req.body?.body;if(typeof body!=='string'||body.length>NOTE_BODY_LIMIT)return res.status(400).json({error:{code:'invalid_note',message:requestText(req,'Заметка должна быть текстом до {limit} символов.',{limit:NOTE_BODY_LIMIT})}});const saved=saveNote(db,req.params.id,body);if(saved.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});const row=getAggregate(db,req.params.id);notifyJournal('note');res.json({entry:fullEntry(db,row)});}catch(error){next(error);}});
  app.post('/api/undo',(req,res)=>{ const undoGroupId=req.body?.undoGroupId; if(typeof undoGroupId!=='string') return res.status(400).json({error:{code:'invalid_undo',message:'Нужна группа отмены.'}}); const owner=undoGroupOwner(db,undoGroupId);if(owner!==undefined&&owner!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Группа отмены не найдена.'}});const reverted=undo(db,undoGroupId);notifyJournal('undo');res.json({reverted}); });
  app.post('/api/memory/search',(req,res)=>{const query=memoryQuery(req); if(!query) return res.status(400).json({error:{code:'invalid_query',message:'Введите запрос длиной до 2 000 символов.'}}); res.json({results:search(db,query,req.user.id)});});
  app.post('/api/memory/answer',async(req,res,next)=>{const lifecycle=requestAbortSignal(req,res);try{const query=memoryQuery(req),provider=requestedProvider(req.body?.provider);if(!query)return res.status(400).json({error:{code:'invalid_query',message:'Введите запрос длиной до 2 000 символов.'}});if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const selectedModelValue=requestedModel(req.body?.model);if(selectedModelValue===null)return res.status(400).json({error:{code:'invalid_model',message:'Некорректная модель.'}});const sources=boundedMemorySources(query,search(db,query,req.user.id)); const answerGate=await spendGate(req.user,provider);const answer=noteDowngrade(await ai.answer(query,sources,answerGate.provider,lifecycle.signal,selectedModelValue||null,userLocale(db,req.user.id,requestLanguages(req.get('accept-language')))),answerGate);noteUsage(db,answer,'answer',req.user.id);if(lifecycle.signal.aborted)return;res.json({...answer,sources,provenance:{requestedProvider:answer.requestedProvider,usedProvider:answer.usedProvider,provider:answer.provider,model:answer.model,fallbackReason:answer.fallbackReason}});}catch(error){if(!lifecycle.signal.aborted)next(error);}finally{lifecycle.dispose();}});
  app.get('/api/export',(req,res)=>{const exported=exportLedger(db,req.user.id);if(exported.limitExceeded)return res.status(413).json({error:{code:'export_limit_exceeded',message:'Экспорт слишком большой для безопасного создания одним файлом.'},rowLimit:exported.rowLimit});reportAudit(audit,{event:'export_created',schemaVersion:exported.schemaVersion,rowCount:exported.captures.length+exported.interpretations.length+exported.corrections.length+exported.projections.length+exported.captureJobs.length+exported.captureJobEvents.length+exported.ledgerEvents.length+exported.dailyBriefs.length+exported.dailyBriefSources.length});res.type('application/json').attachment('pagent-ledger.json').json(exported);});
  // ── потолок расходов ──
  const numberOrNull = (value) => { const parsed = Number(value); return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed; };
  // Потолок расходов на месяц: личный сильнее общего, пустое поле у человека
  // значит «своего нет, работает общий», а не «ноль».
  function spendState(user) {
    const limitUsd = user?.monthly_limit_usd ?? numberOrNull(settingValue(stored, process.env, 'monthlyLimitUsd', null));
    const spent = monthlySpend(db, { userId: user.id, at: now(), timeZone: configuredTimeZone });
    const exhausted = limitUsd !== null && spent.totalUsd >= limitUsd;
    return {
      ...spent,
      limitUsd,
      remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - spent.totalUsd),
      allowed: !exhausted,
      // Сумма считается только там, где провайдер назвал цену; сколько вызовов
      // прошло мимо счёта, говорим вслух, иначе потолок выглядел бы точнее,
      // чем он есть.
      personal: user?.monthly_limit_usd !== null && user?.monthly_limit_usd !== undefined,
    };
  }
  // Потолок исчерпан — журнал продолжает работать, но без платных моделей:
  // отказать в сохранении записи значило бы потерять мысль человека из-за
  // бухгалтерии. Поэтому разбор просто идёт по правилам.
  // Понижение до правил надо не просто выполнить, но и объяснить: иначе запись
  // молча разбирается хуже обычного, и человек считает это поломкой. Здесь же
  // выясняется, что поехало бы без потолка, — «понизили» имеет смысл только
  // тогда, когда было с чего понижать.
  async function spendGate(user, requested) {
    const budget = spendState(user);
    if (budget.allowed) return { provider: requested, budget, downgraded: false };
    const wanted = await snapshotProvider(ai, requested);
    return { provider: 'fallback', budget, downgraded: wanted !== 'fallback', wanted };
  }
  const noteDowngrade = (result, gate) => { if (gate.downgraded) { result.requestedProvider = gate.wanted; result.fallbackReason = 'spend_limit'; } return result; };
  const SPEND_EXHAUSTED = 'Потолок расходов на месяц исчерпан.';
  // ── память помощника ────────────────────────────────────────────────────
  // Всё, что помощник вывел из поправок или запомнил с голоса, человек может
  // прочитать, дописать и стереть. Память, которую нельзя посмотреть, доверия
  // не заслуживает: она молча правит разбор.
  app.get('/api/agent/memory',(req,res,next)=>{try{res.json({memories:listFacts(db,{userId:req.user.id}),canShare:req.user.role==='admin'});}catch(error){next(error);}});
  app.post('/api/agent/memory',(req,res,next)=>{try{
    const text=typeof req.body?.text==='string'?req.body.text.trim():'';
    if(!text||text.length>MEMORY_TEXT_LIMIT)return res.status(400).json({error:{code:'invalid_memory',message:requestText(req,'Правило — от 1 до {limit} символов.',{limit:MEMORY_TEXT_LIMIT})}});
    const subject=typeof req.body?.subject==='string'?req.body.subject.trim():'';
    if(subject.length>MEMORY_SUBJECT_LIMIT)return res.status(400).json({error:{code:'invalid_memory',message:requestText(req,'Тема — до {limit} символов.',{limit:MEMORY_SUBJECT_LIMIT})}});
    const kind=req.body?.kind??'rule';
    if(!['rule','preference','fact','term'].includes(kind))return res.status(400).json({error:{code:'invalid_memory',message:'Некорректный вид правила.'}});
    const scope=req.body?.scope??'user';
    if(scope!=='user'&&scope!=='shared')return res.status(400).json({error:{code:'invalid_memory',message:'Память бывает личная или общая.'}});
    // Общая память — одна на всех, поэтому и правит её тот, кто отвечает за
    // установку. Человек пишет только в свою.
    if(scope==='shared'&&req.user.role!=='admin')return res.status(403).json({error:{code:'forbidden',message:'Общую память правит администратор.'}});
    const saved=rememberFact(db,{userId:scope==='shared'?null:req.user.id,kind,subject:subject||text,body:text,source:'manual',confidence:0.95});
    if(saved.error)return res.status(400).json({error:{code:'invalid_memory',message:'Не получилось запомнить.'}});
    res.status(saved.created?201:200).json({memory:listFacts(db,{userId:req.user.id}).find(item=>item.id===saved.id)||null,memories:listFacts(db,{userId:req.user.id}),canShare:req.user.role==='admin'});
  }catch(error){next(error);}});
  app.delete('/api/agent/memory/:id',(req,res,next)=>{try{
    const result=forgetFact(db,{userId:req.user.id,memoryId:req.params.id,shared:req.user.role==='admin'});
    if(result.notFound)return res.status(404).json({error:{code:'not_found',message:'Правило не найдено.'}});
    res.json({forgotten:true,memories:listFacts(db,{userId:req.user.id}),canShare:req.user.role==='admin'});
  }catch(error){next(error);}});
  // ── карта журнала ───────────────────────────────────────────────────────
  // Тот же снимок, что уходит в голову разговора: проекты, типы, метки, что
  // горит. Отдаётся и наружу — по нему одинаково ориентируются и голос, и
  // любой другой помощник, работающий с этим журналом.
  app.get('/api/journal/overview',(req,res,next)=>{try{res.json(journalOverview(db,{userId:req.user.id,now:now(),timeZone:requestTimeZone(req)}));}catch(error){next(error);}});
  app.get('/api/journal/entries',(req,res,next)=>{try{
    const query=req.query||{};
    const text=value=>typeof value==='string'&&value.trim()?value.trim().slice(0,200):undefined;
    const result=listJournal(db,{userId:req.user.id,now:now(),timeZone:requestTimeZone(req),
      project:text(query.project),type:text(query.type),status:['open','done','overdue','any'].includes(query.status)?query.status:'any',
      priority:['low','high'].includes(query.priority)?query.priority:undefined,tag:text(query.tag),person:text(query.person),
      from:text(query.from),to:text(query.to),query:text(query.query),limit:query.limit,offset:query.offset});
    if(result.error==='unknown_type')return res.status(400).json({error:{code:'unknown_type',message:'Неизвестный тип записи.'}});
    res.json(result);
  }catch(error){next(error);}});
  app.post('/api/reset',(req,res,next)=>{if(req.body?.confirmation!=='СБРОСИТЬ КИЗУНА')return res.status(400).json({error:{code:'invalid_confirmation',message:'Требуется точная фраза подтверждения.'}});try{const mine=db.prepare('SELECT a.id FROM capture_attachments a JOIN captures c ON c.id=a.capture_id WHERE c.user_id IS ?').all(req.user.id);resetLedger(db,req.user.id);db.prepare('DELETE FROM notifications WHERE user_id=?').run(req.user.id);for(const row of mine){try{fs.rmSync(attachmentPath(row.id),{force:true});}catch{}}reportAudit(audit,{event:'local_data_reset',result:'succeeded'});notifyJournal('reset');res.json({ok:true});}catch(error){reportAudit(audit,{event:'local_data_reset',result:'failed',errorCode:'storage_error'});next(error);}});
  // ── вложения ──
  // Тело приходит сырыми байтами: base64 в JSON раздул бы запрос на треть, а
  // multipart потребовал бы зависимости ради одного поля.
  app.post('/api/captures/:id/attachments', express.raw({ type:'*/*', limit: ATTACHMENT_SIZE_LIMIT }), (req,res,next)=>{
    try {
      if (!ownsCapture(req,res,req.params.id)) return;
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      if (!bytes || !bytes.length) return res.status(400).json({error:{code:'empty_attachment',message:'Файл пустой.'}});
      const declared = String(req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      const contentType = ATTACHMENT_TYPES.has(declared) ? declared : 'application/octet-stream';
      const filename = safeFilename(req.get('X-Attachment-Name') ? decodeURIComponent(req.get('X-Attachment-Name')) : '');
      const saved = addAttachment(db, req.params.id, { filename, contentType, bytes });
      if (saved.notFound) return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});
      if (saved.tooMany) return res.status(409).json({error:{code:'too_many_attachments',message:requestText(req,'К записи можно приложить не больше {limit} файлов.',{limit:saved.limit})}});
      // Файл пишется только после того, как строка легла в базу: иначе на диске
      // оставались бы байты, о которых журнал ничего не знает.
      fs.writeFileSync(attachmentPath(saved.id), bytes, { mode: 0o600 });
      reportAudit(audit,{event:'attachment_added',result:'succeeded'});
      notifyJournal('attachment');
      res.status(201).json({ attachment: saved, attachments: attachmentsFor(db, req.params.id) });
    } catch(error){ next(error); }
  });
  app.get('/api/attachments/:id',(req,res,next)=>{
    try {
      if (!validAttachmentId(req.params.id)) return res.status(400).json({error:{code:'invalid_attachment_id',message:'Некорректный идентификатор вложения.'}});
      const found = attachmentOwner(db, req.params.id) === req.user.id ? findAttachment(db, req.params.id) : null;
      if (!found) return res.status(404).json({error:{code:'not_found',message:'Вложение не найдено.'}});
      const file = attachmentPath(found.id);
      if (!fs.existsSync(file)) return res.status(410).json({error:{code:'attachment_gone',message:'Файл вложения не найден на диске.'}});
      const inline = INLINE_TYPES.has(found.contentType);
      res.set({
        'Content-Type': found.contentType,
        'Content-Length': String(found.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        // Имя уходит только в заголовке и только в кодировке RFC 5987:
        // кириллица и пробелы не ломают ответ, а сам файл на диске зовётся id.
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
      });
      fs.createReadStream(file).pipe(res);
    } catch(error){ next(error); }
  });
  app.delete('/api/attachments/:id',(req,res,next)=>{
    try {
      if (!validAttachmentId(req.params.id)) return res.status(400).json({error:{code:'invalid_attachment_id',message:'Некорректный идентификатор вложения.'}});
      if (attachmentOwner(db, req.params.id) !== req.user.id) return res.status(404).json({error:{code:'not_found',message:'Вложение не найдено.'}});
      const removed = removeAttachment(db, req.params.id);
      if (removed.notFound) return res.status(404).json({error:{code:'not_found',message:'Вложение не найдено.'}});
      try { fs.rmSync(attachmentPath(removed.id), { force: true }); } catch {}
      reportAudit(audit,{event:'attachment_removed',result:'succeeded'});
      notifyJournal('attachment');
      res.json({ ...removed, attachments: attachmentsFor(db, removed.captureId) });
    } catch(error){ next(error); }
  });
  app.use('/public',express.static(path.join(__dirname,'..','public'),{index:false,dotfiles:'deny'}));
  // Без учётной записи открывается только вход: приложение целиком, включая
  // журнал, живёт за ним.
  // Сервис-воркер живёт в корне: его область действия — весь адрес, а из
  // /public/ он видел бы только /public/. Манифест — рядом, ради «Домой» на iPhone.
  app.get('/sw.js',(req,res)=>{ res.set({ 'Cache-Control':'no-store', 'Content-Type':'text/javascript; charset=utf-8' }); res.sendFile(path.join(__dirname,'..','public','sw.js')); });
  app.get('/manifest.webmanifest',(req,res)=>{ res.set({ 'Content-Type':'application/manifest+json; charset=utf-8' }); res.sendFile(path.join(__dirname,'..','public','manifest.webmanifest')); });
  app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'..','public','auth.html')));
  // Гостю корень показывает, что это за приложение, а не форму входа: по
  // ссылке человек попадал на поле почты и не понимал, куда пришёл.
  app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'..','public',req.user?'app.html':'hello.html')));
  // Макеты и черновики в репозитории не живут, поэтому и раздавать их нечем:
  // раньше здесь была дверь к концепт-страницам в корне проекта.
  app.use((req,res)=>res.status(404).json({error:{code:'not_found',message:'Не найдено.'}}));
  // Ошибка разбора тела — вина запроса, а не сервера: express.json() помечает
  // такие ошибки типом entity.*/encoding.* и своим статусом (400 на битый JSON,
  // 413 на превышенный лимит). Без этой ветки клиент получал 500 «internal_error»
  // на собственную опечатку и не мог отличить свою ошибку от отказа сервера.
  const bodyErrorCodes={400:'invalid_json',413:'payload_too_large',415:'unsupported_media_type'};
  const bodyErrorMessages={400:'Не удалось разобрать тело запроса.',413:'Тело запроса слишком велико.',415:'Неподдерживаемый формат тела запроса.'};
  app.use((error,req,res,next)=>{if(res.headersSent)return next(error);const status=Number(error?.status||error?.statusCode);if(typeof error?.type==='string'&&(error.type.startsWith('entity.')||error.type.startsWith('encoding.'))&&status>=400&&status<500)return res.status(status).json({error:{code:bodyErrorCodes[status]||'invalid_request',message:bodyErrorMessages[status]||'Некорректный запрос.'}});res.status(500).json({error:{code:'internal_error',message:'Не удалось обработать запрос.'}});});
  return app;
}
// Аудит службы — в stdout, то есть в journalctl: события у кода были всегда
// (удаление записи, экспорт, блокировка, ошибки календаря), но сборщик по
// умолчанию пустой, и они падали в никуда. Одной строкой в JSON, чтобы журнал
// можно было грепать и читать через `journalctl -u kizuna -o cat | jq`.
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=createApp({audit:(event)=>{try{console.log(JSON.stringify({at:new Date().toISOString(),...event}));}catch{}}});const server=app.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>{app.captureJobWorker.start();app.calendarSyncWorker.start();app.reminderWorker.start();app.telegram.start();console.log('Kizuna server started.');});let shuttingDown=false;const shutdown=()=>{if(shuttingDown)return;shuttingDown=true;
  // Потоки событий держали ответы открытыми, и server.close ждал их вечно:
  // systemd убивал процесс по таймауту через 90 с — каждый деплой давал
  // полторы минуты простоя. Потоки закрываем сами, простаивающие соединения
  // тоже, а на всё выключение — жёсткий срок.
  const deadline=setTimeout(()=>process.exit(0),10000);deadline.unref();
  app.closeEventStreams();
  Promise.allSettled([app.captureJobWorker.stop(),app.calendarSyncWorker.stop(),app.reminderWorker.stop(),app.telegram.stop()]).finally(()=>{server.close(()=>process.exit(0));server.closeIdleConnections?.();});};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);}
