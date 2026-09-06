import { test, expect } from "@playwright/test";

async function capture(page, raw) {
  const posted = page.waitForResponse(
    (response) => response.url().endsWith("/api/captures") && response.request().method() === "POST",
  );
  await page.getByLabel("Новая запись").fill(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect((await posted).status()).toBe(202);
  await expect(page.locator("#capture-notifications")).toContainText(raw);
}

async function openCard(page, listSelector, raw) {
  const card = page.locator(`${listSelector} .entry`).filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await card.locator(".entry-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
}

test("the card shows properties as rows and hides the ones the type does not use", async ({ page }) => {
  const raw = "Нужно проверить Hub для карточки";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  for (const label of ["Тип", "Срок", "Проект", "Участники", "Далее", "Сделано"]) {
    await expect(page.locator(".prop-label", { hasText: label })).toBeVisible();
  }
  await page.locator("#review-primary-type").selectOption("note");
  await expect(page.locator("#review-people")).toBeHidden();
  await expect(page.locator("#review-date")).toBeHidden();
  await page.locator("#review-primary-type").selectOption("meeting_event");
  await expect(page.locator("#review-date")).toBeVisible();
});

test("the card opens from the board list, where the panel used to build on a hidden page", async ({ page }) => {
  const raw = "Нужно проверить карточку из списка";
  await page.goto("/");
  await capture(page, raw);
  await page.evaluate(() => { location.hash = "#board?view=list"; });
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
  await expect(page.locator(".card-body .prop-section")).toContainText("версия 1");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = entries.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("## План");
});

test("the note body starts from the original capture without creating a note", async ({ page }) => {
  const raw = "Нужно проверить заготовку тела из оригинала";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await expect(page.locator(".card-markdown")).toContainText(raw);
  await expect(page.locator(".card-body .prop-section")).toContainText("из исходной записи");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  expect(entries.entries.find((item) => item.raw === raw).note).toBeNull();

  await page.locator(".card-markdown").click();
  await expect(page.locator("#card-body-editor")).toHaveText(raw);
  await page.locator("#card-body-editor").fill(`${raw}\n\n- дописал пункт`);
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await expect(page.locator(".card-markdown .md-bullet")).toBeVisible();
  await expect(page.locator(".card-markdown")).toContainText("дописал пункт");
  await expect(page.locator(".card-body .prop-section")).toContainText("версия 1");

  const after = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = after.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("дописал пункт");
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

test("closing a task removes it from today without filing it as reported work", async ({ page }) => {
  const raw = "Нужно проверить уход закрытой задачи";
  await page.goto("/");
  await capture(page, raw);
  const card = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Готово" }).click();

  await expect(page.locator("#todo")).not.toContainText(raw);
  // дневник — это записи-отчёты, закрытие задачи отчётом не является
  await expect(page.locator("#journal")).not.toContainText(raw);
  await expect(page.locator("#notes")).not.toContainText(raw);

  // С открытых дел доски оно тоже ушло, но лежит хвостом списка в «Закрытых» —
  // там же его возвращают в работу.
  await page.evaluate(() => { location.hash = "#board?view=list"; });
  const openCards = page.locator("#board-columns .board-column.dated:not(.closed) .board-card");
  await expect(openCards.filter({ hasText: raw })).toHaveCount(0);
  const closed = page.locator("#board-columns .board-column.closed .board-card").filter({ hasText: raw }).first();
  await expect(closed).toBeVisible();
  await closed.getByRole("button", { name: /Вернуть в работу/ }).click();
  await expect(page.locator("#board-columns .board-column.closed")).toHaveCount(0);
  await expect(openCards.filter({ hasText: raw })).toHaveCount(1);

  await page.evaluate(() => { location.hash = "#today"; });
  await expect(page.locator("#todo")).toContainText(raw);
});

test("a closed entry never shows up among notes", async ({ page }) => {
  // Решение с отдельным действием получает проекции outcome_decision + task:
  // запись живёт в заметках, но закрывается как дело.
  const raw = "Решили по TCAM, нужно отправить протокол";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#notes")).toContainText(raw);

  const noteCard = page.locator("#notes .entry").filter({ hasText: raw }).first();
  await noteCard.getByRole("button", { name: "Готово" }).click();

  await expect(page.locator("#notes")).not.toContainText(raw);
  await expect(page.locator("#journal")).not.toContainText(raw);
  // После перезагрузки закрытая запись в заметки не возвращается: закрыта по данным.
  await page.reload();
  await expect(page.locator("#notes .entry")).toHaveCount(0);
  const entries = await (await page.request.get("/api/entries")).json();
  const entry = entries.entries.find((candidate) => candidate.raw === raw);
  expect(entry.projections.filter((p) => p.type === "task").every((p) => p.completion?.completed)).toBe(true);
});

test("the done toggle overrides the model and moves the entry into reported work", async ({ page }) => {
  const raw = "Нужно проверить переключатель завершения";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  await openCard(page, "#todo", raw);

  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await page.locator("#review-completed").click();
  await expect(page.locator("#review-completed")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#review-close").click();
  await expect(page.locator("#journal")).toContainText(raw);
  await expect(page.locator("#todo")).not.toContainText(raw);
});

test("properties changed in the card are saved when Escape closes it", async ({ page }) => {
  const raw = "Нужно проверить сохранение свойств по Esc";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  await openCard(page, "#todo", raw);

  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await page.locator("#review-project").fill("Проект по Esc");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/corrections") && response.request().method() === "POST",
  );
  // Esc закрывает диалог сам, мимо крестика: правки должны уйти и этим путём.
  await page.locator("#review-project").press("Escape");
  expect((await saved).status()).toBe(200);
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(page.locator("#todo .entry").filter({ hasText: raw })).toContainText("Проект по Esc");
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
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  // Поле потрогали, но значение прежнее — уточнения быть не должно.
  const project = page.locator("#review-project");
  await project.fill(await project.inputValue());
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

  // Перенос строки и блочная разметка.
  await page.keyboard.press("Enter");
  await page.keyboard.type("# Заголовок");
  await page.keyboard.press("Enter");
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
  const card = page.locator(".entry").filter({ hasText: "жирный" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".entry-title strong")).toHaveText("жирный");
  await card.locator(".entry-title").click();
  await expect(page.locator("#review h2 code")).toHaveText("кодом");

  // В карточке — то же живое поле: печатаем и разметка оформляется на месте.
  const noteField = page.locator("#card-body-editor");
  await noteField.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" --правка-- в **карточке**");
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
  const card = page.locator("#today .entry").filter({ hasText: "Разбор недели" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator(".entry-title").click();
  await page.locator(".card-source summary").click();

  // Пока заметку не правили, её тело — копия записи, и текст не дублируется.
  await expect(page.locator(".review-raw")).toContainText("совпадает с заметками");
  await expect(page.locator(".card-source .md-block")).toHaveCount(0);

  // После правки заметки источник показывает исходную запись готовым видом.
  const body = page.locator("#card-body-editor");
  await body.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" правка");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await body.press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);
  // Блок источника собирается при открытии карточки, поэтому переоткрываем её.
  await page.locator("#review-close").click();
  await card.locator(".entry-title").click();
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
  const card = page.locator("#today .entry").filter({ hasText: "Разбор недели" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".entry-title")).toHaveText("Разбор недели …");
  await card.locator(".entry-title").click();
  await expect(page.locator("#review h2")).toHaveText("Разбор недели …");

  // Тело карточки ведёт себя ровно как поле ввода: живая разметка,
  // продолжение списка по Enter и кликабельный чекбокс.
  const body = page.locator("#card-body-editor");
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
  await expect(page.locator(".card-body .prop-section")).toContainText("версия 1");
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

test("the expand button lifts the card into a sheet fitted to the window", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const form = page.locator("#capture-form");
  const field = page.getByLabel("Новая запись");
  const expand = page.locator("#capture-expand");

  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await field.click();
  await page.keyboard.type("# Заметка на листе");
  const before = await form.boundingBox();

  await expand.click();
  await expect(form).toHaveClass(/capture-large/);
  await expect(page.locator("body")).toHaveClass(/capture-large-open/);
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(350);

  // Лист выходит на передний план и вписан в окно с большими отступами.
  await expect(form).toHaveCSS("position", "fixed");
  const sheet = await form.boundingBox();
  const viewport = page.viewportSize();
  expect(sheet.height).toBeGreaterThan(before.height * 2);
  expect(sheet.height).toBeLessThan(viewport.height);
  expect(sheet.y).toBeGreaterThan(20);
  expect(sheet.x).toBeGreaterThan(100);
  // Пропорция листа — чуть шире A4. Допуск на округление пикселей.
  expect(sheet.height / sheet.width).toBeGreaterThan(1.26);
  expect(sheet.height / sheet.width).toBeLessThan(1.34);
  // Страница под листом не прокручивается.
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  // Текст, фокус и разметка на месте: DOM не перестраивался.
  await expect(field.locator(".md-heading")).toHaveText("Заметка на листе");
  await expect(field).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] пункт");
  await expect(field.locator(".md-checkbox")).toHaveCount(1);

  // Esc возвращает карточку на место, ничего не потеряв.
  await page.keyboard.press("Escape");
  await expect(form).not.toHaveClass(/capture-large/);
  await expect(page.locator("body")).not.toHaveClass(/capture-large-open/);
  await expect(form).toHaveCSS("position", "static");
  await expect(field.locator(".md-heading")).toHaveText("Заметка на листе");

  // Отправка с листа возвращает карточку к обычному виду.
  await expand.click();
  const posted = page.waitForRequest(
    (request_) => request_.url().endsWith("/api/captures") && request_.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toContain("# Заметка на листе");
  await expect(form).not.toHaveClass(/capture-large/);
  await expect(field).toHaveText("");
});

test("on a phone the sheet fills the screen without overflow", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("# Заметка на телефоне");
  await page.locator("#capture-expand").click();
  await page.waitForTimeout(350);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  const sheet = await page.locator("#capture-form").boundingBox();
  // Пропорция A4 на телефоне не выдерживается: важнее место под текст.
  expect(sheet.width).toBeGreaterThan(340);
  expect(sheet.height).toBeGreaterThan(690);
  // Подвал остаётся внутри листа.
  const foot = await page.locator(".capture-foot").boundingBox();
  expect(foot.y + foot.height).toBeLessThanOrEqual(sheet.y + sheet.height + 1);
});

test("лист и карточка тихо проявляются, а не летят через экран", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  // Движение в приложении одно на всё: короткое проявление на месте. Ни
  // перелёта из точки клика, ни роста размеров, ни масштаба — только
  // прозрачность и мягкий сдвиг по вертикали.
  const form = page.locator("#capture-form");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("# Заметка на листе");
  await page.locator("#capture-expand").click();
  const sheetFrames = await form.evaluate((node) =>
    node.getAnimations().map((animation) => ({
      duration: animation.effect.getTiming().duration,
      keys: animation.effect.getKeyframes().map((frame) => ({
        opacity: frame.opacity,
        transform: frame.transform,
        width: frame.width,
      })),
    })),
  );
  expect(sheetFrames.length).toBe(1);
  expect(sheetFrames[0].duration).toBe(300);
  const [first, last] = sheetFrames[0].keys;
  expect(first.opacity).toBe("0");
  expect(last.opacity).toBe("1");
  // Постоянное смещение листа остаётся на месте, к нему добавлен только сдвиг.
  expect(first.transform).toContain("translate(-50%, -50%)");
  expect(first.transform).toContain("translateY(12px)");
  expect(last.transform).toBe("translate(-50%, -50%)");
  // Размеры не анимируются вовсе: их считает раскладка.
  expect(first.width).toBeUndefined();

  await page.waitForTimeout(400);
  const sheet = await form.boundingBox();
  // Пропорция листа — чуть шире A4. Допуск на округление пикселей.
  expect(sheet.height / sheet.width).toBeGreaterThan(1.26);
  expect(sheet.height / sheet.width).toBeLessThan(1.34);
  await page.keyboard.press("Escape");

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

// Раньше карточка повторяла «лист» выросшего поля ввода. Теперь открытая
// запись — страница Notion: широкий центральный peek с колонкой контента
// 708px, а лист остался только у поля ввода.
test("the entry card opens as a notion page: wide peek with a 708px column", async ({ page, request }) => {
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

  // Геометрия peek: ширина min(940, окно − 48), высота min(1024, окно − 24).
  const card = await page.locator("#review-dialog").boundingBox();
  expect(Math.round(card.width)).toBe(940);
  expect(Math.round(card.height)).toBe(900 - 24);

  // Контент собран в колонку страницы, как в Notion: сам #review — прокрутка
  // во всю ширину, колонку задают его поля, поэтому меряем заголовок.
  const column = await page.locator("#review h2").boundingBox();
  expect(Math.round(column.width)).toBeLessThanOrEqual(708);
  // Колонка стоит по центру peek, а не прижата к краю.
  const offCenter = Math.abs(column.x + column.width / 2 - (card.x + card.width / 2));
  expect(offCenter).toBeLessThan(16);
});

// Размер карточки меняется мышкой за край и угол: тянется симметрично, чтобы
// остаться по центру, запоминается между открытиями, двойной клик по краю
// возвращает исходный.
test("the card is resized by dragging its edge, the size survives reopening", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для растягивания");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "растягивания" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();
  await page.waitForTimeout(760);

  const dialog = page.locator("#review-dialog");
  const before = await dialog.boundingBox();
  expect(Math.round(before.width)).toBe(940);

  // Правый край на 60px правее: карточка шире на 120 и по-прежнему по центру.
  const edge = await dialog.locator('.card-resize[data-dir="e"]').boundingBox();
  const x = edge.x + edge.width / 2,
    y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y);
  await page.mouse.move(x + 60, y);
  await page.mouse.up();
  const wider = await dialog.boundingBox();
  expect(Math.round(wider.width)).toBe(1060);
  expect(Math.abs(wider.x + wider.width / 2 - (before.x + before.width / 2))).toBeLessThan(2);
  expect(Math.round(wider.height)).toBe(Math.round(before.height));

  // Нижний угол вверх: ниже не стало, а высота уменьшилась на 80.
  const corner = await dialog.locator('.card-resize[data-dir="se"]').boundingBox();
  const cx = corner.x + 6,
    cy = corner.y + 6;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 20);
  await page.mouse.move(cx, cy - 40);
  await page.mouse.up();
  const shorter = await dialog.boundingBox();
  expect(Math.round(shorter.width)).toBe(1060);
  expect(Math.round(shorter.height)).toBe(Math.round(before.height) - 80);

  // Закрыли, открыли заново — размер тот же.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await entry.locator(".entry-title").click();
  await page.waitForTimeout(760);
  const reopened = await dialog.boundingBox();
  expect(Math.round(reopened.width)).toBe(1060);
  expect(Math.round(reopened.height)).toBe(Math.round(before.height) - 80);

  // Двойной клик по краю возвращает исходный размер.
  await dialog.locator('.card-resize[data-dir="e"]').dblclick();
  const reset = await dialog.boundingBox();
  expect(Math.round(reset.width)).toBe(940);
  expect(Math.round(reset.height)).toBe(Math.round(before.height));
  // Карточка при этом не закрылась: клики по ручкам — не клик по подложке.
  await expect(dialog).toBeVisible();
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
  await expect(remove).toHaveText("Удалить запись");
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

test("статус записи — значком и словом: под заголовком и в свёрнутой строке", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const raw = "Нужно проверить статус на карточке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  // Дело без срока: статус назван словом и ведёт свёрнутую строку свойств,
  // которая стоит выше «Записано» — первой строкой карточки.
  await expect(page.locator("#review-dialog .props-summary .entry-status")).toHaveText("Без срока");
  const barBox = await page.locator("#review-dialog .props-bar").boundingBox();
  const writtenBox = await page.locator("#review-dialog .card-written").boundingBox();
  expect(barBox.y).toBeLessThan(writtenBox.y);
  // Статус на карточке один — дубля под заголовком нет.
  expect(await page.locator("#review-dialog .entry-status").count()).toBe(1);
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
  await expect(page.locator("#review-dialog .props-summary .entry-status")).toHaveText("Сделано");
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

test("an unclassified capture lives in notes, not in the todo buffer, until it is typed as a deed", async ({ page }) => {
  const raw = "Созвон с Женей был по доработкам [[сбой модели]]";
  await page.goto("/");
  await capture(page, raw);
  // Модель упала — запись сохранена заметкой без разбора: место ей в «Заметках».
  await expect(page.locator("#notes")).toContainText("Созвон с Женей");
  await expect(page.locator("#todo")).not.toContainText("Созвон с Женей");
  await openCard(page, "#notes", "Созвон с Женей");
  await expect(page.locator(".review-question")).toContainText("без разбора");
  // Человек назвал её задачей — теперь это дело, и оно в TODO.
  await page.locator("#review-primary-type").selectOption("task");
  await page.locator("#review-close").click();
  await expect(page.locator("#todo")).toContainText("Созвон с Женей");
  await expect(page.locator("#notes")).not.toContainText("Созвон с Женей");
});

test("on a phone the card stays pinned to the screen while the page behind is scrolled, and paste lands in the note", async ({ page }) => {
  const raw = "Нужно проверить карточку на телефоне";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await capture(page, raw);
  // Список прокручен вниз — в верхнем слое relative-диалог открывался бы
  // выше экрана, у начала документа.
  await page.evaluate(() => { location.hash = "#board?view=list"; });
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
