import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, createUser, completeProjection, undoProjectionCompletion, exportLedger, resetLedger } from '../server/db.js';
import { createTaskSearchService, parseTaskSearchQuery, taskSearchOriginFromMessage } from '../server/task-search.js';

const fixedNow = new Date('2026-10-03T12:00:00Z');
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-search-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const userId = createUser(db, { email: 'search@kizuna.test', passwordHash: 'test', status: 'active' }).id;
  const otherId = createUser(db, { email: 'other@kizuna.test', passwordHash: 'test', status: 'active' }).id;
  const service = createTaskSearchService(db, options);
  const add = ({ raw = 'Подготовить отчет', title = raw, owner = userId, createdAt = '2026-09-20T10:00:00Z', schedule = null, people = [], completed = false, type = 'task', subtask = false, proposedActions = [], projection = true } = {}) => {
    const id = crypto.randomUUID(), interpretationId = crypto.randomUUID(), projectionId = crypto.randomUUID();
    db.prepare('INSERT INTO captures(id,raw,created_at,occurred_at,user_id,subtask) VALUES(?,?,?,?,?,?)').run(id, raw, createdAt, createdAt, owner, Number(subtask));
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretationId, id, 1, 'active', 'manual', null, JSON.stringify({ primaryType: type, summary: title, completed, proposedActions, entities: { people, schedule } }), '{}', createdAt);
    if (projection) db.prepare('INSERT INTO projections(id,capture_id,interpretation_id,projection_type,payload_json,status,undo_group_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(projectionId, id, interpretationId, 'task', '{}', 'active', crypto.randomUUID(), createdAt);
    return { id, projectionId };
  };
  const search = query => service.search({ userId, query, now: fixedNow, timeZone: 'Europe/Samara' });
  const forward = (name, id = 10, text = 'Пришли отчет, пожалуйста', username = null) => ({ message_id: Math.floor(Math.random() * 1e8), text, from: { id: 1 }, forward_origin: { type: 'user', sender_user: { id, first_name: name, username }, date: 1780000000 } });
  return { db, userId, otherId, service, add, search, forward };
}

test('flagship queries plan role, person, open status and previous calendar week in zone', () => {
  const plan = parseTaskSearchQuery('Какие просьбы Саши я ещё не сделал?', { now: fixedNow });
  assert.deepEqual({ person: plan.criteria.person, status: plan.criteria.status, role: plan.criteria.role, terms: plan.criteria.terms }, { person: 'Саши', status: 'open', role: 'requester', terms: [] });
  const related = parseTaskSearchQuery('Какие у меня вообще дела были связаны с Петей?', { now: fixedNow });
  assert.equal(related.criteria.person, 'Петей'); assert.deepEqual(related.criteria.terms, []);
  assert.deepEqual(parseTaskSearchQuery('За прошлую неделю', { now: fixedNow }).criteria.period, { from: '2026-09-21', to: '2026-09-27' });
  assert.ok(parseTaskSearchQuery('Что я ему обещал?', { now: fixedNow }).clarification);
  const inherited = parseTaskSearchQuery('Что я ему обещал?', { now: fixedNow, previousCriteria: related.criteria });
  assert.equal(inherited.criteria.person, 'Петей'); assert.equal(inherited.criteria.role, 'promise');
});

test('invalid dates and unsupported periods clarify, never broaden search silently', () => {
  for (const query of ['2026-02-30', '2026-13-01', '2026-10-03 — 2026-10-01', 'за прошлый месяц', 'за 12.13']) assert.ok(parseTaskSearchQuery(query).clarification, query);
  const zone = { now: new Date('2026-09-27T23:30:00Z'), timeZone: 'Europe/Samara' };
  assert.deepEqual(parseTaskSearchQuery('за прошлую неделю', zone).criteria.period, { from: '2026-09-21', to: '2026-09-27' });
});

test('requester requires source request evidence; mention and passive forward are excluded', t => {
  const f = fixture(t);
  const requested = f.add(); f.service.recordOrigins({ captureId: requested.id, userId: f.userId, messages: [f.forward('Саша')] });
  const passive = f.add(); f.service.recordOrigins({ captureId: passive.id, userId: f.userId, messages: [f.forward('Саша', 10, 'Отчет готов')] });
  f.add({ people: ['Саша'], raw: 'Обсудить отчет с Сашей' });
  const response = f.search('Какие просьбы Саши я ещё не сделал?');
  assert.deepEqual(response.items.map(item => item.captureId), [requested.id]);
  assert.equal(response.items[0].evidence[0].role, 'requester');
  assert.match(response.items[0].evidence[0].excerpt, /пожалуйста/);
  assert.equal(f.search('дела с Сашей').matchedCount, 3);
  assert.equal(f.search('дела с Александром').matchedCount, 0);
});

