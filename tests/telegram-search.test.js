import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, createUser, enqueueCaptureJob, resetLedger } from '../server/db.js';
import { createTaskSearchService } from '../server/task-search.js';
import { createTelegramService } from '../server/telegram.js';
import { installTelegramTaskSearch, renderTaskSearchResult, taskSearchTaskUrl, TASK_SEARCH_COMMANDS } from '../server/telegram-search.js';

// Contract fake for the separately delivered common router; not a production dispatcher.
function fakeSharedRouter({ db, now, sent, captures, acknowledgements }) {
  const preflights = [], routes = [], callbacks = [], buttons = [], modes = new Map(), pending = new Map();
  let weekdayCalls = 0;
  const key = link => JSON.stringify([link.user_id, link.telegram_id, link.chat_id, link.linked_at]);
  const interactions = {
    begin(link, mode, data = {}) { pending.set(key(link), { mode, data, expiresAt: now().getTime() + 600000 }); },
    get(link) { const value = pending.get(key(link)); if (value?.expiresAt <= now().getTime()) { pending.delete(key(link)); return null; } return value; },
    clear(link) { pending.delete(key(link)); },
  };
  const authorize = (from, chat) => {
    const link = from && db.prepare("SELECT l.* FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.telegram_id=? AND u.status='active'").get(from.id);
    return link && !from.is_bot && chat?.type === 'private' && String(link.chat_id) === String(chat.id) ? link : null;
  };
  const send = async (link, text, markup) => {
    if (router.rejectSearchCancellation && text.startsWith('Поиск отменён. Пересланное')) throw new Error('Fake notification failure');
    sent.push({ userId: link.user_id, chatId: link.chat_id, text, markup });
  };
  const router = {
    interactions,
    canAccessMenu: () => true,
    registerPreflight: handler => preflights.push(handler), registerMessageRoute: handler => routes.push(handler),
    registerCallbackRoute: handler => callbacks.push(handler), registerPendingMode: (name, mode) => modes.set(name, mode),
    registerReplyKeyboardButton: (text, options) => buttons.push({ text, ...options }),
    replyKeyboard: (link = db.prepare('SELECT * FROM telegram_links WHERE telegram_id=100').get()) => ({ keyboard: [['☀️ Сегодня', '🗓 Другой день', ...buttons.filter(button => !button.visible || button.visible(link)).map(button => button.text)], ['⚙️ Настройки сводок']], resize_keyboard: true }),
    weekdayCalls: () => weekdayCalls,
    async routeMessage(message) {
      const link = authorize(message.from, message.chat); if (!link) return false;
      const ctx = { message, text: message.text?.trim() || '', link, interactions, send, update: { update_id: message.message_id, message } };
      for (const handler of preflights) if (await handler(ctx)) return true;
      const forwarded = Boolean(message.forward_origin || message.forward_from || message.forward_sender_name || message.forward_from_chat);
      if (forwarded || typeof message.text !== 'string' || message.document || message.photo || message.voice) { interactions.clear(link); captures.push(message); return false; }
      const text = ctx.text;
      if (text.startsWith('/') || router.replyKeyboard().keyboard.flat().includes(text) || text === 'Отмена') interactions.clear(link);
      if (/^\/(today|day|settings|help|start|cancel)(?:\s|$)/.test(text) || ['☀️ Сегодня', '🗓 Другой день', '⚙️ Настройки сводок', 'Отмена'].includes(text)) { await send(link, `common:${text}`); return true; }
      for (const handler of routes) if (await handler(ctx)) return true;
      if (/^покажи(?: в)? пятницу$/i.test(text)) { weekdayCalls++; return true; }
      const state = interactions.get(link), mode = state && modes.get(state.mode);
      if (mode?.accept(text)) { interactions.clear(link); await mode.consume(link, text, state.data, message); return true; }
      if (text.startsWith('/')) return true;
      captures.push(message); return false;
    },
    async routeCallback(callback) {
      acknowledgements.push(callback.id);
      const link = authorize(callback.from, callback.message?.chat); if (!link) return false;
      const ctx = { callback, link, interactions, send, update: { callback_query: callback } };
      for (const handler of preflights) if (await handler(ctx)) return true;
      for (const handler of callbacks) if (await handler(ctx)) return true;
      interactions.clear(link); await send(link, `common-callback:${callback.data}`); return true;
    },
  };
  return router;
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-tg-search-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const userId = createUser(db, { email: 'owner@kizuna.test', passwordHash: 'test', status: 'active' }).id;
  const otherId = createUser(db, { email: 'other@kizuna.test', passwordHash: 'test', status: 'active' }).id;
  const link = { user_id: userId, telegram_id: 100, chat_id: 100, linked_at: '2026-10-03T00:00:00Z', app_url: 'https://kizuna.example/' };
  db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at,app_url) VALUES(?,?,?,?,?)').run(userId, 100, 100, link.linked_at, link.app_url);
  db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at,app_url) VALUES(?,?,?,?,?)').run(otherId, 200, 200, link.linked_at, link.app_url);
  let at = new Date('2026-10-03T12:00:00Z'), number = 1;
  const now = () => at, sent = [], captures = [], acknowledgements = [];
  const search = createTaskSearchService(db);
  const install = (override = {}) => {
    const router = fakeSharedRouter({ db, now, sent, captures, acknowledgements });
    const plugin = installTelegramTaskSearch({ menuRouter: router, db, search, now, ...options, ...override });
    return { router, plugin };
  };
  const installed = install();
  const message = (text, extra = {}) => ({ message_id: number++, from: { id: 100 }, chat: { id: 100, type: 'private' }, text, ...extra });
  const callback = (data, extra = {}) => ({ id: `callback-${number++}`, from: { id: 100 }, message: { chat: { id: 100, type: 'private' } }, data, ...extra });
  const add = (title, { owner = userId, people = [] } = {}) => {
    const id = crypto.randomUUID(), interpretationId = crypto.randomUUID();
    db.prepare('INSERT INTO captures(id,raw,created_at,occurred_at,user_id) VALUES(?,?,?,?,?)').run(id, title, at.toISOString(), at.toISOString(), owner);
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretationId, id, 1, 'active', 'manual', null, JSON.stringify({ primaryType: 'task', summary: title, entities: { people } }), '{}', at.toISOString());
    return id;
  };
  return { db, userId, otherId, link, search, sent, captures, acknowledgements, now, install, message, callback, add, ...installed, advance: ms => { at = new Date(at.getTime() + ms); } };
}

