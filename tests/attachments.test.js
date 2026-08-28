import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';

// Файлы вложений лежат на диске рядом с базой, а в базе — только описание.
// Поэтому проверяем обе половины: строку в журнале и байты на диске.
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-attach-'));
  const databasePath = path.join(dir, 'test.sqlite');
  return {
    dir,
    databasePath,
    app: createApp({ aiService: fakeModelService(), databasePath }),
    files: () => path.join(dir, 'attachments'),
  };
}
async function capture(api, raw = 'запись с вложением') {
  return (await api.post('/api/captures').send({ raw }).expect(201)).body.entry;
}

test('an attachment is stored beside the entry and comes back byte for byte', async () => {
  const place = workspace();
  const api = authed(place.app);
  const entry = await capture(api);
  const bytes = Buffer.from('строка из приложенного файла', 'utf8');

  const saved = (
    await api
      .post(`/api/captures/${entry.id}/attachments`)
      .set('Content-Type', 'text/plain')
      .set('X-Attachment-Name', encodeURIComponent('заметка о встрече.txt'))
      .send(bytes)
      .expect(201)
  ).body;
  assert.equal(saved.attachment.filename, 'заметка о встрече.txt');
  assert.equal(saved.attachment.contentType, 'text/plain');
  assert.equal(saved.attachment.size, bytes.length);
  assert.match(saved.attachment.checksum, /^[0-9a-f]{64}$/);
  assert.equal(saved.attachments.length, 1);

  // На диске файл называется своим идентификатором: человеческое имя живёт
  // только в базе, поэтому из него нельзя выйти за пределы каталога.
  const onDisk = fs.readdirSync(place.files());
  assert.deepEqual(onDisk, [saved.attachment.id]);

  // Вложение видно в записи — списку журнала не нужен отдельный запрос.
  const listed = (await api.get('/api/entries?limit=1').expect(200)).body.entries[0];
  assert.equal(listed.attachments.length, 1);
  assert.equal(listed.attachments[0].id, saved.attachment.id);

  const download = await api.get(`/api/attachments/${saved.attachment.id}`).expect(200);
  assert.equal(download.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  // Имя уходит в кодировке RFC 5987: кириллица и пробелы не ломают заголовок.
  assert.match(download.headers['content-disposition'], /^inline; filename\*=UTF-8''/);
  // supertest сам разбирает текстовые ответы: сверяем текст, а не буфер.
  assert.equal(download.text, bytes.toString('utf8'));
});

test('an unknown type is never served as something the browser would run', async () => {
  const place = workspace();
  const api = authed(place.app);
  const entry = await capture(api);
  const saved = (
    await api
      .post(`/api/captures/${entry.id}/attachments`)
      .set('Content-Type', 'text/html')
      .set('X-Attachment-Name', encodeURIComponent('страница.html'))
      .send(Buffer.from('<script>alert(1)</script>', 'utf8'))
      .expect(201)
  ).body.attachment;
  // Тип не из белого списка становится потоком байтов…
  assert.equal(saved.contentType, 'application/octet-stream');
  const download = await api.get(`/api/attachments/${saved.id}`).expect(200);
  assert.match(download.headers['content-type'], /application\/octet-stream/);
  // …и отдаётся файлом, а не страницей.
  assert.match(download.headers['content-disposition'], /^attachment;/);
});

test('a filename with a path in it cannot escape the attachments directory', async () => {
  const place = workspace();
  const api = authed(place.app);
  const entry = await capture(api);
  const saved = (
    await api
      .post(`/api/captures/${entry.id}/attachments`)
      .set('Content-Type', 'text/plain')
      .set('X-Attachment-Name', encodeURIComponent('../../../etc/passwd'))
      .send(Buffer.from('x', 'utf8'))
      .expect(201)
  ).body.attachment;
  assert.equal(saved.filename, 'passwd', 'от имени остаётся только базовая часть');
  assert.deepEqual(fs.readdirSync(place.files()), [saved.id]);
  assert.equal(fs.existsSync(path.join(place.dir, 'etc')), false);
});

test('empty files, unknown ids and a full card are refused with a reason', async () => {
  const place = workspace();
  const api = authed(place.app);
  const entry = await capture(api);

  await api
    .post(`/api/captures/${entry.id}/attachments`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.alloc(0))
    .expect(400);
  await api
    .post('/api/captures/00000000-0000-4000-8000-000000000000/attachments')
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('x'))
    .expect(404);
  await api.get('/api/attachments/not-a-uuid').expect(400);
  await api.get('/api/attachments/00000000-0000-4000-8000-000000000000').expect(404);

  // Десять — предел: одиннадцатый файл отвергается объяснением, а не молча.
  for (let index = 0; index < 10; index += 1)
    await api
      .post(`/api/captures/${entry.id}/attachments`)
      .set('Content-Type', 'text/plain')
      .set('X-Attachment-Name', encodeURIComponent(`файл-${index}.txt`))
      .send(Buffer.from(`файл ${index}`, 'utf8'))
      .expect(201);
  const refused = await api
    .post(`/api/captures/${entry.id}/attachments`)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('лишний', 'utf8'))
    .expect(409);
  assert.equal(refused.body.error.code, 'too_many_attachments');
  assert.equal(fs.readdirSync(place.files()).length, 10, 'лишние байты на диск не легли');
});

test('deleting an attachment takes the bytes with it, and reset clears the whole shelf', async () => {
  const place = workspace();
  const api = authed(place.app);
  const entry = await capture(api);
  const saved = (
    await api
      .post(`/api/captures/${entry.id}/attachments`)
      .set('Content-Type', 'image/png')
      .set('X-Attachment-Name', encodeURIComponent('снимок.png'))
      .send(Buffer.from('89504e470d0a1a0a', 'hex'))
      .expect(201)
  ).body.attachment;

  const removed = (await api.delete(`/api/attachments/${saved.id}`).expect(200)).body;
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.attachments, []);
  assert.equal(fs.existsSync(path.join(place.files(), saved.id)), false, 'байты ушли с диска');
  await api.get(`/api/attachments/${saved.id}`).expect(404);
  await api.delete(`/api/attachments/${saved.id}`).expect(404);

  // Полный сброс уносит и каталог с файлами: «удалить всё» значит всё.
  const second = (
    await api
      .post(`/api/captures/${entry.id}/attachments`)
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('останется ли', 'utf8'))
      .expect(201)
  ).body.attachment;
  assert.equal(fs.existsSync(path.join(place.files(), second.id)), true);
  await api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  assert.deepEqual(fs.readdirSync(place.files()), [], 'каталог вложений пуст после сброса');
});
