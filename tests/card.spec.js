import { test, expect, setUiPreferences } from "./fixtures/ui-preferences.js";

async function capture(page, raw) {
  const posted = page.waitForResponse(
    (response) => response.url().endsWith("/api/captures") && response.request().method() === "POST",
  );
  await page.getByLabel("Новая запись").fill(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect((await posted).status()).toBe(202);
  await expect(page.locator("#capture-notifications")).toContainText(raw);
}

// Обложка «Сегодня» живёт по часам: чтобы прогон не зависел от времени суток,
// страница видит один и тот же день — 13:00, фаза «день». Таймеры при этом
// идут как обычно.
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: dayAt(13) });
});

// Под полем два ящика: открытое лежит в «Дне», закрытое — в «Закрыто».
async function showTab(page, name) {
  const tab = page.getByRole("tab", { name });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}
// Запись, которой заглушка модели поставила срок «завтра» (она читает слово
// даже из таблицы), из сегодняшнего «Дня» уходит; тогда срок переносится на
// сегодня, чтобы открыть карточку отсюда: тест про карточку, а не про дату.
async function todayEntry(page, text) {
  const rows = page.locator("#todo .entry, #journal .entry").filter({ hasText: text });
  await expect
    .poll(async () => {
      if (await rows.count()) return true;
      const list = await (await page.request.get("/api/entries?limit=20")).json();
      const entry = list.entries.find((candidate) => candidate.raw.includes(text));
      const schedule = entry?.interpretation.classification.entities.schedule;
      if (entry && schedule?.date && schedule.date > (await (await page.request.get("/api/day")).json()).date) {
        const today = (await (await page.request.get("/api/day")).json()).date;
        await page.request.post(`/api/captures/${entry.id}/corrections`, { data: { patch: { schedule: { date: today, time: schedule.time || null } } } });
        await page.reload();
      }
      return false;
    }, { timeout: 15000 })
    .toBe(true);
  const inJournal = page.locator("#journal .entry").filter({ hasText: text });
  await showTab(page, (await inJournal.count()) ? /^Закрыто/ : /^День/);
  return rows.first();
}

async function openCard(page, listSelector, raw) {
  if (listSelector === "#todo") await showTab(page, /^День/);
  if (listSelector === "#journal") await showTab(page, /^Закрыто/);
  const card = page.locator(`${listSelector} .entry`).filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await card.locator(".entry-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
}

test("the focus card keeps its width while Parameters extends it with a column selector", async ({ page }) => {
  const raw = "Нужно проверить Hub для карточки";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  const dialog = page.locator("#review-dialog");
  const main = dialog.locator(".card-main");
  const width = (await main.boundingBox()).width;
  await expect(main.locator(".card-tick")).toBeVisible();
  await expect(main.locator(".card-body .prop-section")).toHaveText("Заметка");
  await expect(main.locator(".subtask-add")).toBeVisible();
  await expect(dialog.locator("#review-primary-type")).toHaveCount(0);
  await dialog.locator("#review-params-toggle").click();
  await expect(dialog.locator("#review-props")).toBeVisible();
  await expect(dialog.locator("#review-column option:checked")).toHaveText("Дела");
  await expect(dialog.locator(".card-nav-col")).toHaveText("Дела");
  await dialog.locator(".card-source summary").click();
  await expect(dialog.locator(".card-source-body")).toContainText("Поле записи");
  await expect(dialog.locator("#review-date")).toBeVisible();
  await expect(dialog.locator("#review-people")).toBeVisible();
  const mainBox = await main.boundingBox(), panelBox = await dialog.locator("#review-params").boundingBox();
  expect(Math.round(mainBox.width)).toBe(Math.round(width));
  expect(Math.round(panelBox.x)).toBe(Math.round(mainBox.x + mainBox.width));
});

test("the card opens from the board list, where the panel used to build on a hidden page", async ({ page }) => {
  const raw = "Нужно проверить карточку из списка";
  await page.goto("/");
  await capture(page, raw);
  await page.evaluate(() => { location.hash = "#board"; });
  await page.locator("#board-columns .board-card").filter({ hasText: raw }).first().locator(".board-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog h2")).toContainText(raw);
});

test("markdown notes save, render and survive reopening without touching the raw capture", async ({ page }) => {
  const raw = "Нужно проверить заметки в карточке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill("## План\n\n- **первый** пункт\n- `код`\n\n> цитата");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);

  // Тело карточки — живое поле: разметка оформлена прямо в тексте, отдельного
  // отрендеренного вида больше нет.
  const rendered = page.locator(".card-markdown");
  await expect(rendered.locator(".md-heading")).toContainText("План");
  await expect(rendered.locator("strong")).toContainText("первый");
  await expect(rendered.locator("code")).toContainText("код");
  await expect(rendered.locator(".md-quote")).toContainText("цитата");

  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await openCard(page, "#todo", raw);
  await expect(page.locator(".card-markdown .md-heading")).toContainText("План");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = entries.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("## План");
});

test("the description starts empty with a placeholder, the original text is not copied into it, saving writes only what was typed", async ({ page }) => {
  const raw = "Нужно проверить пустое описание без копии оригинала";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await expect(page.locator("#card-body-editor")).toHaveAttribute("data-placeholder", "Описание");
  await expect(page.locator("#card-body-editor")).toHaveText("");
  await expect(page.locator(".card-body .prop-section")).toHaveText("Заметка");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  expect(entries.entries.find((item) => item.raw === raw).note).toBeNull();

  // Уйти с пустым полем — заметка не создаётся, raw в неё не попадает.
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").blur();
  const untouched = await (await page.request.get("/api/entries?limit=100")).json();
  expect(untouched.entries.find((item) => item.raw === raw).note).toBeNull();

  await page.locator("#card-body-editor").fill("- дописал пункт");
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await expect(page.locator(".card-markdown .md-bullet")).toBeVisible();
  await expect(page.locator(".card-markdown")).toContainText("дописал пункт");

  const after = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = after.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toBe("- дописал пункт");
});

test("reopening a card without edits does not create a note version", async ({ page }) => {
  const raw = "Нужно проверить что открытие не создаёт версию";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await page.locator("#review-close").click();
  await openCard(page, "#todo", raw);
  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  expect(entries.entries.find((item) => item.raw === raw).note).toBeNull();
});

test("html typed into notes is escaped, never executed", async ({ page }) => {
  const raw = "Нужно проверить экранирование в заметке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill('<img src=x onerror="window.__pwned=1">');
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await expect(page.locator(".card-markdown")).toContainText("<img src=x");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator(".card-markdown img").count()).toBe(0);
});

test("escape closes the card and keeps what was typed", async ({ page }) => {
  const raw = "Нужно проверить сохранение заметки";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill("дописанное перед закрытием");
  // Раньше Esc откатывал набранное — и правка, сделанная перед закрытием
  // карточки, пропадала. Теперь он закрывает карточку и сохраняет её.
  await page.locator("#card-body-editor").press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();

  await openCard(page, "#todo", raw);
  await expect(page.locator(".card-markdown")).toContainText("дописанное перед закрытием");
});

test("closing a todo moves it from «Сегодня» to «Сделано»", async ({ page }) => {
  const raw = "Нужно проверить уход закрытой задачи";
  await page.goto("/");
  await capture(page, raw);
  const card = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Готово" }).click();

  await expect(page.locator("#todo")).not.toContainText(raw);
  // «Закрыто» — итог дня: закрытое кружком туду встаёт туда со временем закрытия
  await expect(page.locator("#journal")).toContainText(raw);

  // С открытых колонок доски оно тоже ушло, но лежит в «Сделано» — там же его
  // возвращают в работу, и оно встаёт в свою колонку.
  await page.evaluate(() => { location.hash = "#board"; });
  const openCards = page.locator("#board-columns .board-column:not(.board-done-column) .board-card");
  await expect(openCards.filter({ hasText: raw })).toHaveCount(0);
  const closed = page.locator("#board-columns .board-done-column .board-card").filter({ hasText: raw }).first();
  await expect(closed).toBeVisible();
  await closed.getByRole("button", { name: /Вернуть в работу/ }).click();
  await expect(page.locator("#board-columns .board-done-column .board-card").filter({ hasText: raw })).toHaveCount(0);
  await expect(openCards.filter({ hasText: raw })).toHaveCount(1);

  await page.evaluate(() => { location.hash = "#today"; });
  await expect(page.locator("#todo")).toContainText(raw);
});

test("a closed decision with an action leaves the day and never returns", async ({ page }) => {
  // Решение с отдельным действием получает проекции outcome_decision + task:
  // на главной оно лежит среди дел дня и закрывается как дело.
  const raw = "Решили по TCAM, нужно отправить протокол";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);

  const dayCard = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await dayCard.getByRole("button", { name: "Готово" }).click();

  await expect(page.locator("#todo")).not.toContainText(raw);
  await expect(page.locator("#journal")).toContainText(raw);
  // После перезагрузки закрытая запись в день не возвращается: закрыта по данным.
  await page.reload();
  await expect(page.locator("#todo .entry").filter({ hasText: raw })).toHaveCount(0);
  const entries = await (await page.request.get("/api/entries")).json();
  const entry = entries.entries.find((candidate) => candidate.raw === raw);
  expect(entry.projections.filter((p) => p.type === "task").every((p) => p.completion?.completed)).toBe(true);
});

