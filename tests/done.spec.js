import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
// Под полем два ящика; какой открыт сам, зависит от часа, поэтому вкладку
// выбираем явно.
async function showTab(page, name) {
  const tab = page.getByRole("tab", { name });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

// «Закрыто»: закрытая в «Дне» туду попадает в «Закрыто», а страница «Сделано»
// — фраза про неделю, строка её семи дней, чипы по колонкам, ритм пяти недель
// клетками и список по дням.
test("закрытая в «Дне» туду видна в «Закрыто» и на странице «Сделано»", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Проверить страницу итогов" } });
  await request.post("/api/captures", { data: { raw: "Остаться открытым делом" } });
  await page.goto("/");
  await showTab(page, /^День/);
  const row = page.locator("#todo .entry").filter({ hasText: "Проверить страницу итогов" });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator(".completion-button").click();
  await expect(page.locator("#tab-journal b")).toHaveText("1");
  await showTab(page, /^Закрыто/);
  const closedRow = page.locator("#journal .entry").filter({ hasText: "Проверить страницу итогов" });
  await expect(closedRow).toBeVisible();
  await expect(closedRow.locator(".entry-title")).toHaveCSS("text-decoration-line", "line-through");

  // «Сделано» — свой пункт в шапке, первый, перед «Сегодня».
  await expect(page.locator('nav a[href="#done"] .dock-label')).toHaveText("Сделано");
  await page.locator('nav a[href="#done"]').click();
  await expect(page).toHaveURL(/#done$/);
  const done = page.locator("#done");
  await expect(done.locator("h2")).toHaveText("Сделано");

  // Фраза про неделю: сделано 1, встреч 0, сегодня 1 (зелёным).
  await expect(done.locator(".done-line")).toHaveText("За неделю сделано 1, из них встреч 0 · сегодня 1");
  await expect(done.locator(".done-line b.g")).toHaveText("1");
  // Строка недели — семь дней по сегодня: у сегодняшнего число, у остальных «–».
  const strip = done.locator(".done-wd");
  await expect(strip).toHaveCount(7);
  await expect(strip.last()).toHaveClass(/today/);
  await expect(strip.last().locator("b")).toHaveText("1");
  await expect(strip.last()).toHaveAttribute("title", /· 1$/);
  await expect(strip.locator("b")).toHaveText(["–", "–", "–", "–", "–", "–", "1"]);
  // Чипы «куда ушла неделя»: «Дела» — 1; встреч нет, синего чипа нет.
  await expect(done.locator(".done-chip")).toHaveText(["Дела 1"]);
  await expect(done.locator(".done-chip.meet")).toHaveCount(0);
  // Ритм: пять недель по семь клеток, сегодняшняя обведена и гуще всех, будущие недоступны.
  await expect(done.locator(".done-cap")).toHaveText("Ритм · 5 недель");
  await expect(done.locator(".done-cell")).toHaveCount(35);
  await expect(done.locator(".done-grid-lbl")).toHaveCount(5);
  await expect(done.locator(".done-grid-hd")).toHaveText(["пн", "вт", "ср", "чт", "пт", "сб", "вс"]);
  const today = done.locator(".done-cell.today");
  await expect(today).toHaveCount(1);
  await expect(today).toHaveClass(/l1/);
  await expect(today).toHaveAttribute("aria-label", /^[А-Яа-я]+, \d+ [а-я]+ · 1$/);
  await expect(today).toHaveAttribute("title", /· 1$/);
  await expect(today).toHaveAttribute("data-date", (await strip.last().getAttribute("data-date")) || "");
  await expect(done.locator(".done-cell.future:not(:disabled)")).toHaveCount(0);
  // Закрыто одно дело — гуще нуля только клетка сегодняшнего дня.
  await expect(done.locator(".done-cell.l1, .done-cell.l2, .done-cell.l3")).toHaveCount(1);
  // Старых плиток с числами, столбиков и полосок по колонкам больше нет.
  await expect(done.locator(".done-num, .done-bar, .done-col")).toHaveCount(0);
  // Список по дням: «Сегодня · 1» и строка закрытой туду со временем и колонкой.
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 1"]);
  const item = done.locator(".done-days .entry").filter({ hasText: "Проверить страницу итогов" });
  await expect(item).toBeVisible();
  await expect(item.locator(".entry-title")).toHaveCSS("text-decoration-line", "none");
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
  await expect(done.locator(".done-line")).toHaveText("За неделю сделано 0, из них встреч 0 · сегодня 0");
  await expect(done.locator(".done-cell.today")).not.toHaveClass(/l1/);
  await page.goto("/#today");
  await showTab(page, /^День/);
  await expect(page.locator("#todo .entry").filter({ hasText: "Проверить страницу итогов" })).toBeVisible();
  await reset(request);
});

test("страница «Сделано» без закрытого говорит, что пока пусто, и отдаёт то же по API", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#done");
  await expect(page.locator("#done .done-line")).toHaveText("За неделю сделано 0, из них встреч 0 · сегодня 0");
  await expect(page.locator("#done .done-wd.z")).toHaveCount(7);
  await expect(page.locator("#done .done-cell")).toHaveCount(35);
  await expect(page.locator("#done .done-chip")).toHaveCount(0);
  await expect(page.locator("#done .done-days")).toContainText("Пока ничего. Первый кружок — сюда.");

  // «Сделал X» закрыто при записи и сразу лежит на странице.
  await request.post("/api/captures", { data: { raw: "Сделал отчёт по итогам" } });
  const api = await (await request.get("/api/done")).json();
  expect(api.counts.today).toBe(1);
  expect(api.days[0].items.map((item) => item.title).join(" ")).toContain("отчёт");
  await page.reload();
  await expect(page.locator("#done .done-line")).toHaveText("За неделю сделано 1, из них встреч 0 · сегодня 1");
  await expect(page.locator("#done .done-days .entry")).toHaveCount(1);
  await reset(request);
});

