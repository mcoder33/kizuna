export function migrateAdministration(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    allow_contact INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','considering','done','later')),
    request_key TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, request_key)
  );
  CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, created_at);
  CREATE INDEX IF NOT EXISTS feedback_page ON feedback(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS feedback_user_page ON feedback(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS feedback_status_page ON feedback(status, created_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS feedback_replies (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_replies_thread ON feedback_replies(feedback_id, created_at);
  CREATE TABLE IF NOT EXISTS admin_telegram_deliveries (
    event_key TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    lease_until TEXT,
    message_id INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    PRIMARY KEY(event_key, user_id)
  );
  CREATE INDEX IF NOT EXISTS admin_telegram_due ON admin_telegram_deliveries(state, next_attempt_at);`);
}