test("properties changed in the card are saved when Escape closes it", async ({ page }) => {
  const raw = "Нужно проверить сохранение свойств по Esc";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  await openCard(page, "#todo", raw);

  await page.locator("#review-params-toggle").click();
  await page.locator("#review-people").fill("Игорь Петров");
  const propsBar = page.locator("#review-params-toggle");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/corrections") && response.request().method() === "POST",
  );
  // Esc в панели сначала закрывает панель, второй Esc закрывает диалог сам,
  // мимо крестика: правки должны уйти и этим путём.
  await page.locator("#review-people").press("Escape");
  await expect(propsBar).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await saved).status()).toBe(200);
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect
    .poll(async () => (await (await page.request.get("/api/entries?limit=20")).json()).entries.find((candidate) => candidate.raw === raw).interpretation.classification.entities.people)
    .toContain("Игорь Петров");
});

test("an untouched card closes without sending a correction", async ({ page }) => {
  const raw = "Нужно проверить закрытие без правок";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  let corrections = 0;
  page.on("request", (request) => {
    if (request.url().includes("/corrections") && request.method() === "POST") corrections += 1;
  });
  await openCard(page, "#todo", raw);
  // Поле потрогали, но значение прежнее — уточнения быть не должно.
  await page.locator("#review-params-toggle").click();
  const people = page.locator("#review-people");
  await people.fill(await people.inputValue());
  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await openCard(page, "#todo", raw);
  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  expect(corrections).toBe(0);
  const entries = await (await page.request.get("/api/entries?limit=100")).json(),
    entry = entries.entries.find((candidate) => candidate.raw === raw);
  expect(entry.interpretation.version).toBe(1);
});

test("markdown is decorated inside the capture field as it is typed", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  // Печатаем посимвольно: разметка должна оформляться прямо во время набора.
  await page.keyboard.type("--зачёркнуто-- и **жирный** с `кодом`");

  await expect(field.locator("del")).toHaveText("зачёркнуто");
  await expect(field.locator("strong")).toHaveText("жирный");
  await expect(field.locator("code")).toHaveText("кодом");
  // Ни один символ не удалён: маркеры остаются в тексте, лишь приглушены.
  await expect(field).toHaveText("--зачёркнуто-- и **жирный** с `кодом`");
  await expect(field.locator(".md-mark").first()).toHaveText("--");

  // Перенос строки и блочная разметка: Enter отправляет, поэтому строки
  // разделяет Shift+Enter.
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("# Заголовок");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("- пункт");
  await expect(field.locator(".md-heading")).toHaveText("Заголовок");
  await expect(field.locator(".md-bullet")).toHaveText("- ");
  await expect(field.locator(".md-line")).toHaveCount(3);

  // Исходная разметка уходит на сервер целиком, поле очищается.
  const posted = page.waitForRequest(
    (request) => request.url().endsWith("/api/captures") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const sent = JSON.parse((await posted).postData() || "{}");
  expect(sent.raw).toBe("--зачёркнуто-- и **жирный** с `кодом`\n# Заголовок\n- пункт");
  await expect(field).toHaveText("");

  // Сохранённая запись показывается с разметкой в списке и в карточке.
  const card = await todayEntry(page, "жирный");
  await expect(card).toBeVisible();
  await expect(card.locator(".entry-title strong")).toHaveText("жирный");
  await card.locator(".entry-title").click();
  await expect(page.locator("#review h2 code")).toHaveText("кодом");

  // В карточке — то же живое поле: печатаем и разметка оформляется на месте.
  const noteField = page.locator("#card-body-editor");
  await noteField.click();
  await page.keyboard.type("--старт-- описания");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("--правка-- в **карточке**");
  await expect(noteField.locator("del").last()).toHaveText("правка");
  await expect(noteField.locator("strong").last()).toHaveText("карточке");
  // Чистовик: маркеры раскрыты только на строке с кареткой, остальные строки
  // показывают готовый текст без серого синтаксиса.
  await expect(noteField.locator(".md-line.is-current .md-mark").first()).toBeVisible();
  await expect(noteField.locator(".md-line").first().locator(".md-mark").first()).toBeHidden();
});

test("obsidian markup works end to end: typed in the field, rendered in the card", async ({ page, request }) => {
  // Тест смотрит на превью «Сегодня», где помещаются три записи, поэтому
  // начинаем с чистого журнала — иначе соседние тесты вытеснят нашу запись.
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  const raw = [
    "# Разбор недели",
    "- [x] созвон ==сделан==",
    "- [ ] отчёт",
    "> [!warning] Осторожно",
    "| Что | Когда |",
    "| --- | ---: |",
    "| созвон | завтра |",
    "хвост #hub",
  ].join("\n");
  await page.keyboard.insertText(raw);

  // В поле разметка оформлена, но текст сохранён посимвольно.
  await expect(field.locator(".md-heading")).toHaveText("Разбор недели");
  await expect(field.locator(".md-checkbox-done")).toBeVisible();
  await expect(field.locator("mark")).toHaveText("сделан");
  await expect(field.locator(".md-callout-warning").first()).toBeVisible();
  await expect(field.locator(".md-table-line").first()).toBeVisible();
  await expect(field.locator(".md-tag")).toHaveText("#hub");

  const posted = page.waitForRequest(
    (request) => request.url().endsWith("/api/captures") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toBe(raw);

  // В карточке та же разметка становится настоящими блоками. Ищем на «Сегодня»:
  // соседние тесты могли оставить открытым другой раздел.
  await page.evaluate(() => { location.hash = "#today"; });
  const card = await todayEntry(page, "Разбор недели");
  await expect(card).toBeVisible();
  await card.locator(".entry-title").click();

  // Описание пустое, а исходный текст лежит свёрнутым под ним — запись готовым видом.
  await expect(page.locator("#card-body-editor")).toHaveText("");
  await expect(page.locator(".card-source")).toHaveCount(1);

  const body = page.locator("#card-body-editor");
  await body.click();
  await page.keyboard.type("правка");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await body.press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);
  // Блок источника собирается при открытии карточки, поэтому переоткрываем её.
  await page.locator("#review-close").click();
  await card.locator(".entry-title").click();
  await expect(page.locator(".card-source summary")).toContainText("Источник и версия");
  await page.locator(".card-source summary").click();
  const rendered = page.locator(".card-source .md-block");
  await expect(rendered.locator("table.md-table th").last()).toHaveText("Когда");
  await expect(rendered.locator("td").first()).toHaveText("созвон");
  await expect(rendered.locator("li.md-task-done")).toContainText("созвон");
  await expect(rendered.locator(".md-callout-warning .md-callout-title")).toHaveText("Осторожно");
  await expect(rendered.locator(".md-tag")).toHaveText("#hub");
});

test("lists continue on enter and checkboxes are clickable", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();

  // Enter продолжает список тем же маркером.
  await page.keyboard.type("- [ ] первая задача");
  await page.keyboard.press("Enter");
  await page.keyboard.type("вторая задача");
  await expect(field.locator(".md-line").nth(1)).toHaveText("- [ ] вторая задача");

  // Enter на пустом пункте заканчивает список, а не плодит маркеры.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. первый пункт");
  await page.keyboard.press("Enter");
  await page.keyboard.type("второй пункт");
  await expect(field.locator(".md-line").nth(3)).toHaveText("2. второй пункт");

  // Обычный дефис даёт буллет, у задачи — чекбокс вместо буллета; сам дефис
  // задачи в чистовике спрятан, квадрат рисует стиль.
  await expect(field.locator(".md-line").first().locator(".md-checkbox")).toBeVisible();
  await expect(field.locator(".md-bullet-task").first()).toBeHidden();
  await expect(field.locator(".md-ordered").first()).toBeVisible();

  // Чекбокс переключается мышью, и это меняет сам текст записи.
  await field.locator(".md-line").first().locator(".md-checkbox").click();
  await expect(field.locator(".md-line").first()).toHaveText("- [x] первая задача");
  await expect(field.locator(".md-checkbox-done")).toHaveCount(1);
  await field.locator(".md-line").first().locator(".md-checkbox").click();
  await expect(field.locator(".md-line").first()).toHaveText("- [ ] первая задача");

  // Отмеченная задача уходит на сервер именно как [x].
  await field.locator(".md-line").first().locator(".md-checkbox").click();
  const posted = page.waitForRequest(
    (request_) => request_.url().endsWith("/api/captures") && request_.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toContain("- [x] первая задача");
});

