// Подзадачи — дочерние записи-дела, связанные с родителем через
// parent_capture_id: те же строки, что отделённые намерения и дела из строк
// заметки. Карточке нужно всё дерево целиком с прогрессом, поэтому оно
// собирается здесь, а не через постраничный /api/entries, который срезал бы
// хвост на сотне записей.
//
// Метрика: считаются только конечные дела — у которых нет своих видимых дел.
// Ветка с детьми — не единица счёта, её состояние складывается из листьев.
// Итоги (outcome_decision), заметки и идеи в дерево не входят: это не шаги.
// Каждая запись проверяется на доступ: чужая ветка исчезает целиком, без
// идентификаторов, заголовков и счёта.
//
// Обход и подсчёт — без рекурсии и без потолка глубины: от циклов защищает
// список уже увиденных записей, а дерево любой глубины уходит клиенту плоским
// списком — вложенный JSON на сотнях уровней ломал бы разбор.
//
// Два разных «ребёнка». Карточка собирает в «Подзадачи» всех детей записи —
// и настоящие подзадачи (captures.subtask=1, их заводит «＋ Подзадача»), и дела,
// отделённые от пачки. Но только подзадачи уходят из списков и с доски и стоят
// у родителя счётчиком «0/2» (на доске их можно вернуть отдельными карточками —
// см. board.js): отделённое дело самостоятельное, ему место в «Дне».
// Счётчик для списков — subtaskCounts, он идёт тем же обходом и той же метрикой,
// что дуга в карточке, поэтому числа совпадают.
import { canSeeCapture, canCompleteCapture } from './circles.js';
import { occursOn, nextOccurrence, validIsoDate } from './repeat.js';

const ACTIONABLE = new Set(['task', 'meeting_event']);

function parse(json, fallback) { try { return JSON.parse(json); } catch { return fallback; } }

// Все живые дети переданных родителей одним запросом: обход идёт по уровням,
// а не по одной записи, и дерево в сотню шагов стоит нескольких запросов.
// SQLite принимает до 999 параметров — родители режутся пачками.
function childrenOf(db, parentIds, { onlySubtasks = false } = {}) {
  const rows = [];
  for (let start = 0; start < parentIds.length; start += 500) {
    const slice = parentIds.slice(start, start + 500);
    rows.push(...db.prepare(`SELECT c.id, c.parent_capture_id AS parent_id, c.user_id, c.created_at, i.classification_json,
      (SELECT origin FROM capture_jobs j WHERE j.capture_id=c.id ORDER BY j.created_at LIMIT 1) AS origin
      FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
      WHERE c.parent_capture_id IN (${slice.map(() => '?').join(',')}) AND c.deleted_at IS NULL${onlySubtasks ? ' AND c.subtask=1' : ''} ORDER BY c.created_at, c.id`).all(...slice));
  }
  return rows;
}
function projectionsOf(db, captureId) {
  return db.prepare("SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event') ORDER BY created_at").all(captureId).map(row => row.id);
}
function projectionDone(db, projectionId) {
  const event = db.prepare("SELECT event_type FROM ledger_events WHERE projection_id=? AND event_type IN ('completed','completion_undone') ORDER BY rowid DESC LIMIT 1").get(projectionId);
  return event?.event_type === 'completed';
}
export function todayIn(timeZone, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
// Повторяющееся дело закрыто «на день», а не целиком: как и карточка, шаг
// считается сделанным, если показанный день серии убран из неё (skip).
// День — сегодняшний, если серия на него выпадает, иначе ближайший.
function occurrenceState(schedule, closed, today) {
  if (!schedule?.repeat || !schedule.date || closed) return { occurrence: null, occurrenceDone: false };
  const skip = Array.isArray(schedule.skip) ? schedule.skip : [];
  const occurrence = skip.includes(today) || occursOn(schedule, today) ? today : nextOccurrence({ ...schedule, skip: [] }, today);
  return { occurrence, occurrenceDone: Boolean(occurrence && skip.includes(occurrence)) };
}

// Обход от одного или нескольких корней сразу: список дел одним запросом на
// уровень, а не на запись. Узлы лежат по уровням сверху вниз; rootKids — прямые
// дети каждого корня в порядке обхода. onlySubtasks оставляет настоящие
// подзадачи (ветка идёт только по ним).
function collect(db, rootIds, userId, { today, onlySubtasks = false }) {
  const nodes = [];
  const byId = new Map();
  const visited = new Set(rootIds);
  let level = [...rootIds];
  while (level.length) {
    const next = [];
    for (const row of childrenOf(db, level, { onlySubtasks })) {
      // Цикл или повторная ссылка: запись уже в дереве — второй раз не входит.
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      const classification = parse(row.classification_json, null);
      if (!classification || !ACTIONABLE.has(classification.primaryType) || row.origin === 'outcome') continue;
      // Чужое не показываем и не считаем: ни идентификатора, ни числа шагов.
      if (row.user_id !== userId && !canSeeCapture(db, row.id, userId)) continue;
      const projectionIds = projectionsOf(db, row.id);
      if (!projectionIds.length) continue;
      const closed = classification.completed === true || projectionIds.every(id => projectionDone(db, id));
      const { occurrence, occurrenceDone } = occurrenceState(classification.entities?.schedule, closed, today);
      const node = {
        id: row.id,
        parentId: row.parent_id,
        title: classification.summary || '',
        done: closed || occurrenceDone,
        closed,
        occurrence,
        schedule: classification.entities?.schedule || null,
        mine: row.user_id === userId,
        // Отметить может автор или тот, кто взял дело; читатель круга — нет.
        canComplete: row.user_id === userId || canCompleteCapture(db, row.id, userId),
        projectionIds,
        childIds: [],
      };
      nodes.push(node);
      byId.set(row.id, node);
      next.push(row.id);
    }
    level = next;
  }
  const rootKids = new Map(rootIds.map(id => [id, []]));
  for (const node of nodes) (byId.get(node.parentId)?.childIds || rootKids.get(node.parentId)).push(node.id);
  return { nodes, byId, rootKids };
}

// Прогресс ветки — сумма её листьев; сам лист — одна единица. Узлы лежат по
// уровням сверху вниз, поэтому обратный проход считает детей раньше родителей.
// Возвращает {done, total} каждого корня.
function settle({ nodes, byId, rootKids }) {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (!node.childIds.length) { node.leafTotal = 1; node.leafDone = node.done ? 1 : 0; continue; }
    let done = 0, total = 0;
    for (const childId of node.childIds) { const child = byId.get(childId); done += child.leafDone; total += child.leafTotal; }
    node.leafDone = done;
    node.leafTotal = total;
  }
  const progress = new Map();
  for (const [rootId, childIds] of rootKids) {
    let done = 0, total = 0;
    for (const childId of childIds) { const child = byId.get(childId); done += child.leafDone; total += child.leafTotal; }
    progress.set(rootId, { done, total });
  }
  return progress;
}

