// Post-release notes use a fixed, reviewed manifest. No AI, server bootstrap,
// bot polling, or account mutations run here. Telegram has no idempotency key:
// reserve durably BEFORE sending; an uncertain attempt is never sent again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RELEASE_CARDS, selectSeasonalReleaseCard } from './release-cards.js';

export class ReleaseBroadcastError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ReleaseBroadcastError(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const chatHash = chat => hash(`telegram-chat:${chat}`);
const SITE = 'https://kizuna.agent-hub.space';

function cleanText(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('invalid_manifest');
  return value.trim();
}
function publicUrl(value, image = false) {
  if (typeof value !== 'string' || value.length > 500) fail('invalid_manifest_url');
  let url; try { url = new URL(value); } catch { fail('invalid_manifest_url'); }
  if (url.origin !== SITE || url.username || url.password || (image && !url.pathname.startsWith('/public/'))) fail('invalid_manifest_url');
  return url.href;
}

export function prepareRelease(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('invalid_manifest');
  if (Object.keys(manifest).some(key => !['id', 'title', 'changes', 'url', 'image', 'buttons', 'footer', 'seasonalImage'].includes(key))) fail('invalid_manifest');
  if (typeof manifest.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(manifest.id)) fail('invalid_release_id');
  if (manifest.seasonalImage !== undefined && typeof manifest.seasonalImage !== 'boolean') fail('invalid_manifest');
  if (manifest.seasonalImage && manifest.image !== undefined) fail('invalid_manifest');
  const title = cleanText(manifest.title, 140);
  if (!Array.isArray(manifest.changes) || !manifest.changes.length || manifest.changes.length > 8) fail('invalid_manifest');
  const changes = manifest.changes.map(value => cleanText(value, 360));
  const url = manifest.url === undefined ? null : publicUrl(manifest.url);
  const image = manifest.seasonalImage ? RELEASE_CARDS[0] : (manifest.image === undefined ? null : publicUrl(manifest.image, true));
  const footer = manifest.footer === undefined ? null : cleanText(manifest.footer, 240);
  if (manifest.buttons !== undefined && (!Array.isArray(manifest.buttons) || manifest.buttons.length > 2)) fail('invalid_manifest_buttons');
  const buttons = (manifest.buttons || []).map(button => {
    if (!button || Object.keys(button).some(key => !['text', 'url'].includes(key))) fail('invalid_manifest_buttons');
    return { text: cleanText(button.text, 48), url: publicUrl(button.url) };
  });
  const text = [title, changes.map(change => `• ${change}`).join('\n'), footer, url].filter(Boolean).join('\n\n');
  if (text.length > (image ? 1024 : 4096)) fail(image ? 'caption_too_long' : 'message_too_long');
  const method = image ? 'sendPhoto' : 'sendMessage';
  const payload = image ? { photo: image, caption: text } : { text, link_preview_options: { is_disabled: true } };
  if (buttons.length) payload.reply_markup = { inline_keyboard: [buttons] };
  // Hash the reviewed logical manifest, excluding its date-dependent image.
  const logicalPayload = manifest.seasonalImage ? { method, payload, seasonalImage: true } : { method, payload };
  return { id: manifest.id, method, payload, text, seasonalImage: manifest.seasonalImage === true, contentHash: hash(JSON.stringify(logicalPayload)) };
}

export function readBroadcastSource(db, env = process.env) {
  // Match server/index.js environmentWith: a stored empty string deliberately
  // disables the environment token, so do not use the || fallback operator.
  const row = db.prepare("SELECT value FROM app_settings WHERE key='telegramBotToken'").get();
  const token = String(row ? row.value : (env.PAGENT_TELEGRAM_BOT_TOKEN ?? '')).trim();
  const recipients = db.prepare(`SELECT DISTINCT CAST(t.chat_id AS TEXT) AS chat
    FROM telegram_links t JOIN users u ON u.id=t.user_id
    WHERE u.status='active' ORDER BY chat`).all().map(row => row.chat);
  return { token, recipients };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function openReceipts(filename) {
  const db = new Database(filename);
  fs.chmodSync(filename, 0o600);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = DELETE');
  // EXTRA also syncs the directory when the rollback journal is removed.
  db.pragma('synchronous = EXTRA');
  db.exec(`CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT, source_sha TEXT);
    CREATE TABLE IF NOT EXISTS receipts (
      release_id TEXT NOT NULL, chat_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','reserved','sent','rejected','uncertain','unlinked')),
      attempted_at TEXT, finished_at TEXT,
      PRIMARY KEY(release_id,chat_hash));
    CREATE TABLE IF NOT EXISTS broadcast_lock (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);`);
  return db;
}
function inspectReceipt(db, release) {
  const existing = db.prepare('SELECT content_hash,completed_at FROM releases WHERE id=?').get(release.id);
  if (existing && existing.content_hash !== release.contentHash) fail('release_content_changed');
  return existing;
}
function existingSnapshot(filename, release) {
  if (!fs.existsSync(filename)) return null;
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const existing = inspectReceipt(db, release);
    if (!existing) return null;
    const counts = Object.fromEntries(db.prepare('SELECT state,COUNT(*) AS count FROM receipts WHERE release_id=? GROUP BY state').all(release.id).map(row => [row.state, row.count]));
    return { completed: Boolean(existing.completed_at), counts };
  } finally { db.close(); }
}


// Called under the release lock/transaction for sends. A saved payload always
// wins: pending recipients on a retry see the exact same image as earlier ones.
function chooseReleaseCard(receipts, release, date, timeZone) {
  if (!release.seasonalImage) return;
  const existing = receipts?.prepare('SELECT payload_json FROM releases WHERE id=?').get(release.id);
  if (existing) {
    const saved = JSON.parse(existing.payload_json);
    release.payload = saved.payload;
    release.selectedAt = saved.selectedAt;
    return;
  }
  release.selectedAt = date.toISOString();
  try {
    release.payload = { ...release.payload, photo: selectSeasonalReleaseCard(date, timeZone) };
  } catch { fail('invalid_release_date'); }
}
function previewReleaseCard(filename, release, date, timeZone) {
  if (!release.seasonalImage) return;
  if (!fs.existsSync(filename)) { chooseReleaseCard(null, release, date, timeZone); return; }
  const receipts = new Database(filename, { readonly: true, fileMustExist: true });
  try { chooseReleaseCard(receipts, release, date, timeZone); } finally { receipts.close(); }
}

async function deliver(release, chat, token, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${release.method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ chat_id: chat, ...release.payload }), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    if (response.status === 200 && body?.ok === true && Number.isSafeInteger(body.result?.message_id)
        && body.result.message_id > 0 && String(body.result?.chat?.id) === chat) return 'sent';
    if (body?.ok === false && Number.isInteger(body.error_code) && body.error_code >= 400 && body.error_code < 500) return 'rejected';
    return 'uncertain';
  } catch {
    // Do not log fetch errors: their messages can contain the token-bearing URL.
    return 'uncertain';
  }
}