// Клик по клетке ритма или по дню в строке недели показывает список этого дня:
// полка с датой и «Все дни», повторный клик и «Все дни» возвращают неделю.
test("клик по дню показывает его список с полкой «Все дни», «Все дни» возвращает неделю", async ({ page, request }) => {
  await reset(request);
  // «Вчера» в тексте — день, когда это было сделано: вчерашнее закрыто вчера, сегодняшнее — сегодня.
  await request.post("/api/captures", { data: { raw: "Сделал отчёт по смете вчера" } });
  await request.post("/api/captures", { data: { raw: "Сделал сверку по логам" } });
  await page.goto("/#done");
  const done = page.locator("#done");
  await expect(done.locator(".done-line")).toHaveText("За неделю сделано 2, из них встреч 0 · сегодня 1");
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 1", "Вчера · 1"]);
  await expect(done.locator(".done-all")).toHaveCount(0);
  const strip = done.locator(".done-wd");
  await expect(strip.locator("b")).toHaveText(["–", "–", "–", "–", "–", "1", "1"]);

  // Клетка вчерашнего дня: гуще пустых, в подписи — число.
  const yesterday = (await strip.nth(5).getAttribute("data-date")) || "";
  const cell = done.locator(`.done-cell[data-date="${yesterday}"]`);
  await expect(cell).toHaveClass(/l1/);
  const label = (await cell.getAttribute("aria-label")) || "";
  expect(label).toMatch(/^[А-Яа-я]+, \d+ [а-я]+ · 1$/);
  await cell.click();
  // Полка — «Вторник, 29 сентября · 1» и «Все дни»; в списке только этот день.
  await expect(done.locator(".done-day")).toHaveCount(1);
  await expect(done.locator(".done-day")).toContainText(label);
  await expect(done.getByRole("button", { name: "Все дни" })).toBeVisible();
  await expect(done.locator(".done-days .entry")).toHaveCount(1);
  await expect(done.locator(".done-days .entry")).toContainText("отчёт по смете");
  // Выбранный день обведён и в клетках, и в строке недели.
  await expect(done.locator(".done-cell.sel")).toHaveCount(1);
  await expect(done.locator(".done-cell.sel")).toHaveAttribute("data-date", yesterday);
  await expect(strip.nth(5)).toHaveClass(/sel/);
  await expect(strip.nth(5)).toHaveAttribute("aria-pressed", "true");

  // Повторный клик по той же клетке возвращает неделю.
  await cell.click();
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 1", "Вчера · 1"]);
  await expect(done.locator(".done-cell.sel, .done-wd.sel")).toHaveCount(0);

  // День в строке недели работает так же; «Все дни» на полке — тоже возврат, фокус уходит на клетку дня.
  await strip.nth(5).click();
  await expect(done.locator(".done-day")).toContainText(label);
  await done.getByRole("button", { name: "Все дни" }).click();
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 1", "Вчера · 1"]);
  await expect(cell).toBeFocused();

  // Пустой день говорит об этом прямо.
  const empty = done.locator(".done-cell:not(.future):not(.l1):not(.l2):not(.l3)").last();
  await empty.click();
  await expect(done.locator(".done-day")).toContainText("· 0");
  await expect(done.locator(".done-days")).toContainText("В этот день ничего не сделано.");
  await empty.click();

  // Сегодняшний день — тот же список, что на полке «Сегодня», с «Все дни».
  await done.locator(".done-cell.today").click();
  await expect(done.locator(".done-day")).toContainText("Сегодня · 1");
  await expect(done.getByRole("button", { name: "Все дни" })).toBeVisible();
  await expect(done.locator(".done-days .entry")).toContainText("сверку по логам");

  // Выбор не переживает уход со страницы: «Сделано» открывается с недели.
  await page.locator('nav a[href="#today"]').click();
  await page.locator('nav a[href="#done"]').click();
  await expect(done.locator(".done-cell.sel")).toHaveCount(0);
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 1", "Вчера · 1"]);
  await reset(request);
});

