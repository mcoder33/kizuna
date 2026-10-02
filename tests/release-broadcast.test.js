import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { RELEASE_CARDS, selectSeasonalReleaseCard, applySeasonalDefault } from '../server/release-cards.js';
import { announceRelease, prepareRelease, readBroadcastSource, broadcastExitCode } from '../server/release-broadcast.js';

const TOKEN = `123456789:${'x'.repeat(32)}`;
const SITE = 'https://kizuna.agent-hub.space';
const note = { id: 'release-test-1', title: 'Стало удобнее', changes: ['Записать дело теперь проще.'] };
const photo = { ...note, image: `${SITE}/public/release-mac-quick-capture.png`, buttons: [{ text: 'Открыть', url: `${SITE}/` }, { text: 'Скачать для Mac', url: `${SITE}/public/mac-download.html` }] };

function fixture(t, { token = TOKEN, chats = ['101', '202'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-release-'));
  const filename = path.join(dir, 'app.sqlite');
  const source = new Database(filename);
  source.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE telegram_links(user_id TEXT,chat_id INTEGER);');
  if (token !== null) source.prepare('INSERT INTO app_settings VALUES(?,?)').run('telegramBotToken', token);
  chats.forEach((chat, index) => {
    source.prepare('INSERT INTO users VALUES(?,?)').run(`user-${index}`, 'active');
    source.prepare('INSERT INTO telegram_links VALUES(?,?)').run(`user-${index}`, chat);
  });
  const receiptsPath = path.join(dir, 'release-broadcast.sqlite');
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length, chat: { id: body.chat_id } } }), { status: 200 });
  };
  const run = overrides => announceRelease({ db: source, receiptsPath, manifest: note, env: {}, send: true, fetchImpl, intervalMs: 0, ...overrides });
  t.after(() => { source.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, source, receiptsPath, calls, fetchImpl, run };
}
function readReceipts(file, fn) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}

test('manifest creates a concise photo caption and two URL buttons without parse mode', () => {
  const result = prepareRelease(photo);
  assert.equal(result.method, 'sendPhoto');
  assert.equal(result.payload.caption, 'Стало удобнее\n\n• Записать дело теперь проще.');
  assert.deepEqual(result.payload.reply_markup.inline_keyboard, [photo.buttons]);
  assert.equal(result.payload.parse_mode, undefined);
  assert.equal(prepareRelease(note).method, 'sendMessage');
  assert.notEqual(result.contentHash, prepareRelease({ ...photo, buttons: [{ text: 'Перейти', url: `${SITE}/` }] }).contentHash);
  assert.notEqual(result.contentHash, prepareRelease({ ...photo, image: `${SITE}/public/other.png` }).contentHash);
});

test('manifest rejects invalid IDs, foreign URLs, long photo captions and extra buttons', () => {
  for (const manifest of [{ ...note, id: '../release' }, { ...photo, image: 'https://example.com/photo.png' },
    { ...note, url: `${SITE}@example.com/` }, { ...photo, changes: Array(3).fill('x'.repeat(360)) },
    { ...photo, buttons: Array(3).fill(photo.buttons[0]) }, { ...note, unknown: true }]) {
    assert.throws(() => prepareRelease(manifest));
  }
});

test('dry run does not create receipts, mutate source DB, or call Telegram', async t => {
  const f = fixture(t); const before = fs.readFileSync(f.filename);
  const report = await f.run({ send: false });
  assert.equal(report.status, 'dry-run'); assert.equal(report.planned, 2);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.receiptsPath), false);
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.deepEqual(fs.readdirSync(f.dir), ['app.sqlite']);
});

test('stored token takes precedence, including explicitly empty stored token', async t => {
  const f = fixture(t, { token: '' });
  assert.equal(readBroadcastSource(f.source, { PAGENT_TELEGRAM_BOT_TOKEN: TOKEN }).token, '');
  const result = await f.run({ env: { PAGENT_TELEGRAM_BOT_TOKEN: TOKEN } });
  assert.equal(result.status, 'no-token'); assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.receiptsPath), false);
  f.source.prepare('DELETE FROM app_settings').run();
  assert.equal(readBroadcastSource(f.source, { PAGENT_TELEGRAM_BOT_TOKEN: TOKEN }).token, TOKEN);
});

