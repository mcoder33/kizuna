import { t, bindTranslation } from "./browser-i18n.js";
import { uiStorage } from "./ui-preferences.js";

const APPEARANCE = "kizuna-appearance";
const HINTS = "kizuna-torii-hints";
const DISMISSED = "kizuna-torii-dismissed";
const EXAMPLE = "Завтра в 11 созвон с Аней по проекту";
const root = document.documentElement;
const pages = ["today", "done", "board", "calendar", "notes", "guide"];
let observer = null;
let observedPage = null;
let queued = false;

const $ = (selector, scope = document) => scope.querySelector(selector);
const hasContent = element => Boolean(element?.textContent?.trim());
const visible = element => Boolean(element && !element.hidden && element.getClientRects().length);
const dismissed = () => {
  try {
    const ids = JSON.parse(uiStorage.getItem(DISMISSED) || "[]");
    return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string") : []);
  } catch { return new Set(); }
};
const enabled = () => Boolean(root.dataset.accountId)
  && root.dataset.appearance === "workshop"
  && uiStorage.getItem(HINTS) !== "disabled";

function remember(id) {
  const ids = dismissed();
  ids.add(id);
  uiStorage.setItem(DISMISSED, JSON.stringify([...ids].sort()));
}

const definitions = {
  today: {
    text: "День ещё свободен. Запишите одну мысль своими словами — дальше Кизуна поможет её разобрать.",
    ready(page) {
      const list = $("#todo", page);
      // The initial HTML contains a placeholder .empty before real data loads.
      if (!visible(list) || !$(".today-start", list)) return null;
      if ($(".entry, .day-group, .day-rows", list) || hasContent($("#capture-input"))) return null;
      return { holder: list, after: $(".today-start", list) };
    },
  },
  done: {
    text: "Здесь появится сделанное. Закройте первое дело кружком, и день начнёт складываться.",
    ready(page) {
      const list = $(".done-days", page);
      // An individually selected day may be empty while other days have work.
      if ($(".done-cell.l1, .done-cell.l2, .done-cell.l3", page)) return null;
      return list && $(".empty", list) && !$(".entry, .day-rows", list) ? { holder: list } : null;
    },
  },
  board: {
    text: "Доска пока свободна. Одно дело можно отправить в нужную колонку.",
    ready(page) {
      if (!$("#board-columns .board-column, #board-flat .board-row")) return null;
      if ($("#board-search")?.value?.trim() || $(".board-cond", page)) return null;
      if ($(".board-card[data-capture-id], .board-row[data-capture-id]", page)) return null;
      return { holder: page, after: $(".page-heading", page) };
    },
  },
  calendar: {
    text: "В этом периоде пока нет событий. Дело со сроком появится здесь само.",
    ready(page) {
      const view = $("#calendar-view", page);
      if (!$(".cal-body", view) || $("#calendar-search")?.value?.trim()) return null;
      if ($('.cal-source[aria-pressed="false"]', page)) return null;
      if ($(".cal-ev, .cal-chip, .cal-all-day", view)) return null;
      return { holder: page, after: $(".page-heading", page) };
    },
  },
  notes: {
    text: "Здесь можно сохранить мысль, к которой захочется вернуться.",
    ready(page) {
      const side = $("#notes-side", page);
      const main = $("#notes-main", page);
      // The side also contains empty messages for bases and search results.
      // Only the actual pages tree proves there are no pages at all.
      const trees = side?.querySelectorAll(":scope > .notes-tree");
      const pagesTree = trees?.[1];
      if (!pagesTree?.querySelector(".notes-empty") || !$(".notes-empty", main)) return null;
      if ($(".notes-count", side) || (trees?.[2]?.children.length ?? 0) > 1) return null;
      if ($(".notes-card, .notes-list-row, .notes-table-row, .notes-sheet[data-page]", main)) return null;
      if ([...side.querySelectorAll("input")].some(input => input.value.trim())) return null;
      return { holder: main };
    },
  },
  guide: {
    text: "Тории подскажет первый шаг. Пример останется черновиком, пока вы сами его не отправите.",
    ready(page) {
      const welcome = $('.gd-empty-player', page);
      return welcome ? { holder: welcome } : null;
    },
  },
};

