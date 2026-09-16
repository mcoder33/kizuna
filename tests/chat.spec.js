// Разговор круга глазами троих: общий видят все, комнату — только те, кто в
// ней, а призыв приходит за колокольчик, как и остальные уведомления. Плюс то, ради
// чего люди заводят круг: позвать человека, который уже есть в приложении, —
// поиском, а не ссылкой.
import { test, expect } from "@playwright/test";

const ANYA = { email: "chat-anya@kizuna.test", password: "anya-very-long-password" };
const LESHA = { email: "chat-lesha@kizuna.test", password: "lesha-very-long-password" };

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

test("разговор круга: общий, комната подмножеством и призыв", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  await request.patch("/api/account", { data: { name: "Саша" } });
  await ensureUser(request, ANYA);
  await ensureUser(request, LESHA);

  // ── круг и люди: одного зовём ссылкой, другого — поиском ──
  await page.goto("/#circles");
  await page.locator("#circle-new-name").fill("Хаб");
  await page.getByRole("button", { name: "+ Круг" }).click();
  await page.getByRole("button", { name: /Люди и граница/ }).click();
  const card = page.locator(".circle-card").filter({ hasText: "Хаб" });
  await card.getByRole("button", { name: "Завести ссылку" }).click();
  const invite = await card.locator(".invite-link").inputValue();

  const anya = await loginAs(browser, ANYA, "Аня");
  await anya.page.goto(`/${invite.slice(invite.indexOf("#"))}`);
  await anya.page.getByRole("button", { name: "Войти в круг" }).click();
  await expect(anya.page.locator(".room-pane .room-title")).toContainText("Общий");

  // Та же ссылка работает и для второго человека — она не одноразовая.
  const lesha = await loginAs(browser, LESHA, "Лёша");
  await lesha.page.goto(`/${invite.slice(invite.indexOf("#"))}`);
  await lesha.page.getByRole("button", { name: "Войти в круг" }).click();
  await expect(lesha.page.locator(".room-pane .room-title")).toContainText("Общий");

  // ── общий разговор виден всем, кто в круге ──
  await page.goto("/#circles");
  await page.getByRole("button", { name: "Разговор" }).click();
  await expect(page.locator(".room-pane .room-who")).toContainText("Аня");
  await page.locator("#room-input").fill("Всем привет, начинаем Хаб");
  await page.locator("#room-input").press("Enter");
  await expect(page.locator(".room-msg .msg-text")).toContainText("начинаем Хаб");
  await lesha.page.goto("/#circles");
  await expect(lesha.page.locator(".room-msg .msg-text")).toContainText("начинаем Хаб");

  // ── комната подмножеством: Лёша её не видит ──
  await page.locator(".rail-add").first().click();
  await page.locator(".room-new input").fill("Смета");
  await page.locator(".room-new-people .mini").filter({ hasText: "Аня" }).click();
  await page.getByRole("button", { name: "Завести" }).click();
  await expect(page.locator(".room-pane .room-title")).toContainText("Смета");
  await page.locator("#room-input").fill("Цифры по подрядчику не сходятся");
  await page.locator("#room-input").press("Enter");
  await expect(page.locator(".room-msg .msg-text").last()).toContainText("подрядчику");

  await anya.page.goto("/#circles");
  await expect(anya.page.locator(".rail-room").filter({ hasText: "Смета" })).toBeVisible();
  await lesha.page.goto("/#circles");
  await expect(lesha.page.locator(".rail-room").filter({ hasText: "Смета" })).toHaveCount(0);

  // Непрочитанное считается на комнате и живёт только на этой странице: пока
  // Аня сидит в «Смете», сообщение в «Общем» ждёт её там счётчиком.
  await anya.page.locator(".rail-room").filter({ hasText: "Смета" }).click();
  await expect(anya.page.locator(".room-pane .room-title")).toContainText("Смета");
  await page.locator(".rail-room").filter({ hasText: "Общий" }).click();
  await expect(page.locator(".room-pane .room-title")).toContainText("Общий");
  await page.locator("#room-input").fill("И ещё одно по Хабу");
  await page.locator("#room-input").press("Enter");
  await expect(page.locator(".room-msg .msg-text").last()).toContainText("И ещё одно по Хабу");
  await expect(async () => {
    const rooms = (await (await anya.page.request.get("/api/rooms")).json()).rooms;
    expect(rooms.find((room) => room.name === "Общий").unread).toBe(1);
  }).toPass({ timeout: 5000 });
  await anya.page.locator(".rail-room").filter({ hasText: "Смета" }).click();
  await expect(anya.page.locator(".rail-room").filter({ hasText: "Общий" })).toContainText("1");
  // Открыл комнату — значит прочитал.
  await anya.page.locator(".rail-room").filter({ hasText: "Общий" }).click();
  await expect(anya.page.locator(".room-pane .room-title")).toContainText("Общий");
  await expect(anya.page.locator(".rail-unread")).toHaveCount(0);
  await page.locator(".rail-room").filter({ hasText: "Смета" }).click();
  await expect(page.locator(".room-pane .room-title")).toContainText("Смета");

  // ── призыв из разговора приходит за колокольчик ──
  await page.locator("#room-input").fill("@Аня, посмотришь смету до пятницы?");
  await page.locator("#room-input").press("Enter");
  await expect(page.locator(".msg-text .call").last()).toHaveText("@Аня");
  await anya.page.goto("/#today");
  await expect(anya.page.locator(".inbox-row.chat")).toHaveCount(0);
  await anya.page.locator("#bell-summary").click();
  const call = anya.page.locator(".bell-row").filter({ hasText: "Саша зовёт вас в разговоре «Смета»" }).first();
  await expect(call).toBeVisible();
  await call.getByRole("button", { name: "Ответить" }).click();
  await expect(anya.page.locator(".room-pane .room-title")).toContainText("Смета");
  await anya.page.goto("/#today");
  await anya.page.locator("#bell-summary").click();
  await expect(anya.page.locator(".bell-row").filter({ hasText: "разговоре «Смета»" })).not.toHaveClass(/unread/);

  await anya.context.close();
  await lesha.context.close();
  // Уборка: круг распущен, соседи заблокированы — следующие проверки живут в
  // приложении, где у администратора никого нет.
  const circleId = (await (await request.get("/api/circles")).json()).circles[0].id;
  await request.delete(`/api/circles/${circleId}`);
  for (const person of [ANYA, LESHA]) {
    const user = (await (await request.get("/api/admin/users")).json()).users.find((item) => item.email === person.email);
    await request.post(`/api/admin/users/${user.id}/block`, { data: { reason: "конец прогона" } });
  }
});

