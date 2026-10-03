import { readBoundedBody, withDeadline } from './safe-http.js';
import { translate, formatDate } from '../public/i18n.js';
import { userLocale, localizedDay, localizedRepeat } from './locale.js';
// Telegram — второй вход в журнал. Написанное или пересланное боту Кизуны
// записывается и разбирается так же, как запись с главной страницы: та же
// очередь, та же модель, тот же потолок расходов; модель сама решает, дело
// это, встреча, заметка или идея.
//
// Бот один на всё приложение: токен от @BotFather вводит администратор в
// «Ключах». Свой Telegram каждый привязывает сам — кнопкой «Подключить» в
// настройках: одноразовый код уходит боту ссылкой t.me/<бот>?start=<код>, и
// бот узнаёт, в чей журнал писать. Чужим бот не записывает ничего.
//
// Сообщения бот забирает сам (getUpdates), а не ждёт вебхук: Кизуна стоит за
// басик-авторизацией Caddy, и вебхук Telegram упёрся бы в неё. Забранное
// подтверждается Telegram только после того, как легло в журнал: сервер,
// упавший посреди работы, получит те же сообщения снова, а повтор отсекает
// таблица telegram_messages.
//
// Пересланное разом — альбом, несколько сообщений, комментарий с пересылкой —
// становится одной записью: Telegram присылает такие сообщения по одному
// подряд, и бот ждёт полторы секунды тишины, прежде чем сложить их вместе.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateClassification } from './classifier.js';
import { readSettings, writeSettings } from './db.js';
import { describeRepeat } from './repeat.js';
import { dateInZone, shiftDate } from './reports.js';

export const TELEGRAM_API = 'https://api.telegram.org';
export const LINK_TTL_MS = 15 * 60 * 1000;
// Предел записи тот же, что у поля на главной.
const RAW_LIMIT = 10000;
// Пачка пересланных сообщений — один блок: пока чат молчит меньше этого,
// сообщения копятся, и в журнал уходит одна запись, а в ответ — одно сообщение.
const GROUP_QUIET_MS = 4000;
const POLL_TIMEOUT_S = 50;
// Аватарка бота — знак Кизуны с сайта (public/icon.svg): те же белые ворота на
// том же красном, только красное во весь квадрат. Telegram показывает фото
// профиля кругом, и скруглённые углы значка обрезались бы по краю. Формат —
// JPG: другого Telegram для фото профиля не принимает.
export const BOT_AVATAR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'telegram-avatar.jpg');
const AVATAR_SETTING = 'telegramBotAvatar';
const HOLD_TICK_MS = 300;
const IDLE_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Что бот говорит сам. Род не указан нигде: голос Кизуны бывает и мужским, и
// женским, а бот говорит за неё.
export const TELEGRAM_TEXTS = {
  linked: 'Готово — Telegram подключён к Кизуне.\n\nПишите сюда или пересылайте сообщения: всё попадёт в журнал и разберётся так же, как запись на главной странице, — дело, встреча, заметка или идея. Фото и файлы лягут вложениями, а пересланное разом станет одной записью.',
  help: 'Пишите сюда или пересылайте сообщения — Кизуна запишет их в журнал и разберёт так же, как запись на главной странице: дело, встреча, заметка или идея. Фото и файлы ложатся вложениями, пересланное разом — одной записью.',
  notLinked: 'Этот Telegram ещё не подключён к Кизуне. Откройте в Кизуне «Настройки → Telegram» и нажмите «Подключить» — ссылка приведёт обратно сюда.',
  expired: 'Ссылка для подключения устарела или уже использована. Нажмите «Подключить» в настройках Кизуны ещё раз.',
  inactive: 'Учётная запись в Кизуне сейчас закрыта — записать отсюда не получится.',
  unsupported: 'Такое записать не получится — пришлите текст, фото или файл.',
  failed: 'Не получилось записать — попробуйте ещё раз чуть позже.',
  unlinked: 'Telegram отключён от Кизуны. Подключить его снова можно в настройках.',
  saving: '✍️ Записано, ИИ разбирает…',
  savingByRules: '✍️ Записано, разбор по правилам…',
};

