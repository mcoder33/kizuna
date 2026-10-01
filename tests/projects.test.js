import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';

test('project suggestions use current projects, exclude deleted and foreign records, and require login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-projects-'));
  const app = createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite') });
  try {
    await request(app).get('/api/projects').expect(401);
    const api = authed(app);
    const other = authed(app, { email: 'other@kizuna.test' });
    const create = async (client, project) => {
      const entry = (await client.post('/api/captures').send({ raw: 'Проверить карточку', primaryType: 'todo' }).expect(201)).body.entry;
      await client.post(`/api/captures/${entry.id}/corrections`).send({ patch: { project } }).expect(200);
      return entry.id;
    };
    await create(api, 'Zadolbator');
    await create(api, 'zadolbator');
    const changed = await create(api, 'Старый проект');
    await api.post(`/api/captures/${changed}/corrections`).send({ patch: { project: 'Новый проект' } }).expect(200);
    const deleted = await create(api, 'Удалённый проект');
    await api.delete(`/api/captures/${deleted}`).expect(200);
    await create(other, 'Чужой проект');
    const projects = (await api.get('/api/projects').expect(200)).body.projects;
    assert.equal(projects.filter((name) => name.toLowerCase() === 'zadolbator').length, 1);
    assert.ok(projects.includes('Новый проект'));
    for (const name of ['Старый проект', 'Удалённый проект', 'Чужой проект']) assert.ok(!projects.includes(name));
  } finally {
    app.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
