// Доска: канбан по открытым делам — задачам и встречам, не закрытым чекбоксом.
// Колонки заводит человек (как разделы в Todoist); дело без колонки живёт в
// первой колонке — «Входящих» больше нет. Раскладка — отдельная таблица поверх записей: сама запись ничего
// о доске не знает, удаление колонки не трогает дела, а закрытое дело просто
// уходит с доски (и возвращается на своё место, если его вернуть в работу).
import crypto from 'node:crypto';
import { dateInZone } from './reports.js';
import { describeRepeat, effectiveDate } from './repeat.js';
import { withSubtaskCounts } from './subtasks.js';

const now = () => new Date().toISOString();
export const COLUMN_NAME_LIMIT = 40;
export const COLUMNS_LIMIT = 12;
// Цвета подписи колонки — палитра оформления текста, та же, что у маркера
// и цвета в заметках: одна гамма на всё приложение.
export const COLUMN_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

// Откуда дело пришло, как его различает доска: «telegram» (и пересланное),
// «notes» (дело из строки заметки), всё остальное — «field», поле записи.
export const originGroup = origin => origin === 'telegram' || origin === 'telegram_forward' ? 'telegram' : origin === 'notes' ? 'notes' : 'field';

export function completionEvents(db) {
  const map = new Map();
  for (const row of db.prepare("SELECT projection_id, event_type, occurred_at FROM ledger_events WHERE projection_id IS NOT NULL AND event_type IN ('completed','completion_undone') ORDER BY rowid").iterate())
    map.set(row.projection_id, { type: row.event_type, at: row.occurred_at });
  return map;
}

// Сколько закрытых дел отдаёт доска: список показывает их хвостом, чтобы
// закрытое можно было найти и вернуть в работу, а не всю историю целиком.
export const CLOSED_LIMIT = 50;