test("the card body is the same live field as the capture card, and the title stays a title", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const raw = ["# Разбор недели", "- [ ] отчёт", "| Что | Когда |", "| --- | ---: |", "| созвон | завтра |"].join("\n");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.insertText(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();

  // Заголовок — первая значимая строка с многоточием, а не склейка таблицы.
  const card = await todayEntry(page, "Разбор недели");
  await expect(card).toBeVisible();
  await expect(card.locator(".entry-title")).toHaveText("Разбор недели …");
  await card.locator(".entry-title").click();
  await expect(page.locator("#review h2")).toHaveText("Разбор недели …");

  // Тело карточки ведёт себя ровно как поле ввода: живая разметка,
  // продолжение списка по Enter и кликабельный чекбокс.
  const body = page.locator("#card-body-editor");
  await expect(body).toHaveText("");
  await body.click();
  await page.keyboard.insertText(raw);
  await expect(body.locator(".md-heading")).toHaveText("Разбор недели");
  await expect(body.locator(".md-checkbox")).toHaveCount(1);
  await body.locator(".md-line").nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("вторая задача");
  await expect(body.locator(".md-line").nth(2)).toHaveText("- [ ] вторая задача");
  await body.locator(".md-line").nth(2).locator(".md-checkbox").click();
  await expect(body.locator(".md-line").nth(2)).toHaveText("- [x] вторая задача");

  // Правка сохраняется как новая версия заметки, raw не меняется.
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await body.press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);
  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = entries.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("- [x] вторая задача");
});

test("tab nests a list item and shift+tab pulls it back, outside a list tab still moves focus", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();

  await page.keyboard.type("- верхний пункт");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("подпункт");
  await expect(field.locator(".md-line").nth(1)).toHaveText("  - подпункт");

  // Каретка остаётся на месте: продолжаем печатать там же, где стояли.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type(" дописано");
  await expect(field.locator(".md-line").nth(1)).toHaveText("- подпункт дописано");

  // Вне списка Tab уводит фокус дальше по форме — с клавиатуры поле не ловушка.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("обычная строка");
  await page.keyboard.press("Tab");
  await expect(field.locator(".md-line").last()).toHaveText("обычная строка");
  await expect(field).not.toBeFocused();

  // Вложенность доезжает до карточки настоящим вложенным списком.
  await field.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- верх");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("вложенный");
  const posted = page.waitForRequest(
    (request_) => request_.url().endsWith("/api/captures") && request_.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toContain("  - вложенный");
});

// Нумерованный список: Tab делает пункт подпунктом со своим счётом с 1,
// Shift+Tab возвращает его в счёт родителя, соседи ниже подтягиваются.
test("tab turns a numbered item into a sub-item with its own numbering", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.type("1. первый");
  await page.keyboard.press("Enter");
  await page.keyboard.type("второй");
  await page.keyboard.press("Enter");
  await page.keyboard.type("третий");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("подпункт");
  await expect(field.locator(".md-line").nth(3)).toHaveText("  1. подпункт");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ещё подпункт");
  await expect(field.locator(".md-line").nth(4)).toHaveText("  2. ещё подпункт");
  // Возврат влево — следующий пункт родителя, а не «2.» подсписка.
  await page.keyboard.press("Shift+Tab");
  await expect(field.locator(".md-line").nth(4)).toHaveText("4. ещё подпункт");
  // Пункт из середины ушёл вглубь — тот, что ниже, подтянул номер.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  await expect(field.locator(".md-line").nth(1)).toHaveText("  1. второй");
  await expect(field.locator(".md-line").nth(2)).toHaveText("2. третий");
  await expect(field.locator(".md-line").nth(4)).toHaveText("3. ещё подпункт");
});

test("enter continues a callout body and the body keeps the callout colour", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();

  await page.keyboard.type("> [!warning] Осторожно");
  await page.keyboard.press("Enter");
  await page.keyboard.type("тело предупреждения");
  await expect(field.locator(".md-line").nth(1)).toHaveText("> тело предупреждения");
  // Полоса тела окрашена в цвет заголовка: блок читается целиком.
  await expect(field.locator(".md-line").nth(1)).toHaveClass(/md-callout-warning/);

  // Пустая цитата заканчивает блок, а не тянет «>» дальше.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("обычный текст");
  await expect(field.locator(".md-line").last()).toHaveText("обычный текст");
  await expect(field.locator(".md-line").last()).not.toHaveClass(/md-callout/);
});

test("a callout looks like one filled block, a plain quote stays a quote", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.insertText("> [!warning] Осторожно\n> тело\n> вторая строка\n\nобычный текст\n\n> просто цитата");

  const lines = field.locator(".md-line");
  // Заголовок, тело и хвост размечены так, что складываются в один блок.
  await expect(lines.nth(0)).toHaveClass(/md-callout-head md-callout-warning/);
  await expect(lines.nth(1)).toHaveClass(/md-callout-body md-callout-warning/);
  await expect(lines.nth(2)).toHaveClass(/md-callout-tail/);
  // Заливка у строк блока есть, у обычного текста — нет.
  const filled = await lines.nth(1).evaluate((node) => getComputedStyle(node).backgroundColor);
  const plain = await lines.nth(4).evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(filled).not.toBe(plain);
  // Обычная цитата блоком callout не притворяется.
  await expect(lines.last()).not.toHaveClass(/md-callout/);
});



test("карточка тихо проявляется, а не летит через экран", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  // Движение в приложении одно на всё: короткое проявление на месте. Ни
  // перелёта из точки клика, ни роста размеров, ни масштаба — только
  // прозрачность и мягкий сдвиг по вертикали.
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для карточки");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "запись для карточки" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();

  const dialog = page.locator("#review-dialog");
  const cardFrames = await dialog.evaluate((node) =>
    node.getAnimations().map((animation) => ({
      duration: animation.effect.getTiming().duration,
      keys: animation.effect.getKeyframes().map((frame) => frame.transform),
    })),
  );
  expect(cardFrames.length).toBe(1);
  expect(cardFrames[0].duration).toBe(300);
  expect(cardFrames[0].keys[0]).toBe("translateY(10px)");
  expect(cardFrames[0].keys.at(-1)).toBe("none");
  await expect(dialog).toBeVisible();

  // Содержимое въезжает вместе с карточкой: отдельных анимаций у блоков нет.
  const blockAnimations = await page.locator("#review").evaluate((area) =>
    [...area.children].reduce((total, block) => total + block.getAnimations().length, 0),
  );
  expect(blockAnimations).toBe(0);
});

// Карточка по центру — 880px в ширину, высота по содержимому, зазор 40px сверху;
// колонка описания стоит по центру.
test("the entry card starts at 880px and centers its description", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для проверки страницы");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "проверки страницы" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();
  await page.waitForTimeout(760);

  // Короткая карточка не растягивается на всю доступную высоту: её высоту
  // задаёт содержимое, а верх стоит в зазоре 40px от края экрана.
  const card = await page.locator("#review-dialog").boundingBox();
  expect(Math.round(card.width)).toBe(880);
  expect(card.height).toBeLessThan(720);
  expect(card.height).toBeGreaterThan(360);
  expect(Math.round(card.y)).toBe(40);

  // Контент собран в колонку страницы: сам #review — прокрутка во всю ширину,
  // колонку (788px карточки «Фокус») задают его поля, поэтому меряем заметки.
  const column = await page.locator("#review .card-body").boundingBox();
  expect(Math.round(column.width)).toBeLessThanOrEqual(788);
  // Колонка стоит по центру peek, а не прижата к краю.
  const offCenter = Math.abs(column.x + column.width / 2 - (card.x + card.width / 2));
  expect(offCenter).toBeLessThan(16);
});

// При открытии параметров ширина основной части не меняется; ручки размера остаются.
test("the focus card keeps its width when parameters open and after reopening", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("Новая запись").fill("запись для проверки размера");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "проверки размера" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();
  const dialog = page.locator("#review-dialog");
  const before = await dialog.locator(".card-main").boundingBox();
  // Ручки размера: боковые края, нижний и нижние углы.
  await expect(dialog.locator(".card-resize")).toHaveCount(5);
  await dialog.locator("#review-params-toggle").click();
  await expect(dialog.locator("#review-params")).toBeVisible();
  expect(Math.round((await dialog.locator(".card-main").boundingBox()).width)).toBe(Math.round(before.width));
  await page.keyboard.press("Escape");
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await entry.locator(".entry-title").click();
  expect(Math.round((await dialog.locator(".card-main").boundingBox()).width)).toBe(Math.round(before.width));
});

