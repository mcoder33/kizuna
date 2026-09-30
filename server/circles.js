// Круги: общее дело в личном журнале.
//
// Круг — не второй журнал, а общая полка. Запись остаётся у автора; в круг она
// попадает только тогда, когда её туда отправили: назначили исполнителя из
// круга, поставили проект круга или призвали участника в обсуждении. Всё
// остальное остаётся личным — по умолчанию, без переключателей.
//
// Дело уходит человеку тем же одним полем: «Ане — прислать смету до пятницы».
// Разбор и так достаёт участников, здесь только сверяется, есть ли такой
// человек в круге. Просьба не падает в чужой день молча: она приходит полосой
// «к вам», и человек отвечает «беру» или «не я». До ответа автор видит честное
// «ждёт ответа», а не выдуманное «в работе».
import crypto from 'node:crypto';
import { avatarUrl, imageType, AVATAR_IMAGE_LIMIT } from './avatars.js';
import { notify, resolveNotifications } from './notifications.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export const CIRCLE_NAME_LIMIT = 40;
export const CIRCLE_COLORS = ['violet', 'blue', 'teal', 'orange', 'pink', 'red'];
export const CIRCLES_LIMIT = 12;
export const COMMENT_BODY_LIMIT = 4000;
export const DECLINE_REASON_LIMIT = 300;
export const INVITE_TTL_DAYS = 7;
export const NAME_LIMIT = 60;

// ── люди ──

// Имени у учётной записи может не быть: до кругов оно было не нужно, хватало
// почты. Тогда человека зовут по началу адреса — это лучше, чем пустое место
// в строке «просит …».
export function displayName(user) {
  if (!user) return 'кто-то';
  const name = (user.display_name || '').trim();
  return name || String(user.email || '').split('@')[0] || 'кто-то';
}
export function publicUser(user) {
  return { id: user.id, name: displayName(user), email: user.email, initial: displayName(user).slice(0, 1).toUpperCase(), avatar: avatarUrl(user) };
}
export function setDisplayName(db, userId, value) {
  const name = String(value ?? '').trim().slice(0, NAME_LIMIT);
  db.prepare('UPDATE users SET display_name=? WHERE id=?').run(name || null, userId);
  return name || null;
}

// Падежи: «Ане» и «Аня» — один человек. Полной морфологии здесь нет и не
// нужно; хватает того, что имена расходятся только хвостом. Совпадением
// считается общее начало не короче, чем длина большего имени минус два: так
// «аня»/«ане» сходятся, а «аня»/«антон» — нет.
const normalizeName = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sameName(left, right) {
  const a = normalizeName(left), b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return common >= Math.max(2, Math.max(a.length, b.length) - 2);
}

// ── круги ──

const CIRCLE_FIELDS = 'c.id, c.name, c.color, c.photo, c.created_by, c.created_at';
// Фото круга — адрес с версией: браузер держит картинку в кеше, пока её не сменили.
const circlePhotoUrl = row => (row.photo ? `/api/circles/${encodeURIComponent(row.id)}/photo?v=${encodeURIComponent(row.photo)}` : null);
function serializeCircle(row, extra = {}) {
  return { id: row.id, name: row.name, color: row.color, photo: circlePhotoUrl(row), createdBy: row.created_by, createdAt: row.created_at, ...extra };
}

export function circlesOf(db, userId) {
  return db
    .prepare(`SELECT ${CIRCLE_FIELDS}, m.role, m.muted_at FROM circles c JOIN circle_members m ON m.circle_id=c.id
      WHERE m.user_id=? AND m.left_at IS NULL AND c.deleted_at IS NULL ORDER BY c.created_at`)
    .all(userId)
    .map(row => serializeCircle(row, { role: row.role, muted: Boolean(row.muted_at) }));
}
export function circleIdsOf(db, userId) {
  return db.prepare('SELECT circle_id FROM circle_members WHERE user_id=? AND left_at IS NULL').all(userId).map(row => row.circle_id);
}
export function membership(db, circleId, userId) {
  return db.prepare('SELECT * FROM circle_members WHERE circle_id=? AND user_id=? AND left_at IS NULL').get(circleId, userId) || null;
}
export function membersOf(db, circleId) {
  return db
    .prepare(`SELECT u.*, m.role, m.joined_at FROM circle_members m JOIN users u ON u.id=m.user_id
      WHERE m.circle_id=? AND m.left_at IS NULL ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at`)
    .all(circleId)
    .map(row => ({ ...publicUser(row), role: row.role, joinedAt: row.joined_at }));
}

export function createCircle(db, userId, name, color = 'violet') {
  const clean = String(name ?? '').trim().slice(0, CIRCLE_NAME_LIMIT);
  if (!clean) return { error: 'invalid_name' };
  if (!CIRCLE_COLORS.includes(color)) return { error: 'invalid_color' };
  if (circlesOf(db, userId).length >= CIRCLES_LIMIT) return { error: 'circles_limit' };
  const circleId = id(), at = now();
  db.prepare('INSERT INTO circles(id,name,color,created_by,created_at) VALUES(?,?,?,?,?)').run(circleId, clean, color, userId, at);
  db.prepare("INSERT INTO circle_members(circle_id,user_id,role,joined_at) VALUES(?,?,'owner',?)").run(circleId, userId, at);
  return { circle: circleDetail(db, circleId, userId) };
}
export function updateCircle(db, circleId, userId, { name, color }) {
  const member = membership(db, circleId, userId);
  if (!member) return { error: 'not_found' };
  if (member.role !== 'owner') return { error: 'not_owner' };
  if (name !== undefined) {
    const clean = String(name ?? '').trim().slice(0, CIRCLE_NAME_LIMIT);
    if (!clean) return { error: 'invalid_name' };
    db.prepare('UPDATE circles SET name=? WHERE id=?').run(clean, circleId);
  }
  if (color !== undefined) {
    if (!CIRCLE_COLORS.includes(color)) return { error: 'invalid_color' };
    db.prepare('UPDATE circles SET color=? WHERE id=?').run(color, circleId);
  }
  return { circle: circleDetail(db, circleId, userId) };
}

