// Заметки как страницы: дерево, ссылки, базы и дела из строк заметки.
//
// Страница — обычная запись с типом «заметка» или «идея». Своего у страницы
// три вещи (таблицы — в server/notes-schema.js):
//
// - место в дереве. Указано руками или прочитано из текста записи — лежит там;
//   не указано — под страницей своего проекта, а без проекта во «Входящих».
//   Страница проекта не хранится: это узел, который собирает заметки проекта.
// - ссылки [[…]]. Собираются при каждом сохранении заметки; внизу страницы
//   видно, кто на неё ссылается и кто упоминает её название без ссылки.
// - базы — сохранённые виды списка страниц: фильтр, сортировка, раскладка.
//
// Дела здесь не живут: дерево и базы показывают только заметки и идеи. Но
// строку «- [ ] …» можно отправить на «Доску» — появится обычное дело, чья
// исходная запись — эта строка, а связь назад — parent_capture_id, та же, что
// у дел, отделённых от отчёта о встрече. Строку и дело держит якорь блока
// «^task-xxxxxxxx» в конце строки: так же Obsidian ссылается на блок.
import crypto from 'node:crypto';
import { createLedger, saveNote, activeNote } from './db.js';

export const PAGE_TYPES = ['note', 'idea_question'];
export const PAGE_TITLE_LIMIT = 200;
export const BASE_NAME_LIMIT = 60;
export const BASES_LIMIT = 30;
const PAGES_LIMIT = 3000;
const LAYOUTS = ['table', 'gallery', 'list'];
const SORTS = ['created', 'updated', 'title'];
const TYPES = ['all', ...PAGE_TYPES];

const now = () => new Date().toISOString();
const lower = value => String(value ?? '').trim().toLocaleLowerCase('ru-RU');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[\w-]+$/.test(value);
export const deedAnchor = captureId => `task-${String(captureId).slice(0, 8)}`;
const ANCHOR = /(?:^|\s)\^(task-[0-9a-f]{8})(?=\s*$)/;
const TASK_LINE = /^(\s*[-*+]\s+\[)([ xX/-])(\]\s+)(.*)$/;

function parseJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

