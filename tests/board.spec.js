import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
// Дни считаются в часовом поясе приложения, а не в UTC.
const day = (shift) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + shift * 86400000));
// Дело с названным сроком и людьми; возвращает id записи.
const deed = async (request, raw, { due = null, people = null } = {}) => {
  const created = await (await request.post("/api/captures", { data: { raw, ...(due ? { due: { date: due } } : {}) } })).json();
  if (people) await request.post(`/api/captures/${created.entry.id}/corrections`, { data: { patch: { people } } });
  return created.entry.id;
};
const dueOf = async (request, id) => (await (await request.get(`/api/captures/${id}`)).json()).entry.interpretation.classification.entities.schedule?.date ?? null;
// Доска перерисовывается по ответу сервера: при открытии страницы, после отметки,
// переноса, срока. Пока перерисовка не легла, фокус и перетаскивание сбиваются,
// поэтому перед следующим действием ждём, когда доска затихнет.
const settled = (page, quiet = 400) =>
  page.evaluate((ms) => new Promise((resolve) => {
    let timer = 0;
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ms); });
    const done = () => { observer.disconnect(); resolve(); };
    observer.observe(document.querySelector("#board"), { childList: true, subtree: true });
    timer = setTimeout(done, ms);
  }), quiet);
// Вид и группировка помнятся в браузере: тест ставит их и перечитывает страницу.
const arrange = async (page, view, groups) => {
  await page.evaluate(([v, g]) => { localStorage.setItem("kizuna-board-view", v); localStorage.setItem("kizuna-board-groups", JSON.stringify(g)); }, [view, groups]);
  await page.reload();
  await page.locator("#board-columns > :not(.empty), #board-flat > :not(.empty)").first().waitFor({ state: "attached" });
  await settled(page);
};
const groupsOf = (page) => page.locator("#board-grp select").evaluateAll((selects) => selects.map((select) => select.value));
const columnByName = (page, name) =>
  page.locator(".board-column:not(.ghost)").filter({ has: page.locator(".board-col-name", { hasText: new RegExp(`^${name}$`) }) });
const addColumn = async (page, name) => {
  await page.locator(".board-column.ghost .board-add-button").click();
  await page.locator(".board-column.ghost input").fill(name);
  await page.keyboard.press("Enter");
  await expect(columnByName(page, name)).toBeVisible();
};

// Фильтр и порядок колонок помнятся в браузере. Прогон стартует с пустого фильтра
// (tests/fixtures/e2e-auth.setup.js): в первый заход доска показывала бы только
// «сегодня». Проверки умолчания сами убирают ключ.
const stored = (page, key) => page.evaluate((name) => localStorage.getItem(name), key);
const filterToggle = (page) => page.locator("#board-filter-toggle");
const openFilter = async (page) => { if ((await filterToggle(page).getAttribute("aria-expanded")) !== "true") await filterToggle(page).click(); };
// Условие набирается руками, как это делает человек: «+ условие», поле, оператор, значение.
const addCondition = async (page, field, value, op = "=") => {
  await openFilter(page);
  await page.locator("#board-filter .board-cond-add").click();
  const draft = page.locator("#board-filter .board-cond:has(select.is-empty)");
  await draft.locator('[data-part="field"]').selectOption(field);
  if (op !== "=") await draft.locator('[data-part="op"]').selectOption(op);
  await draft.locator('[data-part="value"]').selectOption(value);
};
// Как плашки читаются глазами: «День = сегодня».
const conditionsOf = (page) => page.locator("#board-filter .board-cond").evaluateAll((chips) => chips.map((chip) => [...chip.querySelectorAll("select")].map((select) => select.selectedOptions[0].textContent).join(" ")));
const closeDeed = async (request, id) => {
  const entry = (await (await request.get(`/api/captures/${id}`)).json()).entry;
  for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
};
const openTitles = (page) => page.locator("#board-columns .board-column:not(.board-done-column) .board-card .board-title").allTextContents();
const doneTitles = (page) => page.locator("#board-columns .board-done-column .board-card .board-title").allTextContents();
const idByRaw = async (request, raw) => (await (await request.get("/api/entries?limit=50")).json()).entries.find((entry) => entry.raw === raw)?.id;

test("доска: «Сделано» — обычная колонка, своя колонка, быстрое дело, карточка и кружок", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");

  // Свойств нет; над доской — вид, группировка и «Фильтр», по умолчанию «Доска» по
  // колонкам. «Сделано» — обычная колонка и по умолчанию первая, за ней «Дела»
  // (заводится сервером сама) и призрачная «+ Колонка».
  await expect(page.locator("#board-props-toggle")).toHaveCount(0);
  await expect(page.locator("#board-filter-toggle")).toHaveText("Фильтр");
  await expect(page.locator("#board-view button")).toHaveText(["Доска", "Список", "Таблица"]);
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Доска");
  expect(await groupsOf(page)).toEqual(["col"]);
  await expect(page.locator(".board-column:not(.ghost) .board-col-name")).toHaveText(["Сделано", "Дела"]);
  await expect(page.locator(".board-column.inbox")).toHaveCount(0);
  await expect(page.locator(".board-column.ghost")).toBeVisible();
  await expect(page.locator(".board-column.board-done-column .board-col-name")).toHaveAttribute("href", "#done");
  // «Сделано» такая же колонка: заголовок тянется, а стоит она в потоке, а не прибита
  // к краю. Меню у неё нет — переименовывать и удалять нечего.
  await expect(page.locator(".board-done-column .board-col-head")).toHaveAttribute("draggable", "true");
  await expect(page.locator(".board-done-column .board-menu")).toHaveCount(0);
  await expect(page.locator(".board-done-column")).toHaveCSS("position", "static");
  // У обычной колонки заголовок тянется, а меню — только «Переименовать» и «Удалить колонку».
  const first = columnByName(page, "Дела");
  await expect(first.locator(".board-col-head")).toHaveAttribute("draggable", "true");
  await first.locator(".board-menu summary").click();
  await expect(first.locator(".board-menu-popover button")).toHaveText(["Переименовать", "Удалить колонку"]);
  await expect(page.locator(".board-swatch")).toHaveCount(0);
  await first.locator(".board-menu summary").click();

  // Новая колонка заводится на месте.
  await addColumn(page, "В работе");
  const column = columnByName(page, "В работе");

  // Быстрое дело прямо в колонке: Enter сохраняет, поле остаётся для следующего.
  await column.locator(".board-add-button").click();
  await column.locator(".board-add input").fill("Проверить доску целиком");
  await page.keyboard.press("Enter");
  const card = column.locator(".board-card").filter({ hasText: "Проверить доску" });
  await expect(card).toBeVisible();
  await expect(column.locator(".board-add input")).toBeFocused();
  // Ни статуса, ни типа, ни проекта: кружок, название, мелкая строка под ним.
  await expect(card.locator(".entry-status, .btag.kind, .btag.project")).toHaveCount(0);

  // Название открывает карточку; правка заголовка видна на доске сразу.
  await card.locator(".board-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-dialog .card-title").click();
  await page.locator(".card-title-edit").fill("Проверить доску целиком и карточку");
  await page.keyboard.press("Enter");
  await expect(card.locator(".board-title")).toHaveText("Проверить доску целиком и карточку");
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await page.locator("#review-project").fill("Доска-проект");
  // Первый Esc закрывает панель «Параметры», второй — карточку.
  await page.keyboard.press("Escape");
  await expect(propsBar).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(card.locator(".board-title")).toHaveText("Проверить доску целиком и карточку");

  // Кружок отправляет дело в «Сделано»: оно там зачёркнуто, подпись — «сегодня 10:12».
  await card.locator(".board-done").click();
  await expect(column.locator(".board-card")).toHaveCount(0);
  const done = page.locator(".board-done-column");
  const closed = done.locator(".board-card.closed").filter({ hasText: "Проверить доску" });
  await expect(closed).toBeVisible();
  await expect(closed.locator(".btag.due")).toContainText(/^сегодня \d\d:\d\d$/);
  await expect(done.locator(".board-col-count")).toHaveText("1");
  // Кружок закрытой возвращает дело в его колонку.
  await closed.locator(".board-done").click();
  await expect(done.locator(".board-card")).toHaveCount(0);
  await expect(column.locator(".board-card").filter({ hasText: "Проверить доску" })).toBeVisible();

  // Заголовок «Сделано» ведёт на страницу «Сделано».
  await done.locator(".board-col-name").click();
  await expect(page).toHaveURL(/#done$/);
  await expect(page.locator("#done h2")).toHaveText("Сделано");

  await reset(request);
});

