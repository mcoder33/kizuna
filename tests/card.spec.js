import { test, expect } from "@playwright/test";

async function capture(page, raw) {
  const posted = page.waitForResponse(
    (response) => response.url().endsWith("/api/captures") && response.request().method() === "POST",
  );
  await page.getByLabel("Новая запись").fill(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect((await posted).status()).toBe(202);
  await expect(page.locator("#capture-notifications")).toContainText(raw);
}

// Обложка «Сегодня» живёт по часам: чтобы прогон не зависел от времени суток,
// страница видит один и тот же день — 13:00, фаза «день». Таймеры при этом
// идут как обычно.
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: dayAt(13) });
});

// На «Сегодня» два списка: открытое лежит в «Сегодня», закрытое — в «Что делал».
// Запись, которой заглушка модели поставила срок «завтра» (она читает слово
// даже из таблицы), с сегодняшнего списка уходит; тогда срок переносится на
// сегодня, чтобы открыть карточку отсюда: тест про карточку, а не про дату.
async function todayEntry(page, text) {
  const rows = page.locator("#todo .entry, #journal .entry").filter({ hasText: text });
  await expect
    .poll(async () => {
      if (await rows.count()) return true;
      const list = await (await page.request.get("/api/entries?limit=20")).json();
      const entry = list.entries.find((candidate) => candidate.raw.includes(text));
      const schedule = entry?.interpretation.classification.entities.schedule;
      if (entry && schedule?.date && schedule.date > (await (await page.request.get("/api/day")).json()).date) {
        const today = (await (await page.request.get("/api/day")).json()).date;
        await page.request.post(`/api/captures/${entry.id}/corrections`, { data: { patch: { schedule: { date: today, time: schedule.time || null } } } });
        await page.reload();
      }
      return false;
    }, { timeout: 15000 })
    .toBe(true);
  return rows.first();
}

async function openCard(page, listSelector, raw) {
  const card = page.locator(`${listSelector} .entry`).filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await card.locator(".entry-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
}

test("the card is two panels: description on the left, todo properties on the right, no type, project or next", async ({ page }) => {
  const raw = "Нужно проверить Hub для карточки";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  const side = page.locator("#review-dialog .card-side");
  const main = page.locator("#review-dialog .card-main");
  for (const label of ["Колонка", "День", "Люди", "Напомнить", "Повторять", "Откуда"]) {
    await expect(side.locator(".side-k", { hasText: label })).toBeVisible();
  }
  // Типа, проекта, «Далее», «Сделано» и круга среди свойств нет: у любой туду
  // только то, что есть у любой туду.
  for (const gone of ["Тип", "Проект", "Далее", "Сделано", "Круг"]) {
    await expect(side.locator(".side-k", { hasText: new RegExp(`^${gone}$`) })).toHaveCount(0);
  }
  await expect(page.locator("#review-primary-type, #review-project, #review-follow-up, #review-completed, .props-bar, .card-resize, .card-footer")).toHaveCount(0);
  // Кружок у названия, «Описание» и «Подзадача» слева; исходный текст — под описанием.
  await expect(main.locator(".card-tick")).toBeVisible();
  await expect(main.locator(".card-body .prop-section")).toHaveText("Описание");
  await expect(main.getByRole("button", { name: "Подзадача" })).toBeVisible();
  // Колонка — по доске: новая туду лежит в первой колонке «Дела»; там же «Откуда».
  await expect(page.locator("#review-column option:checked")).toHaveText("Дела");
  await expect(page.locator("#review-dialog .card-nav-col")).toHaveText("Дела");
  await expect(side.locator(".side-quiet")).toContainText("Поле записи");
  // Серая панель шириной 224px справа от сути.
  const mainBox = await main.boundingBox(), sideBox = await side.boundingBox();
  expect(Math.round(sideBox.width)).toBe(224);
  expect(sideBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 1);
  expect(Math.round((await page.locator("#review-dialog").boundingBox()).width)).toBe(880);
});

test("the card opens from the board list, where the panel used to build on a hidden page", async ({ page }) => {
  const raw = "Нужно проверить карточку из списка";
  await page.goto("/");
  await capture(page, raw);
  await page.evaluate(() => { location.hash = "#board"; });
  await page.locator("#board-columns .board-card").filter({ hasText: raw }).first().locator(".board-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog h2")).toContainText(raw);
});

test("markdown notes save, render and survive reopening without touching the raw capture", async ({ page }) => {
  const raw = "Нужно проверить заметки в карточке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill("## План\n\n- **первый** пункт\n- `код`\n\n> цитата");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);

  // Тело карточки — живое поле: разметка оформлена прямо в тексте, отдельного
  // отрендеренного вида больше нет.
  const rendered = page.locator(".card-markdown");
  await expect(rendered.locator(".md-heading")).toContainText("План");
  await expect(rendered.locator("strong")).toContainText("первый");
  await expect(rendered.locator("code")).toContainText("код");
  await expect(rendered.locator(".md-quote")).toContainText("цитата");

  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await openCard(page, "#todo", raw);
  await expect(page.locator(".card-markdown .md-heading")).toContainText("План");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = entries.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("## План");
});

