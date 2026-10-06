import { listPendingDrafts, readPendingDraft } from "./legacy-draft-recovery.bundle.js";
import { uiStorage, receiveUiPreferences, refreshUiPreferences, startUiPreferenceSync } from "./ui-preferences.js";
import { safeExternalUrl } from "./safe-url.js";
import { frameResizeObserver } from "./frame-resize-observer.js";
import { mountLanguageControls, syncLanguageControls } from "./language-control.js";
import { normalizeTimeZone } from "./time-zone.js";
import { getTimeZone, getDetectedTimeZone, initTimeZone, setTimeZone, announceTimeZoneSaved } from "./browser-time-zone.js";
import { t, getLocale, localizedBuiltins, bindTranslation, initLocale, setLocale, getDetectedLocale, announceLocaleSaved, getLocalePreferences } from "./browser-i18n.js";
import { renderMarkdown, renderInlineMarkdown } from "./markdown.js";
import { createMarkdownField } from "./markdown-live.js";
import { createCapturePrompt } from "./capture-prompt.js";
import { attachSlashMenu } from "./slash-menu.js";
import { attachLinkMenu } from "./link-menu.js";
import { attachMentionMenu, forgetMentionPeople } from "./mention-menu.js";
import { attachFormatToolbar } from "./format-toolbar.js";
import { openNotes, refreshNotes } from "./notes.js";
import { mountGuide } from "./guide.js";
import { mountAdministration } from "./administration.js";
import { mountFeedback } from "./feedback.js";
import { phaseOf, coverFor, plural, hm, duration, minutesOf, longDate, shortDate, isWeekend, MEETINGS, DEALS, PHASE_NAMES } from "./today-cover.js";
import { FILTER_FIELDS, FILTER_STATUSES, FILTER_NONE, DONE_LANE, defaultFilter, readFilter, mergeConditions, activeConditions, toggleValue, sameFilter, matchesFilter, statusAllowsDone, readOrder, orderKeys, moveKey, placeLast, readShown } from "./board-model.js";

const $ = (selector) => document.querySelector(selector);
const typeNames = {
  get meeting_event() { return t("встреча"); },
  get task() { return t("задача"); },
  get note() { return t("заметка"); },
  get outcome_decision() { return t("результат"); },
  get idea_question() { return t("идея"); },
};
const providerNames = {
  get fallback() { return t("Без разбора"); },
  openai: "OpenAI",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
};
// У кого можно выбирать модель прямо в шапке. У OpenAI каталог приходит из их
// же API, у OpenRouter — из своего; у CLI-провайдеров модель задаёт окружение.
const modelCapableProviders = new Set(["openrouter", "openai", "gemini"]);
const fallbackNames = {
  get unavailable() { return t("недоступен"); },
  get not_configured() { return t("не настроен"); },
  get busy() { return t("занят"); },
  get timeout() { return t("не ответил вовремя"); },
  get aborted() { return t("отменён"); },
  get nonzero() { return t("не завершил запрос"); },
  get malformed_output() { return t("вернул непонятный ответ"); },
  get absent_output() { return t("не вернул ответ"); },
  get oversize_output() { return t("вернул слишком большой ответ"); },
  get schema_invalid() { return t("вернул некорректную структуру"); },
  get rate_limited() { return t("достиг лимита"); },
  get citation_failure() { return t("не подтвердил источники"); },
  get invalid_provider() { return t("неизвестный провайдер"); },
  get spend_limit() { return t("остановлен потолком расходов"); },
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
  if (url.startsWith('/api/notifications')) url += `${url.includes('?') ? '&' : '?'}scope=personal`;
  const headers = {
      "Content-Type": "application/json",
      "Accept-Language": getLocale(),
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
    // A valid session can still need a fresh second factor for this action.
    const reauthenticationError = ["totp_required", "invalid_totp"].includes(data?.error?.code);
    if (response.status === 401 && !reauthenticationError) { location.replace("/login"); throw new Error(t("Нужно войти.")); }
    if (!response.ok)
      throw new Error(data?.error?.message || t("Не удалось выполнить действие."));
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
// User actions use the service configuration saved by an administrator.
function withProvider(body = {}) {
  return body;
}
function fallbackSuffix(provenance) {
  return provenance?.fallbackReason &&
    provenance.requestedProvider !== "fallback"
    ? ` · ${fallbackNames[provenance.fallbackReason] || t("недоступен")}`
    : "";
}
function showProvenance(provenance) {
  if (!provenance) return;
  const provider = provenance.usedProvider || provenance.provider,
    element = $("#ai-status");
  bindTranslation(element, "Использован: {value1}{value2}", { value1: providerNames[provider] || t("локальные правила"), value2: fallbackSuffix(provenance) });
  element.className = `status ${provider !== "fallback" ? "ai" : fallbackSuffix(provenance) ? "fallback" : ""}`.trim();
}
// Состояние «Обзора» объявлено до первого разбора адреса: прямая ссылка на
// #reports зовёт loadReports сразу, и объявление ниже по файлу ещё не
// существовало бы — обзор оставался пустым до щелчка по вкладке.
// «День» — первая вкладка и вкладка по умолчанию: обзор открывают спросить
// «что было вчера», а сводные «Записи» нужны реже и стоят в конце.
const reportsState = { tab: "day", period: "week", dayDate: null };
const adminArea = mountAdministration({ request, toast, accountKnown: async () => { await accountKnown; return currentUser; }, loadUsers: loadAdmin, loadSettings, loadAi: status, loadUsage });
const feedbackArea = mountFeedback({ request, accountKnown: async () => { await accountKnown; return currentUser; } });
let requestedTodayDate = null;
function dateFromTodayLink(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function applyRequestedTodayDate() {
  if (!requestedTodayDate || !currentDayDate) return;
  const offset = calDayDiff(currentDayDate, requestedTodayDate);
  todayState.view = offset;
  todayState.journalView = offset;
  todayState.tab = "day";
  todayState.manual = true;
  requestedTodayDate = null;
}
function updatePageFromHash() {
  // Внутренние ссылки Obsidian ведут в память с запросом: «#memory?query=Hub».
  // Хэш поэтому разбирается на страницу и параметры — иначе такой страницы не
  // находится и человека выбрасывает на «Сегодня» вместо поиска.
  const hash = location.hash.slice(1);
  // Приглашение в круг приходит ссылкой «#join/<токен>»: это не страница, а
  // разовое действие, поэтому разбирается до страниц.
  if (hash.startsWith("join/")) { openInvite(hash.slice(5)); return; }
  const separator = hash.indexOf("?");
  const routeId = (separator >= 0 ? hash.slice(0, separator) : hash) || "today";
  const pageId = routeId.startsWith('admin/') ? 'admin' : routeId;
  const params = new URLSearchParams(separator >= 0 ? hash.slice(separator + 1) : "");
  const page = document.getElementById(pageId);
  const activePage = page?.classList.contains("app-page") ? pageId : "today";
  requestedTodayDate = activePage === "today" ? dateFromTodayLink(params.get("date")) : null;
  // Ссылка из уведомления: открыть карточку записи и убрать параметр из адреса.
  const openId = params.get("open");
  if (openId) { params.delete("open"); history.replaceState(null, "", `#${activePage}${params.size ? `?${params}` : ""}`); openCaptureById(openId); }
  // Ссылка из push о разговоре: открыть комнату круга.
  const roomId = params.get("room");
  if (roomId) { params.delete("room"); history.replaceState(null, "", `#${activePage}${params.size ? `?${params}` : ""}`); openRoomFromInbox(roomId); }
  for (const section of document.querySelectorAll(".app-page"))
    section.hidden = section.id !== activePage;
  document.body.classList.toggle('admin-mode', activePage === 'admin');
  for (const link of document.querySelectorAll("nav a")) {
    const on = link.getAttribute("href") === `#${activePage}`;
    // Док: подпрыгивание один раз, когда раздел только что выбрали.
    if (on && !link.classList.contains("active") && link.closest(".dock-item")) {
      link.classList.remove("bounce");
      void link.offsetWidth;
      link.classList.add("bounce");
      setTimeout(() => link.classList.remove("bounce"), 400);
    }
    link.classList.toggle("active", on);
    if (on) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (activePage !== pageId) history.replaceState(null, "", "#today");
  // Вернулись на «Сегодня» — обложка и строка «сейчас» пересчитываются: пока
  // страница была скрыта, время шло.
  if (activePage === "today") renderToday();
  // Вопрос из адреса «#guide?q=…» открывается сразу — на него можно дать
  // ссылку, а с «&demo=1» он сразу идёт демо. В шапке страницы нет.
  if (activePage === "guide") renderGuide(params.get("q"), params.has("demo"));
  // Открыли настройки — перечитываем расход: он меняется от каждой записи, а
  // страница может висеть открытой долго.
  if (activePage === "settings") {
    paintPush();
    paintUpcomingReminders();
    loadCalendarAccounts();
    loadTelegram();
    loadMemory();
    // Google возвращает сюда после согласия с итогом в адресе: без слова
    // человек не понял бы, подключилось или нет.
    const calendarOutcome = params.get("calendar");
    if (calendarOutcome) {
      const messages = { get connected() { return t("Google Calendar подключён"); }, get denied() { return t("Google: доступ не дан"); }, get invalid_state() { return t("Подключение Google устарело — попробуйте снова"); }, get no_refresh_token() { return t("Google не выдал токен обновления: отзовите доступ Кизуны в аккаунте Google и подключите заново"); } };
      toast(messages[calendarOutcome] || t("Google: не удалось подключить ({calendarOutcome})", { calendarOutcome: calendarOutcome }));
      history.replaceState(null, "", "#settings");
    }
  }
  if (activePage === "admin") queueMicrotask(() => adminArea.show());
  if (activePage === "feedback") queueMicrotask(() => feedbackArea.show());
  if (activePage === "circles") loadCircles();
  if (activePage === "board") loadBoard();
  if (activePage === "done") loadDone({ fresh: true });
  // Календарь перечитывается при каждом открытии: сроки правятся из карточек
  // и с доски, а чужие события приходят синхронизацией в фоне. Первый разбор
  // адреса случается до того, как модуль дошёл до состояния календаря, —
  // вызов откладывается на микрозадачу, когда модуль уже прочитан целиком.
  // Ссылка из уведомления ведёт на день встречи и открывает её плашку.
  if (activePage === "calendar") {
    const date = params.get("date"), event = params.get("event"), item = params.get("item");
    if (date || event || item) history.replaceState(null, "", "#calendar");
    Promise.resolve()
      .then(() => { if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) calState.anchor = date; return loadCalendar(); })
      .then(() => { if (event || item) openCalendarEvent({ uid: event, id: item, date }); });
  }
  // «Обзор» пересчитывается при каждом открытии: цифры меняются от каждой
  // записи, а страница может быть открыта спустя часы.
  if (activePage === "reports") loadReports();
  // «Заметки» живут своим модулем: ему отдаётся только то, чем он ходит в
  // приложение, — запрос, тост и карточка записи.
  if (activePage === "notes") openNotes(params, { request, toast, openCard: openCaptureById });
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
$("#account-guide-link")?.addEventListener("click", () => $(".account-menu")?.removeAttribute("open"));
document.addEventListener("pointerdown", (event) => {
  // «Вернуть» в тосте — продолжение действия в меню: лента остаётся открытой.
  if (event.target.closest?.("#toast")) return;
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
// «Сделал X» теперь туду, закрытая при записи: открыта она или закрыта, говорит
// кружок (леджер), а не признак разбора. Признак completed решает только для
// старых записей без дела внутри — им закрывать и возвращать нечего.
function isReportedWork(entry) {
  return entry.interpretation.classification.completed === true && completableProjections(entry).length === 0;
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
  const time = new Intl.DateTimeFormat(getLocale(), {
    timeZone: getTimeZone(),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  const date = entryDate(entry);
  const day =
    currentDayDate && date === currentDayDate
      ? t("сегодня")
      : currentDayDate && date === shiftDate(currentDayDate, -1)
        ? t("вчера")
        : new Intl.DateTimeFormat(getLocale(), {
            timeZone: getTimeZone(),
            day: "numeric",
            month: "short",
          }).format(at);
  return `${day}, ${time}`;
}
function scheduleLabel(schedule, on = null) {
  if (!schedule) return null;
  if (schedule.state === "conflict" || (!schedule.date && !schedule.time))
    return schedule.state === "conflict" ? t("Срок требует уточнения") : null;
  const today = currentDayDate || zoneDate(new Date());
  // У повтора подпись — про показанный день или ближайший экземпляр, а не
  // про первый: «сегодня, 10:00, каждую неделю».
  const shown = schedule.repeat && schedule.date
    ? (on && repeatOccursOn(schedule, on) ? on : nextRepeatDate(schedule, today) || schedule.date)
    : schedule.date;
  let dateLabel = shown;
  if (shown) {
    dateLabel =
      shown === today
        ? t("сегодня")
        : shown === shiftDate(today, 1)
          ? t("завтра")
          : shown === shiftDate(today, -1)
            ? t("вчера")
            : new Intl.DateTimeFormat(getLocale(), {
                timeZone: "UTC", day: "numeric", month: "short",
                ...(shown.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
              }).format(new Date(`${shown}T12:00:00Z`));
  }
  const vague =
    !schedule.time && schedule.display?.includes("после обеда")
      ? t("после обеда")
      : null;
  const words = repeatLabel(schedule.repeat, { until: false });
  return (
    [dateLabel, schedule.time || vague, words].filter(Boolean).join(", ") ||
    null
  );
}
function entryDate(entry) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getTimeZone(),
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
    // Промах кружком снимается одним нажатием, как удаление и перенос серии.
    toast(complete ? t("Отмечено как готовое") : t("Возвращено в работу"), complete ? { get label() { return t("Вернуть"); }, run: async () => {
      try {
        for (const projection of pending) await request(`/api/projections/${projection.id}/undo-complete`, { method: "POST", body: "{}" });
        toast(t("Возвращено в работу"));
        await load();
        refreshOtherViews();
      } catch (error) { toast(error.message); }
    } } : null);
    await load();
    refreshOtherViews();
  } catch (error) {
    toast(error.message);
  } finally {
    for (const projection of pending) completionInFlight.delete(projection.id);
    button.disabled = false;
  }
}
// dense — вид для ящика «День»: дело в одну строку. Из четырёх пилюль остаются
// только те, что что-то говорят: «задача» повторяется у всего списка подряд,
// «без срока» — у большинства, а время записи в списке дня не нужно вовсе, оно
// есть в карточке. Двенадцать дел двухэтажными плашками читались как стена, и
// встречи из-за них уезжали за нижний край экрана.
// Быстрый срок: просроченное дело чаще всего просто переносят, и ради этого
// открывать карточку незачем. Повтор сюда не попадает — там перенос значит
// «сдвинуть серию», и это решение принимают в карточке.
async function quickDue(entry, days) {
  const schedule = entry.interpretation.classification.entities.schedule || null;
  const date = days === null ? null : shiftDate(currentDayDate || zoneDate(new Date()), days);
  const move = (target, time) => request(`/api/captures/${entry.id}/corrections`, {
    method: "POST",
    body: JSON.stringify({ at: Date.now(), patch: { schedule: { date: target, time: target ? time : null } } }),
  });
  try {
    await move(date, schedule?.time || null);
    // Перенос — тоже решение на лету: «Вернуть» кладёт прежний срок обратно.
    toast(date ? t("Срок: {value1}", { value1: scheduleLabel({ state: "ok", date, time: null }) }) : t("Срок снят"), { get label() { return t("Вернуть"); }, run: async () => {
      try { await move(schedule?.date || null, schedule?.time || null); toast(t("Срок вернулся")); await load(); }
      catch (error) { toast(error.message); }
    } });
    await load();
  } catch (error) { toast(error.message || t("Срок не изменился")); }
}
// Клавиши списка, как в Тудуисте: ↑ ↓ или J / K — по делам, E — готово или
// вернуть, Enter — открыть карточку, T — срок «сегодня» у дела без срока.
// Работают в «Дне» и на «Доске», пока фокус не в поле ввода; в русской
// раскладке — те же клавиши: о, л, у, е.
const listKeys = { after: null };
document.addEventListener("keydown", async (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable='true'], dialog, .bell-popover, details[open]")) return;
  const scope = !$("#today")?.hidden && $("#todo") && !$("#todo").hidden ? $("#todo") : !$("#board")?.hidden ? $("#board") : null;
  if (!scope) return;
  const rows = [...scope.querySelectorAll(".entry[data-capture-id], .board-card[data-capture-id], .board-row[data-capture-id]")].filter((row) => row.getClientRects().length);
  if (!rows.length) return;
  const key = event.key.toLowerCase();
  const current = document.activeElement?.closest?.("[data-capture-id]");
  const index = current && scope.contains(current) ? rows.indexOf(current) : -1;
  const focusRow = (row) => { if (!row.hasAttribute("tabindex")) row.tabIndex = -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" }); };
  const letterDown = key === "j" || key === "о", letterUp = key === "k" || key === "л";
  const down = event.key === "ArrowDown" || letterDown, up = event.key === "ArrowUp" || letterUp;
  if ((down || up) && (index >= 0 || letterDown || letterUp)) {
    event.preventDefault();
    focusRow(rows[index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (down ? 1 : -1)))]);
    return;
  }
  if (index < 0) return;
  const row = rows[index];
  if (key === "e" || key === "у") {
    const box = row.querySelector(":scope > .completion-button, :scope > .board-done");
    if (!box) return;
    event.preventDefault();
    listKeys.after = { from: row.dataset.captureId, to: (rows[index + 1] || rows[index - 1])?.dataset.captureId || null };
    box.click();
    return;
  }
  if (event.key === "Enter" && event.target === row) {
    event.preventDefault();
    row.querySelector(".entry-title, .board-title")?.click();
    return;
  }
  if (key === "t" || key === "е") {
    event.preventDefault();
    const id = row.dataset.captureId;
    let entry = todayState.entries.find((candidate) => candidate.id === id);
    try { if (!entry) entry = (await request(`/api/captures/${encodeURIComponent(id)}`)).entry; }
    catch (error) { toast(error.message); return; }
    if (scheduleOf(entry)?.date) { toast(t("Срок у дела уже есть — перенести можно в карточке")); return; }
    await quickDue(entry, 0);
    refreshOtherViews();
  }
});
// После отметки в «Дне» сетка календаря и «Доска», если они открыты, тоже
// должны увидеть закрытое.
function refreshOtherViews() {
  if (!$("#calendar")?.hidden) loadCalendar();
  if (!$("#board")?.hidden) loadBoard();
  if (!$("#done")?.hidden) loadDone();
}
// Смахнуть строку на телефоне, как в Тудуисте: вправо — готово, влево — на
// сегодня (у дела из запаса). Мышью строка не тянется: там кружок и клавиши.
function attachRowSwipe(row, { onRight = null, onLeft = null } = {}) {
  let drag = null;
  // Название — кнопка во всю строку, поэтому смахивание начинается и на нём;
  // кружок и кнопки срока нажимаются как обычно.
  row.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || event.target.closest(".completion-button, .quick-due, .todo-tomorrow, .sub-badge, a, input")) return;
    drag = { x: event.clientX, y: event.clientY, id: event.pointerId, moving: false, dx: 0 };
  });
  row.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moving) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      if (Math.abs(dx) < 12 || (dx < 0 && !onLeft) || (dx > 0 && !onRight)) return;
      drag.moving = true;
      try { row.setPointerCapture(event.pointerId); } catch {}
      row.classList.add("swiping");
    }
    drag.dx = Math.max(onLeft ? -120 : 0, Math.min(onRight ? 120 : 0, dx));
    row.style.transform = `translateX(${drag.dx}px)`;
    row.dataset.swipe = drag.dx >= 72 ? "right" : drag.dx <= -72 ? "left" : "";
  });
  const end = () => {
    if (!drag) return;
    const { moving, dx } = drag;
    drag = null;
    if (!moving) return;
    row.classList.remove("swiping");
    row.style.transform = "";
    delete row.dataset.swipe;
    // Смахнутая строка не открывает карточку: нажатие, которым её тянули, не клик.
    const swallow = (click) => { click.stopPropagation(); click.preventDefault(); };
    row.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => row.removeEventListener("click", swallow, { capture: true }), 400);
    if (dx >= 72) onRight?.();
    else if (dx <= -72) onLeft?.();
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", end);
}
function quickDueEl(entry, choices = [[t("сегодня"), 0], [t("завтра"), 1], [t("без срока"), null]]) {
  const wrap = node("div", undefined, `quick-due${choices.length === 1 ? " take-today" : ""}`);
  for (const [label, days] of choices) {
    const button = node("button", label, "quick-due-button");
    button.type = "button";
    button.title = days === null ? t("Снять срок") : t("Перенести на {label}", { label: label });
    button.addEventListener("click", (event) => { event.stopPropagation(); button.disabled = true; quickDue(entry, days); });
    wrap.append(button);
  }
  return wrap;
}
const tomorrowPending = new Set();
// A cancelled or failed move leaves the editor open. Keep its save callbacks
// until a successful refresh replaces that exact card content.
function preserveCardSavers() {
  const content = $("#review")?.firstElementChild;
  const body = flushCardBody, props = flushCardProps, title = flushCardTitle;
  return () => {
    if (!$("#review-dialog")?.open || $("#review")?.firstElementChild !== content) return;
    flushCardBody ||= body;
    flushCardProps ||= props;
    flushCardTitle ||= title;
  };
}
function tomorrowNotice(message, action = null) {
  if ($("#review-dialog")?.open) cardSnack(message, action ? [action] : []);
  else toast(message, action);
}
async function refreshAfterPostpone(sourceId, movedId, openId) {
  await load();
  await Promise.allSettled([
    !$("#board")?.hidden ? loadBoard() : null,
    !$("#calendar")?.hidden ? loadCalendar() : null,
  ]);
  if (openId && cardEntryId === openId && $("#review-dialog").open)
    await renderCardEntry(openId === sourceId ? movedId : openId);
  if ($("#bell-menu")?.open) renderBellPanel();
}
async function postponeOne(id, occurrence = null) {
  if (tomorrowPending.has(id)) return;
  const restoreSavers = preserveCardSavers();
  tomorrowPending.add(id);
  for (const button of document.querySelectorAll(`[data-tomorrow-id="${CSS.escape(id)}"]`)) button.disabled = true;
  try {
    const openId = $("#review-dialog")?.open ? cardEntryId : null;
    if (openId) await flushCard();
    const { entry } = await request(`/api/captures/${encodeURIComponent(id)}`);
    const repeating = Boolean(scheduleOf(entry)?.repeat);
    if (repeating && !confirm(t("Перенести только этот повтор? На завтра появится отдельное дело. Остальные повторы останутся на своих днях."))) return;
    const result = await request(`/api/captures/${encodeURIComponent(id)}/postpone`, {
      method: "POST", body: JSON.stringify({ operationId: crypto.randomUUID(), occurrence: repeating ? occurrence : null }),
    });
    await refreshAfterPostpone(id, result.captureId, openId);
    if (result.unchanged) { tomorrowNotice(t("Уже на завтра")); return; }
    tomorrowNotice(t("Перенесено на завтра"), { get label() { return t("Вернуть"); }, run: async () => {
      const currentOpen = $("#review-dialog")?.open ? cardEntryId : null;
      const restoreUndoSavers = preserveCardSavers();
      if (currentOpen) await flushCard();
      try {
        await request(`/api/captures/${encodeURIComponent(id)}/undo-postpone`, { method: "POST", body: JSON.stringify({ operationId: result.operationId }) });
        await refreshAfterPostpone(result.captureId, id, currentOpen);
        tomorrowNotice(t("Перенос отменён"));
      } catch (error) { tomorrowNotice(error.message); }
      finally { restoreUndoSavers(); }
    } });
  } catch (error) { tomorrowNotice(error.message || t("Не получилось перенести")); }
  finally {
    restoreSavers();
    tomorrowPending.delete(id);
    for (const button of document.querySelectorAll(`[data-tomorrow-id="${CSS.escape(id)}"]`)) button.disabled = button.dataset.alreadyTomorrow === "true";
  }
}
// One presentation for rows, boards, calendar blocks and nested task cards.
function tomorrowAction({ id, title, schedule = null, occurrence = null, done = false, mine = true }) {
  if (done || !mine) return null;
  const tomorrow = shiftDate(zoneDate(new Date()), 1);
  const date = schedule?.repeat ? occurrence || nextRepeatDate(schedule, zoneDate(new Date())) : schedule?.date;
  const already = date === tomorrow;
  const button = node("button", undefined, "todo-tomorrow");
  button.type = "button";
  button.dataset.tomorrowId = id;
  button.dataset.alreadyTomorrow = String(already);
  button.disabled = already || tomorrowPending.has(id);
  button.append(bindTranslation(node("span", t("завтра")), "завтра"));
  const plus = node("sup", "+1");
  plus.setAttribute("aria-hidden", "true");
  button.append(plus);
  const label = already ? t("Уже на завтра") : t("Перенести на {label}", { label: t("завтра") });
  button.title = `${label} · ${calHuman(tomorrow)}${schedule?.time ? ` · ${schedule.time}` : ""}`;
  button.setAttribute("aria-label", `${label}: ${title}`);
  button.addEventListener("pointerdown", event => { if (event.button === 0 && event.isPrimary) event.preventDefault(); });
  button.addEventListener("click", event => { event.stopPropagation(); postponeOne(id, occurrence); });
  return button;
}
function entryTomorrow(entry, occurrence = null) {
  if (!completableProjections(entry).length) return null;
  return tomorrowAction({ id: entry.id, title: titleOf(entry), schedule: scheduleOf(entry), occurrence, done: isClosed(entry), mine: entry.mine !== false && !entry.foreign });
}
// «с вчера», «с 28 сен»: с какого дня дело висит открытым.
const SHORT_MONTHS = localizedBuiltins(["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]);
function sinceLabel(date) {
  if (!date) return t("просрочено");
  if (currentDayDate && date === shiftDate(currentDayDate, -1)) return t("со вчера");
  return t("с {date}", { date: new Intl.DateTimeFormat(getLocale(), { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`)) });
}
// «0/2» у родителя, как в Todoist: подзадачи отдельными строками не стоят ни в
// списках «Сегодня» и «Сделано», ни на доске при «Подзадачи: Скрывать» — у дела
// лишь тихая метка с числом сделанных из всех. Число приходит с сервера (subtasks {done, total}); все
// сделаны — метка зелёная. Нажатие открывает карточку дела на «Подзадачах».
const SUBTASK_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2" width="8" height="3.6" rx="1.2"/><rect x="6.2" y="9.8" width="8" height="3.6" rx="1.2"/><path d="M3.8 5.6v4.2a1.8 1.8 0 0 0 1.8 1.8h.6"/></svg>';
// Число, цвет и подпись метки — из одного места: доска обновляет метку на месте,
// когда подзадачу отметили (в карточке дела или кружком её карточки).
function paintSubtaskBadge(badge, subtasks) {
  badge.classList.toggle("all-done", subtasks.done >= subtasks.total);
  badge.querySelector(".sub-badge-count").textContent = `${subtasks.done}/${subtasks.total}`;
  const words = t("Подзадачи: сделано {done} из {total}", { done: subtasks.done, total: subtasks.total });
  bindTranslation(badge, "{words}. Открыть", { words: words }, "title");
  bindTranslation(badge, "{words}. Открыть подзадачи", { words: words }, "aria-label");
}
function subtaskBadge(subtasks, open) {
  if (!subtasks?.total) return null;
  const badge = node("button", undefined, "sub-badge");
  badge.type = "button";
  const icon = node("span", undefined, "sub-badge-icon");
  icon.innerHTML = SUBTASK_GLYPH;
  badge.append(icon, node("span", undefined, "sub-badge-count"));
  paintSubtaskBadge(badge, subtasks);
  // Строка кликабельна целиком (название, клавиши): метка свой щелчок не отдаёт.
  badge.addEventListener("click", (event) => { event.stopPropagation(); open(); });
  return badge;
}
// Строка дела: кружок, название и справа тихие чипы — час или «со вчера»,
// люди, круг, кому передано. Типа, проекта и тегов у неё нет: всё, что
// записано, — дело. doneAt — минуты закрытия для строки «Закрыто».
function entryCard(entry, { overdue = false, atTime = false, on = null, doneAt = null, takeToday = false } = {}) {
  const c = entry.interpretation.classification,
    projections = completableProjections(entry),
    completed = isClosed(entry),
    card = node(
      "div",
      undefined,
      `entry dense${projections.length ? " completable" : ""}${completed ? " completed" : ""}${overdue ? " overdue" : ""}${projections.length && !completed && !overdue ? " waiting" : ""}`,
    ),
    meta = node("div", undefined, "entry-meta");
  card.dataset.captureId = entry.id;
  // Показанный день повтора — чтобы карточка из списка знала, какой экземпляр
  // закрывает её кружок.
  if (c.entities.schedule?.repeat && on && scheduledOn(entry, on)) card.dataset.occurrence = on;
  if (projections.length) {
    const label = completed ? t("Вернуть в работу") : t("Готово"),
      complete = node("button", undefined, "completion-button");
    complete.type = "button";
    complete.title = label;
    complete.setAttribute("aria-label", label);
    complete.setAttribute("aria-pressed", String(completed));
    // У повтора «Готово» — про этот экземпляр: он убирается из серии, а
    // остальные повторы живут дальше. Серия целиком закрывается в карточке.
    complete.addEventListener("click", () => {
      const occurrence = c.entities.schedule?.repeat && !completed ? (on && scheduledOn(entry, on) ? on : scheduledOn(entry, currentDayDate) ? currentDayDate : null) : null;
      // Строка зачёркивается и гаснет сразу, а не после ответа сервера: отклик
      // на нажатие должен быть под пальцем.
      if (!completed) card.classList.add("completing");
      if (occurrence) { complete.disabled = true; doneOccurrence({ id: entry.id, projectionId: projectionOfType(entry, "task")?.id || null }, occurrence).finally(() => { complete.disabled = false; }); return; }
      updateCompletion(projections, !completed, complete);
    });
    card.append(complete);
    attachRowSwipe(card, { onRight: () => complete.click(), onLeft: (overdue || takeToday) && !completed ? () => quickDue(entry, 0) : null });
  } else if (isReportedWork(entry)) {
    // Старая запись «сделал X» без дела внутри: закрывать и возвращать нечего.
    const mark = node("span", undefined, "completion-button static");
    mark.setAttribute("aria-pressed", "true");
    card.append(mark);
    card.classList.add("completed");
  }
  const title = markdownNode("button", c.summary, "entry-title", { inline: true, links: false, firstLine: true });
  title.type = "button";
  // subtasks — открыть на разделе «Подзадачи»: по метке «0/2» у названия.
  const openCard = ({ subtasks = false } = {}) => {
    // Карточка вытекает из той записи, по которой щёлкнули.
    const review = reviewFromEntry(entry);
    cardOccurrence = c.entities.schedule?.repeat && on && scheduledOn(entry, on) ? on : null;
    const list = card.closest("#todo, #journal");
    pendingCardList = list ? { label: list.id === "journal" ? t("Закрыто") : t("День"), items: rowsAsList([...list.querySelectorAll(".entry[data-capture-id]")]), id: entry.id, occurrence: card.dataset.occurrence || null } : null;
    cardScrollTarget = subtasks ? entry.id : null;
    // Запись из круга открывается перечитанной: обсуждение и исполнитель
    // меняются у другого человека, и показывать вчерашний разговор нельзя.
    if (entry.foreign || circleOf(entry)) { openSharedCard(entry.id); return; }
    showCorrection(entry, review.level === "high" ? undefined : review);
  };
  title.addEventListener("click", () => openCard());
  card.append(title);
  // Просроченное не переносят в карточке — оно решается прямо в строке.
  if (overdue && !c.entities.schedule?.repeat && !completed) meta.append(quickDueEl(entry, [[t("сегодня"), 0]]));
  // Дело из запаса берут на сегодня, не открывая карточку.
  if (takeToday && !completed) meta.append(quickDueEl(entry, [[t("на сегодня"), 0]]));
  const subs = subtaskBadge(entry.subtasks, () => openCard({ subtasks: true }));
  if (subs) meta.append(subs);
  const mark = circleOf(entry);
  if (mark) meta.append(circleChip(mark, { small: true }));
  // Чьё это дело: взятое — «от Саши», отданное — «Аня · ждёт ответа». Второе и
  // есть слежение за реализацией, только без доски со статусами.
  const assignment = entry.assignment || todayState.assignments?.[entry.id] || null;
  if (assignment && assignment.state !== "declined")
    meta.append(node("span", entry.foreign ? t("от {value1}", { value1: genitiveName(assignment.assigner?.name) || t("автора") }) : `${assignment.assignee?.name || ""} · ${assignmentWord(assignment)}`, "tag assign"));
  const due = scheduleLabel(c.entities.schedule, on);
  const repeats = c.entities.schedule?.repeat ? repeatLabel(c.entities.schedule.repeat, { until: false }) : null;
  const dueToday = c.entities.schedule?.repeat ? scheduledOn(entry, currentDayDate) : Boolean(c.entities.schedule?.date) && c.entities.schedule.date === currentDayDate;
  if (overdue && !completed) meta.append(node("span", sinceLabel(c.entities.schedule?.date), "tag due late"));
  else if (repeats && !completed) meta.append(node("span", atTime || dueToday ? repeats : due, "tag due"));
  else if (due && !atTime && !dueToday && !doneAt) meta.append(node("span", due, "tag due"));
  if (c.priority === "high") meta.append(bindTranslation(node("span", t("важно"), "tag urgent"), "важно"));
  // Скрепка с числом: по списку видно, что к записи что-то приложено.
  if (entry.attachments?.length) meta.append(node("span", `📎 ${entry.attachments.length}`, "tag files"));
  // Люди из записи — кружками с первой буквой имени.
  const people = (c.entities.people || []).filter(Boolean).slice(0, 3);
  if (people.length) {
    const faces = node("span", undefined, "entry-people");
    for (const name of people) faces.append(avatarEl({ name }, { size: "mini" }));
    meta.append(faces);
  }
  if (doneAt != null) meta.append(node("span", hm(doneAt), "tag time"));
  const tomorrow = entryTomorrow(entry, card.dataset.occurrence || null);
  if (tomorrow && doneAt == null) meta.append(tomorrow);
  card.append(meta);
  return card;
}
// ── «Сегодня»: обложка по часам, полоса дней, два ящика ──────────────────────
// Страница знает, который час: дата с фазой суток, бриф из двух-трёх фраз и
// вопрос в поле меняются утром, днём, вечером и ночью. Под полем — два ящика
// с вкладками и своей полосой дней: «Закрыто» (закрытое кружком и прошедшие
// встречи) и «День», где дела лежат вместе с календарём. Заметок здесь нет:
// любая запись — туду, а старые заметки видны в «Обзоре» и в поиске.

const circlesState = { circles: [], me: null, loading: false, tab: "chat", discussions: [] };
// Перечитывание разговоров (refreshRoomsQuietly): идёт ли, нужно ли ещё раз и
// счётчик своих правок, по которому узнаётся устаревший ответ. Объявлено здесь,
// а не у страницы кругов: переход по адресу при загрузке зовёт loadCircles
// раньше, чем исполнится её код.
const roomsRefresh = { running: false, again: false, edits: 0 };
function kcEdited() { roomsRefresh.edits += 1; }
const todayState = {
  view: 0,            // смещение дня, показанного в «Дне», от сегодняшнего
  journalView: 0,     // то же для «Закрыто»: у ящиков свои дни
  tab: null,          // открытый ящик: "journal" | "day" | null
  manual: false,      // ящик выбран рукой — фаза его не трогает
  phase: null,
  cover: null,
  calendar: null,     // /api/calendar на сегодня и завтра
  entries: [],
  done: [],     // строки «Закрыто» из /api/done на сегодня
  doneStale: true,
  doneKnownDate: null,
  todo: [],
  // Общее: полоса «к вам», взятые чужие дела, круги и метки для строк.
  inbox: [],
  inboxFolded: [],
  borrowed: [],
  waiting: [],
  circles: [],
  mutedCircles: [],
  circleMarks: {},
  assignments: {},
  cache: new Map(),   // другие дни: date → { calendar, report }
  loading: new Set(),
  placeholder: null,
  calendarStale: true,
  calendarLoading: false,
  calendarKnownDate: null,
};
function zoneMinutes(at) {
  const parts = new Intl.DateTimeFormat(getLocale(), { timeZone: getTimeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return (get("hour") % 24) * 60 + get("minute");
}
const nowMinutes = () => zoneMinutes(new Date());
const zoneDate = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: getTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
// Удаление чужого события идёт в чужой календарь: CalDAV и Google отвечают
// секундами, и всё это время плашка висела «занятой», будто приложение
// подвисло. Событие убирается с экрана сразу, а запрос летит следом. Пока он в
// пути, обновление календаря — своё или по потоку журнала — не возвращает
// событие на место: свежие списки проходят через те же правила.
const removingExternal = [];
// Ключ строки события: у события на несколько дней к id дописан день, а сервер
// всё равно читает только часть до двоеточия.
const externalKey = (id) => String(id || "").replace(/^ext:/, "").split(":")[0];
function pruneRemovedExternal(calendar) {
  if (calendar?.external?.length && removingExternal.length)
    calendar.external = calendar.external.filter((item) => !removingExternal.some((match) => match(item)));
  return calendar;
}
// Прячет событие всюду, где оно лежит: сетка календаря, «Сегодня» и уже
// загруженные другие дни. Возвращает конец работы — правило забывается, когда
// сервер ответил.
function removeExternalFromView(match) {
  removingExternal.push(match);
  for (const owner of [calState.data, todayState.calendar, ...[...todayState.cache.values()].map((day) => day?.calendar)])
    if (owner?.external) owner.external = owner.external.filter((item) => !match(item));
  if (calState.data) renderCalendar();
  renderToday();
  return () => { const at = removingExternal.indexOf(match); if (at >= 0) removingExternal.splice(at, 1); };
}
// Календарь на сегодня, отложенный на время чужой страницы, добирается при
// первой отрисовке «Сегодня».
async function refreshTodayCalendar() {
  if (todayState.calendarLoading || !currentDayDate) return;
  const date = currentDayDate, timeZone = getTimeZone(), generation = dayTimeZoneGeneration, loadToken = dayLoadToken;
  todayState.calendarLoading = true;
  try {
    const calendar = await request(`/api/calendar?from=${date}&to=${shiftDate(date, 1)}`);
    if (generation !== dayTimeZoneGeneration || loadToken !== dayLoadToken || timeZone !== getTimeZone() || date !== currentDayDate) return;
    todayState.calendar = pruneRemovedExternal(calendar);
    todayState.calendarKnownDate = date;
  } catch { /* список остаётся прежним */ }
  finally { if (generation === dayTimeZoneGeneration && loadToken === dayLoadToken) todayState.calendarLoading = false; }
  if (generation !== dayTimeZoneGeneration || loadToken !== dayLoadToken || date !== currentDayDate) return;
  todayState.calendarStale = false;
  renderToday();
}
async function refreshTodayDone() {
  if (todayState.doneLoading || !currentDayDate) return;
  const date = currentDayDate, timeZone = getTimeZone(), generation = dayTimeZoneGeneration, loadToken = dayLoadToken;
  todayState.doneLoading = true;
  try {
    const closed = await request(`/api/done?from=${date}&to=${date}`);
    if (generation !== dayTimeZoneGeneration || loadToken !== dayLoadToken || timeZone !== getTimeZone() || date !== currentDayDate) return;
    todayState.done = (closed?.days || []).flatMap((group) => group.items).filter((item) => !item.auto);
    todayState.doneKnownDate = date;
  } catch { /* список остаётся прежним */ }
  finally { if (generation === dayTimeZoneGeneration && loadToken === dayLoadToken) todayState.doneLoading = false; }
  if (generation !== dayTimeZoneGeneration || loadToken !== dayLoadToken || date !== currentDayDate) return;
  todayState.doneStale = false;
  renderToday();
}
let dayLoadToken = 0;
let dayTimeZoneGeneration = 0;
const scheduleOf = (entry) => entry.interpretation.classification.entities.schedule || null;
// Повтор срока: выпадает ли экземпляр на дату. Зеркало серверного разбора
// (server/repeat.js): день, неделя, месяц по числу, год — с шагом, «до» и
// убранными экземплярами.
function calDayDiff(from, to) { return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000); }
function repeatOccursOn(schedule, date) {
  const rule = schedule?.repeat;
  if (!rule || !schedule.date || !date || date < schedule.date) return false;
  if (rule.until && date > rule.until) return false;
  if ((schedule.skip || []).includes(date)) return false;
  const interval = rule.interval || 1;
  const days = calDayDiff(schedule.date, date);
  const base = new Date(`${schedule.date}T12:00:00Z`), target = new Date(`${date}T12:00:00Z`);
  if (rule.freq === "daily") return days % interval === 0;
  if (rule.freq === "weekly") return days % 7 === 0 && (days / 7) % interval === 0;
  if (rule.freq === "monthly") return target.getUTCDate() === base.getUTCDate() && ((target.getUTCFullYear() - base.getUTCFullYear()) * 12 + target.getUTCMonth() - base.getUTCMonth()) % interval === 0;
  if (rule.freq === "yearly") return target.getUTCDate() === base.getUTCDate() && target.getUTCMonth() === base.getUTCMonth() && (target.getUTCFullYear() - base.getUTCFullYear()) % interval === 0;
  return false;
}
function scheduledOn(entry, date) { const schedule = scheduleOf(entry); return Boolean(schedule?.date) && (schedule.repeat ? repeatOccursOn(schedule, date) : schedule.date === date); }
// Ближайший экземпляр повтора не раньше даты — для подписи срока.
function nextRepeatDate(schedule, from) {
  if (!schedule?.repeat || !schedule.date) return null;
  let day = from < schedule.date ? schedule.date : from;
  for (let step = 0; step < 800; step += 1) { if (repeatOccursOn(schedule, day)) return day; day = shiftDate(day, 1); }
  return null;
}
const REPEAT_WORDS = {
  get daily() { return t("каждый день"); },
  get weekly() { return t("каждую неделю"); },
  get monthly() { return t("каждый месяц"); },
  get yearly() { return t("каждый год"); },
};
function repeatLabel(rule, { until = true } = {}) {
  if (!rule?.freq || !REPEAT_WORDS[rule.freq]) return null;
  const count = rule.interval || 1;
  const sources = { daily: "каждые {count} дня", weekly: "каждые {count} недели", monthly: "каждые {count} месяца", yearly: "каждые {count} года" };
  let text;
  if (count === 1) text = REPEAT_WORDS[rule.freq];
  else if (getLocale() === "ru") {
    const category = new Intl.PluralRules("ru").select(count);
    const words = { daily: ["день", "дня", "дней"], weekly: ["неделю", "недели", "недель"], monthly: ["месяц", "месяца", "месяцев"], yearly: ["год", "года", "лет"] }[rule.freq];
    const every = category === "one" ? rule.freq === "weekly" ? "каждую" : "каждый" : "каждые";
    text = `${every} ${count} ${category === "one" ? words[0] : category === "few" ? words[1] : words[2]}`;
  } else text = t(sources[rule.freq], { count });
  if (until && rule.until) text += t(" до {date}", { date: calHuman(rule.until) });
  return text;
}
// «Готово» и «удалить только этот повтор» у своей серии — одно и то же:
// экземпляр убирается из серии уточнением срока (schedule.skip), остальные
// повторы живут дальше. «Вернуть» — то же уточнение без этой даты. Метка
// времени в теле — чтобы повторное «убрать» после «вернуть» не сочли
// повтором того же запроса.
function scheduleTarget(schedule) { return { baseDate: schedule?.date || null, time: schedule?.time || null, end: schedule?.end || null, skip: schedule?.skip || [] }; }
async function skipOccurrence(target, date, { announce = true } = {}) {
  let { id, baseDate, time = null, end = null, skip = [] } = target;
  try {
    if (!baseDate) {
      const { entry } = await request(`/api/captures/${id}`);
      ({ baseDate, time, end, skip } = scheduleTarget(entry.interpretation.classification.entities.schedule));
    }
    const body = (dates) => JSON.stringify({ patch: { schedule: { date: baseDate, time, ...(time && end ? { end } : {}), skip: dates } }, at: Date.now() });
    const without = skip.filter((day) => day !== date);
    await request(`/api/captures/${id}/corrections`, { method: "POST", body: body([...without, date]) });
    await refreshAfterSkip();
    if (announce) toast(t("Повтор {value1} убран, серия осталась", { value1: calHuman(date) }), { get label() { return t("Вернуть"); }, run: async () => {
      try { await request(`/api/captures/${id}/corrections`, { method: "POST", body: body(without) }); await refreshAfterSkip(); toast(t("Повтор возвращён")); }
      catch (error) { toast(error.message); }
    } });
  } catch (error) { toast(error.message); }
}
// Кружок у повтора: экземпляр закрывается одним запросом. Сервер пишет событие
// «экземпляр закрыт» (оно попадает в «Закрыто» на «Сегодня» и на страницу «Сделано») и убирает день из
// серии, остальные повторы живут дальше. «Вернуть» снимает событие и возвращает день.
async function doneOccurrence(target, date, { announce = true } = {}) {
  let { id, projectionId = null } = target;
  try {
    if (!projectionId) {
      const { entry } = await request(`/api/captures/${id}`);
      projectionId = projectionOfType(entry, "task")?.id || null;
    }
    if (!projectionId) throw new Error(t("У записи нет дела"));
    await request(`/api/projections/${projectionId}/complete`, { method: "POST", body: JSON.stringify({ occurrence: date }) });
    await refreshAfterSkip();
    if (announce) toast(t("Готово на {value1}, серия осталась", { value1: calHuman(date) }), { get label() { return t("Вернуть"); }, run: async () => {
      try {
        const { entry } = await request(`/api/captures/${id}`);
        await request(`/api/projections/${projectionOfType(entry, "task")?.id || projectionId}/undo-complete`, { method: "POST", body: JSON.stringify({ occurrence: date }) });
        await refreshAfterSkip();
        toast(t("Повтор возвращён"));
      } catch (error) { toast(error.message); }
    } });
  } catch (error) { toast(error.message); }
}
async function refreshAfterSkip() {
  await load();
  if (!$("#calendar")?.hidden) await loadCalendar();
  if (!$("#board")?.hidden) loadBoard();
}
const titleOf = (entry) => (entry.interpretation.classification.summary || entry.raw || "").split("\n")[0];
const calendarConnected = () => Boolean(todayState.calendar?.accounts?.some((account) => !account.disabled));
// Календарь в режиме «только занятость» отдаёт события без названия.
const busyOnly = (item) => item.title === "Занято" && item.readOnly;
// Встречи дня для брифа: чужие события по часам и свои встречи со временем.
function todayMeetings() {
  const today = currentDayDate;
  const external = (todayState.calendar?.external || []).filter((item) => item.date === today && !item.allDay && item.time);
  const defaults = todayState.calendar?.defaults?.meetingMinutes || 30;
  return [
    ...external.map((item) => ({ id: item.id, title: item.title, start: minutesOf(item.time), end: minutesOf(item.end) ?? minutesOf(item.time) + defaults, joinUrl: safeExternalUrl(item.joinUrl), busy: busyOnly(item) })),
    ...todayState.todo
      .filter((entry) => isActiveMeeting(entry) && scheduledOn(entry, today) && scheduleOf(entry)?.time)
      .map((entry) => ({ id: entry.id, title: titleOf(entry), start: minutesOf(scheduleOf(entry).time), end: minutesOf(scheduleOf(entry).end) ?? minutesOf(scheduleOf(entry).time) + defaults, joinUrl: null, busy: false })),
  ].filter((meeting) => meeting.start != null);
}
// Дело, которое можно перенести на завтра одним движением: открытая задача со
// сроком сегодня или раньше. Повтор не в счёт — серию двигают в карточке, — и
// взятое чужое дело тоже: срок у него у автора.
function canPostpone(entry, today = currentDayDate) {
  const schedule = scheduleOf(entry);
  return isActiveTask(entry) && !entry.foreign && entry.mine !== false && Boolean(schedule?.date) && !schedule.repeat && schedule.date <= today;
}
const unfinishedTasks = () => todayState.todo.filter((entry) => canPostpone(entry));
function todayTasks() {
  const today = currentDayDate;
  const todays = todayState.todo.filter((entry) => scheduledOn(entry, today));
  return {
    late: todayState.todo.filter((entry) => isOverdue(entry, today)).length,
    unfinished: unfinishedTasks().length,
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
  if (currentDayDate && currentDayDate !== data.date) {
    if (calState.anchor === currentDayDate) calState.anchor = data.date;
    todayState.phase = null;
    todayState.manual = false;
  }
  currentDayDate = data.date;
  // Взятое чужое дело живёт в дне как своё: оно и есть своё — человек его взял.
  todayState.inbox = data.inbox || [];
  todayState.inboxFolded = data.inboxFolded || [];
  todayState.circles = data.circles || [];
  todayState.mutedCircles = data.mutedCircles || [];
  todayState.circleMarks = data.circleMarks || {};
  todayState.borrowed = data.borrowed || [];
  todayState.waiting = data.waiting || [];
  todayState.assignments = data.assignments || {};
  // Дела выключенного круга уходят из списков — и свои, и взятые: именно это
  // обещает переключатель «не показывать круг в дне».
  const muted = new Set((data.circles || []).filter((circle) => circle.muted).map((circle) => circle.id));
  const all = uniqueEntries([data.entries, data.day, data.upcoming, data.attention, data.borrowed])
    .filter((entry) => !muted.has((entry.circle || data.circleMarks?.[entry.id])?.id))
    .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  todayState.entries = all;
  todayState.todo = all
    .filter((entry) => (isActiveTask(entry) || isActiveMeeting(entry) || needsClarification(entry)) && !isReportedWork(entry))
    .sort((left, right) => todoOrder(left, data.date) - todoOrder(right, data.date));
  renderToday();
}
function renderToday() {
  if (!currentDayDate) return;
  // Перерисовка не сбивает фокус с записи: открыли её из брифа или дошли до неё
  // клавиатурой — после живого обновления фокус на той же записи в том же ящике,
  // а не на странице целиком.
  const active = document.activeElement;
  const keep = active?.dataset?.captureId && active.closest(".drawers") ? { id: active.dataset.captureId, drawer: active.closest(".drawer")?.id } : null;
  const navKeep = active?.matches?.(".daynav-step, .daynav-today") && active.closest(".drawer")
    ? { drawer: active.closest(".drawer").id, selector: active.matches(".daynav-today") ? ".daynav-today" : `[data-step="${active.dataset.step}"]` }
    : null;
  if (todayState.calendarStale && !$("#today")?.hidden) refreshTodayCalendar();
  if (todayState.doneStale && !$("#today")?.hidden) refreshTodayDone();
  const minutes = nowMinutes();
  const phase = phaseOf({ minutes, weekend: isWeekend(currentDayDate) });
  const cover = coverFor({
    phase,
    minutes,
    meetings: todayMeetings(),
    tasks: todayTasks(),
    doneCount: doneRows()?.length || 0,
    tomorrow: tomorrowInfo(),
    calendar: calendarConnected(),
  });
  // Пока календарь или закрытые дела ещё неизвестны, не утверждаем, что
  // календарь отключён, встреч нет или за день ничего не закрыто.
  cover.provisional = (todayState.calendarLoading && todayState.calendarKnownDate !== currentDayDate)
    || (todayState.doneLoading && todayState.doneKnownDate !== currentDayDate);
  if (cover.provisional) cover.brief = [t("Загружаю…")];
  const finishingProvisional = todayState.cover?.provisional && !cover.provisional;
  todayState.cover = cover;
  // Новая фаза ставит свой ящик один раз; дальше — как решил человек.
  if (todayState.phase !== phase) {
    todayState.phase = phase;
    if (!(finishingProvisional && todayState.manual) && !recallTab(phase)) {
      todayState.manual = false;
      if (todayState.view === 0) todayState.tab = cover.tab;
    }
  }
  applyRequestedTodayDate();
  applyCoverComposer(cover);
  paintCover(cover, currentDayDate);
  const viewDate = shiftDate(currentDayDate, todayState.view);
  const journalDate = shiftDate(currentDayDate, todayState.journalView);
  paintTabs(viewDate, journalDate);
  paintDockBadges();
  paintJournal(journalDate);
  paintDayList(viewDate);
  if (navKeep && !active.isConnected) {
    const nav = document.querySelector(`#${navKeep.drawer} .daynav`);
    const target = nav?.querySelector(navKeep.selector) || nav?.querySelector(".daynav-current");
    if (target) {
      if (!target.matches("button")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }
  if (keep && !active.isConnected) {
    // Строку закрыли с клавиатуры — фокус встаёт на следующую, а не теряется.
    const find = (id) => id && keep.drawer && document.querySelector(`#${keep.drawer} [data-capture-id="${CSS.escape(id)}"]`);
    const again = find(keep.id) || (listKeys.after?.from === keep.id ? find(listKeys.after.to) : null);
    if (again) {
      if (!again.hasAttribute("tabindex")) again.tabIndex = -1;
      again.focus({ preventScroll: true });
    }
  }
}
// Первый шаг. Пустой журнал ничего о себе не рассказывает: поле есть, а что в
// него писать — человек не знает, и уходит, ничего не записав. Три примера
// подставляются прямо в поле, чтобы первая запись случилась его руками.
// С первой же записью блок исчезает навсегда.
const FIRST_STEPS = localizedBuiltins([
  "Завтра в 11 созвон с Аней по проекту",
  "Нужно оплатить хостинг до пятницы",
  "Созвонились по проекту, решили начать с детектора",
]);
function firstStepNode() {
  const box = node("div", undefined, "today-start");
  box.append(bindTranslation(node("p", t("Журнал пустой. Напишите своими словами что угодно — разберётся само. Например:"), "start-lead"), "Журнал пустой. Напишите своими словами что угодно — разберётся само. Например:"));
  const row = node("div", undefined, "start-row");
  for (const text of FIRST_STEPS) {
    const button = node("button", text, "start-chip");
    button.type = "button";
    button.addEventListener("click", () => prefillCapture(text));
    row.append(button);
  }
  box.append(row);
  // Кроме примеров — обучение: прогоны показывают, как всё устроено, руками.
  const help = bindTranslation(node("a", t("Как пользоваться →"), "start-help"), "Как пользоваться →");
  help.href = "#guide";
  box.append(help);
  return box;
}
// «Как пользоваться» собирается заново при каждом открытии: галочки
// пройденного живут в браузере и меняются в прогоне. «Попробовать
// по-настоящему» ведёт на «Сегодня» и подставляет фразу шага в настоящее поле,
// как пример первого шага; «Выйти из обучения» — просто на «Сегодня».
function renderGuide(initial, initialDemo = false) {
  mountGuide($("#guide"), {
    initial,
    initialDemo,
    onTry: (text) => { location.hash = "#today"; updatePageFromHash(); prefillCapture(text); },
    onGo: (hash) => { location.hash = hash; },
    onExit: () => { location.hash = "#today"; },
  });
}
// Вопрос в поле — по фазе суток, пока в поле пусто: страница не меняется под
// руками.
function applyCoverComposer(cover = todayState.cover) {
  if (!cover || typeof captureField === "undefined") return;
  todayState.placeholder = cover.placeholder;
  captureField.setPlaceholder(cover.placeholder);
}
function paintCover(cover, date) {
  // Обложка рассказывает про день, только пока все ящики закрыты. Раскрытый
  // ящик говорит сам: дату — своей полосой дней, дела и встречи — списком, —
  // и страница начинала повторяться. Место у даты и брифа при этом прежнее.
  const covered = todayState.tab === null;
  const dateEl = $("#today-date");
  dateEl.hidden = !covered;
  clear(dateEl);
  dateEl.append(document.createTextNode(`${longDate(date)} · `), node("span", PHASE_NAMES[cover.phase], `today-phase ${cover.phase}`));
  const brief = $("#today-brief");
  brief.hidden = !covered;
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
    } else if (part.btn) {
      // Вечернее «Не закрыто 3 дела со сроком — перенести на завтра?»: число
      // показывает дела, вопрос их переносит.
      const button = node("button", part.btn.text, "linkish");
      button.type = "button";
      button.dataset.act = part.btn.act;
      button.addEventListener("click", () => (part.btn.act === "show" ? showUnfinished() : postponeToTomorrow(unfinishedTasks(), button)));
      brief.append(button);
    }
  }
}
// Ящик открывается рукой: то же, что щелчок по вкладке, только без «закрыть
// открытый». Любое переключение возвращает все дни на сегодня: день, куда человек
// ушёл стрелками, не тянется за ним в соседний ящик и не ждёт его в закрытом.
function pickTodayTab(key) {
  todayState.tab = key;
  todayState.manual = true;
  todayState.view = 0;
  todayState.journalView = 0;
  rememberTab();
  renderToday();
}
// «3 дела» в вечерней фразе: открыть «День», подвести к первой полке с незакрытым
// (просрочено, а если его нет — на сегодня) и на секунду подсветить эти строки.
function showUnfinished() {
  pickTodayTab("day");
  const ids = new Set(unfinishedTasks().map((entry) => entry.id));
  const rowsNow = () => [...$("#todo").querySelectorAll(".entry[data-capture-id]")].filter((row) => ids.has(row.dataset.captureId));
  const shelf = $("#todo .day-group.late") || $("#todo .day-group.today");
  (shelf?.closest(".day-head") || shelf || rowsNow()[0])?.scrollIntoView({ block: "start", behavior: motionAllowed() ? "smooth" : "auto" });
  // Фон вспыхивает, когда полка уже на месте, а не пока к ней едет прокрутка, и
  // гаснет плавно: класс ставится и снимается, а переходом занимается CSS. Строки
  // ищутся заново в момент вспышки — список могли перерисовать, пока ехала прокрутка.
  const delay = motionAllowed() ? 350 : 0;
  setTimeout(() => { for (const row of rowsNow()) row.classList.add("flash"); }, delay);
  setTimeout(() => { for (const row of rowsNow()) row.classList.remove("flash"); }, delay + 1300);
}
// Перенос группы дел на завтра одним нажатием — из вечерней фразы обложки и с
// полок «просрочено» и «на сегодня». Двигаются только те, что можно (canPostpone):
// срок меняется поправкой, как при переносе в карточке, время и конец остаются.
// «Вернуть» кладёт прежние сроки теми же поправками. Пока запросы идут, кнопка
// не нажимается.
async function postponeToTomorrow(entries, button = null) {
  const today = currentDayDate || zoneDate(new Date());
  const tomorrow = shiftDate(today, 1);
  const tasks = entries.filter((entry) => canPostpone(entry, today));
  if (!tasks.length) return;
  const put = (id, when) => request(`/api/captures/${id}/corrections`, {
    method: "POST",
    // метка времени в теле — чтобы перенос туда и обратно не принимался за повтор одного и того же
    body: JSON.stringify({ at: Date.now(), patch: { schedule: { date: when.date, time: when.time || null, ...(when.time && when.end ? { end: when.end } : {}) } } }),
  });
  if (button) button.disabled = true;
  const moved = [];
  let failure = null;
  try {
    for (const entry of tasks) {
      const before = scheduleOf(entry);
      try {
        await put(entry.id, { date: tomorrow, time: before.time, end: before.end });
        moved.push({ id: entry.id, before: { date: before.date, time: before.time, end: before.end } });
      } catch (error) { failure = error; }
    }
    if (moved.length)
      toast(t("Перенесено на завтра: {length}{value2}", { length: moved.length, value2: failure ? t(" из {value1}", { value1: tasks.length }) : "" }), { get label() { return t("Вернуть"); }, run: async () => {
        try {
          for (const item of moved) await put(item.id, item.before);
          toast(t("Сроки вернулись"));
          await load();
          refreshOtherViews();
        } catch (error) { toast(error.message); }
      } });
    else toast(failure?.message || t("Не получилось перенести"));
    await load();
    refreshOtherViews();
  } finally {
    if (button) button.disabled = false;
  }
}
// Стрелки по дням живут внутри каждого ящика: слева предыдущий день, справа
// следующий, по центру показанный. У каждого ящика свой день; обложка
// всегда про сегодня. Ящик, открытый или закрытый рукой, сбрасывает все дни
// на сегодняшний.
function ownEntriesFor(date) {
  return todayState.entries.filter((entry) =>
    scheduledOn(entry, date) && !isReportedWork(entry)
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
    bindTranslation(button, "{value1} день, {value2}", { value1: delta < 0 ? t("Предыдущий") : t("Следующий"), value2: longDate(target) }, "aria-label");
    const parts = [node("i", delta < 0 ? "‹" : "›", "daynav-arrow"), node("span", shortDate(target), "daynav-date")];
    if (delta > 0) parts.reverse();
    button.append(...parts);
    button.addEventListener("click", () => onView(view + delta));
    return button;
  };
  const current = node("div", undefined, "daynav-current");
  current.append(node("b", longDate(date)));
  if (date === currentDayDate) current.append(bindTranslation(node("span", t("сегодня"), "daynav-mark"), "сегодня"));
  else {
    const back = bindTranslation(node("button", t("сегодня"), "daynav-today"), "сегодня");
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
    // Дела в шапке — сегодняшние, как в утренней сводке: со сроком сегодня и
    // ждущие уточнения. Запас без срока считается у своей полки.
    const todays = todayState.todo.filter((entry) => !isActiveMeeting(entry) && todoOrder(entry, date) > 0 && todoOrder(entry, date) <= 2);
    const allDay = (todayState.calendar?.external || []).filter((item) => item.date === date && item.allDay).length;
    const meetings = todayMeetings().length + allDay;
    if (calendarConnected() || meetings) parts.push(plural(meetings, MEETINGS));
    parts.push(plural(todays.length, DEALS));
    const late = todayState.todo.filter((entry) => isOverdue(entry, date)).length;
    wrap.append(document.createTextNode(parts.join(" · ")));
    if (late) wrap.append(document.createTextNode(" · "), bindTranslation(node("em", t("{late} просрочено", { late: late })), "{late} просрочено", { late: late }));
    return wrap;
  }
  const own = ownEntriesFor(date).filter((entry) => !isClosed(entry));
  const meetings = externalFor(date).length + own.filter(isActiveMeeting).length;
  if (calendarConnected() || meetings) parts.push(plural(meetings, MEETINGS));
  parts.push(plural(own.filter((entry) => !isActiveMeeting(entry)).length, DEALS));
  wrap.append(document.createTextNode(parts.join(" · ")));
  return wrap;
}
// Бейджи дока — те же числа, что в вкладках «Сделано N / День N дел» на «Сегодня»:
// сколько закрыто сегодня и сколько дел на сегодня. Ноль — бейдж скрыт.
function paintDockBadges() {
  const done = doneRows()?.length || 0;
  const todays = todayState.todo.filter((entry) => !isActiveMeeting(entry) && todoOrder(entry, currentDayDate) > 0 && todoOrder(entry, currentDayDate) <= 2).length;
  const day = document.querySelector('.dock-item > a[href="#calendar"]');
  if (day && currentDayDate) day.dataset.day = String(Number(currentDayDate.slice(8, 10)));
  for (const [id, count] of [["dock-badge-done", done], ["dock-badge-today", todays]]) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.hidden = !count;
    badge.textContent = count > 99 ? "99+" : String(count);
  }
}
const DRAWER_PANELS = { journal: "journal", day: "todo" };
function paintTabs(date, journalDate) {
  const host = $("#today-tabs");
  const today = date === currentDayDate, journalToday = journalDate === currentDayDate;
  const doneList = doneRows(journalDate);
  const doneCount = doneList ? String(doneList.length) : "…";
  // «День · Закрыто»: день слева, закрытое справа. Внутри ящик по-прежнему journal
  // (#tab-journal, #journal, journalView) — называется он «Закрыто», а «Сделано» —
  // пункт шапки и страница недели.
  const tabs = [
    ["day", today ? t("День") : t("День {value1}", { value1: shortDate(date) }), dayCountNode(date)],
    ["journal", journalToday ? t("Закрыто") : t("Закрыто {value1}", { value1: shortDate(journalDate) }), node("b", doneCount)],
  ];
  for (const [key, label, count] of tabs) {
    let button = host.querySelector(`#tab-${key}`);
    if (!button) {
      button = node("button", undefined, "drawer-tab");
      button.type = "button";
      button.id = `tab-${key}`;
      button.append(node("span", undefined, "drawer-tab-label"), key === "day" ? node("span", undefined, "drawer-count") : node("b"));
      // Повторный щелчок по открытой вкладке закрывает ящик.
      button.addEventListener("click", () => pickTodayTab(todayState.tab === key ? null : key));
      host.append(button);
    }
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(todayState.tab === key));
    button.setAttribute("aria-controls", DRAWER_PANELS[key]);
    button.querySelector(".drawer-tab-label").textContent = label;
    const currentCount = button.lastElementChild;
    // Узлы самой кнопки остаются на месте: поздний ответ календаря не сбивает
    // фокус и не уничтожает цель pointerdown до pointerup.
    const next = [...count.childNodes];
    for (let i = 0; i < next.length; i += 1) {
      const existing = currentCount.childNodes[i], fresh = next[i];
      if (!existing) currentCount.append(fresh);
      else if (existing.nodeType !== fresh.nodeType || existing.nodeName !== fresh.nodeName) existing.replaceWith(fresh);
      else if (existing.nodeType === Node.TEXT_NODE) existing.nodeValue = fresh.nodeValue;
      else existing.textContent = fresh.textContent;
    }
    while (currentCount.childNodes.length > next.length) currentCount.lastChild.remove();
  }
  for (const [key, panel] of Object.entries(DRAWER_PANELS)) $(`#${panel}`).hidden = todayState.tab !== key;
}
// Строка с временем слева: карточка записи или чужое событие.
function rowWithTime(time, child, className = "") {
  const row = node("div", undefined, `day-row ${className}`.trim());
  row.append(node("span", time, "day-time"), child);
  return row;
}
// Текст из примера или из гида ложится в поле, дальше пишет человек.
function prefillCapture(text) {
  captureField.setValue(text, { caretToEnd: true });
  $("#capture-form").scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
  captureField.focus();
}
// Конец события: свой, а без него — начало плюс обычная длина встречи.
function eventFinish(item) {
  const start = minutesOf(item.time), end = minutesOf(item.end);
  return end ?? (start == null ? null : start + (todayState.calendar?.defaults?.meetingMinutes || 30));
}
// Встреча из календаря, которая уже прошла: в «Дне» она остаётся с пометкой
// «прошла», а в «Закрыто» появляется сама. Событие на весь день, занятость и
// отказ встречами не считаются.
function eventEnded(item, minutes, date = currentDayDate) {
  if (item.allDay || !item.time || busyOnly(item) || item.me?.status === "declined") return false;
  if (date < currentDayDate) return true;
  if (date > currentDayDate) return false;
  const finish = eventFinish(item);
  return finish != null && minutes >= finish;
}
function eventRow(item, { minutes = null, today = false, pastDay = false } = {}) {
  const box = node("div", undefined, "day-event");
  const dot = node("i", undefined, "cal-dot");
  if (item.color) dot.style.background = item.color;
  const meta = node("span", undefined, "day-event-meta");
  const actions = node("span", undefined, "day-event-actions");
  const start = minutesOf(item.time);
  const finish = eventFinish(item);
  let className = "external";
  if (item.allDay) meta.append(bindTranslation(node("span", t("весь день"), "tag"), "весь день"));
  else if (today && start != null) {
    const running = minutes >= start && minutes < finish;
    const soon = !running && start > minutes && start - minutes <= 10;
    if (running) { className += " now"; meta.append(bindTranslation(node("span", t("идёт · до {value1}", { value1: hm(finish) }), "tag now"), "идёт · до {value1}", { value1: hm(finish) })); }
    else if (soon) meta.append(bindTranslation(node("span", t("через {value1} мин", { value1: start - minutes }), "tag soon"), "через {value1} мин", { value1: start - minutes }));
    else if (minutes >= finish) { className += " past"; meta.append(bindTranslation(node("span", t("прошла"), "tag"), "прошла")); }
    else meta.append(bindTranslation(node("span", t("через {value1}", { value1: duration(start - minutes) }), "tag"), "через {value1}", { value1: duration(start - minutes) }));
    if (safeExternalUrl(item.joinUrl) && (running || soon)) {
      const join = bindTranslation(node("a", t("Присоединиться"), "day-join"), "Присоединиться");
      join.href = safeExternalUrl(item.joinUrl);
      join.target = "_blank";
      join.rel = "noopener";
      actions.append(join);
    }
  } else if (pastDay) {
    className += " past";
    if (start != null) meta.append(bindTranslation(node("span", t("прошла"), "tag"), "прошла"));
  } else if (item.end) meta.append(bindTranslation(node("span", t("до {end}", { end: item.end }), "tag"), "до {end}", { end: item.end }));
  if (item.me?.status === "needs-action" && !pastDay) {
    const rsvp = bindTranslation(node("a", t("ответить?"), "tag warm"), "ответить?");
    rsvp.href = "#calendar";
    meta.append(rsvp);
  }
  if (item.calendarName) meta.append(node("span", item.calendarName, "day-event-cal"));
  box.append(dot, node("span", item.title, "day-event-title"), meta);
  if (actions.childNodes.length) box.append(actions);
  return rowWithTime(item.allDay ? t("день") : item.time, box, className);
}
function nowRow(minutes, meetings) {
  const next = meetings.find((meeting) => meeting.start > minutes) || null;
  const text = next ? t("сейчас · свободно {value1} — в {value2} {title}", { value1: duration(next.start - minutes), value2: hm(next.start), title: next.title }) : t("сейчас · встреч больше нет");
  return rowWithTime(hm(minutes), node("span", text, "day-now-text"), "now-mark");
}
function appendMore(container, hidden) {
  if (hidden <= 0) return;
  const more = bindTranslation(node("a", t("Ещё {hidden} — весь список →", { hidden: hidden }), "preview-more"), "Ещё {hidden} — весь список →", { hidden: hidden });
  more.href = "#board";
  // Весь список — это доска без фильтра: с умолчанием «сегодня» на ней не оказалось
  // бы как раз тех дел, о которых говорит ссылка.
  more.addEventListener("click", () => { boardState.filter = []; boardRememberFilter(); });
  container.append(more);
}
// ── круги на «Сегодня» ──
// Общее приходит в тот же день, где человек и так стоит каждое утро: полоса
// «к вам» над списком (просьбы и призывы одной лентой), взятые чужие дела —
// обычными строками с меткой круга, отданное — счётчиком в хвосте. Переключателя
// пространств нет: день у человека один.
const CIRCLE_TONES = { violet: "violet", blue: "blue", teal: "teal", orange: "orange", pink: "pink", red: "red" };
// Круглый значок человека: буква имени. Рисуется одним помощником — где бы
// человек ни появился (карточка, круг, разговор, «я жду»), он выглядит
// одинаково, и менять это придётся в одном месте.
function avatarEl(person, { size = "" } = {}) {
  const initial = person?.initial || (person?.name || "").slice(0, 1).toUpperCase() || "?";
  const avatar = node("i", initial, `ava${size ? ` ${size}` : ""}`);
  if (person?.name) avatar.title = person.name;
  return pictureInto(avatar, person?.avatar);
}
// Лицо — картинкой поверх буквы: пока грузится или если не загрузилось,
// видна буква, и пустого кружка не бывает.
function pictureInto(holder, url) {
  if (!url) return holder;
  const picture = document.createElement("img");
  picture.className = "ava-picture";
  picture.alt = "";
  picture.decoding = "async";
  picture.addEventListener("error", () => picture.remove());
  picture.src = url;
  holder.append(picture);
  return holder;
}
function circleChip(circle, { small = false } = {}) {
  const chip = node("span", undefined, `tag circle${small ? " small" : ""}`);
  chip.append(node("i", undefined, `circle-dot ${CIRCLE_TONES[circle.color] || "violet"}`), node("span", circle.name));
  bindTranslation(chip, "Круг «{name}»", { name: circle.name }, "title");
  return chip;
}
const circleOf = (entry) => entry.circle || todayState.circleMarks?.[entry.id] || null;
const ASSIGNMENT_WORDS = { get pending() { return t("ждёт ответа"); }, get accepted() { return t("взято"); }, get declined() { return t("отказ"); }, get done() { return t("сделано"); } };
const assignmentWord = (assignment) => ASSIGNMENT_WORDS[assignment.state] || assignment.state;
// «От Саши», «от Ани»: имя в строке стоит в родительном падеже, иначе фраза
// читается как заголовок таблицы. Правило простое и честное — хвост имени;
// имя, которое не склоняется («Отто», «Мэри»), остаётся как есть.
function genitiveName(name) {
  const value = String(name || "").trim();
  if (!value || getLocale() !== "ru") return value;
  const last = value.slice(-1).toLowerCase();
  if (last === "ь" || last === "й") return `${value.slice(0, -1)}я`;
  if (last === "я") return `${value.slice(0, -1)}и`;
  if (last === "а") return `${value.slice(0, -1)}${"гкхжшчщ".includes(value.slice(-2, -1).toLowerCase()) ? "и" : "ы"}`;
  if ("оеиуыэю".includes(last)) return value;
  return `${value}а`;
}
async function respondRequest(row, take, button) {
  const reason = take ? null : (prompt(t("Почему не вы? Можно не отвечать — причина уйдёт автору.")) ?? "").trim();
  if (button) button.disabled = true;
  try {
    await request(`/api/assignments/${row.id}/respond`, { method: "POST", body: JSON.stringify({ take, ...(reason ? { reason } : {}) }) });
    toast(take ? t("Взяли: дело в вашем дне") : t("Вернули автору"));
    await load();
  } catch (error) {
    if (button) button.disabled = false;
    toast(error.message || t("Не получилось ответить"));
  }
}
function inboxRow(row) {
  const element = node("div", undefined, `inbox-row ${row.kind}`);
  const mark = node("span", undefined, "inbox-mark");
  mark.append(node("i", undefined, row.kind === "call" ? "inbox-bubble" : "inbox-circle"));
  const main = node("div", undefined, "inbox-main");
  const label = row.kind === "request" ? row.title
    : row.kind === "circle" ? t("{value1} добавил{value2} в круг «{name}»", { value1: row.from?.name || t("Вас"), value2: row.from ? "" : t("и"), name: row.circle.name })
    : t("{name} зовёт: «{value2}»", { name: row.from.name, value2: row.kind === "chat" ? row.title : row.body });
  const open = () => (row.kind === "chat" ? openRoomFromInbox(row.roomId) : row.kind === "circle" ? openCircleFromInbox(row.circle.id) : openSharedCard(row.captureId, { talk: row.kind === "call" }));
  const title = node("button", label, "inbox-title");
  title.type = "button";
  title.addEventListener("click", open);
  const meta = node("div", undefined, "inbox-meta");
  if (row.kind === "request") meta.append(bindTranslation(node("span", t("просит {name}", { name: row.from.name }), "inbox-who"), "просит {name}", { name: row.from.name }));
  else if (row.kind === "chat") meta.append(bindTranslation(node("span", t("разговор «{roomName}»", { roomName: row.roomName }), "inbox-who"), "разговор «{roomName}»", { roomName: row.roomName }));
  else if (row.kind === "circle") meta.append(bindTranslation(node("span", t("общая полка: видно только то, что в неё отдали"), "inbox-who"), "общая полка: видно только то, что в неё отдали"));
  else meta.append(bindTranslation(node("span", t("обсуждение «{title}»", { title: row.title }), "inbox-who"), "обсуждение «{title}»", { title: row.title }));
  if (row.circle) meta.append(circleChip(row.circle, { small: true }));
  if (row.due) meta.append(bindTranslation(node("span", t("срок: {value1}", { value1: scheduleLabel({ date: row.due.date, time: row.due.time }) || row.due.date }), "inbox-due"), "срок: {value1}", { value1: scheduleLabel({ date: row.due.date, time: row.due.time }) || row.due.date }));
  meta.append(node("span", agoWords(row.createdAt) || "", "inbox-ago"));
  main.append(title, meta);
  const acts = node("div", undefined, "inbox-acts");
  if (row.kind === "request") {
    const take = bindTranslation(node("button", t("Беру"), "inbox-take"), "Беру");
    take.type = "button";
    take.addEventListener("click", () => respondRequest(row, true, take));
    const not = bindTranslation(node("button", t("Не я"), "inbox-not"), "Не я");
    not.type = "button";
    not.addEventListener("click", () => respondRequest(row, false, not));
    acts.append(take, not);
  } else {
    const openButton = bindTranslation(node("button", t("Открыть"), "inbox-not"), "Открыть");
    openButton.type = "button";
    openButton.addEventListener("click", open);
    acts.append(openButton);
  }
  element.append(mark, main, acts);
  return element;
}
// Свёрнутая строка выключенного круга: просьбы не показываются поштучно, но и
// не пропадают — иначе человек думает, что попросил, а его никто не увидит.
function inboxFoldedRow(item) {
  const element = node("div", undefined, "inbox-row muted");
  const main = node("div", undefined, "inbox-main");
  const title = node("span", undefined, "inbox-title as-text");
  if (item.circle) title.append(circleChip(item.circle, { small: true }));
  title.append(bindTranslation(node("span", t(" выключен — {count} {value2}", { count: item.count, value2: pluralRu(item.count, t("просьба"), t("просьбы"), t("просьб")) })), " выключен — {count} {value2}", { count: item.count, value2: pluralRu(item.count, t("просьба"), t("просьбы"), t("просьб")) }));
  const meta = node("div", undefined, "inbox-meta");
  meta.append(bindTranslation(node("span", t("последняя: {value1}{value2}", { value1: agoWords(item.lastAt) || "", value2: item.from ? t(" · от {value1}", { value1: item.from.name }) : "" }), "inbox-who"), "последняя: {value1}{value2}", { value1: agoWords(item.lastAt) || "", value2: item.from ? t(" · от {value1}", { value1: item.from.name }) : "" }));
  main.append(title, meta);
  const acts = node("div", undefined, "inbox-acts");
  const show = bindTranslation(node("button", t("Включить круг"), "inbox-not"), "Включить круг");
  show.type = "button";
  show.addEventListener("click", () => toggleCircleMute(item.circle.id, false));
  acts.append(show);
  element.append(node("span", undefined, "inbox-mark"), main, acts);
  return element;
}
// Лента уведомлений (подробности — в разделе «уведомления» ниже). Состояние
// объявлено здесь, до первого разбора адреса: он случается во время чтения
// файла, и `const` ниже по тексту попал бы в мёртвую зону.
const bellState = { items: [], counts: { waits: 0, unread: 0 }, kinds: [], filter: "all", loaded: false, menu: null, digest: null };
const bellDone = new Map();
// Полоса «к вам» — только то, что ждёт вашего решения: просьбы и приглашения
// на встречи. Призывы, добавление в круг и остальные новости живут за
// колокольчиком: день не должен превращаться в ленту событий.
function paintInbox(container) {
  const rows = (todayState.inbox || []).filter((row) => row.kind === "request"), folded = todayState.inboxFolded || [];
  const invites = bellState.items.filter((item) => item.kind === "invite" && item.waits);
  if (!rows.length && !invites.length && !folded.length) return;
  container.append(bindTranslation(node("div", t("к вам · {value1}", { value1: rows.length + invites.length + folded.reduce((total, item) => total + item.count, 0) }), "day-group inbox-group"), "к вам · {value1}", { value1: rows.length + invites.length + folded.reduce((total, item) => total + item.count, 0) }));
  const strip = node("div", undefined, "inbox");
  for (const row of rows) strip.append(inboxRow(row));
  for (const item of invites) strip.append(inviteRow(item));
  for (const item of folded) strip.append(inboxFoldedRow(item));
  container.append(strip);
}
// Хвост дня: сколько дел на других и какие круги выключены. Оба числа — факт в
// своём списке, а не письмо человеку в спину.
function paintCircleTail(container) {
  const waiting = todayState.waiting || [];
  const open = waiting.filter((item) => ["pending", "accepted"].includes(item.state));
  if (open.length) {
    const late = open.filter((item) => item.state === "pending" && daysBetween(item.createdAt) >= 2).length;
    const link = node("button", undefined, "day-more");
    link.type = "button";
    link.append(bindTranslation(node("span", t("На других {length} {value2}", { length: open.length, value2: pluralRu(open.length, t("дело"), t("дела"), t("дел")) }), "strong"), "На других {length} {value2}", { length: open.length, value2: pluralRu(open.length, t("дело"), t("дела"), t("дел")) }));
    if (late) link.append(bindTranslation(node("span", t(" · {late} {value2} ответа второй день", { late: late, value2: pluralRu(late, t("ждёт"), t("ждут"), t("ждут")) })), " · {late} {value2} ответа второй день", { late: late, value2: pluralRu(late, t("ждёт"), t("ждут"), t("ждут")) }));
    link.append(bindTranslation(node("span", t(" — в «Кругах» →")), " — в «Кругах» →"));
    link.addEventListener("click", () => { location.hash = "#circles"; });
    container.append(link);
  }
  for (const circle of todayState.mutedCircles || []) {
    const line = node("div", undefined, "day-muted");
    line.append(circleChip(circle, { small: true }), bindTranslation(node("span", t(" выключен — {deeds} {value2}. ", { deeds: circle.deeds, value2: pluralRu(circle.deeds, t("дело"), t("дела"), t("дел")) })), " выключен — {deeds} {value2}. ", { deeds: circle.deeds, value2: pluralRu(circle.deeds, t("дело"), t("дела"), t("дел")) }));
    const on = bindTranslation(node("button", t("Включить"), "linklike"), "Включить");
    on.type = "button";
    on.addEventListener("click", () => toggleCircleMute(circle.id, false));
    line.append(on);
    container.append(line);
  }
}
async function toggleCircleMute(circleId, muted) {
  try {
    await request(`/api/circles/${circleId}/mute`, { method: "POST", body: JSON.stringify({ muted }) });
    await load();
    if (!$("#circles")?.hidden) await loadCircles();
  } catch (error) { toast(error.message || t("Не получилось")); }
}
// Чужая карточка открывается тем же окном, что и своя: запись живёт у автора,
// а мы читаем её и пишем в обсуждение.
async function openSharedCard(captureId, { talk = false } = {}) {
  try {
    const { entry } = await request(`/api/captures/${captureId}`);
    cardTalkOnOpen = talk;
    showCorrection(entry, reviewFromEntry(entry).level === "high" ? undefined : reviewFromEntry(entry));
  } catch (error) { toast(error.message || t("Запись не открылась")); }
}
function paintDayList(date) {
  const container = $("#todo");
  clear(container);
  container.append(dayNavNode(date, { view: todayState.view, onView: setView }));
  if (date === currentDayDate) { paintTodayList(container); return; }
  const data = todayState.cache.get(date);
  if (!data) {
    container.append(bindTranslation(node("p", t("Загружаю…"), "empty"), "Загружаю…"));
    ensureDayData(date);
    return;
  }
  paintOtherDayList(container, date, data);
}
// Заголовок полки «просрочено» или «на сегодня». Если на полке есть что
// переносить, справа от подписи — тихая ссылка «перенести всё на завтра»; подпись
// остаётся своим элементом .day-group, ссылка стоит рядом с ней в общей строке.
function shelfHeadEl(text, kind, entries) {
  const label = node("div", text, `day-group ${kind}`);
  const movable = entries.filter((entry) => canPostpone(entry));
  if (!movable.length) return label;
  const head = node("div", undefined, "day-head");
  const act = bindTranslation(node("button", t("перенести всё на завтра"), `day-head-act ${kind}`), "перенести всё на завтра");
  act.type = "button";
  act.addEventListener("click", () => postponeToTomorrow(movable, act));
  head.append(label, act);
  return head;
}
// Сегодня: сверху «без времени» — просроченное, требующее уточнения, сегодняшнее
// без часа и дела без срока, ниже «по часам» — свои дела и встречи со временем
// вперемешку с чужими событиями, между прошедшими и будущими — строка «сейчас».
// Это простой список: ничего не обрезается, и своей полосы прокрутки у ящика
// нет — длинный день прокручивается страницей, как и всё остальное. Ящик с
// собственной прокруткой оказался хуже обрезки: дела лежали в окошке высотой в
// три строки, а «по часам» пряталось за его нижним краем. Дела на другие дни
// живут в своих днях и в хвосте «Ещё N».
function paintTodayList(container) {
  const today = currentDayDate, minutes = nowMinutes();
  const timed = (entry) => scheduledOn(entry, today) && Boolean(scheduleOf(entry)?.time);
  const order = (entry) => todoOrder(entry, today);
  const band = todayState.todo.filter((entry) => order(entry) <= 3 && !timed(entry));
  const late = band.filter((entry) => isOverdue(entry, today));
  const rest = band.filter((entry) => !isOverdue(entry, today));
  const later = todayState.todo.filter((entry) => order(entry) === 4);
  const hidden = later.length;
  const external = (todayState.calendar?.external || []).filter((item) => item.date === today);
  const allDay = external.filter((item) => item.allDay);
  const hours = [
    ...todayState.todo.filter(timed).map((entry) => ({ start: minutesOf(scheduleOf(entry).time), entry })),
    ...external.filter((item) => !item.allDay && item.time).map((item) => ({ start: minutesOf(item.time), item })),
  ].filter((slot) => slot.start != null).sort((a, b) => a.start - b.start);
  paintInbox(container);
  if (!band.length && !allDay.length && !hours.length) {
    // Пустому журналу «Открытых дел нет» ничего не объясняет: человек видит
    // поле и не знает, что в него писать. Место то же, слова другие.
    container.append(todayState.entries.length ? bindTranslation(node("p", t("Открытых дел нет."), "empty"), "Открытых дел нет.") : firstStepNode());
    appendMore(container, hidden);
    paintCircleTail(container);
    return;
  }
  // Часы идут первыми: день — это прежде всего встречи, к которым надо успеть.
  // Пока они лежали под списком дел, до «что у меня в 12:30» человек добирался
  // через двенадцать строк. Событие на весь день стоит над часами: оно про весь
  // день, а не про какой-то из них.
  if (hours.length || allDay.length) {
    container.append(bindTranslation(node("div", t("по часам"), "day-group"), "по часам"));
    for (const item of allDay) container.append(eventRow(item, { minutes, today: true }));
    const meetings = todayMeetings();
    const running = meetings.some((meeting) => minutes >= meeting.start && minutes < meeting.end);
    let nowPlaced = running;
    for (const slot of hours) {
      if (!nowPlaced && slot.start > minutes) { container.append(nowRow(minutes, meetings)); nowPlaced = true; }
      container.append(slot.entry
        ? rowWithTime(scheduleOf(slot.entry).time, entryCard(slot.entry, { atTime: true, on: today }))
        : eventRow(slot.item, { minutes, today: true }));
    }
    if (!nowPlaced && hours.length) container.append(nowRow(minutes, meetings));
  }
  // Просроченное — своей полосой сразу под часами, а не строкой в общем списке:
  // под встречами оно иначе теряется, а это единственное, что горит.
  if (late.length) {
    container.append(shelfHeadEl(t("просрочено · {length}", { length: late.length }), "late", late));
    const strip = node("div", undefined, "day-late");
    for (const entry of late) strip.append(entryCard(entry, { overdue: true, on: today }));
    container.append(strip);
  }
  // Сегодняшнее — своей полкой, запас без срока — своей: «3 дела на сегодня» из
  // утренней сводки видно в «Дне» сразу, а не одной меткой среди двенадцати
  // строк. Запись, ждущая уточнения, — на сегодняшней полке: решить её сегодня.
  const shelf = rest.filter((entry) => order(entry) <= 2);
  const stock = rest.filter((entry) => order(entry) === 3);
  if (shelf.length || stock.length) {
    container.append(shelfHeadEl(shelf.length ? t("на сегодня · {length}", { length: shelf.length }) : t("на сегодня"), "today", shelf));
    if (shelf.length) {
      const rows = node("div", undefined, "day-rows");
      for (const entry of shelf) rows.append(entryCard(entry, { on: today }));
      container.append(rows);
    } else container.append(bindTranslation(node("p", t("Без часа на сегодня ничего — возьмите дело из запаса."), "day-shelf-empty"), "Без часа на сегодня ничего — возьмите дело из запаса."));
  }
  if (stock.length) {
    container.append(bindTranslation(node("div", t("без срока · {length}", { length: stock.length }), "day-group stock"), "без срока · {length}", { length: stock.length }));
    const rows = node("div", undefined, "day-rows stock");
    for (const entry of stock) rows.append(entryCard(entry, { on: today, takeToday: true }));
    container.append(rows);
  }
  appendMore(container, hidden);
  paintCircleTail(container);
}
// Соседний день собран так же, как сегодняшний: сначала часы, потом дела. День
// не должен менять устройство от того, каким его открыли.
function paintOtherDayList(container, date, data) {
  const pastDay = date < currentDayDate;
  const own = ownEntriesFor(date);
  const external = (data.calendar?.external || []).filter((item) => item.date === date);
  const card = (entry, atTime = false) => entryCard(entry, { overdue: pastDay && !isClosed(entry) && !scheduleOf(entry)?.repeat, atTime, on: date });
  const band = own.filter((entry) => !scheduleOf(entry)?.time);
  const allDay = external.filter((item) => item.allDay);
  const hours = [
    ...own.filter((entry) => scheduleOf(entry)?.time).map((entry) => ({ start: minutesOf(scheduleOf(entry).time), entry })),
    ...external.filter((item) => !item.allDay && item.time).map((item) => ({ start: minutesOf(item.time), item })),
  ].filter((slot) => slot.start != null).sort((a, b) => a.start - b.start);
  if (!band.length && !allDay.length && !hours.length) {
    container.append(node("p", pastDay ? t("Встреч и дел со сроком не было.") : t("Встреч и дел со сроком пока нет."), "empty"));
    return;
  }
  if (hours.length || allDay.length) {
    container.append(bindTranslation(node("div", t("по часам"), "day-group"), "по часам"));
    for (const item of allDay) container.append(eventRow(item, { pastDay }));
    for (const slot of hours) container.append(slot.entry ? rowWithTime(scheduleOf(slot.entry).time, card(slot.entry, true)) : eventRow(slot.item, { pastDay }));
  }
  if (band.length) {
    container.append(bindTranslation(node("div", t("дела"), "day-group"), "дела"));
    const rows = node("div", undefined, "day-rows");
    for (const entry of band) rows.append(card(entry));
    container.append(rows);
  }
}
// «Закрыто» на «Сегодня» — то же, что вечером назвали бы итогом дня: туду, закрытые
// кружком (кружок возвращает в работу), и встречи из календаря, чей конец
// прошёл (пунктирный кружок: закрылись сами, руками их не вернуть). Сегодня —
// из /api/done и календаря; другой день — из отчёта «Обзора» и календаря того
// дня. Порядок — по времени, свежее сверху. null — день ещё не загружен.
function doneRows(date = currentDayDate) {
  const minutes = nowMinutes();
  let rows;
  if (date === currentDayDate) {
    if (todayState.doneLoading && todayState.doneKnownDate !== date) return null;
    rows = todayState.done.map((item) => ({ done: item, at: minutesOf(item.time) ?? 0 }));
  }
  else {
    const data = todayState.cache.get(date);
    if (!data) return null;
    rows = (data.report?.done || []).map((record) => ({ record, at: zoneMinutes(new Date(record.at)) }));
  }
  for (const item of externalFor(date))
    if (eventEnded(item, minutes, date)) rows.push({ item, at: eventFinish(item) });
  return rows.sort((a, b) => b.at - a.at);
}
// Строка «Закрыто» из /api/done: зелёный кружок «Вернуть в работу» (у
// экземпляра повтора он снимает только этот день), название и час закрытия.
// Старая запись без дела внутри возвращать нечем — у неё немой кружок.
function doneItemRow(item) {
  const row = node("div", undefined, `entry dense completed${item.projectionId ? " completable" : ""}`);
  row.dataset.captureId = item.id;
  if (item.projectionId) {
    const button = node("button", undefined, "completion-button");
    button.type = "button";
    bindTranslation(button, "Вернуть в работу", "title");
    bindTranslation(button, "Вернуть в работу", "aria-label");
    button.setAttribute("aria-pressed", "true");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request(`/api/projections/${item.projectionId}/undo-complete`, { method: "POST", body: JSON.stringify(item.occurrence ? { occurrence: item.occurrence } : {}) });
        toast(t("Возвращено в работу"));
        await load();
        refreshOtherViews();
      } catch (error) { toast(error.message); button.disabled = false; }
    });
    row.append(button);
  } else {
    const mark = node("span", undefined, "completion-button static");
    mark.setAttribute("aria-pressed", "true");
    row.append(mark);
  }
  const title = markdownNode("button", item.title, "entry-title", { inline: true, links: false, firstLine: true });
  title.type = "button";
  title.addEventListener("click", () => openCaptureById(item.id));
  const meta = node("div", undefined, "entry-meta");
  const subs = subtaskBadge(item.subtasks, () => openCaptureById(item.id, { subtasks: true }));
  if (subs) meta.append(subs);
  if (item.occurrence) meta.append(bindTranslation(node("span", t("повтор"), "tag due"), "повтор"));
  meta.append(node("span", item.time, "tag time"));
  row.append(title, meta);
  return row;
}
function autoDoneRow(item, at) {
  const row = node("div", undefined, "entry completed auto-done");
  row.dataset.eventId = item.id;
  const mark = node("span", undefined, "completion-button auto");
  bindTranslation(mark, "Прошла по календарю", "title");
  const title = node("span", item.title, "entry-title");
  const meta = node("div", undefined, "entry-meta");
  meta.append(bindTranslation(node("span", t("прошла по календарю"), "tag auto"), "прошла по календарю"), node("span", hm(at), "tag time"));
  row.append(mark, title, meta);
  return row;
}
function paintJournal(date) {
  const container = $("#journal");
  clear(container);
  container.append(dayNavNode(date, { view: todayState.journalView, onView: setJournalView }));
  const rows = doneRows(date);
  if (!rows) {
    container.append(bindTranslation(node("p", t("Загружаю…"), "empty"), "Загружаю…"));
    if (date !== currentDayDate) ensureDayData(date);
    return;
  }
  if (!rows.length) {
    container.append(node("p", date === currentDayDate ? t("Пока нет зафиксированной работы за сегодня.") : date < currentDayDate ? t("В этот день ничего не записано.") : t("День ещё не наступил."), "empty"));
    return;
  }
  const list = node("div", undefined, "day-rows");
  for (const row of rows)
    list.append(row.done ? doneItemRow(row.done) : row.record ? reportRecordNode(row.record) : autoDoneRow(row.item, row.at));
  container.append(list);
}
// Запись другого дня из отчёта «Обзора»: карточка, если запись ещё среди
// загруженных, иначе строка с названием и временем.
function reportRecordNode(record) {
  const entry = todayState.entries.find((candidate) => candidate.id === record.captureId);
  if (entry) return entryCard(entry, { doneAt: zoneMinutes(new Date(record.at)) });
  const row = node("div", undefined, "entry dense completed");
  row.dataset.captureId = record.captureId;
  const mark = node("span", undefined, "completion-button static");
  mark.setAttribute("aria-pressed", "true");
  row.append(mark);
  const title = node("span", record.title, "entry-title");
  const meta = node("div", undefined, "entry-meta");
  const subs = subtaskBadge(record.subtasks, () => openCaptureById(record.captureId, { subtasks: true }));
  if (subs) meta.append(subs);
  meta.append(node("span", hm(zoneMinutes(new Date(record.at))), "tag time"));
  row.append(title, meta);
  return row;
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
    todayState.cache.set(date, { calendar: pruneRemovedExternal(calendar), report });
  } finally {
    todayState.loading.delete(date);
  }
  if (!currentDayDate) return;
  if ([todayState.view, todayState.journalView].some((offset) => shiftDate(currentDayDate, offset) === date)) renderToday();
}
// День меняется даже с черновиком и на другой странице. Перечитываем данные,
// не перезагружая документ: поля ввода и открытая карточка остаются на месте.
let dayRefresh = null;
function refreshChangedDay() {
  if (!currentDayDate || currentDayDate === zoneDate(new Date())) return false;
  if (!dayRefresh) {
    // Ответы календаря/закрытых дел за старый день больше не применяются.
    dayTimeZoneGeneration += 1;
    todayState.doneLoading = false;
    todayState.calendarLoading = false;
    dayRefresh = load().then(() => {
      paintBell();
      paintUpcomingReminders();
      if (!$("#done")?.hidden) return loadDone({ fresh: true });
    }).catch(() => {}).finally(() => { dayRefresh = null; });
  }
  return true;
}
for (const event of ["focus", "pageshow", "pagent:resume"]) window.addEventListener(event, refreshChangedDay);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshChangedDay(); });
// Обычная минутная перерисовка обложки ждёт, если человек набирает текст.
setInterval(() => {
  if (refreshChangedDay()) return;
  if ($("#today")?.hidden || !currentDayDate) return;
  if (typeof captureField !== "undefined" && String(captureField.getValue()).trim()) return;
  renderToday();
}, 60000);
// Повтор не просрочивается: прошедшие экземпляры просто прошли.
function isOverdue(entry, today) {
  const schedule = entry.interpretation.classification.entities.schedule;
  return Boolean(schedule?.date && !schedule.repeat && schedule.date < today);
}
function todoOrder(entry, today) {
  const schedule = entry.interpretation.classification.entities.schedule;
  const date = schedule?.date;
  if (schedule?.repeat) return scheduledOn(entry, today) ? 2 : 4;
  if (date && date < today) return 0;
  if (needsClarification(entry)) return 1;
  if (date === today) return 2;
  if (!date) return 3;
  return 4;
}
async function load() {
  const loadToken = ++dayLoadToken, timeZone = getTimeZone();
  // Календарь на сегодня и завтра нужен «Дню» и брифу. Он грузится вместе с
  // журналом, но только пока открыта «Сегодня»: на других страницах журнал
  // перечитывается так же быстро, как раньше, а календарь добирается при
  // возвращении. Другие дни грузятся, когда их открывают, и забываются при
  // каждом изменении журнала.
  const todayGuess = zoneDate(new Date());
  const onToday = !$("#today")?.hidden;
  // Сначала отправляем два запроса, без которых день нельзя показать.
  const primaryRequest = Promise.all([
    request("/api/day"),
    request("/api/entries?limit=100"),
  ]);
  const calendarRequest = onToday
    ? request(`/api/calendar?from=${todayGuess}&to=${shiftDate(todayGuess, 1)}`).catch(() => null)
    : Promise.resolve(undefined);
  // «Закрыто» может отвечать заметно дольше журнала. Оба дополнительных
  // запроса стартуют сразу, но не задерживают первую отрисовку дня.
  const doneRequest = onToday
    ? request(`/api/done?from=${todayGuess}&to=${todayGuess}`).catch(() => null)
    : Promise.resolve(undefined);
  let day, entries;
  try {
    [day, entries] = await primaryRequest;
  } catch (error) {
    if (loadToken === dayLoadToken) {
      todayState.calendarLoading = false;
      todayState.doneLoading = false;
      if (timeZone === getTimeZone() && currentDayDate && onToday && (todayState.calendarStale || todayState.doneStale)) renderToday();
    }
    throw error;
  }
  if (loadToken !== dayLoadToken || timeZone !== getTimeZone()) {
    if (loadToken === dayLoadToken) {
      todayState.calendarLoading = false;
      todayState.doneLoading = false;
    }
    return;
  }
  todayState.cache.clear();
  // Не показываем данные вчерашнего дня, пока новые дополнительные ответы в пути.
  if (currentDayDate && currentDayDate !== day.date) {
    todayState.calendar = null;
    todayState.done = [];
    todayState.calendarKnownDate = null;
    todayState.doneKnownDate = null;
  }
  todayState.doneStale = true;
  todayState.calendarStale = true;
  todayState.doneLoading = onToday;
  todayState.calendarLoading = onToday;
  render({ ...day, entries: entries.entries });
  if (!initialDayRendered) {
    initialDayRendered = true;
    if (journalRefreshPending) {
      journalRefreshPending = false;
      reloadJournalSoon();
    }
  }
  // Применяем ответы только к тому дню и поколению, для которых они запрошены.
  // Флаги loading не дают renderToday() запустить тот же запрос второй раз.
  if (onToday) {
    let auxPaintPending = false;
    const paintAux = () => {
      if (auxPaintPending) return;
      auxPaintPending = true;
      requestAnimationFrame(() => {
        auxPaintPending = false;
        if (loadToken === dayLoadToken && timeZone === getTimeZone() && currentDayDate === day.date && !$("#today")?.hidden) renderToday();
      });
    };
    calendarRequest.then(calendar => {
      if (loadToken !== dayLoadToken || timeZone !== getTimeZone() || currentDayDate !== day.date) return;
      todayState.calendarLoading = false;
      if (todayGuess === day.date) {
        todayState.calendar = pruneRemovedExternal(calendar);
        todayState.calendarKnownDate = day.date;
        todayState.calendarStale = false;
      }
      paintAux();
    });
    doneRequest.then(closed => {
      if (loadToken !== dayLoadToken || timeZone !== getTimeZone() || currentDayDate !== day.date) return;
      todayState.doneLoading = false;
      if (todayGuess === day.date) {
        todayState.done = (closed?.days || []).flatMap(group => group.items).filter(item => !item.auto);
        todayState.doneKnownDate = day.date;
        todayState.doneStale = false;
      }
      paintAux();
    });
  }
  // Доска и «Обзор» живут своими запросами: правка в карточке или доразбор
  // записи должны быть видны сразу там, откуда карточку открыли, а не после
  // ухода на другую страницу и обратно. Перечитываются только уже собранные —
  // при старте их собирает переход по хэшу.
  const page = document.querySelector(".app-page:not([hidden])")?.id;
  if (page === "board" && boardState.data) await loadBoard();
  if (page === "circles") await refreshRoomsQuietly();
  if (page === "calendar" && calState.data) await loadCalendar();
  if (page === "reports" && reportsState.loaded) await loadReports();
  if (page === "notes") await refreshNotes();
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
// Заголовок, который правят прямо сейчас: переход к подзадаче и закрытие
// карточки ждут и его.
let flushCardTitle = null;
// День, с которого открыли карточку повторяющейся записи: «удалить» тогда
// предлагает убрать только этот повтор.
let cardOccurrence = null;
function flushCard() {
  const body = flushCardBody,
    props = flushCardProps,
    title = flushCardTitle;
  flushCardBody = null;
  flushCardProps = null;
  flushCardTitle = null;
  // Переход к подзадаче ждёт, пока набранное уйдёт на сервер: родитель после
  // возвращения читается уже с правкой.
  return Promise.all([body?.(), props?.(), title?.()]).catch(() => {});
}
// Поле заметки пересоздаётся на каждое открытие карточки, а меню разметки
// вешает слушатель на документ: без уборки они копились бы с каждым разом.
let closeCardSlashMenu = null;
// ── карточка «Фокус»: вложенные подзадачи и панель «Параметры» ─────────────
// Подзадача открывается в той же карточке, а не поверх: стек помнит, откуда
// пришли, — прокрутку и строку, чтобы «назад» вернуло на то же место. Панель
// «Параметры» живёт одним флагом на всю карточку: открыли у родителя — она
// остаётся открытой и у подзадачи.
let cardStack = [];
let cardEntryId = null;
// Карточку открыли по метке «0/2» у названия: когда раздел «Подзадачи» нарисован,
// она докручивается до него. Держит id записи — чужая карточка не прокрутится.
let cardScrollTarget = null;
// Номер перехода: ответ на запрос, обогнанный другим переходом или закрытием,
// карточку уже не меняет.
let cardNavToken = 0;
let cardParamsOpen = false;
// Черновики обсуждения по записям: ушёл в подзадачу и вернулся — набранное
// на месте.
const cardDrafts = new Map();
// Вид раздела «Подзадачи» и свёрнутые ветки карты — на всё время сеанса.
let cardWorkspace = null;
const CARD_NOTE_SHARE_KEY = "kizuna-card-note-share";
let cardStepView = "list";
const cardCollapsed = new Set();
function resetCardFocus() {
  cardNavToken += 1;
  cardStack = [];
  cardEntryId = null;
  cardScrollTarget = null;
  cardDrafts.clear();
  setCardParams(false, { instant: true });
}
// Карточка сбоку — обычное окно, а не модальное: страница за ней жива, и по
// другой записи на доске можно щёлкнуть, не закрывая эту. Чужое открытие
// отличается от внутренней перерисовки — листания стрелками, подзадачи,
// возврата к родителю, правки заголовка, — её помечает showCardInner.
let cardInner = false;
function showCardInner(entry, review) {
  cardInner = true;
  try { showCorrection(entry, review); } finally { cardInner = false; }
}
const cardOpenedFromPage = (dialog) => dialog.open && !cardInner && !dialog.matches(":modal") && cardEntryId !== null;
// Сбоку страница за карточкой жива, и видно, какая запись читается: её строка или
// карточка на доске обведена. Обводку ведёт showReview, закрытие и смена режима;
// страница перерисовывается сама — за ней следит наблюдатель ниже.
function markOpenCard() {
  for (const element of document.querySelectorAll(".card-is-open")) element.classList.remove("card-is-open");
  const dialog = $("#review-dialog");
  if (!dialog.open || dialog.matches(":modal") || !cardEntryId) return;
  for (const element of document.querySelectorAll(`[data-capture-id="${CSS.escape(cardEntryId)}"]`))
    if (!dialog.contains(element)) element.classList.add("card-is-open");
}
let cardMarkFrame = 0;
new MutationObserver(() => {
  if (cardMarkFrame || !$("#review-dialog").open) return;
  cardMarkFrame = requestAnimationFrame(() => { cardMarkFrame = 0; markOpenCard(); });
}).observe($("main"), { childList: true, subtree: true });
// Запись встаёт на место прежней: набранное в ней уходит на сервер, пока
// разметка ещё на месте, стек подзадач и черновики обсуждения — прошлой записи.
// Список, из которого открыли (pendingCardList), остаётся — его только что
// назвал тот, кто открыл.
function leaveCardForPage() {
  const dialog = $("#review-dialog");
  cardNavToken += 1;
  clearTimeout(cardAdvance);
  cardAdvance = null;
  clearTimeout(cardSnackTimer);
  dialog.querySelector(".card-snack")?.remove();
  flushCard();
  closeCardSlashMenu?.();
  dropCardTalk();
  cardStack = [];
  cardDrafts.clear();
}
// Карточка закрывается в конце угасания. Если за эти 150 мс по записи щёлкнули и
// открылась другая (щелчок мимо карточки сбоку закрывает её по нажатию, а
// щелчок, открывающий другую запись, приходит следом), запоздавшее закрытие
// её не трогает: ему мешает отметка, которую ставит showReview.
let cardCloseToken = 0;
function closeCard() {
  const dialog = $("#review-dialog");
  cardOccurrence = null;
  dropCardFlow();
  resetCardFocus();
  // Сохранение уходит своим ходом: карточка закрывается сразу, но значения
  // полей читаются сейчас, пока разметка ещё на месте.
  flushCard();
  closeCardSlashMenu?.();
  if (!dialog.open) {
    dropCardTalk();
    clear($("#review"));
    return;
  }
  const token = ++cardCloseToken;
  let fade = null;
  const finish = () => {
    if (token !== cardCloseToken) { fade?.cancel(); return; }
    if (dialog.open) dialog.close();
    dropCardTalk();
    clear($("#review"));
    // Анимация закрытия держит карточку прозрачной (fill: forwards): не снять
    // её — и при следующем открытии карточка окажется невидимой.
    for (const animation of dialog.getAnimations()) animation.cancel();
  };
  if (!motionAllowed()) return finish();
  // Уходит карточка так же тихо, как пришла: гаснет на месте, никуда не едет.
  fade = dialog.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(6px)" },
    ],
    { duration: FADE_DURATION, easing: "ease-in", fill: "forwards" },
  );
  fade.finished.then(finish, finish);
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
    return { key: "done", get label() { return t("Сделано"); }, icon: "done" };
  // Статус есть только у дел: заметки, идеи и незакрытые результаты живут без него.
  if (
    !completableProjections(entry).length &&
    !["task", "meeting_event"].includes(c.primaryType)
  )
    return null;
  const date = c.entities.schedule?.date || null;
  if (!date) return { key: "none", get label() { return t("Без срока"); }, icon: "none" };
  if (today && date < today) return { key: "late", get label() { return t("Просрочено"); }, icon: "late" };
  if (today && date === today) return { key: "today", get label() { return t("Сегодня"); }, icon: "clock" };
  return { key: "ontime", get label() { return t("В срок"); }, icon: "clock" };
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
  source: '<path d="M8 2.4 13.4 5.2 8 8 2.6 5.2Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m2.6 8 5.4 2.8L13.4 8M2.6 10.8 8 13.6l5.4-2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.3a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  bell: '<path d="M6 13a2 2 0 0 0 4 0M3 11h10l-1-2V6a4 4 0 0 0-8 0v3l-1 2Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  repeat: '<path d="M3.2 7.2A4.6 4.6 0 0 1 11.6 5M12.8 8.8A4.6 4.6 0 0 1 4.4 11M11.8 2.4V5H9.2M4.2 13.6V11h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
};
function propIcon(name) {
  const glyph = node("span", undefined, "prop-icon");
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16">${PROP_ICONS[name]}</svg>`;
  return glyph;
}
function projectPicker(input) {
  const wrap = node("div", undefined, "project-picker");
  const chip = node("span", undefined, "project-selection");
  const edit = node("button", undefined, "project-selected-name");
  edit.type = "button";
  bindTranslation(edit, "Выбрать другой проект", "title");
  const remove = node("button", "×", "project-remove");
  remove.type = "button";
  bindTranslation(remove, "Убрать проект", "aria-label");
  const list = node("div", undefined, "project-options");
  list.id = "review-project-options";
  list.setAttribute("role", "listbox");
  bindTranslation(list, "Проекты", "aria-label");
  list.hidden = true;
  input.setAttribute("role", "combobox");
  bindTranslation(input, "Проект", "aria-label");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.autocomplete = "off";
  let names = [], active = -1, options = [], committed = input.value.trim();
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
  const paint = () => {
    const value = input.value.trim();
    chip.hidden = !value;
    input.hidden = Boolean(value);
    edit.textContent = value;
    close();
  };
  const select = (name) => {
    input.value = name;
    committed = name;
    paint();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    edit.focus();
  };
  const suggest = () => {
    if (input.hidden || document.activeElement !== input) return;
    const query = input.value.trim();
    const key = query.toLocaleLowerCase();
    options = names.filter((name) => name.toLocaleLowerCase().includes(key));
    const create = query && !names.some((name) => name.toLocaleLowerCase() === key);
    if (create) options.push(query);
    clear(list);
    active = -1;
    input.removeAttribute("aria-activedescendant");
    options.forEach((name, index) => {
      const option = node("button", create && index === options.length - 1 ? t("Создать проект «{name}»", { name: name }) : name, "project-option");
      option.type = "button";
      option.id = `review-project-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.tabIndex = -1;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => select(name));
      list.append(option);
    });
    if (!options.length) list.append(bindTranslation(node("p", t("Введите название нового проекта"), "project-options-empty"), "Введите название нового проекта"));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  edit.addEventListener("click", () => { chip.hidden = true; input.hidden = false; input.focus(); input.select(); });
  const reset = () => { committed = ""; input.value = ""; paint(); input.dispatchEvent(new Event("input", { bubbles: true })); };
  remove.addEventListener("click", () => { reset(); input.focus(); });
  input.addEventListener("focus", suggest);
  input.addEventListener("input", suggest);
  input.addEventListener("blur", () => {
    input.value = names.find((name) => name.toLocaleLowerCase() === input.value.trim().toLocaleLowerCase()) || input.value.trim();
    committed = input.value;
    paint();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !list.hidden) { event.preventDefault(); event.stopPropagation(); input.value = committed; paint(); input.dispatchEvent(new Event("change", { bubbles: true })); if (input.hidden) edit.focus(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      if (list.hidden) suggest();
      if (!options.length) return;
      active = active < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) : (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      [...list.querySelectorAll('[role="option"]')].forEach((option, index) => option.setAttribute("aria-selected", String(index === active)));
      input.setAttribute("aria-activedescendant", `review-project-option-${active}`);
      list.children[active].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation();
      const exact = names.find((name) => name.toLocaleLowerCase() === input.value.trim().toLocaleLowerCase());
      select(active >= 0 ? options[active] : exact || input.value.trim());
    }
  });
  chip.append(edit, remove);
  wrap.append(chip, input, list);
  paint();
  request("/api/projects").then((data) => {
    names = [...new Map([input.value.trim(), ...data.projects].filter(Boolean).map((name) => [name.toLocaleLowerCase(), name])).values()];
    if (document.activeElement === input) suggest();
  }).catch(() => {});
  return { element: wrap, focusTarget: () => input.hidden ? edit : input };
}

function propertyRow(label, control, icon, { clear = null, filled = null } = {}) {
  const row = node("div", undefined, "prop");
  const name = node("span", label, "prop-label");
  if (icon) name.prepend(propIcon(icon));
  row.append(name, control);
  if (clear) {
    const reset = node("button", "×", "prop-clear");
    reset.type = "button";
    bindTranslation(reset, "Сбросить: {value1}", { value1: label.toLowerCase() }, "title");
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
  if (bytes < 1024) return t("{bytes} Б", { bytes: bytes });
  if (bytes < 1024 * 1024) return t("{value1} КБ", { value1: Math.round(bytes / 1024) });
  return t("{value1} МБ", { value1: (bytes / (1024 * 1024)).toFixed(1) });
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
      node("p", `${attachment.contentType || t("файл")} · ${fileSize(attachment.size)}`, "preview-plain"),
    );
  }
  if (!dialog.open) dialog.showModal();
  appear(dialog, { shift: 8 });
}
function attachmentsBlock(entry) {
  const wrap = node("section", undefined, "card-files"),
    head = node("div", undefined, "card-files-head"),
    label = bindTranslation(node("p", t("Вложения"), "prop-section"), "Вложения"),
    emptyMark = bindTranslation(node("span", t(" · Пока пусто"), "attach-empty"), " · Пока пусто"),
    grid = node("div", undefined, "file-grid"),
    input = document.createElement("input"),
    add = bindTranslation(node("button", t("Добавить файл"), "secondary"), "Добавить файл");
  label.append(emptyMark);
  bindTranslation(add, "Перетащите файл сюда или выберите — до 10 файлов, каждый до 10 МБ.", "title");
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
          node("span", attachment.contentType === "application/pdf" ? "PDF" : t("ФАЙЛ"), "file-kind"),
        );
      }
      open.append(node("span", attachment.filename, "file-name"));
      open.addEventListener("click", () => previewAttachment(attachment));
      remove.type = "button";
      bindTranslation(remove, "Убрать вложение", "title");
      bindTranslation(remove, "Убрать {filename}", { filename: attachment.filename }, "aria-label");
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
        if (!response.ok) throw new Error(payload?.error?.message || t("Файл не приложился."));
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
// ── общее в карточке записи ──
// Карточка устроена как страница в Ноушене, и общее встаёт в неё тем же
// порядком: круг и исполнитель — строками свойств, обсуждение — последним
// блоком после заметки. Разговор о деле идёт вокруг того, что о нём написано.
function assignRow(entry, { onChange }) {
  const wrap = node("div", undefined, "assign-row");
  const select = node("select", undefined, "prop-input assign-pick");
  bindTranslation(select, "Исполнитель", "aria-label");
  const people = new Map();
  for (const circle of entry.myCircles || []) for (const member of circle.members || []) if (member.id !== (currentUser?.id ?? null)) people.set(member.id, { ...member, circleId: circle.id });
  select.append(new Option(t("— никому"), ""));
  for (const person of people.values()) select.append(new Option(person.name, person.id));
  select.value = entry.assignment && entry.assignment.state !== "declined" ? entry.assignment.assignee?.id || "" : "";
  const state = node("span", undefined, "assign-state");
  const paintState = () => {
    clear(state);
    if (!entry.assignment || entry.assignment.state === "declined") {
      if (entry.assignment?.state === "declined")
        state.append(node("span", `${entry.assignment.assignee?.name || t("Не взяли")} ${assignmentWord(entry.assignment)}${entry.assignment.reason ? `: «${entry.assignment.reason}»` : ""}`, "assign-declined"));
      return;
    }
    state.append(node("span", `— ${assignmentWord(entry.assignment)}`, "prop-origin"));
  };
  paintState();
  select.addEventListener("change", async () => {
    const assigneeId = select.value || null;
    const circleId = assigneeId ? people.get(assigneeId)?.circleId || null : null;
    try {
      const result = await request(`/api/captures/${entry.id}/assign`, { method: "POST", body: JSON.stringify({ assigneeId, circleId }) });
      entry.assignment = result.assignment;
      entry.circles = result.circles;
      paintState();
      toast(assigneeId ? t("Просьба ушла: {name} ответит «беру» или «не я»", { name: people.get(assigneeId).name }) : t("Исполнитель снят"));
      onChange?.();
      await load();
    } catch (error) { toast(error.message || t("Не получилось")); }
  });
  wrap.append(select, state);
  return wrap;
}
function circleRow(entry) {
  const wrap = node("div", undefined, "circle-value");
  const paint = () => {
    clear(wrap);
    const circles = entry.circles || [];
    if (!circles.length) { wrap.append(bindTranslation(node("span", t("только у вас"), "prop-ghost"), "только у вас")); return; }
    for (const circle of circles) wrap.append(circleChip(circle));
  };
  paint();
  return wrap;
}
// Позвать можно любого из ваших кругов, но не в пустоту: тому, кто записи или
// разговора ещё не видит, призыв их открывает — и об этом сказано до отправки.
const MENTION_GROUPS = { get record() { return t("в записи"); }, get room() { return t("в разговоре"); }, get circle() { return t("в круге"); }, get circles() { return t("из ваших кругов"); }, get everyone() { return t("все в Кизуне"); } };
// Кто и так на месте: этим призыв ничего не открывает, поэтому и приписки у них нет.
const MENTION_INSIDE = ["record", "room"];
function mentionPopup(field, callable, onPick, { lead = "", keys = false, note = t("увидит запись") } = {}) {
  const pop = node("div", undefined, "mention-pop");
  pop.hidden = true;
  let items = [], active = 0, from = -1;
  const close = () => { pop.hidden = true; from = -1; };
  const paint = (query) => {
    clear(pop);
    const needle = query.toLowerCase();
    items = callable.filter((person) => !needle || person.name.toLowerCase().startsWith(needle) || String(person.email || "").toLowerCase().startsWith(needle)).slice(0, 8);
    if (!items.length) { close(); return; }
    active = Math.min(active, items.length - 1);
    // Позвать того, кто запись ещё не видит, — значит показать её. В карточке
    // это сказано одной строкой сверху, а не у каждого имени.
    if (lead && items.some((person) => person.group && !MENTION_INSIDE.includes(person.group))) {
      const note = node("p", undefined, "mention-lead");
      note.append(talkIcon("eye"), document.createTextNode(lead));
      pop.append(note);
    }
    // В карточке записи люди идут группами: кто запись уже видит, люди из
    // ваших кругов и все остальные — позвать последних значит поделиться.
    let group = null;
    if (!items.some((person) => person.group)) pop.append(bindTranslation(node("p", t("призвать"), "mention-cap"), "призвать"));
    items.forEach((person, index) => {
      if (person.group && person.group !== group) {
        group = person.group;
        pop.append(node("p", MENTION_GROUPS[group] || t("призвать"), "mention-cap"));
      }
      const row = node("button", undefined, `mention-row${index === active ? " on" : ""}`);
      row.type = "button";
      row.append(avatarEl(person, { size: "mini" }), node("span", person.name));
      if (!lead && person.group && !MENTION_INSIDE.includes(person.group)) row.append(node("small", note, "mention-note"));
      row.addEventListener("mousedown", (event) => { event.preventDefault(); pick(index); });
      pop.append(row);
    });
    if (keys) {
      const hint = node("p", undefined, "mention-keys");
      hint.append(node("kbd", "↑"), " ", node("kbd", "↓"), t(" выбрать · "), node("kbd", "Enter"), t(" позвать · "), node("kbd", "Esc"), t(" закрыть"));
      pop.append(hint);
    }
    pop.hidden = false;
  };
  const pick = (index) => {
    const person = items[index];
    if (!person) return;
    const value = field.value, head = value.slice(0, from), tail = value.slice(field.selectionStart);
    field.value = `${head}@${person.name} ${tail}`;
    field.focus();
    field.selectionStart = field.selectionEnd = head.length + person.name.length + 2;
    close();
    onPick?.();
  };
  field.addEventListener("input", () => {
    const upto = field.value.slice(0, field.selectionStart);
    const match = upto.match(/@([\p{L}\p{N}_-]*)$/u);
    if (!match) { close(); return; }
    from = field.selectionStart - match[0].length;
    paint(match[1]);
  });
  field.addEventListener("keydown", (event) => {
    if (pop.hidden) return;
    if (event.key === "ArrowDown") { event.preventDefault(); active = (active + 1) % items.length; paint(field.value.slice(from + 1, field.selectionStart)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); active = (active - 1 + items.length) % items.length; paint(field.value.slice(from + 1, field.selectionStart)); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(active); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  field.addEventListener("blur", () => setTimeout(close, 120));
  return pop;
}
// Призыв в сообщении подсвечен: он не украшение, а единственное, что кладёт
// человеку строку в «к вам».
function commentText(body, mentions) {
  const wrap = node("div", undefined, "msg-text");
  const names = new Set((mentions || []).map((person) => person.name.toLowerCase()));
  const parts = String(body).split(/(@[\p{L}\p{N}_-]+)/u);
  for (const part of parts) {
    if (part.startsWith("@") && names.has(part.slice(1).toLowerCase())) wrap.append(node("span", part, "call"));
    else if (part) wrap.append(document.createTextNode(part));
  }
  return wrap;
}
// Обсуждение лежит у нижнего края карточки, как поле в мессенджере: кнопки
// «Обсудить» нет, позвать человека можно сразу. Пока сообщений нет, над полем
// ничего не выезжает — пустому листу неоткуда взяться. Сообщения встают над
// полем панелью по своей высоте, заметки сверху остаются на виду, а свёрнутый
// разговор — его последний пузырь. Пузыри — как в разговорах кругов: это тот
// же разговор, что в «Кругах → Записи».
// Открыли карточку по призыву — разговор сразу развернулся: звали ради него.
let cardTalkOnOpen = false;
// Поле и строка над ним занимают низ карточки: колонка оставляет под ними
// место, чтобы конец заметки и подвал не прятались за полем.
let cardTalkBaseObserver = null;
function dropCardTalk() {
  const dialog = $("#review-dialog");
  cardTalkBaseObserver?.disconnect();
  cardTalkBaseObserver = null;
  dialog.classList.remove("talk-open", "has-talk");
  dialog.style.removeProperty("--talk-base");
  dialog.querySelectorAll(".talk-dock").forEach((element) => element.remove());
}
const TALK_ICONS = {
  lock: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="7.1" width="8.8" height="6.3" rx="1.6"/><path d="M5.6 7.1V5.3a2.4 2.4 0 0 1 4.8 0v1.8"/></svg>',
  send: '<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.8V3.6M4 7.4 8 3.4l4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.2 8 10.2l4-4"/></svg>',
  up: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.8 8 5.8l4 4"/></svg>',
  eye: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 8s2.3-4.3 6.2-4.3S14.2 8 14.2 8s-2.3 4.3-6.2 4.3S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  bubble: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
  at: '<svg viewBox="0 0 16 16" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.4"/><path d="M10.4 5.8v2.9c0 1 .6 1.6 1.4 1.6.9 0 1.7-.8 1.7-2.3A5.5 5.5 0 1 0 11.3 12.4"/></svg>',
};
function talkIcon(name, className = "talk-icon") {
  const holder = node("span", undefined, className);
  holder.setAttribute("aria-hidden", "true");
  holder.innerHTML = TALK_ICONS[name];
  return holder;
}
// «Илья», «Илья и Аня», «Илья, Аня и Марк».
const talkNames = (names) => (names.length > 1 ? t("{value1} и {value2}", { value1: names.slice(0, -1).join(", "), value2: names[names.length - 1] }) : names[0] || "");
function cardDiscussion(entry) {
  let comments = entry.comments || [];
  let participants = entry.participants || [];
  // Сколько чужих сообщений новые: сервер считает до того, как открытие
  // отметит разговор прочитанным. Развернули — увидели, число гаснет.
  let unread = entry.unreadComments || 0;
  const callable = entry.callable || [];
  const openNow = cardTalkOnOpen;
  cardTalkOnOpen = false;
  const dialog = $("#review-dialog");
  // Карточка по ссылке может открыться раньше, чем приложение узнало, кто
  // вошёл: тогда свои реплики до ответа рисуются чужими и перерисовываются.
  let myId = currentUser?.id;
  const mine = entry.mine !== false;
  const author = mine ? null : entry.author;
  const dock = node("section", undefined, "talk-dock");
  dock.id = "card-talk";
  bindTranslation(dock, "Обсуждение", "aria-label");

  // Панель разговора: шапка, кто видит, сообщения.
  const panel = node("div", undefined, "talk-panel");
  panel.id = "card-talk-panel";
  const top = node("div", undefined, "talk-head");
  const head = node("h3", undefined, "talk-title");
  // Кто видит запись — всегда на виду: лица в шапке, по нажатию список, где
  // автор убирает позванных, а позванный может уйти сам.
  const whoButton = node("button", undefined, "talk-who");
  whoButton.type = "button";
  whoButton.setAttribute("aria-haspopup", "true");
  const whoMenu = node("div", undefined, "talk-people");
  whoMenu.hidden = true;
  const shut = node("button", undefined, "talk-close");
  shut.type = "button";
  bindTranslation(shut, "Свернуть · Esc", "title");
  bindTranslation(shut, "Свернуть обсуждение", "aria-label");
  shut.append(talkIcon("down"));
  top.append(head, whoButton, shut);
  const list = node("div", undefined, "thread-list");
  panel.append(top, whoMenu, list);

  // Под панелью: свёрнутый разговор пузырём, вопрос о доступе и само поле.
  const base = node("div", undefined, "talk-base");
  const peek = node("button", undefined, "talk-peek");
  peek.type = "button";
  bindTranslation(peek, "Развернуть обсуждение", "title");
  peek.setAttribute("aria-controls", panel.id);
  const confirm = node("div", undefined, "talk-confirm");
  confirm.hidden = true;
  const composer = node("div", undefined, "thread-composer");
  const field = node("textarea", undefined, "thread-input");
  field.rows = 1;
  bindTranslation(field, "Сообщение в обсуждение", "aria-label");
  const at = node("button", undefined, "talk-at");
  at.type = "button";
  at.append(talkIcon("at"));
  bindTranslation(at, "Позвать человека", "title");
  bindTranslation(at, "Позвать человека", "aria-label");
  const send = node("button", undefined, "talk-send");
  send.type = "button";
  bindTranslation(send, "Отправить · ⌘ + Enter", "title");
  bindTranslation(send, "Отправить", "aria-label");
  send.append(talkIcon("send"));
  base.append(peek, confirm, composer);
  dock.append(panel, base);

  // Все, кто видит запись, кроме меня: автор чужой записи, позванные и круг.
  const seers = () => {
    const people = new Map();
    if (author) people.set(author.id, author);
    for (const person of participants) people.set(person.id, person);
    for (const person of callable) if (person.group === "record") people.set(person.id, person);
    people.delete(myId);
    return [...people.values()];
  };
  const paintWho = () => {
    const others = seers();
    clear(whoButton);
    if (!others.length) { whoButton.append(talkIcon("lock"), bindTranslation(node("span", t("видите только вы")), "видите только вы")); whoButton.disabled = true; whoMenu.hidden = true; return; }
    whoButton.disabled = false;
    const faces = node("span", undefined, "talk-faces");
    for (const person of others.slice(0, 4)) faces.append(avatarEl(person, { size: "mini" }));
    const names = others.map((person) => person.name);
    const words = names.length === 1 ? t("вы и {value1}", { value1: names[0] }) : names.length <= 3 ? t("вы, {value1}", { value1: talkNames(names) }) : t("вы, {value1} и ещё {value2}", { value1: names[0], value2: names.length - 1 });
    whoButton.append(faces, node("span", words));
    clear(whoMenu);
    const row = (person, note, action) => {
      const line = node("div", undefined, "talk-person");
      line.append(avatarEl(person, { size: "mini" }), node("span", person.name, "talk-person-name"));
      if (action) {
        const button = node("button", note, "text-button talk-person-act");
        button.type = "button";
        button.addEventListener("click", action);
        line.append(button);
      } else line.append(node("small", note));
      whoMenu.append(line);
    };
    if (author) row(author, t("автор"));
    for (const person of participants) {
      if (person.id === myId) continue;
      row(person, mine ? t("убрать") : t("позван"), mine ? () => removePerson(person) : null);
    }
    const inRecord = new Set(participants.map((person) => person.id));
    for (const person of callable) if (person.group === "record" && !inRecord.has(person.id) && person.id !== author?.id) row(person, t("из круга"));
    if (!mine && participants.some((person) => person.id === myId)) {
      const leave = bindTranslation(node("button", t("Не следить — убрать запись у себя"), "text-button talk-leave"), "Не следить — убрать запись у себя");
      leave.type = "button";
      leave.addEventListener("click", () => removePerson({ id: myId }, { self: true }));
      whoMenu.append(leave);
    }
    whoMenu.append(bindTranslation(node("p", t("Позвать ещё — напишите @имя в сообщении"), "talk-people-hint"), "Позвать ещё — напишите @имя в сообщении"));
  };
  const removePerson = async (person, { self = false } = {}) => {
    try {
      const result = await request(`/api/captures/${entry.id}/people/${person.id}`, { method: "DELETE" });
      if (self) {
        toast(t("Запись убрана у вас: новый призыв вернёт её"));
        closeCard();
        load();
        return;
      }
      participants = result.participants;
      entry.participants = participants;
      toast(t("{name} больше не видит запись", { name: person.name }));
      paint();
    } catch (error) { toast(error.message || t("Не получилось")); }
  };
  whoButton.addEventListener("click", () => { whoMenu.hidden = !whoMenu.hidden; });

  const isOpen = () => dialog.classList.contains("talk-open");
  const toBottom = () => { list.scrollTop = list.scrollHeight; };
  const setOpen = (open, { focus = true } = {}) => {
    const next = open && comments.length > 0;
    const was = isOpen();
    dialog.classList.toggle("talk-open", next);
    peek.setAttribute("aria-expanded", String(next));
    if (next) {
      if (unread) { unread = 0; entry.unreadComments = 0; paintPeek(); }
      // Выезжает только то, что было свёрнуто: перерисовка развёрнутого
      // разговора не дёргает панель.
      if (!was) panel.classList.add("rise");
      toBottom();
      if (focus) field.focus({ preventScroll: true });
      return;
    }
    whoMenu.hidden = true;
    if (was && dock.contains(document.activeElement) && document.activeElement !== field) peek.focus({ preventScroll: true });
  };

  // Свёрнутый разговор — его последний пузырь, тот же, что внутри: своё
  // справа, чужое слева с лицом и именем. Рядом — сколько нового или сколько
  // ещё выше, а у единственной реплики только стрелка.
  const paintPeek = () => {
    clear(peek);
    const last = comments[comments.length - 1];
    if (!last) return;
    const out = last.author?.id === myId;
    peek.classList.toggle("out", out);
    const text = node("span", undefined, "talk-peek-text");
    if (!out) {
      const name = node("b", last.author?.name || t("Кто-то"), "talk-peek-name");
      name.style.color = `var(--circle-${kcNameTone(last.author?.id)})`;
      text.append(name);
    }
    text.append(document.createTextNode(String(last.body).replace(/\s+/g, " ")));
    const time = node("span", kcClock(last.createdAt), "talk-peek-time");
    if (out && typeof last.read === "boolean") time.append(readMark(last.read));
    const bubble = node("span", undefined, "talk-peek-bubble");
    bubble.append(text, time);
    const label = unread ? `${unread} ${pluralRu(unread, t("новое"), t("новых"), t("новых"))}` : comments.length > 1 ? t("ещё {value1}", { value1: comments.length - 1 }) : "";
    const more = node("span", undefined, `talk-peek-more${unread ? " new" : ""}${label ? "" : " bare"}`);
    if (label) more.append(node("span", label));
    more.append(talkIcon("up"));
    if (!out) peek.append(avatarEl(last.author));
    peek.append(bubble, more);
  };

  // Время и цвет имени — те же, что в разговорах кругов.
  const readMark = (read) => {
    const mark = kcReadMark(read);
    mark.className = `talk-read${read ? " on" : ""}`;
    return mark;
  };
  const reactChip = (comment, reaction) => {
    const chip = node("button", undefined, `talk-react${reaction.mine ? " mine" : ""}`);
    chip.type = "button";
    chip.title = (reaction.people || []).map((person) => person.name).join(", ");
    chip.setAttribute("aria-label", `${reaction.emoji} ${reaction.count}`);
    chip.append(document.createTextNode(reaction.emoji));
    if (reaction.count <= 2 && reaction.people?.length) {
      const faces = node("span", undefined, "talk-faces");
      for (const person of reaction.people.slice(0, 2)) faces.append(avatarEl(person, { size: "mini" }));
      chip.append(faces);
    } else chip.append(node("span", String(reaction.count)));
    chip.addEventListener("click", async () => {
      try {
        const result = await request(`/api/captures/${entry.id}/comments/${comment.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji: reaction.emoji }) });
        comment.reactions = result.reactions;
        paintList();
      } catch (error) { toast(error.message || t("Не получилось")); }
    });
    return chip;
  };
  const bubble = (comment, group) => {
    const wrap = node("div", undefined, "talk-bb-wrap");
    const box = node("div", undefined, "talk-bb");
    box.dataset.id = comment.id;
    if (!group.out && group.first) {
      const name = node("p", comment.author?.name || t("Кто-то"), "talk-name");
      if (author && comment.author?.id === author.id) name.append(bindTranslation(node("i", t("автор")), "автор"));
      name.style.color = `var(--circle-${kcNameTone(comment.author?.id)})`;
      box.append(name);
    }
    if (comment.replyTo) {
      const quote = node("div", undefined, "talk-quote");
      const whose = comment.replyTo.author ? (comment.replyTo.author.id === myId ? t("Вы") : comment.replyTo.author.name) : t("Сообщение");
      quote.append(node("b", whose), node("span", comment.replyTo.removed ? t("сообщение убрано") : comment.replyTo.body));
      box.append(quote);
    }
    const meta = node("span", kcClock(comment.createdAt), "talk-meta");
    if (group.out && typeof comment.read === "boolean") meta.append(readMark(comment.read));
    box.append(commentText(comment.body, comment.mentions));
    const reactions = (comment.reactions || []).filter((reaction) => reaction.count);
    if (reactions.length) {
      const row = node("div", undefined, "talk-reacts");
      row.append(...reactions.map((reaction) => reactChip(comment, reaction)), meta);
      box.append(row);
    } else box.append(meta);
    wrap.append(box);
    // Из сообщения делается дело: пересказывать в поле то, что уже написано,
    // дороже, чем нажать кнопку.
    if (callable.length || comment.mentions.length) {
      const deed = bindTranslation(node("button", t("В дело"), "talk-deed"), "В дело");
      deed.type = "button";
      deed.addEventListener("click", () => {
        prefillCapture(comment.body.replace(/@[\p{L}\p{N}_-]+/gu, "").trim(), "todo");
        closeCard();
      });
      wrap.append(deed);
    }
    return wrap;
  };
  // Строка «Аня — в обсуждении» стоит в ленте там, где человека позвали:
  // видно, с какого места он читает разговор вместе со всеми.
  const paintList = () => {
    const scrolled = list.scrollTop;
    clear(list);
    const joins = participants.map((person) => ({ at: person.addedAt, person }));
    const timeline = [...comments.map((comment) => ({ at: comment.createdAt, comment })), ...joins].sort((left, right) => left.at.localeCompare(right.at) || (left.person ? -1 : 0) - (right.person ? -1 : 0));
    let day = null, group = null;
    for (const item of timeline) {
      const itemDay = zoneDate(new Date(item.at));
      if (itemDay !== day) { day = itemDay; group = null; list.append(node("p", kcDayLabel(day), "talk-day")); }
      if (item.person) {
        group = null;
        const joined = node("p", undefined, "talk-joined");
        joined.append(avatarEl(item.person, { size: "mini" }), bindTranslation(node("span", t("{value1} — в обсуждении", { value1: item.person.id === myId ? t("Вы") : item.person.name })), "{value1} — в обсуждении", { value1: item.person.id === myId ? t("Вы") : item.person.name }));
        list.append(joined);
        continue;
      }
      const by = item.comment.author?.id;
      if (!group || group.by !== by) {
        const out = by === myId;
        const row = node("div", undefined, `talk-grp${out ? " out" : ""}`);
        if (!out) row.append(avatarEl(item.comment.author));
        const stack = node("div", undefined, "talk-bubbles");
        row.append(stack);
        list.append(row);
        group = { by, out, stack, first: true };
      }
      group.stack.append(bubble(item.comment, group));
      group.first = false;
    }
    list.scrollTop = scrolled;
  };
  // «Отправить» появляется с первой буквой: пока писать нечего, самым заметным
  // внизу карточки был серый круг.
  let sending = false;
  const paintField = () => {
    send.hidden = !field.value.trim();
    send.disabled = sending;
  };
  const paint = () => {
    const count = comments.length;
    clear(head);
    head.append(document.createTextNode(t("Обсуждение")), node("span", String(count), "talk-count"));
    paintWho();
    paintPeek();
    paintList();
    panel.hidden = !count;
    peek.hidden = !count;
    at.hidden = !callable.length;
    // Пока запись видите только вы, реплика — себе: об этом говорит поле, а не
    // отдельная метка с замком.
    const alone = !seers().length;
    field.placeholder = count ? t("Сообщение") : callable.length ? t("Написать{value1} или позвать через @", { value1: alone ? t(" себе") : "" }) : alone ? t("Написать себе…") : t("Написать…");
    paintField();
    if (!count) dialog.classList.remove("talk-open");
  };

  // Позвать того, кто запись ещё не видит, — значит поделиться ею. Сервер
  // отвечает share_needed, и над полем встаёт карточка с выбором: журнал
  // личный, молча он не открывается никому.
  const askShare = (people, body) => {
    clear(confirm);
    const names = people.map((person) => person.name);
    const many = names.length > 1;
    const text = node("div", undefined, "talk-confirm-text");
    text.append(
      bindTranslation(node("b", t("{value1} пока не {value2} эту запись", { value1: talkNames(names), value2: many ? t("видят") : t("видит") })), "{value1} пока не {value2} эту запись", { value1: talkNames(names), value2: many ? t("видят") : t("видит") }),
      bindTranslation(node("p", t("Отправите с призывом — {value1} заголовок, заметки, файлы и весь разговор, включая прошлые сообщения.", { value1: many ? t("они увидят") : t("увидит") })), "Отправите с призывом — {value1} заголовок, заметки, файлы и весь разговор, включая прошлые сообщения.", { value1: many ? t("они увидят") : t("увидит") }),
    );
    const acts = node("div", undefined, "talk-confirm-acts");
    const go = bindTranslation(node("button", t("Позвать и отправить"), "talk-btn is-go"), "Позвать и отправить");
    const quiet = bindTranslation(node("button", t("Без призыва"), "talk-btn"), "Без призыва");
    const edit = bindTranslation(node("button", t("Изменить"), "talk-btn is-bare"), "Изменить");
    for (const button of [go, quiet, edit]) button.type = "button";
    go.addEventListener("click", () => submit("yes", body));
    quiet.addEventListener("click", () => submit("no", body));
    edit.addEventListener("click", () => { confirm.hidden = true; field.focus(); });
    acts.append(go, quiet, edit);
    text.append(acts);
    confirm.append(talkIcon("eye", "talk-confirm-icon"), text);
    confirm.hidden = false;
    go.focus();
  };
  const submit = async (share = null, sameBody = null) => {
    const body = sameBody ?? field.value.trim();
    if (!body || sending) return;
    sending = true;
    send.disabled = true;
    try {
      const response = await fetch(`/api/captures/${entry.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(share ? { body, share } : { body }) });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { location.replace("/login"); return; }
      if (response.status === 409 && data?.error?.code === "share_needed") { askShare(data.people || [], body); return; }
      if (!response.ok) throw new Error(data?.error?.message || t("Сообщение не ушло"));
      confirm.hidden = true;
      comments = [...comments, data.comment];
      entry.comments = comments;
      participants = data.participants || participants;
      entry.participants = participants;
      field.value = "";
      cardDrafts.delete(entry.id);
      field.style.height = "auto";
      paint();
      setOpen(true, { focus: false });
      if (data.comment.mentions.length) toast(t("Позвали: {value1}", { value1: talkNames(data.comment.mentions.map((person) => person.name)) }));
    } catch (error) { toast(error.message || t("Сообщение не ушло")); }
    finally { sending = false; paintField(); if (confirm.hidden) field.focus({ preventScroll: true }); }
  };
  send.addEventListener("click", () => submit());
  field.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
  });
  field.addEventListener("input", () => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
    // Черновик переживает переход в подзадачу и обратно.
    if (field.value.trim()) cardDrafts.set(entry.id, field.value);
    else cardDrafts.delete(entry.id);
    paintField();
  });
  if (cardDrafts.has(entry.id)) {
    field.value = cardDrafts.get(entry.id);
    requestAnimationFrame(() => { field.style.height = "auto"; field.style.height = `${Math.min(field.scrollHeight, 200)}px`; paintField(); });
  }
  // Пишут — значит читают: свёрнутый разговор разворачивается над полем.
  field.addEventListener("focus", () => setOpen(true, { focus: false }));
  field.addEventListener("click", () => { if (!isOpen()) setOpen(true, { focus: false }); });
  peek.addEventListener("click", () => setOpen(true));
  shut.addEventListener("click", () => setOpen(false));
  // «@» — тот же призыв, что набранный руками: подсказка открывается сама.
  // Кнопка не забирает фокус у поля, иначе подсказка закрылась бы на blur.
  at.addEventListener("mousedown", (event) => event.preventDefault());
  at.addEventListener("click", () => {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const before = field.value.slice(0, start);
    const insert = before && !/\s$/.test(before) ? " @" : "@";
    field.value = `${before}${insert}${field.value.slice(end)}`;
    field.focus();
    field.selectionStart = field.selectionEnd = start + insert.length;
    field.dispatchEvent(new Event("input"));
  });
  const pop = mentionPopup(field, callable, paintField, { get lead() { return t("Позванный увидит эту запись и разговор"); }, keys: true });
  composer.append(field, at, send, pop);
  // Верхняя кромка поля тянется: высота одна на все карточки (kizuna-card-talk-height).
  const grip = node("div", undefined, "talk-resize");
  grip.setAttribute("aria-hidden", "true");
  attachTalkResize(grip, composer);
  composer.append(grip);

  // Карточка перерисовывается после правки свойств — развёрнутый разговор
  // остаётся на месте, если это та же запись.
  const keep = isOpen() && dialog.dataset.talkFor === entry.id;
  dropCardTalk();
  dialog.dataset.talkFor = entry.id;
  (dialog.querySelector(".card-main") || dialog).append(dock);
  dialog.classList.add("has-talk");
  // Свёрнутый разговор стоит над полем пузырём, развёрнутый его прячет: окно по
  // содержимому от этого не должно вздрагивать, поэтому место под пузырь
  // остаётся в запасе, пока разговор развёрнут.
  let peekRoom = 0;
  cardTalkBaseObserver = frameResizeObserver(() => {
    if (!base.isConnected) return;
    const open = dialog.classList.contains("talk-open");
    if (!open && getComputedStyle(peek).display !== "none") peekRoom = peek.offsetHeight + 10;
    const size = `${Math.ceil(base.offsetHeight + (open ? peekRoom : 0))}px`;
    if (dialog.style.getPropertyValue("--talk-base") !== size) dialog.style.setProperty("--talk-base", size);
  });
  cardTalkBaseObserver.observe(base);
  paint();
  if (!myId) accountKnown.then((user) => { if (!dock.isConnected || !user) return; myId = user.id; paint(); });
  // Та же запись после перерисовки — разговор уже на месте, без выезда и без
  // кражи фокуса у того, кто правил свойства.
  if (keep && comments.length) { dialog.classList.add("talk-open"); peek.setAttribute("aria-expanded", "true"); requestAnimationFrame(toBottom); }
  else if (openNow) requestAnimationFrame(() => setOpen(true));
  // Строка из списка приходит без обсуждения: ни реплик, ни тех, кого можно
  // позвать, — «@» молчал, а разговор казался пустым. Такая карточка догружает
  // его сама; список людей меняется на месте — его держит подсказка «@».
  if (!entry.callable) {
    request(`/api/captures/${entry.id}/comments`).then((data) => {
      if (!dock.isConnected) return;
      const stayOpen = isOpen();
      comments = data.comments || [];
      participants = data.participants || [];
      unread = stayOpen ? 0 : data.unread || 0;
      entry.unreadComments = unread;
      callable.splice(0, callable.length, ...(data.callable || []));
      entry.comments = comments;
      entry.participants = participants;
      paint();
      if (stayOpen) setOpen(true, { focus: false });
    }).catch(() => {});
  }
}
// Тело заметки — отдельная пользовательская сущность, а не правка raw:
// контракт памяти запрещает менять источник, поэтому оно версионируется
// на сервере со ссылкой supersedes.
function cardBody(entry) {
  const wrap = node("section", undefined, "card-body"),
    hint = bindTranslation(node("p", t("Markdown оформляется прямо в тексте · ⌘/Ctrl + Enter — сохранить · закроете карточку — сохранится само"), "card-body-hint"), "Markdown оформляется прямо в тексте · ⌘/Ctrl + Enter — сохранить · закроете карточку — сохранится само"),
    label = bindTranslation(node("p", t("Заметка"), "prop-section"), "Заметка");
  // Описание пишет разбор из текста записи и кладёт первой версией заметки. Нет
  // заметки — поле пустое, с подсказкой «Описание»: копия исходного текста тут
  // только дублировала бы то, что лежит в свёрнутом «Исходном тексте» ниже.
  let body = entry.note?.body ?? "";
  // Тело — то же живое поле, что и в карточке ввода: разметка оформляется
  // прямо в тексте, поэтому отдельный режим просмотра и предпросмотр больше
  // не нужны — читать и править можно в одном месте.
  const field = createMarkdownField({
    id: "card-body-editor",
    get ariaLabel() { return t("Описание"); },
    get placeholder() { return t("Описание"); },
    onSubmit: () => save(),
  });
  field.element.classList.add("card-markdown");
  // Разметку помнить наизусть незачем: «/» показывает, что тут вообще бывает.
  closeCardSlashMenu?.();
  const slashMenu = attachSlashMenu(field);
  // После «[[» — страницы из «Заметок» на выбор: название помнить не нужно.
  const linkMenu = attachLinkMenu(field, { exclude: () => entry.id });
  // Панель оформления живёт столько же, сколько поле: убирается вместе с меню.
  const formatBar = attachFormatToolbar(field, { prefs: window.pagentText });
  closeCardSlashMenu = () => { slashMenu.destroy(); formatBar.destroy(); linkMenu.destroy(); closeCardSlashMenu = null; };
  field.setValue(body);
  // Подсказка не прячется, а гаснет: строка под полем остаётся на месте, и
  // blur перед нажатием на подзадачу не сдвигает кнопку из-под курсора.
  const showHint = (shown) => hint.classList.toggle("shown", shown);
  showHint(false);

  // Отключение поля снимает фокус и вызывает blur, а тот сохраняет: пока
  // сохранение идёт, второй вызов получает то же обещание — переход к
  // подзадаче дожидается именно его.
  let inflight = null;
  const save = () => {
    if (inflight) return inflight;
    const next = field.getValue();
    if (next === body) return Promise.resolve();
    // Обещание записывается раньше, чем поле выключится: выключение снимает
    // фокус, blur зовёт save() снова — и получает то же обещание.
    inflight = Promise.resolve().then(async () => {
      field.setDisabled(true);
      try {
        const result = await request(`/api/captures/${entry.id}/notes`, {
          method: "POST",
          body: JSON.stringify({ body: next }),
        });
        body = result.entry.note?.body || "";
        entry.note = result.entry.note;
        field.setValue(body);
        toast(t("Заметка сохранена"));
        await load();
      } catch (error) {
        toast(error.message);
      } finally {
        inflight = null;
        field.setDisabled(false);
      }
    });
    return inflight;
  };
  field.element.addEventListener("focus", () => {
    showHint(true);
  });
  // Esc не откатывает набранное: раньше он возвращал прежний текст, и правка,
  // сделанная перед закрытием карточки, пропадала. Теперь он просто уводит
  // фокус — на blur заметка сохраняется, как и при закрытии.
  field.element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      showHint(false);
      field.element.blur();
      // Модальную карточку закрывает сам Esc, минуя этот слушатель; у обычного
      // окна («сбоку») он его не видит — закрываем по тем же слоям отсюда.
      if (!$("#review-dialog").matches(":modal")) { event.preventDefault(); if (!cardEscape()) closeCard(); }
    }
  });
  field.element.addEventListener("blur", () => {
    showHint(false);
    save();
  });
  flushCardBody = save;
  wrap.append(label, field.element, hint);
  return wrap;
}
// Карточка открывается модальным окном, а не панелью внутри страницы: панель
// жила в разделе «Сегодня» и на страницах журнала строилась на скрытой
// странице — кнопка срабатывала, но человек не видел ничего.
// ── кружок в карточке: «Отметил — следующее» ────────────────────────────────
// Кружок у названия закрывает дело сразу, как кружок в «Дне». Карточку открыли
// из списка («День», «Доска», календарь) — список едет с ней: отмеченное
// через мгновение сменяется следующим открытым, а ∧ ∨ и K / J листают соседние.
// Открыли по ссылке, из колокольчика или поиска — листать нечего, отмеченная
// карточка остаётся на месте со строкой «Сделано».
let cardList = null;
let pendingCardList = null;
let cardAdvance = null;
let cardArmedUntil = 0;
let cardSnackTimer = null;
const cardKeys = { toggle: null };
const CARD_LIST_DONE = { get "Сегодня"() { return t("На «Сегодня» всё отмечено"); }, get "Сделано"() { return t("В «Сделано» всё отмечено"); }, get "Закрыто"() { return t("В «Закрыто» всё отмечено"); }, get "День"() { return t("В «Дне» всё отмечено"); }, get "Доска"() { return t("На «Доске» всё отмечено"); }, get "Календарь"() { return t("В календаре всё отмечено"); } };
const CARD_TICK_ICON = '<svg class="card-tick-check" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.8 8.4l2.7 2.7 5.7-6.2"/></svg>';
const CARD_CLOCK_ICON = '<svg class="card-tick-hands" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4.6V8l2.3 1.5"/></svg>';
const CARD_REPEAT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 7.2A4.6 4.6 0 0 1 11.6 5"/><path d="M12.8 8.8A4.6 4.6 0 0 1 4.4 11"/><path d="M11.8 2.4V5H9.2"/><path d="M4.2 13.6V11h2.6"/></svg>';
const rowsAsList = (rows) => rows.map((row) => ({ id: row.dataset.captureId, occurrence: row.dataset.occurrence || null }));
function adoptCardList(entry, fresh) {
  if (fresh) {
    const pending = pendingCardList;
    pendingCardList = null;
    cardList = null;
    if (!pending) return;
    const exact = pending.items.findIndex((item) => item.id === pending.id && (item.occurrence || null) === (pending.occurrence || null));
    const index = exact >= 0 ? exact : pending.items.findIndex((item) => item.id === pending.id);
    if (index >= 0) cardList = { label: pending.label, items: pending.items, index };
    return;
  }
  if (cardList && cardList.items[cardList.index]?.id !== entry.id) {
    const index = cardList.items.findIndex((item) => item.id === entry.id);
    if (index >= 0) cardList.index = index;
    else cardList = null;
  }
}
// Верхняя строка карточки. У корневой записи слева — список, из которого её
// открыли («День · 2 из 8»), справа — стрелки к соседям. У подзадачи слева
// «← родитель» и уровень, стрелок нет: соседей листает только корень.
function paintCardNav({ finished = false, entry = null } = {}) {
  const crumb = $("#review-crumb"), slot = $("#review-nav"), close = $("#review-close");
  clear(crumb);
  clear(slot);
  if (cardStack.length) {
    const frame = cardStack.at(-1);
    const parentTitle = entry?.parent?.title || frame.title || t("Без названия");
    const back = node("button", undefined, "card-return");
    back.type = "button";
    back.title = cardStack.map((item) => item.title).filter(Boolean).join(" / ") || parentTitle;
    bindTranslation(back, "Назад к задаче «{parentTitle}»", { parentTitle: parentTitle }, "aria-label");
    back.append(node("span", "←", "card-return-arrow"), node("span", parentTitle, "card-return-label"));
    back.addEventListener("click", () => goBackCard());
    crumb.append(back, bindTranslation(node("span", t("Уровень {value1}", { value1: cardStack.length + 1 }), "card-depth"), "Уровень {value1}", { value1: cardStack.length + 1 }));
    bindTranslation(close, "Вернуться к «{parentTitle}»", { parentTitle: parentTitle }, "title");
    bindTranslation(close, "Закрыть подзадачу и вернуться к родительской", "aria-label");
    return;
  }
  close.title = "";
  bindTranslation(close, "Закрыть карточку", "aria-label");
  const column = node("b", cardMenu.columnName, "card-nav-col");
  column.hidden = !cardMenu.columnName;
  if (!cardList) {
    if (entry) {
      const date = entry.interpretation?.classification?.entities?.schedule?.date;
      const day = date === (currentDayDate || zoneDate(new Date())) ? t("Сегодня") : date ? scheduleLabel({ state: "ok", date }) : t("Задача");
      crumb.append(node("i", undefined, "card-crumb-dot"), column, node("span", day, "card-crumb-word"));
    }
    return;
  }
  const nav = node("span", undefined, "card-nav");
  const label = node("span", undefined, "card-nav-crumb");
  label.append(node("b", cardList.label), document.createTextNode(finished ? t(" · всё отмечено") : t(" · {value1} из {length}", { value1: cardList.index + 1, length: cardList.items.length })));
  nav.append(node("i", undefined, "card-crumb-dot"), label);
  crumb.append(column, nav);
  const step = (direction, label, icon) => {
    const button = node("button", undefined, "card-nav-step");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
    const target = cardList.index + direction;
    button.disabled = finished ? direction > 0 : target < 0 || target >= cardList.items.length;
    button.addEventListener("click", () => stepCard(direction));
    return button;
  };
  slot.append(step(-1, t("Предыдущее · K"), TALK_ICONS.up), step(1, t("Следующее · J"), TALK_ICONS.down));
}
// Панель «Параметры» выезжает справа из той же карточки: ширина карточки
// растёт, колонка содержимого остаётся прежней, и всё вместе снова встаёт по
// центру. Закрытая панель не принимает фокус (inert) — Tab её не находит.
// Закрытая панель не занимает места совсем (display: none): иначе её содержимое
// тянуло бы высоту окна, которая теперь считается по содержимому. Она прячется
// после ухода — когда ширина доехала до нуля.
let cardParamsHide = 0;
function setCardParams(open, { instant = false, focus = null } = {}) {
  const dialog = $("#review-dialog"), panel = $("#review-params"), toggle = $("#review-params-toggle");
  cardParamsOpen = Boolean(open);
  const quick = instant || !motionAllowed();
  clearTimeout(cardParamsHide);
  dialog.classList.toggle("params-instant", quick);
  if (cardParamsOpen) {
    panel.hidden = false;
    // Начальная ширина закрепляется до перехода, иначе панель появилась бы сразу.
    void panel.offsetWidth;
  } else if (quick) panel.hidden = true;
  else cardParamsHide = setTimeout(() => { if (!cardParamsOpen) panel.hidden = true; }, 320);
  dialog.classList.toggle("params-open", cardParamsOpen);
  toggle.setAttribute("aria-expanded", String(cardParamsOpen));
  toggle.classList.toggle("open", cardParamsOpen);
  if (cardParamsOpen) panel.removeAttribute("inert");
  else panel.setAttribute("inert", "");
  const shell = dialog.querySelector(".card-shell");
  // На узком экране панель не помещается рядом: дорожка карточки уезжает к
  // ней, а при закрытии возвращается к содержимому.
  const slide = () => {
    if (!shell) return;
    const behavior = instant || !motionAllowed() ? "instant" : "smooth";
    if (cardParamsOpen && shell.scrollWidth > shell.clientWidth) shell.scrollTo({ left: shell.scrollWidth - shell.clientWidth, behavior });
    else if (!cardParamsOpen) shell.scrollTo({ left: 0, behavior });
  };
  if (cardParamsOpen) {
    // На телефоне ширина не анимируется — движется сама дорожка, одним ходом.
    if (instant || !motionAllowed() || CARD_PHONE.matches) slide();
    else setTimeout(slide, 300);
    if (focus) focus.focus({ preventScroll: true });
  } else {
    slide();
    // Фокус из закрытой панели уходит на кнопку, которая её открыла.
    if (panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  }
}
// Подзадача открывается в той же карточке: текущая запись уходит в стек с
// прокруткой и строкой, из которой пришли, набранное сохраняется на сервере.
async function openSubtaskCard(childId, occurrence = null) {
  const area = $("#review");
  if (!cardEntryId) return;
  const frame = { id: cardEntryId, childId, scrollTop: area.scrollTop, occurrence: cardOccurrence, title: $("#review .card-title")?.textContent?.trim() || "" };
  // Повторяющийся шаг открывается на тот день серии, что показан в дереве.
  const entry = await renderCardEntry(childId, () => { cardStack.push(frame); cardOccurrence = occurrence; });
  if (!entry) return;
  area.scrollTop = 0;
  if (motionAllowed()) appear(area, { shift: 12 });
  requestAnimationFrame(() => $("#review .card-title")?.focus({ preventScroll: true }));
}
async function goBackCard() {
  if (!cardStack.length) return;
  const frame = cardStack.at(-1);
  const area = $("#review");
  const entry = await renderCardEntry(frame.id, () => { cardStack.pop(); cardOccurrence = frame.occurrence || null; });
  if (!entry) return;
  area.scrollTop = frame.scrollTop || 0;
  if (motionAllowed()) appear(area, { shift: -8 });
  requestAnimationFrame(() => {
    const row = frame.childId ? area.querySelector(`[data-task-id="${CSS.escape(frame.childId)}"] .subtask-open, [data-tree-id="${CSS.escape(frame.childId)}"] .tree-open`) : null;
    (row || $("#review .card-title"))?.focus({ preventScroll: true });
  });
}
// Крестик и Esc у подзадачи ведут к родителю, у корня — закрывают карточку.
function requestCardClose() {
  if (cardStack.length) goBackCard();
  else closeCard();
}
// Другая запись встаёт в открытую карточку: набранное уходит на сервер,
// разговор и меню прежней записи убираются, стек меняется между запросом и
// отрисовкой — чтобы неудачный запрос не сдвинул его.
async function renderCardEntry(id, adjustStack = () => {}) {
  const token = ++cardNavToken;
  clearTimeout(cardAdvance);
  cardAdvance = null;
  // Сначала набранное уходит на сервер, потом читается следующая запись:
  // вернувшись к родителю, человек видит свою правку, а не прежний текст.
  await flushCard();
  let entry;
  try { entry = (await request(`/api/captures/${encodeURIComponent(id)}`)).entry; }
  catch (error) { if (token === cardNavToken) cardSnack(error.message || t("Запись не открылась")); return null; }
  if (token !== cardNavToken || !$("#review-dialog").open) return null;
  closeCardSlashMenu?.();
  dropCardTalk();
  cardOccurrence = null;
  adjustStack();
  const review = reviewFromEntry(entry);
  showCardInner(entry, review.level === "high" ? undefined : review);
  window.KizunaTelemetry?.emit('card_opened', { captureId: entry.id });
  keepCardFocus();
  return entry;
}
function cardSnack(text, actions = []) {
  const dialog = $("#review-dialog");
  dialog.querySelector(".card-snack")?.remove();
  clearTimeout(cardSnackTimer);
  const snack = node("div", undefined, "card-snack");
  snack.setAttribute("role", "status");
  snack.append(node("span", text, "card-snack-text"));
  for (const { label, run } of actions) {
    const button = node("button", label, "card-snack-act");
    button.type = "button";
    button.addEventListener("click", async () => {
      snack.remove();
      clearTimeout(cardSnackTimer);
      try { await run(); } catch (error) { cardSnack(error.message || t("Не получилось")); }
    });
    snack.append(button);
  }
  dialog.append(snack);
  cardSnackTimer = setTimeout(() => snack.remove(), actions.length ? 6000 : 3000);
}
function dropCardFlow() {
  cardWorkspace?.dispose();
  cardWorkspace = null;
  clearTimeout(cardAdvance);
  cardAdvance = null;
  clearTimeout(cardSnackTimer);
  cardList = null;
  pendingCardList = null;
  cardArmedUntil = 0;
  cardKeys.toggle = null;
  const dialog = $("#review-dialog");
  dialog.querySelector(".card-nav")?.remove();
  dialog.querySelector(".card-snack")?.remove();
  dialog.classList.remove("armed");
}
async function stepCard(direction) {
  if (!cardList || cardStack.length) return;
  const target = cardList.index + direction;
  if (target < 0 || target >= cardList.items.length) return;
  await openCardFromList(target);
}
// Соседняя карточка встаёт на место текущей: набранное в заметке и свойствах
// уходит на сервер, разговор и меню прежней записи убираются.
async function openCardFromList(index, { armed = false } = {}) {
  clearTimeout(cardAdvance);
  cardAdvance = null;
  const item = cardList?.items[index];
  if (!item) return;
  let entry;
  try { entry = (await request(`/api/captures/${encodeURIComponent(item.id)}`)).entry; }
  catch (error) { cardSnack(error.message || t("Запись не открылась")); return; }
  if (!cardList || !$("#review-dialog").open) return;
  flushCard();
  closeCardSlashMenu?.();
  dropCardTalk();
  cardList.index = index;
  cardOccurrence = item.occurrence || null;
  const dialog = $("#review-dialog");
  // Новое дело встаёт под курсор: первые 350 мс оно не принимает нажатий, и
  // двойной клик по кружку не закроет его заодно с прежним.
  if (armed) {
    cardArmedUntil = Date.now() + 350;
    dialog.classList.add("armed");
    setTimeout(() => dialog.classList.remove("armed"), 350);
  }
  const review = reviewFromEntry(entry);
  showCardInner(entry, review.level === "high" ? undefined : review);
  const area = $("#review");
  area.scrollTop = 0;
  if (motionAllowed()) appear(area, { shift: 12 });
  keepCardFocus();
}
// Перерисовка карточки убирает элемент, на котором стоял фокус: без этого
// клавиши E и K / J переставали работать после первого же нажатия мышью.
function keepCardFocus() {
  const dialog = $("#review-dialog");
  if (dialog.open && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
}
function openForList(entry, occurrence) {
  if (!entry || isReportedWork(entry)) return false;
  if (!completableProjections(entry).length) return needsClarification(entry);
  if (isClosed(entry)) return false;
  return occurrence && scheduleOf(entry)?.repeat ? scheduledOn(entry, occurrence) : true;
}
async function nextOpenInList(from) {
  if (!cardList) return -1;
  const indexes = [...cardList.items.keys()];
  for (const index of [...indexes.filter((i) => i > from), ...indexes.filter((i) => i < from)]) {
    const item = cardList.items[index];
    let entry = todayState.entries.find((candidate) => candidate.id === item.id);
    if (!entry) {
      try { entry = (await request(`/api/captures/${encodeURIComponent(item.id)}`)).entry; }
      catch { continue; }
    }
    if (openForList(entry, item.occurrence)) return index;
  }
  return -1;
}
async function advanceCardFrom(from, snack = null) {
  cardAdvance = null;
  if (!cardList || cardList.index !== from) return;
  const next = await nextOpenInList(from);
  if (!cardList || cardList.index !== from) return;
  if (next < 0) paintCardFinish();
  else await openCardFromList(next, { armed: true });
  if (snack) cardSnack(snack.text, snack.actions);
}
function paintCardFinish() {
  flushCard();
  closeCardSlashMenu?.();
  dropCardTalk();
  cardKeys.toggle = null;
  const area = $("#review");
  clear(area);
  const box = node("div", undefined, "card-finish");
  const mark = node("span", undefined, "card-tick is-done big");
  mark.innerHTML = CARD_TICK_ICON;
  const close = bindTranslation(node("button", t("Закрыть"), "card-finish-close"), "Закрыть");
  close.type = "button";
  close.addEventListener("click", () => closeCard());
  box.append(mark, node("h2", Object.entries(CARD_LIST_DONE).find(([source]) => t(source) === cardList?.label)?.[1] || t("Всё отмечено"), "card-finish-title"), bindTranslation(node("p", t("Открытых дел и встреч в этом списке не осталось."), "card-finish-sub"), "Открытых дел и встреч в этом списке не осталось."), close);
  area.append(box);
  paintCardNav({ finished: true });
  if (motionAllowed()) appear(area, { shift: 12 });
  close.focus({ preventScroll: true });
}
// Что с делом сейчас: закрыто целиком, закрыт показанный день серии или открыто.
function cardDoneState(entry, shownOccurrence = cardOccurrence) {
  const c = entry.interpretation.classification;
  const schedule = scheduleOf(entry);
  const projections = completableProjections(entry);
  const today = currentDayDate || zoneDate(new Date());
  const closed = isClosed(entry);
  const skip = schedule?.skip || [];
  const occurrence = schedule?.repeat && schedule.date && !closed
    ? (shownOccurrence || (skip.includes(today) || scheduledOn(entry, today) ? today : nextRepeatDate(schedule, today)))
    : null;
  const occurrenceDone = Boolean(occurrence && skip.includes(occurrence));
  const assignment = entry.assignment || todayState.assignments?.[entry.id] || null;
  const taken = Boolean(currentUser && assignment?.assignee?.id === currentUser.id && ["accepted", "done"].includes(assignment.state));
  const completedAt = closed ? projections.map((projection) => projection.completion?.completedAt).filter(Boolean).sort().at(-1) || null : null;
  return { c, schedule, projections, closed, occurrence, occurrenceDone, done: closed || occurrenceDone, taken, assignment, own: entry.mine !== false, completedAt, meeting: c.primaryType === "meeting_event", today };
}
// Кружок есть у своего дела и встречи и у дела, взятого у человека из круга.
const cardHasTick = (entry, state) => state.projections.length > 0 && !isReportedWork(entry) && (state.own || state.taken);
function cardDoneWords(state) {
  if (state.occurrenceDone) return state.occurrence === state.today ? t("Готово на сегодня") : t("Готово на {value1}", { value1: scheduleLabel({ state: "ok", date: state.occurrence, time: null }) });
  const verb = state.meeting ? t("Прошла") : t("Сделано");
  if (!state.completedAt) return verb;
  const day = notifyDay(state.completedAt);
  const when = day === state.today ? t("сегодня") : day === shiftDate(state.today, -1) ? t("вчера") : `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return t("{verb} {when} в {value3}", { verb: verb, when: when, value3: notifyClock(state.completedAt) });
}
async function setCardDone(entry, state, completing) {
  if (state.occurrence) {
    // Повтор: отметка — про показанный день, серия живёт дальше.
    const projectionId = state.projections.find((item) => item.type === "task")?.id || completableProjections(entry)[0]?.id;
    await request(`/api/projections/${projectionId}/${completing ? "complete" : "undo-complete"}`, { method: "POST", body: JSON.stringify({ occurrence: state.occurrence }) });
    return;
  }
  const { entry: current } = await request(`/api/captures/${entry.id}`);
  for (const projection of completableProjections(current).filter((item) => Boolean(item.completion?.completed) !== completing))
    await request(`/api/projections/${projection.id}/${completing ? "complete" : "undo-complete"}`, { method: "POST", body: "{}" });
}
async function rerenderCard(entryId) {
  let entry;
  try { entry = (await request(`/api/captures/${encodeURIComponent(entryId)}`)).entry; }
  catch (error) { cardSnack(error.message || t("Запись не открылась")); return null; }
  if (!$("#review-dialog").open) return null;
  flushCard();
  closeCardSlashMenu?.();
  const review = reviewFromEntry(entry);
  showCardInner(entry, review.level === "high" ? undefined : review);
  keepCardFocus();
  return entry;
}
async function toggleCardDone(entry, state, saveFirst = null) {
  if (Date.now() < cardArmedUntil) return;
  clearTimeout(cardAdvance);
  cardAdvance = null;
  const completing = !state.done;
  const tick = $("#review .card-tick");
  if (tick) {
    tick.disabled = true;
    tick.classList.toggle("is-done", completing);
    if (completing) tick.classList.add("just");
    $("#review .card-title")?.classList.toggle("is-done", completing);
  }
  try {
    await saveFirst?.();
    await setCardDone(entry, state, completing);
  } catch (error) {
    cardSnack(error.message || t("Не получилось"));
    await rerenderCard(entry.id);
    return;
  }
  if (state.occurrence) cardOccurrence = state.occurrence;
  await load().catch(() => {});
  refreshOtherViews();
  // Отметка подзадачи не листает список корня: карточка остаётся на месте.
  if (!completing || !cardList || cardStack.length) { await rerenderCard(entry.id); return; }
  const from = cardList.index;
  await rerenderCard(entry.id);
  const actions = [{ get label() { return t("Вернуть"); }, run: async () => {
    await setCardDone(entry, state, false);
    await load().catch(() => {});
    refreshOtherViews();
    if (cardList) await openCardFromList(from);
  } }];
  cardAdvance = setTimeout(() => advanceCardFrom(from, { text: t("Готово: «{value1}»", { value1: shortTitle(titleOf(entry), 34) }), actions }), 700);
}
function cardDoneBlock(entry, state) {
  const block = node("div", undefined, "card-done");
  const line = node("div", undefined, "card-done-line");
  const ok = node("span", undefined, "card-done-ok");
  ok.innerHTML = CARD_TICK_ICON;
  ok.append(document.createTextNode(cardDoneWords(state)));
  line.append(ok);
  const dot = () => node("span", "·", "card-done-sep");
  const link = (label, run) => {
    const button = node("button", label, "card-done-link");
    button.type = "button";
    button.addEventListener("click", run);
    return button;
  };
  if (state.occurrenceDone) {
    const next = nextRepeatDate(state.schedule, shiftDate(state.occurrence, 1));
    if (next) line.append(dot(), bindTranslation(node("span", t("следующий раз {value1}", { value1: scheduleLabel({ state: "ok", date: next, time: state.schedule.time || null }) }), "card-done-note"), "следующий раз {value1}", { value1: scheduleLabel({ state: "ok", date: next, time: state.schedule.time || null }) }));
  }
  if (state.taken && state.assignment?.assigner?.name) line.append(dot(), bindTranslation(node("span", t("{name} видит «сделано»", { name: state.assignment.assigner.name }), "card-done-note"), "{name} видит «сделано»", { name: state.assignment.assigner.name }));
  line.append(dot(), link(t("Вернуть"), () => cardKeys.toggle?.()));
  if (state.occurrenceDone && state.own)
    line.append(dot(), link(t("Закрыть всю серию"), async () => {
      try {
        for (const projection of state.projections) await request(`/api/projections/${projection.id}/complete`, { method: "POST", body: "{}" });
        cardOccurrence = null;
        await load().catch(() => {});
        refreshOtherViews();
        await rerenderCard(entry.id);
        cardSnack(t("Серия закрыта целиком"));
      } catch (error) { cardSnack(error.message || t("Не получилось")); }
    }));
  block.append(line);
  return block;
}
function cardTickButton(entry, state) {
  const label = state.done ? t("Вернуть в работу · E") : state.occurrence ? t("Готово на этот день · E") : state.meeting ? t("Прошла · E") : t("Готово · E");
  const button = node("button", undefined, "card-tick");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(state.done));
  button.classList.toggle("is-done", state.done);
  button.classList.toggle("meeting", state.meeting);
  button.classList.toggle("important", !state.done && !state.meeting && state.c.priority === "high");
  button.classList.toggle("late", !state.done && isOverdue(entry, state.today));
  button.innerHTML = CARD_TICK_ICON + (state.meeting ? CARD_CLOCK_ICON : "");
  if (state.schedule?.repeat) {
    const badge = node("span", undefined, "card-tick-repeat");
    badge.innerHTML = CARD_REPEAT_ICON;
    button.append(badge);
  }
  button.addEventListener("click", () => cardKeys.toggle?.());
  return button;
}
$("#review-dialog")?.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable='true'], .talk-dock, .card-title-edit")) return;
  const key = event.key.toLowerCase();
  if ((key === "e" || key === "у") && cardKeys.toggle) { event.preventDefault(); cardKeys.toggle(); }
  else if ((key === "j" || key === "о") && cardList && !cardStack.length) { event.preventDefault(); stepCard(1); }
  else if ((key === "k" || key === "л") && cardList && !cardStack.length) { event.preventDefault(); stepCard(-1); }
});
// ── путь к подзадаче и раздел «Подзадачи» ───────────────────────────────────
// Ступень пути: если она в стеке — карточка возвращается к ней, снимая
// верхние; если открыли по ссылке с глубины — стек пуст, и ступень просто
// открывается корнем нового пути.
async function jumpToAncestor(id) {
  const index = cardStack.findIndex((frame) => frame.id === id);
  const frame = index >= 0 ? cardStack[index] : null;
  const area = $("#review");
  const entry = await renderCardEntry(id, () => { cardStack = index >= 0 ? cardStack.slice(0, index) : []; cardOccurrence = frame?.occurrence || null; });
  if (!entry) return;
  area.scrollTop = frame?.scrollTop || 0;
  if (motionAllowed()) appear(area, { shift: -8 });
  requestAnimationFrame(() => $("#review .card-title")?.focus({ preventScroll: true }));
}
function cardPath(ancestors) {
  // Не <nav>: общий стиль шапки уводит любой nav в центр страницы.
  const nav = node("div", undefined, "card-path");
  nav.setAttribute("role", "navigation");
  bindTranslation(nav, "Путь к задаче", "aria-label");
  const step = (item, container = nav) => {
    const button = node("button", item.title || t("Без названия"), "card-path-step");
    button.type = "button";
    button.title = item.title || "";
    button.addEventListener("click", () => jumpToAncestor(item.id));
    container.append(button);
  };
  const divider = () => { const span = node("span", "›", "card-path-sep"); span.setAttribute("aria-hidden", "true"); nav.append(span); };
  step(ancestors[0]);
  divider();
  if (ancestors.length > 3) {
    // Длинный путь сворачивается: корень › … › родитель, середина — в меню.
    const menu = node("details", undefined, "card-path-menu");
    const summary = node("summary", "…");
    bindTranslation(summary, "Показать промежуточные задачи", "aria-label");
    const list = node("div", undefined, "card-path-list");
    for (const item of ancestors.slice(1, -1)) step(item, list);
    menu.append(summary, list);
    nav.append(menu);
    divider();
  } else if (ancestors.length === 3) {
    step(ancestors[1]);
    divider();
  }
  step(ancestors.at(-1));
  return nav;
}
const stepsWord = (count) => (count % 10 === 1 && count % 100 !== 11 ? t("шага") : t("шагов"));
// Колонка содержимого докручивается до раздела сама, а не через scrollIntoView:
// тот крутит ещё и внешние обёртки окна (overflow: hidden программно всё равно
// прокручивается), и вместе с разделом уезжает верхняя строка карточки.
function scrollCardTo(element, { smooth = false } = {}) {
  const area = $("#review");
  if (!area || !element?.isConnected) return;
  const top = element.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
  area.scrollTo({ top: Math.max(0, top - 12), behavior: smooth && motionAllowed() ? "smooth" : "instant" });
}
// Раздел «Подзадачи»: настоящие дочерние дела на любой глубине. «Список» —
// прямые дети, «Карта» — всё дерево с раскрывающимися ветками; оба живут на
// одних данных. Дуга вокруг кружка и подпись под названием считают только
// конечные шаги: ветка с детьми — не единица, итоги и заметки — не шаги.
function cardWorkArea(body, steps) {
  const workspace = node("div", undefined, "card-workspace");
  const divider = node("div", undefined, "card-work-divider");
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "horizontal");
  divider.setAttribute("aria-controls", "card-body-editor card-subtasks");
  bindTranslation(divider, "Размер заметки и подзадач", "aria-label");
  workspace.append(body, divider, steps);
  let dragging = false;
  let ratio = 100 * 2 / 3;
  let height = 0;
  const preference = () => {
    const saved = Number(uiStorage.getItem(CARD_NOTE_SHARE_KEY));
    return Number.isFinite(saved) && saved >= 10 && saved <= 90 ? saved : 100 * 2 / 3;
  };
  const apply = () => {
    const available = Math.max(160, height - 14);
    const noteHeight = clampNumber(available * ratio / 100, 80, available - 80);
    workspace.style.gridTemplateRows = `${Math.round(noteHeight)}px 14px minmax(0, 1fr)`;
    divider.setAttribute("aria-valuemin", "10");
    divider.setAttribute("aria-valuemax", "90");
    divider.setAttribute("aria-valuenow", String(Math.round(ratio)));
  };
  const paint = () => {
    if (!workspace.isConnected) return;
    const split = steps.dataset.hasChildren === "true";
    workspace.classList.toggle("has-steps", split);
    divider.hidden = !split;
    if (!split) { workspace.style.height = ""; workspace.style.gridTemplateRows = ""; return; }
    if (!dragging) ratio = preference();
    const area = $("#review"), dialog = $("#review-dialog");
    const style = getComputedStyle(area);
    const occupied = [...area.children].filter(child => child !== workspace).reduce((total, child) => {
      const css = getComputedStyle(child);
      return total + child.getBoundingClientRect().height + (parseFloat(css.marginBottom) || 0) + (child.classList.contains("card-footer") ? 0 : parseFloat(css.marginTop) || 0);
    }, 0);
    const frame = CARD_PHONE.matches || dialog.dataset.mode !== "center" ? 0 : 80;
    const customHeight = !CARD_PHONE.matches && dialog.dataset.mode === "center" ? parseFloat(dialog.style.getPropertyValue("--card-h")) : 0;
    const budget = Math.min(window.innerHeight - frame, customHeight || Infinity);
    const dock = dialog.querySelector(".talk-dock");
    const talk = dock && getComputedStyle(dock).display !== "none" ? (dialog.classList.contains("talk-open") ? dock.getBoundingClientRect().height : parseFloat(getComputedStyle(dialog).getPropertyValue("--talk-base")) || 60) : 0;
    height = Math.max(174, Math.floor(budget - $("#review-top").getBoundingClientRect().height - occupied - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) - talk - 2));
    const size = `${height}px`;
    if (workspace.style.height !== size) workspace.style.height = size;
    apply();
  };
  const persist = () => uiStorage.setItem(CARD_NOTE_SHARE_KEY, String(Math.round(ratio)));
  divider.addEventListener("keydown", event => {
    const changes = { ArrowUp: -5, ArrowDown: 5 };
    if (!(event.key in changes) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    ratio = event.key === "Home" ? 10 : event.key === "End" ? 90 : clampNumber(ratio + changes[event.key], 10, 90);
    apply(); persist();
  });
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    dragging = true;
    const startY = event.clientY, startRatio = ratio;
    let moved = false;
    const move = e => {
      if (!moved && Math.abs(e.clientY - startY) < 3) return;
      moved = true;
      ratio = clampNumber(startRatio + (e.clientY - startY) / Math.max(160, height - 14) * 100, 10, 90);
      apply();
    };
    const stop = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", stop);
      divider.removeEventListener("pointercancel", stop);
      dragging = false;
      if (moved) persist();
      paint();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  });
  const resize = frameResizeObserver(paint);
  const visibility = new MutationObserver(paint);
  visibility.observe(steps, { attributes: true, attributeFilter: ["hidden", "data-has-children"] });
  const onResize = () => paint();
  window.addEventListener("resize", onResize);
  const owner = { paint, dispose: () => { resize.disconnect(); visibility.disconnect(); window.removeEventListener("resize", onResize); } };
  cardWorkspace = owner;
  requestAnimationFrame(() => {
    if (!workspace.isConnected || cardWorkspace !== owner) return;
    resize.observe($("#review-dialog"));
    for (const child of $("#review").children) if (child !== workspace) resize.observe(child);
    paint();
  });
  return workspace;
}

function cardSubtasks(entry, { halo, caption }) {
  const own = entry.mine !== false;
  const section = node("section", undefined, "card-subtasks");
  section.id = "card-subtasks";
  section.hidden = true;
  const subhead = node("div", undefined, "subhead");
  const lead = node("div", undefined, "subhead-lead");
  const count = node("span", undefined, "subtask-count");
  count.setAttribute("aria-live", "polite");
  bindTranslation(count, "Выполнено конечных шагов на всех уровнях", "title");
  lead.append(bindTranslation(node("b", t("Подзадачи")), "Подзадачи"), count);
  const actions = node("div", undefined, "subtask-actions");
  const views = node("div", undefined, "steps-view");
  views.setAttribute("role", "group");
  bindTranslation(views, "Вид подзадач", "aria-label");
  const viewButton = (view, label) => {
    const button = node("button", label, "steps-view-button");
    button.type = "button";
    button.dataset.stepView = view;
    button.addEventListener("click", () => { cardStepView = view; paint(); });
    return button;
  };
  views.append(viewButton("list", t("Список")), viewButton("map", t("Карта")));
  const add = bindTranslation(node("button", t("＋ Подзадача"), "subtask-add"), "＋ Подзадача");
  add.type = "button";
  add.hidden = !own;
  actions.append(views, add);
  subhead.append(lead, actions);
  const list = node("div", undefined, "subtasks");
  list.id = "card-subtask-list";
  const map = node("div", undefined, "metric-tree");
  map.id = "card-subtask-map";
  bindTranslation(map, "Карта подзадач", "aria-label");
  const composer = node("form", undefined, "subtask-composer");
  composer.hidden = true;
  const input = node("input");
  bindTranslation(input, "Название новой подзадачи", "aria-label");
  bindTranslation(input, "Что нужно сделать?", "placeholder");
  input.autocomplete = "off";
  input.maxLength = 500;
  const submit = bindTranslation(node("button", t("Добавить"), "subtask-submit"), "Добавить");
  submit.type = "submit";
  const cancel = node("button", "×", "subtask-cancel");
  cancel.type = "button";
  bindTranslation(cancel, "Отменить добавление", "aria-label");
  composer.append(input, submit, cancel);
  const next = node("div", undefined, "task-next");
  const nextLabel = bindTranslation(node("span", t("Дальше"), "next-label"), "Дальше");
  const nextLink = node("button", undefined, "next-step-link");
  nextLink.type = "button";
  next.append(nextLabel, nextLink);
  section.append(subhead, list, map, composer, next);

  // Дерево приходит плоским списком узлов любой глубины; дети собираются
  // здесь по ссылкам, без рекурсии.
  let tree = null;
  const adopt = (body) => {
    const byId = new Map(body.nodes.map((item) => [item.id, { ...item, children: [] }]));
    for (const item of byId.values()) item.children = item.childIds.map((id) => byId.get(id)).filter(Boolean);
    tree = { ...body, children: body.children.map((id) => byId.get(id)).filter(Boolean) };
  };
  const treeUrl = () => `/api/captures/${encodeURIComponent(entry.id)}/subtasks${currentDayDate ? `?day=${encodeURIComponent(currentDayDate)}` : ""}`;
  const refresh = async () => {
    try { adopt(await request(treeUrl())); }
    catch { tree = null; }
    if (section.isConnected) paint();
  };
  // Отметка шага — ровно то, что сделал бы кружок в карточке самого шага:
  // обычное дело закрывается, повторяющееся — только на показанный день.
  // Родителя это не трогает, соседей списка корня — тоже.
  const pending = new Set();
  const setDone = async (item, done, refocus) => {
    if (pending.has(item.id)) return;
    pending.add(item.id);
    try {
      const { entry: child } = await request(`/api/captures/${encodeURIComponent(item.id)}`);
      // День серии — тот же, что показан в дереве: отметка и карточка шага
      // говорят об одном дне.
      const state = cardDoneState(child, item.occurrence || null);
      if (state.done !== done) await setCardDone(child, state, done);
    } catch (error) { cardSnack(error.message || t("Не получилось")); }
    pending.delete(item.id);
    await refresh();
    load().catch(() => {});
    refreshOtherViews();
    refocus?.();
  };
  const check = (item, className, label) => {
    const box = node("input", undefined, className);
    box.type = "checkbox";
    box.checked = item.done;
    box.setAttribute("aria-label", `${label}: ${item.title}`);
    // Читатель круга видит шаг, но не отмечает; пока отметка уходит — кнопка
    // закрыта, чтобы второй щелчок не обогнал первый.
    box.disabled = !item.canComplete || pending.has(item.id);
    if (!item.canComplete) bindTranslation(box, "Отметить может автор или тот, кто взял дело", "title");
    box.addEventListener("change", () => {
      box.disabled = true;
      setDone(item, box.checked, () => section.querySelector(`[data-check-id="${CSS.escape(item.id)}"]`)?.focus({ preventScroll: true }));
    });
    box.dataset.checkId = item.id;
    return box;
  };
  const openButton = (item, className) => {
    const button = node("button", undefined, className);
    button.type = "button";
    bindTranslation(button, "Открыть подзадачу «{title}»", { title: item.title }, "aria-label");
    // Keep an edited heading/body focused until click starts the save barrier.
    // A blur can change the row's position between pointer press and release.
    button.addEventListener("pointerdown", event => { if (event.button === 0 && event.isPrimary) event.preventDefault(); });
    button.addEventListener("click", () => openSubtaskCard(item.id, item.occurrence || null));
    return button;
  };
  const paintList = () => {
    clear(list);
    for (const item of tree.children) {
      const row = node("div", undefined, "subtask");
      row.dataset.taskId = item.id;
      const open = openButton(item, "subtask-open");
      const name = node("span", item.title, "subtask-name");
      if (item.done) name.classList.add("done");
      open.append(name);
      if (item.children.length) {
        const meta = node("span", `${item.leafDone} / ${item.leafTotal}`, "subtask-meta");
        bindTranslation(meta, "Выполнено конечных шагов", "title");
        open.append(meta);
      }
      const arrow = node("span", "›", "subtask-arrow");
      arrow.setAttribute("aria-hidden", "true");
      open.append(arrow);
      row.append(check(item, "subtask-check", t("Выполнить")), open);
      const tomorrow = tomorrowAction({ ...item, occurrence: item.occurrence });
      if (tomorrow) row.append(tomorrow);
      list.append(row);
    }
  };
  const paintMap = () => {
    clear(map);
    const stack = tree.children.map((item) => ({ item, depth: 0 })).reverse();
    while (stack.length) {
      const { item, depth } = stack.pop();
      const row = node("div", undefined, "tree-row");
      row.dataset.treeId = item.id;
      row.style.setProperty("--indent", `${Math.min(depth, 6) * 18}px`);
      const branch = item.children.length > 0;
      const expanded = branch && !cardCollapsed.has(item.id);
      const fold = node("button", undefined, "tree-fold");
      fold.type = "button";
      if (branch) {
        fold.textContent = expanded ? "⌄" : "›";
        fold.setAttribute("aria-expanded", String(expanded));
        fold.setAttribute("aria-label", `${expanded ? t("Свернуть") : t("Раскрыть")} «${item.title}»`);
        fold.addEventListener("click", () => {
          if (cardCollapsed.has(item.id)) cardCollapsed.delete(item.id);
          else cardCollapsed.add(item.id);
          paintMap();
          map.querySelector(`[data-tree-id="${CSS.escape(item.id)}"] .tree-fold`)?.focus({ preventScroll: true });
        });
      } else {
        fold.classList.add("empty");
        fold.disabled = true;
        fold.setAttribute("aria-hidden", "true");
        fold.tabIndex = -1;
      }
      let status;
      const taskCheck = check(item, "tree-check", t("Выполнить шаг"));
      if (branch) {
        status = node("span", undefined, "branch-dial");
        status.style.setProperty("--branch-progress", `${(item.leafDone / item.leafTotal) * 100}%`);
        bindTranslation(status, "{leafDone} из {leafTotal} {value3}", { leafDone: item.leafDone, leafTotal: item.leafTotal, value3: stepsWord(item.leafTotal) }, "title");
        status.setAttribute("role", "group");
        status.setAttribute("aria-label", status.title);
        const toggle = node("label");
        toggle.append(taskCheck);
        status.append(toggle);
      } else status = taskCheck;
      const open = openButton(item, "tree-open");
      const title = node("span", item.title, "tree-title");
      if (item.done) title.classList.add("done");
      open.append(title);
      if (branch) open.append(node("small", `${item.leafDone} / ${item.leafTotal}`));
      row.append(fold, status, open);
      const tomorrow = tomorrowAction({ ...item, occurrence: item.occurrence });
      if (tomorrow) row.append(tomorrow);
      map.append(row);
      if (expanded) for (let index = item.children.length - 1; index >= 0; index--) stack.push({ item: item.children[index], depth: depth + 1 });
    }
  };
  const paint = () => {
    const hasChildren = Boolean(tree?.children.length);
    section.dataset.hasChildren = String(hasChildren);
    section.hidden = !tree || (!own && !hasChildren);
    halo.classList.toggle("has-progress", hasChildren);
    const fill = halo.querySelector(".halo-fill");
    if (fill) fill.style.strokeDashoffset = hasChildren ? String(100 - (tree.done / tree.total) * 100) : "100";
    caption.hidden = !hasChildren;
    if (hasChildren) {
      bindTranslation(caption, "{done} из {total} {value3} · посмотреть карту ↘", { done: tree.done, total: tree.total, value3: stepsWord(tree.total) });
      bindTranslation(caption, "Выполнено {done} из {total} {value3}. Показать карту", { done: tree.done, total: tree.total, value3: stepsWord(tree.total) }, "aria-label");
    }
    if (!tree) return;
    count.textContent = hasChildren ? `${tree.done} / ${tree.total}` : "";
    count.hidden = !hasChildren;
    views.hidden = !hasChildren;
    for (const button of views.children) {
      const active = button.dataset.stepView === (hasChildren ? cardStepView : "list");
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const showMap = hasChildren && cardStepView === "map";
    list.hidden = showMap;
    map.hidden = !showMap;
    caption.setAttribute("aria-expanded", String(showMap));
    if (!hasChildren) {
      clear(list);
      clear(map);
      list.append(bindTranslation(node("p", t("Разбейте задачу на небольшие шаги"), "subtask-empty"), "Разбейте задачу на небольшие шаги"));
    } else if (showMap) paintMap();
    else paintList();
    const remaining = tree.total - tree.done;
    next.hidden = !hasChildren;
    nextLabel.textContent = tree.next ? t("Дальше") : t("Все шаги выполнены");
    nextLink.hidden = !tree.next;
    nextLink.textContent = tree.next ? `${tree.next.title} ↗` : "";
    nextLink.title = tree.next ? t("Открыть «{title}»", { title: tree.next.title }) : "";
    nextLink.onclick = tree.next ? () => openSubtaskCard(tree.next.id, tree.nodes.find((item) => item.id === tree.next.id)?.occurrence || null) : null;
    next.classList.toggle("all-done", hasChildren && !remaining);
    // Пришли по метке «0/2» — раздел уже нарисован, карточка встаёт на нём.
    if (cardScrollTarget === entry.id && hasChildren) {
      cardScrollTarget = null;
      requestAnimationFrame(() => scrollCardTo(section));
    }
  };
  caption.addEventListener("click", () => {
    cardStepView = "map";
    paint();
    scrollCardTo(section, { smooth: true });
    views.querySelector('[data-step-view="map"]')?.focus({ preventScroll: true });
  });
  const closeComposer = (refocus = true) => {
    composer.hidden = true;
    input.value = "";
    if (refocus) add.focus({ preventScroll: true });
  };
  add.addEventListener("click", () => { composer.hidden = false; input.focus(); });
  cancel.addEventListener("click", () => closeComposer());
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeComposer();
  });
  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    submit.disabled = true;
    try {
      const result = await request(`/api/captures/${encodeURIComponent(entry.id)}/subtasks${currentDayDate ? `?day=${encodeURIComponent(currentDayDate)}` : ""}`, { method: "POST", body: JSON.stringify({ title }) });
      adopt(result.tree);
      input.value = "";
      paint();
      input.focus();
      load().catch(() => {});
      refreshOtherViews();
    } catch (error) { cardSnack(error.message || t("Подзадача не добавилась")); }
    finally { submit.disabled = false; }
  });
  refresh();
  return section;
}
function showReview(entry, review, undoGroupId, provenance) {
  const area = $("#review"),
    dialog = $("#review-dialog"),
    c = entry.interpretation.classification;
  // Показанная карточка отменяет запоздавшее закрытие прежней (см. closeCard).
  cardCloseToken += 1;
  if (cardScrollTarget && cardScrollTarget !== entry.id) cardScrollTarget = null;
  // Сбоку по записи щёлкнули, не закрыв карточку. По той же самой — набранное
  // уходит на сервер, и она перечитывается на месте (запись пришла из списка,
  // а в нём могло быть не всё). По другой — прежняя уступает место, а набранное
  // в ней уходит на сервер, пока её разметка ещё на месте.
  const fromPage = cardOpenedFromPage(dialog);
  if (fromPage && cardEntryId === entry.id) {
    pendingCardList = null;
    flushCard().finally(() => rerenderCard(entry.id));
    return;
  }
  if (fromPage) leaveCardForPage();
  cardWorkspace?.dispose();
  cardWorkspace = null;
  clear(area);
  if (review.level === "high") {
    closeCard();
    return;
  }
  // Список, из которого открыли карточку, едет с ней; кружок — у своего дела,
  // встречи и взятого у человека дела. Подзадача список не трогает: он
  // остаётся у корня и ждёт возвращения.
  if (!cardStack.length) adoptCardList(entry, !dialog.open || fromPage);
  cardEntryId = entry.id;
  const doneState = cardDoneState(entry);
  const hasTick = cardHasTick(entry, doneState);
  // Заголовок правится на месте: клик превращает его в поле, Enter сохраняет
  // уточнением (правда человека — факт), Escape возвращает как было.
  const cardTitle = markdownNode("h2", c.summary, "card-title", { inline: true, firstLine: true });
  bindTranslation(cardTitle, "Изменить заголовок", "title");
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
    let inflight = null;
    const cancel = () => { settled = true; flushCardTitle = null; editor.replaceWith(cardTitle); };
    const save = () => {
      if (inflight) return inflight;
      if (settled) return Promise.resolve();
      settled = true;
      const value = editor.value.trim();
      if (!value || value === c.summary) { flushCardTitle = null; editor.replaceWith(cardTitle); return Promise.resolve(); }
      editor.disabled = true;
      // Ответ может прийти, когда в карточке уже другая запись или карточка
      // закрыта: тогда он ничего не перерисовывает — заголовок сохранён, и
      // родитель при возвращении читается с сервера уже новым.
      const token = cardNavToken;
      inflight = (async () => {
        try {
          // Карточка после ответа перерисуется из сохранённой записи: правки
          // свойств, которые ещё не уходили, едут одним уточнением с заголовком.
          const result = await request(`/api/captures/${entry.id}/corrections`, {
            method: "POST",
            body: JSON.stringify({ patch: { ...(pendingProps() || {}), summary: value } }),
          });
          toast(t("Заголовок обновлён"));
          load();
          if (token !== cardNavToken || cardEntryId !== entry.id || !$("#review-dialog").open || !editor.isConnected) return;
          // Keep the pressed tree button, keyboard focus and divider intact.
          // A blur save must not replace the whole card before its click fires.
          Object.assign(c, result.entry.interpretation.classification);
          const savedTitle = markdownNode("h2", c.summary, "card-title", { inline: true, firstLine: true });
          cardTitle.replaceChildren(...savedTitle.childNodes);
          editor.replaceWith(cardTitle);
        } catch (error) {
          toast(error.message);
          if (editor.isConnected) editor.replaceWith(cardTitle);
        } finally {
          if (flushCardTitle === flushTitle) flushCardTitle = null;
          inflight = null;
        }
      })();
      return inflight;
    };
    // Переход к подзадаче и закрытие карточки дожидаются этого сохранения.
    const flushTitle = () => save();
    flushCardTitle = flushTitle;
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
  // Путь к подзадаче на глубине от второй: корень › … › родитель. Ступени
  // нажимаются — карточка возвращается на нужный уровень.
  const ancestors = entry.ancestors || [];
  if (ancestors.length >= 2) area.append(cardPath(ancestors));
  // Название с кружком. Вокруг кружка — тонкая дуга прогресса подзадач: в
  // центре отметка самого дела, снаружи путь к нему. Дуга и подпись под
  // названием появляются, когда есть хоть один шаг.
  const head = node("div", undefined, `card-head${hasTick ? " with-tick" : ""}`);
  const halo = node("div", undefined, "completion-halo");
  const meter = node("span", undefined, "halo-meter");
  meter.setAttribute("aria-hidden", "true");
  meter.innerHTML = '<svg viewBox="0 0 54 54"><circle class="halo-track" cx="27" cy="27" r="23"></circle><circle class="halo-fill" cx="27" cy="27" r="23" pathLength="100"></circle></svg>';
  halo.append(meter);
  if (hasTick) {
    cardTitle.classList.toggle("is-done", doneState.done);
    halo.append(cardTickButton(entry, doneState));
    head.append(halo);
  }
  const titleCopy = node("div", undefined, "card-title-copy");
  const caption = node("button", undefined, "progress-caption");
  caption.type = "button";
  caption.hidden = true;
  caption.setAttribute("aria-controls", "card-subtask-map");
  titleCopy.append(cardTitle, caption);
  head.append(titleCopy);
  area.append(head);
  if (hasTick && doneState.done) area.append(cardDoneBlock(entry, doneState));
  // Свойства одним взглядом: срок, напоминание, люди — чипами под названием.
  // Чип открывает панель «Параметры» на своём поле; рисуются ниже, когда
  // поля собраны.
  const chips = node("div", undefined, "card-chips");
  area.append(chips);
  // Подзадачи есть у дела и встречи всегда, у остального — если из записи
  // уже отделились дела.
  const wantsSubtasks = ["task", "meeting_event"].includes(c.primaryType) || (entry.parts || []).some((part) => ["task", "meeting_event"].includes(part.type));
  // Происхождение: дело, отделённое от записи, помнит, из чего оно вышло, а
  // исходная запись — что из неё вышло. Без этого «Допинать бот-детектор»
  // висело бы ничьим делом, а у отчёта о встрече не было бы следа, что дела
  // из него уже заведены. У подзадачи, открытой из родителя, путь наверх — в
  // верхней строке; у дела с разделом «Подзадачи» отделённые дела — в нём.
  // Итог дела («+ чем кончилось») — тоже запись с родителем, но это не
  // отделённое дело: у дела он назван итогом, а сам итог помнит своё дело.
  const deedParts = (entry.parts || []).filter((part) => part.type !== "outcome_decision" || !["task", "meeting_event"].includes(c.primaryType));
  const outcomeOfDeed = entry.parent && (c.primaryType === "outcome_decision" || entry.origin === "outcome") && ["task", "meeting_event"].includes(entry.parent.type);
  const stepOfDeed = entry.parent && !entry.parent.splitSource && ["task", "meeting_event"].includes(c.primaryType) && ["task", "meeting_event"].includes(entry.parent.type);
  if ((entry.parent && !cardStack.length) || (deedParts.length && !wantsSubtasks)) {
    const origin = node("p", undefined, "card-origin");
    const link = (id, text) => { const button = node("button", text, "text-button"); button.type = "button"; button.addEventListener("click", () => openCaptureById(id)); return button; };
    if (entry.parent) origin.append(document.createTextNode(outcomeOfDeed ? t("Итог дела ") : stepOfDeed ? t("Подзадача дела ") : t("Отделено от записи ")), link(entry.parent.id, `«${entry.parent.title}»`));
    else {
      origin.append(document.createTextNode(t("Из этой записи {value1}: ", { value1: plural(deedParts.length, DEALS) })));
      deedParts.forEach((part, index) => {
        if (index) origin.append(document.createTextNode(", "));
        origin.append(link(part.id, part.title));
      });
    }
    area.append(origin);
  }
  // Заметка и идея — это ещё и страница в разделе «Заметки»: там у неё место
  // в дереве, ссылки и страницы внутри.
  if (entry.mine !== false && ["note", "idea_question"].includes(entry.interpretation.classification.primaryType)) {
    const asPage = bindTranslation(node("a", t("Открыть как страницу"), "card-page-link"), "Открыть как страницу");
    asPage.href = `#notes?page=${encodeURIComponent(entry.id)}`;
    asPage.addEventListener("click", () => closeCard());
    area.append(asPage);
  }
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
  bindTranslation(type, "Тип записи", "aria-label");
  for (const [value, label] of Object.entries(typeNames)) {
    const option = node("option", label);
    option.value = value;
    option.selected = value === c.primaryType;
    type.append(option);
  }
  // В ветке «только туду» тип нельзя менять из карточки: сервер принимает
  // записи как задачи, а прежние типы остаются лишь для чтения старых данных.
  type.disabled = true;
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
  bindTranslation(end, "Окончание", "title");
  bindTranslation(end, "Окончание", "aria-label");
  const paintEnd = () => { end.hidden = !time.value; if (!time.value) end.value = ""; };
  time.addEventListener("input", paintEnd);
  paintEnd();
  // Напоминание — свойство срока: за сколько до начала у дела со временем,
  // в час напоминаний у дела без времени. Пусто — как в настройках.
  const remind = node("select", undefined, "review-remind");
  remind.id = "review-remind";
  bindTranslation(remind, "Напомнить", "aria-label");
  const storedRemind = c.entities.schedule?.remind;
  let remindChoice = storedRemind === undefined || storedRemind === null ? "" : String(storedRemind);
  const paintRemind = () => {
    const timed = Boolean(time.value);
    const current = !timed && /^\d+$/.test(remindChoice) ? "0" : remindChoice;
    clear(remind);
    const options = timed
      ? [["", t("как в настройках ({value1})", { value1: remindDefaultLabel() })], ["off", t("не напоминать")], ["0", t("в момент начала")], ["5", t("за 5 минут")], ["15", t("за 15 минут")], ["30", t("за 30 минут")], ["60", t("за час")], ["120", t("за 2 часа")], ["1440", t("за день")]]
      : [["", t("как в настройках ({value1})", { value1: remindHourLabel() })], ["off", t("не напоминать")], ["0", t("в {value1}", { value1: remindHourValue() })]];
    if (current && !options.some(([value]) => value === current)) options.push([current, t("за {current} мин", { current: current })]);
    for (const [value, label] of options) { const option = node("option", label); option.value = value; option.selected = value === current; remind.append(option); }
  };
  remind.addEventListener("change", () => { remindChoice = remind.value; });
  time.addEventListener("input", paintRemind);
  paintRemind();
  // Повтор — тоже свойство срока: правило и, если нужно, последний день.
  // Без даты повторять нечего — выбор закрыт.
  const repeat = node("select", undefined, "review-repeat");
  repeat.id = "review-repeat";
  bindTranslation(repeat, "Повтор", "aria-label");
  const storedRepeat = c.entities.schedule?.repeat || null;
  const repeatKey = (rule) => (rule ? `${rule.freq}:${rule.interval || 1}` : "");
  const repeatOptions = [["", t("не повторять")], ["daily:1", t("каждый день")], ["weekly:1", t("каждую неделю")], ["weekly:2", t("каждые 2 недели")], ["monthly:1", t("каждый месяц")], ["yearly:1", t("каждый год")]];
  if (storedRepeat && !repeatOptions.some(([value]) => value === repeatKey(storedRepeat))) repeatOptions.push([repeatKey(storedRepeat), repeatLabel(storedRepeat, { until: false })]);
  for (const [value, label] of repeatOptions) { const option = node("option", label); option.value = value; option.selected = value === repeatKey(storedRepeat); repeat.append(option); }
  const until = node("input");
  until.type = "date"; until.id = "review-repeat-until"; until.value = storedRepeat?.until || ""; bindTranslation(until, "Последний день повтора", "title"); bindTranslation(until, "Повторять до", "aria-label");
  const untilWrap = node("span", undefined, "review-until");
  untilWrap.append(bindTranslation(node("span", t("до"), "review-end-label"), "до"), until);
  const paintRepeat = () => { repeat.disabled = !date.value; if (!date.value) repeat.value = ""; untilWrap.hidden = !repeat.value; if (!repeat.value) until.value = ""; };
  repeat.addEventListener("change", paintRepeat);
  date.addEventListener("input", paintRepeat);
  paintRepeat();
  const repeatRow = node("span", undefined, "review-repeat-row");
  repeatRow.append(bindTranslation(node("span", t("повторять"), "review-end-label"), "повторять"), repeat, untilWrap);
  // Напоминание — тоже подписанная строка панели.
  const remindWrap = node("span", undefined, "review-remind-row");
  remindWrap.append(bindTranslation(node("span", t("напомнить"), "review-end-label"), "напомнить"), remind);
  project.id = "review-project";
  project.value = c.entities.projects[0] || "";
  bindTranslation(project, "Найти или создать проект", "placeholder");
  const projectChoice = projectPicker(project);
  people.id = "review-people";
  people.value = (c.entities.people || []).join(", ");
  bindTranslation(people, "Например, Анна, BE", "placeholder");
  followUp.id = "review-follow-up";
  followUp.value = c.entities.followUp || "";
  bindTranslation(followUp, "Следующее действие", "placeholder");
  // Признак «уже сделано» ставила только модель, и исправить её решение было
  // нечем: заметка, принятая за отчёт, навсегда оставалась в «Сделано».
  let done = Boolean(c.completed);
  doneToggle.id = "review-completed";
  doneToggle.type = "button";
  const paintDone = () => {
    doneToggle.setAttribute("aria-pressed", String(done));
    doneToggle.title = done ? t("Отметить как незавершённое") : t("Отметить как сделанное");
    doneToggle.setAttribute("aria-label", doneToggle.title);
    doneToggle.classList.toggle("is-done", done);
  };
  // Сделанное — результат: у встречи или дела с отметкой «сделано» в «Что
  // делал» остался бы кружок, который нечего отмечать, а заметка или идея
  // «сделанными» не бывают. Сервер держит то же правило, а карточка показывает
  // его сразу — и в обратную сторону: запись, названная не результатом, снова
  // не сделана.
  const notResult = () => type.value !== "outcome_decision";
  doneToggle.addEventListener("click", () => {
    done = !done;
    if (done && notResult()) {
      type.value = "outcome_decision";
      type.dispatchEvent(new Event("change"));
    }
    paintDone();
  });
  paintDone();

  const scheduleRow = node("div", undefined, "review-schedule");
  // Начало и конец — две подписанные колонки одной строки панели.
  const startWrap = node("span", undefined, "review-start");
  startWrap.append(bindTranslation(node("span", t("начало"), "review-end-label"), "начало"), time);
  const endWrap = node("span", undefined, "review-end");
  endWrap.append(bindTranslation(node("span", t("до"), "review-end-label"), "до"), end);
  scheduleRow.append(date, startWrap, endWrap, remindWrap, repeatRow);
  // Сброс уходит на сервер сразу: «без даты» — это решение, а не правка на
  // полпути, и ждать закрытия карточки ему незачем.
  let saveProps = () => {};
  const clearAndSave = (apply) => { apply(); saveProps(); };
  const scheduleWrap = propertyRow(t("Срок"), scheduleRow, "schedule", { clear: () => clearAndSave(() => { date.value = ""; time.value = ""; end.value = ""; remindChoice = ""; repeat.value = ""; until.value = ""; paintEnd(); paintRemind(); paintRepeat(); }), filled: () => Boolean(date.value || time.value) }),
    peopleWrap = propertyRow(t("Участники"), people, "people", { clear: () => clearAndSave(() => { people.value = ""; }), filled: () => Boolean(people.value.trim()) }),
    followUpWrap = propertyRow(t("Далее"), followUp, "next", { clear: () => clearAndSave(() => { followUp.value = ""; }), filled: () => Boolean(followUp.value.trim()) });
  const props = node("div", undefined, "props");
  const columnSelect = node("select", undefined, "side-column");
  columnSelect.id = "review-column";
  bindTranslation(columnSelect, "Колонка", "aria-label");
  const columnRow = propertyRow(t("Колонка"), columnSelect, "project");
  columnRow.hidden = true;
  // Круг и исполнитель — свойства записи, а не отдельная форма: дело уходит
  // человеку фразой, а здесь его правят, когда разбор не угадал.
  const hasCircles = (entry.myCircles || []).some((circle) => (circle.members || []).length > 1);
  const circleWrap = propertyRow(t("Круг"), circleRow(entry), "project"),
    assignWrap = entry.mine === false ? null : propertyRow(t("Исполнитель"), assignRow(entry, { onChange: () => {} }), "people");
  props.append(
    columnRow,
    scheduleWrap,
    propertyRow(t("Проект"), projectChoice.element, "project"),
    ...(entry.circles?.length ? [circleWrap] : []),
    ...(assignWrap && (hasCircles || entry.assignment) ? [assignWrap] : []),
    peopleWrap,
    followUpWrap,
    // У дела и встречи «сделано» — кружок у названия; строка остаётся у заметки,
    // идеи и результата, где она делает запись итогом.
    ...(["task", "meeting_event"].includes(c.primaryType) ? [] : [propertyRow(t("Сделано"), doneToggle, "done")]),
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
  // Чипы под названием — те же свойства одним взглядом: срок, напоминание,
  // повтор, люди, проект, «далее». Чип статуса — из сохранённой записи, правки
  // живут в панели. Чип ведёт в панель «Параметры» на своё поле.
  const chip = (icon, text, { quiet = false, target = null, label = "" } = {}) => {
    const button = node("button", undefined, `chip${quiet ? " quiet" : ""}`);
    button.type = "button";
    button.append(propIcon(icon), node("span", text));
    if (label) button.title = label;
    button.addEventListener("click", () => setCardParams(true, { focus: target && !target.disabled ? target : null }));
    return button;
  };
  const paintChips = () => {
    clear(chips);
    if (!scheduleWrap.hidden) {
      const due = scheduleLabel({ state: "ok", date: date.value || null, time: time.value || null });
      chips.append(chip("schedule", due ? `${due}${time.value && end.value ? `–${end.value}` : ""}` : t("Назначить день"), { quiet: !due, target: date, get label() { return t("Срок"); } }));
      const tomorrow = tomorrowAction({ id: entry.id, title: titleOf(entry), schedule: { date: date.value || null, time: time.value || null, repeat: repeat.value ? storedRepeat : null }, occurrence: doneState.occurrence, done: doneState.done, mine: doneState.own });
      if (tomorrow) chips.append(tomorrow);
      if (date.value) {
        const remindText = remind.value === "off" ? t("Без напоминания") : remind.value ? t("Напомнить {value1}", { value1: remind.selectedOptions[0]?.textContent || "" }) : t("Напомнить");
        chips.append(chip("bell", remindText, { quiet: !remind.value, target: remind, get label() { return t("Напомнить"); } }));
      }
      if (repeat.value) chips.append(chip("repeat", `${repeat.selectedOptions[0]?.textContent || t("повтор")}${until.value ? t(" до {value1}.{value2}", { value1: until.value.slice(8, 10), value2: until.value.slice(5, 7) }) : ""}`, { target: repeat, get label() { return t("Повтор"); } }));
    }
    if (!peopleWrap.hidden) {
      const who = people.value.trim() || doneState.assignment?.assignee?.name || "";
      chips.append(chip("people", who || t("Человек"), { quiet: !who, target: people, get label() { return t("Участники"); } }));
    }
    if (project.value.trim()) chips.append(chip("project", project.value.trim(), { target: projectChoice.focusTarget(), get label() { return t("Проект"); } }));
    if (!followUpWrap.hidden && followUp.value.trim()) chips.append(chip("next", t("далее: {value1}", { value1: followUp.value.trim() }), { target: followUp, get label() { return t("Далее"); } }));
    chips.hidden = !chips.childElementCount;
  };
  type.addEventListener("change", () => {
    // «Результат» — это уже сделанное: у дела строки «Сделано» нет, и выбор
    // типа сам ставит отметку, как её ставит сервер.
    if (!notResult() && !done) { done = true; paintDone(); }
    if (done && notResult()) { done = false; paintDone(); }
    updateVisibility();
  });
  updateVisibility();
  form.addEventListener("input", paintChips);
  form.addEventListener("change", paintChips);
  paintChips();
  form.append(props);
  // Форма свойств живёт в панели «Параметры» справа от колонки. Когда карточка
  // открыта под уточнение (есть вопрос модели) — панель сразу открыта.
  const panelBody = $("#review-params-body");
  clear(panelBody);
  panelBody.append(form);
  if (review.question || review.field) setCardParams(true, { instant: !dialog.open });
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
      patch.schedule = { date: date.value || null, time: time.value || null, ...(time.value && end.value && end.value > time.value ? { end: end.value } : {}), remind: remind.value === "" ? null : remind.value === "off" ? "off" : Number(remind.value), repeat: repeat.value && date.value ? { freq: repeat.value.split(":")[0], interval: Number(repeat.value.split(":")[1]) || 1, until: until.value && until.value >= date.value ? until.value : null } : null };
    return patch;
  };
  const untouched = JSON.stringify(propsPatch());
  pendingProps = () =>
    JSON.stringify(propsPatch()) === untouched ? null : propsPatch();
  let propsInflight = null;
  saveProps = () => {
    if (propsInflight) return propsInflight;
    const patch = pendingProps();
    if (!patch) return Promise.resolve();
    propsInflight = (async () => {
      try {
        const result = await request(`/api/captures/${entry.id}/corrections`, {
          method: "POST",
          body: JSON.stringify({
            patch: { ...patch, get note() { return t("Пользователь исправил классификацию"); } },
          }),
        });
        toast(
          result.review.level === "high" || result.review.safeNote
            ? t("Уточнение сохранено")
            : t("Нужно ещё одно уточнение"),
        );
        await load();
      } catch (error) {
        toast(error.message);
      } finally {
        propsInflight = null;
      }
    })();
    return propsInflight;
  };
  flushCardProps = saveProps;
  // Enter в поле свойства раньше отправлял форму; отправлять больше нечего.
  form.addEventListener("submit", (event) => event.preventDefault());
  const body = cardBody(entry);
  if (wantsSubtasks) area.append(cardWorkArea(body, cardSubtasks(entry, { halo, caption })));
  else area.append(body);
  cardDiscussion(entry);
  // Футер прижат к низу листа и собран в строку: вложения, «когда записано»,
  // источник и удаление — служебный подвал, а не столбик в теле карточки.
  const footer = node("div", undefined, "card-footer");
  footer.append(attachmentsBlock(entry));
  const footerRow = node("div", undefined, "card-footer-row");
  if (written) {
    // Запись, положенная в другой день («поставь это на пятницу как
    // результат», пересланное из Telegram), честно говорит оба времени:
    // когда это было и когда набрано.
    const typedDay = entry.createdAt ? entryDate({ createdAt: entry.createdAt }) : null;
    const moved = typedDay && entry.occurredAt && typedDay !== entryDate(entry);
    const stamp = node("p", moved ? t("Было: {written} · записано {value2}", { written: written, value2: entryClock({ createdAt: entry.createdAt }) }) : t("Записано: {written}", { written: written }), "card-written card-footer-line");
    stamp.prepend(propIcon("written"));
    footerRow.append(stamp);
  }
  footer.append(footerRow);
  area.append(footer);

  const source = node("details", undefined, "card-source");
  const sourceSummary = bindTranslation(node("summary", t("Источник и версия")), "Источник и версия");
  sourceSummary.prepend(propIcon("source"));
  sourceSummary.append(propIcon("chevron"));
  source.append(sourceSummary);
  // Пока заметку не правили, её тело — копия исходной записи, и показывать
  // один и тот же текст дважды незачем: остаётся только строка версии.
  const sourceText = entry.parent?.splitSource ? entry.parent.raw : entry.raw;
  const noteBody = entry.note?.body ?? (entry.raw || "");
  const sameAsRaw = noteBody.trim() === (sourceText || "").trim();
  const raw = node("div", undefined, "review-raw");
  if (sameAsRaw) raw.append(bindTranslation(node("p", t("Исходная запись совпадает с заметками."), "entry-meta"), "Исходная запись совпадает с заметками."));
  else raw.append(bindTranslation(node("p", t("Исходная запись:"), "source-label"), "Исходная запись:"), markdownNode("div", sourceText, undefined));
  const provider = provenance?.usedProvider || entry.interpretation.provider;
  // Источник раскрывается листом над строкой подвала и не распирает её.
  const sourceBody = node("div", undefined, "card-source-body");
  sourceBody.append(
    raw,
    node("p", cardFromWords(entry), "entry-meta"),
    bindTranslation(node(
      "p",
      t("Версия {version} · {value2}{value3}", { version: entry.interpretation.version, value2: providerNames[provider] || t("исправлено вами"), value3: fallbackSuffix(provenance) }),
      "entry-meta",
    ), "Версия {version} · {value2}{value3}", { version: entry.interpretation.version, value2: providerNames[provider] || t("исправлено вами"), value3: fallbackSuffix(provenance) }),
  );
  source.append(sourceBody);
  footerRow.append(source);

  // Удаление живёт внизу карточки, отдельно от правок: это не «ещё одно
  // уточнение», а выход из журнала.
  const remove = bindTranslation(node("button", t("Удалить запись"), "card-delete"), "Удалить запись");
  remove.type = "button";
  remove.prepend(propIcon("trash"));
  const deleteRecord = async () => {
    // Записи больше не будет: сохранять в неё заметку и свойства незачем.
    flushCardBody = null;
    flushCardProps = null;
    remove.disabled = true;
    try {
      await request(`/api/captures/${entry.id}`, { method: "DELETE" });
      closeCard();
      await load();
      toast(t("Запись удалена"), {
        get label() { return t("Вернуть"); },
        run: async () => {
          try {
            await request(`/api/captures/${entry.id}/restore`, { method: "POST" });
            await load();
            toast(t("Запись возвращена"));
          } catch (error) {
            toast(error.message);
          }
        },
      });
    } catch (error) {
      toast(error.message);
      remove.disabled = false;
    }
  };
  // Серия, открытая из календаря или «Дня» на конкретный день: удалить можно
  // только этот повтор (он убирается из серии) или всю запись — выбор на
  // месте кнопки.
  const occurrence = c.entities.schedule?.repeat && cardOccurrence && scheduledOn(entry, cardOccurrence) ? cardOccurrence : null;
  remove.addEventListener("click", () => {
    if (!occurrence) { deleteRecord(); return; }
    const ask = node("div", undefined, "card-delete-ask");
    ask.append(bindTranslation(node("span", t("Запись повторяется. Убрать только {value1} или удалить всю серию?", { value1: calHuman(occurrence) })), "Запись повторяется. Убрать только {value1} или удалить всю серию?", { value1: calHuman(occurrence) }));
    const only = bindTranslation(node("button", t("Только этот повтор"), "danger"), "Только этот повтор"), all = bindTranslation(node("button", t("Всю серию"), "danger"), "Всю серию"), cancel = bindTranslation(node("button", t("Отмена")), "Отмена");
    for (const button of [only, all, cancel]) button.type = "button";
    only.addEventListener("click", async () => {
      for (const button of [only, all, cancel]) button.disabled = true;
      closeCard();
      await skipOccurrence({ id: entry.id, ...scheduleTarget(c.entities.schedule) }, occurrence);
    });
    all.addEventListener("click", () => { ask.replaceWith(remove); deleteRecord(); });
    cancel.addEventListener("click", () => ask.replaceWith(remove));
    ask.append(only, all, cancel);
    remove.replaceWith(ask);
  });
  footerRow.append(remove);
  // Чужая запись открыта только на чтение: правит её автор, а исполнитель
  // просит словами — в обсуждении, которое тут же ниже. Молча подсовывать
  // поля, которые сервер всё равно не примет, — обман.
  if (entry.mine === false) {
    for (const control of props.querySelectorAll("input, select, textarea, button")) control.disabled = true;
    remove.hidden = true;
    const author = entry.author?.name || entry.assignment?.assigner?.name;
    const called = !entry.assignment && (entry.participants || []).some((person) => person.id === currentUser?.id);
    const line = node("p", `${author ? t("Автор записи — {author}. ", { author: author }) : ""}${called ? t("Вас позвали в обсуждение: запись видна вам, правит её автор.") : t("Правит её автор: что нужно поменять — скажите в обсуждении.")}`, "card-foreign");
    chips.after(line);
  }
  // Отправить встречу во внешний календарь можно только отсюда, кнопкой:
  // по контракту памяти действие наружу всегда ждёт отдельного подтверждения.
  if (["task", "meeting_event"].includes(c.primaryType) && c.entities.schedule?.date) footerRow.prepend(calendarExportEl(entry));
  // E — кружок, K / J — соседние дела списка. Свойства, набранные до отметки,
  // уходят раньше неё: поправка после отметки пересобрала бы дело заново.
  cardKeys.toggle = hasTick ? () => toggleCardDone(entry, doneState, () => saveProps()) : null;
  cardMenu.entryId = entry.id;
  cardMenu.columnName = "";
  paintCardNav({ entry });
  fillCardColumn(entry, { columnRow, columnSelect });
  if (!dialog.open) {
    // Прерванное закрытие могло оставить незавершённую анимацию: снимаем её,
    // иначе карточка откроется прозрачной.
    for (const animation of dialog.getAnimations()) animation.cancel();
    openCardDialog(dialog);
    syncCardViewport();
    // Только при открытии: после сохранения уточнения карточка
    // перерисовывается на месте, и проявлять её заново незачем.
    appearCard(dialog);
    // Окно скрыто между открытиями и помнит прокрутку прежней карточки: новая
    // читается с начала (к «Подзадачам» её при нужде докрутит метка «0/2»).
    area.scrollTop = 0;
    // Фокус на самой карточке: иначе он уходит на крестик или на селектор
    // типа, хотя карточку открывают ради заметок.
    dialog.focus();
  } else if (fromPage) {
    // Другая запись на месте прежней: читать её с начала, тихо проявившись.
    area.scrollTop = 0;
    if (motionAllowed()) appear(area, { shift: 12 });
  }
  markOpenCard();
}
function cardFromWords(entry) {
  const from = { telegram: "Telegram", get telegram_forward() { return t("Telegram, пересланное"); }, get notes() { return t("Заметки"); } }[entry.origin] || t("Поле записи");
  const when = entryClock(entry);
  return when ? `${from} · ${when}` : from;
}
// Колонка доски, в которой лежит дело: строка «Колонка» справа и крошка
// вверху. Доска читается заново при каждом открытии; у записи вне доски (не
// дело, чужая) строки нет.
const cardMenu = { remove: null, entryId: null, columnName: "" };
async function cardBoardInfo(entryId) {
  const find = (data) => {
    if (!data) return null;
    for (const column of data.columns || []) if (column.cards.some((card) => card.captureId === entryId)) return { columns: data.columns, column };
    if ((data.closed || []).some((card) => card.captureId === entryId)) return { columns: data.columns, column: null };
    return null;
  };
  // Всегда свежая доска: дело могли закрыть или переложить с тех пор, как доску
  // читали в последний раз, и колонка в карточке не должна врать.
  try {
    const data = await request(boardUrl());
    boardState.data = data;
    currentDayDate ||= data.today;
    return find(data);
  } catch { return null; }
}
async function fillCardColumn(entry, { columnRow, columnSelect }) {
  cardMenu.columnName = "";
  paintCardCrumb();
  const info = await cardBoardInfo(entry.id);
  // Пока шёл запрос, карточку могли закрыть или сменить.
  if (!info || !columnSelect.isConnected || cardMenu.entryId !== entry.id) return;
  clear(columnSelect);
  if (!info.column) {
    columnSelect.append(new Option(t("Закрыто"), ""));
    columnSelect.disabled = true;
    cardMenu.columnName = t("Закрыто");
  } else {
    for (const column of info.columns) {
      const option = new Option(column.name, column.id);
      option.selected = column.id === info.column.id;
      columnSelect.append(option);
    }
    cardMenu.columnName = info.column.name;
    columnSelect.disabled = entry.mine === false;
    columnSelect.addEventListener("change", async () => {
      const target = info.columns.find((column) => column.id === columnSelect.value);
      try {
        await boardMoveRequest({ captureId: entry.id, columnId: columnSelect.value, index: 100000 });
        cardMenu.columnName = target?.name || "";
        paintCardCrumb();
        toast(t("Дело в колонке «{value1}»", { value1: target?.name || "" }));
        if (boardState.data) request(boardUrl()).then((data) => { boardState.data = data; if (!$("#board")?.hidden) { boardState.stamp = JSON.stringify(data); renderBoard(data); } }).catch(() => {});
      } catch (error) {
        columnSelect.value = info.column.id;
        toast(error.message);
      }
    });
  }
  columnRow.hidden = false;
  paintCardCrumb();
}
function paintCardCrumb() {
  const crumb = $("#review-dialog .card-nav-col");
  if (crumb) { crumb.textContent = cardMenu.columnName; crumb.hidden = !cardMenu.columnName; }
}
function showCorrection(
  entry,
  // Без вопроса: карточку открывают просто чтобы посмотреть или дописать
  // заметку, и красная строка «выберите тип» была бы ложной тревогой.
  review = { level: "medium", question: null },
) {
  // Открыл карточку — прочитал уведомления о ней; ждущее ответа остаётся ждать.
  if (entry?.id) markNotificationsRead({ captureId: entry.id });
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
    toast(t("Запись разобрана заново"));
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
    toast(result.reverted ? t("Последнее действие отменено") : t("Уже отменено"));
    await load();
  } catch (error) {
    toast(error.message);
  }
}
function captureState(job) {
  if (job.state === "succeeded") return t("Готово");
  if (job.state === "failed") return t("Не удалось разобрать");
  if (job.state === "cancelled") return t("Отменено");
  if (job.state === "running" || job.stage === "classifying")
    return t("ИИ разбирает запись");
  return job.stage === "saved" ? t("Запись сохранена") : t("В очереди");
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
      bindTranslation(node(
        "p",
        t("Похожая запись уже есть в журнале — возможно, дубль."),
        "progress-raw",
      ), "Похожая запись уже есть в журнале — возможно, дубль."),
    );
  if (job.parts?.length) {
    // Дела, отделённые от записи, показываются сразу: подтверждения заранее
    // приложение не спрашивает нигде, но даёт отменить сделанное.
    const parts = node("p", undefined, "progress-raw progress-parts");
    parts.append(document.createTextNode(t("Отделил {value1}: {value2}", { value1: plural(job.parts.length, DEALS), value2: job.parts.map((part) => `«${part.title}»`).join(", ") })));
    card.append(parts);
  }
  if (job.state === "failed")
    card.append(
      bindTranslation(node("p", t("Запись сохранена, но не классифицирована."), "progress-raw"), "Запись сохранена, но не классифицирована."),
    );
  if (job.state === "cancelled")
    card.append(
      bindTranslation(node(
        "p",
        t("Классификация отменена; исходная запись сохранена."),
        "progress-raw",
      ), "Классификация отменена; исходная запись сохранена."),
    );
  const actions = node("div", undefined, "progress-actions");
  if (job.parts?.length) {
    const drop = node("button", job.parts.length === 1 ? t("Убрать дело") : t("Убрать дела"), "text-button");
    drop.type = "button";
    drop.addEventListener("click", async () => {
      drop.disabled = true;
      const removed = job.parts;
      try {
        for (const part of removed) await request(`/api/captures/${part.id}`, { method: "DELETE" });
        job.parts = [];
        renderCaptureProgress(job, record);
        await load();
        toast(t("{value1} убрано из журнала", { value1: plural(removed.length, DEALS) }), { get label() { return t("Вернуть"); }, run: async () => {
          try { for (const part of removed) await request(`/api/captures/${part.id}/restore`, { method: "POST" }); await load(); toast(t("Вернул")); }
          catch (error) { toast(error.message); }
        } });
      } catch (error) { toast(error.message); drop.disabled = false; }
    });
    actions.append(drop);
  }
  if (!terminal(job)) {
    const cancel = bindTranslation(node("button", t("Отменить классификацию"), "text-button"), "Отменить классификацию");
    cancel.addEventListener("click", () => cancelCapture(record, cancel));
    actions.append(cancel);
  } else if (job.retryable) {
    const retry = node(
      "button",
      record.provider === "fallback"
        ? t("Повторить локальную классификацию")
        : t("Повторить с тем же провайдером (может использовать лимит)"),
      "text-button",
    );
    retry.addEventListener("click", () => retryCapture(job, record, retry));
    actions.append(retry);
  }
  if (terminal(job)) {
    const close = bindTranslation(node("button", t("Закрыть уведомление"), "notification-close"), "Закрыть уведомление");
    bindTranslation(close, "Закрыть уведомление", "aria-label");
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
      get question() { return t("Запись сохранена без разбора: укажите тип."); },
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
// «Легло: «Отправить смету» · сегодня» — единственный ответ на запись: что
// получилось и на какой день. Правится название в карточке, вернуть не нужно.
function layToast(record, job) {
  const entry = todayState.entries.find((candidate) => candidate.id === (record.captureId || job.captureId));
  const classification = entry?.interpretation.classification;
  const parts = job.parts || [];
  const clip = (text) => `«${String(text || "").slice(0, 60)}»`;
  // «Сделал X, надо Y»: отчёт закрыт, дела из него — на сегодня; считаем раздельно.
  if (classification?.completed === true && parts.length) return t("Легло: 1 сделано, {length} на сегодня — {value2}", { length: parts.length, value2: parts.map((part) => clip(part.title)).join(", ") });
  // Пачка дел: родитель не туду, в списках только отделившиеся дела.
  if (parts.length) return t("Легло: {value1} · {value2} — {value3}", { value1: plural(parts.length, [t("туду"), t("туду"), t("туду")]), value2: scheduleLabel(classification?.entities.schedule) || t("сегодня"), value3: parts.map((part) => clip(part.title)).join(", ") });
  const when = classification?.completed === true ? t("сделано") : scheduleLabel(classification?.entities.schedule) || t("сегодня");
  const title = (classification?.summary || record.raw || "").split("\n")[0].slice(0, 80);
  return !title ? t("Легло: 1 туду · {when}", { when: when }) : t("Легло: «{title}» · {when}", { title: title, when: when });
}
async function pollCapture(record) {
  if (!activeCapture(record)) return;
  try {
    const job = await request(record.statusUrl, { headers: record.flowId ? { 'X-Kizuna-Flow-Id': record.flowId } : {} });
    if (!activeCapture(record)) return;
    renderCaptureProgress(job, record);
    if (activeCapture(record).observedState !== job.state) {
      window.KizunaTelemetry?.emit('capture_job_observed', { flowId: record.flowId, captureId: record.captureId, jobId: record.jobId, state: job.state });
      activeCapture(record).observedState = job.state;
    }
    if (terminal(job)) {
      activeCapture(record).terminal = true;
      if (job.state === "succeeded") {
        await load();
        if (!activeCapture(record)) return;
        toast(layToast(record, job));
        window.KizunaTelemetry?.emit('capture_result_visible', { flowId: record.flowId, captureId: record.captureId, jobId: record.jobId,
          totalMs: record.submittedAt ? Math.max(0, Date.now()-record.submittedAt) : undefined });
        return;
      }
      persistActiveCaptures();
      return;
    }
    activeCapture(record).delay = Math.min(activeCapture(record).delay * 2, 5000);
  } catch {
    window.KizunaTelemetry?.emit('capture_poll_failed', { flowId: record.flowId, captureId: record.captureId, jobId: record.jobId, reason: 'other' });
    if (!activeCapture(record)) return;
    activeCapture(record).delay = Math.min(activeCapture(record).delay * 2, 5000);
    toast(t("Не удалось проверить статус классификации. Повторим автоматически."));
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
      throw new Error(t("Сервер не подтвердил повторную классификацию."));
    removeCapture(record);
    startCapturePolling({ ...record, jobId: retry.jobId, statusUrl: retry.statusUrl });
  } catch (error) {
    if (activeCapture(record)) {
      toast(error.message);
      button.disabled = false;
    }
  }
}
// ── Поле записи ──────────────────────────────────────────────────────────────
// Одно поле и одна кнопка. Тип, срок, важность и теги здесь не выбираются:
// сервер сам делает из текста дело на сегодня (или на названную дату), а
// поправить можно в карточке. Markdown оформляется прямо в поле, по мере набора;
// Enter отправляет, Shift+Enter переносит строку. Поле растёт вместе с текстом.
let capturePrompt;
const captureField = createMarkdownField({
  id: "capture-input",
  get ariaLabel() { return t("Новая запись"); },
  get placeholder() { return t("Что нужно сделать?"); },
  submitOnEnter: false,
  onSubmit: () => $("#capture-form").requestSubmit(),
  onInput: () => capturePrompt?.sync(),
});
$("#capture-form").prepend(captureField.element);
capturePrompt = createCapturePrompt(captureField);
attachLinkMenu(captureField);
// «@» прямо в записи: люди из ваших кругов, позванный увидит запись.
attachMentionMenu(captureField);
attachFormatToolbar(captureField, { prefs: window.pagentText });

// Отправка — ⌘+Enter, Ctrl+Enter или Super+Enter (в поле принимают и metaKey, и
// ctrlKey); простой Enter переносит строку, как в любом редакторе. Подпись и
// подсказка кнопки называют клавишу той платформы, где сидит человек: ⌘ — на Mac
// и iOS, Super — на Linux (Android, у которого ядро тоже Linux, не в счёт),
// Ctrl — везде ещё.
function captureModifier(platform = navigator.platform || "", agent = navigator.userAgent || "") {
  if (/Mac|iPhone|iPad|iPod/.test(platform)) return "⌘";
  if (/Linux/.test(`${platform} ${agent}`) && !/Android/.test(agent)) return "Super";
  return "Ctrl";
}
const CAPTURE_MOD = captureModifier();
bindTranslation($("#capture-submit"), "Сохранить запись — {CAPTURE_MOD}+Enter", { CAPTURE_MOD: CAPTURE_MOD }, "title");

// Лист: карточка выходит на передний план и вписывается в окно листом A4.
// DOM не перестраивается — переключаются два класса, поэтому текст, каретка и
// история отмены остаются на месте.
const expandButton = $("#capture-expand");
function captureLarge() {
  return $("#capture-form").classList.contains("capture-large");
}
function setCaptureLarge(large) {
  const form = $("#capture-form");
  form.classList.toggle("capture-large", large);
  document.body.classList.toggle("capture-large-open", large);
  appear(form, { shift: large ? 12 : 6, base: large ? "translate(-50%, -50%)" : "" });
  expandButton.setAttribute("aria-pressed", String(large));
  const label = large ? t("Свернуть поле — Esc") : t("Увеличить поле");
  expandButton.setAttribute("aria-label", label);
  expandButton.title = label;
  captureField.focus();
}
expandButton.addEventListener("click", () => setCaptureLarge(!captureLarge()));
// Esc возвращает обычный размер.
captureField.element.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && captureLarge()) {
    event.preventDefault();
    event.stopPropagation();
    setCaptureLarge(false);
  }
});
// Клик в сторону — то же, что Esc: лист лежит поверх затемнённой страницы, и
// нажатие мимо него его закрывает. Не «мимо» — сама форма и всплывающие меню
// поля: подсказки страниц и людей, панель оформления. Они живут в <body>, а не
// в форме, и без исключения закрывали бы лист на каждом выборе. Нажатие, а не
// клик: выделение мышью, начатое в поле и отпущенное за листом, не закрывает.
const CAPTURE_POPOVERS = "#capture-form, .link-menu, .mention-menu, .fmt-bar";
document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !captureLarge() || event.target.closest?.(CAPTURE_POPOVERS)) return;
  setCaptureLarge(false);
});

// Высота поля живёт в браузере и переживает перезагрузку; меняется нижним
// краем карточки. Края тянутся, как у окна: нижний — высота, боковые — ширина,
// углы — обе. Карточка стоит по центру, поэтому сдвиг бокового края удваивается.
// Двойной клик по краю возвращает размер по умолчанию.
const CAPTURE_HEIGHT = { min: 96, max: 480, key: "kizuna-capture-height" };
const CAPTURE_WIDTH = { min: 480, key: "kizuna-capture-width" };
function readCaptureSize(spec) {
  try {
    const value = Number(uiStorage.getItem(spec.key));
    return Number.isFinite(value) && value >= spec.min ? (spec.max ? Math.min(value, spec.max) : value) : null;
  } catch {
    return null;
  }
}
function paintCaptureSize() {
  const height = readCaptureSize(CAPTURE_HEIGHT);
  const width = readCaptureSize(CAPTURE_WIDTH);
  const form = $("#capture-form");
  const page = $("#today");
  if (height) form.style.setProperty("--capture-height", `${height}px`);
  else form.style.removeProperty("--capture-height");
  if (width) page.style.setProperty("--capture-width", `${Math.min(width, Math.max(0, window.innerWidth - 48))}px`);
  else page.style.removeProperty("--capture-width");
}
paintCaptureSize();
for (const grip of document.querySelectorAll("#capture-form .capture-resize")) {
  const dir = grip.dataset.dir;
  grip.addEventListener("dblclick", () => {
    try {
      if (/[ew]/.test(dir)) uiStorage.removeItem(CAPTURE_WIDTH.key);
      if (dir.includes("s")) uiStorage.removeItem(CAPTURE_HEIGHT.key);
    } catch {}
    paintCaptureSize();
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
        if (sx) uiStorage.setItem(CAPTURE_WIDTH.key, String(Math.round(width)));
        if (sy) uiStorage.setItem(CAPTURE_HEIGHT.key, String(Math.round(height)));
      } catch {}
      paintCaptureSize();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  });
}

// Ящики под полем — «День · Закрыто», полоса дней и списки — тянутся в ширину
// своими ручками, независимо от поля записи: поле растёт само, а колонка
// списков остаётся, где была. Колонка стоит по центру, поэтому сдвиг края
// удваивается. Ширина живёт в браузере и переживает перезагрузку; двойной
// клик по краю возвращает 800px. На телефоне ручек нет.
const DRAWERS_WIDTH = { min: 560, max: 1120 - 48, key: "kizuna-drawers-width" };
const drawersLimit = () => Math.max(DRAWERS_WIDTH.min, Math.min(1120, window.innerWidth) - 48);
function readDrawersWidth() {
  try {
    const value = Number(uiStorage.getItem(DRAWERS_WIDTH.key));
    return Number.isFinite(value) && value >= DRAWERS_WIDTH.min ? Math.min(value, DRAWERS_WIDTH.max) : null;
  } catch {
    return null;
  }
}
function paintDrawersWidth() {
  const width = readDrawersWidth();
  const page = $("#today");
  if (width) page.style.setProperty("--drawers-width", `${Math.min(width, Math.max(0, window.innerWidth - 48))}px`);
  else page.style.removeProperty("--drawers-width");
}
paintDrawersWidth();
for (const grip of document.querySelectorAll(".drawers .drawers-resize")) {
  grip.addEventListener("dblclick", () => {
    try { uiStorage.removeItem(DRAWERS_WIDTH.key); } catch {}
    paintDrawersWidth();
  });
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const drawers = $(".drawers");
    const startX = event.clientX;
    const startWidth = drawers.getBoundingClientRect().width;
    const sx = grip.dataset.dir === "e" ? 2 : -2;
    const max = drawersLimit();
    let width = startWidth;
    let moved = false;
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
    const move = (e) => {
      if (Math.abs(e.clientX - startX) < 2 && !moved) return;
      moved = true;
      width = Math.min(max, Math.max(DRAWERS_WIDTH.min, startWidth + sx * (e.clientX - startX)));
      $("#today").style.setProperty("--drawers-width", `${Math.round(width)}px`);
    };
    const stop = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", stop);
      grip.removeEventListener("pointercancel", stop);
      if (!moved) return;
      try { uiStorage.setItem(DRAWERS_WIDTH.key, String(Math.round(width))); } catch {}
      paintDrawersWidth();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  });
}

function idempotencyKey() {
  return `capture-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
function setCaptureBusy(isBusy) {
  $("#capture-submit").disabled = isBusy;
  captureField.setDisabled(isBusy);
  capturePrompt.sync();
}
$("#capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#capture-submit").disabled) return;
  const raw = captureField.getValue().trim();
  if (!raw) return;
  const telemetry = window.KizunaTelemetry?.submit(raw.length) || {};
  setCaptureBusy(true);
  try {
    const provider = null,
      result = await requestResponse("/api/captures", {
        method: "POST",
        headers: {
          Prefer: "respond-async",
          "Idempotency-Key": idempotencyKey(),
          ...(telemetry.flowId ? { 'X-Kizuna-Flow-Id': telemetry.flowId } : {}),
        },
        body: JSON.stringify(withProvider({ raw })),
      });
    if (result.response.status !== 202 || !safeCaptureEnvelope(result.data))
      throw new Error(t("Сервер не подтвердил асинхронное сохранение."));
    window.KizunaTelemetry?.accepted({ ...telemetry, captureId: result.data.captureId, jobId: result.data.jobId });
    captureField.clear();
    if (captureLarge()) setCaptureLarge(false);
    startCapturePolling({ ...result.data, ...telemetry, raw, provider: provider || "fallback" });
    uploadPendingShots(result.data.captureId);
    // Потолок исчерпан — запись сохранится, но разберут её правила. Сказать об
    // этом надо сразу: иначе человек решит, что разбор сломался.
    if (result.data.spend && !result.data.spend.allowed)
      toast(t("Потолок расходов исчерпан: запись сохранена, но разобрана по правилам"));
  } catch (error) {
    window.KizunaTelemetry?.failed(telemetry);
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
  area.append(bindTranslation(node("p", t("Ищем в памяти…"), "entry-meta"), "Ищем в памяти…"));
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
          ? t("Поиск по памяти")
          : t("Ответ памяти"),
      ),
      markdownNode("div", result.answer, undefined),
    );
    area.append(box);
    const sources = node("div", undefined, "sources");
    for (const source of result.sources.filter((source) =>
      result.citationIds.includes(source.captureId),
    )) {
      const card = node("div", undefined, "source");
      card.append(bindTranslation(node("strong", t("Источник")), "Источник"), markdownNode("div", source.snippet, undefined, { inline: true }));
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
    return;
  }
  const stored = appSettings[aiModelSetting(provider)];
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
function aiModelSetting(provider) {
  return { openai: "aiModel", openrouter: "openrouterModel", gemini: "geminiModel" }[provider];
}
async function onProviderChange() {
  const provider = $("#ai-provider"), model = $("#ai-model");
  provider.disabled = model.disabled = true;
  try {
    await saveSettings({ aiProvider: selectedProvider() });
    await status();
  } catch (error) { toast(error.message); }
  finally { provider.disabled = model.disabled = false; }
}
async function onModelChange() {
  const provider = $("#ai-provider"), model = $("#ai-model");
  const name = aiModelSetting(selectedProvider());
  if (!name) return;
  provider.disabled = model.disabled = true;
  try {
    await saveSettings({ [name]: model.value });
    await status();
  } catch (error) { toast(error.message); }
  finally { provider.disabled = model.disabled = false; }
}
let aiStatusRevision = 0;
async function status() {
  const revision = ++aiStatusRevision;
  const data = await request("/api/admin/ai/status"),
    selector = $("#ai-provider");
  if (revision !== aiStatusRevision) return;
  clear(selector);
  for (const id of Object.keys(providerNames)) {
    const info = data.providers[id],
      option = node(
        "option",
        `${providerNames[id]}${info?.available ? "" : t(" — недоступен")}`,
      );
    option.value = id;
    option.disabled = id !== "fallback" && !info?.available;
    selector.append(option);
  }
  const chosen = data.selectedProvider || data.defaultProvider;
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
    ? t("Выбран: {value1}", { value1: providerNames[selectedProvider()] })
    : t("Выбран: {value1} — недоступен", { value1: providerNames[selectedProvider()] });
  element.className = !available
    ? "status fallback"
    : selectedProvider() === "fallback"
      ? "status"
      : "status ai";
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
    const telemetryStarted = performance.now();
    try {
      await Promise.all([load(), loadSettings(), loadNotifications()]);
      resumeCapture();
      syncPushSubscription();
      window.KizunaTelemetry?.emit('bootstrap_finished', { durationMs: performance.now()-telemetryStarted });
    } catch {
      window.KizunaTelemetry?.emit('bootstrap_failed', { durationMs: performance.now()-telemetryStarted });
      toast(t("Не удалось загрузить данные. Повторим при восстановлении сети."));
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
  "telegramBotToken",
  "aiProvider",
  "aiModel",
  "openrouterModel",
  "geminiModel",
  "timeZone",
  "remindDefault",
  "remindHour",
  "quietHours",
  "theme",
  "locale",
  "requestedTimeZone",
  "modelTemperature",
  "modelMaxTokens",
  "modelReasoning",
  "monthlyLimitUsd",
];
const SECRET_FIELDS = ["openaiKey", "geminiKey", "openrouterKey", "googleClientSecret", "telegramBotToken"];
let appSettings = getLocalePreferences();
let settingsPreferenceSaveQueue = Promise.resolve();
let timeZoneSaveRevision = 0;
let pendingTimeZoneChoice = null;
let localeSaveRevision = 0;
let pendingLocaleChoice = null;
function settingInput(name) {
  return document.getElementById(`setting-${name}`);
}
function paintSettings(payload, { updatedFields = null, submittedValues = null } = {}) {
  const settings = payload.settings || {};
  appSettings = updatedFields
    ? { ...appSettings, ...Object.fromEntries(updatedFields.filter(name => Object.hasOwn(settings, name)).map(name => [name, settings[name]])) }
    : settings;
  initLocale(pendingLocaleChoice === null ? appSettings : { ...appSettings, locale: pendingLocaleChoice });
  syncLanguageControls();
  if (!updatedFields || updatedFields.some(name => ["requestedTimeZone", "detectedTimeZone", "timeZone"].includes(name))) {
    initTimeZone({ ...payload, settings: appSettings }, pendingTimeZoneChoice);
    paintTimeZoneSetting();
  }
  for (const name of SETTING_FIELDS) {
    const input = settingInput(name);
    if (!input || (updatedFields && !updatedFields.includes(name))) continue;
    const value = name === "locale" && pendingLocaleChoice !== null ? pendingLocaleChoice : name === "requestedTimeZone" && pendingTimeZoneChoice !== null ? pendingTimeZoneChoice : appSettings[name];
    const hasNewDraft = submittedValues && Object.hasOwn(submittedValues, name) && input.value !== submittedValues[name];
    if (SECRET_FIELDS.includes(name)) {
      // Поле ключа всегда пустое: показывать нечего, а подпись рядом говорит,
      // настроен он и откуда взялся.
      if (!hasNewDraft && document.activeElement !== input) input.value = "";
      const state = document.getElementById(`state-${name}`);
      if (state)
        state.textContent = value?.configured
          ? `${value.hint}${value.fromEnvironment ? t(" · из .env") : ""}`
          : t("не настроен");
      continue;
    }
    // Поле, в котором человек сейчас печатает, не трогаем: автосохранение
    // соседней настройки не должно отбирать недописанный текст и каретку.
    const next = String(value ?? "");
    if (!hasNewDraft && document.activeElement !== input && input.value !== next) input.value = next;
  }
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
    const remembered = appSettings.theme;
    if (!window.pagentTheme.hasChoice() && ["system", "light", "dark"].includes(remembered)) window.pagentTheme.set(remembered);
    settingInput("theme").value = window.pagentTheme.read();
    paintThemeButton();
  }
  paintNotifySettings();
}
// Расходы: сколько ушло токенов и денег. Показываем три окна — сутки, неделя,
// всё время, — потому что «сколько я трачу» это вопрос про темп, а не про сумму.
const usageKinds = { get classify() { return t("разбор"); }, get answer() { return t("память"); } };
function money(value) {
  if (!value) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
function tokens(value) {
  if (value >= 1000000) return t("{value1} млн", { value1: (value / 1000000).toFixed(1) });
  if (value >= 1000) return t("{value1} тыс.", { value1: Math.round(value / 1000) });
  return String(value);
}
function usageRow(title, slice) {
  const row = node("div", undefined, "usage-row");
  row.append(
    node("span", title, "usage-when"),
    bindTranslation(node("span", t("{calls} вызовов", { calls: slice.calls }), "usage-calls"), "{calls} вызовов", { calls: slice.calls }),
    node("span", `${tokens(slice.inputTokens)} → ${tokens(slice.outputTokens)}`, "usage-tokens"),
    node("span", money(slice.costUsd), "usage-money"),
  );
  return row;
}
let usageLoadRevision = 0;
async function loadUsage() {
  const box = $("#usage-table");
  if (!box) return;
  const revision = ++usageLoadRevision;
  const period = $("#admin-usage-period").value;
  const [data, report] = await Promise.all([
    request("/api/admin/usage"),
    request(`/api/admin/reports?period=${period}`),
  ]);
  if (revision !== usageLoadRevision) return;
  renderReportsService($("#admin-reports-service"), report);
  clear(box);
  box.append(usageRow(t("За сутки"), data.day), usageRow(t("За неделю"), data.week), usageRow(t("Всего"), data.total));
  if (!data.total.calls) {
    box.append(bindTranslation(node("p", t("Пока ничего не потрачено."), "empty"), "Пока ничего не потрачено."));
    return;
  }
  // Разбивка по моделям: видно, что именно съедает деньги.
  for (const row of data.total.rows.slice(0, 6)) {
    const line = node("div", undefined, "usage-row usage-detail");
    line.append(
      node("span", `${providerNames[row.provider] || row.provider} · ${row.model || "—"}`, "usage-when"),
      node("span", `${row.calls}`, "usage-calls"),
      node("span", `${tokens(row.inputTokens)} → ${tokens(row.outputTokens)}`, "usage-tokens"),
      node("span", row.unpriced ? t("{value1} · {unpriced} без цены", { value1: money(row.costUsd), unpriced: row.unpriced }) : money(row.costUsd), "usage-money"),
    );
    box.append(line);
  }
}
// ── память помощника ────────────────────────────────────────────────────────
// Память правит разбор молча, поэтому её показывают целиком: видно, откуда
// правило взялось, и любое можно стереть. Без этого «помощник что-то запомнил»
// было бы страшнее, чем полезно.
const MEMORY_SOURCES = { get correction() { return t("из поправки"); }, get voice() { return t("сказано голосом"); }, get manual() { return t("записано руками"); }, get import() { return t("перенесено"); } };
async function loadMemory() {
  const wrap = $("#memory-list");
  if (!wrap) return;
  try {
    const state = await request("/api/agent/memory");
    paintMemory(state);
  } catch (error) {
    clear(wrap);
    wrap.append(node("p", error.message, "setting-hint"));
  }
}
function paintMemory({ memories = [], canShare = false } = {}) {
  memories = memories.filter(memory => memory.scope === 'user');
  const wrap = $("#memory-list");
  clear(wrap);
  const sharedRow = $("#memory-shared-row");
  if (sharedRow) sharedRow.hidden = !canShare;
  if (!memories.length) {
    wrap.append(bindTranslation(node("p", t("Пока ничего: помощник запомнит первое же, что вы поправите или попросите запомнить."), "setting-hint"), "Пока ничего: помощник запомнит первое же, что вы поправите или попросите запомнить."));
    return;
  }
  for (const memory of memories) {
    const row = node("div", undefined, `memory-item${memory.scope === "shared" ? " is-shared" : ""}`);
    row.append(node("span", memory.body, "memory-body"));
    const marks = [memory.scope === "shared" ? t("общее") : null, MEMORY_SOURCES[memory.source] || memory.source].filter(Boolean);
    row.append(node("span", marks.join(" · "), "memory-meta"));
    const forget = calButton(t("Забыть"), "secondary memory-forget", async () => {
      forget.disabled = true;
      try {
        paintMemory(await request(`/api/agent/memory/${memory.id}`, { method: "DELETE" }));
        toast(t("Забыл"));
      } catch (error) { forget.disabled = false; toast(error.message); }
    });
    // Общее правило человек видит, но стереть его может только тот, кому
    // доверена установка: оно действует и на других.
    forget.disabled = memory.scope === "shared" && !canShare;
    row.append(forget);
    wrap.append(row);
  }
}
async function rememberRule() {
  const input = $("#memory-new");
  const text = input.value.trim();
  if (!text) return;
  const shared = false;
  try {
    paintMemory(await request("/api/agent/memory", { method: "POST", body: JSON.stringify({ text, scope: shared ? "shared" : "user" }) }));
    input.value = "";
    toast(shared ? t("Запомнил для всех") : t("Запомнил"));
  } catch (error) { toast(error.message); }
}

function paintTimeZoneSetting() {
  const input = settingInput("requestedTimeZone");
  if (!input) return;
  const selected = pendingTimeZoneChoice ?? appSettings.requestedTimeZone ?? "system";
  if (input.options.length < 2) {
    const zones = new Set(["UTC", getTimeZone(), ...(Intl.supportedValuesOf?.("timeZone") || [])].map(normalizeTimeZone).filter(Boolean));
    for (const zone of [...zones].sort()) input.append(new Option(zone, zone));
  }
  if (selected !== "system" && ![...input.options].some(option => option.value === selected)) input.append(new Option(selected, selected));
  input.value = selected;
  const effective = $("#setting-effectiveTimeZone");
  if (effective) effective.textContent = getTimeZone();
}
async function persistTimeZone(choice, { detectionOnly = false } = {}) {
  const revision = ++timeZoneSaveRevision;
  const detectedTimeZone = getDetectedTimeZone(appSettings.detectedTimeZone);
  if (!detectionOnly) {
    pendingTimeZoneChoice = choice;
    setTimeZone(choice);
    paintTimeZoneSetting();
  }
  settingsPreferenceSaveQueue = settingsPreferenceSaveQueue.then(async () => {
    try {
      const patch = { ...(detectionOnly ? {} : { requestedTimeZone: choice }), ...(detectedTimeZone ? { detectedTimeZone } : {}) };
      const payload = await request("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      appSettings = { ...appSettings, requestedTimeZone: payload.settings.requestedTimeZone, detectedTimeZone: payload.settings.detectedTimeZone };
      if (revision !== timeZoneSaveRevision) return;
      pendingTimeZoneChoice = null;
      initTimeZone({ ...payload, settings: appSettings });
      paintTimeZoneSetting();
      announceTimeZoneSaved();
      load().catch(() => {});
      const page = location.hash.slice(1).split("?")[0];
      if (page === "board") loadBoard({ force: true });
      if (page === "calendar") loadCalendar();
      if (page === "done") loadDone({ fresh: true });
    } catch (error) {
      if (revision !== timeZoneSaveRevision) return;
      pendingTimeZoneChoice = null;
      initTimeZone({ settings: appSettings });
      paintTimeZoneSetting();
      toast(error.message);
    }
  });
  return settingsPreferenceSaveQueue;
}
function detectChangedTimeZone() {
  if (!Object.hasOwn(appSettings, "requestedTimeZone") || pendingTimeZoneChoice !== null) return;
  const detected = getDetectedTimeZone(appSettings.detectedTimeZone);
  if (detected && detected !== appSettings.detectedTimeZone) persistTimeZone(appSettings.requestedTimeZone, { detectionOnly: true });
}
settingInput("requestedTimeZone")?.addEventListener("change", event => persistTimeZone(event.target.value));
window.addEventListener("focus", detectChangedTimeZone);
window.addEventListener("pagent:systemtimezonechange", detectChangedTimeZone);
document.addEventListener("visibilitychange", () => { if (!document.hidden) detectChangedTimeZone(); });

async function loadSettings() {
  if (!settingInput("timeZone")) return;
  try {
    const localeRevision = localeSaveRevision;
    const timeZoneRevision = timeZoneSaveRevision;
    const submittedValues = Object.fromEntries(SETTING_FIELDS.map(name => [name, settingInput(name)?.value]));
    const payload = await request("/api/settings");
    // An initial GET can finish after a choice was already acknowledged.
    // Retain those committed preferences and any edits made while it loaded.
    if (localeSaveRevision !== localeRevision && Object.hasOwn(appSettings, "locale")) {
      payload.settings = { ...payload.settings, locale: appSettings.locale, detectedLocale: appSettings.detectedLocale };
    }
    if (timeZoneSaveRevision !== timeZoneRevision) {
      payload.timeZone = undefined;
      if (Object.hasOwn(appSettings, "requestedTimeZone")) payload.settings = { ...payload.settings, requestedTimeZone: appSettings.requestedTimeZone, detectedTimeZone: appSettings.detectedTimeZone };
    }
    paintSettings(payload, { submittedValues });
    const detectedLocale = getDetectedLocale(appSettings.detectedLocale);
    const detectedTimeZone = getDetectedTimeZone(appSettings.detectedTimeZone);
    const patch = {};
    if (detectedLocale && appSettings.detectedLocale !== detectedLocale) patch.detectedLocale = detectedLocale;
    if (detectedTimeZone && appSettings.detectedTimeZone !== detectedTimeZone) patch.detectedTimeZone = detectedTimeZone;
    if (Object.keys(patch).length) {
      const detectionTimeZoneRevision = timeZoneSaveRevision;
      settingsPreferenceSaveQueue = settingsPreferenceSaveQueue.then(async () => {
        try {
          const detected = await request("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
          if (timeZoneSaveRevision !== detectionTimeZoneRevision) detected.timeZone = undefined;
          paintSettings(detected, { updatedFields: Object.keys(patch) });
          if (Object.hasOwn(patch, "detectedTimeZone") && timeZoneSaveRevision === detectionTimeZoneRevision && pendingTimeZoneChoice === null) announceTimeZoneSaved();
        } catch {
          // Device detection must not prevent a later explicit choice saving.
        }
      });
      await settingsPreferenceSaveQueue;
    }
  } catch {
    // Настройки не открылись — приложение всё равно работает на прежних.
  }
}
async function saveSettings(patch, { announce = t("Настройки сохранены") } = {}) {
  const status = document.body.classList.contains('admin-mode') ? $("#admin-settings-status") : $("#settings-status");
  bindTranslation(status, "Сохраняем…");
  const updatedFields = Object.keys(patch);
  const submittedValues = Object.fromEntries(updatedFields.map(name => [name, settingInput(name)?.value]));
  try {
    paintSettings(
      await request("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
      { updatedFields, submittedValues },
    );
    bindTranslation(status, "Сохранено");
    if (announce) toast(announce);
    // Новый токен бота — раздел «Telegram» ждёт, пока бот выйдет на связь.
    if (Object.hasOwn(patch, "telegramBotToken")) loadTelegram();
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
  if (name === "theme" || name === "locale" || name === "requestedTimeZone") continue;
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
$("#settings-forget")?.addEventListener("click", () => {
  saveSettings(Object.fromEntries(SECRET_FIELDS.map((name) => [name, ""])));
});
$("#memory-add")?.addEventListener("click", () => rememberRule());
// Enter в строке правила — то же, что кнопка: правило пишут на одном дыхании.
$("#memory-new")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); rememberRule(); }
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
    toast(t("Введите точную фразу подтверждения"));
    return;
  }
  try {
    await request("/api/reset", {
      method: "POST",
      body: JSON.stringify({ get confirmation() { return t("СБРОСИТЬ КИЗУНА"); } }),
    });
    $("#reset-dialog").close();
    $("#reset-confirmation").value = "";
    closeCard();
    for (const record of [...activeCaptures.values()]) removeCapture(record);
    localStorage.removeItem(activeCaptureStorageKey);
    $("#capture-notifications").replaceChildren();
    toast(t("Локальный журнал очищен"));
    await load();
  } catch (error) {
    toast(error.message);
  }
});
$("#admin-usage-period").addEventListener("change", () => loadUsage().catch(error => toast(error.message)));
$("#ai-provider").addEventListener("change", onProviderChange);
$("#ai-model").addEventListener("change", onModelChange);
$("#review-close").addEventListener("click", requestCardClose);
$("#review-params-toggle").addEventListener("click", () => setCardParams(!cardParamsOpen));
$("#review-params-close").addEventListener("click", () => setCardParams(false));
// Escape и клик по подложке закрывают карточку; что менялось — сохраняется.
$("#review-dialog").addEventListener("close", () => {
  // Смена режима закрывает окно и тут же открывает заново (reopenCardDialog):
  // к приходу этого события оно уже открыто, и карточка остаётся на месте.
  if ($("#review-dialog").open) return;
  setCardModeMenu(false);
  // Esc закрывает диалог сам, мимо closeCard: правки забираем и меню разметки
  // убираем здесь же, пока поля ещё на месте — иначе меню осталось бы на
  // документе вместе со своим слушателем клавиш, а правки пропали бы.
  flushCard();
  closeCardSlashMenu?.();
  dropCardTalk();
  dropCardFlow();
  resetCardFocus();
  clear($("#review"));
  syncCardViewport();
  markOpenCard();
});
// Esc идёт по слоям: сначала закрывает меню режимов и панель «Параметры»,
// потом сворачивает разговор, у подзадачи возвращает к родителю — и только у
// корня закрывает карточку. Возвращает true, когда закрыл слой, а не карточку.
function cardEscape() {
  const dialog = $("#review-dialog");
  if (cardModeMenuOpen()) { setCardModeMenu(false); $("#review-mode-toggle").focus({ preventScroll: true }); return true; }
  if (cardParamsOpen) { setCardParams(false); return true; }
  if (dialog.classList.contains("talk-open")) { dialog.querySelector(".talk-close")?.click(); return true; }
  if (cardStack.length) { goBackCard(); return true; }
  return false;
}
$("#review-dialog").addEventListener("cancel", (event) => {
  if (cardEscape()) event.preventDefault();
});
// У обычного окна («сбоку») Esc сам ничего не делает — закрывает его этот
// слушатель, по тем же слоям. Он висит на window, то есть после всех
// слушателей страницы: у кого-то Esc уже занят (меню разметки, заголовок в
// поле) — тот отменил его сам. Поле ввода страницы и её всплывающие списки
// свой Esc оставляют себе.
const CARD_PAGE_OWNS_ESCAPE = "input, textarea, select, [contenteditable='true'], .board-vals, .board-column.ghost, header details[open], .kc-menu, #capture-form";
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  const dialog = $("#review-dialog");
  if (!dialog.open || dialog.matches(":modal") || document.querySelector("dialog:modal")) return;
  const target = event.target;
  if (target instanceof Element && !dialog.contains(target) && target.closest(CARD_PAGE_OWNS_ESCAPE)) return;
  event.preventDefault();
  if (!cardEscape()) closeCard();
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
// Окно сбоку на телефоне — модальное и во весь экран: при переходе через
// границу оно переоткрывается тем способом, который просит ширина.
CARD_PHONE.addEventListener("change", () => {
  const dialog = $("#review-dialog");
  if (dialog.open && dialog.matches(":modal") !== cardNeedsModal()) reopenCardDialog(dialog);
  syncCardViewport();
});
// Клик по подложке закрывает модальную карточку; щелчок, закрывший меню режимов,
// карточку тоже не закрывает.
$("#review-dialog").addEventListener("click", (event) => {
  const dialog = $("#review-dialog");
  if (event.target !== dialog || !dialog.matches(":modal")) return;
  if (cardModeMenuDismissed) { cardModeMenuDismissed = false; return; }
  closeCard();
});
// У обычного окна («сбоку») подложки нет, а страница за ним жива, поэтому мимо
// карточки — это нажатие вне окна: оно закрывает карточку, как подложка у
// модальной, и набранное сохраняется. Не закрывает нажатие по тому, что само
// открывает запись, — карточке или строке с data-capture-id (доска, список,
// «Сегодня», «Закрыто»): тогда открытая карточка переключается на ту запись, — и
// по плавающему, что живёт вне окна: меню разметки, ссылок и упоминаний, колокольчик
// и меню учётной записи, плашка календаря, уведомление с «Вернуть». Нажатие, которое
// закрывает меню режимов, карточку не закрывает. Правая и средняя кнопки тоже.
const CARD_OUTSIDE_KEEPS = "[data-capture-id], .mention-menu, .link-menu, .slash-menu, .fmt-bar, .bell-menu, .account-menu, .cal-pop, #toast";
document.addEventListener("pointerdown", (event) => {
  const dialog = $("#review-dialog");
  if (event.button !== 0 || !dialog.open || dialog.matches(":modal") || document.querySelector("dialog:modal")) return;
  const target = event.target;
  if (!(target instanceof Element) || dialog.contains(target) || target.closest(CARD_OUTSIDE_KEEPS)) return;
  if (cardModeMenuOpen() || cardModeMenuDismissed) return;
  closeCard();
}, true);

// ── режимы показа карточки ───────────────────────────────────────────────────
// Где открывать карточку, человек выбирает один раз, и выбор помнится для всех
// карточек. «По центру» — окно поверх страницы с зазорами по краям, «сбоку» —
// во весь рост справа, доска за ней видна и жива, «во весь экран» — как
// страница. Окно по центру и во весь экран модальное (страница под ним
// замирает), сбоку — обычное: щелчок по другой карточке доски меняет
// содержимое открытой, а не открывает вторую. На телефоне все три режима — во
// весь экран, и окно всегда модальное.
const CARD_MODE_KEY = "kizuna-card-mode";
const CARD_MODES = {
  center: { get words() { return t("по центру"); }, icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="7" y="8" width="10" height="8" rx="1"/>' },
  side: { get words() { return t("сбоку"); }, icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 4v16"/>' },
  full: { get words() { return t("во весь экран"); }, icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>' },
};
function readCardMode() {
  try {
    const value = uiStorage.getItem(CARD_MODE_KEY);
    return Object.hasOwn(CARD_MODES, value) ? value : "center";
  } catch {
    return "center";
  }
}
const cardNeedsModal = (mode = readCardMode()) => mode !== "side" || CARD_PHONE.matches;
function paintCardMode() {
  const mode = readCardMode();
  $("#review-dialog").dataset.mode = mode;
  $("#review-mode-icon").innerHTML = CARD_MODES[mode].icon;
  for (const item of $("#review-mode-menu").querySelectorAll("[data-mode]"))
    item.setAttribute("aria-checked", String(item.dataset.mode === mode));
}
paintCardMode();
// Окно открывается тем способом, который просит режим.
function openCardDialog(dialog) {
  paintCardMode();
  if (cardNeedsModal()) dialog.showModal();
  else dialog.show();
}
// Сбоку карточка выезжает из-за правого края, в остальных режимах — тихо
// проявляется на месте, как всегда.
function appearCard(dialog) {
  if (dialog.dataset.mode !== "side" || CARD_PHONE.matches) return appear(dialog);
  if (!motionAllowed()) return null;
  for (const animation of dialog.getAnimations()) animation.cancel();
  return dialog.animate(
    [{ opacity: 0.4, transform: "translateX(40px)" }, { opacity: 1, transform: "none" }],
    { duration: 220, easing: APPEAR_EASING },
  );
}
// Из модального окна в обычное и обратно без потери карточки: окно закрывается
// и тут же открывается заново, содержимое стоит на месте. Закрытие стирает
// прокрутку — возвращаем её.
function reopenCardDialog(dialog) {
  const focused = document.activeElement;
  const scrolls = [...dialog.querySelectorAll(".review, .card-params-body, .thread-list")].map((element) => [element, element.scrollTop]);
  for (const animation of dialog.getAnimations()) animation.cancel();
  dialog.close();
  openCardDialog(dialog);
  syncCardViewport();
  for (const [element, top] of scrolls) element.scrollTop = top;
  (focused instanceof HTMLElement && dialog.contains(focused) ? focused : dialog).focus({ preventScroll: true });
}
// Окно меняет вид без перехода: ширина и положение прыгают, а не ползут.
function jumpCardSize(change) {
  const dialog = $("#review-dialog");
  dialog.classList.add("jump");
  change();
  requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.remove("jump")));
}
function setCardMode(next) {
  if (!Object.hasOwn(CARD_MODES, next)) return;
  const dialog = $("#review-dialog"), prev = readCardMode();
  try { uiStorage.setItem(CARD_MODE_KEY, next); } catch {}
  jumpCardSize(() => {
    paintCardMode();
    if (dialog.open && dialog.matches(":modal") !== cardNeedsModal(next)) reopenCardDialog(dialog);
    markOpenCard();
  });
  if (dialog.open && next !== prev) cardSnack(t("Карточки открываются {words}", { words: CARD_MODES[next].words }));
}
// Меню режимов: значок в верхней строке рядом с «Параметры». Закрывается
// выбором, щелчком мимо, Esc и уходом фокуса; стрелки ходят по пунктам.
const cardModes = $("#review-modes");
const cardModeMenu = $("#review-mode-menu");
const cardModeToggle = $("#review-mode-toggle");
let cardModeMenuDismissed = false;
const cardModeMenuOpen = () => !cardModeMenu.hidden;
function setCardModeMenu(open, { focus = false } = {}) {
  cardModeMenu.hidden = !open;
  cardModeToggle.setAttribute("aria-expanded", String(open));
  if (open && focus) (cardModeMenu.querySelector('[aria-checked="true"]') || cardModeMenu.querySelector("button"))?.focus({ preventScroll: true });
}
cardModeToggle.addEventListener("click", (event) => setCardModeMenu(!cardModeMenuOpen(), { focus: event.detail === 0 }));
cardModeMenu.addEventListener("click", (event) => {
  const item = event.target.closest("[data-mode]");
  if (!item) return;
  setCardModeMenu(false);
  setCardMode(item.dataset.mode);
  cardModeToggle.focus({ preventScroll: true });
});
cardModes.addEventListener("keydown", (event) => {
  const items = [...cardModeMenu.querySelectorAll("[data-mode]")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "Escape" && cardModeMenuOpen()) {
    event.preventDefault();
    event.stopPropagation();
    setCardModeMenu(false);
    cardModeToggle.focus({ preventScroll: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!cardModeMenuOpen()) { setCardModeMenu(true, { focus: true }); return; }
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length].focus({ preventScroll: true });
  } else if (event.key === "Tab" && cardModeMenuOpen()) setCardModeMenu(false);
});
document.addEventListener("pointerdown", (event) => {
  if (!cardModeMenuOpen() || event.target.closest?.("#review-modes")) return;
  setCardModeMenu(false);
  cardModeMenuDismissed = true;
  setTimeout(() => { cardModeMenuDismissed = false; }, 400);
});

// ── размер окна ──────────────────────────────────────────────────────────────
// Края окна тянутся, как у поля записи на «Сегодня»: боковые — ширина, нижний —
// высота, нижние углы — обе. Окно по центру стоит посередине, поэтому сдвиг
// бокового края удваивается, а верх остаётся на месте — растёт вниз. «Сбоку»
// тянется только левый край. Размер помнится в kizuna-card-size = { w, h, sw }:
// ширина и высота окна по центру, ширина панели сбоку. Двойной клик по краю
// возвращает размер по умолчанию — высоту снова задаёт содержимое.
const CARD_SIZE_KEY = "kizuna-card-size";
const CARD_SIZE_MIN = { w: 560, h: 360, sw: 420 };
const clampNumber = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
function readCardSize() {
  const pick = (value, min) => (Number.isFinite(value) && value >= min ? Math.round(value) : null);
  try {
    const stored = JSON.parse(uiStorage.getItem(CARD_SIZE_KEY));
    if (stored && typeof stored === "object") return { w: pick(stored.w, CARD_SIZE_MIN.w), h: pick(stored.h, CARD_SIZE_MIN.h), sw: pick(stored.sw, CARD_SIZE_MIN.sw) };
  } catch {}
  return { w: null, h: null, sw: null };
}
function writeCardSize(patch) {
  const next = { ...readCardSize(), ...patch };
  try {
    if (next.w === null && next.h === null && next.sw === null) uiStorage.removeItem(CARD_SIZE_KEY);
    else uiStorage.setItem(CARD_SIZE_KEY, JSON.stringify(next));
  } catch {}
}
function paintCardSize() {
  const dialog = $("#review-dialog"), size = readCardSize();
  for (const [name, value] of [["--card-w", size.w], ["--card-h", size.h], ["--card-sw", size.sw]]) {
    if (value) dialog.style.setProperty(name, `${value}px`);
    else dialog.style.removeProperty(name);
  }
}
paintCardSize();
for (const grip of document.querySelectorAll("#review-dialog .card-resize")) {
  const dir = grip.dataset.dir;
  grip.addEventListener("dblclick", () => {
    writeCardSize($("#review-dialog").dataset.mode === "side" ? { sw: null } : { w: null, h: null });
    jumpCardSize(paintCardSize);
    cardSnack(t("Размер по умолчанию"));
  });
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const dialog = $("#review-dialog"), badge = $("#review-size-badge");
    const side = dialog.dataset.mode === "side";
    const box = dialog.getBoundingClientRect();
    const column = dialog.querySelector(".card-main").getBoundingClientRect();
    // Ширина окна по центру — это ширина колонки содержимого: открытая панель
    // «Параметры» в неё не входит, а место ей нужно.
    const params = cardParamsOpen ? dialog.querySelector(".card-params").getBoundingClientRect().width : 0;
    const start = { x: event.clientX, y: event.clientY, w: column.width, h: box.height, sw: box.width };
    const sx = dir.includes("e") ? 2 : dir.includes("w") ? -2 : 0;
    const sy = dir.includes("s") ? 1 : 0;
    let next = {};
    let moved = false;
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
    const move = (e) => {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      if (!moved) {
        moved = true;
        dialog.classList.add("resizing");
      }
      next = {};
      if (side) next.sw = Math.round(clampNumber(start.sw - dx, CARD_SIZE_MIN.sw, window.innerWidth - 200));
      else {
        if (sx) next.w = Math.round(clampNumber(start.w + sx * dx, CARD_SIZE_MIN.w, window.innerWidth - 48 - params));
        if (sy) next.h = Math.round(clampNumber(start.h + sy * dy, CARD_SIZE_MIN.h, window.innerHeight - 80));
      }
      for (const [name, value] of [["--card-w", next.w], ["--card-h", next.h], ["--card-sw", next.sw]])
        if (value) dialog.style.setProperty(name, `${value}px`);
      const now = dialog.getBoundingClientRect();
      badge.textContent = `${Math.round(side ? now.width : dialog.querySelector(".card-main").getBoundingClientRect().width)} × ${Math.round(now.height)}`;
    };
    const stop = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", stop);
      grip.removeEventListener("pointercancel", stop);
      dialog.classList.remove("resizing");
      if (!moved) return;
      writeCardSize(next);
      paintCardSize();
      dialog.classList.add("sized");
      setTimeout(() => dialog.classList.remove("sized"), 900);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  });
}
// Высота поля обсуждения внизу карточки — одна на все карточки и все режимы:
// тянется верхней кромкой поля (полоса строится вместе с полем в cardDiscussion),
// помнится в kizuna-card-talk-height, двойной клик возвращает прежнюю, по
// содержимому. Растёт только поле: окно остаётся в своих зазорах, а основная
// часть отдаёт ему место.
const CARD_TALK_HEIGHT = { min: 44, max: 360, key: "kizuna-card-talk-height" };
function readTalkHeight() {
  try {
    const value = Number(uiStorage.getItem(CARD_TALK_HEIGHT.key));
    return Number.isFinite(value) && value > CARD_TALK_HEIGHT.min ? Math.min(Math.round(value), CARD_TALK_HEIGHT.max) : null;
  } catch {
    return null;
  }
}
function paintTalkHeight() {
  const dialog = $("#review-dialog"), height = readTalkHeight();
  if (height) dialog.style.setProperty("--talk-h", `${height}px`);
  else dialog.style.removeProperty("--talk-h");
}
paintTalkHeight();
function attachTalkResize(grip, composer) {
  grip.addEventListener("dblclick", () => {
    try { uiStorage.removeItem(CARD_TALK_HEIGHT.key); } catch {}
    paintTalkHeight();
  });
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const dialog = $("#review-dialog");
    const startY = event.clientY;
    const startHeight = composer.getBoundingClientRect().height;
    const max = Math.min(CARD_TALK_HEIGHT.max, window.innerHeight - 280);
    let height = startHeight;
    let moved = false;
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
    const move = (e) => {
      if (!moved && Math.abs(e.clientY - startY) < 3) return;
      moved = true;
      height = clampNumber(startHeight - (e.clientY - startY), CARD_TALK_HEIGHT.min, max);
      dialog.style.setProperty("--talk-h", `${Math.round(height)}px`);
    };
    const stop = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", stop);
      grip.removeEventListener("pointercancel", stop);
      if (!moved) return;
      try { uiStorage.setItem(CARD_TALK_HEIGHT.key, String(Math.round(height))); } catch {}
      paintTalkHeight();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
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
let initialDayRendered = false;
let journalRefreshPending = false;
function reloadJournalSoon() {
  // Приветствие потока не должно отменять первый ответ /api/day: иначе
  // dayLoadToken отбросит его до появления вкладок и брифа.
  if (!initialDayRendered) {
    journalRefreshPending = true;
    return;
  }
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
  journalStream.addEventListener("ui-preferences", event => {
    try { receiveUiPreferences(JSON.parse(event.data)); } catch {}
  });
  journalStream.addEventListener("ready", refreshUiPreferences);
  journalStream.addEventListener("journal", reloadJournalSoon);
  // В Telegram нажали «Запустить» по ссылке из настроек — привязка готова.
  journalStream.addEventListener("telegram", () => loadTelegram({ announce: true }));
  journalStream.addEventListener('administration', () => adminArea.refresh());
  // Уведомление в открытую вкладку: строка за колокольчиком и, если повод из
  // тех, что идут на телефон, всплывашка в углу. Push сюда не дублируется —
  // сервер шлёт его, только когда вкладок нет.
  journalStream.addEventListener("notification", (event) => {
    try {
      const { notification, counts, toast: pop } = JSON.parse(event.data);
      bellState.counts = counts || bellState.counts;
      bellState.items = [notification, ...bellState.items.filter((item) => item.id !== notification.id)];
      bellDone.delete(notification.id);
      paintBell();
      if (notification.kind === "invite") renderToday();
      if (pop) showNotificationToast(notification);
    } catch {}
  });
  // Прочитали или ответили в другой вкладке — число на колокольчике здесь то же.
  journalStream.addEventListener("notifications", (event) => {
    try {
      bellState.counts = JSON.parse(event.data).counts || bellState.counts;
      paintBell();
      if ($("#bell-menu")?.open) loadNotifications();
    } catch {}
  });
  // Между загрузкой страницы и подключением к потоку журнал мог измениться:
  // запись пришла голосом, разбор закончился в фоне, правку сделали в другом
  // окне. Сервер здоровается сообщением «поток жив» — по нему и перечитываем,
  // иначе такая правка осталась бы невидимой до следующего события.
  journalStream.addEventListener("ready", reloadJournalSoon);
  journalStream.addEventListener('ready', () => window.KizunaTelemetry?.emit('stream_connected'));
  // Браузер переподключается сам; на всякий случай сбрасываем ссылку, чтобы
  // повторный вызов мог открыть поток заново.
  journalStream.addEventListener("error", () => {
    window.KizunaTelemetry?.emit('stream_disconnected');
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
// «Кто мы» грузится параллельно со страницей: карточка, открытая по ссылке,
// ждёт этого, чтобы отличить свои реплики от чужих.
let resolveAccountKnown = () => {};
const accountKnown = new Promise((resolve) => { resolveAccountKnown = resolve; });

async function openLocalDrafts(captureId = null) {
  const state = await request('/api/auth/state');
  if (!state.authenticated) return false;
  const userId = state.user.id;
  const drafts = (await listPendingDrafts(userId)).filter(draft => !captureId || draft.captureId === captureId);
  if (!drafts.length) return false;
  const dialog = node('dialog', undefined, 'legacy-draft-dialog');
  const content = node('div', undefined, 'legacy-draft-content');
  content.append(node('h2', t('Черновики на устройстве')));
  for (const draft of drafts) {
    // A fresh identity fence is required before reading each account-scoped cache.
    const identity = await request('/api/auth/state');
    if (!identity.authenticated || identity.user.id !== userId) return false;
    const text = await readPendingDraft(draft);
    const afterRead = await request('/api/auth/state');
    if (!afterRead.authenticated || afterRead.user.id !== userId) return false;
    const field = node('textarea', undefined, 'legacy-draft-field'); field.readOnly = true; field.value = text;
    field.setAttribute('aria-label', t('Черновик для копирования'));
    const copy = node('button', t('Скопировать черновик'), 'secondary'); copy.type = 'button';
    copy.addEventListener('click', async () => { const identity = await request('/api/auth/state'); if (!identity.authenticated || identity.user.id !== userId) { dialog.close(); return; } field.select(); try { await navigator.clipboard.writeText(text); } catch {} });
    content.append(field, copy);
  }
  const close = node('button', t('Закрыть'), 'secondary'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  content.append(close); dialog.append(content); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  return true;
}
$('#account-local-drafts')?.addEventListener('click', () => { $('.account-menu')?.removeAttribute('open'); openLocalDrafts().then(found => { if (!found) toast(t('Нет несохранённых черновиков.')); }).catch(error => toast(error.message)); });

const roleNames = { get admin() { return t("администратор"); }, get user() { return t("пользователь"); } };

async function loadAccount() {
  try {
    const state = await request("/api/auth/me");
    currentUser = state.user;
    resolveAccountKnown(currentUser);
  } catch {
    return;
  }
  paintAccountChip();
  $("#account-email").textContent = currentUser.email;
  $("#account-role").textContent = roleNames[currentUser.role] || currentUser.role;
  $("#account-admin-link").hidden = currentUser.role !== "admin";
  if (currentUser.role === 'admin') adminArea.refreshBadge().catch(() => {});
  paintAccountSummary();
  const draftOwner = currentUser.id;
  listPendingDrafts(draftOwner).then(drafts => { if (currentUser?.id === draftOwner) $('#account-local-drafts').hidden = !drafts.length; }).catch(() => {});
  const nameInput = $("#setting-name");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = currentUser.name || "";
  paintAvatarPicker();
  paintTotp();
}
function paintAccountSummary() {
  if (!currentUser) return;
  const line = $("#account-summary-line");
  if (line)
    bindTranslation(line, "{email} · {value2} · вход защищён {value3}", { email: currentUser.email, value2: roleNames[currentUser.role], value3: currentUser.twoFactorEnabled ? t("паролем и вторым фактором") : t("только паролем") });
}
// Значок в шапке — то же лицо, что видят люди в круге: картинка, если она
// выбрана, иначе две буквы адреса.
function paintAccountChip() {
  const chip = $("#account-summary");
  if (!chip || !currentUser) return;
  chip.textContent = currentUser.email.split("@")[0].slice(0, 2).toUpperCase();
  chip.title = currentUser.email;
  pictureInto(chip, currentUser.avatar);
}
// ── аватар ──
// Персонаж из набора или своя картинка; «Буква» возвращает кружок с началом
// имени. Картинку ужимает браузер — на сервер уходит квадрат 256 px, а не
// двенадцать мегапикселей с телефона.
const AVATAR_PRESET_LABELS = localizedBuiltins({
  "cat": "Кот",
  "fox": "Кицунэ",
  "tanuki": "Тануки",
  "panda": "Панда",
  "penguin": "Пингвин",
  "frog": "Лягушка",
  "owl": "Сова",
  "bunny": "Зайка",
  "shiba": "Сиба",
  "octopus": "Осьминожка",
  "onigiri": "Онигири",
  "ghost": "Привидение",
  "bear": "Мишка",
  "robot": "Робот",
  "dino": "Динозаврик",
  "whale": "Кит"
});
const AVATAR_SIDE = 256;
let avatarPresets = null;
async function paintAvatarPicker() {
  const grid = $("#avatar-presets");
  if (!grid || !currentUser) return;
  if (!avatarPresets) {
    try { avatarPresets = (await request("/api/account/avatars")).presets; }
    catch { return; }
  }
  const current = $("#avatar-current");
  clear(current);
  current.append(avatarEl(currentUser, { size: "huge" }));
  clear(grid);
  const choice = (label, content, chosen, onPick) => {
    const button = node("button", undefined, "avatar-choice");
    button.type = "button";
    button.title = label;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", String(chosen));
    button.append(content);
    button.addEventListener("click", onPick);
    grid.append(button);
  };
  choice(t("Буква имени"), avatarEl({ ...currentUser, avatar: null }), !currentUser.avatar, () => chooseAvatar(null));
  for (const preset of avatarPresets)
    choice(AVATAR_PRESET_LABELS[preset.id] || preset.label, avatarEl({ name: AVATAR_PRESET_LABELS[preset.id] || preset.label, avatar: preset.url }), currentUser.avatar === preset.url, () => chooseAvatar(preset.id));
}
async function avatarSaved(result, message) {
  currentUser = { ...currentUser, ...result.me };
  paintAccountChip();
  paintAvatarPicker();
  toast(message);
  // Лицо видно в кругах, в обсуждении и в полосе «к вам» — они перечитываются.
  await load();
}
async function chooseAvatar(presetId) {
  try {
    const result = await request("/api/account/avatar", { method: "PUT", body: JSON.stringify({ preset: presetId }) });
    await avatarSaved(result, presetId ? t("Аватар выбран") : t("Снова буква имени"));
  } catch (error) { toast(error.message || t("Аватар не сохранился")); }
}
// Квадрат по центру картинки: лицо на фото обычно в середине, а кружок всё
// равно срежет углы. Картинка читается обычным <img>: createImageBitmap
// строже и отказывается от файлов, которые браузер спокойно показывает.
async function squareAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIDE;
    const draw = (background) => {
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
      if (background) { context.fillStyle = background; context.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE); }
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    };
    const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    draw(null);
    const webp = await encode("image/webp");
    if (webp?.type === "image/webp") return webp;
    // Safari не умеет сохранять WebP и молча отдаёт PNG на сотни килобайт —
    // тогда JPEG, а прозрачное становится белым.
    draw("#ffffff");
    return await encode("image/jpeg");
  } finally {
    URL.revokeObjectURL(url);
  }
}
$("#avatar-upload")?.addEventListener("click", () => $("#avatar-file").click());
$("#avatar-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const image = await squareAvatar(file);
    const response = await fetch("/api/account/avatar/image", { method: "POST", headers: { "Content-Type": image.type }, body: image });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || t("Картинка не загрузилась"));
    await avatarSaved(result, t("Картинка поставлена"));
  } catch (error) {
    toast(error instanceof DOMException ? t("Это не похоже на картинку") : error.message || t("Картинка не загрузилась"));
  }
});
// Имя сохраняется само, когда поле отпустили: отдельной кнопки «Сохранить» в
// настройках нет ни у чего.
$("#setting-name")?.addEventListener("change", async (event) => {
  try {
    const result = await request("/api/account", { method: "PATCH", body: JSON.stringify({ name: event.target.value }) });
    if (currentUser) currentUser.name = result.me.name;
    toast(t("Вас будут звать «{name}»", { name: result.me.name }));
    await load();
  } catch (error) { toast(error.message || t("Имя не сохранилось")); }
});

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

// Маленькое окно установки в существующем меню учётной записи.
const macDownloadDialog = $("#mac-download-dialog");
$("#account-mac-download")?.addEventListener("click", () => {
  $(".account-menu")?.removeAttribute("open");
  if (!macDownloadDialog.open) macDownloadDialog.showModal();
});
$("#mac-download-close")?.addEventListener("click", () => macDownloadDialog.close());
macDownloadDialog?.addEventListener("close", () => $("#account-summary")?.focus());
macDownloadDialog?.addEventListener("click", (event) => {
  if (event.target !== macDownloadDialog) return;
  const bounds = macDownloadDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) macDownloadDialog.close();
});

// ── тема ─────────────────────────────────────────────────────────────────────
// Кнопка в шапке для быстрого переключения, поле в настройках — чтобы выбор
// пережил смену браузера.
function paintThemeButton() {
  const button = $("#theme-toggle");
  if (!button) return;
  button.innerHTML = window.pagentTheme.icon();
  bindTranslation(button, "Тема: {value1}", { value1: t(window.pagentTheme.label()) }, "title");
  bindTranslation(button, "Тема оформления: {value1}", { value1: t(window.pagentTheme.label()) }, "aria-label");
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
  const source = on
    ? "Включён. При входе после пароля спрашивается код из приложения."
    : "Выключен. Вход защищён только паролем.";
  state.dataset.i18n = source;
  state.textContent = t(source);
  $("#password-factor-field").hidden = !on;
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
    toast(t("Второй фактор включён"));
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
      body: JSON.stringify({ password: $("#totp-disable-password").value, code: $("#totp-disable-code").value.trim() }),
    });
    $("#totp-disable-password").value = "";
    $("#totp-disable-code").value = "";
    $("#totp-disable-dialog").close();
    $("#totp-codes").hidden = true;
    await loadAccount();
    toast(t("Второй фактор выключен"));
  } catch (error) {
    toast(error.message);
  }
});
$("#totp-recovery")?.addEventListener("click", async () => {
  const password = prompt(t("Пароль, чтобы выпустить новые резервные коды:"));
  if (!password) return;
  const code = prompt(t("Код из приложения или резервный код"));
  if (!code) return;
  try {
    const result = await request("/api/auth/totp/recovery-codes", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    });
    showRecoveryCodes(result.recoveryCodes);
    toast(t("Прежние резервные коды больше не работают"));
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
  if (next !== $("#password-repeat").value) return toast(t("Пароли не совпадают"));
  try {
    await request("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: current, newPassword: next, code: $("#password-factor").value.trim() }),
    });
    for (const id of ["#password-current", "#password-new", "#password-repeat", "#password-factor"])
      $(id).value = "";
    $("#password-dialog").close();
    toast(t("Пароль сменён, остальные входы закрыты"));
  } catch (error) {
    toast(error.message);
  }
});

// ── администрирование ────────────────────────────────────────────────────────
const statusNames = {
  get pending() { return t("доступ закрыт"); },
  get active() { return t("работает"); },
  get blocked() { return t("заблокирован"); },
  get rejected() { return t("отклонён"); },
};
async function adminAction(userId, action, body) {
  try {
    await request(`/api/admin/users/${userId}/${action}`, {
      method: "POST",
      body: JSON.stringify(body || {}),
    });
    if (userId === currentUser?.id && action === 'role') await loadAccount();
    await adminArea.show();
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
// Человек живёт в приложении или уже нет: две недели тишины — тот же порог,
// по которому «Обзор» считает проект заглохшим.
const SLEEPING_AFTER_DAYS = 14;
const DAYS_WORDS = localizedBuiltins(["день", "дня", "дней"]);
function daysBetween(iso) { return iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null; }
function agoWords(iso) {
  const days = daysBetween(iso);
  if (days === null) return null;
  if (days <= 0) return t("сегодня");
  if (days === 1) return t("вчера");
  return t("{value1} назад", { value1: plural(days, DAYS_WORDS) });
}
// Полоса дней: сколько записей в каждый из последних тридцати. Высота — от
// самого плотного дня этого человека: полоса про его ритм, а не про то, кто
// пишет больше всех. Сегодняшний столбик коралловый, как «сегодня» в дне.
function activityBand(activity, dates) {
  const band = node("div", undefined, "admin-band");
  band.setAttribute("aria-hidden", "true");
  const top = Math.max(1, ...activity.days);
  activity.days.forEach((count, index) => {
    const bar = node("i", undefined, `admin-band-day${count ? " on" : ""}${index === activity.days.length - 1 ? " today" : ""}`);
    // Пустой день — приступок у основания, а не волосок: иначе полоса читается
    // пунктирной линейкой, а не провалом в работе.
    if (count) bar.style.height = `${30 + Math.round((count / top) * 70)}%`;
    else bar.style.height = "4px";
    bar.title = `${dates?.[index] || ""}: ${plural(count, [t("запись"), t("записи"), t("записей")])}`;
    band.append(bar);
  });
  return band;
}
// Строка активности: то, ради чего список и открывают — живёт человек тут или
// уже нет. Числа за тридцать дней, рядом полоса по дням.
function activityLine(activity, dates) {
  const wrap = node("div", undefined, "admin-activity");
  wrap.append(activityBand(activity, dates));
  const facts = [];
  const last = agoWords(activity.lastCaptureAt);
  facts.push(last ? t("последняя запись {last}", { last: last }) : t("записей нет"));
  facts.push(t("за 30 дней {value1}", { value1: plural(activity.capturesPeriod, [t("запись"), t("записи"), t("записей")]) }));
  facts.push(t("за неделю {capturesWeek}", { capturesWeek: activity.capturesWeek }));
  if (activity.completedPeriod) facts.push(t("закрыто {value1}", { value1: plural(activity.completedPeriod, DEALS) }));
  facts.push(activity.calendars ? t("календарь {calendars}", { calendars: activity.calendars }) : t("без календаря"));
  facts.push(activity.pushDevices ? t("уведомления {pushDevices}", { pushDevices: activity.pushDevices }) : t("без уведомлений"));
  wrap.append(node("p", facts.join(" · "), "admin-user-facts admin-user-activity"));
  return wrap;
}
// Метка состояния рядом со статусом: кто ни разу ничего не записал и кто
// замолчал. Живого человека метить нечем — молчание и есть новость.
function activityTag(user) {
  const activity = user.activity;
  if (!activity || user.status !== "active") return null;
  const silence = [activity.lastCaptureAt, user.lastLoginAt].map(daysBetween).filter((days) => days !== null);
  if (!activity.lastCaptureAt) return bindTranslation(node("span", t("ни одной записи"), "admin-tag admin-state-new"), "ни одной записи");
  const quiet = silence.length ? Math.min(...silence) : null;
  if (quiet !== null && quiet >= SLEEPING_AFTER_DAYS) return bindTranslation(node("span", t("молчит {value1}", { value1: plural(quiet, DAYS_WORDS) }), "admin-tag admin-state-asleep"), "молчит {value1}", { value1: plural(quiet, DAYS_WORDS) });
  return null;
}
function userRow(user, { lastAdmin = false, days = null } = {}) {
  const row = node("div", null, "admin-user");
  row.dataset.userId = user.id;
  const head = node("div", null, "admin-user-head");
  head.append(
    node("span", user.email, "admin-user-email"),
    node("span", roleNames[user.role] || user.role, `admin-tag admin-role-${user.role}`),
    node("span", statusNames[user.status] || user.status, `admin-tag admin-status-${user.status}`),
  );
  if (user.twoFactorEnabled) head.append(node("span", "2FA", "admin-tag admin-tag-quiet"));
  const state = activityTag(user);
  if (state) head.append(state);
  row.append(head);

  // Потолок ставят, глядя на расход, поэтому они стоят рядом: «потрачено из
  // сколько можно», а не два числа в разных углах страницы.
  const spent = user.monthSpentUsd || 0;
  const cap = user.monthlyLimitUsd;
  const capped = cap !== null && cap !== undefined;
  const facts = [
    t("записей {value1}", { value1: user.captureCount ?? 0 }),
    t("в этом месяце ${value1}{value2}", { value1: spent.toFixed(2), value2: capped ? t(" из ${value1}", { value1: cap }) : t(" (потолок общий)") }),
  ];
  if (user.blockedReason) facts.push(t("причина: {blockedReason}", { blockedReason: user.blockedReason }));
  if (user.lastLoginAt) facts.push(t("входил {value1}", { value1: new Date(user.lastLoginAt).toLocaleString(getLocale(), { timeZone: getTimeZone() }) }));
  const factsLine = node("p", facts.join(" · "), "admin-user-facts");
  if (capped && spent >= cap) factsLine.classList.add("quota-exhausted");
  row.append(factsLine);
  if (user.activity) row.append(activityLine(user.activity, days));

  const actions = node("div", null, "admin-user-actions");
  // Последнего администратора не закрыть и не разжаловать: иначе приложение
  // осталось бы без хозяина. Сервер это тоже проверяет — здесь просто не
  // предлагаем того, что всё равно не выйдет.
  if (user.status === "active" && !lastAdmin)
    actions.append(
      adminButton(t("Заблокировать"), "danger", () => {
        const reason = prompt(t("Причина блокировки {email} (необязательно):", { email: user.email }));
        if (reason === null) return;
        adminAction(user.id, "block", { reason });
      }),
    );
  if (user.status === "blocked")
    actions.append(adminButton(t("Разблокировать"), "secondary", () => adminAction(user.id, "unblock")));
  if (user.status === "active" && !lastAdmin)
    actions.append(
      adminButton(
        user.role === "admin" ? t("Снять администратора") : t("Сделать администратором"),
        "secondary",
        () => adminAction(user.id, "role", { role: user.role === "admin" ? "user" : "admin" }),
      ),
    );
  if (user.twoFactorEnabled)
    actions.append(adminButton(t("Сбросить 2FA"), "secondary", () => adminAction(user.id, "reset-2fa")));
  if (user.status !== 'pending') {
    actions.append(adminButton(t('Сбросить сессии'), 'secondary', () => {
      if (confirm(t('Закрыть все сессии этого пользователя?'))) adminAction(user.id, 'sessions-reset');
    }));
    actions.append(adminButton(t('Снять блокировку входа'), 'secondary', () => adminAction(user.id, 'unlock')));
    if (!user.captureCount && user.id !== currentUser?.id && !lastAdmin) actions.append(adminButton(t('Удалить учётную запись'), 'danger', async () => {
      if (!confirm(t('Удалить пустую учётную запись?'))) return;
      try { await request(`/api/admin/users/${user.id}`, { method: 'DELETE' }); await adminArea.show(); }
      catch (error) { toast(error.message); }
    }));
  }
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
  const monthly = field(t("Потолок, $/мес"), t("общий"), user.monthlyLimitUsd, "monthlyLimitUsd", "1");
  limits.append(
    adminButton(t("Сохранить пределы"), "secondary", () =>
      adminAction(user.id, "limits", {
        monthlyLimitUsd: monthly.value.trim(),
      }),
    ),
  );
  if (user.status === 'pending') row.append(limits);
  else {
    const details = node('details', undefined, 'admin-user-management');
    details.append(node('summary', t('Управление учётной записью')), actions, limits);
    row.append(details);
  }
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
  const admins = payload.users.filter((user) => user.role === "admin" && user.status === "active");
  const soleAdmin = admins.length === 1 ? admins[0].id : null;
  const days = payload.activityDays || null;
  clear(box);
  for (const user of payload.users)
    box.append(userRow(user, { lastAdmin: user.id === soleAdmin, days }));

  const events = $("#admin-events");
  clear(events);
  try {
    const log = await request("/api/admin/auth-events?limit=250");
    if (!log.events.length) events.append(bindTranslation(node("p", t("Пока пусто."), "empty"), "Пока пусто."));
    for (const event of log.events) {
      const line = node("div", null, "admin-event");
      line.append(
        node("span", new Date(event.createdAt).toLocaleString(getLocale(), { timeZone: getTimeZone() }), "admin-event-when"),
        node("span", event.email || "—", "admin-event-who"),
        node("span", `${event.event} · ${event.result}${event.detail ? ` · ${event.detail}` : ''}`, "admin-event-what"),
      );
      events.append(line);
    }
  } catch {
    events.append(bindTranslation(node("p", t("Журнал входов не открылся."), "empty"), "Журнал входов не открылся."));
  }
}

loadAccount();

// ── страница «Обзор»: отчёты по записям ─────────────────────────────────────
// Правила из концепта reports-concept.html: списки важнее графиков, каждая
// строка открывает карточку записи, всё названо словом. Данные считает сервер
// одним запросом; здесь только отрисовка.
const REPORT_TYPES = ["task", "meeting_event", "note", "outcome_decision", "idea_question"];
const reportLegendNames = { get task() { return t("Задачи"); }, get meeting_event() { return t("Встречи"); }, get note() { return t("Заметки"); }, get outcome_decision() { return t("Решения"); }, get idea_question() { return t("Вопросы"); } };
const correctionFieldNames = { get schedule() { return t("срок"); }, get primaryType() { return t("тип"); }, get project() { return t("проект"); }, get projects() { return t("проекты"); }, get people() { return t("люди"); }, get followUp() { return t("следующий шаг"); }, get tags() { return t("теги"); }, get priority() { return t("важность"); }, get summary() { return t("формулировка"); } };
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
  return new Intl.DateTimeFormat(getLocale(), { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));
}
function reportTimeLabel(at, timeZone) {
  return new Intl.DateTimeFormat(getLocale(), { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
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
async function openReportEntry(captureId, { occurrence = null, subtasks = false } = {}) {
  cardOccurrence = occurrence;
  try {
    const { entries } = await request("/api/entries?limit=100");
    const entry = entries.find((candidate) => candidate.id === captureId);
    if (!entry) { toast(t("Запись не нашлась среди последних ста.")); return; }
    const review = reviewFromEntry(entry);
    cardScrollTarget = subtasks ? captureId : null;
    showCorrection(entry, review.level === "high" ? undefined : review);
  } catch (error) {
    toast(error.message);
  }
}
function reportItem({ captureId, title, type = null, meta = null, metaCls = "" }) {
  const item = node("li", undefined, undefined);
  bindTranslation(item, "Откроется карточка записи", "title");
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
  const card = reportCard(t("Пульс"), { right: captionText });
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
  const periodNames = { get week() { return t("за неделю"); }, get month() { return t("за месяц"); }, get all() { return t("за всё время"); } };
  const prevNames = { get week() { return t("прошлая неделя"); }, get month() { return t("прошлый месяц"); } };
  counters.append(
    reportCounter({ num: c.done, cls: c.done ? "good" : "", cap: pluralRu(c.done, t("задача сделана"), t("задачи сделано"), t("задач сделано")), sub: periodNames[data.period] }),
    reportCounter({ num: c.captures, cap: pluralRu(c.captures, t("новая запись"), t("новые записи"), t("новых записей")), sub: c.capturesPrev === null ? t("с самого начала") : `${prevNames[data.period]} — ${c.capturesPrev}` }),
    reportCounter({ num: c.overdue, cls: c.overdue ? "bad" : "", get cap() { return t("просрочено"); }, sub: c.overdue ? t("старейшей — {overdueOldestDays} {value2}", { overdueOldestDays: c.overdueOldestDays, value2: pluralRu(c.overdueOldestDays, t("день"), t("дня"), t("дней")) }) : t("хвостов нет") }),
    reportCounter({ num: c.questions, cap: pluralRu(c.questions, t("вопрос без ответа"), t("вопроса без ответа"), t("вопросов без ответа")), sub: c.questions ? t("старейшему — {questionsOldestDays} {value2}", { questionsOldestDays: c.questionsOldestDays, value2: pluralRu(c.questionsOldestDays, t("день"), t("дня"), t("дней")) }) : t("всё отвечено") }),
  );
  area.append(counters);

  const pulseCaption = data.pulse.unit === "week"
    ? t("записи по неделям")
    : t("записи по дням, {value1} — {value2}", { value1: reportDateLabel(data.from), value2: reportDateLabel(shiftDate(data.to, -1)) });
  area.append(reportPulseCard(data.pulse, pulseCaption));

  const tails = node("div", undefined, "report-grid-3");
  const overdueCard = reportCard(t("Просрочено"), { right: String(data.overdue.length || ""), get hint() { return t("Задачи со сроком в прошлом"); } });
  overdueCard.append(reportItemList(data.overdue.map((row) => ({
    captureId: row.captureId, title: row.title, type: "task",
    meta: row.daysLate === 1 ? t("вчера") : `${row.daysLate} ${pluralRu(row.daysLate, t("день"), t("дня"), t("дней"))}`, metaCls: "bad",
  })), t("Хвостов нет.")));
  const questionsCard = reportCard(t("Без ответа"), { right: String(data.questions.length || ""), get hint() { return t("Открытые вопросы и идеи"); } });
  questionsCard.append(reportItemList(data.questions.map((row) => ({
    captureId: row.captureId, title: row.title, type: "idea_question",
    meta: reportDateLabel(row.createdAt.slice(0, 10)),
  })), t("Открытых вопросов нет.")));
  const silentCard = reportCard(t("Встречи без следа"), { right: String(data.silentMeetings.length || ""), get hint() { return t("Прошли, но итог не записан"); } });
  silentCard.append(reportItemList(data.silentMeetings.map((row) => ({
    captureId: row.captureId, title: row.title, type: "meeting_event",
    meta: reportDateLabel(row.date),
  })), t("У всех встреч есть след.")));
  tails.append(overdueCard, questionsCard, silentCard);
  area.append(tails);

  const slices = node("div", undefined, "report-grid-2");
  const projectsCard = reportCard(t("Проекты"), { get right() { return t("по числу записей"); } });
  if (data.projects.length) {
    const bars = node("div", undefined, "report-bars");
    const max = Math.max(...data.projects.map((row) => row.count), 1);
    for (const row of data.projects) bars.append(reportBar({ name: row.name, share: row.count / max, value: String(row.count) }));
    projectsCard.append(bars);
  } else {
    projectsCard.append(bindTranslation(node("p", t("В записях периода проектов нет."), "report-empty"), "В записях периода проектов нет."));
  }
  if (data.stalled.length) {
    const stale = node("div", undefined, "report-stale");
    stale.append(bindTranslation(node("p", t("Заглохло"), "lbl"), "Заглохло"));
    for (const row of data.stalled)
      stale.append(bindTranslation(node("div", t("{name} — {daysQuiet} {value3} без записей", { name: row.name, daysQuiet: row.daysQuiet, value3: pluralRu(row.daysQuiet, t("день"), t("дня"), t("дней")) }), "row"), "{name} — {daysQuiet} {value3} без записей", { name: row.name, daysQuiet: row.daysQuiet, value3: pluralRu(row.daysQuiet, t("день"), t("дня"), t("дней")) }));
    projectsCard.append(stale);
  }
  const peopleCard = reportCard(t("Люди и теги"));
  const chips = (rows, formatName) => {
    const wrap = node("div", undefined, "report-chips");
    for (const row of rows) {
      const chip = node("span", undefined, "report-chip");
      chip.append(node("b", formatName(row.name)), node("span", String(row.count), "n"));
      wrap.append(chip);
    }
    return wrap;
  };
  peopleCard.append(data.people.length ? chips(data.people, (name) => name) : bindTranslation(node("p", t("Людей в записях периода нет."), "report-empty"), "Людей в записях периода нет."));
  peopleCard.append(bindTranslation(node("p", t("Теги"), "report-chip-lbl"), "Теги"));
  peopleCard.append(data.tags.length ? chips(data.tags, (name) => `#${name}`) : bindTranslation(node("p", t("Тегов пока нет."), "report-empty"), "Тегов пока нет."));
  slices.append(projectsCard, peopleCard);
  area.append(slices);

  const discipline = reportCard(t("Дисциплина"), { get right() { return t("по закрытым записям периода"); } });
  if (!data.discipline.closed) {
    discipline.append(bindTranslation(node("p", t("В этом периоде ничего не закрыто."), "report-empty"), "В этом периоде ничего не закрыто."));
  } else {
    const facts = node("div", undefined, "report-facts");
    if (data.discipline.medianDays !== null) {
      const fact = node("div", undefined, "report-fact");
      fact.append(node("b", `${String(data.discipline.medianDays).replace(".", ",")} ${pluralRu(Math.round(data.discipline.medianDays) || 1, t("день"), t("дня"), t("дней"))}`));
      fact.append(document.createTextNode(t("живёт дело — от записи до «готово» (медиана)")));
      facts.append(fact);
    }
    if (data.discipline.withDue) {
      const fact = node("div", undefined, "report-fact");
      fact.append(bindTranslation(node("b", t("{onTime} из {withDue}", { onTime: data.discipline.onTime, withDue: data.discipline.withDue })), "{onTime} из {withDue}", { onTime: data.discipline.onTime, withDue: data.discipline.withDue }));
      fact.append(document.createTextNode(t("дел со сроком закрыты вовремя")));
      facts.append(fact);
    }
    if (!facts.childNodes.length) facts.append(bindTranslation(node("p", t("Закрытых дел со сроком в периоде нет."), "report-empty"), "Закрытых дел со сроком в периоде нет."));
    discipline.append(facts);
  }
  area.append(discipline);
}
function renderReportsService(area, data) {
  clear(area);
  const service = data.service;
  const counters = node("div", undefined, "report-counters");
  counters.append(
    reportCounter({ num: money(service.usage.costUsd), get cap() { return t("потрачено на разбор"); }, sub: service.usage.unpriced ? t("{unpriced} {value2} без цены", { unpriced: service.usage.unpriced, value2: pluralRu(service.usage.unpriced, t("вызов"), t("вызова"), t("вызовов")) }) : t("по данным провайдеров") }),
    reportCounter({ num: service.usage.calls, cap: pluralRu(service.usage.calls, t("вызов модели"), t("вызова модели"), t("вызовов модели")), sub: service.quality.failed ? t("{failed} неудачных", { failed: service.quality.failed }) : t("все удались") }),
    reportCounter({ num: service.quality.corrections, cap: pluralRu(service.quality.corrections, t("правка после модели"), t("правки после модели"), t("правок после модели")), sub: service.quality.topField ? t("чаще всего — {value1}", { value1: correctionFieldNames[service.quality.topField.field] || service.quality.topField.field }) : t("правок не было") }),
  );
  area.append(counters);

  const grid = node("div", undefined, "report-grid-2");
  const usageCard = reportCard(t("Расходы на модели"), { get right() { return t("за период"); } });
  if (service.usage.rows.length) {
    const bars = node("div", undefined, "report-bars");
    const max = Math.max(...service.usage.rows.map((row) => row.costUsd), 0.0001);
    for (const row of service.usage.rows)
      bars.append(reportBar({ name: providerNames[row.provider] || row.provider, caption: row.model || null, share: row.costUsd / max, value: money(row.costUsd), cost: true }));
    usageCard.append(bars);
  } else {
    usageCard.append(bindTranslation(node("p", t("В этом периоде модели не вызывались."), "report-empty"), "В этом периоде модели не вызывались."));
  }
  const qualityCard = reportCard(t("Качество разбора"));
  const rows = [
    [t("Правок после модели"), service.quality.corrections],
    [t("Переразборов моделью"), service.quality.reclassified],
    [t("Ждут разбора сейчас"), service.quality.pendingNow],
    [t("Неудачных разборов"), service.quality.failed],
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
    const accuracy = reportCard(t("Точность по провайдерам"), { get right() { return t("правки на разбор — меньше лучше"); } });
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
    data.date === data.latest ? t("сегодня — {label}", { label: label }) : data.date === shiftDate(data.latest, -1) ? t("вчера — {label}", { label: label }) : label;
  $("#reports-day-prev").disabled = !data.hasOlder;
  $("#reports-day-next").disabled = data.date >= data.latest;
  const counters = node("div", undefined, "report-counters");
  const times = data.feed.map((row) => reportTimeLabel(row.at, data.timeZone));
  counters.append(
    reportCounter({ num: data.done.length, cls: data.done.length ? "good" : "", cap: pluralRu(data.done.length, t("дело сделано"), t("дела сделано"), t("дел сделано")), sub: data.done.length ? null : t("в этот день — ничего") }),
    reportCounter({ num: data.feed.length, cap: pluralRu(data.feed.length, t("новая запись"), t("новые записи"), t("новых записей")), sub: times.length > 1 ? t("с {value1} до {value2}", { value1: times[0], value2: times.at(-1) }) : null }),
    reportCounter({ num: data.meetings, cap: pluralRu(data.meetings, t("встреча"), t("встречи"), t("встреч")), sub: null }),
    reportCounter({ num: data.missed.length, cls: data.missed.length ? "bad" : "", get cap() { return t("не успел"); }, sub: data.missed.length ? t("срок был в этот день") : t("хвостов не осталось") }),
  );
  area.append(counters);

  const grid = node("div", undefined, "report-grid-2");
  const doneCard = reportCard(t("Сделано"), { right: String(data.done.length || ""), get hint() { return t("Зафиксированная работа за этот день — как во вкладке «Закрыто»"); } });
  doneCard.append(reportItemList(data.done.map((row) => ({
    captureId: row.captureId, title: row.title, type: row.type,
    meta: reportTimeLabel(row.at, data.timeZone), metaCls: "ok",
  })), t("За этот день работа не зафиксирована.")));
  const missedCard = reportCard(t("Не успел"), { right: String(data.missed.length || ""), get hint() { return t("Срок был в этот день, к вечеру не закрыто"); } });
  missedCard.append(reportItemList(data.missed.map((row) => ({
    captureId: row.captureId, title: row.title, type: "task",
    meta: row.closedLater ? t("закрыто позже") : t("теперь в «Просрочено»"), metaCls: row.closedLater ? "" : "bad",
  })), t("Всё со сроком на этот день — закрыто.")));
  grid.append(doneCard, missedCard);
  area.append(grid);

  const feedCard = reportCard(t("Записано за день"), { right: String(data.feed.length || ""), get hint() { return t("Все записи дня по времени"); } });
  feedCard.append(reportItemList(data.feed.map((row) => ({
    captureId: row.captureId, title: row.title, type: row.type,
    meta: reportTimeLabel(row.at, data.timeZone),
  })), t("Записей в этот день нет.")));
  area.append(feedCard);
}
function reportsView(tab) {
  return { life: $("#reports-life"), day: $("#reports-day") }[tab];
}
async function loadReports() {
  const tab = reportsState.tab;
  for (const name of ["life", "day"]) reportsView(name).hidden = name !== tab;
  $("#reports-period").hidden = tab === "day";
  $("#reports-daynav").hidden = tab !== "day";
  const area = reportsView(tab);
  if (!area.childNodes.length) area.append(bindTranslation(node("p", t("Считаем…"), "empty"), "Считаем…"));
  try {
    if (tab === "day") {
      const query = reportsState.dayDate ? `?date=${reportsState.dayDate}` : "";
      renderReportsDay(area, await request(`/api/reports/day${query}`));
    } else {
      const data = await request(`/api/reports?period=${reportsState.period}`);
      renderReportsLife(area, data);
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
  const stamp = new Intl.DateTimeFormat(getLocale(), { timeZone: getTimeZone(), hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()).replaceAll(":", "-");
  const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return t("снимок-{stamp}.{extension}", { stamp: stamp, extension: extension });
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
    bindTranslation(open, "Открыть снимок", "title");
    bindTranslation(open, "Открыть {name}", { name: shot.file.name }, "aria-label");
    open.addEventListener("click", () =>
      previewAttachment(
        { id: null, filename: shot.file.name, contentType: shot.file.type, size: shot.file.size },
        shot.url,
      ),
    );
    open.append(image);
    remove.type = "button";
    bindTranslation(remove, "Убрать снимок", "title");
    bindTranslation(remove, "Убрать {name}", { name: shot.file.name }, "aria-label");
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
    if (pendingShots.length >= SHOT_LIMIT) { toast(t("До {SHOT_LIMIT} снимков на запись.", { SHOT_LIMIT: SHOT_LIMIT })); break; }
    if (file.size > SHOT_SIZE_LIMIT) { toast(t("Снимок больше 10 МБ не приложится.")); continue; }
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
      if (!response.ok) throw new Error(payload?.error?.message || t("Снимок не приложился."));
    } catch (error) {
      toast(error.message);
    } finally {
      URL.revokeObjectURL(shot.url);
    }
  }
}

// ── доска: вид, группировка, порядок колонок и фильтр ───────────────────────
// Как в Notion: вид — то, как рисовать (доска или список), группировка —
// по каким полям раскладывать. Полей можно взять сколько угодно: первое даёт
// колонки или разделы, каждое следующее — вложенные подгруппы. Готовых видов
// нет: всё выбирается руками и помнится в браузере; у каждого поля свой цвет
// (--f-* в app.css). «Закрыто» — последний раздел списка при любой
// группировке, а на доске — обычная колонка: первая по умолчанию, и её, как
// любую другую, можно перетащить. Колонки заводит человек, карточка — открытое
// дело: кружок, название и мелкая строка. Название открывает карточку записи,
// кружок закрывает дело, перенос между колонками сохраняется на сервере, а
// при группировке по дню бросок в другой день меняет срок.
//
// Заголовок любой колонки доски тянется: порядок помнится в браузере по полю
// первого уровня (kizuna-board-order), а у колонок человека ещё и на сервере.
// Над доской — наборный фильтр по полям дела (kizuna-board-filter): в первый
// заход он «сегодня», дальше — что человек выбрал, в том числе пустой.
// Колонки-группы (день, человек, проект, откуда) заводит сам человек: на доске
// стоят непустые группы и те, что он добавил через «+ Колонка» (kizuna-board-shown).
// Логика фильтра, порядка и заведённых колонок — в public/board-model.js, здесь —
// хранение и рисунок.
const BOARD_FIELDS = Object.fromEntries(Object.keys(FILTER_FIELDS).filter(key => key !== "status").map(key => [key, null]));
for (const key of Object.keys(BOARD_FIELDS)) Object.defineProperty(BOARD_FIELDS, key, { enumerable: true, get: () => FILTER_FIELDS[key] });
const BOARD_VIEWS = ["board", "list"];
const BOARD_VIEW_KEY = "kizuna-board-view";
const BOARD_GROUPS_KEY = "kizuna-board-groups";
const BOARD_FILTER_KEY = "kizuna-board-filter";
const BOARD_ORDER_KEY = "kizuna-board-order";
const BOARD_SHOWN_KEY = "kizuna-board-shown";
// Подзадачи на доске и в списке: show (умолчание) — подзадачи стоят отдельными
// карточками, как дела, с подписью «↳ родитель»; hide — их нет, у родителя лишь
// полоска и число. Это не условие фильтра, поэтому «Сбросить» его не трогает.
const BOARD_SUBS_KEY = "kizuna-board-subtasks";
// Порядок групп фиксированный: у дня и источника — свой, у человека и
// проекта — по алфавиту, «без …» всегда последним.
const BOARD_DAYS = localizedBuiltins([["late", "просрочено"], ["today", "сегодня"], ["tomorrow", "завтра"], ["week", "на неделе"], ["later", "позже"], ["none", "без срока"]]);
const BOARD_SOURCES = localizedBuiltins([["telegram", "Telegram"], ["notes", "Заметки"], ["field", "Поле"]]);
// Срок, который получает дело, брошенное в группу-день: через сколько дней от
// сегодня. «Просрочено» срока не назначает, «без срока» его снимает.
const BOARD_DAY_DROP = { today: 0, tomorrow: 1, week: 2, later: 14 };
// Вида «Таблица» больше нет: выбранный когда-то в браузере читается как «Список».
function boardStoredView() {
  try { const view = uiStorage.getItem(BOARD_VIEW_KEY); return view === "table" ? "list" : BOARD_VIEWS.includes(view) ? view : "board"; } catch { return "board"; }
}
function boardStoredGroups() {
  try {
    const raw = uiStorage.getItem(BOARD_GROUPS_KEY);
    const list = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(list)) return ["col"];
    return [...new Set(list.filter((field) => Object.keys(BOARD_FIELDS).includes(field)))];
  } catch { return ["col"]; }
}
function boardStoredFilter() {
  try { return readFilter(uiStorage.getItem(BOARD_FILTER_KEY)); } catch { return defaultFilter(); }
}
function boardStoredOrder() {
  try { return readOrder(uiStorage.getItem(BOARD_ORDER_KEY)); } catch { return {}; }
}
function boardStoredShown() {
  try { return readShown(uiStorage.getItem(BOARD_SHOWN_KEY)); } catch { return {}; }
}
function boardStoredSubs() {
  try { return uiStorage.getItem(BOARD_SUBS_KEY) === "hide" ? "hide" : "show"; } catch { return "show"; }
}
const boardState = {
  // stamp — ответ сервера (строкой), по которому нарисована доска: тот же ответ не перерисовывается.
  data: null, stamp: null, drag: null, openAdder: null,
  search: "",
  view: boardStoredView(),
  groups: boardStoredGroups(),
  // Наборный фильтр: условия {field, op, values}. Строка под панелью открыта, пока фильтр что-то отбирает.
  filter: boardStoredFilter(),
  filterOpen: false,
  // Список значений, открытый у условия (ключ — поле и оператор, «day=»), и выбор значения для новой
  // колонки-группы: оба переживают перерисовку доски, пока человек не закрыл их сам.
  valsOpen: null,
  pickOpen: false,
  // Порядок колонок доски: { "<поле первого уровня>": ["__done", "<ключ группы>", …] }.
  order: boardStoredOrder(),
  // Колонки-группы, которые человек завёл сам: { "<поле первого уровня>": ["<ключ группы>", …] }.
  shown: boardStoredShown(),
  // На телефоне открывается первая своя колонка, а не «Закрыто»; null — ещё не выбирали.
  mobileColumn: null,
  // Подзадачи отдельными карточками: "show" или "hide"; от него зависит запрос доски (boardUrl).
  subs: boardStoredSubs(),
};
boardState.filterOpen = activeConditions(boardState.filter).length > 0;
// «Подзадачи: Показывать» просит у сервера доску с подзадачами карточками; перенос
// карточки сообщает то же, чтобы порядок колонки считался по списку на экране.
function boardUrl() {
  return boardState.subs === "show" ? "/api/board?subtasks=1" : "/api/board";
}
function boardMoveRequest(body) {
  return request("/api/board/move", { method: "POST", body: JSON.stringify({ ...body, ...(boardState.subs === "show" ? { subtasks: true } : {}) }) });
}
function boardRemember(key) {
  try {
    if (key === BOARD_VIEW_KEY) uiStorage.setItem(key, boardState.view);
    else uiStorage.setItem(BOARD_GROUPS_KEY, JSON.stringify(boardState.groups));
  } catch {}
}
// Черновик условия (значение ещё не выбрано) не сохраняется: он ничего не отбирает.
function boardRememberFilter() {
  try { uiStorage.setItem(BOARD_FILTER_KEY, JSON.stringify(activeConditions(boardState.filter))); } catch {}
}
function boardRememberOrder() {
  try { uiStorage.setItem(BOARD_ORDER_KEY, JSON.stringify(boardState.order)); } catch {}
}
function boardRememberSubs() {
  try { uiStorage.setItem(BOARD_SUBS_KEY, boardState.subs); } catch {}
}
function boardRememberShown() {
  try { uiStorage.setItem(BOARD_SHOWN_KEY, JSON.stringify(Object.fromEntries(Object.entries(boardState.shown).filter(([, keys]) => keys.length)))); } catch {}
}
const boardDropHint = (() => { const hint = document.createElement("div"); hint.className = "board-drop"; return hint; })();

// Круг на доске больше не группа: карточка круга, который человек выключил,
// просто не показывается.
const boardCircleOf = (card) => boardState.data?.circleMarks?.[card.captureId] || null;
// ── разговоры кругов: «За столом» ──
// Страница стоит по краям верхней строки и без своей рамки. Под шапкой —
// вкладки кругов, под вкладкой — люди круга за столом: у каждого ближайшее дело
// в этом круге и «@», чтобы позвать в разговор. Ниже — разговоры круга чипами:
// «Общий», разговоры на весь круг, комнаты подмножеством и обсуждения записей.
// Разговор идёт колонкой по центру сверху вниз, поле — сразу под ним: короткий
// разговор не прижат к низу пустого экрана. «Информация» — люди, ссылка и
// граница круга — выезжает справа поверх страницы.
//
// Счётчик непрочитанного по-прежнему живёт только на этой странице: в день
// попадает призыв, а не каждое сообщение.
const chatState = { rooms: [], messages: [], more: false, loading: false, drafts: {} };
// The native updater also needs drafts from conversations no longer in the DOM.
window.addEventListener("kizuna:before-update", (event) => {
  if (typeof event.detail?.block !== "function") return;
  if (Object.values(chatState.drafts).some((text) => text.trim())) {
    event.detail.block(t("В «Кругах» есть неотправленный текст. Отправьте или очистите его перед обновлением."));
  }
});
const kc = {
  circle: null, chat: null, info: null, person: null, table: true, menu: false, talks: false, ctx: null,
  reply: null, share: null, newFrom: null, talk: null, modal: null, invite: null,
  fresh: false, focusField: false, deedFocus: false,
  // Набранное в «Поручить дело» по кругу и человеку: страница перестраивается целиком.
  deedDrafts: {},
};
const KC_REACTIONS = ["👍", "❤️", "🔥", "🙏", "👀", "✅"];
// Тип записи — цвет и слово для строки обсуждения.
const KC_KIND = localizedBuiltins({ todo: ["violet", "дело"], meeting: ["orange", "встреча"], outcome: ["blue", "результат"], note: ["teal", "заметка"], idea: ["pink", "идея"] });
const KC_NAME_TONES = ["violet", "blue", "teal", "orange", "pink", "red"];
function kcStored(key, fallback) {
  try { const value = uiStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; }
}
function kcStore(key, value) {
  try { uiStorage.setItem(key, JSON.stringify(value)); } catch {}
}
kc.table = kcStored("pagent.circles-table", true) !== false;
kc.circle = kcStored("pagent.circles-circle", null);

const KC_ICON = {
  chats: '<path d="M2.2 4.6a2 2 0 0 1 2-2h7.6a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H7.4l-3 2.4v-2.4h-.2a2 2 0 0 1-2-2Z"/><path d="M5.2 6.2h5.6M5.2 8.4h3.4"/>',
  unread: '<path d="M9.8 2.6H4.6a2.2 2.2 0 0 0-2.2 2.2v4.4a2.2 2.2 0 0 0 2.2 2.2v2.4l3.2-2.4h3.8a2.2 2.2 0 0 0 2.2-2.2V6.8"/><circle cx="12.6" cy="3.4" r="1.9" fill="currentColor" stroke="none"/>',
  talk: '<path d="M3 3.2h10a1.6 1.6 0 0 1 1.6 1.6v5.4a1.6 1.6 0 0 1-1.6 1.6H8l-3.3 2.5v-2.5H3a1.6 1.6 0 0 1-1.6-1.6V4.8A1.6 1.6 0 0 1 3 3.2Z"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  plusCircle: '<circle cx="8" cy="8" r="6"/><path d="M8 5.2v5.6M5.2 8h5.6"/>',
  send: '<path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2"/>',
  people: '<circle cx="6" cy="5.6" r="2.3"/><path d="M1.9 13.2c.6-2.4 2.2-3.6 4.1-3.6s3.5 1.2 4.1 3.6"/><circle cx="11.4" cy="6.2" r="1.8"/><path d="M11 9.7c1.8.1 3 1.2 3.4 3.1"/>',
  bound: '<circle cx="8" cy="8" r="5.8" stroke-dasharray="2.4 2.1"/><circle cx="8" cy="8" r="1.6"/>',
  back: '<path d="M10 3 5 8l5 5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  dots: '<circle cx="3.4" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  reply: '<path d="M6.4 4 2.6 7.6l3.8 3.6"/><path d="M2.8 7.6h6.4a4.2 4.2 0 0 1 4.2 4.2v.8"/>',
  deed: '<path d="M4 3v5.3A1.7 1.7 0 0 0 5.7 10h6.8M10 7.5l2.5 2.5-2.5 2.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.3a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8.3"/>',
  pin: '<path d="M9.8 2.4 13.6 6.2l-1.7.7-2.2 2.2.2 2.5-1 1-5.5-5.5 1-1 2.5.2 2.2-2.2Z"/><path d="m5.9 10.1-3.2 3.2"/>',
  chevUp: '<path d="m3.5 10 4.5-4.5 4.5 4.5"/>',
  chevDown: '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
  chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.8.8"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.8-.8"/>',
  bell: '<path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.3l-1.3 2.6h9.8l-1.3-2.6V5.8A3.6 3.6 0 0 0 8 2.2Z"/><path d="M6.5 12.9a1.6 1.6 0 0 0 3 0"/>',
  personAdd: '<circle cx="6.4" cy="5.4" r="2.6"/><path d="M1.8 13.6c.6-2.6 2.4-4 4.6-4s4 1.4 4.6 4M12.6 4.6v4M10.6 6.6h4"/>',
  exit: '<path d="M6.4 2.6H4a1.4 1.4 0 0 0-1.4 1.4v8A1.4 1.4 0 0 0 4 13.4h2.4M10.4 11l3-3-3-3M13.2 8H6.2"/>',
  doc: '<path d="M4 1.8h5.2L12.6 5v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M9 1.8V5h3.6M5.4 8.2h5.2M5.4 10.8h3.4"/>',
  eye: '<path d="M1.5 8S3.9 3.6 8 3.6 14.5 8 14.5 8 12.1 12.4 8 12.4 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  lock: '<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.6"/><path d="M5.4 7V5.3a2.6 2.6 0 0 1 5.2 0V7"/>',
  check: '<path d="M3.5 8.4 6.5 11.3 12.5 5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  muted: '<path d="M2.5 6h2.2L8 3.3v9.4L4.7 10H2.5Z"/><path d="m11 6.2 3 3.6M14 6.2l-3 3.6"/>',
  todo: '<circle cx="8" cy="8" r="5.8"/><path d="m5.5 8.1 1.8 1.8 3.3-3.5"/>',
  meeting: '<rect x="2.4" y="3.4" width="11.2" height="10.2" rx="2"/><path d="M2.4 6.6h11.2M5.4 2v2.8M10.6 2v2.8"/>',
  outcome: '<path d="M3 8.5 6.2 11.6 13 4.6"/>',
  note: '<path d="M3.5 2.5h9v11h-9Z"/><path d="M5.8 5.5h4.4M5.8 8h4.4M5.8 10.5h2.4"/>',
  idea: '<path d="M8 2.2a4 4 0 0 0-2.3 7.3c.4.3.6.7.6 1.2v.8h3.4v-.8c0-.5.2-.9.6-1.2A4 4 0 0 0 8 2.2Z"/><path d="M6.4 13.8h3.2"/>',
  camera: '<path d="M2.2 5.8a1.5 1.5 0 0 1 1.5-1.5h1.6l1.2-1.7h3l1.2 1.7h1.6a1.5 1.5 0 0 1 1.5 1.5v5.8a1.5 1.5 0 0 1-1.5 1.5H3.7a1.5 1.5 0 0 1-1.5-1.5Z"/><circle cx="8" cy="8.6" r="2.3"/>',
};
function kcIcon(name, className = "kc-ico") {
  const holder = node("span", undefined, className);
  holder.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KC_ICON[name] || ""}</svg>`;
  return holder;
}
// Галочки прочтения — своя сетка: две галки шире одной.
function kcReadMark(read) {
  const holder = node("span", undefined, `kc-read${read ? " on" : ""}`);
  holder.innerHTML = read
    ? '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m1.4 6.4 2.6 2.6L9.4 3.4M7.4 8.6l.4.4 5.4-5.6"/></svg>'
    : '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 6.4 2.6 2.6L11 3.4"/></svg>';
  holder.setAttribute("role", "img");
  holder.setAttribute("aria-label", read ? t("прочитано") : t("отправлено"));
  return holder;
}
// Разметка собирается узлами: имена, названия и сообщения — чужой текст.
function kcEl(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === "") continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
function kcButton(className, content, onClick, attrs = {}) {
  const button = kcEl("button", className, content);
  button.type = "button";
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) button.setAttribute(key, value);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}
const kcTone = (color) => `tone-${CIRCLE_TONES[color] || "violet"}`;
const kcInitial = (name) => (String(name || "").trim()[0] || "·").toUpperCase();
const kcSeal = (content, tone, extra = "") => kcEl("span", `kc-seal ${tone}${extra ? ` ${extra}` : ""}`, content);
// Знак круга: фото, если хозяин его поставил, поверх первой буквы на тоне
// круга — пока фото грузится или если не загрузилось, видна буква.
const kcCircleSeal = (circle, extra = "round") => pictureInto(kcSeal(kcInitial(circle.name), kcTone(circle.color), extra), circle.photo);
// Цвет имени в пузыре — у каждого свой и один и тот же во всех разговорах.
function kcNameTone(personId) {
  let hash = 0;
  for (const char of String(personId || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return KC_NAME_TONES[hash % KC_NAME_TONES.length];
}
// Время в пузыре и в списке — только часы: день уже сказан плашкой над
// сообщениями или словом «вчера».
function kcClock(iso) {
  try { return new Intl.DateTimeFormat(getLocale(), { timeZone: getTimeZone(), hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return ""; }
}
function kcWhen(iso) {
  if (!iso) return "";
  const day = zoneDate(new Date(iso));
  const today = currentDayDate || zoneDate(new Date());
  if (day === today) return kcClock(iso);
  if (day === shiftDate(today, -1)) return t("вчера");
  return reportDateLabel(day, { day: "numeric", month: "short" });
}
function kcDayLabel(day) {
  const today = currentDayDate || zoneDate(new Date());
  if (day === today) return t("Сегодня");
  if (day === shiftDate(today, -1)) return t("Вчера");
  return reportDateLabel(day, { weekday: "long", day: "numeric", month: "long" });
}
const kcDue = (due) => (due?.date ? `${reportDateLabel(due.date, { day: "numeric", month: "short" })}${due.time ? `, ${due.time}` : ""}` : "");

// ── какие разговоры есть и какой открыт ──
function kcThreads() {
  const list = [];
  for (const room of chatState.rooms) {
    const circle = circlesState.circles.find((item) => item.id === room.circleId);
    if (!circle) continue;
    list.push({ key: `room:${room.id}`, kind: "room", room, circle, title: room.kind === "general" ? circle.name : room.name, at: room.last?.createdAt || room.createdAt, unread: room.unread || 0, called: Boolean(room.called), muted: Boolean(circle.muted) });
  }
  for (const talk of circlesState.discussions || []) {
    const circle = talk.circle ? circlesState.circles.find((item) => item.id === talk.circle.id) || talk.circle : null;
    list.push({ key: `talk:${talk.captureId}`, kind: "talk", talk, circle, title: talk.title, at: talk.last?.at || "", unread: talk.unreadCount || 0, called: Boolean(talk.unread), muted: Boolean(circle?.muted) });
  }
  return list.sort((left, right) => String(right.at).localeCompare(String(left.at)));
}
const kcCurrent = () => kcThreads().find((item) => item.key === kc.chat) || null;
const kcNarrow = () => window.matchMedia("(max-width: 760px)").matches;
// Вкладка разговора — его круг. Обсуждения записей вне ваших кругов лежат на
// вкладке «Без круга».
const kcWhereOf = (item) => (item.circle && circlesState.circles.some((circle) => circle.id === item.circle.id) ? item.circle.id : "none");
const kcTabCircle = () => circlesState.circles.find((circle) => circle.id === kc.circle) || null;
// Вкладка без открытого разговора всё равно про свой круг: «Позвать», меню и
// «Информация» берут за основу его «Общий».
function kcContext() {
  const current = kcCurrent();
  if (current) return current;
  const circle = kcTabCircle();
  return circle ? kcThreads().find((item) => item.kind === "room" && item.room.kind === "general" && item.circle.id === circle.id) || null : null;
}
// Вкладка остаётся на месте, пока её круг есть; иначе — первый круг или «Без круга».
function kcSettleTab() {
  const threads = kcThreads();
  const valid = (where) => (where === "none" ? threads.some((item) => kcWhereOf(item) === "none") : circlesState.circles.some((circle) => circle.id === where));
  if (!valid(kc.circle)) kc.circle = circlesState.circles[0]?.id || (threads.length ? "none" : null);
}
// С какого сообщения начинается непрочитанное: столько чужих сообщений от
// конца, сколько было на счётчике до открытия.
function kcNewFrom(items, unread) {
  let left = unread;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "said" && item.author?.id !== currentUser?.id && --left === 0) return item.id;
  }
  return null;
}
function kcTalkItems(comments) {
  for (const comment of comments) comment.kind = "said";
  return comments;
}

async function kcOpen(key) {
  const changed = kc.chat !== key;
  if (changed) {
    kc.newFrom = null;
    kc.ctx = null;
    kc.menu = false;
    kc.talks = false;
    kc.share = null;
    if (kc.reply?.chat !== key) kc.reply = null;
    if (kc.info && kc.info !== "main") kc.info = "main";
    kc.fresh = true;
  }
  kc.chat = key;
  kcStore("pagent.circles-chat", key);
  // Вкладка идёт за разговором и помнит, какой разговор в круге открыт последним.
  const opened = kcThreads().find((item) => item.key === key);
  if (opened) {
    const where = kcWhereOf(opened);
    if (kc.circle !== where) kc.info = null;
    kc.circle = where;
    kcStore("pagent.circles-circle", where);
    kcStore("pagent.circles-last", { ...kcStored("pagent.circles-last", {}), [where]: key });
  }
  if (key.startsWith("room:")) {
    const roomId = key.slice(5);
    markNotificationsRead({ roomId });
    const room = chatState.rooms.find((item) => item.id === roomId);
    const unread = room?.unread || 0;
    if (changed) { chatState.loading = true; kc.talk = null; renderCircles(); }
    try {
      const data = await request(`/api/rooms/${roomId}/messages`);
      // Пока шёл ответ, человек открыл другой разговор — этот уже не нужен.
      if (kc.chat !== key) return;
      chatState.messages = data.messages || [];
      chatState.more = Boolean(data.more);
      if (room) Object.assign(room, data.room, { unread: 0, called: false });
      if (changed && unread) kc.newFrom = kcNewFrom(chatState.messages, unread);
    } catch (error) {
      chatState.messages = [];
      toast(error.message || t("Разговор не открылся"));
    } finally { chatState.loading = false; }
    if (unread) load().catch(() => {});
  } else {
    const captureId = key.slice(5);
    markNotificationsRead({ captureId });
    const talk = (circlesState.discussions || []).find((item) => item.captureId === captureId);
    const unread = talk?.unreadCount || 0;
    if (changed) { chatState.loading = true; chatState.messages = []; renderCircles(); }
    try {
      const data = await request(`/api/captures/${captureId}/comments`);
      if (kc.chat !== key) return;
      kc.talk = { captureId, comments: kcTalkItems(data.comments || []), callable: data.callable || [], participants: data.participants || [] };
      if (talk) { talk.unreadCount = 0; talk.unread = false; }
      if (changed && unread) kc.newFrom = kcNewFrom(kc.talk.comments, unread);
    } catch (error) {
      kc.talk = { captureId, comments: [], callable: [], participants: [] };
      toast(error.message || t("Обсуждение не открылось"));
    } finally { chatState.loading = false; }
  }
  renderCircles({ toBottom: true });
}

async function loadCircles({ then = null } = {}) {
  // Загрузка уже идёт — но она могла уйти до правки (новый круг, человек в
  // круге). Второй вызов не теряется: круги перечитываются, как только первая
  // закончится, иначе на экране оставался бы список до правки.
  if (circlesState.loading) { circlesState.again = { then: then || circlesState.again?.then || null }; return; }
  // Круги перечитывают — значит состав мог измениться: подсказка «@» в поле
  // записи спросит людей заново.
  forgetMentionPeople();
  circlesState.loading = true;
  kcEdited();
  try {
    const [data, rooms, talks] = await Promise.all([request("/api/circles"), request("/api/rooms"), request("/api/discussions").catch(() => ({ discussions: [] }))]);
    circlesState.circles = data.circles || [];
    circlesState.me = data.me || null;
    chatState.rooms = rooms.rooms || [];
    circlesState.discussions = talks.discussions || [];
    kcSettleTab();
    renderCircles();
    if (then) await then();
    else {
      // Открывается разговор, на котором остановились. Нет его — самый свежий
      // из прочитанных, сначала в своей вкладке: открыть разговор значит
      // прочитать его, и то, где ждут непрочитанные или позвали, страница сама
      // не открывает — такие разговоры ждут нажатия с числом на чипе.
      const threads = kcThreads();
      const wanted = kc.chat || kcStored("pagent.circles-chat", null);
      const quiet = (item) => !item.unread && !item.called;
      const target = threads.find((item) => item.key === wanted) || threads.find((item) => kcWhereOf(item) === kc.circle && quiet(item)) || threads.find(quiet);
      if (target) await kcOpen(target.key);
      else { kc.chat = null; kcSettleTab(); renderCircles(); }
    }
  } catch (error) {
    const body = $("#circles-body");
    if (body) { clear(body); body.append(node("p", error.message || t("Не удалось загрузить круги"), "empty")); }
  } finally {
    circlesState.loading = false;
    const again = circlesState.again;
    circlesState.again = null;
    if (again) await loadCircles(again);
    else if (roomsRefresh.again && !roomsRefresh.running) { roomsRefresh.again = false; await refreshRoomsQuietly(); }
  }
}
// Ссылка из полосы «к вам» и из колокольчика: открыть разговор, где позвали.
// «Вас добавили в круг»: открыть — значит прочитать, строка гаснет.
async function openCircleFromInbox(circleId) {
  location.hash = "#circles";
  try { await request(`/api/circles/${circleId}/seen`, { method: "POST", body: JSON.stringify({}) }); } catch {}
  await loadCircles({ then: async () => {
    const room = chatState.rooms.find((item) => item.circleId === circleId && item.kind === "general");
    if (room) await kcOpen(`room:${room.id}`);
  } });
  load().catch(() => {});
}
async function openRoomFromInbox(roomId) {
  location.hash = "#circles";
  await loadCircles({ then: () => kcOpen(`room:${roomId}`) });
}

// ── страница ──
function renderCircles({ toBottom = false } = {}) {
  const body = $("#circles-body");
  if (!body) return;
  const active = document.activeElement;
  const focusId = active && body.contains(active) && active.id ? active.id : null;
  const selection = focusId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  const oldList = $("#kc-msgs");
  const keep = oldList && !toBottom ? oldList.scrollTop : null;
  // Страница перестраивается целиком — прокрутка остаётся: у «Информации» по
  // высоте, у вкладок, людей и чипов — вбок.
  const scrolls = [".kc-info-body", ".kc-tabs", ".kc-seats", ".kc-chips"].map((selector) => {
    const element = body.querySelector(selector);
    return [selector, element?.scrollTop || 0, element?.scrollLeft || 0];
  });
  clear(body);
  if (kc.joining) { body.append(kcInviteCard()); return; }
  body.append(circlesState.circles.length || (circlesState.discussions || []).length ? kcLayout() : kcEmptyPage());
  const list = $("#kc-msgs");
  if (list) list.scrollTop = keep === null ? list.scrollHeight : keep;
  for (const [selector, top, left] of scrolls) {
    const element = body.querySelector(selector);
    if (element && top) element.scrollTop = top;
    if (element && left) element.scrollLeft = left;
  }
  if (focusId) {
    const element = document.getElementById(focusId);
    if (element) {
      element.focus({ preventScroll: true });
      if (selection && element.setSelectionRange) { try { element.setSelectionRange(selection[0], selection[1]); } catch {} }
    }
  }
  const field = $("#kc-field");
  if (field) kcAutosize(field);
  if (kc.focusField && field) {
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    kc.focusField = false;
  }
  if (kc.modal && kc.modal.focus) { $("#kc-modal-name")?.focus(); kc.modal.focus = false; }
  // Поле «поручить дело» открывается уже готовым к набору: кнопка у человека —
  // это и есть начало записи.
  if (kc.deedFocus) {
    const deed = $("#kc-deed-field");
    if (deed) deed.focus({ preventScroll: true });
    kc.deedFocus = false;
  }
  kc.fresh = false;
  kcFit();
}
// Страница кругов занимает окно по высоте: прокручивается разговор, а не
// страница, — вкладки, стол и чипы стоят на месте.
function kcFit() {
  const box = $("#circles-body > .kc");
  if (!box) return;
  const top = box.getBoundingClientRect().top + window.scrollY;
  box.style.height = `${Math.max(kcNarrow() ? 420 : 520, window.innerHeight - top)}px`;
}
window.addEventListener("resize", () => { if (!$("#circles")?.hidden) kcFit(); });
function kcAutosize(field) {
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
}
function kcLayout() {
  kcSettleTab();
  const current = kcCurrent();
  const context = kcContext();
  const circle = kcTabCircle();
  const tone = circle ? kcTone(circle.color) : current?.kind === "talk" ? `tone-${(KC_KIND[current.talk.kind] || KC_KIND.note)[0]}` : "tone-violet";
  const root = kcEl("div", `kc ${tone}`, kcTabs(), kcTable(current, circle), kcThreadsRow(current, circle, context), kcChatPane(current, circle));
  if (kc.info && context) root.append(kcInfo(context));
  const modal = kcModal();
  if (modal) root.append(modal);
  return root;
}

// ── вкладки кругов ──
// Число на вкладке — сколько разговоров круга ждут: непрочитанное или призыв.
// У круга, который вы не показываете в дне, число серое, как у заглушённого чата.
const kcTabCount = (where) => kcThreads().filter((item) => kcWhereOf(item) === where && item.key !== kc.chat && (item.unread || item.called)).length;
function kcTabs() {
  const tabs = kcEl("div", "kc-tabs");
  tabs.setAttribute("role", "tablist");
  bindTranslation(tabs, "Круги", "aria-label");
  const tab = (where, face, label, { tone = "", muted = false } = {}) => {
    const on = kc.circle === where;
    const count = kcTabCount(where);
    const button = kcButton(`kc-tab${tone ? ` ${tone}` : ""}${on ? " on" : ""}`, [
      face, kcEl("span", "kc-tab-name", label), muted ? kcIcon("muted", "kc-ico kc-muted") : null,
      count ? kcEl("span", `kc-badge${muted ? " muted" : ""}`, String(count)) : null,
    ], () => kcGoTab(where), { role: "tab", "aria-selected": String(on), title: label });
    button.dataset.tab = where;
    return button;
  };
  for (const circle of circlesState.circles) tabs.append(tab(circle.id, kcCircleSeal(circle, ""), circle.name, { tone: kcTone(circle.color), muted: circle.muted }));
  if (kcThreads().some((item) => kcWhereOf(item) === "none")) tabs.append(tab("none", kcEl("span", "kc-tab-doc", kcIcon("doc")), t("Без круга")));
  tabs.append(kcButton("kc-tab add", [kcIcon("plus"), kcEl("span", "kc-tab-name", t("Круг"))], () => kcModalOpen("circle"), { get "aria-label"() { return t("Новый круг"); }, get title() { return t("Новый круг"); } }));
  return tabs;
}
// Вкладка открывает разговор, на котором в этом круге остановились, иначе —
// «Общий»; у «Без круга» — самое свежее обсуждение.
function kcGoTab(where) {
  if (kc.circle === where && kc.chat) return;
  const threads = kcThreads().filter((item) => kcWhereOf(item) === where);
  const remembered = kcStored("pagent.circles-last", {})[where];
  const target = threads.find((item) => item.key === remembered) || threads.find((item) => item.kind === "room" && item.room.kind === "general") || threads[0];
  if (kc.circle !== where) { kc.info = null; kc.menu = false; kc.talks = false; }
  kc.circle = where;
  kcStore("pagent.circles-circle", where);
  if (target) kcOpen(target.key);
  else { kc.chat = null; renderCircles(); }
}

// ── за столом: люди круга ──
// У каждого — ближайшее дело в этом круге, просроченное первым, и «ещё N».
// Лицо открывает карточку человека, «@» зовёт его в открытый разговор. В комнату
// подмножеством так позвать можно только тех, кто в ней: остальные сидят
// бледнее и без «@».
function kcTable(current, circle) {
  if (!kc.table) return null;
  const seats = kcEl("div", "kc-seats");
  if (circle) {
    bindTranslation(seats, "Люди круга «{name}»", { name: circle.name }, "aria-label");
    for (const member of circle.members) seats.append(kcSeat(member, circle, current));
    seats.append(kcButton("kc-seat add", [kcEl("span", "kc-seat-plus", kcIcon("personAdd")), kcEl("span", "kc-seat-who", kcEl("b", null, t("Позвать")), kcEl("small", null, t("из Кизуны или ссылкой")))], () => kcInfoOpen("invite")));
  } else if (current?.kind === "talk") {
    bindTranslation(seats, "Участники обсуждения", "aria-label");
    for (const person of kcTalkPeople(current)) seats.append(kcSeat(person, null, current));
  } else return null;
  return kcEl("div", "kc-band", seats, kcButton("kc-icon kc-band-fold", kcIcon("chevUp"), () => kcSetTable(false), { get "aria-label"() { return t("Свернуть людей"); }, get title() { return t("Свернуть людей"); } }));
}
function kcSetTable(open) {
  kc.table = open;
  kcStore("pagent.circles-table", open);
  renderCircles();
}
function kcSeat(person, circle, current) {
  const me = person.id === currentUser?.id;
  const today = currentDayDate || zoneDate(new Date());
  const deeds = circle ? person.deeds || [] : [];
  const late = deeds.find((deed) => deed.due?.date && deed.due.date < today);
  const next = late || deeds[0];
  const rest = Math.max(0, (person.openDeeds || deeds.length) - 1);
  const away = current?.kind === "room" && current.room.kind === "room" && !current.room.everyone && !current.room.members.some((member) => member.id === person.id);
  const joinedToday = Boolean(person.joinedAt) && zoneDate(new Date(person.joinedAt)) === today;
  const line = next
    ? [kcEl("span", "kc-seat-deed", kcIcon("todo"), kcEl("span", null, next.title)),
      kcEl("small", late ? "late" : null, late ? t("просрочено") : next.due?.date ? kcDue(next.due) : next.state === "pending" ? t("ждёт ответа") : t("без срока"), rest ? t(" · ещё {rest}", { rest: rest }) : "")]
    : kcEl("small", null, !circle ? (person.id === current?.talk?.author?.id ? t("автор записи") : t("в обсуждении")) : away ? t("не в этой комнате") : joinedToday && person.role !== "owner" ? t("в круге с сегодня") : t("дел в круге нет"));
  const face = kcButton("kc-seat-face", avatarEl(person), () => (circle ? kcInfoOpen("person", person.id) : kcInfoOpen("main")), { "aria-label": t("{name}: карточка", { name: person.name }), title: person.name });
  const seat = kcEl("div", `kc-seat${away ? " away" : ""}`, face,
    kcEl("span", "kc-seat-who", kcEl("b", null, kcEl("span", null, me ? t("Вы") : person.name), person.role === "owner" ? kcEl("i", null, t("хозяин")) : null), line));
  if (!me && !away && current) seat.append(kcButton("kc-seat-at", "@", () => kcInsertCall(person.name), { "aria-label": t("Позвать {name} в разговор", { name: person.name }), title: `@${person.name}` }));
  // Дело человеку — прямо отсюда: карточка открывается с готовым полем, писать
  // в него можно сразу.
  if (!me && circle) seat.append(kcButton("kc-seat-todo", kcIcon("todo"), () => { kc.deedFocus = true; kcInfoOpen("person", person.id); }, { "aria-label": t("Поручить дело: {name}", { name: person.name }), get title() { return t("Поручить дело"); } }));
  seat.dataset.person = person.id;
  return seat;
}
function kcFaces(people, max = 4) {
  const shown = people.length > max ? people.slice(0, max - 1) : people;
  const faces = kcEl("span", "kc-faces", shown.map((person) => avatarEl(person)));
  if (people.length > shown.length) faces.append(kcEl("span", "kc-faces-more", `+${people.length - shown.length}`));
  return faces;
}
// «вы, Аня и Лёша» — кто видит комнату: вы первым, дальше по порядку прихода.
function kcNames(people) {
  const mine = (person) => person.id === currentUser?.id;
  const names = [...people.filter(mine), ...people.filter((person) => !mine(person))].map((person) => (mine(person) ? t("вы") : person.name));
  return names.length < 2 ? names.join("") : t("{value1} и {value2}", { value1: names.slice(0, -1).join(", "), value2: names.at(-1) });
}

// ── разговоры круга чипами ──
// «Общий» первым, дальше разговоры на весь круг и комнаты — по порядку
// заведения, затем обсуждения записей. Обсуждений бывает много: в строке —
// открытое, те, где ждут или позвали, и два свежих; остальные — списком за «Записи».
function kcThreadsRow(current, circle, context) {
  const threads = kcThreads().filter((item) => kcWhereOf(item) === kc.circle);
  const rooms = threads.filter((item) => item.kind === "room").sort((left, right) =>
    (left.room.kind === "general" ? -1 : right.room.kind === "general" ? 1 : String(left.room.createdAt).localeCompare(String(right.room.createdAt))));
  const talks = threads.filter((item) => item.kind === "talk");
  const shown = talks.filter((item, index) => item.key === kc.chat || item.unread || item.called || index < 2);
  const hidden = talks.filter((item) => !shown.includes(item));
  const chips = kcEl("div", "kc-chips", [...rooms, ...shown].map(kcChip));
  chips.setAttribute("role", "tablist");
  bindTranslation(chips, "Разговоры", "aria-label");
  if (hidden.length) {
    const waiting = hidden.some((item) => item.unread || item.called);
    const more = kcButton(`kc-chip more${kc.talks ? " on" : ""}`, [kcIcon("doc"), kcEl("span", "kc-chip-name", t("Записи · {length}", { length: hidden.length })), waiting ? kcEl("span", "kc-dot") : null],
      () => { kc.talks = !kc.talks; kc.menu = false; kc.ctx = null; renderCircles(); }, { "aria-haspopup": "menu", "aria-expanded": String(kc.talks) });
    more.dataset.kcMenu = "1";
    chips.append(more);
  }
  if (circle && circle.members.length > 1) chips.append(kcButton("kc-chip add", [kcIcon("plus"), kcEl("span", "kc-chip-name", t("Разговор"))], () => kcModalOpen("room", { circleId: circle.id }), { get title() { return t("Новый разговор в круге"); } }));
  const row = kcEl("div", "kc-threads", chips);
  const people = circle ? circle.members : current?.kind === "talk" ? kcTalkPeople(current) : [];
  if (!kc.table && people.length) row.append(kcButton("kc-folded", [kcFaces(people, 5), kcEl("span", "kc-wide", `${people.length} ${pluralRu(people.length, t("человек"), t("человека"), t("человек"))}`), kcIcon("chevDown")], () => kcSetTable(true), { get "aria-label"() { return t("Показать людей"); }, get title() { return t("Показать людей"); } }));
  if (context) row.append(kcMenuToggle());
  if (kc.menu && context) row.append(kcHeadMenu(context));
  if (kc.talks && hidden.length) row.append(kcTalksMenu(hidden));
  return row;
}
function kcChip(item) {
  const on = item.key === kc.chat;
  let lead, name, faces = null, title;
  if (item.kind === "talk") {
    const kind = KC_KIND[item.talk.kind] ? item.talk.kind : "note";
    lead = kcEl("span", `kc-chip-kind tone-${KC_KIND[kind][0]}`, kcIcon(kind));
    name = item.talk.title;
    title = t("Обсуждение записи «{name}»", { name: name });
  } else if (item.room.kind === "general") {
    lead = kcIcon("chats");
    name = t("Общий");
    title = t("Общий разговор круга — его видят все, кто в круге");
  } else if (item.room.everyone) {
    lead = kcEl("span", "kc-chip-hash", "#");
    name = item.room.name;
    title = t("«{name}» — видит весь круг", { name: name });
  } else {
    lead = kcIcon("lock");
    name = item.room.name;
    faces = kcFaces(item.room.members.filter((member) => member.id !== currentUser?.id), 3);
    title = t("«{name}» — видят только {value2}", { name: name, value2: kcNames(item.room.members) });
  }
  const counts = [];
  if (item.called && !on) counts.push(kcEl("span", "kc-cnt at", "@"));
  if (item.unread && !on) counts.push(kcEl("span", `kc-cnt${item.muted ? " muted" : ""}`, String(item.unread)));
  const chip = kcButton(`kc-chip${on ? " on" : ""}`, [lead, kcEl("span", "kc-chip-name", name), faces, counts], () => kcOpen(item.key), { role: "tab", "aria-selected": String(on), title });
  chip.dataset.chat = item.key;
  return chip;
}
function kcTalksMenu(items) {
  const menu = kcEl("div", "kc-menu kc-talks-menu");
  menu.setAttribute("role", "menu");
  bindTranslation(menu, "Обсуждения записей", "aria-label");
  for (const item of items) {
    const kind = KC_KIND[item.talk.kind] ? item.talk.kind : "note";
    menu.append(kcButton("kc-menu-item", [
      kcEl("span", `kc-chip-kind tone-${KC_KIND[kind][0]}`, kcIcon(kind)), kcEl("span", "kc-menu-name", item.talk.title),
      item.called ? kcEl("span", "kc-cnt at", "@") : null, item.unread ? kcEl("span", "kc-cnt", String(item.unread)) : kcEl("time", null, kcWhen(item.at)),
    ], () => { kc.talks = false; kcOpen(item.key); }, { role: "menuitem" }));
  }
  return menu;
}

// ── разговор ──
function kcTalkPeople(item) {
  const people = new Map();
  const add = (person) => { if (person?.id && !people.has(person.id)) people.set(person.id, person); };
  add(item.talk.author);
  for (const person of kc.talk?.participants || item.talk.people || []) add(person);
  for (const person of kc.talk?.callable || []) if (person.group === "record") add(person);
  add(circlesState.me || currentUser);
  return [...people.values()];
}
const kcMenuToggle = () => {
  const button = kcButton("kc-icon", kcIcon("dots"), () => { kc.menu = !kc.menu; kc.ctx = null; kc.talks = false; renderCircles(); }, { get "aria-label"() { return t("Ещё"); }, get title() { return t("Ещё"); }, "aria-pressed": String(kc.menu), "aria-haspopup": "menu" });
  button.dataset.kcMenu = "1";
  return button;
};
function kcPinned(item) {
  if (item.kind !== "room" || !item.room.pinned) return null;
  const pinned = item.room.pinned;
  const bar = kcEl("div", "kc-pinned");
  const jump = kcButton("kc-pinned-main", [kcEl("span", "kc-pinned-bar"), kcEl("span", "kc-pinned-text", kcEl("b", null, t("Закреплённое сообщение")), kcEl("span", null, pinned.body))], () => {
    const target = document.querySelector(`#kc-msgs [data-id="${CSS.escape(pinned.id)}"]`);
    if (!target) { toast(t("Сообщение выше — прокрутите разговор")); return; }
    target.scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1400);
  });
  bar.append(jump, kcButton("kc-icon", kcIcon("close"), () => kcPin(item, null), { get "aria-label"() { return t("Открепить"); }, get title() { return t("Открепить"); } }));
  return bar;
}
// Над обсуждением записи — сама запись строкой: что это за дело и когда, и
// карточка в одно нажатие.
function kcRecordBar(item) {
  const talk = item.talk;
  const [, word] = KC_KIND[talk.kind] || KC_KIND.note;
  const open = () => openSharedCard(talk.captureId, { talk: true });
  return kcEl("div", "kc-pinned kc-record",
    kcButton("kc-pinned-main", [kcEl("span", "kc-pinned-bar"), kcEl("span", "kc-pinned-text", kcEl("b", null, t("Запись · {word}{value2}", { word: word, value2: talk.due?.date ? t(" · до {value1}", { value1: kcDue(talk.due) }) : "" })), kcEl("span", null, talk.title))], open, { "aria-label": t("Запись «{title}»", { title: talk.title }) }),
    kcButton("kc-btn sm", [kcIcon("doc"), kcEl("span", "kc-wide", t("Открыть карточку"))], open, { get "aria-label"() { return t("Открыть карточку"); } }));
}
function kcChatPane(item, circle) {
  const section = kcEl("section", "kc-chat-pane");
  bindTranslation(section, "Разговор", "aria-label");
  const alone = circle && circle.members.length === 1 && (!item || (item.kind === "room" && item.room.kind === "general"));
  if (alone) { section.append(kcAlone(circle)); return section; }
  if (!item) {
    section.append(kcEl("div", "kc-empty-chat", kcEl("p", "kc-pill", t("Выберите разговор — где ждут, стоит число"))));
    return section;
  }
  const pinned = item.kind === "talk" ? kcRecordBar(item) : kcPinned(item);
  if (pinned) section.append(pinned);
  const list = kcEl("div", "kc-msgs");
  list.id = "kc-msgs";
  list.setAttribute("role", "log");
  const column = kcEl("div", "kc-col");
  if (chatState.loading) column.append(kcEl("p", "kc-pill", t("Читаю…")));
  else {
    const start = kcStart(item);
    if (start) column.append(start);
    if (item.kind === "room") kcRoomMessages(column, item);
    else kcTalkMessages(column, item);
  }
  list.append(column);
  section.append(list, kcEl("div", "kc-dock", kcEl("div", "kc-col", kcComposer(item))));
  if (kc.ctx) { const menu = kcContextMenu(item); if (menu) section.append(menu); }
  return section;
}
// Начало разговора — строкой над первым сообщением: что это за разговор, с
// какого дня и кто его видит. Пока история подгружена не вся, строки нет.
function kcStart(item) {
  if (item.kind === "talk") {
    const talk = kc.talk?.captureId === item.talk.captureId ? kc.talk : null;
    return kcEl("p", "kc-start", t("Начало обсуждения записи «{title}»", { title: item.talk.title }), talk && !talk.comments.length ? t(" — пока тихо: напишите и позовите, кто нужен, через @имя") : "");
  }
  if (chatState.more) return null;
  const room = item.room, circle = item.circle;
  const since = reportDateLabel(zoneDate(new Date(room.kind === "general" ? circle.createdAt : room.createdAt)), { day: "numeric", month: "long" });
  const who = room.kind === "general" || room.everyone ? t("видит весь круг") : t("видят только {value1}", { value1: kcNames(room.members) });
  return kcEl("p", "kc-start", room.kind === "general" ? t("Начало разговора круга «{name}» · с {since} · {who}", { name: circle.name, since: since, who: who }) : t("Начало разговора «{name}» · с {since} · {who}", { name: room.name, since: since, who: who }));
}
// Круг из одного: вместо пустого разговора — позвать людей прямо здесь.
function kcAlone(circle) {
  return kcEl("div", `kc-alone ${kcTone(circle.color)}`,
    kcEl("div", "kc-alone-card",
      kcEl("h3", null, t("В круге пока только вы")),
      kcEl("p", "kc-hint", t("Разговор оживёт, когда позовёте людей. Позванные увидят только то, что вы отдадите в круг.")),
      kcInviteEl(circle)));
}
function kcRoomMessages(list, item) {
  const owner = item.circle.members.find((member) => member.role === "owner")?.id;
  kcBubbles(list, chatState.messages, { owner, get ownerWord() { return t("хозяин"); } });
}
function kcTalkMessages(list, item) {
  const talk = kc.talk?.captureId === item.talk.captureId ? kc.talk : { comments: [], participants: [] };
  // «Аня — в обсуждении» стоит там, где человека позвали: видно, с какого
  // места он читает разговор вместе со всеми.
  const joins = talk.participants.map((person) => ({ id: `join:${person.id}`, kind: "line", createdAt: person.addedAt, text: t("{value1} — в обсуждении", { value1: person.id === currentUser?.id ? t("Вы") : person.name }) }));
  const items = [...talk.comments, ...joins].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  kcBubbles(list, items, { owner: item.talk.author?.id, get ownerWord() { return t("автор"); } });
}
const kcAuthorOf = (message) => (message.kind === "deed" ? message.deed.assigner : message.author);
function kcBubbles(list, items, { owner, ownerWord }) {
  let day = null, index = 0;
  while (index < items.length) {
    const message = items[index];
    const messageDay = zoneDate(new Date(message.createdAt));
    if (messageDay !== day) { day = messageDay; list.append(kcEl("div", "kc-pill kc-day", kcDayLabel(day))); }
    if (message.id === kc.newFrom) list.append(kcEl("div", "kc-unread-bar", t("Непрочитанные сообщения")));
    if (message.kind !== "said" && message.kind !== "deed") {
      list.append(kcEl("div", "kc-pill", message.kind === "line" ? message.text : `${message.author?.name || t("Кто-то")} ${message.body}`));
      index += 1;
      continue;
    }
    const by = kcAuthorOf(message);
    const mine = by?.id === currentUser?.id;
    const bubbles = kcEl("div", "kc-bubbles");
    let first = true;
    while (index < items.length) {
      const next = items[index];
      if (next.kind !== "said" && next.kind !== "deed") break;
      if (kcAuthorOf(next)?.id !== by?.id) break;
      if (!first && (next.id === kc.newFrom || zoneDate(new Date(next.createdAt)) !== day)) break;
      bubbles.append(...[next.kind === "deed" ? kcDeedBubble(next) : kcBubble(next, { first, mine, owner, ownerWord })].flat());
      first = false;
      index += 1;
    }
    const group = kcEl("div", `kc-grp${mine ? " out" : ""}`);
    if (!mine) group.append(avatarEl(by));
    group.append(bubbles);
    list.append(group);
  }
}
function kcQuote(replyTo) {
  const quote = kcButton("kc-quote", [kcEl("b", null, replyTo.author ? (replyTo.author.id === currentUser?.id ? t("Вы") : replyTo.author.name) : t("Сообщение")), kcEl("span", null, replyTo.removed ? t("сообщение убрано") : replyTo.body)], () => {
    const target = document.querySelector(`#kc-msgs [data-id="${CSS.escape(replyTo.id)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1400);
  });
  if (replyTo.author) quote.style.setProperty("--quote", `var(--circle-${kcNameTone(replyTo.author.id)})`);
  return quote;
}
function kcBubble(message, { first, mine, owner, ownerWord }) {
  const bubble = kcEl("div", "kc-bb");
  bubble.dataset.id = message.id;
  if (!mine && first) {
    const name = kcEl("span", "kc-name", kcEl("span", null, message.author?.name || t("Кто-то")), message.author?.id && message.author.id === owner ? kcEl("i", null, ownerWord) : null);
    name.style.color = `var(--circle-${kcNameTone(message.author?.id)})`;
    bubble.append(name);
  }
  if (message.replyTo) bubble.append(kcQuote(message.replyTo));
  const text = commentText(message.body, message.mentions);
  text.className = "kc-tx";
  const meta = kcEl("span", "kc-meta", kcClock(message.createdAt), mine ? kcReadMark(Boolean(message.read)) : null);
  const reactions = (message.reactions || []).filter((reaction) => reaction.count);
  if (reactions.length) bubble.append(text, kcEl("div", "kc-reacts", reactions.map((reaction) => kcReactChip(message, reaction)), meta));
  else { text.append(meta); bubble.append(text); }
  bubble.addEventListener("contextmenu", (event) => { event.preventDefault(); kcCtxOpen(message.id, event.clientX, event.clientY); });
  const more = kcButton("kc-bb-act", kcIcon("dots"), (event) => { const box = event.currentTarget.getBoundingClientRect(); kcCtxOpen(message.id, box.left, box.bottom + 4); }, { get "aria-label"() { return t("Ещё"); } });
  more.dataset.kcMenu = "1";
  return kcEl("div", "kc-bb-wrap", bubble, kcEl("span", "kc-bb-acts", kcButton("kc-bb-act", kcIcon("reply"), () => kcReplyTo(message), { get "aria-label"() { return t("Ответить"); } }), more));
}
function kcReactChip(message, reaction) {
  const faces = reaction.count <= 2 && reaction.people?.length ? kcEl("span", "kc-react-faces", reaction.people.slice(0, 2).map((person) => avatarEl(person, { size: "mini" }))) : kcEl("span", null, String(reaction.count));
  const names = (reaction.people || []).map((person) => person.name).join(", ");
  return kcButton(`kc-react${reaction.mine ? " mine" : ""}`, [reaction.emoji, faces], () => kcReact(message, reaction.emoji), { "aria-label": `${reaction.emoji} ${reaction.count}`, title: names });
}
function kcDeedBubble(message) {
  const deed = message.deed;
  const [stateClass, stateWord] = { pending: ["wait", t("ждёт ответа")], accepted: ["took", t("взято")], declined: ["back", t("отказ")], done: ["done", t("сделано")] }[deed.state] || ["wait", deed.state];
  const me = currentUser?.id;
  const bubble = kcEl("div", "kc-bb kc-deed",
    kcEl("span", "kc-deed-kind", kcIcon("todo"), t("Дело")),
    kcButton("kc-deed-title", deed.title, () => openSharedCard(deed.captureId)),
    kcEl("div", "kc-deed-meta", avatarEl(deed.assigner, { size: "mini" }), deed.assigner?.id === me ? t("вы") : deed.assigner?.name, " → ", avatarEl(deed.assignee, { size: "mini" }), deed.forMe ? t("вам") : deed.assignee?.name, deed.due?.date ? t(" · до {value1}", { value1: kcDue(deed.due) }) : ""),
    kcEl("div", "kc-reacts", kcEl("span", `kc-state ${stateClass}`, stateWord), kcEl("span", "kc-meta", kcClock(message.createdAt))));
  bubble.dataset.id = message.id;
  const tomorrow = tomorrowAction({ id: deed.captureId, title: deed.title, schedule: deed.due, done: deed.state === "done", mine: deed.assigner?.id === me });
  if (tomorrow) bubble.append(tomorrow);
  const wrap = kcEl("div", "kc-bb-wrap", bubble);
  if (!(deed.forMe && deed.state === "pending")) return wrap;
  return [wrap, kcEl("div", "kc-kbd-row", kcButton("kc-kbd", t("Беру"), () => kcRespond(deed, true)), kcButton("kc-kbd", t("Не я"), () => kcRespond(deed, false)))];
}
function kcFindMessage(item, id) {
  if (item.kind === "room") return chatState.messages.find((message) => message.id === id) || null;
  return kc.talk?.comments.find((comment) => comment.id === id) || null;
}

// ── поле сообщения ──
function kcComposer(item) {
  const wrap = kcEl("div", "kc-compose");
  const key = item.key;
  if (kc.share?.chat === key) {
    const names = kc.share.people.map((person) => person.name);
    const many = names.length > 1;
    // В разговоре круга призыв открывает сам разговор, а человека из другого
    // круга ещё и приводит в круг: сказано до отправки, а не после.
    const strangers = kc.share.people.filter((person) => person.inCircle === false);
    wrap.append(kcEl("div", "kc-share",
      kc.share.join
        ? kcEl("p", null, kcEl("b", null, t("{value1} ещё не в этом разговоре", { value1: names.join(", ") })),
          t(": {value1} его целиком, включая прошлые сообщения{value2}.", { value1: many ? t("увидят") : t("увидит"), value2: strangers.length ? t(". {value1} {value2} и в круг «{value3}»: люди круга, общие дела и разговоры", { value1: strangers.map((person) => person.name).join(", "), value2: strangers.length > 1 ? t("войдут") : t("войдёт"), value3: item.circle?.name || "" }) : "" }))
        : kcEl("p", null, kcEl("b", null, t("{value1} {value2} доступ к этой записи", { value1: names.join(", "), value2: many ? t("получат") : t("получит") })), t(": заголовок, заметки, файлы и всё обсуждение.")),
      kcEl("div", "kc-share-acts",
        kcButton("kc-btn sm primary", t("Позвать и отправить"), () => kcSend(item, "yes")),
        kcButton("kc-btn sm", t("Отправить без призыва"), () => kcSend(item, "no")),
        kcButton("kc-btn sm ghost", t("Изменить"), () => { kc.share = null; kc.focusField = true; renderCircles(); }))));
  }
  const target = kc.reply?.chat === key ? kcFindMessage(item, kc.reply.id) : null;
  if (target) {
    wrap.append(kcEl("div", "kc-replybar", kcIcon("reply"),
      kcEl("span", "kc-replybar-q", kcEl("b", null, t("Ответ: {value1}", { value1: target.author?.id === currentUser?.id ? t("себе") : target.author?.name || "" })), kcEl("span", null, target.body)),
      kcButton("kc-icon", kcIcon("close"), () => { kc.reply = null; kc.focusField = true; renderCircles(); }, { get "aria-label"() { return t("Отменить ответ"); } })));
  }
  const field = kcEl("textarea");
  field.id = "kc-field";
  field.rows = 1;
  bindTranslation(field, "Сообщение", "placeholder");
  bindTranslation(field, "Сообщение в «{title}»", { title: item.title }, "aria-label");
  field.value = chatState.drafts[key] || "";
  const callable = item.kind === "room" ? kcRoomCallable(item) : kc.talk?.captureId === item.talk.captureId ? kc.talk.callable : [];
  const send = kcButton("kc-send", kcIcon("send"), () => kcSend(item), { get "aria-label"() { return t("Отправить"); } });
  send.disabled = !field.value.trim();
  const changed = () => { chatState.drafts[key] = field.value; send.disabled = !field.value.trim(); kcAutosize(field); };
  const pop = mentionPopup(field, callable, changed, { note: item.kind === "room" ? t("позовём сюда") : t("увидит запись") });
  field.addEventListener("input", changed);
  field.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); kcSend(item); }
    else if (event.key === "Escape" && kc.reply) { event.preventDefault(); kc.reply = null; renderCircles(); }
  });
  const at = kcButton("kc-round", "@", () => {
    const position = field.selectionStart, before = field.value.slice(0, position);
    const insert = before && !/\s$/.test(before) ? " @" : "@";
    field.value = before + insert + field.value.slice(field.selectionEnd);
    field.focus();
    field.setSelectionRange(position + insert.length, position + insert.length);
    field.dispatchEvent(new Event("input"));
  }, { get "aria-label"() { return t("Позвать через @"); }, get title() { return t("Позвать через @"); } });
  wrap.append(pop, at, kcEl("div", "kc-field", field), send);
  return wrap;
}
// Кого можно позвать в разговор круга: сначала те, кто уже здесь, потом
// остальные из этого круга, потом люди из других ваших кругов. Позвать можно
// любого — тому, кого в разговоре нет, сервер сперва спросит, открывать ли ему
// разговор.
function kcRoomCallable(item) {
  const seen = new Map();
  const put = (person, group) => { if (person && person.id !== currentUser?.id && !seen.has(person.id)) seen.set(person.id, { ...person, group }); };
  for (const person of item.room.members || []) put(person, "room");
  for (const person of item.circle?.members || []) put(person, "circle");
  for (const circle of circlesState.circles || []) if (circle.id !== item.circle?.id) for (const person of circle.members || []) put(person, "circles");
  return [...seen.values()];
}

// «@ Позвать» из кольца и карточки человека: имя встаёт в поле, дальше — как
// обычный призыв.
function kcInsertCall(name) {
  const key = kc.chat;
  if (!key) return;
  const draft = (chatState.drafts[key] || "").replace(/\s+$/, "");
  chatState.drafts[key] = `${draft ? `${draft} ` : ""}@${name}${name ? " " : ""}`;
  kc.focusField = true;
  if (kcNarrow()) kc.info = null;
  renderCircles();
  if (!name) $("#kc-field")?.dispatchEvent(new Event("input"));
}
function kcReplyTo(message) {
  kc.reply = { chat: kc.chat, id: message.id };
  kc.ctx = null;
  kc.focusField = true;
  renderCircles();
}
async function kcSend(item, share = null) {
  const field = $("#kc-field");
  const body = (share ? kc.share?.body : field?.value || "").trim();
  if (!body) return;
  const key = item.key;
  const replyId = kc.reply?.chat === key ? kc.reply.id : null;
  const send = $("#circles-body .kc-send");
  if (send) send.disabled = true;
  try {
    if (item.kind === "room") {
      const response = await fetch(`/api/rooms/${item.room.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, ...(replyId ? { replyTo: replyId } : {}), ...(share ? { join: share } : {}) }) });
      const result = await response.json().catch(() => null);
      if (response.status === 401) { location.replace("/login"); return; }
      // Позвали того, кого в разговоре нет: над полем встаёт выбор — позвать
      // (и, если человек не в круге, привести в круг) или отправить молча.
      if (response.status === 409 && result?.error?.code === "join_needed") { kc.share = { chat: key, body, people: result.people || [], join: true }; renderCircles(); return; }
      if (!response.ok) throw new Error(result?.error?.message || t("Сообщение не ушло"));
      kcEdited();
      if (kc.chat === key && !chatState.messages.some((message) => message.id === result.message.id)) chatState.messages = [...chatState.messages, result.message];
      const room = chatState.rooms.find((entry) => entry.id === item.room.id);
      if (result.room && room) Object.assign(room, result.room, { unread: 0 });
      if (result.called?.length) toast(t("Позвали: {value1}", { value1: result.called.map((person) => person.name).join(", ") }));
      // Позвали того, кого здесь не было, — состав разговора и круга изменился.
      if (share === "yes") loadCircles();
    } else {
      const response = await fetch(`/api/captures/${item.talk.captureId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, ...(replyId ? { parentId: replyId } : {}), ...(share ? { share } : {}) }) });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { location.replace("/login"); return; }
      // Позвать того, кто запись ещё не видит, — значит поделиться ею: над
      // полем встаёт выбор, молча журнал не открывается никому.
      if (response.status === 409 && data?.error?.code === "share_needed") { kc.share = { chat: key, body, people: data.people || [] }; renderCircles(); return; }
      if (!response.ok) throw new Error(data?.error?.message || t("Сообщение не ушло"));
      kcEdited();
      if (kc.talk?.captureId === item.talk.captureId) {
        if (!kc.talk.comments.some((comment) => comment.id === data.comment.id)) kc.talk.comments = kcTalkItems([...kc.talk.comments, data.comment]);
        kc.talk.participants = data.participants || kc.talk.participants;
      }
      const talk = (circlesState.discussions || []).find((entry) => entry.captureId === item.talk.captureId) || item.talk;
      talk.last = { body: data.comment.body.slice(0, 160), at: data.comment.createdAt, author: data.comment.author };
      if (data.comment.mentions.length) toast(t("Позвали: {value1}", { value1: data.comment.mentions.map((person) => person.name).join(", ") }));
    }
    kc.share = null;
    kc.reply = null;
    kc.newFrom = null;
    chatState.drafts[key] = "";
    kc.focusField = true;
    renderCircles({ toBottom: true });
  } catch (error) {
    toast(error.message || t("Сообщение не ушло"));
    if (send) send.disabled = false;
  }
}

// ── меню сообщения и разговора ──
function kcCtxOpen(id, x, y) {
  const pane = $("#circles-body .kc-chat-pane");
  if (!pane) return;
  const box = pane.getBoundingClientRect();
  kc.ctx = { id, x: Math.round(Math.max(8, Math.min(x - box.left, box.width - 250))), y: Math.round(Math.max(8, Math.min(y - box.top, box.height - 270))) };
  kc.menu = false;
  renderCircles();
}
function kcMenuRow(icon, label, run, { danger = false } = {}) {
  return kcButton(`kc-menu-item${danger ? " danger" : ""}`, [kcIcon(icon), label], () => { kc.ctx = null; kc.menu = false; run(); }, { role: "menuitem" });
}
function kcContextMenu(item) {
  const message = kcFindMessage(item, kc.ctx.id);
  if (!message || message.kind === "deed") return null;
  const mine = message.author?.id === currentUser?.id;
  const menu = kcEl("div", "kc-menu kc-ctx");
  menu.setAttribute("role", "menu");
  menu.style.left = `${kc.ctx.x}px`;
  menu.style.top = `${kc.ctx.y}px`;
  menu.append(kcEl("div", "kc-ctx-reacts", KC_REACTIONS.map((emoji) => kcButton(`kc-ctx-react${(message.reactions || []).some((reaction) => reaction.emoji === emoji && reaction.mine) ? " on" : ""}`, emoji, () => kcReact(message, emoji), { "aria-label": t("Реакция {emoji}", { emoji: emoji }) }))));
  menu.append(
    kcMenuRow("reply", t("Ответить"), () => kcReplyTo(message)),
    kcMenuRow("deed", t("В дело"), () => { location.hash = "#today"; prefillCapture(message.body.replace(/@[\p{L}\p{N}_-]+/gu, "").trim(), "todo"); }),
    kcMenuRow("copy", t("Скопировать текст"), async () => {
      try { await navigator.clipboard.writeText(message.body); toast(t("Текст скопирован")); } catch { toast(t("Скопировать не получилось")); }
      renderCircles();
    }));
  if (item.kind === "room") {
    const pinned = item.room.pinned?.id === message.id;
    menu.append(kcMenuRow("pin", pinned ? t("Открепить") : t("Закрепить"), () => kcPin(item, pinned ? null : message.id)));
    if (mine) menu.append(kcMenuRow("trash", t("Убрать"), () => kcRemove(item, message), { danger: true }));
  }
  return menu;
}
function kcHeadMenu(item) {
  const menu = kcEl("div", "kc-menu kc-head-menu");
  menu.setAttribute("role", "menu");
  menu.append(kcMenuRow("people", t("Информация"), () => kcInfoOpen("main")));
  if (item.kind === "room") {
    const circle = item.circle;
    const subset = item.room.kind === "room" && !item.room.everyone;
    if (subset) menu.append(kcMenuRow("personAdd", t("Позвать в комнату"), () => kcInfoOpen("roomadd")));
    if (circle.members.length > 1) menu.append(kcMenuRow("plus", t("Новый разговор"), () => kcModalOpen("room", { circleId: circle.id })));
    menu.append(kcMenuRow("muted", circle.muted ? t("Снова показывать в дне") : t("Не показывать в дне"), () => toggleCircleMute(circle.id, !circle.muted)));
    menu.append(kcMenuRow("bound", t("Граница круга"), () => kcInfoOpen("bound")));
    if (subset) menu.append(kcMenuRow("exit", t("Выйти из комнаты"), () => kcLeaveRoom(item.room), { danger: true }));
    menu.append(circle.role === "owner" ? kcMenuRow("exit", t("Распустить круг"), () => kcDissolve(circle), { danger: true }) : kcMenuRow("exit", t("Покинуть круг"), () => kcLeaveCircle(circle), { danger: true }));
  } else {
    menu.append(kcMenuRow("doc", t("Открыть карточку"), () => openSharedCard(item.talk.captureId, { talk: true })));
    if (!item.talk.mine && (kc.talk?.participants || []).some((person) => person.id === currentUser?.id)) menu.append(kcMenuRow("exit", t("Не следить"), () => kcUnfollow(item), { danger: true }));
  }
  return menu;
}
async function kcReact(message, emoji) {
  kc.ctx = null;
  const item = kcCurrent();
  if (!item) return;
  const url = item.kind === "room" ? `/api/rooms/${item.room.id}/messages/${message.id}/reactions` : `/api/captures/${item.talk.captureId}/comments/${message.id}/reactions`;
  try {
    const result = await request(url, { method: "POST", body: JSON.stringify({ emoji }) });
    kcEdited();
    const current = kcCurrent();
    const target = (current && kcFindMessage(current, message.id)) || message;
    target.reactions = result.reactions;
  } catch (error) { toast(error.message || t("Реакция не встала")); }
  renderCircles();
}
async function kcPin(item, messageId) {
  try {
    const result = await request(`/api/rooms/${item.room.id}/pin`, { method: "POST", body: JSON.stringify(messageId ? { messageId } : {}) });
    kcEdited();
    Object.assign(chatState.rooms.find((entry) => entry.id === item.room.id) || item.room, result.room, { unread: 0 });
    toast(messageId ? t("Сообщение закреплено — его видят все в разговоре") : t("Сообщение откреплено"));
  } catch (error) { toast(error.message || t("Не получилось")); }
  renderCircles();
}
async function kcRemove(item, message) {
  try {
    await request(`/api/rooms/${item.room.id}/messages/${message.id}`, { method: "DELETE" });
    kcEdited();
    chatState.messages = chatState.messages.filter((entry) => entry.id !== message.id);
    const room = chatState.rooms.find((entry) => entry.id === item.room.id) || item.room;
    if (room.pinned?.id === message.id) room.pinned = null;
    toast(t("Сообщение убрано"));
  } catch (error) { toast(error.message || t("Не получилось")); }
  renderCircles();
}
async function kcRespond(deed, take) {
  const reason = take ? "" : (prompt(t("Почему не вы? Можно не отвечать — причина уйдёт автору.")) ?? "").trim();
  try {
    await request(`/api/assignments/${deed.assignmentId}/respond`, { method: "POST", body: JSON.stringify({ take, ...(reason ? { reason } : {}) }) });
    kcEdited();
    toast(take ? t("Взято — дело в вашем дне") : t("Вернули автору"));
    await refreshRoomsQuietly();
    load().catch(() => {});
  } catch (error) { toast(error.message || t("Не получилось ответить")); }
}
async function kcLeaveRoom(room) {
  if (!confirm(t("Выйти из комнаты «{name}»? Она пропадёт из списка, а разговор останется у остальных.", { name: room.name }))) return;
  try {
    await request(`/api/rooms/${room.id}/leave`, { method: "POST", body: JSON.stringify({}) });
    const general = chatState.rooms.find((item) => item.circleId === room.circleId && item.kind === "general");
    kc.chat = general ? `room:${general.id}` : null;
    kc.info = null;
    await loadCircles();
  } catch (error) { toast(error.message || t("Не получилось")); }
}
async function kcDissolve(circle) {
  if (!confirm(t("Распустить круг «{name}»? Записи останутся у авторов, но из круга уйдут, а неотвеченные просьбы снимутся.", { name: circle.name }))) return;
  try {
    await request(`/api/circles/${circle.id}`, { method: "DELETE" });
    kc.chat = null;
    kc.info = null;
    await loadCircles();
    await load();
    toast(t("Круг «{name}» распущен", { name: circle.name }));
  } catch (error) { toast(error.message || t("Не получилось")); }
}
async function kcLeaveCircle(circle) {
  if (!confirm(t("Покинуть круг «{name}»? Взятые дела останутся у вас — вы их взяли.", { name: circle.name }))) return;
  try {
    await request(`/api/circles/${circle.id}/leave`, { method: "POST", body: JSON.stringify({}) });
    kc.chat = null;
    kc.info = null;
    await loadCircles();
    await load();
    toast(t("Вы вышли из круга"));
  } catch (error) { toast(error.message || t("Не получилось")); }
}
async function kcUnfollow(item) {
  try {
    await request(`/api/captures/${item.talk.captureId}/people/${currentUser.id}`, { method: "DELETE" });
    toast(t("Запись убрана у вас: новый призыв вернёт её"));
    kc.chat = null;
    kc.info = null;
    await loadCircles();
    load().catch(() => {});
  } catch (error) { toast(error.message || t("Не получилось")); }
}

// ── «Информация»: люди, ссылка и граница круга ──
function kcInfoOpen(view, personId = null) {
  if (!kc.info) kc.fresh = true;
  kc.info = view;
  if (personId) kc.person = personId;
  // «Позвать» всякий раз ищет заново: кто-то мог войти в круг по ссылке.
  if (view === "invite") { kc.invite = null; const context = kcContext(); if (context?.circle) kcInviteFor(context.circle); }
  kc.menu = false;
  kc.talks = false;
  kc.ctx = null;
  renderCircles();
}
function kcInfoClose() {
  kc.info = null;
  renderCircles();
}
function kcInfo(item) {
  const aside = kcEl("aside", "kc-info");
  bindTranslation(aside, "Информация", "aria-label");
  const head = (title, back = false) => kcEl("div", "kc-info-head",
    back ? kcButton("kc-icon", kcIcon("back"), () => { kc.info = "main"; renderCircles(); }, { get "aria-label"() { return t("Назад"); } }) : null,
    kcEl("h3", null, title),
    kcButton("kc-icon", kcIcon("close"), kcInfoClose, { get "aria-label"() { return t("Закрыть"); } }));
  const body = kcEl("div", "kc-info-body");
  if (item.kind === "talk") {
    aside.append(head(t("Информация")), body);
    kcTalkInfo(body, item);
    return aside;
  }
  const circle = item.circle;
  const member = kc.info === "person" ? circle.members.find((person) => person.id === kc.person) : null;
  if (kc.info === "invite") { aside.append(head(t("Позвать в «{name}»", { name: circle.name }), true), body); body.append(kcInviteEl(circle)); }
  else if (kc.info === "bound") { aside.append(head(t("Граница круга"), true), body); body.append(kcBoundEl()); }
  else if (member) { aside.append(head(member.name, true), body); body.append(kcPersonEl(item, member)); }
  else if (kc.info === "roomadd" && item.room.kind === "room") { aside.append(head(t("Позвать в «{name}»", { name: item.room.name }), true), body); body.append(kcRoomAddEl(item)); }
  else { aside.append(head(t("Информация")), body); body.append(...kcCircleInfo(item)); }
  return aside;
}
function kcRow(icon, title, sub, onClick, { accent = false, danger = false, side = null } = {}) {
  return kcButton(`kc-row${accent ? " accent" : ""}${danger ? " danger" : ""}`, [kcIcon(icon), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", title), sub ? kcEl("span", "kc-row-sub", sub) : null), side], onClick);
}
function kcCircleInfo(item) {
  const circle = item.circle;
  const people = circle.members.length;
  const open = circle.members.reduce((sum, member) => sum + (member.openDeeds || 0), 0);
  const profile = kcEl("div", `kc-profile ${kcTone(circle.color)}`,
    kcCircleSeal(circle, "big"),
    kcEl("b", null, circle.name),
    kcEl("small", null, `${people} ${pluralRu(people, t("участник"), t("участника"), t("участников"))} · ${open ? `${open} ${pluralRu(open, t("открытое дело"), t("открытых дела"), t("открытых дел"))}` : t("дел нет")}`));
  const fresh = circlesState.links?.get(circle.id);
  const invite = circle.invite && !circle.invite.expired ? circle.invite : null;
  const link = kcRow("link", fresh ? kcEl("code", null, fresh) : invite ? t("Ссылка-приглашение") : t("Завести ссылку-приглашение"),
    invite ? t("живёт до {value1} · вошли по ней: {uses}", { value1: reportDateLabel(invite.expiresAt.slice(0, 10), { day: "numeric", month: "short" }), uses: invite.uses }) : t("одна на круг, 7 дней, для любого числа людей"),
    () => (fresh ? kcCopyLink(fresh) : kcInfoOpen("invite")), { side: fresh ? kcIcon("copy") : kcIcon("chev") });
  // «Показывать в дне» — личное и обратимое: остальные ничего не замечают.
  const show = kcEl("label", "kc-row kc-switch", kcIcon("bell"), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", t("Показывать в дне")), kcEl("span", "kc-row-sub", t("на доске и в календаре — только у вас"))));
  const box = kcEl("input");
  box.type = "checkbox";
  box.id = `kc-show-${circle.id}`;
  box.checked = !circle.muted;
  box.addEventListener("change", () => toggleCircleMute(circle.id, !box.checked));
  show.append(box, kcEl("span", "kc-track"));
  // Фото ставит и убирает хозяин — как имя и цвет круга.
  const photo = circle.role !== "owner" ? [] : [
    kcRow("camera", circle.photo ? t("Сменить фото") : t("Поставить фото"), t("вместо буквы на знаке круга — видят все в круге"), () => kcPickPhoto((image) => kcSaveCirclePhoto(circle, image))),
    circle.photo ? kcRow("trash", t("Убрать фото"), t("на знаке снова будет буква"), () => kcRemoveCirclePhoto(circle)) : null,
  ];
  const settings = kcEl("div", "kc-sect", link, show, kcRow("bound", t("Граница круга"), t("что видят участники"), () => kcInfoOpen("bound"), { side: kcIcon("chev") }), photo);
  const members = kcEl("div", "kc-sect", kcEl("p", "kc-sect-cap", `${people} ${pluralRu(people, t("участник"), t("участника"), t("участников"))}`), kcRow("personAdd", t("Позвать людей"), null, () => kcInfoOpen("invite"), { accent: true }));
  for (const member of circle.members) {
    const deeds = member.openDeeds || 0;
    members.append(kcButton("kc-row kc-person", [avatarEl(member), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", member.id === currentUser?.id ? t("{name} · вы", { name: member.name }) : member.name), kcEl("span", "kc-row-sub", deeds ? `${deeds} ${pluralRu(deeds, t("открытое дело"), t("открытых дела"), t("открытых дел"))}` : t("открытых дел нет"))), member.role === "owner" ? kcEl("span", "kc-row-side", t("хозяин")) : null], () => kcInfoOpen("person", member.id)));
  }
  const leave = kcEl("div", "kc-sect", circle.role === "owner"
    ? kcRow("exit", t("Распустить круг"), null, () => kcDissolve(circle), { danger: true })
    : kcRow("exit", t("Покинуть круг"), null, () => kcLeaveCircle(circle), { danger: true }));
  return [profile, settings, members, leave];
}
// Фото круга. Картинку ужимает браузер тем же квадратом 256 px, что и лицо
// человека (squareAvatar). Поле выбора файла одно на страницу и живёт вне
// перерисовок: страница кругов перестраивается целиком на каждое событие.
function kcPickPhoto(onImage) {
  let input = $("#kc-photo-file");
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.id = "kc-photo-file";
    input.accept = "image/png,image/jpeg,image/webp,image/*";
    input.hidden = true;
    document.body.append(input);
  }
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try { await onImage(await squareAvatar(file)); }
    catch (error) { toast(error instanceof DOMException ? t("Это не похоже на картинку") : error.message || t("Фото не поставилось")); }
  };
  input.click();
}
async function kcUploadCirclePhoto(circleId, image) {
  const response = await fetch(`/api/circles/${encodeURIComponent(circleId)}/photo`, { method: "POST", headers: { "Content-Type": image.type }, body: image });
  if (response.status === 401) { location.replace("/login"); return null; }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || t("Фото не поставилось"));
  return result.circle;
}
function kcPutCircle(circle) {
  kcEdited();
  circlesState.circles = circlesState.circles.map((entry) => (entry.id === circle.id ? { ...entry, ...circle } : entry));
  renderCircles();
}
async function kcSaveCirclePhoto(circle, image) {
  const saved = await kcUploadCirclePhoto(circle.id, image);
  if (!saved) return;
  kcPutCircle(saved);
  toast(t("Фото круга поставлено"));
}
async function kcRemoveCirclePhoto(circle) {
  try {
    const result = await request(`/api/circles/${encodeURIComponent(circle.id)}/photo`, { method: "DELETE" });
    kcPutCircle(result.circle);
    toast(t("На знаке круга снова буква"));
  } catch (error) { toast(error.message || t("Фото не убралось")); }
}
async function kcCopyLink(url) {
  try { await navigator.clipboard.writeText(url); toast(t("Ссылка скопирована — передайте её сами: писем приложение не шлёт")); }
  catch { toast(t("Скопируйте ссылку вручную")); }
}
// Ссылка у круга одна и работает для многих. Показывается она один раз — сам
// токен на сервере не хранится; забыли — обновите, прежняя сразу перестанет
// работать. Свежая держится в памяти страницы: перерисовка её не теряет.
async function kcMakeLink(circle) {
  const refresh = Boolean(circle.invite && !circle.invite.expired);
  try {
    const invite = await request(`/api/circles/${circle.id}/invite`, { method: "POST", body: JSON.stringify({}) });
    (circlesState.links ||= new Map()).set(circle.id, invite.url);
    circle.invite = { createdAt: new Date().toISOString(), expiresAt: invite.expiresAt, uses: 0, expired: false };
    toast(refresh ? t("Новая ссылка готова, прежняя больше не работает") : t("Ссылка заведена — она видна только сейчас"));
  } catch (error) { toast(error.message || t("Приглашение не создалось")); }
  renderCircles();
}
// Ответы на поиск приходят в любом порядке: список меняется только ответом на
// последний запрос.
let kcSearchTurn = 0, kcSearchTimer = 0;
// Поиск помнит, для какого он круга: у другого круга свои кандидаты. Он же
// нужен и «Позвать» в «Информации», и кругу из одного — прямо в разговоре.
function kcInviteFor(circle) {
  if (kc.invite?.circleId === circle.id) return kc.invite;
  kc.invite = { circleId: circle.id, query: "", people: null, all: true };
  setTimeout(kcSearchPeople, 0);
  return kc.invite;
}
async function kcSearchPeople() {
  const state = kc.invite;
  if (!state?.circleId) return;
  const turn = ++kcSearchTurn;
  try {
    const data = await request(`/api/circles/${state.circleId}/candidates?q=${encodeURIComponent(state.query.trim())}`);
    if (turn !== kcSearchTurn || kc.invite !== state) return;
    state.people = data.people || [];
    state.all = Boolean(data.all);
  } catch (error) {
    if (turn !== kcSearchTurn || kc.invite !== state) return;
    state.people = [];
    state.error = error.message || t("Поиск не удался");
  }
  renderCircles();
}
function kcInviteEl(circle) {
  const wrap = kcEl("div", "kc-sub");
  const state = kcInviteFor(circle);
  const search = kcEl("label", "kc-search", kcIcon("search"));
  const input = kcEl("input");
  input.id = "kc-invite-q";
  input.type = "search";
  bindTranslation(input, "Имя или почта", "placeholder");
  input.value = state.query;
  bindTranslation(input, "Найти человека для круга «{name}»", { name: circle.name }, "aria-label");
  input.addEventListener("input", () => { state.query = input.value; clearTimeout(kcSearchTimer); kcSearchTimer = setTimeout(kcSearchPeople, 220); });
  search.append(input);
  const found = kcEl("div", "kc-people");
  if (state.people === null) found.append(kcEl("p", "kc-hint", t("Ищу…")));
  else if (!state.people.length) found.append(kcEl("p", "kc-hint", state.error || (state.all ? t("Никого не нашлось. Если человека ещё нет в Кизуне — дайте ему ссылку ниже.") : t("В круге уже все, кто есть в Кизуне. Нового человека зовите ссылкой ниже."))));
  for (const person of state.people || []) {
    found.append(kcButton("kc-row kc-person", [avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.name), kcEl("span", "kc-row-sub", person.email)), kcEl("span", "kc-row-side accent", t("Позвать"))], async (event) => {
      event.currentTarget.disabled = true;
      try {
        await request(`/api/circles/${circle.id}/members`, { method: "POST", body: JSON.stringify({ userId: person.id }) });
        toast(t("{name} в круге «{name2}» — узнает строкой «к вам»", { name: person.name, name2: circle.name }));
        state.people = state.people.filter((entry) => entry.id !== person.id);
        await loadCircles({ then: () => (kc.chat ? kcOpen(kc.chat) : renderCircles()) });
      } catch (error) { toast(error.message || t("Не получилось добавить")); }
    }));
  }
  const fresh = circlesState.links?.get(circle.id);
  const invite = circle.invite && !circle.invite.expired ? circle.invite : null;
  const card = kcEl("div", `kc-linkcard ${kcTone(circle.color)}`,
    kcEl("div", "kc-linkrow",
      kcEl("code", fresh ? null : "masked", fresh || "kizuna.app/#join/••••••••••"),
      fresh ? kcButton("kc-btn sm primary", [kcIcon("copy"), t("Скопировать")], () => kcCopyLink(fresh)) : kcButton(`kc-btn sm${invite ? "" : " primary"}`, invite ? t("Обновить") : t("Завести ссылку"), () => kcMakeLink(circle))),
    fresh ? kcEl("p", "kc-hint", t("Ссылка видна только сейчас — сохраните её.")) : null,
    kcEl("p", "kc-hint", invite ? t("Живёт до {value1} · вошли по ней: {uses}", { value1: reportDateLabel(invite.expiresAt.slice(0, 10), { day: "numeric", month: "long" }), uses: invite.uses }) : t("Одна на круг · 7 дней · для любого числа людей")));
  wrap.append(kcEl("p", "kc-sect-cap", t("Из Кизуны")), search, found, kcEl("p", "kc-hint", t("Позванный узнает строкой «к вам» и может выйти в одно нажатие.")), kcEl("p", "kc-sect-cap", t("Ещё нет в Кизуне")), card);
  return wrap;
}
function kcBoundEl() {
  return kcEl("div", "kc-sub",
    kcEl("div", "kc-bound",
      kcEl("div", "kc-bound-in", kcEl("h4", null, kcIcon("eye"), t("Видит круг")), kcEl("ul", null,
        kcEl("li", null, kcEl("b", null, t("Записи с исполнителем")), t(" из круга")),
        kcEl("li", null, kcEl("b", null, t("Записи, где позвали")), t(" участника")),
        kcEl("li", null, kcEl("b", null, t("Разговоры")), t(" круга и комнат")))),
      kcEl("div", "kc-bound-out", kcEl("h4", null, kcIcon("lock"), t("Остаётся вашим")), kcEl("ul", null,
        kcEl("li", null, t("День, заметки, «Сделано»")),
        kcEl("li", null, t("Память помощника")),
        kcEl("li", null, t("Всё, что не отдали в круг"))))),
    kcEl("p", "kc-hint", kcEl("b", null, t("Правит запись автор")), t(", исполнитель закрывает дело и пишет в обсуждение. "), kcEl("b", null, t("Разбор моделью")), t(" считается тому, кто записал.")));
}
function kcPersonEl(item, member) {
  const circle = item.circle;
  const me = member.id === currentUser?.id;
  const since = member.joinedAt ? reportDateLabel(zoneDate(new Date(member.joinedAt)), { day: "numeric", month: "long" }) : null;
  const today = currentDayDate || zoneDate(new Date());
  const deeds = member.deeds || [];
  const list = kcEl("div", "kc-deeds");
  if (!deeds.length) list.append(kcEl("p", "kc-hint", t("Открытых дел в этом круге нет.")));
  for (const deed of deeds) {
    const late = deed.due?.date && deed.due.date < today;
    list.append(kcButton("kc-deed-row", [kcIcon("todo"), kcEl("span", "kc-deed-row-title", deed.title), kcEl("small", late ? "late" : null, late ? t("просрочено") : deed.due?.date ? kcDue(deed.due) : deed.state === "pending" ? t("ждёт ответа") : "")], () => openSharedCard(deed.captureId)));
  }
  const more = (member.openDeeds || 0) - deeds.length;
  const acts = me ? null : kcEl("div", "kc-person-acts",
    kcButton("kc-btn sm tone", t("@ Позвать в разговоре"), () => { kcInfoClose(); kcInsertCall(member.name); }));
  const avatar = avatarEl(member);
  avatar.classList.add("huge");
  return kcEl("div", `kc-sub ${kcTone(circle.color)}`,
    kcEl("div", "kc-person-head", avatar, kcEl("div", null, kcEl("b", null, me ? t("{name} · вы", { name: member.name }) : member.name), kcEl("small", null, `${member.role === "owner" ? t("хозяин круга") : t("участник")}${since ? t(" · в круге с {since}", { since: since }) : ""}`))),
    kcEl("p", "kc-sect-cap", t("Дела в этом круге · {value1}", { value1: member.openDeeds || 0 })),
    me ? null : kcDeedForm(circle, member),
    list,
    more > 0 ? kcEl("p", "kc-hint", t("и ещё {more} — на доске", { more: more })) : null,
    acts);
}

// Поручить дело, не уходя из круга: строка у человека — это запись в вашем
// журнале и просьба ему. Срок пишется словами внутри — разбирает его та же
// модель, что и обычную запись.
function kcDeedForm(circle, member) {
  const form = kcEl("form", "kc-deed-new");
  const field = kcEl("input");
  field.id = "kc-deed-field";
  field.type = "text";
  bindTranslation(field, "Что поручить", "placeholder");
  bindTranslation(field, "Дело для {name}", { name: member.name }, "aria-label");
  // Страницу перестраивает любое событие журнала (в том числе «поток жив» сразу
  // после открытия), а поле рождается заново пустым: без черновика обновление в
  // фоне стирало набранное под пальцами.
  const draftKey = `${circle.id}:${member.id}`;
  field.dataset.draft = draftKey;
  field.value = kc.deedDrafts[draftKey] || "";
  field.addEventListener("input", () => { kc.deedDrafts[draftKey] = field.value; });
  const send = kcEl("button", "kc-btn sm primary", t("Отдать"));
  send.type = "submit";
  form.append(field, send);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = field.value.trim();
    if (!raw || send.disabled) return;
    send.disabled = true;
    bindTranslation(send, "Отдаю…");
    // Уходит: страница, перестроенная посреди запроса, не должна вернуть его в поле.
    kc.deedDrafts[draftKey] = "";
    try {
      const created = await request("/api/captures", { method: "POST", body: JSON.stringify({ raw, primaryType: "todo" }) });
      await request(`/api/captures/${created.entry.id}/assign`, { method: "POST", body: JSON.stringify({ assigneeId: member.id, circleId: circle.id }) });
      if (!kc.deedDrafts[draftKey]) field.value = "";
      toast(t("Просьба ушла: {name} ответит «беру» или «не я»", { name: member.name }));
      kc.deedFocus = true;
      loadCircles();
      load();
    } catch (error) {
      // Не ушло: набранное остаётся в черновике и в поле — в том, что успели
      // перестроить, если оно всё ещё у этого человека.
      if (!kc.deedDrafts[draftKey]) {
        kc.deedDrafts[draftKey] = raw;
        const live = document.getElementById("kc-deed-field");
        if (live?.dataset.draft === draftKey && !live.value) live.value = raw;
      }
      toast(error.message || t("Дело не ушло"));
    } finally {
      send.disabled = false;
      bindTranslation(send, "Отдать");
    }
  });
  return kcEl("div", "kc-deed-add", form, kcEl("p", "kc-hint", t("Срок называйте словами: «прислать смету до пятницы».")));
}
function kcRoomAddEl(item) {
  const inRoom = new Set(item.room.members.map((person) => person.id));
  const rest = item.circle.members.filter((person) => !inRoom.has(person.id));
  const wrap = kcEl("div", "kc-sub", kcEl("p", "kc-hint", t("Комнату видят только те, кто в ней. Позвать можно людей круга «{name}».", { name: item.circle.name })));
  const people = kcEl("div", "kc-people");
  if (!rest.length) people.append(kcEl("p", "kc-hint", t("В комнате уже весь круг.")));
  for (const person of rest) {
    people.append(kcButton("kc-row kc-person", [avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.name), kcEl("span", "kc-row-sub", person.email)), kcEl("span", "kc-row-side accent", t("Позвать"))], async (event) => {
      event.currentTarget.disabled = true;
      try {
        await request(`/api/rooms/${item.room.id}/members`, { method: "POST", body: JSON.stringify({ userId: person.id }) });
        toast(t("{name} в комнате «{name2}»", { name: person.name, name2: item.room.name }));
        await loadCircles({ then: () => (kc.chat ? kcOpen(kc.chat) : renderCircles()) });
      } catch (error) { toast(error.message || t("Не получилось")); }
    }));
  }
  wrap.append(people);
  return wrap;
}
function kcTalkInfo(body, item) {
  const talk = item.talk;
  const kind = KC_KIND[talk.kind] ? talk.kind : "note";
  const people = kcTalkPeople(item);
  const seal = kcSeal(kcIcon(kind), `tone-${KC_KIND[kind][0]}`, "round big");
  body.append(kcEl("div", `kc-profile tone-${KC_KIND[kind][0]}`, seal, kcEl("b", null, talk.title), kcEl("small", null, t("обсуждение записи · {length} {value2}", { length: people.length, value2: pluralRu(people.length, t("участник"), t("участника"), t("участников")) }))));
  body.append(kcEl("div", "kc-sect", kcRow("doc", t("Открыть карточку записи"), null, () => openSharedCard(talk.captureId, { talk: true }), { accent: true })));
  const list = kcEl("div", "kc-sect", kcEl("p", "kc-sect-cap", `${people.length} ${pluralRu(people.length, t("участник"), t("участника"), t("участников"))}`));
  for (const person of people) {
    const role = person.id === talk.author?.id ? t("автор") : (kc.talk?.participants || []).some((entry) => entry.id === person.id) ? t("позван") : t("из круга");
    list.append(kcEl("div", "kc-row kc-person", avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.id === currentUser?.id ? t("{name} · вы", { name: person.name }) : person.name), kcEl("span", "kc-row-sub", person.email || "")), kcEl("span", "kc-row-side", role)));
  }
  body.append(list);
  body.append(kcEl("p", "kc-hint kc-pad", t("Позвать ещё — напишите @имя в сообщении.")));
  if (!talk.mine && (kc.talk?.participants || []).some((person) => person.id === currentUser?.id))
    body.append(kcEl("div", "kc-sect", kcRow("exit", t("Не следить"), t("запись уйдёт из ваших «Обсуждений»"), () => kcUnfollow(item), { danger: true })));
}

// ── новый круг и новая комната ──
function kcModalOpen(kind, extra = {}) {
  kc.modal = { kind, name: "", color: "violet", people: [], focus: true, ...extra };
  kc.menu = false;
  kc.ctx = null;
  renderCircles();
}
function kcModal() {
  if (!kc.modal) return null;
  const modal = kc.modal;
  const close = () => { if (modal.photo) URL.revokeObjectURL(modal.photo.url); kc.modal = null; renderCircles(); };
  const scrim = kcEl("div", "kc-scrim");
  scrim.addEventListener("click", close);
  const box = kcEl("form", "kc-modal");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const input = kcEl("input");
  input.id = "kc-modal-name";
  input.type = "text";
  input.maxLength = 40;
  input.value = modal.name;
  input.autocomplete = "off";
  if (modal.kind === "circle") {
    const letter = document.createTextNode(kcInitial(modal.name || t("Круг")));
    // Фото можно поставить сразу, как у новой группы в Телеграме, или потом —
    // в «Информации». Уходит на сервер, когда круг заведён.
    const preview = kcButton("kc-photo-pick", [pictureInto(kcSeal(letter, kcTone(modal.color), "big"), modal.photo?.url), kcEl("span", "kc-photo-badge", kcIcon("camera"))], () => kcPickPhoto((image) => {
      if (kc.modal !== modal) return;
      if (modal.photo) URL.revokeObjectURL(modal.photo.url);
      modal.photo = { image, url: URL.createObjectURL(image) };
      renderCircles();
    }), { get "aria-label"() { return t("Фото круга"); }, title: modal.photo ? t("Сменить фото") : t("Поставить фото") });
    const title = kcEl("b", null, modal.name.trim() || t("Новый круг"));
    bindTranslation(input, "«Дача», «Книжный клуб», «Релиз»", "placeholder");
    bindTranslation(input, "Название круга", "aria-label");
    input.addEventListener("input", () => { modal.name = input.value; letter.textContent = kcInitial(input.value || t("Круг")); title.textContent = input.value.trim() || t("Новый круг"); });
    const tones = kcEl("div", "kc-tones");
    for (const color of Object.keys(CIRCLE_TONES)) {
      tones.append(kcButton(`kc-tone-pick ${kcTone(color)}`, null, () => { modal.color = color; renderCircles(); }, { "aria-pressed": String(modal.color === color), "aria-label": { get violet() { return t("фиолетовый"); }, get blue() { return t("синий"); }, get teal() { return t("бирюзовый"); }, get orange() { return t("янтарный"); }, get pink() { return t("розовый"); }, get red() { return t("коралловый"); } }[color] }));
    }
    box.append(
      kcEl("div", "kc-modal-head", kcEl("h3", null, t("Новый круг"), kcEl("small", null, t("Люди, граница и разговор — больше ничего"))), kcButton("kc-icon", kcIcon("close"), close, { get "aria-label"() { return t("Закрыть"); } })),
      kcEl("div", `kc-modal-preview ${kcTone(modal.color)}`, preview, kcEl("div", null, title, kcEl("small", null, t("людей позовёте следующим шагом")))),
      kcEl("label", "kc-field-label", kcEl("span", null, t("Название")), input),
      kcEl("div", "kc-field-label", kcEl("span", null, t("Цвет")), tones),
      kcEl("div", "kc-modal-acts", kcButton("kc-btn ghost", t("Отмена"), close), kcEl("button", "kc-btn primary", t("Завести круг"))));
    box.lastElementChild.lastElementChild.type = "submit";
    box.addEventListener("submit", (event) => { event.preventDefault(); kcCreateCircle(); });
  } else {
    const circle = circlesState.circles.find((entry) => entry.id === modal.circleId);
    if (!circle) return null;
    // Новый разговор видит весь круг — или только позванные, и тогда это комната.
    const everyone = modal.everyone !== false;
    bindTranslation(input, "«Смета», «Релиз»", "placeholder");
    bindTranslation(input, "Название разговора", "aria-label");
    input.addEventListener("input", () => { modal.name = input.value; });
    const who = kcEl("div", "kc-seg");
    who.setAttribute("role", "radiogroup");
    bindTranslation(who, "Кто видит", "aria-label");
    for (const [value, label] of [[true, t("Весь круг · {length} {value2}", { length: circle.members.length, value2: pluralRu(circle.members.length, t("человек"), t("человека"), t("человек")) })], [false, t("Только позванные")]])
      who.append(kcButton("kc-seg-item", label, () => { modal.everyone = value; renderCircles(); }, { role: "radio", "aria-checked": String(everyone === value) }));
    const people = kcEl("div", "kc-people");
    for (const person of circle.members.filter((entry) => entry.id !== currentUser?.id)) {
      const chosen = modal.people.includes(person.id);
      people.append(kcButton("kc-row kc-person kc-pick", [avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.name), kcEl("span", "kc-row-sub", person.email)), kcEl("span", "kc-checkbox", kcIcon("check"))], () => {
        modal.people = chosen ? modal.people.filter((id) => id !== person.id) : [...modal.people, person.id];
        renderCircles();
      }, { "aria-pressed": String(chosen) }));
    }
    box.append(...[
      kcEl("div", "kc-modal-head", kcEl("h3", null, t("Разговор в «{name}»", { name: circle.name }), kcEl("small", null, t("Отдельный разговор в круге — под задачу, событие или тему"))), kcButton("kc-icon", kcIcon("close"), close, { get "aria-label"() { return t("Закрыть"); } })),
      kcEl("label", "kc-field-label", kcEl("span", null, t("Название")), input),
      kcEl("div", "kc-field-label", kcEl("span", null, t("Кто видит")), who),
      everyone ? null : kcEl("div", "kc-field-label", kcEl("span", null, t("Кого позвать")), people),
      kcEl("div", "kc-modal-acts", kcButton("kc-btn ghost", t("Отмена"), close), kcEl("button", "kc-btn primary", t("Завести разговор"))),
    ].filter(Boolean));
    box.lastElementChild.lastElementChild.type = "submit";
    box.addEventListener("submit", (event) => { event.preventDefault(); kcCreateRoom(circle); });
  }
  return kcEl("div", "kc-layer", scrim, box);
}
async function kcCreateCircle() {
  const { name, color } = kc.modal;
  const clean = name.trim();
  if (!clean) { toast(t("Назовите круг — «Дача», «Книжный клуб»")); $("#kc-modal-name")?.focus(); return; }
  try {
    const result = await request("/api/circles", { method: "POST", body: JSON.stringify({ name: clean, color }) });
    const photo = kc.modal?.photo;
    kc.modal = null;
    // Круг уже заведён: не встало фото — круг остаётся, фото ставится в «Информации».
    if (photo) {
      try { await kcUploadCirclePhoto(result.circle.id, photo.image); }
      catch (error) { toast(error.message || t("Фото не поставилось — поставьте его в «Информации»")); }
      finally { URL.revokeObjectURL(photo.url); }
    }
    await loadCircles({ then: async () => {
      const room = chatState.rooms.find((entry) => entry.circleId === result.circle.id && entry.kind === "general");
      if (room) await kcOpen(`room:${room.id}`);
    } });
    load().catch(() => {});
    toast(t("Круг «{clean}» заведён — позовите людей", { clean: clean }));
  } catch (error) { toast(error.message || t("Круг не завёлся")); }
}
async function kcCreateRoom(circle) {
  const { name, people } = kc.modal;
  const everyone = kc.modal.everyone !== false;
  const clean = name.trim();
  if (!clean) { toast(t("Назовите разговор — «Смета», «Релиз»")); $("#kc-modal-name")?.focus(); return; }
  if (!everyone && !people.length) { toast(t("Позовите хотя бы одного человека — или отдайте разговор всему кругу")); return; }
  try {
    const result = await request(`/api/circles/${circle.id}/rooms`, { method: "POST", body: JSON.stringify(everyone ? { name: clean, everyone: true } : { name: clean, members: people }) });
    kc.modal = null;
    await loadCircles({ then: () => kcOpen(`room:${result.room.id}`) });
    toast(everyone ? t("Разговор «{name}» заведён — его видит весь круг", { name: result.room.name }) : t("Комната «{name}» заведена — её видят только позванные", { name: result.room.name }));
  } catch (error) { toast(error.message || t("Разговор не завёлся")); }
}
function kcEmptyPage() {
  const page = kcEl("div", "kc kc-empty-page",
    kcEl("div", "kc-empty-card",
      kcSeal(kcIcon("people"), "tone-violet", "round big"),
      kcEl("h3", null, t("Кругов пока нет")),
      kcEl("p", null, t("Круг — это люди, граница и разговор. Заведите первый и позовите того, с кем есть общее дело. Обсуждения записей тоже появятся здесь.")),
      kcButton("kc-btn primary", [kcIcon("plus"), t("Завести круг")], () => kcModalOpen("circle"))));
  const modal = kcModal();
  if (modal) page.append(modal);
  return page;
}

// Меню закрывается щелчком мимо и клавишей Escape, как любое всплывающее.
document.addEventListener("click", (event) => {
  if (!kc.ctx && !kc.menu && !kc.talks) return;
  if ($("#circles")?.hidden) { kc.ctx = null; kc.menu = false; kc.talks = false; return; }
  if (event.target.closest(".kc-menu, [data-kc-menu]")) return;
  kc.ctx = null;
  kc.menu = false;
  kc.talks = false;
  renderCircles();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("#circles")?.hidden) return;
  if (kc.ctx || kc.menu || kc.talks) { kc.ctx = null; kc.menu = false; kc.talks = false; renderCircles(); }
  else if (kc.modal) { kc.modal = null; renderCircles(); }
  else if (kc.info && !event.target.closest?.("textarea, input")) kcInfoClose();
});

// Приглашение по ссылке: человек видит, кто зовёт и во что, ещё до согласия —
// иначе он нажимает «войти» вслепую. Карточка держится в состоянии страницы:
// круги грузятся параллельно и перерисовали бы её пустым списком.
async function openInvite(token) {
  history.replaceState(null, "", "#circles");
  updatePageFromHash();
  let peek;
  try { peek = await request(`/api/circles/invite/${encodeURIComponent(token)}`); }
  catch (error) { toast(error.message || t("Приглашение не найдено")); return; }
  kc.joining = { token, peek };
  renderCircles();
}
function kcInviteCard() {
  const { token, peek } = kc.joining;
  const card = node("section", undefined, "circle-card invite-card");
  const name = node("h3", undefined, "circle-name");
  name.append(node("i", undefined, `circle-dot big ${CIRCLE_TONES[peek.circle.color] || "violet"}`), node("span", peek.circle.name));
  card.append(name);
  card.append(bindTranslation(node("p", t("{invitedBy} зовёт вас в круг «{name}». Сейчас там {members} {value4}.", { invitedBy: peek.invitedBy, name: peek.circle.name, members: peek.members, value4: pluralRu(peek.members, t("человек"), t("человека"), t("человек")) }), "invite-lead"), "{invitedBy} зовёт вас в круг «{name}». Сейчас там {members} {value4}.", { invitedBy: peek.invitedBy, name: peek.circle.name, members: peek.members, value4: pluralRu(peek.members, t("человек"), t("человека"), t("человек")) }));
  card.append(bindTranslation(node("p", t("Участники круга увидят записи, которыми вы поделитесь. Ваш журнал, заметки и память помощника остаются личными."), "invite-hint"), "Участники круга увидят записи, которыми вы поделитесь. Ваш журнал, заметки и память помощника остаются личными."));
  const accept = bindTranslation(node("button", t("Войти в круг"), "mini primary"), "Войти в круг");
  accept.type = "button";
  accept.addEventListener("click", async () => {
    accept.disabled = true;
    try {
      const result = await request(`/api/circles/invite/${encodeURIComponent(token)}/accept`, { method: "POST", body: JSON.stringify({}) });
      kc.joining = null;
      toast(t("Вы в круге «{name}»", { name: peek.circle.name }));
      await loadCircles({ then: async () => {
        const room = chatState.rooms.find((item) => item.circleId === (result.circle?.id || peek.circle.id) && item.kind === "general");
        if (room) await kcOpen(`room:${room.id}`);
      } });
      await load();
    } catch (error) { toast(error.message || t("Не получилось войти")); accept.disabled = false; }
  });
  const skip = bindTranslation(node("button", t("Не сейчас"), "mini"), "Не сейчас");
  skip.type = "button";
  skip.addEventListener("click", () => { kc.joining = null; loadCircles(); });
  const acts = node("div", undefined, "circle-tools");
  acts.append(accept, skip);
  card.append(acts);
  return node("div", undefined, "kc-joining").appendChild(card).parentNode;
}
async function completeBoardCard(card, element, button) {
  // Повтор: «готово» убирает ближайший экземпляр, серия остаётся на доске.
  if (card.due?.repeat) {
    if (button) button.disabled = true;
    try { await doneOccurrence({ id: card.captureId }, card.due.date); } finally { if (button) button.disabled = false; }
    return;
  }
  if (button) button.disabled = true;
  try {
    for (const projectionId of card.projectionIds)
      await request(`/api/projections/${projectionId}/complete`, { method: "POST", body: "{}" });
    toast(t("Отмечено как готовое"), { get label() { return t("Вернуть"); }, run: async () => {
      try {
        for (const projectionId of card.projectionIds) await request(`/api/projections/${projectionId}/undo-complete`, { method: "POST", body: "{}" });
        toast(t("Возвращено в работу"));
        loadBoard();
        load().catch(() => {});
      } catch (error) { toast(error.message); }
    } });
    element?.remove();
    loadBoard();
    load().catch(() => {});
  } catch (error) {
    toast(error.message);
    if (button) button.disabled = false;
  }
}
// Закрытое дело возвращается в работу тем же кружком: с доски оно ушло, но в
// группе «Закрытые» лежит — иначе закрытое случайно было бы не найти.
async function reopenBoardCard(card, button) {
  button.disabled = true;
  try {
    for (const projectionId of card.projectionIds)
      await request(`/api/projections/${projectionId}/undo-complete`, { method: "POST", body: "{}" });
    toast(t("Возвращено в работу"));
    loadBoard();
    load().catch(() => {});
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
// Когда закрыто: «сегодня 10:12», «вчера 18:20» или дата.
function boardClosedWhen(card) {
  if (!card.closedAt) return "";
  const today = boardState.data?.today || currentDayDate;
  const day = notifyDay(card.closedAt);
  const word = day === today ? t("сегодня") : day === shiftDate(today, -1) ? t("вчера") : `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return `${word} ${notifyClock(card.closedAt)}`;
}
// Кружок «готово»: у открытого дела закрывает его, у закрытого — возвращает в
// работу. Один на карточку доски и строку списка.
function boardDoneButton(card, element, closed) {
  const done = node("button", undefined, `board-done${closed ? " is-done" : ""}${card.type === "meeting_event" && !closed ? " meeting" : ""}`);
  done.type = "button";
  if (card.type === "meeting_event" && !closed) done.innerHTML = BOARD_CLOCK;
  done.title = closed ? t("Вернуть в работу") : t("Готово");
  done.setAttribute("aria-label", `${done.title}: ${card.title}`);
  done.addEventListener("click", (event) => {
    event.stopPropagation();
    if (closed) reopenBoardCard(card, done);
    else completeBoardCard(card, element, done);
  });
  return done;
}
// Открытые дела в порядке показа: по ним карточка листает стрелками, как бы ни
// была разложена доска — колонками или разделами списка.
const boardOpenRows = () => [...$("#board").querySelectorAll(".board-card[data-capture-id]:not(.closed), .board-row[data-capture-id]:not(.closed)")];
// Карточка записи: по названию — с начала, по метке «0/2» — на «Подзадачах».
function openBoardCard(card, element, { subtasks = false } = {}) {
  pendingCardList = { get label() { return t("Доска"); }, items: rowsAsList(boardOpenRows()), id: card.captureId, occurrence: element.dataset.occurrence || null };
  // Подзадач нет среди последних ста записей журнала, где ищет openReportEntry:
  // карточка подзадачи читается по номеру.
  if (card.subtask) { cardOccurrence = null; openCaptureById(card.captureId, { subtasks }); }
  else openReportEntry(card.captureId, { subtasks });
}
// Название — кнопка: открывает карточку записи.
function boardTitleButton(card, element) {
  const title = node("button", card.title.split("\n")[0], "board-title");
  title.type = "button";
  title.addEventListener("click", () => openBoardCard(card, element));
  return title;
}
// «0/2» у дела: метка у полоски прогресса — и в карточке доски, и в строке
// списка. Нажатие открывает карточку дела на «Подзадачах».
const boardSubtaskBadge = (card, element) => subtaskBadge(card.subtasks, () => openBoardCard(card, element, { subtasks: true }));
// Полоска прогресса у дела с подзадачами: под названием тонкая полоска
// (заполненная часть зелёная, дорожка — линия) и та же метка «1/2». Сами
// подзадачи строками внутри карточки не стоят: «Подзадачи: Показывать» выносит
// их на доску отдельными карточками (см. boardParentLabel), «Скрывать» оставляет
// одну полоску с числом — и на доске, и в списке. Данные — subtasks {done, total}
// из /api/board; на «Сегодня» у дела только метка.
// .sub-map → её перерисовка: ответ доски с другими числами обновляет полоску и
// число на месте (boardPatchSubtasks).
const boardSubMaps = new WeakMap();
function boardSubtaskMap(card, element) {
  if (!card.subtasks?.total) return null;
  const map = node("div", undefined, "sub-map");
  const head = node("div", undefined, "sub-progress");
  const track = node("span", undefined, "sub-bar");
  track.setAttribute("aria-hidden", "true");
  const fill = node("i", undefined, "sub-bar-fill");
  track.append(fill);
  const badge = boardSubtaskBadge(card, element);
  head.append(track, badge);
  map.append(head);
  // next — свежие данные с сервера: полоска и число берут их себе.
  const paint = (next = null) => {
    if (next) card.subtasks = next;
    const { done, total } = card.subtasks;
    fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
    paintSubtaskBadge(badge, card.subtasks);
  };
  boardSubMaps.set(map, paint);
  paint();
  return map;
}
// «↳ Родитель» у подзадачи, вставшей на доску своей карточкой: мелкая метка под
// названием, как остальные метки дела, — чьей частью она является.
function boardParentLabel(card) {
  const title = (card.parentTitle || "").split("\n")[0] || t("Без названия");
  const label = node("span", `↳ ${title}`, "btag parent");
  bindTranslation(label, "Подзадача: {title}", { title: title }, "title");
  return label;
}
// Срок одной меткой: «со вчера» у просроченного, дата — если не сегодня, час —
// если он есть.
function boardDueTag(card) {
  const today = boardState.data?.today || currentDayDate;
  const date = card.due?.date || null;
  if (date && date < today) return bindTranslation(node("span", t("со вчера"), "btag due late"), "со вчера");
  if (date && date > today) return node("span", scheduleLabel({ state: "ok", date, time: card.due.time }), "btag due");
  if (card.due?.time) return node("span", card.due.time, "btag due soon");
  return null;
}
// Тихие метки дела: срок, повтор, люди кружками, скрепка.
function boardMetaTags(card) {
  const tags = [];
  const due = boardDueTag(card);
  if (due) tags.push(due);
  if (card.due?.repeat) tags.push(node("span", card.due.repeat, "btag due"));
  for (const person of card.people || []) tags.push(boardPersonEl(person, { avatarOnly: true }));
  if (card.attachments) tags.push(node("span", `📎 ${card.attachments}`, "btag files c-gray"));
  return tags;
}
// Карточка на доске: кружок, название, родитель (у подзадачи), полоска подзадач
// (если они есть) и мелкая строка — час, срок (если он не сегодня) и люди. Закрытая лежит в «Закрыто» и не тянется; не
// тянутся и карточки, когда доска разложена по человеку, проекту или
// источнику: перенос там ничего осмысленного не менял бы.
function boardCardEl(card, { closed = false, draggable = !closed } = {}) {
  const element = node("div", undefined, `board-card${closed ? " closed" : ""}`);
  element.draggable = draggable;
  element.dataset.captureId = card.captureId;
  if (card.due?.repeat && card.due.date) element.dataset.occurrence = card.due.date;
  const done = boardDoneButton(card, element, closed);
  const body = node("div", undefined, "board-body");
  const titleRow = node("div", undefined, "board-title-row");
  titleRow.append(boardTitleButton(card, element));
  if (!closed) {
    // Крестик по наведению — удалить дело прямо с доски. Удаление мягкое, тост
    // даёт «Вернуть», как в карточке.
    const remove = node("button", "×", "board-remove");
    remove.type = "button";
    bindTranslation(remove, "Удалить дело", "title");
    bindTranslation(remove, "Удалить: {title}", { title: card.title }, "aria-label");
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      remove.disabled = true;
      try {
        await request(`/api/captures/${card.captureId}`, { method: "DELETE" });
        element.remove();
        toast(t("Дело удалено"), { get label() { return t("Вернуть"); }, run: async () => { try { await request(`/api/captures/${card.captureId}/restore`, { method: "POST" }); toast(t("Дело возвращено")); } catch (error) { toast(error.message); } loadBoard(); } });
        loadBoard();
        load();
      } catch (error) { toast(error.message); remove.disabled = false; }
    });
    titleRow.append(remove);
  }
  body.append(titleRow);
  // Подзадача, вставшая на доску своей карточкой, подписана родителем; у дела с
  // подзадачами — полоска прогресса с числом, при любом переключателе.
  if (card.subtask) body.append(boardParentLabel(card));
  const map = boardSubtaskMap(card, element);
  if (map) body.append(map);
  const meta = node("div", undefined, "board-meta");
  if (closed) meta.append(node("span", boardClosedWhen(card), "btag due"));
  else meta.append(...boardMetaTags(card));
  const tomorrow = tomorrowAction({ id: card.captureId, title: card.title, schedule: card.due, occurrence: card.due?.repeat ? card.due.date : null, done: closed });
  if (tomorrow) meta.append(tomorrow);
  if (meta.childNodes.length) body.append(meta);
  element.append(done, body);
  if (!draggable) return element;
  element.addEventListener("dragstart", (event) => {
    boardState.drag = { type: "card", captureId: card.captureId, from: card.columnId || null };
    event.dataTransfer.setData("text/plain", card.captureId);
    event.dataTransfer.effectAllowed = "move";
    requestAnimationFrame(() => element.classList.add("dragging"));
  });
  element.addEventListener("dragend", () => {
    element.classList.remove("dragging");
    boardDropHint.remove();
    boardState.drag = null;
    for (const lane of document.querySelectorAll(".board-column.done-drop, .board-column.drop-over")) lane.classList.remove("done-drop", "drop-over");
  });
  return element;
}
// Строка списка: кружок, название, справа — срок, люди и проект; под названием —
// родитель (у подзадачи) и полоска подзадач (у дела с ними). Не тянется.
function boardRowEl(card, { closed = false } = {}) {
  const row = node("div", undefined, `g-row board-row${closed ? " closed" : ""}`);
  row.dataset.captureId = card.captureId;
  if (card.due?.repeat && card.due.date) row.dataset.occurrence = card.due.date;
  const right = node("span", undefined, "g-right");
  if (closed) right.append(node("span", boardClosedWhen(card), "btag due"));
  else right.append(...boardMetaTags(card), ...(card.projects || []).map((name) => node("span", name, "btag project")));
  const tomorrow = tomorrowAction({ id: card.captureId, title: card.title, schedule: card.due, occurrence: card.due?.repeat ? card.due.date : null, done: closed });
  if (tomorrow) right.append(tomorrow);
  row.append(boardDoneButton(card, row, closed), boardTitleButton(card, row), right);
  // Следующие строки сетки под названием: родитель подзадачи, полоска с числом.
  if (card.subtask) row.append(boardParentLabel(card));
  const map = boardSubtaskMap(card, row);
  if (map) row.append(map);
  return row;
}
// Позиция вставки: перед первой карточкой, чья середина ниже мыши. Порядок в
// колонке — серверный, а на экране карточки собраны по подгруппам, поэтому
// индекс считается не по экрану, а по серверному порядку колонки.
function boardDropIndex(list, clientY, columnId) {
  const cards = [...list.querySelectorAll(".board-card:not(.dragging)")];
  const before = cards.find((card) => { const rect = card.getBoundingClientRect(); return clientY < rect.top + rect.height / 2; }) || null;
  const dragged = boardState.drag?.captureId;
  const order = (boardState.data?.columns.find((column) => column.id === columnId)?.cards || []).map((card) => card.captureId).filter((id) => id !== dragged);
  const at = before ? order.indexOf(before.dataset.captureId) : -1;
  return { index: at >= 0 ? at : order.length, before, last: cards.at(-1) || null };
}
async function boardMove(body) {
  try {
    await boardMoveRequest(body);
  } catch (error) {
    toast(error.message);
  }
  loadBoard();
}
// Шапка колонки: название, число карточек, по наведению — меню и «+».
function boardHeadEl(name, count) {
  const head = node("div", undefined, "board-col-head");
  const pill = node("span", undefined, "board-pill");
  pill.append(node("span", name, "board-col-name"));
  head.append(pill, node("span", String(count), "board-col-count"));
  return head;
}
function boardHeadTools(element, { menu = null, plus = true } = {}) {
  const tools = node("div", undefined, "board-col-tools");
  if (menu) tools.append(menu);
  if (plus) {
    const add = node("button", "+", "board-col-plus");
    add.type = "button";
    bindTranslation(add, "Добавить дело", "title");
    bindTranslation(add, "Добавить дело в колонку", "aria-label");
    add.addEventListener("click", () => element.querySelector(".board-add-button")?.click());
    tools.append(add);
  }
  return tools;
}
// Заголовок любой колонки доски тянется: бросок на другую колонку — слева от неё
// или справа, смотря на какую половину пришёлся, — меняет порядок. Тянутся и
// колонки человека, и группы (день, человек, проект, откуда), и «Закрыто».
// field — поле первого уровня («all» — доска без группировки), key — ключ
// колонки в сохранённом порядке.
function boardLaneDrag(element, head, field, key) {
  element.dataset.lane = key;
  head.draggable = true;
  const clearHints = () => { for (const other of document.querySelectorAll(".board-column")) other.classList.remove("col-drop-left", "col-drop-right"); };
  head.addEventListener("dragstart", (event) => {
    boardState.drag = { type: "column", field, key };
    event.dataTransfer.setData("text/plain", key);
    event.dataTransfer.effectAllowed = "move";
    element.classList.add("dragging-column");
    event.stopPropagation();
  });
  head.addEventListener("dragend", () => {
    element.classList.remove("dragging-column");
    boardState.drag = null;
    clearHints();
  });
  const foreign = () => boardState.drag?.type === "column" && boardState.drag.key !== key;
  const leftHalf = (event) => { const rect = element.getBoundingClientRect(); return event.clientX < rect.left + rect.width / 2; };
  element.addEventListener("dragover", (event) => {
    if (!foreign()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const left = leftHalf(event);
    element.classList.toggle("col-drop-left", left);
    element.classList.toggle("col-drop-right", !left);
  });
  element.addEventListener("dragleave", () => element.classList.remove("col-drop-left", "col-drop-right"));
  element.addEventListener("drop", (event) => {
    if (!foreign()) return;
    event.preventDefault();
    const { field: from, key: dragged } = boardState.drag;
    const after = !leftHalf(event);
    boardState.drag = null;
    clearHints();
    boardMoveLane(from, dragged, key, after);
  });
}
// Все колонки поля в естественном порядке — с «Закрыто» впереди, включая
// скрытые (пустые, не заведённые человеком, и спрятанные фильтром): порядок
// сохраняется целиком, а не по тому, что сейчас видно. Заведённая колонка есть
// здесь и тогда, когда открытых дел с этим человеком или проектом нет.
function boardLaneKeys(field, data) {
  if (field === "all") return [DONE_LANE, "all"];
  const open = data.columns.flatMap((column) => column.cards);
  return [DONE_LANE, ...boardGroups(open, field, data, true, boardState.shown[field] || []).map((group) => group.key ?? FILTER_NONE)];
}
// Колонки в порядке показа: сохранённый порядок, а незнакомые ему группы —
// после известных, в своём естественном порядке.
function boardOrderedLanes(field, lanes) {
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]));
  return orderKeys(boardState.order[field], lanes.map((lane) => lane.key)).map((key) => byKey.get(key));
}
async function boardMoveLane(field, key, target, after) {
  const data = boardAnnotate(boardState.data);
  const current = orderKeys(boardState.order[field], boardLaneKeys(field, data));
  const next = moveKey(current, key, target, after);
  if (next.join("\n") === current.join("\n")) return;
  boardState.order[field] = next;
  boardRememberOrder();
  renderBoard(boardState.data);
  // Порядок колонок человека живёт и на сервере; место «Закрыто» — только здесь.
  const own = (keys) => keys.filter((item) => item !== DONE_LANE);
  if (field !== "col" || key === DONE_LANE || own(current).join("\n") === own(next).join("\n")) return;
  try {
    await request(`/api/board/columns/${key}`, { method: "PATCH", body: JSON.stringify({ index: own(next).indexOf(key) }) });
  } catch (error) { toast(error.message); }
  loadBoard();
}
// «Закрыто» — обычная колонка доски (ключ порядка — `__done`), зелёная подложка отличает её от остальных:
// закрытые дела (последние 50), кружок возвращает дело в его колонку, а карточка,
// брошенная на колонку, закрывается. Меню у неё нет; заголовок ведёт на страницу
// «Сделано», а тянется, как у остальных, за свободное место шапки.
function boardDoneColumnEl(closed, field, rest, data) {
  const element = node("section", undefined, "board-column board-done-column");
  element.dataset.columnId = "done";
  const head = node("div", undefined, "board-col-head");
  const pill = node("span", undefined, "board-pill");
  const link = bindTranslation(node("a", t("Закрыто"), "board-col-name"), "Закрыто");
  link.href = "#done";
  // Ссылку браузер тянет сам, как адрес; тянуться должна колонка.
  link.draggable = false;
  pill.append(link);
  head.append(pill, node("span", String(closed.length), "board-col-count"));
  boardLaneDrag(element, head, field, DONE_LANE);
  const list = node("div", undefined, "board-cards");
  list.append(...boardBoxes(closed, rest, data, { closed: true, draggable: false }));
  if (!closed.length) list.append(bindTranslation(node("p", t("Закрытое появится здесь"), "board-done-empty"), "Закрытое появится здесь"));
  element.addEventListener("dragover", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    element.classList.add("done-drop");
  });
  element.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Element && element.contains(event.relatedTarget)) return;
    element.classList.remove("done-drop");
  });
  element.addEventListener("drop", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    element.classList.remove("done-drop");
    const captureId = boardState.drag.captureId;
    const card = boardFindCard(captureId);
    if (card) completeBoardCard(card, document.querySelector(`.board-card[data-capture-id="${captureId}"]`), null);
  });
  element.append(head, list);
  return element;
}
// Колонка пользователя: карточки колонки и, если группировка глубже одного
// уровня, вложенные коробки подгрупп. Бросок карточки во вложенную коробку —
// бросок в колонку: подполе (день, человек, …) он не меняет, это осознанно.
function boardColumnEl(column, cards, rest, data) {
  const element = node("section", undefined, "board-column");
  element.dataset.columnId = column.id;
  const head = boardHeadEl(column.name, cards.length);
  boardLaneDrag(element, head, "col", column.id);
  // Название правится на месте: щелчком по нему или через меню.
  const rename = () => {
    const input = document.createElement("input");
    input.value = column.name;
    input.className = "board-col-input";
    input.maxLength = 40;
    bindTranslation(input, "Название колонки", "aria-label");
    head.querySelector(".board-pill").replaceWith(input);
    head.draggable = false;
    input.focus();
    input.select();
    const cancel = () => loadBoard({ force: true });
    input.addEventListener("keydown", async (event) => {
      if (event.key === "Escape") return cancel();
      if (event.key !== "Enter") return;
      const value = input.value.trim();
      if (!value || value === column.name) return cancel();
      try {
        await request(`/api/board/columns/${column.id}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
      } catch (error) { toast(error.message); }
      loadBoard({ force: true });
    });
    input.addEventListener("blur", cancel);
  };
  head.querySelector(".board-col-name").addEventListener("click", rename);
  // Меню колонки: переименовать или удалить (дела уедут в первую колонку).
  const menu = node("details", undefined, "board-menu");
  const summary = node("summary", "⋯");
  bindTranslation(summary, "Меню колонки {name}", { name: column.name }, "aria-label");
  const popover = node("div", undefined, "board-menu-popover");
  const renameButton = bindTranslation(node("button", t("Переименовать")), "Переименовать");
  renameButton.type = "button";
  renameButton.addEventListener("click", () => { menu.removeAttribute("open"); rename(); });
  const removeColumn = bindTranslation(node("button", t("Удалить колонку")), "Удалить колонку");
  removeColumn.type = "button";
  removeColumn.addEventListener("click", async () => {
    menu.removeAttribute("open");
    try {
      const result = await request(`/api/board/columns/${column.id}`, { method: "DELETE" });
      toast(result.moved ? t("Колонка удалена, дел перенесено: {moved}", { moved: result.moved }) : t("Колонка удалена"));
    } catch (error) { toast(error.message); }
    loadBoard();
  });
  popover.append(renameButton, removeColumn);
  menu.append(summary, popover);
  head.append(boardHeadTools(element, { menu }));
  const list = node("div", undefined, "board-cards");
  list.append(...boardBoxes(cards, rest, data));
  list.addEventListener("dragover", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const { before, last } = boardDropIndex(list, event.clientY, column.id);
    if (before) before.before(boardDropHint);
    else if (last) last.after(boardDropHint);
    else list.append(boardDropHint);
  });
  list.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Element && list.contains(event.relatedTarget)) return;
    boardDropHint.remove();
  });
  list.addEventListener("drop", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    const { index } = boardDropIndex(list, event.clientY, column.id);
    const captureId = boardState.drag.captureId;
    boardDropHint.remove();
    boardMove({ captureId, columnId: column.id, index });
  });
  element.append(head, list, boardAdderEl(boardInviteFor("col", { key: column.id, column }, data)));
  return element;
}
// Новое дело, созданное прямо на доске: туду с названием из набранного.
const boardCreateDeed = (raw, extra = {}) => request("/api/captures", { method: "POST", body: JSON.stringify(withProvider({ raw, primaryType: "todo", ...extra })) });
// Как назвать приглашение и куда падает дело, набранное внизу колонки первого
// уровня. Колонка — «+ Дело в «Дела»», день — «+ Дело на завтра», человек и проект —
// «+ Дело — Аня», «+ Дело — Hub»: имя стоит как есть, не склоняется. Колонка
// человека — в неё, и порядок в ней серверный; день — на срок
// группы (сегодня, завтра, +2, +14: те же, что при броске карточки); человек —
// он встаёт первым среди людей дела, чтобы оно осталось в этой колонке;
// проект — проектом дела. В «просрочено» и «без срока», в «Откуда» и в
// «Закрыто» приглашения нет: срок и источник так не назначить.
const BOARD_INVITE_DAY = { get today() { return t("на сегодня"); }, get tomorrow() { return t("на завтра"); }, get week() { return t("на неделе"); }, get later() { return t("позже"); } };
function boardInviteFor(field, group, data) {
  const key = `${field}:${group.key ?? FILTER_NONE}`;
  if (field === "col") {
    const { column } = group;
    return { key, label: t("+ Дело в «{name}»", { name: column.name }), create: async (raw) => {
      const created = await boardCreateDeed(raw);
      await boardMoveRequest({ captureId: created.entry.id, columnId: column.id, index: 100000 });
    } };
  }
  if (field === "day") {
    if (!(group.key in BOARD_INVITE_DAY)) return null;
    return { key, label: t("+ Дело {value1}", { value1: BOARD_INVITE_DAY[group.key] }), create: (raw) => boardCreateDeed(raw, { due: { date: shiftDate(data.today, BOARD_DAY_DROP[group.key]) } }) };
  }
  if (field === "who") {
    const name = group.key;
    if (name === null) return { key, get label() { return t("+ Дело без человека"); }, create: (raw) => boardCreateDeed(raw) };
    return { key, label: t("+ Дело — {name}", { name: name }), create: async (raw) => {
      const created = await boardCreateDeed(raw);
      const others = (created.entry.interpretation?.classification?.entities?.people || []).filter((person) => person !== name);
      await request(`/api/captures/${created.entry.id}/corrections`, { method: "POST", body: JSON.stringify({ at: Date.now(), patch: { people: [name, ...others] } }) });
    } };
  }
  if (field === "proj") {
    const name = group.key;
    if (name === null) return { key, get label() { return t("+ Дело без проекта"); }, create: (raw) => boardCreateDeed(raw) };
    return { key, label: t("+ Дело — {name}", { name: name }), create: async (raw) => {
      const created = await boardCreateDeed(raw);
      await request(`/api/captures/${created.entry.id}/corrections`, { method: "POST", body: JSON.stringify({ at: Date.now(), patch: { project: name } }) });
    } };
  }
  return null;
}
// Внизу каждой колонки — пунктирная карточка-приглашение «+ Дело в …»: её видно
// по наведению на колонку, с клавиатуры — при фокусе внутри, а там, где наведения
// нет, всегда. Щелчок превращает её в поле на месте: Enter сохраняет и оставляет
// поле открытым для следующего (как в Todoist), Escape закрывает.
function boardAdderEl(invite) {
  if (!invite) return null;
  const wrap = node("div", undefined, "board-add");
  const button = node("button", invite.label, "board-add-button");
  button.type = "button";
  button.title = invite.label;
  const input = document.createElement("input");
  input.type = "text";
  bindTranslation(input, "Что сделать?", "placeholder");
  input.hidden = true;
  const adderKey = invite.key;
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
      await invite.create(raw);
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
// restore — поле было открыто, когда доску перерисовали: оно встаёт открытым, с
// тем, что успели набрать. Перерисовка приходит и посреди набора названия — от
// записи со стороны, от правки в другой вкладке.
function boardGhostColumnEl(restore = null) {
  const element = node("section", undefined, "board-column ghost");
  const button = bindTranslation(node("button", t("+ Колонка"), "board-add-button"), "+ Колонка");
  button.type = "button";
  const input = document.createElement("input");
  input.type = "text";
  bindTranslation(input, "Название колонки", "placeholder");
  input.maxLength = 40;
  input.hidden = true;
  if (restore) { button.hidden = true; input.hidden = false; input.value = restore.draft; }
  button.addEventListener("click", () => { button.hidden = true; input.hidden = false; input.focus(); });
  const close = () => { input.hidden = true; input.value = ""; button.hidden = false; };
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") return close();
    if (event.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return close();
    // Отправляемое поле — уже не черновик: перерисовка его не вернёт.
    input.disabled = true;
    try {
      await request("/api/board/columns", { method: "POST", body: JSON.stringify({ name }) });
    } catch (error) { toast(error.message); }
    loadBoard({ force: true });
  });
  input.addEventListener("blur", () => { if (!input.value.trim() && !input.disabled) close(); });
  element.append(button, input);
  return element;
}
// ── группировка: ключи, группы, вложенные коробки и разделы списка ───────────
// Откуда дело: не назвал сервер — значит, поле записи.
const boardSource = (card) => (BOARD_SOURCES.some(([key]) => key === card.origin) ? card.origin : "field");
// День дела относительно сегодня — одна из шести групп.
function boardDayKey(card, today) {
  const date = card.due?.date || null;
  if (!date) return "none";
  if (date < today) return "late";
  if (date === today) return "today";
  if (date === shiftDate(today, 1)) return "tomorrow";
  return date <= shiftDate(today, 7) ? "week" : "later";
}
// Дело помнит свою колонку: по ней его раскладывает группировка «Колонка».
// Закрытое лежит в колонке, куда вернётся; сервер её называет, а без названия —
// первая.
function boardAnnotate(data) {
  const known = new Set(data.columns.map((column) => column.id));
  for (const column of data.columns) for (const card of column.cards) card.columnId = column.id;
  for (const card of data.closed || []) if (!known.has(card.columnId)) card.columnId = data.columns[0]?.id ?? null;
  return data;
}
const boardFindCard = (captureId) => boardState.data?.columns.flatMap((column) => column.cards).find((card) => card.captureId === captureId) || null;
// Группы одного уровня в фиксированном порядке. Пустые скрываются, кроме
// колонок человека на первом уровне (пустую колонку нужно видеть, чтобы было
// куда бросить) и тех, что оставляет keepEmpty — true или условие: на доске это
// колонки-группы, которые человек завёл сам через «+ Колонка». extra — ключи
// групп, которые есть и без дел: заведённый человек или проект, которого ни у
// одного открытого дела нет первым.
function boardGroups(items, field, data, keepEmpty = false, extra = []) {
  let groups;
  if (field === "col") groups = data.columns.map((column) => ({ key: column.id, label: column.name, column, items: items.filter((card) => card.columnId === column.id) }));
  else if (field === "day") {
    const byTime = (left, right) => (left.due?.date || "").localeCompare(right.due?.date || "") || (left.due?.time || "99").localeCompare(right.due?.time || "99");
    groups = BOARD_DAYS.map(([key, label]) => ({ key, label, items: items.filter((card) => boardDayKey(card, data.today) === key).sort(byTime) }));
  } else if (field === "src") groups = BOARD_SOURCES.map(([key, label]) => ({ key, label, items: items.filter((card) => boardSource(card) === key) }));
  else {
    // Человек и проект — первый из названных; кому и куда не названо — последней группой.
    const valueOf = (card) => (field === "who" ? card.people : card.projects)?.[0] || null;
    const names = [...new Set([...items.map(valueOf).filter(Boolean), ...extra.filter((key) => key !== FILTER_NONE)])].sort((left, right) => left.localeCompare(right, "ru"));
    groups = [...names, null].map((name) => ({ key: name, label: name ?? (field === "who" ? t("Без человека") : t("Без проекта")), items: items.filter((card) => valueOf(card) === name) }));
  }
  return groups.filter((group) => group.items.length || (typeof keepEmpty === "function" ? keepEmpty(group) : keepEmpty));
}
const boardTint = (field) => `var(--f-${field})`;
// Вложенные коробки подгрупп внутри колонки: заголовок в цвете поля, а внутри —
// следующий уровень или карточки.
function boardBoxes(items, fields, data, { draggable = true, closed = false } = {}) {
  if (!fields.length) return items.map((card) => boardCardEl(card, { draggable, closed }));
  const [field, ...rest] = fields;
  return boardGroups(items, field, data).map((group) => {
    const box = node("div", undefined, "g-box");
    box.style.setProperty("--fc", boardTint(field));
    const head = node("div", group.label, "g-bh");
    head.append(" ", node("span", `· ${group.items.length}`, "n"));
    box.append(head, ...boardBoxes(group.items, rest, data, { draggable, closed }));
    return box;
  });
}
// «по дню», «по человеку»… — для подсказки пустой доски: «Колонок по дню пока нет».
const BOARD_BY = { get day() { return t("по дню"); }, get who() { return t("по человеку"); }, get proj() { return t("по проекту"); }, get src() { return t("по источнику"); } };
// Значения поля, которых на доске ещё нет колонкой, — из них человек выбирает в
// «+ Колонка»: все дни и источники, люди и проекты из карточек, «Без человека» и
// «Без проекта». Показанные (непустые и заведённые) не предлагаются.
function boardGroupChoices(field, all, visible) {
  let list;
  if (field === "day") list = BOARD_DAYS.map(([key, label]) => ({ key, label }));
  else if (field === "src") list = BOARD_SOURCES.map(([key, label]) => ({ key, label }));
  else {
    const cards = [...all.columns.flatMap((column) => column.cards), ...(all.closed || [])];
    const names = [...new Set(cards.flatMap((card) => (field === "who" ? card.people : card.projects) || []))].sort((left, right) => left.localeCompare(right, "ru"));
    list = [...names.map((name) => ({ key: name, label: name })), { key: FILTER_NONE, label: field === "who" ? t("Без человека") : t("Без проекта") }];
  }
  return list.filter((item) => !visible.includes(item.key));
}
// Выбор новой колонки открывается и закрывается на месте: состояние лежит в
// boardState.pickOpen, чтобы перерисовка доски не закрывала его под рукой.
function boardSetPick(open, { focus = false } = {}) {
  boardState.pickOpen = open;
  const ghost = $("#board-columns .board-column.ghost.pick");
  if (!ghost) return;
  ghost.classList.toggle("is-open", open);
  ghost.querySelector(".board-pick-list").hidden = !open;
  ghost.querySelector(".board-add-button").setAttribute("aria-expanded", String(open));
  if (open && focus) ghost.querySelector(".board-pick-item")?.focus();
}
// «+ Колонка» у групп: не поле для названия, а выбор из значений, которых на
// доске ещё нет (см. boardGroupChoices). Колонка, которую человек выбрал,
// появляется пустой и остаётся, пока он сам её не уберёт. lonely — групп на
// доске нет вовсе: «+ Колонка» говорит, что делать.
function boardGroupGhostEl(field, choices, lonely) {
  const element = node("section", undefined, `board-column ghost pick${lonely ? " lonely" : ""}${boardState.pickOpen ? " is-open" : ""}`);
  if (lonely) element.append(bindTranslation(node("p", t("Колонок {value1} пока нет — добавьте нужные через «+ Колонка»", { value1: BOARD_BY[field] }), "board-lanes-hint"), "Колонок {value1} пока нет — добавьте нужные через «+ Колонка»", { value1: BOARD_BY[field] }));
  const button = bindTranslation(node("button", t("+ Колонка"), "board-add-button"), "+ Колонка");
  button.type = "button";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", String(boardState.pickOpen));
  button.addEventListener("click", () => boardSetPick(!boardState.pickOpen, { focus: true }));
  const list = node("div", undefined, "board-pick-list");
  list.hidden = !boardState.pickOpen;
  list.setAttribute("role", "group");
  bindTranslation(list, "Какую колонку добавить", "aria-label");
  for (const { key, label } of choices) {
    const item = node("button", label, "board-pick-item");
    item.type = "button";
    item.dataset.key = key;
    item.addEventListener("click", () => boardAddGroup(field, key));
    list.append(item);
  }
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !boardState.pickOpen) return;
    event.stopPropagation();
    boardSetPick(false);
    button.focus();
  });
  element.append(button, list);
  return element;
}
// Колонку выбрали в «+ Колонка»: она запоминается и встаёт в конец ряда — после
// последней из показанных; скрытые колонки стоят, где стояли.
function boardAddGroup(field, key) {
  const lanes = $("#board-columns");
  const visible = [...lanes.querySelectorAll(".board-column[data-lane]")].map((lane) => lane.dataset.lane);
  boardState.shown[field] = [...new Set([...(boardState.shown[field] || []), key])];
  boardRememberShown();
  boardState.order[field] = placeLast(orderKeys(boardState.order[field], boardLaneKeys(field, boardAnnotate(boardState.data))), key, visible);
  boardRememberOrder();
  boardState.pickOpen = false;
  renderBoard(boardState.data);
  // На телефоне колонка одна на экран: открыта новая. На широком экране лента доезжает до неё.
  const added = [...lanes.querySelectorAll(".board-column[data-lane]")].find((lane) => lane.dataset.lane === key);
  if (!added) return;
  boardState.mobileColumn = [...lanes.querySelectorAll(".board-column")].indexOf(added);
  paintBoardSegments([...lanes.querySelectorAll(".board-column")]);
  added.scrollIntoView({ block: "nearest", inline: "nearest" });
}
// «Убрать колонку»: заведённая колонка скрывается, пока в ней пусто. Если в ней
// есть дела, она остаётся, пока они в ней есть, — её просто больше не держат.
function boardRemoveGroup(field, key, label, count) {
  boardState.shown[field] = (boardState.shown[field] || []).filter((item) => item !== key);
  boardRememberShown();
  renderBoard(boardState.data);
  if (count) toast(t("Колонка «{label}» уйдёт, когда в ней не останется дел", { label: label }));
}
// Меню колонки-группы: только «Убрать колонку» и сказанное словами, что будет с
// колонкой, в которой есть дела.
function boardGroupMenu(element, field, group) {
  const menu = node("details", undefined, "board-menu");
  const summary = node("summary", "⋯");
  bindTranslation(summary, "Меню колонки {label}", { label: group.label }, "aria-label");
  const popover = node("div", undefined, "board-menu-popover");
  const remove = bindTranslation(node("button", t("Убрать колонку")), "Убрать колонку");
  remove.type = "button";
  bindTranslation(remove, "Колонка скроется, пока в ней пусто. Если в ней есть дела, она останется, пока они в ней есть.", "title");
  remove.addEventListener("click", () => {
    menu.removeAttribute("open");
    boardRemoveGroup(field, group.key ?? FILTER_NONE, group.label, element.querySelectorAll(".board-card").length);
  });
  popover.append(remove, node("p", group.items.length ? t("В колонке есть дела: она останется, пока они в ней.") : t("Вернуть колонку можно через «+ Колонка»."), "board-menu-note"));
  menu.append(summary, popover);
  return menu;
}
// Колонка-группа: первый уровень — не «Колонка». Заголовок не правится, зато он
// тянется, как у колонок человека; в меню — «Убрать колонку» (колонки-группы
// заводит человек сам, «+ Колонка» стоит в конце ряда). Карточки тянутся, только
// когда группа — день (срок меняется броском) или группировки нет вовсе. Внизу —
// приглашение «+ Дело …», где оно осмысленно.
function boardGroupColumnEl(group, field, rest, data) {
  const element = node("section", undefined, "board-column group");
  element.dataset.group = `${field || "all"}:${group.key ?? ""}`;
  const head = boardHeadEl(group.label, group.items.length);
  boardLaneDrag(element, head, field || "all", group.key ?? FILTER_NONE);
  if (field) head.append(boardHeadTools(element, { menu: boardGroupMenu(element, field, group), plus: false }));
  const list = node("div", undefined, "board-cards");
  list.append(...boardBoxes(group.items, rest, data, { draggable: !field || field === "day" }));
  element.append(head, list);
  const adder = field ? boardAdderEl(boardInviteFor(field, group, data)) : null;
  if (adder) element.append(adder);
  if (field === "day") boardDayDropOn(element, group.key);
  return element;
}
// Бросок карточки в группу-день меняет срок; в «просрочено» срок не назначить.
function boardDayDropOn(element, key) {
  if (key !== "none" && !(key in BOARD_DAY_DROP)) return;
  element.addEventListener("dragover", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    element.classList.add("drop-over");
  });
  element.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Element && element.contains(event.relatedTarget)) return;
    element.classList.remove("drop-over");
  });
  element.addEventListener("drop", (event) => {
    if (boardState.drag?.type !== "card") return;
    event.preventDefault();
    element.classList.remove("drop-over");
    const card = boardFindCard(boardState.drag.captureId);
    // Уже в этой группе — срок не трогаем: «на неделе» не должно стать «через два дня».
    if (!card || boardDayKey(card, boardState.data.today) === key) return;
    boardChangeDue(card, key === "none" ? null : shiftDate(boardState.data.today, BOARD_DAY_DROP[key]));
  });
}
async function boardChangeDue(card, date) {
  try {
    await request(`/api/captures/${card.captureId}/corrections`, {
      method: "POST",
      // метка времени в теле обходит клиентский кэш уточнений: перенос туда и
      // обратно — два разных действия, а не повтор одного
      body: JSON.stringify({ at: Date.now(), patch: { schedule: { date, time: date ? card.due?.time || null : null } } }),
    });
    toast(date ? t("Срок: {value1}", { value1: scheduleLabel({ state: "ok", date, time: null }) }) : t("Срок снят"));
  } catch (error) {
    toast(error.message);
  }
  loadBoard();
  load().catch(() => {});
}
// Список: вложенные разделы — заголовок и тело в рамке цвета поля, — а в самом
// глубоком — строки. Глубина задаёт размер заголовка.
function boardListNodes(items, fields, depth, data, keepEmpty = false, closed = false) {
  if (!fields.length) {
    const rows = node("div", undefined, "g-rows");
    rows.append(...items.map((card) => boardRowEl(card, { closed })));
    return [rows];
  }
  const [field, ...rest] = fields;
  return boardGroups(items, field, data, keepEmpty).flatMap((group) => {
    const head = node("div", group.label, `g-sec d${Math.min(depth, 3)}`);
    head.append(" ", node("span", `· ${group.items.length}`, "n"));
    const kids = node("div", undefined, "g-kids");
    head.style.setProperty("--fc", boardTint(field));
    kids.style.setProperty("--fc", boardTint(field));
    kids.append(...boardListNodes(group.items, rest, depth + 1, data, false, closed));
    return [head, kids];
  });
}
// «Закрыто» — заголовок-ссылка на страницу «Сделано» с числом закрытых.
function boardDoneHead(count, className) {
  const head = node("div", undefined, className);
  const link = bindTranslation(node("a", t("Закрыто")), "Закрыто");
  link.href = "#done";
  head.append(link, " ", node("span", `· ${count}`, "n"));
  return head;
}
// «Статус = открыто» прячет «Закрыто» — колонку доски и раздел списка.
const boardDoneShown = () => statusAllowsDone(boardState.filter);
function boardListEl(open, closed, data) {
  const list = node("div", undefined, "g-list");
  list.append(...boardListNodes(open, boardState.groups, 1, data, boardState.groups[0] === "col"));
  if (!boardDoneShown()) return list;
  const kids = node("div", undefined, "g-kids done");
  kids.append(...boardListNodes(closed, boardState.groups.slice(1), 2, data, false, true));
  list.append(boardDoneHead(closed.length, "g-sec d1 done"), kids);
  return list;
}
// ── наборный фильтр ──────────────────────────────────────────────────────────
// Кнопка «Фильтр · N» над доской открывает строку под панелью: условия-плашки
// («День = сегодня или просрочено», «Человек ≠ Аня или Лёша»), «+ условие»,
// «Сегодня» и «Сбросить». В плашке — поле, «=» или «≠» и значения: кнопка
// со значениями открывает список с галочками из того, что есть в загруженных
// делах. Внутри плашки значения складываются по «или» («=» — любое из них, «≠» —
// ни одно), между плашками стоит тихое «и»; цвет плашки — цвет поля, у «Статуса»
// нейтральный. Условие с тем же полем и оператором не заводится второй раз:
// значения уходят в уже стоящее. Условие без значений — черновик: он ничего не
// отбирает и не сохраняется.
const BOARD_FILTER_OPS = [["=", "="], ["!=", "≠"]];
const boardFilterTint = (field) => (field === "status" ? "var(--f-status)" : boardTint(field));
// Значения условия по полю; у человека и проекта последним — «пусто».
function boardFilterValues(field) {
  const data = boardState.data;
  if (field === "col") return (data?.columns || []).map((column) => [column.id, column.name]);
  if (field === "day") return BOARD_DAYS;
  if (field === "src") return BOARD_SOURCES;
  if (field === "status") return FILTER_STATUSES;
  const cards = data ? [...data.columns.flatMap((column) => column.cards), ...(data.closed || [])] : [];
  const names = [...new Set(cards.flatMap((card) => (field === "who" ? card.people : card.projects) || []))].sort((left, right) => left.localeCompare(right, "ru"));
  return [...names.map((name) => [name, name]), [FILTER_NONE, t("пусто")]];
}
function boardFilterSelect(part, label, options, value) {
  const select = node("select");
  select.dataset.part = part;
  select.setAttribute("aria-label", label);
  for (const [key, name] of options) { const option = new Option(name, key); option.selected = key === value; select.append(option); }
  return select;
}
// Условие на доске одно на поле и оператор, поэтому ими его и называют: список
// значений открыт у того, чей ключ лежит в boardState.valsOpen («day=»).
const boardCondKey = (condition) => `${condition.field}${condition.op}`;
function boardCondEl(condition, index) {
  const chip = node("span", undefined, "board-cond");
  chip.dataset.index = String(index);
  chip.style.setProperty("--fc", boardFilterTint(condition.field));
  // Копия: значения по полю — общие константы, дописывать в них нельзя.
  const options = [...boardFilterValues(condition.field)];
  // Значение, которого в загруженном уже нет (человек ушёл, колонку удалили), не
  // подменяется молча: остаётся в списке, и условие видно.
  for (const value of condition.values)
    if (!options.some(([key]) => key === value))
      options.push([value, !boardState.data ? "…" : condition.field === "col" ? t("колонка удалена") : value]);
  const names = new Map(options);
  const nth = index + 1;
  const open = boardState.valsOpen === boardCondKey(condition);
  // Значения читаются одной строкой: «сегодня или просрочено».
  const button = node("button", undefined, `board-vals-btn${condition.values.length ? "" : " is-empty"}`);
  button.type = "button";
  button.dataset.part = "values";
  bindTranslation(button, "Выбрать значения", "title");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", String(open));
  bindTranslation(button, "Значения условия {nth}: {value2}", { nth: nth, value2: condition.values.map((value) => names.get(value)).join(t(" или ")) || t("не выбраны") }, "aria-label");
  if (!condition.values.length) button.append(t("значения"));
  condition.values.forEach((value, at) => {
    if (at) button.append(" ", bindTranslation(node("span", t("или"), "board-or"), "или"), " ");
    button.append(names.get(value));
  });
  // Под кнопкой — список с галочками: отметили два значения — получили «или».
  const pop = node("div", undefined, "board-vals-pop");
  pop.hidden = !open;
  pop.setAttribute("role", "group");
  bindTranslation(pop, "Значения условия {nth}", { nth: nth }, "aria-label");
  pop.append(node("p", condition.op === "!=" ? t("Ни одно из отмеченных") : t("Любое из отмеченных"), "board-vals-cap"));
  for (const [key, name] of options) {
    const row = node("label", undefined, "board-val");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = key;
    box.checked = condition.values.includes(key);
    row.append(box, node("span", name));
    pop.append(row);
  }
  if (!options.length) pop.append(bindTranslation(node("p", t("Значений пока нет"), "board-vals-none"), "Значений пока нет"));
  const vals = node("span", undefined, "board-vals");
  vals.append(button, pop);
  const remove = node("button", "×", "board-cond-x");
  remove.type = "button";
  remove.dataset.remove = String(index);
  bindTranslation(remove, "Убрать условие", "title");
  bindTranslation(remove, "Убрать условие {nth}: {value2}", { nth: nth, value2: FILTER_FIELDS[condition.field] }, "aria-label");
  chip.append(
    boardFilterSelect("field", t("Поле условия {nth}", { nth: nth }), Object.entries(FILTER_FIELDS), condition.field),
    boardFilterSelect("op", t("Оператор условия {nth}", { nth: nth }), BOARD_FILTER_OPS, condition.op),
    vals,
    remove,
  );
  return chip;
}
// Список значений не должен уходить за край окна: у правого края он открывается влево.
function boardPlaceVals() {
  for (const pop of $("#board-filter").querySelectorAll(".board-vals-pop:not([hidden])")) {
    pop.classList.remove("flip");
    if (pop.getBoundingClientRect().right > document.documentElement.clientWidth - 8) pop.classList.add("flip");
  }
}
// Открыть список значений у условия с этим ключом (null — закрыть все): по одному за раз.
function boardSetVals(key) {
  boardState.valsOpen = key;
  for (const chip of $("#board-filter").querySelectorAll(".board-cond")) {
    const condition = boardState.filter[Number(chip.dataset.index)];
    const open = Boolean(condition) && key === boardCondKey(condition);
    chip.querySelector(".board-vals-pop").hidden = !open;
    chip.querySelector(".board-vals-btn").setAttribute("aria-expanded", String(open));
  }
  boardPlaceVals();
}
function paintBoardFilter() {
  const toggle = $("#board-filter-toggle"), row = $("#board-filter");
  const count = activeConditions(boardState.filter).length;
  toggle.classList.toggle("is-on", count > 0);
  toggle.setAttribute("aria-expanded", String(boardState.filterOpen));
  toggle.querySelector(".board-filter-n").textContent = count ? ` · ${count}` : "";
  row.hidden = !boardState.filterOpen;
  // «Подзадачи» — не условие: строку ради него не пересобирают, меняется только нажатое.
  for (const button of row.querySelectorAll("[data-subs]")) button.setAttribute("aria-pressed", String(button.dataset.subs === boardState.subs));
  // Строка пересобирается, только когда поменялись условия или то, из чего
  // выбирают: доска перечитывается и сама по себе, и это не должно закрывать
  // открытый список и сбивать фокус.
  const conditions = `${getLocale()}:${JSON.stringify(boardState.filter)}`;
  const key = JSON.stringify([conditions, ["col", "who", "proj"].map((field) => boardFilterValues(field))]);
  if (row.dataset.key === key || (row.contains(document.activeElement) && row.dataset.conditions === conditions)) return;
  row.dataset.key = key;
  row.dataset.conditions = conditions;
  clear(row);
  row.append(bindTranslation(node("span", t("Фильтр"), "board-bar-label"), "Фильтр"));
  boardState.filter.forEach((condition, index) => {
    if (index) row.append(bindTranslation(node("span", t("и"), "board-and"), "и"));
    row.append(boardCondEl(condition, index));
  });
  const add = bindTranslation(node("button", t("+ условие"), "board-cond-add"), "+ условие");
  add.type = "button";
  add.dataset.add = "1";
  const today = bindTranslation(node("button", t("Сегодня"), "board-filter-today"), "Сегодня");
  today.type = "button";
  today.dataset.today = "1";
  bindTranslation(today, "Вернуть фильтр по умолчанию: сегодняшнее и просроченное", "title");
  today.setAttribute("aria-pressed", String(sameFilter(boardState.filter, defaultFilter())));
  const clearAll = bindTranslation(node("button", t("Сбросить"), "board-filter-clear"), "Сбросить");
  clearAll.type = "button";
  clearAll.dataset.clear = "1";
  bindTranslation(clearAll, "Снять все условия", "title");
  clearAll.hidden = !boardState.filter.length;
  // Подзадачи на доске и в списке: показывать отдельными карточками или оставить
  // у родителя одну полоску с числом. Помнится в браузере, «Сбросить» его не трогает.
  // Сегменты — те же, что у «Вида»: нажатый залит тёмным, светлый текст.
  const subs = node("span", undefined, "board-subs");
  subs.setAttribute("role", "group");
  bindTranslation(subs, "Подзадачи на доске", "aria-label");
  const segments = node("span", undefined, "board-seg");
  for (const [mode, label] of [["show", t("Показывать")], ["hide", t("Скрывать")]]) {
    const button = node("button", label, "board-subs-btn");
    button.type = "button";
    button.dataset.subs = mode;
    button.setAttribute("aria-pressed", String(boardState.subs === mode));
    segments.append(button);
  }
  subs.append(bindTranslation(node("span", t("Подзадачи"), "board-subs-label"), "Подзадачи"), segments);
  const tail = node("span", undefined, "board-filter-tail");
  tail.append(subs, today, clearAll);
  row.append(add, tail);
  boardPlaceVals();
}
// Условие изменено: условия с одним полем и оператором сливаются в одно, выбор
// запоминается, доска перерисовывается по загруженному. focus — {field, op, part,
// value?}: условие находят по полю и оператору (плашка при перерисовке
// пересобрана), и фокус возвращается на тот список или галочку, которые трогали.
// Если условие слилось с уже стоящим, открывается список значений у него.
function boardFilterChanged(focus = null) {
  const before = boardState.filter.length;
  boardState.filter = mergeConditions(boardState.filter);
  if (focus && boardState.filter.length < before) {
    focus = { ...focus, part: "values", value: undefined };
    boardState.valsOpen = boardCondKey(focus);
  }
  boardRememberFilter();
  if (boardState.data) renderBoard(boardState.data);
  else paintBoardBar();
  if (!focus) return;
  const index = boardState.filter.findIndex((condition) => condition.field === focus.field && condition.op === focus.op);
  const chip = $("#board-filter").querySelector(`.board-cond[data-index="${index}"]`);
  if (!chip) return;
  if (focus.part === "values") {
    const box = focus.value === undefined ? null : [...chip.querySelectorAll(".board-vals-pop input")].find((item) => item.value === focus.value);
    (box || chip.querySelector(".board-vals-btn"))?.focus();
  } else chip.querySelector(`[data-part="${focus.part}"]`)?.focus();
}

// Панель над доской: вид, уровни группировки (у каждого поля свой цвет, номер
// уровня и «×»), «+ ещё» добавляет следующее неиспользованное поле; справа —
// цепочка «Колонка → День → Человек», когда уровней больше одного.
function paintBoardBar() {
  for (const button of $("#board-view").children) button.setAttribute("aria-pressed", String(button.dataset.view === boardState.view));
  $("#board-hint").textContent = boardState.groups.length > 1 ? boardState.groups.map((field) => BOARD_FIELDS[field]).join(" → ") : "";
  paintBoardFilter();
  const box = $("#board-grp");
  // Уровни пересобираются, только когда они поменялись: доска перечитывается и
  // сама по себе, и это не должно сбивать фокус и закрывать открытый список.
  const key = `${getLocale()}:${boardState.groups.join(",")}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  clear(box);
  boardState.groups.forEach((field, index) => {
    if (index) box.append(node("span", "→", "board-then"));
    const level = node("span", undefined, "board-lv");
    level.style.setProperty("--fc", boardTint(field));
    const select = node("select");
    select.dataset.level = String(index);
    bindTranslation(select, "Группировка {value1}", { value1: index + 1 }, "aria-label");
    for (const [key, name] of Object.entries(BOARD_FIELDS)) { const option = new Option(name, key); option.selected = key === field; select.append(option); }
    const remove = node("button", "×", "board-lv-remove");
    remove.type = "button";
    remove.dataset.remove = String(index);
    bindTranslation(remove, "Убрать уровень", "title");
    bindTranslation(remove, "Убрать уровень {value1}: {value2}", { value1: index + 1, value2: BOARD_FIELDS[field] }, "aria-label");
    level.append(node("i", String(index + 1)), select, remove);
    box.append(level);
  });
  if (boardState.groups.length < Object.keys(BOARD_FIELDS).length) {
    const add = bindTranslation(node("button", t("+ ещё"), "board-lv-add"), "+ ещё");
    add.type = "button";
    add.dataset.add = "1";
    box.append(add);
  }
  if (!boardState.groups.length) box.append(bindTranslation(node("span", t("без группировки — один поток"), "board-lv-none"), "без группировки — один поток"));
}
// Вид или группировка сменились: запомнить и перерисовать. Открытое поле
// быстрого дела не переезжает — колонки, где оно стояло, уже другие.
function boardChanged(key = BOARD_GROUPS_KEY) {
  boardRemember(key);
  boardState.openAdder = null;
  boardState.adderDraft = null;
  // Выбор новой колонки относился к прежнему полю — на новом он не открывается сам.
  boardState.pickOpen = false;
  if (boardState.data) renderBoard(boardState.data);
  else paintBoardBar();
}
// Что о деле знает фильтр. «День» у закрытого дела — день, когда его закрыли, у
// открытого — срок: закрыл дело без срока — оно осталось в «Закрыто» под
// фильтром «сегодня», а не исчезло. У дела несколько людей и проектов —
// подходит любой из них.
function boardFacts(card, today) {
  const closed = Boolean(card.closedAt);
  return {
    col: card.columnId ?? null,
    day: boardDayKey(closed ? { due: { date: card.closedDate || notifyDay(card.closedAt) } } : card, today),
    who: card.people || [],
    proj: card.projects || [],
    src: boardSource(card),
    status: closed ? "done" : "open",
  };
}
// Поиск действует на названия, фильтр — на поля дела: доска не перезапрашивается,
// всё уже загружено. Карточки круга, который человек выключил, не показываются.
function boardCardVisible(card, today) {
  const circle = boardCircleOf(card);
  if (circle && (boardState.data?.circles || []).some((item) => item.id === circle.id && item.muted)) return false;
  const query = boardState.search.trim().toLowerCase();
  if (query && !card.title.toLowerCase().includes(query)) return false;
  return matchesFilter(boardState.filter, boardFacts(card, today));
}
function boardFilteredData(data) {
  const visible = (card) => boardCardVisible(card, data.today);
  return {
    ...data,
    columns: data.columns.map((column) => ({ ...column, cards: column.cards.filter(visible) })),
    closed: (data.closed || []).filter(visible),
  };
}
// На телефоне колонки — по одной на экран: сверху сегмент подписей, точка
// показывает, где вы. На широком экране сегмент спрятан стилями.
function paintBoardSegments(columns) {
  const wrap = $("#board-segments");
  clear(wrap);
  // Открыта первая колонка, которая не «Закрыто»: пока человек не выбрал сам, а
  // колонки можно переставлять, «вторая по счёту» уже не значит «первая своя».
  if (boardState.mobileColumn === null) boardState.mobileColumn = Math.max(0, columns.findIndex((column) => !column.classList.contains("board-done-column")));
  if (boardState.mobileColumn >= columns.length) boardState.mobileColumn = 0;
  columns.forEach((column, index) => {
    const name = column.querySelector(".board-col-name");
    const button = node("button", undefined, "board-segment");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(index === boardState.mobileColumn));
    button.append(node("span", name ? name.textContent : column.classList.contains("ghost") ? t("+ Колонка") : "…", "board-pill"));
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
  boardState.locale = getLocale();
  const lanes = $("#board-columns"), flat = $("#board-flat");
  // Перерисовка приходит и посреди набора нового дела (доразбор записи после
  // быстрого добавления перечитывает доску). Снятие поля из DOM даёт blur, а
  // тот закрывает пустое поле — открытость, черновик и фокус возвращаем.
  // Отключённое поле — уже отправляется: его текст не черновик, а снятый с
  // него фокус не выбор человека.
  const openInput = lanes.querySelector(".board-add input:not([hidden]):not(:disabled)");
  const openAdder = boardState.openAdder;
  if (openInput && openAdder) {
    boardState.adderDraft = openInput.value;
    boardState.adderFocus = document.activeElement === openInput;
  }
  // То же — с полем новой колонки.
  const ghostInput = lanes.querySelector(".board-column.ghost input:not([hidden]):not(:disabled)");
  const ghost = ghostInput ? { draft: ghostInput.value, focus: document.activeElement === ghostInput } : null;
  clear(lanes);
  clear(flat);
  boardState.openAdder = openAdder;
  const all = boardAnnotate(source);
  const data = boardFilteredData(all);
  const open = data.columns.flatMap((column) => column.cards);
  const closed = data.closed || [];
  const view = boardState.view;
  $("#board").dataset.view = view;
  lanes.hidden = view !== "board";
  flat.hidden = view === "board";
  paintBoardBar();
  if (view !== "board") {
    clear($("#board-segments"));
    flat.append(boardListEl(open, closed, data));
    return;
  }
  // Доска: колонка на группу первого уровня и «Закрыто» — такая же колонка, по
  // умолчанию первая. Колонки человека — со всем, что у них есть (правятся,
  // «+ Дело в …» и «+ Колонка» с названием). Колонки-группы (день, человек,
  // проект, откуда) заводит человек сам: стоят непустые группы и те, что он
  // добавил через «+ Колонка» (выбор из значений, которых ещё нет на доске), —
  // пустая добавленная остаётся, и под фильтром тоже, пока её не уберут из меню.
  // Заголовок тянется у всех, порядок помнится по полю первого уровня. Пока фильтр
  // что-то отбирает, пустые колонки человека остаются (в них бросают), а «Закрыто»
  // пропадает, только если статус исключает закрытое.
  const [first, ...rest] = boardState.groups;
  const field = first || "all";
  const shown = [];
  if (boardDoneShown()) shown.push({ key: DONE_LANE, element: boardDoneColumnEl(closed, field, rest, data) });
  if (first === "col") for (const group of boardGroups(open, "col", data, true)) shown.push({ key: group.key, element: boardColumnEl(group.column, group.items, rest, data) });
  else if (first) {
    const own = boardState.shown[first] || [];
    for (const group of boardGroups(open, first, data, (group) => own.includes(group.key ?? FILTER_NONE), own)) shown.push({ key: group.key ?? FILTER_NONE, element: boardGroupColumnEl(group, first, rest, data) });
  } else shown.push({ key: "all", element: boardGroupColumnEl({ key: "all", get label() { return t("Все дела"); }, items: open }, null, [], data) });
  for (const lane of boardOrderedLanes(field, shown)) lanes.append(lane.element);
  if (first === "col") {
    lanes.append(boardGhostColumnEl(ghost));
    if (ghost?.focus) lanes.querySelector(".board-column.ghost input")?.focus();
  } else if (first) {
    const choices = boardGroupChoices(first, all, shown.map((lane) => lane.key));
    if (choices.length) lanes.append(boardGroupGhostEl(first, choices, shown.every((lane) => lane.key === DONE_LANE)));
    else boardState.pickOpen = false;
  }
  // Сегмент колонок нужен, когда на телефоне показана одна колонка.
  paintBoardSegments([...lanes.querySelectorAll(".board-column")]);
}
// Панель над доской, поиск и «+ Дело». «+ Дело» открывает поле в первой своей
// колонке; там, где колонок человека нет (список, группы-не-колонки),
// поле встаёт рядом с кнопкой, а дело падает в первую колонку.
{
  $("#board-view").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button || button.dataset.view === boardState.view) return;
    boardState.view = button.dataset.view;
    boardChanged(BOARD_VIEW_KEY);
  });
  $("#board-grp").addEventListener("change", (event) => {
    const select = event.target.closest("select");
    if (!select) return;
    const index = Number(select.dataset.level), field = select.value;
    // Поле, уже занятое другим уровнем, меняется с ним местами: два раза одно и то же не группируют.
    const other = boardState.groups.indexOf(field);
    if (other >= 0 && other !== index) boardState.groups[other] = boardState.groups[index];
    boardState.groups[index] = field;
    boardChanged();
    // Панель перерисована — фокус остаётся на том уровне, где выбирали.
    $("#board-grp").querySelectorAll("select")[index]?.focus();
  });
  $("#board-grp").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    const add = event.target.closest("[data-add]");
    if (remove) boardState.groups.splice(Number(remove.dataset.remove), 1);
    else if (add) boardState.groups.push(Object.keys(BOARD_FIELDS).find((field) => !boardState.groups.includes(field)));
    else return;
    boardChanged();
    // Новый уровень принимает фокус, после «×» он идёт на «+ ещё».
    if (add) [...$("#board-grp").querySelectorAll("select")].at(-1)?.focus();
    else $("#board-grp .board-lv-add")?.focus();
  });
  // Фильтр: кнопка открывает и закрывает строку, а внутри строки — выбор
  // в плашках, «+ условие», «Сегодня» (фильтр по умолчанию) и «Сбросить».
  $("#board-filter-toggle").addEventListener("click", () => {
    boardState.filterOpen = !boardState.filterOpen;
    if (!boardState.filterOpen) boardSetVals(null);
    paintBoardFilter();
  });
  $("#board-filter").addEventListener("change", (event) => {
    // Галочка в списке значений: значение встаёт в условие или уходит из него.
    const box = event.target.closest(".board-vals-pop input");
    if (box) {
      const condition = boardState.filter[Number(box.closest(".board-cond")?.dataset.index)];
      if (!condition) return;
      condition.values = toggleValue(condition.values, box.value);
      boardFilterChanged({ field: condition.field, op: condition.op, part: "values", value: box.value });
      return;
    }
    const select = event.target.closest("select[data-part]");
    const condition = boardState.filter[Number(select?.closest(".board-cond")?.dataset.index)];
    if (!condition) return;
    const part = select.dataset.part;
    boardSetVals(null);
    // Другое поле — другие значения: прежние не подходят, условие снова черновик.
    if (part === "field") { condition.field = select.value; condition.values = []; }
    else condition.op = select.value;
    boardFilterChanged({ field: condition.field, op: condition.op, part });
  });
  $("#board-filter").addEventListener("click", (event) => {
    const row = $("#board-filter");
    const button = event.target.closest(".board-vals-btn");
    const remove = event.target.closest("[data-remove]");
    if (button) {
      const condition = boardState.filter[Number(button.closest(".board-cond")?.dataset.index)];
      if (condition) boardSetVals(boardState.valsOpen === boardCondKey(condition) ? null : boardCondKey(condition));
    } else if (remove) {
      boardSetVals(null);
      boardState.filter.splice(Number(remove.dataset.remove), 1);
      boardFilterChanged();
      row.querySelector(".board-cond-add")?.focus();
    } else if (event.target.closest("[data-add]")) {
      // Новое условие — на первом поле, которого ещё нет; значения выберут сами.
      const used = new Set(boardState.filter.map((condition) => condition.field));
      const condition = { field: Object.keys(FILTER_FIELDS).find((field) => !used.has(field)) || "col", op: "=", values: [] };
      boardSetVals(null);
      boardState.filter.push(condition);
      boardFilterChanged({ field: condition.field, op: condition.op, part: "field" });
    } else if (event.target.closest("[data-subs]")) {
      const mode = event.target.closest("[data-subs]").dataset.subs;
      if (mode === boardState.subs) return;
      boardState.subs = mode;
      boardRememberSubs();
      // Подзадачи приходят карточками (или не приходят) уже с сервера: доска перечитывается.
      paintBoardFilter();
      loadBoard();
    } else if (event.target.closest("[data-today]")) {
      boardSetVals(null);
      boardState.filter = defaultFilter();
      boardFilterChanged();
      row.querySelector(".board-filter-today")?.focus();
    } else if (event.target.closest("[data-clear]")) {
      boardSetVals(null);
      boardState.filter = [];
      boardFilterChanged();
      row.querySelector(".board-cond-add")?.focus();
    }
  });
  // Список значений закрывается и когда фокус ушёл из него на другой элемент (Tab), как меню.
  $("#board-filter").addEventListener("focusout", (event) => {
    if (boardState.valsOpen && event.relatedTarget instanceof Element && !event.relatedTarget.closest(".board-vals")) boardSetVals(null);
  });
  // Список значений и выбор новой колонки закрываются щелчком мимо и Escape, как поповеры шапки.
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (boardState.valsOpen && !target.closest(".board-vals")) boardSetVals(null);
    if (boardState.pickOpen && !target.closest(".board-column.ghost")) boardSetPick(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !boardState.valsOpen) return;
    const open = $("#board-filter").querySelector(".board-vals-btn[aria-expanded='true']");
    boardSetVals(null);
    open?.focus();
  });
  $("#board-search").addEventListener("input", (event) => {
    boardState.search = event.target.value;
    if (boardState.data) renderBoard(boardState.data);
  });
  const quick = $("#board-quick");
  const closeQuick = () => { quick.hidden = true; quick.value = ""; };
  $("#board-new").addEventListener("click", () => {
    const button = $("#board-columns").querySelector(".board-column[data-column-id]:not(.board-done-column) .board-add-button");
    if (button) { button.click(); button.closest(".board-column")?.scrollIntoView({ block: "nearest", inline: "nearest" }); return; }
    quick.hidden = false;
    quick.focus();
  });
  quick.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") return closeQuick();
    if (event.key !== "Enter") return;
    const raw = quick.value.trim();
    if (!raw) return closeQuick();
    quick.disabled = true;
    try {
      await request("/api/captures", { method: "POST", body: JSON.stringify(withProvider({ raw })) });
      quick.value = "";
    } catch (error) { toast(error.message); }
    quick.disabled = false;
    quick.focus();
    await loadBoard();
  });
  quick.addEventListener("blur", () => { if (!quick.value.trim() && !quick.disabled) closeQuick(); });
  // Панель и ленты — сразу по сохранённому выбору, не дожидаясь ответа сервера:
  // первый кадр не должен показывать доску там, где человек оставил список.
  $("#board").dataset.view = boardState.view;
  $("#board-columns").hidden = boardState.view !== "board";
  $("#board-flat").hidden = boardState.view === "board";
  const waiting = $("#board-columns .empty");
  if (waiting && boardState.view !== "board") $("#board-flat").append(waiting);
  paintBoardBar();
}
// Пустое место доски — рука: зажал и повёз влево-вправо, как холст. Карточки,
// шапки колонок и кнопки не задеты — у них свои жесты, рука берёт только фон.
const boardPan = { active: false, pointerId: null, startX: 0, startLeft: 0 };
function boardPanTarget(target) {
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
// Первый переход по хэшу случается до того, как модуль дошёл до состояния
// доски, поэтому оно читается только после ответа сервера.
// Ответ доски без того, что меняет отметка подзадачи: у дела остаётся лишь
// «подзадачи есть или нет», числа не в счёт.
const boardShape = (raw) => JSON.stringify(raw, (key, value) => (key === "subtasks" ? Boolean(value) : value));
const boardCardsOf = (raw) => [...raw.columns.flatMap((column) => column.cards), ...(raw.closed || [])];
// Отличаются только числа подзадач — те же дела, в тех же колонках, в том же
// порядке (при «Скрывать» так бывает, когда шаг отметили в карточке родителя):
// полоски и числа обновляются на месте, а доска не перерисовывается и не сбивает
// ни фокус, ни прокрутку колонок.
// Сравнивается то, по чему доска нарисована (stamp), а не boardState.data: карточка
// при открытии подменяет данные свежими, не перерисовывая доску. Возвращает false,
// если менялось что-то ещё, — тогда рисуется заново.
function boardPatchSubtasks(data, stamp) {
  let before;
  try { before = JSON.parse(boardState.stamp); } catch { return false; }
  if (!boardState.data || boardShape(before) !== boardShape(data)) return false;
  const drawn = new Map();
  for (const element of $("#board").querySelectorAll("[data-capture-id]")) {
    const id = element.dataset.captureId;
    if (!drawn.has(id)) drawn.set(id, []);
    drawn.get(id).push(element);
  }
  for (const card of boardCardsOf(data)) {
    for (const element of drawn.get(card.captureId) || []) {
      const map = element.querySelector(".sub-map");
      if (map) boardSubMaps.get(map)?.(card.subtasks);
    }
  }
  boardState.data = boardAnnotate(data);
  boardState.stamp = stamp;
  return true;
}
// Доска перечитывается по любому поводу, а сразу после открытия — ещё раз из
// общей загрузки. Если ответ тот же, перерисовка только сбила бы фокус, набранное
// в поле и перетаскивание, поэтому без перемен доска не трогается; force —
// когда экран нужно вернуть к данным, даже если те не менялись (отмена правки).
async function loadBoard({ force = false } = {}) {
  const wrap = $("#board-columns");
  if (!wrap.childNodes.length) wrap.append(bindTranslation(node("p", t("Собираем доску…"), "empty"), "Собираем доску…"));
  // Первый разбор адреса зовёт доску раньше, чем модуль дошёл до boardState: читаем его уже после микрозадачи.
  await null;
  const subs = boardState.subs;
  try {
    const data = await request(boardUrl());
    // Переключатель «Подзадачи» нажали, пока шёл ответ: он устарел, доску перечитает само нажатие.
    if (subs !== boardState.subs) return;
    // «Сегодня» могли ещё не открывать: без даты дня сроки на доске выходили
    // бы ISO-строкой вместо «завтра» и «05.09».
    currentDayDate ||= data.today;
    const stamp = JSON.stringify(data);
    const localeChanged = boardState.locale !== getLocale();
    if (!force && !localeChanged && stamp === boardState.stamp) return;
    if (!force && !localeChanged && boardPatchSubtasks(data, stamp)) return;
    boardState.stamp = stamp;
    boardState.data = data;
    renderBoard(data);
  } catch (error) {
    boardState.stamp = null;
    // Ошибка встаёт в ту ленту, что открыта: список живёт в своей.
    const shown = boardState.view === "board" ? wrap : $("#board-flat");
    clear(wrap);
    clear($("#board-flat"));
    shown.hidden = false;
    (shown === wrap ? $("#board-flat") : wrap).hidden = true;
    shown.append(node("p", error.message, "empty"));
  }
}

// ── «Сделано» ────────────────────────────────────────────────────────────────
// Один экран. Вверху в две колонки: слева фраза про неделю, строка её семи
// дней и чипы «куда ушла неделя» по колонкам доски, справа — ритм пяти недель
// клетками. Ниже список по дням — тот же, что во вкладке «Закрыто» на «Сегодня», только за неделю. Клик по
// клетке или по дню в строке недели показывает список этого дня, повторный клик
// и «Все дни» возвращают неделю. Всё берётся из одного ответа GET /api/done —
// с понедельника четыре недели назад по сегодня; фраза, строка и чипы считаются
// на клиенте по последним семи дням. Страница помнит только выбранный день.
// Открывается из заголовка колонки «Закрыто» на доске и по адресу #done.
const DONE_WEEKDAYS = localizedBuiltins(["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"]);
function doneDayWord(date, today) {
  if (date === today) return t("Сегодня");
  if (date === shiftDate(today, -1)) return t("Вчера");
  return DONE_WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}
// Понедельник недели, в которую попадает дата. Функция, а не const: страница
// #done открывается по адресу до того, как модуль дочитан до этого места.
function weekMonday(date) {
  return shiftDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}
// Вернуть закрытое туду в работу: у старой записи-отчёта дела внутри нет.
async function reopenDoneItem(item, button) {
  button.disabled = true;
  try {
    if (item.occurrence && item.projectionId) {
      // Закрыт один день повтора: возвращается он, а не вся запись.
      await request(`/api/projections/${item.projectionId}/undo-complete`, { method: "POST", body: JSON.stringify({ occurrence: item.occurrence }) });
      toast(t("Возвращено в работу"));
      load().catch(() => {});
      await loadDone();
      return;
    }
    const { entry } = await request(`/api/captures/${encodeURIComponent(item.id)}`);
    const closed = completableProjections(entry).filter((projection) => projection.completion?.completed);
    if (!closed.length) throw new Error(t("Это старая запись о сделанном: возвращать в работу нечего"));
    for (const projection of closed) await request(`/api/projections/${projection.id}/undo-complete`, { method: "POST", body: "{}" });
    toast(t("Возвращено в работу"));
    load().catch(() => {});
    await loadDone();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}
function doneRowEl(item) {
  const row = node("div", undefined, `entry dense completed${item.auto ? " auto-done" : ""}`);
  const old = Boolean(item.legacy);
  if (!item.auto) row.dataset.captureId = item.id;
  const mark = node(item.auto || old ? "span" : "button", undefined, `completion-button${item.auto ? " auto" : old ? " static" : ""}`);
  mark.setAttribute("aria-pressed", "true");
  if (item.auto) bindTranslation(mark, "Прошла по календарю", "title");
  else if (!old) {
    mark.type = "button";
    bindTranslation(mark, "Вернуть в работу", "title");
    bindTranslation(mark, "Вернуть в работу: {title}", { title: item.title }, "aria-label");
    mark.addEventListener("click", () => reopenDoneItem(item, mark));
  }
  row.append(mark);
  // Карточка листается по дням страницы; по метке «0/2» — сразу на «Подзадачах».
  const openItem = ({ subtasks = false } = {}) => {
    const list = row.closest(".done-days");
    pendingCardList = list ? { get label() { return t("Сделано"); }, items: rowsAsList([...list.querySelectorAll(".entry[data-capture-id]")]), id: item.id, occurrence: null } : null;
    openReportEntry(item.id, { subtasks });
  };
  if (item.auto) row.append(node("span", item.title, "entry-title"));
  else {
    const title = node("button", item.title, "entry-title");
    title.type = "button";
    title.addEventListener("click", () => openItem());
    row.append(title);
  }
  const meta = node("div", undefined, "entry-meta");
  const subs = item.auto ? null : subtaskBadge(item.subtasks, () => openItem({ subtasks: true }));
  if (subs) meta.append(subs);
  if (item.auto) meta.append(bindTranslation(node("span", t("прошла по календарю"), "tag auto"), "прошла по календарю"));
  else if (item.column && !old) meta.append(node("span", item.column, "tag done-where"));
  meta.append(node("span", item.time, "tag time"));
  row.append(meta);
  return row;
}
const DONE_WEEKS = 5;
const DONE_MONTHS = localizedBuiltins(["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]);
const doneState = { data: null, selected: null, list: null };
// Подписи недель слева от клеток: «31 авг –» — неделя перешла в другой месяц,
// «7–13 сен» — месяц назван, когда он сменился, дальше «14–20» без него.
function doneWeekLabels(mondays) {
  let named = null;
  return mondays.map((monday) => {
    const first = new Date(`${monday}T12:00:00Z`), last = new Date(`${shiftDate(monday, 6)}T12:00:00Z`);
    const month = first.getUTCMonth();
    if (month !== last.getUTCMonth()) {
      named = month;
      return `${first.getUTCDate()} ${DONE_MONTHS[month]} –`;
    }
    const range = `${first.getUTCDate()}–${last.getUTCDate()}`;
    if (named === month) return range;
    named = month;
    return `${range} ${DONE_MONTHS[month]}`;
  });
}
// Густота клетки: 0 — цвет линии, 1 — треть зелёного, 2–3 — две трети, 4+ — весь.
const doneLevel = (n) => (n >= 4 ? "l3" : n >= 2 ? "l2" : n === 1 ? "l1" : "");
// Выбранный день отмечается на месте — без перерисовки страницы, чтобы клавиатурный
// фокус остался на кнопке, которую нажали.
function markDoneSelection() {
  for (const button of $("#done").querySelectorAll("[data-date]")) {
    const on = button.dataset.date === doneState.selected;
    button.classList.toggle("sel", on);
    button.setAttribute("aria-pressed", String(on));
  }
}
function paintDoneList() {
  const { data, selected, list } = doneState;
  clear(list);
  const today = data.today;
  const itemsOn = new Map(data.days.map((day) => [day.date, day.items]));
  const shelf = (title, count, { tone = "", all = false } = {}) => {
    const head = node("h3", undefined, `shelf-head done-day${tone}`);
    head.append(document.createTextNode(title), document.createTextNode(" "), node("span", `· ${count}`, "shelf-n"));
    if (all) {
      const back = bindTranslation(node("button", t("Все дни"), "done-all"), "Все дни");
      back.type = "button";
      back.addEventListener("click", showAllDoneDays);
      head.append(back);
    }
    return head;
  };
  const rowsOf = (items) => {
    const rows = node("div", undefined, "day-rows");
    for (const item of items) rows.append(doneRowEl(item));
    return rows;
  };
  if (selected) {
    // Сегодняшний день — тот же список, что на полке «Сегодня» внизу недели.
    const items = itemsOn.get(selected) || [];
    const isToday = selected === today;
    list.append(shelf(isToday ? t("Сегодня") : longDate(selected), items.length, { tone: isToday ? " today" : "", all: true }));
    if (items.length) list.append(rowsOf(items));
    else list.append(node("p", isToday ? t("Пока ничего.") : t("В этот день ничего не сделано."), "empty"));
    return;
  }
  const from = shiftDate(today, -6);
  for (const day of data.days) {
    if (day.date < from || day.date > today || !day.items.length) continue;
    list.append(shelf(doneDayWord(day.date, today), day.items.length, { tone: day.date === today ? " today" : "" }), rowsOf(day.items));
  }
  if (!list.childNodes.length) list.append(bindTranslation(node("p", t("Пока ничего. Первый кружок — сюда."), "empty"), "Пока ничего. Первый кружок — сюда."));
}
function selectDoneDay(date) {
  doneState.selected = doneState.selected === date ? null : date;
  markDoneSelection();
  paintDoneList();
}
function showAllDoneDays() {
  const date = doneState.selected;
  doneState.selected = null;
  markDoneSelection();
  paintDoneList();
  // Кнопка «Все дни» ушла вместе с полкой дня — фокус переезжает на его клетку.
  $("#done").querySelector(`.done-cell[data-date="${date}"]`)?.focus();
}
function paintDone(data) {
  const page = $("#done");
  clear(page);
  const heading = node("div", undefined, "page-heading");
  heading.append(bindTranslation(node("h2", t("Сделано")), "Сделано"));
  page.append(heading);

  const today = data.today;
  const itemsOn = new Map(data.days.map((day) => [day.date, day.items]));
  const countOn = (date) => itemsOn.get(date)?.length || 0;
  const titleOf = (date) => `${longDate(date)} · ${countOn(date)}`;
  const mondays = Array.from({ length: DONE_WEEKS }, (_, row) => shiftDate(weekMonday(today), (row - DONE_WEEKS + 1) * 7));
  // Выбранный день, которого в клетках уже нет (ночью сменились сутки), сбрасывается.
  if (doneState.selected && (doneState.selected < mondays[0] || doneState.selected > today)) doneState.selected = null;
  doneState.data = data;

  // Неделя — последние семь дней по сегодня; фраза и чипы считаются только по ней.
  const week = Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
  const weekItems = week.flatMap((date) => itemsOn.get(date) || []);
  const meetings = weekItems.filter((item) => item.kind === "meeting").length;

  const summary = node("div", undefined, "done-summary");
  const line = node("p", undefined, "done-line");
  line.append(t("За неделю сделано "), node("b", String(weekItems.length)), t(", из них встреч "), node("b", String(meetings)), t(" · сегодня "), node("b", String(countOn(today)), "g"));

  const strip = node("div", undefined, "done-strip");
  strip.setAttribute("role", "group");
  bindTranslation(strip, "Последние семь дней", "aria-label");
  for (const date of week) {
    const n = countOn(date);
    const button = node("button", undefined, `done-wd${date === today ? " today" : ""}${n ? "" : " z"}`);
    button.type = "button";
    button.dataset.date = date;
    button.title = titleOf(date);
    button.setAttribute("aria-label", titleOf(date));
    button.append(shortDate(date), " ", node("b", n ? String(n) : "–"));
    strip.append(button);
  }

  // Чипы «куда ушла неделя»: колонки доски по убыванию, встречи — синим и последними.
  const chips = node("div", undefined, "done-chips");
  const byColumn = new Map();
  for (const item of weekItems) if (item.kind !== "meeting") byColumn.set(item.column, (byColumn.get(item.column) || 0) + 1);
  const chip = (name, n, className = "done-chip") => {
    const element = node("span", undefined, className);
    element.append(name, " ", node("b", String(n)));
    chips.append(element);
  };
  for (const [name, n] of [...byColumn].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))) chip(name, n);
  if (meetings) chip(t("Встречи"), meetings, "done-chip meet");
  summary.append(line, strip, chips);

  const rhythm = node("div", undefined, "done-rhythm");
  const grid = node("div", undefined, "done-grid");
  grid.setAttribute("role", "group");
  bindTranslation(grid, "Ритм за {DONE_WEEKS} недель", { DONE_WEEKS: DONE_WEEKS }, "aria-label");
  grid.append(node("span"));
  for (const name of CAL_DOW) grid.append(node("span", name, "done-grid-hd"));
  const labels = doneWeekLabels(mondays);
  mondays.forEach((monday, row) => {
    grid.append(node("span", labels[row], "done-grid-lbl"));
    for (let column = 0; column < 7; column += 1) {
      const date = shiftDate(monday, column);
      const cell = node("button", undefined, "done-cell");
      cell.type = "button";
      if (date > today) {
        cell.classList.add("future");
        cell.disabled = true;
        bindTranslation(cell, "{value1} · ещё не наступил", { value1: longDate(date) }, "aria-label");
      } else {
        const level = doneLevel(countOn(date));
        if (level) cell.classList.add(level);
        if (date === today) cell.classList.add("today");
        cell.dataset.date = date;
        cell.title = titleOf(date);
        cell.setAttribute("aria-label", titleOf(date));
      }
      grid.append(cell);
    }
  });
  rhythm.append(bindTranslation(node("p", t("Ритм · {DONE_WEEKS} недель", { DONE_WEEKS: DONE_WEEKS }), "done-cap"), "Ритм · {DONE_WEEKS} недель", { DONE_WEEKS: DONE_WEEKS }), grid);

  const top = node("div", undefined, "done-top");
  top.append(summary, rhythm);
  top.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-date]");
    if (button && !button.disabled) selectDoneDay(button.dataset.date);
  });
  const list = node("div", undefined, "done-days drawer");
  doneState.list = list;
  page.append(top, list);
  markDoneSelection();
  paintDoneList();
}
// Пять недель одним запросом: с понедельника четыре недели назад по сегодня.
// До первого await здесь нельзя трогать const из этого раздела: при открытии
// #done по адресу функция стартует раньше, чем модуль до них дошёл.
async function loadDone({ fresh = false } = {}) {
  const page = $("#done");
  if (!page.childNodes.length) page.append(bindTranslation(node("p", t("Считаем сделанное…"), "empty"), "Считаем сделанное…"));
  try {
    const range = (today) => `from=${shiftDate(weekMonday(today), -28)}&to=${today}`;
    const guess = currentDayDate || zoneDate(new Date());
    let data = await request(`/api/done?${range(guess)}`);
    // Часы страницы и сервера разошлись на границе суток — берём день сервера.
    if (data.today !== guess) data = await request(`/api/done?${range(data.today)}`);
    currentDayDate ||= data.today;
    if (fresh) doneState.selected = null;
    paintDone(data);
  } catch (error) {
    clear(page);
    page.append(node("p", error.message, "empty"));
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
const CAL_DOW = localizedBuiltins(["пн", "вт", "ср", "чт", "пт", "сб", "вс"]);
const CAL_MONTHS = localizedBuiltins(["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]);
const CAL_MONTHS_G = localizedBuiltins(["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]);
const CAL_PHONE = window.matchMedia("(max-width: 760px)");
const calState = { mode: "week", anchor: null, days: 7, data: null, hidden: new Set(), seq: 0, drag: null, pop: null, popAnchorId: null, scrollTop: null, gridScroll: null, search: "" };
try {
  const storedMode = uiStorage.getItem("kizuna-calendar-mode");
  if (["day", "week", "month"].includes(storedMode)) calState.mode = storedMode;
  else if (CAL_PHONE.matches) calState.mode = "day";
  const storedHidden = JSON.parse(uiStorage.getItem("kizuna-calendar-hidden") || "[]");
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
  if (calState.mode === "day") return calHuman(from) + (from === calToday() ? t(" · сегодня") : "");
  if (calState.mode === "month") { const d = calParse(calState.anchor || calToday()); return `${CAL_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${CAL_MONTHS_G[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  return `${a.getUTCDate()} ${CAL_MONTHS_G[a.getUTCMonth()]} – ${b.getUTCDate()} ${CAL_MONTHS_G[b.getUTCMonth()]}`;
}
function setCalendarMode(mode) {
  calState.mode = mode;
  try { uiStorage.setItem("kizuna-calendar-mode", mode); } catch {}
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
  const circle = calState.data?.circleMarks?.[item.id] || todayState.circleMarks?.[item.id] || null;
  if (circle && calState.hidden.has(`circle:${circle.id}`)) return false;
  if (circle && (todayState.circles || []).some((item2) => item2.id === circle.id && item2.muted)) return false;
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
  if (!wrap.childNodes.length) wrap.append(bindTranslation(node("p", t("Собираем календарь…"), "empty"), "Собираем календарь…"));
  try {
    const data = await request(`/api/calendar?from=${from}&to=${to}`);
    if (seq !== calState.seq) return;
    calState.data = pruneRemovedExternal(data);
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
      try { uiStorage.setItem("kizuna-calendar-hidden", JSON.stringify([...calState.hidden])); } catch {}
      renderCalendar();
    });
    button.setAttribute("aria-pressed", String(!calState.hidden.has(key)));
    const dot = node("i", undefined, "cal-dot");
    if (color) dot.style.background = color;
    button.append(dot, node("span", label));
    if (extra) button.append(node("small", extra));
    return button;
  };
  wrap.append(chip("kind:task", t("Дела"), "var(--type-todo)"), chip("kind:meeting", t("Встречи"), "var(--type-meeting)"));
  for (const account of data.accounts) {
    if (account.disabled) continue;
    wrap.append(chip(`account:${account.id}`, account.label, account.color || "var(--n-72)", account.syncError ? t("ошибка") : account.mode === "busy" ? t("занято") : null));
  }
  // Круги встают в ту же полосу: нажатие вычёркивает круг из недели, как
  // вычёркивает чужой календарь. Это взгляд, а не решение — выключают круг
  // на его странице.
  for (const circle of todayState.circles || [])
    wrap.append(chip(`circle:${circle.id}`, circle.name, `var(--circle-${CIRCLE_TONES[circle.color] || "violet"})`, circle.muted ? t("выключен") : null));
  return wrap;
}
function calToolbarEl() {
  const top = node("div", undefined, "cal-top");
  const nav = node("span", undefined, "cal-nav");
  nav.append(calButton("‹", "cal-nav-btn", () => calStep(-1)), calButton(t("Сегодня"), "cal-nav-today", () => { calState.anchor = calToday(); loadCalendar(); }), calButton("›", "cal-nav-btn", () => calStep(1)));
  const title = node("h3", calTitle(), "cal-title");
  const seg = node("div", undefined, "cal-seg");
  seg.setAttribute("role", "group");
  for (const [mode, label, key] of [["day", t("День"), "D"], ["week", t("Неделя"), "W"], ["month", t("Месяц"), "M"]]) {
    const button = calButton(undefined, undefined, () => { setCalendarMode(mode); if (mode === "week") calState.days = 7; loadCalendar(); });
    button.append(node("span", label), node("kbd", key));
    button.setAttribute("aria-pressed", String(calState.mode === mode));
    seg.append(button);
  }
  top.append(nav, title, seg);
  return top;
}
// Приглашение, на которое вы ещё не ответили, стоит в сетке незакрашенным и
// пунктиром — как в Календаре macOS: событие уже занимает время, но оно ещё не
// ваше. Прошедший день не метим: ответ там уже ничего не решает.
const calAwaitingAnswer = (item) => item.kind === "external" && item.me?.status === "needs-action" && item.date >= calToday();
function calChipEl(item, { overdue = false } = {}) {
  const chip = node("div", undefined, `cal-chip ${item.kind}${item.done ? " done" : ""}${overdue || item.overdue ? " late" : ""}${calAwaitingAnswer(item) ? " unanswered" : ""}`);
  chip.dataset.id = item.id;
  if (item.kind === "external" && item.editable) { chip.draggable = true; chip.dataset.own = "1"; }
  if (item.kind !== "external") {
    chip.draggable = !item.done;
    chip.dataset.own = "1";
    chip.dataset.occ = item.date;
    const box = calButton(undefined, `cal-box${item.kind === "meeting" ? " meeting" : ""}${item.done ? " is-done" : ""}`, (event) => { event.stopPropagation(); toggleCalendarDone(item); });
    box.title = item.recurring ? t("Готово: убрать этот повтор, серия останется") : item.done ? t("Вернуть в работу") : t("Готово");
    if (item.kind === "meeting" && !item.done) box.innerHTML = BOARD_CLOCK;
    chip.append(box);
  } else if (item.color) chip.style.setProperty("--cal-c", item.color);
  chip.append(node("span", item.title, "cal-chip-title"));
  const tomorrow = item.kind !== "external" ? tomorrowAction({ id: item.id, title: item.title, schedule: { date: item.date, time: item.time }, occurrence: item.recurring ? item.date : null, done: item.done }) : null;
  if (tomorrow) chip.append(tomorrow);
  if (item.kind !== "external" && item.recurring) { const repeat = node("i", "⟳", "cal-chip-repeat"); repeat.title = item.repeat || t("Повторяется"); chip.append(repeat); }
  chip.title = item.recurring && item.repeat ? `${item.title} · ${item.repeat}` : item.title;
  chip.addEventListener("click", () => openCalendarItem(item));
  return chip;
}
// Раскладка дня: блоки, пересекающиеся по времени, встают рядом, как в
// Календаре Apple, а не друг на друга — иначе дело в 11:00 целиком закрывало
// встречу того же часа. Пересечение считается по видимому блоку: короткое
// событие тянется до высоты 18px и тоже налезает на соседа. Группа
// пересекающихся делится на колонки жадно, по началу (длинное — левее), а
// блок растягивается вправо на соседние колонки, пока они свободны.
const CAL_EV_MIN_PX = 18;
function calLayoutDay(items) {
  const boxes = items.map((item) => {
    const start = calMinutes(item.time);
    return { item, start, end: Math.max(calMinutes(calEndOf(item)), start + (CAL_EV_MIN_PX / CAL_HOUR_PX) * 60) };
  }).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const places = new Map();
  let group = [], columns = [], groupEnd = -Infinity;
  const settle = () => {
    for (const box of group) {
      let span = 1;
      while (box.col + span < columns.length && !columns[box.col + span].some((other) => other.start < box.end && other.end > box.start)) span += 1;
      places.set(box.item, { col: box.col, span, cols: columns.length });
    }
    group = []; columns = []; groupEnd = -Infinity;
  };
  for (const box of boxes) {
    if (box.start >= groupEnd) settle();
    let col = columns.findIndex((column) => column[column.length - 1].end <= box.start);
    if (col < 0) { col = columns.length; columns.push([]); }
    columns[col].push(box);
    box.col = col;
    group.push(box);
    groupEnd = Math.max(groupEnd, box.end);
  }
  settle();
  return places;
}
function calEventEl(item, place = null) {
  const start = calMinutes(item.time), end = calMinutes(calEndOf(item));
  const top = ((start - CAL_H0 * 60) / 60) * CAL_HOUR_PX;
  const height = Math.max(((end - start) / 60) * CAL_HOUR_PX - 2, CAL_EV_MIN_PX);
  const element = node("div", undefined, `cal-ev ${item.kind}${item.done ? " done" : ""}${item.overdue ? " late" : ""}${height < 34 ? " short" : ""}${calAwaitingAnswer(item) ? " unanswered" : ""}`);
  element.style.top = `${top}px`;
  element.style.height = `${height}px`;
  // Место в группе пересекающихся; одиночный блок — во всю ширину, как раньше.
  if (place && place.cols > 1) {
    element.style.setProperty("--col", String(place.col));
    element.style.setProperty("--span", String(place.span));
    element.style.setProperty("--cols", String(place.cols));
  }
  element.dataset.id = item.id;
  if (item.kind !== "external") { element.draggable = !item.done; element.dataset.own = "1"; element.dataset.occ = item.date; }
  else { if (item.editable) { element.draggable = true; element.dataset.own = "1"; } if (item.color) element.style.setProperty("--cal-c", item.color); }
  const title = node("b", undefined);
  // Своё дело или встреча со временем закрывается кружком прямо в сетке —
  // как дело «без времени»: открывать карточку ради одного нажатия незачем.
  if (item.kind !== "external") {
    const box = calButton(undefined, `cal-box${item.kind === "meeting" ? " meeting" : ""}${item.done ? " is-done" : ""}`, (event) => { event.stopPropagation(); toggleCalendarDone(item); });
    box.title = item.recurring ? t("Готово: убрать этот повтор, серия останется") : item.done ? t("Вернуть в работу") : t("Готово");
    box.setAttribute("aria-label", `${box.title}: ${item.title}`);
    box.draggable = false;
    if (item.kind === "meeting" && !item.done) box.innerHTML = BOARD_CLOCK;
    title.append(box);
  }
  title.append(node("span", `${item.time} `, "cal-ev-time"), document.createTextNode(item.title));
  element.append(title);
  const tomorrow = item.kind !== "external" ? tomorrowAction({ id: item.id, title: item.title, schedule: { date: item.date, time: item.time }, occurrence: item.recurring ? item.date : null, done: item.done }) : null;
  if (tomorrow) { element.classList.add("has-tomorrow"); element.append(tomorrow); }
  const sub = item.kind === "external" ? item.calendarName || item.source : [item.project, ...(item.people || [])].filter(Boolean).join(" · ");
  if (sub) element.append(node("small", sub));
  // Повтор — значком в правом верхнем углу, как в Apple.
  if (item.repeat || item.recurring) { const repeat = node("i", "⟳", "cal-ev-repeat"); repeat.title = item.repeat || t("Повторяется"); element.append(repeat); }
  if (safeExternalUrl(item.joinUrl) && height >= 34) {
    const join = bindTranslation(node("a", t("К звонку"), "cal-join"), "К звонку");
    join.href = safeExternalUrl(item.joinUrl); join.target = "_blank"; join.rel = "noopener";
    bindTranslation(join, "Открыть видеовстречу: {value1}", { value1: popHost(item.joinUrl) || t("ссылка") }, "title");
    join.addEventListener("click", (event) => event.stopPropagation());
    element.append(join);
  }
  element.title = `${item.time}–${calEndOf(item)} ${item.title}${item.repeat ? ` · ${item.repeat}` : ""}`;
  element.addEventListener("click", () => openCalendarItem(item));
  return element;
}
// Высота сетки. По умолчанию сетка дотягивается до низа окна: подсказка под
// ней остаётся на экране, а часов видно столько, сколько помещается. Нижний
// край сетки тянется рукой, как край карточки ввода: высота запоминается в
// браузере, двойной клик по краю возвращает подгонку под окно.
const CAL_HEIGHT = { min: 240, key: "kizuna-calendar-height" };
function storedCalendarHeight() {
  try {
    const value = Number(uiStorage.getItem(CAL_HEIGHT.key));
    return Number.isFinite(value) && value >= CAL_HEIGHT.min ? value : null;
  } catch {
    return null;
  }
}
function fitCalendarHeight() {
  const wrap = $("#calendar-view");
  const scroll = wrap?.querySelector(".cal-scroll");
  // Пока край тянут рукой, высоту задаёт рука, а не окно.
  if (!scroll?.getClientRects().length || wrap.classList.contains("resizing")) return;
  const stored = storedCalendarHeight();
  if (stored) { wrap.style.setProperty("--cal-height", `${Math.min(stored, Math.max(CAL_HEIGHT.min, window.innerHeight - 180))}px`); return; }
  const apply = (height) => wrap.style.setProperty("--cal-height", `${Math.round(Math.max(CAL_HEIGHT.min, height))}px`);
  // На телефоне сетка во весь экран забирала бы прокрутку страницы себе.
  if (window.matchMedia("(max-width: 760px)").matches) { apply(window.innerHeight * 0.6); return; }
  // Сетке достаётся окно за вычетом того, что над ней, и того, что под ней до
  // конца страницы: подсказки и нижних полей. Считается за один раз — сетка,
  // промежуточно выросшая на поля, сбила бы свою прокрутку и закрыла плашку.
  const grid = scroll.getBoundingClientRect();
  // Считаем от конца содержимого: минимальная высота body оставляет пустоту
  // под уменьшенной рукой сеткой, но при подгонке её нужно вернуть сетке.
  const below = scroll.closest("main").getBoundingClientRect().bottom - grid.bottom;
  apply(window.innerHeight - (grid.top + window.scrollY) - below);
}
window.addEventListener("resize", () => { if (!$("#calendar")?.hidden) fitCalendarHeight(); });
function calResizeEl() {
  const grip = node("div", undefined, "cal-resize");
  bindTranslation(grip, "Потяните, чтобы изменить высоту. Двойной клик — по высоте окна", "title");
  grip.setAttribute("aria-hidden", "true");
  grip.addEventListener("dblclick", () => {
    try { uiStorage.removeItem(CAL_HEIGHT.key); } catch {}
    fitCalendarHeight();
  });
  grip.addEventListener("pointerdown", (event) => {
    const scroll = grip.parentElement?.querySelector(".cal-scroll");
    if (event.button !== 0 || !scroll) return;
    const wrap = $("#calendar-view");
    const startY = event.clientY, startHeight = Math.round(scroll.getBoundingClientRect().height);
    // Выше самих часов тянуть незачем: под сеткой осталась бы пустота.
    const tallest = scroll.scrollHeight;
    let height = startHeight;
    grip.setPointerCapture(event.pointerId);
    wrap.classList.add("resizing");
    event.preventDefault();
    const move = (e) => {
      height = Math.round(Math.min(tallest, Math.max(CAL_HEIGHT.min, startHeight + e.clientY - startY)));
      wrap.style.setProperty("--cal-height", `${height}px`);
    };
    // Сетку могут перерисовать посреди движения — пришло обновление журнала, —
    // и ручка уйдёт со страницы вместе со своими слушателями. Поэтому движение
    // слушает окно: до него события доходят и от новой ручки, и без неё.
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      wrap.classList.remove("resizing");
      if (height !== startHeight) {
        try { uiStorage.setItem(CAL_HEIGHT.key, String(height)); } catch {}
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });
  return grip;
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
  lane.append(bindTranslation(node("div", t("без времени"), "cal-nt-label"), "без времени"));
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
    const timed = external.filter((entry) => !entry.allDay).concat(own.filter((entry) => entry.time !== null));
    const places = calLayoutDay(timed);
    for (const item of timed) col.append(calEventEl(item, places.get(item)));
    if (isToday) { const line = node("div", undefined, "cal-now"); line.style.top = `${((nowMinutes - CAL_H0 * 60) / 60) * CAL_HOUR_PX}px`; col.append(line); }
    grid.append(col);
  }
  scroll.append(grid);
  const wrap = node("div", undefined, "cal-week");
  wrap.append(head, lane, scroll, calResizeEl());
  // Первый показ — с восьми утра; при перерисовке прокрутка остаётся прежней.
  requestAnimationFrame(() => { if (calState.scrollTop === null) { scroll.scrollTop = (Math.max(CAL_H0, 8) - CAL_H0) * CAL_HOUR_PX - 10; calState.gridScroll = scroll.scrollTop; } });
  return wrap;
}
function calAgendaEl(date) {
  const { own, external } = calItemsOf(date);
  const aside = node("aside", undefined, "cal-agenda");
  const overdue = date === calToday() ? (calState.data.overdue || []).filter(calOwnVisible).map((item) => ({ ...item, overdue: true })) : [];
  const noTime = own.filter((item) => item.time === null).concat(overdue, external.filter((item) => item.allDay));
  aside.append(bindTranslation(node("h4", t("Без времени · {length}", { length: noTime.length })), "Без времени · {length}", { length: noTime.length }));
  if (!noTime.length) aside.append(bindTranslation(node("p", t("пусто"), "cal-free"), "пусто"));
  for (const item of noTime) aside.append(calChipEl(item));
  aside.append(bindTranslation(node("h4", t("По часам")), "По часам"));
  const timed = own.filter((item) => item.time !== null).concat(external.filter((item) => !item.allDay)).sort((a, b) => calMinutes(a.time) - calMinutes(b.time));
  if (!timed.length) aside.append(bindTranslation(node("p", t("свободный день"), "cal-free"), "свободный день"));
  let cursor = 9 * 60;
  for (const item of timed) {
    const start = calMinutes(item.time);
    if (start - cursor >= 60) aside.append(bindTranslation(node("p", t("свободно {value1} ч{value2}", { value1: Math.floor((start - cursor) / 60), value2: (start - cursor) % 60 ? t(" {value1} мин", { value1: (start - cursor) % 60 }) : "" }), "cal-free"), "свободно {value1} ч{value2}", { value1: Math.floor((start - cursor) / 60), value2: (start - cursor) % 60 ? t(" {value1} мин", { value1: (start - cursor) % 60 }) : "" }));
    const waiting = calAwaitingAnswer(item);
    const row = node("div", undefined, `cal-row ${item.kind}${item.done ? " done" : ""}${waiting ? " unanswered" : ""}`);
    row.append(node("time", item.time));
    const text = node("span", item.title, "cal-row-title");
    const meta = node("small", item.kind === "external" ? `${item.source}${waiting ? t(" · без ответа") : ""}` : t("до {value1}{value2}", { value1: calEndOf(item), value2: item.project ? ` · ${item.project}` : "" }));
    const body = node("span", undefined, "cal-row-body");
    body.append(text, meta);
    row.append(body);
    if (safeExternalUrl(item.joinUrl)) { const join = bindTranslation(node("a", t("К звонку"), "cal-join"), "К звонку"); join.href = safeExternalUrl(item.joinUrl); join.target = "_blank"; join.rel = "noopener"; bindTranslation(join, "Открыть видеовстречу: {value1}", { value1: popHost(item.joinUrl) || t("ссылка") }, "title"); join.addEventListener("click", (event) => event.stopPropagation()); row.append(join); }
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
    if (items.length > 3) cell.append(bindTranslation(node("div", t("ещё {value1}", { value1: items.length - 3 }), "cal-more"), "ещё {value1}", { value1: items.length - 3 }));
    wrap.append(cell);
  }
  return wrap;
}
function renderCalendar() {
  const wrap = $("#calendar-view");
  if (!calState.data) return;
  // Перерисовка в фоне — пришло обновление журнала — не должна сбрасывать
  // прокрутку сетки и закрывать открытую плашку: плашка остаётся, если её
  // событие после перерисовки стоит на том же месте.
  const keepId = calState.pop ? calState.popAnchorId : null;
  const anchorBefore = keepId ? wrap.querySelector(`[data-id="${CSS.escape(keepId)}"]`)?.getBoundingClientRect() : null;
  calState.scrollTop = wrap.querySelector(".cal-scroll")?.scrollTop ?? null;
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
  const scroll = wrap.querySelector(".cal-scroll");
  if (scroll && calState.scrollTop !== null) { scroll.scrollTop = calState.scrollTop; calState.gridScroll = scroll.scrollTop; }
  const anchorAfter = keepId ? wrap.querySelector(`[data-id="${CSS.escape(keepId)}"]`)?.getBoundingClientRect() : null;
  const samePlace = anchorBefore && anchorAfter && Math.abs(anchorBefore.top - anchorAfter.top) < 1 && Math.abs(anchorBefore.left - anchorAfter.left) < 1;
  if (calState.pop && !samePlace) closeCalendarPop();
  const hint = node("p", undefined, "cal-hint");
  hint.append(node("kbd", "D"), node("kbd", "W"), node("kbd", "M"), document.createTextNode(t(" виды · ")), node("kbd", "T"), document.createTextNode(t(" сегодня · ")), node("kbd", "←"), node("kbd", "→"), document.createTextNode(t(" листать · ")), node("kbd", "1"), document.createTextNode("–"), node("kbd", "7"), document.createTextNode(t(" дней · тяните дела, встречи и чужие события, клик по пустому месту — новая запись")));
  wrap.append(hint);
  fitCalendarHeight();
}
// Встреча из уведомления открывается на своём дне и сразу плашкой: искать её
// глазами по неделе незачем. Отменённой встречи в сетке нет — тогда просто день.
function openCalendarAt(date, { uid = null, id = null } = {}) {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (uid) params.set("event", uid);
  if (id) params.set("item", id);
  const target = `#calendar${params.size ? `?${params}` : ""}`;
  if (location.hash === target) updatePageFromHash();
  else location.hash = target;
}
async function openCalendarEvent({ uid = null, id = null, date = null } = {}) {
  const external = calState.data?.external || [];
  const item = external.find((candidate) => (id ? candidate.id === id : candidate.uid === uid) && (!date || candidate.date === date))
    || external.find((candidate) => (id ? candidate.id === id : candidate.uid === uid));
  if (!item) return;
  const view = $("#calendar-view");
  const anchor = view?.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  const scroll = view?.querySelector(".cal-scroll");
  if (anchor && scroll && !item.allDay && scroll.contains(anchor)) {
    scroll.scrollTop = Math.max(0, anchor.offsetTop - 60);
    calState.gridScroll = scroll.scrollTop;
    calState.scrollTop = scroll.scrollTop;
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  showExternalEvent(item);
}
// Клик по своему делу — карточка записи; по чужому событию — плашка с тем,
// что известно, и «Взять в память».
function openCalendarItem(item) {
  if (item.kind !== "external") {
    // Свои дела окна — по времени, просроченное первым: этим списком карточка
    // и листается, и ведёт к следующему после «Готово».
    const own = [...(calState.data?.overdue || []), ...(calState.data?.items || [])].filter(calOwnVisible)
      .sort((left, right) => left.date.localeCompare(right.date) || (left.time || "99:99").localeCompare(right.time || "99:99"));
    pendingCardList = { get label() { return t("Календарь"); }, items: own.map((candidate) => ({ id: candidate.id, occurrence: candidate.recurring ? candidate.date : null })), id: item.id, occurrence: item.recurring ? item.date : null };
    openReportEntry(item.id, { occurrence: item.recurring ? item.date : null });
    return;
  }
  showExternalEvent(item);
}
function closeCalendarPop() {
  calState.pop?.remove();
  calState.pop = null;
  calState.popAnchorId = null;
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
  calState.popAnchorId = anchorElement.dataset.id || null;
  const away = (event) => { if (!pop.contains(event.target)) closeCalendarPop(); };
  // Прокрутка сетки закрывает плашку, но не та, что сделала сама перерисовка,
  // возвращая сетку на прежнее место: у неё положение известно заранее.
  const drift = (event) => {
    if (pop.contains(event.target)) return;
    if (event.target instanceof Element && event.target.classList.contains("cal-scroll") && event.target.scrollTop === calState.gridScroll) return;
    closeCalendarPop();
  };
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
const POP_STATUS = localizedBuiltins({ accepted: ["✓", "принято"], declined: ["✕", "отклонено"], tentative: ["?", "под вопросом"], "needs-action": ["·", "без ответа"], delegated: ["→", "передано"] });
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
    bindTranslation(select, "Календарь события", "aria-label");
    for (const calendar of writable) { const option = node("option", calendar.name); option.value = calendar.id; option.selected = calendar.id === item.calendarId; select.append(option); }
    select.addEventListener("change", async () => {
      select.disabled = true;
      try { await request(`/api/calendar/external/${encodeURIComponent(item.id)}/move`, { method: "POST", body: JSON.stringify({ calendarId: select.value }) }); toast(t("Перенесено в календарь «{textContent}»", { textContent: select.selectedOptions[0].textContent })); closeCalendarPop(); await loadCalendar(); }
      catch (error) { toast(error.message); select.disabled = false; }
    });
    calPick.append(select);
  } else calPick.append(node("span", item.calendarName || item.source));
  head.append(calPick);
  if (item.editable) {
    bindTranslation(title, "Переименовать", "title"); title.tabIndex = 0;
    const rename = () => {
      const input = node("input", undefined, "cal-pop-rename");
      input.type = "text"; input.value = item.title; input.maxLength = 300; bindTranslation(input, "Название события", "aria-label");
      title.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        const next = input.value.trim();
        if (!save || !next || next === item.title) { input.replaceWith(title); return; }
        input.disabled = true;
        try { await patch({ title: next }, t("Переименовано в {source}", { source: item.source })); } catch { input.replaceWith(title); }
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
  if (safeExternalUrl(item.href)) { const open = bindTranslation(node("a", t("Открыть"), "cal-pop-btn small"), "Открыть"); open.href = safeExternalUrl(item.href); open.target = "_blank"; open.rel = "noopener"; source.append(open); }
  pop.append(source);
  // ── когда ──
  const when = popSection();
  const year = calParse(item.date).getUTCFullYear();
  const whenText = item.allDay ? t("{value1} {year} · весь день{value3}", { value1: calHuman(item.date), year: year, value3: item.days > 1 ? t(" · {value1} дн.", { value1: item.days }) : "" }) : `${calHuman(item.date)} ${year}  ${item.time} – ${item.end}`;
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
      const marks = [attendee.organizer ? t("организатор") : null, attendee.self ? t("вы") : null, attendee.optional ? t("необязательно") : null].filter(Boolean);
      if (marks.length) row.append(node("small", `(${marks.join(", ")})`));
      people.append(row);
    }
    pop.append(people);
  }
  // ── ссылки ──
  if (safeExternalUrl(item.joinUrl)) {
    const video = popSection("pop-link");
    const link = node("a", item.joinUrl.replace(/^https?:\/\//, ""));
    link.href = safeExternalUrl(item.joinUrl); link.target = "_blank"; link.rel = "noopener";
    video.append(bindTranslation(node("span", t("Ссылка на видеовстречу: ")), "Ссылка на видеовстречу: "), link);
    pop.append(video);
  }
  const eventUrl = item.url !== item.joinUrl ? safeExternalUrl(item.url) : null;
  if (eventUrl) { const urlSec = popSection("pop-link"); const link = node("a", eventUrl.replace(/^https?:\/\//, "")); link.href = eventUrl; link.target = "_blank"; link.rel = "noopener"; urlSec.append(link); pop.append(urlSec); }
  // ── мой ответ ──
  if (item.me) {
    const me = popSection("pop-me");
    const line = node("div", undefined, "pop-me-line");
    line.append(bindTranslation(node("span", t("Мой ответ:"), "pop-me-label"), "Мой ответ:"), popStatusIcon(item.me.status), node("b", POP_STATUS[item.me.status]?.[1] || t("без ответа")));
    me.append(line);
    const comment = node("input", undefined, "pop-comment");
    comment.type = "text"; bindTranslation(comment, "Комментарий организатору", "placeholder"); comment.maxLength = 500; comment.value = item.me.comment || "";
    bindTranslation(comment, "Комментарий организатору", "aria-label");
    const respond = async (status) => {
      for (const button of buttons.children) button.disabled = true;
      try {
        const body = { status, ...(comment.value.trim() !== (item.me.comment || "") ? { comment: comment.value.trim() } : {}) };
        await request(`/api/calendar/external/${encodeURIComponent(item.id)}/respond`, { method: "POST", body: JSON.stringify(body) });
        toast(t("Ответ отправлен: {value1}", { value1: POP_STATUS[status][1] }));
        closeCalendarPop();
        await loadCalendar();
      } catch (error) { toast(error.message); for (const button of buttons.children) button.disabled = false; }
    };
    const buttons = node("div", undefined, "pop-me-buttons");
    // Текущий ответ — не кнопка призыва, а отметка состояния: цветом статуса,
    // с галочкой и без нажатия. Чёрная заливка читалась как «нажми меня».
    for (const [status, label, chosen] of [["accepted", t("Принять"), t("Принято")], ["tentative", t("Под вопросом"), t("Под вопросом")], ["declined", t("Отклонить"), t("Отклонено")]]) {
      const current = item.me.status === status;
      const button = calButton(current ? `${POP_STATUS[status][0]} ${chosen}` : label, `cal-pop-btn small${current ? ` is-current ${status}` : ""}`, () => respond(status));
      button.setAttribute("aria-pressed", String(current));
      if (current) { button.disabled = true; bindTranslation(button, "Ваш текущий ответ", "title"); }
      buttons.append(button);
    }
    comment.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter") { keyEvent.preventDefault(); respond(item.me.status === "needs-action" ? "accepted" : item.me.status); } });
    me.append(buttons, comment);
    pop.append(me);
  }
  // ── действия ──
  const actions = node("div", undefined, "cal-pop-actions");
  if (safeExternalUrl(item.joinUrl)) { const join = bindTranslation(node("a", t("Присоединиться"), "cal-pop-btn primary"), "Присоединиться"); join.href = safeExternalUrl(item.joinUrl); join.target = "_blank"; join.rel = "noopener"; actions.append(join); }
  const take = calButton(t("Взять в память"), `cal-pop-btn${item.joinUrl ? "" : " primary"}`, async () => {
    take.disabled = true;
    try {
      const d = calParse(item.date);
      const numeric = `${calPad(d.getUTCDate())}.${calPad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
      const raw = item.allDay ? t("{title} — {numeric}, весь день (из календаря {source})", { title: item.title, numeric: numeric, source: item.source }) : t("{title} — {numeric} в {time}{value4}{value5} (из календаря {source})", { title: item.title, numeric: numeric, time: item.time, value4: item.end ? `–${item.end}` : "", value5: item.location ? `, ${item.location}` : "", source: item.source });
      await request("/api/captures", { method: "POST", body: JSON.stringify({ raw }) });
      toast(t("Событие записано в память"));
      closeCalendarPop();
      await load();
      await loadCalendar();
    } catch (error) { toast(error.message); take.disabled = false; }
  });
  actions.append(take);
  if (item.editable) {
    // Событие уходит с экрана сразу, а удаление в чужом календаре идёт следом:
    // ждать чужой сервер, держа плашку «занятой», значит подвесить окно на
    // секунды. Ответ придёт тостом; ошибка вернёт событие на место.
    const erase = (scope) => {
      const series = scope === "series";
      const key = externalKey(item.id);
      const forget = removeExternalFromView(series && item.seriesId
        ? (other) => other.accountId === item.accountId && other.seriesId === item.seriesId
        : (other) => externalKey(other.id) === key);
      closeCalendarPop();
      request(`/api/calendar/external/${encodeURIComponent(item.id)}${scope ? `?scope=${scope}` : ""}`, { method: "DELETE" })
        .then(() => {
          forget();
          toast(series ? t("Серия «{title}» удалена из {source}", { title: item.title, source: item.source }) : t("Удалено из {source}", { source: item.source }));
          // Сервер мог убрать больше нашего — у CalDAV одиночное событие
          // лежит файлом целиком, — поэтому сверяемся с ним.
          todayState.calendarStale = true;
          if (calState.data) loadCalendar();
          renderToday();
        })
        .catch((error) => {
          forget();
          toast(t("«{title}» не удалилось: {message}", { title: item.title, message: error.message }));
          load().catch(() => {});
        });
    };
    // Повтор — выбор, как в Календаре macOS: только этот экземпляр или вся
    // серия. Выбор живёт в самой плашке, на месте кнопок.
    const askDeleteScope = () => {
      const ask = node("div", undefined, "cal-pop-ask");
      ask.append(bindTranslation(node("p", t("«{title}» повторяется. Удалить только этот повтор ({value2}) или всю серию из календаря {source}? Это не вернуть.", { title: item.title, value2: calHuman(item.date), source: item.source }), "cal-pop-ask-text"), "«{title}» повторяется. Удалить только этот повтор ({value2}) или всю серию из календаря {source}? Это не вернуть.", { title: item.title, value2: calHuman(item.date), source: item.source }));
      const row = node("div", undefined, "cal-pop-actions");
      row.append(calButton(t("Только это событие"), "cal-pop-btn danger", () => erase("instance")), calButton(t("Всю серию"), "cal-pop-btn danger", () => erase("series")), calButton(t("Отмена"), "cal-pop-btn", () => ask.replaceWith(actions)));
      ask.append(row);
      actions.replaceWith(ask);
      calPopFit(pop);
    };
    actions.append(calButton(t("Удалить"), "cal-pop-btn danger", () => {
      if (item.recurring) { askDeleteScope(); return; }
      if (!confirm(t("Удалить «{title}» из календаря {source}? Это не вернуть.", { title: item.title, source: item.source }))) return;
      erase(null);
    }));
  }
  pop.append(actions);
  // Как в Календаре macOS: правка повтора касается только этого события,
  // удалить можно и его одного, и всю серию; ответ организатору — один на
  // всю серию.
  const note = !item.editable
    ? t("Чужое событие не запись: его нет в поиске и отчётах, пока вы не возьмёте его в память.")
    : item.recurring
      ? t("Экземпляр повтора: название по клику и перенос мышкой меняют только этот повтор; «Удалить» спросит, убрать его одного или всю серию; ответ организатору — на всю серию.")
      : t("Чужое событие не запись: его нет в поиске и отчётах, пока вы не возьмёте его в память. Название правится по клику, перенос — мышкой, изменения уходят в календарь сразу.");
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
  bindTranslation(input, "Что записать? — «созвон с Сашей на полчаса»", "placeholder");
  bindTranslation(input, "Новая запись", "aria-label");
  pop.append(input);
  pop.append(bindTranslation(node("p", t("Enter — записать · Esc — закрыть. Дело получит этот срок; встречу разберёт модель."), "cal-pop-note"), "Enter — записать · Esc — закрыть. Дело получит этот срок; встречу разберёт модель."));
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
        ? { raw: `${text} — ${numeric}${time ? t(" в {time}", { time: time }) : ""}` }
        : { raw: text, primaryType: "todo", due: { date, ...(time ? { time } : {}) } };
      await request("/api/captures", { method: "POST", body: JSON.stringify(body) });
      toast(t("Записано"));
      closeCalendarPop();
      await load();
      await loadCalendar();
    } catch (error) { toast(error.message); input.disabled = false; }
  });
}
function calSnap(minutes) { return Math.max(CAL_H0 * 60, Math.min(CAL_H1 * 60 - CAL_STEP, Math.round(minutes / CAL_STEP) * CAL_STEP)); }
async function toggleCalendarDone(item) {
  // Экземпляр своей серии: «готово» убирает его из серии, остальные остаются.
  if (item.recurring) { await doneOccurrence({ id: item.id, projectionId: item.projectionIds?.[0] || null }, item.date); return; }
  const ids = item.projectionIds || [];
  if (!ids.length) return;
  try {
    for (const projectionId of ids) await request(`/api/projections/${projectionId}/${item.done ? "undo-complete" : "complete"}`, { method: "POST", body: "{}" });
    await loadCalendar();
    if (item.done) toast(t("Снова в работе"));
    else toast(t("Готово: «{value1}»", { value1: shortTitle(item.title) }), { get label() { return t("Вернуть"); }, run: () => toggleCalendarDone({ ...item, done: true }) });
    load().catch(() => {});
  } catch (error) { toast(error.message); }
}
// Перенос — уточнение записи: сервер пересобирает проекции. «Вернуть» — не
// откат, а ещё одно уточнение с прежним сроком: история записи append-only,
// и снятие проекций через /api/undo оставило бы дело вовсе без срока.
// Чужое событие переносится в самом календаре — PATCH уходит в Яндекс, Apple
// или Google; «Вернуть» — такой же перенос обратно.
async function moveCalendarItem(item, schedule, { announce = true } = {}) {
  // Экземпляр своей серии двигается вместе с серией: новое время — у всех
  // повторов, сдвиг по дням — у первого экземпляра, остальные идут за ним.
  if (item.kind !== "external" && item.recurring) {
    const base = shiftDate(item.baseDate, calDayDiff(item.date, schedule.date));
    const next = { date: base, time: schedule.time ?? null, ...(schedule.time && schedule.end ? { end: schedule.end } : {}) };
    if (base === item.baseDate && (next.time || null) === (item.time || null) && (next.end || null) === (item.end || null)) return;
    try {
      await request(`/api/captures/${item.id}/corrections`, { method: "POST", body: JSON.stringify({ patch: { schedule: next }, at: Date.now() }) });
      await loadCalendar();
      const label = next.time ? `${calHuman(schedule.date)}, ${next.time}` : t("{value1}, без времени", { value1: calHuman(schedule.date) });
      if (announce) toast(t("Перенесена вся серия: {label}", { label: label }), { get label() { return t("Вернуть"); }, run: () => moveCalendarItem({ ...item, date: schedule.date, time: next.time, end: next.end || null, baseDate: base }, { date: item.date, time: item.time, ...(item.end ? { end: item.end } : {}) }, { announce: false }) });
      await load();
    } catch (error) { toast(error.message); }
    return;
  }
  if (item.date === schedule.date && (item.time || null) === (schedule.time || null) && (item.end || null) === (schedule.end || null)) return;
  const before = { date: item.date, time: item.time, ...(item.end ? { end: item.end } : {}) };
  try {
    if (item.kind === "external") await request(`/api/calendar/external/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ date: schedule.date, time: schedule.time ?? null, end: schedule.end ?? null }) });
    else await request(`/api/captures/${item.id}/corrections`, { method: "POST", body: JSON.stringify({ patch: { schedule } }) });
    await loadCalendar();
    const label = schedule.time ? `${calHuman(schedule.date)}, ${schedule.time}` : t("{value1}, без времени", { value1: calHuman(schedule.date) });
    if (announce) toast(t("Перенесено{value1}: {label}", { value1: item.kind === "external" ? t(" в {value1}", { value1: item.source }) : "", label: label }), { get label() { return t("Вернуть"); }, run: () => moveCalendarItem({ ...item, ...schedule }, before, { announce: false }) });
    if (item.kind !== "external") await load();
  } catch (error) { toast(error.message); }
}
{
  const wrap = $("#calendar-view");
  // У повтора один id на все экземпляры: экземпляр узнаётся ещё и по дате.
  const findItem = (id, occ = null) => calState.data?.items.find((item) => item.id === id && (!occ || item.date === occ)) || calState.data?.overdue?.find((item) => item.id === id) || calState.data?.external?.find((item) => item.id === id);
  wrap.addEventListener("dragstart", (event) => {
    const element = event.target.closest?.("[data-own][draggable='true']");
    if (!element) return;
    calState.drag = findItem(element.dataset.id, element.dataset.occ || null);
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

// ── Telegram в настройках ───────────────────────────────────────────────────
// Бот один на всё приложение, привязка — своя у каждого. Ссылка с кодом
// открывает бота; когда в Telegram нажали «Запустить», сервер присылает в
// поток событие «telegram», и раздел сам показывает, что всё подключено.
let telegramView = null;
let telegramRetry = null;
async function loadTelegram({ announce = false } = {}) {
  if (!$("#telegram-settings")) return;
  try {
    const view = await request("/api/telegram");
    // Состояние читается только после ответа: страница, открытая сразу на
    // настройках, зовёт это раньше, чем модуль дошёл до объявлений ниже.
    const wasLinked = Boolean(telegramView?.link);
    paintTelegram(view);
    if (announce && !wasLinked && telegramView?.link) toast(t("Telegram подключён"));
  } catch {
    // Раздел не обновился — остальные настройки работают и без него.
  }
}
function telegramAnchor(username) {
  const anchor = node("a", `@${username}`);
  anchor.href = `https://t.me/${username}`;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}
const telegramBotLink = (bot) => (bot?.bot?.username ? telegramAnchor(bot.bot.username) : document.createTextNode(t("Кизуны")));
function paintTelegram(view) {
  const group = $("#telegram-settings");
  if (!group || !view?.bot) return;
  telegramView = view;
  const { bot, link, canSetup } = view;
  // Пока бота нет, раздел нужен только тому, кто может его завести.
  group.hidden = !bot.configured && !canSetup;
  const state = $("#telegram-state");
  clear(state);
  state.classList.toggle("is-error", bot.state === "error");
  if (!bot.configured) {
    state.append(t("Бот ещё не заведён: создайте его у "), telegramAnchor("BotFather"), t(" командой /newbot."), ' ');
    const setup = bindTranslation(node('a', t('Настроить бота')), 'Настроить бота'); setup.href = '#admin/service/integrations'; state.append(setup);
  }
  else if (bot.state === "error") state.append(t("Бот не на связи: {value1}", { value1: bot.error || t("Telegram не отвечает.") }));
  else if (link) {
    const who = `${link.name || "Telegram"}${link.username ? ` (@${link.username})` : ""}`;
    state.append(t("Подключён {who}. Пишите боту ", { who: who }), telegramBotLink(bot), t(" или пересылайте ему сообщения."));
  } else if (bot.state === "connecting") state.append(t("Бот выходит на связь…"));
  else state.append(t("Бот "), telegramBotLink(bot), t(" на связи. Подключите свой Telegram — и пишите ему."));
  const linkButton = $("#telegram-link");
  linkButton.hidden = !bot.configured || Boolean(link);
  $("#telegram-unlink").hidden = !link;
  if (link || !bot.configured) {
    $("#telegram-connect").hidden = true;
    bindTranslation(linkButton, "Подключить Telegram");
  }
  // Токен только что сохранили: пара секунд — и бот на связи.
  clearTimeout(telegramRetry);
  if (bot.configured && bot.state === "connecting" && $("#settings")?.hidden === false) telegramRetry = setTimeout(() => loadTelegram(), 1500);
}
$("#telegram-link")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await request("/api/telegram/link", { method: "POST", body: "{}" });
    paintTelegram(result);
    const qr = $("#telegram-qr");
    qr.hidden = !result.qr;
    if (result.qr) qr.src = result.qr;
    $("#telegram-open").href = result.url;
    $("#telegram-connect").hidden = false;
    // Нажать ещё раз — значит взять новую ссылку: прежняя тут же гаснет.
    bindTranslation(button, "Новая ссылка");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#telegram-unlink")?.addEventListener("click", async () => {
  try {
    paintTelegram(await request("/api/telegram/link", { method: "DELETE" }));
    toast(t("Telegram отключён"));
  } catch (error) {
    toast(error.message);
  }
});

// ── Календари в настройках ──────────────────────────────────────────────────
const CAL_PRESET_HINTS = {
  yandex: { get title() { return t("Яндекс Календарь"); }, get hint() { return t("Логин — адрес почты Яндекса. Пароль — пароль приложения из Яндекс ID: «Безопасность → Пароли приложений → Календарь». Обычный пароль не подойдёт."); }, placeholder: "name@yandex.ru" },
  icloud: { title: "Apple iCloud", get hint() { return t("Логин — Apple ID. Пароль — пароль для приложения с appleid.apple.com: «Вход и безопасность → Пароли приложений»."); }, placeholder: "name@icloud.com" },
  custom: { get title() { return t("Другой CalDAV"); }, get hint() { return t("Адрес сервера, логин и пароль — как в любом CalDAV-клиенте. Подойдёт Fastmail, Nextcloud, Radicale."); }, get placeholder() { return t("логин"); } },
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
  if (account.syncError) return t("ошибка: {syncError}", { syncError: account.syncError });
  if (!account.syncedAt) return t("ещё не синхронизирован");
  const minutes = Math.round((Date.now() - Date.parse(account.syncedAt)) / 60000);
  return minutes < 1 ? t("обновлён только что") : minutes < 60 ? t("обновлён {minutes} мин назад", { minutes: minutes }) : t("обновлён {value1} ч назад", { value1: Math.round(minutes / 60) });
}
function paintCalendarAccounts() {
  const wrap = $("#calendar-accounts");
  clear(wrap);
  const google = $("#calendar-google");
  if (google) { google.classList.toggle("is-disabled", !calendarAccountsState.googleReady); google.title = calendarAccountsState.googleReady ? "" : t("Сначала укажите ID и секрет клиента Google в «Ключах»"); }
  if (!calendarAccountsState.accounts.length) { wrap.append(bindTranslation(node("p", t("Пока ни одного внешнего календаря."), "setting-hint"), "Пока ни одного внешнего календаря.")); return; }
  for (const account of calendarAccountsState.accounts) {
    const card = node("div", undefined, `calendar-account${account.disabled ? " is-disabled" : ""}`);
    const head = node("div", undefined, "calendar-account-head");
    const dot = node("i", undefined, "cal-dot");
    dot.style.background = account.color || "var(--n-72)";
    const name = node("b", account.label);
    bindTranslation(name, "Переименовать", "title");
    name.tabIndex = 0;
    name.addEventListener("click", async () => {
      const next = prompt(t("Название календаря"), account.label);
      if (next === null || !next.trim() || next.trim() === account.label) return;
      await patchCalendarAccount(account.id, { label: next.trim() });
    });
    const meta = node("span", `${account.provider === "google" ? "Google" : account.preset === "yandex" ? t("Яндекс · CalDAV") : account.preset === "icloud" ? "Apple · CalDAV" : "CalDAV"} · ${account.disabled ? t("отключён") : calendarSyncLabel(account)}${account.exportError ? t(" · отправка: {exportError}", { exportError: account.exportError }) : ""}`, `calendar-account-meta${account.syncError || account.exportError ? " is-error" : ""}`);
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
      if (!calendar.writable) label.append(bindTranslation(node("small", t("только чтение")), "только чтение"));
      list.append(label);
    }
    card.append(list);
    const controls = node("div", undefined, "calendar-account-controls");
    const mode = node("select");
    for (const [value, text] of [["full", t("Показывать названия")], ["busy", t("Только «занято»")]]) { const option = node("option", text); option.value = value; option.selected = account.mode === value; mode.append(option); }
    mode.addEventListener("change", () => patchCalendarAccount(account.id, { mode: mode.value }));
    const color = node("input");
    color.type = "color";
    color.value = account.color || "#8a8681";
    bindTranslation(color, "Цвет в календаре", "title");
    color.addEventListener("change", () => patchCalendarAccount(account.id, { color: color.value }));
    const sync = calButton(t("Обновить"), "secondary", async () => {
      sync.disabled = true;
      try { const result = await request(`/api/calendar/accounts/${account.id}/sync`, { method: "POST", body: "{}" }); toast(t("Синхронизировано: {value1} соб.", { value1: result.events ?? 0 })); }
      catch (error) { toast(error.message); }
      await loadCalendarAccounts();
    });
    const toggle = calButton(account.disabled ? t("Включить") : t("Отключить"), "secondary", () => patchCalendarAccount(account.id, { disabled: !account.disabled }));
    const remove = calButton(t("Удалить"), "secondary calendar-remove", async () => {
      if (!confirm(t("Удалить «{label}»? Учётные данные и кэш событий сотрутся; сам календарь не пострадает.", { label: account.label }))) return;
      try { await request(`/api/calendar/accounts/${account.id}`, { method: "DELETE" }); toast(t("Календарь отключён")); }
      catch (error) { toast(error.message); }
      await loadCalendarAccounts();
    });
    controls.append(mode, color, sync, toggle, remove);
    card.append(controls);
    // Автоотправка: свои дела со сроком сами уходят в выбранный
    // календарь и следуют за записью — перенос, «сделано», удаление. Это
    // разрешение даётся один раз здесь, а не на каждую запись.
    const auto = node("div", undefined, "calendar-account-auto");
    const autoMode = node("select");
    // Все записи — дела, поэтому «только встречи» новому выбору не предлагается:
    // оно остаётся в списке лишь у тех, у кого уже включено.
    const autoChoices = [["off", t("Наружу — только кнопкой")], ["all", t("Отправлять дела со сроком")]];
    if ((account.autoExport || "off") === "meetings") autoChoices.splice(1, 0, ["meetings", t("Отправлять только встречи")]);
    for (const [value, text] of autoChoices) { const option = node("option", text); option.value = value; option.selected = (account.autoExport || "off") === value; autoMode.append(option); }
    bindTranslation(autoMode, "Автоматическая отправка", "aria-label");
    autoMode.addEventListener("change", () => patchCalendarAccount(account.id, { autoExport: autoMode.value }));
    auto.append(autoMode);
    const writable = account.calendars.filter((calendar) => calendar.writable);
    if ((account.autoExport || "off") !== "off" && writable.length) {
      auto.append(bindTranslation(node("span", t("в"), "calendar-account-auto-in"), "в"));
      const target = node("select");
      bindTranslation(target, "Календарь для отправки", "aria-label");
      for (const calendar of writable) { const option = node("option", calendar.name); option.value = calendar.id; option.selected = calendar.id === account.autoCalendarId; target.append(option); }
      target.addEventListener("change", () => patchCalendarAccount(account.id, { autoCalendarId: target.value }));
      auto.append(target);
    }
    auto.append(node("small", (account.autoExport || "off") === "off" ? t("Дела уходят в календарь только кнопкой «В календарь» в карточке.") : t("Уходят сами и следуют за записью: перенос, конец, удаление. Сдвинули событие в календаре — срок записи подвинется тоже."), "setting-hint"));
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
      bindTranslation(state, "Проверяем…");
      submit.disabled = true;
      try {
        const result = await request("/api/calendar/accounts", { method: "POST", body: JSON.stringify({ preset, serverUrl: $("#calendar-server").value.trim() || null, username: $("#calendar-username").value.trim(), password: $("#calendar-password").value }) });
        toast(result.syncError ? t("Подключено, но синхронизация не удалась: {syncError}", { syncError: result.syncError }) : t("Подключено: {length} кал., {value2} соб.", { length: result.account.calendars.length, value2: result.events ?? 0 }));
        form.hidden = true;
        form.reset();
        await loadCalendarAccounts();
      } catch (error) { state.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    $("#calendar-google")?.addEventListener("click", (event) => { if (!calendarAccountsState.googleReady) {
      event.preventDefault();
      if (currentUser?.role === 'admin') location.hash = '#admin/service/integrations';
      else toast(t('Подключение Google настраивает администратор.'));
    } });
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
        row.append(bindTranslation(node("span", t("В календаре: {value1}{value2}", { value1: account?.label || t("внешний"), value2: link.auto ? t(" · автоматически") : "" })), "В календаре: {value1}{value2}", { value1: account?.label || t("внешний"), value2: link.auto ? t(" · автоматически") : "" }));
        if (safeExternalUrl(link.href)) { const open = bindTranslation(node("a", t("открыть")), "открыть"); open.href = safeExternalUrl(link.href); open.target = "_blank"; open.rel = "noopener"; row.append(open); }
        // Автоматическую отправку «убрать» нельзя: следующий проход вернул бы
        // событие. Выключается в настройках календаря.
        if (link.auto && (account?.autoExport || "off") !== "off") { wrap.append(row); continue; }
        const remove = bindTranslation(node("button", t("убрать"), "card-calendar-remove"), "убрать");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try { await request("/api/calendar/export/remove", { method: "POST", body: JSON.stringify({ captureId: entry.id, accountId: link.accountId }) }); toast(t("Событие убрано из календаря")); wrap.replaceWith(calendarExportEl(entry)); }
          catch (error) { toast(error.message); remove.disabled = false; }
        });
        row.append(remove);
        wrap.append(row);
      }
      const targets = writable.filter(({ account }) => !exports.some((link) => link.accountId === account.id));
      if (!targets.length) return;
      const menu = node("details", undefined, "card-calendar-menu");
      const summary = bindTranslation(node("summary", t("В календарь")), "В календарь");
      summary.prepend(propIcon("schedule"));
      menu.append(summary);
      const list = node("div", undefined, "card-calendar-list");
      for (const { account, calendar } of targets) {
        const button = node("button", `${account.label} · ${calendar.name}`, "card-calendar-target");
        button.type = "button";
        const dot = node("i", undefined, "cal-dot");
        dot.style.background = calendar.color || account.color || "var(--n-72)";
        button.prepend(dot);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await request("/api/calendar/export", { method: "POST", body: JSON.stringify({ captureId: entry.id, accountId: account.id, calendarId: calendar.id }) }); toast(t("Отправлено в {label}", { label: account.label })); wrap.replaceWith(calendarExportEl(entry)); }
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
const REMIND_LABELS = { get off() { return t("не напоминать"); }, get 0() { return t("в момент начала"); }, get 5() { return t("за 5 минут"); }, get 15() { return t("за 15 минут"); }, get 30() { return t("за 30 минут"); }, get 60() { return t("за час"); }, get 120() { return t("за 2 часа"); }, get 1440() { return t("за день"); } };
function remindMinutesLabel(value) { return REMIND_LABELS[String(value)] || t("за {value} мин", { value: value }); }
function remindDefaultLabel() { return remindMinutesLabel(appSettings.remindDefault ?? "15"); }
function remindHourValue() { const value = appSettings.remindHour; return value && value !== "off" ? value : "09:00"; }
function remindHourLabel() { return appSettings.remindHour === "off" ? t("не напоминать") : t("в {value1}", { value1: remindHourValue() }); }
const IOS_DEVICE = /iPhone|iPad|iPod/.test(navigator.userAgent);
function nativeNotifications() { return window.webkit?.messageHandlers?.kizunaNotifications; }
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
  if (nativeNotifications()) {
    state.removeAttribute("data-i18n");
    const status = window.KizunaNotificationState;
    if (!status) nativeNotifications().postMessage("status");
    const enabled = status?.authorized && status?.enabled;
    state.textContent = status?.denied
      ? t("Уведомления запрещены в macOS. Разрешите их в Системных настройках → Уведомления → Кизуна.")
      : `${enabled ? t("Уведомления включены на этом устройстве") : t("Уведомления выключены на этом устройстве")}. ${t("Уведомления работают, пока Кизуна запущена, в том числе с закрытым окном.")}`;
    enable.hidden = Boolean(enabled);
    disable.hidden = test.hidden = !enabled;
    return;
  }
  if (!pushSupported()) {
    state.textContent = IOS_DEVICE
      ? t("На iPhone уведомления работают, если добавить Кизуну на экран «Домой» (Поделиться → На экран «Домой») и открывать оттуда.")
      : t("Этот браузер не умеет уведомления на закрытую вкладку.");
    enable.hidden = disable.hidden = test.hidden = true;
    return;
  }
  const subscription = await currentPushSubscription();
  let others = 0;
  try { const info = await request("/api/push/key"); others = info.subscriptions.filter((item) => item.endpoint !== subscription?.endpoint).length; } catch {}
  const denied = Notification.permission === "denied";
  if (subscription) bindTranslation(state, "На этом устройстве включены{value1}.", { value1: others ? t(", ещё устройств: {value1}", { value1: others }) : "" });
  else if (denied) bindTranslation(state, "Уведомления для этого сайта запрещены в браузере — разрешите их в настройках сайта.");
  else state.textContent = others ? t("На этом устройстве выключены, других устройств: {others}.", { others: others }) : t("Уведомления приходят на закрытую вкладку и на телефон. Включаются на каждом устройстве отдельно.");
  enable.hidden = Boolean(subscription) || denied;
  disable.hidden = !subscription;
  test.hidden = !subscription && !others;
}
async function enablePush() {
  if (nativeNotifications()) { nativeNotifications().postMessage("enable"); return; }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") { toast(t("Без разрешения браузера уведомления не придут")); paintPush(); return; }
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const { publicKey } = await request("/api/push/key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await request("/api/push/subscriptions", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
  toast(t("Уведомления включены на этом устройстве"));
  paintPush();
}
async function disablePush() {
  if (nativeNotifications()) { nativeNotifications().postMessage("disable"); return; }
  const subscription = await currentPushSubscription();
  if (subscription) {
    await request("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
    try { await subscription.unsubscribe(); } catch {}
  }
  toast(t("Уведомления выключены на этом устройстве"));
  paintPush();
}
async function testPush() {
  if (nativeNotifications()) { nativeNotifications().postMessage("test"); return; }
  try {
    const summary = await request("/api/push/test", { method: "POST", body: "{}" });
    toast(summary.sent ? t("Пробное уведомление отправлено") : t("Устройство не приняло уведомление — включите заново"));
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
      ? t("Ближайшие: {value1}.", { value1: reminders.slice(0, 3).map((item) => `«${item.title}» — ${item.when}${item.lead ? t(", {value1} до", { value1: item.lead.replace("через", "за") }) : ""}`).join("; ") })
      : t("Впереди напоминаний нет: у открытых дел со сроком они появятся сами.");
  } catch { element.textContent = ""; }
}
async function openCaptureById(id, { subtasks = false } = {}) {
  // По ссылке карточка открывается так же, как по клику в списке: с вопросом
  // модели, если разбор неуверенный. subtasks — сразу на разделе «Подзадачи».
  try { const { entry } = await request(`/api/captures/${encodeURIComponent(id)}`); const review = reviewFromEntry(entry); cardScrollTarget = subtasks ? id : null; showCorrection(entry, review.level === "high" ? undefined : review); }
  catch (error) { toast(error.message); }
}
$("#push-enable")?.addEventListener("click", () => enablePush().catch((error) => { toast(error.message || t("Не удалось включить уведомления")); paintPush(); }));
$("#push-disable")?.addEventListener("click", () => disablePush().catch((error) => toast(error.message)));
$("#push-test")?.addEventListener("click", testPush);
window.addEventListener("pagent:notificationschange", paintPush);

// ── уведомления ──────────────────────────────────────────────────────────────
// Колокольчик в шапке хранит историю: что случилось, пока вас не было. Число на
// нём — только то, что ждёт вашего ответа (просьба, приглашение), остальное
// непрочитанное — тихой точкой: колокольчик сообщает, а не подгоняет. Полоса
// «к вам» на «Сегодня» показывает то же ждущее, поэтому ответ в одном месте
// гасит строку в обоих.
// Curated server notification presentation; records and message text stay untouched.
const NOTIFY_KIND_PRESENTATION = localizedBuiltins({
  "request": {
    "label": "Просят сделать дело",
    "hint": "ждёт вашего ответа: беру или не я"
  },
  "call": {
    "label": "Зовут по имени",
    "hint": "@имя в записи, в обсуждении карточки или в разговоре круга"
  },
  "reply": {
    "label": "Отвечают на ваше сообщение",
    "hint": "ответ цитатой в разговоре или обсуждении"
  },
  "feedback_reply": {
    "label": "Ответ на ваше пожелание",
    "hint": ""
  },
  "answer": {
    "label": "Ответили на вашу просьбу",
    "hint": "берут, возвращают, сделали"
  },
  "circle": {
    "label": "Добавили в круг",
    "hint": ""
  },
  "room": {
    "label": "Позвали в комнату",
    "hint": "разговор части круга"
  },
  "reaction": {
    "label": "Реакции на ваши сообщения",
    "hint": "одной строкой на разговор"
  },
  "pin": {
    "label": "Закрепили сообщение",
    "hint": "в разговоре, где вы есть"
  },
  "chatter": {
    "label": "Пишут без призыва",
    "hint": "одной строкой на разговор, без числа"
  },
  "reminder": {
    "label": "Скоро срок дела или начало встречи",
    "hint": "за сколько — в «Напоминаниях»"
  },
  "invite": {
    "label": "Приглашение на встречу",
    "hint": "принять или отказаться прямо в строке"
  },
  "event_changed": {
    "label": "Встречу перенесли или отменили",
    "hint": "только на ближайшие два дня"
  },
  "event_added": {
    "label": "Появилась новая встреча",
    "hint": "из подключённых календарей, на ближайшие два дня"
  },
  "digest": {
    "label": "Утренняя сводка",
    "hint": "в час напоминаний: встречи, дела и кто ждёт ответа"
  },
  "clarify": {
    "label": "Запись ждёт уточнения",
    "hint": "модель не разобрала однозначно"
  },
  "calendar_error": {
    "label": "Календарь перестал обновляться",
    "hint": "нужно переподключить"
  },
  "spend": {
    "label": "Расходы подошли к потолку",
    "hint": "на 80% и на 100% месячного"
  },
  "signup": {
    "label": "Новая заявка на вход",
    "hint": "только администратору"
  }
});
const NOTIFY_FILTERS = localizedBuiltins([["all", "Все"], ["waits", "Ждут ответа"], ["people", "Люди"], ["time", "Сроки и встречи"], ["other", "Остальное"]]);
const NOTIFY_GLYPHS = {
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.9V8l2.1 1.4"/>',
  calendar: '<rect x="2.4" y="3.4" width="11.2" height="10.2" rx="2"/><path d="M2.4 6.6h11.2M5.4 2v2.8M10.6 2v2.8"/>',
  spark: '<path d="M8 2.4c.5 2.9 1.9 4.3 4.8 4.8-2.9.5-4.3 1.9-4.8 4.8-.5-2.9-1.9-4.3-4.8-4.8 2.9-.5 4.3-1.9 4.8-4.8Z"/>',
  warn: '<path d="M8 2.6 14.2 13H1.8Z"/><path d="M8 6.5v3"/><path d="M8 11.3h.01"/>',
  gauge: '<path d="M2.6 11.4a5.4 5.4 0 1 1 10.8 0"/><path d="M8 11.4l2.4-3.1"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/>',
  door: '<path d="M3.5 13.5V3.4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v10.1"/><path d="M2 13.5h12M10 8h.01"/>',
};
const NOTIFY_FACES = {
  reminder: ["clock", "coral"], invite: ["calendar", "blue"], event_added: ["calendar", "blue"], event_changed: ["calendar", "blue"],
  digest: ["sun", "amber"], clarify: ["spark", "violet"], calendar_error: ["warn", "amber"], spend: ["gauge", "muted"], signup: ["door", "teal"],
};
const notifyDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: getTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const notifyClock = (iso) => new Intl.DateTimeFormat(getLocale(), { timeZone: getTimeZone(), hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
function notifyTime(iso) {
  const today = currentDayDate || notifyDay(new Date().toISOString());
  const day = notifyDay(iso);
  if (day === today) return notifyClock(iso);
  if (day === shiftDate(today, -1)) return t("вчера, {value1}", { value1: notifyClock(iso) });
  return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
}
function notifyPeople(actors) {
  const names = actors.map((person) => person.name);
  if (names.length <= 2) return names.join(t(" и "));
  return t("{value1} и ещё {value2}", { value1: names.slice(0, 2).join(", "), value2: names.length - 2 });
}

async function loadNotifications() {
  let data;
  try { data = await request("/api/notifications"); } catch { return; }
  const invitesBefore = bellState.items.filter((item) => item.kind === "invite" && item.waits).map((item) => item.id).join();
  bellState.items = data.notifications || [];
  bellState.counts = data.counts || bellState.counts;
  bellState.kinds = data.kinds || [];
  bellState.loaded = true;
  paintBell();
  paintNotifySettings();
  // Приглашения живут и в полосе «к вам»: изменились — день перерисовывается.
  if (bellState.items.filter((item) => item.kind === "invite" && item.waits).map((item) => item.id).join() !== invitesBefore) renderToday();
}
function paintBell() {
  const count = $("#bell-count"), dot = $("#bell-dot"), summary = $("#bell-summary");
  if (!count || !dot || !summary) return;
  const { waits, unread } = bellState.counts;
  count.hidden = !waits;
  count.textContent = waits > 99 ? "99+" : String(waits);
  dot.hidden = Boolean(waits) || !unread;
  summary.setAttribute("aria-label", waits ? t("Уведомления: ждут ответа — {waits}", { waits: waits }) : unread ? t("Уведомления: есть непрочитанные") : t("Уведомления"));
  if ($("#bell-menu")?.open) renderBellPanel();
}
function notificationFace(item) {
  if (item.actors?.length > 1) {
    const faces = node("span", undefined, "bell-faces");
    for (const person of item.actors.slice(0, 2)) faces.append(avatarEl(person, { size: "big" }));
    return faces;
  }
  if (item.actors?.length) return avatarEl(item.actors[0], { size: "big" });
  const [icon, tone] = NOTIFY_FACES[item.kind] || ["spark", "muted"];
  const glyph = node("span", undefined, `bell-glyph ${tone}`);
  glyph.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NOTIFY_GLYPHS[icon]}</svg>`;
  return glyph;
}
function notificationText(item) {
  const text = node("div", undefined, "bell-text");
  const who = item.actors?.length ? notifyPeople(item.actors) : item.lead;
  if (who) text.append(node("b", who), document.createTextNode(" "));
  text.append(document.createTextNode(item.text));
  return text;
}
function notificationMeta(item) {
  const meta = node("div", undefined, "bell-meta");
  if (item.kind === "chatter" && item.count > 1) meta.append(node("span", `${item.count} ${pluralRu(item.count, t("сообщение"), t("сообщения"), t("сообщений"))}`));
  for (const piece of item.meta || []) meta.append(node("span", piece));
  if (item.data?.circle) meta.append(circleChip(item.data.circle, { small: true }));
  return meta;
}
// Срок «Отложить» словами: «30 минут», «час», «2 часа», «сутки».
function snoozeWords(minutes) {
  if (minutes >= 24 * 60) return t("сутки");
  if (minutes % 60) return `${minutes} ${pluralRu(minutes, t("минуту"), t("минуты"), t("минут"))}`;
  const hours = minutes / 60;
  return hours === 1 ? t("час") : `${hours} ${pluralRu(hours, t("час"), t("часа"), t("часов"))}`;
}
function notifyButton(label, primary, run, { ok = false } = {}) {
  const button = node("button", label, `bell-act${primary ? " primary" : ""}${ok ? " ok" : ""}`);
  button.type = "button";
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try { await run(); } catch (error) { toast(error.message || t("Не получилось")); button.disabled = false; }
  });
  return button;
}
// Кнопки строки — те же, что в карточке и в полосе «к вам»: ответить можно, не
// открывая запись. Сделанное остаётся в строке словами: что стало.
function notificationActions(item, { after = () => {}, inPanel = false } = {}) {
  if (bellDone.has(item.id)) return node("div", bellDone.get(item.id), "bell-done");
  const acts = node("div", undefined, "bell-acts");
  const done = (words, { close = true } = {}) => { bellDone.set(item.id, words); if (close) after(); loadNotifications(); };
  if (item.kind === "request" && item.waits) {
    acts.append(
      notifyButton(t("Беру"), true, async () => { await request(`/api/assignments/${item.assignmentId}/respond`, { method: "POST", body: JSON.stringify({ take: true }) }); done(t("Взято — дело в вашем дне")); load().catch(() => {}); }),
      notifyButton(t("Не я"), false, async () => {
        const reason = (prompt(t("Почему не вы? Можно не отвечать — причина уйдёт автору.")) ?? "").trim();
        await request(`/api/assignments/${item.assignmentId}/respond`, { method: "POST", body: JSON.stringify({ take: false, ...(reason ? { reason } : {}) }) });
        done(t("Вернули автору")); load().catch(() => {});
      }),
    );
  } else if (item.kind === "invite" && item.waits) {
    acts.append(
      notifyButton(t("Приму"), true, async () => { await answerInvite(item, "accepted"); done(t("Принято — встреча в календаре")); }),
      notifyButton(t("Не смогу"), false, async () => { await answerInvite(item, "declined"); done(t("Организатор узнает, что вас не будет")); }),
    );
  } else if (item.kind === "reminder") {
    // Дело из напоминания закрывается прямо в строке — открывать карточку ради
    // одного кружка незачем. Вместе с делом из ленты уходят его напоминания.
    if (item.captureId && (item.meta || []).includes("дело"))
      acts.append(notifyButton(t("Готово"), true, async () => { await completeFromNotification(item); done(t("Готово — дело закрыто"), { close: !inPanel }); }, { ok: true }));
    if (item.data?.startAt ? Date.parse(item.data.startAt) > Date.now() : notifyDay(item.updatedAt) === currentDayDate) {
      if (safeExternalUrl(item.data?.joinUrl)) acts.append(notifyButton(t("К звонку"), true, async () => { window.open(safeExternalUrl(item.data.joinUrl), "_blank", "noopener"); done(t("Звонок открыт в новой вкладке")); }));
      // Отложить: первый раз на полчаса, каждый следующий вдвое дольше — срок
      // считает сервер. Встреча возвращается не позже начала, и кнопка так и
      // говорит.
      const snooze = item.snoozeMinutes || 30;
      const toStart = item.data?.startAt && Date.parse(item.data.startAt) - Date.now() < snooze * 60000;
      acts.append(notifyButton(toStart ? t("Напомнить к началу") : t("Через {value1}", { value1: snoozeWords(snooze) }), false, async () => {
        const result = await request(`/api/notifications/${item.id}/snooze`, { method: "POST", body: JSON.stringify({}) });
        done(t("Напомню в {value1}", { value1: notifyClock(result.snoozedUntil) }));
      }));
    }
  } else if (item.kind === "call" || item.kind === "reply") {
    acts.append(notifyButton(t("Ответить"), false, async () => { after(); openNotification(item); }));
  } else if (item.kind === "clarify" && !item.resolved) {
    acts.append(notifyButton(t("Уточнить"), false, async () => { after(); openNotification(item); }));
  } else if (item.kind === "calendar_error" && !item.resolved) {
    acts.append(notifyButton(t("Переподключить"), false, async () => { after(); openNotification(item); }));
  }
  return acts.childNodes.length ? acts : null;
}
async function answerInvite(item, status) {
  await request(`/api/notifications/${item.id}/respond`, { method: "POST", body: JSON.stringify({ status }) });
}
// «Готово» из ленты — тот же кружок, что в «Дне»: дело закрыто, у повтора —
// только этот день. «Вернуть» в тосте открывает дело снова.
async function completeFromNotification(item) {
  const { entry } = await request(`/api/captures/${item.captureId}`);
  const schedule = scheduleOf(entry);
  const projections = completableProjections(entry).filter((projection) => !projection.completion?.completed);
  if (schedule?.repeat && item.data?.date && scheduledOn(entry, item.data.date)) {
    await doneOccurrence({ id: entry.id, projectionId: projectionOfType(entry, "task")?.id || null }, item.data.date);
    dismissNotifications([item.id]);
    return;
  }
  if (!projections.length) throw new Error(t("Это дело уже закрыто"));
  for (const projection of projections)
    await request(`/api/projections/${projection.id}/complete`, { method: "POST", body: "{}" });
  toast(t("Готово: «{value1}»", { value1: shortTitle(titleOf(entry)) }), { get label() { return t("Вернуть"); }, run: async () => {
    try {
      for (const projection of projections) await request(`/api/projections/${projection.id}/undo-complete`, { method: "POST", body: "{}" });
      toast(t("Снова в работе"));
      await load();
    } catch (error) { toast(error.message); }
  } });
  load().catch(() => {});
}
const shortTitle = (text, limit = 40) => { const clean = String(text || "").replace(/\s+/g, " ").trim(); return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean; };
// Открыл — убрал: в ленте остаётся только неразобранное. Ждущее ответа не
// уходит, пока на него не ответили. «Вернуть» кладёт убранное обратно.
// keep — убрать на сервере, но оставить строку на экране: так уходит сводка,
// которую человек прямо сейчас читает.
async function dismissNotifications(ids, { announce = null, keep = false } = {}) {
  // Строки из всплывашки может ещё не быть в ленте: такие id уходят на сервер
  // как есть, а ждущее ответа он сам не уберёт.
  const waiting = new Set(bellState.items.filter((item) => item.waits).map((item) => item.id));
  const wanted = ids.filter((id) => !waiting.has(id));
  if (!wanted.length) return [];
  if (!keep) bellState.items = bellState.items.filter((item) => !wanted.includes(item.id));
  if (!keep && $("#bell-menu")?.open) renderBellPanel();
  try {
    const result = await request("/api/notifications/dismiss", { method: "POST", body: JSON.stringify({ ids: wanted }) });
    bellState.counts = result.counts;
    paintBell();
    if (announce) toast(announce, { get label() { return t("Вернуть"); }, run: () => restoreNotifications(result.dismissed) });
    return result.dismissed;
  } catch (error) {
    toast(error.message);
    loadNotifications();
    return [];
  }
}
async function restoreNotifications(ids) {
  try { await request("/api/notifications/restore", { method: "POST", body: JSON.stringify({ ids }) }); }
  catch (error) { toast(error.message); }
  await loadNotifications();
}
// «Заглушить» — меню у строки: убрать её, не напоминать об этом деле, молчать
// об изменениях в этом календаре или выключить такие поводы совсем.
const BELL_MUTE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11.2V7.6a4 4 0 0 1 6.6-3"/><path d="M12 7.4v3.8l1.2 1.3H5"/><path d="M6.6 13.8a1.6 1.6 0 0 0 2.8 0"/><path d="M2.5 2.5l11 11"/></svg>';
function notificationMenu(item) {
  const menu = node("div", undefined, "bell-mute-menu");
  menu.setAttribute("role", "menu");
  const entry = (title, hint, run) => {
    const button = node("button", undefined, "bell-mute-item");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.append(node("span", title, "bell-mute-title"));
    if (hint) button.append(node("small", hint));
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      bellState.menu = null;
      try { await run(); } catch (error) { toast(error.message || t("Не получилось")); }
    });
    menu.append(button);
  };
  if (!item.waits) entry(t("Убрать из ленты"), null, () => dismissNotifications([item.id], { get announce() { return t("Убрано из ленты"); } }));
  if (item.kind === "reminder" && item.captureId) entry(t("Не напоминать об этом деле"), t("срок остаётся, напоминаний больше не будет"), () => muteReminder(item));
  if (["event_added", "event_changed"].includes(item.kind) && item.accountId) {
    const account = calendarAccountLabel(item.accountId);
    entry(account ? t("Не сообщать об изменениях в «{account}»", { account: account }) : t("Не сообщать об изменениях в этом календаре"), t("календарь в Кизуне остаётся"), () => muteCalendarChanges(item, account));
  }
  const kind = bellState.kinds.find((candidate) => candidate.key === item.kind);
  if (kind) entry(t("Выключить такие"), t("«{label}» — вернуть можно в настройках", { label: t(kind.label) }), () => turnOffKind(item, kind));
  return menu;
}
function calendarAccountLabel(accountId) {
  const accounts = [...(todayState.calendar?.accounts || []), ...(calState.data?.accounts || []), ...(calendarAccountsState.accounts || [])];
  return accounts.find((account) => account.id === accountId)?.label || null;
}
async function muteReminder(item) {
  const { entry } = await request(`/api/captures/${item.captureId}`);
  const schedule = scheduleOf(entry);
  if (!schedule?.date) throw new Error(t("У дела уже нет срока"));
  const patch = (remind) => ({ patch: { schedule: { date: schedule.date, time: schedule.time || null, ...(schedule.time && schedule.end ? { end: schedule.end } : {}), remind } } });
  await request(`/api/captures/${entry.id}/corrections`, { method: "POST", body: JSON.stringify(patch("off")) });
  await dismissNotifications([item.id]);
  toast(t("Об этом деле больше не напомню"), { get label() { return t("Вернуть"); }, run: async () => {
    try { await request(`/api/captures/${entry.id}/corrections`, { method: "POST", body: JSON.stringify(patch(schedule.remind ?? null)) }); }
    catch (error) { toast(error.message); }
    await restoreNotifications([item.id]);
  } });
  load().catch(() => {});
}
async function saveMutedCalendars(list) {
  const value = JSON.stringify([...new Set(list)]);
  paintSettings(await request("/api/settings", { method: "PUT", body: JSON.stringify({ notifyMutedCalendars: value }) }), { updatedFields: ["notifyMutedCalendars"] });
}
function mutedCalendarsNow() {
  try { const parsed = JSON.parse(appSettings.notifyMutedCalendars || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
async function muteCalendarChanges(item, label) {
  const before = mutedCalendarsNow();
  await saveMutedCalendars([...before, item.accountId]);
  await dismissNotifications([item.id]);
  toast(label ? t("«{label}» — без уведомлений об изменениях", { label: label }) : t("Об изменениях в этом календаре — молчу"), { get label() { return t("Вернуть"); }, run: async () => {
    try { await saveMutedCalendars(before); } catch (error) { toast(error.message); }
    await restoreNotifications([item.id]);
  } });
}
async function turnOffKind(item, kind) {
  const prefs = notifyPrefsNow();
  const before = ["off", "bell", "phone"].includes(prefs[kind.key]) ? prefs[kind.key] : kind.default;
  setNotifyMode(kind, "off");
  await dismissNotifications([item.id]);
  toast(t("«{label}» — выключено", { label: t(kind.label) }), { get label() { return t("Вернуть"); }, run: async () => { setNotifyMode(kind, before); await restoreNotifications([item.id]); } });
}
// «Доброе утро» раскрывается на месте: встречи по часам и дела на сегодня с
// кружками. Переходить на главную, чтобы увидеть те же шесть строк, незачем.
function digestBody(item) {
  const box = node("div", undefined, "bell-digest");
  const today = currentDayDate;
  const forToday = (item.data?.date || notifyDay(item.createdAt || item.updatedAt)) === today;
  if (forToday) {
    const minutes = nowMinutes();
    const meetings = todayMeetings().sort((left, right) => left.start - right.start);
    box.append(node("p", meetings.length ? t("Встречи · {length}", { length: meetings.length }) : t("Встреч сегодня нет"), "bell-digest-head"));
    for (const meeting of meetings) {
      const row = node("button", undefined, "bell-digest-row");
      row.type = "button";
      const state = minutes >= meeting.end ? t("прошла") : minutes >= meeting.start ? t("идёт") : meeting.start - minutes <= 90 ? t("через {value1} мин", { value1: meeting.start - minutes }) : "";
      row.append(node("span", hm(meeting.start), "bell-digest-time"), node("i", undefined, "bell-digest-dot"), node("span", meeting.title, "bell-digest-title"), node("span", state, "bell-digest-state"));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        $("#bell-menu")?.removeAttribute("open");
        if (String(meeting.id).startsWith("ext:")) openCalendarAt(today, { id: meeting.id });
        else openCaptureById(meeting.id);
      });
      box.append(row);
    }
    const deals = todayState.entries
      .filter((entry) => scheduledOn(entry, today) && !isReportedWork(entry) && projectionOfType(entry, "task") && (isActiveTask(entry) || isClosed(entry)))
      .sort((left, right) => (scheduleOf(left)?.time || "99").localeCompare(scheduleOf(right)?.time || "99"));
    box.append(node("p", deals.length ? t("Дела на сегодня · {length}", { length: deals.length }) : t("Дел на сегодня нет"), "bell-digest-head"));
    for (const entry of deals) {
      const closed = isClosed(entry);
      const row = node("div", undefined, `bell-digest-row deal${closed ? " done" : ""}`);
      const tick = node("button", undefined, `completion-button${closed ? " is-done" : ""}`);
      tick.type = "button";
      tick.title = closed ? t("Вернуть в работу") : t("Готово");
      tick.setAttribute("aria-label", `${tick.title}: ${titleOf(entry)}`);
      tick.addEventListener("click", async (event) => {
        event.stopPropagation();
        await updateCompletion(completableProjections(entry), !closed, tick);
        if ($("#bell-menu")?.open) renderBellPanel();
      });
      const title = node("button", titleOf(entry), "bell-digest-title");
      title.type = "button";
      title.addEventListener("click", (event) => { event.stopPropagation(); $("#bell-menu")?.removeAttribute("open"); openCaptureById(entry.id); });
      row.append(node("span", scheduleOf(entry)?.time || "", "bell-digest-time"), tick, title);
      const tomorrow = entryTomorrow(entry, scheduleOf(entry)?.repeat ? today : null);
      if (tomorrow) row.append(tomorrow);
      box.append(row);
    }
  }
  const day = bindTranslation(node("button", t("Открыть «День» →"), "bell-digest-link"), "Открыть «День» →");
  day.type = "button";
  day.addEventListener("click", (event) => {
    event.stopPropagation();
    $("#bell-menu")?.removeAttribute("open");
    todayState.tab = "day";
    todayState.view = 0;
    if (location.hash !== "#today") location.hash = "#today";
    else renderToday();
    setTimeout(() => $("#todo")?.scrollIntoView({ block: "start", behavior: motionAllowed() ? "smooth" : "auto" }), 80);
  });
  box.append(day);
  return box;
}
function notificationRow(item) {
  const row = node("div", undefined, `bell-row${item.read ? "" : " unread"}${item.kind === "digest" ? " digest" : ""}`);
  row.dataset.id = item.id;
  const main = node("div", undefined, "bell-main");
  main.append(notificationText(item));
  const meta = notificationMeta(item);
  if (meta.childNodes.length) main.append(meta);
  if (item.kind === "digest") {
    const open = bellState.digest === item.id;
    const toggle = node("button", open ? t("Свернуть") : t("Показать встречи и дела"), `bell-digest-toggle${open ? " open" : ""}`);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", (event) => { event.stopPropagation(); toggleDigest(item); });
    main.append(toggle);
    if (open) main.append(digestBody(item));
  }
  const acts = notificationActions(item, { after: () => $("#bell-menu")?.removeAttribute("open"), inPanel: true });
  if (acts) main.append(acts);
  const side = node("div", undefined, "bell-side");
  side.append(node("span", notifyTime(item.updatedAt), "bell-time"));
  const mute = node("button", undefined, "bell-mute");
  mute.type = "button";
  bindTranslation(mute, "Заглушить", "title");
  bindTranslation(mute, "Заглушить: {value1}", { value1: [item.lead, item.text].filter(Boolean).join(" ") }, "aria-label");
  mute.setAttribute("aria-expanded", String(bellState.menu === item.id));
  mute.innerHTML = BELL_MUTE_ICON;
  mute.addEventListener("click", (event) => {
    event.stopPropagation();
    bellState.menu = bellState.menu === item.id ? null : item.id;
    renderBellPanel();
  });
  side.append(mute);
  row.append(notificationFace(item), main, side);
  if (bellState.menu === item.id) row.append(notificationMenu(item));
  row.addEventListener("click", (event) => {
    if (event.target.closest("button, .bell-mute-menu")) return;
    if (bellState.menu) { bellState.menu = null; renderBellPanel(); return; }
    if (item.kind === "digest") toggleDigest(item);
    else openNotification(item);
  });
  return row;
}
function toggleDigest(item) {
  const open = bellState.digest !== item.id;
  bellState.digest = open ? item.id : null;
  if (!item.read) markNotificationsRead({ ids: [item.id] });
  // Раскрыл — значит посмотрел: сводка уходит из ленты, как и любой открытый
  // повод. Но не из-под рук: строка стоит на месте, пока колокольчик открыт.
  if (open && !item.seen) { item.seen = true; dismissNotifications([item.id], { keep: true }); }
  renderBellPanel();
}
function renderBellPanel() {
  const panel = $("#bell-popover");
  if (!panel) return;
  const scroll = panel.scrollTop;
  clear(panel);
  const head = node("div", undefined, "bell-head");
  head.append(bindTranslation(node("h3", t("Уведомления")), "Уведомления"));
  // «Очистить» — всё, что не ждёт ответа: лента для неразобранного, а не архив.
  const clearAll = bindTranslation(node("button", t("Очистить"), "linklike bell-read-all"), "Очистить");
  clearAll.type = "button";
  clearAll.disabled = !bellState.items.some((item) => !item.waits);
  clearAll.addEventListener("click", async () => {
    const before = bellState.items;
    bellState.items = bellState.items.filter((item) => item.waits);
    bellState.menu = null;
    renderBellPanel();
    try {
      const result = await request("/api/notifications/dismiss", { method: "POST", body: JSON.stringify({ all: true }) });
      bellState.counts = result.counts;
      paintBell();
      if (result.dismissed.length) toast(t("Лента очищена"), { get label() { return t("Вернуть"); }, run: () => restoreNotifications(result.dismissed) });
    } catch (error) {
      bellState.items = before;
      renderBellPanel();
      toast(error.message);
    }
  });
  head.append(clearAll);
  const filters = node("div", undefined, "bell-filters");
  for (const [key, label] of NOTIFY_FILTERS) {
    const chip = node("button", label, "bell-filter");
    chip.type = "button";
    if (key === "waits" && bellState.counts.waits) chip.append(node("b", String(bellState.counts.waits)));
    chip.setAttribute("aria-pressed", String(bellState.filter === key));
    chip.addEventListener("click", () => { bellState.filter = key; renderBellPanel(); });
    filters.append(chip);
  }
  const list = node("div", undefined, "bell-list");
  const pick = (item) => bellState.filter === "all" || (bellState.filter === "waits" ? item.waits : item.group === bellState.filter);
  const shown = bellState.items.filter(pick);
  const pinned = bellState.filter === "all" ? shown.filter((item) => item.waits) : [];
  const rest = shown.filter((item) => !pinned.includes(item));
  const today = currentDayDate || notifyDay(new Date().toISOString()), yesterday = shiftDate(today, -1);
  const group = (label, items, extra = "") => {
    if (!items.length) return;
    list.append(node("p", label, `bell-group${extra}`));
    for (const item of items) list.append(notificationRow(item));
  };
  group(t("Ждут ответа"), pinned, " waits");
  group(t("Сегодня"), rest.filter((item) => notifyDay(item.updatedAt) === today));
  group(t("Вчера"), rest.filter((item) => notifyDay(item.updatedAt) === yesterday));
  group(t("Раньше"), rest.filter((item) => notifyDay(item.updatedAt) < yesterday));
  if (!list.childNodes.length) list.append(node("p", bellState.filter === "all" ? t("Всё разобрано. Новое появится здесь.") : t("По этому поводу ничего нет."), "bell-empty"));
  const foot = node("div", undefined, "bell-foot");
  const settings = bindTranslation(node("a", t("Настройки уведомлений →")), "Настройки уведомлений →");
  settings.href = "#settings";
  settings.addEventListener("click", () => { $("#bell-menu")?.removeAttribute("open"); setTimeout(() => $("#notify-settings")?.scrollIntoView({ block: "start" }), 60); });
  foot.append(bindTranslation(node("span", t("Открытое уходит из ленты")), "Открытое уходит из ленты"), settings);
  panel.append(head, filters, list, foot);
  panel.scrollTop = scroll;
}
// Открыть повод: карточку, разговор, круг или встречу на её дне — туда, где он
// случился. Открытое уходит из ленты; ждущее ответа остаётся до ответа.
function openNotification(item) {
  $("#bell-menu")?.removeAttribute("open");
  bellState.menu = null;
  if (!item.waits) dismissNotifications([item.id]);
  else if (!item.read) markNotificationsRead({ ids: [item.id] });
  if (["reminder", "clarify"].includes(item.kind) && item.captureId) return openCaptureById(item.captureId);
  if (item.captureId) return openSharedCard(item.captureId, { talk: ["call", "reply", "reaction", "chatter"].includes(item.kind) });
  if (item.roomId) return openRoomFromInbox(item.roomId);
  if (item.kind === "circle" && item.circleId) return openCircleFromInbox(item.circleId);
  if (["invite", "event_added", "event_changed"].includes(item.kind)) return openCalendarAt(item.data?.date || null, { uid: item.eventUid || null });
  if (typeof item.data?.url === 'string' && item.data.url.startsWith('/#')) {
    const target = item.data.url.slice(1);
    if (location.hash === target && item.kind === 'feedback_reply') feedbackArea.show();
    else location.hash = target;
    return;
  }
  const hash = { signup: "#admin", spend: "#admin/users", calendar_error: "#settings", digest: "#today" }[item.kind];
  if (hash) location.hash = hash;
}
async function markNotificationsRead(body) {
  const touches = (item) => body.all || body.ids?.includes(item.id) || (body.captureId && item.captureId === body.captureId && !item.waits) || (body.roomId && item.roomId === body.roomId);
  if (!bellState.items.some((item) => !item.read && touches(item))) return;
  for (const item of bellState.items) if (touches(item)) item.read = true;
  try { bellState.counts = (await request("/api/notifications/read", { method: "POST", body: JSON.stringify(body) })).counts; } catch {}
  paintBell();
}
$("#bell-menu")?.addEventListener("toggle", (event) => {
  if (!event.target.open) return;
  renderBellPanel();
  loadNotifications();
});

// Всплывашка — в углу, с теми же кнопками, что в строке ленты. Вкладка в фоне —
// системное уведомление через сервис-воркер: push не ушёл, потому что Кизуна
// открыта, и человек не должен пропустить повод из-за свёрнутого окна.
function showNotificationToast(item) {
  const stack = $("#notify-toasts");
  if (!stack) return;
  if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
    const who = item.actors?.length ? notifyPeople(item.actors) : item.lead;
    navigator.serviceWorker?.ready
      .then((registration) => registration.showNotification(item.data?.pushTitle || [who, item.text].filter(Boolean).join(" "), { body: item.data?.pushBody || (item.meta || []).join(" · "), tag: `${item.kind}:${item.id}`, data: { url: item.data?.url || location.href } }))
      .catch(() => {});
  }
  stack.querySelector(`[data-id="${item.id}"]`)?.remove();
  const card = node("div", undefined, "notify-toast");
  card.dataset.id = item.id;
  let timer = null;
  const dismiss = () => { clearTimeout(timer); card.remove(); };
  const main = node("div", undefined, "bell-main");
  const text = notificationText(item);
  text.addEventListener("click", () => { dismiss(); openNotification(item); });
  main.append(text);
  const meta = notificationMeta(item);
  if (meta.childNodes.length) main.append(meta);
  const acts = notificationActions(item, { after: dismiss });
  if (acts) main.append(acts);
  const close = node("button", "×", "notify-toast-close");
  close.type = "button";
  bindTranslation(close, "Скрыть", "aria-label");
  close.addEventListener("click", dismiss);
  card.append(notificationFace(item), main, close);
  stack.prepend(card);
  while (stack.children.length > 3) stack.lastElementChild.remove();
  timer = setTimeout(dismiss, 12000);
  card.addEventListener("mouseenter", () => clearTimeout(timer));
  card.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 6000); });
}

// Приглашение в полосе «к вам»: ответ — прямо в строке, как у просьбы.
function inviteRow(item) {
  const element = node("div", undefined, "inbox-row invite");
  const mark = node("span", undefined, "inbox-mark");
  mark.append(node("i", undefined, "inbox-circle"));
  const main = node("div", undefined, "inbox-main");
  const title = node("button", [item.lead, item.text].filter(Boolean).join(" "), "inbox-title");
  title.type = "button";
  title.addEventListener("click", () => openNotification(item));
  const meta = node("div", undefined, "inbox-meta");
  for (const piece of item.meta || []) meta.append(node("span", piece, "inbox-who"));
  main.append(title, meta);
  const acts = node("div", undefined, "inbox-acts");
  const answer = (label, className, status) => {
    const button = node("button", label, className);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await answerInvite(item, status); toast(status === "accepted" ? t("Принято — встреча в календаре") : t("Организатор узнает, что вас не будет")); await loadNotifications(); }
      catch (error) { button.disabled = false; toast(error.message || t("Не получилось ответить")); }
    });
    return button;
  };
  acts.append(answer(t("Приму"), "inbox-take", "accepted"), answer(t("Не смогу"), "inbox-not", "declined"));
  element.append(mark, main, acts);
  return element;
}

// Настройки поводов: колокольчик и телефон на каждый. Телефон без колокольчика
// не бывает — выключенный повод никуда не ложится.
function notifyPrefsNow() {
  try { return JSON.parse(appSettings.notifyPrefs || "{}") || {}; } catch { return {}; }
}
function notifySwitch(id, label, checked, disabled, onChange) {
  const button = node("button", undefined, "notify-switch");
  button.type = "button";
  button.id = id;
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-checked", String(checked));
  button.disabled = disabled;
  button.addEventListener("click", () => onChange(button.getAttribute("aria-checked") !== "true"));
  return button;
}
function setNotifyMode(kind, mode) {
  const prefs = notifyPrefsNow();
  if (kind.default === mode) delete prefs[kind.key];
  else prefs[kind.key] = mode;
  appSettings.notifyPrefs = JSON.stringify(prefs);
  paintNotifySettings();
  saveSettings({ notifyPrefs: JSON.stringify(prefs) }, { announce: null });
}
function paintNotifySettings() {
  const table = $("#notify-table");
  if (!table || !bellState.kinds.length) return;
  const prefs = notifyPrefsNow();
  clear(table);
  const cols = node("div", undefined, "notify-row notify-cols");
  cols.append(bindTranslation(node("span", t("Повод")), "Повод"), bindTranslation(node("span", t("Колокольчик")), "Колокольчик"), bindTranslation(node("span", t("Телефон")), "Телефон"));
  table.append(cols);
  const titles = { get people() { return t("Люди и круги"); }, get time() { return t("Сроки и встречи"); }, get other() { return t("Записи и служебное"); } };
  for (const group of ["people", "time", "other"]) {
    const kinds = bellState.kinds.filter((kind) => kind.group === group);
    if (!kinds.length) continue;
    table.append(node("p", titles[group], "notify-group"));
    for (const kind of kinds) {
      const presentation = NOTIFY_KIND_PRESENTATION[kind.key] || kind;
      const mode = ["off", "bell", "phone"].includes(prefs[kind.key]) ? prefs[kind.key] : kind.default;
      const row = node("div", undefined, "notify-row");
      const name = node("span", undefined, "notify-name");
      name.append(document.createTextNode(presentation.label));
      if (presentation.hint) name.append(node("span", presentation.hint, "notify-hint"));
      row.append(
        name,
        notifySwitch(`notify-bell-${kind.key}`, t("{label}: колокольчик", { label: t(kind.label) }), mode !== "off", false, (on) => setNotifyMode(kind, on ? "bell" : "off")),
        notifySwitch(`notify-phone-${kind.key}`, t("{label}: телефон", { label: t(kind.label) }), mode === "phone", mode === "off", (on) => setNotifyMode(kind, on ? "phone" : "bell")),
      );
      table.append(row);
    }
  }
  // Заглушённые из колокольчика календари: здесь их возвращают.
  const muted = mutedCalendarsNow();
  if (muted.length) {
    const line = bindTranslation(node("p", t("Об изменениях встреч молчат:"), "notify-muted"), "Об изменениях встреч молчат:");
    for (const accountId of muted) {
      const chip = node("button", `${calendarAccountLabel(accountId) || t("календарь")} ✕`);
      chip.type = "button";
      bindTranslation(chip, "Снова сообщать об изменениях", "title");
      chip.addEventListener("click", async () => {
        try { await saveMutedCalendars(mutedCalendarsNow().filter((id) => id !== accountId)); toast(t("Об изменениях снова сообщу")); }
        catch (error) { toast(error.message); }
      });
      line.append(chip);
    }
    table.append(line);
  }
}

// Живое обновление разговора: сообщение приходит к остальным событием журнала,
// и страница перечитывает список и открытый разговор, не сбивая набранное и не
// дёргая прокрутку, если человек читает выше.
//
// Перечитывание идёт одно за раз, и событие не теряется: пришло, пока грузятся
// круги или идёт прошлое перечитывание, — страница перечитает ещё раз, когда
// те закончатся. Ответ, ушедший раньше своей правки человека (сообщение,
// реакция, закреп, фото круга) или перехода в другой разговор, устарел: он
// выбрасывается, и разговор перечитывается заново. Иначе закреп у автора
// пропадал, а число у разговора, куда только что написали, не появлялось до
// следующего события.
async function refreshRoomsQuietly() {
  if ($("#circles")?.hidden) return;
  if (circlesState.loading || roomsRefresh.running) { roomsRefresh.again = true; return; }
  roomsRefresh.running = true;
  try { await refreshRoomsOnce(); }
  finally { roomsRefresh.running = false; }
  if (roomsRefresh.again) { roomsRefresh.again = false; await refreshRoomsQuietly(); }
}
async function refreshRoomsOnce() {
  const key = kc.chat, edits = roomsRefresh.edits;
  let data, rooms, talks, fresh = null;
  try {
    [data, rooms, talks] = await Promise.all([request("/api/circles"), request("/api/rooms"), request("/api/discussions").catch(() => ({ discussions: circlesState.discussions || [] }))]);
    if (key?.startsWith("room:") && (rooms.rooms || []).some((room) => room.id === key.slice(5))) fresh = await request(`/api/rooms/${key.slice(5)}/messages`);
    else if (key?.startsWith("talk:")) fresh = await request(`/api/captures/${key.slice(5)}/comments`);
  } catch { return; }
  if (key !== kc.chat || edits !== roomsRefresh.edits) { roomsRefresh.again = true; return; }
  const list = $("#kc-msgs");
  const atBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  circlesState.circles = data.circles || [];
  chatState.rooms = rooms.rooms || [];
  circlesState.discussions = talks.discussions || [];
  if (key?.startsWith("room:")) {
    if (fresh) {
      chatState.messages = fresh.messages || [];
      const room = chatState.rooms.find((item) => item.id === key.slice(5));
      if (room) Object.assign(room, fresh.room, { unread: 0, called: false });
    } else kc.chat = null;
  } else if (key?.startsWith("talk:")) {
    const captureId = key.slice(5);
    kc.talk = { captureId, comments: kcTalkItems(fresh.comments || []), callable: fresh.callable || [], participants: fresh.participants || [] };
    const talk = circlesState.discussions.find((item) => item.captureId === captureId);
    if (talk) { talk.unreadCount = 0; talk.unread = false; }
  }
  renderCircles({ toBottom: atBottom });
}

// Locale changes update UI labels and cached views without navigating or
// recreating the capture editor. Draft values and selection remain in place.
function persistLocale(choice) {
  const revision = ++localeSaveRevision;
  pendingLocaleChoice = choice;
  setLocale(choice);
  settingInput("locale").value = choice;
  syncLanguageControls();
  // Serialize account writes so the server cannot finish an older choice last.
  // Only the latest selection can repaint or announce a committed preference.
  settingsPreferenceSaveQueue = settingsPreferenceSaveQueue.then(async () => {
    try {
      const detectedLocale = getDetectedLocale(appSettings.detectedLocale);
      const payload = await request("/api/settings", { method: "PUT", body: JSON.stringify({ locale: choice, ...(detectedLocale ? { detectedLocale } : {}) }) });
      appSettings = { ...appSettings, locale: payload.settings.locale, detectedLocale: payload.settings.detectedLocale };
      if (revision !== localeSaveRevision) return;
      pendingLocaleChoice = null;
      initLocale(appSettings);
      settingInput("locale").value = appSettings.locale;
      syncLanguageControls();
      announceLocaleSaved(appSettings);
      loadNotifications();
      paintUpcomingReminders();
    } catch (error) {
      if (revision !== localeSaveRevision) return;
      pendingLocaleChoice = null;
      initLocale(appSettings);
      settingInput("locale").value = appSettings.locale || "system";
      syncLanguageControls();
      toast(error.message);
    }
  });}
settingInput("locale")?.addEventListener("change", event => persistLocale(event.target.value));
mountLanguageControls(persistLocale);
window.addEventListener("pagent:localechange", () => {
  renderToday();
  paintThemeButton();
  paintAccountSummary();
  paintAvatarPicker();
  if (currentUser) $("#account-role").textContent = roleNames[currentUser.role] || currentUser.role;
  for (const name of SECRET_FIELDS) {
    const state = document.getElementById(`state-${name}`);
    const value = appSettings[name];
    if (state) state.textContent = value?.configured ? `${value.hint}${value.fromEnvironment ? t(" · из .env") : ""}` : t("не настроен");
  }
  if (telegramView) paintTelegram(telegramView);
  paintBell();
  paintPush();
  paintNotifySettings();
  paintUpcomingReminders();
  const page = location.hash.slice(1).split("?")[0];
  if (page === "board") loadBoard({ force: true });
  if (page === "done") loadDone({ fresh: true });
  if (page === "calendar") loadCalendar();
  if (page === "guide") updatePageFromHash();
  if (page.startsWith('admin')) adminArea.show();
  if (page === 'feedback') feedbackArea.show();
});

window.addEventListener("pagent:timezonechange", () => {
  dayTimeZoneGeneration += 1;
  dayLoadToken += 1;
  todayState.done = [];
  todayState.calendar = null;
  todayState.doneKnownDate = null;
  todayState.calendarKnownDate = null;
  todayState.doneLoading = false;
  todayState.calendarLoading = false;
  todayState.doneStale = true;
  todayState.calendarStale = true;
  todayState.cache.clear();
  const previousDay = currentDayDate;
  currentDayDate = zoneDate(new Date());
  if (calState.anchor === previousDay) calState.anchor = currentDayDate;
  boardState.locale = null;
  renderToday();
  paintUpcomingReminders();
  paintTimeZoneSetting();
  load().catch(() => {});
  const page = location.hash.slice(1).split("?")[0];
  if (page === "board") loadBoard({ force: true });
  if (page === "calendar") loadCalendar();
  if (page === "done") loadDone({ fresh: true });
});

// Apply remote display choices in place. Rebuilding an active editor or an
// in-progress drag would lose text, so only board/calendar redraws wait for it.
let pendingViewKeys = new Set();
function applySyncedViewPreferences() {
  const keys = pendingViewKeys;
  paintCaptureSize();
  paintDrawersWidth();
  paintCardSize();
  paintTalkHeight();
  cardWorkspace?.paint();
  if (keys.has(CARD_MODE_KEY)) {
    const dialog = $("#review-dialog");
    paintCardMode();
    if (dialog.open && dialog.matches(":modal") !== cardNeedsModal()) reopenCardDialog(dialog);
    markOpenCard();
  }
  if (keys.has("pagent.theme")) { window.pagentTheme.refresh(); paintThemeButton(); }
  if (keys.has("pagent.text")) window.pagentText.refresh();
  const editing = document.activeElement?.matches("input, textarea, [contenteditable=true]");
  const busy = editing || boardState.drag || calState.drag || boardState.openAdder || calState.pop;
  const redraw = [...keys].some(key => key.startsWith("kizuna-board-") || key.startsWith("kizuna-calendar-") || key === "pagent.circles-table");
  if (redraw && busy) return;
  pendingViewKeys = new Set();
  if ([...keys].some(key => key.startsWith("kizuna-board-"))) {
    boardState.view = boardStoredView();
    boardState.groups = boardStoredGroups();
    boardState.filter = boardStoredFilter();
    boardState.filterOpen = activeConditions(boardState.filter).length > 0;
    boardState.order = boardStoredOrder();
    boardState.shown = boardStoredShown();
    boardState.subs = boardStoredSubs();
    boardState.stamp = null;
    if (!$("#board").hidden) loadBoard({ force: true });
  }
  if ([...keys].some(key => key.startsWith("kizuna-calendar-"))) {
    calState.mode = uiStorage.getItem("kizuna-calendar-mode") || (CAL_PHONE.matches ? "day" : "week");
    calState.hidden = new Set(JSON.parse(uiStorage.getItem("kizuna-calendar-hidden") || "[]"));
    if (!$("#calendar").hidden) loadCalendar();
  }
  if (keys.has("pagent.circles-table")) {
    kc.table = kcStored("pagent.circles-table", true) !== false;
    if (!$("#circles").hidden) renderCircles();
  }
}
window.addEventListener("kizuna-ui-preferences", event => {
  for (const key of event.detail.keys) pendingViewKeys.add(key);
  applySyncedViewPreferences();
});
setInterval(() => { if (pendingViewKeys.size) applySyncedViewPreferences(); }, 500);
window.addEventListener("resize", () => { paintCaptureSize(); paintDrawersWidth(); });
startUiPreferenceSync();
