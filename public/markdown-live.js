// Поле ввода, которое рендерит Markdown прямо во время набора.
//
// Главный приём: разметка оформляется, но **ни один символ не удаляется** —
// маркеры (`**`, `#`, `- `) остаются в тексте. Благодаря этому textContent
// строки посимвольно совпадает с исходником, каретку можно восстановить по
// смещению, и перерисовывать можно на каждый ввод, включая строку под
// кареткой. Прячет маркеры только CSS и только на строках без каретки
// (класс is-current): текст модели не меняется, а на активной строке маркеры
// раскрываются — иначе в них некуда поставить каретку и разметку стало бы
// не отредактировать.
const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => escapes[character]);
const mark = (text) => `<span class="md-mark">${escapeHtml(text)}</span>`;
const safeUrl = (url) => (/^https?:\/\/[^\s<>"']+$/i.test(String(url).trim()) ? String(url).trim() : null);

// Инлайновые пары: маркер остаётся на месте, содержимое получает оформление.
// Порядок важен: тройной маркер разбирается раньше двойного и одинарного,
// а код — раньше всех, потому что внутри него разметка не действует.
const INLINE = [
  { re: /(``)([^`\n]+)(``)/g, tag: "code" },
  { re: /(`)([^`\n]+)(`)/g, tag: "code" },
  { re: /(\$\$)([^$\n]+)(\$\$)/g, tag: "code", className: "md-math md-math-block" },
  { re: /(\$)([^$\n]+)(\$)/g, tag: "code", className: "md-math" },
  { re: /(\*\*\*)(?=\S)([^\n]*?\S)(\*\*\*)/g, tag: "strong", inner: "em" },
  { re: /(___)(?=\S)([^\n]*?\S)(___)/g, tag: "strong", inner: "em" },
  { re: /(\*\*)(?=\S)([^\n]*?\S)(\*\*)/g, tag: "strong" },
  { re: /(__)(?=\S)([^\n]*?\S)(__)/g, tag: "strong" },
  { re: /(~~)(?=\S)([^\n]*?\S)(~~)/g, tag: "del" },
  { re: /(?<![-\w])(--)(?=\S)([^-\n]*?\S)(--)(?![-\w])/g, tag: "del" },
  { re: /(==)(?=\S)([^\n]*?\S)(==)/g, tag: "mark" },
  // Подчёркивание: в Markdown его нет, ++текст++ — принятое расширение.
  { re: /(\+\+)(?=\S)([^+\n]*?\S)(\+\+)/g, tag: "u" },
  { re: /(?<![*\w])(\*)(?=\S)([^*\n]*?\S)(\*)(?![*\w])/g, tag: "em" },
  { re: /(?<![_\w])(_)(?=\S)([^_\n]*?\S)(_)(?![_\w])/g, tag: "em" },
  { re: /(%%)([^\n]*?)(%%)/g, tag: "span", className: "md-comment" },
];

// Цвета текста и фона — палитра Notion. Синтаксис — pandoc-овские span-ы с
// классом: [текст]{.red}, [текст]{.bg-yellow}. Как и остальная разметка, это
// обычный текст, который читается и без оформления.
export const COLOR_NAMES = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
export const COLOR_SPAN = /(\[)([^\[\]\n]+?)(\]\{\.)((?:bg-)?(?:gray|brown|orange|yellow|green|blue|purple|pink|red))(\})/g;

function inlineDecorate(text) {
  let out = escapeHtml(text);
  for (const { re, tag, inner, className } of INLINE) {
    out = out.replace(re, (match, open, body, close) => {
      const content = inner ? `<${inner}>${body}</${inner}>` : body;
      const attribute = className ? ` class="${className}"` : "";
      return `${mark(open)}<${tag}${attribute}>${content}</${tag}>${mark(close)}`;
    });
  }
  // Цвет — после парных маркеров (внутри может быть жирный) и до ссылок.
  out = out.replace(COLOR_SPAN, (match, open, body, mid, name, close) =>
    `${mark(open)}<span class="md-color md-color-${name}">${body}</span>${mark(mid + name + close)}`);
  // Внутренние ссылки и встраивания Obsidian.
  out = out.replace(/(!?)(\[\[)([^\]\n]+)(\]\])/g, (match, bang, open, target, close) => {
    const [pathPart, alias] = target.split("|");
    const shown = alias === undefined
      ? escapeHtml(pathPart)
      : `${escapeHtml(pathPart)}${mark("|")}${escapeHtml(alias)}`;
    return `${bang ? mark(bang) : ""}${mark(open)}<span class="md-wikilink">${shown}</span>${mark(close)}`;
  });
  // Изображения и ссылки: адрес приглушается, подпись остаётся читаемой.
  out = out.replace(/(!\[|\[)([^\]\n]+)(\]\()([^)\s]+)(\))/g, (match, open, label, mid, url, close) => {
    if (!safeUrl(url)) return match;
    const kind = open.startsWith("!") ? "md-image" : "md-link";
    return `${mark(open)}<span class="${kind}">${label}</span>${mark(mid)}${mark(url)}${mark(close)}`;
  });
  // Автоссылки: голый адрес и адрес в угловых скобках.
  out = out.replace(/(&lt;)(https?:\/\/[^\s&]+)(&gt;)/g, (match, open, url, close) =>
    `${mark(open)}<span class="md-link">${url}</span>${mark(close)}`);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g, (match, before, url) =>
    `${before}<span class="md-link">${url}</span>`);
  // Сноски, теги и якоря блоков.
  out = out.replace(/(\^\[)([^\]\n]+)(\])/g, (match, open, body, close) =>
    `${mark(open)}<span class="md-footnote-ref">${body}</span>${mark(close)}`);
  out = out.replace(/(\[\^)([^\]\s]+)(\])/g, (match, open, name, close) =>
    `${mark(open)}<span class="md-footnote-ref">${name}</span>${mark(close)}`);
  out = out.replace(/(^|\s)(#)([\p{L}\p{N}_/-]{1,60})(?=$|\s|[.,;:!?)])/gu, (match, before, hash, tag) =>
    `${before}<span class="md-tag">${escapeHtml(hash)}${tag}</span>`);
  out = out.replace(/(^|\s)(\^[\w-]{1,40})(?=$|\s)/g, (match, before, anchor) =>
    `${before}<span class="md-anchor">${escapeHtml(anchor)}</span>`);
  return out;
}

