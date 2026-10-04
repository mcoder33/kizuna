// Only view choices belong here. Capture jobs, drafts and provider credentials
// remain device-local and must never be copied into an account preference.
const choice = (...values) => value => values.includes(value);
const dimension = (min, max) => value => /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === "string" && item.length <= 500);
const json = check => value => { try { return check(JSON.parse(value)); } catch { return false; } };
const fields = ["col", "day", "who", "proj", "src", "status"];
const columns = json(value => object(value) && Object.entries(value).every(([key, items]) => fields.includes(key) && strings(items)));
const rules = {
  "pagent.theme": choice("system", "light", "dark"),
  "kizuna-appearance": choice("classic", "workshop"),
  "kizuna-room-season": choice("auto", "winter", "spring", "summer", "autumn"),
  "kizuna-room-light": choice("auto", "day", "night"),
  "kizuna-torii-hints": choice("enabled", "disabled"),
  "kizuna-torii-dismissed": json(value => Array.isArray(value) && value.length <= 32 && new Set(value).size === value.length && value.every(id => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id))),
  "pagent.text": json(value => object(value) && ["default", "serif", "mono"].includes(value.font) && ["normal", "small"].includes(value.size)),
  "kizuna-capture-width": dimension(480, 4096),
  "kizuna-capture-height": dimension(96, 480),
  "kizuna-drawers-width": dimension(560, 4096),
  "kizuna-card-mode": choice("center", "side", "full"),
  "kizuna-card-size": json(value => object(value) && Object.entries(value).every(([key, size]) => ["w", "h", "sw"].includes(key) && (size === null || (Number.isInteger(size) && size >= { w: 560, h: 360, sw: 420 }[key] && size <= 4096)))),
  "kizuna-card-talk-height": dimension(44, 360),
  "kizuna-card-note-share": dimension(10, 90),
  "kizuna-board-view": choice("board", "list", "table"),
  "kizuna-board-groups": json(value => Array.isArray(value) && value.length <= fields.length && value.every(field => fields.includes(field))),
  "kizuna-board-filter": json(value => Array.isArray(value) && value.length <= 12 && value.every(item => object(item) && fields.includes(item.field) && ["=", "!="].includes(item.op) && strings(Array.isArray(item.values) ? item.values : [item.value]))),
  "kizuna-board-order": columns,
  "kizuna-board-shown": columns,
  "kizuna-board-subtasks": choice("show", "hide"),
  "kizuna-calendar-mode": choice("day", "week", "month"),
  "kizuna-calendar-height": dimension(240, 4096),
  "kizuna-calendar-hidden": json(strings),
  "kizuna-notes-expanded": json(strings),
  "kizuna-notes-collapsed": json(strings),
  "pagent.circles-table": choice("true", "false"),
};
export const UI_PREFERENCE_KEYS = Object.freeze(Object.keys(rules));
export const isUiPreference = key => Object.hasOwn(rules, key);
export const validUiPreference = (key, value) => isUiPreference(key) && (value === null || (typeof value === "string" && value.length <= 16000 && rules[key](value)));
