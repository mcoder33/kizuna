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

// Лицо как в Notion: цветная подпись колонки из меню, свойства строками,
// компактный вид, фильтр по проекту и типу, поиск, вид по проектам и скрытая
// группа закрытых на доске.
test("доска как в Notion: цвет колонки, свойства, фильтр, поиск, проекты и скрытые группы", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await request.post("/api/captures", { data: { raw: "Согласовать смету по CP с Антоном Гришиным", primaryType: "todo" } });
  await request.post("/api/captures", { data: { raw: "Разобрать отчёт по Hub", primaryType: "todo" } });
  await page.goto("/#board");

  // Колонка: пилюля серая, из меню красится в фиолетовый.
  await page.locator(".board-column.ghost .board-add-button").click();
  await page.locator(".board-column.ghost input").fill("Ожидание");
  await page.keyboard.press("Enter");
  const column = page.locator(".board-column").filter({ has: page.locator(".board-col-name", { hasText: "Ожидание" }) });
  await expect(column.locator(".board-pill")).toHaveClass(/c-gray/);
  // Новая запись дозревает в фоне и перерисовывает доску: меню открываем на
  // спокойной странице, после перезагрузки.
  await page.reload();
  await column.locator(".board-menu summary").click();
  await column.locator('.board-swatch[aria-label="Цвет: Фиолетовый"]').click();
  await expect(column.locator(".board-pill")).toHaveClass(/c-purple/);
  await page.reload();
  await expect(column.locator(".board-pill")).toHaveClass(/c-purple/);

  // Карточка: статус чипом, проект чипом с цветом; кружок — без часов, это задача.
  const inbox = page.locator(".board-column.inbox");
  await expect(inbox.locator(".board-card")).toHaveCount(2);
  const smeta = inbox.locator(".board-card").filter({ hasText: "смету" });
  await expect(smeta.locator(".entry-status")).toHaveText("Без срока");
  await expect(smeta.locator(".board-done")).not.toHaveClass(/meeting/);
  await expect(smeta.locator(".btag.project", { hasText: "CP" })).toHaveClass(/c-/);

  // Панель свойств: без проекта — чипа нет; компактно — одна строка.
  await page.locator("#board-props-toggle").click();
  await page.locator('[data-board-prop="project"]').uncheck();
  await expect(smeta.locator(".btag.project")).toHaveCount(0);
  await page.locator('[data-board-prop="project"]').check();
  await page.locator('[data-board-prop="compact"]').check();
  await expect(page.locator("#board-columns")).toHaveClass(/compact/);
  await expect(smeta.locator(".board-meta")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#board-columns")).toHaveClass(/compact/);
  await page.locator("#board-props-toggle").click();
  await page.locator('[data-board-prop="compact"]').uncheck();

  // Фильтр по проекту прячет чужие карточки и считает себя в кнопке.
  await page.locator("#board-filter summary").click();
  await page.locator('#board-filter-projects button', { hasText: "Hub" }).click();
  await expect(page.locator("#board-filter-summary")).toHaveText("Фильтр · 1");
  await expect(inbox.locator(".board-card")).toHaveCount(1);
  await expect(inbox.locator(".board-card")).toContainText("Hub");
  await page.locator("#board-filter-reset").click();
  await expect(inbox.locator(".board-card")).toHaveCount(2);

  // Поиск — по названию, на лету.
  await page.locator("#board-search").fill("смету");
  await expect(inbox.locator(".board-card")).toHaveCount(1);
  await page.locator("#board-search").fill("");
  await expect(inbox.locator(".board-card")).toHaveCount(2);

  // По проектам: группа на проект, «Без проекта» — хвостом при необходимости.
  await page.locator('[data-board-view="projects"]').click();
  await expect(page.locator(".board-column.dated .board-col-name")).toHaveText(["CP", "Hub"]);

  // Закрытое дело — в скрытой группе; кнопка разворачивает её колонкой.
  await page.locator('[data-board-view="columns"]').click();
  await smeta.locator(".board-done").click();
  const hidden = page.locator(".board-hidden-toggle");
  await expect(hidden).toContainText("1");
  await expect(page.locator(".board-column.closed")).toHaveCount(0);
  await hidden.click();
  await expect(page.locator(".board-column.closed .board-card")).toContainText("смету");
  await page.locator(".board-column.closed .board-done").click();
  await expect(inbox.locator(".board-card")).toHaveCount(2);
  await hidden.click();
  await expect(page.locator(".board-column.closed")).toHaveCount(0);
});

// На телефоне список — столбиком целиком, без сегмента колонок, и карточка
// не выше своего содержимого: flex-basis строки заголовка не должен
// превращаться в высоту.
test("на телефоне список не растягивает карточки и не показывает сегмент колонок", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await request.post("/api/captures", { data: { raw: "Проверить список на телефоне", primaryType: "todo" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#board?view=list");
  const card = page.locator("#board-columns .board-card").filter({ hasText: "на телефоне" });
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box.height).toBeLessThan(120);
  await expect(page.locator("#board-segments")).toBeHidden();
  // Страница не шире экрана: иначе Safari на телефоне расширяет окно, и
  // карточка записи с экраном разговора оказываются уже экрана.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // На доске сегмент есть, и показана одна колонка.
  await page.locator('[data-board-view="columns"]').click();
  await expect(page.locator("#board-segments .board-segment").first()).toBeVisible();
  await expect(page.locator("#board-columns .board-column.is-active")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
