import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { entitiesToMarkdown, composeCapture, resultText, BOT_AVATAR_PATH } from '../server/telegram.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';
import { createFakeTelegram } from './helpers/fake-telegram.js';

// Telegram — второй вход в журнал: написанное боту разбирается так же, как
// запись с главной. Telegram здесь поддельный (tests/helpers/fake-telegram.js),
// опрос крутится руками: pollOnce забирает сообщения, flush складывает пачки.
// Локальный .env не должен подменять бота или адрес Кизуны: файл тестов идёт
// своим процессом, и чистка окружения здесь больше никого не задевает.
for (const name of ['PAGENT_TELEGRAM_BOT_TOKEN', 'PAGENT_TELEGRAM_API_BASE', 'PAGENT_PUBLIC_URL']) delete process.env[name];
// «Сейчас» у тестов — в будущем: аренду задания разбора база сверяет с
// настоящими часами, и прошедшее время просрочило бы её сразу.
const NOW = new Date('2031-09-24T09:00:00Z'); // 13:00 в Самаре
const unix = date => Math.floor(date.getTime() / 1000);

function fixture({ now = () => NOW, databasePath, fake = createFakeTelegram(), telegramOptions = {} } = {}) {
  const file = databasePath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-telegram-')), 'test.sqlite');
  const app = createApp({ aiService: fakeModelService({ now }), databasePath: file, now, telegramFetch: fake.fetch, telegramOptions: { groupWindowMs: 0, ...telegramOptions } });
  return { app, api: authed(app), fake, db: app.database, databasePath: file };
}
async function eventually(assertion, timeout = 3000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { return await assertion(); } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw lastError;
}
// Привязка — как у человека: токен в «Ключах», «Подключить», /start с кодом.
async function connect(ctx, { headers = {} } = {}) {
  await ctx.api.put('/api/settings').send({ telegramBotToken: ctx.fake.token }).expect(200);
  let request = ctx.api.post('/api/telegram/link');
  for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
  const link = (await request.send({}).expect(201)).body;
  const code = new URL(link.url).searchParams.get('start');
  ctx.fake.push({ text: `/start ${code}` });
  await ctx.app.telegram.pollOnce();
  return { ...link, code };
}
async function deliver(app) {
  await app.telegram.pollOnce();
  await app.telegram.flush({ force: true });
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

test('Telegram is linked to a journal by a one-time code from the settings', async () => {
  const ctx = fixture();
  const off = (await ctx.api.get('/api/telegram').expect(200)).body;
  assert.equal(off.bot.configured, false);
  assert.equal(off.link, null);
  assert.equal((await ctx.api.post('/api/telegram/link').send({}).expect(409)).body.error.code, 'telegram_off');

  const link = await connect(ctx);
  assert.match(link.url, /^https:\/\/t\.me\/kizuna_test_bot\?start=[A-Za-z0-9_-]{20,64}$/);
  assert.match(link.qr, /^data:image\/svg\+xml;base64,/);
  const view = (await ctx.api.get('/api/telegram').expect(200)).body;
  assert.equal(view.link.username, 'sasha');
  assert.equal(view.link.name, 'Саша');
  assert.equal(view.bot.bot.username, 'kizuna_test_bot');
  assert.match(ctx.fake.said().at(-1).text, /Telegram подключён к Кизуне/);
  // Токен наружу не уходит — ни в настройках, ни в сведениях о боте.
  const visible = JSON.stringify((await ctx.api.get('/api/settings').expect(200)).body) + JSON.stringify(view);
  assert.equal(visible.includes(ctx.fake.token), false);

  // Код одноразовый: второй раз по той же ссылке ничего не привязать.
  ctx.fake.push({ text: `/start ${link.code}`, from: { id: 999, is_bot: false, first_name: 'Чужой' } });
  await ctx.app.telegram.pollOnce();
  assert.match(ctx.fake.said().at(-1).text, /устарела или уже использована/);
  assert.equal(count(ctx.db, 'telegram_links'), 1);
});

test('a link that waited too long connects nothing', async () => {
  let current = NOW;
  const ctx = fixture({ now: () => current });
  await ctx.api.put('/api/settings').send({ telegramBotToken: ctx.fake.token }).expect(200);
  const link = (await ctx.api.post('/api/telegram/link').send({}).expect(201)).body;
  current = new Date(NOW.getTime() + 16 * 60 * 1000);
  ctx.fake.push({ text: `/start ${new URL(link.url).searchParams.get('start')}` });
  await ctx.app.telegram.pollOnce();
  assert.equal((await ctx.api.get('/api/telegram').expect(200)).body.link, null);
  assert.match(ctx.fake.said().at(-1).text, /устарела/);
});

test('a stranger gets directions, a group gets silence, and nothing lands in the journal', async () => {
  const ctx = fixture();
  await connect(ctx);
  ctx.fake.push({ text: 'Нужно купить хлеб', from: { id: 555, is_bot: false, first_name: 'Незнакомец' } });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'captures'), 0);
  assert.match(ctx.fake.said().at(-1).text, /ещё не подключён к Кизуне/);
  // В группе бот молчит даже для своего человека: там не его журнал.
  const before = ctx.fake.sent.length;
  ctx.fake.push({ text: 'Нужно купить хлеб', chat: { id: -100500, type: 'group', title: 'Семья' } });
  await deliver(ctx.app);
  assert.equal(ctx.fake.sent.length, before);
  assert.equal(count(ctx.db, 'captures'), 0);
  // Команда не становится записью: бот отвечает подсказкой.
  ctx.fake.push({ text: '/help' });
  ctx.fake.push({ text: '/settings' });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'captures'), 0);
  assert.match(ctx.fake.said().at(-1).text, /Пишите сюда или пересылайте сообщения/);
});

