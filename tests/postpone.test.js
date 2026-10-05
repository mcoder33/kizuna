import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { occursOn } from '../server/repeat.js';

function fixture(at = '2026-10-05T08:00:00Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-postpone-'));
  const app = createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite'), now: () => new Date(at), timeZone: 'Europe/Samara' });
  return { app, api: authed(app), dir };
}
async function task(api, schedule = { date: '2026-10-05', time: '11:00', end: '11:30', remind: 15 }) {
  const entry = (await api.post('/api/captures').send({ raw: 'Нужно проверить перенос' }).expect(201)).body.entry;
  await api.post(`/api/captures/${entry.id}/corrections`).send({ patch: { schedule }, at: Date.now() }).expect(200);
  return entry.id;
}
const read = async (api, id) => (await api.get(`/api/captures/${id}`).expect(200)).body.entry;
const schedule = async (api, id) => (await read(api, id)).interpretation.classification.entities.schedule;
const move = (api, id, extra = {}) => api.post(`/api/captures/${id}/postpone`).send({ operationId: crypto.randomUUID(), ...extra });
const undo = (api, id, result) => api.post(`/api/captures/${id}/undo-postpone`).send({ operationId: result.operationId });

test('single task: tomorrow preserves time, end, reminder and children; undo restores the exact schedule', async () => {
  const { api } = fixture(), id = await task(api);
  const child = (await api.post(`/api/captures/${id}/subtasks`).send({ title: 'Шаг с прежним сроком' }).expect(201)).body.entry;
  const before = await schedule(api, id), childBefore = await schedule(api, child.id);
  const result = (await move(api, id).expect(200)).body;
  assert.deepEqual(await schedule(api, id), { ...before, date: '2026-10-06', sortAt: '2026-10-06T11:00:00', display: '2026-10-06, 11:00–11:30' });
  assert.deepEqual(await schedule(api, child.id), childBefore);
  await undo(api, id, result).expect(200);
  assert.deepEqual(await schedule(api, id), before);
  await undo(api, id, result).expect(200);
});

test('tasks without a date and future tasks both move to tomorrow; tomorrow itself is a no-op', async () => {
  const { api } = fixture();
  for (const date of [null, '2026-11-10']) {
    const id = await task(api, { date, time: null });
    const before = await schedule(api, id), result = (await move(api, id).expect(200)).body;
    assert.equal((await schedule(api, id)).date, '2026-10-06');
    assert.equal((await move(api, id).expect(200)).body.unchanged, true);
    await undo(api, id, result).expect(200);
    assert.deepEqual(await schedule(api, id), before);
  }
});

test('one repeat is detached; tomorrow regular occurrence stays, details survive and retries do not duplicate it', async () => {
  const { api, app, dir } = fixture();
  const id = await task(api, { date: '2026-10-01', time: '09:00', end: '09:20', repeat: { freq: 'daily', interval: 1 }, skip: ['2026-10-03'], remind: 'off' });
  await api.post(`/api/captures/${id}/notes`).send({ body: 'Сохранить все детали' }).expect(200);
  const before = await schedule(api, id), operationId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  app.database.prepare('INSERT INTO capture_attachments(id,capture_id,filename,content_type,byte_size,checksum,created_at) VALUES(?,?,?,?,?,?,?)').run(attachmentId, id, 'note.txt', 'text/plain', 4, 'test', new Date().toISOString());
  fs.writeFileSync(path.join(dir, 'attachments', attachmentId), 'test');
  const result = (await move(api, id, { operationId, occurrence: '2026-10-05' }).expect(200)).body;
  const source = await schedule(api, id), detached = await read(api, result.captureId);
  assert.notEqual(result.captureId, id);
  assert.deepEqual(source, { ...before, skip: ['2026-10-03', '2026-10-05'] });
  assert.equal(occursOn(source, '2026-10-06'), true);
  assert.equal(detached.interpretation.classification.entities.schedule.repeat, undefined);
  assert.equal(detached.interpretation.classification.entities.schedule.date, '2026-10-06');
  assert.equal(detached.note.body, 'Сохранить все детали');
  assert.equal(fs.readFileSync(path.join(dir, 'attachments', detached.attachments[0].id), 'utf8'), 'test');
  assert.equal((await move(api, id, { operationId, occurrence: '2026-10-05' }).expect(200)).body.captureId, result.captureId);
  await move(api, id, { occurrence: '2026-10-05' }).expect(409);
  await undo(api, id, result).expect(200);
  assert.deepEqual(await schedule(api, id), before);
  assert.ok(app.database.prepare('SELECT deleted_at FROM captures WHERE id=?').get(result.captureId).deleted_at);
});