test("доска: карточку бросают в «Сделано» и между колонками, колонку тянут за заголовок", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Первое дело доски" } });
  await request.post("/api/captures", { data: { raw: "Второе дело доски" } });
  await page.goto("/#board");
  await addColumn(page, "Позже");
  await addColumn(page, "Ожидание");
  const names = () => page.locator(".board-column:not(.ghost) .board-col-name").allTextContents();
  await expect.poll(names).toEqual(["Сделано", "Дела", "Позже", "Ожидание"]);

  // Карточка между колонками: «Второе» уезжает из «Дел» в «Позже».
  const first = columnByName(page, "Дела"), later = columnByName(page, "Позже");
  const second = first.locator(".board-card").filter({ hasText: "Второе дело" });
  await expect(second).toBeVisible();
  await second.locator(".board-title").dragTo(later.locator(".board-cards"));
  await expect(later.locator(".board-card").filter({ hasText: "Второе дело" })).toBeVisible();
  await expect(first.locator(".board-card")).toHaveCount(1);
  await page.reload();
  await expect(columnByName(page, "Позже").locator(".board-card")).toContainText("Второе дело");

  // Колонка тянется за заголовок: «Ожидание» встаёт перед «Дела» (правее «Сделано»,
  // которая пока стоит первой) и после перезагрузки остаётся там.
  await columnByName(page, "Ожидание").locator(".board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Сделано", "Ожидание", "Дела", "Позже"]);
  await page.reload();
  await expect.poll(names).toEqual(["Сделано", "Ожидание", "Дела", "Позже"]);

  // Бросили карточку на «Сделано» — она закрыта и лежит там. Карточка без места
  // лежит в первой колонке, а первой теперь стала «Ожидание».
  const target = columnByName(page, "Ожидание").locator(".board-card").filter({ hasText: "Первое дело" });
  await target.locator(".board-title").dragTo(page.locator(".board-done-column"));
  const closed = page.locator(".board-done-column .board-card.closed");
  await expect(closed).toHaveCount(1);
  await expect(closed).toContainText("Первое дело");
  await expect(columnByName(page, "Ожидание").locator(".board-card")).toHaveCount(0);

  // Удаление колонки переносит её дела в первую оставшуюся колонку.
  const later2 = columnByName(page, "Позже");
  await later2.hover();
  await later2.locator(".board-menu summary").click();
  await later2.getByRole("button", { name: "Удалить колонку" }).click();
  await expect(columnByName(page, "Позже")).toHaveCount(0);
  await expect(columnByName(page, "Ожидание").locator(".board-card").filter({ hasText: "Второе дело" })).toBeVisible();
  await reset(request);
});

// Доска перерисовывается, пока название новой колонки набирают (запись со стороны
// меняет ответ сервера): набранное и фокус остаются в поле.
test("доска: название новой колонки не пропадает, если доску перечитали, пока его набирали", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");
  await page.locator(".board-column.ghost .board-add-button").click();
  await page.locator(".board-column.ghost input").fill("Ждут ответа");
  await request.post("/api/captures", { data: { raw: "Дело, пришедшее, пока набирали название" } });
  await expect(page.locator(".board-card").filter({ hasText: "пока набирали название" })).toBeVisible();
  const input = page.locator(".board-column.ghost input");
  await expect(input).toHaveValue("Ждут ответа");
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(columnByName(page, "Ждут ответа")).toBeVisible();
  // Отправленное поле не возвращается: рядом снова кнопка «+ Колонка».
  await expect(page.locator(".board-column.ghost .board-add-button")).toBeVisible();
  await expect(page.locator(".board-column.ghost input")).toBeHidden();
  await reset(request);
});

// Доска перечитывается по любому поводу; если ответ сервера тот же, перерисовка
// только сбила бы фокус, набранное и перетаскивание — узлы остаются прежними.
test("доска: перечитывание с тем же ответом не перерисовывает её, с другим — перерисовывает", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для проверки перерисовки");
  await page.goto("/#board");
  const card = page.locator(".board-card").filter({ hasText: "для проверки перерисовки" });
  await expect(card).toBeVisible();
  await settled(page);
  // Метка на узле пропадёт, только если карточку пересоздали.
  await card.evaluate((element) => { element.dataset.mark = "kept"; });
  const reads = () => page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith("/api/board")).length);
  const before = await reads();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(reads).toBeGreaterThan(before);
  await settled(page);
  await expect(card).toHaveAttribute("data-mark", "kept");
  // Ответ изменился — доска перерисована, старых узлов нет, новое дело на месте.
  await deed(request, "Второе дело после перерисовки");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".board-card").filter({ hasText: "Второе дело после перерисовки" })).toBeVisible();
  await expect(page.locator(".board-card[data-mark]")).toHaveCount(0);
  await reset(request);
});

test("доска: название колонки правится щелчком, поиск прячет лишнее", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Согласовать смету по CP с Антоном Гришиным" } });
  await request.post("/api/captures", { data: { raw: "Разобрать отчёт по Hub" } });
  await page.goto("/#board");

  // Щелчок по названию превращает его в поле; Enter сохраняет.
  await columnByName(page, "Дела").locator(".board-col-name").click();
  const input = page.locator(".board-col-input");
  await input.fill("Текущие");
  await input.press("Enter");
  await expect(columnByName(page, "Текущие")).toBeVisible();
  await page.reload();
  await expect(columnByName(page, "Текущие").locator(".board-card")).toHaveCount(2);

  // Поиск — по названию, на лету.
  const cards = columnByName(page, "Текущие").locator(".board-card");
  await page.locator("#board-search").fill("смету");
  await expect(cards).toHaveCount(1);
  await page.locator("#board-search").fill("");
  await expect(cards).toHaveCount(2);

  // «+ Дело» вверху открывает поле в первой своей колонке, а не в «Сделано».
  await page.locator("#board-new").click();
  await expect(columnByName(page, "Текущие").locator(".board-add input")).toBeVisible();
  await reset(request);
});

// На телефоне колонки по одной на экран: сверху сегмент подписей, открыта
// первая своя колонка (а не «Сделано»), страница не шире экрана.
test("на телефоне колонки по одной, сегмент показывает «Сделано» и свои", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Проверить доску на телефоне" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#board");
  const card = page.locator("#board-columns .board-card").filter({ hasText: "на телефоне" });
  await expect(card).toBeVisible();
  // Карточка не выше своего содержимого: flex-basis строки заголовка не должен
  // превращаться в высоту.
  await expect.poll(async () => (await card.boundingBox())?.height ?? Infinity).toBeLessThan(120);
  await expect(page.locator("#board-segments .board-segment").first()).toBeVisible();
  await expect(page.locator("#board-segments .board-segment").first()).toContainText("Сделано");
  await expect(page.locator("#board-columns .board-column.is-active")).toHaveCount(1);
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("Дела");
  // Сегмент «Сделано» показывает закрытые; страница не шире экрана.
  await page.locator("#board-segments .board-segment").first().click();
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("Сделано");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await reset(request);
});

test("крестик на карточке доски удаляет дело мягко, «Вернуть» возвращает его", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Дело под удаление с доски" } });
  await page.goto("/#board");
  const card = page.locator(".board-card").filter({ hasText: "Дело под удаление с доски" });
  await expect(card).toBeVisible();
  await card.hover();
  await card.locator(".board-remove").click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("#toast")).toContainText("Дело удалено");
  await page.locator("#toast .toast-action", { hasText: "Вернуть" }).click();
  await expect(page.locator(".board-card").filter({ hasText: "Дело под удаление с доски" })).toBeVisible();
});

