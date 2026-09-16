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
      title: `Выноска: ${title.toLowerCase()}`,
      hint: `> [!${kind}]`,
      keys: `callout выноска ${kind} ${title.toLowerCase()} ${CALLOUT_SYNONYMS[kind] ?? ""}`.trimEnd(),
      kind: "prefix",
      value: `> [!${kind}] `,
    };
    byTitle.set(title, item);
    CALLOUT_ITEMS.push(item);
  }
}

export const SLASH_ITEMS = [
  { id: "h1", title: "Заголовок 1", hint: "# ", keys: "h1 heading zagolovok заголовок большой", kind: "prefix", value: "# " },
  { id: "h2", title: "Заголовок 2", hint: "## ", keys: "h2 heading подзаголовок заголовок", kind: "prefix", value: "## " },
  { id: "h3", title: "Заголовок 3", hint: "### ", keys: "h3 heading заголовок мелкий", kind: "prefix", value: "### " },
  { id: "h4", title: "Заголовок 4", hint: "#### ", keys: "h4 heading заголовок", kind: "prefix", value: "#### " },
  { id: "h5", title: "Заголовок 5", hint: "##### ", keys: "h5 heading заголовок", kind: "prefix", value: "##### " },
  { id: "h6", title: "Заголовок 6", hint: "###### ", keys: "h6 heading заголовок", kind: "prefix", value: "###### " },
  { id: "bullet", title: "Список", hint: "- ", keys: "list bullet список маркер пункт", kind: "prefix", value: "- " },
  { id: "ordered", title: "Нумерованный список", hint: "1. ", keys: "ordered number нумерованный список цифры", kind: "prefix", value: "1. " },
  { id: "task", title: "Задача", hint: "- [ ] ", keys: "todo task чекбокс задача галочка дело", kind: "prefix", value: "- [ ] " },
  { id: "quote", title: "Цитата", hint: "> ", keys: "quote цитата", kind: "prefix", value: "> " },
  { id: "code", title: "Блок кода", hint: "```", keys: "code блок кода программа", kind: "block", value: "```\n\n```", caret: 4 },
  { id: "divider", title: "Разделитель", hint: "---", keys: "divider hr разделитель черта линия", kind: "block", value: "---" },
  // Ячейки пустые, а не с примером внутри: заготовку с «Что» и «Сколько»
  // пришлось бы сначала стирать, а каретка и так стоит в первой ячейке.
  { id: "table", title: "Таблица", hint: "| … | … |", keys: "table таблица", kind: "block", value: "|  |  |\n| --- | --- |\n|  |  |", caret: 2 },
  { id: "bold", title: "Жирный", hint: "**текст**", keys: "bold жирный полужирный", kind: "wrap", before: "**", after: "**" },
  { id: "italic", title: "Курсив", hint: "*текст*", keys: "italic курсив наклонный", kind: "wrap", before: "*", after: "*" },
  { id: "strike", title: "Зачёркнутый", hint: "~~текст~~", keys: "strike зачёркнутый зачеркнутый", kind: "wrap", before: "~~", after: "~~" },
  { id: "mark", title: "Выделение", hint: "==текст==", keys: "highlight mark выделение маркер", kind: "wrap", before: "==", after: "==" },
  { id: "inline-code", title: "Код в строке", hint: "`код`", keys: "code inline код строка", kind: "wrap", before: "`", after: "`" },
  // Адрес в заготовке настоящий, а не «https://»: поле рисует ссылку только с
  // полным адресом, и с обрубком человек видел бы серый текст вместо ссылки.
  // example.com зарезервирован стандартом и никуда не ведёт.
  { id: "link", title: "Ссылка", hint: "[текст](адрес)", keys: "link ссылка адрес url", kind: "wrap", before: "[", after: "](https://example.com)" },
  { id: "image", title: "Изображение", hint: "![подпись](адрес)", keys: "image picture photo изображение картинка фото", kind: "wrap", before: "![", after: "](https://example.com)" },
  { id: "wikilink", title: "Внутренняя ссылка", hint: "[[запись]]", keys: "wikilink internal вики внутренняя ссылка память", kind: "wrap", before: "[[", after: "]]" },
  { id: "embed", title: "Встраивание записи", hint: "![[запись]]", keys: "embed transclude встраивание вложение записи", kind: "wrap", before: "![[", after: "]]" },
  ...CALLOUT_ITEMS,
  { id: "math", title: "Формула", hint: "$x$", keys: "math formula latex формула математика", kind: "wrap", before: "$", after: "$" },
  { id: "math-block", title: "Формула блоком", hint: "$$x$$", keys: "math formula block формула блоком выключная", kind: "wrap", before: "$$", after: "$$" },
  { id: "comment", title: "Комментарий", hint: "%%текст%%", keys: "comment hidden комментарий скрытый черновик", kind: "wrap", before: "%%", after: "%%" },
  { id: "footnote", title: "Сноска", hint: "^[текст]", keys: "footnote inline сноска примечание", kind: "wrap", before: "^[", after: "]" },
  { id: "footnote-ref", title: "Сноска: ссылка", hint: "[^1]", keys: "footnote ref сноска ссылка номер", kind: "wrap", before: "[^", after: "]" },
  { id: "footnote-def", title: "Сноска: определение", hint: "[^1]:", keys: "footnote definition сноска определение внизу", kind: "prefix", value: "[^1]: " },
  // У тега нет закрывающей пары: after пустой, набранное после решётки и есть тег.
  { id: "tag", title: "Тег", hint: "#тег", keys: "tag hashtag тег метка рубрика", kind: "wrap", before: "#", after: "" },
  // Имя якоря — латиницей: поле рисует только такие, поэтому в заготовке
  // настоящее имя-пример, как адрес у ссылки, а не кириллический обрубок.
  { id: "anchor", title: "Якорь блока", hint: "^имя", keys: "anchor block якорь блока метка ссылка", kind: "block", value: "^anchor" },
];

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
  menu.setAttribute("aria-label", "Разметка");
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
