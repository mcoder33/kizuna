import crypto from 'node:crypto';
import { dateInZone, shiftDate } from './reports.js';
import { validIsoDate } from './repeat.js';
import { occurrencesOf } from './occurrences.js';
import { displayName } from './circles.js';

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
}

const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
const words = value => normalize(value).match(/[\p{L}\p{N}_@]+/gu) || [];
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

function extractPerson(query, role) {
  const lower = normalize(query);
  const pattern = role === 'requester'
    ? /(?:просьб[аы]?|попросил[а]?|просьбы\s+от)\s+(?:от\s+)?(@?[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_.-]+\.[\p{L}]{2,})?)/u
    : role === 'promise'
      ? /обещал[а]?\s+(?!(?:ему|ей|им)(?:\s|[?.!]|$))(@?[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_.-]+\.[\p{L}]{2,})?)/u
      : /(?:^|\s)(?:с|про)\s+(@?[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_.-]+\.[\p{L}]{2,})?)/u;
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
  const role = /обеща/u.test(lower) ? 'promise' : /просьб|попросил/u.test(lower) ? 'requester' : 'related';
  let person = extractPerson(original, role);
  const pronoun = /(?:^|\s)(ему|ей|им)(?:\s|[?.!]|$)/u.test(lower);
  if (!person && pronoun) person = previousCriteria?.person || null;
  const today = dateInZone(now, timeZone);
  let period = null;
  const dates = lower.match(/\d{4}-\d{2}-\d{2}/g) || [];
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
  let inherited = false;
  if (previousCriteria && (pronoun || (period && !person && !terms.length))) {
    person ||= previousCriteria.person;
    inherited = true;
  }
  const criteria = { person, role: inherited && role === 'related' ? previousCriteria.role : role, status: inherited && status === 'all' ? previousCriteria.status : status, period, basis, terms: inherited && !terms.length ? previousCriteria.terms || [] : terms, inherited };
  if (pronoun && !person) return { criteria, clarification: 'Назовите человека: кому вы обещали или с кем связаны дела?' };
  if (!original || (!person && !period && !terms.length && status === 'all' && role === 'related')) return { criteria, clarification: 'Укажите человека, тему, статус или период. Например: «дела с Петей».' };
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
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const boundedText = value => String(value || '').slice(0, 16000);

