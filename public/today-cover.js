// Обложка «Сегодня»: страница знает, который час. Здесь — чистая логика без
// DOM: фаза суток по порогам, бриф из двух-трёх предложений по данным дня и
// вопрос в поле по фазе. Слова собираются шаблонами, а не
// моделью: мгновенно и предсказуемо. Модельный «Бриф» остаётся отдельной
// страницей.

// Пороги в минутах от полуночи: начало дня, конец утра, начало вечера, конец
// дня. Ночь — до начала дня и после конца.
export const DEFAULT_THRESHOLDS = { dayStart: 8 * 60, morningEnd: 11 * 60, eveningStart: 18 * 60, dayEnd: 22 * 60 };

export const PHASE_NAMES = { morning: "утро", day: "день", evening: "вечер", night: "ночь", weekend: "выходной" };

export function phaseOf({ minutes, weekend = false, thresholds = DEFAULT_THRESHOLDS }) {
  if (weekend) return "weekend";
  if (minutes < thresholds.dayStart || minutes >= thresholds.dayEnd) return "night";
  if (minutes < thresholds.morningEnd) return "morning";
  if (minutes >= thresholds.eveningStart) return "evening";
  return "day";
}

// «1 встреча», «2 встречи», «5 встреч» — по правилам русского языка.
export function plural(count, [one, few, many]) {
  const n = Math.abs(count) % 100, n10 = n % 10;
  const word = n > 10 && n < 20 ? many : n10 === 1 ? one : n10 >= 2 && n10 <= 4 ? few : many;
  return `${count} ${word}`;
}
export const MEETINGS = ["встреча", "встречи", "встреч"];
export const DEALS = ["дело", "дела", "дел"];