export async function announceRelease({ db, receiptsPath, manifest, env = process.env, send = false,
  fetchImpl = globalThis.fetch, timeoutMs = 15000, intervalMs = 100, now = () => new Date(), isProcessAlive = processAlive, releaseSha = null, releaseDate = null }) {
  const release = prepareRelease(manifest);
  const selectionDate = releaseDate === null ? new Date(now()) : new Date(releaseDate);
  if (!Number.isFinite(selectionDate.getTime()) || (releaseDate !== null &&
      (typeof releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(releaseDate) ||
       selectionDate.toISOString() !== releaseDate.replace(/Z$/, releaseDate.includes('.') ? 'Z' : '.000Z')))) fail('invalid_release_date');
  const timeZone = env.PAGENT_TIMEZONE || 'Europe/Samara';
  if (releaseSha !== null && !/^[a-f0-9]{40,64}$/.test(releaseSha)) fail('invalid_release_sha');
  if (path.resolve(receiptsPath) === path.resolve(db.name)) fail('receipts_must_be_separate');
  const initial = readBroadcastSource(db, env);
  const snapshot = existingSnapshot(receiptsPath, release); // Hash check precedes ANY skip.
  previewReleaseCard(receiptsPath, release, selectionDate, timeZone);
  const report = { releaseId: release.id, mode: send ? 'send' : 'dry-run', status: 'planned',
    eligible: initial.recipients.length, planned: snapshot ? (snapshot.counts.pending || 0) : initial.recipients.length,
    sent: 0, previousSent: snapshot?.counts.sent || 0, rejected: snapshot?.counts.rejected || 0,
    uncertain: (snapshot?.counts.uncertain || 0) + (snapshot?.counts.reserved || 0), unlinked: snapshot?.counts.unlinked || 0 };
  if (release.seasonalImage) report.image = release.payload.photo;
  if (snapshot?.completed) { report.status = 'complete'; report.planned = 0; return report; }
  if (!send) { report.status = 'dry-run'; report.tokenConfigured = Boolean(initial.token); return report; }
  if (!initial.token) { report.status = 'no-token'; return report; }
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,80}$/.test(initial.token)) fail('invalid_bot_configuration');
  if (!initial.recipients.length && !snapshot) { report.status = 'no-recipients'; return report; }

  const receipts = openReceipts(receiptsPath);
  const owner = crypto.randomUUID();
  let locked = false;
  const at = () => now().toISOString();
  try {
    locked = receipts.transaction(() => {
      const lock = receipts.prepare('SELECT owner,pid FROM broadcast_lock WHERE singleton=1').get();
      if (lock && isProcessAlive(lock.pid)) return false;
      receipts.prepare('INSERT OR REPLACE INTO broadcast_lock(singleton,owner,pid) VALUES(1,?,?)').run(owner, process.pid);
      return true;
    }).immediate();
    if (!locked) { report.status = 'locked'; return report; }

    receipts.transaction(() => {
      const existing = inspectReceipt(receipts, release);
      chooseReleaseCard(receipts, release, selectionDate, timeZone);
      if (release.seasonalImage) report.image = release.payload.photo;
      if (!existing) {
        receipts.prepare('INSERT INTO releases(id,content_hash,payload_json,created_at,source_sha) VALUES(?,?,?,?,?)')
          .run(release.id, release.contentHash, JSON.stringify({ method: release.method, payload: release.payload, ...(release.seasonalImage ? { selectedAt: release.selectedAt } : {}) }), at(), releaseSha);
        const insert = receipts.prepare("INSERT INTO receipts(release_id,chat_hash,state) VALUES(?,?,'pending')");
        // Freeze the first audience. Later registrations never receive old news.
        for (const chat of initial.recipients) insert.run(release.id, chatHash(chat));
      }
      // A crashed process may have reached Telegram after this reservation.
      receipts.prepare("UPDATE receipts SET state='uncertain',finished_at=? WHERE release_id=? AND state='reserved'").run(at(), release.id);
    }).immediate();
    const existing = inspectReceipt(receipts, release);
    if (!existing.completed_at) {
      const pending = receipts.prepare("SELECT chat_hash FROM receipts WHERE release_id=? AND state='pending' ORDER BY chat_hash").all(release.id);
      for (const target of pending) {
        // Recheck active account + binding immediately before each reservation.
        const current = readBroadcastSource(db, env);
        const chat = current.recipients.find(value => chatHash(value) === target.chat_hash);
        if (!chat) {
          receipts.prepare("UPDATE receipts SET state='unlinked',finished_at=? WHERE release_id=? AND chat_hash=? AND state='pending'").run(at(), release.id, target.chat_hash);
          continue;
        }
        // Configuration changes stop the run; remaining pending chats can be
        // handled later without changing any uncertain/sent reservations.
        if (current.token !== initial.token) { report.status = 'configuration-changed'; break; }
        const reserved = receipts.prepare("UPDATE receipts SET state='reserved',attempted_at=? WHERE release_id=? AND chat_hash=? AND state='pending'")
          .run(at(), release.id, target.chat_hash);
        if (reserved.changes !== 1) continue;
        const outcome = await deliver(release, chat, initial.token, fetchImpl, timeoutMs);
        receipts.prepare('UPDATE receipts SET state=?,finished_at=? WHERE release_id=? AND chat_hash=? AND state=\'reserved\'')
          .run(outcome, at(), release.id, target.chat_hash);
        if (outcome === 'sent') report.sent++;
        if (intervalMs > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
      const remaining = receipts.prepare("SELECT COUNT(*) AS count FROM receipts WHERE release_id=? AND state='pending'").get(release.id).count;
      if (!remaining) receipts.prepare('UPDATE releases SET completed_at=? WHERE id=? AND completed_at IS NULL').run(at(), release.id);
    }
    const states = Object.fromEntries(receipts.prepare('SELECT state,COUNT(*) AS count FROM receipts WHERE release_id=? GROUP BY state').all(release.id).map(row => [row.state, row.count]));
    report.previousSent = (states.sent || 0) - report.sent;
    report.planned = states.pending || 0;
    report.rejected = states.rejected || 0;
    report.uncertain = (states.uncertain || 0) + (states.reserved || 0);
    report.unlinked = states.unlinked || 0;
    if (report.status !== 'configuration-changed') report.status = report.planned ? 'partial' : 'complete';
    return report;
  } finally {
    if (locked) receipts.prepare('DELETE FROM broadcast_lock WHERE singleton=1 AND owner=?').run(owner);
    receipts.close();
  }
}

export function broadcastExitCode(report) {
  return report.rejected || report.uncertain || ['partial', 'configuration-changed', 'locked'].includes(report.status) ? 1 : 0;
}