test('a message is recorded and parsed exactly like the main page input', async () => {
  const ctx = fixture();
  await connect(ctx);
  ctx.app.captureJobWorker.start();
  try {
    const text = 'Нужно позвонить маме завтра в 18:00';
    const sent = ctx.fake.push({ text, date: unix(NOW) });
    await deliver(ctx.app);
    const viaTelegram = ctx.db.prepare('SELECT c.id, c.raw, c.user_id, j.origin, j.overrides_json FROM captures c JOIN capture_jobs j ON j.capture_id=c.id').get();
    assert.equal(viaTelegram.raw, text);
    assert.equal(viaTelegram.user_id, ctx.api.user.id);
    assert.equal(viaTelegram.origin, 'telegram');
    assert.deepEqual(JSON.parse(viaTelegram.overrides_json), {timeContext:{timeZone:'Europe/Samara',referenceAt:NOW.toISOString()}}, 'только внутренний контекст времени; тип выбирает модель, как на главной');
    // Карточка показывает «Откуда»: полная запись знает, что она из Telegram, а с главной — ни откуда.
    assert.equal((await ctx.api.get(`/api/captures/${viaTelegram.id}`).expect(200)).body.entry.origin, 'telegram');

    // Та же запись с главной — для сравнения: разбор должен совпасть.
    const main = (await ctx.api.post('/api/captures').set('Prefer', 'respond-async').send({ raw: text }).expect(202)).body;
    await eventually(async () => assert.equal((await ctx.api.get(main.statusUrl).expect(200)).body.state, 'succeeded'));
    await eventually(() => assert.ok(ctx.fake.said().some(line => line.method === 'editMessageText')));
    const classification = id => JSON.parse(ctx.db.prepare("SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(id).classification_json);
    const mine = classification(viaTelegram.id), theirs = classification(main.captureId);
    assert.equal((await ctx.api.get(`/api/captures/${main.captureId}`).expect(200)).body.entry.origin, null);
    assert.equal(mine.primaryType, 'task');
    assert.equal(mine.primaryType, theirs.primaryType);
    assert.equal(mine.summary, theirs.summary);
    assert.deepEqual([mine.entities.schedule.date, mine.entities.schedule.time], ['2031-09-25', '18:00']);
    assert.deepEqual([mine.entities.schedule.date, mine.entities.schedule.time], [theirs.entities.schedule.date, theirs.entities.schedule.time]);

    // Ответ: сначала «записано» на само сообщение, потом итог — правкой его же.
    const saving = ctx.fake.said().find(line => line.method === 'sendMessage' && line.replyTo === sent.message.message_id);
    assert.equal(saving.text, '✍️ Записано, ИИ разбирает…');
    const result = ctx.fake.said().find(line => line.method === 'editMessageText');
    assert.equal(result.messageId, saving.messageId);
    assert.equal(result.text, '📌 Легло: «Нужно позвонить маме завтра в 18:00» — завтра в 18:00');
    // Кнопки к записи нет: адрес Кизуны в тесте — не публичный https.
    assert.equal(result.markup, null);
  } finally { await ctx.app.captureJobWorker.stop(); }
});

test('a forwarded message keeps its author and never hands anyone a task', async () => {
  const ctx = fixture();
  const anya = authed(ctx.app, { email: 'anya@kizuna.test', role: 'user' });
  await ctx.api.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await ctx.api.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await ctx.api.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  await connect(ctx);
  ctx.app.captureJobWorker.start();
  try {
    // Своё «Ане — …» поручает дело Ане, как и на главной.
    ctx.fake.push({ text: 'Ане — подготовить отчёт', date: unix(NOW) });
    await deliver(ctx.app);
    // Пересланное «Ане — …» — чужие слова: поручения от вашего имени нет.
    ctx.fake.push({ text: 'Ане — подготовить смету', date: unix(NOW), forward_origin: { type: 'user', sender_user: { id: 31, is_bot: false, first_name: 'Иван', last_name: 'Петров' }, date: unix(NOW) - 3600 } });
    await deliver(ctx.app);
    await eventually(() => assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM capture_jobs WHERE state='succeeded'").get().count, 2));
    const rows = ctx.db.prepare(`SELECT c.raw, j.origin, (SELECT COUNT(*) FROM assignments a WHERE a.capture_id=c.id AND a.cancelled_at IS NULL) AS assigned
      FROM captures c JOIN capture_jobs j ON j.capture_id=c.id ORDER BY j.origin`).all();
    assert.deepEqual(rows.map(row => [row.origin, row.assigned]), [['telegram', 1], ['telegram_forward', 0]]);
    assert.equal(rows[1].raw, 'Ане — подготовить смету\n\n— Иван Петров, переслано из Telegram');
  } finally { await ctx.app.captureJobWorker.stop(); }
});

test('what is sent together becomes one record: a comment with a forward, an album with its photos', async () => {
  const ctx = fixture();
  await connect(ctx);
  // Комментарий и пересланное Telegram присылает двумя сообщениями подряд.
  ctx.fake.push({ text: 'Ответить до вечера', date: unix(NOW) });
  ctx.fake.push({ text: 'Когда релиз?', date: unix(NOW), forward_origin: { type: 'user', sender_user: { id: 32, is_bot: false, first_name: 'Иван', last_name: 'Петров' }, date: unix(NOW) - 2 * 86400 } });
  await deliver(ctx.app);
  const [together] = ctx.db.prepare('SELECT c.raw, j.origin FROM captures c JOIN capture_jobs j ON j.capture_id=c.id').all();
  assert.equal(count(ctx.db, 'captures'), 1);
  assert.equal(together.raw, 'Ответить до вечера\n\n> **Иван Петров, 22 сентября:** Когда релиз?');
  assert.equal(together.origin, 'telegram_forward');

  // Альбом — несколько сообщений с одним media_group_id, подпись у первого.
  const first = ctx.fake.addFile(Buffer.from('jpeg-first'), 'a.jpg');
  const second = ctx.fake.addFile(Buffer.from('jpeg-second'), 'b.jpg');
  ctx.fake.push({ media_group_id: 'album-1', caption: 'Доска после планирования', date: unix(NOW), photo: [{ file_id: 'thumb', file_unique_id: 't', width: 90, height: 90, file_size: 900 }, { file_id: first, file_unique_id: 'a', width: 1280, height: 960, file_size: 10 }] });
  ctx.fake.push({ media_group_id: 'album-1', date: unix(NOW), photo: [{ file_id: second, file_unique_id: 'b', width: 1280, height: 960, file_size: 11 }] });
  await deliver(ctx.app);
  const album = ctx.db.prepare("SELECT id, raw FROM captures WHERE raw='Доска после планирования'").get();
  assert.ok(album, 'подпись альбома — текст записи');
  const files = ctx.db.prepare('SELECT id, content_type, byte_size FROM capture_attachments WHERE capture_id=? ORDER BY byte_size').all(album.id);
  assert.deepEqual(files.map(file => [file.content_type, file.byte_size]), [['image/jpeg', 10], ['image/jpeg', 11]]);
  const stored = path.join(path.dirname(ctx.databasePath), 'attachments', files[0].id);
  assert.equal(fs.readFileSync(stored, 'utf8'), 'jpeg-first');
  assert.equal(count(ctx.db, 'captures'), 2);
});

test('a burst too long for one record falls apart into a record per message', async () => {
  const ctx = fixture();
  await connect(ctx);
  for (const letter of ['а', 'б', 'в']) ctx.fake.push({ text: letter.repeat(4000), date: unix(NOW) });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'captures'), 3);
});

test('a message delivered again after a restart is recorded once', async () => {
  const first = fixture();
  await connect(first);
  first.fake.push({ text: 'Нужно продлить домен', date: unix(NOW) });
  await deliver(first.app);
  assert.equal(count(first.db, 'captures'), 1);
  // Сервер упал, не успев подтвердить обновление: новый процесс получит его
  // от Telegram снова, но записи не повторит.
  const second = fixture({ databasePath: first.databasePath, fake: first.fake });
  await deliver(second.app);
  assert.equal(count(second.db, 'captures'), 1);
});

test('after «Отключить» the bot writes nothing into the journal', async () => {
  const ctx = fixture();
  await connect(ctx);
  assert.equal((await ctx.api.delete('/api/telegram/link').expect(200)).body.link, null);
  await eventually(() => assert.match(ctx.fake.said().at(-1).text, /Telegram отключён от Кизуны/));
  ctx.fake.push({ text: 'Нужно купить хлеб' });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'captures'), 0);
  assert.match(ctx.fake.said().at(-1).text, /ещё не подключён/);
});

