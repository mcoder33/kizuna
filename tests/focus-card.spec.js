// Карточка «Фокус», вариант 01: дуга прогресса вокруг кружка, подзадачи
// списком и картой, вложенные карточки в той же карточке, панель «Параметры»,
// пристёгнутая справа.
import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
async function deed(request, raw, extra = {}) {
  return (await (await request.post("/api/captures", { data: { raw, primaryType: "todo", ...extra } })).json()).entry;
}
async function sub(request, parentId, title) {
  return (await (await request.post(`/api/captures/${parentId}/subtasks`, { data: { title } })).json()).entry;
}
// Дата «через N дней» по поясу приложения: срок не привязан к дню, когда писали тест.
const inDays = (shift) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + shift * 86400000));
async function openById(page, id) {
  await page.goto(`/#today?open=${id}`);
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog .card-title")).not.toBeEmpty();
}

test("короткая завершённая подзадача остаётся компактной, с заметкой и собранным подвалом", async ({ page, request }) => {
  await reset(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const parent = await deed(request, "Отправить смету по Хабу и напомнить про доступы");
  const child = await sub(request, parent.id, "Отправить Ане смету по Хабу");
  await request.post(`/api/captures/${child.id}/notes`, { data: { body: "Смета для нового стенда." } });
  for (const projection of child.projections.filter((item) => item.type === "task"))
    await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
  await openById(page, child.id);
  const card = page.locator("#review-dialog");
  await expect(card.locator(".card-title.is-done")).toBeVisible();
  await expect(card.locator(".card-done-ok")).toContainText("Сделано");
  await expect(card.locator(".card-body .prop-section")).toHaveText("Заметка");
  await expect(card.locator(".subtask-add")).toBeVisible();
  await expect(card.locator(".card-chips .entry-status")).toHaveCount(0);
  const dialog = await card.boundingBox();
  const top = await card.locator(".card-top").boundingBox();
  const head = await card.locator(".card-head").boundingBox();
  const note = await card.locator(".card-body").boundingBox();
  const subtasks = await card.locator(".card-subtasks").boundingBox();
  const footer = await card.locator(".card-footer-row").boundingBox();
  // Высоту по центру задаёт содержимое: короткая карточка заметно ниже потолка
  // окна (экран 900 → 820) и не растягивается до него.
  expect(Math.round(dialog.height)).toBeLessThan(720);
  expect(head.y - top.y - top.height).toBeLessThan(45);
  expect(subtasks.y - note.y - note.height).toBeLessThan(32);
  expect(footer.y + footer.height).toBeLessThan(dialog.y + dialog.height - 55);
  const source = await card.locator(".card-source summary").boundingBox();
  const remove = await card.locator(".card-delete").boundingBox();
  expect(Math.abs(source.y - remove.y)).toBeLessThan(8);
});

test("дуга вокруг кружка считает конечные шаги, подпись ведёт к карте, список и карта — одни данные", async ({ page, request }) => {
  await reset(request);
  const coffee = await deed(request, "Купить кофе");
  const stock = await sub(request, coffee.id, "Проверить, сколько кофе осталось");
  const kitchen = await sub(request, stock.id, "Проверить запас в кухонном шкафу");
  await sub(request, kitchen.id, "Открыть банку и проверить зёрна");
  await sub(request, kitchen.id, "Посмотреть дату обжарки");
  await sub(request, stock.id, "Прикинуть, на сколько дней хватит");
  await sub(request, coffee.id, "Взять с собой банку для зёрен");

  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  const halo = dialog.locator(".completion-halo");
  await expect(halo).toHaveClass(/has-progress/);
  // Кружок в центре — своё дело, дуга снаружи — четыре конечных шага.
  await expect(dialog.locator(".completion-halo .card-tick")).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator(".progress-caption")).toHaveText("0 из 4 шагов · посмотреть карту ↘");
  await expect(dialog.locator(".halo-fill")).toHaveCSS("stroke-dashoffset", "100px");
  await expect(dialog.locator(".subtask-count")).toHaveText("0 / 4");
  // Список — прямые дети, ветка показывает свой счёт.
  const rows = dialog.locator("#card-subtask-list .subtask");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".subtask-meta")).toHaveText("0 / 3");
  await expect(dialog.locator("#card-subtask-map")).toBeHidden();
  await expect(dialog.locator(".next-step-link")).toHaveText("Открыть банку и проверить зёрна ↗");

  // Отметка листа в списке: «Взять с собой банку» — 1 из 4.
  await rows.nth(1).locator(".subtask-check").check();
  await expect(dialog.locator(".progress-caption")).toHaveText("1 из 4 шагов · посмотреть карту ↘");
  await expect(dialog.locator(".halo-fill")).toHaveCSS("stroke-dashoffset", "75px");
  // Родитель от этого не закрылся, и карточка осталась на месте.
  await expect(dialog.locator(".completion-halo .card-tick")).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator(".card-title")).toHaveText("Купить кофе");

  // Подпись под названием открывает карту: всё дерево, ветки раскрыты.
  await dialog.locator(".progress-caption").click();
  await expect(dialog.locator('.steps-view [data-step-view="map"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator("#card-subtask-list")).toBeHidden();
  const treeRows = dialog.locator("#card-subtask-map .tree-row");
  await expect(treeRows).toHaveCount(6);
  await expect(treeRows.nth(0).locator(".branch-dial")).toHaveAttribute("aria-label", "0 из 3 шагов");
  await expect(treeRows.nth(5).locator(".tree-check")).toBeChecked();
  // Лист отмечается и в карте, ветка пересчитывается.
  await treeRows.nth(2).locator(".tree-check").check();
  await expect(dialog.locator("#card-subtask-map .tree-row").nth(0).locator(".branch-dial")).toHaveAttribute("aria-label", "1 из 3 шагов");
  await expect(dialog.locator(".progress-caption")).toHaveText("2 из 4 шагов · посмотреть карту ↘");
  await expect(dialog.locator(".next-step-link")).toHaveText("Посмотреть дату обжарки ↗");
  // Ветка сворачивается.
  await dialog.locator("#card-subtask-map .tree-row").nth(1).locator(".tree-fold").click();
  await expect(dialog.locator("#card-subtask-map .tree-row")).toHaveCount(4);
  // Обратно к списку — те же данные.
  await dialog.locator('.steps-view [data-step-view="list"]').click();
  await expect(dialog.locator("#card-subtask-list .subtask").first().locator(".subtask-meta")).toHaveText("1 / 3");

  // Кружок в центре закрывает само дело, шаги не трогает.
  await dialog.locator(".completion-halo .card-tick").click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Сделано");
  await expect(dialog.locator(".progress-caption")).toHaveText("2 из 4 шагов · посмотреть карту ↘");
  const stored = await (await request.get(`/api/captures/${coffee.id}/subtasks`)).json();
  expect(stored.done).toBe(2);
  expect(stored.total).toBe(4);
});

