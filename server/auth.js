// Учётные записи, вход и второй фактор. Ни одной внешней зависимости: всё, что
// здесь нужно, — это scrypt, HMAC и сравнение за постоянное время, а они есть в
// node:crypto. Отдельный модуль, потому что криптография должна проверяться
// сама по себе, без поднятого сервера.
import crypto from 'node:crypto';

// ── пароли ──────────────────────────────────────────────────────────────────
// scrypt, а не PBKDF2: он дорог по памяти, поэтому перебор на видеокартах
// невыгоден. Параметры лежат в самой строке хеша — иначе их нельзя было бы
// поднять со временем, не сломав уже сохранённые пароли.
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32, saltLength: 16 };
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export function passwordProblem(password) {
  if (typeof password !== 'string') return 'Пароль должен быть строкой.';
  if (password.length < PASSWORD_MIN_LENGTH) return `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} знаков.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Пароль должен быть не длиннее ${PASSWORD_MAX_LENGTH} знаков.`;
  // Нормализация до сравнения: одна и та же фраза, набранная в разных формах
  // Unicode, иначе давала бы разные хеши и «правильный» пароль не подходил бы.
  if (!password.normalize('NFKC').trim()) return 'Пароль не может состоять из пробелов.';
  return null;
}

export function hashPassword(password, options = {}) {
  const { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = options;
  const salt = crypto.randomBytes(SCRYPT.saltLength);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keyLength, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  try {
    const expected = Buffer.from(hash, 'base64');
    const derived = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
    return crypto.timingSafeEqual(derived, expected);
  } catch { return false; }
}

// ── base32 (RFC 4648) ───────────────────────────────────────────────────────
// Приложения-аутентификаторы принимают секрет только в этом виде, а в
// стандартной библиотеке его нет.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  // Пробелы и регистр человек вводит как придётся: секрет из аутентификатора
  // часто копируют группами по четыре знака.
  const cleaned = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Некорректный секрет.');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────
// Шаг 30 секунд и SHA-1 — не выбор вкуса, а то, что умеют Google Authenticator,
// Aegis, 1Password и остальные. Отойти от этих значений значит остаться без
// совместимости, ради которой второй фактор и берут.
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const TOTP_SECRET_BYTES = 20;

export function generateTotpSecret() { return base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES)); }

export function hotpCode(secretBuffer, counter, digits = TOTP_DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuffer).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret, { at = Date.now(), step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS } = {}) {
  return hotpCode(base32Decode(secret), Math.floor(at / 1000 / step), digits);
}

// Окно ±1 шаг: часы телефона и сервера расходятся на секунды, и без запаса
// человек с правильным кодом получал бы отказ на границе минуты.
export function verifyTotp(secret, code, { at = Date.now(), window = 1, step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS } = {}) {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  let secretBuffer;
  try { secretBuffer = base32Decode(secret); } catch { return false; }
  if (!secretBuffer.length) return false;
  const counter = Math.floor(at / 1000 / step);
  let matched = false;
  // Цикл не прерывается на совпадении: ранний выход выдаёт по времени ответа,
  // на каком шаге код сошёлся.
  for (let shift = -window; shift <= window; shift += 1) {
    const candidate = hotpCode(secretBuffer, counter + shift, digits);
    if (candidate.length === normalized.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) matched = true;
  }
  return matched;
}

export function otpauthUri({ secret, account, issuer = 'Кизуна' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${query}`;
}

// ── резервные коды ──────────────────────────────────────────────────────────
// Телефон теряют, и без запасного пути единственным выходом остаётся админ с
// доступом к базе. Коды показываются один раз и хранятся только хешами.
export const RECOVERY_CODE_COUNT = 8;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(10)).slice(0, 16).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

export function normalizeRecoveryCode(code) { return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
export function hashRecoveryCode(code) { return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex'); }

// ── сессии ──────────────────────────────────────────────────────────────────
// В куке живёт случайный токен, в базе — только его SHA-256. Утечка базы не
// даёт войти ни за кого: восстановить токен из хеша нельзя.
export const SESSION_COOKIE = 'pagent_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function newSessionToken() { return crypto.randomBytes(32).toString('base64url'); }
export function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Разбор Cookie вручную: cookie-parser ради одного заголовка — лишняя
// зависимость в проекте, который держит их наперечёт.
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return part.slice(separator + 1).trim(); }
  }
  return null;
}

// ── почта ───────────────────────────────────────────────────────────────────
// Проверка не пытается быть RFC-полной: она нужна, чтобы адрес нельзя было
// перепутать с чем-то другим и чтобы регистр не плодил двойников.
export function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
export function validEmail(value) {
  const email = normalizeEmail(value);
  return email.length >= 3 && email.length <= 254 && /^[^\s@,;:<>"]+@[^\s@.,;:<>"]+(\.[^\s@.,;:<>"]+)+$/.test(email);
}

// ── защита от перебора ──────────────────────────────────────────────────────
// Счётчик неудач живёт у пользователя в базе, а не в памяти процесса: иначе
// перезапуск сервера обнулял бы блокировку, а перебор — продолжался.
export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_MS = 15 * 60 * 1000;
