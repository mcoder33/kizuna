import { t, localizedBuiltins } from "./browser-i18n.js";
// Меню разметки по «/». Markdown в поле оформляется на лету, но помнить его
// наизусть человек не обязан: набрал косую черту — увидел, что вообще бывает,
// и выбрал. Отдельный модуль, потому что это не про разбор разметки, а про
// подсказку; поле отдаёт ему только каретку и замену куска строки.

import { CALLOUTS } from "./markdown.js";

// В списке лежит лишь то, что поле правда рисует: предложить блок, который
// останется серым текстом, — хуже, чем не предлагать ничего. Ключевые слова
// нарочно на двух языках: «/h1» и «/заг» должны находить одно и то же.
// Выноски не перечислены руками: пункты собираются из того же словаря, что
// использует рендер, — новый тип сам появится в меню. Синонимы (hint, check,
// faq…) отдельных пунктов не плодят: они складываются в ключи поиска своего
// заголовка, поэтому «/hint» приводит к «Выноска: совет».
const CALLOUT_SYNONYMS = { note: "примечание", warning: "предупреждение", tip: "подсказка", danger: "опасность" };
const CALLOUT_ITEMS = [];
{
  const byTitle = new Map();
  for (const [kind, title] of Object.entries(CALLOUTS)) {
    const known = byTitle.get(title);
    if (known) {
      known.keys += ` ${kind}`;
      continue;
    }
    const item = {
      id: `callout-${kind}`,
      get title() { return t("Выноска: {label}", { label: CALLOUTS[kind].toLowerCase() }); },
      hint: `> [!${kind}]`,
      keys: `callout выноска ${kind} ${title.toLowerCase()} ${CALLOUT_SYNONYMS[kind] ?? ""}`.trimEnd(),
      kind: "prefix",
      value: `> [!${kind}] `,
    };
    byTitle.set(title, item);
    CALLOUT_ITEMS.push(item);
  }
}