test('a voice message is kept as a file with a line naming it; an oversized file is refused aloud', async () => {
  const ctx = fixture({ telegramOptions: { attachmentLimit: 64 } });
  await connect(ctx);
  const voice = ctx.fake.addFile(Buffer.from('OggS-voice'), 'voice.oga');
  ctx.fake.push({ voice: { file_id: voice, file_unique_id: 'v1', duration: 7, mime_type: 'audio/ogg', file_size: 10 }, date: unix(NOW) });
  await deliver(ctx.app);
  const capture = ctx.db.prepare('SELECT id, raw FROM captures').get();
  assert.equal(capture.raw, 'Из Telegram: голосовое сообщение, 0:07');
  assert.equal(ctx.db.prepare('SELECT content_type FROM capture_attachments WHERE capture_id=?').get(capture.id).content_type, 'audio/ogg');

  const big = ctx.fake.addFile(Buffer.alloc(200, 1), 'big.pdf');
  ctx.fake.push({ document: { file_id: big, file_unique_id: 'b1', file_name: 'смета.pdf', mime_type: 'application/pdf', file_size: 200 }, date: unix(NOW) });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'captures'), 1, 'из одного непринятого файла записи не получается');
  assert.match(ctx.fake.said().at(-1).text, /«смета\.pdf» не сохранён: файлы больше/);
});

