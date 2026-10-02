import { t, getLocale, getRequestedLocale, setGuestLocale } from './browser-i18n.js';
const languageNames = { ru: 'Русский', en: 'English', es: 'Español', 'pt-BR': 'Português (Brasil)', de: 'Deutsch', fr: 'Français', ja: '日本語' };
const controls = new Set();
export function syncLanguageControls() {
  for (const control of controls) {
    if (!control.label.isConnected) { controls.delete(control); continue; }
    const choice = getRequestedLocale();
    control.select.value = choice;
    control.system.textContent = t('Как на устройстве');
    control.code.textContent = getLocale().toUpperCase();
    control.mode.hidden = choice !== 'system';
    control.mode.textContent = t('Авто');
    control.select.setAttribute('aria-label', t('Язык приложения'));
    control.label.title = `${t('Язык приложения')}: ${choice === 'system' ? t('Как на устройстве') : languageNames[choice]}`;
  }
}
export function mountLanguageControls(onChange = setGuestLocale) {
  for (const host of document.querySelectorAll('[data-language-control]')) {
    if (host.firstElementChild) continue;
    const label = document.createElement('label');
    label.className = 'language-control';
    label.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg><span class="language-code" aria-hidden="true"></span><span class="language-mode" aria-hidden="true"></span>';
    const select = document.createElement('select');
    select.className = 'language-select';
    const system = new Option(t('Как на устройстве'), 'system');
    select.append(system);
    for (const [value, name] of Object.entries(languageNames)) select.append(new Option(name, value));
    select.addEventListener('change', () => { onChange(select.value); syncLanguageControls(); });
    label.append(select);
    host.append(label);
    controls.add({ label, select, system, code: label.querySelector('.language-code'), mode: label.querySelector('.language-mode') });
  }
  syncLanguageControls();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagent:localechange', syncLanguageControls);
  if (document.documentElement.dataset.localeScope === 'guest') mountLanguageControls();
}