export function subtaskTree(db, rootId, userId, { today = todayIn('UTC') } = {}) {
  const found = collect(db, [rootId], userId, { today });
  const { nodes, byId } = found;
  const rootChildren = found.rootKids.get(rootId);
  const { done, total } = settle(found).get(rootId);
  // «Дальше» — первый незакрытый лист в порядке дерева (обход в глубину без
  // рекурсии).
  let next = null;
  const stack = [...rootChildren].reverse();
  while (stack.length && !next) {
    const node = byId.get(stack.pop());
    if (!node.childIds.length) { if (!node.done) next = { id: node.id, title: node.title }; }
    else for (let index = node.childIds.length - 1; index >= 0; index--) stack.push(node.childIds[index]);
  }
  return { id: rootId, today, done, total, next, children: rootChildren, nodes };
}

// «0/2» у родителя в списках: сколько подзадач сделано из всех. Идёт для многих
// записей разом — доска и список не спрашивают дерево каждой карточки отдельно.
// Только настоящие подзадачи (captures.subtask=1) и та же метрика, что у дуги в
// карточке: считаются конечные шаги на всех уровнях. У записи без подзадач
// ключа нет.
export function subtaskCounts(db, rootIds, userId, { today = todayIn('UTC') } = {}) {
  const counts = new Map();
  const ids = [...new Set(rootIds)].filter(Boolean);
  if (!ids.length) return counts;
  const found = collect(db, ids, userId, { today, onlySubtasks: true });
  for (const [rootId, progress] of settle(found))
    if (progress.total) counts.set(rootId, progress);
  return counts;
}
// Проставляет счётчик записям и карточкам списков: у кого подзадачи есть —
// поле subtasks {done, total}. key — имя поля с идентификатором записи.
export function withSubtaskCounts(db, items, userId, { today, key = 'id' } = {}) {
  const counts = subtaskCounts(db, items.map(item => item[key]), userId, { today });
  for (const item of items) {
    const progress = counts.get(item[key]);
    if (progress) item.subtasks = { ...progress };
  }
  return items;
}

// Путь до записи снизу вверх — для строки «← родитель» и хлебных крошек в
// карточке подзадачи. Чужая или удалённая ступень обрывает путь, повтор — тоже.
export function ancestorsOf(db, captureId, userId) {
  const chain = [];
  const seen = new Set([captureId]);
  let current = captureId;
  for (;;) {
    const row = db.prepare("SELECT p.id, p.user_id, i.classification_json FROM captures c JOIN captures p ON p.id=c.parent_capture_id AND p.deleted_at IS NULL JOIN interpretations i ON i.capture_id=p.id AND i.status='active' WHERE c.id=?").get(current);
    if (!row || seen.has(row.id)) break;
    if (row.user_id !== userId && !canSeeCapture(db, row.id, userId)) break;
    seen.add(row.id);
    const classification = parse(row.classification_json, {});
    chain.unshift({ id: row.id, title: classification.summary || '', type: classification.primaryType || null });
    current = row.id;
  }
  return chain;
}

export const SUBTASK_TITLE_LIMIT = 500;
export const validDay = value => typeof value === 'string' && validIsoDate(value);
