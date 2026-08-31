// Учётная запись глазами человека: вход закрывает приложение, тема
// переключается и запоминается, администратор видит заявку и решает её, а
// второй фактор показывает то, что нужно поднести к телефону.
import { test, expect } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./fixtures/e2e-account.js";

test("без входа приложение не открывается", async ({ browser }) => {
  // Отдельный контекст без сохранённой куки: так выглядит первый приход.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await context.close();
});

test("неверный пароль объясняет отказ и не пускает внутрь", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Почта").fill(E2E_EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill("совсем-не-тот-пароль");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator("#auth-error")).toContainText("Неверная почта или пароль");
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});

test("тема переключается из шапки, переживает перезагрузку и хранится в учётной записи", async ({ page }) => {
  await page.goto("/");
  const root = page.locator("html");
  const toggle = page.locator("#theme-toggle");

  // Обход по кругу: как в системе → светлая → тёмная.
  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "dark");

  // Тёмная — это правда тёмный фон, а не только атрибут.
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [red, green, blue] = background.match(/\d+/g).map(Number);
  expect((red + green + blue) / 3).toBeLessThan(80);

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");

  // Выбор дошёл до сервера: он про человека, а не про вкладку.
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.settings.theme).toBe("dark");

  await page.goto("/#settings");
  await expect(page.locator("#setting-theme")).toHaveValue("dark");
  await page.locator("#setting-theme").selectOption("light");
  await expect(root).toHaveAttribute("data-theme", "light");

  // Круг замыкается: светлая → тёмная → снова как в системе. Заодно возвращаем
  // учётную запись в исходное состояние, чтобы следующие проверки видели то же,
  // что и человек, впервые открывший приложение.
  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await toggle.click();
  await expect(root).not.toHaveAttribute("data-theme", /.*/);
  await expect
    .poll(async () => (await (await page.request.get("/api/settings")).json()).settings.theme)
    .toBe("system");
});

test("администратор видит заявку, одобряет её и может заблокировать", async ({ page, request }) => {
  const email = `gost-${Date.now()}@kizuna.test`;
  const registered = await request.post("/api/auth/register", {
    data: { email, password: "gost-very-long-password" },
  });
  expect(registered.status()).toBe(201);

  await page.goto("/#admin");
  const pending = page.locator("#admin-pending .admin-user").filter({ hasText: email });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("ждёт подтверждения");

  await pending.getByRole("button", { name: "Одобрить" }).click();
  const approved = page.locator("#admin-users .admin-user").filter({ hasText: email });
  await expect(approved).toContainText("работает");

  // Блокировка спрашивает причину и сразу видна в списке.
  page.once("dialog", (dialog) => dialog.accept("проверка"));
  await approved.getByRole("button", { name: "Заблокировать" }).click();
  await expect(page.locator("#admin-users .admin-user").filter({ hasText: email })).toContainText("заблокирован");

  // Заблокированный внутрь не попадает.
  const refused = await request.post("/api/auth/login", {
    data: { email, password: "gost-very-long-password" },
  });
  expect(refused.status()).toBe(403);
});

test("последнего администратора не предлагают ни заблокировать, ни разжаловать", async ({ page }) => {
  await page.goto("/#admin");
  const self = page.locator("#admin-users .admin-user").filter({ hasText: E2E_EMAIL });
  await expect(self).toContainText("администратор");
  await expect(self.getByRole("button", { name: "Заблокировать" })).toHaveCount(0);
  await expect(self.getByRole("button", { name: "Снять администратора" })).toHaveCount(0);
});

