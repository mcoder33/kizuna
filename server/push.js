// Web Push: уведомления на закрытую вкладку и на телефон (iPhone — с iOS
// 16.4, если Кизуна добавлена на экран «Домой»). Пара ключей VAPID
// заводится один раз и хранится в настройках приложения: по ней браузер
// узнаёт, что слать в его подписку может именно этот сервер. Подписка — это
// устройство: адрес у неё уникален, и одна строка живёт у одного человека.
import crypto from 'node:crypto';
import webpush from 'web-push';
import { readSettings, writeSettings } from './db.js';

const PUBLIC_KEY = 'push:vapidPublic', PRIVATE_KEY = 'push:vapidPrivate';
const ENDPOINT_LIMIT = 2000, USER_AGENT_LIMIT = 300;

export function createPushService({ db, now = () => new Date(), transport = webpush, subject = 'mailto:kizuna@example.com', audit = () => {} }) {
  let cached = null;
  function keys() {
    if (cached) return cached;
    const stored = readSettings(db);
    if (stored[PUBLIC_KEY] && stored[PRIVATE_KEY]) cached = { publicKey: stored[PUBLIC_KEY], privateKey: stored[PRIVATE_KEY] };
    else {
      const generated = transport.generateVAPIDKeys();
      writeSettings(db, { [PUBLIC_KEY]: generated.publicKey, [PRIVATE_KEY]: generated.privateKey });
      cached = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    }
    return cached;
  }
  function publicKey() { return keys().publicKey; }
  function validSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    const { endpoint, keys: pair } = subscription;
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > ENDPOINT_LIMIT) return false;
    return Boolean(pair && typeof pair.p256dh === 'string' && typeof pair.auth === 'string' && pair.p256dh.length <= 200 && pair.auth.length <= 100);
  }
  function subscribe({ userId, subscription, userAgent = null }) {
    if (!validSubscription(subscription)) return { error: 'invalid_subscription' };
    const at = now().toISOString();
    const keysJson = JSON.stringify({ p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
    const agent = userAgent ? String(userAgent).slice(0, USER_AGENT_LIMIT) : null;
    // Тот же адрес мог остаться от прежней подписки: строка переезжает к
    // человеку, который подписался сейчас, а не плодит дубли.
    const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').get(subscription.endpoint);
    if (existing) {
      db.prepare('UPDATE push_subscriptions SET user_id=?, keys_json=?, user_agent=?, failed_at=NULL, fail_reason=NULL WHERE id=?').run(userId, keysJson, agent, existing.id);
      return { id: existing.id, created: false };
    }
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO push_subscriptions(id, user_id, endpoint, keys_json, user_agent, created_at) VALUES(?,?,?,?,?,?)').run(id, userId, subscription.endpoint, keysJson, agent, at);
    audit({ event: 'push_subscribed', userId });
    return { id, created: true };
  }
  function unsubscribe({ userId, endpoint }) {
    if (typeof endpoint !== 'string' || !endpoint) return { error: 'invalid_subscription' };
    const result = db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(userId, endpoint);
    if (result.changes) audit({ event: 'push_unsubscribed', userId });
    return { removed: result.changes > 0 };
  }
  function list(userId) {
    return db.prepare('SELECT id, endpoint, user_agent, created_at, last_used_at, failed_at, fail_reason FROM push_subscriptions WHERE user_id=? ORDER BY created_at').all(userId)
      .map(row => ({ id: row.id, endpoint: row.endpoint, host: hostOf(row.endpoint), userAgent: row.user_agent, createdAt: row.created_at, lastUsedAt: row.last_used_at, failedAt: row.failed_at, failReason: row.fail_reason }));
  }
  // Отправка всем устройствам человека. Подписка, которой больше нет
  // (404/410 от службы), удаляется; другая ошибка запоминается, но подписку
  // не убивает — сеть могла моргнуть.
  async function send(userId, payload) {
    const rows = db.prepare('SELECT id, endpoint, keys_json FROM push_subscriptions WHERE user_id=?').all(userId);
    const body = JSON.stringify(payload);
    const { publicKey: pub, privateKey } = keys();
    const summary = { sent: 0, failed: 0, dropped: 0 };
    for (const row of rows) {
      try {
        await transport.sendNotification({ endpoint: row.endpoint, keys: JSON.parse(row.keys_json) }, body, { vapidDetails: { subject, publicKey: pub, privateKey }, TTL: 60 * 60, urgency: 'high' });
        db.prepare('UPDATE push_subscriptions SET last_used_at=?, failed_at=NULL, fail_reason=NULL WHERE id=?').run(now().toISOString(), row.id);
        summary.sent += 1;
      } catch (error) {
        const status = Number(error?.statusCode);
        if (status === 404 || status === 410) { db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id); summary.dropped += 1; }
        else { db.prepare('UPDATE push_subscriptions SET failed_at=?, fail_reason=? WHERE id=?').run(now().toISOString(), String(error?.message || error?.code || 'push_error').slice(0, 200), row.id); summary.failed += 1; }
        audit({ event: 'push_failed', userId, statusCode: status || null });
      }
    }
    return summary;
  }
  return { publicKey, subscribe, unsubscribe, list, send };
}

function hostOf(endpoint) { try { return new URL(endpoint).host; } catch { return null; } }
