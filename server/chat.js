// Разговор круга: общий и комнаты подмножеством.
//
// У каждого круга есть «Общий» — он заводится сам вместе с кругом, и в нём все,
// кто в круге: состав не хранится, он и есть круг. Комната — разговор
// подмножеством: участники названы поимённо, и кто не в ней, тот её не видит
// вовсе — ни названия, ни числа сообщений.
//
// Чат возвращает в приложение счётчик непрочитанного — то, от чего человек
// уходит в личный журнал. Поэтому счётчик живёт только здесь, на комнате, а в
// день попадает одно: призыв `@имя`. Обычное сообщение не дёргает никого.
import crypto from 'node:crypto';
import { displayName, publicUser, circlesOf, membership, membersOf } from './circles.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export const ROOM_NAME_LIMIT = 40;
export const MESSAGE_LIMIT = 4000;
export const ROOMS_PER_CIRCLE = 20;
export const PAGE_SIZE = 50;
export const GENERAL_NAME = 'Общий';

const normalizeName = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
function sameName(left, right) {
  const a = normalizeName(left), b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return common >= Math.max(2, Math.max(a.length, b.length) - 2);
}

// Общий разговор появляется вместе с кругом — но круги, заведённые до чата,
// тоже должны его иметь, поэтому он заводится при первом обращении.
export function ensureGeneral(db, circleId, userId) {
  const existing = db.prepare("SELECT * FROM chat_rooms WHERE circle_id=? AND kind='general'").get(circleId);
  if (existing) return existing;
  const roomId = id();
  db.prepare("INSERT INTO chat_rooms(id,circle_id,name,kind,created_by,created_at) VALUES(?,?,?,'general',?,?)").run(roomId, circleId, GENERAL_NAME, userId, now());
  return db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(roomId);
}

export function roomMembers(db, room) {
  if (room.kind === 'general') return membersOf(db, room.circle_id);
  return db
    .prepare(`SELECT u.*, m.joined_at FROM chat_room_members m JOIN users u ON u.id=m.user_id
      WHERE m.room_id=? AND m.left_at IS NULL ORDER BY m.joined_at`)
    .all(room.id)
    .map(row => ({ ...publicUser(row), joinedAt: row.joined_at }));
}
export function inRoom(db, room, userId) {
  if (!room || room.archived_at) return false;
  if (!membership(db, room.circle_id, userId)) return false;
  if (room.kind === 'general') return true;
  return Boolean(db.prepare('SELECT 1 FROM chat_room_members WHERE room_id=? AND user_id=? AND left_at IS NULL').get(room.id, userId));
}
export function findRoom(db, roomId) {
  return db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(roomId) || null;
}

function unreadOf(db, room, userId) {
  const read = db.prepare('SELECT last_read_at FROM chat_reads WHERE room_id=? AND user_id=?').get(room.id, userId);
  const since = read?.last_read_at || '';
  return db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE room_id=? AND deleted_at IS NULL AND kind='said' AND author_id IS NOT ? AND created_at > ?").get(room.id, userId, since).n;
}
function lastOf(db, room) {
  const row = db
    .prepare(`SELECT m.body, m.created_at, m.kind, u.email, u.display_name FROM chat_messages m LEFT JOIN users u ON u.id=m.author_id
      WHERE m.room_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1`)
    .get(room.id);
  return row ? { body: row.body, createdAt: row.created_at, kind: row.kind, author: row.email ? displayName(row) : null } : null;
}
function serializeRoom(db, room, userId) {
  return {
    id: room.id,
    circleId: room.circle_id,
    name: room.name,
    kind: room.kind,
    createdBy: room.created_by,
    createdAt: room.created_at,
    members: roomMembers(db, room),
    unread: unreadOf(db, room, userId),
    last: lastOf(db, room),
  };
}

// Комнаты, которые человек видит: общий разговор каждого своего круга и те
// комнаты, в которых он состоит. Чужая комната не показывается даже названием.
export function roomsOf(db, userId, circleId = null) {
  const circles = circlesOf(db, userId).filter(circle => !circleId || circle.id === circleId);
  const rooms = [];
  for (const circle of circles) {
    ensureGeneral(db, circle.id, userId);
    for (const room of db.prepare('SELECT * FROM chat_rooms WHERE circle_id=? AND archived_at IS NULL ORDER BY kind ASC, created_at').all(circle.id))
      if (inRoom(db, room, userId)) rooms.push(serializeRoom(db, room, userId));
  }
  return rooms;
}

