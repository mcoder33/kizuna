// Раздел «Заметки»: страницы деревом, базы и ссылки — как в Notion, но каждая
// страница остаётся обычной записью журнала (сервер — server/notes-tree.js).
//
// Слева дерево: «Входящие», страницы и узлы проектов, базы. Справа — страница
// во весь экран: название, свойства, тело в том же живом поле, что и в
// карточке записи, страницы внутри, встроенные базы, кто ссылается сюда и кто
// упоминает название без ссылки. Строка «- [ ] …» отправляется на «Доску»
// кнопкой у строки и дальше живёт делом; строка показывает его состояние.
//
// Модуль не знает о приложении ничего, кроме того, что ему дали: запрос,
// тост и открытие карточки приходят из app.js при каждом переходе.
import { createMarkdownField } from "./markdown-live.js";
import { attachSlashMenu } from "./slash-menu.js";
import { attachFormatToolbar } from "./format-toolbar.js";
import { attachLinkMenu, forgetLinkPages } from "./link-menu.js";

const ZONE = "Europe/Samara";
const TYPE_NAMES = { note: "Заметка", idea_question: "Идея" };
const LAYOUTS = [["table", "Таблица"], ["gallery", "Галерея"], ["list", "Список"]];
const SORTS = [["created", "Сначала новые"], ["updated", "Недавно изменённые"], ["title", "По названию"]];
const DEFAULT_VIEW = { layout: "table", sort: "created", filter: { type: "all", project: null, tag: null, parent: null } };
const EXPANDED_KEY = "kizuna-notes-expanded";
// Свёрнутые блоки страницы — свойства, страницы внутри, ссылки — помнятся в
// браузере для всех страниц сразу: кому ссылки мешают, тому мешают везде.
const COLLAPSED_KEY = "kizuna-notes-collapsed";
const DEED_LINE = /^\s*[-*+]\s+\[ \]\s+\S/;
const DEED_ANCHOR = /(?:^|\s)\^(task-[0-9a-f]{8})\s*$/;

// Значки — тонкая линия в 16px, как у видов «Доски».
const ICONS = {
  page: '<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5M6 8h4.5M6 10.5h4.5"/>',
  idea: '<path d="M8 1.8a4.3 4.3 0 0 0-2.4 7.9c.5.4.8.9.8 1.5v.6h3.2v-.6c0-.6.3-1.1.8-1.5A4.3 4.3 0 0 0 8 1.8z"/><path d="M6.4 13.8h3.2"/>',
  project: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5z"/>',
  inbox: '<path d="M2 9.5 3.8 3h8.4L14 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1 1.8h3l1-1.8H14"/>',
  base: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M6.5 6v7.5"/>',
  all: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  caret: '<path d="M6 4l4 4-4 4"/>',
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 13.5 13.5"/>',
  card: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.3a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8.3"/>',
};

let deps = null;
let navToken = 0;
const state = {
  overview: null,
  route: null,
  detail: null,
  query: "",
  sideOpen: false,
  draft: null,
  focusTitle: false,
  expanded: readSet(EXPANDED_KEY),
  collapsed: readSet(COLLAPSED_KEY),
};
let editor = null;
let picker = null;

// ── мелочи ──────────────────────────────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name, extra = "") {
  const span = el("span", `notes-ico notes-ico-${name} ${extra}`.trim());
  span.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}
function button(text, className, onClick, { title } = {}) {
  const node = el("button", className, text);
  node.type = "button";
  if (title) { node.title = title; node.setAttribute("aria-label", title); }
  if (onClick) node.addEventListener("click", onClick);
  return node;
}
function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}
function saveExpanded() {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded].slice(-200))); } catch {}
}
// Сворачиваемый блок: заголовок — кнопка со стрелкой, содержимое прячет CSS
// по классу is-collapsed. Перерисовка блоку не нужна.
function foldToggle(key, text, count) {
  const toggle = button("", "notes-fold", (event) => {
    const block = event.currentTarget.closest("[data-fold]");
    if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed])); } catch {}
    const collapsed = state.collapsed.has(key);
    block?.classList.toggle("is-collapsed", collapsed);
    event.currentTarget.setAttribute("aria-expanded", String(!collapsed));
  });
  toggle.setAttribute("aria-expanded", String(!state.collapsed.has(key)));
  toggle.append(icon("caret", "notes-fold-caret"), el("span", "notes-fold-text", text));
  if (count !== undefined) toggle.append(el("span", "notes-section-count", String(count)));
  return toggle;
}
function foldable(block, key) {
  block.dataset.fold = key;
  block.classList.toggle("is-collapsed", state.collapsed.has(key));
  return block;
}
const zoneDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
function when(iso, { time = true } = {}) {
  if (!iso) return "";
  const date = new Date(iso);
  const clock = new Intl.DateTimeFormat("ru-RU", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" }).format(date);
  const today = zoneDay(new Date()), day = zoneDay(date);
  const yesterday = zoneDay(new Date(Date.now() - 86400000));
  if (day === today) return time ? `сегодня, ${clock}` : "сегодня";
  if (day === yesterday) return time ? `вчера, ${clock}` : "вчера";
  const short = new Intl.DateTimeFormat("ru-RU", { timeZone: ZONE, day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) }).format(date);
  return time ? `${short}, ${clock}` : short;
}
const plural = (count, one, few, many) => {
  const mod10 = count % 10, mod100 = count % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
};
const pageById = (id) => state.overview?.pages.find((page) => page.id === id) || null;
const typeIcon = (page) => (page?.type === "idea_question" ? "idea" : "page");
function hashFor(route) {
  const params = new URLSearchParams();
  if (route.kind === "page") params.set("page", route.id);
  else if (route.kind === "project") params.set("project", route.name);
  else if (route.kind === "base") params.set("base", route.id);
  else if (route.kind === "inbox") params.set("view", "inbox");
  else if (route.kind === "title") { params.set("title", route.title); if (route.from) params.set("from", route.from); }
  else params.set("view", "all");
  return `#notes?${params}`;
}
function go(route) {
  const hash = hashFor(route);
  if (location.hash === hash) navigate(route);
  else location.hash = hash;
}
function placeLabel(key) {
  if (key === null || key === undefined) return "Корень";
  if (key === "inbox") return "Входящие";
  if (key.startsWith("project:")) return key.slice(8);
  return pageById(key)?.title || "Страница";
}
async function call(url, method = "GET", body) {
  return deps.request(url, body === undefined ? { method } : { method, body: JSON.stringify(body) });
}

// ── вход из app.js ──────────────────────────────────────────────────────────
function routeFrom(params) {
  if (params.get("page")) return { kind: "page", id: params.get("page") };
  if (params.get("project")) return { kind: "project", name: params.get("project") };
  if (params.get("base")) return { kind: "base", id: params.get("base") };
  if (params.get("title")) return { kind: "title", title: params.get("title"), from: params.get("from") };
  if (params.get("view") === "inbox") return { kind: "inbox" };
  return { kind: "all" };
}
export function openNotes(params, provided) {
  deps = provided;
  state.sideOpen = false;
  hookPage();
  navigate(routeFrom(params));
}
// Высота шапки приложения разная: на телефоне разделы уходят второй строкой.
// Дерево и полоса над страницей прилипают прямо под ней, поэтому высота
// меряется, а не угадывается. Там же — закрытие выезжающего дерева кликом мимо.
let pageHooked = false;
function hookPage() {
  syncTop();
  if (pageHooked) return;
  pageHooked = true;
  addEventListener("resize", syncTop);
  document.addEventListener("pointerdown", (event) => {
    if (!state.sideOpen) return;
    const side = document.getElementById("notes-side");
    if (side?.contains(event.target) || event.target.closest?.(".notes-side-toggle")) return;
    state.sideOpen = false;
    document.querySelector(".notes-shell")?.classList.remove("side-open");
  });
}
function syncTop() {
  const header = document.querySelector("body > header") || document.querySelector("header");
  const height = header ? Math.round(header.getBoundingClientRect().height) : 73;
  document.getElementById("notes")?.style.setProperty("--notes-top", `${height}px`);
}
// Журнал поменялся (запись, правка в карточке, дело закрыли на «Доске»):
// перечитываем дерево и открытую страницу, не трогая набираемый текст.
export async function refreshNotes() {
  if (!deps || !state.route || document.getElementById("notes")?.hidden) return;
  try {
    await loadOverview();
  } catch { return; }
  if (state.route.kind === "page") {
    // Страницу удалили или сделали делом — показываем это, а не старую копию.
    // Сбой сети — не повод объявлять страницу пропавшей.
    try { await loadDetail(state.route.id); }
    catch (error) { if (/не найдена/i.test(error.message)) state.detail = null; else return; }
  }
  renderSide();
  renderMain({ quiet: true });
}

