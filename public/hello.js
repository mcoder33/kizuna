import { t } from "./browser-i18n.js";
// Гостевая главная: ролик «как это работает» в копии «Сегодня». Он идёт сам,
// как видео: фраза печатается, запись раскладывается на встречу завтра и дело
// на сегодня, дело закрывается кружком и уходит во вкладку «Закрыто», а число
// на «Сделано» в доке растёт. Всё происходит в копии: ни сети, ни личных данных.
//
// Копия устроена по правилам настоящего «Дня»: дело со сроком сегодня лежит на
// полке «на сегодня», встреча завтра — в «по часам» завтрашнего дня, закрытое
// уходит из «Дня» в «Сделано». Первый кадр лежит в разметке hello.html.
//
// Часы ролика стоят на паузе, в фоновой вкладке и пока копия за краем экрана:
// человек, долистав до неё, видит ролик с того места, где он остановился.
import { longDate, shortDate, plural, DEALS, MEETINGS } from "./today-cover.js";

const demoPhrase = () => t("Завтра в 11 созвон с Аней, а смету отправить сегодня");
const demoPlaceholder = () => t("Запишите и отпустите");
const DOCK = [
  ["done", '<circle cx="12" cy="12" r="9"/><path d="M7.9 12.4l2.9 2.9 5.4-5.8"/>'],
  ["today", '<circle cx="12" cy="12" r="3.7"/><path d="M12 3.4v2M12 18.6v2M3.4 12h2M18.6 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4"/>'],
  ["board", '<rect x="3.6" y="4.5" width="4.8" height="15" rx="1.6"/><rect x="9.6" y="4.5" width="4.8" height="9.2" rx="1.6"/><rect x="15.6" y="4.5" width="4.8" height="11.6" rx="1.6"/>'],
  ["calendar", '<path class="band" d="M3.5 8a3.5 3.5 0 0 1 3.5-3.5h10A3.5 3.5 0 0 1 20.5 8v2h-17z"/><rect x="3.5" y="4.5" width="17" height="16" rx="3.5"/><path d="M3.5 10h17"/>'],
  ["notes", '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v3.5a1.5 1.5 0 0 0 1.5 1.5H19M8.6 13h6.8M8.6 16.6h4.4"/>'],
];
const CURSOR = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 2v16.5l4.4-4.2 2.9 6.6 2.7-1.2-2.9-6.5H16z" fill="#1b1b1b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';

