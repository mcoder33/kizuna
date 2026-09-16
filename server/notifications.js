// Уведомления: когда Кизуна говорит первой.
//
// Повод случается в своём модуле — просьба в круге, призыв в разговоре,
// напоминание у срока, новая встреча в календаре — и ложится сюда одной строкой
// у человека. Дальше две двери: лента за колокольчиком (история на 30 дней) и
// доставка — всплывашка в открытой вкладке или push на телефон. Что куда идёт,
// человек решает в настройках; по умолчанию на телефон приходит только то, что
// ждёт ответа или горит по времени.
//
// Модуль не знает ни про HTTP, ни про push: сохранив строку, он отдаёт её
// доставщику, которого подключает приложение (setNotificationSink). Поэтому
// круги, разговор и календарь зовут одну функцию и не тянут за собой сервер.
import crypto from 'node:crypto';
import { gateClassification } from './classifier.js';

// Группы — те же, что у фильтров ленты: люди, сроки и встречи, остальное.
// «Ждёт ответа» — повод, на который человек отвечает прямо в строке; число на
// колокольчике считает только такие.
export const NOTIFICATION_KINDS = {
  request: { group: 'people', label: 'Просят сделать дело', hint: 'ждёт вашего ответа: беру или не я', bell: true, phone: true, waits: true },
  call: { group: 'people', label: 'Зовут по имени', hint: '@имя в обсуждении карточки или в разговоре круга', bell: true, phone: true },
  reply: { group: 'people', label: 'Отвечают на ваше сообщение', hint: 'ответ цитатой в разговоре или обсуждении', bell: true, phone: true },
  answer: { group: 'people', label: 'Ответили на вашу просьбу', hint: 'берут, возвращают, сделали', bell: true, phone: false },
  circle: { group: 'people', label: 'Добавили в круг', hint: '', bell: true, phone: false },
  room: { group: 'people', label: 'Позвали в комнату', hint: 'разговор части круга', bell: true, phone: false },
  reaction: { group: 'people', label: 'Реакции на ваши сообщения', hint: 'одной строкой на разговор', bell: true, phone: false },
  pin: { group: 'people', label: 'Закрепили сообщение', hint: 'в разговоре, где вы есть', bell: true, phone: false },
  chatter: { group: 'people', label: 'Пишут без призыва', hint: 'одной строкой на разговор, без числа', bell: false, phone: false },
  reminder: { group: 'time', label: 'Скоро срок дела или начало встречи', hint: 'за сколько — в «Напоминаниях»', bell: true, phone: true },
  invite: { group: 'time', label: 'Приглашение на встречу', hint: 'принять или отказаться прямо в строке', bell: true, phone: true, waits: true },
  event_changed: { group: 'time', label: 'Встречу перенесли или отменили', hint: 'только на ближайшие два дня', bell: true, phone: true },
  event_added: { group: 'time', label: 'Появилась новая встреча', hint: 'из подключённых календарей, на ближайшие два дня', bell: true, phone: false },
  digest: { group: 'time', label: 'Утренняя сводка', hint: 'в час напоминаний: встречи, дела и кто ждёт ответа', bell: true, phone: true },
  clarify: { group: 'other', label: 'Запись ждёт уточнения', hint: 'модель не разобрала однозначно', bell: true, phone: false },
  calendar_error: { group: 'other', label: 'Календарь перестал обновляться', hint: 'нужно переподключить', bell: true, phone: false },
  spend: { group: 'other', label: 'Расходы подошли к потолку', hint: 'на 80% и на 100% месячного', bell: true, phone: false },
  signup: { group: 'other', label: 'Новая заявка на вход', hint: 'только администратору', bell: true, phone: true, admin: true },
};
export const NOTIFICATION_RETENTION_DAYS = 30;
export const DEFAULT_QUIET_HOURS = '22:00-08:00';
const PAGE_SIZE = 60;
const TEXT_LIMIT = 300;

const now = () => new Date().toISOString();
const clip = (value, limit = TEXT_LIMIT) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

