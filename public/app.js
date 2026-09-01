import { renderMarkdown, renderInlineMarkdown } from "./markdown.js";
import { createMarkdownField } from "./markdown-live.js";
import { attachSlashMenu } from "./slash-menu.js";
import { createVoiceDialog } from "./voice.js";

const $ = (selector) => document.querySelector(selector);
const typeNames = {
  meeting_event: "встреча",
  task: "задача",
  note: "заметка",
  outcome_decision: "результат",
  idea_question: "идея",
};
const providerNames = {
  fallback: "Без разбора",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
};
const modelStorageKey = "pagent.ai-model";
// У кого можно выбирать модель прямо в шапке. У OpenAI каталог приходит из их
// же API, у OpenRouter — из своего; у CLI-провайдеров модель задаёт окружение.
const modelCapableProviders = new Set(["openrouter", "openai", "gemini"]);
const fallbackNames = {
  unavailable: "недоступен",
  not_configured: "не настроен",
  busy: "занят",
  timeout: "не ответил вовремя",
  aborted: "отменён",
  nonzero: "не завершил запрос",
  malformed_output: "вернул непонятный ответ",
  absent_output: "не вернул ответ",
  oversize_output: "вернул слишком большой ответ",
  schema_invalid: "вернул некорректную структуру",
  rate_limited: "достиг лимита",
  citation_failure: "не подтвердил источники",
  invalid_provider: "неизвестный провайдер",
  spend_limit: "остановлен потолком расходов",
};
const activeCaptureStorageKey = "pagent.active-captures";
const legacyActiveCaptureStorageKey = "pagent.active-capture";
const activeCaptures = new Map();
let bootstrapInFlight = false,
  bootstrapQueued = false,
  correctionInFlight = false,
  memoryController = null;
