import crypto from 'node:crypto';
import { notify } from './notifications.js';
import { listFacts, rememberFact, forgetFact, MEMORY_TEXT_LIMIT } from './memory.js';
import { logAuthEvent, writeSettings } from './db.js';

export const FEEDBACK_STATUSES = ['new', 'considering', 'done', 'later'];
const PREF_KEY = 'adminNotifyPrefs';
const DEFAULT_PREFS = { signup: { app: true, telegram: true }, feedback: { app: true, telegram: true } };
const keyValid = key => typeof key === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(key);
const textValid = text => typeof text === 'string' && text.trim().length > 0 && text.trim().length <= 3000;
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

export function adminNotificationPrefs(db) {
  let saved = {};
  try { saved = JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key=?').get(PREF_KEY)?.value || '{}'); } catch {}
  return Object.fromEntries(Object.entries(DEFAULT_PREFS).map(([kind, defaults]) => [kind,
    Object.fromEntries(Object.entries(defaults).map(([channel, value]) => [channel, typeof saved?.[kind]?.[channel] === 'boolean' ? saved[kind][channel] : value]))]));
}

export function createAdministration({ db, now = () => new Date(), sendTelegram, botConfigured = () => false, onChange = () => {}, audit = () => {} }) {
  const at = () => now().toISOString();
  let flushing = null;
  const admins = () => db.prepare("SELECT id,email,display_name AS name FROM users WHERE role='admin' AND status='active'").all();
  const changed = () => { try { onChange(admins().map(user => user.id)); } catch {} };
  const note = event => { try { audit(event); } catch {} };
  // Upgrade the signup notices created before the separate admin inbox: attach
  // a stable event key and retire requests that have already been considered.
  db.transaction(() => {
    for (const row of db.prepare("SELECT * FROM notifications WHERE kind='signup' AND group_key IS NULL").all()) {
      const user = db.prepare('SELECT id,status FROM users WHERE email=?').get(row.text);
      if (!user || user.status !== 'pending') db.prepare('UPDATE notifications SET resolved_at=COALESCE(resolved_at,?),read_at=COALESCE(read_at,?) WHERE id=?').run(at(), at(), row.id);
      else {
        let data = {}; try { data = JSON.parse(row.data_json); } catch {}
        db.prepare('UPDATE notifications SET group_key=?,data_json=? WHERE id=?').run(`signup:${user.id}`, JSON.stringify({ ...data, eventId: user.id, admin: true, url: `/#admin/inbox?user=${user.id}` }), row.id);
      }
    }
  })();

  function publish({ kind, eventId, text, url }) {
    const prefs = adminNotificationPrefs(db)[kind];
    if (!prefs) return;
    const eventKey = `${kind}:${eventId}`;
    const lead = kind === 'signup' ? 'Новая заявка на вход:' : 'Новое пожелание:';
    db.transaction(() => {
      for (const admin of admins()) {
        if (prefs.app) notify(db, { userId: admin.id, kind, lead, template: { lead: { source: lead } }, text,
          group: eventKey, once: true, force: true, at: at(), data: { url, eventId, admin: true } });
        const link = db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(admin.id);
        if (prefs.telegram && link) db.prepare(`INSERT OR IGNORE INTO admin_telegram_deliveries
          (event_key,user_id,kind,chat_id,telegram_id,text,url,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(eventKey, admin.id, kind, link.chat_id, link.telegram_id, `${lead}\n${text.slice(0, 1000)}`, url, at(), at());
      }
    })();
    changed();
    // HTTP completion never waits for an external messenger. The persisted queue
    // is retried by notificationTick, including after a process restart.
    queueMicrotask(() => { void flush(); });
  }

  function resolve(kind, eventId) {
    const stamp = at(), group = `${kind}:${eventId}`;
    db.prepare('UPDATE notifications SET resolved_at=?,read_at=COALESCE(read_at,?) WHERE group_key=? AND resolved_at IS NULL').run(stamp, stamp, group);
    db.prepare("UPDATE admin_telegram_deliveries SET state='cancelled' WHERE event_key=? AND state IN ('pending','sending')").run(group);
    changed();
  }

  function flush() {
    if (flushing) return flushing;
    flushing = drain().catch(() => { note({ event: 'admin_telegram_queue_failed' }); }).finally(() => { flushing = null; });
    return flushing;
  }
  async function drain() {
    if (!botConfigured()) return;
    const stamp = at();
    // A lease lets an interrupted send be retried after restart. Telegram has no
    // idempotency key: an ambiguous network acknowledgement can cause a repeat.
    db.prepare("UPDATE admin_telegram_deliveries SET state='pending' WHERE state='sending' AND lease_until<=?").run(stamp);
    const rows = db.prepare("SELECT * FROM admin_telegram_deliveries WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 50").all(stamp);
    for (const row of rows) {
      const eventId = row.event_key.slice(row.kind.length + 1);
      const eventOpen = row.kind === 'signup'
        ? db.prepare("SELECT 1 FROM users WHERE id=? AND status='pending'").get(eventId)
        : db.prepare("SELECT 1 FROM feedback WHERE id=? AND status='new'").get(eventId);
      const user = db.prepare('SELECT role,status FROM users WHERE id=?').get(row.user_id);
      const link = db.prepare('SELECT chat_id,telegram_id FROM telegram_links WHERE user_id=?').get(row.user_id);
      if (!eventOpen || user?.role !== 'admin' || user.status !== 'active' || !link || link.chat_id !== row.chat_id || link.telegram_id !== row.telegram_id || !adminNotificationPrefs(db)[row.kind]?.telegram) {
        db.prepare("UPDATE admin_telegram_deliveries SET state='cancelled' WHERE event_key=? AND user_id=? AND state='pending'").run(row.event_key, row.user_id);
        continue;
      }
      const claim = db.prepare("UPDATE admin_telegram_deliveries SET state='sending',lease_until=?,attempts=attempts+1 WHERE event_key=? AND user_id=? AND state='pending'")
        .run(new Date(now().getTime() + 120000).toISOString(), row.event_key, row.user_id);
      if (!claim.changes) continue;
      try {
        const sent = await sendTelegram({ userId: row.user_id, chatId: row.chat_id, text: row.text, url: row.url });
        db.prepare("UPDATE admin_telegram_deliveries SET state='sent',sent_at=?,message_id=?,lease_until=NULL,error_code=NULL WHERE event_key=? AND user_id=? AND state='sending' AND attempts=?")
          .run(at(), sent?.message_id ?? null, row.event_key, row.user_id, row.attempts + 1);
      } catch (error) {
        const permanent = [400, 403].includes(error?.status);
        const delay = Math.max(Number(error?.retryAfter) * 1000 || 0, Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7)));
        db.prepare("UPDATE admin_telegram_deliveries SET state=?,next_attempt_at=?,lease_until=NULL,error_code=? WHERE event_key=? AND user_id=? AND state='sending' AND attempts=?")
          .run(permanent ? 'failed' : 'pending', new Date(now().getTime() + delay).toISOString(), String(error?.status || 'network'), row.event_key, row.user_id, row.attempts + 1);
        note({ event: 'admin_telegram_failed', errorCode: error?.status || 'network', retry: !permanent });
      }
    }
    // Bound receipt history; pending deliveries are retained for recovery.
    db.prepare("DELETE FROM admin_telegram_deliveries WHERE state IN ('sent','failed','cancelled') AND created_at<?").run(new Date(now().getTime() - 90 * 86400000).toISOString());
  }

  function feedbackView(row, { admin = false } = {}) {
    const replies = db.prepare('SELECT id,text,created_at FROM feedback_replies WHERE feedback_id=? ORDER BY created_at,id').all(row.id)
      .map(reply => ({ id: reply.id, text: reply.text, createdAt: reply.created_at }));
    return { id: row.id, text: row.text, allowContact: Boolean(row.allow_contact), status: row.status, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, replies,
      ...(admin ? { userId: row.user_id, name: row.name || null, email: row.email || null } : {}) };
  }
  function listFeedback({ userId = null, status = null, before = null, q = '', limit = 50 } = {}) {
    const where = [], args = [];
    if (userId) { where.push('f.user_id=?'); args.push(userId); }
    if (status) { where.push('f.status=?'); args.push(status); }
    if (before) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString()); } catch {}
      if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || typeof cursor[1] !== 'string' || cursor[0].length > 40 || cursor[1].length > 80) return null;
      where.push('(f.created_at<? OR (f.created_at=? AND f.id<?))'); args.push(cursor[0], cursor[0], cursor[1]);
    }
    if (q) { where.push("(f.text LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')"); const search = `%${q.replace(/[\\%_]/g, '\\$&')}%`; args.push(search, search, search); }
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const rows = db.prepare(`SELECT f.*,u.display_name AS name,u.email FROM feedback f LEFT JOIN users u ON u.id=f.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.created_at DESC,f.id DESC LIMIT ?`).all(...args, capped + 1);
    const more = rows.length > capped; if (more) rows.pop();
    return { feedback: rows.map(row => feedbackView(row, { admin: !userId })),
      nextCursor: more ? Buffer.from(JSON.stringify([rows.at(-1).created_at, rows.at(-1).id])).toString('base64url') : null };
  }
  const singleFeedback = (id, userId = null) => {
    const row = db.prepare(`SELECT f.*,u.display_name AS name,u.email FROM feedback f LEFT JOIN users u ON u.id=f.user_id WHERE f.id=?${userId ? ' AND f.user_id=?' : ''}`).get(...(userId ? [id, userId] : [id]));
    return row ? feedbackView(row, { admin: !userId }) : null;
  };
  const log = (req, event, detail = '') => logAuthEvent(db, { userId: req.user.id, email: req.user.email, event, result: 'succeeded', detail, createdAt: at() });

  function registerRoutes(app, requireAdmin) {
    const list = (req, res, userId = null) => {
      const { before, status, q, limit } = req.query;
      if ((before !== undefined && (typeof before !== 'string' || before.length > 300)) || (status !== undefined && !FEEDBACK_STATUSES.includes(status)) || (q !== undefined && (typeof q !== 'string' || q.length > 200)) || (limit !== undefined && (typeof limit !== 'string' || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100))) return fail(res, 400, 'invalid_feedback_query', 'Некорректные параметры списка пожеланий.');
      const result = listFeedback({ userId, status, before, q, limit });
      if (!result) return fail(res, 400, 'invalid_feedback_query', 'Некорректные параметры списка пожеланий.');
      res.json(result);
    };
    app.get('/api/feedback', (req, res) => list(req, res, req.user.id));
    app.get('/api/feedback/:id', (req, res) => {
      const feedback = singleFeedback(req.params.id, req.user.id);
      return feedback ? res.json({ feedback }) : fail(res, 404, 'not_found', 'Пожелание не найдено.');
    });
    app.post('/api/feedback', (req, res, next) => { try {
      const { text, allowContact = false } = req.body || {}, key = req.get('Idempotency-Key');
      if (!textValid(text) || typeof allowContact !== 'boolean') return fail(res, 400, 'invalid_feedback', 'Пожелание — от 1 до 3000 символов.');
      if (!keyValid(key)) return fail(res, 400, 'invalid_idempotency_key', 'Некорректный ключ идемпотентности.');
      const existing = db.prepare('SELECT * FROM feedback WHERE user_id=? AND request_key=?').get(req.user.id, key);
      if (existing) {
        if (existing.text !== text.trim() || Boolean(existing.allow_contact) !== allowContact) return fail(res, 409, 'idempotency_conflict', 'Это пожелание уже отправлено с другим текстом.');
        return res.json({ feedback: feedbackView(existing), replayed: true });
      }
      const count = db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id=? AND created_at>=?').get(req.user.id, new Date(now().getTime() - 3600000).toISOString()).n;
      if (count >= 5) { res.set('Retry-After', '3600'); return fail(res, 429, 'feedback_limit', 'За час можно отправить до пяти пожеланий.'); }
      const id = crypto.randomUUID();
      db.transaction(() => {
        db.prepare('INSERT INTO feedback(id,user_id,text,allow_contact,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, req.user.id, text.trim(), allowContact ? 1 : 0, key, at(), at());
        publish({ kind: 'feedback', eventId: id, text: `${req.user.display_name || req.user.email}\n${text.trim()}`, url: `/#admin/feedback?id=${id}` });
      })();
      res.status(201).json({ feedback: feedbackView(db.prepare('SELECT * FROM feedback WHERE id=?').get(id)) });
    } catch (error) { next(error); } });
    app.get('/api/admin/feedback', requireAdmin, (req, res) => list(req, res));
    app.get('/api/admin/feedback/:id', requireAdmin, (req, res) => {
      const feedback = singleFeedback(req.params.id);
      return feedback ? res.json({ feedback }) : fail(res, 404, 'not_found', 'Пожелание не найдено.');
    });
    app.patch('/api/admin/feedback/:id', requireAdmin, (req, res, next) => { try {
      const row = db.prepare('SELECT * FROM feedback WHERE id=?').get(req.params.id);
      if (!row) return fail(res, 404, 'not_found', 'Пожелание не найдено.');
      const { status = row.status, reply = '', revision } = req.body || {};
      if (!FEEDBACK_STATUSES.includes(status) || typeof reply !== 'string' || reply.length > 3000 || !Number.isInteger(revision)) return fail(res, 400, 'invalid_feedback', 'Некорректное изменение пожелания.');
      if (revision !== row.revision) return fail(res, 409, 'feedback_changed', 'Пожелание уже изменено. Обновите страницу.');
      db.transaction(() => {
        db.prepare('UPDATE feedback SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(status, at(), row.id);
        if (reply.trim()) {
          const replyId = crypto.randomUUID();
          db.prepare('INSERT INTO feedback_replies(id,feedback_id,author_id,text,created_at) VALUES(?,?,?,?,?)').run(replyId, row.id, req.user.id, reply.trim(), at());
          if (row.user_id) notify(db, { userId: row.user_id, kind: 'feedback_reply', lead: 'Ответ на ваше пожелание:',
            template: { lead: { source: 'Ответ на ваше пожелание:' } }, text: reply.trim(), group: `feedback_reply:${replyId}`, once: true, at: at(), data: { url: `/#feedback?id=${row.id}` } });
        }
        if (status !== 'new') resolve('feedback', row.id);
        log(req, 'admin_feedback', `${row.id} · ${status}`);
      })();
      changed();
      res.json({ feedback: singleFeedback(row.id) });
    } catch (error) { next(error); } });
    app.get('/api/admin/inbox', requireAdmin, (req, res) => res.json({
      pending: db.prepare("SELECT id,email,display_name AS name,created_at AS createdAt FROM users WHERE status='pending' ORDER BY created_at DESC").all(),
      feedback: listFeedback({ status: 'new', limit: 100 }).feedback,
      feedbackCount: db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status='new'").get().n,
      notifications: db.prepare("SELECT id,kind,text,data_json AS data,created_at AS createdAt,read_at AS readAt FROM notifications WHERE user_id=? AND kind IN ('signup','feedback') AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 100").all(req.user.id).map(row => ({ ...row, data: JSON.parse(row.data) })),
    }));
    app.get('/api/admin/notification-settings', requireAdmin, (req, res) => res.json({ preferences: adminNotificationPrefs(db), botConfigured: botConfigured(),
      recipients: admins().map(user => ({ ...user, telegramLinked: Boolean(db.prepare('SELECT 1 FROM telegram_links WHERE user_id=?').get(user.id)) })),
      deliveries: db.prepare('SELECT state,COUNT(*) AS count FROM admin_telegram_deliveries GROUP BY state').all() }));
    app.put('/api/admin/notification-settings', requireAdmin, (req, res) => {
      const prefs = req.body?.preferences;
      if (!prefs || Object.keys(prefs).length !== 2 || !Object.keys(DEFAULT_PREFS).every(kind => prefs[kind] && Object.keys(prefs[kind]).length === 2 && ['app','telegram'].every(channel => typeof prefs[kind][channel] === 'boolean')))
        return fail(res, 400, 'invalid_preferences', 'Некорректные настройки уведомлений.');
      writeSettings(db, { [PREF_KEY]: JSON.stringify(prefs) }); log(req, 'admin_notifications'); changed();
      res.json({ preferences: adminNotificationPrefs(db) });
    });
    app.get('/api/admin/memory', requireAdmin, (req, res) => res.json({ memories: listFacts(db, { scope: 'shared' }) }));
    app.post('/api/admin/memory', requireAdmin, (req, res) => {
      const text = req.body?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > MEMORY_TEXT_LIMIT) return fail(res, 400, 'invalid_memory', 'Правило — от 1 до 500 символов.');
      const result = rememberFact(db, { userId: null, kind: 'rule', body: text, subject: text, source: 'manual', confidence: 0.95 });
      log(req, 'admin_memory'); res.status(result.created ? 201 : 200).json({ memories: listFacts(db, { scope: 'shared' }) });
    });
    app.delete('/api/admin/memory/:id', requireAdmin, (req, res) => {
      const row = db.prepare('SELECT user_id FROM agent_memories WHERE id=?').get(req.params.id);
      if (!row || row.user_id !== null) return fail(res, 404, 'not_found', 'Правило не найдено.');
      forgetFact(db, { memoryId: req.params.id, shared: true }); log(req, 'admin_memory_delete');
      res.json({ memories: listFacts(db, { scope: 'shared' }) });
    });
  }
  return { publish, resolve, registerRoutes, flush, changed };
}