test("the note body starts from the original capture without creating a note", async ({ page }) => {
  const raw = "Нужно проверить заготовку тела из оригинала";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await expect(page.locator(".card-markdown")).toContainText(raw);
  await expect(page.locator(".card-body .prop-section")).toHaveText("Описание");

  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  expect(entries.entries.find((item) => item.raw === raw).note).toBeNull();

  await page.locator(".card-markdown").click();
  await expect(page.locator("#card-body-editor")).toHaveText(raw);
  await page.locator("#card-body-editor").fill(`${raw}\n\n- дописал пункт`);
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await expect(page.locator(".card-markdown .md-bullet")).toBeVisible();
  await expect(page.locator(".card-markdown")).toContainText("дописал пункт");

  const after = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = after.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("дописал пункт");
});

test("reopening a card without edits does not create a note version", async ({ page }) => {
  const raw = "Нужно проверить что открытие не создаёт версию";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await page.locator("#review-close").click();
  await openCard(page, "#todo", raw);
  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  expect(entries.entries.find((item) => item.raw === raw).note).toBeNull();
});

test("html typed into notes is escaped, never executed", async ({ page }) => {
  const raw = "Нужно проверить экранирование в заметке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill('<img src=x onerror="window.__pwned=1">');
  await page.locator("#card-body-editor").press("ControlOrMeta+Enter");
  await expect(page.locator(".card-markdown")).toContainText("<img src=x");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator(".card-markdown img").count()).toBe(0);
});

test("escape closes the card and keeps what was typed", async ({ page }) => {
  const raw = "Нужно проверить сохранение заметки";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);
  await page.locator(".card-markdown").click();
  await page.locator("#card-body-editor").fill("дописанное перед закрытием");
  // Раньше Esc откатывал набранное — и правка, сделанная перед закрытием
  // карточки, пропадала. Теперь он закрывает карточку и сохраняет её.
  await page.locator("#card-body-editor").press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();

  await openCard(page, "#todo", raw);
  await expect(page.locator(".card-markdown")).toContainText("дописанное перед закрытием");
});

test("closing a todo moves it from «Сегодня» to «Что делал»", async ({ page }) => {
  const raw = "Нужно проверить уход закрытой задачи";
  await page.goto("/");
  await capture(page, raw);
  const card = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Готово" }).click();

  await expect(page.locator("#todo")).not.toContainText(raw);
  // «Что делал» — итог дня: закрытое кружком туду встаёт туда со временем закрытия
  await expect(page.locator("#journal")).toContainText(raw);

  // С открытых колонок доски оно тоже ушло, но лежит в «Сделано» — там же его
  // возвращают в работу, и оно встаёт в свою колонку.
  await page.evaluate(() => { location.hash = "#board"; });
  const openCards = page.locator("#board-columns .board-column:not(.board-done-column) .board-card");
  await expect(openCards.filter({ hasText: raw })).toHaveCount(0);
  const closed = page.locator("#board-columns .board-done-column .board-card").filter({ hasText: raw }).first();
  await expect(closed).toBeVisible();
  await closed.getByRole("button", { name: /Вернуть в работу/ }).click();
  await expect(page.locator("#board-columns .board-done-column .board-card").filter({ hasText: raw })).toHaveCount(0);
  await expect(openCards.filter({ hasText: raw })).toHaveCount(1);

  await page.evaluate(() => { location.hash = "#today"; });
  await expect(page.locator("#todo")).toContainText(raw);
});

test("a closed decision with an action leaves the day and never returns", async ({ page }) => {
  // Решение с отдельным действием получает проекции outcome_decision + task:
  // на главной оно лежит среди дел дня и закрывается как дело.
  const raw = "Решили по TCAM, нужно отправить протокол";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);

  const dayCard = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await dayCard.getByRole("button", { name: "Готово" }).click();

  await expect(page.locator("#todo")).not.toContainText(raw);
  await expect(page.locator("#journal")).toContainText(raw);
  // После перезагрузки закрытая запись в день не возвращается: закрыта по данным.
  await page.reload();
  await expect(page.locator("#todo .entry").filter({ hasText: raw })).toHaveCount(0);
  const entries = await (await page.request.get("/api/entries")).json();
  const entry = entries.entries.find((candidate) => candidate.raw === raw);
  expect(entry.projections.filter((p) => p.type === "task").every((p) => p.completion?.completed)).toBe(true);
});

test("properties changed in the card are saved when Escape closes it", async ({ page }) => {
  const raw = "Нужно проверить сохранение свойств по Esc";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  await openCard(page, "#todo", raw);

  await page.locator("#review-people").fill("Игорь Петров");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/corrections") && response.request().method() === "POST",
  );
  // Esc закрывает диалог сам, мимо крестика: правки должны уйти и этим путём.
  await page.locator("#review-people").press("Escape");
  expect((await saved).status()).toBe(200);
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect
    .poll(async () => (await (await page.request.get("/api/entries?limit=20")).json()).entries.find((candidate) => candidate.raw === raw).interpretation.classification.entities.people)
    .toContain("Игорь Петров");
});