test('same-name identities clarify; full name and username resolve without alias invention', t => {
  const f = fixture(t);
  for (const [name, id, username] of [['Саша Иванов', 10, 'sasha_one'], ['Саша Петров', 11, 'sasha_two']]) {
    const row = f.add(); f.service.recordOrigins({ captureId: row.id, userId: f.userId, messages: [f.forward(name, id, undefined, username)] });
  }
  assert.ok(f.search('дела с Сашей').clarification);
  assert.equal(f.search('дела с Сашей Иванов').matchedCount, 1);
  assert.equal(f.search('дела с @sasha_two').matchedCount, 1);
});

test('own explicit promises are distinct from forwarded promises and mixed batches', t => {
  const f = fixture(t);
  const own = f.add({ raw: 'Я обещал Пете подготовить отчет' });
  f.service.recordOrigins({ captureId: own.id, userId: f.userId, messages: [{ message_id: 1, text: 'Я обещал Пете подготовить отчет', from: { id: 1, first_name: 'Хозяин' } }] });
  const forwarded = f.add({ raw: 'Я обещал Пете подготовить отчет' });
  f.service.recordOrigins({ captureId: forwarded.id, userId: f.userId, messages: [f.forward('Петя', 20, 'Я обещал Пете подготовить отчет')] });
  const mixed = f.add(); f.service.recordOrigins({ captureId: mixed.id, userId: f.userId, messages: [f.forward('Петя', 20), f.forward('Саша', 10)] });
  const result = f.search('Что я обещал Пете?');
  assert.deepEqual(result.items.map(item => item.captureId), [own.id]);
  assert.equal(f.search('просьбы Пети').matchedCount, 0);
  const unrelatedRecipient = f.add({ raw: 'Я обещал Маше позвонить Пете' });
  f.service.recordOrigins({ captureId: unrelatedRecipient.id, userId: f.userId, messages: [{ message_id: 5, text: 'Я обещал Маше позвонить Пете', from: { id: 1 } }] });
  assert.deepEqual(f.search('Что я обещал Пете?').items.map(item => item.captureId), [own.id]);
});