export const SLASH_ITEMS = localizedBuiltins([
  { id: "h1", get title() { return "Заголовок 1"; }, hint: "# ", get keys() { return "h1 heading zagolovok заголовок большой"; }, kind: "prefix", value: "# " },
  { id: "h2", get title() { return "Заголовок 2"; }, hint: "## ", get keys() { return "h2 heading подзаголовок заголовок"; }, kind: "prefix", value: "## " },
  { id: "h3", get title() { return "Заголовок 3"; }, hint: "### ", get keys() { return "h3 heading заголовок мелкий"; }, kind: "prefix", value: "### " },
  { id: "h4", get title() { return "Заголовок 4"; }, hint: "#### ", get keys() { return "h4 heading заголовок"; }, kind: "prefix", value: "#### " },
  { id: "h5", get title() { return "Заголовок 5"; }, hint: "##### ", get keys() { return "h5 heading заголовок"; }, kind: "prefix", value: "##### " },
  { id: "h6", get title() { return "Заголовок 6"; }, hint: "###### ", get keys() { return "h6 heading заголовок"; }, kind: "prefix", value: "###### " },
  { id: "bullet", get title() { return "Список"; }, hint: "- ", get keys() { return "list bullet список маркер пункт"; }, kind: "prefix", value: "- " },
  { id: "ordered", get title() { return "Нумерованный список"; }, hint: "1. ", get keys() { return "ordered number нумерованный список цифры"; }, kind: "prefix", value: "1. " },
  { id: "task", get title() { return "Задача"; }, hint: "- [ ] ", get keys() { return "todo task чекбокс задача галочка дело"; }, kind: "prefix", value: "- [ ] " },
  { id: "quote", get title() { return "Цитата"; }, hint: "> ", get keys() { return "quote цитата"; }, kind: "prefix", value: "> " },
  { id: "code", get title() { return "Блок кода"; }, hint: "```", get keys() { return "code блок кода программа"; }, kind: "block", value: "```\n\n```", caret: 4 },
  { id: "divider", get title() { return "Разделитель"; }, hint: "---", get keys() { return "divider hr разделитель черта линия"; }, kind: "block", value: "---" },
  // Ячейки пустые, а не с примером внутри: заготовку с «Что» и «Сколько»
  // пришлось бы сначала стирать, а каретка и так стоит в первой ячейке.
  { id: "table", get title() { return "Таблица"; }, hint: "| … | … |", get keys() { return "table таблица"; }, kind: "block", value: "|  |  |\n| --- | --- |\n|  |  |", caret: 2 },
  { id: "bold", get title() { return "Жирный"; }, get hint() { return "**текст**"; }, get keys() { return "bold жирный полужирный"; }, kind: "wrap", before: "**", after: "**" },
  { id: "italic", get title() { return "Курсив"; }, get hint() { return "*текст*"; }, get keys() { return "italic курсив наклонный"; }, kind: "wrap", before: "*", after: "*" },
  { id: "strike", get title() { return "Зачёркнутый"; }, get hint() { return "~~текст~~"; }, get keys() { return "strike зачёркнутый зачеркнутый"; }, kind: "wrap", before: "~~", after: "~~" },
  { id: "mark", get title() { return "Выделение"; }, get hint() { return "==текст=="; }, get keys() { return "highlight mark выделение маркер"; }, kind: "wrap", before: "==", after: "==" },
  { id: "inline-code", get title() { return "Код в строке"; }, get hint() { return "`код`"; }, get keys() { return "code inline код строка"; }, kind: "wrap", before: "`", after: "`" },
  // Адрес в заготовке настоящий, а не «https://»: поле рисует ссылку только с
  // полным адресом, и с обрубком человек видел бы серый текст вместо ссылки.
  // example.com зарезервирован стандартом и никуда не ведёт.
  { id: "link", get title() { return "Ссылка"; }, get hint() { return "[текст](адрес)"; }, get keys() { return "link ссылка адрес url"; }, kind: "wrap", before: "[", after: "](https://example.com)" },
  { id: "image", get title() { return "Изображение"; }, get hint() { return "![подпись](адрес)"; }, get keys() { return "image picture photo изображение картинка фото"; }, kind: "wrap", before: "![", after: "](https://example.com)" },
  { id: "wikilink", get title() { return "Внутренняя ссылка"; }, get hint() { return "[[запись]]"; }, get keys() { return "wikilink internal вики внутренняя ссылка память"; }, kind: "wrap", before: "[[", after: "]]" },
  { id: "embed", get title() { return "Встраивание записи"; }, get hint() { return "![[запись]]"; }, get keys() { return "embed transclude встраивание вложение записи"; }, kind: "wrap", before: "![[", after: "]]" },
  ...CALLOUT_ITEMS,
  { id: "math", get title() { return "Формула"; }, hint: "$x$", get keys() { return "math formula latex формула математика"; }, kind: "wrap", before: "$", after: "$" },
  { id: "math-block", get title() { return "Формула блоком"; }, hint: "$$x$$", get keys() { return "math formula block формула блоком выключная"; }, kind: "wrap", before: "$$", after: "$$" },
  { id: "comment", get title() { return "Комментарий"; }, get hint() { return "%%текст%%"; }, get keys() { return "comment hidden комментарий скрытый черновик"; }, kind: "wrap", before: "%%", after: "%%" },
  { id: "footnote", get title() { return "Сноска"; }, get hint() { return "^[текст]"; }, get keys() { return "footnote inline сноска примечание"; }, kind: "wrap", before: "^[", after: "]" },
  { id: "footnote-ref", get title() { return "Сноска: ссылка"; }, hint: "[^1]", get keys() { return "footnote ref сноска ссылка номер"; }, kind: "wrap", before: "[^", after: "]" },
  { id: "footnote-def", get title() { return "Сноска: определение"; }, hint: "[^1]:", get keys() { return "footnote definition сноска определение внизу"; }, kind: "prefix", value: "[^1]: " },
  // У тега нет закрывающей пары: after пустой, набранное после решётки и есть тег.
  { id: "tag", get title() { return "Тег"; }, get hint() { return "#тег"; }, get keys() { return "tag hashtag тег метка рубрика"; }, kind: "wrap", before: "#", after: "" },
  // Имя якоря — латиницей: поле рисует только такие, поэтому в заготовке
  // настоящее имя-пример, как адрес у ссылки, а не кириллический обрубок.
  { id: "anchor", get title() { return "Якорь блока"; }, get hint() { return "^имя"; }, get keys() { return "anchor block якорь блока метка ссылка"; }, kind: "block", value: "^anchor" },
]);

