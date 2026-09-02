import { test, expect } from "@playwright/test";

test("доска: колонка, быстрое дело, статус, карточка и завершение", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/#board");

  // Пустая доска: «Входящие» и призрачная колонка добавления.
  await expect(page.locator(".board-column.inbox .board-col-name")).toHaveText("Входящие");
  await expect(page.locator(".board-column.ghost")).toBeVisible();

  // Новая колонка заводится на месте.
  await page.locator(".board-column.ghost .board-add-button").click();
  await page.locator(".board-column.ghost input").fill("В работе");
  await page.keyboard.press("Enter");
  const column = page
    .locator(".board-column")
    .filter({ has: page.locator(".board-col-name", { hasText: "В работе" }) });
  await expect(column).toBeVisible();

  // Быстрое дело прямо в колонке: Enter сохраняет, поле остаётся для следующего.
  await column.locator(".board-add-button").click();
  await column.locator(".board-add input").fill("Проверить доску целиком");
  await page.keyboard.press("Enter");
  const card = column.locator(".board-card").filter({ hasText: "Проверить доску" });
  await expect(card).toBeVisible();
  await expect(card.locator(".entry-status")).toHaveText("Без срока");
  await expect(column.locator(".board-add input")).toBeFocused();

  // Название открывает обычную карточку записи.
  await card.locator(".board-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();

  // Группировка по датам: колонки считаются из сроков, внутри — группы видов.
  await page.locator('[data-board-view="dates"]').click();
  await expect(page.locator(".board-column.dated .board-col-name")).toHaveText([
    "Просрочено", "Сегодня", "Завтра", "Неделя", "Позже", "Без срока",
  ]);
  const noDue = page.locator(".board-column.dated").filter({ has: page.locator(".board-col-name", { hasText: "Без срока" }) });
  await expect(noDue.locator(".board-group-label")).toHaveText("Задачи");
  const datedCard = noDue.locator(".board-card").filter({ hasText: "Проверить доску" });
  await expect(datedCard).toBeVisible();

  // Обратно к своим колонкам — дело на месте, и кружок закрывает его.
  await page.locator('[data-board-view="columns"]').click();
  await expect(card).toBeVisible();
  await card.locator(".board-done").click();
  await expect(column.locator(".board-card")).toHaveCount(0);

  // Доска убирает за собой: следующие по алфавиту тесты карточек рассчитывают
  // на журнал без чужих закрытых дел.
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
});
