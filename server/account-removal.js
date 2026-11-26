import { forgetAvatar } from './avatars.js';
import { deleteUserSessions, findUserById, resetLedger, logAuthEvent } from './db.js';

const sharedData = () => ({ error: [409, 'user_has_shared_data', 'У пользователя есть общие данные. Учётную запись можно заблокировать.'] });

// Account deletion and its audit record commit together. A dependency on another
// person's workspace must roll back the whole operation, including the sessions.
export function removeAccount(db, { userId, actorId, actorLabel, ip = null, deleteEntries = false }) {
  try {
    return db.transaction(() => {
      const target = findUserById(db, userId);
      if (!target) return { error: [404, 'not_found', 'Пользователь не найден.'] };
      if (target.id === actorId) return { error: [409, 'self_delete', 'Себя удалить нельзя.'] };
      if (target.role === 'admin' && target.status === 'active' &&
          !db.prepare("SELECT 1 FROM users WHERE id<>? AND role='admin' AND status='active'").get(userId)) {
        return { error: [409, 'last_admin', 'Это последний администратор — снимать роль некому.'] };
      }

      const entries = db.prepare('SELECT 1 FROM captures WHERE user_id=? AND deleted_at IS NULL LIMIT 1').get(userId);
      if (entries && (target.status !== 'blocked' || !deleteEntries)) {
        return { error: [409, 'user_has_data', 'Заблокируйте пользователя и подтвердите удаление его записей.'] };
      }
      // resetLedger also clears discussions and assignments on the owner's
      // entries. Keep shared history available to the other participants.
      for (const table of ['capture_circles', 'capture_people', 'assignments']) {
        if (db.prepare(`SELECT 1 FROM ${table} JOIN captures c ON c.id=capture_id WHERE c.user_id=? LIMIT 1`).get(userId)) return sharedData();
      }
      if (db.prepare('SELECT 1 FROM comments m JOIN captures c ON c.id=m.capture_id WHERE c.user_id=? AND m.author_id<>c.user_id LIMIT 1').get(userId)) return sharedData();
      const attachments = db.prepare('SELECT a.id FROM capture_attachments a JOIN captures c ON c.id=a.capture_id WHERE c.user_id=?').all(userId);
      resetLedger(db, userId);
      deleteUserSessions(db, userId);
      forgetAvatar(db, userId);
      for (const table of ['notifications', 'push_subscriptions', 'voice_sessions',
        'telegram_links', 'telegram_codes', 'task_search_intents', 'task_search_receipts', 'day_summary_user_resets']) {
        db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
      }
      db.prepare('DELETE FROM app_settings WHERE key GLOB ?').run(`user:${userId}:*`);
      db.prepare('DELETE FROM users WHERE id=?').run(userId);
      logAuthEvent(db, { email: target.email, event: 'admin_delete', result: 'succeeded', detail: actorLabel, ip });
      return { attachments };
    }).immediate();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return sharedData();
    throw error;
  }
}