// Личная настройка лежит в общей таблице под ключом `user:<id>:<имя>` — так же,
// как её пишет PUT /api/settings (personalKey в server/index.js).
const personal = (db, userId, name) => db.prepare('SELECT value FROM app_settings WHERE key=?').get(`user:${userId}:${name}`)?.value ?? null;

// Выбор по поводу: «off» — никуда, «bell» — только за колокольчик, «phone» —
// за колокольчик и на телефон. Хранится только то, что человек поменял.
export function validNotifyPrefs(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.entries(parsed).every(([kind, mode]) => Object.hasOwn(NOTIFICATION_KINDS, kind) && ['off', 'bell', 'phone'].includes(mode));
}
export function notificationPrefs(db, userId) {
  let own = {};
  try { own = JSON.parse(personal(db, userId, 'notifyPrefs') || '{}') || {}; } catch {}
  const out = {};
  for (const [kind, rule] of Object.entries(NOTIFICATION_KINDS)) {
    const mode = ['off', 'bell', 'phone'].includes(own[kind]) ? own[kind] : rule.phone ? 'phone' : rule.bell ? 'bell' : 'off';
    out[kind] = { bell: mode !== 'off', phone: mode === 'phone' };
  }
  return out;
}

// Тихие часы — «22:00-08:00» в поясе приложения или «off». Ночью телефон
// молчит; лента за колокольчиком копится как обычно.
export function validQuietHours(value) {
  return value === 'off' || /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}
export function quietHoursOf(db, userId) {
  const value = personal(db, userId, 'quietHours');
  return validQuietHours(value) ? value : DEFAULT_QUIET_HOURS;
}
export function isQuiet(value, at, timeZone) {
  if (!validQuietHours(value) || value === 'off') return false;
  const [from, to] = value.split('-');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const clock = `${parts.find(part => part.type === 'hour').value}:${parts.find(part => part.type === 'minute').value}`;
  if (from === to) return false;
  return from < to ? clock >= from && clock < to : clock >= from || clock < to;
}

// Запись, которую модель не разобрала однозначно, ждёт человека — но не
// звонит ему: уточнить можно, когда будет минута. Строка гаснет, как только
// запись уточнили.
export function noticeUnclear(db, { userId, captureId, classification, raw = '' }) {
  const gate = gateClassification(classification);
  if (!userId || gate.level === 'high') return null;
  const title = clip(classification?.summary || raw, 120);
  return notify(db, { userId, kind: 'clarify', captureId, lead: 'Запись ждёт уточнения:', text: `«${title}»`, meta: [gate.question || (classification?.unclassified ? 'сохранена без разбора' : 'разбор не уверен')], group: `clarify:${captureId}`, once: true });
}

// ── доставщик ──
// Приложение подключает его один раз на базу: в тестах у каждой базы свой.
const sinks = new WeakMap();
export function setNotificationSink(db, sink) { sinks.set(db, sink); }

