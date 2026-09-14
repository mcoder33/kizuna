import { renderMarkdown, renderInlineMarkdown } from "./markdown.js";
import { createMarkdownField } from "./markdown-live.js";
import { attachSlashMenu } from "./slash-menu.js";
import { attachFormatToolbar } from "./format-toolbar.js";
import { createVoiceDialog } from "./voice.js";
import { phaseOf, coverFor, endedRecently, plural, hm, duration, minutesOf, longDate, shortDate, isWeekend, MEETINGS, DEALS, PHASE_NAMES } from "./today-cover.js";

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
// Состояние «Обзора» объявлено до первого разбора адреса: прямая ссылка на
// #reports зовёт loadReports сразу, и объявление ниже по файлу ещё не
// существовало бы — обзор оставался пустым до щелчка по вкладке.
// «День» — первая вкладка и вкладка по умолчанию: обзор открывают спросить
// «что было вчера», а сводные «Записи» нужны реже и стоят в конце.
const reportsState = { tab: "day", period: "week", dayDate: null };
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
  // Ссылка из уведомления: открыть карточку записи и убрать параметр из адреса.
  const openId = params.get("open");
  if (openId) { params.delete("open"); history.replaceState(null, "", `#${activePage}${params.size ? `?${params}` : ""}`); openCaptureById(openId); }
  for (const section of document.querySelectorAll(".app-page"))
    section.hidden = section.id !== activePage;
  for (const link of document.querySelectorAll("nav a"))
    link.classList.toggle(
      "active",
      link.getAttribute("href") === `#${activePage}`,
    );
  if (activePage !== pageId) history.replaceState(null, "", "#today");
  // Вернулись на «Сегодня» — обложка и строка «сейчас» пересчитываются: пока
  // страница была скрыта, время шло.
  if (activePage === "today") renderToday();
  // Открыли настройки — перечитываем расход: он меняется от каждой записи, а
  // страница может висеть открытой долго.
  if (activePage === "settings") {
    paintPush();
    paintUpcomingReminders();
    loadUsage();
    loadCalendarAccounts();
    // Google возвращает сюда после согласия с итогом в адресе: без слова
    // человек не понял бы, подключилось или нет.
    const calendarOutcome = params.get("calendar");
    if (calendarOutcome) {
      const messages = { connected: "Google Calendar подключён", denied: "Google: доступ не дан", invalid_state: "Подключение Google устарело — попробуйте снова", no_refresh_token: "Google не выдал токен обновления: отзовите доступ Кизуны в аккаунте Google и подключите заново" };
      toast(messages[calendarOutcome] || `Google: не удалось подключить (${calendarOutcome})`);
      history.replaceState(null, "", "#settings");
    }
  }
  if (activePage === "admin") loadAdmin();
  if (activePage === "board") loadBoard(params.get("view"));
  // Календарь перечитывается при каждом открытии: сроки правятся из карточек
  // и с доски, а чужие события приходят синхронизацией в фоне. Первый разбор
  // адреса случается до того, как модуль дошёл до состояния календаря, —
  // вызов откладывается на микрозадачу, когда модуль уже прочитан целиком.
  if (activePage === "calendar") Promise.resolve().then(() => loadCalendar());
  // «Обзор» пересчитывается при каждом открытии: цифры меняются от каждой
  // записи, а страница может быть открыта спустя часы.
  if (activePage === "reports") loadReports();
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
// Поповеры шапки (настройки ИИ) закрываются по клику вне и Escape.
const headerMenus = () => [...document.querySelectorAll("header details")];
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
  // Неразобранная запись сохраняется заметкой без проекций и уже видна в
  // «Заметках» — в TODO она лишь дублировалась. В дела она попадает только
  // если её тип — задача или встреча: проекций у такой нет, и иначе она
  // не была бы видна нигде.
  if (c.unclassified) return ["task", "meeting_event"].includes(c.primaryType);
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
// Сколько дел без срока показывать в «Дне» — настройка, а не константа.
let previewLimit = 3;
// ── «Сегодня»: обложка по часам, полоса дней, два ящика ──────────────────────
// Страница знает, который час: дата с фазой суток, бриф из двух-трёх фраз и
// вопрос в поле меняются утром, днём, вечером и ночью. Под полем — полоса дней
// и два ящика: «Что делал» и «День», где дела лежат вместе с календарём.
// Заметок на главной нет: они живут в «Обзоре», поиске и карточке записи.
const TODAY_ZONE = "Europe/Samara";
const todayState = {
  view: 0,            // смещение дня, показанного в «Дне», от сегодняшнего
  journalView: 0,     // то же для «Что делал»: у ящиков свои дни
  tab: null,          // открытый ящик: "journal" | "day" | null
  manual: false,      // ящик выбран рукой — фаза его не трогает
  phase: null,
  cover: null,
  calendar: null,     // /api/calendar на сегодня и завтра
  entries: [],
  done: [],
  todo: [],
  cache: new Map(),   // другие дни: date → { calendar, report }
  loading: new Set(),
  placeholder: null,
  placeholderType: "auto",
  calendarStale: true,
  calendarLoading: false,
};
function zoneMinutes(at) {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: TODAY_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return (get("hour") % 24) * 60 + get("minute");
}
const nowMinutes = () => zoneMinutes(new Date());
const zoneDate = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: TODAY_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
// Календарь на сегодня, отложенный на время чужой страницы, добирается при
// первой отрисовке «Сегодня».
async function refreshTodayCalendar() {
  if (todayState.calendarLoading || !currentDayDate) return;
  todayState.calendarLoading = true;
  try { todayState.calendar = await request(`/api/calendar?from=${currentDayDate}&to=${shiftDate(currentDayDate, 1)}`); }
  catch { todayState.calendar = todayState.calendar || null; }
  finally { todayState.calendarLoading = false; }
  todayState.calendarStale = false;
  renderToday();
}
const scheduleOf = (entry) => entry.interpretation.classification.entities.schedule || null;
const titleOf = (entry) => (entry.interpretation.classification.summary || entry.raw || "").split("\n")[0];
const calendarConnected = () => Boolean(todayState.calendar?.accounts?.some((account) => !account.disabled));
// Календарь в режиме «только занятость» отдаёт события без названия.
const busyOnly = (item) => item.title === "Занято" && item.readOnly;
// Встречи дня для брифа: чужие события по часам и свои встречи со временем.
function todayMeetings() {
  const today = currentDayDate;
  const external = (todayState.calendar?.external || []).filter((item) => item.date === today && !item.allDay && item.time);
  const defaults = todayState.calendar?.defaults?.meetingMinutes || 30;
  const hasOutcome = (title) => {
    const needle = title.toLowerCase();
    return todayState.done.some((entry) => titleOf(entry).toLowerCase().includes(needle));
  };
  return [
    ...external.map((item) => ({ id: item.id, title: item.title, start: minutesOf(item.time), end: minutesOf(item.end) ?? minutesOf(item.time) + defaults, joinUrl: item.joinUrl || null, busy: busyOnly(item), hasOutcome: hasOutcome(item.title) })),
    ...todayState.todo
      .filter((entry) => isActiveMeeting(entry) && scheduleOf(entry)?.date === today && scheduleOf(entry)?.time)
      .map((entry) => ({ id: entry.id, title: titleOf(entry), start: minutesOf(scheduleOf(entry).time), end: minutesOf(scheduleOf(entry).end) ?? minutesOf(scheduleOf(entry).time) + defaults, joinUrl: null, busy: false, hasOutcome: true })),
  ].filter((meeting) => meeting.start != null);
}
function todayTasks() {
  const today = currentDayDate;
  const todays = todayState.todo.filter((entry) => scheduleOf(entry)?.date === today);
  return {
    late: todayState.todo.filter((entry) => isOverdue(entry, today)).length,
    open: todayState.todo.filter((entry) => isActiveTask(entry) && !isOverdue(entry, today)).length,
    today: todays.length,
    todayTitle: todays.find((entry) => isActiveTask(entry)) ? titleOf(todays.find((entry) => isActiveTask(entry))) : null,
  };
}
function tomorrowInfo() {
  const calendar = todayState.calendar;
  if (!calendar || !currentDayDate) return null;
  const tomorrow = shiftDate(currentDayDate, 1);
  const timed = [
    ...(calendar.external || []).filter((item) => item.date === tomorrow && !item.allDay && item.time).map((item) => ({ start: minutesOf(item.time), title: item.title })),
    ...(calendar.items || []).filter((item) => item.date === tomorrow && item.kind === "meeting" && item.time && !item.done).map((item) => ({ start: minutesOf(item.time), title: item.title })),
  ].sort((a, b) => a.start - b.start);
  return { count: timed.length, first: timed[0] || null };
}
function lastEntryMinutes() {
  const today = currentDayDate;
  const times = todayState.entries.filter((entry) => entryDate(entry) === today).map((entry) => zoneMinutes(new Date(entry.createdAt)));
  return times.length ? Math.max(...times) : null;
}
// Ящик, выбранный рукой, держится до конца фазы этого дня.
function rememberTab() {
  try { localStorage.setItem("kizuna-today-tab", JSON.stringify({ date: currentDayDate, phase: todayState.phase, tab: todayState.tab })); } catch {}
}
function recallTab(phase) {
  try {
    const saved = JSON.parse(localStorage.getItem("kizuna-today-tab") || "null");
    if (saved && saved.date === currentDayDate && saved.phase === phase && ["journal", "day", null].includes(saved.tab)) {
      todayState.tab = saved.tab;
      todayState.manual = true;
      return true;
    }
  } catch {}
  return false;
}
function render(data) {
  currentDayDate = data.date;
  const all = uniqueEntries([data.entries, data.day, data.upcoming, data.attention]).sort((left, right) =>
    (right.createdAt || "").localeCompare(left.createdAt || ""),
  );
  const todayEntries = all.filter((entry) => entryDate(entry) === data.date || scheduleOf(entry)?.date === data.date);
  todayState.entries = all;
  todayState.done = todayEntries.filter(isReportedWork);
  todayState.todo = all
    .filter((entry) => (isActiveTask(entry) || isActiveMeeting(entry) || needsClarification(entry)) && !isReportedWork(entry))
    .sort((left, right) => todoOrder(left, data.date) - todoOrder(right, data.date));
  renderToday();
}
function renderToday() {
  if (!currentDayDate) return;
  if (todayState.calendarStale && !$("#today")?.hidden) refreshTodayCalendar();
  const minutes = nowMinutes();
  const phase = phaseOf({ minutes, weekend: isWeekend(currentDayDate) });
  const meetings = todayMeetings();
  const cover = coverFor({
    phase,
    minutes,
    meetings,
    tasks: todayTasks(),
    doneCount: todayState.done.length,
    tomorrow: tomorrowInfo(),
    calendar: calendarConnected(),
    endedMeeting: phase === "weekend" ? null : endedRecently({ meetings, minutes, lastEntryMinutes: lastEntryMinutes() }),
  });
  todayState.cover = cover;
  // Новая фаза ставит свой ящик один раз; дальше — как решил человек.
  if (todayState.phase !== phase) {
    todayState.phase = phase;
    if (!recallTab(phase)) {
      todayState.manual = false;
      if (todayState.view === 0) todayState.tab = cover.tab;
    }
  }
  applyCoverComposer(cover);
  paintCover(cover, currentDayDate);
  const viewDate = shiftDate(currentDayDate, todayState.view);
  const journalDate = shiftDate(currentDayDate, todayState.journalView);
  paintTabs(viewDate, journalDate);
  paintJournal(journalDate);
  paintDayList(viewDate);
}
// Вопрос в поле и тип записи — по фазе, но только пока поле пустое и тип не
// выбран рукой: страница не меняется под руками.
function applyCoverComposer(cover = todayState.cover) {
  if (!cover || typeof captureField === "undefined") return;
  todayState.placeholder = cover.placeholder;
  todayState.placeholderType = cover.type === "outcome" ? "outcome" : "auto";
  if (!composerState.userType && !String(captureField.getValue()).trim()) {
    const wanted = cover.type === "outcome" ? "outcome" : "auto";
    if (composerState.type !== wanted) {
      composerState.type = wanted;
      composerState.date = null;
      composerState.time = null;
      composerState.priority = "normal";
    }
  }
  renderCaptureControls();
}
function paintCover(cover, date) {
  const dateEl = $("#today-date");
  clear(dateEl);
  dateEl.append(document.createTextNode(`${longDate(date)} · `), node("span", PHASE_NAMES[cover.phase], `today-phase ${cover.phase}`));
  if (cover.endedMeeting) dateEl.append(document.createTextNode(" · "), node("span", "после встречи", "today-phase after"));
  const brief = $("#today-brief");
  clear(brief);
  // Бриф собирается узлами, а не HTML: названия встреч и дел — чужой текст.
  for (const part of cover.brief) {
    if (typeof part === "string") brief.append(document.createTextNode(part));
    else if (part.b) brief.append(node("b", part.b));
    else if (part.a) {
      const link = node("a", part.a.text);
      link.href = part.a.href;
      link.target = "_blank";
      link.rel = "noopener";
      brief.append(link);
    }
  }
}
// Стрелки по дням живут внутри каждого ящика: слева предыдущий день, справа
// следующий, по центру показанный. У «Дня» и «Что делал» свои дни; обложка
// всегда про сегодня.
function ownEntriesFor(date) {
  return todayState.entries.filter((entry) =>
    scheduleOf(entry)?.date === date && !isReportedWork(entry)
    && (isActiveTask(entry) || isActiveMeeting(entry) || needsClarification(entry) || isClosed(entry)),
  );
}
function externalFor(date) {
  const source = [todayState.calendar, todayState.cache.get(date)?.calendar].find((calendar) => calendar && date >= calendar.from && date <= calendar.to);
  return (source?.external || []).filter((item) => item.date === date);
}
function setView(offset) {
  todayState.view = offset;
  todayState.tab = "day";
  renderToday();
}
function setJournalView(offset) {
  todayState.journalView = offset;
  todayState.tab = "journal";
  renderToday();
}
function dayNavNode(date, { view, onView }) {
  const nav = node("div", undefined, "daynav");
  const step = (delta) => {
    const target = shiftDate(date, delta);
    const button = node("button", undefined, `daynav-step ${delta < 0 ? "prev" : "next"}`);
    button.type = "button";
    button.dataset.step = String(delta);
    button.title = longDate(target);
    button.setAttribute("aria-label", `${delta < 0 ? "Предыдущий" : "Следующий"} день, ${longDate(target)}`);
    const parts = [node("i", delta < 0 ? "‹" : "›", "daynav-arrow"), node("span", shortDate(target), "daynav-date")];
    if (delta > 0) parts.reverse();
    button.append(...parts);
    button.addEventListener("click", () => onView(view + delta));
    return button;
  };
  const current = node("div", undefined, "daynav-current");
  current.append(node("b", longDate(date)));
  if (date === currentDayDate) current.append(node("span", "сегодня", "daynav-mark"));
  else {
    const back = node("button", "сегодня", "daynav-today");
    back.type = "button";
    back.dataset.view = "0";
    back.addEventListener("click", () => onView(0));
    current.append(back);
  }
  nav.append(step(-1), current, step(1));
  return nav;
}
// Счётчики в ящиках: сколько встреч и дел в показанном дне.
function dayCountNode(date) {
  const wrap = node("span", undefined, "drawer-count");
  const parts = [];
  if (date === currentDayDate) {
    const band = todayState.todo.filter((entry) => todoOrder(entry, date) <= 3);
    const timed = todayState.todo.filter((entry) => isActiveTask(entry) && scheduleOf(entry)?.date === date && scheduleOf(entry)?.time);
    const allDay = (todayState.calendar?.external || []).filter((item) => item.date === date && item.allDay).length;
    const meetings = todayMeetings().length + allDay;
    if (calendarConnected() || meetings) parts.push(plural(meetings, MEETINGS));
    parts.push(plural(band.length + timed.length, DEALS));
    const late = todayState.todo.filter((entry) => isOverdue(entry, date)).length;
    wrap.append(document.createTextNode(parts.join(" · ")));
    if (late) wrap.append(document.createTextNode(" · "), node("em", `${late} просрочено`));
    return wrap;
  }
  const own = ownEntriesFor(date).filter((entry) => !isClosed(entry));
  const meetings = externalFor(date).length + own.filter(isActiveMeeting).length;
  if (calendarConnected() || meetings) parts.push(plural(meetings, MEETINGS));
  parts.push(plural(own.filter((entry) => !isActiveMeeting(entry)).length, DEALS));
  wrap.append(document.createTextNode(parts.join(" · ")));
  return wrap;
}
function paintTabs(date, journalDate) {
  const host = $("#today-tabs");
  clear(host);
  const today = date === currentDayDate, journalToday = journalDate === currentDayDate;
  const report = todayState.cache.get(journalDate)?.report;
  const doneCount = journalToday ? String(todayState.done.length) : report ? String((report.done || []).length) : "…";
  const tabs = [
    ["journal", journalToday ? "Что делал" : `Что делал ${shortDate(journalDate)}`, node("b", doneCount)],
    ["day", today ? "День" : `День ${shortDate(date)}`, dayCountNode(date)],
  ];
  for (const [key, label, count] of tabs) {
    const button = node("button", undefined, "drawer-tab");
    button.type = "button";
    button.id = `tab-${key}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(todayState.tab === key));
    button.setAttribute("aria-controls", key === "journal" ? "journal" : "todo");
    button.append(node("span", label, "drawer-tab-label"), count);
    button.addEventListener("click", () => {
      todayState.tab = todayState.tab === key ? null : key;
      todayState.manual = true;
      rememberTab();
      renderToday();
    });
    host.append(button);
  }
  $("#journal").hidden = todayState.tab !== "journal";
  $("#todo").hidden = todayState.tab !== "day";
}
// Строка с временем слева: карточка записи или чужое событие.
function rowWithTime(time, child, className = "") {
  const row = node("div", undefined, `day-row ${className}`.trim());
  row.append(node("span", time, "day-time"), child);
  return row;
}
function outcomeButton(title) {
  const button = node("button", "Записать итог", "day-ghost");
  button.type = "button";
  button.addEventListener("click", () => prefillCapture(`Встреча «${title}» — `, "outcome"));
  return button;
}
// «Записать итог»: текст и тип ложатся в поле, дальше пишет человек.
function prefillCapture(text, type) {
  composerState.type = type;
  composerState.userType = true;
  composerState.date = null;
  composerState.time = null;
  composerState.priority = "normal";
  captureField.setValue(text, { caretToEnd: true });
  renderCaptureControls();
  paintCaptureAction(text);
  $("#capture-form").scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
  captureField.focus();
}
function eventRow(item, { minutes = null, today = false, pastDay = false } = {}) {
  const box = node("div", undefined, "day-event");
  const dot = node("i", undefined, "cal-dot");
  if (item.color) dot.style.background = item.color;
  const meta = node("span", undefined, "day-event-meta");
  const actions = node("span", undefined, "day-event-actions");
  const start = minutesOf(item.time), end = minutesOf(item.end);
  const finish = end ?? (start == null ? null : start + (todayState.calendar?.defaults?.meetingMinutes || 30));
  const busy = busyOnly(item);
  let className = "external";
  if (item.allDay) meta.append(node("span", "весь день", "tag"));
  else if (today && start != null) {
    const running = minutes >= start && minutes < finish;
    const soon = !running && start > minutes && start - minutes <= 10;
    if (running) { className += " now"; meta.append(node("span", `идёт · до ${hm(finish)}`, "tag now")); }
    else if (soon) meta.append(node("span", `через ${start - minutes} мин`, "tag soon"));
    else if (minutes >= finish) { className += " past"; meta.append(node("span", "прошла", "tag")); }
    else meta.append(node("span", `через ${duration(start - minutes)}`, "tag"));
    if (item.joinUrl && (running || soon)) {
      const join = node("a", "Присоединиться", "day-join");
      join.href = item.joinUrl;
      join.target = "_blank";
      join.rel = "noopener";
      actions.append(join);
    }
    if (minutes >= finish && !busy) actions.append(outcomeButton(item.title));
  } else if (pastDay) {
    className += " past";
    if (!busy) actions.append(outcomeButton(item.title));
  } else if (item.end) meta.append(node("span", `до ${item.end}`, "tag"));
  if (item.me?.status === "needs-action" && !pastDay) {
    const rsvp = node("a", "ответить?", "tag warm");
    rsvp.href = "#calendar";
    meta.append(rsvp);
  }
  if (item.calendarName) meta.append(node("span", item.calendarName, "day-event-cal"));
  box.append(dot, node("span", item.title, "day-event-title"), meta);
  if (actions.childNodes.length) box.append(actions);
  return rowWithTime(item.allDay ? "день" : item.time, box, className);
}
function nowRow(minutes, meetings) {
  const next = meetings.find((meeting) => meeting.start > minutes) || null;
  const text = next ? `сейчас · свободно ${duration(next.start - minutes)} — в ${hm(next.start)} ${next.title}` : "сейчас · встреч больше нет";
  return rowWithTime(hm(minutes), node("span", text, "day-now-text"), "now-mark");
}
function appendMore(container, hidden) {
  if (hidden <= 0) return;
  const more = node("a", `Ещё ${hidden} — весь список →`, "preview-more");
  more.href = "#board?view=list";
  container.append(more);
}
function paintDayList(date) {
  const container = $("#todo");
  clear(container);
  container.append(dayNavNode(date, { view: todayState.view, onView: setView }));
  if (date === currentDayDate) { paintTodayList(container); return; }
  const data = todayState.cache.get(date);
  if (!data) {
    container.append(node("p", "Загружаю…", "empty"));
    ensureDayData(date);
    return;
  }
  paintOtherDayList(container, date, data);
}
// Сегодня: сверху «без времени» — просроченное, требующее уточнения, сегодняшнее
// без часа и дела без срока (эти — до предела превью), ниже «по часам» — свои
// дела и встречи со временем вперемешку с чужими событиями, между прошедшими
// и будущими — строка «сейчас». Дела на другие дни живут в своих днях и в
// хвосте «Ещё N».
function paintTodayList(container) {
  const today = currentDayDate, minutes = nowMinutes();
  const timed = (entry) => scheduleOf(entry)?.date === today && Boolean(scheduleOf(entry)?.time);
  const order = (entry) => todoOrder(entry, today);
  const band = todayState.todo.filter((entry) => order(entry) <= 3 && !timed(entry));
  const undated = band.filter((entry) => order(entry) === 3);
  const shownBand = band.filter((entry) => order(entry) < 3).concat(undated.slice(0, previewLimit));
  const later = todayState.todo.filter((entry) => order(entry) === 4);
  const hidden = undated.length - Math.min(undated.length, previewLimit) + later.length;
  const external = (todayState.calendar?.external || []).filter((item) => item.date === today);
  const allDay = external.filter((item) => item.allDay);
  const hours = [
    ...todayState.todo.filter(timed).map((entry) => ({ start: minutesOf(scheduleOf(entry).time), entry })),
    ...external.filter((item) => !item.allDay && item.time).map((item) => ({ start: minutesOf(item.time), item })),
  ].filter((slot) => slot.start != null).sort((a, b) => a.start - b.start);
  if (!shownBand.length && !allDay.length && !hours.length) {
    container.append(node("p", "Открытых дел нет.", "empty"));
    appendMore(container, hidden);
    return;
  }
  if (shownBand.length || allDay.length) {
    container.append(node("div", "без времени", "day-group"));
    for (const entry of shownBand) container.append(entryCard(entry, { overdue: isOverdue(entry, today), compact: true }));
    for (const item of allDay) container.append(eventRow(item, { minutes, today: true }));
  }
  if (hours.length) {
    container.append(node("div", "по часам", "day-group"));
    const meetings = todayMeetings();
    const running = meetings.some((meeting) => minutes >= meeting.start && minutes < meeting.end);
    let nowPlaced = running;
    for (const slot of hours) {
      if (!nowPlaced && slot.start > minutes) { container.append(nowRow(minutes, meetings)); nowPlaced = true; }
      container.append(slot.entry
        ? rowWithTime(scheduleOf(slot.entry).time, entryCard(slot.entry, { overdue: false, compact: true }))
        : eventRow(slot.item, { minutes, today: true }));
    }
    if (!nowPlaced) container.append(nowRow(minutes, meetings));
  }
  appendMore(container, hidden);
}
function paintOtherDayList(container, date, data) {
  const pastDay = date < currentDayDate;
  const own = ownEntriesFor(date);
  const external = (data.calendar?.external || []).filter((item) => item.date === date);
  const card = (entry) => entryCard(entry, { overdue: pastDay && !isClosed(entry), compact: true });
  const band = [...own.filter((entry) => !scheduleOf(entry)?.time).map((entry) => ({ entry })), ...external.filter((item) => item.allDay).map((item) => ({ item }))];
  const hours = [
    ...own.filter((entry) => scheduleOf(entry)?.time).map((entry) => ({ start: minutesOf(scheduleOf(entry).time), entry })),
    ...external.filter((item) => !item.allDay && item.time).map((item) => ({ start: minutesOf(item.time), item })),
  ].filter((slot) => slot.start != null).sort((a, b) => a.start - b.start);
  if (!band.length && !hours.length) {
    container.append(node("p", pastDay ? "Встреч и дел со сроком не было." : "Встреч и дел со сроком пока нет.", "empty"));
    return;
  }
  if (band.length) {
    container.append(node("div", "без времени", "day-group"));
    for (const slot of band) container.append(slot.entry ? card(slot.entry) : eventRow(slot.item, { pastDay }));
  }
  if (hours.length) {
    container.append(node("div", "по часам", "day-group"));
    for (const slot of hours) container.append(slot.entry ? rowWithTime(scheduleOf(slot.entry).time, card(slot.entry)) : eventRow(slot.item, { pastDay }));
  }
}
function paintJournal(date) {
  const container = $("#journal");
  const nav = () => dayNavNode(date, { view: todayState.journalView, onView: setJournalView });
  if (date === currentDayDate) {
    appendEntries(container, todayState.done, "Пока нет зафиксированной работы за сегодня.", { entryOptions: () => ({ compact: true }) });
    container.prepend(nav());
    return;
  }
  clear(container);
  container.append(nav());
  const data = todayState.cache.get(date);
  if (!data) { container.append(node("p", "Загружаю…", "empty")); ensureDayData(date); return; }
  // Сделанное другого дня — из отчёта «Обзора»; карточка записи, если она
  // ещё среди загруженных, иначе строка с названием и временем.
  const done = data.report?.done || [];
  if (!done.length) { container.append(node("p", date < currentDayDate ? "В этот день ничего не записано." : "День ещё не наступил.", "empty")); return; }
  const entriesById = new Map(todayState.entries.map((entry) => [entry.id, entry]));
  for (const record of done) {
    const entry = entriesById.get(record.captureId);
    if (entry) { container.append(entryCard(entry, { compact: true })); continue; }
    const box = node("div", undefined, "day-own");
    box.append(node("span", record.title, "day-own-title"));
    const meta = node("span", undefined, "day-event-meta");
    meta.append(node("span", typeNames[record.type] || record.type, "tag"), node("span", hm(zoneMinutes(new Date(record.at))), "tag"));
    box.append(meta);
    container.append(box);
  }
}
// Другой день грузится, когда его открыли, и помнится до следующего изменения
// журнала: чужие события — из календаря, сделанное — из отчёта «Обзора»;
// свои дела берутся из уже загруженных записей.
async function ensureDayData(date) {
  if (todayState.cache.has(date) || todayState.loading.has(date)) return;
  todayState.loading.add(date);
  try {
    const [calendar, report] = await Promise.all([
      request(`/api/calendar?from=${date}&to=${date}`).catch(() => null),
      request(`/api/reports/day?date=${date}`).catch(() => null),
    ]);
    todayState.cache.set(date, { calendar, report });
  } finally {
    todayState.loading.delete(date);
  }
  if (!currentDayDate) return;
  if ([todayState.view, todayState.journalView].some((offset) => shiftDate(currentDayDate, offset) === date)) renderToday();
}
// Раз в минуту обложка и строка «сейчас» пересчитываются — но не под руками:
// с текстом в поле страница ждёт.
setInterval(() => {
  if ($("#today")?.hidden || !currentDayDate) return;
  if (typeof captureField !== "undefined" && String(captureField.getValue()).trim()) return;
  renderToday();
}, 60000);
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
  // Календарь на сегодня и завтра нужен «Дню» и брифу. Он грузится вместе с
  // журналом, но только пока открыта «Сегодня»: на других страницах журнал
  // перечитывается так же быстро, как раньше, а календарь добирается при
  // возвращении. Другие дни грузятся, когда их открывают, и забываются при
  // каждом изменении журнала.
  const todayGuess = currentDayDate || zoneDate(new Date());
  const onToday = !$("#today")?.hidden;
  const [day, entries, calendar] = await Promise.all([
    request("/api/day"),
    request("/api/entries?limit=100"),
    onToday ? request(`/api/calendar?from=${todayGuess}&to=${shiftDate(todayGuess, 1)}`).catch(() => null) : Promise.resolve(undefined),
  ]);
  todayState.cache.clear();
  if (calendar !== undefined && todayGuess === day.date) {
    todayState.calendar = calendar;
    todayState.calendarStale = false;
  } else todayState.calendarStale = true;
  render({ ...day, entries: entries.entries });
  // Доска и «Обзор» живут своими запросами: правка в карточке или доразбор
  // записи должны быть видны сразу там, откуда карточку открыли, а не после
  // ухода на другую страницу и обратно. Перечитываются только уже собранные —
  // при старте их собирает переход по хэшу.
  const page = document.querySelector(".app-page:not([hidden])")?.id;
  if (page === "board" && boardState.data) await loadBoard();
  if (page === "calendar" && calState.data) await loadCalendar();
  if (page === "reports" && reportsState.loaded) await loadReports();
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
// Свойства уходят на сервер так же, как заметка: при закрытии карточки, без
// отдельной кнопки. Ссылка снимается до вызова — второй раз ничего не улетит.
let flushCardProps = null;
function flushCard() {
  const body = flushCardBody,
    props = flushCardProps;
  flushCardBody = null;
  flushCardProps = null;
  body?.();
  props?.();
}
// Поле заметки пересоздаётся на каждое открытие карточки, а меню разметки
// вешает слушатель на документ: без уборки они копились бы с каждым разом.
let closeCardSlashMenu = null;
function closeCard() {
  const dialog = $("#review-dialog");
  // Сохранение уходит своим ходом: карточка закрывается сразу, но значения
  // полей читаются сейчас, пока разметка ещё на месте.
  flushCard();
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
// Значки свойств — как в Notion: монохромные контуры слева от имени. Инлайновый
// SVG, а не символы шрифта: глифы в каждом шрифте сидят по-своему.
const PROP_ICONS = {
  type: '<circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.7 7.2 8 9.5l2.3-2.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  schedule: '<rect x="2.6" y="3.4" width="10.8" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.4 1.9v2.6M10.6 1.9v2.6M2.6 6.9h10.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  project: '<path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  people: '<circle cx="8" cy="5.1" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.9 13.6a5.3 5.3 0 0 1 10.2 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  next: '<path d="M2.6 8h10M9.2 4.6 12.6 8l-3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  done: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m5.3 8.2 1.9 1.9 3.6-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  written: '<circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.9V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
};
function propIcon(name) {
  const glyph = node("span", undefined, "prop-icon");
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16">${PROP_ICONS[name]}</svg>`;
  return glyph;
}
// Крестик справа — быстрый сброс свойства: «без даты», «без проекта». Показан
// только у заполненного свойства и только по наведению, чтобы не шуметь.
function propertyRow(label, control, icon, { clear = null, filled = null } = {}) {
  const row = node("div", undefined, "prop");
  const name = node("span", label, "prop-label");
  if (icon) name.prepend(propIcon(icon));
  row.append(name, control);
  if (clear) {
    const reset = node("button", "×", "prop-clear");
    reset.type = "button";
    reset.title = `Сбросить: ${label.toLowerCase()}`;
    reset.setAttribute("aria-label", reset.title);
    reset.addEventListener("click", (event) => { event.preventDefault(); clear(); paint(); });
    const paint = () => { reset.hidden = filled ? !filled() : false; };
    control.addEventListener("input", paint);
    control.addEventListener("change", paint);
    row.append(reset);
    row.classList.add("has-clear");
    paint();
  }
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
// Источник можно подменить: снимок из буфера ещё не на сервере и живёт по
// blob-адресу, а просмотр у него тот же, что у сохранённых вложений.
function previewAttachment(attachment, src = `/api/attachments/${attachment.id}`) {
  const dialog = $("#preview-dialog"),
    body = $("#preview-body"),
    title = $("#preview-title"),
    download = $("#preview-download");
  clear(body);
  title.textContent = attachment.filename;
  download.href = src;
  download.download = attachment.filename;
  if (IMAGE_TYPES.has(attachment.contentType)) {
    const image = node("img", undefined, "preview-image");
    image.src = src;
    image.alt = attachment.filename;
    body.append(image);
  } else if (attachment.contentType === "application/pdf") {
    const frame = node("iframe", undefined, "preview-frame");
    frame.src = src;
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
    head = node("div", undefined, "card-files-head"),
    label = node("p", "Вложения", "prop-section"),
    emptyMark = node("span", " · Пока пусто", "attach-empty"),
    grid = node("div", undefined, "file-grid"),
    input = document.createElement("input"),
    add = node("button", "Добавить файл", "secondary");
  label.append(emptyMark);
  add.title = "Перетащите файл сюда или выберите — до 10 файлов, каждый до 10 МБ.";
  let files = entry.attachments || [];
  input.type = "file";
  input.multiple = true;
  input.className = "sr-only";
  input.id = `attach-${entry.id}`;
  add.type = "button";
  add.addEventListener("click", () => input.click());

  const paint = () => {
    clear(grid);
    grid.hidden = !files.length;
    emptyMark.hidden = files.length > 0;
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
  // ⌘V со скриншотом прикладывает его к открытой записи. Фокус при открытой
  // карточке живёт внутри неё, поэтому слушается документ — пока блок на
  // странице; после закрытия карточки слушатель снимает себя сам.
  const onPaste = (event) => {
    if (!wrap.isConnected) { document.removeEventListener("paste", onPaste); return; }
    if (event.target instanceof Element && event.target.closest("#capture-form")) return;
    const images = pastedImages(event.clipboardData);
    if (!images.length) return;
    event.preventDefault();
    upload(images.map(namedShot));
  };
  document.addEventListener("paste", onPaste);

  paint();
  head.append(label, add);
  wrap.append(head, grid, input);
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
    placeholder: "Введите «/» для команд разметки…",
    onSubmit: () => save(),
  });
  field.element.classList.add("card-markdown");
  // Разметку помнить наизусть незачем: «/» показывает, что тут вообще бывает.
  closeCardSlashMenu?.();
  const slashMenu = attachSlashMenu(field);
  // Панель оформления живёт столько же, сколько поле: убирается вместе с меню.
  const formatBar = attachFormatToolbar(field, { prefs: window.pagentText });
  closeCardSlashMenu = () => { slashMenu.destroy(); formatBar.destroy(); closeCardSlashMenu = null; };
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
// ── статус записи ────────────────────────────────────────────────────────────
// Выводится, а не вводится: из типа, срока и «сделано». Стиль — «значок и
// слово», по-нотионовски строкой свойства; цвет помогает, смысл назван словом.
const STATUS_ICONS = {
  done: '<path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  late: '<path d="M8 2.6 14.4 13H1.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.4v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.6" fill="currentColor"/>',
  clock: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.7V8l2.3 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  none: '<path d="M4 8h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
function entryStatus(entry, today = currentDayDate) {
  const c = entry.interpretation.classification;
  if (isReportedWork(entry) || isClosed(entry))
    return { key: "done", label: "Сделано", icon: "done" };
  // Статус есть только у дел: заметки, идеи и незакрытые результаты живут без него.
  if (
    !completableProjections(entry).length &&
    !["task", "meeting_event"].includes(c.primaryType)
  )
    return null;
  const date = c.entities.schedule?.date || null;
  if (!date) return { key: "none", label: "Без срока", icon: "none" };
  if (today && date < today) return { key: "late", label: "Просрочено", icon: "late" };
  if (today && date === today) return { key: "today", label: "Сегодня", icon: "clock" };
  return { key: "ontime", label: "В срок", icon: "clock" };
}
function statusBadge(status) {
  const badge = node("span", undefined, `entry-status st-${status.key}`),
    icon = node("span", undefined, "status-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14">${STATUS_ICONS[status.icon]}</svg>`;
  badge.append(icon, document.createTextNode(status.label));
  return badge;
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
  // Заголовок правится на месте: клик превращает его в поле, Enter сохраняет
  // уточнением (правда человека — факт), Escape возвращает как было.
  const cardTitle = markdownNode("h2", c.summary, "card-title", { inline: true, firstLine: true });
  cardTitle.title = "Изменить заголовок";
  cardTitle.tabIndex = 0;
  // Правки свойств, ещё не ушедшие на сервер (форма собирается ниже).
  let pendingProps = () => null;
  const startTitleEdit = () => {
    const editor = document.createElement("textarea");
    editor.className = "card-title-edit";
    editor.value = c.summary;
    editor.rows = 1;
    cardTitle.replaceWith(editor);
    const fit = () => { editor.style.height = "auto"; editor.style.height = `${editor.scrollHeight}px`; };
    editor.addEventListener("input", fit);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    fit();
    let settled = false;
    const cancel = () => { settled = true; editor.replaceWith(cardTitle); };
    const save = async () => {
      if (settled) return;
      settled = true;
      const value = editor.value.trim();
      if (!value || value === c.summary) { editor.replaceWith(cardTitle); return; }
      editor.disabled = true;
      try {
        // Карточка после ответа перерисуется из сохранённой записи: правки
        // свойств, которые ещё не уходили, едут одним уточнением с заголовком.
        const result = await request(`/api/captures/${entry.id}/corrections`, {
          method: "POST",
          body: JSON.stringify({ patch: { ...(pendingProps() || {}), summary: value } }),
        });
        toast("Заголовок обновлён");
        const review = reviewFromEntry(result.entry);
        showCorrection(result.entry, review.level === "high" ? undefined : review);
        load();
      } catch (error) {
        toast(error.message);
        editor.replaceWith(cardTitle);
      }
    };
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save(); }
    });
    editor.addEventListener("blur", save);
  };
  cardTitle.addEventListener("click", startTitleEdit);
  cardTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); startTitleEdit(); }
  });
  area.append(cardTitle);
  // «Когда это было» — справочная мета: живёт футером внизу карточки одной
  // строкой, а не блоком в шапке. Шапка — заголовок, статус и заметки.
  const written = entryClock(entry);
  if (review.question)
    area.append(node("p", review.question, "review-question"));

  const form = node("form", undefined, "review-form"),
    type = document.createElement("select"),
    date = document.createElement("input"),
    time = document.createElement("input"),
    end = document.createElement("input"),
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
  // Конец — для блока в календаре: без него встрече рисуется час, делу —
  // полчаса. Поле появляется, когда есть время начала.
  end.type = "time";
  end.id = "review-end";
  end.value = c.entities.schedule?.end || "";
  end.title = "Окончание";
  end.setAttribute("aria-label", "Окончание");
  const paintEnd = () => { end.hidden = !time.value; if (!time.value) end.value = ""; };
  time.addEventListener("input", paintEnd);
  paintEnd();
  // Напоминание — свойство срока: за сколько до начала у дела со временем,
  // в час напоминаний у дела без времени. Пусто — как в настройках.
  const remind = node("select", undefined, "review-remind");
  remind.id = "review-remind";
  remind.setAttribute("aria-label", "Напомнить");
  const storedRemind = c.entities.schedule?.remind;
  let remindChoice = storedRemind === undefined || storedRemind === null ? "" : String(storedRemind);
  const paintRemind = () => {
    const timed = Boolean(time.value);
    const current = !timed && /^\d+$/.test(remindChoice) ? "0" : remindChoice;
    clear(remind);
    const options = timed
      ? [["", `как в настройках (${remindDefaultLabel()})`], ["off", "не напоминать"], ["0", "в момент начала"], ["5", "за 5 минут"], ["15", "за 15 минут"], ["30", "за 30 минут"], ["60", "за час"], ["120", "за 2 часа"], ["1440", "за день"]]
      : [["", `как в настройках (${remindHourLabel()})`], ["off", "не напоминать"], ["0", `в ${remindHourValue()}`]];
    if (current && !options.some(([value]) => value === current)) options.push([current, `за ${current} мин`]);
    for (const [value, label] of options) { const option = node("option", label); option.value = value; option.selected = value === current; remind.append(option); }
  };
  remind.addEventListener("change", () => { remindChoice = remind.value; });
  time.addEventListener("input", paintRemind);
  paintRemind();
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
  const endWrap = node("span", undefined, "review-end");
  endWrap.append(node("span", "до", "review-end-label"), end);
  scheduleRow.append(date, time, endWrap, remind);
  // Сброс уходит на сервер сразу: «без даты» — это решение, а не правка на
  // полпути, и ждать закрытия карточки ему незачем.
  let saveProps = () => {};
  const clearAndSave = (apply) => { apply(); saveProps(); };
  const scheduleWrap = propertyRow("Срок", scheduleRow, "schedule", { clear: () => clearAndSave(() => { date.value = ""; time.value = ""; end.value = ""; remindChoice = ""; paintEnd(); paintRemind(); }), filled: () => Boolean(date.value || time.value) }),
    peopleWrap = propertyRow("Участники", people, "people", { clear: () => clearAndSave(() => { people.value = ""; }), filled: () => Boolean(people.value.trim()) }),
    followUpWrap = propertyRow("Далее", followUp, "next", { clear: () => clearAndSave(() => { followUp.value = ""; }), filled: () => Boolean(followUp.value.trim()) });
  const props = node("div", undefined, "props");
  props.append(
    propertyRow("Тип", type, "type"),
    scheduleWrap,
    propertyRow("Проект", project, "project", { clear: () => clearAndSave(() => { project.value = ""; }), filled: () => Boolean(project.value.trim()) }),
    peopleWrap,
    followUpWrap,
    propertyRow("Сделано", doneToggle, "done"),
  );
  props.id = "review-props";
  const updateVisibility = () => {
    const scheduled =
      ["meeting_event", "task"].includes(type.value) || review.field === "schedule";
    scheduleWrap.hidden = !scheduled;
    peopleWrap.hidden = type.value === "note" || type.value === "idea_question";
    followUpWrap.hidden =
      type.value === "note" || type.value === "idea_question";
  };
  // Свойства свёрнуты в строку-сводку: карточку открывают ради заметок, а не
  // ради формы. Кнопка-строка разворачивает полный список; когда карточка
  // открыта под уточнение (есть вопрос модели) — свойства сразу развёрнуты.
  const propsBar = node("button", undefined, "props-bar");
  propsBar.type = "button";
  propsBar.setAttribute("aria-controls", "review-props");
  const propsChevron = node("span", undefined, "props-chevron");
  propsChevron.setAttribute("aria-hidden", "true");
  const propsSummary = node("span", undefined, "props-summary");
  propsBar.append(propsChevron, propsSummary);
  let propsOpen = Boolean(review.question || review.field);
  const summaryText = () => {
    const parts = [typeNames[type.value] || type.value];
    if (project.value.trim()) parts.push(project.value.trim());
    const due = scheduleLabel({ state: "ok", date: date.value || null, time: time.value || null });
    if (!scheduleWrap.hidden && due) parts.push(`срок: ${due}${time.value && end.value ? `–${end.value}` : ""}`);
    if (!scheduleWrap.hidden && due && remind.value) parts.push(remind.value === "off" ? "без напоминания" : `напомнить ${remind.selectedOptions[0]?.textContent || ""}`);
    if (!peopleWrap.hidden && people.value.trim()) parts.push(people.value.trim());
    if (!followUpWrap.hidden && followUp.value.trim()) parts.push(`далее: ${followUp.value.trim()}`);
    return parts.join("   ·   ");
  };
  const paintProps = () => {
    props.hidden = !propsOpen;
    propsBar.setAttribute("aria-expanded", String(propsOpen));
    propsBar.classList.toggle("open", propsOpen);
    clear(propsSummary);
    if (propsOpen) propsSummary.append(document.createTextNode("Свойства"));
    else {
      // Чип статуса ведёт строку: состояние видно, не разворачивая свойства.
      // Берётся из сохранённой записи — правки живут в развёрнутой форме.
      const state = entryStatus(entry);
      if (state) propsSummary.append(statusBadge(state), document.createTextNode("   ·   "));
      propsSummary.append(document.createTextNode(summaryText()));
    }
    propsSummary.classList.toggle("is-label", propsOpen);
  };
  type.addEventListener("change", () => { updateVisibility(); });
  updateVisibility();
  propsBar.addEventListener("click", () => { propsOpen = !propsOpen; paintProps(); });
  paintProps();
  form.append(propsBar, props);
  // Кнопки «сохранить» нет: свойства уходят на сервер сами, когда карточка
  // закрывается — крестиком, подложкой или Esc, — как и заметка. Снимок при
  // открытии нужен, чтобы не слать уточнение, если ничего не трогали.
  const propsPatch = () => {
    const patch = {
      primaryType: type.value,
      project: project.value.trim() || null,
      people: people.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      followUp: followUp.value.trim() || null,
      completed: done,
    };
    if (!scheduleWrap.hidden)
      patch.schedule = { date: date.value || null, time: time.value || null, ...(time.value && end.value && end.value > time.value ? { end: end.value } : {}), remind: remind.value === "" ? null : remind.value === "off" ? "off" : Number(remind.value) };
    return patch;
  };
  const untouched = JSON.stringify(propsPatch());
  pendingProps = () =>
    JSON.stringify(propsPatch()) === untouched ? null : propsPatch();
  let propsSaving = false;
  saveProps = async () => {
    const patch = pendingProps();
    if (!patch || propsSaving) return;
    propsSaving = true;
    try {
      const result = await request(`/api/captures/${entry.id}/corrections`, {
        method: "POST",
        body: JSON.stringify({
          patch: { ...patch, note: "Пользователь исправил классификацию" },
        }),
      });
      toast(
        result.review.level === "high" || result.review.safeNote
          ? "Уточнение сохранено"
          : "Нужно ещё одно уточнение",
      );
      await load();
    } catch (error) {
      toast(error.message);
    } finally {
      propsSaving = false;
    }
  };
  flushCardProps = saveProps;
  // Enter в поле свойства раньше отправлял форму; отправлять больше нечего.
  form.addEventListener("submit", (event) => event.preventDefault());
  area.append(form, cardBody(entry));
  // Футер прижат к низу листа и собран в строку: вложения, «когда записано»,
  // источник и удаление — служебный подвал, а не столбик в теле карточки.
  const footer = node("div", undefined, "card-footer");
  footer.append(attachmentsBlock(entry));
  const footerRow = node("div", undefined, "card-footer-row");
  if (written) {
    const stamp = node("p", `Записано: ${written}`, "card-written card-footer-line");
    stamp.prepend(propIcon("written"));
    footerRow.append(stamp);
  }
  footer.append(footerRow);
  area.append(footer);

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
  footerRow.append(source);

  // Удаление живёт внизу карточки, отдельно от правок: это не «ещё одно
  // уточнение», а выход из журнала.
  const remove = node("button", "Удалить запись", "card-delete");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    // Записи больше не будет: сохранять в неё заметку и свойства незачем.
    flushCardBody = null;
    flushCardProps = null;
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
  footerRow.append(remove);
  // Отправить встречу во внешний календарь можно только отсюда, кнопкой:
  // по контракту памяти действие наружу всегда ждёт отдельного подтверждения.
  if (["task", "meeting_event"].includes(c.primaryType) && c.entities.schedule?.date) footerRow.prepend(calendarExportEl(entry));
  if (!dialog.open) {
    // Прерванное закрытие могло оставить незавершённую анимацию: снимаем её,
    // иначе карточка откроется прозрачной.
    for (const animation of dialog.getAnimations()) animation.cancel();
    dialog.showModal();
    syncCardViewport();
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
attachFormatToolbar(captureField, { prefs: window.pagentText });
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
const composerState = { type: "auto", userType: false, date: null, time: null, priority: "normal", tags: [] };
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
  composerState.userType = false;
  composerState.date = null;
  composerState.time = null;
  composerState.priority = "normal";
  composerState.tags = [];
  renderCaptureControls();
  // Поле снова пустое — фаза суток может вернуть свой тип и вопрос.
  applyCoverComposer();
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
    composerState.userType = true;
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
  // Вопрос в поле — по фазе суток, пока тип тот, для которого он задан.
  captureField.setPlaceholder(todayState.placeholder && composerState.type === todayState.placeholderType ? todayState.placeholder : type.placeholder);
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

// Высота поля живёт в браузере и переживает перезагрузку; меняется нижним
// краем карточки. Лист (capture-large) её не трогает: там высоту задаёт окно.
const CAPTURE_HEIGHT = { min: 96, max: 480, key: "kizuna-capture-height" };
function readCaptureHeight() {
  try {
    const value = Number(localStorage.getItem(CAPTURE_HEIGHT.key));
    return Number.isFinite(value) && value >= CAPTURE_HEIGHT.min ? Math.min(value, CAPTURE_HEIGHT.max) : null;
  } catch {
    return null;
  }
}
function paintCaptureHeight() {
  const height = readCaptureHeight();
  const form = $("#capture-form");
  if (height) form.style.setProperty("--capture-height", `${height}px`);
  else form.style.removeProperty("--capture-height");
}
paintCaptureHeight();
// Края карточки тянутся, как у окна: нижний — высота, боковые — ширина, углы —
// обе. Карточка стоит по центру, поэтому сдвиг бокового края удваивается: край
// идёт за курсором, а карточка остаётся на оси. Двойной клик по краю
// возвращает размер по умолчанию.
const CAPTURE_WIDTH = { min: 480, key: "kizuna-capture-width" };
function readCaptureWidth() {
  try {
    const value = Number(localStorage.getItem(CAPTURE_WIDTH.key));
    return Number.isFinite(value) && value >= CAPTURE_WIDTH.min ? value : null;
  } catch {
    return null;
  }
}
function paintCaptureWidth() {
  const width = readCaptureWidth();
  const page = $("#today");
  if (width) page.style.setProperty("--capture-width", `${width}px`);
  else page.style.removeProperty("--capture-width");
}
paintCaptureWidth();
for (const grip of document.querySelectorAll("#capture-form .capture-resize")) {
  const dir = grip.dataset.dir;
  grip.addEventListener("dblclick", () => {
    try {
      if (/[ew]/.test(dir)) localStorage.removeItem(CAPTURE_WIDTH.key);
      if (dir.includes("s")) localStorage.removeItem(CAPTURE_HEIGHT.key);
    } catch {}
    paintCaptureWidth();
    paintCaptureHeight();
  });
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || captureLarge()) return;
    const form = $("#capture-form");
    const startX = event.clientX, startY = event.clientY;
    const startWidth = form.getBoundingClientRect().width;
    const startHeight = parseFloat(getComputedStyle(captureField.element).minHeight) || CAPTURE_HEIGHT.min;
    const sx = dir.includes("e") ? 2 : dir.includes("w") ? -2 : 0;
    const sy = dir.includes("s") ? 1 : 0;
    const maxWidth = Math.min(1120, window.innerWidth) - 48;
    let width = startWidth, height = startHeight;
    grip.setPointerCapture(event.pointerId);
    form.classList.add("resizing");
    event.preventDefault();
    const move = (e) => {
      if (sx) {
        width = Math.min(maxWidth, Math.max(CAPTURE_WIDTH.min, startWidth + sx * (e.clientX - startX)));
        $("#today").style.setProperty("--capture-width", `${Math.round(width)}px`);
      }
      if (sy) {
        height = Math.min(CAPTURE_HEIGHT.max, Math.max(CAPTURE_HEIGHT.min, startHeight + sy * (e.clientY - startY)));
        form.style.setProperty("--capture-height", `${Math.round(height)}px`);
      }
    };
    const stop = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", stop);
      grip.removeEventListener("pointercancel", stop);
      form.classList.remove("resizing");
      try {
        if (sx) localStorage.setItem(CAPTURE_WIDTH.key, String(Math.round(width)));
        if (sy) localStorage.setItem(CAPTURE_HEIGHT.key, String(Math.round(height)));
      } catch {}
      paintCaptureWidth();
      paintCaptureHeight();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  });
}
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
    uploadPendingShots(result.data.captureId);
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
      syncPushSubscription();
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
  "googleClientId",
  "googleClientSecret",
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
  "remindDefault",
  "remindHour",
  "theme",
  "voiceEnabled",
  "voiceLimitWindow",
  "voiceLimitMinutes",
  "voiceLimitUsd",
  "voiceRateUsdPerMinute",
  "voiceGeminiRateUsdPerMinute",
  "monthlyLimitUsd",
];
const SECRET_FIELDS = ["openaiKey", "geminiKey", "openrouterKey", "googleClientSecret"];
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
      if (document.activeElement !== input) input.value = "";
      const state = document.getElementById(`state-${name}`);
      if (state)
        state.textContent = value?.configured
          ? `${value.hint}${value.fromEnvironment ? " · из .env" : ""}`
          : "не настроен";
      continue;
    }
    // Поле, в котором человек сейчас печатает, не трогаем: автосохранение
    // соседней настройки не должно отбирать недописанный текст и каретку.
    const next = String(value ?? "");
    if (document.activeElement !== input && input.value !== next) input.value = next;
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
// Автосохранение: настройка уходит на сервер сама — списки при выборе, поля
// при уходе фокуса из них, длинный текст промпта ещё и после паузы в наборе.
// Кнопки «Сохранить» нет: жать её было отдельной работой, а забыть — способом
// потерять правку. Тема не здесь: у неё свой обработчик, который ещё и
// перекрашивает страницу.
const AUTOSAVE_PAUSE_MS = 900;
const autosaveTimers = new Map();
function autosaveSetting(name, input) {
  autosaveTimers.delete(name);
  const value = input.value.trim();
  // Пустое поле ключа значит «не трогать»: ключ в него не возвращается.
  if (SECRET_FIELDS.includes(name)) {
    if (value) saveSettings({ [name]: value }, { announce: null });
    return;
  }
  if (value === String(appSettings[name] ?? "")) return;
  saveSettings({ [name]: value }, { announce: null });
}
for (const name of SETTING_FIELDS) {
  if (name === "theme") continue;
  const input = settingInput(name);
  if (!input) continue;
  input.addEventListener("change", () => {
    clearTimeout(autosaveTimers.get(name));
    autosaveSetting(name, input);
  });
  if (input.tagName === "TEXTAREA")
    input.addEventListener("input", () => {
      clearTimeout(autosaveTimers.get(name));
      autosaveTimers.set(name, setTimeout(() => autosaveSetting(name, input), AUTOSAVE_PAUSE_MS));
    });
}
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
// Escape и клик по подложке закрывают карточку; что менялось — сохраняется.
$("#review-dialog").addEventListener("close", () => {
  // Esc закрывает диалог сам, мимо closeCard: правки забираем и меню разметки
  // убираем здесь же, пока поля ещё на месте — иначе меню осталось бы на
  // документе вместе со своим слушателем клавиш, а правки пропали бы.
  flushCard();
  closeCardSlashMenu?.();
  clear($("#review"));
  syncCardViewport();
});
// На телефоне клавиатура сжимает видимую область, а не окно: Safari тогда
// прокручивает документ, чтобы показать каретку, и уводит карточку за экран,
// а вставка попадает в никуда. Пока карточка открыта, её верх и высота идут
// за visualViewport — поле заметки остаётся над клавиатурой, и прокручивается
// сама карточка, а не страница. На широком экране размер задаёт CSS.
const CARD_PHONE = window.matchMedia("(max-width: 760px)");
function syncCardViewport() {
  const dialog = $("#review-dialog"),
    viewport = window.visualViewport;
  if (!dialog.open || !viewport || !CARD_PHONE.matches) {
    dialog.style.removeProperty("top");
    dialog.style.removeProperty("bottom");
    dialog.style.removeProperty("height");
    return;
  }
  dialog.style.top = `${Math.round(viewport.offsetTop)}px`;
  dialog.style.bottom = "auto";
  dialog.style.height = `${Math.round(viewport.height)}px`;
}
window.visualViewport?.addEventListener("resize", syncCardViewport);
window.visualViewport?.addEventListener("scroll", syncCardViewport);
CARD_PHONE.addEventListener("change", syncCardViewport);
$("#review-dialog").addEventListener("click", (event) => {
  if (event.target === $("#review-dialog")) closeCard();
});
// Карточку можно растянуть или сжать мышкой за край или угол. Тянется
// симметрично — она остаётся по центру, как и была, а край идёт за курсором.
// Размер запоминается и возвращается при следующем открытии; двойной клик по
// краю возвращает исходный.
const cardSizeStorageKey = "pagent.card-size";
const CARD_MIN_WIDTH = 480;
const CARD_MIN_HEIGHT = 360;
function applyCardSize(size) {
  const dialog = $("#review-dialog");
  if (!size) {
    dialog.style.removeProperty("--card-w");
    dialog.style.removeProperty("--card-h");
    return;
  }
  dialog.style.setProperty("--card-w", `${Math.round(size.width)}px`);
  dialog.style.setProperty("--card-h", `${Math.round(size.height)}px`);
}
function restoreCardSize() {
  try {
    const stored = JSON.parse(localStorage.getItem(cardSizeStorageKey));
    if (stored && Number.isFinite(stored.width) && Number.isFinite(stored.height)) applyCardSize(stored);
  } catch {
    localStorage.removeItem(cardSizeStorageKey);
  }
}
restoreCardSize();
for (const handle of document.querySelectorAll("#review-dialog .card-resize")) {
  const dir = handle.dataset.dir;
  handle.addEventListener("dblclick", () => {
    applyCardSize(null);
    localStorage.removeItem(cardSizeStorageKey);
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const dialog = $("#review-dialog");
    const start = dialog.getBoundingClientRect();
    const startX = event.clientX,
      startY = event.clientY;
    // Знак: правый и нижний края растут вслед за курсором, левый и верхний —
    // навстречу. Карточка центрирована, поэтому сдвиг края удваивается.
    const sx = dir.includes("e") ? 2 : dir.includes("w") ? -2 : 0;
    const sy = dir.includes("s") ? 2 : dir.includes("n") ? -2 : 0;
    let size = { width: start.width, height: start.height };
    handle.setPointerCapture(event.pointerId);
    dialog.classList.add("resizing");
    event.preventDefault();
    const move = (e) => {
      size = {
        width: Math.min(
          window.innerWidth - 24,
          Math.max(CARD_MIN_WIDTH, start.width + sx * (e.clientX - startX)),
        ),
        height: Math.min(
          window.innerHeight - 24,
          Math.max(CARD_MIN_HEIGHT, start.height + sy * (e.clientY - startY)),
        ),
      };
      applyCardSize(size);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      dialog.classList.remove("resizing");
      localStorage.setItem(
        cardSizeStorageKey,
        JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }),
      );
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
}
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
  // Напоминание в открытую вкладку: тост с «Открыть». Системное уведомление
  // сюда не дублируется — на закрытую вкладку и телефон его несёт push.
  journalStream.addEventListener("reminder", (event) => {
    try {
      const reminder = JSON.parse(event.data);
      toast(`${reminder.title} — ${reminder.body}`, { label: "Открыть", run: () => openCaptureById(reminder.captureId) });
    } catch {}
  });
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
  button.innerHTML = window.pagentTheme.icon();
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

// ── страница «Обзор»: отчёты по записям ─────────────────────────────────────
// Правила из концепта reports-concept.html: списки важнее графиков, каждая
// строка открывает карточку записи, всё названо словом. Данные считает сервер
// одним запросом; здесь только отрисовка.
const REPORT_TYPES = ["task", "meeting_event", "note", "outcome_decision", "idea_question"];
const reportLegendNames = { task: "Задачи", meeting_event: "Встречи", note: "Заметки", outcome_decision: "Решения", idea_question: "Вопросы" };
const correctionFieldNames = { schedule: "срок", primaryType: "тип", project: "проект", projects: "проекты", people: "люди", followUp: "следующий шаг", tags: "теги", priority: "важность", summary: "формулировка" };
function pluralRu(count, one, few, many) {
  const mod10 = count % 10, mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
// Подписи дат считаются от строки YYYY-MM-DD через полдень UTC: label не
// зависит от пояса браузера, а время конкретных событий форматируется в поясе
// журнала, который присылает сервер.
function reportDateLabel(date, options = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));
}
function reportTimeLabel(at, timeZone) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}
function reportCounter({ num, cap, sub, cls = "" }) {
  const box = node("div", undefined, "report-counter");
  box.append(node("div", String(num), `num ${cls}`.trim()), node("div", cap, "cap"));
  if (sub) box.append(node("div", sub, "sub"));
  return box;
}
function reportCard(title, { right = null, hint = null } = {}) {
  const card = node("div", undefined, "report-card"),
    head = node("div", undefined, "report-card-head");
  head.append(node("h3", title));
  if (right) head.append(node("span", right, "right"));
  card.append(head);
  if (hint) card.append(node("p", hint, "report-hint"));
  return card;
}
// Каждая строка — дверь: клик открывает ту же карточку записи, что и журнал.
async function openReportEntry(captureId) {
  try {
    const { entries } = await request("/api/entries?limit=100");
    const entry = entries.find((candidate) => candidate.id === captureId);
    if (!entry) { toast("Запись не нашлась среди последних ста."); return; }
    const review = reviewFromEntry(entry);
    showCorrection(entry, review.level === "high" ? undefined : review);
  } catch (error) {
    toast(error.message);
  }
}
function reportItem({ captureId, title, type = null, meta = null, metaCls = "" }) {
  const item = node("li", undefined, undefined);
  item.title = "Откроется карточка записи";
  if (type) item.append(node("i", undefined, `report-dot ${type}`));
  item.append(node("span", String(title).split("\n")[0], "t"));
  if (meta) item.append(node("span", meta, `meta ${metaCls}`.trim()));
  item.addEventListener("click", () => openReportEntry(captureId));
  return item;
}
function reportItemList(rows, emptyText) {
  if (!rows.length) return node("p", emptyText, "report-empty");
  const list = node("ul", undefined, "report-items");
  for (const row of rows) list.append(reportItem(row));
  return list;
}
function reportBar({ name, caption = null, share, value, cost = false }) {
  const row = node("div", undefined, "report-bar"),
    label = node("span", name, "name"),
    track = node("span", undefined, "track"),
    fill = node("span", undefined, `fill${cost ? " cost" : ""}`);
  if (caption) label.append(node("small", caption));
  fill.style.width = `${Math.max(Math.round(share * 100), 2)}%`;
  track.append(fill);
  row.append(label, track, node("span", value, "n"));
  return row;
}
function reportPulseCard(pulse, captionText) {
  const card = reportCard("Пульс", { right: captionText });
  const chart = node("div", undefined, "report-chart"),
    labels = node("div", undefined, "report-chart-labels");
  const max = Math.max(...pulse.columns.map((column) => column.total), 1);
  const unitHeight = 88 / max;
  let previousMonth = null;
  for (const [index, column] of pulse.columns.entries()) {
    const col = node("div", undefined, `col${column.total ? "" : " empty"}`);
    col.title = `${reportDateLabel(column.date)} — ${column.total}`;
    for (const type of REPORT_TYPES) {
      if (!column.types[type]) continue;
      const seg = node("span", undefined, `seg report-dot ${type}`);
      seg.style.height = `${Math.max(column.types[type] * unitHeight, 4)}px`;
      col.append(seg);
    }
    chart.append(col);
    let text = "";
    if (pulse.unit === "week") {
      const month = column.date.slice(5, 7);
      if (month !== previousMonth) { text = reportDateLabel(column.date, { month: "short" }); previousMonth = month; }
    } else if (pulse.columns.length <= 7) {
      text = reportDateLabel(column.date, { weekday: "short" });
    } else if (index % 7 === 0) {
      text = String(Number(column.date.slice(8, 10)));
    }
    labels.append(node("span", text));
  }
  const legend = node("div", undefined, "report-legend");
  for (const type of REPORT_TYPES) {
    const key = node("span");
    key.append(node("i", undefined, `report-dot ${type}`), document.createTextNode(reportLegendNames[type]));
    legend.append(key);
  }
  card.append(chart, labels, legend);
  return card;
}
function renderReportsLife(area, data) {
  clear(area);
  const c = data.counters;
  const counters = node("div", undefined, "report-counters");
  const periodNames = { week: "за неделю", month: "за месяц", all: "за всё время" };
  const prevNames = { week: "прошлая неделя", month: "прошлый месяц" };
  counters.append(
    reportCounter({ num: c.done, cls: c.done ? "good" : "", cap: pluralRu(c.done, "задача сделана", "задачи сделано", "задач сделано"), sub: periodNames[data.period] }),
    reportCounter({ num: c.captures, cap: pluralRu(c.captures, "новая запись", "новые записи", "новых записей"), sub: c.capturesPrev === null ? "с самого начала" : `${prevNames[data.period]} — ${c.capturesPrev}` }),
    reportCounter({ num: c.overdue, cls: c.overdue ? "bad" : "", cap: "просрочено", sub: c.overdue ? `старейшей — ${c.overdueOldestDays} ${pluralRu(c.overdueOldestDays, "день", "дня", "дней")}` : "хвостов нет" }),
    reportCounter({ num: c.questions, cap: pluralRu(c.questions, "вопрос без ответа", "вопроса без ответа", "вопросов без ответа"), sub: c.questions ? `старейшему — ${c.questionsOldestDays} ${pluralRu(c.questionsOldestDays, "день", "дня", "дней")}` : "всё отвечено" }),
  );
  area.append(counters);

  const pulseCaption = data.pulse.unit === "week"
    ? "записи по неделям"
    : `записи по дням, ${reportDateLabel(data.from)} — ${reportDateLabel(shiftDate(data.to, -1))}`;
  area.append(reportPulseCard(data.pulse, pulseCaption));

  const tails = node("div", undefined, "report-grid-3");
  const overdueCard = reportCard("Просрочено", { right: String(data.overdue.length || ""), hint: "Задачи со сроком в прошлом" });
  overdueCard.append(reportItemList(data.overdue.map((row) => ({
    captureId: row.captureId, title: row.title, type: "task",
    meta: row.daysLate === 1 ? "вчера" : `${row.daysLate} ${pluralRu(row.daysLate, "день", "дня", "дней")}`, metaCls: "bad",
  })), "Хвостов нет."));
  const questionsCard = reportCard("Без ответа", { right: String(data.questions.length || ""), hint: "Открытые вопросы и идеи" });
  questionsCard.append(reportItemList(data.questions.map((row) => ({
    captureId: row.captureId, title: row.title, type: "idea_question",
    meta: reportDateLabel(row.createdAt.slice(0, 10)),
  })), "Открытых вопросов нет."));
  const silentCard = reportCard("Встречи без следа", { right: String(data.silentMeetings.length || ""), hint: "Прошли, но итог не записан" });
  silentCard.append(reportItemList(data.silentMeetings.map((row) => ({
    captureId: row.captureId, title: row.title, type: "meeting_event",
    meta: reportDateLabel(row.date),
  })), "У всех встреч есть след."));
  tails.append(overdueCard, questionsCard, silentCard);
  area.append(tails);

  const slices = node("div", undefined, "report-grid-2");
  const projectsCard = reportCard("Проекты", { right: "по числу записей" });
  if (data.projects.length) {
    const bars = node("div", undefined, "report-bars");
    const max = Math.max(...data.projects.map((row) => row.count), 1);
    for (const row of data.projects) bars.append(reportBar({ name: row.name, share: row.count / max, value: String(row.count) }));
    projectsCard.append(bars);
  } else {
    projectsCard.append(node("p", "В записях периода проектов нет.", "report-empty"));
  }
  if (data.stalled.length) {
    const stale = node("div", undefined, "report-stale");
    stale.append(node("p", "Заглохло", "lbl"));
    for (const row of data.stalled)
      stale.append(node("div", `${row.name} — ${row.daysQuiet} ${pluralRu(row.daysQuiet, "день", "дня", "дней")} без записей`, "row"));
    projectsCard.append(stale);
  }
  const peopleCard = reportCard("Люди и теги");
  const chips = (rows, formatName) => {
    const wrap = node("div", undefined, "report-chips");
    for (const row of rows) {
      const chip = node("span", undefined, "report-chip");
      chip.append(node("b", formatName(row.name)), node("span", String(row.count), "n"));
      wrap.append(chip);
    }
    return wrap;
  };
  peopleCard.append(data.people.length ? chips(data.people, (name) => name) : node("p", "Людей в записях периода нет.", "report-empty"));
  peopleCard.append(node("p", "Теги", "report-chip-lbl"));
  peopleCard.append(data.tags.length ? chips(data.tags, (name) => `#${name}`) : node("p", "Тегов пока нет.", "report-empty"));
  slices.append(projectsCard, peopleCard);
  area.append(slices);

  const discipline = reportCard("Дисциплина", { right: "по закрытым записям периода" });
  if (!data.discipline.closed) {
    discipline.append(node("p", "В этом периоде ничего не закрыто.", "report-empty"));
  } else {
    const facts = node("div", undefined, "report-facts");
    if (data.discipline.medianDays !== null) {
      const fact = node("div", undefined, "report-fact");
      fact.append(node("b", `${String(data.discipline.medianDays).replace(".", ",")} ${pluralRu(Math.round(data.discipline.medianDays) || 1, "день", "дня", "дней")}`));
      fact.append(document.createTextNode("живёт дело — от записи до «готово» (медиана)"));
      facts.append(fact);
    }
    if (data.discipline.withDue) {
      const fact = node("div", undefined, "report-fact");
      fact.append(node("b", `${data.discipline.onTime} из ${data.discipline.withDue}`));
      fact.append(document.createTextNode("дел со сроком закрыты вовремя"));
      facts.append(fact);
    }
    if (!facts.childNodes.length) facts.append(node("p", "Закрытых дел со сроком в периоде нет.", "report-empty"));
    discipline.append(facts);
  }
  area.append(discipline);
}
function renderReportsService(area, data) {
  clear(area);
  const service = data.service;
  const counters = node("div", undefined, "report-counters");
  const minutes = Math.round((service.voice.seconds || 0) / 60);
  counters.append(
    reportCounter({ num: money(service.usage.costUsd), cap: "потрачено на разбор", sub: service.usage.unpriced ? `${service.usage.unpriced} ${pluralRu(service.usage.unpriced, "вызов", "вызова", "вызовов")} без цены` : "по данным провайдеров" }),
    reportCounter({ num: service.usage.calls, cap: pluralRu(service.usage.calls, "вызов модели", "вызова модели", "вызовов модели"), sub: service.quality.failed ? `${service.quality.failed} неудачных` : "все удались" }),
    reportCounter({ num: service.quality.corrections, cap: pluralRu(service.quality.corrections, "правка после модели", "правки после модели", "правок после модели"), sub: service.quality.topField ? `чаще всего — ${correctionFieldNames[service.quality.topField.field] || service.quality.topField.field}` : "правок не было" }),
    reportCounter({ num: `${minutes} мин`, cap: "голосом", sub: service.voice.sessions ? `${service.voice.sessions} ${pluralRu(service.voice.sessions, "сессия", "сессии", "сессий")} · ${money(service.voice.costUsd)}` : "голос не использовался" }),
  );
  area.append(counters);

  const grid = node("div", undefined, "report-grid-2");
  const usageCard = reportCard("Расходы на модели", { right: "за период" });
  if (service.usage.rows.length) {
    const bars = node("div", undefined, "report-bars");
    const max = Math.max(...service.usage.rows.map((row) => row.costUsd), 0.0001);
    for (const row of service.usage.rows)
      bars.append(reportBar({ name: providerNames[row.provider] || row.provider, caption: row.model || null, share: row.costUsd / max, value: money(row.costUsd), cost: true }));
    usageCard.append(bars);
  } else {
    usageCard.append(node("p", "В этом периоде модели не вызывались.", "report-empty"));
  }
  const qualityCard = reportCard("Качество разбора");
  const rows = [
    ["Правок после модели", service.quality.corrections],
    ["Переразборов моделью", service.quality.reclassified],
    ["Ждут разбора сейчас", service.quality.pendingNow],
    ["Неудачных разборов", service.quality.failed],
  ];
  const list = node("ul", undefined, "report-items");
  for (const [label, value] of rows) {
    const item = node("li");
    item.style.cursor = "default";
    item.append(node("span", label, "t"), node("span", String(value), "meta"));
    list.append(item);
  }
  qualityCard.append(list);
  grid.append(usageCard, qualityCard);
  area.append(grid);

  if (service.quality.providers.length) {
    const accuracy = reportCard("Точность по провайдерам", { right: "правки на разбор — меньше лучше" });
    const bars = node("div", undefined, "report-bars");
    for (const row of service.quality.providers)
      bars.append(reportBar({ name: providerNames[row.provider] || row.provider, share: row.parses ? row.corrections / row.parses : 0, value: `${row.corrections}/${row.parses}` }));
    accuracy.append(bars);
    area.append(accuracy);
  }
}
function renderReportsDay(area, data) {
  clear(area);
  reportsState.dayDate = data.date;
  const weekday = reportDateLabel(data.date, { weekday: "short" });
  const label = `${weekday}, ${reportDateLabel(data.date)}`;
  $("#reports-day-label").textContent =
    data.date === data.latest ? `сегодня — ${label}` : data.date === shiftDate(data.latest, -1) ? `вчера — ${label}` : label;
  $("#reports-day-prev").disabled = !data.hasOlder;
  $("#reports-day-next").disabled = data.date >= data.latest;
  const counters = node("div", undefined, "report-counters");
  const times = data.feed.map((row) => reportTimeLabel(row.at, data.timeZone));
  counters.append(
    reportCounter({ num: data.done.length, cls: data.done.length ? "good" : "", cap: pluralRu(data.done.length, "дело сделано", "дела сделано", "дел сделано"), sub: data.done.length ? null : "в этот день — ничего" }),
    reportCounter({ num: data.feed.length, cap: pluralRu(data.feed.length, "новая запись", "новые записи", "новых записей"), sub: times.length > 1 ? `с ${times[0]} до ${times.at(-1)}` : null }),
    reportCounter({ num: data.meetings, cap: pluralRu(data.meetings, "встреча", "встречи", "встреч"), sub: null }),
    reportCounter({ num: data.missed.length, cls: data.missed.length ? "bad" : "", cap: "не успел", sub: data.missed.length ? "срок был в этот день" : "хвостов не осталось" }),
  );
  area.append(counters);

  const grid = node("div", undefined, "report-grid-2");
  const doneCard = reportCard("Сделано", { right: String(data.done.length || ""), hint: "Зафиксированная работа за этот день — как в «Что делал»" });
  doneCard.append(reportItemList(data.done.map((row) => ({
    captureId: row.captureId, title: row.title, type: row.type,
    meta: reportTimeLabel(row.at, data.timeZone), metaCls: "ok",
  })), "За этот день работа не зафиксирована."));
  const missedCard = reportCard("Не успел", { right: String(data.missed.length || ""), hint: "Срок был в этот день, к вечеру не закрыто" });
  missedCard.append(reportItemList(data.missed.map((row) => ({
    captureId: row.captureId, title: row.title, type: "task",
    meta: row.closedLater ? "закрыто позже" : "теперь в «Просрочено»", metaCls: row.closedLater ? "" : "bad",
  })), "Всё со сроком на этот день — закрыто."));
  grid.append(doneCard, missedCard);
  area.append(grid);

  const feedCard = reportCard("Записано за день", { right: String(data.feed.length || ""), hint: "Все записи дня по времени" });
  feedCard.append(reportItemList(data.feed.map((row) => ({
    captureId: row.captureId, title: row.title, type: row.type,
    meta: reportTimeLabel(row.at, data.timeZone),
  })), "Записей в этот день нет."));
  area.append(feedCard);
}
function reportsView(tab) {
  return { life: $("#reports-life"), day: $("#reports-day"), service: $("#reports-service") }[tab];
}
async function loadReports() {
  const tab = reportsState.tab;
  for (const name of ["life", "day", "service"]) reportsView(name).hidden = name !== tab;
  $("#reports-period").hidden = tab === "day";
  $("#reports-daynav").hidden = tab !== "day";
  const area = reportsView(tab);
  if (!area.childNodes.length) area.append(node("p", "Считаем…", "empty"));
  try {
    if (tab === "day") {
      const query = reportsState.dayDate ? `?date=${reportsState.dayDate}` : "";
      renderReportsDay(area, await request(`/api/reports/day${query}`));
    } else {
      const data = await request(`/api/reports?period=${reportsState.period}`);
      if (tab === "life") renderReportsLife(area, data);
      else renderReportsService(area, data);
    }
    reportsState.loaded = true;
  } catch (error) {
    clear(area);
    area.append(node("p", error.message, "empty"));
  }
}
for (const button of document.querySelectorAll("[data-reports-tab]"))
  button.addEventListener("click", () => {
    reportsState.tab = button.dataset.reportsTab;
    for (const other of document.querySelectorAll("[data-reports-tab]"))
      other.setAttribute("aria-pressed", String(other === button));
    loadReports();
  });
for (const button of document.querySelectorAll("[data-reports-period]"))
  button.addEventListener("click", () => {
    reportsState.period = button.dataset.reportsPeriod;
    for (const other of document.querySelectorAll("[data-reports-period]"))
      other.setAttribute("aria-pressed", String(other === button));
    loadReports();
  });
$("#reports-day-prev")?.addEventListener("click", () => {
  if (reportsState.dayDate) { reportsState.dayDate = shiftDate(reportsState.dayDate, -1); loadReports(); }
});
$("#reports-day-next")?.addEventListener("click", () => {
  if (reportsState.dayDate) { reportsState.dayDate = shiftDate(reportsState.dayDate, 1); loadReports(); }
});

// ── снимки из буфера: ⌘V прикладывает картинку ──────────────────────────────
// В карточке ввода снимок ждёт отправки и уезжает вложением следом за записью;
// в открытой карточке записи — прикладывается сразу.
const SHOT_LIMIT = 10;
const SHOT_SIZE_LIMIT = 10 * 1024 * 1024;
const pendingShots = [];
function pastedImages(data) {
  return [...(data?.files || [])].filter((file) => file.type.startsWith("image/"));
}
// Скриншот приходит безликим «image.png» — называем моментом вставки, чтобы
// в списке вложений снимки различались.
function shotName(file) {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const stamp = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()).replaceAll(":", "-");
  const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return `снимок-${stamp}.${extension}`;
}
function namedShot(file) {
  return new File([file], shotName(file), { type: file.type });
}
function paintCaptureShots() {
  const strip = $("#capture-shots");
  clear(strip);
  strip.hidden = !pendingShots.length;
  for (const shot of pendingShots) {
    const tile = node("div", undefined, "capture-shot"),
      open = node("button", undefined, "shot-open"),
      image = node("img"),
      remove = node("button", "×", "shot-remove");
    image.src = shot.url;
    image.alt = shot.file.name;
    // Миниатюра в 52px — лишь знак, что снимок на месте: разглядеть его можно
    // по клику, в том же просмотре, что и у вложений карточки.
    open.type = "button";
    open.title = "Открыть снимок";
    open.setAttribute("aria-label", `Открыть ${shot.file.name}`);
    open.addEventListener("click", () =>
      previewAttachment(
        { id: null, filename: shot.file.name, contentType: shot.file.type, size: shot.file.size },
        shot.url,
      ),
    );
    open.append(image);
    remove.type = "button";
    remove.title = "Убрать снимок";
    remove.setAttribute("aria-label", `Убрать ${shot.file.name}`);
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(shot.url);
      pendingShots.splice(pendingShots.indexOf(shot), 1);
      paintCaptureShots();
    });
    tile.append(open, remove);
    strip.append(tile);
  }
}
function queueShots(files) {
  for (const file of files) {
    if (pendingShots.length >= SHOT_LIMIT) { toast(`До ${SHOT_LIMIT} снимков на запись.`); break; }
    if (file.size > SHOT_SIZE_LIMIT) { toast("Снимок больше 10 МБ не приложится."); continue; }
    const named = namedShot(file);
    pendingShots.push({ file: named, url: URL.createObjectURL(named) });
  }
  paintCaptureShots();
}
$("#capture-form").addEventListener("paste", (event) => {
  const images = pastedImages(event.clipboardData);
  if (!images.length) return;
  event.preventDefault();
  queueShots(images);
});
// Запись уже создана (202 отдаёт captureId), снимки догоняют её своим ходом:
// отправка не ждёт сети вложений.
async function uploadPendingShots(captureId) {
  if (!pendingShots.length) return;
  const shots = pendingShots.splice(0, pendingShots.length);
  paintCaptureShots();
  for (const shot of shots) {
    try {
      const response = await fetch(`/api/captures/${captureId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": shot.file.type || "application/octet-stream", "X-Attachment-Name": encodeURIComponent(shot.file.name) },
        body: shot.file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "Снимок не приложился.");
    } catch (error) {
      toast(error.message);
    } finally {
      URL.revokeObjectURL(shot.url);
    }
  }
}

// ── доска: дела как база в Notion ────────────────────────────────────────────
// Колонки заводит человек (как разделы в Todoist), подпись колонки — цветная
// пилюля со счётчиком, как статус в Notion. Карточка — открытое дело со
// свойствами строками: люди, тип и теги, срок, проект. Над доской — виды
// (колонки, даты, проекты, список), панель свойств, фильтр и поиск. Клик по
// названию открывает карточку записи, кружок закрывает дело, перенос между
// колонками сохраняется на сервере.
const BOARD_VIEWS = ["columns", "dates", "projects", "tags", "list"];
const BOARD_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const BOARD_COLOR_NAMES = { gray: "Серый", brown: "Коричневый", orange: "Оранжевый", yellow: "Жёлтый", green: "Зелёный", blue: "Синий", purple: "Фиолетовый", pink: "Розовый", red: "Красный" };
const BOARD_PROPS_DEFAULT = { people: true, type: true, due: true, project: true, priority: true, files: true, compact: false };
const boardState = {
  data: null, drag: null, openAdder: null, view: "columns",
  props: { ...BOARD_PROPS_DEFAULT },
  filter: { type: "all", projects: [] },
  search: "",
  // Закрытые дела: в списке они всегда хвостом, на доске — по желанию.
  showClosed: false,
  mobileColumn: 0,
};
try {
  const storedView = localStorage.getItem("kizuna-board-view");
  if (BOARD_VIEWS.includes(storedView)) boardState.view = storedView;
  const storedProps = JSON.parse(localStorage.getItem("kizuna-board-props") || "null");
  if (storedProps && typeof storedProps === "object") boardState.props = { ...BOARD_PROPS_DEFAULT, ...storedProps };
  boardState.showClosed = localStorage.getItem("kizuna-board-closed") === "1";
} catch {}
const boardDropHint = (() => { const hint = document.createElement("div"); hint.className = "board-drop"; return hint; })();

function boardCardStatus(card) {
  const today = boardState.data?.today || currentDayDate;
  const date = card.due?.date || null;
  if (!date) return { key: "none", label: "Без срока", icon: "none" };
  if (today && date < today) return { key: "late", label: "Просрочено", icon: "late" };
  if (today && date === today) return { key: "today", label: "Сегодня", icon: "clock" };
  return { key: "ontime", label: "В срок", icon: "clock" };
}
async function completeBoardCard(card, element, button) {
  button.disabled = true;
  try {
    for (const projectionId of card.projectionIds)
      await request(`/api/projections/${projectionId}/complete`, { method: "POST", body: "{}" });
    toast("Отмечено как готовое");
    element.remove();
    loadBoard();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}
// Закрытое дело возвращается в работу тем же кружком: с доски оно ушло, но в
// группе «Закрытые» лежит — иначе закрытое случайно было бы не найти.
async function reopenBoardCard(card, button) {
  button.disabled = true;
  try {
    for (const projectionId of card.projectionIds)
      await request(`/api/projections/${projectionId}/undo-complete`, { method: "POST", body: "{}" });
    toast("Возвращено в работу");
    loadBoard();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}
// Цвет проекта — из названия, чтобы один проект был одного цвета на всех
// карточках и на всех устройствах без настройки.
function boardProjectColor(name) {
  const palette = ["blue", "green", "orange", "purple", "pink", "yellow", "red"];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
function boardInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}
function boardPersonEl(name, { avatarOnly = false } = {}) {
  const who = node("span", undefined, "board-who");
  const avatar = node("i", boardInitials(name), `board-ava c-${boardProjectColor(name)}`);
  avatar.setAttribute("aria-hidden", "true");
  who.append(avatar);
  if (avatarOnly) who.title = name;
  else who.append(document.createTextNode(name));
  return who;
}
// Значок типа — сам кружок «готово»: у задачи пустой, у встречи с часовыми
// стрелками. Один знак перед названием, а не три.
const BOARD_CLOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.5V8l2.4 1.6"/></svg>';
function boardCardEl(card, column, { closed = false } = {}) {
  const props = boardState.props;
  const element = node("div", undefined, `board-card${closed ? " closed" : ""}`);
  element.draggable = !closed;
  element.dataset.captureId = card.captureId;
  const done = node("button", undefined, `board-done${closed ? " is-done" : ""}${card.type === "meeting_event" ? " meeting" : ""}`);
  done.type = "button";
  if (card.type === "meeting_event" && !closed) done.innerHTML = BOARD_CLOCK;
  done.title = closed ? "Вернуть в работу" : "Готово";
  done.setAttribute("aria-label", `${done.title}: ${card.title}`);
  done.addEventListener("click", (event) => {
    event.stopPropagation();
    if (closed) reopenBoardCard(card, done);
    else completeBoardCard(card, element, done);
  });
  const body = node("div", undefined, "board-body");
  const titleRow = node("div", undefined, "board-title-row");
  const title = node("button", card.title.split("\n")[0], "board-title");
  title.type = "button";
  title.addEventListener("click", () => openReportEntry(card.captureId));
  titleRow.append(title);
  if (!closed) {
    // Крестик по наведению — удалить дело прямо с доски. Удаление мягкое, тост
    // даёт «Вернуть», как в карточке.
    const remove = node("button", "×", "board-remove");
    remove.type = "button";
    remove.title = "Удалить дело";
    remove.setAttribute("aria-label", `Удалить: ${card.title}`);
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      remove.disabled = true;
      try {
        await request(`/api/captures/${card.captureId}`, { method: "DELETE" });
        element.remove();
        toast("Дело удалено", { label: "Вернуть", run: async () => { try { await request(`/api/captures/${card.captureId}/restore`, { method: "POST" }); toast("Дело возвращено"); } catch (error) { toast(error.message); } loadBoard(); } });
        loadBoard();
        load();
      } catch (error) { toast(error.message); remove.disabled = false; }
    });
    titleRow.append(remove);
  }
  const status = boardCardStatus(card);
  // Как на «Сегодня»: просроченное — розовая плашка и красный заголовок,
  // открытое — песочная.
  if (!closed) element.classList.add(status.key === "late" ? "overdue" : "waiting");
  const due = card.due ? scheduleLabel({ state: "ok", date: card.due.date, time: card.due.time }) : null;
  // Срок — обычным текстом, как дата в Notion; цвет подсказывает состояние.
  const dueChip = () =>
    node("span", due, `btag due${status.key === "late" ? " late" : status.key === "today" ? " soon" : ""}`);
  const projectChip = (project) => node("span", project, `btag project c-${boardProjectColor(project)}`);
  // Строки свойств, как в Notion; в компактном виде — всё в одну строку.
  const rows = [];
  const row = (cls) => { const line = node("div", undefined, `board-meta ${cls}`); rows.push(line); return line; };
  if (props.people && card.people?.length) {
    const line = row("people");
    for (const person of card.people) line.append(boardPersonEl(person, { avatarOnly: props.compact }));
  }
  const typeLine = row("type");
  if (props.type) typeLine.append(node("span", card.type === "meeting_event" ? "встреча" : "задача", `btag kind ${card.type === "meeting_event" ? "meeting" : "task"}`));
  if (props.priority && card.priority === "high") typeLine.append(node("span", "важно", "btag urgent c-red"));
  if (props.priority && card.priority === "low") typeLine.append(node("span", "не срочно", "btag c-gray"));
  if (props.type) for (const tag of card.tags) typeLine.append(node("span", `#${tag}`, "btag tag c-gray"));
  const dueLine = row("when");
  if (closed) {
    dueLine.append(node("span", `закрыто ${scheduleLabel({ state: "ok", date: card.closedDate, time: null })}`, "btag due"));
  } else if (props.due) {
    if (boardState.view !== "columns") {
      // колонка или группа уже говорит статус — на карточке остаётся конкретный срок
      if (due) dueLine.append(dueChip());
    } else {
      dueLine.append(statusBadge(status));
      if (due && card.due.date > (boardState.data?.today || "")) dueLine.append(node("span", due, "btag due"));
    }
  }
  const projectLine = row("where");
  if (props.project) for (const project of card.projects) projectLine.append(projectChip(project));
  // Скрепка с числом — как в списках: видно, что к делу что-то приложено.
  if (props.files && card.attachments) projectLine.append(node("span", `📎 ${card.attachments}`, "btag files c-gray"));
  body.append(titleRow);
  if (props.compact) {
    const line = node("div", undefined, "board-meta compact");
    for (const filled of rows) while (filled.firstChild) line.append(filled.firstChild);
    if (line.childNodes.length) body.append(line);
  } else {
    for (const filled of rows) if (filled.childNodes.length) body.append(filled);
  }
  element.append(done, body);
  if (closed) return element;
  element.addEventListener("dragstart", (event) => {
    boardState.drag = { type: "card", captureId: card.captureId, from: column.id };
    event.dataTransfer.setData("text/plain", card.captureId);
    event.dataTransfer.effectAllowed = "move";
    requestAnimationFrame(() => element.classList.add("dragging"));
  });
  element.addEventListener("dragend", () => {
    element.classList.remove("dragging");
    boardDropHint.remove();
    boardState.drag = null;
  });
  return element;
}
// Позиция вставки — по вертикали мыши между серединами карточек.
function boardDropIndex(list, clientY) {
  const cards = [...list.querySelectorAll(".board-card:not(.dragging)")];
  for (const [index, card] of cards.entries()) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return { index, before: card };
  }
  return { index: cards.length, before: null };
}
async function boardMove(body) {
  try {
    await request("/api/board/move", { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    toast(error.message);
  }
  loadBoard();
}
// Шапка колонки: цветная пилюля с названием, счётчик, по наведению — меню и «+».
function boardHeadEl(name, color, count) {
  const head = node("div", undefined, "board-col-head");
  const pill = node("span", undefined, `board-pill c-${color || "gray"}`);
  pill.append(node("span", name, "board-col-name"));
  head.append(pill, node("span", String(count), "board-col-count"));
  return head;
}
function boardHeadTools(element, { menu = null } = {}) {
  const tools = node("div", undefined, "board-col-tools");
  if (menu) tools.append(menu);
  const plus = node("button", "+", "board-col-plus");
  plus.type = "button";
  plus.title = "Добавить дело";
  plus.setAttribute("aria-label", "Добавить дело в колонку");
  plus.addEventListener("click", () => element.querySelector(".board-add-button")?.click());
  tools.append(plus);
  return tools;
}
function boardColumnEl(column) {
  const element = node("section", undefined, `board-column${column.id === null ? " inbox" : ""}`);
  element.dataset.columnId = column.id ?? "";
  const head = boardHeadEl(column.name, column.id === null ? "gray" : column.color, column.cards.length);
  const name = head.querySelector(".board-col-name");
  let menu = null;
  if (column.id !== null) {
    head.draggable = true;
    head.addEventListener("dragstart", (event) => {
      boardState.drag = { type: "column", columnId: column.id };
      event.dataTransfer.setData("text/plain", column.id);
      event.dataTransfer.effectAllowed = "move";
      element.classList.add("dragging-column");
      event.stopPropagation();
    });
    head.addEventListener("dragend", () => {
      element.classList.remove("dragging-column");
      boardState.drag = null;
      for (const other of document.querySelectorAll(".board-column")) other.classList.remove("col-drop-left", "col-drop-right");
    });
    // Меню колонки: переименовать, покрасить или удалить (дела вернутся во «Входящие»).
    menu = node("details", undefined, "board-menu");
    const summary = node("summary", "⋯");
    summary.setAttribute("aria-label", `Меню колонки ${column.name}`);
    const popover = node("div", undefined, "board-menu-popover");
    const rename = node("button", "Переименовать");
    rename.type = "button";
    rename.addEventListener("click", () => {
      menu.removeAttribute("open");
      const input = document.createElement("input");
      input.value = column.name;
      input.className = "board-col-input";
      input.maxLength = 40;
      head.querySelector(".board-pill").replaceWith(input);
      input.focus();
      input.select();
      const cancel = () => loadBoard();
      input.addEventListener("keydown", async (event) => {
        if (event.key === "Escape") return cancel();
        if (event.key !== "Enter") return;
        const value = input.value.trim();
        if (!value || value === column.name) return cancel();
        try {
          await request(`/api/board/columns/${column.id}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
        } catch (error) { toast(error.message); }
        loadBoard();
      });
      input.addEventListener("blur", cancel);
    });
    const colors = node("div", undefined, "board-colors");
    colors.setAttribute("role", "group");
    colors.setAttribute("aria-label", "Цвет колонки");
    for (const color of BOARD_COLORS) {
      const swatch = node("button", undefined, `board-swatch c-${color}${(column.color || "gray") === color ? " is-current" : ""}`);
      swatch.type = "button";
      swatch.title = BOARD_COLOR_NAMES[color];
      swatch.setAttribute("aria-label", `Цвет: ${BOARD_COLOR_NAMES[color]}`);
      swatch.addEventListener("click", async () => {
        menu.removeAttribute("open");
        try {
          await request(`/api/board/columns/${column.id}`, { method: "PATCH", body: JSON.stringify({ color }) });
        } catch (error) { toast(error.message); }
        loadBoard();
      });
      colors.append(swatch);
    }
    const removeColumn = node("button", "Удалить колонку");
    removeColumn.type = "button";
    removeColumn.addEventListener("click", async () => {
      menu.removeAttribute("open");
      try {
        const result = await request(`/api/board/columns/${column.id}`, { method: "DELETE" });
        toast(result.movedToInbox ? `Колонка удалена, дел во «Входящих»: +${result.movedToInbox}` : "Колонка удалена");
      } catch (error) { toast(error.message); }
      loadBoard();
    });
    popover.append(rename, node("p", "Цвет", "board-menu-label"), colors, removeColumn);
    menu.append(summary, popover);
  }
  head.append(boardHeadTools(element, { menu }));
  const list = node("div", undefined, "board-cards");
  for (const card of column.cards) list.append(boardCardEl(card, column));
  list.addEventListener("dragover", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const { before } = boardDropIndex(list, event.clientY);
    if (before) list.insertBefore(boardDropHint, before);
    else list.append(boardDropHint);
  });
  list.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Element && list.contains(event.relatedTarget)) return;
    boardDropHint.remove();
  });
  list.addEventListener("drop", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    const { index } = boardDropIndex(list, event.clientY);
    const captureId = boardState.drag.captureId;
    boardDropHint.remove();
    boardMove({ captureId, columnId: column.id, index });
  });
  // Перенос колонок: подсветка стороны, куда встанет колонка.
  element.addEventListener("dragover", (event) => {
    if (boardState.drag?.type !== "column" || column.id === boardState.drag.columnId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = element.getBoundingClientRect();
    const left = event.clientX < rect.left + rect.width / 2;
    element.classList.toggle("col-drop-left", left);
    element.classList.toggle("col-drop-right", !left);
  });
  element.addEventListener("dragleave", () => element.classList.remove("col-drop-left", "col-drop-right"));
  element.addEventListener("drop", async (event) => {
    if (boardState.drag?.type !== "column") return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const left = event.clientX < rect.left + rect.width / 2;
    const real = boardState.data.columns.filter((item) => item.id !== null).map((item) => item.id);
    const from = real.indexOf(boardState.drag.columnId);
    let index = column.id === null ? 0 : real.indexOf(column.id) + (left ? 0 : 1);
    if (from >= 0 && from < index) index -= 1;
    element.classList.remove("col-drop-left", "col-drop-right");
    try {
      await request(`/api/board/columns/${boardState.drag.columnId}`, { method: "PATCH", body: JSON.stringify({ index }) });
    } catch (error) { toast(error.message); }
    loadBoard();
  });
  element.append(head, list, boardAdderEl(column));
  void name;
  return element;
}
// Быстрое добавление дела прямо в колонку: Enter сохраняет и оставляет поле
// открытым для следующего (как в Todoist), Escape закрывает.
function boardAdderEl(column) {
  const wrap = node("div", undefined, "board-add");
  const button = node("button", "+ Дело", "board-add-button");
  button.type = "button";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Что сделать?";
  input.hidden = true;
  const adderKey = `column:${column.id ?? "inbox"}`;
  const open = ({ focus = true } = {}) => {
    button.hidden = true;
    input.hidden = false;
    // Черновик пережил перерисовку доски — возвращаем его в новое поле.
    if (boardState.adderDraft != null) { input.value = boardState.adderDraft; boardState.adderDraft = null; }
    if (focus) input.focus();
    boardState.openAdder = adderKey;
  };
  const close = () => { input.hidden = true; input.value = ""; button.hidden = false; if (boardState.openAdder === adderKey) boardState.openAdder = null; };
  button.addEventListener("click", open);
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") return close();
    if (event.key !== "Enter") return;
    const raw = input.value.trim();
    if (!raw) return close();
    input.disabled = true;
    try {
      const created = await request("/api/captures", { method: "POST", body: JSON.stringify(withProvider({ raw, primaryType: "todo" })) });
      await request("/api/board/move", { method: "POST", body: JSON.stringify({ captureId: created.entry.id, columnId: column.id, index: 100000 }) });
      // Дело ушло — текст больше не черновик; при ошибке он остаётся в поле.
      input.value = "";
    } catch (error) { toast(error.message); }
    // Отключение поля на время запроса снимает с него фокус; возвращаем до
    // перерисовки, чтобы новое поле открылось под каретку — следующее дело
    // набирается без клика.
    input.disabled = false;
    input.focus();
    await loadBoard();
  });
  input.addEventListener("blur", () => { if (!input.value.trim() && !input.disabled) close(); });
  wrap.append(button, input);
  if (boardState.openAdder === adderKey) {
    const focus = boardState.adderFocus !== false;
    boardState.adderFocus = null;
    requestAnimationFrame(() => open({ focus }));
  }
  return wrap;
}
function boardGhostColumnEl() {
  const element = node("section", undefined, "board-column ghost");
  const button = node("button", "+ Колонка", "board-add-button");
  button.type = "button";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Название колонки";
  input.maxLength = 40;
  input.hidden = true;
  button.addEventListener("click", () => { button.hidden = true; input.hidden = false; input.focus(); });
  const close = () => { input.hidden = true; input.value = ""; button.hidden = false; };
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") return close();
    if (event.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return close();
    try {
      await request("/api/board/columns", { method: "POST", body: JSON.stringify({ name }) });
    } catch (error) { toast(error.message); }
    loadBoard();
  });
  input.addEventListener("blur", () => { if (!input.value.trim()) close(); });
  element.append(button, input);
  return element;
}
// Группировка по датам: колонки считаются из сроков, внутри — группы по видам
// (встречи, потом задачи). Перенос карточки в колонку даты меняет срок дела,
// как в Todoist; «Просрочено» и «Без срока» переносом не назначить.
function boardDateBuckets(data) {
  const today = data.today, tomorrow = shiftDate(today, 1), weekEnd = shiftDate(today, 7);
  const buckets = [
    { key: "late", name: "Просрочено", drop: null, cards: [] },
    { key: "today", name: "Сегодня", drop: today, cards: [] },
    { key: "tomorrow", name: "Завтра", drop: tomorrow, cards: [] },
    { key: "week", name: "Неделя", drop: weekEnd, cards: [] },
    { key: "later", name: "Позже", drop: shiftDate(today, 14), cards: [] },
    { key: "none", name: "Без срока", drop: null, adderWithoutDue: true, cards: [] },
  ];
  const bucketOf = (card) => {
    const date = card.due?.date || null;
    if (!date) return "none";
    if (date < today) return "late";
    if (date === today) return "today";
    if (date === tomorrow) return "tomorrow";
    if (date <= weekEnd) return "week";
    return "later";
  };
  for (const card of data.columns.flatMap((column) => column.cards))
    buckets.find((bucket) => bucket.key === bucketOf(card)).cards.push(card);
  const order = (left, right) =>
    (left.due?.date || "9999").localeCompare(right.due?.date || "9999") ||
    (left.due?.time || "99").localeCompare(right.due?.time || "99") ||
    (left.priority === "high" ? -1 : 0) - (right.priority === "high" ? -1 : 0) ||
    left.createdAt.localeCompare(right.createdAt);
  for (const bucket of buckets) bucket.cards.sort(order);
  return buckets;
}
// Группировка по тегам: дело с несколькими тегами лежит в каждой группе,
// без тегов — в «Без тегов». Переносом тег не меняется.
function boardTagGroups(data) {
  const groups = new Map();
  for (const card of data.columns.flatMap((column) => column.cards)) {
    const keys = card.tags.length ? card.tags : [null];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
  }
  const named = [...groups.keys()].filter(Boolean).sort((left, right) => left.localeCompare(right, "ru"));
  const result = named.map((name) => ({ key: `tag:${name}`, name: `#${name}`, color: boardProjectColor(name), drop: null, cards: groups.get(name) }));
  if (groups.has(null)) result.push({ key: "tag:none", name: "Без тегов", color: "gray", drop: null, adderWithoutDue: true, cards: groups.get(null) });
  return result;
}
async function boardChangeDue(captureId, bucket) {
  const card = boardState.data.columns.flatMap((column) => column.cards).find((item) => item.captureId === captureId);
  try {
    await request(`/api/captures/${captureId}/corrections`, {
      method: "POST",
      // метка времени в теле обходит клиентский кэш уточнений: перенос туда и
      // обратно — два разных действия, а не повтор одного
      body: JSON.stringify({ at: Date.now(), patch: { schedule: { date: bucket.drop, time: card?.due?.time || null } } }),
    });
    toast(`Срок: ${scheduleLabel({ state: "ok", date: bucket.drop, time: null })}`);
  } catch (error) {
    toast(error.message);
  }
  loadBoard();
}
const BOARD_BUCKET_COLORS = { late: "red", today: "orange", tomorrow: "yellow", week: "green", later: "blue", none: "gray" };
// Группировка по проектам: дело с несколькими проектами лежит в первом,
// без проекта — в «Без проекта». Переносом проект не меняется.
function boardProjectGroups(data) {
  const groups = new Map();
  for (const card of data.columns.flatMap((column) => column.cards)) {
    const key = card.projects[0] || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const named = [...groups.keys()].filter(Boolean).sort((left, right) => left.localeCompare(right, "ru"));
  const result = named.map((name) => ({ key: `project:${name}`, name, color: boardProjectColor(name), drop: null, cards: groups.get(name) }));
  if (groups.has(null)) result.push({ key: "project:none", name: "Без проекта", color: "gray", drop: null, adderWithoutDue: true, cards: groups.get(null) });
  return result;
}
function boardDateColumnEl(bucket) {
  const element = node("section", undefined, "board-column dated");
  const head = boardHeadEl(bucket.name, bucket.color || BOARD_BUCKET_COLORS[bucket.key] || "gray", bucket.cards.length);
  head.style.cursor = "default";
  if (bucket.drop || bucket.adderWithoutDue) head.append(boardHeadTools(element));
  const list = node("div", undefined, "board-cards");
  const groups = [
    ["Встречи", bucket.cards.filter((card) => card.type === "meeting_event")],
    ["Задачи", bucket.cards.filter((card) => card.type !== "meeting_event")],
  ];
  for (const [label, cards] of groups) {
    if (!cards.length) continue;
    list.append(node("p", label, "board-group-label"));
    for (const card of cards) list.append(boardCardEl(card, { id: null }));
  }
  element.addEventListener("dragover", (event) => {
    if (boardState.drag?.type !== "card" || !bucket.drop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    element.classList.add("drop-over");
  });
  element.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Element && element.contains(event.relatedTarget)) return;
    element.classList.remove("drop-over");
  });
  element.addEventListener("drop", (event) => {
    if (boardState.drag?.type !== "card" || !bucket.drop) return;
    event.preventDefault();
    element.classList.remove("drop-over");
    boardChangeDue(boardState.drag.captureId, bucket);
  });
  element.append(head, list);
  if (bucket.drop || bucket.adderWithoutDue) element.append(boardDateAdderEl(bucket));
  return element;
}
// Быстрое дело в колонке даты: срок ставится сразу по колонке.
function boardDateAdderEl(bucket) {
  const wrap = node("div", undefined, "board-add");
  const button = node("button", "+ Дело", "board-add-button");
  button.type = "button";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = bucket.drop ? `Что сделать — ${bucket.name.toLowerCase()}?` : "Что сделать?";
  input.hidden = true;
  const openAdderKey = `date:${bucket.key}`;
  const open = () => { button.hidden = true; input.hidden = false; input.focus(); boardState.openAdder = openAdderKey; };
  const close = () => { input.hidden = true; input.value = ""; button.hidden = false; if (boardState.openAdder === openAdderKey) boardState.openAdder = null; };
  button.addEventListener("click", open);
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") return close();
    if (event.key !== "Enter") return;
    const raw = input.value.trim();
    if (!raw) return close();
    input.disabled = true;
    try {
      const body = { raw, primaryType: "todo", ...(bucket.drop ? { due: { date: bucket.drop } } : {}) };
      await request("/api/captures", { method: "POST", body: JSON.stringify(withProvider(body)) });
    } catch (error) { toast(error.message); }
    await loadBoard();
  });
  input.addEventListener("blur", () => { if (!input.value.trim() && !input.disabled) close(); });
  wrap.append(button, input);
  if (boardState.openAdder === openAdderKey) requestAnimationFrame(open);
  return wrap;
}
// Группа закрытых дел, свежие сверху. В списке — всегда хвостом; на доске —
// колонкой по кнопке из «Скрытых групп».
function boardClosedGroupEl(cards) {
  const element = node("section", undefined, "board-column dated closed");
  const head = boardHeadEl("Закрытые", "green", cards.length);
  head.style.cursor = "default";
  const list = node("div", undefined, "board-cards");
  for (const card of cards) list.append(boardCardEl(card, { id: null }, { closed: true }));
  element.append(head, list);
  return element;
}
// «Скрытые группы» справа от доски, как в Notion: закрытые дела не мозолят
// глаза, но в одном щелчке.
function boardHiddenEl(data) {
  const aside = node("aside", undefined, "board-hidden");
  aside.append(node("h6", boardState.showClosed ? "Показано" : "Скрытые группы"));
  const toggle = node("button", undefined, "board-hidden-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", String(boardState.showClosed));
  toggle.append(node("span", "Закрытые", "board-pill c-green"), node("span", String(data.closed?.length || 0), "board-col-count"));
  toggle.title = boardState.showClosed ? "Скрыть закрытые" : "Показать колонкой";
  toggle.addEventListener("click", () => {
    boardState.showClosed = !boardState.showClosed;
    try { localStorage.setItem("kizuna-board-closed", boardState.showClosed ? "1" : "0"); } catch {}
    renderBoard(boardState.data);
  });
  aside.append(toggle);
  return aside;
}
// Фильтр и поиск действуют на любой вид: сравниваются проект, тип и текст
// названия. Доска не перезапрашивается — всё уже загружено.
function boardCardVisible(card) {
  const { type, projects } = boardState.filter;
  if (type === "task" && card.type === "meeting_event") return false;
  if (type === "meeting_event" && card.type !== "meeting_event") return false;
  if (projects.length && !card.projects.some((project) => projects.includes(project))) return false;
  const query = boardState.search.trim().toLowerCase();
  if (query && !card.title.toLowerCase().includes(query) && !card.tags.some((tag) => tag.toLowerCase().includes(query))) return false;
  return true;
}
function boardFilteredData(data) {
  return {
    ...data,
    columns: data.columns.map((column) => ({ ...column, cards: column.cards.filter(boardCardVisible) })),
    closed: (data.closed || []).filter(boardCardVisible),
  };
}
function paintBoardFilter(data) {
  const active = (boardState.filter.type !== "all" ? 1 : 0) + boardState.filter.projects.length;
  $("#board-filter-summary").textContent = active ? `Фильтр · ${active}` : "Фильтр";
  $("#board-filter").classList.toggle("is-active", active > 0);
  for (const button of document.querySelectorAll("[data-board-type]"))
    button.setAttribute("aria-pressed", String(button.dataset.boardType === boardState.filter.type));
  const wrap = $("#board-filter-projects");
  clear(wrap);
  const names = [...new Set((data.columns.flatMap((column) => column.cards).concat(data.closed || [])).flatMap((card) => card.projects))]
    .sort((left, right) => left.localeCompare(right, "ru"));
  if (!names.length) wrap.append(node("span", "Проектов пока нет", "board-filter-empty"));
  for (const name of names) {
    const chip = node("button", name, `btag project c-${boardProjectColor(name)}`);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(boardState.filter.projects.includes(name)));
    chip.addEventListener("click", () => {
      const set = new Set(boardState.filter.projects);
      if (set.has(name)) set.delete(name); else set.add(name);
      boardState.filter.projects = [...set];
      renderBoard(boardState.data);
    });
    wrap.append(chip);
  }
}
// На телефоне колонки — по одной на экран: сверху сегмент подписей, точка
// показывает, где вы. На широком экране сегмент спрятан стилями.
function paintBoardSegments(columns) {
  const wrap = $("#board-segments");
  clear(wrap);
  if (boardState.mobileColumn >= columns.length) boardState.mobileColumn = 0;
  columns.forEach((column, index) => {
    const pill = column.querySelector(".board-pill");
    const button = node("button", undefined, "board-segment");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(index === boardState.mobileColumn));
    button.append(pill ? pill.cloneNode(true) : node("span", column.classList.contains("ghost") ? "+ Колонка" : "…", "board-pill c-gray"));
    const count = column.querySelector(".board-col-count");
    if (count) button.append(node("span", count.textContent, "board-col-count"));
    button.addEventListener("click", () => {
      boardState.mobileColumn = index;
      for (const other of columns) other.classList.toggle("is-active", other === column);
      for (const tab of wrap.children) tab.setAttribute("aria-selected", String(tab === button));
    });
    column.classList.toggle("is-active", index === boardState.mobileColumn);
    wrap.append(button);
  });
}
function renderBoard(source) {
  const wrap = $("#board-columns");
  // Перерисовка приходит и посреди набора нового дела (доразбор записи после
  // быстрого добавления перечитывает доску). Снятие поля из DOM даёт blur, а
  // тот закрывает пустое поле — открытость, черновик и фокус возвращаем.
  // Отключённое поле — уже отправляется: его текст не черновик, а снятый с
  // него фокус не выбор человека.
  const openInput = wrap.querySelector(".board-add input:not([hidden]):not(:disabled)");
  const openAdder = boardState.openAdder;
  if (openInput) {
    boardState.adderDraft = openInput.value;
    boardState.adderFocus = document.activeElement === openInput;
  }
  clear(wrap);
  boardState.openAdder = openAdder;
  paintBoardFilter(source);
  const data = boardFilteredData(source);
  wrap.classList.toggle("list", boardState.view === "list");
  wrap.classList.toggle("compact", Boolean(boardState.props.compact));
  if (boardState.view === "dates") {
    for (const bucket of boardDateBuckets(data)) wrap.append(boardDateColumnEl(bucket));
  } else if (boardState.view === "projects" || boardState.view === "tags") {
    const groups = boardState.view === "projects" ? boardProjectGroups(data) : boardTagGroups(data);
    for (const group of groups) wrap.append(boardDateColumnEl(group));
    if (!wrap.childNodes.length) wrap.append(node("p", "Открытых дел нет.", "empty"));
  } else if (boardState.view === "list") {
    // Список — те же группы по срокам, столбиком. Пустые группы не занимают
    // место, кроме «Сегодня» и «Без срока»: туда чаще всего добавляют, и
    // «+ Дело» должно быть под рукой даже на пустой доске.
    for (const bucket of boardDateBuckets(data))
      if (bucket.cards.length || bucket.key === "today" || bucket.key === "none")
        wrap.append(boardDateColumnEl(bucket));
    if (data.closed?.length) wrap.append(boardClosedGroupEl(data.closed));
  } else {
    for (const column of data.columns) wrap.append(boardColumnEl(column));
    wrap.append(boardGhostColumnEl());
  }
  if (boardState.view !== "list") {
    if (boardState.showClosed && data.closed?.length) wrap.append(boardClosedGroupEl(data.closed));
    wrap.append(boardHiddenEl(data));
  }
  // Сегмент колонок нужен, когда на телефоне показана одна колонка; список
  // и так столбиком целиком.
  $("#board-segments").hidden = boardState.view === "list";
  paintBoardSegments([...wrap.querySelectorAll(".board-column")]);
}
function setBoardView(view) {
  boardState.view = view;
  try { localStorage.setItem("kizuna-board-view", view); } catch {}
  for (const button of document.querySelectorAll("[data-board-view]"))
    button.setAttribute("aria-pressed", String(button.dataset.boardView === view));
}
for (const button of document.querySelectorAll("[data-board-view]"))
  button.addEventListener("click", () => {
    setBoardView(button.dataset.boardView);
    loadBoard();
  });
setBoardView(boardState.view);
// Панель свойств: что показывать на карточке и компактно ли. Запоминается в
// браузере вместе с видом.
{
  const toggle = $("#board-props-toggle"), panel = $("#board-props");
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-pressed", String(!panel.hidden));
  });
  for (const box of document.querySelectorAll("[data-board-prop]")) {
    box.checked = Boolean(boardState.props[box.dataset.boardProp]);
    box.addEventListener("change", () => {
      boardState.props[box.dataset.boardProp] = box.checked;
      try { localStorage.setItem("kizuna-board-props", JSON.stringify(boardState.props)); } catch {}
      if (boardState.data) renderBoard(boardState.data);
    });
  }
  for (const button of document.querySelectorAll("[data-board-type]"))
    button.addEventListener("click", () => {
      boardState.filter.type = button.dataset.boardType;
      if (boardState.data) renderBoard(boardState.data);
    });
  $("#board-filter-reset").addEventListener("click", () => {
    boardState.filter = { type: "all", projects: [] };
    $("#board-filter").removeAttribute("open");
    if (boardState.data) renderBoard(boardState.data);
  });
  $("#board-search").addEventListener("input", (event) => {
    boardState.search = event.target.value;
    if (boardState.data) renderBoard(boardState.data);
  });
  // «+ Дело» в панели — в первую колонку с полем: во «Входящие» на доске,
  // в «Сегодня» в списке и по датам.
  $("#board-new").addEventListener("click", () => {
    const button = $("#board-columns").querySelector(".board-column:not(.ghost) .board-add-button");
    if (button) { button.click(); button.closest(".board-column")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  });
}
// Пустое место доски — рука: зажал и повёз влево-вправо, как холст. Карточки,
// шапки колонок и кнопки не задеты — у них свои жесты, рука берёт только фон.
const boardPan = { active: false, pointerId: null, startX: 0, startLeft: 0 };
function boardPanTarget(target) {
  // Список стоит столбиком и вбок не едет — тянуть нечего.
  if ($("#board-columns").classList.contains("list")) return false;
  return target instanceof Element && (
    target.id === "board-columns" ||
    target.classList.contains("board-column") ||
    target.classList.contains("board-cards")
  );
}
{
  const wrap = $("#board-columns");
  wrap.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !boardPanTarget(event.target)) return;
    event.preventDefault();
    boardPan.active = true;
    boardPan.pointerId = event.pointerId;
    boardPan.startX = event.clientX;
    boardPan.startLeft = wrap.scrollLeft;
    wrap.classList.add("panning");
    try { wrap.setPointerCapture(event.pointerId); } catch {}
  });
  wrap.addEventListener("pointermove", (event) => {
    if (!boardPan.active || event.pointerId !== boardPan.pointerId) return;
    wrap.scrollLeft = boardPan.startLeft - (event.clientX - boardPan.startX);
  });
  const endPan = (event) => {
    if (!boardPan.active || event.pointerId !== boardPan.pointerId) return;
    boardPan.active = false;
    wrap.classList.remove("panning");
  };
  wrap.addEventListener("pointerup", endPan);
  wrap.addEventListener("pointercancel", endPan);
}
// view — из адреса («#board?view=list»): ссылка с «Сегодня» ведёт сразу в
// нужный вид. Применяется после ответа сервера: первый переход по хэшу
// случается до того, как модуль дошёл до состояния доски.
// view — из адреса («#board?view=list»): ссылка с «Сегодня» ведёт сразу в
// нужный вид. Применяется после ответа сервера: первый переход по хэшу
// случается до того, как модуль дошёл до состояния доски.
async function loadBoard(view) {
  const wrap = $("#board-columns");
  if (!wrap.childNodes.length) wrap.append(node("p", "Собираем доску…", "empty"));
  try {
    const data = await request("/api/board");
    if (BOARD_VIEWS.includes(view) && view !== boardState.view) setBoardView(view);
    boardState.data = data;
    // «Сегодня» могли ещё не открывать: без даты дня сроки на доске выходили
    // бы ISO-строкой вместо «завтра» и «05.09».
    currentDayDate ||= data.today;
    renderBoard(data);
  } catch (error) {
    clear(wrap);
    wrap.append(node("p", error.message, "empty"));
  }
}

// ── Календарь ───────────────────────────────────────────────────────────────
// Календарь — свой раздел, как «Доска»: те же дела и встречи по срокам, та же
// карточка по клику, свой поиск. Свои дела и встречи лежат в сетке по сроку,
// чужие календари — серым и только для чтения. Перенос мышкой — уточнение
// записи (patch.schedule) с «Вернуть», а не правка календаря.
const CAL_HOUR_PX = 48;
const CAL_H0 = 6;
const CAL_H1 = 23;
const CAL_STEP = 15;
const CAL_DOW = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const CAL_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const CAL_MONTHS_G = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const CAL_PHONE = window.matchMedia("(max-width: 760px)");
const calState = { mode: "week", anchor: null, days: 7, data: null, hidden: new Set(), seq: 0, drag: null, pop: null, search: "" };
try {
  const storedMode = localStorage.getItem("kizuna-calendar-mode");
  if (["day", "week", "month"].includes(storedMode)) calState.mode = storedMode;
  else if (CAL_PHONE.matches) calState.mode = "day";
  const storedHidden = JSON.parse(localStorage.getItem("kizuna-calendar-hidden") || "[]");
  if (Array.isArray(storedHidden)) calState.hidden = new Set(storedHidden);
} catch {}
const calPad = (value) => String(value).padStart(2, "0");
const calMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const calTime = (minutes) => `${calPad(Math.floor(minutes / 60))}:${calPad(minutes % 60)}`;
const calParse = (date) => new Date(`${date}T12:00:00Z`);
const calDow = (date) => (calParse(date).getUTCDay() + 6) % 7;
const calMonday = (date) => shiftDate(date, -calDow(date));
function calHuman(date) {
  const d = calParse(date);
  return `${CAL_DOW[calDow(date)]}, ${d.getUTCDate()} ${CAL_MONTHS_G[d.getUTCMonth()]}`;
}
function calToday() { return calState.data?.today || currentDayDate || new Date().toISOString().slice(0, 10); }
// На телефоне неделя — три дня: семь колонок на 390px не читаются.
function calDays() { return CAL_PHONE.matches ? Math.min(calState.days, 3) : calState.days; }
function calRange() {
  const anchor = calState.anchor || calToday();
  if (calState.mode === "day") return { from: anchor, to: anchor };
  if (calState.mode === "month") {
    const d = calParse(anchor);
    const first = `${d.getUTCFullYear()}-${calPad(d.getUTCMonth() + 1)}-01`;
    const start = calMonday(first);
    return { from: start, to: shiftDate(start, 41) };
  }
  const start = calDays() === 7 ? calMonday(anchor) : anchor;
  return { from: start, to: shiftDate(start, calDays() - 1) };
}
function calTitle() {
  const { from, to } = calRange();
  const a = calParse(from), b = calParse(to);
  if (calState.mode === "day") return calHuman(from) + (from === calToday() ? " · сегодня" : "");
  if (calState.mode === "month") { const d = calParse(calState.anchor || calToday()); return `${CAL_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${CAL_MONTHS_G[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  return `${a.getUTCDate()} ${CAL_MONTHS_G[a.getUTCMonth()]} – ${b.getUTCDate()} ${CAL_MONTHS_G[b.getUTCMonth()]}`;
}
function setCalendarMode(mode) {
  calState.mode = mode;
  try { localStorage.setItem("kizuna-calendar-mode", mode); } catch {}
}
function calStep(direction) {
  const anchor = calState.anchor || calToday();
  if (calState.mode === "month") { const d = calParse(anchor); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + direction); calState.anchor = d.toISOString().slice(0, 10); }
  else calState.anchor = shiftDate(anchor, direction * (calState.mode === "day" ? 1 : calDays()));
  loadCalendar();
}
// Длительность блока: конец из записи, иначе час встрече и полчаса делу.
function calEndOf(item) {
  if (item.time === null) return null;
  if (item.end) return item.end;
  const minutes = calMinutes(item.time) + (item.kind === "meeting" ? calState.data?.defaults?.meetingMinutes || 60 : calState.data?.defaults?.taskMinutes || 30);
  return calTime(Math.min(minutes, 23 * 60 + 59));
}
// Поиск действует на всё: название, теги и проекты своих дел, названия
// чужих событий.
function calOwnVisible(item) {
  if (calState.hidden.has(`kind:${item.kind}`)) return false;
  const query = calState.search.trim().toLowerCase();
  if (query && !item.title.toLowerCase().includes(query) && !item.tags.some((tag) => tag.toLowerCase().includes(query)) && !item.projects.some((project) => project.toLowerCase().includes(query))) return false;
  return true;
}
function calExternalVisible(item) {
  if (calState.hidden.has(`account:${item.accountId}`)) return false;
  const query = calState.search.trim().toLowerCase();
  return !query || item.title.toLowerCase().includes(query);
}
function calItemsOf(date) {
  const data = calState.data;
  if (!data) return { own: [], external: [] };
  const own = data.items.filter((item) => item.date === date && calOwnVisible(item));
  const external = data.external.filter((item) => item.date === date && calExternalVisible(item));
  return { own, external };
}
async function loadCalendar() {
  const wrap = $("#calendar-view");
  const { from, to } = calRange();
  const seq = ++calState.seq;
  if (!wrap.childNodes.length) wrap.append(node("p", "Собираем календарь…", "empty"));
  try {
    const data = await request(`/api/calendar?from=${from}&to=${to}`);
    if (seq !== calState.seq) return;
    calState.data = data;
    currentDayDate ||= data.today;
    renderCalendar();
  } catch (error) {
    clear(wrap);
    wrap.append(node("p", error.message, "empty"));
  }
}
function calButton(text, className, onClick) {
  const button = node("button", text, className);
  button.type = "button";
  if (onClick) button.addEventListener("click", onClick);
  return button;
}
function calSourcesEl() {
  const data = calState.data;
  const wrap = node("div", undefined, "cal-sources");
  const chip = (key, label, color, extra) => {
    const button = calButton(undefined, "cal-source", () => {
      if (calState.hidden.has(key)) calState.hidden.delete(key); else calState.hidden.add(key);
      try { localStorage.setItem("kizuna-calendar-hidden", JSON.stringify([...calState.hidden])); } catch {}
      renderCalendar();
    });
    button.setAttribute("aria-pressed", String(!calState.hidden.has(key)));
    const dot = node("i", undefined, "cal-dot");
    if (color) dot.style.background = color;
    button.append(dot, node("span", label));
    if (extra) button.append(node("small", extra));
    return button;
  };
  wrap.append(chip("kind:task", "Дела", "var(--type-todo)"), chip("kind:meeting", "Встречи", "var(--type-meeting)"));
  for (const account of data.accounts) {
    if (account.disabled) continue;
    wrap.append(chip(`account:${account.id}`, account.label, account.color || "var(--n-72)", account.syncError ? "ошибка" : account.mode === "busy" ? "занято" : null));
  }
  return wrap;
}
function calToolbarEl() {
  const top = node("div", undefined, "cal-top");
  const nav = node("span", undefined, "cal-nav");
  nav.append(calButton("‹", "cal-nav-btn", () => calStep(-1)), calButton("Сегодня", "cal-nav-today", () => { calState.anchor = calToday(); loadCalendar(); }), calButton("›", "cal-nav-btn", () => calStep(1)));
  const title = node("h3", calTitle(), "cal-title");
  const seg = node("div", undefined, "cal-seg");
  seg.setAttribute("role", "group");
  for (const [mode, label, key] of [["day", "День", "D"], ["week", "Неделя", "W"], ["month", "Месяц", "M"]]) {
    const button = calButton(undefined, undefined, () => { setCalendarMode(mode); if (mode === "week") calState.days = 7; loadCalendar(); });
    button.append(node("span", label), node("kbd", key));
    button.setAttribute("aria-pressed", String(calState.mode === mode));
    seg.append(button);
  }
  top.append(nav, title, seg);
  return top;
}
function calChipEl(item, { overdue = false } = {}) {
  const chip = node("div", undefined, `cal-chip ${item.kind}${item.done ? " done" : ""}${overdue || item.overdue ? " late" : ""}`);
  chip.dataset.id = item.id;
  if (item.kind === "external" && item.editable) { chip.draggable = true; chip.dataset.own = "1"; }
  if (item.kind !== "external") {
    chip.draggable = !item.done;
    chip.dataset.own = "1";
    const box = calButton(undefined, `cal-box${item.kind === "meeting" ? " meeting" : ""}${item.done ? " is-done" : ""}`, (event) => { event.stopPropagation(); toggleCalendarDone(item); });
    box.title = item.done ? "Вернуть в работу" : "Готово";
    if (item.kind === "meeting" && !item.done) box.innerHTML = BOARD_CLOCK;
    chip.append(box);
  } else if (item.color) chip.style.setProperty("--cal-c", item.color);
  chip.append(node("span", item.title, "cal-chip-title"));
  chip.title = item.title;
  chip.addEventListener("click", () => openCalendarItem(item));
  return chip;
}
function calEventEl(item) {
  const start = calMinutes(item.time), end = calMinutes(calEndOf(item));
  const top = ((start - CAL_H0 * 60) / 60) * CAL_HOUR_PX;
  const height = Math.max(((end - start) / 60) * CAL_HOUR_PX - 2, 18);
  const element = node("div", undefined, `cal-ev ${item.kind}${item.done ? " done" : ""}${item.overdue ? " late" : ""}${height < 34 ? " short" : ""}`);
  element.style.top = `${top}px`;
  element.style.height = `${height}px`;
  element.dataset.id = item.id;
  if (item.kind !== "external") { element.draggable = !item.done; element.dataset.own = "1"; }
  else { if (item.editable) { element.draggable = true; element.dataset.own = "1"; } if (item.color) element.style.setProperty("--cal-c", item.color); }
  const title = node("b", undefined);
  title.append(node("span", `${item.time} `, "cal-ev-time"), document.createTextNode(item.title));
  element.append(title);
  const sub = item.kind === "external" ? item.calendarName || item.source : [item.project, ...(item.people || [])].filter(Boolean).join(" · ");
  if (sub) element.append(node("small", sub));
  // Повтор — значком в правом верхнем углу, как в Apple.
  if (item.kind === "external" && (item.repeat || item.recurring)) { const repeat = node("i", "⟳", "cal-ev-repeat"); repeat.title = item.repeat || "Повторяется"; element.append(repeat); }
  if (item.joinUrl && height >= 34) {
    const join = node("a", "Войти", "cal-join");
    join.href = item.joinUrl; join.target = "_blank"; join.rel = "noopener";
    join.addEventListener("click", (event) => event.stopPropagation());
    element.append(join);
  }
  element.title = `${item.time}–${calEndOf(item)} ${item.title}`;
  element.addEventListener("click", () => openCalendarItem(item));
  return element;
}
function calGridEl(dates) {
  const today = calToday();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const head = node("div", undefined, "cal-wk");
  head.style.setProperty("--days", String(dates.length));
  head.append(node("div", undefined, "cal-corner"));
  const lane = node("div", undefined, "cal-wk");
  lane.style.setProperty("--days", String(dates.length));
  lane.append(node("div", "без времени", "cal-nt-label"));
  const scroll = node("div", undefined, "cal-scroll");
  const grid = node("div", undefined, "cal-grid");
  grid.style.setProperty("--days", String(dates.length));
  grid.style.setProperty("--h", `${CAL_HOUR_PX}px`);
  const hours = node("div", undefined, "cal-hours");
  for (let hour = CAL_H0; hour < CAL_H1; hour += 1) hours.append(node("div", hour === CAL_H0 ? "" : calTime(hour * 60)));
  grid.append(hours);
  for (const date of dates) {
    const isToday = date === today, weekend = calDow(date) >= 5;
    const dh = node("div", undefined, `cal-dh${isToday ? " today" : ""}${weekend ? " wknd" : ""}`);
    dh.append(document.createTextNode(CAL_DOW[calDow(date)]), node("b", String(calParse(date).getUTCDate())));
    dh.addEventListener("click", () => { calState.anchor = date; setCalendarMode("day"); loadCalendar(); });
    head.append(dh);
    const { own, external } = calItemsOf(date);
    const nt = node("div", undefined, `cal-nt${isToday ? " today" : ""}`);
    nt.dataset.date = date;
    nt.dataset.notime = "1";
    for (const item of own.filter((entry) => entry.time === null)) nt.append(calChipEl(item));
    if (isToday) for (const item of (calState.data.overdue || []).filter(calOwnVisible)) nt.append(calChipEl(item, { overdue: true }));
    for (const item of external.filter((entry) => entry.allDay)) nt.append(calChipEl(item));
    lane.append(nt);
    const col = node("div", undefined, `cal-col${isToday ? " today" : ""}${weekend ? " wknd" : ""}`);
    col.dataset.date = date;
    col.style.setProperty("--n", String(CAL_H1 - CAL_H0));
    for (const item of external.filter((entry) => !entry.allDay)) col.append(calEventEl(item));
    for (const item of own.filter((entry) => entry.time !== null)) col.append(calEventEl(item));
    if (isToday) { const line = node("div", undefined, "cal-now"); line.style.top = `${((nowMinutes - CAL_H0 * 60) / 60) * CAL_HOUR_PX}px`; col.append(line); }
    grid.append(col);
  }
  scroll.append(grid);
  const wrap = node("div", undefined, "cal-week");
  wrap.append(head, lane, scroll);
  requestAnimationFrame(() => { scroll.scrollTop = (Math.max(CAL_H0, 8) - CAL_H0) * CAL_HOUR_PX - 10; });
  return wrap;
}
function calAgendaEl(date) {
  const { own, external } = calItemsOf(date);
  const aside = node("aside", undefined, "cal-agenda");
  const overdue = date === calToday() ? (calState.data.overdue || []).filter(calOwnVisible).map((item) => ({ ...item, overdue: true })) : [];
  const noTime = own.filter((item) => item.time === null).concat(overdue, external.filter((item) => item.allDay));
  aside.append(node("h4", `Без времени · ${noTime.length}`));
  if (!noTime.length) aside.append(node("p", "пусто", "cal-free"));
  for (const item of noTime) aside.append(calChipEl(item));
  aside.append(node("h4", "По часам"));
  const timed = own.filter((item) => item.time !== null).concat(external.filter((item) => !item.allDay)).sort((a, b) => calMinutes(a.time) - calMinutes(b.time));
  if (!timed.length) aside.append(node("p", "свободный день", "cal-free"));
  let cursor = 9 * 60;
  for (const item of timed) {
    const start = calMinutes(item.time);
    if (start - cursor >= 60) aside.append(node("p", `свободно ${Math.floor((start - cursor) / 60)} ч${(start - cursor) % 60 ? ` ${(start - cursor) % 60} мин` : ""}`, "cal-free"));
    const row = node("div", undefined, `cal-row ${item.kind}${item.done ? " done" : ""}`);
    row.append(node("time", item.time));
    const text = node("span", item.title, "cal-row-title");
    const meta = node("small", item.kind === "external" ? item.source : `до ${calEndOf(item)}${item.project ? ` · ${item.project}` : ""}`);
    const body = node("span", undefined, "cal-row-body");
    body.append(text, meta);
    row.append(body);
    if (item.joinUrl) { const join = node("a", "Войти", "cal-join"); join.href = item.joinUrl; join.target = "_blank"; join.rel = "noopener"; join.addEventListener("click", (event) => event.stopPropagation()); row.append(join); }
    row.addEventListener("click", () => openCalendarItem(item));
    aside.append(row);
    cursor = Math.max(cursor, calMinutes(calEndOf(item)));
  }
  return aside;
}
function calMonthEl() {
  const { from } = calRange();
  const today = calToday();
  const month = calParse(calState.anchor || today).getUTCMonth();
  const wrap = node("div", undefined, "cal-month");
  for (const day of CAL_DOW) wrap.append(node("div", day, "cal-mdh"));
  for (let index = 0; index < 42; index += 1) {
    const date = shiftDate(from, index);
    const d = calParse(date);
    const cell = node("div", undefined, `cal-mc${d.getUTCMonth() !== month ? " off" : ""}${date === today ? " today" : ""}`);
    cell.dataset.date = date;
    cell.dataset.notime = "1";
    const number = calButton(String(d.getUTCDate()), "cal-md", () => { calState.anchor = date; setCalendarMode("day"); loadCalendar(); });
    cell.append(number);
    const { own, external } = calItemsOf(date);
    const items = own.concat(external).sort((a, b) => (a.time === null ? -1 : calMinutes(a.time)) - (b.time === null ? -1 : calMinutes(b.time)));
    const shown = items.slice(0, 3);
    for (const item of shown) {
      const chip = calChipEl(item);
      if (item.time !== null) chip.prepend(node("span", item.time, "cal-chip-time"));
      cell.append(chip);
    }
    if (items.length > 3) cell.append(node("div", `ещё ${items.length - 3}`, "cal-more"));
    wrap.append(cell);
  }
  return wrap;
}
function renderCalendar() {
  const wrap = $("#calendar-view");
  if (!calState.data) return;
  closeCalendarPop();
  clear(wrap);
  // Источники живут в шапке страницы, рядом с поиском, как фильтр на доске.
  const sources = $("#calendar-sources");
  if (sources) sources.replaceWith(Object.assign(calSourcesEl(), { id: "calendar-sources" }));
  wrap.append(calToolbarEl());
  const body = node("div", undefined, "cal-body");
  if (calState.mode === "month") body.append(calMonthEl());
  else if (calState.mode === "day") { const day = node("div", undefined, "cal-day"); const { from } = calRange(); day.append(calGridEl([from]), calAgendaEl(from)); body.append(day); }
  else { const { from } = calRange(); body.append(calGridEl(Array.from({ length: calDays() }, (_, index) => shiftDate(from, index)))); }
  wrap.append(body);
  const hint = node("p", undefined, "cal-hint");
  hint.append(node("kbd", "D"), node("kbd", "W"), node("kbd", "M"), document.createTextNode(" виды · "), node("kbd", "T"), document.createTextNode(" сегодня · "), node("kbd", "←"), node("kbd", "→"), document.createTextNode(" листать · "), node("kbd", "1"), document.createTextNode("–"), node("kbd", "7"), document.createTextNode(" дней · тяните дела, встречи и чужие события, клик по пустому месту — новая запись"));
  wrap.append(hint);
}
// Клик по своему делу — карточка записи; по чужому событию — плашка с тем,
// что известно, и «Взять в память».
function openCalendarItem(item) {
  if (item.kind !== "external") { openReportEntry(item.id); return; }
  showExternalEvent(item);
}
function closeCalendarPop() {
  calState.pop?.remove();
  calState.pop = null;
  calState.popCleanup?.();
  calState.popCleanup = null;
}
// Плашка живёт поверх всей страницы, а не внутри сетки: сетка прокручивается
// и режет всё, что выходит за её край, а плашке нужен весь экран. Координаты —
// от окна; прокрутка сетки или окна закрывает плашку, чтобы она не повисла
// отдельно от своего события.
function calPopAt(anchorElement) {
  closeCalendarPop();
  const pop = node("div", undefined, "cal-pop");
  const box = anchorElement.getBoundingClientRect();
  calPopPlace(pop, box.left, box.bottom + 6);
  document.body.append(pop);
  calState.pop = pop;
  const away = (event) => { if (!pop.contains(event.target)) closeCalendarPop(); };
  const drift = (event) => { if (!pop.contains(event.target)) closeCalendarPop(); };
  const timer = setTimeout(() => {
    document.addEventListener("pointerdown", away);
    document.addEventListener("scroll", drift, true);
    window.addEventListener("resize", drift);
  }, 0);
  calState.popCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener("pointerdown", away);
    document.removeEventListener("scroll", drift, true);
    window.removeEventListener("resize", drift);
  };
  return pop;
}
function calPopPlace(pop, left, top) {
  const width = pop.classList.contains("rich") ? 340 : 300;
  pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}
// Плашка собрана — если не влезает под событием, поднимается, но не выше
// верхнего края; остаток, если он есть, прокручивается внутри неё.
function calPopFit(pop) {
  const rect = pop.getBoundingClientRect();
  const overflow = rect.bottom - (window.innerHeight - 8);
  if (overflow > 0) pop.style.top = `${Math.max(8, rect.top - overflow)}px`;
}
// Плашка чужого события — как в Календаре macOS: заголовок и календарь,
// откуда событие, когда и как повторяется, участники с ответами, ссылка на
// видеовстречу и на само событие, мой ответ организатору с комментарием.
const POP_STATUS = { accepted: ["✓", "принято"], declined: ["✕", "отклонено"], tentative: ["?", "под вопросом"], "needs-action": ["·", "без ответа"], delegated: ["→", "передано"] };
function popStatusIcon(status) {
  const [glyph, label] = POP_STATUS[status] || POP_STATUS["needs-action"];
  const icon = node("i", glyph, `pop-st ${status}`);
  icon.title = label;
  return icon;
}
function popSection(cls = "") { return node("section", undefined, `pop-sec${cls ? ` ${cls}` : ""}`); }
function popHost(href) { try { return new URL(href).host; } catch { return null; } }
function showExternalEvent(item) {
  const anchorElement = $("#calendar-view").querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  if (!anchorElement) return;
  const pop = calPopAt(anchorElement);
  pop.classList.add("rich");
  const patch = async (body, done) => {
    try { await request(`/api/calendar/external/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify(body) }); toast(done); closeCalendarPop(); await loadCalendar(); }
    catch (error) { toast(error.message); throw error; }
  };
  // ── заголовок и календарь ──
  const head = popSection("pop-head");
  const title = node("b", item.title, "cal-pop-title");
  head.append(title);
  const account = calState.data?.accounts?.find((candidate) => candidate.id === item.accountId);
  const writable = (account?.calendars || []).filter((calendar) => calendar.writable);
  const calPick = node("span", undefined, "pop-cal");
  const dot = node("i", undefined, "cal-dot");
  dot.style.background = item.color || account?.color || "var(--n-72)";
  calPick.append(dot);
  // Экземпляр повтора по CalDAV в другой календарь не переезжает — только серия.
  if ((item.movable ?? item.editable) && writable.length > 1) {
    const select = node("select");
    select.setAttribute("aria-label", "Календарь события");
    for (const calendar of writable) { const option = node("option", calendar.name); option.value = calendar.id; option.selected = calendar.id === item.calendarId; select.append(option); }
    select.addEventListener("change", async () => {
      select.disabled = true;
      try { await request(`/api/calendar/external/${encodeURIComponent(item.id)}/move`, { method: "POST", body: JSON.stringify({ calendarId: select.value }) }); toast(`Перенесено в календарь «${select.selectedOptions[0].textContent}»`); closeCalendarPop(); await loadCalendar(); }
      catch (error) { toast(error.message); select.disabled = false; }
    });
    calPick.append(select);
  } else calPick.append(node("span", item.calendarName || item.source));
  head.append(calPick);
  if (item.editable) {
    title.title = "Переименовать"; title.tabIndex = 0;
    const rename = () => {
      const input = node("input", undefined, "cal-pop-rename");
      input.type = "text"; input.value = item.title; input.maxLength = 300; input.setAttribute("aria-label", "Название события");
      title.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        const next = input.value.trim();
        if (!save || !next || next === item.title) { input.replaceWith(title); return; }
        input.disabled = true;
        try { await patch({ title: next }, `Переименовано в ${item.source}`); } catch { input.replaceWith(title); }
      };
      input.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter") { keyEvent.preventDefault(); finish(true); } else if (keyEvent.key === "Escape") { keyEvent.preventDefault(); finish(false); } });
      input.addEventListener("blur", () => finish(true));
    };
    title.addEventListener("click", rename);
    title.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter") rename(); });
  }
  pop.append(head);
  // ── откуда ──
  const host = popHost(item.href);
  const source = popSection("pop-row");
  source.append(node("span", `${item.source}${host ? ` · ${host}` : ""}`, "pop-src"));
  if (item.href) { const open = node("a", "Открыть", "cal-pop-btn small"); open.href = item.href; open.target = "_blank"; open.rel = "noopener"; source.append(open); }
  pop.append(source);
  // ── когда ──
  const when = popSection();
  const year = calParse(item.date).getUTCFullYear();
  const whenText = item.allDay ? `${calHuman(item.date)} ${year} · весь день${item.days > 1 ? ` · ${item.days} дн.` : ""}` : `${calHuman(item.date)} ${year}  ${item.time} – ${item.end}`;
  when.append(node("div", whenText, "pop-when"));
  if (item.repeat) { const repeat = node("div", undefined, "pop-repeat"); repeat.append(node("span", item.repeat), node("i", "⟳", "pop-repeat-icon")); when.append(repeat); }
  if (item.location) when.append(node("div", item.location, "pop-loc"));
  pop.append(when);
  // ── участники ──
  if (item.attendees?.length) {
    const people = popSection("pop-people");
    for (const attendee of item.attendees) {
      const row = node("div", undefined, "pop-person");
      row.append(popStatusIcon(attendee.status));
      const name = node("span", attendee.name || attendee.email);
      name.title = attendee.email;
      row.append(name);
      const marks = [attendee.organizer ? "организатор" : null, attendee.self ? "вы" : null, attendee.optional ? "необязательно" : null].filter(Boolean);
      if (marks.length) row.append(node("small", `(${marks.join(", ")})`));
      people.append(row);
    }
    pop.append(people);
  }
  // ── ссылки ──
  if (item.joinUrl) {
    const video = popSection("pop-link");
    const link = node("a", item.joinUrl.replace(/^https?:\/\//, ""));
    link.href = item.joinUrl; link.target = "_blank"; link.rel = "noopener";
    video.append(node("span", "Ссылка на видеовстречу: "), link);
    pop.append(video);
  }
  const eventUrl = item.url && item.url !== item.joinUrl ? item.url : null;
  if (eventUrl) { const urlSec = popSection("pop-link"); const link = node("a", eventUrl.replace(/^https?:\/\//, "")); link.href = eventUrl; link.target = "_blank"; link.rel = "noopener"; urlSec.append(link); pop.append(urlSec); }
  // ── мой ответ ──
  if (item.me) {
    const me = popSection("pop-me");
    const line = node("div", undefined, "pop-me-line");
    line.append(node("span", "Мой ответ:", "pop-me-label"), popStatusIcon(item.me.status), node("b", POP_STATUS[item.me.status]?.[1] || "без ответа"));
    me.append(line);
    const comment = node("input", undefined, "pop-comment");
    comment.type = "text"; comment.placeholder = "Комментарий организатору"; comment.maxLength = 500; comment.value = item.me.comment || "";
    comment.setAttribute("aria-label", "Комментарий организатору");
    const respond = async (status) => {
      for (const button of buttons.children) button.disabled = true;
      try {
        const body = { status, ...(comment.value.trim() !== (item.me.comment || "") ? { comment: comment.value.trim() } : {}) };
        await request(`/api/calendar/external/${encodeURIComponent(item.id)}/respond`, { method: "POST", body: JSON.stringify(body) });
        toast(`Ответ отправлен: ${POP_STATUS[status][1]}`);
        closeCalendarPop();
        await loadCalendar();
      } catch (error) { toast(error.message); for (const button of buttons.children) button.disabled = false; }
    };
    const buttons = node("div", undefined, "pop-me-buttons");
    // Текущий ответ — не кнопка призыва, а отметка состояния: цветом статуса,
    // с галочкой и без нажатия. Чёрная заливка читалась как «нажми меня».
    for (const [status, label, chosen] of [["accepted", "Принять", "Принято"], ["tentative", "Под вопросом", "Под вопросом"], ["declined", "Отклонить", "Отклонено"]]) {
      const current = item.me.status === status;
      const button = calButton(current ? `${POP_STATUS[status][0]} ${chosen}` : label, `cal-pop-btn small${current ? ` is-current ${status}` : ""}`, () => respond(status));
      button.setAttribute("aria-pressed", String(current));
      if (current) { button.disabled = true; button.title = "Ваш текущий ответ"; }
      buttons.append(button);
    }
    comment.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter") { keyEvent.preventDefault(); respond(item.me.status === "needs-action" ? "accepted" : item.me.status); } });
    me.append(buttons, comment);
    pop.append(me);
  }
  // ── действия ──
  const actions = node("div", undefined, "cal-pop-actions");
  if (item.joinUrl) { const join = node("a", "Присоединиться", "cal-pop-btn primary"); join.href = item.joinUrl; join.target = "_blank"; join.rel = "noopener"; actions.append(join); }
  const take = calButton("Взять в память", `cal-pop-btn${item.joinUrl ? "" : " primary"}`, async () => {
    take.disabled = true;
    try {
      const d = calParse(item.date);
      const numeric = `${calPad(d.getUTCDate())}.${calPad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
      const raw = item.allDay ? `${item.title} — ${numeric}, весь день (из календаря ${item.source})` : `${item.title} — ${numeric} в ${item.time}${item.end ? `–${item.end}` : ""}${item.location ? `, ${item.location}` : ""} (из календаря ${item.source})`;
      await request("/api/captures", { method: "POST", body: JSON.stringify({ raw }) });
      toast("Событие записано в память");
      closeCalendarPop();
      await load();
      await loadCalendar();
    } catch (error) { toast(error.message); take.disabled = false; }
  });
  actions.append(take);
  if (item.editable) {
    const remove = calButton("Удалить", "cal-pop-btn danger", async () => {
      const question = item.recurring
        ? `Удалить только этот повтор «${item.title}» (${calHuman(item.date)}) из календаря ${item.source}? Серия останется.`
        : `Удалить «${item.title}» из календаря ${item.source}? Это не вернуть.`;
      if (!confirm(question)) return;
      remove.disabled = true;
      try { await request(`/api/calendar/external/${encodeURIComponent(item.id)}`, { method: "DELETE" }); toast(`Удалено из ${item.source}`); closeCalendarPop(); await loadCalendar(); }
      catch (error) { toast(error.message); remove.disabled = false; }
    });
    actions.append(remove);
  }
  pop.append(actions);
  // Как в Календаре macOS: правка и удаление повтора касаются только этого
  // события, серия остаётся; ответ организатору — один на всю серию.
  const note = !item.editable
    ? "Чужое событие не запись: его нет в поиске и отчётах, пока вы не возьмёте его в память."
    : item.recurring
      ? "Экземпляр повтора: название по клику и перенос мышкой меняют только этот повтор, серия остаётся как была; ответ организатору — на всю серию."
      : "Чужое событие не запись: его нет в поиске и отчётах, пока вы не возьмёте его в память. Название правится по клику, перенос — мышкой, изменения уходят в календарь сразу.";
  pop.append(node("p", note, "cal-pop-note"));
  calPopFit(pop);
}
// Клик по пустому месту сетки — новая запись с уже подставленным временем.
function openCalendarQuickAdd(target, event) {
  const date = target.dataset.date;
  let time = null;
  if (target.classList.contains("cal-col")) {
    const rect = target.getBoundingClientRect();
    time = calTime(calSnap(CAL_H0 * 60 + ((event.clientY - rect.top) / CAL_HOUR_PX) * 60));
  }
  const pop = calPopAt(target);
  calPopPlace(pop, event.clientX + 8, event.clientY + 8);
  pop.classList.add("quick");
  pop.append(node("p", `${calHuman(date)}${time ? `, ${time}` : ""}`, "cal-pop-when"));
  const input = node("input");
  input.type = "text";
  input.placeholder = "Что записать? — «созвон с Сашей на полчаса»";
  input.setAttribute("aria-label", "Новая запись");
  pop.append(input);
  pop.append(node("p", "Enter — записать · Esc — закрыть. Дело получит этот срок; встречу разберёт модель.", "cal-pop-note"));
  input.focus();
  input.addEventListener("keydown", async (keyEvent) => {
    if (keyEvent.key === "Escape") { closeCalendarPop(); return; }
    if (keyEvent.key !== "Enter" || !input.value.trim()) return;
    keyEvent.preventDefault();
    const text = input.value.trim();
    input.disabled = true;
    try {
      const d = calParse(date);
      const numeric = `${calPad(d.getUTCDate())}.${calPad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
      // Встречу распознаёт модель — ей отдаём текст с датой словами; всё
      // остальное — дело с точным сроком, без гаданий.
      const looksMeeting = /созвон|встреч|обед|звон|митинг|интервью|демо|презентац|собеседован/i.test(text);
      const body = looksMeeting
        ? { raw: `${text} — ${numeric}${time ? ` в ${time}` : ""}` }
        : { raw: text, primaryType: "todo", due: { date, ...(time ? { time } : {}) } };
      await request("/api/captures", { method: "POST", body: JSON.stringify(body) });
      toast("Записано");
      closeCalendarPop();
      await load();
      await loadCalendar();
    } catch (error) { toast(error.message); input.disabled = false; }
  });
}
function calSnap(minutes) { return Math.max(CAL_H0 * 60, Math.min(CAL_H1 * 60 - CAL_STEP, Math.round(minutes / CAL_STEP) * CAL_STEP)); }
async function toggleCalendarDone(item) {
  const projectionId = item.projectionIds?.[0];
  if (!projectionId) return;
  try {
    await request(`/api/projections/${projectionId}/${item.done ? "undo-complete" : "complete"}`, { method: "POST", body: "{}" });
    await loadCalendar();
    toast(item.done ? "Снова в работе" : "Сделано");
  } catch (error) { toast(error.message); }
}
// Перенос — уточнение записи: сервер пересобирает проекции. «Вернуть» — не
// откат, а ещё одно уточнение с прежним сроком: история записи append-only,
// и снятие проекций через /api/undo оставило бы дело вовсе без срока.
// Чужое событие переносится в самом календаре — PATCH уходит в Яндекс, Apple
// или Google; «Вернуть» — такой же перенос обратно.
async function moveCalendarItem(item, schedule, { announce = true } = {}) {
  if (item.date === schedule.date && (item.time || null) === (schedule.time || null) && (item.end || null) === (schedule.end || null)) return;
  const before = { date: item.date, time: item.time, ...(item.end ? { end: item.end } : {}) };
  try {
    if (item.kind === "external") await request(`/api/calendar/external/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ date: schedule.date, time: schedule.time ?? null, end: schedule.end ?? null }) });
    else await request(`/api/captures/${item.id}/corrections`, { method: "POST", body: JSON.stringify({ patch: { schedule } }) });
    await loadCalendar();
    const label = schedule.time ? `${calHuman(schedule.date)}, ${schedule.time}` : `${calHuman(schedule.date)}, без времени`;
    if (announce) toast(`Перенесено${item.kind === "external" ? ` в ${item.source}` : ""}: ${label}`, { label: "Вернуть", run: () => moveCalendarItem({ ...item, ...schedule }, before, { announce: false }) });
    if (item.kind !== "external") await load();
  } catch (error) { toast(error.message); }
}
{
  const wrap = $("#calendar-view");
  const findItem = (id) => calState.data?.items.find((item) => item.id === id) || calState.data?.overdue?.find((item) => item.id === id) || calState.data?.external?.find((item) => item.id === id);
  wrap.addEventListener("dragstart", (event) => {
    const element = event.target.closest?.("[data-own][draggable='true']");
    if (!element) return;
    calState.drag = findItem(element.dataset.id);
    element.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", element.dataset.id);
  });
  wrap.addEventListener("dragend", () => { calState.drag = null; for (const el of wrap.querySelectorAll(".dragging, .over")) el.classList.remove("dragging", "over"); wrap.querySelector(".cal-ghost")?.remove(); });
  wrap.addEventListener("dragover", (event) => {
    const target = event.target.closest?.("[data-date]");
    if (!calState.drag || !target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    for (const el of wrap.querySelectorAll(".over")) el.classList.remove("over");
    if (target.classList.contains("cal-col")) {
      const rect = target.getBoundingClientRect();
      const minutes = calSnap(CAL_H0 * 60 + ((event.clientY - rect.top) / CAL_HOUR_PX) * 60);
      const item = calState.drag;
      const duration = item.time !== null ? calMinutes(calEndOf(item)) - calMinutes(item.time) : item.kind === "meeting" || item.kind === "external" ? 60 : 30;
      let ghost = wrap.querySelector(".cal-ghost");
      if (!ghost || ghost.parentElement !== target) { ghost?.remove(); ghost = node("div", undefined, "cal-ghost"); target.append(ghost); }
      ghost.style.top = `${((minutes - CAL_H0 * 60) / 60) * CAL_HOUR_PX}px`;
      ghost.style.height = `${(duration / 60) * CAL_HOUR_PX - 2}px`;
      ghost.textContent = `${calTime(minutes)}–${calTime(minutes + duration)}`;
    } else { target.classList.add("over"); wrap.querySelector(".cal-ghost")?.remove(); }
  });
  wrap.addEventListener("drop", (event) => {
    const target = event.target.closest?.("[data-date]");
    const item = calState.drag;
    if (!item || !target) return;
    event.preventDefault();
    const date = target.dataset.date;
    let schedule;
    if (target.classList.contains("cal-col")) {
      const rect = target.getBoundingClientRect();
      const start = calSnap(CAL_H0 * 60 + ((event.clientY - rect.top) / CAL_HOUR_PX) * 60);
      const duration = item.time !== null ? calMinutes(calEndOf(item)) - calMinutes(item.time) : item.kind === "meeting" || item.kind === "external" ? 60 : 30;
      const end = Math.min(start + duration, 23 * 60 + 59);
      schedule = { date, time: calTime(start), ...(item.end || item.time === null ? { end: calTime(end) } : {}) };
    } else if (target.dataset.notime && !target.classList.contains("cal-mc")) schedule = { date, time: null };
    else schedule = { date, time: item.time, ...(item.end ? { end: item.end } : {}) };
    moveCalendarItem(item, schedule);
  });
  wrap.addEventListener("click", (event) => {
    if (event.target.closest("[data-id], .cal-pop, button, a, input")) return;
    const target = event.target.closest(".cal-col, .cal-nt, .cal-mc");
    if (target) openCalendarQuickAdd(target, event);
  });
  $("#calendar-search")?.addEventListener("input", (event) => { calState.search = event.target.value; if (calState.data) renderCalendar(); });
  document.addEventListener("keydown", (event) => {
    if ($("#calendar").hidden) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "d" || key === "в") setCalendarMode("day");
    else if (key === "w" || key === "ц") { setCalendarMode("week"); calState.days = 7; }
    else if (key === "m" || key === "ь") setCalendarMode("month");
    else if (key === "t" || key === "е") calState.anchor = calToday();
    else if (event.key === "ArrowLeft") { calStep(-1); event.preventDefault(); return; }
    else if (event.key === "ArrowRight") { calStep(1); event.preventDefault(); return; }
    else if (event.key === "Escape") { closeCalendarPop(); return; }
    else if (/^[1-7]$/.test(event.key)) { calState.days = Number(event.key); setCalendarMode(calState.days === 1 ? "day" : "week"); if (calState.days === 1) calState.days = 7; }
    else return;
    event.preventDefault();
    loadCalendar();
  });
}

// ── Календари в настройках ──────────────────────────────────────────────────
const CAL_PRESET_HINTS = {
  yandex: { title: "Яндекс Календарь", hint: "Логин — адрес почты Яндекса. Пароль — пароль приложения из Яндекс ID: «Безопасность → Пароли приложений → Календарь». Обычный пароль не подойдёт.", placeholder: "name@yandex.ru" },
  icloud: { title: "Apple iCloud", hint: "Логин — Apple ID. Пароль — пароль для приложения с appleid.apple.com: «Вход и безопасность → Пароли приложений».", placeholder: "name@icloud.com" },
  custom: { title: "Другой CalDAV", hint: "Адрес сервера, логин и пароль — как в любом CalDAV-клиенте. Подойдёт Fastmail, Nextcloud, Radicale.", placeholder: "логин" },
};
let calendarAccountsState = { accounts: [], googleReady: false };
async function loadCalendarAccounts() {
  const wrap = $("#calendar-accounts");
  if (!wrap) return;
  try {
    calendarAccountsState = await request("/api/calendar/accounts");
    paintCalendarAccounts();
  } catch (error) { clear(wrap); wrap.append(node("p", error.message, "setting-hint")); }
}
function calendarSyncLabel(account) {
  if (account.syncError) return `ошибка: ${account.syncError}`;
  if (!account.syncedAt) return "ещё не синхронизирован";
  const minutes = Math.round((Date.now() - Date.parse(account.syncedAt)) / 60000);
  return minutes < 1 ? "обновлён только что" : minutes < 60 ? `обновлён ${minutes} мин назад` : `обновлён ${Math.round(minutes / 60)} ч назад`;
}
function paintCalendarAccounts() {
  const wrap = $("#calendar-accounts");
  clear(wrap);
  const google = $("#calendar-google");
  if (google) { google.classList.toggle("is-disabled", !calendarAccountsState.googleReady); google.title = calendarAccountsState.googleReady ? "" : "Сначала укажите ID и секрет клиента Google в «Ключах»"; }
  if (!calendarAccountsState.accounts.length) { wrap.append(node("p", "Пока ни одного внешнего календаря.", "setting-hint")); return; }
  for (const account of calendarAccountsState.accounts) {
    const card = node("div", undefined, `calendar-account${account.disabled ? " is-disabled" : ""}`);
    const head = node("div", undefined, "calendar-account-head");
    const dot = node("i", undefined, "cal-dot");
    dot.style.background = account.color || "var(--n-72)";
    const name = node("b", account.label);
    name.title = "Переименовать";
    name.tabIndex = 0;
    name.addEventListener("click", async () => {
      const next = prompt("Название календаря", account.label);
      if (next === null || !next.trim() || next.trim() === account.label) return;
      await patchCalendarAccount(account.id, { label: next.trim() });
    });
    const meta = node("span", `${account.provider === "google" ? "Google" : account.preset === "yandex" ? "Яндекс · CalDAV" : account.preset === "icloud" ? "Apple · CalDAV" : "CalDAV"} · ${account.disabled ? "отключён" : calendarSyncLabel(account)}${account.exportError ? ` · отправка: ${account.exportError}` : ""}`, `calendar-account-meta${account.syncError || account.exportError ? " is-error" : ""}`);
    head.append(dot, name, meta);
    card.append(head);
    const list = node("div", undefined, "calendar-account-calendars");
    for (const calendar of account.calendars) {
      const label = node("label", undefined, "calendar-account-calendar");
      const box = node("input");
      box.type = "checkbox";
      box.checked = calendar.selected;
      box.addEventListener("change", () => patchCalendarAccount(account.id, { calendars: account.calendars.filter((item) => (item.id === calendar.id ? box.checked : item.selected)).map((item) => item.id) }));
      const swatch = node("i", undefined, "cal-dot");
      swatch.style.background = calendar.color || account.color || "var(--n-72)";
      label.append(box, swatch, node("span", calendar.name));
      if (!calendar.writable) label.append(node("small", "только чтение"));
      list.append(label);
    }
    card.append(list);
    const controls = node("div", undefined, "calendar-account-controls");
    const mode = node("select");
    for (const [value, text] of [["full", "Показывать названия"], ["busy", "Только «занято»"]]) { const option = node("option", text); option.value = value; option.selected = account.mode === value; mode.append(option); }
    mode.addEventListener("change", () => patchCalendarAccount(account.id, { mode: mode.value }));
    const color = node("input");
    color.type = "color";
    color.value = account.color || "#8a8681";
    color.title = "Цвет в календаре";
    color.addEventListener("change", () => patchCalendarAccount(account.id, { color: color.value }));
    const sync = calButton("Обновить", "secondary", async () => {
      sync.disabled = true;
      try { const result = await request(`/api/calendar/accounts/${account.id}/sync`, { method: "POST", body: "{}" }); toast(`Синхронизировано: ${result.events ?? 0} соб.`); }
      catch (error) { toast(error.message); }
      await loadCalendarAccounts();
    });
    const toggle = calButton(account.disabled ? "Включить" : "Отключить", "secondary", () => patchCalendarAccount(account.id, { disabled: !account.disabled }));
    const remove = calButton("Удалить", "secondary calendar-remove", async () => {
      if (!confirm(`Удалить «${account.label}»? Учётные данные и кэш событий сотрутся; сам календарь не пострадает.`)) return;
      try { await request(`/api/calendar/accounts/${account.id}`, { method: "DELETE" }); toast("Календарь отключён"); }
      catch (error) { toast(error.message); }
      await loadCalendarAccounts();
    });
    controls.append(mode, color, sync, toggle, remove);
    card.append(controls);
    // Автоотправка: свои дела и встречи со сроком сами уходят в выбранный
    // календарь и следуют за записью — перенос, «сделано», удаление. Это
    // разрешение даётся один раз здесь, а не на каждую запись.
    const auto = node("div", undefined, "calendar-account-auto");
    const autoMode = node("select");
    for (const [value, text] of [["off", "Наружу — только кнопкой"], ["meetings", "Отправлять встречи"], ["all", "Отправлять встречи и дела"]]) { const option = node("option", text); option.value = value; option.selected = (account.autoExport || "off") === value; autoMode.append(option); }
    autoMode.setAttribute("aria-label", "Автоматическая отправка");
    autoMode.addEventListener("change", () => patchCalendarAccount(account.id, { autoExport: autoMode.value }));
    auto.append(autoMode);
    const writable = account.calendars.filter((calendar) => calendar.writable);
    if ((account.autoExport || "off") !== "off" && writable.length) {
      auto.append(node("span", "в", "calendar-account-auto-in"));
      const target = node("select");
      target.setAttribute("aria-label", "Календарь для отправки");
      for (const calendar of writable) { const option = node("option", calendar.name); option.value = calendar.id; option.selected = calendar.id === account.autoCalendarId; target.append(option); }
      target.addEventListener("change", () => patchCalendarAccount(account.id, { autoCalendarId: target.value }));
      auto.append(target);
    }
    auto.append(node("small", (account.autoExport || "off") === "off" ? "Дела и встречи уходят в календарь только кнопкой «В календарь» в карточке." : "Уходят сами и следуют за записью: перенос, конец, удаление. Сдвинули событие в календаре — срок записи подвинется тоже.", "setting-hint"));
    card.append(auto);
    wrap.append(card);
  }
}
async function patchCalendarAccount(id, patch) {
  try { await request(`/api/calendar/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); }
  catch (error) { toast(error.message); }
  await loadCalendarAccounts();
}
{
  const form = $("#calendar-connect");
  if (form) {
    let preset = "yandex";
    const open = (next) => {
      preset = next;
      const info = CAL_PRESET_HINTS[preset];
      $("#calendar-connect-title").textContent = info.title;
      $("#calendar-connect-hint").textContent = info.hint;
      $("#calendar-server-row").hidden = preset !== "custom";
      $("#calendar-username").placeholder = info.placeholder;
      $("#calendar-connect-state").textContent = "";
      form.hidden = false;
      $("#calendar-username").focus();
    };
    for (const button of document.querySelectorAll("[data-calendar-preset]")) button.addEventListener("click", () => open(button.dataset.calendarPreset));
    $("#calendar-connect-cancel").addEventListener("click", () => { form.hidden = true; form.reset(); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const state = $("#calendar-connect-state"), submit = $("#calendar-connect-submit");
      state.textContent = "Проверяем…";
      submit.disabled = true;
      try {
        const result = await request("/api/calendar/accounts", { method: "POST", body: JSON.stringify({ preset, serverUrl: $("#calendar-server").value.trim() || null, username: $("#calendar-username").value.trim(), password: $("#calendar-password").value }) });
        toast(result.syncError ? `Подключено, но синхронизация не удалась: ${result.syncError}` : `Подключено: ${result.account.calendars.length} кал., ${result.events ?? 0} соб.`);
        form.hidden = true;
        form.reset();
        await loadCalendarAccounts();
      } catch (error) { state.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    $("#calendar-google")?.addEventListener("click", (event) => { if (!calendarAccountsState.googleReady) { event.preventDefault(); toast("Сначала укажите ID и секрет клиента Google в «Ключах»"); } });
  }
}

// «В календарь» в карточке: список календарей, куда можно писать, и что уже
// отправлено. Собирается после открытия карточки — двумя короткими запросами,
// чтобы карточка не ждала календарь.
function calendarExportEl(entry) {
  const wrap = node("div", undefined, "card-calendar");
  const c = entry.interpretation.classification;
  const date = c.entities.schedule?.date;
  (async () => {
    try {
      const [{ accounts }, view] = await Promise.all([request("/api/calendar/accounts"), request(`/api/calendar?from=${date}&to=${date}`)]);
      const writable = accounts.filter((account) => !account.disabled).flatMap((account) => account.calendars.filter((calendar) => calendar.selected && calendar.writable).map((calendar) => ({ account, calendar })));
      const item = view.items.find((candidate) => candidate.id === entry.id);
      const exports = item?.exports || [];
      clear(wrap);
      if (!accounts.length) return;
      for (const link of exports) {
        const account = accounts.find((candidate) => candidate.id === link.accountId);
        const row = node("span", undefined, "card-calendar-link");
        row.append(node("span", `В календаре: ${account?.label || "внешний"}${link.auto ? " · автоматически" : ""}`));
        if (link.href && link.href.startsWith("http")) { const open = node("a", "открыть"); open.href = link.href; open.target = "_blank"; open.rel = "noopener"; row.append(open); }
        // Автоматическую отправку «убрать» нельзя: следующий проход вернул бы
        // событие. Выключается в настройках календаря.
        if (link.auto && (account?.autoExport || "off") !== "off") { wrap.append(row); continue; }
        const remove = node("button", "убрать", "card-calendar-remove");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try { await request("/api/calendar/export/remove", { method: "POST", body: JSON.stringify({ captureId: entry.id, accountId: link.accountId }) }); toast("Событие убрано из календаря"); wrap.replaceWith(calendarExportEl(entry)); }
          catch (error) { toast(error.message); remove.disabled = false; }
        });
        row.append(remove);
        wrap.append(row);
      }
      const targets = writable.filter(({ account }) => !exports.some((link) => link.accountId === account.id));
      if (!targets.length) return;
      const menu = node("details", undefined, "card-calendar-menu");
      menu.append(node("summary", "В календарь"));
      const list = node("div", undefined, "card-calendar-list");
      for (const { account, calendar } of targets) {
        const button = node("button", `${account.label} · ${calendar.name}`, "card-calendar-target");
        button.type = "button";
        const dot = node("i", undefined, "cal-dot");
        dot.style.background = calendar.color || account.color || "var(--n-72)";
        button.prepend(dot);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await request("/api/calendar/export", { method: "POST", body: JSON.stringify({ captureId: entry.id, accountId: account.id, calendarId: calendar.id }) }); toast(`Отправлено в ${account.label}`); wrap.replaceWith(calendarExportEl(entry)); }
          catch (error) { toast(error.message); button.disabled = false; }
        });
        list.append(button);
      }
      menu.append(list);
      wrap.append(menu);
    } catch { clear(wrap); }
  })();
  return wrap;
}

// ── напоминания и push ───────────────────────────────────────────────────
// Напоминание считает сервер; страница только показывает, что настроено, и
// подписывает устройство на Web Push. Подписка — на каждом устройстве своя.
const REMIND_LABELS = { off: "не напоминать", 0: "в момент начала", 5: "за 5 минут", 15: "за 15 минут", 30: "за 30 минут", 60: "за час", 120: "за 2 часа", 1440: "за день" };
function remindMinutesLabel(value) { return REMIND_LABELS[String(value)] || `за ${value} мин`; }
function remindDefaultLabel() { return remindMinutesLabel(appSettings.remindDefault ?? "15"); }
function remindHourValue() { const value = appSettings.remindHour; return value && value !== "off" ? value : "09:00"; }
function remindHourLabel() { return appSettings.remindHour === "off" ? "не напоминать" : `в ${remindHourValue()}`; }
const IOS_DEVICE = /iPhone|iPad|iPod/.test(navigator.userAgent);
function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
async function currentPushSubscription() {
  if (!pushSupported()) return null;
  try { const registration = await navigator.serviceWorker.getRegistration("/"); return registration ? await registration.pushManager.getSubscription() : null; } catch { return null; }
}
async function paintPush() {
  const state = $("#push-state");
  if (!state) return;
  const enable = $("#push-enable"), disable = $("#push-disable"), test = $("#push-test");
  if (!pushSupported()) {
    state.textContent = IOS_DEVICE
      ? "На iPhone уведомления работают, если добавить Кизуну на экран «Домой» (Поделиться → На экран «Домой») и открывать оттуда."
      : "Этот браузер не умеет уведомления на закрытую вкладку.";
    enable.hidden = disable.hidden = test.hidden = true;
    return;
  }
  const subscription = await currentPushSubscription();
  let others = 0;
  try { const info = await request("/api/push/key"); others = info.subscriptions.filter((item) => item.endpoint !== subscription?.endpoint).length; } catch {}
  const denied = Notification.permission === "denied";
  if (subscription) state.textContent = `На этом устройстве включены${others ? `, ещё устройств: ${others}` : ""}.`;
  else if (denied) state.textContent = "Уведомления для этого сайта запрещены в браузере — разрешите их в настройках сайта.";
  else state.textContent = others ? `На этом устройстве выключены, других устройств: ${others}.` : "Уведомления приходят на закрытую вкладку и на телефон. Включаются на каждом устройстве отдельно.";
  enable.hidden = Boolean(subscription) || denied;
  disable.hidden = !subscription;
  test.hidden = !subscription && !others;
}
async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") { toast("Без разрешения браузера уведомления не придут"); paintPush(); return; }
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const { publicKey } = await request("/api/push/key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await request("/api/push/subscriptions", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
  toast("Уведомления включены на этом устройстве");
  paintPush();
}
async function disablePush() {
  const subscription = await currentPushSubscription();
  if (subscription) {
    await request("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
    try { await subscription.unsubscribe(); } catch {}
  }
  toast("Уведомления выключены на этом устройстве");
  paintPush();
}
async function testPush() {
  try {
    const summary = await request("/api/push/test", { method: "POST", body: "{}" });
    toast(summary.sent ? "Пробное уведомление отправлено" : "Устройство не приняло уведомление — включите заново");
  } catch (error) { toast(error.message); }
}
// Браузер может сменить адрес подписки: при каждой загрузке она уходит на
// сервер заново, если на устройстве есть.
async function syncPushSubscription() {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  try { await request("/api/push/subscriptions", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) }); } catch {}
}
async function paintUpcomingReminders() {
  const element = $("#reminders-upcoming");
  if (!element) return;
  try {
    const { reminders } = await request("/api/reminders/upcoming");
    element.textContent = reminders.length
      ? `Ближайшие: ${reminders.slice(0, 3).map((item) => `«${item.title}» — ${item.when}${item.lead ? `, ${item.lead.replace("через", "за")} до` : ""}`).join("; ")}.`
      : "Впереди напоминаний нет: у открытых дел со сроком они появятся сами.";
  } catch { element.textContent = ""; }
}
async function openCaptureById(id) {
  // По ссылке карточка открывается так же, как по клику в списке: с вопросом
  // модели, если разбор неуверенный.
  try { const { entry } = await request(`/api/captures/${encodeURIComponent(id)}`); const review = reviewFromEntry(entry); showCorrection(entry, review.level === "high" ? undefined : review); }
  catch (error) { toast(error.message); }
}
$("#push-enable")?.addEventListener("click", () => enablePush().catch((error) => { toast(error.message || "Не удалось включить уведомления"); paintPush(); }));
$("#push-disable")?.addEventListener("click", () => disablePush().catch((error) => toast(error.message)));
$("#push-test")?.addEventListener("click", testPush);
