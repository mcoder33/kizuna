import { test, expect } from "@playwright/test";

// «Как пользоваться» — вариант А: слева вопросы с поиском, справа прогон в
// копии интерфейса. Шаг делается рукой, в журнал ничего не пишется, пока не
// нажали «Попробовать по-настоящему»; в конце можно выйти из обучения. На
// телефоне сначала список, потом прогон с «‹ Вопросы».
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: dayAt(13) });
});

test("по адресу #guide вопросы слева, прогон про поручение идёт справа и заканчивается выходом", async ({ page }) => {
  await page.goto("/#today");
  const entriesBefore = await (await page.request.get("/api/entries")).text();
  // Ссылки на «Как пользоваться» в шапке больше нет: страница открывается по адресу.
  await expect(page.locator(".help-link")).toHaveCount(0);
  await page.evaluate(() => { location.hash = "#guide"; });
  const guide = page.locator("#guide");
  await expect(guide).toBeVisible();
  await expect(page.locator("nav a.active")).toHaveCount(0);
  await expect(guide.locator(".gd-q")).toHaveCount(18);
  await expect(guide.locator(".gd-q-side.live")).toHaveCount(4);
  await expect(guide.getByText("Выберите вопрос слева")).toBeVisible();

  await guide.locator('.gd-q[data-guide="assign"]').click();
  await expect(page).toHaveURL(/#guide\?q=assign$/);
  await expect(guide.locator('.gd-q[data-guide="assign"]')).toHaveAttribute("aria-current", "true");
  // Список и прогон видны вместе.
  await expect(guide.locator(".gd-side")).toBeVisible();
  const count = guide.locator(".gd-count");
  await expect(count).toHaveText("шаг 1 из 8");
  await expect(guide.locator(".gd-kc-band")).toHaveClass(/gd-spot/);
  await guide.getByRole("button", { name: "Дальше" }).click();
  // Шаг 2: фраза печатается сама, стрелка подсвечивается только после набора.
  await expect(guide.locator(".gd-cap-text")).toHaveText("Ане — прислать смету по Хабу до пятницы", { timeout: 5000 });
  await expect(guide.locator(".gd-cap-send")).toHaveClass(/gd-spot/);
  await guide.locator(".gd-cap-send").click();
  await expect(guide.locator(".gd-entry.new .gd-tag.assign")).toHaveText("Аня · ждёт ответа");
  await guide.getByRole("button", { name: "Дальше" }).click();
  // Шаг 4: за Аню нажимаем «Беру».
  await guide.getByRole("button", { name: "Беру" }).click();
  await expect(guide.locator(".gd-entry.new .gd-tag.assign")).toHaveText("Аня · взяла");
  await guide.getByRole("button", { name: "Дальше" }).click();
  await expect(guide.locator(".gd-prop-assign")).toHaveClass(/gd-spot/);
  // «Назад» возвращает шаг.
  await guide.getByRole("button", { name: "Назад" }).click();
  await expect(count).toHaveText("шаг 5 из 8");
  await guide.getByRole("button", { name: "Дальше" }).click();
  await guide.getByRole("button", { name: "Дальше" }).click();
  await expect(guide.locator(".gd-kc-deed input")).toHaveValue("Прислать смету по Хабу до пятницы");
  await guide.getByRole("button", { name: "Дальше" }).click();
  await expect(count).toHaveText("шаг 8 из 8");
  // Пройдено: галочка в списке сразу, в конце — выход из обучения.
  await expect(guide.locator('.gd-q[data-guide="assign"] .gd-q-side')).toHaveText("✓");
  await guide.getByRole("button", { name: "Выйти из обучения" }).click();
  await expect(page.locator("#today")).toBeVisible();
  await expect(guide).toBeHidden();
  // Прогон шёл в копии: в журнале ничего не прибавилось.
  expect(await (await page.request.get("/api/entries")).text()).toBe(entriesBefore);
  // Галочка переживает уход со страницы.
  await page.goto("/#guide");
  await expect(page.locator('#guide .gd-q[data-guide="assign"]')).toHaveClass(/done/);
});

test("по адресу вопроса прогон открыт сразу; «Попробовать по-настоящему» уносит фразу в поле, «Открыть раздел» ведёт в раздел", async ({ page }) => {
  await page.goto("/#guide?q=outcome");
  const guide = page.locator("#guide");
  await expect(guide.locator(".gd-p-title")).toHaveText("Как записать результат");
  await expect(guide.locator(".gd-cap-send")).toHaveClass(/gd-spot/, { timeout: 5000 });
  await guide.locator(".gd-cap-send").click();
  await guide.getByRole("button", { name: "Дальше" }).click();
  await guide.getByRole("button", { name: "Дальше" }).click();
  await guide.getByRole("button", { name: "Попробовать по-настоящему" }).click();
  await expect(page.locator("#today")).toBeVisible();
  await expect(page.getByLabel("Новая запись")).toContainText("Починил ретрай в очереди уведомлений");

  // Вопрос без прогона — шаги списком и кнопка в раздел.
  await page.goto("/#guide");
  await guide.locator("#guide-search").fill("доска");
  await expect(guide.locator(".gd-q")).toHaveCount(1);
  await guide.locator('.gd-q[data-guide="board"]').click();
  await expect(guide.locator(".gd-plain li")).toHaveCount(4);
  await guide.getByRole("button", { name: "Открыть раздел" }).click();
  await expect(page.locator("#board")).toBeVisible();

  // «К вопросам» возвращает к пустой правой половине.
  await page.goto("/#guide?q=meeting");
  await expect(guide.locator(".gd-p-title")).toHaveText("Как назначить встречу");
  await guide.getByRole("button", { name: "К вопросам" }).click();
  await expect(guide.getByText("Выберите вопрос слева")).toBeVisible();
  await expect(page).toHaveURL(/#guide$/);
});

test("на телефоне сначала список, потом прогон с «‹ Вопросы», строка шага видна целиком", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/#guide");
  const guide = page.locator("#guide");
  await expect(guide.locator(".gd-side")).toBeVisible();
  await expect(guide.locator(".gd-main")).toBeHidden();
  await guide.locator('.gd-q[data-guide="todo"]').click();
  await expect(guide.locator(".gd-side")).toBeHidden();
  await expect(guide.locator(".gd-p-title")).toHaveText("Как завести дело");
  // Строка шага видна на экране целиком, хотя копия интерфейса выше экрана.
  await expect(guide.locator(".gd-rail")).toBeInViewport({ ratio: 1 });
  // Страница не шире экрана.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await guide.getByRole("button", { name: "‹ Вопросы" }).click();
  await expect(guide.locator(".gd-side")).toBeVisible();
  await expect(guide.locator('.gd-q[data-guide="todo"]')).toBeFocused();
});

// Демо идёт само, как видео: курсор летит к подсвеченному и нажимает, шаги
// сменяются после паузы на чтение. Время в проверке ускоряют часы Playwright.
async function playTo(page, locator, text) {
  await expect
    .poll(async () => { await page.clock.fastForward(700); return locator.textContent(); }, { timeout: 25000, intervals: [60] })
    .toBe(text);
}

test("демо идёт само: курсор нажимает, пауза останавливает, в конце «Смотреть ещё раз», «Пройти самому» возвращает руки", async ({ page }) => {
  await page.goto("/#guide?q=todo");
  const guide = page.locator("#guide");
  const count = guide.locator(".gd-count");
  await expect(count).toHaveText("шаг 1 из 6");
  await guide.getByRole("button", { name: "Смотреть демо" }).click();
  await expect(page).toHaveURL(/#guide\?q=todo&demo=1$/);
  await expect(count).toHaveText("демо · шаг 1 из 6");
  await expect(guide.locator(".gd-demo-bar i")).toHaveCount(6);
  await expect(guide.locator(".gd-cursor")).toHaveClass(/on/);
  // Поле нажимает курсор, фраза печатается сама, стрелку нажимает курсор.
  await playTo(page, count, "демо · шаг 2 из 6");
  await expect(guide.locator(".gd-cap-text")).toHaveText("Оплатить хостинг до пятницы", { timeout: 5000 });
  await playTo(page, count, "демо · шаг 3 из 6");
  await expect(guide.locator(".gd-entry.new")).toBeVisible();
  // Пауза останавливает ход, «Продолжить» пускает дальше.
  await guide.getByRole("button", { name: "Пауза" }).click();
  for (let i = 0; i < 5; i++) await page.clock.fastForward(3000);
  await expect(count).toHaveText("демо · шаг 3 из 6");
  await guide.getByRole("button", { name: "Продолжить" }).click();
  await guide.getByRole("button", { name: "Скорость 1×" }).click();
  await expect(guide.getByRole("button", { name: "Скорость 2×" })).toBeVisible();
  // Кружок курсор тоже нажимает сам: дело закрыто.
  await playTo(page, count, "демо · шаг 6 из 6");
  await expect(guide.locator(".gd-entry.new")).toHaveClass(/done/);
  await expect(guide.locator('.gd-q[data-guide="todo"] .gd-q-side')).toHaveText("✓");
  await guide.getByRole("button", { name: "Смотреть ещё раз" }).click();
  await expect(count).toHaveText("демо · шаг 1 из 6");
  // «Пройти самому» — ручной режим с первого шага, курсора нет.
  await guide.getByRole("button", { name: "Пройти самому" }).click();
  await expect(count).toHaveText("шаг 1 из 6");
  await expect(page).toHaveURL(/#guide\?q=todo$/);
  await expect(guide.locator(".gd-cursor")).toHaveCount(0);
  await expect(guide.getByRole("button", { name: "Или дальше" })).toBeVisible();
});

test("ссылка с «&demo=1» сразу показывает демо, и пустая правая половина его предлагает", async ({ page }) => {
  const entriesBefore = await (await page.request.get("/api/entries")).text();
  await page.goto("/#guide?q=assign&demo=1");
  const guide = page.locator("#guide");
  const count = guide.locator(".gd-count");
  await expect(count).toHaveText("демо · шаг 1 из 8");
  await playTo(page, count, "демо · шаг 3 из 8");
  await page.goto("/#guide");
  await guide.getByRole("button", { name: "Смотреть демо: как поручить дело" }).click();
  await expect(count).toHaveText("демо · шаг 1 из 8");
  await expect(page).toHaveURL(/#guide\?q=assign&demo=1$/);
  // Демо идёт в копии: в журнале ничего не прибавилось.
  expect(await (await page.request.get("/api/entries")).text()).toBe(entriesBefore);
});
