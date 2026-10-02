// Разговор круга: общий и комнаты подмножеством.
//
// У каждого круга есть «Общий» — он заводится сам вместе с кругом, и в нём все,
// кто в круге: состав не хранится, он и есть круг. Комната — разговор
// подмножеством: участники названы поимённо, и кто не в ней, тот её не видит
// вовсе — ни названия, ни числа сообщений. Разговор можно завести и на весь круг
// (`everyone`): это отдельная тема рядом с «Общим», и состав у неё, как у
// «Общего», — сам круг, включая тех, кто придёт позже.
//
// Чат возвращает в приложение счётчик непрочитанного — то, от чего человек
// уходит в личный журнал. Поэтому счётчик живёт только здесь, на комнате, а в
// день попадает одно: призыв `@имя`. Обычное сообщение не дёргает никого.
import crypto from 'node:crypto';
import { displayName, publicUser, circlesOf, membership, membersOf, circleIdsOf, addMember as addCircleMember, captureTitle, captureDue } from './circles.js';
import { notify } from './notifications.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export const ROOM_NAME_LIMIT = 40;
export const MESSAGE_LIMIT = 4000;
export const ROOMS_PER_CIRCLE = 20;
export const PAGE_SIZE = 50;
export const GENERAL_NAME = 'Общий';
// Реакций немного и они одни на всё приложение: это не набор эмодзи, а способ
// ответить «видел», «согласен», «сделано», не заводя сообщение ради «ок».
export const REACTIONS = ['👍', '❤️', '🔥', '🙏', '👀', '✅'];
const excerptOf = text => (text.length > 140 ? `${text.slice(0, 139)}…` : text);
// Как разговор называется у человека в списке: «Общий» круга зовётся именем
// круга, комната — своим. Уведомление говорит тем же словом, что и страница.
const chatTitle = (room, circle) => (room.kind === 'general' ? circle?.name || room.name : room.name);

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

