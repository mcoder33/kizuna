import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, createUser, enqueueCaptureJob, claimCaptureJob } from '../server/db.js';
import { createTaskSearchService } from '../server/task-search.js';
import { installTelegramTaskSearch, TASK_SEARCH_COMMANDS } from '../server/telegram-search.js';
import { createApp } from '../server/index.js';
const basePlanForIntegration = topicGroups => ({version:1,type:null,status:null,period:null,basis:'createdOrCompleted',person:null,role:'related',exclusivePerson:false,topicGroups,clarification:null});

const dependencyRoot = process.env.PAGENT_SUMMARY_WORKTREE ? path.resolve(process.env.PAGENT_SUMMARY_WORKTREE) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyFiles = ['telegram-day-summary.js', 'telegram.js', 'day-summary-history.js', 'telegram-day-access.js'].map(name => path.join(dependencyRoot, 'server', name));
const dependencyAvailable = dependencyFiles.every(filename => fs.existsSync(filename));
const integrationOptions = { skip: dependencyAvailable ? false : `Shared Telegram menu dependency absent in ${dependencyRoot}; set PAGENT_SUMMARY_WORKTREE or merge its PR.` };
let createTelegramDaySummaryRouter, createSharedTelegramService, migrateDaySummaryHistory, createTelegramDaySummaryAccess;
if (dependencyAvailable) {
  ({ createTelegramDaySummaryRouter } = await import(pathToFileURL(dependencyFiles[0]).href));
  ({ createTelegramService: createSharedTelegramService } = await import(pathToFileURL(dependencyFiles[1]).href));
  ({ migrateDaySummaryHistory } = await import(pathToFileURL(dependencyFiles[2]).href));
  ({ createTelegramDaySummaryAccess } = await import(pathToFileURL(dependencyFiles[3]).href));
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-search-integration-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const userId = createUser(db, { email: 'owner@kizuna.test', passwordHash: 'test', status: 'active' }).id;
  const otherId = createUser(db, { email: 'admin@kizuna.test', passwordHash: 'test', status: 'active' }).id;
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(otherId);
  const link = { user_id: userId, telegram_id: 100, chat_id: 100, linked_at: '2026-10-03T00:00:00Z', app_url: 'https://kizuna.example/' };
  db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at,app_url) VALUES(?,?,?,?,?)').run(userId, 100, 100, link.linked_at, link.app_url);
  db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at,app_url) VALUES(?,?,?,?,?)').run(otherId, 200, 200, link.linked_at, link.app_url);
  let allowedIds = userId;
  const access = createTelegramDaySummaryAccess({ userIds: () => allowedIds });
  let at = new Date('2026-10-03T12:00:00Z'), counter = 1;
  const now = () => at, sent = [], captures = [], acknowledgements = [], search = createTaskSearchService(db);
  const currentBinding = candidate => {
    const actual = db.prepare("SELECT l.* FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.telegram_id=? AND u.status='active'").get(candidate.telegram_id);
    return Boolean(actual && actual.user_id === candidate.user_id && actual.linked_at === candidate.linked_at && String(actual.chat_id) === String(candidate.chat_id));
  };
  const authorize = (from, chat) => {
    const candidate = from && db.prepare('SELECT * FROM telegram_links WHERE telegram_id=?').get(from.id);
    return candidate && !from.is_bot && chat?.type === 'private' && String(chat.id) === String(from.id) && String(candidate.chat_id) === String(chat.id) && currentBinding(candidate) ? candidate : null;
  };
  const install = () => {
    const router = createTelegramDaySummaryRouter({ db, canAccess: access, now, timeZone: () => 'Europe/Samara', authorize, currentBinding, review: () => {},
      send: async (chatId, text, extra) => { sent.push({ chatId, text, markup: extra.reply_markup }); }, acknowledge: async id => { acknowledgements.push(id); } });
    const route = router.routeMessage;
    router.routeMessage = async message => {
      const handled = await route(message, { forwarded: Boolean(message.forward_origin || message.forward_from || message.forward_sender_name || message.forward_from_chat), update: { update_id: message.message_id, message } });
      if (!handled) captures.push(message);
      return handled;
    };
    const plugin = installTelegramTaskSearch({ menuRouter: router, db, search, canAccess: access, now });
    return { router, plugin };
  };
  const message = (text, extra = {}) => ({ message_id: counter++, from: { id: 100 }, chat: { id: 100, type: 'private' }, text, ...extra });
  const callback = data => ({ id: `callback-${counter++}`, from: { id: 100 }, message: { chat: { id: 100, type: 'private' } }, data });
  const add = title => {
    const id = crypto.randomUUID(), interpretationId = crypto.randomUUID();
    db.prepare('INSERT INTO captures(id,raw,created_at,occurred_at,user_id) VALUES(?,?,?,?,?)').run(id, title, at.toISOString(), at.toISOString(), userId);
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretationId, id, 1, 'active', 'manual', null, JSON.stringify({ primaryType: 'task', summary: title, entities: {} }), '{}', at.toISOString());
  };
  return { db, userId, otherId, link, access, setAccess: value => { allowedIds = value; }, now, sent, captures, acknowledgements, search, message, callback, add, install, ...install(), advance: milliseconds => { at = new Date(at.getTime() + milliseconds); } };
}

