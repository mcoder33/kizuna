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

  const toastCard = page.locator(".notify-toast").filter({ hasText: "Аня зовёт вас в разговоре «Хаб»" });
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

// Д «Открыл — убрал»: в ленте только неразобранное. «Очистить» убирает всё,
// кроме ждущего ответа, «Заглушить» — одну строку или весь повод, и у каждого
// шага есть «Вернуть».
test("лента колокольчика: «Очистить», «Заглушить» и «Вернуть», а ждущее ответа остаётся", async ({ page, request, browser }) => {
  const { anya } = await circleWithAnya(request, browser);
  await anya.page.request.post("/api/captures", { data: { raw: "Саше — прислать смету по Хабу" } });
  const rooms = (await (await anya.page.request.get("/api/rooms")).json()).rooms;
  const general = rooms.find((room) => room.kind === "general");
  await anya.page.request.post(`/api/rooms/${general.id}/messages`, { data: { body: "@Саша, глянь смету" } });
  await expect.poll(async () => (await (await request.get("/api/notifications")).json()).notifications.map((item) => item.kind).filter((kind) => ["request", "call"].includes(kind)).sort().join(), { timeout: 15000 }).toBe("call,request");

  await page.goto("/");
  await page.locator("#bell-summary").click();
  const call = page.locator(".bell-row").filter({ hasText: "Аня зовёт вас в разговоре" });
  const ask = page.locator(".bell-row").filter({ hasText: "Аня просит" });
  await expect(call).toBeVisible();
  await expect(ask).toBeVisible();

  // «Заглушить» → «Убрать из ленты» и «Вернуть».
  await call.hover();
  await call.getByRole("button", { name: /^Заглушить/ }).click();
  await call.getByRole("menuitem", { name: /Убрать из ленты/ }).click();
  await expect(call).toHaveCount(0);
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(call).toBeVisible();

  // «Очистить» не трогает ждущее ответа.
  await page.locator(".bell-read-all").click();
  await expect(call).toHaveCount(0);
  await expect(ask).toBeVisible();
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(call).toBeVisible();

  // «Выключить такие» — тот же выключатель, что в настройках.
  await call.hover();
  await call.getByRole("button", { name: /^Заглушить/ }).click();
  await call.getByRole("menuitem", { name: /Выключить такие/ }).click();
  await expect(call).toHaveCount(0);
  await expect.poll(async () => JSON.parse((await (await request.get("/api/settings")).json()).settings.notifyPrefs).call).toBe("off");
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect.poll(async () => JSON.parse((await (await request.get("/api/settings")).json()).settings.notifyPrefs).call).not.toBe("off");

  // Открыл призыв — строка ушла из ленты, в разговоре она не нужна.
  await expect(call).toBeVisible();
  await call.locator(".bell-text").click();
  await expect(page.locator(".kc-tab.on")).toBeVisible();
  await page.locator("#bell-summary").click();
  await expect(page.locator(".bell-row").filter({ hasText: "Аня зовёт вас в разговоре" })).toHaveCount(0);
  await expect(page.locator(".bell-row").filter({ hasText: "Аня просит" })).toBeVisible();

  await cleanup(request, anya);
});

// Напоминание о деле закрывается прямо в строке: «Готово» — тот же кружок, и
// вместе с делом из ленты уходит его напоминание.
test("«Готово» в напоминании закрывает дело и убирает напоминание из ленты", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await request.put("/api/settings", { data: { notifyPrefs: JSON.stringify({ digest: "off" }) } });
  const zone = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(zone.formatToParts(new Date(Date.now() + 8 * 60000)).map((part) => [part.type, part.value]));
  const created = await (await request.post("/api/captures", { data: { raw: "Проверить доступ голосового агента", primaryType: "todo", due: { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, remind: 15 } } })).json();
  // Обход напоминаний идёт раз в полминуты.
  await expect.poll(async () => (await (await request.get("/api/notifications")).json()).notifications.some((item) => item.kind === "reminder"), { timeout: 45000, intervals: [1000] }).toBe(true);

  await page.goto("/");
  await page.locator("#bell-summary").click();
  const reminder = page.locator(".bell-row").filter({ hasText: "Проверить доступ голосового агента" });
  // До начала восемь минут, а «Отложить» — полчаса: кнопка обещает вернуть к началу.
  await expect(reminder.getByRole("button", { name: "Напомнить к началу" })).toBeVisible();
  await reminder.getByRole("button", { name: "Готово" }).click();
  await expect(reminder).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/captures/${created.entry.id}`)).json()).entry.projections.find((projection) => projection.type === "task").completion.completed).toBe(true);
  await expect.poll(async () => (await (await request.get("/api/notifications")).json()).notifications.filter((item) => item.kind === "reminder").length).toBe(0);
  await request.put("/api/settings", { data: { notifyPrefs: "{}" } });
});

// «Доброе утро» — единственный повод, который раскрывается на месте, а не ведёт
// в другое место. Поэтому «открыл — убрал» у него значит «раскрыл»: строка
// стоит, пока её читают, и не возвращается, когда колокольчик открыли снова.
test("раскрытая сводка уходит из ленты", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = new Date().toISOString().slice(0, 10);
  const digest = {
    id: "digest-e2e",
    kind: "digest",
    lead: "Доброе утро:",
    text: "4 встречи",
    meta: ["Одно дело просрочено."],
    data: { date: today },
    actors: [],
    actorIds: [],
    read: false,
    waits: false,
    snoozedUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let listed = [digest];
  let dismissed = null;
  await page.route("**/api/notifications", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: listed, counts: { waits: 0, unread: listed.filter((item) => !item.read).length }, kinds: [] }),
    }),
  );
  await page.route("**/api/notifications/read", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ counts: { waits: 0, unread: 0 } }) }),
  );
  await page.route("**/api/notifications/dismiss", (route) => {
    dismissed = JSON.parse(route.request().postData() || "{}").ids;
    listed = listed.filter((item) => !dismissed.includes(item.id));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dismissed: dismissed.map((id) => ({ id })), counts: { waits: 0, unread: 0 } }),
    });
  });

  await page.goto("/");
  await page.locator("#bell-summary").click();
  const row = page.locator(".bell-row.digest");
  await expect(row).toContainText("Доброе утро");
  await row.getByRole("button", { name: "Показать встречи и дела" }).click();
  // Читать не мешаем: раскрытая сводка остаётся на месте.
  await expect(page.locator(".bell-digest")).toBeVisible();
  await expect(row).toBeVisible();
  await expect.poll(() => dismissed).toEqual(["digest-e2e"]);

  // Закрыли колокольчик, открыли снова — сводки нет.
  await page.locator("#bell-summary").click();
  await page.locator("#bell-summary").click();
  await expect(page.locator(".bell-row.digest")).toHaveCount(0);
});
