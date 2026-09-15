import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeProjections, gateClassification, shouldMaterializeProjections } from './classifier.js';
import { occursOn, nextOccurrence } from './repeat.js';

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  repairMissingProjections(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, raw TEXT NOT NULL, modality TEXT NOT NULL DEFAULT 'text', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, privacy_scope TEXT NOT NULL DEFAULT 'private', deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS interpretations (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','rejected')), provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter','fallback','codex-cli','claude-cli','manual')), model TEXT, classification_json TEXT NOT NULL, field_confidence_json TEXT NOT NULL, created_at TEXT NOT NULL, supersedes_id TEXT REFERENCES interpretations(id));
    CREATE UNIQUE INDEX IF NOT EXISTS interpretations_active_capture ON interpretations(capture_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), interpretation_id TEXT NOT NULL REFERENCES interpretations(id), correction_json TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projections (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), interpretation_id TEXT NOT NULL REFERENCES interpretations(id), projection_type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','reverted')), undo_group_id TEXT NOT NULL, created_at TEXT NOT NULL, reverted_at TEXT);
    CREATE TABLE IF NOT EXISTS activity_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_jobs (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL REFERENCES captures(id),
      selected_provider TEXT NOT NULL CHECK(selected_provider IN ('fallback','openai','openrouter','codex-cli','claude-cli')),
      state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','cancelled')),
      stage TEXT NOT NULL CHECK(stage IN ('queued','classifying','complete','failed','cancelled')),
      retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
      retry_of_id TEXT REFERENCES capture_jobs(id),
      idempotency_key TEXT UNIQUE,
      request_fingerprint TEXT,
      lease_owner TEXT,
      lease_token TEXT,
      lease_fence INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      used_provider TEXT CHECK(used_provider IS NULL OR used_provider IN ('fallback','openai','openrouter','codex-cli','claude-cli')),
      model TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS capture_jobs_claimable ON capture_jobs(state, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS capture_jobs_capture_id ON capture_jobs(capture_id, created_at);
    CREATE TABLE IF NOT EXISTS capture_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES capture_jobs(id),
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS capture_job_events_job_id ON capture_job_events(job_id, created_at);
    CREATE TABLE IF NOT EXISTS ledger_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      capture_id TEXT REFERENCES captures(id),
      job_id TEXT REFERENCES capture_jobs(id),
      projection_id TEXT REFERENCES projections(id),
      interpretation_id TEXT REFERENCES interpretations(id),
      actor TEXT,
      occurred_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_events_capture_id ON ledger_events(capture_id, created_at);
    CREATE TABLE IF NOT EXISTS daily_briefs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      brief_date TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      revision INTEGER NOT NULL,
      generated_at TEXT NOT NULL,
      content_json TEXT NOT NULL,
      effective_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, brief_date, time_zone, revision),
      UNIQUE(user_id, brief_date, time_zone, effective_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS daily_brief_sources (
      id TEXT PRIMARY KEY,
      daily_brief_id TEXT NOT NULL REFERENCES daily_briefs(id),
      section_key TEXT NOT NULL,
      item_key TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('capture','projection','interpretation','ledger_event')),
      source_id TEXT NOT NULL,
      capture_id TEXT REFERENCES captures(id),
      projection_id TEXT REFERENCES projections(id),
      interpretation_id TEXT REFERENCES interpretations(id),
      ledger_event_id TEXT REFERENCES ledger_events(id),
      created_at TEXT NOT NULL,
      UNIQUE(daily_brief_id, section_key, item_key, source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS daily_brief_sources_capture_id ON daily_brief_sources(capture_id, created_at);`);
    const dailyBriefColumns = new Set(db.prepare('PRAGMA table_info(daily_briefs)').all().map(column => column.name));
    if (!dailyBriefColumns.has('revision')) migrateLegacyDailyBriefs(db, dailyBriefColumns);
    if (new Set(db.prepare('PRAGMA table_info(daily_briefs)').all().map(column => column.name)).has('user_id')) db.exec('CREATE INDEX IF NOT EXISTS daily_briefs_latest ON daily_briefs(user_id, brief_date, time_zone, revision DESC)');
    const ledgerColumns = new Set(db.prepare('PRAGMA table_info(ledger_events)').all().map(column => column.name));
    for (const [name, definition] of [['projection_id','TEXT REFERENCES projections(id)'],['interpretation_id','TEXT REFERENCES interpretations(id)'],['actor','TEXT'],['occurred_at','TEXT']]) if (!ledgerColumns.has(name)) db.exec(`ALTER TABLE ledger_events ADD COLUMN ${name} ${definition}`);
    migrateLedgerEventProvenance(db);
    createLedgerEventGuards(db);
    const interpretationSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='interpretations'").get()?.sql || '';
    if (!interpretationSql.includes("'codex-cli'")) {
      db.exec(`PRAGMA foreign_keys = OFF;
        CREATE TABLE interpretations_next (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','rejected')), provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter','fallback','codex-cli','claude-cli','manual')), model TEXT, classification_json TEXT NOT NULL, field_confidence_json TEXT NOT NULL, created_at TEXT NOT NULL, supersedes_id TEXT REFERENCES interpretations(id));
        INSERT INTO interpretations_next SELECT * FROM interpretations;
        DROP INDEX IF EXISTS interpretations_active_capture;
        DROP TABLE interpretations;
        ALTER TABLE interpretations_next RENAME TO interpretations;
        CREATE UNIQUE INDEX interpretations_active_capture ON interpretations(capture_id) WHERE status='active';
        PRAGMA foreign_keys = ON;`);
    }
    const correctionColumns = new Set(db.prepare('PRAGMA table_info(corrections)').all().map(column => column.name));
    if (!correctionColumns.has('operation_key')) db.exec('ALTER TABLE corrections ADD COLUMN operation_key TEXT');
    if (!correctionColumns.has('request_fingerprint')) db.exec('ALTER TABLE corrections ADD COLUMN request_fingerprint TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS corrections_capture_operation ON corrections(capture_id, operation_key) WHERE operation_key IS NOT NULL');
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(4, now());
    migrateOpenRouterProvider(db);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(5, now());
    // Миграция 6: пользовательские заметки к записи. Отдельная сущность, а не
    // правка capture.raw: контракт памяти запрещает менять источник, поэтому
    // тело версионируется append-only со ссылкой supersedes, как интерпретации.
    db.exec(`CREATE TABLE IF NOT EXISTS capture_notes (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL REFERENCES captures(id),
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','superseded')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      supersedes_id TEXT REFERENCES capture_notes(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS capture_notes_active ON capture_notes(capture_id) WHERE status='active';
    CREATE INDEX IF NOT EXISTS capture_notes_capture ON capture_notes(capture_id, created_at);`);
  // Расход на модели: сколько запросов и токенов ушло и во что это обошлось.
  // Деньги хранятся отдельным полем и могут быть пустыми: цену знает не каждый
  // провайдер, и выдумывать её нельзя.
  db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT,
      kind TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(created_at);`);
  // Настройки приложения: то, что раньше жило только в .env и правилось руками.
  // Отдельная таблица, а не часть журнала: это конфигурация, а не записи —
  // поэтому она не попадает в экспорт и переживает очистку данных.
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  // Вложения: сами файлы лежат на диске в data/attachments, в базе — только
  // описание. Байты в SQLite раздули бы и базу, и экспорт; на диске файл
  // называется своим id, а человеческое имя хранится отдельно — значит, из
  // имени файла нельзя выйти за пределы каталога.
  db.exec(`CREATE TABLE IF NOT EXISTS capture_attachments (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL REFERENCES captures(id),
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS capture_attachments_capture ON capture_attachments(capture_id, created_at);`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(6, now());
    // Миграция 7: ручные параметры записи (тип/срок/важность/теги из карточки
    // ввода) сохраняются с заданием и накладываются после разбора моделью.
    const overrideColumns = new Set(db.prepare('PRAGMA table_info(capture_jobs)').all().map(column => column.name));
    if (!overrideColumns.has('overrides_json')) db.exec('ALTER TABLE capture_jobs ADD COLUMN overrides_json TEXT');
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(7, now());
    // Миграция 8: люди. До неё журнал был один и ничей — теперь у каждой записи
    // есть хозяин, а войти можно только своей учётной записью.
    migrateUsers(db);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(8, now());
    // Миграция 9: Google как модель разбора. Список провайдеров зашит в
    // ограничения таблиц, а ALTER TABLE их не меняет — приходится переписывать
    // таблицу копией.
    for (const table of ['interpretations', 'capture_jobs']) rebuildWithGemini(db, table);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(9, now());
    // Миграция 10: доска. Колонки — свои у каждого; раскладка хранит, в какой
    // колонке и на каком месте лежит открытое дело. column_id NULL — «Входящие».
    db.exec(`CREATE TABLE IF NOT EXISTS board_columns (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS board_columns_user ON board_columns(user_id, position)');
    db.exec(`CREATE TABLE IF NOT EXISTS board_placements (
      capture_id TEXT PRIMARY KEY REFERENCES captures(id),
      user_id TEXT REFERENCES users(id),
      column_id TEXT REFERENCES board_columns(id),
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS board_placements_column ON board_placements(user_id, column_id, position)');
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(10, now());
    // Миграция 11: цвет колонки доски — подпись колонки красится, как статус в
    // Notion. NULL — серый по умолчанию.
    if (!db.prepare('PRAGMA table_info(board_columns)').all().some(column => column.name === 'color'))
      db.exec('ALTER TABLE board_columns ADD COLUMN color TEXT');
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(11, now());
    // Миграция 12: внешние календари. Учётная запись — Яндекс/Apple по CalDAV
    // или Google по API — с шифрованными учётными данными и списком выбранных
    // календарей; события — кэш окна синхронизации, не записи журнала; ссылки —
    // какие встречи Кизуна сама отправила наружу, чтобы узнавать их и убирать.
    db.exec(`CREATE TABLE IF NOT EXISTS calendar_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      provider TEXT NOT NULL CHECK(provider IN ('caldav','google')),
      preset TEXT,
      label TEXT NOT NULL,
      color TEXT,
      mode TEXT NOT NULL DEFAULT 'full' CHECK(mode IN ('full','busy')),
      server_url TEXT,
      username TEXT,
      credentials_enc TEXT NOT NULL,
      calendars_json TEXT NOT NULL DEFAULT '[]',
      synced_at TEXT,
      sync_error TEXT,
      created_at TEXT NOT NULL,
      disabled_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      instance_key TEXT,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      busy INTEGER NOT NULL DEFAULT 1,
      join_url TEXT,
      etag TEXT,
      href TEXT,
      updated_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS calendar_events_range ON calendar_events(account_id, start_at, end_at)');
    db.exec(`CREATE TABLE IF NOT EXISTS calendar_links (
      capture_id TEXT NOT NULL REFERENCES captures(id),
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      href TEXT,
      etag TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(capture_id, account_id)
    )`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(12, now());
    // Миграция 13: автоматическая отправка наружу. У учётной записи — режим
    // (off / meetings / all) и календарь-приёмник; у ссылки — отпечаток
    // отправленного события, чтобы понимать, менялась ли запись, признак
    // «создано автоматом» и когда обновлялось. Ошибка отправки хранится
    // отдельно от ошибки чтения: чтение и запись ломаются по-разному.
    for (const [table, column, definition] of [
      ['calendar_accounts', 'auto_export', "TEXT NOT NULL DEFAULT 'off'"], ['calendar_accounts', 'auto_calendar_id', 'TEXT'], ['calendar_accounts', 'export_error', 'TEXT'],
      ['calendar_links', 'fingerprint', 'TEXT'], ['calendar_links', 'auto', 'INTEGER NOT NULL DEFAULT 0'], ['calendar_links', 'updated_at', 'TEXT'],
    ]) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(13, now());
    // Миграция 14: плашка события как в Календаре macOS — участники с
    // ответами, организатор, правило повтора словами, ссылка на событие.
    for (const [column, definition] of [['attendees_json', 'TEXT'], ['organizer_json', 'TEXT'], ['repeat', 'TEXT'], ['url', 'TEXT'], ['sequence', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!db.prepare('PRAGMA table_info(calendar_events)').all().some(entry => entry.name === column)) db.exec(`ALTER TABLE calendar_events ADD COLUMN ${column} ${definition}`);
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(14, now());
    // Миграция 15: напоминания по делам. Подписки Web Push — по устройствам
    // человека (адрес у подписки уникален: одно устройство — одна строка);
    // журнал отправок — чтобы одно напоминание не ушло дважды и чтобы
    // пропущенное за простоем не догоняло человека через сутки.
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      endpoint TEXT NOT NULL UNIQUE,
      keys_json TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      failed_at TEXT,
      fail_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS reminder_sends (
      capture_id TEXT NOT NULL REFERENCES captures(id),
      remind_at TEXT NOT NULL,
      user_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('sent','missed')),
      title TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(capture_id, remind_at)
    )`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(15, now());
    // Миграция 16: серия у экземпляра повтора, чтобы удалять серию целиком:
    // у CalDAV это uid файла, у Google — recurringEventId.
    if (!db.prepare('PRAGMA table_info(calendar_events)').all().some(entry => entry.name === 'series_uid')) db.exec('ALTER TABLE calendar_events ADD COLUMN series_uid TEXT');
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(16, now());
}
// Ограничение переписывается из собственного определения таблицы, а не из
// зашитой здесь копии: копия разошлась бы с настоящей схемой на первой же новой
// колонке, и миграция молча потеряла бы её.
function rebuildWithGemini(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row?.sql || row.sql.includes("'gemini'")) return false;
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table).map(entry => entry.sql);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name).join(',');
  const nextSql = row.sql
    .replaceAll("'openrouter'", "'openrouter','gemini'")
    .replace(new RegExp(`CREATE TABLE\\s+\"?${table}\"?`), `CREATE TABLE ${table}_next`);
  db.pragma('foreign_keys = OFF');
  try {
    withImmediateTransaction(db, () => {
      db.exec(nextSql);
      db.exec(`INSERT INTO ${table}_next(${columns}) SELECT ${columns} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_next RENAME TO ${table};`);
      for (const sql of indexes) db.exec(sql);
    });
  } finally { db.pragma('foreign_keys = ON'); }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`Gemini provider migration broke foreign keys in ${table}.`);
  return true;
}
// Учётные записи, входы и расход голоса. Пароль хранится только хешем, секрет
// второго фактора — в открытом виде: проверить код без него нельзя, поэтому
// защита здесь не в шифровании, а в том, что база лежит локально и не уходит
// ни в экспорт, ни в очистку данных.
function migrateUsers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','blocked','rejected')),
      totp_secret TEXT,
      totp_pending_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      recovery_codes_json TEXT,
      voice_limit_usd REAL,
      voice_limit_minutes REAL,
      monthly_limit_usd REAL,
      voice_limit_window TEXT CHECK(voice_limit_window IN ('day','week','month','total')),
      voice_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT,
      blocked_at TEXT,
      blocked_reason TEXT,
      last_login_at TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS auth_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      email TEXT,
      event TEXT NOT NULL,
      result TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_events_time ON auth_events(created_at);
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      provider TEXT NOT NULL,
      model TEXT,
      rate_usd_per_minute REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      seconds INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      closed_by TEXT
    );
    CREATE INDEX IF NOT EXISTS voice_sessions_time ON voice_sessions(started_at);
    CREATE INDEX IF NOT EXISTS voice_sessions_user ON voice_sessions(user_id, started_at);`);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('voice_limit_minutes')) db.exec('ALTER TABLE users ADD COLUMN voice_limit_minutes REAL');
  if (!userColumns.has('monthly_limit_usd')) db.exec('ALTER TABLE users ADD COLUMN monthly_limit_usd REAL');
  const captureColumns = new Set(db.prepare('PRAGMA table_info(captures)').all().map(column => column.name));
  if (!captureColumns.has('user_id')) db.exec('ALTER TABLE captures ADD COLUMN user_id TEXT REFERENCES users(id)');
  db.exec('CREATE INDEX IF NOT EXISTS captures_user ON captures(user_id, created_at)');
  const usageColumns = new Set(db.prepare('PRAGMA table_info(usage_events)').all().map(column => column.name));
  if (!usageColumns.has('user_id')) db.exec('ALTER TABLE usage_events ADD COLUMN user_id TEXT');
  const jobColumns = new Set(db.prepare('PRAGMA table_info(capture_jobs)').all().map(column => column.name));
  if (!jobColumns.has('user_id')) db.exec('ALTER TABLE capture_jobs ADD COLUMN user_id TEXT');
  // Отчёт за день — у каждого свой, поэтому и «одна ревизия на дату» тоже своя.
  // Ограничения переписываются копией таблицы: ALTER TABLE их не меняет.
  const briefColumns = new Set(db.prepare('PRAGMA table_info(daily_briefs)').all().map(column => column.name));
  if (!briefColumns.has('user_id')) migrateDailyBriefsPerUser(db);
}
function migrateDailyBriefsPerUser(db) {
  db.pragma('foreign_keys = OFF');
  try { withImmediateTransaction(db, () => {
    const briefs = db.prepare('SELECT * FROM daily_briefs ORDER BY created_at,id').all();
    const sources = db.prepare('SELECT * FROM daily_brief_sources ORDER BY created_at,id').all();
    db.exec(`ALTER TABLE daily_brief_sources RENAME TO daily_brief_sources_pre_users;
      ALTER TABLE daily_briefs RENAME TO daily_briefs_pre_users;
      CREATE TABLE daily_briefs (
        id TEXT PRIMARY KEY, user_id TEXT, brief_date TEXT NOT NULL, time_zone TEXT NOT NULL, revision INTEGER NOT NULL,
        generated_at TEXT NOT NULL, content_json TEXT NOT NULL, effective_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(user_id, brief_date, time_zone, revision), UNIQUE(user_id, brief_date, time_zone, effective_fingerprint)
      );
      CREATE TABLE daily_brief_sources (
        id TEXT PRIMARY KEY, daily_brief_id TEXT NOT NULL REFERENCES daily_briefs(id), section_key TEXT NOT NULL, item_key TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('capture','projection','interpretation','ledger_event')), source_id TEXT NOT NULL,
        capture_id TEXT REFERENCES captures(id), projection_id TEXT REFERENCES projections(id), interpretation_id TEXT REFERENCES interpretations(id), ledger_event_id TEXT REFERENCES ledger_events(id), created_at TEXT NOT NULL,
        UNIQUE(daily_brief_id, section_key, item_key, source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS daily_brief_sources_capture_id ON daily_brief_sources(capture_id, created_at);
      CREATE INDEX IF NOT EXISTS daily_briefs_latest ON daily_briefs(user_id, brief_date, time_zone, revision DESC);`);
    const insertBrief = db.prepare('INSERT INTO daily_briefs(id,user_id,brief_date,time_zone,revision,generated_at,content_json,effective_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    // Хозяин старых отчётов неизвестен, пока нет ни одного человека: их
    // подберёт первая учётная запись вместе со старыми записями.
    for (const brief of briefs) insertBrief.run(brief.id, null, brief.brief_date, brief.time_zone, brief.revision, brief.generated_at, brief.content_json, brief.effective_fingerprint, brief.created_at);
    const insertSource = db.prepare('INSERT INTO daily_brief_sources(id,daily_brief_id,section_key,item_key,source_type,source_id,capture_id,projection_id,interpretation_id,ledger_event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const source of sources) insertSource.run(source.id, source.daily_brief_id, source.section_key, source.item_key, source.source_type, source.source_id, source.capture_id, source.projection_id, source.interpretation_id, source.ledger_event_id, source.created_at);
    db.exec('DROP TABLE daily_brief_sources_pre_users; DROP TABLE daily_briefs_pre_users;');
  }); } finally { db.pragma('foreign_keys = ON'); }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Per-user daily brief migration failed foreign-key validation.');
}

export const NOTE_BODY_LIMIT = 20000;

// Запись расхода: молча и никогда не мешая основному делу — если что-то в
// цифрах не сошлось, запись просто не появится, а разбор не сорвётся.
export function recordUsage(db, { provider, model = null, kind = 'classify', inputTokens = 0, outputTokens = 0, costUsd = null, userId = null } = {}) {
  if (!provider) return null;
  const at = now();
  const cost = Number.isFinite(costUsd) ? costUsd : null;
  db.prepare('INSERT INTO usage_events(id,provider,model,kind,input_tokens,output_tokens,cost_usd,created_at,user_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id(), provider, model, kind, Math.max(0, Math.round(inputTokens) || 0), Math.max(0, Math.round(outputTokens) || 0), cost, at, userId);
  return { provider, model, kind, at };
}
function usageSince(db, since, userId) {
  // undefined — «весь дом», это нужно администратору; конкретный id (в том
  // числе null для доисторических записей) — только свой расход.
  const everyone = userId === undefined;
  const rows = db
    .prepare(`SELECT provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(COALESCE(cost_usd,0)) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
      FROM usage_events WHERE created_at >= ? ${everyone ? '' : 'AND user_id IS ?'} GROUP BY provider, model ORDER BY calls DESC`)
    .all(...(everyone ? [since] : [since, userId]));
  const rows_ = rows.map(row => ({
    provider: row.provider,
    model: row.model,
    calls: row.calls,
    inputTokens: row.input || 0,
    outputTokens: row.output || 0,
    costUsd: row.cost || 0,
    // Сколько вызовов без известной цены: без этого сумма выглядела бы полной,
    // хотя часть расхода в неё не вошла.
    unpriced: row.unpriced || 0,
  }));
  return {
    calls: rows_.reduce((total, row) => total + row.calls, 0),
    inputTokens: rows_.reduce((total, row) => total + row.inputTokens, 0),
    outputTokens: rows_.reduce((total, row) => total + row.outputTokens, 0),
    costUsd: rows_.reduce((total, row) => total + row.costUsd, 0),
    unpriced: rows_.reduce((total, row) => total + row.unpriced, 0),
    rows: rows_,
  };
}
export function usageSummary(db, { now: at = new Date(), userId } = {}) {
  const day = new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const week = new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return { day: usageSince(db, day, userId), week: usageSince(db, week, userId), total: usageSince(db, '', userId) };
}
export function readSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key,value FROM app_settings').all()) out[row.key] = row.value;
  return out;
}
export function writeSettings(db, values) {
  const at = now();
  const upsert = db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
  const drop = db.prepare('DELETE FROM app_settings WHERE key=?');
  return withImmediateTransaction(db, () => {
    for (const [key, value] of Object.entries(values)) {
      // Пустое значение — это «вернуть как было», то есть снова брать из
      // окружения: хранить пустую строку значило бы «нет ключа навсегда».
      if (value === null || value === '') drop.run(key);
      else upsert.run(key, String(value), at);
    }
    return readSettings(db);
  });
}
export const ATTACHMENT_SIZE_LIMIT = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_CAPTURE = 10;
export function attachmentsFor(db, captureId) {
  return db
    .prepare(
      'SELECT id,filename,content_type,byte_size,created_at FROM capture_attachments WHERE capture_id=? AND deleted_at IS NULL ORDER BY created_at,id',
    )
    .all(captureId)
    .map(row => ({ id:row.id, filename:row.filename, contentType:row.content_type, size:row.byte_size, createdAt:row.created_at }));
}
export function addAttachment(db, captureId, { filename, contentType, bytes }) {
  const capture = db.prepare('SELECT id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
  if (!capture) return { notFound: true };
  const count = db.prepare('SELECT COUNT(*) AS count FROM capture_attachments WHERE capture_id=? AND deleted_at IS NULL').get(captureId).count;
  if (count >= ATTACHMENTS_PER_CAPTURE) return { tooMany: true, limit: ATTACHMENTS_PER_CAPTURE };
  const attachmentId = id(), createdAt = now();
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO capture_attachments(id,capture_id,filename,content_type,byte_size,checksum,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(attachmentId, captureId, filename, contentType, bytes.length, checksum, createdAt);
  return { id: attachmentId, filename, contentType, size: bytes.length, checksum, createdAt };
}
export function findAttachment(db, attachmentId) {
  const row = db
    .prepare('SELECT id,capture_id,filename,content_type,byte_size,created_at FROM capture_attachments WHERE id=? AND deleted_at IS NULL')
    .get(attachmentId);
  if (!row) return null;
  return { id:row.id, captureId:row.capture_id, filename:row.filename, contentType:row.content_type, size:row.byte_size, createdAt:row.created_at };
}
// Удаление мягкое, как и у записи: файл на диске снимается отдельно, чтобы
// строка в журнале и байты уходили одним решением, а не наполовину.
export function removeAttachment(db, attachmentId) {
  const found = findAttachment(db, attachmentId);
  if (!found) return { notFound: true };
  db.prepare('UPDATE capture_attachments SET deleted_at=? WHERE id=?').run(now(), attachmentId);
  return { id: attachmentId, captureId: found.captureId, removed: true };
}
export function activeNote(db, captureId) {
  return db.prepare("SELECT id,version,body,created_at FROM capture_notes WHERE capture_id=? AND status='active'").get(captureId) || null;
}

export function saveNote(db, captureId, body) {
  const createdAt = now();
  return withImmediateTransaction(db, () => {
    const capture = db.prepare('SELECT id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
    if (!capture) return { notFound: true };
    const previous = db.prepare("SELECT id,version FROM capture_notes WHERE capture_id=? AND status='active'").get(captureId);
    if (previous) db.prepare("UPDATE capture_notes SET status='superseded' WHERE id=?").run(previous.id);
    const trimmed = String(body).slice(0, NOTE_BODY_LIMIT);
    const noteId = id();
    db.prepare('INSERT INTO capture_notes(id,capture_id,version,status,body,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?)')
      .run(noteId, captureId, (previous?.version || 0) + 1, 'active', trimmed, createdAt, previous?.id || null);
    insertLedgerEvent(db, 'note_saved', captureId, null, createdAt);
    return { note: activeNote(db, captureId) };
  });
}

// Миграция 5: провайдер openrouter в CHECK-ограничениях и выбранная модель у
// задания. Ограничения переписываются копированием таблицы — ALTER TABLE в
// SQLite не умеет менять CHECK; данные переносятся как есть.
function migrateOpenRouterProvider(db) {
  const interpretationSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='interpretations'").get()?.sql || '';
  if (!interpretationSql.includes("'openrouter'")) {
    db.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE interpretations_next (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','rejected')), provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter','fallback','codex-cli','claude-cli','manual')), model TEXT, classification_json TEXT NOT NULL, field_confidence_json TEXT NOT NULL, created_at TEXT NOT NULL, supersedes_id TEXT REFERENCES interpretations(id));
      INSERT INTO interpretations_next SELECT * FROM interpretations;
      DROP INDEX IF EXISTS interpretations_active_capture;
      DROP TABLE interpretations;
      ALTER TABLE interpretations_next RENAME TO interpretations;
      CREATE UNIQUE INDEX interpretations_active_capture ON interpretations(capture_id) WHERE status='active';
      PRAGMA foreign_keys = ON;`);
  }
  const jobColumns = new Set(db.prepare('PRAGMA table_info(capture_jobs)').all().map(column => column.name));
  if (!jobColumns.has('selected_model')) db.exec('ALTER TABLE capture_jobs ADD COLUMN selected_model TEXT');
  const jobSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='capture_jobs'").get()?.sql || '';
  if (!jobSql.includes("'openrouter'")) {
    const columns = db.prepare('PRAGMA table_info(capture_jobs)').all().map(column => column.name).join(',');
    db.exec(`PRAGMA foreign_keys = OFF;
      DROP INDEX IF EXISTS capture_jobs_claimable;
      DROP INDEX IF EXISTS capture_jobs_capture_id;
      CREATE TABLE capture_jobs_next (
        id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL REFERENCES captures(id),
        selected_provider TEXT NOT NULL CHECK(selected_provider IN ('fallback','openai','openrouter','codex-cli','claude-cli')),
        state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','cancelled')),
        stage TEXT NOT NULL CHECK(stage IN ('queued','classifying','complete','failed','cancelled')),
        retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
        retry_of_id TEXT REFERENCES capture_jobs(id),
        idempotency_key TEXT UNIQUE,
        request_fingerprint TEXT,
        lease_owner TEXT,
        lease_token TEXT,
        lease_fence INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        used_provider TEXT CHECK(used_provider IS NULL OR used_provider IN ('fallback','openai','openrouter','codex-cli','claude-cli')),
        model TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        cancelled_at TEXT,
        selected_model TEXT
      );
      INSERT INTO capture_jobs_next(${columns}) SELECT ${columns} FROM capture_jobs;
      DROP TABLE capture_jobs;
      ALTER TABLE capture_jobs_next RENAME TO capture_jobs;
      CREATE INDEX IF NOT EXISTS capture_jobs_claimable ON capture_jobs(state, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS capture_jobs_capture_id ON capture_jobs(capture_id, created_at);
      PRAGMA foreign_keys = ON;`);
  }
}

