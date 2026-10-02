import { normalizeTimeZone, resolveTimeZone } from '../public/time-zone.js';
export { normalizeTimeZone };
export function userTimeZone(db, userId, fallback = 'Europe/Samara') {
  const read = name => userId ? db.prepare('SELECT value FROM app_settings WHERE key=?').get(`user:${userId}:${name}`)?.value : null;
  return resolveTimeZone(read('requestedTimeZone') || 'system', read('detectedTimeZone'), fallback);
}
export function captureTimeContext(timeZone, at = new Date()) {
  return { timeZone: normalizeTimeZone(timeZone) || 'Europe/Samara', referenceAt: at.toISOString() };
}
export function validTimeContext(value) {
  return value && normalizeTimeZone(value.timeZone) && typeof value.referenceAt === 'string' && Number.isFinite(Date.parse(value.referenceAt));
}
