import { test, expect } from "@playwright/test";

// «Как пользоваться»: вопросы в «?» в шапке, шаги идут пузырём поверх
// настоящих страниц. Отправка и кружок настоящие, после прогона запись есть в
// журнале; с любого шага можно выйти, в конце — «Выйти из обучения».
// Сегодня в 13:00: записи сервер ставит на сегодня, и днём открыт ящик «День».
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: dayAt(13) });
});

test("прогон про поручение идёт по живым страницам: круги, настоящая запись, карточка, выход", async ({ page }) => {
  await page.goto("/#today");
  await page.locator(".help-menu > summary").click();
  const menu = page.locator("#help-popover");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".gd-q")).toHaveCount(18);
  await menu.locator('.gd-q[data-guide="assign"]').click();
  await expect(menu).toBeHidden();

  const bubble = page.getByRole("dialog", { name: "Как поручить дело человеку" });
  // Шаг 1: «Круги», у нового человека кругов нет — пузырь у пустой карточки.
  await expect(page.locator("#circles")).toBeVisible();
  await expect(bubble.locator(".gd-b-count")).toHaveText("шаг 1 из 7");
  await expect(bubble).toContainText("кругов пока нет");
  await expect(page.locator(".kc-empty-card")).toHaveClass(/gd-spot/);
  await bubble.getByRole("button", { name: "Дальше" }).click();
  // Шаг 2: «Сегодня», пример уже в поле, отправка настоящая.
  await expect(page.locator("#today")).toBeVisible();
  await expect(page.getByLabel("Новая запись")).toContainText("Ане — прислать смету по Хабу до пятницы");
  await expect(page.locator("#capture-submit")).toHaveClass(/gd-spot/);
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/captures") && response.request().method() === "POST");
  await page.locator("#capture-submit").click();
  expect((await posted).status()).toBe(202);
  // Шаг 3: разбор закончился — приложение само сообщает о записи. Дело на
  // пятницу встаёт в свой день, поэтому строка в сегодняшнем списке может быть,
  // а может не быть; тогда в пузыре кнопка «Открыть запись».
  await expect(bubble.locator(".gd-b-count")).toHaveText("шаг 3 из 7", { timeout: 15000 });
  await bubble.getByRole("button", { name: "Дальше" }).click();
  // Шаг 4: открыть карточку — по названию или кнопкой.
  await expect(bubble.locator(".gd-b-count")).toHaveText("шаг 4 из 7");
  const title = page.locator("[data-capture-id].gd-spot .entry-title");
  const openButton = bubble.getByRole("button", { name: "Открыть запись" });
  await expect(title.or(openButton)).toBeVisible({ timeout: 6000 });
  if (await title.isVisible()) await title.click(); else await openButton.click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  // Шаг 5: строки «Исполнитель» без круга нет — запасной текст, пузырь внизу.
  await expect(bubble.locator(".gd-b-count")).toHaveText("шаг 5 из 7");
  await expect(bubble).toContainText("появляется, когда есть круг", { timeout: 6000 });
  await bubble.getByRole("button", { name: "Дальше" }).click();
  // Шаг 6: карточка закрыта, снова «Круги».
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(page.locator("#circles")).toBeVisible();
  await expect(bubble.locator(".gd-b-count")).toHaveText("шаг 6 из 7");
  await bubble.getByRole("button", { name: "Дальше" }).click();
  // Шаг 7: ловушка про «@» и выход.
  await expect(bubble).toContainText("призыв, не поручение");
  await bubble.getByRole("button", { name: "Выйти из обучения" }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.locator("#today")).toBeVisible();
  // Пройденный вопрос помечен, а запись из прогона осталась в журнале.
  await page.locator(".help-menu > summary").click();
  await expect(menu.locator('.gd-q[data-guide="assign"]')).toHaveClass(/done/);
  const entries = await (await page.request.get("/api/entries")).text();
  expect(entries).toContain("смету по Хабу");
});

test("вопрос по разделам ведёт в настройки, «#guide» открывает список, Escape и «×» выходят", async ({ page }) => {
  await page.goto("/#settings");
  await page.getByRole("link", { name: "Как пользоваться Кизуной →" }).click();
  const menu = page.locator("#help-popover");
  await expect(menu).toBeVisible();
  await expect(page).toHaveURL(/#settings$/);
  await menu.locator("#guide-search").fill("telegram");
  await expect(menu.locator(".gd-q")).toHaveCount(1);
  await menu.locator('.gd-q[data-guide="telegram"]').click();
  const bubble = page.getByRole("dialog", { name: "Как писать из Telegram" });
  await expect(bubble).toBeVisible();
  await expect(page.locator("#settings fieldset.gd-spot legend")).toHaveText("Telegram");
  await bubble.getByRole("button", { name: "Дальше" }).click();
  await expect(bubble.locator(".gd-b-count")).toHaveText("шаг 2 из 3");
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await expect(page.locator(".gd-spot")).toHaveCount(0);

  // «#guide» открывает список там, где человек стоит, адрес возвращается.
  await page.goto("/#guide");
  await expect(menu).toBeVisible();
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page).toHaveURL(/#settings$/);
  await menu.locator('.gd-q[data-guide="board"]').click();
  await expect(page.locator("#board")).toBeVisible();
  // «×» прерывает обучение на любом шаге, подсветка снимается.
  await page.getByRole("button", { name: "Прервать обучение" }).click();
  await expect(page.getByRole("dialog", { name: "Как устроена доска" })).toHaveCount(0);
  await expect(page.locator(".gd-spot")).toHaveCount(0);
});