test("an untouched card closes without sending a correction", async ({ page }) => {
  const raw = "Нужно проверить закрытие без правок";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#todo")).toContainText(raw);
  let corrections = 0;
  page.on("request", (request) => {
    if (request.url().includes("/corrections") && request.method() === "POST") corrections += 1;
  });
  await openCard(page, "#todo", raw);
  // Поле потрогали, но значение прежнее — уточнения быть не должно.
  const people = page.locator("#review-people");
  await people.fill(await people.inputValue());
  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await openCard(page, "#todo", raw);
  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  expect(corrections).toBe(0);
  const entries = await (await page.request.get("/api/entries?limit=100")).json(),
    entry = entries.entries.find((candidate) => candidate.raw === raw);
  expect(entry.interpretation.version).toBe(1);
});

test("markdown is decorated inside the capture field as it is typed", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  // Печатаем посимвольно: разметка должна оформляться прямо во время набора.
  await page.keyboard.type("--зачёркнуто-- и **жирный** с `кодом`");

  await expect(field.locator("del")).toHaveText("зачёркнуто");
  await expect(field.locator("strong")).toHaveText("жирный");
  await expect(field.locator("code")).toHaveText("кодом");
  // Ни один символ не удалён: маркеры остаются в тексте, лишь приглушены.
  await expect(field).toHaveText("--зачёркнуто-- и **жирный** с `кодом`");
  await expect(field.locator(".md-mark").first()).toHaveText("--");

  // Перенос строки и блочная разметка: Enter отправляет, поэтому строки
  // разделяет Shift+Enter.
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("# Заголовок");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("- пункт");
  await expect(field.locator(".md-heading")).toHaveText("Заголовок");
  await expect(field.locator(".md-bullet")).toHaveText("- ");
  await expect(field.locator(".md-line")).toHaveCount(3);

  // Исходная разметка уходит на сервер целиком, поле очищается.
  const posted = page.waitForRequest(
    (request) => request.url().endsWith("/api/captures") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const sent = JSON.parse((await posted).postData() || "{}");
  expect(sent.raw).toBe("--зачёркнуто-- и **жирный** с `кодом`\n# Заголовок\n- пункт");
  await expect(field).toHaveText("");

  // Сохранённая запись показывается с разметкой в списке и в карточке.
  const card = await todayEntry(page, "жирный");
  await expect(card).toBeVisible();
  await expect(card.locator(".entry-title strong")).toHaveText("жирный");
  await card.locator(".entry-title").click();
  await expect(page.locator("#review h2 code")).toHaveText("кодом");

  // В карточке — то же живое поле: печатаем и разметка оформляется на месте.
  const noteField = page.locator("#card-body-editor");
  await noteField.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" --правка-- в **карточке**");
  await expect(noteField.locator("del").last()).toHaveText("правка");
  await expect(noteField.locator("strong").last()).toHaveText("карточке");
  // Чистовик: маркеры раскрыты только на строке с кареткой, остальные строки
  // показывают готовый текст без серого синтаксиса.
  await expect(noteField.locator(".md-line.is-current .md-mark").first()).toBeVisible();
  await expect(noteField.locator(".md-line").first().locator(".md-mark").first()).toBeHidden();
});

test("obsidian markup works end to end: typed in the field, rendered in the card", async ({ page, request }) => {
  // Тест смотрит на превью «Сегодня», где помещаются три записи, поэтому
  // начинаем с чистого журнала — иначе соседние тесты вытеснят нашу запись.
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  const raw = [
    "# Разбор недели",
    "- [x] созвон ==сделан==",
    "- [ ] отчёт",
    "> [!warning] Осторожно",
    "| Что | Когда |",
    "| --- | ---: |",
    "| созвон | завтра |",
    "хвост #hub",
  ].join("\n");
  await page.keyboard.insertText(raw);

  // В поле разметка оформлена, но текст сохранён посимвольно.
  await expect(field.locator(".md-heading")).toHaveText("Разбор недели");
  await expect(field.locator(".md-checkbox-done")).toBeVisible();
  await expect(field.locator("mark")).toHaveText("сделан");
  await expect(field.locator(".md-callout-warning").first()).toBeVisible();
  await expect(field.locator(".md-table-line").first()).toBeVisible();
  await expect(field.locator(".md-tag")).toHaveText("#hub");

  const posted = page.waitForRequest(
    (request) => request.url().endsWith("/api/captures") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toBe(raw);

  // В карточке та же разметка становится настоящими блоками. Ищем на «Сегодня»:
  // соседние тесты могли оставить открытым другой раздел.
  await page.evaluate(() => { location.hash = "#today"; });
  const card = await todayEntry(page, "Разбор недели");
  await expect(card).toBeVisible();
  await card.locator(".entry-title").click();

  // Пока описание — копия записи, «Исходный текст» не дублирует её.
  await expect(page.locator(".card-source")).toHaveCount(0);

  // После правки описания под ним появляется «Исходный текст» — запись готовым видом.
  const body = page.locator("#card-body-editor");
  await body.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" правка");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await body.press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);
  // Блок источника собирается при открытии карточки, поэтому переоткрываем её.
  await page.locator("#review-close").click();
  await card.locator(".entry-title").click();
  await expect(page.locator(".card-source summary")).toHaveText("Исходный текст");
  await page.locator(".card-source summary").click();
  const rendered = page.locator(".card-source .md-block");
  await expect(rendered.locator("table.md-table th").last()).toHaveText("Когда");
  await expect(rendered.locator("td").first()).toHaveText("созвон");
  await expect(rendered.locator("li.md-task-done")).toContainText("созвон");
  await expect(rendered.locator(".md-callout-warning .md-callout-title")).toHaveText("Осторожно");
  await expect(rendered.locator(".md-tag")).toHaveText("#hub");
});