test('no configured token or no active bound recipients skips without creating state', async t => {
  const f = fixture(t, { token: null });
  assert.equal((await f.run()).status, 'no-token');
  f.source.prepare('INSERT INTO app_settings VALUES(?,?)').run('telegramBotToken', TOKEN);
  f.source.prepare("UPDATE users SET status='blocked'").run();
  assert.equal((await f.run()).status, 'no-recipients');
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.receiptsPath), false);
});

test('only active, still-bound, distinct chats receive notes; source stays untouched', async t => {
  const f = fixture(t, { chats: ['101', '101', '202', '303'] });
  f.source.prepare("UPDATE users SET status='pending' WHERE id='user-2'").run();
  f.source.prepare("DELETE FROM telegram_links WHERE user_id='user-3'").run();
  const before = fs.readFileSync(f.filename);
  const result = await f.run();
  assert.equal(result.sent, 1); assert.equal(f.calls[0].body.chat_id, '101');
  assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('reservation is committed before network; payload uses approved token, photo, caption, buttons and no redirects', async t => {
  const f = fixture(t, { chats: ['101'] });
  const result = await f.run({ manifest: photo, fetchImpl: async (url, options) => {
    assert.equal(readReceipts(f.receiptsPath, db => db.prepare('SELECT state FROM receipts').get().state), 'reserved');
    assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.photo, photo.image); assert.ok(body.caption.length <= 1024);
    assert.deepEqual(body.reply_markup.inline_keyboard, [photo.buttons]);
    return f.fetchImpl(url, options);
  } });
  assert.equal(result.sent, 1); assert.equal(broadcastExitCode(result), 0);
  assert.equal(fs.statSync(f.receiptsPath).mode & 0o777, 0o600);
});

test('completed release skips globally on rerun, including newly linked chats', async t => {
  const f = fixture(t);
  const first = await f.run(); assert.equal(first.sent, 2);
  f.source.prepare("INSERT INTO users VALUES('new-user','active')").run();
  f.source.prepare("INSERT INTO telegram_links VALUES('new-user',303)").run();
  const second = await f.run();
  assert.equal(second.status, 'complete'); assert.equal(second.sent, 0); assert.equal(second.previousSent, 2);
  assert.equal(f.calls.length, 2); assert.equal(second.planned, 0);
});

test('content hash mismatch blocks completed release even with no token or in dry run', async t => {
  const f = fixture(t); await f.run({ manifest: photo });
  f.source.prepare("UPDATE app_settings SET value='' WHERE key='telegramBotToken'").run();
  for (const send of [true, false]) await assert.rejects(f.run({ send, manifest: { ...photo, title: 'Changed' } }), { code: 'release_content_changed' });
  assert.equal(f.calls.length, 2);
});

test('Telegram rejection is recorded and not retried or converted to text fallback', async t => {
  const f = fixture(t, { chats: ['101'] });
  let count = 0;
  const response = await f.run({ manifest: photo, fetchImpl: async () => { count++; return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'blocked' }), { status: 403 }); } });
  assert.equal(response.rejected, 1); assert.equal(broadcastExitCode(response), 1);
  await f.run({ manifest: photo });
  assert.equal(count, 1); assert.equal(f.calls.length, 0);
});

test('network failure after a possible photo send is uncertain and never repeated', async t => {
  const f = fixture(t, { chats: ['101'] });
  const report = await f.run({ manifest: photo, fetchImpl: async () => { throw new Error(`possibly accepted https://api.telegram.org/bot${TOKEN}`); } });
  assert.equal(report.uncertain, 1); assert.equal(broadcastExitCode(report), 1);
  const retry = await f.run({ manifest: photo });
  assert.equal(retry.uncertain, 1); assert.equal(retry.sent, 0); assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(report).includes(TOKEN)); assert.ok(!JSON.stringify(report).includes('101'));
});

test('timeout and malformed success remain uncertain, with no automatic fallback', async t => {
  const f = fixture(t, { chats: ['101'] });
  const timeout = await f.run({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    // Keep the fake transport alive as a real socket would be.
    const timer = setTimeout(() => reject(new Error('test transport timeout')), 100);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) });
  assert.equal(timeout.uncertain, 1);
  const malformed = await f.run({ manifest: { ...note, id: 'release-test-2' }, fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 'wrong-chat' } } }), { status: 200 }) });
  assert.equal(malformed.uncertain, 1);
});