// Дела пользователя: записи с активной завершаемой проекцией. Открытые — не все
// проекции закрыты; закрытые — все закрыты чекбоксом (в том числе сразу при
// записи: «сделал X» — это туду, закрытая с рождения). Старые отчёты о сделанном
// без завершаемой проекции — дневник, их нет ни там, ни там.
// Взятое чужое дело живёт на доске рядом со своими: человек взял его на себя,
// и спрашивать «чьё оно» каждый раз, глядя на список, незачем. Сама запись
// при этом остаётся у автора — сюда приходит только её идентификатор.
// Подзадачи своей карточки не имеют: они сидят у родителя счётчиком «0/2» и
// открываются в его карточке. Исключение — подзадача, отданная другому человеку
// и им взятая: у него родителя нет, и она для него обычное дело.
function deedCards(db, userId, timeZone, now = new Date(), borrowed = [], { withSubtasks = true } = {}) {
  const mine = borrowed.length ? `(c.user_id IS ? OR c.id IN (${borrowed.map(() => '?').join(',')}))` : 'c.user_id IS ?';
  const who = [userId, ...borrowed];
  const rows = db.prepare(`SELECT c.id, c.created_at, c.parent_capture_id, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.deleted_at IS NULL AND ${mine} AND (c.subtask=0 OR c.user_id IS NOT ?) ORDER BY c.created_at`).all(...who, userId);
  const projections = db.prepare(`SELECT p.id, p.capture_id, p.projection_type FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.status='active' AND c.deleted_at IS NULL AND ${mine} AND p.projection_type IN ('task','meeting_event')`).all(...who);
  const completion = completionEvents(db);
  // Скрепка на карточке: сколько живых вложений у записи.
  const attachments = new Map(db.prepare(`SELECT a.capture_id, COUNT(*) n FROM capture_attachments a JOIN captures c ON c.id=a.capture_id WHERE a.deleted_at IS NULL AND ${mine} GROUP BY a.capture_id`).all(...who).map(row => [row.capture_id, row.n]));
  // Откуда пришло дело: источник называет первая задача разбора записи. У дела,
  // отделённого от пачки, своей задачи нет — оно из того же места, что и
  // запись-родитель (пересланная пачка из Telegram даёт дела «из Telegram»).
  const origins = new Map();
  for (const job of db.prepare(`SELECT j.capture_id, j.origin FROM capture_jobs j JOIN captures c ON c.id=j.capture_id WHERE ${mine} ORDER BY j.created_at`).all(...who))
    if (!origins.has(job.capture_id)) origins.set(job.capture_id, job.origin);
  const originOfCapture = row => originGroup(origins.has(row.id) ? origins.get(row.id) : origins.get(row.parent_capture_id));
  const byCapture = new Map();
  for (const projection of projections) {
    if (!byCapture.has(projection.capture_id)) byCapture.set(projection.capture_id, []);
    byCapture.get(projection.capture_id).push(projection);
  }
  const open = [], closed = [];
  for (const row of rows) {
    const completable = byCapture.get(row.id) || [];
    if (!completable.length) continue;
    const classification = JSON.parse(row.classification_json);
    const events = completable.map(projection => completion.get(projection.id));
    const isClosed = events.every(event => event?.type === 'completed');
    const closedAt = isClosed ? events.map(event => event.at).sort().at(-1) : null;
    const schedule = classification.entities?.schedule || null;
    (isClosed ? closed : open).push({
      captureId: row.id,
      ...(isClosed ? { closedAt, closedDate: dateInZone(new Date(closedAt), timeZone) } : {}),
      createdAt: row.created_at,
      title: classification.summary || '',
      type: classification.primaryType,
      // У повтора срок — ближайший экземпляр от сегодняшнего дня.
      due: schedule?.date ? { date: schedule.repeat ? effectiveDate(schedule, dateInZone(now, timeZone)) || schedule.date : schedule.date, time: schedule.time || null, ...(schedule.repeat ? { repeat: describeRepeat(schedule.repeat) } : {}) } : null,
      priority: classification.priority || null,
      tags: classification.tags || [],
      projects: classification.entities?.projects || [],
      // Люди из разбора: на карточке — строкой с инициалами, как в Notion.
      people: classification.entities?.people || [],
      attachments: attachments.get(row.id) || 0,
      origin: originOfCapture(row),
      projectionIds: completable.map(projection => projection.id),
    });
  }
  closed.sort((left, right) => right.closedAt.localeCompare(left.closedAt));
  const shownClosed = closed.slice(0, CLOSED_LIMIT);
  // «0/2» у родителя: считает сервер, а не доска по спрятанным карточкам. Вместе
  // с числом идут строки карты подзадач (items, до шести): доска рисует их под
  // названием, и второго запроса за ними нет.
  if (withSubtasks) withSubtaskCounts(db, [...open, ...shownClosed], userId, { today: dateInZone(now, timeZone), key: 'captureId', withItems: true });
  return { open, closed: shownClosed };
}

// Порядок по умолчанию (пока карточку не разложили руками) — как в TODO-буфере:
// просроченное, сегодняшнее, без срока, дальше по дате.
function defaultRank(card, today) {
  const date = card.due?.date || null;
  if (date && date < today) return 0;
  if (date === today) return 1;
  if (!date) return 2;
  return 3;
}
function sortBucket(bucket, today) {
  bucket.sort((left, right) => {
    if (left.placed !== right.placed) return left.placed ? -1 : 1;
    if (left.placed) return left.position - right.position;
    const rank = defaultRank(left.card, today) - defaultRank(right.card, today);
    if (rank) return rank;
    const byDate = (left.card.due?.date || '').localeCompare(right.card.due?.date || '');
    if (byDate) return byDate;
    return left.card.createdAt.localeCompare(right.card.createdAt);
  });
  return bucket.map(item => item.card);
}