function fillExample() {
  if (location.hash !== "#today") location.hash = "#today";
  requestAnimationFrame(() => {
    const editor = $("#capture-input[contenteditable='true']");
    if (!editor) return;
    // A draft may have arrived from another action while navigation completed.
    if (hasContent(editor)) { editor.focus(); return; }
    editor.focus();
    if (!document.execCommand?.("insertText", false, t(EXAMPLE))) {
      editor.textContent = t(EXAMPLE);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    $("#capture-form")?.scrollIntoView({ block: "center" });
  });
}

function card(id, description) {
  const element = document.createElement("aside");
  element.className = "torii-help";
  element.dataset.toriiHint = id;
  const art = document.createElement("span");
  art.className = "torii-help-art";
  art.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "torii-help-copy";
  const name = document.createElement("strong");
  name.className = "torii-help-name";
  bindTranslation(name, "Тории рядом");
  const message = document.createElement("p");
  message.className = "torii-help-message";
  bindTranslation(message, description);
  const action = document.createElement("button");
  action.className = "torii-help-action";
  action.type = "button";
  bindTranslation(action, "Подставить пример →");
  action.addEventListener("click", () => { remember(id); removeCard(); fillExample(); });
  const close = document.createElement("button");
  close.className = "torii-help-close";
  close.type = "button";
  close.textContent = "×";
  bindTranslation(close, "Закрыть подсказку Тории", "aria-label");
  close.addEventListener("click", () => {
    remember(id);
    const heading = activePage()?.querySelector("h1, h2");
    removeCard();
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  });
  copy.append(name, message, action);
  element.append(art, copy, close);
  return element;
}

function removeCard() {
  $(".torii-help")?.remove();
  $(".today-start.torii-suppressed")?.classList.remove("torii-suppressed");
}

function activePage() {
  return pages.map(id => document.getElementById(id)).find(page => page && !page.hidden) || null;
}

function watch(page) {
  if (page === observedPage) return;
  observer?.disconnect();
  observedPage = page;
  if (!page) return;
  observer = new MutationObserver(schedule);
  observer.observe(page, { childList: true, subtree: true });
}

function update() {
  queued = false;
  const page = activePage();
  watch(page);
  if (!enabled() || !page || document.querySelector("dialog[open]")) { removeCard(); return; }
  const id = page.id;
  const definition = definitions[id];
  const placement = definition?.ready(page);
  if (!placement || dismissed().has(id)) { removeCard(); return; }
  const existing = $(".torii-help");
  if (existing?.dataset.toriiHint === id && page.contains(existing)) return;
  removeCard();
  const element = card(id, definition.text);
  if (placement.after) placement.after.after(element);
  else if (placement.before) placement.before.before(element);
  else placement.holder.append(element);
  if (id === "today") $(".today-start", page)?.classList.add("torii-suppressed");
}

function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(update);
}

for (const name of ["kizuna-appearance-change", "kizuna-room-change", "pagent-theme", "kizuna-torii-reset", "pagent:localechange"]) {
  window.addEventListener(name, schedule);
}
window.addEventListener("hashchange", () => { schedule(); requestAnimationFrame(schedule); });
window.addEventListener("kizuna-ui-preferences", event => {
  if (event.detail?.keys?.some(key => [APPEARANCE, HINTS, DISMISSED].includes(key))) schedule();
});
document.addEventListener("click", event => {
  if (event.target.closest?.("#today-tabs")) requestAnimationFrame(schedule);
});
document.addEventListener("input", event => {
  if (event.target.closest?.("#capture-input, #board-search, #calendar-search, #notes-search")) schedule();
});
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", schedule, { once: true });
else schedule();