test('actual shared router: query exits to capture; forwarding, weekday query and cancellation preserve intent', integrationOptions, async t => {
  const f = fixture(t); f.add('Подготовить отчет');
  await f.router.routeMessage(f.message('Найти')); assert.match(f.sent.at(-1).text, /Что найти/);
  await f.router.routeMessage(f.message('отчет')); assert.match(f.sent.at(-1).text, /Найдено: 1/); assert.equal(f.captures.length, 0);
  await f.router.routeMessage(f.message('Узнать, какие документы нужны')); assert.equal(f.captures.length, 1);
  await f.router.routeMessage(f.message('Найти'));
  await f.router.routeMessage(f.message('/find', { forward_origin: { type: 'hidden_user', sender_user_name: 'Чужой', date: 1780000000 } }));
  assert.equal(f.captures.length, 2); assert.equal(f.plugin.pending(f.link), false);
  await f.router.routeMessage(f.message('Найти')); await f.router.routeMessage(f.message('покажи пятницу'));
  assert.equal(f.captures.length, 2); assert.equal(f.plugin.pending(f.link), false);
  await f.router.routeMessage(f.message('Найти')); await f.router.routeMessage(f.message('Отмена')); assert.equal(f.plugin.pending(f.link), false);
});

function aiAppFixture(t,{planner,limit=null,aiAdmissionOptions={}}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kizuna-ai-search-app-'));
  const keys=['PAGENT_AI_PROVIDER','PAGENT_TELEGRAM_TASK_SEARCH_USER_IDS','PAGENT_TELEGRAM_BOT_TOKEN'];
  const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.PAGENT_AI_PROVIDER='gemini';process.env.PAGENT_TELEGRAM_BOT_TOKEN='fixture-token';
  const updates=[],sent=[],calls=[];let messageId=1,updateId=1;
  const app=createApp({databasePath:path.join(directory,'db.sqlite'),now:()=>new Date('2026-10-03T12:00:00Z'),aiAdmissionOptions,
    aiService:{status:async()=>assert.fail('search must not enumerate provider catalogues'),planSearch:async(...args)=>{calls.push(args);return planner ? planner(...args) : {plan:basePlanForIntegration([['войс опс','Voice Ops']]),usedProvider:'gemini',provider:'gemini',usageProvider:'gemini',usage:{inputTokens:9,outputTokens:5,costUsd:null}};}},
    telegramOptions:{groupWindowMs:0},telegramFetch:async(url,request)=>{const method=url.split('/').at(-1),params=JSON.parse(request.body||'{}');if(method==='sendMessage')sent.push(params);return new Response(JSON.stringify({ok:true,result:method==='getUpdates'?updates.splice(0):{message_id:999}}),{status:200});},
  });
  const db=app.database,owner=createUser(db,{email:'owner@ai-fixture.test',passwordHash:'test',monthlyLimitUsd:limit}).id,other=createUser(db,{email:'other@ai-fixture.test',passwordHash:'test'}).id;
  process.env.PAGENT_TELEGRAM_TASK_SEARCH_USER_IDS=owner;
  for(const [id,telegram] of [[owner,100],[other,200]])db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at,app_url) VALUES(?,?,?,?,?)').run(id,telegram,telegram,'2026-10-03T00:00:00Z','https://fixture.invalid/');
  const message=(text,telegram=100,extra={})=>({message_id:messageId++,from:{id:telegram},chat:{id:telegram,type:'private'},text,...extra});
  const deliver=async message=>{updates.push({update_id:updateId++,message});await app.telegram.pollOnce();};
  const add=()=>{const id=crypto.randomUUID(),interpretation=crypto.randomUUID();db.prepare('INSERT INTO captures(id,raw,created_at,occurred_at,user_id) VALUES(?,?,?,?,?)').run(id,'Нейтральная запись','2026-10-02T12:00:00Z','2026-10-02T12:00:00Z',owner);db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretation,id,1,'active','manual',null,JSON.stringify({primaryType:'task',summary:'Нейтральная запись',entities:{projects:['ВойсОпс']}}),'{}','2026-10-02T12:00:00Z');return id;};
  t.after(async()=>{await Promise.allSettled([app.telegram.stop(),app.captureJobWorker.stop(),app.calendarSyncWorker.stop(),app.reminderWorker.stop()]);app.closeEventStreams();db.close();fs.rmSync(directory,{recursive:true,force:true});for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}});
  return {app,db,owner,other,message,deliver,updates,sent,calls,add};
}

