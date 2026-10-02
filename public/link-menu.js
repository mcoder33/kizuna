import { t, bindTranslation } from "./browser-i18n.js";
// Подсказка страниц после «[[». Внутренняя ссылка работает, только когда
// название совпадает со страницей, а помнить названия наизусть человек не
// обязан: набрал две скобки — увидел страницы, выбрал, ссылка готова. Нет
// нужной — последний пункт заводит её тут же.
//
// Устроена как меню по «/» (slash-menu.js) и выглядит так же, но классы свои:
// проверки и стили меню разметки её не задевают. Живёт в body или в карточке,
// перехватывает стрелки и Enter раньше поля, подсветку ведёт только настоящее
// движение мыши. Страницы берутся из GET /api/pages и помнятся полминуты.

const normalize = (value) => String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

// Подбор идёт, пока каретка стоит после «[[», а до неё нет закрывающих скобок.
// to захватывает хвост уже закрытой ссылки: «[[Рел|из]]» заменяется целиком,
// а не превращается в «[[Релиз 1.4]]из]]».
export function readLinkQuery(line, offset) {
  const head = String(line).slice(0, offset);
  const open = head.lastIndexOf("[[");
  if (open < 0) return null;
  const query = head.slice(open + 2);
  if (/[[\]|#\n]/.test(query) || query.length > 80) return null;
  const tail = String(line).slice(offset).match(/^[^[\]\n]*\]\]/);
  return { from: open, to: offset + (tail ? tail[0].length : 0), query, embed: open > 0 && line[open - 1] === "!" };
}

