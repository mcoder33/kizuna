// Обсуждение без круга глазами двух людей: Саша зовёт Илью в свою запись через
// @, подтверждает, что тот увидит запись, — и Илья находит её в «Обсуждениях»,
// читает разговор и уходит из записи сам. Круга у них нет.
import { test, expect } from "@playwright/test";

const ILYA = { email: "ilya@kizuna.test", password: "ilya-very-long-password" };

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
async function ensureUser(request, account) {
  const find = async () => (await (await request.get("/api/admin/users")).json()).users.find((user) => user.email === account.email);
  let user = await find();
  if (!user) {
    expect((await request.post("/api/auth/register", { data: account })).status()).toBe(201);
    user = await find();
  }
  if (user.status === "pending") await request.post(`/api/admin/users/${user.id}/approve`, { data: {} });
  if (user.status === "blocked") await request.post(`/api/admin/users/${user.id}/unblock`, { data: {} });
  return user;
}

test("обсуждение без круга: позванный видит одну запись и уходит сам", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const ilyaUser = await ensureUser(request, ILYA);
  await request.patch("/api/account", { data: { name: "Саша" } });
  const ilya = await loginAs(browser, ILYA);
  await ilya.page.request.patch("/api/account", { data: { name: "Илья" } });
  const entry = (await (await request.post("/api/captures", { data: { raw: "Допинать карусель с генератором фраз" } })).json()).entry;

  // ── у личной записи поле обсуждения лежит внизу карточки сразу, без
  // кнопки; сообщений нет — и панели над полем нет. Что реплика пока себе,
  // говорит само поле, а «Отправить» появляется только с текстом ──
  await page.goto(`/#today?open=${entry.id}`);
  const dialog = page.locator("#review-dialog");
  const field = dialog.locator(".thread-input");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Написать себе или позвать через @");
  await expect(dialog.locator(".talk-panel")).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Отправить", exact: true })).toBeHidden();

  // ── @ подсказывает любого человека из Кизуны ──
  await field.fill("Глянь сид, ");
  await field.pressSequentially("@Ил");
  const pop = dialog.locator(".mention-pop");
  await expect(pop).toContainText("Позванный увидит эту запись");
  await expect(pop).toContainText("все в Кизуне");
  await expect(pop).toContainText("Илья");
  await field.press("Enter");
  await expect(field).toHaveValue("Глянь сид, @Илья ");
  await field.pressSequentially("пожалуйста");
  await dialog.getByRole("button", { name: "Отправить", exact: true }).click();

  // ── молча запись не открывается: сначала вопрос ──
  const confirm = dialog.locator(".talk-confirm");
  await expect(confirm).toContainText("Илья пока не видит эту запись");
  expect((await ilya.page.request.get(`/api/captures/${entry.id}`)).status()).toBe(404);
  await confirm.getByRole("button", { name: "Позвать и отправить" }).click();
  await expect(confirm).toBeHidden();
  // Первое сообщение — и разговор встал над полем панелью.
  await expect(dialog.locator(".talk-panel")).toBeVisible();
  await expect(dialog.locator(".msg-text .call")).toHaveText("@Илья");
  await expect(dialog.locator(".talk-joined")).toContainText("Илья — в обсуждении");
  await expect(dialog.locator(".talk-who")).toContainText("вы и Илья");
  await page.locator("#review-close").click();

  // ── Илья находит запись на вкладке «Без круга» страницы разговоров, хотя круга у них нет ──
  await ilya.page.goto("/#circles");
  await expect(ilya.page.locator(".kc-tab.on")).toContainText("Без круга");
  const row = ilya.page.locator(".kc-chip").filter({ hasText: "карусель" });
  // «@» — здесь позвали его, и он ещё не открывал: сама страница такое не открывает.
  await expect(row.locator(".kc-cnt.at")).toBeVisible();
  await row.click();
  await expect(ilya.page.locator(".kc-start")).toContainText("Начало обсуждения записи");
  await expect(ilya.page.locator(".kc-record")).toContainText("карусель");
  await expect(ilya.page.locator(".kc-tx").first()).toContainText("Глянь сид");
  await expect(ilya.page.locator(".kc-pill").filter({ hasText: "Илья — в обсуждении" })).toHaveCount(0);
  await expect(ilya.page.locator(".kc-pill").filter({ hasText: "Вы — в обсуждении" })).toBeVisible();
  await ilya.page.getByRole("button", { name: "Открыть карточку" }).click();
  const hers = ilya.page.locator("#review-dialog");
  await expect(hers.locator(".card-foreign")).toContainText("Вас позвали в обсуждение");
  await expect(hers.locator(".msg-text").first()).toContainText("Глянь сид");
  // Своего журнала у автора Илья не видит: чужая запись не падает в его день.
  expect((await (await ilya.page.request.get("/api/entries?limit=100")).json()).entries.length).toBe(0);

  // Илья отвечает прямо в карточке — у Саши это будет новое сообщение.
  await hers.locator(".thread-input").fill("Смотрю, сид на месте");
  await hers.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(hers.locator(".msg-text").filter({ hasText: "Смотрю, сид на месте" })).toBeVisible();

  // ── «Не следить»: запись пропадает у Ильи ──
  await hers.locator(".talk-who").click();
  await hers.getByRole("button", { name: /Не следить/ }).click();
  await expect(hers).toBeHidden();
  expect((await ilya.page.request.get(`/api/captures/${entry.id}`)).status()).toBe(404);

  // У автора разговор свёрнут последним пузырём — ответом Ильи с «1 новое».
  await page.goto(`/#today?open=${entry.id}`);
  const peek = dialog.locator(".talk-peek");
  await expect(peek).toContainText("Илья");
  await expect(peek).toContainText("Смотрю, сид на месте");
  await expect(peek.locator(".talk-peek-more")).toHaveText("1 новое");
  // Развернули — прочитали; снова «видите только вы», а свёрнутый пишет «ещё 1».
  await peek.click();
  await expect(dialog.locator(".talk-who")).toContainText("видите только вы");
  await page.keyboard.press("Escape");
  await expect(peek.locator(".talk-peek-more")).toHaveText("ещё 1");
  await page.locator("#review-close").click();

  await ilya.context.close();
  await request.post(`/api/admin/users/${ilyaUser.id}/block`, { data: { reason: "конец прогона" } });
});