test('the reply leads to the record when Kizuna lives at a public https address', async () => {
  const ctx = fixture();
  await connect(ctx, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'kizuna.example.com' } });
  ctx.app.captureJobWorker.start();
  try {
    ctx.fake.push({ text: 'Созвон по Hub завтра в 11:00', date: unix(NOW) });
    await deliver(ctx.app);
    await eventually(() => assert.ok(ctx.fake.said().some(line => line.method === 'editMessageText')));
    const capture = ctx.db.prepare('SELECT id FROM captures').get();
    const result = ctx.fake.said().find(line => line.method === 'editMessageText');
    assert.equal(result.text, '📌 Легло: «Созвон по Hub завтра в 11:00» — завтра в 11:00\nПроект: Hub');
    assert.deepEqual(result.markup, { inline_keyboard: [[{ text: 'Открыть в Кизуне', url: `https://kizuna.example.com/#today?open=${capture.id}` }]] });
  } finally { await ctx.app.captureJobWorker.stop(); }
});

test('a wrong token shows as a bot error in the settings instead of breaking anything', async () => {
  const ctx = fixture();
  await ctx.api.put('/api/settings').send({ telegramBotToken: 'не токен' }).expect(400);
  await ctx.api.put('/api/settings').send({ telegramBotToken: '987654321:wrong-token-wrong-token-wrong' }).expect(200);
  assert.equal((await ctx.api.post('/api/telegram/link').send({}).expect(503)).body.error.code, 'telegram_unavailable');
  ctx.app.telegram.start();
  try {
    await eventually(async () => {
      const view = (await ctx.api.get('/api/telegram').expect(200)).body;
      assert.equal(view.bot.state, 'error');
      assert.match(view.bot.error, /Токен не подходит/);
    });
  } finally { await ctx.app.telegram.stop(); }
});

test('clearing the journal forgets delivered messages but keeps Telegram connected', async () => {
  const ctx = fixture();
  await connect(ctx);
  ctx.fake.push({ text: 'Нужно продлить домен', date: unix(NOW) });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'telegram_messages'), 1);
  await ctx.api.post('/api/reset').send({ confirmation: 'СБРОСИТЬ КИЗУНА' }).expect(200);
  assert.equal(count(ctx.db, 'telegram_messages'), 0);
  assert.ok((await ctx.api.get('/api/telegram').expect(200)).body.link);
});

