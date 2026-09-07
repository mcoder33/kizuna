import { test, expect } from "@playwright/test";

const shift = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

test("календарь: неделя, день, месяц, перенос мышкой с «Вернуть», быстрая запись и карточка с «до»", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  const tomorrow = shift(today, 1);
  // Неделя листается от понедельника: дела ставим внутрь текущей недели.
  const monday = shift(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const slotDay = shift(monday, 2);
  await request.post("/api/captures", { data: { raw: "Собрать список рисков по релизу", primaryType: "todo", due: { date: today, time: "12:00" } } });
  await request.post("/api/captures", { data: { raw: "Прочитать спеку по OAuth", primaryType: "todo", due: { date: slotDay } } });
  await request.post("/api/captures", { data: { raw: "Написать Антону Гришину по внедрению", primaryType: "todo", due: { date: shift(today, -3) } } });

  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "week"); });
  await page.reload();
  const calendar = page.locator("#calendar-view");
  await expect(calendar).toBeVisible();
  await expect(page.locator("nav a.active")).toHaveText("Календарь");
  await expect(page.locator("#calendar .page-heading h2")).toHaveText("Календарь");
  await expect(calendar.locator(".cal-title")).toContainText(String(new Date(`${monday}T12:00:00Z`).getUTCDate()));
  // Дело со временем — блок в сетке, дело без времени — чип в полосе «без
  // времени», просроченное — красным в сегодняшнем дне.
  const timed = calendar.locator(".cal-ev.task", { hasText: "рисков" });
  await expect(timed).toBeVisible();
  await expect(timed.locator(".cal-ev-time")).toHaveText("12:00 ");
  const chip = calendar.locator(`.cal-nt[data-date="${slotDay}"] .cal-chip`, { hasText: "OAuth" });
  await expect(chip).toBeVisible();
  await expect(calendar.locator(`.cal-nt[data-date="${today}"] .cal-chip.late`, { hasText: "Антону" })).toBeVisible();

  // Перенос чипа в слот — уточнение записи: появляется время, тост даёт «Вернуть».
  const column = calendar.locator(`.cal-col[data-date="${slotDay}"]`);
  await chip.dragTo(column, { targetPosition: { x: 30, y: 4 * 48 + 2 } });
  await expect(page.locator("#toast")).toContainText("Перенесено");
  const moved = calendar.locator(`.cal-col[data-date="${slotDay}"] .cal-ev.task`, { hasText: "OAuth" });
  await expect(moved).toBeVisible();
  await expect(moved.locator(".cal-ev-time")).toHaveText("10:00 ");
  const entries = await (await request.get("/api/entries?limit=10")).json();
  const oauth = entries.entries.find((entry) => entry.raw.includes("OAuth"));
  expect(oauth.interpretation.classification.entities.schedule).toMatchObject({ date: slotDay, time: "10:00", end: "10:30" });
  await page.locator("#toast .toast-action").click();
  await expect(calendar.locator(`.cal-nt[data-date="${slotDay}"] .cal-chip`, { hasText: "OAuth" })).toBeVisible();

  // Клик по пустому месту — новая запись с подставленным временем.
  await column.click({ position: { x: 40, y: 8 * 48 + 2 } });
  const quick = calendar.locator(".cal-pop.quick input");
  await expect(quick).toBeVisible();
  await quick.fill("Проверить быстрый ввод");
  await quick.press("Enter");
  const added = calendar.locator(`.cal-col[data-date="${slotDay}"] .cal-ev.task`, { hasText: "быстрый ввод" });
  await expect(added).toBeVisible();
  await expect(added.locator(".cal-ev-time")).toHaveText("14:00 ");

  // Поиск в шапке страницы сужает сетку.
  await page.locator("#calendar-search").fill("рисков");
  await expect(calendar.locator(".cal-ev.task", { hasText: "быстрый ввод" })).toBeHidden();
  await expect(timed).toBeVisible();
  await page.locator("#calendar-search").fill("");
  // Клавиши работают вне поля ввода: в поиске «d» — просто буква.
  await page.locator("#calendar-search").blur();
  // Клавиши: D — день с повесткой, M — месяц, W — обратно.
  await page.keyboard.press("d");
  await expect(calendar.locator(".cal-agenda")).toBeVisible();
  await expect(calendar.locator(".cal-agenda .cal-row", { hasText: "рисков" })).toBeVisible();
  await page.keyboard.press("m");
  await expect(calendar.locator(".cal-month")).toBeVisible();
  await expect(calendar.locator(`.cal-mc[data-date="${today}"].today`)).toBeVisible();
  await page.keyboard.press("w");
  await expect(calendar.locator(".cal-wk").first()).toBeVisible();

  // Карточка из календаря: у времени появляется «до», оно сохраняется как конец.
  await timed.click();
  const dialog = page.locator("#review-dialog");
  await expect(dialog).toBeVisible();
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await expect(page.locator("#review-end")).toBeVisible();
  await page.locator("#review-end").fill("13:30");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast")).toContainText("Уточнение сохранено");
  await expect(timed).toHaveAttribute("title", /12:00–13:30/);
  // Без подключённых календарей кнопки «В календарь» нет.
  await timed.click();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".card-calendar-menu")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Вид запоминается, страница не шире телефона, день — колонкой с повесткой.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(calendar).toBeVisible();
  await page.keyboard.press("d");
  await expect(calendar.locator(".cal-agenda")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("настройки: раздел «Календари» с формами Яндекса, Apple и CalDAV; Google выключен без ключей", async ({ page }) => {
  await page.goto("/#settings");
  const section = page.locator("#calendar-settings");
  await expect(section).toBeVisible();
  await expect(section.locator("#calendar-accounts")).toContainText("Пока ни одного");
  await section.locator('[data-calendar-preset="yandex"]').click();
  await expect(section.locator("#calendar-connect")).toBeVisible();
  await expect(section.locator("#calendar-connect-title")).toHaveText("Яндекс Календарь");
  await expect(section.locator("#calendar-connect-hint")).toContainText("Пароли приложений");
  await expect(section.locator("#calendar-server-row")).toBeHidden();
  await section.locator('[data-calendar-preset="custom"]').click();
  await expect(section.locator("#calendar-server-row")).toBeVisible();
  await section.locator("#calendar-connect-cancel").click();
  await expect(section.locator("#calendar-connect")).toBeHidden();
  await expect(section.locator("#calendar-google")).toHaveClass(/is-disabled/);
  // Поля Google лежат в «Ключах», секрет наружу не возвращается.
  await expect(page.locator("#setting-googleClientId")).toBeVisible();
  await expect(page.locator("#state-googleClientSecret")).toHaveText("не настроен");
});
