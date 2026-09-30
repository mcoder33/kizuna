// Модель доски без DOM: наборный фильтр по полям дела и порядок колонок. Всё,
// что здесь, — чистые функции над данными, поэтому их проверяют юнит-тесты, а
// рисует и хранит в браузере public/app.js.
//
// Условие фильтра — поле · оператор · значение: {field, op, value}. «=» на одном
// поле складываются по «или» (подходит любое из значений), разные поля — по «и»,
// «≠» — всегда по «и». Условие без значения — черновик: пока значение не выбрано,
// оно ничего не фильтрует и не считается.

export const FILTER_FIELDS = { col: "Колонка", day: "День", who: "Человек", proj: "Проект", src: "Откуда", status: "Статус" };
export const FILTER_STATUSES = [["open", "открыто"], ["done", "сделано"]];
// «Пусто» у человека и проекта: никто (ничто) не назван. Так же зовётся группа
// «Без человека» в сохранённом порядке колонок.
export const FILTER_NONE = "__none";
// Колонка «Сделано» в сохранённом порядке колонок.
export const DONE_LANE = "__done";

// Первый заход: работа на сегодня — сегодняшнее и просроченное, как на полках «Дня».
export const defaultFilter = () => [
  { field: "day", op: "=", value: "today" },
  { field: "day", op: "=", value: "late" },
];

// Условия одного поля стоят рядом — так видно, какие из них складываются по
// «или». Порядок полей — по первому появлению, внутри поля — как набрали.
// Возвращает те же объекты: по ним интерфейс находит условие, которое двигали.
export function tidyFilter(list) {
  const order = [];
  for (const condition of list) if (!order.includes(condition.field)) order.push(condition.field);
  return order.flatMap((field) => list.filter((condition) => condition.field === field));
}

const cleanCondition = (item) => {
  if (!item || typeof item !== "object") return null;
  if (!Object.hasOwn(FILTER_FIELDS, item.field)) return null;
  if (item.op !== "=" && item.op !== "!=") return null;
  if (typeof item.value !== "string" || item.value === "") return null;
  return { field: item.field, op: item.op, value: item.value };
};

// Что лежит в браузере. Ничего нет (первый заход) или лежит мусор — фильтр по
// умолчанию; пустой список — человек сам всё сбросил, и это тоже выбор.
export function readFilter(text) {
  if (text === null || text === undefined) return defaultFilter();
  let list;
  try { list = JSON.parse(text); } catch { return defaultFilter(); }
  if (!Array.isArray(list)) return defaultFilter();
  return tidyFilter(list.map(cleanCondition).filter(Boolean));
}

// Условия, у которых значение выбрано: только они фильтруют и считаются.
export const activeConditions = (list) => list.filter((condition) => condition.value !== "");

// Один и тот же набор условий — независимо от порядка (для кнопки «Сегодня»).
export function sameFilter(left, right) {
  const keys = (list) => activeConditions(list).map((condition) => `${condition.field}${condition.op}${condition.value}`).sort();
  const a = keys(left), b = keys(right);
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

// Есть ли у дела значение: у человека и проекта их может быть несколько,
// «пусто» — когда не назван никто.
function has(facts, field, value) {
  const own = facts[field];
  if (field === "who" || field === "proj") return value === FILTER_NONE ? !own?.length : Boolean(own?.includes(value));
  return own === value;
}

// facts — {col, day, who: [], proj: [], src, status}: что фильтр знает о деле.
export function matchesFilter(list, facts) {
  const anyOf = new Map();
  for (const condition of activeConditions(list)) {
    const hit = has(facts, condition.field, condition.value);
    if (condition.op === "!=") { if (hit) return false; continue; }
    anyOf.set(condition.field, anyOf.get(condition.field) || hit);
  }
  return [...anyOf.values()].every(Boolean);
}

// Закрытое дело пройдёт по статусу? Если нет — колонка «Сделано» не нужна
// вовсе: «Статус = открыто» прячет её, а не оставляет пустой.
export const statusAllowsDone = (list) => matchesFilter(list.filter((condition) => condition.field === "status"), { status: "done" });

// ── порядок колонок ──────────────────────────────────────────────────────────
// Хранится по полю первого уровня: { "<поле>": ["__done", "<ключ группы>", …] }.

export function readOrder(text) {
  let value;
  try { value = JSON.parse(text ?? "null"); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const order = {};
  for (const [field, keys] of Object.entries(value)) if (Array.isArray(keys)) order[field] = keys.filter((key) => typeof key === "string");
  return order;
}

// Ключи колонок в порядке показа: сначала известные сохранённому порядку — как
// сохранено, затем остальные (новый человек, новая колонка) — в естественном.
export function orderKeys(saved, keys) {
  const rank = new Map();
  (Array.isArray(saved) ? saved : []).forEach((key, index) => { if (!rank.has(key)) rank.set(key, index); });
  const known = keys.filter((key) => rank.has(key)).sort((left, right) => rank.get(left) - rank.get(right));
  return [...known, ...keys.filter((key) => !rank.has(key))];
}

// Колонку `key` бросили на колонку `target`: перед ней или после.
export function moveKey(order, key, target, after) {
  const rest = order.filter((item) => item !== key);
  const at = rest.indexOf(target);
  if (at < 0 || key === target) return order.slice();
  rest.splice(after ? at + 1 : at, 0, key);
  return rest;
}
