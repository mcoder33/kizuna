// Демонстрация до входа: заранее подготовленные примеры, без сети и личных
// данных. Пример меняется только по выбору человека, поэтому его можно спокойно
// дочитать. Первая пара «фраза → результат» видна и без JavaScript.
const EXAMPLES = {
  todo: {
    text: "Нужно забрать посылку до пятницы",
    title: "Забрать посылку",
    icon: "✓",
    tags: ["Дело", "До пятницы"],
    note: "Появится на доске дел и в плане дня на пятницу. Срок уже на месте.",
  },
  meeting: {
    text: "Завтра в 11 встречаемся с Аней обсудить отпуск",
    title: "Обсудить отпуск с Аней",
    icon: "◷",
    tags: ["Встреча", "Завтра, 11:00", "Аня"],
    note: "Встреча появится в календаре Кизуны. Время и участник — из твоих слов.",
  },
  idea: {
    text: "Идея: на выходных выбраться к морю",
    title: "На выходных выбраться к морю",
    icon: "✳",
    tags: ["Идея"],
    note: "Останется в записях. Можно вернуться к ней, когда захочется придумать планы.",
  },
  outcome: {
    text: "Обсудили ремонт кухни. Нужно выбрать краску и найти мастера",
    title: "Обсудили ремонт кухни",
    icon: "↳",
    tags: ["Итог", "2 дела"],
    note: "Итог — в «Что делал», следующие шаги — отдельными делами:",
    parts: ["Выбрать краску", "Найти мастера"],
  },
};

function demoNode(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const field = document.getElementById("demo-text");
const out = document.getElementById("demo-out");
const options = document.querySelector(".hello-demo-options");
const preview = document.getElementById("demo-preview");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function showExample(key) {
  const example = EXAMPLES[key];
  if (!example) return;
  field.textContent = example.text;
  const heading = demoNode("div", undefined, "hello-result-heading");
  const icon = demoNode("span", example.icon, "hello-result-icon");
  icon.setAttribute("aria-hidden", "true");
  heading.append(icon, demoNode("p", example.title, "hello-result-title"));
  const tags = demoNode("div", undefined, "hello-result-tags");
  example.tags.forEach((tag, index) => tags.append(
    demoNode("span", tag, `hello-result-tag${index === 0 ? ` is-${key}` : ""}`),
  ));
  out.replaceChildren(heading, tags, demoNode("p", example.note, "hello-result-note"));
  for (const part of example.parts || []) out.append(demoNode("p", part, "hello-result-part"));
  for (const button of options.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.example === key));
  }
  preview.classList.remove("is-changing");
  // Перезапускаем короткое появление только после клика. Таймеров и автолистания нет.
  if (!reducedMotion.matches) {
    void preview.offsetWidth;
    preview.classList.add("is-changing");
  }
}

if (field && out && options && preview) {
  options.hidden = false;
  document.getElementById("demo-caption").textContent = "Выбери пример выше — посмотри, что получится.";
  options.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-example]");
    if (button && button.getAttribute("aria-pressed") !== "true") showExample(button.dataset.example);
  });
}