const normalize = (value) => String(value).toLowerCase().replace(/ё/g, "е");

export function filterItems(query, items = SLASH_ITEMS) {
  const needle = normalize(query).trim();
  if (!needle) return items;
  // Совпадение в начале слова ценнее совпадения в середине: «/за» должно
  // сначала показать «Заголовок», а не «Зачёркнутый» из-за общей буквы.
  const scored = [];
  for (const item of items) {
    const haystack = normalize(`${item.title} ${item.keys}`);
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    const wordStart = at === 0 || haystack[at - 1] === " ";
    scored.push({ item, score: (wordStart ? 0 : 1) * 100 + at });
  }
  return scored.sort((left, right) => left.score - right.score).map((entry) => entry.item);
}

// Меню открывается не на всякой косой черте: внутри слова (адрес, дробь, дата)
// она значит своё, и подсказка там только мешала бы.
export function readQuery(line, offset) {
  const head = line.slice(0, offset);
  const slash = head.lastIndexOf("/");
  if (slash < 0) return null;
  const before = slash === 0 ? "" : head[slash - 1];
  if (before && !/\s/.test(before)) return null;
  const query = head.slice(slash + 1);
  // Пробел заканчивает подбор: человек уже пишет обычный текст.
  if (/\s/.test(query)) return null;
  return { from: slash, to: offset, query };
}