export const hm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const duration = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `${minutes} мин`);
export const minutesOf = (time) => {
  if (!time) return null;
  const [hours, minutes] = String(time).split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
};
const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);

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
  defaultPlaceholder = "Что нужно сделать?",
}) {
  const sorted = [...meetings].sort((a, b) => a.start - b.start);
  const running = sorted.find((meeting) => minutes >= meeting.start && minutes < meeting.end) || null;
  const next = sorted.find((meeting) => meeting.start > minutes) || null;
  const soon = next && next.start - minutes <= 10 ? next : null;
  const focus = running || soon;
  const after = focus ? sorted.find((meeting) => meeting.start >= focus.end) || null : next;
  const past = sorted.filter((meeting) => minutes >= meeting.end).length;
  const join = (meeting) => (meeting.joinUrl && (meeting === running || meeting === soon) ? [" — ", { a: { text: "присоединиться", href: meeting.joinUrl } }] : []);

  const taskSentence = () => {
    const late = tasks.late || 0;
    const parts = [late ? `${late} ${late % 10 === 1 && late % 100 !== 11 ? "дело просрочено" : late % 10 >= 2 && late % 10 <= 4 && (late % 100 < 10 || late % 100 >= 20) ? "дела просрочены" : "дел просрочено"}` : "Просроченных дел нет"];
    if (tasks.todayTitle) parts.push(", на сегодня — ", { b: lower(tasks.todayTitle) });
    parts.push(".");
    return parts;
  };
  const nextSentence = () => {
    if (!after) return focus ? [] : calendar && sorted.length ? [`Встреч больше нет${past ? `, прошло ${past}` : ""}.`] : [];
    const gap = focus ? after.start - focus.end : after.start - minutes;
    const rest = sorted.filter((meeting) => meeting.start > after.start).length;
    const parts = [gap >= 15 ? `${focus ? "Потом свободно" : "Свободно"} ${duration(gap)}, в ${hm(after.start)} ` : `В ${hm(after.start)} `, { b: after.title }];
    if (rest) parts.push(`, потом ещё ${plural(rest, MEETINGS)}`);
    parts.push(".");
    return parts;
  };
  const space = (parts) => (parts.length ? [" ", ...parts] : []);

  let brief = [], placeholder = defaultPlaceholder, tab = "day";
  if (phase === "weekend") {
    brief.push("Выходной");
    if (calendar) {
      if (running) brief.push(". Идёт ", { b: running.title });
      else if (sorted.length) brief.push(`. Сегодня в ${hm(sorted[0].start)} — `, { b: sorted[0].title });
      else brief.push(", встреч нет");
    }
    brief.push(".");
    brief.push(tasks.late ? ` ${plural(tasks.late, DEALS)} просрочено — подождут понедельника.` : " Просроченных дел нет.");
    placeholder = "О чём думаете?";
  } else if (phase === "night") {
    if (minutes < thresholds.dayStart) {
      brief.push("Рано. ");
      if (!calendar) brief.push("Календарь не подключён.");
      else if (next) brief.push(`Сегодня ${plural(sorted.length, MEETINGS)}, первая в ${hm(next.start)} — `, { b: next.title }, ".");
      else brief.push("Встреч сегодня нет.");
      brief.push(...space(taskSentence()));
      tab = "day";
    } else {
      brief.push(`День закончился${doneCount ? `: закрыто ${doneCount}` : ""}.`);
      if (calendar) {
        if (tomorrow?.count && tomorrow.first) brief.push(` Завтра ${plural(tomorrow.count, MEETINGS)}, первая в ${hm(tomorrow.first.start)} — `, { b: tomorrow.first.title }, ".");
        else brief.push(" Завтра встреч нет.");
      }
      tab = "journal";
    }
    placeholder = "Запишите и отпустите";
  } else if (phase === "morning") {
    brief.push("Доброе утро. ");
    if (!calendar) brief.push("Календарь не подключён.");
    else if (running) brief.push("Идёт ", { b: running.title }, `, до ${hm(running.end)}`, ...join(running), `. Всего ${plural(sorted.length, MEETINGS)}.`);
    else if (next) brief.push(`${past ? "Ближайшая" : "Первая"} встреча в ${hm(next.start)} — `, { b: next.title }, `, всего ${plural(sorted.length, MEETINGS)}.`);
    else brief.push("Встреч сегодня нет.");
    brief.push(...space(taskSentence()));
    placeholder = "С чего начнёте день?";
  } else if (phase === "evening") {
    brief.push(`Закрыто ${doneCount}${calendar ? `, встреч прошло ${past}` : ""}`);
    if (next) brief.push(`, ещё в ${hm(next.start)} `, { b: next.title });
    brief.push(".");
    // Вечером не закрыто всё со сроком сегодня и раньше (unfinished; без него —
    // просроченное), и это можно тут же перенести. Важно и открытое без срока.
    const unfinished = tasks.unfinished ?? tasks.late;
    if (unfinished) brief.push(" Не закрыто ", { btn: { text: plural(unfinished, DEALS), act: "show" } }, " со сроком — ", { btn: { text: "перенести на завтра?", act: "postpone" } });
    else if (tasks.open) brief.push(` Открыто ${plural(tasks.open, DEALS)} без срока.`);
    else brief.push(" Все дела закрыты.");
    if (calendar && tomorrow?.first) brief.push(` Завтра первая встреча в ${hm(tomorrow.first.start)}.`);
    placeholder = "Чем закончился день?";
    tab = "journal";
  } else {
    if (!calendar) brief.push("Календарь не подключён — встреч не вижу.");
    else if (running) brief.push("Идёт ", { b: running.title }, `, до ${hm(running.end)}`, ...join(running), ".");
    else if (soon) brief.push(`Через ${soon.start - minutes} мин `, { b: soon.title }, ...join(soon), ".");
    if (calendar) brief.push(...(brief.length ? space(nextSentence()) : nextSentence()));
    brief.push(...(brief.length ? space(taskSentence()) : taskSentence()));
  }
  return { phase, brief, placeholder, tab, running, next: after };
}

export const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
export const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
export const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// Даты приходят строками YYYY-MM-DD; полдень по UTC не даёт часовому поясу
// сдвинуть день.
export const dateParts = (date) => { const at = new Date(`${date}T12:00:00Z`); return { weekday: at.getUTCDay(), day: at.getUTCDate(), month: at.getUTCMonth() }; };
export const longDate = (date) => { const { weekday, day, month } = dateParts(date); return `${WEEKDAYS[weekday]}, ${day} ${MONTHS[month]}`; };
export const shortDate = (date) => { const { weekday, day } = dateParts(date); return `${WEEKDAYS_SHORT[weekday]} ${day}`; };
export const isWeekend = (date) => [0, 6].includes(dateParts(date).weekday);
