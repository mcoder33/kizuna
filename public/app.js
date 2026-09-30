import { renderMarkdown, renderInlineMarkdown } from "./markdown.js";
import { createMarkdownField } from "./markdown-live.js";
import { attachSlashMenu } from "./slash-menu.js";
import { attachLinkMenu } from "./link-menu.js";
import { attachMentionMenu, forgetMentionPeople } from "./mention-menu.js";
import { attachFormatToolbar } from "./format-toolbar.js";
import { openNotes, refreshNotes } from "./notes.js";
import { mountGuide } from "./guide.js";
import { phaseOf, coverFor, plural, hm, duration, minutesOf, longDate, shortDate, isWeekend, MEETINGS, DEALS, PHASE_NAMES } from "./today-cover.js";
import { FILTER_FIELDS, FILTER_STATUSES, FILTER_NONE, DONE_LANE, defaultFilter, readFilter, tidyFilter, activeConditions, sameFilter, matchesFilter, statusAllowsDone, readOrder, orderKeys, moveKey } from "./board-model.js";

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
  // Приглашение в круг приходит ссылкой «#join/<токен>»: это не страница, а
  // разовое действие, поэтому разбирается до страниц.
  if (hash.startsWith("join/")) { openInvite(hash.slice(5)); return; }
  const separator = hash.indexOf("?");
  const pageId = (separator >= 0 ? hash.slice(0, separator) : hash) || "today";
  const params = new URLSearchParams(separator >= 0 ? hash.slice(separator + 1) : "");
  const page = document.getElementById(pageId);
  const activePage = page?.classList.contains("app-page") ? pageId : "today";
  // Ссылка из уведомления: открыть карточку записи и убрать параметр из адреса.
  const openId = params.get("open");
  if (openId) { params.delete("open"); history.replaceState(null, "", `#${activePage}${params.size ? `?${params}` : ""}`); openCaptureById(openId); }
  // Ссылка из push о разговоре: открыть комнату круга.
  const roomId = params.get("room");
  if (roomId) { params.delete("room"); history.replaceState(null, "", `#${activePage}${params.size ? `?${params}` : ""}`); openRoomFromInbox(roomId); }
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
  // Вопрос из адреса «#guide?q=…» открывается сразу — на него можно дать
  // ссылку, а с «&demo=1» он сразу идёт демо. В шапке страницы нет.
  if (activePage === "guide") renderGuide(params.get("q"), params.has("demo"));
  // Открыли настройки — перечитываем расход: он меняется от каждой записи, а
  // страница может висеть открытой долго.
  if (activePage === "settings") {
    paintPush();
    paintUpcomingReminders();
    loadUsage();
    loadCalendarAccounts();
    loadTelegram();
    loadMemory();
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
function scheduleLabel(schedule, on = null) {
  if (!schedule) return null;
  if (schedule.state === "conflict" || (!schedule.date && !schedule.time))
    return schedule.display || null;
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
        ? "сегодня"
        : shown === shiftDate(today, 1)
          ? "завтра"
          : shown === shiftDate(today, -1)
            ? "вчера"
            : `${shown.slice(8, 10)}.${shown.slice(5, 7)}${
                shown.slice(0, 4) === today.slice(0, 4)
                  ? ""
                  : `.${shown.slice(0, 4)}`
              }`;
  }
  const vague =
    !schedule.time && schedule.display?.includes("после обеда")
      ? "после обеда"
      : null;
  const words = repeatLabel(schedule.repeat, { until: false });
  return (
    [dateLabel, schedule.time || vague, words].filter(Boolean).join(", ") ||
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
    // Промах кружком снимается одним нажатием, как удаление и перенос серии.
    toast(complete ? "Отмечено как готовое" : "Возвращено в работу", complete ? { label: "Вернуть", run: async () => {
      try {
        for (const projection of pending) await request(`/api/projections/${projection.id}/undo-complete`, { method: "POST", body: "{}" });
        toast("Возвращено в работу");
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
    toast(date ? `Срок: ${scheduleLabel({ state: "ok", date, time: null })}` : "Срок снят", { label: "Вернуть", run: async () => {
      try { await move(schedule?.date || null, schedule?.time || null); toast("Срок вернулся"); await load(); }
      catch (error) { toast(error.message); }
    } });
    await load();
  } catch (error) { toast(error.message || "Срок не изменился"); }
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
    const box = row.querySelector(":scope > .completion-button, :scope > .board-done, :scope > td .board-done");
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
    if (scheduleOf(entry)?.date) { toast("Срок у дела уже есть — перенести можно в карточке"); return; }
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
    if (event.pointerType !== "touch" || event.target.closest(".completion-button, .quick-due, a, input")) return;
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
function quickDueEl(entry, choices = [["сегодня", 0], ["завтра", 1], ["без срока", null]]) {
  const wrap = node("div", undefined, `quick-due${choices.length === 1 ? " take-today" : ""}`);
  for (const [label, days] of choices) {
    const button = node("button", label, "quick-due-button");
    button.type = "button";
    button.title = days === null ? "Снять срок" : `Перенести на ${label}`;
    button.addEventListener("click", (event) => { event.stopPropagation(); button.disabled = true; quickDue(entry, days); });
    wrap.append(button);
  }
  return wrap;
}
// «с вчера», «с 28 сен»: с какого дня дело висит открытым.
const SHORT_MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
function sinceLabel(date) {
  if (!date) return "просрочено";
  if (currentDayDate && date === shiftDate(currentDayDate, -1)) return "со вчера";
  return `с ${Number(date.slice(8, 10))} ${SHORT_MONTHS[Number(date.slice(5, 7)) - 1] || ""}`.trim();
}
// Строка дела: кружок, название и справа тихие чипы — час или «со вчера»,
// люди, круг, кому передано. Типа, проекта и тегов у неё нет: всё, что
// записано, — дело. doneAt — минуты закрытия для строки «Сделано».
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
    const label = completed ? "Вернуть в работу" : "Готово",
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
  title.addEventListener("click", () => {
    // Карточка вытекает из той записи, по которой щёлкнули.
    const review = reviewFromEntry(entry);
    cardOccurrence = c.entities.schedule?.repeat && on && scheduledOn(entry, on) ? on : null;
    const list = card.closest("#todo, #journal");
    pendingCardList = list ? { label: list.id === "journal" ? "Сделано" : "День", items: rowsAsList([...list.querySelectorAll(".entry[data-capture-id]")]), id: entry.id, occurrence: card.dataset.occurrence || null } : null;
    // Запись из круга открывается перечитанной: обсуждение и исполнитель
    // меняются у другого человека, и показывать вчерашний разговор нельзя.
    if (entry.foreign || circleOf(entry)) { openSharedCard(entry.id); return; }
    showCorrection(entry, review.level === "high" ? undefined : review);
  });
  card.append(title);
  // Просроченное не переносят в карточке — оно решается прямо в строке.
  if (overdue && !c.entities.schedule?.repeat && !completed) card.append(quickDueEl(entry, [["сегодня", 0], ["завтра", 1]]));
  // Дело из запаса берут на сегодня, не открывая карточку.
  if (takeToday && !completed) card.append(quickDueEl(entry, [["на сегодня", 0]]));
  const mark = circleOf(entry);
  if (mark) meta.append(circleChip(mark, { small: true }));
  // Чьё это дело: взятое — «от Саши», отданное — «Аня · ждёт ответа». Второе и
  // есть слежение за реализацией, только без доски со статусами.
  const assignment = entry.assignment || todayState.assignments?.[entry.id] || null;
  if (assignment && assignment.state !== "declined")
    meta.append(node("span", entry.foreign ? `от ${genitiveName(assignment.assigner?.name) || "автора"}` : `${assignment.assignee?.name || ""} · ${assignmentWord(assignment)}`, "tag assign"));
  const due = scheduleLabel(c.entities.schedule, on);
  const repeats = c.entities.schedule?.repeat ? repeatLabel(c.entities.schedule.repeat, { until: false }) : null;
  const dueToday = c.entities.schedule?.repeat ? scheduledOn(entry, currentDayDate) : Boolean(c.entities.schedule?.date) && c.entities.schedule.date === currentDayDate;
  if (overdue && !completed) meta.append(node("span", sinceLabel(c.entities.schedule?.date), "tag due late"));
  else if (repeats && !completed) meta.append(node("span", atTime || dueToday ? repeats : due, "tag due"));
  else if (due && !atTime && !dueToday && !doneAt) meta.append(node("span", due, "tag due"));
  if (c.priority === "high") meta.append(node("span", "важно", "tag urgent"));
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
  card.append(meta);
  return card;
}
// ── «Сегодня»: обложка по часам, полоса дней, два ящика ──────────────────────
// Страница знает, который час: дата с фазой суток, бриф из двух-трёх фраз и
// вопрос в поле меняются утром, днём, вечером и ночью. Под полем — два ящика
// с вкладками и своей полосой дней: «Сделано» (закрытое кружком и прошедшие
// встречи) и «День», где дела лежат вместе с календарём. Заметок здесь нет:
// любая запись — туду, а старые заметки видны в «Обзоре» и в поиске.
const TODAY_ZONE = "Europe/Samara";
const circlesState = { circles: [], me: null, loading: false, tab: "chat", discussions: [] };
// Перечитывание разговоров (refreshRoomsQuietly): идёт ли, нужно ли ещё раз и
// счётчик своих правок, по которому узнаётся устаревший ответ. Объявлено здесь,
// а не у страницы кругов: переход по адресу при загрузке зовёт loadCircles
// раньше, чем исполнится её код.
const roomsRefresh = { running: false, again: false, edits: 0 };
function kcEdited() { roomsRefresh.edits += 1; }
const todayState = {
  view: 0,            // смещение дня, показанного в «Дне», от сегодняшнего
  journalView: 0,     // то же для «Сделано»: у ящиков свои дни
  tab: null,          // открытый ящик: "journal" | "day" | null
  manual: false,      // ящик выбран рукой — фаза его не трогает
  phase: null,
  cover: null,
  calendar: null,     // /api/calendar на сегодня и завтра
  entries: [],
  done: [],     // строки «Сделано» из /api/done на сегодня
  doneStale: true,
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
};
function zoneMinutes(at) {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: TODAY_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return (get("hour") % 24) * 60 + get("minute");
}
const nowMinutes = () => zoneMinutes(new Date());
const zoneDate = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: TODAY_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
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
  todayState.calendarLoading = true;
  try { todayState.calendar = pruneRemovedExternal(await request(`/api/calendar?from=${currentDayDate}&to=${shiftDate(currentDayDate, 1)}`)); }
  catch { todayState.calendar = todayState.calendar || null; }
  finally { todayState.calendarLoading = false; }
  todayState.calendarStale = false;
  renderToday();
}
async function refreshTodayDone() {
  if (todayState.doneLoading || !currentDayDate) return;
  todayState.doneLoading = true;
  try {
    const closed = await request(`/api/done?from=${currentDayDate}&to=${currentDayDate}`);
    todayState.done = (closed?.days || []).flatMap((group) => group.items).filter((item) => !item.auto);
  } catch { /* список остаётся прежним */ }
  finally { todayState.doneLoading = false; }
  todayState.doneStale = false;
  renderToday();
}
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
function scheduledOn(entry, date) { const schedule = scheduleOf(entry); return Boolean(schedule?.date) && (schedule.date === date || repeatOccursOn(schedule, date)); }
// Ближайший экземпляр повтора не раньше даты — для подписи срока.
function nextRepeatDate(schedule, from) {
  if (!schedule?.repeat || !schedule.date) return null;
  let day = from < schedule.date ? schedule.date : from;
  for (let step = 0; step < 800; step += 1) { if (repeatOccursOn(schedule, day)) return day; day = shiftDate(day, 1); }
  return null;
}
const REPEAT_WORDS = { daily: ["каждый день", "дня", "дней"], weekly: ["каждую неделю", "недели", "недель"], monthly: ["каждый месяц", "месяца", "месяцев"], yearly: ["каждый год", "года", "лет"] };
function repeatLabel(rule, { until = true } = {}) {
  if (!rule?.freq || !REPEAT_WORDS[rule.freq]) return null;
  const count = rule.interval || 1;
  const [one, few, many] = REPEAT_WORDS[rule.freq];
  let text = count === 1 ? one : `каждые ${count} ${count < 5 ? few : many}`;
  if (until && rule.until) text += ` до ${rule.until.slice(8, 10)}.${rule.until.slice(5, 7)}`;
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
    if (announce) toast(`Повтор ${calHuman(date)} убран, серия осталась`, { label: "Вернуть", run: async () => {
      try { await request(`/api/captures/${id}/corrections`, { method: "POST", body: body(without) }); await refreshAfterSkip(); toast("Повтор возвращён"); }
      catch (error) { toast(error.message); }
    } });
  } catch (error) { toast(error.message); }
}
// Кружок у повтора: экземпляр закрывается одним запросом. Сервер пишет событие
// «экземпляр закрыт» (оно попадает в «Сделано» на «Сегодня» и на страницу «Сделано») и убирает день из
// серии, остальные повторы живут дальше. «Вернуть» снимает событие и возвращает день.
async function doneOccurrence(target, date, { announce = true } = {}) {
  let { id, projectionId = null } = target;
  try {
    if (!projectionId) {
      const { entry } = await request(`/api/captures/${id}`);
      projectionId = projectionOfType(entry, "task")?.id || null;
    }
    if (!projectionId) throw new Error("У записи нет дела");
    await request(`/api/projections/${projectionId}/complete`, { method: "POST", body: JSON.stringify({ occurrence: date }) });
    await refreshAfterSkip();
    if (announce) toast(`Готово на ${calHuman(date)}, серия осталась`, { label: "Вернуть", run: async () => {
      try {
        const { entry } = await request(`/api/captures/${id}`);
        await request(`/api/projections/${projectionOfType(entry, "task")?.id || projectionId}/undo-complete`, { method: "POST", body: JSON.stringify({ occurrence: date }) });
        await refreshAfterSkip();
        toast("Повтор возвращён");
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
    ...external.map((item) => ({ id: item.id, title: item.title, start: minutesOf(item.time), end: minutesOf(item.end) ?? minutesOf(item.time) + defaults, joinUrl: item.joinUrl || null, busy: busyOnly(item) })),
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
  if (todayState.calendarStale && !$("#today")?.hidden) refreshTodayCalendar();
  if (todayState.doneStale && !$("#today")?.hidden) refreshTodayDone();
  const minutes = nowMinutes();
  const phase = phaseOf({ minutes, weekend: isWeekend(currentDayDate) });
  const cover = coverFor({
    phase,
    minutes,
    meetings: todayMeetings(),
    tasks: todayTasks(),
    doneCount: doneRows().length,
    tomorrow: tomorrowInfo(),
    calendar: calendarConnected(),
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
const FIRST_STEPS = [
  "Завтра в 11 созвон с Аней по проекту",
  "Нужно оплатить хостинг до пятницы",
  "Созвонились по проекту, решили начать с детектора",
];
function firstStepNode() {
  const box = node("div", undefined, "today-start");
  box.append(node("p", "Журнал пустой. Напишите своими словами что угодно — разберётся само. Например:", "start-lead"));
  const row = node("div", undefined, "start-row");
  for (const text of FIRST_STEPS) {
    const button = node("button", text, "start-chip");
    button.type = "button";
    button.addEventListener("click", () => prefillCapture(text));
    row.append(button);
  }
  box.append(row);
  // Кроме примеров — обучение: прогоны показывают, как всё устроено, руками.
  const help = node("a", "Как пользоваться →", "start-help");
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
  const rows = [...$("#todo").querySelectorAll(".entry[data-capture-id]")].filter((row) => ids.has(row.dataset.captureId));
  const shelf = $("#todo .day-group.late") || $("#todo .day-group.today");
  (shelf?.closest(".day-head") || shelf || rows[0])?.scrollIntoView({ block: "start", behavior: motionAllowed() ? "smooth" : "auto" });
  // Класс встаёт на следующем кадре, чтобы фон успел проявиться плавно, а не появился сразу.
  requestAnimationFrame(() => { for (const row of rows) row.classList.add("flash"); });
  setTimeout(() => { for (const row of rows) row.classList.remove("flash"); }, 1400);
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
      toast(`Перенесено на завтра: ${moved.length}${failure ? ` из ${tasks.length}` : ""}`, { label: "Вернуть", run: async () => {
        try {
          for (const item of moved) await put(item.id, item.before);
          toast("Сроки вернулись");
          await load();
          refreshOtherViews();
        } catch (error) { toast(error.message); }
      } });
    else toast(failure?.message || "Не получилось перенести");
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
    // Дела в шапке — сегодняшние, как в утренней сводке: со сроком сегодня и
    // ждущие уточнения. Запас без срока считается у своей полки.
    const todays = todayState.todo.filter((entry) => !isActiveMeeting(entry) && todoOrder(entry, date) > 0 && todoOrder(entry, date) <= 2);
    const allDay = (todayState.calendar?.external || []).filter((item) => item.date === date && item.allDay).length;
    const meetings = todayMeetings().length + allDay;
    if (calendarConnected() || meetings) parts.push(plural(meetings, MEETINGS));
    parts.push(plural(todays.length, DEALS));
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
const DRAWER_PANELS = { journal: "journal", day: "todo" };
function paintTabs(date, journalDate) {
  const host = $("#today-tabs");
  clear(host);
  const today = date === currentDayDate, journalToday = journalDate === currentDayDate;
  const doneList = doneRows(journalDate);
  const doneCount = doneList ? String(doneList.length) : "…";
  const tabs = [
    ["journal", journalToday ? "Сделано" : `Сделано ${shortDate(journalDate)}`, node("b", doneCount)],
    ["day", today ? "День" : `День ${shortDate(date)}`, dayCountNode(date)],
  ];
  for (const [key, label, count] of tabs) {
    const button = node("button", undefined, "drawer-tab");
    button.type = "button";
    button.id = `tab-${key}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(todayState.tab === key));
    button.setAttribute("aria-controls", DRAWER_PANELS[key]);
    button.append(node("span", label, "drawer-tab-label"), count);
    // Повторный щелчок по открытой вкладке закрывает ящик.
    button.addEventListener("click", () => pickTodayTab(todayState.tab === key ? null : key));
    host.append(button);
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
// «прошла», а в «Сделано» появляется сама. Событие на весь день, занятость и
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
  } else if (pastDay) {
    className += " past";
    if (start != null) meta.append(node("span", "прошла", "tag"));
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
  more.href = "#board";
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
  chip.title = `Круг «${circle.name}»`;
  return chip;
}
const circleOf = (entry) => entry.circle || todayState.circleMarks?.[entry.id] || null;
const ASSIGNMENT_WORDS = { pending: "ждёт ответа", accepted: "взято", declined: "отказ", done: "сделано" };
const assignmentWord = (assignment) => ASSIGNMENT_WORDS[assignment.state] || assignment.state;
// «От Саши», «от Ани»: имя в строке стоит в родительном падеже, иначе фраза
// читается как заголовок таблицы. Правило простое и честное — хвост имени;
// имя, которое не склоняется («Отто», «Мэри»), остаётся как есть.
function genitiveName(name) {
  const value = String(name || "").trim();
  if (!value) return value;
  const last = value.slice(-1).toLowerCase();
  if (last === "ь" || last === "й") return `${value.slice(0, -1)}я`;
  if (last === "я") return `${value.slice(0, -1)}и`;
  if (last === "а") return `${value.slice(0, -1)}${"гкхжшчщ".includes(value.slice(-2, -1).toLowerCase()) ? "и" : "ы"}`;
  if ("оеиуыэю".includes(last)) return value;
  return `${value}а`;
}
async function respondRequest(row, take, button) {
  const reason = take ? null : (prompt("Почему не вы? Можно не отвечать — причина уйдёт автору.") ?? "").trim();
  if (button) button.disabled = true;
  try {
    await request(`/api/assignments/${row.id}/respond`, { method: "POST", body: JSON.stringify({ take, ...(reason ? { reason } : {}) }) });
    toast(take ? "Взяли: дело в вашем дне" : "Вернули автору");
    await load();
  } catch (error) {
    if (button) button.disabled = false;
    toast(error.message || "Не получилось ответить");
  }
}
function inboxRow(row) {
  const element = node("div", undefined, `inbox-row ${row.kind}`);
  const mark = node("span", undefined, "inbox-mark");
  mark.append(node("i", undefined, row.kind === "call" ? "inbox-bubble" : "inbox-circle"));
  const main = node("div", undefined, "inbox-main");
  const label = row.kind === "request" ? row.title
    : row.kind === "circle" ? `${row.from?.name || "Вас"} добавил${row.from ? "" : "и"} в круг «${row.circle.name}»`
    : `${row.from.name} зовёт: «${row.kind === "chat" ? row.title : row.body}»`;
  const open = () => (row.kind === "chat" ? openRoomFromInbox(row.roomId) : row.kind === "circle" ? openCircleFromInbox(row.circle.id) : openSharedCard(row.captureId, { talk: row.kind === "call" }));
  const title = node("button", label, "inbox-title");
  title.type = "button";
  title.addEventListener("click", open);
  const meta = node("div", undefined, "inbox-meta");
  if (row.kind === "request") meta.append(node("span", `просит ${row.from.name}`, "inbox-who"));
  else if (row.kind === "chat") meta.append(node("span", `разговор «${row.roomName}»`, "inbox-who"));
  else if (row.kind === "circle") meta.append(node("span", "общая полка: видно только то, что в неё отдали", "inbox-who"));
  else meta.append(node("span", `обсуждение «${row.title}»`, "inbox-who"));
  if (row.circle) meta.append(circleChip(row.circle, { small: true }));
  if (row.due) meta.append(node("span", `срок: ${scheduleLabel({ date: row.due.date, time: row.due.time }) || row.due.date}`, "inbox-due"));
  meta.append(node("span", agoWords(row.createdAt) || "", "inbox-ago"));
  main.append(title, meta);
  const acts = node("div", undefined, "inbox-acts");
  if (row.kind === "request") {
    const take = node("button", "Беру", "inbox-take");
    take.type = "button";
    take.addEventListener("click", () => respondRequest(row, true, take));
    const not = node("button", "Не я", "inbox-not");
    not.type = "button";
    not.addEventListener("click", () => respondRequest(row, false, not));
    acts.append(take, not);
  } else {
    const openButton = node("button", "Открыть", "inbox-not");
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
  title.append(node("span", ` выключен — ${item.count} ${pluralRu(item.count, "просьба", "просьбы", "просьб")}`));
  const meta = node("div", undefined, "inbox-meta");
  meta.append(node("span", `последняя: ${agoWords(item.lastAt) || ""}${item.from ? ` · от ${item.from.name}` : ""}`, "inbox-who"));
  main.append(title, meta);
  const acts = node("div", undefined, "inbox-acts");
  const show = node("button", "Включить круг", "inbox-not");
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
  container.append(node("div", `к вам · ${rows.length + invites.length + folded.reduce((total, item) => total + item.count, 0)}`, "day-group inbox-group"));
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
    link.append(node("span", `На других ${open.length} ${pluralRu(open.length, "дело", "дела", "дел")}`, "strong"));
    if (late) link.append(node("span", ` · ${late} ${pluralRu(late, "ждёт", "ждут", "ждут")} ответа второй день`));
    link.append(node("span", " — в «Кругах» →"));
    link.addEventListener("click", () => { location.hash = "#circles"; });
    container.append(link);
  }
  for (const circle of todayState.mutedCircles || []) {
    const line = node("div", undefined, "day-muted");
    line.append(circleChip(circle, { small: true }), node("span", ` выключен — ${circle.deeds} ${pluralRu(circle.deeds, "дело", "дела", "дел")}. `));
    const on = node("button", "Включить", "linklike");
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
  } catch (error) { toast(error.message || "Не получилось"); }
}
// Чужая карточка открывается тем же окном, что и своя: запись живёт у автора,
// а мы читаем её и пишем в обсуждение.
async function openSharedCard(captureId, { talk = false } = {}) {
  try {
    const { entry } = await request(`/api/captures/${captureId}`);
    cardTalkOnOpen = talk;
    showCorrection(entry, reviewFromEntry(entry).level === "high" ? undefined : reviewFromEntry(entry));
  } catch (error) { toast(error.message || "Запись не открылась"); }
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
// Заголовок полки «просрочено» или «на сегодня». Если на полке есть что
// переносить, справа от подписи — тихая ссылка «перенести всё на завтра»; подпись
// остаётся своим элементом .day-group, ссылка стоит рядом с ней в общей строке.
function shelfHeadEl(text, kind, entries) {
  const label = node("div", text, `day-group ${kind}`);
  const movable = entries.filter((entry) => canPostpone(entry));
  if (!movable.length) return label;
  const head = node("div", undefined, "day-head");
  const act = node("button", "перенести всё на завтра", `day-head-act ${kind}`);
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
    container.append(todayState.entries.length ? node("p", "Открытых дел нет.", "empty") : firstStepNode());
    appendMore(container, hidden);
    paintCircleTail(container);
    return;
  }
  // Часы идут первыми: день — это прежде всего встречи, к которым надо успеть.
  // Пока они лежали под списком дел, до «что у меня в 12:30» человек добирался
  // через двенадцать строк. Событие на весь день стоит над часами: оно про весь
  // день, а не про какой-то из них.
  if (hours.length || allDay.length) {
    container.append(node("div", "по часам", "day-group"));
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
    container.append(shelfHeadEl(`просрочено · ${late.length}`, "late", late));
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
    container.append(shelfHeadEl(shelf.length ? `на сегодня · ${shelf.length}` : "на сегодня", "today", shelf));
    if (shelf.length) {
      const rows = node("div", undefined, "day-rows");
      for (const entry of shelf) rows.append(entryCard(entry, { on: today }));
      container.append(rows);
    } else container.append(node("p", "Без часа на сегодня ничего — возьмите дело из запаса.", "day-shelf-empty"));
  }
  if (stock.length) {
    container.append(node("div", `без срока · ${stock.length}`, "day-group stock"));
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
    container.append(node("p", pastDay ? "Встреч и дел со сроком не было." : "Встреч и дел со сроком пока нет.", "empty"));
    return;
  }
  if (hours.length || allDay.length) {
    container.append(node("div", "по часам", "day-group"));
    for (const item of allDay) container.append(eventRow(item, { pastDay }));
    for (const slot of hours) container.append(slot.entry ? rowWithTime(scheduleOf(slot.entry).time, card(slot.entry, true)) : eventRow(slot.item, { pastDay }));
  }
  if (band.length) {
    container.append(node("div", "дела", "day-group"));
    const rows = node("div", undefined, "day-rows");
    for (const entry of band) rows.append(card(entry));
    container.append(rows);
  }
}
// «Сделано» на «Сегодня» — то же, что вечером назвали бы итогом дня: туду, закрытые
// кружком (кружок возвращает в работу), и встречи из календаря, чей конец
// прошёл (пунктирный кружок: закрылись сами, руками их не вернуть). Сегодня —
// из /api/done и календаря; другой день — из отчёта «Обзора» и календаря того
// дня. Порядок — по времени, свежее сверху. null — день ещё не загружен.
function doneRows(date = currentDayDate) {
  const minutes = nowMinutes();
  let rows;
  if (date === currentDayDate) rows = todayState.done.map((item) => ({ done: item, at: minutesOf(item.time) ?? 0 }));
  else {
    const data = todayState.cache.get(date);
    if (!data) return null;
    rows = (data.report?.done || []).map((record) => ({ record, at: zoneMinutes(new Date(record.at)) }));
  }
  for (const item of externalFor(date))
    if (eventEnded(item, minutes, date)) rows.push({ item, at: eventFinish(item) });
  return rows.sort((a, b) => b.at - a.at);
}
// Строка «Сделано» из /api/done: зелёный кружок «Вернуть в работу» (у
// экземпляра повтора он снимает только этот день), название и час закрытия.
// Старая запись без дела внутри возвращать нечем — у неё немой кружок.
function doneItemRow(item) {
  const row = node("div", undefined, `entry dense completed${item.projectionId ? " completable" : ""}`);
  row.dataset.captureId = item.id;
  if (item.projectionId) {
    const button = node("button", undefined, "completion-button");
    button.type = "button";
    button.title = "Вернуть в работу";
    button.setAttribute("aria-label", "Вернуть в работу");
    button.setAttribute("aria-pressed", "true");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request(`/api/projections/${item.projectionId}/undo-complete`, { method: "POST", body: JSON.stringify(item.occurrence ? { occurrence: item.occurrence } : {}) });
        toast("Возвращено в работу");
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
  if (item.occurrence) meta.append(node("span", "повтор", "tag due"));
  meta.append(node("span", item.time, "tag time"));
  row.append(title, meta);
  return row;
}
function autoDoneRow(item, at) {
  const row = node("div", undefined, "entry completed auto-done");
  row.dataset.eventId = item.id;
  const mark = node("span", undefined, "completion-button auto");
  mark.title = "Прошла по календарю";
  const title = node("span", item.title, "entry-title");
  const meta = node("div", undefined, "entry-meta");
  meta.append(node("span", "прошла по календарю", "tag auto"), node("span", hm(at), "tag time"));
  row.append(mark, title, meta);
  return row;
}
function paintJournal(date) {
  const container = $("#journal");
  clear(container);
  container.append(dayNavNode(date, { view: todayState.journalView, onView: setJournalView }));
  const rows = doneRows(date);
  if (!rows) { container.append(node("p", "Загружаю…", "empty")); ensureDayData(date); return; }
  if (!rows.length) {
    container.append(node("p", date === currentDayDate ? "Пока нет зафиксированной работы за сегодня." : date < currentDayDate ? "В этот день ничего не записано." : "День ещё не наступил.", "empty"));
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
// Раз в минуту обложка и строка «сейчас» пересчитываются — но не под руками:
// с текстом в поле страница ждёт.
setInterval(() => {
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
  // Календарь на сегодня и завтра нужен «Дню» и брифу. Он грузится вместе с
  // журналом, но только пока открыта «Сегодня»: на других страницах журнал
  // перечитывается так же быстро, как раньше, а календарь добирается при
  // возвращении. Другие дни грузятся, когда их открывают, и забываются при
  // каждом изменении журнала.
  const todayGuess = currentDayDate || zoneDate(new Date());
  const onToday = !$("#today")?.hidden;
  const [day, entries, calendar, closed] = await Promise.all([
    request("/api/day"),
    request("/api/entries?limit=100"),
    onToday ? request(`/api/calendar?from=${todayGuess}&to=${shiftDate(todayGuess, 1)}`).catch(() => null) : Promise.resolve(undefined),
    // «Сделано» рисуется прямо из /api/done: старое дело, закрытое сегодня, не
    // попадает в последние сто записей, и добирать его карточкой не нужно. Звать
    // только пока открыта «Сегодня»; на других страницах список ждёт возвращения.
    onToday ? request(`/api/done?from=${todayGuess}&to=${todayGuess}`).catch(() => null) : Promise.resolve(undefined),
  ]);
  todayState.cache.clear();
  if (closed !== undefined && todayGuess === day.date) {
    todayState.done = (closed?.days || []).flatMap((group) => group.items).filter((item) => !item.auto);
    todayState.doneStale = false;
  } else todayState.doneStale = true;
  if (calendar !== undefined && todayGuess === day.date) {
    todayState.calendar = pruneRemovedExternal(calendar);
    todayState.calendarStale = false;
  } else todayState.calendarStale = true;
  render({ ...day, entries: entries.entries });
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
// Номер перехода: ответ на запрос, обогнанный другим переходом или закрытием,
// карточку уже не меняет.
let cardNavToken = 0;
let cardParamsOpen = false;
// Черновики обсуждения по записям: ушёл в подзадачу и вернулся — набранное
// на месте.
const cardDrafts = new Map();
// Вид раздела «Подзадачи» и свёрнутые ветки карты — на всё время сеанса.
let cardStepView = "list";
const cardCollapsed = new Set();
function resetCardFocus() {
  cardNavToken += 1;
  cardStack = [];
  cardEntryId = null;
  cardDrafts.clear();
  setCardParams(false, { instant: true });
}
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
  const finish = () => {
    if (dialog.open) dialog.close();
    dropCardTalk();
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
// ── общее в карточке записи ──
// Карточка устроена как страница в Ноушене, и общее встаёт в неё тем же
// порядком: круг и исполнитель — строками свойств, обсуждение — последним
// блоком после заметки. Разговор о деле идёт вокруг того, что о нём написано.
function assignRow(entry, { onChange }) {
  const wrap = node("div", undefined, "assign-row");
  const select = node("select", undefined, "prop-input assign-pick");
  select.setAttribute("aria-label", "Исполнитель");
  const people = new Map();
  for (const circle of entry.myCircles || []) for (const member of circle.members || []) if (member.id !== (currentUser?.id ?? null)) people.set(member.id, { ...member, circleId: circle.id });
  select.append(new Option("— никому", ""));
  for (const person of people.values()) select.append(new Option(person.name, person.id));
  select.value = entry.assignment && entry.assignment.state !== "declined" ? entry.assignment.assignee?.id || "" : "";
  const state = node("span", undefined, "assign-state");
  const paintState = () => {
    clear(state);
    if (!entry.assignment || entry.assignment.state === "declined") {
      if (entry.assignment?.state === "declined")
        state.append(node("span", `${entry.assignment.assignee?.name || "Не взяли"} ${assignmentWord(entry.assignment)}${entry.assignment.reason ? `: «${entry.assignment.reason}»` : ""}`, "assign-declined"));
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
      toast(assigneeId ? `Просьба ушла: ${people.get(assigneeId).name} ответит «беру» или «не я»` : "Исполнитель снят");
      onChange?.();
      await load();
    } catch (error) { toast(error.message || "Не получилось"); }
  });
  wrap.append(select, state);
  return wrap;
}
function circleRow(entry) {
  const wrap = node("div", undefined, "circle-value");
  const paint = () => {
    clear(wrap);
    const circles = entry.circles || [];
    if (!circles.length) { wrap.append(node("span", "только у вас", "prop-ghost")); return; }
    for (const circle of circles) wrap.append(circleChip(circle));
  };
  paint();
  return wrap;
}
// Позвать можно любого из ваших кругов, но не в пустоту: тому, кто записи или
// разговора ещё не видит, призыв их открывает — и об этом сказано до отправки.
const MENTION_GROUPS = { record: "в записи", room: "в разговоре", circle: "в круге", circles: "из ваших кругов", everyone: "все в Кизуне" };
// Кто и так на месте: этим призыв ничего не открывает, поэтому и приписки у них нет.
const MENTION_INSIDE = ["record", "room"];
function mentionPopup(field, callable, onPick, { lead = "", keys = false, note = "увидит запись" } = {}) {
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
    if (!items.some((person) => person.group)) pop.append(node("p", "призвать", "mention-cap"));
    items.forEach((person, index) => {
      if (person.group && person.group !== group) {
        group = person.group;
        pop.append(node("p", MENTION_GROUPS[group] || "призвать", "mention-cap"));
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
      hint.append(node("kbd", "↑"), " ", node("kbd", "↓"), " выбрать · ", node("kbd", "Enter"), " позвать · ", node("kbd", "Esc"), " закрыть");
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
const talkNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}` : names[0] || "");
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
  dock.setAttribute("aria-label", "Обсуждение");

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
  shut.title = "Свернуть · Esc";
  shut.setAttribute("aria-label", "Свернуть обсуждение");
  shut.append(talkIcon("down"));
  top.append(head, whoButton, shut);
  const list = node("div", undefined, "thread-list");
  panel.append(top, whoMenu, list);

  // Под панелью: свёрнутый разговор пузырём, вопрос о доступе и само поле.
  const base = node("div", undefined, "talk-base");
  const peek = node("button", undefined, "talk-peek");
  peek.type = "button";
  peek.title = "Развернуть обсуждение";
  peek.setAttribute("aria-controls", panel.id);
  const confirm = node("div", undefined, "talk-confirm");
  confirm.hidden = true;
  const composer = node("div", undefined, "thread-composer");
  const field = node("textarea", undefined, "thread-input");
  field.rows = 1;
  field.setAttribute("aria-label", "Сообщение в обсуждение");
  const at = node("button", undefined, "talk-at");
  at.type = "button";
  at.append(talkIcon("at"));
  at.title = "Позвать человека";
  at.setAttribute("aria-label", "Позвать человека");
  const send = node("button", undefined, "talk-send");
  send.type = "button";
  send.title = "Отправить · ⌘ + Enter";
  send.setAttribute("aria-label", "Отправить");
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
    if (!others.length) { whoButton.append(talkIcon("lock"), node("span", "видите только вы")); whoButton.disabled = true; whoMenu.hidden = true; return; }
    whoButton.disabled = false;
    const faces = node("span", undefined, "talk-faces");
    for (const person of others.slice(0, 4)) faces.append(avatarEl(person, { size: "mini" }));
    const names = others.map((person) => person.name);
    const words = names.length === 1 ? `вы и ${names[0]}` : names.length <= 3 ? `вы, ${talkNames(names)}` : `вы, ${names[0]} и ещё ${names.length - 1}`;
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
    if (author) row(author, "автор");
    for (const person of participants) {
      if (person.id === myId) continue;
      row(person, mine ? "убрать" : "позван", mine ? () => removePerson(person) : null);
    }
    const inRecord = new Set(participants.map((person) => person.id));
    for (const person of callable) if (person.group === "record" && !inRecord.has(person.id) && person.id !== author?.id) row(person, "из круга");
    if (!mine && participants.some((person) => person.id === myId)) {
      const leave = node("button", "Не следить — убрать запись у себя", "text-button talk-leave");
      leave.type = "button";
      leave.addEventListener("click", () => removePerson({ id: myId }, { self: true }));
      whoMenu.append(leave);
    }
    whoMenu.append(node("p", "Позвать ещё — напишите @имя в сообщении", "talk-people-hint"));
  };
  const removePerson = async (person, { self = false } = {}) => {
    try {
      const result = await request(`/api/captures/${entry.id}/people/${person.id}`, { method: "DELETE" });
      if (self) {
        toast("Запись убрана у вас: новый призыв вернёт её");
        closeCard();
        load();
        return;
      }
      participants = result.participants;
      entry.participants = participants;
      toast(`${person.name} больше не видит запись`);
      paint();
    } catch (error) { toast(error.message || "Не получилось"); }
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
      const name = node("b", last.author?.name || "Кто-то", "talk-peek-name");
      name.style.color = `var(--circle-${kcNameTone(last.author?.id)})`;
      text.append(name);
    }
    text.append(document.createTextNode(String(last.body).replace(/\s+/g, " ")));
    const time = node("span", kcClock(last.createdAt), "talk-peek-time");
    if (out && typeof last.read === "boolean") time.append(readMark(last.read));
    const bubble = node("span", undefined, "talk-peek-bubble");
    bubble.append(text, time);
    const label = unread ? `${unread} ${pluralRu(unread, "новое", "новых", "новых")}` : comments.length > 1 ? `ещё ${comments.length - 1}` : "";
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
      } catch (error) { toast(error.message || "Не получилось"); }
    });
    return chip;
  };
  const bubble = (comment, group) => {
    const wrap = node("div", undefined, "talk-bb-wrap");
    const box = node("div", undefined, "talk-bb");
    box.dataset.id = comment.id;
    if (!group.out && group.first) {
      const name = node("p", comment.author?.name || "Кто-то", "talk-name");
      if (author && comment.author?.id === author.id) name.append(node("i", "автор"));
      name.style.color = `var(--circle-${kcNameTone(comment.author?.id)})`;
      box.append(name);
    }
    if (comment.replyTo) {
      const quote = node("div", undefined, "talk-quote");
      const whose = comment.replyTo.author ? (comment.replyTo.author.id === myId ? "Вы" : comment.replyTo.author.name) : "Сообщение";
      quote.append(node("b", whose), node("span", comment.replyTo.removed ? "сообщение убрано" : comment.replyTo.body));
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
      const deed = node("button", "В дело", "talk-deed");
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
        joined.append(avatarEl(item.person, { size: "mini" }), node("span", `${item.person.id === myId ? "Вы" : item.person.name} — в обсуждении`));
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
    head.append(document.createTextNode("Обсуждение"), node("span", String(count), "talk-count"));
    paintWho();
    paintPeek();
    paintList();
    panel.hidden = !count;
    peek.hidden = !count;
    at.hidden = !callable.length;
    // Пока запись видите только вы, реплика — себе: об этом говорит поле, а не
    // отдельная метка с замком.
    const alone = !seers().length;
    field.placeholder = count ? "Сообщение" : callable.length ? `Написать${alone ? " себе" : ""} или позвать через @` : alone ? "Написать себе…" : "Написать…";
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
      node("b", `${talkNames(names)} пока не ${many ? "видят" : "видит"} эту запись`),
      node("p", `Отправите с призывом — ${many ? "они увидят" : "увидит"} заголовок, заметки, файлы и весь разговор, включая прошлые сообщения.`),
    );
    const acts = node("div", undefined, "talk-confirm-acts");
    const go = node("button", "Позвать и отправить", "talk-btn is-go");
    const quiet = node("button", "Без призыва", "talk-btn");
    const edit = node("button", "Изменить", "talk-btn is-bare");
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
      if (!response.ok) throw new Error(data?.error?.message || "Сообщение не ушло");
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
      if (data.comment.mentions.length) toast(`Позвали: ${talkNames(data.comment.mentions.map((person) => person.name))}`);
    } catch (error) { toast(error.message || "Сообщение не ушло"); }
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
  const pop = mentionPopup(field, callable, paintField, { lead: "Позванный увидит эту запись и разговор", keys: true });
  composer.append(field, at, send, pop);

  // Карточка перерисовывается после правки свойств — развёрнутый разговор
  // остаётся на месте, если это та же запись.
  const keep = isOpen() && dialog.dataset.talkFor === entry.id;
  dropCardTalk();
  dialog.dataset.talkFor = entry.id;
  (dialog.querySelector(".card-main") || dialog).append(dock);
  dialog.classList.add("has-talk");
  cardTalkBaseObserver = new ResizeObserver(() => dialog.style.setProperty("--talk-base", `${Math.ceil(base.offsetHeight)}px`));
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
    hint = node("p", "Markdown оформляется прямо в тексте · ⌘/Ctrl + Enter — сохранить · закроете карточку — сохранится само", "card-body-hint"),
    label = node("p", "Заметка", "prop-section");
  // Описание пишет разбор из текста записи и кладёт первой версией заметки. Нет
  // заметки — поле пустое, с подсказкой «Описание»: копия исходного текста тут
  // только дублировала бы то, что лежит в свёрнутом «Исходном тексте» ниже.
  let body = entry.note?.body ?? "";
  // Тело — то же живое поле, что и в карточке ввода: разметка оформляется
  // прямо в тексте, поэтому отдельный режим просмотра и предпросмотр больше
  // не нужны — читать и править можно в одном месте.
  const field = createMarkdownField({
    id: "card-body-editor",
    ariaLabel: "Описание",
    placeholder: "Описание",
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
        toast("Заметка сохранена");
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
const CARD_LIST_DONE = { "Сегодня": "На «Сегодня» всё отмечено", "Сделано": "В «Сделано» всё отмечено", "День": "В «Дне» всё отмечено", "Доска": "На «Доске» всё отмечено", "Календарь": "В календаре всё отмечено" };
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
    const parentTitle = entry?.parent?.title || frame.title || "Без названия";
    const back = node("button", undefined, "card-return");
    back.type = "button";
    back.title = cardStack.map((item) => item.title).filter(Boolean).join(" / ") || parentTitle;
    back.setAttribute("aria-label", `Назад к задаче «${parentTitle}»`);
    back.append(node("span", "←", "card-return-arrow"), node("span", parentTitle, "card-return-label"));
    back.addEventListener("click", () => goBackCard());
    crumb.append(back, node("span", `Уровень ${cardStack.length + 1}`, "card-depth"));
    close.title = `Вернуться к «${parentTitle}»`;
    close.setAttribute("aria-label", "Закрыть подзадачу и вернуться к родительской");
    return;
  }
  close.title = "";
  close.setAttribute("aria-label", "Закрыть карточку");
  const column = node("b", cardMenu.columnName, "card-nav-col");
  column.hidden = !cardMenu.columnName;
  if (!cardList) {
    if (entry) {
      const date = entry.interpretation?.classification?.entities?.schedule?.date;
      const day = date === (currentDayDate || zoneDate(new Date())) ? "Сегодня" : date ? scheduleLabel({ state: "ok", date }) : "Задача";
      crumb.append(node("i", undefined, "card-crumb-dot"), column, node("span", day, "card-crumb-word"));
    }
    return;
  }
  const nav = node("span", undefined, "card-nav");
  const label = node("span", undefined, "card-nav-crumb");
  label.append(node("b", cardList.label), document.createTextNode(finished ? " · всё отмечено" : ` · ${cardList.index + 1} из ${cardList.items.length}`));
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
  slot.append(step(-1, "Предыдущее · K", TALK_ICONS.up), step(1, "Следующее · J", TALK_ICONS.down));
}
// Панель «Параметры» выезжает справа из той же карточки: ширина карточки
// растёт, колонка содержимого остаётся прежней, и всё вместе снова встаёт по
// центру. Закрытая панель не принимает фокус (inert) — Tab её не находит.
function setCardParams(open, { instant = false, focus = null } = {}) {
  const dialog = $("#review-dialog"), panel = $("#review-params"), toggle = $("#review-params-toggle");
  cardParamsOpen = Boolean(open);
  dialog.classList.toggle("params-instant", instant || !motionAllowed());
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
  catch (error) { if (token === cardNavToken) cardSnack(error.message || "Запись не открылась"); return null; }
  if (token !== cardNavToken || !$("#review-dialog").open) return null;
  closeCardSlashMenu?.();
  dropCardTalk();
  cardOccurrence = null;
  adjustStack();
  const review = reviewFromEntry(entry);
  showCorrection(entry, review.level === "high" ? undefined : review);
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
      try { await run(); } catch (error) { cardSnack(error.message || "Не получилось"); }
    });
    snack.append(button);
  }
  dialog.append(snack);
  cardSnackTimer = setTimeout(() => snack.remove(), actions.length ? 6000 : 3000);
}
function dropCardFlow() {
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
  catch (error) { cardSnack(error.message || "Запись не открылась"); return; }
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
  showCorrection(entry, review.level === "high" ? undefined : review);
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
  const close = node("button", "Закрыть", "card-finish-close");
  close.type = "button";
  close.addEventListener("click", () => closeCard());
  box.append(mark, node("h2", CARD_LIST_DONE[cardList?.label] || "Всё отмечено", "card-finish-title"), node("p", "Открытых дел и встреч в этом списке не осталось.", "card-finish-sub"), close);
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
  if (state.occurrenceDone) return state.occurrence === state.today ? "Готово на сегодня" : `Готово на ${scheduleLabel({ state: "ok", date: state.occurrence, time: null })}`;
  const verb = state.meeting ? "Прошла" : "Сделано";
  if (!state.completedAt) return verb;
  const day = notifyDay(state.completedAt);
  const when = day === state.today ? "сегодня" : day === shiftDate(state.today, -1) ? "вчера" : `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return `${verb} ${when} в ${notifyClock(state.completedAt)}`;
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
  catch (error) { cardSnack(error.message || "Запись не открылась"); return null; }
  if (!$("#review-dialog").open) return null;
  flushCard();
  closeCardSlashMenu?.();
  const review = reviewFromEntry(entry);
  showCorrection(entry, review.level === "high" ? undefined : review);
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
    cardSnack(error.message || "Не получилось");
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
  const actions = [{ label: "Вернуть", run: async () => {
    await setCardDone(entry, state, false);
    await load().catch(() => {});
    refreshOtherViews();
    if (cardList) await openCardFromList(from);
  } }];
  cardAdvance = setTimeout(() => advanceCardFrom(from, { text: `Готово: «${shortTitle(titleOf(entry), 34)}»`, actions }), 700);
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
    if (next) line.append(dot(), node("span", `следующий раз ${scheduleLabel({ state: "ok", date: next, time: state.schedule.time || null })}`, "card-done-note"));
  }
  if (state.taken && state.assignment?.assigner?.name) line.append(dot(), node("span", `${state.assignment.assigner.name} видит «сделано»`, "card-done-note"));
  line.append(dot(), link("Вернуть", () => cardKeys.toggle?.()));
  if (state.occurrenceDone && state.own)
    line.append(dot(), link("Закрыть всю серию", async () => {
      try {
        for (const projection of state.projections) await request(`/api/projections/${projection.id}/complete`, { method: "POST", body: "{}" });
        cardOccurrence = null;
        await load().catch(() => {});
        refreshOtherViews();
        await rerenderCard(entry.id);
        cardSnack("Серия закрыта целиком");
      } catch (error) { cardSnack(error.message || "Не получилось"); }
    }));
  block.append(line);
  return block;
}
function cardTickButton(entry, state) {
  const label = state.done ? "Вернуть в работу · E" : state.occurrence ? "Готово на этот день · E" : state.meeting ? "Прошла · E" : "Готово · E";
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
  nav.setAttribute("aria-label", "Путь к задаче");
  const step = (item, container = nav) => {
    const button = node("button", item.title || "Без названия", "card-path-step");
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
    summary.setAttribute("aria-label", "Показать промежуточные задачи");
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
const stepsWord = (count) => (count % 10 === 1 && count % 100 !== 11 ? "шага" : "шагов");
// Раздел «Подзадачи»: настоящие дочерние дела на любой глубине. «Список» —
// прямые дети, «Карта» — всё дерево с раскрывающимися ветками; оба живут на
// одних данных. Дуга вокруг кружка и подпись под названием считают только
// конечные шаги: ветка с детьми — не единица, итоги и заметки — не шаги.
function cardSubtasks(entry, { halo, caption }) {
  const own = entry.mine !== false;
  const section = node("section", undefined, "card-subtasks");
  section.id = "card-subtasks";
  section.hidden = true;
  const subhead = node("div", undefined, "subhead");
  const lead = node("div", undefined, "subhead-lead");
  const count = node("span", undefined, "subtask-count");
  count.setAttribute("aria-live", "polite");
  count.title = "Выполнено конечных шагов на всех уровнях";
  lead.append(node("b", "Подзадачи"), count);
  const actions = node("div", undefined, "subtask-actions");
  const views = node("div", undefined, "steps-view");
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", "Вид подзадач");
  const viewButton = (view, label) => {
    const button = node("button", label, "steps-view-button");
    button.type = "button";
    button.dataset.stepView = view;
    button.addEventListener("click", () => { cardStepView = view; paint(); });
    return button;
  };
  views.append(viewButton("list", "Список"), viewButton("map", "Карта"));
  const add = node("button", "＋ Подзадача", "subtask-add");
  add.type = "button";
  add.hidden = !own;
  actions.append(views, add);
  subhead.append(lead, actions);
  const list = node("div", undefined, "subtasks");
  list.id = "card-subtask-list";
  const map = node("div", undefined, "metric-tree");
  map.id = "card-subtask-map";
  map.setAttribute("aria-label", "Карта подзадач");
  const composer = node("form", undefined, "subtask-composer");
  composer.hidden = true;
  const input = node("input");
  input.setAttribute("aria-label", "Название новой подзадачи");
  input.placeholder = "Что нужно сделать?";
  input.autocomplete = "off";
  input.maxLength = 500;
  const submit = node("button", "Добавить", "subtask-submit");
  submit.type = "submit";
  const cancel = node("button", "×", "subtask-cancel");
  cancel.type = "button";
  cancel.setAttribute("aria-label", "Отменить добавление");
  composer.append(input, submit, cancel);
  const next = node("div", undefined, "task-next");
  const nextLabel = node("span", "Дальше", "next-label");
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
    } catch (error) { cardSnack(error.message || "Не получилось"); }
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
    if (!item.canComplete) box.title = "Отметить может автор или тот, кто взял дело";
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
    button.setAttribute("aria-label", `Открыть подзадачу «${item.title}»`);
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
        meta.title = "Выполнено конечных шагов";
        open.append(meta);
      }
      const arrow = node("span", "›", "subtask-arrow");
      arrow.setAttribute("aria-hidden", "true");
      open.append(arrow);
      row.append(check(item, "subtask-check", "Выполнить"), open);
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
        fold.setAttribute("aria-label", `${expanded ? "Свернуть" : "Раскрыть"} «${item.title}»`);
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
      if (branch) {
        status = node("span", undefined, "branch-dial");
        status.style.setProperty("--branch-progress", `${(item.leafDone / item.leafTotal) * 100}%`);
        status.title = `${item.leafDone} из ${item.leafTotal} ${stepsWord(item.leafTotal)}`;
        status.setAttribute("role", "img");
        status.setAttribute("aria-label", status.title);
      } else status = check(item, "tree-check", "Выполнить шаг");
      const open = openButton(item, "tree-open");
      const title = node("span", item.title, "tree-title");
      if (item.done && !branch) title.classList.add("done");
      open.append(title);
      if (branch) open.append(node("small", `${item.leafDone} / ${item.leafTotal}`));
      row.append(fold, status, open);
      map.append(row);
      if (expanded) for (let index = item.children.length - 1; index >= 0; index--) stack.push({ item: item.children[index], depth: depth + 1 });
    }
  };
  const paint = () => {
    const hasChildren = Boolean(tree?.children.length);
    section.hidden = !tree || (!own && !hasChildren);
    halo.classList.toggle("has-progress", hasChildren);
    const fill = halo.querySelector(".halo-fill");
    if (fill) fill.style.strokeDashoffset = hasChildren ? String(100 - (tree.done / tree.total) * 100) : "100";
    caption.hidden = !hasChildren;
    if (hasChildren) {
      caption.textContent = `${tree.done} из ${tree.total} ${stepsWord(tree.total)} · посмотреть карту ↘`;
      caption.setAttribute("aria-label", `Выполнено ${tree.done} из ${tree.total} ${stepsWord(tree.total)}. Показать карту`);
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
      list.append(node("p", "Разбейте задачу на небольшие шаги", "subtask-empty"));
    } else if (showMap) paintMap();
    else paintList();
    const remaining = tree.total - tree.done;
    next.hidden = !hasChildren;
    nextLabel.textContent = tree.next ? "Дальше" : "Все шаги выполнены";
    nextLink.hidden = !tree.next;
    nextLink.textContent = tree.next ? `${tree.next.title} ↗` : "";
    nextLink.title = tree.next ? `Открыть «${tree.next.title}»` : "";
    nextLink.onclick = tree.next ? () => openSubtaskCard(tree.next.id, tree.nodes.find((item) => item.id === tree.next.id)?.occurrence || null) : null;
    next.classList.toggle("all-done", hasChildren && !remaining);
  };
  caption.addEventListener("click", () => {
    cardStepView = "map";
    paint();
    section.scrollIntoView({ block: "start", behavior: motionAllowed() ? "smooth" : "instant" });
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
    } catch (error) { cardSnack(error.message || "Подзадача не добавилась"); }
    finally { submit.disabled = false; }
  });
  refresh();
  return section;
}
function showReview(entry, review, undoGroupId, provenance) {
  const area = $("#review"),
    dialog = $("#review-dialog"),
    c = entry.interpretation.classification;
  clear(area);
  if (review.level === "high") {
    closeCard();
    return;
  }
  // Список, из которого открыли карточку, едет с ней; кружок — у своего дела,
  // встречи и взятого у человека дела. Подзадача список не трогает: он
  // остаётся у корня и ждёт возвращения.
  if (!cardStack.length) adoptCardList(entry, !dialog.open);
  cardEntryId = entry.id;
  const doneState = cardDoneState(entry);
  const hasTick = cardHasTick(entry, doneState);
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
    let inflight = null;
    const cancel = () => { settled = true; flushCardTitle = null; editor.replaceWith(cardTitle); };
    const save = () => {
      if (inflight) return inflight;
      if (settled) return Promise.resolve();
      settled = true;
      flushCardTitle = null;
      const value = editor.value.trim();
      if (!value || value === c.summary) { editor.replaceWith(cardTitle); return Promise.resolve(); }
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
          toast("Заголовок обновлён");
          load();
          if (token !== cardNavToken || cardEntryId !== entry.id || !$("#review-dialog").open || !editor.isConnected) return;
          const review = reviewFromEntry(result.entry);
          showCorrection(result.entry, review.level === "high" ? undefined : review);
        } catch (error) {
          toast(error.message);
          if (editor.isConnected) editor.replaceWith(cardTitle);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    };
    // Переход к подзадаче и закрытие карточки дожидаются этого сохранения.
    flushCardTitle = () => save();
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
    if (entry.parent) origin.append(document.createTextNode(outcomeOfDeed ? "Итог дела " : stepOfDeed ? "Подзадача дела " : "Отделено от записи "), link(entry.parent.id, `«${entry.parent.title}»`));
    else {
      origin.append(document.createTextNode(`Из этой записи ${plural(deedParts.length, DEALS)}: `));
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
    const asPage = node("a", "Открыть как страницу", "card-page-link");
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
  type.setAttribute("aria-label", "Тип записи");
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
  // Повтор — тоже свойство срока: правило и, если нужно, последний день.
  // Без даты повторять нечего — выбор закрыт.
  const repeat = node("select", undefined, "review-repeat");
  repeat.id = "review-repeat";
  repeat.setAttribute("aria-label", "Повтор");
  const storedRepeat = c.entities.schedule?.repeat || null;
  const repeatKey = (rule) => (rule ? `${rule.freq}:${rule.interval || 1}` : "");
  const repeatOptions = [["", "не повторять"], ["daily:1", "каждый день"], ["weekly:1", "каждую неделю"], ["weekly:2", "каждые 2 недели"], ["monthly:1", "каждый месяц"], ["yearly:1", "каждый год"]];
  if (storedRepeat && !repeatOptions.some(([value]) => value === repeatKey(storedRepeat))) repeatOptions.push([repeatKey(storedRepeat), repeatLabel(storedRepeat, { until: false })]);
  for (const [value, label] of repeatOptions) { const option = node("option", label); option.value = value; option.selected = value === repeatKey(storedRepeat); repeat.append(option); }
  const until = node("input");
  until.type = "date"; until.id = "review-repeat-until"; until.value = storedRepeat?.until || ""; until.title = "Последний день повтора"; until.setAttribute("aria-label", "Повторять до");
  const untilWrap = node("span", undefined, "review-until");
  untilWrap.append(node("span", "до", "review-end-label"), until);
  const paintRepeat = () => { repeat.disabled = !date.value; if (!date.value) repeat.value = ""; untilWrap.hidden = !repeat.value; if (!repeat.value) until.value = ""; };
  repeat.addEventListener("change", paintRepeat);
  date.addEventListener("input", paintRepeat);
  paintRepeat();
  const repeatRow = node("span", undefined, "review-repeat-row");
  repeatRow.append(node("span", "повторять", "review-end-label"), repeat, untilWrap);
  // Напоминание — тоже подписанная строка панели.
  const remindWrap = node("span", undefined, "review-remind-row");
  remindWrap.append(node("span", "напомнить", "review-end-label"), remind);
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
  // нечем: заметка, принятая за отчёт, навсегда оставалась в «Сделано».
  let done = Boolean(c.completed);
  doneToggle.id = "review-completed";
  doneToggle.type = "button";
  const paintDone = () => {
    doneToggle.setAttribute("aria-pressed", String(done));
    doneToggle.title = done ? "Отметить как незавершённое" : "Отметить как сделанное";
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
  startWrap.append(node("span", "начало", "review-end-label"), time);
  const endWrap = node("span", undefined, "review-end");
  endWrap.append(node("span", "до", "review-end-label"), end);
  scheduleRow.append(date, startWrap, endWrap, remindWrap, repeatRow);
  // Сброс уходит на сервер сразу: «без даты» — это решение, а не правка на
  // полпути, и ждать закрытия карточки ему незачем.
  let saveProps = () => {};
  const clearAndSave = (apply) => { apply(); saveProps(); };
  const scheduleWrap = propertyRow("Срок", scheduleRow, "schedule", { clear: () => clearAndSave(() => { date.value = ""; time.value = ""; end.value = ""; remindChoice = ""; repeat.value = ""; until.value = ""; paintEnd(); paintRemind(); paintRepeat(); }), filled: () => Boolean(date.value || time.value) }),
    peopleWrap = propertyRow("Участники", people, "people", { clear: () => clearAndSave(() => { people.value = ""; }), filled: () => Boolean(people.value.trim()) }),
    followUpWrap = propertyRow("Далее", followUp, "next", { clear: () => clearAndSave(() => { followUp.value = ""; }), filled: () => Boolean(followUp.value.trim()) });
  const props = node("div", undefined, "props");
  const columnSelect = node("select", undefined, "side-column");
  columnSelect.id = "review-column";
  columnSelect.setAttribute("aria-label", "Колонка");
  const columnRow = propertyRow("Колонка", columnSelect, "project");
  columnRow.hidden = true;
  // Круг и исполнитель — свойства записи, а не отдельная форма: дело уходит
  // человеку фразой, а здесь его правят, когда разбор не угадал.
  const hasCircles = (entry.myCircles || []).some((circle) => (circle.members || []).length > 1);
  const circleWrap = propertyRow("Круг", circleRow(entry), "project"),
    assignWrap = entry.mine === false ? null : propertyRow("Исполнитель", assignRow(entry, { onChange: () => {} }), "people");
  props.append(
    columnRow,
    scheduleWrap,
    propertyRow("Проект", project, "project", { clear: () => clearAndSave(() => { project.value = ""; }), filled: () => Boolean(project.value.trim()) }),
    ...(entry.circles?.length ? [circleWrap] : []),
    ...(assignWrap && (hasCircles || entry.assignment) ? [assignWrap] : []),
    peopleWrap,
    followUpWrap,
    // У дела и встречи «сделано» — кружок у названия; строка остаётся у заметки,
    // идеи и результата, где она делает запись итогом.
    ...(["task", "meeting_event"].includes(c.primaryType) ? [] : [propertyRow("Сделано", doneToggle, "done")]),
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
      chips.append(chip("schedule", due ? `${due}${time.value && end.value ? `–${end.value}` : ""}` : "Назначить день", { quiet: !due, target: date, label: "Срок" }));
      if (date.value) {
        const remindText = remind.value === "off" ? "Без напоминания" : remind.value ? `Напомнить ${remind.selectedOptions[0]?.textContent || ""}` : "Напомнить";
        chips.append(chip("bell", remindText, { quiet: !remind.value, target: remind, label: "Напомнить" }));
      }
      if (repeat.value) chips.append(chip("repeat", `${repeat.selectedOptions[0]?.textContent || "повтор"}${until.value ? ` до ${until.value.slice(8, 10)}.${until.value.slice(5, 7)}` : ""}`, { target: repeat, label: "Повтор" }));
    }
    if (!peopleWrap.hidden) {
      const who = people.value.trim() || doneState.assignment?.assignee?.name || "";
      chips.append(chip("people", who || "Человек", { quiet: !who, target: people, label: "Участники" }));
    }
    if (project.value.trim()) chips.append(chip("project", project.value.trim(), { target: project, label: "Проект" }));
    if (!followUpWrap.hidden && followUp.value.trim()) chips.append(chip("next", `далее: ${followUp.value.trim()}`, { target: followUp, label: "Далее" }));
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
        propsInflight = null;
      }
    })();
    return propsInflight;
  };
  flushCardProps = saveProps;
  // Enter в поле свойства раньше отправлял форму; отправлять больше нечего.
  form.addEventListener("submit", (event) => event.preventDefault());
  area.append(cardBody(entry));
  if (wantsSubtasks) area.append(cardSubtasks(entry, { halo, caption }));
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
    const stamp = node("p", moved ? `Было: ${written} · записано ${entryClock({ createdAt: entry.createdAt })}` : `Записано: ${written}`, "card-written card-footer-line");
    stamp.prepend(propIcon("written"));
    footerRow.append(stamp);
  }
  footer.append(footerRow);
  area.append(footer);

  const source = node("details", undefined, "card-source");
  const sourceSummary = node("summary", "Источник и версия");
  sourceSummary.prepend(propIcon("source"));
  sourceSummary.append(propIcon("chevron"));
  source.append(sourceSummary);
  // Пока заметку не правили, её тело — копия исходной записи, и показывать
  // один и тот же текст дважды незачем: остаётся только строка версии.
  const sourceText = entry.parent?.splitSource ? entry.parent.raw : entry.raw;
  const noteBody = entry.note?.body ?? (entry.raw || "");
  const sameAsRaw = noteBody.trim() === (sourceText || "").trim();
  const raw = node("div", undefined, "review-raw");
  if (sameAsRaw) raw.append(node("p", "Исходная запись совпадает с заметками.", "entry-meta"));
  else raw.append(node("p", "Исходная запись:", "source-label"), markdownNode("div", sourceText, undefined));
  const provider = provenance?.usedProvider || entry.interpretation.provider;
  // Источник раскрывается листом над строкой подвала и не распирает её.
  const sourceBody = node("div", undefined, "card-source-body");
  sourceBody.append(
    raw,
    node("p", cardFromWords(entry), "entry-meta"),
    node(
      "p",
      `Версия ${entry.interpretation.version} · ${providerNames[provider] || "исправлено вами"}${fallbackSuffix(provenance)}`,
      "entry-meta",
    ),
  );
  source.append(sourceBody);
  footerRow.append(source);

  // Удаление живёт внизу карточки, отдельно от правок: это не «ещё одно
  // уточнение», а выход из журнала.
  const remove = node("button", "Удалить запись", "card-delete");
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
  };
  // Серия, открытая из календаря или «Дня» на конкретный день: удалить можно
  // только этот повтор (он убирается из серии) или всю запись — выбор на
  // месте кнопки.
  const occurrence = c.entities.schedule?.repeat && cardOccurrence && scheduledOn(entry, cardOccurrence) ? cardOccurrence : null;
  remove.addEventListener("click", () => {
    if (!occurrence) { deleteRecord(); return; }
    const ask = node("div", undefined, "card-delete-ask");
    ask.append(node("span", `Запись повторяется. Убрать только ${calHuman(occurrence)} или удалить всю серию?`));
    const only = node("button", "Только этот повтор", "danger"), all = node("button", "Всю серию", "danger"), cancel = node("button", "Отмена");
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
    const line = node("p", `${author ? `Автор записи — ${author}. ` : ""}${called ? "Вас позвали в обсуждение: запись видна вам, правит её автор." : "Правит её автор: что нужно поменять — скажите в обсуждении."}`, "card-foreign");
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
function cardFromWords(entry) {
  const from = { telegram: "Telegram", telegram_forward: "Telegram, пересланное", notes: "Заметки" }[entry.origin] || "Поле записи";
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
    const data = await request("/api/board");
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
    columnSelect.append(new Option("Сделано", ""));
    columnSelect.disabled = true;
    cardMenu.columnName = "Сделано";
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
        await request("/api/board/move", { method: "POST", body: JSON.stringify({ captureId: entry.id, columnId: columnSelect.value, index: 100000 }) });
        cardMenu.columnName = target?.name || "";
        paintCardCrumb();
        toast(`Дело в колонке «${target?.name || ""}»`);
        if (boardState.data) request("/api/board").then((data) => { boardState.data = data; if (!$("#board")?.hidden) { boardState.stamp = JSON.stringify(data); renderBoard(data); } }).catch(() => {});
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
  if (job.parts?.length) {
    // Дела, отделённые от записи, показываются сразу: подтверждения заранее
    // приложение не спрашивает нигде, но даёт отменить сделанное.
    const parts = node("p", undefined, "progress-raw progress-parts");
    parts.append(document.createTextNode(`Отделил ${plural(job.parts.length, DEALS)}: ${job.parts.map((part) => `«${part.title}»`).join(", ")}`));
    card.append(parts);
  }
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
  if (job.parts?.length) {
    const drop = node("button", job.parts.length === 1 ? "Убрать дело" : "Убрать дела", "text-button");
    drop.type = "button";
    drop.addEventListener("click", async () => {
      drop.disabled = true;
      const removed = job.parts;
      try {
        for (const part of removed) await request(`/api/captures/${part.id}`, { method: "DELETE" });
        job.parts = [];
        renderCaptureProgress(job, record);
        await load();
        toast(`${plural(removed.length, DEALS)} убрано из журнала`, { label: "Вернуть", run: async () => {
          try { for (const part of removed) await request(`/api/captures/${part.id}/restore`, { method: "POST" }); await load(); toast("Вернул"); }
          catch (error) { toast(error.message); }
        } });
      } catch (error) { toast(error.message); drop.disabled = false; }
    });
    actions.append(drop);
  }
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
// «Легло: «Отправить смету» · сегодня» — единственный ответ на запись: что
// получилось и на какой день. Правится название в карточке, вернуть не нужно.
function layToast(record, job) {
  const entry = todayState.entries.find((candidate) => candidate.id === (record.captureId || job.captureId));
  const classification = entry?.interpretation.classification;
  const parts = job.parts || [];
  const clip = (text) => `«${String(text || "").slice(0, 60)}»`;
  // «Сделал X, надо Y»: отчёт закрыт, дела из него — на сегодня; считаем раздельно.
  if (classification?.completed === true && parts.length) return `Легло: 1 сделано, ${parts.length} на сегодня — ${parts.map((part) => clip(part.title)).join(", ")}`;
  // Пачка дел: родитель не туду, в списках только отделившиеся дела.
  if (parts.length) return `Легло: ${plural(parts.length, ["туду", "туду", "туду"])} · ${scheduleLabel(classification?.entities.schedule) || "сегодня"} — ${parts.map((part) => clip(part.title)).join(", ")}`;
  const when = classification?.completed === true ? "сделано" : scheduleLabel(classification?.entities.schedule) || "сегодня";
  const title = (classification?.summary || record.raw || "").split("\n")[0].slice(0, 80);
  return !title ? `Легло: 1 туду · ${when}` : `Легло: «${title}» · ${when}`;
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
        toast(layToast(record, job));
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
// ── Поле записи ──────────────────────────────────────────────────────────────
// Одно поле и одна кнопка. Тип, срок, важность и теги здесь не выбираются:
// сервер сам делает из текста дело на сегодня (или на названную дату), а
// поправить можно в карточке. Markdown оформляется прямо в поле, по мере набора;
// Enter отправляет, Shift+Enter переносит строку. Поле растёт вместе с текстом.
const captureField = createMarkdownField({
  id: "capture-input",
  ariaLabel: "Новая запись",
  placeholder: "Что нужно сделать?",
  submitOnEnter: false,
  onSubmit: () => $("#capture-form").requestSubmit(),
});
$("#capture-form").prepend(captureField.element);
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
$("#capture-hint").textContent = `${CAPTURE_MOD}+Enter — отправить, Enter — новая строка`;
$("#capture-submit").title = `Сохранить запись — ${CAPTURE_MOD}+Enter`;

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
  const label = large ? "Свернуть поле — Esc" : "Увеличить поле";
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
    const value = Number(localStorage.getItem(spec.key));
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
  if (width) page.style.setProperty("--capture-width", `${width}px`);
  else page.style.removeProperty("--capture-width");
}
paintCaptureSize();
for (const grip of document.querySelectorAll("#capture-form .capture-resize")) {
  const dir = grip.dataset.dir;
  grip.addEventListener("dblclick", () => {
    try {
      if (/[ew]/.test(dir)) localStorage.removeItem(CAPTURE_WIDTH.key);
      if (dir.includes("s")) localStorage.removeItem(CAPTURE_HEIGHT.key);
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
        if (sx) localStorage.setItem(CAPTURE_WIDTH.key, String(Math.round(width)));
        if (sy) localStorage.setItem(CAPTURE_HEIGHT.key, String(Math.round(height)));
      } catch {}
      paintCaptureSize();
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
        body: JSON.stringify(withProvider({ raw })),
      });
    if (result.response.status !== 202 || !safeCaptureEnvelope(result.data))
      throw new Error("Сервер не подтвердил асинхронное сохранение.");
    captureField.clear();
    if (captureLarge()) setCaptureLarge(false);
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
      await Promise.all([status(), load(), loadSettings(), loadNotifications()]);
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
  "telegramBotToken",
  "aiProvider",
  "timeZone",
  "remindDefault",
  "remindHour",
  "quietHours",
  "theme",
  "modelTemperature",
  "modelMaxTokens",
  "modelReasoning",
  "monthlyLimitUsd",
];
const SECRET_FIELDS = ["openaiKey", "geminiKey", "openrouterKey", "googleClientSecret", "telegramBotToken"];
let appSettings = {};
function settingInput(name) {
  return document.getElementById(`setting-${name}`);
}
function paintSettings(payload) {
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
  paintNotifySettings();
  paintSpend(payload.spend);
}
// Расходы: сколько ушло токенов и денег. Показываем три окна — сутки, неделя,
// всё время, — потому что «сколько я трачу» это вопрос про темп, а не про сумму.
const usageKinds = { classify: "разбор", answer: "память" };
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
// ── память помощника ────────────────────────────────────────────────────────
// Память правит разбор молча, поэтому её показывают целиком: видно, откуда
// правило взялось, и любое можно стереть. Без этого «помощник что-то запомнил»
// было бы страшнее, чем полезно.
const MEMORY_SOURCES = { correction: "из поправки", voice: "сказано голосом", manual: "записано руками", import: "перенесено" };
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
  const wrap = $("#memory-list");
  clear(wrap);
  const sharedRow = $("#memory-shared-row");
  if (sharedRow) sharedRow.hidden = !canShare;
  if (!memories.length) {
    wrap.append(node("p", "Пока ничего: помощник запомнит первое же, что вы поправите или попросите запомнить.", "setting-hint"));
    return;
  }
  for (const memory of memories) {
    const row = node("div", undefined, `memory-item${memory.scope === "shared" ? " is-shared" : ""}`);
    row.append(node("span", memory.body, "memory-body"));
    const marks = [memory.scope === "shared" ? "общее" : null, MEMORY_SOURCES[memory.source] || memory.source].filter(Boolean);
    row.append(node("span", marks.join(" · "), "memory-meta"));
    const forget = calButton("Забыть", "secondary memory-forget", async () => {
      forget.disabled = true;
      try {
        paintMemory(await request(`/api/agent/memory/${memory.id}`, { method: "DELETE" }));
        toast("Забыл");
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
  const shared = Boolean($("#memory-shared")?.checked);
  try {
    paintMemory(await request("/api/agent/memory", { method: "POST", body: JSON.stringify({ text, scope: shared ? "shared" : "user" }) }));
    input.value = "";
    toast(shared ? "Запомнил для всех" : "Запомнил");
  } catch (error) { toast(error.message); }
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
$("#review-close").addEventListener("click", requestCardClose);
$("#review-params-toggle").addEventListener("click", () => setCardParams(!cardParamsOpen));
$("#review-params-close").addEventListener("click", () => setCardParams(false));
// Escape и клик по подложке закрывают карточку; что менялось — сохраняется.
$("#review-dialog").addEventListener("close", () => {
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
});
// Esc идёт по слоям: сначала закрывает панель «Параметры», потом сворачивает
// разговор, у подзадачи возвращает к родителю — и только у корня закрывает
// карточку.
$("#review-dialog").addEventListener("cancel", (event) => {
  const dialog = $("#review-dialog");
  if (cardParamsOpen) { event.preventDefault(); setCardParams(false); return; }
  if (dialog.classList.contains("talk-open")) { event.preventDefault(); dialog.querySelector(".talk-close")?.click(); return; }
  if (cardStack.length) { event.preventDefault(); goBackCard(); }
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
const cardSizeStorageKey = "pagent.focus-card-size";
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
    // Ширина — у колонки содержимого: открытая панель «Параметры» в неё не входит.
    const box = dialog.getBoundingClientRect(), main = dialog.querySelector(".card-main")?.getBoundingClientRect();
    const start = { width: main ? main.width : box.width, height: box.height };
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
window.visualViewport?.addEventListener("resize", syncCardViewport);
window.visualViewport?.addEventListener("scroll", syncCardViewport);
CARD_PHONE.addEventListener("change", syncCardViewport);
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
  // В Telegram нажали «Запустить» по ссылке из настроек — привязка готова.
  journalStream.addEventListener("telegram", () => loadTelegram({ announce: true }));
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
// «Кто мы» грузится параллельно со страницей: карточка, открытая по ссылке,
// ждёт этого, чтобы отличить свои реплики от чужих.
let resolveAccountKnown = () => {};
const accountKnown = new Promise((resolve) => { resolveAccountKnown = resolve; });

const roleNames = { admin: "администратор", user: "пользователь" };

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
  const line = $("#account-summary-line");
  if (line)
    line.textContent = `${currentUser.email} · ${roleNames[currentUser.role]} · вход защищён ${currentUser.twoFactorEnabled ? "паролем и вторым фактором" : "только паролем"}`;
  const nameInput = $("#setting-name");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = currentUser.name || "";
  paintAvatarPicker();
  paintTotp();
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
  choice("Буква имени", avatarEl({ ...currentUser, avatar: null }), !currentUser.avatar, () => chooseAvatar(null));
  for (const preset of avatarPresets)
    choice(preset.label, avatarEl({ name: preset.label, avatar: preset.url }), currentUser.avatar === preset.url, () => chooseAvatar(preset.id));
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
    await avatarSaved(result, presetId ? "Аватар выбран" : "Снова буква имени");
  } catch (error) { toast(error.message || "Аватар не сохранился"); }
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
    if (!response.ok) throw new Error(result.error?.message || "Картинка не загрузилась");
    await avatarSaved(result, "Картинка поставлена");
  } catch (error) {
    toast(error instanceof DOMException ? "Это не похоже на картинку" : error.message || "Картинка не загрузилась");
  }
});
// Имя сохраняется само, когда поле отпустили: отдельной кнопки «Сохранить» в
// настройках нет ни у чего.
$("#setting-name")?.addEventListener("change", async (event) => {
  try {
    const result = await request("/api/account", { method: "PATCH", body: JSON.stringify({ name: event.target.value }) });
    if (currentUser) currentUser.name = result.me.name;
    toast(`Вас будут звать «${result.me.name}»`);
    await load();
  } catch (error) { toast(error.message || "Имя не сохранилось"); }
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
// Человек живёт в приложении или уже нет: две недели тишины — тот же порог,
// по которому «Обзор» считает проект заглохшим.
const SLEEPING_AFTER_DAYS = 14;
const DAYS_WORDS = ["день", "дня", "дней"];
function daysBetween(iso) { return iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null; }
function agoWords(iso) {
  const days = daysBetween(iso);
  if (days === null) return null;
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${plural(days, DAYS_WORDS)} назад`;
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
    bar.title = `${dates?.[index] || ""}: ${plural(count, ["запись", "записи", "записей"])}`;
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
  facts.push(last ? `последняя запись ${last}` : "записей нет");
  facts.push(`за 30 дней ${plural(activity.capturesPeriod, ["запись", "записи", "записей"])}`);
  facts.push(`за неделю ${activity.capturesWeek}`);
  if (activity.completedPeriod) facts.push(`закрыто ${plural(activity.completedPeriod, DEALS)}`);
  facts.push(activity.calendars ? `календарь ${activity.calendars}` : "без календаря");
  facts.push(activity.pushDevices ? `уведомления ${activity.pushDevices}` : "без уведомлений");
  wrap.append(node("p", facts.join(" · "), "admin-user-facts admin-user-activity"));
  return wrap;
}
// Метка состояния рядом со статусом: кто ни разу ничего не записал и кто
// замолчал. Живого человека метить нечем — молчание и есть новость.
function activityTag(user) {
  const activity = user.activity;
  if (!activity || user.status !== "active") return null;
  const silence = [activity.lastCaptureAt, user.lastLoginAt].map(daysBetween).filter((days) => days !== null);
  if (!activity.lastCaptureAt) return node("span", "ни одной записи", "admin-tag admin-state-new");
  const quiet = silence.length ? Math.min(...silence) : null;
  if (quiet !== null && quiet >= SLEEPING_AFTER_DAYS) return node("span", `молчит ${plural(quiet, DAYS_WORDS)}`, "admin-tag admin-state-asleep");
  return null;
}
function userRow(user, { lastAdmin = false, days = null } = {}) {
  const row = node("div", null, "admin-user");
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
    `записей ${user.captureCount ?? 0}`,
    `в этом месяце $${spent.toFixed(2)}${capped ? ` из $${cap}` : " (потолок общий)"}`,
  ];
  if (user.blockedReason) facts.push(`причина: ${user.blockedReason}`);
  if (user.lastLoginAt) facts.push(`входил ${new Date(user.lastLoginAt).toLocaleString("ru-RU")}`);
  const factsLine = node("p", facts.join(" · "), "admin-user-facts");
  if (capped && spent >= cap) factsLine.classList.add("quota-exhausted");
  row.append(factsLine);
  if (user.activity) row.append(activityLine(user.activity, days));

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
  limits.append(
    adminButton("Сохранить пределы", "secondary", () =>
      adminAction(user.id, "limits", {
        monthlyLimitUsd: monthly.value.trim(),
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
  const days = payload.activityDays || null;
  for (const user of pending) pendingBox.append(userRow(user, { days }));
  clear(box);
  for (const user of payload.users.filter((user) => user.status !== "pending"))
    box.append(userRow(user, { lastAdmin: user.id === soleAdmin, days }));

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
async function openReportEntry(captureId, { occurrence = null } = {}) {
  cardOccurrence = occurrence;
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
  counters.append(
    reportCounter({ num: money(service.usage.costUsd), cap: "потрачено на разбор", sub: service.usage.unpriced ? `${service.usage.unpriced} ${pluralRu(service.usage.unpriced, "вызов", "вызова", "вызовов")} без цены` : "по данным провайдеров" }),
    reportCounter({ num: service.usage.calls, cap: pluralRu(service.usage.calls, "вызов модели", "вызова модели", "вызовов модели"), sub: service.quality.failed ? `${service.quality.failed} неудачных` : "все удались" }),
    reportCounter({ num: service.quality.corrections, cap: pluralRu(service.quality.corrections, "правка после модели", "правки после модели", "правок после модели"), sub: service.quality.topField ? `чаще всего — ${correctionFieldNames[service.quality.topField.field] || service.quality.topField.field}` : "правок не было" }),
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
  const doneCard = reportCard("Сделано", { right: String(data.done.length || ""), hint: "Зафиксированная работа за этот день — как во вкладке «Сделано»" });
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

// ── доска: вид, группировка, порядок колонок и фильтр ───────────────────────
// Как в Notion: вид — то, как рисовать (доска, список, таблица), группировка —
// по каким полям раскладывать. Полей можно взять сколько угодно: первое даёт
// колонки или разделы, каждое следующее — вложенные подгруппы. Готовых видов
// нет: всё выбирается руками и помнится в браузере; у каждого поля свой цвет
// (--f-* в app.css). «Сделано» — последний раздел списка и таблицы при любой
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
// Логика фильтра и порядка — в public/board-model.js, здесь — хранение и рисунок.
const BOARD_FIELDS = Object.fromEntries(Object.entries(FILTER_FIELDS).filter(([key]) => key !== "status"));
const BOARD_VIEWS = ["board", "list", "table"];
const BOARD_VIEW_KEY = "kizuna-board-view";
const BOARD_GROUPS_KEY = "kizuna-board-groups";
const BOARD_FILTER_KEY = "kizuna-board-filter";
const BOARD_ORDER_KEY = "kizuna-board-order";
// Порядок групп фиксированный: у дня и источника — свой, у человека и
// проекта — по алфавиту, «без …» всегда последним.
const BOARD_DAYS = [["late", "просрочено"], ["today", "сегодня"], ["tomorrow", "завтра"], ["week", "на неделе"], ["later", "позже"], ["none", "без срока"]];
const BOARD_SOURCES = [["telegram", "Telegram"], ["notes", "Заметки"], ["field", "Поле"]];
// Срок, который получает дело, брошенное в группу-день: через сколько дней от
// сегодня. «Просрочено» срока не назначает, «без срока» его снимает.
const BOARD_DAY_DROP = { today: 0, tomorrow: 1, week: 2, later: 14 };
function boardStoredView() {
  try { const view = localStorage.getItem(BOARD_VIEW_KEY); return BOARD_VIEWS.includes(view) ? view : "board"; } catch { return "board"; }
}
function boardStoredGroups() {
  try {
    const raw = localStorage.getItem(BOARD_GROUPS_KEY);
    const list = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(list)) return ["col"];
    return [...new Set(list.filter((field) => Object.keys(BOARD_FIELDS).includes(field)))];
  } catch { return ["col"]; }
}
function boardStoredFilter() {
  try { return readFilter(localStorage.getItem(BOARD_FILTER_KEY)); } catch { return defaultFilter(); }
}
function boardStoredOrder() {
  try { return readOrder(localStorage.getItem(BOARD_ORDER_KEY)); } catch { return {}; }
}
const boardState = {
  // stamp — ответ сервера (строкой), по которому нарисована доска: тот же ответ не перерисовывается.
  data: null, stamp: null, drag: null, openAdder: null,
  search: "",
  view: boardStoredView(),
  groups: boardStoredGroups(),
  // Наборный фильтр: условия {field, op, value}. Строка под панелью открыта, пока фильтр что-то отбирает.
  filter: boardStoredFilter(),
  filterOpen: false,
  // Порядок колонок доски: { "<поле первого уровня>": ["__done", "<ключ группы>", …] }.
  order: boardStoredOrder(),
  // На телефоне открывается первая своя колонка, а не «Сделано»; null — ещё не выбирали.
  mobileColumn: null,
};
boardState.filterOpen = activeConditions(boardState.filter).length > 0;
function boardRemember() {
  try {
    localStorage.setItem(BOARD_VIEW_KEY, boardState.view);
    localStorage.setItem(BOARD_GROUPS_KEY, JSON.stringify(boardState.groups));
  } catch {}
}
// Черновик условия (значение ещё не выбрано) не сохраняется: он ничего не отбирает.
function boardRememberFilter() {
  try { localStorage.setItem(BOARD_FILTER_KEY, JSON.stringify(activeConditions(boardState.filter))); } catch {}
}
function boardRememberOrder() {
  try { localStorage.setItem(BOARD_ORDER_KEY, JSON.stringify(boardState.order)); } catch {}
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
const kc = {
  circle: null, chat: null, info: null, person: null, table: true, menu: false, talks: false, ctx: null,
  reply: null, share: null, newFrom: null, talk: null, modal: null, invite: null,
  fresh: false, focusField: false, deedFocus: false,
};
const KC_REACTIONS = ["👍", "❤️", "🔥", "🙏", "👀", "✅"];
// Тип записи — цвет и слово для строки обсуждения.
const KC_KIND = { todo: ["violet", "дело"], meeting: ["orange", "встреча"], outcome: ["blue", "результат"], note: ["teal", "заметка"], idea: ["pink", "идея"] };
const KC_NAME_TONES = ["violet", "blue", "teal", "orange", "pink", "red"];
function kcStored(key, fallback) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; }
}
function kcStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
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
  holder.setAttribute("aria-label", read ? "прочитано" : "отправлено");
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
  try { return new Intl.DateTimeFormat("ru-RU", { timeZone: TODAY_ZONE, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return ""; }
}
function kcWhen(iso) {
  if (!iso) return "";
  const day = zoneDate(new Date(iso));
  const today = currentDayDate || zoneDate(new Date());
  if (day === today) return kcClock(iso);
  if (day === shiftDate(today, -1)) return "вчера";
  return reportDateLabel(day, { day: "numeric", month: "short" });
}
function kcDayLabel(day) {
  const today = currentDayDate || zoneDate(new Date());
  if (day === today) return "Сегодня";
  if (day === shiftDate(today, -1)) return "Вчера";
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
      toast(error.message || "Разговор не открылся");
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
      toast(error.message || "Обсуждение не открылось");
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
    if (body) { clear(body); body.append(node("p", error.message || "Не удалось загрузить круги", "empty")); }
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
  tabs.setAttribute("aria-label", "Круги");
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
  if (kcThreads().some((item) => kcWhereOf(item) === "none")) tabs.append(tab("none", kcEl("span", "kc-tab-doc", kcIcon("doc")), "Без круга"));
  tabs.append(kcButton("kc-tab add", [kcIcon("plus"), kcEl("span", "kc-tab-name", "Круг")], () => kcModalOpen("circle"), { "aria-label": "Новый круг", title: "Новый круг" }));
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
    seats.setAttribute("aria-label", `Люди круга «${circle.name}»`);
    for (const member of circle.members) seats.append(kcSeat(member, circle, current));
    seats.append(kcButton("kc-seat add", [kcEl("span", "kc-seat-plus", kcIcon("personAdd")), kcEl("span", "kc-seat-who", kcEl("b", null, "Позвать"), kcEl("small", null, "из Кизуны или ссылкой"))], () => kcInfoOpen("invite")));
  } else if (current?.kind === "talk") {
    seats.setAttribute("aria-label", "Участники обсуждения");
    for (const person of kcTalkPeople(current)) seats.append(kcSeat(person, null, current));
  } else return null;
  return kcEl("div", "kc-band", seats, kcButton("kc-icon kc-band-fold", kcIcon("chevUp"), () => kcSetTable(false), { "aria-label": "Свернуть людей", title: "Свернуть людей" }));
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
      kcEl("small", late ? "late" : null, late ? "просрочено" : next.due?.date ? kcDue(next.due) : next.state === "pending" ? "ждёт ответа" : "без срока", rest ? ` · ещё ${rest}` : "")]
    : kcEl("small", null, !circle ? (person.id === current?.talk?.author?.id ? "автор записи" : "в обсуждении") : away ? "не в этой комнате" : joinedToday && person.role !== "owner" ? "в круге с сегодня" : "дел в круге нет");
  const face = kcButton("kc-seat-face", avatarEl(person), () => (circle ? kcInfoOpen("person", person.id) : kcInfoOpen("main")), { "aria-label": `${person.name}: карточка`, title: person.name });
  const seat = kcEl("div", `kc-seat${away ? " away" : ""}`, face,
    kcEl("span", "kc-seat-who", kcEl("b", null, kcEl("span", null, me ? "Вы" : person.name), person.role === "owner" ? kcEl("i", null, "хозяин") : null), line));
  if (!me && !away && current) seat.append(kcButton("kc-seat-at", "@", () => kcInsertCall(person.name), { "aria-label": `Позвать ${person.name} в разговор`, title: `@${person.name}` }));
  // Дело человеку — прямо отсюда: карточка открывается с готовым полем, писать
  // в него можно сразу.
  if (!me && circle) seat.append(kcButton("kc-seat-todo", kcIcon("todo"), () => { kc.deedFocus = true; kcInfoOpen("person", person.id); }, { "aria-label": `Поручить дело: ${person.name}`, title: "Поручить дело" }));
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
  const names = [...people.filter(mine), ...people.filter((person) => !mine(person))].map((person) => (mine(person) ? "вы" : person.name));
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} и ${names.at(-1)}`;
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
  chips.setAttribute("aria-label", "Разговоры");
  if (hidden.length) {
    const waiting = hidden.some((item) => item.unread || item.called);
    const more = kcButton(`kc-chip more${kc.talks ? " on" : ""}`, [kcIcon("doc"), kcEl("span", "kc-chip-name", `Записи · ${hidden.length}`), waiting ? kcEl("span", "kc-dot") : null],
      () => { kc.talks = !kc.talks; kc.menu = false; kc.ctx = null; renderCircles(); }, { "aria-haspopup": "menu", "aria-expanded": String(kc.talks) });
    more.dataset.kcMenu = "1";
    chips.append(more);
  }
  if (circle && circle.members.length > 1) chips.append(kcButton("kc-chip add", [kcIcon("plus"), kcEl("span", "kc-chip-name", "Разговор")], () => kcModalOpen("room", { circleId: circle.id }), { title: "Новый разговор в круге" }));
  const row = kcEl("div", "kc-threads", chips);
  const people = circle ? circle.members : current?.kind === "talk" ? kcTalkPeople(current) : [];
  if (!kc.table && people.length) row.append(kcButton("kc-folded", [kcFaces(people, 5), kcEl("span", "kc-wide", `${people.length} ${pluralRu(people.length, "человек", "человека", "человек")}`), kcIcon("chevDown")], () => kcSetTable(true), { "aria-label": "Показать людей", title: "Показать людей" }));
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
    title = `Обсуждение записи «${name}»`;
  } else if (item.room.kind === "general") {
    lead = kcIcon("chats");
    name = "Общий";
    title = "Общий разговор круга — его видят все, кто в круге";
  } else if (item.room.everyone) {
    lead = kcEl("span", "kc-chip-hash", "#");
    name = item.room.name;
    title = `«${name}» — видит весь круг`;
  } else {
    lead = kcIcon("lock");
    name = item.room.name;
    faces = kcFaces(item.room.members.filter((member) => member.id !== currentUser?.id), 3);
    title = `«${name}» — видят только ${kcNames(item.room.members)}`;
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
  menu.setAttribute("aria-label", "Обсуждения записей");
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
  const button = kcButton("kc-icon", kcIcon("dots"), () => { kc.menu = !kc.menu; kc.ctx = null; kc.talks = false; renderCircles(); }, { "aria-label": "Ещё", title: "Ещё", "aria-pressed": String(kc.menu), "aria-haspopup": "menu" });
  button.dataset.kcMenu = "1";
  return button;
};
function kcPinned(item) {
  if (item.kind !== "room" || !item.room.pinned) return null;
  const pinned = item.room.pinned;
  const bar = kcEl("div", "kc-pinned");
  const jump = kcButton("kc-pinned-main", [kcEl("span", "kc-pinned-bar"), kcEl("span", "kc-pinned-text", kcEl("b", null, "Закреплённое сообщение"), kcEl("span", null, pinned.body))], () => {
    const target = document.querySelector(`#kc-msgs [data-id="${CSS.escape(pinned.id)}"]`);
    if (!target) { toast("Сообщение выше — прокрутите разговор"); return; }
    target.scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1400);
  });
  bar.append(jump, kcButton("kc-icon", kcIcon("close"), () => kcPin(item, null), { "aria-label": "Открепить", title: "Открепить" }));
  return bar;
}
// Над обсуждением записи — сама запись строкой: что это за дело и когда, и
// карточка в одно нажатие.
function kcRecordBar(item) {
  const talk = item.talk;
  const [, word] = KC_KIND[talk.kind] || KC_KIND.note;
  const open = () => openSharedCard(talk.captureId, { talk: true });
  return kcEl("div", "kc-pinned kc-record",
    kcButton("kc-pinned-main", [kcEl("span", "kc-pinned-bar"), kcEl("span", "kc-pinned-text", kcEl("b", null, `Запись · ${word}${talk.due?.date ? ` · до ${kcDue(talk.due)}` : ""}`), kcEl("span", null, talk.title))], open, { "aria-label": `Запись «${talk.title}»` }),
    kcButton("kc-btn sm", [kcIcon("doc"), kcEl("span", "kc-wide", "Открыть карточку")], open, { "aria-label": "Открыть карточку" }));
}
function kcChatPane(item, circle) {
  const section = kcEl("section", "kc-chat-pane");
  section.setAttribute("aria-label", "Разговор");
  const alone = circle && circle.members.length === 1 && (!item || (item.kind === "room" && item.room.kind === "general"));
  if (alone) { section.append(kcAlone(circle)); return section; }
  if (!item) {
    section.append(kcEl("div", "kc-empty-chat", kcEl("p", "kc-pill", "Выберите разговор — где ждут, стоит число")));
    return section;
  }
  const pinned = item.kind === "talk" ? kcRecordBar(item) : kcPinned(item);
  if (pinned) section.append(pinned);
  const list = kcEl("div", "kc-msgs");
  list.id = "kc-msgs";
  list.setAttribute("role", "log");
  const column = kcEl("div", "kc-col");
  if (chatState.loading) column.append(kcEl("p", "kc-pill", "Читаю…"));
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
    return kcEl("p", "kc-start", `Начало обсуждения записи «${item.talk.title}»`, talk && !talk.comments.length ? " — пока тихо: напишите и позовите, кто нужен, через @имя" : "");
  }
  if (chatState.more) return null;
  const room = item.room, circle = item.circle;
  const since = reportDateLabel(zoneDate(new Date(room.kind === "general" ? circle.createdAt : room.createdAt)), { day: "numeric", month: "long" });
  const who = room.kind === "general" || room.everyone ? "видит весь круг" : `видят только ${kcNames(room.members)}`;
  return kcEl("p", "kc-start", room.kind === "general" ? `Начало разговора круга «${circle.name}» · с ${since} · ${who}` : `Начало разговора «${room.name}» · с ${since} · ${who}`);
}
// Круг из одного: вместо пустого разговора — позвать людей прямо здесь.
function kcAlone(circle) {
  return kcEl("div", `kc-alone ${kcTone(circle.color)}`,
    kcEl("div", "kc-alone-card",
      kcEl("h3", null, "В круге пока только вы"),
      kcEl("p", "kc-hint", "Разговор оживёт, когда позовёте людей. Позванные увидят только то, что вы отдадите в круг."),
      kcInviteEl(circle)));
}
function kcRoomMessages(list, item) {
  const owner = item.circle.members.find((member) => member.role === "owner")?.id;
  kcBubbles(list, chatState.messages, { owner, ownerWord: "хозяин" });
}
function kcTalkMessages(list, item) {
  const talk = kc.talk?.captureId === item.talk.captureId ? kc.talk : { comments: [], participants: [] };
  // «Аня — в обсуждении» стоит там, где человека позвали: видно, с какого
  // места он читает разговор вместе со всеми.
  const joins = talk.participants.map((person) => ({ id: `join:${person.id}`, kind: "line", createdAt: person.addedAt, text: `${person.id === currentUser?.id ? "Вы" : person.name} — в обсуждении` }));
  const items = [...talk.comments, ...joins].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  kcBubbles(list, items, { owner: item.talk.author?.id, ownerWord: "автор" });
}
const kcAuthorOf = (message) => (message.kind === "deed" ? message.deed.assigner : message.author);
function kcBubbles(list, items, { owner, ownerWord }) {
  let day = null, index = 0;
  while (index < items.length) {
    const message = items[index];
    const messageDay = zoneDate(new Date(message.createdAt));
    if (messageDay !== day) { day = messageDay; list.append(kcEl("div", "kc-pill kc-day", kcDayLabel(day))); }
    if (message.id === kc.newFrom) list.append(kcEl("div", "kc-unread-bar", "Непрочитанные сообщения"));
    if (message.kind !== "said" && message.kind !== "deed") {
      list.append(kcEl("div", "kc-pill", message.kind === "line" ? message.text : `${message.author?.name || "Кто-то"} ${message.body}`));
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
  const quote = kcButton("kc-quote", [kcEl("b", null, replyTo.author ? (replyTo.author.id === currentUser?.id ? "Вы" : replyTo.author.name) : "Сообщение"), kcEl("span", null, replyTo.removed ? "сообщение убрано" : replyTo.body)], () => {
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
    const name = kcEl("span", "kc-name", kcEl("span", null, message.author?.name || "Кто-то"), message.author?.id && message.author.id === owner ? kcEl("i", null, ownerWord) : null);
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
  const more = kcButton("kc-bb-act", kcIcon("dots"), (event) => { const box = event.currentTarget.getBoundingClientRect(); kcCtxOpen(message.id, box.left, box.bottom + 4); }, { "aria-label": "Ещё" });
  more.dataset.kcMenu = "1";
  return kcEl("div", "kc-bb-wrap", bubble, kcEl("span", "kc-bb-acts", kcButton("kc-bb-act", kcIcon("reply"), () => kcReplyTo(message), { "aria-label": "Ответить" }), more));
}
function kcReactChip(message, reaction) {
  const faces = reaction.count <= 2 && reaction.people?.length ? kcEl("span", "kc-react-faces", reaction.people.slice(0, 2).map((person) => avatarEl(person, { size: "mini" }))) : kcEl("span", null, String(reaction.count));
  const names = (reaction.people || []).map((person) => person.name).join(", ");
  return kcButton(`kc-react${reaction.mine ? " mine" : ""}`, [reaction.emoji, faces], () => kcReact(message, reaction.emoji), { "aria-label": `${reaction.emoji} ${reaction.count}`, title: names });
}
function kcDeedBubble(message) {
  const deed = message.deed;
  const [stateClass, stateWord] = { pending: ["wait", "ждёт ответа"], accepted: ["took", "взято"], declined: ["back", "отказ"], done: ["done", "сделано"] }[deed.state] || ["wait", deed.state];
  const me = currentUser?.id;
  const bubble = kcEl("div", "kc-bb kc-deed",
    kcEl("span", "kc-deed-kind", kcIcon("todo"), "Дело"),
    kcButton("kc-deed-title", deed.title, () => openSharedCard(deed.captureId)),
    kcEl("div", "kc-deed-meta", avatarEl(deed.assigner, { size: "mini" }), deed.assigner?.id === me ? "вы" : deed.assigner?.name, " → ", avatarEl(deed.assignee, { size: "mini" }), deed.forMe ? "вам" : deed.assignee?.name, deed.due?.date ? ` · до ${kcDue(deed.due)}` : ""),
    kcEl("div", "kc-reacts", kcEl("span", `kc-state ${stateClass}`, stateWord), kcEl("span", "kc-meta", kcClock(message.createdAt))));
  bubble.dataset.id = message.id;
  const wrap = kcEl("div", "kc-bb-wrap", bubble);
  if (!(deed.forMe && deed.state === "pending")) return wrap;
  return [wrap, kcEl("div", "kc-kbd-row", kcButton("kc-kbd", "Беру", () => kcRespond(deed, true)), kcButton("kc-kbd", "Не я", () => kcRespond(deed, false)))];
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
        ? kcEl("p", null, kcEl("b", null, `${names.join(", ")} ещё не в этом разговоре`),
          `: ${many ? "увидят" : "увидит"} его целиком, включая прошлые сообщения${strangers.length ? `. ${strangers.map((person) => person.name).join(", ")} ${strangers.length > 1 ? "войдут" : "войдёт"} и в круг «${item.circle?.name || ""}»: люди круга, общие дела и разговоры` : ""}.`)
        : kcEl("p", null, kcEl("b", null, `${names.join(", ")} ${many ? "получат" : "получит"} доступ к этой записи`), ": заголовок, заметки, файлы и всё обсуждение."),
      kcEl("div", "kc-share-acts",
        kcButton("kc-btn sm primary", "Позвать и отправить", () => kcSend(item, "yes")),
        kcButton("kc-btn sm", "Отправить без призыва", () => kcSend(item, "no")),
        kcButton("kc-btn sm ghost", "Изменить", () => { kc.share = null; kc.focusField = true; renderCircles(); }))));
  }
  const target = kc.reply?.chat === key ? kcFindMessage(item, kc.reply.id) : null;
  if (target) {
    wrap.append(kcEl("div", "kc-replybar", kcIcon("reply"),
      kcEl("span", "kc-replybar-q", kcEl("b", null, `Ответ: ${target.author?.id === currentUser?.id ? "себе" : target.author?.name || ""}`), kcEl("span", null, target.body)),
      kcButton("kc-icon", kcIcon("close"), () => { kc.reply = null; kc.focusField = true; renderCircles(); }, { "aria-label": "Отменить ответ" })));
  }
  const field = kcEl("textarea");
  field.id = "kc-field";
  field.rows = 1;
  field.placeholder = "Сообщение";
  field.setAttribute("aria-label", `Сообщение в «${item.title}»`);
  field.value = chatState.drafts[key] || "";
  const callable = item.kind === "room" ? kcRoomCallable(item) : kc.talk?.captureId === item.talk.captureId ? kc.talk.callable : [];
  const send = kcButton("kc-send", kcIcon("send"), () => kcSend(item), { "aria-label": "Отправить" });
  send.disabled = !field.value.trim();
  const changed = () => { chatState.drafts[key] = field.value; send.disabled = !field.value.trim(); kcAutosize(field); };
  const pop = mentionPopup(field, callable, changed, { note: item.kind === "room" ? "позовём сюда" : "увидит запись" });
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
  }, { "aria-label": "Позвать через @", title: "Позвать через @" });
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
      if (!response.ok) throw new Error(result?.error?.message || "Сообщение не ушло");
      kcEdited();
      if (kc.chat === key && !chatState.messages.some((message) => message.id === result.message.id)) chatState.messages = [...chatState.messages, result.message];
      const room = chatState.rooms.find((entry) => entry.id === item.room.id);
      if (result.room && room) Object.assign(room, result.room, { unread: 0 });
      if (result.called?.length) toast(`Позвали: ${result.called.map((person) => person.name).join(", ")}`);
      // Позвали того, кого здесь не было, — состав разговора и круга изменился.
      if (share === "yes") loadCircles();
    } else {
      const response = await fetch(`/api/captures/${item.talk.captureId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, ...(replyId ? { parentId: replyId } : {}), ...(share ? { share } : {}) }) });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { location.replace("/login"); return; }
      // Позвать того, кто запись ещё не видит, — значит поделиться ею: над
      // полем встаёт выбор, молча журнал не открывается никому.
      if (response.status === 409 && data?.error?.code === "share_needed") { kc.share = { chat: key, body, people: data.people || [] }; renderCircles(); return; }
      if (!response.ok) throw new Error(data?.error?.message || "Сообщение не ушло");
      kcEdited();
      if (kc.talk?.captureId === item.talk.captureId) {
        if (!kc.talk.comments.some((comment) => comment.id === data.comment.id)) kc.talk.comments = kcTalkItems([...kc.talk.comments, data.comment]);
        kc.talk.participants = data.participants || kc.talk.participants;
      }
      const talk = (circlesState.discussions || []).find((entry) => entry.captureId === item.talk.captureId) || item.talk;
      talk.last = { body: data.comment.body.slice(0, 160), at: data.comment.createdAt, author: data.comment.author };
      if (data.comment.mentions.length) toast(`Позвали: ${data.comment.mentions.map((person) => person.name).join(", ")}`);
    }
    kc.share = null;
    kc.reply = null;
    kc.newFrom = null;
    chatState.drafts[key] = "";
    kc.focusField = true;
    renderCircles({ toBottom: true });
  } catch (error) {
    toast(error.message || "Сообщение не ушло");
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
  menu.append(kcEl("div", "kc-ctx-reacts", KC_REACTIONS.map((emoji) => kcButton(`kc-ctx-react${(message.reactions || []).some((reaction) => reaction.emoji === emoji && reaction.mine) ? " on" : ""}`, emoji, () => kcReact(message, emoji), { "aria-label": `Реакция ${emoji}` }))));
  menu.append(
    kcMenuRow("reply", "Ответить", () => kcReplyTo(message)),
    kcMenuRow("deed", "В дело", () => { location.hash = "#today"; prefillCapture(message.body.replace(/@[\p{L}\p{N}_-]+/gu, "").trim(), "todo"); }),
    kcMenuRow("copy", "Скопировать текст", async () => {
      try { await navigator.clipboard.writeText(message.body); toast("Текст скопирован"); } catch { toast("Скопировать не получилось"); }
      renderCircles();
    }));
  if (item.kind === "room") {
    const pinned = item.room.pinned?.id === message.id;
    menu.append(kcMenuRow("pin", pinned ? "Открепить" : "Закрепить", () => kcPin(item, pinned ? null : message.id)));
    if (mine) menu.append(kcMenuRow("trash", "Убрать", () => kcRemove(item, message), { danger: true }));
  }
  return menu;
}
function kcHeadMenu(item) {
  const menu = kcEl("div", "kc-menu kc-head-menu");
  menu.setAttribute("role", "menu");
  menu.append(kcMenuRow("people", "Информация", () => kcInfoOpen("main")));
  if (item.kind === "room") {
    const circle = item.circle;
    const subset = item.room.kind === "room" && !item.room.everyone;
    if (subset) menu.append(kcMenuRow("personAdd", "Позвать в комнату", () => kcInfoOpen("roomadd")));
    if (circle.members.length > 1) menu.append(kcMenuRow("plus", "Новый разговор", () => kcModalOpen("room", { circleId: circle.id })));
    menu.append(kcMenuRow("muted", circle.muted ? "Снова показывать в дне" : "Не показывать в дне", () => toggleCircleMute(circle.id, !circle.muted)));
    menu.append(kcMenuRow("bound", "Граница круга", () => kcInfoOpen("bound")));
    if (subset) menu.append(kcMenuRow("exit", "Выйти из комнаты", () => kcLeaveRoom(item.room), { danger: true }));
    menu.append(circle.role === "owner" ? kcMenuRow("exit", "Распустить круг", () => kcDissolve(circle), { danger: true }) : kcMenuRow("exit", "Покинуть круг", () => kcLeaveCircle(circle), { danger: true }));
  } else {
    menu.append(kcMenuRow("doc", "Открыть карточку", () => openSharedCard(item.talk.captureId, { talk: true })));
    if (!item.talk.mine && (kc.talk?.participants || []).some((person) => person.id === currentUser?.id)) menu.append(kcMenuRow("exit", "Не следить", () => kcUnfollow(item), { danger: true }));
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
  } catch (error) { toast(error.message || "Реакция не встала"); }
  renderCircles();
}
async function kcPin(item, messageId) {
  try {
    const result = await request(`/api/rooms/${item.room.id}/pin`, { method: "POST", body: JSON.stringify(messageId ? { messageId } : {}) });
    kcEdited();
    Object.assign(chatState.rooms.find((entry) => entry.id === item.room.id) || item.room, result.room, { unread: 0 });
    toast(messageId ? "Сообщение закреплено — его видят все в разговоре" : "Сообщение откреплено");
  } catch (error) { toast(error.message || "Не получилось"); }
  renderCircles();
}
async function kcRemove(item, message) {
  try {
    await request(`/api/rooms/${item.room.id}/messages/${message.id}`, { method: "DELETE" });
    kcEdited();
    chatState.messages = chatState.messages.filter((entry) => entry.id !== message.id);
    const room = chatState.rooms.find((entry) => entry.id === item.room.id) || item.room;
    if (room.pinned?.id === message.id) room.pinned = null;
    toast("Сообщение убрано");
  } catch (error) { toast(error.message || "Не получилось"); }
  renderCircles();
}
async function kcRespond(deed, take) {
  const reason = take ? "" : (prompt("Почему не вы? Можно не отвечать — причина уйдёт автору.") ?? "").trim();
  try {
    await request(`/api/assignments/${deed.assignmentId}/respond`, { method: "POST", body: JSON.stringify({ take, ...(reason ? { reason } : {}) }) });
    kcEdited();
    toast(take ? "Взято — дело в вашем дне" : "Вернули автору");
    await refreshRoomsQuietly();
    load().catch(() => {});
  } catch (error) { toast(error.message || "Не получилось ответить"); }
}
async function kcLeaveRoom(room) {
  if (!confirm(`Выйти из комнаты «${room.name}»? Она пропадёт из списка, а разговор останется у остальных.`)) return;
  try {
    await request(`/api/rooms/${room.id}/leave`, { method: "POST", body: JSON.stringify({}) });
    const general = chatState.rooms.find((item) => item.circleId === room.circleId && item.kind === "general");
    kc.chat = general ? `room:${general.id}` : null;
    kc.info = null;
    await loadCircles();
  } catch (error) { toast(error.message || "Не получилось"); }
}
async function kcDissolve(circle) {
  if (!confirm(`Распустить круг «${circle.name}»? Записи останутся у авторов, но из круга уйдут, а неотвеченные просьбы снимутся.`)) return;
  try {
    await request(`/api/circles/${circle.id}`, { method: "DELETE" });
    kc.chat = null;
    kc.info = null;
    await loadCircles();
    await load();
    toast(`Круг «${circle.name}» распущен`);
  } catch (error) { toast(error.message || "Не получилось"); }
}
async function kcLeaveCircle(circle) {
  if (!confirm(`Покинуть круг «${circle.name}»? Взятые дела останутся у вас — вы их взяли.`)) return;
  try {
    await request(`/api/circles/${circle.id}/leave`, { method: "POST", body: JSON.stringify({}) });
    kc.chat = null;
    kc.info = null;
    await loadCircles();
    await load();
    toast("Вы вышли из круга");
  } catch (error) { toast(error.message || "Не получилось"); }
}
async function kcUnfollow(item) {
  try {
    await request(`/api/captures/${item.talk.captureId}/people/${currentUser.id}`, { method: "DELETE" });
    toast("Запись убрана у вас: новый призыв вернёт её");
    kc.chat = null;
    kc.info = null;
    await loadCircles();
    load().catch(() => {});
  } catch (error) { toast(error.message || "Не получилось"); }
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
  aside.setAttribute("aria-label", "Информация");
  const head = (title, back = false) => kcEl("div", "kc-info-head",
    back ? kcButton("kc-icon", kcIcon("back"), () => { kc.info = "main"; renderCircles(); }, { "aria-label": "Назад" }) : null,
    kcEl("h3", null, title),
    kcButton("kc-icon", kcIcon("close"), kcInfoClose, { "aria-label": "Закрыть" }));
  const body = kcEl("div", "kc-info-body");
  if (item.kind === "talk") {
    aside.append(head("Информация"), body);
    kcTalkInfo(body, item);
    return aside;
  }
  const circle = item.circle;
  const member = kc.info === "person" ? circle.members.find((person) => person.id === kc.person) : null;
  if (kc.info === "invite") { aside.append(head(`Позвать в «${circle.name}»`, true), body); body.append(kcInviteEl(circle)); }
  else if (kc.info === "bound") { aside.append(head("Граница круга", true), body); body.append(kcBoundEl()); }
  else if (member) { aside.append(head(member.name, true), body); body.append(kcPersonEl(item, member)); }
  else if (kc.info === "roomadd" && item.room.kind === "room") { aside.append(head(`Позвать в «${item.room.name}»`, true), body); body.append(kcRoomAddEl(item)); }
  else { aside.append(head("Информация"), body); body.append(...kcCircleInfo(item)); }
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
    kcEl("small", null, `${people} ${pluralRu(people, "участник", "участника", "участников")} · ${open ? `${open} ${pluralRu(open, "открытое дело", "открытых дела", "открытых дел")}` : "дел нет"}`));
  const fresh = circlesState.links?.get(circle.id);
  const invite = circle.invite && !circle.invite.expired ? circle.invite : null;
  const link = kcRow("link", fresh ? kcEl("code", null, fresh) : invite ? "Ссылка-приглашение" : "Завести ссылку-приглашение",
    invite ? `живёт до ${reportDateLabel(invite.expiresAt.slice(0, 10), { day: "numeric", month: "short" })} · вошли по ней: ${invite.uses}` : "одна на круг, 7 дней, для любого числа людей",
    () => (fresh ? kcCopyLink(fresh) : kcInfoOpen("invite")), { side: fresh ? kcIcon("copy") : kcIcon("chev") });
  // «Показывать в дне» — личное и обратимое: остальные ничего не замечают.
  const show = kcEl("label", "kc-row kc-switch", kcIcon("bell"), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", "Показывать в дне"), kcEl("span", "kc-row-sub", "на доске и в календаре — только у вас")));
  const box = kcEl("input");
  box.type = "checkbox";
  box.id = `kc-show-${circle.id}`;
  box.checked = !circle.muted;
  box.addEventListener("change", () => toggleCircleMute(circle.id, !box.checked));
  show.append(box, kcEl("span", "kc-track"));
  // Фото ставит и убирает хозяин — как имя и цвет круга.
  const photo = circle.role !== "owner" ? [] : [
    kcRow("camera", circle.photo ? "Сменить фото" : "Поставить фото", "вместо буквы на знаке круга — видят все в круге", () => kcPickPhoto((image) => kcSaveCirclePhoto(circle, image))),
    circle.photo ? kcRow("trash", "Убрать фото", "на знаке снова будет буква", () => kcRemoveCirclePhoto(circle)) : null,
  ];
  const settings = kcEl("div", "kc-sect", link, show, kcRow("bound", "Граница круга", "что видят участники", () => kcInfoOpen("bound"), { side: kcIcon("chev") }), photo);
  const members = kcEl("div", "kc-sect", kcEl("p", "kc-sect-cap", `${people} ${pluralRu(people, "участник", "участника", "участников")}`), kcRow("personAdd", "Позвать людей", null, () => kcInfoOpen("invite"), { accent: true }));
  for (const member of circle.members) {
    const deeds = member.openDeeds || 0;
    members.append(kcButton("kc-row kc-person", [avatarEl(member), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", member.id === currentUser?.id ? `${member.name} · вы` : member.name), kcEl("span", "kc-row-sub", deeds ? `${deeds} ${pluralRu(deeds, "открытое дело", "открытых дела", "открытых дел")}` : "открытых дел нет")), member.role === "owner" ? kcEl("span", "kc-row-side", "хозяин") : null], () => kcInfoOpen("person", member.id)));
  }
  const leave = kcEl("div", "kc-sect", circle.role === "owner"
    ? kcRow("exit", "Распустить круг", null, () => kcDissolve(circle), { danger: true })
    : kcRow("exit", "Покинуть круг", null, () => kcLeaveCircle(circle), { danger: true }));
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
    catch (error) { toast(error instanceof DOMException ? "Это не похоже на картинку" : error.message || "Фото не поставилось"); }
  };
  input.click();
}
async function kcUploadCirclePhoto(circleId, image) {
  const response = await fetch(`/api/circles/${encodeURIComponent(circleId)}/photo`, { method: "POST", headers: { "Content-Type": image.type }, body: image });
  if (response.status === 401) { location.replace("/login"); return null; }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || "Фото не поставилось");
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
  toast("Фото круга поставлено");
}
async function kcRemoveCirclePhoto(circle) {
  try {
    const result = await request(`/api/circles/${encodeURIComponent(circle.id)}/photo`, { method: "DELETE" });
    kcPutCircle(result.circle);
    toast("На знаке круга снова буква");
  } catch (error) { toast(error.message || "Фото не убралось"); }
}
async function kcCopyLink(url) {
  try { await navigator.clipboard.writeText(url); toast("Ссылка скопирована — передайте её сами: писем приложение не шлёт"); }
  catch { toast("Скопируйте ссылку вручную"); }
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
    toast(refresh ? "Новая ссылка готова, прежняя больше не работает" : "Ссылка заведена — она видна только сейчас");
  } catch (error) { toast(error.message || "Приглашение не создалось"); }
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
    state.error = error.message || "Поиск не удался";
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
  input.placeholder = "Имя или почта";
  input.value = state.query;
  input.setAttribute("aria-label", `Найти человека для круга «${circle.name}»`);
  input.addEventListener("input", () => { state.query = input.value; clearTimeout(kcSearchTimer); kcSearchTimer = setTimeout(kcSearchPeople, 220); });
  search.append(input);
  const found = kcEl("div", "kc-people");
  if (state.people === null) found.append(kcEl("p", "kc-hint", "Ищу…"));
  else if (!state.people.length) found.append(kcEl("p", "kc-hint", state.error || (state.all ? "Никого не нашлось. Если человека ещё нет в Кизуне — дайте ему ссылку ниже." : "В круге уже все, кто есть в Кизуне. Нового человека зовите ссылкой ниже.")));
  for (const person of state.people || []) {
    found.append(kcButton("kc-row kc-person", [avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.name), kcEl("span", "kc-row-sub", person.email)), kcEl("span", "kc-row-side accent", "Позвать")], async (event) => {
      event.currentTarget.disabled = true;
      try {
        await request(`/api/circles/${circle.id}/members`, { method: "POST", body: JSON.stringify({ userId: person.id }) });
        toast(`${person.name} в круге «${circle.name}» — узнает строкой «к вам»`);
        state.people = state.people.filter((entry) => entry.id !== person.id);
        await loadCircles({ then: () => (kc.chat ? kcOpen(kc.chat) : renderCircles()) });
      } catch (error) { toast(error.message || "Не получилось добавить"); }
    }));
  }
  const fresh = circlesState.links?.get(circle.id);
  const invite = circle.invite && !circle.invite.expired ? circle.invite : null;
  const card = kcEl("div", `kc-linkcard ${kcTone(circle.color)}`,
    kcEl("div", "kc-linkrow",
      kcEl("code", fresh ? null : "masked", fresh || "kizuna.app/#join/••••••••••"),
      fresh ? kcButton("kc-btn sm primary", [kcIcon("copy"), "Скопировать"], () => kcCopyLink(fresh)) : kcButton(`kc-btn sm${invite ? "" : " primary"}`, invite ? "Обновить" : "Завести ссылку", () => kcMakeLink(circle))),
    fresh ? kcEl("p", "kc-hint", "Ссылка видна только сейчас — сохраните её.") : null,
    kcEl("p", "kc-hint", invite ? `Живёт до ${reportDateLabel(invite.expiresAt.slice(0, 10), { day: "numeric", month: "long" })} · вошли по ней: ${invite.uses}` : "Одна на круг · 7 дней · для любого числа людей"));
  wrap.append(kcEl("p", "kc-sect-cap", "Из Кизуны"), search, found, kcEl("p", "kc-hint", "Позванный узнает строкой «к вам» и может выйти в одно нажатие."), kcEl("p", "kc-sect-cap", "Ещё нет в Кизуне"), card);
  return wrap;
}
function kcBoundEl() {
  return kcEl("div", "kc-sub",
    kcEl("div", "kc-bound",
      kcEl("div", "kc-bound-in", kcEl("h4", null, kcIcon("eye"), "Видит круг"), kcEl("ul", null,
        kcEl("li", null, kcEl("b", null, "Записи с исполнителем"), " из круга"),
        kcEl("li", null, kcEl("b", null, "Записи, где позвали"), " участника"),
        kcEl("li", null, kcEl("b", null, "Разговоры"), " круга и комнат"))),
      kcEl("div", "kc-bound-out", kcEl("h4", null, kcIcon("lock"), "Остаётся вашим"), kcEl("ul", null,
        kcEl("li", null, "День, заметки, «Сделано»"),
        kcEl("li", null, "Голос и расход на модели"),
        kcEl("li", null, "Всё, что не отдали в круг")))),
    kcEl("p", "kc-hint", kcEl("b", null, "Правит запись автор"), ", исполнитель закрывает дело и пишет в обсуждение. ", kcEl("b", null, "Разбор моделью"), " считается тому, кто записал."));
}
function kcPersonEl(item, member) {
  const circle = item.circle;
  const me = member.id === currentUser?.id;
  const since = member.joinedAt ? reportDateLabel(zoneDate(new Date(member.joinedAt)), { day: "numeric", month: "long" }) : null;
  const today = currentDayDate || zoneDate(new Date());
  const deeds = member.deeds || [];
  const list = kcEl("div", "kc-deeds");
  if (!deeds.length) list.append(kcEl("p", "kc-hint", "Открытых дел в этом круге нет."));
  for (const deed of deeds) {
    const late = deed.due?.date && deed.due.date < today;
    list.append(kcButton("kc-deed-row", [kcIcon("todo"), kcEl("span", "kc-deed-row-title", deed.title), kcEl("small", late ? "late" : null, late ? "просрочено" : deed.due?.date ? kcDue(deed.due) : deed.state === "pending" ? "ждёт ответа" : "")], () => openSharedCard(deed.captureId)));
  }
  const more = (member.openDeeds || 0) - deeds.length;
  const acts = me ? null : kcEl("div", "kc-person-acts",
    kcButton("kc-btn sm tone", "@ Позвать в разговоре", () => { kcInfoClose(); kcInsertCall(member.name); }));
  const avatar = avatarEl(member);
  avatar.classList.add("huge");
  return kcEl("div", `kc-sub ${kcTone(circle.color)}`,
    kcEl("div", "kc-person-head", avatar, kcEl("div", null, kcEl("b", null, me ? `${member.name} · вы` : member.name), kcEl("small", null, `${member.role === "owner" ? "хозяин круга" : "участник"}${since ? ` · в круге с ${since}` : ""}`))),
    kcEl("p", "kc-sect-cap", `Дела в этом круге · ${member.openDeeds || 0}`),
    me ? null : kcDeedForm(circle, member),
    list,
    more > 0 ? kcEl("p", "kc-hint", `и ещё ${more} — на доске`) : null,
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
  field.placeholder = "Что поручить";
  field.setAttribute("aria-label", `Дело для ${member.name}`);
  const send = kcEl("button", "kc-btn sm primary", "Отдать");
  send.type = "submit";
  form.append(field, send);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = field.value.trim();
    if (!raw || send.disabled) return;
    send.disabled = true;
    send.textContent = "Отдаю…";
    try {
      const created = await request("/api/captures", { method: "POST", body: JSON.stringify({ raw, primaryType: "todo" }) });
      await request(`/api/captures/${created.entry.id}/assign`, { method: "POST", body: JSON.stringify({ assigneeId: member.id, circleId: circle.id }) });
      field.value = "";
      toast(`Просьба ушла: ${member.name} ответит «беру» или «не я»`);
      kc.deedFocus = true;
      loadCircles();
      load();
    } catch (error) {
      toast(error.message || "Дело не ушло");
    } finally {
      send.disabled = false;
      send.textContent = "Отдать";
    }
  });
  return kcEl("div", "kc-deed-add", form, kcEl("p", "kc-hint", "Срок называйте словами: «прислать смету до пятницы»."));
}
function kcRoomAddEl(item) {
  const inRoom = new Set(item.room.members.map((person) => person.id));
  const rest = item.circle.members.filter((person) => !inRoom.has(person.id));
  const wrap = kcEl("div", "kc-sub", kcEl("p", "kc-hint", `Комнату видят только те, кто в ней. Позвать можно людей круга «${item.circle.name}».`));
  const people = kcEl("div", "kc-people");
  if (!rest.length) people.append(kcEl("p", "kc-hint", "В комнате уже весь круг."));
  for (const person of rest) {
    people.append(kcButton("kc-row kc-person", [avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.name), kcEl("span", "kc-row-sub", person.email)), kcEl("span", "kc-row-side accent", "Позвать")], async (event) => {
      event.currentTarget.disabled = true;
      try {
        await request(`/api/rooms/${item.room.id}/members`, { method: "POST", body: JSON.stringify({ userId: person.id }) });
        toast(`${person.name} в комнате «${item.room.name}»`);
        await loadCircles({ then: () => (kc.chat ? kcOpen(kc.chat) : renderCircles()) });
      } catch (error) { toast(error.message || "Не получилось"); }
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
  body.append(kcEl("div", `kc-profile tone-${KC_KIND[kind][0]}`, seal, kcEl("b", null, talk.title), kcEl("small", null, `обсуждение записи · ${people.length} ${pluralRu(people.length, "участник", "участника", "участников")}`)));
  body.append(kcEl("div", "kc-sect", kcRow("doc", "Открыть карточку записи", null, () => openSharedCard(talk.captureId, { talk: true }), { accent: true })));
  const list = kcEl("div", "kc-sect", kcEl("p", "kc-sect-cap", `${people.length} ${pluralRu(people.length, "участник", "участника", "участников")}`));
  for (const person of people) {
    const role = person.id === talk.author?.id ? "автор" : (kc.talk?.participants || []).some((entry) => entry.id === person.id) ? "позван" : "из круга";
    list.append(kcEl("div", "kc-row kc-person", avatarEl(person), kcEl("span", "kc-row-text", kcEl("span", "kc-row-title", person.id === currentUser?.id ? `${person.name} · вы` : person.name), kcEl("span", "kc-row-sub", person.email || "")), kcEl("span", "kc-row-side", role)));
  }
  body.append(list);
  body.append(kcEl("p", "kc-hint kc-pad", "Позвать ещё — напишите @имя в сообщении."));
  if (!talk.mine && (kc.talk?.participants || []).some((person) => person.id === currentUser?.id))
    body.append(kcEl("div", "kc-sect", kcRow("exit", "Не следить", "запись уйдёт из ваших «Обсуждений»", () => kcUnfollow(item), { danger: true })));
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
    const letter = document.createTextNode(kcInitial(modal.name || "Круг"));
    // Фото можно поставить сразу, как у новой группы в Телеграме, или потом —
    // в «Информации». Уходит на сервер, когда круг заведён.
    const preview = kcButton("kc-photo-pick", [pictureInto(kcSeal(letter, kcTone(modal.color), "big"), modal.photo?.url), kcEl("span", "kc-photo-badge", kcIcon("camera"))], () => kcPickPhoto((image) => {
      if (kc.modal !== modal) return;
      if (modal.photo) URL.revokeObjectURL(modal.photo.url);
      modal.photo = { image, url: URL.createObjectURL(image) };
      renderCircles();
    }), { "aria-label": "Фото круга", title: modal.photo ? "Сменить фото" : "Поставить фото" });
    const title = kcEl("b", null, modal.name.trim() || "Новый круг");
    input.placeholder = "«Дача», «Книжный клуб», «Релиз»";
    input.setAttribute("aria-label", "Название круга");
    input.addEventListener("input", () => { modal.name = input.value; letter.textContent = kcInitial(input.value || "Круг"); title.textContent = input.value.trim() || "Новый круг"; });
    const tones = kcEl("div", "kc-tones");
    for (const color of Object.keys(CIRCLE_TONES)) {
      tones.append(kcButton(`kc-tone-pick ${kcTone(color)}`, null, () => { modal.color = color; renderCircles(); }, { "aria-pressed": String(modal.color === color), "aria-label": { violet: "фиолетовый", blue: "синий", teal: "бирюзовый", orange: "янтарный", pink: "розовый", red: "коралловый" }[color] }));
    }
    box.append(
      kcEl("div", "kc-modal-head", kcEl("h3", null, "Новый круг", kcEl("small", null, "Люди, граница и разговор — больше ничего")), kcButton("kc-icon", kcIcon("close"), close, { "aria-label": "Закрыть" })),
      kcEl("div", `kc-modal-preview ${kcTone(modal.color)}`, preview, kcEl("div", null, title, kcEl("small", null, "людей позовёте следующим шагом"))),
      kcEl("label", "kc-field-label", kcEl("span", null, "Название"), input),
      kcEl("div", "kc-field-label", kcEl("span", null, "Цвет"), tones),
      kcEl("div", "kc-modal-acts", kcButton("kc-btn ghost", "Отмена", close), kcEl("button", "kc-btn primary", "Завести круг")));
    box.lastElementChild.lastElementChild.type = "submit";
    box.addEventListener("submit", (event) => { event.preventDefault(); kcCreateCircle(); });
  } else {
    const circle = circlesState.circles.find((entry) => entry.id === modal.circleId);
    if (!circle) return null;
    // Новый разговор видит весь круг — или только позванные, и тогда это комната.
    const everyone = modal.everyone !== false;
    input.placeholder = "«Смета», «Релиз»";
    input.setAttribute("aria-label", "Название разговора");
    input.addEventListener("input", () => { modal.name = input.value; });
    const who = kcEl("div", "kc-seg");
    who.setAttribute("role", "radiogroup");
    who.setAttribute("aria-label", "Кто видит");
    for (const [value, label] of [[true, `Весь круг · ${circle.members.length} ${pluralRu(circle.members.length, "человек", "человека", "человек")}`], [false, "Только позванные"]])
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
      kcEl("div", "kc-modal-head", kcEl("h3", null, `Разговор в «${circle.name}»`, kcEl("small", null, "Отдельный разговор в круге — под задачу, событие или тему")), kcButton("kc-icon", kcIcon("close"), close, { "aria-label": "Закрыть" })),
      kcEl("label", "kc-field-label", kcEl("span", null, "Название"), input),
      kcEl("div", "kc-field-label", kcEl("span", null, "Кто видит"), who),
      everyone ? null : kcEl("div", "kc-field-label", kcEl("span", null, "Кого позвать"), people),
      kcEl("div", "kc-modal-acts", kcButton("kc-btn ghost", "Отмена", close), kcEl("button", "kc-btn primary", "Завести разговор")),
    ].filter(Boolean));
    box.lastElementChild.lastElementChild.type = "submit";
    box.addEventListener("submit", (event) => { event.preventDefault(); kcCreateRoom(circle); });
  }
  return kcEl("div", "kc-layer", scrim, box);
}
async function kcCreateCircle() {
  const { name, color } = kc.modal;
  const clean = name.trim();
  if (!clean) { toast("Назовите круг — «Дача», «Книжный клуб»"); $("#kc-modal-name")?.focus(); return; }
  try {
    const result = await request("/api/circles", { method: "POST", body: JSON.stringify({ name: clean, color }) });
    const photo = kc.modal?.photo;
    kc.modal = null;
    // Круг уже заведён: не встало фото — круг остаётся, фото ставится в «Информации».
    if (photo) {
      try { await kcUploadCirclePhoto(result.circle.id, photo.image); }
      catch (error) { toast(error.message || "Фото не поставилось — поставьте его в «Информации»"); }
      finally { URL.revokeObjectURL(photo.url); }
    }
    await loadCircles({ then: async () => {
      const room = chatState.rooms.find((entry) => entry.circleId === result.circle.id && entry.kind === "general");
      if (room) await kcOpen(`room:${room.id}`);
    } });
    load().catch(() => {});
    toast(`Круг «${clean}» заведён — позовите людей`);
  } catch (error) { toast(error.message || "Круг не завёлся"); }
}
async function kcCreateRoom(circle) {
  const { name, people } = kc.modal;
  const everyone = kc.modal.everyone !== false;
  const clean = name.trim();
  if (!clean) { toast("Назовите разговор — «Смета», «Релиз»"); $("#kc-modal-name")?.focus(); return; }
  if (!everyone && !people.length) { toast("Позовите хотя бы одного человека — или отдайте разговор всему кругу"); return; }
  try {
    const result = await request(`/api/circles/${circle.id}/rooms`, { method: "POST", body: JSON.stringify(everyone ? { name: clean, everyone: true } : { name: clean, members: people }) });
    kc.modal = null;
    await loadCircles({ then: () => kcOpen(`room:${result.room.id}`) });
    toast(everyone ? `Разговор «${result.room.name}» заведён — его видит весь круг` : `Комната «${result.room.name}» заведена — её видят только позванные`);
  } catch (error) { toast(error.message || "Разговор не завёлся"); }
}
function kcEmptyPage() {
  const page = kcEl("div", "kc kc-empty-page",
    kcEl("div", "kc-empty-card",
      kcSeal(kcIcon("people"), "tone-violet", "round big"),
      kcEl("h3", null, "Кругов пока нет"),
      kcEl("p", null, "Круг — это люди, граница и разговор. Заведите первый и позовите того, с кем есть общее дело. Обсуждения записей тоже появятся здесь."),
      kcButton("kc-btn primary", [kcIcon("plus"), "Завести круг"], () => kcModalOpen("circle"))));
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
  catch (error) { toast(error.message || "Приглашение не найдено"); return; }
  kc.joining = { token, peek };
  renderCircles();
}
function kcInviteCard() {
  const { token, peek } = kc.joining;
  const card = node("section", undefined, "circle-card invite-card");
  const name = node("h3", undefined, "circle-name");
  name.append(node("i", undefined, `circle-dot big ${CIRCLE_TONES[peek.circle.color] || "violet"}`), node("span", peek.circle.name));
  card.append(name);
  card.append(node("p", `${peek.invitedBy} зовёт вас в круг «${peek.circle.name}». Сейчас там ${peek.members} ${pluralRu(peek.members, "человек", "человека", "человек")}.`, "invite-lead"));
  card.append(node("p", "Войдёте — участники круга увидят записи, которые вы туда отдадите, и вы увидите их. Журнал, заметки и расход остаются личными.", "invite-hint"));
  const accept = node("button", "Войти в круг", "mini primary");
  accept.type = "button";
  accept.addEventListener("click", async () => {
    accept.disabled = true;
    try {
      const result = await request(`/api/circles/invite/${encodeURIComponent(token)}/accept`, { method: "POST", body: JSON.stringify({}) });
      kc.joining = null;
      toast(`Вы в круге «${peek.circle.name}»`);
      await loadCircles({ then: async () => {
        const room = chatState.rooms.find((item) => item.circleId === (result.circle?.id || peek.circle.id) && item.kind === "general");
        if (room) await kcOpen(`room:${room.id}`);
      } });
      await load();
    } catch (error) { toast(error.message || "Не получилось войти"); accept.disabled = false; }
  });
  const skip = node("button", "Не сейчас", "mini");
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
    toast("Отмечено как готовое", { label: "Вернуть", run: async () => {
      try {
        for (const projectionId of card.projectionIds) await request(`/api/projections/${projectionId}/undo-complete`, { method: "POST", body: "{}" });
        toast("Возвращено в работу");
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
    toast("Возвращено в работу");
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
  const word = day === today ? "сегодня" : day === shiftDate(today, -1) ? "вчера" : `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return `${word} ${notifyClock(card.closedAt)}`;
}
// Кружок «готово»: у открытого дела закрывает его, у закрытого — возвращает в
// работу. Один на карточку доски, строку списка и строку таблицы.
function boardDoneButton(card, element, closed) {
  const done = node("button", undefined, `board-done${closed ? " is-done" : ""}${card.type === "meeting_event" && !closed ? " meeting" : ""}`);
  done.type = "button";
  if (card.type === "meeting_event" && !closed) done.innerHTML = BOARD_CLOCK;
  done.title = closed ? "Вернуть в работу" : "Готово";
  done.setAttribute("aria-label", `${done.title}: ${card.title}`);
  done.addEventListener("click", (event) => {
    event.stopPropagation();
    if (closed) reopenBoardCard(card, done);
    else completeBoardCard(card, element, done);
  });
  return done;
}
// Открытые дела в порядке показа: по ним карточка листает стрелками, как бы ни
// была разложена доска — колонками, разделами списка или строками таблицы.
const boardOpenRows = () => [...$("#board").querySelectorAll(".board-card[data-capture-id]:not(.closed), .board-row[data-capture-id]:not(.closed)")];
// Название — кнопка: открывает карточку записи.
function boardTitleButton(card, element) {
  const title = node("button", card.title.split("\n")[0], "board-title");
  title.type = "button";
  title.addEventListener("click", () => {
    pendingCardList = { label: "Доска", items: rowsAsList(boardOpenRows()), id: card.captureId, occurrence: element.dataset.occurrence || null };
    openReportEntry(card.captureId);
  });
  return title;
}
// Срок одной меткой: «со вчера» у просроченного, дата — если не сегодня, час —
// если он есть.
function boardDueTag(card) {
  const today = boardState.data?.today || currentDayDate;
  const date = card.due?.date || null;
  if (date && date < today) return node("span", "со вчера", "btag due late");
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
// Карточка на доске: кружок, название и мелкая строка под ним — час, срок
// (если он не сегодня) и люди. Закрытая лежит в «Сделано» и не тянется; не
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
  body.append(titleRow);
  const meta = node("div", undefined, "board-meta");
  if (closed) meta.append(node("span", boardClosedWhen(card), "btag due"));
  else meta.append(...boardMetaTags(card));
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
// Строка списка: кружок, название, справа — срок, люди и проект. Не тянется.
function boardRowEl(card, { closed = false } = {}) {
  const row = node("div", undefined, `g-row board-row${closed ? " closed" : ""}`);
  row.dataset.captureId = card.captureId;
  if (card.due?.repeat && card.due.date) row.dataset.occurrence = card.due.date;
  const right = node("span", undefined, "g-right");
  if (closed) right.append(node("span", boardClosedWhen(card), "btag due"));
  else right.append(...boardMetaTags(card), ...(card.projects || []).map((name) => node("span", name, "btag project")));
  row.append(boardDoneButton(card, row, closed), boardTitleButton(card, row), right);
  return row;
}
// Значение поля в ячейке таблицы: пустое говорит словами, как в заголовке
// группы («Без человека»), а не пропуском.
function boardCell(card, field, closed) {
  if (field === "col") return card.columnName || "";
  if (field === "day") return closed ? boardClosedWhen(card) : card.due?.date ? scheduleLabel({ state: "ok", date: card.due.date, time: card.due.time }) : "Без срока";
  if (field === "who") return (card.people || []).join(", ") || "Без человека";
  if (field === "proj") return (card.projects || []).join(", ") || "Без проекта";
  return BOARD_SOURCES.find(([key]) => key === boardSource(card))[1];
}
// Строка таблицы: кружок вплотную к названию, отступ растёт с уровнем — как у
// заголовков групп, — дальше по ячейке на каждое поле, не занятое группировкой.
function boardTableRowEl(card, depth, cols, { closed = false } = {}) {
  const row = node("tr", undefined, `board-row${closed ? " closed" : ""}`);
  row.dataset.captureId = card.captureId;
  if (card.due?.repeat && card.due.date) row.dataset.occurrence = card.due.date;
  const first = node("td", undefined, "t");
  first.style.paddingLeft = `${10 + (depth - 1) * 16}px`;
  const wrap = node("span", undefined, "tt");
  wrap.append(boardDoneButton(card, row, closed), boardTitleButton(card, row));
  first.append(wrap);
  row.append(first);
  for (const field of cols) row.append(node("td", boardCell(card, field, closed)));
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
    await request("/api/board/move", { method: "POST", body: JSON.stringify(body) });
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
// Заголовок любой колонки доски тянется: бросок на другую колонку — слева от неё
// или справа, смотря на какую половину пришёлся, — меняет порядок. Тянутся и
// колонки человека, и группы (день, человек, проект, откуда), и «Сделано».
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
// Все колонки поля в естественном порядке — с «Сделано» впереди, включая
// скрытые фильтром: порядок сохраняется целиком, а не по тому, что сейчас видно.
function boardLaneKeys(field, data) {
  if (field === "all") return [DONE_LANE, "all"];
  const open = data.columns.flatMap((column) => column.cards);
  return [DONE_LANE, ...boardGroups(open, field, data, true).map((group) => group.key ?? FILTER_NONE)];
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
  // Порядок колонок человека живёт и на сервере; место «Сделано» — только здесь.
  const own = (keys) => keys.filter((item) => item !== DONE_LANE);
  if (field !== "col" || key === DONE_LANE || own(current).join("\n") === own(next).join("\n")) return;
  try {
    await request(`/api/board/columns/${key}`, { method: "PATCH", body: JSON.stringify({ index: own(next).indexOf(key) }) });
  } catch (error) { toast(error.message); }
  loadBoard();
}
// «Сделано» — обычная колонка доски, зелёная подложка отличает её от остальных:
// закрытые дела (последние 50), кружок возвращает дело в его колонку, а карточка,
// брошенная на колонку, закрывается. Меню у неё нет; заголовок ведёт на страницу
// «Сделано», а тянется, как у остальных, за свободное место шапки.
function boardDoneColumnEl(closed, field) {
  const element = node("section", undefined, "board-column board-done-column");
  element.dataset.columnId = "done";
  const head = node("div", undefined, "board-col-head");
  const pill = node("span", undefined, "board-pill");
  const link = node("a", "Сделано", "board-col-name");
  link.href = "#done";
  // Ссылку браузер тянет сам, как адрес; тянуться должна колонка.
  link.draggable = false;
  pill.append(link);
  head.append(pill, node("span", String(closed.length), "board-col-count"));
  boardLaneDrag(element, head, field, DONE_LANE);
  const list = node("div", undefined, "board-cards");
  for (const card of closed) list.append(boardCardEl(card, { closed: true }));
  if (!closed.length) list.append(node("p", "Закрытое появится здесь", "board-done-empty"));
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
    input.setAttribute("aria-label", "Название колонки");
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
  summary.setAttribute("aria-label", `Меню колонки ${column.name}`);
  const popover = node("div", undefined, "board-menu-popover");
  const renameButton = node("button", "Переименовать");
  renameButton.type = "button";
  renameButton.addEventListener("click", () => { menu.removeAttribute("open"); rename(); });
  const removeColumn = node("button", "Удалить колонку");
  removeColumn.type = "button";
  removeColumn.addEventListener("click", async () => {
    menu.removeAttribute("open");
    try {
      const result = await request(`/api/board/columns/${column.id}`, { method: "DELETE" });
      toast(result.moved ? `Колонка удалена, дел перенесено: ${result.moved}` : "Колонка удалена");
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
// уровня. Колонка человека — в неё, и порядок в ней серверный; день — на срок
// группы (сегодня, завтра, +2, +14: те же, что при броске карточки); человек —
// он встаёт первым среди людей дела, чтобы оно осталось в этой колонке;
// проект — проектом дела. В «просрочено» и «без срока», в «Откуда» и в
// «Сделано» приглашения нет: срок и источник так не назначить.
const BOARD_INVITE_DAY = { today: "на сегодня", tomorrow: "на завтра", week: "на неделе", later: "позже" };
function boardInviteFor(field, group, data) {
  const key = `${field}:${group.key ?? FILTER_NONE}`;
  if (field === "col") {
    const { column } = group;
    return { key, label: `+ Дело в «${column.name}»`, create: async (raw) => {
      const created = await boardCreateDeed(raw);
      await request("/api/board/move", { method: "POST", body: JSON.stringify({ captureId: created.entry.id, columnId: column.id, index: 100000 }) });
    } };
  }
  if (field === "day") {
    if (!(group.key in BOARD_INVITE_DAY)) return null;
    return { key, label: `+ Дело ${BOARD_INVITE_DAY[group.key]}`, create: (raw) => boardCreateDeed(raw, { due: { date: shiftDate(data.today, BOARD_DAY_DROP[group.key]) } }) };
  }
  if (field === "who") {
    const name = group.key;
    if (name === null) return { key, label: "+ Дело без человека", create: (raw) => boardCreateDeed(raw) };
    return { key, label: `+ Дело для ${genitiveName(name)}`, create: async (raw) => {
      const created = await boardCreateDeed(raw);
      const others = (created.entry.interpretation?.classification?.entities?.people || []).filter((person) => person !== name);
      await request(`/api/captures/${created.entry.id}/corrections`, { method: "POST", body: JSON.stringify({ at: Date.now(), patch: { people: [name, ...others] } }) });
    } };
  }
  if (field === "proj") {
    const name = group.key;
    if (name === null) return { key, label: "+ Дело без проекта", create: (raw) => boardCreateDeed(raw) };
    return { key, label: `+ Дело в «${name}»`, create: async (raw) => {
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
  input.placeholder = "Что сделать?";
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
  const button = node("button", "+ Колонка", "board-add-button");
  button.type = "button";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Название колонки";
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
// ── группировка: ключи, группы, вложенные коробки, разделы и таблица ─────────
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
// Дело помнит свою колонку (id и имя): по ней его раскладывает группировка
// «Колонка», ею же подписана строка таблицы. Закрытое лежит в колонке, куда
// вернётся; сервер её называет, а без названия — первая.
function boardAnnotate(data) {
  const names = new Map(data.columns.map((column) => [column.id, column.name]));
  for (const column of data.columns) for (const card of column.cards) { card.columnId = column.id; card.columnName = column.name; }
  for (const card of data.closed || []) {
    if (!names.has(card.columnId)) card.columnId = data.columns[0]?.id ?? null;
    card.columnName = names.get(card.columnId) || "";
  }
  return data;
}
const boardFindCard = (captureId) => boardState.data?.columns.flatMap((column) => column.cards).find((card) => card.captureId === captureId) || null;
// Группы одного уровня в фиксированном порядке. Пустые скрываются, кроме
// колонок человека на первом уровне: пустую колонку на доске нужно видеть,
// чтобы было куда бросить. Так же на доске, разложенной по дню, остаются пустые
// дни, в которые карточку можно бросить (не «просрочено»): иначе срок нельзя
// было бы назначить на день, где пока пусто. keepEmpty — true или условие.
function boardGroups(items, field, data, keepEmpty = false) {
  let groups;
  if (field === "col") groups = data.columns.map((column) => ({ key: column.id, label: column.name, column, items: items.filter((card) => card.columnId === column.id) }));
  else if (field === "day") {
    const byTime = (left, right) => (left.due?.date || "").localeCompare(right.due?.date || "") || (left.due?.time || "99").localeCompare(right.due?.time || "99");
    groups = BOARD_DAYS.map(([key, label]) => ({ key, label, items: items.filter((card) => boardDayKey(card, data.today) === key).sort(byTime) }));
  } else if (field === "src") groups = BOARD_SOURCES.map(([key, label]) => ({ key, label, items: items.filter((card) => boardSource(card) === key) }));
  else {
    // Человек и проект — первый из названных; кому и куда не названо — последней группой.
    const valueOf = (card) => (field === "who" ? card.people : card.projects)?.[0] || null;
    const names = [...new Set(items.map(valueOf).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ru"));
    groups = [...names, null].map((name) => ({ key: name, label: name ?? (field === "who" ? "Без человека" : "Без проекта"), items: items.filter((card) => valueOf(card) === name) }));
  }
  return groups.filter((group) => group.items.length || (typeof keepEmpty === "function" ? keepEmpty(group) : keepEmpty));
}
const boardTint = (field) => `var(--f-${field})`;
// Вложенные коробки подгрупп внутри колонки: заголовок в цвете поля, а внутри —
// следующий уровень или карточки.
function boardBoxes(items, fields, data, { draggable = true } = {}) {
  if (!fields.length) return items.map((card) => boardCardEl(card, { draggable }));
  const [field, ...rest] = fields;
  return boardGroups(items, field, data).map((group) => {
    const box = node("div", undefined, "g-box");
    box.style.setProperty("--fc", boardTint(field));
    const head = node("div", group.label, "g-bh");
    head.append(" ", node("span", `· ${group.items.length}`, "n"));
    box.append(head, ...boardBoxes(group.items, rest, data, { draggable }));
    return box;
  });
}
// Колонка-группа: первый уровень — не «Колонка». Заголовок не правится и без
// меню, «+ Колонки» нет, зато он тянется, как у колонок человека; карточки
// тянутся, только когда группа — день (срок меняется броском) или группировки
// нет вовсе. Внизу — приглашение «+ Дело …», где оно осмысленно.
function boardGroupColumnEl(group, field, rest, data) {
  const element = node("section", undefined, "board-column group");
  element.dataset.group = `${field || "all"}:${group.key ?? ""}`;
  const head = boardHeadEl(group.label, group.items.length);
  boardLaneDrag(element, head, field || "all", group.key ?? FILTER_NONE);
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
    toast(date ? `Срок: ${scheduleLabel({ state: "ok", date, time: null })}` : "Срок снят");
  } catch (error) {
    toast(error.message);
  }
  loadBoard();
  load().catch(() => {});
}
// Список: вложенные разделы — заголовок и тело в рамке цвета поля, — а в самом
// глубоком — строки. Глубина задаёт размер заголовка.
function boardListNodes(items, fields, depth, data, keepEmpty = false) {
  if (!fields.length) {
    const rows = node("div", undefined, "g-rows");
    rows.append(...items.map((card) => boardRowEl(card)));
    return [rows];
  }
  const [field, ...rest] = fields;
  return boardGroups(items, field, data, keepEmpty).flatMap((group) => {
    const head = node("div", group.label, `g-sec d${Math.min(depth, 3)}`);
    head.append(" ", node("span", `· ${group.items.length}`, "n"));
    const kids = node("div", undefined, "g-kids");
    head.style.setProperty("--fc", boardTint(field));
    kids.style.setProperty("--fc", boardTint(field));
    kids.append(...boardListNodes(group.items, rest, depth + 1, data));
    return [head, kids];
  });
}
// «Сделано» — заголовок-ссылка на страницу «Сделано» с числом закрытых.
function boardDoneHead(count, className) {
  const head = node("div", undefined, className);
  const link = node("a", "Сделано");
  link.href = "#done";
  head.append(link, " ", node("span", `· ${count}`, "n"));
  return head;
}
// «Статус = открыто» прячет «Сделано» — колонку доски, раздел списка и таблицы.
const boardDoneShown = () => statusAllowsDone(boardState.filter);
function boardListEl(open, closed, data) {
  const list = node("div", undefined, "g-list");
  list.append(...boardListNodes(open, boardState.groups, 1, data, boardState.groups[0] === "col"));
  if (!boardDoneShown()) return list;
  const kids = node("div", undefined, "g-kids done");
  const rows = node("div", undefined, "g-rows");
  rows.append(...closed.map((card) => boardRowEl(card, { closed: true })));
  kids.append(rows);
  list.append(boardDoneHead(closed.length, "g-sec d1 done"), kids);
  return list;
}
// Таблица: строки-заголовки групп на всю ширину и строки дел; столбцы — по
// одному на каждое поле, которое группировка не заняла.
function boardTableNodes(items, fields, depth, cols, data, keepEmpty = false) {
  if (!fields.length) return items.map((card) => boardTableRowEl(card, depth, cols));
  const [field, ...rest] = fields;
  return boardGroups(items, field, data, keepEmpty).flatMap((group) => {
    const row = node("tr", undefined, "sec");
    const cell = node("td");
    cell.colSpan = cols.length + 1;
    const head = node("div", group.label, `g-sec d${Math.min(depth, 3)}`);
    head.style.setProperty("--fc", boardTint(field));
    head.append(" ", node("span", `· ${group.items.length}`, "n"));
    cell.append(head);
    row.append(cell);
    return [row, ...boardTableNodes(group.items, rest, depth + 1, cols, data)];
  });
}
function boardTableEl(open, closed, data) {
  const cols = Object.keys(BOARD_FIELDS).filter((field) => !boardState.groups.includes(field));
  const wrap = node("div", undefined, "board-table-wrap");
  const table = node("table", undefined, "g-table");
  const headRow = node("tr");
  headRow.append(node("th", "Название"), ...cols.map((field) => node("th", BOARD_FIELDS[field])));
  const head = node("thead");
  head.append(headRow);
  const body = node("tbody");
  body.append(...boardTableNodes(open, boardState.groups, 1, cols, data, boardState.groups[0] === "col"));
  if (boardDoneShown()) {
    const doneRow = node("tr", undefined, "sec");
    const doneCell = node("td");
    doneCell.colSpan = cols.length + 1;
    doneCell.append(boardDoneHead(closed.length, "g-sec d1 done"));
    doneRow.append(doneCell);
    body.append(doneRow, ...closed.map((card) => boardTableRowEl(card, 2, cols, { closed: true })));
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
// ── наборный фильтр ──────────────────────────────────────────────────────────
// Кнопка «Фильтр · N» над доской открывает строку под панелью: условия-плашки
// («Человек = Аня ×», «День ≠ просрочено ×»), «+ условие», «Сегодня» и «Сбросить».
// В плашке три списка — поле, «=» или «≠» и значение из того, что есть в
// загруженных делах; цвет плашки — цвет поля, у «Статуса» нейтральный. «=» на
// одном поле объединяются по «или» (между такими плашками стоит «или»), разные
// поля — по «и», «≠» — всегда по «и». Условие без значения — черновик: он
// ничего не отбирает и не сохраняется.
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
  return [...names.map((name) => [name, name]), [FILTER_NONE, "пусто"]];
}
function boardFilterSelect(part, label, options, value) {
  const select = node("select");
  select.dataset.part = part;
  select.setAttribute("aria-label", label);
  for (const [key, name] of options) { const option = new Option(name, key); option.selected = key === value; select.append(option); }
  return select;
}
function boardCondEl(condition, index) {
  const chip = node("span", undefined, "board-cond");
  chip.dataset.index = String(index);
  chip.style.setProperty("--fc", boardFilterTint(condition.field));
  const values = boardFilterValues(condition.field);
  // Значение, которого в загруженном уже нет (человек ушёл, колонку удалили), не
  // подменяется молча: остаётся в списке, и условие видно.
  if (condition.value && !values.some(([key]) => key === condition.value))
    values.push([condition.value, !boardState.data ? "…" : condition.field === "col" ? "колонка удалена" : condition.value]);
  const nth = index + 1;
  const value = boardFilterSelect("value", `Значение условия ${nth}`, values, condition.value);
  if (!condition.value) {
    const hint = new Option("значение", "");
    hint.disabled = true;
    hint.hidden = true;
    hint.selected = true;
    value.prepend(hint);
    value.classList.add("is-empty");
  }
  const remove = node("button", "×", "board-cond-x");
  remove.type = "button";
  remove.dataset.remove = String(index);
  remove.title = "Убрать условие";
  remove.setAttribute("aria-label", `Убрать условие ${nth}: ${FILTER_FIELDS[condition.field]}`);
  chip.append(
    boardFilterSelect("field", `Поле условия ${nth}`, Object.entries(FILTER_FIELDS), condition.field),
    boardFilterSelect("op", `Оператор условия ${nth}`, BOARD_FILTER_OPS, condition.op),
    value,
    remove,
  );
  return chip;
}
function paintBoardFilter() {
  const toggle = $("#board-filter-toggle"), row = $("#board-filter");
  const count = activeConditions(boardState.filter).length;
  toggle.classList.toggle("is-on", count > 0);
  toggle.setAttribute("aria-expanded", String(boardState.filterOpen));
  toggle.querySelector(".board-filter-n").textContent = count ? ` · ${count}` : "";
  row.hidden = !boardState.filterOpen;
  // Строка пересобирается, только когда поменялись условия или то, из чего
  // выбирают: доска перечитывается и сама по себе, и это не должно закрывать
  // открытый список и сбивать фокус.
  const conditions = JSON.stringify(boardState.filter);
  const key = JSON.stringify([conditions, ["col", "who", "proj"].map((field) => boardFilterValues(field))]);
  if (row.dataset.key === key || (row.contains(document.activeElement) && row.dataset.conditions === conditions)) return;
  row.dataset.key = key;
  row.dataset.conditions = conditions;
  clear(row);
  row.append(node("span", "Фильтр", "board-bar-label"));
  boardState.filter.forEach((condition, index) => {
    const before = boardState.filter[index - 1];
    if (before && before.field === condition.field && before.op === "=" && condition.op === "=") row.append(node("span", "или", "board-or"));
    row.append(boardCondEl(condition, index));
  });
  const add = node("button", "+ условие", "board-cond-add");
  add.type = "button";
  add.dataset.add = "1";
  const today = node("button", "Сегодня", "board-filter-today");
  today.type = "button";
  today.dataset.today = "1";
  today.title = "Вернуть фильтр по умолчанию: сегодняшнее и просроченное";
  today.setAttribute("aria-pressed", String(sameFilter(boardState.filter, defaultFilter())));
  const clearAll = node("button", "Сбросить", "board-filter-clear");
  clearAll.type = "button";
  clearAll.dataset.clear = "1";
  clearAll.title = "Снять все условия";
  clearAll.hidden = !boardState.filter.length;
  const tail = node("span", undefined, "board-filter-tail");
  tail.append(today, clearAll);
  row.append(add, tail);
}
// Условие изменено: условия одного поля встают рядом, выбор запоминается, доска
// перерисовывается по загруженному. Фокус возвращается на тот список, который
// трогали, — плашка при перерисовке пересобрана.
function boardFilterChanged(focus = null) {
  boardState.filter = tidyFilter(boardState.filter);
  boardRememberFilter();
  if (boardState.data) renderBoard(boardState.data);
  else paintBoardBar();
  if (!focus) return;
  const index = boardState.filter.indexOf(focus.condition);
  $("#board-filter").querySelector(`.board-cond[data-index="${index}"] [data-part="${focus.part}"]`)?.focus();
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
  const key = boardState.groups.join(",");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  clear(box);
  boardState.groups.forEach((field, index) => {
    if (index) box.append(node("span", "→", "board-then"));
    const level = node("span", undefined, "board-lv");
    level.style.setProperty("--fc", boardTint(field));
    const select = node("select");
    select.dataset.level = String(index);
    select.setAttribute("aria-label", `Группировка ${index + 1}`);
    for (const [key, name] of Object.entries(BOARD_FIELDS)) { const option = new Option(name, key); option.selected = key === field; select.append(option); }
    const remove = node("button", "×", "board-lv-remove");
    remove.type = "button";
    remove.dataset.remove = String(index);
    remove.title = "Убрать уровень";
    remove.setAttribute("aria-label", `Убрать уровень ${index + 1}: ${BOARD_FIELDS[field]}`);
    level.append(node("i", String(index + 1)), select, remove);
    box.append(level);
  });
  if (boardState.groups.length < Object.keys(BOARD_FIELDS).length) {
    const add = node("button", "+ ещё", "board-lv-add");
    add.type = "button";
    add.dataset.add = "1";
    box.append(add);
  }
  if (!boardState.groups.length) box.append(node("span", "без группировки — один поток", "board-lv-none"));
}
// Вид или группировка сменились: запомнить и перерисовать. Открытое поле
// быстрого дела не переезжает — колонки, где оно стояло, уже другие.
function boardChanged() {
  boardRemember();
  boardState.openAdder = null;
  boardState.adderDraft = null;
  if (boardState.data) renderBoard(boardState.data);
  else paintBoardBar();
}
// Что о деле знает фильтр. «День» у закрытого дела — день, когда его закрыли (его
// же показывает столбец «День» в таблице), у открытого — срок: закрыл дело без
// срока — оно осталось в «Сделано» под фильтром «сегодня», а не исчезло. У дела
// несколько людей и проектов — подходит любой из них.
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
  // Открыта первая колонка, которая не «Сделано»: пока человек не выбрал сам, а
  // колонки можно переставлять, «вторая по счёту» уже не значит «первая своя».
  if (boardState.mobileColumn === null) boardState.mobileColumn = Math.max(0, columns.findIndex((column) => !column.classList.contains("board-done-column")));
  if (boardState.mobileColumn >= columns.length) boardState.mobileColumn = 0;
  columns.forEach((column, index) => {
    const name = column.querySelector(".board-col-name");
    const button = node("button", undefined, "board-segment");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(index === boardState.mobileColumn));
    button.append(node("span", name ? name.textContent : column.classList.contains("ghost") ? "+ Колонка" : "…", "board-pill"));
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
    flat.append(view === "list" ? boardListEl(open, closed, data) : boardTableEl(open, closed, data));
    return;
  }
  // Доска: колонка на группу первого уровня и «Сделано» — такая же колонка, по
  // умолчанию первая. Колонки человека — со всем, что у них есть (правятся,
  // «+ Дело в …» и «+ Колонка»); любая другая группа — колонка без меню и без
  // «+ Колонки». Заголовок тянется у всех, порядок помнится по полю первого уровня.
  // Пока фильтр что-то отбирает, пустые группы скрыты (колонки человека остаются:
  // в них бросают), а «Сделано» пропадает, только если статус исключает закрытое.
  const [first, ...rest] = boardState.groups;
  const field = first || "all";
  const filtering = activeConditions(boardState.filter).length > 0;
  const shown = [];
  if (boardDoneShown()) shown.push({ key: DONE_LANE, element: boardDoneColumnEl(closed, field) });
  if (first === "col") for (const group of boardGroups(open, "col", data, true)) shown.push({ key: group.key, element: boardColumnEl(group.column, group.items, rest, data) });
  else if (first) for (const group of boardGroups(open, first, data, first === "day" && !filtering && ((group) => group.key !== "late"))) shown.push({ key: group.key ?? FILTER_NONE, element: boardGroupColumnEl(group, first, rest, data) });
  else shown.push({ key: "all", element: boardGroupColumnEl({ key: "all", label: "Все дела", items: open }, null, [], data) });
  for (const lane of boardOrderedLanes(field, shown)) lanes.append(lane.element);
  if (first === "col") {
    lanes.append(boardGhostColumnEl(ghost));
    if (ghost?.focus) lanes.querySelector(".board-column.ghost input")?.focus();
  }
  // Сегмент колонок нужен, когда на телефоне показана одна колонка.
  paintBoardSegments([...lanes.querySelectorAll(".board-column")]);
}
// Панель над доской, поиск и «+ Дело». «+ Дело» открывает поле в первой своей
// колонке; там, где колонок человека нет (список, таблица, группы-не-колонки),
// поле встаёт рядом с кнопкой, а дело падает в первую колонку.
{
  $("#board-view").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button || button.dataset.view === boardState.view) return;
    boardState.view = button.dataset.view;
    boardChanged();
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
    paintBoardFilter();
  });
  $("#board-filter").addEventListener("change", (event) => {
    const select = event.target.closest("select[data-part]");
    const condition = boardState.filter[Number(select?.closest(".board-cond")?.dataset.index)];
    if (!condition) return;
    const part = select.dataset.part;
    // Другое поле — другие значения: прежнее не подходит, условие снова черновик.
    if (part === "field") { condition.field = select.value; condition.value = ""; }
    else if (part === "op") condition.op = select.value;
    else condition.value = select.value;
    boardFilterChanged({ condition, part });
  });
  $("#board-filter").addEventListener("click", (event) => {
    const row = $("#board-filter");
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      boardState.filter.splice(Number(remove.dataset.remove), 1);
      boardFilterChanged();
      row.querySelector(".board-cond-add")?.focus();
    } else if (event.target.closest("[data-add]")) {
      // Новое условие — на первом поле, которого ещё нет; значение выберут сами.
      const used = new Set(boardState.filter.map((condition) => condition.field));
      const condition = { field: Object.keys(FILTER_FIELDS).find((field) => !used.has(field)) || "col", op: "=", value: "" };
      boardState.filter.push(condition);
      boardFilterChanged({ condition, part: "field" });
    } else if (event.target.closest("[data-today]")) {
      boardState.filter = defaultFilter();
      boardFilterChanged();
      row.querySelector(".board-filter-today")?.focus();
    } else if (event.target.closest("[data-clear]")) {
      boardState.filter = [];
      boardFilterChanged();
      row.querySelector(".board-cond-add")?.focus();
    }
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
// Доска перечитывается по любому поводу, а сразу после открытия — ещё раз из
// общей загрузки. Если ответ тот же, перерисовка только сбила бы фокус, набранное
// в поле и перетаскивание, поэтому без перемен доска не трогается; force —
// когда экран нужно вернуть к данным, даже если те не менялись (отмена правки).
async function loadBoard({ force = false } = {}) {
  const wrap = $("#board-columns");
  if (!wrap.childNodes.length) wrap.append(node("p", "Собираем доску…", "empty"));
  try {
    const data = await request("/api/board");
    // «Сегодня» могли ещё не открывать: без даты дня сроки на доске выходили
    // бы ISO-строкой вместо «завтра» и «05.09».
    currentDayDate ||= data.today;
    const stamp = JSON.stringify(data);
    if (!force && stamp === boardState.stamp) return;
    boardState.stamp = stamp;
    boardState.data = data;
    renderBoard(data);
  } catch (error) {
    boardState.stamp = null;
    // Ошибка встаёт в ту ленту, что открыта: список и таблица живут в своей.
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
// клетками. Ниже список по дням — тот же, что во вкладке «Сделано» на «Сегодня», только за неделю. Клик по
// клетке или по дню в строке недели показывает список этого дня, повторный клик
// и «Все дни» возвращают неделю. Всё берётся из одного ответа GET /api/done —
// с понедельника четыре недели назад по сегодня; фраза, строка и чипы считаются
// на клиенте по последним семи дням. Страница помнит только выбранный день.
// Открывается из заголовка колонки «Сделано» на доске и по адресу #done.
const DONE_WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
function doneDayWord(date, today) {
  if (date === today) return "Сегодня";
  if (date === shiftDate(today, -1)) return "Вчера";
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
      toast("Возвращено в работу");
      load().catch(() => {});
      await loadDone();
      return;
    }
    const { entry } = await request(`/api/captures/${encodeURIComponent(item.id)}`);
    const closed = completableProjections(entry).filter((projection) => projection.completion?.completed);
    if (!closed.length) throw new Error("Это старая запись о сделанном: возвращать в работу нечего");
    for (const projection of closed) await request(`/api/projections/${projection.id}/undo-complete`, { method: "POST", body: "{}" });
    toast("Возвращено в работу");
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
  if (item.auto) mark.title = "Прошла по календарю";
  else if (!old) {
    mark.type = "button";
    mark.title = "Вернуть в работу";
    mark.setAttribute("aria-label", `Вернуть в работу: ${item.title}`);
    mark.addEventListener("click", () => reopenDoneItem(item, mark));
  }
  row.append(mark);
  if (item.auto) row.append(node("span", item.title, "entry-title"));
  else {
    const title = node("button", item.title, "entry-title");
    title.type = "button";
    title.addEventListener("click", () => {
      const list = row.closest(".done-days");
      pendingCardList = list ? { label: "Сделано", items: rowsAsList([...list.querySelectorAll(".entry[data-capture-id]")]), id: item.id, occurrence: null } : null;
      openReportEntry(item.id);
    });
    row.append(title);
  }
  const meta = node("div", undefined, "entry-meta");
  if (item.auto) meta.append(node("span", "прошла по календарю", "tag auto"));
  else if (item.column && !old) meta.append(node("span", item.column, "tag done-where"));
  meta.append(node("span", item.time, "tag time"));
  row.append(meta);
  return row;
}
const DONE_WEEKS = 5;
const DONE_MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
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
      const back = node("button", "Все дни", "done-all");
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
    list.append(shelf(isToday ? "Сегодня" : longDate(selected), items.length, { tone: isToday ? " today" : "", all: true }));
    if (items.length) list.append(rowsOf(items));
    else list.append(node("p", isToday ? "Пока ничего." : "В этот день ничего не сделано.", "empty"));
    return;
  }
  const from = shiftDate(today, -6);
  for (const day of data.days) {
    if (day.date < from || day.date > today || !day.items.length) continue;
    list.append(shelf(doneDayWord(day.date, today), day.items.length, { tone: day.date === today ? " today" : "" }), rowsOf(day.items));
  }
  if (!list.childNodes.length) list.append(node("p", "Пока ничего. Первый кружок — сюда.", "empty"));
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
  heading.append(node("h2", "Сделано"));
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
  line.append("За неделю сделано ", node("b", String(weekItems.length)), ", из них встреч ", node("b", String(meetings)), " · сегодня ", node("b", String(countOn(today)), "g"));

  const strip = node("div", undefined, "done-strip");
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "Последние семь дней");
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
  if (meetings) chip("Встречи", meetings, "done-chip meet");
  summary.append(line, strip, chips);

  const rhythm = node("div", undefined, "done-rhythm");
  const grid = node("div", undefined, "done-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `Ритм за ${DONE_WEEKS} недель`);
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
        cell.setAttribute("aria-label", `${longDate(date)} · ещё не наступил`);
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
  rhythm.append(node("p", `Ритм · ${DONE_WEEKS} недель`, "done-cap"), grid);

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
  if (!page.childNodes.length) page.append(node("p", "Считаем сделанное…", "empty"));
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
const CAL_DOW = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const CAL_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const CAL_MONTHS_G = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const CAL_PHONE = window.matchMedia("(max-width: 760px)");
const calState = { mode: "week", anchor: null, days: 7, data: null, hidden: new Set(), seq: 0, drag: null, pop: null, popAnchorId: null, scrollTop: null, gridScroll: null, search: "" };
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
  if (!wrap.childNodes.length) wrap.append(node("p", "Собираем календарь…", "empty"));
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
  // Круги встают в ту же полосу: нажатие вычёркивает круг из недели, как
  // вычёркивает чужой календарь. Это взгляд, а не решение — выключают круг
  // на его странице.
  for (const circle of todayState.circles || [])
    wrap.append(chip(`circle:${circle.id}`, circle.name, `var(--circle-${CIRCLE_TONES[circle.color] || "violet"})`, circle.muted ? "выключен" : null));
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
    box.title = item.recurring ? "Готово: убрать этот повтор, серия останется" : item.done ? "Вернуть в работу" : "Готово";
    if (item.kind === "meeting" && !item.done) box.innerHTML = BOARD_CLOCK;
    chip.append(box);
  } else if (item.color) chip.style.setProperty("--cal-c", item.color);
  chip.append(node("span", item.title, "cal-chip-title"));
  if (item.kind !== "external" && item.recurring) { const repeat = node("i", "⟳", "cal-chip-repeat"); repeat.title = item.repeat || "Повторяется"; chip.append(repeat); }
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
    box.title = item.recurring ? "Готово: убрать этот повтор, серия останется" : item.done ? "Вернуть в работу" : "Готово";
    box.setAttribute("aria-label", `${box.title}: ${item.title}`);
    box.draggable = false;
    if (item.kind === "meeting" && !item.done) box.innerHTML = BOARD_CLOCK;
    title.append(box);
  }
  title.append(node("span", `${item.time} `, "cal-ev-time"), document.createTextNode(item.title));
  element.append(title);
  const sub = item.kind === "external" ? item.calendarName || item.source : [item.project, ...(item.people || [])].filter(Boolean).join(" · ");
  if (sub) element.append(node("small", sub));
  // Повтор — значком в правом верхнем углу, как в Apple.
  if (item.repeat || item.recurring) { const repeat = node("i", "⟳", "cal-ev-repeat"); repeat.title = item.repeat || "Повторяется"; element.append(repeat); }
  if (item.joinUrl && height >= 34) {
    const join = node("a", "К звонку", "cal-join");
    join.href = item.joinUrl; join.target = "_blank"; join.rel = "noopener";
    join.title = `Открыть видеовстречу: ${popHost(item.joinUrl) || "ссылка"}`;
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
    const value = Number(localStorage.getItem(CAL_HEIGHT.key));
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
  if (stored) { wrap.style.setProperty("--cal-height", `${stored}px`); return; }
  const apply = (height) => wrap.style.setProperty("--cal-height", `${Math.round(Math.max(CAL_HEIGHT.min, height))}px`);
  // На телефоне сетка во весь экран забирала бы прокрутку страницы себе.
  if (window.matchMedia("(max-width: 760px)").matches) { apply(window.innerHeight * 0.6); return; }
  // Сетке достаётся окно за вычетом того, что над ней, и того, что под ней до
  // конца страницы: подсказки и нижних полей. Считается за один раз — сетка,
  // промежуточно выросшая на поля, сбила бы свою прокрутку и закрыла плашку.
  const grid = scroll.getBoundingClientRect();
  const below = document.body.getBoundingClientRect().bottom - grid.bottom;
  apply(window.innerHeight - (grid.top + window.scrollY) - below);
}
window.addEventListener("resize", () => { if (!$("#calendar")?.hidden) fitCalendarHeight(); });
function calResizeEl() {
  const grip = node("div", undefined, "cal-resize");
  grip.title = "Потяните, чтобы изменить высоту. Двойной клик — по высоте окна";
  grip.setAttribute("aria-hidden", "true");
  grip.addEventListener("dblclick", () => {
    try { localStorage.removeItem(CAL_HEIGHT.key); } catch {}
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
        try { localStorage.setItem(CAL_HEIGHT.key, String(height)); } catch {}
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
    const waiting = calAwaitingAnswer(item);
    const row = node("div", undefined, `cal-row ${item.kind}${item.done ? " done" : ""}${waiting ? " unanswered" : ""}`);
    row.append(node("time", item.time));
    const text = node("span", item.title, "cal-row-title");
    const meta = node("small", item.kind === "external" ? `${item.source}${waiting ? " · без ответа" : ""}` : `до ${calEndOf(item)}${item.project ? ` · ${item.project}` : ""}`);
    const body = node("span", undefined, "cal-row-body");
    body.append(text, meta);
    row.append(body);
    if (item.joinUrl) { const join = node("a", "К звонку", "cal-join"); join.href = item.joinUrl; join.target = "_blank"; join.rel = "noopener"; join.title = `Открыть видеовстречу: ${popHost(item.joinUrl) || "ссылка"}`; join.addEventListener("click", (event) => event.stopPropagation()); row.append(join); }
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
  hint.append(node("kbd", "D"), node("kbd", "W"), node("kbd", "M"), document.createTextNode(" виды · "), node("kbd", "T"), document.createTextNode(" сегодня · "), node("kbd", "←"), node("kbd", "→"), document.createTextNode(" листать · "), node("kbd", "1"), document.createTextNode("–"), node("kbd", "7"), document.createTextNode(" дней · тяните дела, встречи и чужие события, клик по пустому месту — новая запись"));
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
    pendingCardList = { label: "Календарь", items: own.map((candidate) => ({ id: candidate.id, occurrence: candidate.recurring ? candidate.date : null })), id: item.id, occurrence: item.recurring ? item.date : null };
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
          toast(series ? `Серия «${item.title}» удалена из ${item.source}` : `Удалено из ${item.source}`);
          // Сервер мог убрать больше нашего — у CalDAV одиночное событие
          // лежит файлом целиком, — поэтому сверяемся с ним.
          todayState.calendarStale = true;
          if (calState.data) loadCalendar();
          renderToday();
        })
        .catch((error) => {
          forget();
          toast(`«${item.title}» не удалилось: ${error.message}`);
          load().catch(() => {});
        });
    };
    // Повтор — выбор, как в Календаре macOS: только этот экземпляр или вся
    // серия. Выбор живёт в самой плашке, на месте кнопок.
    const askDeleteScope = () => {
      const ask = node("div", undefined, "cal-pop-ask");
      ask.append(node("p", `«${item.title}» повторяется. Удалить только этот повтор (${calHuman(item.date)}) или всю серию из календаря ${item.source}? Это не вернуть.`, "cal-pop-ask-text"));
      const row = node("div", undefined, "cal-pop-actions");
      row.append(calButton("Только это событие", "cal-pop-btn danger", () => erase("instance")), calButton("Всю серию", "cal-pop-btn danger", () => erase("series")), calButton("Отмена", "cal-pop-btn", () => ask.replaceWith(actions)));
      ask.append(row);
      actions.replaceWith(ask);
      calPopFit(pop);
    };
    actions.append(calButton("Удалить", "cal-pop-btn danger", () => {
      if (item.recurring) { askDeleteScope(); return; }
      if (!confirm(`Удалить «${item.title}» из календаря ${item.source}? Это не вернуть.`)) return;
      erase(null);
    }));
  }
  pop.append(actions);
  // Как в Календаре macOS: правка повтора касается только этого события,
  // удалить можно и его одного, и всю серию; ответ организатору — один на
  // всю серию.
  const note = !item.editable
    ? "Чужое событие не запись: его нет в поиске и отчётах, пока вы не возьмёте его в память."
    : item.recurring
      ? "Экземпляр повтора: название по клику и перенос мышкой меняют только этот повтор; «Удалить» спросит, убрать его одного или всю серию; ответ организатору — на всю серию."
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
  // Экземпляр своей серии: «готово» убирает его из серии, остальные остаются.
  if (item.recurring) { await doneOccurrence({ id: item.id, projectionId: item.projectionIds?.[0] || null }, item.date); return; }
  const ids = item.projectionIds || [];
  if (!ids.length) return;
  try {
    for (const projectionId of ids) await request(`/api/projections/${projectionId}/${item.done ? "undo-complete" : "complete"}`, { method: "POST", body: "{}" });
    await loadCalendar();
    if (item.done) toast("Снова в работе");
    else toast(`Готово: «${shortTitle(item.title)}»`, { label: "Вернуть", run: () => toggleCalendarDone({ ...item, done: true }) });
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
      const label = next.time ? `${calHuman(schedule.date)}, ${next.time}` : `${calHuman(schedule.date)}, без времени`;
      if (announce) toast(`Перенесена вся серия: ${label}`, { label: "Вернуть", run: () => moveCalendarItem({ ...item, date: schedule.date, time: next.time, end: next.end || null, baseDate: base }, { date: item.date, time: item.time, ...(item.end ? { end: item.end } : {}) }, { announce: false }) });
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
    const label = schedule.time ? `${calHuman(schedule.date)}, ${schedule.time}` : `${calHuman(schedule.date)}, без времени`;
    if (announce) toast(`Перенесено${item.kind === "external" ? ` в ${item.source}` : ""}: ${label}`, { label: "Вернуть", run: () => moveCalendarItem({ ...item, ...schedule }, before, { announce: false }) });
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
    if (announce && !wasLinked && telegramView?.link) toast("Telegram подключён");
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
const telegramBotLink = (bot) => (bot?.bot?.username ? telegramAnchor(bot.bot.username) : document.createTextNode("Кизуны"));
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
  if (!bot.configured) state.append("Бот ещё не заведён: создайте его у ", telegramAnchor("BotFather"), " командой /newbot и вставьте токен в «Ключах» выше.");
  else if (bot.state === "error") state.append(`Бот не на связи: ${bot.error || "Telegram не отвечает."}`);
  else if (link) {
    const who = `${link.name || "Telegram"}${link.username ? ` (@${link.username})` : ""}`;
    state.append(`Подключён ${who}. Пишите боту `, telegramBotLink(bot), " или пересылайте ему сообщения.");
  } else if (bot.state === "connecting") state.append("Бот выходит на связь…");
  else state.append("Бот ", telegramBotLink(bot), " на связи. Подключите свой Telegram — и пишите ему.");
  const linkButton = $("#telegram-link");
  linkButton.hidden = !bot.configured || Boolean(link);
  $("#telegram-unlink").hidden = !link;
  if (link || !bot.configured) {
    $("#telegram-connect").hidden = true;
    linkButton.textContent = "Подключить Telegram";
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
    button.textContent = "Новая ссылка";
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#telegram-unlink")?.addEventListener("click", async () => {
  try {
    paintTelegram(await request("/api/telegram/link", { method: "DELETE" }));
    toast("Telegram отключён");
  } catch (error) {
    toast(error.message);
  }
});

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
    // Автоотправка: свои дела со сроком сами уходят в выбранный
    // календарь и следуют за записью — перенос, «сделано», удаление. Это
    // разрешение даётся один раз здесь, а не на каждую запись.
    const auto = node("div", undefined, "calendar-account-auto");
    const autoMode = node("select");
    // Все записи — дела, поэтому «только встречи» новому выбору не предлагается:
    // оно остаётся в списке лишь у тех, у кого уже включено.
    const autoChoices = [["off", "Наружу — только кнопкой"], ["all", "Отправлять дела со сроком"]];
    if ((account.autoExport || "off") === "meetings") autoChoices.splice(1, 0, ["meetings", "Отправлять только встречи"]);
    for (const [value, text] of autoChoices) { const option = node("option", text); option.value = value; option.selected = (account.autoExport || "off") === value; autoMode.append(option); }
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
    auto.append(node("small", (account.autoExport || "off") === "off" ? "Дела уходят в календарь только кнопкой «В календарь» в карточке." : "Уходят сами и следуют за записью: перенос, конец, удаление. Сдвинули событие в календаре — срок записи подвинется тоже.", "setting-hint"));
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
      const summary = node("summary", "В календарь");
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

// ── уведомления ──────────────────────────────────────────────────────────────
// Колокольчик в шапке хранит историю: что случилось, пока вас не было. Число на
// нём — только то, что ждёт вашего ответа (просьба, приглашение), остальное
// непрочитанное — тихой точкой: колокольчик сообщает, а не подгоняет. Полоса
// «к вам» на «Сегодня» показывает то же ждущее, поэтому ответ в одном месте
// гасит строку в обоих.
const NOTIFY_FILTERS = [["all", "Все"], ["waits", "Ждут ответа"], ["people", "Люди"], ["time", "Сроки и встречи"], ["other", "Остальное"]];
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
const notifyDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TODAY_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const notifyClock = (iso) => new Intl.DateTimeFormat("ru-RU", { timeZone: TODAY_ZONE, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
function notifyTime(iso) {
  const today = currentDayDate || notifyDay(new Date().toISOString());
  const day = notifyDay(iso);
  if (day === today) return notifyClock(iso);
  if (day === shiftDate(today, -1)) return `вчера, ${notifyClock(iso)}`;
  return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
}
function notifyPeople(actors) {
  const names = actors.map((person) => person.name);
  if (names.length <= 2) return names.join(" и ");
  return `${names.slice(0, 2).join(", ")} и ещё ${names.length - 2}`;
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
  summary.setAttribute("aria-label", waits ? `Уведомления: ждут ответа — ${waits}` : unread ? "Уведомления: есть непрочитанные" : "Уведомления");
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
  if (item.kind === "chatter" && item.count > 1) meta.append(node("span", `${item.count} ${pluralRu(item.count, "сообщение", "сообщения", "сообщений")}`));
  for (const piece of item.meta || []) meta.append(node("span", piece));
  if (item.data?.circle) meta.append(circleChip(item.data.circle, { small: true }));
  return meta;
}
// Срок «Отложить» словами: «30 минут», «час», «2 часа», «сутки».
function snoozeWords(minutes) {
  if (minutes >= 24 * 60) return "сутки";
  if (minutes % 60) return `${minutes} ${pluralRu(minutes, "минуту", "минуты", "минут")}`;
  const hours = minutes / 60;
  return hours === 1 ? "час" : `${hours} ${pluralRu(hours, "час", "часа", "часов")}`;
}
function notifyButton(label, primary, run, { ok = false } = {}) {
  const button = node("button", label, `bell-act${primary ? " primary" : ""}${ok ? " ok" : ""}`);
  button.type = "button";
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try { await run(); } catch (error) { toast(error.message || "Не получилось"); button.disabled = false; }
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
      notifyButton("Беру", true, async () => { await request(`/api/assignments/${item.assignmentId}/respond`, { method: "POST", body: JSON.stringify({ take: true }) }); done("Взято — дело в вашем дне"); load().catch(() => {}); }),
      notifyButton("Не я", false, async () => {
        const reason = (prompt("Почему не вы? Можно не отвечать — причина уйдёт автору.") ?? "").trim();
        await request(`/api/assignments/${item.assignmentId}/respond`, { method: "POST", body: JSON.stringify({ take: false, ...(reason ? { reason } : {}) }) });
        done("Вернули автору"); load().catch(() => {});
      }),
    );
  } else if (item.kind === "invite" && item.waits) {
    acts.append(
      notifyButton("Приму", true, async () => { await answerInvite(item, "accepted"); done("Принято — встреча в календаре"); }),
      notifyButton("Не смогу", false, async () => { await answerInvite(item, "declined"); done("Организатор узнает, что вас не будет"); }),
    );
  } else if (item.kind === "reminder") {
    // Дело из напоминания закрывается прямо в строке — открывать карточку ради
    // одного кружка незачем. Вместе с делом из ленты уходят его напоминания.
    if (item.captureId && (item.meta || []).includes("дело"))
      acts.append(notifyButton("Готово", true, async () => { await completeFromNotification(item); done("Готово — дело закрыто", { close: !inPanel }); }, { ok: true }));
    if (item.data?.startAt ? Date.parse(item.data.startAt) > Date.now() : notifyDay(item.updatedAt) === currentDayDate) {
      if (item.data?.joinUrl) acts.append(notifyButton("К звонку", true, async () => { window.open(item.data.joinUrl, "_blank", "noopener"); done("Звонок открыт в новой вкладке"); }));
      // Отложить: первый раз на полчаса, каждый следующий вдвое дольше — срок
      // считает сервер. Встреча возвращается не позже начала, и кнопка так и
      // говорит.
      const snooze = item.snoozeMinutes || 30;
      const toStart = item.data?.startAt && Date.parse(item.data.startAt) - Date.now() < snooze * 60000;
      acts.append(notifyButton(toStart ? "Напомнить к началу" : `Через ${snoozeWords(snooze)}`, false, async () => {
        const result = await request(`/api/notifications/${item.id}/snooze`, { method: "POST", body: JSON.stringify({}) });
        done(`Напомню в ${notifyClock(result.snoozedUntil)}`);
      }));
    }
  } else if (item.kind === "call" || item.kind === "reply") {
    acts.append(notifyButton("Ответить", false, async () => { after(); openNotification(item); }));
  } else if (item.kind === "clarify" && !item.resolved) {
    acts.append(notifyButton("Уточнить", false, async () => { after(); openNotification(item); }));
  } else if (item.kind === "calendar_error" && !item.resolved) {
    acts.append(notifyButton("Переподключить", false, async () => { after(); openNotification(item); }));
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
  if (!projections.length) throw new Error("Это дело уже закрыто");
  for (const projection of projections)
    await request(`/api/projections/${projection.id}/complete`, { method: "POST", body: "{}" });
  toast(`Готово: «${shortTitle(titleOf(entry))}»`, { label: "Вернуть", run: async () => {
    try {
      for (const projection of projections) await request(`/api/projections/${projection.id}/undo-complete`, { method: "POST", body: "{}" });
      toast("Снова в работе");
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
    if (announce) toast(announce, { label: "Вернуть", run: () => restoreNotifications(result.dismissed) });
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
      try { await run(); } catch (error) { toast(error.message || "Не получилось"); }
    });
    menu.append(button);
  };
  if (!item.waits) entry("Убрать из ленты", null, () => dismissNotifications([item.id], { announce: "Убрано из ленты" }));
  if (item.kind === "reminder" && item.captureId) entry("Не напоминать об этом деле", "срок остаётся, напоминаний больше не будет", () => muteReminder(item));
  if (["event_added", "event_changed"].includes(item.kind) && item.accountId) {
    const account = calendarAccountLabel(item.accountId);
    entry(account ? `Не сообщать об изменениях в «${account}»` : "Не сообщать об изменениях в этом календаре", "календарь в Кизуне остаётся", () => muteCalendarChanges(item, account));
  }
  const kind = bellState.kinds.find((candidate) => candidate.key === item.kind);
  if (kind) entry("Выключить такие", `«${kind.label}» — вернуть можно в настройках`, () => turnOffKind(item, kind));
  return menu;
}
function calendarAccountLabel(accountId) {
  const accounts = [...(todayState.calendar?.accounts || []), ...(calState.data?.accounts || []), ...(calendarAccountsState.accounts || [])];
  return accounts.find((account) => account.id === accountId)?.label || null;
}
async function muteReminder(item) {
  const { entry } = await request(`/api/captures/${item.captureId}`);
  const schedule = scheduleOf(entry);
  if (!schedule?.date) throw new Error("У дела уже нет срока");
  const patch = (remind) => ({ patch: { schedule: { date: schedule.date, time: schedule.time || null, ...(schedule.time && schedule.end ? { end: schedule.end } : {}), remind } } });
  await request(`/api/captures/${entry.id}/corrections`, { method: "POST", body: JSON.stringify(patch("off")) });
  await dismissNotifications([item.id]);
  toast("Об этом деле больше не напомню", { label: "Вернуть", run: async () => {
    try { await request(`/api/captures/${entry.id}/corrections`, { method: "POST", body: JSON.stringify(patch(schedule.remind ?? null)) }); }
    catch (error) { toast(error.message); }
    await restoreNotifications([item.id]);
  } });
  load().catch(() => {});
}
async function saveMutedCalendars(list) {
  const value = JSON.stringify([...new Set(list)]);
  paintSettings(await request("/api/settings", { method: "PUT", body: JSON.stringify({ notifyMutedCalendars: value }) }));
}
function mutedCalendarsNow() {
  try { const parsed = JSON.parse(appSettings.notifyMutedCalendars || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
async function muteCalendarChanges(item, label) {
  const before = mutedCalendarsNow();
  await saveMutedCalendars([...before, item.accountId]);
  await dismissNotifications([item.id]);
  toast(label ? `«${label}» — без уведомлений об изменениях` : "Об изменениях в этом календаре — молчу", { label: "Вернуть", run: async () => {
    try { await saveMutedCalendars(before); } catch (error) { toast(error.message); }
    await restoreNotifications([item.id]);
  } });
}
async function turnOffKind(item, kind) {
  const prefs = notifyPrefsNow();
  const before = ["off", "bell", "phone"].includes(prefs[kind.key]) ? prefs[kind.key] : kind.default;
  setNotifyMode(kind, "off");
  await dismissNotifications([item.id]);
  toast(`«${kind.label}» — выключено`, { label: "Вернуть", run: async () => { setNotifyMode(kind, before); await restoreNotifications([item.id]); } });
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
    box.append(node("p", meetings.length ? `Встречи · ${meetings.length}` : "Встреч сегодня нет", "bell-digest-head"));
    for (const meeting of meetings) {
      const row = node("button", undefined, "bell-digest-row");
      row.type = "button";
      const state = minutes >= meeting.end ? "прошла" : minutes >= meeting.start ? "идёт" : meeting.start - minutes <= 90 ? `через ${meeting.start - minutes} мин` : "";
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
    box.append(node("p", deals.length ? `Дела на сегодня · ${deals.length}` : "Дел на сегодня нет", "bell-digest-head"));
    for (const entry of deals) {
      const closed = isClosed(entry);
      const row = node("div", undefined, `bell-digest-row deal${closed ? " done" : ""}`);
      const tick = node("button", undefined, `completion-button${closed ? " is-done" : ""}`);
      tick.type = "button";
      tick.title = closed ? "Вернуть в работу" : "Готово";
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
      box.append(row);
    }
  }
  const day = node("button", "Открыть «День» →", "bell-digest-link");
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
    const toggle = node("button", open ? "Свернуть" : "Показать встречи и дела", `bell-digest-toggle${open ? " open" : ""}`);
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
  mute.title = "Заглушить";
  mute.setAttribute("aria-label", `Заглушить: ${[item.lead, item.text].filter(Boolean).join(" ")}`);
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
  head.append(node("h3", "Уведомления"));
  // «Очистить» — всё, что не ждёт ответа: лента для неразобранного, а не архив.
  const clearAll = node("button", "Очистить", "linklike bell-read-all");
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
      if (result.dismissed.length) toast("Лента очищена", { label: "Вернуть", run: () => restoreNotifications(result.dismissed) });
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
  group("Ждут ответа", pinned, " waits");
  group("Сегодня", rest.filter((item) => notifyDay(item.updatedAt) === today));
  group("Вчера", rest.filter((item) => notifyDay(item.updatedAt) === yesterday));
  group("Раньше", rest.filter((item) => notifyDay(item.updatedAt) < yesterday));
  if (!list.childNodes.length) list.append(node("p", bellState.filter === "all" ? "Всё разобрано. Новое появится здесь." : "По этому поводу ничего нет.", "bell-empty"));
  const foot = node("div", undefined, "bell-foot");
  const settings = node("a", "Настройки уведомлений →");
  settings.href = "#settings";
  settings.addEventListener("click", () => { $("#bell-menu")?.removeAttribute("open"); setTimeout(() => $("#notify-settings")?.scrollIntoView({ block: "start" }), 60); });
  foot.append(node("span", "Открытое уходит из ленты"), settings);
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
  const hash = { signup: "#admin", spend: "#settings", calendar_error: "#settings", digest: "#today" }[item.kind];
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
  close.setAttribute("aria-label", "Скрыть");
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
      try { await answerInvite(item, status); toast(status === "accepted" ? "Принято — встреча в календаре" : "Организатор узнает, что вас не будет"); await loadNotifications(); }
      catch (error) { button.disabled = false; toast(error.message || "Не получилось ответить"); }
    });
    return button;
  };
  acts.append(answer("Приму", "inbox-take", "accepted"), answer("Не смогу", "inbox-not", "declined"));
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
  cols.append(node("span", "Повод"), node("span", "Колокольчик"), node("span", "Телефон"));
  table.append(cols);
  const titles = { people: "Люди и круги", time: "Сроки и встречи", other: "Записи и служебное" };
  for (const group of ["people", "time", "other"]) {
    const kinds = bellState.kinds.filter((kind) => kind.group === group);
    if (!kinds.length) continue;
    table.append(node("p", titles[group], "notify-group"));
    for (const kind of kinds) {
      const mode = ["off", "bell", "phone"].includes(prefs[kind.key]) ? prefs[kind.key] : kind.default;
      const row = node("div", undefined, "notify-row");
      const name = node("span", undefined, "notify-name");
      name.append(document.createTextNode(kind.label));
      if (kind.hint) name.append(node("span", kind.hint, "notify-hint"));
      row.append(
        name,
        notifySwitch(`notify-bell-${kind.key}`, `${kind.label}: колокольчик`, mode !== "off", false, (on) => setNotifyMode(kind, on ? "bell" : "off")),
        notifySwitch(`notify-phone-${kind.key}`, `${kind.label}: телефон`, mode === "phone", mode === "off", (on) => setNotifyMode(kind, on ? "phone" : "bell")),
      );
      table.append(row);
    }
  }
  // Заглушённые из колокольчика календари: здесь их возвращают.
  const muted = mutedCalendarsNow();
  if (muted.length) {
    const line = node("p", "Об изменениях встреч молчат:", "notify-muted");
    for (const accountId of muted) {
      const chip = node("button", `${calendarAccountLabel(accountId) || "календарь"} ✕`);
      chip.type = "button";
      chip.title = "Снова сообщать об изменениях";
      chip.addEventListener("click", async () => {
        try { await saveMutedCalendars(mutedCalendarsNow().filter((id) => id !== accountId)); toast("Об изменениях снова сообщу"); }
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
