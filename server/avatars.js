// Аватар человека: персонаж из набора или своя картинка.
//
// Без аватара человек — буква имени в кружке, и так остаётся по умолчанию.
// Персонажи лежат файлами в public/avatars: их набор общий на всю установку,
// и выбрать можно только из него. Своя картинка хранится в базе отдельной
// таблицей, а в строке человека — только её версия: список людей в круге или
// в разговоре не должен таскать за собой килобайты каждого лица.
//
// Картинку ужимает браузер (квадрат 256 px), сервер лишь проверяет, что это
// действительно картинка нужного формата и разумного размера. Формат берётся
// из самих байтов, а не из заголовка запроса: подписать можно что угодно.

export const AVATAR_PRESETS = [
  { id: 'cat', label: 'Кот' },
  { id: 'fox', label: 'Кицунэ' },
  { id: 'tanuki', label: 'Тануки' },
  { id: 'panda', label: 'Панда' },
  { id: 'penguin', label: 'Пингвин' },
  { id: 'frog', label: 'Лягушка' },
  { id: 'owl', label: 'Сова' },
  { id: 'bunny', label: 'Зайка' },
  { id: 'shiba', label: 'Сиба' },
  { id: 'octopus', label: 'Осьминожка' },
  { id: 'onigiri', label: 'Онигири' },
  { id: 'ghost', label: 'Привидение' },
  { id: 'bear', label: 'Мишка' },
  { id: 'robot', label: 'Робот' },
  { id: 'dino', label: 'Динозаврик' },
  { id: 'whale', label: 'Кит' },
];
export const AVATAR_IMAGE_LIMIT = 300 * 1024;

const presetIds = new Set(AVATAR_PRESETS.map(preset => preset.id));
const presetUrl = id => `/public/avatars/${id}.svg`;

export function avatarPresets() {
  return AVATAR_PRESETS.map(preset => ({ ...preset, url: presetUrl(preset.id) }));
}

// В строке человека: «preset:fox» или «photo:<версия>». Версия попадает в адрес
// картинки, поэтому браузер держит её в кеше, пока человек не сменил лицо.
export function avatarUrl(user) {
  const value = typeof user?.avatar === 'string' ? user.avatar : '';
  if (value.startsWith('preset:') && presetIds.has(value.slice(7))) return presetUrl(value.slice(7));
  if (value.startsWith('photo:') && user.id) return `/api/avatars/${encodeURIComponent(user.id)}?v=${encodeURIComponent(value.slice(6))}`;
  return null;
}

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function choosePreset(db, userId, presetId) {
  if (presetId !== null && !presetIds.has(presetId)) return { error: 'unknown_preset' };
  db.transaction(() => {
    db.prepare('UPDATE users SET avatar=? WHERE id=?').run(presetId ? `preset:${presetId}` : null, userId);
    db.prepare('DELETE FROM user_avatars WHERE user_id=?').run(userId);
  })();
  return { ok: true };
}

export function saveAvatarImage(db, userId, bytes, at = new Date()) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { error: 'empty_image' };
  if (bytes.length > AVATAR_IMAGE_LIMIT) return { error: 'image_too_large' };
  const mime = imageType(bytes);
  if (!mime) return { error: 'not_an_image' };
  const updatedAt = at.toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO user_avatars(user_id, mime, bytes, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes, updated_at=excluded.updated_at`).run(userId, mime, bytes, updatedAt);
    db.prepare('UPDATE users SET avatar=? WHERE id=?').run(`photo:${at.getTime().toString(36)}`, userId);
  })();
  return { ok: true };
}

export function avatarImage(db, userId) {
  const user = db.prepare('SELECT avatar FROM users WHERE id=?').get(userId);
  if (!user?.avatar?.startsWith('photo:')) return null;
  return db.prepare('SELECT mime, bytes FROM user_avatars WHERE user_id=?').get(userId) || null;
}

// Человека удаляют — его лицо уходит вместе с ним: без хозяина картинка
// никому не видна.
export function forgetAvatar(db, userId) {
  db.prepare('DELETE FROM user_avatars WHERE user_id=?').run(userId);
}
