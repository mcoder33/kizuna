import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });

// «Сделано»: закрытая на «Сегодня» туду попадает в «Что делал», а оттуда по
// заголовку — на страницу с тремя числами, неделей столбиками, полосками по
// колонкам и списком по дням.
test("закрытая на «Сегодня» туду видна в «Что делал» и на странице «Сделано»", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Проверить страницу итогов" } });
  await request.post("/api/captures", { data: { raw: "Остаться открытым делом" } });
  await page.goto("/");
  const row = page.locator("#todo .entry").filter({ hasText: "Проверить страницу итогов" });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator(".completion-button").click();
  await expect(page.locator("#journal .entry").filter({ hasText: "Проверить страницу итогов" })).toBeVisible();
  await expect(page.locator("#done-count")).toHaveText("1");

  // Заголовок «Что делал» ведёт на страницу; в шапке пункта «Сделано» нет.
  await expect(page.locator('nav a[href="#done"]')).toHaveCount(0);
  await page.locator(".shelf-head.done a").click();
  await expect(page).toHaveURL(/#done$/);
  const done = page.locator("#done");
  await expect(done.locator("h2")).toHaveText("Сделано");

  // Три числа: сегодня 1, за неделю 1, встреч 0.
  const nums = done.locator(".done-num b");
  await expect(nums).toHaveText(["1", "1", "0"]);
  await expect(done.locator(".done-num.green span")).toHaveText("сегодня");
  // Неделя — семь столбиков, число подписано у сегодняшнего, остальные пусты.
  await expect(done.locator(".done-bar")).toHaveCount(7);
  await expect(done.locator(".done-bar.today .done-bar-n")).toHaveText("1");
  await expect(done.locator(".done-bar-n")).toHaveCount(1);
  await expect(done.locator(".done-bar.today")).toHaveAttribute("title", /· 1$/);
  // По колонкам: «Дела» — 1.
  await expect(done.locator(".done-col")).toHaveCount(1);
  await expect(done.locator(".done-col .done-col-name")).toHaveText("Дела");
  await expect(done.locator(".done-col b")).toHaveText("1");
  // Список по дням: «Сегодня · 1» и строка закрытой туду со временем и колонкой.
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 1"]);
  const item = done.locator(".done-days .entry").filter({ hasText: "Проверить страницу итогов" });
  await expect(item).toBeVisible();
  await expect(item.locator(".tag.done-where")).toHaveText("Дела");
  await expect(item.locator(".tag.time")).toHaveText(/^\d\d:\d\d$/);

  // Название открывает карточку той же туду; закрытая, она говорит «Сделано».
  await item.locator(".entry-title").click();
  await expect(page.locator("#review-dialog .card-done-ok")).toContainText("Сделано");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();

  // Кружок закрытой возвращает её в работу: со страницы «Сделано» она уходит,
  // на «Сегодня» встаёт обратно.
  await item.locator(".completion-button").click();
  await expect(done.locator(".done-days .entry")).toHaveCount(0);
  await expect(nums.first()).toHaveText("0");
  await page.goto("/#today");
  await expect(page.locator("#todo .entry").filter({ hasText: "Проверить страницу итогов" })).toBeVisible();
  await reset(request);
});

test("страница «Сделано» без закрытого говорит, что пока пусто, и отдаёт то же по API", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#done");
  await expect(page.locator("#done .done-num b")).toHaveText(["0", "0", "0"]);
  await expect(page.locator("#done .done-days")).toContainText("Пока ничего. Первый кружок — сюда.");
  await expect(page.locator("#done .done-col")).toHaveCount(0);
  await expect(page.locator("#done .done-empty")).toContainText("ничего не закрыто");

  // «Сделал X» закрыто при записи и сразу лежит на странице.
  await request.post("/api/captures", { data: { raw: "Сделал отчёт по итогам" } });
  const api = await (await request.get("/api/done")).json();
  expect(api.counts.today).toBe(1);
  expect(api.days[0].items.map((item) => item.title).join(" ")).toContain("отчёт");
  await page.reload();
  await expect(page.locator("#done .done-num b").first()).toHaveText("1");
  await expect(page.locator("#done .done-days .entry")).toHaveCount(1);
  await reset(request);
});

// Заголовок колонки «Сделано» на доске ведёт на ту же страницу.
test("заголовок колонки «Сделано» на доске открывает страницу «Сделано»", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");
  await page.locator(".board-done-column .board-col-name").click();
  await expect(page).toHaveURL(/#done$/);
  await expect(page.locator("#done")).toBeVisible();
  await expect(page.locator("#board")).toBeHidden();
});

// Пачка сообщений: из текста получаются отдельные туду, а «родителя» в списках нет.
test("пачка из трёх сообщений — две туду в «Сегодня», без родителя, и тост называет их", async ({ page, request }) => {
  await reset(request);
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.insertText(["Привет!", "1. Отправить Ане смету по Хабу — до вечера", "2. Напомнить Лёше про доступы к репе"].join("\n"));
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(page.locator("#todo .entry")).toHaveCount(2, { timeout: 15000 });
  await expect(page.locator("#todo .entry").filter({ hasText: "Отправить Ане смету по Хабу" })).toBeVisible();
  await expect(page.locator("#todo .entry").filter({ hasText: "Напомнить Лёше про доступы к репе" })).toBeVisible();
  await expect(page.locator("#todo .entry").filter({ hasText: "Привет" })).toHaveCount(0);
  await expect(page.locator("#today-count")).toHaveText("2");
  await expect(page.locator("#toast")).toContainText("Легло: 2 туду");
  // В карточке дела исходный текст — вся пачка, описание — из разбора.
  await page.locator("#todo .entry").filter({ hasText: "Отправить Ане смету по Хабу" }).locator(".entry-title").click();
  await expect(page.locator("#card-body-editor")).toHaveText("до вечера");
  await page.locator(".card-source summary").click();
  await expect(page.locator(".card-source-body")).toContainText("Привет!");
});

// «Сделал X» закрыто при записи, «Вернуть» из «Что делал» ставит его в «Сегодня».
test("закрыл → Вернуть → снова в «Сегодня», а из «Что делал» ушло", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Сделал отчёт для Игоря" } });
  await page.goto("/");
  const done = page.locator("#journal .entry").filter({ hasText: "отчёт для Игоря" });
  await expect(done).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#todo .entry").filter({ hasText: "отчёт для Игоря" })).toHaveCount(0);
  await done.locator(".completion-button").click();
  await expect(page.locator("#todo .entry").filter({ hasText: "отчёт для Игоря" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#journal .entry").filter({ hasText: "отчёт для Игоря" })).toHaveCount(0);
  // Закрыть снова и вернуть кружком строки «Сегодня» — тот же круг.
  await page.locator("#todo .entry").filter({ hasText: "отчёт для Игоря" }).locator(".completion-button").click();
  await expect(page.locator("#journal .entry").filter({ hasText: "отчёт для Игоря" })).toBeVisible({ timeout: 15000 });
});

// У закрытой туду в карточке — зелёный отмеченный кружок «Вернуть в работу»,
// и у «сделал X», закрытого при записи, тоже.
test("карточка закрытого дела и закрытого при записи «сделал X» несёт зелёный кружок", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Сделал сверку по смете" } });
  await page.goto("/");
  await page.locator("#journal .entry").filter({ hasText: "сверку по смете" }).locator(".entry-title").click();
  const tick = page.locator("#review-dialog .card-head .card-tick");
  await expect(tick).toBeVisible();
  await expect(tick).toHaveClass(/is-done/);
  await expect(tick).toHaveAttribute("aria-label", /Вернуть в работу/);
});