test('actual app search invokes configured AI once, charges usage, keeps pages/replay model-free and denies other users',async t=>{
  const f=aiAppFixture(t);for(let index=0;index<9;index++)f.add();
  await f.deliver(f.message('/find'));const query=f.message('Можешь собрать мне всё касающееся войс опса?');await f.deliver(query);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][2],'gemini');assert.match(f.sent.at(-1).text,/Найдено: 9/);
  assert.equal(JSON.stringify(f.calls[0][1]).includes('Нейтральная'),false);assert.equal(JSON.stringify(f.calls[0][1]).includes(f.owner),false);
  const page=f.sent.at(-1).reply_markup.inline_keyboard.at(-1)[0].callback_data;
  f.updates.push({update_id:999,callback_query:{id:'page-ai',from:{id:100},message:{chat:{id:100,type:'private'}},data:page}});await f.app.telegram.pollOnce();assert.equal(f.calls.length,1);
  await f.deliver(query);assert.equal(f.calls.length,1);
  await f.deliver(f.message('/find',200));assert.equal(f.calls.length,1);
  const usage=f.db.prepare("SELECT * FROM usage_events WHERE kind='planSearch'").all();assert.equal(usage.length,1);assert.equal(usage[0].provider,'gemini');assert.equal(usage[0].input_tokens,9);assert.equal(usage[0].output_tokens,5);assert.equal(usage[0].user_id,f.owner);
});

