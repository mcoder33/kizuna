import { test, expect } from "@playwright/test";

test("«День» в обзоре листается назад и вперёд до сегодняшнего дня", async ({ page }) => {
  await page.goto("/#reports");
  // «День» — вкладка по умолчанию: «Записи» стоят в конце.
  await expect(page.locator('[data-reports-tab="day"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-reports-tab]")).toHaveText(["День", "Записи"]);
  const label = page.locator("#reports-day-label"),
    prev = page.locator("#reports-day-prev"),
    next = page.locator("#reports-day-next");
  // По умолчанию — вчера, законченный день; вперёд можно шагнуть на сегодня.
  await expect(label).toContainText("вчера —");
  await expect(next).toBeEnabled();
  await next.click();
  await expect(label).toContainText("сегодня —");
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(label).toContainText("вчера —");
  // Прогон пишет записи только сегодня: раньше вчерашнего дня листать нечего.
  await expect(prev).toBeDisabled();
});
