import { t, getLocale, localizedBuiltins } from "./browser-i18n.js";
// Обложка «Сегодня»: страница знает, который час. Здесь — чистая логика без
// DOM: фаза суток по порогам, бриф из двух-трёх предложений по данным дня и
// вопрос в поле по фазе. Слова собираются шаблонами, а не
// моделью: мгновенно и предсказуемо. Модельный «Бриф» остаётся отдельной
// страницей.

// Пороги в минутах от полуночи: начало дня, конец утра, начало вечера, конец
// дня. Ночь — до начала дня и после конца.
export const DEFAULT_THRESHOLDS = { dayStart: 8 * 60, morningEnd: 11 * 60, eveningStart: 18 * 60, dayEnd: 22 * 60 };

export const PHASE_NAMES = { get morning() { return t("утро"); }, get day() { return t("день"); }, get evening() { return t("вечер"); }, get night() { return t("ночь"); }, get weekend() { return t("выходной"); } };

export function phaseOf({ minutes, weekend = false, thresholds = DEFAULT_THRESHOLDS }) {
  if (weekend) return "weekend";
  if (minutes < thresholds.dayStart || minutes >= thresholds.dayEnd) return "night";
  if (minutes < thresholds.morningEnd) return "morning";
  if (minutes >= thresholds.eveningStart) return "evening";
  return "day";
}

// «1 встреча», «2 встречи», «5 встреч» — по правилам русского языка.
export function plural(count, [one, few, many]) {
  const russianCategory = new Intl.PluralRules("ru").select(count);
  const fallbackWord = russianCategory === "one" ? one : russianCategory === "few" ? few : many;
  if (getLocale() === "ru") return `${count} ${fallbackWord}`;
  return t(`{count} ${one}`, { count });
}
export const MEETINGS = ["встреча", "встречи", "встреч"];
export const DEALS = ["дело", "дела", "дел"];

