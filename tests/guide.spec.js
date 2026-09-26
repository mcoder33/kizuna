import { test, expect } from "@playwright/test";

// «Как пользоваться»: карточки-вопросы и прогон во весь экран. Прогон идёт в
// копии интерфейса, шаг делается рукой, в конце из обучения можно выйти или
// унести фразу в настоящее поле.
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T13:00:00") });
});

test("«?» в шапке открывает вопросы, прогон про поручение проходится руками и заканчивается выходом", async ({ page }) => {
  await page.goto("/#today");
  await page.getByRole("link", { name: "Как пользоваться" }).first().click();
  await expect(page.locator("#guide")).toBeVisible();
  await expect(page.locator("#guide .gd-card")).toHaveCount(18);

  await page.getByRole("button", { name: /Как поручить дело человеку/ }).click();
  const story = page.getByRole("dialog", { name: "Как поручить дело человеку" });
  await expect(story).toBeVisible();
  await expect(story.locator(".gd-count")).toHaveText("шаг 1 из 8");
  // Шаг 1: круг. Дальше.
  await expect(story.locator(".gd-kc-band")).toHaveClass(/gd-spot/);
  await story.getByRole("button", { name: "Дальше" }).click();
  // Шаг 2: фраза печатается сама, стрелка подсвечивается только после набора.
  await expect(story.locator(".gd-cap-text")).toHaveText("Ане — прислать смету по Хабу до пятницы", { timeout: 5000 });
  await expect(story.locator(".gd-cap-send")).toHaveClass(/gd-spot/);
  await story.locator(".gd-cap-send").click();
  // Шаг 3: дело с меткой «ждёт ответа».
  await expect(story.locator(".gd-entry.new .gd-tag.assign")).toHaveText("Аня · ждёт ответа");
  await story.getByRole("button", { name: "Дальше" }).click();
  // Шаг 4: за Аню нажимаем «Беру».
  await story.getByRole("button", { name: "Беру" }).click();
  await expect(story.locator(".gd-entry.new .gd-tag.assign")).toHaveText("Аня · взяла");
  await story.getByRole("button", { name: "Дальше" }).click();
  await expect(story.locator(".gd-prop-assign")).toHaveClass(/gd-spot/);
  await story.getByRole("button", { name: "Дальше" }).click();
  await expect(story.locator(".gd-kc-deed input")).toHaveValue("Прислать смету по Хабу до пятницы");
  await story.getByRole("button", { name: "Дальше" }).click();
  await expect(story.locator(".gd-count")).toHaveText("шаг 8 из 8");
  // Пройдено — есть выход из обучения, он ведёт на «Сегодня».
  await story.getByRole("button", { name: "Выйти из обучения" }).click();
  await expect(story).toHaveCount(0);
  await expect(page.locator("#today")).toBeVisible();
  await expect(page.locator("#guide")).toBeHidden();
  // Пройденный вопрос помечен.
  await page.goto("/#guide");
  await expect(page.locator('.gd-card[data-guide="assign"]')).toHaveClass(/done/);
  await expect(page.locator('.gd-card[data-guide="assign"] .gd-done-mark')).toHaveText("✓ пройдено");
});

test("«Попробовать по-настоящему» уносит фразу шага в настоящее поле, Escape закрывает прогон", async ({ page }) => {
  await page.goto("/#guide");
  await page.getByRole("button", { name: /Как записать результат/ }).click();
  const story = page.getByRole("dialog", { name: "Как записать результат" });
  await expect(story.locator(".gd-cap-send")).toHaveClass(/gd-spot/, { timeout: 5000 });
  await story.locator(".gd-cap-send").click();
  await story.getByRole("button", { name: "Дальше" }).click();
  await story.getByRole("button", { name: "Дальше" }).click();
  await story.getByRole("button", { name: "Попробовать по-настоящему" }).click();
  await expect(story).toHaveCount(0);
  await expect(page.locator("#today")).toBeVisible();
  await expect(page.getByLabel("Новая запись")).toContainText("Починил ретрай в очереди уведомлений");

  await page.goto("/#guide");
  await page.getByRole("button", { name: /Как назначить встречу/ }).click();
  const plain = page.getByRole("dialog", { name: "Как назначить встречу" });
  await expect(plain.locator(".gd-plain li")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(plain).toHaveCount(0);
});