// ── вид и группировка ────────────────────────────────────────────────────────

test("вид и группировка помнятся после перезагрузки: уровни добавляются, меняются местами и убираются", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для вида и группировки");
  await page.goto("/#board");
  // По умолчанию — доска и группировка «Колонка»; подсказки с цепочкой нет, пока уровень один.
  expect(await groupsOf(page)).toEqual(["col"]);
  await expect(page.locator("#board-hint")).toHaveText("");
  // «+ ещё» добавляет следующее неиспользованное поле.
  await page.locator('#board-view [data-view="list"]').click();
  await page.locator("#board-grp .board-lv-add").click();
  await page.locator("#board-grp .board-lv-add").click();
  expect(await groupsOf(page)).toEqual(["col", "day", "who"]);
  // Фокус идёт за рукой: после «+ ещё» — в новом уровне, после выбора поля — там же, где выбирали.
  await expect(page.locator("#board-grp select").nth(2)).toBeFocused();
  await expect(page.locator("#board-hint")).toHaveText("Колонка → День → Человек");
  await expect(page.locator("#board-flat .g-list")).toBeVisible();
  await expect(page.locator("#board-columns")).toBeHidden();
  await page.locator("#board-grp select").nth(1).selectOption("src");
  await expect(page.locator("#board-grp select").nth(1)).toBeFocused();
  expect(await page.evaluate(() => [localStorage.getItem("kizuna-board-view"), localStorage.getItem("kizuna-board-groups")])).toEqual(["list", '["col","src","who"]']);

  await page.reload();
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Список");
  expect(await groupsOf(page)).toEqual(["col", "src", "who"]);
  await expect(page.locator("#board-hint")).toHaveText("Колонка → Откуда → Человек");

  // Поле, уже занятое другим уровнем, меняется с ним местами: дважды одно и то же не группируют.
  await page.locator("#board-grp select").nth(2).selectOption("col");
  expect(await groupsOf(page)).toEqual(["who", "src", "col"]);
  // Крестик убирает уровень; без уровней — один поток, и это тоже помнится.
  await page.locator('#board-grp [data-remove="1"]').click();
  expect(await groupsOf(page)).toEqual(["who", "col"]);
  await page.locator('#board-grp [data-remove="0"]').click();
  await page.locator('#board-grp [data-remove="0"]').click();
  await expect(page.locator("#board-grp select")).toHaveCount(0);
  await expect(page.locator(".board-lv-none")).toBeVisible();
  await page.reload();
  await expect(page.locator("#board-grp select")).toHaveCount(0);
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Сделано · 0"]);
  await expect(page.locator("#board-flat .g-row")).toHaveCount(1);

  // Пять полей — предел: «+ ещё» пропадает. «Доска» возвращается тем же щелчком.
  for (let index = 0; index < 5; index++) await page.locator("#board-grp .board-lv-add").click();
  await expect(page.locator("#board-grp select")).toHaveCount(5);
  await expect(page.locator("#board-grp .board-lv-add")).toHaveCount(0);
  await page.locator('#board-view [data-view="board"]').click();
  await page.reload();
  await expect(page.locator("#board-columns")).toBeVisible();
  await expect(page.locator("#board-flat")).toBeHidden();
  expect(await groupsOf(page)).toEqual(["col", "day", "who", "proj", "src"]);

  // Испорченное значение в браузере не ломает доску: вид и группировка по умолчанию.
  await page.evaluate(() => { localStorage.setItem("kizuna-board-view", "cards"); localStorage.setItem("kizuna-board-groups", "{oops"); });
  await page.reload();
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Доска");
  expect(await groupsOf(page)).toEqual(["col"]);
  await reset(request);
});

test("по дню: группы идут по порядку, бросок в другой день меняет срок, в «просрочено» не принимается", async ({ page, request }) => {
  await reset(request);
  const first = await deed(request, "Дело на сегодня", { due: day(0) });
  const second = await deed(request, "Дело на завтра", { due: day(1) });
  await deed(request, "Дело со вчерашним сроком", { due: day(-1) });
  // «Сделано» и шесть групп-колонок в ряд: окно широкое, чтобы все они были видны без прокрутки ленты.
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column.group .board-col-name").allTextContents();
  // Фиксированный порядок; пустые дни, куда можно бросить, стоят на месте.
  await expect.poll(names).toEqual(["просрочено", "сегодня", "завтра", "на неделе", "позже", "без срока"]);
  // Колонки-группы: меню и «+ Колонки» нет, а заголовок тянется, как у колонок человека;
  // «Сделано» по умолчанию слева, перед всеми.
  await expect(page.locator(".board-column.group .board-menu, .board-column.ghost")).toHaveCount(0);
  await expect(page.locator(".board-column.group .board-col-head[draggable=true]")).toHaveCount(6);
  await expect(page.locator("#board-columns .board-column").first()).toHaveClass(/board-done-column/);
  await expect(page.locator(".board-done-column .board-col-name")).toHaveText("Сделано");
  const group = (key) => page.locator(`.board-column.group[data-group="day:${key}"]`);
  await expect(group("today").locator(".board-card")).toHaveCount(1);
  await expect(group("today").locator(".board-card")).toContainText("Дело на сегодня");
  await expect(group("tomorrow").locator(".board-card")).toHaveCount(1);

  // «Дело на сегодня» бросили в «завтра» — срок стал завтрашним, и на сервере тоже.
  await group("today").locator(".board-title").dragTo(group("tomorrow").locator(".board-cards"));
  await expect(group("tomorrow").locator(".board-card")).toHaveCount(2);
  await expect(group("today").locator(".board-card")).toHaveCount(0);
  await expect(page.locator("#toast")).toContainText("Срок: завтра");
  expect(await dueOf(request, first)).toBe(day(1));
  await settled(page);
  // В пустую группу «на неделе» бросить можно: срок — через два дня.
  await group("tomorrow").locator(".board-card").filter({ hasText: "Дело на завтра" }).locator(".board-title").dragTo(group("week").locator(".board-cards"));
  await expect(group("week").locator(".board-card")).toHaveCount(1);
  expect(await dueOf(request, second)).toBe(day(2));
  await settled(page);
  // «Позже» — через две недели.
  await group("week").locator(".board-title").dragTo(group("later").locator(".board-cards"));
  await expect(group("later").locator(".board-card")).toHaveCount(1);
  expect(await dueOf(request, second)).toBe(day(14));
  await settled(page);
  // «Без срока» срок снимает.
  await group("later").locator(".board-title").dragTo(group("none").locator(".board-cards"));
  await expect(group("none").locator(".board-card")).toHaveCount(1);
  expect(await dueOf(request, second)).toBeNull();
  await settled(page);
  // «Просрочено» срока не назначает: карточка остаётся там, где была.
  await group("tomorrow").locator(".board-title").dragTo(group("late").locator(".board-cards"));
  await expect(group("late").locator(".board-card")).toHaveCount(1);
  await expect(group("tomorrow").locator(".board-card")).toHaveCount(1);
  expect(await dueOf(request, first)).toBe(day(1));
  await page.reload();
  await expect(group("none").locator(".board-card")).toContainText("Дело на завтра");
  await reset(request);
});