export const hm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const duration = (minutes) => minutes >= 60
  ? minutes % 60 ? t("{hours} ч {minutes} мин", { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t("{hours} ч", { hours: Math.floor(minutes / 60) })
  : t("{minutes} мин", { minutes });
export const minutesOf = (time) => {
  if (!time) return null;
  const [hours, minutes] = String(time).split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
};
const lower = (text) => getLocale() === "ru" ? text.charAt(0).toLowerCase() + text.slice(1) : text;

// Бриф — массив кусков: строка, {b: текст}, {a: {text, href}} или
// {btn: {text, act}} — кнопка-ссылка: что она делает, решает страница по act
// («show» показывает дела, о которых речь, «postpone» переносит их на завтра).
// В DOM это уходит узлами, а не HTML: названия встреч и дел — чужой текст.
export function coverFor({
  phase,
  minutes,
  meetings = [],          // сегодняшние встречи по часам: {title, start, end, joinUrl, busy, hasOutcome}
  tasks = { late: 0, unfinished: 0, today: 0, open: 0, todayTitle: null },
  doneCount = 0,
  tomorrow = null,        // {count, first: {start, title}} | null
  calendar = false,       // подключён ли календарь
  thresholds = DEFAULT_THRESHOLDS,
  defaultPlaceholder = t("Что нужно сделать?"),
}) {
  const sorted = [...meetings].sort((a, b) => a.start - b.start);
  const running = sorted.find((meeting) => minutes >= meeting.start && minutes < meeting.end) || null;
  const next = sorted.find((meeting) => meeting.start > minutes) || null;
  const soon = next && next.start - minutes <= 10 ? next : null;
  const focus = running || soon;
  const after = focus ? sorted.find((meeting) => meeting.start >= focus.end) || null : next;
  const past = sorted.filter((meeting) => minutes >= meeting.end).length;
  const join = (meeting) => (meeting.joinUrl && (meeting === running || meeting === soon) ? [" — ", { a: { get text() { return t("присоединиться"); }, href: meeting.joinUrl } }] : []);

  const taskSentence = () => {
    const late = tasks.late || 0;
    const category = new Intl.PluralRules("ru").select(late);
    const lateWords = category === "one" ? "дело просрочено" : category === "few" ? "дела просрочены" : "дел просрочено";
    const parts = [late ? getLocale() === "ru" ? `${late} ${lateWords}` : t("{count} дело просрочено", { count: late }) : t("Просроченных дел нет")];
    if (tasks.todayTitle) parts.push(t(", на сегодня — "), { b: lower(tasks.todayTitle) });
    parts.push(".");
    return parts;
  };
  const nextSentence = () => {
    if (!after) return focus ? [] : calendar && sorted.length ? [t("Встреч больше нет{value1}.", { value1: past ? t(", прошло {value1}", { value1: past }) : "" })] : [];
    const gap = focus ? after.start - focus.end : after.start - minutes;
    const rest = sorted.filter((meeting) => meeting.start > after.start).length;
    const parts = [gap >= 15 ? t("{value1} {value2}, в {value3} ", { value1: focus ? t("Потом свободно") : t("Свободно"), value2: duration(gap), value3: hm(after.start) }) : t("В {value1} ", { value1: hm(after.start) }), { b: after.title }];
    if (rest) parts.push(t(", потом ещё {value1}", { value1: plural(rest, MEETINGS) }));
    parts.push(".");
    return parts;
  };
  const space = (parts) => (parts.length ? [" ", ...parts] : []);

  let brief = [], placeholder = defaultPlaceholder, tab = "day";
  if (phase === "weekend") {
    brief.push(t("Выходной"));
    if (calendar) {
      if (running) brief.push(t(". Идёт "), { b: running.title });
      else if (sorted.length) brief.push(t(". Сегодня в {value1} — ", { value1: hm(sorted[0].start) }), { b: sorted[0].title });
      else brief.push(t(", встреч нет"));
    }
    brief.push(".");
    brief.push(tasks.late ? t(" {value1} просрочено — подождут понедельника.", { value1: plural(tasks.late, DEALS) }) : t(" Просроченных дел нет."));
    placeholder = t("О чём думаете?");
  } else if (phase === "night") {
    if (minutes < thresholds.dayStart) {
      brief.push(t("Рано. "));
      if (!calendar) brief.push(t("Календарь не подключён."));
      else if (next) brief.push(t("Сегодня {value1}, первая в {value2} — ", { value1: plural(sorted.length, MEETINGS), value2: hm(next.start) }), { b: next.title }, ".");
      else brief.push(t("Встреч сегодня нет."));
      brief.push(...space(taskSentence()));
      tab = "day";
    } else {
      brief.push(t("День закончился{value1}.", { value1: doneCount ? t(": закрыто {value1}", { value1: doneCount }) : "" }));
      if (calendar) {
        if (tomorrow?.count && tomorrow.first) brief.push(t(" Завтра {value1}, первая в {value2} — ", { value1: plural(tomorrow.count, MEETINGS), value2: hm(tomorrow.first.start) }), { b: tomorrow.first.title }, ".");
        else brief.push(t(" Завтра встреч нет."));
      }
      tab = "journal";
    }
    placeholder = t("Запишите и отпустите");
  } else if (phase === "morning") {
    brief.push(t("Доброе утро. "));
    if (!calendar) brief.push(t("Календарь не подключён."));
    else if (running) brief.push(t("Идёт "), { b: running.title }, t(", до {value1}", { value1: hm(running.end) }), ...join(running), t(". Всего {value1}.", { value1: plural(sorted.length, MEETINGS) }));
    else if (next) brief.push(t("{value1} встреча в {value2} — ", { value1: past ? t("Ближайшая") : t("Первая"), value2: hm(next.start) }), { b: next.title }, t(", всего {value1}.", { value1: plural(sorted.length, MEETINGS) }));
    else brief.push(t("Встреч сегодня нет."));
    brief.push(...space(taskSentence()));
    placeholder = t("С чего начнёте день?");
  } else if (phase === "evening") {
    brief.push(t("Закрыто {doneCount}{value2}", { doneCount: doneCount, value2: calendar ? t(", встреч прошло {value1}", { value1: past }) : "" }));
    if (next) brief.push(t(", ещё в {value1} ", { value1: hm(next.start) }), { b: next.title });
    brief.push(".");
    // Вечером не закрыто всё со сроком сегодня и раньше (unfinished; без него —
    // просроченное), и это можно тут же перенести. Важно и открытое без срока.
    const unfinished = tasks.unfinished ?? tasks.late;
    if (unfinished) brief.push(t(" Не закрыто "), { btn: { text: plural(unfinished, DEALS), act: "show" } }, t(" со сроком — "), { btn: { get text() { return t("перенести на завтра?"); }, act: "postpone" } });
    else if (tasks.open) brief.push(t(" Открыто {value1} без срока.", { value1: plural(tasks.open, DEALS) }));
    else brief.push(t(" Все дела закрыты."));
    if (calendar && tomorrow?.first) brief.push(t(" Завтра первая встреча в {value1}.", { value1: hm(tomorrow.first.start) }));
    placeholder = t("Чем закончился день?");
    tab = "journal";
  } else {
    if (!calendar) brief.push(t("Календарь не подключён — встреч не вижу."));
    else if (running) brief.push(t("Идёт "), { b: running.title }, t(", до {value1}", { value1: hm(running.end) }), ...join(running), ".");
    else if (soon) brief.push(t("Через {value1} мин ", { value1: soon.start - minutes }), { b: soon.title }, ...join(soon), ".");
    if (calendar) brief.push(...(brief.length ? space(nextSentence()) : nextSentence()));
    brief.push(...(brief.length ? space(taskSentence()) : taskSentence()));
  }
  return { phase, brief, placeholder, tab, running, next: after };
}

export const WEEKDAYS = localizedBuiltins(["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"]);
export const WEEKDAYS_SHORT = localizedBuiltins(["вс", "пн", "вт", "ср", "чт", "пт", "сб"]);
export const MONTHS = localizedBuiltins(["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]);
// Даты приходят строками YYYY-MM-DD; полдень по UTC не даёт часовому поясу
// сдвинуть день.
export const dateParts = (date) => { const at = new Date(`${date}T12:00:00Z`); return { weekday: at.getUTCDay(), day: at.getUTCDate(), month: at.getUTCMonth() }; };
export const longDate = (date) => { const at = new Date(`${date}T12:00:00Z`); const label = new Intl.DateTimeFormat(getLocale(), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(at); return getLocale() === "ru" ? label.charAt(0).toUpperCase() + label.slice(1) : label; };
export const shortDate = (date) => { const label = new Intl.DateTimeFormat(getLocale(), { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`)); return getLocale() === "ru" ? label.replace(",", "") : label; };
export const isWeekend = (date) => [0, 6].includes(dateParts(date).weekday);