const wholeCircle = room => room.kind === 'general' || Boolean(room.everyone);
export function roomMembers(db, room) {
  if (wholeCircle(room)) return membersOf(db, room.circle_id);
  return db
    .prepare(`SELECT u.*, m.joined_at FROM chat_room_members m JOIN users u ON u.id=m.user_id
      WHERE m.room_id=? AND m.left_at IS NULL ORDER BY m.joined_at`)
    .all(room.id)
    .map(row => ({ ...publicUser(row), joinedAt: row.joined_at }));
}
export function inRoom(db, room, userId) {
  if (!room || room.archived_at) return false;
  if (!membership(db, room.circle_id, userId)) return false;
  if (wholeCircle(room)) return true;
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
    .prepare(`SELECT m.body, m.created_at, m.kind, m.author_id, u.email, u.display_name, u.avatar FROM chat_messages m LEFT JOIN users u ON u.id=m.author_id
      WHERE m.room_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1`)
    .get(room.id);
  const said = row ? { body: row.body, createdAt: row.created_at, kind: row.kind, author: row.email ? displayName(row) : null, by: row.email ? publicUser({ ...row, id: row.author_id }) : null } : null;
  if (room.kind !== 'general') return said;
  const deed = db
    .prepare(`SELECT a.capture_id, a.created_at, u.id, u.email, u.display_name, u.avatar FROM assignments a JOIN captures c ON c.id=a.capture_id JOIN users u ON u.id=a.assigner_id
      WHERE a.circle_id=? AND a.cancelled_at IS NULL AND c.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 1`)
    .get(room.circle_id);
  if (!deed || (said && said.createdAt >= deed.created_at)) return said;
  return { body: `Дело: ${captureTitle(db, deed.capture_id)}`, createdAt: deed.created_at, kind: 'deed', author: displayName(deed), by: publicUser(deed) };
}
function pinnedOf(db, room) {
  if (!room.pinned_message_id) return null;
  const row = db
    .prepare(`SELECT m.id, m.body, m.created_at, m.author_id, u.email, u.display_name, u.avatar FROM chat_messages m LEFT JOIN users u ON u.id=m.author_id
      WHERE m.id=? AND m.deleted_at IS NULL`)
    .get(room.pinned_message_id);
  return row ? { id: row.id, body: row.body.slice(0, 300), createdAt: row.created_at, author: row.email ? publicUser({ ...row, id: row.author_id }) : null, pinnedAt: room.pinned_at } : null;
}
function serializeRoom(db, room, userId) {
  return {
    id: room.id,
    circleId: room.circle_id,
    name: room.name,
    kind: room.kind,
    everyone: Boolean(room.everyone),
    createdBy: room.created_by,
    createdAt: room.created_at,
    members: roomMembers(db, room),
    unread: unreadOf(db, room, userId),
    // «@» в списке разговоров: здесь позвали меня, и я ещё не открывал.
    called: Boolean(db.prepare(`SELECT 1 FROM chat_mentions cm JOIN chat_messages m ON m.id=cm.message_id
      WHERE cm.user_id=? AND cm.seen_at IS NULL AND m.room_id=? AND m.deleted_at IS NULL LIMIT 1`).get(userId, room.id)),
    last: lastOf(db, room),
    pinned: pinnedOf(db, room),
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

export function createRoom(db, circleId, userId, name, memberIds = [], { everyone = false } = {}) {
  if (!membership(db, circleId, userId)) return { error: 'not_found' };
  const clean = String(name ?? '').trim().slice(0, ROOM_NAME_LIMIT);
  if (!clean) return { error: 'invalid_room_name' };
  const count = db.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE circle_id=? AND kind='room' AND archived_at IS NULL").get(circleId).n;
  if (count >= ROOMS_PER_CIRCLE) return { error: 'rooms_limit' };
  const circlePeople = new Set(membersOf(db, circleId).map(member => member.id));
  if (everyone) {
    // Разговор на весь круг: строк участия нет, позвать и выйти нельзя — в нём
    // все, кто в круге. Круг из одного звать некуда.
    if (circlePeople.size < 2) return { error: 'room_needs_people' };
    const roomId = id(), at = now();
    db.prepare("INSERT INTO chat_rooms(id,circle_id,name,kind,everyone,created_by,created_at) VALUES(?,?,?,'room',1,?,?)").run(roomId, circleId, clean, userId, at);
    system(db, roomId, userId, 'joined', 'завёл(а) разговор для всего круга');
    const room = findRoom(db, roomId);
    for (const person of circlePeople) roomCall(db, room, userId, person, at, `заводит разговор «${clean}» для всего круга`, {source:'заводит разговор «{name}» для всего круга',params:{name:clean}});
    return { room: serializeRoom(db, room, userId) };
  }
  const wanted = [...new Set([userId, ...memberIds])].filter(person => circlePeople.has(person));
  if (wanted.length < 2) return { error: 'room_needs_people' };
  const roomId = id(), at = now();
  db.prepare("INSERT INTO chat_rooms(id,circle_id,name,kind,created_by,created_at) VALUES(?,?,?,'room',?,?)").run(roomId, circleId, clean, userId, at);
  const add = db.prepare('INSERT INTO chat_room_members(room_id,user_id,added_by,joined_at) VALUES(?,?,?,?)');
  for (const person of wanted) add.run(roomId, person, userId, at);
  // Первая строка комнаты — не сообщение, а факт: кто её завёл и с кем.
  const others = wanted.filter(person => person !== userId).map(person => displayName(db.prepare('SELECT * FROM users WHERE id=?').get(person)));
  system(db, roomId, userId, 'joined', `завёл комнату${others.length ? ` с ${others.join(', ')}` : ''}`);
  for (const person of wanted) roomCall(db, findRoom(db, roomId), userId, person, at);
  return { room: serializeRoom(db, findRoom(db, roomId), userId) };
}
function roomCall(db, room, actorId, personId, at = now(), text = null, textTemplate = null) {
  const circle = db.prepare('SELECT id, name, color FROM circles WHERE id=?').get(room.circle_id) || null;
  notify(db, { userId: personId, kind: 'room', actorId, roomId: room.id, circleId: room.circle_id, text: text ?? `зовёт вас в комнату «${room.name}»`, textTemplate: textTemplate ?? (text === null ? {source:'зовёт вас в комнату «{name}»',params:{name:room.name}} : null), data: { circle, roomName: room.name }, at });
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
  if (room.everyone) return { error: 'everyone_room' };
  if (!membership(db, room.circle_id, personId)) return { error: 'not_in_circle' };
  const at = now();
  db.prepare(`INSERT INTO chat_room_members(room_id,user_id,added_by,joined_at) VALUES(?,?,?,?)
    ON CONFLICT(room_id,user_id) DO UPDATE SET left_at=NULL, joined_at=excluded.joined_at`).run(roomId, personId, userId, at);
  system(db, roomId, userId, 'added', `позвал(а) в комнату: ${displayName(db.prepare('SELECT * FROM users WHERE id=?').get(personId))}`);
  roomCall(db, room, userId, personId, at);
  return { room: serializeRoom(db, findRoom(db, roomId), userId) };
}
export function leaveRoom(db, roomId, userId) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  if (room.kind === 'general') return { error: 'general_room' };
  if (room.everyone) return { error: 'everyone_room' };
  db.prepare('UPDATE chat_room_members SET left_at=? WHERE room_id=? AND user_id=?').run(now(), roomId, userId);
  system(db, roomId, userId, 'left', 'вышел(ла) из комнаты');
  // Комната без людей закрывается: пустая комната в списке — мусор.
  if (!roomMembers(db, findRoom(db, roomId)).length) db.prepare('UPDATE chat_rooms SET archived_at=? WHERE id=?').run(now(), roomId);
  return { left: true };
}

// Реакции одним списком на сообщение: какая, сколько, моя ли и первые лица.
function reactionsOf(db, table, column, ids, userId) {
  const out = new Map();
  if (!ids.length) return out;
  for (const row of db
    .prepare(`SELECT r.${column} AS item_id, r.emoji, r.user_id, u.email, u.display_name, u.avatar FROM ${table} r JOIN users u ON u.id=r.user_id
      WHERE r.${column} IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at`)
    .iterate(...ids)) {
    if (!out.has(row.item_id)) out.set(row.item_id, []);
    const list = out.get(row.item_id);
    let entry = list.find(item => item.emoji === row.emoji);
    if (!entry) { entry = { emoji: row.emoji, count: 0, mine: false, people: [] }; list.push(entry); }
    entry.count += 1;
    if (row.user_id === userId) entry.mine = true;
    if (entry.people.length < 3) entry.people.push(publicUser({ ...row, id: row.user_id }));
  }
  return out;
}
export const chatReactionsOf = (db, ids, userId) => reactionsOf(db, 'chat_reactions', 'message_id', ids, userId);
export const commentReactionsOf = (db, ids, userId) => reactionsOf(db, 'comment_reactions', 'comment_id', ids, userId);

// Дело, отданное человеку круга, встаёт в «Общий» карточкой: разговор и работа
// идут в одном месте. Карточка не сообщение — она не считается непрочитанной и
// всегда показывает, что с делом сейчас.
function deedsBetween(db, room, userId, from, to) {
  if (room.kind !== 'general') return [];
  return db
    .prepare(`SELECT a.* FROM assignments a JOIN captures c ON c.id=a.capture_id
      WHERE a.circle_id=? AND a.cancelled_at IS NULL AND c.deleted_at IS NULL AND a.created_at>=? AND a.created_at<? ORDER BY a.created_at`)
    .all(room.circle_id, from, to)
    .map(row => {
      const assigner = db.prepare('SELECT * FROM users WHERE id=?').get(row.assigner_id);
      const assignee = db.prepare('SELECT * FROM users WHERE id=?').get(row.assignee_id);
      return {
        id: `deed:${row.id}`,
        kind: 'deed',
        createdAt: row.created_at,
        author: assigner ? publicUser(assigner) : null,
        mine: row.assigner_id === userId,
        mentions: [],
        reactions: [],
        deed: {
          assignmentId: row.id, captureId: row.capture_id, title: captureTitle(db, row.capture_id), due: captureDue(db, row.capture_id), state: row.state,
          assigner: assigner ? publicUser(assigner) : null, assignee: assignee ? publicUser(assignee) : null, forMe: row.assignee_id === userId,
        },
      };
    });
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
  const reactions = chatReactionsOf(db, ids, userId);
  // Ответ показывает, на что отвечали, даже если исходное сообщение ушло со
  // страницы или его убрали: цитата без текста честно говорит «убрано».
  const replyIds = [...new Set(rows.map(row => row.reply_to).filter(Boolean))];
  const quoted = new Map();
  if (replyIds.length)
    for (const row of db
      .prepare(`SELECT m.id, m.body, m.deleted_at, m.author_id, u.email, u.display_name, u.avatar FROM chat_messages m LEFT JOIN users u ON u.id=m.author_id
        WHERE m.id IN (${replyIds.map(() => '?').join(',')})`)
      .iterate(...replyIds))
      quoted.set(row.id, { id: row.id, body: row.deleted_at ? '' : excerptOf(row.body), removed: Boolean(row.deleted_at), author: row.email ? publicUser({ ...row, id: row.author_id }) : null });
  // Две галочки — кто-то из разговора дочитал до этого сообщения.
  const othersRead = db.prepare('SELECT MAX(last_read_at) AS at FROM chat_reads WHERE room_id=? AND user_id!=?').get(roomId, userId).at || '';
  const said = rows.reverse().map(row => ({
    id: row.id,
    body: row.body,
    kind: row.kind,
    createdAt: row.created_at,
    author: row.email ? publicUser({ ...row, id: row.author_id }) : null,
    mine: row.author_id === userId,
    mentions: mentions.get(row.id) || [],
    replyTo: row.reply_to ? quoted.get(row.reply_to) || { id: row.reply_to, body: '', removed: true, author: null } : null,
    reactions: reactions.get(row.id) || [],
    read: row.author_id === userId ? othersRead >= row.created_at : null,
  }));
  const more = rows.length === limit;
  const deeds = deedsBetween(db, room, userId, more ? said[0].createdAt : '', before || '9999');
  return {
    room: serializeRoom(db, room, userId),
    messages: [...said, ...deeds].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    more,
  };
}

// Кого можно позвать сюда: те, кто уже в разговоре, остальные из этого круга и
// люди из других ваших кругов. Звать можно любого из них, но тому, кого в
// разговоре нет, призыв его открывает — поэтому молча это не делается (см. say).
export function callableInRoom(db, room, userId) {
  const seen = new Map();
  const put = (person, group) => { if (person.id !== userId && !seen.has(person.id)) seen.set(person.id, { ...person, group }); };
  for (const person of roomMembers(db, room)) put(person, 'room');
  for (const person of membersOf(db, room.circle_id)) put(person, 'circle');
  for (const circleId of circleIdsOf(db, userId)) if (circleId !== room.circle_id) for (const person of membersOf(db, circleId)) put(person, 'circles');
  return [...seen.values()];
}

export function say(db, roomId, userId, body, { replyTo = null, join = null } = {}) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  const text = String(body ?? '').trim();
  if (!text || text.length > MESSAGE_LIMIT) return { error: 'invalid_message' };
  const reply = replyTo ? db.prepare("SELECT id, author_id FROM chat_messages WHERE id=? AND room_id=? AND deleted_at IS NULL AND kind='said'").get(replyTo, roomId) : null;
  if (replyTo && !reply) return { error: 'invalid_reply' };
  // Призыв ищется среди всех ваших людей, а не только среди тех, кто здесь:
  // «@Лёша» в комнате, где Лёши нет, раньше пропадал молча. Позвать такого —
  // значит открыть ему разговор (а человека из другого круга — ещё и привести
  // в круг), поэтому без ответа на вопрос сообщение не уходит.
  const callable = callableInRoom(db, room, userId);
  const targets = new Map();
  for (const name of text.match(/@[\p{L}\p{N}_.-]{2,40}/gu) || []) {
    const target = callable.find(person => sameName(name.slice(1), person.name) || normalizeName(name.slice(1)) === normalizeName(person.email));
    if (target) targets.set(target.id, target);
  }
  const outside = [...targets.values()].filter(person => person.group !== 'room');
  if (outside.length && join !== 'yes' && join !== 'no') return { error: 'join_needed', people: outside.map(({ group, ...person }) => ({ ...person, inCircle: group === 'circle' })) };
  // Позванных приводим до самого сообщения: строка «позвал(а) в комнату» должна
  // стоять над ним, а не под.
  if (join === 'yes')
    for (const person of outside) {
      if (!membership(db, room.circle_id, person.id) && addCircleMember(db, room.circle_id, userId, person.id).error) continue;
      if (!wholeCircle(room)) addToRoom(db, room.id, userId, person.id);
    }
  const messageId = id(), at = now();
  db.prepare("INSERT INTO chat_messages(id,room_id,author_id,body,kind,created_at,reply_to) VALUES(?,?,?,?,'said',?,?)").run(messageId, roomId, userId, text, at, reply?.id || null);
  const people = roomMembers(db, room).filter(person => person.id !== userId);
  const called = [];
  const insert = db.prepare('INSERT OR IGNORE INTO chat_mentions(message_id,user_id,created_at) VALUES(?,?,?)');
  for (const target of targets.values()) {
    if (!people.some(person => person.id === target.id)) continue;
    insert.run(messageId, target.id, at);
    called.push(target);
  }
  markRead(db, roomId, userId, at);
  // Призыв и ответ цитатой — поводы для колокольчика и телефона; обычное
  // сообщение ложится одной тихой строкой на разговор, и то если человек сам
  // включил такой повод. Позванному и тому, кому ответили, строка одна.
  const circle = db.prepare('SELECT id, name, color FROM circles WHERE id=?').get(room.circle_id) || null;
  const excerpt = excerptOf(text);
  for (const person of people) {
    const call = called.some(item => item.id === person.id);
    const answered = reply?.author_id === person.id;
    notify(db, call
      ? { userId: person.id, kind: 'call', actorId: userId, roomId, circleId: room.circle_id, text: `зовёт вас в разговоре «${chatTitle(room, circle)}»: «${excerpt}»`, textTemplate: { source: "зовёт вас в разговоре «{title}»: «{excerpt}»", params: { title: chatTitle(room, circle), excerpt: excerpt } }, meta: [], data: { circle, roomName: chatTitle(room, circle) }, at }
      : answered
        ? { userId: person.id, kind: 'reply', actorId: userId, roomId, circleId: room.circle_id, text: `отвечает вам в разговоре «${chatTitle(room, circle)}»: «${excerpt}»`, textTemplate: { source: "отвечает вам в разговоре «{title}»: «{excerpt}»", params: { title: chatTitle(room, circle), excerpt: excerpt } }, meta: [], data: { circle, roomName: chatTitle(room, circle) }, at }
        : { userId: person.id, kind: 'chatter', actorId: userId, roomId, circleId: room.circle_id, text: `в разговоре «${chatTitle(room, circle)}»: «${excerpt}»`, textTemplate: { source: "в разговоре «{title}»: «{excerpt}»", params: { title: chatTitle(room, circle), excerpt: excerpt } }, meta: [], data: { circle, roomName: chatTitle(room, circle) }, group: `chat:${roomId}`, at });
  }
  return { message: messages(db, roomId, userId, { limit: 1 }).messages.find(item => item.id === messageId), called, room: serializeRoom(db, room, userId) };
}