function createLedgerEventGuards(db) {
  db.exec("CREATE TRIGGER IF NOT EXISTS ledger_events_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END; CREATE TRIGGER IF NOT EXISTS ledger_events_no_delete BEFORE DELETE ON ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;");
}

function migrateLedgerEventProvenance(db) {
  const ledgerSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger_events'").get()?.sql || '';
  if (!/ON DELETE SET NULL/i.test(ledgerSql)) return;
  db.pragma('foreign_keys = OFF');
  try {
    withImmediateTransaction(db, () => {
      db.exec(`DROP TRIGGER IF EXISTS ledger_events_no_update;
        DROP TRIGGER IF EXISTS ledger_events_no_delete;
        ALTER TABLE daily_brief_sources RENAME TO daily_brief_sources_legacy;
        ALTER TABLE ledger_events RENAME TO ledger_events_legacy;
        CREATE TABLE ledger_events (
          id TEXT PRIMARY KEY, event_type TEXT NOT NULL, capture_id TEXT REFERENCES captures(id), job_id TEXT REFERENCES capture_jobs(id),
          projection_id TEXT REFERENCES projections(id), interpretation_id TEXT REFERENCES interpretations(id), actor TEXT, occurred_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE daily_brief_sources (
          id TEXT PRIMARY KEY, daily_brief_id TEXT NOT NULL REFERENCES daily_briefs(id), section_key TEXT NOT NULL, item_key TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('capture','projection','interpretation','ledger_event')), source_id TEXT NOT NULL,
          capture_id TEXT REFERENCES captures(id), projection_id TEXT REFERENCES projections(id), interpretation_id TEXT REFERENCES interpretations(id), ledger_event_id TEXT REFERENCES ledger_events(id), created_at TEXT NOT NULL,
          UNIQUE(daily_brief_id, section_key, item_key, source_type, source_id)
        );
        INSERT INTO ledger_events(id,event_type,capture_id,job_id,projection_id,interpretation_id,actor,occurred_at,created_at)
          SELECT id,event_type,capture_id,job_id,projection_id,interpretation_id,actor,occurred_at,created_at FROM ledger_events_legacy;
        INSERT INTO daily_brief_sources(id,daily_brief_id,section_key,item_key,source_type,source_id,capture_id,projection_id,interpretation_id,ledger_event_id,created_at)
          SELECT id,daily_brief_id,section_key,item_key,source_type,source_id,capture_id,projection_id,interpretation_id,ledger_event_id,created_at FROM daily_brief_sources_legacy;
        DROP TABLE daily_brief_sources_legacy;
        DROP TABLE ledger_events_legacy;
        CREATE INDEX ledger_events_capture_id ON ledger_events(capture_id, created_at);
        CREATE INDEX IF NOT EXISTS daily_brief_sources_capture_id ON daily_brief_sources(capture_id, created_at);`);
      createLedgerEventGuards(db);
    });
  } finally { db.pragma('foreign_keys = ON'); }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Ledger provenance migration failed foreign-key validation.');
}
function migrateLegacyDailyBriefs(db, columns) {
  const requiredBriefColumns=['id','brief_date','time_zone','content_json','created_at','updated_at'];
  const sourceColumns=new Set(db.prepare('PRAGMA table_info(daily_brief_sources)').all().map(column=>column.name));
  if (!requiredBriefColumns.every(column=>columns.has(column)) || !['id','daily_brief_id','capture_id','created_at'].every(column=>sourceColumns.has(column))) throw new Error('Unsupported legacy daily brief schema; export the database before upgrading.');
  const invalidSource=db.prepare(`SELECT 1 FROM daily_brief_sources s LEFT JOIN daily_briefs b ON b.id=s.daily_brief_id LEFT JOIN captures c ON c.id=s.capture_id WHERE b.id IS NULL OR c.id IS NULL LIMIT 1`).get();
  if (invalidSource) throw new Error('Legacy daily brief sources are inconsistent; repair or export the database before upgrading.');
  db.pragma('foreign_keys = OFF');
  try { withImmediateTransaction(db,()=>{
    const legacyBriefs=db.prepare('SELECT * FROM daily_briefs ORDER BY created_at,id').all();
    const legacySources=db.prepare('SELECT * FROM daily_brief_sources ORDER BY created_at,id').all();
    db.exec(`ALTER TABLE daily_brief_sources RENAME TO daily_brief_sources_legacy;
      ALTER TABLE daily_briefs RENAME TO daily_briefs_legacy;
      CREATE TABLE daily_briefs (
        id TEXT PRIMARY KEY, brief_date TEXT NOT NULL, time_zone TEXT NOT NULL, revision INTEGER NOT NULL,
        generated_at TEXT NOT NULL, content_json TEXT NOT NULL, effective_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(brief_date, time_zone, revision), UNIQUE(brief_date, time_zone, effective_fingerprint)
      );
      CREATE TABLE daily_brief_sources (
        id TEXT PRIMARY KEY, daily_brief_id TEXT NOT NULL REFERENCES daily_briefs(id), section_key TEXT NOT NULL, item_key TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('capture','projection','interpretation','ledger_event')), source_id TEXT NOT NULL,
        capture_id TEXT REFERENCES captures(id), projection_id TEXT REFERENCES projections(id), interpretation_id TEXT REFERENCES interpretations(id), ledger_event_id TEXT REFERENCES ledger_events(id), created_at TEXT NOT NULL,
        UNIQUE(daily_brief_id, section_key, item_key, source_type, source_id)
      );`);
    const insertBrief=db.prepare('INSERT INTO daily_briefs(id,brief_date,time_zone,revision,generated_at,content_json,effective_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)');
    for(const brief of legacyBriefs) insertBrief.run(brief.id,brief.brief_date,brief.time_zone,1,brief.updated_at||brief.created_at,brief.content_json||'{"legacy":true}',`legacy:${brief.id}`,brief.created_at);
    const insertSource=db.prepare('INSERT INTO daily_brief_sources(id,daily_brief_id,section_key,item_key,source_type,source_id,capture_id,created_at) VALUES(?,?,?,?,?,?,?,?)');
    for(const source of legacySources) insertSource.run(source.id,source.daily_brief_id,'legacy',source.id,'capture',source.capture_id,source.capture_id,source.created_at);
    db.exec('DROP TABLE daily_brief_sources_legacy; DROP TABLE daily_briefs_legacy;');
  }); } finally { db.pragma('foreign_keys = ON'); }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Legacy daily brief migration failed foreign-key validation.');
}
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// Хозяин записи проставляется здесь и больше не меняется: журнал у каждого
// свой, и «ничьих» записей после появления первой учётной записи не бывает.
const INSERT_CAPTURE = 'INSERT INTO captures(id,raw,modality,occurred_at,created_at,privacy_scope,deleted_at,user_id) VALUES(?,?,?,?,?,?,NULL,?)';

