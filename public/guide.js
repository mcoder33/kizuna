// Страница «Как пользоваться»: слева вопросы с поиском, справа прогон в копии
// интерфейса. На телефоне сначала список, потом экран прогона с «‹ Вопросы».
//
// Прогон идёт в копии, а не в самом журнале: шаг делается рукой (нажать поле,
// отправить, закрыть кружком, ответить «Беру» за Аню), но в журнал ничего не
// пишется, пока человек не нажал «Попробовать по-настоящему». Тогда фраза шага
// подставляется в настоящее поле на «Сегодня». В конце прогона можно выйти из
// обучения совсем.
//
// У вопроса свой адрес «#guide?q=assign» — на него можно дать ссылку.
// Пройденные вопросы помечаются галочкой; это удобство одного браузера, поэтому
// живёт в localStorage и не мешает, если его нет.
import { GUIDE_GROUPS, GUIDES, guideLength, demoPause } from "./guide-data.js";
import { longDate, shortDate } from "./today-cover.js";

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
const motion = () => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function readDone() {
  try { const raw = localStorage.getItem(DONE_KEY); const list = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(list) ? list : []); } catch { return new Set(); }
}
function markDone(id) {
  const done = readDone();
  done.add(id);
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...done])); } catch {}
}
// Дата в копии «Сегодня» — настоящая: пример с позавчерашним числом выглядел
// бы забытым макетом.
const isoDay = (shift = 0) => {
  const day = new Date();
  day.setDate(day.getDate() + shift);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

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
  root.append(h("p", "gd-cover-date", `${longDate(isoDay())} · `, h("span", "gd-phase", "день")), h("p", "gd-cover-brief", state.brief));
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
  const expand = button("gd-cap-expand", expandIcon(), null, { "aria-label": "Увеличить поле в примере" });
  const voice = button("gd-cap-voice", waveIcon(), null, { "aria-label": "Поговорить с журналом в примере" });
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
      i = motion() ? i + 1 : full.length;
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
    button("gd-today-tab" + (state.tab === "done" ? " on" : ""), ["Сделано", h("b", null, String(doneCount))]),
    button("gd-today-tab" + (state.tab === "day" ? " on" : ""), ["День", h("b", null, `${dayCount} ${dayCount === 1 ? "дело" : dayCount > 1 && dayCount < 5 ? "дела" : "дел"}`)]),
  );
  root.append(tabs);
  root.append(h("div", "gd-day-head", h("span", null, `‹ ${shortDate(isoDay(-1))}`), h("span", "gd-mid", longDate(isoDay()), h("i", null, "Сегодня")), h("span", "gd-r", `${shortDate(isoDay(1))} ›`)));
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
  root.append(h("div", "gd-card-head", "Сегодня / запись", button("gd-round", "×", null, { "aria-label": "Закрыть карточку в примере" })), h("p", "gd-card-title", state.title));
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

// Цель шага должна быть видна: в низком окне копия ужата и прокручивается
// сама, и подсвеченное может оказаться за её краем.
function ensureVisible(el) {
  const box = el.closest(".gd-stage")?.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (box && (rect.top < box.top || rect.bottom > box.bottom)) el.scrollIntoView({ block: "center", behavior: motion() ? "smooth" : "auto" });
}

/* ── прогон справа ── */
// Два режима. «Пройти самому» — шаг ждёт нажатия человека. «Смотреть демо» —
// прогон идёт сам, как видео: курсор летит к подсвеченному и нажимает, фраза
// печатается, шаги сменяются с паузой на чтение; пауза, «Сначала» и скорость —
// как у видео. Демо тоже идёт в копии: в журнал ничего не пишется.
const CURSOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2v16.5l4.4-4.2 2.9 6.6 2.7-1.2-2.9-6.5H16z" fill="#1b1b1b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
// Значок перед словом — только для глаз: имя кнопки остаётся словом.
const withMark = (mark, text) => { const icon = h("span", "gd-ic-mark", mark); icon.setAttribute("aria-hidden", "true"); return [icon, text]; };