async function navigate(route) {
  const token = ++navToken;
  closePicker();
  await saveEditor();
  try {
    if (route.kind === "title") {
      const base = state.overview?.bases.find((item) => item.name.toLocaleLowerCase("ru-RU") === route.title.trim().toLocaleLowerCase("ru-RU"));
      if (base) route = { kind: "base", id: base.id };
      else {
        const { id } = await call(`/api/pages/resolve?${new URLSearchParams({ title: route.title, ...(route.from ? { from: route.from } : {}) })}`);
        if (id) route = { kind: "page", id };
        else route = { kind: "missing", title: route.title, from: route.from };
      }
      if (route.kind !== "missing") history.replaceState(null, "", hashFor(route));
    }
    await loadOverview();
    if (route.kind === "page") await loadDetail(route.id);
  } catch (error) {
    if (token !== navToken) return;
    if (route.kind === "page") state.detail = null;
    else deps.toast(error.message);
  }
  if (token !== navToken) return;
  if (state.route?.kind !== route.kind || state.route?.id !== route.id) state.draft = null;
  state.route = route;
  // Страница открыта — её родители в дереве раскрыты: видно, где она лежит.
  if (route.kind === "page" && state.detail) {
    for (const step of state.detail.trail) state.expanded.add(step.key);
    saveExpanded();
  }
  renderSide();
  renderMain();
  document.getElementById("notes-main")?.scrollTo?.(0, 0);
}
async function loadOverview() {
  state.overview = await call("/api/pages");
}
async function loadDetail(id) {
  state.detail = await call(`/api/pages/${encodeURIComponent(id)}`);
}

// ── дерево ─────────────────────────────────────────────────────────────────
// Порядок рядом — как его поставили перетаскиванием; остальные страницы идут
// следом по времени записи (так же сортирует сервер).
const bySiblingOrder = (left, right) =>
  (left.position == null) - (right.position == null)
  || (left.position ?? 0) - (right.position ?? 0)
  || left.createdAt.localeCompare(right.createdAt);
function childrenOf(key) {
  return state.overview.pages.filter((page) => page.parentKey === key).sort(bySiblingOrder);
}
function activeKey() {
  const route = state.route;
  if (!route) return null;
  if (route.kind === "page") return route.id;
  if (route.kind === "project") return `project:${route.name}`;
  if (route.kind === "base") return `base:${route.id}`;
  return route.kind;
}
function treeRow({ key, title, iconName, href, depth, count = 0, hasChildren = false, addParent = null, kind = null }) {
  const row = el("div", "notes-row");
  row.dataset.key = key;
  row.setAttribute("role", "treeitem");
  row.style.setProperty("--depth", depth);
  if (activeKey() === key) row.classList.add("is-active");
  const open = state.expanded.has(key);
  if (hasChildren) row.setAttribute("aria-expanded", String(open));
  const caret = button("", `notes-caret${hasChildren ? "" : " is-empty"}${open ? " is-open" : ""}`, (event) => {
    event.preventDefault();
    if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
    saveExpanded();
    renderSide();
  }, { title: open ? "Свернуть" : "Развернуть" });
  caret.append(icon("caret"));
  if (!hasChildren) caret.tabIndex = -1;
  const link = el("a", "notes-link");
  link.href = href;
  link.append(icon(iconName), el("span", "notes-link-title", title));
  row.append(caret, link);
  if (kind === "page") { link.draggable = false; draggablePage(row, key); }
  if (kind === "page" || kind === "project") dropTarget(row, kind, key);
  if (count) row.append(el("span", "notes-count", String(count)));
  if (addParent !== null) {
    const add = button("", "notes-row-add", (event) => { event.preventDefault(); newPage(addParent); }, { title: "Страница внутри" });
    add.append(icon("plus"));
    row.append(add);
  }
  return row;
}
function treeNode(item, depth, parentList) {
  const kids = childrenOf(item.key);
  parentList.append(treeRow({ ...item, depth, hasChildren: kids.length > 0, count: item.count ?? 0 }));
  if (!kids.length || !state.expanded.has(item.key)) return;
  const group = el("div", "notes-group");
  group.setAttribute("role", "group");
  for (const page of kids) treeNode({ key: page.id, title: page.title, iconName: typeIcon(page), href: hashFor({ kind: "page", id: page.id }), addParent: page.id, kind: "page" }, depth + 1, group);
  parentList.append(group);
}
function renderSide() {
  const side = document.getElementById("notes-side");
  if (!side || !state.overview) return;
  // Пока страницу тащат, дерево не перерисовывается: вместе со строкой пропал
  // бы и сам перенос. Фоновое обновление догонит после отпускания.
  if (drag) { drag.stale = true; return; }
  const searchHadFocus = document.activeElement?.id === "notes-search";
  side.replaceChildren();
  const search = el("label", "notes-search");
  const input = el("input");
  input.id = "notes-search";
  input.type = "search";
  input.placeholder = "Найти страницу";
  input.autocomplete = "off";
  input.value = state.query;
  input.addEventListener("input", () => { state.query = input.value; renderSide(); });
  search.append(icon("search"), input);
  side.append(search);

  const query = state.query.trim().toLocaleLowerCase("ru-RU");
  if (query) {
    const found = state.overview.pages.filter((page) => page.title.toLocaleLowerCase("ru-RU").includes(query) || page.excerpt.toLocaleLowerCase("ru-RU").includes(query)).slice(0, 40);
    const list = el("div", "notes-found");
    for (const page of found) {
      const link = el("a", "notes-found-row");
      link.href = hashFor({ kind: "page", id: page.id });
      link.append(icon(typeIcon(page)), el("span", "notes-found-title", page.title), el("span", "notes-found-where", placeLabel(page.parentKey)));
      list.append(link);
    }
    if (!found.length) list.append(el("p", "notes-empty", "Ничего не нашлось."));
    side.append(list);
  } else {
    const inboxCount = state.overview.pages.filter((page) => page.parentKey === "inbox").length;
    const top = el("div", "notes-tree");
    top.setAttribute("role", "tree");
    top.setAttribute("aria-label", "Разделы заметок");
    const inbox = treeRow({ key: "inbox", title: "Входящие", iconName: "inbox", href: hashFor({ kind: "inbox" }), depth: 0, count: inboxCount });
    if (inboxCount) inbox.querySelector(".notes-count").classList.add("is-hot");
    top.append(inbox);
    side.append(top);

    const pagesHead = el("div", "notes-side-head");
    pagesHead.append(el("span", undefined, "Страницы"));
    const addRoot = button("", "notes-side-add", () => newPage("root"), { title: "Новая страница" });
    addRoot.append(icon("plus"));
    pagesHead.append(addRoot);
    // Заголовок «Страницы» — корень: брошенная на него страница встаёт наверх.
    dropTarget(pagesHead, "root", null);
    side.append(pagesHead);
    const tree = el("div", "notes-tree");
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Страницы");
    // Узлы проектов — первыми: это полки, на которых лежат заметки по делу.
    for (const project of state.overview.projects)
      treeNode({ key: `project:${project.name}`, title: project.name, iconName: "project", href: hashFor({ kind: "project", name: project.name }), addParent: `project:${project.name}`, kind: "project" }, 0, tree);
    for (const page of childrenOf(null))
      treeNode({ key: page.id, title: page.title, iconName: typeIcon(page), href: hashFor({ kind: "page", id: page.id }), addParent: page.id, kind: "page" }, 0, tree);
    if (!state.overview.projects.length && !childrenOf(null).length)
      tree.append(el("p", "notes-empty", "Страниц пока нет. «+» заводит новую, а заметки с «Сегодня» появятся сами."));
    side.append(tree);

    const basesHead = el("div", "notes-side-head");
    basesHead.append(el("span", undefined, "Базы"));
    const addBase = button("", "notes-side-add", () => newBase(), { title: "Новая база" });
    addBase.append(icon("plus"));
    basesHead.append(addBase);
    side.append(basesHead);
    const bases = el("div", "notes-tree");
    bases.append(treeRow({ key: "all", title: "Все заметки", iconName: "all", href: hashFor({ kind: "all" }), depth: 0 }));
    for (const base of state.overview.bases)
      bases.append(treeRow({ key: `base:${base.id}`, title: base.name, iconName: "base", href: hashFor({ kind: "base", id: base.id }), depth: 0 }));
    side.append(bases);
  }
  if (searchHadFocus) {
    const again = document.getElementById("notes-search");
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  }
}