// ── разметка ────────────────────────────────────────────────────────────────
// Разметка Telegram приходит не символами, а списком отрезков (offset/length в
// UTF-16 — как и строки JS). В журнал она ложится Markdown-ом: ссылка под
// словом без этого просто потерялась бы.
const MARKS = { bold: ['**', '**'], italic: ['*', '*'], strikethrough: ['~~', '~~'], code: ['`', '`'] };
export function entitiesToMarkdown(text = '', entities = []) {
  if (!text || !Array.isArray(entities) || !entities.length) return text || '';
  const opens = new Map(), closes = new Map();
  const put = (map, at, mark, first) => { const list = map.get(at) || []; if (first) list.unshift(mark); else list.push(mark); map.set(at, list); };
  // Внешний отрезок открывается раньше вложенного и закрывается позже.
  const valid = entities.filter(entity => Number.isInteger(entity?.offset) && Number.isInteger(entity?.length) && entity.length > 0 && entity.offset >= 0 && entity.offset + entity.length <= text.length);
  for (const entity of valid.sort((a, b) => a.offset - b.offset || b.length - a.length)) {
    let start = entity.offset, end = entity.offset + entity.length, marks;
    if (entity.type === 'text_link' && /^https?:\/\//i.test(entity.url || '')) marks = ['[', `](${entity.url})`];
    else if (entity.type === 'pre') marks = ['```' + (entity.language || '') + '\n', '\n```'];
    else if (MARKS[entity.type]) {
      // Пробелы по краям — наружу: «** жирный **» Markdown жирным не узнал бы.
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (start >= end) continue;
      marks = MARKS[entity.type];
    } else continue;
    put(opens, start, marks[0], false);
    put(closes, end, marks[1], true);
  }
  let out = '';
  for (let at = 0; at <= text.length; at++) {
    for (const mark of closes.get(at) || []) out += mark;
    for (const mark of opens.get(at) || []) out += mark;
    if (at < text.length) out += text[at];
  }
  return out;
}

// ── откуда сообщение ────────────────────────────────────────────────────────
function personName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return name || (user?.username ? `@${user.username}` : '');
}
const signed = (name, signature) => (signature ? `${name} (${signature})` : name);
// Кто написал пересланное: человек, скрытый отправитель, чат или канал. У
// открытого канала есть ссылка на сам пост — с ней заметка ведёт к источнику.
export function originOf(message) {
  const origin = message?.forward_origin;
  const at = seconds => (Number.isInteger(seconds) ? new Date(seconds * 1000) : null);
  if (origin) {
    if (origin.type === 'user') return { name: personName(origin.sender_user) || 'без имени', date: at(origin.date) };
    if (origin.type === 'hidden_user') return { name: origin.sender_user_name || 'скрытый отправитель', date: at(origin.date) };
    if (origin.type === 'chat') return { name: signed(origin.sender_chat?.title || 'чат', origin.author_signature), date: at(origin.date) };
    if (origin.type === 'channel') return {
      name: signed(origin.chat?.title ? `канал «${origin.chat.title}»` : 'канал', origin.author_signature),
      date: at(origin.date),
      link: origin.chat?.username && origin.message_id ? `https://t.me/${origin.chat.username}/${origin.message_id}` : null,
    };
    return { name: 'Telegram', date: at(origin.date) };
  }
  // Старые поля: так пересылку описывал Bot API до версии 7.0.
  if (message?.forward_from) return { name: personName(message.forward_from) || 'без имени', date: at(message.forward_date) };
  if (message?.forward_sender_name) return { name: message.forward_sender_name, date: at(message.forward_date) };
  if (message?.forward_from_chat) return {
    name: message.forward_from_chat.type === 'channel' ? `канал «${message.forward_from_chat.title}»` : message.forward_from_chat.title || 'чат',
    date: at(message.forward_date),
    link: message.forward_from_chat.username && message.forward_from_message_id ? `https://t.me/${message.forward_from_chat.username}/${message.forward_from_message_id}` : null,
  };
  return null;
}