test("a capture can be deleted from its card and brought back from the toast", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const raw = "запись, которую удалим и вернём";
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();

  const card = page.locator("#today .entry").filter({ hasText: "удалим и вернём" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator(".entry-title").click();

  // Удаление живёт в карточке, отдельно от правок.
  const remove = page.locator(".card-delete");
  await expect(remove).toContainText("Удалить запись");
  await remove.click();

  // Карточка закрывается, запись уходит с экрана, тост предлагает вернуть.
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(page.locator("#today")).not.toContainText("удалим и вернём");
  const toast = page.locator("#toast");
  await expect(toast).toContainText("Запись удалена");

  // Журнал ничего не забыл: запись осталась в экспорте с отметкой удаления.
  const exported = await (await request.get("/api/export")).json();
  const stored = exported.captures.find((capture) => capture.raw === raw);
  expect(stored).toBeTruthy();
  expect(stored.deleted_at).toBeTruthy();

  // «Вернуть» поднимает запись обратно.
  await toast.getByRole("button", { name: "Вернуть" }).click();
  await expect(page.locator("#today .entry").filter({ hasText: "удалим и вернём" }).first()).toBeVisible();
  await expect(toast).toContainText("Запись возвращена");
});

test("a card reopened after closing is visible, not a ghost", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для повторного открытия");
  await page.getByRole("button", { name: "Сохранить запись" }).click();

  const card = page.locator("#today .entry").filter({ hasText: "повторного открытия" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  const dialog = page.locator("#review-dialog");

  // Анимация закрытия оставляла карточку прозрачной: со второго раза она была
  // «открыта», но невидима — размер есть, видимости нет.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await card.locator(".entry-title").click();
    await page.waitForTimeout(750);
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.locator("#review-close").click();
    await page.waitForTimeout(600);
    await expect(dialog).toBeHidden();
  }
});

// Вложения: файл живёт рядом с записью, а не внутри текста. Проверяем весь
// путь — выбор файла, плитка, быстрый предпросмотр, удаление и скрепка в списке.
test("к записи можно приложить файл, посмотреть его и убрать", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись со снимком доски");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "снимком доски" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();

  const files = page.locator(".card-files");
  await expect(files).toContainText("Пока пусто");

  // Настоящий выбор файла: тот же путь, что и у человека.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator(".card-files input[type=file]").setInputFiles({
    name: "снимок доски.png",
    mimeType: "image/png",
    buffer: png,
  });

  const tile = page.locator(".file-tile").first();
  await expect(tile).toBeVisible();
  await expect(tile.locator(".file-name")).toHaveText("снимок доски.png");
  await expect(tile.locator("img.file-thumb")).toBeVisible();

  // Быстрый предпросмотр: картинка открывается тут же, не скачиванием.
  await tile.locator(".file-open").click();
  const preview = page.locator("#preview-dialog");
  await expect(preview).toBeVisible();
  await expect(page.locator("#preview-title")).toHaveText("снимок доски.png");
  await expect(page.locator(".preview-image")).toBeVisible();
  await expect(page.locator("#preview-download")).toHaveAttribute("download", "снимок доски.png");
  await page.locator("#preview-close").click();
  await expect(preview).toBeHidden();

  // В списке видно скрепку с числом — не открывая карточку.
  await page.locator("#review-close").click();
  await expect(entry.locator(".entry-meta .tag.files")).toHaveText("📎 1");

  // Убрать вложение можно там же, где приложили.
  await entry.locator(".entry-title").click();
  await page.locator(".file-remove").first().click();
  await expect(page.locator(".card-files")).toContainText("Пока пусто");
  await page.locator("#review-close").click();
  await expect(entry.locator(".entry-meta .tag.files")).toHaveCount(0);
});

// Набранное в карточке не должно пропадать: карточку закрывают крестиком,
// фоном и Esc — во всех трёх случаях заметка сохраняется сама.
test("заметка сохраняется при любом закрытии карточки", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("встреча по колл-центру");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "колл-центру" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  // Esc раньше откатывал набранное — теперь он просто уводит фокус.
  await entry.locator(".entry-title").click();
  await page.locator(".card-markdown").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" :: правка перед Esc");
  // Esc закрывает карточку — и уносит набранное с собой в заметку.
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();

  await entry.locator(".entry-title").click();
  await expect(page.locator(".card-markdown")).toContainText("правка перед Esc");

  // Закрытие крестиком прямо из поля — тоже сохраняет.
  await page.locator(".card-markdown").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" :: и перед крестиком");
  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();

  await entry.locator(".entry-title").click();
  await expect(page.locator(".card-markdown")).toContainText("и перед крестиком");
  await page.locator("#review-close").click();

  // Сохранилось на сервере, а не только на экране.
  const entries = await (await request.get("/api/entries?limit=5")).json();
  const saved = entries.entries.find((item) => item.raw.includes("колл-центру"));
  expect(saved.note.body).toContain("правка перед Esc");
  expect(saved.note.body).toContain("и перед крестиком");
});

test("статус задачи виден у кружка и не дублируется среди свойств", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const raw = "Нужно проверить статус на карточке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  // Чипы оставлены для срока и других редактируемых свойств.
  await expect(page.locator("#review-dialog .card-chips .entry-status")).toHaveCount(0);
  await expect(page.locator("#review-dialog .card-chips .chip").first()).toContainText("сегодня");
  const chipsBox = await page.locator("#review-dialog .card-chips").boundingBox();
  const writtenBox = await page.locator("#review-dialog .card-written").boundingBox();
  expect(chipsBox.y).toBeLessThan(writtenBox.y);
  expect(await page.locator("#review-dialog .entry-status").count()).toBe(0);
  await page.keyboard.press("Escape");

  // Закрытая чекбоксом задача показывает «Сделано» — карточка открывается
  // из «Обзора» за сегодня, где закрытые дела перечислены строками.
  const entry = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await entry.locator(".completion-button").click();
  await expect(page.locator("#todo .entry").filter({ hasText: raw })).toHaveCount(0);
  await page.goto("/#reports");
  await page.locator('[data-reports-tab="day"]').click();
  await page.locator("#reports-day-next").click();
  await page.locator("#reports-day .report-items li").filter({ hasText: raw }).first().click();
  await expect(page.locator("#review-dialog .card-done-ok")).toContainText("Сделано");
  await expect(page.locator("#review-dialog .card-title.is-done")).toBeVisible();
});

test("заголовок записи правится прямо в карточке", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const raw = "Нужно проверить правку заголовка";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await page.locator("#review-dialog h2.card-title").click();
  const editor = page.locator("#review-dialog .card-title-edit");
  await expect(editor).toBeFocused();
  await editor.fill("Проверить заголовок после правки");
  await page.keyboard.press("Enter");
  await expect(page.locator("#review-dialog h2.card-title")).toContainText("Проверить заголовок после правки");
  // Изменение видно и в списке — заголовок один везде.
  await page.keyboard.press("Escape");
  await expect(page.locator("#todo")).toContainText("Проверить заголовок после правки");
  // Escape в поле не закрывает карточку, а возвращает прежний заголовок.
  await openCard(page, "#todo", "Проверить заголовок после правки");
  await page.locator("#review-dialog h2.card-title").click();
  await page.keyboard.type("хвост");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog h2.card-title")).toContainText("Проверить заголовок после правки");
});