test('global lock stops a concurrent runner while the first network request is pending', async t => {
  const f = fixture(t, { chats: ['101'] });
  let releaseFetch, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const first = f.run({ fetchImpl: async (url, options) => { started(); await new Promise(resolve => { releaseFetch = resolve; }); return f.fetchImpl(url, options); } });
  await waiting;
  const second = await f.run(); assert.equal(second.status, 'locked'); assert.equal(f.calls.length, 0);
  releaseFetch(); assert.equal((await first).sent, 1); assert.equal(f.calls.length, 1);
});

test('crashed reservation is never retried; pending snapshot resumes without adding new chats', async t => {
  const f = fixture(t); await f.run();
  const receipts = new Database(f.receiptsPath);
  receipts.prepare('UPDATE releases SET completed_at=NULL').run();
  const rows = receipts.prepare('SELECT chat_hash FROM receipts ORDER BY chat_hash').all();
  receipts.prepare("UPDATE receipts SET state='reserved' WHERE chat_hash=?").run(rows[0].chat_hash);
  receipts.prepare("UPDATE receipts SET state='pending' WHERE chat_hash=?").run(rows[1].chat_hash);
  receipts.prepare("INSERT INTO broadcast_lock VALUES(1,'crashed-owner',99999999)").run(); receipts.close();
  f.source.prepare("INSERT INTO users VALUES('new-user','active')").run();
  f.source.prepare("INSERT INTO telegram_links VALUES('new-user',303)").run();
  const retry = await f.run({ isProcessAlive: () => false });
  assert.equal(retry.uncertain, 1); assert.equal(retry.sent, 1); assert.equal(f.calls.length, 3);
  assert.ok(!f.calls.some(call => call.body.chat_id === '303'));
});

test('unbind during run removes remaining recipients; bot config changes leave pending receipts', async t => {
  const f = fixture(t);
  const result = await f.run({ fetchImpl: async (url, options) => {
    f.source.prepare('DELETE FROM telegram_links').run();
    return f.fetchImpl(url, options);
  } });
  assert.equal(result.sent, 1); assert.equal(result.unlinked, 1);
  const other = fixture(t);
  const changed = await other.run({ fetchImpl: async (url, options) => {
    other.source.prepare("UPDATE app_settings SET value='' WHERE key='telegramBotToken'").run();
    return other.fetchImpl(url, options);
  } });
  assert.equal(changed.status, 'configuration-changed'); assert.equal(changed.sent, 1); assert.equal(changed.planned, 1);
});

test('CLI defaults to dry run, emits no chat/token values, and never creates a missing source DB', t => {
  const f = fixture(t);
  const manifestPath = path.join(f.dir, 'note.json'); fs.writeFileSync(manifestPath, JSON.stringify(note));
  const args = ['scripts/announce-release.mjs', '--database', f.filename, '--manifest', manifestPath];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_PATH: path.join(f.dir, 'absent.env') } });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout.trim());
  assert.equal(output.mode, 'dry-run'); assert.equal(output.planned, 2);
  assert.ok(!result.stdout.includes(TOKEN)); assert.ok(!result.stdout.includes('101'));
  assert.equal(fs.existsSync(f.receiptsPath), false);
  const absent = path.join(f.dir, 'absent.sqlite');
  const missing = spawnSync(process.execPath, ['scripts/announce-release.mjs', '--database', absent, '--manifest', manifestPath], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.equal(fs.existsSync(absent), false);
});

test('tracked release manifest is sendable as text or a photo with its declared buttons', () => {
  const latest = JSON.parse(fs.readFileSync(new URL('../release-notes/latest.json', import.meta.url), 'utf8'));
  const result = prepareRelease(latest);
  assert.ok(latest.changes.length > 0);
  if (latest.image || latest.seasonalImage) {
    assert.equal(result.method, 'sendPhoto');
    assert.ok(result.payload.caption.length <= 1024);
    assert.equal(new URL(result.payload.photo).origin, SITE);
  } else {
    assert.equal(result.method, 'sendMessage');
    assert.ok(result.payload.text.length <= 4096);
    assert.equal(result.payload.link_preview_options.is_disabled, true);
  }
  assert.equal(result.payload.parse_mode, undefined);
  const buttons = result.payload.reply_markup?.inline_keyboard.flat() || [];
  assert.equal(buttons.length, latest.buttons?.length || 0);
  for (const button of buttons) {
    assert.ok(button.text.trim());
    assert.equal(new URL(button.url).origin, SITE);
  }
});

