// Меню разметки по «/». Markdown в поле оформляется на лету, но помнить его
// наизусть человек не обязан: набрал косую черту — увидел, что вообще бывает,
// и выбрал. Отдельный модуль, потому что это не про разбор разметки, а про
// подсказку; поле отдаёт ему только каретку и замену куска строки.

// В списке лежит лишь то, что поле правда рисует: предложить блок, который
// останется серым текстом, — хуже, чем не предлагать ничего. Ключевые слова
// нарочно на двух языках: «/h1» и «/заг» должны находить одно и то же.
export const SLASH_ITEMS = [
  { id: "h1", title: "Заголовок 1", hint: "# ", keys: "h1 heading zagolovok заголовок большой", kind: "prefix", value: "# " },
  { id: "h2", title: "Заголовок 2", hint: "## ", keys: "h2 heading подзаголовок заголовок", kind: "prefix", value: "## " },
  { id: "h3", title: "Заголовок 3", hint: "### ", keys: "h3 heading заголовок мелкий", kind: "prefix", value: "### " },
  { id: "bullet", title: "Список", hint: "- ", keys: "list bullet список маркер пункт", kind: "prefix", value: "- " },
  { id: "ordered", title: "Нумерованный список", hint: "1. ", keys: "ordered number нумерованный список цифры", kind: "prefix", value: "1. " },
  { id: "task", title: "Задача", hint: "- [ ] ", keys: "todo task чекбокс задача галочка дело", kind: "prefix", value: "- [ ] " },
  { id: "quote", title: "Цитата", hint: "> ", keys: "quote цитата", kind: "prefix", value: "> " },
  { id: "note", title: "Выноска: заметка", hint: "> [!note]", keys: "callout note выноска заметка", kind: "prefix", value: "> [!note] " },
  { id: "warning", title: "Выноска: внимание", hint: "> [!warning]", keys: "callout warning выноска внимание предупреждение", kind: "prefix", value: "> [!warning] " },
  { id: "tip", title: "Выноска: совет", hint: "> [!tip]", keys: "callout tip выноска совет подсказка", kind: "prefix", value: "> [!tip] " },
  { id: "danger", title: "Выноска: опасность", hint: "> [!danger]", keys: "callout danger выноска опасность ошибка", kind: "prefix", value: "> [!danger] " },
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
  doc.body.append(menu);

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

  function paint() {
    menu.replaceChildren();
    visible.forEach((item, index) => {
      const option = doc.createElement("div");
      option.className = `slash-option${index === active ? " is-active" : ""}`;
      option.id = `slash-option-${item.id}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === active));
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
      option.addEventListener("mouseenter", () => {
        active = index;
        paint();
      });
      menu.append(option);
    });
    const current = visible[active];
    if (current) root.setAttribute("aria-activedescendant", `slash-option-${current.id}`);
    menu.hidden = false;
    place();
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
      ArrowDown: () => { active = (active + 1) % visible.length; paint(); },
      ArrowUp: () => { active = (active - 1 + visible.length) % visible.length; paint(); },
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
      root.removeEventListener("input", refresh);
      root.removeEventListener("keyup", onKeyUp);
      root.removeEventListener("blur", close);
      root.removeEventListener("mouseup", refresh);
      menu.remove();
    },
  };
}
