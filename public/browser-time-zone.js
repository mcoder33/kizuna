import { normalizeTimeZone, resolveTimeZone } from './time-zone.js';
const browser = typeof window !== 'undefined';
export function getDetectedTimeZone(fallback = null) {
  if (browser) {
    const native = normalizeTimeZone(window.KizunaSystemTimeZone);
    if (native) return native;
    try { return normalizeTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone) || normalizeTimeZone(fallback); } catch {}
  }
  return normalizeTimeZone(fallback);
}
let requestedTimeZone = 'system';
let detectedTimeZone = getDetectedTimeZone();
let fallbackTimeZone = 'Europe/Samara';
let effectiveTimeZone = resolveTimeZone(requestedTimeZone, detectedTimeZone, fallbackTimeZone);
export const getTimeZone = () => effectiveTimeZone;
export const getRequestedTimeZone = () => requestedTimeZone;
function publishTimeZone(next) {
  const changed = next !== effectiveTimeZone;
  effectiveTimeZone = next;
  if (browser && changed) window.dispatchEvent(new CustomEvent('pagent:timezonechange', { detail: timeZoneDetail() }));
}
export function timeZoneDetail() { return { timeZone: effectiveTimeZone, requestedTimeZone, detectedTimeZone }; }
export function initTimeZone(payload, pendingChoice = null) {
  const settings = payload?.settings || {};
  requestedTimeZone = pendingChoice ?? (settings.requestedTimeZone === 'system' ? 'system' : normalizeTimeZone(settings.requestedTimeZone) || 'system');
  detectedTimeZone = normalizeTimeZone(settings.detectedTimeZone);
  fallbackTimeZone = normalizeTimeZone(settings.timeZone) || fallbackTimeZone;
  publishTimeZone(pendingChoice === null && normalizeTimeZone(payload?.timeZone) || resolveTimeZone(requestedTimeZone, detectedTimeZone, fallbackTimeZone));
}
export function setTimeZone(choice) {
  requestedTimeZone = choice === 'system' ? 'system' : normalizeTimeZone(choice) || 'system';
  detectedTimeZone = getDetectedTimeZone(detectedTimeZone);
  publishTimeZone(resolveTimeZone(requestedTimeZone, detectedTimeZone, fallbackTimeZone));
}
export function announceTimeZoneSaved() {
  if (browser) window.dispatchEvent(new CustomEvent('pagent:timezonesaved', { detail: timeZoneDetail() }));
}