export function createLedger(db, { raw, occurredAt, classification, provider, model = null, createProjections = true, userId = null }) {
  const captureId = id(), interpretationId = id(), undoGroupId = id(), createdAt = now();
  const write = db.transaction(() => {
    db.prepare(INSERT_CAPTURE).run(captureId, raw, 'text', occurredAt || createdAt, createdAt, 'private', userId);
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretationId, captureId, 1, 'active', provider, model, JSON.stringify(classification), JSON.stringify(classification.confidence || {}), createdAt);
    if(createProjections) insertProjections(db, interpretationId, makeProjections(captureId, classification, undoGroupId), createdAt);
    db.prepare('INSERT INTO activity_events VALUES(?,?,?,?)').run(id(), 'capture_created', JSON.stringify({ captureId, undoGroupId }), createdAt);
  });
  write(); return { captureId, interpretationId, undoGroupId };
}

function withImmediateTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function insertJobEvent(db, jobId, eventType, createdAt) {
  db.prepare('INSERT INTO capture_job_events(id,job_id,event_type,created_at) VALUES(?,?,?,?)').run(id(), jobId, eventType, createdAt);
}

function insertLedgerEvent(db, eventType, captureId, jobId, createdAt, { projectionId = null, interpretationId = null, actor = null, occurredAt = null } = {}) {
  db.prepare('INSERT INTO ledger_events(id,event_type,capture_id,job_id,projection_id,interpretation_id,actor,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id(), eventType, captureId, jobId, projectionId, interpretationId, actor, occurredAt, createdAt);
}

export function enqueueCaptureJob(db, { raw, occurredAt, selectedProvider, selectedModel = null, idempotencyKey = null, requestFingerprint = null, overrides = null, userId = null }) {
  const createdAt = now();
  return withImmediateTransaction(db, () => {
    if (idempotencyKey) {
      // Ключ идемпотентности уникален на всю базу, а повтором считается только
      // свой же запрос: чужой ключ — это столкновение, а не «то же самое».
      const existing = db.prepare('SELECT id,capture_id,request_fingerprint,user_id FROM capture_jobs WHERE idempotency_key=?').get(idempotencyKey);
      if (existing) {
        if (existing.user_id !== userId || existing.request_fingerprint !== requestFingerprint) return { conflict:true };
        return { captureId:existing.capture_id, jobId:existing.id, state:'pending', existing:true };
      }
    }
    const captureId = id(), jobId = id();
    db.prepare(INSERT_CAPTURE).run(captureId, raw, 'text', occurredAt || createdAt, createdAt, 'private', userId);
    db.prepare(`INSERT INTO capture_jobs(id,capture_id,selected_provider,selected_model,state,stage,retryable,retry_of_id,idempotency_key,request_fingerprint,overrides_json,created_at,user_id)
      VALUES(?,?,?,?,'pending','queued',0,NULL,?,?,?,?,?)`).run(jobId, captureId, selectedProvider, selectedModel, idempotencyKey, requestFingerprint, overrides ? JSON.stringify(overrides) : null, createdAt, userId);
    insertJobEvent(db, jobId, 'queued', createdAt);
    insertLedgerEvent(db, 'capture_queued', captureId, jobId, createdAt);
    return { captureId, jobId, state:'pending', existing:false };
  });
}

export function claimCaptureJob(db, { owner, leaseToken, leaseMs, currentTime = now() }) {
  return withImmediateTransaction(db, () => {
    const job = db.prepare(`SELECT * FROM capture_jobs
      WHERE state='pending' OR (state='running' AND lease_expires_at <= ?)
      ORDER BY created_at LIMIT 1`).get(currentTime);
    if (!job) return null;
    const leaseExpiresAt = new Date(new Date(currentTime).getTime() + leaseMs).toISOString();
    const reclaimed = job.state === 'running';
    const result = db.prepare(`UPDATE capture_jobs SET state='running',stage='classifying',lease_owner=?,lease_token=?,lease_fence=lease_fence+1,lease_expires_at=?,attempt_count=attempt_count+1,started_at=COALESCE(started_at,?)
      WHERE id=? AND (state='pending' OR (state='running' AND lease_expires_at <= ?))`).run(owner, leaseToken, leaseExpiresAt, currentTime, job.id, currentTime);
    if (result.changes !== 1) return null;
    const claim = db.prepare('SELECT j.*,c.raw FROM capture_jobs j JOIN captures c ON c.id=j.capture_id WHERE j.id=?').get(job.id);
    insertJobEvent(db, claim.id, reclaimed ? 'reclaimed' : 'started', currentTime);
    return claim;
  });
}

export function completeCaptureJob(db, claim, { classification, provider, model = null, fallbackReason = null }) {
  const completedAt = now();
  return withImmediateTransaction(db, () => {
    const current = db.prepare(`SELECT * FROM capture_jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_fence=? AND lease_expires_at > ?`).get(claim.id, claim.lease_owner, claim.lease_token, claim.lease_fence, completedAt);
    if (!current) return null;
    const review = gateClassification(classification);
    const interpretationId = id(), undoGroupId = id();
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretationId, claim.capture_id, 1, 'active', provider, model, JSON.stringify(classification), JSON.stringify(classification.confidence || {}), completedAt);
    if (shouldMaterializeProjections(classification)) insertProjections(db, interpretationId, makeProjections(claim.capture_id, classification, undoGroupId), completedAt);
    // Задача «успешна» и с откатом на заглушку — но причина отката остаётся
    // в error_code: без неё после факта не понять, почему запись без разбора.
    db.prepare(`UPDATE capture_jobs SET state='succeeded',stage='complete',retryable=0,used_provider=?,model=?,error_code=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,finished_at=?
      WHERE id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_fence=?`).run(provider, model, provider === 'fallback' ? (fallbackReason || null) : null, completedAt, claim.id, claim.lease_owner, claim.lease_token, claim.lease_fence);
    insertJobEvent(db, claim.id, 'succeeded', completedAt);
    insertLedgerEvent(db, 'capture_classified', claim.capture_id, claim.id, completedAt);
    return { interpretationId, undoGroupId };
  });
}