test('installs only through shared router and composes Find into the existing keyboard', t => {
  const f = fixture(t);
  assert.equal(f.plugin.installed, true);
  assert.deepEqual(f.router.replyKeyboard().keyboard[0], ['☀️ Сегодня', '🗓 Другой день', 'Найти']);
  assert.equal(installTelegramTaskSearch({ db: f.db, search: f.search }).reason, 'shared_menu_router_required');
});

test('Find consumes exactly the next own text, then questions resume ordinary capture', async t => {
  const f = fixture(t); f.add('Подготовить отчет');
  await f.router.routeMessage(f.message('Найти'));
  assert.match(f.sent.at(-1).text, /^Что найти\?/);
  await f.router.routeMessage(f.message('отчет'));
  assert.match(f.sent.at(-1).text, /Найдено: 1/); assert.equal(f.captures.length, 0);
  await f.router.routeMessage(f.message('Узнать, какие документы нужны'));
  assert.equal(f.captures.length, 1);
  await f.router.routeMessage(f.message('Какие просьбы Саши я ещё не сделал?'));
  assert.equal(f.captures.length, 2);
});

test('cancel, slash find and durable repeated commands/queries never create captures or repeat processing', async t => {
  const f = fixture(t), find = f.message('/find'), query = f.message('отчет'), cancel = f.message('/cancel');
  await f.router.routeMessage(find); await f.router.routeMessage(find);
  assert.equal(f.sent.length, 1);
  await f.router.routeMessage(query); await f.router.routeMessage(query);
  assert.equal(f.sent.length, 2);
  await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(cancel); await f.router.routeMessage(cancel);
  assert.equal(f.plugin.pending(f.link), false); assert.equal(f.captures.length, 0);
  const restarted = f.install();
  await restarted.router.routeMessage(find); await restarted.router.routeMessage(query); await restarted.router.routeMessage(cancel);
  assert.equal(f.captures.length, 0); assert.equal(restarted.plugin.pending(f.link), false);
  const rows = f.db.prepare('SELECT * FROM task_search_receipts').all();
  assert.ok(rows.every(row => !JSON.stringify(row).includes('отчет')));
});

