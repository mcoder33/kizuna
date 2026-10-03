import { randomUUID } from 'node:crypto';

// Preserve the final durable text before returning to ordinary notes and circles.
// Historical collaboration tables remain dormant for audit and recovery.
export function retirePublicCollaboration(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=30').get()) return;
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  db.transaction(() => {
    const at = new Date().toISOString();
    if (hasTable('collaborative_documents')) {
      for (const document of db.prepare('SELECT * FROM collaborative_documents').all()) {
        const previousNote = db.prepare("SELECT * FROM capture_notes WHERE capture_id=? AND status='active'").get(document.capture_id);
        if (previousNote?.body !== document.body) {
          if (previousNote) db.prepare("UPDATE capture_notes SET status='superseded' WHERE id=?").run(previousNote.id);
          db.prepare('INSERT INTO capture_notes(id,capture_id,version,status,body,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?)')
            .run(randomUUID(),document.capture_id,(previousNote?.version || 0)+1,'active',document.body,at,previousNote?.id || null);
        }
        const previous = db.prepare("SELECT * FROM interpretations WHERE capture_id=? AND status='active'").get(document.capture_id);
        if (previous) {
          const classification = JSON.parse(previous.classification_json);
          if (classification.summary !== document.title) {
            const interpretationId = randomUUID();
            classification.summary = document.title;
            db.prepare("UPDATE interpretations SET status='superseded' WHERE id=?").run(previous.id);
            db.prepare('INSERT INTO interpretations(id,capture_id,version,status,provider,model,classification_json,field_confidence_json,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
              .run(interpretationId,document.capture_id,previous.version+1,'active',previous.provider,previous.model,JSON.stringify(classification),previous.field_confidence_json,at,previous.id);
            db.prepare("UPDATE projections SET interpretation_id=? WHERE capture_id=? AND status='active'").run(interpretationId,document.capture_id);
          }
        }
        for (const projection of db.prepare("SELECT id,payload_json FROM projections WHERE capture_id=? AND status='active'").all(document.capture_id)) {
          const payload = JSON.parse(projection.payload_json);
          payload.title = document.title || 'Без названия';
          db.prepare('UPDATE projections SET payload_json=? WHERE id=?').run(JSON.stringify(payload),projection.id);
        }
      }
    }
    if (hasTable('public_todo_shares')) db.prepare('UPDATE public_todo_shares SET revoked_at=COALESCE(revoked_at,?)').run(at);
    // Retain the old denial audit, but do not let it prevent ordinary account deletion.
    if (hasTable('circle_share_denials')) db.exec(`CREATE TRIGGER IF NOT EXISTS retired_circle_denials_user_delete
      BEFORE DELETE ON users BEGIN DELETE FROM circle_share_denials WHERE user_id=OLD.id; END;`);
    db.prepare("UPDATE circle_members SET role='member' WHERE role='editor'").run();
    if (db.prepare('PRAGMA table_info(circle_members)').all().some(column => column.name === 'can_edit')) db.prepare('UPDATE circle_members SET can_edit=0').run();
    if (db.prepare('PRAGMA table_info(capture_circles)').all().some(column => column.name === 'persistent')) db.prepare('UPDATE capture_circles SET persistent=0').run();
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(30,?)').run(at);
  })();
}
