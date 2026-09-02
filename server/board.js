// Доска: канбан по открытым делам — задачам и встречам, не закрытым чекбоксом.
// Колонки заводит человек (как разделы в Todoist); дело без колонки живёт во
// «Входящих». Раскладка — отдельная таблица поверх записей: сама запись ничего
// о доске не знает, удаление колонки не трогает дела, а закрытое дело просто
// уходит с доски (и возвращается на своё место, если его вернуть в работу).
import crypto from 'node:crypto';
import { dateInZone } from './reports.js';

const now = () => new Date().toISOString();
export const COLUMN_NAME_LIMIT = 40;
export const COLUMNS_LIMIT = 12;

function completionEvents(db) {
  const map = new Map();
  for (const row of db.prepare("SELECT projection_id, event_type, occurred_at FROM ledger_events WHERE projection_id IS NOT NULL AND event_type IN ('completed','completion_undone') ORDER BY rowid").iterate())
    map.set(row.projection_id, { type: row.event_type, at: row.occurred_at });
  return map;
}

// Открытые дела пользователя: есть активная завершаемая проекция, и не все они
// закрыты. Отчётная работа (completed в классификации) — не дело, а дневник.
// По просьбе (includeClosed) закрытые дела тоже отдаются — с пометкой closed:
// так «показать выполненные» видит их на своих местах.
function openCards(db, userId, includeClosed = false) {
  const rows = db.prepare(`SELECT c.id, c.created_at, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.deleted_at IS NULL AND c.user_id IS ? ORDER BY c.created_at`).all(userId);
  const projections = db.prepare(`SELECT p.id, p.capture_id, p.projection_type FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.status='active' AND c.deleted_at IS NULL AND c.user_id IS ? AND p.projection_type IN ('task','meeting_event')`).all(userId);
  const completion = completionEvents(db);
  const byCapture = new Map();
  for (const projection of projections) {
    if (!byCapture.has(projection.capture_id)) byCapture.set(projection.capture_id, []);
    byCapture.get(projection.capture_id).push(projection);
  }
  const cards = [];
  for (const row of rows) {
    const completable = byCapture.get(row.id) || [];
    if (!completable.length) continue;
    const closed = completable.every(projection => completion.get(projection.id)?.type === 'completed');
    if (closed && !includeClosed) continue;
    const classification = JSON.parse(row.classification_json);
    if (classification.completed === true) continue;
    const schedule = classification.entities?.schedule || null;
    cards.push({
      captureId: row.id,
      createdAt: row.created_at,
      closed,
      closedAt: closed ? completable.map(projection => completion.get(projection.id).at).sort().at(-1) : null,
      title: classification.summary || '',
      type: classification.primaryType,
      due: schedule?.date ? { date: schedule.date, time: schedule.time || null } : null,
      priority: classification.priority || null,
      tags: classification.tags || [],
      projects: classification.entities?.projects || [],
      projectionIds: completable.map(projection => projection.id),
    });
  }
  return cards;
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

export function boardView(db, { userId, timeZone = 'Europe/Samara', now: at = new Date(), includeClosed = false } = {}) {
  const today = dateInZone(at, timeZone);
  const columns = db.prepare('SELECT id, name, position FROM board_columns WHERE user_id IS ? ORDER BY position, created_at').all(userId);
  const placements = new Map(db.prepare('SELECT capture_id, column_id, position FROM board_placements WHERE user_id IS ?').all(userId).map(row => [row.capture_id, row]));
  const known = new Set(columns.map(column => column.id));
  const buckets = new Map([[null, []], ...columns.map(column => [column.id, []])]);
  for (const card of openCards(db, userId, includeClosed)) {
    const placement = placements.get(card.captureId);
    const columnId = placement && placement.column_id !== null && known.has(placement.column_id) ? placement.column_id : null;
    const placed = Boolean(placement && (placement.column_id === null || known.has(placement.column_id)));
    buckets.get(columnId).push({ card, placed, position: placement?.position ?? 0 });
  }
  return {
    today,
    columns: [
      { id: null, name: 'Входящие', cards: sortBucket(buckets.get(null), today) },
      ...columns.map(column => ({ id: column.id, name: column.name, cards: sortBucket(buckets.get(column.id), today) })),
    ],
  };
}

function validName(value) { const name = typeof value === 'string' ? value.trim() : ''; return name && name.length <= COLUMN_NAME_LIMIT ? name : null; }
function ownColumn(db, userId, id) { const column = db.prepare('SELECT id FROM board_columns WHERE id=? AND user_id IS ?').get(id, userId); return Boolean(column); }

export function createColumn(db, { userId, name }) {
  const trimmed = validName(name);
  if (!trimmed) return { error: 'invalid_name' };
  const count = db.prepare('SELECT COUNT(*) n FROM board_columns WHERE user_id IS ?').get(userId).n;
  if (count >= COLUMNS_LIMIT) return { error: 'columns_limit' };
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) p FROM board_columns WHERE user_id IS ?').get(userId).p) + 1;
  const column = { id: crypto.randomUUID(), name: trimmed, position };
  db.prepare('INSERT INTO board_columns(id, user_id, name, position, created_at) VALUES(?,?,?,?,?)').run(column.id, userId, trimmed, position, now());
  return { column };
}

export function renameColumn(db, { userId, id, name }) {
  const trimmed = validName(name);
  if (!trimmed) return { error: 'invalid_name' };
  if (!ownColumn(db, userId, id)) return { error: 'column_not_found' };
  db.prepare('UPDATE board_columns SET name=? WHERE id=?').run(trimmed, id);
  return { column: db.prepare('SELECT id, name, position FROM board_columns WHERE id=?').get(id) };
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
  // Дела не пропадают: раскладка колонки переезжает в конец «Входящих»,
  // сохраняя свой порядок.
  const base = (db.prepare('SELECT COALESCE(MAX(position), -1) p FROM board_placements WHERE user_id IS ? AND column_id IS NULL').get(userId).p) + 1;
  const moved = db.prepare('SELECT capture_id FROM board_placements WHERE user_id IS ? AND column_id=? ORDER BY position').all(userId, id);
  const update = db.prepare('UPDATE board_placements SET column_id=NULL, position=?, updated_at=? WHERE capture_id=?');
  const apply = db.transaction(() => {
    moved.forEach((row, offset) => update.run(base + offset, now(), row.capture_id));
    db.prepare('DELETE FROM board_columns WHERE id=?').run(id);
  });
  apply();
  return { movedToInbox: moved.length };
}

export function moveCard(db, { userId, captureId, columnId = null, index }) {
  if (!Number.isInteger(index) || index < 0) return { error: 'invalid_index' };
  if (columnId !== null && !ownColumn(db, userId, columnId)) return { error: 'column_not_found' };
  const view = boardView(db, { userId });
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