// ── перетаскивание в дереве ────────────────────────────────────────────────
// Как в Notion: на середину строки — внутрь страницы или проекта, к верхнему
// или нижнему краю — рядом, перед или после. На заголовок «Страницы» — в
// корень. Внутрь самой себя и своих потомков страницу не бросить: такие места
// просто не подсвечиваются.
const DRAG_TYPE = "application/x-kizuna-page";
let drag = null;
function draggablePage(node, pageId) {
  node.draggable = true;
  node.addEventListener("dragstart", (event) => {
    if (event.target.closest?.("button, input, select")) return;
    drag = { id: pageId, stale: false };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, pageId);
    event.dataTransfer.setData("text/plain", pageById(pageId)?.title || "");
    node.classList.add("is-dragging");
  });
  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
    finishDrag();
  });
}
function finishDrag() {
  const stale = drag?.stale;
  drag = null;
  markDrop(null);
  if (stale) renderSide();
}
function markDrop(target, zone = null) {
  for (const node of document.querySelectorAll(".drop-before, .drop-after, .drop-inside"))
    if (node !== target || !node.classList.contains(`drop-${zone}`)) node.classList.remove("drop-before", "drop-after", "drop-inside");
  if (target && zone) target.classList.add(`drop-${zone}`);
}
function dropZone(target, event, kind) {
  if (kind !== "page") return "inside";
  const rect = target.getBoundingClientRect();
  const share = (event.clientY - rect.top) / rect.height;
  return share < 0.3 ? "before" : share > 0.7 ? "after" : "inside";
}
function dropAllowed(pageId, kind, key, zone) {
  if (kind !== "page") return true;
  if (key === pageId) return false;
  const blocked = descendantsOf(pageId);
  if (zone === "inside") return !blocked.has(key);
  const parent = pageById(key)?.parentKey;
  return !(parent && blocked.has(parent));
}
function dropTarget(target, kind, key) {
  target.addEventListener("dragover", (event) => {
    if (!drag) return;
    const zone = dropZone(target, event, kind);
    if (!dropAllowed(drag.id, kind, key, zone)) { markDrop(null); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    markDrop(target, zone);
  });
  target.addEventListener("dragleave", (event) => {
    if (!target.contains(event.relatedTarget)) target.classList.remove("drop-before", "drop-after", "drop-inside");
  });
  target.addEventListener("drop", (event) => {
    if (!drag) return;
    const zone = dropZone(target, event, kind);
    if (!dropAllowed(drag.id, kind, key, zone)) return;
    event.preventDefault();
    const pageId = drag.id;
    finishDrag();
    dropPage(pageId, kind, key, zone);
  });
}
async function dropPage(pageId, kind, key, zone) {
  const page = pageById(pageId);
  if (!page) return;
  // Куда: ключ места в дереве (null — корень) и страница, рядом с которой встать.
  let parentKey = null, beside = null;
  if (kind === "page" && zone !== "inside") { parentKey = pageById(key)?.parentKey ?? null; beside = key; }
  else if (kind === "page" || kind === "project") parentKey = key;
  const order = childrenOf(parentKey).map((item) => item.id).filter((id) => id !== pageId);
  let index = order.length;
  if (beside) index = order.indexOf(beside) + (zone === "after" ? 1 : 0);
  order.splice(Math.max(0, index), 0, pageId);
  if (parentKey === page.parentKey && order.join() === childrenOf(parentKey).map((item) => item.id).join()) return;
  try {
    await saveEditor();
    if (parentKey?.startsWith("project:")) {
      const name = parentKey.slice(8);
      if (page.project !== name) await call(`/api/captures/${page.id}/corrections`, "POST", { project: name });
      await call(`/api/pages/${page.id}/place`, "PUT", { parent: "auto", order });
    } else {
      await call(`/api/pages/${page.id}/place`, "PUT", { parent: parentKey ?? "root", order });
    }
    forgetLinkPages();
    if (parentKey) { state.expanded.add(parentKey); saveExpanded(); }
    await loadOverview();
    if (state.route.kind === "page") await loadDetail(state.route.id);
    renderSide();
    renderMain({ quiet: true });
    if (parentKey !== page.parentKey) deps.toast(`«${page.title}» — ${parentKey ? `в «${placeLabel(parentKey)}»` : "в корне"}`);
  } catch (error) {
    deps.toast(error.message);
  }
}

// ── создание ───────────────────────────────────────────────────────────────
async function newPage(parent, title = "Без названия") {
  try {
    await saveEditor();
    const detail = await call("/api/pages", "POST", { title, parent });
    forgetLinkPages();
    if (parent && parent !== "root") { state.expanded.add(parent); saveExpanded(); }
    state.focusTitle = title === "Без названия";
    go({ kind: "page", id: detail.page.id });
  } catch (error) {
    deps.toast(error.message);
  }
}
async function newBase() {
  try {
    const { base } = await call("/api/pages/bases", "POST", { name: "Новая база", view: DEFAULT_VIEW });
    state.focusTitle = true;
    go({ kind: "base", id: base.id });
  } catch (error) {
    deps.toast(error.message);
  }
}

// ── основная область ───────────────────────────────────────────────────────
function mainShell() {
  const main = document.getElementById("notes-main");
  const bar = el("div", "notes-bar");
  const toggle = button("", "notes-side-toggle", () => {
    state.sideOpen = !state.sideOpen;
    document.querySelector(".notes-shell")?.classList.toggle("side-open", state.sideOpen);
  }, { title: "Страницы" });
  toggle.append(icon("menu"), el("span", undefined, "Страницы"));
  bar.append(toggle);
  // Не <nav>: у приложения на nav и nav a висят стили и логика шапки.
  const crumbs = el("div", "notes-crumbs");
  crumbs.setAttribute("role", "navigation");
  crumbs.setAttribute("aria-label", "Где лежит");
  bar.append(crumbs);
  const tail = el("div", "notes-bar-tail");
  bar.append(tail);
  return { main, bar, crumbs, tail };
}
function crumbLink(text, route, iconName) {
  const link = el("a", "notes-crumb");
  link.href = hashFor(route);
  if (iconName) link.append(icon(iconName));
  link.append(el("span", undefined, text));
  return link;
}
function renderMain({ quiet = false } = {}) {
  const main = document.getElementById("notes-main");
  if (!main || !state.overview || !state.route) return;
  document.querySelector(".notes-shell")?.classList.toggle("side-open", state.sideOpen);
  const route = state.route;
  if (route.kind === "page") return renderPage({ quiet });
  if (editor) destroyEditor();
  if (quiet && route.kind === "base" && document.activeElement?.closest?.(".notes-main")) return;
  if (route.kind === "project") return renderProject();
  if (route.kind === "inbox") return renderInbox();
  if (route.kind === "missing") return renderMissing();
  return renderBase();
}

// ── страница ───────────────────────────────────────────────────────────────
function renderPage({ quiet }) {
  const detail = state.detail;
  const { main, bar, crumbs, tail } = mainShell();
  if (!detail || detail.page.id !== state.route.id) {
    if (editor) destroyEditor();
    const sheet = el("article", "notes-sheet");
    sheet.append(el("h1", "notes-title is-static", "Страница не найдена"), el("p", "notes-lead", "Её удалили или она стала делом — дела живут на «Доске»."));
    main.replaceChildren(bar, sheet);
    return;
  }
  const { page } = detail;
  // Фоновое обновление (сохранили текст, закрыли дело на «Доске») не
  // пересобирает страницу: перенос поля в новый лист снял бы с него фокус и
  // каретку посреди набора. Меняется только то, что вокруг поля.
  const current = main.querySelector(`.notes-sheet[data-page="${CSS.escape(page.id)}"]`);
  if (quiet && current && editor?.pageId === page.id) {
    main.querySelector(".notes-bar")?.replaceWith(bar);
    const title = current.querySelector(".notes-title");
    if (title && document.activeElement !== title) title.textContent = page.title;
    current.querySelector(".notes-props-block")?.replaceWith(propsBlock(detail));
    current.querySelector('[data-part="suggest"]')?.replaceWith(suggestBlock(detail));
    current.querySelector(".notes-after")?.replaceWith(afterBlock(detail));
    fillBar(detail, crumbs, tail);
    editorFor(page);
    decorateDeeds();
    return;
  }

  fillBar(detail, crumbs, tail);
  const sheet = el("article", "notes-sheet");
  sheet.dataset.page = page.id;
  const head = el("div", "notes-head");
  head.append(icon(typeIcon(page), "notes-head-ico"));
  const title = el("h1", "notes-title", page.title);
  title.contentEditable = "true";
  title.spellcheck = true;
  title.setAttribute("role", "textbox");
  title.setAttribute("aria-label", "Название страницы");
  title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); title.blur(); editor?.field.focus(); }
    if (event.key === "Escape") { title.textContent = page.title; title.blur(); }
  });
  title.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, (event.clipboardData?.getData("text/plain") || "").replace(/\s+/g, " "));
  });
  title.addEventListener("blur", () => renamePage(page, title));
  head.append(title);
  sheet.append(head, propsBlock(detail), suggestBlock(detail), editorFor(page), afterBlock(detail));
  main.replaceChildren(bar, sheet);
  decorateDeeds();
  if (state.focusTitle) {
    state.focusTitle = false;
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
function fillBar(detail, crumbs, tail) {
  const { page } = detail;
  for (const [index, step] of detail.trail.entries()) {
    if (index) crumbs.append(el("span", "notes-crumb-sep", "/"));
    const route = step.key === "inbox" ? { kind: "inbox" } : step.key.startsWith("project:") ? { kind: "project", name: step.title } : { kind: "page", id: step.key };
    crumbs.append(crumbLink(step.title, route, step.key === "inbox" ? "inbox" : step.key.startsWith("project:") ? "project" : step.type === "idea_question" ? "idea" : "page"));
  }
  if (detail.trail.length) crumbs.append(el("span", "notes-crumb-sep", "/"));
  crumbs.append(el("span", "notes-crumb is-current", page.title));
  const version = el("span", "notes-version");
  version.id = "notes-version";
  version.textContent = versionLabel(page);
  const open = button("", "notes-bar-button", () => deps.openCard(page.id), { title: "Открыть карточку: обсуждение, вложения, источник" });
  open.append(icon("card"), el("span", undefined, "Карточка"));
  const remove = button("", "notes-bar-button is-danger", () => deletePage(detail), { title: "Удалить страницу — вернуть можно из уведомления" });
  remove.append(icon("trash"), el("span", undefined, "Удалить"));
  tail.append(version, open, remove);
}
// Удаление — как у записи в карточке: сразу и с «Вернуть» в уведомлении, без
// вопроса заранее. Страница — это запись журнала, поэтому и возвращается она
// целиком: с текстом, местом в дереве и ссылками. Страницы внутри не пропадают —
// сервер ставит их туда, куда их положило бы правило: в проект или во «Входящие».
async function deletePage(detail) {
  const { page } = detail;
  // Набранное перед удалением сохраняется: вернуть — значит вернуть и его.
  await saveEditor();
  try {
    await call(`/api/captures/${encodeURIComponent(page.id)}`, "DELETE");
  } catch (error) {
    deps.toast(error.message);
    return;
  }
  const up = detail.trail.at(-1);
  go(!up ? { kind: "all" } : up.key === "inbox" ? { kind: "inbox" } : up.key.startsWith("project:") ? { kind: "project", name: up.title } : { kind: "page", id: up.key });
  deps.toast(`Страница «${page.title}» удалена`, { label: "Вернуть", run: async () => {
    try {
      await call(`/api/captures/${encodeURIComponent(page.id)}/restore`, "POST");
      go({ kind: "page", id: page.id });
      deps.toast("Страница возвращена");
    } catch (error) { deps.toast(error.message); }
  } });
}
function versionLabel(page) {
  return `изменено ${when(page.updatedAt)}${page.noteVersion ? ` · версия ${page.noteVersion}` : ""}`;
}
async function renamePage(page, title) {
  const next = title.textContent.replace(/\s+/g, " ").trim();
  if (!next) { title.textContent = page.title; return; }
  if (next === page.title) return;
  try {
    await call(`/api/captures/${page.id}/corrections`, "POST", { summary: next });
    forgetLinkPages();
    page.title = next;
    await loadOverview();
    renderSide();
    const current = document.querySelector(".notes-crumb.is-current");
    if (current) current.textContent = next;
  } catch (error) {
    title.textContent = page.title;
    deps.toast(error.message);
  }
}
function propRow(list, label, value) {
  list.append(el("dt", undefined, label));
  const dd = el("dd");
  if (value instanceof Node) dd.append(value); else dd.textContent = value;
  list.append(dd);
  return dd;
}
function propsBlock(detail) {
  const { page } = detail;
  const block = foldable(el("div", "notes-props-block"), "props");
  const list = el("dl", "notes-props");
  const where = detail.trail.map((step) => step.title).join(" / ") || "Корень";
  // Свёрнутые свойства не пропадают совсем: строка кнопки говорит главное —
  // где лежит, проект и тип.
  const toggle = foldToggle("props", "Свойства");
  toggle.append(el("span", "notes-props-summary", [...new Set([where, page.project, TYPE_NAMES[page.type]].filter(Boolean))].join(" · ")));
  block.append(toggle, list);
  const place = button("", "notes-prop-button", (event) => openPicker(event.currentTarget, page));
  place.append(el("span", undefined, where));
  const placeRow = propRow(list, "Место", place);
  const origin = page.parentKey === "inbox" ? "не разложено" : page.placed ? (detail.page.placeSource === "text" ? "из текста" : "указано") : page.parentKey?.startsWith("project:") ? "по проекту" : "";
  if (origin) placeRow.append(el("span", `notes-prov${page.parentKey === "inbox" ? " is-loose" : ""}`, origin));
  if (page.project) {
    const link = el("a", "notes-prop-link", page.project);
    link.href = hashFor({ kind: "project", name: page.project });
    propRow(list, "Проект", link);
  } else propRow(list, "Проект", el("span", "notes-ghost", "—"));
  const type = el("select", "notes-prop-select");
  type.setAttribute("aria-label", "Тип страницы");
  for (const [value, name] of Object.entries(TYPE_NAMES)) {
    const option = el("option", undefined, name);
    option.value = value;
    option.selected = page.type === value;
    type.append(option);
  }
  type.addEventListener("change", async () => {
    try {
      await call(`/api/captures/${page.id}/corrections`, "POST", { primaryType: type.value });
      await loadOverview();
      await loadDetail(page.id);
      renderSide();
      renderMain();
    } catch (error) { deps.toast(error.message); }
  });
  propRow(list, "Тип", type);
  if (page.tags.length) {
    const tags = el("span", "notes-tags");
    for (const tag of page.tags) tags.append(el("span", "notes-tag", `#${tag}`));
    propRow(list, "Теги", tags);
  }
  propRow(list, "Записано", when(page.createdAt));
  return block;
}
function suggestBlock(detail) {
  const { page } = detail;
  const wrap = el("div");
  wrap.dataset.part = "suggest";
  if (page.parentKey !== "inbox") return wrap;
  wrap.className = "notes-suggest";
  const text = el("p", "notes-suggest-text");
  if (detail.suggest) {
    text.append("Похоже, это про ", el("b", undefined, `«${detail.suggest.title}»`), ". Положить туда?");
    wrap.append(text, button("Положить", "notes-act is-primary", () => applyPlace(page, detail.suggest.key)));
  } else {
    text.textContent = "Заметка во «Входящих»: места для неё пока не нашлось.";
    wrap.append(text);
  }
  wrap.append(
    button("Выбрать место", "notes-act", (event) => openPicker(event.currentTarget, page)),
    button("В корень", "notes-act", () => applyPlace(page, "root")),
  );
  return wrap;
}

// ── тело страницы ──────────────────────────────────────────────────────────
function editorFor(page) {
  if (editor && editor.pageId === page.id) {
    const current = editor.field.getValue();
    const dirty = current !== editor.saved;
    const focused = editor.field.element.contains(document.activeElement);
    // С сервера пришла другая версия (строку отметили на «Доске», упоминание
    // превратили в ссылку) — берём её, если здесь ничего не набрано.
    if (!dirty && !focused && page.body !== current) {
      editor.field.setValue(page.body);
      editor.saved = page.body;
    }
    return editor.wrap;
  }
  if (editor) destroyEditor();
  const wrap = el("div", "notes-editor");
  const field = createMarkdownField({
    id: "notes-editor-field",
    ariaLabel: "Текст страницы",
    placeholder: "Пишите. «/» — команды разметки, [[название]] — ссылка на страницу, «- [ ] …» — дело, которое можно отправить на «Доску».",
    onInput: () => { if (editor?.field === field) { scheduleSave(); decorateDeeds(); } },
    onSubmit: () => saveEditor(),
  });
  field.element.classList.add("notes-markdown");
  const slash = attachSlashMenu(field);
  const format = attachFormatToolbar(field, { prefs: window.pagentText });
  // После «[[» — страницы на выбор; новая страница из подсказки встаёт внутрь
  // этой, как подстраница в Notion.
  const links = attachLinkMenu(field, { exclude: () => page.id, parentFor: () => page.id });
  const deedButton = button("На доску →", "notes-deed-button", () => makeDeed(Number(deedButton.dataset.line)), { title: "Завести дело из этой строки" });
  deedButton.hidden = true;
  deedButton.addEventListener("mousedown", (event) => event.preventDefault());
  wrap.append(field.element, deedButton);
  editor = { pageId: page.id, field, wrap, slash, format, links, deedButton, saved: page.body, timer: 0, saving: null, again: false };
  field.setValue(page.body);
  editor.saved = page.body;

  field.element.addEventListener("blur", () => saveEditor());
  // Ссылка в готовом тексте ведёт на страницу; на строке с кареткой она —
  // просто текст, который правят.
  field.element.addEventListener("mousedown", (event) => {
    const link = event.target.closest?.(".md-wikilink");
    if (!link || event.button !== 0) return;
    const line = link.closest(".md-line");
    if (!line || line.classList.contains("is-current")) return;
    event.preventDefault();
    const label = link.textContent.split("|")[0].split("#")[0].trim();
    if (label) go({ kind: "title", title: label, from: page.id });
  });
  // Строка-дело: чекбокс закрывает и открывает само дело, а не только текст.
  field.element.addEventListener("click", (event) => {
    const box = event.target.closest?.(".md-checkbox");
    const line = box?.closest(".md-line");
    if (!box || !line?.classList.contains("is-deed")) return;
    const anchor = line.textContent.match(DEED_ANCHOR)?.[1];
    const deed = state.detail?.deeds.find((item) => item.anchor === anchor);
    if (!deed || !["open", "done"].includes(deed.state) || !deed.projectionIds.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      deps.toast(deed?.state === "pending" ? "Дело ещё разбирается — через пару секунд его можно будет закрыть" : "Это дело закрывается на «Доске»");
      return;
    }
    toggleDeed(deed);
  }, true);
  field.element.addEventListener("mousemove", (event) => placeDeedButton(event.target.closest?.(".md-line")));
  wrap.addEventListener("mouseleave", () => { if (!field.element.contains(document.activeElement)) deedButton.hidden = true; });
  document.addEventListener("selectionchange", onSelection);
  return wrap;
}
function onSelection() {
  if (!editor) return document.removeEventListener("selectionchange", onSelection);
  if (!editor.field.element.isConnected) return;
  if (!editor.field.element.contains(document.activeElement)) return;
  const caret = editor.field.caret();
  if (!caret) return;
  const node = editor.field.element.querySelectorAll(":scope > .md-line")[caret.line];
  placeDeedButton(node);
}
function placeDeedButton(lineNode) {
  if (!editor) return;
  const { field, deedButton } = editor;
  if (!lineNode || !field.element.contains(lineNode)) return;
  const index = [...field.element.querySelectorAll(":scope > .md-line")].indexOf(lineNode);
  const text = field.lineAt(index);
  if (index < 0 || !DEED_LINE.test(text) || DEED_ANCHOR.test(text)) { deedButton.hidden = true; return; }
  deedButton.dataset.line = String(index);
  deedButton.style.top = `${lineNode.offsetTop}px`;
  deedButton.hidden = false;
}
function destroyEditor() {
  if (!editor) return;
  clearTimeout(editor.timer);
  editor.slash.destroy();
  editor.format.destroy();
  editor.links.destroy();
  document.removeEventListener("selectionchange", onSelection);
  editor = null;
}
function scheduleSave() {
  if (!editor) return;
  clearTimeout(editor.timer);
  editor.timer = setTimeout(() => saveEditor(), 1200);
}
async function saveEditor() {
  const current = editor;
  if (!current) return;
  clearTimeout(current.timer);
  const value = current.field.getValue();
  if (value === current.saved) return current.saving;
  if (current.saving) { current.again = true; return current.saving; }
  current.saving = (async () => {
    try {
      const result = await call(`/api/captures/${current.pageId}/notes`, "POST", { body: value });
      current.saved = value;
      if (state.detail?.page.id === current.pageId) {
        state.detail.page.body = value;
        state.detail.page.noteVersion = result.entry.note?.version ?? state.detail.page.noteVersion;
        state.detail.page.updatedAt = result.entry.note?.created_at || new Date().toISOString();
        const label = document.getElementById("notes-version");
        if (label) label.textContent = versionLabel(state.detail.page);
      }
    } catch (error) {
      deps.toast(error.message);
    } finally {
      current.saving = null;
      if (current.again) { current.again = false; if (editor === current) scheduleSave(); }
    }
  })();
  return current.saving;
}
function deedLabel(deed) {
  if (!deed) return "дело";
  if (deed.state === "pending") return "дело · разбирается…";
  if (deed.state === "failed") return "дело · не разобралось";
  if (deed.state === "done") return "дело · сделано";
  if (deed.state === "other") return "запись";
  return ["дело", "Доска", deed.column, deed.due].filter(Boolean).join(" · ");
}
function decorateDeeds() {
  if (!editor) return;
  const deeds = new Map((state.detail?.deeds || []).map((deed) => [deed.anchor, deed]));
  for (const node of editor.field.element.querySelectorAll(":scope > .md-line")) {
    const anchor = node.textContent.replace(/ /g, " ").match(DEED_ANCHOR)?.[1];
    node.classList.toggle("is-deed", Boolean(anchor));
    if (!anchor) {
      delete node.dataset.deed;
      node.classList.remove("is-deed-done", "is-deed-pending");
      continue;
    }
    const deed = deeds.get(anchor);
    node.dataset.deed = deedLabel(deed);
    node.classList.toggle("is-deed-done", deed?.state === "done");
    node.classList.toggle("is-deed-pending", !deed || deed.state === "pending");
  }
}
async function makeDeed(index) {
  if (!editor || !Number.isInteger(index)) return;
  const current = editor;
  current.deedButton.hidden = true;
  await saveEditor();
  const text = current.field.lineAt(index);
  try {
    const result = await call(`/api/pages/${current.pageId}/deeds`, "POST", { line: index, text });
    if (editor !== current) return;
    state.detail = result;
    current.saved = result.page.body;
    current.field.setValue(result.page.body);
    decorateDeeds();
    deps.toast("Дело на «Доске» — во «Входящих»", { label: "Открыть доску", run: () => { location.hash = "#board"; } });
  } catch (error) {
    deps.toast(error.message);
  }
}
async function toggleDeed(deed) {
  const path = deed.state === "done" ? "undo-complete" : "complete";
  deed.state = deed.state === "done" ? "open" : "done";
  decorateDeeds();
  try {
    for (const id of deed.projectionIds) await call(`/api/projections/${id}/${path}`, "POST", {});
    deps.toast(path === "complete" ? "Дело закрыто — и на «Доске» тоже" : "Дело снова открыто");
  } catch (error) {
    deed.state = path === "complete" ? "open" : "done";
    decorateDeeds();
    deps.toast(error.message);
  }
}

// ── под телом: страницы внутри, базы, ссылки ───────────────────────────────
function sectionHead(text, count, key) {
  const head = el("h2", "notes-section-head");
  if (key) head.append(foldToggle(key, text, count));
  else {
    head.append(el("span", undefined, text));
    if (count !== undefined) head.append(el("span", "notes-section-count", String(count)));
  }
  return head;
}
function pageRow(page, extra) {
  const link = el("a", "notes-page-row");
  link.href = hashFor({ kind: "page", id: page.id });
  link.append(icon(typeIcon(page)), el("span", "notes-page-row-title", page.title));
  if (extra) link.append(el("span", "notes-page-row-meta", extra));
  return link;
}
function afterBlock(detail) {
  const { page } = detail;
  const wrap = el("div", "notes-after");
  const children = foldable(el("section", "notes-section notes-children"), "children");
  children.append(sectionHead("Страницы внутри", detail.children.length || undefined, "children"));
  for (const child of detail.children) children.append(pageRow(child));
  const add = button("", "notes-add-row", () => newPage(page.id));
  add.append(icon("plus"), el("span", undefined, "Страница внутри"));
  children.append(add);
  wrap.append(children);

  // Базы встраиваются в страницу строкой ![[Название базы]], как встраивание
  // в Obsidian: сама база живёт в разделе «Базы», здесь — её вид.
  const bases = state.overview.bases;
  const embedded = [...page.body.matchAll(/!\[\[([^\]\n|#]+)[^\]\n]*\]\]/g)]
    .map((match) => bases.find((base) => base.name.toLocaleLowerCase("ru-RU") === match[1].trim().toLocaleLowerCase("ru-RU")))
    .filter((base, index, list) => base && list.indexOf(base) === index);
  for (const base of embedded) {
    const block = foldable(el("section", "notes-section notes-embed"), `base:${base.id}`);
    const head = sectionHead(base.name, undefined, `base:${base.id}`);
    head.append(crumbLink("открыть", { kind: "base", id: base.id }));
    block.append(head, baseContent(base.view, rowsFor(base.view)));
    wrap.append(block);
  }

  const links = foldable(el("section", "notes-section notes-backlinks"), "backlinks");
  links.append(sectionHead("Ссылаются сюда", detail.backlinks.length, "backlinks"));
  if (!detail.backlinks.length) links.append(el("p", "notes-empty", `Пока никто. Напишите [[${page.title}]] в другой заметке — и она появится здесь.`));
  for (const item of detail.backlinks) links.append(referenceRow(item));
  wrap.append(links);

  if (detail.mentions.length) {
    const mentions = foldable(el("section", "notes-section notes-mentions"), "mentions");
    mentions.append(sectionHead("Упоминания без ссылки", detail.mentions.length, "mentions"));
    for (const item of detail.mentions) {
      const row = referenceRow(item);
      row.append(button("Связать", "notes-act", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          state.detail = await call(`/api/pages/${page.id}/mentions`, "POST", { fromId: item.id });
          deps.toast("Упоминание стало ссылкой");
          renderMain();
        } catch (error) { deps.toast(error.message); }
      }));
      mentions.append(row);
    }
    wrap.append(mentions);
  }
  return wrap;
}
// Ссылка может прийти и не со страницы — из дела или встречи: такая запись
// открывается карточкой.
function referenceRow(item) {
  const row = el("div", "notes-ref");
  const target = pageById(item.id);
  const open = el(target ? "a" : "button", "notes-ref-main");
  if (target) open.href = hashFor({ kind: "page", id: item.id });
  else { open.type = "button"; open.addEventListener("click", () => deps.openCard(item.id)); }
  open.append(el("b", undefined, item.title), el("span", "notes-ref-context", item.context));
  row.append(open);
  return row;
}

// ── узел проекта ───────────────────────────────────────────────────────────
function renderProject() {
  const { main, bar, crumbs } = mainShell();
  const name = state.route.name;
  crumbs.append(el("span", "notes-crumb is-current", name));
  const sheet = el("article", "notes-sheet");
  const head = el("div", "notes-head");
  head.append(icon("project", "notes-head-ico"), el("h1", "notes-title is-static", name));
  const all = state.overview.pages.filter((page) => page.project === name);
  const inside = childrenOf(`project:${name}`);
  sheet.append(head, el("p", "notes-lead", all.length ? `Проект · ${all.length} ${plural(all.length, "заметка", "заметки", "заметок")}. Заметка с этим проектом без своего места ложится сюда сама.` : "В проекте пока нет заметок."));
  const children = foldable(el("section", "notes-section notes-children"), "project-children");
  children.append(sectionHead("Страницы", inside.length || undefined, "project-children"));
  for (const page of inside) children.append(pageRow(page));
  const add = button("", "notes-add-row", () => newPage(`project:${name}`));
  add.append(icon("plus"), el("span", undefined, "Страница в проекте"));
  children.append(add);
  const view = { ...DEFAULT_VIEW, filter: { ...DEFAULT_VIEW.filter, project: name } };
  const everything = foldable(el("section", "notes-section notes-embed"), "project-all");
  everything.append(sectionHead("Все заметки проекта", all.length, "project-all"), baseContent(view, rowsFor(view)));
  sheet.append(children, everything);
  main.replaceChildren(bar, sheet);
}

// ── «Входящие» ─────────────────────────────────────────────────────────────
function renderInbox() {
  const { main, bar, crumbs } = mainShell();
  crumbs.append(el("span", "notes-crumb is-current", "Входящие"));
  const sheet = el("article", "notes-sheet");
  const head = el("div", "notes-head");
  head.append(icon("inbox", "notes-head-ico"), el("h1", "notes-title is-static", "Входящие"));
  sheet.append(head, el("p", "notes-lead", "Заметки с «Сегодня» и из голоса, которым не нашлось места: без проекта и без [[страницы]] в тексте."));
  const rows = state.overview.pages.filter((page) => page.parentKey === "inbox").sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const list = el("div", "notes-inbox");
  if (!rows.length) list.append(el("p", "notes-empty", "Пусто — всё разложено."));
  for (const page of rows) {
    const row = el("div", "notes-inbox-row");
    // Входящие раскладываются и мышью: строку можно бросить на страницу или
    // проект в дереве.
    draggablePage(row, page.id);
    const text = el("a", "notes-inbox-main");
    text.href = hashFor({ kind: "page", id: page.id });
    text.append(el("b", undefined, page.title));
    if (page.excerpt && page.excerpt !== page.title) text.append(el("span", "notes-inbox-excerpt", page.excerpt));
    text.append(el("span", "notes-inbox-when", when(page.createdAt)));
    const actions = el("div", "notes-inbox-actions");
    if (page.suggest) actions.append(button(`В «${page.suggest.title}»`, "notes-act is-primary", () => applyPlace(page, page.suggest.key)));
    actions.append(button("Выбрать место", "notes-act", (event) => openPicker(event.currentTarget, page)), button("В корень", "notes-act", () => applyPlace(page, "root")));
    row.append(icon(typeIcon(page)), text, actions);
    list.append(row);
  }
  sheet.append(list);
  main.replaceChildren(bar, sheet);
}

// ── ссылка на страницу, которой нет ────────────────────────────────────────
function renderMissing() {
  const { main, bar, crumbs } = mainShell();
  const { title, from } = state.route;
  crumbs.append(el("span", "notes-crumb is-current", title));
  const sheet = el("article", "notes-sheet");
  const head = el("div", "notes-head");
  head.append(icon("page", "notes-head-ico"), el("h1", "notes-title is-static", title));
  const parent = from && pageById(from) ? pageById(from).parentKey : "root";
  const actions = el("div", "notes-missing-actions");
  actions.append(
    button(`Создать страницу «${title}»`, "notes-act is-primary", () => newPage(parent === "inbox" ? "root" : parent ?? "root", title)),
  );
  const memory = el("a", "notes-act", "Искать в памяти");
  memory.href = `#memory?query=${encodeURIComponent(title)}`;
  actions.append(memory);
  sheet.append(head, el("p", "notes-lead", "Такой страницы пока нет. Создайте её — ссылки на это название сразу начнут вести сюда."), actions);
  main.replaceChildren(bar, sheet);
}

// ── базы ───────────────────────────────────────────────────────────────────
function viewKey(view) { return JSON.stringify(view); }
function currentBase() {
  return state.route.kind === "base" ? state.overview.bases.find((base) => base.id === state.route.id) || null : null;
}
function rowsFor(view) {
  let rows = state.overview.pages;
  const { type, project, tag, parent } = view.filter;
  if (type && type !== "all") rows = rows.filter((page) => page.type === type);
  if (project) rows = rows.filter((page) => page.project === project);
  if (tag) rows = rows.filter((page) => page.tags.includes(tag));
  if (parent) rows = rows.filter((page) => page.parentKey === parent);
  const sorted = [...rows];
  if (view.sort === "title") sorted.sort((left, right) => left.title.localeCompare(right.title, "ru"));
  else if (view.sort === "updated") sorted.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  else sorted.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sorted;
}
function renderBase() {
  const { main, bar, crumbs, tail } = mainShell();
  const base = currentBase();
  if (state.route.kind === "base" && !base) {
    const sheet = el("article", "notes-sheet");
    sheet.append(el("h1", "notes-title is-static", "База не найдена"));
    main.replaceChildren(bar, sheet);
    return;
  }
  const saved = base ? base.view : DEFAULT_VIEW;
  if (!state.draft) state.draft = structuredClone(saved);
  const view = state.draft;
  crumbs.append(el("span", "notes-crumb is-current", base ? base.name : "Все заметки"));
  const sheet = el("article", "notes-sheet is-wide");
  const head = el("div", "notes-head");
  head.append(icon(base ? "base" : "all", "notes-head-ico"));
  const title = el("h1", "notes-title", base ? base.name : "Все заметки");
  if (base) {
    title.contentEditable = "true";
    title.setAttribute("role", "textbox");
    title.setAttribute("aria-label", "Название базы");
    title.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); title.blur(); } });
    title.addEventListener("blur", async () => {
      const name = title.textContent.replace(/\s+/g, " ").trim();
      if (!name || name === base.name) { title.textContent = base.name; return; }
      try {
        await call(`/api/pages/bases/${base.id}`, "PATCH", { name });
        await loadOverview();
        renderSide();
        const current = document.querySelector(".notes-crumb.is-current");
        if (current) current.textContent = name;
      } catch (error) { title.textContent = base.name; deps.toast(error.message); }
    });
  } else title.classList.add("is-static");
  head.append(title);
  sheet.append(head);

  const controls = el("div", "notes-base-controls");
  const tabs = el("div", "notes-base-tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Раскладка");
  for (const [value, name] of LAYOUTS) {
    const tab = button(name, "notes-base-tab", () => { view.layout = value; renderMain(); });
    tab.setAttribute("aria-pressed", String(view.layout === value));
    tabs.append(tab);
  }
  const filters = el("div", "notes-base-filters");
  const select = (label, value, options, onChange) => {
    const node = el("select", "notes-base-select");
    node.setAttribute("aria-label", label);
    for (const [optionValue, optionName] of options) {
      const option = el("option", undefined, optionName);
      option.value = optionValue;
      option.selected = optionValue === (value ?? "");
      node.append(option);
    }
    node.addEventListener("change", () => { onChange(node.value || null); renderMain(); });
    return node;
  };
  const tags = [...new Set(state.overview.pages.flatMap((page) => page.tags))].sort((left, right) => left.localeCompare(right, "ru"));
  filters.append(
    select("Тип", view.filter.type, [["all", "Заметки и идеи"], ["note", "Только заметки"], ["idea_question", "Только идеи"]], (value) => { view.filter.type = value || "all"; }),
    select("Проект", view.filter.project, [["", "Все проекты"], ...state.overview.allProjects.map((name) => [name, name])], (value) => { view.filter.project = value; }),
    select("Тег", view.filter.tag, [["", "Все теги"], ...tags.map((tag) => [tag, `#${tag}`])], (value) => { view.filter.tag = value; }),
    select("Сортировка", view.sort, SORTS, (value) => { view.sort = value || "created"; }),
  );
  controls.append(tabs, filters);
  sheet.append(controls);

  const rows = rowsFor(view);
  const changed = viewKey(view) !== viewKey(saved);
  if (base) {
    if (changed) tail.append(button("Сохранить вид", "notes-act is-primary", async () => {
      try {
        await call(`/api/pages/bases/${base.id}`, "PATCH", { view });
        await loadOverview();
        state.draft = null;
        deps.toast("Вид базы сохранён");
        renderMain();
      } catch (error) { deps.toast(error.message); }
    }));
    tail.append(button("Удалить базу", "notes-act", async () => {
      try {
        await call(`/api/pages/bases/${base.id}`, "DELETE");
        deps.toast(`База «${base.name}» удалена`);
        go({ kind: "all" });
      } catch (error) { deps.toast(error.message); }
    }));
  } else {
    tail.append(button("Сохранить как базу", "notes-act", async () => {
      try {
        const { base: created } = await call("/api/pages/bases", "POST", { name: view.filter.project || (view.filter.tag ? `#${view.filter.tag}` : "Новая база"), view });
        state.focusTitle = true;
        go({ kind: "base", id: created.id });
      } catch (error) { deps.toast(error.message); }
    }));
  }
  sheet.append(el("p", "notes-base-count", `${rows.length} ${plural(rows.length, "страница", "страницы", "страниц")}`), baseContent(view, rows));
  main.replaceChildren(bar, sheet);
  if (state.focusTitle && base) {
    state.focusTitle = false;
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
}
function baseContent(view, rows) {
  if (!rows.length) return el("p", "notes-empty", "Под этот вид ни одна страница не подходит.");
  if (view.layout === "gallery") {
    const grid = el("div", "notes-gallery");
    for (const page of rows) {
      const card = el("a", "notes-card");
      card.href = hashFor({ kind: "page", id: page.id });
      const cover = el("span", "notes-card-cover", page.excerpt && page.excerpt !== page.title ? page.excerpt : "");
      const body = el("span", "notes-card-body");
      const name = el("span", "notes-card-title");
      name.append(icon(typeIcon(page)), el("span", undefined, page.title));
      body.append(name);
      const meta = el("span", "notes-card-meta", [placeLabel(page.parentKey), when(page.updatedAt, { time: false })].join(" · "));
      body.append(meta);
      if (page.tags.length) {
        const tags = el("span", "notes-tags");
        for (const tag of page.tags) tags.append(el("span", "notes-tag", `#${tag}`));
        body.append(tags);
      }
      card.append(cover, body);
      grid.append(card);
    }
    return grid;
  }
  if (view.layout === "list") {
    const list = el("div", "notes-list");
    for (const page of rows) {
      const row = el("a", "notes-list-row");
      row.href = hashFor({ kind: "page", id: page.id });
      const text = el("span", "notes-list-text");
      text.append(el("b", undefined, page.title));
      if (page.excerpt && page.excerpt !== page.title) text.append(el("span", "notes-list-excerpt", page.excerpt));
      row.append(icon(typeIcon(page)), text, el("span", "notes-list-when", when(page.updatedAt, { time: false })));
      list.append(row);
    }
    return list;
  }
  const wrap = el("div", "notes-table-wrap");
  const table = el("table", "notes-table");
  const head = el("tr");
  for (const name of ["Название", "Место", "Проект", "Теги", "Изменено", "Ссылок"]) head.append(el("th", undefined, name));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  for (const page of rows) {
    const row = el("tr");
    const nameCell = el("td", "notes-table-name");
    const link = el("a");
    link.href = hashFor({ kind: "page", id: page.id });
    link.append(icon(typeIcon(page)), el("span", undefined, page.title));
    nameCell.append(link);
    const tags = el("td");
    for (const tag of page.tags) tags.append(el("span", "notes-tag", `#${tag}`));
    row.append(nameCell, el("td", "notes-table-dim", placeLabel(page.parentKey)), el("td", "notes-table-dim", page.project || ""), tags, el("td", "notes-table-dim", when(page.updatedAt, { time: false })), el("td", "notes-table-num", page.links ? String(page.links) : ""));
    row.addEventListener("click", (event) => { if (!event.target.closest("a")) go({ kind: "page", id: page.id }); });
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

// ── выбор места ────────────────────────────────────────────────────────────
function descendantsOf(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of state.overview.pages) if (!out.has(page.id) && out.has(page.parentKey)) { out.add(page.id); grew = true; }
  }
  return out;
}
function closePicker() {
  if (!picker) return;
  picker.node.remove();
  document.removeEventListener("pointerdown", picker.outside, true);
  document.removeEventListener("keydown", picker.escape, true);
  picker = null;
}
function openPicker(anchor, page) {
  closePicker();
  const node = el("div", "notes-picker");
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", "Куда положить страницу");
  const input = el("input", "notes-picker-input");
  input.type = "search";
  input.placeholder = "Куда положить…";
  const list = el("div", "notes-picker-list");
  list.setAttribute("role", "listbox");
  node.append(input, list);
  const blocked = descendantsOf(page.id);
  const options = [
    { key: "root", title: "В корень", hint: "страница верхнего уровня", iconName: "page" },
    { key: "auto", title: "По правилу", hint: page.project ? `под проект «${page.project}»` : "во «Входящие»", iconName: "inbox" },
    ...state.overview.allProjects.map((name) => ({ key: `project:${name}`, title: name, hint: "проект", iconName: "project" })),
    ...state.overview.pages.filter((item) => !blocked.has(item.id)).map((item) => ({ key: item.id, title: item.title, hint: placeLabel(item.parentKey), iconName: typeIcon(item) })),
  ];
  const paint = () => {
    const query = input.value.trim().toLocaleLowerCase("ru-RU");
    list.replaceChildren();
    const shown = options.filter((option) => !query || option.title.toLocaleLowerCase("ru-RU").includes(query)).slice(0, 60);
    for (const option of shown) {
      const row = button("", "notes-picker-row", () => { closePicker(); applyPlace(page, option.key); });
      row.setAttribute("role", "option");
      row.append(icon(option.iconName), el("span", "notes-picker-title", option.title), el("span", "notes-picker-hint", option.hint));
      list.append(row);
    }
    if (!shown.length) list.append(el("p", "notes-empty", "Ничего не нашлось."));
  };
  input.addEventListener("input", paint);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); list.querySelector(".notes-picker-row")?.click(); }
  });
  paint();
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 32);
  node.style.width = `${width}px`;
  node.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
  node.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 320)}px`;
  const outside = (event) => { if (!node.contains(event.target) && event.target !== anchor) closePicker(); };
  const escape = (event) => { if (event.key === "Escape") { event.stopPropagation(); closePicker(); anchor.focus(); } };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
  picker = { node, outside, escape };
  input.focus();
}
async function applyPlace(page, key) {
  try {
    await saveEditor();
    if (key.startsWith("project:")) {
      const name = key.slice(8);
      if (page.project !== name) await call(`/api/captures/${page.id}/corrections`, "POST", { project: name });
      await call(`/api/pages/${page.id}/place`, "PUT", { parent: "auto" });
    } else {
      await call(`/api/pages/${page.id}/place`, "PUT", { parent: key });
    }
    await loadOverview();
    if (state.route.kind === "page") await loadDetail(state.route.id);
    const where = key === "auto" ? placeLabel(pageById(page.id)?.parentKey) : placeLabel(key);
    if (key !== "root" && key !== "auto") { state.expanded.add(key); saveExpanded(); }
    deps.toast(key === "root" ? `«${page.title}» — в корне` : `«${page.title}» — в «${where}»`);
    renderSide();
    renderMain();
  } catch (error) {
    deps.toast(error.message);
  }
}
