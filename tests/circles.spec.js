// Круги глазами двух людей: Саша заводит круг и зовёт Аню ссылкой, дело уходит
// к ней обычной записью, приходит полосой «к вам», а разговор о нём идёт в
// карточке. Два контекста браузера — два человека: у каждого свой день.
import { test, expect } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./fixtures/e2e-account.js";

const ANYA = { email: "anya@kizuna.test", password: "anya-very-long-password" };
// Ящики «Сегодня» открываются по часам: вечером открыт «Что делал», и дела в
// «Дне» не видны. Оба человека видят один и тот же день — 13:00, фаза «день».
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };

async function dissolveCircles(request) {
  const circles = (await (await request.get("/api/circles")).json()).circles || [];
  for (const circle of circles) await request.delete(`/api/circles/${circle.id}`);
}
async function loginAs(browser, { email, password }) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.clock.install({ time: dayAt(13) });
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
  await page.clock.install({ time: dayAt(13) });
  await page.goto("/#circles");
  await page.locator(".kc-tab.add, .kc-empty-card .kc-btn").first().click();
  await page.locator("#kc-modal-name").fill("Хаб");
  await page.getByRole("dialog").getByRole("button", { name: "Завести круг" }).click();
  // Круг открывается вкладкой, за столом пока один человек, а вместо пустого
  // разговора — «Позвать».
  await expect(page.locator(".kc-tab.on .kc-tab-name")).toHaveText("Хаб");
  await expect(page.locator(".kc-band .kc-seat:not(.add)")).toHaveCount(1);
  await expect(page.locator(".kc-alone")).toContainText("В круге пока только вы");
  await page.getByRole("button", { name: "Завести ссылку" }).click();
  // Ссылка видна только сейчас: ждём настоящую, а не маску.
  await expect(page.locator(".kc-linkrow code:not(.masked)")).toContainText("#join/");
  const invite = await page.locator(".kc-linkrow code:not(.masked)").textContent();
  expect(invite).toContain("#join/");

  // ── Аня входит по ссылке ──
  const anya = await loginAs(browser, ANYA);
  await anya.page.request.patch("/api/account", { data: { name: "Аня" } });
  await anya.page.goto(`/${invite.slice(invite.indexOf("#"))}`);
  await expect(anya.page.locator(".invite-card")).toContainText("Саша зовёт вас в круг «Хаб»");
  await anya.page.getByRole("button", { name: "Войти в круг" }).click();
  await expect(anya.page.locator(".kc-tab.on .kc-tab-name")).toHaveText("Хаб");
  await anya.page.locator(".kc-threads").getByRole("button", { name: "Ещё" }).click();
  await anya.page.getByRole("menuitem", { name: "Информация" }).click();
  await expect(anya.page.locator(".kc-info .kc-person")).toHaveCount(2);

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
  // Разговор не стоит в карточке блоком: поле лежит у нижнего края, а пока
  // сообщений нет, панели над ним нет.
  await expect(dialog.locator(".thread-input")).toBeVisible();
  await expect(dialog.locator(".talk-panel")).toBeHidden();
  await dialog.locator(".thread-input").fill("Половина готова. @Саша, цены от подрядчика были?");
  await dialog.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(dialog.locator(".talk-panel")).toBeVisible();
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
  // Esc сворачивает разговор в строку, а карточка остаётся.
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog .talk-panel")).toBeHidden();
  await expect(page.locator("#review-dialog .talk-peek")).toContainText("Половина готова");
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-close").click();
  await page.reload();
  await page.locator("#bell-summary").click();
  // Открыл — убрал: разобранный призыв из ленты ушёл.
  await expect(page.locator(".bell-row").filter({ hasText: "Аня зовёт вас в обсуждении" })).toHaveCount(0);
  await page.locator("#bell-summary").click();

  // ── «Я жду»: строка на «Сегодня» ведёт в «Круги» ──
  // «Я жду» с доски ушло: что отдано другим, говорит строка на «Сегодня», а
  // состояние каждого дела — «Круги».
  await page.goto("/#today");
  await expect(page.locator(".day-more").filter({ hasText: "На других" })).toContainText("На других 1 дело");
  await page.locator(".day-more").filter({ hasText: "На других" }).click();
  await expect(page).toHaveURL(/#circles$/);

  // ── в «Общем» круга дело стоит карточкой, и видно, что его взяли ──
  await page.goto("/#circles");
  await expect(page.locator(".kc-deed").filter({ hasText: "смету" }).locator(".kc-state")).toHaveText("взято");

  // ── круг выключается: дела уходят из списков, просьбы сворачиваются ──
  await anya.page.goto("/#circles");
  // «Информация» переживает уход со страницы — открыта с прошлого раза.
  if (!(await anya.page.locator(".kc-info").isVisible())) {
    await anya.page.locator(".kc-threads").getByRole("button", { name: "Ещё" }).click();
    await anya.page.getByRole("menuitem", { name: "Информация" }).click();
  }
  const muted = anya.page.waitForResponse((response) => response.url().endsWith("/mute") && response.request().method() === "POST");
  await anya.page.locator(".kc-switch").click();
  expect((await muted).ok()).toBe(true);
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

// Фото круга — как фото группы в Телеграме: ставится при заведении круга или
// потом в «Информации» и встаёт на знак везде, где круг виден буквой.
test("фото круга встаёт на знак во вкладке и в «Информации», а убранное возвращает букву", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const photos = (scope) => page.locator(`${scope} .kc-seal > .ava-picture`);
  await page.goto("/#circles");
  await page.locator(".kc-tab.add, .kc-empty-card .kc-btn").first().click();
  await page.locator("#kc-modal-name").fill("Дача");
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("dialog").getByRole("button", { name: "Фото круга" }).click();
  await (await chooser).setFiles({ name: "дача.png", mimeType: "image/png", buffer: png });
  await expect(photos(".kc-modal-preview")).toHaveCount(1);
  const uploaded = page.waitForResponse((response) => /\/api\/circles\/[^/]+\/photo$/.test(response.url()) && response.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "Завести круг" }).click();
  expect((await uploaded).status()).toBe(200);
  await expect(page.locator(".kc-tab.on .kc-tab-name")).toHaveText("Дача");
  await expect(photos(".kc-tab.on")).toHaveCount(1);
  // Картинка правда пришла, а не висит пустым тегом поверх буквы.
  await expect.poll(() => photos(".kc-tab.on").evaluate((image) => image.complete && image.naturalWidth)).toBeGreaterThan(0);

  // Убрал — снова буква; поставил из «Информации» — снова фото.
  await page.locator(".kc-threads").getByRole("button", { name: "Ещё" }).click();
  await page.getByRole("menuitem", { name: "Информация" }).click();
  await expect(photos(".kc-info .kc-profile")).toHaveCount(1);
  await page.locator(".kc-info").getByRole("button", { name: /Убрать фото/ }).click();
  await expect(photos(".kc-tab.on")).toHaveCount(0);
  await expect(page.locator(".kc-tab.on .kc-seal")).toHaveText("Д");
  chooser = page.waitForEvent("filechooser");
  await page.locator(".kc-info").getByRole("button", { name: /Поставить фото/ }).click();
  await (await chooser).setFiles({ name: "дача.png", mimeType: "image/png", buffer: png });
  await expect(photos(".kc-tab.on")).toHaveCount(1);
  await expect(photos(".kc-info .kc-profile")).toHaveCount(1);
  await dissolveCircles(request);
});