test('forwarded commands and files remain captures while pending and end the search clearly', async t => {
  const f = fixture(t);
  await f.router.routeMessage(f.message('Найти'));
  await f.router.routeMessage(f.message('/find', { forward_origin: { type: 'hidden_user', sender_user_name: 'Саша', date: 1780000000 } }));
  assert.equal(f.captures.length, 1); assert.match(f.sent.at(-1).text, /Поиск отменён/);
  await f.router.routeMessage(f.message('Следующее обычное дело')); assert.equal(f.captures.length, 2);
  await f.router.routeMessage(f.message('Найти'));
  await f.router.routeMessage(f.message(undefined, { document: { file_id: 'safe-fake' } }));
  assert.equal(f.captures.length, 3); assert.equal(f.plugin.pending(f.link), false);
});

test('other commands/calendar buttons clear modes; weekday text in search is a query', async t => {
  const f = fixture(t);
  for (const control of ['/today', '/day', '/settings', '/help', '/start', '☀️ Сегодня', '🗓 Другой день', '⚙️ Настройки сводок']) {
    await f.router.routeMessage(f.message('Найти')); await f.router.routeMessage(f.message(control));
    assert.equal(f.plugin.pending(f.link), false, control);
    await f.router.routeMessage(f.message('Купить молоко'));
  }
  assert.equal(f.captures.length, 8);
  await f.router.routeMessage(f.message('Найти')); await f.router.routeMessage(f.message('покажи пятницу'));
  assert.equal(f.router.weekdayCalls(), 0); assert.equal(f.captures.length, 8);
});

test('known expired pending text is rejected explicitly instead of becoming a capture', async t => {
  const f = fixture(t);
  await f.router.routeMessage(f.message('Найти')); f.advance(600001);
  await f.router.routeMessage(f.message('отчет'));
  assert.equal(f.captures.length, 0); assert.match(f.sent.at(-1).text, /истёк/);
  await f.router.routeMessage(f.message('Купить молоко')); assert.equal(f.captures.length, 1);
});

test('pagination reads current owner, scopes tokens, ACKs every callback and suppresses replay', async t => {
  const f = fixture(t);
  for (let i = 0; i < 14; i++) f.add(`Отчет ${i}`);
  f.add('Секретный отчет', { owner: f.otherId });
  await f.router.routeMessage(f.message('Найти')); await f.router.routeMessage(f.message('отчет'));
  assert.match(f.sent.at(-1).text, /Найдено: 14/); assert.doesNotMatch(f.sent.at(-1).text, /Секретный/);
  const data = f.sent.at(-1).markup.inline_keyboard.at(-1)[0].callback_data;
  assert.ok(data.length <= 64); assert.match(data, /^[\x20-\x7e]+$/);
  const foreign = f.callback(data, { from: { id: 200 }, message: { chat: { id: 200, type: 'private' } } });
  await f.router.routeCallback(foreign);
  assert.match(f.sent.at(-1).text, /недоступна/);
  const next = f.callback(data); await f.router.routeCallback(next);
  assert.match(f.sent.at(-1).text, /Найдено: 14/);
  const length = f.sent.length; await f.router.routeCallback(next); assert.equal(f.sent.length, length);
  assert.equal(f.acknowledgements.length, 3); assert.equal(f.captures.length, 0);
});

test('expired/invalid callbacks never disclose pages; other actions invalidate page contexts', async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.add(`Отчет ${i}`);
  await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(f.message('отчет'));
  const data = f.sent.at(-1).markup.inline_keyboard.at(-1)[0].callback_data;
  await f.router.routeMessage(f.message('/today'));
  await f.router.routeCallback(f.callback(data)); assert.match(f.sent.at(-1).text, /устарела/);
  await f.router.routeCallback(f.callback('ts:page:invalid')); assert.match(f.sent.at(-1).text, /устарела/);
  await f.router.routeMessage(f.message('/find'));
  await f.router.routeCallback(f.callback('ts:page:invalid')); assert.equal(f.plugin.pending(f.link), false);
  await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(f.message('отчет'));
  const expiring = f.sent.at(-1).markup.inline_keyboard.at(-1)[0].callback_data;
  f.advance(600001); await f.router.routeCallback(f.callback(expiring)); assert.match(f.sent.at(-1).text, /устарела/);
});

