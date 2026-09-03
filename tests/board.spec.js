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
  // Правка в раскрытой карточке видна на маленькой сразу, без ухода со страницы:
  // заголовок — после Enter, свойства — после закрытия.
  await page.locator("#review-dialog .card-title").click();
  await page.locator(".card-title-edit").fill("Проверить доску целиком и карточку");
  await page.keyboard.press("Enter");
  await expect(card.locator(".board-title")).toHaveText("Проверить доску целиком и карточку");
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await page.locator("#review-project").fill("Доска-проект");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(card.locator(".btag", { hasText: "Доска-проект" })).toBeVisible();

  // Группировка по датам: колонки считаются из сроков, внутри — группы видов.
  await page.locator('[data-board-view="dates"]').click();
  await expect(page.locator(".board-column.dated .board-col-name")).toHaveText([
    "Просрочено", "Сегодня", "Завтра", "Неделя", "Позже", "Без срока",
  ]);
  const noDue = page.locator(".board-column.dated").filter({ has: page.locator(".board-col-name", { hasText: "Без срока" }) });
  await expect(noDue.locator(".board-group-label")).toHaveText("Задачи");
  const datedCard = noDue.locator(".board-card").filter({ hasText: "Проверить доску" });
  await expect(datedCard).toBeVisible();

  // Список: те же группы по срокам столбиком. Пустые группы спрятаны, кроме
  // «Сегодня» и «Без срока» — там «+ Дело» ставит срок сразу по группе.
  await page.locator('[data-board-view="list"]').click();
  await expect(page.locator("#board-columns")).toHaveClass(/list/);
  await expect(page.locator(".board-column.dated .board-col-name")).toHaveText(["Сегодня", "Без срока"]);
  await expect(page.locator(".board-column.dated .board-card").filter({ hasText: "Проверить доску" })).toBeVisible();
  const todayGroup = page.locator(".board-column.dated").filter({ has: page.locator(".board-col-name", { hasText: "Сегодня" }) });
  await todayGroup.locator(".board-add-button").click();
  await todayGroup.locator(".board-add input").fill("Дело на сегодня из списка");
  await page.keyboard.press("Enter");
  const listed = todayGroup.locator(".board-card").filter({ hasText: "Дело на сегодня из списка" });
  await expect(listed).toBeVisible();
  await expect(listed.locator(".btag.due")).toContainText("сегодня");
  // Вид запоминается: после перезагрузки доска снова списком.
  await page.reload();
  await expect(page.locator("#board-columns")).toHaveClass(/list/);
  await expect(page.locator('[data-board-view="list"]')).toHaveAttribute("aria-pressed", "true");
  // Адрес с видом открывает доску сразу в нём.
  await page.goto("/#board?view=dates");
  await expect(page.locator('[data-board-view="dates"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".board-column.dated .board-col-name")).toHaveCount(6);
  await listed.locator(".board-done").click();
  await expect(listed).toHaveCount(0);

  // Обратно к своим колонкам — дело на месте, и кружок закрывает его.
  await page.locator('[data-board-view="columns"]').click();
  await expect(card).toBeVisible();
  await card.locator(".board-done").click();
  await expect(column.locator(".board-card")).toHaveCount(0);

  // Доска убирает за собой: следующие по алфавиту тесты карточек рассчитывают
  // на журнал без чужих закрытых дел.
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
});