// Текст для списков и поиска: без маркеров разметки, якорей и скобок ссылок.
function plain(text) {
  return String(text || '')
    .replace(/\^task-[0-9a-f]{8}/g, '')
    .replace(/!?\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s?(?:\[![^\]]+\][+-]?\s*)?|[-*+]\s+\[[ xX/-]\]\s+|[-*+]\s+|\d{1,3}[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|==|\+\+|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── страницы пользователя ──────────────────────────────────────────────────
function pageRows(db, userId) {
  return db.prepare(`SELECT c.id, c.raw, c.created_at, i.classification_json, i.created_at AS interpreted_at,
      n.body AS note_body, n.version AS note_version, n.created_at AS noted_at,
      p.capture_id AS placed, p.parent_id AS place_parent, p.source AS place_source
    FROM captures c
    JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    LEFT JOIN capture_notes n ON n.capture_id=c.id AND n.status='active'
    LEFT JOIN note_places p ON p.capture_id=c.id
    WHERE c.deleted_at IS NULL AND c.user_id IS ?
      AND json_extract(i.classification_json,'$.primaryType') IN ('note','idea_question')
    ORDER BY c.created_at DESC LIMIT ${PAGES_LIMIT}`).all(userId);
}

function toPage(row) {
  const classification = parseJson(row.classification_json, {});
  const body = row.note_body ?? row.raw ?? '';
  const updatedAt = [row.created_at, row.interpreted_at, row.noted_at].filter(Boolean).sort().at(-1);
  return {
    id: row.id,
    title: String(classification.summary || plain(row.raw).slice(0, PAGE_TITLE_LIMIT) || 'Без названия'),
    type: classification.primaryType,
    project: classification.entities?.projects?.[0] || null,
    tags: Array.isArray(classification.tags) ? classification.tags.filter(tag => typeof tag === 'string') : [],
    createdAt: row.created_at,
    updatedAt,
    placed: Boolean(row.placed),
    placeParent: row.place_parent ?? null,
    placeSource: row.place_source ?? null,
    body,
    noteVersion: row.note_version ?? null,
  };
}

// Куда страница встаёт в дереве. Место, указанное руками, сильнее выводимого;
// но если родитель пропал (удалён или стал делом), страница не теряется, а
// возвращается туда, куда её положило бы правило.
function parentKeyOf(page, byId) {
  if (page.placed) {
    if (page.placeParent === null) return null;
    if (byId.has(page.placeParent) && page.placeParent !== page.id) return page.placeParent;
  }
  if (page.project) return `project:${page.project}`;
  return 'inbox';
}

// Все страницы человека с вычисленными местами. Цикл в дереве руками не
// собрать — сервер его не пропускает, — но на чтении он тоже гасится: страница
// из кольца встаёт в корень, а не исчезает.
export function loadPages(db, userId) {
  const pages = pageRows(db, userId).map(toPage);
  const byId = new Map(pages.map(page => [page.id, page]));
  for (const page of pages) page.parentKey = parentKeyOf(page, byId);
  for (const page of pages) {
    const seen = new Set([page.id]);
    let key = page.parentKey;
    while (key && byId.has(key)) {
      if (seen.has(key)) { page.parentKey = null; break; }
      seen.add(key);
      key = byId.get(key).parentKey;
    }
  }
  return { pages, byId };
}

function trailOf(page, byId) {
  const trail = [];
  const seen = new Set([page.id]);
  let key = page.parentKey;
  while (key) {
    if (key === 'inbox') { trail.unshift({ key, title: 'Входящие' }); break; }
    if (key.startsWith('project:')) { trail.unshift({ key, title: key.slice(8) }); break; }
    const parent = byId.get(key);
    if (!parent || seen.has(key)) break;
    seen.add(key);
    trail.unshift({ key, title: parent.title, type: parent.type });
    key = parent.parentKey;
  }
  return trail;
}

// ── подсказка места для «Входящих» ─────────────────────────────────────────
// Без модели: название страницы или проекта целиком встречается в тексте
// заметки. Слова сравниваются по началу (пять букв), чтобы «релиза» нашло
// «Релиз 1.4». Выбирается самое конкретное совпадение — больше слов.
const STOP_WORDS = new Set(['в', 'во', 'на', 'и', 'по', 'для', 'как', 'что', 'это', 'про', 'из', 'от', 'до', 'не', 'с', 'со', 'к', 'ко', 'о', 'об', 'у', 'за', 'же', 'ли', 'или', 'а', 'но', 'мы', 'я', 'он', 'она', 'они', 'его', 'её', 'их', 'мне', 'там', 'тут', 'все', 'всё', 'так', 'уже', 'ещё', 'еще', 'бы', 'то', 'да', 'нет', 'the', 'and']);
function stems(text) {
  const words = String(text || '').toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter(word => word.length >= 3 && !STOP_WORDS.has(word)).map(word => word.slice(0, 5)));
}
function suggestPlace(page, candidates) {
  const text = stems(`${page.title} ${page.body.slice(0, 4000)}`);
  let best = null;
  for (const candidate of candidates) {
    if (candidate.key === page.id) continue;
    const need = candidate.stems;
    if (!need.size || [...need].some(stem => !text.has(stem))) continue;
    const score = need.size + (candidate.key.startsWith('project:') ? 0 : 0.5);
    if (!best || score > best.score || (score === best.score && candidate.updatedAt > best.updatedAt)) best = { ...candidate, score };
  }
  return best ? { key: best.key, title: best.title } : null;
}
function placeCandidates(db, userId, pages) {
  const candidates = pages.filter(page => page.parentKey !== 'inbox')
    .map(page => ({ key: page.id, title: page.title, stems: stems(page.title), updatedAt: page.updatedAt }));
  for (const name of knownProjects(db, userId)) candidates.push({ key: `project:${name}`, title: name, stems: stems(name), updatedAt: '' });
  return candidates;
}
function knownProjects(db, userId) {
  const names = new Set();
  for (const row of db.prepare(`SELECT i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.deleted_at IS NULL AND c.user_id IS ? ORDER BY c.created_at DESC LIMIT ${PAGES_LIMIT}`).iterate(userId)) {
    for (const name of parseJson(row.classification_json, {})?.entities?.projects || []) if (typeof name === 'string' && name.trim()) names.add(name.trim());
  }
  return [...names];
}

// ── ссылки ─────────────────────────────────────────────────────────────────
const WIKI = /(!?)\[\[([^\]\n]+)\]\]/g;
function linkTargets(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    for (const match of line.matchAll(WIKI)) {
      const label = match[2].split('|')[0].split('#')[0].trim().slice(0, PAGE_TITLE_LIMIT);
      if (!label || out.has(lower(label))) continue;
      out.set(lower(label), { label, context: plain(line).slice(0, 240) });
    }
  }
  return [...out.values()];
}
function bodyOf(db, captureId) {
  const capture = db.prepare('SELECT id, raw, user_id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
  if (!capture) return null;
  const note = activeNote(db, captureId);
  return { capture, body: note ? note.body : capture.raw, note };
}
function pageByTitle(pages, title, exceptId = null) {
  const wanted = lower(title);
  return pages.filter(page => page.id !== exceptId && lower(page.title) === wanted)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
}

// Связи записи пересобираются целиком при каждом сохранении. Ссылка, которая
// уже вела на страницу, продолжает вести туда же, даже если страницу с тех пор
// переименовали: иначе переименование молча рвало бы все ссылки на неё.
export function indexLinks(db, captureId) {
  const found = bodyOf(db, captureId);
  if (!found) return [];
  // Без скобок в тексте пересобирать нечего — только убрать прежние связи.
  if (!found.body.includes('[[')) {
    db.prepare('DELETE FROM note_links WHERE from_id=?').run(captureId);
    return [];
  }
  const { pages, byId } = loadPages(db, found.capture.user_id);
  const previous = new Map(db.prepare('SELECT label, to_id FROM note_links WHERE from_id=?').all(captureId).map(row => [lower(row.label), row.to_id]));
  const links = linkTargets(found.body).map(({ label, context }) => {
    const kept = previous.get(lower(label));
    const target = kept && byId.has(kept) && kept !== captureId ? kept : pageByTitle(pages, label, captureId)?.id || null;
    return { label, context, toId: target };
  });
  db.transaction(() => {
    db.prepare('DELETE FROM note_links WHERE from_id=?').run(captureId);
    const insert = db.prepare('INSERT INTO note_links(from_id,label,to_id,context) VALUES(?,?,?,?)');
    for (const link of links) insert.run(captureId, link.label, link.toId, link.context);
  })();
  return links;
}

// Ссылки в записях, сделанных до появления страниц, собираются один раз: пока
// таблица связей пуста, а текст со скобками в журнале есть.
export function indexExistingLinks(db) {
  if (db.prepare('SELECT 1 FROM note_links LIMIT 1').get()) return 0;
  const rows = db.prepare(`SELECT c.id FROM captures c LEFT JOIN capture_notes n ON n.capture_id=c.id AND n.status='active'
    WHERE c.deleted_at IS NULL AND (instr(COALESCE(n.body, c.raw), '[[') > 0)`).all();
  for (const row of rows) indexLinks(db, row.id);
  return rows.length;
}

// Куда ведёт [[название]]: сначала туда, куда ссылка вела при сохранении этой
// записи, потом на страницу с таким названием.
export function resolveTitle(db, userId, title, fromId = null) {
  const { pages, byId } = loadPages(db, userId);
  if (fromId && validId(fromId)) {
    const kept = db.prepare('SELECT l.label, l.to_id FROM note_links l JOIN captures c ON c.id=l.from_id WHERE l.from_id=? AND c.user_id IS ?').all(fromId, userId)
      .find(row => lower(row.label) === lower(title));
    if (kept?.to_id && byId.has(kept.to_id)) return kept.to_id;
  }
  return pageByTitle(pages, title)?.id || null;
}

function backlinksOf(db, userId, page) {
  const rows = db.prepare(`SELECT l.from_id, l.label, l.to_id, l.context, i.classification_json, c.raw
    FROM note_links l JOIN captures c ON c.id=l.from_id AND c.deleted_at IS NULL AND c.user_id IS ?
    LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    WHERE (l.to_id=? OR l.to_id IS NULL) AND l.from_id<>?`).all(userId, page.id, page.id);
  const out = new Map();
  for (const row of rows) {
    if (row.to_id === null && lower(row.label) !== lower(page.title)) continue;
    if (out.has(row.from_id)) continue;
    const summary = parseJson(row.classification_json, {})?.summary;
    out.set(row.from_id, { id: row.from_id, title: summary || plain(row.raw).slice(0, 120), context: row.context });
  }
  return [...out.values()];
}

// Упоминания без ссылки: название страницы встречается в тексте, но не в
// скобках. Короткие названия не ищутся — «Hub» нашёлся бы в половине журнала.
function mentionsOf(db, userId, page, linked) {
  const title = page.title.trim();
  if (title.length < 4) return [];
  const needle = lower(title);
  const rows = db.prepare(`SELECT c.id, c.raw, n.body, i.classification_json FROM captures c
    LEFT JOIN capture_notes n ON n.capture_id=c.id AND n.status='active'
    LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    WHERE c.deleted_at IS NULL AND c.user_id IS ? AND c.id<>? ORDER BY c.created_at DESC LIMIT ${PAGES_LIMIT}`).all(userId, page.id);
  const out = [];
  for (const row of rows) {
    if (linked.has(row.id)) continue;
    const text = String(row.body ?? row.raw ?? '').replace(/!?\[\[[^\]\n]+\]\]/g, match => ' '.repeat(match.length));
    const at = text.toLocaleLowerCase('ru-RU').indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 70);
    const context = `${start ? '…' : ''}${plain(text.slice(start, at + title.length + 50))}…`;
    const summary = parseJson(row.classification_json, {})?.summary;
    out.push({ id: row.id, title: summary || plain(row.raw).slice(0, 120), context });
    if (out.length >= 20) break;
  }
  return out;
}