// Реакция ставится и снимается одним нажатием. Автору сообщения — тихая
// склеенная строка на разговор: десять «👍» не должны звенеть десять раз.
export function react(db, roomId, messageId, userId, emoji) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  const message = db.prepare("SELECT * FROM chat_messages WHERE id=? AND room_id=? AND deleted_at IS NULL AND kind='said'").get(messageId, roomId);
  if (!message) return { error: 'not_found' };
  if (!REACTIONS.includes(emoji)) return { error: 'invalid_reaction' };
  const exists = db.prepare('SELECT 1 FROM chat_reactions WHERE message_id=? AND user_id=? AND emoji=?').get(messageId, userId, emoji);
  const at = now();
  if (exists) db.prepare('DELETE FROM chat_reactions WHERE message_id=? AND user_id=? AND emoji=?').run(messageId, userId, emoji);
  else {
    db.prepare('INSERT INTO chat_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)').run(messageId, userId, emoji, at);
    const circle = db.prepare('SELECT id, name, color FROM circles WHERE id=?').get(room.circle_id) || null;
    if (message.author_id) notify(db, { userId: message.author_id, kind: 'reaction', actorId: userId, roomId, circleId: room.circle_id, text: `${emoji} на ваше сообщение в «${chatTitle(room, circle)}»: «${excerptOf(message.body)}»`, textTemplate: { source: "{emoji} на ваше сообщение в «{title}»: «{excerpt}»", params: { emoji: emoji, title: chatTitle(room, circle), excerpt: excerptOf(message.body) } }, data: { circle, roomName: chatTitle(room, circle), emoji }, group: `react:${roomId}`, at });
  }
  return { reactions: chatReactionsOf(db, [messageId], userId).get(messageId) || [], added: !exists };
}

