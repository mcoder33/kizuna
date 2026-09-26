// «Как пользоваться»: вопросы в «?» в шапке и прогон поверх настоящих
// страниц. Ничего не имитируется: пузырь встаёт у живого элемента, фраза
// примера подставляется в настоящее поле, отправка и кружок — настоящие, и
// после прогона запись уже есть в журнале. Шаг ждёт действия человека
// («capture» — новая запись, «click» — нажатие на цель) или кнопки «Дальше»;
// с любого шага можно выйти, в конце — «Выйти из обучения».
//
// Пройденные вопросы помечаются галочкой; это удобство одного браузера,
// поэтому живёт в localStorage и не мешает, если его нет.
import { GUIDE_GROUPS, GUIDES, isHandsOn } from "./guide-data.js";

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
const visible = (el) => Boolean(el) && el.getClientRects().length > 0;
const motion = () => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function readDone() {
  try { const raw = localStorage.getItem(DONE_KEY); const list = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(list) ? list : []); } catch { return new Set(); }
}
function markDone(id) {
  const done = readDone();
  done.add(id);
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...done])); } catch {}
}

/* ── где цель шага ── */
function findTarget(spec, newId) {
  if (!spec) return { el: null, index: 0 };
  if (Array.isArray(spec)) {
    for (let i = 0; i < spec.length; i++) { const el = findTarget(spec[i], newId).el; if (el) return { el, index: i }; }
    return { el: null, index: 0 };
  }
  if (typeof spec === "string") {
    if (spec.startsWith("@new")) {
      if (!newId) return { el: null, index: 0 };
      spec = `[data-capture-id="${newId}"]` + spec.slice(4);
    }
    return { el: [...document.querySelectorAll(spec)].find(visible) || null, index: 0 };
  }
  if (spec.legend) {
    const legend = [...document.querySelectorAll("#settings legend")].find((el) => el.textContent.trim() === spec.legend);
    return { el: legend && visible(legend) ? legend.closest("fieldset") : null, index: 0 };
  }
  if (spec.prop) {
    const row = [...document.querySelectorAll("#review-props .prop")].find((el) => el.querySelector(".prop-label")?.textContent.trim() === spec.prop);
    return { el: visible(row) ? row : null, index: 0 };
  }
  return { el: null, index: 0 };
}
// Ящик на «Сегодня» открывается вкладкой; пока цель не видна, пробуем вкладки
// по очереди — запись могла лечь в «День», «Что делал» или «Заметки».
function openTab(step, attempt) {
  const tabs = [step.tab].flat().filter(Boolean);
  if (!tabs.length) return;
  const tab = document.querySelector(tabs[attempt % tabs.length]);
  if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
}

const isNewTarget = (spec) => typeof spec === "string" && spec.startsWith("@new");