test("человека из приложения зовут поиском, и он узнаёт об этом за колокольчиком", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  await request.patch("/api/account", { data: { name: "Саша" } });
  await ensureUser(request, ANYA);

  await page.goto("/#circles");
  await page.locator("#circle-new-name").fill("Дом");
  await page.getByRole("button", { name: "+ Круг" }).click();
  await page.getByRole("button", { name: /Люди и граница/ }).click();
  const card = page.locator(".circle-card").filter({ hasText: "Дом" });
  // Список открывается сам, как только в поле встали: людей в приложении
  // немного, и вспоминать почту соседа наизусть незачем.
  await card.locator(".invite-search").focus();
  await expect(card.locator(".people-row.candidate").filter({ hasText: "chat-anya" })).toBeVisible();
  // Ссылка не нужна: человек уже в приложении — его находят по имени или почте.
  await card.locator(".invite-search").fill("chat-anya");
  // Ждём отфильтрованный список: в приложении могут быть и другие люди.
  await expect(card.locator(".people-row.candidate")).toHaveCount(1);
  const added = page.waitForResponse((response) => response.url().endsWith("/members") && response.request().method() === "POST");
  await card.locator(".people-row.candidate").filter({ hasText: "chat-anya" }).click();
  expect((await added).ok()).toBe(true);
  await expect(card.locator(".people-name")).toHaveCount(2);

  const anya = await loginAs(browser, ANYA, "Аня");
  await anya.page.goto("/#today");
  await anya.page.locator("#bell-summary").click();
  const row = anya.page.locator(".bell-row").filter({ hasText: "добавляет вас в круг «Дом»" }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(anya.page.locator(".room-pane .room-title")).toContainText("Общий");
  // Открыл — значит прочитал: строка больше не непрочитанная.
  await anya.page.goto("/#today");
  await anya.page.locator("#bell-summary").click();
  await expect(anya.page.locator(".bell-row").filter({ hasText: "«Дом»" })).not.toHaveClass(/unread/);

  await anya.context.close();
  const circleId = (await (await request.get("/api/circles")).json()).circles[0].id;
  await request.delete(`/api/circles/${circleId}`);
  const user = (await (await request.get("/api/admin/users")).json()).users.find((item) => item.email === ANYA.email);
  await request.post(`/api/admin/users/${user.id}/block`, { data: { reason: "конец прогона" } });
});