export function renewCaptureJobLease(db, claim, { leaseMs, currentTime = now() }) {
  const leaseExpiresAt = new Date(new Date(currentTime).getTime() + leaseMs).toISOString();
  const result = db.prepare(`UPDATE capture_jobs SET lease_expires_at=?
    WHERE id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_fence=?`).run(leaseExpiresAt, claim.id, claim.lease_owner, claim.lease_token, claim.lease_fence);
  return result.changes === 1;
}

const safeJobErrors = new Set(['unavailable','busy','timeout','aborted','nonzero','malformed_output','absent_output','oversize_output','schema_invalid','rate_limited','invalid_provider','not_configured']);

export function failCaptureJob(db, claim, errorCode = 'unavailable') {
  const finishedAt = now(), safeError = safeJobErrors.has(errorCode) ? errorCode : 'unavailable';
  return withImmediateTransaction(db, () => {
    const result = db.prepare(`UPDATE capture_jobs SET state='failed',stage='failed',retryable=1,error_code=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,finished_at=?
      WHERE id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_fence=?`).run(safeError, finishedAt, claim.id, claim.lease_owner, claim.lease_token, claim.lease_fence);
    if (result.changes !== 1) return false;
    insertJobEvent(db, claim.id, 'failed', finishedAt);
    insertLedgerEvent(db, 'capture_failed', claim.capture_id, claim.id, finishedAt);
    return true;
  });
}

export function releaseCaptureJob(db, claim) {
  const releasedAt = now();
  return withImmediateTransaction(db, () => {
    const result = db.prepare(`UPDATE capture_jobs SET state='pending',stage='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_fence=?`).run(claim.id, claim.lease_owner, claim.lease_token, claim.lease_fence);
    if (result.changes !== 1) return false;
    insertJobEvent(db, claim.id, 'released', releasedAt);
    return true;
  });
}

export function cancelCaptureJob(db, jobId) {
  const cancelledAt = now();
  return withImmediateTransaction(db, () => {
    const job = db.prepare('SELECT * FROM capture_jobs WHERE id=?').get(jobId);
    if (!job) return null;
    if (['succeeded','failed','cancelled'].includes(job.state)) return { job, changed:false };
    db.prepare(`UPDATE capture_jobs SET state='cancelled',stage='cancelled',retryable=1,lease_owner=NULL,lease_token=NULL,lease_fence=lease_fence+1,lease_expires_at=NULL,cancelled_at=?,finished_at=? WHERE id=?`).run(cancelledAt, cancelledAt, jobId);
    insertJobEvent(db, jobId, 'cancelled', cancelledAt);
    insertLedgerEvent(db, 'capture_cancelled', job.capture_id, jobId, cancelledAt);
    return { job:db.prepare('SELECT * FROM capture_jobs WHERE id=?').get(jobId), changed:true };
  });
}

export function retryCaptureJob(db, jobId) {
  const createdAt = now();
  return withImmediateTransaction(db, () => {
    const previous = db.prepare('SELECT * FROM capture_jobs WHERE id=?').get(jobId);
    if (!previous) return null;
    if (!['failed','cancelled'].includes(previous.state) || !previous.retryable) return { invalidState:true };
    const retryId = id();
    db.prepare(`INSERT INTO capture_jobs(id,capture_id,selected_provider,selected_model,state,stage,retryable,retry_of_id,created_at,user_id)
      VALUES(?,?,?,?,'pending','queued',0,?,?,?)`).run(retryId, previous.capture_id, previous.selected_provider, previous.selected_model || null, previous.id, createdAt, previous.user_id ?? null);
    insertJobEvent(db, retryId, 'queued', createdAt);
    insertLedgerEvent(db, 'capture_retry_queued', previous.capture_id, retryId, createdAt);
    return { captureId:previous.capture_id, jobId:retryId, state:'pending' };
  });
}

