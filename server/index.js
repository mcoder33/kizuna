import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, createLedger, deleteCapture, restoreCapture, saveNote, NOTE_BODY_LIMIT, readSettings, writeSettings, recordUsage, usageSummary, attachmentsFor, addAttachment, findAttachment, removeAttachment, ATTACHMENT_SIZE_LIMIT, ATTACHMENTS_PER_CAPTURE, enqueueCaptureJob, cancelCaptureJob, retryCaptureJob, getCaptureJob, getAggregate, replaceInterpretation, completeProjection, undoProjectionCompletion, dayView, getDailyBrief, findDailyBrief, findDailyBriefSource, listEntries, undo, search, exportLedger, resetLedger, fullEntry } from './db.js';
import { createAiService } from './ai.js';
import { createVoiceService, runVoiceTool, mockVoiceTurn, VOICE_TOOLS, VOICE_INSTRUCTIONS, VOICE_CHOICES, buildVoiceInstructions, DEFAULT_VOICE_CHARACTER } from './voice.js';
import { CaptureJobWorker } from './capture-job-worker.js';
import { normalizeClassification, gateClassification, shouldMaterializeProjections, parseCaptureOverrides, applyUserOverrides } from './classifier.js';
import { validateRemoteModel } from './cli-config.js';
import { createAccounts, publicUser } from './accounts.js';
import { periodReport, dayReport, shiftDate as reportShiftDate } from './reports.js';
import { boardView, createColumn, renameColumn, moveColumn, deleteColumn, moveCard } from './board.js';
import { captureOwner, attachmentOwner, projectionOwner, undoGroupOwner, openVoiceSession, closeVoiceSession, closeStaleVoiceSessions, voiceSpend, monthlySpend, findUserById, countUsers } from './db.js';

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
function validSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const { date = null, time = null } = schedule;
  if (date !== null) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false; const [year, month, day] = date.split('-').map(Number); const parsed = new Date(Date.UTC(year, month - 1, day)); if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false; }
  if (time !== null && (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0,2)) > 23 || Number(time.slice(3)) > 59)) return false;
  return true;
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
function completionError(res, error) { const errors={not_found:[404,'not_found','Проекция не найдена.'],inactive:[409,'projection_inactive','Проекция больше не активна.'],not_completable:[409,'projection_not_completable','Завершать можно только задачи и встречи.']}; const [status,code,message]=errors[error]; return res.status(status).json({error:{code,message}}); }
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
  openaiKey: { env:'OPENAI_API_KEY', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 400 },
  geminiKey: { env:'GEMINI_API_KEY', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 400 },
  openrouterKey: { env:'OPENROUTER_API_KEY', secret:true, admin:true, check:value => typeof value === 'string' && value.length <= 400 },
  aiProvider: { env:'PAGENT_AI_PROVIDER', admin:true, check:value => providerIds.has(value) },
  voiceProvider: { env:'PAGENT_VOICE_PROVIDER', admin:true, check:value => value === 'openai' || value === 'gemini' },
  // Голос выбирается из каталога: от него зависит род, в котором модель говорит
  // о себе, поэтому произвольная строка здесь только сломала бы согласование.
  voiceName: { env:'PAGENT_VOICE_NAME', admin:true, check:value => VOICE_CHOICES.openai.some(item => item.id === value) },
  geminiVoiceName: { env:'PAGENT_GEMINI_VOICE_NAME', admin:true, check:value => VOICE_CHOICES.gemini.some(item => item.id === value) },
  // Модель голоса: у OpenAI живой режим принимает и realtime-, и audio-модели,
  // поэтому список открытый — проверяем только форму имени.
  voiceModel: { env:'PAGENT_VOICE_MODEL', admin:true, check:value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,60}$/.test(value) },
  geminiVoiceModel: { env:'PAGENT_GEMINI_VOICE_MODEL', admin:true, check:value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,80}$/.test(value) },
  // Добавка к системному промпту разговора: правила инструментов и памяти она
  // не отменяет, а дописывается к ним.
  systemPrompt: { personal:true, check:value => typeof value === 'string' && value.length <= 2000 },
  timeZone: { env:'PAGENT_TIMEZONE', admin:true, check:value => { try { new Intl.DateTimeFormat('en-CA', { timeZone:value }); return true; } catch { return false; } } },
  // Настройки интерфейса живут здесь же: они про человека, а не про вкладку,
  // поэтому переживают смену браузера.
  sleepAfterSeconds: { personal:true, check:value => /^\d+$/.test(String(value)) && Number(value) >= 10 && Number(value) <= 600 },
  wakeWord: { personal:true, check:value => typeof value === 'string' && value.trim().length >= 2 && value.length <= 40 },
  previewLimit: { personal:true, check:value => /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 20 },
  // Тема оформления. Хранится у человека, а не во вкладке: со сменой браузера
  // светлая тема не должна возвращаться сама.
  theme: { personal:true, check:value => ['system','light','dark'].includes(value) },
  // ── предел расхода на разговор ──
  // Звук идёт мимо сервера, поэтому денег мы не видим: считаем минуты и
  // умножаем на заданную цену. Предел по минутам работает и без цены — это
  // важнее, чем красивая сумма, потому что перекрыть разговор надо наверняка.
  voiceRateUsdPerMinute: { admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100 },
  voiceGeminiRateUsdPerMinute: { admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100 },
  voiceLimitUsd: { admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e6 },
  voiceLimitMinutes: { admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e6 },
  voiceLimitWindow: { admin:true, check:value => ['day','week','month','total'].includes(value) },
  voiceEnabled: { admin:true, check:value => value === 'on' || value === 'off' },
  // Потолок расходов на месяц. В отличие от предела разговора считает всё, за
  // что платят деньгами: вызовы модели, у которых провайдер назвал цену, и
  // оценку разговора. Здесь — общий для всех; своё значение человеку ставит
  // администратор в разделе «Пользователи».
  monthlyLimitUsd: { admin:true, check:value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e6 },
};
// Голоса по умолчанию те же, что и у самой службы: без них выпадающий список
// открывался бы пустым, хотя разговор уже идёт каким-то голосом.
const SETTING_DEFAULTS = { sleepAfterSeconds:'25', wakeWord:'кизуна', previewLimit:'3', voiceName:'coral', geminiVoiceName:'Leda', systemPrompt:DEFAULT_VOICE_CHARACTER, voiceModel:'gpt-realtime', geminiVoiceModel:'models/gemini-3.1-flash-live-preview', theme:'system',
  // Цены по умолчанию нет намеренно: выдумать её значит показать человеку
  // сумму, которой он не платил. Пока цену не задали, работает предел по
  // минутам, а деньги честно показываются как неизвестные.
  voiceRateUsdPerMinute:'0', voiceGeminiRateUsdPerMinute:'0', voiceLimitUsd:'', voiceLimitMinutes:'', voiceLimitWindow:'day', voiceEnabled:'on', monthlyLimitUsd:'' };