test("a screenshot pasted into the capture field opens a preview on click", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.evaluate(() => {
    // PNG 1×1 — снимок из буфера, ещё не отправленный на сервер.
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
      (char) => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document
      .querySelector("#capture-form")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const shot = page.locator("#capture-shots .capture-shot");
  await expect(shot).toHaveCount(1);
  await shot.getByRole("button", { name: /^Открыть/ }).click();
  await expect(page.locator("#preview-dialog")).toBeVisible();
  await expect(page.locator("#preview-dialog .preview-image")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#preview-title")).toContainText("снимок-");
  await page.locator("#preview-close").click();
  await expect(page.locator("#preview-dialog")).toBeHidden();
  // Просмотр ничего не отправляет и не убирает: снимок остаётся в полосе.
  await expect(shot).toHaveCount(1);
});

test("a capture the model could not parse still lands as a todo for today", async ({ page }) => {
  const raw = "Созвон с Женей был по доработкам [[сбой модели]]";
  await page.goto("/");
  await capture(page, raw);
  // Модель упала — запись всё равно туду на сегодня: ничего не теряется и
  // ничего не переспрашивается, поправить можно в карточке.
  const findEntry = async () => (await (await page.request.get("/api/entries?limit=100")).json()).entries.find((candidate) => candidate.raw.includes("Созвон с Женей")) || null;
  await expect.poll(findEntry, { timeout: 15000 }).not.toBeNull();
  const row = page.locator("#todo .entry").filter({ hasText: "Созвон с Женей" });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator(".entry-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-close").click();
  await expect(page.locator("#todo")).toContainText("Созвон с Женей");
});

test("on a phone the card stays pinned to the screen while the page behind is scrolled, and paste lands in the note", async ({ page }) => {
  const raw = "Нужно проверить карточку на телефоне";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await capture(page, raw);
  // Список прокручен вниз — в верхнем слое relative-диалог открывался бы
  // выше экрана, у начала документа.
  await page.evaluate(() => { location.hash = "#board"; });
  const card = page.locator("#board-columns .board-card").filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await card.locator(".board-title").click();
  const dialog = page.locator("#review-dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350);
  await expect(dialog).toHaveCSS("position", "fixed");
  expect(Math.abs((await dialog.boundingBox()).y)).toBeLessThan(2);

  // Прокрутка страницы карточку не двигает: страница под ней заперта.
  await page.evaluate(() => window.scrollBy(0, 300));
  expect(Math.abs((await dialog.boundingBox()).y)).toBeLessThan(2);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  // Каретка в заметке — и вставка из буфера попадает именно туда.
  const editor = page.locator("#card-body-editor");
  await editor.click();
  await expect(editor).toBeFocused();
  const box = await editor.boundingBox();
  expect(box.y).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(844);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "SIP/RTP → ASR → LLM");
    document
      .querySelector("#card-body-editor")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor).toContainText("SIP/RTP → ASR → LLM");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Карточка закрыта — страница снова прокручивается.
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("a cross next to the day resets it at once: a dated task becomes undated", async ({ page, request }) => {
  const raw = "Дело с датой для сброса";
  await request.post("/api/captures", { data: { raw, primaryType: "todo", due: { date: "2026-09-04", time: "11:00" } } });
  await page.goto("/");
  await openCard(page, "#todo", raw);
  await page.locator("#review-params-toggle").click();
  await expect(page.locator("#review-date")).toHaveValue("2026-09-04");
  const clear = page.locator('#review-dialog .prop-clear[aria-label="Сбросить: срок"]');
  await expect(clear).toBeVisible();
  const saved = page.waitForResponse((response) => response.url().includes("/corrections") && response.request().method() === "POST");
  await clear.click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("#review-date")).toHaveValue("");
  await expect(page.locator("#review-time")).toHaveValue("");
  await expect(clear).toBeHidden();
  await page.keyboard.press("Escape");
  // На сервере срока больше нет: на доске дело лежит без даты.
  await expect.poll(async () => {
    const board = await (await request.get("/api/board")).json();
    const card = JSON.stringify(board).match(new RegExp(`"title":"${raw}"[^}]*`));
    return card ? /"due":null/.test(card[0]) : null;
  }).toBe(true);
});

// Г «Отметил — следующее»: кружок у названия закрывает дело сразу, а карточка,
// открытая из «Дня», идёт к следующему открытому делу. Плашка «Готово ·
// Вернуть» даёт передумать.
test("кружок в карточке закрывает дело и ведёт к следующему делу «Сегодня»", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  for (const raw of ["Разбор: третье дело", "Разбор: второе дело", "Разбор: первое дело"])
    await request.post("/api/captures", { data: { raw, primaryType: "todo", due: { date: today } } });
  await page.goto("/");
  const shelf = page.locator("#todo .day-rows .entry");
  await expect(shelf).toHaveCount(3, { timeout: 15000 });
  const titles = await shelf.locator(".entry-title").allInnerTexts();
  await shelf.first().locator(".entry-title").click();

  const dialog = page.locator("#review-dialog");
  const title = dialog.locator(".card-title");
  await expect(title).toHaveText(titles[0]);
  await expect(dialog.locator(".card-nav-col")).toHaveText("Дела");
  await expect(dialog.locator(".card-nav-crumb")).toContainText("1 из 3");
  // Отметили — дело закрыто сразу, строка «Сделано» видна до перехода.
  await dialog.locator(".card-tick").click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Сделано сегодня в");
  await expect(title).toHaveText(titles[1], { timeout: 5000 });
  await expect(dialog.locator(".card-nav-crumb")).toContainText("2 из 3");
  const snack = dialog.locator(".card-snack");
  await expect(snack).toContainText(`Готово: «${titles[0].slice(0, 20)}`);

  // Клавиша E — тот же кружок; K — назад к закрытому, J — вперёд. Новое дело
  // первые 350 мс нажатий не принимает — двойной клик не закроет его заодно.
  await page.waitForTimeout(400);
  await dialog.focus();
  await page.keyboard.press("e");
  await expect(title).toHaveText(titles[2], { timeout: 5000 });
  await page.keyboard.press("k");
  await expect(title).toHaveText(titles[1]);
  await expect(dialog.locator(".card-title.is-done")).toBeVisible();
  // «Вернуть» в строке «Сделано» открывает дело снова.
  await dialog.locator(".card-done-link", { hasText: "Вернуть" }).click();
  await expect(dialog.locator(".card-tick")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("j");
  await expect(title).toHaveText(titles[2]);
  await dialog.locator(".card-tick").click();
  // Дальше открыто только второе, вернувшееся в работу.
  await expect(title).toHaveText(titles[1], { timeout: 5000 });
  await page.waitForTimeout(400);
  await dialog.locator(".card-tick").click();
  await expect(dialog.locator(".card-finish-title")).toHaveText("В «Дне» всё отмечено", { timeout: 5000 });
  await dialog.locator(".card-finish-close").click();

  await expect(page.locator("#todo .day-rows .entry")).toHaveCount(0);
  // Закрытое кружком лежит в «Закрыто».
  await expect(page.locator("#journal")).toContainText(titles[0]);
});

// Открытая не из списка карточка никуда не уходит: отметка остаётся на месте,
// а «Сделано» у дела — кружок, не строка свойств.
test("карточка по ссылке остаётся на месте после отметки, «Вернуть» открывает дело снова", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const created = await (await request.post("/api/captures", { data: { raw: "Проверить доступ голосового агента", primaryType: "todo" } })).json();
  await page.goto(`/#today?open=${created.entry.id}`);
  const dialog = page.locator("#review-dialog");
  await expect(dialog.locator(".card-title")).toHaveText("Проверить доступ голосового агента");
  // Не из списка: листать нечего, но колонка над названием видна.
  await expect(dialog.locator(".card-nav-step")).toHaveCount(0);
  await expect(dialog.locator(".card-nav-col")).toHaveText("Дела");
  await dialog.locator(".card-tick").click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Сделано");
  await page.waitForTimeout(1200);
  await expect(dialog.locator(".card-title")).toHaveText("Проверить доступ голосового агента");
  await expect(dialog.locator(".card-tick")).toHaveAttribute("aria-pressed", "true");
  const stored = await (await request.get(`/api/captures/${created.entry.id}`)).json();
  expect(stored.entry.interpretation.classification.primaryType).toBe("task");
  expect(stored.entry.projections.find((projection) => projection.type === "task").completion.completed).toBe(true);
  await dialog.locator(".card-done-link", { hasText: "Вернуть" }).click();
  await expect(dialog.locator(".card-tick")).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator(".card-done")).toHaveCount(0);
});

// ── режимы показа карточки ───────────────────────────────────────────────────
// По центру — окно поверх с зазорами и высотой по содержимому, сбоку — во весь
// рост справа, страница живая, во весь экран — как страница. Выбор один на все
// карточки и помнится в браузере (kizuna-card-mode); края окна тянутся, размер
// помнится (kizuna-card-size), поле обсуждения внизу тянется само
// (kizuna-card-talk-height).
const resetAll = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
const makeDeed = async (request, raw) => (await (await request.post("/api/captures", { data: { raw, primaryType: "todo" } })).json()).entry;
const makeStep = async (request, parentId, title) => (await (await request.post(`/api/captures/${parentId}/subtasks`, { data: { title } })).json()).entry;
async function openByLink(page, id) {
  await page.goto(`/#today?open=${id}`);
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog .card-title")).not.toBeEmpty();
  // Проявление и смена ширины заканчиваются до замеров.
  await settled(page);
}
const settled = (page) => page.locator("#review-dialog").evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
const isModal = (page) => page.locator("#review-dialog").evaluate((element) => element.matches(":modal"));
const storedValue = (page, key) => page.evaluate((name) => window.pagentPreferenceStorage.getItem(name), key);
const startInMode = (page, mode) => setUiPreferences(page.request, { "kizuna-card-mode": mode });
async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.up();
}

test("режимы карточки: меню с тремя пунктами, выбор «сбоку» помнится после перезагрузки, следующая карточка открывается сбоку", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const first = await makeDeed(request, "Первое дело для режимов");
  const second = await makeDeed(request, "Второе дело для режимов");
  await openByLink(page, first.id);
  const dialog = page.locator("#review-dialog");
  const toggle = dialog.locator("#review-mode-toggle");
  const menu = dialog.locator("#review-mode-menu");
  const items = menu.getByRole("menuitemradio");

  // По умолчанию — по центру, окно модальное, значок — «окно поверх».
  await expect(dialog).toHaveAttribute("data-mode", "center");
  expect(await isModal(page)).toBe(true);
  await expect(menu).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(menu).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("По центру");
  await expect(items.nth(0)).toContainText("окно поверх, зазоры по краям");
  await expect(items.nth(1)).toContainText("Сбоку");
  await expect(items.nth(1)).toContainText("во весь рост справа, доска видна");
  await expect(items.nth(2)).toContainText("Во весь экран");
  await expect(items.nth(2)).toContainText("как страница");
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(items.nth(1)).toHaveAttribute("aria-checked", "false");
  await expect(menu).toContainText("Выбор запоминается для всех карточек");
  // Esc закрывает только меню, карточка остаётся.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();

  await toggle.click();
  await items.nth(1).click();
  await expect(menu).toBeHidden();
  await expect(dialog).toHaveAttribute("data-mode", "side");
  await expect(dialog.locator(".card-snack")).toContainText("Карточки открываются сбоку");
  expect(await storedValue(page, "kizuna-card-mode")).toBe("side");
  // Карточка осталась той же, но окно стало обычным, а не модальным.
  await expect(dialog.locator(".card-title")).toHaveText("Первое дело для режимов");
  expect(await isModal(page)).toBe(false);
  await settled(page);
  let box = await dialog.boundingBox();
  expect(Math.round(box.x + box.width)).toBe(1440);
  expect(Math.round(box.y)).toBe(0);
  expect(Math.round(box.height)).toBe(900);
  expect(Math.round(box.width)).toBe(Math.round(1440 * 0.56));
  await toggle.click();
  await expect(items.nth(1)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // После перезагрузки выбор на месте, и следующая карточка открывается сбоку.
  await page.reload();
  await openByLink(page, second.id);
  await expect(dialog).toHaveAttribute("data-mode", "side");
  await expect(dialog.locator(".card-title")).toHaveText("Второе дело для режимов");
  expect(await isModal(page)).toBe(false);
  box = await dialog.boundingBox();
  expect(Math.round(box.x + box.width)).toBe(1440);
  expect(Math.round(box.height)).toBe(900);

  // Значок на кнопке показывает текущий режим; выбор «по центру» возвращает окно.
  await expect(toggle.locator("path")).toHaveAttribute("d", "M13 4v16");
  await toggle.click();
  await items.nth(0).click();
  await expect(dialog).toHaveAttribute("data-mode", "center");
  await expect(dialog.locator(".card-snack")).toContainText("Карточки открываются по центру");
  expect(await isModal(page)).toBe(true);
  expect(await storedValue(page, "kizuna-card-mode")).toBe("center");
});

