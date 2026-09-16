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

  // ── у личной записи обсуждение есть, и видит его пока только автор ──
  await page.goto(`/#today?open=${entry.id}`);
  const dialog = page.locator("#review-dialog");
  const opener = dialog.locator(".card-talk-open");
  await expect(opener).toContainText("Обсудить");
  await opener.click();
  await expect(dialog.locator(".talk-who")).toContainText("видите только вы");

  // ── @ подсказывает любого человека из Кизуны ──
  const field = dialog.locator(".thread-input");
  await field.fill("Глянь сид, ");
  await field.pressSequentially("@Ил");
  const pop = dialog.locator(".mention-pop");
  await expect(pop).toContainText("все в Кизуне");
  await expect(pop).toContainText("Илья");
  await field.press("Enter");
  await expect(field).toHaveValue("Глянь сид, @Илья ");
  await field.pressSequentially("пожалуйста");
  await dialog.getByRole("button", { name: "Отправить", exact: true }).click();

  // ── молча запись не открывается: сначала вопрос ──
  const confirm = dialog.locator(".talk-confirm");
  await expect(confirm).toContainText("Илья получит доступ к этой записи");
  expect((await ilya.page.request.get(`/api/captures/${entry.id}`)).status()).toBe(404);
  await confirm.getByRole("button", { name: "Позвать и отправить" }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.locator(".msg-text .call")).toHaveText("@Илья");
  await expect(dialog.locator(".talk-joined")).toContainText("Илья — в обсуждении");
  await expect(dialog.locator(".talk-who")).toContainText("вы и Илья");
  await page.locator("#review-close").click();

  // ── Илья находит запись в «Обсуждениях», хотя круга у них нет ──
  await ilya.page.goto("/#circles");
  await ilya.page.getByRole("button", { name: /Обсуждения/ }).click();
  const row = ilya.page.locator(".talk-row").filter({ hasText: "карусель" });
  await expect(row).toHaveClass(/unread/);
  await row.click();
  const hers = ilya.page.locator("#review-dialog");
  await expect(hers.locator(".card-foreign")).toContainText("Вас позвали в обсуждение");
  await expect(hers.locator(".msg-text").first()).toContainText("Глянь сид");
  // Своего журнала у автора Илья не видит: чужая запись не падает в его день.
  expect((await (await ilya.page.request.get("/api/entries?limit=100")).json()).entries.length).toBe(0);

  // ── «Не следить»: запись пропадает у Ильи ──
  await hers.locator(".talk-who").click();
  await hers.getByRole("button", { name: /Не следить/ }).click();
  await expect(hers).toBeHidden();
  expect((await ilya.page.request.get(`/api/captures/${entry.id}`)).status()).toBe(404);

  // У автора снова «видите только вы».
  await page.goto(`/#today?open=${entry.id}`);
  await dialog.locator(".card-talk-open").click();
  await expect(dialog.locator(".talk-who")).toContainText("видите только вы");
  await page.locator("#review-close").click();

  await ilya.context.close();
  await request.post(`/api/admin/users/${ilyaUser.id}/block`, { data: { reason: "конец прогона" } });
});