test("lists continue on enter and checkboxes are clickable", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();

  // Enter продолжает список тем же маркером.
  await page.keyboard.type("- [ ] первая задача");
  await page.keyboard.press("Enter");
  await page.keyboard.type("вторая задача");
  await expect(field.locator(".md-line").nth(1)).toHaveText("- [ ] вторая задача");

  // Enter на пустом пункте заканчивает список, а не плодит маркеры.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. первый пункт");
  await page.keyboard.press("Enter");
  await page.keyboard.type("второй пункт");
  await expect(field.locator(".md-line").nth(3)).toHaveText("2. второй пункт");

  // Обычный дефис даёт буллет, у задачи — чекбокс вместо буллета; сам дефис
  // задачи в чистовике спрятан, квадрат рисует стиль.
  await expect(field.locator(".md-line").first().locator(".md-checkbox")).toBeVisible();
  await expect(field.locator(".md-bullet-task").first()).toBeHidden();
  await expect(field.locator(".md-ordered").first()).toBeVisible();

  // Чекбокс переключается мышью, и это меняет сам текст записи.
  await field.locator(".md-line").first().locator(".md-checkbox").click();
  await expect(field.locator(".md-line").first()).toHaveText("- [x] первая задача");
  await expect(field.locator(".md-checkbox-done")).toHaveCount(1);
  await field.locator(".md-line").first().locator(".md-checkbox").click();
  await expect(field.locator(".md-line").first()).toHaveText("- [ ] первая задача");

  // Отмеченная задача уходит на сервер именно как [x].
  await field.locator(".md-line").first().locator(".md-checkbox").click();
  const posted = page.waitForRequest(
    (request_) => request_.url().endsWith("/api/captures") && request_.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toContain("- [x] первая задача");
});

test("the card body is the same live field as the capture card, and the title stays a title", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const raw = ["# Разбор недели", "- [ ] отчёт", "| Что | Когда |", "| --- | ---: |", "| созвон | завтра |"].join("\n");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.insertText(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();

  // Заголовок — первая значимая строка с многоточием, а не склейка таблицы.
  const card = await todayEntry(page, "Разбор недели");
  await expect(card).toBeVisible();
  await expect(card.locator(".entry-title")).toHaveText("Разбор недели …");
  await card.locator(".entry-title").click();
  await expect(page.locator("#review h2")).toHaveText("Разбор недели …");

  // Тело карточки ведёт себя ровно как поле ввода: живая разметка,
  // продолжение списка по Enter и кликабельный чекбокс.
  const body = page.locator("#card-body-editor");
  await expect(body.locator(".md-heading")).toHaveText("Разбор недели");
  await expect(body.locator(".md-checkbox")).toHaveCount(1);
  await body.locator(".md-line").nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("вторая задача");
  await expect(body.locator(".md-line").nth(2)).toHaveText("- [ ] вторая задача");
  await body.locator(".md-line").nth(2).locator(".md-checkbox").click();
  await expect(body.locator(".md-line").nth(2)).toHaveText("- [x] вторая задача");

  // Правка сохраняется как новая версия заметки, raw не меняется.
  const saved = page.waitForResponse(
    (response) => response.url().includes("/notes") && response.request().method() === "POST",
  );
  await body.press("ControlOrMeta+Enter");
  expect((await saved).status()).toBe(200);
  const entries = await (await page.request.get("/api/entries?limit=100")).json();
  const entry = entries.entries.find((item) => item.raw === raw);
  expect(entry.raw).toBe(raw);
  expect(entry.note.body).toContain("- [x] вторая задача");
});

test("tab nests a list item and shift+tab pulls it back, outside a list tab still moves focus", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();

  await page.keyboard.type("- верхний пункт");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("подпункт");
  await expect(field.locator(".md-line").nth(1)).toHaveText("  - подпункт");

  // Каретка остаётся на месте: продолжаем печатать там же, где стояли.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type(" дописано");
  await expect(field.locator(".md-line").nth(1)).toHaveText("- подпункт дописано");

  // Вне списка Tab уводит фокус дальше по форме — с клавиатуры поле не ловушка.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("обычная строка");
  await page.keyboard.press("Tab");
  await expect(field.locator(".md-line").last()).toHaveText("обычная строка");
  await expect(field).not.toBeFocused();

  // Вложенность доезжает до карточки настоящим вложенным списком.
  await field.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- верх");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("вложенный");
  const posted = page.waitForRequest(
    (request_) => request_.url().endsWith("/api/captures") && request_.method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect(JSON.parse((await posted).postData() || "{}").raw).toContain("  - вложенный");
});