// ── что внутри ──────────────────────────────────────────────────────────────
const mapLink = location => `https://yandex.ru/maps/?pt=${location.longitude},${location.latitude}&z=17&l=map`;
function bodyOf(message) {
  if (typeof message.text === 'string') return entitiesToMarkdown(message.text, message.entities).trim();
  const parts = [];
  if (typeof message.caption === 'string') parts.push(entitiesToMarkdown(message.caption, message.caption_entities).trim());
  if (message.venue?.location) parts.push(`📍 ${[message.venue.title, message.venue.address].filter(Boolean).join(', ')}\n${mapLink(message.venue.location)}`);
  else if (message.location) parts.push(`📍 ${mapLink(message.location)}`);
  if (message.contact) parts.push(`Контакт: ${[message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ')}, ${message.contact.phone_number}`);
  if (message.poll) parts.push(`Опрос: ${message.poll.question}\n${(message.poll.options || []).map(option => `- ${option.text}`).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}
// Файл сообщения: у фото — самый крупный размер, у GIF Telegram кладёт ещё и
// document, поэтому анимация проверяется раньше документа.
export function fileOf(message) {
  const id = message.message_id;
  if (Array.isArray(message.photo) && message.photo.length) {
    const area = size => (size.width || 0) * (size.height || 0);
    const best = message.photo.reduce((a, b) => (area(b) > area(a) || (area(b) === area(a) && (b.file_size || 0) > (a.file_size || 0)) ? b : a));
    return { kind: 'photo', fileId: best.file_id, size: best.file_size || 0, filename: `photo-${id}.jpg`, contentType: 'image/jpeg' };
  }
  const pick = (kind, file, filename, contentType) => ({ kind, fileId: file.file_id, size: file.file_size || 0, filename: file.file_name || filename, contentType: file.mime_type || contentType, duration: file.duration || 0, title: file.title || null });
  if (message.animation) return pick('animation', message.animation, `animation-${id}.mp4`, 'video/mp4');
  if (message.video) return pick('video', message.video, `video-${id}.mp4`, 'video/mp4');
  if (message.video_note) return pick('video_note', message.video_note, `video-note-${id}.mp4`, 'video/mp4');
  if (message.voice) return pick('voice', message.voice, `voice-${id}.ogg`, 'audio/ogg');
  if (message.audio) return pick('audio', message.audio, `audio-${id}.mp3`, 'audio/mpeg');
  if (message.document) return pick('document', message.document, `file-${id}`, 'application/octet-stream');
  return null;
}
const minutes = seconds => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
// Запись из одних файлов: у поля на главной без текста не сохранить ничего,
// поэтому текстом записи становится то, что в ней лежит.
function filesLine(files) {
  if (!files.length) return '';
  if (files.every(file => file.kind === 'photo')) return files.length === 1 ? 'фото' : `${files.length} фото`;
  if (files.length > 1) return `${files.length} ${plural(files.length, ['файл', 'файла', 'файлов'])}`;
  const [file] = files;
  if (file.kind === 'voice') return `голосовое сообщение${file.duration ? `, ${minutes(file.duration)}` : ''}`;
  if (file.kind === 'video_note') return `видеосообщение${file.duration ? `, ${minutes(file.duration)}` : ''}`;
  if (file.kind === 'video') return 'видео';
  if (file.kind === 'animation') return 'GIF';
  if (file.kind === 'audio') return `аудио «${file.title || file.filename}»`;
  return `файл «${file.filename}»`;
}
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
export function plural(count, [one, few, many]) {
  const tens = count % 100, units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}
function dayWords(date, today) {
  if (date === today) return 'сегодня';
  if (date === shiftDate(today, 1)) return 'завтра';
  if (date === shiftDate(today, -1)) return 'вчера';
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}${String(year) !== today.slice(0, 4) ? ` ${year}` : ''}`;
}
const quote = text => text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');

// Текст записи из пачки сообщений одного чата. Своё — как есть: это то же, что
// напечатать на главной. Пересланное подписывается автором, а рядом со своим
// комментарием уходит цитатой — модель должна видеть, где слова человека, а
// где чужое сообщение, о котором он пишет.
export function composeCapture(messages, { files = [], timeZone = 'Europe/Samara', now = new Date() } = {}) {
  const today = dateInZone(now, timeZone);
  const items = messages.map(message => ({ origin: originOf(message), body: bodyOf(message) }));
  const forwarded = items.some(item => item.origin);
  const label = ({ origin }) => {
    const day = origin.date ? dateInZone(origin.date, timeZone) : today;
    const name = origin.link ? `[${origin.name}](${origin.link})` : origin.name;
    return day === today ? name : `${name}, ${dayWords(day, today)}`;
  };
  const own = items.filter(item => !item.origin && item.body);
  const theirs = items.filter(item => item.origin && item.body);
  let raw;
  if (!theirs.length) raw = own.map(item => item.body).join('\n\n');
  else if (own.length) raw = `${own.map(item => item.body).join('\n\n')}\n\n${theirs.map(item => quote(`**${label(item)}:** ${item.body}`)).join('\n\n')}`;
  else {
    const authors = [...new Set(theirs.map(label))];
    raw = authors.length === 1
      ? `${theirs.map(item => item.body).join('\n\n')}\n\n— ${authors[0]}, переслано из Telegram`
      : `${theirs.map(item => `**${label(item)}:** ${item.body}`).join('\n\n')}\n\n— переслано из Telegram`;
  }
  if (!raw.trim()) {
    const line = filesLine(files);
    if (!line) return null;
    const authors = [...new Set(items.filter(item => item.origin).map(label))];
    raw = !forwarded ? `Из Telegram: ${line}` : authors.length === 1 ? `${capital(line)}\n\n— ${authors[0]}, переслано из Telegram` : `${capital(line)}\n\n— переслано из Telegram`;
  }
  return { raw: raw.trim(), forwarded };
}

// ── ответ после разбора ─────────────────────────────────────────────────────
// Та же сводка, что показывает карточка записи на главной после разбора: что
// получилось, когда, что отделилось, что осталось неясным.
export function whenText(schedule, today, locale = 'ru') {
  if (!schedule || (!schedule.date && !schedule.time)) return '';
  const words = [];
  if (schedule.date) words.push(locale === 'ru' ? dayWords(schedule.date, today) : localizedDay(locale,schedule.date,today));
  if (schedule.time) words.push(translate(locale,'в {time}',{time:`${schedule.time}${schedule.end ? `–${schedule.end}` : ''}`}));
  const repeat = schedule.repeat ? (locale === 'ru' ? describeRepeat(schedule.repeat) : localizedRepeat(locale,schedule.repeat)) : null;
  if (repeat) words.push(`(${repeat})`);
  return words.join(' ');
}
const clip = (text, limit) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; };
// Срок в ответе: сегодняшний день не называем («на сегодня» уже в заголовке),
// остальное — словами: «в пятницу», «завтра в 11:00», «каждую среду».
function dueText(schedule, today, locale = 'ru') {
  if (!schedule) return '';
  if (!schedule.date || schedule.date === today) return whenText({ ...schedule, date: null }, today, locale);
  return whenText(schedule, today, locale);
}
export function resultText({ state, classification = null, parts = [], captureGone = false }, { today, locale = 'ru' }) {
  const t = (source, params = {}) => translate(locale, source, params);
  if (captureGone) return t('Запись уже удалена из журнала.');
  if (state === 'cancelled') return t('Разбор отменён — запись сохранена как есть.');
  if (state !== 'succeeded' || !classification) return t('⚠️ Записано, но не разобрано — название и срок можно поправить в карточке записи.');
  const lines = [];
  const title = `«${clip(classification.summary, 140)}»`;
  const partTitles = parts.map(part => `«${clip(part.title, 80)}»`);
  if (classification.completed === true) {
    const when = whenText(classification.entities?.doneOn, today, locale);
    lines.push(t('🏁 Записано как сделанное: {title}{when}', {title, when:when ? ` — ${when}` : ''}));
    if (partTitles.length) lines.push(t('Легло {count} туду на сегодня:',{count:partTitles.length})+'\n'+partTitles.map(item=>`• ${item}`).join('\n'));
  } else {
    const due = dueText(classification.entities?.schedule, today, locale);
    const onToday = !classification.entities?.schedule?.date || classification.entities.schedule.date === today;
    if (!partTitles.length) lines.push(t(onToday ? '📌 Легло на сегодня: {title}{due}' : '📌 Легло: {title}{due}', {title,due:due ? ` — ${due}` : ''}));
    else {
      // Родитель при пачке дел не туду: перечисляются только отделившиеся дела.
      const count = partTitles.length;
      lines.push(t('📌 Легло {count} туду на сегодня:', {count}));
      for (const item of partTitles) lines.push(`• ${item}`);
    }
  }
  const projects = (classification.entities?.projects || []).filter(Boolean);
  if (projects.length) lines.push(t('Проект: {projects}', {projects:projects.join(', ')}));
  const review = gateClassification(classification);
  if (review.question) lines.push(`❓ ${review.question}`);
  return lines.join('\n');
}