test("два уровня «Колонка → День» рисуют вложенные коробки; бросок в коробку — бросок в колонку, срок не меняется", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Первое дело на сегодня", { due: day(0) });
  const tomorrow = await deed(request, "Второе дело на завтра", { due: day(1) });
  const third = await deed(request, "Третье дело на сегодня", { due: day(0) });
  const other = await (await request.post("/api/board/columns", { data: { name: "Позже" } })).json();
  await request.post("/api/board/move", { data: { captureId: third, columnId: other.id, index: 0 } });
  await page.goto("/#board");
  await arrange(page, "board", ["col", "day"]);
  // Названия обоих полей: колонки — первый уровень, дни — коробки внутри них.
  await expect(page.locator("#board-hint")).toHaveText("Колонка → День");
  const home = columnByName(page, "Дела"), later = columnByName(page, "Позже");
  await expect(home.locator(".board-cards > .g-box > .g-bh")).toHaveText(["сегодня · 1", "завтра · 1"]);
  await expect(later.locator(".board-cards > .g-box > .g-bh")).toHaveText(["сегодня · 1"]);
  await expect(home.locator(".g-box .board-card")).toHaveCount(2);
  // Колонка со всем, что у неё есть: меню, «+ Дело», «+ Колонка».
  await expect(home.locator(".board-menu")).toHaveCount(1);
  await expect(home.locator(".board-add-button")).toHaveCount(1);
  await expect(page.locator(".board-column.ghost")).toBeVisible();
  // Коробка красится цветом своего поля: у «День» он свой, не синий колонки.
  const border = (locator) => locator.evaluate((element) => getComputedStyle(element).borderTopColor);
  expect(await border(home.locator(".g-box").first())).not.toBe(await border(page.locator(".board-column.ghost")));

  // Бросок в коробку чужой колонки — бросок в колонку «Позже»; день (подполе) не меняется.
  await home.locator(".board-card").filter({ hasText: "Второе дело" }).locator(".board-title").dragTo(later.locator(".g-box").first());
  await expect(later.locator(".board-card")).toHaveCount(2);
  await expect(home.locator(".board-card")).toHaveCount(1);
  await expect(later.locator(".board-cards > .g-box > .g-bh")).toHaveText(["сегодня · 1", "завтра · 1"]);
  expect(await dueOf(request, tomorrow)).toBe(day(1));
  // Порядок в колонке сохранён на сервере: после перезагрузки дело всё там же.
  await page.reload();
  await expect(columnByName(page, "Позже").locator(".board-card")).toHaveCount(2);
  await reset(request);
});

test("по человеку: группы по алфавиту, «Без человека» последней; карточки не тянутся, колонки без меню", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для Бориса", { people: ["Борис"] });
  await deed(request, "Дело для Ани", { people: ["Аня"] });
  await deed(request, "Общее дело обоим", { people: ["Аня", "Борис"] });
  await deed(request, "Дело ничьё");
  await page.goto("/#board");
  await arrange(page, "board", ["who"]);
  const names = () => page.locator("#board-columns .board-column.group .board-col-name").allTextContents();
  await expect.poll(names).toEqual(["Аня", "Борис", "Без человека"]);
  // Дело с двумя людьми лежит у первого.
  await expect(page.locator('.board-column.group[data-group="who:Аня"] .board-card')).toHaveCount(2);
  await expect(page.locator('.board-column.group[data-group="who:Борис"] .board-card')).toHaveCount(1);
  await expect(page.locator(".board-card[draggable=true]")).toHaveCount(0);
  await expect(page.locator(".board-column.group .board-menu, .board-column.ghost")).toHaveCount(0);
  // Карточки тут не тянутся, а колонки — да: заголовок любой группы двигает саму колонку.
  await expect(page.locator(".board-column.group .board-col-head[draggable=true]")).toHaveCount(3);
  // Проект и «Откуда» ведут себя так же: «Без проекта» последней, откуда — «Поле».
  await page.locator("#board-grp select").selectOption("proj");
  await expect.poll(names).toEqual(["Без проекта"]);
  await page.locator("#board-grp select").selectOption("src");
  await expect.poll(names).toEqual(["Поле"]);
  await reset(request);
});

test("список: разделы по колонкам, «Сделано» — последний раздел, кружок закрытого возвращает дело", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Открытое дело списка");
  const finished = await deed(request, "Закрытое дело списка");
  const entry = (await (await request.get(`/api/captures/${finished}`)).json()).entry;
  for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
  await page.goto("/#board");
  await arrange(page, "list", ["col"]);
  await expect(page.locator("#board-columns")).toBeHidden();
  // Раздел колонки, за ним — «Сделано»: зелёный, последний, ведёт на страницу «Сделано».
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 1", "Сделано · 1"]);
  await expect(page.locator("#board-flat .g-sec").last()).toHaveClass(/done/);
  await expect(page.locator("#board-flat .g-sec.done a")).toHaveAttribute("href", "#done");
  const closed = page.locator("#board-flat .g-row.closed");
  await expect(closed).toHaveCount(1);
  await expect(closed.locator(".board-title")).toHaveText("Закрытое дело списка");
  await expect(closed.locator(".board-title")).toHaveCSS("text-decoration-line", "line-through");
  await expect(closed.locator(".btag.due")).toContainText(/^сегодня \d\d:\d\d$/);
  // В строке открытого дела — кружок и название; тянуть строку нельзя.
  const open = page.locator("#board-flat .g-row:not(.closed)");
  await expect(open.locator(".board-done")).toHaveCount(1);
  await expect(open).not.toHaveAttribute("draggable", "true");
  // Кружок закрытого возвращает дело в работу, кружок открытого — закрывает.
  await closed.locator(".board-done").click();
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 2", "Сделано · 0"]);
  await settled(page);
  await page.locator("#board-flat .g-row").filter({ hasText: "Открытое дело списка" }).locator(".board-done").click();
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 1", "Сделано · 1"]);
  await expect(page.locator("#board-flat .g-row.closed")).toContainText("Открытое дело списка");
  await reset(request);
});

test("таблица: кружок рядом с названием, столбцы — только для полей, не занятых группировкой", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Строка таблицы на сегодня", { due: day(0), people: ["Аня"] });
  await deed(request, "Строка таблицы на завтра", { due: day(1) });
  await page.goto("/#board");
  await arrange(page, "table", ["src", "day"]);
  await expect(page.locator("#board-columns")).toBeHidden();
  await expect(page.locator("#board-flat .g-table thead th")).toHaveText(["Название", "Колонка", "Человек", "Проект"]);
  // Заголовки групп — строки на всю ширину: «Откуда», в нём дни; «Сделано» — последний раздел.
  await expect(page.locator("#board-flat tr.sec .g-sec")).toHaveText(["Поле · 2", "сегодня · 1", "завтра · 1", "Сделано · 0"]);
  const headWidth = await page.locator("#board-flat tr.sec").first().evaluate((row) => row.firstElementChild.colSpan);
  expect(headWidth).toBe(4);
  // Кружок вплотную к названию, а не в своём столбце; уровень — отступом строки.
  const row = page.locator("#board-flat tr.board-row").filter({ hasText: "Строка таблицы на сегодня" });
  const circle = await row.locator(".board-done").boundingBox(), title = await row.locator(".board-title").boundingBox();
  expect(title.x - (circle.x + circle.width)).toBeLessThan(16);
  expect(Math.abs(title.y + title.height / 2 - (circle.y + circle.height / 2))).toBeLessThan(8);
  const indent = (locator) => locator.locator(".board-done").evaluate((element) => element.getBoundingClientRect().x);
  const group = (await page.locator("#board-flat tr.sec .g-sec").first().boundingBox()).x;
  expect(await indent(row)).toBeGreaterThan(group + 16);
  await expect(row.locator("td")).toHaveText(["Строка таблицы на сегодня", "Дела", "Аня", "Без проекта"]);

  // Без группировки столбцов пять — «День» и «Откуда» тоже.
  await page.locator('#board-grp [data-remove="0"]').click();
  await page.locator('#board-grp [data-remove="0"]').click();
  await expect(page.locator("#board-flat .g-table thead th")).toHaveText(["Название", "Колонка", "День", "Человек", "Проект", "Откуда"]);
  const flat = page.locator("#board-flat tr.board-row").filter({ hasText: "Строка таблицы на завтра" });
  await expect(flat.locator("td")).toHaveText(["Строка таблицы на завтра", "Дела", "завтра", "Без человека", "Без проекта", "Поле"]);
  // Кружок закрывает дело — строка уходит в «Сделано», а он же его возвращает.
  await flat.locator(".board-done").click();
  await expect(page.locator("#board-flat tr.sec .g-sec").last()).toHaveText("Сделано · 1");
  await settled(page);
  const closed = page.locator("#board-flat tr.board-row.closed");
  await expect(closed).toHaveCount(1);
  await expect(closed.locator(".board-done")).toHaveClass(/is-done/);
  await expect(closed.locator("td").nth(2)).toContainText(/^сегодня \d\d:\d\d$/);
  await closed.locator(".board-done").click();
  await expect(page.locator("#board-flat tr.board-row.closed")).toHaveCount(0);
  await reset(request);
});

