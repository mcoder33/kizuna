// Страница «Как пользоваться»: карточки-вопросы и прогон во весь экран.
// Прогон идёт в копии интерфейса, а не в самом журнале: шаг делается рукой
// (нажать поле, отправить, закрыть кружком, ответить «Беру» за Аню), но в
// журнал ничего не пишется, пока человек не нажал «Попробовать по-настоящему».
// Тогда фраза шага подставляется в настоящее поле на «Сегодня».
//
// Пройденные вопросы помечаются галочкой; это удобство одного браузера, поэтому
// живёт в localStorage и не мешает, если его нет.
import { GUIDE_GROUPS, GUIDES, guideLength } from "./guide-data.js";

const DONE_KEY = "kizuna.guide.done";
const h = (tag, cls, ...kids) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const button = (cls, label, onClick, attrs = {}) => {
  const b = h("button", cls, ...(Array.isArray(label) ? label : [label]));
  b.type = "button";
  for (const [name, value] of Object.entries(attrs)) b.setAttribute(name, value);
  if (onClick) b.addEventListener("click", onClick);
  return b;
};
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function readDone() {
  try { const raw = localStorage.getItem(DONE_KEY); const list = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(list) ? list : []); } catch { return new Set(); }
}
function markDone(id) {
  const done = readDone();
  done.add(id);
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...done])); } catch {}
}