// Кнопка к записи. Telegram не принимает в кнопках адреса без https и
// локальные — с ними не ушёл бы и сам ответ.
function openButton(appUrl, captureId, locale = 'ru') {
  if (!appUrl || !/^https:\/\//i.test(appUrl)) return undefined;
  try {
    const host = new URL(appUrl).hostname;
    if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return undefined;
  } catch { return undefined; }
  return { inline_keyboard: [[{ text: translate(locale, 'Открыть в Кизуне'), url: `${appUrl.replace(/\/+$/, '')}/#today?open=${captureId}` }]] };
}

const hashCode = code => crypto.createHash('sha256').update(String(code)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.());

// ── служба ──────────────────────────────────────────────────────────────────
// Всё, что касается журнала, приходит крючками из server/index.js: запись в
// очередь, вложение, сводка разбора. Сама служба знает только Telegram и свои
// три таблицы.
export function createTelegramService({
  db,
  token = () => null,
  apiBase = () => TELEGRAM_API,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  clock = () => Date.now(),
  timeZone = () => 'Europe/Samara',
  audit = () => {},
  userActive = () => false,
  queueCapture,
  attach = () => false,
  describe = () => null,
  onLink = () => {},
  attachmentLimit = 10 * 1024 * 1024,
  requestTimeoutMs = 20000,
  maxResponseBytes = 2 * 1024 * 1024,
  attachmentsPerCapture = 10,
  groupWindowMs = GROUP_QUIET_MS,
  pollTimeoutSeconds = POLL_TIMEOUT_S,
  avatar = () => fs.readFileSync(BOT_AVATAR_PATH),
} = {}) {
  const note = event => { try { audit(event); } catch {} };
  const at = () => now().toISOString();
  let bot = null, botToken = null;
  let state = 'off', lastError = null;
  let running = false, loopDone = null, controller = null, wakeUp = null;
  let loopToken = null, ready = false, failures = 0;
  let offset = 0;
  const held = new Map();
  const seen = new Set();
  const sending = new Set();

  async function call(method, params = {}, { signal, key = token(), files = null } = {}) {
    if (!key) { const error = new Error('Токен бота не задан.'); error.status = 401; throw error; }
    let request = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) };
    // Файл Telegram принимает только формой multipart: поля-объекты в ней —
    // строки JSON, а сам файл — отдельная часть, на которую поле ссылается
    // как attach://<имя части>.
    if (files) {
      const form = new FormData();
      for (const [name, value] of Object.entries(params)) form.append(name, typeof value === 'string' ? value : JSON.stringify(value));
      for (const [name, file] of Object.entries(files)) form.append(name, new Blob([file.bytes], { type: file.type }), file.filename);
      request = { body: form };
    }
    return withDeadline(async requestSignal => {
    const response = await fetchImpl(`${apiBase().replace(/\/+$/, '')}/bot${key}/${method}`, { method: 'POST', ...request, signal: requestSignal, redirect: 'error' });
    const bytes = await readBoundedBody(response, { maxBytes: maxResponseBytes, signal: requestSignal });
    let body = null;
    try { body = JSON.parse(bytes.toString('utf8')); } catch {}
    if (!body?.ok) {
      const error = new Error(body?.description || `Telegram: HTTP ${response.status}`);
      error.status = body?.error_code || response.status;
      error.retryAfter = body?.parameters?.retry_after || null;
      throw error;
    }
    return body.result;
    }, { signal, timeoutMs: method === 'getUpdates' ? ((Number(params.timeout) || 0) + 15) * 1000 : requestTimeoutMs });
  }
  async function download(fileId) {
    try {
      return await withDeadline(async signal => {
        const file = await call('getFile', { file_id: fileId }, { signal });
        if (!file?.file_path || typeof file.file_path !== 'string') throw new Error('no_file_path');
        const segments = file.file_path.split('/');
        if (segments.some(part => !part || part === '.' || part === '..' || /[\\\s?#]/.test(part))) throw new Error('invalid_file_path');
        if (file.file_size && file.file_size > attachmentLimit) throw Object.assign(new Error('too_large'), { tooLarge: true });
        const response = await fetchImpl(`${apiBase().replace(/\/+$/, '')}/file/bot${token()}/${segments.map(encodeURIComponent).join('/')}`, { signal, redirect: 'error' });
        if (!response.ok) throw new Error(`download_${response.status}`);
        return await readBoundedBody(response, { maxBytes: attachmentLimit, signal });
      }, { timeoutMs: requestTimeoutMs });
    } catch (error) {
      if (error.code === 'response_too_large') error.tooLarge = true;
      throw error;
    }
  }
  const localeForChat = chatId => userLocale(db, db.prepare('SELECT user_id FROM telegram_links WHERE chat_id=?').get(chatId)?.user_id);
  const say = (chatId, text, replyTo = null, extra = {}) => call('sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    ...extra,
  });
  const quietly = promise => promise.catch(error => { note({ event: 'telegram_send_failed', errorCode: error?.status || 'network' }); return null; });

  // Бот по текущему токену: имя нужно ссылке «Подключить», поэтому его можно
  // спросить и раньше, чем опрос дошёл до первого круга.
  async function ensureBot() {
    const key = token();
    if (!key) return null;
    if (bot && botToken === key) return bot;
    const me = await call('getMe', {}, { key });
    bot = me; botToken = key;
    return me;
  }
  // Аватарка — одна загрузка на бота и на картинку. Сервер перезапускается с
  // каждым релизом, а каждая загрузка добавляла бы в профиль бота ещё одно
  // такое же фото. Поэтому в настройках лежит метка «бот:отпечаток картинки»:
  // другой бот или новая картинка — загрузка заново, а фото, которое потом
  // поменяли в @BotFather, сервер уже не трогает.
  async function setupAvatar() {
    const bytes = avatar();
    if (!bot?.id || !bytes?.length) return;
    const mark = `${bot.id}:${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
    if (readSettings(db)[AVATAR_SETTING] === mark) return;
    await call('setMyProfilePhoto', { photo: { type: 'static', photo: 'attach://avatar' } }, { files: { avatar: { bytes, type: 'image/jpeg', filename: 'kizuna.jpg' } } });
    writeSettings(db, { [AVATAR_SETTING]: mark });
    note({ event: 'telegram_avatar_set' });
  }
  // Команды, описание и аватарка — один раз на токен. Описание, заданное в
  // @BotFather, не трогаем: заполняем, только если его нет.
  async function setupBot() {
    await call('setMyCommands', { commands: [{ command: 'help', description: 'Как записывать в Кизуну' }] }).catch(() => {});
    const current = await call('getMyDescription', {}).catch(() => null);
    if (current && !current.description) await call('setMyDescription', { description: 'Пишите или пересылайте сюда сообщения — Кизуна запишет их в ваш журнал и разберёт: дела, встречи, заметки, идеи.' }).catch(() => {});
    const short = await call('getMyShortDescription', {}).catch(() => null);
    if (short && !short.short_description) await call('setMyShortDescription', { short_description: 'Второй вход в журнал Кизуны' }).catch(() => {});
    await setupAvatar().catch(error => note({ event: 'telegram_avatar_failed', errorCode: error?.status || error?.code || 'avatar_error' }));
  }

  // ── привязка ──
  const linkByTelegram = telegramId => db.prepare('SELECT * FROM telegram_links WHERE telegram_id=?').get(telegramId) || null;
  function linkOf(userId) {
    const row = db.prepare('SELECT username,name,linked_at FROM telegram_links WHERE user_id=?').get(userId);
    return row ? { username: row.username || null, name: row.name || null, linkedAt: row.linked_at } : null;
  }
  async function createLink(userId, appUrl = null) {
    if (!token()) return { error: 'telegram_off' };
    let me;
    try { me = await ensureBot(); } catch { return { error: 'telegram_unavailable' }; }
    if (!me?.username) return { error: 'telegram_unavailable' };
    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = new Date(now().getTime() + LINK_TTL_MS).toISOString();
    db.transaction(() => {
      // Действует последняя выданная ссылка: прежние того же человека гаснут.
      db.prepare('DELETE FROM telegram_codes WHERE user_id=? OR expires_at<=?').run(userId, at());
      db.prepare('INSERT INTO telegram_codes(code_hash,user_id,app_url,expires_at) VALUES(?,?,?,?)').run(hashCode(code), userId, appUrl, expiresAt);
    })();
    return { url: `https://t.me/${me.username}?start=${code}`, expiresAt };
  }
  function unlink(userId) {
    const row = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id=?').get(userId);
    db.prepare('DELETE FROM telegram_links WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM telegram_codes WHERE user_id=?').run(userId);
    if (row) quietly(say(row.chat_id, TELEGRAM_TEXTS.unlinked));
    return Boolean(row);
  }
  async function linkWithCode(message, code) {
    const chatId = message.chat.id;
    const row = db.prepare('SELECT * FROM telegram_codes WHERE code_hash=?').get(hashCode(code));
    if (!row || row.expires_at <= at()) { await quietly(say(chatId, TELEGRAM_TEXTS.expired)); return; }
    db.prepare('DELETE FROM telegram_codes WHERE code_hash=?').run(row.code_hash);
    if (!userActive(row.user_id)) { await quietly(say(chatId, TELEGRAM_TEXTS.inactive)); return; }
    // Один Telegram — один журнал, и у журнала — один Telegram: новая привязка
    // заменяет старую с любой стороны.
    db.transaction(() => {
      db.prepare('DELETE FROM telegram_links WHERE user_id=? OR telegram_id=?').run(row.user_id, message.from.id);
      db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,username,name,app_url,linked_at) VALUES(?,?,?,?,?,?,?)')
        .run(row.user_id, message.from.id, chatId, message.from.username || null, personName(message.from) || null, row.app_url || null, at());
    })();
    note({ event: 'telegram_linked', result: 'succeeded' });
    try { onLink(row.user_id); } catch {}
    await quietly(say(chatId, TELEGRAM_TEXTS.linked));
  }

  // ── приём ──
  // Команда — только своё сообщение: пересланное «/start» — это чужой текст.
  // Незнакомая «/команда» получает подсказку, а не становится записью.
  const COMMAND = /^\/([a-z_]+)(?:@\w+)?(?:\s+(\S+))?\s*$/i;
  async function take(update) {
    const message = update.message;
    if (!message || message.chat?.type !== 'private' || !message.from || message.from.is_bot) return;
    const command = !originOf(message) && typeof message.text === 'string' ? COMMAND.exec(message.text.trim()) : null;
    if (command?.[1].toLowerCase() === 'start' && command[2]) return linkWithCode(message, command[2]);
    const link = linkByTelegram(message.from.id);
    if (command) { await quietly(say(message.chat.id, link ? TELEGRAM_TEXTS.help : TELEGRAM_TEXTS.notLinked)); return; }
    if (!link) { await quietly(say(message.chat.id, TELEGRAM_TEXTS.notLinked, message.message_id)); return; }
    if (db.prepare('SELECT 1 FROM telegram_messages WHERE chat_id=? AND message_id=?').get(message.chat.id, message.message_id)) return;
    const group = held.get(message.chat.id) || { chatId: message.chat.id, link, items: [], lastAt: 0 };
    group.items.push({ updateId: update.update_id, message });
    group.lastAt = clock();
    held.set(message.chat.id, group);
  }
  // Подтверждать Telegram можно всё до первого сообщения, которое ещё ждёт
  // своей пачки.
  function settleOffset() {
    const waiting = [...held.values()].flatMap(group => group.items.map(item => item.updateId));
    if (waiting.length) offset = Math.max(offset, Math.min(...waiting));
    else if (seen.size) offset = Math.max(offset, Math.max(...seen) + 1);
    for (const id of seen) if (id < offset) seen.delete(id);
  }
  async function pollOnce({ timeout = 0 } = {}) {
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), (timeout + 15) * 1000);
    timer.unref?.();
    let updates;
    try { updates = await call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, { signal: controller.signal }); }
    finally { clearTimeout(timer); controller = null; }
    for (const update of updates || []) {
      if (!Number.isInteger(update?.update_id) || update.update_id < offset || seen.has(update.update_id)) continue;
      seen.add(update.update_id);
      try { await take(update); }
      catch (error) { note({ event: 'telegram_update_failed', errorCode: error?.status || error?.code || 'update_error' }); }
    }
    settleOffset();
    return (updates || []).length;
  }
  async function flush({ force = false } = {}) {
    for (const [chatId, group] of [...held]) {
      if (!force && clock() - group.lastAt < groupWindowMs) continue;
      held.delete(chatId);
      try { await save(group); }
      catch (error) {
        note({ event: 'telegram_save_failed', errorCode: error?.status || error?.code || 'save_error' });
        await quietly(say(chatId, TELEGRAM_TEXTS.failed, group.items[0]?.message.message_id));
      }
    }
    settleOffset();
  }

  // Пачка сообщений — одна запись. Файлы качаются заранее: запись без них
  // потом пришлось бы переписывать, а слишком большой файл лучше назвать сразу.
  async function save(group) {
    const { chatId, link } = group;
    const messages = group.items.map(item => item.message).sort((a, b) => a.message_id - b.message_id);
    const head = messages[0];
    if (!userActive(link.user_id)) { await quietly(say(chatId, TELEGRAM_TEXTS.inactive, head.message_id)); return; }
    // Слишком длинная пачка ложится по сообщению на запись: предел поля один.
    const draft = composeCapture(messages, { files: messages.map(fileOf).filter(Boolean), timeZone: timeZone(link.user_id), now: now() });
    if (draft && draft.raw.length > RAW_LIMIT && messages.length > 1) {
      for (const message of messages) await save({ chatId, link, items: [{ message }] });
      return;
    }
    const files = [], problems = [];
    for (const message of messages) {
      const file = fileOf(message);
      if (!file) continue;
      const limitText = `${Math.round(attachmentLimit / 1024 / 1024)} МБ`;
      if (files.length >= attachmentsPerCapture) { problems.push(`«${file.filename}» не приложен: к записи можно приложить не больше ${attachmentsPerCapture} файлов.`); continue; }
      if (file.size > attachmentLimit) { problems.push(`«${file.filename}» не сохранён: файлы больше ${limitText} не принимаются.`); continue; }
      try { files.push({ ...file, bytes: await download(file.fileId) }); }
      catch (error) { problems.push(error?.tooLarge ? `«${file.filename}» не сохранён: файлы больше ${limitText} не принимаются.` : `«${file.filename}» не удалось скачать из Telegram.`); }
    }
    const composed = composeCapture(messages, { files, timeZone: timeZone(link.user_id), now: now() });
    if (!composed) { await quietly(say(chatId, problems.length ? problems.join('\n') : TELEGRAM_TEXTS.unsupported, head.message_id)); return; }
    const occurredAt = Number.isInteger(head.date) ? new Date(head.date * 1000).toISOString() : undefined;
    const queued = await queueCapture({ userId: link.user_id, raw: composed.raw.slice(0, RAW_LIMIT), occurredAt, origin: composed.forwarded ? 'telegram_forward' : 'telegram' });
    if (!queued?.captureId) { await quietly(say(chatId, queued?.error === 'inactive' ? TELEGRAM_TEXTS.inactive : TELEGRAM_TEXTS.failed, head.message_id)); return; }
    const extra = [queued.duplicate ? 'Похожая запись уже есть в журнале — возможно, дубль.' : null, queued.spent ? 'Потолок расходов исчерпан: разобрано по правилам, без модели.' : null, ...problems].filter(Boolean);
    const insert = db.prepare('INSERT OR IGNORE INTO telegram_messages(chat_id,message_id,user_id,capture_id,job_id,note,created_at) VALUES(?,?,?,?,?,?,?)');
    sending.add(queued.jobId);
    try {
      db.transaction(() => { messages.forEach((message, index) => insert.run(chatId, message.message_id, link.user_id, queued.captureId, index === 0 ? queued.jobId : null, index === 0 && extra.length ? extra.join('\n') : null, at())); })();
      for (const file of files) {
        try { if (!attach({ captureId: queued.captureId, filename: file.filename, contentType: file.contentType, bytes: file.bytes })) problems.push(`«${file.filename}» не приложен.`); }
        catch { problems.push(`«${file.filename}» не приложен.`); }
      }
      const sent = await quietly(say(chatId, [queued.spent ? TELEGRAM_TEXTS.savingByRules : TELEGRAM_TEXTS.saving, ...extra].join('\n'), head.message_id));
      if (sent?.message_id) db.prepare('UPDATE telegram_messages SET reply_id=? WHERE chat_id=? AND message_id=?').run(sent.message_id, chatId, head.message_id);
    } finally { sending.delete(queued.jobId); }
    note({ event: 'telegram_capture_queued', result: 'succeeded', messages: messages.length, files: files.length });
    await answer(queued.jobId);
  }

  // Итог разбора — правкой ответа «Записано, ИИ разбирает…». Зовётся, когда
  // задание разбора закончилось, и сразу после записи: быстрый разбор мог
  // закончиться раньше, чем ушёл первый ответ.
  async function answer(jobId) {
    if (!jobId || sending.has(jobId)) return false;
    const row = db.prepare('SELECT * FROM telegram_messages WHERE job_id=? AND answered_at IS NULL').get(jobId);
    if (!row) return false;
    let summary = null;
    try { summary = describe({ captureId: row.capture_id, jobId }); } catch {}
    if (!summary) return false;
    const claimed = db.prepare('UPDATE telegram_messages SET answered_at=? WHERE chat_id=? AND message_id=? AND answered_at IS NULL').run(at(), row.chat_id, row.message_id);
    if (!claimed.changes) return false;
    const link = db.prepare('SELECT app_url FROM telegram_links WHERE user_id=?').get(row.user_id);
    const text = [resultText(summary, { today: dateInZone(now(), timeZone(row.user_id)), locale:userLocale(db,row.user_id) }), row.note].filter(Boolean).join('\n');
    const markup = summary.captureGone ? undefined : openButton(link?.app_url, row.capture_id, userLocale(db,row.user_id));
    const extra = { link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) };
    if (row.reply_id) {
      const edited = await quietly(call('editMessageText', { chat_id: row.chat_id, message_id: row.reply_id, text, ...extra }));
      if (edited) return true;
    }
    await quietly(say(row.chat_id, text, row.message_id, markup ? { reply_markup: markup } : {}));
    return true;
  }
  // После перезапуска: разборы, которые закончились без нас, всё равно
  // получают ответ.
  async function catchUp() {
    const since = new Date(now().getTime() - 2 * DAY_MS).toISOString();
    for (const row of db.prepare('SELECT job_id FROM telegram_messages WHERE job_id IS NOT NULL AND answered_at IS NULL AND created_at>=?').all(since)) await answer(row.job_id);
  }

  // ── опрос ──
  function describeError(error) {
    if (error?.status === 401 || error?.status === 404) return 'Токен не подходит — проверьте его в «Ключах».';
    if (error?.status === 409) return 'Этого бота уже опрашивает другое приложение или у него включён вебхук.';
    return 'Telegram не отвечает — повторим сами.';
  }
  function backoffMs(error) {
    if (error?.retryAfter) return error.retryAfter * 1000;
    if (error?.status === 401 || error?.status === 404) return 60_000;
    if (error?.status === 409) return 30_000;
    return Math.min(60_000, 2000 * 2 ** Math.min(failures, 5));
  }
  function idle(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() { clearTimeout(timer); if (wakeUp === done) wakeUp = null; resolve(); }
      wakeUp = done;
    });
  }
  async function loop() {
    while (running) {
      const key = token() || null;
      if (key !== loopToken) {
        loopToken = key; ready = false; failures = 0; lastError = null;
        offset = 0; held.clear(); seen.clear();
        state = key ? 'connecting' : 'off';
      }
      if (!key) { await idle(IDLE_MS); continue; }
      try {
        if (!ready) { await ensureBot(); await setupBot(); ready = true; state = 'ok'; lastError = null; await catchUp(); }
        await pollOnce({ timeout: held.size ? 0 : pollTimeoutSeconds });
        await flush();
        failures = 0; state = 'ok'; lastError = null;
        if (held.size) await idle(HOLD_TICK_MS);
      } catch (error) {
        if (!running) break;
        // Прерванный опрос — это смена токена или остановка, а не сбой.
        if (error?.name === 'AbortError') continue;
        failures += 1; state = 'error'; lastError = describeError(error);
        note({ event: 'telegram_poll_failed', errorCode: error?.status || 'network' });
        await idle(backoffMs(error));
      }
    }
  }
  function start() {
    if (running) return;
    running = true;
    loopDone = loop().catch(error => note({ event: 'telegram_loop_failed', errorCode: error?.code || 'loop_error' }));
  }
  async function stop() {
    running = false;
    controller?.abort();
    wakeUp?.();
    if (loopDone) await Promise.race([loopDone, sleep(3000)]);
    loopDone = null;
  }
  // Смена токена в настройках: текущий опрос прерывается, следующий круг
  // идёт уже с новым ключом — перезапускать сервер ради этого не нужно.
  function reconfigure() {
    const key = token() || null;
    if (key !== botToken) { bot = null; botToken = null; }
    if (key === loopToken) return;
    if (!key) state = 'off';
    controller?.abort();
    wakeUp?.();
  }
  function status() {
    const key = token();
    if (!key) return { configured: false, state: 'off', bot: null, error: null };
    const known = bot && botToken === key ? { username: bot.username || null, name: bot.first_name || null } : null;
    return { configured: true, state: key === loopToken ? state : 'connecting', bot: known, error: key === loopToken ? lastError : null };
  }

  async function sendAdminNotification({ userId, chatId, text, url }) {
    const user = db.prepare('SELECT role,status FROM users WHERE id=?').get(userId);
    const link = db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(userId);
    if (user?.role !== 'admin' || user.status !== 'active' || link?.chat_id !== chatId)
      throw Object.assign(new Error('Admin Telegram link is unavailable'), { status: 403 });
    let buttonUrl = null;
    try {
      const base = new URL(link.app_url);
      if (base.protocol === 'https:' && !base.username && !base.password && /^\/#admin\//.test(url)) buttonUrl = new URL(url, base.origin).href;
    } catch {}
    return say(chatId, text, null, buttonUrl ? { reply_markup: { inline_keyboard: [[{ text: translate(userLocale(db, userId), 'Открыть в Кизуне'), url: buttonUrl }]] } } : {});
  }
  return { start, stop, reconfigure, status, linkOf, createLink, unlink, answer, pollOnce, flush, ensureBot, catchUp, sendAdminNotification };
}
