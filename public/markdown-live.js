// Поле ввода, которое рендерит Markdown прямо во время набора.
//
// Главный приём: разметка оформляется, но **ни один символ не удаляется** —
// маркеры (`**`, `#`, `- `) остаются в тексте и лишь приглушаются. Благодаря
// этому textContent строки посимвольно совпадает с исходником, каретку можно
// восстановить по смещению, и перерисовывать можно на каждый ввод, включая
// строку под кареткой. Скрывать маркеры нельзя: тогда в них некуда поставить
// каретку и разметку стало бы не отредактировать.
const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => escapes[character]);
const mark = (text) => `<span class="md-mark">${escapeHtml(text)}</span>`;
const safeUrl = (url) => (/^https?:\/\/[^\s<>"']+$/i.test(String(url).trim()) ? String(url).trim() : null);

// Инлайновые пары: маркер остаётся на месте, содержимое получает оформление.
const INLINE = [
  { re: /(`)([^`\n]+)(`)/g, tag: "code" },
  { re: /(\*\*)(?=\S)([^\n]*?\S)(\*\*)/g, tag: "strong" },
  { re: /(__)(?=\S)([^\n]*?\S)(__)/g, tag: "strong" },
  { re: /(~~)(?=\S)([^\n]*?\S)(~~)/g, tag: "del" },
  { re: /(?<![-\w])(--)(?=\S)([^-\n]*?\S)(--)(?![-\w])/g, tag: "del" },
  { re: /(?<![*\w])(\*)(?=\S)([^*\n]*?\S)(\*)(?![*\w])/g, tag: "em" },
  { re: /(?<![_\w])(_)(?=\S)([^_\n]*?\S)(_)(?![_\w])/g, tag: "em" },
];

function inlineDecorate(text) {
  // Код разбирается первым: внутри него разметка не действует.
  let out = escapeHtml(text);
  for (const { re, tag } of INLINE) {
    out = out.replace(re, (match, open, body, close) =>
      `${mark(open)}<${tag}>${body}</${tag}>${mark(close)}`,
    );
  }
  out = out.replace(/(\[)([^\]\n]+)(\]\()([^)\s]+)(\))/g, (match, ob, label, mid, url, cb) => {
    if (!safeUrl(url)) return match;
    return `${mark(ob)}<span class="md-link">${label}</span>${mark(mid)}${mark(url)}${mark(cb)}`;
  });
  return out;
}

// Одна строка исходника → HTML, чей textContent равен этой же строке.
export function decorateLine(line) {
  if (!line) return "<br>";
  const heading = line.match(/^(\s*)(#{1,4})(\s+)(.*)$/);
  if (heading) {
    const [, space, hashes, gap, rest] = heading;
    return `${escapeHtml(space)}${mark(hashes + gap)}<span class="md-heading md-h${hashes.length}">${inlineDecorate(rest)}</span>`;
  }
  const quote = line.match(/^(\s*)(>\s?)(.*)$/);
  if (quote) {
    const [, space, marker, rest] = quote;
    return `${escapeHtml(space)}<span class="md-quote">${mark(marker)}${inlineDecorate(rest)}</span>`;
  }
  const bullet = line.match(/^(\s*)([-*+]\s+)(.*)$/);
  if (bullet) {
    const [, space, marker, rest] = bullet;
    return `${escapeHtml(space)}<span class="md-bullet">${mark(marker)}</span>${inlineDecorate(rest)}`;
  }
  const ordered = line.match(/^(\s*)(\d{1,3}[.)]\s+)(.*)$/);
  if (ordered) {
    const [, space, marker, rest] = ordered;
    return `${escapeHtml(space)}<span class="md-bullet">${mark(marker)}</span>${inlineDecorate(rest)}`;
  }
  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return `<span class="md-rule">${escapeHtml(line)}</span>`;
  if (/^\s*```/.test(line)) return `<span class="md-fence">${escapeHtml(line)}</span>`;
  return inlineDecorate(line);
}

const LINE = "md-line";
const normalize = (text) => String(text).replace(/\r\n?/g, "\n").replace(/ /g, " ");

/** Поле ввода с живым Markdown. Возвращает элемент и небольшое API вокруг него. */
export function createMarkdownField({ id, ariaLabel, placeholder = "", onInput, onSubmit } = {}) {
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

  const readCaret = () => {
    const selection = document.getSelection();
    if (!selection || !selection.rangeCount || !root.contains(selection.anchorNode)) return null;
    const nodes = lineNodes();
    const anchor = selection.anchorNode;
    const host = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const lineNode = host?.closest(`.${LINE}`);
    const index = lineNode ? nodes.indexOf(lineNode) : -1;
    if (index < 0) return null;
    const range = document.createRange();
    range.selectNodeContents(lineNode);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return { line: index, offset: normalize(range.toString()).length };
  };

  const placeCaret = (position) => {
    if (!position) return;
    const nodes = lineNodes();
    const lineNode = nodes[Math.min(position.line, nodes.length - 1)];
    if (!lineNode) return;
    const walker = document.createTreeWalker(lineNode, NodeFilter.SHOW_TEXT);
    let remaining = position.offset;
    let target = null;
    let targetOffset = 0;
    while (walker.nextNode()) {
      const length = walker.currentNode.textContent.length;
      if (remaining <= length) {
        target = walker.currentNode;
        targetOffset = remaining;
        break;
      }
      remaining -= length;
    }
    const range = document.createRange();
    if (target) range.setStart(target, targetOffset);
    else range.selectNodeContents(lineNode), range.collapse(false);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const render = (caret) => {
    root.replaceChildren(
      ...lines.map((line) => {
        const node = document.createElement("div");
        node.className = LINE;
        node.innerHTML = decorateLine(line);
        return node;
      }),
    );
    root.dataset.empty = String(lines.length === 1 && lines[0] === "");
    placeCaret(caret);
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
  root.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (onSubmit) onSubmit(getValue());
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      // Перенос строки контролируем сами: браузер иначе вставит свои <div>
      // и модель строк перестанет совпадать с разметкой.
      event.preventDefault();
      const caret = readCaret() || { line: lines.length - 1, offset: lines[lines.length - 1].length };
      const current = lines[caret.line] ?? "";
      lines.splice(caret.line, 1, current.slice(0, caret.offset), current.slice(caret.offset));
      render({ line: caret.line + 1, offset: 0 });
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
    setPlaceholder: (text) => {
      root.dataset.placeholder = text;
    },
    setDisabled: (disabled) => {
      root.contentEditable = disabled ? "false" : "true";
      root.dataset.disabled = String(Boolean(disabled));
    },
  };
}
