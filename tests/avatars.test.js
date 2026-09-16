import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { AVATAR_PRESETS, AVATAR_IMAGE_LIMIT } from '../server/avatars.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-avatars-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite') });
}
// Самый маленький настоящий PNG: точка 1×1.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
const upload = (api, bytes, type = 'image/png') => api.post('/api/account/avatar/image').set('Content-Type', type).send(bytes);

test('каждый персонаж набора лежит файлом, а набор отдаётся адресами', async () => {
  for (const preset of AVATAR_PRESETS) assert.ok(fs.existsSync(path.join('public', 'avatars', `${preset.id}.svg`)), preset.id);
  const api = authed(freshApp());
  const presets = (await api.get('/api/account/avatars').expect(200)).body.presets;
  assert.deepEqual(presets.map(preset => preset.id), AVATAR_PRESETS.map(preset => preset.id));
  await api.get(presets[0].url).expect(200).expect('Content-Type', /svg/);
});

test('персонаж выбирается, виден людям в круге и снимается обратно в букву', async () => {
  const app = freshApp();
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  assert.equal((await sasha.get('/api/auth/me').expect(200)).body.user.avatar, null, 'по умолчанию — буква имени');
  const chosen = (await sasha.put('/api/account/avatar').send({ preset: 'fox' }).expect(200)).body.me;
  assert.equal(chosen.avatar, '/public/avatars/fox.svg');
  await sasha.put('/api/account/avatar').send({ preset: 'dragon' }).expect(400);
  await sasha.put('/api/account/avatar').send({ preset: 42 }).expect(400);

  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  const members = (await anya.get('/api/circles').expect(200)).body.circles[0].members;
  assert.equal(members.find(member => member.id === sasha.user.id).avatar, '/public/avatars/fox.svg');
  assert.equal(members.find(member => member.id === anya.user.id).avatar, null);

  assert.equal((await sasha.put('/api/account/avatar').send({ preset: null }).expect(200)).body.me.avatar, null);
});

test('своя картинка: только настоящая и небольшая, отдаётся вошедшим и кешируется по версии', async () => {
  const app = freshApp();
  const api = authed(app);
  // Формат решают байты, а не подпись запроса.
  await upload(api, Buffer.from('<svg onload="alert(1)"></svg>')).expect(415);
  await upload(api, Buffer.alloc(0)).expect(400);
  await upload(api, Buffer.alloc(AVATAR_IMAGE_LIMIT + 1, 1)).expect(413);

  const me = (await upload(api, PNG, 'image/webp').expect(200)).body.me;
  assert.match(me.avatar, new RegExp(`^/api/avatars/${api.user.id}\\?v=`));
  const served = await api.get(me.avatar).buffer(true).parse((response, done) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => done(null, Buffer.concat(chunks)));
  }).expect(200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.match(served.headers['cache-control'], /immutable/);
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(served.body, PNG);
  await request(app).get(me.avatar).expect(401);

  // Выбрал персонажа — своя картинка больше не хранится и не отдаётся.
  await api.put('/api/account/avatar').send({ preset: 'owl' }).expect(200);
  await api.get(me.avatar).expect(404);
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM user_avatars').get().n, 0);
});

// Лицо нужно там, где человек появляется: в обсуждении карточки, в призыве,
// в разговоре круга. Автор собирается из строки сообщения — у неё свой id, и
// картинке нужен id человека.
test('лицо видно в обсуждении, в призыве и в разговоре круга', async () => {
  const app = freshApp();
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  await sasha.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  const fox = (await sasha.put('/api/account/avatar').send({ preset: 'fox' }).expect(200)).body.me.avatar;
  const photo = (await upload(anya, PNG).expect(200)).body.me.avatar;

  const entry = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  await anya.post(`/api/captures/${entry.id}/comments`).send({ body: '@Саша, цены от подрядчика были?' }).expect(201);
  const call = (await sasha.get('/api/inbox').expect(200)).body.rows.find(row => row.kind === 'call');
  assert.equal(call.from.avatar, photo);
  const comment = (await sasha.get(`/api/captures/${entry.id}`).expect(200)).body.entry.comments[0];
  assert.equal(comment.author.avatar, photo);
  assert.equal(comment.mentions[0].avatar, fox);

  const general = (await sasha.get('/api/rooms').expect(200)).body.rooms.find(room => room.kind === 'general');
  await sasha.post(`/api/rooms/${general.id}/messages`).send({ body: '@Аня, посмотри смету' }).expect(201);
  const chatCall = (await anya.get('/api/inbox').expect(200)).body.rows.find(row => row.kind === 'chat');
  assert.equal(chatCall.from.avatar, fox);
  const message = (await anya.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.at(-1);
  assert.equal(message.author.avatar, fox);
  assert.equal(message.mentions[0].avatar, photo);
});

test('удалённый человек уносит свою картинку с собой', async () => {
  const app = freshApp();
  const admin = authed(app);
  const guest = authed(app, { email: 'guest@kizuna.test', role: 'user' });
  await upload(guest, PNG).expect(200);
  await admin.delete(`/api/admin/users/${guest.user.id}`).expect(200);
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM user_avatars').get().n, 0);
});
