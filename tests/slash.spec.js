// Меню разметки глазами человека: набрал «/», выбрал, продолжил писать.
// Проверяется не наличие списка, а то, что после выбора в поле оказалась
// настоящая разметка и каретка стоит там, откуда удобно печатать дальше.
import { test, expect } from "@playwright/test";
import { SLASH_ITEMS } from "../public/slash-menu.js";

const field = "#capture-input";
const menu = ".slash-menu:not([hidden])";
const active = ".slash-option.is-active .slash-title";

async function typeIn(page, text) {
  await page.locator(field).click();
  await page.locator(field).pressSequentially(text);
}
const valueOf = (page) =>
  page.locator(field).evaluate((node) => [...node.querySelectorAll(":scope > .md-line")].map((line) => line.textContent).join("\n"));

// Обложка «Сегодня» живёт по часам: чтобы прогон не зависел от времени суток,
// страница видит один и тот же день — 13:00, фаза «день». Таймеры при этом
// идут как обычно.
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: dayAt(13) });
  await page.goto("/");
  await page.locator(field).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
});

test("косая черта открывает список, а он подсказывает саму разметку", async ({ page }) => {
  await typeIn(page, "/");
  await expect(page.locator(menu)).toBeVisible();
  const options = page.locator(".slash-option");
  // Пустой запрос показывает весь набор: каждый вариант разметки, который поле
  // умеет рисовать, отсюда достижим.
  await expect(options).toHaveCount(SLASH_ITEMS.length);
  await expect(options.first()).toContainText("Заголовок 1");
  // Рядом с названием стоит то, что вставится: список не только называет, но и
  // учит разметке.
  await expect(options.first().locator(".slash-hint")).toHaveText("#");
  await expect(page.locator(active)).toHaveText("Заголовок 1");
});

test("набор после косой черты сужает список", async ({ page }) => {
  await typeIn(page, "/зада");
  // Сужается до дел: пункт «Задача» и выноска-задача, а не весь список.
  await expect(page.locator(".slash-option")).toHaveCount(2);
  await expect(page.locator(active)).toHaveText("Задача");
  // Латиницей находится то же самое.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await typeIn(page, "/todo");
  await expect(page.locator(active)).toHaveText("Задача");
});

test("выбор вставляет разметку, и она сразу оформлена", async ({ page }) => {
  await typeIn(page, "/зада");
  await page.keyboard.press("Enter");
  await expect(page.locator(menu)).toBeHidden();
  expect(await valueOf(page)).toBe("- [ ] ");
  // Разметка не текстом, а делом: галочка нарисована.
  await expect(page.locator(`${field} .md-checkbox`)).toBeVisible();
  // Каретка осталась там, где продолжают писать.
  await page.keyboard.type("купить кофе");
  expect(await valueOf(page)).toBe("- [ ] купить кофе");
});

test("стрелки водят по списку, Escape закрывает без следа", async ({ page }) => {
  await typeIn(page, "/");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(active)).toHaveText("Заголовок 2");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(active)).toHaveText("Якорь блока", { timeout: 3000 });
  // Список длиннее окна меню: выделенный пункт подъезжает в видимую часть.
  await expect(page.locator(".slash-option.is-active")).toBeInViewport();

  await page.keyboard.press("Escape");
  await expect(page.locator(menu)).toBeHidden();
  expect(await valueOf(page)).toBe("/", "Escape закрывает меню, а набранное не трогает");
});

test("разметка строки встаёт слева, что бы ни было набрано до неё", async ({ page }) => {
  await typeIn(page, "созвон завтра /цитат");
  await page.keyboard.press("Enter");
  expect(await valueOf(page)).toBe("> созвон завтра ");
  await expect(page.locator(`${field} .md-quote`)).toBeVisible();
});

test("обёртка ставит каретку внутрь, а не после", async ({ page }) => {
  await typeIn(page, "/жирн");
  await page.keyboard.press("Enter");
  await page.keyboard.type("важное");
  expect(await valueOf(page)).toBe("**важное**");
  await expect(page.locator(`${field} strong`)).toHaveText("важное");
});

test("блок в несколько строк разворачивается строками, а не одной", async ({ page }) => {
  await typeIn(page, "/табл");
  await page.keyboard.press("Enter");
  // Три строки таблицы — три строки модели: перенос внутри одной сломал бы поле.
  await expect(page.locator(`${field} > .md-line`)).toHaveCount(3);
  await expect(page.locator(`${field} .md-table-line`).first()).toBeVisible();
  await page.keyboard.type("Что");
  expect((await valueOf(page)).split("\n")[0]).toBe("| Что |  |");
});

test("косая черта внутри слова списка не открывает", async ({ page }) => {
  await typeIn(page, "смотри https://example.com/");
  await expect(page.locator(menu)).toBeHidden();
  await typeIn(page, " 12/34");
  await expect(page.locator(menu)).toBeHidden();
});

test("меню есть и в заметке карточки, и уходит вместе с ней", async ({ page }) => {
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/captures") && response.request().method() === "POST");
  await typeIn(page, "запись для проверки меню разметки");
  // Заметок на главной нет — запись отправляется делом, чтобы открыть её карточку отсюда.
  await page.locator('#capture-types [data-value="todo"]').click();
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
  // Меню поля записи при этом на месте: убирается только то, что принадлежало
  // закрытой карточке.
  await expect(page.locator(".slash-menu")).toHaveCount(1);
});

test("новые варианты из меню рисуются делом: формула, выноска, тег", async ({ page }) => {
  await typeIn(page, "/формул");
  await page.keyboard.press("Enter");
  await page.keyboard.type("E=mc^2");
  await expect(page.locator(`${field} .md-math`)).toBeVisible();
  expect(await valueOf(page)).toBe("$E=mc^2$");

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await typeIn(page, "/важно");
  await page.keyboard.press("Enter");
  await page.keyboard.type("не забыть");
  await expect(page.locator(`${field} .md-callout-line.md-callout-important`)).toBeVisible();
  expect(await valueOf(page)).toBe("> [!important] не забыть");

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await typeIn(page, "/тег");
  await page.keyboard.press("Enter");
  await page.keyboard.type("проект");
  await expect(page.locator(`${field} .md-tag`)).toBeVisible();
  expect(await valueOf(page)).toBe("#проект");
});
