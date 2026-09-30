// Гостевая главная глазами человека, который пришёл по ссылке: ролик в копии
// «Сегодня» идёт сам — фраза печатается, встреча встаёт на завтра, дело — на
// сегодня, кружок закрывает дело, и оно уходит в «Сделано». Часы страницы
// подменены: ролик проматывается, а не смотрится целиком.
import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("ролик на главной проходит день по правилам «Дня» и встаёт на паузу", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const demo = page.locator("#demo-app");
  const playUntil = (check) => expect.poll(async () => { await page.clock.runFor(300); return check(); }, { timeout: 30_000 }).toBe(true);

  await expect(page.getByRole("link", { name: "Оставить заявку" }).first()).toHaveAttribute("href", "/login?join");
  await expect(demo.locator('[data-id="parcel"]')).toBeVisible();

  // Одна фраза — две записи: дело на полке «на сегодня», встреча у завтрашнего дня.
  await playUntil(async () => (await demo.locator('[data-id="smeta"]').count()) === 1);
  await expect(demo).toContainText("Записано: встреча завтра в 11:00 и дело на сегодня");
  await expect(demo.locator(".hello-app-shelf.is-today")).toHaveText("на сегодня · 2");
  await playUntil(async () => (await demo.locator('[data-id="meet"]').count()) === 1);
  await expect(demo.locator('[data-id="meet"]')).toContainText("11:00");
  await expect(demo.locator(".hello-app-shelf")).toHaveText(["по часам"]);

  // Кружок закрывает дело: из «Дня» оно уходит, в «Сделано» появляется.
  await playUntil(async () => (await demo.locator('.hello-app-tab.is-on[data-tab="journal"]').count()) === 1);
  await expect(demo.locator('[data-id="parcel"]')).toHaveClass(/is-done/);

  // Пауза останавливает ролик: кадр не меняется, сколько бы времени ни прошло.
  await page.getByRole("button", { name: "Пауза" }).click();
  const frame = await demo.innerHTML();
  await page.clock.runFor(15_000);
  expect(await demo.innerHTML()).toBe(frame);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await playUntil(async () => (await demo.innerHTML()) !== frame);
});
