import { t, localizedBuiltins } from "./browser-i18n.js";
// Панель оформления выделенного текста — как в Notion: появляется над
// выделением в любом живом поле. Кнопки не меняют модель поля напрямую — они
// переписывают строки текстом с маркерами Markdown, а цвет ставят
// pandoc-овским span-ом ([текст]{.red}). Поэтому оформление читается и в
// сыром виде, а сама панель ничего не знает об отрисовке поля.
import { COLOR_NAMES } from "./markdown-live.js";

export const INLINE_MARKS = {
  bold: { open: "**", close: "**", get label() { return t("Ж"); }, get title() { return t("Жирный · ⌘B"); } },
  italic: { open: "*", close: "*", get label() { return t("К"); }, get title() { return t("Курсив · ⌘I"); } },
  underline: { open: "++", close: "++", get label() { return t("Ч"); }, get title() { return t("Подчёркнутый · ⌘U"); } },
  strike: { open: "~~", close: "~~", label: "S", get title() { return t("Зачёркнутый · ⌘⇧S"); } },
  code: { open: "`", close: "`", label: "<>", get title() { return t("Код · ⌘E"); } },
  highlight: { open: "==", close: "==", label: "▮", get title() { return t("Маркер · ⌘⇧H"); } },
};

export const COLOR_LABELS = {
  get gray() { return t("Серый"); }, get brown() { return t("Коричневый"); }, get orange() { return t("Оранжевый"); }, get yellow() { return t("Жёлтый"); }, get green() { return t("Зелёный"); },
  get blue() { return t("Синий"); }, get purple() { return t("Фиолетовый"); }, get pink() { return t("Розовый"); }, get red() { return t("Красный"); },
};

export const BLOCK_KINDS = localizedBuiltins([
  { id: "text", get label() { return "Текст"; }, prefix: "" },
  { id: "h1", get label() { return "Заголовок 1"; }, prefix: "# " },
  { id: "h2", get label() { return "Заголовок 2"; }, prefix: "## " },
  { id: "h3", get label() { return "Заголовок 3"; }, prefix: "### " },
  { id: "bullet", get label() { return "Список"; }, prefix: "- " },
  { id: "ordered", get label() { return "Нумерованный"; }, prefix: "1. " },
  { id: "task", get label() { return "Задача"; }, prefix: "- [ ] " },
  { id: "quote", get label() { return "Цитата"; }, prefix: "> " },
]);

export const FONT_OPTIONS = localizedBuiltins([
  { id: "default", get label() { return "Обычный"; } },
  { id: "serif", get label() { return "С засечками"; } },
  { id: "mono", get label() { return "Моноширинный"; } },
]);
export const SIZE_OPTIONS = localizedBuiltins([
  { id: "normal", get label() { return "Обычный"; } },
  { id: "small", get label() { return "Мелкий"; } },
]);

const BLOCK_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX/-]\]\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s?)/;

// Пробелы по краям выделения остаются снаружи маркеров: `** текст **` не
// оформляется ни здесь, ни в Markdown вообще.
function trimmedBounds(line, from, to) {
  const selected = line.slice(from, to);
  const lead = selected.match(/^\s*/)[0].length;
  const trail = selected.match(/\s*$/)[0].length;
  return { from: from + lead, to: Math.max(from + lead, to - trail) };
}

// Обернуть или снять парный маркер. Возвращает новую строку и границы
// выделения — сам текст, без маркеров.
export function toggleWrap(line, from, to, open, close = open) {
  ({ from, to } = trimmedBounds(line, from, to));
  const selected = line.slice(from, to);
  if (!selected) return { line, from, to };
  // Маркеры уже стоят вокруг выделения — снимаем.
  if (line.slice(from - open.length, from) === open && line.slice(to, to + close.length) === close) {
    return {
      line: line.slice(0, from - open.length) + selected + line.slice(to + close.length),
      from: from - open.length,
      to: to - open.length,
    };
  }
  // Выделение захватило маркеры целиком — тоже снимаем.
  if (selected.length > open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return { line: line.slice(0, from) + inner + line.slice(to), from, to: from + inner.length };
  }
  return {
    line: line.slice(0, from) + open + selected + close + line.slice(to),
    from: from + open.length,
    to: to + open.length,
  };
}

const colorSuffix = (name) => `]{.${name}}`;
const COLOR_AROUND = /\]\{\.((?:bg-)?[a-z]+)\}/y;

