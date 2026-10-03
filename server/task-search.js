import crypto from 'node:crypto';
import { dateInZone, shiftDate } from './reports.js';
import { validIsoDate } from './repeat.js';
import { occurrencesOf } from './occurrences.js';
import { displayName, canSeeCapture, assignmentFor } from './circles.js';
import { normalizeSearchText, searchWords, lexicalMatch } from './search-normalization.js';

// Independent feature migration: other worktrees may add numbered migrations.
export function initializeTaskSearchSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_search_origins (
    id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), user_id TEXT,
    message_id INTEGER, type TEXT NOT NULL, sender_id TEXT, name TEXT, username TEXT,
    source_date TEXT, source_url TEXT, request_excerpt TEXT, own_promise_excerpt TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_search_origins_capture ON task_search_origins(capture_id);
  CREATE INDEX IF NOT EXISTS task_search_origins_owner ON task_search_origins(user_id);
  CREATE INDEX IF NOT EXISTS task_search_origins_identity_scan ON task_search_origins(user_id,id);
  CREATE INDEX IF NOT EXISTS task_search_capture_scan ON captures(user_id, created_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS task_search_receipts (
    receipt_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, binding_key TEXT NOT NULL,
    kind TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_search_generations (user_key TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0);`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_search_intents (
    connection_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, binding_key TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS entry_search_traces (
    id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, query TEXT NOT NULL,
    outcome TEXT NOT NULL, matched_count INTEGER NOT NULL, partial INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entry_search_traces_requester ON entry_search_traces(requester_id,created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS entry_search_trace_matches (
    trace_id TEXT NOT NULL REFERENCES entry_search_traces(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, capture_id TEXT NOT NULL, reason_codes_json TEXT NOT NULL,
    score INTEGER NOT NULL, PRIMARY KEY(trace_id,position)
  );
  CREATE INDEX IF NOT EXISTS entry_search_trace_capture ON entry_search_trace_matches(capture_id);`);
}

const normalize = normalizeSearchText;
const words = searchWords;
const nameForms = new Map([
  ['саша', 'саша'], ['саши', 'саша'], ['саше', 'саша'], ['сашу', 'саша'], ['сашей', 'саша'],
  ['петя', 'петя'], ['пети', 'петя'], ['пете', 'петя'], ['петю', 'петя'], ['петей', 'петя'],
  ['маша', 'маша'], ['маши', 'маша'], ['маше', 'маша'], ['машу', 'маша'], ['машей', 'маша'],
  ['аня', 'аня'], ['ани', 'аня'], ['ане', 'аня'], ['аню', 'аня'], ['аней', 'аня'],
]);
function stem(value) {
  const word = normalize(value);
  if (nameForms.has(word)) return nameForms.get(word);
  return word.length > 4 ? word.replace(/(?:иями|ами|ями|ого|ему|ому|ий|ый|ой|ая|яя|ое|ее|ые|ие|ов|ев|ам|ям|ах|ях|ом|ем|ть|ти|а|я|ы|и|у|ю|е)$/u, '') : word;
}
const conceptGroups = [
  ['документ', 'бумага'], ['отчет', 'сводка'], ['оплата', 'платеж', 'заплатить', 'оплатить'],
  ['проверить', 'проверка'], ['отправить', 'прислать', 'выслать', 'отослать'], ['звонок', 'позвонить', 'созвон'],
];
const concepts = new Map();
for (const group of conceptGroups) for (const word of group) concepts.set(stem(word), group.map(stem));
const stopWords = new Set(words('какие какой какая что мне мои моих меня я у нас вообще дела дело задачи задача найти найди покажи поиск были было есть еще не сделал сделала выполнил выполнила сделано выполнено выполненные завершенные открытые незавершенные осталось осталось связанные связано связаны с со и или по за в на к от про все просьбы просьба попросил попросила обещал обещала обещаю ему ей им сегодня вчера неделю прошлую прошлой прошлые добавленные созданные выполнены срок сроки запланированные запланировано до').map(stem));
for (const word of words('дай все всё связанное связанного проект проекта проекту проекты подзадачи подзадача заметка заметки заметку результаты результат решения решение встреча встречи встречу идеи идея вопросы вопрос человек участник')) stopWords.add(stem(word));
const typeWords = { task:['задача','задачи','задачу','задач'], subtask:['подзадача','подзадачи','подзадачу','подзадач'], note:['заметка','заметки','заметку','заметок'], outcome_decision:['результат','результаты','результатов','решение','решения'], meeting_event:['встреча','встречи','встречу','встреч'], idea_question:['идея','идеи','идей','вопрос','вопросы'] };

