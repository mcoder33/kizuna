// Подсказка людей после «@» в поле записи. Позвать человека в запись можно, не
// заходя в круг: набрал «@», увидел своих, выбрал — и он эту запись видит и
// знает о ней. Кого звать, решает сервер: GET /api/people отдаёт людей из всех
// ваших кругов.
//
// Устроена как меню страниц по «[[» (link-menu.js) и меню разметки по «/»:
// свои классы, свой список, стрелки и Enter перехватываются раньше поля.
// Список помнится полминуты — круги меняются редко.

const normalize = (value) => String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

// Подбор идёт, пока каретка стоит после «@», начатого с начала строки или после
// пробела: в «почта@дом» это не имя, а адрес.
export function readMentionQuery(line, offset) {
  const head = String(line).slice(0, offset);
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s(«"'—-]/.test(head[at - 1])) return null;
  const query = head.slice(at + 1);
  if (/[\s@]/.test(query) || query.length > 40) return null;
  return { from: at, to: offset, query };
}

// Совпадение с начала имени ценнее совпадения в середине; дальше — по алфавиту,
// чтобы список не прыгал.
export function rankPeople(people, query, limit = 8) {
  const needle = normalize(query).trim();
  const byName = (left, right) => String(left.name || "").localeCompare(String(right.name || ""), "ru");
  if (!needle) return [...people].sort(byName).slice(0, limit);
  const scored = [];
  for (const person of people) {
    const name = normalize(person.name);
    const mail = normalize(person.email);
    const at = name.indexOf(needle);
    const inMail = mail.startsWith(needle);
    if (at < 0 && !inMail) continue;
    scored.push({ person, score: at === 0 ? 0 : inMail ? 1 : 2 });
  }
  scored.sort((left, right) => left.score - right.score || byName(left.person, right.person));
  return scored.slice(0, limit).map((entry) => entry.person);
}

let cache = null;
let cachedAt = 0;
let loading = null;
function loadPeople(fetchImplementation) {
  if (cache && Date.now() - cachedAt < 30000) return Promise.resolve(cache);
  loading ||= fetchImplementation("/api/people", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : { people: [] }))
    .then((data) => { cache = data.people || []; cachedAt = Date.now(); return cache; })
    .catch(() => [])
    .finally(() => { loading = null; });
  return loading;
}
// Человек вошёл в круг или вышел — подсказка должна это увидеть сразу.
export function forgetMentionPeople() {
  cache = null;
}

export function attachMentionMenu(field, { document: doc = document, fetch: fetchImplementation = fetch } = {}) {
  const root = field.element;
  const menu = doc.createElement("div");
  menu.className = "mention-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Кого позвать");
  menu.hidden = true;
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
  }
  function place() {
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const base = rect.width || rect.height ? rect : root.getBoundingClientRect();
    const top = base.bottom + 6;
    const height = menu.offsetHeight || 220;
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
    visible.forEach((person, index) => {
      const option = doc.createElement("div");
      option.className = "mention-option";
      option.setAttribute("role", "option");
      const name = doc.createElement("span");
      name.className = "mention-name";
      name.textContent = person.name;
      const hint = doc.createElement("span");
      hint.className = "mention-hint";
      hint.textContent = (person.circles || []).join(", ");
      option.append(name, hint);
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(index);
      });
      menu.append(option);
    });
    const foot = doc.createElement("p");
    foot.className = "mention-foot";
    foot.textContent = "Позванный увидит эту запись";
    menu.append(foot);
    menu.hidden = false;
    place();
    setActive(active);
  }

  function choose(index) {
    const person = visible[index];
    if (!person || !anchor) return;
    const call = `@${person.name} `;
    field.replaceInLine(anchor.line, anchor.from, anchor.to, call, call.length);
    close();
  }

  let token = 0;
  async function refresh() {
    const mine = ++token;
    const caret = field.caret();
    if (!caret) return close();
    const found = readMentionQuery(field.lineAt(caret.line), caret.offset);
    if (!found) return close();
    const people = await loadPeople(fetchImplementation);
    if (mine !== token) return;
    const items = rankPeople(people, found.query);
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
    const index = [...menu.children].indexOf(event.target.closest?.(".mention-option"));
    if (index >= 0 && index !== active) setActive(index);
  };
  doc.addEventListener("mousemove", onMouseMove, true);
  const onKeyUp = (event) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) refresh(); };
  root.addEventListener("input", refresh);
  root.addEventListener("keyup", onKeyUp);
  root.addEventListener("blur", close);
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
      root.removeEventListener("blur", close);
      root.removeEventListener("mouseup", refresh);
      window.removeEventListener("resize", onResize);
      menu.remove();
    },
  };
}