export function migrateNotifications(db) {
  // Ни пользователь, ни запись не держатся внешним ключом: уведомление
  // переживает удалённую запись ровно до чистки, а удаление человека не должно
  // спотыкаться о его ленту — она стирается явно, рядом с учётной записью.
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      group_key TEXT,
      actor_id TEXT,
      capture_id TEXT,
      room_id TEXT,
      circle_id TEXT,
      assignment_id TEXT,
      account_id TEXT,
      event_uid TEXT,
      lead TEXT,
      text TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      count INTEGER NOT NULL DEFAULT 1,
      waits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      read_at TEXT,
      resolved_at TEXT,
      snoozed_until TEXT
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS notifications_group ON notifications(user_id, group_key);`);
}

/**
 * Повод для человека. Возвращает строку ленты или null, если повод выключен.
 *
 * group — склейка: пока строка с тем же ключом не прочитана, новый повод
 * дописывается в неё (число, последние лица), а не ложится рядом. once — повод
 * случается один раз на ключ: сводка за день, порог расходов, приглашение.
 */
export function notify(db, { userId, kind, actorId = null, captureId = null, roomId = null, circleId = null, assignmentId = null, accountId = null, eventUid = null, lead = null, text, meta = [], data = {}, group = null, once = false, at = now() }) {
  const rule = NOTIFICATION_KINDS[kind];
  if (!rule || !userId || actorId === userId) return null;
  if (!notificationPrefs(db, userId)[kind].bell) return null;
  if (once && group && db.prepare('SELECT 1 FROM notifications WHERE user_id=? AND group_key=?').get(userId, group)) return null;
  const payload = { ...data, meta: meta.filter(Boolean).map(item => clip(item, 120)).slice(0, 4) };
  if (group && !once) {
    const open = db.prepare('SELECT * FROM notifications WHERE user_id=? AND group_key=? AND read_at IS NULL AND resolved_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(userId, group);
    if (open) {
      const previous = JSON.parse(open.data_json || '{}');
      const actors = [actorId, ...(previous.actors || [])].filter((value, index, all) => value && all.indexOf(value) === index).slice(0, 3);
      db.prepare('UPDATE notifications SET actor_id=?, lead=?, text=?, data_json=?, count=count+1, updated_at=? WHERE id=?')
        .run(actorId || open.actor_id, lead === null ? open.lead : clip(lead, 120), clip(text), JSON.stringify({ ...payload, actors }), at, open.id);
      const row = findNotification(db, open.id);
      deliver(db, row, { merged: true });
      return row;
    }
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO notifications(id,user_id,kind,group_key,actor_id,capture_id,room_id,circle_id,assignment_id,account_id,event_uid,lead,text,data_json,waits,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, kind, group, actorId, captureId, roomId, circleId, assignmentId, accountId, eventUid, lead === null ? null : clip(lead, 120), clip(text), JSON.stringify({ ...payload, actors: actorId ? [actorId] : [] }), rule.waits ? 1 : 0, at, at);
  const row = findNotification(db, id);
  deliver(db, row, { merged: false });
  return row;
}
function deliver(db, row, options) {
  const sink = sinks.get(db);
  if (!sink || !row) return;
  try { sink(row, options); } catch {}
}
export function findNotification(db, id) {
  return db.prepare('SELECT * FROM notifications WHERE id=?').get(id) || null;
}

// Строка ленты в том виде, в каком её видит браузер. Лица людей подставляет
// тот, кто знает про круги: здесь только их идентификаторы.
export function serializeNotification(row) {
  const data = JSON.parse(row.data_json || '{}');
  const { actors = [], meta = [], ...rest } = data;
  return {
    id: row.id, kind: row.kind, group: NOTIFICATION_KINDS[row.kind]?.group || 'other',
    lead: row.lead, text: row.text, meta, data: rest, actorIds: actors.length ? actors : row.actor_id ? [row.actor_id] : [], count: row.count,
    captureId: row.capture_id, roomId: row.room_id, circleId: row.circle_id, assignmentId: row.assignment_id, accountId: row.account_id, eventUid: row.event_uid,
    waits: Boolean(row.waits) && !row.resolved_at, resolved: Boolean(row.resolved_at), read: Boolean(row.read_at),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function listNotifications(db, userId, { before = null, limit = PAGE_SIZE, stillWaits = () => true } = {}) {
  // Ждущее ответа сверяется с делом: просьбу могли снять, встречу — отменить,
  // а ответить могли и из карточки. Устаревшее закрывается при чтении ленты.
  for (const row of db.prepare('SELECT * FROM notifications WHERE user_id=? AND waits=1 AND resolved_at IS NULL').all(userId))
    if (!stillWaits(row)) resolveNotification(db, row.id);
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id=? AND (snoozed_until IS NULL) ${before ? 'AND updated_at < ?' : ''} ORDER BY updated_at DESC LIMIT ?`)
    .all(...(before ? [userId, before, limit] : [userId, limit]));
  return { notifications: rows, nextCursor: rows.length === limit ? rows.at(-1).updated_at : null };
}
export function notificationCounts(db, userId) {
  const row = db.prepare(`SELECT
      SUM(CASE WHEN waits=1 AND resolved_at IS NULL AND snoozed_until IS NULL THEN 1 ELSE 0 END) AS waits,
      SUM(CASE WHEN read_at IS NULL AND snoozed_until IS NULL THEN 1 ELSE 0 END) AS unread
    FROM notifications WHERE user_id=?`).get(userId);
  return { waits: row.waits || 0, unread: row.unread || 0 };
}