const completionInFlight = new Set();
const correctionResponses = new Map();
function correctionOperationKey(body) {
  let hash = 2166136261;
  for (const character of body) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `correction-${(hash >>> 0).toString(36)}`;
}
async function requestResponse(url, options = {}) {
  const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    isCorrection = /^\/api\/captures\/[0-9a-f-]{36}\/corrections$/i.test(url),
    cacheKey = isCorrection ? `${url}\n${options.body || ""}` : null;
  if (cacheKey && correctionResponses.has(cacheKey))
    return correctionResponses.get(cacheKey);
  if (isCorrection && !headers["Idempotency-Key"])
    headers["Idempotency-Key"] = correctionOperationKey(options.body || "");
  const pending = (async () => {
    const response = await fetch(url, { ...options, headers }),
      data = await response.json().catch(() => null);
    // Сессия кончилась или её закрыл администратор: сообщать об этом ошибкой в
    // углу бессмысленно — дальше всё равно ничего не откроется.
    if (response.status === 401) { location.replace("/login"); throw new Error("Нужно войти."); }
    if (!response.ok)
      throw new Error(data?.error?.message || "Не удалось выполнить действие.");
    return { response, data };
  })();
  if (cacheKey) correctionResponses.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    if (cacheKey) correctionResponses.delete(cacheKey);
    throw error;
  }
}
async function request(url, options = {}) {
  return (await requestResponse(url, options)).data;
}
document.addEventListener(
  "submit",
  (event) => {
    const form = event.target;
    if (
      form instanceof HTMLFormElement &&
      form.classList.contains("review-form")
    ) {
      if (form.dataset.correctionSubmitted === "true") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      form.dataset.correctionSubmitted = "true";
    }
  },
  true,
);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function clear(element) {
  element.replaceChildren();
}
// Markdown живёт во всём интерфейсе, а не только в заметке карточки. Разметка
// разбирается нашим рендерером (public/markdown.js): HTML экранируется до
// разбора, поэтому пользовательский текст не может внести теги.
function markdownNode(tag, text, className, { inline = false, links = true, firstLine = false } = {}) {
  const element = node(tag, undefined, className);
  const source = String(text ?? "");
  element.innerHTML = inline
    ? renderInlineMarkdown(source, { links, firstLine })
    : renderMarkdown(source);
  if (inline) element.classList.add("md-inline");
  else element.classList.add("md-block");
  return element;
}
let toastTimer = 0;
// Тост умеет нести одно действие: удаление показывается вместе с «Вернуть»,
// поэтому подтверждать его заранее не нужно — отменить можно после.
function toast(text, action = null) {
  const element = $("#toast");
  clear(element);
  element.append(node("span", text));
  if (action) {
    const button = node("button", action.label, "toast-action");
    button.type = "button";
    button.addEventListener("click", async () => {
      element.classList.remove("show");
      await action.run();
    });
    element.append(button);
  }
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), action ? 6000 : 2800);
}
function selectedProvider() {
  return $("#ai-provider").value || "fallback";
}
function selectedModel() {
  const picker = $("#ai-model");
  return modelCapableProviders.has(selectedProvider()) && picker.value
    ? picker.value
    : null;
}
function withModel(body) {
  const model = selectedModel();
  return model ? { ...body, model } : body;
}
// Пока список провайдеров не загрузился, выбор ещё не известен. Раньше в этот
// момент отправлялся provider: "fallback", и запись молча сохранялась без
// разбора при настроенном провайдере. Теперь поле не отправляется — провайдера
// выбирает сервер по своей настройке.
function providerReady() {
  return $("#ai-provider").options.length > 0;
}
function withProvider(body = {}) {
  return withModel(providerReady() ? { ...body, provider: selectedProvider() } : body);
}
function fallbackSuffix(provenance) {
  return provenance?.fallbackReason &&
    provenance.requestedProvider !== "fallback"
    ? ` · ${fallbackNames[provenance.fallbackReason] || "недоступен"}`
    : "";
}
function showProvenance(provenance) {
  if (!provenance) return;
  const provider = provenance.usedProvider || provenance.provider,
    element = $("#ai-status");
  element.textContent = `Использован: ${providerNames[provider] || "локальные правила"}${fallbackSuffix(provenance)}`;
  element.className = `status ${provider !== "fallback" ? "ai" : fallbackSuffix(provenance) ? "fallback" : ""}`.trim();
}
function updatePageFromHash() {
  // Внутренние ссылки Obsidian ведут в память с запросом: «#memory?query=Hub».
  // Хэш поэтому разбирается на страницу и параметры — иначе такой страницы не
  // находится и человека выбрасывает на «Сегодня» вместо поиска.
  const hash = location.hash.slice(1);
  const separator = hash.indexOf("?");
  const pageId = (separator >= 0 ? hash.slice(0, separator) : hash) || "today";
  const params = new URLSearchParams(separator >= 0 ? hash.slice(separator + 1) : "");
  const page = document.getElementById(pageId);
  const activePage = page?.classList.contains("app-page") ? pageId : "today";
  for (const section of document.querySelectorAll(".app-page"))
    section.hidden = section.id !== activePage;
  for (const link of document.querySelectorAll("nav a"))
    link.classList.toggle(
      "active",
      link.getAttribute("href") === `#${activePage}`,
    );
  const historyMenu = document.querySelector(".history-menu");
  historyMenu?.classList.toggle("active", activePage.startsWith("history-"));
  if (activePage !== pageId) history.replaceState(null, "", "#today");
  // Открыли настройки — перечитываем расход: он меняется от каждой записи, а
  // страница может висеть открытой долго.
  if (activePage === "settings") loadUsage();
  if (activePage === "admin") loadAdmin();
  // Запрос из ссылки сразу уходит в поиск: человек щёлкнул по имени, а не по
  // пустой странице памяти.
  const query = activePage === "memory" ? params.get("query")?.trim() : "";
  if (query) {
    const input = $("#memory-input");
    if (input.value !== query || !$("#memory-result").hasChildNodes()) {
      input.value = query;
      $("#memory-form").requestSubmit();
    }
  }
}
const historyMenu = document.querySelector(".history-menu");
// Поповеры шапки: «Журнал» и настройки ИИ закрываются по клику вне и Escape.
const headerMenus = () => [...document.querySelectorAll("header details")];
historyMenu?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement)
    event.currentTarget.removeAttribute("open");
});
document.addEventListener("pointerdown", (event) => {
  for (const menu of headerMenus())
    if (menu.open && !menu.contains(event.target)) menu.removeAttribute("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of headerMenus())
    if (menu.open) {
      menu.removeAttribute("open");
      menu.querySelector("summary")?.focus();
    }
});
// У записи может быть несколько завершаемых проекций (например task и
// meeting_event сразу). Раньше карточка смотрела на первую, а список TODO —
// на свою: закрытая по одной проекции запись показывала «готово» и при этом
// оставалась в TODO. Теперь правило общее для всех проекций записи.
function completableProjections(entry) {
  return entry.projections.filter(
    (projection) =>
      projection.type === "task" || projection.type === "meeting_event",
  );
}
function projectionOfType(entry, type) {
  return entry.projections.find((projection) => projection.type === type);
}
// Две разные вещи, которые раньше смешивались в одном признаке:
// «записал как сделанное» — это отчёт о работе и содержимое дневника,
// «закрыл задачу чекбоксом» — это просто уход из TODO, а не запись в дневник.
function isReportedWork(entry) {
  return entry.interpretation.classification.completed === true;
}
function isClosed(entry) {
  const projections = completableProjections(entry);
  return (
    projections.length > 0 &&
    projections.every((projection) => projection.completion?.completed)
  );
}
function isActiveTask(entry) {
  const projection = projectionOfType(entry, "task");
  return Boolean(projection && !projection.completion?.completed);
}
function isActiveMeeting(entry) {
  const projection = projectionOfType(entry, "meeting_event");
  return Boolean(projection && !projection.completion?.completed);
}
// Конфликтующая задача или встреча сохраняется без проекций, поэтому попадает
// в TODO только по этому признаку — иначе она недоступна ни на одном экране.
// Заметки и идеи с конфликтом остаются в своём списке и здесь не нужны.
function needsClarification(entry) {
  const c = entry.interpretation.classification;
  if (isReportedWork(entry) || isClosed(entry)) return false;
  // Неразобранная запись не имеет проекций вообще, поэтому без этого признака
  // она была бы недоступна на всех экранах.
  if (c.unclassified) return true;
  return Boolean(
    (c.conflicts?.schedule || c.conflicts?.projects) &&
      ["task", "meeting_event"].includes(c.primaryType),
  );
}
let currentDayDate = null;
function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
// Подпись срока считается от сегодняшней даты при отрисовке: сохранённый
// токен «сегодня» назавтра превращался в бессмыслицу «сегодня · просрочено».
// Когда запись сделана — день и время. «Сегодня» и «вчера» словами: так дату
// читают, а не вычисляют. Часовой пояс тот же, что и у остального журнала.
function entryClock(entry) {
  const at = new Date(entry.occurredAt || entry.createdAt);
  if (Number.isNaN(at.getTime())) return null;
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Samara",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  const date = entryDate(entry);
  const day =
    currentDayDate && date === currentDayDate
      ? "сегодня"
      : currentDayDate && date === shiftDate(currentDayDate, -1)
        ? "вчера"
        : new Intl.DateTimeFormat("ru-RU", {
            timeZone: "Europe/Samara",
            day: "numeric",
            month: "short",
          }).format(at);
  return `${day}, ${time}`;
}
function scheduleLabel(schedule) {
  if (!schedule) return null;
  if (schedule.state === "conflict" || (!schedule.date && !schedule.time))
    return schedule.display || null;
  let dateLabel = schedule.date;
  if (schedule.date && currentDayDate) {
    dateLabel =
      schedule.date === currentDayDate
        ? "сегодня"
        : schedule.date === shiftDate(currentDayDate, 1)
          ? "завтра"
          : schedule.date === shiftDate(currentDayDate, -1)
            ? "вчера"
            : `${schedule.date.slice(8, 10)}.${schedule.date.slice(5, 7)}${
                schedule.date.slice(0, 4) === currentDayDate.slice(0, 4)
                  ? ""
                  : `.${schedule.date.slice(0, 4)}`
              }`;
  }
  const vague =
    !schedule.time && schedule.display?.includes("после обеда")
      ? "после обеда"
      : null;
  return (
    [dateLabel, schedule.time || vague].filter(Boolean).join(", ") ||
    schedule.display ||
    null
  );
}
function entryDate(entry) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Samara",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(entry.occurredAt || entry.createdAt));
}
function uniqueEntries(groups) {
  const entries = new Map();
  for (const group of groups)
    for (const entry of group || []) entries.set(entry.id, entry);
  return [...entries.values()];
}
// Переключатель действует на все завершаемые проекции записи сразу, иначе
// закрытие одной оставляло запись открытой по другой.
async function updateCompletion(projections, complete, button) {
  const pending = projections.filter(
    (projection) =>
      !completionInFlight.has(projection.id) &&
      Boolean(projection.completion?.completed) !== complete,
  );
  if (!pending.length) return;
  for (const projection of pending) completionInFlight.add(projection.id);
  button.disabled = true;
  try {
    await Promise.all(
      pending.map((projection) =>
        request(
          `/api/projections/${projection.id}/${complete ? "complete" : "undo-complete"}`,
          { method: "POST", body: "{}" },
        ),
      ),
    );
    toast(complete ? "Отмечено как готовое" : "Возвращено в работу");
    await load();
  } catch (error) {
    toast(error.message);
  } finally {
    for (const projection of pending) completionInFlight.delete(projection.id);
    button.disabled = false;
  }
}
function entryCard(entry, { overdue = false, compact = false } = {}) {
  const c = entry.interpretation.classification,
    projections = completableProjections(entry),
    completed = isClosed(entry),
    waiting = projections.length > 0 && !completed && !overdue,
    card = node(
      "div",
      undefined,
      `entry${projections.length ? " completable" : ""}${completed ? " completed" : ""}${overdue ? " overdue" : ""}${waiting ? " waiting" : ""}`,
    ),
    meta = node("div", undefined, "entry-meta");
  card.dataset.captureId = entry.id;
  if (projections.length) {
    const label = completed ? "Вернуть в работу" : "Готово",
      complete = node("button", undefined, "completion-button");
    complete.type = "button";
    complete.title = label;
    complete.setAttribute("aria-label", label);
    complete.setAttribute("aria-pressed", String(completed));
    complete.addEventListener("click", () =>
      updateCompletion(projections, !completed, complete),
    );
    card.append(complete);
  }
  const title = markdownNode("button", c.summary, "entry-title", { inline: true, links: false, firstLine: true });
  title.type = "button";
  title.addEventListener("click", () => {
    // Карточка вытекает из той записи, по которой щёлкнули.
    // Если у записи есть свой вопрос от модели, он и показывается; иначе
    // карточка открывается на обычное уточнение.
    const review = reviewFromEntry(entry);
    showCorrection(entry, review.level === "high" ? undefined : review);
  });
  card.append(title);
  meta.append(
    node(
      "span",
      typeNames[c.primaryType] || c.primaryType,
      `tag ${c.primaryType === "task" ? "task" : ""}`,
    ),
  );
  // Проект — отдельной меткой рядом с типом: это то, к чему запись относится,
  // а не подробность в общей строке.
  for (const project of c.entities.projects)
    meta.append(node("span", project, "tag project"));
  const due = scheduleLabel(c.entities.schedule);
  // Время записи видно всегда: без него карточка не отвечает на вопрос
  // «когда это было».
  const metaParts = [
    entryClock(entry),
    ...(Array.isArray(c.tags) ? c.tags.map((tag) => `#${tag}`) : []),
  ].filter(Boolean);
  if (metaParts.length)
    meta.append(document.createTextNode(metaParts.join(" · ")));
  // Состояния — цветными метками, а не словами в общей строке: просрочено и
  // готово должны читаться взглядом, не чтением.
  const dueDate = c.entities.schedule?.date;
  if (due)
    meta.append(
      node(
        "span",
        `срок: ${due}`,
        `tag due${overdue ? " late" : dueDate && dueDate === currentDayDate ? " soon" : ""}`,
      ),
    );
  // У дела без срока просрочки быть не может — и это тоже должно быть видно,
  // иначе пустое место читается как «неизвестно».
  if (!due && !completed && ["task", "meeting_event"].includes(c.primaryType))
    meta.append(node("span", "без срока", "tag undated"));
  if (overdue) meta.append(node("span", "просрочено", "tag late"));
  if (!overdue && !completed && due && ["task", "meeting_event"].includes(c.primaryType))
    meta.append(node("span", "в срок", "tag ontime"));
  if (completed) meta.append(node("span", "готово", "tag done"));
  if (c.primaryType === "task" && c.priority === "high")
    meta.append(node("span", "важно", "tag urgent"));
  if (c.primaryType === "task" && c.priority === "low")
    meta.append(node("span", "не срочно", "tag calm"));
  // Скрепка с числом: по списку видно, что к записи что-то приложено.
  if (entry.attachments?.length)
    meta.append(node("span", `📎 ${entry.attachments.length}`, "tag files"));
  card.append(meta);
  const actions = node("div", undefined, "entry-actions");
  if (!compact) {
    const reclassify = node("button", "Переразобрать", "text-button");
    reclassify.addEventListener("click", () => reclassifyEntry(entry));
    actions.append(reclassify);
  }
  if (!compact && entry.projections[0]?.undoGroupId) {
    const undo = node("button", "Отменить", "text-button");
    undo.addEventListener("click", () =>
      undoGroup(entry.projections[0].undoGroupId),
    );
    actions.append(undo);
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}
function appendEntries(container, entries, emptyText, options) {
  clear(container);
  for (const entry of entries)
    container.append(entryCard(entry, options?.entryOptions?.(entry)));
  if (!container.childNodes.length)
    container.append(node("p", emptyText, "empty"));
}
// Сколько записей показывать в колонке — настройка, а не константа.
let previewLimit = 3;
// Колонка показывает первые записи, а не все. Раньше об этом было сказано
// только заголовком-ссылкой, и запись, ушедшая за границу превью (например,
// дело, которому передвинули срок вперёд), выглядела пропавшей.
function appendPreview(container, entries, emptyText, options) {
  appendEntries(container, entries.slice(0, previewLimit), emptyText, {
    entryOptions: (entry) => ({
      ...options?.entryOptions?.(entry),
      compact: true,
    }),
  });
  const hidden = entries.length - previewLimit;
  if (hidden <= 0) return;
  const more = node("a", `Ещё ${hidden} — весь список →`, "preview-more");
  more.href = options?.href || "#today";
  container.append(more);
}
function historyLabel(date) {
  if (!date) return "Без срока";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Samara",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00+04:00`));
}
function appendHistoryByDay(container, entries, emptyText, dateOf, options) {
  clear(container);
  if (!entries.length) {
    container.append(node("p", emptyText, "empty"));
    return;
  }
  const groups = new Map();
  for (const entry of entries) {
    const date = dateOf(entry) || null;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(entry);
  }
  const dated = [...groups.keys()].filter(Boolean).sort();
  if (options?.order !== "due") dated.reverse();
  const undated = groups.has(null) ? [null] : [];
  for (const date of [...dated, ...undated]) {
    const groupEntries = groups.get(date);
    const group = node("section", undefined, "history-group");
    group.append(node("h3", historyLabel(date)));
    const stack = node("div", undefined, "stack");
    for (const entry of groupEntries)
      stack.append(entryCard(entry, options?.entryOptions?.(entry)));
    group.append(stack);
    container.append(group);
  }
}
function appendClosedGroup(container, entries) {
  if (!entries.length) return;
  const group = node("section", undefined, "history-group closed-group");
  group.append(node("h3", "Закрытые"));
  const stack = node("div", undefined, "stack");
  for (const entry of entries) stack.append(entryCard(entry));
  group.append(stack);
  container.append(group);
}
function render(data) {
  currentDayDate = data.date;
  const all = uniqueEntries([
      data.entries,
      data.day,
      data.upcoming,
      data.attention,
    ]).sort((left, right) =>
      (right.createdAt || "").localeCompare(left.createdAt || ""),
    ),
    todayEntries = all.filter(
      (entry) =>
        entryDate(entry) === data.date ||
        entry.interpretation.classification.entities.schedule?.date ===
          data.date,
    ),
    done = todayEntries.filter(isReportedWork),
    todo = all
      .filter(
        (entry) =>
          (isActiveTask(entry) ||
            isActiveMeeting(entry) ||
            needsClarification(entry)) &&
          !isReportedWork(entry),
      )
      .sort((left, right) => todoOrder(left, data.date) - todoOrder(right, data.date)),
    notes = todayEntries.filter((entry) => {
      const type = entry.interpretation.classification.primaryType;
      return (
        !isReportedWork(entry) &&
        !isClosed(entry) &&
        ["note", "outcome_decision", "idea_question"].includes(type)
      );
    }),
    workHistory = all.filter(isReportedWork),
    // Закрытая задача не попадает в дневник, но и не исчезает бесследно:
    // она остаётся в журнале TODO отдельной группой, чтобы её можно было найти
    // и вернуть в работу.
    closedHistory = all.filter(
      (entry) => isClosed(entry) && !isReportedWork(entry),
    ),
    // Закрытая задача не заметка, даже если модель когда-то отнесла её к
    // заметкам: она живёт в группе «Закрытые» журнала TODO.
    notesHistory = all.filter((entry) => {
      const type = entry.interpretation.classification.primaryType;
      return (
        !isReportedWork(entry) &&
        !isClosed(entry) &&
        ["note", "outcome_decision", "idea_question"].includes(type)
      );
    });
  appendPreview($("#journal"), done, "Пока нет зафиксированной работы за сегодня.", {
    href: "#history-work",
  });
  appendPreview($("#todo"), todo, "Открытых дел нет.", {
    href: "#history-todo",
    entryOptions: (entry) => ({ overdue: isOverdue(entry, data.date) }),
  });
  appendPreview($("#notes"), notes, "Заметки появятся здесь.", { href: "#history-notes" });
  appendHistoryByDay(
    $("#history-work-list"),
    workHistory,
    "Пока нет зафиксированной работы.",
    entryDate,
  );
  appendHistoryByDay(
    $("#history-todo-list"),
    todo,
    "Открытых дел нет.",
    (entry) => entry.interpretation.classification.entities.schedule?.date,
    {
      order: "due",
      entryOptions: (entry) => ({ overdue: isOverdue(entry, data.date) }),
    },
  );
  appendClosedGroup($("#history-todo-list"), closedHistory);
  appendHistoryByDay(
    $("#history-notes-list"),
    notesHistory,
    "Заметок пока нет.",
    entryDate,
  );
}
function isOverdue(entry, today) {
  const date = entry.interpretation.classification.entities.schedule?.date;
  return Boolean(date && date < today);
}
function todoOrder(entry, today) {
  const date = entry.interpretation.classification.entities.schedule?.date;
  if (date && date < today) return 0;
  if (needsClarification(entry)) return 1;
  if (date === today) return 2;
  if (!date) return 3;
  return 4;
}
async function load() {
  const [day, entries] = await Promise.all([
    request("/api/day"),
    request("/api/entries?limit=100"),
  ]);
  render({ ...day, entries: entries.entries });
}
// Движение в приложении одно на всё: предмет не летит через экран и не растёт
// на глазах — он тихо проявляется там, где его посчитала раскладка. Тот же
// характер, что у кольца в разговоре: мягко, коротко и без рывка.
const APPEAR_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const APPEAR_DURATION = 300;
const FADE_DURATION = 150;
function motionAllowed() {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
// base нужен предметам, у которых своё постоянное смещение (лист держится на
// translate(-50%, -50%)): без него анимация сбросила бы его на первом кадре.
function appear(element, { shift = 10, duration = APPEAR_DURATION, base = "" } = {}) {
  if (!motionAllowed()) return null;
  for (const animation of element.getAnimations()) animation.cancel();
  return element.animate(
    [
      { opacity: 0, transform: `${base} translateY(${shift}px)`.trim() },
      { opacity: 1, transform: base || "none" },
    ],
    { duration, easing: APPEAR_EASING },
  );
}
// Незаписанная правка заметки: карточку закрывают крестиком, фоном и Esc —
// и во всех трёх случаях набранное должно остаться, а не пропасть.
let flushCardBody = null;
// Поле заметки пересоздаётся на каждое открытие карточки, а меню разметки
// вешает слушатель на документ: без уборки они копились бы с каждым разом.
let closeCardSlashMenu = null;
function closeCard() {
  const dialog = $("#review-dialog");
  // Сохранение уходит своим ходом: карточка закрывается сразу, но значение
  // поля читается сейчас, пока разметка ещё на месте.
  const flush = flushCardBody;
  flushCardBody = null;
  flush?.();
  closeCardSlashMenu?.();
  if (!dialog.open) {
    clear($("#review"));
    return;
  }
  const finish = () => {
    if (dialog.open) dialog.close();
    clear($("#review"));
    // Анимация закрытия держит карточку прозрачной (fill: forwards): не снять
    // её — и при следующем открытии карточка окажется невидимой.
    for (const animation of dialog.getAnimations()) animation.cancel();
  };
  if (!motionAllowed()) return finish();
  // Уходит карточка так же тихо, как пришла: гаснет на месте, никуда не едет.
  const animation = dialog.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(6px)" },
    ],
    { duration: FADE_DURATION, easing: "ease-in", fill: "forwards" },
  );
  animation.finished.then(finish, finish);
}
// Карточка открывается модальным окном, а не панелью внутри страницы: панель
// жила в разделе «Сегодня» и на страницах журнала строилась на скрытой
// странице — кнопка срабатывала, но человек не видел ничего.
function propertyRow(label, control) {
  const row = node("div", undefined, "prop");
  row.append(node("span", label, "prop-label"), control);
  return row;
}
// ── вложения записи ──────────────────────────────────────────────────────────
// Файл живёт рядом с записью, а не внутри текста: заметку правят словами, а
// снимок доски или счёт прикладывают как есть.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic"]);
function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
// Быстрый предпросмотр: картинка открывается прямо здесь, PDF — рамкой,
// остальное честно предлагается скачать.
function previewAttachment(attachment) {
  const dialog = $("#preview-dialog"),
    body = $("#preview-body"),
    title = $("#preview-title"),
    download = $("#preview-download");
  clear(body);
  title.textContent = attachment.filename;
  download.href = `/api/attachments/${attachment.id}`;
  download.download = attachment.filename;
  if (IMAGE_TYPES.has(attachment.contentType)) {
    const image = node("img", undefined, "preview-image");
    image.src = `/api/attachments/${attachment.id}`;
    image.alt = attachment.filename;
    body.append(image);
  } else if (attachment.contentType === "application/pdf") {
    const frame = node("iframe", undefined, "preview-frame");
    frame.src = `/api/attachments/${attachment.id}`;
    frame.title = attachment.filename;
    body.append(frame);
  } else {
    body.append(
      node("p", `${attachment.contentType || "файл"} · ${fileSize(attachment.size)}`, "preview-plain"),
    );
  }
  if (!dialog.open) dialog.showModal();
  appear(dialog, { shift: 8 });
}
function attachmentsBlock(entry) {
  const wrap = node("section", undefined, "card-files"),
    label = node("p", "Вложения", "prop-section"),
    grid = node("div", undefined, "file-grid"),
    hint = node("p", "Перетащите файл сюда или выберите — до 10 файлов, каждый до 10 МБ.", "card-body-hint"),
    input = document.createElement("input"),
    add = node("button", "Добавить файл", "secondary");
  let files = entry.attachments || [];
  input.type = "file";
  input.multiple = true;
  input.className = "sr-only";
  input.id = `attach-${entry.id}`;
  add.type = "button";
  add.addEventListener("click", () => input.click());

  const paint = () => {
    clear(grid);
    if (!files.length) grid.append(node("p", "Пока пусто.", "empty"));
    for (const attachment of files) {
      const tile = node("div", undefined, "file-tile"),
        open = node("button", undefined, "file-open"),
        remove = node("button", "×", "file-remove");
      open.type = "button";
      open.title = `${attachment.filename} · ${fileSize(attachment.size)}`;
      if (IMAGE_TYPES.has(attachment.contentType)) {
        const thumb = node("img", undefined, "file-thumb");
        thumb.src = `/api/attachments/${attachment.id}`;
        thumb.alt = attachment.filename;
        thumb.loading = "lazy";
        open.append(thumb);
      } else {
        open.append(
          node("span", attachment.contentType === "application/pdf" ? "PDF" : "ФАЙЛ", "file-kind"),
        );
      }
      open.append(node("span", attachment.filename, "file-name"));
      open.addEventListener("click", () => previewAttachment(attachment));
      remove.type = "button";
      remove.title = "Убрать вложение";
      remove.setAttribute("aria-label", `Убрать ${attachment.filename}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const result = await request(`/api/attachments/${attachment.id}`, { method: "DELETE" });
          files = result.attachments;
          paint();
          load();
        } catch (error) {
          toast(error.message);
          remove.disabled = false;
        }
      });
      tile.append(open, remove);
      grid.append(tile);
    }
  };

  const upload = async (list) => {
    for (const file of list) {
      try {
        const response = await fetch(`/api/captures/${entry.id}/attachments`, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Attachment-Name": encodeURIComponent(file.name),
          },
          body: file,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message || "Файл не приложился.");
        files = payload.attachments;
        paint();
      } catch (error) {
        toast(error.message);
      }
    }
    load();
  };
  input.addEventListener("change", () => {
    const chosen = [...(input.files || [])];
    input.value = "";
    if (chosen.length) upload(chosen);
  });
  // Перетаскивание — самый короткий путь для снимка экрана: он и так в буфере.
  for (const event of ["dragover", "dragenter"])
    wrap.addEventListener(event, (dropEvent) => {
      dropEvent.preventDefault();
      wrap.classList.add("dropping");
    });
  for (const event of ["dragleave", "drop"])
    wrap.addEventListener(event, () => wrap.classList.remove("dropping"));
  wrap.addEventListener("drop", (dropEvent) => {
    dropEvent.preventDefault();
    const dropped = [...(dropEvent.dataTransfer?.files || [])];
    if (dropped.length) upload(dropped);
  });

  paint();
  wrap.append(label, grid, add, input, hint);
  return wrap;
}
// Тело заметки — отдельная пользовательская сущность, а не правка raw:
// контракт памяти запрещает менять источник, поэтому оно версионируется
// на сервере со ссылкой supersedes.
function cardBody(entry) {
  const wrap = node("section", undefined, "card-body"),
    hint = node("p", "Markdown оформляется прямо в тексте · ⌘/Ctrl + Enter — сохранить · закроете карточку — сохранится само", "card-body-hint"),
    label = node("p", "Заметки", "prop-section"),
    origin = node("span", " · из исходной записи", "prop-origin");
  // Пока своей заметки нет, тело начинается с текста записи: дописывать проще,
  // чем набирать заново. Это копия в заметку — сам raw остаётся неизменным и
  // по-прежнему виден в блоке «Источник и версия».
  let body = entry.note?.body ?? (entry.raw || "");
  const paintLabel = () => {
    origin.textContent = entry.note
      ? ` · версия ${entry.note.version}`
      : " · из исходной записи";
  };
  paintLabel();
  label.append(origin);
  // Тело — то же живое поле, что и в карточке ввода: разметка оформляется
  // прямо в тексте, поэтому отдельный режим просмотра и предпросмотр больше
  // не нужны — читать и править можно в одном месте.
  const field = createMarkdownField({
    id: "card-body-editor",
    ariaLabel: "Заметки к записи",
    placeholder: "Добавьте заметки в Markdown…",
    onSubmit: () => save(),
  });
  field.element.classList.add("card-markdown");
  // Разметку помнить наизусть незачем: «/» показывает, что тут вообще бывает.
  closeCardSlashMenu?.();
  const slashMenu = attachSlashMenu(field);
  closeCardSlashMenu = () => { slashMenu.destroy(); closeCardSlashMenu = null; };
  field.setValue(body);
  hint.hidden = true;

  // Отключение поля снимает фокус и вызывает blur, а тот сохраняет: без флага
  // заметка сохранялась бы дважды.
  let saving = false;
  const save = async () => {
    if (saving) return;
    const next = field.getValue();
    if (next === body) return;
    saving = true;
    field.setDisabled(true);
    try {
      const result = await request(`/api/captures/${entry.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: next }),
      });
      body = result.entry.note?.body || "";
      entry.note = result.entry.note;
      field.setValue(body);
      paintLabel();
      toast("Заметка сохранена");
      await load();
    } catch (error) {
      toast(error.message);
    } finally {
      saving = false;
      field.setDisabled(false);
    }
  };
  field.element.addEventListener("focus", () => {
    hint.hidden = false;
  });
  // Esc не откатывает набранное: раньше он возвращал прежний текст, и правка,
  // сделанная перед закрытием карточки, пропадала. Теперь он просто уводит
  // фокус — на blur заметка сохраняется, как и при закрытии.
  field.element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      hint.hidden = true;
      field.element.blur();
    }
  });
  field.element.addEventListener("blur", () => {
    hint.hidden = true;
    save();
  });
  flushCardBody = save;
  wrap.append(label, field.element, hint);
  return wrap;
}
// Карточка открывается модальным окном, а не панелью внутри страницы: панель
// жила в разделе «Сегодня» и на страницах журнала строилась на скрытой
// странице — кнопка срабатывала, но человек не видел ничего.
function showReview(entry, review, undoGroupId, provenance) {
  const area = $("#review"),
    dialog = $("#review-dialog"),
    c = entry.interpretation.classification;
  clear(area);
  if (review.level === "high") {
    closeCard();
    return;
  }
  area.append(markdownNode("h2", c.summary, undefined, { inline: true, firstLine: true }));
  // Когда запись сделана — в самой карточке: «Срок» ниже это про будущее, а
  // здесь ответ на вопрос «когда это было».
  const written = entryClock(entry);
  if (written) area.append(node("p", `Записано: ${written}`, "card-written"));
  if (review.question)
    area.append(node("p", review.question, "review-question"));

  const form = node("form", undefined, "review-form"),
    type = document.createElement("select"),
    date = document.createElement("input"),
    time = document.createElement("input"),
    project = document.createElement("input"),
    people = document.createElement("input"),
    followUp = document.createElement("input"),
    doneToggle = node("button", undefined, "completion-button");
  type.id = "review-primary-type";
  type.setAttribute("aria-label", "Тип записи");
  for (const [value, label] of Object.entries(typeNames)) {
    const option = node("option", label);
    option.value = value;
    option.selected = value === c.primaryType;
    type.append(option);
  }
  date.type = "date";
  date.id = "review-date";
  date.value = c.entities.schedule?.date || "";
  time.type = "time";
  time.id = "review-time";
  time.value = c.entities.schedule?.time || "";
  project.id = "review-project";
  project.setAttribute("list", "known-projects");
  project.value = c.entities.projects[0] || "";
  project.placeholder = "Например, Hub";
  people.id = "review-people";
  people.value = (c.entities.people || []).join(", ");
  people.placeholder = "Например, Анна, BE";
  followUp.id = "review-follow-up";
  followUp.value = c.entities.followUp || "";
  followUp.placeholder = "Следующее действие";
  // Признак «уже сделано» ставила только модель, и исправить её решение было
  // нечем: заметка, принятая за отчёт, навсегда оставалась в «Что делал».
  let done = Boolean(c.completed);
  doneToggle.id = "review-completed";
  doneToggle.type = "button";
  const paintDone = () => {
    doneToggle.setAttribute("aria-pressed", String(done));
    doneToggle.title = done ? "Отметить как незавершённое" : "Отметить как сделанное";
    doneToggle.setAttribute("aria-label", doneToggle.title);
    doneToggle.classList.toggle("is-done", done);
  };
  doneToggle.addEventListener("click", () => { done = !done; paintDone(); });
  paintDone();

  const scheduleRow = node("div", undefined, "review-schedule");
  scheduleRow.append(date, time);
  const scheduleWrap = propertyRow("Срок", scheduleRow),
    peopleWrap = propertyRow("Участники", people),
    followUpWrap = propertyRow("Далее", followUp);
  const props = node("div", undefined, "props");
  props.append(
    propertyRow("Тип", type),
    scheduleWrap,
    propertyRow("Проект", project),
    peopleWrap,
    followUpWrap,
    propertyRow("Сделано", doneToggle),
  );
  form.append(props);
  const updateVisibility = () => {
    const scheduled =
      ["meeting_event", "task"].includes(type.value) || review.field === "schedule";
    scheduleWrap.hidden = !scheduled;
    peopleWrap.hidden = type.value === "note" || type.value === "idea_question";
    followUpWrap.hidden =
      type.value === "note" || type.value === "idea_question";
  };
  type.addEventListener("change", updateVisibility);
  updateVisibility();
  const apply = node("button", "Сохранить уточнение", "secondary");
  apply.type = "submit";
  form.append(apply);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (correctionInFlight) return;
    correctionInFlight = true;
    apply.disabled = true;
    const patch = {
      primaryType: type.value,
      project: project.value.trim() || null,
      people: people.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      followUp: followUp.value.trim() || null,
      completed: done,
      note: "Пользователь исправил классификацию",
    };
    if (!scheduleWrap.hidden)
      patch.schedule = { date: date.value || null, time: time.value || null };
    try {
      const result = await request(`/api/captures/${entry.id}/corrections`, {
        method: "POST",
        body: JSON.stringify({ patch }),
      });
      toast(
        result.review.level === "high" || result.review.safeNote
          ? "Уточнение сохранено"
          : "Нужно ещё одно уточнение",
      );
      showReview(result.entry, result.review, result.undoGroupId);
      await load();
    } catch (error) {
      toast(error.message);
    } finally {
      correctionInFlight = false;
      apply.disabled = false;
    }
  });
  area.append(form, cardBody(entry), attachmentsBlock(entry));

  const source = node("details", undefined, "card-source");
  source.append(node("summary", "Источник и версия"));
  // Пока заметку не правили, её тело — копия исходной записи, и показывать
  // один и тот же текст дважды незачем: остаётся только строка версии.
  const noteBody = entry.note?.body ?? (entry.raw || "");
  const sameAsRaw = noteBody.trim() === (entry.raw || "").trim();
  const raw = node("div", undefined, "review-raw");
  if (sameAsRaw) raw.append(node("p", "Исходная запись совпадает с заметками.", "entry-meta"));
  else raw.append(node("p", "Исходная запись:", "source-label"), markdownNode("div", entry.raw, undefined));
  const provider = provenance?.usedProvider || entry.interpretation.provider;
  source.append(
    raw,
    node(
      "p",
      `Версия ${entry.interpretation.version} · ${providerNames[provider] || "исправлено вами"}${fallbackSuffix(provenance)}`,
      "entry-meta",
    ),
  );
  area.append(source);

  // Удаление живёт внизу карточки, отдельно от правок: это не «ещё одно
  // уточнение», а выход из журнала.
  const remove = node("button", "Удалить запись", "card-delete");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    // Записи больше не будет: сохранять в неё заметку незачем.
    flushCardBody = null;
    remove.disabled = true;
    try {
      await request(`/api/captures/${entry.id}`, { method: "DELETE" });
      closeCard();
      await load();
      toast("Запись удалена", {
        label: "Вернуть",
        run: async () => {
          try {
            await request(`/api/captures/${entry.id}/restore`, { method: "POST" });
            await load();
            toast("Запись возвращена");
          } catch (error) {
            toast(error.message);
          }
        },
      });
    } catch (error) {
      toast(error.message);
      remove.disabled = false;
    }
  });
  area.append(remove);
  if (!dialog.open) {
    // Прерванное закрытие могло оставить незавершённую анимацию: снимаем её,
    // иначе карточка откроется прозрачной.
    for (const animation of dialog.getAnimations()) animation.cancel();
    dialog.showModal();
    // Только при открытии: после сохранения уточнения карточка
    // перерисовывается на месте, и проявлять её заново незачем.
    appear(dialog);
    // Фокус на самой карточке: иначе он уходит на крестик или на селектор
    // типа, хотя карточку открывают ради заметок.
    dialog.focus();
  }
}
function showCorrection(
  entry,
  // Без вопроса: карточку открывают просто чтобы посмотреть или дописать
  // заметку, и красная строка «выберите тип» была бы ложной тревогой.
  review = { level: "medium", question: null },
) {
  showReview(entry, review, entry.projections[0]?.undoGroupId);
}
async function reclassifyEntry(entry) {
  try {
    const result = await request(`/api/captures/${entry.id}/classify`, {
      method: "POST",
      body: JSON.stringify(withProvider()),
    });
    showProvenance(result.provenance);
    showReview(
      result.entry,
      result.review,
      result.undoGroupId,
      result.provenance,
    );
    toast("Запись разобрана заново");
    await load();
  } catch (error) {
    toast(error.message);
  }
}
async function undoGroup(undoGroupId) {
  try {
    const result = await request("/api/undo", {
      method: "POST",
      body: JSON.stringify({ undoGroupId }),
    });
    toast(result.reverted ? "Последнее действие отменено" : "Уже отменено");
    await load();
  } catch (error) {
    toast(error.message);
  }
}
function captureState(job) {
  if (job.state === "succeeded") return "Готово";
  if (job.state === "failed") return "Не удалось разобрать";
  if (job.state === "cancelled") return "Отменено";
  if (job.state === "running" || job.stage === "classifying")
    return "ИИ разбирает запись";
  return job.stage === "saved" ? "Запись сохранена" : "В очереди";
}
function terminal(job) {
  return ["succeeded", "failed", "cancelled"].includes(job.state);
}
function safeCaptureEnvelope(data) {
  return (
    data &&
    typeof data.captureId === "string" &&
    typeof data.jobId === "string" &&
    typeof data.statusUrl === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(data.captureId) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(data.jobId) &&
    data.statusUrl === `/api/jobs/${data.jobId}`
  );
}
function persistActiveCaptures() {
  const records = [...activeCaptures.values()].map(({ timer, delay, ...record }) => record);
  if (records.length) localStorage.setItem(activeCaptureStorageKey, JSON.stringify(records));
  else localStorage.removeItem(activeCaptureStorageKey);
  localStorage.removeItem(legacyActiveCaptureStorageKey);
}
function activeCapture(record) {
  return activeCaptures.get(record.jobId);
}
function removeCapture(record) {
  const current = activeCapture(record);
  if (current?.timer) clearTimeout(current.timer);
  activeCaptures.delete(record.jobId);
  document.querySelector(`[data-capture-job="${CSS.escape(record.jobId)}"]`)?.remove();
  persistActiveCaptures();
}
function registerCapture(record) {
  const previous = activeCapture(record);
  if (previous?.timer) clearTimeout(previous.timer);
  activeCaptures.set(record.jobId, { ...record, delay: 1000, timer: null });
  persistActiveCaptures();
  return activeCapture(record);
}
function renderCaptureProgress(job, record) {
  const area = $("#capture-notifications");
  let card = area.querySelector(`[data-capture-job="${CSS.escape(record.jobId)}"]`);
  if (!card) {
    card = node("section", undefined, "capture-notification");
    card.dataset.captureJob = record.jobId;
    card.setAttribute("role", "status");
    area.prepend(card);
  }
  clear(card);
  card.className = `capture-notification state-${job.state}`;
  const state = captureState(job),
    stateLine = node("p", undefined, "progress-state");
  if (!terminal(job)) stateLine.append(node("span", undefined, "spinner"));
  stateLine.append(node("span", state));
  card.append(
    stateLine,
    node("p", record.raw, "progress-raw"),
  );
  if (record.duplicateCaptureId)
    card.append(
      node(
        "p",
        "Похожая запись уже есть в журнале — возможно, дубль.",
        "progress-raw",
      ),
    );
  if (job.state === "failed")
    card.append(
      node("p", "Запись сохранена, но не классифицирована.", "progress-raw"),
    );
  if (job.state === "cancelled")
    card.append(
      node(
        "p",
        "Классификация отменена; исходная запись сохранена.",
        "progress-raw",
      ),
    );
  const actions = node("div", undefined, "progress-actions");
  if (!terminal(job)) {
    const cancel = node("button", "Отменить классификацию", "text-button");
    cancel.addEventListener("click", () => cancelCapture(record, cancel));
    actions.append(cancel);
  } else if (job.retryable) {
    const retry = node(
      "button",
      record.provider === "fallback"
        ? "Повторить локальную классификацию"
        : "Повторить с тем же провайдером (может использовать лимит)",
      "text-button",
    );
    retry.addEventListener("click", () => retryCapture(job, record, retry));
    actions.append(retry);
  }
  if (terminal(job)) {
    const close = node("button", "Закрыть уведомление", "notification-close");
    close.setAttribute("aria-label", "Закрыть уведомление");
    close.addEventListener("click", () => removeCapture(record));
    actions.append(close);
  }
  if (actions.childNodes.length) card.append(actions);
  if (job.state === "succeeded") {
    window.setTimeout(() => removeCapture(record), 2400);
  }
}
// Зеркало серверного gateClassification: уровень определяет модель через
// ambiguity, а не пороги уверенности.
function reviewFromEntry(entry) {
  const c = entry.interpretation.classification;
  if (c.unclassified)
    return {
      level: "low",
      question: "Запись сохранена без разбора: укажите тип.",
      field: "type",
      safeNote: true,
    };
  const ambiguity = c.ambiguity;
  if (ambiguity?.field) {
    const conflicting =
      ambiguity.field === "schedule" || ambiguity.field === "projects";
    return {
      level: conflicting ? "conflict" : "low",
      question: ambiguity.question || null,
      field: ambiguity.field,
      ...(ambiguity.field === "type" ? { safeNote: true } : {}),
    };
  }
  return { level: "high", question: null, field: null };
}
function scheduleCapturePoll(record) {
  const current = activeCapture(record);
  if (!current) return;
  current.timer = setTimeout(() => pollCapture(record), current.delay);
}
async function pollCapture(record) {
  if (!activeCapture(record)) return;
  try {
    const job = await request(record.statusUrl);
    if (!activeCapture(record)) return;
    renderCaptureProgress(job, record);
    if (terminal(job)) {
      activeCapture(record).terminal = true;
      if (job.state === "succeeded") {
        await load();
        if (!activeCapture(record)) return;
        toast("Готово: запись разобрана");
        return;
      }
      persistActiveCaptures();
      return;
    }
    activeCapture(record).delay = Math.min(activeCapture(record).delay * 2, 5000);
  } catch {
    if (!activeCapture(record)) return;
    activeCapture(record).delay = Math.min(activeCapture(record).delay * 2, 5000);
    toast("Не удалось проверить статус классификации. Повторим автоматически.");
  } finally {
    if (activeCapture(record) && !activeCapture(record).terminal)
      scheduleCapturePoll(record);
  }
}
function startCapturePolling(record) {
  registerCapture(record);
  renderCaptureProgress({ state: "pending", stage: "saved" }, record);
  activeCapture(record).timer = setTimeout(() => pollCapture(record), 0);
}
async function cancelCapture(record, button) {
  button.disabled = true;
  const current = activeCapture(record);
  if (current?.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  try {
    const job = await request(`/api/jobs/${record.jobId}/cancel`, {
      method: "POST",
      body: "{}",
    });
    if (!activeCapture(record)) return;
    renderCaptureProgress(job, record);
    if (terminal(job)) {
      activeCapture(record).terminal = true;
      persistActiveCaptures();
    }
  } catch (error) {
    if (activeCapture(record)) {
      toast(error.message);
      button.disabled = false;
      activeCapture(record).delay = 1000;
      scheduleCapturePoll(record);
    }
  }
}
async function retryCapture(job, record, button) {
  button.disabled = true;
  try {
    const retry = await request(`/api/jobs/${job.id}/retry`, {
      method: "POST",
      body: "{}",
    });
    if (!activeCapture(record) || !safeCaptureEnvelope(retry))
      throw new Error("Сервер не подтвердил повторную классификацию.");
    removeCapture(record);
    startCapturePolling({ ...record, jobId: retry.jobId, statusUrl: retry.statusUrl });
  } catch (error) {
    if (activeCapture(record)) {
      toast(error.message);
      button.disabled = false;
    }
  }
}
// ── Карточка ввода: тип, срок, важность, теги ─────────────────────────────
// UI говорит на языке трёх типов; сервер отображает их на внутренние типы
// журнала (todo→task, outcome→outcome_decision, note→note).
// Поле записи: Markdown оформляется прямо в нём, по мере набора.
const captureField = createMarkdownField({
  id: "capture-input",
  ariaLabel: "Новая запись",
  placeholder: "Запишите мысль, план, встречу или итог дня",
  onInput: (value) => paintCaptureAction(value),
  onSubmit: () => $("#capture-form").requestSubmit(),
});
$("#capture-form").prepend(captureField.element);
attachSlashMenu(captureField);
// Одна кнопка на два дела: пока писать нечего — это разговор, как только
// появился текст — отправка. Две кнопки рядом заставляли бы выбирать там, где
// выбор уже сделан тем, что набрано (или не набрано).
function paintCaptureAction(value = captureField.getValue()) {
  const typing = Boolean(String(value).trim());
  // Пока разговор идёт, кнопку не прячем даже с текстом: она сейчас — «закончить
  // разговор», и убирать её значило бы отнять единственную привычную дверь.
  const talking = $("#capture-voice").getAttribute("aria-pressed") === "true";
  $("#capture-voice").hidden = typing && !talking;
  $("#capture-submit").hidden = !typing;
}
// Начало и конец разговора меняют роль кнопки, а ввода при этом может и не быть.
$("#capture-voice").addEventListener("click", () => setTimeout(paintCaptureAction, 0));
paintCaptureAction();
const captureTypes = [
  { value: "auto", label: "Авто", cssVar: "auto", placeholder: "Запишите мысль, план, встречу или итог дня" },
  { value: "todo", label: "ТУДУ", cssVar: "todo", placeholder: "Что нужно сделать — и когда" },
  { value: "outcome", label: "Результат", cssVar: "outcome", placeholder: "Что решили или что уже сделано" },
  { value: "note", label: "Заметка", cssVar: "note", placeholder: "Наблюдение, идея, открытый вопрос" },
];
const composerState = { type: "auto", date: null, time: null, priority: "normal", tags: [] };
let knownTags = [];
async function refreshKnownTags() {
  try {
    const response = await fetch("/api/tags");
    if (response.ok) knownTags = (await response.json()).tags || [];
  } catch {}
}
function composerOverridesBody() {
  const body = {};
  if (composerState.type !== "auto") body.primaryType = composerState.type;
  if (composerState.type === "todo" && composerState.date)
    body.due = { date: composerState.date, ...(composerState.time ? { time: composerState.time } : {}) };
  if (composerState.type === "todo" && composerState.priority !== "normal")
    body.priority = composerState.priority;
  if (composerState.tags.length) body.tags = [...composerState.tags];
  return body;
}
function resetComposerOverrides() {
  composerState.type = "auto";
  composerState.date = null;
  composerState.time = null;
  composerState.priority = "normal";
  composerState.tags = [];
  renderCaptureControls();
  refreshKnownTags();
}
const captureIso = (shift) => {
  const day = new Date();
  day.setDate(day.getDate() + shift);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const typeDotsHost = $("#capture-types");
for (const type of captureTypes) {
  const button = node("button", undefined, "type-dot");
  button.type = "button";
  button.setAttribute("role", "tab");
  button.dataset.value = type.value;
  button.style.setProperty("--c", `var(--type-${type.cssVar})`);
  button.style.setProperty("--tint", `var(--tint-${type.cssVar})`);
  button.setAttribute("aria-label", type.label);
  button.append(node("span", undefined, "mark"), node("span", type.label, "label"));
  button.addEventListener("click", () => {
    composerState.type = type.value;
    if (composerState.type !== "todo") {
      composerState.date = null;
      composerState.time = null;
      composerState.priority = "normal";
    }
    renderCaptureControls();
  });
  typeDotsHost.append(button);
}

const todoLineHost = $("#capture-todo-line");
const quickDates = [
  ["Сегодня", 0],
  ["Завтра", 1],
  ["Неделя", 7],
];
const quickButtons = quickDates.map(([label, shift]) => {
  const button = node("button", label, "ghost");
  button.type = "button";
  button.dataset.shift = String(shift);
  button.addEventListener("click", () => {
    const date = captureIso(shift);
    composerState.date = composerState.date === date ? null : date;
    if (!composerState.date) composerState.time = null;
    renderCaptureControls();
  });
  return button;
});
const dateGhost = node("button", "дата…", "ghost");
dateGhost.type = "button";
const timeGhost = node("button", "время…", "ghost");
timeGhost.type = "button";
const dateHidden = document.createElement("input");
dateHidden.type = "date";
dateHidden.tabIndex = -1;
dateHidden.setAttribute("aria-hidden", "true");
const timeHidden = document.createElement("input");
timeHidden.type = "time";
timeHidden.tabIndex = -1;
timeHidden.setAttribute("aria-hidden", "true");
const dateAnchor = node("span", undefined, "picker-anchor");
dateAnchor.append(dateGhost, dateHidden);
const timeAnchor = node("span", undefined, "picker-anchor");
timeAnchor.append(timeGhost, timeHidden);
function openHiddenPicker(input) {
  input.style.pointerEvents = "auto";
  try {
    input.showPicker?.();
  } catch {
    input.focus();
  }
  input.style.pointerEvents = "none";
}
dateGhost.addEventListener("click", () => openHiddenPicker(dateHidden));
timeGhost.addEventListener("click", () => openHiddenPicker(timeHidden));
dateHidden.addEventListener("change", () => {
  composerState.date = dateHidden.value || null;
  if (!composerState.date) composerState.time = null;
  renderCaptureControls();
});
timeHidden.addEventListener("change", () => {
  composerState.time = timeHidden.value || null;
  renderCaptureControls();
});
const priorityButtons = [
  { value: "low", label: "⌄ не срочно", className: "ghost prio-low" },
  { value: "high", label: "⌃ важно", className: "ghost prio-high" },
].map((level) => {
  const button = node("button", level.label, level.className);
  button.type = "button";
  button.dataset.value = level.value;
  button.addEventListener("click", () => {
    composerState.priority = composerState.priority === level.value ? "normal" : level.value;
    renderCaptureControls();
  });
  return button;
});
const todoSep = node("span", "·", "sep");
todoLineHost.append(...quickButtons, dateAnchor, timeAnchor, todoSep, ...priorityButtons);

const tagsHost = $("#capture-tags");
const tagInput = document.createElement("input");
tagInput.className = "tag-input";
tagInput.placeholder = "#тег…";
tagInput.setAttribute("aria-label", "Теги");
const tagSuggest = node("div", undefined, "tag-suggest");
tagSuggest.hidden = true;
let tagCursor = 0;
function closeTagSuggest() {
  tagSuggest.hidden = true;
  tagCursor = 0;
}
function addCaptureTag(value) {
  const tag = value.trim().replace(/^#/, "").toLowerCase();
  if (!tag || tag.length > 40 || composerState.tags.includes(tag) || composerState.tags.length >= 8) return;
  composerState.tags.push(tag);
  tagInput.value = "";
  closeTagSuggest();
  renderCaptureControls();
}
function openTagSuggest() {
  const query = tagInput.value.trim().replace(/^#/, "").toLowerCase();
  const matches = knownTags
    .filter((tag) => !composerState.tags.includes(tag) && (!query || tag.startsWith(query)))
    .slice(0, 5);
  if (!matches.length) return closeTagSuggest();
  clear(tagSuggest);
  matches.forEach((tag, index) => {
    const option = node("button", `#${tag}`, index === tagCursor ? "cursor" : undefined);
    option.type = "button";
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      addCaptureTag(tag);
    });
    tagSuggest.append(option);
  });
  tagSuggest.style.left = `${tagInput.offsetLeft}px`;
  tagSuggest.hidden = false;
}
tagInput.addEventListener("input", () => {
  tagCursor = 0;
  openTagSuggest();
});
tagInput.addEventListener("focus", openTagSuggest);
tagInput.addEventListener("blur", () => setTimeout(closeTagSuggest, 80));
tagInput.addEventListener("keydown", (event) => {
  const options = [...tagSuggest.querySelectorAll("button")];
  if (event.key === "Enter") {
    event.preventDefault();
    addCaptureTag(!tagSuggest.hidden && options[tagCursor] ? options[tagCursor].textContent : tagInput.value);
  } else if (event.key === "Backspace" && !tagInput.value && composerState.tags.length) {
    composerState.tags.pop();
    renderCaptureControls();
  } else if (event.key === "Escape") {
    closeTagSuggest();
  } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !tagSuggest.hidden) {
    event.preventDefault();
    tagCursor = (tagCursor + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options.forEach((option, index) => option.classList.toggle("cursor", index === tagCursor));
  }
});

function renderCaptureControls() {
  const type = captureTypes.find((item) => item.value === composerState.type);
  for (const button of typeDotsHost.querySelectorAll("button"))
    button.setAttribute("aria-selected", String(button.dataset.value === composerState.type));
  captureField.setPlaceholder(type.placeholder);
  todoLineHost.hidden = composerState.type !== "todo";
  for (const button of quickButtons)
    button.setAttribute("aria-pressed", String(captureIso(Number(button.dataset.shift)) === composerState.date));
  const isQuick = quickDates.some(([, shift]) => captureIso(shift) === composerState.date);
  const customDate = composerState.date && !isQuick;
  dateGhost.textContent = customDate
    ? composerState.date.split("-").reverse().slice(0, 2).join(".")
    : "дата…";
  dateGhost.setAttribute("aria-pressed", String(Boolean(customDate)));
  dateHidden.value = composerState.date || "";
  timeAnchor.hidden = !composerState.date;
  timeGhost.textContent = composerState.time || "время…";
  timeGhost.setAttribute("aria-pressed", String(Boolean(composerState.time)));
  timeHidden.value = composerState.time || "";
  for (const button of priorityButtons)
    button.setAttribute("aria-pressed", String(button.dataset.value === composerState.priority));
  for (const chip of tagsHost.querySelectorAll(".tag-chip")) chip.remove();
  const chips = composerState.tags.map((tag) => {
    const chip = node("span", undefined, "tag-chip");
    chip.append(document.createTextNode(`#${tag}`));
    const remove = node("button", "✕");
    remove.type = "button";
    remove.setAttribute("aria-label", `Убрать тег ${tag}`);
    remove.addEventListener("click", () => {
      composerState.tags = composerState.tags.filter((item) => item !== tag);
      renderCaptureControls();
    });
    chip.append(remove);
    return chip;
  });
  tagsHost.prepend(...chips);
}
tagsHost.append(tagInput, tagSuggest);
renderCaptureControls();
refreshKnownTags();

// Лист: карточка выходит на передний план и вписывается в окно листом A4.
// DOM не перестраивается — переключаются два класса, поэтому текст, каретка и
// история отмены остаются на месте, а появление можно анимировать.
const expandButton = $("#capture-expand");
function captureLarge() {
  return $("#capture-form").classList.contains("capture-large");
}
function setCaptureLarge(large) {
  const form = $("#capture-form");
  // Лист не летит и не растёт на глазах: раскладка ставит его на место, а
  // движение только показывает, что он появился. Тот же характер, что у
  // кольца в разговоре.
  form.classList.toggle("capture-large", large);
  document.body.classList.toggle("capture-large-open", large);
  appear(form, { shift: large ? 12 : 6, base: large ? "translate(-50%, -50%)" : "" });
  expandButton.setAttribute("aria-pressed", String(large));
  const label = large ? "Свернуть поле — Esc" : "Увеличить поле";
  expandButton.setAttribute("aria-label", label);
  expandButton.title = label;
  captureField.focus();
}
expandButton.addEventListener("click", () => setCaptureLarge(!captureLarge()));
// Esc возвращает обычный размер. Слушатель на самом поле: там же живут
// остальные клавиши ввода, и поповеры шапки перехватывать не приходится.
captureField.element.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && captureLarge()) {
    event.preventDefault();
    event.stopPropagation();
    setCaptureLarge(false);
  }
});