// Цвет: [текст]{.имя}. Тот же цвет снимает, другой — заменяет, null — снимает.
export function applyColor(line, from, to, name) {
  ({ from, to } = trimmedBounds(line, from, to));
  const selected = line.slice(from, to);
  if (!selected) return { line, from, to };
  COLOR_AROUND.lastIndex = to;
  const after = COLOR_AROUND.exec(line);
  const wrapped = line[from - 1] === "[" && after && !selected.includes("[") && !selected.includes("]");
  if (wrapped) {
    const current = after[1];
    const head = line.slice(0, from - 1), tail = line.slice(to + after[0].length);
    const next = name && name !== current ? name : null;
    return next
      ? { line: `${head}[${selected}${colorSuffix(next)}${tail}`, from, to }
      : { line: `${head}${selected}${tail}`, from: from - 1, to: to - 1 };
  }
  const whole = selected.match(/^\[([^\[\]]+)\]\{\.((?:bg-)?[a-z]+)\}$/);
  if (whole) {
    const [, inner, current] = whole;
    const next = name && name !== current ? name : null;
    return next
      ? { line: `${line.slice(0, from)}[${inner}${colorSuffix(next)}${line.slice(to)}`, from: from + 1, to: from + 1 + inner.length }
      : { line: `${line.slice(0, from)}${inner}${line.slice(to)}`, from, to: from + inner.length };
  }
  if (!name) return { line, from, to };
  return { line: `${line.slice(0, from)}[${selected}${colorSuffix(name)}${line.slice(to)}`, from: from + 1, to: to + 1 };
}