test('actual app accounts for paid planner failure and monthly budget prevents another paid operation',async t=>{
  const f=aiAppFixture(t,{planner:async(query,context,provider)=>provider==='fallback'?{plan:null,usedProvider:'fallback',usage:null}:{plan:null,usedProvider:'fallback',provider:'fallback',requestedProvider:'gemini',usageProvider:'gemini',fallbackReason:'malformed_output',usage:{inputTokens:9,outputTokens:5,costUsd:0.25}}});f.add();
  await f.deliver(f.message('/find'));await f.deliver(f.message('покажи все что связанно с войс опсом'));
  assert.match(f.sent.at(-1).text,/Найдено: 1/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_events WHERE kind='planSearch' AND provider='gemini' AND cost_usd=0.25").get().n,1);
  f.db.prepare('UPDATE users SET monthly_limit_usd=0 WHERE id=?').run(f.owner);
  await f.deliver(f.message('/find'));await f.deliver(f.message('войсопс'));
  assert.equal(f.calls.at(-1)[2],'fallback','budget downgrades before paid operation');assert.match(f.sent.at(-1).text,/Найдено: 1/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_events WHERE kind='planSearch'").get().n,1,'fallback makes no paid call and adds no fabricated usage');
});

test('actual app admission rejects a second paid search and cancellation aborts the old interaction',async t=>{
  let resolve;
  const f=aiAppFixture(t,{aiAdmissionOptions:{maxConcurrent:1},planner:async(query,context,provider)=>provider==='fallback'?{plan:null,usage:null}:new Promise(done=>{resolve=done;})});f.add();
  await f.deliver(f.message('/find'));
  const first=f.message('войсопс'),pending=f.app.telegram.menuRouter.routeMessage(first,{update:{message:first}});
  await new Promise(done=>setImmediate(done));assert.equal(f.calls.length,1);
  await f.app.telegram.menuRouter.routeMessage(f.message('/find'));
  await f.app.telegram.menuRouter.routeMessage(f.message('войсопс'));
  assert.equal(f.calls.length,2);assert.equal(f.calls[1][2],'fallback');assert.equal(f.calls[0][3].aborted,true);assert.match(f.sent.at(-1).text,/Найдено: 1/);
  const before=f.sent.length;resolve({plan:basePlanForIntegration([['войсопс']]),usedProvider:'gemini',usageProvider:'gemini',usage:{inputTokens:9,outputTokens:5,costUsd:null}});await pending;await new Promise(done=>setImmediate(done));assert.equal(f.sent.length,before);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_events WHERE kind='planSearch'").get().n,1);
});

test('actual app discards a late AI result after owner restriction is revoked',async t=>{
  let resolve;
  const f=aiAppFixture(t,{planner:async()=>new Promise(done=>{resolve=done;})});f.add();
  await f.deliver(f.message('/find'));const before=f.sent.length;
  const query=f.message('войсопс'),pending=f.app.telegram.menuRouter.routeMessage(query,{update:{message:query}});
  await new Promise(done=>setImmediate(done));process.env.PAGENT_TELEGRAM_TASK_SEARCH_USER_IDS='';
  resolve({plan:basePlanForIntegration([['войсопс']]),usedProvider:'gemini'});await pending;
  assert.equal(f.sent.length,before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entry_search_traces').get().n,0);
});

test('actual shared router: replay precedes mode clearing; page ACK, summary picker, expiry and restart', integrationOptions, async t => {
  const f = fixture(t); for (let i = 0; i < 8; i++) f.add(`Отчет ${i}`);
  const find = f.message('/find'), query = f.message('отчет');
  await f.router.routeMessage(find); await f.router.routeMessage(query);
  const token = f.sent.at(-1).markup.inline_keyboard.at(-1)[0].callback_data;
  await f.router.routeCallback(f.callback(token)); assert.equal(f.acknowledgements.length, 1); assert.match(f.sent.at(-1).text, /Найдено: 8/);
  await f.router.routeMessage(f.message('/find')); await f.router.routeMessage(query); assert.equal(f.plugin.pending(f.link), true);
  await f.router.routeCallback(f.callback('tds:pick')); assert.equal(f.plugin.pending(f.link), false); assert.match(f.sent.at(-1).text, /Введите дату/);
  await f.router.routeMessage(f.message('/find')); f.advance(600001); await f.router.routeMessage(f.message('отчет'));
  assert.equal(f.captures.length, 0); assert.match(f.sent.at(-1).text, /истёк/);
  const restarted = f.install(); await restarted.router.routeMessage(query); assert.equal(f.captures.length, 0);
  await restarted.router.routeMessage(f.message('/find'));
  const restartedBeforeQuery = f.install(); await restartedBeforeQuery.router.routeMessage(f.message('Новый запрос отчета'));
  assert.equal(f.captures.length, 0); assert.match(f.sent.at(-1).text, /сброшен/);
});

test('actual shared polling service: start code preflight clears pending; replay preserves a newer search', integrationOptions, async t => {
  const f = fixture(t), updates = [], sent = [];
  const fetch = async (url, options) => {
    const method = url.split('/').at(-1), params = JSON.parse(options.body || '{}');
    if (method === 'sendMessage') sent.push(params);
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? updates.splice(0) : { message_id: 999 } }), { status: 200 });
  };
  migrateDaySummaryHistory(f.db, f.now().toISOString(), { now: f.now });
  const service = createSharedTelegramService({ db: f.db, canAccessDaySummary: f.access, token: () => 'fixture-token', fetch, now: f.now, userActive: id => id === f.userId, groupWindowMs: 0,
    queueCapture: async input => enqueueCaptureJob(f.db, { ...input, selectedProvider: 'fallback' }) });
  const plugin = installTelegramTaskSearch({ menuRouter: service.menuRouter, db: f.db, search: f.search, canAccess: f.access, now: f.now });
  let update = 1;
  const deliver = async message => { updates.push({ update_id: update++, message }); await service.pollOnce(); };
  await deliver(f.message('/find')); assert.equal(plugin.pending(f.link), true);
  const start = f.message('/start invalid-code'); await deliver(start); assert.equal(plugin.pending(f.link), false);
  await deliver(f.message('Узнать, какие документы нужны')); await service.flush({ force: true });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 1);
  await deliver(f.message('/find')); const before = sent.length;
  await deliver(start); assert.equal(plugin.pending(f.link), true); assert.equal(sent.length, before);
});