test('a blocked account gets nothing recorded from Telegram', async () => {
  const ctx = fixture();
  await connect(ctx);
  ctx.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(ctx.api.user.id);
  ctx.fake.push({ text: 'Нужно продлить домен', date: unix(NOW) });
  await deliver(ctx.app);
  assert.equal(count(ctx.db, 'captures'), 0);
  assert.match(ctx.fake.said().at(-1).text, /закрыта/);
});

test('Telegram formatting and forwarded authors turn into readable Markdown', () => {
  assert.equal(
    entitiesToMarkdown('Смотри тут и важно ', [{ type: 'text_link', offset: 7, length: 3, url: 'https://example.com/a' }, { type: 'bold', offset: 13, length: 6 }]),
    'Смотри [тут](https://example.com/a) и **важно** ',
  );
  assert.equal(entitiesToMarkdown('жирный курсив', [{ type: 'bold', offset: 0, length: 13 }, { type: 'italic', offset: 7, length: 6 }]), '**жирный *курсив***');
  assert.equal(entitiesToMarkdown('без разметки', []), 'без разметки');

  const now = unix(NOW);
  const together = composeCapture([
    { message_id: 1, date: now, text: 'Когда релиз?', forward_origin: { type: 'user', sender_user: { first_name: 'Иван' }, date: now } },
    { message_id: 2, date: now, text: 'В четверг', forward_origin: { type: 'hidden_user', sender_user_name: 'Аня', date: now - 86400 } },
  ], { now: NOW });
  assert.deepEqual(together, { raw: '**Иван:** Когда релиз?\n\n**Аня, вчера:** В четверг\n\n— переслано из Telegram', forwarded: true });
  const post = composeCapture([{ message_id: 3, date: now, text: 'Вышла версия 2.0', forward_origin: { type: 'channel', chat: { title: 'Новости Hub', username: 'hubnews' }, message_id: 42, date: now } }], { now: NOW });
  assert.equal(post.raw, 'Вышла версия 2.0\n\n— [канал «Новости Hub»](https://t.me/hubnews/42), переслано из Telegram');
  assert.equal(composeCapture([{ message_id: 4, date: now, sticker: { file_id: 's' } }], { now: NOW }), null);
});

test('the reply after parsing says what the main page says', () => {
  const today = '2026-09-24';
  assert.equal(resultText({
    state: 'succeeded',
    classification: { primaryType: 'task', summary: 'Отправить счёт', entities: { schedule: { date: '2026-09-24', time: null }, projects: [] }, ambiguity: { field: 'people', question: 'Кому отправить?' } },
    parts: [{ title: 'Позвонить в банк' }],
  }, { today }), '📌 Легло 1 туду на сегодня:\n• «Позвонить в банк»\n❓ Кому отправить?', 'родитель при пачке дел — не туду, в ответе только отделившиеся дела');
  assert.equal(resultText({
    state: 'succeeded',
    classification: { primaryType: 'task', summary: 'Пачка', entities: { schedule: { date: '2026-09-24', time: null }, projects: [] } },
    parts: [{ title: 'Отправить счёт' }, { title: 'Позвонить в банк' }],
  }, { today }), '📌 Легло 2 туду на сегодня:\n• «Отправить счёт»\n• «Позвонить в банк»');
  assert.equal(resultText({ state: 'succeeded', classification: { primaryType: 'task', summary: 'Идеи к отпуску', entities: { schedule: { date: today, time: '15:00' }, projects: [] } } }, { today }), '📌 Легло на сегодня: «Идеи к отпуску» — в 15:00');
  assert.equal(resultText({ state: 'succeeded', classification: { primaryType: 'task', summary: 'Квартальный отчёт', entities: { schedule: { date: '2026-09-25', time: null }, projects: [] } } }, { today }), '📌 Легло: «Квартальный отчёт» — завтра');
  assert.equal(resultText({ state: 'succeeded', classification: { primaryType: 'task', completed: true, summary: 'Ревью по Hub', entities: { schedule: null, doneOn: { date: '2026-09-23', time: null }, projects: [] } } }, { today }), '🏁 Записано как сделанное: «Ревью по Hub» — вчера');
  assert.match(resultText({ state: 'failed' }, { today }), /не разобрано/);
  assert.equal(resultText({ state: 'succeeded', captureGone: true }, { today }), 'Запись уже удалена из журнала.');
});