test('foreign, deleted, closed and skipped tasks cannot be moved', async () => {
  const { api, app } = fixture(), other = authed(app, { email: 'other@kizuna.test' });
  const id = await task(api);
  await move(other, id).expect(404);
  await api.post(`/api/projections/${(await read(api, id)).projections[0].id}/complete`).send({}).expect(200);
  await move(api, id).expect(409);
  const deleted = await task(api);
  await api.delete(`/api/captures/${deleted}`).expect(200);
  await move(api, deleted).expect(404);
  const recurring = await task(api, { date: '2026-10-05', repeat: { freq: 'daily' }, skip: ['2026-10-05'] });
  await move(api, recurring, { occurrence: '2026-10-05' }).expect(409);
});

test('undo never overwrites a subsequent schedule edit or discards an edited detached task', async () => {
  const { api } = fixture(), id = await task(api);
  const result = (await move(api, id).expect(200)).body;
  await api.post(`/api/captures/${id}/corrections`).send({ patch: { schedule: { date: '2026-10-09', time: null } } }).expect(200);
  await undo(api, id, result).expect(409);
  assert.equal((await schedule(api, id)).date, '2026-10-09');
  const repeat = await task(api, { date: '2026-10-05', repeat: { freq: 'weekly' } });
  const moved = (await move(api, repeat, { occurrence: '2026-10-05' }).expect(200)).body;
  await api.post(`/api/captures/${moved.captureId}/notes`).send({ body: 'Новая правка' }).expect(200);
  await undo(api, repeat, moved).expect(409);
  assert.equal((await read(api, moved.captureId)).note.body, 'Новая правка');
  const another = await task(api, { date: '2026-10-05', repeat: { freq: 'daily' } });
  const withChild = (await move(api, another, { occurrence: '2026-10-05' }).expect(200)).body;
  const child = (await api.post(`/api/captures/${withChild.captureId}/subtasks`).send({ title: 'Новая подзадача после переноса' }).expect(201)).body.entry;
  await undo(api, another, withChild).expect(409);
  await read(api, child.id);
});

test('tomorrow uses the user time zone across a UTC day boundary', async () => {
  const { api } = fixture('2026-10-05T21:30:00Z'), id = await task(api);
  assert.equal((await move(api, id).expect(200)).body.date, '2026-10-07');
});

test('a failed attachment copy rolls back the detached task and series change together', async () => {
  const { api, app, dir } = fixture();
  const id = await task(api, { date: '2026-10-05', repeat: { freq: 'daily' } });
  const before = await schedule(api, id);
  for (const [index, exists] of [true, false].entries()) {
    const attachmentId = crypto.randomUUID();
    app.database.prepare('INSERT INTO capture_attachments(id,capture_id,filename,content_type,byte_size,checksum,created_at) VALUES(?,?,?,?,?,?,?)').run(attachmentId, id, 'note.txt', 'text/plain', 4, 'test', `2026-10-05T08:00:0${index}Z`);
    if (exists) fs.writeFileSync(path.join(dir, 'attachments', attachmentId), 'test');
  }
  const count = app.database.prepare('SELECT COUNT(*) AS n FROM captures').get().n;
  const files = fs.readdirSync(path.join(dir, 'attachments'));
  await move(api, id, { occurrence: '2026-10-05' }).expect(500);
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM captures').get().n, count);
  assert.deepEqual(await schedule(api, id), before);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'attachments')), files);
});