// Голосовой диалог: кнопка рядом с «развернуть», панель — под карточкой.
// Записи, сделанные голосом, сразу видны в журнале, поэтому после каждого
// изменения перезагружаем списки.
const voiceDialog = createVoiceDialog({
  onJournalChanged: () => load(),
  // Разговор начинается тем провайдером, которого выбрали в шапке.
  voiceProvider: () => selectedVoiceProvider(),
  // Через сколько тишины засыпать и по какому слову просыпаться — из настроек.
  sleepAfterMs: () => Number(appSettings.sleepAfterSeconds || 25) * 1000,
  wakeWord: () => appSettings.wakeWord || "кизуна",
  // А сказанное разбирает та же модель, что и напечатанное.
  captureProvider: () => (providerReady() ? selectedProvider() : null),
  // Кнопка разговора показывает состояние панели, а закрыть панель можно и
  // изнутри — крестиком или Esc.
  onClosed: () => $("#capture-voice").setAttribute("aria-pressed", "false"),
});
$("#capture-form").after(voiceDialog.element);
const voiceButton = $("#capture-voice");
function toggleVoice() {
  if (voiceDialog.isOpen()) {
    voiceDialog.stop();
    voiceButton.setAttribute("aria-pressed", "false");
    captureField.focus();
    return;
  }
  voiceButton.setAttribute("aria-pressed", "true");
  voiceDialog.open();
}
voiceButton.addEventListener("click", toggleVoice);

