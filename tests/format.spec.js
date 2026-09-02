import { test, expect } from "@playwright/test";

// Выделить слово в живом поле: панель оформления появляется над выделением.
async function selectWord(page, word) {
  await page.evaluate((needle) => {
    const field = document.querySelector("#capture-form .md-field");
    const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`нет слова ${needle}`);
  }, word);
}

test("панель оформления: жирный, цвет, превращение строки и горячие клавиши", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.type("купить молоко и хлеб");
  const bar = page.locator(".fmt-bar");
  await expect(bar).toBeHidden();

  await selectWord(page, "молоко");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Жирный · ⌘B" }).dispatchEvent("mousedown");
  await expect(field).toHaveText("купить **молоко** и хлеб");
  // Выделение осталось на слове: повторное нажатие снимает маркеры.
  await bar.getByRole("button", { name: "Жирный · ⌘B" }).dispatchEvent("mousedown");
  await expect(field).toHaveText("купить молоко и хлеб");

  // Цвет — pandoc-овский span; в поле он сразу красный.
  await bar.getByRole("button", { name: "Цвет текста и фона" }).dispatchEvent("mousedown");
  await bar.getByRole("menuitem", { name: "Красный" }).first().dispatchEvent("mousedown");
  await expect(field).toHaveText("купить [молоко]{.red} и хлеб");
  await expect(field.locator(".md-color-red")).toHaveText("молоко");

  // Превратить строку в заголовок.
  await bar.getByRole("button", { name: "Превратить в…" }).dispatchEvent("mousedown");
  await bar.getByRole("menuitem", { name: "Заголовок 2" }).dispatchEvent("mousedown");
  await expect(field).toHaveText("## купить [молоко]{.red} и хлеб");
  await expect(field.locator(".md-h2")).toBeVisible();

  // Горячая клавиша — курсив по выделению.
  await selectWord(page, "хлеб");
  await page.keyboard.press("ControlOrMeta+i");
  await expect(field).toHaveText("## купить [молоко]{.red} и *хлеб*");
});

test("шрифт и размер текста выбираются из панели и переживают перезагрузку", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.type("текст для шрифта");
  await selectWord(page, "шрифта");
  const bar = page.locator(".fmt-bar");
  await bar.getByRole("button", { name: "Шрифт и размер текста" }).dispatchEvent("mousedown");
  await bar.getByRole("menuitem", { name: "С засечками" }).dispatchEvent("mousedown");
  await expect(page.locator("html")).toHaveAttribute("data-font", "serif");
  await bar.getByRole("button", { name: "Шрифт и размер текста" }).dispatchEvent("mousedown");
  await bar.getByRole("menuitem", { name: "Мелкий" }).dispatchEvent("mousedown");
  await expect(page.locator("html")).toHaveAttribute("data-text", "small");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-font", "serif");
  await expect(page.locator("html")).toHaveAttribute("data-text", "small");
  // Возвращаем обычные, чтобы не задеть соседние прогоны.
  await page.evaluate(() => window.pagentText.set({ font: "default", size: "normal" }));
  await expect(page.locator("html")).not.toHaveAttribute("data-font", "serif");
});
