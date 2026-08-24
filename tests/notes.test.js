import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { openDatabase, saveNote, activeNote, resetLedger, NOTE_BODY_LIMIT } from '../server/db.js';

function fixture(prefix = 'pagent-notes-') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'test.sqlite');
}
function app() {
  return createApp({ aiService: fakeModelService(), databasePath: fixture() });
}
async function capture(api, raw = 'Нужно проверить Hub') {
  return (await api.post('/api/captures').send({ raw }).expect(201)).body.entry;
}

test('a note is stored as a new version instead of rewriting the previous one', () => {
  const db = openDatabase(fixture());
  const captureId = 'c1';
  db.prepare('INSERT INTO captures VALUES(?,?,?,?,?,?,NULL)').run(captureId, 'raw', 'text', '2026-08-21T10:00:00Z', '2026-08-21T10:00:00Z', 'private');
  const first = saveNote(db, captureId, '# Первая');
  assert.equal(first.note.version, 1);
  const second = saveNote(db, captureId, '# Вторая');
  assert.equal(second.note.version, 2);
  assert.equal(activeNote(db, captureId).body, '# Вторая');
  const rows = db.prepare('SELECT version,status,supersedes_id FROM capture_notes ORDER BY version').all();
  assert.deepEqual(rows.map(row => row.status), ['superseded', 'active'], 'прежняя версия сохраняется');
  assert.equal(rows[1].supersedes_id, rows[0] && db.prepare("SELECT id FROM capture_notes WHERE version=1").get().id);
});

test('saving a note for a missing capture reports not found', () => {
  const db = openDatabase(fixture());
  assert.equal(saveNote(db, 'нет-такой', 'текст').notFound, true);
});

test('a note body is capped instead of failing', () => {
  const db = openDatabase(fixture());
  db.prepare('INSERT INTO captures VALUES(?,?,?,?,?,?,NULL)').run('c2', 'raw', 'text', '2026-08-21T10:00:00Z', '2026-08-21T10:00:00Z', 'private');
  const saved = saveNote(db, 'c2', 'x'.repeat(NOTE_BODY_LIMIT + 500));
  assert.equal(saved.note.body.length, NOTE_BODY_LIMIT);
});

test('reset removes notes together with captures', () => {
  const databasePath = fixture();
  const db = openDatabase(databasePath);
  db.prepare('INSERT INTO captures VALUES(?,?,?,?,?,?,NULL)').run('c3', 'raw', 'text', '2026-08-21T10:00:00Z', '2026-08-21T10:00:00Z', 'private');
  saveNote(db, 'c3', 'тело');
  resetLedger(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM capture_notes').get().c, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('the api returns the note with the entry and rejects a non-string body', async () => {
  const api = request(app());
  const entry = await capture(api);
  assert.equal(entry.note, null);
  const saved = (await api.post(`/api/captures/${entry.id}/notes`).send({ body: '**жирный**' }).expect(200)).body;
  assert.equal(saved.entry.note.body, '**жирный**');
  assert.equal(saved.entry.note.version, 1);
  const reread = (await api.get('/api/entries').expect(200)).body.entries.find(item => item.id === entry.id);
  assert.equal(reread.note.body, '**жирный**');
  await api.post(`/api/captures/${entry.id}/notes`).send({ body: 42 }).expect(400);
  await api.post(`/api/captures/${entry.id}/notes`).send({ body: 'x'.repeat(NOTE_BODY_LIMIT + 1) }).expect(400);
  await api.post('/api/captures/00000000-0000-4000-8000-000000000000/notes').send({ body: 'x' }).expect(404);
});

test('the note never touches the immutable raw capture', async () => {
  const api = request(app());
  const entry = await capture(api, 'Нужно проверить Hub');
  await api.post(`/api/captures/${entry.id}/notes`).send({ body: 'совсем другой текст' }).expect(200);
  const reread = (await api.get('/api/entries')).body.entries.find(item => item.id === entry.id);
  assert.equal(reread.raw, 'Нужно проверить Hub');
});

test('a correction can flip the completed flag the model set', async () => {
  const api = request(app());
  const entry = await capture(api, 'обсудили перспективы ИИ');
  assert.equal(entry.interpretation.classification.completed, true, 'фейковая модель считает это отчётом');
  const corrected = (await api.post(`/api/captures/${entry.id}/corrections`).send({ patch: { completed: false } }).expect(200)).body;
  assert.equal(corrected.entry.interpretation.classification.completed, false);
  assert.equal(corrected.entry.interpretation.version, 2, 'исправление создаёт новую версию');
  await api.post(`/api/captures/${entry.id}/corrections`).send({ patch: { completed: 'да' } }).expect(400);
});

test('the export includes note versions as lifecycle provenance', async () => {
  const api = request(app());
  const entry = await capture(api);
  await api.post(`/api/captures/${entry.id}/notes`).send({ body: 'первая' }).expect(200);
  await api.post(`/api/captures/${entry.id}/notes`).send({ body: 'вторая' }).expect(200);
  const exported = (await api.get('/api/export').expect(200)).body;
  const notes = exported.captureNotes.filter(row => row.capture_id === entry.id);
  assert.equal(notes.length, 2);
  assert.equal(notes.some(row => row.status === 'active'), true);
  assert.equal(Object.hasOwn(notes[0], 'body'), false, 'экспорт метаданных не дублирует тело');
});