export function getCaptureJob(db, jobId) {
  const job = db.prepare('SELECT id,capture_id,state,stage,retryable,retry_of_id,created_at,started_at,finished_at,cancelled_at,error_code,used_provider,user_id FROM capture_jobs WHERE id=?').get(jobId);
  if (!job) return null;
  return { id:job.id, captureId:job.capture_id, state:job.state, stage:job.stage, retryable:Boolean(job.retryable), retryOfId:job.retry_of_id, createdAt:job.created_at, startedAt:job.started_at, finishedAt:job.finished_at, cancelledAt:job.cancelled_at, error:job.error_code, usedProvider:job.used_provider, userId:job.user_id ?? null };
}
function insertProjections(db, interpretationId, projections, createdAt) {
  const stmt = db.prepare('INSERT INTO projections VALUES(?,?,?,?,?,?,?,?,NULL)');
  for (const p of projections) stmt.run(id(), p.captureId, interpretationId, p.projectionType, JSON.stringify(p.payload), 'active', p.undoGroupId, createdAt);
}
function repairMissingProjections(db) {
  const activeInterpretations = db.prepare(`SELECT i.id,i.capture_id,i.classification_json
    FROM interpretations i JOIN captures c ON c.id=i.capture_id
    WHERE i.status='active' AND c.deleted_at IS NULL`).all();
  withImmediateTransaction(db, () => {
    for (const interpretation of activeInterpretations) {
      let classification;
      try { classification = JSON.parse(interpretation.classification_json); }
      catch { continue; }
      if (!shouldMaterializeProjections(classification)) continue;
      const existingTypes = new Set(db.prepare('SELECT projection_type FROM projections WHERE interpretation_id=?').all(interpretation.id).map(row => row.projection_type));
      const missing = makeProjections(interpretation.capture_id, classification, id()).filter(projection => !existingTypes.has(projection.projectionType));
      if (missing.length) insertProjections(db, interpretation.id, missing, now());
    }
  });
}
export function replaceInterpretation(db, captureId, classification, provider, correction = null, createProjections = true, model = null) {
  return withImmediateTransaction(db,()=>{
    if(correction?.operationKey){const existing=db.prepare('SELECT interpretation_id,request_fingerprint FROM corrections WHERE capture_id=? AND operation_key=?').get(captureId,correction.operationKey);if(existing){if(existing.request_fingerprint!==correction.requestFingerprint)return { conflict:true };const projection=db.prepare('SELECT undo_group_id FROM projections WHERE interpretation_id=? ORDER BY created_at LIMIT 1').get(existing.interpretation_id);return { interpretationId:existing.interpretation_id,undoGroupId:projection?.undo_group_id||null,replayed:true };}}
    const previous = db.prepare("SELECT * FROM interpretations WHERE capture_id=? AND status='active'").get(captureId);
    if (!previous) return null;
    const interpretationId = id(), undoGroupId = id(), createdAt = now();
    db.prepare("UPDATE interpretations SET status='superseded' WHERE id=?").run(previous.id);
    db.prepare("UPDATE projections SET status='reverted', reverted_at=? WHERE interpretation_id=? AND status='active'").run(createdAt, previous.id);
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,?)').run(interpretationId, captureId, previous.version + 1, 'active', provider, provider === 'manual' ? null : model, JSON.stringify(classification), JSON.stringify(classification.confidence || {}), createdAt, previous.id);
    if(createProjections) insertProjections(db, interpretationId, makeProjections(captureId, classification, undoGroupId), createdAt);
    if (correction) db.prepare('INSERT INTO corrections(id,capture_id,interpretation_id,correction_json,note,created_at,operation_key,request_fingerprint) VALUES(?,?,?,?,?,?,?,?)').run(id(), captureId, interpretationId, JSON.stringify(correction.patch||correction), correction.note || null, createdAt, correction.operationKey||null, correction.requestFingerprint||null);
    db.prepare('INSERT INTO activity_events VALUES(?,?,?,?)').run(id(), 'interpretation_replaced', JSON.stringify({ captureId, undoGroupId }), createdAt);
    return { interpretationId, undoGroupId };
  });
}
export function getAggregate(db, captureId) {
  return db.prepare(`SELECT c.*, i.id interpretation_id, i.version, i.provider, i.model, i.classification_json, i.field_confidence_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.id=?`).get(captureId);
}
function completionState(db, projectionId) {
  const event = db.prepare("SELECT event_type,occurred_at FROM ledger_events WHERE projection_id=? AND event_type IN ('completed','completion_undone') ORDER BY rowid DESC LIMIT 1").get(projectionId);
  return { completed:event?.event_type === 'completed', completedAt:event?.event_type === 'completed' ? event.occurred_at : null, actor:event?.event_type === 'completed' ? 'user' : null };
}
function completionTarget(db, projectionId) {
  const projection = db.prepare('SELECT p.*,c.deleted_at,i.status interpretation_status FROM projections p JOIN captures c ON c.id=p.capture_id JOIN interpretations i ON i.id=p.interpretation_id WHERE p.id=?').get(projectionId);
  if (!projection) return { error:'not_found' };
  if (projection.status !== 'active' || projection.deleted_at !== null || projection.interpretation_status !== 'active') return { error:'inactive' };
  if (!['task','meeting_event'].includes(projection.projection_type)) return { error:'not_completable' };
  return { projection };
}
export function completeProjection(db, projectionId) {
  return withImmediateTransaction(db, () => {
    const target = completionTarget(db, projectionId);
    if (target.error) return target;
    const completion = completionState(db, projectionId);
    if (completion.completed) return { projection:target.projection, completion, changed:false };
    const occurredAt = now();
    insertLedgerEvent(db, 'completed', target.projection.capture_id, null, occurredAt, { projectionId, interpretationId:target.projection.interpretation_id, actor:'user', occurredAt });
    return { projection:target.projection, completion:{ completed:true, completedAt:occurredAt, actor:'user' }, changed:true };
  });
}
export function undoProjectionCompletion(db, projectionId) {
  return withImmediateTransaction(db, () => {
    const target = completionTarget(db, projectionId);
    if (target.error) return target;
    const completion = completionState(db, projectionId);
    if (!completion.completed) return { projection:target.projection, completion, changed:false };
    const occurredAt = now();
    insertLedgerEvent(db, 'completion_undone', target.projection.capture_id, null, occurredAt, { projectionId, interpretationId:target.projection.interpretation_id, actor:'user', occurredAt });
    return { projection:target.projection, completion:{ completed:false, completedAt:null, actor:null }, changed:true };
  });
}
export function listEntries(db, { cursor, limit = 40, userId }) {
  const rows = db.prepare(`SELECT c.*, i.id interpretation_id, i.version, i.provider, i.model, i.classification_json, i.field_confidence_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.deleted_at IS NULL AND c.user_id IS ? ${cursor ? 'AND c.created_at < ?' : ''} ORDER BY c.created_at DESC LIMIT ?`).all(...(cursor ? [userId, cursor, limit] : [userId, limit]));
  return { entries: rows.map(row => fullEntry(db, row)), nextCursor: rows.length === limit ? rows.at(-1).created_at : null };
}
export function serializeEntry(row) { return { id: row.id, raw: row.raw, occurredAt: row.occurred_at, createdAt: row.created_at, interpretation: { id: row.interpretation_id, version: row.version, provider: row.provider, model: row.model, classification: JSON.parse(row.classification_json), confidence: JSON.parse(row.field_confidence_json) }, projections: [] }; }
export function fullEntry(db, row) { const entry = serializeEntry(row); entry.note = activeNote(db, row.id); entry.attachments = attachmentsFor(db, row.id); entry.projections = db.prepare("SELECT * FROM projections WHERE capture_id=? AND status='active' ORDER BY created_at").all(row.id).map(p => ({ id:p.id,type:p.projection_type,payload:JSON.parse(p.payload_json),undoGroupId:p.undo_group_id,completion:completionState(db,p.id),completionCandidate:null })); return entry; }
export function day(db, userId) { const rows = db.prepare(`SELECT c.*, i.id interpretation_id, i.version, i.provider, i.model, i.classification_json, i.field_confidence_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.deleted_at IS NULL AND c.user_id IS ? ORDER BY c.created_at DESC LIMIT 100`).all(userId); return rows.map(row=>fullEntry(db,row)); }
export function dayView(db, date, now=new Date(), userId=null) { const entries=day(db,userId); const scheduled=entry=>entry.interpretation.classification.entities.schedule; const onDay=s=>Boolean(s?.date)&&(s.date===date||occursOn(s,date)); const sortAtOf=s=>{if(!s?.sortAt)return null;if(!s.repeat)return s.sortAt;const next=nextOccurrence(s,date);return next?`${next}T${s.time||'23:59'}:00`:null;}; const completable=entry=>entry.projections.find(projection=>['task','meeting_event'].includes(projection.type)); const dayEntries=entries.filter(entry=>onDay(scheduled(entry))); const horizon=new Date(now.getTime()+48*60*60*1000); const upcoming=entries.filter(entry=>{const c=entry.interpretation.classification,s=scheduled(entry),projection=completable(entry);return !projection?.completion.completed&&['meeting_event','task'].includes(c.primaryType)&&sortAtOf(s)&&new Date(sortAtOf(s))>=now&&new Date(sortAtOf(s))<=horizon}).sort((a,b)=>new Date(sortAtOf(scheduled(a)))-new Date(sortAtOf(scheduled(b)))); const attention=entries.filter(entry=>{const c=entry.interpretation.classification,projection=completable(entry);return !projection?.completion.completed&&!c.completed&&((c.primaryType==='task'&&!scheduled(entry)?.date)||c.entities.followUp||c.primaryType==='outcome_decision')}); return {day:dayEntries,upcoming,attention}; }