export function attachSlashMenu(field, { document: doc = document } = {}) {
  const root = field.element;
  const menu = doc.createElement("div");
  menu.className = "slash-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", t("Разметка"));
  menu.hidden = true;
  // Пока меню закрыто, оно лежит в body; перед показом переезжает в модальную
  // карточку, если поле живёт в ней: элемент вне <dialog> рисуется под
  // top-layer'ом диалога — его не видно, а клики до него не доходят. Искать
  // диалог при подключении нельзя: поле заметки собирается до вставки в DOM.
  doc.body.append(menu);
  const mount = () => {
    const host = root.closest("dialog") ?? doc.body;
    if (menu.parentNode !== host) host.append(menu);
  };

  let visible = [];
  let active = 0;
  let anchor = null;

  const open = () => !menu.hidden;

  function close() {
    menu.hidden = true;
    menu.replaceChildren();
    visible = [];
    anchor = null;
    root.removeAttribute("aria-activedescendant");
  }

  function place() {
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    // У схлопнутой каретки в пустой строке ширина и высота нулевые, а иногда и
    // координаты: тогда цепляемся за само поле, иначе меню улетит в угол окна.
    const base = rect.width || rect.height ? rect : root.getBoundingClientRect();
    const top = base.bottom + 6;
    const height = menu.offsetHeight || 260;
    // Не хватает места снизу — открываем вверх: список, уехавший за край окна,
    // бесполезен.
    menu.style.top = `${top + height > window.innerHeight ? Math.max(8, base.top - height - 6) : top}px`;
    menu.style.left = `${Math.min(base.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  }

  // Подсветка отделена от перестройки списка: перерисовывать пункты на каждое
  // движение было бы не только расточительно — replaceChildren пересоздаёт
  // узел прямо под курсором, и нажатие мыши приходится в уже отсоединённый
  // элемент. Список строится один раз на запрос, дальше ходит только подсветка.
  function setActive(index) {
    active = index;
    [...menu.children].forEach((option, position) => {
      option.classList.toggle("is-active", position === active);
      option.setAttribute("aria-selected", String(position === active));
    });
    const current = visible[active];
    if (current) root.setAttribute("aria-activedescendant", `slash-option-${current.id}`);
    // Пунктов больше, чем помещается: выбранный подтягивается в видимую часть,
    // иначе стрелки уводят выделение за край прокрутки.
    menu.children[active]?.scrollIntoView?.({ block: "nearest" });
  }

  function paint() {
    mount();
    menu.replaceChildren();
    visible.forEach((item, index) => {
      const option = doc.createElement("div");
      option.className = "slash-option";
      option.id = `slash-option-${item.id}`;
      option.setAttribute("role", "option");
      const title = doc.createElement("span");
      title.className = "slash-title";
      title.textContent = item.title;
      const hint = doc.createElement("span");
      hint.className = "slash-hint";
      hint.textContent = item.hint;
      option.append(title, hint);
      // Мышью выбираем по нажатию, а не по клику: клик уводит фокус из поля, и
      // каретка теряется до того, как мы успеем вставить разметку.
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

  function choose(index) {
    const item = visible[index];
    if (!item || !anchor) return;
    const { line, from, to } = anchor;
    const text = field.lineAt(line);
    if (item.kind === "prefix") {
      // Подсказка убирается, а сам блок встаёт в начало строки: разметка строки
      // на то и разметка, что живёт слева, где бы ни стояла каретка.
      const rest = text.slice(0, from) + text.slice(to);
      const indent = rest.match(/^\s*/)[0];
      const body = rest.slice(indent.length);
      field.replaceInLine(line, 0, text.length, indent + item.value + body, (indent + item.value).length);
    } else if (item.kind === "wrap") {
      field.replaceInLine(line, from, to, item.before + item.after, item.before.length);
    } else {
      field.replaceInLine(line, from, to, item.value, item.caret ?? item.value.length);
    }
    close();
  }

  function refresh() {
    const caret = field.caret();
    if (!caret) return close();
    const found = readQuery(field.lineAt(caret.line), caret.offset);
    if (!found) return close();
    const matches = filterItems(found.query);
    // Ничего не подошло — меню уходит, а не висит пустой рамкой.
    if (!matches.length) return close();
    const sameQuery = anchor && anchor.line === caret.line && anchor.from === found.from;
    anchor = { line: caret.line, from: found.from, to: found.to };
    visible = matches;
    active = sameQuery ? Math.min(active, matches.length - 1) : 0;
    paint();
  }

  // Клавиши перехватываются на перехвате и выше поля: у самого поля есть свои
  // обработчики Enter и Tab, и они сработали бы раньше, разорвав строку вместо
  // выбора пункта.
  const onKeyDown = (event) => {
    if (!root.contains(event.target)) return;
    if (!open()) return;
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

  // Подсветку ведёт мышь, только когда она правда сдвинулась. Меню встаёт под
  // кареткой — часто прямо под курсором, оставшимся после щелчка в поле, — и
  // браузер сразу сообщает о наведении. Поверь меню этому, Enter вставил бы не
  // первое совпадение, а пункт под неподвижной стрелкой: «созвон /цитат»
  // становился выноской вместо цитаты.
  let pointer = null;
  const onMouseMove = (event) => {
    const moved = pointer && (pointer.x !== event.clientX || pointer.y !== event.clientY);
    pointer = { x: event.clientX, y: event.clientY };
    if (!moved || !open()) return;
    const index = [...menu.children].indexOf(event.target.closest?.(".slash-option"));
    if (index >= 0 && index !== active) setActive(index);
  };
  doc.addEventListener("mousemove", onMouseMove, true);

  // Курсор мог уехать мышью или стрелками — тогда подсказка уже не о том месте.
  const onKeyUp = (event) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) refresh(); };
  root.addEventListener("input", refresh);
  root.addEventListener("keyup", onKeyUp);
  root.addEventListener("blur", close);
  root.addEventListener("mouseup", refresh);
  window.addEventListener("resize", () => { if (open()) place(); });

  return {
    element: menu,
    close,
    isOpen: open,
    destroy: () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("mousemove", onMouseMove, true);
      root.removeEventListener("input", refresh);
      root.removeEventListener("keyup", onKeyUp);
      root.removeEventListener("blur", close);
      root.removeEventListener("mouseup", refresh);
      menu.remove();
    },
  };
}
