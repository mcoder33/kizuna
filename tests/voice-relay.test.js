// Живой разговор шёл из браузера прямо к Google, и Google закрывал сокет кодом
// 1007 «User location is not supported» — по стране самого браузера. Теперь
// сокет к Google держит сервер: браузер соединяется со своим же сайтом. Здесь
// проверяется именно это — что токен наружу не уходит, кадры ходят в обе
// стороны, билет одноразовый и чужому не годится.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { createApp } from '../server/index.js';
import { createVoiceService } from '../server/voice.js';
import { fakeModelService } from './helpers/fake-model.js';
import { seedUser } from './helpers/auth.js';
import { openDatabase } from '../server/db.js';

// Вместо Google — свой сокет: запоминает, с каким токеном к нему пришли, и
// отвечает на сказанное.
async function fakeGoogle({ closeWith = null } = {}) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  const seen = { url: null, frames: [] };
  sockets.on('connection', (socket, request) => {
    seen.url = request.url;
    if (closeWith) { socket.close(closeWith.code, closeWith.reason); return; }
    socket.on('message', data => {
      seen.frames.push(data.toString());
      socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, port: server.address().port, async stop() { sockets.close(); server.close(); await once(server, 'close'); } };
}

async function fixture(upstreamPort) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-relay-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const voiceService = createVoiceService({
    geminiApiKey: 'ключ-остаётся-на-сервере',
    provider: 'gemini',
    liveUrl: `ws://127.0.0.1:${upstreamPort}`,
    fetch: async () => ({ ok: true, json: async () => ({ name: 'токен-гугла' }) }),
  });
  const app = createApp({ aiService: fakeModelService(), voiceService, databasePath });
  const user = seedUser(app, { email: 'relay@example.com' });
  const cookie = `pagent_session=${app.accounts.issueSession(user)}`;
  const server = http.createServer(app);
  app.attachVoiceRelay(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = async () => (await fetch(`${base}/api/voice/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
  })).json();
  return {
    app, cookie, databasePath, session,
    socket: (ticket, withCookie = true) => new WebSocket(`${base.replace('http', 'ws')}/api/voice/relay?ticket=${encodeURIComponent(ticket)}`, withCookie ? { headers: { Cookie: cookie } } : {}),
    async stop() { await app.captureJobWorker.stop(); server.close(); await once(server, 'close'); },
  };
}

test('разговор идёт через свой сервер: токен Google наружу не уходит, кадры ходят в обе стороны', async () => {
  const google = await fakeGoogle();
  const kizuna = await fixture(google.port);
  try {
    const session = await kizuna.session();
    assert.equal(session.relay, true);
    assert.equal(session.url, '/api/voice/relay');
    assert.notEqual(session.clientSecret, 'токен-гугла', 'браузер получает билет, а не ключ от Google');

    const socket = kizuna.socket(session.clientSecret);
    await once(socket, 'open');
    socket.send(JSON.stringify({ setup: { model: session.model } }));
    const [answer] = await once(socket, 'message');
    assert.match(answer.toString(), /turnComplete/, 'ответ Google дошёл до браузера');
    assert.match(google.seen.url, /access_token=%D1%82%D0%BE%D0%BA%D0%B5%D0%BD|access_token=токен/, 'к Google пришли с настоящим токеном');
    assert.match(google.seen.frames[0], /setup/, 'сказанное браузером дошло до Google');

    socket.close();
    // Разговор закрывает релей — он один знает настоящую длительность.
    await new Promise(done => setTimeout(done, 120));
    const db = openDatabase(kizuna.databasePath);
    const row = db.prepare('SELECT closed_by, ended_at FROM voice_sessions ORDER BY started_at DESC LIMIT 1').get();
    db.close();
    assert.equal(row.closed_by, 'relay');
    assert.ok(row.ended_at, 'разговор закрыт, а не брошен сторожу');
  } finally {
    await kizuna.stop();
    await google.stop();
  }
});

test('билет одноразовый и чужому не годится, без куки не пускают вовсе', async () => {
  const google = await fakeGoogle();
  const kizuna = await fixture(google.port);
  try {
    const session = await kizuna.session();
    const first = kizuna.socket(session.clientSecret);
    await once(first, 'open');
    // Тот же билет второй раз ничего не открывает.
    const second = kizuna.socket(session.clientSecret);
    const [error] = await once(second, 'error');
    assert.ok(error, 'повторное подключение по использованному билету отклонено');
    first.close();

    // Без куки не пускают даже с живым билетом.
    const fresh = await kizuna.session();
    const stranger = kizuna.socket(fresh.clientSecret, false);
    const [refused] = await once(stranger, 'error');
    assert.ok(refused, 'чужой сокет закрыт');
  } finally {
    await kizuna.stop();
    await google.stop();
  }
});

test('отказ Google доходит до человека словами, а не молчанием', async () => {
  const google = await fakeGoogle({ closeWith: { code: 1007, reason: 'User location is not supported for the API use' } });
  const kizuna = await fixture(google.port);
  try {
    const session = await kizuna.session();
    const socket = kizuna.socket(session.clientSecret);
    await once(socket, 'open');
    const [code, reason] = await once(socket, 'close');
    assert.equal(code, 1011, 'код вне разрешённого диапазона заменяется, но соединение закрыто честно');
    assert.match(reason.toString(), /User location is not supported/);
  } finally {
    await kizuna.stop();
    await google.stop();
  }
});