test('same-binding previous criteria support follow-up periods; cancel clears context', async t => {
  const f = fixture(t); f.add('Отчет Пети', { people: ['Петя'] });
  await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(f.message('дела с Петей'));
  await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(f.message('за прошлую неделю'));
  assert.match(f.sent.at(-1).text, /Человек: Петей/); assert.match(f.sent.at(-1).text, /предыдущего поиска/);
  await f.router.routeMessage(f.message('Отмена')); await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(f.message('Что я ему обещал?'));
  assert.match(f.sent.at(-1).text, /Назовите человека/);
});

test('reset invalidates pending contexts and retains consumed-query replay protection', async t => {
  const f = fixture(t), query = f.message('отчет');
  await f.router.routeMessage(f.message('Найти')); await f.router.routeMessage(query);
  await f.router.routeMessage(f.message('Найти')); resetLedger(f.db, f.userId);
  await f.router.routeMessage(f.message('документы'));
  assert.match(f.sent.at(-1).text, /сброшен/); assert.equal(f.captures.length, 0);
  await f.router.routeMessage(query); assert.equal(f.captures.length, 0);
});

test('fresh binding and active status prevent results after an asynchronous rebind/unlink', async t => {
  const f = fixture(t); f.add('Отчет');
  const delayed = { ...f.search, search: async input => {
    const result = f.search.search(input);
    f.db.prepare('UPDATE telegram_links SET linked_at=? WHERE user_id=?').run('2026-10-03T12:01:00Z', f.userId);
    return result;
  } };
  const plugin = f.install({ search: delayed });
  await plugin.router.routeMessage(f.message('Найти')); const before = f.sent.length;
  await plugin.router.routeMessage(f.message('отчет')); assert.equal(f.sent.length, before); assert.equal(f.captures.length, 0);
  const stale = f.message('Найти', { from: { id: 100 }, chat: { id: 999, type: 'private' } });
  await plugin.router.routeMessage(stale); assert.equal(f.sent.length, before);
  f.db.prepare('UPDATE users SET status=? WHERE id=?').run('blocked', f.userId);
  await plugin.router.routeMessage(f.message('Найти')); assert.equal(f.sent.length, before);
});

test('renderer bounds titles/text, reports evidence and occurrence facts, validates links', () => {
  const id = crypto.randomUUID();
  const result = { matchedCount: 100, criteria: {}, limitations: ['😀'.repeat(2000)], items: Array.from({ length: 9 }, () => ({ captureId: id, title: '😀'.repeat(3000), status: 'open', completionKind: 'occurrence', matchedOccurrences: [{ date: '2026-10-02' }], evidence: [{ role: 'mention', name: 'Петя', confidence: 'text-only' }], sourceUrl: 'https://evil.example/private' })) };
  const rendered = renderTaskSearchResult(result, { appUrl: 'https://kizuna.example/', nextCallback: 'ts:page:123' });
  assert.ok(rendered.text.length <= 3800); assert.equal(rendered.text.isWellFormed(), true);
  assert.match(rendered.text, /Выполнен повтор 2026-10-02; серия открыта/); assert.match(rendered.text, /личность не подтверждена/);
  assert.equal(rendered.markup.inline_keyboard.length, 7);
  assert.ok(rendered.markup.inline_keyboard.flat().filter(item => item.url).every(item => item.url.startsWith('https://kizuna.example/')));
  assert.equal(taskSearchTaskUrl('http://kizuna.example/', id), null); assert.equal(taskSearchTaskUrl('https://localhost/', id), null);
});