function serviceFixture(t, { searchFactory = search => search } = {}) {
  const f = fixture(t), updates = [], calls = [];
  const fetch = async (url, options) => {
    if (url.includes('/file/bot')) return new Response('fixture file', { status: 200 });
    const method = url.split('/').at(-1), params = JSON.parse(options.body || '{}');
    calls.push({ method, params });
    if (method === 'getUpdates') await new Promise(resolve => setImmediate(resolve));
    const result = method === 'getUpdates' ? updates.splice(0) : method === 'getFile' ? { file_path: 'fixture.txt', file_size: 12 } : { id: 1, username: 'fixture_bot', message_id: 999 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const search = searchFactory(f.search), inputs = [];
  const observedSearch = { ...search, search: input => { inputs.push(input); return search.search(input); } };
  const service = createSharedTelegramService({ db: f.db, canAccessDaySummary: f.access, token: () => 'fixture-token', fetch, now: f.now, groupWindowMs: 0,
    userActive: id => f.db.prepare("SELECT status FROM users WHERE id=?").get(id)?.status === 'active', additionalCommands: () => TASK_SEARCH_COMMANDS,
    queueCapture: async input => enqueueCaptureJob(f.db, { ...input, selectedProvider: 'fallback' }), attach: () => true,
    onCaptureSaved: input => f.search.recordOrigins(input) });
  const plugin = installTelegramTaskSearch({ menuRouter: service.menuRouter, db: f.db, search: observedSearch, canAccess: f.access, now: f.now });
  let update = 1;
  const deliver = async message => { updates.push({ update_id: update++, message }); await service.pollOnce(); await service.flush({ force: true }); };
  const deliverCallback = async callback => { updates.push({ update_id: update++, callback_query: callback }); await service.pollOnce(); };
  return { ...f, service, plugin, inputs, calls, deliver, deliverCallback };
}

test('actual owner-only service: owner Find/result/cancel; other active administrator cannot search or see controls but still captures', integrationOptions, async t => {
  const f = serviceFixture(t); for (let i = 0; i < 8; i++) f.add(`Отчет ${i}`);
  await f.deliver(f.message('Найти')); assert.equal(f.plugin.pending(f.link), true);
  assert.ok(JSON.stringify(f.calls.filter(call => call.method === 'sendMessage').at(-1).params.reply_markup).includes('Найти'));
  await f.deliver(f.message('отчет')); assert.equal(f.inputs.length, 1);
  const answer = f.calls.filter(call => call.method === 'sendMessage').at(-1).params;
  assert.match(answer.text, /Найдено: 8/);
  const ownerPage = answer.reply_markup.inline_keyboard.at(-1)[0].callback_data;
  const other = { from: { id: 200 }, chat: { id: 200, type: 'private' } };
  const beforeInputs = f.inputs.length;
  await f.deliver(f.message('Найти', other)); await f.deliver(f.message('/find', other));
  await f.deliverCallback({ ...f.callback(ownerPage), from: other.from, message: { chat: other.chat } });
  assert.equal(f.inputs.length, beforeInputs);
  const deniedMessages = f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === 200);
  for (const { params } of deniedMessages) { assert.doesNotMatch(params.text, /Что найти|Найдено/); assert.doesNotMatch(JSON.stringify(params.reply_markup || {}), /Найти|Сегодня|tds:|ts:|capture=/); }
  assert.ok(f.calls.some(call => call.method === 'answerCallbackQuery'));
  await f.deliver(f.message('/find')); await f.deliver(f.message('Отмена')); assert.equal(f.plugin.pending(f.link), false);
  const beforeCaptures = f.db.prepare('SELECT COUNT(*) n FROM captures WHERE user_id=?').get(f.otherId).n;
  await f.deliver(f.message('Купить молоко', other));
  await f.deliver(f.message('Пересланная задача', { ...other, forward_origin: { type: 'hidden_user', sender_user_name: 'Петя', date: 1780000000 } }));
  await f.deliver(f.message(undefined, { ...other, document: { file_id: 'fixture-file', file_name: 'fixture.txt', mime_type: 'text/plain' } }));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures WHERE user_id=?').get(f.otherId).n, beforeCaptures + 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents WHERE user_id=?').get(f.otherId).n, 0);
  f.service.menuRouter.registerReplyKeyboardButton('Обычный плагин', { row: 0 });
  const otherLink = f.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(f.otherId);
  assert.ok(f.service.menuRouter.replyKeyboard(otherLink).keyboard.flat().includes('Обычный плагин'));
  assert.doesNotMatch(JSON.stringify(f.service.menuRouter.replyKeyboard(otherLink)), /Найти|Сегодня/);
});

