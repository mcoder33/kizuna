import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
const makePage = async (request, title, parent) => (await (await request.post("/api/pages", { data: parent ? { title, parent } : { title } })).json()).page;

test("«Заметки» стоят в шапке вместо «Обзора», а обзор открывается по адресу", async ({ page, request }) => {
  await reset(request);
  await page.goto("/");
  await expect(page.locator('nav a[href="#notes"]')).toHaveText("Заметки");
  await expect(page.locator('nav a[href="#reports"]')).toHaveCount(0);
  await page.locator('nav a[href="#notes"]').click();
  await expect(page.locator("#notes")).toBeVisible();
  await expect(page.locator(".notes-side")).toContainText("Входящие");
  await page.goto("/#reports");
  await expect(page.locator("#reports")).toBeVisible();
});

test("новая страница: название, текст со ссылкой, место в дереве и обратная ссылка", async ({ page, request }) => {
  await reset(request);
  const home = await makePage(request, "Кизуна");
  await page.goto("/#notes");
  await page.locator(".notes-side-add[aria-label='Новая страница']").click();
  const title = page.locator(".notes-title");
  await expect(title).toBeFocused();
  await page.keyboard.type("Планы на осень");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notes-markdown")).toBeFocused();
  await page.keyboard.type("Смотри [[Кизуна]]");
  // Текст сохраняется сам — версия появляется в полосе над страницей.
  await expect(page.locator("#notes-version")).toContainText("версия 2", { timeout: 5000 });
  await expect(page.locator(".notes-side .notes-row", { hasText: "Планы на осень" })).toBeVisible();
  // Сохранение будит журнал, и страница обновляется в фоне — но поле не
  // теряет фокус: набор продолжается с того же места.
  await page.waitForTimeout(600);
  await expect(page.locator(".notes-markdown")).toBeFocused();
  await page.keyboard.type(" и дальше");
  await expect(page.locator(".notes-markdown")).toHaveText("Смотри [[Кизуна]] и дальше");

  // Место — через выбор: страница уходит внутрь «Кизуны».
  await page.locator(".notes-prop-button").click();
  await page.locator(".notes-picker-input").fill("Кизу");
  await page.locator(".notes-picker-row", { hasText: "Кизуна" }).first().click();
  await expect(page.locator(".notes-crumbs")).toContainText("Кизуна");
  await expect(page.locator(".notes-props")).toContainText("указано");

  // Ссылка в готовом тексте ведёт на страницу, а там видно, кто на неё ссылается.
  await title.click();
  await page.locator(".notes-markdown .md-wikilink", { hasText: "Кизуна" }).click();
  await expect(page).toHaveURL(new RegExp(`page=${home.id}`));
  await expect(title).toHaveText("Кизуна");
  const backlinks = page.locator(".notes-section", { hasText: "Ссылаются сюда" });
  await expect(backlinks).toContainText("Планы на осень");
  await expect(page.locator(".notes-children")).toContainText("Планы на осень");
});

test("заметка с «Сегодня» ждёт во «Входящих» и раскладывается по подсказке", async ({ page, request }) => {
  await reset(request);
  const release = await makePage(request, "Релиз 1.4");
  const { entry } = await (await request.post("/api/captures", { data: { raw: "Про релиз 1.4: changelog и круги" } })).json();
  await page.goto("/#notes?view=inbox");
  const row = page.locator(".notes-inbox-row", { hasText: "Про релиз 1.4" });
  await expect(row).toBeVisible();
  await expect(page.locator(".notes-row", { hasText: "Входящие" }).locator(".notes-count")).toHaveText("1");
  await row.getByRole("button", { name: "В «Релиз 1.4»" }).click();
  await expect(page.locator(".notes-inbox")).toContainText("Пусто — всё разложено.");

  // Та же запись в карточке ведёт на свою страницу.
  await page.goto(`/#today?open=${entry.id}`);
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-dialog .card-page-link").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(page.locator(".notes-crumbs")).toContainText("Релиз 1.4");
  await expect(page).toHaveURL(new RegExp(`page=${entry.id}`));
  expect(release.id).toBeTruthy();
});

test("строка заметки уходит делом на «Доску» и отмечается, когда дело закрыли", async ({ page, request }) => {
  await reset(request);
  const note = await makePage(request, "Что сделать до релиза");
  await request.post(`/api/captures/${note.id}/notes`, { data: { body: "План:\n- [ ] Позвонить в банк\n- [ ] Просто пункт" } });
  await page.goto(`/#notes?page=${note.id}`);
  const line = page.locator(".notes-markdown .md-line", { hasText: "Позвонить в банк" });
  await line.hover();
  await page.locator(".notes-deed-button").click();
  await expect(line).toHaveAttribute("data-deed", /дело · Доска · Входящие/, { timeout: 10000 });
  // Вторая строка осталась простым чекбоксом.
  await expect(page.locator(".notes-markdown .md-line", { hasText: "Просто пункт" })).not.toHaveClass(/is-deed/);

  await page.goto("/#board");
  await expect(page.locator(".board-card", { hasText: "Позвонить в банк" })).toBeVisible();

  const detail = await (await request.get(`/api/pages/${note.id}`)).json();
  await request.post(`/api/projections/${detail.deeds[0].projectionIds[0]}/complete`);
  await page.goto(`/#notes?page=${note.id}`);
  const done = page.locator(".notes-markdown .md-line", { hasText: "Позвонить в банк" });
  await expect(done).toHaveAttribute("data-deed", "дело · сделано");
  await expect(done.locator(".md-checkbox")).toHaveClass(/md-checkbox-done/);

  // Чекбокс в самой заметке открывает дело обратно — и на «Доске» тоже.
  await done.locator(".md-checkbox").click();
  await expect(done).toHaveAttribute("data-deed", /дело · Доска/);
  await expect.poll(async () => (await (await request.get(`/api/pages/${note.id}`)).json()).deeds[0].state).toBe("open");
});

test("«Все заметки»: галерея и сохранение вида базой", async ({ page, request }) => {
  await reset(request);
  await makePage(request, "Shape Up", "project:Книги");
  await makePage(request, "How to Take Smart Notes", "project:Книги");
  await makePage(request, "Кизуна");
  await page.goto("/#notes?view=all");
  await expect(page.locator(".notes-table tbody tr")).toHaveCount(3);
  await page.locator(".notes-base-tab", { hasText: "Галерея" }).click();
  await expect(page.locator(".notes-card")).toHaveCount(3);
  await page.locator(".notes-base-select[aria-label='Проект']").selectOption("Книги");
  await expect(page.locator(".notes-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Сохранить как базу" }).click();
  const title = page.locator(".notes-title");
  await expect(title).toBeFocused();
  await page.keyboard.type("Чтение");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notes-side .notes-row", { hasText: "Чтение" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".notes-card")).toHaveCount(2);
  await expect(page.locator(".notes-base-tab[aria-pressed='true']")).toHaveText("Галерея");
  // Узел проекта в дереве собирает его заметки.
  await page.locator(".notes-row", { hasText: "Книги" }).locator(".notes-link").click();
  await expect(page.locator(".notes-children")).toContainText("Shape Up");
});