// Фото круга вместо буквы на знаке — как фото группы в Телеграме. Ставит и
// убирает его хозяин, как имя и цвет; видят все, кто в круге. Байты лежат
// отдельной таблицей, в строке круга — только версия: список кругов не таскает
// за собой килобайты. Картинку ужимает браузер, сервер проверяет формат по
// самим байтам — так же, как у лица человека (server/avatars.js).
function ownCircle(db, circleId, userId) {
  const member = membership(db, circleId, userId);
  if (!member || !db.prepare('SELECT 1 FROM circles WHERE id=? AND deleted_at IS NULL').get(circleId)) return { error: 'not_found' };
  if (member.role !== 'owner') return { error: 'not_owner' };
  return {};
}
export function setCirclePhoto(db, circleId, userId, bytes, at = new Date()) {
  const owned = ownCircle(db, circleId, userId);
  if (owned.error) return owned;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { error: 'empty_image' };
  if (bytes.length > AVATAR_IMAGE_LIMIT) return { error: 'image_too_large' };
  const mime = imageType(bytes);
  if (!mime) return { error: 'not_an_image' };
  db.transaction(() => {
    db.prepare(`INSERT INTO circle_photos(circle_id, mime, bytes, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(circle_id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes, updated_at=excluded.updated_at`).run(circleId, mime, bytes, at.toISOString());
    db.prepare('UPDATE circles SET photo=? WHERE id=?').run(at.getTime().toString(36), circleId);
  })();
  return { circle: circleDetail(db, circleId, userId) };
}
export function removeCirclePhoto(db, circleId, userId) {
  const owned = ownCircle(db, circleId, userId);
  if (owned.error) return owned;
  db.transaction(() => {
    db.prepare('DELETE FROM circle_photos WHERE circle_id=?').run(circleId);
    db.prepare('UPDATE circles SET photo=NULL WHERE id=?').run(circleId);
  })();
  return { circle: circleDetail(db, circleId, userId) };
}
export function circlePhoto(db, circleId, userId) {
  if (!membership(db, circleId, userId)) return null;
  return db.prepare(`SELECT p.mime, p.bytes FROM circles c JOIN circle_photos p ON p.circle_id=c.id
    WHERE c.id=? AND c.deleted_at IS NULL AND c.photo IS NOT NULL`).get(circleId) || null;
}

// Выключение круга — личное и обратимое: круг вы не покидаете, дела остаются на
// месте, остальные ничего не замечают. Из списков дела уходят, но просьбы
// продолжают приходить свёрнутой строкой — тихо ронять чужие просьбы нельзя.
export function setMuted(db, circleId, userId, muted) {
  const member = membership(db, circleId, userId);
  if (!member) return { error: 'not_found' };
  db.prepare('UPDATE circle_members SET muted_at=? WHERE circle_id=? AND user_id=?').run(muted ? now() : null, circleId, userId);
  return { circle: circleDetail(db, circleId, userId) };
}
export function mutedCircleIds(db, userId) {
  return new Set(db.prepare('SELECT circle_id FROM circle_members WHERE user_id=? AND left_at IS NULL AND muted_at IS NOT NULL').all(userId).map(row => row.circle_id));
}

export function circleDetail(db, circleId, userId) {
  const row = db.prepare(`SELECT ${CIRCLE_FIELDS}, m.role, m.muted_at FROM circles c JOIN circle_members m ON m.circle_id=c.id AND m.user_id=? AND m.left_at IS NULL
    WHERE c.id=? AND c.deleted_at IS NULL`).get(userId, circleId);
  if (!row) return null;
  const open = db.prepare(`SELECT a.assignee_id, COUNT(*) AS n FROM assignments a WHERE a.circle_id=? AND a.state IN ('pending','accepted') GROUP BY a.assignee_id`).all(circleId);
  const byUser = new Map(open.map(item => [item.assignee_id, item.n]));
  const deedsOf = db.prepare(`SELECT a.capture_id, a.state FROM assignments a JOIN captures c ON c.id=a.capture_id
    WHERE a.circle_id=? AND a.assignee_id=? AND a.cancelled_at IS NULL AND c.deleted_at IS NULL AND a.state IN ('pending','accepted') ORDER BY a.created_at LIMIT 3`);
  return serializeCircle(row, {
    role: row.role,
    muted: Boolean(row.muted_at),
    members: membersOf(db, circleId).map(member => ({
      ...member,
      openDeeds: byUser.get(member.id) || 0,
      deeds: deedsOf.all(circleId, member.id).map(deed => ({ captureId: deed.capture_id, title: titleOf(db, deed.capture_id), due: dueOf(db, deed.capture_id), state: deed.state })),
    })),
    captureCount: db.prepare('SELECT COUNT(*) AS n FROM capture_circles WHERE circle_id=? AND removed_at IS NULL').get(circleId).n,
    invite: inviteState(db, circleId),
  });
}

// Покинуть круг может каждый, кроме последнего хозяина: круг не должен
// остаться без того, кто зовёт людей. Дела, которые человек взял, остаются —
// он их взял.
export function leaveCircle(db, circleId, userId) {
  const member = membership(db, circleId, userId);
  if (!member) return { error: 'not_found' };
  const owners = db.prepare("SELECT COUNT(*) AS n FROM circle_members WHERE circle_id=? AND left_at IS NULL AND role='owner'").get(circleId).n;
  if (member.role === 'owner' && owners <= 1) return { error: 'last_owner' };
  db.prepare('UPDATE circle_members SET left_at=? WHERE circle_id=? AND user_id=?').run(now(), circleId, userId);
  return { left: true };
}