test('actual shared allowlist controls global help-only and owner chat command publication', integrationOptions, async t => {
  const f = serviceFixture(t);
  const commandCount = () => f.calls.filter(call => call.method === 'setMyCommands');
  f.service.start();
  // Startup is asynchronous; yield bounded times until the owner scope has been published.
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (commandCount().some(call => call.params.scope?.chat_id === 100)) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(commandCount().some(call => call.params.scope?.chat_id === 100));
  } finally { await f.service.stop(); }
  const global = commandCount().find(call => !call.params.scope);
  assert.deepEqual(global.params.commands.map(command => command.command), ['help']);
  const own = commandCount().filter(call => call.params.scope?.chat_id === 100);
  assert.equal(own.length, 1); assert.deepEqual(own[0].params.commands.map(command => command.command), ['today', 'day', 'settings', 'help', 'find']);
  assert.equal(commandCount().filter(call => call.params.scope?.chat_id === 200).length, 0);
  assert.ok(f.calls.some(call => call.method === 'deleteMyCommands' && call.params.scope?.chat_id === 200));
});

test('startup command publication leaves SQLite available for the capture worker while awaiting Telegram', integrationOptions, async t => {
  const f = fixture(t);
  const queued = enqueueCaptureJob(f.db, { userId: f.userId, raw: 'Startup worker task', selectedProvider: 'fallback' });
  let scopedRequestStarted = false, releaseCommands;
  const commandsPaused = new Promise(resolve => { releaseCommands = resolve; });
  const fetch = async (url, options) => {
    const method = url.split('/').at(-1), params = JSON.parse(options.body || '{}');
    if (method === 'setMyCommands' && params.scope?.chat_id === 100) {
      scopedRequestStarted = true;
      await commandsPaused;
    }
    if (method === 'getUpdates') await new Promise(resolve => setImmediate(resolve));
    const result = method === 'getUpdates' ? [] : { id: 1, username: 'fixture_bot' };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const service = createSharedTelegramService({ db: f.db, canAccessDaySummary: f.access, token: () => 'fixture-token', fetch, now: f.now,
    userActive: id => id === f.userId, additionalCommands: () => TASK_SEARCH_COMMANDS, avatar: () => null });
  service.start();
  try {
    for (let attempt = 0; attempt < 100 && !scopedRequestStarted; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(scopedRequestStarted, true);
    const claim = claimCaptureJob(f.db, { owner: 'fixture-worker', leaseToken: 'fixture-lease', leaseMs: 60000, currentTime: f.now().toISOString() });
    assert.equal(claim.id, queued.jobId);
    assert.equal(claim.state, 'running');
  } finally {
    releaseCommands();
    await service.stop();
  }
});

test('actual shared revocation across asynchronous query/page removes stale result, criteria and controls', integrationOptions, async t => {
  for (const mode of ['query', 'page']) for (const revoke of ['owner-removed', 'rollout-disabled']) {
    let resolveSearch;
    const f = serviceFixture(t, { searchFactory: search => ({ ...search, search: input => {
      const result = search.search(input);
      if ((mode === 'query' && !input.criteria) || (mode === 'page' && input.criteria)) return new Promise(resolve => { resolveSearch = () => resolve(result); });
      return result;
    } }) });
    for (let i = 0; i < 8; i++) f.add(`Отчет Пети ${i}`);
    const router = f.service.menuRouter;
    await router.routeMessage(f.message('/find'));
    let pending;
    if (mode === 'query') pending = router.routeMessage(f.message('дела с Петей'));
    else {
      await router.routeMessage(f.message('дела с Петей'));
      const token = f.calls.filter(call => call.method === 'sendMessage').at(-1).params.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      pending = router.routeCallback(f.callback(token));
    }
    for (let attempt = 0; attempt < 20 && !resolveSearch; attempt++) await Promise.resolve();
    assert.equal(typeof resolveSearch, 'function');
    f.setAccess(revoke === 'owner-removed' ? f.otherId : '');
    const before = f.calls.filter(call => call.method === 'sendMessage').length;
    resolveSearch(); await pending;
    assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, before, `${mode}/${revoke}`);
    assert.equal(f.plugin.pageCount(), 0); assert.equal(f.plugin.pending(f.link), false);
    assert.doesNotMatch(JSON.stringify(router.replyKeyboard(f.link) || {}), /Найти|Сегодня/);
    f.setAccess(f.userId);
    // Restore synchronous search, then prove that the inaccessible person's context was discarded.
    f.inputs.length = 0;
    await router.routeMessage(f.message('/find'));
    const followup = router.routeMessage(f.message('Что я ему обещал?'));
    for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve();
    if (mode === 'query') { resolveSearch(); }
    await followup;
    assert.match(f.calls.filter(call => call.method === 'sendMessage').at(-1).params.text, /Назовите человека/);
  }
});

test('actual shared access revocation preserves consumed-query replay protection before capture fallback', integrationOptions, async t => {
  const f = serviceFixture(t); f.add('Отчет');
  const query = f.message('отчет'); await f.deliver(f.message('/find')); await f.deliver(query);
  f.setAccess(''); const before = f.calls.length;
  await f.deliver(query);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 1);
  assert.equal(f.inputs.length, 1); assert.equal(f.calls.slice(before).filter(call => call.method === 'sendMessage').length, 0);
  await f.deliver(f.message('Обычная новая задача')); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 2);
});