test("поиск работает во всех видах; название открывает карточку, стрелки листают дела в порядке показа", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Альфа дело", { due: day(0) });
  await deed(request, "Бета дело", { due: day(1) });
  await deed(request, "Гамма дело", { due: day(0) });
  await page.goto("/#board");
  await arrange(page, "list", ["day"]);
  const titles = () => page.locator("#board-flat .g-row .board-title").allTextContents();
  // Порядок показа: сегодняшние, затем завтрашние.
  await expect.poll(titles).toEqual(["Альфа дело", "Гамма дело", "Бета дело"]);
  await page.locator("#board-search").fill("бета");
  await expect.poll(titles).toEqual(["Бета дело"]);
  await page.locator('#board-view [data-view="table"]').click();
  await expect(page.locator("#board-flat tr.board-row")).toHaveCount(1);
  await page.locator('#board-view [data-view="board"]').click();
  await expect(page.locator("#board-columns .board-card")).toHaveCount(1);
  await page.locator("#board-search").fill("");
  await page.locator('#board-view [data-view="list"]').click();
  await expect.poll(titles).toEqual(["Альфа дело", "Гамма дело", "Бета дело"]);

  // Вторая по порядку показа — «Гамма»; карточка листает так же, как показано.
  await page.locator("#board-flat .g-row").filter({ hasText: "Гамма дело" }).locator(".board-title").click();
  await expect(page.locator("#review-dialog")).toBeVisible();
  await expect(page.locator("#review-dialog .card-title")).toHaveText("Гамма дело");
  await expect(page.locator("#review-dialog .card-nav-crumb")).toContainText("2 из 3");
  await page.locator('#review-dialog .card-nav-step[aria-label^="Следующее"]').click();
  await expect(page.locator("#review-dialog .card-title")).toHaveText("Бета дело");
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-dialog")).toBeHidden();
  await reset(request);
});

test("клавиши J, E и Enter работают в списке и в таблице так же, как на доске", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Первая строка для клавиш");
  await deed(request, "Вторая строка для клавиш");
  await page.goto("/#board");
  for (const view of ["list", "table"]) {
    await arrange(page, view, []);
    const rows = page.locator(view === "list" ? "#board-flat .g-row:not(.closed)" : "#board-flat tr.board-row:not(.closed)");
    await expect(rows).toHaveCount(2);
    // J идёт вниз по строкам, E закрывает ту, до которой дошли.
    await page.keyboard.press("j");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("e");
    await expect(rows).toHaveCount(1);
    await expect(page.locator("#board-flat .board-row.closed")).toHaveCount(1);
    await settled(page);
    await page.locator("#board-flat .board-row.closed .board-done").click();
    await expect(rows).toHaveCount(2);
    await settled(page);
    // Enter на строке открывает карточку.
    await page.keyboard.press("j");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#review-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#review-dialog")).toBeHidden();
  }
  await reset(request);
});

test("«+ Дело» в списке открывает поле рядом с кнопкой, дело падает в первую колонку", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");
  await arrange(page, "list", ["col"]);
  await expect(page.locator("#board-quick")).toBeHidden();
  await page.locator("#board-new").click();
  const quick = page.locator("#board-quick");
  await expect(quick).toBeVisible();
  await quick.fill("Дело из списка");
  await quick.press("Enter");
  const row = page.locator("#board-flat .g-row").filter({ hasText: "Дело из списка" });
  await expect(row).toBeVisible();
  await expect(page.locator("#board-flat .g-sec").first()).toHaveText("Дела · 1");
  await expect(quick).toBeFocused();
  await quick.press("Escape");
  await expect(quick).toBeHidden();
  await reset(request);
});

test("на телефоне у списка и таблицы нет сегментов колонок, а таблица прокручивается вбок внутри себя", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для телефона со длинным названием, чтобы таблица не поместилась", { due: day(1) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#board");
  await arrange(page, "table", ["col"]);
  await expect(page.locator("#board-segments")).toBeHidden();
  const wrap = page.locator("#board-flat .board-table-wrap");
  await expect(wrap).toBeVisible();
  expect(await wrap.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await arrange(page, "list", ["col", "day"]);
  await expect(page.locator("#board-segments")).toBeHidden();
  await expect(page.locator("#board-flat .g-row")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // «Доска» сегменты возвращает.
  await arrange(page, "board", ["col"]);
  await expect(page.locator("#board-segments .board-segment").first()).toBeVisible();
  await reset(request);
});

// ── порядок колонок ──────────────────────────────────────────────────────────

test("колонки тянутся при любой группировке: по дню «завтра» встаёт перед «сегодня», порядок помнится после перезагрузки", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело на сегодня", { due: day(0) });
  const tomorrow = await deed(request, "Дело на завтра", { due: day(1) });
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column:not(.ghost) .board-col-name").allTextContents();
  const lane = (key) => page.locator(`.board-column.group[data-group="day:${key}"]`);
  // Пока порядка нет — естественный, «Сделано» первая; пустая «просрочено» не показана.
  await expect.poll(names).toEqual(["Сделано", "сегодня", "завтра", "на неделе", "позже", "без срока"]);
  expect(await stored(page, "kizuna-board-order")).toBeNull();

  // «завтра» — за заголовок — перед «сегодня». Колонка переехала, а срок дела остался.
  await lane("tomorrow").locator(".board-col-head").dragTo(lane("today"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Сделано", "завтра", "сегодня", "на неделе", "позже", "без срока"]);
  expect(await dueOf(request, tomorrow)).toBe(day(1));
  // В браузере лежит полный порядок — и скрытая «просрочено» тоже, на своём месте.
  expect(JSON.parse(await stored(page, "kizuna-board-order"))).toEqual({ day: ["__done", "late", "tomorrow", "today", "week", "later", "none"] });
  await page.reload();
  await expect.poll(names).toEqual(["Сделано", "завтра", "сегодня", "на неделе", "позже", "без срока"]);
  await expect(lane("tomorrow").locator(".board-card")).toContainText("Дело на завтра");

  // Порядок помнится по полю первого уровня: у другого поля он свой, естественный.
  await arrange(page, "board", ["src"]);
  await expect.poll(names).toEqual(["Сделано", "Поле"]);
  await arrange(page, "board", ["day"]);
  await expect.poll(names).toEqual(["Сделано", "завтра", "сегодня", "на неделе", "позже", "без срока"]);
  await reset(request);
});

test("«Сделано» — такая же колонка: её тянут на второе место, и это помнится; новая группа встаёт после известных", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело на сегодня", { due: day(0) });
  await deed(request, "Просроченное дело", { due: day(-1) });
  await deed(request, "Дело Бориса", { people: ["Борис"] });
  await deed(request, "Дело Ани", { people: ["Аня"] });
  const finished = await deed(request, "Закрытое дело");
  await closeDeed(request, finished);
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column:not(.ghost) .board-col-name").allTextContents();
  const done = page.locator(".board-done-column");
  const lane = (key) => page.locator(`.board-column.group[data-group="day:${key}"]`);
  await expect.poll(names).toEqual(["Сделано", "просрочено", "сегодня", "завтра", "на неделе", "позже", "без срока"]);

  // «Сделано» встала правее «просрочено»: вторая по счёту, а не прибитая к краю.
  await done.locator(".board-col-head").dragTo(lane("late"), { targetPosition: { x: 260, y: 60 } });
  await expect.poll(names).toEqual(["просрочено", "Сделано", "сегодня", "завтра", "на неделе", "позже", "без срока"]);
  await expect(done.locator(".board-card.closed")).toContainText("Закрытое дело");
  await page.reload();
  await expect.poll(names).toEqual(["просрочено", "Сделано", "сегодня", "завтра", "на неделе", "позже", "без срока"]);
  expect(JSON.parse(await stored(page, "kizuna-board-order")).day.slice(0, 3)).toEqual(["late", "__done", "today"]);
  // Она обычная и в остальном: закрывает брошенное на неё дело.
  await lane("today").locator(".board-card").filter({ hasText: "Дело на сегодня" }).locator(".board-title").dragTo(page.locator(".board-done-column"));
  await expect(done.locator(".board-card.closed")).toHaveCount(2);

  // Порядок из браузера знает не все группы: новый человек встаёт после известных, в естественном порядке.
  await page.evaluate(() => localStorage.setItem("kizuna-board-order", JSON.stringify({ who: ["Борис", "__done"] })));
  await arrange(page, "board", ["who"]);
  await expect.poll(names).toEqual(["Борис", "Сделано", "Аня", "Без человека"]);
  // Испорченный порядок не ломает доску: естественный, «Сделано» первая.
  await page.evaluate(() => localStorage.setItem("kizuna-board-order", "{oops"));
  await page.reload();
  await expect.poll(names).toEqual(["Сделано", "Аня", "Борис", "Без человека"]);
  await reset(request);
});