test('actual Telegram polling/capture batching records message origins through saved hook with fake fetch only', async t => {
  const f = fixture(t), updates = [], calls = [], origins = [];
  const fetch = async (url, options) => {
    const method = url.split('/').at(-1), params = JSON.parse(options.body || '{}'); calls.push({ method, params });
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? updates.splice(0) : { message_id: 999 } }), { status: 200 });
  };
  const service = createTelegramService({ db: f.db, canAccessDaySummary: id => id === f.userId, token: () => 'fake-token', fetch, now: f.now, userActive: id => id === f.userId, groupWindowMs: 0,
    queueCapture: async input => enqueueCaptureJob(f.db, { ...input, selectedProvider: 'fallback' }),
    onCaptureSaved: input => { origins.push(input); f.search.recordOrigins(input); },
  });
  const forwardedMessage = f.message('Пришли отчет, пожалуйста', { forward_origin: { type: 'user', sender_user: { id: 500, first_name: 'Саша' }, date: 1780000000 } });
  updates.push({ update_id: 1, message: forwardedMessage });
  await service.pollOnce(); await service.flush({ force: true });
  assert.equal(origins.length, 1); assert.equal(origins[0].messages[0].forward_origin.sender_user.id, 500);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_origins').get().n, 1);
  assert.ok(calls.some(call => call.method === 'sendMessage'));
  assert.equal(installTelegramTaskSearch({ menuRouter: service.menuRouter, db: f.db, search: f.search, now: f.now }).installed, true);
  assert.ok(service.menuRouter.replyKeyboard(f.link).keyboard.flat().includes('Найти'));
  updates.push({ update_id: 2, message: forwardedMessage });
  await service.pollOnce(); await service.flush({ force: true }); assert.equal(origins.length, 1);
});

test('actual stacked Telegram startup preserves summary/help commands and adds find', async t => {
  const f = fixture(t); let registered;
  const commandsReady = new Promise(resolve => { registered = resolve; });
  const fetch = async (url, options) => {
    const method = url.split('/').at(-1), params = JSON.parse(options.body || '{}');
    if (method === 'setMyCommands' && params.scope?.chat_id === 100) registered(params.commands);
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : { id: 1, username: 'fixture_bot' } }), { status: 200 });
  };
  const service = createTelegramService({ db: f.db, canAccessDaySummary: id => id === f.userId, userActive: id => id === f.userId, token: () => 'fake-token', fetch, now: f.now, additionalCommands: () => TASK_SEARCH_COMMANDS });
  service.start();
  try {
    const commands = await commandsReady;
    assert.deepEqual(commands.map(item => item.command), ['today', 'day', 'settings', 'help', 'find']);
  } finally { await service.stop(); }
});

test('shared summary callbacks retain their own actions and their replay cannot clear a new search', async t => {
  const f = fixture(t), shared = f.callback('tds:pick');
  await f.router.routeMessage(f.message('Найти')); await f.router.routeCallback(shared);
  assert.match(f.sent.at(-1).text, /common-callback:tds:pick/); assert.equal(f.plugin.pending(f.link), false);
  await f.router.routeMessage(f.message('Найти'));
  await f.router.routeCallback(shared); assert.equal(f.plugin.pending(f.link), true);
  await f.router.routeMessage(f.message('отчет')); assert.equal(f.captures.length, 0);
});

test('private chat must correspond to sender even if a mismatched link is stored', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE telegram_links SET chat_id=? WHERE user_id=?').run(999, f.userId);
  await f.router.routeMessage(f.message('Найти', { chat: { id: 999, type: 'private' } }));
  assert.equal(f.sent.length, 0); assert.equal(f.captures.length, 0);
});

test('deletion during async preparation removes inaccessible item before rendering', async t => {
  const f = fixture(t), id = f.add('Удалённый отчет');
  const delayed = { ...f.search, search: async input => {
    const result = f.search.search(input);
    f.db.prepare('UPDATE captures SET deleted_at=? WHERE id=?').run(f.now().toISOString(), id);
    return result;
  } };
  const { router } = f.install({ search: delayed });
  await router.routeMessage(f.message('Найти')); await router.routeMessage(f.message('отчет'));
  assert.doesNotMatch(f.sent.at(-1).text, /Удалённый отчет/); assert.match(f.sent.at(-1).text, /просмотренной части/);
});