const seasonalNote = { ...note, seasonalImage: true };
test('seasonal deck covers all seven weekdays in each of the four calendar seasons', () => {
  const weeks = { spring: '2026-03-02', summer: '2026-06-01', autumn: '2026-09-07', winter: '2026-12-07' };
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const selected = [];
  for (const [season, monday] of Object.entries(weeks)) for (const [offset, day] of days.entries()) {
    const date = new Date(monday + 'T08:00:00Z'); date.setUTCDate(date.getUTCDate() + offset);
    const url = selectSeasonalReleaseCard(date);
    assert.equal(url, SITE + '/public/release-cards/' + season + '-' + day + '.png');
    selected.push(url);
  }
  assert.equal(new Set(selected).size, 28);
  assert.deepEqual(new Set(selected), new Set(RELEASE_CARDS));
});

test('selection follows Samara local midnight at season boundaries and leap day', () => {
  for (const [utc, expected] of [
    ['2026-02-28T19:59:59Z', 'winter-sat'], ['2026-02-28T20:00:00Z', 'spring-sun'],
    ['2026-05-31T19:59:59Z', 'spring-sun'], ['2026-05-31T20:00:00Z', 'summer-mon'],
    ['2026-08-31T19:59:59Z', 'summer-mon'], ['2026-08-31T20:00:00Z', 'autumn-tue'],
    ['2026-11-30T19:59:59Z', 'autumn-mon'], ['2026-11-30T20:00:00Z', 'winter-tue'],
    ['2024-02-29T08:00:00Z', 'winter-thu'], ['2024-02-29T20:00:00Z', 'spring-fri'],
  ]) assert.equal(selectSeasonalReleaseCard(new Date(utc)), SITE + '/public/release-cards/' + expected + '.png');
  assert.equal(selectSeasonalReleaseCard(new Date('2026-02-28T20:00:00Z'), 'UTC'), SITE + '/public/release-cards/winter-sat.png');
});

test('seasonal manifest rejects ambiguous media and overlong captions before any send', async t => {
  for (const bad of [{ ...seasonalNote, image: photo.image }, { ...seasonalNote, seasonalImage: 'yes' },
    { ...seasonalNote, changes: Array(3).fill('x'.repeat(360)) }]) assert.throws(() => prepareRelease(bad));
  assert.equal(prepareRelease(seasonalNote).method, 'sendPhoto');
  assert.notEqual(prepareRelease(seasonalNote).contentHash, prepareRelease({ ...note, image: RELEASE_CARDS[0] }).contentHash);
  const f = fixture(t);
  await assert.rejects(f.run({ manifest: seasonalNote, releaseDate: '2026-02-30T00:00:00Z' }), /invalid_release_date/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.receiptsPath), false);
});

test('seasonal dry run previews successful deploy date without creating or changing receipts', async t => {
  const f = fixture(t); const sourceBefore = fs.readFileSync(f.filename);
  const options = { manifest: seasonalNote, send: false, releaseDate: '2026-06-01T08:00:00Z', now: () => new Date('2026-12-01T08:00:00Z') };
  const preview = await f.run(options);
  assert.equal(preview.image, SITE + '/public/release-cards/summer-mon.png');
  assert.equal(fs.existsSync(f.receiptsPath), false); assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readFileSync(f.filename), sourceBefore);
  await f.run({ ...options, send: true });
  const before = fs.readFileSync(f.receiptsPath);
  const retry = await f.run({ ...options, releaseDate: '2026-12-01T08:00:00Z' });
  assert.equal(retry.image, preview.image); assert.equal(retry.status, 'complete');
  assert.deepEqual(fs.readFileSync(f.receiptsPath), before);
});

