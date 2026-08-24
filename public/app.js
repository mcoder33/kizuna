import { renderMarkdown, renderInlineMarkdown } from "./markdown.js";
import { createMarkdownField } from "./markdown-live.js";

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
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
};
const modelStorageKey = "pagent.ai-model";
const modelCapableProviders = new Set(["openrouter"]);
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
function toast(text) {
  const element = $("#toast");
  element.textContent = text;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2800);
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
  const pageId = location.hash.slice(1) || "today";
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
  const metaParts = [
    ...c.entities.projects,
    ...(Array.isArray(c.tags) ? c.tags.map((tag) => `#${tag}`) : []),
    scheduleLabel(c.entities.schedule),
    c.primaryType === "task" && c.priority === "high" ? "важно" : null,
    c.primaryType === "task" && c.priority === "low" ? "не срочно" : null,
    overdue ? "просрочено" : null,
    completed ? "готово" : null,
  ].filter(Boolean);
  if (metaParts.length)
    meta.append(document.createTextNode(metaParts.join(" · ")));
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
const previewLimit = 3;
function appendPreview(container, entries, emptyText, options) {
  appendEntries(container, entries.slice(0, previewLimit), emptyText, {
    entryOptions: (entry) => ({
      ...options?.entryOptions?.(entry),
      compact: true,
    }),
  });
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
  appendPreview(
    $("#journal"),
    done,
    "Пока нет зафиксированной работы за сегодня.",
  );
  appendPreview($("#todo"), todo, "Открытых дел нет.", {
    entryOptions: (entry) => ({ overdue: isOverdue(entry, data.date) }),
  });
  appendPreview($("#notes"), notes, "Заметки появятся здесь.");
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
function closeCard() {
  const dialog = $("#review-dialog");
  if (dialog.open) dialog.close();
  clear($("#review"));
}
// Карточка открывается модальным окном, а не панелью внутри страницы: панель
// жила в разделе «Сегодня» и на страницах журнала строилась на скрытой
// странице — кнопка срабатывала, но человек не видел ничего.
function propertyRow(label, control) {
  const row = node("div", undefined, "prop");
  row.append(node("span", label, "prop-label"), control);
  return row;
}
// Тело заметки — отдельная пользовательская сущность, а не правка raw:
// контракт памяти запрещает менять источник, поэтому оно версионируется
// на сервере со ссылкой supersedes.
function cardBody(entry) {
  const wrap = node("section", undefined, "card-body"),
    hint = node("p", "Markdown оформляется прямо в тексте · ⌘/Ctrl + Enter — сохранить, Esc — отменить", "card-body-hint"),
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
  field.setValue(body);
  hint.hidden = true;

  // Отключение поля снимает фокус и вызывает blur, а тот сохраняет: без этих
  // флагов заметка сохранялась дважды, а Escape вместо отмены сохранял
  // черновик.
  let saving = false;
  let cancelling = false;
  const save = async () => {
    if (saving || cancelling) return;
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
  field.element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelling = true;
      field.setValue(body);
      hint.hidden = true;
      field.element.blur();
      cancelling = false;
    }
  });
  field.element.addEventListener("blur", () => {
    hint.hidden = true;
    save();
  });
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
  area.append(form, cardBody(entry));

  const source = node("details", undefined, "card-source");
  source.append(node("summary", "Источник и версия"));
  const raw = node("div", undefined, "review-raw");
  raw.append(node("p", "Исходная запись:", "source-label"), markdownNode("div", entry.raw, undefined));
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
  if (!dialog.open) {
    dialog.showModal();
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
  onSubmit: () => $("#capture-form").requestSubmit(),
});
$("#capture-form").prepend(captureField.element);
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
    // Параметры действуют на одну запись: залипший тип или «важно» молча
    // испортили бы следующие записи.
    resetComposerOverrides();
    startCapturePolling({ ...result.data, raw, provider: provider || "fallback" });
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
      await Promise.all([status(), load()]);
      resumeCapture();
    } catch {
      toast("Не удалось загрузить данные. Повторим при восстановлении сети.");
    } finally {
      bootstrapInFlight = false;
    }
  } while (bootstrapQueued);
}
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
window.addEventListener("online", bootstrap);
window.addEventListener("hashchange", updatePageFromHash);
updatePageFromHash();
bootstrap();