test("по «Колонке» колонка человека тянется и порядок уходит на сервер, а место «Сделано» — только в браузере", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/board/columns", { data: { name: "Позже" } });
  await request.post("/api/board/columns", { data: { name: "Ожидание" } });
  await page.goto("/#board");
  const names = () => page.locator(".board-column:not(.ghost) .board-col-name").allTextContents();
  const server = async () => (await (await request.get("/api/board")).json()).columns.map((column) => column.name);
  await expect.poll(names).toEqual(["Сделано", "Дела", "Позже", "Ожидание"]);

  // «Ожидание» перед «Позже»: на экране, в браузере и на сервере.
  await columnByName(page, "Ожидание").locator(".board-col-head").dragTo(columnByName(page, "Позже"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Сделано", "Дела", "Ожидание", "Позже"]);
  await expect.poll(server).toEqual(["Дела", "Ожидание", "Позже"]);
  expect(JSON.parse(await stored(page, "kizuna-board-order")).col).toHaveLength(4);

  // «Сделано» на второе место — только на экране: свои колонки на сервере стоят, как стояли.
  await page.locator(".board-done-column .board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 260, y: 60 } });
  await expect.poll(names).toEqual(["Дела", "Сделано", "Ожидание", "Позже"]);
  expect(await server()).toEqual(["Дела", "Ожидание", "Позже"]);
  await page.reload();
  await expect.poll(names).toEqual(["Дела", "Сделано", "Ожидание", "Позже"]);

  // Колонка человека, брошенная за «Сделано», тоже уходит на сервер — среди своих колонок она первая.
  await columnByName(page, "Позже").locator(".board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Позже", "Дела", "Сделано", "Ожидание"]);
  await expect.poll(server).toEqual(["Позже", "Дела", "Ожидание"]);
  await reset(request);
});

// ── наборный фильтр ──────────────────────────────────────────────────────────

test("первый заход: фильтр «сегодня» — «День = сегодня» и «просрочено»; «Сбросить» показывает всё и помнится, «Сегодня» возвращает умолчание", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело на сегодня для фильтра", { due: day(0) });
  await deed(request, "Просроченное дело для фильтра", { due: day(-2) });
  await deed(request, "Дело на завтра для фильтра", { due: day(1) });
  await deed(request, "Дело на потом для фильтра", { due: day(20) });
  await page.goto("/#board");
  // Ключа нет — это первый заход: прогон по умолчанию стартует с пустым фильтром, здесь его убираем.
  await page.evaluate(() => localStorage.removeItem("kizuna-board-filter"));
  await page.reload();
  await expect(page.locator("#board-columns .board-card").first()).toBeVisible();
  await settled(page);

  // Кнопка подсвечена и считает условия; строка открыта, обе плашки на виду.
  await expect(filterToggle(page)).toHaveText("Фильтр · 2");
  await expect(filterToggle(page)).toHaveClass(/is-on/);
  await expect(page.locator("#board-filter")).toBeVisible();
  expect(await conditionsOf(page)).toEqual(["День = сегодня", "День = просрочено"]);
  await expect(page.locator("#board-filter .board-or")).toHaveText("или");
  await expect(page.locator("#board-filter .board-filter-today")).toHaveAttribute("aria-pressed", "true");
  // Дела на завтра и на потом спрятаны, сегодняшнее и просроченное — на месте.
  await expect.poll(() => openTitles(page)).toEqual(["Просроченное дело для фильтра", "Дело на сегодня для фильтра"]);
  // Умолчание само в браузер не пишется, пока человек ничего не менял.
  expect(await stored(page, "kizuna-board-filter")).toBeNull();

  // «Сбросить» снимает всё: дела на завтра и на потом вернулись; пустой фильтр помнится, «сегодня» не возвращается.
  await page.locator("#board-filter .board-filter-clear").click();
  await expect.poll(() => openTitles(page)).toHaveLength(4);
  await expect(filterToggle(page)).toHaveText("Фильтр");
  await expect(filterToggle(page)).not.toHaveClass(/is-on/);
  expect(await stored(page, "kizuna-board-filter")).toBe("[]");
  await page.reload();
  await expect.poll(() => openTitles(page)).toHaveLength(4);
  await expect(filterToggle(page)).toHaveText("Фильтр");
  await expect(page.locator("#board-filter")).toBeHidden();

  // «Сегодня» в строке фильтра возвращает умолчание.
  await openFilter(page);
  await expect(page.locator("#board-filter .board-cond")).toHaveCount(0);
  await expect(page.locator("#board-filter .board-filter-today")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#board-filter .board-filter-today").click();
  await expect(filterToggle(page)).toHaveText("Фильтр · 2");
  expect(await conditionsOf(page)).toEqual(["День = сегодня", "День = просрочено"]);
  await expect.poll(() => openTitles(page)).toEqual(["Просроченное дело для фильтра", "Дело на сегодня для фильтра"]);
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 2");
  await expect.poll(() => openTitles(page)).toHaveLength(2);

  // Вторую плашку можно убрать: остаётся «День = сегодня».
  await page.locator('#board-filter [data-remove="1"]').click();
  expect(await conditionsOf(page)).toEqual(["День = сегодня"]);
  await expect.poll(() => openTitles(page)).toEqual(["Дело на сегодня для фильтра"]);
  await expect(page.locator("#board-filter .board-filter-today")).toHaveAttribute("aria-pressed", "false");
  await reset(request);
});

test("фильтр «Человек = Аня» оставляет её дела на доске, в списке и таблице, переживает перезагрузку, «Сбросить» возвращает всё", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело Ани для фильтра", { people: ["Аня"] });
  await deed(request, "Дело Бориса для фильтра", { people: ["Борис"] });
  await deed(request, "Общее дело для фильтра", { people: ["Аня", "Борис"] });
  await deed(request, "Дело ничьё для фильтра");
  await closeDeed(request, await deed(request, "Закрытое дело Ани", { people: ["Аня"] }));
  await closeDeed(request, await deed(request, "Закрытое дело Бориса", { people: ["Борис"] }));
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  await expect(filterToggle(page)).toHaveText("Фильтр");
  await expect.poll(() => openTitles(page)).toHaveLength(4);
  await expect.poll(() => doneTitles(page)).toHaveLength(2);

  await addCondition(page, "who", "Аня");
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  expect(await conditionsOf(page)).toEqual(["Человек = Аня"]);
  // Доска: только её открытые дела (в том числе общее с Борисом) и её закрытое в «Сделано».
  await expect.poll(() => openTitles(page)).toEqual(["Дело Ани для фильтра", "Общее дело для фильтра"]);
  await expect.poll(() => doneTitles(page)).toEqual(["Закрытое дело Ани"]);
  await expect(page.locator(".board-done-column .board-col-count")).toHaveText("1");
  // Поиск работает поверх фильтра.
  await page.locator("#board-search").fill("общее");
  await expect.poll(() => openTitles(page)).toEqual(["Общее дело для фильтра"]);
  await page.locator("#board-search").fill("");

  // Список и таблица: те же дела, «Сделано» — последний раздел с её закрытым.
  await page.locator('#board-view [data-view="list"]').click();
  await expect(page.locator("#board-flat .g-row .board-title")).toHaveText(["Дело Ани для фильтра", "Общее дело для фильтра", "Закрытое дело Ани"]);
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 2", "Сделано · 1"]);
  await page.locator('#board-view [data-view="table"]').click();
  await expect(page.locator("#board-flat tr.board-row .board-title")).toHaveText(["Дело Ани для фильтра", "Общее дело для фильтра", "Закрытое дело Ани"]);

  // Выбор лежит в браузере и переживает перезагрузку — вместе с видом.
  expect(JSON.parse(await stored(page, "kizuna-board-filter"))).toEqual([{ field: "who", op: "=", value: "Аня" }]);
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  await expect(page.locator("#board-filter")).toBeVisible();
  expect(await conditionsOf(page)).toEqual(["Человек = Аня"]);
  await expect(page.locator("#board-flat tr.board-row .board-title")).toHaveText(["Дело Ани для фильтра", "Общее дело для фильтра", "Закрытое дело Ани"]);
  await page.locator('#board-view [data-view="board"]').click();
  await expect.poll(() => openTitles(page)).toEqual(["Дело Ани для фильтра", "Общее дело для фильтра"]);

  // «Сбросить» возвращает всё и в браузере остаётся пустой фильтр.
  await page.locator("#board-filter .board-filter-clear").click();
  await expect.poll(() => openTitles(page)).toHaveLength(4);
  await expect.poll(() => doneTitles(page)).toHaveLength(2);
  await expect(filterToggle(page)).toHaveText("Фильтр");
  expect(await stored(page, "kizuna-board-filter")).toBe("[]");
  await page.reload();
  await expect.poll(() => openTitles(page)).toHaveLength(4);
  await reset(request);
});

