import { catalogs } from './i18n-catalog.js';

export const SUPPORTED_LOCALES = Object.freeze(['ru', 'en', 'es', 'pt-BR', 'de', 'fr', 'ja']);
export function normalizeLocale(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().replaceAll('_', '-').toLowerCase();
  const language = value.split('-')[0];
  if (language === 'pt') return 'pt-BR';
  return SUPPORTED_LOCALES.find(locale => locale.toLowerCase() === value)
    || SUPPORTED_LOCALES.find(locale => locale === language) || null;
}
export function resolveLocale(requested = 'system', preferred = []) {
  if (requested !== 'system') { const explicit = normalizeLocale(requested); if (explicit) return explicit; }
  for (const value of Array.isArray(preferred) ? preferred : [preferred]) {
    const locale = normalizeLocale(value); if (locale) return locale;
  }
  return 'ru';
}
export function pluralIndex(locale, count) {
  return new Intl.PluralRules(resolveLocale(locale)).select(Number(count));
}
export function translate(locale, source, params = {}) {
  const resolved = resolveLocale(locale);
  const entry = catalogs[resolved]?.[source] ?? catalogs.ru?.[source] ?? source;
  const phrase = typeof entry === 'string' ? entry : entry?.[pluralIndex(resolved, params.count)] ?? entry?.other ?? source;
  return String(phrase).replace(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name]) : token);
}
export function formatDate(locale, value, options = {}) {
  return new Intl.DateTimeFormat(resolveLocale(locale), options).format(value instanceof Date ? value : new Date(value));
}