export const DEFAULT_COLUMN = 'Дела';
// У человека всегда есть хотя бы одна колонка: новое падает в первую. Заводим
// лениво, один раз — на первом обращении к доске или при удалении последней.
function ensureColumn(db, userId) {
  const first = db.prepare('SELECT id, name, position, color FROM board_columns WHERE user_id IS ? ORDER BY position, created_at LIMIT 1').get(userId);
  if (first) return first;
  const column = { id: crypto.randomUUID(), name: DEFAULT_COLUMN, position: 0, color: null };
  db.prepare('INSERT INTO board_columns(id, user_id, name, position, created_at) VALUES(?,?,?,?,?)').run(column.id, userId, column.name, column.position, now());
  return column;
}

export function boardView(db, { userId, timeZone = 'Europe/Samara', now: at = new Date(), borrowed = [], withSubtasks = true } = {}) {
  const today = dateInZone(at, timeZone);
  ensureColumn(db, userId);
  const columns = db.prepare('SELECT id, name, position, color FROM board_columns WHERE user_id IS ? ORDER BY position, created_at').all(userId);
  const placements = new Map(db.prepare('SELECT capture_id, column_id, position FROM board_placements WHERE user_id IS ?').all(userId).map(row => [row.capture_id, row]));
  const known = new Set(columns.map(column => column.id));
  const firstId = columns[0].id;
  const buckets = new Map(columns.map(column => [column.id, []]));
  const { open, closed } = deedCards(db, userId, timeZone, at, borrowed, { withSubtasks });
  for (const card of open) {
    const placement = placements.get(card.captureId);
    // Без размещения, с потерянной колонкой и со старым «Входящие» (column_id
    // NULL) карточка лежит в первой колонке; порядок внутри — по умолчанию.
    const inKnown = Boolean(placement && placement.column_id !== null && known.has(placement.column_id));
    buckets.get(inKnown ? placement.column_id : firstId).push({ card, placed: inKnown, position: placement?.position ?? 0 });
  }
  return {
    today,
    columns: columns.map(column => ({ id: column.id, name: column.name, color: column.color || null, cards: sortBucket(buckets.get(column.id), today) })),
    // Закрытое дело лежит в своей колонке и вернётся в неё, если его вернуть в работу.
    closed: closed.map(card => {
      const placement = placements.get(card.captureId);
      return { ...card, columnId: placement && placement.column_id !== null && known.has(placement.column_id) ? placement.column_id : firstId };
    }),
  };
}

function validName(value) { const name = typeof value === 'string' ? value.trim() : ''; return name && name.length <= COLUMN_NAME_LIMIT ? name : null; }
function ownColumn(db, userId, id) { const column = db.prepare('SELECT id FROM board_columns WHERE id=? AND user_id IS ?').get(id, userId); return Boolean(column); }

export function createColumn(db, { userId, name }) {
  const trimmed = validName(name);
  if (!trimmed) return { error: 'invalid_name' };
  // Первая колонка всегда «Дела»: своя встаёт после неё, а не вместо неё.
  ensureColumn(db, userId);
  const count = db.prepare('SELECT COUNT(*) n FROM board_columns WHERE user_id IS ?').get(userId).n;
  if (count >= COLUMNS_LIMIT) return { error: 'columns_limit' };
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) p FROM board_columns WHERE user_id IS ?').get(userId).p) + 1;
  const column = { id: crypto.randomUUID(), name: trimmed, position, color: null };
  db.prepare('INSERT INTO board_columns(id, user_id, name, position, created_at) VALUES(?,?,?,?,?)').run(column.id, userId, trimmed, position, now());
  return { column };
}

export function colorColumn(db, { userId, id, color }) {
  if (color !== null && !COLUMN_COLORS.includes(color)) return { error: 'invalid_color' };
  if (!ownColumn(db, userId, id)) return { error: 'column_not_found' };
  db.prepare('UPDATE board_columns SET color=? WHERE id=?').run(color, id);
  return { column: db.prepare('SELECT id, name, position, color FROM board_columns WHERE id=?').get(id) };
}

export function renameColumn(db, { userId, id, name }) {
  const trimmed = validName(name);
  if (!trimmed) return { error: 'invalid_name' };
  if (!ownColumn(db, userId, id)) return { error: 'column_not_found' };
  db.prepare('UPDATE board_columns SET name=? WHERE id=?').run(trimmed, id);
  return { column: db.prepare('SELECT id, name, position, color FROM board_columns WHERE id=?').get(id) };
}