// ── приглашения ──

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
// Ссылка у круга одна и работает для многих: звать десятерых десятью ссылками
// неудобно, а охранять ей нечего — круг виден только тем, кто в нём, и войти по
// ней может лишь тот, у кого уже есть учётная запись в приложении. Сам токен не
// хранится, только его SHA-256; поэтому «показать ссылку ещё раз» невозможно —
// её показывают один раз тому, кто её завёл, а забыли — обновите.
export function createInvite(db, circleId, userId) {
  const member = membership(db, circleId, userId);
  if (!member) return { error: 'not_found' };
  const token = crypto.randomBytes(18).toString('base64url'), at = now();
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();
  db.prepare('UPDATE circle_invites SET revoked_at=? WHERE circle_id=? AND revoked_at IS NULL').run(at, circleId);
  db.prepare('INSERT INTO circle_invites(id,circle_id,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id(), circleId, hashToken(token), userId, at, expires);
  return { token, expiresAt: expires, uses: 0 };
}
// Что известно о живой ссылке круга, когда самого токена у нас нет: когда
// заведена, до какого числа живёт и сколько людей по ней вошло.
export function inviteState(db, circleId) {
  const row = db.prepare('SELECT * FROM circle_invites WHERE circle_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get(circleId);
  if (!row) return null;
  return { createdAt: row.created_at, expiresAt: row.expires_at, uses: row.uses, expired: row.expires_at < now() };
}
// Приглашённый видит, кто зовёт и во что, ещё до согласия: иначе он нажимает
// «войти» вслепую.
export function peekInvite(db, token) {
  const row = db.prepare(`SELECT i.*, c.name, c.color, c.deleted_at, u.email, u.display_name FROM circle_invites i
    JOIN circles c ON c.id=i.circle_id JOIN users u ON u.id=i.created_by WHERE i.token_hash=?`).get(hashToken(token));
  if (!row || row.deleted_at) return { error: 'invite_not_found' };
  if (row.revoked_at) return { error: 'invite_used' };
  if (row.expires_at < now()) return { error: 'invite_expired' };
  return { circle: { id: row.circle_id, name: row.name, color: row.color }, invitedBy: displayName(row), members: membersOf(db, row.circle_id).length };
}
export function acceptInvite(db, token, userId) {
  const peek = peekInvite(db, token);
  if (peek.error) return peek;
  const at = now();
  const existing = db.prepare('SELECT * FROM circle_members WHERE circle_id=? AND user_id=?').get(peek.circle.id, userId);
  // Ссылка не тратится: она заведена для многих. Считается только, сколько
  // людей по ней вошло — это и есть весь её учёт.
  db.prepare('UPDATE circle_invites SET uses=uses+1, used_at=?, used_by=? WHERE token_hash=? AND revoked_at IS NULL').run(at, userId, hashToken(token));
  if (existing && !existing.left_at) return { circle: circleDetail(db, peek.circle.id, userId), already: true };
  if (existing) db.prepare('UPDATE circle_members SET left_at=NULL, joined_at=?, muted_at=NULL WHERE circle_id=? AND user_id=?').run(at, peek.circle.id, userId);
  else db.prepare("INSERT INTO circle_members(circle_id,user_id,role,joined_at) VALUES(?,?,'member',?)").run(peek.circle.id, userId, at);
  db.prepare('UPDATE circle_invites SET used_at=?, used_by=? WHERE token_hash=?').run(at, userId, hashToken(token));
  return { circle: circleDetail(db, peek.circle.id, userId) };
}

// Кого можно позвать: люди приложения, которых в круге ещё нет. Ищем по имени
// и по почте, и только среди работающих учётных записей — заявка, которую
// администратор ещё не одобрил, в круг попасть не может.
export const CANDIDATES_LIMIT = 20;
export function candidates(db, circleId, userId, query) {
  if (!membership(db, circleId, userId)) return { error: 'not_found' };
  const text = String(query || '').trim().toLocaleLowerCase('ru-RU');
  const inside = new Set(db.prepare('SELECT user_id FROM circle_members WHERE circle_id=? AND left_at IS NULL').all(circleId).map(row => row.user_id));
  const matches = person => !text || displayName(person).toLocaleLowerCase('ru-RU').includes(text) || String(person.email).toLocaleLowerCase('ru-RU').includes(text);
  const rest = db
    .prepare("SELECT * FROM users WHERE status='active' ORDER BY COALESCE(display_name, email) LIMIT 200")
    .all()
    .filter(person => !inside.has(person.id));
  return { people: rest.filter(matches).slice(0, CANDIDATES_LIMIT).map(publicUser), all: rest.length };
}
// Добавить сразу — то, ради чего люди и заводят круг: искать ссылку ради
// человека, который уже в приложении, незачем. Своего у него при этом никто не
// увидит: в круге видно только то, что в него отдали, а сам он узнаёт о
// добавлении строкой «к вам» и может выйти в одно нажатие.
export function addMember(db, circleId, userId, personId) {
  if (!membership(db, circleId, userId)) return { error: 'not_found' };
  const person = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(personId);
  if (!person) return { error: 'person_not_found' };
  if (membership(db, circleId, personId)) return { error: 'already_member' };
  const at = now();
  const existing = db.prepare('SELECT 1 FROM circle_members WHERE circle_id=? AND user_id=?').get(circleId, personId);
  if (existing) db.prepare('UPDATE circle_members SET left_at=NULL, joined_at=?, muted_at=NULL, added_by=?, seen_at=NULL WHERE circle_id=? AND user_id=?').run(at, userId, circleId, personId);
  else db.prepare("INSERT INTO circle_members(circle_id,user_id,role,joined_at,added_by) VALUES(?,?,'member',?,?)").run(circleId, personId, at, userId);
  const brief = circleBrief(db, circleId);
  notify(db, { userId: personId, kind: 'circle', actorId: userId, circleId, text: `добавляет вас в круг «${brief?.name || ''}»`, meta: ['видно только то, что в круг отдали'], data: { circle: brief }, at });
  return { circle: circleDetail(db, circleId, userId), person: publicUser(person) };
}
// Пока человек не открыл круг, в который его добавили, об этом говорит строка
// «к вам»: добавить молча — то же самое, что положить дело в чужой день молча.
export function newCircles(db, userId) {
  return db
    .prepare(`SELECT c.id, c.name, c.color, m.joined_at, m.added_by, u.email, u.display_name, u.avatar FROM circle_members m
      JOIN circles c ON c.id=m.circle_id LEFT JOIN users u ON u.id=m.added_by
      WHERE m.user_id=? AND m.left_at IS NULL AND m.added_by IS NOT NULL AND m.seen_at IS NULL AND c.deleted_at IS NULL
      ORDER BY m.joined_at`)
    .all(userId)
    .map(row => ({
      kind: 'circle',
      id: row.id,
      circle: { id: row.id, name: row.name, color: row.color },
      title: `вас добавили в круг «${row.name}»`,
      from: row.email ? publicUser({ ...row, id: row.added_by }) : null,
      createdAt: row.joined_at,
    }));
}
export function markCircleSeen(db, circleId, userId) {
  db.prepare('UPDATE circle_members SET seen_at=? WHERE circle_id=? AND user_id=? AND seen_at IS NULL').run(now(), circleId, userId);
  return { seen: true };
}

// ── видимость записи ──

export function circlesForCapture(db, captureId) {
  return db
    .prepare('SELECT c.id, c.name, c.color FROM capture_circles cc JOIN circles c ON c.id=cc.circle_id WHERE cc.capture_id=? AND cc.removed_at IS NULL AND c.deleted_at IS NULL')
    .all(captureId)
    .map(row => ({ id: row.id, name: row.name, color: row.color }));
}
// Метка круга для списков: одна на запись — та, в которую её отправили.
export function circleMarksFor(db, userId) {
  const marks = new Map();
  for (const row of db
    .prepare(`SELECT cc.capture_id, c.id, c.name, c.color FROM capture_circles cc JOIN circles c ON c.id=cc.circle_id
      JOIN circle_members m ON m.circle_id=c.id AND m.user_id=? AND m.left_at IS NULL
      WHERE cc.removed_at IS NULL AND c.deleted_at IS NULL ORDER BY cc.shared_at`)
    .iterate(userId))
    if (!marks.has(row.capture_id)) marks.set(row.capture_id, { id: row.id, name: row.name, color: row.color });
  return marks;
}
export function shareCapture(db, captureId, circleId, userId) {
  const at = now();
  db.prepare(`INSERT INTO capture_circles(capture_id,circle_id,shared_by,shared_at) VALUES(?,?,?,?)
    ON CONFLICT(capture_id,circle_id) DO UPDATE SET removed_at=NULL, shared_at=excluded.shared_at`).run(captureId, circleId, userId, at);
}
export function unshareCapture(db, captureId, circleId) {
  db.prepare('UPDATE capture_circles SET removed_at=? WHERE capture_id=? AND circle_id=? AND removed_at IS NULL').run(now(), captureId, circleId);
}
// Запись видна своему автору всегда, а участнику круга — пока она в круге.
// Ответ на чужое остаётся честным «не найдено»: существование чужой записи —
// тоже не наше дело.
export function canSeeCapture(db, captureId, userId) {
  const capture = db.prepare('SELECT user_id FROM captures WHERE id=?').get(captureId);
  if (!capture) return false;
  if (capture.user_id === userId) return true;
  if (isParticipant(db, captureId, userId)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM capture_circles cc JOIN circle_members m ON m.circle_id=cc.circle_id AND m.user_id=? AND m.left_at IS NULL
    WHERE cc.capture_id=? AND cc.removed_at IS NULL`).get(userId, captureId));
}

// ── дела другим людям ──

const ASSIGNMENT_OPEN = "('pending','accepted')";
export function assignmentFor(db, captureId) {
  const row = db.prepare('SELECT * FROM assignments WHERE capture_id=? AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1').get(captureId);
  return row ? serializeAssignment(db, row) : null;
}
function serializeAssignment(db, row) {
  const assignee = db.prepare('SELECT * FROM users WHERE id=?').get(row.assignee_id);
  const assigner = db.prepare('SELECT * FROM users WHERE id=?').get(row.assigner_id);
  const circle = row.circle_id ? db.prepare('SELECT id,name,color FROM circles WHERE id=?').get(row.circle_id) : null;
  return {
    id: row.id,
    captureId: row.capture_id,
    // Название и срок — того дела, о котором просьба: без них список «я жду»
    // говорил бы, кому отдали, но не что.
    title: titleOf(db, row.capture_id, db.prepare('SELECT raw FROM captures WHERE id=?').get(row.capture_id)?.raw),
    due: dueOf(db, row.capture_id),
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    doneAt: row.done_at,
    assignee: assignee ? publicUser(assignee) : null,
    assigner: assigner ? publicUser(assigner) : null,
    circle: circle || null,
  };
}

// Кого просят: имя из разбора сверяется с людьми моих кругов. Двух похожих
// приложение не выбирает — угадывать, кому досталось дело, нельзя; в этом
// случае исполнителя ставят руками в карточке.
export function matchAssignee(db, userId, people) {
  if (!Array.isArray(people) || !people.length) return null;
  const candidates = db
    .prepare(`SELECT u.id, u.email, u.display_name, m.circle_id FROM circle_members m JOIN users u ON u.id=m.user_id
      JOIN circle_members mine ON mine.circle_id=m.circle_id AND mine.user_id=? AND mine.left_at IS NULL
      WHERE m.left_at IS NULL AND m.user_id!=? AND u.status='active'`)
    .all(userId, userId);
  const found = [];
  for (const person of people)
    for (const candidate of candidates) {
      if (!sameName(person, displayName(candidate)) && normalizeName(person) !== normalizeName(candidate.email)) continue;
      if (!found.some(item => item.id === candidate.id)) found.push({ id: candidate.id, circleId: candidate.circle_id });
    }
  return found.length === 1 ? found[0] : null;
}

export function assign(db, { captureId, assigneeId, assignerId, circleId = null }) {
  const capture = db.prepare('SELECT user_id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
  if (!capture) return { error: 'not_found' };
  if (capture.user_id !== assignerId) return { error: 'not_owner' };
  if (assigneeId === assignerId) return { error: 'self_assign' };
  const shared = new Set(circleIdsOf(db, assigneeId).filter(circle => circleIdsOf(db, assignerId).includes(circle)));
  const circle = circleId && shared.has(circleId) ? circleId : [...shared][0];
  if (!circle) return { error: 'not_in_circle' };
  const at = now();
  db.prepare('UPDATE assignments SET cancelled_at=? WHERE capture_id=? AND cancelled_at IS NULL').run(at, captureId);
  resolveNotifications(db, { kind: 'request', captureId, at });
  const assignmentId = id();
  db.prepare("INSERT INTO assignments(id,capture_id,circle_id,assignee_id,assigner_id,state,created_at) VALUES(?,?,?,?,?,'pending',?)").run(assignmentId, captureId, circle, assigneeId, assignerId, at);
  shareCapture(db, captureId, circle, assignerId);
  // Просьба ждёт ответа — и в полосе «к вам», и за колокольчиком, и на
  // телефоне, если человек не у экрана.
  notify(db, { userId: assigneeId, kind: 'request', actorId: assignerId, captureId, circleId: circle, assignmentId, text: `просит: «${titleOf(db, captureId)}»`, meta: [dueWords(dueOf(db, captureId))], data: { circle: circleBrief(db, circle), due: dueOf(db, captureId) }, at });
  return { assignment: assignmentFor(db, captureId) };
}
export function unassign(db, captureId, userId) {
  const capture = db.prepare('SELECT user_id FROM captures WHERE id=?').get(captureId);
  if (!capture || capture.user_id !== userId) return { error: 'not_found' };
  const current = db.prepare('SELECT * FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(captureId);
  if (!current) return { assignment: null };
  db.prepare('UPDATE assignments SET cancelled_at=? WHERE id=?').run(now(), current.id);
  resolveNotifications(db, { kind: 'request', assignmentId: current.id });
  if (current.circle_id) unshareCapture(db, captureId, current.circle_id);
  return { assignment: null };
}
// «Беру» опускает дело в день исполнителя; «не я» возвращает его автору вместе
// с причиной, если её написали.
export function respond(db, assignmentId, userId, take, reason = null) {
  const row = db.prepare('SELECT * FROM assignments WHERE id=? AND cancelled_at IS NULL').get(assignmentId);
  if (!row || row.assignee_id !== userId) return { error: 'not_found' };
  if (row.state !== 'pending') return { error: 'already_answered' };
  const at = now();
  const why = take ? null : String(reason || '').trim().slice(0, DECLINE_REASON_LIMIT) || null;
  db.prepare('UPDATE assignments SET state=?, responded_at=?, reason=? WHERE id=?')
    .run(take ? 'accepted' : 'declined', at, why, assignmentId);
  resolveNotifications(db, { kind: 'request', assignmentId, at });
  const title = titleOf(db, row.capture_id);
  notify(db, { userId: row.assigner_id, kind: 'answer', actorId: userId, captureId: row.capture_id, circleId: row.circle_id, assignmentId,
    text: take ? `берёт «${title}»` : `возвращает «${title}»${why ? `: «${why}»` : ''}`, meta: [take ? 'ваша просьба' : 'просьба вернулась к вам'], data: { circle: circleBrief(db, row.circle_id), state: take ? 'accepted' : 'declined' }, at });
  return { assignment: assignmentFor(db, row.capture_id) };
}
// Закрытое дело закрывает и просьбу: автор узнаёт об этом в «Я жду», а в свой
// журнал чужую работу не записывает — он её не делал. Закрыть может и сам
// автор, пока просьба ещё ждёт ответа: тогда она уходит из «к вам» у
// исполнителя, а возврат в работу снова ставит её туда.
export function noteCompletion(db, captureId, completed) {
  const row = db.prepare('SELECT * FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(captureId);
  if (!row) return;
  const at = now();
  if (completed && row.state === 'accepted') {
    db.prepare("UPDATE assignments SET state='done', done_at=? WHERE id=?").run(at, row.id);
    notify(db, { userId: row.assigner_id, kind: 'answer', actorId: row.assignee_id, captureId, circleId: row.circle_id, assignmentId: row.id, text: `отмечает сделанным «${titleOf(db, captureId)}»`, meta: ['ваша просьба закрыта'], data: { circle: circleBrief(db, row.circle_id), state: 'done' } });
  }
  if (completed && row.state === 'pending') {
    db.prepare("UPDATE assignments SET state='done', done_at=? WHERE id=?").run(at, row.id);
    resolveNotifications(db, { kind: 'request', assignmentId: row.id, at });
  }
  if (!completed && row.state === 'done') db.prepare('UPDATE assignments SET state=?, done_at=NULL WHERE id=?').run(row.responded_at ? 'accepted' : 'pending', row.id);
}

// Дела, которые я отдал: четыре состояния и ни одного лишнего — ждёт ответа,
// взял, сделано, вернул.
export function waiting(db, userId) {
  return db
    .prepare(`SELECT a.* FROM assignments a JOIN captures c ON c.id=a.capture_id
      WHERE a.assigner_id=? AND a.cancelled_at IS NULL AND c.deleted_at IS NULL ORDER BY a.created_at DESC`)
    .all(userId)
    .map(row => serializeAssignment(db, row));
}
export function assignmentsTo(db, userId, states = ['pending', 'accepted']) {
  const marks = states.map(() => '?').join(',');
  return db
    .prepare(`SELECT a.* FROM assignments a JOIN captures c ON c.id=a.capture_id
      WHERE a.assignee_id=? AND a.cancelled_at IS NULL AND c.deleted_at IS NULL AND a.state IN (${marks}) ORDER BY a.created_at`)
    .all(userId, ...states)
    .map(row => serializeAssignment(db, row));
}

// ── обсуждение и призыв ──

export function comments(db, captureId, userId = null) {
  const rows = db
    .prepare(`SELECT m.*, u.email, u.display_name, u.avatar FROM comments m JOIN users u ON u.id=m.author_id
      WHERE m.capture_id=? AND m.deleted_at IS NULL ORDER BY m.created_at`)
    .all(captureId);
  const byId = new Map(rows.map(row => [row.id, row]));
  const reactions = reactionsOfComments(db, rows.map(row => row.id), userId);
  const othersRead = userId ? db.prepare('SELECT MAX(last_read_at) AS at FROM comment_reads WHERE capture_id=? AND user_id!=?').get(captureId, userId).at || '' : '';
  const mentions = new Map();
  for (const row of db
    .prepare(`SELECT cm.comment_id, u.id, u.email, u.display_name, u.avatar FROM comment_mentions cm JOIN users u ON u.id=cm.user_id
      JOIN comments c ON c.id=cm.comment_id WHERE c.capture_id=?`)
    .iterate(captureId)) {
    if (!mentions.has(row.comment_id)) mentions.set(row.comment_id, []);
    mentions.get(row.comment_id).push(publicUser(row));
  }
  return rows.map(row => {
    const parent = row.parent_id ? byId.get(row.parent_id) : null;
    return {
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      parentId: row.parent_id,
      author: publicUser({ ...row, id: row.author_id }),
      mentions: mentions.get(row.id) || [],
      replyTo: row.parent_id ? (parent ? { id: parent.id, body: excerpt(parent.body), author: publicUser({ ...parent, id: parent.author_id }), removed: false } : { id: row.parent_id, body: '', author: null, removed: true }) : null,
      reactions: reactions.get(row.id) || [],
      read: userId && row.author_id === userId ? othersRead >= row.created_at : null,
    };
  });
}
const excerpt = text => (text.length > 140 ? `${text.slice(0, 139)}…` : text);
// Те же шесть реакций, что в разговоре круга.
export const COMMENT_REACTIONS = ['👍', '❤️', '🔥', '🙏', '👀', '✅'];
function reactionsOfComments(db, ids, userId) {
  const out = new Map();
  if (!ids.length) return out;
  for (const row of db
    .prepare(`SELECT r.comment_id, r.emoji, r.user_id, u.email, u.display_name, u.avatar FROM comment_reactions r JOIN users u ON u.id=r.user_id
      WHERE r.comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at`)
    .iterate(...ids)) {
    if (!out.has(row.comment_id)) out.set(row.comment_id, []);
    const list = out.get(row.comment_id);
    let entry = list.find(item => item.emoji === row.emoji);
    if (!entry) { entry = { emoji: row.emoji, count: 0, mine: false, people: [] }; list.push(entry); }
    entry.count += 1;
    if (row.user_id === userId) entry.mine = true;
    if (entry.people.length < 3) entry.people.push(publicUser({ ...row, id: row.user_id }));
  }
  return out;
}
export function reactComment(db, captureId, commentId, userId, emoji) {
  const comment = db.prepare('SELECT * FROM comments WHERE id=? AND capture_id=? AND deleted_at IS NULL').get(commentId, captureId);
  if (!comment) return { error: 'not_found' };
  if (!COMMENT_REACTIONS.includes(emoji)) return { error: 'invalid_reaction' };
  const exists = db.prepare('SELECT 1 FROM comment_reactions WHERE comment_id=? AND user_id=? AND emoji=?').get(commentId, userId, emoji);
  const at = now();
  if (exists) db.prepare('DELETE FROM comment_reactions WHERE comment_id=? AND user_id=? AND emoji=?').run(commentId, userId, emoji);
  else {
    db.prepare('INSERT INTO comment_reactions(comment_id,user_id,emoji,created_at) VALUES(?,?,?,?)').run(commentId, userId, emoji, at);
    const circle = circlesForCapture(db, captureId)[0] || null;
    notify(db, { userId: comment.author_id, kind: 'reaction', actorId: userId, captureId, circleId: circle?.id || null, text: `${emoji} на ваше сообщение в «${titleOf(db, captureId)}»: «${excerpt(comment.body)}»`, data: { circle, emoji }, group: `react:capture:${captureId}`, at });
  }
  return { reactions: reactionsOfComments(db, [commentId], userId).get(commentId) || [], added: !exists };
}
// Прочитанное обсуждение: число в списке разговоров считается от этой отметки.
export function markCommentsRead(db, captureId, userId, at = now()) {
  db.prepare(`INSERT INTO comment_reads(capture_id,user_id,last_read_at) VALUES(?,?,?)
    ON CONFLICT(capture_id,user_id) DO UPDATE SET last_read_at=excluded.last_read_at`).run(captureId, userId, at);
}
// Сколько чужих сообщений человек ещё не видел. Открытая карточка сразу
// отмечает разговор прочитанным, поэтому число спрашивают до отметки: по нему
// свёрнутый разговор пишет «1 новое».
export function unreadComments(db, captureId, userId) {
  const at = db.prepare('SELECT last_read_at FROM comment_reads WHERE capture_id=? AND user_id=?').get(captureId, userId)?.last_read_at || '';
  return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE capture_id=? AND deleted_at IS NULL AND author_id!=? AND created_at>?').get(captureId, userId, at).n;
}
// Кого можно призвать — тремя группами, в этом порядке: те, кто запись уже
// видит (автор, позванные, круг записи), люди из моих кругов и все остальные
// в Кизуне. Круг для разговора не нужен: позванный получает доступ к одной
// этой записи. Звать «всех в Кизуне» может только автор — позванный делится
// чужой записью лишь с теми, кого знает сам.
export function callableFor(db, captureId, userId) {
  const seen = new Map();
  const put = (person, group) => { if (person && person.id !== userId && !seen.has(person.id)) seen.set(person.id, { ...person, group, sees: group === 'record' }); };
  const owner = db.prepare('SELECT u.* FROM captures c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(captureId);
  if (owner && owner.status === 'active') put(publicUser(owner), 'record');
  for (const person of captureParticipants(db, captureId)) put(person, 'record');
  for (const circle of circlesForCapture(db, captureId)) for (const member of membersOf(db, circle.id)) put(member, 'record');
  for (const circleId of circleIdsOf(db, userId)) for (const member of membersOf(db, circleId)) put(member, 'circles');
  if (owner?.id === userId)
    for (const row of db.prepare("SELECT * FROM users WHERE status='active' ORDER BY COALESCE(display_name, email) LIMIT 200").all()) put(publicUser(row), 'everyone');
  return [...seen.values()];
}
// Сообщение с призывом того, кто запись ещё не видит, — это и есть «поделиться».
// Молча это не происходит: без `share` сервер отвечает share_needed и
// называет людей, а клиент спрашивает. `share: 'yes'` — позвать и открыть
// запись, `share: 'no'` — отправить, а незнакомых оставить без призыва.
export function addComment(db, { captureId, authorId, body, parentId = null, share = null }) {
  const text = String(body ?? '').trim();
  if (!text || text.length > COMMENT_BODY_LIMIT) return { error: 'invalid_comment' };
  if (parentId && !db.prepare('SELECT 1 FROM comments WHERE id=? AND capture_id=?').get(parentId, captureId)) return { error: 'not_found' };
  const callable = callableFor(db, captureId, authorId);
  const targets = new Map();
  for (const name of text.match(/@[\p{L}\p{N}_.-]{2,40}/gu) || []) {
    const target = callable.find(person => sameName(name.slice(1), person.name) || normalizeName(name.slice(1)) === normalizeName(person.email));
    if (target) targets.set(target.id, target);
  }
  const strangers = [...targets.values()].filter(person => !canSeeCapture(db, captureId, person.id));
  if (strangers.length && share !== 'yes' && share !== 'no') return { error: 'share_needed', people: strangers.map(({ group, sees, ...person }) => person) };
  const commentId = id(), at = now();
  db.prepare('INSERT INTO comments(id,capture_id,author_id,body,parent_id,created_at) VALUES(?,?,?,?,?,?)').run(commentId, captureId, authorId, text, parentId, at);
  markCommentsRead(db, captureId, authorId, at);
  const added = [];
  if (share === 'yes') for (const person of strangers) { addParticipant(db, captureId, person.id, authorId, at); added.push(person.id); }
  const insert = db.prepare('INSERT OR IGNORE INTO comment_mentions(comment_id,user_id,created_at) VALUES(?,?,?)');
  // Призванному — строка за колокольчиком и телефон. Тем, кто следит за
  // записью (автор, исполнитель, позванные в неё), — тихая склеенная строка на
  // обсуждение, если они сами включили «пишут без призыва».
  const title = titleOf(db, captureId);
  const circle = circlesForCapture(db, captureId)[0] || null;
  const excerpt = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  const called = new Set();
  for (const target of targets.values()) {
    if (share !== 'yes' && strangers.includes(target)) continue;
    insert.run(commentId, target.id, at);
    called.add(target.id);
    notify(db, { userId: target.id, kind: 'call', actorId: authorId, captureId, circleId: circle?.id || null, text: `зовёт вас в обсуждении «${title}»: «${excerpt}»`, data: { circle }, at });
  }
  // Ответ цитатой — как призыв: тому, кому ответили, строка и телефон.
  const parentAuthor = parentId ? db.prepare('SELECT author_id FROM comments WHERE id=?').get(parentId)?.author_id : null;
  if (parentAuthor && parentAuthor !== authorId && !called.has(parentAuthor) && canSeeCapture(db, captureId, parentAuthor)) {
    notify(db, { userId: parentAuthor, kind: 'reply', actorId: authorId, captureId, circleId: circle?.id || null, text: `отвечает вам в обсуждении «${title}»: «${excerpt}»`, data: { circle }, at });
    called.add(parentAuthor);
  }
  const participants = captureParticipants(db, captureId);
  const owner = db.prepare('SELECT user_id FROM captures WHERE id=?').get(captureId)?.user_id;
  const assignee = db.prepare('SELECT assignee_id FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(captureId)?.assignee_id;
  for (const follower of new Set([owner, assignee, ...participants.map(person => person.id)].filter(Boolean))) {
    if (follower === authorId || called.has(follower)) continue;
    notify(db, { userId: follower, kind: 'chatter', actorId: authorId, captureId, circleId: circle?.id || null, text: `в обсуждении «${title}»: «${excerpt}»`, data: { circle }, group: `comments:${captureId}`, at });
  }
  return { comment: comments(db, captureId, authorId).find(item => item.id === commentId), added, participants };
}
export function unseenMentions(db, userId) {
  return db
    .prepare(`SELECT cm.comment_id, c.id AS capture_id, c.raw, m.body, m.created_at, u.email, u.display_name, u.avatar, m.author_id
      FROM comment_mentions cm JOIN comments m ON m.id=cm.comment_id JOIN captures c ON c.id=m.capture_id JOIN users u ON u.id=m.author_id
      WHERE cm.user_id=? AND cm.seen_at IS NULL AND m.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY m.created_at`)
    .all(userId)
    // Убрали из записи — старый призыв не должен звать туда, куда не пустят.
    .filter(row => canSeeCapture(db, row.capture_id, userId))
    .map(row => ({
      commentId: row.comment_id,
      captureId: row.capture_id,
      title: row.raw,
      body: row.body,
      createdAt: row.created_at,
      author: publicUser({ ...row, id: row.author_id }),
    }));
}
export function markMentionsSeen(db, captureId, userId) {
  db.prepare(`UPDATE comment_mentions SET seen_at=? WHERE user_id=? AND seen_at IS NULL AND comment_id IN (SELECT id FROM comments WHERE capture_id=?)`).run(now(), userId, captureId);
}
export function commentCounts(db, captureIds) {
  if (!captureIds.length) return new Map();
  const marks = captureIds.map(() => '?').join(',');
  return new Map(
    db.prepare(`SELECT capture_id, COUNT(*) AS n FROM comments WHERE deleted_at IS NULL AND capture_id IN (${marks}) GROUP BY capture_id`).all(...captureIds).map(row => [row.capture_id, row.n]),
  );
}

// ── участники записи ──

// Позванный в запись видит эту одну запись — не круг и не журнал автора.
// Строка не удаляется: «убрать» и «не следить» ставят removed_at, а новый
// призыв возвращает человека.
export function isParticipant(db, captureId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM capture_people WHERE capture_id=? AND user_id=? AND removed_at IS NULL').get(captureId, userId));
}
export function captureParticipants(db, captureId) {
  return db
    .prepare(`SELECT p.added_at, p.added_by, u.* FROM capture_people p JOIN users u ON u.id=p.user_id
      WHERE p.capture_id=? AND p.removed_at IS NULL ORDER BY p.added_at`)
    .all(captureId)
    .map(row => ({ ...publicUser(row), addedAt: row.added_at, addedBy: row.added_by }));
}
function addParticipant(db, captureId, userId, addedBy, at = now()) {
  db.prepare(`INSERT INTO capture_people(capture_id,user_id,added_by,added_at) VALUES(?,?,?,?)
    ON CONFLICT(capture_id,user_id) DO UPDATE SET added_by=excluded.added_by, added_at=excluded.added_at, removed_at=NULL`).run(captureId, userId, addedBy, at);
}
// Убрать может автор записи; сам себя — любой позванный («не следить»).
export function removeParticipant(db, captureId, actorId, personId) {
  const capture = db.prepare('SELECT user_id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
  if (!capture) return { error: 'not_found' };
  if (capture.user_id !== actorId && actorId !== personId) return { error: 'not_owner' };
  const result = db.prepare('UPDATE capture_people SET removed_at=? WHERE capture_id=? AND user_id=? AND removed_at IS NULL').run(now(), captureId, personId);
  if (!result.changes) return { error: 'not_found' };
  return { participants: captureParticipants(db, captureId) };
}
// «Обсуждения»: записи, где идёт разговор с людьми, — куда позвали меня, где я
// позвал других, и записи моих кругов, в которых уже что-то написано. Свежие
// сверху; точка — непрочитанный призыв.
export function discussions(db, userId) {
  const rows = db
    .prepare(`SELECT c.id, c.raw, c.user_id FROM captures c WHERE c.deleted_at IS NULL AND (
        c.id IN (SELECT capture_id FROM capture_people WHERE user_id=? AND removed_at IS NULL)
        OR (c.user_id=? AND c.id IN (SELECT capture_id FROM capture_people WHERE removed_at IS NULL))
        OR (c.id IN (SELECT cc.capture_id FROM capture_circles cc JOIN circle_members m ON m.circle_id=cc.circle_id
              WHERE m.user_id=? AND m.left_at IS NULL AND cc.removed_at IS NULL)
            AND c.id IN (SELECT capture_id FROM comments WHERE deleted_at IS NULL)))`)
    .all(userId, userId, userId);
  const last = db.prepare(`SELECT m.body, m.created_at, u.* FROM comments m JOIN users u ON u.id=m.author_id
    WHERE m.capture_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1`);
  const unseen = db.prepare(`SELECT COUNT(*) AS n FROM comment_mentions cm JOIN comments m ON m.id=cm.comment_id
    WHERE cm.user_id=? AND cm.seen_at IS NULL AND m.capture_id=? AND m.deleted_at IS NULL`);
  const owners = db.prepare('SELECT * FROM users WHERE id=?');
  const readAt = db.prepare('SELECT last_read_at FROM comment_reads WHERE capture_id=? AND user_id=?');
  const fresh = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE capture_id=? AND deleted_at IS NULL AND author_id!=? AND created_at>?');
  return rows
    .map(row => {
      const message = last.get(row.id);
      return {
        captureId: row.id,
        title: titleOf(db, row.id, row.raw),
        kind: captureKind(db, row.id),
        due: dueOf(db, row.id),
        circle: circlesForCapture(db, row.id)[0] || null,
        mine: row.user_id === userId,
        author: row.user_id ? publicUser(owners.get(row.user_id)) : null,
        people: captureParticipants(db, row.id),
        count: commentCounts(db, [row.id]).get(row.id) || 0,
        last: message ? { body: message.body.slice(0, 160), at: message.created_at, author: publicUser(message) } : null,
        unread: unseen.get(userId, row.id).n > 0,
        unreadCount: fresh.get(row.id, userId, readAt.get(row.id, userId)?.last_read_at || '').n,
      };
    })
    .sort((left, right) => (right.last?.at || '').localeCompare(left.last?.at || ''))
    .slice(0, 100);
}

// ── полоса «к вам» ──

// Одна входящая полоса на всё: просьбы и призывы вперемешку, потому что для
// человека это одно и то же — кому-то от меня что-то нужно. Дела выключенных
// кругов в неё не попадают поштучно: они собираются одной свёрнутой строкой,
// и в этом разница между «спрятать» и «тихо потерять».
export function inbox(db, userId, extraRows = []) {
  const muted = mutedCircleIds(db, userId);
  const rows = [...extraRows.map(row => ({ ...row, muted: row.circle ? muted.has(row.circle.id) : false }))];
  for (const assignment of assignmentsTo(db, userId, ['pending'])) {
    const capture = db.prepare('SELECT raw FROM captures WHERE id=?').get(assignment.captureId);
    rows.push({
      kind: 'request',
      id: assignment.id,
      captureId: assignment.captureId,
      title: titleOf(db, assignment.captureId, capture?.raw),
      circle: assignment.circle,
      from: assignment.assigner,
      createdAt: assignment.createdAt,
      due: dueOf(db, assignment.captureId),
      muted: assignment.circle ? muted.has(assignment.circle.id) : false,
    });
  }
  for (const mention of unseenMentions(db, userId)) {
    const circle = circlesForCapture(db, mention.captureId)[0] || null;
    rows.push({
      kind: 'call',
      id: mention.commentId,
      captureId: mention.captureId,
      title: titleOf(db, mention.captureId, mention.title),
      body: mention.body,
      circle,
      from: mention.author,
      createdAt: mention.createdAt,
      muted: circle ? muted.has(circle.id) : false,
    });
  }
  rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const visible = rows.filter(row => !row.muted);
  const hidden = rows.filter(row => row.muted);
  const folded = [];
  for (const row of hidden) {
    const existing = folded.find(item => item.circle?.id === row.circle?.id);
    if (existing) { existing.count += 1; existing.lastAt = row.createdAt; existing.from = row.from; continue; }
    folded.push({ kind: 'muted', circle: row.circle, count: 1, lastAt: row.createdAt, from: row.from });
  }
  return { rows: visible, folded };
}
// Тип записи словом, которым его рисует список разговоров.
const KIND_OF_TYPE = { task: 'todo', meeting_event: 'meeting', outcome_decision: 'outcome', note: 'note', idea_question: 'idea' };
export function captureKind(db, captureId) {
  const row = db.prepare("SELECT i.classification_json FROM interpretations i WHERE i.capture_id=? AND i.status='active'").get(captureId);
  if (!row) return 'note';
  return KIND_OF_TYPE[JSON.parse(row.classification_json).primaryType] || 'note';
}
export const captureTitle = (db, captureId, fallback = '') => titleOf(db, captureId, fallback || db.prepare('SELECT raw FROM captures WHERE id=?').get(captureId)?.raw || '');
export const captureDue = (db, captureId) => dueOf(db, captureId);
function titleOf(db, captureId, fallback = '') {
  const row = db.prepare("SELECT i.classification_json FROM interpretations i WHERE i.capture_id=? AND i.status='active'").get(captureId);
  if (row) {
    const classification = JSON.parse(row.classification_json);
    if (classification.summary) return classification.summary;
  }
  return String(fallback || '').slice(0, 200);
}
const circleBrief = (db, circleId) => (circleId ? db.prepare('SELECT id, name, color FROM circles WHERE id=?').get(circleId) || null : null);
// Срок словами для строки уведомления и push: «до 19.09, 15:00». Дни недели и
// «завтра» дорисовывает браузер — он знает, какой сегодня день у человека.
function dueWords(due) {
  if (!due?.date) return null;
  return `до ${due.date.slice(8, 10)}.${due.date.slice(5, 7)}${due.time ? `, ${due.time}` : ''}`;
}
function dueOf(db, captureId) {
  const row = db.prepare("SELECT i.classification_json FROM interpretations i WHERE i.capture_id=? AND i.status='active'").get(captureId);
  if (!row) return null;
  const schedule = JSON.parse(row.classification_json).entities?.schedule;
  return schedule?.date ? { date: schedule.date, time: schedule.time || null } : null;
}

// Что приложение говорит о круге в хвосте дня, когда круг выключен.
export function mutedSummary(db, userId) {
  const muted = [...mutedCircleIds(db, userId)];
  if (!muted.length) return [];
  const marks = muted.map(() => '?').join(',');
  return db
    .prepare(`SELECT c.id, c.name, c.color,
        (SELECT COUNT(*) FROM assignments a WHERE a.circle_id=c.id AND a.assignee_id=? AND a.cancelled_at IS NULL AND a.state IN ('pending','accepted')) AS deeds
      FROM circles c WHERE c.id IN (${marks}) AND c.deleted_at IS NULL`)
    .all(userId, ...muted)
    .map(row => ({ id: row.id, name: row.name, color: row.color, deeds: row.deeds }));
}

/** Люди из всех ваших кругов — для подсказки «@» там, где круг ещё не выбран. */
export function peopleAround(db, userId) {
  const seen = new Map();
  for (const circleId of circleIdsOf(db, userId)) {
    const circle = circleBrief(db, circleId);
    for (const person of membersOf(db, circleId)) {
      if (person.id === userId) continue;
      const known = seen.get(person.id);
      if (known) { if (circle?.name) known.circles.push(circle.name); continue; }
      // membersOf уже отдаёт человека наружу — заворачивать второй раз нельзя:
      // publicUser пересобрал бы имя из почты.
      seen.set(person.id, { id: person.id, name: person.name, email: person.email, avatar: person.avatar ?? null, circles: circle?.name ? [circle.name] : [] });
    }
  }
  return [...seen.values()];
}

/**
 * Призыв прямо в записи: «@Аня — прислать смету» значит, что Аня эту запись
 * видит и знает о ней. Тому, кому запись и так досталась делом, второй раз не
 * звоним: просьба уже пришла своей строкой.
 */
export function callFromText(db, { captureId, authorId, raw = '', assigneeId = null, at = now() }) {
  const people = peopleAround(db, authorId);
  if (!people.length) return [];
  const targets = new Map();
  for (const name of String(raw).match(/@[\p{L}\p{N}_.-]{2,40}/gu) || []) {
    const target = people.find(person => sameName(name.slice(1), person.name) || normalizeName(name.slice(1)) === normalizeName(person.email));
    if (target && target.id !== assigneeId) targets.set(target.id, target);
  }
  if (!targets.size) return [];
  const title = titleOf(db, captureId, 'запись');
  const circle = circlesForCapture(db, captureId)[0] || null;
  const called = [];
  for (const person of targets.values()) {
    addParticipant(db, captureId, person.id, authorId, at);
    notify(db, { userId: person.id, kind: 'call', actorId: authorId, captureId, circleId: circle?.id || null, text: `зовёт вас в записи «${title}»`, data: { circle }, at });
    called.push(person);
  }
  return called;
}

// Дело уходит человеку тем же одним полем. Приложение не изобретает намерение:
// исполнителем становится тот участник круга, которого назвал сам разбор, и
// только если он один — угадывать, кому досталось дело, нельзя.
export function autoAssign(db, { captureId, userId, classification, raw = '' }) {
  if (!classification || classification.primaryType !== 'task') return null;
  // «Сделал X» и любая личная запись человеку не уходит: поручение — только явное.
  if (classification.completed === true) return null;
  const lead = addresseeOf(raw);
  if (!lead) return null;
  if (db.prepare('SELECT 1 FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(captureId)) return null;
  const match = matchAssignee(db, userId, [lead]);
  if (!match) return null;
  return assign(db, { captureId, assigneeId: match.id, assignerId: userId, circleId: match.circleId }).assignment || null;
}

// Явное обращение в начале записи: «Ане — …», «Ане: …», «Лёше — поднять стенд».
// Одно слово с большой буквы и тире (с пробелами) или двоеточие. Остальное — не просьба.
export function addresseeOf(raw) {
  const match = /^\s*@?(\p{Lu}[\p{L}-]{1,29})\s*(?::|[—–]|\s-)\s*\S/u.exec(String(raw || ''));
  return match ? match[1] : null;
}

// Взятые дела — ссылки, а не копии: запись живёт у автора, а в чужом дне стоит
// строка со ссылкой на неё. Поэтому «взял» ничего не переписывает в журналах и
// «вернул» ничего оттуда не стирает.
export function acceptedFor(db, userId) {
  return db
    .prepare(`SELECT a.id AS assignment_id, a.capture_id FROM assignments a JOIN captures c ON c.id=a.capture_id
      WHERE a.assignee_id=? AND a.state IN ('accepted','done') AND a.cancelled_at IS NULL AND c.deleted_at IS NULL ORDER BY a.responded_at`)
    .all(userId);
}
// Может ли человек закрыть чекбокс: своё — всегда, чужое — только то, что взял.
export function canCompleteCapture(db, captureId, userId) {
  const capture = db.prepare('SELECT user_id FROM captures WHERE id=?').get(captureId);
  if (!capture) return false;
  if (capture.user_id === userId) return true;
  const row = db.prepare("SELECT 1 FROM assignments WHERE capture_id=? AND assignee_id=? AND state IN ('accepted','done') AND cancelled_at IS NULL").get(captureId, userId);
  return Boolean(row);
}

// Распустить круг может хозяин: круг, который больше не нужен, иначе остаётся
// висеть у всех навсегда. Записи при этом не трогаются — они и так живут у
// авторов, — но из круга уходят, а неотвеченные просьбы снимаются: просить
// больше некому.
export function dissolveCircle(db, circleId, userId) {
  const member = membership(db, circleId, userId);
  if (!member) return { error: 'not_found' };
  if (member.role !== 'owner') return { error: 'not_owner' };
  const at = now();
  db.prepare("UPDATE assignments SET cancelled_at=? WHERE circle_id=? AND cancelled_at IS NULL AND state IN ('pending','accepted')").run(at, circleId);
  db.prepare('UPDATE capture_circles SET removed_at=? WHERE circle_id=? AND removed_at IS NULL').run(at, circleId);
  db.prepare('UPDATE circle_members SET left_at=? WHERE circle_id=? AND left_at IS NULL').run(at, circleId);
  db.prepare('UPDATE circles SET deleted_at=?, photo=NULL WHERE id=?').run(at, circleId);
  // Фото распущенного круга больше некому показать — байты уходят вместе с ним.
  db.prepare('DELETE FROM circle_photos WHERE circle_id=?').run(circleId);
  return { dissolved: true };
}
