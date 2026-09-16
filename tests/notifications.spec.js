// Уведомления глазами двоих: просьба ждёт ответа числом на колокольчике и
// гасится одним «Беру» в ленте — и в полосе «к вам» тоже; призыв в открытую
// вкладку всплывает в углу; что куда приходит, человек решает в настройках.
import { test, expect } from "@playwright/test";

const ANYA = { email: "bell-anya@kizuna.test", password: "anya-very-long-password" };

async function dissolveCircles(request) {
  const circles = (await (await request.get("/api/circles")).json()).circles || [];
  for (const circle of circles) await request.delete(`/api/circles/${circle.id}`);
}
async function ensureUser(request, person) {
  const users = (await (await request.get("/api/admin/users")).json()).users;
  const existing = users.find((user) => user.email === person.email);
  if (existing) {
    if (existing.status !== "active") await request.post(`/api/admin/users/${existing.id}/unblock`, { data: {} });
    return existing.id;
  }
  await request.post("/api/auth/register", { data: person });
  const pending = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === person.email);
  await request.post(`/api/admin/users/${pending.id}/approve`, { data: {} });
  return pending.id;
}
async function loginAs(browser, { email, password }, name) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator("#today")).toBeVisible();
  await page.request.patch("/api/account", { data: { name } });
  return { context, page };
}
// Круг на двоих: Саша (администратор прогона) и Аня, добавленная поиском.
async function circleWithAnya(request, browser) {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  await request.patch("/api/account", { data: { name: "Саша" } });
  const anyaId = await ensureUser(request, ANYA);
  const circle = (await (await request.post("/api/circles", { data: { name: "Хаб" } })).json()).circle;
  await request.post(`/api/circles/${circle.id}/members`, { data: { userId: anyaId } });
  const anya = await loginAs(browser, ANYA, "Аня");
  return { anya, circle };
}
async function cleanup(request, anya) {
  await anya.context.close();
  await dissolveCircles(request);
  const user = (await (await request.get("/api/admin/users")).json()).users.find((item) => item.email === ANYA.email);
  await request.post(`/api/admin/users/${user.id}/block`, { data: { reason: "конец прогона" } });
  await request.put("/api/settings", { data: { notifyPrefs: "{}" } });
}

test("просьба ждёт ответа числом на колокольчике, а «Беру» в ленте гасит и полосу «к вам»", async ({ page, request, browser }) => {
  const { anya } = await circleWithAnya(request, browser);
  const posted = await anya.page.request.post("/api/captures", { data: { raw: "Саше — прислать смету по Хабу" } });
  expect(posted.ok()).toBe(true);

  await expect.poll(async () => (await (await request.get("/api/notifications")).json()).counts.waits, { timeout: 15000 }).toBe(1);
  await page.goto("/");
  await expect(page.locator("#bell-count")).toHaveText("1");
  await expect(page.locator(".inbox-row.request")).toContainText("прислать смету");

  await page.locator("#bell-summary").click();
  const ask = page.locator(".bell-row").filter({ hasText: "Аня просит" }).first();
  await expect(ask.locator(".bell-glyph, .ava")).toHaveCount(1);
  await ask.getByRole("button", { name: "Беру" }).click();
  await expect(page.locator("#bell-count")).toBeHidden();
  await expect(page.locator(".inbox-row.request")).toHaveCount(0);
  // Ответ дошёл до Ани её уведомлением.
  await expect.poll(async () => (await (await anya.page.request.get("/api/notifications")).json()).notifications.some((item) => item.kind === "answer")).toBe(true);

  await cleanup(request, anya);
});

test("призыв всплывает в углу открытой вкладки, а что идёт на телефон — решает человек", async ({ page, request, browser }) => {
  const { anya } = await circleWithAnya(request, browser);
  await page.goto("/");
  await expect(page.locator("#bell-summary")).toBeVisible();
  const rooms = (await (await anya.page.request.get("/api/rooms")).json()).rooms;
  const general = rooms.find((room) => room.kind === "general");
  await anya.page.request.post(`/api/rooms/${general.id}/messages`, { data: { body: "@Саша, посмотри смету, пожалуйста" } });

  const toastCard = page.locator(".notify-toast").filter({ hasText: "Аня зовёт вас в разговоре «Общий»" });
  await expect(toastCard).toBeVisible();
  // Призыв не ждёт ответа в строке — числа нет, есть точка.
  await expect(page.locator("#bell-count")).toBeHidden();
  await expect(page.locator("#bell-dot")).toBeVisible();
  await toastCard.getByRole("button", { name: "Скрыть" }).click();
  await expect(toastCard).toHaveCount(0);

  await page.goto("/#settings");
  const phone = page.locator("#notify-phone-call");
  await expect(phone).toHaveAttribute("aria-checked", "true");
  await phone.click();
  await expect(phone).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.notifyPrefs).toBe('{"call":"bell"}');
  await page.reload();
  await expect(page.locator("#notify-phone-call")).toHaveAttribute("aria-checked", "false");
  // Колокольчик выключен — телефон без него не бывает.
  await page.locator("#notify-bell-call").click();
  await expect(page.locator("#notify-phone-call")).toBeDisabled();

  await cleanup(request, anya);
});
