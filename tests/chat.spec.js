// Разговоры круга глазами троих: «За столом» — вкладки кругов, люди круга за
// столом и разговоры чипами. «Общий» и разговор на весь круг видят все, комнату —
// только те, кто в ней, ответ цитатой, реакция и закреп видны каждому, а призыв
// приходит за колокольчик. Плюс то, ради чего люди заводят круг: позвать
// человека, который уже есть в приложении, — поиском, а не ссылкой.
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
// Новый круг заводится окном: название и цвет, а людей зовут следующим шагом.
async function newCircle(page, name) {
  await page.goto("/#circles");
  // Кругов ещё нет — страница сама предлагает завести первый; есть — «+ Круг» во вкладках.
  await page.locator(".kc-tab.add, .kc-empty-card .kc-btn").first().click();
  await page.locator("#kc-modal-name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Завести круг" }).click();
  await expect(page.locator(".kc-tab.on .kc-tab-name")).toHaveText(name);
  // Круг из одного — ещё не круг: вместо пустого разговора сразу «Позвать».
  await expect(page.locator(".kc-alone")).toContainText("В круге пока только вы");
}
const chip = (page, name) => page.locator(".kc-chip").filter({ has: page.locator(".kc-chip-name", { hasText: new RegExp(`^${name}$`) }) });
const openChip = (page) => page.locator(".kc-chip.on .kc-chip-name");

