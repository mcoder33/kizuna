// Pure helpers shared by browser and server; no browser globals.
export function normalizeTimeZone(input) {
  if (typeof input !== 'string' || !input || input !== input.trim() || /^[+-]/.test(input)) return null;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: input }).resolvedOptions().timeZone; }
  catch { return null; }
}
export function resolveTimeZone(requested = 'system', detected = null, fallback = 'Europe/Samara') {
  return normalizeTimeZone(requested) || normalizeTimeZone(detected) || normalizeTimeZone(fallback) || 'Europe/Samara';
}