test('a pending seasonal release reuses its exact image across day and season changes', async t => {
  const f = fixture(t);
  const first = await f.run({ manifest: seasonalNote, releaseDate: '2026-02-28T19:59:59Z', fetchImpl: async (url, options) => {
    const result = await f.fetchImpl(url, options);
    f.source.prepare("UPDATE app_settings SET value='' WHERE key='telegramBotToken'").run();
    return result;
  } });
  assert.equal(first.status, 'configuration-changed'); assert.equal(first.sent, 1);
  f.source.prepare("UPDATE app_settings SET value=? WHERE key='telegramBotToken'").run(TOKEN);
  const second = await f.run({ manifest: seasonalNote, releaseDate: '2026-06-01T08:00:00Z' });
  assert.equal(second.sent, 1); assert.equal(second.previousSent, 1);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.body.photo), Array(2).fill(SITE + '/public/release-cards/winter-sat.png'));
  const saved = readReceipts(f.receiptsPath, db => JSON.parse(db.prepare('SELECT payload_json FROM releases').get().payload_json));
  assert.equal(saved.selectedAt, '2026-02-28T19:59:59.000Z');
  await assert.rejects(f.run({ manifest: { ...seasonalNote, title: 'Changed' } }), /release_content_changed/);
});

test('uncertain seasonal sends never repeat and plain or manual media remain unchanged', async t => {
  const f = fixture(t, { chats: ['101'] });
  let attempts = 0;
  const failed = await f.run({ manifest: seasonalNote, releaseDate: '2026-03-02T08:00:00Z', fetchImpl: async () => { attempts++; throw Error('lost'); } });
  assert.equal(failed.uncertain, 1);
  const retry = await f.run({ manifest: seasonalNote, releaseDate: '2026-12-01T08:00:00Z', fetchImpl: async () => { attempts++; } });
  assert.equal(attempts, 1); assert.equal(retry.image, failed.image);
  await f.run({ manifest: { ...note, id: 'plain-new' } });
  await f.run({ manifest: { ...photo, id: 'manual-new' } });
  assert.equal(f.calls[0].body.photo, undefined);
  assert.equal(f.calls[1].body.photo, photo.image);
  assert.equal(readReceipts(f.receiptsPath, db => db.prepare("SELECT COUNT(*) AS n FROM releases WHERE json_extract(payload_json, '$.selectedAt') IS NOT NULL").get().n), 1);
});

test('every seasonal card has a tracked PNG asset available for deployment', () => {
  assert.equal(RELEASE_CARDS.length, 28);
  for (const url of RELEASE_CARDS) {
    const filename = new URL('..' + new URL(url).pathname, import.meta.url);
    const content = fs.readFileSync(filename);
    assert.deepEqual(content.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), url);
    assert.ok(content.readUInt32BE(16) > 0 && content.readUInt32BE(20) > 0, url);
  }
});

test('automatic release defaults omitted media to seasonal while standalone, plain and manual choices stay intact', t => {
  const auto = applySeasonalDefault(note, true);
  assert.equal(prepareRelease(auto).method, 'sendPhoto');
  assert.equal(auto.seasonalImage, true);
  assert.equal(note.seasonalImage, undefined);
  assert.equal(prepareRelease(applySeasonalDefault(note)).method, 'sendMessage');
  const plain = { ...note, seasonalImage: false };
  assert.equal(applySeasonalDefault(plain, true), plain);
  assert.equal(prepareRelease(plain).method, 'sendMessage');
  assert.equal(applySeasonalDefault(photo, true), photo);
  assert.equal(prepareRelease(photo).payload.photo, photo.image);
  assert.throws(() => prepareRelease(applySeasonalDefault({ ...note, seasonalImage: 'yes' }, true)), /invalid_manifest/);
  const f = fixture(t);
  const manifestPath = path.join(f.dir, 'auto-note.json');
  fs.writeFileSync(manifestPath, JSON.stringify(note));
  const args = ['scripts/announce-release.mjs', '--database', f.filename, '--manifest', manifestPath, '--seasonal-default', '--release-date', '2026-03-02T08:00:00Z'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_PATH: path.join(f.dir, 'absent.env') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).image, SITE + '/public/release-cards/spring-mon.png');
  fs.writeFileSync(manifestPath, JSON.stringify(plain));
  const plainResult = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_PATH: path.join(f.dir, 'absent.env') } });
  assert.equal(plainResult.status, 0, plainResult.stderr);
  assert.equal(JSON.parse(plainResult.stdout).image, undefined);
  assert.equal(fs.existsSync(f.receiptsPath), false);
});