/* ── прогон ── */
function startTour(id, { prefill, openCard, closeCard, onExit, onAnother }) {
  const guide = GUIDES[id];
  const steps = guide.steps;
  let idx = 0, newId = null, current = null, tick = null, waitCapture = null, attempts = 0, scrolled = false;
  const bubble = h("div", "gd-bubble");
  bubble.setAttribute("role", "dialog");
  bubble.setAttribute("aria-label", guide.q);
  const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); finishTour(false); } };
  document.addEventListener("keydown", onKey);
  const onClickTarget = () => setTimeout(next, 0);

  function unbind() {
    clearInterval(tick); tick = null;
    if (waitCapture) document.removeEventListener("kizuna:captured", waitCapture);
    waitCapture = null;
    if (current) { current.classList.remove("gd-spot"); current.removeEventListener("click", onClickTarget, true); }
    current = null;
  }
  function finishTour(toToday, another = false) {
    unbind();
    bubble.remove();
    document.removeEventListener("keydown", onKey);
    if (toToday) { closeCard(); location.hash = "#today"; }
    if (another) onAnother?.(); else onExit?.();
  }
  function next() { if (idx < steps.length - 1) show(idx + 1); }

  function paint(step, index, found) {
    bubble.replaceChildren();
    const head = h("div", "gd-b-head", h("b", null, guide.q), h("span", "gd-b-count", `шаг ${idx + 1} из ${steps.length}`), button("gd-b-x", "×", () => finishTour(false), { "aria-label": "Прервать обучение", title: "Прервать обучение" }));
    const say = Array.isArray(step.say) ? step.say[index] : step.say;
    const text = h("p", "gd-b-say", found || !step.missing ? say : step.missing);
    const acts = h("div", "gd-b-acts");
    if (step.act === "finish") {
      acts.append(button("gd-act primary", "Выйти из обучения", () => { markDone(id); finishTour(true); }));
      acts.append(button("gd-act", "Другой вопрос", () => { markDone(id); finishTour(false, true); }));
    } else {
      if (step.act === "click") acts.append(h("span", "gd-hint", h("i"), found ? "Нажмите подсвеченное" : "Когда будет на что нажать"));
      if (step.act === "capture") acts.append(h("span", "gd-hint", h("i"), "Отправьте запись"));
      acts.append(button("gd-act" + (step.act === "next" ? " primary" : " ghost"), step.act === "next" ? "Дальше" : "Или дальше", next));
      // Строки новой записи не видно (дело на другой день, другой ящик) —
      // запись всё равно есть, её можно открыть прямо отсюда.
      if (!found && newId && isNewTarget(step.target)) acts.prepend(button("gd-act primary", "Открыть запись", () => { openCard(newId); if (step.act === "click") setTimeout(next, 0); }));
      if (idx > 0) acts.append(button("gd-act ghost", "Назад", () => show(idx - 1)));
    }
    bubble.append(head, text, acts);
  }
  function place(target) {
    // Открытое модальное окно (карточка записи) лежит поверх всего: пузырь,
    // оставленный в body, оказался бы под ним и не нажимался бы.
    const dialog = target?.closest("dialog[open]") || [...document.querySelectorAll("dialog[open]")].find((el) => { try { return el.matches(":modal"); } catch { return false; } });
    const host = dialog || document.body;
    if (bubble.parentNode !== host) host.append(bubble);
    if (!target) { bubble.className = "gd-bubble docked"; bubble.style.cssText = ""; return; }
    const rect = target.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    bubble.style.width = width + "px";
    const height = bubble.offsetHeight;
    const below = rect.bottom + 12;
    const fitsBelow = below + height <= window.innerHeight - 8;
    const fitsAbove = rect.top - 12 - height >= 8;
    if (!fitsBelow && !fitsAbove) { bubble.className = "gd-bubble docked"; bubble.style.width = ""; return; }
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    bubble.className = "gd-bubble " + (fitsBelow ? "below" : "above");
    bubble.style.left = left + "px";
    bubble.style.top = (fitsBelow ? below : rect.top - 12 - height) + "px";
    bubble.style.setProperty("--arrow", Math.max(14, Math.min(width - 22, rect.left + Math.min(rect.width / 2, 40) - left)) + "px");
  }
  function bind(step, target) {
    if (current === target) return;
    if (current) { current.classList.remove("gd-spot"); current.removeEventListener("click", onClickTarget, true); }
    current = target;
    if (!target) return;
    target.classList.add("gd-spot");
    if (step.act === "click") target.addEventListener("click", onClickTarget, true);
    if (!scrolled) { scrolled = true; target.scrollIntoView({ block: "center", behavior: motion() ? "smooth" : "auto" }); }
  }
  function show(i) {
    unbind();
    idx = i; attempts = 0; scrolled = false;
    const step = steps[i];
    if (step.closeCard) closeCard();
    const here = location.hash.split("?")[0] || "#today";
    if (step.page && here !== step.page) location.hash = step.page;
    // Пример подставляется после того, как раздел показан: поле живёт на «Сегодня».
    if (step.prefill) setTimeout(() => prefill(step.prefill), 0);
    // Новую запись называет само приложение, когда разбор закончился.
    if (step.act === "capture") {
      waitCapture = (event) => { newId = event.detail?.captureId || null; if (newId) next(); };
      document.addEventListener("kizuna:captured", waitCapture);
    }
    let painted = false;
    const look = () => {
      let { el, index } = findTarget(step.target, newId);
      if (!el && step.tab && attempts < 12) { openTab(step, attempts); ({ el, index } = findTarget(step.target, newId)); }
      attempts++;
      // Цель ищется до трёх секунд: раздел мог ещё рисоваться. Потом пузырь
      // встаёт внизу экрана с текстом «если бы цель была».
      if (!el && attempts < 20 && step.target) return;
      if (!painted || (el && !current) || (!el && current)) { painted = true; paint(step, index, Boolean(el)); }
      bind(step, el);
      place(el);
    };
    look();
    tick = setInterval(look, 150);
  }
  show(0);
  return { exit: () => finishTour(false) };
}

/* ── список вопросов в «?» ── */
export function installGuide({ menu, popover, prefill, openCard, closeCard }) {
  let tour = null;
  const search = h("label", "gd-search", "⌕");
  const input = h("input");
  input.type = "search";
  input.id = "guide-search";
  input.placeholder = "Что вы хотите сделать?";
  input.setAttribute("aria-label", "Поиск по вопросам");
  search.append(input);
  const list = h("div", "gd-list");
  popover.replaceChildren(h("p", "gd-title", "Как пользоваться"), h("p", "gd-sub", "Нажмите вопрос: шаги пойдут прямо по приложению, в вашем журнале."), search, list);
  const paint = () => {
    const done = readDone();
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    for (const group of GUIDE_GROUPS) {
      const items = group.items.filter((id) => !query || (GUIDES[id].q + " " + GUIDES[id].sum).toLowerCase().includes(query));
      if (!items.length) continue;
      list.append(h("p", "gd-group", group.name));
      for (const id of items) {
        const guide = GUIDES[id];
        const row = button("gd-q" + (done.has(id) ? " done" : ""), [h("span", "gd-q-text", h("b", null, guide.q), h("span", null, guide.sum)), h("span", "gd-q-side", done.has(id) ? "✓" : `${guide.steps.length}`, isHandsOn(guide) ? h("i", null) : null)], () => start(id), { "data-guide": id, title: done.has(id) ? "Пройдено" : `${guide.steps.length} шагов${isHandsOn(guide) ? ", руками" : ""}` });
        list.append(row);
      }
    }
    if (!list.childNodes.length) list.append(h("p", "gd-sub", "Такого вопроса пока нет."));
  };
  input.addEventListener("input", paint);
  const open = () => { paint(); menu.open = true; input.focus({ preventScroll: true }); };
  const close = () => { menu.open = false; };
  function start(id) {
    // Следующий раз список открывается целиком, а не с прошлым поиском.
    input.value = "";
    close();
    tour?.exit();
    tour = startTour(id, { prefill, openCard, closeCard, onExit: () => { tour = null; paint(); }, onAnother: () => { tour = null; open(); } });
  }
  menu.addEventListener("toggle", () => { if (menu.open) paint(); });
  document.addEventListener("click", (event) => { if (menu.open && !menu.contains(event.target)) close(); });
  paint();
  return { open, start };
}