// Нумерованный список: Tab делает пункт подпунктом со своим счётом с 1,
// Shift+Tab возвращает его в счёт родителя, соседи ниже подтягиваются.
test("tab turns a numbered item into a sub-item with its own numbering", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.type("1. первый");
  await page.keyboard.press("Enter");
  await page.keyboard.type("второй");
  await page.keyboard.press("Enter");
  await page.keyboard.type("третий");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("подпункт");
  await expect(field.locator(".md-line").nth(3)).toHaveText("  1. подпункт");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ещё подпункт");
  await expect(field.locator(".md-line").nth(4)).toHaveText("  2. ещё подпункт");
  // Возврат влево — следующий пункт родителя, а не «2.» подсписка.
  await page.keyboard.press("Shift+Tab");
  await expect(field.locator(".md-line").nth(4)).toHaveText("4. ещё подпункт");
  // Пункт из середины ушёл вглубь — тот, что ниже, подтянул номер.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  await expect(field.locator(".md-line").nth(1)).toHaveText("  1. второй");
  await expect(field.locator(".md-line").nth(2)).toHaveText("2. третий");
  await expect(field.locator(".md-line").nth(4)).toHaveText("3. ещё подпункт");
});

test("enter continues a callout body and the body keeps the callout colour", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();

  await page.keyboard.type("> [!warning] Осторожно");
  await page.keyboard.press("Enter");
  await page.keyboard.type("тело предупреждения");
  await expect(field.locator(".md-line").nth(1)).toHaveText("> тело предупреждения");
  // Полоса тела окрашена в цвет заголовка: блок читается целиком.
  await expect(field.locator(".md-line").nth(1)).toHaveClass(/md-callout-warning/);

  // Пустая цитата заканчивает блок, а не тянет «>» дальше.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("обычный текст");
  await expect(field.locator(".md-line").last()).toHaveText("обычный текст");
  await expect(field.locator(".md-line").last()).not.toHaveClass(/md-callout/);
});

test("a callout looks like one filled block, a plain quote stays a quote", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const field = page.getByLabel("Новая запись");
  await field.click();
  await page.keyboard.insertText("> [!warning] Осторожно\n> тело\n> вторая строка\n\nобычный текст\n\n> просто цитата");

  const lines = field.locator(".md-line");
  // Заголовок, тело и хвост размечены так, что складываются в один блок.
  await expect(lines.nth(0)).toHaveClass(/md-callout-head md-callout-warning/);
  await expect(lines.nth(1)).toHaveClass(/md-callout-body md-callout-warning/);
  await expect(lines.nth(2)).toHaveClass(/md-callout-tail/);
  // Заливка у строк блока есть, у обычного текста — нет.
  const filled = await lines.nth(1).evaluate((node) => getComputedStyle(node).backgroundColor);
  const plain = await lines.nth(4).evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(filled).not.toBe(plain);
  // Обычная цитата блоком callout не притворяется.
  await expect(lines.last()).not.toHaveClass(/md-callout/);
});



test("карточка тихо проявляется, а не летит через экран", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  // Движение в приложении одно на всё: короткое проявление на месте. Ни
  // перелёта из точки клика, ни роста размеров, ни масштаба — только
  // прозрачность и мягкий сдвиг по вертикали.
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для карточки");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "запись для карточки" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();

  const dialog = page.locator("#review-dialog");
  const cardFrames = await dialog.evaluate((node) =>
    node.getAnimations().map((animation) => ({
      duration: animation.effect.getTiming().duration,
      keys: animation.effect.getKeyframes().map((frame) => frame.transform),
    })),
  );
  expect(cardFrames.length).toBe(1);
  expect(cardFrames[0].duration).toBe(300);
  expect(cardFrames[0].keys[0]).toBe("translateY(10px)");
  expect(cardFrames[0].keys.at(-1)).toBe("none");
  await expect(dialog).toBeVisible();

  // Содержимое въезжает вместе с карточкой: отдельных анимаций у блоков нет.
  const blockAnimations = await page.locator("#review").evaluate((area) =>
    [...area.children].reduce((total, block) => total + block.getAnimations().length, 0),
  );
  expect(blockAnimations).toBe(0);
});