// Личная настройка лежит под своим ключом: у каждого своя строчка, общая
// таблица одна.
const personalKey = (userId, name) => `user:${userId}:${name}`;
function settingValue(stored, env, name, userId) {
  const rule = SETTINGS[name];
  const own = rule.personal && userId ? stored[personalKey(userId, name)] : undefined;
  return own ?? stored[name] ?? (rule.env ? env[rule.env] : undefined) ?? SETTING_DEFAULTS[name] ?? null;
}
function secretHint(value) { return value ? `••••${String(value).slice(-4)}` : null; }
// createVoiceService по умолчанию читает process.env напрямую; здесь ей отдаётся
// то же окружение, но с настройками из приложения поверх.
function voiceOptions(env) {
  return {
    apiKey: env.OPENAI_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
    provider: env.PAGENT_VOICE_PROVIDER,
    model: env.PAGENT_VOICE_MODEL || undefined,
    geminiModel: env.PAGENT_GEMINI_VOICE_MODEL || undefined,
    voice: env.PAGENT_VOICE_NAME || undefined,
    geminiVoice: env.PAGENT_GEMINI_VOICE_NAME || undefined,
  };
}
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
const ATTACHMENT_TYPES = new Set([...INLINE_TYPES, 'application/zip','application/json','text/csv','audio/mpeg','audio/wav','video/mp4','application/octet-stream']);
// Имя приходит от человека: оставляем только базовую часть без путей и
// управляющих символов, а на диске файл всё равно называется своим id.
function safeFilename(value) {
  const raw = typeof value === 'string' ? value : '';
  const base = path.basename(raw.replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : 'файл';
}
function validAttachmentId(value) { return validJobId(value); }
function captureRequestFingerprint({ raw, occurredAt, selectedProvider, selectedModel = null, overrides = null }) { return crypto.createHash('sha256').update(JSON.stringify({ raw, occurredAt:typeof occurredAt === 'string' ? occurredAt : null, selectedProvider, selectedModel, overrides })).digest('hex'); }
function correctionRequestFingerprint(patch) { return crypto.createHash('sha256').update(JSON.stringify(patch)).digest('hex'); }
function reportAudit(audit, event) { try { audit(event); } catch {} }
// Расход записывается рядом с ответом модели и никогда не мешает делу: сбой
// учёта не должен ронять разбор записи.
function noteUsage(db, result, kind, userId = null) {
  try {
    if (!result?.usage || !result.usedProvider || result.usedProvider === 'fallback') return;
    recordUsage(db, { provider:result.usedProvider, model:result.model || null, kind, inputTokens:result.usage.inputTokens, outputTokens:result.usage.outputTokens, costUsd:result.usage.costUsd, userId });
  } catch {}
}
function correctedClassification(original,patch){const entities={...original.entities,projects:patch.project===undefined?original.entities.projects:(patch.project?[patch.project.trim()]:[]),people:patch.people===undefined?original.entities.people:patch.people.map(person=>person.trim()).filter(Boolean),followUp:patch.followUp===undefined?original.entities.followUp:(patch.followUp?.trim()||null),schedule:patch.schedule===undefined?original.entities.schedule:{state:patch.schedule.date&&patch.schedule.time?'ok':'ambiguous',date:patch.schedule.date||null,time:patch.schedule.time||null,sortAt:patch.schedule.date?`${patch.schedule.date}T${patch.schedule.time||'23:59'}:00`:null,display:[patch.schedule.date,patch.schedule.time].filter(Boolean).join(', ')}};const clearsAmbiguity=Boolean(original.ambiguity)&&patch[{type:'primaryType',schedule:'schedule',projects:'project',people:'people',followUp:'followUp'}[original.ambiguity.field]||'primaryType']!==undefined;const classification={...original,primaryType:patch.primaryType||original.primaryType,summary:patch.summary===undefined?original.summary:patch.summary.trim(),entities,completed:patch.completed===undefined?Boolean(original.completed):patch.completed,unclassified:original.unclassified&&patch.primaryType===undefined?true:undefined,ambiguity:clearsAmbiguity?null:(original.ambiguity??null),conflicts:{projects:patch.project!==undefined?false:original.conflicts?.projects,schedule:patch.schedule!==undefined?false:original.conflicts?.schedule},claims:(original.claims||[]).map(claim=>{const map={type:'primaryType',projects:'project',people:'people',followUp:'followUp',schedule:'schedule'};return patch[map[claim.field]]!==undefined?{...claim,value:claim.field==='type'?(patch.primaryType||original.primaryType):entities[claim.field],confidence:1,kind:'fact',provenance:{source:'raw',evidence:'manual correction'}}:claim})};classification.confidence=Object.fromEntries(classification.claims.map(claim=>[claim.field,claim.confidence]));return classification;}
function applyCorrection(db,req,res,next,notify=()=>{}){try{const active=getAggregate(db,req.params.id);if(!active)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});const body=req.body||{},patch=body.patch||body,providedKey=req.get('Idempotency-Key');if(providedKey!==undefined&&!validIdempotencyKey(providedKey))return res.status(400).json({error:{code:'invalid_idempotency_key',message:'Некорректный ключ идемпотентности.'}});if(patch.primaryType!==undefined&&!['meeting_event','task','note','outcome_decision','idea_question'].includes(patch.primaryType))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректный тип записи.'}});if(patch.schedule!==undefined&&!validSchedule(patch.schedule))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректная дата или время.'}});if(patch.project!==undefined&&patch.project!==null&&(typeof patch.project!=='string'||patch.project.length>120))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректный проект.'}});if(patch.people!==undefined&&(!Array.isArray(patch.people)||patch.people.length>8||patch.people.some(person=>typeof person!=='string'||person.length>120)))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректные участники.'}});if(patch.followUp!==undefined&&patch.followUp!==null&&(typeof patch.followUp!=='string'||patch.followUp.length>500))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректное действие.'}}); if(patch.completed!==undefined&&typeof patch.completed!=='boolean')return res.status(400).json({error:{code:'invalid_patch',message:'Некорректный признак выполнения.'}});if(patch.summary!==undefined&&(typeof patch.summary!=='string'||!patch.summary.trim()||patch.summary.trim().length>500))return res.status(400).json({error:{code:'invalid_patch',message:'Заголовок — от 1 до 500 символов.'}});const requestFingerprint=correctionRequestFingerprint(patch),operationKey=providedKey||`correction-${requestFingerprint}`,classification=correctedClassification(JSON.parse(active.classification_json),patch),review=gateClassification(classification),replacement=replaceInterpretation(db,req.params.id,classification,'manual',{...patch,patch,operationKey,requestFingerprint},shouldMaterializeProjections(classification));if(replacement?.conflict)return res.status(409).json({error:{code:'idempotency_conflict',message:'Ключ уже использован для другого уточнения.'}});const row=getAggregate(db,req.params.id);notify();res.json({entry:fullEntry(db,row),undoGroupId:replacement.undoGroupId,review,replayed:Boolean(replacement.replayed)});}catch(error){next(error);}}
async function snapshotProvider(ai, requested) { if (requested) return requested; const status = await ai.status(); return providerIds.has(status?.selectedProvider) ? status.selectedProvider : providerIds.has(status?.defaultProvider) ? status.defaultProvider : 'fallback'; }
export function createApp({ databasePath = process.env.PAGENT_DB_PATH || path.join(__dirname, '..', 'data', 'pagent.sqlite'), aiService, voiceService, timeZone = process.env.PAGENT_TIMEZONE || 'Europe/Samara', now = () => new Date(), workerOptions, audit = () => {}, secureCookies = process.env.PAGENT_SECURE_COOKIES === 'on' } = {}) {
  const db = openDatabase(databasePath);
  const accounts = createAccounts({ db, now, secureCookies, audit, timeZone: () => configuredTimeZone });
  // Настройки читаются из базы поверх окружения: то, что человек поменял в
  // приложении, сильнее того, что лежит в .env, и применяется без перезапуска.
  let stored = readSettings(db);
  const environment = () => environmentWith(stored, process.env);
  let configuredTimeZone = validateTimeZone(stored.timeZone || timeZone);
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
  };
  // Разбор заканчивается в воркере, а не в запросе: там журнал и меняется.
  const workerAudit = (event) => { try { audit(event); } finally { if (event?.event === 'capture_job_succeeded' || event?.event === 'capture_job_failed') notifyJournal('job'); } };
  const captureJobWorker = new CaptureJobWorker({ db, ai, now, audit: workerAudit, ...workerOptions });
  let voice = voiceService || createVoiceService(voiceOptions(environment()));
  // Смена ключа, голоса или пояса пересобирает службы на месте: перезапускать
  // сервер ради строчки в настройках человек не должен.
  function rebuildServices() {
    stored = readSettings(db);
    const env = environment();
    try { configuredTimeZone = validateTimeZone(stored.timeZone || timeZone); } catch {}
    if (!aiService) ai = createAiService({ timeZone:configuredTimeZone, now, env });
    if (!voiceService) voice = createVoiceService(voiceOptions(env));
    captureJobWorker.ai = ai;
  }
  app.captureJobWorker = captureJobWorker;
  // Внутренние ручки для тестов и для запуска: наружу по HTTP они не выходят.
  app.accounts = accounts;
  app.database = db;
  app.disable('x-powered-by');
  app.use(express.json({ limit:'32kb' }));
  // Кто перед нами — выясняется до всего остального, но никого не заворачивает:
  // страница входа и заявка на регистрацию должны работать без учётной записи.
  app.use(accounts.attachUser);
  app.use((req,res,next)=>{ if(req.path==='/'||req.path.startsWith('/api/')||req.path.startsWith('/public/')) res.set({'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}); next(); });
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
  app.get('/api/events',(req,res)=>{
    res.set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-store', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
    res.flushHeaders?.();
    // Первое сообщение сразу: клиент понимает, что поток жив, и не ждёт таймаута.
    res.write(`event: ready\ndata: ${JSON.stringify({ at: now().toISOString() })}\n\n`);
    journalListeners.add(res);
    // Комментарий раз в 25 секунд держит соединение открытым через прокси.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    beat.unref?.();
    const drop = () => { clearInterval(beat); journalListeners.delete(res); };
    req.on('close', drop);
    res.on('close', drop);
  });
  // ── настройки ──
  app.get('/api/settings',(req,res)=>{
    res.json({ settings: publicSettings(stored, process.env, req.user), editable: editableSettings(req.user), voice: voice.status(), voices: VOICE_CHOICES, timeZone: configuredTimeZone, quota: voiceQuota(req.user), spend: spendState(req.user) });
  });
  app.put('/api/settings',(req,res,next)=>{
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const next = {};
      for (const [name, value] of Object.entries(body)) {
        const rule = SETTINGS[name];
        if (!rule) return res.status(400).json({error:{code:'unknown_setting',message:`Неизвестная настройка: ${name}.`}});
        // Общая настройка — общая ответственность: ключи, провайдеры и пределы
        // меняет только администратор, остальное каждый правит у себя.
        if (!rule.personal && req.user.role !== 'admin') return res.status(403).json({error:{code:'forbidden',message:`Настройку «${name}» меняет администратор.`}});
        const key = rule.personal ? personalKey(req.user.id, name) : name;
        // Пустая строка и null означают «вернуть значение из окружения».
        if (value === null || value === '') { next[key] = null; continue; }
        if (!rule.check(value)) return res.status(400).json({error:{code:'invalid_setting',message:`Некорректное значение настройки: ${name}.`}});
        next[key] = String(value).trim();
      }
      writeSettings(db, next);
      rebuildServices();
      reportAudit(audit,{event:'settings_changed',result:'succeeded',keys:Object.keys(next)});
      res.json({ settings: publicSettings(stored, process.env, req.user), editable: editableSettings(req.user), voice: voice.status(), voices: VOICE_CHOICES, timeZone: configuredTimeZone, quota: voiceQuota(req.user), spend: spendState(req.user) });
    } catch(error){ next(error); }
  });
  app.get('/api/usage',(req,res,next)=>{try{res.json({...usageSummary(db,{now:now(),userId:req.user.id}),spend:spendState(req.user)});}catch(error){next(error);}});
  app.get('/api/status', async (req,res,next)=>{try{const provider=requestedProvider(req.query.selectedProvider);if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});res.json(await ai.status(provider));}catch(error){next(error);}});
  app.post('/api/captures/:id/corrections',(req,res,next)=>{ if(!ownsCapture(req,res,req.params.id))return; applyCorrection(db,req,res,next,()=>notifyJournal('correction')); });
  app.post('/api/captures', async (req,res,next)=> { const lifecycle=requestAbortSignal(req,res);try { const raw = typeof req.body?.raw === 'string' ? req.body.raw.trim() : '',provider=requestedProvider(req.body?.provider),selectedModelValue=requestedModel(req.body?.model); if (selectedModelValue===null) return res.status(400).json({error:{code:'invalid_model',message:'Некорректная модель.'}}); if (!raw || raw.length > 10000) return res.status(400).json({error:{code:'invalid_capture',message:'Запись должна содержать от 1 до 10 000 символов.'}});if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const parsedOverrides=parseCaptureOverrides(req.body,now(),configuredTimeZone);if(parsedOverrides.error)return res.status(400).json({error:{code:parsedOverrides.error,message:'Некорректные параметры записи.'}});const overrides=parsedOverrides.overrides;if(wantsAsyncResponse(req.get('Prefer'))){const idempotencyKey=req.get('Idempotency-Key');if(idempotencyKey!==undefined&&!validIdempotencyKey(idempotencyKey))return res.status(400).json({error:{code:'invalid_idempotency_key',message:'Некорректный ключ идемпотентности.'}});const gate=await spendGate(req.user,provider);const selectedProvider=await snapshotProvider(ai,gate.provider);const selectedModel=selectedModelValue||null;const queued=enqueueCaptureJob(db,{userId:req.user.id,raw,occurredAt:req.body.occurredAt,selectedProvider,selectedModel,idempotencyKey:idempotencyKey||null,requestFingerprint:idempotencyKey?captureRequestFingerprint({raw,occurredAt:req.body.occurredAt,selectedProvider,selectedModel,overrides}):null,overrides});if(queued.conflict)return res.status(409).json({error:{code:'idempotency_conflict',message:'Ключ уже использован для другого запроса.'}});const duplicate=db.prepare('SELECT id FROM captures WHERE deleted_at IS NULL AND user_id IS ? AND raw=? AND id!=? AND created_at>=? ORDER BY created_at DESC LIMIT 1').get(req.user.id,raw,queued.captureId,new Date(now().getTime()-24*60*60*1000).toISOString());const statusUrl=jobStatusUrl(queued.jobId);captureJobWorker.wake();notifyJournal('queued');res.location(statusUrl).status(202).json({captureId:queued.captureId,jobId:queued.jobId,statusUrl,...(duplicate?{duplicateCaptureId:duplicate.id}:{}),...(gate.budget.allowed?{}:{spend:gate.budget})});return;}const gate=await spendGate(req.user,provider);const result = noteDowngrade(await ai.classify(raw, gate.provider, lifecycle.signal, selectedModelValue||null), gate);noteUsage(db,result,'classify',req.user.id);if(lifecycle.signal.aborted)return; if(overrides)result.classification=applyUserOverrides(result.classification,overrides,now(),configuredTimeZone); const review=gateClassification(result.classification); const ids = createLedger(db,{userId:req.user.id,raw,occurredAt:req.body.occurredAt, ...result,createProjections:shouldMaterializeProjections(result.classification)}); const row=getAggregate(db,ids.captureId); notifyJournal('capture'); res.status(201).json({entry:fullEntry(db,row),undoGroupId:ids.undoGroupId,review,provenance:{requestedProvider:result.requestedProvider,usedProvider:result.usedProvider,provider:result.provider,model:result.model,fallbackReason:result.fallbackReason},...(gate.budget.allowed?{}:{spend:gate.budget})}); } catch(error){if(!lifecycle.signal.aborted)next(error);}finally{lifecycle.dispose();} });
  app.get('/api/jobs/:id',(req,res)=>{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_job_id',message:'Некорректный идентификатор задачи.'}});const job=getCaptureJob(db,req.params.id);if(!job||job.userId!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});res.json(publicJob(job));});
  app.post('/api/jobs/:id/cancel',(req,res)=>{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_job_id',message:'Некорректный идентификатор задачи.'}});const existing=getCaptureJob(db,req.params.id);if(existing&&existing.userId!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});const cancelled=cancelCaptureJob(db,req.params.id);if(!cancelled)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});if(cancelled.changed)captureJobWorker.abort(req.params.id);res.status(cancelled.changed?202:200).json(publicJob(getCaptureJob(db,req.params.id)));});
  app.post('/api/jobs/:id/retry',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_job_id',message:'Некорректный идентификатор задачи.'}});if(Object.hasOwn(req.body||{},'provider'))return res.status(400).json({error:{code:'retry_provider_not_allowed',message:'Повтор использует исходного провайдера.'}});const existing=getCaptureJob(db,req.params.id);if(existing&&existing.userId!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});const retry=retryCaptureJob(db,req.params.id);if(!retry)return res.status(404).json({error:{code:'not_found',message:'Задача не найдена.'}});if(retry.invalidState)return res.status(409).json({error:{code:'retry_not_allowed',message:'Повтор возможен только для отменённой или неудачной задачи.'}});captureJobWorker.wake();const statusUrl=jobStatusUrl(retry.jobId);res.location(statusUrl).status(202).json({...retry,statusUrl});}catch(error){next(error);}});
  app.post('/api/captures/:id/classify', async (req,res,next)=> { const lifecycle=requestAbortSignal(req,res);try { const provider=requestedProvider(req.body?.provider);if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const selectedModelValue=requestedModel(req.body?.model);if(selectedModelValue===null)return res.status(400).json({error:{code:'invalid_model',message:'Некорректная модель.'}});if(!ownsCapture(req,res,req.params.id))return;const budget=spendState(req.user);if(!budget.allowed)return res.status(429).json({error:{code:'spend_limit',message:SPEND_EXHAUSTED},spend:budget});const capture=db.prepare('SELECT raw FROM captures WHERE id=?').get(req.params.id); if(!capture) return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}}); const result=await ai.classify(capture.raw,provider,lifecycle.signal,selectedModelValue||null);noteUsage(db,result,'classify',req.user.id);if(lifecycle.signal.aborted)return;const review=gateClassification(result.classification); const replacement=replaceInterpretation(db,req.params.id,result.classification,result.provider,null,shouldMaterializeProjections(result.classification),result.model); const row=getAggregate(db,req.params.id); res.json({entry:fullEntry(db,row),undoGroupId:replacement.undoGroupId,review,provenance:{requestedProvider:result.requestedProvider,usedProvider:result.usedProvider,provider:result.provider,model:result.model,fallbackReason:result.fallbackReason}}); }catch(error){if(!lifecycle.signal.aborted)next(error);}finally{lifecycle.dispose();} });
  app.post('/api/captures/:id/corrections',(req,res,next)=>{ try { const active=getAggregate(db,req.params.id); if(!active) return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}}); const original=JSON.parse(active.classification_json); const body=req.body||{}, patch=body.patch||body; if(patch.primaryType!==undefined&&!['meeting_event','task','note','outcome_decision','idea_question'].includes(patch.primaryType))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректный тип записи.'}}); if(patch.schedule!==undefined&&!validSchedule(patch.schedule))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректная дата или время.'}}); if(patch.project!==undefined&&patch.project!==null&&(typeof patch.project!=='string'||patch.project.length>120))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректный проект.'}}); if(patch.people!==undefined&&(!Array.isArray(patch.people)||patch.people.length>8||patch.people.some(person=>typeof person!=='string'||person.length>120)))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректные участники.'}}); if(patch.followUp!==undefined&&patch.followUp!==null&&(typeof patch.followUp!=='string'||patch.followUp.length>500))return res.status(400).json({error:{code:'invalid_patch',message:'Некорректное действие.'}}); if(patch.completed!==undefined&&typeof patch.completed!=='boolean')return res.status(400).json({error:{code:'invalid_patch',message:'Некорректный признак выполнения.'}}); const entities={...original.entities,projects:patch.project===undefined?original.entities.projects:(patch.project?[patch.project.trim()]:[]),people:patch.people===undefined?original.entities.people:patch.people.map(person=>person.trim()).filter(Boolean),followUp:patch.followUp===undefined?original.entities.followUp:(patch.followUp?.trim()||null),schedule:patch.schedule===undefined?original.entities.schedule:{state:patch.schedule.date&&patch.schedule.time?'ok':'ambiguous',date:patch.schedule.date||null,time:patch.schedule.time||null,sortAt:patch.schedule.date?`${patch.schedule.date}T${patch.schedule.time||'23:59'}:00`:null,display:[patch.schedule.date,patch.schedule.time].filter(Boolean).join(', ')}}; const clearsAmbiguity=Boolean(original.ambiguity)&&patch[{type:'primaryType',schedule:'schedule',projects:'project',people:'people',followUp:'followUp'}[original.ambiguity.field]||'primaryType']!==undefined;const classification={...original,primaryType:patch.primaryType||original.primaryType,entities,completed:patch.completed===undefined?Boolean(original.completed):patch.completed,unclassified:original.unclassified&&patch.primaryType===undefined?true:undefined,ambiguity:clearsAmbiguity?null:(original.ambiguity??null),conflicts:{projects:patch.project!==undefined?false:original.conflicts?.projects,schedule:patch.schedule!==undefined?false:original.conflicts?.schedule},claims:(original.claims||[]).map(claim=>{const map={type:'primaryType',projects:'project',people:'people',followUp:'followUp',schedule:'schedule'};return patch[map[claim.field]]!==undefined?{...claim,value:claim.field==='type'?(patch.primaryType||original.primaryType):entities[claim.field],confidence:1,kind:'fact',provenance:{source:'raw',evidence:'manual correction'}}:claim})}; classification.confidence=Object.fromEntries(classification.claims.map(claim=>[claim.field,claim.confidence])); const review=gateClassification(classification); const replacement=replaceInterpretation(db,req.params.id,classification,'manual',patch,shouldMaterializeProjections(classification)); const row=getAggregate(db,req.params.id); res.json({entry:fullEntry(db,row),undoGroupId:replacement.undoGroupId,review}); }catch(error){next(error);} });
  // Удаление записи — мягкое: она уходит из всех списков, но остаётся в
  // журнале и в экспорте. Поэтому же её можно вернуть.
  app.delete('/api/captures/:id',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const result=deleteCapture(db,req.params.id);if(result.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});reportAudit(audit,{event:'capture_deleted',result:'succeeded'});notifyJournal('delete');res.json(result);}catch(error){next(error);}});
  app.post('/api/captures/:id/restore',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const result=restoreCapture(db,req.params.id);if(result.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});reportAudit(audit,{event:'capture_restored',result:'succeeded'});notifyJournal('restore');res.json(result);}catch(error){next(error);}});
  app.post('/api/projections/:id/complete',(req,res,next)=>{try{if(!validProjectionId(req.params.id))return res.status(400).json({error:{code:'invalid_projection_id',message:'Некорректный идентификатор проекции.'}});if(projectionOwner(db,req.params.id)!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Проекция не найдена.'}});const result=completeProjection(db,req.params.id);if(result.error)return completionError(res,result.error);notifyJournal('completion');res.json({projectionId:result.projection.id,completion:result.completion,changed:result.changed});}catch(error){next(error);}});
  app.post('/api/projections/:id/undo-complete',(req,res,next)=>{try{if(!validProjectionId(req.params.id))return res.status(400).json({error:{code:'invalid_projection_id',message:'Некорректный идентификатор проекции.'}});if(projectionOwner(db,req.params.id)!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Проекция не найдена.'}});const result=undoProjectionCompletion(db,req.params.id);if(result.error)return completionError(res,result.error);notifyJournal('completion');res.json({projectionId:result.projection.id,completion:result.completion,changed:result.changed});}catch(error){next(error);}});
  app.get('/api/entries',(req,res)=>{ const limit=Math.min(Math.max(Number(req.query.limit)||40,1),100); res.json(listEntries(db,{cursor:typeof req.query.cursor==='string'?req.query.cursor:null,limit,userId:req.user.id})); });
  // Доска: колонки и раскладка открытых дел. Ошибки одной картой: имя, лимит,
  // чужая или пропавшая колонка/карточка, кривой индекс.
  const boardError=(res,error)=>{const errors={invalid_name:[400,'Имя колонки — от 1 до 40 символов.'],columns_limit:[409,'Колонок может быть не больше 12.'],column_not_found:[404,'Колонка не найдена.'],card_not_found:[404,'Дело не найдено на доске.'],invalid_index:[400,'Некорректная позиция.']};const [status,message]=errors[error];return res.status(status).json({error:{code:error,message}});};
  app.get('/api/board',(req,res,next)=>{try{res.json(boardView(db,{userId:req.user.id,timeZone:configuredTimeZone,now:now(),includeClosed:req.query.done==='1'}));}catch(error){next(error);}});
  app.post('/api/board/columns',(req,res,next)=>{try{const result=createColumn(db,{userId:req.user.id,name:req.body?.name});if(result.error)return boardError(res,result.error);res.status(201).json(result.column);}catch(error){next(error);}});
  app.patch('/api/board/columns/:id',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_column_id',message:'Некорректный идентификатор колонки.'}});if(req.body?.name!==undefined){const result=renameColumn(db,{userId:req.user.id,id:req.params.id,name:req.body.name});if(result.error)return boardError(res,result.error);return res.json(result.column);}if(req.body?.index!==undefined){const result=moveColumn(db,{userId:req.user.id,id:req.params.id,index:req.body.index});if(result.error)return boardError(res,result.error);return res.json({order:result.order});}res.status(400).json({error:{code:'nothing_to_change',message:'Передайте name или index.'}});}catch(error){next(error);}});
  app.delete('/api/board/columns/:id',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_column_id',message:'Некорректный идентификатор колонки.'}});const result=deleteColumn(db,{userId:req.user.id,id:req.params.id});if(result.error)return boardError(res,result.error);res.json(result);}catch(error){next(error);}});
  app.post('/api/board/move',(req,res,next)=>{try{const {captureId,columnId=null,index}=req.body||{};if(!validJobId(captureId))return res.status(400).json({error:{code:'invalid_capture_id',message:'Некорректный идентификатор записи.'}});if(columnId!==null&&!validJobId(columnId))return res.status(400).json({error:{code:'invalid_column_id',message:'Некорректный идентификатор колонки.'}});const result=moveCard(db,{userId:req.user.id,captureId,columnId,index});if(result.error)return boardError(res,result.error);res.json(result);}catch(error){next(error);}});
  app.get('/api/reports',(req,res,next)=>{try{const period=typeof req.query.period==='string'?req.query.period:'week';if(!['week','month','all'].includes(period))return res.status(400).json({error:{code:'invalid_period',message:'Период должен быть week, month или all.'}});res.json(periodReport(db,{period,now:now(),timeZone:configuredTimeZone,userId:req.user.id}));}catch(error){next(error);}});
  // Сводка одного дня; по умолчанию — вчера: день, который уже закончился.
  app.get('/api/reports/day',(req,res,next)=>{try{const date=req.query.date||reportShiftDate(dateInTimeZone(now(),configuredTimeZone),-1);if(!validDate(date))return res.status(400).json({error:{code:'invalid_date',message:'Дата должна быть в формате YYYY-MM-DD.'}});res.json(dayReport(db,{date,now:now(),timeZone:configuredTimeZone,userId:req.user.id}));}catch(error){next(error);}});
  app.get('/api/day',(req,res)=>{const date=req.query.date||dateInTimeZone(now(),configuredTimeZone);if(!validDate(date))return res.status(400).json({error:{code:'invalid_date',message:'Дата должна быть в формате YYYY-MM-DD.'}});res.json({date,...dayView(db,date,now(),req.user.id)});});
  app.get('/api/daily-brief',(req,res,next)=>{try{const date=req.query.date||dateInTimeZone(now(),'Europe/Samara'), revision=req.query.revision; if(!validDate(date)||revision!==undefined&&(!/^\d+$/.test(revision)||Number(revision)<1))return res.status(400).json({error:{code:'invalid_daily_brief_request',message:'Некорректная дата или ревизия отчёта.'}}); const brief=revision===undefined?getDailyBrief(db,{date,timeZone:'Europe/Samara',userId:req.user.id}):findDailyBrief(db,{date,timeZone:'Europe/Samara',revision:Number(revision),userId:req.user.id}); if(!brief)return res.status(404).json({error:{code:'not_found',message:'Ревизия отчёта не найдена.'}}); res.json(brief);}catch(error){next(error);}});
  app.post('/api/daily-brief/refresh',(req,res,next)=>{try{const date=req.body?.date||dateInTimeZone(now(),'Europe/Samara');if(!validDate(date))return res.status(400).json({error:{code:'invalid_date',message:'Дата должна быть в формате YYYY-MM-DD.'}});res.json(getDailyBrief(db,{date,timeZone:'Europe/Samara',force:true,userId:req.user.id}));}catch(error){next(error);}});
  app.get('/api/daily-brief/:date/revisions/:revision/sources/:sourceId',(req,res,next)=>{try{const {date,revision,sourceId}=req.params;if(!validDate(date)||!/^\d+$/.test(revision)||Number(revision)<1||!validJobId(sourceId))return res.status(400).json({error:{code:'invalid_daily_source',message:'Некорректный источник отчёта.'}});const source=findDailyBriefSource(db,{date,timeZone:'Europe/Samara',revision:Number(revision),sourceId,userId:req.user.id});if(!source)return res.status(404).json({error:{code:'not_found',message:'Источник отчёта не найден.'}});res.json({captureId:source.id,raw:source.raw,occurredAt:source.occurred_at,createdAt:source.created_at});}catch(error){next(error);}});
  app.post('/api/captures/:id/notes',(req,res,next)=>{try{if(!ownsCapture(req,res,req.params.id))return;const body=req.body?.body;if(typeof body!=='string'||body.length>NOTE_BODY_LIMIT)return res.status(400).json({error:{code:'invalid_note',message:`Заметка должна быть текстом до ${NOTE_BODY_LIMIT} символов.`}});const saved=saveNote(db,req.params.id,body);if(saved.notFound)return res.status(404).json({error:{code:'not_found',message:'Запись не найдена.'}});const row=getAggregate(db,req.params.id);notifyJournal('note');res.json({entry:fullEntry(db,row)});}catch(error){next(error);}});
  app.post('/api/undo',(req,res)=>{ const undoGroupId=req.body?.undoGroupId; if(typeof undoGroupId!=='string') return res.status(400).json({error:{code:'invalid_undo',message:'Нужна группа отмены.'}}); const owner=undoGroupOwner(db,undoGroupId);if(owner!==undefined&&owner!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Группа отмены не найдена.'}});const reverted=undo(db,undoGroupId);notifyJournal('undo');res.json({reverted}); });
  app.post('/api/memory/search',(req,res)=>{const query=memoryQuery(req); if(!query) return res.status(400).json({error:{code:'invalid_query',message:'Введите запрос длиной до 2 000 символов.'}}); res.json({results:search(db,query,req.user.id)});});
  app.post('/api/memory/answer',async(req,res,next)=>{const lifecycle=requestAbortSignal(req,res);try{const query=memoryQuery(req),provider=requestedProvider(req.body?.provider);if(!query)return res.status(400).json({error:{code:'invalid_query',message:'Введите запрос длиной до 2 000 символов.'}});if(provider===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const selectedModelValue=requestedModel(req.body?.model);if(selectedModelValue===null)return res.status(400).json({error:{code:'invalid_model',message:'Некорректная модель.'}});const sources=boundedMemorySources(query,search(db,query,req.user.id)); const answerGate=await spendGate(req.user,provider);const answer=noteDowngrade(await ai.answer(query,sources,answerGate.provider,lifecycle.signal,selectedModelValue||null),answerGate);noteUsage(db,answer,'answer',req.user.id);if(lifecycle.signal.aborted)return;res.json({...answer,sources,provenance:{requestedProvider:answer.requestedProvider,usedProvider:answer.usedProvider,provider:answer.provider,model:answer.model,fallbackReason:answer.fallbackReason}});}catch(error){if(!lifecycle.signal.aborted)next(error);}finally{lifecycle.dispose();}});
  app.get('/api/export',(req,res)=>{const exported=exportLedger(db,req.user.id);if(exported.limitExceeded)return res.status(413).json({error:{code:'export_limit_exceeded',message:'Экспорт слишком большой для безопасного создания одним файлом.'},rowLimit:exported.rowLimit});reportAudit(audit,{event:'export_created',schemaVersion:exported.schemaVersion,rowCount:exported.captures.length+exported.interpretations.length+exported.corrections.length+exported.projections.length+exported.captureJobs.length+exported.captureJobEvents.length+exported.ledgerEvents.length+exported.dailyBriefs.length+exported.dailyBriefSources.length});res.type('application/json').attachment('pagent-ledger.json').json(exported);});
  app.get('/api/tags',(req,res,next)=>{try{const counts=new Map();for(const row of db.prepare("SELECT i.classification_json FROM interpretations i JOIN captures c ON c.id=i.capture_id WHERE i.status='active' AND c.deleted_at IS NULL AND c.user_id IS ?").all(req.user.id)){let tags;try{tags=JSON.parse(row.classification_json)?.tags}catch{continue}if(!Array.isArray(tags))continue;for(const tag of tags)if(typeof tag==='string')counts.set(tag,(counts.get(tag)||0)+1)}res.json({tags:[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,30).map(([tag])=>tag)});}catch(error){next(error);}});
  // ── голосовой диалог ──
  // Состояние: настроен ли ключ и в каком режиме пойдёт разговор.
  // Промпт собирается на месте: он зависит от выбранного голоса и добавки из
  // настроек, а они меняются без перезапуска.
  const voiceInstructions = (user = null) => {
    const state = voice.status();
    const chosen = state.provider === 'gemini' ? state.providers?.gemini?.voice : state.providers?.openai?.voice;
    return buildVoiceInstructions({ provider:state.provider, voice:state.voice || chosen, extra:settingValue(stored, process.env, 'systemPrompt', user?.id) });
  };
  // ── предел расхода на разговор ──
  // Правило одно на всех, но у человека может быть своё: личный предел сильнее
  // общего, потому что заводят его как раз для исключения. «Ноль» — это ноль, а
  // «пусто» — «своего нет», и путать их нельзя.
  const voiceRate = (provider) => Number(settingValue(stored, process.env, provider === 'gemini' ? 'voiceGeminiRateUsdPerMinute' : 'voiceRateUsdPerMinute', null)) || 0;
  const numberOrNull = (value) => { const parsed = Number(value); return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed; };
  function voiceQuota(user) {
    const window = user?.voice_limit_window || settingValue(stored, process.env, 'voiceLimitWindow', null) || 'day';
    const limitUsd = user?.voice_limit_usd ?? numberOrNull(settingValue(stored, process.env, 'voiceLimitUsd', null));
    const limitMinutes = user?.voice_limit_minutes ?? numberOrNull(settingValue(stored, process.env, 'voiceLimitMinutes', null));
    // Забытые разговоры закрываются перед подсчётом: иначе вкладка, закрытая
    // крестиком, навсегда оставалась бы бесплатной.
    try { closeStaleVoiceSessions(db, { at: now().toISOString() }); } catch {}
    const spent = voiceSpend(db, { userId: user.id, window, at: now() });
    const minutes = spent.seconds / 60;
    const globallyOff = settingValue(stored, process.env, 'voiceEnabled', null) === 'off';
    const budget = spendState(user);
    const reason = globallyOff ? 'voice_disabled'
      : user.voice_blocked ? 'voice_blocked_for_user'
      : !budget.allowed ? 'spend_limit'
      : limitUsd !== null && spent.costUsd >= limitUsd ? 'voice_limit_usd'
      : limitMinutes !== null && minutes >= limitMinutes ? 'voice_limit_minutes'
      : null;
    return {
      window, limitUsd, limitMinutes,
      spentUsd: spent.costUsd, spentMinutes: Math.round(minutes * 100) / 100, sessions: spent.sessions,
      remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - spent.costUsd),
      remainingMinutes: limitMinutes === null ? null : Math.max(0, Math.round((limitMinutes - minutes) * 100) / 100),
      rateUsdPerMinute: voiceRate(voice.status().provider),
      priced: voiceRate(voice.status().provider) > 0,
      allowed: reason === null, reason,
    };
  }
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
  const quotaMessages = {
    voice_disabled: 'Разговор выключен администратором.',
    voice_blocked_for_user: 'Разговор для вашей учётной записи закрыт администратором.',
    voice_limit_usd: 'Предел расхода на разговор исчерпан.',
    voice_limit_minutes: 'Предел времени разговора исчерпан.',
    spend_limit: SPEND_EXHAUSTED,
  };
  app.get('/api/voice/status',(req,res)=>res.json({...voice.status(),voices:VOICE_CHOICES,instructions:voiceInstructions(req.user),tools:VOICE_TOOLS,quota:voiceQuota(req.user)}));
  app.get('/api/voice/quota',(req,res,next)=>{try{res.json(voiceQuota(req.user));}catch(error){next(error);}});
  // Короткоживущий токен для браузера. Сам ключ наружу не уходит; без ключа
  // отвечаем режимом заглушки, чтобы интерфейс работал одинаково.
  app.post('/api/voice/session',async(req,res,next)=>{try{const chosen=req.body?.provider;if(chosen!==undefined&&chosen!==null&&chosen!=='openai'&&chosen!=='gemini')return res.status(400).json({error:{code:'invalid_voice_provider',message:'Некорректный провайдер голоса.'}});// Предел проверяется до выдачи токена: после выдачи разговор идёт мимо нас,
    // и остановить его будет уже нечем.
    const quota=voiceQuota(req.user);
    if(!quota.allowed)return res.status(429).json({error:{code:quota.reason,message:quotaMessages[quota.reason]||'Разговор недоступен.'},quota});
    const session=await voice.createSession({instructions:voiceInstructions(req.user),tools:VOICE_TOOLS,provider:chosen??null});
    // Выбранный провайдер без ключа — это не «сервер сломался», а «так не
    // получится»: причину видно, и интерфейс может предложить другой.
    if(session.error==='not_configured')return res.status(409).json({error:{code:'voice_provider_not_configured',message:'У выбранного провайдера нет ключа.'}});
    if(session.error)return res.status(503).json({error:{code:session.error,message:'Голосовая модель недоступна.'}});
    // Аудио идёт мимо нас, поэтому минуты разговора нам не видны — считаем хотя
    // бы сами разговоры, чтобы расход не выглядел нулевым.
    const voiceProvider=session.provider||voice.status().provider||'openai';
    try{recordUsage(db,{provider:voiceProvider,model:session.model||null,kind:'voice_session',userId:req.user.id});}catch{}
    // Разговор заводится в собственной книге расхода: она не уходит в экспорт и
    // переживает «Очистить данные» — иначе предел обходился бы одной кнопкой.
    let voiceSessionId=null;
    try{voiceSessionId=openVoiceSession(db,{userId:req.user.id,provider:voiceProvider,model:session.model||null,ratePerMinute:voiceRate(voiceProvider),startedAt:now().toISOString()});}catch{}
    res.json({...session,voiceSessionId,instructions:voiceInstructions(req.user),tools:VOICE_TOOLS,quota:voiceQuota(req.user)});}catch(error){next(error);}});
  // Браузер сообщает, сколько говорили. Верить ему на слово нельзя, поэтому
  // длительность обрезается по времени, реально прошедшему с выдачи токена.
  app.post('/api/voice/session/:id/close',(req,res,next)=>{try{if(!validJobId(req.params.id))return res.status(400).json({error:{code:'invalid_session_id',message:'Некорректный идентификатор разговора.'}});const owned=db.prepare('SELECT user_id FROM voice_sessions WHERE id=?').get(req.params.id);if(!owned||owned.user_id!==req.user.id)return res.status(404).json({error:{code:'not_found',message:'Разговор не найден.'}});const seconds=Number(req.body?.seconds);const closed=closeVoiceSession(db,req.params.id,{seconds:Number.isFinite(seconds)?seconds:undefined,at:now().toISOString(),closedBy:'client'});res.json({seconds:closed?.seconds??0,costUsd:closed?.cost_usd??0,quota:voiceQuota(req.user)});}catch(error){next(error);}});
  // Вызов инструмента моделью: журнал меняется только здесь, на сервере.
  // Сказанное вслух разбирает та же модель, что и напечатанное: провайдер
  // приходит из интерфейса, а если его не назвали — берётся тот, что выбран на
  // сервере. С жёстким 'fallback' отчёт о сделанном оказывался заметкой.
  app.post('/api/voice/tool',async(req,res,next)=>{try{const name=req.body?.name;if(typeof name!=='string'||!VOICE_TOOLS.some(tool=>tool.name===name))return res.status(400).json({error:{code:'unknown_tool',message:'Неизвестный инструмент.'}});const requested=requestedProvider(req.body?.provider);if(requested===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const args=req.body?.arguments&&typeof req.body.arguments==='object'?req.body.arguments:{};const provider=await snapshotProvider(ai,requested);const result=runVoiceTool(db,name,args,{now,timeZone:configuredTimeZone,provider,userId:req.user.id});if(result?.error)return res.status(400).json({error:{code:'tool_failed',message:result.error}});captureJobWorker.wake();notifyJournal('voice');res.json({name,result});}catch(error){next(error);}});
  // Ход разговора в режиме заглушки: та же цепочка инструментов, но без сети.
  app.post('/api/voice/turn',async(req,res,next)=>{try{const text=typeof req.body?.text==='string'?req.body.text:'';if(text.length>2000)return res.status(400).json({error:{code:'invalid_turn',message:'Реплика слишком длинная.'}});const requested=requestedProvider(req.body?.provider);if(requested===null)return res.status(400).json({error:{code:'invalid_provider',message:'Некорректный провайдер.'}});const provider=await snapshotProvider(ai,requested);const turn=mockVoiceTurn(db,text,{now,timeZone:configuredTimeZone,provider,userId:req.user.id});captureJobWorker.wake();if(turn.calls?.length)notifyJournal('voice');res.json(turn);}catch(error){next(error);}});
  app.post('/api/reset',(req,res,next)=>{if(req.body?.confirmation!=='СБРОСИТЬ КИЗУНА')return res.status(400).json({error:{code:'invalid_confirmation',message:'Требуется точная фраза подтверждения.'}});try{const mine=db.prepare('SELECT a.id FROM capture_attachments a JOIN captures c ON c.id=a.capture_id WHERE c.user_id IS ?').all(req.user.id);resetLedger(db,req.user.id);for(const row of mine){try{fs.rmSync(attachmentPath(row.id),{force:true});}catch{}}reportAudit(audit,{event:'local_data_reset',result:'succeeded'});notifyJournal('reset');res.json({ok:true});}catch(error){reportAudit(audit,{event:'local_data_reset',result:'failed',errorCode:'storage_error'});next(error);}});
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
      if (saved.tooMany) return res.status(409).json({error:{code:'too_many_attachments',message:`К записи можно приложить не больше ${saved.limit} файлов.`}});
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
  app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'..','public','auth.html')));
  app.get('/',(req,res)=>req.user?res.sendFile(path.join(__dirname,'..','public','app.html')):res.redirect('/login'));
  // Черновики и студии макетов — часть той же двери: снаружи у приложения
  // видна только страница входа.
  for(const page of ['prototype.html','memory-model.html','index.html','design-options.html','ui-options.html','voice-orb-variations.html','capture-motion-variations.html'])app.get(`/${page}`,(req,res)=>req.user?res.sendFile(path.join(__dirname,'..',page)):res.redirect('/login'));
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
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=createApp();const server=app.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>{app.captureJobWorker.start();console.log('Kizuna server started.');});let shuttingDown=false;const shutdown=()=>{if(shuttingDown)return;shuttingDown=true;app.captureJobWorker.stop().finally(()=>server.close(()=>process.exit(0)));};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);}