// Упоминание превращается в ссылку правкой той записи, где оно найдено:
// новая версия заметки, исходный текст записи не трогается.
export function linkMention(db, { userId, pageId, fromId }) {
  if (!validId(pageId) || !validId(fromId)) return { error: 'not_found' };
  const { byId } = loadPages(db, userId);
  const page = byId.get(pageId);
  const found = bodyOf(db, fromId);
  if (!page || !found || found.capture.user_id !== userId || fromId === pageId) return { error: 'not_found' };
  const masked = found.body.replace(/!?\[\[[^\]\n]+\]\]/g, match => ' '.repeat(match.length));
  const at = masked.toLocaleLowerCase('ru-RU').indexOf(lower(page.title));
  if (at < 0) return { error: 'mention_gone' };
  const original = found.body.slice(at, at + page.title.trim().length);
  const link = original === page.title.trim() ? `[[${original}]]` : `[[${page.title.trim()}|${original}]]`;
  const next = found.body.slice(0, at) + link + found.body.slice(at + original.length);
  saveNote(db, fromId, next);
  indexLinks(db, fromId);
  return { ok: true };
}

// ── место в дереве ─────────────────────────────────────────────────────────
// «[[Страница]] …» или «в страницу: …» в самой записи кладут её внутрь этой
// страницы — место можно назвать прямо при вводе на «Сегодня». Место из
// текста ставится один раз, при записи: потом человек волен его поменять.
export function placeFromText(db, { captureId, userId }) {
  if (!validId(captureId) || db.prepare('SELECT 1 FROM note_places WHERE capture_id=?').get(captureId)) return null;
  const capture = db.prepare('SELECT raw, user_id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
  if (!capture || capture.user_id !== userId) return null;
  if (!String(capture.raw).includes('[[') && !/^\s*в\s/i.test(capture.raw)) return null;
  const { pages } = loadPages(db, userId);
  let target = null;
  for (const { label } of linkTargets(capture.raw)) {
    target = pageByTitle(pages, label, captureId);
    if (target) break;
  }
  if (!target) {
    const into = String(capture.raw).match(/^\s*в\s+([^:\n]{2,80}?)\s*:\s*\S/i);
    if (into) {
      const phrase = lower(into[1]);
      target = pageByTitle(pages, phrase, captureId);
      if (!target && phrase.length >= 4) {
        const starts = pages.filter(page => page.id !== captureId && lower(page.title).startsWith(phrase));
        if (starts.length === 1) target = starts[0];
      }
    }
  }
  if (!target) return null;
  db.prepare('INSERT OR IGNORE INTO note_places(capture_id,parent_id,source,placed_at) VALUES(?,?,?,?)').run(captureId, target.id, 'text', now());
  return target.id;
}

// Новая запись: место из текста и ссылки. Зовётся сразу после создания — и для
// разобранной записи, и для той, что ещё ждёт разбора.
export function afterCapture(db, { captureId, userId }) {
  placeFromText(db, { captureId, userId });
  indexLinks(db, captureId);
}

// parent: 'root' — корень, 'auto' — место по правилу (проект или «Входящие»),
// иначе id страницы. Внутрь самой себя и своих потомков страницу не положить.
export function placePage(db, { userId, pageId, parent }) {
  const { byId } = loadPages(db, userId);
  const page = byId.get(pageId);
  if (!page) return { error: 'not_found' };
  if (parent === 'auto') {
    db.prepare('DELETE FROM note_places WHERE capture_id=?').run(pageId);
    return { ok: true };
  }
  let parentId = null;
  if (parent !== 'root') {
    if (!validId(parent) || !byId.has(parent)) return { error: 'parent_not_found' };
    for (let key = parent, guard = 0; key && byId.has(key) && guard < 500; key = byId.get(key).parentKey, guard += 1)
      if (key === pageId) return { error: 'cycle' };
    parentId = parent;
  }
  db.prepare(`INSERT INTO note_places(capture_id,parent_id,source,placed_at) VALUES(?,?,'manual',?)
    ON CONFLICT(capture_id) DO UPDATE SET parent_id=excluded.parent_id, source='manual', placed_at=excluded.placed_at`).run(pageId, parentId, now());
  return { ok: true };
}

// ── новая страница ─────────────────────────────────────────────────────────
// Страница из раздела заводится без модели: тип и название назвал человек, а
// разбирать одно название незачем. Проект наследуется от места.
function pageClassification(title, project) {
  const projects = project ? [project] : [];
  const fact = (field, value) => ({ field, value, kind: 'fact', confidence: 1, provenance: { source: 'raw', evidence: 'manual page' }, essential: field === 'type' });
  const claims = [fact('type', 'note'), fact('projects', projects), { field: 'schedule', value: null, kind: 'unknown', confidence: 0, provenance: { source: 'manual' }, essential: false }, { field: 'people', value: [], kind: 'unknown', confidence: 0, provenance: { source: 'manual' }, essential: false }, { field: 'followUp', value: null, kind: 'unknown', confidence: 0, provenance: { source: 'manual' }, essential: false }];
  return { primaryType: 'note', summary: title, entities: { projects, people: [], schedule: null, followUp: null }, additionalTypes: [], proposedActions: [], completed: false, ambiguity: null, claims, confidence: Object.fromEntries(claims.map(claim => [claim.field, claim.confidence])), conflicts: { projects: false, schedule: false } };
}
export function createPage(db, { userId, title, parent = 'root' }) {
  const name = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > PAGE_TITLE_LIMIT) return { error: 'invalid_title' };
  const { byId } = loadPages(db, userId);
  let project = null, parentId = null, placed = true;
  if (typeof parent === 'string' && parent.startsWith('project:')) {
    project = parent.slice(8).trim().slice(0, 120);
    if (!project) return { error: 'parent_not_found' };
    placed = false;
  } else if (parent && parent !== 'root') {
    if (!validId(parent) || !byId.has(parent)) return { error: 'parent_not_found' };
    parentId = parent;
    project = byId.get(parent).project;
  }
  const ids = createLedger(db, { raw: name, classification: pageClassification(name, project), provider: 'manual', userId });
  // Тело новой страницы пустое: название уже стоит заголовком, повторять его
  // первой строкой текста незачем.
  saveNote(db, ids.captureId, '');
  if (placed) db.prepare('INSERT INTO note_places(capture_id,parent_id,source,placed_at) VALUES(?,?,?,?)').run(ids.captureId, parentId, 'manual', now());
  indexLinks(db, ids.captureId);
  return { id: ids.captureId };
}

