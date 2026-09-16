// Круги глазами двух людей: Саша заводит круг и зовёт Аню ссылкой, дело уходит
// к ней обычной записью, приходит полосой «к вам», а разговор о нём идёт в
// карточке. Два контекста браузера — два человека: у каждого свой день.
import { test, expect } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./fixtures/e2e-account.js";

const ANYA = { email: "anya@kizuna.test", password: "anya-very-long-password" };

async function dissolveCircles(request) {
  const circles = (await (await request.get("/api/circles")).json()).circles || [];
  for (const circle of circles) await request.delete(`/api/circles/${circle.id}`);
}
async function loginAs(browser, { email, password }) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator("#today")).toBeVisible();
  return { context, page };
}

test("круг: приглашение, просьба, «беру» и разговор с призывом", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  // Второй человек заводится заявкой и одобряется администратором — обычным путём.
  const existing = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === ANYA.email);
  if (!existing) {
    const registered = await request.post("/api/auth/register", { data: ANYA });
    expect(registered.status()).toBe(201);
    const pending = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === ANYA.email);
    await request.post(`/api/admin/users/${pending.id}/approve`, { data: {} });
  }
  // Имена: без них в круге стояли бы почтовые адреса.
  await request.patch("/api/account", { data: { name: "Саша" } });

  // ── круг заводится и зовёт ссылкой ──
  await page.goto("/#circles");
  await page.locator("#circle-new-name").fill("Хаб");
  await page.getByRole("button", { name: "+ Круг" }).click();
  // Круг открывается разговором; люди и граница — вторая половина страницы.
  await expect(page.locator(".room-pane .room-title")).toContainText("Общий");
  await page.getByRole("button", { name: /Люди и граница/ }).click();
  const card = page.locator(".circle-card").filter({ hasText: "Хаб" });
  await expect(card).toBeVisible();
  await expect(card.locator(".people-name")).toContainText("Саша");
  await card.getByRole("button", { name: "Завести ссылку" }).click();
  const invite = await card.locator(".invite-link").inputValue();
  expect(invite).toContain("#join/");

  // ── Аня входит по ссылке ──
  const anya = await loginAs(browser, ANYA);
  await anya.page.request.patch("/api/account", { data: { name: "Аня" } });
  await anya.page.goto(`/${invite.slice(invite.indexOf("#"))}`);
  await expect(anya.page.locator(".invite-card")).toContainText("Саша зовёт вас в круг «Хаб»");
  await anya.page.getByRole("button", { name: "Войти в круг" }).click();
  await anya.page.getByRole("button", { name: /Люди и граница/ }).click();
  await expect(anya.page.locator(".circle-card").filter({ hasText: "Хаб" }).locator(".people-name")).toHaveCount(2);

  // ── дело уходит фразой ──
  await page.goto("/#today");
  await page.locator("#capture-input").click();
  await page.keyboard.type("Ане — нужно прислать смету по Хабу");
  await page.locator("#capture-form button[type=submit]").click();
  const mine = page.locator("#todo .entry").filter({ hasText: "смету" });
  await expect(mine).toBeVisible();
  // У автора — честное «ждёт ответа», а не выдуманное «в работе».
  await expect(mine.locator(".tag.assign")).toContainText("ждёт ответа");
  await expect(page.locator(".day-more")).toContainText("На других");

  // ── у Ани просьба приходит полосой, а не молча в список ──
  await anya.page.goto("/#today");
  const request_ = anya.page.locator(".inbox-row.request").first();
  await expect(request_).toBeVisible();
  await expect(request_).toContainText("просит Саша");
  await expect(request_.locator(".tag.circle")).toContainText("Хаб");
  await request_.getByRole("button", { name: "Беру" }).click();
  await expect(anya.page.locator(".inbox-row")).toHaveCount(0);
  const taken = anya.page.locator("#todo .entry").filter({ hasText: "смету" });
  await expect(taken).toBeVisible();
  await expect(taken.locator(".tag.circle")).toContainText("Хаб");

  // ── разговор идёт в карточке, призыв кладёт строку автору ──
  await taken.locator(".entry-title").click();
  const dialog = anya.page.locator("#review-dialog");
  await expect(dialog.locator(".card-foreign")).toContainText("Автор записи — Саша");
  // Разговор не стоит в карточке блоком — выезжает снизу по кнопке.
  await expect(dialog.locator(".thread-input")).toBeHidden();
  await dialog.locator(".card-talk-open").click();
  // Высоту листа тянут за верхнюю кромку, и она запоминается.
  const sheet = dialog.locator(".talk-sheet");
  // лист выезжает 0.26 с — меряем, когда встал
  await anya.page.waitForTimeout(400);
  const grip = await dialog.locator(".talk-grip").boundingBox();
  const tall = (await sheet.boundingBox()).height;
  await anya.page.mouse.move(grip.x + grip.width / 2, grip.y + 8);
  await anya.page.mouse.down();
  await anya.page.mouse.move(grip.x + grip.width / 2, grip.y + 160, { steps: 6 });
  await anya.page.mouse.up();
  expect((await sheet.boundingBox()).height).toBeLessThan(tall - 100);
  expect(await anya.page.evaluate(() => localStorage.getItem("pagent.talk-height"))).not.toBeNull();
  await dialog.locator(".thread-input").fill("Половина готова. @Саша, цены от подрядчика были?");
  await dialog.getByRole("button", { name: "Отправить" }).click();
  await expect(dialog.locator(".msg-text .call")).toHaveText("@Саша");
  await anya.page.locator("#review-close").click();

  await page.reload();
  // Призыв живёт за колокольчиком: полоса «к вам» — только для того, что ждёт решения.
  await expect(page.locator(".inbox-row.call")).toHaveCount(0);
  await page.locator("#bell-summary").click();
  const call = page.locator(".bell-row").filter({ hasText: "Аня зовёт вас в обсуждении" }).first();
  await expect(call).toBeVisible();
  // Открыл карточку — значит прочитал: строка гаснет сама.
  await call.getByRole("button", { name: "Ответить" }).click();
  // Открыли по призыву — разговор выехал сам.
  await expect(page.locator("#review-dialog .msg-text")).toBeVisible();
  await expect(page.locator("#review-dialog .msg-text")).toContainText("Половина готова");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog .talk-sheet")).toBeHidden();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-close").click();
  await page.reload();
  await page.locator("#bell-summary").click();
  await expect(page.locator(".bell-row").filter({ hasText: "Аня зовёт вас в обсуждении" })).not.toHaveClass(/unread/);
  await page.locator("#bell-summary").click();

  // ── «Я жду»: четыре состояния и ни одного лишнего ──
  await page.goto("/#board?view=waiting");
  const waiting = page.locator(".wait-row").filter({ hasText: "смету" });
  await expect(waiting.locator(".wait-who")).toContainText("Аня");
  await expect(waiting.locator(".wait-state")).toContainText("взято");

  // ── круг выключается: дела уходят из списков, просьбы сворачиваются ──
  await anya.page.goto("/#circles");
  await anya.page.getByRole("button", { name: /Люди и граница/ }).click();
  await anya.page.locator(".circle-card").filter({ hasText: "Хаб" }).locator(".switch-row input").check();
  await anya.page.goto("/#today");
  await expect(anya.page.locator("#todo .entry").filter({ hasText: "смету" })).toHaveCount(0);
  await expect(anya.page.locator(".day-muted")).toContainText("выключен");
  await anya.page.locator(".day-muted button").click();
  await expect(anya.page.locator("#todo .entry").filter({ hasText: "смету" })).toBeVisible();

  // Прогон убирает за собой: круг распускается, второй человек блокируется.
  // Иначе следующие проверки живут в приложении, где у администратора есть
  // круг и сосед, — и их ожидания перестают сходиться.
  await anya.context.close();
  const circleId = (await (await request.get("/api/circles")).json()).circles[0].id;
  await request.delete(`/api/circles/${circleId}`);
  const anyaUser = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === ANYA.email);
  await request.post(`/api/admin/users/${anyaUser.id}/block`, { data: { reason: "конец прогона" } });
});