const h = (tag, cls, ...kids) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
};
const motion = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Дата в копии настоящая, как в «Как пользоваться»: пример со вчерашним числом
// выглядел бы забытым макетом.
const isoDay = (shift = 0) => {
  const day = new Date();
  day.setDate(day.getDate() + shift);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const figure = document.getElementById("demo");
const app = document.getElementById("demo-app");
const bar = document.getElementById("demo-progress");
const controls = document.getElementById("demo-controls");
const pauseButton = document.getElementById("demo-pause");
const cursor = h("span", "hello-cursor");
cursor.innerHTML = CURSOR;
cursor.setAttribute("aria-hidden", "true");

// ── состояние копии ──
const start = () => ({
  text: "",
  typing: false,
  view: 0,
  tab: "day",
  toast: null,
  fresh: null,
  closing: null,
  today: [{ id: "parcel", get title() { return t("Забрать посылку"); } }],
  stock: [{ id: "service", get title() { return t("Позвонить в сервис насчёт стиралки"); } }],
  tomorrow: [],
  done: [{ id: "report", get title() { return t("Отправить отчёт за неделю"); } }],
});
let state = start();

function row(item, { done = false } = {}) {
  const line = h("div", `hello-app-row${state.fresh === item.id ? " is-fresh" : ""}${done || state.closing === item.id ? " is-done" : ""}`);
  line.dataset.id = item.id;
  if (item.time) line.append(h("span", "hello-app-time", item.time));
  else line.append(h("span", "hello-app-check"));
  const title = h("span", "hello-app-title", item.title);
  if (item.who) title.append(" ", h("span", "hello-app-chip", item.who));
  line.append(title);
  return line;
}
function shelf(label, items, options) {
  if (!items.length) return [];
  return [h("p", `hello-app-shelf${options?.today ? " is-today" : ""}`, label, options?.aside ? h("span", null, options.aside) : null), h("div", "hello-app-rows", ...items.map((item) => row(item, options)))];
}
function paint() {
  const s = state;
  const shown = isoDay(s.view);
  const text = h("div", `hello-app-text${s.text ? "" : " is-empty"}`, s.text || demoPlaceholder());
  if (s.typing) text.append(h("i", "hello-app-caret"));
  const send = h("span", "hello-app-send", "→");
  const tab = (key, label, count) => {
    const el = h("span", `hello-app-tab${s.tab === key ? " is-on" : ""}`, label, " ", h("b", null, count));
    el.dataset.tab = key;
    return el;
  };
  // Счётчик «Дня» — как в приложении: сегодня считаются дела на сегодня, у
  // другого дня — его встречи и дела.
  const dayCount = s.view ? `${plural(s.tomorrow.length, MEETINGS)} · ${plural(0, DEALS)}` : plural(s.today.length, DEALS);
  const step = (delta) => {
    const target = shortDate(isoDay(s.view + delta));
    const el = h("span", "hello-app-step", ...(delta < 0 ? [h("i", null, "‹"), " ", target] : [target, " ", h("i", null, "›")]));
    el.dataset.step = String(delta);
    return el;
  };
  const current = h("span", "hello-app-current", h("b", null, longDate(shown)), h("span", null, s.view ? t("завтра") : t("сегодня")));
  let list;
  if (s.tab === "journal") list = shelf(t("закрыто сегодня"), s.done, { done: true });
  else if (s.view) list = shelf(t("по часам"), s.tomorrow);
  else list = [...shelf(t("на сегодня · {length}", { length: s.today.length }), s.today, { today: true, get aside() { return t("перенести всё на завтра"); } }), ...shelf(t("без срока · {length}", { length: s.stock.length }), s.stock)];
  const dock = h("div", "hello-app-dock");
  const badges = { done: s.done.length, today: s.today.length };
  for (const [key, icon] of DOCK) {
    const item = h("span", `hello-dock-item${key === "today" ? " is-on" : ""}`);
    item.dataset.k = key;
    const tile = h("span", "hello-dock-tile");
    tile.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${icon}</svg>`;
    item.append(tile);
    if (badges[key]) item.append(h("b", null, String(badges[key])));
    dock.append(item);
  }
  const parts = [
    h("div", "hello-app-capture", text, h("div", "hello-app-foot", h("span", "hello-app-hint", t("⌘+Enter — отправить, Enter — новая строка")), send)),
    h("div", "hello-app-tabs", tab("day", s.view ? t("День {value1}", { value1: shortDate(shown) }) : t("День"), dayCount), tab("journal", t("Закрыто"), String(s.done.length))),
    h("div", "hello-app-nav", step(-1), current, step(1)),
    ...list,
    dock,
  ];
  if (s.toast) parts.push(h("p", "hello-app-toast", s.toast));
  app.replaceChildren(...parts);
}
const progress = (part) => { bar.style.width = `${Math.round(part * 100)}%`; };
// Высота копии — по самому высокому кадру ролика: иначе копия дышала бы от кадра
// к кадру, а вместе с ней прыгал бы заголовок слева. Кадры меряются при запуске
// и когда меняется ширина.
function tallFrames() {
  const sent = { ...start(), today: [{ id: "smeta", get title() { return t("Отправить смету"); } }, ...start().today], tomorrow: [{ id: "meet", get title() { return t("Созвон с Аней"); }, time: "11:00", get who() { return t("Аня"); } }] };
  return [start(), sent, { ...sent, view: 1 }, { ...sent, tab: "journal", done: [sent.today[1], ...sent.done] }];
}
function fit() {
  const current = state;
  app.style.minHeight = "";
  let tallest = 0;
  for (const frame of tallFrames()) {
    state = frame;
    paint();
    tallest = Math.max(tallest, app.offsetHeight);
  }
  state = current;
  paint();
  app.style.minHeight = `${tallest}px`;
}

// ── часы ролика ──
// Номер хода гасит ожидания прошлого круга: «Сначала» не ждёт, пока доиграет
// старый.
const demo = { run: 0, paused: false, seen: true };
const alive = (token) => token === demo.run;
function wait(ms, token) {
  return new Promise((resolve) => {
    let left = ms, last = Date.now();
    const timer = setInterval(() => {
      if (!alive(token)) { clearInterval(timer); return; }
      const now = Date.now();
      if (!demo.paused && demo.seen && !document.hidden) left -= now - last;
      last = now;
      if (left <= 0) { clearInterval(timer); resolve(); }
    }, 50);
  });
}
// Курсор живёт внутри копии, в её координатах; остриё стрелки — в точке (3, 2).
function pointAt(el) {
  const box = figure.getBoundingClientRect(), rect = el.getBoundingClientRect();
  return { x: Math.round(rect.left - box.left + Math.min(rect.width / 2, 40)), y: Math.round(rect.top - box.top + Math.min(rect.height / 2, 18)) };
}
function parkCursor() {
  cursor.style.transitionDuration = "0ms";
  cursor.style.transform = `translate(${Math.round(figure.clientWidth * 0.78)}px, ${Math.round(app.offsetHeight * 0.86)}px)`;
}
async function press(selector, token) {
  const target = app.querySelector(selector);
  if (!target) return;
  const { x, y } = pointAt(target);
  if (motion()) {
    cursor.style.transitionDuration = "700ms";
    cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    await wait(780, token);
    if (!alive(token)) return;
    const ripple = h("span", "hello-ripple");
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    figure.append(ripple);
    setTimeout(() => ripple.remove(), 600);
  }
  target.classList.add("is-pressed");
  await wait(280, token);
  target.classList.remove("is-pressed");
}
// Фраза печатается по букве; при «уменьшении движения» появляется сразу.
async function type(token) {
  state.typing = true;
  let typed = motion() ? 0 : demoPhrase().length - 1;
  while (typed < demoPhrase().length) {
    typed += 1;
    state.text = demoPhrase().slice(0, typed);
    paint();
    await wait(40, token);
    if (!alive(token)) return;
  }
  state.typing = false;
  paint();
}

async function play(token) {
  while (alive(token)) {
    state = start();
    paint();
    progress(0);
    parkCursor();
    await wait(1400, token);
    await press(".hello-app-text", token);
    await type(token);
    if (!alive(token)) return;
    progress(0.2);
    await wait(500, token);
    await press(".hello-app-send", token);
    if (!alive(token)) return;
    state.text = "";
    state.today = [{ id: "smeta", get title() { return t("Отправить смету"); } }, ...state.today];
    state.tomorrow = [{ id: "meet", get title() { return t("Созвон с Аней"); }, time: "11:00", get who() { return t("Аня"); } }];
    state.fresh = "smeta";
    state.toast = t("Записано: встреча завтра в 11:00 и дело на сегодня");
    paint();
    progress(0.38);
    await wait(2800, token);
    await press('[data-step="1"]', token);
    if (!alive(token)) return;
    state.view = 1;
    state.toast = null;
    state.fresh = "meet";
    paint();
    progress(0.56);
    await wait(2600, token);
    await press('[data-step="-1"]', token);
    if (!alive(token)) return;
    state.view = 0;
    state.fresh = null;
    paint();
    progress(0.66);
    await wait(900, token);
    await press('[data-id="parcel"] .hello-app-check', token);
    if (!alive(token)) return;
    state.closing = "parcel";
    paint();
    await wait(700, token);
    if (!alive(token)) return;
    const parcel = state.today.find((item) => item.id === "parcel");
    state.today = state.today.filter((item) => item.id !== "parcel");
    state.done = [parcel, ...state.done];
    state.closing = null;
    state.toast = t("Дело закрыто — оно в «Закрыто»");
    paint();
    progress(0.82);
    await wait(2200, token);
    await press('[data-tab="journal"]', token);
    if (!alive(token)) return;
    state.tab = "journal";
    state.toast = null;
    paint();
    progress(1);
    await wait(3800, token);
  }
}
function restart() {
  demo.run += 1;
  demo.paused = false;
  pauseButton.textContent = t("Пауза");
  pauseButton.setAttribute("aria-pressed", "false");
  play(demo.run);
}

if (figure && app && bar && controls && pauseButton) {
  figure.append(cursor);
  cursor.hidden = !motion();
  controls.hidden = false;
  pauseButton.addEventListener("click", () => {
    demo.paused = !demo.paused;
    pauseButton.textContent = demo.paused ? t("Продолжить") : t("Пауза");
    pauseButton.setAttribute("aria-pressed", String(demo.paused));
  });
  document.getElementById("demo-again").addEventListener("click", restart);
  window.addEventListener("pagent:localechange", () => {
    const wasPaused = demo.paused;
    restart();
    if (wasPaused) pauseButton.click();
    fit();
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => { demo.seen = entry.intersectionRatio >= 0.3; }, { threshold: [0, 0.3] }).observe(figure);
  }
  let width = 0;
  const refit = () => { if (figure.clientWidth !== width) { width = figure.clientWidth; fit(); } };
  if ("ResizeObserver" in window) new ResizeObserver(refit).observe(figure);
  else window.addEventListener("resize", refit);
  refit();
  restart();
}
