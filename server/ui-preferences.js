import { validUiPreference } from '../public/ui-preference-schema.js';
// Same per-account key used by the existing settings API.
const themeKeyFor = userId => `user:${userId}:theme`;

const keyFor = userId => `uiPreferences:${userId}`;
export function readUiPreferences(db, userId) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(keyFor(userId));
  const record = row ? JSON.parse(row.value) : { revision: 0, values: {} };
  const setting = db.prepare('SELECT value FROM app_settings WHERE key=?');
  const theme = setting.get(themeKeyFor(userId)) ?? setting.get('theme');
  if (theme || Object.hasOwn(record.values, 'pagent.theme')) record.values['pagent.theme'] = ['system', 'light', 'dark'].includes(theme?.value) ? theme.value : null;
  return { userId, ...record };
}

export function writeUiPreferences(db, userId, patch, { onlyIfMissing = [], mirrorTheme = true } = {}) {
  return db.transaction(() => {
    const current = readUiPreferences(db, userId);
    const changes = Object.fromEntries(Object.entries(patch).filter(([key]) => !onlyIfMissing.includes(key) || !Object.hasOwn(current.values, key)));
    const record = { revision: current.revision + 1, values: { ...current.values, ...changes } };
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(keyFor(userId), JSON.stringify(record), new Date().toISOString());
    if (mirrorTheme && Object.hasOwn(changes, 'pagent.theme')) {
      const themeKey = themeKeyFor(userId);
      if (changes['pagent.theme'] === null) db.prepare('DELETE FROM app_settings WHERE key=?').run(themeKey);
      else db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(themeKey, changes['pagent.theme'], new Date().toISOString());
    }
    return readUiPreferences(db, userId);
  })();
}

export function mountUiPreferences(app, { db, notifyUser, onChanged = () => {} }) {
  app.get('/api/ui-preferences', (req, res) => res.json(readUiPreferences(db, req.user.id)));
  app.patch('/api/ui-preferences', (req, res) => {
    if (req.body?.userId !== req.user.id) return res.status(409).json({ error: { code: 'account_changed', message: 'Учётная запись изменилась.' } });
    const patch = req.body?.changes;
    const onlyIfMissing = req.body?.onlyIfMissing ?? [];
    if (!Array.isArray(onlyIfMissing) || onlyIfMissing.length > 30 || !onlyIfMissing.every(key => typeof key === 'string' && Object.hasOwn(patch || {}, key))) return res.status(400).json({ error: { code: 'invalid_ui_preferences' } });
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length > 30 || !Object.entries(patch).every(([key, value]) => validUiPreference(key, value))) {
      return res.status(400).json({ error: { code: 'invalid_ui_preferences', message: 'Некорректные настройки отображения.' } });
    }
    // Read and merge inside the same transaction. Two devices editing different
    // keys cannot replace one another's snapshot; null is a persisted reset.
    const saved = writeUiPreferences(db, req.user.id, patch, { onlyIfMissing });
    onChanged();
    notifyUser(req.user.id, 'ui-preferences', saved);
    res.json(saved);
  });
}
