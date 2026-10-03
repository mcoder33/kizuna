import { test, expect } from "@playwright/test";

// Память помощника в настройках: человек видит, что Кизуна о нём знает, может
// дописать своё правило и стереть лишнее. Проверка идёт по той же дороге, что и
// у человека: раздел настроек, а не запрос в обход интерфейса.
test("память помощника пополняется руками и забывается по кнопке", async ({ page }) => {
  await page.goto("/#settings");
  const list = page.locator("#memory-list");
  await expect(page.getByRole("group", { name: "Память помощника" })).toBeVisible();
  await page.locator("#memory-new").fill("Созвоны с подрядчиком — это встречи");
  await page.locator("#memory-add").click();
  const rule = list.locator(".memory-item", { hasText: "Созвоны с подрядчиком" });
  await expect(rule).toBeVisible();
  await expect(rule.locator(".memory-meta")).toHaveText("записано руками");
  // Общие правила управляются отдельно, в административной области.
  await expect(page.locator("#memory-shared-row")).toHaveCount(0);
  await rule.getByRole("button", { name: "Забыть" }).click();
  await expect(list.locator(".memory-item", { hasText: "Созвоны с подрядчиком" })).toHaveCount(0);
});

test("поправка разбора запоминается сама и видна в настройках", async ({ page }) => {
  await page.goto("/#today");
  const created = await (await page.request.post("/api/captures", { data: { raw: "Прошить стенд по TCAM" } })).json();
  // Поправка должна что-то менять: тип берём заведомо другой, чем понял разбор.
  const wrong = created.entry.interpretation.classification.primaryType === "note" ? "task" : "note";
  await page.request.post(`/api/captures/${created.entry.id}/corrections`, { data: { patch: { primaryType: wrong } } });
  await page.goto("/#settings");
  const learned = page.locator("#memory-list .memory-item", { hasText: "Прошить стенд по TCAM" });
  await expect(learned).toBeVisible();
  await expect(learned.locator(".memory-meta")).toHaveText("из поправки");
  await learned.getByRole("button", { name: "Забыть" }).click();
  await expect(page.locator("#memory-list .memory-item", { hasText: "Прошить стенд по TCAM" })).toHaveCount(0);
});
