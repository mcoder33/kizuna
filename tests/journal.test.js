import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDatabase, createLedger, enqueueCaptureJob } from '../server/db.js';
import { normalizeClassification } from '../server/classifier.js';
import { journalOverview, listJournal, vocabulary } from '../server/journal.js';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

const NOW = new Date('2026-09-15T09:00:00Z');
const at = () => NOW;

function database() {
  return openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-journal-')), 'test.sqlite'));
}

// Запись с готовым разбором: карта журнала читает активную интерпретацию, а не
// очередь, поэтому заводим её сразу.
function entry(db, raw, { userId = null, type = 'task', projects = [], people = [], when = null, tags = [], priority, completed = false } = {}) {
  const classification = normalizeClassification(
    { primaryType: type, entities: { projects, people, when: when ? { time: null, ...when } : null, followUp: null }, additionalTypes: [], summary: raw, proposedActions: [], completed, ambiguity: null },
    raw, NOW, 'model',
  );
  // Разбор теперь всегда даёт туду, но в базе лежат и старые записи других типов:
  // карта журнала обязана читать и их.
  classification.primaryType = type;
  if (tags.length) classification.tags = tags;
  if (priority) classification.priority = priority;
  return createLedger(db, { userId, raw, classification, provider: 'manual' }).captureId;
}

function seeded() {
  const db = database();
  entry(db, 'Созвон по Hub с Даниилом', { type: 'meeting_event', projects: ['Hub'], people: ['Даниил'], when: { date: '2026-09-15', time: '11:00' } });
  entry(db, 'Допинать бот-детектор по Hub', { projects: ['Hub'], when: { date: '2026-09-10' }, tags: ['релиз'], priority: 'high' });
  entry(db, 'Написать письмо в Hub завтра', { projects: ['Hub'], when: { date: '2026-09-16' } });
  entry(db, 'Релизил TCAM вчера', { type: 'outcome_decision', projects: ['TCAM'], completed: true });
  entry(db, 'Стоит ли брать CP в работу', { type: 'idea_question', projects: ['CP'] });
  return db;
}

test('карта журнала считает открытое, просроченное и проекты', () => {
  const db = seeded();
  const map = journalOverview(db, { now: NOW });
  assert.equal(map.today, '2026-09-15');
  assert.equal(map.totals.entries, 5);
  assert.equal(map.totals.open, 3, 'встреча сегодня и два дела');
  assert.equal(map.totals.done, 1);
  assert.equal(map.totals.overdue, 1);
  assert.deepEqual(map.overdue.map(item => item.daysLate), [5]);
  const hub = map.projects.find(project => project.name === 'Hub');
  assert.equal(hub.count, 3);
  assert.equal(hub.open, 3);
  assert.equal(hub.overdue, 1);
  assert.equal(hub.stalled, false);
  assert.deepEqual(map.people.map(person => person.name), ['Даниил']);
  assert.deepEqual(map.tags.map(tag => tag.name), ['релиз']);
  assert.equal(map.flags.high, 1);
  assert.equal(map.flags.questions, 1);
  assert.equal(map.horizon.today.length, 1);
  assert.equal(map.horizon.tomorrow, 1);
  assert.equal(map.horizon.week, 2, 'сегодняшняя встреча и завтрашнее письмо');
});

test('записи на разборе видны в карте, а не пропадают из счёта', () => {
  const db = seeded();
  enqueueCaptureJob(db, { userId: null, raw: 'Только что продиктовал', selectedProvider: 'fallback' });
  const map = journalOverview(db, { now: NOW });
  assert.equal(map.totals.unparsed, 1);
  assert.equal(map.totals.entries, 6);
});

test('тихий проект отмечается днями молчания', () => {
  const db = database();
  const old = new Date('2026-08-01T09:00:00Z').toISOString();
  for (const raw of ['Монетизация: первый заход', 'Монетизация: второй заход']) {
    const id = entry(db, raw, { projects: ['Монетизация'] });
    db.prepare('UPDATE captures SET created_at=? WHERE id=?').run(old, id);
  }
  const project = journalOverview(db, { now: NOW }).projects.find(item => item.name === 'Монетизация');
  assert.equal(project.quietDays, 45);
  assert.equal(project.stalled, true);
});