test("смена режима в открытой карточке не теряет её: название, заметка и панель «Параметры» на месте", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело, которое переезжает между режимами");
  await openByLink(page, deed.id);
  const dialog = page.locator("#review-dialog");
  await dialog.locator("#review-params-toggle").click();
  await expect(dialog.locator("#review-props")).toBeVisible();
  await dialog.locator(".card-markdown").click();
  await dialog.locator("#card-body-editor").fill("дописано до смены режима");
  for (const [index, mode] of [[2, "full"], [1, "side"], [0, "center"]]) {
    await dialog.locator("#review-mode-toggle").click();
    await dialog.locator("#review-mode-menu").getByRole("menuitemradio").nth(index).click();
    await expect(dialog).toHaveAttribute("data-mode", mode);
    await expect(dialog.locator(".card-title")).toHaveText("Дело, которое переезжает между режимами");
    await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.locator(".card-markdown")).toContainText("дописано до смены режима");
    expect(await isModal(page)).toBe(mode !== "side");
  }
  // Заметка ушла на сервер при уходе фокуса в меню, а не пропала.
  await expect.poll(async () => (await (await request.get(`/api/captures/${deed.id}`)).json()).entry.note?.body).toBe("дописано до смены режима");
});

test("сбоку страница жива: щелчок по другой карточке доски меняет открытую, а не открывает вторую; щелчок мимо закрывает", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await makeDeed(request, "Альфа дело режима");
  await makeDeed(request, "Бета дело режима");
  await makeDeed(request, "Гамма дело режима");
  await startInMode(page, "side");
  await page.goto("/#board");
  const boardTitle = (text) => page.locator("#board-columns .board-card").filter({ hasText: text }).first().locator(".board-title");
  const dialog = page.locator("#review-dialog");

  await boardTitle("Альфа").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".card-title")).toHaveText("Альфа дело режима");
  // Окно не модальное, подложки нет: доска левее панели видна и не затемнена.
  expect(await isModal(page)).toBe(false);
  const panel = await dialog.boundingBox();
  const beta = await boardTitle("Бета").boundingBox();
  expect(beta.x + beta.width).toBeLessThan(panel.x);

  // Открытая запись на доске за карточкой обведена: видно, какая из них читается.
  const marked = page.locator("#board-columns .card-is-open");
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("Альфа дело режима");

  // Щелчок по другой карточке доски меняет содержимое открытой карточки.
  await boardTitle("Бета").click();
  await expect(dialog.locator(".card-title")).toHaveText("Бета дело режима");
  await expect(dialog.locator(".card-nav-crumb")).toContainText("из 3");
  expect(await page.evaluate(() => document.querySelectorAll("dialog[open]").length)).toBe(1);
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("Бета дело режима");
  await boardTitle("Гамма").click();
  await expect(dialog.locator(".card-title")).toHaveText("Гамма дело режима");

  // Стрелки листают соседние дела.
  const before = await dialog.locator(".card-title").innerText();
  await dialog.locator(".card-nav-step:not([disabled])").first().click();
  await expect(dialog.locator(".card-title")).not.toHaveText(before);

  // Esc закрывает окно, у которого своего Esc нет, и обводка с доски уходит.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(marked).toHaveCount(0);

  // Щелчок мимо карточки — по самой странице — закрывает её, как Esc и подложка у модальной,
  // и обводка с доски уходит тоже.
  await boardTitle("Гамма").click();
  await expect(dialog.locator(".card-title")).toHaveText("Гамма дело режима");
  await expect(marked).toHaveCount(1);
  await page.locator("#board .page-heading h2").click({ position: { x: 20, y: 10 } });
  await expect(dialog).toBeHidden();
  await expect(marked).toHaveCount(0);
});

test("сбоку щелчок мимо карточки закрывает её и сохраняет набранное; правая кнопка и плавающее меню вне окна её не закрывают", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело для щелчка мимо");
  await startInMode(page, "side");
  await page.goto("/#board");
  const dialog = page.locator("#review-dialog");
  await page.locator("#board-columns .board-card").filter({ hasText: "Дело для щелчка мимо" }).locator(".board-title").click();
  await expect(dialog.locator(".card-title")).toHaveText("Дело для щелчка мимо");
  expect(await isModal(page)).toBe(false);
  await dialog.locator(".card-markdown").click();
  await dialog.locator("#card-body-editor").fill("набрано и оставлено щелчком мимо");

  // Правая кнопка мимо окна карточку не закрывает.
  await page.locator("#board .page-heading h2").click({ button: "right", position: { x: 20, y: 10 } });
  await expect(dialog).toBeVisible();
  // Меню разметки, ссылок и упоминаний, плашки календаря и колокольчика живут вне окна:
  // нажатие по ним карточку не закрывает (здесь — такой же элемент, поставленный на страницу).
  await page.evaluate(() => {
    const menu = document.createElement("div");
    menu.className = "link-menu";
    menu.id = "probe-floating";
    menu.textContent = "меню вне окна";
    menu.style.cssText = "display:block;position:fixed;left:24px;top:420px;width:160px;height:40px;z-index:5;background:#fff;";
    document.body.append(menu);
  });
  await page.locator("#probe-floating").click();
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.querySelector("#probe-floating")?.remove());
  // Внутри окна — тоже нет: поле, заголовок, кнопка «Параметры».
  await dialog.locator("#review-params-toggle").click();
  await expect(dialog).toBeVisible();
  await dialog.locator("#review-params-toggle").click();

  // Мимо карточки — в пустое место страницы: закрывается, а набранное ушло на сервер.
  await page.locator("#board .page-heading h2").click({ position: { x: 20, y: 10 } });
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await (await request.get(`/api/captures/${deed.id}`)).json()).entry.note?.body).toBe("набрано и оставлено щелчком мимо");

  // Щелчок, закрывший меню режимов, карточку не закрывает: нужен второй.
  await page.locator("#board-columns .board-card").filter({ hasText: "Дело для щелчка мимо" }).locator(".board-title").click();
  await expect(dialog).toBeVisible();
  await dialog.locator("#review-mode-toggle").click();
  await expect(dialog.locator("#review-mode-menu")).toBeVisible();
  await page.locator("#board .page-heading h2").click({ position: { x: 20, y: 10 } });
  await expect(dialog.locator("#review-mode-menu")).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(450);
  await page.locator("#board .page-heading h2").click({ position: { x: 20, y: 10 } });
  await expect(dialog).toBeHidden();
  await resetAll(request);
});

test("сбоку щелчок по строке списка и по строке «Сегодня» переключает открытую карточку, а не закрывает", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await makeDeed(request, "Первое дело строк");
  await makeDeed(request, "Второе дело строк");
  await startInMode(page, "side");
  await setUiPreferences(page.request, { "kizuna-board-view": "list", "kizuna-board-filter": "[]" });
  await page.goto("/#board");
  const dialog = page.locator("#review-dialog");
  const row = (text) => page.locator("#board-flat .g-row").filter({ hasText: text }).locator(".board-title");
  await row("Первое").click();
  await expect(dialog.locator(".card-title")).toHaveText("Первое дело строк");
  // Строка списка — та же запись на странице, а не «мимо»: карточка переключается.
  // Лента списка стоит по центру, и панель сбоку (правые 56% окна) накрывает середину
  // названия: щелчок по центру попадал в панель. Поэтому щёлкают у левого края названия,
  // как ниже на «Сегодня».
  await row("Второе").click({ position: { x: 10, y: 8 } });
  await expect(dialog.locator(".card-title")).toHaveText("Второе дело строк");
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll("dialog[open]").length)).toBe(1);

  // На «Сегодня» — так же: по строке дня карточка меняется, по пустому месту закрывается.
  // Панель стоит справа поверх страницы, поэтому по строкам щёлкают у левого края.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.goto("/#today");
  await showTab(page, /^День/);
  const today = (text) => page.locator("#todo .entry").filter({ hasText: text }).locator(".entry-title");
  await today("Первое").click({ position: { x: 10, y: 8 } });
  await expect(dialog.locator(".card-title")).toHaveText("Первое дело строк");
  await today("Второе").click({ position: { x: 10, y: 8 } });
  await expect(dialog.locator(".card-title")).toHaveText("Второе дело строк");
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll("dialog[open]").length)).toBe(1);
  // Пустое поле страницы слева от ящиков — мимо: карточка закрывается.
  await page.mouse.click(20, 500);
  await expect(dialog).toBeHidden();
  await resetAll(request);
});