export function createRoom(db, circleId, userId, name, memberIds = []) {
  if (!membership(db, circleId, userId)) return { error: 'not_found' };
  const clean = String(name ?? '').trim().slice(0, ROOM_NAME_LIMIT);
  if (!clean) return { error: 'invalid_room_name' };
  const count = db.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE circle_id=? AND kind='room' AND archived_at IS NULL").get(circleId).n;
  if (count >= ROOMS_PER_CIRCLE) return { error: 'rooms_limit' };
  const circlePeople = new Set(membersOf(db, circleId).map(member => member.id));
  const wanted = [...new Set([userId, ...memberIds])].filter(person => circlePeople.has(person));
  if (wanted.length < 2) return { error: 'room_needs_people' };
  const roomId = id(), at = now();
  db.prepare("INSERT INTO chat_rooms(id,circle_id,name,kind,created_by,created_at) VALUES(?,?,?,'room',?,?)").run(roomId, circleId, clean, userId, at);
  const add = db.prepare('INSERT INTO chat_room_members(room_id,user_id,added_by,joined_at) VALUES(?,?,?,?)');
  for (const person of wanted) add.run(roomId, person, userId, at);
  // Первая строка комнаты — не сообщение, а факт: кто её завёл и с кем.
  const others = wanted.filter(person => person !== userId).map(person => displayName(db.prepare('SELECT * FROM users WHERE id=?').get(person)));
  system(db, roomId, userId, 'joined', `завёл комнату${others.length ? ` с ${others.join(', ')}` : ''}`);
  return { room: serializeRoom(db, findRoom(db, roomId), userId) };
}
function system(db, roomId, userId, kind, body) {
  db.prepare('INSERT INTO chat_messages(id,room_id,author_id,body,kind,created_at) VALUES(?,?,?,?,?,?)').run(id(), roomId, userId, body, kind, now());
}

export function renameRoom(db, roomId, userId, name) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  if (room.kind === 'general') return { error: 'general_room' };
  const clean = String(name ?? '').trim().slice(0, ROOM_NAME_LIMIT);
  if (!clean) return { error: 'invalid_room_name' };
  db.prepare('UPDATE chat_rooms SET name=? WHERE id=?').run(clean, roomId);
  return { room: serializeRoom(db, findRoom(db, roomId), userId) };
}
// Позвать в комнату может любой, кто в ней: это разговор, а не отдел. Позвать
// можно только из круга — в комнате не может оказаться человек со стороны.
export function addToRoom(db, roomId, userId, personId) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  if (room.kind === 'general') return { error: 'general_room' };
  if (!membership(db, room.circle_id, personId)) return { error: 'not_in_circle' };
  const at = now();
  db.prepare(`INSERT INTO chat_room_members(room_id,user_id,added_by,joined_at) VALUES(?,?,?,?)
    ON CONFLICT(room_id,user_id) DO UPDATE SET left_at=NULL, joined_at=excluded.joined_at`).run(roomId, personId, userId, at);
  system(db, roomId, userId, 'added', `позвал(а) в комнату: ${displayName(db.prepare('SELECT * FROM users WHERE id=?').get(personId))}`);
  return { room: serializeRoom(db, findRoom(db, roomId), userId) };
}
export function leaveRoom(db, roomId, userId) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  if (room.kind === 'general') return { error: 'general_room' };
  db.prepare('UPDATE chat_room_members SET left_at=? WHERE room_id=? AND user_id=?').run(now(), roomId, userId);
  system(db, roomId, userId, 'left', 'вышел(ла) из комнаты');
  // Комната без людей закрывается: пустая комната в списке — мусор.
  if (!roomMembers(db, findRoom(db, roomId)).length) db.prepare('UPDATE chat_rooms SET archived_at=? WHERE id=?').run(now(), roomId);
  return { left: true };
}