test('actual start-code linking shows Find and scoped commands only to the freshly linked allowed owner', integrationOptions, async t => {
  const f = serviceFixture(t);
  const ownerLink = await f.service.createLink(f.userId, 'https://kizuna.example/');
  const ownerCode = new URL(ownerLink.url).searchParams.get('start');
  await f.deliver(f.message(`/start ${ownerCode}`));
  const ownerWelcome = f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === 100).at(-1).params;
  assert.ok(JSON.stringify(ownerWelcome.reply_markup).includes('Найти'));
  assert.ok(f.calls.some(call => call.method === 'setMyCommands' && call.params.scope?.chat_id === 100 && call.params.commands.some(command => command.command === 'find')));
  const current = f.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(f.userId);
  assert.equal(f.service.menuRouter.canAccessMenu(current), true);
  const otherLink = await f.service.createLink(f.otherId, 'https://kizuna.example/');
  const otherCode = new URL(otherLink.url).searchParams.get('start');
  await f.deliver(f.message(`/start ${otherCode}`, { from: { id: 200 }, chat: { id: 200, type: 'private' } }));
  const otherWelcome = f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === 200).at(-1).params;
  assert.doesNotMatch(JSON.stringify(otherWelcome.reply_markup || {}), /Найти|Сегодня/);
  assert.equal(f.calls.filter(call => call.method === 'setMyCommands' && call.params.scope?.chat_id === 200).length, 0);
});

