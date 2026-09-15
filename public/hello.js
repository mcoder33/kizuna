// Показ вместо рассказа: на посадочной печатается фраза и рядом собирается то,
// во что приложение её превращает. Фразы и разбор настоящие — так оно и
// раскладывает, поэтому первое, что человек увидит внутри, совпадёт с обещанным.
// Никакой сети: страницу открывают до входа, и просить за это разбор моделью
// было бы странно.

const PHRASES = [
  {
    text: "Завтра в 11 созвон с Аней по Хабу",
    title: "Созвон с Аней по Hub",
    chips: [
      { text: "встреча", kind: "meeting" },
      { text: "завтра, 11:00", kind: "when" },
      { text: "Hub", kind: "project" },
      { text: "Аня", kind: "person" },
    ],
    note: "Встанет в календарь рядом с чужими встречами и напомнит за десять минут.",
  },
  {
    text: "Нужно оплатить хостинг до пятницы",
    title: "Оплатить хостинг",
    chips: [
      { text: "дело", kind: "todo" },
      { text: "срок: пятница", kind: "when" },
    ],
    note: "Не успеется — станет красным в дне, а не потеряется в списке.",
  },
  {
    text: "Созвонились по ВойсОпс, решили допинать детектор и карусель",
    title: "Итоги созвона по ВойсОпс",
    chips: [
      { text: "сделано", kind: "done" },
      { text: "результат", kind: "outcome" },
      { text: "ВойсОпс", kind: "project" },
    ],
    note: "Отчёт уходит в «Что делал», а два намерения из него — отдельными делами:",
    parts: ["Допинать детектор", "Допинать карусель"],
  },
  {
    text: "Мысль: показывать просроченное отдельной полосой",
    title: "Показывать просроченное отдельной полосой",
    chips: [{ text: "идея", kind: "idea" }],
    note: "Идеи не притворяются задачами: срок им не ставится, в дне они не мозолят глаза.",
  },
];

const field = document.getElementById("demo-text");
const caret = document.querySelector(".demo-caret");
const hint = document.getElementById("demo-hint");
const out = document.getElementById("demo-out");
const slow = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

function result(phrase) {
  const card = node("div", undefined, "demo-result");
  card.append(node("p", phrase.title, "demo-title"));
  const chips = node("div", undefined, "demo-chips");
  for (const chip of phrase.chips) chips.append(node("span", chip.text, `demo-tag is-${chip.kind}`));
  card.append(chips);
  if (phrase.note) card.append(node("p", phrase.note, "demo-note"));
  for (const part of phrase.parts || []) {
    const row = node("div", undefined, "demo-part");
    row.append(node("i", undefined, "demo-dot"), node("span", part));
    card.append(row);
  }
  return card;
}

async function type(text) {
  field.textContent = "";
  if (slow) { field.textContent = text; return; }
  for (const letter of text) {
    field.textContent += letter;
    await wait(letter === " " ? 26 : 34);
  }
}

async function run() {
  for (let index = 0; ; index = (index + 1) % PHRASES.length) {
    const phrase = PHRASES[index];
    out.replaceChildren();
    hint.textContent = "пишите как говорите";
    caret.classList.remove("is-idle");
    await type(phrase.text);
    caret.classList.add("is-idle");
    hint.textContent = "разбираю…";
    await wait(slow ? 300 : 650);
    hint.textContent = "разобрано";
    const card = result(phrase);
    out.append(card);
    requestAnimationFrame(() => card.classList.add("is-in"));
    await wait(slow ? 2200 : 4200);
  }
}

if (field && out) run();