test("подзадача открывается той же карточкой: правка сохраняется, «назад» возвращает к родителю", async ({ page, request }) => {
  await reset(request);
  const coffee = await deed(request, "Купить кофе");
  const stock = await sub(request, coffee.id, "Проверить, сколько кофе осталось");
  const kitchen = await sub(request, stock.id, "Проверить запас в кухонном шкафу");
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  await expect(dialog.locator("#review-crumb")).toContainText("Сегодня");

  // Правка заметки родителя уходит на сервер до перехода — медленный ответ
  // не теряет текст.
  await page.route("**/api/captures/*/notes", async (route) => { await new Promise((done) => setTimeout(done, 400)); await route.continue(); });
  await dialog.locator("#card-body-editor").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" — зерно 250 г");
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-title")).toHaveText("Проверить, сколько кофе осталось");
  await expect(dialog.locator(".card-return")).toContainText("Купить кофе");
  await expect(dialog.locator(".card-depth")).toHaveText("Уровень 2");
  await expect(dialog.locator(".card-nav")).toHaveCount(0);
  await expect(dialog.locator(".card-path")).toHaveCount(0);

  // Глубже: третий уровень показывает путь, крестик ведёт назад.
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-title")).toHaveText("Проверить запас в кухонном шкафу");
  await expect(dialog.locator(".card-depth")).toHaveText("Уровень 3");
  await expect(dialog.locator(".card-path .card-path-step")).toHaveText(["Купить кофе", "Проверить, сколько кофе осталось"]);
  // Новая подзадача на глубине — настоящая запись; кружок у неё отмечает её.
  await dialog.locator(".subtask-add").click();
  await dialog.locator(".subtask-composer input").fill("Открыть банку");
  await page.keyboard.press("Enter");
  await expect(dialog.locator("#card-subtask-list .subtask-name")).toHaveText(["Открыть банку"]);
  await expect(dialog.locator(".progress-caption")).toHaveText("0 из 1 шага · посмотреть карту ↘");
  const deep = await (await request.get(`/api/captures/${kitchen.id}/subtasks`)).json();
  expect(deep.nodes.map((node) => node.title)).toEqual(["Открыть банку"]);
  await page.keyboard.press("Escape");
  await expect(dialog.locator(".subtask-composer")).toBeHidden();
  await expect(dialog).toBeVisible();

  await dialog.locator("#review-close").click();
  await expect(dialog.locator(".card-title")).toHaveText("Проверить, сколько кофе осталось");
  // Ступень пути ведёт сразу к корню.
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await dialog.locator(".card-path-step").first().click();
  await expect(dialog.locator(".card-title")).toHaveText("Купить кофе");
  await expect(dialog.locator("#card-body-editor")).toContainText("зерно 250 г");
  await expect(dialog.locator(".card-return")).toHaveCount(0);
  // Единственный лист цепочки — «Открыть банку» на четвёртом уровне.
  await expect(dialog.locator(".progress-caption")).toHaveText("0 из 1 шага · посмотреть карту ↘");
  // Esc у корня закрывает карточку.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const saved = await (await request.get(`/api/captures/${coffee.id}`)).json();
  expect(saved.entry.note.body).toContain("зерно 250 г");
  expect(stock.id).toBeTruthy();
});