function extractPerson(query, role) {
  const lower = normalize(query);
  const pattern = role === 'requester'
    ? /(?:просьб[аы]?|попросил[а]?|просьбы\s+от)\s+(?:от\s+)?(@?[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_.-]+\.[\p{L}]{2,})?)/u
    : role === 'promise'
      ? /обещал[а]?\s+(?!(?:ему|ей|им)(?:\s|[?.!]|$))(@?[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_.-]+\.[\p{L}]{2,})?)/u
      : /(?:^|\s)(?:с|про|человек|участник)\s+(@?[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_.-]+\.[\p{L}]{2,})?)/u;
  const matched = lower.match(pattern);
  if (!matched) return null;
  const start = matched.index + matched[0].lastIndexOf(matched[1]);
  const end = start + matched[1].length;
  const surname = query.slice(end).match(/^\s+([А-ЯЁA-Z][\p{L}]+)(?=\s|[?.!]|$)/u)?.[1];
  return query.slice(start, end) + (surname && !stopWords.has(stem(surname)) ? ` ${surname}` : '');
}

export function parseTaskSearchQuery(query, { now = new Date(), timeZone = 'Europe/Samara', previousCriteria = null } = {}) {
  const original = String(query || '').trim().slice(0, 1000);
  const lower = normalize(original);
  const tokens = new Set(words(lower));
  const type = Object.entries(typeWords).find(([, forms]) => forms.some(word => tokens.has(word)))?.[0] || null;
  const role = /обеща/u.test(lower) ? 'promise' : /просьб|попросил/u.test(lower) ? 'requester' : 'related';
  const exclusivePerson = tokens.has('человек') || tokens.has('участник') || role !== 'related';
  let person = extractPerson(original, role);
  const pronoun = /(?:^|\s)(ему|ей|им)(?:\s|[?.!]|$)/u.test(lower);
  if (!person && pronoun) person = previousCriteria?.person || null;
  const today = dateInZone(now, timeZone);
  let period = null;
  // Keep each whole hyphenated fragment, including empty or extra fields.
  // A year prefix or three numeric fields identifies a date candidate; ISO validation stays strict.
  const fragments = lower.match(/[\p{L}\p{N}_-]+/gu) || [];
  const dates = fragments.filter(fragment => /^\d{4,}-/.test(fragment) || /\d+(?:-+\d*){2}/.test(fragment)).flatMap(fragment => {
    const range = /^(\d{4}-\d{2}-\d{2})-+(\d{4}-\d{2}-\d{2})$/.exec(fragment);
    return range ? range.slice(1) : [fragment];
  });
  if (dates.some(date => !validIsoDate(date)) || dates.length > 2) return { clarification: 'Укажите существующую дату или диапазон в формате YYYY-MM-DD.' };
  if (dates.length) {
    if (dates.length === 2 && dates[0] > dates[1]) return { clarification: 'Начало периода должно быть раньше его конца.' };
    period = { from: dates[0], to: dates.at(-1) };
  } else if (/прошл(?:ую|ой)\s+недел/u.test(lower)) {
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
    period = { from: shiftDate(today, -weekday - 6), to: shiftDate(today, -weekday) };
  } else if (tokens.has('вчера')) period = { from: shiftDate(today, -1), to: shiftDate(today, -1) };
  else if (tokens.has('сегодня')) period = { from: today, to: today };
  else if ([...tokens].some(token => /^(?:недел[\p{L}]*|месяц[\p{L}]*|год(?:а|ов|у|ы)?)$/u.test(token)) || /\d{1,2}[./]\d{1,2}/u.test(lower)) return { clarification: 'Уточните период: «за прошлую неделю» или YYYY-MM-DD — YYYY-MM-DD.' };
  const status = /не\s+(?:сделал|выполнил)|не[\s-]?заверш|открыт|остал/u.test(lower) ? 'open'
    : /сделан|выполнен|завершен/u.test(lower) ? 'done' : 'all';
  const basis = /срок|дедлайн/u.test(lower) ? 'deadline' : /заплан/u.test(lower) ? 'scheduled'
    : /добавлен|создан/u.test(lower) ? 'created' : /выполнен|завершен/u.test(lower) ? 'completed' : 'createdOrCompleted';
  const excluded = new Set([...words(person).map(stem), ...dates.flatMap(words).map(stem)]);
  const terms = [...new Set(words(original).map(stem).filter(word => !stopWords.has(word) && !excluded.has(word) && !/^\d+$/.test(word)))].slice(0, 12);
  const lexicalTerms = [...new Set(words(original).filter(word => !stopWords.has(stem(word)) && !excluded.has(stem(word)) && !/^\d+$/.test(word)))].slice(0, 12);
  let inherited = false;
  if (previousCriteria && (pronoun || (period && !person && !terms.length))) {
    person ||= previousCriteria.person;
    inherited = true;
  }
  const criteria = { person, role: inherited && role === 'related' ? previousCriteria.role : role, exclusivePerson:exclusivePerson || Boolean(inherited && previousCriteria.exclusivePerson), status: inherited && status === 'all' ? previousCriteria.status : status, type: inherited && !type ? previousCriteria.type || null : type, period, basis, terms: inherited && !terms.length ? previousCriteria.terms || [] : terms, lexicalTerms: inherited && !lexicalTerms.length ? previousCriteria.lexicalTerms || previousCriteria.terms || [] : lexicalTerms, inherited };
  if (pronoun && !person) return { criteria, clarification: 'Назовите человека: кому вы обещали или с кем связаны дела?' };
  if (!original || (!person && !period && !terms.length && !type && status === 'all' && role === 'related')) return { criteria, clarification: 'Укажите человека, тему, статус или период. Например: «дела с Петей».' };
  return { criteria };
}