test('the running bot collects a burst by the pause and fills in its commands on the first connection', async () => {
  const ctx = fixture({ telegramOptions: { groupWindowMs: 120, pollTimeoutSeconds: 1 } });
  await connect(ctx);
  ctx.app.telegram.start();
  try {
    await eventually(async () => assert.equal((await ctx.api.get('/api/telegram').expect(200)).body.bot.state, 'ok'));
    assert.deepEqual(ctx.fake.bot.commands.map(command => command.command), ['help']);
    assert.match(ctx.fake.bot.description, /Кизуна запишет их в ваш журнал/);
    ctx.fake.push({ text: 'Глянуть до пятницы', date: unix(NOW) });
    await new Promise(resolve => setTimeout(resolve, 30));
    ctx.fake.push({ text: 'Черновик договора готов', date: unix(NOW), forward_origin: { type: 'user', sender_user: { id: 33, is_bot: false, first_name: 'Лена' }, date: unix(NOW) } });
    await eventually(() => assert.equal(count(ctx.db, 'captures'), 1));
    assert.equal(ctx.db.prepare('SELECT raw FROM captures').get().raw, 'Глянуть до пятницы\n\n> **Лена:** Черновик договора готов');
    // Всё забранное подтверждено: Telegram больше ничего не держит.
    await eventually(() => assert.equal(ctx.fake.pending.length, 0));
  } finally { await ctx.app.telegram.stop(); }
});

test('the bot wears the Kizuna logo from the site: uploaded once per bot and picture, not on every restart', async () => {
  const run = async ctx => {
    ctx.app.telegram.start();
    try { await eventually(async () => assert.equal((await ctx.api.get('/api/telegram').expect(200)).body.bot.state, 'ok')); }
    finally { await ctx.app.telegram.stop(); }
  };
  const first = fixture({ telegramOptions: { pollTimeoutSeconds: 1 } });
  await first.api.put('/api/settings').send({ telegramBotToken: first.fake.token }).expect(200);
  await run(first);
  assert.equal(first.fake.bot.photos.length, 1);
  assert.deepEqual(first.fake.bot.photos[0], fs.readFileSync(BOT_AVATAR_PATH));
  assert.equal(first.fake.bot.photos[0].subarray(0, 3).toString('hex'), 'ffd8ff', 'Telegram берёт фото профиля только в JPG');

  // Релиз перезапускает сервер: тот же бот и та же картинка — второго фото
  // в профиле бота не появляется.
  const again = fixture({ databasePath: first.databasePath, fake: first.fake, telegramOptions: { pollTimeoutSeconds: 1 } });
  await run(again);
  assert.equal(first.fake.bot.photos.length, 1);

  // Картинку поменяли — бот получает новую.
  const redrawn = Buffer.from('ffd8ffe000104a46494600', 'hex');
  const changed = fixture({ databasePath: first.databasePath, fake: first.fake, telegramOptions: { pollTimeoutSeconds: 1, avatar: () => redrawn } });
  await run(changed);
  assert.equal(first.fake.bot.photos.length, 2);
  assert.deepEqual(first.fake.bot.photos[1], redrawn);
});

test('a Telegram that refuses the picture leaves the bot working and tries again after the next restart', async () => {
  const fake = createFakeTelegram();
  let refuse = true;
  const refusing = { ...fake, fetch: async (url, init = {}) => refuse && url.endsWith('/setMyProfilePhoto') ? new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }), { status: 400 }) : fake.fetch(url, init) };
  const ctx = fixture({ fake: refusing, telegramOptions: { pollTimeoutSeconds: 1 } });
  await ctx.api.put('/api/settings').send({ telegramBotToken: fake.token }).expect(200);
  ctx.app.telegram.start();
  try { await eventually(async () => assert.equal((await ctx.api.get('/api/telegram').expect(200)).body.bot.state, 'ok')); }
  finally { await ctx.app.telegram.stop(); }
  assert.equal(fake.bot.photos.length, 0);

  refuse = false;
  const next = fixture({ databasePath: ctx.databasePath, fake: refusing, telegramOptions: { pollTimeoutSeconds: 1 } });
  next.app.telegram.start();
  try { await eventually(async () => assert.equal((await next.api.get('/api/telegram').expect(200)).body.bot.state, 'ok')); }
  finally { await next.app.telegram.stop(); }
  assert.equal(fake.bot.photos.length, 1);
});