// Заголовок колонки «Закрыто» на доске ведёт на страницу «Сделано».
test("заголовок колонки «Закрыто» на доске открывает страницу «Сделано»", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");
  await page.locator(".board-done-column .board-col-name").click();
  await expect(page).toHaveURL(/#done$/);
  await expect(page.locator("#done")).toBeVisible();
  await expect(page.locator("#board")).toBeHidden();
});

// Пачка сообщений: из текста получаются отдельные туду, а «родителя» в списках нет.
test("пачка из трёх сообщений — две туду в «Дне», без родителя, и тост называет их", async ({ page, request }) => {
  await reset(request);
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.insertText(["Привет!", "1. Отправить Ане смету по Хабу — до вечера", "2. Напомнить Лёше про доступы к репе"].join("\n"));
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await showTab(page, /^День/);
  await expect(page.locator("#todo .entry")).toHaveCount(2, { timeout: 15000 });
  await expect(page.locator("#todo .entry").filter({ hasText: "Отправить Ане смету по Хабу" })).toBeVisible();
  await expect(page.locator("#todo .entry").filter({ hasText: "Напомнить Лёше про доступы к репе" })).toBeVisible();
  await expect(page.locator("#todo .entry").filter({ hasText: "Привет" })).toHaveCount(0);
  await expect(page.locator("#tab-day")).toContainText("2 дела");
  await expect(page.locator("#toast")).toContainText("Легло: 2 туду");
  // В карточке дела исходный текст — вся пачка, описание — из разбора.
  await page.locator("#todo .entry").filter({ hasText: "Отправить Ане смету по Хабу" }).locator(".entry-title").click();
  await expect(page.locator("#card-body-editor")).toHaveText("до вечера");
  await page.locator(".card-source summary").click();
  await expect(page.locator(".card-source-body")).toContainText("Привет!");
});

// «Сделал X» закрыто при записи, «Вернуть» из «Закрыто» ставит его в «День».
test("закрыл → Вернуть → снова в «Дне», а из «Закрыто» ушло", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Сделал отчёт для Игоря" } });
  await page.goto("/");
  await showTab(page, /^Закрыто/);
  const done = page.locator("#journal .entry").filter({ hasText: "отчёт для Игоря" });
  await expect(done).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#todo .entry").filter({ hasText: "отчёт для Игоря" })).toHaveCount(0);
  await done.locator(".completion-button").click();
  await expect(page.locator("#journal .entry").filter({ hasText: "отчёт для Игоря" })).toHaveCount(0);
  await showTab(page, /^День/);
  await expect(page.locator("#todo .entry").filter({ hasText: "отчёт для Игоря" })).toBeVisible({ timeout: 15000 });
  // Закрыть снова и вернуть кружком строки «Дня» — тот же круг.
  await page.locator("#todo .entry").filter({ hasText: "отчёт для Игоря" }).locator(".completion-button").click();
  await showTab(page, /^Закрыто/);
  await expect(page.locator("#journal .entry").filter({ hasText: "отчёт для Игоря" })).toBeVisible({ timeout: 15000 });
});