// ── обзор и страница ───────────────────────────────────────────────────────
function linkCounts(db, userId, pages) {
  const counts = new Map();
  const byTitle = new Map(pages.map(page => [lower(page.title), page.id]));
  for (const row of db.prepare('SELECT DISTINCT l.from_id, l.to_id, l.label FROM note_links l JOIN captures c ON c.id=l.from_id AND c.deleted_at IS NULL AND c.user_id IS ?').iterate(userId)) {
    const target = row.to_id ?? byTitle.get(lower(row.label));
    if (target && target !== row.from_id) counts.set(target, (counts.get(target) || 0) + 1);
  }
  return counts;
}
const listed = (page, counts) => ({
  id: page.id, title: page.title, type: page.type, project: page.project, tags: page.tags,
  createdAt: page.createdAt, updatedAt: page.updatedAt, parentKey: page.parentKey,
  placed: page.placed, excerpt: plain(page.body).slice(0, 220), links: counts.get(page.id) || 0,
});

export function pagesOverview(db, userId) {
  const { pages, byId } = loadPages(db, userId);
  const counts = linkCounts(db, userId, pages);
  const candidates = placeCandidates(db, userId, pages);
  const list = pages.map(page => {
    const item = listed(page, counts);
    if (page.parentKey === 'inbox') item.suggest = suggestPlace(page, candidates);
    if (page.parentKey && byId.has(page.parentKey)) item.parentTitle = byId.get(page.parentKey).title;
    return item;
  });
  const projects = new Map();
  for (const page of pages) if (page.parentKey?.startsWith('project:')) projects.set(page.project, (projects.get(page.project) || 0) + 1);
  return {
    pages: list,
    projects: [...projects.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => left.name.localeCompare(right.name, 'ru')),
    allProjects: knownProjects(db, userId).sort((left, right) => left.localeCompare(right, 'ru')),
    bases: listBases(db, userId),
  };
}

