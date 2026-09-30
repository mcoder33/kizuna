// Модель доски без DOM: наборный фильтр по полям дела, порядок колонок и то,
// какие колонки-группы человек завёл сам. Всё, что здесь, — чистые функции над
// данными, поэтому их проверяют юнит-тесты, а рисует и хранит в браузере
// public/app.js.
//
// Условие фильтра — поле · оператор · значения: {field, op, values}. Значения
// внутри одного условия складываются по «или»: «=» подходит, если у дела есть
// любое из них, «≠» — если нет ни одного («ни одно из»). Между условиями всегда
// «и». Условие без значений — черновик: пока значения не выбраны, оно ничего не
// фильтрует и не считается. Условие с одним полем и одним оператором на доске
// бывает только одно: второе сливается с первым, значения — в одно «или».

export const FILTER_FIELDS = { col: "Колонка", day: "День", who: "Человек", proj: "Проект", src: "Откуда", status: "Статус" };
export const FILTER_STATUSES = [["open", "открыто"], ["done", "сделано"]];
// «Пусто» у человека и проекта: никто (ничто) не назван. Так же зовётся группа
// «Без человека» в сохранённом порядке колонок и в списке заведённых колонок.
export const FILTER_NONE = "__none";
// Колонка «Сделано» в сохранённом порядке колонок.
export const DONE_LANE = "__done";

// Первый заход: работа на сегодня — сегодняшнее и просроченное, как на полках
// «Дня»; одна плашка «День = сегодня или просрочено».
export const defaultFilter = () => [{ field: "day", op: "=", values: ["today", "late"] }];

const cleanValues = (list) => [...new Set(list.filter((value) => typeof value === "string" && value !== ""))];

// Годное условие или null. Старый формат — одно значение {field, op, value} —
// читается как условие из одного значения.
const cleanCondition = (item) => {
  if (!item || typeof item !== "object") return null;
  if (!Object.hasOwn(FILTER_FIELDS, item.field)) return null;
  if (item.op !== "=" && item.op !== "!=") return null;
  const values = cleanValues(Array.isArray(item.values) ? item.values : [item.value]);
  return values.length ? { field: item.field, op: item.op, values } : null;
};

// Условия одного поля и оператора — в одно, по первому появлению; значения
// складываются («=» по «или», «≠» — «ни одно из»: то же, что действовали они по
// отдельности раньше). Возвращает новые объекты: по полю и оператору условие
// находят заново. Черновики сохраняются — человек ещё выбирает значения.
export function mergeConditions(list) {
  const merged = [];
  for (const condition of list) {
    const same = merged.find((item) => item.field === condition.field && item.op === condition.op);
    if (same) same.values = cleanValues([...same.values, ...condition.values]);
    else merged.push({ field: condition.field, op: condition.op, values: cleanValues(condition.values) });
  }
  return merged;
}

// Что лежит в браузере. Ничего нет (первый заход) или лежит мусор — фильтр по
// умолчанию; пустой список — человек сам всё сбросил, и это тоже выбор. Старые
// условия по одному значению сливаются по полю и оператору: два «День =» стали
// одним «День = … или …», как и действовали.
export function readFilter(text) {
  if (text === null || text === undefined) return defaultFilter();
  let list;
  try { list = JSON.parse(text); } catch { return defaultFilter(); }
  if (!Array.isArray(list)) return defaultFilter();
  return mergeConditions(list.map(cleanCondition).filter(Boolean));
}

// Условия, у которых значения выбраны: только они фильтруют и считаются.
export const activeConditions = (list) => list.filter((condition) => condition.values.length > 0);

// Значение в списке выбранных: есть — убрать, нет — добавить в конец (в таком
// порядке плашка и читается: «сегодня или завтра»).
export const toggleValue = (values, value) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);

// Один и тот же набор условий — независимо от порядка условий и значений (для
// кнопки «Сегодня»).
export function sameFilter(left, right) {
  const keys = (list) => activeConditions(mergeConditions(list)).map((condition) => `${condition.field}${condition.op}${[...condition.values].sort().join("\u0000")}`).sort();
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
// Внутри условия — «или» («=») и «ни одно из» («≠»), между условиями — «и».
export function matchesFilter(list, facts) {
  return activeConditions(list).every((condition) => {
    const hit = condition.values.some((value) => has(facts, condition.field, value));
    return condition.op === "!=" ? !hit : hit;
  });
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

// Новая колонка встаёт в конец ряда: в полном порядке — сразу за последней из
// показанных (`visible` — ключи показанных колонок слева направо). Скрытые
// колонки остаются на своих местах.
export function placeLast(order, key, visible) {
  const rest = order.filter((item) => item !== key);
  const last = [...visible].reverse().find((item) => item !== key && rest.includes(item));
  rest.splice(last === undefined ? rest.length : rest.indexOf(last) + 1, 0, key);
  return rest;
}

// ── колонки-группы, которые человек завёл сам ────────────────────────────────
// При группировке по дню, человеку, проекту и источнику на доске стоят только
// непустые группы и те, что человек добавил через «+ Колонка». Добавленные
// лежат по полю первого уровня: { "<поле>": ["<ключ группы>", …] } — ключи те же,
// что у порядка колонок. Пустая добавленная колонка остаётся, пока её не убрали.

export const GROUP_FIELDS = ["day", "who", "proj", "src"];

export function readShown(text) {
  let value;
  try { value = JSON.parse(text ?? "null"); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const shown = {};
  for (const field of GROUP_FIELDS) {
    if (!Array.isArray(value[field])) continue;
    const keys = [...new Set(value[field].filter((key) => typeof key === "string" && key !== ""))];
    if (keys.length) shown[field] = keys;
  }
  return shown;
}
