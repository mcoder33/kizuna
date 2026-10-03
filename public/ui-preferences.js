import { UI_PREFERENCE_KEYS, isUiPreference, validUiPreference } from "./ui-preference-schema.js";

// The authenticated HTML carries the snapshot so dependent modules (including
// notes.js) read account preferences before creating their cached UI state.
const accountId = document.documentElement.dataset.accountId;
const cacheKey = accountId ? `kizuna-ui-preferences:${accountId}` : null;
let revision = -1;
let values = {};
let serverValues = {};
let pending = {};
let pendingTokens = {};
let migratedKeys = new Set();
let saving = false;
let timer = 0;
let stopped = false;
let started = false;
const clean = source => Object.fromEntries(Object.entries(source || {}).filter(([key, value]) => validUiPreference(key, value)));
const pendingKey = key => `${cacheKey}:${key}`;
function readPendingEntry(key) {
  const entry = JSON.parse(localStorage.getItem(pendingKey(key)) || "null");
  return entry && typeof entry.token === "string" && validUiPreference(key, entry.value) ? entry : null;
}
function rememberEntry(key, entry) {
  if (!entry) { delete pending[key]; delete pendingTokens[key]; migratedKeys.delete(key); return; }
  pending[key] = entry.value;
  pendingTokens[key] = entry.token;
  if (entry.migrated) migratedKeys.add(key); else migratedKeys.delete(key);
}
function queue(key, value, migrated = false) {
  const entry = { value, token: crypto.randomUUID(), migrated };
  rememberEntry(key, entry);
  // One durable record per key: independent tabs cannot replace one another's
  // offline queues. The token prevents an older acknowledgement clearing a
  // newer edit of the same key (including an edit to the same value).
  try { localStorage.setItem(pendingKey(key), JSON.stringify(entry)); } catch {}
}
try {
  const initial = JSON.parse(decodeURIComponent(document.documentElement.dataset.uiPreferences || ""));
  if (initial.userId === accountId) { serverValues = clean(initial.values); values = serverValues; revision = initial.revision; }
} catch {}
if (cacheKey) for (const key of UI_PREFERENCE_KEYS) {
  try { rememberEntry(key, readPendingEntry(key)); } catch {}
}
// Claim only anonymous display choices once. Notes, people, filters and other
// identifiers are excluded from this one-time legacy migration.
try {
  const ownerKey = "kizuna-ui-preferences-legacy-owner";
  if (accountId && !localStorage.getItem(ownerKey)) {
    localStorage.setItem(ownerKey, accountId);
    const legacyKeys = ["pagent.theme", "pagent.text", "kizuna-capture-width", "kizuna-capture-height", "kizuna-drawers-width", "kizuna-card-mode", "kizuna-card-size", "kizuna-card-talk-height", "kizuna-board-view", "kizuna-board-groups", "kizuna-board-subtasks", "kizuna-calendar-mode", "kizuna-calendar-height", "pagent.circles-table"];
    for (const key of legacyKeys) {
      const value = localStorage.getItem(key);
      if (value !== null && !Object.hasOwn(values, key) && !Object.hasOwn(pending, key) && validUiPreference(key, value)) queue(key, value, true);
    }
  }
} catch {}
values = { ...values, ...pending };

function schedule(delay = 250) {
  clearTimeout(timer);
  if (!stopped && accountId) timer = setTimeout(flushUiPreferences, delay);
}
export const uiStorage = {
  getItem(key) { return isUiPreference(key) ? values[key] ?? null : localStorage.getItem(key); },
  setItem(key, value) {
    if (!isUiPreference(key)) { localStorage.setItem(key, value); return; }
    value = String(value);
    if (!validUiPreference(key, value) || values[key] === value || !accountId) return;
    values[key] = value;
    queue(key, value);
    schedule();
  },
  removeItem(key) {
    if (!isUiPreference(key)) { localStorage.removeItem(key); return; }
    if (!accountId || values[key] === null) return;
    values[key] = null;
    queue(key, null);
    schedule();
  },
};

export function receiveUiPreferences(record) {
  if (record?.userId !== accountId || !Number.isInteger(record.revision)) return;
  if (record.revision >= revision) { revision = record.revision; serverValues = clean(record.values); }
  // A newer SSE snapshot may arrive before an older PATCH response. After an
  // acknowledgement removes pending edits, reveal that latest snapshot.
  const next = { ...serverValues, ...pending };
  const keys = UI_PREFERENCE_KEYS.filter(key => (values[key] ?? null) !== (next[key] ?? null));
  values = next;
  if (keys.length) window.dispatchEvent(new CustomEvent("kizuna-ui-preferences", { detail: { keys } }));
}
async function fetchPreferences(options) {
  const response = await fetch("/api/ui-preferences", { cache: "no-store", ...options, signal: AbortSignal.timeout(8000) });
  if ([401, 409].includes(response.status)) { stopped = true; throw new Error("Session expired"); }
  if (!response.ok) throw new Error("Preferences unavailable");
  const record = await response.json();
  // A tab left open while someone switches account must never replay the old
  // account's pending preferences into the new session.
  if (record.userId !== accountId) { stopped = true; throw new Error("Account changed"); }
  return record;
}
export async function refreshUiPreferences() {
  if (stopped || !accountId) return;
  try { receiveUiPreferences(await fetchPreferences()); } catch {}
  if (Object.keys(pending).length) schedule();
}
export async function flushUiPreferences() {
  timer = 0;
  if (saving || stopped || !accountId || !Object.keys(pending).length) return;
  saving = true;
  const sent = { ...pending };
  const sentTokens = { ...pendingTokens };
  try {
    // Bind writes to the HTML's account even if another tab changes the cookie.
    const record = await fetchPreferences({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: accountId, changes: sent, onlyIfMissing: Object.keys(sent).filter(key => migratedKeys.has(key)) }) });
    for (const key of Object.keys(sent)) {
      try {
        const current = readPendingEntry(key);
        if (current?.token === sentTokens[key]) localStorage.removeItem(pendingKey(key));
        else if (current) { rememberEntry(key, current); continue; }
      } catch {}
      if (pendingTokens[key] === sentTokens[key]) rememberEntry(key, null);
    }
    receiveUiPreferences(record);
  } catch {
    schedule(5000);
  } finally {
    saving = false;
    if (!timer && Object.keys(pending).length) schedule();
  }
}
export function startUiPreferenceSync() {
  if (started) return;
  started = true;
  window.addEventListener("storage", event => {
    if (!event.key?.startsWith(`${cacheKey}:`)) return;
    const key = event.key.slice(cacheKey.length + 1);
    if (!isUiPreference(key)) return;
    try {
      const entry = readPendingEntry(key);
      rememberEntry(key, entry);
      if (entry && (values[key] ?? null) !== entry.value) {
        values[key] = entry.value;
        window.dispatchEvent(new CustomEvent("kizuna-ui-preferences", { detail: { keys: [key] } }));
      }
      refreshUiPreferences();
    } catch {}
  });
  window.addEventListener("online", refreshUiPreferences);
  window.addEventListener("focus", refreshUiPreferences);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshUiPreferences(); });
  setInterval(() => { if (!document.hidden) refreshUiPreferences(); }, 30000);
  refreshUiPreferences();
}
window.pagentPreferenceStorage = uiStorage;
window.pagentTheme?.refresh?.();
window.pagentText?.refresh?.();
