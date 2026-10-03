// History for Telegram reviews: observation time is distinct from the event's day.
const clockSql = "day_summary_observed_at()";
const sources = [
  { table:'interpretations', kind:'interpretation', key:r=>`${r}.id`, owner:r=>`(SELECT user_id FROM captures WHERE id=${r}.capture_id)`, subject:r=>`${r}.capture_id`, fields:r=>`json_object('capture_id',${r}.capture_id,'occurred_at',(SELECT occurred_at FROM captures WHERE id=${r}.capture_id))`, at:r=>`${r}.created_at`, updates:false },
  { table:'calendar_events', kind:'external', key:r=>`json_array(${r}.account_id,${r}.calendar_id,${r}.uid,COALESCE(${r}.instance_key,''))`, owner:r=>`(SELECT user_id FROM calendar_accounts WHERE id=${r}.account_id)`, subject:r=>`${r}.account_id`, fields:r=>`json_object('account_id',${r}.account_id,'calendar_id',${r}.calendar_id,'uid',${r}.uid,'series_uid',${r}.series_uid,'instance_key',${r}.instance_key,'title',${r}.title,'start_at',${r}.start_at,'end_at',${r}.end_at,'all_day',${r}.all_day,'busy',${r}.busy,'attendees_json',${r}.attendees_json)` },
  { table:'calendar_accounts', kind:'account', key:r=>`${r}.id`, owner:r=>`${r}.user_id`, subject:r=>`${r}.id`, fields:r=>`json_object('calendars_json',${r}.calendars_json,'mode',${r}.mode,'disabled_at',${r}.disabled_at,'synced_at',${r}.synced_at,'identity_email',lower(trim(COALESCE(${r}.username,''))))` },
  { table:'assignments', kind:'assignment', key:r=>`${r}.id`, owner:r=>`(SELECT user_id FROM captures WHERE id=${r}.capture_id)`, subject:r=>`${r}.assignee_id`, fields:r=>`json_object('capture_id',${r}.capture_id,'assignee_id',${r}.assignee_id,'state',${r}.state,'responded_at',${r}.responded_at,'done_at',${r}.done_at,'cancelled_at',${r}.cancelled_at)` },
  { table:'circle_members', kind:'member', key:r=>`json_array(${r}.circle_id,${r}.user_id)`, owner:r=>`${r}.user_id`, subject:r=>`${r}.circle_id`, fields:r=>`json_object('circle_id',${r}.circle_id,'user_id',${r}.user_id,'left_at',${r}.left_at)` },
  { table:'capture_circles', kind:'share', key:r=>`json_array(${r}.capture_id,${r}.circle_id)`, owner:r=>`(SELECT user_id FROM captures WHERE id=${r}.capture_id)`, subject:r=>`${r}.capture_id`, fields:r=>`json_object('capture_id',${r}.capture_id,'circle_id',${r}.circle_id,'removed_at',${r}.removed_at)` },
  { table:'capture_people', kind:'participant', key:r=>`json_array(${r}.capture_id,${r}.user_id)`, owner:r=>`(SELECT user_id FROM captures WHERE id=${r}.capture_id)`, subject:r=>`${r}.user_id`, fields:r=>`json_object('capture_id',${r}.capture_id,'user_id',${r}.user_id,'removed_at',${r}.removed_at)` },
];

