// Миграция 21: заметки как страницы — место в дереве, связи [[…]] и базы.
//
// Страница — это обычная запись с типом «заметка» или «идея»: разбор, версии
// тела, обсуждение и круги у неё те же. Здесь живёт только то, чего у записи
// раньше не было.
//
// - note_places — место страницы в дереве. Строки нет — место выводится: под
//   страницей своего проекта или во «Входящих». parent_id NULL — корень,
//   выбранный человеком. source: manual — указал руками, text — прочитано из
//   самой записи («[[Релиз 1.4]] …», «в релиз 1.4: …»).
// - note_links — внутренние ссылки. Связь хранит id страницы, куда вела ссылка
//   в момент сохранения: переименованная страница не теряет ссылок на себя.
//   to_id NULL — страницы с таким именем пока нет.
// - note_bases — сохранённые виды: фильтр, сортировка и раскладка.
//
// Модуль без зависимостей: его зовёт openDatabase, а логика страниц
// (server/notes-tree.js) сама пользуется db.js — так не возникает цикла.
export function migrateNotesTree(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS note_places (
      capture_id TEXT PRIMARY KEY REFERENCES captures(id),
      parent_id TEXT REFERENCES captures(id),
      source TEXT NOT NULL CHECK(source IN ('manual','text')),
      placed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_places_parent ON note_places(parent_id);
    CREATE TABLE IF NOT EXISTS note_links (
      from_id TEXT NOT NULL REFERENCES captures(id),
      label TEXT NOT NULL,
      to_id TEXT REFERENCES captures(id),
      context TEXT NOT NULL,
      PRIMARY KEY(from_id, label)
    );
    CREATE INDEX IF NOT EXISTS note_links_to ON note_links(to_id);
    CREATE TABLE IF NOT EXISTS note_bases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      view_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_bases_user ON note_bases(user_id, created_at);`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(21, new Date().toISOString());
}