// Совпадение с начала названия ценнее совпадения с начала слова, а то —
// совпадения в середине. Пустой запрос — недавно изменённые страницы.
export function rankPages(pages, query, limit = 8) {
  const needle = normalize(query).trim();
  const byRecent = (left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  if (!needle) return [...pages].sort(byRecent).slice(0, limit);
  const scored = [];
  for (const page of pages) {
    const title = normalize(page.title);
    const at = title.indexOf(needle);
    if (at < 0) continue;
    const wordStart = at === 0 || /[\s\-—:«"(/]/.test(title[at - 1]);
    scored.push({ page, score: (at === 0 ? 0 : wordStart ? 1 : 2) * 1000 + Math.min(at, 999) });
  }
  scored.sort((left, right) => left.score - right.score || byRecent(left.page, right.page));
  return scored.slice(0, limit).map((entry) => entry.page);
}

// Где страница лежит — подписью справа: одинаковые названия в разных местах
// иначе не различить.
export function placeHint(page) {
  if (page.parentTitle) return page.parentTitle;
  if (page.parentKey?.startsWith?.("project:")) return page.parentKey.slice(8);
  if (page.parentKey === "inbox") return t("Входящие");
  return "";
}

let cache = null;
let cachedAt = 0;
let loading = null;
function loadPages() {
  if (cache && Date.now() - cachedAt < 30000) return Promise.resolve(cache);
  loading ||= fetch("/api/pages", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : { pages: [], bases: [] }))
    .then((data) => { cache = data; cachedAt = Date.now(); return data; })
    .catch(() => ({ pages: [], bases: [] }))
    .finally(() => { loading = null; });
  return loading;
}
// Страницу завели или переименовали — подсказка должна это увидеть сразу.
export function forgetLinkPages() {
  cache = null;
}

export function attachLinkMenu(field, { document: doc = document, exclude = () => null, parentFor = () => "root" } = {}) {
  const root = field.element;
  const menu = doc.createElement("div");
  menu.className = "link-menu";
  menu.setAttribute("role", "listbox");
  bindTranslation(menu, "Страницы", "aria-label");
  menu.hidden = true;
  doc.body.append(menu);
  const mount = () => {
    const host = root.closest("dialog") ?? doc.body;
    if (menu.parentNode !== host) host.append(menu);
  };

  let visible = [];
  let active = 0;
  let anchor = null;
  let creating = false;
  const open = () => !menu.hidden;

  function close() {
    menu.hidden = true;
    menu.replaceChildren();
    visible = [];
    anchor = null;
  }
  function place() {
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const base = rect.width || rect.height ? rect : root.getBoundingClientRect();
    const top = base.bottom + 6;
    const height = menu.offsetHeight || 260;
    menu.style.top = `${top + height > window.innerHeight ? Math.max(8, base.top - height - 6) : top}px`;
    menu.style.left = `${Math.max(8, Math.min(base.left, window.innerWidth - menu.offsetWidth - 12))}px`;
  }
  function setActive(index) {
    active = index;
    [...menu.children].forEach((option, position) => {
      option.classList.toggle("is-active", position === active);
      option.setAttribute("aria-selected", String(position === active));
    });
    menu.children[active]?.scrollIntoView?.({ block: "nearest" });
  }
  function paint() {
    mount();
    menu.replaceChildren();
    visible.forEach((item, index) => {
      const option = doc.createElement("div");
      option.className = `link-option${item.create ? " link-create" : ""}`;
      option.setAttribute("role", "option");
      const title = doc.createElement("span");
      title.className = "link-title";
      title.textContent = item.create ? t("Новая страница «{title}»", { title: item.title }) : item.title;
      const hint = doc.createElement("span");
      hint.className = "link-hint";
      hint.textContent = item.create ? t("создать") : item.hint;
      option.append(title, hint);
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(index);
      });
      menu.append(option);
    });
    menu.hidden = false;
    place();
    setActive(active);
  }

  async function choose(index) {
    const item = visible[index];
    if (!item || !anchor || creating) return;
    let { line, from, to } = anchor;
    const query = anchor.query;
    let title = item.title;
    if (item.create) {
      creating = true;
      try {
        const response = await fetch("/api/pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, parent: parentFor() }) });
        if (!response.ok) { close(); return; }
        title = (await response.json()).page.title;
        forgetLinkPages();
      } finally {
        creating = false;
      }
      // Пока страница заводилась, строку могли поменять: ссылка встаёт, только
      // если набранный подбор всё ещё на своём месте.
      const text = field.lineAt(line);
      if (!text.startsWith(`[[${query}`, from)) { close(); return; }
      const found = readLinkQuery(text, from + 2 + query.length);
      if (!found || found.from !== from) { close(); return; }
      to = found.to;
    }
    const link = `[[${title}]]`;
    field.replaceInLine(line, from, to, link, link.length);
    close();
  }

  let token = 0;
  async function refresh() {
    // Любой новый взгляд на строку отменяет подбор, ещё ждущий страниц: иначе
    // медленный ответ открыл бы меню, которое уже закрыли.
    const mine = ++token;
    const caret = field.caret();
    if (!caret) return close();
    const found = readLinkQuery(field.lineAt(caret.line), caret.offset);
    if (!found) return close();
    const data = await loadPages();
    if (mine !== token) return;
    const skip = exclude();
    const pages = (data.pages || []).filter((page) => page.id !== skip).map((page) => ({ title: page.title, hint: placeHint(page), updatedAt: page.updatedAt }));
    // Встраивание «![[…]]» — это ещё и базы: их вид встаёт в страницу.
    const bases = found.embed ? (data.bases || []).map((base) => ({ title: base.name, get hint() { return t("база"); }, updatedAt: base.updatedAt })) : [];
    const matches = rankPages([...bases, ...pages], found.query);
    const wanted = found.query.trim();
    const exact = wanted && [...bases, ...pages].some((item) => normalize(item.title) === normalize(wanted));
    const items = [...matches, ...(wanted && !exact ? [{ create: true, title: wanted }] : [])];
    if (!items.length) return close();
    const sameQuery = anchor && anchor.line === caret.line && anchor.from === found.from;
    anchor = { line: caret.line, from: found.from, to: found.to, query: found.query };
    visible = items;
    active = sameQuery ? Math.min(active, items.length - 1) : 0;
    paint();
  }

  const onKeyDown = (event) => {
    if (!root.contains(event.target) || !open()) return;
    const keys = {
      ArrowDown: () => setActive((active + 1) % visible.length),
      ArrowUp: () => setActive((active - 1 + visible.length) % visible.length),
      Enter: () => choose(active),
      Tab: () => choose(active),
      Escape: close,
    };
    const handler = keys[event.key];
    if (!handler) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handler();
  };
  doc.addEventListener("keydown", onKeyDown, true);
  let pointer = null;
  const onMouseMove = (event) => {
    const moved = pointer && (pointer.x !== event.clientX || pointer.y !== event.clientY);
    pointer = { x: event.clientX, y: event.clientY };
    if (!moved || !open()) return;
    const index = [...menu.children].indexOf(event.target.closest?.(".link-option"));
    if (index >= 0 && index !== active) setActive(index);
  };
  doc.addEventListener("mousemove", onMouseMove, true);
  const onKeyUp = (event) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) refresh(); };
  const onBlur = () => { if (!creating) close(); };
  root.addEventListener("input", refresh);
  root.addEventListener("keyup", onKeyUp);
  root.addEventListener("blur", onBlur);
  root.addEventListener("mouseup", refresh);
  const onResize = () => { if (open()) place(); };
  window.addEventListener("resize", onResize);

  return {
    element: menu,
    close,
    isOpen: open,
    destroy: () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("mousemove", onMouseMove, true);
      root.removeEventListener("input", refresh);
      root.removeEventListener("keyup", onKeyUp);
      root.removeEventListener("blur", onBlur);
      root.removeEventListener("mouseup", refresh);
      window.removeEventListener("resize", onResize);
      menu.remove();
    },
  };
}