export function messages(db, roomId, userId, { before = null, limit = PAGE_SIZE } = {}) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  const rows = db
    .prepare(`SELECT m.*, u.email, u.display_name, u.avatar FROM chat_messages m LEFT JOIN users u ON u.id=m.author_id
      WHERE m.room_id=? AND m.deleted_at IS NULL ${before ? 'AND m.created_at < ?' : ''} ORDER BY m.created_at DESC LIMIT ?`)
    .all(...(before ? [roomId, before, limit] : [roomId, limit]));
  const ids = rows.map(row => row.id);
  const mentions = new Map();
  if (ids.length)
    for (const row of db
      .prepare(`SELECT cm.message_id, u.id, u.email, u.display_name, u.avatar FROM chat_mentions cm JOIN users u ON u.id=cm.user_id
        WHERE cm.message_id IN (${ids.map(() => '?').join(',')})`)
      .iterate(...ids)) {
      if (!mentions.has(row.message_id)) mentions.set(row.message_id, []);
      mentions.get(row.message_id).push(publicUser(row));
    }
  return {
    room: serializeRoom(db, room, userId),
    messages: rows.reverse().map(row => ({
      id: row.id,
      body: row.body,
      kind: row.kind,
      createdAt: row.created_at,
      author: row.email ? publicUser({ ...row, id: row.author_id }) : null,
      mine: row.author_id === userId,
      mentions: mentions.get(row.id) || [],
    })),
    more: rows.length === limit,
  };
}

export function say(db, roomId, userId, body) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  const text = String(body ?? '').trim();
  if (!text || text.length > MESSAGE_LIMIT) return { error: 'invalid_message' };
  const messageId = id(), at = now();
  db.prepare("INSERT INTO chat_messages(id,room_id,author_id,body,kind,created_at) VALUES(?,?,?,?,'said',?)").run(messageId, roomId, userId, text, at);
  // Призвать можно только того, кто в этой комнате: звать в пустоту и ждать
  // ответа — худшее, что может сделать интерфейс.
  const people = roomMembers(db, room).filter(person => person.id !== userId);
  const called = [];
  const insert = db.prepare('INSERT OR IGNORE INTO chat_mentions(message_id,user_id,created_at) VALUES(?,?,?)');
  for (const name of text.match(/@[\p{L}\p{N}_.-]{2,40}/gu) || []) {
    const target = people.find(person => sameName(name.slice(1), person.name) || normalizeName(name.slice(1)) === normalizeName(person.email));
    if (target && !called.some(person => person.id === target.id)) { insert.run(messageId, target.id, at); called.push(target); }
  }
  markRead(db, roomId, userId, at);
  return { message: messages(db, roomId, userId, { limit: 1 }).messages[0], called, room: serializeRoom(db, room, userId) };
}
// Своё сообщение можно убрать: свои слова — свои. Чужие остаются.
export function removeMessage(db, messageId, userId) {
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(messageId);
  if (!row || row.author_id !== userId) return { error: 'not_found' };
  db.prepare('UPDATE chat_messages SET deleted_at=? WHERE id=?').run(now(), messageId);
  return { removed: true };
}
export function markRead(db, roomId, userId, at = now()) {
  db.prepare(`INSERT INTO chat_reads(room_id,user_id,last_read_at) VALUES(?,?,?)
    ON CONFLICT(room_id,user_id) DO UPDATE SET last_read_at=excluded.last_read_at`).run(roomId, userId, at);
  db.prepare(`UPDATE chat_mentions SET seen_at=? WHERE user_id=? AND seen_at IS NULL AND message_id IN (SELECT id FROM chat_messages WHERE room_id=?)`).run(at, userId, roomId);
  return { readAt: at };
}

// Призывы из разговора — в ту же полосу «к вам», что просьбы и призывы из
// карточек: одна входящая полоса на всё приложение.
export function unseenCalls(db, userId) {
  return db
    .prepare(`SELECT cm.message_id, m.body, m.created_at, m.room_id, r.name AS room_name, r.circle_id, c.name AS circle_name, c.color,
        u.email, u.display_name, u.avatar, m.author_id FROM chat_mentions cm
      JOIN chat_messages m ON m.id=cm.message_id JOIN chat_rooms r ON r.id=m.room_id JOIN circles c ON c.id=r.circle_id
      JOIN users u ON u.id=m.author_id
      WHERE cm.user_id=? AND cm.seen_at IS NULL AND m.deleted_at IS NULL AND r.archived_at IS NULL AND c.deleted_at IS NULL
      ORDER BY m.created_at`)
    .all(userId)
    .map(row => ({
      kind: 'chat',
      id: row.message_id,
      roomId: row.room_id,
      roomName: row.room_name,
      title: row.body,
      circle: { id: row.circle_id, name: row.circle_name, color: row.color },
      from: publicUser({ ...row, id: row.author_id }),
      createdAt: row.created_at,
    }));
}
// Сколько непрочитанного у человека и где: число на круге в списке — но не в
// дне. День остаётся про день.
export function unreadByCircle(db, userId) {
  const totals = {};
  for (const room of roomsOf(db, userId)) totals[room.circleId] = (totals[room.circleId] || 0) + room.unread;
  return totals;
}