// Одна строка исходника → HTML, чей textContent равен этой же строке.
export function decorateLine(line) {
  if (!line) return "<br>";
  const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (heading) {
    const [, space, hashes, gap, rest] = heading;
    return `${escapeHtml(space)}${mark(hashes + gap)}<span class="md-heading md-h${hashes.length}">${inlineDecorate(rest)}</span>`;
  }
  // Определение сноски: [^1]: текст.
  const footnote = line.match(/^(\s*)(\[\^[^\]\s]+\]:)(\s*)(.*)$/);
  if (footnote) {
    const [, space, marker, gap, rest] = footnote;
    return `${escapeHtml(space)}<span class="md-footnote-def">${mark(marker)}</span>${escapeHtml(gap)}${inlineDecorate(rest)}`;
  }
  const quote = line.match(/^(\s*)(>\s?)(.*)$/);
  if (quote) {
    const [, space, marker, rest] = quote;
    // Callout — цитата с типом в начале: `> [!warning] Заголовок`.
    const callout = rest.match(/^(\[!)([\p{L}\p{N}_-]+)(\][+-]?)(\s*)(.*)$/u);
    if (callout) {
      const [, open, kind, close, gap, title] = callout;
      return `${escapeHtml(space)}<span class="md-callout-line md-callout-${escapeHtml(kind.toLowerCase())}">${mark(marker)}${mark(open)}<span class="md-callout-kind">${escapeHtml(kind)}</span>${mark(close)}${escapeHtml(gap)}<span class="md-callout-title">${inlineDecorate(title)}</span></span>`;
    }
    return `${escapeHtml(space)}<span class="md-quote">${mark(marker)}${inlineDecorate(rest)}</span>`;
  }
  // Задачи `- [ ]` и `- [x]` — раньше обычного списка.
  const task = line.match(/^(\s*)([-*+]\s+)(\[)([ xX/-])(\]\s+)(.*)$/);
  if (task) {
    const [, space, bullet, open, state, close, rest] = task;
    const done = state.toLowerCase() === "x";
    return `${escapeHtml(space)}<span class="md-bullet md-bullet-task">${mark(bullet)}</span><span class="md-checkbox${done ? " md-checkbox-done" : ""}">${mark(open)}${escapeHtml(state)}${mark(close)}</span><span class="${done ? "md-task-done" : "md-task"}">${inlineDecorate(rest)}</span>`;
  }
  const bullet = line.match(/^(\s*)([-*+]\s+)(.*)$/);
  if (bullet) {
    const [, space, marker, rest] = bullet;
    return `${escapeHtml(space)}<span class="md-bullet">${mark(marker)}</span>${inlineDecorate(rest)}`;
  }
  const ordered = line.match(/^(\s*)(\d{1,3}[.)]\s+)(.*)$/);
  if (ordered) {
    const [, space, marker, rest] = ordered;
    return `${escapeHtml(space)}<span class="md-bullet md-ordered">${mark(marker)}</span>${inlineDecorate(rest)}`;
  }
  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return `<span class="md-rule">${escapeHtml(line)}</span>`;
  if (/^\s*(?:```|~~~)/.test(line)) return `<span class="md-fence">${escapeHtml(line)}</span>`;
  // Строка таблицы: содержимое ячеек читается, трубы приглушаются.
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const cells = line.split("|");
    const decorated = cells
      .map((cell, index) => (index === 0 || index === cells.length - 1 ? escapeHtml(cell) : `<span class="md-cell">${inlineDecorate(cell)}</span>`))
      .join(mark("|"));
    return `<span class="md-table-line">${decorated}</span>`;
  }
  return inlineDecorate(line);
}

// Продолжение списка по Enter, как в Obsidian. Возвращает:
//   { prefix }  — чем начать следующую строку;
//   { clear: true } — пункт пустой, список пора закончить;
//   null — строка не список.
export function listContinuation(line) {
  // Цитата и callout продолжаются так же, как список: Enter повторяет «> »,
  // иначе тело callout разваливается на отдельные строки. Вложенные «> > »
  // сохраняются целиком, а список внутри цитаты продолжается вместе с ней.
  const quote = line.match(/^(\s*)((?:>\s?)+)(.*)$/);
  if (quote) {
    const [, space, markers, rest] = quote;
    const callout = rest.match(/^\[![\p{L}\p{N}_-]+\][+-]?\s*(.*)$/u);
    // После строки с типом всегда идёт тело — даже если заголовок пуст.
    if (callout) return { prefix: `${space}${markers}` };
    const inner = listContinuation(rest);
    if (inner) return { prefix: `${space}${markers}${inner.prefix ?? ""}` };
    return rest.trim() ? { prefix: `${space}${markers}` } : { clear: true, keep: space };
  }
  const task = line.match(/^(\s*)([-*+]\s+)\[([ xX/-])\](\s+)(.*)$/);
  if (task) {
    const [, space, bullet, , gap, rest] = task;
    return rest.trim() ? { prefix: `${space}${bullet}[ ]${gap}` } : { clear: true, keep: space };
  }
  const ordered = line.match(/^(\s*)(\d{1,3})([.)])(\s+)(.*)$/);
  if (ordered) {
    const [, space, number, dot, gap, rest] = ordered;
    return rest.trim()
      ? { prefix: `${space}${Number(number) + 1}${dot}${gap}` }
      : { clear: true, keep: space };
  }
  const bullet = line.match(/^(\s*)([-*+])(\s+)(.*)$/);
  if (bullet) {
    const [, space, marker, gap, rest] = bullet;
    return rest.trim() ? { prefix: `${space}${marker}${gap}` } : { clear: true, keep: space };
  }
  return null;
}

// Уровень вложенности пункта — два пробела: столько же ждёт блочный рендер,
// когда собирает вложенные списки.
export const INDENT = "  ";

// Сдвиг строки списка вправо (Tab) или влево (Shift+Tab). Возвращает новую
// строку и то, насколько сместилась каретка.
export function indentLine(line, direction) {
  if (direction > 0) return { line: INDENT + line, shift: INDENT.length };
  const leading = line.match(/^(\t| {1,2})/);
  if (!leading) return { line, shift: 0 };
  return { line: line.slice(leading[0].length), shift: -leading[0].length };
}

// Пересчёт номеров в блоке нумерованного списка вокруг строк from..to: после
// сдвига вправо пункт становится подпунктом и начинает счёт с 1, после сдвига
// влево — продолжает счёт родителя, а соседи ниже подтягиваются. Номер
// считается по глубине отступа; маркер другого вида или строка не из списка
// обрывают счёт на своей глубине и глубже. Возвращает true, если что-то
// изменилось.
export function renumberOrdered(lines, from, to = from) {
  const isItem = (line) => listContinuation(line) !== null;
  let start = from, end = to;
  while (start > 0 && isItem(lines[start - 1])) start -= 1;
  while (end < lines.length - 1 && isItem(lines[end + 1])) end += 1;
  const counters = new Map();
  let changed = false;
  for (let index = start; index <= end; index += 1) {
    const line = lines[index];
    const ordered = line.match(/^(\s*)(\d{1,3})([.)])(\s+)(.*)$/);
    const other = ordered ? null : line.match(/^(\s*)\S/);
    const depth = (ordered ? ordered[1] : other ? other[1] : "").length;
    for (const key of [...counters.keys()]) if (key > depth || (!ordered && key === depth)) counters.delete(key);
    if (!ordered) continue;
    const number = (counters.get(depth) ?? 0) + 1;
    counters.set(depth, number);
    if (Number(ordered[2]) === number) continue;
    lines[index] = `${ordered[1]}${number}${ordered[3]}${ordered[4]}${ordered[5]}`;
    changed = true;
  }
  return changed;
}

// Переключение состояния задачи в строке: `[ ]` ⇄ `[x]`.
export function toggleTask(line) {
  const task = line.match(/^(\s*[-*+]\s+\[)([ xX/-])(\].*)$/);
  if (!task) return null;
  return `${task[1]}${task[2].toLowerCase() === "x" ? " " : "x"}${task[3]}`;
}

const LINE = "md-line";
const normalize = (text) => String(text).replace(/\r\n?/g, "\n").replace(/ /g, " ");

/** Поле ввода с живым Markdown. Возвращает элемент и небольшое API вокруг него. */
export function createMarkdownField({ id, ariaLabel, placeholder = "", onInput, onSubmit, submitOnEnter = false } = {}) {
  const root = document.createElement("div");
  root.className = "md-field";
  if (id) root.id = id;
  root.contentEditable = "true";
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  root.dataset.placeholder = placeholder;
  root.spellcheck = true;

  let lines = [""];

  const lineNodes = () => [...root.querySelectorAll(`:scope > .${LINE}`)];
  const readLines = () => {
    const nodes = lineNodes();
    if (!nodes.length) return normalize(root.textContent).split("\n");
    // Внутри строки перенос может появиться после вставки: разворачиваем его.
    return nodes.flatMap((node) => normalize(node.textContent).split("\n"));
  };

  // Позиция (строка, смещение) для произвольного узла выделения.
  const caretOf = (anchorNode, anchorOffset) => {
    const nodes = lineNodes();
    const host = anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement;
    const lineNode = host?.closest(`.${LINE}`);
    const index = lineNode ? nodes.indexOf(lineNode) : -1;
    if (index < 0) return null;
    const range = document.createRange();
    range.selectNodeContents(lineNode);
    range.setEnd(anchorNode, anchorOffset);
    return { line: index, offset: normalize(range.toString()).length };
  };

  const readCaret = () => {
    const selection = document.getSelection();
    if (!selection || !selection.rangeCount || !root.contains(selection.anchorNode)) return null;
    return caretOf(selection.anchorNode, selection.anchorOffset);
  };

  // Точка в DOM для позиции «строка и смещение» — общая для каретки и границ
  // выделения.
  const pointOf = (position) => {
    const nodes = lineNodes();
    const lineNode = nodes[Math.min(position.line, nodes.length - 1)];
    if (!lineNode) return null;
    const walker = document.createTreeWalker(lineNode, NodeFilter.SHOW_TEXT);
    let remaining = position.offset;
    while (walker.nextNode()) {
      const length = walker.currentNode.textContent.length;
      if (remaining <= length) return { node: walker.currentNode, offset: remaining };
      remaining -= length;
    }
    return { node: lineNode, offset: lineNode.childNodes.length };
  };
  const placeCaret = (position) => {
    if (!position) return;
    const point = pointOf(position);
    if (!point) return;
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const placeSelection = (from, to) => {
    const start = pointOf(from), end = pointOf(to);
    if (!start || !end) return;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  // Выделение в координатах модели, от меньшей границы к большей; null — если
  // выделения нет или оно вне поля.
  const readSelection = () => {
    const selection = document.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
    const anchor = caretOf(selection.anchorNode, selection.anchorOffset);
    const focus = caretOf(selection.focusNode, selection.focusOffset);
    if (!anchor || !focus) return null;
    const before = anchor.line < focus.line || (anchor.line === focus.line && anchor.offset <= focus.offset);
    return before ? { from: anchor, to: focus } : { from: focus, to: anchor };
  };

  // Чистовик, как в Notion: маркеры разметки видны только на строке с
  // кареткой, остальные строки показывают готовый текст. Прячет и раскрывает
  // маркеры CSS по классу is-current — перерисовка для этого не нужна.
  const paintCurrentLine = (index) => {
    lineNodes().forEach((node, position) => node.classList.toggle("is-current", position === index));
  };
  let wasConnected = false;
  const onSelectionChange = () => {
    if (root.isConnected) wasConnected = true;
    else {
      // Поле заметки пересоздаётся на каждое открытие карточки: слушатель
      // убирает себя, когда его поле ушло из DOM, иначе копился бы на документе.
      if (wasConnected) document.removeEventListener("selectionchange", onSelectionChange);
      return;
    }
    const caret = readCaret();
    paintCurrentLine(caret ? caret.line : -1);
  };
  document.addEventListener("selectionchange", onSelectionChange);

  const render = (caret) => {
    // Тело callout — обычные строки цитаты, но полоса у них должна быть цвета
    // заголовка: иначе блок распадается на разноцветную шапку и серый хвост.
    let calloutKind = null;
    const nodes = lines.map((line) => {
      const node = document.createElement("div");
      node.className = LINE;
      const callout = line.match(/^\s*(?:>\s?)+\[!([\p{L}\p{N}_-]+)\]/u);
      if (callout) {
        calloutKind = callout[1].toLowerCase();
        node.classList.add("md-callout-head", `md-callout-${calloutKind}`);
      } else if (!/^\s*>/.test(line)) {
        calloutKind = null;
      } else if (calloutKind) {
        node.classList.add("md-callout-body", `md-callout-${calloutKind}`);
      }
      node.innerHTML = decorateLine(line);
      return node;
    });
    // Последняя строка блока скругляется снизу: строки остаются отдельными
    // (иначе каретка потеряется), но выглядят одним callout.
    nodes.forEach((node, index) => {
      const inside = node.classList.contains("md-callout-head") || node.classList.contains("md-callout-body");
      const nextInside = nodes[index + 1]?.classList.contains("md-callout-body");
      if (inside && !nextInside) node.classList.add("md-callout-tail");
    });
    root.replaceChildren(...nodes);
    root.dataset.empty = String(lines.length === 1 && lines[0] === "");
    placeCaret(caret);
    // Сразу, не дожидаясь selectionchange: иначе маркеры мигают на перерисовке.
    paintCurrentLine(caret ? caret.line : -1);
  };

  const sync = () => {
    const caret = readCaret();
    lines = readLines();
    if (!lines.length) lines = [""];
    render(caret);
    if (onInput) onInput(getValue());
  };

  const getValue = () => lines.join("\n");
  const setValue = (value, { caretToEnd = false } = {}) => {
    lines = normalize(value ?? "").split("\n");
    if (!lines.length) lines = [""];
    render(caretToEnd ? { line: lines.length - 1, offset: lines[lines.length - 1].length } : null);
    if (onInput) onInput(getValue());
  };

  root.addEventListener("input", sync);
  root.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = normalize(event.clipboardData?.getData("text/plain") || "");
    const caret = readCaret() || { line: lines.length - 1, offset: lines[lines.length - 1].length };
    const current = lines[caret.line] ?? "";
    const inserted = text.split("\n");
    const head = current.slice(0, caret.offset);
    const tail = current.slice(caret.offset);
    inserted[0] = head + inserted[0];
    const last = inserted.length - 1;
    const caretOffset = inserted[last].length;
    inserted[last] += tail;
    lines.splice(caret.line, 1, ...inserted);
    render({ line: caret.line + last, offset: caretOffset });
    if (onInput) onInput(getValue());
  });
  root.addEventListener("click", (event) => {
    const box = event.target.closest?.(".md-checkbox");
    if (!box || !root.contains(box)) return;
    const lineNode = box.closest(`.${LINE}`);
    const index = lineNodes().indexOf(lineNode);
    if (index < 0) return;
    const toggled = toggleTask(lines[index]);
    if (toggled === null) return;
    event.preventDefault();
    lines[index] = toggled;
    render({ line: index, offset: lines[index].length });
    if (onInput) onInput(getValue());
  });
  root.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (onSubmit) onSubmit(getValue());
      return;
    }
    if (event.key === "Tab") {
      const caret = readCaret();
      const selection = document.getSelection();
      // Границы выделения: Tab двигает все захваченные строки, а не одну.
      const focus = selection && selection.focusNode ? caretOf(selection.focusNode, selection.focusOffset) : null;
      const from = Math.min(caret?.line ?? 0, focus?.line ?? caret?.line ?? 0);
      const to = Math.max(caret?.line ?? 0, focus?.line ?? caret?.line ?? 0);
      if (caret === null) return;
      // Вне списка Tab не перехватываем: он должен уводить фокус дальше по
      // форме, иначе с клавиатуры из поля не выйти.
      const touched = lines.slice(from, to + 1);
      if (!touched.some((line) => listContinuation(line) !== null)) return;
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      let caretShift = 0;
      for (let index = from; index <= to; index += 1) {
        const result = indentLine(lines[index], direction);
        lines[index] = result.line;
        if (index === caret.line) caretShift = result.shift;
      }
      // Сдвинутый пункт нумерованного списка меняет номер: подпункт начинает
      // с 1, вернувшийся продолжает счёт родителя. Каретка едет вместе с
      // маркером, если тот стал короче или длиннее.
      const beforeRenumber = lines[caret.line].length;
      renumberOrdered(lines, from, to);
      caretShift += lines[caret.line].length - beforeRenumber;
      render({ line: caret.line, offset: Math.max(0, caret.offset + caretShift) });
      if (onInput) onInput(getValue());
      return;
    }
    // Поле записи: Enter отправляет, Shift+Enter переносит строку. Внутри
    // списка или цитаты Enter продолжает их, как в Obsidian: пустой пункт
    // заканчивает список, и следующий Enter уже отправляет. Пока идёт набор
    // через IME, Enter принадлежит ему.
    if (event.key === "Enter" && submitOnEnter && onSubmit && !event.shiftKey && !event.isComposing) {
      const at = readCaret();
      const head = at ? (lines[at.line] ?? "").slice(0, at.offset) : "";
      if (!at || listContinuation(head) === null) {
        event.preventDefault();
        onSubmit(getValue());
        return;
      }
    }
    if (event.key === "Enter") {
      // Перенос строки контролируем сами: браузер иначе вставит свои <div>
      // и модель строк перестанет совпадать с разметкой.
      event.preventDefault();
      const caret = readCaret() || { line: lines.length - 1, offset: lines[lines.length - 1].length };
      const current = lines[caret.line] ?? "";
      const head = current.slice(0, caret.offset);
      const tail = current.slice(caret.offset);
      // Shift+Enter — просто перенос: список не продолжаем.
      const continuation = event.shiftKey ? null : listContinuation(head);
      if (continuation?.clear) {
        // Enter на пустом пункте заканчивает список, а не плодит маркеры.
        lines.splice(caret.line, 1, continuation.keep + tail);
        render({ line: caret.line, offset: continuation.keep.length });
        if (onInput) onInput(getValue());
        return;
      }
      const prefix = continuation?.prefix ?? "";
      lines.splice(caret.line, 1, head, prefix + tail);
      render({ line: caret.line + 1, offset: prefix.length });
      if (onInput) onInput(getValue());
    }
  });

  render(null);

  return {
    element: root,
    getValue,
    setValue,
    clear: () => setValue(""),
    focus: () => root.focus(),
    // Узкий шов для меню разметки: оно должно знать, что набрано на строке до
    // каретки, и уметь заменить этот кусок. Больше внутренностей поля наружу не
    // отдаём — иначе меню начнёт лезть в отрисовку и модель строк.
    caret: readCaret,
    selection: readSelection,
    lines: () => [...lines],
    // Замена всех строк разом — для панели оформления, которая переписывает
    // несколько строк выделения и хочет оставить выделение на тексте.
    setLines: (next, range = null) => {
      lines = next.length ? [...next] : [""];
      render(range ? range.from : null);
      if (range && (range.from.line !== range.to.line || range.from.offset !== range.to.offset)) placeSelection(range.from, range.to);
      if (onInput) onInput(getValue());
    },
    lineAt: (index) => lines[index] ?? "",
    replaceInLine: (index, from, to, text, caretOffset = text.length) => {
      const current = lines[index] ?? "";
      // Вставка может быть в несколько строк (блок кода, таблица). Перенос
      // внутри одной строки модели сломал бы её: строки должны оставаться
      // строками, поэтому вставка сразу разворачивается в отдельные.
      const head = current.slice(0, from);
      const tail = current.slice(to);
      const parts = (head + text + tail).split("\n");
      lines.splice(index, 1, ...parts);
      // Каретка задана смещением внутри вставки — переводим его в «строка и
      // смещение», считая переносы до него.
      const before = (head + text.slice(0, caretOffset)).split("\n");
      render({ line: index + before.length - 1, offset: before[before.length - 1].length });
      if (onInput) onInput(getValue());
    },
    setPlaceholder: (text) => {
      root.dataset.placeholder = text;
    },
    setDisabled: (disabled) => {
      root.contentEditable = disabled ? "false" : "true";
      root.dataset.disabled = String(Boolean(disabled));
    },
  };
}
