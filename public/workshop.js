import { uiStorage } from './ui-preferences.js';
import { getTimeZone } from './browser-time-zone.js';
import { chooseRoom, roomAsset, ROOM_REFRESH_MS } from './workshop-scenes.js';

const root = document.documentElement;
const account = root.dataset.accountId;
const publicDemo = !account && root.dataset.publicAppearance === 'workshop' && document.querySelector('.hello-app');
const compact = matchMedia('(max-width:1100px)');
const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)');
const systemTheme = matchMedia('(prefers-color-scheme:dark)');
let backdrop, composing = false, pointerHeld = false, dragging = false, pending = false, applied = null, revision = 0;
let lastAppearance = root.dataset.appearance || 'classic';
let timer = 0;
const allowed = () => root.dataset.workshopEnabled === 'true';
const preference = (key, fallback) => { try { return uiStorage.getItem(key) || fallback; } catch { return fallback; } };
const selectedAppearance = () => account && allowed() && preference('kizuna-appearance', 'classic') === 'workshop' ? 'workshop' : 'classic';
const active = () => selectedAppearance() === 'workshop' || !!publicDemo;
const busy = () => composing || pointerHeld || dragging || document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') || !!document.querySelector('dialog[open]');
const roomChoice = () => chooseRoom({ timeZone: getTimeZone(), season: account ? preference('kizuna-room-season', 'auto') : 'auto', theme: root.dataset.theme || 'system', systemDark: systemTheme.matches });

function ensureBackdrop() {
  if (publicDemo || backdrop) return;
  backdrop = document.createElement('div');
  backdrop.className = 'workshop-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.prepend(backdrop);
}

async function renderRoom({ force = false } = {}) {
  if (!active()) return;
  const room = roomChoice();
  force ||= !!applied && applied.light !== room.light;
  if (document.hidden || (!force && busy())) { pending = true; return; }
  const src = roomAsset(room, compact.matches);
  if (applied?.src === src) {
    ++revision;
    pending = false;
    delete root.dataset.roomFallback;
    delete root.dataset.roomError;
    return;
  }
  // While decoding a different theme, keep readable neutral materials instead
  // of briefly combining the previous room with the new interface colors.
  if (applied && applied.light !== room.light) root.dataset.roomFallback = 'true';
  pending = false;
  const generation = ++revision;
  const image = new Image();
  image.src = src;
  try { await image.decode(); }
  catch {
    if (generation !== revision || !active()) return;
    root.dataset.roomError = 'true';
    if (!applied || applied.light !== room.light) root.dataset.roomFallback = 'true';
    return;
  }
  if (generation !== revision || !active()) return;
  if (document.hidden || (!force && busy())) { pending = true; return; }
  ensureBackdrop();
  if (backdrop) {
    const layer = document.createElement('div');
    layer.className = 'workshop-scene';
    layer.style.backgroundImage = 'url("' + src + '")';
    const instant = !applied || applied.light !== room.light || reducedMotion.matches;
    if (instant) { layer.style.transition = 'none'; layer.classList.add('shown'); }
    backdrop.append(layer);
    const previous = [...backdrop.children].filter(el => el !== layer);
    if (!instant) requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('shown')));
    setTimeout(() => previous.forEach(el => el.remove()), instant ? 0 : 950);
  }
  root.style.setProperty('--workshop-room-image', 'url("' + src + '")');
  root.dataset.roomSeason = room.season;
  root.dataset.roomLight = room.light;
  delete root.dataset.roomError;
  delete root.dataset.roomFallback;
  applied = { ...room, src };
  window.dispatchEvent(new CustomEvent('kizuna-room-change', { detail: { ...room, timeZone: getTimeZone() } }));
}

function paintSettings() {
  const row = document.querySelector('#workshop-appearance-row');
  if (row) row.hidden = !allowed();
  const controls = document.querySelector('#workshop-settings');
  if (controls) controls.hidden = selectedAppearance() !== 'workshop';
  for (const [id, key, fallback] of [
    ['setting-appearance', 'kizuna-appearance', 'classic'],
    ['setting-room-season', 'kizuna-room-season', 'auto'],
    ['setting-torii-hints', 'kizuna-torii-hints', 'enabled'],
  ]) {
    const field = document.getElementById(id);
    if (field) field.value = id === 'setting-appearance' && !allowed() ? 'classic' : preference(key, fallback);
  }
}

function refresh({ force = false } = {}) {
  const appearance = selectedAppearance();
  root.dataset.appearance = appearance;
  if (appearance !== lastAppearance) {
    lastAppearance = appearance;
    window.dispatchEvent(new CustomEvent('kizuna-appearance-change', { detail: { appearance } }));
  }
  paintSettings();
  if (!active()) {
    ++revision;
    pending = false;
    applied = null;
    backdrop?.remove();
    backdrop = null;
    root.style.removeProperty('--workshop-room-image');
    delete root.dataset.roomLight;
    delete root.dataset.roomSeason;
    delete root.dataset.roomFallback;
    delete root.dataset.roomError;
    return;
  }
  if (!applied) root.dataset.roomFallback = 'true';
  ensureBackdrop();
  renderRoom({ force });
}

function resumePending() {
  clearTimeout(timer);
  if (pending && active()) timer = setTimeout(() => renderRoom(), 0);
}

for (const [id, key] of [
  ['setting-appearance', 'kizuna-appearance'],
  ['setting-room-season', 'kizuna-room-season'],
  ['setting-torii-hints', 'kizuna-torii-hints'],
]) document.getElementById(id)?.addEventListener('change', event => {
  event.stopPropagation();
  if (!allowed()) return;
  uiStorage.setItem(key, event.target.value);
  refresh({ force: true });
  window.dispatchEvent(new CustomEvent('kizuna-appearance-change', { detail: { appearance: selectedAppearance() } }));
});
document.getElementById('torii-restore-hints')?.addEventListener('click', () => {
  uiStorage.removeItem('kizuna-torii-dismissed');
  window.dispatchEvent(new Event('kizuna-torii-reset'));
});
function route() { root.dataset.workshopRoute = location.hash.slice(1).split(/[/?]/)[0] || 'today'; }
window.addEventListener('hashchange', route);
window.addEventListener('kizuna-ui-preferences', () => refresh());
window.addEventListener('kizuna-ui-capabilities', () => refresh());
window.addEventListener('pagent:timezonechange', () => refresh());
window.addEventListener('pagent:resume', () => refresh());
window.addEventListener('focus', () => refresh());
window.addEventListener('blur', () => { pointerHeld = false; composing = false; dragging = false; });
document.addEventListener('visibilitychange', () => refresh());
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', () => { composing = false; resumePending(); });
document.addEventListener('pointerdown', () => { pointerHeld = true; });
document.addEventListener('pointerup', () => { pointerHeld = false; resumePending(); });
document.addEventListener('pointercancel', () => { pointerHeld = false; resumePending(); });
document.addEventListener('dragstart', () => { dragging = true; });
document.addEventListener('dragend', () => { dragging = false; resumePending(); });
document.addEventListener('drop', () => { dragging = false; resumePending(); });
document.addEventListener('focusout', resumePending);
document.addEventListener('close', resumePending, true);
compact.addEventListener('change', () => refresh());
// Theme changes must stay in sync even while a draft or dialog is focused.
new MutationObserver(() => refresh({ force: true })).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
systemTheme.addEventListener('change', () => refresh({ force: true }));
route();
refresh();
setInterval(() => { if (active()) renderRoom(); }, ROOM_REFRESH_MS);