export function createTaskSearchService(db, { maxScanMs = 2000, clock = () => performance.now(), pageSize = 6 } = {}) {
  initializeTaskSearchSchema(db);
  const generation = userId => db.prepare('SELECT generation FROM task_search_generations WHERE user_key=?').get(userId ?? '__orphan__')?.generation || 0;
  const ownerCapture = db.prepare("SELECT c.*, i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.user_id IS ? AND c.id=? AND c.deleted_at IS NULL AND c.subtask=0");
  const originsFor = db.prepare('SELECT * FROM task_search_origins WHERE user_id IS ? AND capture_id=? ORDER BY created_at,id');
  const projectionsFor = db.prepare(`SELECT p.id, (SELECT e.event_type FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type IN ('completed','completion_undone') ORDER BY e.rowid DESC LIMIT 1) completion,
    (SELECT e.occurred_at FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type IN ('completed','completion_undone') ORDER BY e.rowid DESC LIMIT 1) completed_at
    FROM projections p WHERE p.capture_id=? AND p.status='active' AND p.projection_type IN ('task','meeting_event')`);
  const participantsFor = db.prepare('SELECT u.id,u.email,u.display_name FROM capture_people p JOIN users u ON u.id=p.user_id WHERE p.capture_id=? AND p.removed_at IS NULL');
  const scan = db.prepare(`SELECT c.id,c.raw,c.created_at,c.occurred_at,c.parent_capture_id,i.classification_json
    FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    WHERE c.user_id IS ? AND c.deleted_at IS NULL AND c.subtask=0 AND (c.created_at < ? OR (c.created_at=? AND c.id<?))
    ORDER BY c.created_at DESC,c.id DESC LIMIT 200`);

  function entryOf(row, userId, timeZone) {
    if (!row) return null;
    const classification = parseJson(row.classification_json);
    if (classification.primaryType !== 'task' || (classification.completed !== true && (classification.proposedActions || []).some(action => action.type === 'task' && typeof action.title === 'string'))) return null;
    const projections = projectionsFor.all(row.id);
    const closed = projections.length > 0 && projections.every(item => item.completion === 'completed');
    const done = closed || (!projections.length && classification.completed === true);
    const completedAt = closed ? projections.map(item => item.completed_at).filter(Boolean).sort().at(-1) || null : done ? row.occurred_at : null;
    const origins = originsFor.all(userId, row.id);
    const schedule = classification.entities?.schedule || null;
    const occurrences = schedule?.repeat ? occurrencesOf(db, row.id) : [];
    return { captureId: row.id, title: classification.summary || row.raw.slice(0, 160), raw: boundedText(row.raw), classification, status: done ? 'done' : 'open', createdAt: row.created_at, completedAt, scheduledDate: schedule?.date || null, deadline: schedule?.date && !schedule.defaulted && !schedule.repeat ? schedule.date : null, occurrences, repeat: Boolean(schedule?.repeat), origins, people: classification.entities?.people || [], participants: participantsFor.all(row.id).map(item => ({ id: item.id, name: displayName(item), email: item.email })), evidence: [], sourceUrl: origins.length === 1 ? publicSourceUrl(origins[0].source_url) : null, timeZone };
  }

  function match(entry, criteria) {
    const completedOccurrences = entry.occurrences.filter(item => !criteria.period || (dateInZone(new Date(item.completedAt), entry.timeZone) >= criteria.period.from && dateInZone(new Date(item.completedAt), entry.timeZone) <= criteria.period.to));
    const occurrenceResult = criteria.status === 'done' && entry.status === 'open' && completedOccurrences.length > 0;
    if (criteria.status !== 'all' && entry.status !== criteria.status && !occurrenceResult) return null;
    const evidence = [];
    const relatedOrigins = entry.origins.filter(origin => origin.type !== 'own' && (personMatches(origin.name, criteria.person) || personMatches(`@${origin.username || ''}`, criteria.person)));
    if (criteria.person) {
      if (criteria.role === 'requester') {
        // Source-level evidence must be uniquely attributable to this capture.
        const request = entry.origins.length === 1 && relatedOrigins.find(origin => origin.request_excerpt);
        const ownText = entry.origins.length === 1 && entry.origins[0].type === 'own';
        const literal = ownText && entry.origins[0].request_excerpt?.match(/^\s*([\p{L}]+(?:\s+[\p{L}]+)?)\s+попросил[а]?\s/iu);
        if (request) evidence.push({ role: 'requester', name: request.name, confidence: request.sender_id ? 'known-origin' : 'unverified-name', excerpt: request.request_excerpt });
        else if (literal && personMatches(literal[1], criteria.person)) evidence.push({ role: 'requester', name: literal[1], confidence: 'explicit-text', excerpt: entry.origins[0].request_excerpt });
        else return null;
      } else if (criteria.role === 'promise') {
        const promise = entry.origins.length === 1 && entry.origins[0].own_promise_excerpt;
        const recipient = promise && promise.match(/(?:обещал[а]?|обещаю|обязуюсь)\s+(@?[\p{L}\p{N}_]+(?:\s+[А-ЯЁ][а-яё]+)?)/u)?.[1];
        if (!recipient || !personMatches(recipient, criteria.person)) return null;
        evidence.push({ role: 'own-promise', name: criteria.person, confidence: 'explicit-own-text', excerpt: promise });
      } else {
        for (const origin of relatedOrigins) evidence.push({ role: 'forward-author', name: origin.name, confidence: origin.sender_id ? 'known-origin' : 'unverified-name' });
        for (const name of entry.people) if (personMatches(name, criteria.person)) evidence.push({ role: 'mention', name, confidence: 'classification' });
        for (const participant of entry.participants) if (personMatches(participant.name, criteria.person) || personMatches(participant.email, criteria.person)) evidence.push({ role: 'participant', name: participant.name, participantId: participant.id, confidence: 'discussion-participant' });
        if (!evidence.length && personMatches(entry.raw, criteria.person)) evidence.push({ role: 'mention', name: criteria.person, confidence: 'text-only' });
        if (!evidence.length) return null;
      }
    } else if (criteria.role === 'promise') {
      const promise = entry.origins.length === 1 && entry.origins[0].own_promise_excerpt;
      if (!promise) return null;
      evidence.push({ role: 'own-promise', confidence: 'explicit-own-text', excerpt: promise });
    }
    const textTokens = new Set(words(`${entry.title} ${entry.raw}`).map(stem));
    for (const term of criteria.terms) if (!(concepts.get(term) || [term]).some(candidate => textTokens.has(candidate))) return null;
    if (criteria.period) {
      const within = date => date && date >= criteria.period.from && date <= criteria.period.to;
      const created = dateInZone(new Date(entry.createdAt), entry.timeZone);
      const completed = entry.completedAt ? dateInZone(new Date(entry.completedAt), entry.timeZone) : null;
      const occurrenceDates = entry.occurrences.filter(item => within(dateInZone(new Date(item.completedAt), entry.timeZone)));
      const matched = criteria.basis === 'created' ? within(created) : criteria.basis === 'completed' ? within(completed) || occurrenceDates.length > 0 : criteria.basis === 'deadline' ? within(entry.deadline) : criteria.basis === 'scheduled' ? within(entry.scheduledDate) : within(created) || within(completed) || occurrenceDates.length > 0;
      if (!matched) return null;
      evidence.push({ role: 'period', basis: criteria.basis, created: within(created) ? created : null, completed: within(completed) ? completed : null, occurrences: occurrenceDates.map(item => item.date) });
    }
    return { ...entry, evidence, completionKind: occurrenceResult ? 'occurrence' : entry.status === 'done' ? 'task' : null, matchedOccurrences: occurrenceResult ? completedOccurrences : [], score: criteria.terms.length * 10 + evidence.length };
  }

  function search({ userId, query, now = new Date(), timeZone = 'Europe/Samara', previousCriteria = null, offset = 0, criteria: suppliedCriteria = null }) {
    if (typeof userId !== 'string' || !userId) return { items: [], matchedCount: 0, clarification: 'Подключите личный Telegram к Кизуне.' };
    const parsed = suppliedCriteria ? { criteria: suppliedCriteria } : parseTaskSearchQuery(query, { now, timeZone, previousCriteria });
    if (parsed.clarification) return { ...parsed, items: [], matchedCount: 0, limitations: [] };
    const criteria = parsed.criteria;
    const started = clock();
    if (criteria.person) {
      const matches = new Map();
      const originChunk = db.prepare(`SELECT o.id,o.type,o.sender_id,o.name,o.username FROM task_search_origins o JOIN captures c ON c.id=o.capture_id WHERE o.user_id=? AND c.user_id=? AND c.deleted_at IS NULL AND o.type!='own' AND o.sender_id IS NOT NULL AND o.id>? ORDER BY o.id LIMIT 200`);
      const participantChunk = db.prepare(`SELECT p.rowid cursor_id,u.id,u.email,u.display_name FROM capture_people p JOIN users u ON u.id=p.user_id JOIN captures c ON c.id=p.capture_id WHERE c.user_id=? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.rowid>? ORDER BY p.rowid LIMIT 200`);
      for (const source of ['origin', 'participant']) {
        let cursor = source === 'origin' ? '' : 0;
        while (true) {
          if (clock() - started > maxScanMs) return { criteria, items: [], matchedCount: 0, partialCoverage: true, clarification: 'Не удалось проверить личности по всей истории. Уточните полное имя или @username и повторите поиск.', limitations: ['Проверка неоднозначности имени не завершена; результат не сформирован.'] };
          const chunk = source === 'origin' ? originChunk.all(userId, userId, cursor) : participantChunk.all(userId, cursor);
          if (!chunk.length) break;
          for (const row of chunk) {
            const identity = source === 'origin' ? row : { type: 'participant', sender_id: row.id, name: displayName(row), email: row.email };
            if (personMatches(identity.name, criteria.person) || personMatches(`@${identity.username || ''}`, criteria.person) || personMatches(identity.email, criteria.person)) matches.set(`${identity.type}:${identity.sender_id}`, identity);
            if (matches.size > 1) return { criteria, items: [], matchedCount: 0, clarification: 'Найдено несколько людей с этим именем. Укажите полное имя, @username или почту участника.', people: [...matches.values()].map(item => ({ name: item.name, username: item.username, email: item.email })), limitations: [] };
            cursor = source === 'origin' ? row.id : row.cursor_id;
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
      const chunk = scan.all(userId, cursorDate, cursorDate, cursorId);
      if (!chunk.length) break;
      for (const row of chunk) {
        scanned += 1;
        const entry = entryOf(row, userId, timeZone);
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
    const items = kept.slice(pageOffset, pageOffset + size).map(({ raw, classification, origins, people, participants, score, ...item }) => item);
    return { criteria, items, matchedCount, partialCoverage, scanned, hasMore: !partialCoverage && pageOffset < 600 && matchedCount > pageOffset + size, nextOffset: pageOffset + size, limitations };
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
  return { search, searchTasks: search, recordOrigins, generation, resetGeneration: generation, byId: ({ userId, captureId, timeZone = 'Europe/Samara' }) => entryOf(ownerCapture.get(userId, captureId), userId, timeZone) };
}