export function readNotifications(db, userId, { ids = null, captureId = null, roomId = null, at = now() } = {}) {
  if (Array.isArray(ids)) {
    const clean = ids.filter(id => typeof id === 'string').slice(0, 200);
    if (!clean.length) return 0;
    return db.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`).run(at, userId, ...clean).changes;
  }
  if (captureId) return db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND capture_id=? AND waits=0').run(at, userId, captureId).changes;
  if (roomId) return db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND room_id=?').run(at, userId, roomId).changes;
  return db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(at, userId).changes;
}

// Отвеченное гаснет везде сразу: ответили в полосе «к вам», в ленте или в
// карточке — строка перестаёт ждать и считаться на колокольчике.
export function resolveNotification(db, id, at = now()) {
  return db.prepare('UPDATE notifications SET resolved_at=?, read_at=COALESCE(read_at, ?) WHERE id=? AND resolved_at IS NULL').run(at, at, id).changes;
}
export function resolveNotifications(db, { userId = null, kind, assignmentId = null, accountId = null, eventUid = null, captureId = null, at = now() }) {
  const where = ['kind=?', 'resolved_at IS NULL'], args = [kind];
  if (userId) { where.push('user_id=?'); args.push(userId); }
  if (assignmentId) { where.push('assignment_id=?'); args.push(assignmentId); }
  if (accountId) { where.push('account_id=?'); args.push(accountId); }
  if (eventUid) { where.push('event_uid=?'); args.push(eventUid); }
  if (captureId) { where.push('capture_id=?'); args.push(captureId); }
  return db.prepare(`UPDATE notifications SET resolved_at=?, read_at=COALESCE(read_at, ?) WHERE ${where.join(' AND ')}`).run(at, at, ...args).changes;
}

// «Напомнить через 10 минут»: строка уходит из ленты и возвращается в срок —
// заново непрочитанной и со свежей доставкой.
export function snoozeNotification(db, userId, id, minutes, at = new Date()) {
  const row = db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(id, userId);
  if (!row) return { error: 'not_found' };
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return { error: 'invalid_snooze' };
  const until = new Date(at.getTime() + minutes * 60000).toISOString();
  db.prepare('UPDATE notifications SET snoozed_until=?, read_at=? WHERE id=?').run(until, at.toISOString(), id);
  return { snoozedUntil: until };
}
export function wakeSnoozed(db, at = new Date(), refresh = row => row) {
  const due = db.prepare('SELECT * FROM notifications WHERE snoozed_until IS NOT NULL AND snoozed_until<=?').all(at.toISOString());
  for (const row of due) {
    const fresh = refresh(row) || row;
    db.prepare('UPDATE notifications SET snoozed_until=NULL, read_at=NULL, updated_at=?, lead=?, text=? WHERE id=?').run(at.toISOString(), fresh.lead, fresh.text, row.id);
    deliver(db, findNotification(db, row.id), { merged: false });
  }
  return due.length;
}

// Лента — уведомления, а не архив: старше 30 дней это уже история, и она есть
// в самих записях и разговорах.
export function purgeNotifications(db, at = new Date()) {
  const cutoff = new Date(at.getTime() - NOTIFICATION_RETENTION_DAYS * 86400000).toISOString();
  return db.prepare('DELETE FROM notifications WHERE updated_at<? AND (waits=0 OR resolved_at IS NOT NULL)').run(cutoff).changes;
}
