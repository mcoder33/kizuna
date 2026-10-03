// Run over stdin from the deployed application directory; never starts services.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readSettings, recordUsage, monthlySpend } from './server/db.js';
import { userTimeZone } from './server/time-zone.js';
import { reviewDay } from './server/day-review.js';
import { renderDaySummaryMessage } from './server/telegram-day-summary-renderer.js';
import { createReportImageService } from './server/report-images.js';
import { sendTelegramReport } from './server/telegram-report-message.js';
import { readBoundedBody, withDeadline } from './server/safe-http.js';
import { validIsoDate } from './server/repeat.js';

const [mode, requested, date, expectedUserId, operationId] = process.argv.slice(2);
let db, receiptPath, attemptStarted = false, ownsReceipt = false;
const reject = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const writeReceipt = value => fs.writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
try {
  if (!['inspect', 'send'].includes(mode) || !/^@?[A-Za-z0-9_]{3,64}$/.test(requested || '') || !validIsoDate(date) || !/^[A-Za-z0-9-]{8,100}$/.test(operationId || '')) reject('invalid_arguments');
  const deployedSha = fs.readFileSync('/opt/kizuna/.deployed-sha', 'utf8').trim();
  if (deployedSha !== '38ae65bf986ab2795007290b3b1e6e56a9853f52') reject('deployed_version_changed');
  const databasePath = path.resolve(process.env.PAGENT_DB_PATH || path.join(process.cwd(), 'data', 'pagent.sqlite'));
  db = new Database(databasePath, { readonly: true, fileMustExist: true });
  const handle = requested.replace(/^@/, '').toLowerCase();
  const lookup = db.prepare(`SELECT u.id, u.status, u.display_name, u.monthly_limit_usd, l.telegram_id, l.chat_id, l.username, l.linked_at
    FROM users u JOIN telegram_links l ON l.user_id=u.id
    WHERE lower(l.username)=? OR lower(u.display_name)=? OR lower(substr(u.email,1,instr(u.email,'@')-1))=?`);
  const matches = lookup.all(handle, handle, handle);
  const exactTelegram = matches.filter(row => (row.username || '').toLowerCase() === handle);
  const candidates = exactTelegram.length ? exactTelegram : matches;
  if (candidates.length !== 1) reject(candidates.length ? 'recipient_ambiguous' : 'recipient_not_found');
  const target = candidates[0];
  if (target.status !== 'active' || String(target.chat_id) !== String(target.telegram_id)) reject('recipient_not_active_or_private');
  const settings = readSettings(db), env = { ...process.env };
  for (const [key, name] of Object.entries({ openaiKey: 'OPENAI_API_KEY', geminiKey: 'GEMINI_API_KEY', aiProvider: 'PAGENT_AI_PROVIDER', telegramBotToken: 'PAGENT_TELEGRAM_BOT_TOKEN' })) if (settings[key] !== undefined) env[name] = settings[key];
  const zone = userTimeZone(db, target.id, settings.timeZone || env.PAGENT_TIMEZONE || 'Europe/Samara');
  if (!env.PAGENT_TELEGRAM_BOT_TOKEN) reject('telegram_not_configured');
  if (mode === 'inspect') {
    console.log(JSON.stringify({ status: 'recipient_verified', recipient: requested, userId: target.id, telegramUsername: target.username, date, phase: 'evening', timeZone: zone,
      imageKeyConfigured: Boolean(env.OPENAI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY) }));
  } else {
    if (target.id !== expectedUserId) reject('recipient_identity_changed');
    const readLink = db.prepare('SELECT u.status,l.* FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE u.id=?');
    const allowed = () => { const current = readLink.get(target.id); return current?.status === 'active' && String(current.chat_id) === String(target.chat_id) && String(current.telegram_id) === String(target.telegram_id) && current.linked_at === target.linked_at; };
    const receiptDirectory = path.join(path.dirname(databasePath), 'test-report-receipts');
    fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
    receiptPath = path.join(receiptDirectory, `${operationId}.json`);
    if (fs.existsSync(receiptPath)) {
      const prior = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (prior.userId !== target.id || prior.date !== date) reject('operation_identity_mismatch');
      console.log(JSON.stringify({ status: 'already_processed', deliveryStatus: prior.status, messageId: prior.messageId || null }));
      if (prior.status !== 'sent') process.exitCode = 1;
    } else {
      fs.writeFileSync(receiptPath, JSON.stringify({ status: 'preparing', userId: target.id, date }), { flag: 'wx', mode: 0o600 }); ownsReceipt = true;
      const images = createReportImageService({ directory: path.join(path.dirname(databasePath), 'report-images'), env: () => env,
        allowGenerate: () => { const limit = target.monthly_limit_usd ?? (settings.monthlyLimitUsd ? Number(settings.monthlyLimitUsd) : null); return allowed() && (limit === null || monthlySpend(db, { userId: target.id, timeZone: zone }).totalUsd < limit); },
        onUsage: result => { const usageDb = new Database(databasePath, { fileMustExist: true }); try { recordUsage(usageDb, { provider: result.usedProvider, model: result.model, kind: 'report_image', userId: target.id, ...result.usage }); } finally { usageDb.close(); } } });
      const image = await images.prepare({ userId: target.id, date, phase: 'evening', timeZone: zone, now: new Date() });
      const message = () => { if (!allowed()) return null; const body = renderDaySummaryMessage(reviewDay(db, { userId: target.id, date, phase: 'evening', timeZone: zone, now: new Date() })); return allowed() ? { ...body, text: `${body.text}\n\n🧪 Тестовый вечерний отчёт.` } : null; };
      const payload = message(); if (!payload) reject('recipient_binding_changed');
      async function call(method, params, file = null) {
        return withDeadline(async signal => {
          let body, headers;
          if (file) { body = new FormData(); for (const [key, value] of Object.entries(params)) body.append(key, typeof value === 'string' ? value : JSON.stringify(value)); body.append('report', new Blob([file.bytes], { type: file.type }), file.filename); }
          else { body = JSON.stringify(params); headers = { 'Content-Type': 'application/json' }; }
          const response = await fetch(`https://api.telegram.org/bot${env.PAGENT_TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', body, headers, signal, redirect: 'error' });
          const result = JSON.parse((await readBoundedBody(response, { maxBytes: 2 * 1024 * 1024, signal })).toString('utf8'));
          if (!result.ok) throw Object.assign(new Error('telegram_rejected'), { status: result.error_code || response.status });
          return result.result;
        }, { timeoutMs: 20000 });
      }
      writeReceipt({ status: 'sending', userId: target.id, date }); attemptStarted = true;
      const result = await sendTelegramReport({ chatId: target.chat_id, ...payload, image, stillAllowed: allowed, refreshMessage: message,
        sendText: (chatId, text, extra) => call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra }),
        sendPhoto: (chatId, photo, extra) => call('sendPhoto', { chat_id: chatId, photo: 'attach://report', ...extra }, photo) });
      if (!result?.message_id) reject('delivery_not_confirmed');
      writeReceipt({ status: 'sent', userId: target.id, date, messageId: result.message_id, sentAt: new Date().toISOString() });
      console.log(JSON.stringify({ status: 'sent', recipient: requested, date, phase: 'evening', image: Boolean(image), messageId: result.message_id }));
    }
  }
} catch (error) {
  if (ownsReceipt) try { const prior = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); if (prior.status !== 'sent') writeReceipt({ ...prior, status: attemptStarted ? 'uncertain' : 'failed' }); } catch {}
  console.error(JSON.stringify({ status: 'error', code: error.safeCode || (error.status ? `telegram_${error.status}` : 'test_report_failed') }));
  process.exitCode = 1;
} finally { db?.close(); }