test('revoked late query preserves a newer pending intent until reset notice, then ordinary capture resumes', integrationOptions, async t => {
  let resolveOld;
  const f = serviceFixture(t, { searchFactory: search => ({ ...search, search: input => {
    const result = search.search(input);
    return new Promise(resolve => { resolveOld = () => resolve(result); });
  } }) });
  f.add('Отчет'); const router = f.service.menuRouter;
  await router.routeMessage(f.message('/find'));
  const old = router.routeMessage(f.message('отчет'));
  for (let attempt = 0; attempt < 20 && !resolveOld; attempt++) await Promise.resolve();
  assert.equal(typeof resolveOld, 'function');
  await router.routeMessage(f.message('Найти'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents').get().n, 1);
  f.setAccess(''); const before = f.calls.filter(call => call.method === 'sendMessage').length;
  resolveOld(); await old;
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, before);
  assert.equal(f.plugin.pageCount(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents').get().n, 1);
  await f.deliver(f.message('Следующий запрос нового поиска'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 1);
  assert.equal(f.inputs.length, 1);
  const notice = f.calls.filter(call => call.method === 'sendMessage').at(-1).params;
  assert.match(notice.text, /сброшен/); assert.doesNotMatch(notice.text, /Следующий запрос|Найдено/);
  assert.doesNotMatch(JSON.stringify(notice.reply_markup || {}), /Найти|ts:/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_search_intents').get().n, 0);
  await f.deliver(f.message('Обычная задача после уведомления'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 2);
});

test('actual owner search renders all project record types and explicit task/subtask filters with generic links',integrationOptions,async t=>{
  const f=serviceFixture(t);
  for(const [index,type] of ['task','task','task','task','task','task','note','outcome_decision','outcome_decision'].entries()) {
    const title=`Синтетическая запись ${index}`;f.add(title);
    const capture=f.db.prepare('SELECT id FROM captures WHERE raw=? AND user_id=?').get(title,f.userId);
    f.db.prepare('UPDATE interpretations SET classification_json=? WHERE capture_id=?').run(JSON.stringify({primaryType:type,summary:title,entities:{projects:['ВойсОпс']}}),capture.id);
    if(index>=2&&index<6) f.db.prepare('UPDATE captures SET subtask=1 WHERE id=?').run(capture.id);
  }
  const response=()=>f.calls.filter(call=>call.method==='sendMessage').at(-1).params;
  await f.deliver(f.message('Найти'));await f.deliver(f.message('что у нас с voice ops'));
  assert.match(response().text,/Найдено: 9/);
  assert.equal(response().reply_markup.inline_keyboard.flat().filter(button=>button.text.includes('Открыть запись')).length,6);
  assert.ok(response().reply_markup.inline_keyboard.flat().filter(button=>button.url).every(button=>new URL(button.url).hash.startsWith('#today?open=')));
  await f.deliver(f.message('/find'));await f.deliver(f.message('заметки войсопс'));
  assert.match(response().text,/Найдено: 1/);assert.match(response().text,/Заметка/);assert.doesNotMatch(response().text,/Открыто|Упоминание|Текст:|Поиск по словам/);
  await f.deliver(f.message('/find'));await f.deliver(f.message('результаты войсопс'));
  assert.match(response().text,/Найдено: 2/);assert.match(response().text,/Результат/);assert.doesNotMatch(response().text,/Открыто/);
  await f.deliver(f.message('/find'));await f.deliver(f.message('задачи войсопс'));assert.match(response().text,/Найдено: 6/);
  await f.deliver(f.message('/find'));await f.deliver(f.message('подзадачи войсопс'));assert.match(response().text,/Найдено: 4/);assert.match(response().text,/Подзадача/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM captures').get().n,9);
});