function createPlayer({ onTry, onGo, onExit, onBack, onDone, onMode }) {
  let guide = null, id = null, idx = 0, mode = "hands";
  // Номер хода гасит ожидания прошлого шага; пауза и скорость применяются на лету.
  const demo = { run: 0, paused: false, speed: 1 };
  const back = button("gd-back", "‹ Вопросы", () => onBack());
  const title = h("h3", "gd-p-title");
  title.tabIndex = -1;
  const handsButton = button("", "Пройти самому", () => setMode("hands"));
  const demoButton = button("", withMark("▶", "Смотреть демо"), () => setMode("demo"));
  const modes = h("div", "gd-modes", handsButton, demoButton);
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Как смотреть вопрос");
  const count = h("span", "gd-count");
  const head = h("div", "gd-p-head", back, title, modes, count);
  const bar = h("div", "gd-demo-bar");
  bar.setAttribute("aria-hidden", "true");
  const stage = h("div", "gd-stage");
  const rail = h("div", "gd-rail");
  rail.setAttribute("aria-live", "polite");
  const root = h("div", "gd-player", head, bar, stage, rail);
  const cursor = h("div", "gd-cursor");
  cursor.innerHTML = CURSOR;
  cursor.setAttribute("aria-hidden", "true");

  function setMode(next) {
    mode = next;
    idx = 0;
    demo.paused = false;
    root.classList.remove("paused");
    cursor.classList.remove("on");
    onMode?.(id, mode);
    render();
  }
  const alive = (token) => token === demo.run && root.isConnected;
  // Ожидание по часам демо: на паузе, на скрытой странице и в фоновой вкладке
  // время стоит, а скорость ускоряет его.
  function wait(ms, token, onProgress) {
    return new Promise((resolve) => {
      let left = ms, last = Date.now();
      const timer = setInterval(() => {
        if (!alive(token)) { clearInterval(timer); return; }
        const now = Date.now();
        if (!demo.paused && !document.hidden && !root.closest("[hidden]")) left -= (now - last) * demo.speed;
        last = now;
        if (onProgress && ms > 0) onProgress(Math.min(1, Math.max(0, 1 - left / ms)));
        if (left <= 0) { clearInterval(timer); resolve(); }
      }, 50);
    });
  }
  // Курсор живёт внутри копии, в её координатах: копия прокручивается сама, и
  // курсор едет вместе с ней.
  function pointAt(el) {
    const box = stage.getBoundingClientRect(), rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left - box.left - stage.clientLeft + stage.scrollLeft + Math.min(rect.width / 2, 60)),
      y: Math.round(rect.top - box.top - stage.clientTop + stage.scrollTop + Math.min(rect.height / 2, 24)),
    };
  }
  function parkCursor() {
    cursor.style.transitionDuration = "0ms";
    cursor.style.transform = `translate(${Math.max(0, stage.clientWidth - 90)}px, ${Math.max(0, stage.clientHeight - 70)}px)`;
  }
  function moveCursor(el, token) {
    const { x, y } = pointAt(el);
    const ms = motion() ? Math.round(650 / demo.speed) : 0;
    cursor.style.transitionDuration = `${ms}ms`;
    cursor.classList.add("on");
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    return wait(ms + 80, token);
  }
  async function press(token) {
    cursor.classList.add("press");
    const ripple = h("span", "gd-ripple");
    ripple.style.transform = cursor.style.transform;
    stage.append(ripple);
    await wait(motion() ? 380 : 150, token);
    cursor.classList.remove("press");
    ripple.remove();
  }
  async function runDemo(step, token, typed) {
    await wait(300, token);
    if (!alive(token)) return;
    // Фраза печатается сама — курсор в это время у поля, потом у стрелки.
    if (step.state.typing) {
      const field = stage.querySelector(".gd-cap-text");
      if (field) await moveCursor(field, token);
      await typed;
      if (!alive(token)) return;
    }
    const target = stage.querySelector(step.target);
    if (target) {
      ensureVisible(target);
      await wait(250, token);
      if (!alive(token)) return;
      await moveCursor(target, token);
      if (!alive(token)) return;
    }
    const segment = bar.children[idx];
    await wait(demoPause(step.say), token, (part) => segment?.style.setProperty("--p", part));
    if (!alive(token) || step.act === "finish") return;
    if (step.act === "click" && target) {
      await press(token);
      if (!alive(token)) return;
    }
    next();
  }
  function demoControls() {
    const acts = h("div", "gd-acts");
    const pause = button("gd-act primary", withMark(demo.paused ? "▶" : "❚❚", demo.paused ? "Продолжить" : "Пауза"), () => {
      demo.paused = !demo.paused;
      root.classList.toggle("paused", demo.paused);
      pause.replaceChildren(...withMark(demo.paused ? "▶" : "❚❚", demo.paused ? "Продолжить" : "Пауза"));
    });
    const speed = button("gd-act", `Скорость ${demo.speed}×`, () => {
      demo.speed = demo.speed === 1 ? 2 : 1;
      speed.textContent = `Скорость ${demo.speed}×`;
    });
    acts.append(pause, button("gd-act", withMark("↺", "Сначала"), () => setMode("demo")), speed);
    return acts;
  }
  function exitButtons(first, again) {
    const acts = h("div", "gd-acts");
    if (first) acts.append(first);
    if (again) acts.append(again);
    acts.append(button("gd-act", "К вопросам", () => onBack()));
    acts.append(button("gd-act ghost", "Выйти из обучения", () => onExit()));
    return acts;
  }
  function render() {
    const token = ++demo.run;
    const watching = mode === "demo" && Boolean(guide.steps);
    root.classList.toggle("demo", watching);
    title.textContent = guide.q;
    modes.hidden = !guide.steps;
    handsButton.setAttribute("aria-pressed", String(!watching));
    demoButton.setAttribute("aria-pressed", String(watching));
    count.textContent = guide.steps ? `${watching ? "демо · " : ""}шаг ${idx + 1} из ${guideLength(guide)}` : "";
    bar.hidden = !watching;
    if (watching) bar.replaceChildren(...guide.steps.map((_, i) => h("i", i < idx ? "done" : i === idx ? "on" : "")));
    stage.classList.toggle("plain", Boolean(guide.plain));
    stage.scrollTop = 0;
    if (guide.plain) {
      stage.replaceChildren(h("div", "gd-plain", h("ol", null, ...guide.plain.map((text) => h("li", null, text)))));
      rail.replaceChildren(h("div", "gd-no end", "✓"), h("div", null, h("p", "gd-say", "Шаги по порядку. Кнопка ведёт в нужный раздел приложения, там всё уже по-настоящему."), exitButtons(button("gd-act primary", "Открыть раздел", () => onGo(guide.go || "#today")))));
      onDone(id);
      return;
    }
    const step = guide.steps[idx];
    let armed = false;
    const arm = (target) => {
      if (armed || !target) return;
      armed = true;
      target.classList.add("gd-spot");
      if (step.act === "click" && !watching) target.addEventListener("click", (event) => { event.preventDefault(); next(); }, { once: true });
      ensureVisible(target);
    };
    let typedDone;
    const typed = new Promise((resolve) => { typedDone = resolve; });
    stage.replaceChildren(scene(step.state, { onTyped: (send) => { arm(send); typedDone(); } }));
    if (watching) {
      stage.append(cursor);
      if (!cursor.classList.contains("on")) parkCursor();
    }
    const no = h("div", "gd-no" + (step.act === "finish" ? " end" : ""), step.act === "finish" ? "✓" : String(idx + 1));
    const body = h("div", null, h("p", "gd-say", step.say));
    if (step.act === "finish") {
      const again = watching ? button("gd-act", withMark("↺", "Смотреть ещё раз"), () => setMode("demo")) : null;
      body.append(exitButtons(step.tryText ? button("gd-act primary", "Попробовать по-настоящему", () => onTry(step.tryText)) : null, again));
      onDone(id);
    } else if (watching) {
      body.append(demoControls());
    } else {
      const acts = h("div", "gd-acts");
      if (step.act === "click") acts.append(h("span", "gd-hint", h("i"), "Нажмите подсвеченное"), button("gd-act ghost", "Или дальше", next));
      if (step.act === "next") acts.append(button("gd-act primary", "Дальше", next));
      if (idx > 0) acts.append(button("gd-act ghost", "Назад", () => { idx--; render(); }));
      body.append(acts);
    }
    rail.replaceChildren(no, body);
    // Печатающаяся фраза подсвечивает стрелку только после набора.
    if (!(step.state.typing && step.target === ".gd-cap-send")) arm(stage.querySelector(step.target));
    if (watching) runDemo(step, token, typed);
  }
  function next() { if (guide.steps && idx < guide.steps.length - 1) { idx++; render(); } }
  return {
    el: root,
    play(nextId, { watch = false } = {}) {
      id = nextId;
      guide = GUIDES[nextId];
      idx = 0;
      mode = watch && guide.steps ? "demo" : "hands";
      demo.paused = false;
      root.classList.remove("paused");
      cursor.classList.remove("on");
      render();
    },
    focus() { title.focus({ preventScroll: true }); },
  };
}