test("сбоку набранное в карточке не пропадает, когда по доске открывают другую", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const alpha = await makeDeed(request, "Альфа дело с заметкой");
  await makeDeed(request, "Бета дело без заметки");
  await startInMode(page, "side");
  await page.goto("/#board");
  const boardTitle = (text) => page.locator("#board-columns .board-card").filter({ hasText: text }).first().locator(".board-title");
  const dialog = page.locator("#review-dialog");
  await boardTitle("Альфа").click();
  await dialog.locator("#review-params-toggle").click();
  await dialog.locator("#review-people").fill("Игорь Петров");
  await dialog.locator(".card-markdown").click();
  await dialog.locator("#card-body-editor").fill("набрано сбоку перед щелчком по доске");
  await boardTitle("Бета").click();
  await expect(dialog.locator(".card-title")).toHaveText("Бета дело без заметки");
  // Панель «Параметры» одна на всю карточку: осталась открытой и у другой записи.
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator("#review-people")).toHaveValue("");
  await expect.poll(async () => (await (await request.get(`/api/captures/${alpha.id}`)).json()).entry.note?.body).toBe("набрано сбоку перед щелчком по доске");
  await expect.poll(async () => (await (await request.get(`/api/captures/${alpha.id}`)).json()).entry.interpretation.classification.entities.people).toContain("Игорь Петров");
});

test("сбоку щелчок по уже открытой записи перечитывает её на месте, а щелчок по доске поверх подзадачи сбрасывает путь назад", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const parent = await makeDeed(request, "Родитель с шагом для режима");
  await makeStep(request, parent.id, "Шаг родителя для режима");
  await makeDeed(request, "Другое дело на доске режима");
  await startInMode(page, "side");
  await page.goto("/#board");
  const boardTitle = (text) => page.locator("#board-columns .board-card").filter({ hasText: text }).first().locator(".board-title");
  const dialog = page.locator("#review-dialog");
  await boardTitle("Родитель с шагом").click();
  await expect(dialog.locator(".card-title")).toHaveText("Родитель с шагом для режима");

  // Та же запись ещё раз: набранное в панели не пропадает, карточка остаётся.
  await dialog.locator("#review-params-toggle").click();
  await dialog.locator("#review-people").fill("Игорь Петров");
  await boardTitle("Родитель с шагом").click();
  await expect(dialog.locator(".card-title")).toHaveText("Родитель с шагом для режима");
  await expect(dialog.locator("#review-people")).toHaveValue("Игорь Петров");
  await expect.poll(async () => (await (await request.get(`/api/captures/${parent.id}`)).json()).entry.interpretation.classification.entities.people).toContain("Игорь Петров");
  await dialog.locator("#review-params-toggle").click();

  // Подзадача открыта в той же карточке, путь назад — к родителю.
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-title")).toHaveText("Шаг родителя для режима");
  await expect(dialog.locator(".card-return")).toBeVisible();
  // Другая запись с доски встаёт на место подзадачи: пути назад больше нет.
  await boardTitle("Другое дело").click();
  await expect(dialog.locator(".card-title")).toHaveText("Другое дело на доске режима");
  await expect(dialog.locator(".card-return")).toHaveCount(0);
  await expect(dialog.locator(".card-nav-crumb")).toContainText("из");
});

test("сбоку Esc идёт по слоям: меню режимов, панель «Параметры», потом карточка", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело для слоёв Esc сбоку");
  await startInMode(page, "side");
  await openByLink(page, deed.id);
  const dialog = page.locator("#review-dialog");
  const menu = dialog.locator("#review-mode-menu");
  await dialog.locator("#review-mode-toggle").click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.locator("#review-params-toggle").click();
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Esc в заметке: поле отпускает фокус, а карточка закрывается и сохраняет написанное.
  await openByLink(page, deed.id);
  await dialog.locator(".card-markdown").click();
  await dialog.locator("#card-body-editor").fill("записано и закрыто Esc сбоку");
  await page.locator("#card-body-editor").press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await (await request.get(`/api/captures/${deed.id}`)).json()).entry.note?.body).toBe("записано и закрыто Esc сбоку");
});

test("во весь экран карточка занимает весь экран, содержимое и нижняя полоса стоят по центру колонкой до 980px", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело на весь экран");
  await request.post(`/api/captures/${deed.id}/notes`, { data: { body: "Описание дела, которое читается как страница." } });
  await startInMode(page, "full");
  await openByLink(page, deed.id);
  const dialog = page.locator("#review-dialog");
  const box = await dialog.boundingBox();
  expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, 1440, 900]);
  expect(await isModal(page)).toBe(true);
  // Без рамки и тени: как страница.
  await expect(dialog).toHaveCSS("border-radius", "0px");
  await expect(dialog).toHaveCSS("box-shadow", "none");
  // Верхняя строка тянется на весь экран, содержимое — колонка до 980px по центру.
  const top = await dialog.locator(".card-top").boundingBox();
  expect(Math.round(top.width)).toBe(1440);
  const body = await dialog.locator(".card-body").boundingBox();
  expect(body.width).toBeLessThanOrEqual(980);
  expect(Math.abs(body.x + body.width / 2 - 720)).toBeLessThan(2);
  const field = await dialog.locator(".thread-composer").boundingBox();
  expect(field.width).toBeLessThanOrEqual(980);
  expect(Math.abs(field.x + field.width / 2 - 720)).toBeLessThan(2);
  // Ручек размера у страницы нет.
  for (const grip of await dialog.locator(".card-resize").all()) await expect(grip).toBeHidden();
  // Параметры встают у правого края, колонка остаётся по центру оставшегося.
  await dialog.locator("#review-params-toggle").click();
  await expect(dialog.locator("#review-props")).toBeVisible();
  await settled(page);
  const panel = await dialog.locator("#review-params").boundingBox();
  expect(Math.round(panel.x + panel.width)).toBe(1440);
  // Esc и крестик закрывают.
  await page.keyboard.press("Escape");
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openByLink(page, deed.id);
  await dialog.locator("#review-close").click();
  await expect(dialog).toBeHidden();
});

test("по центру высота идёт за содержимым: длинная карточка выше короткой, обе в зазорах экрана, нижняя полоса прижата ко дну", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const short = await makeDeed(request, "Короткое дело без описания");
  const long = await makeDeed(request, "Длинное дело с описанием и подзадачами");
  await request.post(`/api/captures/${long.id}/notes`, {
    data: { body: Array.from({ length: 8 }, (_, index) => `Абзац ${index + 1}: длинное описание дела, которое занимает несколько строк и не помещается в окно целиком.`).join("\n\n") },
  });
  for (const title of ["Найти блокнот", "Проверить страницы", "Положить в сумку", "Перечитать заметки", "Выписать вопросы", "Позвонить Ане"]) await makeStep(request, long.id, title);
  const dialog = page.locator("#review-dialog");
  const measure = async (id) => {
    await openByLink(page, id);
    await expect(dialog.locator(".thread-composer")).toBeVisible();
    const result = { box: await dialog.boundingBox(), field: await dialog.locator(".thread-composer").boundingBox() };
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    return result;
  };
  const a = await measure(short.id);
  const b = await measure(long.id);
  expect(b.box.height).toBeGreaterThan(a.box.height + 100);
  for (const { box, field } of [a, b]) {
    // Зазор 40px сверху и снизу: выше экрана окно не вырастает.
    expect(Math.round(box.y)).toBe(40);
    expect(box.height).toBeLessThanOrEqual(900 - 80 + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(900 - 40 + 0.5);
    // Полоса с полем «Написать себе…» прижата ко дну окна у короткой и у длинной.
    expect(Math.abs(box.y + box.height - (field.y + field.height) - 16)).toBeLessThanOrEqual(3);
  }
  // Экран пониже — потолок ниже: окно по-прежнему в зазорах, а основная часть прокручивается.
  await page.setViewportSize({ width: 1440, height: 640 });
  await openByLink(page, long.id);
  const low = await dialog.boundingBox();
  expect(Math.round(low.height)).toBe(640 - 80);
  expect(Math.round(low.y)).toBe(40);
  expect(await dialog.locator("#review").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  // Закрытая панель «Параметры» не занимает места и не тянет высоту окна.
  await expect(dialog.locator("#review-params")).toBeHidden();
  expect(await dialog.locator("#review-params").evaluate((element) => getComputedStyle(element).display)).toBe("none");
});

test("разговор разворачивается над полем и не меняет высоту окна по центру", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело с перепиской для высоты окна");
  for (const body of ["Первое сообщение в разговоре", "Второе сообщение в разговоре"])
    expect((await request.post(`/api/captures/${deed.id}/comments`, { data: { body } })).ok()).toBe(true);
  await openByLink(page, deed.id);
  const dialog = page.locator("#review-dialog");
  const height = async () => Math.round((await dialog.boundingBox()).height);
  // Свёрнутый разговор — пузырь над полем; окно стоит по содержимому.
  await expect(dialog.locator(".talk-peek")).toBeVisible();
  await expect(dialog.locator(".talk-panel")).toBeHidden();
  const folded = await height();
  await dialog.locator(".talk-peek").click();
  await expect(dialog).toHaveClass(/talk-open/);
  await expect(dialog.locator(".talk-panel")).toBeVisible();
  await settled(page);
  // Развёрнутый разговор встаёт поверх заметок, а окно остаётся того же роста.
  expect(await height()).toBe(folded);
  const box = await dialog.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(900 - 40 + 0.5);
  // Свернули — всё на месте.
  await dialog.locator(".talk-close").click();
  await expect(dialog.locator(".talk-panel")).toBeHidden();
  expect(await height()).toBe(folded);
});

