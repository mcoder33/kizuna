import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
const columnByName = (page, name) =>
  page.locator(".board-column:not(.ghost)").filter({ has: page.locator(".board-col-name", { hasText: new RegExp(`^${name}$`) }) });
const addColumn = async (page, name) => {
  await page.locator(".board-column.ghost .board-add-button").click();
  await page.locator(".board-column.ghost input").fill(name);
  await page.keyboard.press("Enter");
  await expect(columnByName(page, name)).toBeVisible();
};

test("доска: «Сделано» слева, своя колонка, быстрое дело, карточка и кружок", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");

  // Видов, свойств и фильтра нет; слева прибита «Сделано», за ней первая
  // колонка «Дела» (заводится сервером сама) и призрачная «+ Колонка».
  await expect(page.locator(".board-views, #board-props-toggle, #board-filter")).toHaveCount(0);
  await expect(page.locator(".board-column:not(.ghost) .board-col-name")).toHaveText(["Сделано", "Дела"]);
  await expect(page.locator(".board-column.inbox")).toHaveCount(0);
  await expect(page.locator(".board-column.ghost")).toBeVisible();
  await expect(page.locator(".board-column.board-done-column .board-col-name")).toHaveAttribute("href", "#done");
  // «Сделано» не тянется и без меню.
  await expect(page.locator(".board-done-column .board-col-head")).not.toHaveAttribute("draggable", "true");
  await expect(page.locator(".board-done-column .board-menu")).toHaveCount(0);
  // У обычной колонки заголовок тянется, а меню — только «Переименовать» и «Удалить колонку».
  const first = columnByName(page, "Дела");
  await expect(first.locator(".board-col-head")).toHaveAttribute("draggable", "true");
  await first.locator(".board-menu summary").click();
  await expect(first.locator(".board-menu-popover button")).toHaveText(["Переименовать", "Удалить колонку"]);
  await expect(page.locator(".board-swatch")).toHaveCount(0);
  await first.locator(".board-menu summary").click();

  // Новая колонка заводится на месте.
  await addColumn(page, "В работе");
  const column = columnByName(page, "В работе");

  // Быстрое дело прямо в колонке: Enter сохраняет, поле остаётся для следующего.
  await column.locator(".board-add-button").click();
  await column.locator(".board-add input").fill("Проверить доску целиком");
  await page.keyboard.press("Enter");
  const card = column.locator(".board-card").filter({ hasText: "Проверить доску" });
  await expect(card).toBeVisible();
  await expect(column.locator(".board-add input")).toBeFocused();
  // Ни статуса, ни типа, ни проекта: кружок, название, мелкая строка под ним.
  await expect(card.locator(".entry-status, .btag.kind, .btag.project")).toHaveCount(0);

  // Название открывает карточку; правка заголовка видна на доске сразу.
  await card.locator(".board-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-dialog .card-title").click();
  await page.locator(".card-title-edit").fill("Проверить доску целиком и карточку");
  await page.keyboard.press("Enter");
  await expect(card.locator(".board-title")).toHaveText("Проверить доску целиком и карточку");
  // Люди из карточки появляются на доске кружком с первой буквой.
  await page.locator("#review-people").fill("Анна");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(card.locator(".board-who")).toHaveAttribute("title", "Анна");

  // Кружок отправляет дело в «Сделано»: оно там зачёркнуто, подпись — «сегодня 10:12».
  await card.locator(".board-done").click();
  await expect(column.locator(".board-card")).toHaveCount(0);
  const done = page.locator(".board-done-column");
  const closed = done.locator(".board-card.closed").filter({ hasText: "Проверить доску" });
  await expect(closed).toBeVisible();
  await expect(closed.locator(".btag.due")).toContainText(/^сегодня \d\d:\d\d$/);
  await expect(done.locator(".board-col-count")).toHaveText("1");
  // Кружок закрытой возвращает дело в его колонку.
  await closed.locator(".board-done").click();
  await expect(done.locator(".board-card")).toHaveCount(0);
  await expect(column.locator(".board-card").filter({ hasText: "Проверить доску" })).toBeVisible();

  // Заголовок «Сделано» ведёт на страницу «Сделано».
  await done.locator(".board-col-name").click();
  await expect(page).toHaveURL(/#done$/);
  await expect(page.locator("#done h2")).toHaveText("Сделано");

  await reset(request);
});