// Карточка — модальное окно фиксированной ширины в две панели: слева суть,
// справа серая панель свойств. Ручек размера нет.
test("the entry card is an 880px window with a 224px properties panel and no resize handles", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для проверки страницы");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "проверки страницы" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();
  await page.waitForTimeout(760);

  // Геометрия: ширина min(880, окно − 48), высота min(720, окно − 24).
  const card = await page.locator("#review-dialog").boundingBox();
  expect(Math.round(card.width)).toBe(880);
  expect(Math.round(card.height)).toBe(720);
  await expect(page.locator("#review-dialog .card-resize")).toHaveCount(0);
  // Карточка стоит по центру окна.
  expect(Math.abs(card.x + card.width / 2 - 640)).toBeLessThan(2);
  // Правая панель серая, на всю высоту окна, вплотную к правому краю.
  const side = await page.locator("#review-dialog .card-side").boundingBox();
  expect(Math.round(side.width)).toBe(224);
  expect(Math.round(side.y + side.height)).toBe(Math.round(card.y + card.height));
  expect(Math.round(side.x + side.width)).toBe(Math.round(card.x + card.width));

  // На телефоне окно во весь экран, панель свойств — под сутью.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const phone = await page.locator("#review-dialog").boundingBox();
  expect(Math.round(phone.width)).toBe(390);
  const main = await page.locator("#review-dialog .card-main").boundingBox();
  const under = await page.locator("#review-dialog .card-side").boundingBox();
  expect(under.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a capture can be deleted from its card and brought back from the toast", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const raw = "запись, которую удалим и вернём";
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();

  const card = page.locator("#today .entry").filter({ hasText: "удалим и вернём" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator(".entry-title").click();

  // Удаление живёт в карточке, отдельно от правок.
  await page.locator("#review-dialog .card-more > summary").click();
  const remove = page.locator(".card-delete");
  await expect(remove).toHaveText("Удалить");
  await remove.click();

  // Карточка закрывается, запись уходит с экрана, тост предлагает вернуть.
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(page.locator("#today")).not.toContainText("удалим и вернём");
  const toast = page.locator("#toast");
  await expect(toast).toContainText("Запись удалена");

  // Журнал ничего не забыл: запись осталась в экспорте с отметкой удаления.
  const exported = await (await request.get("/api/export")).json();
  const stored = exported.captures.find((capture) => capture.raw === raw);
  expect(stored).toBeTruthy();
  expect(stored.deleted_at).toBeTruthy();

  // «Вернуть» поднимает запись обратно.
  await toast.getByRole("button", { name: "Вернуть" }).click();
  await expect(page.locator("#today .entry").filter({ hasText: "удалим и вернём" }).first()).toBeVisible();
  await expect(toast).toContainText("Запись возвращена");
});

test("a card reopened after closing is visible, not a ghost", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись для повторного открытия");
  await page.getByRole("button", { name: "Сохранить запись" }).click();

  const card = page.locator("#today .entry").filter({ hasText: "повторного открытия" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  const dialog = page.locator("#review-dialog");

  // Анимация закрытия оставляла карточку прозрачной: со второго раза она была
  // «открыта», но невидима — размер есть, видимости нет.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await card.locator(".entry-title").click();
    await page.waitForTimeout(750);
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.locator("#review-close").click();
    await page.waitForTimeout(600);
    await expect(dialog).toBeHidden();
  }
});

// Вложения: файл живёт рядом с записью, а не внутри текста. Проверяем весь
// путь — выбор файла, плитка, быстрый предпросмотр, удаление и скрепка в списке.
test("к записи можно приложить файл, посмотреть его и убрать", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("запись со снимком доски");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "снимком доски" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await entry.locator(".entry-title").click();

  const files = page.locator(".card-files");
  await expect(files).toContainText("Пока пусто");

  // Настоящий выбор файла: тот же путь, что и у человека.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator(".card-files input[type=file]").setInputFiles({
    name: "снимок доски.png",
    mimeType: "image/png",
    buffer: png,
  });

  const tile = page.locator(".file-tile").first();
  await expect(tile).toBeVisible();
  await expect(tile.locator(".file-name")).toHaveText("снимок доски.png");
  await expect(tile.locator("img.file-thumb")).toBeVisible();

  // Быстрый предпросмотр: картинка открывается тут же, не скачиванием.
  await tile.locator(".file-open").click();
  const preview = page.locator("#preview-dialog");
  await expect(preview).toBeVisible();
  await expect(page.locator("#preview-title")).toHaveText("снимок доски.png");
  await expect(page.locator(".preview-image")).toBeVisible();
  await expect(page.locator("#preview-download")).toHaveAttribute("download", "снимок доски.png");
  await page.locator("#preview-close").click();
  await expect(preview).toBeHidden();

  // В списке видно скрепку с числом — не открывая карточку.
  await page.locator("#review-close").click();
  await expect(entry.locator(".entry-meta .tag.files")).toHaveText("📎 1");

  // Убрать вложение можно там же, где приложили.
  await entry.locator(".entry-title").click();
  await page.locator(".file-remove").first().click();
  await expect(page.locator(".card-files")).toContainText("Пока пусто");
  await page.locator("#review-close").click();
  await expect(entry.locator(".entry-meta .tag.files")).toHaveCount(0);
});

// Набранное в карточке не должно пропадать: карточку закрывают крестиком,
// фоном и Esc — во всех трёх случаях заметка сохраняется сама.
test("заметка сохраняется при любом закрытии карточки", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.keyboard.type("встреча по колл-центру");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const entry = page.locator("#today .entry").filter({ hasText: "колл-центру" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  // Esc раньше откатывал набранное — теперь он просто уводит фокус.
  await entry.locator(".entry-title").click();
  await page.locator(".card-markdown").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" :: правка перед Esc");
  // Esc закрывает карточку — и уносит набранное с собой в заметку.
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();

  await entry.locator(".entry-title").click();
  await expect(page.locator(".card-markdown")).toContainText("правка перед Esc");

  // Закрытие крестиком прямо из поля — тоже сохраняет.
  await page.locator(".card-markdown").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" :: и перед крестиком");
  await page.locator("#review-close").click();
  await expect(page.locator("#review-dialog")).toBeHidden();

  await entry.locator(".entry-title").click();
  await expect(page.locator(".card-markdown")).toContainText("и перед крестиком");
  await page.locator("#review-close").click();

  // Сохранилось на сервере, а не только на экране.
  const entries = await (await request.get("/api/entries?limit=5")).json();
  const saved = entries.entries.find((item) => item.raw.includes("колл-центру"));
  expect(saved.note.body).toContain("правка перед Esc");
  expect(saved.note.body).toContain("и перед крестиком");
});