function publicSourceUrl(value) {
  return /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/[1-9]\d*$/.test(String(value || '')) ? value : null;
}
const requestCue = /^\s*(?:пожалуйста[,\s]+)?(?:прошу|просьба|можешь|можете|нужно\s+(?:тебе|вам)|пришли|пришлите|сделай|сделайте|подготовь|подготовьте|проверь|проверьте|отправь|отправьте|помоги|помогите)(?:\s|[,:])/iu;
const ownPromise = /^\s*(?:я\s+обещал[а]?|(?:я\s+)?обещаю|(?:я\s+)?обязуюсь)(?:\s|[,:])/iu;
const ownNamedRequest = /^\s*[\p{L}]+(?:\s+[\p{L}]+)?\s+попросил[а]?\s/iu;
const excerpt = (text, pattern) => pattern.test(text) ? String(text).replace(/\s+/g, ' ').slice(0, 200) : null;

export function taskSearchOriginFromMessage(message) {
  const origin = message?.forward_origin;
  const legacy = message?.forward_from;
  const forwarded = Boolean(origin || legacy || message?.forward_sender_name || message?.forward_from_chat);
  const sender = origin?.sender_user || legacy || (!forwarded ? message?.from : null);
  const channel = origin?.type === 'channel' ? origin.chat : message?.forward_from_chat?.type === 'channel' ? message.forward_from_chat : null;
  const sourceMessageId = origin?.message_id || message?.forward_from_message_id;
  const sourceSeconds = origin?.date || message?.forward_date || message?.date;
  const body = String(message?.text || message?.caption || '');
  const statementStart = body.search(/\S/u);
  const quoted = (message?.entities || message?.caption_entities || []).some(entity => ['blockquote', 'expandable_blockquote'].includes(entity.type) && Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset <= statementStart && entity.offset + entity.length > statementStart);
  return {
    messageId: message?.message_id || null,
    type: forwarded ? origin?.type || (legacy ? 'user' : channel ? 'channel' : 'hidden_user') : 'own',
    senderId: sender?.id != null ? String(sender.id) : channel?.id != null ? String(channel.id) : null,
    name: sender ? [sender.first_name, sender.last_name].filter(Boolean).join(' ') || null : origin?.sender_user_name || message?.forward_sender_name || origin?.sender_chat?.title || channel?.title || null,
    username: sender?.username || channel?.username || null,
    sourceDate: Number.isInteger(sourceSeconds) && Number.isFinite(new Date(sourceSeconds * 1000).getTime()) ? new Date(sourceSeconds * 1000).toISOString() : null,
    sourceUrl: channel?.username && sourceMessageId ? publicSourceUrl(`https://t.me/${channel.username}/${sourceMessageId}`) : null,
    requestExcerpt: !quoted ? excerpt(body, forwarded ? requestCue : ownNamedRequest) : null,
    ownPromiseExcerpt: !forwarded && !quoted ? excerpt(body, ownPromise) : null,
  };
}

function personMatches(name, query) {
  const haystack = words(name), needles = words(query);
  const matchesToken = (known, needle) => {
    if (known === needle) return true;
    if (known.startsWith('@') || needle.startsWith('@')) return false;
    if (nameForms.has(known) || nameForms.has(needle)) return nameForms.get(known) === nameForms.get(needle);
    if (/[ая]$/u.test(known)) return ['и', 'ы', 'е', 'у', 'ю', 'ой', 'ей'].some(ending => `${known.slice(0, -1)}${ending}` === needle);
    if (/[йь]$/u.test(known)) return ['я', 'ю', 'ем', 'е'].some(ending => `${known.slice(0, -1)}${ending}` === needle);
    return ['а', 'у', 'ом', 'е'].some(ending => `${known}${ending}` === needle);
  };
  return needles.length > 0 && needles.every(needle => haystack.some(known => matchesToken(known, needle)));
}
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const boundedText = value => String(value || '').slice(0, 100000);
const accessibleCaptures = `WITH accessible(id) AS (
  SELECT id FROM captures WHERE user_id=@requester
  UNION SELECT capture_id FROM capture_people WHERE user_id=@requester AND removed_at IS NULL
  UNION SELECT cc.capture_id FROM capture_circles cc JOIN circle_members m ON m.circle_id=cc.circle_id
    WHERE m.user_id=@requester AND m.left_at IS NULL AND cc.removed_at IS NULL
)`;