test("«Статус = открыто» прячет «Сделано» — колонку, раздел списка и таблицы; «Статус = сделано» оставляет только закрытые", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Открытое дело статуса");
  await closeDeed(request, await deed(request, "Закрытое дело статуса"));
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  await expect(page.locator(".board-done-column")).toBeVisible();

  await addCondition(page, "status", "open");
  expect(await conditionsOf(page)).toEqual(["Статус = открыто"]);
  // Колонки «Сделано» нет вовсе, а не пустая; открытое дело на месте.
  await expect(page.locator(".board-done-column")).toHaveCount(0);
  await expect.poll(() => openTitles(page)).toEqual(["Открытое дело статуса"]);
  await expect(page.locator("#board-segments .board-segment").first()).not.toContainText("Сделано");
  await page.locator('#board-view [data-view="list"]').click();
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 1"]);
  await expect(page.locator("#board-flat .g-sec.done, #board-flat .g-row.closed")).toHaveCount(0);
  await page.locator('#board-view [data-view="table"]').click();
  await expect(page.locator("#board-flat tr.sec .g-sec")).toHaveText(["Дела · 1"]);
  await expect(page.locator("#board-flat tr.board-row.closed")).toHaveCount(0);

  // «Статус = сделано»: остаются только закрытые; колонки человека при группировке по «Колонке» стоят пустые — в них бросают.
  await page.locator('#board-filter [data-part="value"]').selectOption("done");
  await expect(page.locator("#board-flat tr.board-row .board-title")).toHaveText(["Закрытое дело статуса"]);
  await expect(page.locator("#board-flat tr.sec .g-sec")).toHaveText(["Дела · 0", "Сделано · 1"]);
  await page.locator('#board-view [data-view="board"]').click();
  await expect(page.locator(".board-done-column .board-card.closed")).toHaveCount(1);
  await expect(columnByName(page, "Дела")).toBeVisible();
  await expect(columnByName(page, "Дела").locator(".board-card")).toHaveCount(0);

  // «≠ сделано» — то же, что «= открыто»: «Сделано» пропала.
  await page.locator('#board-filter [data-part="op"]').selectOption("!=");
  await expect(page.locator(".board-done-column")).toHaveCount(0);
  await expect.poll(() => openTitles(page)).toEqual(["Открытое дело статуса"]);
  await reset(request);
});

test("условия: «=» на одном поле — «или», разные поля — «и», «≠» — исключает; у закрытого дела «День» — день закрытия", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Сегодняшнее дело Ани", { due: day(0), people: ["Аня"] });
  await deed(request, "Завтрашнее дело Ани", { due: day(1), people: ["Аня"] });
  await deed(request, "Сегодняшнее дело Бориса", { due: day(0), people: ["Борис"] });
  await deed(request, "Просроченное дело Бориса", { due: day(-3), people: ["Борис"] });
  await deed(request, "Дело на потом", { due: day(20) });
  // Закрыто сегодня, срок был завтра: под фильтром «сегодня» оно в «Сделано», ведь закрыто сегодня.
  await closeDeed(request, await deed(request, "Закрытое сегодня досрочно", { due: day(1) }));
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  const titles = () => openTitles(page).then((list) => list.sort());

  await addCondition(page, "day", "today");
  await expect.poll(titles).toEqual(["Сегодняшнее дело Ани", "Сегодняшнее дело Бориса"]);
  await expect.poll(() => doneTitles(page)).toEqual(["Закрытое сегодня досрочно"]);
  // Второе «=» на том же поле — «или»: сегодняшнее и завтрашнее; между плашками стоит «или».
  await addCondition(page, "day", "tomorrow");
  expect(await conditionsOf(page)).toEqual(["День = сегодня", "День = завтра"]);
  await expect(page.locator("#board-filter .board-or")).toHaveText(["или"]);
  await expect.poll(titles).toEqual(["Завтрашнее дело Ани", "Сегодняшнее дело Ани", "Сегодняшнее дело Бориса"]);
  // Другое поле — «и»: из этих — только дела Ани. Плашки одного поля стоят рядом.
  await addCondition(page, "who", "Аня");
  expect(await conditionsOf(page)).toEqual(["День = сегодня", "День = завтра", "Человек = Аня"]);
  await expect(page.locator("#board-filter .board-or")).toHaveCount(1);
  await expect.poll(titles).toEqual(["Завтрашнее дело Ани", "Сегодняшнее дело Ани"]);
  await expect.poll(() => doneTitles(page)).toEqual([]);
  await expect(filterToggle(page)).toHaveText("Фильтр · 3");

  // «≠» исключает: все дни, кроме завтрашнего и далёкого, — для Бориса это сегодня и просрочено.
  await page.locator("#board-filter .board-filter-clear").click();
  await addCondition(page, "who", "Борис");
  await addCondition(page, "day", "tomorrow", "!=");
  expect(await conditionsOf(page)).toEqual(["Человек = Борис", "День ≠ завтра"]);
  await expect.poll(titles).toEqual(["Просроченное дело Бориса", "Сегодняшнее дело Бориса"]);
  // «Пусто» у человека — дела, где никто не назван; «Аня» или «пусто» вместе — «или».
  await page.locator("#board-filter .board-filter-clear").click();
  await addCondition(page, "who", "__none");
  await expect.poll(titles).toEqual(["Дело на потом"]);
  await addCondition(page, "who", "Аня");
  await expect.poll(titles).toEqual(["Дело на потом", "Завтрашнее дело Ани", "Сегодняшнее дело Ани"]);
  await reset(request);
});

test("при фильтре пустые группы-колонки скрыты, а колонки человека остаются: в них можно бросать", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Сегодняшнее дело группы", { due: day(0) });
  await deed(request, "Завтрашнее дело группы", { due: day(1) });
  await request.post("/api/board/columns", { data: { name: "Пустая" } });
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column:not(.ghost) .board-col-name").allTextContents();
  // Без фильтра пустые дни, куда можно бросить, на месте.
  await expect.poll(names).toEqual(["Сделано", "сегодня", "завтра", "на неделе", "позже", "без срока"]);
  await addCondition(page, "day", "today");
  await expect.poll(names).toEqual(["Сделано", "сегодня"]);
  // Список по человеку с тем же фильтром: пустых групп нет, остались те, где есть дело.
  await arrange(page, "board", ["who"]);
  await expect.poll(names).toEqual(["Сделано", "Без человека"]);
  // По «Колонке» пустая колонка человека остаётся, хоть в ней сейчас ничего не подходит.
  await arrange(page, "board", ["col"]);
  await expect.poll(names).toEqual(["Сделано", "Дела", "Пустая"]);
  await expect(columnByName(page, "Пустая").locator(".board-add-button")).toHaveCount(1);
  await reset(request);
});

