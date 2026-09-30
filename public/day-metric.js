// «Метрика дня»: числа пилюли на «Сегодня» и «Доске» — чистая логика без DOM.
// Числа дня не считаются заново: страница отдаёт сюда те, что уже показывают
// вкладка «День», вкладка «Закрыто» и бейджи дока, — пилюля и вкладки говорят
// одно и то же. Тридцать дней истории (счёт закрытого по дням из
// /api/done?only=byDay) нужны только серии, неделе и искре.
import { plural, DEALS } from "./today-cover.js";

export const METRIC_KINDS = ["planned", "done", "left", "late", "streak", "week"];
export const DAYS = ["день", "дня", "дней"];
// Искра — последние семь дней, считая сегодня.
export const SPARK_DAYS = 7;

// Даты — строки YYYY-MM-DD; полдень по UTC не даёт поясу сдвинуть день.
export function addDays(date, days) {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// open — открытые дела на сегодня без просрочки, late — просроченные, done —
// закрытое сегодня, byDay — [{date, n}] по возрастанию дат, окно истории
// (последняя дата — сегодня; null — история ещё не пришла). Сегодняшний день
// из byDay не берётся: там живое число done, чтобы после кружка всё менялось
// сразу, не дожидаясь ответа сервера.
export function dayMetric({ open = 0, late = 0, done = 0, byDay = null, today }) {
  const counts = new Map((byDay || []).map((row) => [row.date, row.n]));
  counts.set(today, done);
  const first = byDay?.length ? byDay[0].date : null;
  const spark = Array.from({ length: SPARK_DAYS }, (_, index) => counts.get(addDays(today, index - (SPARK_DAYS - 1))) || 0);
  // Серия: назад от сегодня, если сегодня уже есть закрытое, иначе от вчера —
  // день без закрытого ещё можно закрыть, и серия до этого не обрывается.
  // Упёрлась в начало окна — настоящая длина неизвестна: capped, «30+».
  let day = done > 0 ? today : addDays(today, -1);
  let streak = 0;
  let capped = false;
  while ((counts.get(day) || 0) > 0) {
    streak += 1;
    if (first !== null && day <= first) { capped = true; break; }
    day = addDays(day, -1);
  }
  return {
    planned: open + late + done,
    done,
    left: open + late,
    late,
    week: spark.reduce((sum, n) => sum + n, 0),
    streak,
    capped,
    spark,
  };
}

// Что говорит каждый счётчик: подпись (в панели), число как на экране, полная
// фраза для читалки экрана и подсказка; act — что сделает нажатие, actOn — что
// оно сделает, пока фильтр уже включён. Нажатие зависит от места: на «Сегодня»
// оно работает со списком дня, на «Доске» — с колонками (place: "board").
export function metricLabels(metric, { place = "today" } = {}) {
  const streakText = metric.capped ? `${metric.streak}+` : String(metric.streak);
  const streakWords = plural(metric.streak, DAYS);
  const labels = {
    planned: {
      caption: "запланировано",
      text: String(metric.planned),
      aria: `запланировано ${metric.planned}`,
      tip: `Запланировано на сегодня: ${metric.planned}`,
      act: "показать весь план",
    },
    done: {
      caption: "сделано",
      text: String(metric.done),
      aria: `сделано ${metric.done} из ${metric.planned}`,
      tip: `Сделано ${metric.done} из ${metric.planned}`,
      act: "вкладка «Закрыто»",
    },
    left: {
      caption: "осталось",
      text: String(metric.left),
      aria: `осталось ${metric.left}`,
      tip: `Осталось дел: ${metric.left}`,
      act: "только открытые",
      actOn: "снять фильтр",
    },
    late: {
      caption: "просрочено",
      text: String(metric.late),
      aria: `просрочено ${metric.late}`,
      tip: `Просрочено: ${metric.late}`,
      act: "только просроченные",
      actOn: "снять фильтр",
    },
    streak: {
      caption: "серия",
      text: streakText,
      aria: metric.capped ? `серия ${streakWords} и больше` : `серия ${streakWords}`,
      tip: metric.capped ? `Серия: ${streakText} ${DAYS[2]} подряд` : `Серия: ${streakWords} подряд`,
      act: "искра нарисуется заново",
    },
    week: {
      caption: "за неделю",
      text: String(metric.week),
      aria: `за неделю ${plural(metric.week, DEALS)}`,
      tip: `За неделю закрыто ${plural(metric.week, DEALS)}`,
      act: "искра нарисуется заново",
    },
  };
  if (place === "board") {
    Object.assign(labels.planned, { act: "показать всё" });
    Object.assign(labels.done, { act: "подсветить колонку «Закрыто»", actOn: "снять подсветку" });
    Object.assign(labels.left, { act: "приглушить «Закрыто»" });
  }
  return labels;
}

// Подсказка у свёрнутой пилюли: фраза и то, что сделает нажатие.
export function metricTitle(label, { pressed = false } = {}) {
  return `${label.tip} · нажмите${pressed ? " ещё раз" : ""} — ${pressed && label.actOn ? label.actOn : label.act}`;
}

// Читалка экрана объявляет эту фразу, когда числа меняются.
export function metricAnnouncement(metric) {
  return `Сделано ${metric.done} из ${metric.planned}, осталось ${metric.left}, просрочено ${metric.late}`;
}

// Доля закрытого для полоски под пилюлей: 0…1.
export function metricFraction(metric) {
  return metric.planned > 0 ? Math.min(1, metric.done / metric.planned) : 0;
}

// Искра: ломаная по точкам в рамке width×height. Высота — от максимума точек
// (но не меньше единицы: нули лежат на дне), последняя точка — сегодняшняя.
export function sparkShape(points, width, height, { pad = 2.5, radius = 2.4 } = {}) {
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? (width - 2 * pad) / (points.length - 1) : 0;
  const round = (value) => Math.round(value * 10) / 10;
  const xy = points.map((value, index) => [round(pad + index * step), round(height - pad - (value / max) * (height - 2 * pad))]);
  const line = xy.map(([x, y], index) => `${index ? "L" : "M"}${x},${y}`).join(" ");
  const last = xy[xy.length - 1];
  return {
    line,
    area: `${line} L${last[0]},${height} L${xy[0][0]},${height} Z`,
    dot: { x: last[0], y: last[1], r: radius },
  };
}