const dailySectionLabels = { doneYesterday:'Сделано вчера', decisions:'Решения', carried:'Перенесённое', blockers:'Блокеры', today:'Сегодня' };
function samaraBounds(date) { const start = new Date(`${date}T00:00:00+04:00`); return { start:start.toISOString(), end:new Date(start.getTime()+86400000).toISOString() }; }
function previousDate(date) { return new Date(new Date(`${date}T00:00:00Z`).getTime()-86400000).toISOString().slice(0,10); }
function dailySource(sectionKey, itemKey, sourceType, sourceId, row) { return { sectionKey,itemKey,sourceType,sourceId,captureId:row.capture_id || row.id,projectionId:row.projection_id || null,interpretationId:row.interpretation_id || null,ledgerEventId:row.ledger_id || null }; }
function dailyItem(key, text, source) { return { key, text, source:{ kind:'capture', captureId:source.captureId } }; }
function isExplicitDecision(raw) { return !/^\s*[«"']/u.test(raw) && !raw.includes('?') && /^\s*(?:решение|решили|договорились|выбрали)\s*:/iu.test(raw); }
function effectiveProjectionText(row) { const payload=JSON.parse(row.payload_json),schedule=payload.schedule||{},details=[schedule.time,payload.title,(payload.projects||[]).join(', '),payload.followUp].filter(Boolean); return details.join(' · '); }
function dailyContent(db, date, userId=null) {
  const yesterday = previousDate(date), { start, end } = samaraBounds(yesterday), sections = [];
  const doneRows = db.prepare(`SELECT e.id ledger_id,e.capture_id,e.projection_id,e.interpretation_id,c.raw FROM ledger_events e JOIN captures c ON c.id=e.capture_id
    WHERE e.event_type='completed' AND e.actor='user' AND c.user_id IS ? AND e.occurred_at>=? AND e.occurred_at<?
    AND NOT EXISTS (SELECT 1 FROM ledger_events later WHERE later.projection_id=e.projection_id AND later.event_type='completion_undone' AND later.rowid>e.rowid)
    ORDER BY e.occurred_at LIMIT 100`).all(userId,start,end);
  const done = doneRows.map(row => ({ item:dailyItem(`done-${row.ledger_id}`,row.raw,{captureId:row.capture_id}), sources:[dailySource('doneYesterday',`done-${row.ledger_id}`,'ledger_event',row.ledger_id,row),dailySource('doneYesterday',`done-${row.ledger_id}`,'capture',row.capture_id,row),dailySource('doneYesterday',`done-${row.ledger_id}`,'projection',row.projection_id,row)] }));
  sections.push({ key:'doneYesterday', label:dailySectionLabels.doneYesterday, empty:'Нет подтверждённых завершений за вчера.', items:done });
  const decisionRows = db.prepare(`SELECT c.id,c.raw,i.id interpretation_id FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    WHERE c.deleted_at IS NULL AND c.user_id IS ? AND i.classification_json LIKE '%"primaryType":"outcome_decision"%' AND c.occurred_at>=? AND c.occurred_at<? ORDER BY c.occurred_at LIMIT 200`).all(userId,start,end).filter(row=>isExplicitDecision(row.raw)).slice(0,100);
  const decisions = decisionRows.map(row => ({ item:dailyItem(`decision-${row.id}`,row.raw,{captureId:row.id}), sources:[dailySource('decisions',`decision-${row.id}`,'capture',row.id,row),dailySource('decisions',`decision-${row.id}`,'interpretation',row.interpretation_id,row)] }));
  sections.push({ key:'decisions', label:dailySectionLabels.decisions, empty:'Нет зафиксированных решений.', items:decisions });
  const carriedRows = db.prepare(`SELECT p.id projection_id,p.capture_id,p.interpretation_id,p.payload_json,c.raw FROM projections p JOIN captures c ON c.id=p.capture_id JOIN interpretations i ON i.id=p.interpretation_id
    WHERE p.status='active' AND c.deleted_at IS NULL AND c.user_id IS ? AND i.status='active' AND p.projection_type IN ('task','meeting_event')
      AND json_extract(p.payload_json,'$.schedule.date')<? AND json_extract(p.payload_json,'$.schedule.repeat') IS NULL
      AND NOT EXISTS (SELECT 1 FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type='completed' AND NOT EXISTS (SELECT 1 FROM ledger_events undo_e WHERE undo_e.projection_id=p.id AND undo_e.event_type='completion_undone' AND undo_e.rowid>e.rowid))
    ORDER BY json_extract(p.payload_json,'$.schedule.date'),p.created_at LIMIT 100`).all(userId,date);
  const carried = carriedRows.map(row => ({ item:dailyItem(`carried-${row.projection_id}`,effectiveProjectionText(row),{captureId:row.capture_id}), sources:[dailySource('carried',`carried-${row.projection_id}`,'capture',row.capture_id,row),dailySource('carried',`carried-${row.projection_id}`,'projection',row.projection_id,row),dailySource('carried',`carried-${row.projection_id}`,'interpretation',row.interpretation_id,row)] }));
  sections.push({ key:'carried', label:dailySectionLabels.carried, empty:'Нет незавершённых задач или встреч из прошлого.', items:carried });
  const blockRows = db.prepare(`SELECT c.id,c.raw,i.id interpretation_id FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active'
    WHERE c.deleted_at IS NULL AND c.user_id IS ? AND c.occurred_at>=? AND c.occurred_at<? AND (trim(c.raw) LIKE 'Блокер:%' OR trim(c.raw) LIKE 'Блокер—%' OR trim(c.raw) LIKE 'Блокер-%' OR trim(c.raw) LIKE 'блокер:%' OR trim(c.raw) LIKE 'блокер—%' OR trim(c.raw) LIKE 'блокер-%' OR trim(c.raw) LIKE 'Блокирует:%' OR trim(c.raw) LIKE 'Блокирует—%' OR trim(c.raw) LIKE 'Блокирует-%' OR trim(c.raw) LIKE 'блокирует:%' OR trim(c.raw) LIKE 'блокирует—%' OR trim(c.raw) LIKE 'блокирует-%')
    ORDER BY c.occurred_at LIMIT 100`).all(userId,start,end);
  const blockers = blockRows.map(row => ({ item:dailyItem(`blocker-${row.id}`,row.raw,{captureId:row.id}), sources:[dailySource('blockers',`blocker-${row.id}`,'capture',row.id,row),dailySource('blockers',`blocker-${row.id}`,'interpretation',row.interpretation_id,row)] }));
  sections.push({ key:'blockers', label:dailySectionLabels.blockers, empty:'Нет зафиксированных блокеров.', items:blockers });
  const todayRows = db.prepare(`SELECT p.id projection_id,p.capture_id,p.interpretation_id,p.payload_json,c.raw FROM projections p JOIN captures c ON c.id=p.capture_id JOIN interpretations i ON i.id=p.interpretation_id
    WHERE p.status='active' AND c.deleted_at IS NULL AND c.user_id IS ? AND i.status='active' AND p.projection_type IN ('task','meeting_event') AND json_extract(p.payload_json,'$.schedule.date')=? AND json_extract(p.payload_json,'$.schedule.repeat') IS NULL
      AND NOT EXISTS (SELECT 1 FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type='completed' AND NOT EXISTS (SELECT 1 FROM ledger_events undo_e WHERE undo_e.projection_id=p.id AND undo_e.event_type='completion_undone' AND undo_e.rowid>e.rowid))
    ORDER BY json_extract(p.payload_json,'$.schedule.time'),p.created_at LIMIT 100`).all(userId,date);
  // Повторяющиеся дела и встречи: в день попадает экземпляр, если он выпадает
  // на эту дату и не убран.
  const repeatingRows = db.prepare(`SELECT p.id projection_id,p.capture_id,p.interpretation_id,p.payload_json,c.raw FROM projections p JOIN captures c ON c.id=p.capture_id JOIN interpretations i ON i.id=p.interpretation_id
    WHERE p.status='active' AND c.deleted_at IS NULL AND c.user_id IS ? AND i.status='active' AND p.projection_type IN ('task','meeting_event') AND json_extract(p.payload_json,'$.schedule.repeat') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ledger_events e WHERE e.projection_id=p.id AND e.event_type='completed' AND NOT EXISTS (SELECT 1 FROM ledger_events undo_e WHERE undo_e.projection_id=p.id AND undo_e.event_type='completion_undone' AND undo_e.rowid>e.rowid))
    ORDER BY json_extract(p.payload_json,'$.schedule.time'),p.created_at LIMIT 100`).all(userId).filter(row => { try { return occursOn(JSON.parse(row.payload_json).schedule, date); } catch { return false; } });
  const today = [...todayRows, ...repeatingRows].map(row => ({ item:dailyItem(`today-${row.projection_id}`,effectiveProjectionText(row),{captureId:row.capture_id}), sources:[dailySource('today',`today-${row.projection_id}`,'capture',row.capture_id,row),dailySource('today',`today-${row.projection_id}`,'projection',row.projection_id,row),dailySource('today',`today-${row.projection_id}`,'interpretation',row.interpretation_id,row)] }));
  sections.push({ key:'today', label:dailySectionLabels.today, empty:'На сегодня задач и встреч нет.', items:today });
  return { content:{ date, timeZone:'Europe/Samara', sections:sections.map(section=>({...section,items:section.items.map(entry=>entry.item)})) }, sourceRows:sections.flatMap(section=>section.items.flatMap(entry=>entry.sources)) };
}
function dailyFingerprint(content, sourceRows) { return crypto.createHash('sha256').update(JSON.stringify({content,sources:sourceRows.map(source=>[source.sectionKey,source.itemKey,source.sourceType,source.sourceId])})).digest('hex'); }
function readBriefSources(db, briefId) { return db.prepare(`SELECT section_key,item_key,source_type,source_id,capture_id FROM daily_brief_sources WHERE daily_brief_id=? ORDER BY rowid`).all(briefId).map(row => ({ sectionKey:row.section_key,itemKey:row.item_key,sourceType:row.source_type,sourceId:row.source_id,action:{kind:'capture',captureId:row.capture_id} })); }
function serializeBrief(db, row) { return { date:row.brief_date, timeZone:row.time_zone, revision:row.revision, generatedAt:row.generated_at, content:JSON.parse(row.content_json), sources:readBriefSources(db,row.id) }; }
export function getDailyBrief(db, { date, timeZone='Europe/Samara', force=false, userId=null }) {
  return withImmediateTransaction(db,()=>{const { content, sourceRows }=dailyContent(db,date,userId),fingerprint=dailyFingerprint(content,sourceRows),latest=db.prepare('SELECT * FROM daily_briefs WHERE user_id IS ? AND brief_date=? AND time_zone=? ORDER BY revision DESC LIMIT 1').get(userId,date,timeZone);if(latest&&latest.effective_fingerprint===fingerprint)return serializeBrief(db,latest);const generatedAt=now(),revision=(latest?.revision||0)+1,briefId=id();db.prepare('INSERT INTO daily_briefs(id,user_id,brief_date,time_zone,revision,generated_at,content_json,effective_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(briefId,userId,date,timeZone,revision,generatedAt,JSON.stringify(content),fingerprint,generatedAt);for(const source of sourceRows)db.prepare('INSERT INTO daily_brief_sources(id,daily_brief_id,section_key,item_key,source_type,source_id,capture_id,projection_id,interpretation_id,ledger_event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id(),briefId,source.sectionKey,source.itemKey,source.sourceType,source.sourceId,source.captureId,source.projectionId,source.interpretationId,source.ledgerEventId,generatedAt);return serializeBrief(db,db.prepare('SELECT * FROM daily_briefs WHERE id=?').get(briefId));});
}
export function findDailyBrief(db, { date, timeZone='Europe/Samara', revision=null, userId=null }) { const row = revision === null ? db.prepare('SELECT * FROM daily_briefs WHERE user_id IS ? AND brief_date=? AND time_zone=? ORDER BY revision DESC LIMIT 1').get(userId,date,timeZone) : db.prepare('SELECT * FROM daily_briefs WHERE user_id IS ? AND brief_date=? AND time_zone=? AND revision=?').get(userId,date,timeZone,revision); return row ? serializeBrief(db,row) : null; }
export function findDailyBriefSource(db,{date,timeZone='Europe/Samara',revision,sourceId,userId=null}) { return db.prepare(`SELECT c.id,c.raw,c.occurred_at,c.created_at FROM daily_brief_sources s JOIN daily_briefs b ON b.id=s.daily_brief_id JOIN captures c ON c.id=s.capture_id WHERE b.user_id IS ? AND b.brief_date=? AND b.time_zone=? AND b.revision=? AND s.source_id=?`).get(userId,date,timeZone,revision,sourceId) || null; }
// Удаление записи — мягкое: строка остаётся в журнале, но помечается временем
// удаления и пропадает из всех списков, поиска и отчётов. Контракт памяти этим
// не нарушается: raw не переписывается, история решений сохраняется, а экспорт
// по-прежнему отдаёт всё — «удалить» здесь значит «убрать с глаз», а не
// «переписать прошлое».
export function deleteCapture(db, captureId) {
  const deletedAt = now();
  return withImmediateTransaction(db, () => {
    const capture = db.prepare('SELECT id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
    if (!capture) return { notFound: true };
    // Проекции снимаются тем же временем: по нему они и вернутся при отмене.
    const reverted = db
      .prepare("UPDATE projections SET status='reverted', reverted_at=? WHERE capture_id=? AND status='active'")
      .run(deletedAt, captureId).changes;
    db.prepare('UPDATE captures SET deleted_at=? WHERE id=?').run(deletedAt, captureId);
    insertLedgerEvent(db, 'capture_deleted', captureId, null, deletedAt);
    return { captureId, deletedAt, revertedProjections: reverted };
  });
}

// Возврат удалённой записи: проекции поднимаются те же, что были сняты при
// удалении — их узнаём по времени, а не по догадке.
export function restoreCapture(db, captureId) {
  const restoredAt = now();
  return withImmediateTransaction(db, () => {
    const capture = db.prepare('SELECT id, deleted_at FROM captures WHERE id=?').get(captureId);
    if (!capture) return { notFound: true };
    if (!capture.deleted_at) return { captureId, restored: false };
    const restored = db
      .prepare("UPDATE projections SET status='active', reverted_at=NULL WHERE capture_id=? AND status='reverted' AND reverted_at=?")
      .run(captureId, capture.deleted_at).changes;
    db.prepare('UPDATE captures SET deleted_at=NULL WHERE id=?').run(captureId);
    insertLedgerEvent(db, 'capture_restored', captureId, null, restoredAt);
    return { captureId, restored: true, restoredProjections: restored };
  });
}

export function undo(db, undoGroupId) { const result = db.prepare("UPDATE projections SET status='reverted', reverted_at=? WHERE undo_group_id=? AND status='active'").run(now(), undoGroupId); return result.changes; }
const memoryStopwords=new Set(['что','было','по','мы','уже','про','о','об','когда','кто','где','как','я','ты','он','она','оно','они','меня','мне','тебя','тебе','его','её','ей','их','нас','нам','вас','вам','себя','свой','моя','мой','твоя','твой','наш','ваш','этот','эта','это','эти','тот','та','то','те','ли','не','да','а','и','в','во','с','со','за','для','от','до','из','на']);
export function normalizeMemoryText(value){return String(value||'').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ')}
function meaningfulTokens(normalized){return [...new Set(normalized.split(' ').filter(token=>token&&!memoryStopwords.has(token)))].slice(0,8)}
// Падежи: «про Даниила» должно находить «с Даниилом». Полноценной морфологии
// здесь нет и не нужно — хватает совпадения по началу слова, и оно ценится
// ниже точного, чтобы порядок выдачи не перевернулся.
const STEM_LENGTH = 5;
function stemMatch(token, rawTokens) {
  if (token.length < STEM_LENGTH) return false;
  const stem = token.slice(0, STEM_LENGTH);
  for (const rawToken of rawTokens) if (rawToken.length >= STEM_LENGTH && rawToken.startsWith(stem)) return true;
  return false;
}
export function search(db, query, userId=null) { const normalizedQuery=normalizeMemoryText(query),tokens=meaningfulTokens(normalizedQuery); const rows=db.prepare('SELECT id,raw,created_at FROM captures WHERE deleted_at IS NULL AND user_id IS ? ORDER BY created_at DESC LIMIT ?').all(userId,500); const results=[]; for(const row of rows){const normalizedRaw=normalizeMemoryText(row.raw),rawTokens=new Set(normalizedRaw.split(' '));const matched=tokens.filter(token=>rawTokens.has(token));const stemmed=tokens.filter(token=>!rawTokens.has(token)&&stemMatch(token,rawTokens));const exact=Boolean(normalizedQuery&&normalizedRaw.includes(normalizedQuery));if(!matched.length&&!stemmed.length&&!exact)continue;const score=(exact?10000:0)+matched.length*100+stemmed.length*40+(tokens.length?(matched.length+stemmed.length*0.5)/tokens.length:0)*10;results.push({captureId:row.id,snippet:row.raw.slice(0,500),createdAt:row.created_at,score})}return results.sort((left,right)=>right.score-left.score||right.createdAt.localeCompare(left.createdAt)).slice(0,12).map(({score,...result})=>result); }
const EXPORT_ROW_LIMIT = 10_000;
const exportTables = ['captures','interpretations','corrections','projections','capture_jobs','capture_job_events','ledger_events','daily_briefs','daily_brief_sources'];
// Экспорт и очистка — только про свой журнал: чужие записи не выгружаются и
// не стираются, даже если очистку запускает администратор.
const MINE = 'capture_id IN (SELECT id FROM captures WHERE user_id IS ?)';
const ownedRows = {
  captures: ['user_id IS ?', 1],
  interpretations: [MINE, 1], corrections: [MINE, 1], projections: [MINE, 1],
  capture_notes: [MINE, 1], capture_attachments: [MINE, 1], capture_jobs: [MINE, 1],
  ledger_events: [MINE, 1],
  capture_job_events: ['job_id IN (SELECT id FROM capture_jobs WHERE ' + MINE + ')', 1],
  daily_briefs: ['user_id IS ?', 1],
  daily_brief_sources: ['daily_brief_id IN (SELECT id FROM daily_briefs WHERE user_id IS ?)', 1],
  usage_events: ['user_id IS ?', 1],
  board_placements: ['user_id IS ?', 1],
  board_columns: ['user_id IS ?', 1],
  // Внешние календари стираются вместе с журналом: чужие события в чистой
  // Кизуне были бы чужими вдвойне. В экспорт они при этом не попадают.
  calendar_links: ['account_id IN (SELECT id FROM calendar_accounts WHERE user_id IS ?)', 1],
  calendar_events: ['account_id IN (SELECT id FROM calendar_accounts WHERE user_id IS ?)', 1],
  calendar_accounts: ['user_id IS ?', 1],
  activity_events: ["json_extract(payload_json,'$.captureId') IN (SELECT id FROM captures WHERE user_id IS ?)", 1],
  // Журнал отправленных напоминаний ссылается на записи — уходит вместе с ними.
  reminder_sends: [MINE, 1],
};
const mineWhere = table => 'WHERE ' + ownedRows[table][0];
function exportRowCount(db, userId) { return exportTables.reduce((total, table) => total + db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${mineWhere(table)}`).get(userId).count, 0); }
export function exportLedger(db, userId = null) {
  const rowCount = exportRowCount(db, userId);
  if (rowCount > EXPORT_ROW_LIMIT) return { limitExceeded:true, rowCount, rowLimit:EXPORT_ROW_LIMIT };
  const mine = (table, columns, order) => db.prepare(`SELECT ${columns} FROM ${table} ${mineWhere(table)} ORDER BY ${order}`).all(userId);
  return {
    schemaVersion:2,
    exportedAt:now(),
    dataClassification:'local-personal-data',
    rowLimit:EXPORT_ROW_LIMIT,
    captures:mine('captures','*','created_at,id'),
    interpretations:mine('interpretations','id,capture_id,version,status,provider,created_at,supersedes_id','created_at,id'),
    corrections:mine('corrections','id,capture_id,interpretation_id,correction_json,note,created_at','created_at,id'),
    projections:mine('projections','id,capture_id,interpretation_id,projection_type,status,undo_group_id,created_at,reverted_at','created_at,id'),
    captureNotes:mine('capture_notes','id,capture_id,version,status,created_at,supersedes_id','created_at,id'),
    captureJobs:mine('capture_jobs','id,capture_id,selected_provider,selected_model,state,stage,retryable,retry_of_id,attempt_count,error_code,used_provider,created_at,started_at,finished_at,cancelled_at','created_at,id'),
    captureJobEvents:mine('capture_job_events','id,job_id,event_type,created_at','created_at,id'),
    ledgerEvents:mine('ledger_events','*','created_at,id'),
    dailyBriefs:mine('daily_briefs','*','brief_date,time_zone,revision'),
    dailyBriefSources:mine('daily_brief_sources','*','daily_brief_id,created_at,id')
  };
}
export function resetLedger(db, userId = null) {
  return withImmediateTransaction(db, () => {
    db.exec('DROP TRIGGER IF EXISTS ledger_events_no_update; DROP TRIGGER IF EXISTS ledger_events_no_delete;');
    try {
      // Порядок важен: сначала то, что ссылается, потом то, на что ссылаются.
      for (const table of ['activity_events','reminder_sends','daily_brief_sources','daily_briefs','ledger_events','capture_job_events','capture_jobs','corrections','projections','interpretations','capture_attachments','capture_notes','usage_events','board_placements','board_columns','calendar_links','calendar_events','calendar_accounts','captures']) db.prepare(`DELETE FROM ${table} ${mineWhere(table)}`).run(userId);
    } finally { createLedgerEventGuards(db); }
  });
}

// ── люди ────────────────────────────────────────────────────────────────────
// Учётные записи живут рядом с журналом, но живут отдельной жизнью: их не
// уносит экспорт, не стирает «Очистить данные» и не видит модель.
const USER_COLUMNS = 'id,email,role,status,totp_enabled,voice_limit_usd,voice_limit_minutes,monthly_limit_usd,voice_limit_window,voice_blocked,created_at,approved_at,approved_by,blocked_at,blocked_reason,last_login_at';

export function createUser(db, { email, passwordHash, role = 'user', status = 'pending' }) {
  const userId = id(), createdAt = now();
  db.prepare('INSERT INTO users(id,email,password_hash,role,status,created_at) VALUES(?,?,?,?,?,?)').run(userId, email, passwordHash, role, status, createdAt);
  return findUserById(db, userId);
}
export function findUserByEmail(db, email) { return db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '')) || null; }
export function findUserById(db, userId) { return db.prepare('SELECT * FROM users WHERE id=?').get(userId) || null; }
export function countUsers(db) { return db.prepare('SELECT COUNT(*) AS count FROM users').get().count; }
export function listUsers(db) {
  // Расход показывается рядом с человеком: без него список пользователей не
  // отвечает на вопрос, ради которого его и открывают.
  return db.prepare(`SELECT ${USER_COLUMNS},
      (SELECT COUNT(*) FROM captures c WHERE c.user_id=users.id AND c.deleted_at IS NULL) AS capture_count,
      (SELECT COALESCE(SUM(cost_usd),0) FROM voice_sessions v WHERE v.user_id=users.id) AS voice_cost_usd,
      (SELECT COALESCE(SUM(seconds),0) FROM voice_sessions v WHERE v.user_id=users.id) AS voice_seconds
    FROM users ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at`).all();
}

// Активность человека: страница «Люди» должна отвечать не только «сколько
// потратил», но и «живёт ли он в приложении». Считается по уже записанному —
// записи, закрытые дела, разговоры, подключённые календари и уведомления, —
// поэтому отдельного журнала действий заводить не нужно. Полоса дней —
// местные даты, а не UTC: вечерняя запись не должна попадать в завтра.
export function userActivity(db, { now: at = new Date(), timeZone = 'UTC', days = 30 } = {}) {
  const dayMs = 86400000;
  const sinceIso = new Date(at.getTime() - days * dayMs).toISOString();
  const weekIso = new Date(at.getTime() - 7 * dayMs).toISOString();
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const band = [];
  for (let step = days - 1; step >= 0; step -= 1) band.push(format.format(new Date(at.getTime() - step * dayMs)));
  const position = new Map(band.map((date, index) => [date, index]));
  const users = new Map();
  const blank = () => ({ lastCaptureAt: null, capturesWeek: 0, capturesPeriod: 0, completedPeriod: 0, voiceSeconds: 0, voiceSessions: 0, calendars: 0, pushDevices: 0, days: band.map(() => 0) });
  for (const row of db.prepare('SELECT id FROM users').all()) users.set(row.id, blank());
  const of = (userId) => (userId === null || userId === undefined ? null : users.get(userId) || null);

  for (const row of db.prepare('SELECT user_id, MAX(created_at) AS last FROM captures WHERE deleted_at IS NULL GROUP BY user_id').all()) {
    const user = of(row.user_id);
    if (user) user.lastCaptureAt = row.last;
  }
  for (const row of db.prepare('SELECT user_id, created_at FROM captures WHERE deleted_at IS NULL AND created_at >= ?').all(sinceIso)) {
    const user = of(row.user_id);
    if (!user) continue;
    user.capturesPeriod += 1;
    if (row.created_at >= weekIso) user.capturesWeek += 1;
    const index = position.get(format.format(new Date(row.created_at)));
    if (index !== undefined) user.days[index] += 1;
  }
  // Закрытое дело — событие журнала, отдельной таблицы «сделано» нет.
  for (const row of db.prepare(`SELECT c.user_id AS user_id, COUNT(*) AS count FROM ledger_events e
      JOIN captures c ON c.id=e.capture_id
      WHERE e.event_type='completed' AND e.created_at >= ? GROUP BY c.user_id`).all(sinceIso)) {
    const user = of(row.user_id);
    if (user) user.completedPeriod = row.count;
  }
  for (const row of db.prepare('SELECT user_id, COUNT(*) AS count, COALESCE(SUM(seconds),0) AS seconds FROM voice_sessions WHERE started_at >= ? GROUP BY user_id').all(sinceIso)) {
    const user = of(row.user_id);
    if (user) { user.voiceSessions = row.count; user.voiceSeconds = row.seconds; }
  }
  for (const row of db.prepare('SELECT user_id, COUNT(*) AS count FROM calendar_accounts WHERE disabled_at IS NULL GROUP BY user_id').all()) {
    const user = of(row.user_id);
    if (user) user.calendars = row.count;
  }
  for (const row of db.prepare('SELECT user_id, COUNT(*) AS count FROM push_subscriptions WHERE failed_at IS NULL GROUP BY user_id').all()) {
    const user = of(row.user_id);
    if (user) user.pushDevices = row.count;
  }
  return { days: band, since: sinceIso, users: Object.fromEntries(users) };
}
// Правится только то, что перечислено: список полей — это и есть граница между
// «администратор поменял роль» и «кто-то переписал чужой пароль».
const EDITABLE_USER_FIELDS = new Set(['role','status','password_hash','totp_secret','totp_pending_secret','totp_enabled','recovery_codes_json','voice_limit_usd','voice_limit_minutes','monthly_limit_usd','voice_limit_window','voice_blocked','approved_at','approved_by','blocked_at','blocked_reason','last_login_at','failed_attempts','locked_until','email']);
export function updateUser(db, userId, patch) {
  const fields = Object.entries(patch).filter(([field]) => EDITABLE_USER_FIELDS.has(field));
  if (!fields.length) return findUserById(db, userId);
  db.prepare(`UPDATE users SET ${fields.map(([field]) => `${field}=?`).join(',')} WHERE id=?`).run(...fields.map(([, value]) => value), userId);
  return findUserById(db, userId);
}
// Первая учётная запись забирает себе всё, что было записано до появления
// людей: иначе журнал, который человек вёл до обновления, оказался бы ничьим и
// пропал бы у него из глаз.
export function adoptOrphanRecords(db, userId) {
  return withImmediateTransaction(db, () => {
    const captures = db.prepare('UPDATE captures SET user_id=? WHERE user_id IS NULL').run(userId).changes;
    db.prepare('UPDATE capture_jobs SET user_id=? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE usage_events SET user_id=? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE voice_sessions SET user_id=? WHERE user_id IS NULL').run(userId);
    // Отчёты уникальны по (хозяин, дата, ревизия): у ничьих отчётов хозяин уже
    // есть — это тот же человек, поэтому столкновения быть не может.
    db.prepare('UPDATE daily_briefs SET user_id=? WHERE user_id IS NULL').run(userId);
    return captures;
  });
}

// ── сессии ──────────────────────────────────────────────────────────────────
export function createSession(db, { tokenHash, userId, expiresAt, userAgent = null }) {
  const at = now();
  db.prepare('INSERT INTO user_sessions(id,user_id,created_at,last_seen_at,expires_at,user_agent) VALUES(?,?,?,?,?,?)').run(tokenHash, userId, at, at, expiresAt, userAgent ? String(userAgent).slice(0, 200) : null);
  return { tokenHash, userId, expiresAt };
}
export function findSessionUser(db, tokenHash, at = now()) {
  return db.prepare('SELECT u.*, s.expires_at session_expires_at FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at > ?').get(tokenHash, at) || null;
}
export function touchSession(db, tokenHash, at = now()) { db.prepare('UPDATE user_sessions SET last_seen_at=? WHERE id=?').run(at, tokenHash); }
export function deleteSession(db, tokenHash) { return db.prepare('DELETE FROM user_sessions WHERE id=?').run(tokenHash).changes; }
export function deleteUserSessions(db, userId) { return db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(userId).changes; }
export function purgeExpiredSessions(db, at = now()) { return db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(at).changes; }
export function countUserSessions(db, userId, at = now()) { return db.prepare('SELECT COUNT(*) AS count FROM user_sessions WHERE user_id=? AND expires_at > ?').get(userId, at).count; }

// ── журнал входов ───────────────────────────────────────────────────────────
// Кто и когда пытался войти — единственный след, по которому потом можно
// понять, был ли перебор. Пароли и коды сюда не попадают никогда.
export function logAuthEvent(db, { userId = null, email = null, event, result, detail = null }) {
  try { db.prepare('INSERT INTO auth_events(id,user_id,email,event,result,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(id(), userId, email, event, result, detail, now()); } catch {}
}
export function listAuthEvents(db, { limit = 50, userId = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return userId
    ? db.prepare('SELECT * FROM auth_events WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(userId, capped)
    : db.prepare('SELECT * FROM auth_events ORDER BY created_at DESC LIMIT ?').all(capped);
}

// ── разговоры и их цена ─────────────────────────────────────────────────────
// Звук идёт напрямую к провайдеру, мимо сервера, поэтому настоящего счёта у нас
// нет: считаем минуты разговора и умножаем на заданную цену. Это оценка, и она
// названа оценкой везде, где показывается, — но лимит по ней работает честно,
// потому что минуты мы знаем точно.
export function openVoiceSession(db, { userId = null, provider, model = null, ratePerMinute = 0, startedAt = now() }) {
  const sessionId = id();
  db.prepare('INSERT INTO voice_sessions(id,user_id,provider,model,rate_usd_per_minute,started_at) VALUES(?,?,?,?,?,?)').run(sessionId, userId, provider, model, ratePerMinute, startedAt);
  return sessionId;
}
export function closeVoiceSession(db, sessionId, { seconds, at = now(), closedBy = 'client' }) {
  const session = db.prepare('SELECT * FROM voice_sessions WHERE id=?').get(sessionId);
  if (!session) return null;
  if (session.ended_at) return session;
  // Длительность приходит из браузера, поэтому ей нельзя верить на слово: она
  // обрезается по времени, которое реально прошло с начала разговора.
  const elapsed = Math.max(0, Math.round((new Date(at).getTime() - new Date(session.started_at).getTime()) / 1000));
  const claimed = Number.isFinite(Number(seconds)) ? Math.max(0, Math.round(Number(seconds))) : elapsed;
  const counted = Math.min(claimed, elapsed + 5);
  const cost = (counted / 60) * (session.rate_usd_per_minute || 0);
  db.prepare('UPDATE voice_sessions SET ended_at=?, seconds=?, cost_usd=?, closed_by=? WHERE id=?').run(at, counted, cost, closedBy, sessionId);
  return db.prepare('SELECT * FROM voice_sessions WHERE id=?').get(sessionId);
}
// Разговор, о котором браузер не отчитался (вкладку закрыли, связь пропала),
// иначе висел бы открытым вечно и не попадал бы в расход. Закрываем по потолку
// длительности — так забытый разговор считается дорого, а не бесплатно.
export function closeStaleVoiceSessions(db, { at = now(), maxSeconds = 3600 } = {}) {
  const cutoff = new Date(new Date(at).getTime() - maxSeconds * 1000).toISOString();
  const stale = db.prepare('SELECT id FROM voice_sessions WHERE ended_at IS NULL AND started_at <= ?').all(cutoff);
  for (const row of stale) closeVoiceSession(db, row.id, { seconds: maxSeconds, at, closedBy: 'timeout' });
  return stale.length;
}
const VOICE_WINDOW_MS = { day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000 };
export function voiceWindowStart(window, at = new Date()) {
  const span = VOICE_WINDOW_MS[window];
  return span ? new Date(at.getTime() - span).toISOString() : '';
}
export function voiceSpend(db, { userId, window = 'day', at = new Date() } = {}) {
  const since = voiceWindowStart(window, at);
  const everyone = userId === undefined;
  const row = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(seconds),0) AS seconds, COUNT(*) AS sessions
    FROM voice_sessions WHERE started_at >= ? ${everyone ? '' : 'AND user_id IS ?'}`).get(...(everyone ? [since] : [since, userId]));
  return { window, since: since || null, costUsd: row.cost, seconds: row.seconds, sessions: row.sessions };
}
export function listVoiceSessions(db, { userId, limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return userId === undefined
    ? db.prepare('SELECT * FROM voice_sessions ORDER BY started_at DESC LIMIT ?').all(capped)
    : db.prepare('SELECT * FROM voice_sessions WHERE user_id IS ? ORDER BY started_at DESC LIMIT ?').all(userId, capped);
}
// Кому принадлежит запись: одна проверка на все маршруты, которые берут id из
// адреса. Без неё чужой идентификатор открывал бы чужую карточку.
// undefined — «такого нет вовсе», null — «есть, но ничей». Свести их к одному
// значению нельзя: ничья запись бывает у журнала, который вели до появления
// людей, и она должна оставаться доступной, а не исчезать.
const ownerOf = (row) => row ? row.user_id : undefined;
export function captureOwner(db, captureId) { return ownerOf(db.prepare('SELECT user_id FROM captures WHERE id=?').get(captureId)); }
export function attachmentOwner(db, attachmentId) { return ownerOf(db.prepare('SELECT c.user_id FROM capture_attachments a JOIN captures c ON c.id=a.capture_id WHERE a.id=?').get(attachmentId)); }
export function projectionOwner(db, projectionId) { return ownerOf(db.prepare('SELECT c.user_id FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.id=?').get(projectionId)); }
export function undoGroupOwner(db, undoGroupId) { return ownerOf(db.prepare('SELECT c.user_id FROM projections p JOIN captures c ON c.id=p.capture_id WHERE p.undo_group_id=? LIMIT 1').get(undoGroupId)); }

// ── расход за календарный месяц ─────────────────────────────────────────────
// Скользящее окно годится для «предела разговора», но деньги человек считает
// по календарю: «сколько ушло в августе» и «первого числа снова можно». Поэтому
// у месячного потолка границы календарные — в поясе, настроенном в приложении.
function zoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const match = (parts.find(part => part.type === 'timeZoneName')?.value || 'GMT+00:00').match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0));
}
export function monthBounds(at = new Date(), timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = Number(parts.find(part => part.type === 'year').value);
  const month = Number(parts.find(part => part.type === 'month').value);
  // Полночь первого числа по местному времени — это момент UTC, сдвинутый на
  // смещение пояса; смещение берётся на сам этот момент, иначе перевод часов
  // внутри месяца сдвинул бы границу на час.
  const localMidnight = (y, m) => { const guess = Date.UTC(y, m - 1, 1); return new Date(guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000).toISOString(); };
  return {
    month: `${year}-${String(month).padStart(2, '0')}`,
    start: localMidnight(year, month),
    end: localMidnight(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1),
  };
}
// Что считается расходом: цена вызовов модели, где провайдер её назвал, плюс
// оценка разговора по минутам. Вызовы без цены в сумму не входят и считаются
// отдельно — иначе сумма выглядела бы полной, не будучи ею.
export function monthlySpend(db, { userId, at = new Date(), timeZone = 'UTC' } = {}) {
  const { month, start, end } = monthBounds(at, timeZone);
  const everyone = userId === undefined;
  const scope = everyone ? [start, end] : [start, end, userId];
  const models = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls,
      SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM usage_events WHERE created_at >= ? AND created_at < ? ${everyone ? '' : 'AND user_id IS ?'}`).get(...scope);
  const voice = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(seconds),0) AS seconds
    FROM voice_sessions WHERE started_at >= ? AND started_at < ? ${everyone ? '' : 'AND user_id IS ?'}`).get(...scope);
  return {
    month, since: start, until: end,
    modelUsd: models.cost, voiceUsd: voice.cost, totalUsd: models.cost + voice.cost,
    calls: models.calls, unpriced: models.unpriced || 0, voiceSeconds: voice.seconds,
  };
}