test("плашка условия: значение, которого больше нет, остаётся видно; испорченный фильтр в браузере — умолчание", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для испорченного фильтра");
  await page.goto("/#board");
  // Человека, которого нет среди дел, условие не подменяет молча: плашка на месте, дел под неё нет.
  await page.evaluate(() => localStorage.setItem("kizuna-board-filter", JSON.stringify([{ field: "who", op: "=", value: "Ушедший" }, { field: "nope", op: "=", value: "x" }])));
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  expect(await conditionsOf(page)).toEqual(["Человек = Ушедший"]);
  await expect.poll(() => openTitles(page)).toEqual([]);
  // Испорченное значение не ломает доску: как в первый заход, «сегодня».
  await page.evaluate(() => localStorage.setItem("kizuna-board-filter", "{oops"));
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 2");
  expect(await conditionsOf(page)).toEqual(["День = сегодня", "День = просрочено"]);
  await expect.poll(() => openTitles(page)).toEqual(["Дело для испорченного фильтра"]);
  // Черновик — «+ условие» без значения — ничего не отбирает и в браузер не уходит.
  await page.locator("#board-filter .board-filter-clear").click();
  await page.locator("#board-filter .board-cond-add").click();
  await expect(page.locator("#board-filter .board-cond select.is-empty")).toHaveCount(1);
  await expect(filterToggle(page)).toHaveText("Фильтр");
  await expect.poll(() => openTitles(page)).toEqual(["Дело для испорченного фильтра"]);
  expect(await stored(page, "kizuna-board-filter")).toBe("[]");
  await reset(request);
});

// ── приглашение «+ Дело в …» внизу колонки ───────────────────────────────────

test("внизу колонки — приглашение «+ Дело в …»: видно по наведению, Enter создаёт дело в этой колонке, Esc отменяет", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/board/columns", { data: { name: "Позже" } });
  await page.goto("/#board");
  const home = columnByName(page, "Дела"), later = columnByName(page, "Позже");
  const invite = (lane) => lane.locator(".board-add-button");
  await expect(invite(home)).toHaveText("+ Дело в «Дела»");
  await expect(invite(later)).toHaveText("+ Дело в «Позже»");
  // Приглашения нет ни у «Сделано», ни у призрачной «+ Колонки» (у неё свой, обычный).
  await expect(page.locator(".board-done-column .board-add")).toHaveCount(0);
  // Без наведения его не видно, по наведению — видно; пунктирная коралловая карточка
  // (рамка 1.5px, но на обычном экране браузер округляет её до пикселя).
  await page.mouse.move(5, 5);
  await expect(later.locator(".board-add")).toHaveCSS("opacity", "0");
  await later.hover();
  await expect(later.locator(".board-add")).toHaveCSS("opacity", "1");
  await expect(invite(later)).toHaveCSS("border-top-style", "dashed");
  const [border, ink] = await invite(later).evaluate((button) => [getComputedStyle(button).borderTopColor, getComputedStyle(button).color]);
  expect(border).toBe(ink);

  // Щелчок — поле на месте; Enter создаёт дело именно в этой колонке.
  await invite(later).click();
  const input = later.locator(".board-add input");
  await expect(input).toBeFocused();
  await input.fill("Дело из приглашения");
  await page.keyboard.press("Enter");
  await expect(later.locator(".board-card").filter({ hasText: "Дело из приглашения" })).toBeVisible();
  await expect(home.locator(".board-card")).toHaveCount(0);
  // Поле осталось для следующего дела; Esc закрывает его и ничего не создаёт.
  await expect(input).toBeFocused();
  await input.fill("Это не должно лечь");
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  await expect(invite(later)).toBeVisible();
  await expect(later.locator(".board-card")).toHaveCount(1);
  await reset(request);
});

test("приглашение в группе: по дню — срок группы, по человеку и проекту — человек и проект; в «просрочено», «без срока» и «Откуда» его нет", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Старое дело для приглашений", { due: day(-1) });
  await deed(request, "Дело Ани для приглашений", { people: ["Аня"] });
  const hubDeed = await deed(request, "Дело проекта для приглашений");
  await request.post(`/api/captures/${hubDeed}/corrections`, { data: { at: Date.now(), patch: { project: "Hub" } } });
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  const create = async (lane, raw) => {
    await lane.hover();
    await lane.locator(".board-add-button").click();
    await lane.locator(".board-add input").fill(raw);
    await page.keyboard.press("Enter");
    await expect(lane.locator(".board-card").filter({ hasText: raw })).toBeVisible();
    await page.keyboard.press("Escape");
  };

  // По дню: слова у каждой группы свои, а срок у созданного дела — срок группы.
  await arrange(page, "board", ["day"]);
  const dayLane = (key) => page.locator(`.board-column.group[data-group="day:${key}"]`);
  await expect(dayLane("late").locator(".board-add-button")).toHaveCount(0);
  await expect(dayLane("none").locator(".board-add-button")).toHaveCount(0);
  await expect(dayLane("today").locator(".board-add-button")).toHaveText("+ Дело на сегодня");
  await expect(dayLane("tomorrow").locator(".board-add-button")).toHaveText("+ Дело на завтра");
  await expect(dayLane("week").locator(".board-add-button")).toHaveText("+ Дело на неделе");
  await expect(dayLane("later").locator(".board-add-button")).toHaveText("+ Дело позже");
  await create(dayLane("tomorrow"), "Проверить чертёж");
  expect(await dueOf(request, await idByRaw(request, "Проверить чертёж"))).toBe(day(1));
  await create(dayLane("week"), "Сверить смету");
  expect(await dueOf(request, await idByRaw(request, "Сверить смету"))).toBe(day(2));
  await create(dayLane("later"), "Разобрать архив");
  expect(await dueOf(request, await idByRaw(request, "Разобрать архив"))).toBe(day(14));
  // «+ Дело» вверху осталось прежним: без колонок человека оно открывает своё поле.
  await page.locator("#board-new").click();
  await expect(page.locator("#board-quick")).toBeVisible();
  await page.keyboard.press("Escape");

  // По человеку: «Аня» — она первая среди людей дела; «Без человека» — дело без людей.
  await arrange(page, "board", ["who"]);
  const whoLane = (name) => page.locator(`.board-column.group[data-group="who:${name}"]`);
  await expect(whoLane("Аня").locator(".board-add-button")).toHaveText("+ Дело для Ани");
  await expect(whoLane("").locator(".board-add-button")).toHaveText("+ Дело без человека");
  await create(whoLane("Аня"), "Сверить макет");
  const people = async (raw) => (await (await request.get(`/api/captures/${await idByRaw(request, raw)}`)).json()).entry.interpretation.classification.entities.people;
  expect((await people("Сверить макет"))[0]).toBe("Аня");
  await create(whoLane(""), "Убрать на столе");
  expect(await people("Убрать на столе")).toEqual([]);

  // По проекту: проект дела — как у колонки; «Без проекта» — просто дело.
  await arrange(page, "board", ["proj"]);
  const projLane = (name) => page.locator(`.board-column.group[data-group="proj:${name}"]`);
  await expect(projLane("Hub").locator(".board-add-button")).toHaveText("+ Дело в «Hub»");
  await expect(projLane("").locator(".board-add-button")).toHaveText("+ Дело без проекта");
  await create(projLane("Hub"), "Собрать релиз");
  const projects = async (raw) => (await (await request.get(`/api/captures/${await idByRaw(request, raw)}`)).json()).entry.interpretation.classification.entities.projects;
  expect(await projects("Собрать релиз")).toEqual(["Hub"]);

  // «Откуда»: срок и источник так не назначить — приглашения нет.
  await arrange(page, "board", ["src"]);
  await expect(page.locator(".board-column .board-add-button")).toHaveCount(0);
  await reset(request);
});