/* ── страница: список слева, прогон справа ── */
// Страница занимает окно под шапкой: высота шапки своя у каждой ширины окна,
// поэтому пересчитывается и при смене размера.
let sizedHost = null;
const sizeTop = () => sizedHost?.style.setProperty("--guide-top", `${Math.round(document.querySelector("header")?.getBoundingClientRect().height ?? 72)}px`);
window.addEventListener("resize", sizeTop);

export function mountGuide(host, { initial = null, initialDemo = false, onTry, onGo, onExit } = {}) {
  host.replaceChildren();
  sizedHost = host;
  sizeTop();
  const shell = h("div", "gd-shell");
  const side = h("aside", "gd-side");
  side.setAttribute("aria-label", "Вопросы");
  const search = h("label", "gd-search", h("span", "gd-search-mark", "⌕"));
  const input = h("input");
  input.type = "search";
  input.id = "guide-search";
  input.placeholder = "Что вы хотите сделать?";
  input.setAttribute("aria-label", "Поиск по вопросам");
  search.append(input);
  const list = h("div", "gd-list");
  side.append(h("h2", "gd-side-title", "Как пользоваться"), h("p", "gd-side-sub", "Нажмите вопрос: справа покажется, как это делается, в копии интерфейса. С красной точкой — руками, по шагам."), search, list);
  const main = h("div", "gd-main");
  shell.append(side, main);
  host.append(shell);

  let current = null;
  // Адрес помнит вопрос и режим: ссылку «#guide?q=assign&demo=1» открывают
  // сразу смотрящим демо.
  const setAddress = (id, watching = false) => history.replaceState(null, "", id ? `#guide?q=${id}${watching ? "&demo=1" : ""}` : "#guide");
  const player = createPlayer({
    onTry, onGo, onExit,
    onBack: () => back(),
    onDone: (id) => { markDone(id); paintList(); },
    onMode: (id, mode) => setAddress(id, mode === "demo"),
  });

  function paintList() {
    const done = readDone();
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    for (const group of GUIDE_GROUPS) {
      const items = group.items.filter((id) => !query || (GUIDES[id].q + " " + GUIDES[id].sum).toLowerCase().includes(query));
      if (!items.length) continue;
      list.append(h("p", "gd-group", group.name));
      for (const id of items) {
        const guide = GUIDES[id];
        const mark = done.has(id) ? h("span", "gd-q-side done", "✓") : guide.steps ? h("span", "gd-q-side live") : h("span", "gd-q-side", "шаги");
        const hint = done.has(id) ? "Пройдено" : guide.steps ? `${guide.steps.length} шагов, руками` : `${guide.plain.length} шага списком`;
        const row = button("gd-q" + (id === current ? " on" : "") + (done.has(id) ? " done" : ""), [h("span", "gd-q-text", guide.q), mark], () => pick(id), { "data-guide": id, title: hint });
        if (id === current) row.setAttribute("aria-current", "true");
        list.append(row);
      }
    }
    if (!list.childNodes.length) list.append(h("p", "gd-side-sub", "Такого вопроса пока нет."));
  }
  function empty() {
    main.replaceChildren(h("div", "gd-empty-player",
      h("span", "gd-big", "?"),
      h("b", null, "Выберите вопрос слева"),
      h("span", null, "Вопросы с красной точкой проходятся руками в копии интерфейса: в журнал ничего не запишется, пока вы сами не нажмёте «Попробовать по-настоящему». Остальные показывают шаги по порядку."),
      h("div", "gd-acts gd-empty-acts",
        button("gd-act primary", "Начать с первого: как завести дело", () => pick("todo")),
        button("gd-act", withMark("▶", "Смотреть демо: как поручить дело"), () => pick("assign", { watch: true })))));
  }
  function pick(id, { focus = true, watch = false } = {}) {
    current = id;
    shell.classList.add("playing");
    paintList();
    main.replaceChildren(player.el);
    player.play(id, { watch });
    setAddress(id, watch && Boolean(GUIDES[id].steps));
    main.scrollTop = 0;
    if (focus) player.focus();
  }
  function back() {
    const was = current;
    current = null;
    shell.classList.remove("playing");
    paintList();
    empty();
    setAddress(null);
    const row = was && list.querySelector(`[data-guide="${was}"]`);
    if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" }); }
  }
  input.addEventListener("input", paintList);
  paintList();
  if (initial && GUIDES[initial]) pick(initial, { focus: false, watch: initialDemo });
  else empty();
}