test('actual capture batch preserves two known forward authors without assigning one requester to the whole task', async t => {
  const f = fixture(t), updates = [];
  const fetch = async url => new Response(JSON.stringify({ ok: true, result: url.endsWith('/getUpdates') ? updates.splice(0) : { message_id: 999 } }), { status: 200 });
  const service = createTelegramService({ db: f.db, token: () => 'fake-token', fetch, now: f.now, userActive: id => id === f.userId, groupWindowMs: 1000,
    queueCapture: async input => enqueueCaptureJob(f.db, { ...input, selectedProvider: 'fallback' }), onCaptureSaved: input => f.search.recordOrigins(input) });
  for (const [index, name] of ['Саша', 'Петя'].entries()) updates.push({ update_id: index + 1, message: f.message('Пришли отчет, пожалуйста', { forward_origin: { type: 'user', sender_user: { id: 500 + index, first_name: name }, date: 1780000000 } }) });
  await service.pollOnce(); await service.flush({ force: true });
  const captures = f.db.prepare('SELECT id FROM captures').all(); assert.equal(captures.length, 1);
  const rows = f.db.prepare('SELECT * FROM task_search_origins').all(); assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.sender_id)), new Set(['500', '501']));
  assert.ok(rows.every(row => row.capture_id === captures[0].id));
  f.db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(crypto.randomUUID(), captures[0].id, 1, 'active', 'manual', null, JSON.stringify({ primaryType: 'task', summary: 'Подготовить отчет', entities: {} }), '{}', f.now().toISOString());
  assert.equal(f.search.search({ userId: f.userId, query: 'дела с Сашей' }).matchedCount, 1);
  assert.equal(f.search.search({ userId: f.userId, query: 'дела с Петей' }).matchedCount, 1);
  assert.equal(f.search.search({ userId: f.userId, query: 'просьбы Саши' }).matchedCount, 0);
  assert.equal(f.search.search({ userId: f.userId, query: 'просьбы Пети' }).matchedCount, 0);
});