export function blockKindOf(line) {
  const match = line.match(BLOCK_PREFIX);
  if (!match) return "text";
  const prefix = match[2];
  if (/^#+/.test(prefix)) return `h${Math.min(3, prefix.trim().length)}`;
  if (/^[-*+]\s+\[/.test(prefix)) return "task";
  if (/^[-*+]/.test(prefix)) return "bullet";
  if (/^\d/.test(prefix)) return "ordered";
  return "quote";
}

// Сменить блок строки: старый префикс снимается, отступ остаётся.
export function turnInto(line, kind) {
  const target = BLOCK_KINDS.find((item) => item.id === kind);
  if (!target) return line;
  const match = line.match(BLOCK_PREFIX);
  const indent = match ? match[1] : line.match(/^\s*/)[0];
  const rest = match ? line.slice(match[0].length) : line.slice(indent.length);
  return `${indent}${target.prefix}${rest}`;
}

// Границы выделения по строкам: на каждой — свой кусок.
function pieces(range, lines) {
  const result = [];
  for (let index = range.from.line; index <= range.to.line; index += 1) {
    const from = index === range.from.line ? range.from.offset : 0;
    const to = index === range.to.line ? range.to.offset : (lines[index] ?? "").length;
    result.push({ index, from, to });
  }
  return result;
}

export function attachFormatToolbar(field, { document: doc = document, prefs = null } = {}) {
  const root = field.element;
  const bar = doc.createElement("div");
  bar.className = "fmt-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("Оформление текста"));
  bar.hidden = true;
  doc.body.append(bar);
  // Как и меню разметки: внутри <dialog> элемент из body не виден — панель
  // переезжает в диалог перед показом.
  const mount = () => {
    const host = root.closest("dialog") ?? doc.body;
    if (bar.parentNode !== host) host.append(bar);
  };

  let openMenu = null;
  const closeMenu = () => {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    for (const trigger of bar.querySelectorAll("[aria-expanded]")) trigger.setAttribute("aria-expanded", "false");
  };

  // Нажатие, а не клик: клик уводит фокус из поля, и выделение пропадает.
  const press = (element, run) => {
    element.addEventListener("mousedown", (event) => {
      event.preventDefault();
      run(event);
    });
  };
  const button = (label, title, run, className = "") => {
    const element = doc.createElement("button");
    element.type = "button";
    element.className = `fmt-button ${className}`.trim();
    element.textContent = label;
    element.title = title;
    element.setAttribute("aria-label", title);
    press(element, run);
    return element;
  };

  // Применить преобразование к каждой строке выделения; выделение остаётся на
  // тексте, чтобы следующая кнопка работала с ним же.
  const apply = (transform) => {
    const range = field.selection();
    if (!range) return;
    const lines = field.lines();
    let first = null, last = null;
    for (const piece of pieces(range, lines)) {
      if (piece.from === piece.to) continue;
      const result = transform(lines[piece.index], piece.from, piece.to);
      lines[piece.index] = result.line;
      if (!first) first = { line: piece.index, offset: result.from };
      last = { line: piece.index, offset: result.to };
    }
    if (!first) return;
    field.setLines(lines, { from: first, to: last });
  };
  const applyBlock = (kind) => {
    const range = field.selection() || (field.caret() && { from: field.caret(), to: field.caret() });
    if (!range) return;
    const lines = field.lines();
    const shifts = [];
    for (let index = range.from.line; index <= range.to.line; index += 1) {
      const before = lines[index].length;
      lines[index] = turnInto(lines[index], kind);
      shifts[index] = lines[index].length - before;
    }
    const clamp = (position) => ({ line: position.line, offset: Math.max(0, position.offset + (shifts[position.line] || 0)) });
    field.setLines(lines, { from: clamp(range.from), to: clamp(range.to) });
  };
  const wrap = (mark) => apply((line, from, to) => toggleWrap(line, from, to, mark.open, mark.close));
  const color = (name) => apply((line, from, to) => applyColor(line, from, to, name));
  const link = () => {
    const range = field.selection();
    if (!range || range.from.line !== range.to.line) return;
    const url = window.prompt(t("Адрес ссылки"), "https://");
    if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) return;
    apply((line, from, to) => {
      const text = line.slice(from, to);
      const next = `[${text}](${url.trim()})`;
      return { line: line.slice(0, from) + next + line.slice(to), from: from + 1, to: from + 1 + text.length };
    });
  };

  const menu = (trigger, build) => {
    press(trigger, () => {
      if (openMenu?.dataset.owner === trigger.dataset.menu) return closeMenu();
      closeMenu();
      const panel = doc.createElement("div");
      panel.className = "fmt-menu";
      panel.dataset.owner = trigger.dataset.menu;
      panel.setAttribute("role", "menu");
      build(panel);
      trigger.setAttribute("aria-expanded", "true");
      trigger.after(panel);
      openMenu = panel;
      // Меню не должно уезжать за правый край окна.
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) panel.style.left = `${Math.max(-trigger.offsetLeft, window.innerWidth - 8 - rect.right)}px`;
    });
  };
  const item = (label, run, { active = false, swatch = null } = {}) => {
    const element = doc.createElement("button");
    element.type = "button";
    element.className = `fmt-item${active ? " is-on" : ""}`;
    element.setAttribute("role", "menuitem");
    if (swatch) {
      const dot = doc.createElement("span");
      dot.className = `fmt-swatch md-color-${swatch}`;
      dot.setAttribute("aria-hidden", "true");
      element.append(dot);
    }
    element.append(doc.createTextNode(label));
    press(element, () => {
      closeMenu();
      run();
    });
    return element;
  };
  const head = (text) => {
    const element = doc.createElement("p");
    element.className = "fmt-head";
    element.textContent = text;
    return element;
  };

  // «Превратить в» — блок текущих строк.
  const blockTrigger = button(t("Текст"), t("Превратить в…"), () => {}, "fmt-trigger");
  blockTrigger.dataset.menu = "block";
  blockTrigger.setAttribute("aria-haspopup", "menu");
  blockTrigger.setAttribute("aria-expanded", "false");
  menu(blockTrigger, (panel) => {
    const current = field.caret() ? blockKindOf(field.lineAt(field.caret().line)) : "text";
    panel.append(head(t("Превратить в")));
    for (const kind of BLOCK_KINDS) panel.append(item(kind.label, () => applyBlock(kind.id), { active: kind.id === current }));
  });

  const marks = Object.entries(INLINE_MARKS).map(([id, mark]) => {
    const element = button(mark.label, mark.title, () => wrap(mark), `fmt-${id}`);
    return element;
  });
  const linkButton = button(t("Ссылка"), t("Ссылка · ⌘K"), link, "fmt-link");

  const colorTrigger = button("A", t("Цвет текста и фона"), () => {}, "fmt-trigger fmt-color");
  colorTrigger.dataset.menu = "color";
  colorTrigger.setAttribute("aria-haspopup", "menu");
  colorTrigger.setAttribute("aria-expanded", "false");
  menu(colorTrigger, (panel) => {
    panel.classList.add("fmt-menu-colors");
    panel.append(head(t("Цвет")));
    panel.append(item(t("Без цвета"), () => color(null)));
    for (const name of COLOR_NAMES) panel.append(item(COLOR_LABELS[name], () => color(name), { swatch: name }));
    panel.append(head(t("Фон")));
    for (const name of COLOR_NAMES) panel.append(item(COLOR_LABELS[name], () => color(`bg-${name}`), { swatch: `bg-${name}` }));
  });

  const fontTrigger = button("Aa", t("Шрифт и размер текста"), () => {}, "fmt-trigger fmt-font");
  fontTrigger.dataset.menu = "font";
  fontTrigger.setAttribute("aria-haspopup", "menu");
  fontTrigger.setAttribute("aria-expanded", "false");
  menu(fontTrigger, (panel) => {
    const current = prefs?.read?.() || { font: "default", size: "normal" };
    panel.append(head(t("Шрифт")));
    for (const option of FONT_OPTIONS) panel.append(item(option.label, () => prefs?.set?.({ font: option.id }), { active: current.font === option.id }));
    panel.append(head(t("Размер")));
    for (const option of SIZE_OPTIONS) panel.append(item(option.label, () => prefs?.set?.({ size: option.id }), { active: current.size === option.id }));
  });

  const separator = () => {
    const element = doc.createElement("span");
    element.className = "fmt-sep";
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  bar.append(blockTrigger, separator(), ...marks, linkButton, separator(), colorTrigger);
  if (prefs) bar.append(fontTrigger);

  const shown = () => !bar.hidden;
  const hide = () => {
    if (!shown()) return;
    closeMenu();
    bar.hidden = true;
  };
  const place = (rect) => {
    const height = bar.offsetHeight || 36, width = bar.offsetWidth || 320;
    const above = rect.top - height - 8;
    bar.style.top = `${above >= 8 ? above : rect.bottom + 8}px`;
    bar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
  };
  const show = () => {
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return hide();
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return hide();
    mount();
    bar.hidden = false;
    // Подпись «Превратить в» показывает текущий блок строки с кареткой.
    const caret = field.caret();
    const kind = BLOCK_KINDS.find((entry) => entry.id === (caret ? blockKindOf(field.lineAt(caret.line)) : "text"));
    blockTrigger.textContent = kind?.label ?? t("Текст");
    place(rect);
  };

  let frame = 0;
  const onSelectionChange = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!root.isConnected) return;
      const selection = doc.getSelection();
      const inside = selection && selection.rangeCount && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode);
      if (inside) show();
      else if (!openMenu) hide();
    });
  };
  doc.addEventListener("selectionchange", onSelectionChange);
  const onScroll = () => { if (shown()) hide(); };
  window.addEventListener("scroll", onScroll, true);

  // Горячие клавиши — как в Notion; без выделения маркеры ставятся вокруг
  // каретки, чтобы дальше печатать уже оформленным.
  const onKeydown = (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier || event.altKey) return;
    const key = event.key.toLowerCase();
    let mark = null;
    if (!event.shiftKey && key === "b") mark = INLINE_MARKS.bold;
    else if (!event.shiftKey && key === "i") mark = INLINE_MARKS.italic;
    else if (!event.shiftKey && key === "u") mark = INLINE_MARKS.underline;
    else if (!event.shiftKey && key === "e") mark = INLINE_MARKS.code;
    else if (event.shiftKey && key === "s") mark = INLINE_MARKS.strike;
    else if (event.shiftKey && key === "h") mark = INLINE_MARKS.highlight;
    else if (!event.shiftKey && key === "k") { event.preventDefault(); link(); return; }
    else if (event.key === "Escape" && shown()) { hide(); return; }
    if (!mark) return;
    event.preventDefault();
    if (field.selection()) return wrap(mark);
    const caret = field.caret();
    if (!caret) return;
    field.replaceInLine(caret.line, caret.offset, caret.offset, mark.open + mark.close, mark.open.length);
  };
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("keydown", (event) => { if (event.key === "Escape" && shown()) { event.stopPropagation(); hide(); } });

  return {
    element: bar,
    hide,
    destroy() {
      cancelAnimationFrame(frame);
      doc.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      root.removeEventListener("keydown", onKeydown);
      bar.remove();
    },
  };
}