test('выборка складывает признаки и знает свои типы', () => {
  const db = seeded();
  assert.equal(listJournal(db, { now: NOW, project: 'Hub', status: 'open' }).total, 3);
  assert.equal(listJournal(db, { now: NOW, project: 'Hub', type: 'meeting' }).total, 1);
  assert.equal(listJournal(db, { now: NOW, status: 'overdue' }).items[0].title, 'Допинать бот-детектор по Hub');
  assert.equal(listJournal(db, { now: NOW, status: 'done' }).total, 1);
  assert.equal(listJournal(db, { now: NOW, tag: 'релиз' }).total, 1);
  assert.equal(listJournal(db, { now: NOW, person: 'Даниил' }).total, 1);
  assert.equal(listJournal(db, { now: NOW, priority: 'high' }).total, 1);
  assert.equal(listJournal(db, { now: NOW, query: 'детектор' }).total, 1);
  assert.equal(listJournal(db, { now: NOW, from: '2026-09-16' }).total, 1, 'только завтрашнее письмо');
  assert.equal(listJournal(db, { now: NOW, to: '2026-09-15' }).total, 2);
  assert.equal(listJournal(db, { now: NOW, type: 'нечто' }).error, 'unknown_type');
  assert.equal(listJournal(db, { now: NOW, limit: 2 }).shown, 2);
  assert.equal(listJournal(db, { now: NOW, limit: 1000 }).shown, 5, 'выборка не отдаёт больше сотни');
  const page = listJournal(db, { now: NOW, limit: 2, offset: 2 });
  assert.equal(page.offset, 2);
  assert.deepEqual(page.items.map(item => item.dueDate), ['2026-09-16', null], 'вторая страница продолжает первую');
});

test('в выборке сначала то, у чего есть срок', () => {
  const db = seeded();
  const items = listJournal(db, { now: NOW }).items;
  assert.deepEqual(items.slice(0, 3).map(item => item.dueDate), ['2026-09-10', '2026-09-15', '2026-09-16']);
  assert.equal(items.at(-1).dueDate, null);
});

test('словарь журнала отдаёт написания проектов, людей и меток', () => {
  const known = vocabulary(seeded(), {});
  assert.deepEqual(known.projects.sort(), ['CP', 'Hub', 'TCAM']);
  assert.deepEqual(known.people, ['Даниил']);
  assert.deepEqual(known.tags, ['релиз']);
});

test('карта журнала называет счётчики, проекты и сегодняшнее', () => {
  const map = journalOverview(seeded(), { now: NOW });
  assert.equal(map.totals.entries, 5);
  assert.equal(map.totals.open, 3);
  assert.equal(map.totals.overdue, 1);
  const hub = map.projects.find(project => project.name === 'Hub');
  assert.equal(hub.open, 3);
  assert.equal(hub.overdue, 1);
  assert.equal(map.horizon.today.length, 1);
  assert.deepEqual(map.overdue.map(item => item.daysLate), [5]);
});

test('выборка по проекту и статусу отдаёт открытое и знает общее число', () => {
  const db = seeded();
  const found = listJournal(db, { now: NOW, project: 'Hub', status: 'open', limit: 2 });
  assert.equal(found.total, 3);
  assert.equal(found.items.length, 2);
});

test('карта журнала отдаётся по сети и только своя', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-journal-api-'));
  const app = createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite') });
  const mine = authed(app);
  const stranger = authed(app, { email: 'other@kizuna.test', role: 'user' });
  entry(app.database, 'Допинать бот-детектор по Hub', { userId: mine.user.id, projects: ['Hub'], when: { date: '2026-09-10' } });
  const map = await mine.get('/api/journal/overview').expect(200);
  assert.equal(map.body.totals.entries, 1);
  assert.equal(map.body.projects[0].name, 'Hub');
  const empty = await stranger.get('/api/journal/overview').expect(200);
  assert.equal(empty.body.totals.entries, 0);
  const list = await mine.get('/api/journal/entries?project=Hub&status=open').expect(200);
  assert.equal(list.body.total, 1);
  await mine.get('/api/journal/entries?type=нечто').expect(400);
  await request(app).get('/api/journal/overview').expect(401);
});
