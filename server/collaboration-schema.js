// R3–R16: explicit collaboration storage, without changing private associations.
export function migrateCollaboration(db) {
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=28').get()) {
  db.transaction(() => {
    db.exec(`CREATE TABLE circle_members_editor (
      circle_id TEXT NOT NULL REFERENCES circles(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('owner','member','editor')), joined_at TEXT NOT NULL,
      muted_at TEXT, left_at TEXT, added_by TEXT REFERENCES users(id), seen_at TEXT,
      PRIMARY KEY(circle_id,user_id));
      INSERT INTO circle_members_editor SELECT circle_id,user_id,role,joined_at,muted_at,left_at,added_by,seen_at FROM circle_members;
      DROP TABLE circle_members;
      ALTER TABLE circle_members_editor RENAME TO circle_members;
      CREATE INDEX circle_members_user ON circle_members(user_id,left_at);
      ALTER TABLE capture_circles ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE public_todo_shares (
        id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        circle_id TEXT NOT NULL REFERENCES circles(id), token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE INDEX public_todo_shares_capture ON public_todo_shares(capture_id,circle_id);
      CREATE TABLE circle_share_denials (
        circle_id TEXT NOT NULL REFERENCES circles(id), user_id TEXT NOT NULL REFERENCES users(id),
        denied_at TEXT NOT NULL, PRIMARY KEY(circle_id,user_id));
      CREATE TABLE collaborative_documents (
        capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
        generation TEXT NOT NULL, state BLOB NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL, checkpoint_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE collaborative_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL, actor_id TEXT, revision INTEGER NOT NULL,
        update_hash TEXT NOT NULL, update_bytes BLOB NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(capture_id,actor_id,operation_id), UNIQUE(capture_id,update_hash));
      CREATE TABLE collaborative_commands (
        capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE, actor_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY(capture_id,actor_id,operation_id));
      CREATE TABLE collaborative_structure (
        capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0);
      INSERT INTO schema_migrations(version,applied_at) VALUES(28,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
  })();
  }
  // A circle owner may explicitly consent to editing without losing management.
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=29').get()) db.transaction(() => {
    db.exec('ALTER TABLE circle_members ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0 CHECK(can_edit IN (0,1))');
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(29,?)').run(new Date().toISOString());
  })();
}