// Дело человеку — не уходя из круга, и призыв через «@» — кого угодно из своих
// кругов, даже если в этом разговоре его ещё нет.
test("круг: дело человеку прямо за столом и призыв того, кого в разговоре нет", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await dissolveCircles(request);
  // Соседний человек остаётся от прошлых проверок — и заблокированным ими же.
  const existing = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === ANYA.email);
  if (existing) {
    if (existing.status !== "active") await request.post(`/api/admin/users/${existing.id}/unblock`, { data: {} });
  } else {
    await request.post("/api/auth/register", { data: ANYA });
    const pending = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === ANYA.email);
    await request.post(`/api/admin/users/${pending.id}/approve`, { data: {} });
  }
  await request.patch("/api/account", { data: { name: "Саша" } });
  const circle = (await (await request.post("/api/circles", { data: { name: "Хаб" } })).json()).circle;
  const invite = await (await request.post(`/api/circles/${circle.id}/invite`, { data: {} })).json();
  const anya = await loginAs(browser, ANYA);
  await anya.page.request.patch("/api/account", { data: { name: "Аня" } });
  await anya.page.request.post(`/api/circles/invite/${invite.token}/accept`, { data: {} });

  // ── дело ставится прямо у человека за столом ──
  await page.clock.install({ time: dayAt(13) });
  await page.goto("/#circles");
  const seat = page.locator(".kc-band .kc-seat").filter({ hasText: "Аня" });
  await expect(seat).not.toContainText("смету");
  await seat.getByRole("button", { name: "Поручить дело: Аня" }).click();
  const deedField = page.locator("#kc-deed-field");
  await expect(deedField).toBeFocused();
  await deedField.fill("Прислать смету по Хабу");
  await page.locator(".kc-deed-new").getByRole("button", { name: "Отдать" }).click();
  await expect(page.locator("#toast")).toContainText("Просьба ушла");
  // Дело сразу видно и в карточке человека, и у него за столом.
  await expect(page.locator(".kc-deeds")).toContainText("смету", { timeout: 15000 });
  await expect(seat).toContainText("смету");
  // Дело теперь всегда на дату (без названной — сегодняшняя), поэтому за столом
  // рядом с ним срок; «ждёт ответа» пишется, только когда срока нет.
  await expect(seat).toContainText(/ждёт ответа|\d{1,2} [а-я]+\./);

  // У Ани это обычная просьба: строка «к вам», ответ «беру».
  await anya.page.goto("/#today");
  const ask = anya.page.locator(".inbox-row.request").filter({ hasText: "смету" });
  await expect(ask).toBeVisible({ timeout: 15000 });
  await expect(ask).toContainText("просит Саша");

  // ── «@» зовёт того, кого в разговоре нет ──
  // Комната заводится с Аней — и Аня из неё выходит: теперь её тут нет, а
  // позвать всё равно надо.
  const anyaId = (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === ANYA.email).id;
  const room = (await (await request.post(`/api/circles/${circle.id}/rooms`, { data: { name: "Смета", members: [anyaId] } })).json()).room;
  await anya.page.request.post(`/api/rooms/${room.id}/leave`, { data: {} });
  await page.goto("/#circles");
  await page.locator(".kc-chip").filter({ hasText: "Смета" }).click();
  const field = page.locator("#kc-field");
  await field.click();
  await field.type("@");
  const pop = page.locator(".mention-pop");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("в круге");
  await pop.locator(".mention-row").filter({ hasText: "Аня" }).click();
  await field.type("посмотри, пожалуйста");
  await page.locator(".kc-send").click();
  // Молча разговор никому не открывается: сперва вопрос.
  const ask2 = page.locator(".kc-share");
  await expect(ask2).toContainText("Аня ещё не в этом разговоре");
  await ask2.getByRole("button", { name: "Позвать и отправить" }).click();
  await expect(page.locator(".kc-bb .call")).toHaveText("@Аня");
  await expect(page.locator(".kc-band .kc-seat").filter({ hasText: "Аня" })).toBeVisible();

  // Аня теперь видит и разговор, и призыв в нём.
  await anya.page.goto("/#circles");
  await anya.page.locator(".kc-chip").filter({ hasText: "Смета" }).click();
  await expect(anya.page.locator(".kc-bb")).toContainText("посмотри, пожалуйста");

  // ── «@» в самом поле записи ──
  await page.goto("/#today");
  await page.locator("#capture-input").click();
  await page.keyboard.type("@");
  const menu = page.locator(".mention-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Аня");
  await expect(menu).toContainText("Хаб");
  await menu.locator(".mention-option").filter({ hasText: "Аня" }).click();
  await page.keyboard.type("глянь смету по Хабу");
  await expect(page.locator("#capture-input")).toContainText("@Аня глянь смету");
  await page.locator("#capture-form button[type=submit]").click();
  await expect
    .poll(async () => (await (await request.get("/api/entries?limit=5")).json()).entries.some((entry) => entry.raw.includes("глянь смету")), { timeout: 15000 })
    .toBe(true);

  // Позванная видит запись у себя за колокольчиком и может её открыть.
  await anya.page.goto("/#today");
  await anya.page.locator("#bell-summary").click();
  const call = anya.page.locator(".bell-row").filter({ hasText: "зовёт вас в записи" }).first();
  await expect(call).toBeVisible({ timeout: 15000 });
  await call.locator(".bell-text").click();
  await expect(anya.page.locator("#review-dialog")).toContainText("глянь смету");
  await anya.page.locator("#review-close").click();
  await anya.context.close();
  // Уборка, как в соседних проверках: круг распущен, сосед заблокирован.
  await dissolveCircles(request);
  await request.post(`/api/admin/users/${anyaId}/block`, { data: { reason: "конец прогона" } });
});