test("второй фактор показывает код для телефона и ключ на случай, если камеры нет", async ({ page }) => {
  await page.goto("/#settings");
  await expect(page.locator("#totp-state")).toContainText("Выключен");
  await page.locator("#totp-start").click();
  await expect(page.locator("#totp-qr")).toBeVisible();
  await expect(page.locator("#totp-qr")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  await expect(page.locator("#totp-secret")).toHaveText(/^[A-Z2-7 ]{32,}$/);
  await expect(page.locator("#totp-confirm")).toBeVisible();

  // Неверный код не включает защиту, которую нечем будет открыть.
  await page.locator("#totp-code").fill("000000");
  await page.locator("#totp-confirm").click();
  await expect(page.locator("#toast")).toContainText("Код не подошёл");
  await expect(page.locator("#totp-state")).toContainText("Выключен");
});

test("предел разговора виден в настройках и закрывает разговор, когда исчерпан", async ({ page, request }) => {
  await request.put("/api/settings", { data: { voiceLimitMinutes: "0", voiceLimitWindow: "day" } });
  await page.goto("/#settings");
  await expect(page.locator("#voice-quota-state")).toContainText("разговор сейчас закрыт");

  const refused = await request.post("/api/voice/session", { data: {} });
  expect(refused.status()).toBe(429);
  expect((await refused.json()).error.code).toBe("voice_limit_minutes");

  await request.put("/api/settings", { data: { voiceLimitMinutes: "" } });
  const allowed = await request.post("/api/voice/session", { data: {} });
  expect(allowed.status()).toBe(200);
  const session = await allowed.json();
  // Разговор заведён в книге расхода: браузер отчитается о минутах, когда
  // закончит, и они попадут в предел.
  expect(session.voiceSessionId).toMatch(/^[0-9a-f-]{36}$/);
  const closed = await request.post(`/api/voice/session/${session.voiceSessionId}/close`, {
    data: { seconds: 42 },
  });
  expect(closed.status()).toBe(200);
  expect((await closed.json()).quota.spentMinutes).toBeGreaterThanOrEqual(0);
});

test("выход возвращает на страницу входа", async ({ browser }) => {
  // Вход здесь делается заново, своей сессией: выход закрывает именно её.
  // Взять сохранённую куку было бы нельзя — закрыв её, мы обрубили бы доступ
  // всем остальным проверкам, которые ею пользуются.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Почта").fill(E2E_EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator("#account-summary")).toHaveAttribute("title", E2E_EMAIL);

  await page.locator(".account-menu > summary").click();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/\/login$/);
  // Кука закрытой сессии больше ничего не открывает.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});

test("администратор ставит человеку потолок расходов на месяц", async ({ page, request }) => {
  const email = `limit-${Date.now()}@kizuna.test`;
  expect((await request.post("/api/auth/register", { data: { email, password: "limit-very-long-password" } })).status()).toBe(201);

  await page.goto("/#admin");
  const pending = page.locator("#admin-pending .admin-user").filter({ hasText: email });
  await pending.getByRole("button", { name: "Одобрить" }).click();

  const card = page.locator("#admin-users .admin-user").filter({ hasText: email });
  await expect(card).toContainText("потолок общий");

  // Потолок правится полем прямо в карточке, а не вопросом в модальном окне.
  await card.locator('input[data-key="monthlyLimitUsd"]').fill("7");
  await card.locator('input[data-key="voiceLimitMinutes"]').fill("30");
  await card.getByRole("button", { name: "Сохранить пределы" }).click();

  const saved = page.locator("#admin-users .admin-user").filter({ hasText: email });
  await expect(saved).toContainText("в этом месяце $0.00 из $7");
  await expect(saved.locator('input[data-key="monthlyLimitUsd"]')).toHaveValue("7");
  await expect(saved.locator('input[data-key="voiceLimitMinutes"]')).toHaveValue("30");

  // Пустое поле возвращает человека под общий потолок, а не обнуляет его.
  await saved.locator('input[data-key="monthlyLimitUsd"]').fill("");
  await saved.getByRole("button", { name: "Сохранить пределы" }).click();
  await expect(page.locator("#admin-users .admin-user").filter({ hasText: email })).toContainText("потолок общий");
});

test("свой расход за месяц виден в настройках", async ({ page, request }) => {
  await request.put("/api/settings", { data: { monthlyLimitUsd: "50" } });
  await page.goto("/#settings");
  await expect(page.locator("#spend-state")).toContainText("потрачено");
  await expect(page.locator("#spend-state")).toContainText("осталось");
  await expect(page.locator("#setting-monthlyLimitUsd")).toHaveValue("50");
  // Возвращаем как было: потолок общий, и он касается остальных проверок.
  expect((await request.put("/api/settings", { data: { monthlyLimitUsd: "" } })).status()).toBe(200);
  // Перезагрузка, а не переход по тому же адресу: адрес и хэш те же, и переход
  // по ним страницу не обновит — она осталась бы с прежними числами.
  await page.reload();
  await expect(page.locator("#spend-state")).toContainText("потолка нет");
});
