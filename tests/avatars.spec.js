import { test, expect } from "@playwright/test";

// Аватар — лицо человека в шапке, в кругах и в разговоре: персонаж из набора
// или своя картинка. Прогон возвращает букву, чтобы соседние проверки видели
// шапку такой, какой её оставили.
test.afterEach(async ({ request }) => {
  await request.put("/api/account/avatar", { data: { preset: null } });
});

async function openAvatarSettings(page) {
  await page.goto("/#settings");
  const grid = page.locator("#avatar-presets");
  await expect(grid.locator(".avatar-choice")).toHaveCount(17);
  return grid;
}

test("персонаж из набора становится лицом в шапке, а «Буква имени» возвращает букву", async ({ page }) => {
  const grid = await openAvatarSettings(page);
  const chip = page.locator("#account-summary");
  await expect(grid.getByRole("radio", { name: "Буква имени" })).toHaveAttribute("aria-checked", "true");
  await expect(chip.locator("img")).toHaveCount(0);

  await grid.getByRole("radio", { name: "Онигири" }).click();
  await expect(grid.getByRole("radio", { name: "Онигири" })).toHaveAttribute("aria-checked", "true");
  await expect(chip.locator("img")).toHaveAttribute("src", "/public/avatars/onigiri.svg");
  await expect(page.locator("#avatar-current img")).toHaveAttribute("src", "/public/avatars/onigiri.svg");
  // Выбор переживает перезагрузку: он в учётной записи, а не в браузере.
  await page.reload();
  await expect(page.locator("#account-summary img")).toHaveAttribute("src", "/public/avatars/onigiri.svg");

  await page.locator("#avatar-presets").getByRole("radio", { name: "Буква имени" }).click();
  await expect(page.locator("#account-summary img")).toHaveCount(0);
  await expect(page.locator("#account-summary")).not.toHaveText("");
});

test("своя картинка уходит на сервер ужатым квадратом и встаёт в шапку", async ({ page }) => {
  await openAvatarSettings(page);
  // Любая картинка: браузер сам сводит её к квадрату 256 px.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const uploaded = page.waitForResponse((response) => response.url().endsWith("/api/account/avatar/image"));
  await page.locator("#avatar-file").setInputFiles({ name: "я.png", mimeType: "image/png", buffer: png });
  expect((await uploaded).status()).toBe(200);

  const picture = page.locator("#account-summary img");
  await expect(picture).toHaveAttribute("src", /^\/api\/avatars\/.+\?v=/);
  await expect.poll(() => picture.evaluate((image) => image.complete && image.naturalWidth)).toBe(256);
  await expect(page.locator("#avatar-presets").getByRole("radio", { name: "Буква имени" })).toHaveAttribute("aria-checked", "false");
});

test("не картинка не ломает выбор: остаётся прежнее лицо и слово об ошибке", async ({ page }) => {
  await openAvatarSettings(page);
  await page.locator("#avatar-file").setInputFiles({ name: "заметка.png", mimeType: "image/png", buffer: Buffer.from("это не картинка") });
  await expect(page.locator("#toast")).toContainText("не похоже на картинку");
  await expect(page.locator("#account-summary img")).toHaveCount(0);
});