// Карточку чаще открывают кликом по строке в «Дне», чем по ссылке. Строка
// журнала приходит без обсуждения: «@» молчал, а прошлые реплики не
// показывались, хотя по ссылке та же запись открывалась целиком.
test("запись, открытая из списка, зовёт через @ и показывает прошлые реплики", async ({ page, request, browser }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const ilyaUser = await ensureUser(request, ILYA);
  const ilya = await loginAs(browser, ILYA);
  await ilya.page.request.patch("/api/account", { data: { name: "Илья" } });
  await ilya.context.close();
  const raw = "Нужно проверить сид карусели";
  const entry = (await (await request.post("/api/captures", { data: { raw } })).json()).entry;
  expect((await request.post(`/api/captures/${entry.id}/comments`, { data: { body: "Сид лежит в папке фраз" } })).status()).toBe(201);

  // Ящик «День» открыт днём: страница видит 13:00.
  const noon = new Date();
  noon.setHours(13, 0, 0, 0);
  await page.clock.install({ time: noon });
  await page.goto("/");
  await page.locator("#todo .entry").filter({ hasText: raw }).locator(".entry-title").click();
  const dialog = page.locator("#review-dialog");
  // Разговор догрузился и свёрнут последним пузырём: своя реплика — справа.
  const peek = dialog.locator(".talk-peek");
  await expect(peek).toContainText("Сид лежит в папке фраз");
  await expect(peek).toHaveClass(/\bout\b/);
  await peek.click();
  await expect(dialog.locator(".msg-text")).toHaveText("Сид лежит в папке фраз");

  // «@» у поля открывает ту же подсказку, что и набранный руками.
  const field = dialog.locator(".thread-input");
  await expect(field).toHaveAttribute("placeholder", "Сообщение");
  await dialog.getByRole("button", { name: "Позвать человека" }).click();
  const pop = dialog.locator(".mention-pop");
  await expect(pop).toContainText("все в Кизуне");
  await expect(field).toHaveValue("@");
  await field.pressSequentially("Ил");
  await expect(pop).toContainText("Илья");
  await field.press("Enter");
  await expect(field).toHaveValue("@Илья ");
  await page.locator("#review-close").click();

  await request.post(`/api/admin/users/${ilyaUser.id}/block`, { data: { reason: "конец прогона" } });
});