test("ручки размера: правый край тянет ширину, размер помнится после перезагрузки, двойной клик возвращает умолчание", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело для ручек размера");
  await openByLink(page, deed.id);
  const dialog = page.locator("#review-dialog");
  const size = async () => { const box = await dialog.boundingBox(); return [Math.round(box.width), Math.round(box.height)]; };
  const grip = (dir) => dialog.locator(`.card-resize[data-dir="${dir}"]`);
  const [width0, height0] = await size();
  expect(width0).toBe(880);
  // Пять невидимых полос, о которых говорит только курсор.
  const cursors = await dialog.locator(".card-resize").evaluateAll((elements) => Object.fromEntries(elements.map((element) => [element.dataset.dir, getComputedStyle(element).cursor])));
  expect(cursors).toEqual({ e: "ew-resize", w: "ew-resize", s: "ns-resize", se: "nwse-resize", sw: "nesw-resize" });

  // Окно по центру стоит посередине: край идёт за курсором, ширина растёт вдвое.
  await dragBy(page, grip("e"), 60, 0);
  expect(await size()).toEqual([1000, height0]);
  // Маленькая подпись с размером остаётся на мгновение после отпускания.
  await expect(dialog.locator("#review-size-badge")).toHaveText(`1000 × ${height0}`);
  await expect(dialog.locator("#review-size-badge")).toHaveCSS("opacity", "1");
  expect(JSON.parse(await storedValue(page, "kizuna-card-size"))).toEqual({ w: 1000, h: null, sw: null });
  await page.reload();
  await openByLink(page, deed.id);
  expect(await size()).toEqual([1000, height0]);

  // Нижний угол тянет и ширину, и высоту: верх остаётся на месте.
  await dragBy(page, grip("se"), 40, 50);
  expect(await size()).toEqual([1080, height0 + 50]);
  expect(Math.round((await dialog.boundingBox()).y)).toBe(40);
  expect(JSON.parse(await storedValue(page, "kizuna-card-size"))).toEqual({ w: 1080, h: height0 + 50, sw: null });
  // Пределы: не уже 560 и не шире экрана без зазоров, не ниже 360 и не выше 820.
  await dragBy(page, grip("e"), -700, 0);
  expect((await size())[0]).toBe(560);
  await dragBy(page, grip("e"), 430, 0);
  expect((await size())[0]).toBe(1440 - 48);
  await dragBy(page, grip("s"), 0, -700);
  expect((await size())[1]).toBe(360);
  await dragBy(page, grip("s"), 0, 480);
  expect((await size())[1]).toBe(900 - 80);

  // Двойной клик по ручке возвращает размер по умолчанию: 880 и высота по содержимому.
  await grip("e").dblclick();
  expect(await size()).toEqual([880, height0]);
  expect(await storedValue(page, "kizuna-card-size")).toBeNull();
  // Простой щелчок по краю размера не меняет и не запоминает.
  await grip("s").click();
  expect(await size()).toEqual([880, height0]);
  expect(await storedValue(page, "kizuna-card-size")).toBeNull();
});

test("сбоку тянется только левый край, ширина панели помнится отдельно от размера окна по центру", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deed = await makeDeed(request, "Дело для ширины панели");
  await startInMode(page, "side");
  await openByLink(page, deed.id);
  const dialog = page.locator("#review-dialog");
  const width = async () => Math.round((await dialog.boundingBox()).width);
  expect(await width()).toBe(Math.round(1440 * 0.56));
  // Из пяти ручек виден только левый край.
  for (const dir of ["e", "s", "se", "sw"]) await expect(dialog.locator(`.card-resize[data-dir="${dir}"]`)).toBeHidden();
  const left = dialog.locator('.card-resize[data-dir="w"]');
  await expect(left).toBeVisible();
  await dragBy(page, left, -100, 0);
  expect(await width()).toBe(Math.round(1440 * 0.56) + 100);
  expect(JSON.parse(await storedValue(page, "kizuna-card-size"))).toEqual({ w: null, h: null, sw: Math.round(1440 * 0.56) + 100 });
  // Пределы: не уже 420 и оставляет доске 200px.
  await dragBy(page, left, 800, 0);
  expect(await width()).toBe(420);
  await dragBy(page, left, -900, 0);
  expect(await width()).toBe(1440 - 200);
  await page.reload();
  await openByLink(page, deed.id);
  expect(await width()).toBe(1440 - 200);
  // Двойной клик возвращает 56%.
  await left.dblclick();
  expect(await width()).toBe(Math.round(1440 * 0.56));
  expect(await storedValue(page, "kizuna-card-size")).toBeNull();
});

test("высота поля обсуждения тянется верхней кромкой, помнится для всех карточек и режимов, двойной клик возвращает прежнюю", async ({ page, request }) => {
  await resetAll(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const one = await makeDeed(request, "Первое дело для поля обсуждения");
  const two = await makeDeed(request, "Второе дело для поля обсуждения");
  await openByLink(page, one.id);
  const dialog = page.locator("#review-dialog");
  const composer = dialog.locator(".thread-composer");
  const grip = dialog.locator(".talk-resize");
  const height = async () => Math.round((await composer.boundingBox()).height);
  const base = await height();
  await expect(grip).toHaveCSS("cursor", "ns-resize");

  // Потянули верхний край вверх на 80px — поле выросло на столько же.
  await dragBy(page, grip, 0, -80);
  expect(await height()).toBe(base + 80);
  expect(await storedValue(page, "kizuna-card-talk-height")).toBe(String(base + 80));
  // Окно остаётся в зазорах, нижняя полоса по-прежнему прижата ко дну.
  const box = await dialog.boundingBox();
  const field = await composer.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(900 - 40 + 0.5);
  expect(Math.abs(box.y + box.height - (field.y + field.height) - 16)).toBeLessThanOrEqual(3);
  // Поле — это textarea во всю высоту, а не пустая рамка вокруг узкой строки.
  expect(Math.round((await dialog.locator(".thread-input").boundingBox()).height)).toBe(base + 80 - 8);

  // После перезагрузки и в другой карточке высота та же.
  await page.reload();
  await openByLink(page, two.id);
  expect(await height()).toBe(base + 80);
  // В другом режиме — тоже: высота одна на все карточки и все режимы.
  await dialog.locator("#review-mode-toggle").click();
  await dialog.locator("#review-mode-menu").getByRole("menuitemradio").nth(1).click();
  await expect(dialog).toHaveAttribute("data-mode", "side");
  expect(await height()).toBe(base + 80);
  // Пределы: не ниже привычной строки и не выше 360px.
  await dragBy(page, grip, 0, -500);
  expect(await height()).toBe(360);
  await dragBy(page, grip, 0, 350);
  expect(await height()).toBe(base);
  // Двойной клик по кромке возвращает прежнюю высоту — по содержимому.
  await dragBy(page, grip, 0, -50);
  expect(await height()).toBe(base + 50);
  await grip.dblclick();
  expect(await height()).toBe(base);
  expect(await storedValue(page, "kizuna-card-talk-height")).toBeNull();
});

for (const mode of ["center", "side", "full"]) {
  test(`на телефоне режим «${mode}» — карточка во весь экран, модальная, без меню режимов`, async ({ page, request }) => {
    await resetAll(request);
    await page.setViewportSize({ width: 390, height: 844 });
    const deed = await makeDeed(request, "Дело для телефона в режимах");
    await startInMode(page, mode);
    await openByLink(page, deed.id);
    const dialog = page.locator("#review-dialog");
    const box = await dialog.boundingBox();
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, 390, 844]);
    expect(await isModal(page)).toBe(true);
    await expect(dialog.locator("#review-modes")).toBeHidden();
    for (const grip of await dialog.locator(".card-resize").all()) await expect(grip).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
    await dialog.locator("#review-close").click();
    await expect(dialog).toBeHidden();
  });
}