function idempotencyKey() {
  return `capture-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
function setCaptureBusy(isBusy) {
  $("#capture-submit").disabled = isBusy;
  captureField.setDisabled(isBusy);
}
$("#capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#capture-submit").disabled) return;
  const raw = captureField.getValue().trim();
  if (!raw) return;
  setCaptureBusy(true);
  try {
    const provider = providerReady() ? selectedProvider() : null,
      result = await requestResponse("/api/captures", {
        method: "POST",
        headers: {
          Prefer: "respond-async",
          "Idempotency-Key": idempotencyKey(),
        },
        body: JSON.stringify(withProvider({ raw, ...composerOverridesBody() })),
      });
    if (result.response.status !== 202 || !safeCaptureEnvelope(result.data))
      throw new Error("Сервер не подтвердил асинхронное сохранение.");
    captureField.clear();
    if (captureLarge()) setCaptureLarge(false);
    // Параметры действуют на одну запись: залипший тип или «важно» молча
    // испортили бы следующие записи.
    resetComposerOverrides();
    startCapturePolling({ ...result.data, raw, provider: provider || "fallback" });
    // Потолок исчерпан — запись сохранится, но разберут её правила. Сказать об
    // этом надо сразу: иначе человек решит, что разбор сломался.
    if (result.data.spend && !result.data.spend.allowed)
      toast("Потолок расходов исчерпан: запись сохранена, но разобрана по правилам");
  } catch (error) {
    toast(error.message);
  } finally {
    setCaptureBusy(false);
  }
});

$("#memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (memoryController) return;
  const query = $("#memory-input").value.trim();
  if (!query) return;
  const area = $("#memory-result"),
    input = $("#memory-input"),
    button = $("#memory-form button");
  clear(area);
  memoryController = new AbortController();
  input.disabled = true;
  button.disabled = true;
  area.append(node("p", "Ищем в памяти…", "entry-meta"));
  try {
    const result = await request("/api/memory/answer", {
      method: "POST",
      body: JSON.stringify(withProvider({ query })),
      signal: memoryController.signal,
    });
    showProvenance(result.provenance);
    clear(area);
    const box = node("div", undefined, "answer");
    box.append(
      node(
        "strong",
        result.provenance.usedProvider === "fallback"
          ? "Поиск по памяти"
          : "Ответ памяти",
      ),
      markdownNode("div", result.answer, undefined),
    );
    area.append(box);
    const sources = node("div", undefined, "sources");
    for (const source of result.sources.filter((source) =>
      result.citationIds.includes(source.captureId),
    )) {
      const card = node("div", undefined, "source");
      card.append(node("strong", "Источник"), markdownNode("div", source.snippet, undefined, { inline: true }));
      sources.append(card);
    }
    area.append(sources);
  } catch (error) {
    if (error.name !== "AbortError") toast(error.message);
  } finally {
    memoryController = null;
    input.disabled = false;
    button.disabled = false;
  }
});
function shortModelName(model) {
  return String(model).split("/").pop().replace(/^gemini-/, "");
}
// В шапке остаётся одна короткая метка вместо двух подписанных селекторов и
// плашки статуса — подробности открываются в поповере.
function paintAiSummary() {
  const model = selectedModel();
  $("#ai-summary").textContent = model
    ? shortModelName(model)
    : providerNames[selectedProvider()] || "ИИ";
}
function renderModelPicker(data) {
  const wrapper = document.querySelector(".model-picker"),
    picker = $("#ai-model"),
    provider = selectedProvider(),
    models = modelCapableProviders.has(provider)
      ? data.providers[provider]?.models || []
      : [];
  if (!models.length) {
    wrapper.hidden = true;
    clear(picker);
    paintAiSummary();
    return;
  }
  const stored = localStorage.getItem(modelStorageKey);
  clear(picker);
  for (const entry of models) {
    const option = node("option", entry.name || entry.id);
    option.value = entry.id;
    picker.append(option);
  }
  picker.value = models.some((entry) => entry.id === stored)
    ? stored
    : data.providers[provider]?.model || models[0].id;
  wrapper.hidden = false;
}
function onProviderChange() {
  if (providerReady()) localStorage.setItem("pagent.ai-provider", selectedProvider());
  status().catch((error) => toast(error.message));
}
function onModelChange() {
  const model = $("#ai-model").value;
  if (model) localStorage.setItem(modelStorageKey, model);
  paintAiSummary();
}
// Голос умеют оба провайдера, и выбор между ними — не то же самое, что выбор
// модели разбора: голос и характер у них разные. Список показывается, только
// если выбирать есть из чего, а ключей в браузере всё так же нет — сервер
// присылает лишь признак «настроен».
const voiceProviderNames = { openai: "OpenAI", gemini: "Google Gemini" };
// Провайдер голоса выбирается в настройках и хранится на сервере: это про
// человека, а не про вкладку, поэтому localStorage здесь больше не нужен.
function selectedVoiceProvider() {
  return appSettings.voiceProvider || null;
}
async function status() {
  const stored = localStorage.getItem("pagent.ai-provider"),
    data = await request(
      `/api/status${stored ? `?selectedProvider=${encodeURIComponent(stored)}` : ""}`,
    ),
    selector = $("#ai-provider");
  clear(selector);
  for (const id of Object.keys(providerNames)) {
    const info = data.providers[id],
      option = node(
        "option",
        `${providerNames[id]}${info?.available ? "" : " — недоступен"}`,
      );
    option.value = id;
    option.disabled = id !== "fallback" && !info?.available;
    selector.append(option);
  }
  const chosen = stored || data.defaultProvider;
  selector.value = [...selector.options].some(
    (option) => option.value === chosen,
  )
    ? chosen
    : "fallback";
  renderModelPicker(data);
  const available =
      selectedProvider() === "fallback" ||
      data.providers[selectedProvider()]?.available,
    element = $("#ai-status");
  element.textContent = available
    ? `Выбран: ${providerNames[selectedProvider()]}`
    : `Выбран: ${providerNames[selectedProvider()]} — недоступен`;
  element.className = !available
    ? "status fallback"
    : selectedProvider() === "fallback"
      ? "status"
      : "status ai";
  paintAiSummary();
}
function resumeCapture() {
  try {
    const stored = JSON.parse(localStorage.getItem(activeCaptureStorageKey));
    const legacy = JSON.parse(localStorage.getItem(legacyActiveCaptureStorageKey));
    const records = Array.isArray(stored) ? stored : legacy ? [legacy] : [];
    for (const record of records)
      if (
        safeCaptureEnvelope(record) &&
        typeof record.raw === "string" &&
        typeof record.provider === "string" &&
        !activeCapture(record)
      )
        startCapturePolling(record);
  } catch {
    localStorage.removeItem(activeCaptureStorageKey);
    localStorage.removeItem(legacyActiveCaptureStorageKey);
  }
}
async function bootstrap() {
  if (bootstrapInFlight) {
    bootstrapQueued = true;
    return;
  }
  do {
    bootstrapQueued = false;
    bootstrapInFlight = true;
    try {
      await Promise.all([status(), load(), loadSettings()]);
      resumeCapture();
    } catch {
      toast("Не удалось загрузить данные. Повторим при восстановлении сети.");
    } finally {
      bootstrapInFlight = false;
    }
  } while (bootstrapQueued);
}
// ── настройки приложения ─────────────────────────────────────────────────────
// Всё, что раньше правилось в .env с перезапуском: ключи, провайдеры, голос,
// поведение разговора и вид журнала. Ключи наружу не отдаются — с сервера
// приходит только признак «настроен» и последние знаки.
const SETTING_FIELDS = [
  "openaiKey",
  "geminiKey",
  "openrouterKey",
  "voiceProvider",
  "voiceModel",
  "geminiVoiceModel",
  "voiceName",
  "geminiVoiceName",
  "sleepAfterSeconds",
  "wakeWord",
  "systemPrompt",
  "aiProvider",
  "timeZone",
  "previewLimit",
  "theme",
  "voiceEnabled",
  "voiceLimitWindow",
  "voiceLimitMinutes",
  "voiceLimitUsd",
  "voiceRateUsdPerMinute",
  "voiceGeminiRateUsdPerMinute",
  "monthlyLimitUsd",
];
const SECRET_FIELDS = ["openaiKey", "geminiKey", "openrouterKey"];
let appSettings = {};
function settingInput(name) {
  return document.getElementById(`setting-${name}`);
}
// Списки голосов приходят с сервера вместе с настройками: там же и род, от
// которого зависит, как модель говорит о себе.
function paintVoiceChoices(catalogue) {
  for (const [provider, field] of [
    ["openai", "voiceName"],
    ["gemini", "geminiVoiceName"],
  ]) {
    const picker = settingInput(field);
    if (!picker || !catalogue?.[provider]) continue;
    const chosen = picker.value;
    clear(picker);
    for (const voice of catalogue[provider]) {
      const option = node("option", voice.label);
      option.value = voice.id;
      picker.append(option);
    }
    if (chosen) picker.value = chosen;
  }
}
// Быстрое переключение голоса живёт там же, где выбор модели: и то и другое —
// «чем сейчас работать». Показывается, только когда есть из чего выбирать.
function paintVoiceQuickPicker(payload) {
  const label = document.querySelector(".voice-quick-picker"),
    picker = $("#voice-quick-provider");
  if (!label || !picker) return;
  const configured = Object.entries(payload.voice?.providers || {})
    .filter(([, info]) => info?.configured)
    .map(([id]) => id);
  for (const option of picker.options) option.hidden = !configured.includes(option.value);
  label.hidden = configured.length < 2;
  picker.value = payload.settings?.voiceProvider || payload.voice?.provider || configured[0] || "openai";
}
function paintSettings(payload) {
  paintVoiceChoices(payload.voices);
  paintVoiceQuickPicker(payload);
  appSettings = payload.settings || {};
  for (const name of SETTING_FIELDS) {
    const input = settingInput(name);
    if (!input) continue;
    const value = appSettings[name];
    if (SECRET_FIELDS.includes(name)) {
      // Поле ключа всегда пустое: показывать нечего, а подпись рядом говорит,
      // настроен он и откуда взялся.
      input.value = "";
      const state = document.getElementById(`state-${name}`);
      if (state)
        state.textContent = value?.configured
          ? `${value.hint}${value.fromEnvironment ? " · из .env" : ""}`
          : "не настроен";
      continue;
    }
    input.value = value ?? "";
  }
  const voiceState = document.getElementById("state-voiceProvider");
  if (voiceState)
    voiceState.textContent = payload.voice?.configured
      ? `сейчас ${providerNames[payload.voice.provider] || payload.voice.provider}`
      : "ключа нет — разговор без модели";
  const editable = new Set(payload.editable || SETTING_FIELDS);
  for (const name of SETTING_FIELDS) {
    const input = settingInput(name);
    const row = input?.closest(".setting");
    if (row) row.hidden = !editable.has(name);
  }
  // Ключи, провайдеры и пределы — общие на всё приложение, поэтому целые
  // разделы настроек существуют только для администратора.
  for (const group of document.querySelectorAll(".settings-group")) {
    const rows = [...group.querySelectorAll(".setting")];
    if (rows.length && rows.every((row) => row.hidden)) group.hidden = true;
  }
  if (settingInput("theme")) {
    // Тема, сохранённая в учётной записи, сильнее пустого браузера: человек
    // выбрал её однажды и ждёт её на любом устройстве.
    const remembered = appSettings.theme || "system";
    if (window.pagentTheme.read() === "system" && remembered !== "system") window.pagentTheme.set(remembered);
    settingInput("theme").value = window.pagentTheme.read();
    paintThemeButton();
  }
  paintVoiceQuota(payload.quota);
  paintSpend(payload.spend);
  // Настройки вида применяются сразу, без перезагрузки страницы.
  const limit = Number(appSettings.previewLimit);
  if (Number.isFinite(limit) && limit > 0 && limit !== previewLimit) {
    previewLimit = limit;
    load().catch(() => {});
  }
}
// Расходы: сколько ушло токенов и денег. Показываем три окна — сутки, неделя,
// всё время, — потому что «сколько я трачу» это вопрос про темп, а не про сумму.
const usageKinds = { classify: "разбор", answer: "память", voice_session: "разговор" };
function money(value) {
  if (!value) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
function tokens(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)} млн`;
  if (value >= 1000) return `${Math.round(value / 1000)} тыс.`;
  return String(value);
}
function usageRow(title, slice) {
  const row = node("div", undefined, "usage-row");
  row.append(
    node("span", title, "usage-when"),
    node("span", `${slice.calls} вызовов`, "usage-calls"),
    node("span", `${tokens(slice.inputTokens)} → ${tokens(slice.outputTokens)}`, "usage-tokens"),
    node("span", money(slice.costUsd), "usage-money"),
  );
  return row;
}
// Сколько ушло за календарный месяц и сколько осталось до потолка. Месяц
// календарный нарочно: деньги человек считает по счетам, а не по скользящему
// окну, и «первого числа снова можно» — понятное правило.
function paintSpend(spend) {
  const line = $("#spend-state");
  if (!line || !spend) return;
  const money = (value) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
  const parts = [`За ${spend.month} потрачено ${money(spend.totalUsd)}`];
  if (spend.voiceUsd) parts.push(`из них разговор ${money(spend.voiceUsd)}`);
  if (spend.limitUsd === null) parts.push("потолка нет");
  else parts.push(spend.allowed ? `осталось ${money(spend.remainingUsd)} из ${money(spend.limitUsd)}` : `потолок ${money(spend.limitUsd)} исчерпан`);
  if (spend.unpriced) parts.push(`${spend.unpriced} вызовов без цены в сумму не вошли`);
  line.textContent = parts.join(" · ");
  line.classList.toggle("quota-exhausted", !spend.allowed);
}
async function loadUsage() {
  const box = $("#usage-table");
  if (!box) return;
  let data;
  try {
    data = await request("/api/usage");
  } catch {
    return;
  }
  paintSpend(data.spend);
  clear(box);
  box.append(usageRow("За сутки", data.day), usageRow("За неделю", data.week), usageRow("Всего", data.total));
  if (!data.total.calls) {
    box.append(node("p", "Пока ничего не потрачено.", "empty"));
    return;
  }
  // Разбивка по моделям: видно, что именно съедает деньги.
  for (const row of data.total.rows.slice(0, 6)) {
    const line = node("div", undefined, "usage-row usage-detail");
    line.append(
      node("span", `${providerNames[row.provider] || row.provider} · ${row.model || "—"}`, "usage-when"),
      node("span", `${row.calls}`, "usage-calls"),
      node("span", `${tokens(row.inputTokens)} → ${tokens(row.outputTokens)}`, "usage-tokens"),
      node("span", row.unpriced ? `${money(row.costUsd)} · ${row.unpriced} без цены` : money(row.costUsd), "usage-money"),
    );
    box.append(line);
  }
}
async function loadSettings() {
  if (!settingInput("timeZone")) return;
  try {
    paintSettings(await request("/api/settings"));
    loadUsage();
  } catch {
    // Настройки не открылись — приложение всё равно работает на прежних.
  }
}
async function saveSettings(patch, { announce = "Настройки сохранены" } = {}) {
  const status = $("#settings-status");
  status.textContent = "Сохраняем…";
  try {
    paintSettings(
      await request("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
    );
    status.textContent = "Сохранено";
    if (announce) toast(announce);
  } catch (error) {
    status.textContent = "";
    toast(error.message);
  }
}
$("#settings-save")?.addEventListener("click", () => {
  const patch = {};
  for (const name of SETTING_FIELDS) {
    const input = settingInput(name);
    if (!input) continue;
    const value = input.value.trim();
    // Пустое поле ключа значит «не трогать», пустое обычное — «как в .env».
    if (SECRET_FIELDS.includes(name)) {
      if (value) patch[name] = value;
      continue;
    }
    patch[name] = value;
  }
  saveSettings(patch);
});
// Переключение из шапки — это та же настройка, только одним движением.
$("#voice-quick-provider")?.addEventListener("change", (event) => {
  const chosen = event.target.value;
  saveSettings(
    { voiceProvider: chosen },
    { announce: `Голос: ${voiceProviderNames[chosen] || chosen}` },
  );
});
$("#settings-forget")?.addEventListener("click", () => {
  saveSettings(Object.fromEntries(SECRET_FIELDS.map((name) => [name, ""])));
});

// Предпросмотр закрывается крестиком, кликом по фону и Esc — как и карточка.
$("#preview-close").addEventListener("click", () => $("#preview-dialog").close());
$("#preview-dialog").addEventListener("click", (event) => {
  if (event.target === $("#preview-dialog")) $("#preview-dialog").close();
});
$("#preview-dialog").addEventListener("close", () => clear($("#preview-body")));
$("#reset-button").addEventListener("click", () =>
  $("#reset-dialog").showModal(),
);
$("#reset-submit").addEventListener("click", async (event) => {
  event.preventDefault();
  if ($("#reset-confirmation").value !== "СБРОСИТЬ КИЗУНА") {
    toast("Введите точную фразу подтверждения");
    return;
  }
  try {
    await request("/api/reset", {
      method: "POST",
      body: JSON.stringify({ confirmation: "СБРОСИТЬ КИЗУНА" }),
    });
    $("#reset-dialog").close();
    $("#reset-confirmation").value = "";
    closeCard();
    for (const record of [...activeCaptures.values()]) removeCapture(record);
    localStorage.removeItem(activeCaptureStorageKey);
    $("#capture-notifications").replaceChildren();
    toast("Локальный журнал очищен");
    await load();
  } catch (error) {
    toast(error.message);
  }
});
$("#ai-provider").addEventListener("change", onProviderChange);
$("#ai-model").addEventListener("change", onModelChange);
$("#review-close").addEventListener("click", closeCard);
// Escape и клик по подложке закрывают карточку без сохранения.
$("#review-dialog").addEventListener("close", () => clear($("#review")));
$("#review-dialog").addEventListener("click", (event) => {
  if (event.target === $("#review-dialog")) closeCard();
});
window.addEventListener("pagehide", () => {
  for (const record of activeCaptures.values())
    if (record.timer) clearTimeout(record.timer);
  memoryController?.abort();
});
window.addEventListener("pagent:toast", (event) => {
  if (typeof event.detail === "string" && event.detail) toast(event.detail);
});
// Живое обновление: сервер сообщает, что журнал изменился, — карточки
// перерисовываются сами. Меняет журнал не только эта вкладка: запись может
// прийти голосом, разбор — закончиться в фоне, правка — из другого окна.
let journalStream = null;
let journalReloadTimer = 0;
function reloadJournalSoon() {
  // Событий может прийти пачка (запись, разбор, проекция): перечитываем один
  // раз, а не по разу на каждое.
  clearTimeout(journalReloadTimer);
  journalReloadTimer = setTimeout(() => {
    load().catch(() => {});
  }, 120);
}
function listenToJournal() {
  if (!("EventSource" in window) || journalStream) return;
  try {
    journalStream = new EventSource("/api/events");
  } catch {
    journalStream = null;
    return;
  }
  journalStream.addEventListener("journal", reloadJournalSoon);
  // Между загрузкой страницы и подключением к потоку журнал мог измениться:
  // запись пришла голосом, разбор закончился в фоне, правку сделали в другом
  // окне. Сервер здоровается сообщением «поток жив» — по нему и перечитываем,
  // иначе такая правка осталась бы невидимой до следующего события.
  journalStream.addEventListener("ready", reloadJournalSoon);
  // Браузер переподключается сам; на всякий случай сбрасываем ссылку, чтобы
  // повторный вызов мог открыть поток заново.
  journalStream.addEventListener("error", () => {
    if (journalStream?.readyState === EventSource.CLOSED) {
      journalStream = null;
    }
  });
}
window.addEventListener("online", () => {
  listenToJournal();
  bootstrap();
});
window.addEventListener("hashchange", updatePageFromHash);
updatePageFromHash();
bootstrap();
listenToJournal();

// ── учётная запись ───────────────────────────────────────────────────────────
// Кто мы, что нам можно и как отсюда выйти. Всё остальное приложение об этом не
// спрашивает: маршруты закрыты на сервере, а здесь только видимость разделов.
let currentUser = null;

const roleNames = { admin: "администратор", user: "пользователь" };

async function loadAccount() {
  try {
    const state = await request("/api/auth/me");
    currentUser = state.user;
  } catch {
    return;
  }
  const short = currentUser.email.split("@")[0];
  $("#account-summary").textContent = short.slice(0, 2).toUpperCase();
  $("#account-summary").title = currentUser.email;
  $("#account-email").textContent = currentUser.email;
  $("#account-role").textContent = roleNames[currentUser.role] || currentUser.role;
  $("#account-admin-link").hidden = currentUser.role !== "admin";
  const line = $("#account-summary-line");
  if (line)
    line.textContent = `${currentUser.email} · ${roleNames[currentUser.role]} · вход защищён ${currentUser.twoFactorEnabled ? "паролем и вторым фактором" : "только паролем"}`;
  paintTotp();
}

async function logout(everywhere = false) {
  try {
    await request(everywhere ? "/api/auth/logout-everywhere" : "/api/auth/logout", { method: "POST" });
  } catch {
    // Даже если сервер не ответил, оставаться на закрытой странице незачем.
  }
  location.replace("/login");
}
$("#account-logout")?.addEventListener("click", () => logout());
$("#account-logout-2")?.addEventListener("click", () => logout());
$("#logout-everywhere")?.addEventListener("click", () => logout(true));

// ── тема ─────────────────────────────────────────────────────────────────────
// Кнопка в шапке для быстрого переключения, поле в настройках — чтобы выбор
// пережил смену браузера.
function paintThemeButton() {
  const button = $("#theme-toggle");
  if (!button) return;
  button.textContent = window.pagentTheme.icon();
  button.title = `Тема: ${window.pagentTheme.label()}`;
  button.setAttribute("aria-label", `Тема оформления: ${window.pagentTheme.label()}`);
  const field = settingInput("theme");
  if (field) field.value = window.pagentTheme.read();
}
$("#theme-toggle")?.addEventListener("click", () => {
  const next = window.pagentTheme.next();
  window.pagentTheme.set(next);
  paintThemeButton();
  saveSettings({ theme: next }, { announce: null }).catch(() => {});
});
settingInput("theme")?.addEventListener("change", (event) => {
  window.pagentTheme.set(event.target.value);
  paintThemeButton();
  // Выбор из списка сохраняется сразу, как и нажатие кнопки в шапке: иначе
  // тема держалась только в этом браузере и «забывалась» на другом устройстве
  // или после чистки хранилища — выглядело как будто выбор не запомнился.
  saveSettings({ theme: event.target.value }, { announce: null }).catch(() => {});
});
paintThemeButton();

// ── второй фактор ────────────────────────────────────────────────────────────
// Секрет сначала показывается, и только подтверждённый кодом становится
// рабочим: иначе можно включить защиту, которую нечем открыть.
function paintTotp() {
  const state = $("#totp-state");
  if (!state || !currentUser) return;
  const on = currentUser.twoFactorEnabled;
  state.textContent = on
    ? "Включён. При входе после пароля спрашивается код из приложения."
    : "Выключен. Вход защищён только паролем.";
  $("#totp-start").hidden = on;
  $("#totp-disable").hidden = !on;
  $("#totp-recovery").hidden = !on;
  $("#totp-confirm").hidden = true;
  $("#totp-setup").hidden = true;
}
$("#totp-start")?.addEventListener("click", async () => {
  try {
    const setup = await request("/api/auth/totp/setup", { method: "POST" });
    if (setup.qr) $("#totp-qr").src = setup.qr;
    $("#totp-qr").hidden = !setup.qr;
    $("#totp-secret").textContent = setup.secret.replace(/(.{4})/g, "$1 ").trim();
    $("#totp-setup").hidden = false;
    $("#totp-confirm").hidden = false;
    $("#totp-start").hidden = true;
    $("#totp-code").focus();
  } catch (error) {
    toast(error.message);
  }
});
$("#totp-confirm")?.addEventListener("click", async () => {
  try {
    const result = await request("/api/auth/totp/enable", {
      method: "POST",
      body: JSON.stringify({ code: $("#totp-code").value.trim() }),
    });
    showRecoveryCodes(result.recoveryCodes);
    $("#totp-code").value = "";
    await loadAccount();
    toast("Второй фактор включён");
  } catch (error) {
    toast(error.message);
  }
});
function showRecoveryCodes(codes) {
  $("#totp-codes-list").textContent = (codes || []).join("\n");
  $("#totp-codes").hidden = !codes?.length;
}
$("#totp-disable")?.addEventListener("click", () => $("#totp-disable-dialog").showModal());
$("#totp-disable-submit")?.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    await request("/api/auth/totp/disable", {
      method: "POST",
      body: JSON.stringify({ password: $("#totp-disable-password").value }),
    });
    $("#totp-disable-password").value = "";
    $("#totp-disable-dialog").close();
    $("#totp-codes").hidden = true;
    await loadAccount();
    toast("Второй фактор выключен");
  } catch (error) {
    toast(error.message);
  }
});
$("#totp-recovery")?.addEventListener("click", async () => {
  const password = prompt("Пароль, чтобы выпустить новые резервные коды:");
  if (!password) return;
  try {
    const result = await request("/api/auth/totp/recovery-codes", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    showRecoveryCodes(result.recoveryCodes);
    toast("Прежние резервные коды больше не работают");
  } catch (error) {
    toast(error.message);
  }
});

// ── пароль ───────────────────────────────────────────────────────────────────
$("#password-change")?.addEventListener("click", () => $("#password-dialog").showModal());
$("#password-submit")?.addEventListener("click", async (event) => {
  event.preventDefault();
  const current = $("#password-current").value,
    next = $("#password-new").value;
  if (next !== $("#password-repeat").value) return toast("Пароли не совпадают");
  try {
    await request("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    for (const id of ["#password-current", "#password-new", "#password-repeat"])
      $(id).value = "";
    $("#password-dialog").close();
    toast("Пароль сменён, остальные входы закрыты");
  } catch (error) {
    toast(error.message);
  }
});

// ── предел разговора ─────────────────────────────────────────────────────────
function paintVoiceQuota(quota) {
  const state = $("#voice-quota-state");
  if (!state) return;
  if (!quota) return void (state.textContent = "");
  const windows = { day: "за сутки", week: "за неделю", month: "за месяц", total: "за всё время" };
  const parts = [`Наговорено ${quota.spentMinutes} мин ${windows[quota.window] || ""}`];
  if (quota.priced) parts.push(`это примерно $${quota.spentUsd.toFixed(2)}`);
  else parts.push("цена не задана, поэтому деньги не считаются");
  if (quota.limitMinutes !== null) parts.push(`осталось ${quota.remainingMinutes} мин`);
  if (quota.limitUsd !== null) parts.push(`осталось $${quota.remainingUsd.toFixed(2)}`);
  if (!quota.allowed) parts.push("разговор сейчас закрыт");
  state.textContent = parts.join(" · ");
  state.classList.toggle("quota-exhausted", !quota.allowed);
}

// ── администрирование ────────────────────────────────────────────────────────
const statusNames = {
  pending: "ждёт подтверждения",
  active: "работает",
  blocked: "заблокирован",
  rejected: "отклонён",
};
async function adminAction(userId, action, body) {
  try {
    await request(`/api/admin/users/${userId}/${action}`, {
      method: "POST",
      body: JSON.stringify(body || {}),
    });
    await loadAdmin();
  } catch (error) {
    toast(error.message);
  }
}
function adminButton(label, className, handler) {
  const button = node("button", label, className);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}
function userRow(user, { lastAdmin = false } = {}) {
  const row = node("div", null, "admin-user");
  const head = node("div", null, "admin-user-head");
  head.append(
    node("span", user.email, "admin-user-email"),
    node("span", roleNames[user.role] || user.role, `admin-tag admin-role-${user.role}`),
    node("span", statusNames[user.status] || user.status, `admin-tag admin-status-${user.status}`),
  );
  if (user.twoFactorEnabled) head.append(node("span", "2FA", "admin-tag admin-tag-quiet"));
  row.append(head);

  // Потолок ставят, глядя на расход, поэтому они стоят рядом: «потрачено из
  // сколько можно», а не два числа в разных углах страницы.
  const spent = user.monthSpentUsd || 0;
  const cap = user.monthlyLimitUsd;
  const capped = cap !== null && cap !== undefined;
  const facts = [
    `записей ${user.captureCount ?? 0}`,
    `разговор ${Math.round((user.voiceSeconds || 0) / 60)} мин`,
    `в этом месяце $${spent.toFixed(2)}${capped ? ` из $${cap}` : " (потолок общий)"}`,
  ];
  if (user.blockedReason) facts.push(`причина: ${user.blockedReason}`);
  if (user.lastLoginAt) facts.push(`входил ${new Date(user.lastLoginAt).toLocaleString("ru-RU")}`);
  const factsLine = node("p", facts.join(" · "), "admin-user-facts");
  if (capped && spent >= cap) factsLine.classList.add("quota-exhausted");
  row.append(factsLine);

  const actions = node("div", null, "admin-user-actions");
  if (user.status === "pending") {
    actions.append(adminButton("Одобрить", "primary", () => adminAction(user.id, "approve")));
    actions.append(adminButton("Отклонить", "secondary", () => adminAction(user.id, "reject")));
  }
  if (user.status === "rejected")
    actions.append(adminButton("Всё-таки пустить", "secondary", () => adminAction(user.id, "approve")));
  // Последнего администратора не закрыть и не разжаловать: иначе приложение
  // осталось бы без хозяина. Сервер это тоже проверяет — здесь просто не
  // предлагаем того, что всё равно не выйдет.
  if (user.status === "active" && !lastAdmin)
    actions.append(
      adminButton("Заблокировать", "danger", () => {
        const reason = prompt(`Причина блокировки ${user.email} (необязательно):`);
        if (reason === null) return;
        adminAction(user.id, "block", { reason });
      }),
    );
  if (user.status === "blocked")
    actions.append(adminButton("Разблокировать", "secondary", () => adminAction(user.id, "unblock")));
  if (user.status === "active" && !lastAdmin)
    actions.append(
      adminButton(
        user.role === "admin" ? "Снять администратора" : "Сделать администратором",
        "secondary",
        () => adminAction(user.id, "role", { role: user.role === "admin" ? "user" : "admin" }),
      ),
    );
  if (user.twoFactorEnabled)
    actions.append(adminButton("Сбросить 2FA", "secondary", () => adminAction(user.id, "reset-2fa")));
  row.append(actions);

  // Пределы правятся полями, а не вопросом в модальном окне: их два, они
  // числовые, и видеть прежнее значение рядом с новым — половина дела.
  const limits = node("div", null, "admin-limits");
  const field = (label, hint, value, key, step) => {
    const wrap = node("label", null, "admin-limit");
    wrap.append(node("span", label, "admin-limit-name"));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = step;
    input.placeholder = hint;
    input.value = value ?? "";
    input.dataset.key = key;
    wrap.append(input);
    limits.append(wrap);
    return input;
  };
  const monthly = field("Потолок, $/мес", "общий", user.monthlyLimitUsd, "monthlyLimitUsd", "1");
  const minutes = field("Разговор, мин", "общий", user.voiceLimitMinutes, "voiceLimitMinutes", "5");
  limits.append(
    adminButton("Сохранить пределы", "secondary", () =>
      adminAction(user.id, "limits", {
        monthlyLimitUsd: monthly.value.trim(),
        voiceLimitMinutes: minutes.value.trim(),
      }),
    ),
  );
  row.append(limits);
  return row;
}
async function loadAdmin() {
  const box = $("#admin-users");
  if (!box) return;
  let payload;
  try {
    payload = await request("/api/admin/users");
  } catch (error) {
    clear(box);
    box.append(node("p", error.message, "empty"));
    return;
  }
  const pendingBox = $("#admin-pending-list");
  const pending = payload.users.filter((user) => user.status === "pending");
  clear(pendingBox);
  $("#admin-pending").hidden = !pending.length;
  const admins = payload.users.filter((user) => user.role === "admin" && user.status === "active");
  const soleAdmin = admins.length === 1 ? admins[0].id : null;
  for (const user of pending) pendingBox.append(userRow(user));
  clear(box);
  for (const user of payload.users.filter((user) => user.status !== "pending"))
    box.append(userRow(user, { lastAdmin: user.id === soleAdmin }));

  const events = $("#admin-events");
  clear(events);
  try {
    const log = await request("/api/admin/auth-events?limit=25");
    if (!log.events.length) events.append(node("p", "Пока пусто.", "empty"));
    for (const event of log.events) {
      const line = node("div", null, "admin-event");
      line.append(
        node("span", new Date(event.createdAt).toLocaleString("ru-RU"), "admin-event-when"),
        node("span", event.email || "—", "admin-event-who"),
        node("span", `${event.event} · ${event.result}`, "admin-event-what"),
      );
      events.append(line);
    }
  } catch {
    events.append(node("p", "Журнал входов не открылся.", "empty"));
  }
}

loadAccount();