/* ── иконки ── */
function icon(paths, extra = "") {
  const wrap = h("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${paths}</svg>`;
  return wrap.firstChild;
}
const waveIcon = () => icon('<path d="M3 9.5v5"/><path d="M7.5 7v10"/><path d="M12 4v16"/><path d="M16.5 7v10"/><path d="M21 9.5v5"/>', 'stroke-width="2.2"');
const expandIcon = () => icon('<path d="M9 4.5H6.5a2 2 0 0 0-2 2V9"/><path d="M15 4.5h2.5a2 2 0 0 1 2 2V9"/><path d="M9 19.5H6.5a2 2 0 0 1-2-2V15"/><path d="M15 19.5h2.5a2 2 0 0 0 2-2V15"/>', 'stroke-width="1.6"');
const todoIcon = () => icon('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.5 2.3 2.3L15.5 10"/>');

/* ── сцены: копии интерфейса ── */
function todayScene(state, hooks) {
  const root = h("div", "gd-today");
  root.append(h("p", "gd-cover-date", "Пятница, 26 сентября · ", h("span", "gd-phase", "день")), h("p", "gd-cover-brief", state.brief));
  const cap = h("div", "gd-capture");
  const hasText = Boolean(state.text) || Boolean(state.typing);
  const text = h("div", "gd-cap-text" + (hasText ? "" : " empty"));
  text.tabIndex = 0;
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", "Поле записи в примере");
  text.textContent = state.text || (state.typing ? "" : "Запишите мысль, план, встречу или итог дня");
  const foot = h("div", "gd-cap-foot");
  const dots = h("div", "gd-type-dots");
  for (const [value, label] of [["auto", "Авто"], ["todo", "ТУДУ"], ["outcome", "Результат"], ["note", "Заметка"]]) {
    const dot = button("gd-type-dot" + (value === "auto" ? " on" : ""), [h("span", "gd-mark"), h("span", "gd-label", label)], null, { "aria-label": label });
    dot.style.setProperty("--c", `var(--type-${value})`);
    dot.style.setProperty("--tint", `var(--tint-${value})`);
    dots.append(dot);
  }
  const send = button("gd-cap-send", "→", null, { "aria-label": "Сохранить запись в примере" });
  send.hidden = !state.text;
  const expand = button("gd-cap-expand", expandIcon(), null, { "aria-label": "Увеличить поле" });
  const voice = button("gd-cap-voice", waveIcon(), null, { "aria-label": "Поговорить с журналом" });
  foot.append(dots, h("span", "gd-sep"), h("span", "gd-tags", "#тег…"), expand, voice, send);
  cap.append(text, foot);
  root.append(cap);
  if (state.typing) {
    const caret = h("i", "gd-caret");
    text.append(caret);
    const full = state.typing;
    let i = 0;
    const step = () => {
      if (!text.isConnected) return;
      i = reducedMotion() ? full.length : i + 1;
      text.textContent = full.slice(0, i);
      text.append(caret);
      if (i < full.length) setTimeout(step, 26);
      else { send.hidden = false; hooks?.onTyped?.(send); }
    };
    setTimeout(step, 240);
  }
  const tabs = h("div", "gd-today-tabs");
  const doneCount = state.doneEntries.length, dayCount = state.entries.filter((e) => !e.done).length;
  tabs.append(
    button("gd-today-tab" + (state.tab === "done" ? " on" : ""), ["Что делал", h("b", null, String(doneCount))]),
    button("gd-today-tab" + (state.tab === "day" ? " on" : ""), ["День", h("b", null, `${dayCount} ${dayCount === 1 ? "дело" : dayCount < 5 ? "дела" : "дел"}`)]),
  );
  root.append(tabs);
  root.append(h("div", "gd-day-head", h("span", null, "‹ ЧТ 25"), h("span", "gd-mid", "Пятница, 26 сентября", h("i", null, "Сегодня")), h("span", "gd-r", "СБ 27 ›")));
  const list = h("div", "gd-entries");
  if (state.tab === "day") {
    root.append(h("p", "gd-shelf", "Без времени"));
    for (const entry of state.entries) list.append(entryRow(entry));
  } else {
    root.append(h("p", "gd-shelf", "Сделано сегодня"));
    if (!state.doneEntries.length) list.append(h("p", "gd-cover-brief", "Пока нет зафиксированной работы за сегодня."));
    for (const entry of state.doneEntries) list.append(entryRow(entry));
  }
  root.append(list);
  if (state.toast) root.append(h("div", "gd-toast", state.toast));
  return root;
}
function entryRow(entry) {
  const row = h("div", "gd-entry" + (entry.isNew ? " new" : "") + (entry.done ? " done" : "") + (entry.type === "task" ? "" : " no-check"));
  if (entry.type === "task") row.append(button("gd-check", "", null, { "aria-label": entry.done ? "Вернуть в работу" : "Готово" }));
  row.append(button("gd-title", entry.title));
  const meta = h("div", "gd-meta");
  meta.append(h("span", "gd-tag " + entry.type, { task: "задача", outcome: "результат", note: "заметка", meeting: "встреча" }[entry.type]));
  if (entry.project) meta.append(h("span", "gd-tag project", entry.project));
  if (entry.from) meta.append(h("span", "gd-tag from", entry.from));
  if (entry.assign) meta.append(h("span", "gd-tag assign" + (entry.taken ? " taken" : ""), entry.assign));
  if (entry.when) meta.append(h("span", null, entry.when));
  if (entry.due) meta.append(h("span", "gd-tag due" + (entry.ontime ? " ontime" : ""), "срок: " + entry.due));
  if (entry.undated && !entry.done) meta.append(h("span", "gd-tag", "без срока"));
  if (entry.due && entry.ontime && !entry.done) meta.append(h("span", "gd-tag ontime", "в срок"));
  if (entry.done) meta.append(h("span", "gd-tag done", "готово"));
  row.append(meta);
  return row;
}
function cardScene(state) {
  const root = h("div", "gd-cardv");
  root.append(h("div", "gd-card-head", "Сегодня / запись", button("gd-round", "×", null, { "aria-label": "Закрыть карточку в примере" })), h("h3", "gd-card-title", state.title));
  const props = h("div", "gd-props");
  const typeVal = h("div", "gd-prop-val");
  if (state.choices) {
    for (const [id, word] of [["note", "заметка"], ["task", "задача"], ["meeting", "встреча"], ["outcome", "результат"], ["idea", "идея"]])
      typeVal.append(button(`gd-choice gd-choice-${id}` + (word === state.type ? " on" : ""), word));
  } else typeVal.append(h("span", "gd-select", state.type));
  props.append(h("div", "gd-prop", h("span", "gd-prop-name", "Тип"), typeVal));
  props.append(h("div", "gd-prop", h("span", "gd-prop-name", "Срок"), h("div", "gd-prop-val", state.due ? h("span", "gd-select", state.due) : h("span", "gd-ghost", "без срока"))));
  props.append(h("div", "gd-prop", h("span", "gd-prop-name", "Проект"), h("div", "gd-prop-val", h("span", "gd-select", state.project || "—"))));
  if (state.assignee !== undefined) {
    const val = h("div", "gd-prop-val", h("span", "gd-select", state.assignee || "— никому"));
    if (state.assignWord) val.append(h("span", "gd-origin", "— " + state.assignWord));
    props.append(h("div", "gd-prop gd-prop-assign", h("span", "gd-prop-name", "Исполнитель"), val));
  }
  root.append(props);
  if (state.lesson) root.append(h("p", "gd-lesson", h("span", "gd-mk", "✓"), state.lesson));
  root.append(h("div", "gd-card-src", "Исходная запись: ", h("b", null, `«${state.title}»`), " · сегодня, 12:05. Она хранится как есть, правки живут поверх."));
  return root;
}
function circlesScene(state) {
  const root = h("div", "gd-circles");
  const band = h("div", "gd-kc-band", h("div", "gd-kc-title", h("span", "gd-kc-dot"), "ВойсОпс ", h("span", "gd-kc-sub", "3 за столом")));
  const seats = h("div", "gd-kc-seats");
  for (const person of [{ n: "Саша", sub: "вы", me: true, cls: "me" }, { n: "Аня", sub: "1 открытое дело", cls: "a" }, { n: "Миша", sub: "открытых дел нет", cls: "m" }]) {
    const seat = h("div", "gd-kc-seat", h("span", "gd-ava " + person.cls, person.n[0]), h("span", null, h("span", "gd-kc-name", person.n), h("span", "gd-kc-sub", person.sub)));
    if (!person.me && (state.showTodo || person.n === "Аня")) seat.append(button("gd-kc-todo", todoIcon(), null, { title: "Поручить дело", "aria-label": "Поручить дело: " + person.n }));
    seats.append(seat);
  }
  seats.append(h("div", "gd-kc-seat add", h("span", "gd-ava", "+"), h("span", "gd-kc-name", "Позвать")));
  band.append(seats);
  root.append(band);
  if (state.panel) {
    const panel = h("div", "gd-kc-panel", h("div", "gd-kc-panel-head", h("span", "gd-ava a", "А"), state.panel, h("span", "gd-kc-sub", "в круге ВойсОпс")));
    const input = h("input");
    input.type = "text";
    input.placeholder = "Что поручить";
    input.value = state.deed || "";
    input.setAttribute("aria-label", "Дело для " + state.panel + " в примере");
    panel.append(h("div", "gd-kc-deed", input, button("gd-act primary", "Отдать")), h("p", "gd-kc-hint", "Срок пишется словами внутри: «до пятницы». Разбирает та же модель, что и обычную запись."));
    root.append(panel);
  }
  return root;
}
function annaScene(state) {
  const root = h("div", "gd-anna", h("p", "gd-as-label", h("span", "gd-ava a", "А"), "Так это видит Аня"));
  const bell = h("div", "gd-bell", h("div", "gd-bell-h", "Колокольчик", h("span", "gd-n", "1")));
  const notice = h("div", "gd-notice" + (state.taken ? " taken" : ""), h("span", "gd-ava s", "С"));
  if (!state.taken) {
    notice.append(h("div", null, h("b", null, "Саша"), " просит: «Прислать смету по Хабу»", h("div", "gd-notice-meta", "срок: пятница · круг ВойсОпс")));
    notice.append(h("div", "gd-notice-acts", button("gd-act primary gd-take", "Беру"), button("gd-act", "Не я")));
  } else notice.append(h("div", null, h("b", null, "Взято"), ", дело в вашем дне"));
  bell.append(notice);
  root.append(bell);
  if (state.taken) root.append(h("div", "gd-anna-day", h("p", "gd-shelf", "День Ани · без времени"), h("div", "gd-entries", entryRow({ title: "Прислать смету по Хабу", type: "task", due: "пятница", ontime: true, from: "от Саши", when: "ссылка на запись Саши" }))));
  return root;
}
function scene(state, hooks) {
  if (state.view === "card") return cardScene(state);
  if (state.view === "circles") return circlesScene(state);
  if (state.view === "anna") return annaScene(state);
  return todayScene(state, hooks);
}

/* ── прогон во весь экран ── */
function openStory(id, { onTry, onGo, onExit, onClose }) {
  const guide = GUIDES[id];
  const total = guideLength(guide);
  let idx = 0;
  const previous = document.activeElement;
  const overlay = h("div", "gd-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", guide.q);
  const bar = h("div", "gd-bar");
  const head = h("div", "gd-p-head");
  const stage = h("div", "gd-stage");
  const rail = h("div", "gd-rail");
  const inner = h("div", "gd-player", bar, head, stage, rail);
  overlay.append(inner);
  document.body.append(overlay);
  document.body.classList.add("gd-open");
  const close = () => {
    overlay.remove();
    document.body.classList.remove("gd-open");
    document.removeEventListener("keydown", onKey);
    onClose?.();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey);
  const finish = () => { markDone(id); };
  const toast = (text) => { const t = h("div", "gd-toast", text); stage.append(t); setTimeout(() => t.remove(), 2600); };

  function paintHead() {
    head.replaceChildren();
    const x = button("gd-back", "× Закрыть", close, { "aria-label": "Закрыть прогон" });
    head.append(x, h("h2", null, guide.q), h("span", "gd-count", guide.plain ? "" : `шаг ${idx + 1} из ${total}`));
    bar.replaceChildren();
    for (let i = 0; i < (guide.plain ? 1 : total); i++) bar.append(h("i", i < idx ? "done" : i === idx ? "on" : ""));
  }
  function exitButtons(tryText) {
    const acts = h("div", "gd-acts");
    if (tryText) acts.append(button("gd-act primary", "Попробовать по-настоящему", () => { finish(); close(); onTry?.(tryText); }));
    acts.append(button("gd-act", "Другой вопрос", () => { finish(); close(); }));
    acts.append(button("gd-act ghost", "Выйти из обучения", () => { finish(); close(); onExit?.(); }));
    return acts;
  }
  function render() {
    paintHead();
    if (guide.plain) {
      stage.replaceChildren(h("div", "gd-plain", h("ol", null, ...guide.plain.map((text) => h("li", null, text)))));
      const acts = h("div", "gd-acts");
      acts.append(button("gd-act primary", "Открыть раздел", () => { finish(); close(); onGo?.(guide.go || "#today"); }));
      acts.append(button("gd-act", "Другой вопрос", () => { finish(); close(); }));
      acts.append(button("gd-act ghost", "Выйти из обучения", () => { finish(); close(); onExit?.(); }));
      rail.replaceChildren(h("div", "gd-no end", "✓"), h("div", null, h("p", "gd-say", "Шаги по порядку. Кнопка ниже ведёт в нужный раздел приложения."), acts));
      return;
    }
    const step = guide.steps[idx];
    let armed = false;
    const arm = (target) => {
      if (armed || !target) return;
      armed = true;
      target.classList.add("gd-spot");
      if (step.act === "click") target.addEventListener("click", (event) => { event.preventDefault(); next(); }, { once: true });
    };
    stage.replaceChildren(scene(step.state, { onTyped: (send) => arm(send) }));
    if (!(step.state.typing && step.target === ".gd-cap-send")) arm(stage.querySelector(step.target));
    rail.replaceChildren();
    const no = h("div", "gd-no" + (step.act === "finish" ? " end" : ""), step.act === "finish" ? "✓" : String(idx + 1));
    const body = h("div", null, h("p", "gd-say", step.say));
    const acts = h("div", "gd-acts");
    if (step.act === "click") acts.append(h("span", "gd-hint", h("i"), "Нажмите подсвеченное"), button("gd-act ghost", "Или дальше", next));
    if (step.act === "next") acts.append(button("gd-act primary", "Дальше", next));
    if (idx > 0 && step.act !== "finish") acts.append(button("gd-act ghost", "Назад", () => { idx--; render(); }));
    body.append(step.act === "finish" ? exitButtons(step.tryText) : acts);
    rail.append(no, body);
    overlay.scrollTop = 0;
  }
  function next() { if (idx < total - 1) { idx++; render(); } }
  render();
  head.querySelector(".gd-back")?.focus({ preventScroll: true });
  return { close };
}

/* ── страница с карточками ── */
const KIND_MARK = { write: "✎", people: "@", day: "☼", talk: "♪", memory: "◎" };
export function mountGuide(host, { onTry, onGo, onExit } = {}) {
  host.replaceChildren();
  const done = readDone();
  const heading = h("div", "page-heading gd-heading", h("p", "eyebrow", "КАК ПОЛЬЗОВАТЬСЯ"), h("h2", null, "Как пользоваться"), h("p", null, "Нажмите вопрос: прогон покажет, как это делается, в копии интерфейса и даст попробовать по-настоящему. Пройденные помечаются галочкой."));
  const search = h("label", "gd-search", "⌕");
  const input = h("input");
  input.type = "search";
  input.id = "guide-search";
  input.placeholder = "Что вы хотите сделать?";
  input.setAttribute("aria-label", "Поиск по вопросам");
  search.append(input);
  const tools = h("div", "gd-tools", search, button("gd-act ghost", "Выйти из обучения", () => onExit?.()));
  const body = h("div", "gd-body");
  host.append(heading, tools, body);
  const paint = () => {
    const query = input.value.trim().toLowerCase();
    body.replaceChildren();
    for (const group of GUIDE_GROUPS) {
      const items = group.items.filter((id) => !query || (GUIDES[id].q + " " + GUIDES[id].sum).toLowerCase().includes(query));
      if (!items.length) continue;
      body.append(h("p", "gd-group", group.name));
      const cards = h("div", "gd-cards");
      for (const id of items) {
        const guide = GUIDES[id];
        const kind = h("span", "gd-kind", guide.steps ? h("i") : null, guide.steps ? `${guide.steps.length} шагов, руками` : `${guide.plain.length} шага, списком`);
        const card = button("gd-card" + (done.has(id) ? " done" : ""), [h("span", "gd-ic " + group.id, KIND_MARK[group.id]), h("b", null, guide.q), h("span", null, guide.sum), kind, done.has(id) ? h("span", "gd-done-mark", "✓ пройдено") : null], () => open(id), { "data-guide": id });
        cards.append(card);
      }
      body.append(cards);
    }
    if (!body.childNodes.length) body.append(h("p", "gd-empty", "Такого вопроса пока нет."));
  };
  const open = (id) => openStory(id, { onTry, onGo, onExit, onClose: () => { done.clear(); for (const item of readDone()) done.add(item); paint(); } });
  input.addEventListener("input", paint);
  paint();
  return { open };
}
