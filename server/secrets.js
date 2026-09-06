// Шифрование учётных данных внешних календарей. Пароль приложения Яндекса или
// Apple открывает не только календарь, а почту и диск, а база лежит на диске
// открытым файлом и уходит в резервные копии — хранить такое в открытом виде
// нельзя. Ключ живёт рядом с базой отдельным файлом с правами 600: тот же
// локальный каталог, что и вложения, но в экспорт и очистку он не попадает.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';

export function createSecretBox({ keyPath, key = null } = {}) {
  let material = key;
  function loadKey() {
    if (material) return material;
    if (!keyPath) throw new Error('Secret key path is not configured.');
    try {
      const stored = fs.readFileSync(keyPath);
      if (stored.length === 32) { material = stored; return material; }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    material = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, material, { mode: 0o600 });
    return material;
  }
  return {
    // Строка вида v1.<iv>.<tag>.<шифртекст>, всё в base64url — видно версию
    // схемы, и её можно сменить, не теряя старые записи.
    seal(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGORITHM, loadKey(), iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    open(sealed) {
      if (typeof sealed !== 'string') return null;
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1' || !iv || !tag || !body) return null;
      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, loadKey(), Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
        return JSON.parse(plain.toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}