export function exportEntrySearchTraces(db, requesterId, at = new Date()) {
  cleanupEntrySearchTraces(db, requesterId, at);
  return db.prepare('SELECT * FROM entry_search_traces WHERE requester_id IS ? ORDER BY created_at,rowid').all(requesterId).map(trace => ({
    ...trace,
    matches: db.prepare('SELECT capture_id,reason_codes_json,score FROM entry_search_trace_matches WHERE trace_id=? ORDER BY position').all(trace.id)
      .filter(row => db.prepare('SELECT 1 FROM captures WHERE id=? AND deleted_at IS NULL').get(row.capture_id) && canSeeCapture(db, row.capture_id, requesterId))
      .map(row => ({ captureId:row.capture_id, reasonCodes:parseJson(row.reason_codes_json, []), score:row.score })),
  }));
}
function cleanupEntrySearchTraces(db, requesterId, at) {
  const cutoff = new Date(at.getTime() - 30 * 86400000).toISOString();
  db.prepare('DELETE FROM entry_search_traces WHERE requester_id IS ? AND created_at<?').run(requesterId, cutoff);
  db.prepare(`DELETE FROM entry_search_traces WHERE id IN (SELECT id FROM entry_search_traces
    WHERE requester_id IS ? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1000)`).run(requesterId);
}

export function resetEntrySearchTraces(db, requesterId) {
  db.prepare('DELETE FROM entry_search_trace_matches WHERE capture_id IN (SELECT id FROM captures WHERE user_id IS ?)').run(requesterId);
  db.prepare('DELETE FROM entry_search_traces WHERE requester_id IS ?').run(requesterId);
}