test("«Параметры» выезжают из той же карточки: колонка не сжимается, карточка встаёт по центру, Esc закрывает панель первой", async ({ page, request }) => {
  await reset(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const coffee = await deed(request, "Купить кофе");
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  const toggle = dialog.locator("#review-params-toggle");
  await expect(toggle).toHaveText("Параметры");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const before = await dialog.boundingBox();
  const mainBefore = await dialog.locator(".card-main").boundingBox();
  const centre = before.x + before.width / 2;

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator("#review-props")).toBeVisible();
  await page.waitForTimeout(400);
  const after = await dialog.boundingBox();
  const main = await dialog.locator(".card-main").boundingBox();
  const panel = await dialog.locator("#review-params").boundingBox();
  expect(Math.round(main.width)).toBe(Math.round(mainBefore.width));
  expect(Math.round(after.width)).toBe(Math.round(mainBefore.width + panel.width));
  // Панель пристёгнута к колонке без зазора, внутри той же карточки.
  expect(Math.round(panel.x)).toBe(Math.round(main.x + main.width));
  expect(panel.x + panel.width).toBeLessThanOrEqual(after.x + after.width + 1);
  // Карточка целиком снова по центру: сдвинулась влево.
  expect(Math.abs(after.x + after.width / 2 - centre)).toBeLessThan(2);
  expect(after.x).toBeLessThan(before.x);
  // Поля панели живые: дата ставится, чип под названием меняется сразу.
  const later = inDays(10);
  await dialog.locator("#review-date").fill(later);
  await expect(dialog.locator(".card-chips .chip").first()).toContainText(`${later.slice(8, 10)}.${later.slice(5, 7)}`);
  // Esc закрывает панель, карточка остаётся; второй Esc закрывает карточку.
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350);
  const closed = await dialog.boundingBox();
  expect(Math.round(closed.width)).toBe(Math.round(before.width));
  // Та же кнопка и крестик панели тоже закрывают.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await dialog.locator(".card-chips .chip").first().click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator("#review-date")).toBeFocused();
  await dialog.locator("#review-params-close").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Дата ушла уточнением при закрытии.
  await expect.poll(async () => (await (await request.get(`/api/captures/${coffee.id}`)).json()).entry.interpretation.classification.entities.schedule?.date).toBe(later);
});

