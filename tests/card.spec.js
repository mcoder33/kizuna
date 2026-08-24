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

  for (const label of ["Тип", "Срок", "Проект", "Участники", "Далее", "Сделано"]) {
    await expect(page.locator(".prop-label", { hasText: label })).toBeVisible();
  }
  await page.locator("#review-primary-type").selectOption("note");
  await expect(page.locator("#review-people")).toBeHidden();
  await expect(page.locator("#review-date")).toBeHidden();
  await page.locator("#review-primary-type").selectOption("meeting_event");
  await expect(page.locator("#review-date")).toBeVisible();
});

test("the card opens from the journal, where the panel used to build on a hidden page", async ({ page }) => {
  const raw = "Нужно проверить журнальную карточку";
  await page.goto("/");
  await capture(page, raw);
  await page.evaluate(() => { location.hash = "#history-todo"; });
  await openCard(page, "#history-todo-list", raw);
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

  const rendered = page.locator(".card-markdown");
  await expect(rendered.locator("h4")).toContainText("План");
  await expect(rendered.locator("li strong")).toContainText("первый");
  await expect(rendered.locator("li code")).toContainText("код");
  await expect(rendered.locator("blockquote")).toContainText("цитата");

  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await openCard(page, "#todo", raw);
  await expect(page.locator(".card-markdown h4")).toContainText("План");
  await expect(page.locator(".prop-section")).toContainText("версия 1");

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
  await expect(page.locator(".prop-section")).toContainText("из исходной записи");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  expect(entries.entries.find((item) => item.raw === raw).note).toBeNull();

  await page.locator(".card-markdown").click();
  await expect(page.locator("#card-body-editor")).toHaveValue(raw);
  await page.locator("#card-body-editor").fill(`${raw}\n\n- дописал пункт`);
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await expect(page.locator(".card-markdown li")).toContainText("дописал пункт");
  await expect(page.locator(".prop-section")).toContainText("версия 1");

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

test("escape leaves the note unsaved and keeps the card open", async ({ page }) => {
  const raw = "Нужно проверить отмену заметки";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill("черновик, который не нужен");
  await page.locator("#card-body-editor").press("Escape");
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#card-body-editor")).toBeHidden();
  await expect(page.locator(".card-markdown")).not.toContainText("черновик");
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

  await page.evaluate(() => { location.hash = "#history-work"; });
  await expect(page.locator("#history-work-list")).not.toContainText(raw);

  await page.evaluate(() => { location.hash = "#history-todo"; });
  const closed = page.locator("#history-todo-list .closed-group .entry").filter({ hasText: raw }).first();
  await expect(closed).toBeVisible();
  await closed.getByRole("button", { name: "Вернуть в работу" }).click();
  await expect(page.locator("#history-todo-list .closed-group")).toHaveCount(0);

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
  await page.evaluate(() => { location.hash = "#history-notes"; });
  await expect(page.locator("#history-notes-list")).not.toContainText(raw);
  await page.evaluate(() => { location.hash = "#history-todo"; });
  await expect(page.locator("#history-todo-list .closed-group")).toContainText(raw);
});

test("the done toggle overrides the model and moves the entry into reported work", async ({ page }) => {
  const raw = "Нужно проверить переключатель завершения";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  await openCard(page, "#todo", raw);

  await page.locator("#review-completed").click();
  await expect(page.locator("#review-completed")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Сохранить уточнение" }).click();
  await expect(page.locator("#journal")).toContainText(raw);
  await expect(page.locator("#todo")).not.toContainText(raw);
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

  // Живой предпросмотр в редакторе заметки.
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill("## Итог\n- сделал **раз**");
  const notePreview = page.locator("#card-body-preview");
  await expect(notePreview).toBeVisible();
  await expect(notePreview.locator("h4")).toHaveText("Итог");
  await expect(notePreview.locator("li strong")).toHaveText("раз");
});