export function pageDetail(db, userId, pageId) {
  if (!validId(pageId)) return null;
  const { pages, byId } = loadPages(db, userId);
  const page = byId.get(pageId);
  if (!page) return null;
  const counts = linkCounts(db, userId, pages);
  const backlinks = backlinksOf(db, userId, page);
  const linked = new Set(backlinks.map(link => link.id));
  return {
    page: { ...listed(page, counts), body: page.body, noteVersion: page.noteVersion, placeSource: page.placeSource },
    trail: trailOf(page, byId),
    children: pages.filter(child => child.parentKey === page.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(child => listed(child, counts)),
    backlinks,
    mentions: mentionsOf(db, userId, page, linked),
    deeds: deedsOf(db, userId, page),
    suggest: page.parentKey === 'inbox' ? suggestPlace(page, placeCandidates(db, userId, pages)) : null,
  };
}

// ── дела из строк заметки ──────────────────────────────────────────────────
function deedsOf(db, userId, page) {
  const anchors = new Set();
  for (const line of page.body.split('\n')) { const match = line.match(ANCHOR); if (match) anchors.add(match[1]); }
  if (!anchors.size) return [];
  const rows = db.prepare(`SELECT c.id, c.raw, i.classification_json FROM captures c
    LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    WHERE c.parent_capture_id=? AND c.deleted_at IS NULL AND c.user_id IS ?`).all(page.id, userId);
  const out = [];
  for (const row of rows) {
    const anchor = deedAnchor(row.id);
    if (!anchors.has(anchor)) continue;
    out.push({ anchor, ...deedState(db, userId, row) });
  }
  return out;
}
function deedState(db, userId, row) {
  const classification = row.classification_json ? parseJson(row.classification_json, {}) : null;
  if (!classification) {
    const job = db.prepare('SELECT state FROM capture_jobs WHERE capture_id=? ORDER BY created_at DESC LIMIT 1').get(row.id);
    return { captureId: row.id, title: plain(row.raw), state: job?.state === 'failed' ? 'failed' : 'pending', projectionIds: [], column: null, due: null };
  }
  const projections = db.prepare("SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event') ORDER BY created_at").all(row.id).map(item => item.id);
  const lastEvent = db.prepare("SELECT event_type FROM ledger_events WHERE projection_id=? AND event_type IN ('completed','completion_undone') ORDER BY rowid DESC LIMIT 1");
  const done = classification.completed === true || (projections.length > 0 && projections.every(id => lastEvent.get(id)?.event_type === 'completed'));
  const column = db.prepare('SELECT bc.name FROM board_placements bp LEFT JOIN board_columns bc ON bc.id=bp.column_id WHERE bp.capture_id=? AND bp.user_id IS ?').get(row.id, userId);
  const onBoard = projections.length > 0;
  return {
    captureId: row.id,
    title: classification.summary || plain(row.raw),
    state: done ? 'done' : onBoard ? 'open' : 'other',
    type: classification.primaryType,
    projectionIds: projections,
    column: onBoard ? column?.name || 'Входящие' : null,
    due: classification.entities?.schedule?.display || null,
  };
}

// Дело из строки: строка «- [ ] …» становится записью-делом, а в конец строки
// дописывается якорь. Строку сверяем с тем, что прислал браузер: если заметку
// успели поменять, лучше попросить повторить, чем завести дело не из той строки.
export async function createDeed(db, { userId, pageId, line, text, queue }) {
  const { byId } = loadPages(db, userId);
  const page = byId.get(pageId);
  if (!page) return { error: 'not_found' };
  const lines = page.body.split('\n');
  if (!Number.isInteger(line) || line < 0 || line >= lines.length || typeof text !== 'string' || lines[line] !== text) return { error: 'line_changed' };
  const task = lines[line].match(TASK_LINE);
  if (!task) return { error: 'not_task_line' };
  if (ANCHOR.test(lines[line])) return { error: 'already_deed' };
  if (task[2] !== ' ') return { error: 'done_line' };
  const title = task[4].replace(/\s+\^[\w-]{1,40}\s*$/, '').trim();
  if (!title || title.length > 500) return { error: 'not_task_line' };
  const queued = await queue(title);
  // Пока ждали очередь, заметку могли сохранить ещё раз: строку ищем заново.
  const fresh = bodyOf(db, pageId);
  const freshLines = fresh.body.split('\n');
  const index = freshLines[line] === text ? line : freshLines.indexOf(text);
  db.prepare('UPDATE captures SET parent_capture_id=? WHERE id=?').run(pageId, queued.captureId);
  if (index >= 0) {
    freshLines[index] = `${freshLines[index].replace(/\s+$/, '')} ^${deedAnchor(queued.captureId)}`;
    saveNote(db, pageId, freshLines.join('\n'));
  }
  return { captureId: queued.captureId, anchor: deedAnchor(queued.captureId) };
}

// Дело закрыли (на «Доске», в «Сегодня», в самой заметке) — строка в заметке
// отмечается так же, чтобы текст заметки не врал, в том числе при выгрузке.
export function syncDeedLine(db, captureId) {
  const capture = db.prepare('SELECT id, parent_capture_id, user_id, raw FROM captures WHERE id=?').get(captureId);
  if (!capture?.parent_capture_id) return false;
  const found = bodyOf(db, capture.parent_capture_id);
  if (!found || found.capture.user_id !== capture.user_id) return false;
  const anchor = deedAnchor(captureId);
  const lines = found.body.split('\n');
  const index = lines.findIndex(line => ANCHOR.test(line) && line.match(ANCHOR)[1] === anchor);
  if (index < 0) return false;
  const interpretation = db.prepare("SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(captureId);
  const state = deedState(db, capture.user_id, { ...capture, classification_json: interpretation?.classification_json || null });
  const task = lines[index].match(TASK_LINE);
  if (!task) return false;
  const mark = state.state === 'done' ? 'x' : ' ';
  if ((task[2].toLowerCase() === 'x') === (mark === 'x')) return false;
  lines[index] = `${task[1]}${mark}${task[3]}${task[4]}`;
  saveNote(db, capture.parent_capture_id, lines.join('\n'));
  return true;
}

// ── базы ───────────────────────────────────────────────────────────────────
function normalizeView(view) {
  const source = view && typeof view === 'object' ? view : {};
  const filter = source.filter && typeof source.filter === 'object' ? source.filter : {};
  const text = (value, limit) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null);
  const out = {
    layout: LAYOUTS.includes(source.layout) ? source.layout : 'table',
    sort: SORTS.includes(source.sort) ? source.sort : 'created',
    filter: {
      type: TYPES.includes(filter.type) ? filter.type : 'all',
      project: text(filter.project, 120),
      tag: text(filter.tag, 40),
      parent: filter.parent && validId(filter.parent) ? filter.parent : null,
    },
  };
  return out;
}
const serializeBase = row => ({ id: row.id, name: row.name, view: normalizeView(parseJson(row.view_json, {})), createdAt: row.created_at, updatedAt: row.updated_at });
export function listBases(db, userId) {
  return db.prepare('SELECT * FROM note_bases WHERE user_id=? ORDER BY created_at').all(userId).map(serializeBase);
}
function baseName(name) {
  const value = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  return value && value.length <= BASE_NAME_LIMIT ? value : null;
}
export function createBase(db, { userId, name, view }) {
  const clean = baseName(name);
  if (!clean) return { error: 'invalid_base_name' };
  if (db.prepare('SELECT COUNT(*) AS n FROM note_bases WHERE user_id=?').get(userId).n >= BASES_LIMIT) return { error: 'bases_limit' };
  const id = crypto.randomUUID(), at = now();
  db.prepare('INSERT INTO note_bases(id,user_id,name,view_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, userId, clean, JSON.stringify(normalizeView(view)), at, at);
  return { base: serializeBase(db.prepare('SELECT * FROM note_bases WHERE id=?').get(id)) };
}
export function updateBase(db, { userId, baseId, name, view }) {
  const row = validId(baseId) ? db.prepare('SELECT * FROM note_bases WHERE id=? AND user_id=?').get(baseId, userId) : null;
  if (!row) return { error: 'base_not_found' };
  const nextName = name === undefined ? row.name : baseName(name);
  if (!nextName) return { error: 'invalid_base_name' };
  const nextView = view === undefined ? parseJson(row.view_json, {}) : view;
  db.prepare('UPDATE note_bases SET name=?, view_json=?, updated_at=? WHERE id=?').run(nextName, JSON.stringify(normalizeView(nextView)), now(), baseId);
  return { base: serializeBase(db.prepare('SELECT * FROM note_bases WHERE id=?').get(baseId)) };
}
export function deleteBase(db, { userId, baseId }) {
  const result = validId(baseId) ? db.prepare('DELETE FROM note_bases WHERE id=? AND user_id=?').run(baseId, userId) : { changes: 0 };
  return result.changes ? { ok: true } : { error: 'base_not_found' };
}

// ── маршруты ───────────────────────────────────────────────────────────────
const ERRORS = {
  not_found: [404, 'Страница не найдена.'],
  parent_not_found: [404, 'Такого места нет.'],
  cycle: [409, 'Страницу нельзя положить внутрь неё самой.'],
  invalid_title: [400, `Название страницы — от 1 до ${PAGE_TITLE_LIMIT} символов.`],
  invalid_parent: [400, 'Некорректное место.'],
  mention_gone: [409, 'Упоминания уже нет в тексте.'],
  line_changed: [409, 'Строка изменилась — сохраните заметку и попробуйте ещё раз.'],
  not_task_line: [400, 'Делом становится строка вида «- [ ] что сделать».'],
  already_deed: [409, 'Эта строка уже на «Доске».'],
  done_line: [400, 'Отмеченная строка уже сделана — дело из неё не нужно.'],
  invalid_base_name: [400, `Название базы — от 1 до ${BASE_NAME_LIMIT} символов.`],
  bases_limit: [409, `Баз может быть не больше ${BASES_LIMIT}.`],
  base_not_found: [404, 'База не найдена.'],
};
function reply(res, result, status = 200) {
  if (result?.error) {
    const [code, message] = ERRORS[result.error] || [400, 'Не удалось выполнить действие.'];
    return res.status(code).json({ error: { code: result.error, message } });
  }
  return res.status(status).json(result);
}

// Маршруты страниц и перехватчики чужих ответов. Перехватчики регистрируются
// раньше основных маршрутов и ничего не меняют в ответе: после того как запись
// создана, заметка сохранена или дело закрыто, они обновляют место, связи и
// отметку строки. Ошибка здесь не должна ронять основное действие.
export function registerNotesRoutes(app, { db, notifyJournal = () => {}, queueCapture }) {
  indexExistingLinks(db);
  const after = handler => (req, res, next) => {
    const json = res.json.bind(res);
    res.json = body => {
      if (res.statusCode < 300) { try { handler(req, body); } catch {} }
      return json(body);
    };
    next();
  };
  app.post('/api/captures', after((req, body) => {
    const captureId = body?.captureId || body?.entry?.id;
    if (captureId) afterCapture(db, { captureId, userId: req.user.id });
  }));
  app.post('/api/captures/:id/notes', after(req => indexLinks(db, req.params.id)));
  for (const path of ['/api/projections/:id/complete', '/api/projections/:id/undo-complete'])
    app.post(path, after(req => {
      const projection = db.prepare('SELECT capture_id FROM projections WHERE id=?').get(req.params.id);
      if (projection) syncDeedLine(db, projection.capture_id);
    }));

  const guard = fn => (req, res, next) => { try { fn(req, res); } catch (error) { next(error); } };
  app.get('/api/pages', guard((req, res) => res.json(pagesOverview(db, req.user.id))));
  app.post('/api/pages', guard((req, res) => {
    const parent = req.body?.parent ?? 'root';
    if (typeof parent !== 'string') return reply(res, { error: 'invalid_parent' });
    const result = createPage(db, { userId: req.user.id, title: req.body?.title, parent });
    if (result.error) return reply(res, result);
    notifyJournal('page');
    reply(res, pageDetail(db, req.user.id, result.id), 201);
  }));
  app.get('/api/pages/resolve', guard((req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title.slice(0, PAGE_TITLE_LIMIT) : '';
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    res.json({ id: title.trim() ? resolveTitle(db, req.user.id, title, from) : null });
  }));
  app.post('/api/pages/bases', guard((req, res) => reply(res, createBase(db, { userId: req.user.id, name: req.body?.name, view: req.body?.view }), 201)));
  app.patch('/api/pages/bases/:id', guard((req, res) => reply(res, updateBase(db, { userId: req.user.id, baseId: req.params.id, name: req.body?.name, view: req.body?.view }))));
  app.delete('/api/pages/bases/:id', guard((req, res) => reply(res, deleteBase(db, { userId: req.user.id, baseId: req.params.id }))));
  app.get('/api/pages/:id', guard((req, res) => {
    const detail = pageDetail(db, req.user.id, req.params.id);
    if (!detail) return reply(res, { error: 'not_found' });
    res.json(detail);
  }));
  app.put('/api/pages/:id/place', guard((req, res) => {
    const parent = req.body?.parent;
    if (typeof parent !== 'string') return reply(res, { error: 'invalid_parent' });
    const result = placePage(db, { userId: req.user.id, pageId: req.params.id, parent });
    if (result.error) return reply(res, result);
    notifyJournal('page');
    res.json(pageDetail(db, req.user.id, req.params.id));
  }));
  app.post('/api/pages/:id/mentions', guard((req, res) => {
    const result = linkMention(db, { userId: req.user.id, pageId: req.params.id, fromId: req.body?.fromId });
    if (result.error) return reply(res, result);
    notifyJournal('note');
    res.json(pageDetail(db, req.user.id, req.params.id));
  }));
  app.post('/api/pages/:id/deeds', async (req, res, next) => {
    try {
      const result = await createDeed(db, { userId: req.user.id, pageId: req.params.id, line: req.body?.line, text: req.body?.text, queue: title => queueCapture(req.user, title, { primaryType: 'task' }) });
      if (result.error) return reply(res, result);
      notifyJournal('queued');
      res.status(201).json({ ...pageDetail(db, req.user.id, req.params.id), deed: result });
    } catch (error) { next(error); }
  });
}