test("доска: карточку бросают в «Сделано» и между колонками, колонку тянут за заголовок", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Первое дело доски" } });
  await request.post("/api/captures", { data: { raw: "Второе дело доски" } });
  await page.goto("/#board");
  await addColumn(page, "Позже");
  await addColumn(page, "Ожидание");
  const names = () => page.locator(".board-column:not(.ghost) .board-col-name").allTextContents();
  await expect.poll(names).toEqual(["Сделано", "Дела", "Позже", "Ожидание"]);

  // Карточка между колонками: «Второе» уезжает из «Дел» в «Позже».
  const first = columnByName(page, "Дела"), later = columnByName(page, "Позже");
  const second = first.locator(".board-card").filter({ hasText: "Второе дело" });
  await expect(second).toBeVisible();
  await second.locator(".board-title").dragTo(later.locator(".board-cards"));
  await expect(later.locator(".board-card").filter({ hasText: "Второе дело" })).toBeVisible();
  await expect(first.locator(".board-card")).toHaveCount(1);
  await page.reload();
  await expect(columnByName(page, "Позже").locator(".board-card")).toContainText("Второе дело");

  // Колонка тянется за заголовок: «Ожидание» встаёт перед «Дела» — но не левее «Сделано».
  await columnByName(page, "Ожидание").locator(".board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Сделано", "Ожидание", "Дела", "Позже"]);
  await page.reload();
  await expect.poll(names).toEqual(["Сделано", "Ожидание", "Дела", "Позже"]);

  // Бросили карточку на «Сделано» — она закрыта и лежит там. Карточка без места
  // лежит в первой колонке, а первой теперь стала «Ожидание».
  const target = columnByName(page, "Ожидание").locator(".board-card").filter({ hasText: "Первое дело" });
  await target.locator(".board-title").dragTo(page.locator(".board-done-column"));
  const closed = page.locator(".board-done-column .board-card.closed");
  await expect(closed).toHaveCount(1);
  await expect(closed).toContainText("Первое дело");
  await expect(columnByName(page, "Ожидание").locator(".board-card")).toHaveCount(0);

  // Удаление колонки переносит её дела в первую оставшуюся колонку.
  const later2 = columnByName(page, "Позже");
  await later2.hover();
  await later2.locator(".board-menu summary").click();
  await later2.getByRole("button", { name: "Удалить колонку" }).click();
  await expect(columnByName(page, "Позже")).toHaveCount(0);
  await expect(columnByName(page, "Ожидание").locator(".board-card").filter({ hasText: "Второе дело" })).toBeVisible();
  await reset(request);
});

test("доска: название колонки правится щелчком, поиск прячет лишнее", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Согласовать смету по CP с Антоном Гришиным" } });
  await request.post("/api/captures", { data: { raw: "Разобрать отчёт по Hub" } });
  await page.goto("/#board");

  // Щелчок по названию превращает его в поле; Enter сохраняет.
  await columnByName(page, "Дела").locator(".board-col-name").click();
  const input = page.locator(".board-col-input");
  await input.fill("Текущие");
  await input.press("Enter");
  await expect(columnByName(page, "Текущие")).toBeVisible();
  await page.reload();
  await expect(columnByName(page, "Текущие").locator(".board-card")).toHaveCount(2);

  // Поиск — по названию, на лету.
  const cards = columnByName(page, "Текущие").locator(".board-card");
  await page.locator("#board-search").fill("смету");
  await expect(cards).toHaveCount(1);
  await page.locator("#board-search").fill("");
  await expect(cards).toHaveCount(2);

  // «+ Дело» вверху открывает поле в первой своей колонке, а не в «Сделано».
  await page.locator("#board-new").click();
  await expect(columnByName(page, "Текущие").locator(".board-add input")).toBeVisible();
  await reset(request);
});

// На телефоне колонки по одной на экран: сверху сегмент подписей, открыта
// первая своя колонка (а не «Сделано»), страница не шире экрана.
test("на телефоне колонки по одной, сегмент показывает «Сделано» и свои", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Проверить доску на телефоне" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#board");
  const card = page.locator("#board-columns .board-card").filter({ hasText: "на телефоне" });
  await expect(card).toBeVisible();
  // Карточка не выше своего содержимого: flex-basis строки заголовка не должен
  // превращаться в высоту.
  await expect.poll(async () => (await card.boundingBox())?.height ?? Infinity).toBeLessThan(120);
  await expect(page.locator("#board-segments .board-segment").first()).toBeVisible();
  await expect(page.locator("#board-segments .board-segment").first()).toContainText("Сделано");
  await expect(page.locator("#board-columns .board-column.is-active")).toHaveCount(1);
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("Дела");
  // Сегмент «Сделано» показывает закрытые; страница не шире экрана.
  await page.locator("#board-segments .board-segment").first().click();
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("Сделано");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await reset(request);
});

test("крестик на карточке доски удаляет дело мягко, «Вернуть» возвращает его", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Дело под удаление с доски" } });
  await page.goto("/#board");
  const card = page.locator(".board-card").filter({ hasText: "Дело под удаление с доски" });
  await expect(card).toBeVisible();
  await card.hover();
  await card.locator(".board-remove").click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("#toast")).toContainText("Дело удалено");
  await page.locator("#toast .toast-action", { hasText: "Вернуть" }).click();
  await expect(page.locator(".board-card").filter({ hasText: "Дело под удаление с доски" })).toBeVisible();
});