export function moveColumn(db, { userId, id, index }) {
  if (!Number.isInteger(index) || index < 0) return { error: 'invalid_index' };
  if (!ownColumn(db, userId, id)) return { error: 'column_not_found' };
  const order = db.prepare('SELECT id FROM board_columns WHERE user_id IS ? ORDER BY position, created_at').all(userId).map(row => row.id).filter(existing => existing !== id);
  order.splice(Math.min(index, order.length), 0, id);
  const update = db.prepare('UPDATE board_columns SET position=? WHERE id=?');
  const apply = db.transaction(() => { order.forEach((columnId, position) => update.run(position, columnId)); });
  apply();
  return { order };
}

export function deleteColumn(db, { userId, id }) {
  if (!ownColumn(db, userId, id)) return { error: 'column_not_found' };
  // Дела не пропадают: раскладка колонки переезжает в конец первой из
  // оставшихся колонок, сохраняя свой порядок. Удаляют последнюю — сначала
  // заводится «Дела», и дела уходят в неё.
  const apply = db.transaction(() => {
    let target = db.prepare('SELECT id FROM board_columns WHERE user_id IS ? AND id != ? ORDER BY position, created_at LIMIT 1').get(userId, id);
    if (!target) target = ensureColumnAfter(db, userId);
    const base = (db.prepare('SELECT COALESCE(MAX(position), -1) p FROM board_placements WHERE user_id IS ? AND column_id IS ?').get(userId, target.id).p) + 1;
    const moved = db.prepare('SELECT capture_id FROM board_placements WHERE user_id IS ? AND column_id=? ORDER BY position').all(userId, id);
    const update = db.prepare('UPDATE board_placements SET column_id=?, position=?, updated_at=? WHERE capture_id=?');
    moved.forEach((row, offset) => update.run(target.id, base + offset, now(), row.capture_id));
    db.prepare('DELETE FROM board_columns WHERE id=?').run(id);
    return moved.length;
  });
  const moved = apply();
  return { moved, movedToInbox: moved };
}
// Последняя колонка удаляется: новая «Дела» встаёт на её место до удаления.
function ensureColumnAfter(db, userId) {
  const column = { id: crypto.randomUUID(), name: DEFAULT_COLUMN, position: 0, color: null };
  db.prepare('INSERT INTO board_columns(id, user_id, name, position, created_at) VALUES(?,?,?,?,?)').run(column.id, userId, column.name, column.position, now());
  return column;
}

export function moveCard(db, { userId, captureId, columnId = null, index }) {
  if (!Number.isInteger(index) || index < 0) return { error: 'invalid_index' };
  // Колонки «Входящие» нет: у карточки всегда есть настоящая колонка.
  if (columnId === null || columnId === undefined) return { error: 'invalid_column_id' };
  if (!ownColumn(db, userId, columnId)) return { error: 'column_not_found' };
  const view = boardView(db, { userId, withSubtasks: false });
  const hasCard = view.columns.some(column => column.cards.some(card => card.captureId === captureId));
  if (!hasCard) return { error: 'card_not_found' };
  // Порядок целевой колонки перезаписывается целиком: позиции всегда плотные,
  // и дыр от прежних раскладок не остаётся.
  const target = view.columns.find(column => column.id === columnId);
  const order = target.cards.map(card => card.captureId).filter(existing => existing !== captureId);
  order.splice(Math.min(index, order.length), 0, captureId);
  const upsert = db.prepare(`INSERT INTO board_placements(capture_id, user_id, column_id, position, updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(capture_id) DO UPDATE SET column_id=excluded.column_id, position=excluded.position, updated_at=excluded.updated_at`);
  const apply = db.transaction(() => { order.forEach((id, position) => upsert.run(id, userId, columnId, position, now())); });
  apply();
  return { columnId, order };
}