// У закрытой туду в карточке — зелёный отмеченный кружок «Вернуть в работу»,
// и у «сделал X», закрытого при записи, тоже.
test("карточка закрытого дела и закрытого при записи «сделал X» несёт зелёный кружок", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Сделал сверку по смете" } });
  await page.goto("/");
  await showTab(page, /^Закрыто/);
  await page.locator("#journal .entry").filter({ hasText: "сверку по смете" }).locator(".entry-title").click();
  const tick = page.locator("#review-dialog .card-head .card-tick");
  await expect(tick).toBeVisible();
  await expect(tick).toHaveClass(/is-done/);
  await expect(tick).toHaveAttribute("aria-label", /Вернуть в работу/);
});

// Закрытая подзадача отдельной строкой в «Сделано» не стоит: у закрытого дела —
// метка «1/1», по ней карточка открывается на «Подзадачах».
test("«Сделано» и «Закрыто»: закрытая подзадача строкой не стоит, у закрытого дела метка «1/1», по ней карточка открывается на «Подзадачах»", async ({ page, request }) => {
  await reset(request);
  const made = async (raw) => (await (await request.post("/api/captures", { data: { raw, primaryType: "todo" } })).json()).entry;
  const close = async (entry) => {
    for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
  };
  const parent = await made("Отправить отчёт по Hub Ане");
  const alone = await made("Проверить логи Hub");
  const child = (await (await request.post(`/api/captures/${parent.id}/subtasks`, { data: { title: "Собрать цифры для отчёта" } })).json()).entry;
  await close(child);
  await close(parent);
  await close(alone);

  // «Закрыто» на «Сегодня»: два дела, подзадачи среди них нет, метка у того, у кого она есть.
  await page.goto("/");
  await showTab(page, /^Закрыто/);
  const rows = page.locator("#journal .entry");
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  await expect(rows.filter({ hasText: "Собрать цифры" })).toHaveCount(0);
  await expect(page.locator("#tab-journal b")).toHaveText("2");
  await expect(rows.filter({ hasText: "Отправить отчёт" }).locator(".sub-badge")).toHaveText("1/1");
  await expect(rows.filter({ hasText: "Проверить логи" }).locator(".sub-badge")).toHaveCount(0);

  // Страница «Сделано»: то же — «Сегодня · 2», фраза недели считает дела, метка зелёная.
  await page.locator('nav a[href="#done"]').click();
  const done = page.locator("#done");
  await expect(done.locator(".done-day")).toHaveText(["Сегодня · 2"]);
  await expect(done.locator(".done-line")).toHaveText("За неделю сделано 2, из них встреч 0 · сегодня 2");
  await expect(done.locator(".done-days .entry")).toHaveCount(2);
  await expect(done.locator(".done-days .entry").filter({ hasText: "Собрать цифры" })).toHaveCount(0);
  const badge = done.locator(".done-days .entry").filter({ hasText: "Отправить отчёт" }).locator(".sub-badge");
  await expect(badge).toHaveText("1/1");
  await expect(badge).toHaveClass(/all-done/);
  await expect(done.locator(".done-days .sub-badge")).toHaveCount(1);
  // Тот же счёт отдаёт API: подзадача в «Сделано» отдельной строкой не идёт.
  const api = await (await request.get("/api/done")).json();
  expect(api.counts.today).toBe(2);
  expect(api.days[0].items.find((item) => item.id === parent.id).subtasks).toEqual({ done: 1, total: 1 });

  // Метка открывает карточку закрытого дела на «Подзадачах».
  await badge.click();
  const dialog = page.locator("#review-dialog");
  await expect(dialog.locator(".card-title")).toHaveText("Отправить отчёт по Hub Ане");
  await expect(dialog.locator("#card-subtasks .subtask-count")).toHaveText("1 / 1");
  await expect(dialog.locator("#card-subtasks .subtask-name")).toHaveText("Собрать цифры для отчёта");
});