export function createTaskSearchService(db, { maxScanMs = 2000, clock = () => performance.now(), pageSize = 6 } = {}) {
  initializeTaskSearchSchema(db);
  const generation = userId => db.prepare('SELECT generation FROM task_search_generations WHERE user_key=?').get(userId ?? '__orphan__')?.generation || 0;
  const currentCapture = db.prepare(`SELECT c.*, i.classification_json,n.body AS note_body FROM captures c
    LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    LEFT JOIN capture_notes n ON n.capture_id=c.id AND n.status='active'
    WHERE c.id=? AND c.deleted_at IS NULL`);
  const originsFor = db.prepare('SELECT * FROM task_search_origins WHERE capture_id=? ORDER BY created_at,id LIMIT 21');
  const projectionsFor = db.prepare(`SELECT p.id, (SELECT e.event_type FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type IN ('completed','completion_undone') ORDER BY e.rowid DESC LIMIT 1) completion,
    (SELECT e.occurred_at FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type IN ('completed','completion_undone') ORDER BY e.rowid DESC LIMIT 1) completed_at
    FROM projections p WHERE p.capture_id=? AND p.status='active' AND p.projection_type IN ('task','meeting_event')`);
  const participantsFor = db.prepare('SELECT u.id,u.email,u.display_name FROM capture_people p JOIN users u ON u.id=p.user_id WHERE p.capture_id=? AND p.removed_at IS NULL');
  const authorFor = db.prepare('SELECT id,email,display_name FROM users WHERE id=?');
  const scan = db.prepare(`${accessibleCaptures} SELECT c.*,i.classification_json,n.body AS note_body
    FROM accessible a JOIN captures c ON c.id=a.id LEFT JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    LEFT JOIN capture_notes n ON n.capture_id=c.id AND n.status='active'
    WHERE c.deleted_at IS NULL AND (c.created_at < @cursorDate OR (c.created_at=@cursorDate AND c.id<@cursorId))
    ORDER BY c.created_at DESC,c.id DESC LIMIT 200`);
  const relationIds = db.prepare(`SELECT related_id,relation FROM (
    SELECT parent_capture_id related_id,'parent' relation FROM captures WHERE id=?
    UNION ALL SELECT parent_id,'place' FROM note_places WHERE capture_id=?
    UNION ALL SELECT to_id,'link' FROM note_links WHERE from_id=?
    UNION ALL SELECT from_id,'link' FROM note_links WHERE to_id=?
  ) WHERE related_id IS NOT NULL LIMIT 20`);

  function entryOf(row, userId, timeZone) {
    if (!row || !canSeeCapture(db, row.id, userId)) return null;
    const classification = parseJson(row.classification_json);
    const type = classification.primaryType || 'unknown';
    const actionable = ['task','meeting_event'].includes(type);
    const projections = actionable ? projectionsFor.all(row.id) : [];
    const container = !projections.length && classification.completed !== true && (classification.proposedActions || []).some(action => action.type === 'task' && typeof action.title === 'string');
    const closed = projections.length > 0 && projections.every(item => item.completion === 'completed');
    const done = closed || (!projections.length && classification.completed === true);
    const completedAt = closed ? projections.map(item => item.completed_at).filter(Boolean).sort().at(-1) || null : done ? row.occurred_at : null;
    const origins = originsFor.all(row.id);
    const author=authorFor.get(row.user_id),assignment=assignmentFor(db,row.id);
    const associatedPeople=[];
    if (author) associatedPeople.push({id:author.id,name:displayName(author),email:author.email,association:'author'});
    if (assignment?.assignee) associatedPeople.push({...assignment.assignee,association:'assignee'});
    const schedule = classification.entities?.schedule || null;
    const occurrences = schedule?.repeat ? occurrencesOf(db, row.id) : [];
    const relations = [], seen = new Set([row.id]);
    for (const edge of relationIds.all(row.id,row.id,row.id,row.id)) {
      if (seen.has(edge.related_id)) continue;
      seen.add(edge.related_id);
      const related = currentCapture.get(edge.related_id);
      if (!related || !canSeeCapture(db, related.id, userId)) continue;
      const detail = parseJson(related.classification_json);
      relations.push({ captureId:related.id, relation:edge.relation, type:detail.primaryType || 'unknown', title:detail.summary || (related.note_body ?? related.raw ?? '').slice(0,160), text:boundedText(related.note_body ?? related.raw), textTruncated:String(related.note_body ?? related.raw ?? '').length>100000, projects:detail.entities?.projects || [] });
    }
    return { captureId:row.id, type, subtask:Boolean(row.subtask), container, title:classification.summary || (row.note_body ?? row.raw ?? '').slice(0,160), raw:boundedText(row.note_body ?? row.raw), classification,
      owned:row.user_id===userId, status:actionable && !container ? done ? 'done' : 'open' : null,
      createdAt:row.created_at, completedAt:actionable && !container ? completedAt : null,
      scheduledDate:schedule?.date || null, deadline:schedule?.date && !schedule.defaulted && !schedule.repeat ? schedule.date : null,
      occurrences, repeat:Boolean(schedule?.repeat), origins, people:classification.entities?.people || [], projects:classification.entities?.projects || [],
      participants:participantsFor.all(row.id).map(item => ({ id:item.id,name:displayName(item),email:item.email })), associatedPeople,relations,
      textTruncated:String(row.note_body ?? row.raw ?? '').length>100000 || relations.some(edge=>edge.textTruncated),
      evidence:[],sourceUrl:origins.length===1 ? publicSourceUrl(origins[0].source_url) : null,timeZone };
  }

  function match(entry, criteria) {
    if (criteria.type === 'subtask' ? !entry.subtask : criteria.type && entry.type !== criteria.type) return null;
    if (criteria.type === 'task' && entry.container) return null;
    const completedOccurrences = entry.occurrences.filter(item => !criteria.period || (dateInZone(new Date(item.completedAt), entry.timeZone) >= criteria.period.from && dateInZone(new Date(item.completedAt), entry.timeZone) <= criteria.period.to));
    const occurrenceResult = criteria.status === 'done' && entry.status === 'open' && completedOccurrences.length > 0;
    if (criteria.status !== 'all' && entry.status !== criteria.status && !occurrenceResult) return null;
    const evidence = [], reasonCodes = new Set();
    if (criteria.type) reasonCodes.add('type-filter');
    if (criteria.status !== 'all') reasonCodes.add('status-filter');
    const terms = criteria.lexicalTerms || criteria.terms || [];
    const relatedCompound = criteria.role==='related' && !criteria.exclusivePerson && criteria.person && terms.length
      ? bestLexical(`${criteria.person} ${terms.join(' ')}`,entry) : null;
    let score = relatedCompound?.weight || 0;
    if (relatedCompound) reasonCodes.add(relatedCompound.code);
    const relatedOrigins = entry.origins.filter(origin => origin.type !== 'own' && (personMatches(origin.name, criteria.person) || personMatches(`@${origin.username || ''}`, criteria.person)));
    if (criteria.person && !relatedCompound) {
      if (criteria.role === 'requester') {
        // Source-level evidence must be uniquely attributable to this capture.
        const request = entry.origins.length === 1 && relatedOrigins.find(origin => origin.request_excerpt);
        const ownText = entry.origins.length === 1 && entry.origins[0].type === 'own';
        const literal = ownText && entry.origins[0].request_excerpt?.match(/^\s*([\p{L}]+(?:\s+[\p{L}]+)?)\s+попросил[а]?\s/iu);
        if (request) evidence.push({ role: 'requester', name: request.name, confidence: request.sender_id ? 'known-origin' : 'unverified-name', excerpt: request.request_excerpt });
        else if (literal && personMatches(literal[1], criteria.person)) evidence.push({ role: 'requester', name: literal[1], confidence: 'explicit-text', excerpt: entry.origins[0].request_excerpt });
        else return null;
      } else if (criteria.role === 'promise') {
        const promise = entry.owned && entry.origins.length === 1 && entry.origins[0].own_promise_excerpt;
        const recipient = promise && promise.match(/(?:обещал[а]?|обещаю|обязуюсь)\s+(@?[\p{L}\p{N}_]+(?:\s+[А-ЯЁ][а-яё]+)?)/u)?.[1];
        if (!recipient || !personMatches(recipient, criteria.person)) return null;
        evidence.push({ role: 'own-promise', name: criteria.person, confidence: 'explicit-own-text', excerpt: promise });
      } else {
        for (const origin of relatedOrigins) evidence.push({ role: 'forward-author', name: origin.name, confidence: origin.sender_id ? 'known-origin' : 'unverified-name' });
        for (const name of entry.people) if (personMatches(name, criteria.person)) evidence.push({ role: 'mention', name, confidence: 'classification' });
        for (const participant of entry.participants) if (personMatches(participant.name, criteria.person) || personMatches(participant.email, criteria.person)) evidence.push({ role: 'participant', name: participant.name, participantId: participant.id, confidence: 'discussion-participant' });
        for (const person of entry.associatedPeople) if (personMatches(person.name,criteria.person) || personMatches(person.email,criteria.person)) evidence.push({role:person.association,name:person.name,participantId:person.id,confidence:'associated-person'});
        if (!criteria.exclusivePerson && !evidence.length && personMatches(`${entry.title} ${entry.raw}`, criteria.person)) evidence.push({ role:'mention',name:criteria.person,confidence:'text-only' });
        if (!evidence.length) {
          if (criteria.exclusivePerson) return null;
          const related = bestLexical(criteria.person, entry);
          if (!related) return null;
          score += related.weight; reasonCodes.add(related.code);
          evidence.push({ role:'mention',name:criteria.person,confidence:'lexical-affinity' });
        }
      }
    } else if (criteria.role === 'promise') {
      const promise = entry.owned && entry.origins.length === 1 && entry.origins[0].own_promise_excerpt;
      if (!promise) return null;
      evidence.push({ role: 'own-promise', confidence: 'explicit-own-text', excerpt: promise });
    }
    if (evidence.some(item => item.role === 'requester' || item.role === 'own-promise')) { score += 100; reasonCodes.add('proven-role'); }
    else if (criteria.person && !score) { score += 90; reasonCodes.add('person-form'); }
    const compound = !relatedCompound && terms.length > 1 ? bestLexical(terms.join(' '), entry) : null;
    if (compound) { score += compound.weight; reasonCodes.add(compound.code); }
    else for (const term of relatedCompound ? [] : terms) {
      let hit = bestLexical(term, entry);
      if (!hit) {
        for (const concept of concepts.get(stem(term)) || []) {
          const alternative = bestLexical(concept, entry);
          if (alternative && (!hit || alternative.weight > hit.weight)) hit = { code:'concept',weight:Math.min(50,alternative.weight) };
        }
      }
      if (!hit) return null;
      score += hit.weight; reasonCodes.add(hit.code);
    }
    if (criteria.period) {
      const within = date => date && date >= criteria.period.from && date <= criteria.period.to;
      const created = dateInZone(new Date(entry.createdAt), entry.timeZone);
      const completed = entry.completedAt ? dateInZone(new Date(entry.completedAt), entry.timeZone) : null;
      const occurrenceDates = entry.occurrences.filter(item => within(dateInZone(new Date(item.completedAt), entry.timeZone)));
      const matched = criteria.basis === 'created' ? within(created) : criteria.basis === 'completed' ? within(completed) || occurrenceDates.length > 0 : criteria.basis === 'deadline' ? within(entry.deadline) : criteria.basis === 'scheduled' ? within(entry.scheduledDate) : within(created) || within(completed) || occurrenceDates.length > 0;
      if (!matched) return null;
      evidence.push({ role: 'period', basis: criteria.basis, created: within(created) ? created : null, completed: within(completed) ? completed : null, occurrences: occurrenceDates.map(item => item.date) });
      reasonCodes.add('period');
    }
    return { ...entry,evidence,reasonCodes:[...reasonCodes],completionKind:occurrenceResult ? 'occurrence' : entry.status === 'done' ? 'task' : null,matchedOccurrences:occurrenceResult ? completedOccurrences : [],score };
  }

  function bestLexical(needle, entry) {
    const fields = [ ['text',entry.title,1], ['text',entry.raw,1], ...entry.projects.map(value => ['project',value,1]),
      ...entry.people.map(value => ['person',value,0.9]), ...[...entry.participants,...entry.associatedPeople].flatMap(person => [['person',person.name,0.9],['person',person.email,0.9]]),
      ...entry.origins.flatMap(origin => [['person',origin.name,0.9],['person',origin.username ? `@${origin.username}` : '',0.9]]),
      ...entry.relations.flatMap(item => [['relation',item.title,0.2],['relation',item.text,0.2],...item.projects.map(value => ['relation',value,0.2])]) ];
    let best = null;
    for (const [field,text,multiplier] of fields) {
      const hit = lexicalMatch(needle,text,stem);
      if (!hit) continue;
      const weight = Math.round(hit.weight * multiplier);
      if (!best || weight > best.weight) best = { code:`${field}-${hit.code}`,weight };
    }
    return best;
  }

  function publicItem(entry) {
    if (!entry) return null;
    const {raw,classification,origins,people,participants,associatedPeople,projects,score,reasonCodes,owned,textTruncated,...item} = entry;
    return {...item,relations:item.relations.map(({text,projects,textTruncated,...edge})=>edge)};
  }

  function searchCore({ userId, query, now = new Date(), timeZone = 'Europe/Samara', previousCriteria = null, offset = 0, criteria: suppliedCriteria = null }) {
    if (typeof userId !== 'string' || !userId) return { items: [], matchedCount: 0, clarification: 'Подключите личный Telegram к Кизуне.' };
    const parsed = suppliedCriteria ? { criteria: suppliedCriteria } : parseTaskSearchQuery(query, { now, timeZone, previousCriteria });
    if (parsed.clarification) return { ...parsed, items: [], matchedCount: 0, limitations: [] };
    const criteria = parsed.criteria;
    const started = clock();
    if (criteria.person && (criteria.exclusivePerson || criteria.role !== 'related')) {
      const matches = new Map();
      const originChunk = db.prepare(`${accessibleCaptures} SELECT o.id,o.capture_id,o.type,o.sender_id,o.name,o.username FROM accessible a JOIN captures c ON c.id=a.id JOIN task_search_origins o ON o.capture_id=c.id WHERE c.deleted_at IS NULL AND o.type!='own' AND o.sender_id IS NOT NULL AND o.id>@cursor ORDER BY o.id LIMIT 200`);
      const participantChunk = db.prepare(`${accessibleCaptures} SELECT p.rowid cursor_id,p.capture_id,u.id,u.email,u.display_name FROM accessible a JOIN captures c ON c.id=a.id JOIN capture_people p ON p.capture_id=c.id JOIN users u ON u.id=p.user_id WHERE c.deleted_at IS NULL AND p.removed_at IS NULL AND p.rowid>@cursor ORDER BY p.rowid LIMIT 200`);
      const associationChunk=db.prepare(`${accessibleCaptures} SELECT c.id capture_id,u.id author_id,u.email author_email,u.display_name author_name,
        au.id assignee_id,au.email assignee_email,au.display_name assignee_name
        FROM accessible accessible JOIN captures c ON c.id=accessible.id JOIN users u ON u.id=c.user_id
        LEFT JOIN assignments assignment ON assignment.id=(SELECT id FROM assignments WHERE capture_id=c.id AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1)
        LEFT JOIN users au ON au.id=assignment.assignee_id
        WHERE c.deleted_at IS NULL AND c.id>@cursor ORDER BY c.id LIMIT 200`);
      for (const source of ['origin','participant','association']) {
        let cursor = source === 'participant' ? 0 : '';
        while (true) {
          if (clock() - started > maxScanMs) return { criteria, items: [], matchedCount: 0, partialCoverage: true, clarification: 'Не удалось проверить личности по всей истории. Уточните полное имя или @username и повторите поиск.', limitations: ['Проверка неоднозначности имени не завершена; результат не сформирован.'] };
          const chunk = (source==='origin' ? originChunk : source==='participant' ? participantChunk : associationChunk).all({requester:userId,cursor});
          if (!chunk.length) break;
          for (const row of chunk) {
            cursor = source==='origin' ? row.id : source==='participant' ? row.cursor_id : row.capture_id;
            if (!canSeeCapture(db,row.capture_id,userId)) continue;
            const identities=source==='origin' ? [row] : source==='participant' ? [{type:'participant',sender_id:row.id,name:displayName(row),email:row.email}]
              : ['author','assignee'].filter(role=>row[`${role}_id`]).map(role=>({type:'participant',sender_id:row[`${role}_id`],name:displayName({display_name:row[`${role}_name`],email:row[`${role}_email`]}),email:row[`${role}_email`]}));
            for (const identity of identities) if (personMatches(identity.name,criteria.person) || personMatches(`@${identity.username || ''}`,criteria.person) || personMatches(identity.email,criteria.person)) matches.set(`${identity.type}:${identity.sender_id}`,identity);
            if (matches.size > 1) return { criteria, items: [], matchedCount: 0, clarification: 'Найдено несколько людей с этим именем. Укажите полное имя, @username или почту участника.', people: [...matches.values()].map(item => ({ name: item.name, username: item.username, email: item.email })), limitations: [] };
            if (clock() - started > maxScanMs) return { criteria, items: [], matchedCount: 0, partialCoverage: true, clarification: 'Не удалось проверить личности по всей истории. Уточните полное имя или @username и повторите поиск.', limitations: ['Проверка неоднозначности имени не завершена; результат не сформирован.'] };
          }
          if (chunk.length < 200) break;
        }
      }
    }
    const pageOffset = Math.min(600, Math.max(0, Math.floor(Number(offset) || 0)));
    const size = Math.min(6, Math.max(1, pageSize));
    const kept = [];
    let matchedCount = 0, scanned = 0, partialCoverage = false, cursorDate = '\uffff', cursorId = '\uffff';
    while (true) {
      if (clock() - started > maxScanMs) { partialCoverage = true; break; }
      const chunk = scan.all({requester:userId,cursorDate,cursorId});
      if (!chunk.length) break;
      for (const row of chunk) {
        scanned += 1;
        const entry = entryOf(row, userId, timeZone);
        if (entry?.textTruncated) partialCoverage = true;
        const matched = entry && match(entry, criteria);
        if (matched) {
          matchedCount += 1;
          kept.push(matched);
          kept.sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt) || right.captureId.localeCompare(left.captureId));
          if (kept.length > pageOffset + size + 1) kept.pop();
        }
        cursorDate = row.created_at; cursorId = row.id;
        if (clock() - started > maxScanMs) { partialCoverage = true; break; }
      }
      if (partialCoverage || chunk.length < 200) break;
    }
    const limitations = ['Поиск по словам, близким формам, людям и датам; свободные перефразировки могут не найтись.'];
    if (criteria.role === 'requester' || criteria.role === 'promise') limitations.push('Роли подтверждаются явным текстом и сохранённым источником. Старые записи и смешанные пачки могут не попасть в результат.');
    if (criteria.person) limitations.push('Упоминание имени без идентификатора не подтверждает личность человека.');
    if (partialCoverage) limitations.push('Просмотрена часть истории; число совпадений неполное. Уточните период или тему.');
    const items = kept.slice(pageOffset,pageOffset+size).map(publicItem);
    return { criteria,items,matchedCount,partialCoverage,scanned,hasMore:!partialCoverage && pageOffset<600 && matchedCount>pageOffset+size,nextOffset:pageOffset+size,limitations,
      traceMatches:kept.slice(0,20).map(item=>({captureId:item.captureId,reasonCodes:item.reasonCodes,score:item.score})) };
  }

  function search(input) {
    const result = searchCore(input);
    if (typeof input.userId === 'string' && input.userId) {
      const at = input.now || new Date(), traceId = crypto.randomUUID();
      db.transaction(() => {
        cleanupEntrySearchTraces(db,input.userId,at);
        db.prepare('INSERT INTO entry_search_traces VALUES(?,?,?,?,?,?,?)').run(traceId,input.userId,String(input.query || '').slice(0,1000),result.clarification ? 'clarification' : 'results',result.matchedCount,Number(Boolean(result.partialCoverage)),at.toISOString());
        const insert = db.prepare('INSERT INTO entry_search_trace_matches VALUES(?,?,?,?,?)');
        for (const [position,item] of (result.traceMatches || []).entries()) insert.run(traceId,position,item.captureId,JSON.stringify(item.reasonCodes),item.score);
        cleanupEntrySearchTraces(db,input.userId,at);
      })();
    }
    const {traceMatches,...publicResult} = result;
    return publicResult;
  }

  function recordOrigins({ captureId, userId, messages = [], origins = null }) {
    const capture = db.prepare('SELECT id FROM captures WHERE id=? AND user_id IS ? AND deleted_at IS NULL').get(captureId, userId);
    if (!capture) return false;
    const incoming = origins || messages.map(taskSearchOriginFromMessage);
    const insert = db.prepare(`INSERT OR IGNORE INTO task_search_origins(id,capture_id,user_id,message_id,type,sender_id,name,username,source_date,source_url,request_excerpt,own_promise_excerpt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const origin of incoming) insert.run(`${captureId}:${origin.messageId || crypto.randomUUID()}`, captureId, userId, origin.messageId || null, origin.type || 'unknown', origin.senderId || null, origin.name ? String(origin.name).slice(0, 200) : null, origin.username ? String(origin.username).slice(0, 64) : null, origin.sourceDate || null, publicSourceUrl(origin.sourceUrl), origin.requestExcerpt ? String(origin.requestExcerpt).slice(0, 200) : null, origin.ownPromiseExcerpt ? String(origin.ownPromiseExcerpt).slice(0, 200) : null, new Date().toISOString());
    })();
    return true;
  }
  return { search,searchTasks:search,recordOrigins,generation,resetGeneration:generation,byId:({userId,captureId,timeZone='Europe/Samara',criteria=null})=>{
    const entry=entryOf(currentCapture.get(captureId),userId,timeZone);
    return criteria ? publicItem(entry && match(entry,criteria)) : entry;
  } };
}
