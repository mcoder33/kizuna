import { test, expect } from "@playwright/test";

// Напоминания: блок в настройках с личными значениями и push на устройство,
// «Напомнить» в карточке рядом со сроком — уходит уточнением срока.
test("настройки напоминаний личные, push предлагается на этом устройстве, «Напомнить» в карточке уходит в срок", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/#settings");
  await expect(page.locator("#settings")).toBeVisible();
  const group = page.locator(".settings-group").filter({ has: page.locator("legend", { hasText: "Напоминания" }) });
  await expect(group).toBeVisible();
  await expect(page.locator("#setting-remindDefault")).toHaveValue("15");
  await expect(page.locator("#setting-remindHour")).toHaveValue("09:00");
  // Состояние push объясняется словами; в безголовом Chromium разрешение на
  // уведомления обычно уже отклонено, и кнопка «Включить» тогда спрятана.
  await expect(page.locator("#push-state")).toContainText(/закрытую вкладку|запрещены/);
  await expect(page.locator("#push-disable")).toBeHidden();
  await expect(page.locator("#reminders-upcoming")).toContainText("Впереди напоминаний нет");
  await page.locator("#setting-remindDefault").selectOption("60");
  await expect(page.locator("#settings-status")).toHaveText("Сохранено");
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.remindDefault).toBe("60");

  // Дело со временем через два дня: в карточке «Напомнить» показывает
  // настройку по умолчанию, выбор «за 15 минут» уходит уточнением.
  const at = new Date();
  at.setDate(at.getDate() + 2);
  const day = at.toISOString().slice(0, 10);
  const created = await (await request.post("/api/captures", { data: { raw: "встретить курьера у подъезда", primaryType: "todo", due: { date: day, time: "14:00" } } })).json();
  await page.goto("/#board");
  const card = page.locator("#board .entry, #board .board-card").filter({ hasText: "встретить курьера" }).first();
  await expect(card).toBeVisible();
  await card.getByText("встретить курьера у подъезда").first().click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  // «Напомнить» лежит в панели «Параметры», а она в карточке по умолчанию свёрнута.
  const propsBar = page.locator("#review-dialog .props-bar");
  await propsBar.click();
  await expect(propsBar).toHaveAttribute("aria-expanded", "true");
  const remind = page.locator("#review-remind");
  await expect(remind).toBeVisible();
  await expect(remind.locator("option").first()).toHaveText("как в настройках (за час)");
  await expect(remind).toHaveValue("");
  const saved = page.waitForResponse((response) => response.url().includes("/corrections") && response.request().method() === "POST");
  await remind.selectOption("15");
  // Первый Esc закрывает панель «Параметры», второй — карточку, и правка уходит.
  await remind.press("Escape");
  await expect(propsBar).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  expect((await saved).status()).toBe(200);
  await expect.poll(async () => {
    const entry = (await (await request.get(`/api/captures/${created.entry.id}`)).json()).entry;
    return entry.interpretation.classification.entities.schedule.remind;
  }).toBe(15);
  // «Ближайшие» в настройках знают о нём.
  await page.goto("/#settings");
  await expect(page.locator("#reminders-upcoming")).toContainText("встретить курьера у подъезда");
  await expect(page.locator("#reminders-upcoming")).toContainText("за 15 мин до");
});
