import { SUPPORTED_LOCALES, normalizeLocale, resolveLocale, translate } from './i18n.js';

const browser = typeof window !== 'undefined';
let requestedLocale = 'system';
let activeLocale = 'ru';
let storedDetectedLocale = null;
const bindings = new Map();
let prunePending = false;
const preferredLanguages = () => browser ? [...(navigator.languages || []), navigator.language].filter(Boolean) : [];
// Read-only, curated UI/demo data resolves its strings when consumed, so
// changing locale does not freeze module-level arrays in the first language.
export function localizedBuiltins(value) {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value, { get(target, key, receiver) {
    const item = Reflect.get(target, key, receiver);
    return typeof item === 'string' ? key === 'keys' ? item : t(item) : item && typeof item === 'object' ? localizedBuiltins(item) : item;
  } });
}
export function bindTranslation(element, source, params = {}, attribute = null) {
  if (!element) return element;
  if (typeof params === 'string' && attribute === null) { attribute = params; params = {}; }
  if (!prunePending) {
    prunePending = true;
    queueMicrotask(() => {
      prunePending = false;
      for (const node of bindings.keys()) if (!node.isConnected) bindings.delete(node);
    });
  }
  const key = attribute || 'textContent';
  let entries = bindings.get(element);
  if (!entries) bindings.set(element, entries = new Map());
  if (attribute) element.setAttribute(attribute, t(source, params));
  else element.textContent = t(source, params);
  entries.set(key, { source, params, attribute, textNode: attribute ? null : element.firstChild });
  return element;
}
export const getLocale = () => activeLocale;
export const t = (source, params = {}) => translate(activeLocale, source, params);
export { SUPPORTED_LOCALES };

// Only explicitly annotated application text is translated. Drafts, pages,
// names and other user-authored strings never enter this traversal.
export function applyStaticTranslations(root = browser ? document : null) {
  if (!root) return;
  const elements = [...root.querySelectorAll('[data-i18n], [data-i18n-attrs]')];
  if (root.matches?.('[data-i18n], [data-i18n-attrs]')) elements.unshift(root);
  for (const element of elements) {
    if (element.hasAttribute('data-i18n')) element.textContent = t(element.getAttribute('data-i18n'));
    const attributes = element.getAttribute('data-i18n-attrs');
    if (attributes) for (const [name, source] of Object.entries(JSON.parse(attributes))) element.setAttribute(name, t(source));
  }
  for (const [element, entries] of bindings) {
    if (!element.isConnected) { bindings.delete(element); continue; }
    for (const { source, params, attribute, textNode } of entries.values()) {
      if (attribute) element.setAttribute(attribute, t(source, params));
      else if (textNode?.parentNode === element) textNode.nodeValue = t(source, params);
    }
  }
  document.documentElement.lang = activeLocale;
  const openGraph = document.querySelector('meta[property="og:locale"]');
  if (openGraph) openGraph.content = activeLocale.replace('-', '_');
}

export function setLocale(choice = 'system', { preferred = [...preferredLanguages(), ...(storedDetectedLocale ? [storedDetectedLocale] : [])], notify = true } = {}) {
  requestedLocale = choice === 'system' ? 'system' : normalizeLocale(choice) || 'system';
  const next = resolveLocale(requestedLocale, preferred);
  const changed = next !== activeLocale;
  activeLocale = next;
  if (browser) {
    applyStaticTranslations();
    if (changed && notify) window.dispatchEvent(new CustomEvent('pagent:localechange', { detail: { locale: next, requestedLocale } }));
  }
  return next;
}

export function initLocale(settings = null) {
  if (!browser) return activeLocale;
  // Before account settings arrive, only this browser's languages apply.
  // A previous account's preference must not leak into guests or a new session.
  const choice = settings ? settings.locale || 'system' : 'system';
  const detected = normalizeLocale(settings?.detectedLocale);
  storedDetectedLocale = detected;
  setLocale(choice, { preferred: [...preferredLanguages(), ...(detected ? [detected] : [])] });
  return activeLocale;
}
// Native consumers refetch the authoritative settings only after the write
// completes. This event is also emitted when the preference mode changes
// while the resolved language stays the same.
export function announceLocaleSaved(settings) {
  if (!browser) return;
  const requestedLocale = settings?.locale === 'system' ? 'system' : normalizeLocale(settings?.locale) || 'system';
  window.dispatchEvent(new CustomEvent('pagent:localesaved', { detail: {
    locale: activeLocale,
    requestedLocale,
    detectedLocale: normalizeLocale(settings?.detectedLocale),
  } }));
}
export const getDetectedLocale = (fallback = null) => preferredLanguages().map(normalizeLocale).find(Boolean) || normalizeLocale(fallback);
export const getRequestedLocale = () => requestedLocale;

if (browser) {
  initLocale();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => applyStaticTranslations(), { once: true });
  else applyStaticTranslations();
  window.addEventListener('languagechange', () => { if (requestedLocale === 'system') setLocale('system'); });
}