export function migrateDaySummaryHistory(db, at = new Date().toISOString(), { now = () => new Date() } = {}) {
  db.function('day_summary_observed_at', () => now().toISOString());
  db.exec(`CREATE TABLE IF NOT EXISTS day_summary_history_meta (id INTEGER PRIMARY KEY CHECK(id=1), observed_from TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS day_summary_user_resets (user_id TEXT PRIMARY KEY, reset_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS day_summary_history (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_key TEXT NOT NULL, user_id TEXT,
      subject_id TEXT, observed_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS day_summary_history_source ON day_summary_history(source,source_key,observed_at,id);
    CREATE INDEX IF NOT EXISTS day_summary_history_user ON day_summary_history(user_id,source,observed_at);
    CREATE INDEX IF NOT EXISTS day_summary_history_subject ON day_summary_history(source,subject_id,observed_at);
    CREATE INDEX IF NOT EXISTS day_summary_captures_user ON captures(user_id,created_at);
    CREATE INDEX IF NOT EXISTS day_summary_interpretations_capture ON interpretations(capture_id,created_at,version);
    CREATE INDEX IF NOT EXISTS day_summary_projections_interpretation ON projections(interpretation_id,created_at);
    CREATE INDEX IF NOT EXISTS day_summary_projection_completion ON ledger_events(projection_id,created_at) WHERE event_type IN ('completed','completion_undone');
    CREATE TABLE IF NOT EXISTS telegram_summary_receipts (
      user_id TEXT NOT NULL, local_date TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('morning','evening')),
      status TEXT NOT NULL CHECK(status IN ('reserved','sent','retry','failed','uncertain')),
      telegram_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, reserved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, retry_at TEXT, message_id TEXT, error_code TEXT,
      PRIMARY KEY(user_id,local_date,phase));`);
  const receiptColumns=new Set(db.prepare('PRAGMA table_info(telegram_summary_receipts)').all().map(column=>column.name));
  for(const column of ['binding_linked_at','due_at','grace_deadline','schedule_signature'])if(!receiptColumns.has(column))db.exec(`ALTER TABLE telegram_summary_receipts ADD COLUMN ${column} TEXT`);
  const first = db.prepare('INSERT OR IGNORE INTO day_summary_history_meta VALUES(1,?)').run(at).changes;
  for (const source of sources) {
    if (first) db.prepare(`INSERT INTO day_summary_history(source,source_key,user_id,subject_id,observed_at,snapshot_json)
      SELECT ?,${source.key('s')},${source.owner('s')},${source.subject('s')},?,${source.fields('s')} FROM ${source.table} s`).run(source.kind,at);
    if (source.updates !== false) db.exec(`CREATE TRIGGER IF NOT EXISTS day_summary_${source.table}_key_change AFTER UPDATE ON ${source.table}
      WHEN ${source.key('OLD')} IS NOT ${source.key('NEW')} BEGIN
      INSERT INTO day_summary_history(source,source_key,user_id,subject_id,observed_at,deleted,snapshot_json)
      VALUES('${source.kind}',${source.key('OLD')},${source.owner('OLD')},${source.subject('OLD')},${clockSql},1,${source.fields('OLD')}); END;`);
    for (const operation of source.updates === false ? ['INSERT'] : ['INSERT','UPDATE','DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      db.exec(`CREATE TRIGGER IF NOT EXISTS day_summary_${source.table}_${operation.toLowerCase()} AFTER ${operation} ON ${source.table}${operation === 'UPDATE' ? ` WHEN ${source.fields('OLD')} IS NOT ${source.fields('NEW')}` : ''} BEGIN
        INSERT INTO day_summary_history(source,source_key,user_id,subject_id,observed_at,deleted,snapshot_json)
        VALUES('${source.kind}',${source.key(row)},${source.owner(row)},${source.subject(row)},${source.at ? source.at(row) : clockSql},${operation === 'DELETE' ? 1 : 0},${source.fields(row)}); END;`);
    }
  }
}

export function historySnapshot(db, source, key, cutoff) {
  return db.prepare('SELECT * FROM day_summary_history WHERE source=? AND source_key=? AND observed_at<? ORDER BY observed_at DESC,id DESC LIMIT 1').get(source,key,cutoff) || null;
}

export function reserveSummaryReceipt(db, { userId, date, phase, telegramUserId, chatId, linkedAt = null, dueAt = null, graceDeadline = null, scheduleSignature = null, now }) {
  return Boolean(db.prepare(`INSERT OR IGNORE INTO telegram_summary_receipts
    (user_id,local_date,phase,status,telegram_user_id,chat_id,reserved_at,updated_at,binding_linked_at,due_at,grace_deadline,schedule_signature)
    VALUES(?,?,?,'reserved',?,?,?,?,?,?,?,?)`).run(userId,date,phase,String(telegramUserId),String(chatId),now,now,linkedAt,dueAt,graceDeadline,scheduleSignature).changes);
}
export function claimSummaryRetry(db,{userId,date,phase,telegramUserId,chatId,linkedAt,dueAt,graceDeadline,scheduleSignature,now}) {
  return Boolean(db.prepare("UPDATE telegram_summary_receipts SET status='reserved',reserved_at=?,updated_at=?,retry_at=NULL,error_code=NULL WHERE user_id=? AND local_date=? AND phase=? AND status='retry' AND retry_at<=? AND telegram_user_id=? AND chat_id=? AND binding_linked_at=? AND due_at=? AND grace_deadline=? AND schedule_signature=? AND due_at<=? AND grace_deadline>=?").run(now,now,userId,date,phase,now,String(telegramUserId),String(chatId),linkedAt,dueAt??null,graceDeadline??null,scheduleSignature??null,now,now).changes);
}
export function updateSummaryReceipt(db, { userId, date, phase, status, now, retryAt = null, messageId = null, errorCode = null }) {
  return db.prepare(`UPDATE telegram_summary_receipts SET status=?,updated_at=?,retry_at=?,message_id=?,error_code=?
    WHERE user_id=? AND local_date=? AND phase=?`).run(status,now,retryAt,messageId === null ? null : String(messageId),errorCode,userId,date,phase).changes;
}
export function recoverSummaryReceipts(db, now = new Date().toISOString()) {
  return db.prepare("UPDATE telegram_summary_receipts SET status='uncertain',updated_at=?,error_code='interrupted_delivery' WHERE status='reserved'").run(now).changes;
}
export function daySummaryHistoryRowCount(db,userId) {
  return db.prepare('SELECT (SELECT count(*) FROM day_summary_history WHERE user_id IS ?) + (SELECT count(*) FROM telegram_summary_receipts WHERE user_id IS ?) AS count').get(userId,userId).count;
}
export function exportDaySummaryHistory(db, userId) {
  return {
    resetAt:db.prepare('SELECT reset_at FROM day_summary_user_resets WHERE user_id IS ?').get(userId)?.reset_at || null,
    observedFrom:db.prepare('SELECT observed_from FROM day_summary_history_meta WHERE id=1').get().observed_from,
    snapshots:db.prepare('SELECT * FROM day_summary_history WHERE user_id IS ? ORDER BY id').all(userId),
    receipts:db.prepare('SELECT * FROM telegram_summary_receipts WHERE user_id IS ? ORDER BY local_date,phase').all(userId),
  };
}
export function resetDaySummaryHistory(db, userId) {
  // Reset runs after DELETE triggers, so neither snapshots nor tombstones survive.
  db.prepare('DELETE FROM day_summary_history WHERE user_id IS ?').run(userId);
  db.prepare('DELETE FROM telegram_summary_receipts WHERE user_id IS ?').run(userId);
  if (userId !== null) db.prepare('INSERT INTO day_summary_user_resets(user_id,reset_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET reset_at=excluded.reset_at').run(userId,new Date().toISOString());
}