test('failed search cancellation notification never prevents forwarding or file capture', async t => {
  const f = fixture(t); f.router.rejectSearchCancellation = true;
  for (const extra of [{ forward_origin: { type: 'hidden_user', sender_user_name: 'Саша', date: 1780000000 } }, { document: { file_id: 'fake-file' } }]) {
    await f.router.routeMessage(f.message('Найти'));
    const before = f.captures.length;
    await f.router.routeMessage(f.message('Пришли отчет', extra));
    assert.equal(f.captures.length, before + 1); assert.equal(f.plugin.pending(f.link), false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents').get().n, 0);
  }
});

test('a late query answer cannot overwrite new Find/cancel intent or replace newer criteria', async t => {
  for (const control of ['Найти', 'Отмена']) {
    const f = fixture(t); f.add('Отчет Пети', { people: ['Петя'] }); f.add('Отчет Саши', { people: ['Саша'] });
    let resolveOld, calls = 0;
    const delayed = { ...f.search, search: input => {
      const result = f.search.search(input);
      if (++calls === 1) return new Promise(resolve => { resolveOld = () => resolve(result); });
      return result;
    } };
    const { router, plugin } = f.install({ search: delayed });
    await router.routeMessage(f.message('Найти'));
    const old = router.routeMessage(f.message('дела с Петей'));
    for (let i = 0; i < 20 && !resolveOld; i++) await Promise.resolve();
    assert.equal(typeof resolveOld, 'function');
    await router.routeMessage(f.message(control));
    if (control === 'Найти') await router.routeMessage(f.message('дела с Сашей'));
    const before = f.sent.length; resolveOld(); await old;
    assert.equal(f.sent.length, before, control);
    assert.equal(plugin.pending(f.link), false);
    await router.routeMessage(f.message('Найти'));
    await router.routeMessage(f.message(control === 'Найти' ? 'за прошлую неделю' : 'Что я ему обещал?'));
    if (control === 'Найти') { assert.match(f.sent.at(-1).text, /Человек: Сашей/); assert.doesNotMatch(f.sent.at(-1).text, /Петей/); }
    else assert.match(f.sent.at(-1).text, /Назовите человека/);
    assert.equal(f.captures.length, 0);
  }
});

test('a late page answer cannot clear a newer pending search or publish another page', async t => {
  const f = fixture(t); for (let i = 0; i < 20; i++) f.add(`Отчет ${i}`);
  let resolvePage;
  const delayed = { ...f.search, search: input => {
    const result = f.search.search(input);
    return input.criteria ? new Promise(resolve => { resolvePage = () => resolve(result); }) : result;
  } };
  const { router, plugin } = f.install({ search: delayed });
  await router.routeMessage(f.message('Найти')); await router.routeMessage(f.message('отчет'));
  const token = f.sent.at(-1).markup.inline_keyboard.at(-1)[0].callback_data;
  const page = router.routeCallback(f.callback(token));
  for (let i = 0; i < 20 && !resolvePage; i++) await Promise.resolve();
  assert.equal(typeof resolvePage, 'function');
  await router.routeMessage(f.message('Найти')); const before = f.sent.length;
  resolvePage(); await page;
  assert.equal(f.sent.length, before); assert.equal(plugin.pending(f.link), true); assert.equal(plugin.pageCount(), 0);
});

test('a late query answer leaves a newly prompted search pending with no misleading capture hint', async t => {
  const f = fixture(t); f.add('Отчет'); let resolveQuery;
  const delayed = { ...f.search, search: input => new Promise(resolve => { resolveQuery = () => resolve(f.search.search(input)); }) };
  const { router, plugin } = f.install({ search: delayed });
  await router.routeMessage(f.message('Найти')); const old = router.routeMessage(f.message('отчет'));
  for (let i = 0; i < 20 && !resolveQuery; i++) await Promise.resolve();
  assert.equal(typeof resolveQuery, 'function'); await router.routeMessage(f.message('Найти'));
  const before = f.sent.length; resolveQuery(); await old;
  assert.equal(f.sent.length, before); assert.equal(plugin.pending(f.link), true);
  assert.match(f.sent.at(-1).text, /^Что найти\?/); assert.equal(plugin.pageCount(), 0);
});

test('restart after Find protects a NEW query with durable intent containing no query text', async t => {
  const f = fixture(t);
  await f.router.routeMessage(f.message('Найти'));
  const intent = f.db.prepare('SELECT * FROM task_search_intents').get();
  assert.equal(intent.user_id, f.userId); assert.equal(intent.connection_key, '100:100');
  const restarted = f.install();
  await restarted.router.routeMessage(f.message('отчет'));
  assert.equal(f.captures.length, 0); assert.match(f.sent.at(-1).text, /сброшен/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents').get().n, 0);
  await restarted.router.routeMessage(f.message('Купить молоко')); assert.equal(f.captures.length, 1);
  assert.doesNotMatch(JSON.stringify(intent), /отчет|Купить/);
});

test('durable pending guards survive expiry/reset/rebind and clear on controls or forwarded capture', async t => {
  for (const transition of ['expiry', 'reset', 'rebind', 'command', 'forward']) {
    const f = fixture(t); await f.router.routeMessage(f.message('Найти'));
    if (transition === 'expiry') f.advance(600001);
    if (transition === 'reset') resetLedger(f.db, f.userId);
    if (transition === 'rebind') {
      f.db.prepare('DELETE FROM telegram_links WHERE user_id=?').run(f.otherId);
      f.db.prepare('UPDATE telegram_links SET user_id=?,linked_at=? WHERE telegram_id=?').run(f.otherId, '2026-10-03T12:01:00Z', 100);
    }
    const restarted = f.install();
    const extra = transition === 'forward' ? { forward_origin: { type: 'hidden_user', sender_user_name: 'Саша', date: 1780000000 } } : {};
    await restarted.router.routeMessage(f.message(transition === 'command' ? '/today' : 'отчет', extra));
    assert.equal(f.captures.length, transition === 'forward' ? 1 : 0, transition);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents').get().n, 0, transition);
    if (!['command', 'forward'].includes(transition)) assert.match(f.sent.at(-1).text, /сброшен|истёк/, transition);
  }
});

test('consumed query replay stays suppressed after the shared access predicate revokes search', async t => {
  const f = fixture(t); f.add('Отчет');
  const query = f.message('отчет'); await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(query);
  f.router.canAccessMenu = () => false; const before = f.sent.length;
  await f.router.routeMessage(query);
  assert.equal(f.captures.length, 0); assert.equal(f.sent.length, before);
  await f.router.routeMessage(f.message('Купить молоко')); assert.equal(f.captures.length, 1);
  assert.doesNotMatch(JSON.stringify(f.router.replyKeyboard(f.link)), /Найти/);
});