test("панель открыта у родителя — открыта и у подзадачи, а её ширина не меняет колонку", async ({ page, request }) => {
  await reset(request);
  const coffee = await deed(request, "Купить кофе");
  await sub(request, coffee.id, "Проверить запас");
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  await dialog.locator("#review-params-toggle").click();
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-title")).toHaveText("Проверить запас");
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator("#review-props")).toBeVisible();
  await dialog.locator("#review-project").fill("Дом");
  await dialog.locator(".card-return").click();
  await expect(dialog.locator(".card-title")).toHaveText("Купить кофе");
  await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "true");
  const child = (await (await request.get(`/api/captures/${coffee.id}/subtasks`)).json()).nodes[0];
  await expect.poll(async () => (await (await request.get(`/api/captures/${child.id}`)).json()).entry.interpretation.classification.entities.projects).toEqual(["Дом"]);
});

for (const width of [390, 320]) {
  test(`на телефоне ${width} панель достижима без сжатия колонки и без прокрутки страницы`, async ({ page, request }) => {
    await reset(request);
    await page.setViewportSize({ width, height: 760 });
    const coffee = await deed(request, "Купить кофе");
    await sub(request, coffee.id, "Проверить запас");
    await openById(page, coffee.id);
    const dialog = page.locator("#review-dialog");
    await expect(dialog.locator("#review-params-toggle")).toBeVisible();
    await expect(dialog.locator("#review-close")).toBeVisible();
    await expect(dialog.locator(".completion-halo")).toHaveClass(/has-progress/);
    const main = await dialog.locator(".card-main").boundingBox();
    expect(Math.round(main.width)).toBe(width);
    await dialog.locator("#review-params-toggle").click();
    // Дорожка карточки доезжает до панели; страница под ней не растёт.
    await expect.poll(async () => { const panel = await dialog.locator("#review-params").boundingBox(); return Math.round(panel.x + panel.width); }).toBeLessThanOrEqual(width + 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    const dialogBox = await dialog.boundingBox();
    expect(Math.round(dialogBox.width)).toBe(width);
    expect(Math.round((await dialog.locator(".card-main").boundingBox()).width)).toBe(width);
    const panel = await dialog.locator("#review-params").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(-1);
    await expect(dialog.locator("#review-column")).toBeVisible();
    await dialog.locator("#review-params-close").click();
    await expect.poll(async () => Math.round((await dialog.locator(".card-main").boundingBox()).x)).toBe(0);
    await expect(dialog.locator(".card-title")).toBeVisible();
  });
}

test("при отключённой анимации панель встаёт мгновенно", async ({ page, request }) => {
  await reset(request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const coffee = await deed(request, "Купить кофе");
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  await expect(dialog).toHaveCSS("transition-duration", "0s");
  await expect(dialog.locator("#review-params")).toHaveCSS("transition-duration", "0s");
  await dialog.locator("#review-params-toggle").click();
  const panel = await dialog.locator("#review-params").boundingBox();
  expect(Math.round(panel.width)).toBe(340);
  await expect(dialog.locator("#review-props")).toBeVisible();
});

test("повторяющийся шаг в списке закрывается на день, серия живёт дальше", async ({ page, request }) => {
  await reset(request);
  const today = (await (await request.get("/api/day")).json()).date;
  const coffee = await deed(request, "Купить кофе");
  const water = await sub(request, coffee.id, "Поменять воду в фильтре");
  await request.post(`/api/captures/${water.id}/corrections`, { data: { patch: { schedule: { date: today, time: null, repeat: { freq: "daily", interval: 1 } } } } });
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  await dialog.locator("#card-subtask-list .subtask-check").first().check();
  await expect(dialog.locator(".progress-caption")).toHaveText("1 из 1 шага · посмотреть карту ↘");
  await expect.poll(async () => (await (await request.get(`/api/captures/${water.id}`)).json()).entry.interpretation.classification.entities.schedule.skip).toEqual([today]);
  const stored = (await (await request.get(`/api/captures/${water.id}`)).json()).entry;
  expect(stored.projections[0].completion.completed).toBe(false);
  // Карточка самого шага говорит то же: готово на сегодня.
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Готово на сегодня");
  await dialog.locator(".card-done-link", { hasText: "Вернуть" }).click();
  await expect(dialog.locator(".card-done")).toHaveCount(0);
  await dialog.locator(".card-return").click();
  await expect(dialog.locator(".progress-caption")).toHaveText("0 из 1 шага · посмотреть карту ↘");
});

test("еженедельный шаг: дерево и карточка шага говорят об одном дне серии", async ({ page, request }) => {
  await reset(request);
  const today = (await (await request.get("/api/day")).json()).date;
  const shift = (day, days) => { const at = new Date(`${day}T12:00:00Z`); at.setUTCDate(at.getUTCDate() + days); return at.toISOString().slice(0, 10); };
  const tomorrow = shift(today, 1);
  const coffee = await deed(request, "Купить кофе");
  const water = await sub(request, coffee.id, "Поменять воду в фильтре");
  await request.post(`/api/captures/${water.id}/corrections`, { data: { patch: { schedule: { date: tomorrow, time: null, repeat: { freq: "weekly", interval: 1 } } }, at: Date.now() } });
  const scheduled = (await (await request.get(`/api/captures/${water.id}`)).json()).entry;
  await request.post(`/api/projections/${scheduled.projections[0].id}/complete`, { data: { occurrence: tomorrow } });
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  const check = dialog.locator("#card-subtask-list .subtask-check").first();
  await expect(check).toBeChecked();
  // Карточка шага открыта на тот же день: «Готово на …», не «в работе».
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-done-ok")).toContainText("Готово на");
  await dialog.locator(".card-return").click();
  // Снять отметку в дереве — вернуть именно этот день в серию.
  await dialog.locator("#card-subtask-list .subtask-check").first().uncheck();
  await expect.poll(async () => (await (await request.get(`/api/captures/${water.id}`)).json()).entry.interpretation.classification.entities.schedule.skip || []).toEqual([]);
  await expect(dialog.locator("#card-subtask-list .subtask-check").first()).not.toBeChecked();
  const stored = (await (await request.get(`/api/captures/${water.id}`)).json()).entry;
  expect(stored.projections[0].completion.completed).toBe(false);
  expect(stored.interpretation.classification.entities.schedule.repeat.freq).toBe("weekly");
});

test("у дела без шагов дуги и подписи нет", async ({ page, request }) => {
  await reset(request);
  const coffee = await deed(request, "Купить кофе");
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  await expect(dialog.locator("#card-subtasks")).toBeVisible();
  await expect(dialog.locator(".completion-halo")).not.toHaveClass(/has-progress/);
  await expect(dialog.locator(".progress-caption")).toBeHidden();
  await expect(dialog.locator(".subtask-empty")).toHaveText("Разбейте задачу на небольшие шаги");
  await expect(dialog.locator(".steps-view")).toBeHidden();
});

test("медленное сохранение заголовка не возвращает родителя поверх открытой подзадачи и не открывает закрытую карточку", async ({ page, request }) => {
  await reset(request);
  const coffee = await deed(request, "Купить кофе");
  await sub(request, coffee.id, "Проверить, сколько кофе осталось");
  await openById(page, coffee.id);
  const dialog = page.locator("#review-dialog");
  await page.route("**/api/captures/*/corrections", async (route) => { await new Promise((done) => setTimeout(done, 650)); await route.continue(); });

  // Переименовали и сразу ушли в подзадачу: ответ приходит позже перехода.
  await dialog.locator(".card-title").click();
  await dialog.locator(".card-title-edit").fill("Купить кофе — новый заголовок");
  await dialog.locator("#card-subtask-list .subtask-open").first().click();
  await expect(dialog.locator(".card-title")).toHaveText("Проверить, сколько кофе осталось");
  await page.waitForTimeout(1200);
  await expect(dialog.locator(".card-title")).toHaveText("Проверить, сколько кофе осталось");
  await expect(dialog.locator(".card-depth")).toHaveText("Уровень 2");
  // Назад — родитель уже с новым названием, и оно сохранено.
  await dialog.locator(".card-return").click();
  await expect(dialog.locator(".card-title")).toHaveText("Купить кофе — новый заголовок");
  expect((await (await request.get(`/api/captures/${coffee.id}`)).json()).entry.interpretation.classification.summary).toBe("Купить кофе — новый заголовок");

  // Переименовали и закрыли крестиком: ответ не открывает карточку заново.
  await dialog.locator(".card-title").click();
  await dialog.locator(".card-title-edit").fill("Купить кофе — ещё раз");
  await dialog.locator("#review-close").click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(1200);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await (await request.get(`/api/captures/${coffee.id}`)).json()).entry.interpretation.classification.summary).toBe("Купить кофе — ещё раз");
});