test('completion undo and repeating occurrences preserve established task closure semantics', t => {
  const f = fixture(t), row = f.add();
  assert.equal(f.service.byId({ userId: f.userId, captureId: row.id }).status, 'open');
  completeProjection(f.db, row.projectionId);
  assert.equal(f.search('выполненные задачи').matchedCount, 1);
  undoProjectionCompletion(f.db, row.projectionId);
  assert.equal(f.search('выполненные задачи').matchedCount, 0);
  const repeated = f.add({ raw: 'Подготовить документы', schedule: { date: '2026-09-21', repeat: { freq: 'daily', interval: 1 } } });
  f.db.prepare('INSERT INTO ledger_events(id,event_type,capture_id,projection_id,occurred_at,created_at,payload) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'occurrence_completed', repeated.id, repeated.projectionId, '2026-09-23T09:00:00Z', '2026-09-23T09:00:00Z', JSON.stringify({ date: '2026-09-23' }));
  const result = f.search('документы за прошлую неделю');
  assert.equal(result.items[0].status, 'open'); assert.equal(result.items[0].occurrences[0].date, '2026-09-23');
  const doneResult = f.search('выполненные документы за прошлую неделю');
  assert.equal(doneResult.items[0].status, 'open'); assert.equal(doneResult.items[0].completionKind, 'occurrence');
  assert.equal(doneResult.items[0].matchedOccurrences[0].date, '2026-09-23');
  f.db.prepare('INSERT INTO ledger_events(id,event_type,capture_id,projection_id,occurred_at,created_at,payload) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'occurrence_undone', repeated.id, repeated.projectionId, '2026-09-24T09:00:00Z', '2026-09-24T09:00:00Z', JSON.stringify({ date: '2026-09-23' }));
  assert.equal(f.search('выполненные документы за прошлую неделю').matchedCount, 0);
});

test('period means added or completed, with explicit dates and no implicit deadline', t => {
  const f = fixture(t);
  const added = f.add({ raw: 'Документы', createdAt: '2026-09-27T22:00:00Z' }); // Monday locally, outside last week.
  const completed = f.add({ raw: 'Документы', createdAt: '2026-08-01T00:00:00Z' });
  f.db.prepare('INSERT INTO ledger_events(id,event_type,capture_id,projection_id,occurred_at,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), 'completed', completed.id, completed.projectionId, '2026-09-22T12:00:00Z', '2026-09-22T12:00:00Z');
  f.add({ raw: 'Документы', schedule: { date: '2026-09-22', defaulted: true } });
  f.add({ raw: 'Документы', schedule: { date: '2026-09-22', defaulted: false } });
  assert.deepEqual(f.search('документы за прошлую неделю').items.map(item => item.captureId), [completed.id]);
  assert.equal(f.search('документы срок 2026-09-22').matchedCount, 1);
  assert.equal(f.search('документы запланированные 2026-09-22').matchedCount, 2);
  assert.equal(f.service.byId({ userId: f.userId, captureId: added.id }).createdAt, '2026-09-27T22:00:00Z');
});

test('malformed date-like tokens clarify instead of removing or truncating the period', t => {
  const f = fixture(t);
  const onDate = f.add({ raw: 'Документы', createdAt: '2026-10-03T12:00:00Z' });
  f.add({ raw: 'Документы', createdAt: '2026-09-01T12:00:00Z' });
  for (const query of ['документы за 2026-2-30', 'документы за 2026-10-030', 'документы за 2026-10-03x']) {
    const response = f.search(query);
    assert.match(response.clarification || '', /существующую дату.*YYYY-MM-DD/, query);
    assert.deepEqual(response.items, [], query);
    assert.equal(response.matchedCount, 0, query);
    assert.equal(response.criteria, undefined, query);
  }
  assert.deepEqual(f.search('документы за (2026-10-03)').items.map(item => item.captureId), [onDate.id]);
  assert.deepEqual(f.search('документы за 2026-10-01 — 2026-10-03').items.map(item => item.captureId), [onDate.id]);
});

test('history beyond 500 and concept morphology are searched without cross-user or archive leakage', t => {
  const f = fixture(t);
  const old = f.add({ raw: 'Отправить бумаги', createdAt: '2020-01-01T00:00:00Z' });
  f.db.transaction(() => { for (let i = 0; i < 550; i++) f.add({ raw: 'Купить молоко' }); })();
  f.add({ raw: 'Отправить бумаги', owner: f.otherId });
  f.add({ raw: 'Отправить бумаги', subtask: true });
  f.add({ raw: 'Отправить бумаги', type: 'note' });
  f.add({ raw: 'Отправить бумаги', proposedActions: [{ type: 'task', title: 'Отправить бумаги' }], projection: false });
  const result = f.search('отправить документы');
  assert.equal(result.partialCoverage, false); assert.deepEqual(result.items.map(item => item.captureId), [old.id]);
  assert.equal(f.service.byId({ userId: f.otherId, captureId: old.id }), null);
  assert.equal(f.search('неизвестная тема').matchedCount, 0);
});

test('bounded pages and incomplete scan are explicit, not false zero/full counts', t => {
  const f = fixture(t);
  for (let i = 0; i < 15; i++) f.add();
  const first = f.search('отчет'); assert.equal(first.items.length, 6); assert.equal(first.matchedCount, 15); assert.equal(first.hasMore, true);
  const second = f.service.search({ userId: f.userId, query: 'отчет', offset: first.nextOffset });
  assert.equal(second.items.length, 6); assert.equal(first.items.some(item => second.items.some(next => next.captureId === item.captureId)), false);
  let tick = 0;
  const partial = createTaskSearchService(f.db, { maxScanMs: 1, clock: () => ++tick }).search({ userId: f.userId, query: 'отчет' });
  assert.equal(partial.partialCoverage, true); assert.equal(partial.hasMore, false); assert.ok(partial.limitations.some(value => /часть истории/.test(value)));
});

test('source links only come from public channel forwards and origin capture respects ownership', t => {
  const f = fixture(t), row = f.add();
  assert.equal(f.service.recordOrigins({ userId: f.otherId, captureId: row.id, messages: [f.forward('Петя')] }), false);
  assert.equal(taskSearchOriginFromMessage(f.forward('Петя')).sourceUrl, null);
  const channel = { message_id: 3, text: 'Проверь отчет https://evil.example', forward_origin: { type: 'channel', chat: { id: -10, username: 'public_channel', title: 'Канал' }, message_id: 42, date: 1780000000 } };
  f.service.recordOrigins({ userId: f.userId, captureId: row.id, messages: [channel] });
  assert.equal(f.search('отчет').items[0].sourceUrl, 'https://t.me/public_channel/42');
});

test('origins export/reset are scoped; replay receipts survive reset and generations invalidate state', t => {
  const f = fixture(t), own = f.add(), other = f.add({ owner: f.otherId });
  f.service.recordOrigins({ userId: f.userId, captureId: own.id, messages: [f.forward('Саша')] });
  f.service.recordOrigins({ userId: f.otherId, captureId: other.id, messages: [f.forward('Петя')] });
  f.db.prepare('INSERT INTO task_search_receipts VALUES(?,?,?,?,?)').run('chat:1', f.userId, 'binding', 'query', fixedNow.toISOString());
  assert.equal(exportLedger(f.db, f.userId).taskSearchOrigins.length, 1);
  assert.equal(f.service.generation(f.userId), 0);
  resetLedger(f.db, f.userId);
  assert.equal(f.service.generation(f.userId), 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_origins').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_receipts').get().n, 1);
  assert.equal(f.service.search({ userId: f.otherId, query: 'дела с Петей' }).matchedCount, 1);
});

test('case, question marks and recognized status words preserve actual filtered results', t => {
  const f = fixture(t);
  const requested = f.add();
  f.service.recordOrigins({ captureId: requested.id, userId: f.userId, messages: [f.forward('Саша')] });
  f.add({ raw: 'Обсудить с Сашей', people: ['Саша'] });
  assert.deepEqual(f.search('Просьбы Саши').items.map(item => item.captureId), [requested.id]);
  assert.equal(f.search('Не выполнил?').matchedCount, 2);
  const today = f.add({ raw: 'Подготовить документы', people: ['Петя'], createdAt: '2026-10-03T12:00:00Z' });
  f.add({ raw: 'Подготовить документы', people: ['Петя'], createdAt: '2026-10-02T12:00:00Z' });
  assert.deepEqual(f.search('Задачи с Петей сегодня?').items.map(item => item.captureId), [today.id]);
  f.db.prepare('INSERT INTO ledger_events(id,event_type,capture_id,projection_id,occurred_at,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), 'completed', requested.id, requested.projectionId, '2026-10-02T12:00:00Z', '2026-10-02T12:00:00Z');
  assert.deepEqual(f.search('Выполненные задачи вчера?').items.map(item => item.captureId), [requested.id]);
});

test('quoted or reported speech does not establish owner promise or source-author request', t => {
  const f = fixture(t);
  for (const [index, text, entities] of [
    [1, 'Саша написал: я обещал Пете подготовить отчет', []],
    [2, '«Я обещал Пете подготовить отчет»', []],
    [3, 'Я обещал Пете подготовить отчет', [{ type: 'blockquote', offset: 0, length: 35 }]],
  ]) {
    const row = f.add({ raw: text });
    f.service.recordOrigins({ captureId: row.id, userId: f.userId, messages: [{ message_id: index, text, entities, from: { id: 1 } }] });
  }
  assert.equal(f.search('Что я обещал Пете?').matchedCount, 0);
  const request = f.add({ raw: 'Петя попросил: пришли отчет, пожалуйста' });
  f.service.recordOrigins({ captureId: request.id, userId: f.userId, messages: [f.forward('Саша', 10, 'Петя попросил: пришли отчет, пожалуйста')] });
  assert.equal(f.search('Просьбы Саши').matchedCount, 0);
  const related = f.search('дела с Сашей').items.find(item => item.captureId === request.id);
  assert.equal(related.evidence[0].role, 'forward-author');
});

test('participants use display names and identity evidence; duplicate known people clarify', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE users SET display_name=? WHERE id=?').run('Петя', f.otherId);
  const first = f.add();
  f.db.prepare('INSERT INTO capture_people(capture_id,user_id,added_at) VALUES(?,?,?)').run(first.id, f.otherId, fixedNow.toISOString());
  const result = f.search('дела с Петей');
  assert.equal(result.matchedCount, 1);
  assert.equal(result.items[0].evidence[0].role, 'participant');
  assert.equal(result.items[0].evidence[0].participantId, f.otherId);
  const third = createUser(f.db, { email: 'guest@test.example', passwordHash: 'test', status: 'active' }).id;
  f.db.prepare('UPDATE users SET display_name=? WHERE id=?').run('Петя', third);
  const second = f.add();
  f.db.prepare('INSERT INTO capture_people(capture_id,user_id,added_at) VALUES(?,?,?)').run(second.id, third, fixedNow.toISOString());
  assert.ok(f.search('дела с Петей').clarification);
  assert.deepEqual(f.search('дела с guest@test.example').items.map(item => item.captureId), [second.id]);
  f.db.prepare('UPDATE capture_people SET removed_at=? WHERE capture_id=? AND user_id=?').run(fixedNow.toISOString(), second.id, third);
  assert.equal(f.search('дела с Петей').matchedCount, 1);
});

test('identity checking is inside the scan budget and stops with explicit incomplete coverage', t => {
  const f = fixture(t), row = f.add();
  f.db.transaction(() => {
    for (let i = 0; i < 1000; i++) f.service.recordOrigins({ captureId: row.id, userId: f.userId, messages: [{ ...f.forward('Саша', i + 100), message_id: i + 1 }] });
  })();
  let ticks = 0;
  const service = createTaskSearchService(f.db, { maxScanMs: 1, clock: () => ++ticks });
  const result = service.search({ userId: f.userId, query: 'дела с Сашей' });
  assert.equal(result.partialCoverage, true);
  assert.ok(result.clarification); assert.deepEqual(result.items, []);
  assert.ok(ticks <= 4, `budget stopped after ${ticks} checks`);
  const ambiguous = f.search('дела с Сашей');
  assert.ok(ambiguous.clarification); assert.equal(ambiguous.people.length, 2);
});

test('quotation covering statement start after whitespace excludes promise and request evidence', t => {
  const f = fixture(t);
  const ownText = '\nЯ обещал Пете подготовить отчет';
  const ownMessage = { message_id: 100, text: ownText, from: { id: 1 }, entities: [{ type: 'blockquote', offset: 1, length: ownText.length - 1 }] };
  assert.equal(taskSearchOriginFromMessage(ownMessage).ownPromiseExcerpt, null);
  const own = f.add({ raw: ownText });
  f.service.recordOrigins({ captureId: own.id, userId: f.userId, messages: [ownMessage] });
  assert.equal(f.search('Что я обещал Пете?').matchedCount, 0);
  const requestText = ' Пришли отчет, пожалуйста';
  const forwardedMessage = { ...f.forward('Саша', 10, requestText), entities: [{ type: 'expandable_blockquote', offset: 1, length: requestText.length - 1 }] };
  assert.equal(taskSearchOriginFromMessage(forwardedMessage).requestExcerpt, null);
  const request = f.add({ raw: requestText });
  f.service.recordOrigins({ captureId: request.id, userId: f.userId, messages: [forwardedMessage] });
  assert.equal(f.search('Просьбы Саши').matchedCount, 0);
  assert.equal(f.search('дела с Сашей').matchedCount, 1);
});

test('own named requester requires saved nonquoted statement evidence, not arbitrary raw text', t => {
  const f = fixture(t), text = 'Саша попросил прислать отчет';
  const own = f.add({ raw: text });
  f.service.recordOrigins({ captureId: own.id, userId: f.userId, messages: [{ message_id: 1, text, from: { id: 1 } }] });
  const quoted = f.add({ raw: text });
  f.service.recordOrigins({ captureId: quoted.id, userId: f.userId, messages: [{ message_id: 2, text, from: { id: 1 }, entities: [{ type: 'blockquote', offset: 0, length: text.length }] }] });
  const reported = f.add({ raw: `Петя написал: ${text}` });
  f.service.recordOrigins({ captureId: reported.id, userId: f.userId, messages: [{ message_id: 3, text: `Петя написал: ${text}`, from: { id: 1 } }] });
  assert.deepEqual(f.search('Просьбы Саши').items.map(item => item.captureId), [own.id]);
});
