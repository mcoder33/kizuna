import { test, expect } from "@playwright/test";

// Telegram — второй вход в журнал. Бот здесь поддельный (заглушка на 3099,
// пути /telegram/…), но дорога та же, что у человека: токен в «Ключах»,
// «Подключить», «Запустить» в Telegram — и написанное боту встаёт на «Сегодня»
// разобранным, как запись с главной, а бот отвечает итогом разбора.
const FAKE = "http://127.0.0.1:3099/telegram";
const TOKEN = "123456789:fake-telegram-token-for-tests-000";

test("написанное боту Telegram ложится на «Сегодня» разобранным, как запись с главной", async ({ page, request }) => {
  await page.goto("/#settings");
  const section = page.getByRole("group", { name: "Telegram", exact: true });
  const state = section.locator("#telegram-state");
  await expect(state).toContainText("Бот ещё не заведён");

  try {
    // Администратор вставляет токен бота в «Ключах» — раздел ждёт, пока бот
    // выйдет на связь.
    const token = page.locator("#setting-telegramBotToken");
    await token.fill(TOKEN);
    await token.blur();
    await expect(state).toContainText("@kizuna_test_bot на связи", { timeout: 15000 });

    // «Подключить» даёт ссылку на бота и код для телефона.
    await section.getByRole("button", { name: "Подключить Telegram" }).click();
    const open = section.getByRole("link", { name: "Открыть бота в Telegram" });
    await expect(open).toBeVisible();
    await expect(section.locator("#telegram-qr")).toBeVisible();
    const href = await open.getAttribute("href");
    expect(href).toMatch(/^https:\/\/t\.me\/kizuna_test_bot\?start=[A-Za-z0-9_-]+$/);

    // В Telegram нажали «Запустить»: бот получил /start с кодом, а раздел
    // узнал о привязке сам, без перезагрузки.
    await request.post(`${FAKE}/__push`, { data: { text: `/start ${new URL(href).searchParams.get("start")}` } });
    await expect(state).toContainText("Подключён Саша (@sasha). Пишите боту @kizuna_test_bot", { timeout: 15000 });
    await expect(section.locator("#telegram-connect")).toBeHidden();
    await expect(section.getByRole("button", { name: "Отключить" })).toBeVisible();

    // Написанное боту разбирается и встаёт в «Сегодня» обычным делом.
    await request.post(`${FAKE}/__push`, { data: { text: "Нужно купить корм коту сегодня" } });
    await page.goto("/#today");
    await expect(page.locator("#todo .entry").filter({ hasText: "Нужно купить корм коту сегодня" })).toBeVisible({ timeout: 20000 });

    // Бот ответил на сообщение итогом разбора.
    const said = async () => (await (await request.get(`${FAKE}/__said`)).json()).said.map((line) => line.text).join("\n");
    await expect.poll(said, { timeout: 20000 }).toContain("📌 Легло на сегодня: «Нужно купить корм коту сегодня»");

    // «Отключить» — и раздел снова предлагает подключиться.
    await page.goto("/#settings");
    await section.getByRole("button", { name: "Отключить" }).click();
    await expect(section.getByRole("button", { name: "Подключить Telegram" })).toBeVisible();
    await expect(state).toContainText("на связи");
  } finally {
    // Бот больше никому не нужен: остальные проверки видят настройки без него.
    await page.request.put("/api/settings", { data: { telegramBotToken: "" } });
  }
});