test("у карточки нет значка статуса: только кружок, а закрытая говорит «Сделано»", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const raw = "Нужно проверить статус на карточке";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  // Значка статуса и свёрнутой строки свойств нет: состояние читается по кружку.
  await expect(page.locator("#review-dialog .entry-status, #review-dialog .props-summary")).toHaveCount(0);
  await expect(page.locator("#review-dialog .card-tick")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");

  // Закрытая чекбоксом задача показывает «Сделано» — карточка открывается
  // из «Обзора» за сегодня, где закрытые дела перечислены строками.
  const entry = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await entry.locator(".completion-button").click();
  await expect(page.locator("#todo .entry").filter({ hasText: raw })).toHaveCount(0);
  await page.goto("/#reports");
  await page.locator('[data-reports-tab="day"]').click();
  await page.locator("#reports-day-next").click();
  await page.locator("#reports-day .report-items li").filter({ hasText: raw }).first().click();
  await expect(page.locator("#review-dialog .card-done-ok")).toContainText("Сделано");
  await expect(page.locator("#review-dialog .card-nav-col")).toHaveText("Сделано");
});

test("заголовок записи правится прямо в карточке", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const raw = "Нужно проверить правку заголовка";
  await page.goto("/");
  await capture(page, raw);
  await openCard(page, "#todo", raw);

  await page.locator("#review-dialog h2.card-title").click();
  const editor = page.locator("#review-dialog .card-title-edit");
  await expect(editor).toBeFocused();
  await editor.fill("Проверить заголовок после правки");
  await page.keyboard.press("Enter");
  await expect(page.locator("#review-dialog h2.card-title")).toContainText("Проверить заголовок после правки");
  // Изменение видно и в списке — заголовок один везде.
  await page.keyboard.press("Escape");
  await expect(page.locator("#todo")).toContainText("Проверить заголовок после правки");
  // Escape в поле не закрывает карточку, а возвращает прежний заголовок.
  await openCard(page, "#todo", "Проверить заголовок после правки");
  await page.locator("#review-dialog h2.card-title").click();
  await page.keyboard.type("хвост");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog h2.card-title")).toContainText("Проверить заголовок после правки");
});

