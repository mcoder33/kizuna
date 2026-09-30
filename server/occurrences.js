// Экземпляры повтора, закрытые кружком: событие леджера occurrence_completed с
// {date} в payload. Сама запись при этом не закрывается — закрыт один день
// серии. Снятие — отдельное событие occurrence_undone (леджер только дописывается).
// Привязка идёт по записи, а не по проекции: поправка пересобирает проекции,
// а закрытые дни серии должны пережить её.
const KINDS = "('occurrence_completed','occurrence_undone')";

function fold(rows) {
  const out = new Map();
  for (const row of rows) {
    let date = null;
    try { date = JSON.parse(row.payload || '{}').date || null; } catch { date = null; }
    if (!date) continue;
    if (!out.has(row.capture_id)) out.set(row.capture_id, new Map());
    const days = out.get(row.capture_id);
    if (row.event_type === 'occurrence_completed') days.set(date, row.occurred_at || row.created_at);
    else days.delete(date);
  }
  return out;
}

// Закрытые экземпляры по всем записям пользователя: capture_id → Map(день → время закрытия).
export function occurrencesByCapture(db, userId) {
  return fold(db.prepare(`SELECT e.capture_id, e.event_type, e.occurred_at, e.created_at, e.payload FROM ledger_events e JOIN captures c ON c.id=e.capture_id
    WHERE e.event_type IN ${KINDS} AND c.user_id IS ? ORDER BY e.rowid`).all(userId));
}

// Закрытые экземпляры одной записи: [{date, completedAt}] по возрастанию дня.
export function occurrencesOf(db, captureId) {
  const days = fold(db.prepare(`SELECT capture_id, event_type, occurred_at, created_at, payload FROM ledger_events WHERE capture_id=? AND event_type IN ${KINDS} ORDER BY rowid`).all(captureId)).get(captureId);
  return [...(days || [])].map(([date, completedAt]) => ({ date, completedAt })).sort((left, right) => left.date.localeCompare(right.date));
}