test("пустая заметка не оставляет провал перед подзадачами", async ({ page, request }) => {
  await reset(request);
  await page.setViewportSize({ width: 390, height: 844 });
  const coffee = await deed(request, "Купить кофе");
  await sub(request, coffee.id, "Проверить запас");
  await openById(page, coffee.id);
  const editor = page.locator("#review-dialog #card-body-editor");
  await expect(editor).toHaveCSS("min-height", "36px");
  const box = await editor.boundingBox();
  expect(box.height).toBeLessThan(160);
});

test("панель «Параметры» — ровный инспектор: поля по одной сетке, начало и конец равными колонками, без обрезки", async ({ page, request }) => {
  await reset(request);
  const today = (await (await request.get("/api/day")).json()).date;
  const coffee = await deed(request, "Купить кофе", { due: { date: today, time: "10:00" } });
  const geometry = () => page.evaluate(() => {
    const fields = [...document.querySelectorAll("#review-params .props select, #review-params .props input:not([hidden])")].map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, x: Math.round(r.x), width: Math.round(r.width), right: Math.round(r.right) }; });
    const labels = [...document.querySelectorAll("#review-params .prop-label")].map((el) => Math.round(el.getBoundingClientRect().x));
    const body = document.querySelector("#review-params-body");
    return { fields, labels, overflow: body.scrollWidth > body.clientWidth || document.documentElement.scrollWidth > window.innerWidth };
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await openById(page, coffee.id);
    const dialog = page.locator("#review-dialog");
    await dialog.locator("#review-params-toggle").click();
    await expect(dialog.locator("#review-props")).toBeVisible();
    await dialog.locator("#review-repeat").selectOption("weekly:1");
    await expect(dialog.locator("#review-repeat-until")).toBeVisible();
    // Панель доехала до своей ширины — мерить можно.
    await expect.poll(async () => Math.round((await dialog.locator("#review-params").boundingBox()).width)).toBe(width <= 760 ? width : 340);
    const { fields, labels, overflow } = await geometry();
    expect(overflow).toBe(false);
    // Повторяющегося названия задачи в шапке панели нет.
    expect(await dialog.locator("#review-params-name").count()).toBe(0);
    const left = fields[0].x, right = fields[0].right;
    const time = fields.find((field) => field.id === "review-time"), end = fields.find((field) => field.id === "review-end");
    for (const field of fields) {
      // Все поля стоят по одному левому и правому краю; исключение — пара
      // «начало / до», делящая строку пополам.
      if (field.id !== "review-time") expect(field.right).toBe(right);
      if (field.id !== "review-end") expect(field.x).toBe(left);
    }
    for (const x of labels) expect(x).toBe(left);
    expect(Math.abs(time.width - end.width)).toBeLessThanOrEqual(1);
    expect(end.x).toBeGreaterThan(time.right);
    // Поля живые: срок, время, напоминание — и чипы под названием идут следом.
    await dialog.locator("#review-time").fill("11:30");
    await dialog.locator("#review-end").fill("12:00");
    await dialog.locator("#review-remind").selectOption("15");
    await expect(dialog.locator(".card-chips .chip").first()).toContainText("11:30–12:00");
    await expect(dialog.locator(".card-chips .chip").nth(1)).toContainText("за 15 минут");
    await dialog.locator("#review-params-close").click();
    await expect(dialog.locator("#review-params-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await (await request.get(`/api/captures/${coffee.id}`)).json()).entry.interpretation.classification.entities.schedule?.repeat?.freq).toBe("weekly");
  }
});