test("a screenshot pasted into the capture field opens a preview on click", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Новая запись").click();
  await page.evaluate(() => {
    // PNG 1×1 — снимок из буфера, ещё не отправленный на сервер.
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
      (char) => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document
      .querySelector("#capture-form")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const shot = page.locator("#capture-shots .capture-shot");
  await expect(shot).toHaveCount(1);
  await shot.getByRole("button", { name: /^Открыть/ }).click();
  await expect(page.locator("#preview-dialog")).toBeVisible();
  await expect(page.locator("#preview-dialog .preview-image")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#preview-title")).toContainText("снимок-");
  await page.locator("#preview-close").click();
  await expect(page.locator("#preview-dialog")).toBeHidden();
  // Просмотр ничего не отправляет и не убирает: снимок остаётся в полосе.
  await expect(shot).toHaveCount(1);
});

test("a capture the model could not parse still lands as a todo for today", async ({ page }) => {
  const raw = "Созвон с Женей был по доработкам [[сбой модели]]";
  await page.goto("/");
  await capture(page, raw);
  // Модель упала — запись всё равно туду на сегодня: ничего не теряется и
  // ничего не переспрашивается, поправить можно в карточке.
  const findEntry = async () => (await (await page.request.get("/api/entries?limit=100")).json()).entries.find((candidate) => candidate.raw.includes("Созвон с Женей")) || null;
  await expect.poll(findEntry, { timeout: 15000 }).not.toBeNull();
  const row = page.locator("#todo .entry").filter({ hasText: "Созвон с Женей" });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator(".entry-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-close").click();
  await expect(page.locator("#todo")).toContainText("Созвон с Женей");
});

test("on a phone the card stays pinned to the screen while the page behind is scrolled, and paste lands in the note", async ({ page }) => {
  const raw = "Нужно проверить карточку на телефоне";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await capture(page, raw);
  // Список прокручен вниз — в верхнем слое relative-диалог открывался бы
  // выше экрана, у начала документа.
  await page.evaluate(() => { location.hash = "#board"; });
  const card = page.locator("#board-columns .board-card").filter({ hasText: raw }).first();
  await expect(card).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await card.locator(".board-title").click();
  const dialog = page.locator("#review-dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350);
  await expect(dialog).toHaveCSS("position", "fixed");
  expect(Math.abs((await dialog.boundingBox()).y)).toBeLessThan(2);

  // Прокрутка страницы карточку не двигает: страница под ней заперта.
  await page.evaluate(() => window.scrollBy(0, 300));
  expect(Math.abs((await dialog.boundingBox()).y)).toBeLessThan(2);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  // Каретка в заметке — и вставка из буфера попадает именно туда.
  const editor = page.locator("#card-body-editor");
  await editor.click();
  await expect(editor).toBeFocused();
  const box = await editor.boundingBox();
  expect(box.y).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(844);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "SIP/RTP → ASR → LLM");
    document
      .querySelector("#card-body-editor")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor).toContainText("SIP/RTP → ASR → LLM");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Карточка закрыта — страница снова прокручивается.
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("a cross next to the day resets it at once: a dated task becomes undated", async ({ page, request }) => {
  const raw = "Дело с датой для сброса";
  await request.post("/api/captures", { data: { raw, primaryType: "todo", due: { date: "2026-09-04", time: "11:00" } } });
  await page.goto("/");
  await openCard(page, "#todo", raw);
  await expect(page.locator("#review-date")).toHaveValue("2026-09-04");
  const clear = page.locator("#review-dialog .side-clear");
  await expect(clear).toBeVisible();
  const saved = page.waitForResponse((response) => response.url().includes("/corrections") && response.request().method() === "POST");
  await clear.click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("#review-date")).toHaveValue("");
  await expect(page.locator("#review-time")).toHaveValue("");
  await expect(clear).toBeHidden();
  await page.keyboard.press("Escape");
  // На сервере срока больше нет: на доске дело лежит без даты.
  await expect.poll(async () => {
    const board = await (await request.get("/api/board")).json();
    const card = JSON.stringify(board).match(new RegExp(`"title":"${raw}"[^}]*`));
    return card ? /"due":null/.test(card[0]) : null;
  }).toBe(true);
});

// Г «Отметил — следующее»: кружок у названия закрывает дело сразу, а карточка,
// открытая из «Дня», идёт к следующему открытому делу. Плашка «Готово ·
// Вернуть» даёт передумать.
test("кружок в карточке закрывает дело и ведёт к следующему делу «Сегодня»", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  for (const raw of ["Разбор: третье дело", "Разбор: второе дело", "Разбор: первое дело"])
    await request.post("/api/captures", { data: { raw, primaryType: "todo", due: { date: today } } });
  await page.goto("/");
  const shelf = page.locator("#todo .day-rows .entry");
  await expect(shelf).toHaveCount(3, { timeout: 15000 });
  const titles = await shelf.locator(".entry-title").allInnerTexts();
  await shelf.first().locator(".entry-title").click();

  const dialog = page.locator("#review-dialog");
  const title = dialog.locator(".card-title");
  await expect(title).toHaveText(titles[0]);
  await expect(dialog.locator(".card-nav-col")).toHaveText("Дела");
  await expect(dialog.locator(".card-nav-rest")).toHaveText("Сегодня · 1 из 3");
  // Отметили — дело закрыто сразу, строка «Сделано» видна до перехода.
  await dialog.locator(".card-tick").click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Сделано сегодня в");
  await expect(title).toHaveText(titles[1], { timeout: 5000 });
  await expect(dialog.locator(".card-nav-rest")).toHaveText("Сегодня · 2 из 3");
  const snack = dialog.locator(".card-snack");
  await expect(snack).toContainText(`Готово: «${titles[0].slice(0, 20)}`);

  // Клавиша E — тот же кружок; K — назад к закрытому, J — вперёд. Новое дело
  // первые 350 мс нажатий не принимает — двойной клик не закроет его заодно.
  await page.waitForTimeout(400);
  await dialog.focus();
  await page.keyboard.press("e");
  await expect(title).toHaveText(titles[2], { timeout: 5000 });
  await page.keyboard.press("k");
  await expect(title).toHaveText(titles[1]);
  await expect(dialog.locator(".card-title.is-done")).toBeVisible();
  // «Вернуть» в строке «Сделано» открывает дело снова.
  await dialog.locator(".card-done-link", { hasText: "Вернуть" }).click();
  await expect(dialog.locator(".card-tick")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("j");
  await expect(title).toHaveText(titles[2]);
  await dialog.locator(".card-tick").click();
  // Дальше открыто только второе, вернувшееся в работу.
  await expect(title).toHaveText(titles[1], { timeout: 5000 });
  await page.waitForTimeout(400);
  await dialog.locator(".card-tick").click();
  await expect(dialog.locator(".card-finish-title")).toHaveText("На «Сегодня» всё отмечено", { timeout: 5000 });
  await dialog.locator(".card-finish-close").click();

  await expect(page.locator("#todo .day-rows .entry")).toHaveCount(0);
  // Закрытое кружком лежит в «Что делал».
  await expect(page.locator("#journal")).toContainText(titles[0]);
});

// Открытая не из списка карточка никуда не уходит: отметка остаётся на месте,
// а «Сделано» у дела — кружок, не строка свойств.
test("карточка по ссылке остаётся на месте после отметки, «Вернуть» открывает дело снова", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const created = await (await request.post("/api/captures", { data: { raw: "Проверить доступ голосового агента", primaryType: "todo" } })).json();
  await page.goto(`/#today?open=${created.entry.id}`);
  const dialog = page.locator("#review-dialog");
  await expect(dialog.locator(".card-title")).toHaveText("Проверить доступ голосового агента");
  // Не из списка: листать нечего, но колонка над названием видна.
  await expect(dialog.locator(".card-nav-step")).toHaveCount(0);
  await expect(dialog.locator(".card-nav-col")).toHaveText("Дела");
  await dialog.locator(".card-tick").click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Сделано");
  await page.waitForTimeout(1200);
  await expect(dialog.locator(".card-title")).toHaveText("Проверить доступ голосового агента");
  await expect(dialog.locator(".card-tick")).toHaveAttribute("aria-pressed", "true");
  const stored = await (await request.get(`/api/captures/${created.entry.id}`)).json();
  expect(stored.entry.interpretation.classification.primaryType).toBe("task");
  expect(stored.entry.projections.find((projection) => projection.type === "task").completion.completed).toBe(true);
  await dialog.locator(".card-done-link", { hasText: "Вернуть" }).click();
  await expect(dialog.locator(".card-tick")).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator(".card-done")).toHaveCount(0);
});