test("разговор круга: общий, комната подмножеством, ответ, реакция, закреп и призыв", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  await request.patch("/api/account", { data: { name: "Саша" } });
  await ensureUser(request, ANYA);
  await ensureUser(request, LESHA);

  // ── круг и люди: зовём ссылкой ──
  await newCircle(page, "Хаб");
  await page.getByRole("button", { name: "Завести ссылку" }).click();
  // Ссылка видна только сейчас: ждём настоящую, а не маску.
  await expect(page.locator(".kc-linkrow code:not(.masked)")).toContainText("#join/");
  const invite = await page.locator(".kc-linkrow code:not(.masked)").textContent();
  expect(invite).toContain("#join/");

  const anya = await loginAs(browser, ANYA, "Аня");
  await anya.page.goto(`/${invite.slice(invite.indexOf("#"))}`);
  await anya.page.getByRole("button", { name: "Войти в круг" }).click();
  await expect(anya.page.locator(".kc-tab.on .kc-tab-name")).toHaveText("Хаб");

  // Та же ссылка работает и для второго человека — она не одноразовая.
  const lesha = await loginAs(browser, LESHA, "Лёша");
  await lesha.page.goto(`/${invite.slice(invite.indexOf("#"))}`);
  await lesha.page.getByRole("button", { name: "Войти в круг" }).click();
  await expect(lesha.page.locator(".kc-tab.on .kc-tab-name")).toHaveText("Хаб");

  // ── общий разговор виден всем, кто в круге; за столом — люди круга ──
  await page.goto("/#circles");
  await expect(page.locator(".kc-band .kc-seat:not(.add)")).toHaveCount(3);
  await expect(openChip(page)).toHaveText("Общий");
  await expect(page.locator(".kc-start")).toContainText("Начало разговора круга «Хаб»");
  await page.locator("#kc-field").fill("Всем привет, начинаем Хаб");
  await page.locator("#kc-field").press("Enter");
  await expect(page.locator(".kc-grp.out .kc-tx").last()).toContainText("начинаем Хаб");
  await lesha.page.goto("/#circles");
  const hello = lesha.page.locator(".kc-bb").filter({ hasText: "начинаем Хаб" });
  await expect(hello).toBeVisible();

  // ── ответ цитатой и реакция: видны всем ──
  await hello.click({ button: "right" });
  await lesha.page.locator(".kc-ctx-react").filter({ hasText: "👍" }).click();
  await expect(hello.locator(".kc-react")).toContainText("👍");
  await hello.hover();
  await lesha.page.locator(".kc-bb-wrap").filter({ hasText: "начинаем Хаб" }).getByRole("button", { name: "Ответить" }).click();
  await expect(lesha.page.locator(".kc-replybar")).toContainText("начинаем Хаб");
  await lesha.page.locator("#kc-field").fill("Я в деле");
  await lesha.page.locator("#kc-field").press("Enter");
  const answer = lesha.page.locator(".kc-bb").filter({ hasText: "Я в деле" });
  await expect(answer.locator(".kc-quote")).toContainText("начинаем Хаб");
  await page.reload();
  await expect(page.locator(".kc-bb").filter({ hasText: "Я в деле" }).locator(".kc-quote b")).toHaveText("Вы");
  await expect(page.locator(".kc-bb").filter({ hasText: "начинаем Хаб" }).locator(".kc-react")).toContainText("👍");

  // ── закреп — одна памятка на разговор ──
  await page.locator(".kc-bb").filter({ hasText: "Я в деле" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Закрепить" }).click();
  await expect(page.locator(".kc-pinned")).toContainText("Я в деле");
  await lesha.page.reload();
  await expect(lesha.page.locator(".kc-pinned")).toContainText("Я в деле");

  // ── разговор на весь круг: его видит каждый, и Лёша тоже ──
  await page.locator(".kc-chip.add").click();
  await page.locator("#kc-modal-name").fill("Запуск");
  await expect(page.getByRole("radio", { name: /Весь круг/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Завести разговор" }).click();
  await expect(openChip(page)).toHaveText("Запуск");
  await expect(page.locator(".kc-start")).toContainText("видит весь круг");
  await lesha.page.reload();
  await expect(chip(lesha.page, "Запуск")).toBeVisible();

  // ── комната подмножеством: Лёша её не видит ──
  await page.locator(".kc-threads").getByRole("button", { name: "Ещё" }).click();
  await page.getByRole("menuitem", { name: "Новый разговор" }).click();
  await page.locator("#kc-modal-name").fill("Смета");
  await page.getByRole("radio", { name: "Только позванные" }).click();
  await page.locator(".kc-pick").filter({ hasText: "Аня" }).click();
  await page.getByRole("button", { name: "Завести разговор" }).click();
  await expect(openChip(page)).toHaveText("Смета");
  await expect(page.locator(".kc-start")).toContainText("видят только вы и Аня");
  // За столом Лёша бледнее и без «@»: в эту комнату его так не позвать.
  await expect(page.locator(".kc-seat.away")).toHaveCount(1);
  await expect(page.locator(".kc-seat.away")).toContainText("Лёша");
  await page.locator("#kc-field").fill("Цифры по подрядчику не сходятся");
  await page.locator("#kc-field").press("Enter");
  await expect(page.locator(".kc-tx").last()).toContainText("подрядчику");

  await anya.page.goto("/#circles");
  await expect(chip(anya.page, "Смета")).toBeVisible();
  await lesha.page.goto("/#circles");
  await expect(chip(lesha.page, "Смета")).toHaveCount(0);

  // Непрочитанное считается на разговоре и живёт только на этой странице: пока
  // Аня сидит в «Смете», сообщение в «Общем» ждёт её там числом.
  await chip(anya.page, "Смета").click();
  await expect(openChip(anya.page)).toHaveText("Смета");
  await chip(page, "Общий").click();
  await expect(openChip(page)).toHaveText("Общий");
  await page.locator("#kc-field").fill("И ещё одно по Хабу");
  await page.locator("#kc-field").press("Enter");
  await expect(page.locator(".kc-tx").last()).toContainText("И ещё одно по Хабу");
  await expect(async () => {
    const rooms = (await (await anya.page.request.get("/api/rooms")).json()).rooms;
    expect(rooms.find((room) => room.kind === "general").unread).toBe(1);
  }).toPass({ timeout: 5000 });
  await expect(chip(anya.page, "Общий").locator(".kc-cnt")).toHaveText("1", { timeout: 8000 });
  // Открыл разговор — значит прочитал.
  await chip(anya.page, "Общий").click();
  await expect(openChip(anya.page)).toHaveText("Общий");
  await expect(chip(anya.page, "Общий").locator(".kc-cnt")).toHaveCount(0);
  await chip(page, "Смета").click();
  await expect(openChip(page)).toHaveText("Смета");

  // ── призыв из разговора приходит за колокольчик ──
  await page.locator("#kc-field").fill("@Аня, посмотришь смету до пятницы?");
  await page.locator("#kc-field").press("Enter");
  await expect(page.locator(".kc-tx .call").last()).toHaveText("@Аня");
  await anya.page.goto("/#today");
  await expect(anya.page.locator(".inbox-row.chat")).toHaveCount(0);
  await anya.page.locator("#bell-summary").click();
  const call = anya.page.locator(".bell-row").filter({ hasText: "Саша зовёт вас в разговоре «Смета»" }).first();
  await expect(call).toBeVisible();
  await call.getByRole("button", { name: "Ответить" }).click();
  await expect(openChip(anya.page)).toHaveText("Смета");
  await anya.page.goto("/#today");
  await anya.page.locator("#bell-summary").click();
  await expect(anya.page.locator(".bell-row").filter({ hasText: "разговоре «Смета»" })).not.toHaveClass(/unread/);

  // ── стол сворачивается в лица и помнит это ──
  await page.locator(".kc-band").getByRole("button", { name: "Свернуть людей" }).click();
  await expect(page.locator(".kc-band")).toHaveCount(0);
  await expect(page.locator(".kc-folded")).toContainText("3 человека");
  await page.reload();
  await expect(page.locator(".kc-folded")).toBeVisible();
  await page.getByRole("button", { name: "Показать людей" }).click();
  await expect(page.locator(".kc-band")).toBeVisible();

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

  await newCircle(page, "Дом");
  // Список открывается сам, прямо вместо пустого разговора: людей в приложении
  // немного, и вспоминать почту соседа наизусть незачем.
  const found = page.locator(".kc-alone .kc-person");
  await expect(found.filter({ hasText: "chat-anya" })).toBeVisible();
  // Ссылка не нужна: человек уже в приложении — его находят по имени или почте.
  await page.locator("#kc-invite-q").fill("chat-anya");
  await expect(found).toHaveCount(1);
  const added = page.waitForResponse((response) => response.url().endsWith("/members") && response.request().method() === "POST");
  await found.filter({ hasText: "chat-anya" }).click();
  expect((await added).ok()).toBe(true);
  // Круг больше не из одного: на месте приглашения — разговор, за столом двое.
  await expect(page.locator(".kc-alone")).toHaveCount(0);
  await expect(page.locator(".kc-band .kc-seat:not(.add)")).toHaveCount(2);

  const anya = await loginAs(browser, ANYA, "Аня");
  await anya.page.goto("/#today");
  await anya.page.locator("#bell-summary").click();
  const row = anya.page.locator(".bell-row").filter({ hasText: "добавляет вас в круг «Дом»" }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(anya.page.locator(".kc-tab.on .kc-tab-name")).toHaveText("Дом");
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
