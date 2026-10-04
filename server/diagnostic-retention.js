// These tables are technical diagnostics. Captures, interpretations, corrections,
// job state and factual ledger events are user data and must not be pruned here.
export function pruneDiagnostics(db, { at = new Date(), authDays = 90, authRows = 20000, searchDays = 30, searchRows = 10000 } = {}) {
  const prune = (table, days, rows) => {
    const cutoff = new Date(at.getTime() - days * 86400000).toISOString();
    const expired = db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(cutoff).changes;
    const excess = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(rows).changes;
    return expired + excess;
  };
  return db.transaction(() => ({ auth: prune('auth_events',authDays,authRows), search: prune('entry_search_traces',searchDays,searchRows) }))();
}
