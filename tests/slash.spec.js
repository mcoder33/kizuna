// Меню разметки «/» живёт в заметке карточки: в поле записи на «Сегодня» его
// больше нет — туда пишут обычный текст и отправляют Enter.
import { test, expect } from "@playwright/test";

const field = "#capture-input";
const menu = ".slash-menu:not([hidden])";

// Обложка «Сегодня» живёт по часам: чтобы прогон не зависел от времени суток,
// страница видит один и тот же день — 13:00, фаза «день». Таймеры при этом
// идут как обычно.
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: dayAt(13) });
  await page.goto("/");
});

test("в поле записи косая черта — обычный символ: меню не открывается", async ({ page }) => {
  await page.locator(field).click();
  await page.locator(field).pressSequentially("/спис");
  await expect(page.locator(".slash-menu")).toHaveCount(0);
  await expect(page.locator(field)).toContainText("/спис");
});

test("меню есть в заметке карточки и уходит вместе с ней", async ({ page }) => {
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/captures") && response.request().method() === "POST");
  await page.locator(field).click();
  await page.locator(field).pressSequentially("запись для проверки меню разметки");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect((await posted).status()).toBe(202);

  const card = page.locator("#todo .entry").filter({ hasText: "проверки меню разметки" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator(".entry-title").click();
  const editor = page.locator("#card-body-editor");
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await editor.pressSequentially("/спис");
  // Меню живёт внутри модальной карточки: снаружи, в body, оно рисовалось бы
  // под top-layer'ом диалога — невидимое и не отвечающее на клики.
  const cardMenu = page.locator("#review-dialog .slash-menu:not([hidden])");
  await expect(cardMenu).toBeVisible();
  // Пункт выбирается мышью: до элемента вне top-layer клик бы не дошёл.
  await cardMenu.locator(".slash-option").first().click();
  await expect(editor).toHaveText("-", { useInnerText: true });

  // Карточку закрыли — меню не должно остаться висеть на странице.
  await page.locator("#review-close").click();
  await expect(page.locator(menu)).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(".slash-menu")).toHaveCount(0);
});