// Закрепить может любой, кто в разговоре: это не власть, а общая памятка —
// «демо в четверг в 11». Закреп один; новый заменяет прежний.
export function pin(db, roomId, userId, messageId = null) {
  const room = findRoom(db, roomId);
  if (!room || !inRoom(db, room, userId)) return { error: 'not_found' };
  if (!messageId) {
    db.prepare('UPDATE chat_rooms SET pinned_message_id=NULL, pinned_by=NULL, pinned_at=NULL WHERE id=?').run(roomId);
    return { room: serializeRoom(db, findRoom(db, roomId), userId) };
  }
  const message = db.prepare("SELECT * FROM chat_messages WHERE id=? AND room_id=? AND deleted_at IS NULL AND kind='said'").get(messageId, roomId);
  if (!message) return { error: 'not_found' };
  const at = now();
  db.prepare('UPDATE chat_rooms SET pinned_message_id=?, pinned_by=?, pinned_at=? WHERE id=?').run(messageId, userId, at, roomId);
  const circle = db.prepare('SELECT id, name, color FROM circles WHERE id=?').get(room.circle_id) || null;
  for (const person of roomMembers(db, room))
    notify(db, { userId: person.id, kind: 'pin', actorId: userId, roomId, circleId: room.circle_id, text: `закрепляет в «${chatTitle(room, circle)}»: «${excerptOf(message.body)}»`, textTemplate: { source: "закрепляет в «{title}»: «{excerpt}»", params: { title: chatTitle(room, circle), excerpt: excerptOf(message.body) } }, data: { circle, roomName: chatTitle(room, circle) }, group: `pin:${roomId}`, at });
  return { room: serializeRoom(db, findRoom(db, roomId), userId) };
}
// Своё сообщение можно убрать: свои слова — свои. Чужие остаются.
export function removeMessage(db, messageId, userId) {
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(messageId);
  if (!row || row.author_id !== userId) return { error: 'not_found' };
  db.prepare('UPDATE chat_messages SET deleted_at=? WHERE id=?').run(now(), messageId);
  db.prepare('UPDATE chat_rooms SET pinned_message_id=NULL, pinned_by=NULL, pinned_at=NULL WHERE pinned_message_id=?').run(messageId);
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
